import { createHash } from "node:crypto";
import { z } from "zod";
import { verifierRemediationClaimV1Schema } from "./review-fix-packet.js";
import { DEFAULT_RESOURCE_BUDGET_V1, resourceBudgetPolicyV1Schema } from "./resource-budget.js";

export const parseJsonObject = <T>(
  json: string,
  schema: z.ZodType<T>,
): T => {
  const parsed = JSON.parse(json);

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Top-level JSON must be an object");
  }

  return schema.parse(parsed);
};

export const modelRoleSchema = z.enum([
  "brain_planner",
  "brain_reviewer",
  "hands_implementer",
  "hands_fixer",
]);

export const workflowStageSchema = z.enum([
  "intake",
  "research",
  "planning",
  "issue_drafting",
  "issue_critique",
  "ready_for_hands",
  "implementing",
  "local_verification",
  "pull_request",
  "brain_review",
  "fixing",
  "requirement_audit",
  "merge_ready",
  "final_audit",
  "complete",
  "replan",
]);

export const reasoningEffortSchema = z.enum([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);

export const roleNameSchema = z.enum(["brain", "hands", "verifier"]);
export const runModeSchema = z.enum(["github", "local"]);
export const sandboxModeSchema = z.enum(["read-only", "workspace-write"]);
export const reasoningEffortV2Schema = z.enum([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);

export const qualityGatePolicySchema = z.object({
  hands_self_review_passes: z.number().int().min(0).max(3),
  max_attempts_per_reviewer_action: z.number().int().min(1).max(3),
  require_focused_verifier_confirmation: z.literal(true),
}).strict();

export const phaseReasoningSchema = z.object({
  hands_self_review: reasoningEffortV2Schema,
  reflection: reasoningEffortV2Schema,
}).strict();

export const reviewDispositionSchema = z.enum([
  "blocking",
  "fix_in_scope",
  "requires_replan",
  "follow_up",
  "advisory",
]);

export const reviewLimitActionSchema = z.enum([
  "auto_replan",
  "stop",
  "continue_with_warning",
]);

export const reviewPolicySchema = z.object({
  policy_revision: z.number().int().positive(),
  max_fix_cycles: z.number().int().min(0),
  on_limit: reviewLimitActionSchema,
  auto_advance_on_approval: z.boolean(),
  severity_defaults: z.object({
    critical: reviewDispositionSchema,
    high: reviewDispositionSchema,
    medium: reviewDispositionSchema,
    low: reviewDispositionSchema,
  }).strict(),
  pause_on: z.array(z.enum([
    "plan_approval",
    "irreversible_external_action",
    "unresolved_release_blocker",
  ])),
}).strict();

export const reviewPolicyOverrideSchema = z.object({
  max_fix_cycles: z.number().int().min(0).optional(),
  on_limit: reviewLimitActionSchema.optional(),
  auto_advance_on_approval: z.boolean().optional(),
  severity_defaults: z.object({
    critical: reviewDispositionSchema.optional(),
    high: reviewDispositionSchema.optional(),
    medium: reviewDispositionSchema.optional(),
    low: reviewDispositionSchema.optional(),
  }).strict().optional(),
  pause_on: z.array(z.enum([
    "plan_approval",
    "irreversible_external_action",
    "unresolved_release_blocker",
  ])).optional(),
}).strict();

export const releaseGuardSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
}).strict();

export const acceptanceCriterionSchema = z.object({
  ref: z.string().regex(/^BH-\d{3}:AC-\d+$/),
  text: z.string().min(1),
}).strict();

export const reviewAccountingSchema = z.object({
  review_revision: z.number().int().min(0),
  fix_cycles_used: z.number().int().min(0),
  self_review_mutations_used: z.number().int().min(0),
  plan_revision: z.number().int().min(0),
}).strict();

export const reviewPolicyDecisionSchema = z.object({
  action: z.enum([
    "advance",
    "fix",
    "quality_recovery",
    "create_replan",
    "await_plan_approval",
    "continue_with_warning",
    "stop",
  ]),
  reason_code: z.string().regex(/^[a-z][a-z0-9_]*$/),
  finding_ids: z.array(z.string().regex(/^finding:[a-f0-9]{64}$/)),
  policy_revision: z.number().int().positive(),
  authorization_required: z.boolean(),
}).strict();

export const reviewCycleStateSchema = z.object({
  cycle_id: z.string().regex(/^review-cycle:[a-f0-9]{64}$/),
  work_item_id: z.string().trim().min(1),
  phase: z.enum(["work_item", "final_integrated", "post_pr"]),
  review_revision: z.number().int().positive(),
  policy_hash: z.string().regex(/^[a-f0-9]{64}$/),
  finding_ids: z.array(z.string().regex(/^finding:[a-f0-9]{64}$/)),
  accounting_before: reviewAccountingSchema,
  decision_path: z.string().trim().min(1),
  effect_id: z.string().regex(/^review-effect:[a-f0-9]{64}$/),
  effect_state: z.enum(["pending", "in_progress", "complete", "blocked"]),
  effect_owner: z.string().trim().min(1).optional(),
  effect_result: z.json().optional(),
  work_item_progress_reference: z.object({
    attempts: z.number().int().min(0),
    review_path: z.string().trim().min(1),
    verification_path: z.string().trim().min(1),
  }).strict().optional(),
  decision: reviewPolicyDecisionSchema,
}).strict().superRefine((state, context) => {
  if (state.effect_state === "pending" && (state.effect_owner !== undefined || state.effect_result !== undefined)) {
    context.addIssue({ code: "custom", message: "Pending review effects cannot have an owner or result" });
  }
  if (state.effect_state === "in_progress" && state.effect_owner === undefined) {
    context.addIssue({ code: "custom", message: "In-progress review effects require an owner" });
  }
  if (state.effect_state === "in_progress" && state.effect_result !== undefined) {
    context.addIssue({ code: "custom", message: "In-progress review effects cannot have a result" });
  }
  if ((state.effect_state === "complete" || state.effect_state === "blocked") && state.effect_owner === undefined) {
    context.addIssue({ code: "custom", message: "Finished review effects require an owner" });
  }
  if ((state.effect_state === "complete" || state.effect_state === "blocked") && state.effect_result === undefined) {
    context.addIssue({ code: "custom", message: "Finished review effects require a persisted result" });
  }
});

export const findingSourceSchema = z.enum(["verifier", "verification", "release_guard"]);
export const findingSeveritySchema = z.enum(["critical", "high", "medium", "low"]);
export const verifierProblemClassSchema = z.enum([
  "correctness",
  "security",
  "regression",
  "verification",
  "artifact",
  "browser",
  "release_guard",
  "maintainability",
]);

export const findingIdentityInputSchema = z.object({
  work_item_id: z.string().trim().min(1),
  criterion_ref: z.string().trim().min(1),
  source: findingSourceSchema,
  normalized_location: z.string().trim().min(1),
  problem_class: z.string().trim().min(1),
}).strict();

export const safeEvidenceRefSchema = z.string().trim().min(1).superRefine((value, context) => {
  const normalized = value.replaceAll("\\", "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) {
    context.addIssue({ code: "custom", message: "Evidence reference must be relative" });
    return;
  }
  if (normalized.split("/").some((segment) => segment === "..")) {
    context.addIssue({ code: "custom", message: "Evidence reference must stay inside the run directory" });
  }
});

export const assuranceOutcomeSchema = z.enum(["verified_ready", "human_accepted", "blocked", "abandoned"]);

export const assuranceAssessmentSchema = z.object({
  outcome: assuranceOutcomeSchema,
  assessed_at: z.string().datetime({ offset: true }),
  approved_plan_revision: z.number().int().positive().nullable(),
  approved_plan_sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  candidate_commit: z.string().regex(/^[a-f0-9]{40,64}$/).nullable(),
  blocker_code: z.string().trim().min(1).nullable(),
  blocker: z.string().trim().min(1).nullable(),
  missing_evidence: z.array(safeEvidenceRefSchema),
  invalid_evidence: z.array(safeEvidenceRefSchema),
  zero_attempt_work_items: z.array(z.string().trim().min(1)),
  acceptance_path: safeEvidenceRefSchema.nullable(),
}).strict();

export const riskAcceptanceArtifactSchema = z.object({
  version: z.literal(1),
  run_id: z.string().trim().min(1),
  gate: z.literal("final-delivery"),
  approved_plan_revision: z.number().int().positive(),
  approved_plan_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  candidate_commit: z.string().regex(/^[a-f0-9]{40,64}$/),
  blocker_code: z.string().trim().min(1),
  blocker: z.string().trim().min(1),
  missing_evidence: z.array(safeEvidenceRefSchema),
  invalid_evidence: z.array(safeEvidenceRefSchema),
  actor: z.string().trim().min(1),
  timestamp: z.string().datetime({ offset: true }),
  reason: z.string().trim().min(1),
}).strict();

export const abandonmentArtifactSchema = z.object({
  version: z.literal(1),
  run_id: z.string().trim().min(1),
  actor: z.string().trim().min(1),
  timestamp: z.string().datetime({ offset: true }),
  reason: z.string().trim().min(1),
}).strict();

const gitObjectIdSchema = z.string().regex(/^[0-9a-f]{40,64}$/);

export const remoteSynchronizationEvidenceSchema = z.object({
  version: z.literal(1),
  run_id: z.string().trim().min(1),
  branch_name: z.string().trim().min(1),
  remote_name: z.string().trim().min(1),
  pull_request_number: z.number().int().positive(),
  pull_request_url: z.string().trim().min(1),
  local_candidate_sha: gitObjectIdSchema.nullable(),
  mapped_pr_sha: gitObjectIdSchema.nullable(),
  remote_head_sha: gitObjectIdSchema.nullable(),
  problems: z.array(z.object({
    source: z.enum(["local", "pull_request", "remote"]),
    code: z.enum([
      "lookup_unavailable",
      "not_found",
      "identity_mismatch",
      "invalid_response",
      "command_failed",
    ]),
  }).strict()),
  synchronized: z.boolean(),
  observed_at: z.string().datetime({ offset: true }),
}).strict().superRefine((evidence, context) => {
  const equal = evidence.problems.length === 0
    && evidence.local_candidate_sha !== null
    && evidence.mapped_pr_sha === evidence.local_candidate_sha
    && evidence.remote_head_sha === evidence.local_candidate_sha;
  if (evidence.synchronized !== equal) {
    context.addIssue({
      code: "custom",
      path: ["synchronized"],
      message: "synchronized must equal the three-SHA comparison",
    });
  }
});

export const warningContinuationAuthorizationSchema = z.object({
  actor: z.string().trim().min(1),
  source: z.enum(["run_override", "approved_plan"]),
  finding_ids: z.array(z.string().regex(/^finding:[a-f0-9]{64}$/)).min(1),
  reason: z.string().trim().min(1),
  residual_risk: z.string().trim().min(1),
  evidence_snapshot: z.array(safeEvidenceRefSchema).min(1),
  timestamp: z.string().datetime({ offset: true }),
  policy_revision: z.number().int().positive(),
}).strict();

export const warningContinuationAuthoritySchema = warningContinuationAuthorizationSchema.pick({
  actor: true,
  source: true,
}).strict();

const convergenceRecommendedActionSchema = z.enum(["advance", "create_replan", "stop"]);

export const convergenceReportSchema = z.object({
  work_item_id: z.string().trim().min(1),
  policy_revision: z.number().int().positive(),
  max_fix_cycles: z.number().int().min(0),
  plan_revision: z.number().int().positive(),
  review_revision: z.number().int().positive(),
  fix_cycles_used: z.number().int().min(0),
  self_review_mutations_used: z.number().int().min(0),
  unresolved_finding_ids: z.array(z.string().regex(/^finding:[a-f0-9]{64}$/)),
  resolved_finding_ids: z.array(z.string().regex(/^finding:[a-f0-9]{64}$/)),
  repeated_finding_ids: z.array(z.string().regex(/^finding:[a-f0-9]{64}$/)),
  advisory_finding_ids: z.array(z.string().regex(/^finding:[a-f0-9]{64}$/)),
  follow_up_finding_ids: z.array(z.string().regex(/^finding:[a-f0-9]{64}$/)),
  evidence_refs: z.array(safeEvidenceRefSchema),
  remaining_release_guards: z.array(z.string().trim().min(1)),
  authorization: warningContinuationAuthorizationSchema.nullable(),
  decision_reason_code: z.string().regex(/^[a-z][a-z0-9_]*$/),
  recommended_action: convergenceRecommendedActionSchema,
}).strict();

export const convergenceReportSummarySchema = z.object({
  path: safeEvidenceRefSchema,
  plan_revision: z.number().int().positive(),
  review_revision: z.number().int().positive(),
  recommended_action: convergenceRecommendedActionSchema,
}).strict();

const verificationTierSchema = z.enum(["focused", "cross_cutting"]);
const crossCuttingCategorySchema = z.enum([
  "shared_helper",
  "runtime",
  "cli_lifecycle",
  "ledger",
  "artifact_paths",
]);

export const executionCrossCuttingImpactSchema = z.object({
  change_unit_id: z.string().min(1),
  category: crossCuttingCategorySchema,
  callers: z.array(z.string().min(1)),
  representative_fixtures: z.array(z.string().min(1)),
  verification_command_ids: z.array(z.string().min(1)).min(1),
}).strict();

