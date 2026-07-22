import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  approvalSha256,
  buildPlanApprovalRequest,
  planDecisionContractSha256,
  requestSha256,
  serializePlanApprovalRequest,
} from "../../src/core/plan-approval.js";
import {
  appendRunEvent,
  appendRunEventOnce,
  approvePlanRevision,
  commitPreparedPlanApprovalBoundary,
  reconcilePreparedPlanApprovalBoundary,
  createRunLedger,
  createRunLedgerV2,
  derivePlanAcceptanceCriteria,
  readManifestV2,
  requiresPinnedRuntimeAuthority,
  recordTerminalDisposition,
  recordTerminalDispositionWithCleanup,
  recordPlan,
  readManifest,
  taskLineageId,
  transitionRun,
  updateManifestV2,
  updateReviewAccounting,
  verifyPersistedPlanApprovalSubject,
  updateManifest,
  withRunLedgerCompoundTransaction,
  writeTextArtifact,
  writeImmutableTextArtifact,
  writeImmutableValidatedJson,
  readReferencedJson,
  retryVerifierReviewAfterInvalidReplanContract,
} from "../../src/core/ledger.js";
import * as sessionStore from "../../src/progress/session-store.js";
import { sessionStateSchema } from "../../src/progress/session-events.js";
import type { PlanApprovalRequestV1 } from "../../src/core/types.js";
import { createLegacyRunLedgerV2 } from "../fixtures/legacy-run.js";
import { readTaskLineage, withTaskLineageTransaction } from "../../src/core/task-lineage.js";
import { planIssueSyncPreview, writeGithubEffectPreview } from "../../src/github/effect-plan.js";
import { defaultConfig } from "../../src/core/config.js";
import { resolveRunIntake } from "../../src/core/intake.js";
import { resolveRunConfiguration, serializeRunConfiguration } from "../../src/core/run-configuration.js";
import { buildPlanDelta } from "../../src/core/plan-delta.js";
import { serializePersistedPlan } from "../../src/core/execution-spec.js";
import { executionSpec } from "../fixtures/execution-spec.js";
import { recordAndApprovePinnedInitialPlan } from "../fixtures/pinned-plan.js";
import type { BrainPlan } from "../../src/core/types.js";

let repoRoot: string | null = null;

function recoveryScopeState(headSequence: number, headDecisionPath: string | null) {
  return {
    version: 1 as const,
    head_sequence: headSequence,
    head_decision_path: headDecisionPath,
    blocker_fingerprint: null,
    progress_subject_sha256: null,
    consecutive_without_progress: 0,
    disposition: "active" as const,
    diagnostic_path: null,
    authorization_path: null,
  };
}

afterEach(async () => {
  if (repoRoot) {
    await rm(repoRoot, { recursive: true, force: true });
    repoRoot = null;
  }
});

async function readyGithubCleanupRun() {
  repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-terminal-cleanup-"));
  const ledger = await createRunLedgerV2({
    repoRoot,
    originalRequest: "Close every lineage issue",
    mode: "github",
  });
  const manifest = await updateManifestV2(ledger.runDir, {
    stage: "verifier_review",
    delivery_state: "blocked",
  });
  const desired = (title: string, reason_code: string) => ({
    title,
    body: `${title}\n`,
    labels: ["brain-hands"],
    state: "OPEN" as const,
    state_reason: null,
    reason_code,
  });
  const preview = planIssueSyncPreview({
    revision: 1,
    lineage_id: manifest.task_lineage_id!,
    run_id: manifest.run_id,
    repository: { host: "github.com", name_with_owner: "acme/repo" },
    plan_revision: 1,
    plan_sha256: "a".repeat(64),
    created_at: "2026-07-17T11:00:00.000Z",
    lineage_state: "active",
    issue_set: {
      state: "uninitialized",
      plan_revision: null,
      plan_sha256: null,
      parent_issue_number: null,
      work_item_issue_map: {},
      has_prior_owned_state: false,
    },
    approved_replan: false,
    parent: { feature_slug: "cleanup", desired: desired("Parent", "approved-plan-parent"), observations: [] },
    work_items: [
      { work_item_id: "first", desired: desired("First", "approved-plan-work-item"), observations: [] },
      { work_item_id: "second", desired: desired("Second", "approved-plan-work-item"), observations: [] },
    ],
  });
  const written = await writeGithubEffectPreview({ run_dir: ledger.runDir, preview });
  const reference = { ...written, state: "applied" as const };
  const numbers = new Map(["parent", "work_item:first", "work_item:second"].map((key, index) => [key, [9, 27, 14][index]!]));
  await withTaskLineageTransaction({
    repoRoot,
    lineageId: manifest.task_lineage_id!,
    operation: (transaction) => {
      const current = transaction.read();
      return transaction.update({
        ...current,
        repository_key: "github.com/acme/repo",
        issue_set: {
          ...current.issue_set,
          state: "ready",
          plan_revision: 1,
          plan_sha256: "a".repeat(64),
          parent_issue_number: 9,
          work_item_issue_map: { first: 27, second: 14 },
          preview: reference,
          operations: Object.fromEntries(preview.effects.map((effect) => {
            if (effect.target.kind !== "parent" && effect.target.kind !== "work_item") {
              throw new Error("Issue preview fixture contains a delivery effect");
            }
            const key = effect.target.kind === "parent" ? "parent" : `work_item:${effect.target.work_item_id}`;
            return [effect.effect_id, {
              operation_id: effect.effect_id,
              target_key: key,
              desired_sha256: effect.desired_sha256,
              state: "complete" as const,
              issue_number: numbers.get(key)!,
              created_by_run_id: manifest.run_id,
            }];
          })),
        },
      });
    },
  });
  await updateManifestV2(ledger.runDir, {
    issue_numbers: [27, 14],
    work_item_issue_map: { first: 27, second: 14 },
    github_ids: {
      ...manifest.github_ids,
      issue_numbers: [27, 14],
      work_item_issue_map: { first: 27, second: 14 },
      parent_issue_number: 9,
    },
    github_effects: { ...manifest.github_effects, issue_sync: reference },
  });
  return {
    ledger,
    manifest: await readManifestV2(ledger.runDir),
    lineage: await readTaskLineage(repoRoot, manifest.task_lineage_id!),
  };
}

async function preparedBoundaryFixture() {
  repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-ledger-prepared-replan-"));
  const ledger = await createLegacyRunLedgerV2({ repoRoot, originalRequest: "Prepare a replan boundary" });
  const base = await recordPlan(ledger.runDir, "{}\n");
  await approvePlanRevision(ledger.runDir, base.revision, { actor: "human" });
  await updateManifestV2(ledger.runDir, { stage: "replanning" });
  const expectedManifest = await readManifestV2(ledger.runDir);
  const planBytes = "candidate\n";
  const planSha256 = createHash("sha256").update(planBytes).digest("hex");
  const decisionContractSha256 = "b".repeat(64);
  const subject = {
    schema_version: 1 as const,
    gate: "plan" as const,
    reason_code: "material_replan" as const,
    run_id: ledger.runId,
    plan_revision: 2,
    base_plan_revision: 1,
    plan_sha256: planSha256,
    prerequisite_subject_sha256: "1".repeat(64),
    execution_context_sha256: "2".repeat(64),
    authority_contract_sha256: "3".repeat(64),
    decision_contract_sha256: decisionContractSha256,
  };
  const request: PlanApprovalRequestV1 = {
    schema_version: 1 as const,
    subject,
    approval_subject_sha256: approvalSha256(subject),
    plan_path: "plans/revision-2.md",
    delta: {
      schema_version: 1 as const,
      base_revision: 1,
      proposed_revision: 2,
      entries: [],
      unchanged_high_impact_categories: ["risks", "external_effects", "destructive_actions"],
    },
    additional_approvals_expected: "only_if_material_replan" as const,
  };
  const requestBytes = serializePlanApprovalRequest(request);
  const revision = {
    revision: 2,
    path: request.plan_path,
    sha256: planSha256,
    origin: "replan" as const,
    base_revision: 1,
    approval_request_path: "approvals/plan/revision-2.json",
    approval_request_sha256: requestSha256(request),
    approval_subject_sha256: request.approval_subject_sha256,
    decision_contract_sha256: decisionContractSha256,
  };
  const pending = {
    schema_version: 1 as const,
    proposed_revision: 2,
    base_revision: 1,
    request_path: revision.approval_request_path,
    request_sha256: revision.approval_request_sha256,
    approval_subject_sha256: revision.approval_subject_sha256,
  };
  const runConfigurationSha256 = "c".repeat(64);
  const writePlan = () => writeFile(join(ledger.runDir, revision.path), planBytes);
  const writeRequest = async (bytes = requestBytes) => {
    await mkdir(join(ledger.runDir, "approvals/plan"), { recursive: true });
    await writeFile(join(ledger.runDir, pending.request_path), bytes);
  };
  const commit = (overrides: Record<string, unknown> = {}) => commitPreparedPlanApprovalBoundary({
    runDir: ledger.runDir,
    baseRevision: 1,
    proposedRevision: 2,
    revision,
    pending,
    expectedManifest,
    runConfigurationSha256,
    canonicalBlocker: "Review policy requires replanning BH-001",
    ...overrides,
  } as never);
  return {
    ledger,
    expectedManifest,
    planBytes,
    request,
    requestBytes,
    revision,
    pending,
    runConfigurationSha256,
    writePlan,
    writeRequest,
    commit,
  };
}

async function modernApprovedReplanFixture() {
  repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-ledger-modern-replan-"));
  const config = defaultConfig();
  const intake = resolveRunIntake({
    task: "Audit the exact approval suffix",
    repo_root: repoRoot,
    mode: "local",
    research: false,
    reflection: false,
  }, config);
  const controller = {
    self_hosting: false,
    mode: "development_checkout" as const,
    executable_path: "/test/brain-hands",
    package_root: "/test/package",
    package_name: "@ngelik/brain-hands",
    package_version: "0.4.0",
    package_hash_algorithm: "sha256" as const,
    package_hash: "a".repeat(64),
    candidate_commit: "b".repeat(40),
  };
  const runConfiguration = resolveRunConfiguration({ intake, config, controller, overrides: {} });
  const ledger = await createRunLedgerV2({
    repoRoot,
    originalRequest: intake.task,
    intake,
    roles: intake.roles,
    sourceCommit: controller.candidate_commit,
    controllerProvenance: controller,
  });
  await writeFile(join(ledger.runDir, "run-configuration.json"), serializeRunConfiguration(runConfiguration));
  await transitionRun(ledger.runDir, "preflight");
  await transitionRun(ledger.runDir, "brain_discovery");
  const basePlan: BrainPlan = {
    summary: "Audit exact approval history",
    assumptions: [],
    research: [],
    research_sources: ["repository"],
    architecture: "Keep approval history immutable.",
    risks: [],
    work_items: [executionSpec("BH-001")],
    integration_verification: [["npm", "test"]],
  };
  await recordAndApprovePinnedInitialPlan(
    ledger.runDir,
    basePlan,
    async () => ({ provenance: controller, selfHosting: false }),
  );
  await updateManifestV2(ledger.runDir, { stage: "replanning" });
  const expectedManifest = await readManifestV2(ledger.runDir);
  const proposedPlan = { ...basePlan, summary: "Audit the complete exact approval suffix" } as BrainPlan;
  const revision = 2;
  const planPath = `plans/revision-${revision}.md`;
  const planBytes = serializePersistedPlan(proposedPlan, expectedManifest.workflow_protocol);
  const planSha256 = createHash("sha256").update(planBytes).digest("hex");
  const request = buildPlanApprovalRequest({
    manifest: expectedManifest,
    runConfiguration,
    reasonCode: "material_replan",
    revision,
    baseRevision: 1,
    planPath,
    planSha256,
    decisionContractSha256: planDecisionContractSha256(proposedPlan),
    delta: buildPlanDelta(basePlan, proposedPlan, { baseRevision: 1, proposedRevision: revision }),
  });
  const requestPath = `approvals/plan/revision-${revision}.json`;
  const requestBytes = serializePlanApprovalRequest(request);
  const revisionRecord = {
    revision,
    path: planPath,
    sha256: planSha256,
    origin: "replan" as const,
    base_revision: 1,
    approval_request_path: requestPath,
    approval_request_sha256: requestSha256(request),
    approval_subject_sha256: request.approval_subject_sha256,
    decision_contract_sha256: planDecisionContractSha256(proposedPlan),
    acceptance_criteria: derivePlanAcceptanceCriteria(proposedPlan),
  };
  const pending = {
    schema_version: 1 as const,
    proposed_revision: revision,
    base_revision: 1,
    request_path: requestPath,
    request_sha256: requestSha256(request),
    approval_subject_sha256: request.approval_subject_sha256,
  };
  await writeFile(join(ledger.runDir, planPath), planBytes);
  await mkdir(join(ledger.runDir, "approvals/plan"), { recursive: true });
  await writeFile(join(ledger.runDir, requestPath), requestBytes);
  const pendingManifest = await commitPreparedPlanApprovalBoundary({
    runDir: ledger.runDir,
    baseRevision: 1,
    proposedRevision: revision,
    revision: revisionRecord,
    pending,
    expectedManifest,
    runConfigurationSha256: expectedManifest.run_configuration_sha256!,
    canonicalBlocker: "Approve the exact replan",
  });
  const promoted = {
    ...pendingManifest,
    stage: "worktree_setup" as const,
    current_revision: revision,
    current_plan_revision: revision,
    approved_revision: revision,
    approved_plan_revision: revision,
    pending_plan_approval: null,
    delivery_state: "pending" as const,
    last_blocker: null,
    review_accounting: pendingManifest.review_accounting === undefined
      ? undefined
      : { ...pendingManifest.review_accounting, plan_revision: revision },
  };
  await writeFile(join(ledger.runDir, "manifest.json"), `${JSON.stringify(promoted, null, 2)}\n`);
  const eventsPath = join(ledger.runDir, "events.jsonl");
  const events = await readFile(eventsPath, "utf8");
  const event = {
    event_id: `plan-approved:${approvalSha256({ run_id: ledger.runId, approval_subject_sha256: request.approval_subject_sha256 })}`,
    run_id: ledger.runId,
    stage: "worktree_setup",
    type: "plan_approved",
    timestamp: new Date().toISOString(),
    actor: "human",
    payload: {
      revision,
      plan_sha256: planSha256,
      request_sha256: pending.request_sha256,
      approval_subject_sha256: request.approval_subject_sha256,
      approval_semantics_version: 1,
    },
  };
  const patchPath = "replans/BH-001-revision-2.json";
  await mkdir(join(ledger.runDir, "replans"), { recursive: true });
  await writeFile(join(ledger.runDir, patchPath), "{}\n");
  const resetEvent = {
    event_id: `approved-replan-reset:${createHash("sha256")
      .update(`${ledger.runId}:BH-001:1:2:${patchPath}`, "utf8").digest("hex")}`,
    run_id: ledger.runId,
    stage: "worktree_setup",
    type: "approved_replan_attempt_reset",
    timestamp: new Date().toISOString(),
    actor: "human",
    payload: { work_item_id: "BH-001", base_plan_revision: 1, plan_revision: 2, replan_patch_path: patchPath },
  };
  await writeFile(eventsPath, `${events}${JSON.stringify(event)}\n${JSON.stringify(resetEvent)}\n`);
  return { ledger, manifest: await readManifestV2(ledger.runDir), revisionRecord };
}

