import type { VerifierRemediationClaimV1 } from "./review-fix-packet.js";
import type {
  RecoveryFailureClass,
  RecoveryGuardAction,
  RecoveryObservationV1,
  RecoveryProgressSubjectV1,
  RecoveryRequestedEffect,
} from "../workflow/recovery-policy.js";
import type { ResourceBudgetPolicyV1 } from "./resource-budget.js";

export type ModelRole =
  | "brain_planner"
  | "brain_reviewer"
  | "hands_implementer"
  | "hands_fixer";

export type WorkflowStage =
  | "intake"
  | "research"
  | "planning"
  | "issue_drafting"
  | "issue_critique"
  | "ready_for_hands"
  | "implementing"
  | "local_verification"
  | "pull_request"
  | "brain_review"
  | "fixing"
  | "requirement_audit"
  | "merge_ready"
  | "final_audit"
  | "complete"
  | "replan";

export type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

export interface PhaseReasoning {
  hands_self_review: ReasoningEffort;
  reflection: ReasoningEffort;
}

export type ReflectionProtocol = "role-accounts-v1" | "single-pass-v1";

export interface HandsBackupPolicy {
  fallback_on_primary_usage_limit: boolean;
  max_quality_recovery_attempts: 1;
  profile: {
    model: string;
    reasoning_effort: ReasoningEffort;
  };
}

export interface HandsBackupCatalogSnapshot {
  slug: string;
  reasoning_effort: ReasoningEffort;
  supported_reasoning_efforts: string[];
}

export interface QualityGatePolicy {
  hands_self_review_passes: number;
  max_attempts_per_reviewer_action: number;
  require_focused_verifier_confirmation: true;
}

export type ReviewDisposition =
  | "blocking"
  | "fix_in_scope"
  | "requires_replan"
  | "follow_up"
  | "advisory";

export type ReviewLimitAction = "auto_replan" | "stop" | "continue_with_warning";

export interface ReviewPolicy {
  policy_revision: number;
  max_fix_cycles: number;
  on_limit: ReviewLimitAction;
  auto_advance_on_approval: boolean;
  severity_defaults: Record<"critical" | "high" | "medium" | "low", ReviewDisposition>;
  pause_on: Array<
    "plan_approval" | "irreversible_external_action" | "unresolved_release_blocker"
  >;
}

export interface ReviewPolicyOverride {
  max_fix_cycles?: number;
  on_limit?: ReviewLimitAction;
  auto_advance_on_approval?: boolean;
  severity_defaults?: Partial<
    Record<"critical" | "high" | "medium" | "low", ReviewDisposition>
  >;
  pause_on?: Array<
    "plan_approval" | "irreversible_external_action" | "unresolved_release_blocker"
  >;
}

export interface ReleaseGuard {
  id: string;
  description: string;
}

export interface AcceptanceCriterion {
  ref: string;
  text: string;
}

export interface ReplanPatch {
  target_work_item_id: string;
  base_plan_revision: number;
  unresolved_finding_ids: string[];
  revised_objective: string | null;
  added_or_changed_criteria: AcceptanceCriterion[];
  changed_instructions: string[];
  added_change_units: Array<{
    id: string;
    path: string;
    target: string;
    operation: "create" | "modify" | "delete";
    requirements: string[];
    satisfies: string[];
  }>;
  added_verification_commands: Array<{
    id: string;
    argv: string[];
    expected_exit_code: 0;
    tier?: VerificationTier;
    satisfies: string[];
  }>;
  added_cross_cutting_impacts: ExecutionCrossCuttingImpact[];
  added_read_only_file_contracts: Array<{
    path: string;
    targets: string[];
  }>;
  explicitly_rejected_hardening: string[];
}

export interface ReplanFindingContext {
  finding_id: string;
  problem_class: string;
  criterion_ref: string;
  normalized_location: string;
  severity: FindingSeverity;
  disposition: ReviewDisposition;
  problem: string;
  required_fix: string | null;
  evidence_refs: string[];
}

export interface ReplanPatchProvenance {
  base_plan_revision: number;
  convergence_report_path: string;
  convergence_review_revision: number;
  unresolved_finding_ids: string[];
  criterion_refs: string[];
  finding_records: ReplanFindingContext[];
  release_guards: ReleaseGuard[];
  evidence_paths: string[];
  model_profile: RoleProfile;
}

export interface ReplanPatchRecord {
  materialization_version?: 2;
  patch: ReplanPatch;
  provenance: ReplanPatchProvenance;
}

export interface ReplanPatchResult {
  patch: ReplanPatch;
  path: string;
  model_profile: RoleProfile;
}

export interface ReviewAccounting {
  review_revision: number;
  fix_cycles_used: number;
  self_review_mutations_used: number;
  plan_revision: number;
}

export interface WarningContinuationAuthorization {
  actor: string;
  source: "run_override" | "approved_plan";
  finding_ids: string[];
  reason: string;
  residual_risk: string;
  evidence_snapshot: string[];
  timestamp: string;
  policy_revision: number;
}

export interface WarningContinuationAuthority {
  actor: string;
  source: WarningContinuationAuthorization["source"];
}

export type ConvergenceRecommendedAction = "advance" | "create_replan" | "stop";

export interface ConvergenceReport {
  work_item_id: string;
  policy_revision: number;
  max_fix_cycles: number;
  plan_revision: number;
  review_revision: number;
  fix_cycles_used: number;
  self_review_mutations_used: number;
  unresolved_finding_ids: string[];
  resolved_finding_ids: string[];
  repeated_finding_ids: string[];
  advisory_finding_ids: string[];
  follow_up_finding_ids: string[];
  evidence_refs: string[];
  remaining_release_guards: string[];
  authorization: WarningContinuationAuthorization | null;
  decision_reason_code: string;
  recommended_action: ConvergenceRecommendedAction;
}

export interface ConvergenceReportSummary {
  path: string;
  plan_revision: number;
  review_revision: number;
  recommended_action: ConvergenceRecommendedAction;
}

export type FindingSource = "verifier" | "verification" | "release_guard";
export type FindingSeverity = "critical" | "high" | "medium" | "low";
export type VerifierBlockerCode =
  | "transport_failure"
  | "permission_failure"
  | "network_failure"
  | "catalog_failure"
  | "test_infrastructure_failure"
  | "corrupt_state";
export type VerifierProblemClass =
  | "correctness"
  | "security"
  | "regression"
  | "verification"
  | "artifact"
  | "browser"
  | "release_guard"
  | "maintainability";

export interface FindingIdentityInput {
  work_item_id: string;
  criterion_ref: string;
  source: FindingSource;
  normalized_location: string;
  problem_class: string;
}