const replanPatchCommonShape = {
  target_work_item_id: z.string().trim().min(1),
  base_plan_revision: z.number().int().positive(),
  unresolved_finding_ids: z.array(z.string().regex(/^finding:[a-f0-9]{64}$/)).min(1),
  revised_objective: z.string().trim().min(1).nullable(),
  added_or_changed_criteria: z.array(acceptanceCriterionSchema),
  changed_instructions: z.array(z.string().trim().min(1)),
  explicitly_rejected_hardening: z.array(z.string().trim().min(1)),
};

const replanAddedChangeUnitSchema = z.object({
    id: z.string().trim().min(1),
    path: z.string().trim().min(1),
    target: z.string().trim().min(1),
    operation: z.enum(["create", "modify", "delete"]),
    requirements: z.array(z.string().trim().min(1)).min(1),
    satisfies: z.array(z.string().trim().min(1)).min(1),
}).strict();

const replanAddedVerificationCommandCommonShape = {
    id: z.string().trim().min(1),
    argv: z.array(z.string().min(1)).min(1),
    expected_exit_code: z.literal(0),
};

const replanReadOnlyFileContractSchema = z.object({
  path: z.string().trim().min(1),
  targets: z.array(z.string().trim().min(1)).min(1),
}).strict();

export const replanPatchSchema = z.object({
  ...replanPatchCommonShape,
  added_change_units: z.array(replanAddedChangeUnitSchema).default([]),
  added_verification_commands: z.array(z.object({
    ...replanAddedVerificationCommandCommonShape,
    tier: verificationTierSchema.optional(),
    satisfies: z.array(z.string().trim().min(1)).default([]),
  }).strict()).default([]),
  added_cross_cutting_impacts: z.array(executionCrossCuttingImpactSchema).default([]),
  added_read_only_file_contracts: z.array(replanReadOnlyFileContractSchema).default([]),
}).strict().superRefine((patch, context) => {
  if (new Set(patch.unresolved_finding_ids).size !== patch.unresolved_finding_ids.length) {
    context.addIssue({ code: "custom", path: ["unresolved_finding_ids"], message: "Replan finding IDs must be unique" });
  }
  if (new Set(patch.added_change_units.map((unit) => unit.id)).size !== patch.added_change_units.length) {
    context.addIssue({ code: "custom", path: ["added_change_units"], message: "Replan change-unit IDs must be unique" });
  }
});

/** Strict boundary for newly generated Brain output; persisted patches use replanPatchSchema. */
export const generatedReplanPatchSchema = z.object({
  ...replanPatchCommonShape,
  added_change_units: z.array(replanAddedChangeUnitSchema),
  added_verification_commands: z.array(z.object({
    ...replanAddedVerificationCommandCommonShape,
    tier: verificationTierSchema,
    satisfies: z.array(z.string().trim().min(1)).min(1),
  }).strict()),
  added_cross_cutting_impacts: z.array(executionCrossCuttingImpactSchema),
  added_read_only_file_contracts: z.array(replanReadOnlyFileContractSchema),
}).strict().superRefine((patch, context) => {
  if (new Set(patch.unresolved_finding_ids).size !== patch.unresolved_finding_ids.length) {
    context.addIssue({ code: "custom", path: ["unresolved_finding_ids"], message: "Replan finding IDs must be unique" });
  }
  if (new Set(patch.added_change_units.map((unit) => unit.id)).size !== patch.added_change_units.length) {
    context.addIssue({ code: "custom", path: ["added_change_units"], message: "Replan change-unit IDs must be unique" });
  }
});

export const findingSummarySchema = z.object({
  finding_id: z.string().regex(/^finding:[a-f0-9]{64}$/),
  work_item_id: z.string().trim().min(1),
  severity: findingSeveritySchema,
  disposition: reviewDispositionSchema,
  first_seen_revision: z.number().int().positive(),
  last_seen_revision: z.number().int().positive(),
  occurrences: z.number().int().positive(),
}).strict().superRefine((summary, context) => {
  if (summary.last_seen_revision < summary.first_seen_revision) {
    context.addIssue({
      code: "custom",
      path: ["last_seen_revision"],
      message: "last_seen_revision must not precede first_seen_revision",
    });
  }
});

export const findingIndexSchema = z.record(z.string(), findingSummarySchema).superRefine(
  (index, context) => {
    for (const [key, summary] of Object.entries(index)) {
      if (key !== summary.finding_id) {
        context.addIssue({
          code: "custom",
          path: [key],
          message: "Finding index key must match summary finding_id",
        });
      }
    }
  },
);

export const engineFindingSchema = findingSummarySchema.extend({
  source: findingSourceSchema,
  criterion_ref: z.string().trim().min(1),
  normalized_location: z.string().trim().min(1),
  problem_class: z.string().trim().min(1),
  problem: z.string().trim().min(1),
  required_fix: z.string().trim().min(1).nullable(),
  evidence_refs: z.array(safeEvidenceRefSchema).min(1),
  repeated_from: z.string().regex(/^finding:[a-f0-9]{64}$/).optional(),
}).strict().superRefine((finding, context) => {
  if (finding.occurrences === 1 && finding.repeated_from !== undefined) {
    context.addIssue({ code: "custom", path: ["repeated_from"], message: "First occurrence cannot repeat a finding" });
  }
  if (finding.occurrences > 1 && finding.repeated_from !== finding.finding_id) {
    context.addIssue({ code: "custom", path: ["repeated_from"], message: "Repeated occurrence must reference its finding_id" });
  }
});

export const operationalBlockerSchema = z.object({
  code: z.enum([
    "invalid_verifier_contract",
    "transport_failure",
    "permission_failure",
    "network_failure",
    "catalog_failure",
    "test_infrastructure_failure",
    "corrupt_state",
  ]),
  message: z.string().trim().min(1),
  phase: z.enum(["work_item", "final_integrated", "post_pr"]),
  evidence_refs: z.array(safeEvidenceRefSchema),
}).strict();

export const releaseGuardFailureSchema = z.object({
  guard_ref: z.string().trim().min(1),
  severity: findingSeveritySchema,
  normalized_location: z.string().trim().min(1),
  problem_class: z.string().trim().min(1),
  problem: z.string().trim().min(1),
  required_fix: z.string().trim().min(1).nullable(),
  evidence_refs: z.array(safeEvidenceRefSchema).min(1),
}).strict();

export const normalizedReviewInputSchema = z.union([
  z.object({
    findings: z.array(engineFindingSchema),
    operational_blocker: z.null(),
  }).strict(),
  z.object({
    findings: z.tuple([]),
    operational_blocker: operationalBlockerSchema,
  }).strict(),
]);

export const findingRevisionInputSchema = findingIdentityInputSchema.extend({
  severity: findingSeveritySchema,
  disposition: reviewDispositionSchema,
  problem: z.string().trim().min(1),
  required_fix: z.string().trim().min(1).nullable(),
  evidence_refs: z.array(safeEvidenceRefSchema).min(1),
  review_revision: z.number().int().positive(),
}).strict();

export const handsBackupPolicySchema = z.object({
  fallback_on_primary_usage_limit: z.boolean().default(false),
  max_quality_recovery_attempts: z.literal(1),
  profile: z.object({
    model: z.string().min(1),
    reasoning_effort: reasoningEffortV2Schema,
  }).strict(),
}).strict();

export const handsBackupCatalogSnapshotSchema = z.object({
  slug: z.string().min(1),
  reasoning_effort: reasoningEffortV2Schema,
  supported_reasoning_efforts: z.array(z.string().min(1)),
}).strict();

export const roleProfileSchema = z.object({
  model: z.string().min(1),
  reasoning_effort: reasoningEffortV2Schema,
  sandbox: sandboxModeSchema,
});

export const replanFindingContextSchema = z.object({
  finding_id: z.string().regex(/^finding:[a-f0-9]{64}$/),
  problem_class: z.string().trim().min(1).max(100),
  criterion_ref: z.string().trim().min(1).max(200),
  normalized_location: z.string().trim().min(1).max(500),
  severity: findingSeveritySchema,
  disposition: reviewDispositionSchema,
  problem: z.string().trim().min(1).max(4_000),
  required_fix: z.string().trim().min(1).max(4_000).nullable(),
  evidence_refs: z.array(safeEvidenceRefSchema).max(50),
}).strict();

export const replanPatchRecordSchema = z.object({
  patch: replanPatchSchema,
  provenance: z.object({
    base_plan_revision: z.number().int().positive(),
    convergence_report_path: safeEvidenceRefSchema,
    convergence_review_revision: z.number().int().positive(),
    unresolved_finding_ids: z.array(z.string().regex(/^finding:[a-f0-9]{64}$/)).min(1),
    criterion_refs: z.array(z.string().regex(/^BH-\d{3}:AC-\d+$/)),
    finding_records: z.array(replanFindingContextSchema).min(1).max(50),
    release_guards: z.array(releaseGuardSchema),
    evidence_paths: z.array(safeEvidenceRefSchema).min(1),
    model_profile: roleProfileSchema,
  }).strict(),
}).strict();

export const runStageV2Schema = z.enum([
  "intake",
  "preflight",
  "brain_discovery",
  "awaiting_discovery_answer",
  "awaiting_discovery_approach",
  "awaiting_discovery_brief_approval",
  "brain_planning",
  "awaiting_plan_approval",
  "worktree_setup",
  "awaiting_github_issue_effects",
  "github_issue_sync",
  "implementing",
  "verifying",
  "verifier_review",
  "fixing",
  "replanning",
  "final_verification",
  "awaiting_github_delivery_effects",
  "delivery",
  "reflecting",
  "complete",
]);

export const executionLeaseActiveEffectV1Schema = z.object({
  invocation_id: z.string().min(1),
  kind: z.string().min(1),
  hostname: z.string().min(1),
  child_pids: z.array(z.number().int().positive()),
  started_at: z.string().datetime(),
}).strict();

export const executionLeaseV1Schema = z.object({
  version: z.literal(1),
  token: z.string().uuid(),
  epoch: z.number().int().positive(),
  mode: z.enum(["execution", "replan_preparation", "pending_publication", "initial_pending_publication"]),
  authority_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  owner: z.object({
    invocation_id: z.string().min(1),
    hostname: z.string().min(1),
    pid: z.number().int().positive(),
    process_started_at: z.string().datetime(),
  }).strict(),
  active_effect: executionLeaseActiveEffectV1Schema.nullable(),
  acquired_at: z.string().datetime(),
  heartbeat_at: z.string().datetime(),
}).strict();

export const terminalDispositionSchema = z.object({
  outcome: z.enum(["delivered", "human_accepted", "abandoned", "closed_blocked"]),
  actor: z.enum(["runtime", "human"]),
  reason: z.string().trim().min(1),
  recorded_at: z.string().datetime(),
  source_stage: runStageV2Schema,
  residual_risks: z.array(z.string().trim().min(1)),
}).strict();

export const runIntakeSchema = z.object({
  task: z.string().min(1),
  repo_root: z.string().min(1),
  mode: runModeSchema.optional(),
  research: z.boolean().optional(),
  reflection: z.boolean().optional(),
  brain_model: z.string().min(1).optional(),
  hands_model: z.string().min(1).optional(),
  verifier_model: z.string().min(1).optional(),
  models: z
    .object({
      brain: z.string().min(1).optional(),
      hands: z.string().min(1).optional(),
      verifier: z.string().min(1).optional(),
    })
    .strict()
    .optional(),
  quality_gate: qualityGatePolicySchema.optional(),
  hands_backup: handsBackupPolicySchema.optional(),
  review_policy: reviewPolicyOverrideSchema.optional(),
  phase_reasoning: phaseReasoningSchema.optional(),
});

export const verificationCommandSchema = z.array(z.string().min(1)).min(1);

export const browserConsoleErrorPolicySchema = z.enum(["allow_errors", "no_errors"]);

export const browserViewportSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  mobile: z.boolean().optional(),
});

export const artifactPathPattern = /^(?:[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9_-])?|\.[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9_-])?)(?:\/(?:[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9_-])?|\.[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9_-])?))*$/;
export const artifactPathSchema = z.string().min(1).regex(artifactPathPattern);

export const browserCheckSpecSchema = z.object({
  name: z.string().min(1),
  url: z.string().url(),
  local_server_command: z.string().min(1),
  required_selectors: z.array(z.string()),
  console_error_policy: browserConsoleErrorPolicySchema,
  expected_network: z.array(z.string()),
  screenshot_artifact: artifactPathSchema,
  viewport: browserViewportSchema.optional(),
  wait_ms: z.number().int().positive().optional(),
  require_no_horizontal_overflow: z.boolean().optional(),
  forbidden_overlaps: z.array(z.tuple([z.string().min(1), z.string().min(1)])).optional(),
});

export const workItemSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  objective: z.string().min(1),
  acceptance_criteria: z.array(z.string().min(1)).min(1),
  dependencies: z.array(z.string().min(1)),
  implementation_instructions: z.array(z.string().min(1)).min(1),
  verification_commands: z.array(verificationCommandSchema).min(1),
  files_expected_to_change: z.array(z.string().min(1)).min(1),
  included_scope: z.array(z.string().min(1)).optional(),
  excluded_scope: z.array(z.string().min(1)).optional(),
  expected_artifacts: z.array(artifactPathSchema).optional(),
  browser_checks: z.array(browserCheckSpecSchema).optional(),
  risks: z.array(z.string().min(1)).optional(),
  hands_handoff: z.string().min(1).optional(),
});

