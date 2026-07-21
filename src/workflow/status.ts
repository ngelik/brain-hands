import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { readManifest, readManifestV2, readVerifiedRunConfiguration, reconcileClaimedInitialPlanBoundary, requiresPinnedRuntimeAuthority, verifyPersistedPlanApprovalSubject } from "../core/ledger.js";
import { assuranceAssessmentSchema, convergenceReportSchema, discoveryApproachSchema, discoveryBriefSchema, discoveryPendingActionSchema, discoveryQuestionSchema, reviewCycleStateSchema, runEventSchema, warningContinuationAuthorizationSchema } from "../core/schema.js";
import { discoveryApproachSelectionPath, discoveryApproachesPath, discoveryBriefPath, discoveryPendingActionPath, discoveryQuestionPath } from "../core/discovery.js";
import {
  discoverySha256,
  readVerifiedDiscoveryQuestionAnswerHistory,
  readVerifiedDiscoveryReadinessHistory,
} from "../core/discovery-ledger.js";
import { z } from "zod";
import type {
  DiscoveryPendingAction,
  DiscoveryQuestion,
  PlanApprovalRequestV1,
  ReviewEffectState,
  ReviewCycleState,
  ReviewPolicyAction,
  RunManifest,
  RunManifestV2,
  RunEvent,
  GithubEffectPhase,
  TerminalOutcome,
  WorkflowStage,
} from "../core/types.js";
import { convergenceReportPath } from "./convergence.js";
import { readOwnedEvidenceFile, readOwnedRunFile } from "./owned-evidence.js";
import { loadSuccessfulFixProvenance, reviewDecisionPath, validatePersistedReviewEffectState } from "./review-cycle.js";
import { summarizeProgressActivity } from "../progress/log.js";
import { resolvePendingReplanTarget, validateActiveReplanPatch } from "./replan.js";
import { assessFinalDelivery, type AssuranceAssessmentOptions } from "./assurance.js";
import { isReviewEffectAction } from "./review-policy.js";
import type { AssuranceAssessment } from "../core/types.js";
import {
  RUN_CONFIGURATION_PATH,
  resolvedRunConfigurationSchema,
  type ResolvedRunConfiguration,
} from "../core/run-configuration.js";
import { reconcileRecoveryJournal } from "./recovery-ledger.js";
import { readVerifiedGithubEffectPreview, renderGithubEffectPreview } from "../github/effect-plan.js";
import { readTaskLineage } from "../core/task-lineage.js";
import { usesDurableDiscoveryProtocol } from "../core/run-state.js";
import {
  resourceBudgetPolicyV1Schema,
  type ResourceBudgetPolicyV1,
  type ResourceBudgetUsage,
} from "../core/resource-budget.js";
import { openResourceBudget, readEffectiveResourceBudgetPolicy } from "./resource-budget.js";
import { classifySemanticBoundary } from "./semantic-boundary.js";

export interface ResumeRunInput {
  runDir: string;
}

export interface V2StatusSummary {
  run_id: string;
  run_dir: string | null;
  stage: RunManifestV2["stage"];
  mode: RunManifestV2["mode"];
  current_revision: number | null;
  approved_revision: number | null;
  current_work_item_id: string | null;
  delivery_state: RunManifestV2["delivery_state"];
  terminal_outcome: TerminalOutcome | null;
  blocker: string | null;
  parent_issue_number: number | null;
  issue_numbers: number[];
  work_item_issue_map: Record<string, number>;
  pull_request_numbers: number[];
  github_task_lineage_id: string | null;
  github_cleanup_state: "pending" | "blocked" | "complete" | null;
  github_cleanup_pending_targets: number[];
  operator_state: OperatorState;
  operator_state_label: string;
  review_revision: number | null;
  fix_cycles_used: number | null;
  max_fix_cycles: number | null;
  plan_revision: number | null;
  active_finding_ids: string[];
  next_automatic_effect: string | null;
  approval_boundary: string;
  latest_decision: ReviewPolicyAction | null;
  latest_effect_state: ReviewEffectState | null;
  warning_continuation_authorized: boolean;
  assurance_outcome: AssuranceAssessment["outcome"] | null;
  assurance_assessment: AssuranceAssessment | null;
  pending_action: DiscoveryPendingAction | null;
  effect_boundary: GithubEffectBoundary | null;
  plan_approval_request: PlanApprovalRequestV1 | null;
  run_configuration?: ResolvedRunConfiguration | null;
  recovery_disposition: RunManifestV2["recovery"]["scopes"][string]["disposition"] | null;
  recovery_scope: string | null;
  blocker_fingerprint: string | null;
  progress_subject_sha256: string | null;
  consecutive_without_progress: number | null;
  diagnostic_path: string | null;
  task_lineage_id: string | null;
  predecessor_run_id: string | null;
  resource_budget: ResourceBudgetStatus | null;
}

export interface ResourceBudgetStatus {
  policy: ResourceBudgetPolicyV1;
  usage: ResourceBudgetUsage;
  remaining: {
    model_invocations: number;
    workflow_attempts: number;
    total_tokens: number;
    active_elapsed_ms: number;
    external_effects: number;
  };
  token_accounting: ResourceBudgetUsage["token_accounting"];
  token_budget_overshot_by: number;
}

export interface GithubEffectBoundary {
  phase: GithubEffectPhase;
  rendered_preview: string;
  preview_path: string;
  preview_sha256: string;
  permitted_next_actions: ["resume", "abandon"];
}

export type OperatorState =
  | "progressing_automatically"
  | "awaiting_discovery_answer"
  | "awaiting_discovery_approach"
  | "awaiting_discovery_brief_approval"
  | "awaiting_plan_approval"
  | "awaiting_github_effect_application"
  | "awaiting_irreversible_action_authority"
  | "diagnostic_stop"
  | "operationally_blocked"
  | "unresolved_release_blocker"
  | "authorized_warning_continuation"
  | "human_accepted"
  | "abandoned"
  | "closed_blocked"
  | "delivered";

export interface OperatorStatusEvidence {
  active_finding_ids?: string[];
  latest_decision?: ReviewPolicyAction | null;
  latest_effect_state?: ReviewEffectState | null;
  warning_authorized?: boolean;
  force_release_blocker?: boolean;
  operational_blocker?: boolean;
  convergence_report_path?: string | null;
  projection_blocker?: string | null;
}

const OPERATOR_LABELS: Record<OperatorState, string> = {
  progressing_automatically: "Progressing automatically",
  awaiting_discovery_answer: "Awaiting local discovery input",
  awaiting_discovery_approach: "Awaiting local discovery input",
  awaiting_discovery_brief_approval: "Awaiting local discovery input",
  awaiting_plan_approval: "Awaiting plan approval",
  awaiting_github_effect_application: "Awaiting GitHub effect application",
  awaiting_irreversible_action_authority: "Awaiting irreversible-action authority",
  diagnostic_stop: "Diagnostic stop",
  operationally_blocked: "Operationally blocked",
  unresolved_release_blocker: "Unresolved release blocker",
  authorized_warning_continuation: "Authorized warning continuation",
  human_accepted: "Human accepted",
  abandoned: "Abandoned",
  closed_blocked: "Closed blocked",
  delivered: "Delivered",
};

function hasLegacyReplanPatch(manifest: RunManifestV2): boolean {
  return manifest.pending_plan_approval === null
    && Object.values(manifest.work_item_progress)
      .some((progress) => typeof progress.replan_patch_path === "string");
}

function approvalBoundary(
  state: OperatorState,
  manifest: RunManifestV2,
  request: PlanApprovalRequestV1 | null,
): string {
  switch (state) {
    case "awaiting_discovery_answer":
    case "awaiting_discovery_approach":
    case "awaiting_discovery_brief_approval":
      return "Awaiting local discovery input.";
    case "awaiting_plan_approval":
      if (request !== null) {
        return `Explicit approval is required for plan revision ${request.subject.plan_revision}.`;
      }
      if (hasLegacyReplanPatch(manifest)) {
        return "Run resume to prepare an exact plan approval request before approval.";
      }
      if (manifest.current_revision === null) return "A plan revision must be created before approval.";
      const sha256 = manifest.plan_revisions[String(manifest.current_revision)]?.sha256;
      return sha256 === undefined
        ? `Explicit approval is required for legacy plan revision ${manifest.current_revision}.`
        : `Explicit approval is required for legacy plan revision ${manifest.current_revision} (SHA-256: ${sha256}).`;
    case "awaiting_irreversible_action_authority":
      return "A human must review and merge the pull request; Brain Hands never merges automatically.";
    case "diagnostic_stop":
      return "Explicit diagnostic recovery authorization is required before one exact retry.";
    case "unresolved_release_blocker":
      return "A human-approved replan or explicit scope decision is required; the blocker cannot be auto-waived.";
    case "operationally_blocked":
      return "Restore the failed runtime, permission, network, catalog, or test-infrastructure dependency, then resume.";
    case "authorized_warning_continuation":
      return "Continuation was preauthorized for this run and is recorded in an immutable authorization artifact.";
    default:
      return "none";
  }
}