async function modernApprovedThreeRevisionFixture() {
  const fixture = await modernApprovedReplanFixture();
  const runDir = fixture.ledger.runDir;
  await updateManifestV2(runDir, { stage: "replanning" });
  const expectedManifest = await readManifestV2(runDir);
  const baseRecordPath = expectedManifest.plan_revisions["2"]!.path;
  const basePlan = JSON.parse(await readFile(
    baseRecordPath.startsWith("/") ? baseRecordPath : join(runDir, baseRecordPath),
    "utf8",
  )) as BrainPlan;
  const proposedPlan = { ...basePlan, summary: "Audit three exact approval revisions" } as BrainPlan;
  const revision = 3;
  const planPath = `plans/revision-${revision}.md`;
  const planBytes = serializePersistedPlan(proposedPlan, expectedManifest.workflow_protocol);
  const planSha256 = createHash("sha256").update(planBytes).digest("hex");
  const runConfiguration = JSON.parse(await readFile(join(runDir, "run-configuration.json"), "utf8"));
  const request = buildPlanApprovalRequest({
    manifest: expectedManifest,
    runConfiguration,
    reasonCode: "material_replan",
    revision,
    baseRevision: 2,
    planPath,
    planSha256,
    decisionContractSha256: planDecisionContractSha256(proposedPlan),
    delta: buildPlanDelta(basePlan, proposedPlan, { baseRevision: 2, proposedRevision: revision }),
  });
  const requestPath = `approvals/plan/revision-${revision}.json`;
  const requestBytes = serializePlanApprovalRequest(request);
  const revisionRecord = {
    revision, path: planPath, sha256: planSha256, origin: "replan" as const, base_revision: 2,
    approval_request_path: requestPath, approval_request_sha256: requestSha256(request),
    approval_subject_sha256: request.approval_subject_sha256,
    decision_contract_sha256: planDecisionContractSha256(proposedPlan),
    acceptance_criteria: derivePlanAcceptanceCriteria(proposedPlan),
  };
  const pending = {
    schema_version: 1 as const, proposed_revision: revision, base_revision: 2,
    request_path: requestPath, request_sha256: requestSha256(request),
    approval_subject_sha256: request.approval_subject_sha256,
  };
  await writeFile(join(runDir, planPath), planBytes);
  await writeFile(join(runDir, requestPath), requestBytes);
  const pendingManifest = await commitPreparedPlanApprovalBoundary({
    runDir, baseRevision: 2, proposedRevision: revision, revision: revisionRecord, pending,
    expectedManifest, runConfigurationSha256: expectedManifest.run_configuration_sha256!,
    canonicalBlocker: "Approve revision three",
  });
  const promoted = {
    ...pendingManifest, stage: "worktree_setup" as const, current_revision: revision,
    current_plan_revision: revision, approved_revision: revision, approved_plan_revision: revision,
    pending_plan_approval: null, delivery_state: "pending" as const, last_blocker: null,
    review_accounting: pendingManifest.review_accounting === undefined ? undefined
      : { ...pendingManifest.review_accounting, plan_revision: revision },
  };
  await writeFile(join(runDir, "manifest.json"), `${JSON.stringify(promoted, null, 2)}\n`);
  const patchPath = "replans/BH-001-revision-3.json";
  await writeFile(join(runDir, patchPath), "{}\n");
  const eventsPath = join(runDir, "events.jsonl");
  const events = await readFile(eventsPath, "utf8");
  const approvalEvent = {
    event_id: `plan-approved:${approvalSha256({ run_id: fixture.ledger.runId, approval_subject_sha256: request.approval_subject_sha256 })}`,
    run_id: fixture.ledger.runId, stage: "worktree_setup", type: "plan_approved",
    timestamp: new Date().toISOString(), actor: "human",
    payload: { revision, plan_sha256: planSha256, request_sha256: pending.request_sha256,
      approval_subject_sha256: request.approval_subject_sha256, approval_semantics_version: 1 },
  };
  const resetEvent = {
    event_id: `approved-replan-reset:${createHash("sha256")
      .update(`${fixture.ledger.runId}:BH-001:2:3:${patchPath}`, "utf8").digest("hex")}`,
    run_id: fixture.ledger.runId, stage: "worktree_setup", type: "approved_replan_attempt_reset",
    timestamp: new Date().toISOString(), actor: "human",
    payload: { work_item_id: "BH-001", base_plan_revision: 2, plan_revision: 3, replan_patch_path: patchPath },
  };
  await writeFile(eventsPath, `${events}${JSON.stringify(approvalEvent)}\n${JSON.stringify(resetEvent)}\n`);
  return { ...fixture, manifest: await readManifestV2(runDir) };
}

async function migratedStartThreeFixture() {
  repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-ledger-migrated-three-"));
  const config = defaultConfig();
  const intake = resolveRunIntake({
    task: "Migrate after a historical replan", repo_root: repoRoot, mode: "local",
    research: false, reflection: false,
  }, config);
  const controller = {
    self_hosting: false, mode: "development_checkout" as const,
    executable_path: "/test/brain-hands", package_root: "/test/package",
    package_name: "@ngelik/brain-hands", package_version: "0.4.0",
    package_hash_algorithm: "sha256" as const, package_hash: "a".repeat(64),
    candidate_commit: "b".repeat(40),
  };
  const runConfiguration = resolveRunConfiguration({ intake, config, controller, overrides: {} });
  const ledger = await createLegacyRunLedgerV2({
    repoRoot, originalRequest: intake.task, intake, controllerProvenance: controller,
    sourceCommit: controller.candidate_commit,
  });
  const basePlan: BrainPlan = {
    summary: "Historical base", assumptions: [], research: [], research_sources: ["repository"],
    architecture: "legacy", risks: [], work_items: [executionSpec("BH-001")],
    integration_verification: [["npm", "test"]],
  };
  await recordPlan(ledger.runDir, serializePersistedPlan(basePlan, "legacy-v2"));
  await approvePlanRevision(ledger.runDir, 1, { actor: "human" });
  const secondPlan = { ...basePlan, summary: "Historical approved replan" } as BrainPlan;
  await recordPlan(ledger.runDir, serializePersistedPlan(secondPlan, "legacy-v2"));
  await approvePlanRevision(ledger.runDir, 2, { actor: "human" });
  await appendRunEvent(ledger.runDir, {
    actor: "human", stage: "worktree_setup", type: "approved_replan_attempt_reset",
    payload: { work_item_id: "BH-001", base_plan_revision: 1, plan_revision: 2,
      replan_patch_path: "replans/historical-revision-2.json" },
  });
  await writeFile(join(ledger.runDir, "run-configuration.json"), serializeRunConfiguration(runConfiguration));
  await updateManifestV2(ledger.runDir, { stage: "replanning" });
  const expectedManifest = await readManifestV2(ledger.runDir);
  const proposedPlan = { ...secondPlan, summary: "First exact migrated replan" } as BrainPlan;
  const planPath = "plans/revision-3.md";
  const planBytes = serializePersistedPlan(proposedPlan, "legacy-v2");
  const planSha256 = createHash("sha256").update(planBytes).digest("hex");
  const request = buildPlanApprovalRequest({
    manifest: expectedManifest, runConfiguration, reasonCode: "material_replan", revision: 3,
    baseRevision: 2, planPath, planSha256,
    decisionContractSha256: planDecisionContractSha256(proposedPlan),
    delta: buildPlanDelta(secondPlan, proposedPlan, { baseRevision: 2, proposedRevision: 3 }),
  });
  const requestPath = "approvals/plan/revision-3.json";
  const requestBytes = serializePlanApprovalRequest(request);
  const revision = {
    revision: 3, path: planPath, sha256: planSha256, origin: "replan" as const,
    base_revision: 2, approval_request_path: requestPath,
    approval_request_sha256: requestSha256(request),
    approval_subject_sha256: request.approval_subject_sha256,
    decision_contract_sha256: planDecisionContractSha256(proposedPlan),
    acceptance_criteria: derivePlanAcceptanceCriteria(proposedPlan),
  };
  const pending = {
    schema_version: 1 as const, proposed_revision: 3, base_revision: 2,
    request_path: requestPath, request_sha256: requestSha256(request),
    approval_subject_sha256: request.approval_subject_sha256,
  };
  await writeFile(join(ledger.runDir, planPath), planBytes);
  await mkdir(join(ledger.runDir, "approvals/plan"), { recursive: true });
  await writeFile(join(ledger.runDir, requestPath), requestBytes);
  const manifest = await commitPreparedPlanApprovalBoundary({
    runDir: ledger.runDir, baseRevision: 2, proposedRevision: 3, revision, pending,
    expectedManifest, runConfigurationSha256: createHash("sha256")
      .update(serializeRunConfiguration(runConfiguration)).digest("hex"),
    canonicalBlocker: "Approve migrated revision three",
  });
  return { ledger, manifest };
}

function bindPreparedRequest(
  fixture: Awaited<ReturnType<typeof preparedBoundaryFixture>>,
  request: PlanApprovalRequestV1,
  requestBytes = serializePlanApprovalRequest(request),
) {
  const digest = createHash("sha256").update(requestBytes).digest("hex");
  return {
    requestBytes,
    revision: {
      ...fixture.revision,
      approval_request_sha256: digest,
      approval_subject_sha256: request.approval_subject_sha256,
    },
    pending: {
      ...fixture.pending,
      request_sha256: digest,
      approval_subject_sha256: request.approval_subject_sha256,
    },
  };
}

