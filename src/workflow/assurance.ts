import { createHash } from "node:crypto";
import { lstat, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ZodType } from "zod";
import { getGitSnapshot, resolveLocalHeadSha, resolveRemoteBranchSha } from "../adapters/git.js";
import { GhCliGitHubAdapter, type GitHubPullRequestReference } from "../adapters/github.js";
import {
  readManifestV2,
  appendRunEvent,
  readOptionalValidatedArtifact,
  updateManifestV2,
  withRunLedgerCompoundTransaction,
  writeCreateOnceValidated,
} from "../core/ledger.js";
import { loadVerifiedPlanBundle } from "./verified-plan.js";
import {
  abandonmentArtifactSchema,
  assuranceAssessmentSchema,
  executionSpecV2Schema,
  riskAcceptanceArtifactSchema,
  persistedVerifierReviewSchema,
  remoteSynchronizationEvidenceSchema,
  runManifestV2Schema,
} from "../core/schema.js";
import { artifactRefFromBytes } from "../core/context-contracts.js";
import { readOwnedRunFile } from "../core/owned-evidence.js";
import type {
  AbandonmentArtifact,
  AssuranceAssessment,
  RiskAcceptanceArtifact,
  RunManifestV2,
} from "../core/types.js";
import { validatePersistedVerificationEvidence } from "../verification/evidence.js";
import { readOwnedEvidenceFile } from "../core/owned-evidence.js";
import { RUN_CONFIGURATION_PATH, resolvedRunConfigurationSchema } from "../core/run-configuration.js";
import { requirePersistedPullRequestMapping } from "../core/github-pull-request-mapping.js";
import { loadEvidenceIndex, verifierEvidenceIndexPath } from "./evidence-index.js";

const WAIVABLE_BLOCKERS = new Set(["missing_final_evidence", "invalid_final_evidence", "final_verification_failed"]);

export interface AssuranceAssessmentOptions {
  candidateCommit?: string;
  worktreeClean?: boolean;
  legacyRemoteCandidate?: {
    resolveRemoteSha?: typeof resolveRemoteBranchSha;
    getPullRequest?: (pullRequestNumber: number) => Promise<GitHubPullRequestReference | null>;
  };
}

interface RemoteBlocker {
  blocker_code: "missing_remote_synchronization" | "invalid_remote_synchronization" | "stale_remote_synchronization" | "remote_candidate_mismatch" | "pull_request_candidate_mismatch";
  blocker: string;
  missing_evidence?: string[];
  invalid_evidence?: string[];
}

function normalizedUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

async function configuredRemoteName(runDir: string): Promise<string> {
  const raw = await readOwnedRunFile(runDir, RUN_CONFIGURATION_PATH);
  return resolvedRunConfigurationSchema.parse(JSON.parse(raw.toString("utf8"))).github.default_remote;
}

function unsafeSynchronizationPath(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (trimmed === "") return true;
  const normalized = trimmed.replaceAll("\\", "/");
  return normalized.startsWith("/")
    || /^[A-Za-z]:\//.test(normalized)
    || normalized.split("/").some((segment) => segment === "..");
}

async function readAssuranceManifest(runDir: string): Promise<{ manifest: RunManifestV2; unsafeSynchronizationPointer: boolean }> {
  try {
    return { manifest: await readManifestV2(runDir), unsafeSynchronizationPointer: false };
  } catch (originalError) {
    let raw: unknown;
    try {
      raw = JSON.parse((await readOwnedRunFile(runDir, "manifest.json")).toString("utf8"));
    } catch { throw originalError; }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)
      || !Object.prototype.hasOwnProperty.call(raw, "remote_synchronization_path")
      || !unsafeSynchronizationPath((raw as Record<string, unknown>).remote_synchronization_path)) {
      throw originalError;
    }
    const manifest = runManifestV2Schema.parse({
      ...(raw as Record<string, unknown>),
      remote_synchronization_path: null,
    }) as RunManifestV2;
    return { manifest, unsafeSynchronizationPointer: true };
  }
}

