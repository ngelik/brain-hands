import {
  artifactRefFromBytes,
  artifactRefV1Schema,
  evidenceIndexV1Schema,
  type ArtifactRefV1,
  type EvidenceIndexV1,
  type WorkItemSummaryV1,
  workItemSummaryV1Schema,
} from "../core/context-contracts.js";
import {
  readReferencedJson,
  readVerifiedPlanRevision,
  withRunLedgerTransaction,
  writeImmutableValidatedJson,
} from "../core/ledger.js";
import { readOwnedRunFile } from "../core/owned-evidence.js";
import {
  assuranceAssessmentSchema,
  engineFindingSchema,
  executionSpecV2Schema,
  persistedVerifierReviewSchema,
  reviewCycleStateSchema,
  verificationEvidenceSchema,
} from "../core/schema.js";
import type {
  AssuranceOutcome,
  RunManifestV2,
  TerminalDisposition,
  WorkItem,
} from "../core/types.js";
import { loadCurrentFindingResolution, loadCurrentUnresolvedFindingReference } from "./findings.js";
import { loadWorkItemSummary } from "./work-item-summaries.js";

export type VerifierEvidenceIndexPhase = "final_integrated" | "post_pr";

interface CommonEvidenceIndexInput {
  runDir: string;
  attempt: number;
  candidateCommit: string;
  workItemSummaryRefs: ArtifactRefV1[];
  integratedVerificationRef: ArtifactRefV1;
  createdAt?: string;
  hooks?: EvidenceIndexBuildHooks;
}

export interface EvidenceIndexBuildHooks {
  afterAuthorityValidated?: () => Promise<void>;
}

export interface BuildVerifierEvidenceIndexInput extends CommonEvidenceIndexInput {
  phase: VerifierEvidenceIndexPhase;
}

export interface BuildReflectionEvidenceIndexInput extends CommonEvidenceIndexInput {
  finalReviewRef: ArtifactRefV1;
}

export interface LoadEvidenceIndexExpected {
  phase: EvidenceIndexV1["phase"];
  attempt: number;
  candidateCommit: string;
  hooks?: {
    afterArtifactRead?: () => Promise<void>;
  };
  findingValidation?: {
    mode: "post_review";
    finalReviewRef: ArtifactRefV1;
  };
}

interface ApprovedPlanAuthority {
  runDir: string;
  manifest: RunManifestV2;
  ref: ArtifactRefV1;
  revision: number;
  sha256: string;
  workItems: WorkItem[];
}

interface CommonAuthority extends ApprovedPlanAuthority {
  findingRefs: ArtifactRefV1[];
}

interface ReflectionAuthority {
  finalReviewRef: ArtifactRefV1;
  terminal: TerminalDisposition;
  assurance: {
    outcome: AssuranceOutcome;
    assessment_ref: ArtifactRefV1 | null;
  };
}

function equalJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertPositiveAttempt(attempt: number): void {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new Error("Evidence index attempt must be positive");
  }
}

export function verifierEvidenceIndexPath(
  phase: VerifierEvidenceIndexPhase,
  attempt: number,
): string {
  assertPositiveAttempt(attempt);
  const directory = phase === "final_integrated" ? "final-integrated" : "post-pr";
  return `evidence-indexes/verifier/${directory}/attempt-${attempt}.json`;
}

export const reflectionEvidenceIndexPath = "evidence-indexes/reflection/final.json";

function structuredWorkItems(planText: string): WorkItem[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(planText);
  } catch {
    throw new Error("Evidence index requires a structured approved plan");
  }
  const raw = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as { work_items?: unknown }).work_items
    : undefined;
  if (!Array.isArray(raw)) throw new Error("Evidence index approved plan has no work items");
  const workItems = raw.map((entry) => executionSpecV2Schema.parse(entry));
  const ids = workItems.map((entry) => entry.id);
  if (new Set(ids).size !== ids.length) {
    throw new Error("Evidence index approved plan work-item IDs are not unique");
  }
  return workItems.filter((entry) => entry.id !== "integrated");
}

