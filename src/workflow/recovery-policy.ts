import { createHash } from "node:crypto";
import type {
  RecoveryScopeStateV1,
  ReviewPolicyAction,
  RunStageV2,
} from "../core/types.js";
import {
  recoveryScopeStateV1Schema,
  runStageV2Schema,
} from "../core/schema.js";

export type RecoveryFailureClass =
  | "implementation_failure"
  | "invocation_failure"
  | "model_failure"
  | "operational_blocker"
  | "test_infrastructure_blocker";

export type RecoveryRequestedEffect = ReviewPolicyAction | "retry_operation";

export interface RecoveryProgressSubjectV1 {
  version: 1;
  approved_plan_sha256: string | null;
  candidate_commit: string | null;
  implementation_artifact_sha256: string | null;
  verification_artifact_sha256: string | null;
  review_artifact_sha256: string | null;
  review_revision: number | null;
  finding_ids: string[];
}

export interface RecoveryBlockerSubjectV1 {
  version: 1;
  scope_id: string;
  stage: RunStageV2;
  operation: string;
  failure_class: RecoveryFailureClass;
  blocker_code: string;
  finding_ids: string[];
}

export interface RecoveryObservationV1 extends RecoveryBlockerSubjectV1 {
  run_id: string;
  effect_attempt_id: string;
  blocker_fingerprint: string;
  progress_subject_sha256: string;
}

export type RecoveryGuardAction =
  | "allow_next_effect"
  | "await_external_fix"
  | "diagnostic_stop"
  | "exhausted_stop";

export interface RecoveryGuardDecision {
  action: RecoveryGuardAction;
  next: RecoveryScopeStateV1;
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const RECOVERY_FAILURE_CLASSES: Readonly<Record<RecoveryFailureClass, true>> = {
  implementation_failure: true,
  invocation_failure: true,
  model_failure: true,
  operational_blocker: true,
  test_infrastructure_blocker: true,
};
const RECOVERY_REQUESTED_EFFECTS: Readonly<Record<RecoveryRequestedEffect, true>> = {
  advance: true,
  fix: true,
  quality_recovery: true,
  create_replan: true,
  await_plan_approval: true,
  continue_with_warning: true,
  stop: true,
  retry_operation: true,
};
const EXTERNAL_FAILURES = new Set<RecoveryFailureClass>([
  "invocation_failure",
  "model_failure",
  "operational_blocker",
  "test_infrastructure_blocker",
]);

export function blockerFingerprint(
  input: RecoveryBlockerSubjectV1,
): string {
  assertRecord(input, "Recovery blocker subject");
  assertVersionOne(input.version);
  assertNonblank(input.scope_id, "scope ID");
  assertRunStage(input.stage);
  assertNonblank(input.operation, "operation");
  assertFailureClass(input.failure_class);
  assertNonblank(input.blocker_code, "blocker code");
  assertFindingIds(input.finding_ids);

  return sha256({
    version: 1,
    scope_id: input.scope_id,
    stage: input.stage,
    operation: input.operation,
    failure_class: input.failure_class,
    blocker_code: input.blocker_code,
    finding_ids: [...input.finding_ids].sort(),
  });
}

export function progressSubjectSha256(
  input: RecoveryProgressSubjectV1,
): string {
  assertRecord(input, "Recovery progress subject");
  assertVersionOne(input.version);
  assertOptionalSha256(input.approved_plan_sha256, "approved plan SHA-256");
  if (input.candidate_commit !== null) {
    assertNonblank(input.candidate_commit, "candidate commit identifier");
  }
  assertOptionalSha256(
    input.implementation_artifact_sha256,
    "implementation artifact SHA-256",
  );
  assertOptionalSha256(
    input.verification_artifact_sha256,
    "verification artifact SHA-256",
  );
  assertOptionalSha256(input.review_artifact_sha256, "review artifact SHA-256");
  if (
    input.review_revision !== null
    && (!Number.isInteger(input.review_revision) || input.review_revision < 0)
  ) {
    throw new Error("Review revision must be a non-negative integer or null");
  }
  assertFindingIds(input.finding_ids);

  return sha256({
    version: 1,
    approved_plan_sha256: input.approved_plan_sha256,
    candidate_commit: input.candidate_commit,
    implementation_artifact_sha256: input.implementation_artifact_sha256,
    verification_artifact_sha256: input.verification_artifact_sha256,
    review_artifact_sha256: input.review_artifact_sha256,
    review_revision: input.review_revision,
    finding_ids: [...input.finding_ids].sort(),
  });
}

export function recoveryScopePathComponent(scopeId: string): string {
  assertNonblank(scopeId, "scope ID");
  return sha256({
    domain: "brain-hands/recovery-scope-path-component",
    version: 1,
    scope_id: scopeId,
  });
}

export function evaluateRecoveryGuard(input: {
  previous: RecoveryScopeStateV1 | undefined;
  observation: RecoveryObservationV1;
  requestedEffect: RecoveryRequestedEffect;
  requestedEffectReason: string;
}): RecoveryGuardDecision {
  assertRecord(input, "Recovery guard input");
  assertNonblank(input.requestedEffectReason, "requested effect reason");
  assertRequestedEffect(input.requestedEffect);
  assertObservation(input.observation);

  if (
    input.requestedEffect === "stop"
    && input.requestedEffectReason !== "fix_limit_reached"
  ) {
    throw new Error("Recovery guard supports only exhausted fix-limit stops");
  }

  const previous = input.previous === undefined
    ? initialScopeState()
    : recoveryScopeStateV1Schema.parse(input.previous);
  if (previous.disposition === "diagnostic_stop") {
    throw new Error("Diagnostic-stop recovery requires an authorized state transition");
  }
  if (previous.disposition === "exhausted") {
    throw new Error("Exhausted recovery state cannot transition directly");
  }
  const nextHeadSequence = safeIntegerSuccessor(
    previous.head_sequence,
    "Recovery journal sequence",
  );
  const repeated = previous.blocker_fingerprint === input.observation.blocker_fingerprint
    && previous.progress_subject_sha256 === input.observation.progress_subject_sha256;
  const consecutiveWithoutProgress = repeated
    ? safeIntegerSuccessor(
      previous.consecutive_without_progress,
      "Recovery repetition counter",
    )
    : 1;
  const next: RecoveryScopeStateV1 = {
    ...previous,
    blocker_fingerprint: input.observation.blocker_fingerprint,
    progress_subject_sha256: input.observation.progress_subject_sha256,
    consecutive_without_progress: consecutiveWithoutProgress,
  };

  if (input.requestedEffect === "stop") {
    return {
      action: "exhausted_stop",
      next: { ...next, disposition: "exhausted" },
    };
  }
  if (repeated) {
    return {
      action: "diagnostic_stop",
      next: {
        ...next,
        disposition: "diagnostic_stop",
        diagnostic_path: diagnosticPath(
          input.observation.scope_id,
          nextHeadSequence,
        ),
      },
    };
  }
  if (EXTERNAL_FAILURES.has(input.observation.failure_class)) {
    return {
      action: "await_external_fix",
      next: { ...next, disposition: "awaiting_external_fix" },
    };
  }
  return {
    action: "allow_next_effect",
    next: { ...next, disposition: "active" },
  };
}

function initialScopeState(): RecoveryScopeStateV1 {
  return {
    version: 1,
    head_sequence: 0,
    head_decision_path: null,
    blocker_fingerprint: null,
    progress_subject_sha256: null,
    consecutive_without_progress: 0,
    disposition: "active",
    diagnostic_path: null,
    authorization_path: null,
  };
}

function assertObservation(observation: RecoveryObservationV1): void {
  assertRecord(observation, "Recovery observation");
  assertNonblank(observation.run_id, "run identifier");
  assertNonblank(observation.effect_attempt_id, "effect attempt identifier");
  assertSha256(observation.blocker_fingerprint, "blocker fingerprint SHA-256");
  assertSha256(observation.progress_subject_sha256, "progress subject SHA-256");
  if (blockerFingerprint(observation) !== observation.blocker_fingerprint) {
    throw new Error("Observation blocker fingerprint does not match its subject");
  }
}

function assertVersionOne(version: unknown): void {
  if (version !== 1) {
    throw new Error("Recovery fingerprint subject version must be 1");
  }
}

function assertFindingIds(findingIds: unknown): asserts findingIds is string[] {
  if (!Array.isArray(findingIds)) {
    throw new Error("Finding identifiers must be an array");
  }
  const seen = new Set<string>();
  for (let index = 0; index < findingIds.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(findingIds, index)) {
      throw new Error("Finding identifiers must be a dense array");
    }
    const findingId = findingIds[index];
    assertNonblank(findingId, "finding identifier");
    if (seen.has(findingId)) {
      throw new Error("Finding identifiers must be unique");
    }
    seen.add(findingId);
  }
}