async function assessDurableRemoteSynchronization(
  runDir: string,
  manifest: RunManifestV2,
  candidateCommit: string,
): Promise<RemoteBlocker | null> {
  const path = manifest.remote_synchronization_path;
  if (path === null) {
    return {
      blocker_code: "missing_remote_synchronization",
      blocker: "Final GitHub assurance requires durable remote synchronization evidence.",
      missing_evidence: ["assurance/remote-synchronization"],
    };
  }
  if (path === undefined) throw new Error("Durable remote synchronization assessment requires a manifest pointer field");
  let evidence;
  let remoteName: string;
  try {
    const [raw, configuredRemote] = await Promise.all([
      readOwnedEvidenceFile(runDir, path, "assurance/"),
      configuredRemoteName(runDir),
    ]);
    evidence = remoteSynchronizationEvidenceSchema.parse(JSON.parse(raw.toString("utf8")));
    remoteName = configuredRemote;
  } catch {
    return {
      blocker_code: "invalid_remote_synchronization",
      blocker: "Durable remote synchronization evidence is missing, unsafe, corrupt, or invalid.",
      invalid_evidence: [path],
    };
  }
  let mapping;
  try { mapping = requirePersistedPullRequestMapping(manifest); } catch {
    return {
      blocker_code: "invalid_remote_synchronization",
      blocker: "The persisted pull request mapping is incomplete or invalid.",
      invalid_evidence: [path],
    };
  }
  if (evidence.run_id !== manifest.run_id
    || evidence.branch_name !== manifest.branch_name
    || evidence.remote_name !== remoteName
    || evidence.pull_request_number !== mapping.number
    || normalizedUrl(evidence.pull_request_url) !== normalizedUrl(mapping.url)) {
    return {
      blocker_code: "invalid_remote_synchronization",
      blocker: "Durable remote synchronization evidence does not match the current run, branch, remote, or pull request mapping.",
      invalid_evidence: [path],
    };
  }
  const integratedCommit = manifest.work_item_progress.integrated?.commit_sha;
  const expected = candidateCommit.toLowerCase();
  if (typeof integratedCommit !== "string"
    || integratedCommit.toLowerCase() !== expected
    || evidence.synchronized !== true
    || evidence.local_candidate_sha !== expected
    || evidence.mapped_pr_sha !== expected
    || evidence.remote_head_sha !== expected) {
    return {
      blocker_code: "remote_candidate_mismatch",
      blocker: "Durable synchronization does not prove the local candidate, mapped pull request, remote branch, and integrated commit are identical.",
      invalid_evidence: [path],
    };
  }
  const boundary = manifest.work_item_progress.integrated?.github_status_transition_at;
  if (typeof boundary !== "string") {
    return {
      blocker_code: "invalid_remote_synchronization",
      blocker: "Durable remote synchronization requires the final integrated candidate boundary.",
      invalid_evidence: [path],
    };
  }
  if (Date.parse(evidence.observed_at) < Date.parse(boundary)) {
    return {
      blocker_code: "stale_remote_synchronization",
      blocker: "Durable remote synchronization evidence predates the final integrated candidate boundary.",
      invalid_evidence: [path],
    };
  }
  return null;
}

async function assessLegacyRemoteCandidate(
  manifest: RunManifestV2,
  candidateCommit: string,
  options: AssuranceAssessmentOptions,
): Promise<RemoteBlocker | null> {
  let mapping;
  try { mapping = requirePersistedPullRequestMapping(manifest); } catch {
    return { blocker_code: "pull_request_candidate_mismatch", blocker: "The persisted pull request mapping is incomplete or invalid." };
  }
  if (!manifest.worktree_path || !manifest.branch_name) {
    return { blocker_code: "pull_request_candidate_mismatch", blocker: "The persisted pull request mapping is incomplete or invalid." };
  }
  const remoteName = "origin";
  const resolveRemote = options.legacyRemoteCandidate?.resolveRemoteSha ?? resolveRemoteBranchSha;
  const getPullRequest = options.legacyRemoteCandidate?.getPullRequest
    ?? ((number: number) => new GhCliGitHubAdapter(manifest.repo_root).getPullRequest(number));
  let remoteCommit: string | null = null;
  try {
    remoteCommit = await resolveRemote(manifest.worktree_path, manifest.branch_name, remoteName);
  } catch { /* reported below */ }
  if (remoteCommit?.toLowerCase() !== candidateCommit.toLowerCase()) {
    return { blocker_code: "remote_candidate_mismatch", blocker: "The remote pull-request branch does not match the current candidate commit." };
  }
  try {
    const pullRequest = await getPullRequest(mapping.number);
    if (!pullRequest
      || pullRequest.number !== mapping.number
      || normalizedUrl(pullRequest.url) !== normalizedUrl(mapping.url)
      || pullRequest.state !== "OPEN"
      || pullRequest.head_ref !== manifest.branch_name
      || pullRequest.head_sha?.toLowerCase() !== candidateCommit.toLowerCase()) {
      return { blocker_code: "pull_request_candidate_mismatch", blocker: "The pull request does not exist at the exact current candidate branch and commit." };
    }
  } catch {
    return { blocker_code: "pull_request_candidate_mismatch", blocker: "The pull request does not exist at the exact current candidate branch and commit." };
  }
  return null;
}