describe("ledger", () => {
  it.each([
    ["research", (configuration: ReturnType<typeof resolveRunConfiguration>) => ({ ...configuration, research: true })],
    ["roles", (configuration: ReturnType<typeof resolveRunConfiguration>) => ({ ...configuration, roles: { ...configuration.roles, hands: { ...configuration.roles.hands, model: "drifted-hands" } } })],
    ["backup", (configuration: ReturnType<typeof resolveRunConfiguration>) => ({ ...configuration, hands_backup: { fallback_on_primary_usage_limit: true, max_quality_recovery_attempts: 1 as const, profile: { model: "backup", reasoning_effort: "medium" as const } } })],
    ["quality", (configuration: ReturnType<typeof resolveRunConfiguration>) => ({ ...configuration, limits: { ...configuration.limits, quality_gate: null } })],
    ["review policy", (configuration: ReturnType<typeof resolveRunConfiguration>) => ({ ...configuration, limits: { ...configuration.limits, review_policy: { ...configuration.limits.review_policy, max_fix_cycles: configuration.limits.review_policy.max_fix_cycles + 1 } } })],
  ])("rejects a run configuration whose %s authority contradicts intake", async (_label, mutate) => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-ledger-authority-"));
    const config = defaultConfig();
    const intake = resolveRunIntake({
      task: "Pin execution authority",
      repo_root: repoRoot,
      mode: "local",
      research: false,
      reflection: false,
      quality_gate: config.retry_policy.quality_gate,
      hands_backup: config.retry_policy.backup,
    }, config);
    const controllerProvenance = {
      self_hosting: false,
      mode: "installed" as const,
      executable_path: "/opt/bin/brain-hands",
      package_root: "/opt/node_modules/@ngelik/brain-hands",
      package_name: "@ngelik/brain-hands",
      package_version: "0.4.0",
      package_hash_algorithm: "sha256" as const,
      package_hash: "a".repeat(64),
      candidate_commit: "b".repeat(40),
    };
    const runConfiguration = resolveRunConfiguration({ intake, config, controller: controllerProvenance, overrides: {} });

    await expect(createRunLedgerV2({
      repoRoot,
      originalRequest: intake.task,
      mode: intake.mode,
      intake,
      roles: intake.roles,
      sourceCommit: controllerProvenance.candidate_commit,
      controllerProvenance,
      runConfiguration: mutate(runConfiguration),
    })).rejects.toThrow(/run configuration.*(intake|roles|backup|quality|review|authority|inputs)/i);
    await expect(access(join(repoRoot, ".brain-hands"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("initializes strict session artifacts and protects all append-only streams", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-ledger-session-"));
    const ledger = await createRunLedgerV2({ repoRoot, originalRequest: "Initialize session artifacts" });
    expect(JSON.parse(await readFile(join(ledger.runDir, "session-state.json"), "utf8"))).toMatchObject({
      schema_version: 1,
      run_id: ledger.runId,
      terminal_outcome: null,
      assurance_outcome: null,
    });
    const state = sessionStateSchema.parse(JSON.parse(await readFile(join(ledger.runDir, "session-state.json"), "utf8")));
    expect(state.session_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(state.canonical_event_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await readFile(join(ledger.runDir, "events.jsonl"), "utf8")).toBe("");
    expect(await readFile(join(ledger.runDir, "progress.jsonl"), "utf8")).toBe("");
    expect(await readFile(join(ledger.runDir, "session-events.jsonl"), "utf8")).toBe("");
    for (const path of ["events.jsonl", "progress.jsonl", "session-events.jsonl"]) {
      await expect(writeTextArtifact(ledger.runDir, path, "overwrite\n")).rejects.toThrow(/append-only/);
      await expect(writeImmutableTextArtifact(ledger.runDir, path, "overwrite\n")).rejects.toThrow(/append-only/);
    }
  });

  it("keeps authoritative ledger creation usable when session initialization fails", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-ledger-session-failure-"));
    const initialize = vi.spyOn(sessionStore, "initializeSessionArtifacts").mockRejectedValueOnce(new Error("telemetry unavailable"));
    const ledger = await createRunLedgerV2({ repoRoot, originalRequest: "Keep authoritative state" });
    expect(initialize).toHaveBeenCalledOnce();
    expect(await readManifestV2(ledger.runDir)).toMatchObject({ run_id: ledger.runId, stage: "intake" });
    expect(await readFile(join(ledger.runDir, "events.jsonl"), "utf8")).toBe("");
    expect(await readFile(join(ledger.runDir, "progress.jsonl"), "utf8")).toBe("");
    await expect(appendRunEvent(ledger.runDir, { actor: "runtime", type: "session_initialization_failed" })).resolves.toMatchObject({ run_id: ledger.runId });
  });

  it("appends one deterministic run event and rejects conflicting replay bytes", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-ledger-event-once-"));
    const ledger = await createRunLedgerV2({ repoRoot, originalRequest: "Append an event once" });
    const input = {
      eventId: `test-event:${"a".repeat(64)}`,
      actor: "test",
      stage: "intake" as const,
      type: "deterministic_test_event",
      timestamp: "2026-07-16T12:00:00.000Z",
      payload: { exact: true },
    };

    const first = await appendRunEventOnce(ledger.runDir, input);
    const replay = await appendRunEventOnce(ledger.runDir, input);

    expect(replay).toEqual(first);
    expect((await readFile(join(ledger.runDir, "events.jsonl"), "utf8")).trim().split("\n"))
      .toHaveLength(1);
    await expect(appendRunEventOnce(ledger.runDir, {
      ...input,
      payload: { exact: false },
    })).rejects.toThrow(/event.*conflict|conflicting.*event/i);
  });

  it("routes one malformed replan contract back to the same immutable Verifier evidence", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-ledger-replan-contract-retry-"));
    const ledger = await createRunLedgerV2({ repoRoot, originalRequest: "Retry malformed Verifier evidence" });
    const reviewPath = "reviews/feature/attempt-3.json";
    const verificationPath = "verification/feature/attempt-3/evidence.json";
    await updateManifestV2(ledger.runDir, {
      stage: "replanning",
      current_work_item_id: "feature",
      delivery_state: "blocked",
      last_blocker: "Replan preparation blocked",
      work_item_progress: {
        feature: {
          status: "blocked",
          attempts: 3,
          review_path: reviewPath,
          verification_path: verificationPath,
          review_revision: 7,
          review_cycle_path: "reviews/decisions/feature/revision-7.json",
          review_effect_id: `review-effect:${"a".repeat(64)}`,
          replan_patch_path: "replans/feature-base-1-review-7.json",
          replan_target_work_item_id: "feature",
          queue_state: "complete",
          queue_path: "reviews/action-queues/feature/revision-7.json",
          completed_action_ids: ["replan"],
        },
      },
    });
    const blocker = "invalid_verifier_contract: Generated artifact output report.json references unknown command report";

    const retried = await retryVerifierReviewAfterInvalidReplanContract(ledger.runDir, {
      workItemId: "feature",
      blocker,
    });

    expect(retried).toMatchObject({ stage: "verifier_review", last_blocker: blocker });
    expect(retried.work_item_progress.feature).toMatchObject({
      status: "blocked",
      attempts: 3,
      review_path: reviewPath,
      verification_path: verificationPath,
      blocker,
      blocker_code: "operational_blocker",
      replan_contract_retry_used: true,
    });
    expect(retried.work_item_progress.feature).not.toHaveProperty("review_revision");
    expect(retried.work_item_progress.feature).not.toHaveProperty("review_cycle_path");
    expect(retried.work_item_progress.feature).not.toHaveProperty("review_effect_id");
    expect(retried.work_item_progress.feature).not.toHaveProperty("replan_patch_path");
    expect(retried.work_item_progress.feature).not.toHaveProperty("queue_path");
    expect((await readFile(join(ledger.runDir, "events.jsonl"), "utf8")))
      .toContain('"type":"invalid_replan_contract_retry"');
  });

  it("rejects a second malformed replan-contract retry", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-ledger-replan-contract-loop-"));
    const ledger = await createRunLedgerV2({ repoRoot, originalRequest: "Stop malformed Verifier retry loops" });
    await updateManifestV2(ledger.runDir, {
      stage: "replanning",
      current_work_item_id: "feature",
      work_item_progress: {
        feature: {
          status: "blocked",
          attempts: 3,
          review_path: "reviews/feature/attempt-3.json",
          verification_path: "verification/feature/attempt-3/evidence.json",
          replan_contract_retry_used: true,
        },
      },
    });

    await expect(retryVerifierReviewAfterInvalidReplanContract(ledger.runDir, {
      workItemId: "feature",
      blocker: "invalid_verifier_contract: repeated malformed command linkage",
    })).rejects.toThrow(/already used/);
    expect((await readManifestV2(ledger.runDir)).stage).toBe("replanning");
  });

  it("tracks controller-output correction independently from linkage retry", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-ledger-controller-output-retry-"));
    const ledger = await createRunLedgerV2({ repoRoot, originalRequest: "Correct controller-owned output" });
    await updateManifestV2(ledger.runDir, {
      stage: "replanning",
      current_work_item_id: "feature",
      work_item_progress: {
        feature: {
          status: "blocked",
          attempts: 4,
          review_path: "reviews/feature/attempt-4.json",
          verification_path: "verification/feature/attempt-4/evidence.json",
          review_revision: 8,
          review_cycle_path: "reviews/decisions/feature/revision-8.json",
          review_effect_id: `review-effect:${"b".repeat(64)}`,
          replan_contract_retry_used: true,
        },
      },
    });
    const blocker = "invalid_verifier_contract: Generated browser output verification/feature/attempt-4/rerun.txt is outside proposed browser-check scope";

    const retried = await retryVerifierReviewAfterInvalidReplanContract(ledger.runDir, {
      workItemId: "feature",
      blocker,
      retryKind: "controller_output",
    });

    expect(retried.work_item_progress.feature).toMatchObject({
      replan_contract_retry_used: true,
      controller_output_contract_retry_used: true,
    });
  });

  it("requires canonical event framing before deterministic appends", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-ledger-event-framing-"));
    const ledger = await createRunLedgerV2({ repoRoot, originalRequest: "Validate event framing" });
    const eventInput = (suffix: string) => ({
      eventId: `test-event:${suffix.repeat(64)}`,
      actor: "test",
      stage: "intake" as const,
      type: "deterministic_test_event",
      timestamp: "2026-07-16T12:00:00.000Z",
      payload: { suffix },
    });

    await expect(appendRunEventOnce(ledger.runDir, eventInput("a"))).resolves.toMatchObject({
      event_id: `test-event:${"a".repeat(64)}`,
    });
    await expect(appendRunEventOnce(ledger.runDir, eventInput("b"))).resolves.toMatchObject({
      event_id: `test-event:${"b".repeat(64)}`,
    });
    const eventsPath = join(ledger.runDir, "events.jsonl");
    const canonical = await readFile(eventsPath, "utf8");
    expect(canonical.endsWith("\n")).toBe(true);
    await writeFile(eventsPath, canonical.slice(0, -1));
    const unterminated = await readFile(eventsPath);

    await expect(appendRunEventOnce(ledger.runDir, eventInput("c")))
      .rejects.toThrow(/event.*newline|unterminated|framing/i);
    expect(await readFile(eventsPath)).toEqual(unterminated);
    await expect(appendRunEventOnce(ledger.runDir, eventInput("c")))
      .rejects.toThrow(/event.*newline|unterminated|framing/i);
    expect(await readFile(eventsPath)).toEqual(unterminated);
  });

  it("does not backfill session artifacts while reading a legacy ledger", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-ledger-legacy-session-"));
    const ledger = await createLegacyRunLedgerV2({
      repoRoot,
      originalRequest: "Read legacy ledger",
      now: new Date("2026-07-15T20:34:01.000Z"),
      intake: { task: "Read legacy ledger", repo_root: repoRoot, mode: "local", research: false, reflection: false },
    });
    const manifestBefore = await readFile(join(ledger.runDir, "manifest.json"));
    expect(await readFile(join(ledger.runDir, "events.jsonl"))).toEqual(Buffer.alloc(0));
    expect(await sessionStore.readSessionState(ledger.runDir)).toBeNull();
    expect(await readFile(join(ledger.runDir, "manifest.json"))).toEqual(manifestBefore);
    expect(ledger.manifest).not.toHaveProperty("remote_synchronization_path");
    expect(await readManifestV2(ledger.runDir)).not.toHaveProperty("remote_synchronization_path");
    await expect(access(join(ledger.runDir, "session-state.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(ledger.runDir, "session-events.jsonl"))).rejects.toMatchObject({ code: "ENOENT" });
    for (const directory of ["recovery", "controller-recovery", "lineage", "replacement"]) {
      await expect(access(join(ledger.runDir, directory))).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("rejects an events.jsonl symlink without modifying its external target", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-ledger-event-symlink-"));
    const ledger = await createRunLedgerV2({ repoRoot, originalRequest: "Protect event appends" });
    const eventsPath = join(ledger.runDir, "events.jsonl");
    await rename(eventsPath, `${eventsPath}.saved`);
    const outside = join(repoRoot, "outside-events.jsonl");
    await writeFile(outside, "outside-sentinel\n");
    await symlink(outside, eventsPath);

    await expect(appendRunEvent(ledger.runDir, { actor: "test", type: "test_event" }))
      .rejects.toThrow(/symlink|owned/i);
    expect(await readFile(outside, "utf8")).toBe("outside-sentinel\n");
  });
  it("rejects malformed controller provenance before creating ledger directories", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-ledger-controller-"));
    await expect(createRunLedgerV2({
      repoRoot,
      originalRequest: "Reject malformed provenance",
      sourceCommit: "a".repeat(40),
      controllerProvenance: {
        self_hosting: false,
        mode: "installed",
        executable_path: "/opt/bin/brain-hands",
        package_root: "/opt/node_modules/@ngelik/brain-hands",
        package_name: "@ngelik/brain-hands",
        package_version: "0.2.0",
        package_hash_algorithm: "sha256",
        package_hash: "invalid",
        candidate_commit: "a".repeat(40),
      },
    })).rejects.toThrow(/package_hash/i);
    await expect(access(join(repoRoot, ".brain-hands"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("records one immutable terminal disposition while leaving the operational stage intact", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-terminal-"));
    const ledger = await createRunLedgerV2({
      repoRoot,
      originalRequest: "Close an incomplete run",
      intake: { task: "Close an incomplete run", repo_root: repoRoot, mode: "local", research: false, reflection: true },
    });
    await updateManifestV2(ledger.runDir, {
      stage: "verifier_review",
      delivery_state: "blocked",
      last_blocker: "The required service is unavailable",
    });

    const first = await recordTerminalDisposition(ledger.runDir, {
      outcome: "closed_blocked",
      actor: "human",
      reason: "The operator chose to stop waiting for the service",
      residual_risks: ["The implementation was not delivered"],
      recorded_at: "2026-07-12T12:00:00.000Z",
    });
    const repeated = await recordTerminalDisposition(ledger.runDir, {
      outcome: "closed_blocked",
      actor: "human",
      reason: "The operator chose to stop waiting for the service",
      residual_risks: ["The implementation was not delivered"],
      recorded_at: "2026-07-12T12:00:00.000Z",
    });

    expect(first.terminal).toEqual({
      outcome: "closed_blocked",
      actor: "human",
      reason: "The operator chose to stop waiting for the service",
      residual_risks: ["The implementation was not delivered"],
      recorded_at: "2026-07-12T12:00:00.000Z",
      source_stage: "verifier_review",
    });
    expect(repeated.terminal).toEqual(first.terminal);
    expect(repeated.stage).toBe("verifier_review");
    expect(repeated.delivery_state).toBe("blocked");
    const events = (await readFile(join(ledger.runDir, "events.jsonl"), "utf8"))
      .split("\n").filter(Boolean).map((line) => JSON.parse(line) as { type: string });
    expect(events.filter((event) => event.type === "run_terminalized")).toHaveLength(1);

    await expect(recordTerminalDisposition(ledger.runDir, {
      outcome: "abandoned",
      actor: "human",
      reason: "A conflicting reason",
      residual_risks: [],
    })).rejects.toThrow("already has terminal outcome closed_blocked");
  });

  it("enforces terminal invariants inside the low-level ledger transaction", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-terminal-transaction-"));
    const ledger = await createRunLedgerV2({ repoRoot, originalRequest: "Reject forged delivery" });

    await expect(withRunLedgerCompoundTransaction(ledger.runDir, (transaction) =>
      transaction.recordTerminalDisposition({
        outcome: "delivered",
        actor: "human",
        reason: "Forge delivery",
        recorded_at: "2026-07-12T12:00:00.000Z",
        source_stage: "intake",
        residual_risks: [],
      }))).rejects.toThrow("Delivered terminal outcomes must be recorded by the runtime");
    expect((await readManifestV2(ledger.runDir)).terminal).toBeNull();
  });

  it("rejects public attempts to forge legacy restore authority", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-legacy-restore-forge-"));
    const ledger = await createRunLedgerV2({ repoRoot, originalRequest: "Reject forged restore" });
    await expect(updateManifestV2(ledger.runDir, { legacy_github_restore: {
      version: 1,
      lineage_id: ledger.manifest.task_lineage_id!,
      migration_run_id: ledger.runId,
      plan_revision: 1,
      plan_sha256: "a".repeat(64),
      original_manifest_sha256: "b".repeat(64),
      original_stage: "implementing",
    } } as never)).rejects.toThrow(/legacy_github_restore.*immutable/i);
    expect((await readManifestV2(ledger.runDir)).legacy_github_restore).toBeNull();
  });

  it("records the whole authoritative lineage cleanup batch with the terminal disposition in one manifest replacement", async () => {
    const setup = await readyGithubCleanupRun();
    await updateManifestV2(setup.ledger.runDir, {
      issue_numbers: [14],
      work_item_issue_map: { second: 14 },
      github_ids: {
        ...setup.manifest.github_ids,
        issue_numbers: [14],
        work_item_issue_map: { second: 14 },
        parent_issue_number: null,
      },
    });

    const terminal = await recordTerminalDispositionWithCleanup({
      runDir: setup.ledger.runDir,
      disposition: {
        outcome: "abandoned",
        actor: "human",
        reason: "Stop the task",
        residual_risks: [],
        recorded_at: "2026-07-17T12:00:00.000Z",
      },
      lineage: setup.lineage,
    });

    expect(terminal.terminal).toMatchObject({ outcome: "abandoned", reason: "Stop the task" });
    expect(terminal.github_cleanup).toEqual({
      version: 1,
      lineage_id: setup.lineage.lineage_id,
      reason: "not_planned",
      target_numbers: [9, 14, 27],
      target_sha256: createHash("sha256").update(JSON.stringify([9, 14, 27])).digest("hex"),
      target_states: { "9": "pending", "14": "pending", "27": "pending" },
      state: "pending",
      started_at: "2026-07-17T12:00:00.000Z",
      completed_at: null,
    });
    await expect(readTaskLineage(repoRoot!, setup.lineage.lineage_id)).resolves.toMatchObject({
      state: "abandoned",
      cleanup_state: "pending",
    });
  });

  it("rejects an empty abandonment claim when the preview contains reuse or update authority", async () => {
    const setup = await readyGithubCleanupRun();
    const previewed = { ...setup.lineage.issue_set.preview!, state: "previewed" as const };
    await withTaskLineageTransaction({ repoRoot: repoRoot!, lineageId: setup.lineage.lineage_id, operation: (transaction) => transaction.update({
      ...transaction.read(),
      issue_set: {
        ...transaction.read().issue_set, state: "uninitialized", parent_issue_number: null,
        work_item_issue_map: {}, operations: {}, preview: previewed,
      },
    }) });
    await updateManifestV2(setup.ledger.runDir, {
      stage: "awaiting_github_issue_effects", issue_numbers: [], work_item_issue_map: {},
      github_ids: { ...setup.manifest.github_ids, issue_numbers: [], work_item_issue_map: {}, parent_issue_number: null },
      github_effects: { ...setup.manifest.github_effects, issue_sync: previewed },
    });

    await expect(recordTerminalDispositionWithCleanup({
      runDir: setup.ledger.runDir,
      disposition: { outcome: "abandoned", actor: "human", reason: "Stop before effects", residual_risks: [], recorded_at: "2026-07-17T12:00:00.000Z" },
      lineage: await readTaskLineage(repoRoot!, setup.lineage.lineage_id),
    })).rejects.toThrow(/create-only|zero-side-effect/i);
    expect((await readManifestV2(setup.ledger.runDir)).terminal).toBeNull();
    expect(await readTaskLineage(repoRoot!, setup.lineage.lineage_id)).toMatchObject({ state: "active", cleanup_state: "not_required" });
  });

  it("rejects terminal cleanup when the supplied lineage snapshot is not the authoritative ready applied issue set", async () => {
    const setup = await readyGithubCleanupRun();
    const forged = {
      ...setup.lineage,
      issue_set: {
        ...setup.lineage.issue_set,
        work_item_issue_map: { ...setup.lineage.issue_set.work_item_issue_map, forged: 99 },
      },
    };

    await expect(recordTerminalDispositionWithCleanup({
      runDir: setup.ledger.runDir,
      disposition: { outcome: "abandoned", actor: "human", reason: "Stop", residual_risks: [] },
      lineage: forged,
    })).rejects.toThrow(/authoritative|lineage snapshot/i);
    expect((await readManifestV2(setup.ledger.runDir)).terminal).toBeNull();
  });

  it("rejects the legacy terminal API for GitHub task-lineage runs", async () => {
    const setup = await readyGithubCleanupRun();

    await expect(recordTerminalDisposition(setup.ledger.runDir, {
      outcome: "abandoned",
      actor: "human",
      reason: "Bypass coordinated cleanup",
      residual_risks: [],
    })).rejects.toThrow(/coordinated|cleanup/i);
    expect((await readManifestV2(setup.ledger.runDir)).terminal).toBeNull();
    expect(await readTaskLineage(repoRoot!, setup.lineage.lineage_id)).toMatchObject({ state: "active" });
  });

  it("rejects explicit null through the public transaction for a delivered task-lineage GitHub run", async () => {
    const setup = await readyGithubCleanupRun();
    await updateManifestV2(setup.ledger.runDir, { stage: "delivery", delivery_state: "ready" });
    const disposition = {
      outcome: "delivered" as const,
      actor: "runtime" as const,
      reason: "Ready",
      residual_risks: [],
      recorded_at: "2026-07-17T12:00:00.000Z",
      source_stage: "delivery" as const,
    };

    await expect(withRunLedgerCompoundTransaction(setup.ledger.runDir, (transaction) => {
      expect(Object.getOwnPropertySymbols(transaction)).toEqual([]);
      const publicRecord = transaction.recordTerminalDisposition as unknown as (...args: unknown[]) => Promise<unknown>;
      return publicRecord(disposition, null);
    })).rejects.toThrow(/coordinated|public|task.lineage/i);
    expect((await readManifestV2(setup.ledger.runDir)).terminal).toBeNull();
    expect(await readTaskLineage(repoRoot!, setup.lineage.lineage_id)).toMatchObject({ state: "active" });
  });

  it("rejects a valid-looking cleanup batch through the public transaction capability", async () => {
    const setup = await readyGithubCleanupRun();
    const base = {
      version: 1 as const,
      lineage_id: setup.lineage.lineage_id,
      reason: "not_planned" as const,
      target_numbers: [9, 14, 27],
      target_sha256: createHash("sha256").update(JSON.stringify([9, 14, 27])).digest("hex"),
      target_states: { "9": "pending" as const, "14": "pending" as const, "27": "pending" as const },
      state: "pending" as const,
      started_at: "2026-07-17T12:00:00.000Z",
      completed_at: null,
    };
    const disposition = {
      outcome: "abandoned" as const,
      actor: "human" as const,
      reason: "Stop",
      residual_risks: [],
      recorded_at: "2026-07-17T12:00:00.000Z",
      source_stage: "verifier_review" as const,
    };

    await expect(withRunLedgerCompoundTransaction(setup.ledger.runDir, (transaction) => {
      const publicRecord = transaction.recordTerminalDisposition as unknown as (...args: unknown[]) => Promise<unknown>;
      return publicRecord(disposition, base);
    })).rejects.toThrow(/coordinated|public|task.lineage/i);
    expect((await readManifestV2(setup.ledger.runDir)).terminal).toBeNull();
    expect((await readManifestV2(setup.ledger.runDir)).github_cleanup).toBeNull();
    expect(await readTaskLineage(repoRoot!, setup.lineage.lineage_id)).toMatchObject({ state: "active" });
  });

  it("rejects cleanup on a local run at the low-level transaction boundary", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-local-cleanup-forgery-"));
    const ledger = await createRunLedgerV2({ repoRoot, originalRequest: "Local cleanup forgery", mode: "local" });
    const manifest = await updateManifestV2(ledger.runDir, { stage: "verifier_review", delivery_state: "blocked" });
    const cleanup = {
      version: 1 as const,
      lineage_id: manifest.task_lineage_id!,
      reason: "not_planned" as const,
      target_numbers: [9],
      target_sha256: createHash("sha256").update(JSON.stringify([9])).digest("hex"),
      target_states: { "9": "pending" as const },
      state: "pending" as const,
      started_at: "2026-07-17T12:00:00.000Z",
      completed_at: null,
    };

    await expect(withRunLedgerCompoundTransaction(ledger.runDir, (transaction) => {
      const publicRecord = transaction.recordTerminalDisposition as unknown as (...args: unknown[]) => Promise<unknown>;
      return publicRecord({
        outcome: "abandoned", actor: "human", reason: "Stop", residual_risks: [],
        recorded_at: "2026-07-17T12:00:00.000Z", source_stage: "verifier_review",
      }, cleanup);
    })).rejects.toThrow(/GitHub|local|cleanup|public/i);
    expect((await readManifestV2(ledger.runDir)).terminal).toBeNull();
  });

  it("prevents workflow mutation and plan approval after an incomplete terminal outcome", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-terminal-freeze-"));
    const ledger = await createRunLedgerV2({ repoRoot, originalRequest: "Freeze terminal state" });
    const plan = await recordPlan(ledger.runDir, "# Plan\n");
    await updateManifestV2(ledger.runDir, { stage: "awaiting_plan_approval" });
    await recordTerminalDisposition(ledger.runDir, {
      outcome: "abandoned",
      actor: "human",
      reason: "The request was withdrawn",
      residual_risks: [],
    });

    await expect(updateManifestV2(ledger.runDir, { stage: "worktree_setup" })).rejects.toThrow("terminal outcome abandoned");
    const eventsBeforeTransition = await readFile(join(ledger.runDir, "events.jsonl"), "utf8");
    await expect(transitionRun(ledger.runDir, "worktree_setup", { actor: "runtime" })).rejects.toThrow("terminal outcome abandoned");
    expect(await readFile(join(ledger.runDir, "events.jsonl"), "utf8")).toBe(eventsBeforeTransition);
    await expect(approvePlanRevision(ledger.runDir, plan.revision, { actor: "human" })).rejects.toThrow("terminal outcome abandoned");
    const manifest = await readManifestV2(ledger.runDir);
    expect(manifest.stage).toBe("awaiting_plan_approval");
    expect(manifest.approved_revision).toBeNull();
  });

  it("retains the terminal append-only final artifact exception", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-terminal-final-artifacts-"));
    const ledger = await createRunLedgerV2({ repoRoot, originalRequest: "Record replacement completion" });
    await updateManifestV2(ledger.runDir, { final_artifact_paths: ["assurance/abandonment.json"] });
    await recordTerminalDisposition(ledger.runDir, {
      outcome: "abandoned",
      actor: "human",
      reason: "The operator chose replacement",
      residual_risks: [],
    });

    await expect(updateManifestV2(ledger.runDir, {
      final_artifact_paths: ["assurance/abandonment.json", "replacement/completion.json"],
    })).resolves.toMatchObject({
      final_artifact_paths: ["assurance/abandonment.json", "replacement/completion.json"],
    });
    await expect(updateManifestV2(ledger.runDir, {
      final_artifact_paths: ["replacement/completion.json"],
    })).rejects.toThrow(/terminal final artifacts are append-only/i);
  });

  it("allows one atomic terminal reflection-index publication", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-terminal-reflection-index-"));
    const ledger = await createRunLedgerV2({ repoRoot, originalRequest: "Publish reflection evidence" });
    await updateManifestV2(ledger.runDir, { delivery_state: "ready", final_artifact_paths: ["assurance/final.json"] });
    await recordTerminalDisposition(ledger.runDir, {
      outcome: "delivered", actor: "runtime", reason: "Delivery is ready", residual_risks: [],
    });

    const published = await updateManifestV2(ledger.runDir, {
      reflection_index_path: "evidence-indexes/reflection/final.json",
      final_artifact_paths: ["assurance/final.json", "evidence-indexes/reflection/final.json"],
    });

    expect(published.reflection_index_path).toBe("evidence-indexes/reflection/final.json");
    expect(published.final_artifact_paths).toEqual([
      "assurance/final.json",
      "evidence-indexes/reflection/final.json",
    ]);
  });

  it("accepts an idempotent replay of terminal reflection-index publication", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-terminal-reflection-replay-"));
    const ledger = await createRunLedgerV2({ repoRoot, originalRequest: "Replay reflection evidence" });
    await updateManifestV2(ledger.runDir, { delivery_state: "ready" });
    await recordTerminalDisposition(ledger.runDir, {
      outcome: "delivered", actor: "runtime", reason: "Delivery is ready", residual_risks: [],
    });
    const patch = {
      reflection_index_path: "evidence-indexes/reflection/final.json",
      final_artifact_paths: ["evidence-indexes/reflection/final.json"],
    };
    await updateManifestV2(ledger.runDir, patch);

    await expect(updateManifestV2(ledger.runDir, patch)).resolves.toMatchObject(patch);
  });

  it("rejects terminal reflection-index pointer replacement", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-terminal-reflection-replace-"));
    const ledger = await createRunLedgerV2({ repoRoot, originalRequest: "Protect reflection evidence" });
    await updateManifestV2(ledger.runDir, { delivery_state: "ready" });
    await recordTerminalDisposition(ledger.runDir, {
      outcome: "delivered", actor: "runtime", reason: "Delivery is ready", residual_risks: [],
    });
    await updateManifestV2(ledger.runDir, {
      reflection_index_path: "evidence-indexes/reflection/final.json",
      final_artifact_paths: ["evidence-indexes/reflection/final.json"],
    });

    await expect(updateManifestV2(ledger.runDir, {
      reflection_index_path: "evidence-indexes/reflection/replacement.json",
      final_artifact_paths: ["evidence-indexes/reflection/final.json", "evidence-indexes/reflection/replacement.json"],
    })).rejects.toThrow(/terminal|reflection/i);
  });

  it("rejects prior-artifact removal during terminal reflection-index publication", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-terminal-reflection-removal-"));
    const ledger = await createRunLedgerV2({ repoRoot, originalRequest: "Keep terminal artifacts" });
    await updateManifestV2(ledger.runDir, { delivery_state: "ready", final_artifact_paths: ["assurance/final.json"] });
    await recordTerminalDisposition(ledger.runDir, {
      outcome: "delivered", actor: "runtime", reason: "Delivery is ready", residual_risks: [],
    });

    await expect(updateManifestV2(ledger.runDir, {
      reflection_index_path: "evidence-indexes/reflection/final.json",
      final_artifact_paths: ["evidence-indexes/reflection/final.json"],
    })).rejects.toThrow(/append-only|terminal/i);
  });

  it("creates a run directory with manifest and request artifact", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-ledger-"));

    const ledger = await createRunLedger({
      repoRoot,
      originalRequest: "Build the CLI",
      slug: "build-cli",
      now: new Date("2026-07-08T12:00:00.000Z"),
    });

    const manifest = await readManifest(ledger.runDir);
    const request = await readFile(join(ledger.runDir, "original-request.md"), "utf8");
    const verificationDir = await stat(join(ledger.runDir, "verification"));
    const reviewsDir = await stat(join(ledger.runDir, "reviews"));
    const promptsDir = await stat(join(ledger.runDir, "prompts"));
    const responsesDir = await stat(join(ledger.runDir, "responses"));

    expect(ledger.runId).toBe("2026-07-08T12-00-00-000Z-build-cli");
    expect(manifest.stage).toBe("intake");
    expect(request).toBe("Build the CLI\n");
    expect(verificationDir.isDirectory()).toBe(true);
    expect(reviewsDir.isDirectory()).toBe(true);
    expect(promptsDir.isDirectory()).toBe(true);
    expect(responsesDir.isDirectory()).toBe(true);
  });

  it("updates manifest stage and writes nested artifacts", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-ledger-"));
    const ledger = await createRunLedger({
      repoRoot,
      originalRequest: "Build the CLI",
      slug: "build-cli",
      now: new Date("2026-07-08T12:00:00.000Z"),
    });
    const initialManifest = await readManifest(ledger.runDir);

    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });

    await updateManifest(ledger.runDir, { stage: "planning" });
    const artifactPath = await writeTextArtifact(
      ledger.runDir,
      "verification/issue-1/test-output.txt",
      "PASS\n",
    );

    const manifest = await readManifest(ledger.runDir);
    const artifact = await readFile(artifactPath, "utf8");

    expect(manifest.stage).toBe("planning");
    expect(manifest.updated_at > initialManifest.updated_at).toBe(true);
    expect(artifact).toBe("PASS\n");
  });

  it("validates artifact paths stay within run directory", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-ledger-"));
    const ledger = await createRunLedger({
      repoRoot,
      originalRequest: "Build the CLI",
      slug: "build-cli",
      now: new Date("2026-07-08T12:00:00.000Z"),
    });
    const escapedPath = join(repoRoot, "outside.txt");

    await expect(writeTextArtifact(ledger.runDir, "../outside.txt", "NOPE")).rejects.toThrow(
      "Artifact path must resolve inside the run directory",
    );
    await expect(readFile(escapedPath, "utf8")).rejects.toThrow("ENOENT");
  });

  it("keeps the v2 event and progress logs append-only", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-ledger-v2-"));
    const ledger = await createLegacyRunLedgerV2({
      repoRoot,
      originalRequest: "Build the v2 CLI",
      slug: "build-v2-cli",
    });

    await expect(writeTextArtifact(ledger.runDir, "events.jsonl", "overwrite\n")).rejects.toThrow(
      "events.jsonl is append-only",
    );
    await expect(writeTextArtifact(ledger.runDir, "progress.jsonl", "overwrite\n")).rejects.toThrow(
      "progress.jsonl is append-only",
    );
    expect(await readFile(join(ledger.runDir, "events.jsonl"), "utf8")).toBe("");
    expect(await readFile(join(ledger.runDir, "progress.jsonl"), "utf8")).toBe("");
  });

  it("creates a durable v2 ledger with intake and artifact directories", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-ledger-v2-"));

    const ledger = await createRunLedgerV2({
      repoRoot,
      originalRequest: "Build the v2 CLI",
      slug: "build-v2-cli",
      mode: "local",
      roleProfiles: {
        brain: { model: "brain-model", reasoning_effort: "high", sandbox: "read-only" },
        hands: { model: "hands-model", reasoning_effort: "medium", sandbox: "workspace-write" },
        verifier: { model: "verifier-model", reasoning_effort: "high", sandbox: "read-only" },
      },
      sourceCommit: "abc123",
      worktreePath: "/tmp/worktree",
      branchName: "codex/build-v2-cli",
      intake: {
        task: "Build the v2 CLI",
        repo_root: repoRoot,
        mode: "local",
        research: false,
        reflection: false,
        quality_gate: {
          hands_self_review_passes: 2,
          max_attempts_per_reviewer_action: 2,
          require_focused_verifier_confirmation: true,
        },
      } as never,
      now: new Date("2026-07-10T12:00:00.000Z"),
      taskLineageId: "946c7414-d500-4e65-a596-dcf99f0015c2",
    });

    expect(ledger.manifest).toMatchObject({
      task_lineage_id: "946c7414-d500-4e65-a596-dcf99f0015c2",
      github_effects_protocol: "task-lineage-v1",
      github_effects: { issue_sync: null, pull_request_delivery: null },
      github_cleanup: null,
    });
    await expect(readTaskLineage(repoRoot, ledger.manifest.task_lineage_id!)).resolves.toMatchObject({
      root_run_id: ledger.runId,
      active_run_id: ledger.runId,
    });
    expect(ledger.manifest.workflow_protocol).toBe("bounded-context-v1");
    expect(ledger.manifest.discovery).toMatchObject({ cycle: 1, answered_questions: 0 });
    expect(ledger.manifest.resource_budget_policy).toMatchObject({ schema_version: 1, max_model_invocations: 64 });
    await expect(readFile(join(ledger.runDir, "budgets", "policy.json"), "utf8"))
      .resolves.toContain('"max_model_invocations": 64');
    for (const directory of ["questions", "answers", "approaches", "briefs"]) {
      expect((await stat(join(ledger.runDir, "discovery", directory))).isDirectory()).toBe(true);
    }

    const manifest = await readManifestV2(ledger.runDir);
    expect(manifest.stage).toBe("intake");
    expect(manifest.run_mode).toBe("local");
    expect(manifest.active_hands_profile).toBe("primary");
    expect(manifest.backup_activation_reason).toBeNull();
    expect(manifest.review_policy_snapshot?.max_fix_cycles).toBe(2);
    expect(manifest.release_guards?.map((guard) => guard.id)).toEqual([
      "release:no-secrets",
      "release:no-auto-merge",
      "release:no-critical-regression",
      "release:required-verification",
    ]);
    expect(manifest.review_accounting).toEqual({
      review_revision: 0,
      fix_cycles_used: 0,
      self_review_mutations_used: 0,
      plan_revision: 0,
    });
    expect(manifest.quality_gate_policy).toEqual({
      hands_self_review_passes: 2,
      max_attempts_per_reviewer_action: 2,
      require_focused_verifier_confirmation: true,
    });
    expect(manifest.source_commit).toBe("abc123");
    expect(manifest.selected_role_profiles.brain?.model).toBe("brain-model");
    expect(manifest.role_profiles.brain?.model).toBe("brain-model");
    expect(manifest.github_ids.parent_issue_number).toBeNull();
    expect(manifest.remote_synchronization_path).toBeNull();
    expect(JSON.parse(await readFile(join(ledger.runDir, "intake.json"), "utf8"))).toMatchObject({
      task: "Build the v2 CLI",
      repo_root: repoRoot,
      quality_gate: manifest.quality_gate_policy,
    });
    expect(await readFile(join(ledger.runDir, "original-request.md"), "utf8")).toBe(
      "Build the v2 CLI\n",
    );
    expect(await readFile(join(ledger.runDir, "events.jsonl"), "utf8")).toBe("");
    expect(await readFile(join(ledger.runDir, "progress.jsonl"), "utf8")).toBe("");

    for (const directory of [
      "plans",
      "prompts",
      "responses",
      "schemas",
      "implementation",
      "verification",
      "reviews",
      "summaries",
      "evidence-indexes",
      "contexts",
      "budgets/claims",
      "budgets/completions",
    ]) {
      expect((await stat(join(ledger.runDir, directory))).isDirectory()).toBe(true);
    }
  });

  it("updates and clears only safe synchronization artifact pointers", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-ledger-synchronization-"));
    const ledger = await createRunLedgerV2({ repoRoot, originalRequest: "Record synchronization evidence" });

    const linked = await updateManifestV2(ledger.runDir, {
      remote_synchronization_path: "assurance/remote-synchronization-proof.json",
    });
    expect(linked.remote_synchronization_path).toBe("assurance/remote-synchronization-proof.json");
    expect((await readManifestV2(ledger.runDir)).remote_synchronization_path)
      .toBe("assurance/remote-synchronization-proof.json");

    expect((await updateManifestV2(ledger.runDir, { remote_synchronization_path: null }))
      .remote_synchronization_path).toBeNull();
    const manifestBeforeUndefined = await readFile(join(ledger.runDir, "manifest.json"));
    await expect(updateManifestV2(ledger.runDir, { remote_synchronization_path: undefined }))
      .rejects.toThrow(/remote_synchronization_path.*undefined/i);
    expect((await readManifestV2(ledger.runDir)).remote_synchronization_path).toBeNull();
    expect(await readFile(join(ledger.runDir, "manifest.json"))).toEqual(manifestBeforeUndefined);
    for (const remote_synchronization_path of ["/tmp/proof.json", "assurance/../proof.json"]) {
      await expect(updateManifestV2(ledger.runDir, { remote_synchronization_path }))
        .rejects.toThrow();
    }
  });

  it("preserves the integrated boundary for one commit and advances it when commit identity changes", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-ledger-integrated-boundary-"));
    const ledger = await createRunLedgerV2({ repoRoot, originalRequest: "Track the integrated commit boundary" });
    const firstCommit = "a".repeat(40);
    const nextCommit = "b".repeat(40);
    const firstBoundary = "2099-01-01T00:00:00.000Z";
    const callerSuppliedEarlierBoundary = "2000-01-01T00:00:00.000Z";
    await updateManifestV2(ledger.runDir, {
      work_item_progress: {
        integrated: { status: "complete", attempts: 1, commit_sha: firstCommit, github_status_transition_at: firstBoundary },
      },
    });
    await updateManifestV2(ledger.runDir, {
      work_item_progress: { feature: { status: "in_progress", attempts: 1 } },
    });
    const omittedEntry = await readManifestV2(ledger.runDir);
    expect(omittedEntry.work_item_progress.integrated).toMatchObject({
      commit_sha: firstCommit,
      github_status_transition_at: firstBoundary,
    });
    await updateManifestV2(ledger.runDir, {
      work_item_progress: {
        ...omittedEntry.work_item_progress,
        integrated: { status: "in_progress", attempts: 2, github_status_transition_at: callerSuppliedEarlierBoundary },
      },
    });
    const omitted = (await readManifestV2(ledger.runDir)).work_item_progress.integrated!;
    expect(omitted).toMatchObject({ commit_sha: firstCommit, github_status_transition_at: firstBoundary });

    const beforeChange = await readManifestV2(ledger.runDir);
    await updateManifestV2(ledger.runDir, {
      work_item_progress: {
        ...beforeChange.work_item_progress,
        integrated: { ...beforeChange.work_item_progress.integrated!, commit_sha: nextCommit, github_status_transition_at: callerSuppliedEarlierBoundary },
      },
    });
    const changed = (await readManifestV2(ledger.runDir)).work_item_progress.integrated!;
    expect(changed.commit_sha).toBe(nextCommit);
    expect(Date.parse(changed.github_status_transition_at as string)).toBeGreaterThan(Date.parse(firstBoundary));

    const sameCommit = await readManifestV2(ledger.runDir);
    await updateManifestV2(ledger.runDir, {
      work_item_progress: {
        ...sameCommit.work_item_progress,
        integrated: { ...sameCommit.work_item_progress.integrated!, github_status_transition_at: callerSuppliedEarlierBoundary },
      },
    });
    expect((await readManifestV2(ledger.runDir)).work_item_progress.integrated!.github_status_transition_at)
      .toBe(changed.github_status_transition_at);
  });

  it("rejects malformed integrated GitHub status transition boundaries", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-ledger-invalid-boundary-"));
    const ledger = await createRunLedgerV2({ repoRoot, originalRequest: "Reject malformed boundary" });
    await expect(updateManifestV2(ledger.runDir, {
      work_item_progress: {
        integrated: { status: "complete", attempts: 1, github_status_transition_at: "tomorrow-ish" },
      },
    })).rejects.toThrow();
    expect((await readManifestV2(ledger.runDir)).work_item_progress.integrated).toBeUndefined();
  });

  it("initializes deterministic root lineage and empty recovery projections", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-ledger-recovery-init-"));
    const ledger = await createRunLedgerV2({
      repoRoot,
      originalRequest: "Initialize durable recovery state",
      runId: "recovery-root-01",
    });
    const expectedLineageId = `task-lineage:${createHash("sha256")
      .update(`brain-hands-task-lineage-v1\0${ledger.runId}`)
      .digest("hex")}`;

    expect(ledger.manifest.recovery).toEqual({
      version: 1,
      active_scope: null,
      scopes: {},
    });
    expect(ledger.manifest.task_lineage).toEqual({
      version: 1,
      lineage_id: expectedLineageId,
      root_run_id: ledger.runId,
      predecessor_run_id: null,
      predecessor_abandonment_sha256: null,
    });
    expect(ledger.manifest.controller_recovery).toEqual({
      version: 1,
      transition_count: 0,
      head_path: null,
    });
    for (const directory of [
      "recovery/scopes",
      "controller-recovery/transitions",
      "lineage",
      "replacement",
    ]) {
      expect((await stat(join(ledger.runDir, directory))).isDirectory()).toBe(true);
    }
  });

  it("uses an exact reserved run ID and supplied task lineage", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-ledger-reserved-id-"));
    const rootRunId = "recovery-root-01";
    const taskLineage = {
      version: 1 as const,
      lineage_id: taskLineageId(rootRunId),
      root_run_id: rootRunId,
      predecessor_run_id: "abandoned-run-01",
      predecessor_abandonment_sha256: "b".repeat(64),
    };

    const ledger = await createRunLedgerV2({
      repoRoot,
      originalRequest: "Create reserved successor",
      runId: "reserved-successor-01",
      taskLineage,
    });

    expect(ledger.runId).toBe("reserved-successor-01");
    expect(ledger.manifest.task_lineage).toEqual(taskLineage);
  });

  it("rejects a supplied lineage identity mismatch before creating ledger directories", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-ledger-lineage-mismatch-"));

    await expect(createRunLedgerV2({
      repoRoot,
      originalRequest: "Reject mismatched lineage identity",
      runId: "reserved-successor-01",
      taskLineage: {
        version: 1,
        lineage_id: `task-lineage:${"a".repeat(64)}`,
        root_run_id: "recovery-root-01",
        predecessor_run_id: "abandoned-run-01",
        predecessor_abandonment_sha256: "b".repeat(64),
      },
    })).rejects.toThrow(/lineage_id.*root_run_id/i);
    await expect(access(join(repoRoot, ".brain-hands"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a persisted lineage identity mismatch on reads and transaction updates", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-ledger-lineage-tamper-"));
    const ledger = await createRunLedgerV2({
      repoRoot,
      originalRequest: "Reject tampered lineage identity",
      runId: "lineage-root-01",
    });
    const manifestPath = join(ledger.runDir, "manifest.json");
    const persisted = JSON.parse(await readFile(manifestPath, "utf8")) as {
      task_lineage: { lineage_id: string };
    };
    persisted.task_lineage.lineage_id = `task-lineage:${"f".repeat(64)}`;
    await writeFile(manifestPath, JSON.stringify(persisted, null, 2), "utf8");

    await expect(readManifestV2(ledger.runDir)).rejects.toThrow(/lineage_id.*root_run_id/i);
    await expect(withRunLedgerCompoundTransaction(ledger.runDir, (transaction) =>
      transaction.updateManifestV2({ last_blocker: "must not persist" })))
      .rejects.toThrow(/lineage_id.*root_run_id/i);
  });

  it("rejects invalid reserved run IDs before creating ledger directories", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-ledger-invalid-reserved-id-"));

    await expect(createRunLedgerV2({
      repoRoot,
      originalRequest: "Escape the run root",
      runId: "../escape",
    })).rejects.toThrow("Reserved run ID is invalid");
    await expect(access(join(repoRoot, ".brain-hands"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("atomically rejects a reserved run ID collision without overwriting the winner", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-ledger-reserved-collision-"));
    const first = await createRunLedgerV2({
      repoRoot,
      originalRequest: "Reserved winner",
      runId: "reserved-collision-01",
      now: new Date("2026-07-16T12:00:00.000Z"),
    });
    await appendRunEvent(first.runDir, { actor: "test", type: "winner_marker" });
    const beforeManifest = await readFile(join(first.runDir, "manifest.json"), "utf8");
    const beforeEvents = await readFile(join(first.runDir, "events.jsonl"), "utf8");

    await expect(createRunLedgerV2({
      repoRoot,
      originalRequest: "Reserved loser",
      runId: "reserved-collision-01",
      now: new Date("2026-07-16T13:00:00.000Z"),
    })).rejects.toThrow("already exists");

    expect(await readFile(join(first.runDir, "manifest.json"), "utf8")).toBe(beforeManifest);
    expect(await readFile(join(first.runDir, "events.jsonl"), "utf8")).toBe(beforeEvents);
  });

  it("rejects byte-changing task lineage mutations", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-ledger-lineage-immutable-"));
    const ledger = await createRunLedgerV2({
      repoRoot,
      originalRequest: "Keep lineage immutable",
      runId: "lineage-root-01",
    });
    const lineage = ledger.manifest.task_lineage!;

    await expect(updateManifestV2(ledger.runDir, {
      task_lineage: {
        ...lineage,
        lineage_id: `task-lineage:${"f".repeat(64)}`,
      },
    } as never)).rejects.toThrow(/task_lineage.*immutable/i);
    expect((await readManifestV2(ledger.runDir)).task_lineage).toEqual(lineage);
  });

  it("allows an unchanged recovery projection and a valid first scope head", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-ledger-recovery-head-"));
    const ledger = await createRunLedgerV2({ repoRoot, originalRequest: "Start recovery journal" });
    const recovery = {
      version: 1 as const,
      active_scope: "work-item:item-1",
      scopes: {
        "work-item:item-1": recoveryScopeState(
          1,
          "recovery/scopes/item-1/decisions/000001-observation.json",
        ),
      },
    };

    await expect(updateManifestV2(ledger.runDir, { recovery })).resolves.toMatchObject({ recovery });
    await expect(updateManifestV2(ledger.runDir, { recovery })).resolves.toMatchObject({ recovery });
  });

  it("rejects invalid first recovery scope heads", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-ledger-recovery-first-head-"));
    const ledger = await createRunLedgerV2({ repoRoot, originalRequest: "Reject invalid first head" });

    for (const [headSequence, headDecisionPath] of [
      [0, null],
      [2, "recovery/scopes/item-1/decisions/000002-observation.json"],
    ] as const) {
      await expect(updateManifestV2(ledger.runDir, {
        recovery: {
          version: 1,
          active_scope: "work-item:item-1",
          scopes: {
            "work-item:item-1": recoveryScopeState(headSequence, headDecisionPath),
          },
        },
      })).rejects.toThrow(/first recovery head.*sequence 1/i);
    }
  });

  it("enforces recovery head sequencing for prototype-named scopes through both update APIs", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-ledger-prototype-scopes-"));

    for (const [scopeId, throughTransaction] of [
      ["toString", false],
      ["constructor", true],
    ] as const) {
      const ledger = await createRunLedgerV2({
        repoRoot,
        originalRequest: `Protect ${scopeId} recovery scope`,
        runId: `prototype-scope-${scopeId.toLowerCase()}`,
      });
      const pathOne = `recovery/scopes/${scopeId}/decisions/000001-observation.json`;
      const pathTwo = `recovery/scopes/${scopeId}/decisions/000002-observation.json`;
      const update = (headSequence: number, headDecisionPath: string) => {
        const patch = {
          recovery: {
            version: 1 as const,
            active_scope: scopeId,
            scopes: { [scopeId]: recoveryScopeState(headSequence, headDecisionPath) },
          },
        };
        return throughTransaction
          ? withRunLedgerCompoundTransaction(ledger.runDir, (transaction) =>
              transaction.updateManifestV2(patch))
          : updateManifestV2(ledger.runDir, patch);
      };

      await expect(update(2, pathTwo)).rejects.toThrow(/first recovery head.*sequence 1/i);
      await expect(update(1, pathOne)).resolves.toMatchObject({
        recovery: { scopes: { [scopeId]: { head_sequence: 1, head_decision_path: pathOne } } },
      });
      await expect(update(1, pathOne)).resolves.toMatchObject({
        recovery: { scopes: { [scopeId]: { head_sequence: 1, head_decision_path: pathOne } } },
      });
      await expect(update(2, pathTwo)).resolves.toMatchObject({
        recovery: { scopes: { [scopeId]: { head_sequence: 2, head_decision_path: pathTwo } } },
      });
    }
  });

  it("rejects removed, decreased, skipped, and unchanged-path recovery heads", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-ledger-recovery-monotonic-"));
    const ledger = await createRunLedgerV2({ repoRoot, originalRequest: "Keep recovery heads monotonic" });
    const pathOne = "recovery/scopes/item-1/decisions/000001-observation.json";
    const pathTwo = "recovery/scopes/item-1/decisions/000002-observation.json";
    await updateManifestV2(ledger.runDir, {
      recovery: {
        version: 1,
        active_scope: "work-item:item-1",
        scopes: { "work-item:item-1": recoveryScopeState(1, pathOne) },
      },
    });

    await expect(updateManifestV2(ledger.runDir, {
      recovery: { version: 1, active_scope: null, scopes: {} },
    })).rejects.toThrow(/scope.*cannot be removed/i);
    await expect(updateManifestV2(ledger.runDir, {
      recovery: {
        version: 1,
        active_scope: "work-item:item-1",
        scopes: { "work-item:item-1": recoveryScopeState(0, null) },
      },
    })).rejects.toThrow(/head sequence.*decrease/i);
    await expect(updateManifestV2(ledger.runDir, {
      recovery: {
        version: 1,
        active_scope: "work-item:item-1",
        scopes: { "work-item:item-1": recoveryScopeState(3, pathTwo) },
      },
    })).rejects.toThrow(/head sequence.*exactly one/i);
    await expect(updateManifestV2(ledger.runDir, {
      recovery: {
        version: 1,
        active_scope: "work-item:item-1",
        scopes: { "work-item:item-1": recoveryScopeState(1, pathTwo) },
      },
    })).rejects.toThrow(/unchanged recovery head.*same decision path/i);
    await expect(updateManifestV2(ledger.runDir, {
      recovery: {
        version: 1,
        active_scope: "work-item:item-1",
        scopes: { "work-item:item-1": recoveryScopeState(2, pathOne) },
      },
    })).rejects.toThrow(/advanced recovery head.*new decision path/i);

    await expect(updateManifestV2(ledger.runDir, {
      recovery: {
        version: 1,
        active_scope: "work-item:item-1",
        scopes: { "work-item:item-1": recoveryScopeState(2, pathTwo) },
      },
    })).resolves.toMatchObject({
      recovery: { scopes: { "work-item:item-1": { head_sequence: 2, head_decision_path: pathTwo } } },
    });
  });

  it("keeps controller recovery heads unchanged or advances them exactly once", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-ledger-controller-recovery-"));
    const ledger = await createRunLedgerV2({ repoRoot, originalRequest: "Keep controller heads monotonic" });
    const pathOne = "controller-recovery/transitions/000001.json";
    const pathTwo = "controller-recovery/transitions/000002.json";
    const initial = { version: 1 as const, transition_count: 0, head_path: null };

    await expect(updateManifestV2(ledger.runDir, { controller_recovery: initial }))
      .resolves.toMatchObject({ controller_recovery: initial });
    await expect(updateManifestV2(ledger.runDir, {
      controller_recovery: { version: 1, transition_count: 1, head_path: pathOne },
    })).resolves.toMatchObject({ controller_recovery: { transition_count: 1, head_path: pathOne } });
    await expect(updateManifestV2(ledger.runDir, {
      controller_recovery: initial,
    })).rejects.toThrow(/transition count.*decrease/i);
    await expect(updateManifestV2(ledger.runDir, {
      controller_recovery: { version: 1, transition_count: 3, head_path: pathTwo },
    })).rejects.toThrow(/transition count.*exactly one/i);
    await expect(updateManifestV2(ledger.runDir, {
      controller_recovery: { version: 1, transition_count: 1, head_path: pathTwo },
    })).rejects.toThrow(/unchanged controller head.*same path/i);
    await expect(updateManifestV2(ledger.runDir, {
      controller_recovery: { version: 1, transition_count: 2, head_path: pathOne },
    })).rejects.toThrow(/advanced controller head.*new path/i);
    await expect(updateManifestV2(ledger.runDir, {
      controller_recovery: { version: 1, transition_count: 2, head_path: pathTwo },
    })).resolves.toMatchObject({ controller_recovery: { transition_count: 2, head_path: pathTwo } });
  });

  it("replays equal immutable JSON writes and rejects byte mismatches", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-ledger-immutable-json-"));
    const ledger = await createRunLedgerV2({ repoRoot, originalRequest: "Write immutable JSON" });
    const schema = z.object({ value: z.string() }).strict();

    const first = await writeImmutableValidatedJson(
      ledger.runDir,
      "summaries/item-1.json",
      schema,
      { value: "first" },
    );
    const replay = await writeImmutableValidatedJson(
      ledger.runDir,
      "summaries/item-1.json",
      schema,
      { value: "first" },
    );

    expect(replay).toEqual(first);
    await expect(readReferencedJson(ledger.runDir, first, schema)).resolves.toEqual({ value: "first" });
    await expect(writeImmutableValidatedJson(
      ledger.runDir,
      "summaries/item-1.json",
      schema,
      { value: "different" },
    )).rejects.toThrow(/immutable artifact.*different bytes/i);
    await expect(readReferencedJson(ledger.runDir, first, schema)).resolves.toEqual({ value: "first" });
  });

  it("rejects immutable JSON path traversal", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-ledger-immutable-traversal-"));
    const ledger = await createRunLedgerV2({ repoRoot, originalRequest: "Reject immutable traversal" });
    const schema = z.object({ value: z.string() }).strict();

    await expect(writeImmutableValidatedJson(
      ledger.runDir,
      "../outside.json",
      schema,
      { value: "outside" },
    )).rejects.toThrow(/inside the run directory/i);
    await expect(access(join(repoRoot, "outside.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps missing referenced reads side-effect free", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-ledger-missing-reference-"));
    const ledger = await createRunLedgerV2({ repoRoot, originalRequest: "Read a missing reference" });
    const schema = z.object({ value: z.string() }).strict();
    const summariesPath = join(ledger.runDir, "summaries");
    const before = await readdir(summariesPath);

    await expect(readReferencedJson(ledger.runDir, {
      path: "summaries/missing.json",
      sha256: "0".repeat(64),
    }, schema)).rejects.toThrow();
    expect(await readdir(summariesPath)).toEqual(before);

    await expect(readReferencedJson(ledger.runDir, {
      path: "summaries/item.json/child.json",
      sha256: "0".repeat(64),
    }, schema)).rejects.toThrow();

    expect(await readdir(summariesPath)).toEqual(before);
    await expect(access(join(summariesPath, "item.json"))).rejects.toMatchObject({ code: "ENOENT" });
    const reference = await writeImmutableValidatedJson(
      ledger.runDir,
      "summaries/item.json",
      schema,
      { value: "written later" },
    );
    await expect(readReferencedJson(ledger.runDir, reference, schema))
      .resolves.toEqual({ value: "written later" });
  });

  it("protects bounded artifact roots from mutable text writes", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-ledger-bounded-roots-"));
    const ledger = await createRunLedgerV2({ repoRoot, originalRequest: "Protect bounded roots" });

    for (const relativePath of [
      "summaries/item-1.json",
      "evidence-indexes/final.json",
      "contexts/hands/item-1.json",
      "budgets/claims/item-1.json",
      "budgets/completions/item-1.json",
    ]) {
      await expect(writeTextArtifact(ledger.runDir, relativePath, "mutable\n"))
        .rejects.toThrow(/immutable/i);
    }
  });

  it("rejects contradictory primary and selected role profiles before creating a run", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-ledger-role-authority-"));
    const config = defaultConfig();
    const intake = resolveRunIntake({
      task: "Reject contradictory roles",
      repo_root: repoRoot,
      mode: "local",
      research: false,
      reflection: false,
    }, config);
    const runConfiguration = resolveRunConfiguration({
      intake,
      config,
      controller: {
        self_hosting: false,
        mode: "development_checkout",
        executable_path: "/test/brain-hands",
        package_root: "/test/package",
        package_name: "@ngelik/brain-hands",
        package_version: "0.4.0",
        package_hash_algorithm: "sha256",
        package_hash: "a".repeat(64),
        candidate_commit: "b".repeat(40),
      },
      overrides: {},
    });

    await expect(createRunLedgerV2({
      repoRoot,
      originalRequest: intake.task,
      mode: intake.mode,
      intake,
      roles: intake.roles,
      selectedRoleProfiles: {
        ...intake.roles,
        hands: { ...intake.roles.hands, model: "drifted-hands" },
      },
      controllerProvenance: {
        self_hosting: false,
        mode: "development_checkout",
        executable_path: "/test/brain-hands",
        package_root: "/test/package",
        package_name: "@ngelik/brain-hands",
        package_version: "0.4.0",
        package_hash_algorithm: "sha256",
        package_hash: "a".repeat(64),
        candidate_commit: "b".repeat(40),
      },
      runConfiguration,
    })).rejects.toThrow(/selected.*role|role.*authority/i);
    await expect(access(join(repoRoot, ".brain-hands", "runs"))).rejects.toThrow("ENOENT");
  });

  it("requires discovery before planning for durable runs", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-ledger-discovery-transition-"));
    const ledger = await createRunLedgerV2({ repoRoot, originalRequest: "Discover before planning" });

    await transitionRun(ledger.runDir, "preflight", { actor: "test" });
    await expect(transitionRun(ledger.runDir, "brain_planning", { actor: "test" }))
      .rejects.toThrow("bounded-context-v1");
    await transitionRun(ledger.runDir, "brain_discovery", { actor: "test" });
    expect((await readManifestV2(ledger.runDir)).stage).toBe("brain_discovery");
  });

  it("defaults old manifests to the legacy protocol without discovery state", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-ledger-legacy-protocol-"));
    const ledger = await createRunLedgerV2({ repoRoot, originalRequest: "Read an old manifest" });
    const manifestPath = join(ledger.runDir, "manifest.json");
    const persisted = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    delete persisted.workflow_protocol;
    delete persisted.discovery;
    await writeFile(manifestPath, JSON.stringify(persisted, null, 2), "utf8");

    const manifest = await readManifestV2(ledger.runDir);
    expect(manifest.workflow_protocol).toBe("legacy-v2");
    expect(manifest.discovery).toBeNull();
  });

  it("does not silently add policy state when reading an active legacy v2 manifest", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-ledger-v2-"));
    const ledger = await createLegacyRunLedgerV2({
      repoRoot,
      originalRequest: "Resume an active legacy v2 run",
    });
    const manifestPath = join(ledger.runDir, "manifest.json");
    const legacyManifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    delete legacyManifest.review_policy_snapshot;
    delete legacyManifest.review_accounting;
    delete legacyManifest.release_guards;
    await writeFile(manifestPath, `${JSON.stringify(legacyManifest, null, 2)}\n`, "utf8");

    const resumed = await readManifestV2(ledger.runDir);

    expect(resumed.review_policy_snapshot).toBeUndefined();
    expect(resumed.review_accounting).toBeUndefined();
    expect(resumed.release_guards).toBeUndefined();
  });

  it("persists resolved review policy without exposing the engine-owned revision as an override", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-ledger-v2-"));
    const ledger = await createRunLedgerV2({
      repoRoot,
      originalRequest: "Persist a resumable intake",
      intake: {
        task: "Persist a resumable intake",
        repo_root: repoRoot,
        mode: "local",
        research: false,
        reflection: false,
        review_policy: {
          policy_revision: 1,
          max_fix_cycles: 5,
          on_limit: "stop",
          auto_advance_on_approval: true,
          severity_defaults: {
            critical: "blocking",
            high: "blocking",
            medium: "follow_up",
            low: "advisory",
          },
          pause_on: ["plan_approval"],
        },
      } as never,
    });

    const persisted = JSON.parse(await readFile(join(ledger.runDir, "intake.json"), "utf8"));
    expect(persisted.review_policy).toMatchObject({ max_fix_cycles: 5, on_limit: "stop" });
    expect(persisted.review_policy).not.toHaveProperty("policy_revision");
  });

  it("persists valid queue progress and rejects invalid queue state", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-ledger-v2-"));
    const ledger = await createRunLedgerV2({
      repoRoot,
      originalRequest: "Resume ordered review actions",
    });

    const updated = await updateManifestV2(ledger.runDir, {
      work_item_progress: {
        "item-1": {
          status: "in_progress",
          attempts: 1,
          review_revision: 2,
          queue_state: "in_progress",
          queue_path: "reviews/item-1/revision-2/queue.json",
          active_action_id: "R2-A1",
          active_action_attempt: 1,
          completed_action_ids: [],
          mutation_kind: "reviewer_action",
          self_review_pass: 2,
          self_review_state: "verification_pending",
          focused_review_path: null,
        },
      },
    });

    expect(updated.work_item_progress["item-1"].active_action_id).toBe("R2-A1");
    await expect(updateManifestV2(ledger.runDir, {
      work_item_progress: {
        "item-1": {
          status: "in_progress",
          attempts: 1,
          queue_state: "paused",
        },
      },
    } as never)).rejects.toThrow();
  });

  it("never converts a zero-attempt work item to complete", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-ledger-v2-"));
    const ledger = await createRunLedgerV2({ repoRoot, originalRequest: "Require a real attempt" });
    await expect(updateManifestV2(ledger.runDir, {
      work_item_progress: { item: { status: "complete", attempts: 0 } },
    })).rejects.toThrow(/cannot become complete without a real attempt/i);
  });

  it("requires immutable summary pointers for bounded work-item completion", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-ledger-bounded-summary-"));
    const ledger = await createRunLedgerV2({ repoRoot, originalRequest: "Require bounded summaries" });

    await expect(updateManifestV2(ledger.runDir, {
      work_item_progress: {
        "item-1": {
          status: "complete",
          attempts: 1,
          context_base_commit: "a".repeat(40),
          context_plan_revision: 1,
        },
      },
    })).rejects.toThrow("Completed work item item-1 requires an immutable summary");
  });

  it("exempts integrated progress and older protocols from bounded summary pointers", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-ledger-summary-compatibility-"));
    const legacy = await createLegacyRunLedgerV2({
      repoRoot,
      originalRequest: "Preserve legacy summary compatibility",
      slug: "preserve-legacy-summary-compatibility",
    });

    await expect(updateManifestV2(legacy.runDir, {
      work_item_progress: { item: { status: "complete", attempts: 1 } },
    })).resolves.toMatchObject({ workflow_protocol: "legacy-v2" });

    const bounded = await createRunLedgerV2({
      repoRoot,
      originalRequest: "Preserve integrated summary compatibility",
      now: new Date("2026-07-10T12:00:01.000Z"),
    });
    await expect(updateManifestV2(bounded.runDir, {
      work_item_progress: { integrated: { status: "complete", attempts: 1 } },
    })).resolves.toMatchObject({ workflow_protocol: "bounded-context-v1" });
  });

  it("keeps abandonment irreversible and risk-acceptance history append-only", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-ledger-v2-"));
    const ledger = await createRunLedgerV2({ repoRoot, originalRequest: "Keep terminal history" });
    await updateManifestV2(ledger.runDir, {
      abandonment_path: "assurance/abandonment.json",
      assurance_outcome: "abandoned",
      delivery_state: "blocked",
      risk_acceptance_path: "assurance/acceptance-1.json",
      risk_acceptance_history: ["assurance/acceptance-1.json"],
    });
    await expect(updateManifestV2(ledger.runDir, { abandonment_path: null, assurance_outcome: null }))
      .rejects.toThrow(/abandonment is immutable/i);
    await expect(updateManifestV2(ledger.runDir, { risk_acceptance_path: null, risk_acceptance_history: [] }))
      .rejects.toThrow(/risk-acceptance history is append-only/i);
  });

  it.each([
    ["review_policy_snapshot", { max_fix_cycles: 99 }],
    ["release_guards", []],
    ["review_accounting", { review_revision: 1, fix_cycles_used: 1 }],
    ["review_policy_snapshot", undefined],
    ["release_guards", undefined],
    ["review_accounting", undefined],
  ])("rejects general manifest mutation of immutable %s", async (field, value) => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-ledger-v2-"));
    const ledger = await createRunLedgerV2({ repoRoot, originalRequest: "Keep snapshots immutable" });
    const before = await readManifestV2(ledger.runDir);

    await expect(updateManifestV2(ledger.runDir, { [field]: value } as never))
      .rejects.toThrow("immutable run snapshot");

    const after = await readManifestV2(ledger.runDir);
    expect(after.review_policy_snapshot).toEqual(before.review_policy_snapshot);
    expect(after.release_guards).toEqual(before.release_guards);
    expect(after.review_accounting).toEqual(before.review_accounting);
  });

  it.each([
    ["pending_plan_approval", {
      schema_version: 1,
      proposed_revision: 1,
      base_revision: null,
      request_path: "approvals/plan/revision-1.json",
      request_sha256: "a".repeat(64),
      approval_subject_sha256: "b".repeat(64),
    }],
    ["run_configuration_sha256", "c".repeat(64)],
    ["approval_protocol_version", null],
    ["approval_protocol_start_revision", 2],
    ["workflow_protocol", "legacy-v2"],
  ])("rejects deliberately untyped mutation of approval-owned %s", async (field, value) => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-ledger-approval-owned-"));
    const ledger = await createRunLedgerV2({ repoRoot, originalRequest: "Keep approval state immutable" });
    const before = await readManifestV2(ledger.runDir);

    await expect(updateManifestV2(ledger.runDir, { [field]: value } as never))
      .rejects.toThrow(`${field} is an immutable run snapshot`);

    const after = await readManifestV2(ledger.runDir);
    expect(after.pending_plan_approval).toEqual(before.pending_plan_approval);
    expect(after.run_configuration_sha256).toEqual(before.run_configuration_sha256);
  });

  it("pins a legacy null configuration digest while committing exact prepared artifacts", async () => {
    const fixture = await preparedBoundaryFixture();
    await fixture.writePlan();
    await fixture.writeRequest();

    const committed = await fixture.commit();

    expect(committed).toMatchObject({
      stage: "awaiting_plan_approval",
      current_revision: 1,
      approved_revision: 1,
      pending_plan_approval: fixture.pending,
      approval_protocol_version: 1,
      approval_protocol_start_revision: 2,
      run_configuration_sha256: fixture.runConfigurationSha256,
      delivery_state: "blocked",
      last_blocker: "Review policy requires replanning BH-001",
    });
    await expect(fixture.commit()).resolves.toEqual(committed);
  });

  it("keeps a genuine unpinned historical replan reset compatible", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-ledger-historical-reset-"));
    const ledger = await createLegacyRunLedgerV2({ repoRoot, originalRequest: "Historical reset" });
    await recordPlan(ledger.runDir, "{}\n");
    await approvePlanRevision(ledger.runDir, 1, { actor: "human" });
    await recordPlan(ledger.runDir, "{\"revision\":2}\n");
    await approvePlanRevision(ledger.runDir, 2, { actor: "human" });
    await appendRunEvent(ledger.runDir, {
      actor: "human", stage: "worktree_setup", type: "approved_replan_attempt_reset",
      payload: { work_item_id: "BH-001", base_plan_revision: 1, plan_revision: 2,
        replan_patch_path: "replans/historical.json" },
    });
    const manifest = await readManifestV2(ledger.runDir);

    await expect(requiresPinnedRuntimeAuthority(ledger.runDir, manifest)).resolves.toBe(false);
  });

  it("ignores a legacy reset prefix when exact migration starts at revision three", async () => {
    const fixture = await migratedStartThreeFixture();

    expect(fixture.manifest).toMatchObject({
      approval_protocol_version: 1,
      approval_protocol_start_revision: 3,
      pending_plan_approval: { proposed_revision: 3, base_revision: 2 },
    });
    await expect(requiresPinnedRuntimeAuthority(fixture.ledger.runDir, fixture.manifest))
      .resolves.toBe(true);
  });

  it("rejects a legacy-shaped approval event in the exact migration suffix", async () => {
    const fixture = await migratedStartThreeFixture();
    await appendRunEvent(fixture.ledger.runDir, {
      actor: "human",
      stage: "worktree_setup",
      type: "plan_approved",
      payload: { revision: 3, sha256: fixture.manifest.plan_revisions["3"]!.sha256 },
    });

    await expect(requiresPinnedRuntimeAuthority(fixture.ledger.runDir, fixture.manifest))
      .rejects.toThrow(/Legacy plan approval event conflicts with exact revision 3/i);
  });

  it("rejects exact approval provenance whose irreversible protocol marker was stripped", async () => {
    const fixture = await preparedBoundaryFixture();
    await fixture.writePlan();
    await fixture.writeRequest();
    const committed = await fixture.commit();
    const manifestPath = join(fixture.ledger.runDir, "manifest.json");
    const stripped = structuredClone(committed) as unknown as Record<string, unknown>;
    delete stripped.approval_protocol_version;
    await writeFile(manifestPath, `${JSON.stringify(stripped, null, 2)}\n`, "utf8");

    await expect(readManifestV2(fixture.ledger.runDir))
      .rejects.toThrow(/approval protocol|exact plan approval provenance/i);
  });

  it("rejects stripping exact metadata from an older revision in a modern approved suffix", async () => {
    const fixture = await modernApprovedReplanFixture();
    const path = join(fixture.ledger.runDir, "manifest.json");
    const stripped = structuredClone(fixture.manifest);
    delete (stripped.plan_revisions["1"] as unknown as Record<string, unknown>).approval_request_path;
    await writeFile(path, `${JSON.stringify(stripped, null, 2)}\n`);

    await expect(readManifestV2(fixture.ledger.runDir))
      .rejects.toThrow(/every revision|complete exact metadata|approval/i);
  });

  it("rejects deleting the older exact approval event without mutating the ledger", async () => {
    const fixture = await modernApprovedReplanFixture();
    const eventPath = join(fixture.ledger.runDir, "events.jsonl");
    const lines = (await readFile(eventPath, "utf8")).split("\n").filter(Boolean);
    const tamperedEvents = `${lines.filter((line) => {
      const event = JSON.parse(line) as { type?: string; payload?: { revision?: number } };
      return event.type !== "plan_approved" || event.payload?.revision !== 1;
    }).join("\n")}\n`;
    await writeFile(eventPath, tamperedEvents);
    const manifestBefore = await readFile(join(fixture.ledger.runDir, "manifest.json"), "utf8");

    await expect(requiresPinnedRuntimeAuthority(fixture.ledger.runDir, fixture.manifest))
      .rejects.toThrow(/approval event is missing.*revision 1/i);
    expect(await readFile(join(fixture.ledger.runDir, "manifest.json"), "utf8")).toBe(manifestBefore);
    expect(await readFile(eventPath, "utf8")).toBe(tamperedEvents);
  });

  it("rejects combined older exact metadata and event stripping", async () => {
    const fixture = await modernApprovedReplanFixture();
    const manifestPath = join(fixture.ledger.runDir, "manifest.json");
    const stripped = structuredClone(fixture.manifest);
    for (const field of [
      "origin", "base_revision", "approval_request_path", "approval_request_sha256",
      "approval_subject_sha256", "decision_contract_sha256",
    ]) delete (stripped.plan_revisions["1"] as unknown as Record<string, unknown>)[field];
    await writeFile(manifestPath, `${JSON.stringify(stripped, null, 2)}\n`);
    const events = (await readFile(join(fixture.ledger.runDir, "events.jsonl"), "utf8"))
      .split("\n")
      .filter(Boolean)
      .filter((line) => {
        const event = JSON.parse(line) as { type?: string; payload?: { revision?: number } };
        return event.type !== "plan_approved" || event.payload?.revision !== 1;
      })
      .join("\n");
    await writeFile(join(fixture.ledger.runDir, "events.jsonl"), `${events}\n`);

    await expect(readManifestV2(fixture.ledger.runDir))
      .rejects.toThrow(/every revision|complete exact metadata/i);
  });

  it.each([
    ["deleted request", "request-delete"],
    ["drifted request", "request-drift"],
    ["deleted plan", "plan-delete"],
    ["drifted plan", "plan-drift"],
  ] as const)("audits older exact artifacts and rejects a %s", async (_label, attack) => {
    const fixture = await modernApprovedReplanFixture();
    const older = fixture.manifest.plan_revisions["1"]!;
    const relativeOrAbsolute = attack.startsWith("request") ? older.approval_request_path! : older.path;
    const artifactPath = relativeOrAbsolute.startsWith("/")
      ? relativeOrAbsolute
      : join(fixture.ledger.runDir, relativeOrAbsolute);
    if (attack.endsWith("delete")) await rm(artifactPath);
    else await writeFile(artifactPath, "tampered\n");
    const manifestBefore = await readFile(join(fixture.ledger.runDir, "manifest.json"), "utf8");
    const eventsBefore = await readFile(join(fixture.ledger.runDir, "events.jsonl"), "utf8");

    await expect(requiresPinnedRuntimeAuthority(fixture.ledger.runDir, fixture.manifest))
      .rejects.toThrow(/missing|digest|canonical|artifact|enoent|unexpected token|sha-256/i);
    expect(await readFile(join(fixture.ledger.runDir, "manifest.json"), "utf8")).toBe(manifestBefore);
    expect(await readFile(join(fixture.ledger.runDir, "events.jsonl"), "utf8")).toBe(eventsBefore);
  });

  it.each(["deleted", "duplicated", "drifted"] as const)(
    "rejects an older exact replan reset event that is %s after revision three",
    async (attack) => {
      const fixture = await modernApprovedThreeRevisionFixture();
      const eventsPath = join(fixture.ledger.runDir, "events.jsonl");
      const events = (await readFile(eventsPath, "utf8")).split("\n").filter(Boolean)
        .map((line) => JSON.parse(line) as { type?: string; payload?: Record<string, unknown> });
      const reset = events.find((event) => event.type === "approved_replan_attempt_reset"
        && event.payload?.plan_revision === 2)!;
      const tampered = attack === "deleted"
        ? events.filter((event) => event !== reset)
        : attack === "duplicated"
          ? [...events, reset]
          : events.map((event) => event === reset
            ? { ...event, payload: { ...event.payload, work_item_id: "BH-DRIFT" } }
            : event);
      await writeFile(eventsPath, `${tampered.map((event) => JSON.stringify(event)).join("\n")}\n`);
      const manifestBefore = await readFile(join(fixture.ledger.runDir, "manifest.json"), "utf8");
      const eventsBefore = await readFile(eventsPath, "utf8");

      await expect(requiresPinnedRuntimeAuthority(fixture.ledger.runDir, fixture.manifest))
        .rejects.toThrow(/replan reset event|duplicate|conflicts/i);
      expect(await readFile(join(fixture.ledger.runDir, "manifest.json"), "utf8")).toBe(manifestBefore);
      expect(await readFile(eventsPath, "utf8")).toBe(eventsBefore);
    },
  );

  it("rejects pending exact approval downgraded by combined pointer, digest, and revision metadata stripping", async () => {
    const fixture = await preparedBoundaryFixture();
    await fixture.writePlan();
    await fixture.writeRequest();
    const committed = await fixture.commit();
    const manifestPath = join(fixture.ledger.runDir, "manifest.json");
    const stripped = structuredClone(committed);
    stripped.pending_plan_approval = null;
    stripped.run_configuration_sha256 = null;
    const proposed = stripped.plan_revisions["2"]! as unknown as Record<string, unknown>;
    for (const field of [
      "origin", "base_revision", "approval_request_path", "approval_request_sha256",
      "approval_subject_sha256", "decision_contract_sha256",
    ]) delete proposed[field];
    await writeFile(manifestPath, `${JSON.stringify(stripped, null, 2)}\n`, "utf8");

    await expect(readManifestV2(fixture.ledger.runDir))
      .rejects.toThrow(/approval protocol version 1.*exact revision metadata/i);
  });

  it("rejects direct legacy approval selection after exact protocol activation", async () => {
    const fixture = await preparedBoundaryFixture();
    await fixture.writePlan();
    await fixture.writeRequest();
    const committed = await fixture.commit();

    await expect(verifyPersistedPlanApprovalSubject(fixture.ledger.runDir, committed, 1))
      .rejects.toThrow(/pinned run plan approval metadata is missing/i);
    await expect(approvePlanRevision(fixture.ledger.runDir, 1, { actor: "human" }))
      .rejects.toThrow(/pinned run plan approval metadata is missing/i);
  });

  it("rejects direct legacy approval after combined marker, pointer, digest, and metadata stripping when modern artifacts remain", async () => {
    const fixture = await preparedBoundaryFixture();
    await fixture.writePlan();
    await fixture.writeRequest();
    const committed = await fixture.commit();
    const path = join(fixture.ledger.runDir, "manifest.json");
    const stripped = structuredClone(committed) as Record<string, any>;
    delete stripped.approval_protocol_version;
    delete stripped.approval_protocol_start_revision;
    stripped.pending_plan_approval = null;
    stripped.run_configuration_sha256 = null;
    for (const revision of Object.values(stripped.plan_revisions) as Array<Record<string, unknown>>) {
      for (const field of [
        "origin", "base_revision", "approval_request_path", "approval_request_sha256",
        "approval_subject_sha256", "decision_contract_sha256",
      ]) delete revision[field];
    }
    await writeFile(path, `${JSON.stringify(stripped, null, 2)}\n`);
    const manifest = await readManifestV2(fixture.ledger.runDir);
    const beforeManifest = await readFile(path, "utf8");
    const beforeEvents = await readFile(join(fixture.ledger.runDir, "events.jsonl"), "utf8");

    await expect(verifyPersistedPlanApprovalSubject(fixture.ledger.runDir, manifest, 1))
      .rejects.toThrow(/protocol marker|pinned run|run configuration/i);
    await expect(approvePlanRevision(fixture.ledger.runDir, 1, { actor: "human" }))
      .rejects.toThrow(/protocol marker|pinned run|run configuration/i);

    expect(await readFile(path, "utf8")).toBe(beforeManifest);
    expect(await readFile(join(fixture.ledger.runDir, "events.jsonl"), "utf8")).toBe(beforeEvents);
  });

  it("rejects a malformed irreversible approval protocol marker", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-ledger-marker-malformed-"));
    const ledger = await createLegacyRunLedgerV2({ repoRoot, originalRequest: "Reject malformed marker" });
    const path = join(ledger.runDir, "manifest.json");
    const raw = JSON.parse(await readFile(path, "utf8"));
    raw.approval_protocol_version = 2;
    await writeFile(path, `${JSON.stringify(raw, null, 2)}\n`);

    await expect(readManifestV2(ledger.runDir)).rejects.toThrow(/approval_protocol_version|literal/i);
  });

  it("lets a concurrent prepared-plan promotion win CAS reconciliation", async () => {
    const fixture = await preparedBoundaryFixture();
    await fixture.writePlan();
    await fixture.writeRequest();
    const pending = await fixture.commit();
    const promoted = {
      ...pending,
      stage: "worktree_setup",
      current_revision: 2,
      current_plan_revision: 2,
      approved_revision: 2,
      approved_plan_revision: 2,
      pending_plan_approval: null,
      delivery_state: "pending",
      last_blocker: null,
    };
    await writeFile(join(fixture.ledger.runDir, "manifest.json"), `${JSON.stringify(promoted, null, 2)}\n`, "utf8");

    const reconciled = await reconcilePreparedPlanApprovalBoundary({
      runDir: fixture.ledger.runDir,
      baseRevision: 1,
      proposedRevision: 2,
      pending: fixture.pending,
      canonicalBlocker: "Review policy requires replanning BH-001",
    });

    expect(reconciled).toMatchObject({ state: "approved", manifest: promoted });
    expect(await readManifestV2(fixture.ledger.runDir)).toEqual(promoted);
  });

  it("rejects a stale preparation snapshot even when base aliases did not change", async () => {
    const fixture = await preparedBoundaryFixture();
    await fixture.writePlan();
    await fixture.writeRequest();
    await updateManifestV2(fixture.ledger.runDir, {
      current_work_item_id: "BH-005",
      work_item_progress: { "BH-005": { status: "blocked", attempts: 1 } },
    });

    await expect(fixture.commit()).rejects.toThrow(/manifest.*changed|stale.*snapshot/i);
    expect((await readManifestV2(fixture.ledger.runDir)).pending_plan_approval).toBeNull();
  });

  it.each([
    ["missing plan", false, false, null],
    ["missing request", true, false, null],
    ["plan digest mismatch", true, true, "plan"],
    ["request digest mismatch", true, true, "request"],
  ])("rejects prepared-boundary artifact failure: %s", async (_label, writePlan, writeRequest, mismatch) => {
    const fixture = await preparedBoundaryFixture();
    if (writePlan) await fixture.writePlan();
    if (writeRequest) await fixture.writeRequest();
    if (mismatch === "plan") await writeFile(join(fixture.ledger.runDir, fixture.revision.path), "wrong plan\n");
    if (mismatch === "request") await writeFile(join(fixture.ledger.runDir, fixture.pending.request_path), "wrong request\n");

    await expect(fixture.commit()).rejects.toThrow(/artifact|missing|digest/i);
  });

  it("rejects a prepared boundary whose configuration digest conflicts with its pinned manifest", async () => {
    const fixture = await preparedBoundaryFixture();
    await fixture.writePlan();
    await fixture.writeRequest();
    const committed = await fixture.commit();
    const pinned = {
      ...committed,
      run_configuration_sha256: "d".repeat(64),
    };
    await writeFile(join(fixture.ledger.runDir, "manifest.json"), JSON.stringify(pinned, null, 2));

    await expect(fixture.commit({ expectedManifest: pinned })).rejects.toThrow(/configuration.*digest|run configuration/i);
  });

  it.each([
    ["run", { run_id: "other-run" }],
    ["revision", { plan_revision: 3 }],
    ["base", { base_plan_revision: 2 }],
    ["plan digest", { plan_sha256: "e".repeat(64) }],
    ["decision digest", { decision_contract_sha256: "f".repeat(64) }],
  ])("rejects request semantic binding drift for %s", async (_label, subjectPatch) => {
    const fixture = await preparedBoundaryFixture();
    await fixture.writePlan();
    const subject = { ...fixture.request.subject, ...subjectPatch };
    const request = {
      ...fixture.request,
      subject,
      approval_subject_sha256: approvalSha256(subject),
    };
    const requestBytes = serializePlanApprovalRequest(request);
    await fixture.writeRequest(requestBytes);
    const requestDigest = createHash("sha256").update(requestBytes).digest("hex");
    const revision = {
      ...fixture.revision,
      approval_request_sha256: requestDigest,
      approval_subject_sha256: request.approval_subject_sha256,
    };
    const pending = {
      ...fixture.pending,
      request_sha256: requestDigest,
      approval_subject_sha256: request.approval_subject_sha256,
    };

    await expect(fixture.commit({ revision, pending })).rejects.toThrow(/request.*(binding|subject|revision|base|plan|decision|run)/i);
  });

  it("rejects a canonical request whose plan path drifts from the prepared revision", async () => {
    const fixture = await preparedBoundaryFixture();
    await fixture.writePlan();
    const request = { ...fixture.request, plan_path: "plans/revision-999.md" };
    const bound = bindPreparedRequest(fixture, request);
    await fixture.writeRequest(bound.requestBytes);

    await expect(fixture.commit({ revision: bound.revision, pending: bound.pending }))
      .rejects.toThrow(/request semantic binding/i);
  });

  it("rejects a request whose declared approval subject hash is inconsistent", async () => {
    const fixture = await preparedBoundaryFixture();
    await fixture.writePlan();
    const request = { ...fixture.request, approval_subject_sha256: "a".repeat(64) };
    const bound = bindPreparedRequest(fixture, request);
    await fixture.writeRequest(bound.requestBytes);

    await expect(fixture.commit({ revision: bound.revision, pending: bound.pending }))
      .rejects.toThrow(/request subject binding/i);
  });

  it("rejects valid-schema noncanonical request JSON even when caller digests match its raw bytes", async () => {
    const fixture = await preparedBoundaryFixture();
    await fixture.writePlan();
    const requestBytes = `${JSON.stringify(fixture.request, null, 2)}\n`;
    const bound = bindPreparedRequest(fixture, fixture.request, requestBytes);
    await fixture.writeRequest(bound.requestBytes);

    await expect(fixture.commit({ revision: bound.revision, pending: bound.pending }))
      .rejects.toThrow(/request artifact is not canonical/i);
  });

  it("rejects a valid-schema request whose reason drifts from material replan", async () => {
    const fixture = await preparedBoundaryFixture();
    await fixture.writePlan();
    const subject = { ...fixture.request.subject, reason_code: "initial_plan" as const };
    const request = {
      ...fixture.request,
      subject,
      approval_subject_sha256: approvalSha256(subject),
    };
    const bound = bindPreparedRequest(fixture, request);
    await fixture.writeRequest(bound.requestBytes);

    await expect(fixture.commit({ revision: bound.revision, pending: bound.pending }))
      .rejects.toThrow(/request semantic binding/i);
  });

  it("updates review accounting only through the dedicated compare-and-set path", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-ledger-v2-"));
    const ledger = await createRunLedgerV2({ repoRoot, originalRequest: "Account exactly once" });
    const before = (await readManifestV2(ledger.runDir)).review_accounting!;
    const after = { ...before, review_revision: 1 };

    expect(await updateReviewAccounting(ledger.runDir, before, after)).toEqual(after);
    expect(await updateReviewAccounting(ledger.runDir, before, after)).toEqual(after);
    await expect(updateReviewAccounting(ledger.runDir, before, { ...after, fix_cycles_used: 1 }))
      .rejects.toThrow("accounting conflict");
  });

  it.each([
    "reviews/decisions/item.json",
    "reviews/effects/effect/claim.json",
    "reviews/accounting/fixes/fix.json",
  ])("prevents generic replacement of engine history at %s", async (path) => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-ledger-v2-"));
    const ledger = await createRunLedgerV2({ repoRoot, originalRequest: "Protect engine history" });

    await expect(writeTextArtifact(ledger.runDir, path, "overwrite\n"))
      .rejects.toThrow("Engine history is immutable");
  });

  it.each([
    "run-configuration.json",
    "approvals/plan/revision-1.json",
    "approvals/other.txt",
  ])("prevents generic replacement of approval evidence at %s", async (path) => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-ledger-approval-evidence-"));
    const ledger = await createRunLedgerV2({ repoRoot, originalRequest: "Protect approval evidence" });

    await expect(writeTextArtifact(ledger.runDir, path, "overwrite\n"))
      .rejects.toThrow(/approval|configuration|immutable/i);
    await expect(writeImmutableTextArtifact(ledger.runDir, path, "create\n"))
      .rejects.toThrow(/approval|configuration|immutable/i);
  });

  it("enforces v2 stage transitions and appends transition events", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-ledger-v2-"));
    const ledger = await createRunLedgerV2({
      repoRoot,
      originalRequest: "Build the v2 CLI",
      slug: "build-v2-cli",
    });

    await transitionRun(ledger.runDir, "preflight", { actor: "system", payload: { ok: true } });
    await expect(
      transitionRun(ledger.runDir, "implementing", { actor: "system" }),
    ).rejects.toThrow("Illegal run stage transition");

    const manifest = await readManifestV2(ledger.runDir);
    expect(manifest.stage).toBe("preflight");
    const events = (await readFile(join(ledger.runDir, "events.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actor: "system", stage: "preflight", payload: { ok: true } });

    await appendRunEvent(ledger.runDir, {
      actor: "test",
      stage: "preflight",
      type: "note",
      payload: { detail: "kept" },
    });
    expect((await readFile(join(ledger.runDir, "events.jsonl"), "utf8")).trim().split("\n"))
      .toHaveLength(2);
  });

  it("uses GitHub-effects protocol-specific stage transitions", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-ledger-effects-"));
    const legacy = await createRunLedgerV2({
      repoRoot,
      originalRequest: "Preserve the legacy issue-sync path",
      slug: "legacy-effects",
    });
    await updateManifestV2(legacy.runDir, {
      task_lineage_id: null,
      github_effects_protocol: "legacy-run-v1",
    });
    await transitionRun(legacy.runDir, "preflight");
    await transitionRun(legacy.runDir, "brain_discovery");
    await transitionRun(legacy.runDir, "awaiting_discovery_brief_approval");
    await transitionRun(legacy.runDir, "brain_planning");
    await transitionRun(legacy.runDir, "awaiting_plan_approval");
    await expect(transitionRun(legacy.runDir, "github_issue_sync")).resolves.toMatchObject({
      stage: "github_issue_sync",
      github_effects_protocol: "legacy-run-v1",
    });

    const lineage = await createRunLedgerV2({
      repoRoot,
      originalRequest: "Require task-lineage effect boundaries",
      slug: "lineage-effects",
    });
    await updateManifestV2(lineage.runDir, {
      task_lineage_id: "946c7414-d500-4e65-a596-dcf99f0015c2",
      github_effects_protocol: "task-lineage-v1",
    });
    await transitionRun(lineage.runDir, "preflight");
    await transitionRun(lineage.runDir, "brain_discovery");
    await transitionRun(lineage.runDir, "awaiting_discovery_brief_approval");
    await transitionRun(lineage.runDir, "brain_planning");
    await transitionRun(lineage.runDir, "awaiting_plan_approval");
    await expect(transitionRun(lineage.runDir, "github_issue_sync")).rejects.toThrow("Illegal run stage transition");
    await transitionRun(lineage.runDir, "worktree_setup");
    await expect(transitionRun(lineage.runDir, "github_issue_sync")).rejects.toThrow("Illegal run stage transition");
    await transitionRun(lineage.runDir, "awaiting_github_issue_effects");
    await expect(transitionRun(lineage.runDir, "implementing")).rejects.toThrow("Illegal run stage transition");
    await transitionRun(lineage.runDir, "github_issue_sync");
    await expect(transitionRun(lineage.runDir, "worktree_setup")).rejects.toThrow("Illegal run stage transition");
    await transitionRun(lineage.runDir, "implementing");
    await transitionRun(lineage.runDir, "verifying");
    await transitionRun(lineage.runDir, "verifier_review");
    await transitionRun(lineage.runDir, "final_verification");
    await transitionRun(lineage.runDir, "awaiting_github_delivery_effects");
    await expect(transitionRun(lineage.runDir, "delivery")).rejects.toThrow("Illegal run stage transition");
    await expect(transitionRun(lineage.runDir, "final_verification")).resolves.toMatchObject({
      stage: "final_verification",
      github_effects_protocol: "task-lineage-v1",
    });
  });

  it("requires explicit Verifier approval before delivery and removes the final-verification bypass", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-ledger-delivery-"));
    const ledger = await createRunLedgerV2({ repoRoot, originalRequest: "Delivery gate" });
    await transitionRun(ledger.runDir, "preflight");
    await transitionRun(ledger.runDir, "brain_discovery");
    await transitionRun(ledger.runDir, "awaiting_discovery_brief_approval");
    await transitionRun(ledger.runDir, "brain_planning");
    await transitionRun(ledger.runDir, "awaiting_plan_approval");
    await transitionRun(ledger.runDir, "worktree_setup");
    await transitionRun(ledger.runDir, "implementing");
    await transitionRun(ledger.runDir, "verifying");
    await transitionRun(ledger.runDir, "verifier_review");
    await transitionRun(ledger.runDir, "final_verification", { actor: "runtime", payload: { work_item_id: "integrated", final: true, pass: 1 } });
    await expect(transitionRun(ledger.runDir, "delivery", { actor: "test" })).rejects.toThrow();
    await transitionRun(ledger.runDir, "verifier_review", { actor: "runtime", payload: { work_item_id: "integrated", final: true, pass: 1 } });
    await expect(transitionRun(ledger.runDir, "delivery", { actor: "test" })).rejects.toThrow("verifier_approved=true");
    const finalVerificationPath = "verification/integrated/attempt-1/evidence.json";
    const finalEvidence = { verification_scope: "integrated", work_item_id: "integrated", attempt: 1, evidence_path: finalVerificationPath, commands: [{ command: "npm test", argv: ["npm", "test"], exit_code: 0, timed_out: false, error_code: null, error_message: null, signal: null, stdout_path: "verification/integrated/attempt-1/command-1.stdout.txt", stderr_path: "verification/integrated/attempt-1/command-1.stderr.txt", result_path: "verification/integrated/attempt-1/command-1.json" }], artifacts: [], artifact_checks: [], browser_evidence: [], created_at: new Date().toISOString() };
    await writeTextArtifact(ledger.runDir, finalVerificationPath, `${JSON.stringify(finalEvidence)}\n`);
    await expect(transitionRun(ledger.runDir, "delivery", { actor: "test", payload: { verifier_approved: true, final: true, work_item_id: "integrated", final_review_path: "reviews/integrated/final-missing.json", final_verification_path: finalVerificationPath } })).rejects.toThrow("final_review_path");
    await writeTextArtifact(ledger.runDir, "reviews/item-1/final-attempt-1.json", `${JSON.stringify({ work_item_id: "item-1", attempt: 1, final: true, decision: "approve", acceptance_coverage: [], evidence_reviewed: [], findings: [], residual_risks: [] })}\n`);
    await updateManifestV2(ledger.runDir, { final_artifact_paths: ["reviews/item-1/final-attempt-1.json", finalVerificationPath] });
    await expect(transitionRun(ledger.runDir, "delivery", { actor: "test", payload: { verifier_approved: true, final: true, work_item_id: "integrated", final_review_path: "reviews/item-1/final-attempt-1.json", final_verification_path: finalVerificationPath } })).rejects.toThrow("final_review_path");
    await writeTextArtifact(ledger.runDir, "reviews/integrated/final-attempt-1.json", `${JSON.stringify({ work_item_id: "integrated", attempt: 1, final: true, decision: "request_changes", failure_class: "implementation_failure", blocker: null, acceptance_coverage: [], evidence_reviewed: [], findings: [{ severity: "medium", file: "src/example.ts", line: null, acceptance_criterion: "The item works", problem: "problem", required_fix: "fix", re_verification: [] }], residual_risks: [] })}\n`);
    await updateManifestV2(ledger.runDir, { final_artifact_paths: ["reviews/integrated/final-attempt-1.json", finalVerificationPath] });
    await expect(transitionRun(ledger.runDir, "delivery", { actor: "test", payload: { verifier_approved: true, final: true, work_item_id: "integrated", final_review_path: "reviews/integrated/final-attempt-1.json", final_verification_path: finalVerificationPath } })).rejects.toThrow("approving");
    await writeTextArtifact(ledger.runDir, "reviews/integrated/final-attempt-2.json", `${JSON.stringify({ work_item_id: "integrated", attempt: 2, final: true, decision: "approve", acceptance_coverage: [], evidence_reviewed: [], findings: [], residual_risks: [] })}\n`);
    await updateManifestV2(ledger.runDir, { final_artifact_paths: ["reviews/integrated/final-attempt-2.json", finalVerificationPath] });
    await expect(transitionRun(ledger.runDir, "delivery", { actor: "test", payload: { verifier_approved: true, final: true, work_item_id: "integrated", final_review_path: "reviews/integrated/final-attempt-2.json", final_verification_path: finalVerificationPath } })).rejects.toThrow("match verification/integrated");
    await writeTextArtifact(ledger.runDir, finalVerificationPath, "{}\n");
    await updateManifestV2(ledger.runDir, { final_artifact_paths: ["reviews/integrated/final-attempt-1.json", finalVerificationPath] });
    await writeTextArtifact(ledger.runDir, "reviews/integrated/final-attempt-1.json", `${JSON.stringify({ work_item_id: "integrated", attempt: 1, final: true, decision: "approve", acceptance_coverage: [], evidence_reviewed: [], findings: [], residual_risks: [] })}\n`);
    await expect(transitionRun(ledger.runDir, "delivery", { actor: "test", payload: { verifier_approved: true, final: true, work_item_id: "integrated", final_review_path: "reviews/integrated/final-attempt-1.json", final_verification_path: finalVerificationPath } })).rejects.toThrow();
    await writeTextArtifact(ledger.runDir, finalVerificationPath, `${JSON.stringify(finalEvidence)}\n`);
    await updateManifestV2(ledger.runDir, { final_artifact_paths: ["reviews/integrated/final-attempt-1.json", finalVerificationPath] });
    await writeTextArtifact(ledger.runDir, finalVerificationPath, `${JSON.stringify({
      ...finalEvidence,
      browser_evidence: [{
        name: "desktop",
        url: "https://example.com/",
        status: "passed",
        screenshot_artifact: "verification/issue-1/attempt-1/desktop.png",
        screenshot_exists: true,
        expected_network: [],
        observed_network: [],
        missing_network: [],
        console_errors: [],
        missing_selectors: [],
        failure_reasons: [],
        evidence_report_path: "verification/issue-1/attempt-1/browser-evidence.json",
        skipped_reason: null,
      }],
    })}\n`);
    await expect(transitionRun(ledger.runDir, "delivery", { actor: "test", payload: { verifier_approved: true, final: true, work_item_id: "integrated", final_review_path: "reviews/integrated/final-attempt-1.json", final_verification_path: finalVerificationPath } })).rejects.toThrow("browser artifacts");
    await writeTextArtifact(ledger.runDir, finalVerificationPath, `${JSON.stringify(finalEvidence)}\n`);
    const manifest = await transitionRun(ledger.runDir, "delivery", { actor: "test", payload: { verifier_approved: true, final: true, work_item_id: "integrated", final_review_path: "reviews/integrated/final-attempt-1.json", final_verification_path: finalVerificationPath } });
    expect(manifest.stage).toBe("delivery");
  });

  it("rejects a duplicate v2 run id before touching the existing ledger", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-ledger-v2-"));
    const now = new Date("2026-07-10T12:00:00.000Z");
    const first = await createRunLedgerV2({
      repoRoot,
      originalRequest: "First request",
      slug: "same-run",
      now,
    });
    await appendRunEvent(first.runDir, { actor: "system", stage: "intake", type: "marker" });
    const beforeEvents = await readFile(join(first.runDir, "events.jsonl"), "utf8");
    const beforeIntake = await readFile(join(first.runDir, "intake.json"), "utf8");

    await expect(
      createRunLedgerV2({
        repoRoot,
        originalRequest: "Second request",
        slug: "same-run",
        now,
      }),
    ).rejects.toThrow("already exists");
    expect(await readFile(join(first.runDir, "events.jsonl"), "utf8")).toBe(beforeEvents);
    expect(await readFile(join(first.runDir, "intake.json"), "utf8")).toBe(beforeIntake);
  });

  it("atomically rejects concurrent duplicate run creation without overwriting the winner", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-ledger-v2-"));
    const now = new Date("2026-07-10T12:00:00.000Z");
    const requests = ["Concurrent request 1", "Concurrent request 2", "Concurrent request 3"];
    const results = await Promise.allSettled(
      requests.map((originalRequest) =>
        createRunLedgerV2({ repoRoot: repoRoot as string, originalRequest, slug: "same-run", now }),
      ),
    );
    const fulfilled = results.filter(
      (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof createRunLedgerV2>>> =>
        result.status === "fulfilled",
    );
    const rejected = results.filter((result) => result.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(requests.length - 1);
    for (const result of rejected) {
      expect(String(result.reason)).toContain("already exists");
    }
    const winner = fulfilled[0].value;
    const winnerIntake = JSON.parse(await readFile(join(winner.runDir, "intake.json"), "utf8")) as {
      task: string;
    };
    expect(requests).toContain(winnerIntake.task);
    expect(await readFile(join(winner.runDir, "original-request.md"), "utf8")).toBe(
      `${winnerIntake.task}\n`,
    );
  });

  it("records plan revisions by hash and approves only the current revision", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-ledger-v2-"));
    const ledger = await createLegacyRunLedgerV2({
      repoRoot,
      originalRequest: "Build the v2 CLI",
      slug: "build-v2-cli",
    });

    const planOne = "# Plan one\n\nImplement it.";
    const first = await recordPlan(ledger.runDir, planOne);
    expect(first.revision).toBe(1);
    expect(first.sha256).toBe(createHash("sha256").update(planOne).digest("hex"));
    expect(await readFile(join(ledger.runDir, "plans/revision-1.md"), "utf8")).toBe(planOne);

    const second = await recordPlan(ledger.runDir, "# Plan two");
    expect(second.revision).toBe(2);
    await expect(approvePlanRevision(ledger.runDir, 1)).rejects.toThrow(
      "Plan revision 1 is not the current revision 2",
    );
    await approvePlanRevision(ledger.runDir, 2, { actor: "human" });

    const manifest = await readManifestV2(ledger.runDir);
    expect(manifest.current_revision).toBe(2);
    expect(manifest.approved_revision).toBe(2);
    expect(manifest.plan_revisions["2"].sha256).toBe(
      createHash("sha256").update("# Plan two").digest("hex"),
    );

    await writeFile(join(ledger.runDir, "plans/revision-2.md"), "tampered", "utf8");
    await expect(approvePlanRevision(ledger.runDir, 2)).rejects.toThrow(
      "does not match its recorded SHA-256",
    );
  });

  it("assigns stable acceptance-criterion references only when approving a structured plan", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-ledger-v2-"));
    const ledger = await createLegacyRunLedgerV2({ repoRoot, originalRequest: "Approve criteria" });
    const plan = {
      summary: "Two items",
      assumptions: [],
      research: [],
      research_sources: [],
      architecture: "Small changes",
      risks: [],
      work_items: [
        { id: "first", acceptance_criteria: ["One", "Two"] },
        { id: "second", acceptance_criteria: ["Three"] },
      ],
      integration_verification: [["npm", "test"]],
    };
    await recordPlan(ledger.runDir, `${JSON.stringify(plan)}\n`);
    const approved = await approvePlanRevision(ledger.runDir, 1);

    expect(approved.plan_revisions["1"].acceptance_criteria).toEqual({
      first: [
        { ref: "BH-001:AC-1", text: "One" },
        { ref: "BH-001:AC-2", text: "Two" },
      ],
      second: [{ ref: "BH-002:AC-1", text: "Three" }],
    });

    const resumed = await readManifestV2(ledger.runDir);
    expect(resumed.plan_revisions["1"].acceptance_criteria).toEqual(
      approved.plan_revisions["1"].acceptance_criteria,
    );
  });

  it("never persists new plan accounting without the matching approval metadata", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-ledger-v2-"));
    const ledger = await createLegacyRunLedgerV2({ repoRoot, originalRequest: "Approve atomically" });
    await recordPlan(ledger.runDir, `${JSON.stringify({
      work_items: [{ id: "first", acceptance_criteria: ["One"] }],
    })}\n`);

    await expect(approvePlanRevision(ledger.runDir, 1, {
      actor: "human",
      transactionHooks: {
        beforeManifestPhase: async (phase: string) => {
          if (phase === "write") throw new Error("injected approval write failure");
        },
      },
    } as never)).rejects.toThrow("injected approval write failure");

    const failed = await readManifestV2(ledger.runDir);
    expect(failed.review_accounting?.plan_revision).toBe(0);
    expect(failed.approved_revision).toBeNull();
    expect(failed.approved_plan_revision).toBeNull();
    expect(failed.plan_revisions["1"].acceptance_criteria).toBeUndefined();
    expect(await readFile(join(ledger.runDir, "events.jsonl"), "utf8")).toBe("");

    const approved = await approvePlanRevision(ledger.runDir, 1, { actor: "human" });
    expect(approved).toMatchObject({
      approved_revision: 1,
      approved_plan_revision: 1,
      review_accounting: { plan_revision: 1 },
    });
    expect(approved.plan_revisions["1"].acceptance_criteria?.first).toEqual([
      { ref: "BH-001:AC-1", text: "One" },
    ]);
  });

  it("rejects generic manifest updates that mutate revision aliases independently", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-ledger-alias-"));
    const ledger = await createLegacyRunLedgerV2({ repoRoot, originalRequest: "Keep revision aliases atomic" });
    const revision = await recordPlan(ledger.runDir, "# Plan\n");
    await approvePlanRevision(ledger.runDir, revision.revision, { actor: "human" });
    const before = await readFile(join(ledger.runDir, "manifest.json"), "utf8");

    await expect(updateManifestV2(ledger.runDir, { current_revision: 2 }))
      .rejects.toThrow(/revision alias|together|independent/i);
    await expect(updateManifestV2(ledger.runDir, { approved_revision: null }))
      .rejects.toThrow(/revision alias|together|independent/i);

    expect(await readFile(join(ledger.runDir, "manifest.json"), "utf8")).toBe(before);
  });

  it("repairs exactly one deterministic approval event after the manifest is durable", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-ledger-v2-"));
    const ledger = await createLegacyRunLedgerV2({ repoRoot, originalRequest: "Repair approval event" });
    const recorded = await recordPlan(ledger.runDir, "# Approved plan\n");

    await expect(approvePlanRevision(ledger.runDir, recorded.revision, {
      actor: "human",
      transactionHooks: {
        afterPlanApprovalManifestPersisted: async () => {
          throw new Error("injected post-manifest approval failure");
        },
      },
    } as never)).rejects.toThrow("injected post-manifest approval failure");

    const durable = await readManifestV2(ledger.runDir);
    expect(durable).toMatchObject({
      approved_revision: recorded.revision,
      approved_plan_revision: recorded.revision,
      review_accounting: { plan_revision: recorded.revision },
    });
    expect(await readFile(join(ledger.runDir, "events.jsonl"), "utf8")).toBe("");

    await approvePlanRevision(ledger.runDir, recorded.revision, { actor: "human" });
    await approvePlanRevision(ledger.runDir, recorded.revision, { actor: "human" });
    const events = (await readFile(join(ledger.runDir, "events.jsonl"), "utf8"))
      .trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actor: "human",
      stage: durable.stage,
      type: "plan_approved",
      payload: { revision: recorded.revision, sha256: recorded.sha256 },
    });
    expect(events[0].event_id).toMatch(/^plan-approved:[a-f0-9]{64}$/);
  });

  it("rejects duplicate structured work-item ids before writing criterion metadata", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-ledger-v2-"));
    const ledger = await createLegacyRunLedgerV2({ repoRoot, originalRequest: "Reject duplicate ids" });
    const plan = {
      work_items: [
        { id: "duplicate", acceptance_criteria: ["One"] },
        { id: "duplicate", acceptance_criteria: ["Two"] },
      ],
    };
    await recordPlan(ledger.runDir, `${JSON.stringify(plan)}\n`);

    await expect(approvePlanRevision(ledger.runDir, 1)).rejects.toThrow(
      'Duplicate work item id "duplicate"',
    );
    const manifest = await readManifestV2(ledger.runDir);
    expect(manifest.approved_plan_revision).toBeNull();
    expect(manifest.plan_revisions["1"].acceptance_criteria).toBeUndefined();
    expect(await readFile(join(ledger.runDir, "events.jsonl"), "utf8")).toBe("");
  });

  it.each(["parent", "target"] as const)(
    "rejects mutable artifact writes through a symlinked %s",
    async (kind) => {
      repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-ledger-v2-"));
      const ledger = await createRunLedgerV2({ repoRoot, originalRequest: "Reject mutable symlink" });
      const outside = join(repoRoot, "outside");
      await mkdir(outside);

      if (kind === "parent") {
        await rm(join(ledger.runDir, "responses"), { recursive: true, force: true });
        await symlink(outside, join(ledger.runDir, "responses"));
      } else {
        await writeFile(join(outside, "response.json"), "ORIGINAL\n");
        await symlink(join(outside, "response.json"), join(ledger.runDir, "response.json"));
      }

      const relativePath = kind === "parent" ? "responses/response.json" : "response.json";
      await expect(writeTextArtifact(ledger.runDir, relativePath, "OVERWRITE\n"))
        .rejects.toThrow(/symlink/i);
      if (kind === "parent") {
        await expect(stat(join(outside, "response.json"))).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        expect(await readFile(join(outside, "response.json"), "utf8")).toBe("ORIGINAL\n");
      }
    },
  );
});