const executionFilePermissionSchema = z.enum(["create", "modify", "delete", "read_only"]);
export const executionSpecV2Schema = z.object({
  schema_version: z.literal("2.0"),
  id: z.string().min(1),
  title: z.string().min(1),
  objective: z.string().min(1),
  dependencies: z.array(z.string().min(1)),
  file_contract: z.array(z.object({
    path: z.string().min(1),
    permission: executionFilePermissionSchema,
    targets: z.array(z.string().min(1)).min(1),
  }).strict()).min(1),
  forbidden_changes: z.array(z.object({
    path: z.string().min(1),
    except: z.array(z.string().min(1)),
    reason: z.string().min(1),
  }).strict()),
  change_units: z.array(z.object({
    id: z.string().min(1),
    path: z.string().min(1),
    target: z.string().min(1),
    operation: z.enum(["create", "modify", "delete"]),
    requirements: z.array(z.string().min(1)).min(1),
  }).strict()).min(1),
  acceptance: z.array(z.object({
    id: z.string().min(1),
    statement: z.string().min(1),
    satisfied_by: z.array(z.string().min(1)).min(1),
  }).strict()).min(1),
  tests: z.array(z.object({
    id: z.string().min(1),
    path: z.string().min(1),
    assertion: z.string().min(1),
    verification_command_ids: z.array(z.string().min(1)),
  }).strict()),
  verification_commands: z.array(z.object({
    id: z.string().min(1),
    argv: verificationCommandSchema,
    expected_exit_code: z.literal(0),
    tier: verificationTierSchema.optional(),
  }).strict()).min(1),
  cross_cutting_impacts: z.array(executionCrossCuttingImpactSchema).optional(),
  expected_artifacts: z.array(z.string().min(1)),
  browser_checks: z.array(browserCheckSpecSchema),
  risks: z.array(z.object({
    description: z.string().min(1),
    mitigation: z.string().min(1),
  }).strict()),
  completion_contract: z.object({
    expected_changed_files: z.array(z.string().min(1)).min(1),
    allow_additional_files: z.boolean(),
    required_acceptance_ids: z.array(z.string().min(1)).min(1),
  }).strict(),
  ambiguity_policy: z.object({
    default: z.literal("stop_and_report"),
    stop_when: z.array(z.string().min(1)).min(1),
  }).strict(),
}).strict().superRefine((spec, context) => {
  const seenForbiddenPaths = new Set<string>();
  spec.forbidden_changes.forEach((change, index) => {
    if (seenForbiddenPaths.has(change.path)) {
      context.addIssue({
        code: "custom",
        path: ["forbidden_changes", index, "path"],
        message: "Forbidden-change paths must be unique",
      });
    }
    seenForbiddenPaths.add(change.path);
  });
});

export const controllerBootstrapSpecSchema = z.object({
  version: z.literal(1),
  baseline_commit: gitObjectIdSchema,
  preserved_head: gitObjectIdSchema,
  source_worktree: artifactPathSchema.refine(
    (value) => value.startsWith(".brain-hands/worktrees/") && value.length > ".brain-hands/worktrees/".length,
    "Bootstrap source must identify a Brain Hands worktree",
  ),
  commit_message: z.string().trim().min(1),
  files: z.array(z.object({
    path: artifactPathSchema,
    source_status: z.enum(["tracked", "untracked"]),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict()).min(1),
}).strict().superRefine((spec, context) => {
  const paths = spec.files.map((file) => file.path);
  if (new Set(paths).size !== paths.length) {
    context.addIssue({ code: "custom", path: ["files"], message: "Bootstrap file paths must be unique" });
  }
});

export const controllerBootstrapEvidenceSchema = z.object({
  version: z.literal(1),
  baseline_commit: gitObjectIdSchema,
  preserved_head: gitObjectIdSchema,
  source_worktree: artifactPathSchema,
  merge_commit: gitObjectIdSchema,
  bootstrap_commit: gitObjectIdSchema,
  files: z.array(z.object({
    path: artifactPathSchema,
    source_status: z.enum(["tracked", "untracked"]),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    source_before_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    source_after_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    target_after_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict()).min(1),
  completed_at: z.string().datetime(),
}).strict();

export const brainPlanSchema = z.object({
  feature_slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(16).optional(),
  parent_issue: z.object({ title: z.string().min(1) }).nullable().optional(),
  summary: z.string().min(1),
  assumptions: z.array(z.string().min(1)),
  research: z.array(z.string().min(1)),
  research_sources: z.array(z.string().min(1)),
  architecture: z.string().min(1),
  risks: z.array(z.string().min(1)),
  controller_bootstrap: controllerBootstrapSpecSchema.nullable().optional(),
  work_items: z.array(executionSpecV2Schema).min(1),
  integration_verification: z.array(verificationCommandSchema).min(1),
}).strict();

const discoveryQuestionIdSchema = z.string().regex(/^(?:q-\d{3}|cycle-\d{3}-q-\d{3})$/);
const discoveryDecisionIdSchema = z.string().regex(/^d-\d{3}$/);
const discoveryAssumptionIdSchema = z.string().regex(/^a-\d{3}$/);
const discoveryApproachIdSchema = z.string().regex(/^approach-[a-z0-9]+(?:-[a-z0-9]+)*$/);

export const discoveryChoiceSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().min(1),
}).strict();

const discoveryQuestionFields = {
  id: discoveryQuestionIdSchema,
  sequence: z.number().int().positive(),
  category: z.enum(["required", "high_value_tradeoff"]),
  text: z.string().min(1).refine((value) => value.trim() === value && /^[^?]*\?$/.test(value), {
    message: "Discovery question text must contain exactly one terminal question mark",
  }),
  choices: z.array(discoveryChoiceSchema),
  recommended_choice_id: z.string().min(1).nullable().optional(),
  recommendation_rationale: z.string().refine((value) => value.trim().length > 0, {
    message: "Discovery question recommendation rationale must contain non-whitespace text",
  }).nullable().optional(),
  rationale: z.string().min(1),
  material_effects: z.array(z.enum(["scope", "architecture", "acceptance_criteria", "verification"])),
  repository_evidence: z.array(z.string().min(1)),
  essential_after_soft_limit: z.string().min(1).nullable(),
} as const;

function validateQuestionRecommendations(
  question: {
    choices: Array<{ id: string }>;
    recommended_choice_id?: string | null;
    recommendation_rationale?: string | null;
  },
  context: z.RefinementCtx,
  requireFields: boolean,
): void {
  const hasChoiceRecommendation = question.recommended_choice_id !== undefined;
  const hasRationale = question.recommendation_rationale !== undefined;
  if (!requireFields && !hasChoiceRecommendation && !hasRationale) return;
  if (!hasChoiceRecommendation || !hasRationale) {
    context.addIssue({ code: "custom", path: ["recommended_choice_id"], message: "Discovery question recommendation fields are required together" });
    return;
  }
  const recommendedChoiceId = question.recommended_choice_id;
  const recommendationRationale = question.recommendation_rationale;
  if (question.choices.length === 0) {
    if (recommendedChoiceId !== null || recommendationRationale !== null) {
      context.addIssue({ code: "custom", path: ["recommended_choice_id"], message: "Discovery questions without choices require explicit null recommendations" });
    }
    return;
  }
  if (recommendedChoiceId === null
    || !question.choices.some((choice) => choice.id === recommendedChoiceId)) {
    context.addIssue({ code: "custom", path: ["recommended_choice_id"], message: "Discovery question recommended_choice_id must reference an offered choice" });
  }
  if (recommendationRationale === null || recommendationRationale === undefined || !recommendationRationale.trim()) {
    context.addIssue({ code: "custom", path: ["recommendation_rationale"], message: "Discovery question recommendation rationale must contain non-whitespace text" });
  }
}

export const discoveryQuestionSchema = z.object(discoveryQuestionFields).strict().superRefine((question, context) => {
  const ids = question.choices.map((choice) => choice.id);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: "custom", path: ["choices"], message: "Discovery question contains duplicate choice IDs" });
  }
  validateQuestionRecommendations(question, context, false);
});

export const persistedDiscoveryQuestionSchema = discoveryQuestionSchema;

export const generatedDiscoveryQuestionSchema = z.object({
  ...discoveryQuestionFields,
  recommended_choice_id: z.string().min(1).nullable(),
  recommendation_rationale: z.string().refine((value) => value.trim().length > 0, {
    message: "Discovery question recommendation rationale must contain non-whitespace text",
  }).nullable(),
}).strict().superRefine((question, context) => {
  const ids = question.choices.map((choice) => choice.id);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: "custom", path: ["choices"], message: "Discovery question contains duplicate choice IDs" });
  }
  validateQuestionRecommendations(question, context, true);
});

export const discoveryApproachSchema = z.object({
  id: discoveryApproachIdSchema,
  title: z.string().min(1),
  summary: z.string().min(1),
  tradeoffs: z.array(z.string().min(1)),
  recommended: z.boolean(),
  recommendation_rationale: z.string().min(1).nullable(),
}).strict();

export const discoveryDecisionSchema = z.object({
  id: discoveryDecisionIdSchema,
  statement: z.string().min(1),
  source_question_ids: z.array(discoveryQuestionIdSchema),
}).strict();

export const discoveryAssumptionSchema = z.object({
  id: discoveryAssumptionIdSchema,
  statement: z.string().min(1),
  source: z.enum(["brain_inference", "user_instruction", "proceed_with_assumptions"]),
  source_question_ids: z.array(discoveryQuestionIdSchema),
}).strict();

export const discoveryBriefSchema = z.object({
  revision: z.number().int().positive(),
  goal: z.string().min(1),
  problem: z.string().min(1),
  success_criteria: z.array(z.string().min(1)),
  constraints: z.array(z.string().min(1)),
  decisions: z.array(discoveryDecisionSchema),
  assumptions: z.array(discoveryAssumptionSchema),
  selected_approach_id: discoveryApproachIdSchema.nullable(),
  selected_approach_rationale: z.string().min(1).nullable(),
  out_of_scope: z.array(z.string().min(1)),
  accepted_risks: z.array(z.string().min(1)),
  repository_evidence: z.array(z.string().min(1)),
}).strict();

export const discoveryOutcomeSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("ask_question"),
    question: generatedDiscoveryQuestionSchema,
  }).strict(),
  z.object({
    outcome: z.enum(["ready_for_brief", "no_discovery_needed"]),
    rationale: z.string().min(1).refine((value) => value.trim().length > 0),
    repository_evidence: z.array(z.string().min(1)).min(1),
    approaches: z.array(discoveryApproachSchema),
    alternatives_omitted_reason: z.string().min(1).refine((value) => value.trim().length > 0).nullable(),
    brief: discoveryBriefSchema,
  }).strict(),
]).superRefine((outcome, context) => {
  if (outcome.outcome === "ask_question") return;
  const ids = outcome.approaches.map((approach) => approach.id);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: "custom", path: ["approaches"], message: "Discovery outcome contains duplicate approach IDs" });
  }
});

export const planningDiscoveryGapSchema = z.object({
  outcome: z.literal("discovery_gap"),
  evidence: z.array(z.string().min(1)).min(1),
  question: generatedDiscoveryQuestionSchema,
}).strict();

export const discoveryDecisionCoverageSchema = z.object({
  decision_id: discoveryDecisionIdSchema,
  work_item_ids: z.array(z.string().min(1)),
  acceptance_ids: z.array(z.string().min(1)),
  verification_command_ids: z.array(z.string().min(1)),
  no_implementation_effect: z.string().min(1).refine((value) => value.trim().length > 0, {
    message: "no_implementation_effect must contain non-whitespace text",
  }).nullable(),
}).strict();

export const discoveredBrainPlanSchema = brainPlanSchema.extend({
  discovery_brief_revision: z.number().int().positive(),
  discovery_brief_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  discovery_decision_coverage: z.array(discoveryDecisionCoverageSchema),
  accepted_risks: z.array(z.string().min(1)),
  out_of_scope: z.array(z.string().min(1)),
}).strict();

export const discoveryArtifactRecordSchema = z.object({
  revision: z.number().int().positive(),
  path: safeEvidenceRefSchema,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export const discoveryQuestionAnswerArtifactRecordSchema = z.object({
  cycle: z.number().int().positive(),
  sequence: z.number().int().positive(),
  question_id: discoveryQuestionIdSchema,
  path: safeEvidenceRefSchema,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export const discoveryManifestStateSchema = z.object({
  cycle: z.number().int().positive(),
  cycle_kind: z.enum(["initial", "planning_gap"]),
  asked_questions: z.number().int().min(0),
  answered_questions: z.number().int().min(0),
  current_question_id: discoveryQuestionIdSchema.nullable(),
  current_approaches_revision: z.number().int().positive().nullable(),
  selected_approach_id: discoveryApproachIdSchema.nullable(),
  current_brief_revision: z.number().int().positive().nullable(),
  current_readiness_revision: z.number().int().positive().nullable().default(null),
  approved_brief_revision: z.number().int().positive().nullable(),
  approved_brief_sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  proceed_with_assumptions: z.object({
    cycle: z.number().int().positive(),
    question_id: discoveryQuestionIdSchema,
    path: safeEvidenceRefSchema,
  }).strict().nullable().default(null),
  pending_action_path: safeEvidenceRefSchema.nullable(),
  question_artifacts: z.record(z.string(), discoveryQuestionAnswerArtifactRecordSchema).default({}),
  answer_artifacts: z.record(z.string(), discoveryQuestionAnswerArtifactRecordSchema).default({}),
  readiness_revisions: z.record(z.string(), discoveryArtifactRecordSchema).default({}),
  brief_revisions: z.record(z.string(), discoveryArtifactRecordSchema),
}).strict();

export const discoveryPendingActionSchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("awaiting_discovery_answer"),
    question: discoveryQuestionSchema,
    permitted_next_actions: z.tuple([
      z.literal("answer-discovery"),
      z.literal("proceed-discovery"),
    ]),
  }).strict(),
  z.object({
    state: z.literal("awaiting_discovery_approach"),
    revision: z.number().int().positive(),
    approaches: z.array(discoveryApproachSchema),
    permitted_next_actions: z.tuple([z.literal("select-discovery-approach")]),
  }).strict(),
  z.object({
    state: z.literal("awaiting_discovery_brief_approval"),
    revision: z.number().int().positive(),
    brief: discoveryBriefSchema,
    readiness_revision: z.number().int().positive(),
    readiness_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    permitted_next_actions: z.tuple([
      z.literal("approve-discovery"),
      z.literal("revise-discovery"),
    ]),
  }).strict(),
]);