function artifactName(prefix: string, timestamp: string, value: unknown): string {
  const compact = timestamp.replaceAll(/[^0-9]/g, "");
  const digest = createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
  return `assurance/${prefix}-${compact}-${digest}.json`;
}

async function ensureAssuranceDirectory(runDir: string): Promise<void> {
  const path = join(runDir, "assurance");
  await mkdir(path, { recursive: true });
  if (!(await lstat(path)).isDirectory()) throw new Error("Run assurance path must be a directory");
}

async function optionalArtifact<T>(runDir: string, path: string, schema: ZodType<T>): Promise<T | null> {
  try {
    return await readOptionalValidatedArtifact(runDir, path, schema);
  } catch {
    return null;
  }
}

function blocked(input: Omit<AssuranceAssessment, "outcome" | "assessed_at" | "acceptance_path"> & { acceptance_path?: string | null }): AssuranceAssessment {
  return assuranceAssessmentSchema.parse({
    ...input,
    outcome: "blocked",
    assessed_at: new Date().toISOString(),
    acceptance_path: input.acceptance_path ?? null,
  });
}

function acceptanceMatches(acceptance: RiskAcceptanceArtifact, assessment: AssuranceAssessment, runId: string): boolean {
  return acceptance.run_id === runId
    && acceptance.approved_plan_revision === assessment.approved_plan_revision
    && acceptance.approved_plan_sha256 === assessment.approved_plan_sha256
    && acceptance.candidate_commit === assessment.candidate_commit
    && acceptance.blocker_code === assessment.blocker_code
    && acceptance.blocker === assessment.blocker
    && JSON.stringify(acceptance.missing_evidence) === JSON.stringify(assessment.missing_evidence)
    && JSON.stringify(acceptance.invalid_evidence) === JSON.stringify(assessment.invalid_evidence);
}

