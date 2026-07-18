import { createHash } from "node:crypto";
import { z } from "zod";
import {
  artifactRefFromBytes,
  artifactSegment,
  artifactRefV1Schema,
  type ArtifactRefV1,
  type WorkItemSummaryV1,
  workItemSummaryV1Schema,
} from "../core/context-contracts.js";
import {
  readManifestV2,
  readOptionalValidatedArtifact,
  readReferencedJson,
  readVerifiedPlanRevision,
  writeImmutableValidatedJson,
} from "../core/ledger.js";
import {
  executionSpecV2Schema,
  implementationResultSchema,
  persistedVerifierReviewSchema,
  reviewCycleStateSchema,
  verificationEvidenceSchema,
  verificationExecutionResultSchema,
  warningContinuationAuthorizationSchema,
} from "../core/schema.js";
import type {
  ImplementationResult,
  ReviewCycleState,
  RunManifestV2,
  VerificationEvidence,
  VerifierReview,
  WorkItem,
  WorkItemProgress,
} from "../core/types.js";
import { validatePersistedWarningAuthorization, warningAuthorizationPath } from "./authorization.js";
import { loadCurrentFindingResolution } from "./findings.js";
import { readOwnedEvidenceFile } from "./owned-evidence.js";
import {
  loadPolicyCommitResult,
  requireCompletedAdvanceEffect,
  reviewDecisionPath,
} from "./review-cycle.js";

const persistedImplementationResultSchema = z.preprocess((value) => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const raw = value as Record<string, unknown>;
  if (raw.completed_steps !== undefined && raw.remaining_risks !== undefined) return value;
  const asStrings = (entry: unknown): string[] => Array.isArray(entry)
    ? entry.filter((part): part is string => typeof part === "string")
    : [];
  const asCommands = (entry: unknown): readonly string[][] => Array.isArray(entry)
    ? entry.flatMap((command) => Array.isArray(command)
      ? [command.filter((part): part is string => typeof part === "string")]
      : typeof command === "string" ? [[command]] : [])
    : [];
  const summary = typeof raw.summary === "string" && raw.summary.length > 0 ? [raw.summary] : [];
  return {
    ...raw,
    changed_files: asStrings(raw.changed_files),
    tests_added_or_changed: asStrings(raw.tests_added_or_changed),
    commands_attempted: asCommands(raw.commands_attempted),
    completed_steps: asStrings(raw.completed_steps).length > 0 ? asStrings(raw.completed_steps) : summary,
    remaining_risks: asStrings(raw.remaining_risks ?? raw.known_limitations),
  };
}, implementationResultSchema);

export type WorkItemCompletionBasis = WorkItemSummaryV1["completion_basis"];

export interface PersistWorkItemSummaryInput {
  runDir: string;
  workItem: WorkItem;
  planRevision: number;
  planSha256: string;
  attempt: number;
  baseCommit: string;
  commitSha: string;
  completionBasis: WorkItemCompletionBasis;
  implementationRef: ArtifactRefV1;
  verificationRef: ArtifactRefV1;
  reviewRef: ArtifactRefV1;
  policyDecisionRef: ArtifactRefV1 | null;
  findingRevision: {
    reviewRevision: number;
    findingIds: string[];
  };
  createdAt: string;
}

export interface LoadWorkItemSummaryExpected {
  runId: string;
  workItemId: string;
  planRevision: number;
  planSha256: string;
  attempt: number;
  baseCommit: string;
  commitSha: string;
}

interface SummarySources {
  implementation: ImplementationResult;
  verification: VerificationEvidence;
  review: VerifierReview;
}

interface WarningValidationInput {
  runDir: string;
  workItemId: string;
  reviewRef: ArtifactRefV1;
  verificationRef: ArtifactRefV1;
}

interface CurrentSourceAuthorityInput {
  workItemId: string;
  planRevision: number;
  attempt: number;
  baseCommit: string;
  commitSha: string;
  implementationRef: ArtifactRefV1;
  verificationRef: ArtifactRefV1;
  reviewRef: ArtifactRefV1;
  reviewRevision?: number;
}