export const implementationResultSchema = z.object({
  work_item_id: z.string().min(1),
  changed_files: z.array(z.string().min(1)),
  tests_added_or_changed: z.array(z.string().min(1)),
  commands_attempted: z.array(verificationCommandSchema),
  completed_steps: z.array(z.string().min(1)),
  remaining_risks: z.array(z.string().min(1)),
});

export const handsSelfReviewReportSchema = z.object({
  work_item_id: z.string().min(1),
  parent_attempt: z.number().int().positive(),
  mutation_kind: z.enum(["initial", "normal_fix", "reviewer_action", "quality_recovery"]),
  pass: z.number().int().positive(),
  active_action_id: z.string().min(1).nullable(),
  findings: z.array(z.string().min(1)),
  fixes_applied: z.array(z.string().min(1)),
  changed_files: z.array(z.string().min(1)),
  commands_attempted: z.array(verificationCommandSchema),
  remaining_findings: z.array(z.string().min(1)),
  ready_for_resolution_check: z.boolean(),
}).strict().superRefine((report, context) => {
  if (report.ready_for_resolution_check && report.remaining_findings.length > 0) {
    context.addIssue({
      code: "custom",
      path: ["ready_for_resolution_check"],
      message: "ready_for_resolution_check requires no remaining findings",
    });
  }
});

export const verifierFindingSchema = z.object({
  severity: z.enum(["critical", "high", "medium", "low"]),
  file: z.string().min(1),
  line: z.number().int().positive().nullable(),
  acceptance_criterion: z.string().min(1),
  problem_class: verifierProblemClassSchema.optional(),
  problem: z.string().min(1),
  required_fix: z.string().min(1),
  evidence_refs: z.array(safeEvidenceRefSchema).min(1).optional(),
  re_verification: z.array(verificationCommandSchema),
});

export const reviewerActionSchema = verifierFindingSchema.omit({ re_verification: true }).extend({
  problem_class: verifierProblemClassSchema,
  evidence_refs: z.array(safeEvidenceRefSchema).min(1),
  action_id: z.string().min(1),
  order: z.number().int().positive(),
  depends_on: z.array(z.string().min(1)),
  remediation: verifierRemediationClaimV1Schema,
}).strict();

const generatedVerifierFindingSchema = reviewerActionSchema.extend({
  remediation: verifierRemediationClaimV1Schema.optional(),
}).strict();

/** Accepts persisted queues created before strict claim identity and evidence were required. */
const legacyPersistedReviewerActionSchema = verifierFindingSchema.extend({
  action_id: z.string().min(1),
  order: z.number().int().positive(),
  depends_on: z.array(z.string().min(1)),
}).strict();
const persistedReviewerActionSchema = z.union([legacyPersistedReviewerActionSchema, reviewerActionSchema]);

export const reviewerActionQueueSchema = z.object({
  contract_version: z.literal("review_fix_packet_v1").optional(),
  review_revision: z.number().int().positive(),
  work_item_id: z.string().min(1),
  actions: z.array(persistedReviewerActionSchema),
}).strict();

export const actionResolutionReviewSchema = z.object({
  review_revision: z.number().int().positive(),
  action_id: z.string().min(1),
  action_attempt: z.number().int().positive(),
  decision: z.enum(["resolved", "still_open", "blocked", "replan_required"]),
  evidence_reviewed: z.array(z.string().min(1)),
  remaining_problem: z.string().min(1).nullable(),
  required_next_fix: z.string().min(1).nullable(),
}).strict().superRefine((review, context) => {
  if (review.decision === "resolved") {
    if (review.remaining_problem !== null) {
      context.addIssue({
        code: "custom",
        path: ["remaining_problem"],
        message: "resolved requires remaining_problem null",
      });
    }
    if (review.required_next_fix !== null) {
      context.addIssue({
        code: "custom",
        path: ["required_next_fix"],
        message: "resolved requires required_next_fix null",
      });
    }
  }
  if (review.decision === "still_open") {
    if (review.remaining_problem === null) {
      context.addIssue({
        code: "custom",
        path: ["remaining_problem"],
        message: "still_open requires remaining_problem",
      });
    }
    if (review.required_next_fix === null) {
      context.addIssue({
        code: "custom",
        path: ["required_next_fix"],
        message: "still_open requires required_next_fix",
      });
    }
  }
});

export const verificationFailureClassSchema = z.enum([
  "none",
  "implementation_failure",
  "operational_blocker",
  "test_infrastructure_blocker",
  "replan_required",
]);
export const verifierBlockerCodeSchema = z.enum([
  "transport_failure",
  "permission_failure",
  "network_failure",
  "catalog_failure",
  "test_infrastructure_failure",
  "corrupt_state",
]);

const verifierReviewBaseSchema = z.object({
  work_item_id: z.string().min(1),
  attempt: z.number().int().positive(),
  final: z.boolean(),
  decision: z.enum(["approve", "request_changes", "blocked", "replan_required"]),
  failure_class: verificationFailureClassSchema.default("none"),
  blocker: z.string().min(1).nullable().default(null),
  blocker_code: verifierBlockerCodeSchema.nullable().default(null),
  acceptance_coverage: z.array(z.string().min(1)),
  evidence_reviewed: z.array(z.string().min(1)),
  residual_risks: z.array(z.string().min(1)),
});

function validateLegacyVerifierReview(
  review: z.infer<typeof verifierReviewBaseSchema> & { findings: unknown[] },
  context: z.RefinementCtx,
): void {
  if (review.decision === "request_changes" && review.findings.length === 0) {
    context.addIssue({
      code: "custom",
      path: ["findings"],
      message: "request_changes requires at least one concrete finding",
    });
  }
  if (review.decision === "approve" && review.failure_class !== "none") {
    context.addIssue({ code: "custom", path: ["failure_class"], message: "approve requires failure_class none" });
  }
  if (review.decision === "request_changes" && review.failure_class !== "implementation_failure") {
    context.addIssue({ code: "custom", path: ["failure_class"], message: "request_changes requires implementation_failure" });
  }
  if (review.decision === "blocked" && !["operational_blocker", "test_infrastructure_blocker"].includes(review.failure_class)) {
    context.addIssue({ code: "custom", path: ["failure_class"], message: "blocked requires an operational blocker classification" });
  }
  if (review.decision === "blocked" && !review.blocker) {
    context.addIssue({ code: "custom", path: ["blocker"], message: "blocked requires a blocker description" });
  }
}

function validateStrictVerifierReview(
  review: z.infer<typeof verifierReviewBaseSchema> & { findings: Array<{ remediation?: unknown }> },
  context: z.RefinementCtx,
): void {
  if (["request_changes", "replan_required"].includes(review.decision) && review.findings.length === 0) {
    context.addIssue({
      code: "custom",
      path: ["findings"],
      message: `${review.decision} requires at least one concrete finding`,
    });
  }
  const operationalCodes = [
    "transport_failure", "permission_failure", "network_failure", "catalog_failure", "corrupt_state",
  ];
  if (review.decision === "approve") {
    if (review.findings.length > 0) context.addIssue({ code: "custom", path: ["findings"], message: "approve requires no findings" });
    if (review.failure_class !== "none" || review.blocker !== null || review.blocker_code !== null) {
      context.addIssue({ code: "custom", message: "approve requires none and null blocker fields" });
    }
  } else if (review.decision === "request_changes") {
    for (const [index, finding] of review.findings.entries()) {
      if (finding.remediation === undefined) context.addIssue({ code: "custom", path: ["findings", index, "remediation"], message: "request_changes requires remediation" });
    }
    if (review.failure_class !== "implementation_failure" || review.blocker !== null || review.blocker_code !== null) {
      context.addIssue({ code: "custom", message: "request_changes requires implementation_failure and null blocker fields" });
    }
  } else if (review.decision === "replan_required") {
    for (const [index, finding] of review.findings.entries()) {
      if (finding.remediation !== undefined) context.addIssue({ code: "custom", path: ["findings", index, "remediation"], message: "replan_required cannot contain executable remediation" });
    }
    if (review.failure_class !== "replan_required" || review.blocker !== null || review.blocker_code !== null) {
      context.addIssue({ code: "custom", message: "replan_required requires matching class and null blocker fields" });
    }
  } else {
    if (review.findings.length > 0) context.addIssue({ code: "custom", path: ["findings"], message: "blocked requires no findings" });
    if (!review.blocker) {
      context.addIssue({ code: "custom", path: ["blocker"], message: "blocked requires a blocker description" });
    }
    if (review.failure_class === "operational_blocker") {
      if (!operationalCodes.includes(review.blocker_code ?? "")) {
        context.addIssue({ code: "custom", path: ["blocker_code"], message: "operational blocker requires an operational blocker code" });
      }
    } else if (
      review.failure_class !== "test_infrastructure_blocker"
      || review.blocker_code !== "test_infrastructure_failure"
    ) {
      context.addIssue({ code: "custom", path: ["blocker_code"], message: "test infrastructure blocker requires its matching code" });
    }
  }
}

/** Accepts persisted reviews created before ordered action metadata was required. */
export const verifierReviewSchema = verifierReviewBaseSchema.extend({
  findings: z.array(verifierFindingSchema),
}).superRefine(validateLegacyVerifierReview);

/** Validates newly generated Verifier output. */
export const strictVerifierReviewSchema = verifierReviewBaseSchema.extend({
  failure_class: verificationFailureClassSchema,
  blocker: z.string().min(1).nullable(),
  blocker_code: verifierBlockerCodeSchema.nullable(),
  findings: z.array(generatedVerifierFindingSchema),
}).superRefine(validateStrictVerifierReview);

/** Accepts both current strict reviews and reviews persisted by older controllers. */
export const persistedVerifierReviewSchema = z.union([
  strictVerifierReviewSchema,
  verifierReviewSchema,
]);

export const reflectionSchema = z.object({
  outcome_summary: z.string().min(1),
  what_worked: z.array(z.string().min(1)),
  what_was_correct: z.array(z.string().min(1)),
  what_failed: z.array(z.string().min(1)),
  root_causes: z.array(z.string().min(1)),
  avoidable_rework: z.array(z.string().min(1)),
  process_improvements: z.array(z.string().min(1)),
  improvements: z.array(z.string().min(1)),
  classifications: z.object({
    implementation_defects: z.array(z.string().min(1)),
    planning_defects: z.array(z.string().min(1)),
    verification_gaps: z.array(z.string().min(1)),
    environment_failures: z.array(z.string().min(1)),
    external_blockers: z.array(z.string().min(1)),
    unnecessary_cost_or_rework: z.array(z.string().min(1)),
  }).strict(),
  candidate_regression_tests: z.array(z.string().min(1)),
  evidence_paths: z.array(z.string().min(1)),
}).strict();

export const improvementPlanSchema = z.object({
  reflection_source: z.string().min(1),
  observed_problem: z.array(z.string().min(1)),
  evidence: z.array(z.string().min(1)),
  recommended_changes: z.array(z.string().min(1)),
  expected_benefits: z.array(z.string().min(1)),
  implementation_sequence: z.array(z.string().min(1)),
  tests_and_acceptance_criteria: z.array(z.string().min(1)),
  risks: z.array(z.string().min(1)),
  out_of_scope: z.array(z.string().min(1)),
});

export const runEventSchema = z.object({
  event_id: z.string().min(1),
  run_id: z.string().min(1),
  stage: runStageV2Schema,
  type: z.string().min(1),
  timestamp: z.string().datetime(),
  actor: z.string().min(1),
  payload: z.record(z.string(), z.unknown()).default({}),
}).strict();

export const planApprovalReasonCodeSchema = z.enum(["initial_plan", "material_replan"]);

export const planDeltaCategorySchema = z.enum([
  "objective",
  "scope",
  "files",
  "acceptance",
  "verification",
  "risks",
  "external_effects",
  "destructive_actions",
]);

export const planDeltaEntryV1Schema = z.object({
  category: planDeltaCategorySchema,
  pointer: z.string().min(1),
  operation: z.enum(["add", "remove", "replace"]),
  before: z.unknown().nullable(),
  after: z.unknown().nullable(),
}).strict();

export const planApprovalDeltaV1Schema = z.object({
  schema_version: z.literal(1),
  base_revision: z.number().int().positive().nullable(),
  proposed_revision: z.number().int().positive(),
  entries: z.array(planDeltaEntryV1Schema),
  unchanged_high_impact_categories: z.array(planDeltaCategorySchema),
}).strict();