/** Recompute terminal assurance from current durable provenance. This never trusts delivery_state alone. */
export async function assessFinalDelivery(runDir: string, options: AssuranceAssessmentOptions = {}): Promise<AssuranceAssessment> {
  const { manifest, unsafeSynchronizationPointer } = await readAssuranceManifest(runDir);
  const requiresRemoteCandidate = manifest.mode === "github"
    && (manifest.stage === "delivery" || manifest.stage === "complete" || manifest.work_item_progress.integrated !== undefined);
  if (manifest.abandonment_path) {
    const abandonment = await optionalArtifact(runDir, manifest.abandonment_path, abandonmentArtifactSchema);
    if (abandonment?.run_id === manifest.run_id) {
      return assuranceAssessmentSchema.parse({
        outcome: "abandoned", assessed_at: new Date().toISOString(),
        approved_plan_revision: manifest.approved_revision,
        approved_plan_sha256: manifest.approved_revision ? manifest.plan_revisions[String(manifest.approved_revision)]?.sha256 ?? null : null,
        candidate_commit: null, blocker_code: null, blocker: null,
        missing_evidence: [], invalid_evidence: [], zero_attempt_work_items: [], acceptance_path: null,
      });
    }
  }
  if (unsafeSynchronizationPointer) {
    let candidateCommit: string | null = options.candidateCommit ?? null;
    if (candidateCommit === null && manifest.worktree_path) {
      try { candidateCommit = await resolveLocalHeadSha(manifest.worktree_path); } catch { /* included as null provenance */ }
    }
    const revision = manifest.approved_revision ?? manifest.approved_plan_revision;
    return blocked({
      approved_plan_revision: revision ?? null,
      approved_plan_sha256: revision ? manifest.plan_revisions[String(revision)]?.sha256 ?? null : null,
      candidate_commit: candidateCommit,
      blocker_code: "invalid_remote_synchronization",
      blocker: "The remote synchronization manifest pointer is unsafe or invalid.",
      missing_evidence: [],
      invalid_evidence: ["manifest.json"],
      zero_attempt_work_items: [],
    });
  }
  let acceptanceHistoryValid = new Set(manifest.risk_acceptance_history).size === manifest.risk_acceptance_history.length;
  if (manifest.risk_acceptance_path !== null) {
    acceptanceHistoryValid = acceptanceHistoryValid
      && manifest.risk_acceptance_history.at(-1) === manifest.risk_acceptance_path;
  }
  for (const path of manifest.risk_acceptance_history) {
    const artifact = await optionalArtifact(runDir, path, riskAcceptanceArtifactSchema);
    if (!artifact || artifact.run_id !== manifest.run_id) acceptanceHistoryValid = false;
  }

  const revision = manifest.approved_revision ?? manifest.approved_plan_revision;
  const record = revision ? manifest.plan_revisions[String(revision)] : undefined;
  let planValid = false;
  let requiredWorkItemIds: string[] = [];
  const revisionPointersAgree = revision !== null && revision !== undefined
    && manifest.approved_revision === manifest.approved_plan_revision
    && manifest.current_revision === manifest.current_plan_revision
    && revision === manifest.current_revision;
  if (revision && record && revisionPointersAgree) {
    try {
      const plan = (await loadVerifiedPlanBundle(runDir, manifest, revision)).plan as { work_items?: unknown };
      if (!Array.isArray(plan.work_items) || plan.work_items.length === 0) throw new Error("Approved plan has no work items");
      requiredWorkItemIds = plan.work_items.map((item) => {
        return manifest.workflow_protocol === "bounded-context-v1"
          ? executionSpecV2Schema.parse(item).id
          : (() => {
              const id = item && typeof item === "object" ? (item as { id?: unknown }).id : undefined;
              if (typeof id !== "string" || id.trim() === "") throw new Error("Approved plan work item has no ID");
              return id;
            })();
      });
      if (new Set(requiredWorkItemIds).size !== requiredWorkItemIds.length) throw new Error("Approved plan work item IDs are not unique");
      planValid = true;
    } catch { /* reported below */ }
  }

  let candidateCommit: string | null = options.candidateCommit ?? null;
  let worktreeClean = options.worktreeClean ?? false;
  if (manifest.worktree_path) {
    if (options.candidateCommit === undefined) {
      try { candidateCommit = await resolveLocalHeadSha(manifest.worktree_path); } catch { /* reported below */ }
    }
    if (options.worktreeClean === undefined) {
      try { worktreeClean = (await getGitSnapshot(manifest.worktree_path)).status.trim() === ""; } catch { /* reported below */ }
    }
  }
  let remoteBlocker: RemoteBlocker | null = null;
  if (requiresRemoteCandidate && candidateCommit) {
    remoteBlocker = Object.prototype.hasOwnProperty.call(manifest, "remote_synchronization_path")
      ? await assessDurableRemoteSynchronization(runDir, manifest, candidateCommit)
      : await assessLegacyRemoteCandidate(manifest, candidateCommit, options);
  }
  const invalidIndexPaths: string[] = [];
  if (manifest.workflow_protocol === "bounded-context-v1") {
    const integrated = manifest.work_item_progress.integrated;
    const attempt = integrated?.attempts ?? 0;
    const phase = integrated?.delivery_phase === "post_pr" ? "post_pr" : "final_integrated";
    const expectedPath = Number.isInteger(attempt) && attempt > 0
      ? verifierEvidenceIndexPath(phase, attempt)
      : manifest.final_verifier_index_path ?? "evidence-indexes/verifier";
    try {
      if (!candidateCommit || !Number.isInteger(attempt) || attempt < 1) {
        throw new Error("Final-Verifier evidence index identity is incomplete");
      }
      if (manifest.final_verifier_index_path !== expectedPath || typeof manifest.final_verifier_index_sha256 !== "string") {
        throw new Error("Final-Verifier evidence index pointer does not match the terminal phase");
      }
      const indexRef = { path: expectedPath, sha256: manifest.final_verifier_index_sha256 };
      if (typeof integrated?.review_path !== "string") {
        throw new Error("Final-Verifier evidence index requires the matching terminal review");
      }
      const finalReviewRef = artifactRefFromBytes(
        integrated.review_path,
        await readOwnedRunFile(runDir, integrated.review_path),
      );
      const index = await loadEvidenceIndex(runDir, indexRef, {
        phase,
        attempt,
        candidateCommit,
        findingValidation: { mode: "post_review", finalReviewRef },
      });
      const approvedPlanRef = revision && record
        ? { path: `plans/revision-${revision}.md`, sha256: record.sha256 }
        : null;
      const integratedVerificationPath = typeof integrated?.verification_path === "string"
        ? integrated.verification_path
        : null;
      const integratedVerificationRef = integratedVerificationPath
        ? artifactRefFromBytes(integratedVerificationPath, await readOwnedRunFile(runDir, integratedVerificationPath))
        : null;
      if (
        index.phase !== phase
        || index.attempt !== attempt
        || index.candidate_commit !== candidateCommit
        || JSON.stringify(index.approved_plan_ref) !== JSON.stringify(approvedPlanRef)
        || JSON.stringify(index.integrated_verification_ref) !== JSON.stringify(integratedVerificationRef)
      ) throw new Error("Final-Verifier evidence index does not match current terminal authority");
    } catch {
      invalidIndexPaths.push(expectedPath);
    }
  }
  const progressEntries = Object.entries(manifest.work_item_progress);
  const zeroAttempts = progressEntries.filter(([, progress]) => progress.status === "complete" && progress.attempts < 1).map(([id]) => id).sort();
  const incomplete = requiredWorkItemIds.filter((id) => manifest.work_item_progress[id]?.status !== "complete").sort();
  const base = {
    approved_plan_revision: revision ?? null,
    approved_plan_sha256: record?.sha256 ?? null,
    candidate_commit: candidateCommit,
    missing_evidence: [] as string[], invalid_evidence: [] as string[], zero_attempt_work_items: zeroAttempts,
  };
  let assessment: AssuranceAssessment;
  if (!acceptanceHistoryValid) assessment = blocked({ ...base, blocker_code: "invalid_acceptance_history", blocker: "Risk-acceptance history is missing, corrupt, duplicated, or detached from its active pointer." });
  else if (!planValid) assessment = blocked({ ...base, blocker_code: "invalid_plan_provenance", blocker: "The current plan is not the exact approved plan revision." });
  else if (!candidateCommit) assessment = blocked({ ...base, blocker_code: "unknown_candidate_commit", blocker: "The candidate commit cannot be resolved." });
  else if (!worktreeClean) assessment = blocked({ ...base, blocker_code: "dirty_candidate_worktree", blocker: "The candidate worktree is not clean." });
  else if (remoteBlocker) assessment = blocked({ ...base, ...remoteBlocker });
  else if (zeroAttempts.length > 0) assessment = blocked({ ...base, blocker_code: "zero_attempt_completion", blocker: `Completed work items have zero attempts: ${zeroAttempts.join(", ")}` });
  else if (incomplete.length > 0) assessment = blocked({ ...base, blocker_code: "work_incomplete", blocker: `Required work items are incomplete: ${incomplete.join(", ")}` });
  else {
    const integrated = manifest.work_item_progress.integrated;
    const missing = [integrated?.verification_path, integrated?.review_path].filter((value): value is undefined => value === undefined);
    const missingPaths = missing.length > 0
      ? [integrated?.verification_path ? null : "verification/integrated", integrated?.review_path ? null : "reviews/integrated"].filter((value): value is string => value !== null)
      : [];
    if (!integrated || integrated.status !== "complete" || integrated.attempts < 1 || missingPaths.length > 0) {
      assessment = blocked({ ...base, blocker_code: "missing_final_evidence", blocker: "Final integrated verification evidence is incomplete.", missing_evidence: missingPaths });
    } else {
      const expectedEvidencePath = `verification/integrated/attempt-${integrated.attempts}/evidence.json`;
      const expectedReviewPath = `reviews/integrated/final-attempt-${integrated.attempts}.json`;
      const evidence = integrated.verification_path === expectedEvidencePath
        ? await validatePersistedVerificationEvidence({
          runDir, identity: { scope: "integrated", work_item_id: "integrated" },
          attempt: integrated.attempts, evidencePath: expectedEvidencePath,
        }).catch(() => null)
        : null;
      const review = await optionalArtifact(runDir, integrated.review_path as string, persistedVerifierReviewSchema);
      const finalPointersCurrent = manifest.final_artifact_paths.includes(expectedEvidencePath)
        && manifest.final_artifact_paths.includes(expectedReviewPath);
      const invalid = [
        ...invalidIndexPaths,
        evidence ? null : integrated.verification_path,
        review && integrated.review_path === expectedReviewPath && finalPointersCurrent ? null : integrated.review_path,
      ].filter((value): value is string => typeof value === "string");
      if (invalid.length > 0) assessment = blocked({ ...base, blocker_code: "invalid_final_evidence", blocker: "Final integrated evidence is missing or invalid.", invalid_evidence: invalid });
      else if (evidence!.attempt !== integrated.attempts || review!.attempt !== integrated.attempts || review!.work_item_id !== "integrated" || review!.final !== true || review!.decision !== "approve" || evidence!.commands.some((command) => command.exit_code !== 0 || command.timed_out) || evidence!.artifact_checks.some((artifact) => artifact.required && !artifact.exists) || evidence!.browser_evidence.some((browser) => browser.status !== "passed" || !browser.screenshot_exists)) {
        assessment = blocked({ ...base, blocker_code: "final_verification_failed", blocker: "Final verification and review do not prove the current delivery candidate.", invalid_evidence: [integrated.verification_path as string, integrated.review_path as string] });
      } else if (integrated.commit_sha !== candidateCommit) {
        assessment = blocked({ ...base, blocker_code: "candidate_commit_mismatch", blocker: "Final evidence is bound to a different candidate commit." });
      } else {
        assessment = assuranceAssessmentSchema.parse({ ...base, outcome: "verified_ready", assessed_at: new Date().toISOString(), blocker_code: null, blocker: null, acceptance_path: null });
      }
    }
  }

  if (assessment.outcome === "blocked" && manifest.risk_acceptance_path && WAIVABLE_BLOCKERS.has(assessment.blocker_code ?? "")) {
    const acceptance = await optionalArtifact(runDir, manifest.risk_acceptance_path, riskAcceptanceArtifactSchema);
    if (acceptance && acceptanceMatches(acceptance, assessment, manifest.run_id)) {
      assessment = assuranceAssessmentSchema.parse({ ...assessment, outcome: "human_accepted", acceptance_path: manifest.risk_acceptance_path });
    }
  }
  return assessment;
}