async function approvedPlanAuthority(
  runDir: string,
  manifest: RunManifestV2,
): Promise<ApprovedPlanAuthority> {
  if (manifest.workflow_protocol !== "bounded-context-v1") {
    throw new Error("Evidence indexes require the bounded-context-v1 workflow protocol");
  }
  const revision = manifest.approved_revision ?? manifest.approved_plan_revision;
  if (
    revision === null
    || manifest.approved_revision !== revision
    || manifest.approved_plan_revision !== revision
  ) throw new Error("Evidence index approved-plan pointers do not agree");
  const recorded = manifest.plan_revisions[String(revision)];
  if (!recorded) throw new Error("Evidence index approved plan is not recorded");
  const planText = await readVerifiedPlanRevision(runDir, manifest, revision);
  const relativePath = `plans/revision-${revision}.md`;
  return {
    runDir,
    manifest,
    ref: artifactRefV1Schema.parse({ path: relativePath, sha256: recorded.sha256 }),
    revision,
    sha256: recorded.sha256,
    workItems: structuredWorkItems(planText),
  };
}

async function planWorkItem(
  runDir: string,
  manifest: RunManifestV2,
  revision: number,
  workItemId: string,
): Promise<WorkItem> {
  const items = structuredWorkItems(await readVerifiedPlanRevision(runDir, manifest, revision));
  const matches = items.filter((entry) => entry.id === workItemId);
  if (matches.length !== 1) {
    throw new Error(`Work-item summary ${workItemId} is not unique in its recorded plan`);
  }
  return matches[0]!;
}

async function validateSummaryRefs(
  authority: ApprovedPlanAuthority,
  refs: ArtifactRefV1[],
): Promise<void> {
  const summaries: WorkItemSummaryV1[] = [];
  const seen = new Set<string>();
  for (const rawRef of refs) {
    const ref = artifactRefV1Schema.parse(rawRef);
    const summary = await readReferencedJson(authority.runDir, ref, workItemSummaryV1Schema);
    if (seen.has(summary.work_item_id)) {
      throw new Error(`Duplicate work-item summary for ${summary.work_item_id}`);
    }
    seen.add(summary.work_item_id);
    summaries.push(summary);
  }
  const expectedIds = authority.workItems.map((entry) => entry.id);
  const missing = expectedIds.find((id) => !seen.has(id));
  if (missing) throw new Error(`Missing work-item summary for ${missing}`);
  const extra = summaries.find((summary) => !expectedIds.includes(summary.work_item_id));
  if (extra) throw new Error(`Unexpected work-item summary for ${extra.work_item_id}`);
  if (!equalJson(summaries.map((summary) => summary.work_item_id), expectedIds)) {
    throw new Error("Work-item summary references are not in approved-plan order");
  }
  for (const [index, summary] of summaries.entries()) {
    const ref = refs[index]!;
    const currentWorkItem = authority.workItems[index]!;
    const historicalWorkItem = await planWorkItem(
      authority.runDir,
      authority.manifest,
      summary.plan_revision,
      summary.work_item_id,
    );
    if (!equalJson(currentWorkItem, historicalWorkItem)) {
      throw new Error(`Work-item summary ${summary.work_item_id} contract does not match the current approved plan`);
    }
    const progress = authority.manifest.work_item_progress[summary.work_item_id];
    if (
      progress?.status !== "complete"
      || progress.summary_path !== ref.path
      || progress.summary_sha256 !== ref.sha256
    ) throw new Error(`Work-item summary ${summary.work_item_id} is not the current durable summary authority`);
    await loadWorkItemSummary(authority.runDir, ref, {
      runId: authority.manifest.run_id,
      workItemId: summary.work_item_id,
      planRevision: summary.plan_revision,
      planSha256: summary.plan_sha256,
      attempt: summary.attempt,
      baseCommit: summary.base_commit,
      commitSha: summary.commit_sha,
    });
  }
}

async function currentFindingRefs(
  runDir: string,
  manifest: RunManifestV2,
): Promise<ArtifactRefV1[]> {
  const refs: ArtifactRefV1[] = [];
  const unresolvedDispositions = new Set(["blocking", "fix_in_scope", "requires_replan"]);
  const workItemIds = [...new Set(Object.values(manifest.finding_index ?? {})
    .filter((finding) => unresolvedDispositions.has(finding.disposition))
    .map((finding) => finding.work_item_id))].sort();
  for (const workItemId of workItemIds) {
    const progress = manifest.work_item_progress[workItemId];
    if (!Number.isInteger(progress?.review_revision) || (progress?.review_revision ?? 0) < 1) {
      if (Array.isArray(progress?.approved_replan_history) && progress.approved_replan_history.length > 0) continue;
      throw new Error(`Unresolved finding authority for ${workItemId} has no current positive review revision`);
    }
    const ref = await loadCurrentUnresolvedFindingReference(
      runDir,
      workItemId,
      progress.review_revision!,
    );
    if (ref) refs.push(ref);
  }
  return refs.sort((left, right) => left.path.localeCompare(right.path));
}

