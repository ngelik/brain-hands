import { realpath, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute } from "node:path";
import type { CodexAdapter } from "../adapters/codex.js";
import type { ResourceBudgetPort } from "../core/resource-budget.js";
import {
  commitPreparedPlanApprovalBoundary,
  acquireExecutionLease,
  assertExecutionLease,
  beginExecutionEffect,
  reconcilePreparedPlanApprovalBoundary,
  appendPlanApprovalEvent,
  appendRunEventOnce,
  buildPlanApprovalEventRecord,
  assertPlanApprovalEventPrecondition,
  hasExactPlanApprovalEvent,
  readManifestV2,
  readOptionalValidatedArtifact,
  type RunManifestV2Ledger,
  type VerifiedPlanApproval,
  withRunLedgerCompoundTransaction,
  verifyPlanApprovalSubject,
  verifyPersistedPlanApprovalSubject,
  recordExecutionEffectChild,
  endExecutionEffect,
  releaseExecutionLease,
  rejectPreparedPlanApprovalBoundary,
  updateManifestV2,
  type ApprovalControllerCapture,
  type RunLedgerTransactionHooks,
  writeCreateOnceValidated,
  writeTextArtifact,
} from "../core/ledger.js";
import { currentExecutionAuthority, runWithExecutionAuthority } from "../core/execution-context.js";
import { replanPatchOutputSchema } from "../core/output-schemas.js";
import { assertNoSecretMaterial } from "../core/secret-detector.js";
import {
  convergenceReportSchema,
  releaseGuardSchema,
  replanFindingContextSchema,
  replanPatchRecordSchema,
  roleProfileSchema,
  reviewCycleStateSchema,
  safeEvidenceRefSchema,
  executionSpecV2Schema,
  generatedReplanPatchSchema,
  planApprovalRequestSchema,
  persistedVerifierReviewSchema,
  verificationEvidenceSchema,
} from "../core/schema.js";
import type {
  ReleaseGuard,
  ReplanPatch,
  ReplanFindingContext,
  ReplanPatchRecord,
  ReplanPatchResult,
  RoleProfile,
  WorkItem,
  EngineFinding,
  RunEvent,
  RunManifestV2,
  ReviewCycleState,
  ConvergenceReport,
  DiscoveredBrainPlan,
  PendingPlanApprovalV1,
  PlanApprovalRequestV1,
  VerifierReview,
} from "../core/types.js";
import {
  assertPlanReady,
  assertSparkReady,
  PlanReadinessError,
  parseExecutionPlan,
  serializePersistedPlan,
  validateDiscoveryCoverage,
} from "../core/execution-spec.js";
import {
  buildPlanApprovalRequest,
  requestSha256,
  serializePlanApprovalRequest,
  writePlanApprovalRequest,
  readVerifiedPlanApprovalRequest,
} from "../core/plan-approval.js";
import {
  resolvedRunConfigurationSchema,
  reconstructHistoricalRunConfiguration,
  RUN_CONFIGURATION_PATH,
  runConfigurationSha256,
  serializeRunConfiguration,
} from "../core/run-configuration.js";
import {
  appendOwnedRunFile,
  readOwnedEvidenceFile,
  readOwnedRunFile,
  writeOwnedRunFile,
  writeOwnedEvidenceFile,
  type OwnedFileIoHooks,
} from "../core/owned-evidence.js";
import { loadPromptTemplate } from "../prompts/loader.js";
import { renderTemplate } from "../prompts/renderer.js";
import { loadFindingRevisionRecords, recordFindingRevision } from "./findings.js";
import { loadVerifiedPlanBundle } from "./verified-plan.js";
import { materializeReplanCandidate } from "./replan-candidate.js";
import { buildPlanDelta, planDecisionContractSha256 } from "./plan-delta.js";
import { loadCurrentCycleEvidence } from "./convergence.js";
import {
  reviewCycleIdentity,
  beginReviewCycle,
  reviewDecisionPath,
  reviewEffectIdentity,
  validatePersistedReviewEffectState,
} from "./review-cycle.js";
import { writeConvergenceReport } from "./convergence.js";
import { evaluateReviewPolicy, qualityRecoveryEligibilitySnapshot } from "./review-policy.js";

function errorCode(error: unknown): unknown {
  return error && typeof error === "object" && "code" in error ? error.code : undefined;
}