async function persistAssessmentLocked(
  runDir: string,
  transaction: { readManifestV2(): Promise<RunManifestV2>; updateManifestV2(patch: Parameters<typeof updateManifestV2>[1]): Promise<RunManifestV2> },
  providedAssessment?: AssuranceAssessment,
): Promise<AssuranceAssessment> {
  const assessment = providedAssessment ?? await assessFinalDelivery(runDir);
  const before = await transaction.readManifestV2();
  await ensureAssuranceDirectory(runDir);
  const path = artifactName("assessment", assessment.assessed_at, assessment);
  await writeCreateOnceValidated(runDir, path, assessment, assuranceAssessmentSchema);
  if (before.assurance_outcome !== assessment.outcome) {
    await appendRunEvent(runDir, {
      actor: "assurance", stage: before.stage, type: "assurance_outcome_changed",
      payload: { from: before.assurance_outcome, to: assessment.outcome, assessment_path: path },
    });
  }
  await transaction.updateManifestV2({ assurance_outcome: assessment.outcome, assurance_assessment_path: path });
  return assessment;
}

export async function persistFinalDeliveryAssessment(runDir: string): Promise<AssuranceAssessment> {
  return withRunLedgerCompoundTransaction(runDir, async (transaction) =>
    persistAssessmentLocked(runDir, transaction));
}