export interface FindingSummary {
  finding_id: string;
  work_item_id: string;
  severity: FindingSeverity;
  disposition: ReviewDisposition;
  first_seen_revision: number;
  last_seen_revision: number;
  occurrences: number;
}

export interface EngineFinding extends FindingSummary, FindingIdentityInput {
  problem: string;
  required_fix: string | null;
  evidence_refs: string[];
  repeated_from?: string;
}

export interface OperationalBlocker {
  code:
    | "invalid_verifier_contract"
    | "transport_failure"
    | "permission_failure"
    | "network_failure"
    | "catalog_failure"
    | "test_infrastructure_failure"
    | "corrupt_state";
  message: string;
  phase: "work_item" | "final_integrated" | "post_pr";
  evidence_refs: string[];
}

export interface ReleaseGuardFailure {
  guard_ref: string;
  severity: FindingSeverity;
  normalized_location: string;
  problem_class: string;
  problem: string;
  required_fix: string | null;
  evidence_refs: string[];
}

export interface NormalizeReviewInput {
  work_item_id: string;
  phase: OperationalBlocker["phase"];
  review_revision: number;
  review: VerifierReview;
  verification: VerificationEvidence;
  criteria: AcceptanceCriterion[];
  criterion_aliases?: Record<string, string>;
  release_guards: ReleaseGuard[];
  severity_defaults: Record<FindingSeverity, ReviewDisposition>;
  verification_criterion_ref: string;
  writable_paths?: string[];
  release_guard_failures?: ReleaseGuardFailure[];
  operational_failure?: Omit<OperationalBlocker, "phase">;
}

export type NormalizedReviewInput =
  | { findings: EngineFinding[]; operational_blocker: null }
  | { findings: []; operational_blocker: OperationalBlocker };

export type ReviewPolicyAction =
  | "advance"
  | "fix"
  | "quality_recovery"
  | "create_replan"
  | "await_plan_approval"
  | "continue_with_warning"
  | "stop";

export interface ReviewPolicyDecision {
  action: ReviewPolicyAction;
  reason_code: string;
  finding_ids: string[];
  policy_revision: number;
  authorization_required: boolean;
}

export type ReviewPhase = "work_item" | "final_integrated" | "post_pr";
export type ReviewEffectState = "pending" | "in_progress" | "complete" | "blocked";

export interface ReviewCycleState {
  cycle_id: string;
  work_item_id: string;
  phase: ReviewPhase;
  review_revision: number;
  policy_hash: string;
  finding_ids: string[];
  accounting_before: ReviewAccounting;
  decision_path: string;
  effect_id: string;
  effect_state: ReviewEffectState;
  effect_owner?: string;
  effect_result?: unknown;
  work_item_progress_reference?: ReviewCycleProgressReference;
  decision: ReviewPolicyDecision;
}

export interface ReviewCycleProgressReference {
  attempts: number;
  review_path: string;
  verification_path: string;
}

export interface EvaluateReviewPolicyInput {
  policy: ReviewPolicy;
  findings: EngineFinding[];
  accounting: ReviewAccounting;
  phase: OperationalBlocker["phase"];
  operational_blocker: null;
  replan_patch_pending: boolean;
  authorization: WarningContinuationAuthorization | null;
  quality_recovery: QualityRecoveryEligibility;
}

export interface QualityRecoveryEligibility {
  configured: boolean;
  active_hands_profile: HandsProfileKind;
  attempts_used: 0 | 1;
}

export interface FindingRevisionInput extends Omit<
  EngineFinding,
  | "finding_id"
  | "first_seen_revision"
  | "last_seen_revision"
  | "occurrences"
  | "repeated_from"
> {
  review_revision: number;
}

export type HandsProfileKind = "primary" | "backup";
export type BackupActivationReason = "primary_usage_limit" | null;
export type RecoveryState = "not_eligible" | "eligible" | "pending" | "in_progress" | "approved" | "exhausted";
export type HandsAttemptKind = "initial" | "primary_fix" | "fix_packet" | "quality_recovery";
export type HandsInvocationOutcome = "completed" | "primary_usage_limit" | "operational_blocker";
export type HandsBlockerCode =
  | "operational_blocker"
  | "test_infrastructure_blocker"
  | "backup_profile_unavailable"
  | "primary_usage_limit_no_backup"
  | "ambiguous_hands_invocation"
  | "escalation_exhausted"
  | "action_fix_exhausted"
  | "invalid_reviewer_action_queue"
  | "replan_required";
export type VerificationFailureClass =
  | "none"
  | "implementation_failure"
  | "operational_blocker"
  | "test_infrastructure_blocker"
  | "replan_required";

export interface HandsInvocationRecord {
  profile: HandsProfileKind;
  model: string;
  reasoning_effort: ReasoningEffort;
  outcome: HandsInvocationOutcome;
  budget_consumed: boolean;
  prompt_path: string;
  stdout_path: string;
  stderr_path: string;
}

export interface HandsAttemptRecord {
  work_item_id: string;
  ordinal: number;
  kind: HandsAttemptKind;
  trigger_review_path: string | null;
  invocations: HandsInvocationRecord[];
  implementation_path: string | null;
  verification_path: string | null;
  review_path: string | null;
  failure_class: VerificationFailureClass | null;
  outcome: "approve" | "request_changes" | "blocked" | "replan_required";
}

export interface ModelProfile {
  model: string;
  reasoning_effort: ReasoningEffort;
  temperature: "low" | "medium";
  responsibilities: string[];
}

export type BrowserConsoleErrorPolicy = "allow_errors" | "no_errors";

export interface BrowserCheckSpec {
  name: string;
  url: string;
  local_server_command: string;
  required_selectors: string[];
  console_error_policy: BrowserConsoleErrorPolicy;
  expected_network: string[];
  screenshot_artifact: string;
  viewport?: {
    width: number;
    height: number;
    mobile?: boolean;
  };
  wait_ms?: number;
  require_no_horizontal_overflow?: boolean;
  forbidden_overlaps?: Array<[string, string]>;
}

export interface BrowserEvidenceReport {
  check_name: string;
  url: string;
  status: "passed" | "failed" | "skipped";
  observed_selectors: string[];
  missing_selectors: string[];
  console_errors: string[];
  expected_network: string[];
  observed_network: string[];
  screenshot_artifact: string;
  console_error_policy: BrowserConsoleErrorPolicy;
  viewport?: {
    width: number;
    height: number;
    mobile: boolean;
  };
  horizontal_overflow?: boolean;
  overlap_failures?: string[];
  pixel_check?: {
    sampled_pixels: number;
    non_blank_pixels: number;
    unique_colors: number;
  };
  failure_reasons?: string[];
  skipped_reason?: string | null;
}