async function readOrMigrateHistoricalRunConfiguration(
  runDir: string,
  manifest: RunManifestV2Ledger,
  hooks: OwnedFileIoHooks = {},
  afterWrite?: () => Promise<void>,
) {
  let existing: string | null = null;
  try {
    existing = (await readOwnedRunFile(runDir, RUN_CONFIGURATION_PATH)).toString("utf8");
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
  if (existing !== null) {
    const configuration = resolvedRunConfigurationSchema.parse(JSON.parse(existing));
    if (serializeRunConfiguration(configuration) !== existing) {
      throw new Error("Run configuration bytes are not canonical");
    }
    if (manifest.run_configuration_sha256 !== null
      && manifest.run_configuration_sha256 !== runConfigurationSha256(configuration)) {
      throw new Error("Run configuration digest does not match the immutable manifest");
    }
    if (manifest.run_configuration_sha256 === null) {
      const intake = JSON.parse((await readOwnedRunFile(runDir, manifest.intake_path)).toString("utf8"));
      const reconstructed = reconstructHistoricalRunConfiguration(manifest, intake);
      if (serializeRunConfiguration(reconstructed) !== existing) {
        throw new Error("Existing historical run configuration conflicts with deterministic reconstruction");
      }
    }
    return configuration;
  }
  if (manifest.run_configuration_sha256 !== null || manifest.approval_protocol_version === 1) {
    throw new Error("Pinned run configuration is missing");
  }
  const intake = JSON.parse((await readOwnedRunFile(runDir, manifest.intake_path)).toString("utf8"));
  const reconstructed = reconstructHistoricalRunConfiguration(manifest, intake);
  const bytes = serializeRunConfiguration(reconstructed);
  try {
    await writeOwnedRunFile(runDir, RUN_CONFIGURATION_PATH, bytes, hooks);
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
  }
  const persisted = (await readOwnedRunFile(runDir, RUN_CONFIGURATION_PATH)).toString("utf8");
  if (persisted !== bytes) {
    throw new Error("Historical run configuration create-once bytes conflict with reconstruction");
  }
  await afterWrite?.();
  return reconstructed;
}

async function readExistingHistoricalRunConfiguration(
  runDir: string,
  manifest: RunManifestV2Ledger,
) {
  let existing: string | null = null;
  try {
    existing = (await readOwnedRunFile(runDir, RUN_CONFIGURATION_PATH)).toString("utf8");
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
  if (existing === null) return null;
  const configuration = resolvedRunConfigurationSchema.parse(JSON.parse(existing));
  if (serializeRunConfiguration(configuration) !== existing) {
    throw new Error("Run configuration bytes are not canonical");
  }
  if (manifest.run_configuration_sha256 !== null
    && manifest.run_configuration_sha256 !== runConfigurationSha256(configuration)) {
    throw new Error("Run configuration digest does not match the immutable manifest");
  }
  if (manifest.run_configuration_sha256 === null) {
    const intake = JSON.parse((await readOwnedRunFile(runDir, manifest.intake_path)).toString("utf8"));
    const reconstructed = reconstructHistoricalRunConfiguration(manifest, intake);
    if (serializeRunConfiguration(reconstructed) !== existing) {
      throw new Error("Existing historical run configuration conflicts with deterministic reconstruction");
    }
  }
  return configuration;
}

export class NoMaterialReplanError extends Error {
  readonly diagnostics = ["Proposed replan bytes exactly match the approved base plan."];

  constructor() {
    super("Replan candidate has no material serialized plan change");
    this.name = "NoMaterialReplanError";
  }
}

export class InvalidReplanCandidateError extends Error {
  readonly diagnostics: string[];

  constructor(diagnostics: string[], options: ErrorOptions = {}) {
    super(`Replan candidate is not approval-ready:\n- ${diagnostics.join("\n- ")}`, options);
    this.name = "InvalidReplanCandidateError";
    this.diagnostics = diagnostics;
  }
}

export function replanOutputScopeDiagnostics(input: {
  baseTarget: WorkItem;
  proposedTarget: WorkItem;
  review: VerifierReview;
  findingRecords: readonly ReplanFindingContext[];
  approvedArtifactOutputs?: readonly string[];
  approvedBrowserOutputs?: readonly string[];
}): string[] {
  const unresolved = new Set(input.findingRecords.map((finding) =>
    `${finding.problem}\0${finding.required_fix ?? ""}`));
  const approvedArgv = new Set(input.proposedTarget.verification_commands.map((command) => canonical(command.argv)));
  const artifactScope = new Set([
    ...input.proposedTarget.expected_artifacts,
    ...(input.approvedArtifactOutputs ?? []),
  ]);
  const browserScope = new Set([
    ...input.proposedTarget.browser_checks.map((check) => check.screenshot_artifact),
    ...(input.approvedBrowserOutputs ?? []),
  ]);
  const requiredArtifacts = new Set<string>();
  const diagnostics: string[] = [];
  for (const finding of input.review.findings) {
    if (!unresolved.has(`${finding.problem}\0${finding.required_fix}`) || finding.remediation === undefined) continue;
    const commands = new Map(finding.remediation.verification.commands.map((command) => [command.id, command.argv]));
    for (const evidence of finding.remediation.verification.required_evidence) {
      if (evidence.kind !== "artifact" && evidence.kind !== "browser") continue;
      const argv = commands.get(evidence.source_id);
      if (argv === undefined) {
        diagnostics.push(`Generated ${evidence.kind} output ${evidence.output_path} references unknown command ${evidence.source_id}`);
        continue;
      }
      if (!approvedArgv.has(canonical(argv))) {
        diagnostics.push(`Generated ${evidence.kind} output ${evidence.output_path} is not linked to an exact approved verification command`);
        continue;
      }
      if (evidence.kind === "artifact") {
        requiredArtifacts.add(evidence.output_path);
        if (!artifactScope.has(evidence.output_path)) {
          diagnostics.push(`Generated artifact output ${evidence.output_path} is outside proposed expected_artifacts scope`);
        }
      } else if (!browserScope.has(evidence.output_path)) {
        diagnostics.push(`Generated browser output ${evidence.output_path} is outside proposed browser-check scope`);
      }
    }
  }
  const baseArtifacts = new Set(input.baseTarget.expected_artifacts);
  for (const path of input.proposedTarget.expected_artifacts) {
    if (!baseArtifacts.has(path) && !requiredArtifacts.has(path)) {
      diagnostics.push(`Proposed expected artifact ${path} is not required by exact unresolved remediation evidence`);
    }
  }
  return [...new Set(diagnostics)];
}

export async function rejectPreparedReplanRevision(input: {
  runDir: string;
  revision: number;
  actor: string;
  reason: string;
}): Promise<RunManifestV2Ledger> {
  const actor = input.actor.trim();
  const reason = input.reason.trim();
  if (!actor) throw new Error("Plan rejection actor must be non-empty");
  if (!reason) throw new Error("Plan rejection reason must be non-empty");
  assertNoSecretMaterial("Plan rejection reason", reason);
  let manifest = await readManifestV2(input.runDir);
  const pending = manifest.pending_plan_approval;
  if (!pending || pending.base_revision === null || pending.proposed_revision !== input.revision) {
    throw new Error(`Plan revision ${input.revision} is not the exact pending material replan`);
  }
  const request = await readVerifiedPlanApprovalRequest(input.runDir, manifest);
  const targetWorkItemId = resolvePendingReplanTarget(manifest);
  const sourceWorkItemId = manifest.current_work_item_id;
  if (!targetWorkItemId || !sourceWorkItemId) throw new Error("Pending replan rejection lineage is missing");
  const sourceProgress = manifest.work_item_progress[sourceWorkItemId];
  const priorCyclePath = sourceProgress?.review_cycle_path;
  if (!sourceProgress || typeof priorCyclePath !== "string") {
    throw new Error("Pending replan rejection review-cycle lineage is missing");
  }
  const priorCycle = reviewCycleStateSchema.parse(JSON.parse((await readOwnedEvidenceFile(
    input.runDir,
    priorCyclePath,
    "reviews/",
  )).toString("utf8")));
  if (priorCycle.decision.action !== "create_replan" || priorCycle.work_item_id !== sourceWorkItemId) {
    throw new Error("Pending plan rejection requires the exact create-replan cycle");
  }
  const rejection = {
    schema_version: 1,
    run_id: manifest.run_id,
    rejected_revision: input.revision,
    base_revision: pending.base_revision,
    request_path: pending.request_path,
    request_sha256: pending.request_sha256,
    approval_subject_sha256: request.approval_subject_sha256,
    source_work_item_id: sourceWorkItemId,
    target_work_item_id: targetWorkItemId,
    prior_review_revision: priorCycle.review_revision,
    reason,
    actor,
  };
  const rejectionPath = `approvals/plan/revision-${input.revision}-rejection.json`;
  const rejectionBytes = `${JSON.stringify(rejection, null, 2)}\n`;
  try {
    await writeOwnedEvidenceFile(input.runDir, rejectionPath, "approvals/", rejectionBytes);
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
    const existing = (await readOwnedEvidenceFile(input.runDir, rejectionPath, "approvals/")).toString("utf8");
    if (existing !== rejectionBytes) throw new Error("Plan rejection artifact conflicts with the exact pending revision");
  }

  const rejectionSha256 = createHash("sha256").update(rejectionBytes).digest("hex");
  manifest = await rejectPreparedPlanApprovalBoundary({
    runDir: input.runDir,
    revision: input.revision,
    rejectionPath,
    rejectionSha256,
    blocker: `Plan revision ${input.revision} rejected: ${reason}`,
  });
  const resetProgress = { ...manifest.work_item_progress[sourceWorkItemId]! };
  delete resetProgress.review_revision;
  delete resetProgress.review_cycle_path;
  delete resetProgress.review_effect_id;
  delete resetProgress.replan_patch_path;
  delete resetProgress.replan_target_work_item_id;
  resetProgress.queue_state = "blocked";
  manifest = await updateManifestV2(input.runDir, {
    work_item_progress: { ...manifest.work_item_progress, [sourceWorkItemId]: resetProgress },
  });
  const policy = manifest.review_policy_snapshot;
  const accounting = manifest.review_accounting;
  if (!policy || !accounting) throw new Error("Plan rejection requires snapshotted review policy accounting");
  const reviewRevision = accounting.review_revision + 1;
  const priorFindings = await loadFindingRevisionRecords(
    input.runDir,
    sourceWorkItemId,
    priorCycle.review_revision,
    priorCycle.finding_ids,
  );
  const findings: EngineFinding[] = [];
  for (const finding of priorFindings) {
    findings.push(await recordFindingRevision(input.runDir, {
      work_item_id: finding.work_item_id,
      source: finding.source,
      severity: finding.severity,
      disposition: "requires_replan",
      criterion_ref: finding.criterion_ref,
      normalized_location: finding.normalized_location,
      problem_class: finding.problem_class,
      problem: finding.problem,
      required_fix: finding.required_fix,
      evidence_refs: finding.evidence_refs,
      review_revision: reviewRevision,
    }));
  }
  const reference = priorCycle.work_item_progress_reference;
  if (!reference) throw new Error("Plan rejection source cycle lacks immutable work-item evidence");
  const cycle = await beginReviewCycle({
    run_dir: input.runDir,
    work_item_id: sourceWorkItemId,
    phase: priorCycle.phase,
    review_revision: reviewRevision,
    policy_hash: createHash("sha256").update(JSON.stringify(policy)).digest("hex"),
    finding_ids: findings.map((finding) => finding.finding_id).sort(),
    accounting_before: accounting,
    work_item_progress_reference: reference,
    evaluate: () => evaluateReviewPolicy({
      policy,
      findings,
      accounting,
      phase: priorCycle.phase,
      operational_blocker: null,
      replan_patch_pending: false,
      authorization: null,
      quality_recovery: qualityRecoveryEligibilitySnapshot(manifest, sourceWorkItemId),
    }),
  });
  if (cycle.decision.action !== "create_replan") {
    throw new Error("Rejected plan revision did not create a fresh replan decision");
  }
  manifest = await readManifestV2(input.runDir);
  await writeConvergenceReport({
    run_dir: input.runDir,
    cycle,
    policy,
    accounting: manifest.review_accounting!,
    finding_index: manifest.finding_index ?? {},
    findings,
    release_guards: manifest.release_guards ?? [],
    authorization: null,
  });
  manifest = await updateManifestV2(input.runDir, {
    delivery_state: "blocked",
    last_blocker: `Plan revision ${input.revision} rejected: ${reason}`,
  });
  await appendRunEventOnce(input.runDir, {
    eventId: `plan-rejection:${rejectionSha256}`,
    actor,
    stage: "replanning",
    type: "plan_revision_rejected",
    payload: { rejected_revision: input.revision, rejection_path: rejectionPath, next_review_revision: reviewRevision },
  });
  return manifest;
}

export interface CreateReplanPatchInput {
  run_dir: string;
  repo_root: string;
  codex: CodexAdapter;
  target_work_item: WorkItem;
  base_plan_revision: number;
  unresolved_finding_ids: string[];
  convergence_report_path: string;
  release_guards: ReleaseGuard[];
  evidence_paths: string[];
  model_profile: RoleProfile;
  /** Final/post-PR phases may project one integrated cycle onto one approved target. */
  source_work_item_id?: string;
  /** Runtime recovery reuses a patch or retries only when no invocation prompt was persisted. */
  existing_only?: boolean;
  budget?: ResourceBudgetPort;
}

const maxPromptBytes = 96_000;
const runOwnedEvidenceRoots = new Set([
  "assurance",
  "authorizations",
  "contexts",
  "failures",
  "findings",
  "implementation",
  "plans",
  "reflection",
  "replans",
  "reviews",
  "verification",
]);
const runOwnedEvidenceFiles = new Set(["original-request.md"]);

function canonical(value: unknown): string {
  return JSON.stringify(value);
}

function assertEqual(label: string, actual: unknown, expected: unknown): void {
  if (canonical(actual) !== canonical(expected)) {
    throw new Error(`Replan ${label} does not match durable provenance`);
  }
}

function encoded(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

async function assertReplanEvidenceAvailable(
  runDir: string,
  repoRoot: string,
  path: string,
  verifiedMissingRepositoryPaths: ReadonlySet<string> = new Set(),
  verifiedMissingLocalVerificationPaths: ReadonlySet<string> = new Set(),
): Promise<void> {
  if (runOwnedEvidenceFiles.has(path)) {
    await readOwnedRunFile(runDir, path);
    return;
  }
  const root = path.split("/", 1)[0]!;
  if (runOwnedEvidenceRoots.has(root)) {
    if (verifiedMissingLocalVerificationPaths.has(path)) return;
    await readOwnedEvidenceFile(runDir, path, `${root}/`);
    return;
  }
  const repositoryPath = path.replace(/:[1-9]\d*(?:(?::|-)[1-9]\d*)?$/, "");
  const target = await realpath(join(repoRoot, repositoryPath)).catch((error: unknown) => {
    if (errorCode(error) === "ENOENT" && verifiedMissingRepositoryPaths.has(repositoryPath)) return null;
    if (errorCode(error) === "ENOENT") throw new Error(`Repository evidence artifact is missing: ${path}`);
    throw error;
  });
  if (target === null) return;
  const relation = relative(repoRoot, target);
  if (relation === "" || relation.startsWith("..") || isAbsolute(relation)) {
    throw new Error(`Repository evidence artifact escaped the authorized checkout: ${path}`);
  }
  if (!(await stat(target)).isFile()) {
    throw new Error(`Repository evidence artifact is not a regular file: ${path}`);
  }
}

async function verifiedMissingLocalVerificationEvidence(
  runDir: string,
  evidencePaths: readonly string[],
): Promise<Set<string>> {
  const canonicalEvidence = await Promise.all(evidencePaths
    .filter((path) => path.startsWith("verification/local/") && path.endsWith("/evidence.json"))
    .map((path) => readOptionalValidatedArtifact(runDir, path, verificationEvidenceSchema)));
  if (!canonicalEvidence.some((evidence) => evidence !== null)) return new Set();
  const missing = new Set<string>();
  for (const path of evidencePaths.filter((candidate) => candidate.startsWith("verification/local/"))) {
    try {
      await readOwnedEvidenceFile(runDir, path, "verification/");
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
      missing.add(path);
    }
  }
  return missing;
}

async function verifiedMissingRepositoryEvidence(
  runDir: string,
  evidencePaths: readonly string[],
): Promise<Set<string>> {
  const missing = new Set<string>();
  for (const path of evidencePaths) {
    if (!path.startsWith("verification/") || !path.endsWith("/evidence.json")) continue;
    const evidence = await readOptionalValidatedArtifact(runDir, path, verificationEvidenceSchema);
    if (evidence === null) continue;
    for (const artifact of evidence.artifact_checks) {
      if (!artifact.exists && !artifact.path.startsWith("verification/")) missing.add(artifact.path);
    }
  }
  return missing;
}

async function mutableGeneratedPlanArtifacts(
  runDir: string,
  manifest: RunManifestV2,
): Promise<Set<string>> {
  const revision = manifest.approved_plan_revision ?? manifest.approved_revision;
  if (revision === null) return new Set();
  const { plan } = await loadVerifiedPlanBundle(runDir, manifest, revision);
  const writablePaths = new Set(plan.work_items.flatMap((item) => item.file_contract)
    .filter((entry) => entry.permission !== "read_only")
    .map((entry) => entry.path));
  return new Set(plan.work_items.flatMap((item) => item.expected_artifacts)
    .filter((path) => writablePaths.has(path)));
}

export function replanPatchPath(
  workItemId: string,
  basePlanRevision: number,
  reviewRevision: number,
): string {
  if (!workItemId.trim()) throw new Error("Replan target work item must be non-empty");
  if (!Number.isInteger(basePlanRevision) || basePlanRevision < 1) {
    throw new Error("Replan base plan revision must be positive");
  }
  if (!Number.isInteger(reviewRevision) || reviewRevision < 1) {
    throw new Error("Replan review revision must be positive");
  }
  return `replans/work-item-${encoded(workItemId)}-base-${basePlanRevision}-review-${reviewRevision}.json`;
}

async function verifyCanonicalReplanProvenance(input: {
  runDir: string;
  manifest: RunManifestV2;
  sourceWorkItemId: string;
  record: ReplanPatchRecord;
  convergence: ConvergenceReport;
  cycle: ReviewCycleState;
}): Promise<void> {
  const { runDir, manifest, sourceWorkItemId, record, convergence, cycle } = input;
  const findings = await loadFindingRevisionRecords(
    runDir,
    sourceWorkItemId,
    convergence.review_revision,
    cycle.finding_ids,
  );
  if (findings.some((finding) => finding.work_item_id !== sourceWorkItemId)) {
    throw new Error("Replan canonical finding history belongs to a different source");
  }
  assertEqual("canonical review finding set", cycle.finding_ids, findings.map((finding) => finding.finding_id).sort());
  const blockingDispositions = new Set(["blocking", "fix_in_scope", "requires_replan"]);
  assertEqual(
    "canonical unresolved finding set",
    convergence.unresolved_finding_ids,
    findings.filter((finding) => blockingDispositions.has(finding.disposition))
      .map((finding) => finding.finding_id).sort(),
  );
  assertEqual(
    "canonical advisory finding set",
    convergence.advisory_finding_ids,
    findings.filter((finding) => finding.disposition === "advisory")
      .map((finding) => finding.finding_id).sort(),
  );
  assertEqual(
    "canonical follow-up finding set",
    convergence.follow_up_finding_ids,
    findings.filter((finding) => finding.disposition === "follow_up")
      .map((finding) => finding.finding_id).sort(),
  );
  const unresolved = new Set(convergence.unresolved_finding_ids);
  assertEqual(
    "canonical finding snapshots",
    record.provenance.finding_records,
    findingContext(findings.filter((finding) => unresolved.has(finding.finding_id))),
  );

  const cycleEvidence = await loadCurrentCycleEvidence(runDir, cycle);
  if (cycleEvidence.some((path) => !convergence.evidence_refs.includes(path))) {
    throw new Error("Replan convergence omits canonical reviewed evidence");
  }
  assertEqual("canonical evidence paths", record.provenance.evidence_paths, convergence.evidence_refs);
  const repositoryRoot = await realpath(manifest.worktree_path ?? manifest.repo_root);
  const verifiedMissing = await verifiedMissingRepositoryEvidence(runDir, convergence.evidence_refs);
  for (const path of await mutableGeneratedPlanArtifacts(runDir, manifest)) verifiedMissing.add(path);
  const verifiedMissingLocal = await verifiedMissingLocalVerificationEvidence(runDir, convergence.evidence_refs);
  for (const path of convergence.evidence_refs) {
    await assertReplanEvidenceAvailable(runDir, repositoryRoot, path, verifiedMissing, verifiedMissingLocal);
  }
}

export async function validateActiveReplanPatch(
  runDir: string,
  manifest: RunManifestV2,
  sourceWorkItemId: string,
  patchPath: string,
  cycle: ReviewCycleState,
  completion: ReviewCycleState | null,
): Promise<ReplanPatchRecord> {
  const record = replanPatchRecordSchema.parse(JSON.parse((await readOwnedEvidenceFile(
    runDir, patchPath, "replans/",
  )).toString("utf8")));
  const summary = manifest.convergence_reports?.[sourceWorkItemId];
  if (!summary || summary.recommended_action !== "create_replan") {
    throw new Error("Active replan patch requires its authoritative convergence summary");
  }
  const expectedPath = replanPatchPath(
    record.patch.target_work_item_id,
    summary.plan_revision,
    summary.review_revision,
  );
  if (
    patchPath !== expectedPath
    || record.patch.base_plan_revision !== summary.plan_revision
    || record.provenance.base_plan_revision !== summary.plan_revision
    || record.provenance.convergence_report_path !== summary.path
    || record.provenance.convergence_review_revision !== summary.review_revision
    || canonical(record.patch.unresolved_finding_ids) !== canonical(record.provenance.unresolved_finding_ids)
  ) throw new Error("Active replan patch path or base provenance is invalid");
  const convergence = convergenceReportSchema.parse(JSON.parse((await readOwnedEvidenceFile(
    runDir, summary.path, "reviews/convergence/",
  )).toString("utf8")));
  if (
    convergence.work_item_id !== sourceWorkItemId
    || convergence.plan_revision !== summary.plan_revision
    || convergence.review_revision !== summary.review_revision
    || convergence.recommended_action !== "create_replan"
    || canonical(convergence.unresolved_finding_ids) !== canonical(record.patch.unresolved_finding_ids)
    || canonical(convergence.evidence_refs) !== canonical(record.provenance.evidence_paths)
  ) throw new Error("Active replan convergence or unresolved-finding provenance is invalid");
  const findingRecordIds = new Set(record.provenance.finding_records.map((finding) => finding.finding_id));
  if (findingRecordIds.size !== record.patch.unresolved_finding_ids.length
    || record.patch.unresolved_finding_ids.some((findingId) => !findingRecordIds.has(findingId))) {
    throw new Error("Active replan finding-record IDs must exactly equal unresolved findings");
  }
  const effectResult = completion?.effect_result as {
    replan_patch_path?: unknown;
    target_work_item_id?: unknown;
  } | undefined;
  if (
    cycle.decision.action !== "create_replan"
    || cycle.review_revision !== summary.review_revision
    || completion?.effect_state !== "complete"
    || effectResult?.replan_patch_path !== patchPath
    || (effectResult.target_work_item_id === undefined
      ? record.patch.target_work_item_id !== sourceWorkItemId
      : effectResult.target_work_item_id !== record.patch.target_work_item_id)
  ) throw new Error("Active replan patch does not match its completed create_replan effect");
  await verifyCanonicalReplanProvenance({
    runDir,
    manifest,
    sourceWorkItemId,
    record,
    convergence,
    cycle,
  });
  return record;
}

async function approvedPlan(input: CreateReplanPatchInput) {
  const manifest = await readManifestV2(input.run_dir);
  const expectedRoot = manifest.worktree_path ?? manifest.repo_root;
  const [canonicalExpectedRoot, canonicalInputRoot] = await Promise.all([
    realpath(expectedRoot),
    realpath(input.repo_root),
  ]).catch((error: unknown) => {
    throw new Error(`Brain replan authorized checkout cannot be canonicalized: ${String(error)}`);
  });
  if (canonicalInputRoot !== canonicalExpectedRoot) {
    throw new Error("Brain replan cwd does not match the canonical manifest-authorized checkout or worktree");
  }
  const durableBrainProfile = manifest.selected_role_profiles.brain ?? manifest.role_profiles.brain;
  if (!durableBrainProfile || canonical(durableBrainProfile) !== canonical(input.model_profile)) {
    throw new Error("Replan model profile does not match the recorded durable Brain profile");
  }
  const approvedRevision = manifest.approved_revision ?? manifest.approved_plan_revision;
  if (approvedRevision !== input.base_plan_revision) {
    throw new Error("Replan base plan revision does not match the approved plan");
  }
  const revision = manifest.plan_revisions[String(input.base_plan_revision)];
  if (!revision) throw new Error("Replan base plan revision is not recorded");
  const verified = await loadVerifiedPlanBundle(input.run_dir, manifest, input.base_plan_revision);
  if (verified.revision !== input.base_plan_revision) throw new Error("Replan base plan revision is not current");
  const plan = verified.plan;
  const target = plan.work_items.find((item) => item.id === input.target_work_item.id);
  if (!target) throw new Error("Replan target work item is not in the approved plan");
  assertEqual("target work item", executionSpecV2Schema.parse(input.target_work_item), target);
  if (manifest.work_item_progress[target.id]?.status === "complete" && input.source_work_item_id !== "integrated") {
    throw new Error("Replan cannot change a completed target work item");
  }
  const criteria = revision.acceptance_criteria?.[target.id];
  if (!criteria?.length) throw new Error("Replan target acceptance-criterion provenance is missing");
  return { manifest, target, criteria, brainRoot: canonicalExpectedRoot };
}

function buildReplanCandidate(
  target: WorkItem,
  patch: ReplanPatch,
  criteria: readonly { ref: string; text: string }[],
  materializationVersion: 1 | 2,
): WorkItem {
  const criterionChanges = new Map(patch.added_or_changed_criteria.map(({ ref, text }) => [ref, text]));
  const criterionTextByIndex = criteria.map((criterion) => criterionChanges.get(criterion.ref) ?? criterion.text);
  const addedPaths = [...new Set(patch.added_change_units.map((unit) => unit.path))];
  const addedReadOnlyPaths = patch.added_read_only_file_contracts.map((contract) => contract.path);
  const authorizedPaths = [...new Set([...addedPaths, ...addedReadOnlyPaths])];
  const fileContract = target.file_contract.map((contract) => {
    const matchingUnits = patch.added_change_units.filter((unit) => unit.path === contract.path);
    const addedTargets = matchingUnits
      .map((unit) => unit.target);
    const promotesReadOnly = materializationVersion === 2
      && contract.permission === "read_only"
      && matchingUnits.length > 0
      && matchingUnits.every((unit) => unit.operation === "modify");
    return addedTargets.length > 0 ? {
      ...contract,
      permission: promotesReadOnly ? "modify" as const : contract.permission,
      targets: promotesReadOnly ? addedTargets : [...contract.targets, ...addedTargets],
    } : contract;
  });
  for (const path of addedPaths) {
    if (fileContract.some((contract) => contract.path === path)) continue;
    const units = patch.added_change_units.filter((unit) => unit.path === path);
    fileContract.push({
      path,
      permission: units[0]!.operation,
      targets: units.map((unit) => unit.target),
    });
  }
  fileContract.push(...patch.added_read_only_file_contracts.map((contract) => ({
    ...contract,
    permission: "read_only" as const,
  })));
  return {
    ...target,
    objective: materializationVersion === 2
      ? [patch.revised_objective ?? target.objective, ...patch.changed_instructions].join("\n")
      : patch.revised_objective ?? target.objective,
    file_contract: fileContract,
    forbidden_changes: target.forbidden_changes.map((forbidden) => forbidden.path === "*"
      ? { ...forbidden, except: [...forbidden.except, ...authorizedPaths.filter((path) => !forbidden.except.includes(path))] }
      : forbidden),
    acceptance: target.acceptance.map((criterion, index) => {
      const addedEvidence = [
        ...patch.added_change_units
          .filter((unit) => unit.satisfies.includes(criterion.id))
          .map((unit) => unit.id),
        ...patch.added_verification_commands
          .filter((command) => command.satisfies.includes(criterion.id))
          .map((command) => command.id),
      ];
      return {
        ...criterion,
        statement: criterionTextByIndex[index] ?? criterion.statement,
        satisfied_by: [...criterion.satisfied_by, ...addedEvidence],
      };
    }),
    change_units: [
      ...(materializationVersion === 2 || patch.changed_instructions.length === 0
        ? target.change_units
        : target.change_units.map((unit, index) => index === 0
          ? { ...unit, requirements: patch.changed_instructions }
          : unit)),
      ...patch.added_change_units.map(({ satisfies: _satisfies, ...unit }) => unit),
    ],
    cross_cutting_impacts: materializationVersion === 2
      ? mergeCrossCuttingImpacts(target.cross_cutting_impacts ?? [], patch.added_cross_cutting_impacts)
      : [
          ...(target.cross_cutting_impacts ?? []),
          ...patch.added_cross_cutting_impacts,
        ],
    verification_commands: [
      ...target.verification_commands,
      ...patch.added_verification_commands.map(({ satisfies: _satisfies, ...command }) => command),
    ],
    expected_artifacts: [
      ...target.expected_artifacts,
      ...patch.added_expected_artifacts.filter((path) => !target.expected_artifacts.includes(path)),
    ],
    completion_contract: {
      ...target.completion_contract,
      expected_changed_files: [
        ...target.completion_contract.expected_changed_files,
        ...addedPaths.filter((path) => !target.completion_contract.expected_changed_files.includes(path)),
      ],
    },
  };
}

function mergeCrossCuttingImpacts(
  existing: WorkItem["cross_cutting_impacts"],
  added: ReplanPatch["added_cross_cutting_impacts"],
): NonNullable<WorkItem["cross_cutting_impacts"]> {
  const replacements = new Map(added.map((impact) => [
    `${impact.change_unit_id}\0${impact.category}`,
    impact,
  ]));
  const merged = (existing ?? []).map((impact) => {
    const key = `${impact.change_unit_id}\0${impact.category}`;
    const replacement = replacements.get(key);
    if (replacement) replacements.delete(key);
    return replacement ?? impact;
  });
  return [...merged, ...replacements.values()];
}

function validatePatch(
  patch: ReplanPatch,
  input: CreateReplanPatchInput,
  criteria: readonly { ref: string; text: string }[],
  materializationVersion: 1 | 2,
): void {
  const criterionRefs = criteria.map((criterion) => criterion.ref);
  if (patch.target_work_item_id !== input.target_work_item.id) {
    throw new Error("Replan patch targets a different target work item");
  }
  if (patch.base_plan_revision !== input.base_plan_revision) {
    throw new Error("Replan patch has a different base plan revision");
  }
  if (canonical(patch.unresolved_finding_ids) !== canonical(input.unresolved_finding_ids)) {
    throw new Error("Replan patch finding set must exactly match the unresolved finding set");
  }
  const allowed = new Set(criterionRefs);
  // JSON Schema cannot express uniqueness by one object property. Keep the
  // structured schema shape-compatible with Zod and enforce ref identity here.
  const seenCriterionRefs = new Set<string>();
  for (const criterion of patch.added_or_changed_criteria) {
    if (!allowed.has(criterion.ref)) {
      throw new Error(`Replan patch contains an unknown criterion ref: ${criterion.ref}`);
    }
    if (seenCriterionRefs.has(criterion.ref)) {
      throw new Error(`Replan patch contains a duplicate criterion ref: ${criterion.ref}`);
    }
    seenCriterionRefs.add(criterion.ref);
  }
  const existingChangeUnitIds = new Set(input.target_work_item.change_units.map((unit) => unit.id));
  const acceptanceIds = new Set(input.target_work_item.acceptance.map((criterion) => criterion.id));
  const contracts = new Map(input.target_work_item.file_contract.map((contract) => [contract.path, contract]));
  const addedPaths = new Map<string, ReplanPatch["added_change_units"][number]["operation"]>();
  const addedTargets = new Set<string>();
  for (const unit of patch.added_change_units) {
    if (existingChangeUnitIds.has(unit.id)) {
      throw new Error(`Replan patch change-unit ID already exists: ${unit.id}`);
    }
    for (const acceptanceId of unit.satisfies) {
      if (!acceptanceIds.has(acceptanceId)) {
        throw new Error(`Replan patch change unit ${unit.id} references unknown acceptance ID: ${acceptanceId}`);
      }
    }
    const contract = contracts.get(unit.path);
    const promotesReadOnly = materializationVersion === 2
      && contract?.permission === "read_only"
      && unit.operation === "modify";
    if (contract && contract.permission !== unit.operation && !promotesReadOnly) {
      throw new Error(`Replan patch change unit ${unit.id} conflicts with ${unit.path} permission`);
    }
    const existingOperation = addedPaths.get(unit.path);
    if (existingOperation && existingOperation !== unit.operation) {
      throw new Error(`Replan patch change units disagree on ${unit.path} operation`);
    }
    addedPaths.set(unit.path, unit.operation);
    const targetKey = `${unit.path}\0${unit.target}`;
    if (contract?.targets.includes(unit.target) || addedTargets.has(targetKey)) {
      throw new Error(`Replan patch duplicates target ${unit.target} for ${unit.path}`);
    }
    addedTargets.add(targetKey);
  }
  const verificationIds = new Set(input.target_work_item.verification_commands.map((command) => command.id));
  const verificationArgv = new Set(input.target_work_item.verification_commands.map((command) => canonical(command.argv)));
  for (const command of patch.added_verification_commands) {
    if (verificationIds.has(command.id)) {
      throw new Error(`Replan patch verification-command ID already exists: ${command.id}`);
    }
    verificationIds.add(command.id);
    const argv = canonical(command.argv);
    if (verificationArgv.has(argv)) {
      throw new Error(`Replan patch duplicates verification command argv: ${command.argv.join(" ")}`);
    }
    verificationArgv.add(argv);
    for (const acceptanceId of command.satisfies) {
      if (!acceptanceIds.has(acceptanceId)) {
        throw new Error(`Replan patch verification command ${command.id} references unknown acceptance ID: ${acceptanceId}`);
      }
    }
  }
  const outputText = [
    patch.target_work_item_id,
    ...patch.unresolved_finding_ids,
    ...(patch.revised_objective === null ? [] : [patch.revised_objective]),
    ...patch.added_or_changed_criteria.flatMap((criterion) => [criterion.ref, criterion.text]),
    ...patch.changed_instructions,
    ...patch.added_change_units.flatMap((unit) => [
      unit.id,
      unit.path,
      unit.target,
      ...unit.requirements,
      ...unit.satisfies,
    ]),
    ...patch.added_verification_commands.flatMap((command) => [command.id, ...command.argv, ...command.satisfies]),
    ...patch.added_cross_cutting_impacts.flatMap((impact) => [
      impact.change_unit_id,
      impact.category,
      ...impact.callers,
      ...impact.representative_fixtures,
      ...impact.verification_command_ids,
    ]),
    ...patch.added_read_only_file_contracts.flatMap((contract) => [contract.path, ...contract.targets]),
    ...patch.added_expected_artifacts,
    ...patch.explicitly_rejected_hardening,
  ];
  for (const value of outputText) assertNoSecretMaterial("Brain replan output", value);
  assertSparkReady(buildReplanCandidate(input.target_work_item, patch, criteria, materializationVersion));
}

function findingContext(findings: Awaited<ReturnType<typeof loadFindingRevisionRecords>>): ReplanFindingContext[] {
  return findings.map((finding) => ({
    finding_id: finding.finding_id,
    problem_class: finding.problem_class,
    criterion_ref: finding.criterion_ref,
    normalized_location: finding.normalized_location,
    severity: finding.severity,
    disposition: finding.disposition,
    problem: finding.problem,
    required_fix: finding.required_fix,
    evidence_refs: finding.evidence_refs,
  }));
}

function canonicalizeGeneratedPatch(
  patch: ReplanPatch,
  target: WorkItem,
  criteria: readonly { ref: string; text: string }[],
): ReplanPatch {
  const localAcceptanceIdByRef = new Map(criteria.flatMap((criterion, index) => {
    const localId = target.acceptance[index]?.id;
    return localId === undefined ? [] : [[criterion.ref, localId] as const];
  }));
  const localizeSatisfies = (refs: readonly string[]) => [...new Set(
    refs.map((ref) => localAcceptanceIdByRef.get(ref) ?? ref),
  )];
  const existingCommandArgv = new Set(target.verification_commands.map((command) => canonical(command.argv)));
  const redundantControllerEnvCommandIds = new Set(patch.added_verification_commands.flatMap((command) => {
    const controllerReportAssignment = command.argv[0] === "env"
      && command.argv[1]?.startsWith("BRAIN_HANDS_BROWSER_EVIDENCE_REPORT=");
    return controllerReportAssignment && existingCommandArgv.has(canonical(command.argv.slice(2)))
      ? [command.id]
      : [];
  }));
  const addedVerificationCommands = patch.added_verification_commands.filter(
    (command) => !redundantControllerEnvCommandIds.has(command.id),
  );
  const crossCuttingCommandIds = new Set(
    patch.added_cross_cutting_impacts.flatMap((impact) => impact.verification_command_ids)
      .filter((commandId) => !redundantControllerEnvCommandIds.has(commandId)),
  );
  return {
    ...patch,
    added_change_units: patch.added_change_units.map((unit) => ({
      ...unit,
      satisfies: localizeSatisfies(unit.satisfies),
    })),
    added_verification_commands: addedVerificationCommands.map((command) =>
      ({
        ...command,
        ...(crossCuttingCommandIds.has(command.id) && command.tier !== "cross_cutting"
          ? { tier: "cross_cutting" as const }
          : {}),
        satisfies: localizeSatisfies(command.satisfies),
      })),
    added_cross_cutting_impacts: patch.added_cross_cutting_impacts.map((impact) => ({
      ...impact,
      verification_command_ids: impact.verification_command_ids.filter(
        (commandId) => !redundantControllerEnvCommandIds.has(commandId),
      ),
    })),
  };
}

export async function createReplanPatch(
  rawInput: CreateReplanPatchInput,
): Promise<ReplanPatchResult> {
  const input: CreateReplanPatchInput = {
    ...rawInput,
    target_work_item: executionSpecV2Schema.parse(rawInput.target_work_item),
    base_plan_revision: rawInput.base_plan_revision,
    unresolved_finding_ids: rawInput.unresolved_finding_ids.map((id) => id.trim()),
    convergence_report_path: safeEvidenceRefSchema.parse(rawInput.convergence_report_path),
    release_guards: rawInput.release_guards.map((guard) => releaseGuardSchema.parse(guard)),
    evidence_paths: rawInput.evidence_paths.map((path) => safeEvidenceRefSchema.parse(path)),
    model_profile: roleProfileSchema.parse(rawInput.model_profile),
  };
  if (input.model_profile.sandbox !== "read-only") {
    throw new Error("Brain replan model profile must be read-only");
  }
  if (new Set(input.unresolved_finding_ids).size !== input.unresolved_finding_ids.length) {
    throw new Error("Replan unresolved finding set must be unique");
  }

  const { manifest, target, criteria, brainRoot } = await approvedPlan(input);
  const sourceWorkItemId = input.source_work_item_id?.trim() || target.id;
  const summary = manifest.convergence_reports?.[sourceWorkItemId];
  if (!summary || summary.path !== input.convergence_report_path) {
    throw new Error("Replan convergence report is not the authoritative target report");
  }
  const convergence = await readOptionalValidatedArtifact(
    input.run_dir,
    input.convergence_report_path,
    convergenceReportSchema,
  );
  if (!convergence) throw new Error("Replan convergence report is missing");
  if (convergence.work_item_id !== sourceWorkItemId) {
    throw new Error("Replan convergence target work item does not match");
  }
  if (convergence.plan_revision !== input.base_plan_revision) {
    throw new Error("Replan convergence base plan revision does not match");
  }
  if (convergence.recommended_action !== "create_replan") {
    throw new Error("Replan convergence report does not authorize create_replan");
  }
  if (
    convergence.plan_revision !== summary.plan_revision
    || convergence.review_revision !== summary.review_revision
    || convergence.recommended_action !== summary.recommended_action
  ) {
    throw new Error("Replan convergence provenance does not match its manifest summary");
  }
  assertEqual("finding set", input.unresolved_finding_ids, convergence.unresolved_finding_ids);
  assertEqual("evidence paths", input.evidence_paths, convergence.evidence_refs);
  assertEqual("release guards", input.release_guards, manifest.release_guards ?? []);
  const verifiedMissing = await verifiedMissingRepositoryEvidence(input.run_dir, input.evidence_paths);
  for (const path of await mutableGeneratedPlanArtifacts(input.run_dir, manifest)) verifiedMissing.add(path);
  const verifiedMissingLocal = await verifiedMissingLocalVerificationEvidence(input.run_dir, input.evidence_paths);
  for (const path of input.evidence_paths) {
    await assertReplanEvidenceAvailable(input.run_dir, brainRoot, path, verifiedMissing, verifiedMissingLocal);
  }

  const criterionRefs = criteria.map((criterion) => criterion.ref);
  const progress = manifest.work_item_progress[sourceWorkItemId];
  if (
    !progress
    || typeof progress.review_cycle_path !== "string"
    || typeof progress.review_effect_id !== "string"
    || progress.review_revision !== convergence.review_revision
  ) throw new Error("Replan target is missing exact review-cycle provenance");
  const cycle = await readOptionalValidatedArtifact(
    input.run_dir,
    progress.review_cycle_path,
    reviewCycleStateSchema,
  );
  if (
    !cycle
    || cycle.decision_path !== progress.review_cycle_path
    || cycle.effect_id !== progress.review_effect_id
    || cycle.work_item_id !== sourceWorkItemId
    || cycle.review_revision !== convergence.review_revision
    || cycle.decision.action !== "create_replan"
    || canonical(cycle.decision.finding_ids) !== canonical(convergence.unresolved_finding_ids)
  ) throw new Error("Replan review-cycle provenance does not match the convergence report");
  const completedTargetException = manifest.work_item_progress[target.id]?.status === "complete";
  if (
    (sourceWorkItemId !== target.id || completedTargetException)
    && (sourceWorkItemId !== "integrated" || (cycle.phase !== "final_integrated" && cycle.phase !== "post_pr"))
  ) throw new Error("Projected completed-target replan requires integrated final/post engine provenance");
  const cycleFindingIdSet = new Set(cycle.finding_ids);
  if (convergence.unresolved_finding_ids.some((findingId) => !cycleFindingIdSet.has(findingId))) {
    throw new Error("Replan convergence unresolved findings are not an exact subset of the review cycle");
  }
  const fullRevisionFindings = await loadFindingRevisionRecords(
    input.run_dir,
    sourceWorkItemId,
    convergence.review_revision,
    cycle.finding_ids,
  );
  if (fullRevisionFindings.some((finding) => finding.work_item_id !== sourceWorkItemId)) {
    throw new Error("Replan finding work item provenance does not match the target");
  }
  const findingsById = new Map(fullRevisionFindings.map((finding) => [finding.finding_id, finding]));
  for (const findingId of convergence.advisory_finding_ids) {
    if (findingsById.get(findingId)?.disposition !== "advisory") {
      throw new Error(`Replan advisory finding is absent or has mismatched provenance: ${findingId}`);
    }
  }
  for (const findingId of convergence.follow_up_finding_ids) {
    if (findingsById.get(findingId)?.disposition !== "follow_up") {
      throw new Error(`Replan follow-up finding is absent or has mismatched provenance: ${findingId}`);
    }
  }
  const findings = convergence.unresolved_finding_ids.map((findingId) => {
    const finding = findingsById.get(findingId);
    if (!finding) throw new Error(`Replan unresolved finding is absent from the exact review cycle: ${findingId}`);
    if (finding.disposition === "advisory" || finding.disposition === "follow_up") {
      throw new Error(`Replan unresolved finding has non-blocking disposition: ${findingId}`);
    }
    return finding;
  });
  const criterionSet = new Set(criteria.map((criterion) => criterion.ref));
  if (sourceWorkItemId === target.id
    && findings.some((finding) => finding.source !== "release_guard" && !criterionSet.has(finding.criterion_ref))) {
    throw new Error("Replan projected findings do not resolve to the approved target work item");
  }
  const unresolvedFindingSet = new Set(input.unresolved_finding_ids);
  const findingRecords = replanFindingContextSchema.array().min(1).max(50).parse(
    findingContext(findings.filter((finding) => unresolvedFindingSet.has(finding.finding_id))),
  );
  const relativePath = replanPatchPath(target.id, input.base_plan_revision, convergence.review_revision);
  const provenance = {
    base_plan_revision: input.base_plan_revision,
    convergence_report_path: input.convergence_report_path,
    convergence_review_revision: convergence.review_revision,
    unresolved_finding_ids: input.unresolved_finding_ids,
    criterion_refs: criterionRefs,
    finding_records: findingRecords,
    release_guards: input.release_guards,
    evidence_paths: input.evidence_paths,
    model_profile: input.model_profile,
  };
  const existing = await readOptionalValidatedArtifact(input.run_dir, relativePath, replanPatchRecordSchema);
  if (existing) {
    if (canonical(existing.provenance) !== canonical(provenance)) {
      throw new Error(`Replan patch already exists with different content or provenance: ${relativePath}`);
    }
    validatePatch(existing.patch, input, criteria, existing.materialization_version ?? 1);
    return { patch: existing.patch, path: join(input.run_dir, relativePath), model_profile: input.model_profile };
  }
  const artifactName = relativePath.slice(0, -".json".length).replaceAll("/", "-");
  const persistGeneratedPatch = async (rawPatch: unknown): Promise<ReplanPatchResult> => {
    const patch = canonicalizeGeneratedPatch(generatedReplanPatchSchema.parse(rawPatch), target, criteria);
    validatePatch(patch, input, criteria, 2);
    const record: ReplanPatchRecord = replanPatchRecordSchema.parse({ materialization_version: 2, patch, provenance });
    const raced = await readOptionalValidatedArtifact(input.run_dir, relativePath, replanPatchRecordSchema);
    if (raced) {
      if (canonical(raced) !== canonical(record)) {
        throw new Error(`Replan patch already exists with different content: ${relativePath}`);
      }
    } else {
      await writeCreateOnceValidated(input.run_dir, relativePath, record, replanPatchRecordSchema);
    }
    return { patch, path: join(input.run_dir, relativePath), model_profile: input.model_profile };
  };
  if (input.existing_only) {
    let promptExists = false;
    try {
      await readOwnedEvidenceFile(input.run_dir, `prompts/${artifactName}.md`, "prompts/");
      promptExists = true;
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
    if (promptExists) {
      try {
        const response = JSON.parse((await readOwnedEvidenceFile(
          input.run_dir,
          `responses/${artifactName}.json`,
          "responses/",
        )).toString("utf8"));
        return await persistGeneratedPatch(response);
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
        throw new Error(`Ambiguous create_replan effect has no persisted immutable patch: ${relativePath}`);
      }
    }
  }

  const promptTarget = { ...target, acceptance_criteria: criteria };
  const unresolvedSet = new Set(convergence.unresolved_finding_ids);
  const promptConvergence = {
    work_item_id: convergence.work_item_id,
    policy_revision: convergence.policy_revision,
    max_fix_cycles: convergence.max_fix_cycles,
    plan_revision: convergence.plan_revision,
    review_revision: convergence.review_revision,
    fix_cycles_used: convergence.fix_cycles_used,
    self_review_mutations_used: convergence.self_review_mutations_used,
    unresolved_finding_ids: convergence.unresolved_finding_ids,
    repeated_unresolved_finding_ids: convergence.repeated_finding_ids.filter((id) => unresolvedSet.has(id)),
    evidence_refs: convergence.evidence_refs,
    remaining_release_guards: convergence.remaining_release_guards,
    decision_reason_code: convergence.decision_reason_code,
    recommended_action: convergence.recommended_action,
  };
  const template = await loadPromptTemplate("brain-replan-patch-v2");
  const promptSources = {
    template,
    target_work_item: JSON.stringify(promptTarget, null, 2),
    unresolved_finding_ids: JSON.stringify(input.unresolved_finding_ids),
    finding_records: JSON.stringify(findingRecords, null, 2),
    convergence_report_path: input.convergence_report_path,
    convergence_report: JSON.stringify(promptConvergence, null, 2),
    release_guards: JSON.stringify(input.release_guards, null, 2),
    evidence_paths: JSON.stringify(input.evidence_paths),
  };
  for (const [label, value] of Object.entries(promptSources)) assertNoSecretMaterial(`Brain replan ${label}`, value);
  const prompt = renderTemplate(template, {
    target_work_item: promptSources.target_work_item,
    base_plan_revision: String(input.base_plan_revision),
    unresolved_finding_ids: promptSources.unresolved_finding_ids,
    finding_records: promptSources.finding_records,
    convergence_report_path: promptSources.convergence_report_path,
    convergence_report: promptSources.convergence_report,
    release_guards: promptSources.release_guards,
    evidence_paths: promptSources.evidence_paths,
  });
  if (Buffer.byteLength(prompt, "utf8") >= maxPromptBytes) {
    throw new Error(`Brain replan prompt exceeds ${maxPromptBytes} bytes`);
  }
  assertNoSecretMaterial("Brain replan prompt", prompt);

  const schemaText = `${JSON.stringify(replanPatchOutputSchema, null, 2)}\n`;
  await writeTextArtifact(input.run_dir, `prompts/${artifactName}.md`, prompt);
  await writeTextArtifact(input.run_dir, `schemas/${artifactName}.json`, schemaText);
  const result = await input.codex.invoke({
    role: "brain",
    model: input.model_profile.model,
    reasoningEffort: input.model_profile.reasoning_effort,
    sandbox: "read-only",
    cwd: brainRoot,
    enableWebSearch: false,
    prompt,
    runDir: input.run_dir,
    artifactName,
    budget: input.budget,
    attemptKey: `brain:replan:${input.base_plan_revision}:${target.id}:1`,
    outputSchema: replanPatchOutputSchema,
    outputParser: generatedReplanPatchSchema,
  });
  if (result.parsed === undefined) throw new Error("Brain replan did not return a parsed ReplanPatch object");
  return persistGeneratedPatch(result.parsed);
}

/** Resolve the concrete target of the one replan currently awaiting approval. */
export function resolvePendingReplanTarget(manifest: RunManifestV2): string | null {
  const pending = manifest.pending_plan_approval;
  if (pending !== null && pending.base_revision !== null) {
    const revision = manifest.plan_revisions[String(pending.proposed_revision)];
    if (manifest.stage !== "awaiting_plan_approval"
      || manifest.current_revision !== pending.base_revision
      || manifest.current_plan_revision !== pending.base_revision
      || manifest.approved_revision !== pending.base_revision
      || manifest.approved_plan_revision !== pending.base_revision
      || pending.proposed_revision <= pending.base_revision
      || revision?.revision !== pending.proposed_revision
      || revision?.origin !== "replan"
      || revision.base_revision !== pending.base_revision) {
      throw new Error("Pending replan revision or base coordinates are invalid");
    }
    const sourceWorkItemId = manifest.current_work_item_id;
    if (sourceWorkItemId === null) throw new Error("Pending replan source lineage is missing");
    const source = manifest.work_item_progress[sourceWorkItemId];
    if (!source || typeof source.replan_patch_path !== "string") {
      throw new Error("Pending replan source patch pointer lineage is missing");
    }
    if (typeof source.replan_target_work_item_id !== "string") {
      throw new Error("Pending replan target projection lineage is missing");
    }
    const targetWorkItemId = source.replan_target_work_item_id;
    const convergence = manifest.convergence_reports?.[sourceWorkItemId];
    if (!convergence
      || convergence.recommended_action !== "create_replan"
      || convergence.plan_revision !== pending.base_revision) {
      throw new Error("Pending replan convergence lineage is missing or invalid");
    }
    const expectedPatchPath = replanPatchPath(
      targetWorkItemId,
      pending.base_revision,
      convergence.review_revision,
    );
    if (source.replan_patch_path !== expectedPatchPath) {
      throw new Error("Pending replan source patch pointer lineage is not canonical");
    }
    const target = manifest.work_item_progress[targetWorkItemId];
    if (!target) throw new Error("Pending replan concrete target progress lineage is missing");
    if (targetWorkItemId !== sourceWorkItemId && (
      target.replan_source_work_item_id !== sourceWorkItemId
      || target.replan_patch_path !== expectedPatchPath
    )) throw new Error("Pending replan source and concrete target lineage do not match");
    return targetWorkItemId;
  }
  if (pending !== null) return null;
  if (manifest.stage !== "awaiting_plan_approval" || manifest.current_work_item_id === null) return null;
  const sourceWorkItemId = manifest.current_work_item_id;
  const source = manifest.work_item_progress[sourceWorkItemId];
  const convergence = manifest.convergence_reports?.[sourceWorkItemId];
  const projectedTargets = Object.entries(manifest.work_item_progress)
    .filter(([, progress]) => progress.replan_source_work_item_id === sourceWorkItemId);
  const hasReplanLineage = convergence?.recommended_action === "create_replan"
    || projectedTargets.length > 0
    || source?.replan_target_work_item_id !== undefined;
  if (!source || typeof source.replan_patch_path !== "string") {
    if (hasReplanLineage) throw new Error("Pending replan source patch pointer is missing");
    return null;
  }
  const targetWorkItemId = typeof source.replan_target_work_item_id === "string"
    ? source.replan_target_work_item_id
    : sourceWorkItemId;
  const target = manifest.work_item_progress[targetWorkItemId];
  if (!target) throw new Error("Pending replan concrete target progress is missing");
  if (targetWorkItemId !== sourceWorkItemId && (
    target.replan_source_work_item_id !== sourceWorkItemId
    || target.replan_patch_path !== source.replan_patch_path
  )) throw new Error("Pending replan source and concrete target lineage do not match");
  if (convergence?.recommended_action !== "create_replan") {
    throw new Error("Pending replan convergence lineage is missing");
  }
  return targetWorkItemId;
}

const clearedReplanProgressKeys = new Set([
  "implementation_path",
  "last_attempt_path",
  "verification_path",
  "review_path",
  "review_revision",
  "review_cycle_path",
  "review_effect_id",
  "fix_reservation_id",
  "queue_state",
  "queue_path",
  "active_action_id",
  "active_action_attempt",
  "focused_review_path",
  "mutation_kind",
  "self_review_state",
  "mutation_verification_path",
  "self_review_claim_owner",
  "backup_claim_transfer_pending",
  "candidate_recheck",
  "replan_patch_path",
  "replan_source_work_item_id",
  "replan_target_work_item_id",
  "blocker",
  "blocker_code",
]);

function resetTargetProgress(
  progress: RunManifestV2Ledger["work_item_progress"][string],
  revision: number,
  targetWorkItemId: string,
  patchPath: string,
): RunManifestV2Ledger["work_item_progress"][string] {
  const retained = Object.fromEntries(
    Object.entries(progress).filter(([key]) => !clearedReplanProgressKeys.has(key)),
  );
  const history = Array.isArray(progress.approved_replan_history)
    ? progress.approved_replan_history
    : [];
  return {
    ...retained,
    status: "pending",
    // Reserve the next lifetime attempt so resumed artifacts cannot collide
    // with immutable evidence from the approved base revision.
    attempts: progress.attempts + 1,
    fix_cycles_used: 0,
    plan_revision: revision,
    approved_replan_history: [...history, {
      target_work_item_id: targetWorkItemId,
      plan_revision: revision,
      replan_patch_path: patchPath,
      review_revision: progress.review_revision,
      review_cycle_path: progress.review_cycle_path,
      review_effect_id: progress.review_effect_id,
      review_path: progress.review_path,
      verification_path: progress.verification_path,
      delivery_phase: progress.delivery_phase,
    }],
    last_approved_replan_target_work_item_id: targetWorkItemId,
    last_approved_replan_revision: revision,
    last_approved_replan_patch_path: patchPath,
  };
}

function archiveSourceProgress(
  progress: RunManifestV2Ledger["work_item_progress"][string],
  targetWorkItemId: string,
  revision: number,
  patchPath: string,
): RunManifestV2Ledger["work_item_progress"][string] {
  const history = Array.isArray(progress.approved_replan_history)
    ? progress.approved_replan_history
    : [];
  const next: RunManifestV2Ledger["work_item_progress"][string] = {
    ...progress,
    status: "in_progress" as const,
    // The source phase will run again after the concrete target completes.
    // Reserve its next lifetime attempt so immutable artifacts are never reused.
    attempts: progress.attempts + 1,
    approved_replan_history: [...history, {
      target_work_item_id: targetWorkItemId,
      plan_revision: revision,
      replan_patch_path: patchPath,
      review_revision: progress.review_revision,
      review_cycle_path: progress.review_cycle_path,
      review_effect_id: progress.review_effect_id,
      review_path: progress.review_path,
      verification_path: progress.verification_path,
      delivery_phase: progress.delivery_phase,
    }],
    last_approved_replan_target_work_item_id: targetWorkItemId,
    last_approved_replan_revision: revision,
    last_approved_replan_patch_path: patchPath,
  };
  for (const key of [
    "replan_patch_path",
    "replan_target_work_item_id",
    "review_revision",
    "review_cycle_path",
    "review_effect_id",
    "review_path",
    "verification_path",
    "candidate_recheck",
    "blocker",
    "blocker_code",
    "delivery_phase",
  ]) delete next[key];
  return next;
}

function completionPath(effectId: string): string {
  return `reviews/effects/${Buffer.from(effectId, "utf8").toString("base64url")}/completion.json`;
}

async function verifyCompletedReplanReviewEffect(input: {
  runDir: string;
  manifest: RunManifestV2Ledger;
  sourceWorkItemId: string;
  targetWorkItemId: string;
  patchPath: string;
  convergence: ConvergenceReport;
  approvedHistory: Record<string, unknown> | null;
  record: ReplanPatchRecord;
}): Promise<void> {
  const {
    runDir,
    manifest,
    sourceWorkItemId,
    targetWorkItemId,
    patchPath,
    convergence,
    approvedHistory,
    record,
  } = input;
  const decisionPath = reviewDecisionPath(sourceWorkItemId, convergence.review_revision);
  const projected = sourceWorkItemId !== targetWorkItemId;
  if (projected && sourceWorkItemId !== "integrated") {
    throw new Error("Completed projected replan source must be integrated review provenance");
  }
  const archivedDeliveryPhase = approvedHistory?.delivery_phase;
  if (projected && archivedDeliveryPhase !== undefined && archivedDeliveryPhase !== "post_pr") {
    throw new Error("Completed replan source history has invalid review phase provenance");
  }
  const expectedPhase = projected
    ? archivedDeliveryPhase === "post_pr" ? "post_pr" : "final_integrated"
    : "work_item";
  const historyMismatch = projected ? [
    ["review revision", approvedHistory?.review_revision !== convergence.review_revision],
    ["decision path", approvedHistory?.review_cycle_path !== decisionPath],
    ["effect identity", typeof approvedHistory?.review_effect_id !== "string"],
  ] as const : [];
  const mismatchedHistoryField = historyMismatch.find(([, mismatched]) => mismatched)?.[0];
  if (mismatchedHistoryField) {
    throw new Error(`Completed replan source history ${mismatchedHistoryField} is missing exact review lineage`);
  }

  const decision = await readOptionalValidatedArtifact(runDir, decisionPath, reviewCycleStateSchema);
  if (!decision) throw new Error("Completed replan review decision is missing");
  const policy = manifest.review_policy_snapshot;
  if (!policy) throw new Error("Completed replan review policy snapshot is missing");
  const expectedPolicyHash = createHash("sha256").update(JSON.stringify(policy)).digest("hex");
  const expectedAuthorizationRequired = convergence.decision_reason_code === "warning_authorization_required";
  const expectedAccounting = {
    review_revision: convergence.review_revision - 1,
    fix_cycles_used: convergence.fix_cycles_used,
    self_review_mutations_used: convergence.self_review_mutations_used,
    plan_revision: convergence.plan_revision,
  };
  const decisionMismatch = [
    ["source", decision.work_item_id !== sourceWorkItemId],
    ["phase", decision.phase !== expectedPhase],
    ["review revision", decision.review_revision !== convergence.review_revision],
    ["policy hash", decision.policy_hash !== expectedPolicyHash],
    ["decision path", decision.decision_path !== decisionPath],
    ["effect state", decision.effect_state !== "pending"],
    ["action", decision.decision.action !== "create_replan"],
    ["reason code", decision.decision.reason_code !== convergence.decision_reason_code],
    ["policy revision", decision.decision.policy_revision !== convergence.policy_revision],
    ["authorization", decision.decision.authorization_required !== expectedAuthorizationRequired],
  ] as const;
  const mismatchedDecisionField = decisionMismatch.find(([, mismatched]) => mismatched)?.[0];
  if (mismatchedDecisionField) {
    throw new Error(`Completed replan review decision ${mismatchedDecisionField} does not match convergence`);
  }
  assertEqual("completed review decision findings", decision.decision.finding_ids, convergence.unresolved_finding_ids);
  assertEqual(
    "completed review cycle finding normalization",
    decision.finding_ids,
    [...new Set(decision.finding_ids)].sort(),
  );
  if (convergence.unresolved_finding_ids.some((findingId) => !decision.finding_ids.includes(findingId))) {
    throw new Error("Completed replan convergence findings are absent from the review cycle");
  }
  assertEqual("completed review accounting", decision.accounting_before, expectedAccounting);
  const expectedCycleId = reviewCycleIdentity({
    work_item_id: sourceWorkItemId,
    phase: expectedPhase,
    review_revision: convergence.review_revision,
    policy_hash: expectedPolicyHash,
    finding_ids: decision.finding_ids,
    accounting_before: expectedAccounting,
    work_item_progress_reference: decision.work_item_progress_reference,
  });
  const expectedEffectId = reviewEffectIdentity(expectedCycleId, decision.decision);
  if (decision.cycle_id !== expectedCycleId
    || decision.effect_id !== expectedEffectId
    || (projected && approvedHistory?.review_effect_id !== expectedEffectId)) {
    throw new Error("Completed replan review cycle identity does not match durable provenance");
  }

  const expectedOwner = projected
    ? `runtime:${expectedPhase}:integrated`
    : `runtime:work-item:${sourceWorkItemId}`;
  const persistedEffect = await validatePersistedReviewEffectState(runDir, decision, expectedOwner);
  if (!persistedEffect.claim || !persistedEffect.completion
    || persistedEffect.completion.effect_state !== "complete") {
    throw new Error("Completed replan review effect state machine is incomplete");
  }
  const completion = persistedEffect.completion;
  const result = completion.effect_result;
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("Completed replan review effect result is invalid");
  }
  const expectedBlocker = projected
    ? `Review policy requires replanning ${targetWorkItemId} from ${expectedPhase}`
    : `Review policy requires replanning for work item ${sourceWorkItemId}`;
  const effectResult = result as Record<string, unknown>;
  const expectedResult = projected
    ? { blocker: expectedBlocker, replan_patch_path: patchPath, target_work_item_id: targetWorkItemId }
    : { blocker: expectedBlocker, replan_patch_path: patchPath };
  assertEqual("completed review effect result", effectResult, expectedResult);
  await verifyCanonicalReplanProvenance({
    runDir,
    manifest,
    sourceWorkItemId,
    record,
    convergence,
    cycle: decision,
  });
}

function buildApprovedResetEvent(
  manifest: RunManifestV2Ledger,
  workItemId: string,
  baseRevision: number,
  revision: number,
  patchPath: string,
): RunEvent {
  const eventId = `approved-replan-reset:${createHash("sha256")
    .update(`${manifest.run_id}:${workItemId}:${baseRevision}:${revision}:${patchPath}`, "utf8").digest("hex")}`;
  return {
    event_id: eventId,
    run_id: manifest.run_id,
    stage: "worktree_setup",
    type: "approved_replan_attempt_reset",
    timestamp: manifest.updated_at,
    actor: "human",
    payload: {
      work_item_id: workItemId,
      base_plan_revision: baseRevision,
      plan_revision: revision,
      replan_patch_path: patchPath,
    },
  };
}

export interface ReplanEventIoHooks {
  resetRead?: OwnedFileIoHooks;
  resetAppend?: OwnedFileIoHooks;
  repairAppend?: OwnedFileIoHooks;
}

async function readRunEvents(runDir: string, hooks: OwnedFileIoHooks = {}): Promise<RunEvent[]> {
  return (await readOwnedRunFile(runDir, "events.jsonl", hooks)).toString("utf8")
    .split("\n").filter(Boolean).map((line) => JSON.parse(line) as RunEvent);
}

async function appendApprovedResetEvent(
  runDir: string,
  manifest: RunManifestV2Ledger,
  workItemId: string,
  baseRevision: number,
  revision: number,
  patchPath: string,
  hooks: ReplanEventIoHooks = {},
): Promise<void> {
  const event = buildApprovedResetEvent(manifest, workItemId, baseRevision, revision, patchPath);
  const eventId = event.event_id;
  const events = await readRunEvents(runDir, hooks.resetRead);
  const matching = events.filter((candidate) => candidate.event_id === eventId);
  if (matching.length > 1) throw new Error(`Duplicate approved replan reset event: ${eventId}`);
  if (matching.length === 1) {
    if (canonical(matching[0]) !== canonical(event)) {
      throw new Error(`Approved replan reset event conflicts with durable approval: ${eventId}`);
    }
    return;
  }
  await appendOwnedRunFile(runDir, "events.jsonl", `${JSON.stringify(event)}\n`, hooks.resetAppend);
}

interface ApprovedResetEventCoordinates {
  workItemId: string;
  baseRevision: number;
  revision: number;
  patchPath: string;
}

async function readApprovedResetEvent(
  runDir: string,
  manifest: RunManifestV2Ledger,
  revision: number,
  hooks: OwnedFileIoHooks = {},
): Promise<ApprovedResetEventCoordinates | null> {
  const events = (await readRunEvents(runDir, hooks))
    .filter((event) => event.type === "approved_replan_attempt_reset"
      && (event.payload as { plan_revision?: unknown }).plan_revision === revision);
  if (events.length > 1) throw new Error(`Duplicate approved replan reset event for revision ${revision}`);
  if (events.length === 0) return null;
  const revisionRecord = manifest.plan_revisions[String(revision)];
  const recordedBaseRevision = revisionRecord?.origin === "replan" ? revisionRecord.base_revision : null;
  const event = events[0]!;
  const payload = event.payload as {
    work_item_id?: unknown;
    base_plan_revision?: unknown;
    plan_revision?: unknown;
    replan_patch_path?: unknown;
  };
  if (typeof payload.work_item_id !== "string"
    || typeof payload.base_plan_revision !== "number"
    || payload.base_plan_revision !== recordedBaseRevision
    || payload.plan_revision !== revision
    || typeof payload.replan_patch_path !== "string") {
    throw new Error("Approved replan reset event payload conflicts with durable approval");
  }
  const expectedPayload = {
    work_item_id: payload.work_item_id,
    base_plan_revision: payload.base_plan_revision,
    plan_revision: revision,
    replan_patch_path: payload.replan_patch_path,
  };
  if (canonical(payload) !== canonical(expectedPayload)) {
    throw new Error("Approved replan reset event payload is not exact");
  }
  const eventId = `approved-replan-reset:${createHash("sha256")
    .update(`${manifest.run_id}:${payload.work_item_id}:${payload.base_plan_revision}:${revision}:${payload.replan_patch_path}`, "utf8").digest("hex")}`;
  if (event.event_id !== eventId
    || event.run_id !== manifest.run_id
    || event.stage !== "worktree_setup"
    || event.actor !== "human") {
    throw new Error(`Approved replan reset event conflicts with durable approval: ${eventId}`);
  }
  return {
    workItemId: payload.work_item_id,
    baseRevision: payload.base_plan_revision,
    revision,
    patchPath: payload.replan_patch_path,
  };
}

async function reconcileCompletedReplanEvents(input: {
  runDir: string;
  manifest: RunManifestV2Ledger;
  verifiedApproval: VerifiedPlanApproval;
  workItemId: string;
  baseRevision: number;
  planRevision: number;
  planSha256: string;
  patchPath: string;
  eventIoHooks?: ReplanEventIoHooks;
}): Promise<void> {
  const {
    runDir,
    manifest,
    verifiedApproval,
    workItemId,
    baseRevision,
    planRevision,
    planSha256,
    patchPath,
    eventIoHooks = {},
  } = input;
  const resetEvent = await readApprovedResetEvent(runDir, manifest, planRevision, eventIoHooks.resetRead);
  if (resetEvent !== null
    && (resetEvent.workItemId !== workItemId
      || resetEvent.baseRevision !== baseRevision
      || resetEvent.patchPath !== patchPath)) {
    throw new Error("Approved replan reset event does not match immutable promotion provenance");
  }
  const hasApprovalEvent = await hasExactPlanApprovalEvent(
    runDir,
    manifest,
    "human",
    planRevision,
    planSha256,
    verifiedApproval,
  );
  if (hasApprovalEvent && resetEvent !== null) return;
  if (manifest.stage !== "worktree_setup") {
    throw new Error("Cannot repair missing replan approval events after workflow advancement");
  }
  const missingEvents: RunEvent[] = [];
  if (!hasApprovalEvent) {
    missingEvents.push(buildPlanApprovalEventRecord(
      manifest,
      "human",
      planRevision,
      planSha256,
      verifiedApproval,
    ) as RunEvent);
  }
  if (resetEvent === null) {
    missingEvents.push(buildApprovedResetEvent(
      manifest,
      workItemId,
      baseRevision,
      planRevision,
      patchPath,
    ));
  }
  await appendOwnedRunFile(
    runDir,
    "events.jsonl",
    missingEvents.map((event) => `${JSON.stringify(event)}\n`).join(""),
    eventIoHooks.repairAppend,
  );
}

export interface PrepareReplanApprovalBoundaryInput {
  runDir: string;
  targetWorkItemId: string;
  runConfigurationIoHooks?: OwnedFileIoHooks;
  afterRunConfigurationWrite?: () => Promise<void>;
  afterPlanWrite?: () => Promise<void>;
  afterRequestWrite?: () => Promise<void>;
  beforePendingReconciliation?: () => Promise<void>;
  afterBoundaryCommit?: () => Promise<void>;
}

export interface PreparedReplanApprovalBoundary {
  state: "pending" | "approved";
  manifest: RunManifestV2Ledger;
  request: PlanApprovalRequestV1;
  coordinates: PreparedReplanApprovalCoordinates;
}

export interface PreparedReplanApprovalCoordinates {
  baseRevision: number;
  proposedRevision: number;
  pending: PendingPlanApprovalV1;
  canonicalBlocker: string;
}

export class ReplanBoundaryPostCommitError extends Error {
  readonly baseRevision: number;
  readonly proposedRevision: number;
  readonly pending: PendingPlanApprovalV1;
  readonly canonicalBlocker: string;

  constructor(input: {
    cause: unknown;
    baseRevision: number;
    proposedRevision: number;
    pending: PendingPlanApprovalV1;
    canonicalBlocker: string;
  }) {
    super(input.cause instanceof Error ? input.cause.message : String(input.cause), { cause: input.cause });
    this.name = "ReplanBoundaryPostCommitError";
    this.baseRevision = input.baseRevision;
    this.proposedRevision = input.proposedRevision;
    this.pending = input.pending;
    this.canonicalBlocker = input.canonicalBlocker;
  }
}

function invalidCandidateDiagnostics(error: unknown): string[] {
  if (error instanceof PlanReadinessError) {
    return error.diagnostics.map((diagnostic) => diagnostic.message);
  }
  const message = error instanceof Error ? error.message : String(error);
  return message.split("\n- ").map((entry) => entry.trim()).filter(Boolean);
}

async function reuseOrWritePlanRevision(
  runDir: string,
  path: string,
  planText: string,
): Promise<void> {
  try {
    await writeOwnedEvidenceFile(runDir, path, "plans/", planText);
  } catch (error: unknown) {
    if (errorCode(error) !== "EEXIST") throw error;
    const existing = (await readOwnedEvidenceFile(runDir, path, "plans/")).toString("utf8");
    if (existing !== planText) {
      throw new Error(`Prepared replan found conflicting orphaned revision bytes: ${path}`);
    }
  }
}

async function reuseOrWriteApprovalRequest(
  runDir: string,
  request: PlanApprovalRequestV1,
): Promise<{ path: string; sha256: string }> {
  try {
    return await writePlanApprovalRequest(runDir, request);
  } catch (error: unknown) {
    if (errorCode(error) !== "EEXIST") throw error;
    const path = `approvals/plan/revision-${request.subject.plan_revision}.json`;
    let bytes: string;
    let parsed: PlanApprovalRequestV1;
    try {
      bytes = (await readOwnedRunFile(runDir, path)).toString("utf8");
      parsed = planApprovalRequestSchema.parse(JSON.parse(bytes));
    } catch (readError) {
      throw new Error(`Prepared replan conflicts with invalid orphaned approval request: ${path}`, { cause: readError });
    }
    const expectedBytes = serializePlanApprovalRequest(request);
    const externalSha256 = createHash("sha256").update(bytes, "utf8").digest("hex");
    if (serializePlanApprovalRequest(parsed) !== bytes
      || externalSha256 !== requestSha256(parsed)
      || bytes !== expectedBytes
      || externalSha256 !== requestSha256(request)) {
      throw new Error(`Prepared replan conflicts with orphaned approval request bytes: ${path}`);
    }
    return { path, sha256: externalSha256 };
  }
}

async function pendingReplanCanonicalBlocker(
  runDir: string,
  manifest: RunManifestV2Ledger,
  targetWorkItemId: string,
): Promise<string> {
  const sourceWorkItemId = manifest.current_work_item_id;
  const source = sourceWorkItemId === null ? undefined : manifest.work_item_progress[sourceWorkItemId];
  if (sourceWorkItemId === null
    || !source
    || typeof source.review_cycle_path !== "string"
    || typeof source.review_effect_id !== "string"
    || typeof source.replan_patch_path !== "string"
    || source.replan_target_work_item_id !== targetWorkItemId) {
    throw new Error("Pending replan approval source lineage is incomplete");
  }
  const decision = await readOptionalValidatedArtifact(runDir, source.review_cycle_path, reviewCycleStateSchema);
  const completed = await readOptionalValidatedArtifact(runDir, completionPath(source.review_effect_id), reviewCycleStateSchema);
  const effectResult = completed?.effect_result as {
    blocker?: unknown;
    replan_patch_path?: unknown;
    target_work_item_id?: unknown;
  } | undefined;
  if (!decision
    || !completed
    || decision.effect_id !== source.review_effect_id
    || decision.work_item_id !== sourceWorkItemId
    || decision.decision.action !== "create_replan"
    || completed.effect_state !== "complete"
    || completed.effect_id !== decision.effect_id
    || completed.work_item_id !== decision.work_item_id
    || completed.review_revision !== decision.review_revision
    || completed.decision_path !== decision.decision_path
    || canonical(completed.decision) !== canonical(decision.decision)
    || canonical(completed.finding_ids) !== canonical(decision.finding_ids)
    || canonical(completed.accounting_before) !== canonical(decision.accounting_before)
    || typeof effectResult?.blocker !== "string"
    || effectResult.blocker.trim() === ""
    || effectResult.replan_patch_path !== source.replan_patch_path
    || (sourceWorkItemId !== targetWorkItemId && effectResult.target_work_item_id !== targetWorkItemId)) {
    throw new Error("Pending replan approval source effect is invalid");
  }
  await validateActiveReplanPatch(
    runDir,
    manifest,
    sourceWorkItemId,
    source.replan_patch_path,
    decision,
    completed,
  );
  return effectResult.blocker;
}

async function withStandaloneReplanPreparationAuthority<T>(
  runDir: string,
  operation: () => Promise<T>,
): Promise<T> {
  const claim = await acquireExecutionLease(runDir, { mode: "replan_preparation" });
  const context = {
    claim,
    assert: () => assertExecutionLease(runDir, claim),
    beginEffect: (kind: string) => beginExecutionEffect(runDir, claim, kind),
    recordEffectChild: (invocationId: string, pid: number | null) =>
      recordExecutionEffectChild(runDir, claim, invocationId, pid),
    endEffect: (invocationId: string) => endExecutionEffect(runDir, claim, invocationId),
  };
  try {
    return await runWithExecutionAuthority(context, operation);
  } finally {
    const current = await readManifestV2(runDir).catch(() => null);
    if (current?.execution_lease?.token === claim.token
      && current.execution_lease.active_effect === null) {
      try {
        await releaseExecutionLease(runDir, claim);
      } catch (error) {
        const refreshed = await readManifestV2(runDir).catch(() => null);
        if (refreshed?.execution_lease?.token === claim.token) throw error;
      }
    }
  }
}

/** Persist one validated replan candidate and exact approval request without promoting it. */
export async function prepareReplanApprovalBoundary(
  input: PrepareReplanApprovalBoundaryInput,
): Promise<PreparedReplanApprovalBoundary> {
  if (!input.targetWorkItemId.trim()) throw new Error("Replan preparation target work item must be non-empty");
  const manifest = await readManifestV2(input.runDir);
  const approvedRuntime = manifest.approved_revision !== null;
  if (manifest.execution_lease !== null && manifest.execution_lease !== undefined) {
    const authority = currentExecutionAuthority();
    if (!authority || await realpath(authority.claim.runDir) !== await realpath(input.runDir)) {
      throw new Error("Approved replan preparation requires the active execution lease owner before artifact writes");
    }
    await assertExecutionLease(input.runDir, authority.claim);
  }
  if (manifest.pending_plan_approval !== null) {
    if (manifest.pending_plan_approval.base_revision === null) {
      throw new Error("Cannot prepare a replan while an initial plan approval is pending");
    }
    if (resolvePendingReplanTarget(manifest) !== input.targetWorkItemId) {
      throw new Error("Pending plan approval targets a different replan work item");
    }
    const request = await readVerifiedPlanApprovalRequest(input.runDir, manifest);
    const canonicalBlocker = await pendingReplanCanonicalBlocker(input.runDir, manifest, input.targetWorkItemId);
    const coordinates = {
      baseRevision: manifest.pending_plan_approval.base_revision,
      proposedRevision: manifest.pending_plan_approval.proposed_revision,
      pending: manifest.pending_plan_approval,
      canonicalBlocker,
    };
    await input.beforePendingReconciliation?.();
    const reconciled = await reconcilePreparedPlanApprovalBoundary({
      runDir: input.runDir,
      ...coordinates,
    });
    return { state: reconciled.state, manifest: reconciled.manifest, request, coordinates };
  }
  if (manifest.stage !== "replanning" && manifest.stage !== "awaiting_plan_approval") {
    throw new Error(`Replan preparation requires replanning or legacy awaiting_plan_approval stage, got ${manifest.stage}`);
  }
  const baseRevision = manifest.approved_revision ?? manifest.approved_plan_revision;
  if (baseRevision === null
    || manifest.current_revision !== baseRevision
    || manifest.current_plan_revision !== baseRevision
    || manifest.approved_revision !== baseRevision
    || manifest.approved_plan_revision !== baseRevision) {
    throw new Error("Replan preparation requires one exact current approved base revision");
  }
  const proposedRevision = Math.max(baseRevision, ...Object.keys(manifest.plan_revisions).map(Number)) + 1;
  const sourceWorkItemId = manifest.current_work_item_id;
  const sourceProgress = sourceWorkItemId === null
    ? undefined
    : manifest.work_item_progress[sourceWorkItemId];
  if (sourceWorkItemId === null || !sourceProgress || typeof sourceProgress.replan_patch_path !== "string") {
    throw new Error("Replan preparation current source lineage is missing");
  }
  if (sourceProgress.replan_target_work_item_id !== input.targetWorkItemId) {
    throw new Error("Replan preparation source target projection lineage does not match");
  }
  const targetProgress = manifest.work_item_progress[input.targetWorkItemId];
  if (!targetProgress) throw new Error("Replan preparation concrete target progress lineage is missing");
  const baseRecord = manifest.plan_revisions[String(baseRevision)];
  if (!baseRecord || baseRecord.revision !== baseRevision) {
    throw new Error(`Replan preparation base plan revision ${baseRevision} is not recorded`);
  }
  const convergenceSummary = manifest.convergence_reports?.[sourceWorkItemId];
  if (!convergenceSummary || convergenceSummary.plan_revision !== baseRevision
    || convergenceSummary.recommended_action !== "create_replan") {
    throw new Error("Replan preparation convergence provenance does not match the target and base revision");
  }
  const patchPath = replanPatchPath(
    input.targetWorkItemId,
    baseRevision,
    convergenceSummary.review_revision,
  );
  if (sourceWorkItemId !== input.targetWorkItemId
    && (targetProgress.replan_source_work_item_id !== sourceWorkItemId
      || targetProgress.replan_patch_path !== patchPath)) {
    throw new Error("Replan preparation concrete target projection lineage does not match");
  }
  const record = await readOptionalValidatedArtifact(input.runDir, patchPath, replanPatchRecordSchema);
  if (!record) throw new Error("Replan preparation immutable pending patch is missing");
  if (record.patch.target_work_item_id !== input.targetWorkItemId
    || record.patch.base_plan_revision !== baseRevision
    || record.provenance.base_plan_revision !== baseRevision
    || record.provenance.convergence_report_path !== convergenceSummary.path
    || record.provenance.convergence_review_revision !== convergenceSummary.review_revision
    || (sourceWorkItemId !== input.targetWorkItemId
      && sourceProgress.replan_target_work_item_id !== input.targetWorkItemId)) {
    throw new Error("Replan preparation patch target or base provenance does not match");
  }
  assertEqual("preparation finding set", record.patch.unresolved_finding_ids, record.provenance.unresolved_finding_ids);
  assertEqual("preparation release guards", record.provenance.release_guards, manifest.release_guards ?? []);
  const durableBrain = manifest.selected_role_profiles.brain ?? manifest.role_profiles.brain;
  assertEqual("preparation model profile", record.provenance.model_profile, durableBrain);

  const convergence = await readOptionalValidatedArtifact(input.runDir, convergenceSummary.path, convergenceReportSchema);
  if (!convergence
    || convergence.work_item_id !== sourceWorkItemId
    || convergence.plan_revision !== baseRevision
    || convergence.review_revision !== convergenceSummary.review_revision
    || convergence.recommended_action !== "create_replan") {
    throw new Error("Replan preparation convergence report does not match durable provenance");
  }
  assertEqual("preparation convergence findings", convergence.unresolved_finding_ids, record.patch.unresolved_finding_ids);
  assertEqual("preparation evidence paths", convergence.evidence_refs, record.provenance.evidence_paths);
  if (sourceProgress.replan_patch_path !== patchPath) {
    throw new Error("Replan preparation pending patch pointer does not match the immutable patch");
  }
  const decision = await readOptionalValidatedArtifact(
    input.runDir,
    String(sourceProgress.review_cycle_path ?? ""),
    reviewCycleStateSchema,
  );
  if (!decision
    || decision.work_item_id !== sourceWorkItemId
    || decision.effect_id !== sourceProgress.review_effect_id
    || decision.review_revision !== convergence.review_revision
    || decision.decision.action !== "create_replan"
    || canonical(decision.decision.finding_ids) !== canonical(convergence.unresolved_finding_ids)) {
    throw new Error("Replan preparation review effect provenance does not match");
  }
  const completed = await readOptionalValidatedArtifact(
    input.runDir,
    completionPath(decision.effect_id),
    reviewCycleStateSchema,
  );
  if (!completed
    || completed.effect_state !== "complete"
    || completed.effect_id !== decision.effect_id
    || completed.work_item_id !== decision.work_item_id
    || completed.review_revision !== decision.review_revision
    || completed.decision_path !== decision.decision_path
    || canonical(completed.decision) !== canonical(decision.decision)
    || canonical(completed.finding_ids) !== canonical(decision.finding_ids)
    || canonical(completed.accounting_before) !== canonical(decision.accounting_before)
    || typeof (completed.effect_result as { blocker?: unknown } | undefined)?.blocker !== "string"
    || (completed.effect_result as { replan_patch_path?: unknown; target_work_item_id?: unknown } | undefined)?.replan_patch_path !== patchPath
    || (sourceWorkItemId !== input.targetWorkItemId
      && (completed.effect_result as { target_work_item_id?: unknown } | undefined)?.target_work_item_id !== input.targetWorkItemId)) {
    throw new Error("Replan preparation effect is not immutably complete for the exact patch");
  }
  const canonicalBlocker = (completed.effect_result as { blocker: string }).blocker;
  await validateActiveReplanPatch(
    input.runDir,
    manifest,
    sourceWorkItemId,
    patchPath,
    decision,
    completed,
  );

  const verified = await loadVerifiedPlanBundle(input.runDir, manifest, baseRevision);
  const basePlan = verified.plan;
  if (!basePlan.work_items.some((item) => item.id === input.targetWorkItemId)) {
    throw new Error("Replan preparation target is absent from the approved base plan");
  }
  if (manifest.work_item_progress[input.targetWorkItemId]?.status === "complete" && sourceWorkItemId !== "integrated") {
    throw new Error("Replan preparation cannot change a completed target work item");
  }
  const durableCriteria = baseRecord.acceptance_criteria?.[input.targetWorkItemId];
  if (!durableCriteria?.length
    || canonical(record.provenance.criterion_refs) !== canonical(durableCriteria.map(({ ref }) => ref))) {
    throw new Error("Replan preparation criterion provenance does not match the base plan");
  }
  const criterionChanges = new Map(record.patch.added_or_changed_criteria.map(({ ref, text }) => [ref, text]));
  if (criterionChanges.size !== record.patch.added_or_changed_criteria.length
    || [...criterionChanges.keys()].some((ref) => !durableCriteria.some((criterion) => criterion.ref === ref))) {
    throw new Error("Replan preparation criterion patch is not an exact target subset");
  }
  let proposed: ReturnType<typeof materializeReplanCandidate>;
  try {
    proposed = materializeReplanCandidate({
      basePlan,
      targetWorkItemId: input.targetWorkItemId,
      patch: record.patch,
      durableCriteria,
      workflowProtocol: manifest.workflow_protocol,
      materializationVersion: record.materialization_version ?? 1,
    });
    proposed = parseExecutionPlan(proposed, { mode: manifest.mode, repoRoot: manifest.repo_root }, manifest.workflow_protocol);
    if (manifest.workflow_protocol === "durable-discovery-v1") {
      if (verified.brief === null) throw new Error("Durable replan base is missing its verified approved brief");
      validateDiscoveryCoverage(proposed as DiscoveredBrainPlan, verified.brief);
    }
    const baseTarget = basePlan.work_items.find((item) => item.id === input.targetWorkItemId)!;
    const proposedTarget = proposed.work_items.find((item) => item.id === input.targetWorkItemId)!;
    const reviewPath = decision.work_item_progress_reference?.review_path;
    if (!reviewPath) throw new Error("Replan candidate validation is missing its exact review evidence");
    const review = persistedVerifierReviewSchema.parse(JSON.parse((await readOwnedEvidenceFile(
      input.runDir,
      reviewPath,
      "reviews/",
    )).toString("utf8")));
    const outputDiagnostics = replanOutputScopeDiagnostics({
      baseTarget,
      proposedTarget,
      review,
      findingRecords: record.provenance.finding_records,
      approvedArtifactOutputs: proposed.work_items.flatMap((item) => item.expected_artifacts),
      approvedBrowserOutputs: proposed.work_items.flatMap((item) =>
        item.browser_checks.map((check) => check.screenshot_artifact)),
    });
    if (outputDiagnostics.length > 0) throw new InvalidReplanCandidateError(outputDiagnostics);
  } catch (error) {
    if (error instanceof InvalidReplanCandidateError) throw error;
    throw new InvalidReplanCandidateError(invalidCandidateDiagnostics(error), { cause: error });
  }

  const planText = serializePersistedPlan(proposed, manifest.workflow_protocol);
  const planSha256 = createHash("sha256").update(planText, "utf8").digest("hex");
  if (planSha256 === baseRecord.sha256) throw new NoMaterialReplanError();
  const decisionContracts = {
    base: planDecisionContractSha256(basePlan),
    proposed: planDecisionContractSha256(proposed),
  };
  const delta = buildPlanDelta(basePlan, proposed, { baseRevision, proposedRevision });
  const existingRunConfiguration = await readExistingHistoricalRunConfiguration(input.runDir, manifest);
  if (approvedRuntime) {
    const authority = currentExecutionAuthority();
    if (!authority || await realpath(authority.claim.runDir) !== await realpath(input.runDir)) {
      const prepared = await withStandaloneReplanPreparationAuthority(input.runDir, () => prepareReplanApprovalBoundary(input));
      return { ...prepared, manifest: await readManifestV2(input.runDir) };
    }
    await assertExecutionLease(input.runDir, authority.claim);
  }
  const runConfiguration = existingRunConfiguration ?? await readOrMigrateHistoricalRunConfiguration(
    input.runDir,
    manifest,
    input.runConfigurationIoHooks,
    input.afterRunConfigurationWrite,
  );
  const revisionPath = `plans/revision-${proposedRevision}.md`;
  const request = buildPlanApprovalRequest({
    manifest,
    runConfiguration,
    reasonCode: "material_replan",
    revision: proposedRevision,
    baseRevision,
    planPath: revisionPath,
    planSha256,
    decisionContractSha256: decisionContracts.proposed,
    delta,
  });
  await reuseOrWritePlanRevision(input.runDir, revisionPath, planText);
  await input.afterPlanWrite?.();
  const requestRecord = await reuseOrWriteApprovalRequest(input.runDir, request);
  await input.afterRequestWrite?.();
  const revision = {
    revision: proposedRevision,
    path: revisionPath,
    sha256: planSha256,
    acceptance_criteria: {
      ...baseRecord.acceptance_criteria,
      [input.targetWorkItemId]: durableCriteria.map((criterion) => ({
        ...criterion,
        text: criterionChanges.get(criterion.ref) ?? criterion.text,
      })),
    },
    origin: "replan" as const,
    base_revision: baseRevision,
    approval_request_path: requestRecord.path,
    approval_request_sha256: requestRecord.sha256,
    approval_subject_sha256: request.approval_subject_sha256,
    decision_contract_sha256: decisionContracts.proposed,
  };
  const pending = {
    schema_version: 1 as const,
    proposed_revision: proposedRevision,
    base_revision: baseRevision,
    request_path: requestRecord.path,
    request_sha256: requestRecord.sha256,
    approval_subject_sha256: request.approval_subject_sha256,
  };
  await commitPreparedPlanApprovalBoundary({
    runDir: input.runDir,
    baseRevision,
    proposedRevision,
    revision,
    pending,
    expectedManifest: manifest,
    runConfigurationSha256: runConfigurationSha256(runConfiguration),
    canonicalBlocker,
  });
  try {
    await input.afterBoundaryCommit?.();
  } catch (cause) {
    throw new ReplanBoundaryPostCommitError({
      cause,
      baseRevision,
      proposedRevision,
      pending,
      canonicalBlocker,
    });
  }
  const reconciled = await reconcilePreparedPlanApprovalBoundary({
    runDir: input.runDir,
    baseRevision,
    proposedRevision,
    pending,
    canonicalBlocker,
  });
  return {
    state: reconciled.state,
    manifest: reconciled.manifest,
    request,
    coordinates: { baseRevision, proposedRevision, pending, canonicalBlocker },
  };
}

/** Finish an interrupted or legacy patch-only replan boundary without invoking Brain. */
export async function reconcilePendingReplanApprovalBoundary(
  input: Omit<PrepareReplanApprovalBoundaryInput, "targetWorkItemId">,
): Promise<PreparedReplanApprovalBoundary | null> {
  const manifest = await readManifestV2(input.runDir);
  if (manifest.pending_plan_approval !== null) {
    if (manifest.pending_plan_approval.base_revision === null) return null;
    const targetWorkItemId = resolvePendingReplanTarget(manifest);
    if (targetWorkItemId === null) throw new Error("Pending replan approval target is missing");
    return prepareReplanApprovalBoundary({ ...input, targetWorkItemId });
  }
  if (manifest.stage !== "replanning" && manifest.stage !== "awaiting_plan_approval") return null;
  const sourceWorkItemId = manifest.current_work_item_id;
  if (sourceWorkItemId === null) return null;
  const source = manifest.work_item_progress[sourceWorkItemId];
  if (!source || typeof source.replan_patch_path !== "string") return null;
  const targetWorkItemId = typeof source.replan_target_work_item_id === "string"
    ? source.replan_target_work_item_id
    : sourceWorkItemId;
  return prepareReplanApprovalBoundary({ ...input, targetWorkItemId });
}

/** Promote one already-persisted replan revision without changing its plan bytes. */
export async function approvePreparedReplanRevision(
  runDir: string,
  workItemId: string,
  planRevision: number,
  options: {
    approvalControllerCapture?: ApprovalControllerCapture;
    verifyCurrentController?: boolean;
    transactionHooks?: RunLedgerTransactionHooks;
    completedReplay?: boolean;
    eventIoHooks?: ReplanEventIoHooks;
  } = {},
): Promise<RunManifestV2Ledger> {
  if (!workItemId.trim()) throw new Error("Replan approval target work item must be non-empty");
  if (!Number.isInteger(planRevision) || planRevision < 2) {
    throw new Error("Replan approval revision must be an integer greater than one");
  }
  return withRunLedgerCompoundTransaction(runDir, async (transaction) => {
    const manifest = await transaction.readManifestV2();
    const proposedRecord = manifest.plan_revisions[String(planRevision)];
    const baseRevision = proposedRecord?.base_revision;
    if (proposedRecord?.origin !== "replan" || baseRevision === null || baseRevision === undefined) {
      throw new Error("Prepared replan revision metadata does not identify its approved base");
    }
    const verifiedApproval = options.verifyCurrentController === false
      ? await verifyPersistedPlanApprovalSubject(
          transaction.runDir,
          manifest,
          planRevision,
        )
      : await verifyPlanApprovalSubject(
          transaction.runDir,
          manifest,
          planRevision,
          options.approvalControllerCapture,
        );
    if (verifiedApproval === null) {
      throw new Error("Prepared replan approval requires immutable request metadata");
    }
    if (!proposedRecord
      || proposedRecord.origin !== "replan"
      || proposedRecord.base_revision !== baseRevision) {
      throw new Error("Prepared replan revision metadata does not match its approved base");
    }
    const completedPromotion = manifest.pending_plan_approval === null
      && manifest.current_revision === planRevision
      && manifest.current_plan_revision === planRevision
      && manifest.approved_revision === planRevision
      && manifest.approved_plan_revision === planRevision
      && (manifest.review_accounting === undefined || manifest.review_accounting.plan_revision === planRevision)
      && manifest.work_item_progress[workItemId]?.plan_revision === planRevision;
    const immediateAlreadyApplied = completedPromotion && manifest.stage === "worktree_setup";
    if (options.completedReplay === true && !completedPromotion) {
      throw new Error("Completed replan promotion progress does not match the approved revision");
    }
    const alreadyApplied = options.completedReplay === true
      ? completedPromotion
      : immediateAlreadyApplied;
    if (alreadyApplied && manifest.stage === "worktree_setup") {
      const immediateProgress = manifest.work_item_progress[workItemId]!;
      if (immediateProgress.status !== "pending"
        || immediateProgress.fix_cycles_used !== 0
        || [...clearedReplanProgressKeys].some((key) => key in immediateProgress)) {
        throw new Error("Immediate completed replan target progress does not match the approved reset");
      }
    }
    await assertPlanApprovalEventPrecondition(
      transaction.runDir,
      planRevision,
      verifiedApproval,
      alreadyApplied,
    );
    let sourceCandidates = Object.entries(manifest.work_item_progress).filter(([candidateId, progress]) =>
      typeof progress.replan_patch_path === "string"
      && (progress.replan_target_work_item_id === workItemId
        || (candidateId === workItemId && progress.replan_source_work_item_id === undefined)));
    if (alreadyApplied && sourceCandidates.length === 0) {
      sourceCandidates = Object.entries(manifest.work_item_progress).filter(([, progress]) =>
        progress.last_approved_replan_target_work_item_id === workItemId
        && progress.last_approved_replan_revision === planRevision);
    }
    if (alreadyApplied && sourceCandidates.length > 1) {
      const archivedPatchPaths = [...new Set(sourceCandidates
        .map(([, progress]) => progress.last_approved_replan_patch_path)
        .filter((path): path is string => typeof path === "string"))];
      if (archivedPatchPaths.length !== 1) {
        throw new Error(`Replan approval archived source cycles disagree for target ${workItemId}`);
      }
      const archivedRecord = await readOptionalValidatedArtifact(
        runDir,
        archivedPatchPaths[0]!,
        replanPatchRecordSchema,
      );
      const archivedConvergence = archivedRecord
        ? await readOptionalValidatedArtifact(
            runDir,
            archivedRecord.provenance.convergence_report_path,
            convergenceReportSchema,
          )
        : null;
      if (!archivedConvergence) {
        throw new Error(`Replan approval archived source provenance is missing for target ${workItemId}`);
      }
      sourceCandidates = sourceCandidates.filter(([candidateId]) => candidateId === archivedConvergence.work_item_id);
    }
    if (sourceCandidates.length !== 1 && !(alreadyApplied && sourceCandidates.length === 0)) {
      throw new Error(`Replan approval must resolve exactly one source cycle for target ${workItemId}`);
    }
    const [sourceWorkItemId, sourceProgress] = sourceCandidates[0]
      ?? [workItemId, manifest.work_item_progress[workItemId]!];
    if (!alreadyApplied) {
      if (manifest.stage !== "awaiting_plan_approval") {
        throw new Error(`Replan approval requires awaiting_plan_approval stage, got ${manifest.stage}`);
      }
      if ((manifest.current_revision ?? manifest.current_plan_revision) !== baseRevision
        || (manifest.approved_revision ?? manifest.approved_plan_revision) !== baseRevision) {
      throw new Error(`Replan approval revision ${planRevision} does not preserve approved base revision ${baseRevision}`);
      }
      if (manifest.current_work_item_id !== sourceWorkItemId) {
        throw new Error("Replan approval source does not match the current work item");
      }
    }

    const baseRecord = manifest.plan_revisions[String(baseRevision)];
    if (!baseRecord) throw new Error(`Replan approval base plan revision ${baseRevision} is not recorded`);
    let approvedHistory: Record<string, unknown> | null = null;
    let archivedPatchPath: string | null = null;
    if (alreadyApplied && sourceCandidates.length > 0) {
      const history = Array.isArray(sourceProgress.approved_replan_history)
        ? sourceProgress.approved_replan_history as Record<string, unknown>[]
        : [];
      const matchingHistory = history.filter((entry) => entry.target_work_item_id === workItemId
        && entry.plan_revision === planRevision
        && typeof entry.replan_patch_path === "string");
      if (matchingHistory.length !== 1) {
        throw new Error("Completed replan source archived lineage does not identify exactly one approved patch");
      }
      approvedHistory = matchingHistory[0]!;
      archivedPatchPath = approvedHistory.replan_patch_path as string;
      if (sourceProgress.last_approved_replan_target_work_item_id !== workItemId
        || sourceProgress.last_approved_replan_revision !== planRevision
        || sourceProgress.last_approved_replan_patch_path !== archivedPatchPath) {
        throw new Error("Completed replan source archived lineage does not match the approved patch");
      }
    }
    const currentConvergenceSummary = manifest.convergence_reports?.[sourceWorkItemId];
    if (archivedPatchPath === null && (!currentConvergenceSummary
      || currentConvergenceSummary.plan_revision !== baseRevision
      || currentConvergenceSummary.recommended_action !== "create_replan")) {
      throw new Error("Replan approval convergence provenance does not match the target and base revision");
    }
    const patchPath = archivedPatchPath
      ?? replanPatchPath(workItemId, baseRevision, currentConvergenceSummary!.review_revision);
    const record = await readOptionalValidatedArtifact(runDir, patchPath, replanPatchRecordSchema);
    if (!record) throw new Error("Replan approval immutable pending patch is missing");
    const convergenceSummary = archivedPatchPath === null
      ? currentConvergenceSummary!
      : {
          path: record.provenance.convergence_report_path,
          plan_revision: baseRevision,
          review_revision: record.provenance.convergence_review_revision,
          recommended_action: "create_replan" as const,
        };
    if (record.patch.target_work_item_id !== workItemId
      || record.patch.base_plan_revision !== baseRevision
      || record.provenance.base_plan_revision !== baseRevision
      || record.provenance.convergence_report_path !== convergenceSummary.path
      || record.provenance.convergence_review_revision !== convergenceSummary.review_revision
      || (!alreadyApplied && sourceWorkItemId !== workItemId
        && sourceProgress.replan_target_work_item_id !== workItemId)) {
      throw new Error("Replan approval patch target or base provenance does not match");
    }
    assertEqual("approval finding set", record.patch.unresolved_finding_ids, record.provenance.unresolved_finding_ids);
    assertEqual("approval release guards", record.provenance.release_guards, manifest.release_guards ?? []);
    const durableBrain = manifest.selected_role_profiles.brain ?? manifest.role_profiles.brain;
    assertEqual("approval model profile", record.provenance.model_profile, durableBrain);

    const convergence = await readOptionalValidatedArtifact(runDir, convergenceSummary.path, convergenceReportSchema);
    if (!convergence
      || convergence.work_item_id !== sourceWorkItemId
      || convergence.plan_revision !== baseRevision
      || convergence.review_revision !== convergenceSummary.review_revision
      || convergence.recommended_action !== "create_replan") {
      throw new Error("Replan approval convergence report does not match durable provenance");
    }
    assertEqual("approval convergence findings", convergence.unresolved_finding_ids, record.patch.unresolved_finding_ids);
    assertEqual("approval evidence paths", convergence.evidence_refs, record.provenance.evidence_paths);
    if (alreadyApplied) {
      await verifyCompletedReplanReviewEffect({
        runDir,
        manifest,
        sourceWorkItemId,
        targetWorkItemId: workItemId,
        patchPath,
        convergence,
        approvedHistory,
        record,
      });
    }

    const progress = manifest.work_item_progress[workItemId];
    if (!progress) throw new Error("Replan approval concrete target progress is missing");
    const expectedPatchPointer = sourceProgress.replan_patch_path;
    if (!alreadyApplied && expectedPatchPointer !== patchPath) {
      throw new Error("Replan approval pending patch pointer does not match the immutable patch");
    }
    const decision = !alreadyApplied
      ? await readOptionalValidatedArtifact(runDir, String(sourceProgress.review_cycle_path ?? ""), reviewCycleStateSchema)
      : null;
    if (!alreadyApplied && (
      !decision
      || decision.work_item_id !== sourceWorkItemId
      || decision.effect_id !== sourceProgress.review_effect_id
      || decision.review_revision !== convergence.review_revision
      || decision.decision.action !== "create_replan"
      || canonical(decision.decision.finding_ids) !== canonical(convergence.unresolved_finding_ids)
    )) throw new Error("Replan approval review effect provenance does not match");
    let completed: ReviewCycleState | null = null;
    if (!alreadyApplied && decision) {
      completed = await readOptionalValidatedArtifact(runDir, completionPath(decision.effect_id), reviewCycleStateSchema);
      if (!completed
        || completed.effect_state !== "complete"
        || completed.effect_id !== decision.effect_id
        || completed.work_item_id !== decision.work_item_id
        || completed.review_revision !== decision.review_revision
        || completed.decision_path !== decision.decision_path
        || canonical(completed.decision) !== canonical(decision.decision)
        || canonical(completed.finding_ids) !== canonical(decision.finding_ids)
        || canonical(completed.accounting_before) !== canonical(decision.accounting_before)
        || (completed.effect_result as { replan_patch_path?: unknown; target_work_item_id?: unknown } | undefined)?.replan_patch_path !== patchPath
        || (sourceWorkItemId !== workItemId
          && (completed.effect_result as { target_work_item_id?: unknown } | undefined)?.target_work_item_id !== workItemId)) {
        throw new Error("Replan approval effect is not immutably complete for the exact patch");
      }
      await validateActiveReplanPatch(
        runDir,
        manifest,
        sourceWorkItemId,
        patchPath,
        decision,
        completed,
      );
    }

    if (baseRecord.revision !== baseRevision) {
      throw new Error("Replan approval base plan record does not match the approved revision");
    }
    if (!alreadyApplied
      && manifest.work_item_progress[workItemId]?.status === "complete"
      && sourceWorkItemId !== "integrated") {
      throw new Error("Replan approval cannot change a completed target work item");
    }
    const durableCriteria = baseRecord.acceptance_criteria?.[workItemId];
    if (!durableCriteria?.length || canonical(record.provenance.criterion_refs) !== canonical(durableCriteria.map(({ ref }) => ref))) {
      throw new Error("Replan approval criterion provenance does not match the base plan");
    }
    const criterionChanges = new Map(record.patch.added_or_changed_criteria.map(({ ref, text }) => [ref, text]));
    if (criterionChanges.size !== record.patch.added_or_changed_criteria.length
      || [...criterionChanges.keys()].some((ref) => !durableCriteria.some((criterion) => criterion.ref === ref))) {
      throw new Error("Replan approval criterion patch is not an exact target subset");
    }
    const expectedCriteria = durableCriteria.map((criterion) => ({
      ...criterion,
      text: criterionChanges.get(criterion.ref) ?? criterion.text,
    }));
    if (canonical(proposedRecord.acceptance_criteria?.[workItemId]) !== canonical(expectedCriteria)) {
      throw new Error("Prepared replan revision criterion metadata does not match the immutable patch");
    }
    const verifiedBase = await loadVerifiedPlanBundle(runDir, manifest, baseRevision);
    const reconstructed = materializeReplanCandidate({
      basePlan: verifiedBase.plan,
      targetWorkItemId: workItemId,
      patch: record.patch,
      durableCriteria,
      workflowProtocol: manifest.workflow_protocol,
      materializationVersion: record.materialization_version ?? 1,
    });
    const reconstructedSha256 = createHash("sha256")
      .update(serializePersistedPlan(reconstructed, manifest.workflow_protocol), "utf8")
      .digest("hex");
    if (reconstructedSha256 !== proposedRecord.sha256) {
      throw new Error("Replan approval immutable patch does not reconstruct the approved plan");
    }
    const nextProgress = alreadyApplied
      ? progress
      : resetTargetProgress(progress, planRevision, workItemId, patchPath);
    const nextSourceProgress = alreadyApplied || sourceWorkItemId === workItemId
      ? undefined
      : archiveSourceProgress(sourceProgress, workItemId, planRevision, patchPath);
    if (alreadyApplied) {
      let replayManifest = manifest;
      if (replayManifest.recovery.active_scope !== null) {
        replayManifest = await transaction.updateManifestV2({
          recovery: {
            ...replayManifest.recovery,
            active_scope: null,
          },
        });
      }
      const replayProgress = manifest.work_item_progress[workItemId]!;
      const replayHistory = Array.isArray(replayProgress.approved_replan_history)
        ? replayProgress.approved_replan_history
        : [];
      const hasReplayHistory = replayHistory.some((entry) =>
        entry.target_work_item_id === workItemId
        && entry.plan_revision === planRevision
        && entry.replan_patch_path === patchPath);
      if (sourceWorkItemId === workItemId && !hasReplayHistory) {
        const historicalDecision = await readOptionalValidatedArtifact(
          runDir,
          reviewDecisionPath(sourceWorkItemId, convergence.review_revision),
          reviewCycleStateSchema,
        );
        if (!historicalDecision
          || historicalDecision.work_item_id !== sourceWorkItemId
          || historicalDecision.review_revision !== convergence.review_revision
          || historicalDecision.decision.action !== "create_replan") {
          throw new Error("Completed direct replan is missing its historical review lineage");
        }
        const repairedProgress = {
          ...replayProgress,
          approved_replan_history: [...replayHistory, {
            target_work_item_id: workItemId,
            plan_revision: planRevision,
            replan_patch_path: patchPath,
            review_revision: historicalDecision.review_revision,
            review_cycle_path: historicalDecision.decision_path,
            review_effect_id: historicalDecision.effect_id,
            review_path: historicalDecision.work_item_progress_reference?.review_path,
            verification_path: historicalDecision.work_item_progress_reference?.verification_path,
          }],
          last_approved_replan_target_work_item_id: workItemId,
          last_approved_replan_revision: planRevision,
          last_approved_replan_patch_path: patchPath,
        };
        replayManifest = await transaction.updateManifestV2({
          work_item_progress: {
            ...manifest.work_item_progress,
            [workItemId]: repairedProgress,
          },
        });
      }
      await reconcileCompletedReplanEvents({
        runDir: transaction.runDir,
        manifest: replayManifest,
        verifiedApproval,
        workItemId,
        baseRevision,
        planRevision,
        planSha256: proposedRecord.sha256,
        patchPath,
        eventIoHooks: options.eventIoHooks,
      });
      return replayManifest;
    }
    const approved = await transaction.approveReplanRevision({
      base_revision: baseRevision,
      revision: planRevision,
      work_item_id: workItemId,
      expected_progress: progress,
      next_progress: nextProgress,
      ...(nextSourceProgress ? {
        source_work_item_id: sourceWorkItemId,
        expected_source_progress: sourceProgress,
        next_source_progress: nextSourceProgress,
      } : {}),
      plan_revisions: manifest.plan_revisions,
    });
    if (!alreadyApplied) await options.transactionHooks?.afterPlanApprovalManifestPersisted?.();
    await appendPlanApprovalEvent(
      transaction.runDir,
      approved,
      "human",
      planRevision,
      proposedRecord.sha256,
      verifiedApproval,
    );
    await appendApprovedResetEvent(
      runDir,
      approved,
      workItemId,
      baseRevision,
      planRevision,
      patchPath,
      options.eventIoHooks,
    );
    return approved;
  }, options.transactionHooks);
}

/** Continue a durably promoted material replan without replaying its mutation. */
export async function continueApprovedReplanRevision(
  runDir: string,
  planRevision: number,
  options: {
    approvalControllerCapture?: ApprovalControllerCapture;
    verifyCurrentController?: boolean;
    eventIoHooks?: ReplanEventIoHooks;
  } = {},
): Promise<RunManifestV2Ledger> {
  const manifest = await readManifestV2(runDir);
  const approvedRecord = manifest.plan_revisions[String(planRevision)];
  const approvedBaseRevision = approvedRecord?.origin === "replan" ? approvedRecord.base_revision : null;
  const resetEvent = await readApprovedResetEvent(
    runDir,
    manifest,
    planRevision,
    options.eventIoHooks?.resetRead,
  );
  const candidates = new Set<string>();
  if (resetEvent !== null) {
    candidates.add(resetEvent.workItemId);
  } else {
    for (const [sourceWorkItemId, progress] of Object.entries(manifest.work_item_progress)) {
      if (progress.last_approved_replan_revision === planRevision
        && typeof progress.last_approved_replan_target_work_item_id === "string") {
        candidates.add(progress.last_approved_replan_target_work_item_id);
      }
      const convergence = manifest.convergence_reports?.[sourceWorkItemId];
      if (progress.plan_revision === planRevision
        && convergence?.plan_revision === approvedBaseRevision
        && convergence?.recommended_action === "create_replan") {
        candidates.add(sourceWorkItemId);
      }
    }
  }
  if (candidates.size !== 1) {
    throw new Error("Completed replan approval must resolve exactly one durable promotion target");
  }
  return approvePreparedReplanRevision(runDir, [...candidates][0]!, planRevision, {
    approvalControllerCapture: options.approvalControllerCapture,
    verifyCurrentController: options.verifyCurrentController,
    completedReplay: true,
    eventIoHooks: options.eventIoHooks,
  });
}