/** Persist assurance only once execution has reached a final-delivery gate. */
export async function persistFinalDeliveryAssessmentAtBoundary(runDir: string): Promise<AssuranceAssessment | null> {
  return withRunLedgerCompoundTransaction(runDir, async (transaction) => {
    const manifest = await transaction.readManifestV2();
    if (!manifest.abandonment_path && !["final_verification", "delivery", "complete"].includes(manifest.stage)) {
      return null;
    }
    return persistAssessmentLocked(runDir, transaction);
  });
}

export async function acceptFinalDeliveryRisk(runDir: string, actor: string, reason: string): Promise<RiskAcceptanceArtifact> {
  return withRunLedgerCompoundTransaction(runDir, async (transaction) => {
    const assessment = await assessFinalDelivery(runDir);
    const existingManifest = await transaction.readManifestV2();
    const atFinalDeliveryGate = ["final_verification", "verifier_review", "delivery", "complete"].includes(existingManifest.stage);
    if (!atFinalDeliveryGate) throw new Error("Risk acceptance is available only at the blocked final-delivery gate");
    let activeAcceptanceMatches = false;
    if (existingManifest.risk_acceptance_path) {
      const existing = await optionalArtifact(runDir, existingManifest.risk_acceptance_path, riskAcceptanceArtifactSchema);
      activeAcceptanceMatches = Boolean(existing && acceptanceMatches(existing, assessment, existingManifest.run_id));
      if (existing && activeAcceptanceMatches && existing.actor === actor.trim() && existing.reason === reason.trim()) return existing;
    }
    if ((assessment.outcome !== "blocked" && !(assessment.outcome === "human_accepted" && activeAcceptanceMatches))
      || !WAIVABLE_BLOCKERS.has(assessment.blocker_code ?? "")) {
      throw new Error(`Final-delivery risk acceptance requires a waivable evidence blocker; current blocker is ${assessment.blocker_code ?? "none"}`);
    }
    if (!assessment.approved_plan_revision || !assessment.approved_plan_sha256 || !assessment.candidate_commit || !assessment.blocker_code || !assessment.blocker) {
      throw new Error("Final-delivery risk acceptance requires exact plan, commit, and blocker provenance");
    }
    const artifact = riskAcceptanceArtifactSchema.parse({
      version: 1, run_id: existingManifest.run_id, gate: "final-delivery",
      approved_plan_revision: assessment.approved_plan_revision, approved_plan_sha256: assessment.approved_plan_sha256,
      candidate_commit: assessment.candidate_commit, blocker_code: assessment.blocker_code, blocker: assessment.blocker,
      missing_evidence: assessment.missing_evidence, invalid_evidence: assessment.invalid_evidence,
      actor, timestamp: new Date().toISOString(), reason,
    });
    const path = artifactName("acceptance", artifact.timestamp, artifact);
    await ensureAssuranceDirectory(runDir);
    await writeCreateOnceValidated(runDir, path, artifact, riskAcceptanceArtifactSchema);
    const manifest = await transaction.readManifestV2();
    await appendRunEvent(runDir, { actor, stage: manifest.stage, type: "final_delivery_risk_accepted", payload: { gate: artifact.gate, acceptance_path: path } });
    await transaction.updateManifestV2({ risk_acceptance_path: path, risk_acceptance_history: [...manifest.risk_acceptance_history, path] });
    await persistAssessmentLocked(runDir, transaction);
    return artifact;
  });
}