export interface BrowserEvidenceBundle {
  generated_at: string;
  status: "passed" | "failed" | "skipped";
  reports: BrowserEvidenceReport[];
}

export interface BrainHandsConfig {
  version: 1 | 2;
  github: {
    enabled: boolean;
    default_remote: string;
  };
  codex: {
    command: string;
    args_template: string[];
    prompt_transport: "stdin" | "file";
    prompt_file_flag: string;
    timeout_seconds: number;
  };
  retry_policy: {
    max_hands_fix_attempts: number;
    max_replan_attempts: number;
    backup?: HandsBackupPolicy;
    quality_gate?: QualityGatePolicy;
  };
  profiles: Record<ModelRole, ModelProfile>;
  phase_reasoning?: PhaseReasoning;
}

export interface IssueSpec {
  /** Generated GitHub display title; legacy issue specs fall back to goal. */
  title?: string;
  feature_slug?: string;
  work_item_id?: string;
  plan_revision?: number;
  parent_issue_number?: number;
  type: "implementation_task";
  run_id: string;
  parent_request: string;
  goal: string;
  context: string;
  scope: {
    include: string[];
    exclude: string[];
  };
  dependencies: number[];
  implementation_steps: string[];
  acceptance_criteria: string[];
  verification: {
    required_commands: string[];
    manual_checks: string[];
    expected_artifacts: string[];
  };
  review_checklist: string[];
  risk_register: string[];
  handoff_prompt: string;
  browser_checks?: BrowserCheckSpec[];
}

export interface PrReviewFinding {
  severity: "critical" | "high" | "medium" | "low";
  file: string;
  line: number;
  problem: string;
  required_fix: string;
  verification_after_fix: string;
}

export interface PrReview {
  decision: "approve" | "request_changes" | "replan_required";
  requirement_coverage: {
    passed: string[];
    failed: string[];
  };
  verification: {
    commands_reviewed: string[];
    commands_missing: string[];
    artifacts_reviewed: string[];
  };
  findings: PrReviewFinding[];
  residual_risks: string[];
}

export interface RunManifest {
  run_id: string;
  original_request: string;
  repo_root: string;
  created_at: string;
  updated_at: string;
  stage: WorkflowStage;
  current_issue: number | null;
  current_pr: number | null;
  retry_counts: Record<string, number>;
  issue_numbers: number[];
  pr_numbers: number[];
}

export type PreflightStatus = "OK" | "FAIL" | "SKIP";

export interface PreflightCheck {
  command: string;
  args: string[];
  required: boolean;
  status: PreflightStatus;
  available: boolean;
  exit_code: number | null;
  stdout: string;
  stderr: string;
}

export interface PreflightResult {
  checks: PreflightCheck[];
  required_checks_failed: boolean;
}

export interface RunPreflightInput {
  repoRoot: string;
  config: BrainHandsConfig;
  strict: boolean;
  githubMode: boolean;
}

export type VerificationScope = "github" | "local" | "integrated";

export type VerificationIdentity =
  | {
      scope: "github";
      work_item_id: string;
      issue_number: number;
    }
  | {
      scope: "local";
      work_item_id: string;
    }
  | {
      scope: "integrated";
      work_item_id: "integrated";
    };

export function verificationIdentityDirectory(identity: VerificationIdentity): string {
  switch (identity.scope) {
    case "github":
      return `verification/issue-${identity.issue_number}`;
    case "integrated":
      return "verification/integrated";
    case "local": {
      const encoded = Buffer.from(identity.work_item_id, "utf8").toString("base64url");
      return `verification/local/${encoded}`;
    }
  }
}

export function verificationEvidencePath(identity: VerificationIdentity, attempt: number): string {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new Error("Verification attempt must be a positive integer");
  }
  return `${verificationIdentityDirectory(identity)}/attempt-${attempt}/evidence.json`;
}

export function verificationIdentityIssueNumber(identity: VerificationIdentity): number | undefined {
  return identity.scope === "github" ? identity.issue_number : undefined;
}

interface VerificationEvidenceCommon {
  attempt: number;
  /** Relative run-ledger path of this evidence bundle. */
  evidence_path: string;
  commands: Array<{
    command: string;
    /** Exact executable-plus-arguments vector used by the runner when available. */
    argv?: readonly string[];
    exit_code: number | null;
    timed_out: boolean;
    error_code: string | null;
    error_message: string | null;
    signal: string | null;
    stdout_path: string;
    stderr_path: string;
    /** JSON artifact containing stdout, stderr, status, and duration. */
    result_path?: string;
    duration_ms?: number;
  }>;
  artifacts: string[];
  artifact_checks: Array<{
    path: string;
    exists: boolean;
    required: boolean;
  }>;
  browser_evidence: Array<{
    name: string;
    url: string;
    status: "passed" | "failed" | "skipped";
    screenshot_artifact: string;
    screenshot_exists: boolean;
    expected_network: string[];
      observed_network: string[];
      missing_network: string[];
      console_errors: string[];
      missing_selectors: string[];
      failure_reasons: string[];
      evidence_report_path: string | null;
      skipped_reason: string | null;
    }>;
  created_at: string;
}

export type VerificationEvidence =
  | (VerificationEvidenceCommon & {
      verification_scope: "github";
      work_item_id: string;
      issue_number: number;
    })
  | (VerificationEvidenceCommon & {
      verification_scope: "local";
      work_item_id: string;
      issue_number?: never;
    })
  | (VerificationEvidenceCommon & {
      verification_scope: "integrated";
      work_item_id: "integrated";
      issue_number?: never;
    });

/** Version 2 role names used by the deterministic orchestration engine. */
export type RoleName = "brain" | "hands" | "verifier";

export type RunMode = "github" | "local";

export type SandboxMode = "read-only" | "workspace-write";

export interface RoleProfile {
  model: string;
  reasoning_effort: ReasoningEffort;
  sandbox: SandboxMode;
}

export type RunStageV2 =
  | "intake"
  | "preflight"
  | "brain_discovery"
  | "awaiting_discovery_answer"
  | "awaiting_discovery_approach"
  | "awaiting_discovery_brief_approval"
  | "brain_planning"
  | "awaiting_plan_approval"
  | "worktree_setup"
  | "awaiting_github_issue_effects"
  | "github_issue_sync"
  | "implementing"
  | "verifying"
  | "verifier_review"
  | "fixing"
  | "replanning"
  | "final_verification"
  | "awaiting_github_delivery_effects"
  | "delivery"
  | "reflecting"
  | "complete";

