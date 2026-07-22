import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { access, lstat, readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { classifyCodexFailure, CodexInvocationError, SubprocessCodexAdapter, type CodexAdapter } from "../adapters/codex.js";
import { readModelCatalog, validateCatalogProfile, type ModelCatalogSnapshot } from "../adapters/model-catalog.js";
import {
  collectScopedWorktreeDiff,
  collectCommittedRecoveryEvidence,
  collectWorktreeBlobEvidence,
  commitWorkItem,
  createRunWorktree,
  getGitSnapshot,
  getWorktreeChangedFiles,
  prepareWorkItemCommitIntent,
  pushBranch,
  pushCommitToBranch,
  requireRemoteBranchAtLocalHead,
  restoreTrackedWorktreeFiles,
  runControllerBootstrap,
  resolveLocalCommitProvenance,
  resolveLocalHeadSha,
  resolveRemoteBranchSha,
  runWorktreeBranchName,
  runWorktreePath,
  verifyRunWorktreeIdentity,
  type GitSnapshot,
} from "../adapters/git.js";
import {
  formatIssueBody,
  formatParentIssueBody,
  reconcileManagedIssueBody,
  type GitHubIssueReference,
  type GitHubIssueObservation,
  type GitHubParentIssueMarker,
  GitHubAdapter,
  GitHubIssueMarker,
  GitHubPullRequestReference,
  OpenIntegratedPullRequestInput,
  IntegratedWorkItemReference,
  type ParentIssueSpec,
  ISSUE_LABELS,
  PARENT_ISSUE_LABELS,
} from "../adapters/github.js";
import { verificationEvidencePath, verificationIdentityDirectory } from "../core/types.js";
import { artifactRefFromBytes, canonicalJsonBytes, type ArtifactRefV1 } from "../core/context-contracts.js";
import { formatParentIssueTitle, formatWorkItemIssueTitle, resolveFeatureSlug } from "../core/issue-naming.js";
import { topologicallySortWorkItems } from "../core/work-item-order.js";
import { createWorkItemIssueResolutionContext, resolveWorkItemIssueNumber } from "./work-item-issue-resolution.js";
import {
  assertVerificationNamespaceAvailable,
  readHandsSelfReviewReportArtifact,
  readOptionalValidatedArtifact,
  readManifestV2,
  readVerifiedPlanRevision,
  reconcilePreparedPlanApprovalBoundary,
  appendRunEvent,
  recordTerminalDisposition,
  recordTerminalDispositionWithCleanup,
  consumeReadyLegacyGithubRestore,
  transitionRun,
  updateManifestV2,
  withRunLedgerTransaction,
  writeImmutableTextArtifact,
  writeReviewerActionQueueArtifact,
  writeTextArtifact,
  type RunLedgerTransactionHooks,
  verifyPersistedPlanApprovalSubject,
  verifyHistoricalApprovedRuntimeSubject,
  requiresPinnedRuntimeAuthority,
  derivePlanAcceptanceCriteria,
  acquireExecutionLease,
  assertExecutionLease,
  beginExecutionEffect,
  recordExecutionEffectChild,
  endExecutionEffect,
  releaseExecutionLease,
  setRunCheckoutIdentity,
  markRunCheckoutReady,
  retryVerifierReviewAfterInvalidReplanContract,
  VerifierContractRetryAlreadyUsedError,
} from "../core/ledger.js";
import { requirePersistedPullRequestMapping } from "../core/github-pull-request-mapping.js";
import type {
  BrainPlan,
  ImplementationResult,
  ResolvedRunIntake,
  RunManifestV2,
  VerificationEvidence,
  VerificationIdentity,
  VerifierFinding,
  VerifierReview,
  WorkItem,
  ConfigV2,
  HandsAttemptKind,
  HandsSelfReviewReport,
  HandsBlockerCode,
  ReviewerAction,
  ReviewerActionQueue,
  AcceptanceCriterion,
  AssuranceAssessment,
  EngineFinding,
  ReviewCycleState,
  ReviewPhase,
  ReasoningEffort,
  WarningContinuationAuthorization,
  ControllerBootstrapSpec,
  GithubEffectPreviewRef,
  ExecutionLeaseClaim,
  WorkItemProgress,
} from "../core/types.js";
import { assertPlanReady, serializePersistedPlan } from "../core/execution-spec.js";
import { DEFAULT_PHASE_REASONING, defaultConfig } from "../core/config.js";
import { actionResolutionReviewSchema, assuranceAssessmentSchema, controllerBootstrapSpecSchema, convergenceReportSchema, handsSelfReviewReportSchema, reviewCycleStateSchema, runManifestV2Schema, verificationEvidenceSchema } from "../core/schema.js";
import { workItemDecisionTransition } from "../core/run-state.js";
import { assertNotAbandoned, persistFinalDeliveryAssessmentAtBoundary } from "./assurance.js";
import {
  recordRemoteSynchronization,
  type RecordRemoteSynchronizationResult,
} from "./remote-synchronization.js";
import * as controllerProvenance from "../core/controller-provenance.js";
import {
  assertCurrentExecutionAuthority,
  currentExecutionAuthority,
  currentCheckoutAllocationAuthority,
  runWithExecutionAuthority,
  runWithCheckoutAllocationAuthority,
  runWithExecutionAuthorityPreflight,
  waitForCurrentExecutionEffects,
  withCurrentExecutionEffect,
} from "../core/execution-context.js";
import { readOwnedRunFile } from "../core/owned-evidence.js";
import type { ResolvedRunConfiguration } from "../core/run-configuration.js";
import { loadVerifiedPlanBundle } from "./verified-plan.js";
import { runCommand } from "../core/executor.js";
import { runVerification, type RunVerificationInput } from "../verification/runner.js";
import { validatePersistedVerificationEvidence } from "../verification/evidence.js";
import { browserEvidenceArtifactsMatchIdentity } from "../core/verification-provenance.js";
import {
  runHandsWorkItem,
  runHandsFixPacket,
  readHandsFixPacketInvocationProfile,
  type HandsFixPacketInput,
  type HandsFixPacketResult,
  type HandsFixPacketInvocationProfile,
  type HandsWorkItemInput,
  type HandsWorkItemResult,
} from "./worker.js";
import { classifyFixPacketCompilationFailure, compileReviewFixPacket, correctVerifierRemediationClaim, FixPacketRequiresReplanError, loadReviewFixPacket, persistReviewFixPacket, persistFixAttemptSupplement, fixAttemptSupplementPath, reviewFixPacketRoot, assertFixPacketChangedFiles, assertRecoveredFixPacketCommitEvidence } from "./fix-packets.js";
import { fingerprintFinding } from "./findings.js";
import { assertFixPacketResolutionMatchesPacket, assertFixPacketResultMatchesPacket, fixAttemptSupplementV1Schema, fixPacketResolutionV1Schema, fixPacketResultV1Schema, hashReviewFixPacket, type FixAttemptSupplementV1, type FixPacketResolutionV1, type ReviewFixPacketV1 } from "../core/review-fix-packet.js";
import {
  assertVerifierScopeSnapshot,
  loadVerifierScopeAuthority,
  verifyWorkItem,
  type VerifyWorkItemInput,
  type VerifyWorkItemResult,
} from "./verifier.js";
import { replayGitHubStatusIntents, syncRuntimeDeliveryStatus, syncRuntimeWorkItemStatus } from "./github-status.js";
import {
  expectedClosingIssueNumbers,
  reconcileClosingLinksBlock,
} from "../github/issue-lifecycle.js";
import { issueOwnershipMatches, reconcileGitHubPullRequestLinks } from "../github/issue-reconciliation.js";
import type { ProgressReporter } from "../progress/log.js";
import { artifactPathSchema, brainPlanSchema } from "../core/schema.js";
import {
  runHandsSelfReview,
  type HandsSelfReviewInput,
  type HandsSelfReviewResult,
} from "./self-review.js";
import {
  actionAttemptDecision,
  actionResolutionReviewPath,
  bindObservedFixPacketResolution,
  verifyReviewerAction,
  verifyReviewFixPacket,
  type ActionResolutionResult,
  type FixPacketResolutionResult,
  type VerifyReviewFixPacketInput,
  type VerifyReviewerActionInput,
} from "./action-verifier.js";
import {
  nextQueueAction,
  normalizeReviewerActions,
  normalizePolicyReviewerActions,
  assertPolicyReviewerQueueAuthority,
  parseFixEffectResult,
  validateReviewerActionQueue,
  type FixEffectResult,
} from "./reviewer-actions.js";
import { loadFindingRevisionRecords, recordFindingRevision } from "./findings.js";
import { criterionAliasesForAcceptance, normalizeReviewInputs } from "./review-normalizer.js";
import { evaluateReviewPolicy, isReviewEffectAction, qualityRecoveryEligibilitySnapshot } from "./review-policy.js";
import { writeConvergenceReport } from "./convergence.js";
import { buildHandsRecoveryPacket, legacyQualityRecoveryAttempts } from "./hands-recovery.js";
import {
  createReplanPatch,
  InvalidReplanCandidateError,
  NoMaterialReplanError,
  prepareReplanApprovalBoundary,
  ReplanBoundaryPostCommitError,
  reconcilePendingReplanApprovalBoundary,
  resolvePendingReplanTarget,
  type PreparedReplanApprovalBoundary,
  type PreparedReplanApprovalCoordinates,
} from "./replan.js";
import {
  applyIssueEffectPreview,
  assertReadyAppliedIssueSet,
  completeIssueReconciliation,
  reconcileIssueMutation,
  type IssueReconciliationResult,
} from "./github-issue-reconciliation.js";
import { loadOrCreateWarningAuthorization } from "./authorization.js";
import { formatRunStatusComment, readOperatorStatus } from "./status.js";
import {
  buildRecoveryProgressSubject,
  gateOperationalRecoveryAttempt,
  gateReviewPolicyEffect,
  type OperationalRecoveryGateResult,
  recordAuthorizedRecoveryOutcome,
  recordOperationalRecovery,
} from "./recovery-runtime.js";
import {
  beginReviewCycle,
  claimReviewEffect,
  AmbiguousEffectError,
  completeReviewEffect,
  incrementSelfReviewMutation,
  incrementSuccessfulFix,
  loadCompletedReviewEffect,
  reserveFixSlot,
  commitReservedFixSlot,
  assertChargedFixSlot,
  requireClaimedReviewEffect,
  recoverClaimedReviewEffectBeforeQueue,
  requireCompletedAdvanceEffect,
  loadPolicyCommitResult,
  recordPolicyCommitResult,
  reviewDecisionPath,
} from "./review-cycle.js";
import { ensureProducingTaskLineage, readTaskLineage, withTaskLineageTransaction, type TaskLineageRecordV1 } from "../core/task-lineage.js";
import { assertGithubExecutionViable, type GithubExecutionViabilityDependencies } from "./execution-viability.js";
import {
  GithubEffectPlanningError,
  planIssueSyncPreview,
  readVerifiedGithubEffectPreview,
  writeGithubEffectPreview,
  type GithubEffectPreviewV1,
  type IssueSyncPlanningInput,
  type ObservedPullRequestMaterial,
  type PullRequestDeliveryPlanningInput,
} from "../github/effect-plan.js";
import {
  applyDeliveryEffectPreview,
  openIntegratedPullRequestThroughDeliveryGateway,
  prepareDeliveryEffectBoundary,
} from "./github-delivery-effects.js";
import {
  loadWorkItemSummary,
  persistWorkItemSummary,
  workItemSummaryPath,
  type WorkItemCompletionBasis,
} from "./work-item-summaries.js";
import {
  buildVerifierEvidenceIndex,
  loadEvidenceIndex,
  verifierEvidenceIndexPath,
  type VerifierEvidenceIndexPhase,
} from "./evidence-index.js";
import {
  boundedGeneratedLockfileDiff,
  boundedVerifierDiff,
  buildHandsContext,
  buildVerifierContext,
  handsContextPath,
  loadRoleContext,
  verifierContextPath,
} from "./role-context.js";
import { integratedWorkItem } from "./integrated-work-item.js";
import { claimExternalEffect, completeExternalEffect, openResourceBudget } from "./resource-budget.js";
import type { ResourceBudgetPort } from "../core/resource-budget.js";

export interface LocalRuntimeDependencies {
  hands?: (input: HandsWorkItemInput) => Promise<HandsWorkItemResult>;
  handsFixPacket?: (input: HandsFixPacketInput) => Promise<HandsFixPacketResult>;
  verifier?: (input: VerifyWorkItemInput) => Promise<VerifyWorkItemResult>;
  verification?: (input: RunVerificationInput) => Promise<VerificationEvidence>;
  selfReview?: (input: HandsSelfReviewInput) => Promise<HandsSelfReviewResult>;
  actionVerifier?: (input: VerifyReviewerActionInput) => Promise<ActionResolutionResult>;
  packetVerifier?: (input: VerifyReviewFixPacketInput) => Promise<FixPacketResolutionResult>;
  diff?: (worktreePath: string) => Promise<string>;
  collectScopedWorktreeDiff?: typeof collectScopedWorktreeDiff;
  collectCommittedRecoveryEvidence?: typeof collectCommittedRecoveryEvidence;
  collectWorktreeBlobEvidence?: typeof collectWorktreeBlobEvidence;
  commit?: typeof commitWorkItem;
  gitSnapshot?: (worktreePath: string) => Promise<GitSnapshot>;
  changedFiles?: typeof getWorktreeChangedFiles;
  restoreTrackedFiles?: typeof restoreTrackedWorktreeFiles;
  hasWorktreeChanges?: (worktreePath: string) => Promise<boolean>;
  modelCatalog?: () => Promise<ModelCatalogSnapshot>;
  afterCheckpoint?: (checkpoint: RuntimeCheckpoint) => Promise<void>;
  remoteBranchSha?: typeof resolveRemoteBranchSha;
  localHeadSha?: typeof resolveLocalHeadSha;
  prepareCommitIntent?: typeof prepareWorkItemCommitIntent;
  localCommitProvenance?: typeof resolveLocalCommitProvenance;
  remoteBranchAtLocalHead?: typeof requireRemoteBranchAtLocalHead;
  controllerBootstrap?: typeof runControllerBootstrap;
}

export type RuntimeCheckpoint =
  | "after_action_mutation"
  | "after_action_progress"
  | "after_action_reservation_charge"
  | "after_action_invocation_claim"
  | "after_action_worker_report"
  | "after_action_invocation_complete"
  | "after_legacy_quality_recovery_report"
  | "after_self_review_pass_1"
  | "after_post_pass_verification"
  | "after_focused_review_write"
  | "after_packet_supplement_write"
  | "after_queue_full_review"
  | "after_work_item_decision"
  | "after_work_item_cycle_started"
  | "after_work_item_fix_effect_claim"
  | "after_work_item_convergence_report"
  | "after_work_item_effect"
  | "after_ordered_replan_effect_complete"
  | "after_ordered_fix_effect_complete"
  | "after_ordered_fix_effect_progress"
  | "after_ordered_recovery_outcome"
  | "after_work_item_advance_commit"
  | "after_work_item_commit_intent"
  | "after_work_item_commit_result"
  | "after_work_item_completion_commit"
  | "after_work_item_summary_persisted"
  | "after_work_item_summary_pointer"
  | "after_work_item_advance_effect"
  | "after_replan_effect_claim"
  | "after_replan_patch_write"
  | "after_replan_effect_complete"
  | "after_replan_pointer_write"
  | "after_replan_plan_write"
  | "after_replan_request_write"
  | "before_replan_pending_reconciliation"
  | "after_replan_pending_reconciliation"
  | "after_replan_post_error_reconciliation"
  | "after_replan_boundary_commit"
  | "after_replan_awaiting_transition"
  | "before_remote_synchronization"
  | "after_final_integrated_effect_complete"
  | "after_post_pr_effect_complete"
  | "after_post_pr_push"
  | "after_post_pr_head_authority"
  | "after_post_pr_head_consumption"
  | "after_post_pr_commit_intent"
  | "after_post_pr_commit"
  | "after_candidate_recheck_commit"
  | "after_candidate_recheck_hands_report"
  | "after_status_implementing_publication"
  | "after_status_verifying_publication"
  | "after_status_fixing_publication"
  | "after_status_policy_publication"
  | "after_initial_runtime_authority_bind";

const gitObjectIdSchema = z.string().regex(/^[a-f0-9]{40,64}$/);
const actionGitCoordinateShape = {
  effect_id: z.string().regex(/^review-effect:[a-f0-9]{64}$/),
  review_revision: z.number().int().positive(),
  action_id: z.string().min(1),
  action_attempt: z.number().int().positive(),
};
const actionGitClaimSchema = z.object({
  ...actionGitCoordinateShape,
  pre_action_head: gitObjectIdSchema,
  pre_action_tree: gitObjectIdSchema,
}).strict();
const actionGitCompletionSchema = z.object({
  ...actionGitCoordinateShape,
  pre_action_head: gitObjectIdSchema,
  pre_action_tree: gitObjectIdSchema,
  report_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  post_action_blobs: z.array(z.object({ path: z.string().min(1), blob: gitObjectIdSchema }).strict()),
}).strict();

export interface GithubRuntimeDependencies extends LocalRuntimeDependencies {
  github: GitHubAdapter;
  executionViability?: GithubExecutionViabilityDependencies;
  afterIssuePreviewLineagePersisted?: () => Promise<void>;
  afterIssuePreviewInvalidated?: () => Promise<void>;
  afterIssuePreviewLineageInvalidated?: () => Promise<void>;
  afterIssueReplacementArtifactPersisted?: () => Promise<void>;
  afterDeliveryPreviewLineagePersisted?: () => Promise<void>;
  afterDeliveryPreviewArtifactPersisted?: () => Promise<void>;
  afterDeliveryLineageReady?: () => Promise<void>;
  issuePreviewLedgerHooks?: RunLedgerTransactionHooks;
  push?: typeof pushBranch;
  pushBranch?: typeof pushBranch;
  pushCommit?: typeof pushCommitToBranch;
  recordRemoteSynchronization?: typeof recordRemoteSynchronization;
  persistFinalDeliveryAssessmentAtBoundary?: typeof persistFinalDeliveryAssessmentAtBoundary;
}

export interface RunLocalWorkflowInput {
  runDir: string;
  worktreePath: string;
  intake: ResolvedRunIntake;
  plan: BrainPlan;
  codex: CodexAdapter;
  dependencies?: LocalRuntimeDependencies;
  /** Maximum number of Verifier passes, including the first review. */
  maxVerifierPasses?: number;
  progress?: ProgressReporter;
  config?: ConfigV2;
  deferTerminalDisposition?: boolean;
}

export interface LocalWorkflowResult {
  status: "local_ready" | "github_ready" | "human_action_required" | "awaiting_github_effects";
  manifest: RunManifestV2;
  orderedWorkItems: WorkItem[];
  implementationResults: Record<string, ImplementationResult>;
  verification: Record<string, VerificationEvidence>;
  reviews: Record<string, VerifierReview[]>;
  finalVerification?: VerificationEvidence;
  finalReview?: VerifierReview;
  blocker?: string;
  pullRequest?: GitHubPullRequestReference;
  pendingReplanBoundary?: PreparedReplanApprovalCoordinates;
}

export interface RunGithubWorkflowInput extends Omit<RunLocalWorkflowInput, "dependencies"> {
  repoRoot: string;
  branchName: string;
  baseBranch?: string;
  remote?: string;
  dependencies: GithubRuntimeDependencies;
}

function runtimeConfigFromSnapshot(
  base: ConfigV2,
  configuration: ResolvedRunConfiguration,
): ConfigV2 {
  const controllerOwnedTransport = defaultConfig().codex;
  const role = (name: "brain" | "hands" | "verifier") => ({
    model: configuration.roles[name].model,
    reasoning_effort: configuration.roles[name].reasoning_effort,
    sandbox: configuration.roles[name].sandbox,
  });
  return {
    ...base,
    codex: controllerOwnedTransport,
    github: { ...base.github, default_remote: configuration.github.default_remote },
    profiles: { brain: role("brain"), hands: role("hands"), verifier: role("verifier") },
    phase_reasoning: "phase_reasoning" in configuration && configuration.phase_reasoning
      ? configuration.phase_reasoning
      : { ...DEFAULT_PHASE_REASONING },
    retry_policy: {
      max_hands_fix_attempts: configuration.limits.max_hands_fix_attempts,
      max_replan_attempts: configuration.limits.max_replan_attempts,
      ...(configuration.hands_backup === null ? {} : { backup: configuration.hands_backup }),
      ...(configuration.limits.quality_gate === null ? {} : { quality_gate: configuration.limits.quality_gate }),
    },
    review_policy: configuration.limits.review_policy,
  };
}

export interface ApprovedRuntimeSnapshot {
  manifest: RunManifestV2;
  plan: BrainPlan;
  planText: string;
  intake: ResolvedRunIntake;
  config: ConfigV2;
}

class RuntimeAuthorityError extends Error {
  constructor(cause: unknown) {
    super(`Runtime authority verification failed: ${errorMessage(cause)}`, { cause });
    this.name = "RuntimeAuthorityError";
  }
}

const revisionAliasIssueMessages = new Map([
  ["current_plan_revision", "Current revision aliases must be equal"],
  ["approved_plan_revision", "Approved revision aliases must be equal"],
]);

async function readRuntimeEntryManifest(runDir: string): Promise<{
  manifest: RunManifestV2;
  authorityBlocker: string | null;
}> {
  const raw = JSON.parse((await readOwnedRunFile(runDir, "manifest.json")).toString("utf8")) as unknown;
  const parsed = runManifestV2Schema.safeParse(raw);
  if (parsed.success) return { manifest: parsed.data as RunManifestV2, authorityBlocker: null };
  if (parsed.error.issues.length === 0 || parsed.error.issues.some((entry) => {
    if (entry.code !== "custom" || entry.path.length !== 1 || typeof entry.path[0] !== "string") return true;
    return revisionAliasIssueMessages.get(entry.path[0]) !== entry.message;
  })) throw parsed.error;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw parsed.error;
  const candidate = raw as Record<string, unknown>;
  const normalized = runManifestV2Schema.safeParse({
    ...candidate,
    current_plan_revision: candidate.current_revision,
    approved_plan_revision: candidate.approved_revision,
  });
  if (!normalized.success) throw parsed.error;
  const aliases = parsed.error.issues.map((entry) => entry.path[0] === "current_plan_revision" ? "Current" : "Approved");
  return {
    manifest: normalized.data as RunManifestV2,
    authorityBlocker: `Runtime authority verification failed: ${aliases.join(" and ")} plan revision aliases do not match`,
  };
}

function runtimeAuthorityStop(manifest: RunManifestV2, blocker: string): LocalWorkflowResult {
  return {
    status: "human_action_required",
    manifest,
    orderedWorkItems: [],
    implementationResults: {},
    verification: {},
    reviews: {},
    blocker,
  };
}

/** Load the complete approved execution subject before any checkout or delivery mutation. */
export async function loadApprovedRuntimeSnapshot(
  runDir: string,
  baseConfig: ConfigV2 = defaultConfig(),
): Promise<ApprovedRuntimeSnapshot | null> {
  const manifest = await readManifestV2(runDir);
  if (!await requiresPinnedRuntimeAuthority(runDir, manifest)) return null;
  const approvedRevision = assertApprovedCurrentPlanRevision(manifest);
  if (approvedRevision === null) throw new Error("Pinned runtime execution requires an approved plan revision");
  let approvedManifest = manifest;
  const pending = manifest.pending_plan_approval;
  if (pending !== null && typeof pending.base_revision === "number") {
    if (pending.base_revision !== approvedRevision) {
      throw new Error("Pending material replan base does not match the approved runtime revision");
    }
    const proposed = await verifyPersistedPlanApprovalSubject(runDir, manifest, pending.proposed_revision);
    if (proposed === null || proposed.snapshot.plan === null) {
      throw new Error("Pending material replan requires complete immutable approval evidence");
    }
    approvedManifest = {
      ...manifest,
      current_revision: approvedRevision,
      current_plan_revision: approvedRevision,
      approved_revision: approvedRevision,
      approved_plan_revision: approvedRevision,
      pending_plan_approval: null,
    };
  }
  const historicalSubject = await verifyHistoricalApprovedRuntimeSubject(runDir, approvedManifest, approvedRevision);
  const verified = historicalSubject === null
    ? await verifyPersistedPlanApprovalSubject(runDir, approvedManifest, approvedRevision)
    : null;
  const runtimeSubject = historicalSubject ?? verified;
  if (runtimeSubject === null || runtimeSubject.snapshot.plan === null) {
    throw new Error("Pinned runtime execution requires complete immutable plan approval evidence");
  }
  const plan = runtimeSubject.snapshot.plan;
  const configuration = runtimeSubject.runConfiguration;
  const planText = serializePersistedPlan(plan, manifest.workflow_protocol);
  const roles = {
    brain: { model: configuration.roles.brain.model, reasoning_effort: configuration.roles.brain.reasoning_effort, sandbox: configuration.roles.brain.sandbox },
    hands: { model: configuration.roles.hands.model, reasoning_effort: configuration.roles.hands.reasoning_effort, sandbox: configuration.roles.hands.sandbox },
    verifier: { model: configuration.roles.verifier.model, reasoning_effort: configuration.roles.verifier.reasoning_effort, sandbox: configuration.roles.verifier.sandbox },
  };
  const intake: ResolvedRunIntake = {
    task: manifest.original_request,
    repo_root: manifest.repo_root,
    mode: configuration.mode,
    research: configuration.research,
    reflection: configuration.reflection,
    brain_model: roles.brain.model,
    hands_model: roles.hands.model,
    verifier_model: roles.verifier.model,
    models: { brain: roles.brain.model, hands: roles.hands.model, verifier: roles.verifier.model },
    resolved_models: { brain: roles.brain.model, hands: roles.hands.model, verifier: roles.verifier.model },
    roles,
    phase_reasoning: "phase_reasoning" in configuration && configuration.phase_reasoning
      ? configuration.phase_reasoning
      : { ...DEFAULT_PHASE_REASONING },
    review_policy: configuration.limits.review_policy,
    ...(configuration.hands_backup === null ? {} : { hands_backup: configuration.hands_backup }),
    ...(configuration.limits.quality_gate === null ? {} : { quality_gate: configuration.limits.quality_gate }),
    ...(manifest.warning_continuation_authority === undefined
      ? {}
      : { warning_continuation_authority: manifest.warning_continuation_authority }),
  };
  return {
    manifest,
    plan,
    planText,
    intake,
    config: runtimeConfigFromSnapshot(baseConfig, configuration),
  };
}

/** Replace all caller-supplied execution authority with the exact approved run snapshots. */
export async function bindApprovedRuntimeAuthority<T extends RunLocalWorkflowInput | RunGithubWorkflowInput>(
  input: T,
): Promise<T> {
  const manifest = await readManifestV2(input.runDir);
  const requiresExactSnapshots = await requiresPinnedRuntimeAuthority(input.runDir, manifest);
  const deterministicWorktreePath = runWorktreePath(manifest.repo_root, manifest.run_id);
  const deterministicBranchName = runWorktreeBranchName(manifest.run_id);
  if (manifest.approved_revision !== null && manifest.worktree_path !== null && !("repoRoot" in input)) {
    const expectedCallerWorktree = manifest.worktree_path;
    let callerMatchesManifest = false;
    try {
      callerMatchesManifest = await realpath(input.worktreePath) === await realpath(expectedCallerWorktree);
    } catch {
      // Missing or otherwise unreadable caller paths are authority mismatches,
      // not raw filesystem errors that leak past the workflow boundary.
    }
    if (!callerMatchesManifest) {
      throw new Error("Caller worktree differs from the canonical manifest checkout");
    }
  }
  if (manifest.approved_revision !== null && "repoRoot" in input
    && manifest.branch_name !== null && input.branchName !== manifest.branch_name) {
    throw new Error("Caller branch differs from the canonical manifest branch");
  }
  if (manifest.approved_revision !== null && requiresExactSnapshots) {
    if (manifest.source_commit === null) {
      throw new Error("Approved execution requires an immutable source commit");
    }
    if (manifest.worktree_path === null || resolve(manifest.worktree_path) !== deterministicWorktreePath) {
      throw new Error("Manifest checkout differs from the deterministic approved run worktree");
    }
    if (manifest.branch_name !== deterministicBranchName) {
      throw new Error("Manifest branch differs from the deterministic approved run branch");
    }
    if ("repoRoot" in input && resolve(input.repoRoot) !== resolve(manifest.repo_root)) {
      throw new Error("Caller repository differs from the immutable run repository");
    }
    if ("repoRoot" in input && input.branchName !== deterministicBranchName) {
      throw new Error("Caller branch differs from the canonical manifest branch");
    }
  }
  if (!requiresExactSnapshots) {
    return input;
  }
  const currentRevision = manifest.current_revision;
  const currentPlanRevision = manifest.current_plan_revision;
  const approvedRevision = manifest.approved_revision;
  const approvedPlanRevision = manifest.approved_plan_revision;
  if (currentRevision !== currentPlanRevision) {
    throw new Error("Current plan revision aliases do not match");
  }
  if (approvedRevision !== approvedPlanRevision) {
    throw new Error("Approved plan revision aliases do not match");
  }
  if (approvedRevision === null) {
    if (manifest.pending_plan_approval?.base_revision === null && currentRevision !== null) return input;
    throw new Error("Pinned runtime execution requires explicit approval for the current plan revision");
  }
  const snapshot = await loadApprovedRuntimeSnapshot(input.runDir, input.config ?? defaultConfig());
  if (snapshot === null) throw new Error("Pinned runtime execution requires an immutable runtime snapshot");
  if (serializePersistedPlan(input.plan, manifest.workflow_protocol) !== snapshot.planText) {
    throw new Error("Caller plan differs from the exact approved recorded plan bytes");
  }
  if (manifest.worktree_path === null || resolve(manifest.worktree_path) !== deterministicWorktreePath) {
    throw new Error("Manifest checkout differs from the deterministic approved run worktree");
  }
  const expectedWorktreePath = deterministicWorktreePath;
  let callerMatchesExpectedWorktree = false;
  try {
    callerMatchesExpectedWorktree = await realpath(input.worktreePath) === await realpath(expectedWorktreePath);
  } catch {
    // Normalize unreadable caller paths to the authority boundary below.
  }
  if (!callerMatchesExpectedWorktree) {
    throw new Error("Caller worktree differs from the canonical manifest checkout");
  }
  if ("repoRoot" in input && resolve(input.repoRoot) !== resolve(manifest.repo_root)) {
    throw new Error("Caller repository differs from the immutable run repository");
  }
  if (("repoRoot" in input && snapshot.intake.mode !== "github")
    || (!("repoRoot" in input) && snapshot.intake.mode !== "local")) {
    throw new Error("Exported runtime does not match the immutable execution mode");
  }
  let githubAuthority: Pick<RunGithubWorkflowInput, "branchName" | "remote"> | Record<string, never> = {};
  if ("repoRoot" in input) {
    const branchName = deterministicBranchName;
    if (manifest.branch_name === null || manifest.branch_name !== branchName) {
      throw new Error("Manifest branch differs from the deterministic approved run branch");
    }
    if (input.branchName !== branchName) {
      throw new Error("Caller branch differs from the canonical manifest branch");
    }
    const remote = snapshot.config.github.default_remote;
    if (input.remote !== undefined && input.remote !== remote) {
      throw new Error("Caller remote differs from the approved run configuration remote");
    }
    githubAuthority = { branchName, remote };
  }
  return {
    ...input,
    ...githubAuthority,
    worktreePath: expectedWorktreePath,
    intake: snapshot.intake,
    plan: snapshot.plan,
    codex: input.codex instanceof SubprocessCodexAdapter
      ? new SubprocessCodexAdapter(snapshot.config, expectedWorktreePath)
      : input.codex,
    config: snapshot.config,
  };
}

async function prepareApprovedControllerBootstrap(input: RunLocalWorkflowInput, currentRepoRoot?: string): Promise<void> {
  const spec = input.plan.controller_bootstrap;
  if (spec === undefined || spec === null) return;
  const manifest = await readManifestV2(input.runDir);
  assertApprovedCurrentPlanRevision(manifest);
  if (manifest.source_commit === null) throw new Error("Controller bootstrap requires a run-pinned source commit");
  await (input.dependencies?.controllerBootstrap ?? runControllerBootstrap)({
    runDir: input.runDir,
    repoRoot: currentRepoRoot ?? manifest.repo_root,
    worktreePath: input.worktreePath,
    sourceCommit: manifest.source_commit,
    spec,
  });
}

async function prepareApprovedGithubControllerBootstrap(input: RunGithubWorkflowInput): Promise<void> {
  const manifest = await readManifestV2(input.runDir);
  const revision = assertApprovedCurrentPlanRevision(manifest);
  let bytes: string;
  try {
    bytes = await readVerifiedPlanRevision(input.runDir, manifest, revision);
  } catch {
    throw new Error("Approved controller bootstrap plan binding is invalid");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes);
  } catch {
    throw new Error("Approved controller bootstrap plan bytes are not valid JSON");
  }
  const member = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as { controller_bootstrap?: unknown }).controller_bootstrap
    : undefined;
  let spec: ControllerBootstrapSpec | null | undefined;
  try {
    spec = controllerBootstrapSpecSchema.nullable().optional().parse(member);
  } catch {
    throw new Error("Approved controller bootstrap specification is invalid");
  }
  if (spec === undefined || spec === null) return;
  if (manifest.source_commit === null) throw new Error("Controller bootstrap requires a run-pinned source commit");
  await (input.dependencies.controllerBootstrap ?? runControllerBootstrap)({
    runDir: input.runDir,
    repoRoot: input.repoRoot,
    worktreePath: input.worktreePath,
    sourceCommit: manifest.source_commit,
    spec,
  });
}

async function captureRuntimeDirectory(
  path: string,
  label: string,
  allowSymlink = false,
  relocatedSymlinkTarget?: string,
): Promise<{ path: string; realPath: string }> {
  const resolved = resolve(path);
  const status = await lstat(resolved);
  if (status.isSymbolicLink() && !allowSymlink) throw new Error(`${label} must not be a symlink`);
  if (!status.isDirectory() && !status.isSymbolicLink()) throw new Error(`${label} must be a directory`);
  let realPath: string;
  try {
    realPath = await realpath(resolved);
  } catch (error) {
    if (!allowSymlink || !status.isSymbolicLink() || !relocatedSymlinkTarget
      || (error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    realPath = await realpath(relocatedSymlinkTarget);
  }
  if (allowSymlink && !(await lstat(realPath)).isDirectory()) throw new Error(`${label} must resolve to a directory`);
  return { path: resolved, realPath };
}

async function bindGithubRuntimePaths(input: Pick<RunGithubWorkflowInput, "repoRoot" | "runDir" | "worktreePath">): Promise<{
  repoRoot: string;
  runDir: string;
  worktreePath: string;
}> {
  const repository = await captureRuntimeDirectory(input.repoRoot, "GitHub repository root");
  const control = await captureRuntimeDirectory(join(repository.path, ".brain-hands"), "Brain Hands control directory");
  const runs = await captureRuntimeDirectory(join(control.path, "runs"), "Brain Hands runs directory");
  const run = await captureRuntimeDirectory(input.runDir, "Run directory");
  const expectedRunPath = join(runs.path, basename(run.path));
  if (run.path !== expectedRunPath
    || dirname(run.realPath) !== runs.realPath
    || dirname(runs.realPath) !== control.realPath
    || dirname(control.realPath) !== repository.realPath) {
    throw new Error("Run directory is not bound to the current GitHub repository root");
  }
  const translatedRunWorktree = join(control.path, "worktrees", basename(run.path));
  let worktree: Awaited<ReturnType<typeof captureRuntimeDirectory>>;
  try {
    worktree = await captureRuntimeDirectory(input.worktreePath, "GitHub worktree", true, translatedRunWorktree);
  } catch (error) {
    throw new Error("GitHub worktree does not match the canonical manifest checkout", { cause: error });
  }
  const worktreeRelative = relative(repository.realPath, worktree.realPath);
  if (worktreeRelative === ".." || worktreeRelative.startsWith(`..${sep}`) || isAbsolute(worktreeRelative)) {
    throw new Error("GitHub worktree is not bound to the current repository root");
  }
  return { repoRoot: repository.path, runDir: run.path, worktreePath: worktree.path };
}

async function assertPersistedGithubExecutionIdentity(
  input: Pick<RunGithubWorkflowInput, "repoRoot" | "worktreePath" | "branchName">,
  manifest: RunManifestV2,
): Promise<void> {
  if (!manifest.worktree_path || !manifest.branch_name) {
    throw new Error("GitHub-producing execution requires persisted worktree and branch identity");
  }
  if (input.branchName !== manifest.branch_name) {
    throw new Error("Supplied GitHub branch does not match the persisted run branch identity");
  }
  if (!isAbsolute(manifest.repo_root) || !isAbsolute(manifest.worktree_path)) {
    throw new Error("Persisted GitHub repository and worktree identity must be absolute");
  }
  const historicalRoot = resolve(manifest.repo_root);
  const historicalWorktree = resolve(manifest.worktree_path);
  const historicalRelative = relative(historicalRoot, historicalWorktree);
  if (historicalRelative === ""
    || historicalRelative === ".."
    || historicalRelative.startsWith(`..${sep}`)
    || isAbsolute(historicalRelative)) {
    throw new Error("Persisted GitHub worktree is not structurally beneath its historical repository root");
  }
  const expected = await captureRuntimeDirectory(
    resolve(input.repoRoot, historicalRelative),
    "Translated persisted GitHub worktree",
  );
  const supplied = await captureRuntimeDirectory(input.worktreePath, "Supplied GitHub worktree", true, expected.path);
  if (supplied.realPath !== expected.realPath) {
    throw new Error("Supplied GitHub worktree does not match the persisted run worktree identity");
  }
}

async function verifyApprovedCheckout(input: RunLocalWorkflowInput): Promise<void> {
  const manifest = await readManifestV2(input.runDir);
  if (!await requiresPinnedRuntimeAuthority(input.runDir, manifest)) return;
  const authority = currentExecutionAuthority();
  if (authority) {
    await authority.assert();
    return;
  }
  if (manifest.source_commit === null || manifest.worktree_path === null || manifest.branch_name === null) {
    throw new Error("Approved execution requires a pinned checkout identity and source commit");
  }
  await verifyRunWorktreeIdentity({
    repoRoot: manifest.repo_root,
    runId: manifest.run_id,
    worktreePath: manifest.worktree_path,
    branchName: manifest.branch_name,
    sourceCommit: manifest.source_commit,
  });
}

/** Fail closed when Hands reports or leaves changes outside the approved file contract. */
export function assertImplementationScope(
  workItem: WorkItem,
  implementation: ImplementationResult,
  worktreeChangedFiles: readonly string[],
): void {
  const allowed = new Set(workItem.completion_contract.expected_changed_files);
  const reportedOutOfScope = [...new Set(implementation.changed_files)]
    .filter((path) => !allowed.has(path));
  const worktreeOutOfScope = [...new Set(worktreeChangedFiles)]
    .filter((path) => !allowed.has(path));
  const failures = [
    reportedOutOfScope.length > 0
      ? `Hands reported out-of-scope files: ${reportedOutOfScope.join(", ")}`
      : null,
    worktreeOutOfScope.length > 0
      ? `Worktree contains out-of-scope files: ${worktreeOutOfScope.join(", ")}`
      : null,
  ].filter((entry): entry is string => entry !== null);

  if (failures.length > 0) {
    throw new Error(failures.join("; "));
  }
}

interface MutationQualityGateInput {
  workItem: WorkItem;
  parentAttempt: number;
  mutationKind: "initial" | "normal_fix" | "reviewer_action" | "quality_recovery";
  activeAction: ReviewerAction | null;
  completedActions: ReviewerAction[];
  implementation: ImplementationResult;
  phase: "work_item" | "pre_pr" | "post_pr";
}

interface MutationQualityGateResult {
  implementation: ImplementationResult;
  finalVerification: VerificationEvidence;
  selfReviews: HandsSelfReviewReport[];
}

class HandsSelfReviewQualityGateError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "HandsSelfReviewQualityGateError";
  }
}

class NonRetryableHandsResultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonRetryableHandsResultError";
  }
}

function workItemPolicyCriteria(
  criteriaByItem: Record<string, AcceptanceCriterion[]>,
  workItemId: string,
): AcceptanceCriterion[] | null {
  const criteria = criteriaByItem[workItemId];
  return criteria && criteria.length > 0 ? criteria : null;
}

function workItemPolicyProvenanceIssue(
  manifest: RunManifestV2,
  criteriaByItem: Record<string, AcceptanceCriterion[]>,
  workItemId: string,
): string | null {
  if (!manifest.review_accounting) return "review accounting is missing";
  if (!workItemPolicyCriteria(criteriaByItem, workItemId)) {
    return `approved acceptance-criterion provenance is missing for ${workItemId}`;
  }
  const guards = manifest.release_guards;
  if (!guards || guards.length === 0) return "release-guard provenance is missing";
  if (new Set(guards.map((guard) => guard.id)).size !== guards.length) {
    return "release-guard provenance contains duplicate identifiers";
  }
  return null;
}

function integratedPolicyCriteria(
  criteriaByItem: Record<string, AcceptanceCriterion[]>,
): AcceptanceCriterion[] | null {
  const criteria = Object.values(criteriaByItem).flat();
  return criteria.length > 0 ? criteria : null;
}

function hashReviewPolicy(policy: RunManifestV2["review_policy_snapshot"]): string {
  return createHash("sha256").update(JSON.stringify(policy)).digest("hex");
}

function engineFindingToVerifierFinding(
  finding: EngineFinding,
  criteria: AcceptanceCriterion[],
  verificationCommands: WorkItem["verification_commands"],
): VerifierFinding {
  return {
    severity: finding.severity,
    file: finding.normalized_location,
    line: null,
    acceptance_criterion: criteria.find((criterion) => criterion.ref === finding.criterion_ref)?.text
      ?? finding.criterion_ref,
    problem_class: finding.problem_class as VerifierFinding["problem_class"],
    problem: finding.problem,
    required_fix: finding.required_fix ?? "Resolve the deterministic review finding.",
    evidence_refs: [...finding.evidence_refs],
    re_verification: verificationCommands.map((command) => [...command.argv]),
  };
}

export { topologicallySortWorkItems };

export async function hasWorktreeChanges(worktreePath: string): Promise<boolean> {
  return (await getGitSnapshot(worktreePath)).status.trim().length > 0;
}

async function assertRecoveryWorktreeClean(worktreePath: string, workItemId: string): Promise<void> {
  if ((await getGitSnapshot(worktreePath)).status.trim().length > 0) {
    throw new Error(`Persisted direct work-item completion marker has dirty worktree changes: ${workItemId}`);
  }
}

function aggregateImplementation(
  results: Record<string, ImplementationResult>,
  plan: BrainPlan,
): ImplementationResult {
  const values = Object.values(results);
  return {
    work_item_id: "integrated",
    changed_files: [...new Set(values.flatMap((result) => result.changed_files))],
    tests_added_or_changed: [...new Set(values.flatMap((result) => result.tests_added_or_changed))],
    commands_attempted: values.flatMap((result) => result.commands_attempted),
    completed_steps: values.flatMap((result) => result.completed_steps),
    remaining_risks: [
      ...new Set([...plan.risks, ...values.flatMap((result) => result.remaining_risks)]),
    ],
  };
}

async function setProgress(
  runDir: string,
  itemId: string,
  progress: RunManifestV2["work_item_progress"][string],
  artifactPaths: string[] = [],
): Promise<RunManifestV2> {
  const manifest = await readManifestV2(runDir);
  const previous = manifest.work_item_progress[itemId] ?? {};
  const statusChanged = previous.status !== progress.status;
  const statusTimestamp = statusChanged && (progress.status === "complete" || progress.status === "blocked")
    ? new Date().toISOString()
    : undefined;
  const nextProgress = Object.fromEntries(
    Object.entries({
      ...previous,
      ...progress,
      ...(statusTimestamp ? { github_status_transition_at: statusTimestamp } : {}),
    }).filter(([, value]) => value !== undefined),
  ) as RunManifestV2["work_item_progress"][string];
  if (nextProgress.candidate_recheck?.phase === "final_integrated") {
    delete nextProgress.delivery_phase;
    delete nextProgress.integrated_pr;
    delete nextProgress.push_pending;
    delete nextProgress.push_commit_pending;
    delete nextProgress.push_expected_sha;
    delete nextProgress.push_remote_before_sha;
    delete nextProgress.push_local_before_sha;
    delete nextProgress.push_commit_parent_sha;
    delete nextProgress.push_commit_tree_sha;
    delete nextProgress.push_commit_message;
    delete nextProgress.push_commit_review_cycle_path;
    delete nextProgress.push_commit_review_effect_id;
  } else if (nextProgress.candidate_recheck?.phase === "post_pr") {
    nextProgress.delivery_phase = "post_pr";
  }
  return updateManifestV2(runDir, {
    current_work_item_id: progress.status === "complete" ? null : itemId,
    work_item_progress: {
      ...manifest.work_item_progress,
      [itemId]: nextProgress,
    },
    final_artifact_paths: [...new Set([...manifest.final_artifact_paths, ...artifactPaths])],
  });
}

async function advancePostPrDeliveryHeadAuthority(input: {
  github: RunGithubWorkflowInput;
  itemId: string;
  previousHead: string;
  authorizedHead: string;
  progress: RunManifestV2["work_item_progress"][string];
  artifactPaths: string[];
}): Promise<RunManifestV2> {
  const manifest = await readManifestV2(input.github.runDir);
  if (manifest.task_lineage_id === null) throw new Error("Post-PR head authorization requires a task lineage");
  return withTaskLineageTransaction({
    repoRoot: input.github.repoRoot,
    lineageId: manifest.task_lineage_id,
    operation: async (lineageTransaction) => {
      let lineage = lineageTransaction.read();
      const transition = {
        run_id: manifest.run_id,
        work_item_id: input.itemId,
        previous_head_sha: input.previousHead,
        authorized_head_sha: input.authorizedHead,
      };
      if (lineage.active_run_id !== manifest.run_id || lineage.delivery.state !== "ready"
        || lineage.delivery.branch_name !== input.github.branchName
        || (lineage.delivery.head_sha !== input.previousHead && lineage.delivery.head_sha !== input.authorizedHead)
        || (lineage.delivery.head_sha === input.authorizedHead
          && !isDeepStrictEqual(lineage.delivery.head_transition, transition))) {
        throw new Error("Post-PR head authorization does not extend the exact ready lineage delivery");
      }
      if (!isDeepStrictEqual(lineage.delivery.head_transition, transition)) {
        lineage = await lineageTransaction.update({
          ...lineage,
          delivery: { ...lineage.delivery, head_transition: transition },
        });
      }
      if (lineage.delivery.head_sha === input.previousHead) {
        lineage = await lineageTransaction.update({
          ...lineage,
          delivery: { ...lineage.delivery, head_sha: input.authorizedHead },
        });
      }
      return withRunLedgerTransaction(input.github.runDir, async (runTransaction) => {
        const current = await runTransaction.readManifestV2();
        if (current.run_id !== manifest.run_id || current.task_lineage_id !== lineage.lineage_id) {
          throw new Error("Post-PR head authorization lost its run and lineage binding");
        }
        const previous = current.work_item_progress[input.itemId] ?? {};
        const statusChanged = previous.status !== input.progress.status;
        const statusTimestamp = statusChanged && (input.progress.status === "complete" || input.progress.status === "blocked")
          ? new Date().toISOString()
          : undefined;
        return runTransaction.updateManifestV2({
          current_work_item_id: input.progress.status === "complete" ? null : input.itemId,
          work_item_progress: {
            ...current.work_item_progress,
            [input.itemId]: { ...previous, ...input.progress, ...(statusTimestamp ? { github_status_transition_at: statusTimestamp } : {}) },
          },
          final_artifact_paths: [...new Set([...current.final_artifact_paths, ...input.artifactPaths])],
        });
      });
    },
  });
}

async function consumePostPrDeliveryHeadAuthority(input: {
  github: RunGithubWorkflowInput;
  itemId: string;
  previousHead: string;
  remoteBefore: string;
  authorizedHead: string;
}): Promise<RunManifestV2> {
  const manifest = await readManifestV2(input.github.runDir);
  if (manifest.task_lineage_id === null) throw new Error("Post-PR head consumption requires a task lineage");
  const expectedTransition = {
    run_id: manifest.run_id,
    work_item_id: input.itemId,
    previous_head_sha: input.previousHead,
    authorized_head_sha: input.authorizedHead,
  };
  return withTaskLineageTransaction({
    repoRoot: input.github.repoRoot,
    lineageId: manifest.task_lineage_id,
    operation: async (lineageTransaction) => {
      let lineage = lineageTransaction.read();
      if (lineage.active_run_id !== manifest.run_id || lineage.delivery.state !== "ready"
        || lineage.delivery.branch_name !== input.github.branchName
        || lineage.delivery.head_sha !== input.authorizedHead
        || (lineage.delivery.head_transition !== undefined
          && !isDeepStrictEqual(lineage.delivery.head_transition, expectedTransition))) {
        throw new Error("Post-PR head consumption does not match the exact durable transition");
      }
      if (lineage.delivery.head_transition !== undefined) {
        const { head_transition: _consumed, ...delivery } = lineage.delivery;
        lineage = await lineageTransaction.update({ ...lineage, delivery });
      }
      return withRunLedgerTransaction(input.github.runDir, async (runTransaction) => {
        const current = await runTransaction.readManifestV2();
        const progress = current.work_item_progress[input.itemId];
        if (current.run_id !== manifest.run_id || current.task_lineage_id !== lineage.lineage_id
          || progress?.push_pending !== true
          || progress.push_expected_sha !== input.authorizedHead
          || progress.push_remote_before_sha !== input.remoteBefore
          || progress.push_local_before_sha !== input.previousHead
          || progress.push_commit_parent_sha !== input.previousHead) {
          throw new Error("Post-PR head consumption lost its exact run provenance");
        }
        return runTransaction.updateManifestV2({
          work_item_progress: {
            ...current.work_item_progress,
            [input.itemId]: {
              ...progress,
              push_pending: false,
              push_commit_pending: false,
              push_expected_sha: undefined,
              push_remote_before_sha: undefined,
              push_local_before_sha: undefined,
              push_commit_parent_sha: undefined,
              push_commit_tree_sha: undefined,
              push_commit_message: undefined,
              push_commit_review_cycle_path: undefined,
              push_commit_review_effect_id: undefined,
            },
          },
        });
      });
    },
  });
}

function reviewNeedsReplan(review: VerifierReview): boolean {
  return review.decision === "replan_required";
}

function verificationFailureReasons(
  evidence: VerificationEvidence,
  requiredBrowserChecks: WorkItem["browser_checks"] = [],
): string[] {
  const commandFailures = evidence.commands.flatMap((command) => {
    const reasons: string[] = [];
    if (command.exit_code !== 0) reasons.push(`${command.command} exited with ${command.exit_code ?? "null"}`);
    if (command.timed_out) reasons.push(`${command.command} timed out`);
    return reasons;
  });
  const artifactFailures = evidence.artifact_checks
    .filter((artifact) => artifact.required && !artifact.exists)
    .map((artifact) => `required artifact is missing: ${artifact.path}`);
  const browserFailures = evidence.browser_evidence.flatMap((browser) =>
    browser.status === "passed" ? [] : [`browser check ${browser.name} is ${browser.status}`],
  );
  const missingBrowserEvidence = (requiredBrowserChecks ?? [])
    .filter((check) => !evidence.browser_evidence.some((browser) =>
      browser.name === check.name || browser.screenshot_artifact === check.screenshot_artifact,
    ))
    .map((check) => `browser evidence is missing for ${check.name}`);
  return [...commandFailures, ...artifactFailures, ...browserFailures, ...missingBrowserEvidence];
}

function verificationIdentityForWorkItem(
  item: WorkItem,
  githubDelivery: RunGithubWorkflowInput | undefined,
  manifest: RunManifestV2,
): VerificationIdentity {
  if (!githubDelivery) {
    return { scope: "local", work_item_id: item.id };
  }
  const issueNumber = manifest.work_item_issue_map[item.id] ?? manifest.github_ids.work_item_issue_map?.[item.id];
  if (!Number.isInteger(issueNumber) || issueNumber < 1) {
    throw new Error(`No durable GitHub issue mapping exists for work item ${item.id}`);
  }
  return { scope: "github", work_item_id: item.id, issue_number: issueNumber };
}

function integratedVerificationIdentity(): VerificationIdentity {
  return { scope: "integrated", work_item_id: "integrated" };
}

function mappedIssueNumbers(manifest: RunManifestV2, orderedWorkItems: WorkItem[]): number[] {
  return orderedWorkItems.map((item) => {
  const issueNumber = manifest.work_item_issue_map[item.id] ?? manifest.github_ids.work_item_issue_map?.[item.id];
    if (!Number.isInteger(issueNumber) || issueNumber < 1) {
      throw new Error(`No durable GitHub issue mapping exists for work item ${item.id}`);
    }
    return issueNumber;
  });
}

function validateEvidenceForIdentity(
  evidence: VerificationEvidence,
  identity: VerificationIdentity,
  attempt: number,
  artifactNamespace?: string,
): VerificationEvidence {
  const expectedPath = verificationEvidencePath(identity, attempt);
  if (evidence.verification_scope !== identity.scope || evidence.work_item_id !== identity.work_item_id || evidence.attempt !== attempt || evidence.evidence_path !== expectedPath) {
    throw new Error(`Verification evidence provenance does not match ${identity.scope}/${identity.work_item_id} attempt ${attempt}`);
  }
  if (identity.scope === "github" && evidence.issue_number !== identity.issue_number) {
    throw new Error(`Verification evidence issue number does not match mapped work item ${identity.work_item_id}`);
  }
  if (identity.scope !== "github" && evidence.issue_number !== undefined) {
    throw new Error("Local and integrated verification evidence cannot contain a GitHub issue number");
  }
  const prefix = `${verificationIdentityDirectory(identity)}/attempt-${attempt}/`;
  for (const command of evidence.commands) {
    if (!command.stdout_path.startsWith(prefix) || !command.stderr_path.startsWith(prefix) || (command.result_path && !command.result_path.startsWith(prefix))) {
      throw new Error("Verification command artifacts do not match the evidence identity");
    }
  }
  if (!browserEvidenceArtifactsMatchIdentity(evidence, prefix)) {
    throw new Error("Browser verification artifacts do not match the evidence identity");
  }
  return evidence;
}

function verificationProgressIdentity(identity: VerificationIdentity): Record<string, unknown> {
  return {
    verification_scope: identity.scope,
    verification_work_item_id: identity.work_item_id,
    ...(identity.scope === "github" ? { verification_issue_number: identity.issue_number } : {}),
  };
}

function identityFromVerificationEvidence(evidence: VerificationEvidence): VerificationIdentity {
  if (evidence.verification_scope === "github") {
    if (evidence.issue_number === undefined) {
      throw new Error("GitHub verification evidence is missing its issue identity");
    }
    return { scope: "github", work_item_id: evidence.work_item_id, issue_number: evidence.issue_number };
  }
  if (evidence.verification_scope === "integrated") {
    if (evidence.work_item_id !== "integrated") {
      throw new Error("Integrated verification evidence has an invalid work-item identity");
    }
    return { scope: "integrated", work_item_id: "integrated" };
  }
  return { scope: "local", work_item_id: evidence.work_item_id };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isGitObjectId(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{40,64}$/i.test(value);
}

function canonicalRunArtifactPath(runDir: string, artifactPath: string, allowAbsolute: boolean): string {
  if (artifactPath.length === 0) {
    throw new Error("Hands report path must not be empty");
  }
  if (artifactPath.includes("\\")) {
    throw new Error(`Hands report path must use canonical separators: ${artifactPath}`);
  }
  const segments = artifactPath.split("/");
  const firstSegment = allowAbsolute && isAbsolute(artifactPath) ? 1 : 0;
  if (segments.slice(firstSegment).some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new Error(`Hands report path is not canonical: ${artifactPath}`);
  }

  const root = resolve(runDir);
  const candidate = resolve(root, artifactPath);
  if (candidate === root) {
    throw new Error(`Hands report path must name an artifact below the run directory: ${artifactPath}`);
  }
  if (!candidate.startsWith(`${root}/`)) {
    throw new Error(`Hands report path escapes the run directory: ${artifactPath}`);
  }
  if (!allowAbsolute || !isAbsolute(artifactPath)) return artifactPath;

  const relativePath = relative(root, candidate);
  if (relativePath.length === 0 || relativePath.includes("\\")) {
    throw new Error(`Hands report path could not be canonicalized: ${artifactPath}`);
  }
  return relativePath;
}

function runArtifactRelativePath(runDir: string, reportPath: string): string {
  if (reportPath.length === 0) {
    throw new Error("Hands report path must not be empty");
  }
  if (isAbsolute(reportPath)) {
    throw new Error(`Hands report path must be run-relative: ${reportPath}`);
  }
  return canonicalRunArtifactPath(runDir, reportPath, false);
}

function controllerArtifactRelativePath(runDir: string, artifactPath: string): string {
  return canonicalRunArtifactPath(runDir, artifactPath, true);
}

function replanArtifactPathForValidation(runDir: string, artifactPath: string): string {
  const rootPrefix = `${resolve(runDir)}/`;
  return artifactPath.startsWith(rootPrefix) ? artifactPath.slice(rootPrefix.length) : artifactPath;
}

async function readRunArtifact<T>(runDir: string, artifactPath: string): Promise<T> {
  const root = resolve(runDir);
  const candidate = resolve(root, artifactPath);
  if (candidate !== root && !candidate.startsWith(`${root}/`)) {
    throw new Error(`Persisted run artifact escapes the run directory: ${artifactPath}`);
  }
  return JSON.parse(await readFile(candidate, "utf8")) as T;
}

export async function isExactBlockedSelfReviewClaim(
  runDir: string,
  claimPath: string,
  reportPath: string,
): Promise<boolean> {
  try {
    const claim = await readRunArtifact<Record<string, unknown>>(runDir, claimPath);
    if (claim.state !== "blocked" || claim.report_path !== reportPath) {
      throw new HandsSelfReviewQualityGateError(`Persisted Hands self-review claim is invalid: ${claimPath}`);
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function isResumableSelfReviewQualityState(
  progress: RunManifestV2["work_item_progress"][string] | undefined,
  parentAttempt: number,
  exactBlockedClaim: boolean,
): boolean {
  return progress !== undefined
    && (progress.attempts === parentAttempt || exactBlockedClaim)
    && progress.self_review_state !== undefined
    && typeof progress.verification_path === "string";
}

export function shouldResumeBlockedSelfReviewClaim(
  fallbackClaimTransfer: boolean,
  exactBlockedClaim: boolean,
): boolean {
  return fallbackClaimTransfer || exactBlockedClaim;
}

export function isResumableReviewerActionQualityGate(
  progress: RunManifestV2["work_item_progress"][string] | undefined,
  mutationAttempt: number,
  actionId: string,
  actionAttempt: number,
  exactBlockedClaim: boolean,
): boolean {
  return progress !== undefined
    && (progress.mutation_kind === "reviewer_action" || progress.mutation_kind === "quality_recovery")
    && (progress.attempts === mutationAttempt || exactBlockedClaim)
    && progress.active_action_id === actionId
    && progress.active_action_attempt === actionAttempt
    && typeof progress.implementation_path === "string"
    && progress.implementation_path.endsWith(`/attempt-${mutationAttempt}.json`);
}

async function artifactReference(runDir: string, artifactPath: string): Promise<ArtifactRefV1> {
  const path = controllerArtifactRelativePath(runDir, artifactPath);
  return artifactRefFromBytes(path, await readFile(resolve(runDir, path)));
}

async function loadExistingFocusedReviewIfPresent(
  runDir: string,
  artifactPath: string,
): Promise<ActionResolutionResult["review"] | null> {
  try {
    return actionResolutionReviewSchema.parse(
      await readRunArtifact<unknown>(runDir, artifactPath),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function packetFocusedReviewPath(packetId: string, actionAttempt: number): string {
  return `${reviewFixPacketRoot(packetId)}/attempts/${actionAttempt}/focused-resolution.json`;
}

async function loadExistingPacketFocusedReviewIfPresent(input: {
  runDir: string;
  artifactPath: string;
  packetPath: string | undefined;
  packetSha256: string | undefined;
  packetId: string;
  actionAttempt: number;
  verificationEvidencePath?: string;
}): Promise<{ review: FixPacketResolutionV1; packet: ReviewFixPacketV1 } | null> {
  let review: FixPacketResolutionV1;
  try {
    review = fixPacketResolutionV1Schema.parse(await readRunArtifact<unknown>(input.runDir, input.artifactPath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!input.packetPath || !input.packetSha256) {
    throw new Error("Persisted packet focused review has no immutable packet pointer");
  }
  const packet = await loadReviewFixPacket(input.runDir, input.packetPath, input.packetSha256);
  if (
    packet.provenance.packet_id !== input.packetId
    || review.packet_id !== input.packetId
    || review.packet_sha256 !== input.packetSha256
    || review.action_attempt !== input.actionAttempt
  ) throw new Error("Persisted packet focused review provenance does not match the active packet attempt");
  if (input.verificationEvidencePath) {
    const evidence = verificationEvidenceSchema.parse(
      await readRunArtifact<unknown>(input.runDir, input.verificationEvidencePath),
    );
    review = bindObservedFixPacketResolution(packet, review, evidence, input.actionAttempt);
  }
  assertFixPacketResolutionMatchesPacket(packet, review);
  return { review, packet };
}

function packetFocusedDecision(
  review: FixPacketResolutionV1,
): "resolved" | "still_open" | "replan_required" | "blocked" {
  if (review.decision === "resolved") return "resolved";
  if (review.decision === "still_open") return "still_open";
  if (review.decision === "packet_contradiction") return "replan_required";
  return "blocked";
}

function packetSupplementForReview(
  packet: ReviewFixPacketV1,
  packetSha256: string,
  review: FixPacketResolutionV1,
): FixAttemptSupplementV1 {
  if (review.decision !== "still_open" || review.required_next_fix === null) {
    throw new Error("Only a still-open packet review can authorize a retry supplement");
  }
  const unsatisfied = review.condition_results.filter((entry) => entry.status === "unsatisfied");
  return fixAttemptSupplementV1Schema.parse({
    packet_id: packet.provenance.packet_id,
    base_packet_sha256: packetSha256,
    next_attempt: review.action_attempt + 1,
    unsatisfied_condition_ids: unsatisfied.map((entry) => entry.success_condition_id),
    remaining_problem: unsatisfied.map((entry) => entry.remaining_problem).filter((entry): entry is string => entry !== null).join("; "),
    required_next_fix: review.required_next_fix,
    additional_evidence_refs: [...new Set(unsatisfied.flatMap((entry) => entry.evidence_refs))],
  });
}

async function persistImmutableJsonArtifact(runDir: string, artifactPath: string, value: unknown): Promise<void> {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  try {
    const existing = await readFile(resolve(runDir, artifactPath), "utf8");
    if (JSON.stringify(JSON.parse(existing)) !== JSON.stringify(value)) {
      throw new Error(`Artifact already exists with different content: ${artifactPath}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await writeImmutableTextArtifact(runDir, artifactPath, content);
  }
}

async function loadPersistedImplementation(
  runDir: string,
  progress: RunManifestV2["work_item_progress"][string] | undefined,
  item: WorkItem,
): Promise<ImplementationResult> {
  const path = runArtifactRelativePath(runDir, typeof progress?.implementation_path === "string" && progress.implementation_path.length > 0
    ? progress.implementation_path
    : `implementation/${item.id.replace(/[^a-zA-Z0-9._-]/g, "_")}/attempt-${Math.max(1, progress?.attempts ?? 1)}.json`);
  const raw = await readRunArtifact<Record<string, unknown>>(runDir, path);
  const asStrings = (value: unknown): string[] => Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
  const asCommands = (value: unknown): readonly string[][] => Array.isArray(value)
    ? value.flatMap((entry) => Array.isArray(entry)
      ? [entry.filter((part): part is string => typeof part === "string")]
      : typeof entry === "string" ? [[entry]] : [])
    : [];
  const summary = typeof raw.summary === "string" && raw.summary.length > 0 ? [raw.summary] : [];
  const implementation: ImplementationResult = {
    work_item_id: typeof raw.work_item_id === "string" ? raw.work_item_id : item.id,
    changed_files: asStrings(raw.changed_files),
    tests_added_or_changed: asStrings(raw.tests_added_or_changed),
    commands_attempted: asCommands(raw.commands_attempted),
    completed_steps: asStrings(raw.completed_steps).length > 0 ? asStrings(raw.completed_steps) : summary,
    remaining_risks: asStrings(raw.remaining_risks ?? raw.known_limitations),
  };
  if (implementation.work_item_id !== item.id) {
    throw new Error(`Persisted Hands report belongs to ${implementation.work_item_id}, expected ${item.id}`);
  }
  return implementation;
}

async function loadPersistedEvidence(
  runDir: string,
  progress: RunManifestV2["work_item_progress"][string] | undefined,
  identity?: VerificationIdentity,
  attempt?: number,
): Promise<VerificationEvidence> {
  const path = progress?.verification_path;
  if (typeof path !== "string" || path.length === 0) {
    throw new Error("Cannot resume: persisted verification evidence is missing");
  }
  if (identity) {
    if (progress?.verification_scope !== undefined && progress.verification_scope !== identity.scope) {
      throw new Error("Persisted verification scope does not match the work item identity");
    }
    if (progress?.verification_work_item_id !== undefined && progress.verification_work_item_id !== identity.work_item_id) {
      throw new Error("Persisted verification work item does not match the work item identity");
    }
    if (identity.scope === "github" && progress?.verification_issue_number !== undefined && progress.verification_issue_number !== identity.issue_number) {
      throw new Error("Persisted verification issue number does not match the durable mapping");
    }
  }
  if (identity && attempt) {
    return validatePersistedVerificationEvidence({ runDir, identity, attempt, evidencePath: path });
  }
  const validated = verificationEvidenceSchema.parse(await readRunArtifact<unknown>(runDir, path)) as VerificationEvidence;
  if (validated.evidence_path !== path) {
    throw new Error(`Persisted verification evidence path ${validated.evidence_path ?? "null"} does not match ${path}`);
  }
  const artifactDirectory = dirname(path);
  for (const command of validated.commands) {
    for (const artifactPath of [command.stdout_path, command.stderr_path, command.result_path].filter((entry): entry is string => typeof entry === "string")) {
      if (dirname(artifactPath) !== artifactDirectory) {
        throw new Error(`Persisted verification command artifact escapes its namespace: ${artifactPath}`);
      }
    }
  }
  return validated;
}

async function persistVerificationEvidence(
  runDir: string,
  evidence: VerificationEvidence,
  identity: VerificationIdentity,
  attempt: number,
): Promise<string> {
  const validated = validateEvidenceForIdentity(evidence, identity, attempt);
  let existingEvidence = false;
  try {
    const existing = await readRunArtifact<unknown>(runDir, validated.evidence_path);
    const parsed = verificationEvidenceSchema.parse(existing) as VerificationEvidence;
    validateEvidenceForIdentity(parsed, identity, attempt);
    existingEvidence = true;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  await assertVerificationNamespaceAvailable(runDir, identity, attempt, { allowExistingAttempt: existingEvidence });
  await writeTextArtifact(
    runDir,
    validated.evidence_path,
    canonicalJsonBytes(verificationEvidenceSchema, validated).toString("utf8"),
  );
  return validated.evidence_path;
}

async function loadPersistedReview(
  runDir: string,
  workItemId: string,
  attempt: number,
  final = false,
): Promise<VerifierReview> {
  const suffix = final ? `final-attempt-${attempt}` : `attempt-${attempt}`;
  const review = await readRunArtifact<VerifierReview>(runDir, `reviews/${workItemId}/${suffix}.json`);
  if (review.work_item_id !== workItemId || review.attempt !== attempt || review.final !== final) {
    throw new Error(`Persisted Verifier review provenance does not match ${workItemId} attempt ${attempt}`);
  }
  return review;
}

async function loadPersistedReviewPath(
  runDir: string,
  path: string,
  workItemId: string,
  attempt: number,
  final: boolean,
): Promise<VerifierReview> {
  const review = await readRunArtifact<VerifierReview>(runDir, path);
  if (review.work_item_id !== workItemId || review.attempt !== attempt || review.final !== final) {
    throw new Error(`Persisted Verifier review provenance does not match ${workItemId} attempt ${attempt}`);
  }
  return review;
}

function mergeImplementationResults(
  base: ImplementationResult,
  additional: ImplementationResult,
): ImplementationResult {
  return {
    work_item_id: "integrated",
    changed_files: [...new Set([...base.changed_files, ...additional.changed_files])],
    tests_added_or_changed: [...new Set([...base.tests_added_or_changed, ...additional.tests_added_or_changed])],
    commands_attempted: [...base.commands_attempted, ...additional.commands_attempted],
    completed_steps: [...base.completed_steps, ...additional.completed_steps],
    remaining_risks: [...new Set([...base.remaining_risks, ...additional.remaining_risks])],
  };
}

function titleForWorkItem(plan: BrainPlan, item: WorkItem, sequence: number): string {
  const featureSlug = resolveFeatureSlug(plan);
  try {
    return formatWorkItemIssueTitle({ featureSlug, sequence, itemSlug: item.id, title: item.title });
  } catch (error) {
    if (plan.feature_slug !== undefined) throw error;
    return item.title;
  }
}

function assertApprovedCurrentPlanRevision(manifest: RunManifestV2): number {
  if (manifest.current_revision !== manifest.current_plan_revision) {
    throw new Error("Current plan revision aliases do not match");
  }
  if (manifest.approved_revision !== manifest.approved_plan_revision) {
    throw new Error("Approved plan revision aliases do not match");
  }
  const currentRevision = manifest.current_revision;
  const approvedRevision = manifest.approved_revision;
  if (currentRevision === null || currentRevision === undefined) {
    throw new Error("Runtime requires a recorded current plan revision");
  }
  if (approvedRevision !== currentRevision) {
    throw new Error(`Runtime requires explicit approval for current plan revision ${currentRevision}`);
  }
  if (!manifest.plan_revisions[String(currentRevision)]) {
    throw new Error(`Runtime requires a recorded plan revision ${currentRevision}`);
  }
  return currentRevision;
}

function runtimeAuthorityToken(manifest: RunManifestV2): string {
  const revision = manifest.approved_revision;
  return JSON.stringify({
    current_revision: manifest.current_revision,
    current_plan_revision: manifest.current_plan_revision,
    approved_revision: revision,
    approved_plan_revision: manifest.approved_plan_revision,
    run_configuration_sha256: manifest.run_configuration_sha256,
    approved_record: revision === null ? null : manifest.plan_revisions[String(revision)] ?? null,
  });
}

function concurrentRuntimeAuthorityHandoff(manifest: RunManifestV2): LocalWorkflowResult {
  return {
    status: "human_action_required",
    manifest,
    orderedWorkItems: [],
    implementationResults: {},
    verification: {},
    reviews: {},
    blocker: "Runtime authority changed concurrently; retry resume with the newly approved revision",
  };
}

function issueProjectionHash(title: string, body: string): string {
  return createHash("sha256").update(JSON.stringify({ title, body })).digest("hex");
}

function attachLineageOwnershipHeader(body: string, lineageId: string): string {
  const lineageMarker = `<!-- brain-hands-lineage:${lineageId} -->`;
  const signatureCount = [...body.matchAll(/brain-hands(?:-|:)lineage/gi)].length;
  if (signatureCount === 0) return `${lineageMarker}\n${body}`;
  if (signatureCount === 1 && body.startsWith(`${lineageMarker}\n`)) return body;
  throw new Error("GitHub issue has duplicate, malformed, or mixed lineage ownership markers");
}

async function appendIssueMaterialEventOnce(
  runDir: string,
  result: IssueReconciliationResult,
  type: string,
  payload: Record<string, unknown>,
): Promise<void> {
  if (result.outcome === "noop") return;
  const events = (await readFile(join(runDir, "events.jsonl"), "utf8"))
    .split("\n").filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line) as { type?: unknown; payload?: unknown }]; } catch { return []; }
    });
  const recorded = events.some((event) =>
    event.type === type
    && typeof event.payload === "object"
    && event.payload !== null
    && (event.payload as { operation_id?: unknown }).operation_id === result.operation_id);
  if (!recorded) {
    await appendRunEvent(runDir, {
      actor: "runtime",
      stage: "github_issue_sync",
      type,
      payload: {
        ...payload,
        operation_id: result.operation_id,
        desired_hash: result.desired_hash,
      },
    });
  }
  await completeIssueReconciliation(runDir, result);
}

function samePreviewReference(left: GithubEffectPreviewRef, right: GithubEffectPreviewRef): boolean {
  return left.phase === right.phase
    && left.revision === right.revision
    && left.path === right.path
    && left.sha256 === right.sha256
    && left.plan_revision === right.plan_revision
    && left.plan_sha256 === right.plan_sha256
    && left.state === right.state;
}

function samePreviewIdentity(left: GithubEffectPreviewRef, right: GithubEffectPreviewRef): boolean {
  return left.phase === right.phase
    && left.revision === right.revision
    && left.path === right.path
    && left.sha256 === right.sha256
    && left.plan_revision === right.plan_revision
    && left.plan_sha256 === right.plan_sha256;
}

function countLiteral(value: string, literal: string): number {
  return value.split(literal).length - 1;
}

function observedIssueLineage(
  observation: GitHubIssueObservation,
  runId: string,
  target: { kind: "work_item"; value: string } | { kind: "parent"; value: string },
): string | null {
  const runMarker = `<!-- brain-hands-run:${runId} -->`;
  const targetMarker = target.kind === "work_item"
    ? `<!-- brain-hands-work-item:${target.value} -->`
    : `<!-- brain-hands-parent:${target.value} -->`;
  const oppositeMarker = target.kind === "work_item" ? "brain-hands-parent:" : "brain-hands-work-item:";
  const lineageSignatures = [...observation.body.matchAll(/brain-hands(?:-|:)lineage/gi)].length;
  const lineageHeader = observation.body.match(/^<!-- brain-hands-lineage:([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}) -->\n/i);
  const validMarkerCounts = countLiteral(observation.body, runMarker) === 1
    && countLiteral(observation.body, targetMarker) === 1
    && !observation.body.includes(oppositeMarker);
  if (lineageSignatures === 0) {
    if (!validMarkerCounts || !observation.body.startsWith(`${runMarker}\n${targetMarker}\n`)) {
      throw new GithubEffectPlanningError("ownership-mismatch", `GitHub issue #${observation.number} has malformed legacy ownership markers`);
    }
    return null;
  }
  if (lineageSignatures !== 1 || lineageHeader === null
    || !validMarkerCounts
    || !observation.body.startsWith(`${lineageHeader[0]}${runMarker}\n${targetMarker}\n`)) {
    throw new GithubEffectPlanningError("ownership-mismatch", `GitHub issue #${observation.number} has malformed or mixed lineage ownership markers`);
  }
  return lineageHeader[1]!.toLowerCase();
}

function classifyIssueObservations(
  expectedLineageId: string,
  runId: string,
  target: { kind: "work_item"; value: string } | { kind: "parent"; value: string },
  lineageMatches: GitHubIssueObservation[],
  legacyMatches: GitHubIssueObservation[],
): GitHubIssueObservation[] {
  const byNumber = new Map<number, GitHubIssueObservation>();
  for (const observation of [...lineageMatches, ...legacyMatches]) {
    const existing = byNumber.get(observation.number);
    if (existing && !isDeepStrictEqual(existing, observation)) {
      throw new GithubEffectPlanningError("ownership-mismatch", `GitHub issue #${observation.number} returned conflicting ownership observations`);
    }
    byNumber.set(observation.number, observation);
  }
  const observations = [...byNumber.values()].sort((left, right) => left.number - right.number);
  for (const observation of observations) {
    const lineageId = observedIssueLineage(observation, runId, target);
    if (lineageId !== null && lineageId !== expectedLineageId.toLowerCase()) {
      throw new GithubEffectPlanningError(
        "ownership-mismatch",
        `GitHub issue #${observation.number} is owned by a different lineage`,
      );
    }
  }
  if (observations.length > 1) {
    throw new GithubEffectPlanningError("ambiguous-marker", "Multiple GitHub issues claim the same run and target provenance");
  }
  return observations;
}

function issueObservationMaterial(observation: GitHubIssueObservation) {
  return {
    number: observation.number,
    title: observation.title,
    body: observation.body,
    labels: observation.labels,
    state: observation.state,
    state_reason: observation.state_reason,
  };
}

async function observeIssuePreviewTargets(
  input: RunGithubWorkflowInput,
  manifest: RunManifestV2,
  lineage: TaskLineageRecordV1,
  orderedWorkItems: WorkItem[],
): Promise<Pick<IssueSyncPlanningInput, "parent" | "work_items">> {
  const github = input.dependencies.github;
  if (!github.findIssuesByMarker || !github.findParentIssuesByMarker) {
    throw new Error("GitHub all-match issue observation is required before effect preview planning");
  }
  if (manifest.task_lineage_id === null) throw new Error("GitHub issue preview requires a task lineage");
  const lineageId = manifest.task_lineage_id;
  const featureSlug = resolveFeatureSlug(input.plan);
  const planRevision = assertApprovedCurrentPlanRevision(manifest);
  const legacyRestore = (manifest.legacy_github_restore ?? null) !== null;
  const authoritativeMap = Object.keys(lineage.issue_set.work_item_issue_map).length > 0
    ? lineage.issue_set.work_item_issue_map
    : legacyRestore ? { ...manifest.github_ids.work_item_issue_map, ...manifest.work_item_issue_map } : {};
  const persistedMap = { ...authoritativeMap };
  if (Object.keys(persistedMap).length === 0 && manifest.github_ids.issue_numbers.length > orderedWorkItems.length) {
    throw new GithubEffectPlanningError("ownership-mismatch", "Legacy issue mappings contain targets absent from the approved plan");
  }
  const workItems: IssueSyncPlanningInput["work_items"] = [];
  for (const [index, item] of orderedWorkItems.entries()) {
    const marker: GitHubIssueMarker = { lineageId, runId: manifest.run_id, workItemId: item.id };
    const observations = await Promise.allSettled([
      github.findIssuesByMarker!(marker),
      github.findIssuesByMarker!({ runId: manifest.run_id, workItemId: item.id }),
    ]);
    const failedObservation = observations.find((observation) => observation.status === "rejected");
    if (failedObservation?.status === "rejected") throw failedObservation.reason;
    const [lineageMatches, legacyMatches] = observations.map((observation) =>
      (observation as PromiseFulfilledResult<GitHubIssueObservation[]>).value);
    const classified = classifyIssueObservations(
      lineageId,
      manifest.run_id,
      { kind: "work_item", value: item.id },
      lineageMatches,
      legacyMatches,
    );
    const persistedNumber = persistedMap[item.id] ?? (Object.keys(persistedMap).length === 0 ? manifest.github_ids.issue_numbers[index] : undefined);
    if (persistedNumber !== undefined && (classified.length !== 1 || classified[0]!.number !== persistedNumber)) {
      throw new GithubEffectPlanningError("ownership-mismatch", `Persisted legacy mapping for ${item.id} does not match exhaustive ownership observation`);
    }
    workItems.push({
      work_item_id: item.id,
      desired: {
        title: titleForWorkItem(input.plan, item, index + 1),
        body: formatIssueBody(item, marker),
        labels: ISSUE_LABELS.split(","),
        state: "OPEN" as const,
        state_reason: null,
        reason_code: "approved-plan-work-item",
      },
      observations: classified.map(issueObservationMaterial),
    });
  }
  if (!input.plan.parent_issue) return { parent: null, work_items: workItems };
  const parentMarker: GitHubParentIssueMarker = { lineageId, runId: manifest.run_id, featureSlug };
  const parentObservations = await Promise.allSettled([
    github.findParentIssuesByMarker(parentMarker),
    github.findParentIssuesByMarker({ runId: manifest.run_id, featureSlug }),
  ]);
  const failedParentObservation = parentObservations.find((observation) => observation.status === "rejected");
  if (failedParentObservation?.status === "rejected") throw failedParentObservation.reason;
  const [lineageParents, legacyParents] = parentObservations.map((observation) =>
    (observation as PromiseFulfilledResult<GitHubIssueObservation[]>).value);
  const parentSpec: ParentIssueSpec = {
    title: formatParentIssueTitle({ featureSlug, title: input.plan.parent_issue.title }),
    summary: input.plan.summary,
    runId: manifest.run_id,
    featureSlug,
    planRevision,
    workItems: [],
  };
  const classifiedParents = classifyIssueObservations(
    lineageId,
    manifest.run_id,
    { kind: "parent", value: featureSlug },
    lineageParents,
    legacyParents,
  );
  const persistedParent = lineage.issue_set.parent_issue_number ?? (legacyRestore ? manifest.github_ids.parent_issue_number : null);
  if (persistedParent !== null && (classifiedParents.length !== 1 || classifiedParents[0]!.number !== persistedParent)) {
    throw new GithubEffectPlanningError("ownership-mismatch", "Persisted legacy parent mapping does not match exhaustive ownership observation");
  }
  return {
    parent: {
      feature_slug: featureSlug,
      desired: {
        title: parentSpec.title,
        body: formatParentIssueBody(parentSpec, parentMarker),
        labels: PARENT_ISSUE_LABELS.split(","),
        state: "OPEN",
        state_reason: null,
        reason_code: "approved-plan-parent",
      },
      observations: classifiedParents.map(issueObservationMaterial),
    },
    work_items: workItems,
  };
}

function issueSetHasPriorOwnedState(lineage: TaskLineageRecordV1): boolean {
  return lineage.issue_set.state !== "uninitialized"
    || lineage.issue_set.parent_issue_number !== null
    || Object.keys(lineage.issue_set.work_item_issue_map).length > 0
    || Object.keys(lineage.issue_set.operations).length > 0;
}

async function verifyIssuePreviewReference(
  runDir: string,
  manifest: RunManifestV2,
  reference: GithubEffectPreviewRef,
): Promise<GithubEffectPreviewV1> {
  if (manifest.task_lineage_id === null) throw new Error("GitHub issue preview is missing its lineage binding");
  const planRevision = assertApprovedCurrentPlanRevision(manifest);
  const plan = manifest.plan_revisions[String(planRevision)]!;
  return readVerifiedGithubEffectPreview({
    run_dir: runDir,
    reference,
    expected: {
      phase: "issue_sync",
      lineage_id: manifest.task_lineage_id,
      run_id: manifest.run_id,
      plan_revision: planRevision,
      plan_sha256: plan.sha256,
    },
  });
}

async function readArtifactOnlyIssuePreview(
  runDir: string,
  manifest: RunManifestV2,
  revision = 1,
): Promise<{ preview: GithubEffectPreviewV1; reference: GithubEffectPreviewRef } | null> {
  let bytes: Buffer;
  try {
    bytes = await readOwnedRunFile(runDir, `github-effects/issue-sync/revision-${revision}.json`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (manifest.task_lineage_id === null) throw new Error("GitHub issue preview artifact is missing its lineage binding");
  const planRevision = assertApprovedCurrentPlanRevision(manifest);
  const plan = manifest.plan_revisions[String(planRevision)]!;
  const reference: GithubEffectPreviewRef = {
    phase: "issue_sync",
    revision,
    path: `github-effects/issue-sync/revision-${revision}.json`,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    plan_revision: planRevision,
    plan_sha256: plan.sha256,
    state: "previewed",
  };
  const preview = await readVerifiedGithubEffectPreview({
    run_dir: runDir,
    reference,
    expected: {
      phase: "issue_sync",
      lineage_id: manifest.task_lineage_id,
      run_id: manifest.run_id,
      plan_revision: planRevision,
      plan_sha256: plan.sha256,
    },
  });
  return { preview, reference };
}

function assertPlanningManifestUnchanged(current: RunManifestV2, expected: RunManifestV2): void {
  const normalizeLeaseInternals = (manifest: RunManifestV2): RunManifestV2 => ({
    ...manifest,
    updated_at: "",
    execution_epoch: 0,
    execution_lease: manifest.execution_lease === null || manifest.execution_lease === undefined
      ? null
      : {
        ...manifest.execution_lease,
        heartbeat_at: "",
        authority_sha256: "0".repeat(64),
      },
  });
  if (!isDeepStrictEqual(normalizeLeaseInternals(current), normalizeLeaseInternals(expected))) {
    throw new Error("Run manifest changed after GitHub issue preview planning snapshot");
  }
}

async function persistIssuePreviewBoundary(input: {
  runDir: string;
  repoRoot: string;
  manifestSnapshot: RunManifestV2;
  lineageSnapshot: TaskLineageRecordV1;
  preview: GithubEffectPreviewV1;
  expectedReference?: GithubEffectPreviewRef;
  afterLineagePersisted?: () => Promise<void>;
  ledgerHooks?: RunLedgerTransactionHooks;
}): Promise<RunManifestV2> {
  const reference = await writeGithubEffectPreview({ run_dir: input.runDir, preview: input.preview });
  if (input.expectedReference && !samePreviewReference(input.expectedReference, reference)) {
    throw new Error("Verified GitHub issue preview reference changed during persistence");
  }
  await verifyIssuePreviewReference(input.runDir, input.manifestSnapshot, reference);
  const persisted = await withTaskLineageTransaction({
    repoRoot: input.repoRoot,
    lineageId: input.lineageSnapshot.lineage_id,
    operation: async (transaction) => {
      const current = transaction.read();
      if (!isDeepStrictEqual(current, input.lineageSnapshot)) {
        throw new Error("Task lineage changed after GitHub issue preview planning snapshot");
      }
      const existingLineageReference = current.issue_set.preview;
      if (existingLineageReference !== null && !samePreviewReference(existingLineageReference, reference)) {
        throw new Error("Task lineage has a conflicting immutable issue preview reference");
      }
      if ((current.issue_set.plan_revision !== null && current.issue_set.plan_revision !== reference.plan_revision)
        || (current.issue_set.plan_sha256 !== null && current.issue_set.plan_sha256 !== reference.plan_sha256)) {
        throw new Error("Task lineage issue preview plan binding conflicts with the approved plan");
      }
      const lineage = existingLineageReference !== null ? current : await transaction.update({
        ...current,
        issue_set: {
          ...current.issue_set,
          // Still pre-application: Task 8 exclusively owns state/operation changes.
          plan_revision: reference.plan_revision,
          plan_sha256: reference.plan_sha256,
          preview: reference,
        },
      });
      await input.afterLineagePersisted?.();
      const manifest = await withRunLedgerTransaction(input.runDir, async (manifestTransaction) => {
        const currentManifest = await manifestTransaction.readManifestV2();
        assertPlanningManifestUnchanged(currentManifest, input.manifestSnapshot);
        const existingManifestReference = currentManifest.github_effects.issue_sync;
        if (existingManifestReference !== null && !samePreviewReference(existingManifestReference, reference)) {
          throw new Error("Run manifest has a conflicting immutable issue preview reference");
        }
        const boundaryMetadataResolved = currentManifest.delivery_state === "pending"
          && currentManifest.last_blocker === null;
        let nextManifest = existingManifestReference === null || !boundaryMetadataResolved
          ? await manifestTransaction.updateManifestV2({
            github_effects: { ...currentManifest.github_effects, issue_sync: reference },
            delivery_state: "pending",
            last_blocker: null,
          })
          : currentManifest;
        if (nextManifest.stage === "worktree_setup") {
          nextManifest = await transitionRun(input.runDir, "awaiting_github_issue_effects", {
            actor: "runtime",
            payload: { preview_revision: input.preview.revision, preview_sha256: input.preview.preview_sha256 },
          });
        } else if (nextManifest.stage !== "awaiting_github_issue_effects") {
          throw new Error(`GitHub issue preview boundary requires worktree_setup or awaiting_github_issue_effects stage, got ${nextManifest.stage}`);
        }
        return nextManifest;
      }, input.ledgerHooks);
      return { lineage, manifest };
    },
  });
  if (!samePreviewReference(persisted.lineage.issue_set.preview!, reference)) {
    throw new Error("Task lineage issue preview persistence did not retain the verified reference");
  }
  const manifest = persisted.manifest;
  if (!samePreviewReference(manifest.github_effects.issue_sync!, reference)) {
    throw new Error("Run manifest issue preview persistence did not retain the verified reference");
  }
  return manifest;
}

async function previewGithubIssues(
  input: RunGithubWorkflowInput,
  orderedWorkItems: WorkItem[],
  manifest: RunManifestV2,
  lineage: TaskLineageRecordV1,
  repository: { host: string; name_with_owner: string },
): Promise<LocalWorkflowResult> {
  if (!input.plan.parent_issue && manifest.github_ids.parent_issue_number) {
    throw new Error(`Approved plan cannot detach persisted parent issue #${manifest.github_ids.parent_issue_number}`);
  }
  const planRevision = assertApprovedCurrentPlanRevision(manifest);
  const plan = manifest.plan_revisions[String(planRevision)]!;
  const lineageReference = lineage.issue_set.preview;
  const manifestReference = manifest.github_effects.issue_sync;
  if (lineageReference !== null || manifestReference !== null) {
    if (lineageReference === null || (manifestReference !== null && !samePreviewReference(lineageReference, manifestReference))) {
      throw new Error("Run and task lineage issue preview references are incomplete or conflicting");
    }
    if (lineageReference.plan_revision !== planRevision || lineageReference.plan_sha256 !== plan.sha256) {
      if (manifestReference === null) throw new Error("Approved replan is missing its prior run issue preview reference");
      await readVerifiedGithubEffectPreview({
        run_dir: input.runDir,
        reference: lineageReference,
        expected: {
          phase: "issue_sync",
          lineage_id: lineage.lineage_id,
          run_id: manifest.run_id,
          plan_revision: lineageReference.plan_revision,
          plan_sha256: lineageReference.plan_sha256,
        },
      });
      const observations = await observeIssuePreviewTargets(input, manifest, lineage, orderedWorkItems);
      const replacement = planIssueSyncPreview({
        revision: lineageReference.revision + 1,
        lineage_id: lineage.lineage_id,
        run_id: manifest.run_id,
        repository,
        plan_revision: planRevision,
        plan_sha256: plan.sha256,
        created_at: new Date().toISOString(),
        lineage_state: lineage.state,
        issue_set: {
          state: lineage.issue_set.state,
          plan_revision: lineage.issue_set.plan_revision,
          plan_sha256: lineage.issue_set.plan_sha256,
          parent_issue_number: lineage.issue_set.parent_issue_number,
          work_item_issue_map: lineage.issue_set.work_item_issue_map,
          has_prior_owned_state: issueSetHasPriorOwnedState(lineage),
        },
        approved_replan: true,
        ...observations,
      });
      return persistReplacementIssuePreview(input, orderedWorkItems, manifest, lineage, repository, replacement, null);
    }
    const preview = await verifyIssuePreviewReference(input.runDir, manifest, lineageReference);
    const persisted = await persistIssuePreviewBoundary({
      runDir: input.runDir,
      repoRoot: input.repoRoot,
      manifestSnapshot: manifest,
      lineageSnapshot: lineage,
      preview,
      expectedReference: lineageReference,
      afterLineagePersisted: input.dependencies.afterIssuePreviewLineagePersisted,
      ledgerHooks: input.dependencies.issuePreviewLedgerHooks,
    });
    return { status: "awaiting_github_effects", manifest: persisted, orderedWorkItems, implementationResults: {}, verification: {}, reviews: {} };
  }
  if (manifest.stage !== "worktree_setup") {
    throw new Error(`GitHub issue preview planning requires worktree_setup stage, got ${manifest.stage}`);
  }
  const artifactOnly = await readArtifactOnlyIssuePreview(input.runDir, manifest);
  if (artifactOnly !== null) {
    const persisted = await persistIssuePreviewBoundary({
      runDir: input.runDir,
      repoRoot: input.repoRoot,
      manifestSnapshot: manifest,
      lineageSnapshot: lineage,
      preview: artifactOnly.preview,
      expectedReference: artifactOnly.reference,
      afterLineagePersisted: input.dependencies.afterIssuePreviewLineagePersisted,
      ledgerHooks: input.dependencies.issuePreviewLedgerHooks,
    });
    return { status: "awaiting_github_effects", manifest: persisted, orderedWorkItems, implementationResults: {}, verification: {}, reviews: {} };
  }
  const observations = await observeIssuePreviewTargets(input, manifest, lineage, orderedWorkItems);
  const preview = planIssueSyncPreview({
    revision: 1,
    lineage_id: lineage.lineage_id,
    run_id: manifest.run_id,
    repository,
    plan_revision: planRevision,
    plan_sha256: plan.sha256,
    created_at: manifest.created_at,
    lineage_state: lineage.state,
    issue_set: {
      state: lineage.issue_set.state,
      plan_revision: lineage.issue_set.plan_revision,
      plan_sha256: lineage.issue_set.plan_sha256,
      parent_issue_number: lineage.issue_set.parent_issue_number,
      work_item_issue_map: lineage.issue_set.work_item_issue_map,
      has_prior_owned_state: issueSetHasPriorOwnedState(lineage),
    },
    approved_replan: planRevision > 1,
    ...observations,
  });
  const persisted = await persistIssuePreviewBoundary({
    runDir: input.runDir,
    repoRoot: input.repoRoot,
    manifestSnapshot: manifest,
    lineageSnapshot: lineage,
    preview,
    afterLineagePersisted: input.dependencies.afterIssuePreviewLineagePersisted,
    ledgerHooks: input.dependencies.issuePreviewLedgerHooks,
  });
  return { status: "awaiting_github_effects", manifest: persisted, orderedWorkItems, implementationResults: {}, verification: {}, reviews: {} };
}

async function applyGithubIssuePreview(
  input: RunGithubWorkflowInput,
  orderedWorkItems: WorkItem[],
  manifest: RunManifestV2,
  lineage: TaskLineageRecordV1,
  repository: { host: string; name_with_owner: string },
): Promise<LocalWorkflowResult | null> {
  if (manifest.stage !== "awaiting_github_issue_effects") throw new Error("Issue effects can only apply at their awaiting stage");
  let lineageReference = lineage.issue_set.preview;
  let manifestReference = manifest.github_effects.issue_sync;
  const hasInvalidatedReference = lineageReference?.state === "invalidated" || manifestReference?.state === "invalidated";
  if (lineageReference !== null && manifestReference !== null && samePreviewIdentity(lineageReference, manifestReference) && hasInvalidatedReference
    && (lineageReference.state !== "invalidated" || manifestReference.state !== "invalidated")) {
    const invalidated = { ...lineageReference, state: "invalidated" as const };
    const repaired = await withTaskLineageTransaction({ repoRoot: input.repoRoot, lineageId: lineage.lineage_id, operation: async (lineageTransaction) => {
      const current = lineageTransaction.read();
      if (!samePreviewIdentity(current.issue_set.preview!, lineageReference!)) throw new Error("Task lineage changed during invalidation-prefix recovery");
      const nextLineage = current.issue_set.preview!.state === "invalidated" ? current : await lineageTransaction.update({ ...current, issue_set: { ...current.issue_set, preview: invalidated } });
      const nextManifest = await withRunLedgerTransaction(input.runDir, async (runTransaction) => {
        const currentManifest = await runTransaction.readManifestV2();
        if (!samePreviewIdentity(currentManifest.github_effects.issue_sync!, manifestReference!)) throw new Error("Run manifest changed during invalidation-prefix recovery");
        return currentManifest.github_effects.issue_sync!.state === "invalidated" ? currentManifest : runTransaction.updateManifestV2({ github_effects: { ...currentManifest.github_effects, issue_sync: invalidated } });
      });
      return { nextLineage, nextManifest };
    } });
    lineage = repaired.nextLineage; manifest = repaired.nextManifest;
    lineageReference = lineage.issue_set.preview; manifestReference = manifest.github_effects.issue_sync;
  }
  if (lineageReference !== null && manifestReference !== null && !samePreviewIdentity(lineageReference, manifestReference)
    && lineageReference.revision === manifestReference.revision + 1) {
    await verifyIssuePreviewReference(input.runDir, manifest, lineageReference);
    const repaired = await withTaskLineageTransaction({
      repoRoot: input.repoRoot,
      lineageId: lineage.lineage_id,
      operation: async (lineageTransaction) => {
        const currentLineage = lineageTransaction.read();
        if (!samePreviewReference(currentLineage.issue_set.preview!, lineageReference)
          || currentLineage.active_run_id !== manifest.run_id
          || currentLineage.repository_key !== `${repository.host}/${repository.name_with_owner}`.toLowerCase()) {
          throw new Error("Task lineage changed before replacement preview mirror recovery");
        }
        return withRunLedgerTransaction(input.runDir, async (manifestTransaction) => {
          const current = await manifestTransaction.readManifestV2();
          if (!samePreviewReference(current.github_effects.issue_sync!, manifestReference)
            || current.stage !== "awaiting_github_issue_effects") throw new Error("Run manifest changed before replacement preview mirror recovery");
          return manifestTransaction.updateManifestV2({
            github_effects: { ...current.github_effects, issue_sync: lineageReference },
            delivery_state: "pending",
            last_blocker: null,
          });
        });
      },
    });
    return { status: "awaiting_github_effects", manifest: repaired, orderedWorkItems, implementationResults: {}, verification: {}, reviews: {} };
  }
  if (lineageReference === null || manifestReference === null || !samePreviewIdentity(lineageReference, manifestReference)) {
    throw new Error("Run and task lineage issue preview references are incomplete or conflicting");
  }
  const preview = await verifyIssuePreviewReference(input.runDir, manifest, manifestReference);
  const repositoryKey = `${repository.host}/${repository.name_with_owner}`.toLowerCase();
  if (lineage.active_run_id !== manifest.run_id
    || lineage.repository_key !== repositoryKey
    || lineage.state !== "active") {
    throw new Error("Issue effect application requires the exact active lineage, run, and repository binding");
  }
  const planRevision = assertApprovedCurrentPlanRevision(manifest);
  const plan = manifest.plan_revisions[String(planRevision)]!;

  if (lineage.issue_set.state === "ready" && !hasInvalidatedReference) {
    await mirrorAppliedIssueMappings(input.runDir, input.repoRoot, lineage.lineage_id, manifest.run_id, repositoryKey);
    return null;
  }

  const observations = await observeIssuePreviewTargets(input, manifest, lineage, orderedWorkItems);
  const planningIssueSet = lineage.issue_set.state === "uninitialized"
    && lineage.issue_set.parent_issue_number === null
    && Object.keys(lineage.issue_set.work_item_issue_map).length === 0
    && Object.keys(lineage.issue_set.operations).length === 0
    ? { plan_revision: null, plan_sha256: null }
    : { plan_revision: lineage.issue_set.plan_revision, plan_sha256: lineage.issue_set.plan_sha256 };
  const candidate = planIssueSyncPreview({
    revision: preview.revision,
    lineage_id: lineage.lineage_id,
    run_id: manifest.run_id,
    repository,
    plan_revision: planRevision,
    plan_sha256: plan.sha256,
    created_at: preview.created_at,
    lineage_state: lineage.state,
    issue_set: {
      state: lineage.issue_set.state,
      ...planningIssueSet,
      parent_issue_number: lineage.issue_set.parent_issue_number,
      work_item_issue_map: lineage.issue_set.work_item_issue_map,
      has_prior_owned_state: issueSetHasPriorOwnedState(lineage),
    },
    approved_replan: planRevision > 1,
    ...observations,
  });
  const exactlyUnchanged = candidate.observation_sha256 === preview.observation_sha256
    && candidate.desired_sha256 === preview.desired_sha256
    && isDeepStrictEqual(candidate.effects, preview.effects);
  const recoverableCreateDrift = candidate.desired_sha256 === preview.desired_sha256
    && preview.effects.every((effect) => {
      const current = candidate.effects.find((candidateEffect) => isDeepStrictEqual(candidateEffect.target, effect.target));
      if (!current) return false;
      if (isDeepStrictEqual(current, effect)) return true;
      const operation = lineage.issue_set.operations[effect.effect_id];
      return effect.action === "create"
        && current.action === "reuse"
        && current.desired_sha256 === effect.desired_sha256
        && operation?.state === "intent";
    });
  const unchanged = !hasInvalidatedReference && (exactlyUnchanged || recoverableCreateDrift);
  if (!unchanged) {
    const artifactOnly = await readArtifactOnlyIssuePreview(input.runDir, manifest, preview.revision + 1);
    const plannedReplacement = planIssueSyncPreview({
      revision: preview.revision + 1,
      lineage_id: lineage.lineage_id,
      run_id: manifest.run_id,
      repository,
      plan_revision: planRevision,
      plan_sha256: plan.sha256,
      created_at: artifactOnly?.preview.created_at ?? new Date().toISOString(),
      lineage_state: lineage.state,
      issue_set: {
        state: lineage.issue_set.state,
        ...planningIssueSet,
        parent_issue_number: lineage.issue_set.parent_issue_number,
        work_item_issue_map: lineage.issue_set.work_item_issue_map,
        has_prior_owned_state: issueSetHasPriorOwnedState(lineage),
      },
      approved_replan: planRevision > 1,
      ...observations,
    });
    if (artifactOnly !== null && (plannedReplacement.observation_sha256 !== artifactOnly.preview.observation_sha256
      || plannedReplacement.desired_sha256 !== artifactOnly.preview.desired_sha256
      || !isDeepStrictEqual(plannedReplacement.effects, artifactOnly.preview.effects))) {
      throw new Error("Remote issue state drifted after the immutable replacement preview was written");
    }
    const replacement = artifactOnly?.preview ?? plannedReplacement;
    return persistReplacementIssuePreview(input, orderedWorkItems, manifest, lineage, repository, replacement, artifactOnly?.reference ?? null);
  }

  const featureSlug = resolveFeatureSlug(input.plan);
  const targets: Parameters<typeof applyIssueEffectPreview>[0]["targets"] = {};
  for (const [index, item] of orderedWorkItems.entries()) {
    const effect = preview.effects.find((candidate): candidate is Extract<typeof candidate, { target: { kind: "work_item" } }> =>
      candidate.target.kind === "work_item" && candidate.target.work_item_id === item.id);
    if (!effect) throw new Error(`Immutable issue preview is missing work item ${item.id}`);
    const marker: GitHubIssueMarker = { lineageId: lineage.lineage_id, runId: manifest.run_id, workItemId: item.id };
    let latest: GitHubIssueObservation | undefined;
    targets[`work_item:${item.id}`] = {
      effect,
      desired: observations.work_items.find((candidate) => candidate.work_item_id === item.id)!.desired,
      lookup: async () => {
        const [lineageMatches, legacyMatches] = await Promise.all([
          input.dependencies.github.findIssuesByMarker!(marker),
          input.dependencies.github.findIssuesByMarker!({ runId: manifest.run_id, workItemId: item.id }),
        ]);
        const matches = classifyIssueObservations(lineage.lineage_id, manifest.run_id, { kind: "work_item", value: item.id }, lineageMatches, legacyMatches);
        latest = matches[0];
        return matches;
      },
      create: () => input.dependencies.github.createIssue(item, marker, titleForWorkItem(input.plan, item, index + 1)),
      update: (number) => input.dependencies.github.updateIssue(number, item, marker,
        latest ? attachLineageOwnershipHeader(latest.body, lineage.lineage_id) : undefined,
        titleForWorkItem(input.plan, item, index + 1)),
    };
  }
  if (input.plan.parent_issue) {
    const effect = preview.effects.find((candidate): candidate is Extract<typeof candidate, { target: { kind: "parent" } }> => candidate.target.kind === "parent");
    if (!effect || !input.dependencies.github.createParentIssue || !input.dependencies.github.updateParentIssue) {
      throw new Error("Immutable issue preview or adapter is missing its parent issue effect");
    }
    const marker: GitHubParentIssueMarker = { lineageId: lineage.lineage_id, runId: manifest.run_id, featureSlug };
    const spec: ParentIssueSpec = {
      title: formatParentIssueTitle({ featureSlug, title: input.plan.parent_issue.title }),
      summary: input.plan.summary,
      runId: manifest.run_id,
      featureSlug,
      planRevision,
      workItems: [],
    };
    let latest: GitHubIssueObservation | undefined;
    targets.parent = {
      effect,
      desired: observations.parent!.desired,
      lookup: async () => {
        const [lineageMatches, legacyMatches] = await Promise.all([
          input.dependencies.github.findParentIssuesByMarker!(marker),
          input.dependencies.github.findParentIssuesByMarker!({ runId: manifest.run_id, featureSlug }),
        ]);
        const matches = classifyIssueObservations(lineage.lineage_id, manifest.run_id, { kind: "parent", value: featureSlug }, lineageMatches, legacyMatches);
        latest = matches[0];
        return matches;
      },
      create: () => input.dependencies.github.createParentIssue!(spec, marker),
      update: (number) => input.dependencies.github.updateParentIssue!(number, spec, marker,
        latest ? attachLineageOwnershipHeader(latest.body, lineage.lineage_id) : undefined),
    };
  }
  const applied = await applyIssueEffectPreview({
    repoRoot: input.repoRoot,
    runDir: input.runDir,
    lineageId: lineage.lineage_id,
    runId: manifest.run_id,
    repositoryKey,
    preview,
    targets,
    buildReplacement: ({ observations: locked, lineage: current }) => planIssueSyncPreview({
      revision: preview.revision + 1, lineage_id: current.lineage_id, run_id: manifest.run_id, repository,
      plan_revision: planRevision, plan_sha256: plan.sha256, created_at: new Date().toISOString(), lineage_state: current.state,
      issue_set: { state: current.issue_set.state, ...planningIssueSet,
        parent_issue_number: current.issue_set.parent_issue_number, work_item_issue_map: current.issue_set.work_item_issue_map, has_prior_owned_state: issueSetHasPriorOwnedState(current) },
      approved_replan: planRevision > 1,
      parent: observations.parent === null ? null : { feature_slug: featureSlug, desired: observations.parent.desired, observations: locked.parent ?? [] },
      work_items: observations.work_items.map((item) => ({ work_item_id: item.work_item_id, desired: item.desired, observations: locked[`work_item:${item.work_item_id}`] ?? [] })),
    }),
  });
  if (applied.outcome === "ambiguous") throw new Error(`GitHub issue create result is ambiguous for ${applied.target_key}; reconcile-github --apply may only adopt a later unique match`);
  if (applied.outcome === "replacement_preview") {
    return persistReplacementIssuePreview(input, orderedWorkItems, manifest, lineage, repository, applied.preview, null);
  }
  if (applied.outcome !== "applied") throw new Error("Unexpected replacement issue preview result during application");
  await mirrorAppliedIssueMappings(input.runDir, input.repoRoot, lineage.lineage_id, manifest.run_id, repositoryKey);
  return null;
}

async function persistReplacementIssuePreview(
  input: RunGithubWorkflowInput,
  orderedWorkItems: WorkItem[],
  manifest: RunManifestV2,
  lineage: TaskLineageRecordV1,
  repository: { host: string; name_with_owner: string },
  replacement: GithubEffectPreviewV1,
  existingReference: GithubEffectPreviewRef | null,
): Promise<LocalWorkflowResult> {
  const old = lineage.issue_set.preview;
  if (old === null || manifest.github_effects.issue_sync === null || !samePreviewIdentity(old, manifest.github_effects.issue_sync)) throw new Error("Replacement requires one exact current issue preview");
  const planBindingChanged = old.plan_revision !== replacement.plan_revision
    || old.plan_sha256 !== replacement.plan_sha256;
  const invalidated = { ...old, state: "invalidated" as const };
  await withTaskLineageTransaction({ repoRoot: input.repoRoot, lineageId: lineage.lineage_id, operation: async (lineageTransaction) => {
    let current = lineageTransaction.read();
    if (!samePreviewIdentity(current.issue_set.preview!, old)) throw new Error("Task lineage changed before issue preview invalidation");
    if (current.issue_set.preview!.state !== "invalidated") current = await lineageTransaction.update({ ...current, issue_set: { ...current.issue_set, preview: invalidated } });
    await input.dependencies.afterIssuePreviewLineageInvalidated?.();
    await withRunLedgerTransaction(input.runDir, async (runTransaction) => {
      const currentManifest = await runTransaction.readManifestV2();
      if (!samePreviewIdentity(currentManifest.github_effects.issue_sync!, old)) throw new Error("Run manifest changed before issue preview invalidation");
      if (currentManifest.github_effects.issue_sync!.state !== "invalidated") await runTransaction.updateManifestV2({ github_effects: { ...currentManifest.github_effects, issue_sync: invalidated } });
      const events = await readFile(join(input.runDir, "events.jsonl"), "utf8");
      if (!events.includes(`\"old_sha256\":\"${old.sha256}\"`)) await appendRunEvent(input.runDir, { actor: "runtime", type: "github_effect_preview_invalidated", payload: {
        old_phase: old.phase, old_revision: old.revision, old_path: old.path, old_sha256: old.sha256,
        old_plan_revision: old.plan_revision, old_plan_sha256: old.plan_sha256, replacement_revision: replacement.revision, reason: "observed_issue_drift",
      } });
    });
  } });
  await input.dependencies.afterIssuePreviewInvalidated?.();
  const reference = existingReference ?? await writeGithubEffectPreview({ run_dir: input.runDir, preview: replacement });
  if (existingReference === null) await input.dependencies.afterIssueReplacementArtifactPersisted?.();
  const persisted = await withTaskLineageTransaction({ repoRoot: input.repoRoot, lineageId: lineage.lineage_id, operation: async (lineageTransaction) => {
    const current = lineageTransaction.read();
    if (current.issue_set.preview?.state !== "invalidated" || !samePreviewIdentity(current.issue_set.preview, old)) throw new Error("Task lineage changed before replacement attachment");
    await lineageTransaction.update({
      ...current,
      issue_set: {
        ...current.issue_set,
        state: current.issue_set.state === "ready" ? "applying" : current.issue_set.state,
        operations: current.issue_set.state === "ready" ? {} : current.issue_set.operations,
        plan_revision: reference.plan_revision,
        plan_sha256: reference.plan_sha256,
        preview: reference,
      },
      ...(planBindingChanged && current.delivery.preview !== null ? {
        delivery: {
          ...current.delivery,
          state: "uninitialized" as const,
          preview: { ...current.delivery.preview, state: "invalidated" as const },
        },
      } : {}),
    });
    await input.dependencies.afterIssuePreviewLineagePersisted?.();
    return withRunLedgerTransaction(input.runDir, async (runTransaction) => {
      const currentManifest = await runTransaction.readManifestV2();
      if (currentManifest.github_effects.issue_sync?.state !== "invalidated" || !samePreviewIdentity(currentManifest.github_effects.issue_sync, old)) throw new Error("Run manifest changed before replacement attachment");
      return runTransaction.updateManifestV2({
        github_effects: {
          ...currentManifest.github_effects,
          issue_sync: reference,
          ...(planBindingChanged && currentManifest.github_effects.pull_request_delivery !== null ? {
            pull_request_delivery: {
              ...currentManifest.github_effects.pull_request_delivery,
              state: "invalidated" as const,
            },
          } : {}),
        },
        delivery_state: "pending",
        last_blocker: null,
      });
    });
  } });
  return { status: "awaiting_github_effects", manifest: persisted, orderedWorkItems, implementationResults: {}, verification: {}, reviews: {} };
}

async function mirrorAppliedIssueMappings(
  runDir: string,
  repoRoot: string,
  lineageId: string,
  runId: string,
  repositoryKey: string,
): Promise<RunManifestV2> {
  return withTaskLineageTransaction({
    repoRoot,
    lineageId,
    operation: async (lineageTransaction) => {
      const lineage = lineageTransaction.read();
      if (lineage.active_run_id !== runId || lineage.repository_key !== repositoryKey
        || lineage.issue_set.state !== "ready" || lineage.issue_set.preview === null) {
        throw new Error("Only the exact active complete lineage issue mapping may be mirrored");
      }
      return withRunLedgerTransaction(runDir, async (manifestTransaction) => {
        const current = await manifestTransaction.readManifestV2();
        if (current.run_id !== runId || current.task_lineage_id !== lineageId
          || current.github_effects.issue_sync === null
          || !samePreviewIdentity(current.github_effects.issue_sync, lineage.issue_set.preview!)) {
          throw new Error("Run manifest does not match the authoritative applied lineage mapping");
        }
        const preview = await verifyIssuePreviewReference(runDir, current, lineage.issue_set.preview!);
        assertReadyAppliedIssueSet({ repoRoot, lineageId, runId, repositoryKey, preview }, lineage);
        const numbers = Object.values(lineage.issue_set.work_item_issue_map);
        let manifest = await manifestTransaction.updateManifestV2({
          issue_numbers: numbers,
          work_item_issue_map: { ...lineage.issue_set.work_item_issue_map },
          github_ids: {
            ...current.github_ids,
            issue_numbers: numbers,
            work_item_issue_map: { ...lineage.issue_set.work_item_issue_map },
            parent_issue_number: lineage.issue_set.parent_issue_number,
          },
          github_effects: { ...current.github_effects, issue_sync: lineage.issue_set.preview },
        });
        if (manifest.stage === "awaiting_github_issue_effects") manifest = await transitionRun(runDir, "github_issue_sync", { actor: "runtime" });
        if (manifest.stage === "github_issue_sync") manifest = await transitionRun(runDir, "implementing", {
          actor: "runtime",
          payload: { issue_numbers: numbers, work_item_issue_map: lineage.issue_set.work_item_issue_map },
        });
        return manifest;
      });
    },
  });
}

async function restoreLegacyProducingStage(runDir: string, manifest: RunManifestV2): Promise<RunManifestV2> {
  if ((manifest.legacy_github_restore ?? null) === null || manifest.stage === "awaiting_github_issue_effects") return manifest;
  return consumeReadyLegacyGithubRestore(runDir);
}

async function syncGithubIssues(input: RunGithubWorkflowInput, orderedWorkItems: WorkItem[]): Promise<void> {
  if (!input.dependencies.github.findIssueByMarker) {
    throw new Error("GitHub marker lookup is required for idempotent issue sync");
  }
  let manifest = await readManifestV2(input.runDir);
  const budget = manifest.workflow_protocol === "bounded-context-v1" && manifest.resource_budget_policy !== undefined
    ? await openResourceBudget(input.runDir)
    : undefined;
  const planRevision = assertApprovedCurrentPlanRevision(manifest);
  if (!input.plan.parent_issue && manifest.github_ids.parent_issue_number) {
    throw new Error(`Approved plan cannot detach persisted parent issue #${manifest.github_ids.parent_issue_number}`);
  }
  if (manifest.stage === "awaiting_plan_approval") {
    manifest = await transitionRun(input.runDir,
      manifest.github_effects_protocol === "task-lineage-v1" ? "worktree_setup" : "github_issue_sync", {
      actor: "runtime",
      payload: { work_items: orderedWorkItems.map((item) => item.id) },
    });
  } else if (manifest.stage !== "github_issue_sync" && manifest.stage !== "worktree_setup") {
    throw new Error(`GitHub runtime requires awaiting_plan_approval, github_issue_sync, or worktree_setup stage, got ${manifest.stage}`);
  }
  const featureSlug = resolveFeatureSlug(input.plan);
  let parentIssueNumber = manifest.github_ids.parent_issue_number ?? null;
  let foundParentIssue: number | GitHubIssueReference | null = null;
  let parentCurrentBody: string | undefined;
  let parentObservedBody: string | undefined;
  let parentCurrentTitle: string | undefined;
  let parentMarker: GitHubParentIssueMarker | undefined;
  let parentSpec: ParentIssueSpec | undefined;
  if (input.plan.parent_issue) {
    const github = input.dependencies.github;
    if (!github.createParentIssue || !github.findParentIssueByMarker || !github.updateParentIssue) {
      throw new Error("GitHub adapter does not support parent issues");
    }
    if (manifest.task_lineage_id === null) throw new Error("GitHub issue sync requires a task lineage");
    parentMarker = { lineageId: manifest.task_lineage_id, runId: manifest.run_id, featureSlug };
    parentSpec = {
      title: formatParentIssueTitle({ featureSlug, title: input.plan.parent_issue.title }),
      summary: input.plan.summary,
      runId: manifest.run_id,
      featureSlug,
      planRevision,
      workItems: [],
    };
    let foundParent = await github.findParentIssueByMarker(parentMarker);
    if (foundParent === null) {
      foundParent = await github.findParentIssueByMarker({ runId: manifest.run_id, featureSlug });
    }
    foundParentIssue = foundParent;
    if (foundParent !== null) {
      const foundNumber = typeof foundParent === "number" ? foundParent : foundParent.number;
      if (parentIssueNumber !== null && parentIssueNumber !== foundNumber) {
        throw new Error(`Persisted parent issue ${parentIssueNumber} no longer matches its GitHub marker`);
      }
      parentIssueNumber = foundNumber;
      if (typeof foundParent === "object") {
        if (!foundParent.body.includes("<!-- brain-hands-managed:start -->")
          || !foundParent.body.includes("<!-- brain-hands-managed:end -->")) {
          throw new Error(`GitHub parent issue #${foundNumber} is missing Brain Hands managed body markers`);
        }
        parentObservedBody = foundParent.body;
        parentCurrentBody = attachLineageOwnershipHeader(foundParent.body, manifest.task_lineage_id!);
        parentCurrentTitle = foundParent.title;
      }
    } else if (parentIssueNumber !== null) {
      throw new Error(`Persisted parent issue ${parentIssueNumber} no longer matches its GitHub marker`);
    }
  }

  const existing = [...manifest.github_ids.issue_numbers];
  const foundByWorkItemId = new Map<string, number | GitHubIssueReference>();
  const foundNumbers = new Set<number>();
  for (const item of orderedWorkItems) {
    if (manifest.task_lineage_id === null) throw new Error("GitHub issue sync requires a task lineage");
    const marker: GitHubIssueMarker = { lineageId: manifest.task_lineage_id, runId: manifest.run_id, workItemId: item.id };
    let foundIssue = await input.dependencies.github.findIssueByMarker(marker);
    if (foundIssue === null) {
      foundIssue = await input.dependencies.github.findIssueByMarker({ runId: manifest.run_id, workItemId: item.id });
    }
    if (foundIssue === null) continue;
    if (typeof foundIssue === "number") {
      throw new Error(`GitHub issue #${foundIssue} marker lookup must return a full issue reference for reconciliation`);
    }
    const foundNumber = foundIssue.number;
    if (foundNumbers.has(foundNumber)) {
      throw new Error(`GitHub issue #${foundNumber} matches more than one work-item marker`);
    }
    foundNumbers.add(foundNumber);
    foundByWorkItemId.set(item.id, foundIssue);
  }
  for (const persistedIssueNumber of existing) {
    if (!foundNumbers.has(persistedIssueNumber)) {
      throw new Error(`Approved plan cannot detach persisted issue #${persistedIssueNumber}`);
    }
  }

  const resolvedIssueNumbers: Array<number | null> = orderedWorkItems.map((item) => {
    const foundIssue = foundByWorkItemId.get(item.id);
    return foundIssue === undefined ? null : (typeof foundIssue === "number" ? foundIssue : foundIssue.number);
  });
  for (const [index, item] of orderedWorkItems.entries()) {
    if (manifest.task_lineage_id === null) throw new Error("GitHub issue sync requires a task lineage");
    const marker: GitHubIssueMarker = { lineageId: manifest.task_lineage_id, runId: manifest.run_id, workItemId: item.id };
    const desiredIssue = item;
    const desiredTitle = titleForWorkItem(input.plan, item, index + 1);
    const foundIssue = foundByWorkItemId.get(item.id) ?? null;
    if (foundIssue !== null && typeof foundIssue === "object"
      && (!foundIssue.body.includes("<!-- brain-hands-managed:start -->")
        || !foundIssue.body.includes("<!-- brain-hands-managed:end -->"))) {
      throw new Error(`GitHub issue #${foundIssue.number} is missing Brain Hands managed body markers`);
    }
    const desiredBody = formatIssueBody(desiredIssue, marker);
    const currentBody = foundIssue !== null && typeof foundIssue === "object"
      ? attachLineageOwnershipHeader(foundIssue.body, manifest.task_lineage_id)
      : undefined;
    const reconciledBody = currentBody !== undefined
      ? reconcileManagedIssueBody(currentBody, desiredBody)
      : desiredBody;
    const result = await reconcileIssueMutation({
      runDir: input.runDir,
      targetKey: `work-item:${item.id}`,
      desiredHash: issueProjectionHash(desiredTitle, desiredBody),
      found: foundIssue,
      matchesDesired: foundIssue !== null && (typeof foundIssue === "number"
        || (foundIssue.title === desiredTitle && reconciledBody === foundIssue.body)),
      create: () => input.dependencies.github.createIssue(desiredIssue, marker, desiredTitle),
      update: async () => {
        const number = typeof foundIssue === "number" ? foundIssue : foundIssue!.number;
        await input.dependencies.github.updateIssue(number, desiredIssue, marker,
          currentBody, desiredTitle);
      },
      budget,
    });
    const issueNumber = result.issue_number;
    if (!Number.isInteger(issueNumber) || issueNumber < 1) throw new Error(`GitHub returned invalid issue number for ${item.id}`);
    resolvedIssueNumbers[index] = issueNumber;
    const persistedIssueNumbers = resolvedIssueNumbers.filter((number): number is number => number !== null);
    const persistedIssueMap = Object.fromEntries(
      orderedWorkItems.flatMap((candidate, candidateIndex) => {
        const number = resolvedIssueNumbers[candidateIndex];
        return number === null ? [] : [[candidate.id, number] as const];
      }),
    );
    manifest = await updateManifestV2(input.runDir, {
      issue_numbers: persistedIssueNumbers,
      github_ids: {
        ...manifest.github_ids,
        issue_numbers: persistedIssueNumbers,
        work_item_issue_map: persistedIssueMap,
      },
      work_item_issue_map: persistedIssueMap,
    });
    await appendIssueMaterialEventOnce(input.runDir, result, `github_issue_${result.outcome}`, {
      work_item_id: item.id,
      issue_number: issueNumber,
      marker,
    });
    if (!manifest.work_item_progress[item.id]) {
      await syncRuntimeWorkItemStatus({
        runDir: input.runDir,
        github: input.dependencies.github,
        manifest,
        workItem: item,
        workItemIndex: index + 1,
        workItemTotal: orderedWorkItems.length,
        issueNumber,
        state: "ready",
        attempt: 1,
        transitionAt: manifest.updated_at,
        budget,
      });
    }
  }
  const issueNumbers = resolvedIssueNumbers.map((number, index) => {
    if (number === null) throw new Error(`GitHub issue synchronization did not resolve ${orderedWorkItems[index]!.id}`);
    return number;
  });

  if (parentMarker && parentSpec) {
    const completedParentSpec = {
      ...parentSpec,
      workItems: orderedWorkItems.map((item, index) => ({ id: item.id, issueNumber: issueNumbers[index]! })),
    };
    const desiredParentBody = formatParentIssueBody(completedParentSpec, parentMarker);
    const reconciledParentBody = parentCurrentBody === undefined
      ? desiredParentBody
      : reconcileManagedIssueBody(parentCurrentBody, desiredParentBody);
    const parentResult = await reconcileIssueMutation({
      runDir: input.runDir,
      targetKey: `parent:${featureSlug}`,
      desiredHash: issueProjectionHash(completedParentSpec.title, desiredParentBody),
      found: foundParentIssue,
      matchesDesired: foundParentIssue !== null && (typeof foundParentIssue === "number"
        || (parentCurrentTitle === completedParentSpec.title && parentObservedBody === reconciledParentBody)),
      create: () => input.dependencies.github.createParentIssue!(completedParentSpec, parentMarker!),
      update: () => input.dependencies.github.updateParentIssue!(
        parentIssueNumber!, completedParentSpec, parentMarker!, parentCurrentBody),
      budget,
    });
    parentIssueNumber = parentResult.issue_number;
    manifest = await updateManifestV2(input.runDir, {
      github_ids: { ...manifest.github_ids, parent_issue_number: parentIssueNumber },
    });
    await appendIssueMaterialEventOnce(input.runDir, parentResult, `github_parent_issue_${parentResult.outcome}`, {
      parent_issue_number: parentIssueNumber,
      feature_slug: featureSlug,
      marker: parentMarker,
    });
  }

  if (manifest.stage === "github_issue_sync") {
    await transitionRun(input.runDir, "worktree_setup", {
      actor: "runtime",
      payload: {
        issue_numbers: issueNumbers,
        work_item_issue_map: { ...manifest.work_item_issue_map, ...(manifest.github_ids.work_item_issue_map ?? {}) },
      },
    });
  }
}

function verifiedPullRequestReference(value: unknown, source: string): GitHubPullRequestReference {
  if (!value || typeof value !== "object") {
    throw new Error(`${source} returned an invalid pull request reference`);
  }
  const reference = value as {
    number?: unknown;
    url?: unknown;
    title?: unknown;
    head_ref?: unknown;
    head_sha?: unknown;
    base_ref?: unknown;
    body?: unknown;
    closing_issue_numbers?: unknown;
    state?: unknown;
  };
  if (!Number.isInteger(reference.number) || (reference.number as number) < 1) {
    throw new Error(`${source} returned an invalid pull request number`);
  }
  if (typeof reference.url !== "string") {
    throw new Error(`${source} returned a pull request without a verified URL`);
  }
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(reference.url);
  } catch {
    throw new Error(`${source} returned an invalid pull request URL`);
  }
  if (parsedUrl.protocol !== "https:" || !parsedUrl.hostname) {
    throw new Error(`${source} returned a pull request URL that is not a real HTTPS URL`);
  }
  if (reference.head_ref !== undefined && (typeof reference.head_ref !== "string" || reference.head_ref.trim() === "")) {
    throw new Error(`${source} returned an invalid pull request head ref`);
  }
  if (reference.head_sha !== undefined && (typeof reference.head_sha !== "string" || !/^[a-f0-9]{40,64}$/i.test(reference.head_sha))) {
    throw new Error(`${source} returned an invalid pull request head SHA`);
  }
  if (reference.state !== undefined && reference.state !== "OPEN" && reference.state !== "CLOSED" && reference.state !== "MERGED") {
    throw new Error(`${source} returned an invalid pull request state`);
  }
  if (reference.base_ref !== undefined && typeof reference.base_ref !== "string") {
    throw new Error(`${source} returned an invalid pull request base branch`);
  }
  if (reference.body !== undefined && typeof reference.body !== "string") {
    throw new Error(`${source} returned an invalid pull request body`);
  }
  if (reference.closing_issue_numbers !== undefined && (!Array.isArray(reference.closing_issue_numbers)
    || reference.closing_issue_numbers.some((number) => !Number.isSafeInteger(number) || number < 1))) {
    throw new Error(`${source} returned invalid closing issue references`);
  }
  return {
    number: reference.number as number,
    url: reference.url,
    ...(typeof reference.title === "string" ? { title: reference.title } : {}),
    ...(typeof reference.head_ref === "string" ? { head_ref: reference.head_ref } : {}),
    ...(typeof reference.head_sha === "string" ? { head_sha: reference.head_sha.toLowerCase() } : {}),
    ...(typeof reference.base_ref === "string" ? { base_ref: reference.base_ref } : {}),
    ...(typeof reference.body === "string" ? { body: reference.body } : {}),
    ...(Array.isArray(reference.closing_issue_numbers) ? { closing_issue_numbers: [...reference.closing_issue_numbers] as number[] } : {}),
    ...(reference.state === "OPEN" || reference.state === "CLOSED" || reference.state === "MERGED" ? { state: reference.state } : {}),
  };
}

function normalizePullRequestReference(value: GitHubPullRequestReference | number): GitHubPullRequestReference {
  if (typeof value === "number") {
    throw new Error("GitHub adapter returned a pull request number without a verified URL");
  }
  return verifiedPullRequestReference(value, "GitHub adapter");
}

function deliveryPullRequestObservation(reference: GitHubPullRequestReference): ObservedPullRequestMaterial {
  const complete = verifiedPullRequestReference(reference, "GitHub lineage pull-request lookup");
  if (typeof complete.title !== "string" || typeof complete.body !== "string"
    || typeof complete.head_ref !== "string" || typeof complete.head_sha !== "string"
    || typeof complete.base_ref !== "string" || complete.state === undefined
    || complete.closing_issue_numbers === undefined) {
    throw new Error(`Pull request #${complete.number} has incomplete delivery identity metadata`);
  }
  return {
    number: complete.number, url: complete.url, title: complete.title, body: complete.body,
    head_ref: complete.head_ref, head_sha: complete.head_sha, base_ref: complete.base_ref,
    closing_issue_numbers: [...complete.closing_issue_numbers], state: complete.state,
  };
}

async function allSettledOrThrow<const T extends readonly Promise<unknown>[]>(
  operations: T,
): Promise<{ [K in keyof T]: Awaited<T[K]> }>;
async function allSettledOrThrow<T>(operations: Iterable<Promise<T>>): Promise<T[]>;
async function allSettledOrThrow(operations: Iterable<Promise<unknown>>): Promise<unknown[]> {
  const settled = await Promise.allSettled([...operations]);
  const failed = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failed) throw failed.reason;
  return settled.map((result) => (result as PromiseFulfilledResult<unknown>).value);
}

async function buildDeliveryPlanningInput(
  input: RunGithubWorkflowInput,
  manifest: RunManifestV2,
  lineage: TaskLineageRecordV1,
  orderedWorkItems: WorkItem[],
  revision: number,
  createdAt: string,
): Promise<PullRequestDeliveryPlanningInput> {
  const github = input.dependencies.github;
  if (!github.getDefaultBranch || !github.findPullRequestsByLineage || !github.getIssue) {
    throw new Error("GitHub delivery preview requires exhaustive lineage PR, default branch, and issue observation");
  }
  if (manifest.task_lineage_id === null || manifest.task_lineage_id !== lineage.lineage_id) {
    throw new Error("GitHub delivery preview requires its exact task lineage");
  }
  if (lineage.issue_set.preview === null) throw new Error("GitHub delivery requires the applied issue preview reference");
  const issuePreview = await readVerifiedGithubEffectPreview({
    run_dir: input.runDir, reference: lineage.issue_set.preview,
    expected: { phase: "issue_sync", lineage_id: lineage.lineage_id, run_id: manifest.run_id,
      plan_revision: lineage.issue_set.preview.plan_revision, plan_sha256: lineage.issue_set.preview.plan_sha256 },
  });
  assertReadyAppliedIssueSet({
    repoRoot: input.repoRoot, lineageId: lineage.lineage_id, runId: manifest.run_id,
    repositoryKey: lineage.repository_key!, preview: issuePreview,
  }, lineage);
  const issueNumbers = mappedIssueNumbers(manifest, orderedWorkItems);
  for (const [index, item] of orderedWorkItems.entries()) {
    const issue = await github.getIssue(issueNumbers[index]!);
    if (!issueOwnershipMatches(manifest, { kind: "work_item", workItemId: item.id }, issue)) {
      throw new Error(`GitHub issue #${issue.number} does not match the authoritative lineage mapping for ${item.id}`);
    }
  }
  const parentIssueNumber = lineage.issue_set.parent_issue_number;
  if (parentIssueNumber !== null) {
    const parent = await github.getIssue(parentIssueNumber);
    if (!issueOwnershipMatches(manifest, { kind: "parent" }, parent)) {
      throw new Error(`GitHub parent issue #${parentIssueNumber} does not match the authoritative lineage mapping`);
    }
  }
  const closingIssueNumbers = expectedClosingIssueNumbers({
    workItems: orderedWorkItems.map((item, index) => ({ id: item.id, issueNumber: issueNumbers[index]! })),
    ...(parentIssueNumber === null ? {} : { parentIssueNumber }),
  });
  const defaultBranch = await github.getDefaultBranch();
  const baseBranch = input.baseBranch ?? defaultBranch;
  if (baseBranch !== defaultBranch) throw new Error(`GitHub delivery base ${baseBranch} is not the repository default branch ${defaultBranch}`);
  const [localHead, observedRemoteHead, lineageCandidates] = await allSettledOrThrow([
    (input.dependencies.localHeadSha ?? resolveLocalHeadSha)(input.worktreePath),
    (input.dependencies.remoteBranchSha ?? resolveRemoteBranchSha)(input.worktreePath, input.branchName, input.remote ?? "origin"),
    github.findPullRequestsByLineage(lineage.lineage_id),
  ]);
  const observed = await allSettledOrThrow(lineageCandidates.map(async (candidate) => {
    const hydrated = deliveryPullRequestObservation(verifiedPullRequestReference(
      await github.getPullRequest!(candidate.number),
      `GitHub pull request #${candidate.number}`,
    ));
    if (hydrated.number !== candidate.number || hydrated.url !== candidate.url) {
      throw new Error(`Hydrated pull request #${candidate.number} does not match its lineage observation`);
    }
    return hydrated;
  }));
  const startingBody = observed[0]?.body ?? input.plan.summary;
  const body = reconcileClosingLinksBlock(startingBody, lineage.lineage_id, manifest.run_id, closingIssueNumbers);
  const planRevision = assertApprovedCurrentPlanRevision(manifest);
  const hasPreviewAuthority = lineage.delivery.state !== "uninitialized";
  if (hasPreviewAuthority && !Object.prototype.hasOwnProperty.call(lineage.delivery, "preview_prior_head_sha")) {
    throw new Error("GitHub delivery preview is missing its persisted prior-head authority");
  }
  const authorizedPriorHead = hasPreviewAuthority
    ? lineage.delivery.preview_prior_head_sha
    : lineage.delivery.head_sha;
  return {
    revision, lineage_id: lineage.lineage_id, run_id: manifest.run_id,
    repository: {
      host: lineage.repository_key!.slice(0, lineage.repository_key!.indexOf("/")),
      name_with_owner: lineage.repository_key!.slice(lineage.repository_key!.indexOf("/") + 1),
    },
    plan_revision: planRevision, plan_sha256: manifest.plan_revisions[String(planRevision)]!.sha256,
    created_at: createdAt, lineage_state: lineage.state,
    authorized_prior_head_sha: authorizedPriorHead,
    branch: { branch_name: input.branchName, head_sha: localHead, observed_head_sha: observedRemoteHead, reason_code: "verified-delivery-head" },
    pull_request: { desired: {
      title: `Task: ${input.plan.summary}`, body, head_ref: input.branchName, head_sha: localHead,
      base_ref: baseBranch, closing_issue_numbers: closingIssueNumbers, reason_code: "verified-delivery",
    }, observations: observed },
  };
}

async function openOrRecoverIntegratedPullRequest(
  input: RunGithubWorkflowInput,
  orderedWorkItems: WorkItem[],
  issueNumbers: number[],
  persistedPullRequestNumber?: number,
  persistedPullRequestUrl?: string,
  parentIssueNumber?: number,
  budget?: ResourceBudgetPort,
): Promise<GitHubPullRequestReference> {
  const adapter = input.dependencies.github;
  if (!adapter.findPullRequestByHead || !adapter.findPullRequestsByLineage) throw new Error("GitHub exhaustive pull-request lookup is required for idempotent delivery");
  if (!adapter.getDefaultBranch || !adapter.getPullRequest || !adapter.updatePullRequestBody || !adapter.getIssue) {
    throw new Error("GitHub pull-request metadata reconciliation is required for issue closure");
  }
  if (persistedPullRequestNumber !== undefined && (!Number.isInteger(persistedPullRequestNumber) || persistedPullRequestNumber < 1)) {
    throw new Error("Persisted pull request number is invalid");
  }
  if (persistedPullRequestUrl !== undefined) {
    verifiedPullRequestReference({ number: persistedPullRequestNumber, url: persistedPullRequestUrl }, "Persisted pull request");
  }
  const manifest = await readManifestV2(input.runDir);
  if (manifest.task_lineage_id === null) throw new Error("GitHub pull-request recovery requires a task lineage");
  const lineage = await withTaskLineageTransaction({
    repoRoot: input.repoRoot, lineageId: manifest.task_lineage_id, operation: (transaction) => transaction.read(),
  });
  const approvedPlanRevision = assertApprovedCurrentPlanRevision(manifest);
  const approvedPlanSha256 = manifest.plan_revisions[String(approvedPlanRevision)]!.sha256;
  if (lineage.active_run_id !== manifest.run_id || lineage.repository_key === null
    || lineage.delivery.state !== "ready" || lineage.delivery.preview?.state !== "applied"
    || lineage.delivery.pull_request_number === null || lineage.delivery.pull_request_url === null
    || lineage.issue_set.state !== "ready" || lineage.issue_set.preview?.state !== "applied") {
    throw new Error("GitHub pull-request recovery requires the authoritative ready issue set and applied lineage delivery");
  }
  if (manifest.github_effects.pull_request_delivery === null
    || !samePreviewReference(manifest.github_effects.pull_request_delivery, lineage.delivery.preview)
    || manifest.github_effects.issue_sync === null
    || !samePreviewReference(manifest.github_effects.issue_sync, lineage.issue_set.preview)) {
    throw new Error("Run manifest does not match the authoritative applied lineage previews");
  }
  const issuePreview = await readVerifiedGithubEffectPreview({ run_dir: input.runDir, reference: lineage.issue_set.preview, expected: {
    phase: "issue_sync", lineage_id: lineage.lineage_id, run_id: manifest.run_id,
    plan_revision: approvedPlanRevision, plan_sha256: approvedPlanSha256,
  } });
  assertReadyAppliedIssueSet({
    repoRoot: input.repoRoot, lineageId: lineage.lineage_id, runId: manifest.run_id,
    repositoryKey: lineage.repository_key, preview: issuePreview,
  }, lineage);
  const deliveryPreview = await readVerifiedGithubEffectPreview({ run_dir: input.runDir, reference: lineage.delivery.preview, expected: {
    phase: "pull_request_delivery", lineage_id: lineage.lineage_id, run_id: manifest.run_id,
    plan_revision: approvedPlanRevision, plan_sha256: approvedPlanSha256,
  } });
  if (deliveryPreview.effects.length !== 2 || deliveryPreview.effects[0]?.target.kind !== "branch"
    || deliveryPreview.effects[1]?.target.kind !== "pull_request") {
    throw new Error("Applied delivery preview has an invalid effect schema");
  }
  const repositorySeparator = lineage.repository_key.indexOf("/");
  const repositoryHost = lineage.repository_key.slice(0, repositorySeparator);
  const repositoryName = lineage.repository_key.slice(repositorySeparator + 1);
  const authoritativeRepository = { host: repositoryHost, name_with_owner: repositoryName };
  if (repositorySeparator < 1 || !isDeepStrictEqual(issuePreview.repository, authoritativeRepository)
    || !isDeepStrictEqual(deliveryPreview.repository, authoritativeRepository)) {
    throw new Error("Applied GitHub previews do not match the authoritative lineage repository");
  }
  const authoritativeWorkMap = lineage.issue_set.work_item_issue_map;
  const authoritativeWorkNumbers = Object.values(authoritativeWorkMap).sort((left, right) => left - right);
  if (!isDeepStrictEqual(manifest.work_item_issue_map, authoritativeWorkMap)
    || !isDeepStrictEqual(manifest.github_ids.work_item_issue_map, authoritativeWorkMap)
    || !isDeepStrictEqual([...manifest.issue_numbers].sort((left, right) => left - right), authoritativeWorkNumbers)
    || !isDeepStrictEqual([...manifest.github_ids.issue_numbers].sort((left, right) => left - right), authoritativeWorkNumbers)
    || manifest.github_ids.parent_issue_number !== lineage.issue_set.parent_issue_number) {
    throw new Error("Run manifest issue mappings do not match the authoritative lineage issue set");
  }
  const authoritativeIssueNumbers = orderedWorkItems.map((item) => authoritativeWorkMap[item.id]);
  if (authoritativeIssueNumbers.some((number) => !Number.isSafeInteger(number) || (number ?? 0) < 1)
    || Object.keys(authoritativeWorkMap).sort().join("\n") !== orderedWorkItems.map((item) => item.id).sort().join("\n")
    || !isDeepStrictEqual(issueNumbers, authoritativeIssueNumbers)
    || (parentIssueNumber ?? null) !== lineage.issue_set.parent_issue_number) {
    throw new Error("Requested issue closing set does not match the authoritative lineage mappings");
  }
  const defaultBranch = await adapter.getDefaultBranch();
  const baseBranch = input.baseBranch ?? defaultBranch;
  if (baseBranch !== defaultBranch) {
    throw new Error(`GitHub delivery base ${baseBranch} is not the repository default branch ${defaultBranch}; closing links would be ignored`);
  }
  const workItems: IntegratedWorkItemReference[] = orderedWorkItems.map((item, index) => ({ id: item.id, issueNumber: authoritativeIssueNumbers[index]! }));
  const expectedIssueNumbers = expectedClosingIssueNumbers({
    workItems, ...(lineage.issue_set.parent_issue_number === null ? {} : { parentIssueNumber: lineage.issue_set.parent_issue_number }),
  });
  for (const workItem of workItems) {
    const issue = await adapter.getIssue(workItem.issueNumber);
    if (!issueOwnershipMatches(manifest, { kind: "work_item", workItemId: workItem.id }, issue)) {
      throw new Error(`GitHub issue #${workItem.issueNumber} does not have the exact durable ownership markers for ${workItem.id}`);
    }
  }
  if (parentIssueNumber !== undefined) {
    const parent = await adapter.getIssue(parentIssueNumber);
    if (!issueOwnershipMatches(manifest, { kind: "parent" }, parent)) {
      throw new Error(`GitHub parent issue #${parentIssueNumber} does not have the exact durable ownership markers`);
    }
  }
  const integrated = integratedWorkItem(input.plan);
  const pending = manifest.work_item_progress[integrated.id];
  const expectedCommitMessage = `work-item: ${integrated.id.trim()} ${integrated.title.trim()}`;
  const headTransition = lineage.delivery.head_transition;
  const pendingCommitIntentIsAuthorized = pending?.push_commit_pending === true
    && isGitObjectId(pending.push_local_before_sha)
    && isGitObjectId(pending.push_remote_before_sha)
    && pending.push_commit_parent_sha === pending.push_local_before_sha
    && isGitObjectId(pending.push_commit_tree_sha)
    && pending.push_commit_message === expectedCommitMessage
    && (lineage.delivery.head_sha === pending.push_local_before_sha
      || (headTransition?.run_id === manifest.run_id
        && headTransition.work_item_id === integrated.id
        && headTransition.previous_head_sha === pending.push_local_before_sha
        && headTransition.authorized_head_sha === lineage.delivery.head_sha));
  const pendingPushIsAuthorized = pending?.push_pending === true
    && isGitObjectId(pending.push_expected_sha)
    && pending.push_expected_sha === lineage.delivery.head_sha
    && isGitObjectId(pending.push_remote_before_sha)
    && pending.push_commit_parent_sha === pending.push_local_before_sha
    && isGitObjectId(pending.push_commit_tree_sha)
    && pending.push_commit_message === expectedCommitMessage
    && headTransition?.run_id === manifest.run_id
    && headTransition.work_item_id === integrated.id
    && headTransition.previous_head_sha === pending.push_commit_parent_sha
    && headTransition.authorized_head_sha === pending.push_expected_sha;
  const pendingHeadTransitionIsAuthorized = isGitObjectId(pending?.push_expected_sha)
    && pending.push_expected_sha === lineage.delivery.head_sha
    && isGitObjectId(pending.push_remote_before_sha)
    && pending.push_commit_parent_sha === pending.push_local_before_sha
    && isGitObjectId(pending.push_commit_tree_sha)
    && pending.push_commit_message === expectedCommitMessage
    && headTransition?.run_id === manifest.run_id
    && headTransition.work_item_id === integrated.id
    && headTransition.previous_head_sha === pending.push_commit_parent_sha
    && headTransition.authorized_head_sha === pending.push_expected_sha;
  const candidateHead = await (input.dependencies.localHeadSha ?? resolveLocalHeadSha)(input.worktreePath);
  let pendingCommitCandidateIsAuthorized = false;
  if (pendingCommitIntentIsAuthorized && candidateHead !== pending!.push_local_before_sha) {
    const committed = await (input.dependencies.localCommitProvenance ?? resolveLocalCommitProvenance)(
      input.worktreePath,
      candidateHead,
    );
    pendingCommitCandidateIsAuthorized = committed.sha === candidateHead
      && committed.parent_shas.length === 1
      && committed.parent_shas[0] === pending.push_commit_parent_sha
      && committed.tree_sha === pending.push_commit_tree_sha
      && committed.message === pending.push_commit_message;
  }
  const reconcileMetadata = async (reference: GitHubPullRequestReference): Promise<GitHubPullRequestReference> => {
    const reconciled = await reconcileGitHubPullRequestLinks({
      runDir: input.runDir,
      runId: manifest.run_id,
      github: adapter,
      pullRequestNumber: reference.number,
      expectedIssueNumbers,
      defaultBranch,
      expectedUrl: reference.url,
      expectedHeadRef: input.branchName,
      expectedHeadSha: candidateHead,
      apply: true,
      budget,
    });
    const current = verifiedPullRequestReference(reconciled.reference, "GitHub pull-request lookup");
    if (current.url !== reference.url) throw new Error(`Pull request #${reference.number} URL changed during delivery reconciliation`);
    if (!reconciled.report.identity_verified) throw new Error(`Pull request #${reference.number} is not the exact current candidate branch and commit`);
    if (current.state !== "OPEN") throw new Error(`Pull request #${reference.number} is not open during delivery reconciliation`);
    if (current.base_ref !== defaultBranch) throw new Error(`Pull request #${reference.number} does not target default branch ${defaultBranch}`);
    const missing = reconciled.report.missing_closing_issue_numbers;
    if (missing.length > 0) {
      throw new Error(`Pull request #${current.number} is missing parsed closing references for ${missing.map((number) => `#${number}`).join(", ")}`);
    }
    return current;
  };
  const existingByHead = await adapter.findPullRequestByHead(input.branchName);
  if (existingByHead) {
    const recoveredByHead = verifiedPullRequestReference(existingByHead, "GitHub pull-request lookup");
    if (persistedPullRequestNumber !== undefined && recoveredByHead.number !== persistedPullRequestNumber) {
      throw new Error(`Recovered pull request #${recoveredByHead.number} does not match persisted pull request #${persistedPullRequestNumber}`);
    }
    if (persistedPullRequestUrl !== undefined && recoveredByHead.url !== persistedPullRequestUrl) {
      throw new Error(`Recovered pull request URL does not match persisted pull request #${persistedPullRequestNumber}`);
    }
  }
  if (lineage.delivery.branch_name !== input.branchName
    || (lineage.delivery.head_sha !== candidateHead
      && !(pendingCommitIntentIsAuthorized && candidateHead === pending!.push_local_before_sha)
      && !pendingCommitCandidateIsAuthorized)) {
    if (pendingCommitIntentIsAuthorized && lineage.delivery.branch_name === input.branchName) {
      throw new Error("Recovered post-PR commit provenance does not match the durable workflow intent");
    }
    throw new Error("Local delivery branch and head do not match the authoritative lineage delivery");
  }
  const lineageMatches = await adapter.findPullRequestsByLineage(manifest.task_lineage_id);
  if (lineageMatches.length > 1) throw new Error(`Expected at most one pull request for the active task lineage, found ${lineageMatches.length}`);
  if (lineageMatches.length === 1) {
    const candidate = verifiedPullRequestReference(lineageMatches[0]!, "GitHub lineage pull-request lookup");
    const recovered = deliveryPullRequestObservation(verifiedPullRequestReference(
      await adapter.getPullRequest(candidate.number),
      `GitHub pull request #${candidate.number}`,
    ));
    const repositoryUrl = new URL(recovered.url);
    const expectedPath = `/${repositoryName}/pull/${recovered.number}`.toLowerCase();
    const canonicalBody = reconcileClosingLinksBlock(recovered.body, lineage.lineage_id, manifest.run_id, expectedIssueNumbers);
    const sortedExpected = [...expectedIssueNumbers].sort((left, right) => left - right);
    const sortedObserved = [...recovered.closing_issue_numbers].sort((left, right) => left - right);
    const recoveredHeadIsAuthorized = recovered.head_sha === lineage.delivery.head_sha
    || ((pendingCommitIntentIsAuthorized || pendingPushIsAuthorized || pendingHeadTransitionIsAuthorized)
        && recovered.head_sha === pending!.push_remote_before_sha);
    if (candidate.number !== recovered.number || candidate.url !== recovered.url
      || recovered.number !== lineage.delivery.pull_request_number || recovered.url !== lineage.delivery.pull_request_url
      || persistedPullRequestNumber !== recovered.number || persistedPullRequestUrl !== recovered.url
      || repositoryUrl.protocol !== "https:" || repositoryUrl.hostname.toLowerCase() !== repositoryHost
      || repositoryUrl.pathname.toLowerCase() !== expectedPath || repositoryUrl.search !== "" || repositoryUrl.hash !== ""
      || recovered.title !== `Task: ${input.plan.summary}` || recovered.body !== canonicalBody
      || recovered.head_ref !== lineage.delivery.branch_name || !recoveredHeadIsAuthorized
      || recovered.base_ref !== defaultBranch || recovered.state !== "OPEN"
      || new Set(sortedObserved).size !== sortedObserved.length || !isDeepStrictEqual(sortedObserved, sortedExpected)) {
      throw new Error("Recovered pull request does not match the complete authoritative lineage delivery identity");
    }
    return recovered;
  }
  if (persistedPullRequestNumber !== undefined || persistedPullRequestUrl !== undefined
    || lineage.delivery.pull_request_number !== null || lineage.delivery.pull_request_url !== null) {
    throw new Error("Authoritative pull request identity is persisted but cannot be recovered");
  }
  if (existingByHead) {
    throw new Error(`Existing pull request #${existingByHead.number} for ${input.branchName} is not owned by the active task lineage`);
  }
  if (!adapter.openIntegratedPullRequest) throw new Error("GitHub adapter does not support integrated pull requests");
  const request: OpenIntegratedPullRequestInput = {
    lineageId: lineage.lineage_id,
    runId: manifest.run_id,
    title: `Task: ${input.plan.summary}`,
    summary: input.plan.summary,
    head: input.branchName,
    headSha: candidateHead,
    base: baseBranch,
    workItems,
    parentIssueNumber,
  };
  const openIntegratedPullRequest = adapter.openIntegratedPullRequest;
  const claim = await claimExternalEffect(
    budget,
    `github-open-pr:${input.branchName}:${candidateHead}`,
  );
  try {
    const opened = normalizePullRequestReference(await openIntegratedPullRequest(request));
    await completeExternalEffect(budget, claim);
    return reconcileMetadata(opened);
  } catch (error) {
    await completeExternalEffect(budget, claim, "failed");
    throw error;
  }
}

async function recordRuntimeBlocker(
  runDir: string,
  blocker: string,
  workItemId: string,
  attempts: number,
  blockerCode: HandsBlockerCode = "operational_blocker",
): Promise<RunManifestV2> {
  const manifest = await readManifestV2(runDir);
  const statusTimestamp = new Date().toISOString();
  return updateManifestV2(runDir, {
    delivery_state: "blocked",
    last_blocker: blocker,
    current_work_item_id: workItemId,
    work_item_progress: {
      ...manifest.work_item_progress,
      [workItemId]: {
        ...(manifest.work_item_progress[workItemId] ?? {}),
        status: "blocked",
        attempts,
        blocker,
        blocker_code: blockerCode,
        github_status_transition_at: statusTimestamp,
      },
    },
  });
}

function resolvePersistedPullRequestMapping(
  manifest: RunManifestV2,
  pullRequest: GitHubPullRequestReference,
): { pullRequestNumber: number; pullRequestUrl: string } {
  const mapping = requirePersistedPullRequestMapping(manifest);
  const pullRequestNumber = mapping.number;
  if (pullRequestNumber !== pullRequest.number) {
    throw new Error(`Persisted integrated pull_request_number ${pullRequestNumber} conflicts with reconciled pull request ${pullRequest.number}`);
  }
  return { pullRequestNumber, pullRequestUrl: mapping.url };
}

function manifestCarriesPostPrDeliveryIdentity(manifest: RunManifestV2): boolean {
  const integratedPr = manifest.work_item_progress.integrated?.integrated_pr;
  return ["final_verification", "verifier_review", "fixing", "delivery", "complete"].includes(manifest.stage)
    && manifest.github_effects.pull_request_delivery !== null
    && (
      typeof integratedPr === "number"
      || manifest.pull_request_numbers.length > 0
      || manifest.github_ids.pull_request_numbers.length > 0
      || Object.keys(manifest.github_ids.pull_request_urls).length > 0
    );
}

function requirePersistedPullRequestMappingBeforeRemoteSynchronization(manifest: RunManifestV2): void {
  if (manifest.remote_synchronization_path == null && manifestCarriesPostPrDeliveryIdentity(manifest)) {
    requirePersistedPullRequestMapping(manifest);
  }
}

async function requireIntegratedCommitBeforeRemoteSynchronization(
  input: Pick<RunGithubWorkflowInput, "worktreePath" | "dependencies">,
  manifest: RunManifestV2,
): Promise<void> {
  if (manifest.remote_synchronization_path != null || !manifestCarriesPostPrDeliveryIdentity(manifest)) return;
  const integratedProgress = manifest.work_item_progress.integrated;
  if (integratedProgress?.push_pending === true || integratedProgress?.push_commit_pending === true) return;
  const integratedCommitSha = integratedProgress?.commit_sha;
  if (typeof integratedCommitSha !== "string" || integratedCommitSha.trim() === "") {
    throw new Error("Remote synchronization requires work_item_progress.integrated.commit_sha");
  }
  const localHeadSha = (await (input.dependencies.localHeadSha ?? resolveLocalHeadSha)(input.worktreePath)).toLowerCase();
  if (localHeadSha !== integratedCommitSha.toLowerCase()) {
    throw new Error(`Local HEAD ${localHeadSha} differs from work_item_progress.integrated.commit_sha ${integratedCommitSha.toLowerCase()}`);
  }
}

async function recordRuntimeRemoteSynchronization(
  input: RunGithubWorkflowInput,
  pullRequest: GitHubPullRequestReference,
): Promise<RecordRemoteSynchronizationResult> {
  const manifest = await readManifestV2(input.runDir);
  const { pullRequestNumber, pullRequestUrl } = resolvePersistedPullRequestMapping(manifest, pullRequest);
  const integratedCommitSha = manifest.work_item_progress.integrated?.commit_sha;
  if (typeof integratedCommitSha !== "string" || integratedCommitSha.trim() === "") {
    throw new Error("Remote synchronization requires work_item_progress.integrated.commit_sha");
  }
  const resolveLocal = input.dependencies.localHeadSha ?? resolveLocalHeadSha;
  const localHeadSha = (await resolveLocal(input.worktreePath)).toLowerCase();
  if (localHeadSha !== integratedCommitSha.toLowerCase()) {
    throw new Error(`Local HEAD ${localHeadSha} differs from work_item_progress.integrated.commit_sha ${integratedCommitSha.toLowerCase()}`);
  }

  const synchronize = input.dependencies.recordRemoteSynchronization ?? recordRemoteSynchronization;
  const result = await synchronize({
    runDir: input.runDir,
    repoRoot: manifest.repo_root,
    branchName: input.branchName,
    remoteName: input.remote ?? "origin",
    pullRequestNumber,
    expectedPullRequestUrl: pullRequestUrl,
    github: input.dependencies.github,
    resolveLocalSha: async () => localHeadSha,
    resolveRemoteSha: async () => (input.dependencies.remoteBranchSha ?? resolveRemoteBranchSha)(
      input.worktreePath,
      input.branchName,
      input.remote ?? "origin",
    ),
  });
  const synchronizedManifest = await readManifestV2(input.runDir);
  if (synchronizedManifest.remote_synchronization_path !== result.artifactPath) {
    throw new Error(`Remote synchronization did not persist remote_synchronization_path=${result.artifactPath}`);
  }
  if (!result.evidence.synchronized) {
    throw new Error([
      "Remote synchronization failed",
      `local_candidate_sha=${result.evidence.local_candidate_sha ?? "null"}`,
      `mapped_pr_sha=${result.evidence.mapped_pr_sha ?? "null"}`,
      `remote_head_sha=${result.evidence.remote_head_sha ?? "null"}`,
      `evidence_path=${result.artifactPath}`,
    ].join("; "));
  }
  return result;
}

async function recordReplanAwaitingState(
  runDir: string,
  blocker: string,
  workItemId: string,
  attempts: number,
  replanPatchPath: string,
  targetWorkItemId = workItemId,
): Promise<RunManifestV2> {
  const manifest = await readManifestV2(runDir);
  const sourceProgress = {
    ...(manifest.work_item_progress[workItemId] ?? {}),
    status: "blocked" as const,
    attempts,
    blocker,
    replan_patch_path: replanPatchPath,
    replan_target_work_item_id: targetWorkItemId,
  };
  const targetProgress = targetWorkItemId === workItemId
    ? sourceProgress
    : {
        ...(manifest.work_item_progress[targetWorkItemId] ?? { status: "pending" as const, attempts: 0 }),
        replan_patch_path: replanPatchPath,
        replan_source_work_item_id: workItemId,
      };
  return updateManifestV2(runDir, {
    delivery_state: "blocked",
    last_blocker: blocker,
    current_work_item_id: workItemId,
    work_item_progress: {
      ...manifest.work_item_progress,
      [workItemId]: sourceProgress,
      [targetWorkItemId]: targetProgress,
    },
  });
}

function deterministicReplanPreparationBlocker(error: unknown): string | null {
  if (error instanceof NoMaterialReplanError) {
    return `Replan preparation blocked: ${error.diagnostics[0]}`;
  }
  if (error instanceof InvalidReplanCandidateError) {
    return `Replan preparation blocked: ${error.diagnostics.join(" | ")}`;
  }
  if (error instanceof Error && error.name === "ZodError") {
    return `Replan preparation blocked: ${error.message}`;
  }
  return null;
}

function invalidVerifierContractReplanBlocker(error: unknown): string | null {
  if (!(error instanceof InvalidReplanCandidateError) || error.diagnostics.length === 0) return null;
  const verifierLinkageDiagnostics = error.diagnostics.every((diagnostic) =>
    diagnostic.includes("references unknown command")
    || diagnostic.includes("is not linked to an exact approved verification command"));
  return verifierLinkageDiagnostics
    ? `invalid_verifier_contract: ${error.diagnostics.join(" | ")}`
    : null;
}

function controllerOwnedOutputReplanBlocker(error: unknown): string | null {
  if (!(error instanceof InvalidReplanCandidateError) || error.diagnostics.length === 0) return null;
  return error.diagnostics.every((diagnostic) =>
    /^Generated (?:artifact|browser) output verification\/.+ is outside proposed .+ scope$/.test(diagnostic))
    ? `invalid_verifier_contract: ${error.diagnostics.join(" | ")}`
    : null;
}

async function persistDeterministicReplanPreparationBlocker(
  runDir: string,
  error: unknown,
): Promise<{ manifest: RunManifestV2; blocker: string } | null> {
  const blocker = deterministicReplanPreparationBlocker(error);
  if (blocker === null) return null;
  let manifest = await readManifestV2(runDir);
  const verifierContractBlocker = invalidVerifierContractReplanBlocker(error);
  const controllerOutputBlocker = controllerOwnedOutputReplanBlocker(error);
  const workItemId = manifest.current_work_item_id;
  if (
    verifierContractBlocker !== null
    && manifest.stage === "replanning"
    && workItemId !== null
  ) {
    try {
      manifest = await retryVerifierReviewAfterInvalidReplanContract(runDir, {
        workItemId,
        blocker: verifierContractBlocker,
      });
      return { manifest, blocker: verifierContractBlocker };
    } catch (retryError) {
      if (!(retryError instanceof VerifierContractRetryAlreadyUsedError)) throw retryError;
    }
  }
  if (
    controllerOutputBlocker !== null
    && manifest.stage === "replanning"
    && workItemId !== null
  ) {
    try {
      manifest = await retryVerifierReviewAfterInvalidReplanContract(runDir, {
        workItemId,
        blocker: controllerOutputBlocker,
        retryKind: "controller_output",
      });
      return { manifest, blocker: controllerOutputBlocker };
    } catch (retryError) {
      if (!(retryError instanceof VerifierContractRetryAlreadyUsedError)) throw retryError;
    }
  }
  if (manifest.stage === "awaiting_plan_approval" || manifest.stage === "verifier_review") {
    manifest = await transitionRun(runDir, "replanning", {
      actor: "runtime",
      payload: { blocker, reason: "replan_candidate_not_approval_ready" },
    });
  }
  manifest = await updateManifestV2(runDir, {
    delivery_state: "blocked",
    last_blocker: blocker,
  });
  return { manifest, blocker };
}

class ConcurrentPlanPromotionHandoff extends Error {
  constructor(readonly result: LocalWorkflowResult) {
    super(result.blocker);
    this.name = "ConcurrentPlanPromotionHandoff";
  }
}

function replanPreparationHooks(input: RunLocalWorkflowInput) {
  return {
    afterPlanWrite: async () => input.dependencies?.afterCheckpoint?.("after_replan_plan_write"),
    afterRequestWrite: async () => input.dependencies?.afterCheckpoint?.("after_replan_request_write"),
    beforePendingReconciliation: async () => input.dependencies?.afterCheckpoint?.("before_replan_pending_reconciliation"),
    afterBoundaryCommit: async () => input.dependencies?.afterCheckpoint?.("after_replan_boundary_commit"),
  };
}

type RuntimeReplanBoundary = {
  state: "pending" | "approved" | "blocked";
  manifest: RunManifestV2;
  blocker: string | null;
  coordinates?: PreparedReplanApprovalCoordinates;
};

async function prepareRuntimeReplanApprovalBoundary(
  input: RunLocalWorkflowInput,
  targetWorkItemId: string,
): Promise<RuntimeReplanBoundary> {
  try {
    const prepared = await prepareReplanApprovalBoundary({
      runDir: input.runDir,
      targetWorkItemId,
      ...replanPreparationHooks(input),
    });
    return { state: prepared.state, manifest: prepared.manifest, blocker: null, coordinates: prepared.coordinates };
  } catch (error) {
    const blocked = await persistDeterministicReplanPreparationBlocker(input.runDir, error);
    if (blocked !== null) return { state: "blocked", ...blocked };
    throw error;
  }
}

async function finalizeRuntimePreparedReplan(
  input: RunLocalWorkflowInput,
  prepared: RuntimeReplanBoundary,
): Promise<RuntimeReplanBoundary> {
  if (prepared.state === "blocked") {
    await input.dependencies?.afterCheckpoint?.("after_replan_awaiting_transition");
    return prepared;
  }
  const coordinates = prepared.coordinates;
  if (!coordinates) throw new Error("Prepared runtime replan is missing exact approval coordinates");
  if (prepared.state === "approved") {
    const revision = prepared.manifest.approved_revision ?? prepared.manifest.approved_plan_revision;
    throw new ConcurrentPlanPromotionHandoff(concurrentPromotionApprovalStop(prepared.manifest, revision!).result);
  }
  let checkpointError: unknown = null;
  try {
    await input.dependencies?.afterCheckpoint?.("after_replan_awaiting_transition");
  } catch (error) {
    checkpointError = error;
  }
  const reconciled = await reconcilePreparedPlanApprovalBoundary({
    runDir: input.runDir,
    ...coordinates,
  });
  if (reconciled.state === "approved") {
    throw new ConcurrentPlanPromotionHandoff(
      concurrentPromotionApprovalStop(reconciled.manifest, coordinates.proposedRevision).result,
    );
  }
  return {
    state: "pending",
    manifest: reconciled.manifest,
    blocker: checkpointError === null ? prepared.blocker : coordinates.canonicalBlocker,
    coordinates,
  };
}

async function reconcileRuntimeReplanApprovalBoundary(
  input: RunLocalWorkflowInput,
): Promise<RuntimeReplanBoundary | null> {
  try {
    const prepared = await reconcilePendingReplanApprovalBoundary({
      runDir: input.runDir,
      ...replanPreparationHooks(input),
    });
    return prepared === null ? null : {
      state: prepared.state,
      manifest: prepared.manifest,
      blocker: null,
      coordinates: prepared.coordinates,
    };
  } catch (error) {
    const blocked = await persistDeterministicReplanPreparationBlocker(input.runDir, error);
    if (blocked !== null) return { state: "blocked", ...blocked };
    throw error;
  }
}

function persistedInvalidVerifierContractReplanBlocker(
  manifest: RunManifestV2,
): { blocker: string; retryKind: "linkage" | "controller_output" } | null {
  const prefix = "Replan preparation blocked: ";
  if (manifest.stage !== "replanning" || !manifest.last_blocker?.startsWith(prefix)) return null;
  const diagnostics = manifest.last_blocker.slice(prefix.length).split(" | ");
  if (diagnostics.length === 0) return null;
  if (diagnostics.every((diagnostic) =>
    diagnostic.includes("references unknown command")
    || diagnostic.includes("is not linked to an exact approved verification command"))) {
    return { blocker: `invalid_verifier_contract: ${diagnostics.join(" | ")}`, retryKind: "linkage" };
  }
  if (diagnostics.every((diagnostic) =>
    /^Generated (?:artifact|browser) output verification\/.+ is outside proposed .+ scope$/.test(diagnostic))) {
    return { blocker: `invalid_verifier_contract: ${diagnostics.join(" | ")}`, retryKind: "controller_output" };
  }
  return null;
}

export async function recoverPersistedInvalidVerifierContractReplan(
  runDir: string,
): Promise<RunManifestV2> {
  const manifest = await readManifestV2(runDir);
  const retry = persistedInvalidVerifierContractReplanBlocker(manifest);
  const workItemId = manifest.current_work_item_id;
  if (retry === null || workItemId === null) return manifest;
  try {
    return await retryVerifierReviewAfterInvalidReplanContract(runDir, {
      workItemId,
      blocker: retry.blocker,
      retryKind: retry.retryKind,
    });
  } catch (error) {
    if (error instanceof VerifierContractRetryAlreadyUsedError) return manifest;
    throw error;
  }
}

async function preBootstrapApprovalStop(
  input: RunLocalWorkflowInput,
): Promise<{ result: LocalWorkflowResult; initial: boolean; concurrentPromotion: boolean } | null> {
  let manifest = await readManifestV2(input.runDir);
  manifest = await recoverPersistedInvalidVerifierContractReplan(input.runDir);
  const currentRevision = manifest.current_revision ?? manifest.current_plan_revision;
  const approvedRevision = manifest.approved_revision ?? manifest.approved_plan_revision;
  const initialApprovalPending = manifest.pending_plan_approval?.base_revision === null
    || (manifest.run_configuration_sha256 === null
      && manifest.stage === "awaiting_plan_approval"
      && manifest.pending_plan_approval === null
      && currentRevision !== null
      && approvedRevision !== currentRevision);
  if (initialApprovalPending) {
    const proposedRevision = manifest.pending_plan_approval?.proposed_revision ?? currentRevision!;
    return {
      initial: true,
      concurrentPromotion: false,
      result: {
        status: "human_action_required",
        manifest,
        orderedWorkItems: [],
        implementationResults: {},
        verification: {},
        reviews: {},
        blocker: manifest.last_blocker
          ?? `Plan revision ${proposedRevision} requires explicit approval`,
      },
    };
  }
  const reconciled = await reconcileRuntimeReplanApprovalBoundary(input);
  if (reconciled !== null) manifest = reconciled.manifest;
  if (reconciled?.state === "approved") {
    const revision = manifest.approved_revision ?? manifest.approved_plan_revision;
    return concurrentPromotionApprovalStop(manifest, revision!);
  }
  if (reconciled?.state === "pending" && reconciled.coordinates) {
    try {
      await input.dependencies?.afterCheckpoint?.("after_replan_pending_reconciliation");
    } catch {
      // The exact CAS below decides whether this remains a canonical pending stop or a handoff.
    }
    const finalized = await reconcilePreparedPlanApprovalBoundary({
      runDir: input.runDir,
      ...reconciled.coordinates,
    });
    manifest = finalized.manifest;
    if (finalized.state === "approved") {
      return concurrentPromotionApprovalStop(manifest, reconciled.coordinates.proposedRevision);
    }
  }
  const pendingReplanTarget = resolvePendingReplanTarget(manifest);
  if (pendingReplanTarget === null && (reconciled === null || reconciled.blocker === null)) return null;
  const blocker = reconciled?.blocker
    ?? manifest.last_blocker
    ?? `Replan patch for ${manifest.current_work_item_id} requires explicit approval`;
  return {
    initial: false,
    concurrentPromotion: false,
    result: {
      status: "human_action_required",
      manifest,
      orderedWorkItems: [],
      implementationResults: {},
      verification: {},
      reviews: {},
      blocker,
      ...(reconciled?.state === "pending" && reconciled.coordinates
        ? { pendingReplanBoundary: reconciled.coordinates }
        : {}),
    },
  };
}

function concurrentPromotionApprovalStop(
  manifest: RunManifestV2,
  revision: number,
): { result: LocalWorkflowResult; initial: false; concurrentPromotion: true } {
  return {
    initial: false,
    concurrentPromotion: true,
    result: {
      status: "human_action_required",
      manifest,
      orderedWorkItems: [],
      implementationResults: {},
      verification: {},
      reviews: {},
      blocker: `Plan revision ${revision} was approved concurrently; retry resume to continue with the promoted revision`,
    },
  };
}

async function postErrorApprovalStop(input: RunLocalWorkflowInput, error: unknown) {
  if (/Execution lease token does not match the active run owner/.test(errorMessage(error))) {
    const manifest = await readManifestV2(input.runDir);
    const revision = manifest.approved_revision ?? manifest.approved_plan_revision;
    if (manifest.pending_plan_approval === null
      && revision !== null
      && (manifest.current_revision ?? manifest.current_plan_revision) === revision
      && (manifest.approved_revision ?? manifest.approved_plan_revision) === revision
      && manifest.stage === "worktree_setup") {
      return concurrentPromotionApprovalStop(manifest, revision);
    }
  }
  if (error instanceof ReplanBoundaryPostCommitError) {
    const reconciled = await reconcilePreparedPlanApprovalBoundary({
      runDir: input.runDir,
      baseRevision: error.baseRevision,
      proposedRevision: error.proposedRevision,
      pending: error.pending,
      canonicalBlocker: error.canonicalBlocker,
    });
    if (reconciled.state === "approved") {
      return concurrentPromotionApprovalStop(reconciled.manifest, error.proposedRevision);
    }
    try {
      await input.dependencies?.afterCheckpoint?.("after_replan_post_error_reconciliation");
    } catch {
      // The exact CAS below decides whether this remains a canonical pending stop or a handoff.
    }
    const finalized = await reconcilePreparedPlanApprovalBoundary({
      runDir: input.runDir,
      baseRevision: error.baseRevision,
      proposedRevision: error.proposedRevision,
      pending: error.pending,
      canonicalBlocker: error.canonicalBlocker,
    });
    if (finalized.state === "approved") {
      return concurrentPromotionApprovalStop(finalized.manifest, error.proposedRevision);
    }
    return {
      initial: false,
      concurrentPromotion: false,
      result: {
        status: "human_action_required" as const,
        manifest: finalized.manifest,
        orderedWorkItems: [],
        implementationResults: {},
        verification: {},
        reviews: {},
        blocker: error.canonicalBlocker,
        pendingReplanBoundary: {
          baseRevision: error.baseRevision,
          proposedRevision: error.proposedRevision,
          pending: error.pending,
          canonicalBlocker: error.canonicalBlocker,
        },
      },
    };
  }
  const manifest = await readManifestV2(input.runDir);
  if (manifest.pending_plan_approval === null) return null;
  return preBootstrapApprovalStop(input);
}

/**
 * Execute the approved Brain plan in local mode. This function deliberately
 * imports no GitHub adapter: local delivery is confined to the worktree and
 * commits are made only after an independent Verifier approval.
 */
async function runLocalWorkflowUnsafe(input: RunLocalWorkflowInput): Promise<LocalWorkflowResult> {
  const githubDelivery = (input as RunLocalWorkflowInput & { githubDelivery?: RunGithubWorkflowInput }).githubDelivery;
  if (input.intake.mode !== "local" && !githubDelivery) throw new Error("Local runtime requires intake.mode=local");
  if (!input.worktreePath.trim()) throw new Error("A local worktree path is required");
  const config = input.config ?? defaultConfig();
  const maxHandsFixAttempts = config.retry_policy.max_hands_fix_attempts;

  assertPlanReady(input.plan, {
    mode: githubDelivery ? "github" : "local",
    repoRoot: input.worktreePath,
  });
  const orderedWorkItems = topologicallySortWorkItems(input.plan.work_items);
  let manifest = await readManifestV2(input.runDir);
  const issueResolution = createWorkItemIssueResolutionContext(manifest, input.plan.work_items);
  const budget = manifest.workflow_protocol === "bounded-context-v1" && manifest.resource_budget_policy !== undefined
    ? await openResourceBudget(input.runDir)
    : undefined;
  const budgetPlanRevision = (): number | undefined =>
    budget === undefined ? undefined : manifest.approved_revision ?? manifest.approved_plan_revision ?? undefined;
  const approvedRevision = manifest.approved_revision ?? manifest.approved_plan_revision;
  const recordedCriteria = approvedRevision === null || approvedRevision === undefined
    ? undefined
    : manifest.plan_revisions[String(approvedRevision)]?.acceptance_criteria;
  const approvedCriteria = await requiresPinnedRuntimeAuthority(input.runDir, manifest)
    ? derivePlanAcceptanceCriteria(input.plan)
    : recordedCriteria ?? derivePlanAcceptanceCriteria(input.plan);
  const hasRevisionLedger = (manifest.current_revision ?? manifest.current_plan_revision) !== null;
  if (manifest.review_policy_snapshot !== undefined || hasRevisionLedger) {
    assertApprovedCurrentPlanRevision(manifest);
  }
  const expectedMutationKind = (attempt: number): HandsSelfReviewReport["mutation_kind"] =>
    attempt === 1
      ? "initial"
      : manifest.review_policy_snapshot !== undefined
        ? "normal_fix"
        : attempt > maxHandsFixAttempts + 1 ? "quality_recovery" : "normal_fix";
  const implementationAttempt = (progress: WorkItemProgress | undefined): number => {
    const match = typeof progress?.implementation_path === "string"
      ? progress.implementation_path.match(/\/attempt-(\d+)\.json$/)
      : null;
    return match ? Number(match[1]) : Math.max(1, progress?.attempts ?? 1);
  };
  const expectedTerminalMutationKind = (): HandsSelfReviewReport["mutation_kind"] => "normal_fix";
  const terminalFixLimitBlocker = (scope: string, fixesUsed: number): string =>
    `${scope} reached the configured limit of ${maxHandsFixAttempts} actual Hands ${maxHandsFixAttempts === 1 ? "fix" : "fixes"} (${fixesUsed} used)`;
  const qualityGatePolicy = manifest.quality_gate_policy ?? undefined;
  const handsBackupPolicy = manifest.hands_backup_policy ?? undefined;
  const resumableStages = new Set<RunManifestV2["stage"]>([
    "worktree_setup",
    "implementing",
    "verifying",
    "verifier_review",
    "fixing",
    "replanning",
    "awaiting_plan_approval",
    "final_verification",
  ]);
  if (!resumableStages.has(manifest.stage)) {
    throw new Error(`Local runtime cannot resume from stage ${manifest.stage}`);
  }
  const loadZeroMutationEffectCycle = async (
    workItemId: string,
    progress: WorkItemProgress | undefined,
  ): Promise<ReviewCycleState | null> => {
    if (
      !progress
      || typeof progress.review_revision !== "number"
      || typeof progress.queue_path !== "string"
    ) return null;
    let cycle: ReviewCycleState;
    try {
      cycle = reviewCycleStateSchema.parse(await readRunArtifact<unknown>(
        input.runDir,
        reviewDecisionPath(workItemId, progress.review_revision),
      ));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    if (
      cycle.work_item_id !== workItemId
      || cycle.review_revision !== progress.review_revision
      || !isReviewEffectAction(cycle.decision.action)
    ) return null;
    const completed = await loadCompletedReviewEffect({
      run_dir: input.runDir,
      cycle,
      owner: `runtime:work-item:${workItemId}`,
    });
    if (!completed) return null;
    const result = parseFixEffectResult(completed.effect_result);
    return result.kind === "still_blocking" && result.successful_hands_fixes === 0
      ? cycle
      : null;
  };
  if (manifest.stage === "replanning" || manifest.stage === "awaiting_plan_approval") {
    const workItemId = manifest.current_work_item_id;
    const progress = workItemId ? manifest.work_item_progress[workItemId] : undefined;
    const convergence = workItemId ? manifest.convergence_reports?.[workItemId] : undefined;
    const pendingTarget = manifest.stage === "awaiting_plan_approval"
      ? resolvePendingReplanTarget(manifest)
      : null;
    const zeroMutationCycle = manifest.stage === "replanning"
      ? await loadZeroMutationEffectCycle(workItemId ?? "", progress)
      : null;
    const hasReplanProvenance = Boolean(
      workItemId
      && progress
      && ((typeof progress.review_cycle_path === "string"
        && typeof progress.review_effect_id === "string"
        && typeof progress.review_revision === "number"
        && convergence?.recommended_action === "create_replan")
        || zeroMutationCycle !== null)
      && (manifest.stage !== "awaiting_plan_approval" || pendingTarget !== null),
    );
    if (!hasReplanProvenance) {
      throw new Error(`Local runtime stage ${manifest.stage} lacks resumable create-replan provenance`);
    }
  }
  const hands = input.dependencies?.hands ?? (async (handsInput: HandsWorkItemInput) => {
    const result = await runHandsWorkItem(handsInput);
    return {
      ...result,
      reportPath: `implementation/${handsInput.workItem.id.replace(/[^a-zA-Z0-9._-]/g, "_")}/attempt-${handsInput.attempt}.json`,
    };
  });
  const handsFixPacket = input.dependencies?.handsFixPacket ?? runHandsFixPacket;
  const verifier = input.dependencies?.verifier ?? verifyWorkItem;
  const verificationRunner = input.dependencies?.verification ?? runVerification;
  const selfReview = input.dependencies?.selfReview ?? runHandsSelfReview;
  const actionVerifier = input.dependencies?.actionVerifier ?? verifyReviewerAction;
  const packetVerifier = input.dependencies?.packetVerifier ?? verifyReviewFixPacket;
  const legacyDiff = input.dependencies?.diff;
  const scopedDiffCollector = input.dependencies?.collectScopedWorktreeDiff ?? collectScopedWorktreeDiff;
  const scopedDiffFromBase = async (workItem: WorkItem, baseCommit: string): Promise<string> => {
    const scoped = await scopedDiffCollector({
      repoRoot: input.worktreePath,
      baseCommit,
      workItem,
    });
    const patch = boundedGeneratedLockfileDiff(scoped.patch);
    return patch.length > 0 ? patch : "# No local diff was detected.\n";
  };
  const currentDiff = async (workItem: WorkItem): Promise<string> => {
    if (legacyDiff) return legacyDiff(input.worktreePath);
    const baseCommit = await (input.dependencies?.localHeadSha ?? resolveLocalHeadSha)(input.worktreePath);
    return scopedDiffFromBase(workItem, baseCommit);
  };
  const commit = input.dependencies?.commit ?? commitWorkItem;
  const gitSnapshot = input.dependencies?.gitSnapshot ?? getGitSnapshot;
  const changedFiles = input.dependencies?.changedFiles ?? getWorktreeChangedFiles;
  const committedRecoveryEvidence = input.dependencies?.collectCommittedRecoveryEvidence ?? collectCommittedRecoveryEvidence;
  const worktreeBlobEvidence = input.dependencies?.collectWorktreeBlobEvidence ?? collectWorktreeBlobEvidence;
  const restoreTrackedFiles = input.dependencies?.restoreTrackedFiles ?? restoreTrackedWorktreeFiles;
  const worktreeHasChanges = input.dependencies?.hasWorktreeChanges
    ?? (async (worktreePath: string) => (await gitSnapshot(worktreePath)).status.trim().length > 0);
  const reserveCandidateRecheck = async (
    phase: VerifierEvidenceIndexPhase,
    reviewedAttempt: number,
    commitSha: string,
  ): Promise<void> => {
    const current = await readManifestV2(input.runDir);
    if (current.workflow_protocol !== "bounded-context-v1") return;
    const progress = current.work_item_progress.integrated;
    const attempt = reviewedAttempt + 1;
    const existing = progress?.candidate_recheck;
    if (existing) {
      if (
        existing.phase === phase
        && existing.attempt === attempt
        && existing.commit_sha === commitSha
      ) return;
      if (!(existing.state === "reviewed" && existing.attempt === reviewedAttempt)) {
        throw new Error("Candidate recheck reservation conflicts with durable progress");
      }
    }
    const nextProgress: WorkItemProgress = {
      ...(progress ?? { status: "in_progress", attempts: reviewedAttempt }),
      status: "in_progress" as const,
      attempts: attempt,
      commit_sha: commitSha,
      verification_path: undefined,
      verification_scope: undefined,
      verification_work_item_id: undefined,
      verification_issue_number: undefined,
      review_cycle_path: undefined,
      review_effect_id: undefined,
      candidate_recheck: {
        phase,
        attempt,
        commit_sha: commitSha,
        state: "reserved" as const,
      },
      ...(phase === "post_pr" ? { delivery_phase: "post_pr" as const, push_pending: false } : {}),
    };
    if (phase === "final_integrated") {
      nextProgress.delivery_phase = undefined;
      nextProgress.integrated_pr = undefined;
      nextProgress.push_pending = undefined;
      nextProgress.push_commit_pending = undefined;
      nextProgress.push_expected_sha = undefined;
      nextProgress.push_remote_before_sha = undefined;
      nextProgress.push_local_before_sha = undefined;
      nextProgress.push_commit_parent_sha = undefined;
      nextProgress.push_commit_tree_sha = undefined;
      nextProgress.push_commit_message = undefined;
      nextProgress.push_commit_review_cycle_path = undefined;
      nextProgress.push_commit_review_effect_id = undefined;
    }
    manifest = await setProgress(input.runDir, "integrated", {
      ...nextProgress,
    });
  };
  const gateTerminalVerifier = async (
    phase: VerifierEvidenceIndexPhase,
    attempt: number,
    integratedVerificationPath: string,
  ): Promise<void> => {
    await captureBoundedWorkItemContext(integratedWorkItem(input.plan), attempt);
    const current = await readManifestV2(input.runDir);
    if (current.workflow_protocol !== "bounded-context-v1") return;
    const candidateCommit = await (input.dependencies?.localHeadSha ?? resolveLocalHeadSha)(input.worktreePath);
    const integrated = current.work_item_progress.integrated;
    manifest = await setProgress(input.runDir, "integrated", {
      ...(integrated ?? { status: "in_progress", attempts: attempt }),
      status: "in_progress",
      attempts: attempt,
      verification_path: integratedVerificationPath,
      commit_sha: candidateCommit,
    });
    const workItemSummaryRefs: ArtifactRefV1[] = orderedWorkItems.map((workItem) => {
      const progress = manifest.work_item_progress[workItem.id];
      if (
        progress?.status !== "complete"
        || typeof progress.summary_path !== "string"
        || typeof progress.summary_sha256 !== "string"
      ) throw new Error(`Terminal Verifier evidence index requires the current summary for ${workItem.id}`);
      return { path: progress.summary_path, sha256: progress.summary_sha256 };
    });
    const integratedVerificationRef = await artifactReference(input.runDir, integratedVerificationPath);
    const indexRef = await buildVerifierEvidenceIndex({
      runDir: input.runDir,
      phase,
      attempt,
      candidateCommit,
      workItemSummaryRefs,
      integratedVerificationRef,
    });
    await loadEvidenceIndex(input.runDir, indexRef, { phase, attempt, candidateCommit });
    const beforeIndexPointer = await readManifestV2(input.runDir);
    if (
      beforeIndexPointer.final_verifier_index_path === indexRef.path
      && beforeIndexPointer.final_verifier_index_sha256 !== null
      && beforeIndexPointer.final_verifier_index_sha256 !== indexRef.sha256
    ) throw new Error("Final-Verifier evidence index changed after its durable invocation reference was recorded");
    manifest = await updateManifestV2(input.runDir, {
      final_verifier_index_path: indexRef.path,
      final_verifier_index_sha256: indexRef.sha256,
    });
    const afterIndex = manifest.work_item_progress.integrated;
    if (
      afterIndex?.candidate_recheck?.phase === phase
      && afterIndex.candidate_recheck.attempt === attempt
      && afterIndex.candidate_recheck.commit_sha === candidateCommit
    ) {
      manifest = await setProgress(input.runDir, "integrated", {
        ...afterIndex,
        candidate_recheck: {
          ...afterIndex.candidate_recheck,
          state: "indexed",
          verification_path: integratedVerificationPath,
          index_path: indexRef.path,
        },
      });
    }
  };
  const validateTerminalVerifierAfterReview = async (
    phase: VerifierEvidenceIndexPhase,
    attempt: number,
    reviewPath: string,
  ): Promise<string | null> => {
    const current = await readManifestV2(input.runDir);
    if (current.workflow_protocol !== "bounded-context-v1") return null;
    const progress = current.work_item_progress.integrated;
    if (typeof progress?.commit_sha !== "string") {
      throw new Error("Post-review evidence-index validation requires a candidate commit");
    }
    const indexPath = verifierEvidenceIndexPath(phase, attempt);
    if (current.final_verifier_index_path !== indexPath || typeof current.final_verifier_index_sha256 !== "string") {
      throw new Error(`Post-review evidence-index pointer does not match the terminal attempt: expected ${indexPath}, found ${current.final_verifier_index_path ?? "null"}`);
    }
    const index = await loadEvidenceIndex(
      input.runDir,
      { path: indexPath, sha256: current.final_verifier_index_sha256 },
      {
        phase,
        attempt,
        candidateCommit: progress.commit_sha,
        findingValidation: {
          mode: "post_review",
          finalReviewRef: await artifactReference(input.runDir, reviewPath),
        },
      },
    );
    return index.candidate_commit;
  };
  const captureBoundedWorkItemContext = async (
    item: WorkItem,
    attempt: number,
  ): Promise<{ planRevision: number; baseCommit: string } | null> => {
    if (manifest.workflow_protocol !== "bounded-context-v1") return null;
    const current = await readManifestV2(input.runDir);
    const planRevision = assertApprovedCurrentPlanRevision(current);
    const progress = current.work_item_progress[item.id] ?? {
      status: "in_progress" as const,
      attempts: Math.max(0, attempt - 1),
    };
    if (progress.context_plan_revision === planRevision && typeof progress.context_base_commit === "string") {
      return { planRevision, baseCommit: progress.context_base_commit };
    }
    const baseCommit = await (input.dependencies?.localHeadSha ?? resolveLocalHeadSha)(input.worktreePath);
    manifest = await setProgress(input.runDir, item.id, {
      ...progress,
      context_base_commit: baseCommit,
      context_plan_revision: planRevision,
      ...(progress.context_plan_revision !== planRevision
        ? { commit_sha: undefined, summary_path: undefined, summary_sha256: undefined }
        : {}),
    });
    return { planRevision, baseCommit };
  };
  const boundedHandsInvocationContext = async (
    item: WorkItem,
    attempt: number,
    attemptKind: HandsAttemptKind,
    diffScope: WorkItem = item,
  ): Promise<Pick<HandsWorkItemInput, "contextRef" | "context" | "contextPlanRevision"> | null> => {
    const authority = await captureBoundedWorkItemContext(item, attempt);
    if (authority === null) return null;
    const path = handsContextPath(item.id, authority.planRevision, attempt, attemptKind);
    let contextRef: ArtifactRefV1;
    try {
      contextRef = await artifactReference(input.runDir, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      contextRef = await buildHandsContext({
        runDir: input.runDir,
        workItemId: item.id,
        planRevision: authority.planRevision,
        attempt,
        attemptKind,
        workItem: item,
        diff: await scopedDiffFromBase(diffScope, authority.baseCommit),
      });
    }
    return {
      contextRef,
      context: await loadRoleContext(input.runDir, contextRef, "hands"),
      contextPlanRevision: authority.planRevision,
    };
  };
  const boundedVerifierInvocationContext = async (
    item: WorkItem,
    phase: "work_item" | VerifierEvidenceIndexPhase,
    attempt: number,
  ): Promise<{ contextRef: ArtifactRefV1; context: import("../core/context-contracts.js").VerifierContextV1; phase: "work_item" | VerifierEvidenceIndexPhase; final: boolean } | null> => {
    const authority = await captureBoundedWorkItemContext(item, attempt);
    if (authority === null) return null;
    const snapshot = await scopedDiffCollector({
      repoRoot: input.worktreePath,
      baseCommit: authority.baseCommit,
      workItem: item,
    });
    const boundedSnapshot = {
      ...snapshot,
      patch: boundedVerifierDiff(snapshot.patch),
    };
    const current = await readManifestV2(input.runDir);
    const evidenceIndexRef = phase === "work_item"
      ? null
      : (() => {
          if (
            current.final_verifier_index_path !== verifierEvidenceIndexPath(phase, attempt)
            || typeof current.final_verifier_index_sha256 !== "string"
          ) throw new Error(`${phase} Verifier context requires its current immutable evidence index`);
          return { path: current.final_verifier_index_path, sha256: current.final_verifier_index_sha256 };
        })();
    let contextRef: ArtifactRefV1 | null = null;
    let context: import("../core/context-contracts.js").VerifierContextV1 | null = null;
    for (let resume = 1; resume <= 100; resume += 1) {
      const path = verifierContextPath(item.id, phase, attempt, resume);
      try {
        contextRef = await artifactReference(input.runDir, path);
        context = await loadRoleContext(input.runDir, contextRef, "verifier");
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          if (errorMessage(error) === "Verifier active findings are not current finding authority") continue;
          throw error;
        }
        contextRef = await buildVerifierContext({
          runDir: input.runDir,
          workItemId: item.id,
          phase,
          attempt,
          acceptanceContract: item.acceptance,
          changedFiles: boundedSnapshot.changed_files,
          diff: boundedSnapshot.patch,
          evidenceIndexRef,
          resume,
        });
        context = await loadRoleContext(input.runDir, contextRef, "verifier");
        break;
      }
    }
    if (!contextRef || !context) throw new Error(`Verifier context resume limit reached for ${item.id} attempt ${attempt}`);
    const scopeAuthority = await loadVerifierScopeAuthority({
      runDir: input.runDir,
      workItemId: item.id,
      phase,
      attempt,
      evidenceIndexRef: context.evidence_index_ref,
    });
    assertVerifierScopeSnapshot(context, boundedSnapshot, scopeAuthority);
    return {
      contextRef,
      context,
      phase,
      final: phase !== "work_item",
    };
  };
  const validateBoundedDirectCompletionCommit = async (validationInput: {
    workItem: WorkItem;
    baseCommit: string;
    commitSha: string;
  }): Promise<void> => {
    if (!isGitObjectId(validationInput.baseCommit)) {
      throw new Error(`Bounded direct work-item base commit is invalid: ${validationInput.workItem.id}`);
    }
    const currentHead = await (input.dependencies?.localHeadSha ?? resolveLocalHeadSha)(input.worktreePath);
    if (validationInput.commitSha === "no-op") {
      if (currentHead !== validationInput.baseCommit) {
        throw new Error(`Bounded direct no-op no longer matches captured HEAD: ${validationInput.workItem.id}`);
      }
      return;
    }
    if (!isGitObjectId(validationInput.commitSha) || currentHead !== validationInput.commitSha) {
      throw new Error(`Bounded direct work-item commit does not match current HEAD: ${validationInput.workItem.id}`);
    }
    const committed = await (input.dependencies?.localCommitProvenance ?? resolveLocalCommitProvenance)(input.worktreePath, currentHead);
    if (
      committed.sha !== validationInput.commitSha
      || committed.parent_shas.length !== 1
      || committed.parent_shas[0] !== validationInput.baseCommit
      || committed.message !== `work-item: ${validationInput.workItem.id.trim()} ${validationInput.workItem.title.trim()}`
    ) throw new Error(`Bounded direct work-item commit provenance is invalid: ${validationInput.workItem.id}`);
  };
  const recoverBoundedDirectCommit = async (recoveryInput: {
    workItem: WorkItem;
    attempt: number;
    implementationPath: string;
    verificationPath: string;
    reviewPath: string;
  }): Promise<string | null> => {
    const current = await readManifestV2(input.runDir);
    if (current.workflow_protocol !== "bounded-context-v1") return null;
    const progress = current.work_item_progress[recoveryInput.workItem.id];
    const commitSha = progress?.commit_sha;
    if (commitSha === undefined) return null;
    if (
      (commitSha !== "no-op" && !isGitObjectId(commitSha))
      || (progress?.status !== "in_progress" && progress?.status !== "blocked")
      || progress.attempts !== recoveryInput.attempt
      || progress.context_plan_revision !== assertApprovedCurrentPlanRevision(current)
      || !isGitObjectId(progress.context_base_commit)
      || progress.implementation_path !== recoveryInput.implementationPath
      || progress.verification_path !== recoveryInput.verificationPath
      || progress.review_path !== recoveryInput.reviewPath
      || progress.review_revision !== recoveryInput.attempt
      || progress.review_cycle_path !== undefined
      || progress.review_effect_id !== undefined
    ) throw new Error(`Persisted direct work-item commit authority is stale or incomplete: ${recoveryInput.workItem.id}`);
    await assertRecoveryWorktreeClean(input.worktreePath, recoveryInput.workItem.id);
    await validateBoundedDirectCompletionCommit({
      workItem: recoveryInput.workItem,
      baseCommit: progress.context_base_commit,
      commitSha,
    });
    return commitSha;
  };
  const persistBoundedCompletionSummary = async (summaryInput: {
    workItem: WorkItem;
    attempt: number;
    commitSha: string;
    completionBasis: WorkItemCompletionBasis;
    policyDecisionPath: string | null;
    findingIds: string[];
  }): Promise<ArtifactRefV1 | null> => {
    const current = await readManifestV2(input.runDir);
    if (current.workflow_protocol !== "bounded-context-v1" || summaryInput.workItem.id === "integrated") return null;
    const progress = current.work_item_progress[summaryInput.workItem.id];
    const planRevision = progress?.context_plan_revision;
    const baseCommit = progress?.context_base_commit;
    const reviewRevision = progress?.review_revision;
    const implementationPath = progress?.implementation_path;
    const verificationPath = progress?.verification_path;
    const reviewPath = progress?.review_path;
    if (
      !planRevision
      || typeof baseCommit !== "string"
      || !reviewRevision
      || typeof implementationPath !== "string"
      || typeof verificationPath !== "string"
      || typeof reviewPath !== "string"
    ) throw new Error(`Bounded work-item completion authority is incomplete: ${summaryInput.workItem.id}`);
    const planRecord = current.plan_revisions[String(planRevision)];
    if (!planRecord) throw new Error(`Bounded work-item plan revision is missing: ${planRevision}`);
    const expected = {
      runId: current.run_id,
      workItemId: summaryInput.workItem.id,
      planRevision,
      planSha256: planRecord.sha256,
      attempt: summaryInput.attempt,
      baseCommit,
      commitSha: summaryInput.commitSha,
    };
    const expectedPath = workItemSummaryPath(summaryInput.workItem.id, planRevision, summaryInput.attempt);
    let existing: ArtifactRefV1 | null = null;
    try {
      existing = await artifactReference(input.runDir, expectedPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (existing) {
      await loadWorkItemSummary(input.runDir, existing, expected);
      return existing;
    }
    const summary = await persistWorkItemSummary({
      runDir: input.runDir,
      workItem: summaryInput.workItem,
      planRevision,
      planSha256: planRecord.sha256,
      attempt: summaryInput.attempt,
      baseCommit,
      commitSha: summaryInput.commitSha,
      completionBasis: summaryInput.completionBasis,
      implementationRef: await artifactReference(input.runDir, implementationPath),
      verificationRef: await artifactReference(input.runDir, verificationPath),
      reviewRef: await artifactReference(input.runDir, reviewPath),
      policyDecisionRef: summaryInput.policyDecisionPath === null
        ? null
        : await artifactReference(input.runDir, summaryInput.policyDecisionPath),
      findingRevision: { reviewRevision, findingIds: summaryInput.findingIds },
      createdAt: new Date().toISOString(),
    });
    await loadWorkItemSummary(input.runDir, summary, expected);
    return summary;
  };
  const assertCurrentImplementationScope = async (
    workItem: WorkItem,
    implementation: ImplementationResult,
  ): Promise<void> => {
    assertImplementationScope(workItem, implementation, await changedFiles(input.worktreePath));
  };
  const checkedHands = async (handsInput: HandsWorkItemInput): Promise<HandsWorkItemResult> => {
    const result = await hands(handsInput);
    const allowed = new Set(handsInput.workItem.completion_contract.expected_changed_files);
    const reported = new Set(result.implementation.changed_files);
    const inheritedRejectedPaths = (await changedFiles(input.worktreePath))
      .filter((path) => !allowed.has(path) && !reported.has(path));
    await restoreTrackedFiles(input.worktreePath, inheritedRejectedPaths);
    return result;
  };
  const implementationResults: Record<string, ImplementationResult> = {};
  const evidenceByItem: Record<string, VerificationEvidence> = {};
  const reviews: Record<string, VerifierReview[]> = {};
  const publishWorkItemStatus = async (
    item: WorkItem,
    index: number,
    state: "implementing" | "verifying" | "reviewing" | "fixing" | "blocked" | "complete",
    attempt: number,
    evidence?: VerificationEvidence,
    review?: VerifierReview,
    materialEvents?: Parameters<typeof syncRuntimeWorkItemStatus>[0]["materialEvents"],
  ): Promise<void> => {
    if (!githubDelivery) return;
    const issueNumber = issueResolution.resolve(item.id);
    if (!issueNumber) return;
    await syncRuntimeWorkItemStatus({
      runDir: input.runDir,
      github: githubDelivery.dependencies.github,
      manifest,
      workItem: item,
      workItemIndex: index + 1,
      workItemTotal: orderedWorkItems.length,
      issueNumber,
      state,
      attempt: Math.max(1, attempt),
      transitionAt: typeof manifest.work_item_progress[item.id]?.github_status_transition_at === "string"
        ? manifest.work_item_progress[item.id]!.github_status_transition_at as string
        : manifest.updated_at,
      evidence,
      review,
      materialEvents,
      budget,
    });
  };
  const publishOperationalBlocker = async (
    item: WorkItem,
    index: number,
    attempt: number,
    blockerClass: NonNullable<Parameters<typeof syncRuntimeWorkItemStatus>[0]["materialEvents"]>[number]["blockerClass"],
    evidence?: VerificationEvidence,
    review?: VerifierReview,
  ): Promise<void> => {
    await publishWorkItemStatus(item, index, "blocked", attempt, evidence, review, [{ kind: "operational_blocker", attempt, blockerClass }]);
  };

  type RetryableRuntimeOperation = {
    workItemId: string;
    scopeId: string;
    operation: string;
    attempt: number;
    classification: {
      failure_class: "invocation_failure" | "model_failure" | "operational_blocker" | "test_infrastructure_blocker";
      blocker_code: string;
    };
    findingIds?: string[];
    requestedEffect?: "fix" | "quality_recovery" | "retry_operation";
    requestedEffectReason?: string;
    allowDifferentAuthorizedSubject?: boolean;
  };
  type RuntimeRecoveryContext = {
    gate: OperationalRecoveryGateResult;
    progress: Awaited<ReturnType<typeof buildRecoveryProgressSubject>> | null;
    ownedEvidenceRefs: {
      implementation_path: string | null;
      verification_path: string | null;
      review_path: string | null;
    };
  };
  const runtimeRecoveryContext = async (
    recoveryInput: RetryableRuntimeOperation,
    pathOverrides: Partial<RuntimeRecoveryContext["ownedEvidenceRefs"]> = {},
  ): Promise<Omit<RuntimeRecoveryContext, "gate">> => {
    const current = await readManifestV2(input.runDir);
    const itemProgress = current.work_item_progress[recoveryInput.workItemId];
    const implementationPath = pathOverrides.implementation_path ?? (typeof itemProgress?.implementation_path === "string"
      ? runArtifactRelativePath(input.runDir, itemProgress.implementation_path)
      : undefined);
    const verificationPath = pathOverrides.verification_path ?? (typeof itemProgress?.verification_path === "string"
      ? itemProgress.verification_path
      : undefined);
    const reviewPath = pathOverrides.review_path ?? (typeof itemProgress?.review_path === "string"
      ? itemProgress.review_path
      : undefined);
    const progress = await buildRecoveryProgressSubject({
      runDir: input.runDir,
      manifest: current,
      workItemId: recoveryInput.workItemId,
      findingIds: recoveryInput.findingIds ?? [],
      ...(implementationPath === undefined ? {} : { implementationPath }),
      ...(verificationPath === undefined ? {} : { verificationPath }),
      ...(reviewPath === undefined ? {} : { reviewPath }),
      reviewRevision: itemProgress?.review_revision,
    });
    return {
      progress,
      ownedEvidenceRefs: {
        implementation_path: implementationPath ?? null,
        verification_path: verificationPath ?? null,
        review_path: reviewPath ?? null,
      },
    };
  };
  const gateRetryableRuntimeOperation = async (
    recoveryInput: RetryableRuntimeOperation,
  ): Promise<RuntimeRecoveryContext> => {
    const current = await readManifestV2(input.runDir);
    if (!Object.prototype.hasOwnProperty.call(current.recovery.scopes, recoveryInput.scopeId)) {
      return {
        gate: {
          mode: "ordinary",
          authorization_id: null,
          effect_attempt_id: null,
          manifest: current,
        },
        progress: null,
        ownedEvidenceRefs: {
          implementation_path: null,
          verification_path: null,
          review_path: null,
        },
      };
    }
    const context = await runtimeRecoveryContext(recoveryInput);
    const gate = await gateOperationalRecoveryAttempt({
      runDir: input.runDir,
      scopeId: recoveryInput.scopeId,
      operation: recoveryInput.operation,
      requestedEffect: recoveryInput.requestedEffect ?? "retry_operation",
      requestedEffectReason: recoveryInput.requestedEffectReason ?? "retryable_runtime_failure",
      findingIds: recoveryInput.findingIds ?? [],
      classification: recoveryInput.classification,
      progress: context.progress!,
      allowDifferentAuthorizedSubject: recoveryInput.allowDifferentAuthorizedSubject,
    });
    return { gate, ...context };
  };
  const recordAuthorizedRuntimeSuccess = async (
    recoveryInput: RetryableRuntimeOperation,
    context: RuntimeRecoveryContext,
    pathOverrides: Partial<RuntimeRecoveryContext["ownedEvidenceRefs"]>,
  ): Promise<void> => {
    if (context.gate.mode !== "authorized_attempt") return;
    const resulting = await runtimeRecoveryContext(recoveryInput, pathOverrides);
    await recordAuthorizedRecoveryOutcome({
      runDir: input.runDir,
      scopeId: recoveryInput.scopeId,
      operation: recoveryInput.operation,
      authorizationId: context.gate.authorization_id,
      effectAttemptId: context.gate.effect_attempt_id,
      outcome: {
        kind: "success",
        requestedEffect: recoveryInput.requestedEffect ?? "retry_operation",
        requestedEffectReason: recoveryInput.requestedEffectReason ?? "retryable_runtime_failure",
        findingIds: recoveryInput.findingIds ?? [],
        classification: recoveryInput.classification,
      },
      progress: resulting.progress!,
      ownedEvidenceRefs: resulting.ownedEvidenceRefs,
    });
  };
  const recordRetryableRuntimeBlocker = async (recoveryInput: RetryableRuntimeOperation & {
    blocker: string;
    error: unknown;
    recoveryContext?: RuntimeRecoveryContext;
  }): Promise<{ blocker: string; manifest: RunManifestV2 }> => {
    const context = recoveryInput.recoveryContext ?? {
      gate: {
        mode: "ordinary" as const,
        authorization_id: null,
        effect_attempt_id: null,
        manifest: await readManifestV2(input.runDir),
      },
      ...await runtimeRecoveryContext(recoveryInput),
    };
    const outcomeContext = await runtimeRecoveryContext(recoveryInput);
    if (context.gate.mode === "authorized_attempt") {
      const recovery = await recordAuthorizedRecoveryOutcome({
        runDir: input.runDir,
        scopeId: recoveryInput.scopeId,
        operation: recoveryInput.operation,
        authorizationId: context.gate.authorization_id,
        effectAttemptId: context.gate.effect_attempt_id,
        outcome: {
          kind: "failure",
          requestedEffect: recoveryInput.requestedEffect ?? "retry_operation",
          requestedEffectReason: recoveryInput.requestedEffectReason ?? "retryable_runtime_failure",
          findingIds: recoveryInput.findingIds ?? [],
          classification: recoveryInput.classification,
          error: recoveryInput.error,
        },
        progress: outcomeContext.progress!,
        ownedEvidenceRefs: outcomeContext.ownedEvidenceRefs,
      });
      const blocker = recovery.guard_action === "diagnostic_stop"
        ? `Recovery diagnostic stop after repeated ${recoveryInput.operation}: ${recoveryInput.blocker}`
        : recovery.guard_action === "exhausted_stop"
          ? `Recovery exhausted after ${recoveryInput.operation}: ${recoveryInput.blocker}`
          : recoveryInput.blocker;
      return {
        blocker,
        manifest: await recordRuntimeBlocker(
          input.runDir,
          blocker,
          recoveryInput.workItemId,
          recoveryInput.attempt,
          recoveryInput.classification.failure_class === "test_infrastructure_blocker"
            ? "test_infrastructure_blocker"
            : "operational_blocker",
        ),
      };
    }
    const current = await readManifestV2(input.runDir);
    const nextSequence = (current.recovery.scopes[recoveryInput.scopeId]?.head_sequence ?? 0) + 1;
    const effectAttemptId = `runtime-attempt:${createHash("sha256").update(JSON.stringify({
      version: 1,
      run_id: current.run_id,
      scope_id: recoveryInput.scopeId,
      operation: recoveryInput.operation,
      sequence: nextSequence,
    })).digest("hex")}`;
    const recovery = await recordOperationalRecovery({
      runDir: input.runDir,
      scopeId: recoveryInput.scopeId,
      operation: recoveryInput.operation,
      effectAttemptId,
      requestedEffect: recoveryInput.requestedEffect ?? "retry_operation",
      requestedEffectReason: recoveryInput.requestedEffectReason ?? "retryable_runtime_failure",
      findingIds: recoveryInput.findingIds ?? [],
      classification: recoveryInput.classification,
      error: recoveryInput.error,
      progress: outcomeContext.progress!,
      ownedEvidenceRefs: outcomeContext.ownedEvidenceRefs,
    });
    const blocker = recovery.guard_action === "diagnostic_stop"
      ? `Recovery diagnostic stop after repeated ${recoveryInput.operation}: ${recoveryInput.blocker}`
      : recovery.guard_action === "exhausted_stop"
        ? `Recovery exhausted after ${recoveryInput.operation}: ${recoveryInput.blocker}`
        : recoveryInput.blocker;
    return {
      blocker,
      manifest: await recordRuntimeBlocker(
        input.runDir,
        blocker,
        recoveryInput.workItemId,
        recoveryInput.attempt,
        recoveryInput.classification.failure_class === "test_infrastructure_blocker"
          ? "test_infrastructure_blocker"
          : "operational_blocker",
      ),
    };
  };

  const legacyOperationalBlockerCode = (review: VerifierReview): HandsBlockerCode | null => {
    const failureClass = review.failure_class;
    if (failureClass === "test_infrastructure_blocker") return "test_infrastructure_blocker";
    if (review.decision === "blocked" || failureClass === "operational_blocker") return "operational_blocker";
    return null;
  };

  const recordLegacyOperationalReview = async (
    item: WorkItem,
    review: VerifierReview,
    attempt: number,
  ): Promise<{ blocker: string; manifest: RunManifestV2 } | null> => {
    const blockerCode = legacyOperationalBlockerCode(review);
    if (!blockerCode) return null;
    const blocker = review.blocker?.trim() || `Verifier blocked work item ${item.id}: ${blockerCode}`;
    const recovered = await recordRetryableRuntimeBlocker({
      workItemId: item.id,
      scopeId: `work-item:${item.id}`,
      operation: "verifier-operational-review",
      attempt,
      blocker,
      classification: {
        failure_class: blockerCode === "test_infrastructure_blocker"
          ? "test_infrastructure_blocker"
          : "operational_blocker",
        blocker_code: blockerCode,
      },
      error: new Error(blocker),
      findingIds: review.findings.map((finding) => `${finding.file}:${finding.acceptance_criterion}`),
    });
    const progress = recovered.manifest.work_item_progress[item.id]!;
    const updated = await updateManifestV2(input.runDir, {
      work_item_progress: {
        ...recovered.manifest.work_item_progress,
        [item.id]: { ...progress, blocker_code: blockerCode },
      },
    });
    return { blocker: recovered.blocker, manifest: updated };
  };

  const invokeWithHandsFallback = async <T>(
    item: WorkItem,
    attempt: number,
    claimTransferCapable: boolean,
    invoke: (profile: HandsSelfReviewInput["profile"] | undefined, resumeBlockedClaim: boolean) => Promise<T>,
    resumePrimaryBlockedClaim = false,
  ): Promise<T> => {
    const activeProfile = manifest.active_hands_profile === "backup" ? handsBackupPolicy?.profile : undefined;
    const completeClaimTransfer = async (): Promise<void> => {
      if (!claimTransferCapable) return;
      const current = await readManifestV2(input.runDir);
      const currentProgress = current.work_item_progress[item.id] ?? { status: "in_progress" as const, attempts: attempt };
      manifest = await setProgress(input.runDir, item.id, {
        ...currentProgress,
        self_review_claim_owner: "backup",
        backup_claim_transfer_pending: false,
      });
    };
    if (manifest.active_hands_profile === "backup") {
      if (!activeProfile || !manifest.hands_backup_catalog) {
        throw new Error("Active Hands backup route is missing its snapshotted profile or catalog validation");
      }
      const currentProgress = (await readManifestV2(input.runDir)).work_item_progress[item.id];
      const transferPending = claimTransferCapable && currentProgress?.backup_claim_transfer_pending === true;
      const result = await invoke({ ...activeProfile }, transferPending);
      if (transferPending) await completeClaimTransfer();
      return result;
    }
    try {
      return await invoke(undefined, resumePrimaryBlockedClaim);
    } catch (error) {
      const usageLimited = error instanceof CodexInvocationError && error.result !== undefined && classifyCodexFailure(error.result) === "primary_usage_limit";
      const backup = handsBackupPolicy;
      if (!usageLimited || !backup?.fallback_on_primary_usage_limit) throw error;
      const catalog = input.dependencies?.modelCatalog
        ? await input.dependencies.modelCatalog()
        : (await readModelCatalog({ command: config.codex.command, cwd: input.worktreePath, timeoutMs: config.codex.timeout_seconds * 1000 })).snapshot;
      const selection = validateCatalogProfile(catalog, backup.profile, "Hands backup");
      manifest = await updateManifestV2(input.runDir, {
        active_hands_profile: "backup",
        backup_activation_reason: "primary_usage_limit",
        hands_backup_catalog: selection,
      });
      if (claimTransferCapable) {
        const currentProgress = manifest.work_item_progress[item.id] ?? { status: "in_progress" as const, attempts: attempt };
        manifest = await setProgress(input.runDir, item.id, {
          ...currentProgress,
          self_review_claim_owner: "primary",
          backup_claim_transfer_pending: true,
        });
      }
      await appendRunEvent(input.runDir, { actor: "runtime", stage: "fixing", type: "hands_backup_activated", payload: { work_item_id: item.id, attempt, reason: "primary_usage_limit" } });
      const result = await invoke(backup.profile, claimTransferCapable);
      await completeClaimTransfer();
      return result;
    }
  };

  const invokeHands = async (item: WorkItem, attempt: number, kind: HandsAttemptKind, findings: VerifierReview["findings"]): Promise<HandsWorkItemResult> => {
    const boundedContext = await boundedHandsInvocationContext(item, attempt, kind);
    const itemIndex = item.id === "integrated" ? orderedWorkItems.length + 1 : orderedWorkItems.findIndex((candidate) => candidate.id === item.id) + 1;
    const itemTotal = item.id === "integrated" ? orderedWorkItems.length + 1 : orderedWorkItems.length;
    await input.progress?.emit({
      code: kind === "initial" ? "work_item_implementation" : "work_item_fix",
      source: "hands",
      workItem: { index: itemIndex, total: itemTotal, attempt, final: item.id === "integrated" },
    });
    const invoke = (profile: NonNullable<typeof handsBackupPolicy>["profile"] | undefined) => checkedHands({
      runDir: input.runDir,
      worktreePath: input.worktreePath,
      workItem: item,
      intake: input.intake,
      codex: input.codex,
      attempt,
      ...(boundedContext ?? { findings }),
      profile,
      profileKind: profile ? "backup" : "primary",
      attemptKind: kind,
      progress: input.progress,
      workItemIndex: itemIndex,
      workItemTotal: itemTotal,
      budget,
    });
    const result = kind === "quality_recovery"
      ? await (async () => {
          const backup = handsBackupPolicy;
          if (!backup || manifest.active_hands_profile !== "primary") {
            throw new Error("Policy quality recovery requires one configured backup while the primary route is active");
          }
          return invoke(backup.profile);
        })()
      : await invokeWithHandsFallback(item, attempt, false, invoke);
    try {
      return { ...result, reportPath: runArtifactRelativePath(input.runDir, result.reportPath) };
    } catch (error) {
      throw new NonRetryableHandsResultError(errorMessage(error));
    }
  };

  const validateLegacyQualityRecoveryReport = async (item: WorkItem, reportPath: string): Promise<void> => {
    const backup = handsBackupPolicy;
    if (!backup) throw new Error("Legacy quality-recovery report has no snapshotted backup profile");
    const raw = await readRunArtifact<Record<string, unknown>>(input.runDir, reportPath);
    if (
      raw.work_item_id !== item.id
      || raw.profile_kind !== "backup"
      || raw.model !== backup.profile.model
      || raw.reasoning_effort !== backup.profile.reasoning_effort
    ) {
      throw new Error(`Legacy quality-recovery report profile provenance is invalid: ${reportPath}`);
    }
  };

  const invokeLegacyQualityRecovery = async (
    item: WorkItem,
    attempt: number,
    findings: VerifierReview["findings"],
    priorReviews: VerifierReview[],
    diagnosticImplementation: ImplementationResult,
  ): Promise<HandsWorkItemResult> => {
    if (manifest.review_policy_snapshot !== undefined) {
      throw new Error("Legacy quality recovery cannot run for a policy-enabled manifest");
    }
    const backup = handsBackupPolicy;
    if (!backup || manifest.active_hands_profile !== "primary") {
      throw new Error("Legacy quality recovery requires one configured backup while the primary route is active");
    }
    const boundedContext = await boundedHandsInvocationContext(item, attempt, "quality_recovery");
    const catalog = input.dependencies?.modelCatalog
      ? await input.dependencies.modelCatalog()
      : (await readModelCatalog({
          command: config.codex.command,
          cwd: input.worktreePath,
          timeoutMs: config.codex.timeout_seconds * 1000,
        })).snapshot;
    const selection = validateCatalogProfile(catalog, backup.profile, "Hands quality recovery");
    const expectedReportPath = `implementation/${item.id.replace(/[^a-zA-Z0-9._-]/g, "_")}/attempt-${attempt}.json`;
    const current = await readManifestV2(input.runDir);
    manifest = await updateManifestV2(input.runDir, {
      hands_backup_catalog: selection,
      work_item_progress: {
        ...current.work_item_progress,
        [item.id]: {
          ...(current.work_item_progress[item.id] ?? { status: "in_progress" as const, attempts: attempt - 1 }),
          status: "in_progress",
          attempts: attempt,
          mutation_kind: "quality_recovery",
          recovery_state: "in_progress",
          verification_path: undefined,
          verification_scope: undefined,
          verification_work_item_id: undefined,
          verification_issue_number: undefined,
          self_review_pass: 0,
          self_review_state: "pending",
          mutation_verification_path: undefined,
          self_review_paths: undefined,
          self_review_verification_paths: undefined,
          implementation_path: expectedReportPath,
        },
      },
    });
    await appendRunEvent(input.runDir, {
      actor: "runtime",
      stage: "fixing",
      type: "hands_quality_recovery_started",
      payload: { work_item_id: item.id, attempt, profile: "backup" },
    });
    let diagnosticContext: string | undefined;
    if (manifest.workflow_protocol !== "bounded-context-v1") {
      const reviewsByAttempt = new Map<string, VerifierReview>();
      for (const review of priorReviews) {
        reviewsByAttempt.set(`${review.work_item_id}:${review.attempt}:${review.final}`, review);
      }
      const reviewHistory = [...reviewsByAttempt.values()].sort((left, right) => left.attempt - right.attempt);
      const reviewEvidence = reviewHistory.flatMap((review) => [
        ...review.evidence_reviewed,
        ...review.findings.flatMap((finding) => finding.evidence_refs ?? []),
      ]);
      const verificationPaths = [...new Set([
        ...reviewEvidence,
        ...Object.values(evidenceByItem).flatMap((evidence) => evidence.evidence_path ? [evidence.evidence_path] : []),
      ])];
      const commandsAttempted = [
        ...diagnosticImplementation.commands_attempted,
        ...item.verification_commands.map((command) => command.argv),
      ];
      diagnosticContext = buildHandsRecoveryPacket({
        workItem: item,
        currentDiff: await currentDiff(item),
        latestFindings: findings,
        attempts: reviewHistory.map((review) => ({
          attempt: review.attempt,
          outcome: review.decision,
          failure_class: review.failure_class ?? null,
          findings: review.findings,
          evidence: [...new Set([
            ...review.evidence_reviewed,
            ...review.findings.flatMap((finding) => finding.evidence_refs ?? []),
          ])],
        })),
        verificationPaths,
        changedFiles: diagnosticImplementation.changed_files,
        commandsAttempted,
      });
    }
    const result = await hands({
      runDir: input.runDir,
      worktreePath: input.worktreePath,
      workItem: item,
      intake: input.intake,
      codex: input.codex,
      attempt,
      ...(boundedContext ?? { findings }),
      profile: backup.profile,
      profileKind: "backup",
      attemptKind: "quality_recovery",
      ...(diagnosticContext === undefined ? {} : { diagnosticContext }),
      budget,
    });
    if (runArtifactRelativePath(input.runDir, result.reportPath) !== expectedReportPath) {
      throw new Error(`Hands quality-recovery report does not match ${expectedReportPath}`);
    }
    await validateLegacyQualityRecoveryReport(item, expectedReportPath);
    await input.dependencies?.afterCheckpoint?.("after_legacy_quality_recovery_report");
    await appendRunEvent(input.runDir, {
      actor: "runtime",
      stage: "fixing",
      type: "hands_quality_recovery_completed",
      payload: { work_item_id: item.id, attempt, profile: "backup", report_path: expectedReportPath },
    });
    return { ...result, reportPath: expectedReportPath };
  };

  const runMutationQualityGate = async (
    gateInput: MutationQualityGateInput,
  ): Promise<MutationQualityGateResult> => {
    const workItemIndex = gateInput.workItem.id === "integrated"
      ? orderedWorkItems.length + 1
      : orderedWorkItems.findIndex((item) => item.id === gateInput.workItem.id) + 1;
    if (workItemIndex < 1) throw new Error(`Cannot verify unknown work item ${gateInput.workItem.id}`);
    const finalIdentity = gateInput.workItem.id === "integrated"
      ? integratedVerificationIdentity()
      : verificationIdentityForWorkItem(gateInput.workItem, githubDelivery, manifest);
    const policy = input.config?.retry_policy.quality_gate;
    const configuredPasses = policy?.hands_self_review_passes ?? 0;
    const expectedArtifacts = gateInput.workItem.expected_artifacts;
    const browserChecks = gateInput.workItem.browser_checks;
    const artifactId = gateInput.workItem.id.replace(/[^a-zA-Z0-9._-]/g, "_");
    let progress = (await readManifestV2(input.runDir)).work_item_progress[gateInput.workItem.id];
    let implementation = gateInput.implementation;
    let verification: VerificationEvidence;
    const reports: HandsSelfReviewReport[] = [];
    const currentVerificationCommands = gateInput.workItem.verification_commands.map((command) => command.argv);
    const originalActionCommands = gateInput.activeAction
      ? gateInput.activeAction.re_verification
        ?? gateInput.activeAction.remediation?.verification.commands.map((command) => command.argv)
        ?? []
      : currentVerificationCommands;
    const originalActionArtifacts = gateInput.activeAction?.remediation?.verification.required_evidence
      .filter((evidence) => evidence.kind === "artifact")
      .map((evidence) => evidence.output_path) ?? expectedArtifacts;
    const currentVerificationAuthority = {
      commands: currentVerificationCommands,
      expectedArtifacts,
      browserChecks,
      browser_evidence_identity_revision: browserChecks.length > 0 ? 3 : null,
    };
    const verificationAuthoritySuffix = JSON.stringify(originalActionCommands) === JSON.stringify(currentVerificationCommands)
        && JSON.stringify(originalActionArtifacts) === JSON.stringify(expectedArtifacts)
        && browserChecks.length === 0
      ? ""
      : `:authority-${createHash("sha256").update(JSON.stringify(currentVerificationAuthority)).digest("hex").slice(0, 16)}`;
    const intermediateIdentity = (pass: number): VerificationIdentity => ({
      scope: "local",
      work_item_id: `${gateInput.workItem.id}:quality-gate:${gateInput.parentAttempt}:${pass === 0 ? "baseline" : pass}${verificationAuthoritySuffix}`,
    });

    const accountSelfReviewMutation = async (report: HandsSelfReviewReport): Promise<void> => {
      if ((await readManifestV2(input.runDir)).review_policy_snapshot === undefined || report.changed_files.length === 0) return;
      const current = (await readManifestV2(input.runDir)).work_item_progress[gateInput.workItem.id];
      await incrementSelfReviewMutation({
        run_dir: input.runDir,
        mutation_id: [
          current?.review_effect_id ?? "pre-effect",
          gateInput.workItem.id,
          gateInput.mutationKind,
          gateInput.activeAction?.action_id ?? "no-action",
          gateInput.parentAttempt,
          report.pass,
        ].join(":"),
      });
      manifest = await readManifestV2(input.runDir);
    };
    const selfReviewProfile = (
      profile: HandsSelfReviewInput["profile"] | undefined,
    ): NonNullable<HandsSelfReviewInput["profile"]> => ({
      ...(profile ?? input.intake.roles.hands),
      reasoning_effort: (input.intake.phase_reasoning ?? DEFAULT_PHASE_REASONING).hands_self_review,
    });

    const assertReportProvenance = (report: HandsSelfReviewReport, pass: number): void => {
      if (
        report.work_item_id !== gateInput.workItem.id
        || report.parent_attempt !== gateInput.parentAttempt
        || report.mutation_kind !== gateInput.mutationKind
        || report.pass !== pass
        || report.active_action_id !== (gateInput.activeAction?.action_id ?? null)
      ) {
        throw new HandsSelfReviewQualityGateError(`Hands self-review provenance does not match ${gateInput.workItem.id} attempt ${gateInput.parentAttempt} pass ${pass}`);
      }
    };

    const loadQualityEvidence = async (currentProgress: RunManifestV2["work_item_progress"][string]): Promise<VerificationEvidence> => {
      const pass = currentProgress.self_review_pass ?? 0;
      const completedPass = currentProgress.self_review_state === "complete" ? pass : Math.max(0, pass - 1);
      const isFinal = configuredPasses === 0 || (completedPass === configuredPasses && configuredPasses > 0);
      const identity: VerificationIdentity = isFinal && verificationAuthoritySuffix === ""
        ? finalIdentity
        : intermediateIdentity(completedPass);
      const attempt = isFinal ? gateInput.parentAttempt : 1;
      try {
        return await loadPersistedEvidence(input.runDir, currentProgress, identity, attempt);
      } catch (error) {
        throw new HandsSelfReviewQualityGateError(`Persisted verification provenance is invalid: ${errorMessage(error)}`, { cause: error });
      }
    };

    const runAndPersistVerification = async (selfReviewPass?: number): Promise<VerificationEvidence> => {
      const isFinal = configuredPasses === 0 || selfReviewPass === configuredPasses;
      const identity: VerificationIdentity = isFinal && verificationAuthoritySuffix === ""
        ? finalIdentity
        : intermediateIdentity(selfReviewPass ?? 0);
      const attempt = isFinal ? gateInput.parentAttempt : 1;
      const raw = await verificationRunner({
        repoRoot: input.worktreePath,
        runDir: input.runDir,
        identity,
        mode: githubDelivery ? "github" : "local",
        commands: gateInput.workItem.verification_commands.map((command) => command.argv),
        stopOnFailure: true,
        commandIds: gateInput.workItem.verification_commands.map((command) => command.id),
        budget,
        expectedArtifacts,
        browserChecks,
        phase: gateInput.phase,
        attempt,
        resumeExistingNamespace: true,
        progress: input.progress,
        progressContext: { workItem: { index: workItemIndex, total: gateInput.workItem.id === "integrated" ? orderedWorkItems.length + 1 : orderedWorkItems.length, attempt: gateInput.parentAttempt, final: gateInput.workItem.id === "integrated" } },
      });
      const saved = validateEvidenceForIdentity(raw, identity, attempt);
      const path = await persistVerificationEvidence(input.runDir, saved, identity, attempt);
      manifest = await setProgress(input.runDir, gateInput.workItem.id, {
        status: "in_progress",
        attempts: gateInput.parentAttempt,
        mutation_kind: gateInput.mutationKind,
        verification_path: path,
        ...verificationProgressIdentity(identity),
        ...(selfReviewPass === undefined
          ? { mutation_verification_path: path }
          : {
              self_review_verification_paths: {
                ...(progress?.self_review_verification_paths ?? {}),
                [String(selfReviewPass)]: path,
              },
            }),
        ...(configuredPasses > 0 && selfReviewPass === undefined
          ? { self_review_pass: 0, self_review_state: "pending" }
          : {}),
        ...(configuredPasses === 0
          ? { self_review_pass: 0, self_review_state: "complete" }
          : {}),
        ...(selfReviewPass !== undefined
          ? { self_review_pass: selfReviewPass, self_review_state: "complete" }
          : {}),
      }, [path]);
      progress = manifest.work_item_progress[gateInput.workItem.id];
      return saved;
    };

    const pendingSelfReviewPass = progress?.self_review_pass;
    const exactBlockedQualityClaim = progress?.self_review_state === "invoking"
      && typeof pendingSelfReviewPass === "number"
      && pendingSelfReviewPass > 0
      && await isExactBlockedSelfReviewClaim(
        input.runDir,
        `self-review/${artifactId}/attempt-${gateInput.parentAttempt}/pass-${pendingSelfReviewPass}.claim.json`,
        `self-review/${artifactId}/attempt-${gateInput.parentAttempt}/pass-${pendingSelfReviewPass}.json`,
      );
    const resumableQualityState = isResumableSelfReviewQualityState(
      progress,
      gateInput.parentAttempt,
      exactBlockedQualityClaim,
    );
    if (resumableQualityState) {
      try {
        verification = await loadQualityEvidence(progress);
      } catch (error) {
        if (verificationAuthoritySuffix === "" || !errorMessage(error).includes("Persisted verification")) throw error;
        verification = await runAndPersistVerification((progress.self_review_pass ?? 0) > 0
          ? progress.self_review_pass
          : undefined);
      }
    } else {
      verification = await runAndPersistVerification();
    }

    for (let pass = 1; pass <= configuredPasses; pass += 1) {
      progress = (await readManifestV2(input.runDir)).work_item_progress[gateInput.workItem.id];
      const reportPath = `self-review/${artifactId}/attempt-${gateInput.parentAttempt}/pass-${pass}.json`;
      const claimPath = `self-review/${artifactId}/attempt-${gateInput.parentAttempt}/pass-${pass}.claim.json`;
      let report: HandsSelfReviewReport | undefined;
      const sameAttempt = progress?.attempts === gateInput.parentAttempt;
      const passAlreadyStarted = sameAttempt
        && progress.self_review_pass === pass
        && (progress.self_review_state === "invoking"
          || progress.self_review_state === "verification_pending"
          || progress.self_review_state === "complete");

      if (sameAttempt) {
        try {
          report = await readHandsSelfReviewReportArtifact(input.runDir, reportPath);
          assertReportProvenance(report, pass);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw new HandsSelfReviewQualityGateError(`Persisted Hands self-review is invalid: ${errorMessage(error)}`, { cause: error });
          }
          if (passAlreadyStarted && progress?.self_review_state !== "invoking") throw error;
          report = undefined;
        }
      } else {
        report = undefined;
      }

      if (report !== undefined && progress?.self_review_state === "complete") {
        await accountSelfReviewMutation(report);
        reports.push(report);
        implementation = {
          ...implementation,
          changed_files: [...new Set([...implementation.changed_files, ...report.changed_files])],
          commands_attempted: [...implementation.commands_attempted, ...report.commands_attempted],
          completed_steps: [...implementation.completed_steps, ...report.fixes_applied],
        };
        verification = await loadQualityEvidence(progress);
        continue;
      }

      if (report === undefined) {
        const exactBlockedClaim = progress?.self_review_state === "invoking"
          && await isExactBlockedSelfReviewClaim(input.runDir, claimPath, reportPath);
        manifest = await setProgress(input.runDir, gateInput.workItem.id, {
          status: "in_progress",
          attempts: gateInput.parentAttempt,
          mutation_kind: gateInput.mutationKind,
          self_review_pass: pass,
          self_review_state: "invoking",
          verification_path: verification.evidence_path,
        });
        let result: HandsSelfReviewResult;
        try {
          result = await invokeWithHandsFallback(gateInput.workItem, gateInput.parentAttempt, true, async (profile, resumeBlockedClaim) => selfReview({
            runDir: input.runDir,
            worktreePath: input.worktreePath,
            workItem: gateInput.workItem,
            intake: input.intake,
            codex: input.codex,
            parentAttempt: gateInput.parentAttempt,
            mutationKind: gateInput.mutationKind,
            pass,
            implementation,
            currentDiff: await currentDiff(gateInput.workItem),
            verification,
            activeAction: gateInput.activeAction,
            completedActions: gateInput.completedActions,
            priorPassReports: reports,
            profile: selfReviewProfile(profile),
            resumeBlockedClaim: shouldResumeBlockedSelfReviewClaim(resumeBlockedClaim, exactBlockedClaim),
            contextPlanRevision: budgetPlanRevision(),
            budget,
          }), (passAlreadyStarted && progress?.self_review_state === "invoking") || exactBlockedClaim);
          report = handsSelfReviewReportSchema.parse(result.report);
        } catch (error) {
          throw new HandsSelfReviewQualityGateError(`Hands self-review pass ${pass} failed: ${errorMessage(error)}`, { cause: error });
        }
        assertReportProvenance(report, pass);
        const resultPath = runArtifactRelativePath(input.runDir, result.reportPath);
        if (resultPath !== reportPath) {
          throw new HandsSelfReviewQualityGateError(`Hands self-review path does not match ${reportPath}`);
        }
      }

      reports.push(report);
      implementation = {
        ...implementation,
        changed_files: [...new Set([...implementation.changed_files, ...report.changed_files])],
        commands_attempted: [...implementation.commands_attempted, ...report.commands_attempted],
        completed_steps: [...implementation.completed_steps, ...report.fixes_applied],
      };
      const currentPaths = progress?.self_review_paths ?? {};
      manifest = await setProgress(input.runDir, gateInput.workItem.id, {
        status: "in_progress",
        attempts: gateInput.parentAttempt,
        mutation_kind: gateInput.mutationKind,
        self_review_pass: pass,
        self_review_state: report.changed_files.length > 0 ? "verification_pending" : "complete",
        verification_path: verification.evidence_path,
        self_review_paths: { ...currentPaths, [String(pass)]: reportPath },
      }, [reportPath]);
      await accountSelfReviewMutation(report);
      if (gateInput.mutationKind === "reviewer_action" && pass === 1) {
        await input.dependencies?.afterCheckpoint?.("after_self_review_pass_1");
      }

      if (report.changed_files.length > 0) {
        verification = await runAndPersistVerification(pass);
        if (gateInput.mutationKind === "reviewer_action" && pass === 1) {
          await input.dependencies?.afterCheckpoint?.("after_post_pass_verification");
        }
      }
      manifest = await setProgress(input.runDir, gateInput.workItem.id, {
        status: "in_progress",
        attempts: gateInput.parentAttempt,
        mutation_kind: gateInput.mutationKind,
        self_review_pass: pass,
        self_review_state: "complete",
        verification_path: verification.evidence_path,
        self_review_paths: { ...currentPaths, [String(pass)]: reportPath },
      }, [reportPath, ...(verification.evidence_path ? [verification.evidence_path] : [])]);
    }

    const expectedFinalIdentity = verificationAuthoritySuffix === "" ? finalIdentity : intermediateIdentity(configuredPasses);
    if (verification.verification_scope !== expectedFinalIdentity.scope || verification.work_item_id !== expectedFinalIdentity.work_item_id || verification.attempt !== gateInput.parentAttempt) {
      verification = await runAndPersistVerification(configuredPasses);
    }

    return { implementation, finalVerification: verification, selfReviews: reports };
  };

  const validatePersistedMutationQualityGate = async (validationInput: {
    workItem: WorkItem;
    parentAttempt: number;
    expectedMutationKind: HandsSelfReviewReport["mutation_kind"];
    activeAction: ReviewerAction | null;
  }): Promise<MutationQualityGateResult> => {
    const progress = (await readManifestV2(input.runDir)).work_item_progress[validationInput.workItem.id];
    if (!progress || progress.mutation_kind !== validationInput.expectedMutationKind) {
      throw new HandsSelfReviewQualityGateError(
        `Persisted mutation identity ${progress?.mutation_kind ?? "missing"} does not match expected ${validationInput.expectedMutationKind} for ${validationInput.workItem.id}`,
      );
    }
    const configuredPasses = qualityGatePolicy?.hands_self_review_passes ?? 0;
    const finalIdentity = validationInput.workItem.id === "integrated"
      ? integratedVerificationIdentity()
      : verificationIdentityForWorkItem(validationInput.workItem, githubDelivery, manifest);
    const currentVerificationCommands = validationInput.workItem.verification_commands.map((command) => command.argv);
    const originalActionCommands = validationInput.activeAction
      ? validationInput.activeAction.re_verification
        ?? validationInput.activeAction.remediation?.verification.commands.map((command) => command.argv)
        ?? []
      : currentVerificationCommands;
    const expectedArtifacts = validationInput.workItem.expected_artifacts;
    const originalActionArtifacts = validationInput.activeAction?.remediation?.verification.required_evidence
      .filter((evidence) => evidence.kind === "artifact")
      .map((evidence) => evidence.output_path) ?? expectedArtifacts;
    const currentVerificationAuthority = {
      commands: currentVerificationCommands,
      expectedArtifacts,
      browserChecks: validationInput.workItem.browser_checks,
      browser_evidence_identity_revision: validationInput.workItem.browser_checks.length > 0 ? 3 : null,
    };
    const verificationAuthoritySuffix = JSON.stringify(originalActionCommands) === JSON.stringify(currentVerificationCommands)
        && JSON.stringify(originalActionArtifacts) === JSON.stringify(expectedArtifacts)
        && validationInput.workItem.browser_checks.length === 0
      ? ""
      : `:authority-${createHash("sha256").update(JSON.stringify(currentVerificationAuthority)).digest("hex").slice(0, 16)}`;
    const identityForPass = (pass: number): { identity: VerificationIdentity; attempt: number } => {
      const isFinal = configuredPasses === 0 || pass === configuredPasses;
      return isFinal && verificationAuthoritySuffix === ""
        ? { identity: finalIdentity, attempt: validationInput.parentAttempt }
        : { identity: {
            scope: "local",
            work_item_id: `${validationInput.workItem.id}:quality-gate:${validationInput.parentAttempt}:${pass === 0 ? "baseline" : pass}${verificationAuthoritySuffix}`,
          }, attempt: isFinal ? validationInput.parentAttempt : 1 };
    };
    const mutationIdentity = identityForPass(0);
    const mutationPath = verificationEvidencePath(mutationIdentity.identity, mutationIdentity.attempt);
    if (progress.mutation_verification_path !== mutationPath) {
      throw new HandsSelfReviewQualityGateError(`Persisted mutation evidence path does not match ${validationInput.workItem.id} attempt ${validationInput.parentAttempt}`);
    }
    const loadAtPath = async (path: string, identity: VerificationIdentity, attempt: number) => {
      try {
        return await loadPersistedEvidence(input.runDir, {
          ...progress,
          verification_path: path,
          verification_scope: identity.scope,
          verification_work_item_id: identity.work_item_id,
          verification_issue_number: identity.scope === "github" ? identity.issue_number : undefined,
        }, identity, attempt);
      } catch (error) {
        throw new HandsSelfReviewQualityGateError(`Persisted quality evidence is invalid: ${errorMessage(error)}`, { cause: error });
      }
    };
    let finalVerification = await loadAtPath(mutationPath, mutationIdentity.identity, mutationIdentity.attempt);
    const selfReviews: HandsSelfReviewReport[] = [];
    let implementation = await loadPersistedImplementation(input.runDir, progress, validationInput.workItem);
    for (let pass = 1; pass <= configuredPasses; pass += 1) {
      const reportPath = `self-review/${validationInput.workItem.id.replace(/[^a-zA-Z0-9._-]/g, "_")}/attempt-${validationInput.parentAttempt}/pass-${pass}.json`;
      if (progress.self_review_paths?.[String(pass)] !== reportPath) {
        throw new HandsSelfReviewQualityGateError(`Persisted self-review report path does not match pass ${pass}`);
      }
      const report = await readHandsSelfReviewReportArtifact(input.runDir, reportPath);
      if (
        report.work_item_id !== validationInput.workItem.id
        || report.parent_attempt !== validationInput.parentAttempt
        || report.mutation_kind !== validationInput.expectedMutationKind
        || report.pass !== pass
        || report.active_action_id !== (validationInput.activeAction?.action_id ?? null)
      ) {
        throw new HandsSelfReviewQualityGateError(`Persisted self-review provenance does not match ${validationInput.workItem.id} attempt ${validationInput.parentAttempt} pass ${pass}`);
      }
      selfReviews.push(report);
      implementation = {
        ...implementation,
        changed_files: [...new Set([...implementation.changed_files, ...report.changed_files])],
        commands_attempted: [...implementation.commands_attempted, ...report.commands_attempted],
        completed_steps: [...implementation.completed_steps, ...report.fixes_applied],
      };
      if (report.changed_files.length > 0) {
        const passIdentity = identityForPass(pass);
        const evidencePath = verificationEvidencePath(passIdentity.identity, passIdentity.attempt);
        if (progress.self_review_verification_paths?.[String(pass)] !== evidencePath) {
          throw new HandsSelfReviewQualityGateError(`Persisted self-review evidence path does not match pass ${pass}`);
        }
        finalVerification = await loadAtPath(evidencePath, passIdentity.identity, passIdentity.attempt);
      } else {
        const persistedPath = progress.self_review_verification_paths?.[String(pass)];
        const finalPassIdentity = identityForPass(pass);
        const finalFallbackPath = verificationEvidencePath(finalPassIdentity.identity, finalPassIdentity.attempt);
        if (persistedPath !== undefined && !(pass === configuredPasses && persistedPath === finalFallbackPath)) {
          throw new HandsSelfReviewQualityGateError(`Unchanged self-review pass ${pass} has unexpected verification evidence`);
        }
        if (persistedPath === finalFallbackPath) {
          finalVerification = await loadAtPath(finalFallbackPath, finalPassIdentity.identity, finalPassIdentity.attempt);
        }
      }
    }
    const expectedFinalIdentity = identityForPass(configuredPasses);
    const expectedFinalPath = verificationEvidencePath(expectedFinalIdentity.identity, expectedFinalIdentity.attempt);
    const laterFinalPath = verificationEvidencePath(finalIdentity, validationInput.parentAttempt);
    if (
      (configuredPasses > 0 && progress.self_review_pass !== configuredPasses)
      || (configuredPasses > 0 && progress.self_review_state !== "complete")
      || (progress.verification_path !== expectedFinalPath && progress.verification_path !== laterFinalPath)
      || finalVerification.evidence_path !== expectedFinalPath
    ) {
      throw new HandsSelfReviewQualityGateError(`Persisted quality gate is incomplete for ${validationInput.workItem.id} attempt ${validationInput.parentAttempt}`);
    }
    return { implementation, finalVerification, selfReviews };
  };

  const actionMutationAttempt = (
    reviewRevision: number,
    action: ReviewerAction,
    actionAttempt: number,
  ): number => reviewRevision * 1_000_000 + action.order * 100 + actionAttempt;

  const actionCommands = (
    active: ReviewerAction,
    completed: readonly ReviewerAction[],
  ): readonly string[][] => {
    const commands = [...completed, active].flatMap((action) =>
      action.re_verification ?? action.remediation?.verification.commands.map((command) => command.argv) ?? []);
    const seen = new Set<string>();
    return commands.filter((command) => {
      const key = JSON.stringify(command);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };

  const actionScopedWorkItem = (
    workItem: WorkItem,
    active: ReviewerAction,
    completed: readonly ReviewerAction[],
    packet?: ReviewFixPacketV1,
  ): WorkItem => {
    const commands = packet
      ? packet.verification.commands.map((command) => command.argv)
      : actionCommands(active, completed);
    const packetArtifacts = packet
      ? packet.verification.required_evidence
          .filter((evidence) => evidence.kind === "artifact")
          .map((evidence) => evidence.output_path)
      : [];
    return {
      ...workItem,
      objective: [
        workItem.objective,
        `Resolve only Reviewer action ${active.action_id}: ${active.required_fix}`,
        `Completed Reviewer actions to preserve without reopening: ${completed.length === 0
          ? "none"
          : completed.map((action) => `${action.action_id}: ${action.required_fix}`).join("; ")}`,
      ].join("\n"),
      verification_commands: commands.length > 0
        ? commands.map((argv, index) => ({ id: `review-action-${active.action_id}-${index + 1}`, argv, expected_exit_code: 0 as const }))
        : workItem.verification_commands,
      expected_artifacts: [...new Set([...workItem.expected_artifacts, ...packetArtifacts])],
    };
  };

  const packetForAction = async (
    workItem: WorkItem,
    action: ReviewerAction,
    reviewRevision: number,
    actionAttempt: number,
    findingCriterionRef?: string,
  ): Promise<{ packet: ReviewFixPacketV1; path: string; sha256: string }> => {
    if (!action.remediation || !action.problem_class) throw new Error(`Reviewer action ${action.action_id} has no packet remediation`);
    const criterion = workItem.acceptance.find((entry) =>
      entry.id === action.acceptance_criterion || entry.statement === action.acceptance_criterion);
    if (!criterion) throw new Error(`Reviewer action ${action.action_id} references an unknown acceptance criterion`);
    const current = await readManifestV2(input.runDir);
    const approvedRevision = current.approved_revision ?? current.approved_plan_revision;
    const approvedSha = approvedRevision === null ? null : current.plan_revisions[String(approvedRevision)]?.sha256;
    if (!approvedSha) throw new Error("Approved plan hash is unavailable for review fix packet compilation");
    const findingId = fingerprintFinding({
      work_item_id: workItem.id,
      criterion_ref: findingCriterionRef ?? criterion.id,
      source: "verifier",
      normalized_location: action.line === null ? action.file : `${action.file}:${action.line}`,
      problem_class: action.problem_class,
    });
    const compile = (claim: typeof action.remediation) => compileReviewFixPacket({
      claim: claim!, work_item: workItem, finding_id: findingId, action_id: action.action_id,
      review_revision: reviewRevision, criterion_ref: criterion.id, severity: action.severity,
      problem_class: action.problem_class!, approved_plan_sha256: approvedSha, worktree_path: input.worktreePath,
      packet_identity: current.workflow_protocol === "bounded-context-v1" ? "scoped" : "legacy",
      approved_artifact_outputs: input.plan.work_items.flatMap((candidate) => candidate.expected_artifacts),
      approved_browser_outputs: input.plan.work_items.flatMap((candidate) =>
        candidate.browser_checks.map((check) => check.screenshot_artifact)),
    });
    let packet: ReviewFixPacketV1;
    try {
      packet = compile(action.remediation);
    } catch (error) {
      if (error instanceof FixPacketRequiresReplanError) throw error;
      const corrected = await correctVerifierRemediationClaim({
        runDir: input.runDir, worktreePath: input.worktreePath, actionId: action.action_id,
        actionAttempt, reviewRevision, approvedPlanSha256: approvedSha,
        claim: action.remediation, validationErrors: [errorMessage(error)], workItem,
        verifierProfile: input.intake.roles.verifier, codex: input.codex,
        approvedPlanRevision: budgetPlanRevision(),
        budget,
      });
      try {
        packet = compile(corrected);
      } catch (correctedError) {
        if (correctedError instanceof FixPacketRequiresReplanError) throw correctedError;
        throw new Error(`invalid_verifier_contract: corrected remediation remains invalid: ${errorMessage(correctedError)}`);
      }
    }
    return { packet, ...await persistReviewFixPacket(input.runDir, packet) };
  };

  const packetImplementation = (workItem: WorkItem, result: import("../core/review-fix-packet.js").FixPacketResultV1): ImplementationResult => ({
    work_item_id: workItem.id,
    changed_files: result.changed_files,
    tests_added_or_changed: result.changed_files.filter((path) => path.startsWith("tests/")),
    commands_attempted: result.commands_attempted.map((attempt) => attempt.argv),
    completed_steps: result.change_units.filter((unit) => unit.status === "completed").map((unit) => `${unit.change_unit_id}: ${unit.summary}`),
    remaining_risks: result.unresolved_requirements.map((entry) => `${entry.change_unit_id}: ${entry.requirement} (${entry.reason})`),
  });

  type PersistedHandsProfile = { kind: "primary" | "backup"; model: string; reasoning_effort: ReasoningEffort };

  const invokePacketHands = async (
    workItem: WorkItem,
    packet: ReviewFixPacketV1,
    actionAttempt: number,
    mutationAttempt: number,
    completedActions: ReviewerAction[],
    supplement: FixAttemptSupplementV1 | null,
    claimedProfile?: PersistedHandsProfile,
    recoverStartedInvocation = false,
  ): Promise<HandsWorkItemResult & { invocationProfile: HandsFixPacketInvocationProfile }> => {
    const itemIndex = orderedWorkItems.findIndex((candidate) => candidate.id === workItem.id) + 1;
    await input.progress?.emit({
      code: "work_item_fix",
      source: "hands",
      workItem: {
        index: itemIndex,
        total: orderedWorkItems.length,
        attempt: mutationAttempt,
        final: false,
      },
    });
    const packetResultPath = `${reviewFixPacketRoot(packet.provenance.packet_id)}/attempts/${actionAttempt}/hands-result.json`;
    let packetResult = await readOptionalValidatedArtifact(input.runDir, packetResultPath, fixPacketResultV1Schema);
    if (recoverStartedInvocation && packetResult?.status === "operationally_blocked") packetResult = null;
    let invocation = {} as never;
    let invocationProfile: HandsFixPacketInvocationProfile;
    if (!packetResult) {
      const packetPaths = new Set(packet.remediation.allowed_files);
      const packetDiffScope: WorkItem = {
        ...workItem,
        file_contract: workItem.file_contract.filter((contract) => packetPaths.has(contract.path)),
        completion_contract: {
          ...workItem.completion_contract,
          expected_changed_files: packet.completion_contract.expected_changed_files,
        },
      };
      const boundedContext = await boundedHandsInvocationContext(workItem, mutationAttempt, "fix_packet", packetDiffScope);
      const sourceContext = boundedContext ? [] : await Promise.all(packet.remediation.allowed_files.map(async (path) => ({
          path,
          content: await readFile(resolve(input.worktreePath, path), "utf8").catch(() => "[file unavailable]"),
        })));
      const evidenceContext = boundedContext ? [] : await Promise.all(packet.diagnosis.evidence_refs.map(async (path) => ({
          path,
          content: await readFile(resolve(input.runDir, path), "utf8").catch(() => "[evidence unavailable]"),
        })));
      const invoked = await handsFixPacket({
        runDir: input.runDir, worktreePath: input.worktreePath, workItem, packet, actionAttempt,
        intake: input.intake, codex: input.codex, relevantSourceContext: sourceContext, evidenceContext,
        completedDependencies: boundedContext ? [] : completedActions.map((action) => ({ action_id: action.action_id, required_fix: action.required_fix })),
        currentDiff: boundedContext ? "" : await currentDiff(workItem), supplement,
        ...(boundedContext ? { contextAttempt: mutationAttempt } : {}),
        ...(boundedContext ?? {}),
        ...(claimedProfile ? {
          profile: { model: claimedProfile.model, reasoning_effort: claimedProfile.reasoning_effort },
          profileKind: claimedProfile.kind,
        } : {}),
        recoverStartedInvocation,
        budget,
      });
      packetResult = invoked.result;
      invocation = invoked.invocation as never;
      invocationProfile = invoked.profile;
    } else {
      invocationProfile = await readHandsFixPacketInvocationProfile(input.runDir, packet, actionAttempt);
    }
    if (packetResult.packet_id !== packet.provenance.packet_id
      || packetResult.packet_sha256 !== hashReviewFixPacket(packet)
      || packetResult.action_attempt !== actionAttempt) {
      throw new Error("Persisted Hands fix packet result provenance does not match the active packet");
    }
    assertFixPacketResultMatchesPacket(packet, packetResult);
    if (packetResult.status !== "implemented") throw new Error(`Review fix packet ${packet.provenance.packet_id} was not implemented: ${packetResult.status}`);
    const implementation = packetImplementation(workItem, packetResult);
    const reportPath = `implementation/${workItem.id.replace(/[^a-zA-Z0-9._-]/g, "_")}/attempt-${mutationAttempt}.json`;
    await writeImmutableTextArtifact(input.runDir, reportPath, `${JSON.stringify({
      ...implementation,
      work_item_id: implementation.work_item_id, changed_files: implementation.changed_files,
      commands_attempted: implementation.commands_attempted, summary: implementation.completed_steps.join("\n"),
      known_limitations: implementation.remaining_risks, tests_added_or_changed: implementation.tests_added_or_changed,
      completed_steps: implementation.completed_steps,
      remaining_risks: implementation.remaining_risks,
      packet_id: packet.provenance.packet_id, packet_sha256: hashReviewFixPacket(packet),
      ...(claimedProfile ? {
        model: claimedProfile.model,
        reasoning_effort: claimedProfile.reasoning_effort,
        profile_kind: claimedProfile.kind,
      } : {}),
    }, null, 2)}\n`).catch(async (error) => {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    });
    return { implementation, reportPath, invocation, invocationProfile };
  };

  const invokeClaimedActionHands = async (claimInput: {
    cycle: ReviewCycleState;
    workItem: WorkItem;
    action: ReviewerAction;
    actionAttempt: number;
    mutationAttempt: number;
    invokeMutation?: (profile: PersistedHandsProfile) => Promise<HandsWorkItemResult>;
  }): Promise<HandsWorkItemResult> => {
    const claimId = [claimInput.cycle.effect_id, claimInput.cycle.review_revision, claimInput.action.action_id, claimInput.actionAttempt].join(":");
    const claimRoot = `reviews/action-invocations/${Buffer.from(claimId).toString("base64url")}`;
    const claimPath = `${claimRoot}/claim.json`;
    const completionPath = `${claimRoot}/completion.json`;
    const gitClaimPath = `${claimRoot}/git-claim.json`;
    const gitCompletionPath = `${claimRoot}/git-completion.json`;
    const reportPath = `implementation/${claimInput.workItem.id.replace(/[^a-zA-Z0-9._-]/g, "_")}/attempt-${claimInput.mutationAttempt}.json`;
    const staticProvenance = {
      effect_id: claimInput.cycle.effect_id,
      review_revision: claimInput.cycle.review_revision,
      action_id: claimInput.action.action_id,
      action_attempt: claimInput.actionAttempt,
      report_path: reportPath,
      substage: claimInput.cycle.decision.action === "quality_recovery" ? "quality_recovery" : "primary_fix",
    };
    const gitCoordinates = {
      effect_id: claimInput.cycle.effect_id,
      review_revision: claimInput.cycle.review_revision,
      action_id: claimInput.action.action_id,
      action_attempt: claimInput.actionAttempt,
    };
    const persistGitCompletion = async (reportSha256: string): Promise<void> => {
      const gitClaim = actionGitClaimSchema.parse(await readRunArtifact(input.runDir, gitClaimPath));
      const expectedPaths = claimInput.action.remediation?.completion_contract.expected_changed_files
        ?? claimInput.workItem.completion_contract.expected_changed_files;
      await persistImmutableJsonArtifact(input.runDir, gitCompletionPath, actionGitCompletionSchema.parse({
        ...gitClaim,
        report_sha256: reportSha256,
        post_action_blobs: await worktreeBlobEvidence(input.worktreePath, expectedPaths),
      }));
    };
    const profileForKind = (manifestAtStart: RunManifestV2, kind: "primary" | "backup"): PersistedHandsProfile => {
      const profile = kind === "primary"
        ? manifestAtStart.selected_role_profiles.hands ?? manifestAtStart.role_profiles.hands
        : manifestAtStart.hands_backup_policy?.profile;
      if (!profile) throw new Error(`Hands ${kind} profile is unavailable for action claim`);
      return { kind, model: profile.model, reasoning_effort: profile.reasoning_effort };
    };
    const loadReport = async (): Promise<HandsWorkItemResult> => ({
      implementation: await loadPersistedImplementation(input.runDir, {
        status: "in_progress",
        attempts: claimInput.mutationAttempt,
        implementation_path: reportPath,
      }, claimInput.workItem),
      reportPath,
      invocation: {} as never,
    });
    const loadReportIdentity = async (): Promise<{ profile: PersistedHandsProfile; sha256: string }> => {
      const bytes = await readFile(resolve(input.runDir, reportPath));
      const raw = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
      const kind = raw.profile_kind;
      const model = raw.model;
      const reasoning = raw.reasoning_effort;
      if ((kind !== "primary" && kind !== "backup") || typeof model !== "string" || typeof reasoning !== "string") {
        throw new Error(`Hands action report is missing profile provenance: ${reportPath}`);
      }
      const actual = { kind, model, reasoning_effort: reasoning } as PersistedHandsProfile;
      const current = await readManifestV2(input.runDir);
      const expectedProfile = actual.kind === "primary"
        ? current.selected_role_profiles.hands ?? current.role_profiles.hands
        : current.hands_backup_policy?.profile;
      if (!expectedProfile || expectedProfile.model !== actual.model || expectedProfile.reasoning_effort !== actual.reasoning_effort) {
        throw new Error(`Hands action report profile does not match snapshotted ${actual.kind} profile`);
      }
      return { profile: actual, sha256: createHash("sha256").update(bytes).digest("hex") };
    };
    const validateTransfer = async (started: PersistedHandsProfile, completed: PersistedHandsProfile): Promise<void> => {
      const snapshot = (await readManifestV2(input.runDir));
      const startedExpected = started.kind === "primary"
        ? snapshot.selected_role_profiles.hands ?? snapshot.role_profiles.hands
        : snapshot.hands_backup_policy?.profile;
      if (!startedExpected || startedExpected.model !== started.model || startedExpected.reasoning_effort !== started.reasoning_effort) {
        throw new Error("Persisted Hands starting profile does not match its immutable snapshot");
      }
      if (started.kind === completed.kind) {
        if (started.model !== completed.model || started.reasoning_effort !== completed.reasoning_effort) {
          throw new Error("Hands action profile changed without a legal transfer");
        }
        return;
      }
      const current = await readManifestV2(input.runDir);
      const events = (await readFile(join(input.runDir, "events.jsonl"), "utf8"))
        .split("\n").filter(Boolean).map((line) => JSON.parse(line) as { type?: string; payload?: Record<string, unknown> });
      const activation = events.some((event) => event.type === "hands_backup_activated"
        && event.payload?.work_item_id === claimInput.workItem.id
        && event.payload?.reason === "primary_usage_limit");
      if (
        started.kind !== "primary"
        || completed.kind !== "backup"
        || current.active_hands_profile !== "backup"
        || current.backup_activation_reason !== "primary_usage_limit"
        || !current.hands_backup_policy?.fallback_on_primary_usage_limit
        || current.hands_backup_catalog?.slug !== completed.model
        || !activation
      ) throw new Error("Hands action profile transfer provenance is invalid");
    };
    let completion: unknown = null;
    try { completion = await readRunArtifact<unknown>(input.runDir, completionPath); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (completion !== null) {
      const persistedCompletion = completion as Record<string, unknown>;
      const claim = await readRunArtifact<Record<string, unknown>>(input.runDir, claimPath);
      const persistedStarted = claim.started_profile as PersistedHandsProfile;
      if (JSON.stringify(claim) !== JSON.stringify({ ...staticProvenance, state: "started", started_profile: persistedStarted, completed_profile: null })) {
        throw new Error(`Persisted action invocation claim is invalid for ${claimInput.action.action_id}`);
      }
      const identity = await loadReportIdentity();
      await validateTransfer(persistedStarted, identity.profile);
      if (JSON.stringify(persistedCompletion)
        !== JSON.stringify({ ...staticProvenance, state: "complete", started_profile: persistedStarted, completed_profile: identity.profile, report_sha256: identity.sha256 })) {
        throw new Error(`Persisted action invocation completion is invalid for ${claimInput.action.action_id}`);
      }
      return loadReport();
    }
    let claim: unknown = null;
    try { claim = await readRunArtifact<unknown>(input.runDir, claimPath); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (claim !== null) {
      const persistedClaim = claim as Record<string, unknown>;
      const persistedStarted = persistedClaim.started_profile as PersistedHandsProfile;
      if (JSON.stringify(persistedClaim) !== JSON.stringify({ ...staticProvenance, state: "started", started_profile: persistedStarted, completed_profile: null })) {
        throw new Error(`Persisted action invocation claim is invalid for ${claimInput.action.action_id}`);
      }
      try {
        const persisted = await loadReport();
        const identity = await loadReportIdentity();
        await validateTransfer(persistedStarted, identity.profile);
        await persistImmutableJsonArtifact(input.runDir, completionPath, {
          ...staticProvenance,
          state: "complete",
          started_profile: persistedStarted,
          completed_profile: identity.profile,
          report_sha256: identity.sha256,
        });
        await input.dependencies?.afterCheckpoint?.("after_action_invocation_complete");
        return persisted;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          if (!claimInput.invokeMutation) {
            throw new Error(`Ambiguous action invocation ${claimInput.action.action_id} attempt ${claimInput.actionAttempt}`);
          }
          const recovered = await claimInput.invokeMutation(persistedStarted);
          const identity = await loadReportIdentity();
          await validateTransfer(persistedStarted, identity.profile);
          await persistImmutableJsonArtifact(input.runDir, completionPath, {
            ...staticProvenance,
            state: "complete",
            started_profile: persistedStarted,
            completed_profile: identity.profile,
            report_sha256: identity.sha256,
          });
          await input.dependencies?.afterCheckpoint?.("after_action_invocation_complete");
          return recovered;
        }
        throw error;
      }
    }
    const startManifest = await readManifestV2(input.runDir);
    const startedProfile = profileForKind(
      startManifest,
      claimInput.cycle.decision.action === "quality_recovery" ? "backup" : startManifest.active_hands_profile,
    );
    if (claimInput.invokeMutation) {
      const preActionHead = await (input.dependencies?.localHeadSha ?? resolveLocalHeadSha)(input.worktreePath);
      const preActionCommit = await (input.dependencies?.localCommitProvenance ?? resolveLocalCommitProvenance)(input.worktreePath, preActionHead);
      await persistImmutableJsonArtifact(input.runDir, gitClaimPath, actionGitClaimSchema.parse({
        ...gitCoordinates,
        pre_action_head: preActionCommit.sha,
        pre_action_tree: preActionCommit.tree_sha,
      }));
    }
    await persistImmutableJsonArtifact(input.runDir, claimPath, { ...staticProvenance, state: "started", started_profile: startedProfile, completed_profile: null });
    await input.dependencies?.afterCheckpoint?.("after_action_invocation_claim");
    const invoked = claimInput.invokeMutation
      ? await claimInput.invokeMutation(startedProfile)
      : await invokeHands(
          claimInput.workItem,
          claimInput.mutationAttempt,
          "primary_fix",
          [claimInput.action],
        );
    await input.dependencies?.afterCheckpoint?.("after_action_worker_report");
    if (runArtifactRelativePath(input.runDir, invoked.reportPath) !== reportPath) {
      throw new Error(`Hands action report path does not match claimed path ${reportPath}`);
    }
    await loadReport();
    const identity = await loadReportIdentity();
    await validateTransfer(startedProfile, identity.profile);
    if (claimInput.invokeMutation) await persistGitCompletion(identity.sha256);
    await persistImmutableJsonArtifact(input.runDir, completionPath, {
      ...staticProvenance,
      state: "complete",
      started_profile: startedProfile,
      completed_profile: identity.profile,
      report_sha256: identity.sha256,
    });
    await input.dependencies?.afterCheckpoint?.("after_action_invocation_complete");
    return invoked;
  };

  type OrderedQueueResult =
    | {
      kind: "review";
      implementationResult: HandsWorkItemResult;
      verification: VerificationEvidence;
      reviewResult: VerifyWorkItemResult;
      reviewPass: number;
      savedEvidencePath: string;
    }
    | { kind: "blocked"; blocker: string; blockerCode: HandsBlockerCode }
    | {
      kind: "complete" | "still_blocking";
      successful_hands_fixes: number;
      evidence_paths: string[];
      implementationResult: HandsWorkItemResult;
      verification: VerificationEvidence;
      reviewPass: number;
      savedEvidencePath: string;
    };

  const runOrderedActionQueue = async (queueInput: {
    workItem: WorkItem;
    issueNumber: number;
    review: VerifierReview;
    reviewPass: number;
    implementationResult: HandsWorkItemResult;
    cycle?: ReviewCycleState;
    effectOwner?: string;
    policyCriterionAliases?: Readonly<Record<string, string>>;
    legacyQualityRecovery?: boolean;
    recoverStartedPacketInvocation?: boolean;
  }): Promise<OrderedQueueResult> => {
    const policyEffect = queueInput.cycle !== undefined;
    const policyEffectAction = queueInput.cycle && isReviewEffectAction(queueInput.cycle.decision.action)
      ? queueInput.cycle.decision.action
      : null;
    if (policyEffect && policyEffectAction === null) {
      return {
        kind: "blocked",
        blocker: "Ordered Reviewer actions require an engine-authorized fix decision",
        blockerCode: "invalid_reviewer_action_queue",
      };
    }
    const currentProgress = (await readManifestV2(input.runDir)).work_item_progress[queueInput.workItem.id];
    const legacyQualityRecovery = !policyEffect && (
      queueInput.legacyQualityRecovery === true
      || (currentProgress?.mutation_kind === "quality_recovery" && currentProgress.recovery_state === "in_progress")
    );
    const resumableQueue = currentProgress?.queue_path
      && currentProgress.queue_state !== "complete"
      && currentProgress.review_revision !== undefined;
    const reviewRevision = policyEffect
      ? queueInput.cycle!.review_revision
      : resumableQueue
      ? currentProgress.review_revision!
      : (currentProgress?.review_revision ?? 0) + 1;
    let queue: ReviewerActionQueue;
    try {
      queue = resumableQueue
        ? validateReviewerActionQueue(await readRunArtifact<ReviewerActionQueue>(input.runDir, currentProgress.queue_path!))
        : policyEffect
          ? normalizePolicyReviewerActions(
              queueInput.review,
              reviewRevision,
              queueInput.workItem,
              queueInput.cycle!.decision.finding_ids,
              queueInput.policyCriterionAliases,
            )
          : validateReviewerActionQueue(normalizeReviewerActions(queueInput.review, reviewRevision));
      if (policyEffect) {
        queue = assertPolicyReviewerQueueAuthority(
          queue,
          queueInput.workItem,
          queueInput.cycle!.decision.finding_ids,
          queueInput.policyCriterionAliases,
        );
      }
    } catch (error) {
      return {
        kind: "blocked",
        blocker: `Invalid Reviewer action queue for ${queueInput.workItem.id}: ${errorMessage(error)}`,
        blockerCode: "invalid_reviewer_action_queue",
      };
    }
    const queueArtifactId = queueInput.workItem.id.replace(/[^a-zA-Z0-9._-]/g, "_");
    const queuePath = `action-queues/${queueArtifactId}/revision-${reviewRevision}.json`;
    if (
      queue.work_item_id !== queueInput.workItem.id
      || queue.review_revision !== reviewRevision
      || (resumableQueue && currentProgress.queue_path !== queuePath)
    ) {
      return {
        kind: "blocked",
        blocker: `Persisted Reviewer action queue provenance does not match ${queueInput.workItem.id} revision ${reviewRevision}`,
        blockerCode: "invalid_reviewer_action_queue",
      };
    }
    if (!resumableQueue) {
      await writeReviewerActionQueueArtifact(input.runDir, queuePath, queue);
      manifest = await setProgress(input.runDir, queueInput.workItem.id, {
        status: "in_progress",
        attempts: queueInput.reviewPass,
        review_revision: reviewRevision,
        queue_state: "pending",
        queue_path: queuePath,
        active_action_id: null,
        active_action_attempt: 0,
        completed_action_ids: [],
        focused_review_path: null,
        fix_packet_supplement_path: null,
      }, [queuePath]);
    }

    let implementationResult = queueInput.implementationResult;
    const completed = queue.actions.filter((action) =>
      (currentProgress?.completed_action_ids ?? []).includes(action.action_id));
    let activeAction = resumableQueue && currentProgress.active_action_id
      ? queue.actions.find((action) => action.action_id === currentProgress.active_action_id) ?? null
      : null;
    if (
      resumableQueue
      && (
        completed.length !== (currentProgress.completed_action_ids ?? []).length
        || (currentProgress.active_action_id !== null
          && currentProgress.active_action_id !== undefined
          && activeAction === null)
      )
    ) {
      return {
        kind: "blocked",
        blocker: `Persisted Reviewer action progress does not match queue revision ${reviewRevision}`,
        blockerCode: "invalid_reviewer_action_queue",
      };
    }
    let activeAttempt = resumableQueue ? currentProgress.active_action_attempt ?? 0 : 0;
    let focusedDecision: "resolved" | "still_open" | "replan_required" | null = null;
    let effectKind: "complete" | "still_blocking" = "complete";
    let focusedReviewPath = currentProgress?.focused_review_path ?? null;
    const packetQueue = queue.contract_version === "review_fix_packet_v1";
    const persistedPacketId = async (): Promise<string> => {
      if (!currentProgress?.fix_packet_path || !currentProgress.fix_packet_sha256) {
        throw new Error("Persisted packet queue has no immutable packet pointer");
      }
      const packet = await loadReviewFixPacket(
        input.runDir,
        currentProgress.fix_packet_path,
        currentProgress.fix_packet_sha256,
      );
      if (packet.provenance.action_id !== activeAction?.action_id) {
        throw new Error("Persisted packet action identity does not match the active queue action");
      }
      return packet.provenance.packet_id;
    };
    if (resumableQueue && !focusedReviewPath && activeAction) {
      try {
        const packetId = packetQueue ? await persistedPacketId() : null;
        const discoveredPath = packetId
          ? packetFocusedReviewPath(packetId, activeAttempt)
          : actionResolutionReviewPath(
              queueInput.workItem.id,
              reviewRevision,
              activeAction.action_id,
              activeAttempt,
            );
        const discovered = packetQueue
          ? await loadExistingPacketFocusedReviewIfPresent({
              runDir: input.runDir,
              artifactPath: discoveredPath,
              packetPath: currentProgress.fix_packet_path,
              packetSha256: currentProgress.fix_packet_sha256,
              packetId: packetId!,
              actionAttempt: activeAttempt,
              verificationEvidencePath: currentProgress.mutation_verification_path,
            })
          : await loadExistingFocusedReviewIfPresent(input.runDir, discoveredPath);
        if (discovered !== null) {
          let adoptedSupplementPath: string | undefined;
          if (packetQueue && "packet" in discovered && discovered.review.decision === "still_open") {
            adoptedSupplementPath = await persistFixAttemptSupplement(
              input.runDir,
              packetSupplementForReview(discovered.packet, currentProgress.fix_packet_sha256!, discovered.review),
            );
          }
          focusedReviewPath = discoveredPath;
          manifest = await setProgress(input.runDir, queueInput.workItem.id, {
            ...currentProgress,
            focused_review_path: discoveredPath,
            ...(adoptedSupplementPath ? { fix_packet_supplement_path: adoptedSupplementPath } : {}),
          }, [discoveredPath, ...(adoptedSupplementPath ? [adoptedSupplementPath] : [])]);
        }
      } catch (error) {
        return {
          kind: "blocked",
          blocker: `Persisted focused review could not be recovered: ${errorMessage(error)}`,
          blockerCode: "operational_blocker",
        };
      }
    }
    let resumeReservedAction = activeAction !== null && !focusedReviewPath;
    let recoveryMutationUsed = legacyQualityRecovery && focusedReviewPath !== null;
    if (resumableQueue && focusedReviewPath && activeAction) {
      const packetId = packetQueue ? await persistedPacketId() : null;
      const focused = packetQueue
        ? await loadExistingPacketFocusedReviewIfPresent({
            runDir: input.runDir,
            artifactPath: focusedReviewPath,
            packetPath: currentProgress.fix_packet_path,
            packetSha256: currentProgress.fix_packet_sha256,
            packetId: packetId!,
            actionAttempt: activeAttempt,
            verificationEvidencePath: currentProgress.mutation_verification_path,
          })
        : await loadExistingFocusedReviewIfPresent(input.runDir, focusedReviewPath);
      if (focused === null) {
        return {
          kind: "blocked",
          blocker: `Persisted focused review is missing for ${activeAction.action_id} attempt ${activeAttempt}`,
          blockerCode: "operational_blocker",
        };
      }
      const recoveredDecision = packetQueue && "packet" in focused
        ? packetFocusedDecision(focused.review)
        : "review_revision" in focused ? focused.decision : "blocked";
      if (packetQueue ? recoveredDecision === "blocked" : (
        !("review_revision" in focused)
        || focused.review_revision !== reviewRevision
        || focused.action_id !== activeAction.action_id
        || focused.action_attempt !== activeAttempt
        || focused.decision === "blocked"
      )) {
        return {
          kind: "blocked",
          blocker: `Persisted focused review does not match ${activeAction.action_id} attempt ${activeAttempt}`,
          blockerCode: "operational_blocker",
        };
      }
      focusedDecision = recoveredDecision === "blocked" ? null : recoveredDecision;
    }

    while (true) {
      const transition = resumeReservedAction
        ? { kind: "retry" as const, action_id: activeAction!.action_id, attempt: activeAttempt }
        : nextQueueAction({
            queue,
            completedActionIds: completed.map((action) => action.action_id),
            activeActionId: activeAction?.action_id ?? null,
            activeActionAttempt: activeAttempt,
            focusedDecision,
            maxAttemptsPerAction: qualityGatePolicy!.max_attempts_per_reviewer_action,
          });
      resumeReservedAction = false;
      if (focusedDecision === "resolved" && activeAction) {
        completed.push(activeAction);
      }
      if (transition.kind === "block") {
        if (policyEffect && transition.blocker_code === "action_fix_exhausted") {
          effectKind = "still_blocking";
          break;
        }
        manifest = await setProgress(input.runDir, queueInput.workItem.id, {
          status: "blocked",
          attempts: queueInput.reviewPass,
          queue_state: "blocked",
          blocker_code: transition.blocker_code,
        });
        return {
          kind: "blocked",
          blocker: transition.blocker_code === "action_fix_exhausted"
            ? `Reviewer action ${activeAction?.action_id ?? "unknown"} remained open after ${activeAttempt} attempts`
            : `Reviewer action queue ${reviewRevision} became invalid`,
          blockerCode: transition.blocker_code,
        };
      }
      if (transition.kind === "replan") {
        if (policyEffect) {
          effectKind = "still_blocking";
          break;
        }
        return {
          kind: "blocked",
          blocker: `Focused Verifier requires replanning for ${activeAction?.action_id ?? "unknown"}`,
          blockerCode: "replan_required",
        };
      }
      if (transition.kind === "full_review") break;
      if (legacyQualityRecovery && recoveryMutationUsed) break;

      const selectedAction = queue.actions.find((action) => action.action_id === transition.action_id);
      if (!selectedAction) throw new Error(`Reviewer action queue is missing ${transition.action_id}`);
      activeAction = selectedAction;
      activeAttempt = transition.attempt;
      focusedDecision = null;
      const completedIds = completed.map((action) => action.action_id);
      const mutationAttempt = actionMutationAttempt(reviewRevision, activeAction, activeAttempt);
      const latestProgress = (await readManifestV2(input.runDir)).work_item_progress[queueInput.workItem.id];
      let packetState: Awaited<ReturnType<typeof packetForAction>> | null = null;
      if (queue.contract_version === "review_fix_packet_v1") {
        try {
          const criterion = queueInput.workItem.acceptance.find((entry) =>
            entry.id === selectedAction.acceptance_criterion || entry.statement === selectedAction.acceptance_criterion);
          packetState = await packetForAction(
            queueInput.workItem,
            selectedAction,
            reviewRevision,
            activeAttempt,
            criterion ? queueInput.policyCriterionAliases?.[criterion.id] : undefined,
          );
        } catch (error) {
          if (classifyFixPacketCompilationFailure(error) === "replan") {
            if (policyEffect) {
              return { kind: "blocked", blocker: errorMessage(error), blockerCode: "replan_required" };
            }
            return { kind: "blocked", blocker: errorMessage(error), blockerCode: "replan_required" };
          }
          return { kind: "blocked", blocker: `invalid_verifier_contract: ${errorMessage(error)}`, blockerCode: "operational_blocker" };
        }
      }
      const packetResultPath = packetState
        ? `${reviewFixPacketRoot(packetState.packet.provenance.packet_id)}/attempts/${activeAttempt}/hands-result.json`
        : null;
      let packetSupplement: FixAttemptSupplementV1 | null = null;
      let packetSupplementPath: string | null = null;
      if (packetState) {
        if (activeAttempt === 1) {
          if (
            latestProgress?.fix_packet_supplement_path !== null
            && latestProgress?.fix_packet_supplement_path !== undefined
            && latestProgress.active_action_id !== null
            && latestProgress.active_action_id !== undefined
          ) {
            throw new Error("First fix-packet attempt has a stale supplement pointer");
          }
        } else {
          packetSupplementPath = fixAttemptSupplementPath(packetState.packet.provenance.packet_id, activeAttempt);
          if (latestProgress?.fix_packet_supplement_path !== packetSupplementPath) {
            throw new Error(`Fix-packet attempt ${activeAttempt} has no exact durable supplement pointer`);
          }
          packetSupplement = await readOptionalValidatedArtifact(input.runDir, packetSupplementPath, fixAttemptSupplementV1Schema);
          if (
            packetSupplement === null
            || packetSupplement.packet_id !== packetState.packet.provenance.packet_id
            || packetSupplement.base_packet_sha256 !== packetState.sha256
            || packetSupplement.next_attempt !== activeAttempt
          ) {
            throw new Error(`Fix-packet attempt ${activeAttempt} supplement authority is invalid`);
          }
        }
      }
      const resumableActionSelfReviewPass = latestProgress?.self_review_pass;
      const exactBlockedActionSelfReview = latestProgress?.self_review_state === "invoking"
        && typeof resumableActionSelfReviewPass === "number"
        && resumableActionSelfReviewPass > 0
        && await isExactBlockedSelfReviewClaim(
          input.runDir,
          `self-review/${queueArtifactId}/attempt-${mutationAttempt}/pass-${resumableActionSelfReviewPass}.claim.json`,
          `self-review/${queueArtifactId}/attempt-${mutationAttempt}/pass-${resumableActionSelfReviewPass}.json`,
        );
      const resumeQualityGate = isResumableReviewerActionQualityGate(
        latestProgress,
        mutationAttempt,
        activeAction.action_id,
        activeAttempt,
        exactBlockedActionSelfReview,
      );
      if (!policyEffect && !resumeQualityGate && manifest.stage !== "fixing") {
        manifest = await transitionRun(input.runDir, "fixing", {
          actor: "runtime",
          payload: {
            work_item_id: queueInput.workItem.id,
            review_revision: reviewRevision,
            action_id: activeAction.action_id,
            action_attempt: activeAttempt,
          },
        });
      }
      if (!resumeQualityGate) {
        manifest = await setProgress(input.runDir, queueInput.workItem.id, {
          status: "in_progress",
          attempts: latestProgress?.attempts ?? queueInput.reviewPass,
          review_revision: reviewRevision,
          queue_state: "in_progress",
          queue_path: queuePath,
          active_action_id: activeAction.action_id,
          active_action_attempt: activeAttempt,
          completed_action_ids: completedIds,
          focused_review_path: null,
          ...(packetState ? {
            fix_packet_path: packetState.path,
            fix_packet_sha256: packetState.sha256,
            fix_packet_result_path: packetResultPath!,
            fix_packet_attempt: activeAttempt,
            fix_packet_supplement_path: packetSupplementPath,
          } : {}),
        });
      }

      const scopedItem = actionScopedWorkItem(queueInput.workItem, activeAction, completed, packetState?.packet);
      const beforeDiffPath = `action-diffs/${queueArtifactId}/revision-${reviewRevision}/${activeAction.action_id}/attempt-${activeAttempt}-before.diff`;
      const beforeFilesPath = `action-diffs/${queueArtifactId}/revision-${reviewRevision}/${activeAction.action_id}/attempt-${activeAttempt}-before-files.json`;
      let beforeDiff: string;
      try {
        beforeDiff = await readFile(resolve(input.runDir, beforeDiffPath), "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        beforeDiff = await currentDiff(scopedItem);
        await writeImmutableTextArtifact(input.runDir, beforeDiffPath, beforeDiff);
      }
      beforeDiff = boundedGeneratedLockfileDiff(beforeDiff);
      let beforeFiles: string[];
      try {
        const persistedBeforeFiles = JSON.parse(await readFile(resolve(input.runDir, beforeFilesPath), "utf8")) as unknown;
        if (!Array.isArray(persistedBeforeFiles)
          || persistedBeforeFiles.some((path) => typeof path !== "string" || path.trim() === "")
          || JSON.stringify(persistedBeforeFiles) !== JSON.stringify([...persistedBeforeFiles].sort())) {
          throw new Error(`Persisted Reviewer action changed-file baseline is invalid: ${beforeFilesPath}`);
        }
        beforeFiles = persistedBeforeFiles;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        beforeFiles = [...await changedFiles(input.worktreePath)].sort();
        await writeImmutableTextArtifact(input.runDir, beforeFilesPath, `${JSON.stringify(beforeFiles, null, 2)}\n`);
      }
      try {
        const actionMutationId = `${activeAction.action_id}:attempt-${activeAttempt}`;
        if (resumeQualityGate) {
          const persisted = await loadPersistedImplementation(input.runDir, latestProgress, scopedItem);
          implementationResult = {
            implementation: persisted,
            reportPath: runArtifactRelativePath(input.runDir, latestProgress.implementation_path as string),
            invocation: {} as never,
          };
          if (legacyQualityRecovery) recoveryMutationUsed = true;
          if (policyEffect) {
            if (latestProgress?.fix_reservation_id !== undefined
              && latestProgress.fix_reservation_id !== actionMutationId) {
              throw new Error(`Persisted fix reservation does not match ${activeAction.action_id} attempt ${activeAttempt}`);
            }
            if (latestProgress?.fix_reservation_id === actionMutationId) {
              await commitReservedFixSlot({
                run_dir: input.runDir,
                cycle: queueInput.cycle!,
                owner: queueInput.effectOwner!,
                mutation_id: actionMutationId,
                effect_action: policyEffectAction!,
              });
              manifest = await setProgress(input.runDir, queueInput.workItem.id, {
                ...(await readManifestV2(input.runDir)).work_item_progress[queueInput.workItem.id],
                fix_reservation_id: undefined,
              });
            } else {
              await assertChargedFixSlot({
                run_dir: input.runDir,
                cycle: queueInput.cycle!,
                owner: queueInput.effectOwner!,
                mutation_id: actionMutationId,
              });
            }
          }
        } else {
          if (policyEffect) {
            if (latestProgress?.fix_reservation_id && latestProgress.fix_reservation_id !== actionMutationId) {
              throw new Error(`Persisted fix reservation does not match ${activeAction.action_id} attempt ${activeAttempt}`);
            }
            const reservation = await reserveFixSlot({
              run_dir: input.runDir,
              cycle: queueInput.cycle!,
              owner: queueInput.effectOwner!,
              mutation_id: actionMutationId,
              effect_action: policyEffectAction!,
            });
            if (reservation.status === "exhausted") {
              effectKind = "still_blocking";
              break;
            }
            manifest = await setProgress(input.runDir, queueInput.workItem.id, {
              ...(await readManifestV2(input.runDir)).work_item_progress[queueInput.workItem.id],
              fix_reservation_id: actionMutationId,
            });
          }
          const handsItem = manifest.workflow_protocol === "bounded-context-v1"
            ? queueInput.workItem
            : scopedItem;
          implementationResult = packetState
            ? policyEffect
              ? await invokeClaimedActionHands({
                  cycle: queueInput.cycle!, workItem: handsItem, action: activeAction,
                  actionAttempt: activeAttempt, mutationAttempt,
                  invokeMutation: (profile) => invokePacketHands(
                    handsItem, packetState!.packet, activeAttempt, mutationAttempt,
                    completed, packetSupplement, profile, queueInput.recoverStartedPacketInvocation,
                  ),
                })
              : await invokePacketHands(handsItem, packetState.packet, activeAttempt, mutationAttempt, completed, packetSupplement)
            : policyEffect
            ? await invokeClaimedActionHands({
                cycle: queueInput.cycle!,
                workItem: handsItem,
                action: activeAction,
                actionAttempt: activeAttempt,
                mutationAttempt,
              })
            : legacyQualityRecovery
              ? await invokeLegacyQualityRecovery(
                  handsItem,
                  mutationAttempt,
                  [activeAction],
                  [...(reviews[queueInput.workItem.id] ?? []), queueInput.review],
                  queueInput.implementationResult.implementation,
                )
              : await invokeHands(handsItem, mutationAttempt, "primary_fix", [activeAction]);
          if (legacyQualityRecovery) recoveryMutationUsed = true;
          if (packetState) {
            const completedOnlyFiles = new Set(completed.flatMap((action) => action.remediation?.completion_contract.expected_changed_files ?? []));
            const activeExpected = new Set(packetState.packet.completion_contract.expected_changed_files);
            const existedBeforeAction = new Set(beforeFiles);
            const actual = await changedFiles(input.worktreePath);
            const scopedActual = actual.filter((path) =>
              activeExpected.has(path)
              || (!existedBeforeAction.has(path) && !completedOnlyFiles.has(path)));
            if (queueInput.recoverStartedPacketInvocation) {
              const missingExpected = [...activeExpected].filter((path) => !scopedActual.includes(path));
              if (missingExpected.length > 0) {
                const claimId = [queueInput.cycle!.effect_id, queueInput.cycle!.review_revision, activeAction.action_id, activeAttempt].join(":");
                const claimRoot = `reviews/action-invocations/${Buffer.from(claimId).toString("base64url")}`;
                const gitClaim = actionGitClaimSchema.parse(await readRunArtifact(input.runDir, `${claimRoot}/git-claim.json`));
                const gitCompletion = actionGitCompletionSchema.parse(await readRunArtifact(input.runDir, `${claimRoot}/git-completion.json`));
                if (
                  gitCompletion.effect_id !== gitClaim.effect_id
                  || gitCompletion.review_revision !== gitClaim.review_revision
                  || gitCompletion.action_id !== gitClaim.action_id
                  || gitCompletion.action_attempt !== gitClaim.action_attempt
                  || gitCompletion.pre_action_head !== gitClaim.pre_action_head
                  || gitCompletion.pre_action_tree !== gitClaim.pre_action_tree
                ) throw new Error("Committed packet recovery Git provenance is inconsistent");
                const reportSha256 = createHash("sha256")
                  .update(await readFile(resolve(input.runDir, implementationResult.reportPath)))
                  .digest("hex");
                if (gitCompletion.report_sha256 !== reportSha256) {
                  throw new Error("Committed packet recovery report hash is not current authority");
                }
                const evidence = await committedRecoveryEvidence({
                  repoRoot: input.worktreePath,
                  baseCommit: gitClaim.pre_action_head,
                  paths: missingExpected,
                });
                assertRecoveredFixPacketCommitEvidence({
                  packet: packetState.packet,
                  missingExpectedPaths: missingExpected,
                  preActionHead: gitClaim.pre_action_head,
                  preActionTree: gitClaim.pre_action_tree,
                  postActionBlobs: gitCompletion.post_action_blobs,
                  evidence,
                });
                scopedActual.push(...missingExpected);
              }
            }
            assertFixPacketChangedFiles(packetState.packet, scopedActual);
          }
          manifest = await setProgress(input.runDir, queueInput.workItem.id, {
            status: "in_progress",
            attempts: mutationAttempt,
            ...(legacyQualityRecovery
              ? {}
              : { primary_fix_attempts: Math.max(queueInput.reviewPass, latestProgress?.primary_fix_attempts ?? 0) }),
            mutation_kind: legacyQualityRecovery ? "quality_recovery" : "reviewer_action",
            ...(legacyQualityRecovery ? { recovery_state: "in_progress" as const } : {}),
            implementation_path: implementationResult.reportPath,
            verification_path: undefined,
            verification_scope: undefined,
            verification_work_item_id: undefined,
            verification_issue_number: undefined,
            self_review_pass: 0,
            self_review_state: "pending" as const,
            mutation_verification_path: undefined,
            self_review_paths: undefined,
            self_review_verification_paths: undefined,
            ...(packetState ? {
              fix_packet_path: packetState.path,
              fix_packet_sha256: packetState.sha256,
              fix_packet_result_path: packetResultPath!,
              fix_packet_attempt: activeAttempt,
              fix_packet_supplement_path: packetSupplementPath,
            } : {}),
          }, [implementationResult.reportPath]);
          await input.dependencies?.afterCheckpoint?.("after_action_progress");
          if (policyEffect) {
            await commitReservedFixSlot({
              run_dir: input.runDir,
              cycle: queueInput.cycle!,
              owner: queueInput.effectOwner!,
              mutation_id: actionMutationId,
              effect_action: policyEffectAction!,
            });
            manifest = await setProgress(input.runDir, queueInput.workItem.id, {
              ...(await readManifestV2(input.runDir)).work_item_progress[queueInput.workItem.id],
              fix_reservation_id: undefined,
            });
            await input.dependencies?.afterCheckpoint?.("after_action_reservation_charge");
            manifest = await readManifestV2(input.runDir);
          }
          await input.dependencies?.afterCheckpoint?.("after_action_mutation");
        }
        if (!policyEffect && manifest.stage !== "verifying") {
          manifest = await transitionRun(input.runDir, "verifying", {
            actor: "runtime",
            payload: {
              work_item_id: queueInput.workItem.id,
              review_revision: reviewRevision,
              action_id: activeAction.action_id,
              action_attempt: activeAttempt,
            },
          });
        }
        const gateResult = await runMutationQualityGate({
          workItem: scopedItem,
          parentAttempt: mutationAttempt,
          mutationKind: legacyQualityRecovery ? "quality_recovery" : "reviewer_action",
          activeAction,
          completedActions: completed,
          implementation: implementationResult.implementation,
          phase: scopedItem.id === "integrated" ? "pre_pr" : "work_item",
        });
        implementationResult = { ...implementationResult, implementation: gateResult.implementation };
        const deterministicFailures = verificationFailureReasons(
          gateResult.finalVerification,
          scopedItem.browser_checks,
        );
        if (!policyEffect) {
          manifest = await transitionRun(input.runDir, "verifier_review", {
            actor: "runtime",
            payload: {
              work_item_id: queueInput.workItem.id,
              review_revision: reviewRevision,
              action_id: activeAction.action_id,
              action_attempt: activeAttempt,
              focused: deterministicFailures.length === 0,
            },
          });
        }
        if (deterministicFailures.length > 0) {
          if (packetState) {
            const deterministicSupplement = fixAttemptSupplementV1Schema.parse({
              packet_id: packetState.packet.provenance.packet_id,
              base_packet_sha256: packetState.sha256,
              next_attempt: activeAttempt + 1,
              unsatisfied_condition_ids: packetState.packet.verification.success_conditions.map((condition) => condition.id),
              remaining_problem: deterministicFailures.join("; "),
              required_next_fix: "Resolve the recorded deterministic verification failures without changing packet scope.",
              additional_evidence_refs: [gateResult.finalVerification.evidence_path],
            });
            const deterministicSupplementPath = await persistFixAttemptSupplement(
              input.runDir,
              deterministicSupplement,
            );
            manifest = await setProgress(input.runDir, queueInput.workItem.id, {
              ...(await readManifestV2(input.runDir)).work_item_progress[queueInput.workItem.id],
              fix_packet_supplement_path: deterministicSupplementPath,
            }, [deterministicSupplementPath]);
          }
          focusedDecision = actionAttemptDecision({ deterministicFailures, focusedDecision: null });
          continue;
        }
        const focusedResult = packetState
          ? await packetVerifier({
              runDir: input.runDir, worktreePath: input.worktreePath, packet: packetState.packet,
              actionAttempt: activeAttempt, intake: input.intake, codex: input.codex,
              beforeDiff, afterDiff: await currentDiff(scopedItem), verificationEvidence: gateResult.finalVerification,
              selfReviewReports: gateResult.selfReviews,
              planRevision: budgetPlanRevision(),
              reviewRevision,
              actionId: activeAction.action_id,
              budget,
            })
          : await actionVerifier({
              runDir: input.runDir,
              worktreePath: input.worktreePath,
              workItem: scopedItem,
              intake: input.intake,
              codex: input.codex,
              reviewRevision,
              action: activeAction,
              actionAttempt: activeAttempt,
              beforeDiff,
              afterDiff: await currentDiff(scopedItem),
              activeVerification: gateResult.finalVerification,
              completedVerification: [],
              selfReviewReports: gateResult.selfReviews,
              planRevision: budgetPlanRevision(),
              budget,
            });
        await input.dependencies?.afterCheckpoint?.("after_focused_review_write");
        const packetReview = packetState ? (focusedResult as FixPacketResolutionResult).review : null;
        const packetDecision = packetReview
          ? packetReview.decision === "resolved" ? "resolved"
            : packetReview.decision === "packet_contradiction" ? "replan_required"
            : packetReview.decision === "still_open" ? "still_open"
            : "blocked"
          : null;
        const effectiveDecision = packetState ? packetDecision! : (focusedResult as ActionResolutionResult).review.decision;
        focusedDecision = effectiveDecision === "blocked"
          ? null
          : actionAttemptDecision({ deterministicFailures, focusedDecision: effectiveDecision });
        let nextSupplementPath: string | undefined;
        if (packetState && packetReview?.decision === "still_open") {
          nextSupplementPath = await persistFixAttemptSupplement(
            input.runDir,
            packetSupplementForReview(packetState.packet, packetState.sha256, packetReview),
          );
          await input.dependencies?.afterCheckpoint?.("after_packet_supplement_write");
        }
        if (effectiveDecision === "blocked") {
          return {
            kind: "blocked",
            blocker: `Focused Verifier blocked Reviewer action ${activeAction.action_id}`,
            blockerCode: "operational_blocker",
          };
        }
        manifest = await setProgress(input.runDir, queueInput.workItem.id, {
          status: "in_progress",
          attempts: mutationAttempt,
          review_revision: reviewRevision,
          queue_state: "in_progress",
          queue_path: queuePath,
          active_action_id: activeAction.action_id,
          active_action_attempt: activeAttempt,
          completed_action_ids: completedIds,
          focused_review_path: focusedResult.reviewPath,
          ...(nextSupplementPath ? { fix_packet_supplement_path: nextSupplementPath } : {}),
        }, [focusedResult.reviewPath, ...(nextSupplementPath ? [nextSupplementPath] : [])]);
      } catch (error) {
        return {
          kind: "blocked",
          blocker: `Reviewer action ${activeAction.action_id} failed operationally: ${errorMessage(error)}`,
          blockerCode: error instanceof NonRetryableHandsResultError
            ? "invalid_reviewer_action_queue"
            : "operational_blocker",
        };
      }
    }

    const nextReviewPass = queueInput.reviewPass + 1;
    manifest = await setProgress(input.runDir, queueInput.workItem.id, {
      status: "in_progress",
      attempts: nextReviewPass,
      review_revision: reviewRevision,
      queue_state: "in_progress",
      queue_path: queuePath,
      active_action_id: null,
      active_action_attempt: 0,
      completed_action_ids: completed.map((action) => action.action_id),
      focused_review_path: null,
    });
    if (!policyEffect && manifest.stage === "verifier_review") {
      manifest = await transitionRun(input.runDir, "fixing", {
        actor: "runtime",
        payload: { work_item_id: queueInput.workItem.id, review_revision: reviewRevision, queue_complete: true },
      });
    }
    if (!policyEffect && manifest.stage === "fixing") {
      manifest = await transitionRun(input.runDir, "verifying", {
        actor: "runtime",
        payload: { work_item_id: queueInput.workItem.id, pass: nextReviewPass, review_revision: reviewRevision },
      });
    }
    const queueIdentity = verificationIdentityForWorkItem(queueInput.workItem, githubDelivery, manifest);
    const savedEvidencePath = verificationEvidencePath(queueIdentity, nextReviewPass);
    let normalizedEvidence: VerificationEvidence;
    const latestProgress = (await readManifestV2(input.runDir)).work_item_progress[queueInput.workItem.id];
    if (latestProgress?.verification_path === savedEvidencePath) {
      normalizedEvidence = await loadPersistedEvidence(
        input.runDir,
        latestProgress,
        queueIdentity,
        nextReviewPass,
      );
    } else {
      const rawEvidence = await verificationRunner({
        repoRoot: input.worktreePath,
        runDir: input.runDir,
        identity: queueIdentity,
        ...(queueIdentity.scope === "github" ? { issueNumber: queueIdentity.issue_number } : {}),
        mode: githubDelivery ? "github" : "local",
        commands: queueInput.workItem.verification_commands.map((command) => command.argv),
        stopOnFailure: true,
        commandIds: queueInput.workItem.verification_commands.map((command) => command.id),
        budget,
        expectedArtifacts: queueInput.workItem.expected_artifacts,
        browserChecks: queueInput.workItem.browser_checks,
        attempt: nextReviewPass,
        resumeExistingNamespace: true,
      });
      normalizedEvidence = validateEvidenceForIdentity(rawEvidence, queueIdentity, nextReviewPass);
      await persistVerificationEvidence(input.runDir, normalizedEvidence, queueIdentity, nextReviewPass);
    }
    manifest = await setProgress(input.runDir, queueInput.workItem.id, {
      status: "in_progress",
      attempts: nextReviewPass,
      verification_path: savedEvidencePath,
      ...verificationProgressIdentity(queueIdentity),
    }, [savedEvidencePath]);
    if (!policyEffect && manifest.stage !== "verifier_review") {
      manifest = await transitionRun(input.runDir, "verifier_review", {
        actor: "runtime",
        payload: { work_item_id: queueInput.workItem.id, pass: nextReviewPass, review_revision: reviewRevision },
      });
    }
    if (policyEffect) {
      return {
        kind: effectKind,
        successful_hands_fixes: Math.max(
          0,
          ((await readManifestV2(input.runDir)).review_accounting?.fix_cycles_used ?? 0)
            - queueInput.cycle!.accounting_before.fix_cycles_used,
        ),
        evidence_paths: [savedEvidencePath],
        implementationResult,
        verification: normalizedEvidence,
        reviewPass: nextReviewPass,
        savedEvidencePath,
      };
    }
    let reviewResult: VerifyWorkItemResult;
    try {
      const persistedReview = await loadPersistedReview(
        input.runDir,
        queueInput.workItem.id,
        nextReviewPass,
      );
      reviewResult = { review: persistedReview, reviewPath: `reviews/${queueInput.workItem.id}/attempt-${nextReviewPass}.json`, invocation: {} as never };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const boundedContext = await boundedVerifierInvocationContext(
        queueInput.workItem,
        "work_item",
        nextReviewPass,
      );
      const verifierInput: VerifyWorkItemInput = boundedContext ? {
        runDir: input.runDir,
        worktreePath: input.worktreePath,
        workItem: queueInput.workItem,
        ...boundedContext,
        intake: input.intake,
        codex: input.codex,
        attempt: nextReviewPass,
        budget,
      } : {
        runDir: input.runDir, worktreePath: input.worktreePath, workItem: queueInput.workItem,
        implementation: implementationResult.implementation, verification: normalizedEvidence,
        intake: input.intake, codex: input.codex, attempt: nextReviewPass, budget,
      };
      reviewResult = await verifier(verifierInput);
      await input.dependencies?.afterCheckpoint?.("after_queue_full_review");
    }
    manifest = await setProgress(input.runDir, queueInput.workItem.id, {
      status: "in_progress",
      attempts: nextReviewPass,
      queue_state: "complete",
      review_path: reviewResult.reviewPath,
    }, [reviewResult.reviewPath]);
    return {
      kind: "review",
      implementationResult,
      verification: normalizedEvidence,
      reviewResult,
      reviewPass: nextReviewPass,
      savedEvidencePath,
    };
  };

  type PolicyOrderedQueueResult =
    | ((Extract<FixEffectResult, { kind: "complete" | "still_blocking" }>) & {
      implementationResult: HandsWorkItemResult;
      verification: VerificationEvidence;
      reviewPass: number;
      savedEvidencePath: string;
    })
    | { kind: "replan_required"; blocker: string }
    | Extract<FixEffectResult, { kind: "operationally_blocked" }>;

  const executeOrderedFixEffect = async (
    cycle: ReviewCycleState,
    queue: Omit<Parameters<typeof runOrderedActionQueue>[0], "cycle" | "effectOwner">,
    effectOwner: string,
  ): Promise<PolicyOrderedQueueResult> => {
    const result = await runOrderedActionQueue({ ...queue, cycle, effectOwner });
    if (result.kind === "review") {
      throw new Error("Policy ordered fix effect returned legacy review authority");
    }
    if (result.kind === "blocked") {
      if (result.blockerCode === "replan_required") {
        return { kind: "replan_required", blocker: result.blocker };
      }
      return {
        kind: "operationally_blocked",
        blocker: {
          code: result.blockerCode === "operational_blocker"
            ? result.blocker.startsWith("invalid_verifier_contract:")
              ? "invalid_verifier_contract"
              : "transport_failure"
            : "corrupt_state",
          message: result.blocker,
          phase: "work_item",
          evidence_refs: [],
        },
      };
    }
    return result;
  };

  const warningAuthorizationForReview = async (authorizationInput: {
    workItemId: string;
    reviewRevision: number;
    policy: NonNullable<RunManifestV2["review_policy_snapshot"]>;
    accounting: NonNullable<RunManifestV2["review_accounting"]>;
    findings: EngineFinding[];
    reviewPath: string;
    verificationPath: string;
  }): Promise<WarningContinuationAuthorization | null> => {
    if (
      authorizationInput.policy.on_limit !== "continue_with_warning"
      || authorizationInput.accounting.fix_cycles_used < authorizationInput.policy.max_fix_cycles
      || authorizationInput.findings.some((finding) =>
        ["blocking", "fix_in_scope", "requires_replan"].includes(finding.disposition)
        && (finding.severity === "critical" || finding.severity === "high"))
    ) return null;
    return loadOrCreateWarningAuthorization({
      run_dir: input.runDir,
      work_item_id: authorizationInput.workItemId,
      review_revision: authorizationInput.reviewRevision,
      policy: authorizationInput.policy,
      findings: authorizationInput.findings,
      evidence_snapshot: [...new Set([
        authorizationInput.reviewPath,
        authorizationInput.verificationPath,
        ...authorizationInput.findings.flatMap((finding) => finding.evidence_refs),
      ])].sort(),
    });
  };

  const beginPolicyPhaseReview = async (phaseInput: {
    phase: ReviewPhase;
    workItem: WorkItem;
    review: VerifierReview;
    reviewPath: string;
    verification: VerificationEvidence;
    verificationPath: string;
    attempt: number;
  }): Promise<{ cycle: ReviewCycleState; findings: EngineFinding[]; owner: string; authorization: WarningContinuationAuthorization | null }> => {
    const current = await readManifestV2(input.runDir);
    const policy = current.review_policy_snapshot;
    const accounting = current.review_accounting;
    if (!policy || !accounting) throw new Error(`Policy phase ${phaseInput.phase} requires snapshotted policy accounting`);
    const criteria = phaseInput.phase === "work_item"
      ? workItemPolicyCriteria(approvedCriteria, phaseInput.workItem.id)
      : integratedPolicyCriteria(approvedCriteria);
    if (!criteria) throw new Error(`Policy phase ${phaseInput.phase} is missing approved acceptance-criterion provenance`);
    if (!current.release_guards?.length) throw new Error(`Policy phase ${phaseInput.phase} is missing release-guard provenance`);
    const progress = current.work_item_progress[phaseInput.workItem.id];
    const expectedReviewPath = controllerArtifactRelativePath(input.runDir, phaseInput.reviewPath);
    const sameReviewSource = progress?.review_path === expectedReviewPath
      && progress.verification_path === phaseInput.verificationPath;
    const pointedCycle = typeof progress?.review_cycle_path === "string"
      ? reviewCycleStateSchema.parse(await readRunArtifact<unknown>(input.runDir, progress.review_cycle_path))
      : null;
    const reusablePointer = pointedCycle?.phase === phaseInput.phase;
    const expectedRevision = sameReviewSource && progress?.review_revision && reusablePointer
      ? progress.review_revision
      : accounting.review_revision + 1;
    if (!(sameReviewSource && reusablePointer)) {
      await setProgress(input.runDir, phaseInput.workItem.id, {
        ...(progress ?? { status: "in_progress", attempts: phaseInput.attempt }),
        attempts: phaseInput.attempt,
        review_path: expectedReviewPath,
        verification_path: phaseInput.verificationPath,
        review_revision: expectedRevision,
        review_cycle_path: undefined,
        review_effect_id: undefined,
      }, [expectedReviewPath, phaseInput.verificationPath]);
    }
    let cycle: ReviewCycleState | null = null;
    let authorization: WarningContinuationAuthorization | null = null;
    try {
      cycle = reviewCycleStateSchema.parse(await readRunArtifact<unknown>(
        input.runDir,
        reviewDecisionPath(phaseInput.workItem.id, expectedRevision),
      ));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (cycle) {
      const reference = cycle.work_item_progress_reference;
      if (
        cycle.work_item_id !== phaseInput.workItem.id
        || cycle.phase !== phaseInput.phase
        || cycle.review_revision !== expectedRevision
        || cycle.policy_hash !== hashReviewPolicy(policy)
        || !reference
        || reference.attempts !== phaseInput.attempt
        || reference.review_path !== expectedReviewPath
        || reference.verification_path !== phaseInput.verificationPath
      ) throw new Error(`Persisted ${phaseInput.phase} policy cycle provenance is invalid`);
      cycle = await beginReviewCycle({
        run_dir: input.runDir,
        work_item_id: cycle.work_item_id,
        phase: cycle.phase,
        review_revision: cycle.review_revision,
        policy_hash: cycle.policy_hash,
        finding_ids: cycle.finding_ids,
        accounting_before: cycle.accounting_before,
        work_item_progress_reference: reference,
        evaluate: () => { throw new Error("Persisted phase cycle must not be reevaluated"); },
      });
    } else {
      const normalized = normalizeReviewInputs({
        work_item_id: phaseInput.workItem.id,
        phase: phaseInput.phase,
        review_revision: expectedRevision,
        review: phaseInput.review,
        verification: phaseInput.verification,
        criteria,
        criterion_aliases: criterionAliasesForAcceptance(phaseInput.workItem.acceptance, criteria),
        release_guards: current.release_guards,
        severity_defaults: policy.severity_defaults,
        verification_criterion_ref: criteria[0]!.ref,
        writable_paths: phaseInput.workItem.file_contract
          .filter((entry) => entry.permission !== "read_only")
          .map((entry) => entry.path),
      });
      if (normalized.operational_blocker) {
        throw new Error(`${normalized.operational_blocker.code}: ${normalized.operational_blocker.message}`);
      }
      const findings: EngineFinding[] = [];
      for (const finding of normalized.findings) {
        findings.push(await recordFindingRevision(input.runDir, {
          work_item_id: finding.work_item_id,
          source: finding.source,
          severity: finding.severity,
          disposition: finding.disposition,
          criterion_ref: finding.criterion_ref,
          normalized_location: finding.normalized_location,
          problem_class: finding.problem_class,
          problem: finding.problem,
          required_fix: finding.required_fix,
          evidence_refs: finding.evidence_refs,
          review_revision: expectedRevision,
        }));
      }
      authorization = await warningAuthorizationForReview({
        workItemId: phaseInput.workItem.id,
        reviewRevision: expectedRevision,
        policy,
        accounting,
        findings,
        reviewPath: expectedReviewPath,
        verificationPath: phaseInput.verificationPath,
      });
      cycle = await beginReviewCycle({
        run_dir: input.runDir,
        work_item_id: phaseInput.workItem.id,
        phase: phaseInput.phase,
        review_revision: expectedRevision,
        policy_hash: hashReviewPolicy(policy),
        finding_ids: [...new Set(findings.map((finding) => finding.finding_id))].sort(),
        accounting_before: accounting,
        work_item_progress_reference: {
          attempts: phaseInput.attempt,
          review_path: expectedReviewPath,
          verification_path: phaseInput.verificationPath,
        },
        evaluate: () => evaluateReviewPolicy({
          policy,
          findings,
          accounting,
          phase: phaseInput.phase,
          operational_blocker: null,
          replan_patch_pending: false,
          authorization,
          quality_recovery: qualityRecoveryEligibilitySnapshot(current, phaseInput.workItem.id),
        }),
      });
    }
    const findings = await loadFindingRevisionRecords(
      input.runDir,
      phaseInput.workItem.id,
      cycle.review_revision,
      cycle.finding_ids,
    );
    const latest = await readManifestV2(input.runDir);
    if (cycle.decision.action === "continue_with_warning" && authorization === null) {
      authorization = await warningAuthorizationForReview({
        workItemId: phaseInput.workItem.id,
        reviewRevision: cycle.review_revision,
        policy,
        accounting: cycle.accounting_before,
        findings,
        reviewPath: cycle.work_item_progress_reference!.review_path,
        verificationPath: cycle.work_item_progress_reference!.verification_path,
      });
      if (authorization === null) throw new Error("Persisted warning decision is missing authorization");
    }
    if (!isReviewEffectAction(cycle.decision.action) && cycle.decision.action !== "await_plan_approval") {
      await writeConvergenceReport({
        run_dir: input.runDir,
        cycle,
        policy,
        accounting: latest.review_accounting!,
        finding_index: latest.finding_index ?? {},
        findings,
        release_guards: latest.release_guards ?? [],
        authorization,
      });
    }
    return {
      cycle,
      findings,
      owner: `runtime:${phaseInput.phase}:${phaseInput.workItem.id}`,
      authorization,
    };
  };

  const resolvePhaseReplanTarget = (findings: EngineFinding[]): WorkItem => {
    const currentCriteria = integratedPolicyCriteria(approvedCriteria) ?? [];
    const refsByItem = new Map<string, Set<string>>();
    for (const [workItemId, criteria] of Object.entries(approvedCriteria)) {
      refsByItem.set(workItemId, new Set(criteria.map((criterion) => criterion.ref)));
    }
    const candidates: Array<{ finding: EngineFinding; target_id: string }> = [];
    for (const finding of findings.filter((candidate) => candidate.disposition === "requires_replan" || candidate.disposition === "blocking" || candidate.disposition === "fix_in_scope")) {
      if (finding.source === "release_guard") throw new Error("Integrated replan cannot project an unresolved release guard onto a work item");
      const matches = [...refsByItem.entries()].filter(([, refs]) => refs.has(finding.criterion_ref));
      if (matches.length !== 1) throw new Error(`Integrated replan criterion does not resolve to exactly one approved work item: ${finding.criterion_ref}`);
      candidates.push({ finding, target_id: matches[0]![0] });
    }
    const verifierReplans = candidates.filter(({ finding }) =>
      finding.source === "verifier"
      && (finding.disposition === "requires_replan" || finding.disposition === "blocking"));
    const severityRank = { critical: 4, high: 3, medium: 2, low: 1 } as const;
    const targetId = (verifierReplans.length > 0 ? verifierReplans : candidates)
      .sort((left, right) =>
        severityRank[right.finding.severity] - severityRank[left.finding.severity]
        || orderedWorkItems.findIndex((item) => item.id === left.target_id)
          - orderedWorkItems.findIndex((item) => item.id === right.target_id))[0]?.target_id;
    if (!targetId) throw new Error("Integrated replan has no approved work-item target");
    const target = orderedWorkItems.find((candidate) => candidate.id === targetId);
    if (!target || currentCriteria.length === 0) throw new Error(`Integrated replan target is unavailable: ${targetId}`);
    return target;
  };

  const createPhaseReplan = async (
    phasePolicy: { cycle: ReviewCycleState; findings: EngineFinding[]; owner: string },
    claim: Awaited<ReturnType<typeof claimReviewEffect>>,
    attempt: number,
  ): Promise<{ blocker: string; pendingReplanBoundary?: PreparedReplanApprovalCoordinates }> => {
    const target = resolvePhaseReplanTarget(phasePolicy.findings);
    const current = await readManifestV2(input.runDir);
    const summary = current.convergence_reports?.[phasePolicy.cycle.work_item_id];
    if (!summary || summary.recommended_action !== "create_replan") {
      throw new Error("Phase create_replan requires its integrated convergence report");
    }
    const report = convergenceReportSchema.parse(await readRunArtifact<unknown>(input.runDir, summary.path));
    const replan = await createReplanPatch({
      run_dir: input.runDir,
      repo_root: current.worktree_path ?? current.repo_root,
      codex: input.codex,
      target_work_item: target,
      source_work_item_id: phasePolicy.cycle.work_item_id,
      base_plan_revision: report.plan_revision,
      unresolved_finding_ids: report.unresolved_finding_ids,
      convergence_report_path: summary.path,
      release_guards: current.release_guards ?? [],
      evidence_paths: report.evidence_refs,
      model_profile: input.intake.roles.brain,
      existing_only: claim.status === "complete",
      budget,
    });
    const patchPath = controllerArtifactRelativePath(input.runDir, replanArtifactPathForValidation(input.runDir, replan.path));
    const blocker = `Review policy requires replanning ${target.id} from ${phasePolicy.cycle.phase}`;
    if (claim.status === "acquired") {
      await input.dependencies?.afterCheckpoint?.("after_replan_patch_write");
      await completeReviewEffect({
        run_dir: input.runDir,
        cycle: phasePolicy.cycle,
        owner: phasePolicy.owner,
        outcome: "complete",
        result: { blocker, replan_patch_path: patchPath, target_work_item_id: target.id },
      });
      await input.dependencies?.afterCheckpoint?.("after_replan_effect_complete");
    }
    manifest = await recordReplanAwaitingState(input.runDir, blocker, phasePolicy.cycle.work_item_id, attempt, patchPath, target.id);
    await input.dependencies?.afterCheckpoint?.("after_replan_pointer_write");
    if (manifest.stage !== "replanning") {
      manifest = await transitionRun(input.runDir, "replanning", { actor: "runtime", payload: { blocker, final: true, target_work_item_id: target.id } });
    }
    const prepared = await finalizeRuntimePreparedReplan(
      input,
      await prepareRuntimeReplanApprovalBoundary(input, target.id),
    );
    manifest = prepared.manifest;
    return {
      blocker: prepared.blocker ?? blocker,
      ...(prepared.state === "pending" ? { pendingReplanBoundary: prepared.coordinates } : {}),
    };
  };

  const claimPhaseReviewEffect = async (
    phasePolicy: { cycle: ReviewCycleState; findings: EngineFinding[]; owner: string },
  ): Promise<Awaited<ReturnType<typeof claimReviewEffect>>> => {
    try {
      return await claimReviewEffect({ run_dir: input.runDir, cycle: phasePolicy.cycle, owner: phasePolicy.owner });
    } catch (error) {
      if (!(error instanceof AmbiguousEffectError)) throw error;
      if (isReviewEffectAction(phasePolicy.cycle.decision.action)) {
        const current = await readManifestV2(input.runDir);
        const progress = current.work_item_progress[phasePolicy.cycle.work_item_id];
        return recoverClaimedReviewEffectBeforeQueue({
          run_dir: input.runDir,
          cycle: phasePolicy.cycle,
          owner: phasePolicy.owner,
          queue_persisted: typeof progress.queue_path === "string",
        });
      }
      if (phasePolicy.cycle.decision.action !== "create_replan") throw error;
      const target = resolvePhaseReplanTarget(phasePolicy.findings);
      const current = await readManifestV2(input.runDir);
      const summary = current.convergence_reports?.[phasePolicy.cycle.work_item_id];
      if (!summary || summary.recommended_action !== "create_replan") throw error;
      const report = convergenceReportSchema.parse(await readRunArtifact<unknown>(input.runDir, summary.path));
      const replan = await createReplanPatch({
        run_dir: input.runDir,
        repo_root: current.worktree_path ?? current.repo_root,
        codex: input.codex,
        target_work_item: target,
        source_work_item_id: phasePolicy.cycle.work_item_id,
        base_plan_revision: report.plan_revision,
        unresolved_finding_ids: report.unresolved_finding_ids,
        convergence_report_path: summary.path,
        release_guards: current.release_guards ?? [],
        evidence_paths: report.evidence_refs,
        model_profile: input.intake.roles.brain,
        existing_only: true,
        budget,
      });
      const patchPath = controllerArtifactRelativePath(input.runDir, replanArtifactPathForValidation(input.runDir, replan.path));
      const blocker = `Review policy requires replanning ${target.id} from ${phasePolicy.cycle.phase}`;
      const completed = await completeReviewEffect({
        run_dir: input.runDir,
        cycle: phasePolicy.cycle,
        owner: phasePolicy.owner,
        outcome: "complete",
        result: { blocker, replan_patch_path: patchPath, target_work_item_id: target.id },
      });
      await input.dependencies?.afterCheckpoint?.("after_replan_effect_complete");
      return { status: "complete", cycle: completed };
    }
  };

  const gateIntegratedPolicyEffect = async (gateInput: {
    policy: { cycle: ReviewCycleState };
    scopeId: "integrated:final" | "integrated:post-pr";
    operation: "final-integrated-fix" | "post-pr-fix";
    verificationPath: string;
    reviewPath: string;
  }) => {
    const current = await readManifestV2(input.runDir);
    const currentProgress = current.work_item_progress.integrated;
    const implementationPath = typeof currentProgress?.implementation_path === "string"
      ? runArtifactRelativePath(input.runDir, currentProgress.implementation_path)
      : undefined;
    const progress = await buildRecoveryProgressSubject({
      runDir: input.runDir,
      manifest: current,
      workItemId: "integrated",
      findingIds: gateInput.policy.cycle.decision.finding_ids,
      ...(implementationPath === undefined ? {} : { implementationPath }),
      verificationPath: gateInput.verificationPath,
      reviewPath: gateInput.reviewPath,
      reviewRevision: gateInput.policy.cycle.review_revision,
    });
    return gateReviewPolicyEffect({
      runDir: input.runDir,
      scopeId: gateInput.scopeId,
      operation: gateInput.operation,
      effectAttemptId: gateInput.policy.cycle.effect_id,
      decision: gateInput.policy.cycle.decision,
      reviewCyclePath: gateInput.policy.cycle.decision_path,
      progress,
      ownedEvidenceRefs: {
        implementation_path: implementationPath ?? null,
        verification_path: gateInput.verificationPath,
        review_path: gateInput.reviewPath,
      },
    });
  };

  workItems: for (const [index, item] of orderedWorkItems.entries()) {
    let progress = manifest.work_item_progress[item.id];
    const itemIdentity = verificationIdentityForWorkItem(item, githubDelivery, manifest);
    if (
      progress?.queue_state === "complete"
      && typeof progress.verification_path === "string"
      && progress.verification_scope === itemIdentity.scope
      && typeof progress.verification_work_item_id === "string"
      && progress.verification_work_item_id.startsWith(`${item.id}:quality-gate:`)
      && progress.verification_work_item_id !== itemIdentity.work_item_id
    ) {
      const evidenceAttempt = Math.max(1, progress.attempts);
      if (progress.verification_path !== verificationEvidencePath(itemIdentity, evidenceAttempt)) {
        throw new Error(`Completed ordered fix queue evidence identity is invalid: ${item.id}`);
      }
      const correctedProgress = {
        ...progress,
        ...verificationProgressIdentity(itemIdentity),
      };
      await loadPersistedEvidence(input.runDir, correctedProgress, itemIdentity, evidenceAttempt);
      manifest = await setProgress(input.runDir, item.id, correctedProgress, [progress.verification_path]);
      progress = manifest.work_item_progress[item.id];
    }
    const policyEnabled = manifest.review_policy_snapshot !== undefined;
    const provenanceIssue = policyEnabled
      ? workItemPolicyProvenanceIssue(manifest, approvedCriteria, item.id)
      : null;
    if (provenanceIssue) {
      const blocker = `corrupt_state: Policy-enabled work item cannot run because ${provenanceIssue}`;
      manifest = await recordRuntimeBlocker(input.runDir, blocker, item.id, progress?.attempts ?? 0);
      return { status: "human_action_required", manifest, orderedWorkItems, implementationResults, verification: evidenceByItem, reviews, blocker };
    }
    const policyCriteria = policyEnabled ? workItemPolicyCriteria(approvedCriteria, item.id)! : null;
    const policyEffectOwner = `runtime:work-item:${item.id}`;
    const prepareZeroMutationReplan = async (
      sourceCycle: ReviewCycleState,
      blocker: string,
    ): Promise<LocalWorkflowResult> => {
      const current = await readManifestV2(input.runDir);
      const policy = current.review_policy_snapshot;
      const accounting = current.review_accounting;
      if (!policy || !accounting) throw new Error(`Zero-mutation replan requires policy accounting: ${item.id}`);
      const sourceFindings = await loadFindingRevisionRecords(
        input.runDir,
        item.id,
        sourceCycle.review_revision,
        sourceCycle.finding_ids,
      );
      const reviewRevision = accounting.review_revision + 1;
      const reference = sourceCycle.work_item_progress_reference;
      if (!reference) throw new Error(`Zero-mutation replan lacks work-item evidence provenance: ${item.id}`);
      manifest = await setProgress(input.runDir, item.id, {
        ...(current.work_item_progress[item.id] ?? progress ?? { status: "blocked", attempts: reference.attempts }),
        status: "blocked",
        attempts: reference.attempts,
        blocker,
        queue_state: undefined,
        queue_path: undefined,
        active_action_id: null,
        active_action_attempt: 0,
        completed_action_ids: [],
        review_revision: reviewRevision,
        review_path: reference.review_path,
        verification_path: reference.verification_path,
        review_cycle_path: undefined,
        review_effect_id: undefined,
      }, [reference.review_path, reference.verification_path]);
      const findings: EngineFinding[] = [];
      for (const finding of sourceFindings) {
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
      const cycle = await beginReviewCycle({
        run_dir: input.runDir,
        work_item_id: item.id,
        phase: "work_item",
        review_revision: reviewRevision,
        policy_hash: hashReviewPolicy(policy),
        finding_ids: [...new Set(findings.map((finding) => finding.finding_id))].sort(),
        accounting_before: accounting,
        work_item_progress_reference: reference,
        evaluate: () => evaluateReviewPolicy({
          policy,
          findings,
          accounting,
          phase: "work_item",
          operational_blocker: null,
          replan_patch_pending: false,
          authorization: null,
          quality_recovery: qualityRecoveryEligibilitySnapshot(current, item.id),
        }),
      });
      if (cycle.decision.action !== "create_replan") {
        throw new Error(`Zero-mutation policy recovery did not create a replan decision: ${item.id}`);
      }
      const afterCycle = await readManifestV2(input.runDir);
      await writeConvergenceReport({
        run_dir: input.runDir,
        cycle,
        policy,
        accounting: afterCycle.review_accounting!,
        finding_index: afterCycle.finding_index ?? {},
        findings,
        release_guards: afterCycle.release_guards ?? [],
        authorization: null,
      });
      manifest = await setProgress(input.runDir, item.id, {
        ...(afterCycle.work_item_progress[item.id] ?? progress ?? { status: "blocked", attempts: reference.attempts }),
        status: "blocked",
        attempts: reference.attempts,
        blocker,
        queue_state: "blocked",
        review_revision: cycle.review_revision,
        review_path: reference.review_path,
        verification_path: reference.verification_path,
        review_cycle_path: cycle.decision_path,
        review_effect_id: cycle.effect_id,
      }, [reference.review_path, reference.verification_path, cycle.decision_path]);
      if (manifest.stage !== "replanning") {
        manifest = await transitionRun(input.runDir, "replanning", {
          actor: "runtime",
          payload: { work_item_id: item.id, review_revision: cycle.review_revision, blocker },
        });
      }
      manifest = await updateManifestV2(input.runDir, { delivery_state: "blocked", last_blocker: blocker });
      return { status: "human_action_required", manifest, orderedWorkItems, implementationResults, verification: evidenceByItem, reviews, blocker };
    };
    if (
      policyEnabled
      && manifest.stage === "replanning"
      && typeof progress?.review_cycle_path === "string"
      && typeof progress.review_effect_id === "string"
    ) {
      const cycle = reviewCycleStateSchema.parse(await readRunArtifact<unknown>(
        input.runDir,
        progress.review_cycle_path,
      ));
      if (
        cycle.work_item_id === item.id
        && cycle.effect_id === progress.review_effect_id
        && cycle.decision.action === "create_replan"
      ) {
        const reference = cycle.work_item_progress_reference;
        if (!reference) throw new Error(`Create-replan cycle lacks work-item progress provenance: ${item.id}`);
        manifest = await setProgress(input.runDir, item.id, {
          ...progress,
          attempts: reference.attempts,
          queue_state: undefined,
          queue_path: undefined,
          active_action_id: null,
          active_action_attempt: 0,
          completed_action_ids: [],
        });
        progress = manifest.work_item_progress[item.id];
      }
    }
    if (
      policyEnabled
      && (manifest.stage === "verifier_review" || manifest.stage === "replanning")
      && (progress?.queue_state === "complete" || progress?.queue_state === "blocked")
    ) {
      const zeroMutationCycle = await loadZeroMutationEffectCycle(item.id, progress);
      if (zeroMutationCycle) {
        return prepareZeroMutationReplan(
          zeroMutationCycle,
          `Reviewer fix effect made no successful Hands mutation for work item ${item.id}`,
        );
      }
    }
    let recoveredBoundedCompletionMarker: string | null | undefined;
    if (
      !policyEnabled
      && manifest.workflow_protocol === "bounded-context-v1"
      && (progress?.status === "in_progress" || progress?.status === "blocked")
      && typeof progress.commit_sha === "string"
    ) {
      if (
        typeof progress.implementation_path !== "string"
        || typeof progress.verification_path !== "string"
        || typeof progress.review_path !== "string"
      ) throw new Error(`Persisted direct work-item completion marker is incomplete: ${item.id}`);
      recoveredBoundedCompletionMarker = await recoverBoundedDirectCommit({
        workItem: item,
        attempt: progress.attempts,
        implementationPath: progress.implementation_path,
        verificationPath: progress.verification_path,
        reviewPath: progress.review_path,
      });
      if (recoveredBoundedCompletionMarker === null) {
        throw new Error(`Persisted direct work-item completion marker disappeared: ${item.id}`);
      }
    }
    if (progress?.status === "complete") {
      if (manifest.workflow_protocol === "bounded-context-v1") {
        const planRevision = progress.context_plan_revision;
        const planRecord = planRevision === undefined ? undefined : manifest.plan_revisions[String(planRevision)];
        if (
          planRevision === undefined
          || !planRecord
          || typeof progress.context_base_commit !== "string"
          || typeof progress.commit_sha !== "string"
          || typeof progress.summary_path !== "string"
          || typeof progress.summary_sha256 !== "string"
        ) throw new Error(`Bounded-complete work item is missing summary provenance: ${item.id}`);
        await loadWorkItemSummary(input.runDir, {
          path: progress.summary_path,
          sha256: progress.summary_sha256,
        }, {
          runId: manifest.run_id,
          workItemId: item.id,
          planRevision,
          planSha256: planRecord.sha256,
          attempt: progress.attempts,
          baseCommit: progress.context_base_commit,
          commitSha: progress.commit_sha,
        });
      }
      if (policyEnabled) {
        if (typeof progress.review_cycle_path !== "string") {
          throw new Error(`Policy-complete work item is missing its review cycle reference: ${item.id}`);
        }
        if (typeof progress.review_effect_id !== "string") {
          throw new Error(`Policy-complete work item is missing its review effect reference: ${item.id}`);
        }
        const cycle = reviewCycleStateSchema.parse(await readRunArtifact<unknown>(input.runDir, progress.review_cycle_path));
        if (
          cycle.decision_path !== progress.review_cycle_path
          || cycle.effect_id !== progress.review_effect_id
          || cycle.work_item_id !== item.id
          || cycle.review_revision !== progress.review_revision
          || !["advance", "continue_with_warning"].includes(cycle.decision.action)
        ) throw new Error(`Policy-complete work item review effect provenance is invalid: ${item.id}`);
        const completed = await requireCompletedAdvanceEffect({
          run_dir: input.runDir,
          cycle,
          owner: policyEffectOwner,
        });
        const immutableCommitSha = completed.commit_sha === "policy-authorized"
          ? await loadPolicyCommitResult(input.runDir, cycle)
          : completed.commit_sha;
        if (
          typeof progress.commit_sha !== "string"
          || immutableCommitSha === null
          || progress.commit_sha !== immutableCommitSha
        ) {
          throw new Error(`Policy-complete work item commit does not match immutable advance result: ${item.id}`);
        }
      }
      if (qualityGatePolicy && progress.queue_state !== "complete" && typeof progress.verification_path === "string") {
        const parentAttempt = Math.max(1, progress.attempts);
        const validated = await validatePersistedMutationQualityGate({ workItem: item, parentAttempt, expectedMutationKind: expectedMutationKind(parentAttempt), activeAction: null });
        implementationResults[item.id] = validated.implementation;
        evidenceByItem[item.id] = validated.finalVerification;
      } else {
        implementationResults[item.id] = await loadPersistedImplementation(input.runDir, progress, item);
        if (typeof progress.verification_path === "string") {
          evidenceByItem[item.id] = await loadPersistedEvidence(input.runDir, progress, itemIdentity, Math.max(1, progress.attempts));
        }
      }
      continue;
    }

    if (
      policyEnabled
      && manifest.stage === "verifier_review"
      && progress?.queue_state === "complete"
      && typeof progress.queue_path === "string"
      && typeof progress.review_revision === "number"
    ) {
      const cycle = reviewCycleStateSchema.parse(await readRunArtifact<unknown>(
        input.runDir,
        reviewDecisionPath(item.id, progress.review_revision),
      ));
      if (
        cycle.work_item_id !== item.id
        || cycle.review_revision !== progress.review_revision
        || !isReviewEffectAction(cycle.decision.action)
      ) throw new Error(`Completed ordered fix effect provenance is invalid: ${item.id}`);
      const completedEffect = await loadCompletedReviewEffect({
        run_dir: input.runDir,
        cycle,
        owner: policyEffectOwner,
      });
      if (completedEffect) {
        const result = parseFixEffectResult(completedEffect.effect_result);
        if (result.kind === "still_blocking" && result.successful_hands_fixes === 0) {
          return prepareZeroMutationReplan(
            cycle,
            `Reviewer fix effect made no successful Hands mutation for work item ${item.id}`,
          );
        }
      }
    }

    if (
      policyEnabled
      && progress?.queue_path
      && progress.queue_state !== "complete"
      && typeof progress.review_cycle_path === "string"
      && typeof progress.review_effect_id === "string"
    ) {
      const cycle = reviewCycleStateSchema.parse(await readRunArtifact<unknown>(
        input.runDir,
        progress.review_cycle_path,
      ));
      if (
        !isReviewEffectAction(cycle.decision.action)
        || cycle.effect_id !== progress.review_effect_id
        || cycle.work_item_id !== item.id
        || cycle.review_revision !== progress.review_revision
      ) throw new Error(`Persisted ordered fix effect provenance is invalid: ${item.id}`);
      const completedEffect = await loadCompletedReviewEffect({
        run_dir: input.runDir,
        cycle,
        owner: policyEffectOwner,
      });
      if (completedEffect) {
        const result = parseFixEffectResult(completedEffect.effect_result);
        if (result.kind === "operationally_blocked") {
          const blocker = result.blocker.message;
          manifest = await updateManifestV2(input.runDir, { delivery_state: "blocked", last_blocker: blocker });
          return { status: "human_action_required", manifest, orderedWorkItems, implementationResults, verification: evidenceByItem, reviews, blocker };
        }
        if (result.kind === "still_blocking" && result.successful_hands_fixes === 0) {
          return prepareZeroMutationReplan(
            cycle,
            `Reviewer fix effect made no successful Hands mutation for work item ${item.id}`,
          );
        }
        if (result.evidence_paths.some((path) => path.includes("..") || path.startsWith("/"))) {
          throw new Error(`Completed ordered fix effect evidence path escapes its run: ${item.id}`);
        }
        for (const path of result.evidence_paths) await readFile(resolve(input.runDir, path));
        const evidencePath = result.evidence_paths.at(-1);
        if (!evidencePath || evidencePath !== progress.verification_path) {
          throw new Error(`Completed ordered fix effect evidence provenance is invalid: ${item.id}`);
        }
        const attemptMatch = evidencePath.match(/\/attempt-(\d+)\//);
        if (!attemptMatch) throw new Error(`Completed ordered fix effect evidence attempt is invalid: ${item.id}`);
        const evidenceAttempt = Number(attemptMatch[1]);
        if (evidencePath !== verificationEvidencePath(itemIdentity, evidenceAttempt)) {
          throw new Error(`Completed ordered fix effect evidence identity is invalid: ${item.id}`);
        }
        const baseVerificationProgress = {
          ...progress,
          ...verificationProgressIdentity(itemIdentity),
        };
        await loadPersistedEvidence(input.runDir, baseVerificationProgress, itemIdentity, evidenceAttempt);
        manifest = await readManifestV2(input.runDir);
        if (manifest.stage === "fixing") {
          manifest = await transitionRun(input.runDir, "verifying", { actor: "runtime", payload: { work_item_id: item.id, review_revision: cycle.review_revision, effect_complete: true } });
        }
        if (manifest.stage === "verifying") {
          manifest = await transitionRun(input.runDir, "verifier_review", { actor: "runtime", payload: { work_item_id: item.id, review_revision: cycle.review_revision, effect_complete: true } });
        }
        manifest = await setProgress(input.runDir, item.id, {
          ...baseVerificationProgress,
          status: "in_progress",
          attempts: evidenceAttempt,
          queue_state: "complete",
          active_action_id: null,
          active_action_attempt: 0,
          focused_review_path: null,
          review_path: undefined,
          review_cycle_path: undefined,
          review_effect_id: undefined,
        }, [evidencePath]);
        return runLocalWorkflowUnsafe(input);
      }
      await requireClaimedReviewEffect({ run_dir: input.runDir, cycle, owner: policyEffectOwner });
      const reference = cycle.work_item_progress_reference;
      if (!reference) throw new Error(`Persisted ordered fix effect is missing its review reference: ${item.id}`);
      const priorReview = await loadPersistedReviewPath(
        input.runDir,
        reference.review_path,
        item.id,
        reference.attempts,
        false,
      );
      const persistedImplementation = await loadPersistedImplementation(input.runDir, progress, item);
      const orderedRecoveryOperation: RetryableRuntimeOperation = {
        workItemId: item.id,
        scopeId: `work-item:${item.id}`,
        operation: "ordered-reviewer-action",
        attempt: progress.attempts,
        classification: { failure_class: "operational_blocker", blocker_code: "transport_failure" },
        findingIds: cycle.decision.finding_ids,
        requestedEffect: cycle.decision.action,
        requestedEffectReason: cycle.decision.reason_code,
      };
      const orderedRecoveryContext = await gateRetryableRuntimeOperation(
        orderedRecoveryOperation,
      );
      if (orderedRecoveryContext.gate.mode === "blocked") {
        const blocker = orderedRecoveryContext.gate.guard_action === "diagnostic_stop"
          ? "Recovery diagnostic stop after repeated ordered-reviewer-action"
          : "Recovery exhausted after ordered-reviewer-action";
        manifest = await updateManifestV2(input.runDir, { delivery_state: "blocked", last_blocker: blocker });
        return { status: "human_action_required", manifest, orderedWorkItems, implementationResults, verification: evidenceByItem, reviews, blocker };
      }
      const queueResult = await executeOrderedFixEffect(cycle, {
        workItem: item,
        issueNumber: index + 1,
        review: priorReview,
        reviewPass: reference.attempts,
        policyCriterionAliases: criterionAliasesForAcceptance(
          item.acceptance,
          workItemPolicyCriteria(approvedCriteria, item.id) ?? [],
        ),
        implementationResult: {
          implementation: persistedImplementation,
          reportPath: runArtifactRelativePath(input.runDir, progress.implementation_path as string),
          invocation: {} as never,
        },
        recoverStartedPacketInvocation: orderedRecoveryContext.gate.mode === "authorized_attempt",
      }, policyEffectOwner);
      if (queueResult.kind === "operationally_blocked") {
        const blocker = queueResult.blocker.message;
        if (queueResult.blocker.code === "corrupt_state" || queueResult.blocker.code === "invalid_verifier_contract") {
          manifest = await updateManifestV2(input.runDir, { delivery_state: "blocked", last_blocker: blocker });
          return { status: "human_action_required", manifest, orderedWorkItems, implementationResults, verification: evidenceByItem, reviews, blocker };
        }
        const recovered = await recordRetryableRuntimeBlocker({
          ...orderedRecoveryOperation,
          blocker,
          classification: { failure_class: "operational_blocker", blocker_code: queueResult.blocker.code },
          error: new Error(blocker),
          recoveryContext: orderedRecoveryContext,
        });
        manifest = recovered.manifest;
        return { status: "human_action_required", manifest, orderedWorkItems, implementationResults, verification: evidenceByItem, reviews, blocker: recovered.blocker };
      }
      if (
        queueResult.kind === "replan_required"
        || (queueResult.kind === "still_blocking" && queueResult.successful_hands_fixes === 0)
      ) {
        await recordAuthorizedRuntimeSuccess(
          orderedRecoveryOperation,
          orderedRecoveryContext,
          {
            implementation_path: progress.implementation_path as string,
            verification_path: progress.verification_path as string,
            review_path: reference.review_path,
          },
        );
        await completeReviewEffect({
          run_dir: input.runDir,
          cycle,
          owner: policyEffectOwner,
          outcome: "complete",
          result: queueResult.kind === "replan_required"
            ? { kind: "still_blocking", successful_hands_fixes: 0, evidence_paths: [] }
            : {
                kind: queueResult.kind,
                successful_hands_fixes: queueResult.successful_hands_fixes,
                evidence_paths: queueResult.evidence_paths,
              },
        });
        await input.dependencies?.afterCheckpoint?.("after_ordered_replan_effect_complete");
        const blocker = queueResult.kind === "replan_required"
          ? `Fix packet requires replanning for work item ${item.id}: ${queueResult.blocker}`
          : `Reviewer fix effect made no successful Hands mutation for work item ${item.id}`;
        return prepareZeroMutationReplan(cycle, blocker);
      }
      await recordAuthorizedRuntimeSuccess(
        orderedRecoveryOperation,
        orderedRecoveryContext,
        {
          implementation_path: queueResult.implementationResult.reportPath,
          verification_path: queueResult.savedEvidencePath,
          review_path: reference.review_path,
        },
      );
      await input.dependencies?.afterCheckpoint?.("after_ordered_recovery_outcome");
      await completeReviewEffect({
        run_dir: input.runDir,
        cycle,
        owner: policyEffectOwner,
        outcome: "complete",
        result: {
          kind: queueResult.kind,
          successful_hands_fixes: queueResult.successful_hands_fixes,
          evidence_paths: queueResult.evidence_paths,
        },
      });
      await input.dependencies?.afterCheckpoint?.("after_ordered_fix_effect_complete");
      manifest = await readManifestV2(input.runDir);
      if (manifest.stage === "fixing") {
        manifest = await transitionRun(input.runDir, "verifying", {
          actor: "runtime",
          payload: { work_item_id: item.id, review_revision: cycle.review_revision, effect_complete: true },
        });
      }
      if (manifest.stage === "verifying") {
        manifest = await transitionRun(input.runDir, "verifier_review", {
          actor: "runtime",
          payload: { work_item_id: item.id, review_revision: cycle.review_revision, effect_complete: true },
        });
      }
      manifest = await setProgress(input.runDir, item.id, {
        ...(await readManifestV2(input.runDir)).work_item_progress[item.id],
        status: "in_progress",
        attempts: queueResult.reviewPass,
        implementation_path: queueResult.implementationResult.reportPath,
        verification_path: queueResult.savedEvidencePath,
        ...verificationProgressIdentity(itemIdentity),
        queue_state: "complete",
        review_path: undefined,
        review_cycle_path: undefined,
        review_effect_id: undefined,
      }, [queueResult.implementationResult.reportPath, queueResult.savedEvidencePath]);
      await input.dependencies?.afterCheckpoint?.("after_ordered_fix_effect_progress");
      return runLocalWorkflowUnsafe(input);
    }

    if (
      !policyEnabled
      &&
      qualityGatePolicy
      && progress?.queue_path
      && progress.review_revision
    ) {
      let resumedImplementation: HandsWorkItemResult;
      try {
        const persisted = await loadPersistedImplementation(input.runDir, progress, item);
        resumedImplementation = {
          implementation: persisted,
          reportPath: runArtifactRelativePath(input.runDir, progress.implementation_path as string),
          invocation: {} as never,
        };
      } catch (error) {
        const blocker = `Persisted Reviewer action mutation could not be resumed: ${errorMessage(error)}`;
        manifest = await recordRuntimeBlocker(input.runDir, blocker, item.id, progress.attempts);
        return { status: "human_action_required", manifest, orderedWorkItems, implementationResults, verification: evidenceByItem, reviews, blocker };
      }
      let queueResult: OrderedQueueResult;
      if (progress.queue_state === "complete") {
        try {
          if (typeof progress.verification_path !== "string" || typeof progress.review_path !== "string") {
            throw new Error("Completed queue is missing its full verification or review path");
          }
          const persistedEvidence = await loadPersistedEvidence(input.runDir, progress, itemIdentity, progress.attempts);
          const persistedReview = await loadPersistedReviewPath(
            input.runDir,
            progress.review_path,
            item.id,
            progress.attempts,
            false,
          );
          if (persistedReview.decision === "request_changes") {
            queueResult = await runOrderedActionQueue({
              workItem: item,
              issueNumber: index + 1,
              review: persistedReview,
              reviewPass: progress.attempts,
              implementationResult: resumedImplementation,
            });
          } else {
            queueResult = {
              kind: "review",
              implementationResult: resumedImplementation,
              verification: persistedEvidence,
              reviewResult: { review: persistedReview, reviewPath: progress.review_path, invocation: {} as never },
              reviewPass: progress.attempts,
              savedEvidencePath: progress.verification_path,
            };
          }
        } catch (error) {
          const blocker = `Completed Reviewer action queue could not be resumed: ${errorMessage(error)}`;
          manifest = await recordRuntimeBlocker(input.runDir, blocker, item.id, progress.attempts);
          return { status: "human_action_required", manifest, orderedWorkItems, implementationResults, verification: evidenceByItem, reviews, blocker };
        }
      } else {
        let priorReview: VerifierReview;
        try {
          priorReview = await loadPersistedReview(input.runDir, item.id, progress.review_revision);
        } catch (error) {
          const blocker = `Persisted full review for Reviewer action queue could not be resumed: ${errorMessage(error)}`;
          manifest = await recordRuntimeBlocker(input.runDir, blocker, item.id, progress.attempts);
          return { status: "human_action_required", manifest, orderedWorkItems, implementationResults, verification: evidenceByItem, reviews, blocker };
        }
        queueResult = await runOrderedActionQueue({
          workItem: item,
          issueNumber: index + 1,
          review: priorReview,
          reviewPass: progress.review_revision,
          implementationResult: resumedImplementation,
        });
      }
      while (queueResult.kind === "review" && queueResult.reviewResult.review.decision === "request_changes") {
        manifest = await readManifestV2(input.runDir);
        const queueProgress = manifest.work_item_progress[item.id];
        if (queueProgress?.mutation_kind === "quality_recovery") break;
        const primaryLimitReached = queueResult.reviewPass >= maxHandsFixAttempts + 1;
        const legacyQualityRecovery = primaryLimitReached
          && legacyQualityRecoveryAttempts(queueProgress) === 0
          && handsBackupPolicy !== undefined
          && manifest.active_hands_profile === "primary";
        if (primaryLimitReached && !legacyQualityRecovery) break;
        reviews[item.id] ??= [];
        reviews[item.id].push(queueResult.reviewResult.review);
        queueResult = await runOrderedActionQueue({
          workItem: item,
          issueNumber: index + 1,
          review: queueResult.reviewResult.review,
          reviewPass: queueResult.reviewPass,
          implementationResult: queueResult.implementationResult,
          legacyQualityRecovery,
        });
        if (legacyQualityRecovery) break;
      }
      if (queueResult.kind === "blocked") {
        const blocker = queueResult.blocker;
        const latestAttempts = (await readManifestV2(input.runDir)).work_item_progress[item.id]?.attempts
          ?? progress.attempts;
        manifest = await recordRuntimeBlocker(input.runDir, blocker, item.id, latestAttempts);
        return { status: "human_action_required", manifest, orderedWorkItems, implementationResults, verification: evidenceByItem, reviews, blocker };
      }
      if (queueResult.kind !== "review") {
        throw new Error("Legacy ordered queue returned a policy-only effect result");
      }
      reviews[item.id] ??= [];
      reviews[item.id].push(queueResult.reviewResult.review);
      const operational = await recordLegacyOperationalReview(item, queueResult.reviewResult.review, queueResult.reviewPass);
      if (operational) {
        manifest = operational.manifest;
        return { status: "human_action_required", manifest, orderedWorkItems, implementationResults, verification: evidenceByItem, reviews, blocker: operational.blocker };
      }
      const afterQueue = await readManifestV2(input.runDir);
      const recoveryReviewed = afterQueue.work_item_progress[item.id]?.mutation_kind === "quality_recovery";
      if (recoveryReviewed) {
        manifest = await setProgress(input.runDir, item.id, {
          ...afterQueue.work_item_progress[item.id]!,
          quality_recovery_attempts: 1,
          recovery_state: queueResult.reviewResult.review.decision === "approve" ? "approved" : "exhausted",
        });
      }
      if (queueResult.reviewResult.review.decision !== "approve") {
        const escalationExhausted = recoveryReviewed
          && queueResult.reviewResult.review.decision === "request_changes"
          && (queueResult.reviewResult.review.failure_class ?? "implementation_failure") === "implementation_failure";
        const blocker = escalationExhausted
          ? `blocked: escalation_exhausted for work item ${item.id}`
          : `Verifier requires replanning for work item ${item.id}`;
        manifest = await transitionRun(input.runDir, "replanning", { actor: "runtime", payload: { work_item_id: item.id, blocker } });
        const current = await readManifestV2(input.runDir);
        manifest = await updateManifestV2(input.runDir, {
          delivery_state: "blocked",
          last_blocker: blocker,
          work_item_progress: {
            ...current.work_item_progress,
            [item.id]: {
              ...current.work_item_progress[item.id]!,
              status: "blocked",
              blocker,
              ...(escalationExhausted ? { blocker_code: "escalation_exhausted" as const, recovery_state: "exhausted" as const } : {}),
            },
          },
        });
        return { status: "human_action_required", manifest, orderedWorkItems, implementationResults, verification: evidenceByItem, reviews, blocker };
      }
      const queueImplementationPath = queueResult.implementationResult.reportPath;
      const queueVerificationPath = queueResult.savedEvidencePath;
      const queueReviewPath = controllerArtifactRelativePath(input.runDir, queueResult.reviewResult.reviewPath);
      manifest = await readManifestV2(input.runDir);
      const boundedQueueCompletion = manifest.workflow_protocol === "bounded-context-v1";
      const recoveredCommitSha = boundedQueueCompletion
        ? recoveredBoundedCompletionMarker !== undefined
          ? recoveredBoundedCompletionMarker
          : await recoverBoundedDirectCommit({
            workItem: item,
            attempt: queueResult.reviewPass,
            implementationPath: queueImplementationPath,
            verificationPath: queueVerificationPath,
            reviewPath: queueReviewPath,
          })
        : null;
      const changed = recoveredCommitSha === null && await worktreeHasChanges(input.worktreePath);
      const commitSha = recoveredCommitSha
        ?? (changed
          ? await commit({ worktreePath: input.worktreePath, workItemId: item.id, title: item.title, verifierApproved: true })
          : "no-op");
      if (boundedQueueCompletion && recoveredCommitSha === null) {
        const current = await readManifestV2(input.runDir);
        const currentProgress = current.work_item_progress[item.id];
        if (
          currentProgress?.context_plan_revision !== assertApprovedCurrentPlanRevision(current)
          || !isGitObjectId(currentProgress.context_base_commit)
        ) throw new Error(`Bounded direct work-item context authority is incomplete: ${item.id}`);
        await validateBoundedDirectCompletionCommit({
          workItem: item,
          baseCommit: currentProgress.context_base_commit,
          commitSha,
        });
        manifest = current;
      }
      implementationResults[item.id] = queueResult.implementationResult.implementation;
      evidenceByItem[item.id] = queueResult.verification;
      const queueCompletionProgress = {
        attempts: queueResult.reviewPass,
        commit_sha: commitSha,
        implementation_path: queueImplementationPath,
        verification_path: queueVerificationPath,
        review_path: queueReviewPath,
        review_revision: queueResult.reviewPass,
      };
      const queueCompletionArtifacts = [
        queueImplementationPath,
        queueVerificationPath,
        queueReviewPath,
      ];
      if (boundedQueueCompletion) {
        manifest = await setProgress(input.runDir, item.id, {
          ...queueCompletionProgress,
          status: "in_progress",
        }, queueCompletionArtifacts);
        await input.dependencies?.afterCheckpoint?.("after_work_item_completion_commit");
        const summary = await persistBoundedCompletionSummary({
          workItem: item,
          attempt: queueResult.reviewPass,
          commitSha,
          completionBasis: "verifier_approve",
          policyDecisionPath: null,
          findingIds: [],
        });
        if (!summary) throw new Error(`Bounded work-item summary was not created: ${item.id}`);
        await input.dependencies?.afterCheckpoint?.("after_work_item_summary_persisted");
        manifest = await setProgress(input.runDir, item.id, {
          ...queueCompletionProgress,
          status: "complete",
          summary_path: summary.path,
          summary_sha256: summary.sha256,
        }, [...queueCompletionArtifacts, summary.path]);
        await input.dependencies?.afterCheckpoint?.("after_work_item_summary_pointer");
      } else {
        manifest = await setProgress(input.runDir, item.id, {
          ...queueCompletionProgress,
          status: "complete",
        }, queueCompletionArtifacts);
      }
      continue workItems;
    }

    const isCurrentItem = manifest.current_work_item_id === item.id;
    const resumeStage = isCurrentItem ? manifest.stage : "worktree_setup";
    let implementationResult: HandsWorkItemResult;
    const retryBlockedVerification = resumeStage === "verifying"
      && progress?.status === "blocked"
      && typeof progress.verification_path === "string"
      && typeof progress.blocker === "string"
      && progress.blocker.startsWith(`Verification failed for work item ${item.id}:`);
    const retryInvalidVerifierContract = resumeStage === "verifier_review"
      && progress?.status === "blocked"
      && typeof progress.review_path === "string"
      && typeof progress.blocker === "string"
      && progress.blocker.startsWith("invalid_verifier_contract:");
    const retryOperationalVerifierReview = resumeStage === "verifier_review"
      && progress?.status === "blocked"
      && (progress.blocker_code === "operational_blocker" || progress.blocker_code === "test_infrastructure_blocker");
    const retryCompletedOperationalVerifierReview = retryOperationalVerifierReview
      && typeof progress?.review_path === "string";
    let pass = retryBlockedVerification
      ? Math.max(1, progress.attempts)
      : retryCompletedOperationalVerifierReview
        ? Math.max(1, progress?.attempts ?? 1)
      : retryOperationalVerifierReview
        ? Math.max(0, (progress?.attempts ?? 1) - 1)
      : Math.max(0, (progress?.attempts ?? 1) - 1);
    let resumeReview = ["verifier_review", "replanning", "awaiting_plan_approval"].includes(resumeStage)
      && !retryCompletedOperationalVerifierReview;
    let resumeClaimedQueue = false;
    if (resumeStage === "fixing") {
      const recordedAttempts = Math.max(1, progress?.attempts ?? 1);
      const implementationPath = typeof progress?.implementation_path === "string"
        ? runArtifactRelativePath(input.runDir, progress.implementation_path)
        : undefined;
      const implementationAttempt = implementationPath?.match(/\/attempt-(\d+)\.json$/)?.[1];
      const persistedFix = recordedAttempts > 1 && implementationAttempt === String(recordedAttempts);
      const previousReviewAttempt = persistedFix ? recordedAttempts - 1 : recordedAttempts;
      let resumeClaimedReviewAttempt: number | null = null;
      if (policyEnabled && progress?.review_revision) {
        const cycle = reviewCycleStateSchema.parse(await readRunArtifact<unknown>(
          input.runDir,
          reviewDecisionPath(item.id, progress.review_revision),
        ));
        if (!isReviewEffectAction(cycle.decision.action)) {
          throw new Error(`Persisted work-item fix effect action is invalid: ${cycle.effect_id}`);
        }
        let claimed: Awaited<ReturnType<typeof claimReviewEffect>>;
        try {
          claimed = await claimReviewEffect({
            run_dir: input.runDir,
            cycle,
            owner: policyEffectOwner,
          });
        } catch (error) {
          if (!(error instanceof AmbiguousEffectError) || typeof progress.queue_path === "string") throw error;
          claimed = await recoverClaimedReviewEffectBeforeQueue({
            run_dir: input.runDir,
            cycle,
            owner: policyEffectOwner,
            queue_persisted: false,
          });
        }
        if (claimed.status === "complete") {
          await incrementSuccessfulFix({
            run_dir: input.runDir,
            cycle,
            owner: policyEffectOwner,
            mutation_id: typeof progress.implementation_path === "string"
              ? progress.implementation_path
              : cycle.effect_id,
            kind: "successful_fix",
            effect_action: cycle.decision.action,
          });
          const afterFix = await readManifestV2(input.runDir);
          manifest = await setProgress(input.runDir, item.id, {
            ...(afterFix.work_item_progress[item.id] ?? progress),
            review_cycle_path: undefined,
            review_effect_id: undefined,
          });
        } else if (typeof progress.queue_path !== "string" && !persistedFix) {
          const referencedAttempt = cycle.work_item_progress_reference?.attempts;
          if (!Number.isInteger(referencedAttempt) || referencedAttempt! < 1) {
            throw new Error(`Persisted work-item fix effect ${cycle.effect_id} is missing its review attempt`);
          }
          resumeClaimedQueue = true;
          resumeClaimedReviewAttempt = referencedAttempt!;
        } else {
          throw new Error(`Persisted work-item fix effect ${cycle.effect_id} is not complete`);
        }
      }
      if (resumeClaimedQueue) {
        const implementation = await loadPersistedImplementation(input.runDir, progress, item);
        implementationResult = {
          implementation,
          reportPath: runArtifactRelativePath(input.runDir, progress!.implementation_path as string),
          invocation: {} as never,
        };
      } else if (persistedFix) {
        try {
          if (progress?.mutation_kind === "quality_recovery") {
            await validateLegacyQualityRecoveryReport(item, progress.implementation_path as string);
          }
          const implementation = await loadPersistedImplementation(input.runDir, progress, item);
          implementationResult = {
            implementation,
            reportPath: runArtifactRelativePath(input.runDir, progress!.implementation_path as string),
            invocation: {} as never,
          };
        } catch (error) {
          const blocker = `Persisted Hands report failed while resuming fix for work item ${item.id}: ${errorMessage(error)}`;
          manifest = await recordRuntimeBlocker(input.runDir, blocker, item.id, recordedAttempts);
          await publishOperationalBlocker(item, index, recordedAttempts, "hands_invalid");
          return { status: "human_action_required", manifest, orderedWorkItems, implementationResults, verification: evidenceByItem, reviews, blocker };
        }
      } else {
        try {
          const previousReview = await loadPersistedReview(input.runDir, item.id, previousReviewAttempt);
          implementationResult = await invokeHands(item, previousReviewAttempt + 1, "primary_fix", previousReview.findings);
        } catch (error) {
          const blocker = `Hands invocation failed while resuming fix for work item ${item.id}: ${errorMessage(error)}`;
          manifest = await recordRuntimeBlocker(input.runDir, blocker, item.id, previousReviewAttempt + 1);
          await publishOperationalBlocker(item, index, previousReviewAttempt + 1, "hands_invalid");
          return { status: "human_action_required", manifest, orderedWorkItems, implementationResults, verification: evidenceByItem, reviews, blocker };
        }
        await setProgress(input.runDir, item.id, {
          status: "in_progress",
          attempts: previousReviewAttempt + 1,
          verification_path: undefined,
          verification_scope: undefined,
          verification_work_item_id: undefined,
          verification_issue_number: undefined,
          self_review_pass: 0,
          self_review_state: "pending",
          mutation_verification_path: undefined,
          self_review_paths: undefined,
          self_review_verification_paths: undefined,
          implementation_path: implementationResult.reportPath,
        }, [implementationResult.reportPath]);
      }
      pass = resumeClaimedQueue ? resumeClaimedReviewAttempt! - 1 : previousReviewAttempt;
      resumeReview = resumeClaimedQueue;
    } else {
      const persistedImplementation = typeof progress?.implementation_path === "string"
        || resumeStage === "verifying"
        || resumeStage === "verifier_review"
        || resumeStage === "replanning"
        || resumeStage === "awaiting_plan_approval";
      const handsRecoveryOperation: RetryableRuntimeOperation = {
        workItemId: item.id,
        scopeId: `work-item:${item.id}`,
        operation: "hands-invocation",
        attempt: Math.max(1, progress?.attempts ?? 1),
        classification: { failure_class: "invocation_failure", blocker_code: "hands_invocation_failed" },
      };
      const handsRecoveryContext = persistedImplementation
        ? null
        : await gateRetryableRuntimeOperation(handsRecoveryOperation);
      if (handsRecoveryContext?.gate.mode === "blocked") {
        const blocker = handsRecoveryContext.gate.guard_action === "diagnostic_stop"
          ? "Recovery diagnostic stop after repeated hands-invocation"
          : "Recovery exhausted after hands-invocation";
        manifest = await updateManifestV2(input.runDir, { delivery_state: "blocked", last_blocker: blocker });
        return { status: "human_action_required", manifest, orderedWorkItems, implementationResults, verification: evidenceByItem, reviews, blocker };
      }
      try {
        if (persistedImplementation) {
          const implementation = await loadPersistedImplementation(input.runDir, progress, item);
          implementationResult = { implementation, reportPath: runArtifactRelativePath(input.runDir, progress!.implementation_path as string), invocation: {} as never };
        } else {
          if (resumeStage === "worktree_setup") {
            manifest = await setProgress(input.runDir, item.id, {
              status: "in_progress",
              attempts: progress?.attempts ?? 0,
            });
            if (manifest.stage !== "implementing") {
              manifest = await transitionRun(input.runDir, "implementing", { actor: "runtime", payload: { work_item_id: item.id, order: index + 1 } });
            }
            await publishWorkItemStatus(item, index, "implementing", 1);
            await publishRuntimeStatusCheckpoint(input, orderedWorkItems);
            await input.dependencies?.afterCheckpoint?.("after_status_implementing_publication");
          }
          implementationResult = await invokeHands(item, Math.max(1, progress?.attempts ?? 1), "initial", []);
          await recordAuthorizedRuntimeSuccess(
            handsRecoveryOperation,
            handsRecoveryContext!,
            { implementation_path: implementationResult.reportPath },
          );
          await setProgress(input.runDir, item.id, { status: "in_progress", attempts: Math.max(1, progress?.attempts ?? 1), implementation_path: implementationResult.reportPath }, [implementationResult.reportPath]);
        }
      } catch (error) {
        const blocker = `Hands invocation failed for work item ${item.id}: ${errorMessage(error)}`;
        if (error instanceof NonRetryableHandsResultError) {
          manifest = await recordRuntimeBlocker(input.runDir, blocker, item.id, Math.max(1, progress?.attempts ?? 1));
          return { status: "human_action_required", manifest, orderedWorkItems, implementationResults, verification: evidenceByItem, reviews, blocker };
        }
        const recovered = await recordRetryableRuntimeBlocker({
          ...handsRecoveryOperation,
          blocker,
          error,
          ...(handsRecoveryContext === null ? {} : { recoveryContext: handsRecoveryContext }),
        });
        manifest = recovered.manifest;
        await publishOperationalBlocker(item, index, Math.max(1, progress?.attempts ?? 1), "hands_invalid");
        return { status: "human_action_required", manifest, orderedWorkItems, implementationResults, verification: evidenceByItem, reviews, blocker: recovered.blocker };
      }
      if (resumeStage === "implementing") {
        manifest = await transitionRun(input.runDir, "verifying", { actor: "runtime", payload: { work_item_id: item.id, pass: Math.max(1, progress?.attempts ?? 1) } });
        await publishWorkItemStatus(item, index, "verifying", Math.max(1, progress?.attempts ?? 1));
      }
    }

    let implementationScopeFailure: string | null = null;
    try {
      await assertCurrentImplementationScope(item, implementationResult.implementation);
    } catch (error) {
      implementationScopeFailure = `Implementation scope check failed for work item ${item.id}: ${errorMessage(error)}`;
    }

    if (["verifier_review", "replanning", "awaiting_plan_approval"].includes(resumeStage)) {
      const mutationParentAttempt = implementationAttempt(progress);
      const pendingReplanCycle = typeof progress?.review_cycle_path === "string"
        ? reviewCycleStateSchema.parse(await readRunArtifact<unknown>(input.runDir, progress.review_cycle_path))
        : null;
      const validatedGate = qualityGatePolicy
        && progress?.queue_state !== "complete"
        && !retryOperationalVerifierReview
        && pendingReplanCycle?.decision.action !== "create_replan"
        ? await validatePersistedMutationQualityGate({ workItem: item, parentAttempt: mutationParentAttempt, expectedMutationKind: expectedMutationKind(mutationParentAttempt), activeAction: null })
        : undefined;
      const persistedEvidence = validatedGate
        ? validatedGate.finalVerification
        : retryOperationalVerifierReview
          ? await loadPersistedEvidence(input.runDir, progress)
          : await loadPersistedEvidence(input.runDir, progress, itemIdentity, Math.max(1, progress?.attempts ?? 1));
      if (retryOperationalVerifierReview) {
        const recoveredIdentity = identityFromVerificationEvidence(persistedEvidence);
        validateEvidenceForIdentity(persistedEvidence, recoveredIdentity, Math.max(1, progress?.attempts ?? 1));
        manifest = await setProgress(input.runDir, item.id, {
          ...progress!,
          ...verificationProgressIdentity(recoveredIdentity),
        }, [persistedEvidence.evidence_path]);
        progress = manifest.work_item_progress[item.id];
      }
      if (validatedGate) implementationResult = { ...implementationResult, implementation: validatedGate.implementation };
      evidenceByItem[item.id] = persistedEvidence;
    }

    while (true) {
      const reviewPass = pass + 1;
      const resumingReview = resumeReview;
      let normalizedEvidence: VerificationEvidence;
      let savedEvidencePath: string;
      let escalateFailedVerificationToVerifier = false;
      if (resumeReview) {
        normalizedEvidence = evidenceByItem[item.id] ?? (qualityGatePolicy && progress?.queue_state !== "complete"
          ? (await validatePersistedMutationQualityGate({ workItem: item, parentAttempt: reviewPass, expectedMutationKind: expectedMutationKind(reviewPass), activeAction: null })).finalVerification
          : await loadPersistedEvidence(input.runDir, progress, itemIdentity, reviewPass));
        normalizedEvidence = validateEvidenceForIdentity(
          normalizedEvidence,
          identityFromVerificationEvidence(normalizedEvidence),
          reviewPass,
        );
        if (progress?.self_review_state === "complete" && typeof progress.self_review_pass === "number") {
          const selfReviewPath = progress.self_review_paths?.[String(progress.self_review_pass)];
          if (typeof selfReviewPath === "string") {
            const lastSelfReview = await readHandsSelfReviewReportArtifact(input.runDir, selfReviewPath);
            escalateFailedVerificationToVerifier = lastSelfReview.ready_for_resolution_check === false
              && lastSelfReview.remaining_findings.length > 0;
          }
        }
        evidenceByItem[item.id] = normalizedEvidence;
        savedEvidencePath = normalizedEvidence.evidence_path;
        resumeReview = false;
      } else {
        if (manifest.stage !== "verifying") {
          manifest = await transitionRun(input.runDir, "verifying", { actor: "runtime", payload: { work_item_id: item.id, pass: reviewPass } });
          await publishWorkItemStatus(item, index, "verifying", reviewPass);
          await publishRuntimeStatusCheckpoint(input, orderedWorkItems);
          await input.dependencies?.afterCheckpoint?.("after_status_verifying_publication");
        }
        let gateResult: MutationQualityGateResult;
        const verificationRecoveryOperation: RetryableRuntimeOperation = {
          workItemId: item.id,
          scopeId: `work-item:${item.id}`,
          operation: "verification-infrastructure",
          attempt: reviewPass,
          classification: {
            failure_class: "test_infrastructure_blocker",
            blocker_code: "verification_infrastructure_failed",
          },
        };
        const verificationRecoveryContext = await gateRetryableRuntimeOperation(
          verificationRecoveryOperation,
        );
        if (verificationRecoveryContext.gate.mode === "blocked") {
          const blocker = verificationRecoveryContext.gate.guard_action === "diagnostic_stop"
            ? "Recovery diagnostic stop after repeated verification-infrastructure"
            : "Recovery exhausted after verification-infrastructure";
          manifest = await updateManifestV2(input.runDir, { delivery_state: "blocked", last_blocker: blocker });
          return { status: "human_action_required", manifest, orderedWorkItems, implementationResults, verification: evidenceByItem, reviews, blocker };
        }
        try {
          gateResult = await runMutationQualityGate({
            workItem: item,
            parentAttempt: reviewPass,
            mutationKind: expectedMutationKind(reviewPass),
            activeAction: null,
            completedActions: [],
            implementation: implementationResult.implementation,
            phase: "work_item",
          });
          await recordAuthorizedRuntimeSuccess(
            verificationRecoveryOperation,
            verificationRecoveryContext,
            { verification_path: gateResult.finalVerification.evidence_path },
          );
        } catch (error) {
          if (!(error instanceof HandsSelfReviewQualityGateError)) {
            const blocker = `Verification infrastructure failed for work item ${item.id}: ${errorMessage(error)}`;
            const recovered = await recordRetryableRuntimeBlocker({
              ...verificationRecoveryOperation,
              blocker,
              error,
              recoveryContext: verificationRecoveryContext,
            });
            manifest = recovered.manifest;
            return { status: "human_action_required", manifest, orderedWorkItems, implementationResults, verification: evidenceByItem, reviews, blocker: recovered.blocker };
          }
          const blocker = `Hands self-review quality gate failed for work item ${item.id}: ${errorMessage(error)}`;
          manifest = await recordRuntimeBlocker(input.runDir, blocker, item.id, reviewPass);
          return { status: "human_action_required", manifest, orderedWorkItems, implementationResults, verification: evidenceByItem, reviews, blocker };
        }
        implementationResult = { ...implementationResult, implementation: gateResult.implementation };
        const lastSelfReview = gateResult.selfReviews.at(-1);
        escalateFailedVerificationToVerifier = lastSelfReview !== undefined
          && lastSelfReview.ready_for_resolution_check === false
          && lastSelfReview.remaining_findings.length > 0;
        normalizedEvidence = gateResult.finalVerification;
        savedEvidencePath = normalizedEvidence.evidence_path;
        evidenceByItem[item.id] = normalizedEvidence;
      }
      evidenceByItem[item.id] = normalizedEvidence;
      const verificationFailures = verificationFailureReasons(normalizedEvidence, item.browser_checks);
      const policyClassifiesVerificationFailure = policyEnabled && item.id !== "integrated";
      if (
        verificationFailures.length > 0
        && !policyClassifiesVerificationFailure
        && !escalateFailedVerificationToVerifier
        && implementationScopeFailure === null
      ) {
        const blocker = `Verification failed for work item ${item.id}: ${verificationFailures.join("; ")}`;
        manifest = await setProgress(input.runDir, item.id, {
          status: "blocked",
          attempts: reviewPass,
          verification_path: savedEvidencePath,
          ...verificationProgressIdentity(identityFromVerificationEvidence(normalizedEvidence)),
          blocker,
        }, [savedEvidencePath]);
        manifest = await updateManifestV2(input.runDir, {
          delivery_state: "blocked",
          last_blocker: blocker,
        });
        await publishWorkItemStatus(item, index, "blocked", reviewPass, normalizedEvidence, undefined, [{ kind: "verification_blocked", attempt: reviewPass }]);
        return {
          status: "human_action_required",
          manifest,
          orderedWorkItems,
          implementationResults,
          verification: evidenceByItem,
          reviews,
          blocker,
        };
      }
      if (!resumingReview) {
        manifest = await setProgress(input.runDir, item.id, {
          status: "in_progress",
          attempts: reviewPass,
          verification_path: savedEvidencePath,
          ...verificationProgressIdentity(identityFromVerificationEvidence(normalizedEvidence)),
        }, [savedEvidencePath]);
        manifest = await transitionRun(input.runDir, "verifier_review", {
          actor: "runtime",
          payload: { work_item_id: item.id, pass: reviewPass },
        });
        await publishWorkItemStatus(item, index, "reviewing", reviewPass, normalizedEvidence);
      }
      let reviewResult: VerifyWorkItemResult;
      const verifierRecoveryOperation: RetryableRuntimeOperation = {
        workItemId: item.id,
        scopeId: `work-item:${item.id}`,
        operation: "verifier-invocation",
        attempt: reviewPass,
        classification: { failure_class: "invocation_failure", blocker_code: "verifier_invocation_failed" },
      };
      const verifierRecoveryContext = policyEnabled && resumingReview && typeof progress?.review_path === "string"
        && !retryInvalidVerifierContract && !retryOperationalVerifierReview
        ? null
        : await gateRetryableRuntimeOperation(verifierRecoveryOperation);
      if (verifierRecoveryContext?.gate.mode === "blocked") {
        const blocker = verifierRecoveryContext.gate.guard_action === "diagnostic_stop"
          ? "Recovery diagnostic stop after repeated verifier-invocation"
          : "Recovery exhausted after verifier-invocation";
        manifest = await updateManifestV2(input.runDir, { delivery_state: "blocked", last_blocker: blocker });
        return { status: "human_action_required", manifest, orderedWorkItems, implementationResults, verification: evidenceByItem, reviews, blocker };
      }
      try {
        const persistedReviewPath = resumingReview && typeof progress?.review_path === "string"
          && !retryInvalidVerifierContract && !retryOperationalVerifierReview
          ? progress.review_path
          : null;
        const recoverBoundedCompletionReview = !policyEnabled
          && manifest.workflow_protocol === "bounded-context-v1"
          && persistedReviewPath !== null
          && recoveredBoundedCompletionMarker !== undefined
          && recoveredBoundedCompletionMarker !== null;
        if ((policyEnabled && persistedReviewPath !== null) || recoverBoundedCompletionReview) {
          reviewResult = {
            review: await loadPersistedReviewPath(
              input.runDir,
              persistedReviewPath!,
              item.id,
              reviewPass,
              false,
            ),
            reviewPath: persistedReviewPath!,
            invocation: {} as never,
          };
        } else {
          const boundedContext = await boundedVerifierInvocationContext(
            item,
            "work_item",
            pass + 1,
          );
          const verifierInput: VerifyWorkItemInput = boundedContext ? {
            runDir: input.runDir,
            worktreePath: input.worktreePath,
            workItem: item,
            ...boundedContext,
            intake: input.intake,
            codex: input.codex,
            attempt: pass + 1,
            progress: input.progress,
            workItemIndex: index + 1,
            workItemTotal: orderedWorkItems.length,
            budget,
          } : {
            runDir: input.runDir, worktreePath: input.worktreePath, workItem: item,
            implementation: implementationResult.implementation, verification: normalizedEvidence,
            intake: input.intake, codex: input.codex, attempt: pass + 1, progress: input.progress, budget,
            workItemIndex: index + 1, workItemTotal: orderedWorkItems.length,
          };
          reviewResult = await verifier(verifierInput);
        }
        if (verifierRecoveryContext !== null) {
          await recordAuthorizedRuntimeSuccess(
            verifierRecoveryOperation,
            verifierRecoveryContext,
            { review_path: controllerArtifactRelativePath(input.runDir, reviewResult.reviewPath) },
          );
        }
      } catch (error) {
        const blocker = `Verifier invocation failed for work item ${item.id}: ${errorMessage(error)}`;
        const recovered = await recordRetryableRuntimeBlocker({
          ...verifierRecoveryOperation,
          blocker,
          error,
          ...(verifierRecoveryContext === null ? {} : { recoveryContext: verifierRecoveryContext }),
        });
        manifest = recovered.manifest;
        await publishOperationalBlocker(item, index, reviewPass, "verifier_invalid", normalizedEvidence);
        return { status: "human_action_required", manifest, orderedWorkItems, implementationResults, verification: evidenceByItem, reviews, blocker: recovered.blocker };
      }
      reviews[item.id] ??= [];
      reviews[item.id].push(reviewResult.review);
      pass = reviewPass;
      let reviewPath = controllerArtifactRelativePath(input.runDir, reviewResult.reviewPath);
      const beforeReviewProgress = (await readManifestV2(input.runDir)).work_item_progress[item.id];
      const sameReviewSource = beforeReviewProgress?.review_path === reviewPath
        && beforeReviewProgress.verification_path === savedEvidencePath;
      manifest = await setProgress(input.runDir, item.id, {
        status: "in_progress",
        attempts: pass,
        implementation_path: implementationResult.reportPath,
        verification_path: savedEvidencePath,
        review_path: reviewPath,
        ...(policyEnabled ? {
          review_revision: sameReviewSource && beforeReviewProgress?.review_revision
            ? beforeReviewProgress.review_revision
            : manifest.review_accounting!.review_revision + 1,
        } : {}),
      }, [reviewPath]);

      if (!policyEnabled) {
        const operational = await recordLegacyOperationalReview(item, reviewResult.review, reviewPass);
        if (operational) {
          manifest = operational.manifest;
          return {
            status: "human_action_required",
            manifest,
            orderedWorkItems,
            implementationResults,
            verification: evidenceByItem,
            reviews,
            blocker: operational.blocker,
          };
        }
        const reviewedProgress = (await readManifestV2(input.runDir)).work_item_progress[item.id];
        if (reviewedProgress?.mutation_kind === "quality_recovery"
          && reviewedProgress.recovery_state === "in_progress"
          && reviewedProgress.attempts === reviewPass) {
          manifest = await setProgress(input.runDir, item.id, {
            ...reviewedProgress,
            quality_recovery_attempts: 1,
            recovery_state: reviewResult.review.decision === "approve" ? "approved" : "exhausted",
          });
        }
      }

      while (
        !policyEnabled
        &&
        reviewResult.review.decision === "request_changes"
        && qualityGatePolicy
      ) {
        manifest = await readManifestV2(input.runDir);
        const queueProgress = manifest.work_item_progress[item.id];
        const primaryLimitReached = pass >= maxHandsFixAttempts + 1;
        const legacyQualityRecovery = primaryLimitReached
          && legacyQualityRecoveryAttempts(queueProgress) === 0
          && handsBackupPolicy !== undefined
          && manifest.active_hands_profile === "primary";
        if (primaryLimitReached && !legacyQualityRecovery) break;
        const queueResult = await runOrderedActionQueue({
          workItem: item,
          issueNumber: index + 1,
          review: reviewResult.review,
          reviewPass: pass,
          implementationResult,
          legacyQualityRecovery,
        });
        if (queueResult.kind === "blocked") {
          const blocker = queueResult.blocker;
          const current = await readManifestV2(input.runDir);
          manifest = await updateManifestV2(input.runDir, {
            delivery_state: "blocked",
            last_blocker: blocker,
            current_work_item_id: item.id,
            work_item_progress: {
              ...current.work_item_progress,
              [item.id]: {
                ...(current.work_item_progress[item.id] ?? {}),
                status: "blocked",
                blocker,
                blocker_code: queueResult.blockerCode,
                queue_state: "blocked",
              },
            },
          });
          return { status: "human_action_required", manifest, orderedWorkItems, implementationResults, verification: evidenceByItem, reviews, blocker };
        }
        if (queueResult.kind !== "review") {
          throw new Error("Legacy ordered queue returned a policy-only effect result");
        }
        implementationResult = queueResult.implementationResult;
        normalizedEvidence = queueResult.verification;
        savedEvidencePath = queueResult.savedEvidencePath;
        evidenceByItem[item.id] = normalizedEvidence;
        reviewResult = queueResult.reviewResult;
        pass = queueResult.reviewPass;
        reviewPath = controllerArtifactRelativePath(input.runDir, reviewResult.reviewPath);
        reviews[item.id].push(reviewResult.review);
        const operational = await recordLegacyOperationalReview(item, reviewResult.review, pass);
        if (operational) {
          manifest = operational.manifest;
          return { status: "human_action_required", manifest, orderedWorkItems, implementationResults, verification: evidenceByItem, reviews, blocker: operational.blocker };
        }
        if (legacyQualityRecovery) {
          const current = await readManifestV2(input.runDir);
          manifest = await setProgress(input.runDir, item.id, {
            ...current.work_item_progress[item.id]!,
            quality_recovery_attempts: 1,
            recovery_state: reviewResult.review.decision === "approve" ? "approved" : "exhausted",
          });
          break;
        }
      }

      if (policyEnabled) {
        const activePolicyCriteria = policyCriteria!;
        manifest = await readManifestV2(input.runDir);
        const policy = manifest.review_policy_snapshot!;
        const accounting = manifest.review_accounting!;
        const recordedFindings: EngineFinding[] = [];
        let warningAuthorization: WarningContinuationAuthorization | null = null;
        const currentProgress = manifest.work_item_progress[item.id];
        let cycle: ReviewCycleState;
        let reviewRevision: number;
        if (
          typeof currentProgress?.review_cycle_path === "string"
          && typeof currentProgress.review_effect_id === "string"
          && typeof currentProgress.review_revision === "number"
        ) {
          cycle = reviewCycleStateSchema.parse(await readRunArtifact<unknown>(
            input.runDir,
            currentProgress.review_cycle_path,
          ));
          reviewRevision = currentProgress.review_revision;
          if (
            cycle.decision_path !== currentProgress.review_cycle_path
            || cycle.effect_id !== currentProgress.review_effect_id
            || cycle.work_item_id !== item.id
            || cycle.phase !== "work_item"
            || cycle.review_revision !== reviewRevision
            || cycle.policy_hash !== hashReviewPolicy(policy)
          ) throw new Error(`Persisted work-item policy cycle provenance is invalid: ${item.id}`);
        } else {
          const expectedReviewRevision = currentProgress?.review_revision
            ?? accounting.review_revision + 1;
          let discoveredCycle: ReviewCycleState | null = null;
          try {
            discoveredCycle = reviewCycleStateSchema.parse(await readRunArtifact<unknown>(
              input.runDir,
              reviewDecisionPath(item.id, expectedReviewRevision),
            ));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
          if (discoveredCycle) {
            const reference = discoveredCycle.work_item_progress_reference;
            const expectedReviewPath = controllerArtifactRelativePath(input.runDir, reviewResult.reviewPath);
            if (
              discoveredCycle.work_item_id !== item.id
              || discoveredCycle.phase !== "work_item"
              || discoveredCycle.review_revision !== expectedReviewRevision
              || discoveredCycle.policy_hash !== hashReviewPolicy(policy)
              || !reference
              || reference.attempts !== reviewPass
              || reference.review_path !== expectedReviewPath
              || reference.verification_path !== savedEvidencePath
            ) throw new Error(`Discovered work-item policy cycle provenance is invalid: ${item.id}`);
            reviewRevision = discoveredCycle.review_revision;
            cycle = await beginReviewCycle({
              run_dir: input.runDir,
              work_item_id: discoveredCycle.work_item_id,
              phase: discoveredCycle.phase,
              review_revision: discoveredCycle.review_revision,
              policy_hash: discoveredCycle.policy_hash,
              finding_ids: discoveredCycle.finding_ids,
              accounting_before: discoveredCycle.accounting_before,
              work_item_progress_reference: reference,
              evaluate: () => { throw new Error("Persisted work-item cycle must not be reevaluated"); },
            });
          } else {
            reviewRevision = expectedReviewRevision;
          const normalized = normalizeReviewInputs({
            work_item_id: item.id,
            phase: "work_item",
            review_revision: reviewRevision,
            review: reviewResult.review,
            verification: normalizedEvidence,
            criteria: activePolicyCriteria,
            criterion_aliases: criterionAliasesForAcceptance(item.acceptance, activePolicyCriteria),
            release_guards: manifest.release_guards ?? [],
            severity_defaults: policy.severity_defaults,
            verification_criterion_ref: activePolicyCriteria[0]!.ref,
            writable_paths: item.file_contract
              .filter((entry) => entry.permission !== "read_only")
              .map((entry) => entry.path),
          });
          if (normalized.operational_blocker) {
            const blocker = `${normalized.operational_blocker.code}: ${normalized.operational_blocker.message}`;
            manifest = await recordRuntimeBlocker(input.runDir, blocker, item.id, reviewPass);
            return {
              status: "human_action_required",
              manifest,
              orderedWorkItems,
              implementationResults,
              verification: evidenceByItem,
              reviews,
              blocker,
            };
          }
          for (const finding of normalized.findings) {
            recordedFindings.push(await recordFindingRevision(input.runDir, {
              work_item_id: finding.work_item_id,
              source: finding.source,
              severity: finding.severity,
              disposition: finding.disposition,
              criterion_ref: finding.criterion_ref,
              normalized_location: finding.normalized_location,
              problem_class: finding.problem_class,
              problem: finding.problem,
              required_fix: finding.required_fix,
              evidence_refs: finding.evidence_refs,
              review_revision: reviewRevision,
            }));
          }
          const findingIds = [...new Set(recordedFindings.map((finding) => finding.finding_id))].sort();
          warningAuthorization = await warningAuthorizationForReview({
            workItemId: item.id,
            reviewRevision,
            policy,
            accounting,
            findings: recordedFindings,
            reviewPath: controllerArtifactRelativePath(input.runDir, reviewResult.reviewPath),
            verificationPath: savedEvidencePath,
          });
          cycle = await beginReviewCycle({
            run_dir: input.runDir,
            work_item_id: item.id,
            phase: "work_item",
            review_revision: reviewRevision,
            policy_hash: hashReviewPolicy(policy),
            finding_ids: findingIds,
            accounting_before: accounting,
            work_item_progress_reference: {
              attempts: reviewPass,
              review_path: controllerArtifactRelativePath(input.runDir, reviewResult.reviewPath),
              verification_path: savedEvidencePath,
            },
            evaluate: () => evaluateReviewPolicy({
              policy,
              findings: recordedFindings,
              accounting,
              phase: "work_item",
              operational_blocker: null,
              replan_patch_pending: false,
              authorization: warningAuthorization,
              quality_recovery: qualityRecoveryEligibilitySnapshot(manifest, item.id),
            }),
          }, {
            afterDecisionPersisted: async () => input.dependencies?.afterCheckpoint?.("after_work_item_decision"),
          });
          }
        }
        const canonicalFindings = await loadFindingRevisionRecords(
          input.runDir,
          item.id,
          reviewRevision,
          cycle.finding_ids,
        );
        recordedFindings.splice(0, recordedFindings.length, ...canonicalFindings);
        if (cycle.decision.action === "continue_with_warning" && warningAuthorization === null) {
          warningAuthorization = await warningAuthorizationForReview({
            workItemId: item.id,
            reviewRevision,
            policy,
            accounting: cycle.accounting_before,
            findings: recordedFindings,
            reviewPath: cycle.work_item_progress_reference!.review_path,
            verificationPath: cycle.work_item_progress_reference!.verification_path,
          });
          if (warningAuthorization === null) throw new Error(`Persisted warning decision is missing authorization: ${item.id}`);
        }
        await input.dependencies?.afterCheckpoint?.("after_work_item_cycle_started");
        manifest = await readManifestV2(input.runDir);
        if (!isReviewEffectAction(cycle.decision.action) && cycle.decision.action !== "await_plan_approval") {
          await writeConvergenceReport({
            run_dir: input.runDir,
            cycle,
            policy,
            accounting: manifest.review_accounting!,
            finding_index: manifest.finding_index ?? {},
            findings: recordedFindings,
            release_guards: manifest.release_guards ?? [],
            authorization: warningAuthorization,
          });
          await publishRuntimeStatusCheckpoint(input, orderedWorkItems);
          await input.dependencies?.afterCheckpoint?.("after_status_policy_publication");
          await input.dependencies?.afterCheckpoint?.("after_work_item_convergence_report");
          manifest = await readManifestV2(input.runDir);
        }
        if (cycle.decision.action === "await_plan_approval") {
          const existingSummary = manifest.convergence_reports?.[item.id];
          if (
            !existingSummary
            || existingSummary.plan_revision !== manifest.review_accounting!.plan_revision
            || existingSummary.review_revision >= cycle.review_revision
            || existingSummary.recommended_action !== "create_replan"
          ) throw new Error(`Awaiting plan approval requires the prior replan convergence report: ${item.id}`);
          const existingReport = convergenceReportSchema.parse(await readRunArtifact<unknown>(
            input.runDir,
            existingSummary.path,
          ));
          if (
            existingReport.work_item_id !== item.id
            || existingReport.plan_revision !== existingSummary.plan_revision
            || existingReport.review_revision !== existingSummary.review_revision
            || existingReport.recommended_action !== "create_replan"
          ) throw new Error(`Pending replan convergence provenance is invalid: ${item.id}`);
        }
        const replanBlocker = `Review policy requires replanning for work item ${item.id}`;
        const loadReplan = async (existingOnly: boolean) => {
          const current = await readManifestV2(input.runDir);
          const summary = current.convergence_reports?.[item.id];
          if (!summary || summary.recommended_action !== "create_replan") {
            throw new Error(`Create-replan effect requires its convergence report: ${item.id}`);
          }
          const report = convergenceReportSchema.parse(await readRunArtifact<unknown>(
            input.runDir,
            summary.path,
          ));
          const replan = await createReplanPatch({
            run_dir: input.runDir,
            repo_root: current.worktree_path ?? current.repo_root,
            codex: input.codex,
            target_work_item: item,
            base_plan_revision: report.plan_revision,
            unresolved_finding_ids: report.unresolved_finding_ids,
            convergence_report_path: summary.path,
            release_guards: current.release_guards ?? [],
            evidence_paths: report.evidence_refs,
            model_profile: input.intake.roles.brain,
            existing_only: existingOnly,
            budget,
          });
          return { replan, report };
        };
        let claim: Awaited<ReturnType<typeof claimReviewEffect>>;
        try {
          claim = await claimReviewEffect({
            run_dir: input.runDir,
            cycle,
            owner: policyEffectOwner,
          });
          if (cycle.decision.action === "create_replan" && claim.status === "acquired") {
            await input.dependencies?.afterCheckpoint?.("after_replan_effect_claim");
          }
        } catch (error) {
          if (isReviewEffectAction(cycle.decision.action) && error instanceof AmbiguousEffectError) {
            const current = await readManifestV2(input.runDir);
            const progress = current.work_item_progress[item.id];
            if (progress?.review_effect_id !== cycle.effect_id) throw error;
            claim = await recoverClaimedReviewEffectBeforeQueue({
              run_dir: input.runDir,
              cycle,
              owner: policyEffectOwner,
              queue_persisted: typeof progress.queue_path === "string",
            });
          } else {
            if (cycle.decision.action !== "create_replan" || !(error instanceof AmbiguousEffectError)) {
              throw error;
            }
            const { replan } = await loadReplan(true);
            const replanPatchPath = controllerArtifactRelativePath(input.runDir, replanArtifactPathForValidation(input.runDir, replan.path));
            const completed = await completeReviewEffect({
              run_dir: input.runDir,
              cycle,
              owner: policyEffectOwner,
              outcome: "complete",
              result: { blocker: replanBlocker, replan_patch_path: replanPatchPath },
            });
            claim = { status: "complete", cycle: completed };
          }
        }
        const transition = workItemDecisionTransition(cycle.decision.action);

        if (isReviewEffectAction(cycle.decision.action)) {
          if (claim.status === "blocked") throw new Error(`Work-item fix effect ${cycle.effect_id} is blocked`);
          if (claim.status === "acquired") {
            await input.dependencies?.afterCheckpoint?.("after_work_item_fix_effect_claim");
            manifest = await readManifestV2(input.runDir);
            const recoveryScopeId = `work-item:${item.id}`;
            const recoveryProgress = await buildRecoveryProgressSubject({
              runDir: input.runDir,
              manifest,
              workItemId: item.id,
              findingIds: cycle.decision.finding_ids,
              implementationPath: implementationResult.reportPath,
              verificationPath: savedEvidencePath,
              reviewPath: cycle.work_item_progress_reference!.review_path,
              reviewRevision: cycle.review_revision,
            });
            const handsFixRecoveryOperation: RetryableRuntimeOperation = {
              workItemId: item.id,
              scopeId: recoveryScopeId,
              operation: "hands-invocation",
              attempt: pass + 1,
              classification: { failure_class: "invocation_failure", blocker_code: "hands_invocation_failed" },
              findingIds: cycle.decision.finding_ids,
              requestedEffect: cycle.decision.action,
              requestedEffectReason: cycle.decision.reason_code,
              allowDifferentAuthorizedSubject: true,
            };
            const usesOrderedReviewerAction = qualityGatePolicy !== null
              && qualityGatePolicy !== undefined
              && reviewResult.review.findings.length > 0;
            const handsFixRecoveryContext = usesOrderedReviewerAction
              ? null
              : await gateRetryableRuntimeOperation(handsFixRecoveryOperation);
            if (handsFixRecoveryContext?.gate.mode === "blocked") {
              const blocker = handsFixRecoveryContext.gate.guard_action === "diagnostic_stop"
                ? `Recovery diagnostic stop after repeated Hands invocation for work item ${item.id}`
                : `Recovery exhausted after Hands invocation for work item ${item.id}`;
              manifest = await updateManifestV2(input.runDir, { delivery_state: "blocked", last_blocker: blocker });
              return { status: "human_action_required", manifest, orderedWorkItems, implementationResults, verification: evidenceByItem, reviews, blocker };
            }
            const recoveryGate = usesOrderedReviewerAction || handsFixRecoveryContext?.gate.mode === "authorized_attempt"
              ? null
              : await gateReviewPolicyEffect({
                  runDir: input.runDir,
                  scopeId: recoveryScopeId,
                  operation: "work-item-fix",
                  effectAttemptId: cycle.effect_id,
                  decision: cycle.decision,
                  ...(resumeClaimedQueue ? { observationStage: "verifier_review" as const } : {}),
                  reviewCyclePath: cycle.decision_path,
                  progress: recoveryProgress,
                  ownedEvidenceRefs: {
                    implementation_path: implementationResult.reportPath,
                    verification_path: savedEvidencePath,
                    review_path: cycle.work_item_progress_reference!.review_path,
                  },
                });
            if (recoveryGate !== null && recoveryGate.guard_action !== "allow_next_effect") {
              const blocker = recoveryGate.guard_action === "diagnostic_stop"
                ? `Recovery diagnostic stop for work item ${item.id}`
                : recoveryGate.guard_action === "exhausted_stop"
                  ? `Recovery exhausted for work item ${item.id}`
                  : `Recovery awaits an external fix for work item ${item.id}`;
              manifest = await updateManifestV2(input.runDir, {
                delivery_state: "blocked",
                last_blocker: blocker,
              });
              return { status: "human_action_required", manifest, orderedWorkItems, implementationResults, verification: evidenceByItem, reviews, blocker };
            }
            if (transition && manifest.stage !== transition) {
              manifest = await transitionRun(input.runDir, transition, {
                actor: "runtime",
                payload: { work_item_id: item.id, review_revision: reviewRevision, decision: cycle.decision.action },
              });
            }
            if (qualityGatePolicy && reviewResult.review.findings.length > 0) {
              const orderedRecoveryOperation: RetryableRuntimeOperation = {
                workItemId: item.id,
                scopeId: `work-item:${item.id}`,
                operation: "ordered-reviewer-action",
                attempt: pass,
                classification: { failure_class: "operational_blocker", blocker_code: "transport_failure" },
                findingIds: cycle.decision.finding_ids,
                requestedEffect: cycle.decision.action,
                requestedEffectReason: cycle.decision.reason_code,
              };
              const orderedRecoveryContext = await gateRetryableRuntimeOperation(
                orderedRecoveryOperation,
              );
              if (orderedRecoveryContext.gate.mode === "blocked") {
                const blocker = orderedRecoveryContext.gate.guard_action === "diagnostic_stop"
                  ? "Recovery diagnostic stop after repeated ordered-reviewer-action"
                  : "Recovery exhausted after ordered-reviewer-action";
                manifest = await updateManifestV2(input.runDir, { delivery_state: "blocked", last_blocker: blocker });
                return { status: "human_action_required", manifest, orderedWorkItems, implementationResults, verification: evidenceByItem, reviews, blocker };
              }
              const queueResult = await executeOrderedFixEffect(cycle, {
                workItem: item,
                issueNumber: index + 1,
                review: reviewResult.review,
                reviewPass: pass,
                policyCriterionAliases: criterionAliasesForAcceptance(item.acceptance, activePolicyCriteria),
                implementationResult,
                recoverStartedPacketInvocation: orderedRecoveryContext.gate.mode === "authorized_attempt",
              }, policyEffectOwner);
              if (
                queueResult.kind === "replan_required"
                || (queueResult.kind === "still_blocking" && queueResult.successful_hands_fixes === 0)
              ) {
                await recordAuthorizedRuntimeSuccess(
                  orderedRecoveryOperation,
                  orderedRecoveryContext,
                  {
                    implementation_path: implementationResult.reportPath,
                    verification_path: savedEvidencePath,
                    review_path: cycle.work_item_progress_reference!.review_path,
                  },
                );
                await completeReviewEffect({
                  run_dir: input.runDir,
                  cycle,
                  owner: policyEffectOwner,
                  outcome: "complete",
                  result: queueResult.kind === "replan_required"
                    ? { kind: "still_blocking", successful_hands_fixes: 0, evidence_paths: [] }
                    : {
                        kind: queueResult.kind,
                        successful_hands_fixes: queueResult.successful_hands_fixes,
                        evidence_paths: queueResult.evidence_paths,
                      },
                });
                await input.dependencies?.afterCheckpoint?.("after_ordered_replan_effect_complete");
                const blocker = queueResult.kind === "replan_required"
                  ? `Fix packet requires replanning for work item ${item.id}: ${queueResult.blocker}`
                  : `Reviewer fix effect made no successful Hands mutation for work item ${item.id}`;
                return prepareZeroMutationReplan(cycle, blocker);
              }
              if (queueResult.kind === "operationally_blocked") {
                const blocker = queueResult.blocker.message;
                if (queueResult.blocker.code === "corrupt_state" || queueResult.blocker.code === "invalid_verifier_contract") {
                  manifest = await updateManifestV2(input.runDir, { delivery_state: "blocked", last_blocker: blocker });
                  return { status: "human_action_required", manifest, orderedWorkItems, implementationResults, verification: evidenceByItem, reviews, blocker };
                }
                const recovered = await recordRetryableRuntimeBlocker({
                  ...orderedRecoveryOperation,
                  blocker,
                  classification: { failure_class: "operational_blocker", blocker_code: queueResult.blocker.code },
                  error: new Error(blocker),
                  recoveryContext: orderedRecoveryContext,
                });
                manifest = recovered.manifest;
                return { status: "human_action_required", manifest, orderedWorkItems, implementationResults, verification: evidenceByItem, reviews, blocker: recovered.blocker };
              }
              if (queueResult.kind === "complete" || queueResult.kind === "still_blocking") {
                await recordAuthorizedRuntimeSuccess(
                  orderedRecoveryOperation,
                  orderedRecoveryContext,
                  {
                    implementation_path: queueResult.implementationResult.reportPath,
                    verification_path: queueResult.savedEvidencePath,
                    review_path: cycle.work_item_progress_reference!.review_path,
                  },
                );
                await input.dependencies?.afterCheckpoint?.("after_ordered_recovery_outcome");
                implementationResult = queueResult.implementationResult;
                normalizedEvidence = queueResult.verification;
                savedEvidencePath = queueResult.savedEvidencePath;
                evidenceByItem[item.id] = normalizedEvidence;
                await completeReviewEffect({
                  run_dir: input.runDir,
                  cycle,
                  owner: policyEffectOwner,
                  outcome: "complete",
                  result: {
                    kind: queueResult.kind,
                    successful_hands_fixes: queueResult.successful_hands_fixes,
                    evidence_paths: queueResult.evidence_paths,
                  },
                });
                await input.dependencies?.afterCheckpoint?.("after_ordered_fix_effect_complete");
                await input.dependencies?.afterCheckpoint?.("after_work_item_effect");
                manifest = await readManifestV2(input.runDir);
                if (manifest.stage === "fixing") {
                  manifest = await transitionRun(input.runDir, "verifying", {
                    actor: "runtime",
                    payload: { work_item_id: item.id, review_revision: cycle.review_revision, effect_complete: true },
                  });
                }
                if (manifest.stage === "verifying") {
                  manifest = await transitionRun(input.runDir, "verifier_review", {
                    actor: "runtime",
                    payload: { work_item_id: item.id, review_revision: cycle.review_revision, effect_complete: true },
                  });
                }
                manifest = await setProgress(input.runDir, item.id, {
                  ...(await readManifestV2(input.runDir)).work_item_progress[item.id],
                  status: "in_progress",
                  attempts: queueResult.reviewPass,
                  implementation_path: implementationResult.reportPath,
                  verification_path: savedEvidencePath,
                  queue_state: "complete",
                  review_path: undefined,
                  review_cycle_path: undefined,
                  review_effect_id: undefined,
                }, [implementationResult.reportPath, savedEvidencePath]);
                progress = manifest.work_item_progress[item.id];
                pass = queueResult.reviewPass - 1;
                resumeReview = true;
                continue;
              }
            }
            if (handsFixRecoveryContext === null) {
              throw new Error("Ordered Reviewer action returned without a terminal queue result");
            }
            try {
              implementationResult = await invokeHands(
                item,
                pass + 1,
                cycle.decision.action === "quality_recovery" ? "quality_recovery" : "primary_fix",
                recordedFindings.map((finding) => engineFindingToVerifierFinding(finding, activePolicyCriteria, item.verification_commands)),
              );
            } catch (error) {
              if (error instanceof NonRetryableHandsResultError) {
                const blocker = `Hands result failed validation while fixing work item ${item.id}: ${errorMessage(error)}`;
                manifest = await recordRuntimeBlocker(input.runDir, blocker, item.id, pass + 1);
                return { status: "human_action_required", manifest, orderedWorkItems, implementationResults, verification: evidenceByItem, reviews, blocker };
              }
              const blocker = `Hands invocation failed while fixing work item ${item.id}: ${errorMessage(error)}`;
              if (handsFixRecoveryContext.gate.mode === "authorized_attempt") {
                const recovered = await recordRetryableRuntimeBlocker({
                  ...handsFixRecoveryOperation,
                  blocker,
                  error,
                  recoveryContext: handsFixRecoveryContext,
                });
                manifest = recovered.manifest;
                return { status: "human_action_required", manifest, orderedWorkItems, implementationResults, verification: evidenceByItem, reviews, blocker: recovered.blocker };
              }
              if (recoveryGate?.mode === "authorized_attempt") {
                await recordAuthorizedRecoveryOutcome({
                  runDir: input.runDir,
                  scopeId: recoveryScopeId,
                  operation: "work-item-fix",
                  authorizationId: recoveryGate.authorization_id,
                  effectAttemptId: recoveryGate.effect_attempt_id,
                  outcome: {
                    kind: "failure",
                    decision: cycle.decision,
                    classification: { failure_class: "implementation_failure", blocker_code: cycle.decision.reason_code },
                    error,
                  },
                  progress: recoveryProgress,
                  ownedEvidenceRefs: {
                    implementation_path: implementationResult.reportPath,
                    verification_path: savedEvidencePath,
                    review_path: cycle.work_item_progress_reference!.review_path,
                  },
                });
              }
              if (recoveryGate?.mode === "authorized_attempt") {
                manifest = await recordRuntimeBlocker(input.runDir, blocker, item.id, pass + 1);
                return { status: "human_action_required", manifest, orderedWorkItems, implementationResults, verification: evidenceByItem, reviews, blocker };
              }
              const recovered = await recordRetryableRuntimeBlocker({
                workItemId: item.id,
                scopeId: recoveryScopeId,
                operation: "hands-invocation",
                attempt: pass + 1,
                blocker,
                classification: { failure_class: "invocation_failure", blocker_code: "hands_invocation_failed" },
                error,
                findingIds: cycle.decision.finding_ids,
                requestedEffect: cycle.decision.action,
                requestedEffectReason: cycle.decision.reason_code,
              });
              manifest = recovered.manifest;
              return { status: "human_action_required", manifest, orderedWorkItems, implementationResults, verification: evidenceByItem, reviews, blocker: recovered.blocker };
            }
            await recordAuthorizedRuntimeSuccess(
              handsFixRecoveryOperation,
              handsFixRecoveryContext,
              { implementation_path: implementationResult.reportPath },
            );
            manifest = await setProgress(input.runDir, item.id, {
              status: "in_progress",
              attempts: pass + 1,
              mutation_kind: cycle.decision.action === "quality_recovery" ? "quality_recovery" : "normal_fix",
              verification_path: undefined,
              verification_scope: undefined,
              verification_work_item_id: undefined,
              verification_issue_number: undefined,
              self_review_pass: 0,
              self_review_state: "pending",
              mutation_verification_path: undefined,
              self_review_paths: undefined,
              self_review_verification_paths: undefined,
              implementation_path: implementationResult.reportPath,
              review_path: controllerArtifactRelativePath(input.runDir, reviewResult.reviewPath),
              review_revision: reviewRevision,
            }, [implementationResult.reportPath]);
            implementationResult = {
              ...implementationResult,
              implementation: await loadPersistedImplementation(input.runDir, manifest.work_item_progress[item.id], item),
            };
            if (recoveryGate?.mode === "authorized_attempt") {
              const resultingProgress = await buildRecoveryProgressSubject({
                runDir: input.runDir,
                manifest,
                workItemId: item.id,
                findingIds: cycle.decision.finding_ids,
                implementationPath: implementationResult.reportPath,
                verificationPath: savedEvidencePath,
                reviewPath: cycle.work_item_progress_reference!.review_path,
                reviewRevision: cycle.review_revision,
              });
              await recordAuthorizedRecoveryOutcome({
                runDir: input.runDir,
                scopeId: recoveryScopeId,
                operation: "work-item-fix",
                authorizationId: recoveryGate.authorization_id,
                effectAttemptId: recoveryGate.effect_attempt_id,
                outcome: { kind: "success", decision: cycle.decision },
                progress: resultingProgress,
                ownedEvidenceRefs: {
                  implementation_path: implementationResult.reportPath,
                  verification_path: savedEvidencePath,
                  review_path: cycle.work_item_progress_reference!.review_path,
                },
              });
            }
            await completeReviewEffect({
              run_dir: input.runDir,
              cycle,
              owner: policyEffectOwner,
              outcome: "complete",
              result: { attempt: pass + 1, implementation_path: implementationResult.reportPath },
            });
            await input.dependencies?.afterCheckpoint?.("after_work_item_effect");
          }
          await incrementSuccessfulFix({
            run_dir: input.runDir,
            cycle,
            owner: policyEffectOwner,
            mutation_id: implementationResult.reportPath,
            kind: "successful_fix",
            effect_action: cycle.decision.action,
          });
          const afterFix = await readManifestV2(input.runDir);
          manifest = await setProgress(input.runDir, item.id, {
            ...(afterFix.work_item_progress[item.id] ?? { status: "in_progress", attempts: pass + 1 }),
            review_cycle_path: undefined,
            review_effect_id: undefined,
          });
          continue;
        }

        if (cycle.decision.action === "advance" || cycle.decision.action === "continue_with_warning") {
          if (claim.status === "blocked") throw new Error(`Work-item advance effect ${cycle.effect_id} is blocked`);
          const latestProgress = (await readManifestV2(input.runDir)).work_item_progress[item.id];
          let recoveredCommitSha: string | null = null;
          if (claim.status === "complete" && latestProgress?.policy_commit_pending === true) {
            recoveredCommitSha = await loadPolicyCommitResult(input.runDir, cycle);
          }
          let completed = claim.status === "complete"
            ? await requireCompletedAdvanceEffect({ run_dir: input.runDir, cycle, owner: policyEffectOwner })
            : null;
          if (claim.status === "acquired") {
            const hasChanges = await worktreeHasChanges(input.worktreePath);
            const completion = await completeReviewEffect({
              run_dir: input.runDir,
              cycle,
              owner: policyEffectOwner,
              outcome: "complete",
              result: { commit_sha: hasChanges ? "policy-authorized" : "no-op" },
            });
            completed = { cycle: completion, commit_sha: hasChanges ? "policy-authorized" : "no-op" };
          }
          if (!completed) throw new Error(`Work-item advance effect ${cycle.effect_id} did not complete`);
          let commitSha = completed.commit_sha;
          if (completed.commit_sha === "policy-authorized") {
            if (recoveredCommitSha !== null) {
              const intent = {
                parent_sha: latestProgress!.policy_commit_parent_sha,
                tree_sha: latestProgress!.policy_commit_tree_sha,
                message: latestProgress!.policy_commit_message,
              };
              const currentHead = await (input.dependencies?.localHeadSha ?? resolveLocalHeadSha)(input.worktreePath);
              const committed = await (input.dependencies?.localCommitProvenance ?? resolveLocalCommitProvenance)(input.worktreePath, currentHead);
              if (
                currentHead !== recoveredCommitSha
                || !isGitObjectId(intent.parent_sha)
                || !isGitObjectId(intent.tree_sha)
                || intent.message !== `work-item: ${item.id.trim()} ${item.title.trim()}`
                || latestProgress!.policy_commit_review_cycle_path !== cycle.decision_path
                || latestProgress!.policy_commit_review_effect_id !== cycle.effect_id
                || committed.sha !== recoveredCommitSha
                || committed.parent_shas.length !== 1
                || committed.parent_shas[0] !== intent.parent_sha
                || committed.tree_sha !== intent.tree_sha
                || committed.message !== intent.message
              ) throw new Error(`Persisted work-item commit result no longer matches HEAD and durable intent: ${item.id}`);
              commitSha = committed.sha;
            } else {
              const beforeProgress = (await readManifestV2(input.runDir)).work_item_progress[item.id]!;
              const resumedIntent = beforeProgress.policy_commit_pending === true;
              const intent = resumedIntent
                ? {
                    parent_sha: beforeProgress.policy_commit_parent_sha,
                    tree_sha: beforeProgress.policy_commit_tree_sha,
                    message: beforeProgress.policy_commit_message,
                  }
                : await (input.dependencies?.prepareCommitIntent ?? prepareWorkItemCommitIntent)(
                    input.worktreePath,
                    item.id,
                    item.title,
                  );
              const expectedMessage = `work-item: ${item.id.trim()} ${item.title.trim()}`;
              if (
                !isGitObjectId(intent.parent_sha)
                || !isGitObjectId(intent.tree_sha)
                || intent.message !== expectedMessage
                || (resumedIntent && beforeProgress.policy_commit_review_cycle_path !== cycle.decision_path)
                || (resumedIntent && beforeProgress.policy_commit_review_effect_id !== cycle.effect_id)
              ) throw new Error(`Work-item commit intent provenance is invalid: ${item.id}`);
              const headBefore = await (input.dependencies?.localHeadSha ?? resolveLocalHeadSha)(input.worktreePath);
              if (!resumedIntent) {
                if (headBefore !== intent.parent_sha) throw new Error(`Work-item commit intent raced with a local branch advance: ${item.id}`);
                manifest = await setProgress(input.runDir, item.id, {
                  ...beforeProgress,
                  policy_commit_pending: true,
                  policy_commit_parent_sha: intent.parent_sha,
                  policy_commit_tree_sha: intent.tree_sha,
                  policy_commit_message: intent.message,
                  policy_commit_review_cycle_path: cycle.decision_path,
                  policy_commit_review_effect_id: cycle.effect_id,
                  policy_commit_invoked: false,
                });
                await input.dependencies?.afterCheckpoint?.("after_work_item_commit_intent");
              }
              let committed = headBefore === intent.parent_sha
                ? null
                : await (input.dependencies?.localCommitProvenance ?? resolveLocalCommitProvenance)(input.worktreePath, headBefore);
              if (committed === null) {
                if (resumedIntent && beforeProgress.policy_commit_invoked === true) {
                  throw new Error(`Work-item commit invocation returned to its parent or was reset: ${item.id}`);
                }
                manifest = await setProgress(input.runDir, item.id, {
                  ...(await readManifestV2(input.runDir)).work_item_progress[item.id],
                  policy_commit_invoked: true,
                });
                const refreshedIntent = await (input.dependencies?.prepareCommitIntent ?? prepareWorkItemCommitIntent)(
                  input.worktreePath,
                  item.id,
                  item.title,
                );
                const refreshedHead = await (input.dependencies?.localHeadSha ?? resolveLocalHeadSha)(input.worktreePath);
                if (
                  refreshedHead !== intent.parent_sha
                  || refreshedIntent.parent_sha !== intent.parent_sha
                  || refreshedIntent.tree_sha !== intent.tree_sha
                  || refreshedIntent.message !== intent.message
                ) throw new Error(`Work-item commit tree drifted after durable intent: ${item.id}`);
                commitSha = await commit({
                worktreePath: input.worktreePath,
                workItemId: item.id,
                title: item.title,
                verifierApproved: false,
                policyProof: { runDir: input.runDir, cycle, owner: policyEffectOwner },
                });
                await input.dependencies?.afterCheckpoint?.("after_work_item_advance_commit");
                const currentHead = await (input.dependencies?.localHeadSha ?? resolveLocalHeadSha)(input.worktreePath);
                if (currentHead !== commitSha) throw new Error(`Work-item commit returned a SHA that is not local HEAD: ${item.id}`);
                committed = await (input.dependencies?.localCommitProvenance ?? resolveLocalCommitProvenance)(input.worktreePath, currentHead);
              }
              if (
                committed.sha !== commitSha && commitSha !== "policy-authorized"
                || committed.parent_shas.length !== 1
                || committed.parent_shas[0] !== intent.parent_sha
                || committed.tree_sha !== intent.tree_sha
                || committed.message !== intent.message
              ) throw new Error(`Work-item commit provenance does not match its durable intent: ${item.id}`);
              commitSha = committed.sha;
              await recordPolicyCommitResult(input.runDir, cycle, commitSha);
              await input.dependencies?.afterCheckpoint?.("after_work_item_commit_result");
            }
          }
          implementationResults[item.id] = implementationResult.implementation;
          const completionProgress = {
            attempts: pass,
            commit_sha: commitSha,
            implementation_path: implementationResult.reportPath,
            verification_path: savedEvidencePath,
            review_path: controllerArtifactRelativePath(input.runDir, reviewResult.reviewPath),
            review_revision: reviewRevision,
            review_cycle_path: cycle.decision_path,
            review_effect_id: cycle.effect_id,
          };
          const completionArtifacts = [
            implementationResult.reportPath,
            savedEvidencePath,
            controllerArtifactRelativePath(input.runDir, reviewResult.reviewPath),
          ];
          if (manifest.workflow_protocol === "bounded-context-v1") {
            manifest = await setProgress(input.runDir, item.id, {
              ...completionProgress,
              status: "in_progress",
            }, completionArtifacts);
            await input.dependencies?.afterCheckpoint?.("after_work_item_completion_commit");
            const summary = await persistBoundedCompletionSummary({
              workItem: item,
              attempt: pass,
              commitSha,
              completionBasis: cycle.decision.action === "advance"
                ? "policy_advance"
                : "policy_warning_continuation",
              policyDecisionPath: cycle.decision_path,
              findingIds: [...cycle.finding_ids],
            });
            if (!summary) throw new Error(`Bounded work-item summary was not created: ${item.id}`);
            await input.dependencies?.afterCheckpoint?.("after_work_item_summary_persisted");
            manifest = await setProgress(input.runDir, item.id, {
              ...completionProgress,
              status: "complete",
              blocker: undefined,
              blocker_code: undefined,
              policy_commit_pending: false,
              summary_path: summary.path,
              summary_sha256: summary.sha256,
            }, [...completionArtifacts, summary.path]);
            await input.dependencies?.afterCheckpoint?.("after_work_item_summary_pointer");
            await publishWorkItemStatus(item, index, "complete", pass, normalizedEvidence, reviewResult.review);
          } else {
            manifest = await setProgress(input.runDir, item.id, {
              ...completionProgress,
              status: "complete",
              blocker: undefined,
              blocker_code: undefined,
              policy_commit_pending: false,
            }, completionArtifacts);
          }
          await input.dependencies?.afterCheckpoint?.("after_work_item_advance_effect");
          break;
        }

        const blocker = cycle.decision.action === "create_replan"
          ? replanBlocker
          : cycle.decision.action === "await_plan_approval"
            ? `Review policy is awaiting plan approval for work item ${item.id}`
            : `Review policy stopped work item ${item.id}: ${cycle.decision.reason_code}`;
        if (cycle.decision.action === "create_replan") {
          if (claim.status === "blocked") throw new Error(`Create-replan effect ${cycle.effect_id} is blocked`);
          let completed = claim.cycle;
          let replanPatchPath: string;
          if (claim.status === "acquired") {
            if (transition && manifest.stage !== transition) {
              manifest = await transitionRun(input.runDir, transition, {
                actor: "runtime",
                payload: { work_item_id: item.id, review_revision: reviewRevision, decision: cycle.decision.action, blocker },
              });
            }
            const { replan } = await loadReplan(false);
            replanPatchPath = controllerArtifactRelativePath(input.runDir, replanArtifactPathForValidation(input.runDir, replan.path));
            await input.dependencies?.afterCheckpoint?.("after_replan_patch_write");
            completed = await completeReviewEffect({
              run_dir: input.runDir,
              cycle,
              owner: policyEffectOwner,
              outcome: "complete",
              result: { blocker, replan_patch_path: replanPatchPath },
            });
            await input.dependencies?.afterCheckpoint?.("after_replan_effect_complete");
          } else {
            const result = completed.effect_result;
            if (
              !result
              || typeof result !== "object"
              || (result as { blocker?: unknown }).blocker !== blocker
              || typeof (result as { replan_patch_path?: unknown }).replan_patch_path !== "string"
            ) throw new Error(`Completed create-replan effect has invalid patch proof: ${cycle.effect_id}`);
            replanPatchPath = (result as { replan_patch_path: string }).replan_patch_path;
            const { replan } = await loadReplan(true);
            if (controllerArtifactRelativePath(input.runDir, replanArtifactPathForValidation(input.runDir, replan.path)) !== replanPatchPath) {
              throw new Error(`Completed create-replan effect patch proof does not match: ${cycle.effect_id}`);
            }
          }
          manifest = await recordReplanAwaitingState(
            input.runDir,
            blocker,
            item.id,
            pass,
            replanPatchPath,
          );
          await input.dependencies?.afterCheckpoint?.("after_replan_pointer_write");
          if (manifest.stage !== "replanning") {
            throw new Error(`Create-replan completion cannot prepare approval from stage ${manifest.stage}`);
          }
          const prepared = await finalizeRuntimePreparedReplan(
            input,
            await prepareRuntimeReplanApprovalBoundary(input, item.id),
          );
          manifest = prepared.manifest;
          return {
            status: "human_action_required",
            manifest,
            orderedWorkItems,
            implementationResults,
            verification: evidenceByItem,
            reviews,
            blocker: prepared.blocker ?? blocker,
            ...(prepared.state === "pending" ? { pendingReplanBoundary: prepared.coordinates } : {}),
          };
        }

        if (claim.status === "acquired") {
          if (transition && manifest.stage !== transition) {
            manifest = await transitionRun(input.runDir, transition, {
              actor: "runtime",
              payload: { work_item_id: item.id, review_revision: reviewRevision, decision: cycle.decision.action, blocker },
            });
          }
          manifest = await recordRuntimeBlocker(
            input.runDir,
            blocker,
            item.id,
            pass,
            "replan_required",
          );
          await completeReviewEffect({
            run_dir: input.runDir,
            cycle,
            owner: policyEffectOwner,
            outcome: cycle.decision.action === "stop" ? "blocked" : "complete",
            result: { blocker },
          });
          await input.dependencies?.afterCheckpoint?.("after_work_item_effect");
        } else {
          manifest = await readManifestV2(input.runDir);
        }
        return {
          status: "human_action_required",
          manifest,
          orderedWorkItems,
          implementationResults,
          verification: evidenceByItem,
          reviews,
          blocker,
        };
      }

      if (reviewResult.review.decision === "approve") {
        if (implementationScopeFailure !== null) {
          manifest = await recordRuntimeBlocker(
            input.runDir,
            implementationScopeFailure,
            item.id,
            pass,
            "replan_required",
          );
          return {
            status: "human_action_required",
            manifest,
            orderedWorkItems,
            implementationResults,
            verification: evidenceByItem,
            reviews,
            blocker: implementationScopeFailure,
          };
        }
        const recoveredCommitSha = recoveredBoundedCompletionMarker !== undefined
          ? recoveredBoundedCompletionMarker
          : await recoverBoundedDirectCommit({
              workItem: item,
              attempt: pass,
              implementationPath: implementationResult.reportPath,
              verificationPath: savedEvidencePath,
              reviewPath,
            });
        const changed = recoveredCommitSha === null && await worktreeHasChanges(input.worktreePath);
        const commitSha = recoveredCommitSha
          ?? (changed
            ? await commit({
                worktreePath: input.worktreePath,
                workItemId: item.id,
                title: item.title,
                verifierApproved: true,
              })
            : "no-op");
        if (recoveredCommitSha === null && manifest.workflow_protocol === "bounded-context-v1") {
          const current = await readManifestV2(input.runDir);
          const progress = current.work_item_progress[item.id];
          if (
            progress?.context_plan_revision !== assertApprovedCurrentPlanRevision(current)
            || !isGitObjectId(progress.context_base_commit)
          ) throw new Error(`Bounded direct work-item context authority is incomplete: ${item.id}`);
          await validateBoundedDirectCompletionCommit({
            workItem: item,
            baseCommit: progress.context_base_commit,
            commitSha,
          });
        }
        if (changed) await input.progress?.emit({ code: "changes_committed", source: "runtime" });
        implementationResults[item.id] = implementationResult.implementation;
        const completionProgress = {
          attempts: pass,
          commit_sha: commitSha,
          implementation_path: implementationResult.reportPath,
          verification_path: savedEvidencePath,
          review_path: reviewPath,
          ...verificationProgressIdentity(itemIdentity),
        };
        const completionArtifacts = [implementationResult.reportPath, savedEvidencePath, reviewPath];
        if (manifest.workflow_protocol === "bounded-context-v1") {
          manifest = await setProgress(input.runDir, item.id, {
            ...completionProgress,
            status: "in_progress",
            review_revision: pass,
          }, completionArtifacts);
          await input.dependencies?.afterCheckpoint?.("after_work_item_completion_commit");
          const summary = await persistBoundedCompletionSummary({
            workItem: item,
            attempt: pass,
            commitSha,
            completionBasis: "verifier_approve",
            policyDecisionPath: null,
            findingIds: [],
          });
          if (!summary) throw new Error(`Bounded work-item summary was not created: ${item.id}`);
          await input.dependencies?.afterCheckpoint?.("after_work_item_summary_persisted");
          manifest = await setProgress(input.runDir, item.id, {
            ...completionProgress,
            status: "complete",
            blocker: undefined,
            blocker_code: undefined,
            review_revision: pass,
            summary_path: summary.path,
            summary_sha256: summary.sha256,
          }, [...completionArtifacts, summary.path]);
          await input.dependencies?.afterCheckpoint?.("after_work_item_summary_pointer");
        } else {
          manifest = await setProgress(input.runDir, item.id, {
            ...completionProgress,
            status: "complete",
            blocker: undefined,
            blocker_code: undefined,
          }, completionArtifacts);
        }
        await publishWorkItemStatus(item, index, "complete", pass, normalizedEvidence, reviewResult.review);
        break;
      }

      const reviewedProgress = (await readManifestV2(input.runDir)).work_item_progress[item.id];
      const recoveryRejected = reviewedProgress?.mutation_kind === "quality_recovery"
        && legacyQualityRecoveryAttempts(reviewedProgress) === 1;
      const primaryLimitReached = pass >= maxHandsFixAttempts + 1;
      const recoveryEligible = primaryLimitReached
        && !recoveryRejected
        && legacyQualityRecoveryAttempts(reviewedProgress) === 0
        && manifest.active_hands_profile === "primary"
        && handsBackupPolicy !== undefined
        && reviewResult.review.decision === "request_changes"
        && (reviewResult.review.failure_class ?? "implementation_failure") === "implementation_failure";
      if (recoveryEligible) {
        manifest = await transitionRun(input.runDir, "fixing", {
          actor: "runtime",
          payload: { work_item_id: item.id, pass, findings: reviewResult.review.findings, recovery: true },
        });
        await publishRuntimeStatusCheckpoint(input, orderedWorkItems);
        try {
          implementationResult = await invokeLegacyQualityRecovery(
            item,
            pass + 1,
            reviewResult.review.findings,
            reviews[item.id],
            implementationResult.implementation,
          );
        } catch (error) {
          const blocker = `Hands quality recovery failed for work item ${item.id}: ${errorMessage(error)}`;
          manifest = await recordRuntimeBlocker(input.runDir, blocker, item.id, pass + 1);
          return { status: "human_action_required", manifest, orderedWorkItems, implementationResults, verification: evidenceByItem, reviews, blocker };
        }
        continue;
      }

      if (reviewNeedsReplan(reviewResult.review) || primaryLimitReached) {
        const escalationExhausted = primaryLimitReached
          && reviewResult.review.decision === "request_changes"
          && (reviewResult.review.failure_class ?? "implementation_failure") === "implementation_failure";
        const blocker = escalationExhausted
          ? `blocked: escalation_exhausted for work item ${item.id}`
          : `Verifier requires replanning for work item ${item.id}`;
        manifest = await transitionRun(input.runDir, "replanning", {
          actor: "runtime",
          payload: { work_item_id: item.id, pass, blocker },
        });
        manifest = await updateManifestV2(input.runDir, {
          delivery_state: "blocked",
          last_blocker: blocker,
          current_work_item_id: item.id,
          work_item_progress: {
            ...manifest.work_item_progress,
            [item.id]: {
              ...(manifest.work_item_progress[item.id] ?? {}),
              status: "blocked",
              attempts: pass,
              blocker,
              github_status_transition_at: new Date().toISOString(),
              ...(escalationExhausted ? {
                blocker_code: "escalation_exhausted" as const,
                recovery_state: "exhausted" as const,
              } : {}),
            },
          },
        });
        await publishWorkItemStatus(item, index, "blocked", pass, normalizedEvidence, reviewResult.review, [{ kind: "replan_required", attempt: pass }]);
        return {
          status: "human_action_required",
          manifest,
          orderedWorkItems,
          implementationResults,
          verification: evidenceByItem,
          reviews,
          blocker,
        };
      }

      manifest = await transitionRun(input.runDir, "fixing", {
        actor: "runtime",
        payload: { work_item_id: item.id, pass, findings: reviewResult.review.findings },
      });
      await publishWorkItemStatus(item, index, "fixing", pass, normalizedEvidence, reviewResult.review, [{ kind: "reviewer_findings", attempt: pass }]);
      await publishRuntimeStatusCheckpoint(input, orderedWorkItems);
      await input.dependencies?.afterCheckpoint?.("after_status_fixing_publication");
      try {
        implementationResult = await invokeHands(item, pass + 1, "primary_fix", reviewResult.review.findings);
      } catch (error) {
        const blocker = `Hands invocation failed while fixing work item ${item.id}: ${errorMessage(error)}`;
        manifest = await recordRuntimeBlocker(input.runDir, blocker, item.id, pass + 1);
        await publishOperationalBlocker(item, index, pass + 1, "hands_invalid", normalizedEvidence, reviewResult.review);
        return { status: "human_action_required", manifest, orderedWorkItems, implementationResults, verification: evidenceByItem, reviews, blocker };
      }
      await setProgress(input.runDir, item.id, {
        status: "in_progress",
        attempts: pass + 1,
        primary_fix_attempts: Math.min(pass, maxHandsFixAttempts),
        mutation_kind: "normal_fix",
        verification_path: undefined,
        verification_scope: undefined,
        verification_work_item_id: undefined,
        verification_issue_number: undefined,
        self_review_pass: 0,
        self_review_state: "pending",
        mutation_verification_path: undefined,
        self_review_paths: undefined,
        self_review_verification_paths: undefined,
        implementation_path: implementationResult.reportPath,
      }, [implementationResult.reportPath]);
    }
  }

  if (manifest.stage === "replanning" && manifest.current_work_item_id === "integrated") {
    const integratedProgress = manifest.work_item_progress.integrated;
    if (typeof integratedProgress?.review_cycle_path !== "string"
      || typeof integratedProgress.review_effect_id !== "string"
      || typeof integratedProgress.review_revision !== "number") {
      throw new Error("Integrated replanning lacks resumable review-effect provenance");
    }
    const cycle = reviewCycleStateSchema.parse(await readRunArtifact<unknown>(
      input.runDir,
      integratedProgress.review_cycle_path,
    ));
    if (cycle.work_item_id !== "integrated"
      || cycle.effect_id !== integratedProgress.review_effect_id
      || cycle.review_revision !== integratedProgress.review_revision
      || cycle.decision.action !== "create_replan"
      || (cycle.phase !== "final_integrated" && cycle.phase !== "post_pr")) {
      throw new Error("Integrated replanning review-effect provenance is invalid");
    }
    const phasePolicy = {
      cycle,
      findings: await loadFindingRevisionRecords(
        input.runDir,
        cycle.work_item_id,
        cycle.review_revision,
        cycle.finding_ids,
      ),
      owner: `runtime:${cycle.phase}:integrated`,
    };
    try {
      const preparedReplan = await createPhaseReplan(
        phasePolicy,
        await claimPhaseReviewEffect(phasePolicy),
        integratedProgress.attempts,
      );
      return {
        status: "human_action_required",
        manifest,
        orderedWorkItems,
        implementationResults,
        verification: evidenceByItem,
        reviews,
        ...preparedReplan,
      };
    } catch (error) {
      const deterministicBlocked = await persistDeterministicReplanPreparationBlocker(input.runDir, error);
      if (deterministicBlocked === null) throw error;
      return {
        status: "human_action_required",
        manifest: deterministicBlocked.manifest,
        orderedWorkItems,
        implementationResults,
        verification: evidenceByItem,
        reviews,
        blocker: deterministicBlocked.blocker,
      };
    }
  }

  const finalStageAlreadyActive = manifest.current_work_item_id === "integrated"
    && ["verifying", "verifier_review", "fixing", "final_verification"].includes(manifest.stage);
  if (manifest.stage !== "final_verification" && !finalStageAlreadyActive) {
    manifest = await transitionRun(input.runDir, "final_verification", {
      actor: "runtime",
      payload: { work_item_id: "integrated", work_items: orderedWorkItems.map((item) => item.id), final: true, pass: 1 },
    });
    await publishRuntimeStatusCheckpoint(input, orderedWorkItems);
    await input.dependencies?.afterCheckpoint?.("after_status_verifying_publication");
  }
  const finalItem = integratedWorkItem(input.plan, {
    includeCompletedDependencies: manifest.workflow_protocol === "bounded-context-v1",
  });
  const finalIdentity = integratedVerificationIdentity();
  const integratedBrowserChecks = finalItem.browser_checks ?? [];
  const integratedExpectedArtifacts = finalItem.expected_artifacts ?? [];
  const finalIssueNumber = orderedWorkItems.length + 1;
  let persistedFinalProgress = manifest.work_item_progress["integrated"];
  let claimedFinalFixSourceAttempt: number | null = null;
  if (
    manifest.review_policy_snapshot
    && typeof persistedFinalProgress?.review_cycle_path === "string"
    && typeof persistedFinalProgress.review_effect_id === "string"
  ) {
    const phaseCycle = reviewCycleStateSchema.parse(await readRunArtifact<unknown>(
      input.runDir,
      persistedFinalProgress.review_cycle_path,
    ));
    if (
      phaseCycle.work_item_id === finalItem.id
      && phaseCycle.effect_id === persistedFinalProgress.review_effect_id
      && isReviewEffectAction(phaseCycle.decision.action)
      && (phaseCycle.phase === "final_integrated" || phaseCycle.phase === "post_pr")
    ) {
      const owner = `runtime:${phaseCycle.phase}:${finalItem.id}`;
      let claimed: Awaited<ReturnType<typeof claimReviewEffect>>;
      try {
        claimed = await claimReviewEffect({ run_dir: input.runDir, cycle: phaseCycle, owner });
      } catch (error) {
        const recoverablePreInvocationClaim = error instanceof AmbiguousEffectError
          && manifest.stage === "fixing"
          && persistedFinalProgress.status === "blocked"
          && persistedFinalProgress.review_effect_id === phaseCycle.effect_id
          && typeof persistedFinalProgress.queue_path !== "string"
          && typeof persistedFinalProgress.implementation_path !== "string";
        if (!recoverablePreInvocationClaim) throw error;
        claimed = await recoverClaimedReviewEffectBeforeQueue({
          run_dir: input.runDir,
          cycle: phaseCycle,
          owner,
          queue_persisted: false,
        });
      }
      if (claimed.status === "acquired") {
        // The exact pre-invocation claim remains authoritative; normal final-phase
        // dispatch below resumes it without charging or fabricating completion.
        const sourceAttempt = phaseCycle.work_item_progress_reference?.attempts;
        if (!Number.isInteger(sourceAttempt) || sourceAttempt! < 1) {
          throw new Error(`Persisted ${phaseCycle.phase} fix effect is missing its source review attempt`);
        }
        claimedFinalFixSourceAttempt = sourceAttempt!;
        manifest = await setProgress(input.runDir, finalItem.id, {
          ...persistedFinalProgress,
          status: "in_progress",
          attempts: sourceAttempt!,
          blocker: undefined,
          blocker_code: undefined,
        });
        persistedFinalProgress = manifest.work_item_progress[finalItem.id];
      } else if (claimed.status !== "complete") {
        throw new Error(`Persisted ${phaseCycle.phase} fix effect ${phaseCycle.effect_id} is not complete`);
      } else {
        const result = claimed.cycle.effect_result as { attempt?: unknown; implementation_path?: unknown } | undefined;
        if (
          !result
          || !Number.isInteger(result.attempt)
          || typeof result.implementation_path !== "string"
          || result.implementation_path !== persistedFinalProgress.implementation_path
        ) throw new Error(`Completed ${phaseCycle.phase} fix effect has invalid immutable Hands proof`);
        await loadPersistedImplementation(input.runDir, persistedFinalProgress, finalItem);
        await incrementSuccessfulFix({
          run_dir: input.runDir,
          cycle: phaseCycle,
          owner,
          mutation_id: result.implementation_path,
          kind: "successful_fix",
          effect_action: phaseCycle.decision.action,
        });
        const afterCharge = await readManifestV2(input.runDir);
        manifest = await setProgress(input.runDir, finalItem.id, {
          ...afterCharge.work_item_progress[finalItem.id]!,
          review_cycle_path: undefined,
          review_effect_id: undefined,
        });
        persistedFinalProgress = manifest.work_item_progress[finalItem.id];
      }
    }
  }
  const persistedFinalEvidencePath = typeof persistedFinalProgress?.verification_path === "string"
    && persistedFinalProgress.verification_scope === finalIdentity.scope
    && persistedFinalProgress.verification_work_item_id === finalIdentity.work_item_id
    ? persistedFinalProgress.verification_path
    : undefined;
  const persistedFinalReviewPath = typeof persistedFinalProgress?.review_path === "string"
    ? persistedFinalProgress.review_path
    : undefined;
  const persistedFinalImplementationPath = typeof persistedFinalProgress?.implementation_path === "string"
    ? runArtifactRelativePath(input.runDir, persistedFinalProgress.implementation_path)
    : undefined;
  let finalPass = 0;
  let finalVerification: VerificationEvidence | undefined;
  let finalReview: VerifierReview | undefined;
  let finalReviewPath: string | undefined = persistedFinalReviewPath;
  let finalImplementation = aggregateImplementation(implementationResults, input.plan);
  let finalFixResult: HandsWorkItemResult | undefined;
  let finalCommitSha: string | undefined;
  if (typeof persistedFinalProgress?.commit_sha === "string" && persistedFinalProgress.commit_sha.length > 0) {
    finalCommitSha = persistedFinalProgress.commit_sha;
  }

  type PostPrLoopResult = {
    blocker?: string;
    postEvidencePath: string;
    pullRequest?: GitHubPullRequestReference;
    pendingReplanBoundary?: PreparedReplanApprovalCoordinates;
  };

  /** Continue the bounded Verifier/Hands loop against an already-open PR. */
  const runPostPrLoop = async (
    pullRequest: GitHubPullRequestReference,
    resume: boolean,
  ): Promise<PostPrLoopResult> => {
    let postEvidencePath = finalVerification?.evidence_path ?? verificationEvidencePath(finalIdentity, Math.max(1, finalPass));
    let postPass = finalPass;
    let reuseEvidence = false;
    let reuseReview = false;
    let pushPending = false;
    let postMutationPending = false;

    if (resume) {
      const current = await readManifestV2(input.runDir);
      let progress = current.work_item_progress[finalItem.id];
      pushPending = progress?.push_pending === true;
      if (progress?.push_commit_pending === true) {
        const localBefore = progress.push_local_before_sha;
        const remoteBefore = progress.push_remote_before_sha;
        const intendedParent = progress.push_commit_parent_sha;
        const intendedTree = progress.push_commit_tree_sha;
        const intendedMessage = progress.push_commit_message;
        const intendedCyclePath = progress.push_commit_review_cycle_path;
        const intendedEffectId = progress.push_commit_review_effect_id;
        const expectedMessage = `work-item: ${finalItem.id.trim()} ${finalItem.title.trim()}`;
        if (
          !isGitObjectId(localBefore)
          || !(isGitObjectId(remoteBefore) || remoteBefore === null)
          || !isGitObjectId(intendedParent)
          || intendedParent !== localBefore
          || !isGitObjectId(intendedTree)
          || intendedMessage !== expectedMessage
          || intendedCyclePath !== progress.review_cycle_path
          || intendedEffectId !== progress.review_effect_id
        ) {
          throw new Error("Post-PR commit reconciliation requires durable exact commit provenance");
        }
        const localSha = await (githubDelivery?.dependencies.localHeadSha ?? resolveLocalHeadSha)(input.worktreePath);
        if (localSha !== localBefore) {
          const committed = await (githubDelivery?.dependencies.localCommitProvenance ?? resolveLocalCommitProvenance)(
            input.worktreePath,
            localSha,
          );
          if (
            committed.sha !== localSha
            || committed.parent_shas.length !== 1
            || committed.parent_shas[0] !== intendedParent
            || committed.tree_sha !== intendedTree
            || committed.message !== intendedMessage
          ) throw new Error("Recovered post-PR commit provenance does not match the durable workflow intent");
          const snapshot = await gitSnapshot(input.worktreePath);
          if (snapshot.status.trim().length > 0) throw new Error("Recovered post-PR commit has a dirty worktree");
          finalCommitSha = localSha;
          pushPending = true;
          if (!githubDelivery) throw new Error("Post-PR head authorization requires GitHub dependencies");
          const boundedRecheck = current.workflow_protocol === "bounded-context-v1";
          manifest = await advancePostPrDeliveryHeadAuthority({
            github: githubDelivery,
            itemId: finalItem.id,
            previousHead: localBefore,
            authorizedHead: localSha,
            progress: {
              ...progress,
              commit_sha: localSha,
              push_commit_pending: false,
              push_pending: !boundedRecheck,
              push_expected_sha: localSha,
              push_remote_before_sha: remoteBefore,
            },
            artifactPaths: [],
          });
          if (boundedRecheck) await reserveCandidateRecheck("post_pr", progress.attempts, localSha);
          progress = (await readManifestV2(input.runDir)).work_item_progress[finalItem.id];
          pushPending = !boundedRecheck;
        }
      }
      if (
        current.workflow_protocol === "bounded-context-v1"
        && progress?.candidate_recheck === undefined
        && progress?.push_commit_pending === false
        && progress.push_pending === false
        && isGitObjectId(progress.commit_sha)
        && progress.push_expected_sha === progress.commit_sha
        && isGitObjectId(progress.push_remote_before_sha)
        && progress.push_remote_before_sha !== progress.commit_sha
        && progress.self_review_state !== "pending"
      ) {
        await reserveCandidateRecheck("post_pr", progress.attempts, progress.commit_sha);
        progress = (await readManifestV2(input.runDir)).work_item_progress[finalItem.id];
      }
      const targetAttempt = Math.max(1, progress?.attempts ?? finalPass + 1);
      const persistedFixesUsed = current.review_policy_snapshot !== undefined
        ? current.review_accounting?.fix_cycles_used ?? 0
        : progress?.terminal_hands_fix_attempts ?? 0;
      const persistedFixLimit = current.review_policy_snapshot !== undefined
        ? current.review_policy_snapshot.max_fix_cycles
        : maxHandsFixAttempts;
      if (persistedFixesUsed > persistedFixLimit) {
        const blocker = `Persisted post-PR Hands fix count ${persistedFixesUsed} exceeds the maximum of ${persistedFixLimit}`;
        manifest = await updateManifestV2(input.runDir, { delivery_state: "blocked", last_blocker: blocker });
        return { blocker, postEvidencePath };
      }
      postPass = targetAttempt - 1;
      reuseEvidence = progress?.candidate_recheck
        ? progress.candidate_recheck.state !== "reserved" && finalVerification?.attempt === targetAttempt
        : finalVerification?.attempt === targetAttempt;
      reuseReview = progress?.candidate_recheck
        ? progress.candidate_recheck.state === "reviewed" && finalReview?.attempt === targetAttempt
        : finalReview?.attempt === targetAttempt;

      const implementationPath = typeof progress?.implementation_path === "string"
        ? runArtifactRelativePath(input.runDir, progress.implementation_path)
        : undefined;
      const implementationAttempt = implementationPath?.match(/(?:^|\/)attempt-(\d+)\.json$/)?.[1];
      const reviewAttempt = finalReview?.attempt ?? 0;
      if (implementationPath && implementationAttempt && Number(implementationAttempt) === targetAttempt && targetAttempt > reviewAttempt) {
        try {
          const persistedFix = await loadPersistedImplementation(input.runDir, progress, finalItem);
          finalImplementation = mergeImplementationResults(finalImplementation, persistedFix);
          postMutationPending = true;
        } catch (error) {
          const blocker = `Persisted post-PR Hands report could not be resumed: ${errorMessage(error)}`;
          manifest = await recordRuntimeBlocker(input.runDir, blocker, finalItem.id, targetAttempt);
          return { blocker, postEvidencePath };
        }
      }
    }

    while (true) {
      const reviewPass = postPass + 1;
      if (!reuseEvidence) {
        if (manifest.stage !== "final_verification") {
          manifest = await transitionRun(input.runDir, "final_verification", {
            actor: "runtime",
            payload: { work_item_id: finalItem.id, pass: reviewPass, final: true, integrated_pr: pullRequest.number },
          });
          await publishRuntimeStatusCheckpoint(input, orderedWorkItems);
          await input.dependencies?.afterCheckpoint?.("after_status_verifying_publication");
        }
        if (postMutationPending) {
          try {
            const gateResult = await runMutationQualityGate({
              workItem: finalItem,
              parentAttempt: reviewPass,
              mutationKind: expectedTerminalMutationKind(),
              activeAction: null,
              completedActions: [],
              implementation: finalImplementation,
              phase: "post_pr",
            });
            finalImplementation = gateResult.implementation;
            finalVerification = gateResult.finalVerification;
            postEvidencePath = finalVerification.evidence_path;
            postMutationPending = false;
          } catch (error) {
            if (!(error instanceof HandsSelfReviewQualityGateError)) throw error;
            const blocker = `Hands self-review quality gate failed during post-PR attempt ${reviewPass}: ${errorMessage(error)}`;
            manifest = await recordRuntimeBlocker(input.runDir, blocker, finalItem.id, reviewPass);
            return { blocker, postEvidencePath };
          }
        } else {
          let postRawEvidence: VerificationEvidence;
          const postVerificationRecoveryOperation: RetryableRuntimeOperation = {
            workItemId: finalItem.id,
            scopeId: "integrated:post-pr",
            operation: "verification-infrastructure",
            attempt: reviewPass,
            classification: {
              failure_class: "test_infrastructure_blocker",
              blocker_code: "verification_infrastructure_failed",
            },
          };
          const postVerificationRecoveryContext = await gateRetryableRuntimeOperation(
            postVerificationRecoveryOperation,
          );
          if (postVerificationRecoveryContext.gate.mode === "blocked") {
            const blocker = postVerificationRecoveryContext.gate.guard_action === "diagnostic_stop"
              ? "Recovery diagnostic stop after repeated post-PR verification-infrastructure"
              : "Recovery exhausted after post-PR verification-infrastructure";
            manifest = await updateManifestV2(input.runDir, { delivery_state: "blocked", last_blocker: blocker });
            return { blocker, postEvidencePath };
          }
          try {
            postRawEvidence = await verificationRunner({
              repoRoot: input.worktreePath,
              runDir: input.runDir,
              identity: finalIdentity,
               mode: "github",
               commands: finalItem.verification_commands.map((command) => command.argv),
               commandIds: finalItem.verification_commands.map((command) => command.id),
               phase: "post_pr",
               stopOnFailure: true,
               budget,
               expectedArtifacts: integratedExpectedArtifacts,
              browserChecks: integratedBrowserChecks,
              attempt: reviewPass,
              progress: input.progress,
              progressContext: { workItem: { index: orderedWorkItems.length + 1, total: orderedWorkItems.length + 1, attempt: reviewPass, final: true } },
            });
          } catch (error) {
            const blocker = `Post-PR verification infrastructure failed: ${errorMessage(error)}`;
            const recovered = await recordRetryableRuntimeBlocker({
              ...postVerificationRecoveryOperation,
              blocker,
              error,
              recoveryContext: postVerificationRecoveryContext,
            });
            manifest = recovered.manifest;
            return { blocker: recovered.blocker, postEvidencePath };
          }
          finalVerification = validateEvidenceForIdentity(postRawEvidence, finalIdentity, reviewPass);
          postEvidencePath = await persistVerificationEvidence(input.runDir, finalVerification, finalIdentity, reviewPass);
          await recordAuthorizedRuntimeSuccess(
            postVerificationRecoveryOperation,
            postVerificationRecoveryContext,
            { verification_path: postEvidencePath },
          );
          const currentProgress = (await readManifestV2(input.runDir)).work_item_progress.integrated;
          const candidateRecheck = currentProgress?.candidate_recheck?.attempt === reviewPass
            ? currentProgress.candidate_recheck
            : undefined;
          manifest = await setProgress(input.runDir, finalItem.id, {
            status: "in_progress",
            attempts: reviewPass,
            verification_path: postEvidencePath,
            ...verificationProgressIdentity(finalIdentity),
            delivery_phase: "post_pr",
            integrated_pr: pullRequest.number,
            ...(candidateRecheck ? {
              candidate_recheck: {
                ...candidateRecheck,
                state: "verified",
                verification_path: postEvidencePath,
              },
            } : {}),
          }, [postEvidencePath]);
        }
      } else {
        if (manifest.stage !== "final_verification" && manifest.stage !== "verifier_review") {
          manifest = await transitionRun(input.runDir, "final_verification", {
            actor: "runtime",
            payload: { work_item_id: finalItem.id, pass: reviewPass, final: true, integrated_pr: pullRequest.number },
          });
        }
        reuseEvidence = false;
        postEvidencePath = finalVerification?.evidence_path ?? postEvidencePath;
      }

      if (!finalVerification) throw new Error("Post-PR verification evidence is required before review");
      const postFailures = verificationFailureReasons(finalVerification, integratedBrowserChecks);
      if (postFailures.length > 0 && (await readManifestV2(input.runDir)).review_policy_snapshot === undefined) {
        const blocker = `Integrated post-PR verification failed: ${postFailures.join("; ")}`;
        manifest = await updateManifestV2(input.runDir, { delivery_state: "blocked", last_blocker: blocker });
        return { blocker, postEvidencePath };
      }
      manifest = await updateManifestV2(input.runDir, {
        final_artifact_paths: [...new Set([...manifest.final_artifact_paths, postEvidencePath])],
      });

      if (!reuseReview) {
        try {
          await gateTerminalVerifier("post_pr", reviewPass, postEvidencePath);
        } catch (error) {
          const blocker = `Post-PR evidence index validation failed: ${errorMessage(error)}`;
          manifest = await recordRuntimeBlocker(input.runDir, blocker, finalItem.id, reviewPass);
          return { blocker, postEvidencePath };
        }
        if (manifest.stage !== "verifier_review") {
          manifest = await transitionRun(input.runDir, "verifier_review", {
            actor: "runtime",
            payload: { work_item_id: finalItem.id, pass: reviewPass, final: true, integrated_pr: pullRequest.number },
          });
        }
        let postReviewResult: VerifyWorkItemResult;
        const postVerifierRecoveryOperation: RetryableRuntimeOperation = {
          workItemId: finalItem.id,
          scopeId: "integrated:post-pr",
          operation: "verifier-invocation",
          attempt: reviewPass,
          classification: { failure_class: "invocation_failure", blocker_code: "verifier_invocation_failed" },
        };
        const postVerifierRecoveryContext = await gateRetryableRuntimeOperation(
          postVerifierRecoveryOperation,
        );
        if (postVerifierRecoveryContext.gate.mode === "blocked") {
          const blocker = postVerifierRecoveryContext.gate.guard_action === "diagnostic_stop"
            ? "Recovery diagnostic stop after repeated post-PR verifier-invocation"
            : "Recovery exhausted after post-PR verifier-invocation";
          manifest = await updateManifestV2(input.runDir, { delivery_state: "blocked", last_blocker: blocker });
          return { blocker, postEvidencePath };
        }
        const boundedContext = await boundedVerifierInvocationContext(
          finalItem,
          "post_pr",
          reviewPass,
        );
        const verifierInput: VerifyWorkItemInput = boundedContext ? {
          runDir: input.runDir,
          worktreePath: input.worktreePath,
          workItem: finalItem,
          ...boundedContext,
          intake: input.intake,
          codex: input.codex,
          attempt: reviewPass,
          progress: input.progress,
          workItemIndex: orderedWorkItems.length + 1,
          workItemTotal: orderedWorkItems.length + 1,
          budget,
        } : {
          runDir: input.runDir, worktreePath: input.worktreePath, workItem: finalItem,
          implementation: finalImplementation, verification: finalVerification,
          priorVerification: Object.values(evidenceByItem), final: true,
          intake: input.intake, codex: input.codex, attempt: reviewPass, progress: input.progress, budget,
          workItemIndex: orderedWorkItems.length + 1, workItemTotal: orderedWorkItems.length + 1,
        };
        try {
          postReviewResult = await verifier(verifierInput);
        } catch (error) {
          const blocker = `Post-PR Verifier invocation failed: ${errorMessage(error)}`;
          const recovered = await recordRetryableRuntimeBlocker({
            ...postVerifierRecoveryOperation,
            blocker,
            error,
            recoveryContext: postVerifierRecoveryContext,
          });
          manifest = recovered.manifest;
          return { blocker: recovered.blocker, postEvidencePath };
        }
        finalReview = postReviewResult.review;
        finalReviewPath = controllerArtifactRelativePath(input.runDir, postReviewResult.reviewPath);
        await recordAuthorizedRuntimeSuccess(
          postVerifierRecoveryOperation,
          postVerifierRecoveryContext,
          { review_path: finalReviewPath },
        );
        const currentProgress = (await readManifestV2(input.runDir)).work_item_progress.integrated;
        const candidateRecheck = currentProgress?.candidate_recheck?.attempt === reviewPass
          ? currentProgress.candidate_recheck
          : undefined;
        manifest = await setProgress(input.runDir, finalItem.id, {
          status: "in_progress",
          attempts: reviewPass,
          verification_path: postEvidencePath,
          ...verificationProgressIdentity(finalIdentity),
          review_path: finalReviewPath,
          delivery_phase: "post_pr",
          integrated_pr: pullRequest.number,
          ...(candidateRecheck ? {
            candidate_recheck: {
              ...candidateRecheck,
              state: "reviewed",
              verification_path: postEvidencePath,
              index_path: verifierEvidenceIndexPath("post_pr", reviewPass),
              review_path: finalReviewPath,
            },
          } : {}),
        }, [finalReviewPath]);
      } else {
        if (manifest.stage !== "verifier_review") {
          manifest = await transitionRun(input.runDir, "verifier_review", {
            actor: "runtime",
            payload: { work_item_id: finalItem.id, pass: reviewPass, final: true, integrated_pr: pullRequest.number },
          });
        }
        reuseReview = false;
      }
      finalPass = reviewPass;
      if (!finalReview || !finalReviewPath) throw new Error("Post-PR Verifier review is required before delivery");
      manifest = await updateManifestV2(input.runDir, {
        final_artifact_paths: [...new Set([...manifest.final_artifact_paths, finalReviewPath])],
      });

      const postPolicy = (await readManifestV2(input.runDir)).review_policy_snapshot
        ? await beginPolicyPhaseReview({
            phase: "post_pr",
            workItem: finalItem,
            review: finalReview,
            reviewPath: finalReviewPath,
            verification: finalVerification,
            verificationPath: postEvidencePath,
            attempt: reviewPass,
          })
        : null;
      const postPolicyClaim = postPolicy
        ? await claimPhaseReviewEffect(postPolicy)
        : null;
      const postRecoveryGate = postPolicy
        && isReviewEffectAction(postPolicy.cycle.decision.action)
        && postPolicyClaim?.status === "acquired"
        ? await gateIntegratedPolicyEffect({
            policy: postPolicy,
            scopeId: "integrated:post-pr",
            operation: "post-pr-fix",
            verificationPath: postEvidencePath,
            reviewPath: finalReviewPath,
          })
        : null;
      if (postRecoveryGate && postRecoveryGate.guard_action !== "allow_next_effect") {
        const blocker = postRecoveryGate.guard_action === "diagnostic_stop"
          ? "Recovery diagnostic stop for post-PR review"
          : postRecoveryGate.guard_action === "exhausted_stop"
            ? "Recovery exhausted for post-PR review"
            : "Recovery awaits an external fix for post-PR review";
        manifest = await updateManifestV2(input.runDir, { delivery_state: "blocked", last_blocker: blocker });
        return { blocker, postEvidencePath };
      }
      const postAdvances = postPolicy
        ? postPolicy.cycle.decision.action === "advance" || postPolicy.cycle.decision.action === "continue_with_warning"
        : finalReview.decision === "approve";
      const reviewedCandidateCommit = postAdvances
        ? await validateTerminalVerifierAfterReview("post_pr", reviewPass, finalReviewPath)
        : null;

      if (postAdvances) {
        if (postPolicyClaim?.status === "blocked") throw new Error(`Post-PR advance effect ${postPolicy!.cycle.effect_id} is blocked`);
        try {
          await assertCurrentImplementationScope(finalItem, finalImplementation);
        } catch (error) {
          const blocker = `Integrated implementation scope check failed: ${errorMessage(error)}`;
          manifest = await updateManifestV2(input.runDir, { delivery_state: "blocked", last_blocker: blocker });
          return { blocker, postEvidencePath };
        }
        if (postPolicy && postPolicyClaim?.status === "acquired") {
          await completeReviewEffect({
            run_dir: input.runDir,
            cycle: postPolicy.cycle,
            owner: postPolicy.owner,
            outcome: "complete",
            result: { commit_sha: "policy-authorized" },
          });
        }
        if (postPolicy) {
          await requireCompletedAdvanceEffect({ run_dir: input.runDir, cycle: postPolicy.cycle, owner: postPolicy.owner });
        }
        let candidateRecheckReserved = false;
        if (!postPolicy || postPolicyClaim?.status === "acquired" || postPolicyClaim?.status === "complete") {
          const postSnapshot = await gitSnapshot(input.worktreePath);
          if (postSnapshot.status.trim().length > 0) {
            const beforeProgress = (await readManifestV2(input.runDir)).work_item_progress[finalItem.id];
            if (!githubDelivery) throw new Error("Post-PR delivery requires GitHub dependencies");
            const resumedCommitIntent = beforeProgress?.push_commit_pending === true;
            const unpushedCandidateParent = beforeProgress?.push_pending === false
              && isGitObjectId(beforeProgress.push_remote_before_sha)
              && beforeProgress.push_expected_sha === beforeProgress.commit_sha
              && beforeProgress.commit_sha === await (githubDelivery.dependencies.localHeadSha ?? resolveLocalHeadSha)(input.worktreePath);
            const remoteBefore = resumedCommitIntent
              ? beforeProgress.push_remote_before_sha
              : unpushedCandidateParent
                ? await (githubDelivery.dependencies.remoteBranchSha ?? resolveRemoteBranchSha)(
                    input.worktreePath,
                    githubDelivery.branchName,
                    githubDelivery.remote ?? "origin",
                  )
              : await (githubDelivery.dependencies.remoteBranchAtLocalHead ?? requireRemoteBranchAtLocalHead)(
                  input.worktreePath,
                  githubDelivery.branchName,
                  githubDelivery.remote ?? "origin",
                );
            const commitIntent = resumedCommitIntent
              ? {
                  parent_sha: beforeProgress.push_commit_parent_sha,
                  tree_sha: beforeProgress.push_commit_tree_sha,
                  message: beforeProgress.push_commit_message,
                }
              : await (githubDelivery.dependencies.prepareCommitIntent ?? prepareWorkItemCommitIntent)(
                  input.worktreePath,
                  finalItem.id,
                  finalItem.title,
                );
            const localBefore = commitIntent?.parent_sha;
            const expectedMessage = `work-item: ${finalItem.id.trim()} ${finalItem.title.trim()}`;
            if (
              !isGitObjectId(localBefore)
              || !(isGitObjectId(remoteBefore) || remoteBefore === null)
              || (unpushedCandidateParent
                ? remoteBefore !== beforeProgress.push_remote_before_sha
                : remoteBefore !== localBefore)
              || !isGitObjectId(commitIntent?.tree_sha)
              || commitIntent.message !== expectedMessage
              || (postPolicy && resumedCommitIntent && beforeProgress.push_commit_review_cycle_path !== postPolicy.cycle.decision_path)
              || (postPolicy && resumedCommitIntent && beforeProgress.push_commit_review_effect_id !== postPolicy.cycle.effect_id)
            ) {
              throw new Error("Post-PR commit intent requires exact parent, tree, message, and remote provenance");
            }
            if (typeof localBefore !== "string") {
              throw new Error("Post-PR commit intent requires a string parent SHA");
            }
            const currentHead = await (githubDelivery.dependencies.localHeadSha ?? resolveLocalHeadSha)(input.worktreePath);
            if (currentHead !== localBefore) throw new Error("Post-PR commit intent raced with a local branch advance");
            manifest = await setProgress(input.runDir, finalItem.id, {
              ...beforeProgress!,
              push_commit_pending: true,
              push_local_before_sha: localBefore,
              push_remote_before_sha: remoteBefore,
              push_commit_parent_sha: localBefore,
              push_commit_tree_sha: commitIntent.tree_sha,
              push_commit_message: commitIntent.message,
              ...(postPolicy ? {
                push_commit_review_cycle_path: postPolicy.cycle.decision_path,
                push_commit_review_effect_id: postPolicy.cycle.effect_id,
              } : {}),
            });
            if (!resumedCommitIntent) await input.dependencies?.afterCheckpoint?.("after_post_pr_commit_intent");
            finalCommitSha = await commit({
              worktreePath: input.worktreePath,
              workItemId: finalItem.id,
              title: finalItem.title,
              verifierApproved: !postPolicy,
              ...(postPolicy ? { policyProof: { runDir: input.runDir, cycle: postPolicy.cycle, owner: postPolicy.owner } } : {}),
            });
            await input.progress?.emit({ code: "changes_committed", source: "runtime" });
            await input.dependencies?.afterCheckpoint?.("after_post_pr_commit");
            const committedHead = await (githubDelivery.dependencies.localHeadSha ?? resolveLocalHeadSha)(input.worktreePath);
            const committed = await (githubDelivery.dependencies.localCommitProvenance ?? resolveLocalCommitProvenance)(
              input.worktreePath,
              finalCommitSha,
            );
            if (
              committedHead !== finalCommitSha
              || committed.sha !== finalCommitSha
              || committed.parent_shas.length !== 1
              || committed.parent_shas[0] !== localBefore
              || committed.tree_sha !== commitIntent.tree_sha
              || committed.message !== commitIntent.message
            ) throw new Error("Post-PR commit provenance does not match the durable workflow intent");
            const afterPostCommit = await gitSnapshot(input.worktreePath);
            if (afterPostCommit.status.trim().length > 0) throw new Error("Worktree remains dirty after approved post-PR fix commit");
            pushPending = true;
            const committedProgress = {
              status: "in_progress",
              attempts: reviewPass,
              verification_path: postEvidencePath,
              ...verificationProgressIdentity(finalIdentity),
              review_path: finalReviewPath,
              delivery_phase: "post_pr",
              integrated_pr: pullRequest.number,
              commit_sha: finalCommitSha,
              push_pending: reviewedCandidateCommit === null,
              push_commit_pending: false,
              push_expected_sha: finalCommitSha,
              push_remote_before_sha: remoteBefore,
              push_local_before_sha: localBefore,
              push_commit_parent_sha: localBefore,
              push_commit_tree_sha: commitIntent.tree_sha,
              push_commit_message: commitIntent.message,
              ...(postPolicy ? {
                push_commit_review_cycle_path: postPolicy.cycle.decision_path,
                push_commit_review_effect_id: postPolicy.cycle.effect_id,
              } : {}),
            } satisfies RunManifestV2["work_item_progress"][string];
            manifest = await advancePostPrDeliveryHeadAuthority({
              github: githubDelivery,
              itemId: finalItem.id,
              previousHead: localBefore,
              authorizedHead: finalCommitSha,
              progress: committedProgress,
              artifactPaths: [postEvidencePath, finalReviewPath],
            });
            await input.dependencies?.afterCheckpoint?.("after_post_pr_head_authority");
            if (reviewedCandidateCommit !== null) {
              await reserveCandidateRecheck("post_pr", reviewPass, finalCommitSha);
              candidateRecheckReserved = true;
              pushPending = false;
            } else {
              pushPending = true;
            }
          } else if (reviewedCandidateCommit !== null) {
            const currentHead = await (githubDelivery?.dependencies.localHeadSha ?? resolveLocalHeadSha)(input.worktreePath);
            if (currentHead !== reviewedCandidateCommit) {
              finalCommitSha = currentHead;
              await reserveCandidateRecheck("post_pr", reviewPass, currentHead);
              candidateRecheckReserved = true;
              pushPending = false;
            } else {
              const currentProgress = (await readManifestV2(input.runDir)).work_item_progress.integrated;
              if (currentProgress?.candidate_recheck?.state === "reviewed") {
                manifest = await setProgress(input.runDir, finalItem.id, {
                  ...currentProgress,
                  push_pending: true,
                });
                pushPending = true;
              }
            }
          }
          if (candidateRecheckReserved) {
            postPass = reviewPass;
            reuseEvidence = false;
            reuseReview = false;
            continue;
          }
          if (pushPending) {
            if (!githubDelivery) throw new Error("Post-PR delivery requires GitHub dependencies");
            const currentProgress = (await readManifestV2(input.runDir)).work_item_progress[finalItem.id];
            const expected = currentProgress?.push_expected_sha;
            const before = currentProgress?.push_remote_before_sha;
            const parent = currentProgress?.push_commit_parent_sha;
            const tree = currentProgress?.push_commit_tree_sha;
            const message = currentProgress?.push_commit_message;
            const cyclePath = currentProgress?.push_commit_review_cycle_path;
            const effectId = currentProgress?.push_commit_review_effect_id;
            const commitCycle = typeof cyclePath === "string"
              ? reviewCycleStateSchema.parse(await readRunArtifact<unknown>(input.runDir, cyclePath))
              : null;
            const completedCommitEffect = commitCycle
              ? await loadCompletedReviewEffect({
                  run_dir: input.runDir,
                  cycle: commitCycle,
                  owner: `runtime:post_pr:${finalItem.id}`,
                })
              : null;
            const invalidPushProvenance = [
              !isGitObjectId(expected) ? "expected_sha" : null,
              !isGitObjectId(before) ? "remote_before_sha" : null,
              !isGitObjectId(parent) ? "parent_sha" : null,
              !isGitObjectId(tree) ? "tree_sha" : null,
              message !== `work-item: ${finalItem.id.trim()} ${finalItem.title.trim()}` ? "message" : null,
              ((cyclePath === undefined) !== (effectId === undefined)) ? "review_reference_pair" : null,
              commitCycle !== null && commitCycle.effect_id !== effectId ? "review_effect" : null,
              commitCycle !== null && completedCommitEffect?.effect_state !== "complete" ? "review_effect_state" : null,
            ].filter((value): value is string => value !== null);
            if (invalidPushProvenance.length > 0) {
              throw new Error(`Post-PR push reconciliation requires durable exact commit and remote provenance: ${invalidPushProvenance.join(", ")}`);
            }
            const expectedSha = expected as string;
            const remoteBeforeSha = before as string;
            const parentSha = parent as string;
            const currentHead = await (githubDelivery.dependencies.localHeadSha ?? resolveLocalHeadSha)(input.worktreePath);
            const committed = await (githubDelivery.dependencies.localCommitProvenance ?? resolveLocalCommitProvenance)(
              input.worktreePath,
              expectedSha,
            );
            if (
              currentHead !== expectedSha
              || committed.sha !== expectedSha
              || committed.parent_shas.length !== 1
              || committed.parent_shas[0] !== parentSha
              || committed.tree_sha !== tree
              || committed.message !== message
            ) throw new Error("Post-PR push commit provenance no longer matches the durable workflow intent");
            const remoteSha = githubDelivery.dependencies.remoteBranchSha ?? resolveRemoteBranchSha;
            const currentRemote = await remoteSha(input.worktreePath, githubDelivery.branchName, githubDelivery.remote ?? "origin");
            const pushManifest = await readManifestV2(input.runDir);
            if (pushManifest.task_lineage_id === null) throw new Error("Post-PR push requires a task lineage");
            const pushLineage = await withTaskLineageTransaction({
              repoRoot: githubDelivery.repoRoot,
              lineageId: pushManifest.task_lineage_id,
              operation: (transaction) => transaction.read(),
            });
            const expectedTransition = {
              run_id: pushManifest.run_id,
              work_item_id: finalItem.id,
              previous_head_sha: parentSha,
              authorized_head_sha: expectedSha,
            };
            const transitionIsPending = isDeepStrictEqual(pushLineage.delivery.head_transition, expectedTransition);
            if (currentRemote !== expectedSha) {
              if (!transitionIsPending) throw new Error("Post-PR push transition authority has already been consumed or changed");
              if (currentRemote !== remoteBeforeSha) throw new Error("Post-PR remote branch changed outside the durable push boundary");
              const pushCommit = githubDelivery.dependencies.pushCommit ?? pushCommitToBranch;
              const pushClaim = await claimExternalEffect(
                budget,
                `git-push:${githubDelivery.remote ?? "origin"}:${githubDelivery.branchName}:${expectedSha}`,
              );
              try {
                await pushCommit(
                  input.worktreePath,
                  expectedSha,
                  githubDelivery.branchName,
                  remoteBeforeSha,
                  githubDelivery.remote ?? "origin",
                );
              } catch (error) {
                const afterError = await remoteSha(input.worktreePath, githubDelivery.branchName, githubDelivery.remote ?? "origin");
                if (afterError !== expectedSha) {
                  await completeExternalEffect(budget, pushClaim, "failed");
                  throw new Error(`Post-PR atomic remote lease rejected without delivery confirmation: ${errorMessage(error)}`);
                }
              }
              const confirmed = await remoteSha(input.worktreePath, githubDelivery.branchName, githubDelivery.remote ?? "origin");
              if (confirmed !== expectedSha) throw new Error("Post-PR push read-back does not match the expected local commit");
              await completeExternalEffect(budget, pushClaim);
              await input.dependencies?.afterCheckpoint?.("after_post_pr_push");
            }
            pullRequest = await openOrRecoverIntegratedPullRequest(
              githubDelivery,
              orderedWorkItems,
              mappedIssueNumbers(pushManifest, orderedWorkItems),
              pullRequest.number,
              pullRequest.url,
              pushLineage.issue_set.parent_issue_number ?? undefined,
            );
            manifest = await consumePostPrDeliveryHeadAuthority({
              github: githubDelivery,
              itemId: finalItem.id,
              previousHead: parentSha,
              remoteBefore: remoteBeforeSha,
              authorizedHead: expectedSha,
            });
            await input.dependencies?.afterCheckpoint?.("after_post_pr_head_consumption");
            await input.progress?.emit({ code: "branch_pushed", source: "github" });
            pushPending = false;
          }
        }
        const deliveredCommitSha = finalCommitSha
          ?? await (githubDelivery?.dependencies.localHeadSha ?? input.dependencies?.localHeadSha ?? resolveLocalHeadSha)(input.worktreePath);
        manifest = await setProgress(input.runDir, finalItem.id, {
          status: "complete",
          attempts: reviewPass,
          verification_path: postEvidencePath,
          ...verificationProgressIdentity(finalIdentity),
          review_path: finalReviewPath,
          delivery_phase: "post_pr",
          integrated_pr: pullRequest.number,
          commit_sha: deliveredCommitSha,
          push_pending: false,
          candidate_recheck: undefined,
        }, [postEvidencePath, finalReviewPath]);
        return { postEvidencePath, pullRequest };
      }

      if (postPolicy && !isReviewEffectAction(postPolicy.cycle.decision.action)) {
        if (postPolicy.cycle.decision.action === "create_replan") {
          const preparedReplan = await createPhaseReplan(postPolicy, postPolicyClaim!, reviewPass);
          return { ...preparedReplan, postEvidencePath };
        }
        const blocker = `Post-PR review policy stopped: ${postPolicy.cycle.decision.reason_code}`;
        if (postPolicyClaim?.status === "acquired") {
          await completeReviewEffect({
            run_dir: input.runDir,
            cycle: postPolicy.cycle,
            owner: postPolicy.owner,
            outcome: "blocked",
            result: { blocker },
          });
        }
        manifest = await updateManifestV2(input.runDir, { delivery_state: "blocked", last_blocker: blocker });
        return { blocker, postEvidencePath };
      }

      const postFixesUsed = (await readManifestV2(input.runDir)).work_item_progress[finalItem.id]?.terminal_hands_fix_attempts ?? 0;
      if (!postPolicy && (reviewNeedsReplan(finalReview) || postFixesUsed >= maxHandsFixAttempts)) {
        const blocker = reviewNeedsReplan(finalReview)
          ? "Integrated PR Verifier requires replanning after PR creation"
          : terminalFixLimitBlocker("Integrated PR Verifier", postFixesUsed);
        manifest = await updateManifestV2(input.runDir, { delivery_state: "blocked", last_blocker: blocker });
        return { blocker, postEvidencePath };
      }

      if (manifest.stage !== "fixing") {
        manifest = await transitionRun(input.runDir, "fixing", {
          actor: "runtime",
          payload: { work_item_id: finalItem.id, pass: reviewPass, final: true, integrated_pr: pullRequest.number, findings: finalReview.findings },
        });
        await publishRuntimeStatusCheckpoint(input, orderedWorkItems);
        await input.dependencies?.afterCheckpoint?.("after_status_fixing_publication");
      }
      try {
        const postCriteria = postPolicy ? integratedPolicyCriteria(approvedCriteria)! : null;
        finalFixResult = await invokeHands(
          finalItem,
          reviewPass + 1,
          postPolicy?.cycle.decision.action === "quality_recovery" ? "quality_recovery" : "primary_fix",
          postPolicy
            ? postPolicy.findings.map((finding) => engineFindingToVerifierFinding(finding, postCriteria!, finalItem.verification_commands))
            : finalReview.findings,
        );
      } catch (error) {
        if (error instanceof NonRetryableHandsResultError) {
          const blocker = `Hands result failed validation during post-PR fix: ${errorMessage(error)}`;
          manifest = await recordRuntimeBlocker(input.runDir, blocker, finalItem.id, reviewPass + 1);
          return { blocker, postEvidencePath };
        }
        if (postPolicy && postRecoveryGate?.mode === "authorized_attempt") {
          const progress = await buildRecoveryProgressSubject({
            runDir: input.runDir,
            manifest: await readManifestV2(input.runDir),
            workItemId: "integrated",
            findingIds: postPolicy.cycle.decision.finding_ids,
            verificationPath: postEvidencePath,
            reviewPath: finalReviewPath,
            reviewRevision: postPolicy.cycle.review_revision,
          });
          await recordAuthorizedRecoveryOutcome({
            runDir: input.runDir,
            scopeId: "integrated:post-pr",
            operation: "post-pr-fix",
            authorizationId: postRecoveryGate.authorization_id,
            effectAttemptId: postRecoveryGate.effect_attempt_id,
            outcome: {
              kind: "failure",
              decision: postPolicy.cycle.decision,
              classification: { failure_class: "implementation_failure", blocker_code: postPolicy.cycle.decision.reason_code },
              error,
            },
            progress,
            ownedEvidenceRefs: { verification_path: postEvidencePath, review_path: finalReviewPath },
          });
        }
        const blocker = `Hands invocation failed during post-PR fix: ${errorMessage(error)}`;
        if (postRecoveryGate?.mode === "authorized_attempt") {
          manifest = await recordRuntimeBlocker(input.runDir, blocker, finalItem.id, reviewPass + 1);
          return { blocker, postEvidencePath };
        }
        const recovered = await recordRetryableRuntimeBlocker({
          workItemId: finalItem.id,
          scopeId: "integrated:post-pr",
          operation: "hands-invocation",
          attempt: reviewPass + 1,
          blocker,
          classification: { failure_class: "invocation_failure", blocker_code: "hands_invocation_failed" },
          error,
          findingIds: postPolicy?.cycle.decision.finding_ids,
          requestedEffect: postPolicy && isReviewEffectAction(postPolicy.cycle.decision.action)
            ? postPolicy.cycle.decision.action
            : undefined,
          requestedEffectReason: postPolicy?.cycle.decision.reason_code,
        });
        manifest = recovered.manifest;
        return { blocker: recovered.blocker, postEvidencePath };
      }
      finalImplementation = mergeImplementationResults(finalImplementation, finalFixResult.implementation);
      postMutationPending = true;
      const beforePostFixProgress = (await readManifestV2(input.runDir)).work_item_progress[finalItem.id];
      const fixedCandidateRecheck = beforePostFixProgress?.candidate_recheck?.state === "reviewed";
      manifest = await setProgress(input.runDir, finalItem.id, {
        status: "in_progress",
        attempts: reviewPass + 1,
        implementation_path: finalFixResult.reportPath,
        verification_path: undefined,
        verification_scope: undefined,
        verification_work_item_id: undefined,
        verification_issue_number: undefined,
        review_path: finalReviewPath,
        delivery_phase: "post_pr",
        integrated_pr: pullRequest.number,
        mutation_kind: expectedTerminalMutationKind(),
        self_review_pass: 0,
        self_review_state: "pending",
        mutation_verification_path: undefined,
        self_review_paths: undefined,
        self_review_verification_paths: undefined,
        candidate_recheck: undefined,
        terminal_hands_fix_attempts: (beforePostFixProgress?.terminal_hands_fix_attempts ?? 0) + 1,
      }, [finalFixResult.reportPath]);
      if (postPolicy && postRecoveryGate?.mode === "authorized_attempt") {
        const progress = await buildRecoveryProgressSubject({
          runDir: input.runDir,
          manifest,
          workItemId: "integrated",
          findingIds: postPolicy.cycle.decision.finding_ids,
          implementationPath: finalFixResult.reportPath,
          verificationPath: postEvidencePath,
          reviewPath: finalReviewPath,
          reviewRevision: postPolicy.cycle.review_revision,
        });
        await recordAuthorizedRecoveryOutcome({
          runDir: input.runDir,
          scopeId: "integrated:post-pr",
          operation: "post-pr-fix",
          authorizationId: postRecoveryGate.authorization_id,
          effectAttemptId: postRecoveryGate.effect_attempt_id,
          outcome: { kind: "success", decision: postPolicy.cycle.decision },
          progress,
          ownedEvidenceRefs: {
            implementation_path: finalFixResult.reportPath,
            verification_path: postEvidencePath,
            review_path: finalReviewPath,
          },
        });
      }
      if (postPolicy) {
        const effectAction = postPolicy.cycle.decision.action;
        if (!isReviewEffectAction(effectAction)) throw new Error("Post-PR fix effect action changed after dispatch");
        if (postPolicyClaim?.status === "blocked") throw new Error(`Post-PR fix effect ${postPolicy.cycle.effect_id} is blocked`);
        if (postPolicyClaim?.status === "acquired") {
          await completeReviewEffect({
            run_dir: input.runDir,
            cycle: postPolicy.cycle,
            owner: postPolicy.owner,
            outcome: "complete",
            result: { attempt: reviewPass + 1, implementation_path: finalFixResult.reportPath },
          });
          await input.dependencies?.afterCheckpoint?.("after_post_pr_effect_complete");
        }
        await incrementSuccessfulFix({
          run_dir: input.runDir,
          cycle: postPolicy.cycle,
          owner: postPolicy.owner,
          mutation_id: finalFixResult.reportPath,
          kind: "successful_fix",
          effect_action: effectAction,
        });
        const afterFix = await readManifestV2(input.runDir);
        manifest = await setProgress(input.runDir, finalItem.id, {
          ...afterFix.work_item_progress[finalItem.id]!,
          review_cycle_path: undefined,
          review_effect_id: undefined,
        });
      }
      if (fixedCandidateRecheck) {
        await input.dependencies?.afterCheckpoint?.("after_candidate_recheck_hands_report");
      }
      postPass = reviewPass;
    }
  };

  // Final-stage artifacts are persisted before every external boundary. On
  // resume, consume the exact evidence/review/fix already recorded instead of
  // invoking the same role a second time.
  if (persistedFinalEvidencePath) {
    try {
      const persistedFinalAttempt = claimedFinalFixSourceAttempt
        ?? Math.max(1, persistedFinalProgress?.attempts ?? 1);
      const validatedGate = qualityGatePolicy && persistedFinalImplementationPath && !persistedFinalProgress?.candidate_recheck
        ? await validatePersistedMutationQualityGate({
            workItem: finalItem,
            parentAttempt: persistedFinalAttempt,
            expectedMutationKind: expectedTerminalMutationKind(),
            activeAction: null,
          })
        : undefined;
      finalVerification = validatedGate && persistedFinalProgress.verification_path !== verificationEvidencePath(finalIdentity, persistedFinalAttempt)
        ? validatedGate.finalVerification
        : await loadPersistedEvidence(input.runDir, persistedFinalProgress, finalIdentity, persistedFinalAttempt);
      if (validatedGate) finalImplementation = mergeImplementationResults(finalImplementation, validatedGate.implementation);
    } catch (error) {
      const blocker = `Persisted integrated verification could not be resumed: ${errorMessage(error)}`;
      manifest = await recordRuntimeBlocker(input.runDir, blocker, finalItem.id, persistedFinalProgress?.attempts ?? 0);
      return { status: "human_action_required", manifest, orderedWorkItems, implementationResults, verification: evidenceByItem, reviews, finalVerification, finalReview, blocker };
    }
  }
  if (persistedFinalReviewPath) {
    try {
      const pathAttempt = persistedFinalReviewPath.match(/final-attempt-(\d+)\.json$/i)?.[1];
      const reviewAttempt = pathAttempt ? Number(pathAttempt) : finalVerification?.attempt ?? persistedFinalProgress?.attempts ?? 0;
      finalReview = await loadPersistedReviewPath(input.runDir, persistedFinalReviewPath, finalItem.id, reviewAttempt, true);
      finalReviewPath = persistedFinalReviewPath;
    } catch (error) {
      const blocker = `Persisted integrated Verifier review could not be resumed: ${errorMessage(error)}`;
      manifest = await recordRuntimeBlocker(input.runDir, blocker, finalItem.id, persistedFinalProgress?.attempts ?? 0);
      return { status: "human_action_required", manifest, orderedWorkItems, implementationResults, verification: evidenceByItem, reviews, finalVerification, finalReview, blocker };
    }
  }

  const postPrProgress = manifest.work_item_progress[finalItem.id];
  const postPrStageActive = ["final_verification", "verifier_review", "fixing"].includes(manifest.stage)
    && postPrProgress?.delivery_phase === "post_pr";
  const persistedIntegratedPr = typeof postPrProgress?.integrated_pr === "number"
    && Number.isInteger(postPrProgress.integrated_pr)
    && postPrProgress.integrated_pr > 0
    ? postPrProgress.integrated_pr
    : undefined;
  if (githubDelivery && postPrStageActive && persistedIntegratedPr === undefined) {
    const blocker = "Post-PR resume requires a positive persisted integrated PR number";
    manifest = await updateManifestV2(input.runDir, { delivery_state: "blocked", last_blocker: blocker });
    return { status: "human_action_required", manifest, orderedWorkItems, implementationResults, verification: evidenceByItem, reviews, finalVerification, finalReview, blocker };
  }
  const isPostPrResume = Boolean(
    githubDelivery
      && postPrStageActive
      && persistedIntegratedPr !== undefined
  );
  if (isPostPrResume && githubDelivery && persistedIntegratedPr !== undefined) {
    try {
      const githubManifest = await readManifestV2(input.runDir);
      const persistedMapping = requirePersistedPullRequestMapping(githubManifest);
      if (persistedMapping.number !== persistedIntegratedPr) {
        throw new Error(`Persisted integrated PR #${persistedIntegratedPr} does not match mapped PR #${persistedMapping.number}`);
      }
      let pullRequest = await openOrRecoverIntegratedPullRequest(
        githubDelivery,
        orderedWorkItems,
        mappedIssueNumbers(githubManifest, orderedWorkItems),
        persistedMapping.number,
        persistedMapping.url,
        githubManifest.github_ids.parent_issue_number ?? undefined,
        budget,
      );
      if (pullRequest.number !== persistedIntegratedPr) {
        throw new Error(`Persisted integrated PR #${persistedIntegratedPr} does not match recovered PR #${pullRequest.number}`);
      }
      let postResult: PostPrLoopResult;
      try {
        postResult = await runPostPrLoop(pullRequest, true);
      } catch (error) {
        const deterministicBlocked = await persistDeterministicReplanPreparationBlocker(input.runDir, error);
        if (deterministicBlocked !== null) {
          return {
            status: "human_action_required",
            manifest: deterministicBlocked.manifest,
            orderedWorkItems,
            implementationResults,
            verification: evidenceByItem,
            reviews,
            finalVerification,
            finalReview,
            blocker: deterministicBlocked.blocker,
            pullRequest,
          };
        }
        throw error;
      }
      if (postResult.blocker) {
        return { status: "human_action_required", manifest, orderedWorkItems, implementationResults, verification: evidenceByItem, reviews, finalVerification, finalReview, blocker: postResult.blocker, pullRequest, pendingReplanBoundary: postResult.pendingReplanBoundary };
      }
      const finalGithubManifest = await readManifestV2(input.runDir);
      const postLoopPullRequest = postResult.pullRequest ?? pullRequest;
      const finalPersistedMapping = requirePersistedPullRequestMapping(finalGithubManifest);
      const confirmedPullRequest = await openOrRecoverIntegratedPullRequest(
        githubDelivery,
        orderedWorkItems,
        mappedIssueNumbers(finalGithubManifest, orderedWorkItems),
        finalPersistedMapping.number,
        finalPersistedMapping.url,
        finalGithubManifest.github_ids.parent_issue_number ?? undefined,
      );
      if (postLoopPullRequest.number !== confirmedPullRequest.number) {
        throw new Error(`Post-PR pull request #${postLoopPullRequest.number} does not match mapped PR #${confirmedPullRequest.number}`);
      }
      resolvePersistedPullRequestMapping(finalGithubManifest, confirmedPullRequest);
      const events = (await readFile(join(input.runDir, "events.jsonl"), "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { type?: string; payload?: { pull_request_number?: number } });
      if (!events.some((event) => event.type === "pull_request_open" && event.payload?.pull_request_number === confirmedPullRequest.number)) {
        await appendRunEvent(input.runDir, {
          actor: "runtime",
          stage: "delivery",
          type: "pull_request_open",
          payload: { pull_request_number: confirmedPullRequest.number, pull_request_url: confirmedPullRequest.url, head: githubDelivery.branchName },
        });
      }
      await recordRuntimeRemoteSynchronization(githubDelivery, confirmedPullRequest);
      manifest = await transitionRun(input.runDir, "delivery", {
        actor: "runtime",
        payload: {
          delivery: "github_ready",
          final: true,
          work_item_id: "integrated",
          final_review_path: finalReviewPath,
          final_verification_path: postResult.postEvidencePath,
          final_commit: finalCommitSha ?? null,
          verifier_approved: true,
          pull_request_number: confirmedPullRequest.number,
          pull_request_url: confirmedPullRequest.url,
        },
      });
      const deliveryTransitionAt = manifest.updated_at;
      manifest = await updateManifestV2(input.runDir, { delivery_state: "ready", last_blocker: null });
      if (finalVerification && finalReview) {
        const deliveredCommit = manifest.work_item_progress.integrated?.commit_sha;
        if (typeof deliveredCommit !== "string") throw new Error("GitHub delivery status requires the persisted integrated commit");
        await syncRuntimeDeliveryStatus({
          runDir: input.runDir,
          github: githubDelivery.dependencies.github,
          manifest,
          pullRequest: confirmedPullRequest,
          commitSha: deliveredCommit,
          transitionAt: deliveryTransitionAt,
          evidence: finalVerification,
          review: finalReview,
          intentOnly: true,
          budget,
        });
      }
      return { status: "github_ready", manifest, orderedWorkItems, implementationResults, verification: evidenceByItem, reviews, finalVerification, finalReview, pullRequest: confirmedPullRequest };
    } catch (error) {
      if (error instanceof ConcurrentPlanPromotionHandoff) throw error;
      const approvalStop = await postErrorApprovalStop(input, error).catch(() => null);
      if (approvalStop?.concurrentPromotion) throw new ConcurrentPlanPromotionHandoff(approvalStop.result);
      if (approvalStop !== null) return approvalStop.result;
      const deterministicBlocked = await persistDeterministicReplanPreparationBlocker(input.runDir, error);
      if (deterministicBlocked !== null) {
        return {
          status: "human_action_required",
          manifest: deterministicBlocked.manifest,
          orderedWorkItems,
          implementationResults,
          verification: evidenceByItem,
          reviews,
          finalVerification,
          finalReview,
          blocker: deterministicBlocked.blocker,
        };
      }
      const blocker = `GitHub post-PR resume failed: ${errorMessage(error)}`;
      manifest = await updateManifestV2(input.runDir, { delivery_state: "blocked", last_blocker: blocker });
      return { status: "human_action_required", manifest, orderedWorkItems, implementationResults, verification: evidenceByItem, reviews, finalVerification, finalReview, blocker };
    }
  }
  const stageBeforeFinal = manifest.stage;
  let resumeFinalEvidence = false;
  let resumeFinalReview = false;
  let resumedFinalFix = false;
  if ((stageBeforeFinal === "fixing" || stageBeforeFinal === "verifying") && persistedFinalImplementationPath
    && persistedFinalProgress?.attempts && persistedFinalProgress.status !== "complete"
    && !persistedFinalProgress.candidate_recheck) {
    try {
      const persistedFix = await loadPersistedImplementation(input.runDir, persistedFinalProgress, finalItem);
      finalImplementation = mergeImplementationResults(finalImplementation, persistedFix);
      resumedFinalFix = true;
    } catch (error) {
      const blocker = `Persisted integrated Hands report could not be resumed: ${errorMessage(error)}`;
      manifest = await recordRuntimeBlocker(input.runDir, blocker, finalItem.id, persistedFinalProgress?.attempts ?? 0);
      return { status: "human_action_required", manifest, orderedWorkItems, implementationResults, verification: evidenceByItem, reviews, finalVerification, finalReview, blocker };
    }
  }
  if (persistedFinalProgress?.candidate_recheck) {
    const recheck = persistedFinalProgress.candidate_recheck;
    finalPass = recheck.attempt - 1;
    resumeFinalEvidence = recheck.state !== "reserved" && finalVerification?.attempt === recheck.attempt;
    resumeFinalReview = recheck.state === "reviewed" && finalReview?.attempt === recheck.attempt;
  } else if (claimedFinalFixSourceAttempt !== null) {
    finalPass = claimedFinalFixSourceAttempt - 1;
    resumeFinalEvidence = finalVerification?.attempt === claimedFinalFixSourceAttempt;
    resumeFinalReview = finalReview?.attempt === claimedFinalFixSourceAttempt;
  } else if (stageBeforeFinal === "verifier_review" && finalReview && finalReview.attempt === persistedFinalProgress?.attempts) {
    finalPass = Math.max(0, finalReview.attempt - 1);
    resumeFinalEvidence = finalVerification?.attempt === finalReview.attempt;
    resumeFinalReview = true;
  } else if ((stageBeforeFinal === "final_verification" || stageBeforeFinal === "verifier_review" || stageBeforeFinal === "verifying")
    && finalVerification && finalVerification.attempt === persistedFinalProgress?.attempts) {
    finalPass = Math.max(0, finalVerification.attempt - 1);
    resumeFinalEvidence = true;
    resumeFinalReview = stageBeforeFinal === "final_verification"
      && finalReview?.attempt === finalVerification.attempt;
  } else if (resumedFinalFix) {
    finalPass = Math.max(0, (persistedFinalProgress?.attempts ?? 1) - 1);
  } else if (Array.isArray(persistedFinalProgress?.approved_replan_history)
    && persistedFinalProgress.approved_replan_history.length > 0) {
    finalPass = Math.max(0, (persistedFinalProgress?.attempts ?? 1) - 1);
  }

  while (true) {
    const reviewPass = finalPass + 1;
    let savedEvidencePath: string;
    const reuseFinalEvidence = resumeFinalEvidence
      && finalVerification?.attempt === reviewPass
      && typeof finalVerification.evidence_path === "string";
    if (reuseFinalEvidence) {
      savedEvidencePath = finalVerification!.evidence_path as string;
      resumeFinalEvidence = false;
    } else {
      const currentRecheck = (await readManifestV2(input.runDir)).work_item_progress.integrated?.candidate_recheck;
      const candidateRecheck = currentRecheck?.attempt === reviewPass ? currentRecheck : undefined;
      const verificationStage = candidateRecheck ? "final_verification" : "verifying";
      if (finalPass > 0 && manifest.stage !== verificationStage) {
        manifest = await transitionRun(input.runDir, verificationStage, {
          actor: "runtime",
          payload: { work_item_id: finalItem.id, pass: reviewPass, final: true },
        });
        await publishRuntimeStatusCheckpoint(input, orderedWorkItems);
        await input.dependencies?.afterCheckpoint?.("after_status_verifying_publication");
      }
      if (candidateRecheck) {
        const rawFinalVerification = await verificationRunner({
          repoRoot: input.worktreePath,
          runDir: input.runDir,
          identity: finalIdentity,
          mode: githubDelivery ? "github" : "local",
          commands: input.plan.integration_verification,
          commandIds: input.plan.integration_verification.map((_command, index) => String(index + 1)),
          budget,
          expectedArtifacts: integratedExpectedArtifacts,
          browserChecks: integratedBrowserChecks,
          attempt: reviewPass,
          progress: input.progress,
          progressContext: { workItem: { index: orderedWorkItems.length + 1, total: orderedWorkItems.length + 1, attempt: reviewPass, final: true } },
        });
        finalVerification = validateEvidenceForIdentity(rawFinalVerification, finalIdentity, reviewPass);
        savedEvidencePath = await persistVerificationEvidence(input.runDir, finalVerification, finalIdentity, reviewPass);
        const current = (await readManifestV2(input.runDir)).work_item_progress.integrated!;
        manifest = await setProgress(input.runDir, finalItem.id, {
          ...current,
          status: "in_progress",
          attempts: reviewPass,
          verification_path: savedEvidencePath,
          ...verificationProgressIdentity(finalIdentity),
          candidate_recheck: {
            ...candidateRecheck,
            state: "verified",
            verification_path: savedEvidencePath,
          },
        }, [savedEvidencePath]);
      } else if (finalPass > 0) {
        try {
          const gateResult = await runMutationQualityGate({
            workItem: finalItem,
            parentAttempt: reviewPass,
            mutationKind: expectedTerminalMutationKind(),
            activeAction: null,
            completedActions: [],
            implementation: finalImplementation,
            phase: "pre_pr",
          });
          finalImplementation = gateResult.implementation;
          finalVerification = gateResult.finalVerification;
          if (finalVerification.verification_scope === finalIdentity.scope
            && finalVerification.work_item_id === finalIdentity.work_item_id) {
            savedEvidencePath = finalVerification.evidence_path;
          } else {
            const rawFinalVerification = await verificationRunner({
              repoRoot: input.worktreePath,
              runDir: input.runDir,
              identity: finalIdentity,
              mode: githubDelivery ? "github" : "local",
              commands: input.plan.integration_verification,
              commandIds: input.plan.integration_verification.map((_command, index) => String(index + 1)),
              stopOnFailure: true,
              budget,
              expectedArtifacts: integratedExpectedArtifacts,
              browserChecks: integratedBrowserChecks,
              attempt: reviewPass,
              progress: input.progress,
              progressContext: { workItem: { index: orderedWorkItems.length + 1, total: orderedWorkItems.length + 1, attempt: reviewPass, final: true } },
            });
            finalVerification = validateEvidenceForIdentity(rawFinalVerification, finalIdentity, reviewPass);
            savedEvidencePath = await persistVerificationEvidence(input.runDir, finalVerification, finalIdentity, reviewPass);
            manifest = await setProgress(input.runDir, finalItem.id, {
              status: "in_progress",
              attempts: reviewPass,
              verification_path: savedEvidencePath,
              ...verificationProgressIdentity(finalIdentity),
            }, [savedEvidencePath]);
          }
        } catch (error) {
          if (!(error instanceof HandsSelfReviewQualityGateError)) throw error;
          const blocker = `Hands self-review quality gate failed for integrated attempt ${reviewPass}: ${errorMessage(error)}`;
          manifest = await recordRuntimeBlocker(input.runDir, blocker, finalItem.id, reviewPass);
          return { status: "human_action_required", manifest, orderedWorkItems, implementationResults, verification: evidenceByItem, reviews, finalVerification, finalReview, blocker };
        }
      } else {
        let rawFinalVerification: VerificationEvidence;
        const finalVerificationRecoveryOperation: RetryableRuntimeOperation = {
          workItemId: finalItem.id,
          scopeId: "integrated:final",
          operation: "verification-infrastructure",
          attempt: reviewPass,
          classification: {
            failure_class: "test_infrastructure_blocker",
            blocker_code: "verification_infrastructure_failed",
          },
        };
        const finalVerificationRecoveryContext = await gateRetryableRuntimeOperation(
          finalVerificationRecoveryOperation,
        );
        if (finalVerificationRecoveryContext.gate.mode === "blocked") {
          const blocker = finalVerificationRecoveryContext.gate.guard_action === "diagnostic_stop"
            ? "Recovery diagnostic stop after repeated integrated verification-infrastructure"
            : "Recovery exhausted after integrated verification-infrastructure";
          manifest = await updateManifestV2(input.runDir, { delivery_state: "blocked", last_blocker: blocker });
          return { status: "human_action_required", manifest, orderedWorkItems, implementationResults, verification: evidenceByItem, reviews, finalVerification, finalReview, blocker };
        }
        try {
          rawFinalVerification = await verificationRunner({
            repoRoot: input.worktreePath,
            runDir: input.runDir,
            identity: finalIdentity,
             mode: githubDelivery ? "github" : "local",
             commands: input.plan.integration_verification,
             commandIds: input.plan.integration_verification.map((_command, index) => String(index + 1)),
             stopOnFailure: true,
             budget,
             expectedArtifacts: integratedExpectedArtifacts,
            browserChecks: integratedBrowserChecks,
            attempt: reviewPass,
            progress: input.progress,
            progressContext: { workItem: { index: orderedWorkItems.length + 1, total: orderedWorkItems.length + 1, attempt: reviewPass, final: true } },
          });
        } catch (error) {
          const blocker = `Integrated verification infrastructure failed: ${errorMessage(error)}`;
          const recovered = await recordRetryableRuntimeBlocker({
            ...finalVerificationRecoveryOperation,
            blocker,
            error,
            recoveryContext: finalVerificationRecoveryContext,
          });
          manifest = recovered.manifest;
          return { status: "human_action_required", manifest, orderedWorkItems, implementationResults, verification: evidenceByItem, reviews, finalVerification, finalReview, blocker: recovered.blocker };
        }
        finalVerification = validateEvidenceForIdentity(rawFinalVerification, finalIdentity, reviewPass);
        savedEvidencePath = await persistVerificationEvidence(input.runDir, finalVerification, finalIdentity, reviewPass);
        await recordAuthorizedRuntimeSuccess(
          finalVerificationRecoveryOperation,
          finalVerificationRecoveryContext,
          { verification_path: savedEvidencePath },
        );
        manifest = await setProgress(input.runDir, finalItem.id, {
          status: "in_progress",
          attempts: reviewPass,
          verification_path: savedEvidencePath,
          ...verificationProgressIdentity(finalIdentity),
        }, [savedEvidencePath]);
      }
      if (finalPass > 0) {
        await appendRunEvent(input.runDir, {
          actor: "runtime",
          stage: "final_verification",
          type: "transition",
          payload: { work_item_id: finalItem.id, final: true, pass: reviewPass },
        });
      }
    }
    if (!finalVerification) {
      throw new Error("Integrated final verification artifact is required before review");
    }
    const verificationFailures = verificationFailureReasons(finalVerification, integratedBrowserChecks);
    if (verificationFailures.length > 0 && (await readManifestV2(input.runDir)).review_policy_snapshot === undefined) {
      const blocker = `Integrated verification failed: ${verificationFailures.join("; ")}`;
      manifest = await updateManifestV2(input.runDir, {
        delivery_state: "blocked",
        last_blocker: blocker,
        current_work_item_id: finalItem.id,
        work_item_progress: {
          ...manifest.work_item_progress,
          [finalItem.id]: {
            ...(manifest.work_item_progress[finalItem.id] ?? {}),
            status: "blocked",
            attempts: reviewPass,
            verification_path: savedEvidencePath,
            ...verificationProgressIdentity(finalIdentity),
            blocker,
          },
        },
        final_artifact_paths: [...new Set([...manifest.final_artifact_paths, savedEvidencePath])],
      });
      return {
        status: "human_action_required",
        manifest,
        orderedWorkItems,
        implementationResults,
        verification: evidenceByItem,
        reviews,
        finalVerification,
        finalReview,
        blocker,
      };
    }
    manifest = await updateManifestV2(input.runDir, {
      final_artifact_paths: [...new Set([...manifest.final_artifact_paths, savedEvidencePath])],
    });
    const reuseFinalReview = resumeFinalReview
      && finalReview?.attempt === reviewPass;
    if (reuseFinalReview) {
      if (claimedFinalFixSourceAttempt === null && manifest.stage !== "verifier_review") {
        manifest = await transitionRun(input.runDir, "verifier_review", {
          actor: "runtime",
          payload: { work_item_id: finalItem.id, pass: reviewPass, final: true },
        });
      }
      resumeFinalReview = false;
    } else {
      try {
        await gateTerminalVerifier("final_integrated", reviewPass, savedEvidencePath);
      } catch (error) {
        const blocker = `Final-integrated evidence index validation failed: ${errorMessage(error)}`;
        manifest = await recordRuntimeBlocker(input.runDir, blocker, finalItem.id, reviewPass);
        return { status: "human_action_required", manifest, orderedWorkItems, implementationResults, verification: evidenceByItem, reviews, finalVerification, finalReview, blocker };
      }
      if (manifest.stage !== "verifier_review") {
        manifest = await transitionRun(input.runDir, "verifier_review", {
          actor: "runtime",
          payload: { work_item_id: finalItem.id, pass: reviewPass, final: true },
        });
      }
      let finalReviewResult: VerifyWorkItemResult;
      const finalVerifierRecoveryOperation: RetryableRuntimeOperation = {
        workItemId: finalItem.id,
        scopeId: "integrated:final",
        operation: "verifier-invocation",
        attempt: reviewPass,
        classification: { failure_class: "invocation_failure", blocker_code: "verifier_invocation_failed" },
      };
      const finalVerifierRecoveryContext = await gateRetryableRuntimeOperation(
        finalVerifierRecoveryOperation,
      );
      if (finalVerifierRecoveryContext.gate.mode === "blocked") {
        const blocker = finalVerifierRecoveryContext.gate.guard_action === "diagnostic_stop"
          ? "Recovery diagnostic stop after repeated final verifier-invocation"
          : "Recovery exhausted after final verifier-invocation";
        manifest = await updateManifestV2(input.runDir, { delivery_state: "blocked", last_blocker: blocker });
        return { status: "human_action_required", manifest, orderedWorkItems, implementationResults, verification: evidenceByItem, reviews, finalVerification, finalReview, blocker };
      }
      try {
        const boundedContext = await boundedVerifierInvocationContext(
          finalItem,
          "final_integrated",
          reviewPass,
        );
        const verifierInput: VerifyWorkItemInput = boundedContext ? {
          runDir: input.runDir,
          worktreePath: input.worktreePath,
          workItem: finalItem,
          ...boundedContext,
          intake: input.intake,
          codex: input.codex,
          attempt: reviewPass,
          progress: input.progress,
          workItemIndex: orderedWorkItems.length + 1,
          workItemTotal: orderedWorkItems.length + 1,
          budget,
        } : {
          runDir: input.runDir, worktreePath: input.worktreePath, workItem: finalItem,
          implementation: finalImplementation, verification: finalVerification,
          priorVerification: Object.values(evidenceByItem), final: true,
          intake: input.intake, codex: input.codex, attempt: reviewPass, progress: input.progress, budget,
          workItemIndex: orderedWorkItems.length + 1, workItemTotal: orderedWorkItems.length + 1,
        };
        finalReviewResult = await verifier(verifierInput);
      } catch (error) {
        const blocker = `Final Verifier invocation failed: ${errorMessage(error)}`;
        const recovered = await recordRetryableRuntimeBlocker({
          ...finalVerifierRecoveryOperation,
          blocker,
          error,
          recoveryContext: finalVerifierRecoveryContext,
        });
        manifest = recovered.manifest;
        return { status: "human_action_required", manifest, orderedWorkItems, implementationResults, verification: evidenceByItem, reviews, finalVerification, finalReview, blocker: recovered.blocker };
      }
      finalReview = finalReviewResult.review;
      finalReviewPath = controllerArtifactRelativePath(input.runDir, finalReviewResult.reviewPath);
      await recordAuthorizedRuntimeSuccess(
        finalVerifierRecoveryOperation,
        finalVerifierRecoveryContext,
        { review_path: finalReviewPath },
      );
      const currentProgress = (await readManifestV2(input.runDir)).work_item_progress.integrated;
      const candidateRecheck = currentProgress?.candidate_recheck?.attempt === reviewPass
        ? currentProgress.candidate_recheck
        : undefined;
      manifest = await setProgress(input.runDir, finalItem.id, {
        status: "in_progress",
        attempts: reviewPass,
        verification_path: savedEvidencePath,
        ...verificationProgressIdentity(finalIdentity),
        review_path: finalReviewPath,
        ...(candidateRecheck ? {
          candidate_recheck: {
            ...candidateRecheck,
            state: "reviewed",
            verification_path: savedEvidencePath,
            index_path: verifierEvidenceIndexPath("final_integrated", reviewPass),
            review_path: finalReviewPath,
          },
        } : {}),
      }, [finalReviewPath]);
    }
    finalPass = reviewPass;
    if (!finalVerification || !finalReview || !finalReviewPath) {
      throw new Error("Integrated final verification and review artifacts are required before delivery");
    }

    const finalPolicy = (await readManifestV2(input.runDir)).review_policy_snapshot
      ? await beginPolicyPhaseReview({
          phase: "final_integrated",
          workItem: finalItem,
          review: finalReview,
          reviewPath: finalReviewPath,
          verification: finalVerification,
          verificationPath: savedEvidencePath,
          attempt: reviewPass,
        })
      : null;
    const finalPolicyClaim = finalPolicy
      ? await claimPhaseReviewEffect(finalPolicy)
      : null;
    const finalRecoveryGate = finalPolicy
      && isReviewEffectAction(finalPolicy.cycle.decision.action)
      && finalPolicyClaim?.status === "acquired"
      && claimedFinalFixSourceAttempt === null
      ? await gateIntegratedPolicyEffect({
          policy: finalPolicy,
          scopeId: "integrated:final",
          operation: "final-integrated-fix",
          verificationPath: savedEvidencePath,
          reviewPath: finalReviewPath,
        })
      : null;
    if (finalRecoveryGate && finalRecoveryGate.guard_action !== "allow_next_effect") {
      const blocker = finalRecoveryGate.guard_action === "diagnostic_stop"
        ? "Recovery diagnostic stop for final integrated review"
        : finalRecoveryGate.guard_action === "exhausted_stop"
          ? "Recovery exhausted for final integrated review"
          : "Recovery awaits an external fix for final integrated review";
      manifest = await updateManifestV2(input.runDir, { delivery_state: "blocked", last_blocker: blocker });
      return { status: "human_action_required", manifest, orderedWorkItems, implementationResults, verification: evidenceByItem, reviews, finalVerification, finalReview, blocker };
    }
    const finalAdvances = finalPolicy
      ? finalPolicy.cycle.decision.action === "advance" || finalPolicy.cycle.decision.action === "continue_with_warning"
      : finalReview.decision === "approve";
    const reviewedCandidateCommit = finalAdvances
      ? await validateTerminalVerifierAfterReview("final_integrated", reviewPass, finalReviewPath)
      : null;

    if (finalAdvances) {
      if (finalPolicyClaim?.status === "blocked") throw new Error(`Final-integrated advance effect ${finalPolicy!.cycle.effect_id} is blocked`);
      try {
        await assertCurrentImplementationScope(finalItem, finalImplementation);
      } catch (error) {
        const blocker = `Integrated implementation scope check failed: ${errorMessage(error)}`;
        manifest = await recordRuntimeBlocker(input.runDir, blocker, finalItem.id, finalPass);
        return { status: "human_action_required", manifest, orderedWorkItems, implementationResults, verification: evidenceByItem, reviews, finalVerification, finalReview, blocker };
      }
      if (finalPolicy && finalPolicyClaim?.status === "acquired") {
        await completeReviewEffect({
          run_dir: input.runDir,
          cycle: finalPolicy.cycle,
          owner: finalPolicy.owner,
          outcome: "complete",
          result: { commit_sha: "policy-authorized" },
        });
      }
      if (finalPolicy) {
        await requireCompletedAdvanceEffect({
          run_dir: input.runDir,
          cycle: finalPolicy.cycle,
          owner: finalPolicy.owner,
        });
      }
      let candidateRecheckReserved = false;
      if (!finalPolicy || finalPolicyClaim?.status === "acquired" || finalPolicyClaim?.status === "complete") {
        const snapshot = await gitSnapshot(input.worktreePath);
        if (snapshot.status.trim().length > 0) {
          finalCommitSha = await commit({
            worktreePath: input.worktreePath,
            workItemId: finalItem.id,
            title: finalItem.title,
            verifierApproved: !finalPolicy,
            ...(finalPolicy ? { policyProof: { runDir: input.runDir, cycle: finalPolicy.cycle, owner: finalPolicy.owner } } : {}),
          });
          await input.progress?.emit({ code: "changes_committed", source: "runtime" });
          if (reviewedCandidateCommit !== null) {
            await input.dependencies?.afterCheckpoint?.("after_candidate_recheck_commit");
          }
          const afterCommit = await gitSnapshot(input.worktreePath);
          if (afterCommit.status.trim().length > 0) {
            const blocker = "Worktree remains dirty after the approved final commit";
            manifest = await updateManifestV2(input.runDir, {
              delivery_state: "blocked",
              last_blocker: blocker,
              current_work_item_id: finalItem.id,
            });
            return {
              status: "human_action_required",
              manifest,
              orderedWorkItems,
              implementationResults,
              verification: evidenceByItem,
              reviews,
              finalVerification,
              finalReview,
              blocker,
            };
          }
          if (reviewedCandidateCommit !== null) {
            const committedHead = await (input.dependencies?.localHeadSha ?? resolveLocalHeadSha)(input.worktreePath);
            if (committedHead !== finalCommitSha) {
              throw new Error("Approved final commit does not match the current candidate HEAD");
            }
            await reserveCandidateRecheck("final_integrated", reviewPass, committedHead);
            candidateRecheckReserved = true;
          }
        } else if (reviewedCandidateCommit !== null) {
          const currentHead = await (input.dependencies?.localHeadSha ?? resolveLocalHeadSha)(input.worktreePath);
          if (currentHead !== reviewedCandidateCommit) {
            finalCommitSha = currentHead;
            await reserveCandidateRecheck("final_integrated", reviewPass, currentHead);
            candidateRecheckReserved = true;
          }
        }
      }
      if (candidateRecheckReserved) {
        resumeFinalEvidence = false;
        resumeFinalReview = false;
        continue;
      }
      manifest = await updateManifestV2(input.runDir, {
        final_artifact_paths: [...new Set([...manifest.final_artifact_paths, finalReviewPath])],
        ...(finalCommitSha ? { current_work_item_id: null } : {}),
        ...(finalCommitSha ? {
          work_item_progress: {
            ...manifest.work_item_progress,
            [finalItem.id]: {
              ...(manifest.work_item_progress[finalItem.id] ?? {}),
              status: "in_progress",
              attempts: finalPass,
              verification_path: savedEvidencePath,
              ...verificationProgressIdentity(finalIdentity),
              review_path: finalReviewPath,
              commit_sha: finalCommitSha,
            },
          },
        } : {}),
      });

      if (githubDelivery) {
        try {
          if (manifest.stage !== "final_verification") {
            manifest = await transitionRun(input.runDir, "final_verification", {
              actor: "runtime", payload: { final: true, work_item_id: "integrated", delivery_boundary: "github" },
            });
          }
          const lineage = await withTaskLineageTransaction({
            repoRoot: githubDelivery.repoRoot, lineageId: manifest.task_lineage_id!, operation: (transaction) => transaction.read(),
          });
          const planning = await buildDeliveryPlanningInput(githubDelivery, manifest, lineage, orderedWorkItems, 1, new Date().toISOString());
          await prepareDeliveryEffectBoundary({
            runDir: input.runDir, repoRoot: githubDelivery.repoRoot, planning, manifest, lineage,
            afterArtifactPersisted: githubDelivery.dependencies.afterDeliveryPreviewArtifactPersisted,
            afterLineagePersisted: githubDelivery.dependencies.afterDeliveryPreviewLineagePersisted,
          });
          manifest = await readManifestV2(input.runDir);
          return { status: "awaiting_github_effects", manifest, orderedWorkItems, implementationResults, verification: evidenceByItem, reviews, finalVerification, finalReview };
        } catch (error) {
          if (error instanceof ConcurrentPlanPromotionHandoff) throw error;
          const approvalStop = await postErrorApprovalStop(input, error).catch(() => null);
          if (approvalStop?.concurrentPromotion) throw new ConcurrentPlanPromotionHandoff(approvalStop.result);
          if (approvalStop !== null) return approvalStop.result;
          const blocker = `GitHub delivery failed: ${errorMessage(error)}`;
          manifest = await updateManifestV2(input.runDir, { delivery_state: "blocked", last_blocker: blocker });
          return { status: "human_action_required", manifest, orderedWorkItems, implementationResults, verification: evidenceByItem, reviews, finalVerification, finalReview, blocker };
        }
      }

      const deliveredCommitSha = finalCommitSha
        ?? await (input.dependencies?.localHeadSha ?? resolveLocalHeadSha)(input.worktreePath);
      manifest = await setProgress(input.runDir, finalItem.id, {
        status: "complete",
        attempts: finalPass,
        verification_path: savedEvidencePath,
        review_path: finalReviewPath,
        ...verificationProgressIdentity(finalIdentity),
        commit_sha: deliveredCommitSha,
        candidate_recheck: undefined,
      }, [savedEvidencePath, finalReviewPath]);

      manifest = await transitionRun(input.runDir, "delivery", {
        actor: "runtime",
        payload: {
          delivery: "local_ready",
          final: true,
          work_item_id: "integrated",
          final_review_path: finalReviewPath,
          final_verification_path: savedEvidencePath,
          final_commit: deliveredCommitSha,
          verifier_approved: true,
        },
      });
      manifest = await updateManifestV2(input.runDir, { delivery_state: "ready", last_blocker: null });
      await input.progress?.emit({ code: "local_delivery_ready", source: "runtime" });
      return {
        status: "local_ready",
        manifest,
        orderedWorkItems,
        implementationResults,
        verification: evidenceByItem,
        reviews,
        finalVerification,
        finalReview,
      };
    }

    const finalPolicyAction = finalPolicy?.cycle.decision.action;
    if (finalPolicy && finalPolicyAction !== undefined && !isReviewEffectAction(finalPolicyAction)) {
      if (finalPolicyAction === "create_replan") {
        const preparedReplan = await createPhaseReplan(finalPolicy, finalPolicyClaim!, finalPass);
        return {
          status: "human_action_required",
          manifest,
          orderedWorkItems,
          implementationResults,
          verification: evidenceByItem,
          reviews,
          finalVerification,
          finalReview,
          ...preparedReplan,
        };
      }
      const blocker = `Final integrated review policy stopped: ${finalPolicy.cycle.decision.reason_code}`;
      if (finalPolicyClaim?.status === "acquired") {
        await completeReviewEffect({
          run_dir: input.runDir,
          cycle: finalPolicy.cycle,
          owner: finalPolicy.owner,
          outcome: "blocked",
          result: { blocker },
        });
      }
      manifest = await transitionRun(input.runDir, "replanning", {
        actor: "runtime",
        payload: { blocker, final: true, pass: finalPass },
      });
      manifest = await updateManifestV2(input.runDir, {
        delivery_state: "blocked",
        last_blocker: blocker,
        final_artifact_paths: [...new Set([...manifest.final_artifact_paths, finalReviewPath])],
      });
      return {
        status: "human_action_required",
        manifest,
        orderedWorkItems,
        implementationResults,
        verification: evidenceByItem,
        reviews,
        finalVerification,
        finalReview,
        blocker,
      };
    }

    const finalFixesUsed = (await readManifestV2(input.runDir)).work_item_progress[finalItem.id]?.terminal_hands_fix_attempts ?? 0;
    if (!finalPolicy && (reviewNeedsReplan(finalReview) || finalFixesUsed >= maxHandsFixAttempts)) {
      const blocker = finalFixesUsed >= maxHandsFixAttempts
        ? terminalFixLimitBlocker("Final integrated Verifier", finalFixesUsed)
        : "Final integrated Verifier review requires replanning";
      manifest = await transitionRun(input.runDir, "replanning", {
        actor: "runtime",
        payload: { blocker, final: true, pass: finalPass },
      });
      manifest = await updateManifestV2(input.runDir, {
        delivery_state: "blocked",
        last_blocker: blocker,
        final_artifact_paths: [...new Set([...manifest.final_artifact_paths, finalReviewPath])],
      });
      return { status: "human_action_required", manifest, orderedWorkItems, implementationResults, verification: evidenceByItem, reviews, finalVerification, finalReview, blocker };
    }

    if (manifest.stage !== "fixing") {
      manifest = await transitionRun(input.runDir, "fixing", {
        actor: "runtime",
        payload: { work_item_id: finalItem.id, pass: finalPass, final: true, findings: finalReview.findings },
      });
    }
    await publishRuntimeStatusCheckpoint(input, orderedWorkItems);
    await input.dependencies?.afterCheckpoint?.("after_status_fixing_publication");
    try {
      const finalCriteria = finalPolicy ? integratedPolicyCriteria(approvedCriteria)! : null;
      finalFixResult = await invokeHands(
        finalItem,
        finalPass + 1,
        finalPolicy?.cycle.decision.action === "quality_recovery" ? "quality_recovery" : "primary_fix",
        finalPolicy
          ? finalPolicy.findings.map((finding) => engineFindingToVerifierFinding(finding, finalCriteria!, finalItem.verification_commands))
          : finalReview.findings,
      );
    } catch (error) {
      if (error instanceof NonRetryableHandsResultError) {
        const blocker = `Hands result failed validation during final integration fix: ${errorMessage(error)}`;
        manifest = await recordRuntimeBlocker(input.runDir, blocker, finalItem.id, finalPass + 1);
        return { status: "human_action_required", manifest, orderedWorkItems, implementationResults, verification: evidenceByItem, reviews, finalVerification, finalReview, blocker };
      }
      if (finalPolicy && finalRecoveryGate?.mode === "authorized_attempt") {
        const progress = await buildRecoveryProgressSubject({
          runDir: input.runDir,
          manifest: await readManifestV2(input.runDir),
          workItemId: "integrated",
          findingIds: finalPolicy.cycle.decision.finding_ids,
          verificationPath: savedEvidencePath,
          reviewPath: finalReviewPath,
          reviewRevision: finalPolicy.cycle.review_revision,
        });
        await recordAuthorizedRecoveryOutcome({
          runDir: input.runDir,
          scopeId: "integrated:final",
          operation: "final-integrated-fix",
          authorizationId: finalRecoveryGate.authorization_id,
          effectAttemptId: finalRecoveryGate.effect_attempt_id,
          outcome: {
            kind: "failure",
            decision: finalPolicy.cycle.decision,
            classification: { failure_class: "implementation_failure", blocker_code: finalPolicy.cycle.decision.reason_code },
            error,
          },
          progress,
          ownedEvidenceRefs: { verification_path: savedEvidencePath, review_path: finalReviewPath },
        });
      }
      const blocker = `Hands invocation failed during final integration fix: ${errorMessage(error)}`;
      if (finalRecoveryGate?.mode === "authorized_attempt") {
        manifest = await recordRuntimeBlocker(input.runDir, blocker, finalItem.id, finalPass + 1);
        return { status: "human_action_required", manifest, orderedWorkItems, implementationResults, verification: evidenceByItem, reviews, finalVerification, finalReview, blocker };
      }
      const recovered = await recordRetryableRuntimeBlocker({
        workItemId: finalItem.id,
        scopeId: "integrated:final",
        operation: "hands-invocation",
        attempt: finalPass + 1,
        blocker,
        classification: { failure_class: "invocation_failure", blocker_code: "hands_invocation_failed" },
        error,
        findingIds: finalPolicy?.cycle.decision.finding_ids,
        requestedEffect: finalPolicy && isReviewEffectAction(finalPolicy.cycle.decision.action)
          ? finalPolicy.cycle.decision.action
          : undefined,
        requestedEffectReason: finalPolicy?.cycle.decision.reason_code,
      });
      manifest = recovered.manifest;
      return { status: "human_action_required", manifest, orderedWorkItems, implementationResults, verification: evidenceByItem, reviews, finalVerification, finalReview, blocker: recovered.blocker };
    }
    finalImplementation = mergeImplementationResults(finalImplementation, finalFixResult.implementation);
    const beforeFinalFixProgress = (await readManifestV2(input.runDir)).work_item_progress[finalItem.id];
    const fixedCandidateRecheck = beforeFinalFixProgress?.candidate_recheck?.state === "reviewed";
    manifest = await setProgress(input.runDir, finalItem.id, {
      status: "in_progress",
      attempts: finalPass + 1,
      implementation_path: finalFixResult.reportPath,
      verification_path: undefined,
      verification_scope: undefined,
      verification_work_item_id: undefined,
      verification_issue_number: undefined,
      review_path: finalReviewPath,
      mutation_kind: expectedTerminalMutationKind(),
      self_review_pass: 0,
      self_review_state: "pending",
      mutation_verification_path: undefined,
      self_review_paths: undefined,
      self_review_verification_paths: undefined,
      candidate_recheck: undefined,
      terminal_hands_fix_attempts: (beforeFinalFixProgress?.terminal_hands_fix_attempts ?? 0) + 1,
    }, [finalFixResult.reportPath]);
    if (finalPolicy && finalRecoveryGate?.mode === "authorized_attempt") {
      const progress = await buildRecoveryProgressSubject({
        runDir: input.runDir,
        manifest,
        workItemId: "integrated",
        findingIds: finalPolicy.cycle.decision.finding_ids,
        implementationPath: finalFixResult.reportPath,
        verificationPath: savedEvidencePath,
        reviewPath: finalReviewPath,
        reviewRevision: finalPolicy.cycle.review_revision,
      });
      await recordAuthorizedRecoveryOutcome({
        runDir: input.runDir,
        scopeId: "integrated:final",
        operation: "final-integrated-fix",
        authorizationId: finalRecoveryGate.authorization_id,
        effectAttemptId: finalRecoveryGate.effect_attempt_id,
        outcome: { kind: "success", decision: finalPolicy.cycle.decision },
        progress,
        ownedEvidenceRefs: {
          implementation_path: finalFixResult.reportPath,
          verification_path: savedEvidencePath,
          review_path: finalReviewPath,
        },
      });
    }
    if (finalPolicy) {
      const effectAction = finalPolicy.cycle.decision.action;
      if (!isReviewEffectAction(effectAction)) throw new Error("Final-integrated fix effect action changed after dispatch");
      if (finalPolicyClaim?.status === "blocked") throw new Error(`Final-integrated fix effect ${finalPolicy.cycle.effect_id} is blocked`);
      if (finalPolicyClaim?.status === "acquired") {
        await completeReviewEffect({
          run_dir: input.runDir,
          cycle: finalPolicy.cycle,
          owner: finalPolicy.owner,
          outcome: "complete",
          result: { attempt: finalPass + 1, implementation_path: finalFixResult.reportPath },
        });
        await input.dependencies?.afterCheckpoint?.("after_final_integrated_effect_complete");
      }
      await incrementSuccessfulFix({
        run_dir: input.runDir,
        cycle: finalPolicy.cycle,
        owner: finalPolicy.owner,
        mutation_id: finalFixResult.reportPath,
        kind: "successful_fix",
        effect_action: effectAction,
      });
      const afterFix = await readManifestV2(input.runDir);
      manifest = await setProgress(input.runDir, finalItem.id, {
        ...afterFix.work_item_progress[finalItem.id]!,
        review_cycle_path: undefined,
        review_effect_id: undefined,
      });
    }
    if (fixedCandidateRecheck) {
      await input.dependencies?.afterCheckpoint?.("after_candidate_recheck_hands_report");
    }
  }
}

async function recordRuntimeDeliveryDisposition(
  runDir: string,
  reason: string,
): Promise<RunManifestV2> {
  const manifest = await readManifestV2(runDir);
  if (manifest.mode !== "github") {
    return recordTerminalDisposition(runDir, {
      outcome: "delivered",
      actor: "runtime",
      reason,
      residual_risks: [],
    });
  }
  if (manifest.task_lineage_id === null) throw new Error("GitHub delivery is missing its task lineage");
  const lineage = await readTaskLineage(manifest.repo_root, manifest.task_lineage_id);
  return recordTerminalDispositionWithCleanup({
    runDir,
    disposition: { outcome: "delivered", actor: "runtime", reason, residual_risks: [] },
    lineage,
  });
}

function authorityCheckedObject<T extends object>(target: T, options: { effect?: boolean } = {}): T {
  return new Proxy(target, {
    get(object, property, receiver) {
      const value = Reflect.get(object, property, receiver) as unknown;
      if (typeof value !== "function") return value;
      const moduleOwnedPersistence = property === "recordRemoteSynchronization"
        || property === "persistFinalDeliveryAssessmentAtBoundary";
      const checkpointHook = typeof property === "string" && property.startsWith("after");
      if (moduleOwnedPersistence || checkpointHook) {
        return async (...args: unknown[]) => {
          if (moduleOwnedPersistence) await waitForCurrentExecutionEffects();
          await assertCurrentExecutionAuthority();
          return Reflect.apply(value as (...callArgs: unknown[]) => unknown, object, args);
        };
      }
      return async (...args: unknown[]) => {
        await assertCurrentExecutionAuthority();
        if (options.effect === false) {
          return Reflect.apply(value as (...callArgs: unknown[]) => unknown, object, args);
        }
        return withCurrentExecutionEffect(`adapter:${String(property)}`, async () =>
          Reflect.apply(value as (...callArgs: unknown[]) => unknown, object, args));
      };
    },
  });
}

function guardRuntimeEffects<T extends RunLocalWorkflowInput | RunGithubWorkflowInput>(input: T): T {
  const dependencies = input.dependencies ? authorityCheckedObject(input.dependencies) : undefined;
  const guardedDependencies = dependencies && "github" in dependencies
    ? { ...dependencies, github: authorityCheckedObject(dependencies.github as object) }
    : dependencies;
  return {
    ...input,
    codex: authorityCheckedObject(input.codex),
    ...(guardedDependencies ? { dependencies: guardedDependencies } : {}),
    // Local JSONL telemetry is replay-safe. It still checks authority but does
    // not create a durable external-effect intent that could strand a lease.
    ...(input.progress ? { progress: authorityCheckedObject(input.progress, { effect: false }) } : {}),
  } as T;
}

export async function withRunExecutionLease<T>(
  runDir: string,
  operation: () => Promise<T>,
): Promise<T> {
  const existing = currentExecutionAuthority();
  if (existing) {
    if (await realpath(existing.claim.runDir) !== await realpath(runDir)) {
      throw new Error("Cross-run execution lease reuse is not allowed");
    }
    await existing.assert();
    return operation();
  }
  const scope = await acquireRunExecutionScope(runDir);
  try {
    return await scope.run(operation);
  } finally {
    await scope.release();
  }
}

export interface RunExecutionScope {
  claim: ExecutionLeaseClaim;
  run<T>(operation: () => Promise<T>): Promise<T>;
  release(): Promise<void>;
}

export async function acquireRunExecutionScope(runDir: string): Promise<RunExecutionScope> {
  const manifest = await readManifestV2(runDir);
  await controllerProvenance.assertCurrentControllerMatches(runDir, manifest);
  const leaseMode = manifest.pending_plan_approval === null
      ? "execution"
      : manifest.pending_plan_approval.base_revision === null
        ? "initial_pending_publication"
        : "pending_publication";
  const claim = await acquireExecutionLease(runDir, { mode: leaseMode });
  const checkoutVerification = new AsyncLocalStorage<boolean>();
  let checkoutVerificationInFlight: Promise<void> | null = null;
  const assertLeaseAndCheckout = async (): Promise<void> => {
    await assertExecutionLease(runDir, claim);
    const assertedManifest = await readManifestV2(runDir);
    if (assertedManifest.execution_lease?.token === claim.token
      && assertedManifest.execution_lease.mode !== "execution") return;
    // Git commands used by the verifier inherit this recursion marker. Other
    // concurrent callers join the same complete verification so a second
    // checkout probe cannot deadlock against the serialized effect queue.
    if (checkoutVerification.getStore()) return;
    const existingVerification = checkoutVerificationInFlight;
    if (existingVerification !== null) return existingVerification;
    const verification = checkoutVerification.run(true, () => runWithExecutionAuthorityPreflight(async () => {
      const current = await readManifestV2(runDir);
      if (current.execution_lease?.token === claim.token
        && current.execution_lease.mode !== "execution") return;
      const requiresPinnedCheckout = await requiresPinnedRuntimeAuthority(runDir, current);
      if (!requiresPinnedCheckout) return;
      if (current.worktree_path === null || current.branch_name === null) {
        if (currentCheckoutAllocationAuthority() || leaseMode === "initial_pending_publication") return;
        throw new Error("Approved execution requires a pinned checkout identity");
      }
      if (current.source_commit === null) {
        throw new Error("Approved execution requires a pinned source commit");
      }
      try {
        await access(current.worktree_path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT"
          && current.checkout_allocation_state === "pending"
          && currentCheckoutAllocationAuthority()) return;
        throw error;
      }
      await verifyRunWorktreeIdentity({
        repoRoot: current.repo_root,
        runId: current.run_id,
        worktreePath: current.worktree_path,
        branchName: current.branch_name,
        sourceCommit: current.source_commit,
      });
    }));
    checkoutVerificationInFlight = verification;
    try {
      await verification;
    } finally {
      if (checkoutVerificationInFlight === verification) checkoutVerificationInFlight = null;
    }
  };
  const context = {
    claim,
    assert: assertLeaseAndCheckout,
    // beginExecutionEffect atomically validates the lease claim. The more
    // expensive checkout preflight runs before the effect queue is reserved.
    beginEffect: (kind: string) => beginExecutionEffect(runDir, claim, kind),
    recordEffectChild: (invocationId: string, pid: number | null) =>
      recordExecutionEffectChild(runDir, claim, invocationId, pid),
    endEffect: (invocationId: string) => endExecutionEffect(runDir, claim, invocationId),
  };
  return {
    claim,
    run: <T>(operation: () => Promise<T>) => runWithExecutionAuthority(context, operation),
    release: async () => {
      const current = await readManifestV2(runDir).catch(() => null);
      // A tainted or otherwise uncertain effect intentionally strands the
      // durable lease. Do not let cleanup mask the originating authority/error.
      if (current?.execution_lease?.token === claim.token
        && current.execution_lease.active_effect === null) {
        try {
          await releaseExecutionLease(runDir, claim);
        } catch (error) {
          const refreshed = await readManifestV2(runDir).catch(() => null);
          if (refreshed?.execution_lease?.token === claim.token) throw error;
        }
      }
    },
  };
}

async function pinHistoricalCheckoutIfRequired(
  input: RunLocalWorkflowInput | RunGithubWorkflowInput,
): Promise<void> {
  const manifest = await readManifestV2(input.runDir);
  const approvalStart = manifest.approval_protocol_start_revision;
  if (manifest.approval_protocol_version !== 1
    || approvalStart === null
    || approvalStart === undefined
    || approvalStart <= 1) return;
  if (manifest.source_commit === null) {
    throw new Error("Historical checkout migration requires a pinned source commit before worktree allocation");
  }
  if (await loadApprovedRuntimeSnapshot(input.runDir, input.config ?? defaultConfig()) === null) {
    throw new Error("Historical checkout migration requires complete immutable approval evidence");
  }
  const sourceCommit = manifest.source_commit;
  const worktreePath = runWorktreePath(manifest.repo_root, manifest.run_id);
  const branchName = runWorktreeBranchName(manifest.run_id);
  if ((manifest.worktree_path !== null && resolve(manifest.worktree_path) !== worktreePath)
    || (manifest.branch_name !== null && manifest.branch_name !== branchName)) {
    throw new Error("Historical checkout migration conflicts with the pinned checkout identity");
  }
  if (resolve(input.worktreePath) !== worktreePath
    || ("branchName" in input && input.branchName !== branchName)) {
    throw new Error("Historical checkout migration requires the deterministic run worktree and branch");
  }
  await withRunExecutionLease(input.runDir, () => runWithCheckoutAllocationAuthority(async () => {
    const authority = currentExecutionAuthority();
    if (!authority) throw new Error("Historical checkout migration requires execution lease authority");
    await setRunCheckoutIdentity(input.runDir, authority.claim, { worktreePath, branchName });
    try {
      await access(worktreePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const created = await createRunWorktree(manifest.repo_root, manifest.run_id, sourceCommit);
      if (created.worktreePath !== worktreePath || created.branchName !== branchName) {
        throw new Error("Historical checkout allocation differs from its pinned identity");
      }
    }
    await verifyRunWorktreeIdentity({
      repoRoot: manifest.repo_root,
      runId: manifest.run_id,
      worktreePath,
      branchName,
      sourceCommit,
    });
    await markRunCheckoutReady(input.runDir, authority.claim);
  }));
}

/** Durable boundary: no local-run exception escapes without a blocked ledger result. */
async function runLocalWorkflowOwned(input: RunLocalWorkflowInput): Promise<LocalWorkflowResult> {
  const entry = await readRuntimeEntryManifest(input.runDir);
  await controllerProvenance.assertCurrentControllerMatches(input.runDir, entry.manifest);
  if (entry.authorityBlocker !== null) return runtimeAuthorityStop(entry.manifest, entry.authorityBlocker);
  const initialManifest = entry.manifest;
  if (initialManifest.terminal !== null && initialManifest.terminal.outcome !== "delivered") {
    throw new Error(`Cannot execute run with terminal outcome ${initialManifest.terminal.outcome}`);
  }
  try {
    try {
      input = await bindApprovedRuntimeAuthority(input);
    } catch (error) {
      throw new RuntimeAuthorityError(error);
    }
    const initiallyBoundAuthority = runtimeAuthorityToken(await readManifestV2(input.runDir));
    await input.dependencies?.afterCheckpoint?.("after_initial_runtime_authority_bind");
    const authorityAfterInitialBind = await readManifestV2(input.runDir);
    if (runtimeAuthorityToken(authorityAfterInitialBind) !== initiallyBoundAuthority) {
      return concurrentRuntimeAuthorityHandoff(authorityAfterInitialBind);
    }
    const approvalStop = await preBootstrapApprovalStop(input);
    if (approvalStop !== null) {
      await input.progress?.emit({ code: "worker_started", source: "runtime" });
      await input.progress?.emit({ code: "worker_blocked", source: "runtime" });
      return approvalStop.result;
    }
    const authorityAfterApprovalCheck = await readManifestV2(input.runDir);
    if (runtimeAuthorityToken(authorityAfterApprovalCheck) !== initiallyBoundAuthority) {
      return concurrentRuntimeAuthorityHandoff(authorityAfterApprovalCheck);
    }
    try {
      input = await bindApprovedRuntimeAuthority(input);
    } catch (error) {
      throw new RuntimeAuthorityError(error);
    }
    await verifyApprovedCheckout(input);
    await input.progress?.emit({ code: "worker_started", source: "runtime" });
    await prepareApprovedControllerBootstrap(input);
    const result = await runLocalWorkflowUnsafe(input);
    if (result.status === "local_ready" && input.deferTerminalDisposition !== true) {
      result.manifest = await recordRuntimeDeliveryDisposition(input.runDir, "Local delivery is ready");
    }
    await input.progress?.emit({ code: result.status === "human_action_required" ? "worker_blocked" : "worker_completed", source: "runtime" });
    return result;
  } catch (error) {
    if (error instanceof RuntimeAuthorityError) {
      return {
        status: "human_action_required",
        manifest: await readManifestV2(input.runDir),
        orderedWorkItems: [],
        implementationResults: {},
        verification: {},
        reviews: {},
        blocker: error.message,
      };
    }
    if (error instanceof ConcurrentPlanPromotionHandoff) {
      await input.progress?.emit({ code: "worker_blocked", source: "runtime" });
      return error.result;
    }
    const approvalStop = await postErrorApprovalStop(input, error).catch(() => null);
    if (approvalStop !== null) {
      await input.progress?.emit({ code: "worker_blocked", source: "runtime" });
      return approvalStop.result;
    }
    const blocker = `Local runtime failed: ${errorMessage(error)}`;
    try {
      const manifest = await updateManifestV2(input.runDir, {
        delivery_state: "blocked",
        last_blocker: blocker,
      });
      await input.progress?.emit({ code: "worker_blocked", source: "runtime" });
      return {
        status: "human_action_required",
        manifest,
        orderedWorkItems: [],
        implementationResults: {},
        verification: {},
        reviews: {},
        blocker,
      };
    } catch {
      throw error;
    }
  }
}

export function resolveRunStatusIssueNumber(
  manifest: Pick<RunManifestV2, "current_work_item_id" | "github_ids" | "stage" | "work_item_progress">
    & Partial<Pick<RunManifestV2, "work_item_issue_map">>,
  orderedWorkItems: readonly WorkItem[],
  rawPlanWorkItems?: readonly WorkItem[],
): number | null {
  const issueNumbers = manifest.github_ids.issue_numbers;
  const planWorkItems = rawPlanWorkItems ?? orderedWorkItems;
  const current = manifest.current_work_item_id;
  const currentProgress = current === null ? undefined : manifest.work_item_progress[current];
  if (current !== null && (
    typeof currentProgress?.replan_target_work_item_id === "string"
    || typeof currentProgress?.replan_patch_path === "string"
  )) {
    const replanTarget = typeof currentProgress.replan_target_work_item_id === "string"
      ? currentProgress.replan_target_work_item_id
      : current;
    if (!orderedWorkItems.some((item) => item.id === replanTarget)) return null;
    return resolveWorkItemIssueNumber(manifest, replanTarget, planWorkItems);
  }
  const integrated = manifest.work_item_progress.integrated;
  const integratedPhaseActive = current === "integrated"
    || ["final_verification", "delivery", "complete"].includes(manifest.stage)
    || Boolean(integrated && (
      integrated.delivery_phase === "post_pr"
      || typeof integrated.review_cycle_path === "string"
      || (["final_verification", "verifier_review", "fixing", "delivery", "complete"].includes(manifest.stage)
        && (typeof integrated.review_path === "string" || typeof integrated.verification_path === "string"))
    ));
  if (current === null || integratedPhaseActive) return issueNumbers[0] ?? null;
  const index = orderedWorkItems.findIndex((item) => item.id === current);
  if (index < 0) throw new Error(`Run status cannot resolve unknown current work item: ${current}`);
  return resolveWorkItemIssueNumber(manifest, current, planWorkItems);
}

function resolveDurableMappedRunStatusIssueNumber(
  manifest: Pick<RunManifestV2, "current_work_item_id" | "github_ids" | "stage" | "work_item_progress">
    & Partial<Pick<RunManifestV2, "work_item_issue_map">>,
  orderedWorkItems: readonly WorkItem[],
): number | null {
  const nestedMap = manifest.github_ids.work_item_issue_map ?? {};
  const mappedIssueFor = (workItemId: string): number | null => {
    const issueNumber = nestedMap[workItemId] ?? null;
    return Number.isInteger(issueNumber) && issueNumber > 0 ? issueNumber : null;
  };
  const current = manifest.current_work_item_id;
  const currentProgress = current === null ? undefined : manifest.work_item_progress[current];
  if (current !== null && (
    typeof currentProgress?.replan_target_work_item_id === "string"
    || typeof currentProgress?.replan_patch_path === "string"
  )) {
    const replanTarget = typeof currentProgress.replan_target_work_item_id === "string"
      ? currentProgress.replan_target_work_item_id
      : current;
    if (!orderedWorkItems.some((item) => item.id === replanTarget)) return null;
    return mappedIssueFor(replanTarget);
  }
  if (current !== null) return mappedIssueFor(current);
  return null;
}

function hasReplanRunStatusSource(
  manifest: Pick<RunManifestV2, "current_work_item_id" | "work_item_progress">,
): boolean {
  const current = manifest.current_work_item_id;
  if (current === null) return false;
  const currentProgress = manifest.work_item_progress[current];
  return typeof currentProgress?.replan_target_work_item_id === "string"
    || typeof currentProgress?.replan_patch_path === "string";
}

async function publishRuntimeStatusCheckpoint(
  input: RunLocalWorkflowInput,
  orderedWorkItems: readonly WorkItem[],
): Promise<void> {
  const githubDelivery = (input as RunLocalWorkflowInput & { githubDelivery?: RunGithubWorkflowInput }).githubDelivery;
  const github = githubDelivery?.dependencies.github;
  if (!github?.upsertRunStatus) return;
  const manifest = await readManifestV2(input.runDir);
  const issueNumber = resolveRunStatusIssueNumber(manifest, orderedWorkItems, input.plan.work_items);
  if (issueNumber === null) return;
  const status = await readOperatorStatus(input.runDir);
  if (status.operator_state === "operationally_blocked" && manifest.delivery_state !== "blocked") {
    throw new Error(status.blocker ?? "Status checkpoint provenance is operationally blocked");
  }
  const comment = formatRunStatusComment(status);
  await github.upsertRunStatus({ kind: "issue", number: issueNumber }, comment.marker, comment.body);
}

function pendingReplanCoordinatesFromCandidate(
  manifest: RunManifestV2,
): PreparedReplanApprovalCoordinates {
  const pending = manifest.pending_plan_approval;
  if (!pending || typeof pending.base_revision !== "number") {
    throw new Error("Pending replan publication candidate is missing exact approval coordinates");
  }
  const revision = manifest.plan_revisions[String(pending.proposed_revision)];
  if (!revision
    || revision.origin !== "replan"
    || revision.base_revision !== pending.base_revision
    || revision.approval_request_path !== pending.request_path
    || revision.approval_request_sha256 !== pending.request_sha256
    || revision.approval_subject_sha256 !== pending.approval_subject_sha256
    || manifest.last_blocker === null
    || manifest.last_blocker.trim() === "") {
    throw new Error("Pending replan publication candidate has invalid revision or blocker binding");
  }
  return {
    baseRevision: pending.base_revision,
    proposedRevision: pending.proposed_revision,
    pending,
    canonicalBlocker: manifest.last_blocker,
  };
}

async function publishGithubWorkflowStatusOwned(
  input: Pick<RunGithubWorkflowInput, "runDir" | "dependencies" | "plan"> & { assuranceAssessment?: AssuranceAssessment },
  result: LocalWorkflowResult,
): Promise<LocalWorkflowResult> {
  if (!input.dependencies.github.upsertRunStatus) return result;
  try {
    let pendingReplanBoundary = result.pendingReplanBoundary;
    let markerlessRecoveryError: unknown = null;
    if (!pendingReplanBoundary && typeof result.manifest.pending_plan_approval?.base_revision === "number") {
      let recovered: PreparedReplanApprovalBoundary | null = null;
      try {
        recovered = await reconcilePendingReplanApprovalBoundary({ runDir: input.runDir });
      } catch (error) {
        markerlessRecoveryError = error;
      }
      if (markerlessRecoveryError === null) {
        if (recovered?.state === "approved") {
          return concurrentPromotionApprovalStop(
            recovered.manifest,
            recovered.coordinates.proposedRevision,
          ).result;
        }
        pendingReplanBoundary = recovered?.coordinates
          ?? pendingReplanCoordinatesFromCandidate(result.manifest);
        result = { ...result, pendingReplanBoundary };
      }
    }
    if (pendingReplanBoundary) {
      const guarded = await reconcilePreparedPlanApprovalBoundary({
        runDir: input.runDir,
        ...pendingReplanBoundary,
      });
      if (guarded.state === "approved") {
        return concurrentPromotionApprovalStop(
          guarded.manifest,
          pendingReplanBoundary.proposedRevision,
        ).result;
      }
      result = { ...result, manifest: guarded.manifest };
    }
    let manifest = await readManifestV2(input.runDir);
    const approvedAuthority = manifest.approved_revision === null
      ? null
      : await loadApprovedRuntimeSnapshot(input.runDir);
    const authoritativePlan = approvedAuthority?.plan
      ?? (manifest.pending_plan_approval?.base_revision === null
        ? (await loadVerifiedPlanBundle(
            input.runDir,
            manifest,
            manifest.pending_plan_approval.proposed_revision,
          )).plan
        : input.plan);
    const orderedWorkItems = topologicallySortWorkItems(authoritativePlan.work_items);
    let issueNumber = resolveRunStatusIssueNumber(manifest, orderedWorkItems);
    if (markerlessRecoveryError !== null) {
      const blocker = errorMessage(markerlessRecoveryError);
      if (manifest.delivery_state !== "blocked" || manifest.last_blocker !== blocker) {
        manifest = await updateManifestV2(input.runDir, { delivery_state: "blocked", last_blocker: blocker });
      }
      result = { ...result, status: "human_action_required", manifest, blocker };
      issueNumber = resolveDurableMappedRunStatusIssueNumber(manifest, orderedWorkItems);
    }
    if (issueNumber === null) return result;
    let status = await readOperatorStatus(input.runDir, {
      assuranceAssessment: input.assuranceAssessment,
      assessAssurance: manifest.pending_plan_approval === null
        && manifest.assurance_assessment_path !== null,
    });
    if (status.operator_state === "operationally_blocked") {
      const blocker = status.blocker ?? "Status provenance is operationally blocked";
      if (result.blocker && blocker.startsWith("Status provenance invalid:")) {
        const combinedBlocker = `${result.blocker}; ${blocker}`;
        if (manifest.delivery_state !== "blocked" || manifest.last_blocker !== combinedBlocker) {
          manifest = await updateManifestV2(input.runDir, { delivery_state: "blocked", last_blocker: combinedBlocker });
        }
        return { ...result, status: "human_action_required", manifest, blocker: combinedBlocker };
      }
      if (manifest.delivery_state !== "blocked") {
        manifest = await updateManifestV2(input.runDir, { delivery_state: "blocked", last_blocker: blocker });
      }
      result = { ...result, status: "human_action_required", manifest, blocker };
      const durableIssueNumber = resolveDurableMappedRunStatusIssueNumber(manifest, orderedWorkItems);
      if (durableIssueNumber !== null) {
        issueNumber = durableIssueNumber;
      } else if (hasReplanRunStatusSource(manifest)) {
        return result;
      }
      status = await readOperatorStatus(input.runDir, {
        assuranceAssessment: input.assuranceAssessment,
        assessAssurance: manifest.pending_plan_approval === null
          && manifest.assurance_assessment_path !== null,
      });
    }
    const comment = formatRunStatusComment(status);
    await input.dependencies.github.upsertRunStatus(
      { kind: "issue", number: issueNumber },
      comment.marker,
      comment.body,
    );
    return { ...result, manifest: await readManifestV2(input.runDir) };
  } catch (error) {
    const publicationFailure = `GitHub run-status publication failed: ${errorMessage(error)}`;
    const blocker = result.blocker
      ? `${result.blocker}; ${publicationFailure}`
      : publicationFailure;
    const manifest = await updateManifestV2(input.runDir, { delivery_state: "blocked", last_blocker: blocker });
    return { ...result, status: "human_action_required", manifest, blocker };
  }
}

export async function publishGithubWorkflowStatus(
  input: Pick<RunGithubWorkflowInput, "runDir" | "dependencies" | "plan"> & { assuranceAssessment?: AssuranceAssessment },
  result: LocalWorkflowResult,
): Promise<LocalWorkflowResult> {
  const manifest = await readManifestV2(input.runDir);
  await controllerProvenance.assertCurrentControllerMatches(input.runDir, manifest);
  if (manifest.approved_revision === null && manifest.pending_plan_approval === null) {
    // No approved or proposed subject exists to authorize a GitHub mutation.
    return result;
  }
  const proposedReplanRevision = result.pendingReplanBoundary?.proposedRevision
    ?? result.manifest.pending_plan_approval?.proposed_revision
    ?? null;
  if (proposedReplanRevision !== null) {
    const current = await readManifestV2(input.runDir);
    if (current.pending_plan_approval === null
      && current.approved_revision === proposedReplanRevision
      && current.approved_plan_revision === proposedReplanRevision) {
      return concurrentPromotionApprovalStop(
        current,
        proposedReplanRevision,
      ).result;
    }
  }
  if (result.pendingReplanBoundary) {
    const guardedBoundary = await reconcilePreparedPlanApprovalBoundary({
      runDir: input.runDir,
      ...result.pendingReplanBoundary,
    });
    if (guardedBoundary.state === "approved") {
      return concurrentPromotionApprovalStop(
        guardedBoundary.manifest,
        result.pendingReplanBoundary.proposedRevision,
      ).result;
    }
  }
  const guarded = {
    ...input,
    dependencies: {
      ...authorityCheckedObject(input.dependencies),
      github: authorityCheckedObject(input.dependencies.github),
    },
  };
  const published = await withRunExecutionLease(input.runDir, () => publishGithubWorkflowStatusOwned(guarded, result));
  return { ...published, manifest: await readManifestV2(input.runDir) };
}

async function runGithubWorkflowOwned(input: RunGithubWorkflowInput): Promise<LocalWorkflowResult> {
  const entry = await readRuntimeEntryManifest(input.runDir);
  await controllerProvenance.assertCurrentControllerMatches(input.runDir, entry.manifest);
  if (entry.authorityBlocker !== null) return runtimeAuthorityStop(entry.manifest, entry.authorityBlocker);
  if (input.intake.mode !== "github") throw new Error("GitHub runtime requires intake.mode=github");
  if (!input.worktreePath.trim()) throw new Error("A GitHub worktree path is required");
  const boundPaths = await bindGithubRuntimePaths(input);
  input = {
    ...input,
    ...boundPaths,
    intake: { ...input.intake, repo_root: boundPaths.repoRoot },
  };
  const initialManifest = await readManifestV2(input.runDir);
  if (initialManifest.run_id !== basename(input.runDir)) {
    throw new Error("Run manifest is not bound to its current run directory");
  }
  await assertPersistedGithubExecutionIdentity(input, initialManifest);
  if (initialManifest.terminal !== null && initialManifest.terminal.outcome !== "delivered") {
    throw new Error(`Cannot execute run with terminal outcome ${initialManifest.terminal.outcome}`);
  }
  let orderedWorkItems: WorkItem[] = [];
  const finish = async (candidate: LocalWorkflowResult): Promise<LocalWorkflowResult> => {
    if (candidate.status === "awaiting_github_effects") return candidate;
    let assuranceAssessment: AssuranceAssessment | undefined;
    if (candidate.status === "github_ready") {
      const beforeAssurance = await readManifestV2(input.runDir);
      requirePersistedPullRequestMappingBeforeRemoteSynchronization(beforeAssurance);
      await requireIntegratedCommitBeforeRemoteSynchronization(input, beforeAssurance);
      const persistAssurance = input.dependencies.persistFinalDeliveryAssessmentAtBoundary ?? persistFinalDeliveryAssessmentAtBoundary;
      const assessment = beforeAssurance.terminal === null
        ? await persistAssurance(input.runDir)
        : beforeAssurance.assurance_assessment_path === null
          ? null
          : await readOptionalValidatedArtifact(input.runDir, beforeAssurance.assurance_assessment_path, assuranceAssessmentSchema);
      const afterAssurance = await readManifestV2(input.runDir);
      const persistedAssessment = afterAssurance.assurance_assessment_path === null
        ? null
        : await readOptionalValidatedArtifact(input.runDir, afterAssurance.assurance_assessment_path, assuranceAssessmentSchema);
      const assessmentIsDurable = assessment !== null && persistedAssessment !== null
        && JSON.stringify(persistedAssessment) === JSON.stringify(assessment)
        && afterAssurance.assurance_outcome === assessment.outcome;
      if (!assessmentIsDurable || assessment === null || (assessment.outcome !== "verified_ready" && assessment.outcome !== "human_accepted")) {
        const blocker = assessment?.blocker ?? "Final-delivery assurance was not reached";
        candidate = {
          ...candidate,
          status: "human_action_required",
          blocker,
          manifest: await updateManifestV2(input.runDir, { delivery_state: "blocked", last_blocker: blocker }),
        };
      } else {
        assuranceAssessment = assessment;
        await replayGitHubStatusIntents({
          runDir: input.runDir,
          github: input.dependencies.github,
          manifest: afterAssurance,
          plan: input.plan,
          publishIntegratedDelivery: true,
        });
      }
    }
    let published = await publishGithubWorkflowStatus({ ...input, assuranceAssessment }, candidate);
    if (published.status === "github_ready") {
      if (input.deferTerminalDisposition !== true) {
        published = {
          ...published,
          manifest: await recordRuntimeDeliveryDisposition(input.runDir, "Pull request delivery is ready for human review"),
        };
      }
      await input.progress?.emit({ code: "pull_request_ready", source: "github" });
      await input.progress?.emit({ code: "github_delivery_ready", source: "runtime" });
    }
    await input.progress?.emit({ code: published.status === "human_action_required" ? "worker_blocked" : "worker_completed", source: "runtime" });
    return published;
  };
  let result: LocalWorkflowResult;
  let producingLineageReady = false;
  let issuePreviewPath = false;
  try {
    try {
      input = await bindApprovedRuntimeAuthority(input);
    } catch (error) {
      throw new RuntimeAuthorityError(error);
    }
    const initiallyBoundAuthority = runtimeAuthorityToken(await readManifestV2(input.runDir));
    await input.dependencies?.afterCheckpoint?.("after_initial_runtime_authority_bind");
    const authorityAfterInitialBind = await readManifestV2(input.runDir);
    if (runtimeAuthorityToken(authorityAfterInitialBind) !== initiallyBoundAuthority) {
      return concurrentRuntimeAuthorityHandoff(authorityAfterInitialBind);
    }
    let existingManifest = await readManifestV2(input.runDir);
    requirePersistedPullRequestMappingBeforeRemoteSynchronization(existingManifest);
    await requireIntegratedCommitBeforeRemoteSynchronization(input, existingManifest);
    assertNotAbandoned(existingManifest);
    const approvalStop = await preBootstrapApprovalStop(input as unknown as RunLocalWorkflowInput);
    if (approvalStop !== null) {
      await input.progress?.emit({ code: "worker_started", source: "runtime" });
      if (approvalStop.initial || approvalStop.concurrentPromotion) {
        await input.progress?.emit({ code: "worker_blocked", source: "runtime" });
        return approvalStop.result;
      }
      return finish(approvalStop.result);
    }
    const authorityAfterApprovalCheck = await readManifestV2(input.runDir);
    if (runtimeAuthorityToken(authorityAfterApprovalCheck) !== initiallyBoundAuthority) {
      return concurrentRuntimeAuthorityHandoff(authorityAfterApprovalCheck);
    }
    try {
      input = await bindApprovedRuntimeAuthority(input);
    } catch (error) {
      throw new RuntimeAuthorityError(error);
    }
    await prepareApprovedGithubControllerBootstrap(input);
    const viability = await assertGithubExecutionViable({
      runDir: input.runDir,
      worktreePath: input.worktreePath,
      plan: input.plan,
      config: input.config ?? defaultConfig(),
      github: input.dependencies.github,
      dependencies: input.dependencies.executionViability,
    });
    input = { ...input, plan: viability.plan };
    orderedWorkItems = topologicallySortWorkItems(viability.plan.work_items);
    const binding = await ensureProducingTaskLineage({ runDir: input.runDir, repository: viability.repository });
    existingManifest = binding.manifest;
    producingLineageReady = true;
    issuePreviewPath = existingManifest.stage === "awaiting_plan_approval"
      || existingManifest.stage === "worktree_setup"
      || existingManifest.stage === "awaiting_github_issue_effects";
    const pendingReplanTarget = resolvePendingReplanTarget(existingManifest);
    if (pendingReplanTarget !== null) {
      result = {
        status: "human_action_required",
        manifest: existingManifest,
        orderedWorkItems,
        implementationResults: {},
        verification: {},
        reviews: {},
        blocker: existingManifest.last_blocker ?? `Replan patch for ${existingManifest.current_work_item_id} requires explicit approval`,
      };
      return issuePreviewPath ? result : finish(result);
    }
    orderedWorkItems = topologicallySortWorkItems(input.plan.work_items);
    await verifyApprovedCheckout(input);
    await input.progress?.emit({ code: "worker_started", source: "runtime" });
    assertApprovedCurrentPlanRevision(existingManifest);
    if (existingManifest.stage === "awaiting_plan_approval") {
      existingManifest = await transitionRun(input.runDir, "worktree_setup", {
        actor: "runtime",
        payload: { work_items: orderedWorkItems.map((item) => item.id) },
      });
    }
    if (existingManifest.stage === "worktree_setup") {
      result = await previewGithubIssues(
        input,
        orderedWorkItems,
        existingManifest,
        binding.lineage,
        viability.repository,
      );
      return result;
    }
    if (existingManifest.stage === "awaiting_github_issue_effects") {
      const boundary = await applyGithubIssuePreview(
        input,
        orderedWorkItems,
        existingManifest,
        binding.lineage,
        viability.repository,
      );
      if (boundary !== null) return boundary;
      existingManifest = await readManifestV2(input.runDir);
    }
    existingManifest = await restoreLegacyProducingStage(input.runDir, existingManifest);
    if (existingManifest.stage === "awaiting_github_delivery_effects") {
      const reference = existingManifest.github_effects.pull_request_delivery;
      if (reference === null || existingManifest.task_lineage_id === null) throw new Error("GitHub delivery boundary is missing its immutable preview reference");
      const lineage = await withTaskLineageTransaction({
        repoRoot: input.repoRoot, lineageId: existingManifest.task_lineage_id, operation: (transaction) => transaction.read(),
      });
      const preview = await readVerifiedGithubEffectPreview({
        run_dir: input.runDir, reference,
        expected: { phase: "pull_request_delivery", lineage_id: lineage.lineage_id, run_id: existingManifest.run_id,
          plan_revision: reference.plan_revision, plan_sha256: reference.plan_sha256 },
      });
      const observedPlanning = await buildDeliveryPlanningInput(
        input, existingManifest, lineage, orderedWorkItems, preview.revision, preview.created_at,
      );
      const applied = await applyDeliveryEffectPreview({
        runDir: input.runDir, repoRoot: input.repoRoot, worktreePath: input.worktreePath,
        remote: input.remote, preview,
        planning: {
          lineage_id: observedPlanning.lineage_id, run_id: observedPlanning.run_id, repository: observedPlanning.repository,
          plan_revision: observedPlanning.plan_revision, plan_sha256: observedPlanning.plan_sha256,
          lineage_state: observedPlanning.lineage_state,
          authorized_prior_head_sha: observedPlanning.authorized_prior_head_sha,
          branch: {
            branch_name: observedPlanning.branch.branch_name, head_sha: observedPlanning.branch.head_sha,
            reason_code: observedPlanning.branch.reason_code,
          },
          pull_request: { desired: observedPlanning.pull_request.desired },
        },
        localHead: () => (input.dependencies.localHeadSha ?? resolveLocalHeadSha)(input.worktreePath),
        remoteHead: () => (input.dependencies.remoteBranchSha ?? resolveRemoteBranchSha)(input.worktreePath, input.branchName, input.remote ?? "origin"),
        observePullRequests: async () => allSettledOrThrow((await input.dependencies.github.findPullRequestsByLineage!(lineage.lineage_id)).map(async (candidate) => {
          const hydrated = deliveryPullRequestObservation(verifiedPullRequestReference(
            await input.dependencies.github.getPullRequest!(candidate.number),
            `GitHub pull request #${candidate.number}`,
          ));
          if (hydrated.number !== candidate.number || hydrated.url !== candidate.url) throw new Error(`Hydrated pull request #${candidate.number} conflicts with lineage lookup`);
          return hydrated;
        })),
        pushCommitToBranch: input.dependencies.pushCommit ?? pushCommitToBranch,
        openPullRequest: async (desired) => normalizePullRequestReference(await openIntegratedPullRequestThroughDeliveryGateway(input.dependencies.github, {
          lineageId: lineage.lineage_id, runId: existingManifest.run_id, title: desired.title, summary: input.plan.summary,
          head: desired.head_ref, headSha: desired.head_sha, base: desired.base_ref,
          workItems: orderedWorkItems.map((item) => ({ id: item.id, issueNumber: existingManifest.work_item_issue_map[item.id]! })),
          ...(lineage.issue_set.parent_issue_number === null ? {} : { parentIssueNumber: lineage.issue_set.parent_issue_number }),
        })),
        updatePullRequestBody: (number, body) => input.dependencies.github.updatePullRequestBody!(number, body),
        getPullRequest: async (number) => deliveryPullRequestObservation(verifiedPullRequestReference(
          await input.dependencies.github.getPullRequest!(number),
          `GitHub pull request #${number}`,
        )),
        afterLineageReady: input.dependencies.afterDeliveryLineageReady,
      });
      if (applied.outcome === "replacement_preview") {
        return { status: "awaiting_github_effects", manifest: await readManifestV2(input.runDir), orderedWorkItems, implementationResults: {}, verification: {}, reviews: {} };
      }
      await input.progress?.emit({ code: "branch_pushed", source: "github" });
      const githubMapPath = "github-map.json";
      const mirrored = await readManifestV2(input.runDir);
      await writeTextArtifact(input.runDir, githubMapPath, `${JSON.stringify({
        run_id: mirrored.run_id, parent_issue_number: lineage.issue_set.parent_issue_number,
        work_item_issue_map: mirrored.work_item_issue_map,
        issues: orderedWorkItems.map((item) => ({ work_item_id: item.id, issue_number: mirrored.work_item_issue_map[item.id] })),
        pull_request: applied.pull_request,
      }, null, 2)}\n`);
      existingManifest = await updateManifestV2(input.runDir, { final_artifact_paths: [...new Set([...mirrored.final_artifact_paths, githubMapPath])] });
      const integratedProgress = existingManifest.work_item_progress.integrated;
      existingManifest = await setProgress(input.runDir, "integrated", {
        ...(integratedProgress ?? { status: "in_progress", attempts: 0 }),
        status: "in_progress",
        attempts: (integratedProgress?.attempts ?? 0) + 1,
        verification_path: undefined,
        verification_scope: undefined,
        verification_work_item_id: undefined,
        verification_issue_number: undefined,
        review_path: undefined,
        candidate_recheck: undefined,
        delivery_phase: "post_pr",
        integrated_pr: applied.pull_request.number,
      }, [githubMapPath]);
      existingManifest = await transitionRun(input.runDir, "final_verification", {
        actor: "runtime", payload: {
          work_item_id: "integrated", final: true,
          pass: existingManifest.work_item_progress.integrated?.attempts ?? 1,
          pull_request_number: applied.pull_request.number, delivery_boundary_applied: true,
        },
      });
      await appendRunEvent(input.runDir, { actor: "runtime", stage: "final_verification", type: "pull_request_pending",
        payload: { pull_request_number: applied.pull_request.number, pull_request_url: applied.pull_request.url, head: input.branchName } });
    }
    if (existingManifest.stage === "delivery" || existingManifest.stage === "complete") {
      const mapping = requirePersistedPullRequestMapping(existingManifest);
      const number = mapping.number;
      if (!Number.isInteger(number) || number < 1) throw new Error("Persisted pull request number is invalid");
      if (mapping.number !== number) throw new Error("Persisted pull request mapping conflicts with the manifest pull_request_numbers projection");
      const persistedUrl = mapping.url;
      const recovered = await openOrRecoverIntegratedPullRequest(
        input,
        orderedWorkItems,
        mappedIssueNumbers(existingManifest, orderedWorkItems),
        number,
        persistedUrl,
        existingManifest.github_ids.parent_issue_number ?? undefined,
      );
      await input.dependencies?.afterCheckpoint?.("before_remote_synchronization");
      await recordRuntimeRemoteSynchronization(input, recovered);
      await replayGitHubStatusIntents({ runDir: input.runDir, github: input.dependencies.github, manifest: existingManifest, plan: input.plan });
      const readyManifest = existingManifest.delivery_state === "ready" && existingManifest.last_blocker === null
        ? existingManifest
        : await updateManifestV2(input.runDir, { delivery_state: "ready", last_blocker: null });
      result = { status: "github_ready", manifest: readyManifest, orderedWorkItems, implementationResults: {}, verification: {}, reviews: {}, pullRequest: recovered };
      return finish(result);
    }
    const resumableAfterIssueSync = new Set<RunManifestV2["stage"]>([
      "implementing",
      "verifying",
      "verifier_review",
      "fixing",
      "replanning",
      "final_verification",
    ]);
    if (!resumableAfterIssueSync.has(existingManifest.stage)) {
      await input.progress?.emit({ code: "github_sync", source: "github" });
      await syncGithubIssues(input, orderedWorkItems);
    }
    await replayGitHubStatusIntents({ runDir: input.runDir, github: input.dependencies.github, manifest: await readManifestV2(input.runDir), plan: input.plan });
    const runtimeInput = {
      ...input,
      dependencies: input.dependencies,
      githubDelivery: input,
    } as unknown as RunLocalWorkflowInput & { githubDelivery: RunGithubWorkflowInput };
    result = await runLocalWorkflowUnsafe(runtimeInput);
  } catch (error) {
    if (error instanceof RuntimeAuthorityError) {
      return {
        status: "human_action_required",
        manifest: await readManifestV2(input.runDir),
        orderedWorkItems: [],
        implementationResults: {},
        verification: {},
        reviews: {},
        blocker: error.message,
      };
    }
    if (error instanceof ConcurrentPlanPromotionHandoff) {
      await input.progress?.emit({ code: "worker_blocked", source: "runtime" });
      return error.result;
    }
    const approvalStop = await postErrorApprovalStop(input as unknown as RunLocalWorkflowInput, error).catch(() => null);
    if (approvalStop !== null) {
      if (approvalStop.initial || approvalStop.concurrentPromotion) {
        await input.progress?.emit({ code: "worker_blocked", source: "runtime" });
        return approvalStop.result;
      }
      return finish(approvalStop.result);
    }
    const blocker = `GitHub runtime failed: ${errorMessage(error)}`;
    try {
      const manifest = await updateManifestV2(input.runDir, { delivery_state: "blocked", last_blocker: blocker });
      result = { status: "human_action_required", manifest, orderedWorkItems, implementationResults: {}, verification: {}, reviews: {}, blocker };
      return issuePreviewPath ? result : finish(result);
    } catch {
      throw error;
    }
  }
  return producingLineageReady && !issuePreviewPath ? finish(result) : result;
}

export async function runLocalWorkflow(input: RunLocalWorkflowInput): Promise<LocalWorkflowResult> {
  const entry = await readRuntimeEntryManifest(input.runDir);
  if (entry.authorityBlocker !== null) return runtimeAuthorityStop(entry.manifest, entry.authorityBlocker);
  const manifest = entry.manifest;
  await controllerProvenance.assertCurrentControllerMatches(input.runDir, manifest);
  if (manifest.approved_revision === null) {
    return runLocalWorkflowOwned(input);
  }
  await pinHistoricalCheckoutIfRequired(input);
  let bound: RunLocalWorkflowInput;
  try {
    bound = await bindApprovedRuntimeAuthority(input);
  } catch (error) {
    return runtimeAuthorityStop(await readManifestV2(input.runDir), new RuntimeAuthorityError(error).message);
  }
  try {
    return await withRunExecutionLease(input.runDir, () => runLocalWorkflowOwned(guardRuntimeEffects(bound)));
  } catch (error) {
    const approvalStop = await postErrorApprovalStop(input, error).catch(() => null);
    if (approvalStop !== null) return approvalStop.result;
    throw error;
  }
}

export async function runGithubWorkflow(input: RunGithubWorkflowInput): Promise<LocalWorkflowResult> {
  const entry = await readRuntimeEntryManifest(input.runDir);
  if (entry.authorityBlocker !== null) return runtimeAuthorityStop(entry.manifest, entry.authorityBlocker);
  const manifest = entry.manifest;
  await controllerProvenance.assertCurrentControllerMatches(input.runDir, manifest);
  if (manifest.approved_revision === null) {
    return runGithubWorkflowOwned(input);
  }
  try {
    requirePersistedPullRequestMappingBeforeRemoteSynchronization(manifest);
    await requireIntegratedCommitBeforeRemoteSynchronization(input, manifest);
  } catch (error) {
    const blocker = `GitHub runtime failed: ${errorMessage(error)}`;
    const blocked = await updateManifestV2(input.runDir, { delivery_state: "blocked", last_blocker: blocker });
    return {
      status: "human_action_required",
      manifest: blocked,
      orderedWorkItems: [],
      implementationResults: {},
      verification: {},
      reviews: {},
      blocker,
    };
  }
  await pinHistoricalCheckoutIfRequired(input);
  let bound: RunGithubWorkflowInput;
  try {
    bound = await bindApprovedRuntimeAuthority(input);
  } catch (error) {
    return runtimeAuthorityStop(await readManifestV2(input.runDir), new RuntimeAuthorityError(error).message);
  }
  try {
    return await withRunExecutionLease(input.runDir, () => runGithubWorkflowOwned(guardRuntimeEffects(bound)));
  } catch (error) {
    const approvalStop = await postErrorApprovalStop(input as unknown as RunLocalWorkflowInput, error).catch(() => null);
    if (approvalStop !== null) return approvalStop.result;
    throw error;
  }
}

export async function runWorkflow(input: RunLocalWorkflowInput | RunGithubWorkflowInput): Promise<LocalWorkflowResult> {
  const manifest = await readManifestV2(input.runDir);
  await controllerProvenance.assertCurrentControllerMatches(input.runDir, manifest);
  return manifest.mode === "github"
    ? runGithubWorkflow(input as RunGithubWorkflowInput)
    : runLocalWorkflow(input as RunLocalWorkflowInput);
}

export const executeLocalWorkflow = runLocalWorkflow;
export const runLocal = runLocalWorkflow;
export const executeGithubWorkflow = runGithubWorkflow;