interface PolicyAuthorityInput extends CurrentSourceAuthorityInput {
  runDir: string;
  completionBasis: WorkItemCompletionBasis;
  policyDecisionRef: ArtifactRefV1 | null;
  findingIds: string[];
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function equalJson(actual: unknown, expected: unknown): boolean {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function assertEqual(label: string, actual: unknown, expected: unknown): void {
  if (!equalJson(actual, expected)) {
    throw new Error(`Work-item summary ${label} does not match controller provenance`);
  }
}

function policyHash(policy: unknown): string {
  return createHash("sha256").update(JSON.stringify(policy)).digest("hex");
}

export function assertApprovedAcceptanceCoverage(
  requiredAcceptanceIds: readonly string[],
  approvedAcceptanceIds: readonly string[],
): void {
  if (!equalJson(sortedUnique(requiredAcceptanceIds), sortedUnique(approvedAcceptanceIds))) {
    throw new Error("Verifier approval does not cover required acceptance IDs");
  }
}

export function workItemSummaryPath(id: string, revision: number, attempt: number): string {
  return `summaries/work-items/${artifactSegment(id)}/plan-${revision}/attempt-${attempt}.json`;
}

function approvedWorkItemFromPlan(planText: string, workItemId: string): WorkItem {
  let plan: unknown;
  try {
    plan = JSON.parse(planText);
  } catch {
    throw new Error("Work-item summary requires a structured approved plan");
  }
  const rawItems = plan && typeof plan === "object" && !Array.isArray(plan)
    ? (plan as { work_items?: unknown }).work_items
    : undefined;
  if (!Array.isArray(rawItems)) throw new Error("Work-item summary approved plan has no work items");
  const matching = rawItems.filter((candidate) =>
    candidate && typeof candidate === "object" && !Array.isArray(candidate)
    && (candidate as { id?: unknown }).id === workItemId);
  if (matching.length !== 1) throw new Error("Work-item summary work item is not unique in the approved plan");
  return executionSpecV2Schema.parse(matching[0]);
}

async function validateApprovedPlan(
  input: Pick<PersistWorkItemSummaryInput, "runDir" | "workItem" | "planRevision" | "planSha256">,
): Promise<{ runId: string; manifest: RunManifestV2; workItem: WorkItem }> {
  const manifest = await readManifestV2(input.runDir);
  const approvedRevision = manifest.approved_revision ?? manifest.approved_plan_revision;
  if (approvedRevision !== input.planRevision) {
    throw new Error("Work-item summary plan revision does not match the approved plan");
  }
  const recorded = manifest.plan_revisions[String(input.planRevision)];
  if (!recorded || recorded.sha256 !== input.planSha256) {
    throw new Error("Work-item summary approved plan hash does not match the run ledger");
  }
  const planText = await readVerifiedPlanRevision(input.runDir, manifest, input.planRevision);
  const approvedWorkItem = approvedWorkItemFromPlan(planText, input.workItem.id);
  const suppliedWorkItem = executionSpecV2Schema.parse(input.workItem);
  if (!equalJson(approvedWorkItem, suppliedWorkItem)) {
    throw new Error("Work-item summary work item does not match the approved plan");
  }
  return { runId: manifest.run_id, manifest, workItem: approvedWorkItem };
}

function validateCurrentSourceAuthority(
  manifest: RunManifestV2,
  input: CurrentSourceAuthorityInput,
): WorkItemProgress {
  const progress = manifest.work_item_progress[input.workItemId];
  if (!progress) throw new Error("Work-item summary has no current durable work-item authority");
  if (progress.status !== "in_progress" && progress.status !== "complete") {
    throw new Error("Work-item summary current authority is not active or complete");
  }
  if (progress.attempts !== input.attempt) {
    throw new Error("Work-item summary attempt does not match current authority");
  }
  if (progress.context_base_commit !== input.baseCommit) {
    throw new Error("Work-item summary base commit does not match current authority");
  }
  if (progress.context_plan_revision !== input.planRevision) {
    throw new Error("Work-item summary context plan revision does not match current authority");
  }
  if (progress.implementation_path !== input.implementationRef.path) {
    throw new Error("Work-item summary implementation reference does not match current authority");
  }
  if (progress.verification_path !== input.verificationRef.path) {
    throw new Error("Work-item summary verification reference does not match current authority");
  }
  if (progress.review_path !== input.reviewRef.path) {
    throw new Error("Work-item summary review reference does not match current authority");
  }
  if (progress.commit_sha !== input.commitSha) {
    throw new Error("Work-item summary commit provenance does not match current authority");
  }
  if (!Number.isInteger(progress.review_revision) || (input.reviewRevision !== undefined
    && progress.review_revision !== input.reviewRevision)) {
    throw new Error("Work-item summary finding revision does not match the current durable review revision");
  }
  return progress;
}

async function loadSources(
  runDir: string,
  implementationRef: ArtifactRefV1,
  verificationRef: ArtifactRefV1,
  reviewRef: ArtifactRefV1,
  expected: { workItemId: string; attempt: number },
): Promise<SummarySources> {
  const implementation = await readReferencedJson(
    runDir,
    artifactRefV1Schema.parse(implementationRef),
    persistedImplementationResultSchema,
  );
  const verification = await readReferencedJson(
    runDir,
    artifactRefV1Schema.parse(verificationRef),
    verificationEvidenceSchema,
  );
  const review = await readReferencedJson(
    runDir,
    artifactRefV1Schema.parse(reviewRef),
    persistedVerifierReviewSchema,
  );
  if (implementation.work_item_id !== expected.workItemId) {
    throw new Error("Implementation result work item does not match summary provenance");
  }
  if (verification.work_item_id !== expected.workItemId || review.work_item_id !== expected.workItemId) {
    throw new Error("Verification or review work item does not match summary provenance");
  }
  if (verification.attempt !== expected.attempt || review.attempt !== expected.attempt) {
    throw new Error("Verification or review attempt does not match summary provenance");
  }
  if (verification.evidence_path !== verificationRef.path) {
    throw new Error("Verification evidence path does not match its artifact reference");
  }
  if (!review.evidence_reviewed.includes(verificationRef.path)) {
    throw new Error("Verifier review does not bind the referenced verification evidence");
  }
  return { implementation, verification, review };
}

async function commandEvidence(
  runDir: string,
  workItem: WorkItem,
  verification: VerificationEvidence,
): Promise<WorkItemSummaryV1["command_evidence"]> {
  if (workItem.verification_commands.length !== verification.commands.length) {
    throw new Error("Work-item verification command count does not match approved commands");
  }
  return Promise.all(workItem.verification_commands.map(async (spec, index) => {
    const result = verification.commands[index]!;
    if (!result.argv || !equalJson(result.argv, spec.argv)) {
      throw new Error(`Verification command ${spec.id} argv does not match the approved command`);
    }
    if (!result.result_path) {
      throw new Error(`Verification command ${spec.id} is missing its result path`);
    }
    const bytes = await readOwnedEvidenceFile(runDir, result.result_path, "verification/");
    const execution = verificationExecutionResultSchema.parse(JSON.parse(bytes.toString("utf8")));
    assertEqual(`command ${spec.id} argv`, execution.argv, spec.argv);
    assertEqual(`command ${spec.id} exit code`, execution.exit_code, result.exit_code);
    assertEqual(`command ${spec.id} timeout`, execution.timed_out, result.timed_out);
    assertEqual(`command ${spec.id} error code`, execution.error_code, result.error_code);
    assertEqual(`command ${spec.id} error message`, execution.error_message, result.error_message);
    assertEqual(`command ${spec.id} signal`, execution.signal, result.signal);
    return {
      command_id: spec.id,
      argv: [...spec.argv],
      exit_code: result.exit_code,
      timed_out: result.timed_out,
      result_ref: artifactRefFromBytes(result.result_path, bytes),
    };
  }));
}

function assertPolicyCycle(
  cycle: ReviewCycleState,
  input: PolicyAuthorityInput,
  progress: WorkItemProgress,
  policy: unknown,
): void {
  if (cycle.decision_path !== input.policyDecisionRef?.path) {
    throw new Error("Policy decision path does not match its artifact reference");
  }
  if (cycle.decision_path !== reviewDecisionPath(input.workItemId, cycle.review_revision)) {
    throw new Error("Policy decision is not at the canonical current review-cycle path");
  }
  if (
    progress.review_cycle_path !== cycle.decision_path
    || progress.review_effect_id !== cycle.effect_id
  ) throw new Error("Policy decision is not the current review cycle authority");
  if (cycle.work_item_id !== input.workItemId || cycle.phase !== "work_item") {
    throw new Error("Policy decision work-item provenance does not match the summary");
  }
  if (cycle.review_revision !== input.reviewRevision) {
    throw new Error("Policy decision finding revision does not match the summary");
  }
  if (cycle.accounting_before.plan_revision !== input.planRevision || cycle.policy_hash !== policyHash(policy)) {
    throw new Error("Policy decision plan or policy provenance does not match the run ledger");
  }
  const reference = cycle.work_item_progress_reference;
  if (
    !reference
    || reference.attempts !== input.attempt
    || reference.review_path !== input.reviewRef.path
    || reference.verification_path !== input.verificationRef.path
  ) throw new Error("Policy decision evidence provenance does not match the summary");
  assertEqual(
    "policy finding IDs",
    sortedUnique(cycle.finding_ids),
    sortedUnique(input.findingIds),
  );
}

async function loadPolicyDecision(
  input: PolicyAuthorityInput,
  expectedAction: "advance" | "continue_with_warning",
): Promise<ReviewCycleState> {
  if (input.policyDecisionRef === null) {
    throw new Error(`${input.completionBasis} requires a policy decision artifact`);
  }
  const manifest = await readManifestV2(input.runDir);
  if (!manifest.review_policy_snapshot) throw new Error("Policy completion requires a snapshotted review policy");
  const progress = validateCurrentSourceAuthority(manifest, input);
  const cycle = await readReferencedJson(
    input.runDir,
    input.policyDecisionRef,
    reviewCycleStateSchema,
  );
  assertPolicyCycle(cycle, input, progress, manifest.review_policy_snapshot);
  if (cycle.decision.action !== expectedAction) {
    throw new Error(`Policy decision must authorize ${expectedAction}`);
  }
  const completion = await requireCompletedAdvanceEffect({
    run_dir: input.runDir,
    cycle,
    owner: `runtime:work-item:${input.workItemId}`,
  });
  const completedCommit = completion.commit_sha === "policy-authorized"
    ? await loadPolicyCommitResult(input.runDir, cycle)
    : completion.commit_sha;
  if (completedCommit === null || completedCommit !== input.commitSha) {
    throw new Error("Policy advance effect commit provenance does not match the summary");
  }
  return cycle;
}

async function validateWarningAuthorization(
  input: WarningValidationInput,
  cycle: ReviewCycleState,
  findings: Awaited<ReturnType<typeof loadCurrentFindingResolution>>["findings"],
): Promise<void> {
  const manifest = await readManifestV2(input.runDir);
  const policy = manifest.review_policy_snapshot;
  if (!policy) throw new Error("Warning continuation requires a snapshotted review policy");
  const authorization = await readOptionalValidatedArtifact(
    input.runDir,
    warningAuthorizationPath(input.workItemId, cycle.review_revision),
    warningContinuationAuthorizationSchema,
  );
  if (!authorization) throw new Error("Warning continuation requires an authorization artifact");
  await validatePersistedWarningAuthorization({
    run_dir: input.runDir,
    work_item_id: input.workItemId,
    review_revision: cycle.review_revision,
    policy,
    findings,
    evidence_snapshot: sortedUnique([
      input.reviewRef.path,
      input.verificationRef.path,
      ...findings.flatMap((finding) => finding.evidence_refs),
    ]),
    authorization,
  });
}

export async function persistWorkItemSummary(
  input: PersistWorkItemSummaryInput,
): Promise<ArtifactRefV1> {
  const workItem = executionSpecV2Schema.parse(input.workItem);
  const { runId, manifest } = await validateApprovedPlan({ ...input, workItem });
  const currentAuthority: CurrentSourceAuthorityInput = {
    workItemId: workItem.id,
    planRevision: input.planRevision,
    attempt: input.attempt,
    baseCommit: input.baseCommit,
    commitSha: input.commitSha,
    implementationRef: input.implementationRef,
    verificationRef: input.verificationRef,
    reviewRef: input.reviewRef,
    reviewRevision: input.findingRevision.reviewRevision,
  };
  const progress = validateCurrentSourceAuthority(manifest, currentAuthority);
  const sources = await loadSources(
    input.runDir,
    input.implementationRef,
    input.verificationRef,
    input.reviewRef,
    { workItemId: workItem.id, attempt: input.attempt },
  );
  const findings = await loadCurrentFindingResolution(
    input.runDir,
    workItem.id,
    input.findingRevision.reviewRevision,
    input.findingRevision.findingIds,
  );
  const policyAuthority: PolicyAuthorityInput = {
    ...currentAuthority,
    runDir: input.runDir,
    completionBasis: input.completionBasis,
    policyDecisionRef: input.policyDecisionRef,
    findingIds: input.findingRevision.findingIds,
  };
  let policyDecisionRef: ArtifactRefV1 | null = null;
  if (input.completionBasis === "verifier_approve") {
    if (input.policyDecisionRef !== null) {
      throw new Error("Direct Verifier approval cannot include a policy decision artifact");
    }
    if (sources.review.decision !== "approve") {
      throw new Error("Verifier approval requires an approving review");
    }
    if (progress.review_cycle_path !== undefined || progress.review_effect_id !== undefined) {
      throw new Error("Direct Verifier approval cannot replace current policy-cycle authority");
    }
    assertApprovedAcceptanceCoverage(
      workItem.completion_contract.required_acceptance_ids,
      sources.review.acceptance_coverage,
    );
    if (findings.unresolved_finding_ids.length > 0) {
      throw new Error("Verifier approval cannot retain unresolved findings");
    }
  } else if (input.completionBasis === "policy_advance") {
    await loadPolicyDecision(policyAuthority, "advance");
    policyDecisionRef = input.policyDecisionRef;
  } else {
    const cycle = await loadPolicyDecision(policyAuthority, "continue_with_warning");
    await validateWarningAuthorization({
      runDir: input.runDir,
      workItemId: workItem.id,
      reviewRef: input.reviewRef,
      verificationRef: input.verificationRef,
    }, cycle, findings.findings);
    policyDecisionRef = input.policyDecisionRef;
  }
  const summary = workItemSummaryV1Schema.parse({
    schema_version: 1,
    run_id: runId,
    work_item_id: workItem.id,
    plan_revision: input.planRevision,
    plan_sha256: input.planSha256,
    attempt: input.attempt,
    base_commit: input.baseCommit,
    commit_sha: input.commitSha,
    completion_basis: input.completionBasis,
    implementation_ref: input.implementationRef,
    verification_ref: input.verificationRef,
    review_ref: input.reviewRef,
    policy_decision_ref: policyDecisionRef,
    changed_files: sortedUnique(sources.implementation.changed_files),
    acceptance_ids: sortedUnique(sources.review.acceptance_coverage),
    command_evidence: await commandEvidence(input.runDir, workItem, sources.verification),
    resolved_finding_ids: findings.resolved_finding_ids,
    unresolved_finding_ids: findings.unresolved_finding_ids,
    residual_risks: sortedUnique([
      ...sources.implementation.remaining_risks,
      ...sources.review.residual_risks,
    ]),
    created_at: input.createdAt,
  });
  return writeImmutableValidatedJson(
    input.runDir,
    workItemSummaryPath(workItem.id, input.planRevision, input.attempt),
    workItemSummaryV1Schema,
    summary,
  );
}

function assertExpected(summary: WorkItemSummaryV1, expected: LoadWorkItemSummaryExpected): void {
  const fields: Array<[string, unknown, unknown]> = [
    ["run ID", summary.run_id, expected.runId],
    ["work-item ID", summary.work_item_id, expected.workItemId],
    ["plan revision", summary.plan_revision, expected.planRevision],
    ["plan hash", summary.plan_sha256, expected.planSha256],
    ["attempt", summary.attempt, expected.attempt],
    ["base commit", summary.base_commit, expected.baseCommit],
    ["commit SHA", summary.commit_sha, expected.commitSha],
  ];
  for (const [label, actual, wanted] of fields) assertEqual(label, actual, wanted);
}

export async function loadWorkItemSummary(
  runDir: string,
  ref: ArtifactRefV1,
  expected: LoadWorkItemSummaryExpected,
): Promise<WorkItemSummaryV1> {
  const summary = await readReferencedJson(runDir, ref, workItemSummaryV1Schema);
  assertExpected(summary, expected);
  if (ref.path !== workItemSummaryPath(summary.work_item_id, summary.plan_revision, summary.attempt)) {
    throw new Error("Work-item summary path does not match its identity");
  }
  const manifest = await readManifestV2(runDir);
  if (manifest.run_id !== summary.run_id) throw new Error("Work-item summary run ID does not match the run ledger");
  const recordedPlan = manifest.plan_revisions[String(summary.plan_revision)];
  if (!recordedPlan || recordedPlan.sha256 !== summary.plan_sha256) {
    throw new Error("Work-item summary plan hash does not match the run ledger");
  }
  const planText = await readVerifiedPlanRevision(runDir, manifest, summary.plan_revision);
  const workItem = approvedWorkItemFromPlan(planText, summary.work_item_id);
  const currentAuthority: CurrentSourceAuthorityInput = {
    workItemId: summary.work_item_id,
    planRevision: summary.plan_revision,
    attempt: summary.attempt,
    baseCommit: summary.base_commit,
    commitSha: summary.commit_sha,
    implementationRef: summary.implementation_ref,
    verificationRef: summary.verification_ref,
    reviewRef: summary.review_ref,
  };
  const progress = validateCurrentSourceAuthority(manifest, currentAuthority);
  const sources = await loadSources(
    runDir,
    summary.implementation_ref,
    summary.verification_ref,
    summary.review_ref,
    { workItemId: summary.work_item_id, attempt: summary.attempt },
  );
  assertEqual("changed files", summary.changed_files, sortedUnique(sources.implementation.changed_files));
  assertEqual("acceptance IDs", summary.acceptance_ids, sortedUnique(sources.review.acceptance_coverage));
  assertEqual("residual risks", summary.residual_risks, sortedUnique([
    ...sources.implementation.remaining_risks,
    ...sources.review.residual_risks,
  ]));
  if (summary.command_evidence.length !== sources.verification.commands.length) {
    throw new Error("Work-item summary command count does not match verification evidence");
  }
  for (const [index, command] of summary.command_evidence.entries()) {
    const resultPath = sources.verification.commands[index]!.result_path;
    if (command.result_ref.path !== resultPath) {
      throw new Error(`Work-item summary command ${command.command_id} result reference path does not match verification`);
    }
    await readReferencedJson(runDir, command.result_ref, verificationExecutionResultSchema);
  }
  const expectedCommandEvidence = await commandEvidence(runDir, workItem, sources.verification);
  assertEqual("command evidence", summary.command_evidence, expectedCommandEvidence);
  const currentFindings = await loadCurrentFindingResolution(
    runDir,
    summary.work_item_id,
    progress.review_revision!,
  );
  assertEqual("resolved finding IDs", summary.resolved_finding_ids, currentFindings.resolved_finding_ids);
  assertEqual("unresolved finding IDs", summary.unresolved_finding_ids, currentFindings.unresolved_finding_ids);
  if (summary.completion_basis === "verifier_approve") {
    if (summary.policy_decision_ref !== null || sources.review.decision !== "approve") {
      throw new Error("Loaded Verifier approval summary has invalid completion authority");
    }
    if (progress.review_cycle_path !== undefined || progress.review_effect_id !== undefined) {
      throw new Error("Loaded direct Verifier approval is not the current authority");
    }
    assertApprovedAcceptanceCoverage(
      workItem.completion_contract.required_acceptance_ids,
      sources.review.acceptance_coverage,
    );
    if (currentFindings.unresolved_finding_ids.length > 0) {
      throw new Error("Loaded Verifier approval summary has unresolved findings");
    }
  } else {
    if (summary.policy_decision_ref === null) throw new Error("Loaded policy summary is missing its decision reference");
    const expectedAction = summary.completion_basis === "policy_advance" ? "advance" : "continue_with_warning";
    const cycle = await loadPolicyDecision({
      ...currentAuthority,
      runDir,
      completionBasis: summary.completion_basis,
      policyDecisionRef: summary.policy_decision_ref,
      reviewRevision: progress.review_revision,
      findingIds: currentFindings.findings.map((finding) => finding.finding_id),
    }, expectedAction);
    if (summary.completion_basis === "policy_warning_continuation") {
      await validateWarningAuthorization({
        runDir,
        workItemId: summary.work_item_id,
        verificationRef: summary.verification_ref,
        reviewRef: summary.review_ref,
      }, cycle, currentFindings.findings);
    }
  }
  return summary;
}