export const planApprovalSubjectV1Schema = z.object({
  schema_version: z.literal(1),
  gate: z.literal("plan"),
  reason_code: planApprovalReasonCodeSchema,
  run_id: z.string().min(1),
  plan_revision: z.number().int().positive(),
  base_plan_revision: z.number().int().positive().nullable(),
  plan_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  prerequisite_subject_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  execution_context_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  authority_contract_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  decision_contract_sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export const planApprovalRequestSchema = z.object({
  schema_version: z.literal(1),
  gate: z.enum(["initial_plan", "replan"]).optional(),
  requested_revision: z.number().int().positive().optional(),
  base_revision: z.number().int().positive().nullable().optional(),
  artifact_path: z.string().min(1).optional(),
  artifact_sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  subject: planApprovalSubjectV1Schema,
  approval_subject_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  fresh_approval_required: z.boolean().optional(),
  reuse_reason: z.string().min(1).nullable().optional(),
  reason_code: planApprovalReasonCodeSchema.optional(),
  reason: z.string().min(1).optional(),
  plan_path: z.string().min(1),
  delta: planApprovalDeltaV1Schema,
  additional_approvals_expected: z.enum(["none", "only_if_material_replan", "manual_delivery_authority"]),
}).strict();

export const pendingPlanApprovalV1Schema = z.object({
  schema_version: z.literal(1),
  proposed_revision: z.number().int().positive(),
  base_revision: z.number().int().positive().nullable(),
  request_path: z.string().min(1),
  request_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  approval_subject_sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

const planRevisionSchema = z.object({
  revision: z.number().int().positive(),
  path: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  candidate_path: z.string().regex(/^plans\/candidates\/[0-9a-f-]{36}\.json$/).optional(),
  candidate_invocation_id: z.string().uuid().optional(),
  acceptance_criteria: z.record(
    z.string().min(1),
    z.array(acceptanceCriterionSchema).min(1),
  ).optional(),
  origin: z.enum(["initial", "replan"]).optional(),
  base_revision: z.number().int().positive().nullable().optional(),
  approval_request_path: z.string().min(1).optional(),
  approval_request_sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  approval_subject_sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  decision_contract_sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict().superRefine((revision, context) => {
  if ((revision.candidate_path === undefined) !== (revision.candidate_invocation_id === undefined)) {
    context.addIssue({ code: "custom", message: "Claim-owned plan revision candidate identity must be complete" });
  }
});

const workItemProgressSchema = z.object({
  status: z.enum(["pending", "in_progress", "complete", "blocked"]),
  attempts: z.number().int().min(0),
  github_status_transition_at: z.string().datetime({ offset: true }).optional(),
  context_base_commit: gitObjectIdSchema.optional(),
  context_plan_revision: z.number().int().positive().optional(),
  summary_path: artifactPathSchema.optional(),
  summary_sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  primary_fix_attempts: z.number().int().min(0).optional(),
  quality_recovery_attempts: z.number().int().min(0).optional(),
  recovery_state: z.enum(["not_eligible", "eligible", "pending", "in_progress", "approved", "exhausted"]).optional(),
  last_attempt_path: z.string().min(1).optional(),
  blocker_code: z.enum(["operational_blocker", "test_infrastructure_blocker", "backup_profile_unavailable", "primary_usage_limit_no_backup", "ambiguous_hands_invocation", "escalation_exhausted", "action_fix_exhausted", "invalid_reviewer_action_queue", "replan_required"]).optional(),
  review_revision: z.number().int().positive().optional(),
  review_cycle_path: z.string().min(1).optional(),
  review_effect_id: z.string().regex(/^review-effect:[a-f0-9]{64}$/).optional(),
  fix_reservation_id: z.string().min(1).optional(),
  queue_state: z.enum(["pending", "in_progress", "complete", "blocked"]).optional(),
  queue_path: z.string().min(1).optional(),
  active_action_id: z.string().min(1).nullable().optional(),
  active_action_attempt: z.number().int().min(0).optional(),
  completed_action_ids: z.array(z.string().min(1)).optional(),
  mutation_kind: z.enum(["initial", "normal_fix", "reviewer_action", "quality_recovery"]).optional(),
  self_review_pass: z.number().int().min(0).optional(),
  self_review_state: z.enum(["pending", "invoking", "verification_pending", "complete"]).optional(),
  mutation_verification_path: z.string().min(1).optional(),
  self_review_paths: z.record(z.string(), z.string().min(1)).optional(),
  self_review_verification_paths: z.record(z.string(), z.string().min(1)).optional(),
  self_review_claim_owner: z.enum(["primary", "backup"]).optional(),
  backup_claim_transfer_pending: z.boolean().optional(),
  focused_review_path: z.string().min(1).nullable().optional(),
  terminal_hands_fix_attempts: z.number().int().min(0).optional(),
  candidate_recheck: z.object({
    phase: z.enum(["final_integrated", "post_pr"]),
    attempt: z.number().int().positive(),
    commit_sha: gitObjectIdSchema,
    state: z.enum(["reserved", "verified", "indexed", "reviewed"]),
    verification_path: artifactPathSchema.optional(),
    index_path: artifactPathSchema.optional(),
    review_path: artifactPathSchema.optional(),
  }).strict().superRefine((recheck, context) => {
    const expectedVerification = `verification/integrated/attempt-${recheck.attempt}/evidence.json`;
    const expectedIndex = recheck.phase === "final_integrated"
      ? `evidence-indexes/verifier/final-integrated/attempt-${recheck.attempt}.json`
      : `evidence-indexes/verifier/post-pr/attempt-${recheck.attempt}.json`;
    const expectedReview = `reviews/integrated/final-attempt-${recheck.attempt}.json`;
    if (recheck.state === "reserved" && (
      recheck.verification_path !== undefined
      || recheck.index_path !== undefined
      || recheck.review_path !== undefined
    )) {
      context.addIssue({ code: "custom", message: "Reserved candidate recheck cannot publish later-stage paths" });
    }
    if (recheck.state !== "reserved" && recheck.verification_path !== expectedVerification) {
      context.addIssue({ code: "custom", message: "Candidate recheck verification path must match its attempt" });
    }
    if (["indexed", "reviewed"].includes(recheck.state) && recheck.index_path !== expectedIndex) {
      context.addIssue({ code: "custom", message: "Candidate recheck index path must match its phase and attempt" });
    }
    if (recheck.state === "verified" && (recheck.index_path !== undefined || recheck.review_path !== undefined)) {
      context.addIssue({ code: "custom", message: "Verified candidate recheck cannot publish index or review paths" });
    }
    if (recheck.state === "indexed" && recheck.review_path !== undefined) {
      context.addIssue({ code: "custom", message: "Indexed candidate recheck cannot publish a review path" });
    }
    if (recheck.state === "reviewed" && recheck.review_path !== expectedReview) {
      context.addIssue({ code: "custom", message: "Candidate recheck review path must match its attempt" });
    }
  }).optional(),
}).passthrough().superRefine((progress, context) => {
  const recheck = progress.candidate_recheck;
  if (!recheck) return;
  if (recheck.attempt !== progress.attempts) {
    context.addIssue({ code: "custom", path: ["candidate_recheck", "attempt"], message: "Candidate recheck attempt must match parent progress" });
  }
  if (recheck.commit_sha !== progress.commit_sha) {
    context.addIssue({ code: "custom", path: ["candidate_recheck", "commit_sha"], message: `Candidate recheck commit ${recheck.commit_sha} must match parent progress ${progress.commit_sha ?? "missing"}` });
  }
  if (recheck.phase === "post_pr" && progress.delivery_phase !== "post_pr") {
    context.addIssue({ code: "custom", path: ["candidate_recheck", "phase"], message: "Post-PR candidate recheck requires post-PR delivery state" });
  }
  if (recheck.phase === "final_integrated" && progress.delivery_phase === "post_pr") {
    context.addIssue({ code: "custom", path: ["candidate_recheck", "phase"], message: "Final-integrated candidate recheck cannot carry post-PR delivery state" });
  }
});

const githubIdsSchema = z.object({
  issue_numbers: z.array(z.number().int().positive()),
  work_item_issue_map: z.record(z.string().min(1), z.number().int().positive()).default({}),
  parent_issue_number: z.number().int().positive().nullable().default(null),
  pull_request_numbers: z.array(z.number().int().positive()),
  pull_request_urls: z.record(z.string(), z.string().url()).default({}),
});

const manifestRoleProfilesSchema = z.object({
  brain: roleProfileSchema.optional(),
  hands: roleProfileSchema.optional(),
  verifier: roleProfileSchema.optional(),
}).default({});

export const controllerProvenanceSchema = z.object({
  self_hosting: z.boolean(),
  mode: z.enum(["installed", "development_checkout"]),
  executable_path: z.string().min(1),
  package_root: z.string().min(1),
  package_name: z.string().min(1),
  package_version: z.string().regex(/^\d+\.\d+\.\d+$/),
  package_hash_algorithm: z.literal("sha256"),
  package_hash: z.string().regex(/^[a-f0-9]{64}$/),
  candidate_commit: z.string().regex(/^[a-f0-9]{40,64}$/),
}).strict();

export const controllerRuntimeSnapshotV1Schema = controllerProvenanceSchema.omit({ candidate_commit: true });

export const controllerRuntimeSubjectV1Schema = z.object({
  version: z.literal(1),
  package_name: z.string().min(1),
  package_version: z.string().regex(/^\d+\.\d+\.\d+$/),
  mode: z.enum(["installed", "development_checkout"]),
  package_hash_algorithm: z.literal("sha256"),
  package_hash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export const controllerRecoveryArtifactV1Schema = z.object({
  version: z.literal(1),
  run_id: z.string().trim().min(1),
  sequence: z.number().int().positive().refine(Number.isSafeInteger),
  stage: runStageV2Schema,
  actor: z.string().refine((value) => value.trim().length > 0 && value === value.trim(), {
    message: "Controller recovery actor must be canonical and non-empty",
  }),
  reason: z.string().refine((value) => value.trim().length > 0 && value === value.trim(), {
    message: "Controller recovery reason must be canonical and non-empty",
  }),
  recorded_at: z.string().datetime(),
  previous_subject_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  next_subject_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  previous_runtime: controllerRuntimeSnapshotV1Schema,
  next_runtime: controllerRuntimeSnapshotV1Schema,
  candidate_head_at_recovery: z.string().regex(/^[a-f0-9]{40,64}$/),
  blocker_fingerprint: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  event_id: z.string().regex(/^controller-recovery:[a-f0-9]{64}$/),
}).strict();

const brainControllerClaimSchema = z.object({
  phase: z.literal("planning"),
  invocation_id: z.string().uuid(),
  owner: z.string().min(1),
  owner_pid: z.number().int().positive(),
  artifact_name: z.string().min(1),
  claimed_at: z.string().datetime(),
  attempt_kind: z.enum(["full", "repair"]).optional(),
  attempt_ordinal: z.number().int().positive().optional(),
}).strict();

const planningRecoveryStateSchema = z.object({
  lineage_id: z.string().uuid(),
  approved_brief_revision: z.number().int().positive().nullable(),
  approved_brief_sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  state: z.enum(["full_generation", "repairing", "blocked", "ready"]),
  full_attempts_used: z.number().int().nonnegative(),
  repair_attempts_used: z.number().int().nonnegative(),
  latest_candidate_ref: safeEvidenceRefSchema.nullable(),
  latest_candidate_sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  latest_failure_ref: safeEvidenceRefSchema.nullable(),
  latest_diagnostic_fingerprint: z.string().max(4096).nullable(),
}).strict();

export const recoveryDispositionSchema = z.enum([
  "active",
  "awaiting_external_fix",
  "diagnostic_stop",
  "exhausted",
]);

const recoveryNonblankStringSchema = z.string().refine((value) => value.trim().length > 0);

function isWellFormedUtf16(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

export const recoveryAuthorizationNoteSchema = recoveryNonblankStringSchema.refine(
  isWellFormedUtf16,
  { message: "Diagnostic recovery authorization note must contain well-formed Unicode" },
);

export const recoveryScopeIdSchema = recoveryNonblankStringSchema.refine(
  (value) => value !== "__proto__",
  { message: "Recovery scope ID __proto__ is not allowed" },
);

const recoveryFindingIdsSchema = z.array(recoveryNonblankStringSchema).superRefine((values, context) => {
  if (new Set(values).size !== values.length) {
    context.addIssue({ code: "custom", message: "Recovery finding identifiers must be unique" });
  }
});

const recoverySha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const recoveryProgressSubjectV1Schema = z.object({
  version: z.literal(1),
  approved_plan_sha256: recoverySha256Schema.nullable(),
  candidate_commit: recoveryNonblankStringSchema.nullable(),
  implementation_artifact_sha256: recoverySha256Schema.nullable(),
  verification_artifact_sha256: recoverySha256Schema.nullable(),
  review_artifact_sha256: recoverySha256Schema.nullable(),
  review_revision: z.number().int().nonnegative().refine(Number.isSafeInteger).nullable(),
  finding_ids: recoveryFindingIdsSchema,
}).strict();

export const recoveryFailureClassSchema = z.enum([
  "implementation_failure",
  "invocation_failure",
  "model_failure",
  "operational_blocker",
  "test_infrastructure_blocker",
]);

export const recoveryRequestedEffectSchema = z.enum([
  "advance",
  "fix",
  "quality_recovery",
  "create_replan",
  "await_plan_approval",
  "continue_with_warning",
  "stop",
  "retry_operation",
]);

export const recoveryGuardActionSchema = z.enum([
  "allow_next_effect",
  "await_external_fix",
  "diagnostic_stop",
  "exhausted_stop",
]);

export const recoveryObservationV1Schema = z.object({
  version: z.literal(1),
  scope_id: recoveryScopeIdSchema,
  stage: runStageV2Schema,
  operation: recoveryNonblankStringSchema,
  failure_class: recoveryFailureClassSchema,
  blocker_code: recoveryNonblankStringSchema,
  finding_ids: recoveryFindingIdsSchema,
  run_id: recoveryNonblankStringSchema,
  effect_attempt_id: recoveryNonblankStringSchema,
  blocker_fingerprint: recoverySha256Schema,
  progress_subject_sha256: recoverySha256Schema,
}).strict().superRefine((observation, context) => {
  const expected = createHash("sha256").update(JSON.stringify({
    version: 1,
    scope_id: observation.scope_id,
    stage: observation.stage,
    operation: observation.operation,
    failure_class: observation.failure_class,
    blocker_code: observation.blocker_code,
    finding_ids: [...observation.finding_ids].sort(),
  })).digest("hex");
  if (observation.blocker_fingerprint !== expected) {
    context.addIssue({
      code: "custom",
      path: ["blocker_fingerprint"],
      message: "Recovery observation blocker fingerprint does not match its subject",
    });
  }
});

export const githubEffectsProtocolSchema = z.enum(["legacy-run-v1", "task-lineage-v1"]);
export const githubEffectPhaseSchema = z.enum(["issue_sync", "pull_request_delivery"]);

export const githubEffectPreviewRefSchema = z.object({
  phase: githubEffectPhaseSchema,
  revision: z.number().int().positive(),
  path: safeEvidenceRefSchema,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  plan_revision: z.number().int().positive(),
  plan_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  state: z.enum(["previewed", "applying", "applied", "invalidated"]),
}).strict().superRefine((preview, context) => {
  const phaseDirectory = preview.phase === "issue_sync" ? "issue-sync" : "pull-request-delivery";
  const expectedPath = `github-effects/${phaseDirectory}/revision-${preview.revision}.json`;
  if (preview.path !== expectedPath) {
    context.addIssue({
      code: "custom",
      path: ["path"],
      message: `GitHub effect preview path must be ${expectedPath}`,
    });
  }
});

const diagnosticAuthorizationIdSchema = z.string().regex(
  /^diagnostic-authorization:[a-f0-9]{64}$/,
);

export const diagnosticRecoveryAuthorizationV1Schema = z.object({
  version: z.literal(1),
  authorization_id: diagnosticAuthorizationIdSchema,
  run_id: recoveryNonblankStringSchema,
  scope_id: recoveryScopeIdSchema,
  journal_sequence: z.number().int().positive().refine(Number.isSafeInteger),
  decision_path: safeEvidenceRefSchema,
  blocker_fingerprint: recoverySha256Schema,
  progress_subject_sha256: recoverySha256Schema,
  actor: recoveryNonblankStringSchema,
  note: recoveryAuthorizationNoteSchema,
  note_sha256: recoverySha256Schema,
  recorded_at: z.string().datetime(),
}).strict().superRefine((authorization, context) => {
  const expectedNoteSha256 = createHash("sha256").update(authorization.note).digest("hex");
  if (authorization.note_sha256 !== expectedNoteSha256) {
    context.addIssue({
      code: "custom",
      path: ["note_sha256"],
      message: "Diagnostic recovery authorization note SHA-256 does not match its note",
    });
  }
  const expectedAuthorizationId = `diagnostic-authorization:${createHash("sha256")
    .update(JSON.stringify({
      version: 1,
      run_id: authorization.run_id,
      scope_id: authorization.scope_id,
      journal_sequence: authorization.journal_sequence,
      decision_path: authorization.decision_path,
      blocker_fingerprint: authorization.blocker_fingerprint,
      progress_subject_sha256: authorization.progress_subject_sha256,
      actor: authorization.actor,
      note_sha256: authorization.note_sha256,
    }))
    .digest("hex")}`;
  if (authorization.authorization_id !== expectedAuthorizationId) {
    context.addIssue({
      code: "custom",
      path: ["authorization_id"],
      message: "Diagnostic recovery authorization identity does not match its bound subject",
    });
  }
});

export const diagnosticRecoveryConsumptionV1Schema = z.object({
  version: z.literal(1),
  authorization_id: diagnosticAuthorizationIdSchema,
  run_id: recoveryNonblankStringSchema,
  scope_id: recoveryScopeIdSchema,
  effect_attempt_id: z.string().regex(/^recovery-attempt:[a-f0-9]{64}$/),
  consumed_at: z.string().datetime(),
}).strict().superRefine((consumption, context) => {
  const expectedEffectAttemptId = `recovery-attempt:${createHash("sha256")
    .update(`brain-hands-recovery-attempt-v1\0${consumption.authorization_id}`)
    .digest("hex")}`;
  if (consumption.effect_attempt_id !== expectedEffectAttemptId) {
    context.addIssue({
      code: "custom",
      path: ["effect_attempt_id"],
      message: "Diagnostic recovery consumption attempt identity does not match its authorization",
    });
  }
});

const semanticNonblankStringSchema = z.string().refine(
  (value) => value.trim().length > 0,
  { message: "Identifier must contain a non-whitespace character" },
);

export const recoveryScopeStateV1Schema = z.object({
  version: z.literal(1),
  head_sequence: z.number().int().nonnegative(),
  head_decision_path: safeEvidenceRefSchema.nullable(),
  blocker_fingerprint: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  progress_subject_sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  consecutive_without_progress: z.number().int().nonnegative(),
  disposition: recoveryDispositionSchema,
  diagnostic_path: safeEvidenceRefSchema.nullable(),
  authorization_path: safeEvidenceRefSchema.nullable(),
}).strict().superRefine((state, context) => {
  if ((state.head_sequence === 0) !== (state.head_decision_path === null)) {
    context.addIssue({
      code: "custom",
      path: ["head_decision_path"],
      message: "Recovery decision path must match the head sequence",
    });
  }
  if (state.disposition === "diagnostic_stop" && state.diagnostic_path === null) {
    context.addIssue({
      code: "custom",
      path: ["diagnostic_path"],
      message: "Diagnostic stops require a diagnostic artifact",
    });
  }
  if (state.disposition !== "diagnostic_stop" && state.diagnostic_path !== null) {
    context.addIssue({
      code: "custom",
      path: ["diagnostic_path"],
      message: "Only diagnostic stops may reference a diagnostic artifact",
    });
  }
});

const recoveryScopesSchema = z.preprocess((value, context) => {
  if (
    value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.prototype.hasOwnProperty.call(value, "__proto__")
  ) {
    context.addIssue({
      code: "custom",
      path: ["__proto__"],
      message: "Recovery scope key __proto__ is not allowed",
    });
    return z.NEVER;
  }
  return value;
}, z.record(semanticNonblankStringSchema, recoveryScopeStateV1Schema));

export const runRecoveryStateV1Schema = z.object({
  version: z.literal(1),
  active_scope: semanticNonblankStringSchema.nullable(),
  scopes: recoveryScopesSchema,
}).strict().superRefine((state, context) => {
  if (state.active_scope !== null && !Object.prototype.hasOwnProperty.call(state.scopes, state.active_scope)) {
    context.addIssue({
      code: "custom",
      path: ["active_scope"],
      message: "Active recovery scope must exist in scopes",
    });
  }
});

export const taskLineageV1Schema = z.object({
  version: z.literal(1),
  lineage_id: z.string().regex(/^task-lineage:[a-f0-9]{64}$/)
    .transform((value): `task-lineage:${string}` => value as `task-lineage:${string}`),
  root_run_id: semanticNonblankStringSchema,
  predecessor_run_id: semanticNonblankStringSchema.nullable(),
  predecessor_abandonment_sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
}).strict().superRefine((lineage, context) => {
  if ((lineage.predecessor_run_id === null) !== (lineage.predecessor_abandonment_sha256 === null)) {
    context.addIssue({
      code: "custom",
      path: ["predecessor_abandonment_sha256"],
      message: "Predecessor run and abandonment hash must be paired",
    });
  }
});

const replacementRunIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,191}$/);

export const replacementReservationV1Schema = z.object({
  version: z.literal(1),
  predecessor_run_id: replacementRunIdSchema,
  predecessor_abandonment_path: safeEvidenceRefSchema,
  predecessor_abandonment_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  successor_run_id: replacementRunIdSchema,
  task_lineage: taskLineageV1Schema,
  actor: semanticNonblankStringSchema,
  reason: semanticNonblankStringSchema,
  created_at: z.string().datetime(),
}).strict().superRefine((reservation, context) => {
  if (reservation.predecessor_run_id === reservation.successor_run_id) {
    context.addIssue({ code: "custom", path: ["successor_run_id"], message: "Replacement successor must differ from its predecessor" });
  }
  if (reservation.task_lineage.predecessor_run_id !== reservation.predecessor_run_id) {
    context.addIssue({ code: "custom", path: ["task_lineage", "predecessor_run_id"], message: "Replacement lineage must name the predecessor" });
  }
  if (reservation.task_lineage.predecessor_abandonment_sha256 !== reservation.predecessor_abandonment_sha256) {
    context.addIssue({ code: "custom", path: ["task_lineage", "predecessor_abandonment_sha256"], message: "Replacement lineage must bind the abandonment hash" });
  }
});

export const replacementPredecessorLinkV1Schema = z.object({
  version: z.literal(1),
  predecessor_run_id: replacementRunIdSchema,
  predecessor_reservation_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  successor_run_id: replacementRunIdSchema,
  task_lineage: taskLineageV1Schema,
}).strict().superRefine((link, context) => {
  if (link.predecessor_run_id === link.successor_run_id) {
    context.addIssue({ code: "custom", path: ["successor_run_id"], message: "Replacement successor must differ from its predecessor" });
  }
  if (link.task_lineage.predecessor_run_id !== link.predecessor_run_id) {
    context.addIssue({ code: "custom", path: ["task_lineage", "predecessor_run_id"], message: "Replacement backlink lineage must name the predecessor" });
  }
});

export const replacementCompletionV1Schema = z.object({
  version: z.literal(1),
  predecessor_run_id: replacementRunIdSchema,
  successor_run_id: replacementRunIdSchema,
  reservation_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  predecessor_link_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  completed_at: z.string().datetime(),
}).strict().superRefine((completion, context) => {
  if (completion.predecessor_run_id === completion.successor_run_id) {
    context.addIssue({ code: "custom", path: ["successor_run_id"], message: "Replacement successor must differ from its predecessor" });
  }
});

export const controllerRecoveryStateV1Schema = z.object({
  version: z.literal(1),
  transition_count: z.number().int().nonnegative(),
  head_path: safeEvidenceRefSchema.nullable(),
}).strict().superRefine((state, context) => {
  if ((state.transition_count === 0) !== (state.head_path === null)) {
    context.addIssue({
      code: "custom",
      path: ["head_path"],
      message: "Controller recovery head must match the transition count",
    });
  }
});

const githubEffectsSchema = z.object({
  issue_sync: githubEffectPreviewRefSchema.nullable(),
  pull_request_delivery: githubEffectPreviewRefSchema.nullable(),
}).strict().superRefine((effects, context) => {
  if (effects.issue_sync !== null && effects.issue_sync.phase !== "issue_sync") {
    context.addIssue({ code: "custom", path: ["issue_sync", "phase"], message: "Issue-sync preview has the wrong phase" });
  }
  if (effects.pull_request_delivery !== null && effects.pull_request_delivery.phase !== "pull_request_delivery") {
    context.addIssue({ code: "custom", path: ["pull_request_delivery", "phase"], message: "Pull-request delivery preview has the wrong phase" });
  }
});

export const githubCleanupBatchSchema = z.object({
  version: z.literal(1),
  lineage_id: z.string().uuid(),
  reason: z.enum(["completed", "not_planned"]),
  target_numbers: z.array(z.number().int().positive()),
  target_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  target_states: z.record(
    z.string().regex(/^[1-9]\d*$/),
    z.enum(["pending", "complete", "blocked"]),
  ),
  state: z.enum(["pending", "complete", "blocked"]),
  started_at: z.string().datetime(),
  completed_at: z.string().datetime().nullable(),
}).strict().superRefine((cleanup, context) => {
  if (cleanup.target_numbers.some((number, index) => index > 0 && number <= cleanup.target_numbers[index - 1])) {
    context.addIssue({
      code: "custom",
      path: ["target_numbers"],
      message: "GitHub cleanup target numbers must be unique and sorted",
    });
  }
  const expectedKeys = cleanup.target_numbers.map(String).sort();
  const actualKeys = Object.keys(cleanup.target_states).sort();
  if (expectedKeys.length !== actualKeys.length || expectedKeys.some((key, index) => key !== actualKeys[index])) {
    context.addIssue({
      code: "custom",
      path: ["target_states"],
      message: "GitHub cleanup target-state keys must match target numbers",
    });
  }
});

export const runManifestV2Schema = z.object({
  version: z.literal(2),
  schema_version: z.literal(2).default(2),
  run_id: z.string().min(1),
  original_request: z.string().min(1),
  repo_root: z.string().min(1),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  stage: runStageV2Schema,
  workflow_protocol: z.enum(["legacy-v2", "durable-discovery-v1", "bounded-context-v1"]).default("legacy-v2"),
  task_lineage_id: z.string().uuid().nullable().default(null),
  github_effects_protocol: githubEffectsProtocolSchema.default("legacy-run-v1"),
  github_effects: githubEffectsSchema.default({ issue_sync: null, pull_request_delivery: null }),
  github_cleanup: githubCleanupBatchSchema.nullable().default(null),
  legacy_github_restore: z.object({
    version: z.literal(1),
    lineage_id: z.string().uuid(),
    migration_run_id: z.string().min(1),
    plan_revision: z.number().int().positive(),
    plan_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    original_manifest_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    original_stage: z.enum([
      "github_issue_sync", "implementing", "verifying", "verifier_review", "fixing",
      "replanning", "final_verification", "awaiting_github_delivery_effects", "delivery", "reflecting",
    ]),
  }).strict().nullable().default(null),
  discovery: discoveryManifestStateSchema.nullable().default(null),
  current_work_item_id: z.string().min(1).nullable(),
  retry_counts: z.record(z.string(), z.number().int().min(0)),
  issue_numbers: z.array(z.number().int().positive()),
  pull_request_numbers: z.array(z.number().int().positive()),
  events: z.array(z.string().min(1)),
  mode: runModeSchema.default("local"),
  run_mode: runModeSchema.default("local"),
  active_hands_profile: z.enum(["primary", "backup"]).default("primary"),
  backup_activation_reason: z.literal("primary_usage_limit").nullable().default(null),
  quality_gate_policy: qualityGatePolicySchema.nullable().optional(),
  hands_backup_policy: handsBackupPolicySchema.nullable().optional(),
  hands_backup_catalog: handsBackupCatalogSnapshotSchema.nullable().optional(),
  review_policy_snapshot: reviewPolicySchema.optional(),
  warning_continuation_authority: warningContinuationAuthoritySchema.optional(),
  release_guards: z.array(releaseGuardSchema).optional(),
  review_accounting: reviewAccountingSchema.optional(),
  finding_index: findingIndexSchema.optional(),
  convergence_reports: z.record(z.string(), convergenceReportSummarySchema).optional(),
  role_profiles: manifestRoleProfilesSchema,
  selected_role_profiles: manifestRoleProfilesSchema,
  current_revision: z.number().int().positive().nullable().default(null),
  approved_revision: z.number().int().positive().nullable().default(null),
  current_plan_revision: z.number().int().positive().nullable().default(null),
  approved_plan_revision: z.number().int().positive().nullable().default(null),
  plan_revisions: z.record(z.string(), planRevisionSchema).default({}),
  pending_plan_approval: pendingPlanApprovalV1Schema.nullable().default(null),
  approval_protocol_version: z.literal(1).nullable().default(null),
  approval_protocol_start_revision: z.number().int().positive().nullable().default(null),
  run_configuration_sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable().default(null),
  execution_epoch: z.number().int().nonnegative().default(0),
  execution_lease: executionLeaseV1Schema.nullable().default(null),
  source_commit: z.string().min(1).nullable().default(null),
  worktree_path: z.string().min(1).nullable().default(null),
  branch_name: z.string().min(1).nullable().default(null),
  checkout_allocation_state: z.enum(["pending", "ready"]).nullable().default(null),
  work_item_progress: z.record(z.string(), workItemProgressSchema).default({}),
  work_item_issue_map: z.record(z.string().min(1), z.number().int().positive()).default({}),
  github_ids: githubIdsSchema.default({ issue_numbers: [], work_item_issue_map: {}, parent_issue_number: null, pull_request_numbers: [], pull_request_urls: {} }),
  delivery_state: z.enum(["pending", "ready", "complete", "blocked"]).default("pending"),
  assurance_outcome: z.enum(["verified_ready", "human_accepted", "blocked", "abandoned"]).nullable().default(null),
  assurance_assessment_path: safeEvidenceRefSchema.nullable().default(null),
  remote_synchronization_path: safeEvidenceRefSchema.nullable().optional(),
  risk_acceptance_path: safeEvidenceRefSchema.nullable().default(null),
  risk_acceptance_history: z.array(safeEvidenceRefSchema).default([]),
  abandonment_path: safeEvidenceRefSchema.nullable().default(null),
  terminal: terminalDispositionSchema.nullable().default(null),
  final_artifact_paths: z.array(z.string().min(1)).default([]),
  final_verifier_index_path: artifactPathSchema.nullable().default(null),
  final_verifier_index_sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable().default(null),
  reflection_index_path: artifactPathSchema.nullable().default(null),
  reflection_protocol: z.enum(["role-accounts-v1", "single-pass-v1"]).optional(),
  resource_budget_policy: z.json().optional(),
  last_blocker: z.string().min(1).nullable().default(null),
  intake_path: z.string().min(1).default("intake.json"),
  controller_provenance: controllerProvenanceSchema.optional(),
  brain_controller_claim: brainControllerClaimSchema.nullable().default(null),
  planning_recovery: planningRecoveryStateSchema.nullable().default(null),
  recovery: runRecoveryStateV1Schema.default(() => ({ version: 1 as const, active_scope: null, scopes: {} })),
  task_lineage: taskLineageV1Schema.nullable().default(null),
  controller_recovery: controllerRecoveryStateV1Schema.default({ version: 1, transition_count: 0, head_path: null }),
}).superRefine((manifest, context) => {
  if (manifest.task_lineage !== null) {
    if (
      (manifest.task_lineage.predecessor_run_id === null)
      !== (manifest.task_lineage.root_run_id === manifest.run_id)
    ) {
      context.addIssue({
        code: "custom",
        path: ["task_lineage", "predecessor_run_id"],
        message: "Only the lineage root may omit its predecessor",
      });
    }
    if (manifest.task_lineage.predecessor_run_id === manifest.run_id) {
      context.addIssue({
        code: "custom",
        path: ["task_lineage", "predecessor_run_id"],
        message: "A run may not be its own predecessor",
      });
    }
  }
  if (manifest.github_effects_protocol === "task-lineage-v1" && manifest.task_lineage_id === null) {
    context.addIssue({
      code: "custom",
      path: ["task_lineage_id"],
      message: "Task-lineage GitHub effects require a task lineage ID",
    });
  }
  if (manifest.github_effects_protocol === "legacy-run-v1" && manifest.task_lineage_id !== null) {
    context.addIssue({
      code: "custom",
      path: ["task_lineage_id"],
      message: "Legacy GitHub effects cannot carry a task lineage ID",
    });
  }
  const legacyRestore = manifest.legacy_github_restore ?? null;
  if (legacyRestore !== null) {
    const allowedNormalizedStages = new Set([
      "worktree_setup",
      "awaiting_github_issue_effects",
      "github_issue_sync",
      "implementing",
      "final_verification",
      "awaiting_github_delivery_effects",
    ]);
    if (manifest.mode !== "github" || manifest.run_mode !== "github") {
      context.addIssue({ code: "custom", path: ["legacy_github_restore"], message: "Legacy GitHub restore authority requires GitHub mode" });
    }
    if (manifest.github_effects_protocol !== "task-lineage-v1") {
      context.addIssue({ code: "custom", path: ["legacy_github_restore"], message: "Legacy GitHub restore authority requires task-lineage protocol" });
    }
    if (manifest.task_lineage_id !== legacyRestore.lineage_id) {
      context.addIssue({ code: "custom", path: ["legacy_github_restore", "lineage_id"], message: "Legacy GitHub restore lineage must match the manifest" });
    }
    if (manifest.run_id !== legacyRestore.migration_run_id) {
      context.addIssue({ code: "custom", path: ["legacy_github_restore", "migration_run_id"], message: "Legacy GitHub restore run must match the manifest" });
    }
    const approvedRevision = manifest.approved_revision ?? manifest.approved_plan_revision;
    if (approvedRevision !== legacyRestore.plan_revision
      || manifest.plan_revisions[String(legacyRestore.plan_revision)]?.sha256 !== legacyRestore.plan_sha256) {
      context.addIssue({ code: "custom", path: ["legacy_github_restore", "plan_revision"], message: "Legacy GitHub restore plan must match the approved plan" });
    }
    if (!allowedNormalizedStages.has(manifest.stage)) {
      context.addIssue({ code: "custom", path: ["stage"], message: "Legacy GitHub restore authority requires a normalized effect-boundary stage" });
    }
    const deliverySource = legacyRestore.original_stage === "awaiting_github_delivery_effects"
      || legacyRestore.original_stage === "delivery"
      || legacyRestore.original_stage === "reflecting";
    if (!deliverySource && (manifest.stage === "final_verification" || manifest.stage === "awaiting_github_delivery_effects")) {
      context.addIssue({ code: "custom", path: ["legacy_github_restore", "original_stage"], message: "Only a legacy delivery-stage source may normalize through the delivery boundary" });
    }
  }
  if ((manifest.final_verifier_index_path === null) !== (manifest.final_verifier_index_sha256 === null)) {
    context.addIssue({ code: "custom", path: ["final_verifier_index_path"], message: "Final-Verifier evidence index reference must include both path and SHA-256" });
  }
  const issue = (path: Array<string | number>, message: string): void => {
    context.addIssue({ code: "custom", path, message });
  };
  if ((manifest.worktree_path === null) !== (manifest.branch_name === null)) {
    issue([manifest.worktree_path === null ? "worktree_path" : "branch_name"], "Checkout path and branch must be pinned together");
  }
  if (manifest.checkout_allocation_state !== null && (
    manifest.source_commit === null
    || manifest.worktree_path === null
    || manifest.branch_name === null
  )) {
    issue(["checkout_allocation_state"], "Checkout allocation state requires complete source, path, and branch authority");
  }
  if (manifest.execution_lease?.mode === "execution" && manifest.pending_plan_approval !== null) {
    issue(["execution_lease", "mode"], "Execution lease cannot coexist with a pending approval boundary");
  }
  if (manifest.execution_lease?.mode === "replan_preparation" && (
    manifest.pending_plan_approval !== null
    || manifest.approved_revision === null
    || (manifest.stage !== "replanning" && manifest.stage !== "awaiting_plan_approval")
  )) {
    issue(["execution_lease", "mode"], "Replan-preparation lease requires an approved run with no pending boundary");
  }
  if (manifest.execution_lease?.mode === "pending_publication" && (
    manifest.pending_plan_approval === null
    || manifest.pending_plan_approval.base_revision === null
    || manifest.pending_plan_approval.base_revision !== manifest.approved_revision
  )) {
    issue(["execution_lease", "mode"], "Pending-publication lease requires an exact pending boundary over the approved base");
  }
  if (manifest.execution_lease?.mode === "initial_pending_publication" && (
    manifest.pending_plan_approval === null
    || manifest.pending_plan_approval.base_revision !== null
    || manifest.approved_revision !== null
  )) {
    issue(["execution_lease", "mode"], "Initial-pending publication lease requires the exact unapproved initial boundary");
  }
  const exactMetadataState = (revision: (typeof manifest.plan_revisions)[string]) => {
    const metadata = [
      revision.origin,
      revision.base_revision,
      revision.approval_request_path,
      revision.approval_request_sha256,
      revision.approval_subject_sha256,
      revision.decision_contract_sha256,
    ];
    const count = metadata.filter((value) => value !== undefined).length;
    return count === 0 ? "none" : count === metadata.length ? "complete" : "partial";
  };
  const hasExactApprovalMetadata = manifest.pending_plan_approval !== null
    || manifest.run_configuration_sha256 !== null
    || Object.values(manifest.plan_revisions).some((revision) => exactMetadataState(revision) !== "none");
  if (manifest.current_revision !== manifest.current_plan_revision) {
    issue(["current_plan_revision"], "Current revision aliases must be equal");
  }
  if (manifest.approved_revision !== manifest.approved_plan_revision) {
    issue(["approved_plan_revision"], "Approved revision aliases must be equal");
  }
  if (hasExactApprovalMetadata && manifest.approval_protocol_version !== 1) {
    issue(["approval_protocol_version"], "Exact plan approval provenance requires approval protocol version 1");
  }
  if ((manifest.approval_protocol_version === 1) !== (manifest.approval_protocol_start_revision !== null)) {
    issue(["approval_protocol_start_revision"], "Approval protocol marker and start revision must be persisted together");
  }
  if (manifest.approval_protocol_version === 1) {
    const startRevision = manifest.approval_protocol_start_revision;
    if (startRevision === null) {
      issue(["approval_protocol_start_revision"], "Exact approval protocol requires its immutable start revision");
    } else {
      if (startRevision === 1
        && manifest.workflow_protocol !== "durable-discovery-v1"
        && manifest.workflow_protocol !== "bounded-context-v1") {
        issue(["approval_protocol_start_revision"], "Exact approval starting at revision 1 requires durable discovery");
      }
      for (const [key, revision] of Object.entries(manifest.plan_revisions)) {
        const revisionNumber = Number(key);
        const state = exactMetadataState(revision);
        if (revisionNumber < startRevision && state !== "none") {
          issue(["plan_revisions", key], "Revisions before the exact approval start must remain legacy-only");
        }
        if (revisionNumber >= startRevision && state !== "complete") {
          issue(["plan_revisions", key], "Every revision from the exact approval start requires complete exact metadata");
        }
      }
      if (startRevision > 1) {
        const startRecord = manifest.plan_revisions[String(startRevision)];
        if (!startRecord
          || startRecord.origin !== "replan"
          || startRecord.base_revision !== startRevision - 1) {
          issue(["approval_protocol_start_revision"], "Historical exact approval must start at a replan of the immediately preceding legacy revision");
        }
      }
    }
    const exactRevision = manifest.pending_plan_approval?.proposed_revision ?? manifest.current_revision;
    if (exactRevision !== null) {
      const record = manifest.plan_revisions[String(exactRevision)];
      if (!record
        || record.origin === undefined
        || record.base_revision === undefined
        || record.approval_request_path === undefined
        || record.approval_request_sha256 === undefined
        || record.approval_subject_sha256 === undefined
        || record.decision_contract_sha256 === undefined) {
        issue(["approval_protocol_version"], "Approval protocol version 1 requires complete exact revision metadata");
      }
    }
    if (manifest.current_revision !== null
      && manifest.approved_revision !== manifest.current_revision
      && manifest.pending_plan_approval === null) {
      issue(["pending_plan_approval"], "Unapproved exact plan revision requires its pending approval pointer");
    }
  }
  if (manifest.stage === "awaiting_plan_approval" && manifest.pending_plan_approval !== null) {
    const pending = manifest.pending_plan_approval;
    const revision = manifest.plan_revisions[String(pending.proposed_revision)];
    if (!revision) issue(["pending_plan_approval"], "Pending approval revision must exist");
    if (revision?.approval_subject_sha256 !== pending.approval_subject_sha256) {
      issue(["pending_plan_approval"], "Pending approval subject must match the revision");
    }
    if (revision?.approval_request_sha256 !== pending.request_sha256) {
      issue(["pending_plan_approval"], "Pending approval request must match the revision");
    }
    if (pending.base_revision === null && manifest.current_revision !== pending.proposed_revision) {
      issue(["current_revision"], "Initial pending revision must be current");
    }
    if (pending.base_revision === null && manifest.current_plan_revision !== pending.proposed_revision) {
      issue(["current_plan_revision"], "Initial pending plan revision alias must be current");
    }
    if (pending.base_revision === null
      && (manifest.approved_revision !== null || manifest.approved_plan_revision !== null)) {
      issue(["approved_plan_revision"], "Initial pending revision must remain unapproved");
    }
    if (pending.base_revision !== null
      && (manifest.current_revision !== pending.base_revision || manifest.approved_revision !== pending.base_revision)) {
      issue(["pending_plan_approval"], "Pending replan must preserve the executable approved base");
    }
    if (pending.base_revision !== null
      && (manifest.current_plan_revision !== pending.base_revision
        || manifest.approved_plan_revision !== pending.base_revision)) {
      issue(["pending_plan_approval"], "Pending replan aliases must preserve the executable approved base");
    }
    if (pending.base_revision !== null && pending.proposed_revision <= pending.base_revision) {
      issue(["pending_plan_approval", "proposed_revision"], "Proposed replan revision must be greater than its base");
    }
  }
  if (manifest.pending_plan_approval !== null && manifest.stage !== "awaiting_plan_approval") {
    issue(["pending_plan_approval"], "Pending plan approval is allowed only at its approval stage");
  }
  if (manifest.controller_provenance && manifest.source_commit !== manifest.controller_provenance.candidate_commit) {
    context.addIssue({ code: "custom", path: ["source_commit"], message: "Candidate commit must match controller provenance" });
  }
  const topMap = manifest.work_item_issue_map;
  const nestedMap = manifest.github_ids.work_item_issue_map;
  for (const [workItemId, issueNumber] of Object.entries(topMap)) {
    if (nestedMap[workItemId] !== undefined && nestedMap[workItemId] !== issueNumber) {
      context.addIssue({
        code: "custom",
        path: ["work_item_issue_map", workItemId],
        message: "Conflicting durable GitHub issue mappings",
      });
    }
  }
  const seen = new Map<number, string>();
  for (const [workItemId, issueNumber] of Object.entries({ ...topMap, ...nestedMap })) {
    const existing = seen.get(issueNumber);
    if (existing && existing !== workItemId) {
      context.addIssue({
        code: "custom",
        path: ["work_item_issue_map", workItemId],
        message: `GitHub issue number is already mapped to ${existing}`,
      });
    }
    seen.set(issueNumber, workItemId);
  }
});

export const configV2Schema = z.object({
  version: z.literal(2),
  github: z.object({
    default_remote: z.string().min(1),
    enabled: z.boolean().optional(),
  }),
  codex: z.object({
    command: z.string().min(1),
    timeout_seconds: z.number().int().positive(),
    isolate_user_config: z.boolean(),
    args_template: z.array(z.string()).optional(),
    prompt_transport: z.enum(["stdin", "file"]).optional(),
    prompt_file_flag: z.string().min(1).optional(),
  }).superRefine((codex, ctx) => {
    if (codex.args_template?.includes("--reasoning-effort")) {
      ctx.addIssue({
        code: "custom",
        path: ["args_template"],
        message: "args_template contains obsolete --reasoning-effort; use structured Codex invocation",
      });
    }
  }),
  retry_policy: z.object({
    max_hands_fix_attempts: z.number().int().min(1),
    max_replan_attempts: z.number().int().min(0),
    backup: handsBackupPolicySchema.optional(),
    quality_gate: qualityGatePolicySchema.optional(),
  }),
  profiles: z.record(roleNameSchema, roleProfileSchema),
  phase_reasoning: phaseReasoningSchema.default({
    hands_self_review: "medium",
    reflection: "medium",
  }),
  review_policy: reviewPolicyOverrideSchema.optional(),
  resource_budget: resourceBudgetPolicyV1Schema.default(DEFAULT_RESOURCE_BUDGET_V1),
});

export const browserEvidenceReportSchema = z.object({
  check_name: z.string().min(1),
  url: z.string().url(),
  status: z.enum(["passed", "failed", "skipped"]),
  observed_selectors: z.array(z.string()),
  missing_selectors: z.array(z.string()),
  console_errors: z.array(z.string()),
  expected_network: z.array(z.string()),
  observed_network: z.array(z.string()),
  screenshot_artifact: z.string().min(1),
  console_error_policy: browserConsoleErrorPolicySchema,
  viewport: browserViewportSchema.extend({ mobile: z.boolean() }).optional(),
  horizontal_overflow: z.boolean().optional(),
  overlap_failures: z.array(z.string()).optional(),
  pixel_check: z.object({
    sampled_pixels: z.number().int().min(0),
    non_blank_pixels: z.number().int().min(0),
    unique_colors: z.number().int().min(0),
  }).optional(),
  failure_reasons: z.array(z.string().min(1)).optional(),
  skipped_reason: z.string().nullable().optional(),
});

export const browserEvidenceBundleSchema = z.object({
  generated_at: z.string().datetime(),
  status: z.enum(["passed", "failed", "skipped"]),
  reports: z.array(browserEvidenceReportSchema),
});

export const legacyConfigSchema = z.object({
  version: z.literal(1),
  github: z.object({
    enabled: z.boolean(),
    default_remote: z.string().min(1),
  }),
  codex: z.object({
    command: z.string().min(1),
    args_template: z.array(z.string()),
    prompt_transport: z.enum(["stdin", "file"]),
    prompt_file_flag: z.string().min(1),
    timeout_seconds: z.number().int().positive(),
  }),
  retry_policy: z.object({
    max_hands_fix_attempts: z.number().int().min(1),
    max_replan_attempts: z.number().int().min(0),
  }),
  profiles: z.record(
    modelRoleSchema,
    z.object({
      model: z.string().min(1),
      reasoning_effort: reasoningEffortSchema,
      temperature: z.enum(["low", "medium"]),
      responsibilities: z.array(z.string().min(1)).min(1),
    }),
  ),
});

export const issueSpecSchema = z.object({
  title: z.string().min(1).optional(),
  feature_slug: z.string().min(1).optional(),
  work_item_id: z.string().min(1).optional(),
  plan_revision: z.number().int().positive().optional(),
  parent_issue_number: z.number().int().positive().optional(),
  type: z.literal("implementation_task"),
  run_id: z.string().min(1),
  parent_request: z.string().min(1),
  goal: z.string().min(1),
  context: z.string().min(1),
  scope: z.object({
    include: z.array(z.string()),
    exclude: z.array(z.string()),
  }),
  dependencies: z.array(z.number().int().positive()),
  implementation_steps: z.array(z.string().min(1)).min(1),
  acceptance_criteria: z.array(z.string().min(1)).min(1),
  verification: z.object({
    required_commands: z.array(z.string().min(1)).min(1),
    manual_checks: z.array(z.string()),
    expected_artifacts: z.array(artifactPathSchema),
  }),
  review_checklist: z.array(z.string().min(1)).min(1),
  risk_register: z.array(z.string()),
  handoff_prompt: z.string().min(1),
  browser_checks: z.array(browserCheckSpecSchema).default([]),
});

export const prReviewSchema = z.object({
  decision: z.enum(["approve", "request_changes", "replan_required"]),
  requirement_coverage: z.object({
    passed: z.array(z.string()),
    failed: z.array(z.string()),
  }),
  verification: z.object({
    commands_reviewed: z.array(z.string()),
    commands_missing: z.array(z.string()),
    artifacts_reviewed: z.array(z.string()),
  }),
  findings: z.array(
    z.object({
      severity: z.enum(["critical", "high", "medium", "low"]),
      file: z.string().min(1),
      line: z.number().int().min(1),
      problem: z.string().min(1),
      required_fix: z.string().min(1),
      verification_after_fix: z.string().min(1),
    }),
  ),
  residual_risks: z.array(z.string()),
});

export const runManifestSchema = z.object({
  run_id: z.string().min(1),
  original_request: z.string().min(1),
  repo_root: z.string().min(1),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  stage: workflowStageSchema,
  current_issue: z.number().int().positive().nullable(),
  current_pr: z.number().int().positive().nullable(),
  retry_counts: z.record(z.string(), z.number().int().min(0)),
  issue_numbers: z.array(z.number().int().positive()),
  pr_numbers: z.array(z.number().int().positive()),
});

export const verificationCommandResultSchema = z.object({
  command: z.string().min(1),
  argv: z.array(z.string()).optional(),
  exit_code: z.number().int().nullable(),
  timed_out: z.boolean(),
  error_code: z.string().min(1).nullable(),
  error_message: z.string().min(1).nullable(),
  signal: z.string().min(1).nullable(),
  stdout_path: z.string().min(1),
  stderr_path: z.string().min(1),
  result_path: z.string().min(1).optional(),
  duration_ms: z.number().nonnegative().optional(),
});

export const verificationExecutionResultSchema = z.object({
  argv: z.array(z.string()),
  stdout: z.string(),
  stderr: z.string(),
  exit_code: z.number().int().nullable(),
  duration_ms: z.number().nonnegative(),
  timed_out: z.boolean(),
  error_code: z.string().min(1).nullable(),
  error_message: z.string().min(1).nullable(),
  signal: z.string().min(1).nullable(),
});

export const verificationBrowserEvidenceSchema = z.object({
  name: z.string().min(1),
  url: z.string().url(),
  status: z.enum(["passed", "failed", "skipped"]),
  screenshot_artifact: z.string().min(1),
  screenshot_exists: z.boolean(),
  expected_network: z.array(z.string()),
  observed_network: z.array(z.string()),
  missing_network: z.array(z.string()),
  console_errors: z.array(z.string()),
  missing_selectors: z.array(z.string()),
  failure_reasons: z.array(z.string()).default([]),
  evidence_report_path: z.string().min(1).nullable(),
  skipped_reason: z.string().nullable(),
});

export const verificationArtifactCheckSchema = z.object({
  path: z.string().min(1),
  exists: z.boolean(),
  required: z.boolean(),
});

const verificationEvidenceCommonSchema = z.object({
  attempt: z.number().int().positive(),
  evidence_path: z.string().min(1),
  commands: z.array(verificationCommandResultSchema),
  artifacts: z.array(z.string()),
  artifact_checks: z.array(verificationArtifactCheckSchema).default([]),
  browser_evidence: z.array(verificationBrowserEvidenceSchema).default([]),
  created_at: z.string().datetime(),
});

export const verificationEvidenceSchema = z.discriminatedUnion("verification_scope", [
  verificationEvidenceCommonSchema.extend({
    verification_scope: z.literal("github"),
    work_item_id: z.string().min(1),
    issue_number: z.number().int().positive(),
  }).strict(),
  verificationEvidenceCommonSchema.extend({
    verification_scope: z.literal("local"),
    work_item_id: z.string().min(1),
  }).strict(),
  verificationEvidenceCommonSchema.extend({
    verification_scope: z.literal("integrated"),
    work_item_id: z.literal("integrated"),
  }).strict(),
]);

/** Read-only compatibility parser for pre-BH-009 issue-number evidence. */
export const legacyVerificationEvidenceSchema = z.object({
  issue_number: z.number().int().positive(),
  attempt: z.number().int().positive().optional(),
  evidence_path: z.string().min(1).optional(),
  commands: z.array(verificationCommandResultSchema),
  artifacts: z.array(z.string()),
  artifact_checks: z.array(
    z.object({
      path: z.string().min(1),
      exists: z.boolean(),
      required: z.boolean(),
    }),
  ).default([]),
  browser_evidence: z.array(verificationBrowserEvidenceSchema).default([]),
  created_at: z.string().datetime(),
}).passthrough();

export const preflightStatusSchema = z.enum(["OK", "FAIL", "SKIP"]);

export const preflightCheckSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()),
  required: z.boolean(),
  status: preflightStatusSchema,
  available: z.boolean(),
  exit_code: z.number().int().nullable(),
  stdout: z.string(),
  stderr: z.string(),
});

export const preflightResultSchema = z.object({
  checks: z.array(preflightCheckSchema),
  required_checks_failed: z.boolean(),
});

/** Accept both persisted configuration versions during the migration window. */
export const configSchema = z.union([configV2Schema, legacyConfigSchema]);