export async function abandonRun(runDir: string, actor: string, reason: string): Promise<AbandonmentArtifact> {
  return withRunLedgerCompoundTransaction(runDir, async (transaction) => {
    const manifest = await transaction.readManifestV2();
    if (manifest.abandonment_path || manifest.assurance_outcome === "abandoned") throw new Error("Run is already abandoned");
    const artifact = abandonmentArtifactSchema.parse({ version: 1, run_id: manifest.run_id, actor, timestamp: new Date().toISOString(), reason });
    const path = artifactName("abandonment", artifact.timestamp, artifact);
    await ensureAssuranceDirectory(runDir);
    await writeCreateOnceValidated(runDir, path, artifact, abandonmentArtifactSchema);
    await appendRunEvent(runDir, { actor, stage: manifest.stage, type: "run_abandoned", payload: { abandonment_path: path } });
    await transaction.updateManifestV2({ abandonment_path: path, assurance_outcome: "abandoned", delivery_state: "blocked", last_blocker: "Run abandoned by a human actor." });
    await persistAssessmentLocked(runDir, transaction);
    return artifact;
  });
}

export function assertNotAbandoned(manifest: RunManifestV2): void {
  if (manifest.abandonment_path || manifest.assurance_outcome === "abandoned") throw new Error("Abandoned runs cannot be resumed or delivered");
}