function assertNonblank(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string`);
  }
  if (value.trim().length === 0) {
    throw new Error(`${label} must not be blank`);
  }
}

function assertOptionalSha256(value: unknown, label: string): asserts value is string | null {
  if (value !== null) {
    assertSha256(value, label);
  }
}

function assertSha256(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new Error(`${label} must be 64 lowercase hexadecimal characters`);
  }
}

function sha256(value: object): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function safeIntegerSuccessor(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value >= Number.MAX_SAFE_INTEGER) {
    throw new Error(`${label} successor must be a safe integer`);
  }
  return value + 1;
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function assertRunStage(value: unknown): asserts value is RunStageV2 {
  if (!runStageV2Schema.safeParse(value).success) {
    throw new Error("Unsupported recovery stage");
  }
}

function assertFailureClass(value: unknown): asserts value is RecoveryFailureClass {
  if (
    typeof value !== "string"
    || !Object.prototype.hasOwnProperty.call(RECOVERY_FAILURE_CLASSES, value)
  ) {
    throw new Error("Unsupported recovery failure class");
  }
}

function assertRequestedEffect(value: unknown): asserts value is RecoveryRequestedEffect {
  if (
    typeof value !== "string"
    || !Object.prototype.hasOwnProperty.call(RECOVERY_REQUESTED_EFFECTS, value)
  ) {
    throw new Error("Unsupported recovery requested effect");
  }
}

function diagnosticPath(scopeId: string, sequence: number): string {
  const scope = recoveryScopePathComponent(scopeId);
  return `recovery/scopes/${scope}/diagnostics/${String(sequence).padStart(6, "0")}.json`;
}