function nextEffect(state: OperatorState, evidence: OperatorStatusEvidence): string | null {
  if (state !== "progressing_automatically" && state !== "authorized_warning_continuation") return null;
  if (evidence.latest_decision && evidence.latest_effect_state !== "complete") return evidence.latest_decision;
  return state === "progressing_automatically" ? "resume approved workflow" : "advance with recorded warning";
}

/** Pure projection: models may describe findings, but only durable engine state selects this operator state. */
export function projectOperatorStatus(
  manifest: RunManifestV2,
  evidence: OperatorStatusEvidence = {},
  assurance: AssuranceAssessment | null = null,
  pendingAction: DiscoveryPendingAction | null = null,
  runDir: string | null = null,
  runConfiguration: ResolvedRunConfiguration | null = null,
  effectBoundary: GithubEffectBoundary | null = null,
  resourceBudget: ResourceBudgetStatus | null = null,
  planApprovalRequest: PlanApprovalRequestV1 | null = null,
): V2StatusSummary {
  const activeFindingIds = [...new Set(evidence.active_finding_ids ?? [])].sort();
  const hasReplanPatch = Object.values(manifest.work_item_progress).some(
    (progress) => typeof progress.replan_patch_path === "string",
  );
  const hasDeterministicReplanPreparationBlocker = manifest.stage === "replanning"
    && manifest.pending_plan_approval === null
    && manifest.delivery_state === "blocked"
    && manifest.last_blocker?.startsWith("Replan preparation blocked: ") === true;
  const isDelivered = manifest.stage === "complete"
    || manifest.delivery_state === "complete"
    || (manifest.mode === "local" && manifest.stage === "delivery" && manifest.delivery_state === "ready");
  const isManualDeliveryBoundary = manifest.mode === "github"
    && manifest.stage === "delivery"
    && manifest.delivery_state === "ready";
  const semanticBoundary = classifySemanticBoundary(manifest);
  const isAssuranceBoundary = Boolean(manifest.abandonment_path)
    || manifest.assurance_assessment_path !== null
    || manifest.stage === "delivery"
    || manifest.stage === "complete";
  const effectiveAssurance = isAssuranceBoundary ? assurance : null;
  const recoveryScope = manifest.recovery.active_scope;
  const recoveryState = recoveryScope !== null
    && Object.prototype.hasOwnProperty.call(manifest.recovery.scopes, recoveryScope)
    ? manifest.recovery.scopes[recoveryScope]
    : undefined;

  let operatorState: OperatorState;
  if (manifest.terminal?.outcome === "human_accepted") {
    operatorState = "human_accepted";
  } else if (manifest.terminal?.outcome === "abandoned") {
    operatorState = "abandoned";
  } else if (manifest.terminal?.outcome === "closed_blocked") {
    operatorState = "closed_blocked";
  } else if (effectiveAssurance?.outcome === "human_accepted") {
    operatorState = "human_accepted";
  } else if (effectiveAssurance?.outcome === "abandoned") {
    operatorState = "abandoned";
  } else if (manifest.terminal?.outcome === "delivered") {
    operatorState = "delivered";
  } else if (evidence.projection_blocker !== undefined && evidence.projection_blocker !== null) {
    operatorState = "operationally_blocked";
  } else if (
    planApprovalRequest !== null
    && manifest.stage === "awaiting_plan_approval"
  ) {
    operatorState = "awaiting_plan_approval";
  } else if (recoveryState?.disposition === "diagnostic_stop") {
    operatorState = "diagnostic_stop";
  } else if (evidence.operational_blocker === true || effectiveAssurance?.outcome === "blocked") {
    operatorState = "operationally_blocked";
  } else if (semanticBoundary === "discovery_answer") {
    operatorState = "awaiting_discovery_answer";
  } else if (semanticBoundary === "discovery_approach") {
    operatorState = "awaiting_discovery_approach";
  } else if (semanticBoundary === "discovery_brief_approval") {
    operatorState = "awaiting_discovery_brief_approval";
  } else if (hasDeterministicReplanPreparationBlocker) {
    operatorState = "operationally_blocked";
  } else if (semanticBoundary === "plan_approval" || hasReplanPatch) {
    operatorState = "awaiting_plan_approval";
  } else if (effectBoundary !== null && (
    manifest.stage === "awaiting_github_issue_effects"
    || manifest.stage === "awaiting_github_delivery_effects"
  )) {
    operatorState = "awaiting_github_effect_application";
  } else if (manifest.delivery_state === "blocked"
    && (evidence.force_release_blocker === true || evidence.latest_decision === "stop")) {
    operatorState = "unresolved_release_blocker";
  } else if (manifest.delivery_state === "blocked") {
    operatorState = "operationally_blocked";
  } else if (isManualDeliveryBoundary) {
    operatorState = "awaiting_irreversible_action_authority";
  } else if (isDelivered) {
    operatorState = "delivered";
  } else if (evidence.warning_authorized === true
    && evidence.latest_decision === "continue_with_warning") {
    operatorState = "authorized_warning_continuation";
  } else {
    operatorState = "progressing_automatically";
  }

  return {
    run_id: manifest.run_id,
    run_dir: runDir,
    stage: manifest.stage,
    mode: manifest.mode,
    current_revision: manifest.current_revision,
    approved_revision: manifest.approved_revision,
    current_work_item_id: manifest.current_work_item_id,
    delivery_state: manifest.delivery_state,
    terminal_outcome: manifest.terminal?.outcome ?? (manifest.stage === "complete" ? "delivered" : null),
    blocker: evidence.projection_blocker ?? effectiveAssurance?.blocker ?? manifest.last_blocker,
    parent_issue_number: manifest.github_ids.parent_issue_number ?? null,
    issue_numbers: manifest.issue_numbers,
    work_item_issue_map: {
      ...manifest.work_item_issue_map,
      ...(manifest.github_ids.work_item_issue_map ?? {}),
    },
    pull_request_numbers: manifest.pull_request_numbers,
    github_task_lineage_id: manifest.task_lineage_id,
    github_cleanup_state: manifest.github_cleanup?.state ?? null,
    github_cleanup_pending_targets: manifest.github_cleanup?.target_numbers.filter(
      (number) => manifest.github_cleanup!.target_states[String(number)] !== "complete",
    ) ?? [],
    operator_state: operatorState,
    operator_state_label: OPERATOR_LABELS[operatorState],
    review_revision: manifest.review_accounting?.review_revision ?? null,
    fix_cycles_used: manifest.review_accounting?.fix_cycles_used ?? null,
    max_fix_cycles: manifest.review_policy_snapshot?.max_fix_cycles ?? null,
    plan_revision: manifest.review_accounting?.plan_revision ?? manifest.current_plan_revision,
    active_finding_ids: activeFindingIds,
    next_automatic_effect: nextEffect(operatorState, evidence),
    approval_boundary: approvalBoundary(operatorState, manifest, planApprovalRequest),
    latest_decision: evidence.latest_decision ?? null,
    latest_effect_state: evidence.latest_effect_state ?? null,
    warning_continuation_authorized: evidence.warning_authorized === true,
    assurance_outcome: isAssuranceBoundary
      ? effectiveAssurance?.outcome ?? manifest.assurance_outcome
      : null,
    assurance_assessment: effectiveAssurance,
    pending_action: pendingAction,
    effect_boundary: effectBoundary,
    plan_approval_request: planApprovalRequest,
    run_configuration: runConfiguration,
    recovery_disposition: recoveryState?.disposition ?? null,
    recovery_scope: recoveryScope,
    blocker_fingerprint: recoveryState?.blocker_fingerprint ?? null,
    progress_subject_sha256: recoveryState?.progress_subject_sha256 ?? null,
    consecutive_without_progress: recoveryState?.consecutive_without_progress ?? null,
    diagnostic_path: recoveryState?.diagnostic_path ?? null,
    task_lineage_id: manifest.task_lineage?.lineage_id ?? null,
    predecessor_run_id: manifest.task_lineage?.predecessor_run_id ?? null,
    resource_budget: resourceBudget,
  };
}