export type TerminalOutcome = "delivered" | "human_accepted" | "abandoned" | "closed_blocked";

export interface TerminalDisposition {
  outcome: TerminalOutcome;
  actor: "runtime" | "human";
  reason: string;
  recorded_at: string;
  source_stage: RunStageV2;
  residual_risks: string[];
}

export interface RunIntake {
  task: string;
  repo_root: string;
  mode?: RunMode;
  research?: boolean;
  reflection?: boolean;
  brain_model?: string;
  hands_model?: string;
  verifier_model?: string;
  models?: Partial<Record<RoleName, string>>;
  quality_gate?: QualityGatePolicy;
  hands_backup?: HandsBackupPolicy;
  review_policy?: ReviewPolicyOverride;
  phase_reasoning?: PhaseReasoning;
}

export interface ResolvedRunIntake extends RunIntake {
  mode: RunMode;
  research: boolean;
  reflection: boolean;
  models: Record<RoleName, string>;
  resolved_models: Record<RoleName, string>;
  roles: Record<RoleName, RoleProfile>;
  review_policy?: ReviewPolicy;
  phase_reasoning?: PhaseReasoning;
  warning_continuation_authority?: WarningContinuationAuthority;
}

export interface LegacyWorkItem {
  id: string;
  title: string;
  objective: string;
  acceptance_criteria: string[];
  dependencies: string[];
  implementation_instructions: string[];
  verification_commands: readonly string[][];
  files_expected_to_change: string[];
  included_scope?: string[];
  excluded_scope?: string[];
  expected_artifacts?: string[];
  browser_checks?: BrowserCheckSpec[];
  risks?: string[];
  hands_handoff?: string;
}

export type ExecutionFilePermission = "create" | "modify" | "delete" | "read_only";

export interface ExecutionFileContractEntry {
  path: string;
  permission: ExecutionFilePermission;
  targets: string[];
}

export interface ForbiddenChange {
  path: string;
  except: string[];
  reason: string;
}

export interface ExecutionChangeUnit {
  id: string;
  path: string;
  target: string;
  operation: Exclude<ExecutionFilePermission, "read_only">;
  requirements: string[];
}

export interface ExecutionAcceptanceCriterion {
  id: string;
  statement: string;
  satisfied_by: string[];
}

export interface ExecutionTestCase {
  id: string;
  path: string;
  assertion: string;
  verification_command_ids: string[];
}

export type VerificationTier = "focused" | "cross_cutting";

export type CrossCuttingCategory =
  | "shared_helper"
  | "runtime"
  | "cli_lifecycle"
  | "ledger"
  | "artifact_paths";

export interface ExecutionCrossCuttingImpact {
  change_unit_id: string;
  category: CrossCuttingCategory;
  callers: string[];
  representative_fixtures: string[];
  verification_command_ids: string[];
}

export interface ExecutionVerificationCommand {
  id: string;
  argv: readonly string[];
  expected_exit_code: 0;
  tier?: VerificationTier;
}

export interface ExecutionRisk {
  description: string;
  mitigation: string;
}

export interface ExecutionSpecV2 {
  schema_version: "2.0";
  id: string;
  title: string;
  objective: string;
  dependencies: string[];
  file_contract: ExecutionFileContractEntry[];
  forbidden_changes: ForbiddenChange[];
  change_units: ExecutionChangeUnit[];
  acceptance: ExecutionAcceptanceCriterion[];
  tests: ExecutionTestCase[];
  verification_commands: ExecutionVerificationCommand[];
  cross_cutting_impacts?: ExecutionCrossCuttingImpact[];
  expected_artifacts: string[];
  browser_checks: BrowserCheckSpec[];
  risks: ExecutionRisk[];
  completion_contract: {
    expected_changed_files: string[];
    allow_additional_files: boolean;
    required_acceptance_ids: string[];
  };
  ambiguity_policy: {
    default: "stop_and_report";
    stop_when: string[];
  };
}

/** Canonical v2 execution unit. The legacy workflow continues to use IssueSpec. */
export type WorkItem = ExecutionSpecV2;

export interface ControllerBootstrapFileSpec {
  path: string;
  source_status: "tracked" | "untracked";
  sha256: string;
}

export interface ControllerBootstrapSpec {
  version: 1;
  baseline_commit: string;
  preserved_head: string;
  source_worktree: string;
  commit_message: string;
  files: ControllerBootstrapFileSpec[];
}

export interface ControllerBootstrapEvidenceFile extends ControllerBootstrapFileSpec {
  source_before_sha256: string;
  source_after_sha256: string;
  target_after_sha256: string;
}

export interface ControllerBootstrapEvidence {
  version: 1;
  baseline_commit: string;
  preserved_head: string;
  source_worktree: string;
  merge_commit: string;
  bootstrap_commit: string;
  files: ControllerBootstrapEvidenceFile[];
  completed_at: string;
}

export interface BrainPlan {
  /** Required for newly generated plans; omitted only by legacy persisted runs. */
  feature_slug?: string;
  /** Required as an object or null for new plans; omitted only by legacy persisted runs. */
  parent_issue?: { title: string } | null;
  summary: string;
  assumptions: string[];
  research: string[];
  research_sources: string[];
  architecture: string;
  risks: string[];
  /** Explicit null for new plans; omitted only by legacy persisted plans. */
  controller_bootstrap?: ControllerBootstrapSpec | null;
  work_items: WorkItem[];
  integration_verification: readonly string[][];
}

export type WorkflowProtocol = "legacy-v2" | "durable-discovery-v1" | "bounded-context-v1";
export type DiscoveryMaterialEffect = "scope" | "architecture" | "acceptance_criteria" | "verification";

export interface DiscoveryChoice {
  id: string;
  label: string;
  description: string;
}

export interface DiscoveryQuestion {
  id: string;
  sequence: number;
  category: "required" | "high_value_tradeoff";
  text: string;
  choices: DiscoveryChoice[];
  recommended_choice_id?: string | null;
  recommendation_rationale?: string | null;
  rationale: string;
  material_effects: DiscoveryMaterialEffect[];
  repository_evidence: string[];
  essential_after_soft_limit: string | null;
}

export interface GeneratedDiscoveryQuestion extends DiscoveryQuestion {
  recommended_choice_id: string | null;
  recommendation_rationale: string | null;
}

export interface DiscoveryApproach {
  id: string;
  title: string;
  summary: string;
  tradeoffs: string[];
  recommended: boolean;
  recommendation_rationale: string | null;
}

export interface DiscoveryDecision {
  id: string;
  statement: string;
  source_question_ids: string[];
}