async function validateCommonAuthority(
  input: CommonEvidenceIndexInput,
  manifest: RunManifestV2,
): Promise<CommonAuthority> {
  assertPositiveAttempt(input.attempt);
  const authority = await approvedPlanAuthority(input.runDir, manifest);
  await validateSummaryRefs(authority, input.workItemSummaryRefs);
  const integrated = authority.manifest.work_item_progress.integrated;
  if (integrated?.status !== "in_progress" && integrated?.status !== "complete") {
    throw new Error("Integrated verification has no active durable authority");
  }
  if (integrated?.commit_sha !== input.candidateCommit) {
    throw new Error("Candidate commit does not match current integrated authority");
  }
  if (
    integrated.attempts !== input.attempt
    || integrated.verification_path !== input.integratedVerificationRef.path
  ) throw new Error("Integrated verification does not match current durable authority");
  const expectedPath = `verification/integrated/attempt-${input.attempt}/evidence.json`;
  if (input.integratedVerificationRef.path !== expectedPath) {
    throw new Error("Integrated verification does not match current durable authority");
  }
  const evidence = await readReferencedJson(
    input.runDir,
    artifactRefV1Schema.parse(input.integratedVerificationRef),
    verificationEvidenceSchema,
  );
  if (
    evidence.verification_scope !== "integrated"
    || evidence.work_item_id !== "integrated"
    || evidence.attempt !== input.attempt
    || evidence.evidence_path !== expectedPath
  ) throw new Error("Integrated verification provenance does not match current durable authority");
  return {
    ...authority,
    findingRefs: await currentFindingRefs(input.runDir, authority.manifest),
  };
}

async function artifactReference(runDir: string, path: string): Promise<ArtifactRefV1> {
  return artifactRefFromBytes(path, await readOwnedRunFile(runDir, path));
}

async function reflectionAuthority(
  input: BuildReflectionEvidenceIndexInput,
  authority: ApprovedPlanAuthority,
): Promise<ReflectionAuthority> {
  const integrated = authority.manifest.work_item_progress.integrated;
  const expectedPath = `reviews/integrated/final-attempt-${input.attempt}.json`;
  if (
    integrated?.review_path !== input.finalReviewRef.path
    || input.finalReviewRef.path !== expectedPath
    || !authority.manifest.final_artifact_paths.includes(input.integratedVerificationRef.path)
    || !authority.manifest.final_artifact_paths.includes(input.finalReviewRef.path)
  ) throw new Error("Final review does not match current durable authority");
  const review = await readReferencedJson(
    input.runDir,
    artifactRefV1Schema.parse(input.finalReviewRef),
    persistedVerifierReviewSchema,
  );
  if (
    review.work_item_id !== "integrated"
    || review.attempt !== input.attempt
    || review.final !== true
    || !review.evidence_reviewed.includes(input.integratedVerificationRef.path)
  ) throw new Error("Final review does not match current integrated evidence authority");
  if (!authority.manifest.terminal) throw new Error("Reflection evidence index requires a terminal disposition");
  if (!authority.manifest.assurance_outcome) throw new Error("Reflection evidence index requires an assurance outcome");
  const compatibleAssurance: Record<TerminalDisposition["outcome"], AssuranceOutcome> = {
    delivered: "verified_ready",
    human_accepted: "human_accepted",
    abandoned: "abandoned",
    closed_blocked: "blocked",
  };
  if (compatibleAssurance[authority.manifest.terminal.outcome] !== authority.manifest.assurance_outcome) {
    throw new Error("Reflection terminal and assurance outcomes are incompatible");
  }
  if (authority.manifest.terminal.outcome === "delivered" && review.decision !== "approve") {
    throw new Error("Delivered reflection final review must approve current integrated evidence");
  }
  let assessmentRef: ArtifactRefV1 | null = null;
  if (authority.manifest.assurance_assessment_path !== null) {
    assessmentRef = await artifactReference(input.runDir, authority.manifest.assurance_assessment_path);
    const assessment = await readReferencedJson(
      input.runDir,
      assessmentRef,
      assuranceAssessmentSchema,
    );
    if (
      assessment.outcome !== authority.manifest.assurance_outcome
      || assessment.approved_plan_revision !== authority.revision
      || assessment.approved_plan_sha256 !== authority.sha256
      || assessment.candidate_commit !== (assessment.outcome === "abandoned" ? null : input.candidateCommit)
    ) throw new Error("Assurance assessment does not match current durable authority");
  }
  return {
    finalReviewRef: input.finalReviewRef,
    terminal: authority.manifest.terminal,
    assurance: {
      outcome: authority.manifest.assurance_outcome,
      assessment_ref: assessmentRef,
    },
  };
}