async function readStatusEffectBoundary(runDir: string, manifest: RunManifestV2): Promise<GithubEffectBoundary | null> {
  const phase = manifest.stage === "awaiting_github_issue_effects" ? "issue_sync"
    : manifest.stage === "awaiting_github_delivery_effects" ? "pull_request_delivery" : null;
  if (phase === null) {
    if (manifest.stage === "worktree_setup"
      && manifest.github_effects_protocol === "task-lineage-v1"
      && manifest.task_lineage_id !== null) {
      const lineage = await readTaskLineage(manifest.repo_root, manifest.task_lineage_id);
      const artifactExists = await access(join(runDir, "github-effects", "issue-sync", "revision-1.json"))
        .then(() => true, (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return false;
          throw error;
        });
      if (artifactExists || lineage.issue_set.preview !== null || manifest.github_effects.issue_sync !== null) {
        throw new Error("GitHub issue preview persistence is incomplete; resume to recover the non-mutating prefix");
      }
    }
    return null;
  }
  if (manifest.task_lineage_id === null) throw new Error("GitHub effect boundary is missing its task lineage");
  const reference = manifest.github_effects[phase];
  if (reference === null) throw new Error(`GitHub effect boundary is missing its ${phase} preview reference`);
  if (reference.state === "invalidated") return null;
  const lineage = await readTaskLineage(manifest.repo_root, manifest.task_lineage_id);
  const lineageReference = phase === "issue_sync" ? lineage.issue_set.preview : lineage.delivery.preview;
  const sameReferenceIdentity = lineageReference !== null
    && lineageReference.phase === reference.phase
    && lineageReference.revision === reference.revision
    && lineageReference.path === reference.path
    && lineageReference.sha256 === reference.sha256
    && lineageReference.plan_revision === reference.plan_revision
    && lineageReference.plan_sha256 === reference.plan_sha256;
  const recoverableDeliveryMirrorPrefix = phase === "pull_request_delivery"
    && lineage.delivery.state === "ready"
    && reference.state === "previewed"
    && lineageReference?.state === "applied"
    && sameReferenceIdentity;
  if (lineageReference === null || (JSON.stringify(lineageReference) !== JSON.stringify(reference) && !recoverableDeliveryMirrorPrefix)) {
    throw new Error("GitHub effect boundary manifest and lineage preview references do not match");
  }
  const planRevision = manifest.approved_revision ?? manifest.approved_plan_revision;
  if (planRevision === null) throw new Error("GitHub effect boundary is missing its approved plan revision");
  const plan = manifest.plan_revisions[String(planRevision)];
  if (!plan) throw new Error("GitHub effect boundary is missing its approved plan record");
  const preview = await readVerifiedGithubEffectPreview({
    run_dir: runDir,
    reference,
    expected: {
      phase,
      lineage_id: manifest.task_lineage_id,
      run_id: manifest.run_id,
      plan_revision: planRevision,
      plan_sha256: plan.sha256,
    },
  });
  return {
    phase,
    rendered_preview: renderGithubEffectPreview(preview),
    preview_path: reference.path,
    preview_sha256: reference.sha256,
    permitted_next_actions: ["resume", "abandon"],
  };
}