export interface DiscoveryAssumption {
  id: string;
  statement: string;
  source: "brain_inference" | "user_instruction" | "proceed_with_assumptions";
  source_question_ids: string[];
}

export interface DiscoveryBrief {
  revision: number;
  goal: string;
  problem: string;
  success_criteria: string[];
  constraints: string[];
  decisions: DiscoveryDecision[];
  assumptions: DiscoveryAssumption[];
  selected_approach_id: string | null;
  selected_approach_rationale: string | null;
  out_of_scope: string[];
  accepted_risks: string[];
  repository_evidence: string[];
}

export type DiscoveryOutcome =
  | { outcome: "ask_question"; question: DiscoveryQuestion }
  | {
      outcome: "ready_for_brief" | "no_discovery_needed";
      rationale: string;
      repository_evidence: string[];
      approaches: DiscoveryApproach[];
      alternatives_omitted_reason: string | null;
      brief: DiscoveryBrief;
    };

export interface DiscoveryArtifactRecord {
  revision: number;
  path: string;
  sha256: string;
}

export interface DiscoveryQuestionAnswerArtifactRecord {
  cycle: number;
  sequence: number;
  question_id: string;
  path: string;
  sha256: string;
}

export interface DiscoveryProceedIntent {
  cycle: number;
  question_id: string;
  path: string;
}

export interface DiscoveryManifestState {
  cycle: number;
  cycle_kind: "initial" | "planning_gap";
  asked_questions: number;
  answered_questions: number;
  current_question_id: string | null;
  current_approaches_revision: number | null;
  selected_approach_id: string | null;
  current_brief_revision: number | null;
  current_readiness_revision: number | null;
  approved_brief_revision: number | null;
  approved_brief_sha256: string | null;
  proceed_with_assumptions: DiscoveryProceedIntent | null;
  pending_action_path: string | null;
  question_artifacts: Record<string, DiscoveryQuestionAnswerArtifactRecord>;
  answer_artifacts: Record<string, DiscoveryQuestionAnswerArtifactRecord>;
  readiness_revisions: Record<string, DiscoveryArtifactRecord>;
  brief_revisions: Record<string, DiscoveryArtifactRecord>;
}

export type DiscoveryPendingAction =
  | {
      state: "awaiting_discovery_answer";
      question: DiscoveryQuestion;
      permitted_next_actions: ["answer-discovery", "proceed-discovery"];
    }
  | {
      state: "awaiting_discovery_approach";
      revision: number;
      approaches: DiscoveryApproach[];
      permitted_next_actions: ["select-discovery-approach"];
    }
  | {
      state: "awaiting_discovery_brief_approval";
      revision: number;
      brief: DiscoveryBrief;
      readiness_revision: number;
      readiness_sha256: string;
      permitted_next_actions: ["approve-discovery", "revise-discovery"];
    };

export interface PlanningDiscoveryGap {
  outcome: "discovery_gap";
  evidence: string[];
  question: DiscoveryQuestion;
}

export interface DiscoveryDecisionCoverage {
  decision_id: string;
  work_item_ids: string[];
  acceptance_ids: string[];
  verification_command_ids: string[];
  no_implementation_effect: string | null;
}

export interface DiscoveredBrainPlan extends BrainPlan {
  discovery_brief_revision: number;
  discovery_brief_sha256: string;
  discovery_decision_coverage: DiscoveryDecisionCoverage[];
  accepted_risks: string[];
  out_of_scope: string[];
}

export interface ImplementationResult {
  work_item_id: string;
  changed_files: string[];
  tests_added_or_changed: string[];
  commands_attempted: readonly string[][];
  completed_steps: string[];
  remaining_risks: string[];
}

export interface HandsSelfReviewReport {
  work_item_id: string;
  parent_attempt: number;
  mutation_kind: "initial" | "normal_fix" | "reviewer_action" | "quality_recovery";
  pass: number;
  active_action_id: string | null;
  findings: string[];
  fixes_applied: string[];
  changed_files: string[];
  commands_attempted: readonly string[][];
  remaining_findings: string[];
  ready_for_resolution_check: boolean;
}

export interface VerifierFinding {
  severity: "critical" | "high" | "medium" | "low";
  file: string;
  line: number | null;
  /** Exact acceptance criterion that this finding fails. */
  acceptance_criterion: string;
  /** Optional only for persisted legacy reviews; strict generated output requires it. */
  problem_class?: VerifierProblemClass;
  problem: string;
  required_fix: string;
  /** Optional only for persisted legacy reviews; strict generated output requires it. */
  evidence_refs?: string[];
  /** Present only on persisted legacy reviews. */
  re_verification?: readonly string[][];
  /** Required for newly generated actionable findings. */
  remediation?: VerifierRemediationClaimV1;
}

export interface ReviewerAction extends VerifierFinding {
  action_id: string;
  order: number;
  depends_on: string[];
}

export interface ReviewerActionQueue {
  contract_version?: "review_fix_packet_v1";
  review_revision: number;
  work_item_id: string;
  actions: ReviewerAction[];
}

export type ActionResolutionDecision =
  | "resolved"
  | "still_open"
  | "blocked"
  | "replan_required";

export interface ActionResolutionReview {
  review_revision: number;
  action_id: string;
  action_attempt: number;
  decision: ActionResolutionDecision;
  evidence_reviewed: string[];
  remaining_problem: string | null;
  required_next_fix: string | null;
}

export interface QueueCostEstimate {
  maximum_hands_calls: number;
  maximum_focused_verifier_calls: number;
  final_full_verifier_calls: 1;
}

export interface VerifierReview {
  work_item_id: string;
  attempt: number;
  final: boolean;
  decision: "approve" | "request_changes" | "blocked" | "replan_required";
  failure_class?: VerificationFailureClass;
  blocker?: string | null;
  blocker_code?: VerifierBlockerCode | null;
  acceptance_coverage: string[];
  evidence_reviewed: string[];
  findings: VerifierFinding[];
  residual_risks: string[];
}

export interface ReflectionClassifications {
  implementation_defects: string[];
  planning_defects: string[];
  verification_gaps: string[];
  environment_failures: string[];
  external_blockers: string[];
  unnecessary_cost_or_rework: string[];
}

export interface Reflection {
  outcome_summary: string;
  what_worked: string[];
  what_was_correct: string[];
  what_failed: string[];
  root_causes: string[];
  avoidable_rework: string[];
  process_improvements: string[];
  improvements: string[];
  classifications: ReflectionClassifications;
  candidate_regression_tests: string[];
  evidence_paths: string[];
}