function commonIndexFields(input: CommonEvidenceIndexInput, authority: CommonAuthority) {
  return {
    schema_version: 1 as const,
    run_id: authority.manifest.run_id,
    attempt: input.attempt,
    approved_plan_ref: authority.ref,
    candidate_commit: input.candidateCommit,
    work_item_summary_refs: input.workItemSummaryRefs,
    integrated_verification_ref: input.integratedVerificationRef,
    unresolved_finding_refs: authority.findingRefs,
    created_at: input.createdAt ?? new Date().toISOString(),
  };
}

function errorCode(error: unknown): unknown {
  return error && typeof error === "object" && "code" in error ? error.code : undefined;
}

async function optionalArtifactReference(
  runDir: string,
  path: string,
): Promise<ArtifactRefV1 | null> {
  try {
    return artifactRefFromBytes(path, await readOwnedRunFile(runDir, path));
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}

async function validateLoadedIndex(
  runDir: string,
  ref: ArtifactRefV1,
  index: EvidenceIndexV1,
  expected: LoadEvidenceIndexExpected,
  manifest: RunManifestV2,
): Promise<EvidenceIndexV1> {
  const expectedPath = expected.phase === "reflection"
    ? reflectionEvidenceIndexPath
    : verifierEvidenceIndexPath(expected.phase, expected.attempt);
  if (ref.path !== expectedPath) throw new Error("Evidence index path does not match its phase and attempt");
  if (
    index.phase !== expected.phase
    || index.attempt !== expected.attempt
    || index.candidate_commit !== expected.candidateCommit
  ) throw new Error("Evidence index identity does not match expected authority");
  const indexedFindings = expected.findingValidation
    ? await validateIndexedFindingRefs(runDir, index.unresolved_finding_refs)
    : [];
  const authority = await validateCommonAuthority({
    runDir,
    attempt: index.attempt,
    candidateCommit: index.candidate_commit,
    workItemSummaryRefs: index.work_item_summary_refs,
    integratedVerificationRef: index.integrated_verification_ref,
    createdAt: index.created_at,
  }, manifest);
  if (
    index.run_id !== authority.manifest.run_id
    || !equalJson(index.approved_plan_ref, authority.ref)
  ) throw new Error("Evidence index run or approved plan reference is stale");
  if (expected.findingValidation) {
    await validatePostReviewFindingAuthority(
      runDir,
      index,
      authority.manifest,
      expected.findingValidation.finalReviewRef,
      indexedFindings,
      authority.findingRefs,
    );
  } else if (!equalJson(index.unresolved_finding_refs, authority.findingRefs)) {
    throw new Error("Evidence index is missing or has a stale active finding reference");
  }
  if (index.phase === "reflection") {
    const reflection = await reflectionAuthority({
      runDir,
      attempt: index.attempt,
      candidateCommit: index.candidate_commit,
      workItemSummaryRefs: index.work_item_summary_refs,
      integratedVerificationRef: index.integrated_verification_ref,
      finalReviewRef: index.final_review_ref,
      createdAt: index.created_at,
    }, authority);
    if (
      !equalJson(index.terminal, reflection.terminal)
      || !equalJson(index.assurance, reflection.assurance)
    ) throw new Error("Reflection evidence index terminal authority is stale");
  }
  return index;
}

async function validateIndexedFindingRefs(
  runDir: string,
  refs: ArtifactRefV1[],
): Promise<Array<ReturnType<typeof engineFindingSchema.parse>>> {
  const findings: Array<ReturnType<typeof engineFindingSchema.parse>> = [];
  for (const rawRef of refs) {
    const ref = artifactRefV1Schema.parse(rawRef);
    if (!/^findings\/work-item-[A-Za-z0-9_-]+\.jsonl$/.test(ref.path)) {
      throw new Error("Indexed finding history path is invalid");
    }
    const bytes = await readOwnedRunFile(runDir, ref.path);
    if (!equalJson(artifactRefFromBytes(ref.path, bytes), ref)) {
      throw new Error("Indexed finding history hash does not match its immutable reference");
    }
    for (const line of bytes.toString("utf8").split("\n").filter(Boolean)) {
      findings.push(engineFindingSchema.parse(JSON.parse(line)));
    }
  }
  return findings;
}

async function validatePostReviewFindingAuthority(
  runDir: string,
  index: EvidenceIndexV1,
  manifest: RunManifestV2,
  rawFinalReviewRef: ArtifactRefV1,
  indexedHistory: Array<ReturnType<typeof engineFindingSchema.parse>>,
  currentFindingRefs: ArtifactRefV1[],
): Promise<void> {
  if (index.phase === "reflection") {
    throw new Error("Post-review finding validation is unavailable for reflection indexes");
  }
  const finalReviewRef = artifactRefV1Schema.parse(rawFinalReviewRef);
  const integrated = manifest.work_item_progress.integrated;
  if (integrated?.review_path !== finalReviewRef.path) {
    throw new Error("Post-review finding validation requires the current terminal review pointer");
  }
  const review = await readReferencedJson(runDir, finalReviewRef, persistedVerifierReviewSchema);
  let policyAdvanceAuthority = false;
  if (review.decision !== "approve"
    && typeof integrated.review_cycle_path === "string"
    && typeof integrated.review_effect_id === "string") {
    const cycle = reviewCycleStateSchema.parse(JSON.parse(
      (await readOwnedRunFile(runDir, integrated.review_cycle_path)).toString("utf8"),
    ));
    policyAdvanceAuthority = cycle.phase === index.phase
      && cycle.decision_path === integrated.review_cycle_path
      && cycle.effect_id === integrated.review_effect_id
      && (cycle.decision.action === "advance" || cycle.decision.action === "continue_with_warning");
  }
  if (
    review.work_item_id !== "integrated"
    || review.attempt !== index.attempt
    || review.final !== true
    || (review.decision !== "approve" && !policyAdvanceAuthority)
    || !review.evidence_reviewed.includes(index.integrated_verification_ref.path)
  ) throw new Error("Post-review finding validation requires the matching approving terminal review or policy advance authority");
  if (currentFindingRefs.length > 0 && !policyAdvanceAuthority) {
    throw new Error("Post-review finding validation found a new unresolved terminal finding");
  }
  if (currentFindingRefs.length > 0 && policyAdvanceAuthority) return;
  if (index.unresolved_finding_refs.length === 0) return;
  if (!Number.isInteger(integrated.review_revision) || integrated.review_revision! < 1) {
    throw new Error("Post-review finding validation requires a current review revision");
  }
  const latestById = new Map(indexedHistory.map((finding) => [finding.finding_id, finding]));
  const indexedUnresolved = [...latestById.values()].filter((finding) =>
    ["blocking", "fix_in_scope", "requires_replan"].includes(finding.disposition));
  if (
    indexedUnresolved.length === 0
    || indexedUnresolved.some((finding) => finding.work_item_id !== "integrated")
  ) throw new Error("Post-review finding validation requires indexed integrated unresolved findings");
  const resolution = await loadCurrentFindingResolution(
    runDir,
    "integrated",
    integrated.review_revision!,
  );
  if (
    resolution.unresolved_finding_ids.length > 0
    || indexedUnresolved.some((finding) => !resolution.resolved_finding_ids.includes(finding.finding_id))
  ) throw new Error("Indexed finding was not resolved by the matching terminal review");
}

function validateReplayInput(
  index: EvidenceIndexV1,
  input: CommonEvidenceIndexInput,
  finalReviewRef?: ArtifactRefV1,
): void {
  if (!equalJson(input.workItemSummaryRefs, index.work_item_summary_refs)) {
    throw new Error("Evidence index replay work-item summary references do not match the stored index");
  }
  if (!equalJson(input.integratedVerificationRef, index.integrated_verification_ref)) {
    throw new Error("Evidence index replay integrated verification reference does not match the stored index");
  }
  if (index.phase === "reflection" && !equalJson(finalReviewRef, index.final_review_ref)) {
    throw new Error("Evidence index replay final review reference does not match the stored index");
  }
}

export async function buildVerifierEvidenceIndex(
  input: BuildVerifierEvidenceIndexInput,
): Promise<ArtifactRefV1> {
  return withRunLedgerTransaction(input.runDir, async (transaction) => {
    const path = verifierEvidenceIndexPath(input.phase, input.attempt);
    const existing = input.createdAt === undefined
      ? await optionalArtifactReference(transaction.runDir, path)
      : null;
    if (existing) {
      const index = await readReferencedJson(transaction.runDir, existing, evidenceIndexV1Schema);
      let manifest = await transaction.readManifestV2();
      await validateLoadedIndex(transaction.runDir, existing, index, {
        phase: input.phase,
        attempt: input.attempt,
        candidateCommit: input.candidateCommit,
      }, manifest);
      if (input.hooks?.afterAuthorityValidated) {
        await input.hooks.afterAuthorityValidated();
        manifest = await transaction.readManifestV2();
        await validateLoadedIndex(transaction.runDir, existing, index, {
          phase: input.phase,
          attempt: input.attempt,
          candidateCommit: input.candidateCommit,
        }, manifest);
      }
      validateReplayInput(index, input);
      return existing;
    }
    let manifest = await transaction.readManifestV2();
    let authority = await validateCommonAuthority(input, manifest);
    if (input.hooks?.afterAuthorityValidated) {
      await input.hooks.afterAuthorityValidated();
      manifest = await transaction.readManifestV2();
      authority = await validateCommonAuthority(input, manifest);
    }
    return writeImmutableValidatedJson(
      transaction.runDir,
      path,
      evidenceIndexV1Schema,
      {
        ...commonIndexFields(input, authority),
        phase: input.phase,
        final_review_ref: null,
        terminal: null,
      },
    );
  });
}

export async function buildReflectionEvidenceIndex(
  input: BuildReflectionEvidenceIndexInput,
): Promise<ArtifactRefV1> {
  return withRunLedgerTransaction(input.runDir, async (transaction) => {
    const existing = input.createdAt === undefined
      ? await optionalArtifactReference(transaction.runDir, reflectionEvidenceIndexPath)
      : null;
    if (existing) {
      const index = await readReferencedJson(transaction.runDir, existing, evidenceIndexV1Schema);
      let manifest = await transaction.readManifestV2();
      await validateLoadedIndex(transaction.runDir, existing, index, {
        phase: "reflection",
        attempt: input.attempt,
        candidateCommit: input.candidateCommit,
      }, manifest);
      if (input.hooks?.afterAuthorityValidated) {
        await input.hooks.afterAuthorityValidated();
        manifest = await transaction.readManifestV2();
        await validateLoadedIndex(transaction.runDir, existing, index, {
          phase: "reflection",
          attempt: input.attempt,
          candidateCommit: input.candidateCommit,
        }, manifest);
      }
      validateReplayInput(index, input, input.finalReviewRef);
      return existing;
    }
    let manifest = await transaction.readManifestV2();
    let authority = await validateCommonAuthority(input, manifest);
    let reflection = await reflectionAuthority(input, authority);
    if (input.hooks?.afterAuthorityValidated) {
      await input.hooks.afterAuthorityValidated();
      manifest = await transaction.readManifestV2();
      authority = await validateCommonAuthority(input, manifest);
      reflection = await reflectionAuthority(input, authority);
    }
    return writeImmutableValidatedJson(
      transaction.runDir,
      reflectionEvidenceIndexPath,
      evidenceIndexV1Schema,
      {
        ...commonIndexFields(input, authority),
        phase: "reflection",
        final_review_ref: reflection.finalReviewRef,
        terminal: reflection.terminal,
        assurance: reflection.assurance,
      },
    );
  });
}

export async function loadEvidenceIndex(
  runDir: string,
  ref: ArtifactRefV1,
  expected: LoadEvidenceIndexExpected,
): Promise<EvidenceIndexV1> {
  return withRunLedgerTransaction(runDir, async (transaction) => {
    const reference = artifactRefV1Schema.parse(ref);
    const index = await readReferencedJson(transaction.runDir, reference, evidenceIndexV1Schema);
    await expected.hooks?.afterArtifactRead?.();
    const manifest = await transaction.readManifestV2();
    return validateLoadedIndex(transaction.runDir, reference, index, expected, manifest);
  });
}