async function readOptionalRunConfiguration(runDir: string): Promise<ResolvedRunConfiguration | null> {
  try {
    return resolvedRunConfigurationSchema.parse(JSON.parse((await readOwnedRunFile(runDir, RUN_CONFIGURATION_PATH)).toString("utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function readResourceBudgetStatus(runDir: string, manifest: RunManifestV2): Promise<ResourceBudgetStatus | null> {
  if (manifest.workflow_protocol !== "bounded-context-v1") return null;
  if (manifest.resource_budget_policy === undefined) {
    throw new Error("Bounded run manifest is missing resource budget policy");
  }
  resourceBudgetPolicyV1Schema.parse(manifest.resource_budget_policy);
  const policy = await readEffectiveResourceBudgetPolicy(runDir);
  const budget = await openResourceBudget(runDir);
  const usage = await budget.usage();
  return {
    policy,
    usage,
    remaining: {
      model_invocations: Math.max(0, policy.max_model_invocations - usage.model_invocations),
      workflow_attempts: Math.max(0, policy.max_workflow_attempts - usage.workflow_attempts),
      total_tokens: Math.max(0, policy.max_total_tokens - usage.total_tokens),
      active_elapsed_ms: Math.max(0, policy.max_active_elapsed_ms - usage.active_elapsed_ms),
      external_effects: Math.max(0, policy.max_external_effects - usage.external_effects),
    },
    token_accounting: usage.token_accounting,
    token_budget_overshot_by: usage.token_overshoot,
  };
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function readRequiredOwnedJson(runDir: string, path: string, root: string): Promise<unknown> {
  return JSON.parse((await readOwnedEvidenceFile(runDir, path, root)).toString("utf8")) as unknown;
}

async function validateRunEvents(runDir: string, manifest: RunManifestV2): Promise<RunEvent[]> {
  if (!manifest.events.includes("events.jsonl")) throw new Error("Manifest event-log pointer is missing");
  if (new Set(manifest.events).size !== manifest.events.length) throw new Error("Manifest event-log pointers must be unique");
  const events: RunEvent[] = [];
  const eventIds = new Set<string>();
  for (const path of manifest.events) {
    const bytes = await readOwnedRunFile(runDir, path);
    if (path !== "events.jsonl") continue;
    for (const line of bytes.toString("utf8").split("\n").filter(Boolean)) {
      const event = runEventSchema.parse(JSON.parse(line)) as RunEvent;
      if (event.run_id !== manifest.run_id) throw new Error("Run event provenance does not match the manifest");
      if (eventIds.has(event.event_id)) throw new Error(`Duplicate immutable run event: ${event.event_id}`);
      eventIds.add(event.event_id);
      events.push(event);
    }
  }
  return events;
}

function isDiscoveryBoundary(stage: string): stage is DiscoveryPendingAction["state"] {
  return stage === "awaiting_discovery_answer"
    || stage === "awaiting_discovery_approach"
    || stage === "awaiting_discovery_brief_approval";
}

function statusProvenanceBlocker(manifest: RunManifestV2, error: unknown): string {
  return isDiscoveryBoundary(manifest.stage)
    ? "Status provenance invalid: discovery pending action validation failed"
    : `Status provenance invalid: ${error instanceof Error ? error.message : String(error)}`;
}

async function readOwnedApproaches(runDir: string, revision: number) {
  const approachesPath = discoveryApproachesPath(revision);
  const raw = (await readOwnedEvidenceFile(runDir, approachesPath, "discovery/")).toString("utf8");
  const artifact = z.object({
    revision: z.literal(revision),
    approaches: z.array(discoveryApproachSchema),
  }).strict().parse(JSON.parse(raw));
  if (raw !== `${JSON.stringify(artifact, null, 2)}\n`) {
    throw new Error("Discovery approaches artifact is not canonical");
  }
  return artifact;
}

async function readStatusPendingAction(
  runDir: string,
  manifest: RunManifestV2,
): Promise<DiscoveryPendingAction | null> {
  if (!isDiscoveryBoundary(manifest.stage)) return null;
  if (
    !usesDurableDiscoveryProtocol(manifest.workflow_protocol)
    || manifest.discovery === null
    || manifest.discovery.pending_action_path !== discoveryPendingActionPath()
  ) {
    throw new Error("Discovery boundary is missing its canonical pending-action pointer");
  }
  const raw = (await readOwnedEvidenceFile(
    runDir,
    discoveryPendingActionPath(),
    "discovery/",
  )).toString("utf8");
  const pending = discoveryPendingActionSchema.parse(JSON.parse(raw)) as DiscoveryPendingAction;
  if (pending.state !== manifest.stage || raw !== `${JSON.stringify(pending, null, 2)}\n`) {
    throw new Error("Discovery pending action does not match the manifest stage");
  }
  const state = manifest.discovery;
  await readVerifiedDiscoveryQuestionAnswerHistory(runDir, state);
  if (pending.state === "awaiting_discovery_answer") {
    if (
      state.current_question_id !== pending.question.id
      || state.asked_questions !== pending.question.sequence
      || state.answered_questions !== pending.question.sequence - 1
    ) throw new Error("Discovery pending question coordinates do not match the manifest");
    const questionPath = discoveryQuestionPath(pending.question.sequence, state.cycle);
    const questionRaw = (await readOwnedEvidenceFile(runDir, questionPath, "discovery/")).toString("utf8");
    const question = discoveryQuestionSchema.parse(JSON.parse(questionRaw));
    if (
      questionRaw !== `${JSON.stringify(question, null, 2)}\n`
      || JSON.stringify(question) !== JSON.stringify(pending.question)
    ) throw new Error("Discovery pending question does not match its immutable artifact");
  } else if (pending.state === "awaiting_discovery_approach") {
    if (state.current_question_id !== null || state.current_approaches_revision !== pending.revision) {
      throw new Error("Discovery pending approach coordinates do not match the manifest");
    }
    const approaches = await readOwnedApproaches(runDir, pending.revision);
    if (JSON.stringify(approaches.approaches) !== JSON.stringify(pending.approaches)) {
      throw new Error("Discovery pending approaches do not match their immutable artifact");
    }
  } else {
    const record = state.brief_revisions[String(pending.revision)];
    const briefPath = discoveryBriefPath(pending.revision);
    if (
      state.current_question_id !== null
      || state.current_brief_revision !== pending.revision
      || state.current_readiness_revision !== pending.readiness_revision
      || pending.brief.revision !== pending.revision
      || state.approved_brief_revision !== null
      || state.approved_brief_sha256 !== null
      || !record
      || record.revision !== pending.revision
      || record.path !== briefPath
    ) throw new Error("Discovery pending brief coordinates do not match the manifest");
    const readinessRecord = state.readiness_revisions[String(pending.readiness_revision)];
    const readinessHistory = await readVerifiedDiscoveryReadinessHistory(runDir, state);
    const readiness = readinessHistory.find((entry) => entry.revision === pending.readiness_revision);
    if (
      !readinessRecord
      || readinessRecord.sha256 !== pending.readiness_sha256
      || !readiness
      || JSON.stringify(readiness.outcome.brief) !== JSON.stringify(pending.brief)
    ) throw new Error("Discovery pending brief does not match its readiness provenance");
    if (state.selected_approach_id === null) {
      if (
        state.current_approaches_revision !== null
        || pending.brief.selected_approach_id !== null
        || pending.brief.selected_approach_rationale !== null
      ) {
        throw new Error("Discovery pending brief records an unowned approach selection");
      }
    } else {
      const approachesRevision = state.current_approaches_revision;
      if (
        approachesRevision === null
        || pending.brief.selected_approach_id !== state.selected_approach_id
        || !pending.brief.selected_approach_rationale?.trim()
      ) throw new Error("Discovery pending brief does not match the selected approach state");
      const approaches = await readOwnedApproaches(runDir, approachesRevision);
      if (!approaches.approaches.some((approach) => approach.id === state.selected_approach_id)) {
        throw new Error("Discovery selected approach is not present in its immutable approaches artifact");
      }
      const selectionPath = discoveryApproachSelectionPath(approachesRevision);
      const selectionRaw = (await readOwnedEvidenceFile(runDir, selectionPath, "discovery/")).toString("utf8");
      const selection = z.object({
        revision: z.literal(approachesRevision),
        approach_id: z.string().min(1),
      }).strict().parse(JSON.parse(selectionRaw));
      if (
        selectionRaw !== `${JSON.stringify(selection, null, 2)}\n`
        || selection.approach_id !== state.selected_approach_id
      ) throw new Error("Discovery pending brief selection does not match its immutable artifact");
    }
    const briefRaw = (await readOwnedEvidenceFile(runDir, briefPath, "discovery/")).toString("utf8");
    const brief = discoveryBriefSchema.parse(JSON.parse(briefRaw));
    if (
      briefRaw !== `${JSON.stringify(brief, null, 2)}\n`
      || JSON.stringify(brief) !== JSON.stringify(pending.brief)
      || discoverySha256(briefRaw) !== record.sha256
    ) throw new Error("Discovery pending brief does not match its immutable artifact and digest");
  }
  return pending;
}

async function inspectStatusEvidence(runDir: string, manifest: RunManifestV2): Promise<OperatorStatusEvidence> {
  if (usesDurableDiscoveryProtocol(manifest.workflow_protocol) && manifest.discovery !== null) {
    await readVerifiedDiscoveryQuestionAnswerHistory(runDir, manifest.discovery);
    await readVerifiedDiscoveryReadinessHistory(runDir, manifest.discovery);
  }
  resolvePendingReplanTarget(manifest);
  const currentProgress = manifest.current_work_item_id === null
    ? undefined
    : manifest.work_item_progress[manifest.current_work_item_id];
  const selectedWorkItemId = typeof currentProgress?.review_cycle_path === "string"
    ? manifest.current_work_item_id
    : typeof manifest.work_item_progress.integrated?.review_cycle_path === "string"
      ? "integrated"
      : manifest.current_work_item_id;
  const cycles = new Map<string, {
    cycle: ReviewCycleState;
    effectState: ReviewEffectState;
    completion: ReviewCycleState | null;
  }>();
  for (const [progressWorkItemId, progress] of Object.entries(manifest.work_item_progress)) {
    const cyclePath = typeof progress.review_cycle_path === "string" ? progress.review_cycle_path : null;
    if ((cyclePath === null) !== (typeof progress.review_effect_id !== "string")) {
      throw new Error(`Review-cycle and effect manifest pointers must be present together for ${progressWorkItemId}`);
    }
    if (cyclePath === null) continue;
    const cycle = reviewCycleStateSchema.parse(await readRequiredOwnedJson(runDir, cyclePath, "reviews/decisions/"));
    const expectedCycleId = `review-cycle:${hash([
      cycle.work_item_id,
      cycle.phase,
      cycle.review_revision,
      cycle.policy_hash,
      cycle.finding_ids,
      cycle.accounting_before,
      cycle.work_item_progress_reference ?? null,
    ])}`;
    const expectedEffectId = `review-effect:${hash([cycle.cycle_id, cycle.decision])}`;
    const policy = manifest.review_policy_snapshot;
    const accounting = manifest.review_accounting;
    if (!policy || !accounting) throw new Error("Review-cycle pointers require a snapshotted policy and accounting");
    if (
      cycle.decision_path !== cyclePath
      || cycle.decision_path !== reviewDecisionPath(cycle.work_item_id, cycle.review_revision)
      || cycle.work_item_id !== progressWorkItemId
      || cycle.review_revision !== progress.review_revision
      || cycle.effect_id !== progress.review_effect_id
      || cycle.cycle_id !== expectedCycleId
      || cycle.effect_id !== expectedEffectId
      || cycle.policy_hash !== hash(policy)
      || cycle.decision.policy_revision !== policy.policy_revision
      || cycle.review_revision > accounting.review_revision
      || cycle.accounting_before.plan_revision > accounting.plan_revision
      || !manifest.plan_revisions[String(cycle.accounting_before.plan_revision)]
      || cycle.decision.finding_ids.some((id) => !cycle.finding_ids.includes(id))
    ) throw new Error(`Status review-cycle pointer does not match immutable policy/accounting/progress provenance for ${progressWorkItemId}`);
    if (progressWorkItemId === selectedWorkItemId && (
      cycle.review_revision !== accounting.review_revision
      || cycle.accounting_before.plan_revision !== accounting.plan_revision
    )) throw new Error(`Active status review-cycle accounting is stale for ${progressWorkItemId}`);
    const owner = `runtime:${cycle.phase === "work_item" ? "work-item" : cycle.phase}:${cycle.work_item_id}`;
    const persistedEffect = await validatePersistedReviewEffectState(runDir, cycle, owner);
    const effectState = persistedEffect.effect_state;
    const reference = cycle.work_item_progress_reference;
    if (reference && effectState === "pending" && (
      reference.attempts !== progress.attempts
      || reference.review_path !== progress.review_path
      || reference.verification_path !== progress.verification_path
    )) throw new Error(`Status active review-cycle progress reference is stale for ${progressWorkItemId}`);
    cycles.set(progressWorkItemId, { cycle, effectState, completion: persistedEffect.completion });
  }

  const selected = selectedWorkItemId === null ? undefined : cycles.get(selectedWorkItemId);
  const selectedProgress = selectedWorkItemId === null ? undefined : manifest.work_item_progress[selectedWorkItemId];
  const cycle = selected?.cycle ?? null;
  const effectState = selected?.effectState ?? null;

  const workItemId = cycle?.work_item_id ?? manifest.current_work_item_id ?? "integrated";
  let report: ReturnType<typeof convergenceReportSchema.parse> | null = null;
  const reportsByWorkItem = new Map<string, ReturnType<typeof convergenceReportSchema.parse>>();
  for (const [pointerWorkItemId, summary] of Object.entries(manifest.convergence_reports ?? {})) {
    const candidate = convergenceReportSchema.parse(await readRequiredOwnedJson(
      runDir, summary.path, "reviews/convergence/",
    ));
    if (
      candidate.work_item_id !== pointerWorkItemId
      || candidate.review_revision !== summary.review_revision
      || candidate.plan_revision !== summary.plan_revision
      || candidate.recommended_action !== summary.recommended_action
      || summary.path !== convergenceReportPath(pointerWorkItemId, summary.plan_revision, summary.review_revision)
      || candidate.policy_revision !== manifest.review_policy_snapshot?.policy_revision
      || !manifest.plan_revisions[String(candidate.plan_revision)]
      || [...candidate.unresolved_finding_ids, ...candidate.resolved_finding_ids, ...candidate.repeated_finding_ids,
        ...candidate.advisory_finding_ids, ...candidate.follow_up_finding_ids].some((id) => manifest.finding_index?.[id] === undefined)
    ) throw new Error("Status convergence summary does not match immutable policy/finding provenance");
    if (cycle && cycle.work_item_id === pointerWorkItemId && cycle.review_revision === candidate.review_revision) {
      const expectedRecommendation = cycle.decision.action === "stop" ? "stop"
        : cycle.decision.action === "create_replan" ? "create_replan"
          : cycle.decision.action === "advance" || cycle.decision.action === "continue_with_warning" ? "advance" : null;
      if (expectedRecommendation === null
        || candidate.recommended_action !== expectedRecommendation
        || candidate.decision_reason_code !== cycle.decision.reason_code
        || candidate.unresolved_finding_ids.some((id) => !cycle.finding_ids.includes(id))) {
        throw new Error("Status convergence report does not match its immutable review decision");
      }
    }
    if (candidate.authorization) {
      const authorizationPath = `authorizations/${Buffer.from(pointerWorkItemId, "utf8").toString("base64url")}/revision-${candidate.review_revision}.json`;
      const authorization = warningContinuationAuthorizationSchema.parse(await readRequiredOwnedJson(
        runDir, authorizationPath, "authorizations/",
      ));
      if (JSON.stringify(authorization) !== JSON.stringify(candidate.authorization)
        || authorization.actor !== manifest.warning_continuation_authority?.actor
        || authorization.source !== manifest.warning_continuation_authority?.source
        || authorization.policy_revision !== candidate.policy_revision
        || JSON.stringify(authorization.finding_ids) !== JSON.stringify(candidate.unresolved_finding_ids)
        || authorization.evidence_snapshot.some((path) => !candidate.evidence_refs.includes(path))) {
        throw new Error("Status warning authorization does not match immutable run authority");
      }
    }
    reportsByWorkItem.set(pointerWorkItemId, candidate);
    if (pointerWorkItemId === workItemId) report = candidate;
  }
  for (const [cycleWorkItemId, persisted] of cycles) {
    const action = persisted.cycle.decision.action;
    const convergence = reportsByWorkItem.get(cycleWorkItemId);
    if (action === "await_plan_approval") {
      if (!convergence
        || convergence.review_revision >= persisted.cycle.review_revision
        || convergence.recommended_action !== "create_replan") {
        throw new Error("Awaiting-plan review cycle requires its prior create-replan convergence report");
      }
      continue;
    }
    if (!isReviewEffectAction(action) && (persisted.effectState === "complete" || persisted.effectState === "blocked")) {
      if (!convergence || convergence.review_revision !== persisted.cycle.review_revision) {
        throw new Error(`Review action ${action} requires its exact convergence report`);
      }
      if (action === "continue_with_warning" && convergence.authorization === null) {
        throw new Error("Warning continuation requires exact immutable authorization");
      }
      if (action !== "continue_with_warning" && convergence.authorization !== null) {
        throw new Error("Only warning continuation may carry convergence authorization");
      }
    } else if (action === "continue_with_warning" && convergence && convergence.authorization === null) {
      throw new Error("Warning continuation convergence requires exact immutable authorization");
    }
  }
  for (const [sourceWorkItemId, progress] of Object.entries(manifest.work_item_progress)) {
    if (typeof progress.replan_patch_path !== "string") continue;
    if (typeof progress.replan_source_work_item_id === "string") {
      const source = manifest.work_item_progress[progress.replan_source_work_item_id];
      if (!source
        || source.replan_target_work_item_id !== sourceWorkItemId
        || source.replan_patch_path !== progress.replan_patch_path) {
        throw new Error("Active replan concrete target lineage does not match its source cycle");
      }
      continue;
    }
    const persisted = cycles.get(sourceWorkItemId);
    if (!persisted) throw new Error("Active replan patch is missing its review-cycle pointer");
    await validateActiveReplanPatch(
      runDir,
      manifest,
      sourceWorkItemId,
      progress.replan_patch_path,
      persisted.cycle,
      persisted.completion,
    );
  }
  const currentReport = report && (cycle === null || report.review_revision === cycle.review_revision)
    ? report
    : null;
  const activeFindingIds = currentReport?.unresolved_finding_ids ?? cycle?.finding_ids ?? [];
  const forceReleaseBlocker = activeFindingIds.some((id) => {
    const finding = manifest.finding_index?.[id];
    return finding?.severity === "critical"
      || finding?.severity === "high"
      || finding?.disposition === "blocking"
      || finding?.disposition === "fix_in_scope"
      || finding?.disposition === "requires_replan";
  });
  const blockerCode = currentProgress?.blocker_code ?? selectedProgress?.blocker_code;
  const operationalBlockerCodes = new Set([
    "operational_blocker",
    "test_infrastructure_blocker",
    "backup_profile_unavailable",
    "primary_usage_limit_no_backup",
    "ambiguous_hands_invocation",
    "invalid_reviewer_action_queue",
  ]);
  if (manifest.review_accounting) {
    await loadSuccessfulFixProvenance(runDir, manifest.review_accounting);
  }
  return {
    active_finding_ids: activeFindingIds,
    latest_decision: cycle?.decision.action ?? null,
    latest_effect_state: effectState,
    warning_authorized: currentReport?.authorization !== null && currentReport?.authorization !== undefined,
    force_release_blocker: forceReleaseBlocker
      || blockerCode === "replan_required"
      || blockerCode === "escalation_exhausted"
      || blockerCode === "action_fix_exhausted",
    operational_blocker: blockerCode !== undefined && operationalBlockerCodes.has(blockerCode),
    convergence_report_path: manifest.convergence_reports?.[workItemId]?.path ?? null,
  };
}

export async function readOperatorStatus(runDir: string, options: {
  assurance?: AssuranceAssessmentOptions;
  assuranceAssessment?: AssuranceAssessment;
  assessAssurance?: boolean;
  approvalVerificationHooks?: {
    afterRunConfigurationRead?: (configuration: ResolvedRunConfiguration) => Promise<void>;
  };
} = {}): Promise<V2StatusSummary> {
  let manifest = await readManifestV2(runDir);
  try {
    manifest = await reconcileRecoveryJournal(runDir);
    const requiresVerifiedConfiguration = await requiresPinnedRuntimeAuthority(runDir, manifest);
    const [evidence, assurance, , pendingAction, ordinaryRunConfiguration, verifiedApproval, effectBoundary, resourceBudget] = await settleStatusReads([
      inspectStatusEvidence(runDir, manifest),
      options.assuranceAssessment !== undefined
        ? readSuppliedAssuranceAssessment(runDir, manifest, options.assuranceAssessment)
        : options.assessAssurance === false ? Promise.resolve(null) : assessFinalDelivery(runDir, options.assurance),
      validateRunEvents(runDir, manifest),
      readStatusPendingAction(runDir, manifest),
      manifest.pending_plan_approval === null
        ? requiresVerifiedConfiguration
          ? readVerifiedRunConfiguration(runDir, manifest)
          : readOptionalRunConfiguration(runDir)
        : Promise.resolve(null),
      manifest.pending_plan_approval === null
        ? Promise.resolve(null)
        : verifyPersistedPlanApprovalSubject(
          runDir,
          manifest,
          manifest.pending_plan_approval.proposed_revision,
          { hooks: options.approvalVerificationHooks },
        ),
      readStatusEffectBoundary(runDir, manifest),
      readResourceBudgetStatus(runDir, manifest),
    ] as const);
    return projectOperatorStatus(
      manifest,
      evidence,
      assurance,
      pendingAction,
      runDir,
      verifiedApproval?.runConfiguration ?? ordinaryRunConfiguration,
      effectBoundary,
      resourceBudget,
      verifiedApproval?.request ?? null,
    );
  } catch (error) {
    return projectOperatorStatus(manifest, {
      operational_blocker: true,
      projection_blocker: statusProvenanceBlocker(manifest, error),
    }, null, null, runDir);
  }
}

async function readSuppliedAssuranceAssessment(
  runDir: string,
  manifest: RunManifestV2,
  suppliedAssessment: AssuranceAssessment,
): Promise<AssuranceAssessment> {
  if (manifest.assurance_assessment_path === null) {
    throw new Error("Supplied assurance assessment requires a durable manifest pointer");
  }
  const raw = await readOwnedEvidenceFile(runDir, manifest.assurance_assessment_path, "assurance/");
  const persistedAssessment = assuranceAssessmentSchema.parse(JSON.parse(raw.toString("utf8")));
  const validatedSuppliedAssessment = assuranceAssessmentSchema.parse(suppliedAssessment);
  if (JSON.stringify(persistedAssessment) !== JSON.stringify(validatedSuppliedAssessment)) {
    throw new Error("Supplied assurance assessment does not match the persisted assurance artifact");
  }
  if (manifest.assurance_outcome !== persistedAssessment.outcome) {
    throw new Error("Supplied assurance outcome does not match the manifest assurance outcome");
  }
  return persistedAssessment;
}

export async function readRunLog(runDir: string): Promise<{ status: V2StatusSummary; events: RunEvent[] }> {
  let manifest = await readManifestV2(runDir);
  try {
    manifest = await reconcileRecoveryJournal(runDir);
    const requiresVerifiedConfiguration = await requiresPinnedRuntimeAuthority(runDir, manifest);
    const [evidence, events, assurance, pendingAction, ordinaryRunConfiguration, verifiedApproval, effectBoundary, resourceBudget] = await settleStatusReads([
      inspectStatusEvidence(runDir, manifest),
      validateRunEvents(runDir, manifest),
      assessFinalDelivery(runDir),
      readStatusPendingAction(runDir, manifest),
      manifest.pending_plan_approval === null
        ? requiresVerifiedConfiguration
          ? readVerifiedRunConfiguration(runDir, manifest)
          : readOptionalRunConfiguration(runDir)
        : Promise.resolve(null),
      manifest.pending_plan_approval === null
        ? Promise.resolve(null)
        : verifyPersistedPlanApprovalSubject(
          runDir,
          manifest,
          manifest.pending_plan_approval.proposed_revision,
        ),
      readStatusEffectBoundary(runDir, manifest),
      readResourceBudgetStatus(runDir, manifest),
    ] as const);
    return {
      status: projectOperatorStatus(
        manifest,
        evidence,
        assurance,
        pendingAction,
        runDir,
        verifiedApproval?.runConfiguration ?? ordinaryRunConfiguration,
        effectBoundary,
        resourceBudget,
        verifiedApproval?.request ?? null,
      ),
      events,
    };
  } catch (error) {
    return {
      status: projectOperatorStatus(manifest, {
        operational_blocker: true,
        projection_blocker: statusProvenanceBlocker(manifest, error),
      }, null, null, runDir),
      events: [],
    };
  }
}

async function settleStatusReads<T extends readonly unknown[]>(
  reads: { [K in keyof T]: Promise<T[K]> },
): Promise<T> {
  const results = await Promise.allSettled(reads);
  const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (rejected) throw rejected.reason;
  return results.map((result) => (result as PromiseFulfilledResult<unknown>).value) as unknown as T;
}

export function renderRunStatus(status: V2StatusSummary): string {
  return [
    `Run ID: ${status.run_id}`,
    "Schema: v2",
    `Operator state: ${status.operator_state_label} (${status.operator_state})`,
    ...renderRecoveryStatus(status),
    `Mode: ${status.mode}`,
    `Stage: ${status.stage}`,
    `Task lineage: ${status.github_task_lineage_id ?? status.task_lineage_id ?? "none"}`,
    ...(status.github_task_lineage_id !== null && status.task_lineage_id !== null
      ? [`Recovery task lineage: ${status.task_lineage_id}`]
      : []),
    `GitHub cleanup: ${status.github_cleanup_state ?? "not required"}`,
    ...(status.github_cleanup_state !== null && status.github_cleanup_state !== "complete"
      ? [`GitHub cleanup incomplete targets: ${formatNumberList(status.github_cleanup_pending_targets)}`]
      : []),
    `Current plan revision: ${status.current_revision ?? "none"}`,
    `Approved plan revision: ${status.approved_revision ?? "none"}`,
    `Current work item: ${status.current_work_item_id ?? "none"}`,
    `Review revision: ${status.review_revision ?? "legacy/not recorded"}`,
    `Fix cycles: ${status.fix_cycles_used === null ? "legacy/not recorded" : `${status.fix_cycles_used}/${status.max_fix_cycles ?? "unknown"}`}`,
    `Plan lineage revision: ${status.plan_revision ?? "legacy/not recorded"}`,
    `Active findings: ${status.active_finding_ids.length === 0 ? "none" : status.active_finding_ids.join(", ")}`,
    `Latest policy decision: ${status.latest_decision ?? "none"}`,
    `Latest effect state: ${status.latest_effect_state ?? "none"}`,
    `Warning continuation authorization: ${status.warning_continuation_authorized ? "recorded" : "none"}`,
    `Next automatic effect: ${status.next_automatic_effect ?? "none"}`,
    `Approval boundary: ${status.approval_boundary}`,
    `Issue numbers: ${formatNumberList(status.issue_numbers)}`,
    `Pull request numbers: ${formatNumberList(status.pull_request_numbers)}`,
    `Delivery: ${status.delivery_state}`,
    `Assurance outcome: ${status.assurance_outcome ?? "not evaluated"}`,
    `Assurance blocker: ${status.assurance_assessment?.blocker ?? "none"}`,
    ...renderResourceBudgetStatus(status.resource_budget),
    `Blocker: ${status.blocker ?? "none"}`,
    ...renderGithubEffectBoundary(status),
    ...renderGithubCleanupAction(status),
    ...renderDiscoveryAction(status),
    ...renderPlanApproval(status),
  ].join("\n");
}

function renderRecoveryStatus(status: V2StatusSummary): string[] {
  if (status.operator_state !== "diagnostic_stop") return [];
  const run = status.run_dir === null ? "<runDir>" : quotePosixShellArgument(status.run_dir);
  return [
    `Recovery scope: ${status.recovery_scope ?? "none"}`,
    `Repeated blocker: ${status.blocker_fingerprint ?? "none"}`,
    `Progress subject: ${status.progress_subject_sha256 ?? "none"}`,
    `No material progress: ${status.consecutive_without_progress ?? 0} distinct attempts`,
    `Diagnostic: ${status.diagnostic_path ?? "none"}`,
    `Next command: brain-hands resume --run ${run} --actor <actor> --recovery-note-file <path>`,
  ];
}

function renderGithubCleanupAction(status: V2StatusSummary): string[] {
  if (status.github_cleanup_state === null || status.github_cleanup_state === "complete") return [];
  const run = status.run_dir === null ? "<runDir>" : quotePosixShellArgument(status.run_dir);
  return [`Next command (reconcile-github): brain-hands reconcile-github --run ${run} --apply`];
}

function renderGithubEffectBoundary(status: V2StatusSummary): string[] {
  const boundary = status.effect_boundary;
  if (boundary === null) return [];
  const run = status.run_dir === null ? "<runDir>" : quotePosixShellArgument(status.run_dir);
  return [
    `GitHub effect phase: ${boundary.phase}`,
    `GitHub effect preview path: ${boundary.preview_path}`,
    `GitHub effect preview SHA-256: ${boundary.preview_sha256}`,
    "GitHub effect preview:",
    boundary.rendered_preview,
    `Next command (resume): brain-hands resume --run ${run}`,
    `Next command (abandon): brain-hands abandon --run ${run} --actor <actor> --reason <reason>`,
  ];
}

function budgetLine(label: string, used: number, limit: number, remaining: number, unit = ""): string {
  const suffix = unit ? ` ${unit}` : "";
  return `Resource budget ${label}: ${used}/${limit}${suffix} used; ${remaining}${suffix} remaining`;
}

function renderResourceBudgetStatus(status: ResourceBudgetStatus | null): string[] {
  if (status === null) return ["Resource budget: not enabled"];
  return [
    budgetLine("model invocations", status.usage.model_invocations, status.policy.max_model_invocations, status.remaining.model_invocations),
    budgetLine("workflow attempts", status.usage.workflow_attempts, status.policy.max_workflow_attempts, status.remaining.workflow_attempts),
    budgetLine("tokens", status.usage.total_tokens, status.policy.max_total_tokens, status.remaining.total_tokens),
    budgetLine("active elapsed", status.usage.active_elapsed_ms, status.policy.max_active_elapsed_ms, status.remaining.active_elapsed_ms, "ms"),
    budgetLine("external effects", status.usage.external_effects, status.policy.max_external_effects, status.remaining.external_effects),
    `Resource budget token accounting: ${status.token_accounting}`,
    `Resource budget token overshoot: ${status.token_budget_overshot_by}`,
  ];
}

const DELTA_CATEGORY_LABELS = {
  objective: "objectives",
  scope: "scope",
  files: "files",
  acceptance: "acceptance criteria",
  verification: "verification",
  risks: "risks",
  external_effects: "external effects",
  destructive_actions: "destructive actions",
} as const;

function countInitialAuthorization(request: PlanApprovalRequestV1): {
  workItems: number;
  changeableFiles: number;
  verificationCommands: number;
  browserChecks: number;
  destructiveFileOperations: number;
  risks: number;
} {
  const workItems = new Set<string>();
  const changeableFiles = new Set<string>();
  let verificationCommands = 0;
  let browserChecks = 0;
  let destructiveFileOperations = 0;
  let risks = 0;
  for (const entry of request.delta.entries) {
    const match = entry.pointer.match(/^\/work_items\/([^/]+)\//);
    if (match?.[1]) workItems.add(match[1]);
    if (entry.pointer.includes("/file_contract/") && entry.after !== null) {
      const permission = (entry.after as { permission?: unknown }).permission;
      if (permission === "create" || permission === "modify" || permission === "delete") {
        changeableFiles.add(entry.pointer);
      }
      if (permission === "delete") destructiveFileOperations += 1;
    }
    if (entry.pointer.includes("/verification_commands/") && entry.after !== null) {
      verificationCommands += 1;
    }
    if (entry.pointer === "/integration_verification" && Array.isArray(entry.after)) {
      verificationCommands += entry.after.length;
    }
    if (entry.pointer.includes("/browser_checks/") && entry.after !== null) browserChecks += 1;
    if ((entry.pointer === "/risks" || entry.pointer.endsWith("/risks")) && Array.isArray(entry.after)) {
      risks += entry.after.length;
    }
  }
  return {
    workItems: workItems.size,
    changeableFiles: changeableFiles.size,
    verificationCommands,
    browserChecks,
    destructiveFileOperations,
    risks,
  };
}

function renderPlanApproval(status: V2StatusSummary): string[] {
  const request = status.plan_approval_request;
  if (request === null || status.operator_state !== "awaiting_plan_approval") return [];
  const revision = request.subject.plan_revision;
  const run = status.run_dir === null ? "<runDir>" : quotePosixShellArgument(status.run_dir);
  const common = [
    `Plan SHA-256: ${request.subject.plan_sha256}`,
    `Approval subject SHA-256: ${request.approval_subject_sha256}`,
    `Full plan: ${request.plan_path}`,
  ];
  const details = request.subject.reason_code === "initial_plan"
    ? (() => {
        const counts = countInitialAuthorization(request);
        const effects = status.run_configuration?.github.effects === "issues_and_pull_request"
          ? `issues and one pull request via ${status.run_configuration.github.default_remote}`
          : "none";
        return [
          "Approval required: initial plan",
          "Why: The exact initial plan must be approved before implementation begins.",
          `Proposed revision: ${revision}`,
          ...common,
          "",
          "Authorization summary:",
          `  Work items: ${counts.workItems}`,
          `  Changeable files: ${counts.changeableFiles}`,
          `  Verification commands: ${counts.verificationCommands}`,
          `  Browser checks: ${counts.browserChecks}`,
          `  Destructive file operations: ${counts.destructiveFileOperations}`,
          `  Risks: ${counts.risks}`,
          `  GitHub effects: ${effects}`,
          "  Merge policy: manual only",
        ];
      })()
    : [
        "Approval required: material replan",
        "Why: Verifier findings require changes outside the currently approved decision contract.",
        `Base revision: ${request.subject.base_plan_revision}`,
        `Proposed revision: ${revision}`,
        ...common,
        "",
        ...Object.entries(DELTA_CATEGORY_LABELS).flatMap(([category, label]) => {
          const entries = request.delta.entries.filter((entry) => entry.category === category);
          return entries.length === 0
            ? []
            : [`Changed ${label}:`, ...entries.map((entry) => `  ${entry.operation} ${entry.pointer}`)];
        }),
        `Unchanged high-impact categories: ${request.delta.unchanged_high_impact_categories
          .map((category) => DELTA_CATEGORY_LABELS[category]).join(", ") || "none"}`,
      ];
  return [
    ...details,
    "Additional approvals expected: only if another material replan is prepared.",
    `Next command (approve-plan): brain-hands approve-plan --run ${run} --revision ${revision}`,
  ];
}

function renderDiscoveryAction(status: V2StatusSummary): string[] {
  const pending = status.pending_action;
  const run = status.run_dir === null ? "<runDir>" : quotePosixShellArgument(status.run_dir);
  if (pending?.state === "awaiting_discovery_answer") {
    return [
      `Discovery question: ${pending.question.text}`,
      ...renderQuestionRecommendation(pending.question),
      `Next command (answer-discovery): brain-hands answer-discovery --run ${run} --question ${pending.question.id} --input-file <path>`,
      `Next command (proceed-discovery): brain-hands proceed-discovery --run ${run} --question ${pending.question.id} --input-file <path>`,
    ];
  }
  if (pending?.state === "awaiting_discovery_approach") {
    return [
      `Discovery approach IDs: ${pending.approaches.map((approach) => approach.id).join(", ")}`,
      ...renderApproachRecommendation(pending.approaches),
      ...pending.approaches.map((approach) =>
        `Next command (${approach.id}): brain-hands select-discovery-approach --run ${run} --revision ${pending.revision} --approach ${approach.id}`),
    ];
  }
  if (pending?.state === "awaiting_discovery_brief_approval") {
    return [
      `Discovery brief revision: ${pending.revision}`,
      `Next command (approve-discovery): brain-hands approve-discovery --run ${run} --revision ${pending.revision}`,
      `Next command (revise-discovery): brain-hands revise-discovery --run ${run} --revision ${pending.revision} --input-file <path>`,
    ];
  }
  return [];
}

function renderQuestionRecommendation(question: DiscoveryQuestion): string[] {
  if (
    question.recommended_choice_id === undefined
    || question.recommendation_rationale === undefined
    || question.recommended_choice_id === null
    || question.recommendation_rationale === null
  ) return [];
  return [
    `Recommended choice: ${question.recommended_choice_id}`,
    `Recommendation rationale: ${question.recommendation_rationale}`,
  ];
}

function renderApproachRecommendation(approaches: Extract<DiscoveryPendingAction, { state: "awaiting_discovery_approach" }>["approaches"]): string[] {
  const recommended = approaches.find((approach) => approach.recommended && approach.recommendation_rationale?.trim());
  if (recommended === undefined) return [];
  return [
    `Recommended approach: ${recommended.id}`,
    `Recommendation rationale: ${recommended.recommendation_rationale}`,
  ];
}

function quotePosixShellArgument(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function formatRunStatusComment(status: V2StatusSummary): { marker: string; body: string } {
  const marker = `<!-- brain-hands-run-status:${status.run_id} -->`;
  if (isDiscoveryBoundary(status.stage)) {
    return { marker, body: `${marker}\nAwaiting local discovery input.` };
  }
  if (status.stage === "awaiting_plan_approval") {
    if (status.plan_approval_request !== null && status.operator_state === "awaiting_plan_approval") {
      return {
        marker,
        body: `${marker}\nLocal plan approval required for revision ${status.plan_approval_request.subject.plan_revision}.`,
      };
    }
    if (status.operator_state === "operationally_blocked") {
      return { marker, body: `${marker}\nOperationally blocked; inspect local status.` };
    }
    return { marker, body: `${marker}\nLocal plan approval status requires attention.` };
  }
  if (status.stage === "replanning" || status.latest_decision === "create_replan") {
    return { marker, body: `${marker}\nLocal replan status requires attention.` };
  }
  return {
    marker,
    body: [
      marker,
      "## Brain Hands run status",
      "",
      `**${status.operator_state_label}**`,
      "",
      `- Stage: \`${status.stage}\``,
      `- Work item: \`${status.current_work_item_id ?? "none"}\``,
      `- Review revision: ${status.review_revision ?? "legacy/not recorded"}`,
      `- Fix cycles: ${status.fix_cycles_used === null ? "legacy/not recorded" : `${status.fix_cycles_used}/${status.max_fix_cycles ?? "unknown"}`}`,
      `- Plan revision: ${status.plan_revision ?? "legacy/not recorded"}`,
      `- Active findings: ${status.active_finding_ids.length === 0 ? "none" : status.active_finding_ids.map((id) => `\`${id}\``).join(", ")}`,
      `- Next automatic effect: ${status.next_automatic_effect ?? "none"}`,
      `- Warning continuation authorization: ${status.warning_continuation_authorized ? "recorded" : "none"}`,
      `- Approval boundary: ${status.approval_boundary}`,
      ...(status.blocker ? [`- Blocker: ${status.blocker}`] : []),
      "",
      "Brain Hands never merges pull requests automatically.",
    ].join("\n"),
  };
}

function formatMaybeNumber(value: number | null): string {
  return value === null ? "none" : `#${value}`;
}

function formatNumberList(values: number[]): string {
  return values.length === 0 ? "none" : values.map((value) => `#${value}`).join(", ");
}

function nextIssueNumber(manifest: RunManifest): number | null {
  if (manifest.current_issue !== null) {
    return manifest.current_issue;
  }

  return manifest.issue_numbers[0] ?? null;
}

function commandForStage(stage: WorkflowStage, runDir: string, manifest: RunManifest): string {
  const issueNumber = nextIssueNumber(manifest);
  const prNumber = manifest.current_pr;

  switch (stage) {
    case "ready_for_hands":
      return issueNumber === null
        ? "Inspect issues.json and pick the next issue to implement."
        : `Run brain-hands implement --run "${runDir}" --issue ${issueNumber}.`;
    case "local_verification":
      if (issueNumber === null) {
        return "Inspect verification artifacts and rerun the blocked workflow step.";
      }
      return prNumber === null
        ? `Review verification/issue-${issueNumber}/evidence.json, fix the repo, then rerun brain-hands implement --run "${runDir}" --issue ${issueNumber}.`
        : `Review verification/issue-${issueNumber}/evidence.json, fix the repo, then rerun brain-hands fix --run "${runDir}" --issue ${issueNumber} --pr ${prNumber}.`;
    case "pull_request":
    case "brain_review":
      return issueNumber !== null && prNumber !== null
        ? `Run brain-hands review --run "${runDir}" --issue ${issueNumber} --pr ${prNumber}.`
        : "Inspect the open PR state and rerun the review step.";
    case "fixing":
      return issueNumber !== null && prNumber !== null
        ? `Run brain-hands fix --run "${runDir}" --issue ${issueNumber} --pr ${prNumber}.`
        : "Inspect reviews/ and rerun the fix step for the active PR.";
    case "merge_ready":
      return "Review the approved PR manually and merge it yourself; brain-hands does not auto-merge.";
    case "final_audit":
      return `Run brain-hands final-audit --run "${runDir}" --repo "${manifest.repo_root}".`;
    case "complete":
      return "No action required; the run is complete.";
    case "replan":
      return "Revisit research.md, architecture-plan.md, and issues.json before starting new implementation work.";
    default:
      return "Inspect the run artifacts and resume the workflow from the current stage.";
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function summarizeRun(runDir: string): Promise<string> {
  try {
    const manifest = await readManifestV2(runDir);
    const status = await readOperatorStatus(runDir);
    const activity = await summarizeProgressActivity(runDir, manifest);
    return [
      renderRunStatus(status),
      `Parent issue: ${formatMaybeNumber(status.parent_issue_number)}`,
      `Work-item issue map: ${Object.entries(status.work_item_issue_map).sort(([a], [b]) => a.localeCompare(b)).map(([id, issue]) => `${id}=#${issue}`).join(", ") || "none"}`,
      `Activity: ${activity?.latest.safe_label ?? "unavailable"}`,
      ...(activity ? [
        `Activity phase: ${activity.phase}`,
        `Activity health: ${activity.health.replaceAll("_", " ")}`,
        `Activity age: ${activity.age_seconds} seconds`,
        `Last heartbeat: ${activity.last_heartbeat_at ?? "none"}`,
        `Activity role: ${activity.latest.source}`,
        `Activity model: ${activity.latest.model ?? "none"}`,
        `Reasoning effort: ${activity.latest.reasoning_effort ?? "none"}`,
        `Worker session: ${activity.latest.worker_session_id ?? "none"}`,
        `Worker PID: ${activity.latest.worker_pid ?? "none"}`,
        `Child PID: ${activity.latest.child_pid ?? "none"}`,
      ] : []),
    ].join("\n");
  } catch (error) {
    try {
      const raw = JSON.parse(await readFile(join(runDir, "manifest.json"), "utf8")) as Record<string, unknown>;
      if (raw.version === 2 || raw.schema_version === 2) throw error;
    } catch (readError) {
      if (readError === error) throw error;
    }
    // Keep the legacy read-only status helper available for migration tooling.
  }
  const manifest = await readManifest(runDir);

  return [
    `Run ID: ${manifest.run_id}`,
    `Stage: ${manifest.stage}`,
    `Current issue: ${formatMaybeNumber(manifest.current_issue)}`,
    `Current PR: ${formatMaybeNumber(manifest.current_pr)}`,
    `Issue numbers: ${formatNumberList(manifest.issue_numbers)}`,
    `PR numbers: ${formatNumberList(manifest.pr_numbers)}`,
    `Updated at: ${manifest.updated_at}`,
    `Next action: ${commandForStage(manifest.stage, runDir, manifest)}`,
  ].join("\n");
}

/** Return a machine-readable v2 status without accepting a legacy manifest. */
export async function summarizeRunV2(runDir: string): Promise<V2StatusSummary> {
  return readOperatorStatus(runDir);
}

export async function resumeRun(input: ResumeRunInput): Promise<string> {
  try {
    await reconcileClaimedInitialPlanBoundary(input.runDir);
    const manifest = await readManifestV2(input.runDir);
    await inspectStatusEvidence(input.runDir, manifest);
    return resumeRunV2Message(manifest, input.runDir);
  } catch (error) {
    try {
      const raw = JSON.parse(await readFile(join(input.runDir, "manifest.json"), "utf8")) as Record<string, unknown>;
      if (raw.version === 2 || raw.schema_version === 2) throw error;
    } catch (readError) {
      if (readError === error) throw error;
    }
    // Keep the legacy guidance path available for old-run recovery tooling.
  }
  const manifest = await readManifest(input.runDir);
  const issueNumber = nextIssueNumber(manifest);
  const prNumber = manifest.current_pr;
  const reviewPath = prNumber === null ? null : join(input.runDir, "reviews", `pr-${prNumber}-review.json`);
  const auditPath = join(input.runDir, "final-audit.md");

  switch (manifest.stage) {
    case "ready_for_hands":
      return issueNumber === null
        ? "The run is ready for hands work, but no issue number is recorded. Inspect issues.json and choose the first planned issue before implementing."
        : [
            `The run is ready for hands work on issue #${issueNumber}.`,
            `Start with: brain-hands implement --run "${input.runDir}" --issue ${issueNumber}.`,
            "That command handles implementation, local verification, and PR creation in one pass.",
          ].join("\n");
    case "local_verification":
      return issueNumber === null
        ? "Local verification is blocked, but the manifest does not record an active issue. Inspect verification/ and the latest implementation or fix artifacts before retrying."
        : [
            `Local verification is the current blocker for issue #${issueNumber}.`,
            `Inspect verification/issue-${issueNumber}/evidence.json and the per-command stdout/stderr files first.`,
            prNumber === null
              ? `After fixing the repo, rerun: brain-hands implement --run "${input.runDir}" --issue ${issueNumber}.`
              : `After fixing the repo, rerun: brain-hands fix --run "${input.runDir}" --issue ${issueNumber} --pr ${prNumber}.`,
          ].join("\n");
    case "pull_request":
      return issueNumber !== null && prNumber !== null
        ? [
            `Issue #${issueNumber} has PR #${prNumber} open and is waiting for brain review.`,
            `Continue with: brain-hands review --run "${input.runDir}" --issue ${issueNumber} --pr ${prNumber}.`,
          ].join("\n")
        : "The run is in pull_request stage, but issue or PR metadata is missing. Inspect the manifest and open PR before retrying review.";
    case "brain_review":
      return issueNumber !== null && prNumber !== null
        ? [
            `Brain review is the next step for PR #${prNumber} on issue #${issueNumber}.`,
            reviewPath && (await fileExists(reviewPath))
              ? `A stored review already exists at ${reviewPath}; inspect it before re-running review.`
              : "No stored review artifact was found yet.",
            `Review command: brain-hands review --run "${input.runDir}" --issue ${issueNumber} --pr ${prNumber}.`,
          ].join("\n")
        : "The run is in brain_review stage, but issue or PR metadata is missing. Inspect the run artifacts before retrying.";
    case "fixing":
      return issueNumber !== null && prNumber !== null
        ? [
            `PR #${prNumber} needs fixes for issue #${issueNumber}.`,
            reviewPath === null
              ? "Inspect reviews/ for the stored findings before continuing."
              : `Read ${reviewPath} to confirm the requested changes.`,
            `Continue with: brain-hands fix --run "${input.runDir}" --issue ${issueNumber} --pr ${prNumber}.`,
          ].join("\n")
        : "The run is in fixing stage, but issue or PR metadata is missing. Inspect reviews/ and manifest.json before retrying.";
    case "merge_ready":
      return [
        `The run is merge-ready${prNumber === null ? "" : ` for PR #${prNumber}`}.`,
        "Do a manual approval check, merge the PR yourself, then run final audit.",
        `Audit command: brain-hands final-audit --run "${input.runDir}" --repo "${manifest.repo_root}".`,
      ].join("\n");
    case "complete":
      return [
        "The run is complete.",
        (await fileExists(auditPath))
          ? `Final audit report: ${auditPath}`
          : "No final audit report was found, so inspect the run artifacts before closing it out.",
      ].join("\n");
    case "replan":
      return [
        "The reviewer asked for a replan.",
        "Revisit research.md, architecture-plan.md, issues.json, and the latest review artifacts before drafting replacement issues or PR work.",
      ].join("\n");
    default:
      return [
        `The run is currently at stage "${manifest.stage}".`,
        "Inspect manifest.json plus the latest artifacts in the run directory, then continue from the recorded stage.",
      ].join("\n");
  }
}

function resumeRunV2Message(manifest: RunManifestV2, runDir: string): string {
  if (manifest.stage === "awaiting_plan_approval") {
    if (manifest.pending_plan_approval !== null) {
      const revision = manifest.pending_plan_approval.proposed_revision;
      return `The v2 run is awaiting approval for plan revision ${revision}. Use brain-hands approve-plan ${manifest.run_id} --revision ${revision}.`;
    }
    if (hasLegacyReplanPatch(manifest)) {
      return `The v2 run has a legacy replan patch. Use brain-hands resume ${runDir} to prepare its exact approval request.`;
    }
    const revision = manifest.current_revision;
    if (revision === null) return "The v2 run has no plan revision to approve.";
    if (manifest.approved_revision !== revision) {
      return `The v2 run is awaiting legacy approval for plan revision ${revision}. Use brain-hands approve-plan ${manifest.run_id} --revision ${revision}.`;
    }
  }
  if (manifest.delivery_state === "blocked") {
    return [
      `The v2 run is blocked at stage ${manifest.stage}.`,
      manifest.last_blocker ?? "No blocker was recorded.",
      `Inspect status with: brain-hands status ${manifest.run_id}.`,
    ].join("\n");
  }
  if (manifest.stage === "complete") return "The v2 run is complete.";
  return `The v2 run is at stage ${manifest.stage}; resume it with brain-hands resume ${runDir}.`;
}

export { commandForStage };