export interface ImprovementPlan {
  reflection_source: string;
  observed_problem: string[];
  evidence: string[];
  recommended_changes: string[];
  expected_benefits: string[];
  implementation_sequence: string[];
  tests_and_acceptance_criteria: string[];
  risks: string[];
  out_of_scope: string[];
}

export interface RunEvent {
  event_id: string;
  run_id: string;
  stage: RunStageV2;
  type: string;
  timestamp: string;
  actor: string;
  payload: Record<string, unknown>;
}

export type PlanApprovalReasonCode = "initial_plan" | "material_replan";

export type PlanDeltaCategory =
  | "objective"
  | "scope"
  | "files"
  | "acceptance"
  | "verification"
  | "risks"
  | "external_effects"
  | "destructive_actions";

export interface PlanDeltaEntryV1 {
  category: PlanDeltaCategory;
  pointer: string;
  operation: "add" | "remove" | "replace";
  before: unknown | null;
  after: unknown | null;
}

export interface PlanApprovalDeltaV1 {
  schema_version: 1;
  base_revision: number | null;
  proposed_revision: number;
  entries: PlanDeltaEntryV1[];
  unchanged_high_impact_categories: PlanDeltaCategory[];
}

export interface PlanApprovalSubjectV1 {
  schema_version: 1;
  gate: "plan";
  reason_code: PlanApprovalReasonCode;
  run_id: string;
  plan_revision: number;
  base_plan_revision: number | null;
  plan_sha256: string;
  prerequisite_subject_sha256: string;
  execution_context_sha256: string;
  authority_contract_sha256: string;
  decision_contract_sha256: string;
}

export interface PlanApprovalRequestV1 {
  schema_version: 1;
  gate?: "initial_plan" | "replan";
  requested_revision?: number;
  base_revision?: number | null;
  artifact_path?: string;
  artifact_sha256?: string;
  subject: PlanApprovalSubjectV1;
  approval_subject_sha256: string;
  fresh_approval_required?: boolean;
  reuse_reason?: string | null;
  reason_code?: PlanApprovalReasonCode;
  reason?: string;
  plan_path: string;
  delta: PlanApprovalDeltaV1;
  additional_approvals_expected: "none" | "only_if_material_replan" | "manual_delivery_authority";
}

export interface PendingPlanApprovalV1 {
  schema_version: 1;
  proposed_revision: number;
  base_revision: number | null;
  request_path: string;
  request_sha256: string;
  approval_subject_sha256: string;
}

export interface PlanRevision {
  revision: number;
  path: string;
  sha256: string;
  candidate_path?: string;
  candidate_invocation_id?: string;
  acceptance_criteria?: Record<string, AcceptanceCriterion[]>;
  origin?: "initial" | "replan";
  base_revision?: number | null;
  approval_request_path?: string;
  approval_request_sha256?: string;
  approval_subject_sha256?: string;
  decision_contract_sha256?: string;
}

export interface WorkItemProgress {
  status: "pending" | "in_progress" | "complete" | "blocked";
  attempts: number;
  github_status_transition_at?: string;
  context_base_commit?: string;
  context_plan_revision?: number;
  summary_path?: string;
  summary_sha256?: string;
  primary_fix_attempts?: number;
  quality_recovery_attempts?: number;
  recovery_state?: RecoveryState;
  last_attempt_path?: string;
  blocker_code?: HandsBlockerCode;
  review_revision?: number;
  review_cycle_path?: string;
  review_effect_id?: string;
  fix_reservation_id?: string;
  queue_state?: ActionQueueState;
  queue_path?: string;
  active_action_id?: string | null;
  active_action_attempt?: number;
  completed_action_ids?: string[];
  mutation_kind?: "initial" | "normal_fix" | "reviewer_action" | "quality_recovery";
  self_review_pass?: number;
  self_review_state?: SelfReviewState;
  mutation_verification_path?: string;
  self_review_paths?: Record<string, string>;
  self_review_verification_paths?: Record<string, string>;
  self_review_claim_owner?: HandsProfileKind;
  backup_claim_transfer_pending?: boolean;
  focused_review_path?: string | null;
  terminal_hands_fix_attempts?: number;
  fix_packet_path?: string;
  fix_packet_sha256?: string;
  fix_packet_result_path?: string;
  fix_packet_attempt?: number;
  fix_packet_supplement_path?: string | null;
  candidate_recheck?: {
    phase: "final_integrated" | "post_pr";
    attempt: number;
    commit_sha: string;
    state: "reserved" | "verified" | "indexed" | "reviewed";
    verification_path?: string;
    index_path?: string;
    review_path?: string;
  };
  [key: string]: unknown;
}

export type AssuranceOutcome = "verified_ready" | "human_accepted" | "blocked" | "abandoned";

export interface AssuranceAssessment {
  outcome: AssuranceOutcome;
  assessed_at: string;
  approved_plan_revision: number | null;
  approved_plan_sha256: string | null;
  candidate_commit: string | null;
  blocker_code: string | null;
  blocker: string | null;
  missing_evidence: string[];
  invalid_evidence: string[];
  zero_attempt_work_items: string[];
  acceptance_path: string | null;
}

export interface RiskAcceptanceArtifact {
  version: 1;
  run_id: string;
  gate: "final-delivery";
  approved_plan_revision: number;
  approved_plan_sha256: string;
  candidate_commit: string;
  blocker_code: string;
  blocker: string;
  missing_evidence: string[];
  invalid_evidence: string[];
  actor: string;
  timestamp: string;
  reason: string;
}

export interface AbandonmentArtifact {
  version: 1;
  run_id: string;
  actor: string;
  timestamp: string;
  reason: string;
}

export interface RemoteSynchronizationEvidence {
  version: 1;
  run_id: string;
  branch_name: string;
  remote_name: string;
  pull_request_number: number;
  pull_request_url: string;
  local_candidate_sha: string | null;
  mapped_pr_sha: string | null;
  remote_head_sha: string | null;
  problems: Array<{
    source: "local" | "pull_request" | "remote";
    code: "lookup_unavailable" | "not_found" | "identity_mismatch" | "invalid_response" | "command_failed";
  }>;
  synchronized: boolean;
  observed_at: string;
}

export type ActionQueueState = "pending" | "in_progress" | "complete" | "blocked";
export type SelfReviewState = "pending" | "invoking" | "verification_pending" | "complete";

export type GithubEffectsProtocol = "legacy-run-v1" | "task-lineage-v1";
export type GithubEffectPhase = "issue_sync" | "pull_request_delivery";

export interface GithubEffectPreviewRef {
  phase: GithubEffectPhase;
  revision: number;
  path: string;
  sha256: string;
  plan_revision: number;
  plan_sha256: string;
  state: "previewed" | "applying" | "applied" | "invalidated";
}

export interface GithubCleanupBatch {
  version: 1;
  lineage_id: string;
  reason: "completed" | "not_planned";
  target_numbers: number[];
  target_sha256: string;
  target_states: Record<string, "pending" | "complete" | "blocked">;
  state: "pending" | "complete" | "blocked";
  started_at: string;
  completed_at: string | null;
}

export interface LegacyGithubRestoreAuthority {
  version: 1;
  lineage_id: string;
  migration_run_id: string;
  plan_revision: number;
  plan_sha256: string;
  original_manifest_sha256: string;
  original_stage:
    | "github_issue_sync"
    | "implementing"
    | "verifying"
    | "verifier_review"
    | "fixing"
    | "replanning"
    | "final_verification"
    | "awaiting_github_delivery_effects"
    | "delivery"
    | "reflecting";
}

export interface GitHubIds {
  issue_numbers: number[];
  work_item_issue_map?: Record<string, number>;
  parent_issue_number?: number | null;
  pull_request_numbers: number[];
  pull_request_urls: Record<string, string>;
}

export type RecoveryDisposition =
  | "active"
  | "awaiting_external_fix"
  | "diagnostic_stop"
  | "exhausted";

export interface RecoveryScopeStateV1 {
  version: 1;
  head_sequence: number;
  head_decision_path: string | null;
  blocker_fingerprint: string | null;
  progress_subject_sha256: string | null;
  consecutive_without_progress: number;
  disposition: RecoveryDisposition;
  diagnostic_path: string | null;
  authorization_path: string | null;
}

export interface RecoveryDecisionArtifactV1 {
  version: 1;
  run_id: string;
  scope_id: string;
  sequence: number;
  observation: RecoveryObservationV1;
  requested_effect: RecoveryRequestedEffect;
  requested_effect_reason: string;
  previous_state: RecoveryScopeStateV1 | null;
  next_state: RecoveryScopeStateV1;
  guard_action: RecoveryGuardAction;
  previous_decision_event_id: string | null;
  decision_event_id: string;
  diagnostic_intent?: RecoveryDiagnosticArtifactV1;
  recorded_at: string;
}

export interface RecoveryOwnedEvidenceRefsV1 {
  implementation_path: string | null;
  verification_path: string | null;
  review_path: string | null;
}

export type RecoveryDiagnosticClassificationV1 =
  | {
      kind: "review_policy";
      review_cycle_path: string;
      effect_id: string;
    }
  | {
      kind: "operational";
      failure_class: RecoveryFailureClass;
      blocker_code: string;
    };

interface RecoveryDiagnosticArtifactBaseV1 {
  version: 1;
  run_id: string;
  scope_id: string;
  journal_sequence: number;
  decision_path: string;
  guard_action: "diagnostic_stop" | "exhausted_stop";
  previous_observation: RecoveryObservationV1 | null;
  current_observation: RecoveryObservationV1;
  requested_effect: RecoveryRequestedEffect;
  requested_effect_reason: string;
  owned_evidence_refs: RecoveryOwnedEvidenceRefsV1;
  progress: {
    subject: RecoveryProgressSubjectV1;
    sha256: string;
  };
  recorded_at: string;
}

interface RecoveryReviewPolicyDiagnosticArtifactV1 extends RecoveryDiagnosticArtifactBaseV1 {
  classification: Extract<RecoveryDiagnosticClassificationV1, { kind: "review_policy" }>;
  policy_decision: ReviewPolicyDecision;
  review_accounting: ReviewAccounting;
  quality_recovery_usage: {
    work_item_id: string;
    active_hands_profile: HandsProfileKind;
    attempts_used: 0 | 1;
  };
}

interface RecoveryOperationalDiagnosticArtifactV1 extends RecoveryDiagnosticArtifactBaseV1 {
  classification: Extract<RecoveryDiagnosticClassificationV1, { kind: "operational" }>;
  policy_decision: null;
  review_accounting: null;
  quality_recovery_usage: null;
}

export type RecoveryDiagnosticArtifactV1 =
  | RecoveryReviewPolicyDiagnosticArtifactV1
  | RecoveryOperationalDiagnosticArtifactV1;

export interface DiagnosticRecoveryAuthorizationV1 {
  version: 1;
  authorization_id: string;
  run_id: string;
  scope_id: string;
  journal_sequence: number;
  decision_path: string;
  blocker_fingerprint: string;
  progress_subject_sha256: string;
  actor: string;
  note: string;
  note_sha256: string;
  recorded_at: string;
}

export interface DiagnosticRecoveryConsumptionV1 {
  version: 1;
  authorization_id: string;
  run_id: string;
  scope_id: string;
  effect_attempt_id: string;
  consumed_at: string;
}

export interface RunRecoveryStateV1 {
  version: 1;
  active_scope: string | null;
  scopes: Record<string, RecoveryScopeStateV1>;
}

export interface TaskLineageV1 {
  version: 1;
  lineage_id: `task-lineage:${string}`;
  root_run_id: string;
  predecessor_run_id: string | null;
  predecessor_abandonment_sha256: string | null;
}

export interface ReplacementReservationV1 {
  version: 1;
  predecessor_run_id: string;
  predecessor_abandonment_path: string;
  predecessor_abandonment_sha256: string;
  successor_run_id: string;
  task_lineage: TaskLineageV1;
  actor: string;
  reason: string;
  created_at: string;
}

export interface ReplacementPredecessorLinkV1 {
  version: 1;
  predecessor_run_id: string;
  predecessor_reservation_sha256: string;
  successor_run_id: string;
  task_lineage: TaskLineageV1;
}

export interface ReplacementCompletionV1 {
  version: 1;
  predecessor_run_id: string;
  successor_run_id: string;
  reservation_sha256: string;
  predecessor_link_sha256: string;
  completed_at: string;
}

export interface ControllerRecoveryStateV1 {
  version: 1;
  transition_count: number;
  head_path: string | null;
}

export interface RunManifestV2 {
  version: 2;
  schema_version: 2;
  run_id: string;
  original_request: string;
  repo_root: string;
  created_at: string;
  updated_at: string;
  stage: RunStageV2;
  workflow_protocol: WorkflowProtocol;
  task_lineage_id: string | null;
  github_effects_protocol: GithubEffectsProtocol;
  github_effects: Record<GithubEffectPhase, GithubEffectPreviewRef | null>;
  github_cleanup: GithubCleanupBatch | null;
  legacy_github_restore?: LegacyGithubRestoreAuthority | null;
  discovery: DiscoveryManifestState | null;
  current_work_item_id: string | null;
  retry_counts: Record<string, number>;
  issue_numbers: number[];
  pull_request_numbers: number[];
  events: string[];
  mode: RunMode;
  run_mode: RunMode;
  active_hands_profile: HandsProfileKind;
  backup_activation_reason: BackupActivationReason;
  quality_gate_policy?: QualityGatePolicy | null;
  hands_backup_policy?: HandsBackupPolicy | null;
  hands_backup_catalog?: HandsBackupCatalogSnapshot | null;
  review_policy_snapshot?: ReviewPolicy;
  warning_continuation_authority?: WarningContinuationAuthority;
  release_guards?: ReleaseGuard[];
  review_accounting?: ReviewAccounting;
  finding_index?: Record<string, FindingSummary>;
  convergence_reports?: Record<string, ConvergenceReportSummary>;
  role_profiles: Partial<Record<RoleName, RoleProfile>>;
  selected_role_profiles: Partial<Record<RoleName, RoleProfile>>;
  current_revision: number | null;
  approved_revision: number | null;
  current_plan_revision: number | null;
  approved_plan_revision: number | null;
  plan_revisions: Record<string, PlanRevision>;
  pending_plan_approval: PendingPlanApprovalV1 | null;
  /** Irreversible discriminator for exact plan-subject approval semantics. */
  approval_protocol_version?: 1 | null;
  /** First revision governed by exact plan-subject approval semantics. */
  approval_protocol_start_revision?: number | null;
  run_configuration_sha256: string | null;
  /** Monotonic generation for durable execution-authority compare-and-set. */
  execution_epoch?: number;
  /** At most one mutating runtime may own a run at a time. */
  execution_lease?: ExecutionLeaseV1 | null;
  source_commit: string | null;
  worktree_path: string | null;
  branch_name: string | null;
  /** Durable crash-recovery marker for pin-before-create checkout allocation. */
  checkout_allocation_state?: "pending" | "ready" | null;
  work_item_progress: Record<string, WorkItemProgress>;
  work_item_issue_map: Record<string, number>;
  github_ids: GitHubIds;
  delivery_state: "pending" | "ready" | "complete" | "blocked";
  assurance_outcome: AssuranceOutcome | null;
  assurance_assessment_path: string | null;
  remote_synchronization_path?: string | null;
  risk_acceptance_path: string | null;
  risk_acceptance_history: string[];
  abandonment_path: string | null;
  terminal: TerminalDisposition | null;
  final_artifact_paths: string[];
  final_verifier_index_path?: string | null;
  final_verifier_index_sha256?: string | null;
  reflection_index_path?: string | null;
  reflection_protocol?: ReflectionProtocol;
  resource_budget_policy?: unknown;
  last_blocker: string | null;
  intake_path: string;
  controller_provenance?: ControllerProvenance;
  brain_controller_claim?: BrainControllerClaim | null;
  planning_recovery?: PlanningRecoveryState | null;
  recovery: RunRecoveryStateV1;
  task_lineage: TaskLineageV1 | null;
  controller_recovery: ControllerRecoveryStateV1;
}

export interface ExecutionLeaseActiveEffectV1 {
  invocation_id: string;
  kind: string;
  hostname: string;
  child_pids: number[];
  started_at: string;
}

export interface ExecutionLeaseV1 {
  version: 1;
  token: string;
  epoch: number;
  mode: "execution" | "replan_preparation" | "pending_publication" | "initial_pending_publication";
  authority_sha256: string;
  owner: {
    invocation_id: string;
    hostname: string;
    pid: number;
    process_started_at: string;
  };
  active_effect: ExecutionLeaseActiveEffectV1 | null;
  acquired_at: string;
  heartbeat_at: string;
}

export interface ExecutionLeaseClaim {
  runDir: string;
  token: string;
  epoch: number;
  invocationId: string;
}

export interface PlanningRecoveryState {
  lineage_id: string;
  approved_brief_revision: number | null;
  approved_brief_sha256: string | null;
  state: "full_generation" | "repairing" | "blocked" | "ready";
  full_attempts_used: number;
  repair_attempts_used: number;
  latest_candidate_ref: string | null;
  latest_candidate_sha256: string | null;
  latest_failure_ref: string | null;
  latest_diagnostic_fingerprint: string | null;
}

export interface BrainControllerClaim {
  phase: "planning";
  invocation_id: string;
  owner: string;
  owner_pid: number;
  artifact_name: string;
  claimed_at: string;
  attempt_kind?: "full" | "repair";
  attempt_ordinal?: number;
}

export interface ControllerProvenance {
  self_hosting: boolean;
  mode: "installed" | "development_checkout";
  executable_path: string;
  package_root: string;
  package_name: string;
  package_version: string;
  package_hash_algorithm: "sha256";
  package_hash: string;
  candidate_commit: string;
}

export type ControllerRuntimeSnapshotV1 = Omit<ControllerProvenance, "candidate_commit">;

export interface ControllerRuntimeSubjectV1 {
  version: 1;
  package_name: string;
  package_version: string;
  mode: "installed" | "development_checkout";
  package_hash_algorithm: "sha256";
  package_hash: string;
}

export interface ControllerRecoveryArtifactV1 {
  version: 1;
  run_id: string;
  sequence: number;
  stage: RunStageV2;
  actor: string;
  reason: string;
  recorded_at: string;
  previous_subject_sha256: string;
  next_subject_sha256: string;
  previous_runtime: ControllerRuntimeSnapshotV1;
  next_runtime: ControllerRuntimeSnapshotV1;
  candidate_head_at_recovery: string;
  blocker_fingerprint: string | null;
  event_id: string;
}

export interface ConfigV2 {
  version: 2;
  github: {
    default_remote: string;
    enabled?: boolean;
  };
  codex: {
    command: string;
    timeout_seconds: number;
    isolate_user_config: boolean;
    args_template?: string[];
    prompt_transport?: "stdin" | "file";
    prompt_file_flag?: string;
  };
  retry_policy: {
    max_hands_fix_attempts: number;
    max_replan_attempts: number;
    backup?: HandsBackupPolicy;
    quality_gate?: QualityGatePolicy;
  };
  profiles: Record<RoleName, RoleProfile>;
  phase_reasoning: PhaseReasoning;
  review_policy?: ReviewPolicyOverride;
  resource_budget: ResourceBudgetPolicyV1;
}

/** Legacy role aliases retained while the recovery workflow is migrated. */
export type LegacyModelRole = ModelRole;
export type LegacyBrainHandsConfig = BrainHandsConfig;
