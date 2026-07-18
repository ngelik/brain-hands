import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type {
  DiagnosticRecoveryAuthorizationV1,
  DiagnosticRecoveryConsumptionV1,
  RecoveryDecisionArtifactV1,
  RecoveryDiagnosticArtifactV1,
  RecoveryDiagnosticClassificationV1,
  RecoveryOwnedEvidenceRefsV1,
  ReviewPhase,
  ReviewPolicyDecision,
  RecoveryScopeStateV1,
  RunEvent,
  RunManifestV2,
} from "../core/types.js";
import {
  diagnosticRecoveryAuthorizationV1Schema,
  diagnosticRecoveryConsumptionV1Schema,
  implementationResultSchema,
  persistedVerifierReviewSchema,
  recoveryProgressSubjectV1Schema,
  recoveryGuardActionSchema,
  recoveryObservationV1Schema,
  recoveryAuthorizationNoteSchema,
  recoveryRequestedEffectSchema,
  recoveryScopeIdSchema,
  recoveryScopeStateV1Schema,
  reviewAccountingSchema,
  reviewCycleStateSchema,
  reviewPolicyDecisionSchema,
  runEventSchema,
  runManifestV2Schema,
  safeEvidenceRefSchema,
  verificationEvidenceSchema,
} from "../core/schema.js";
import {
  appendRunEventOnce,
  readOptionalValidatedArtifact,
  type RunLedgerTransaction,
  withRunLedgerCompoundTransaction,
  writeCreateOnceValidated,
} from "../core/ledger.js";
import { readOwnedEvidenceFile, readOwnedRunFile } from "../core/owned-evidence.js";
import {
  evaluateRecoveryGuard,
  progressSubjectSha256,
  recoveryScopePathComponent,
  type RecoveryObservationV1,
  type RecoveryRequestedEffect,
} from "./recovery-policy.js";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const DECISION_FILE_PATTERN = /^(\d+)-([a-f0-9]{64})\.json$/;
const SCOPE_COMPONENT_PATTERN = /^[a-f0-9]{64}$/;
const AUTHORIZATION_FILE_PATTERN = /^(diagnostic-authorization:[a-f0-9]{64})(-consumed)?\.json$/;
const DIAGNOSTIC_FILE_PATTERN = /^(\d{6})\.json$/;
const SUPPORTED_SCOPE_DIRECTORIES = new Set([
  "decisions",
  "diagnostics",
  "authorizations",
]);

function ownRecoveryScopeState(
  scopes: RunManifestV2["recovery"]["scopes"],
  scopeId: string,
): RunManifestV2["recovery"]["scopes"][string] | undefined {
  return Object.prototype.hasOwnProperty.call(scopes, scopeId)
    ? scopes[scopeId]
    : undefined;
}

export type {
  DiagnosticRecoveryAuthorizationV1,
  DiagnosticRecoveryConsumptionV1,
  RecoveryDecisionArtifactV1,
  RecoveryDiagnosticArtifactV1,
} from "../core/types.js";

export type DiagnosticRecoveryArtifactV1 = RecoveryDiagnosticArtifactV1;

export interface RecoveryLedgerHooks {
  afterDecisionArtifact?: () => Promise<void>;
  afterDiagnosticArtifact?: () => Promise<void>;
  afterDecisionEvent?: () => Promise<void>;
  afterManifestProjection?: () => Promise<void>;
  afterAuthorizationArtifact?: () => Promise<void>;
  afterConsumptionArtifact?: () => Promise<void>;
  afterAuthorizationEntriesRead?: (directoryPath: string) => Promise<void>;
  afterDiagnosticEntriesRead?: (directoryPath: string) => Promise<void>;
}

export interface RecoveryDiagnosticContext {
  classification: RecoveryDiagnosticClassificationV1;
  policy_decision: ReviewPolicyDecision | null;
  owned_evidence_refs: RecoveryOwnedEvidenceRefsV1;
  progress: RecoveryDiagnosticArtifactV1["progress"];
}

export interface AuthorizedRecoverySubjectV1 {
  run_id: string;
  scope_id: string;
  stage: RecoveryObservationV1["stage"];
  operation: string;
  failure_class: RecoveryObservationV1["failure_class"];
  blocker_code: string;
  finding_ids: string[];
  requested_effect: RecoveryRequestedEffect;
  requested_effect_reason: string;
  progress_subject_sha256: string;
}

function authorizedRecoverySubject(
  decision: RecoveryDecisionArtifactV1,
): AuthorizedRecoverySubjectV1 {
  return {
    run_id: decision.observation.run_id,
    scope_id: decision.observation.scope_id,
    stage: decision.observation.stage,
    operation: decision.observation.operation,
    failure_class: decision.observation.failure_class,
    blocker_code: decision.observation.blocker_code,
    finding_ids: [...decision.observation.finding_ids].sort(),
    requested_effect: decision.requested_effect,
    requested_effect_reason: decision.requested_effect_reason,
    progress_subject_sha256: decision.observation.progress_subject_sha256,
  };
}

function assertExactAuthorizedSubject(
  expected: AuthorizedRecoverySubjectV1,
  decision: RecoveryDecisionArtifactV1,
  allowChangedProgress: boolean,
): void {
  const actual = authorizedRecoverySubject(decision);
  const normalizedExpected = {
    ...expected,
    finding_ids: [...expected.finding_ids].sort(),
    ...(allowChangedProgress
      ? { progress_subject_sha256: actual.progress_subject_sha256 }
      : {}),
  };
  if (!exactEqual(normalizedExpected, actual)) {
    throw new Error("Recovery attempt does not match the exact authorized operation subject");
  }
}

export const diagnosticRecoveryArtifactV1Schema = z.object({
  version: z.literal(1),
  run_id: z.string().refine((value) => value.trim().length > 0),
  scope_id: recoveryScopeIdSchema,
  journal_sequence: z.number().int().positive().refine(Number.isSafeInteger),
  decision_path: safeEvidenceRefSchema,
  guard_action: z.enum(["diagnostic_stop", "exhausted_stop"]),
  previous_observation: recoveryObservationV1Schema.nullable(),
  current_observation: recoveryObservationV1Schema,
  requested_effect: recoveryRequestedEffectSchema,
  requested_effect_reason: z.string().refine((value) => value.trim().length > 0),
  classification: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("review_policy"),
      review_cycle_path: safeEvidenceRefSchema,
      effect_id: z.string().regex(/^review-effect:[a-f0-9]{64}$/),
    }).strict(),
    z.object({
      kind: z.literal("operational"),
      failure_class: z.enum([
        "implementation_failure",
        "invocation_failure",
        "model_failure",
        "operational_blocker",
        "test_infrastructure_blocker",
      ]),
      blocker_code: z.string().refine((value) => value.trim().length > 0),
    }).strict(),
  ]),
  policy_decision: reviewPolicyDecisionSchema.nullable(),
  review_accounting: reviewAccountingSchema.nullable(),
  quality_recovery_usage: z.object({
    work_item_id: z.string().refine((value) => value.trim().length > 0),
    active_hands_profile: z.enum(["primary", "backup"]),
    attempts_used: z.union([z.literal(0), z.literal(1)]),
  }).strict().nullable(),
  owned_evidence_refs: z.object({
    implementation_path: safeEvidenceRefSchema.nullable(),
    verification_path: safeEvidenceRefSchema.nullable(),
    review_path: safeEvidenceRefSchema.nullable(),
  }).strict(),
  progress: z.object({
    subject: recoveryProgressSubjectV1Schema,
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict(),
  recorded_at: z.string().datetime(),
}).strict().superRefine((artifact, context) => {
  if (
    artifact.current_observation.run_id !== artifact.run_id
    || artifact.current_observation.scope_id !== artifact.scope_id
  ) {
    context.addIssue({
      code: "custom",
      path: ["current_observation"],
      message: "Diagnostic current observation must match its run and scope",
    });
  }
  if ((artifact.classification.kind === "review_policy") !== (artifact.policy_decision !== null)) {
    context.addIssue({
      code: "custom",
      path: ["classification"],
      message: "Diagnostic policy classification and decision must be paired",
    });
  }
  if (
    artifact.classification.kind === "review_policy"
      ? artifact.review_accounting === null || artifact.quality_recovery_usage === null
      : artifact.review_accounting !== null || artifact.quality_recovery_usage !== null
  ) {
    context.addIssue({
      code: "custom",
      path: ["classification"],
      message: "Diagnostic authority snapshots must match the diagnostic classification",
    });
  }
  if (
    artifact.classification.kind === "review_policy"
    && artifact.classification.effect_id !== artifact.current_observation.effect_attempt_id
  ) {
    context.addIssue({
      code: "custom",
      path: ["classification", "effect_id"],
      message: "Diagnostic policy effect must match its observation attempt",
    });
  }
  if (
    artifact.classification.kind === "operational"
    && (
      artifact.classification.failure_class !== artifact.current_observation.failure_class
      || artifact.classification.blocker_code !== artifact.current_observation.blocker_code
    )
  ) {
    context.addIssue({
      code: "custom",
      path: ["classification"],
      message: "Diagnostic operational classification must match its observation",
    });
  }
  if (artifact.previous_observation !== null && (
    artifact.previous_observation.run_id !== artifact.run_id
    || artifact.previous_observation.scope_id !== artifact.scope_id
  )) {
    context.addIssue({
      code: "custom",
      path: ["previous_observation"],
      message: "Diagnostic previous observation must match its run and scope",
    });
  }
  if (
    artifact.policy_decision !== null
    && (
      artifact.policy_decision.action !== artifact.requested_effect
      || artifact.policy_decision.reason_code !== artifact.requested_effect_reason
    )
  ) {
    context.addIssue({
      code: "custom",
      path: ["policy_decision"],
      message: "Diagnostic policy decision must match its requested effect",
    });
  }
  const ownedEvidencePairs = [
    [artifact.owned_evidence_refs.implementation_path, artifact.progress.subject.implementation_artifact_sha256],
    [artifact.owned_evidence_refs.verification_path, artifact.progress.subject.verification_artifact_sha256],
    [artifact.owned_evidence_refs.review_path, artifact.progress.subject.review_artifact_sha256],
  ] as const;
  if (ownedEvidencePairs.some(([path, sha256]) => (path === null) !== (sha256 === null))) {
    context.addIssue({
      code: "custom",
      path: ["owned_evidence_refs"],
      message: "Diagnostic owned evidence references and content hashes must be paired",
    });
  }
}) as z.ZodType<RecoveryDiagnosticArtifactV1>;

export function recoveryDiagnosticPath(scopeId: string, sequence: number): string {
  recoveryScopeIdSchema.parse(scopeId);
  if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence > 999_999) {
    throw new Error("Recovery diagnostic sequence must be between 1 and 999999");
  }
  return `recovery/scopes/${recoveryScopePathComponent(scopeId)}/diagnostics/${String(sequence).padStart(6, "0")}.json`;
}

function assertAuthorizationId(authorizationId: string): void {
  if (!/^diagnostic-authorization:[a-f0-9]{64}$/.test(authorizationId)) {
    throw new Error("Diagnostic recovery authorization identity must be canonical");
  }
}

export function diagnosticRecoveryAuthorizationPath(
  scopeId: string,
  authorizationId: string,
): string {
  recoveryScopeIdSchema.parse(scopeId);
  assertAuthorizationId(authorizationId);
  return `recovery/scopes/${recoveryScopePathComponent(scopeId)}/authorizations/${authorizationId}.json`;
}

export function diagnosticRecoveryConsumptionPath(
  scopeId: string,
  authorizationId: string,
): string {
  recoveryScopeIdSchema.parse(scopeId);
  assertAuthorizationId(authorizationId);
  return `recovery/scopes/${recoveryScopePathComponent(scopeId)}/authorizations/${authorizationId}-consumed.json`;
}

export function recoveryDecisionPath(
  scopeId: string,
  sequence: number,
  observationId: string,
): string {
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new Error("Recovery decision sequence must be a positive safe integer");
  }
  if (!SHA256_PATTERN.test(observationId)) {
    throw new Error("Recovery observation ID must be 64 lowercase hexadecimal characters");
  }
  const scope = recoveryScopePathComponent(scopeId);
  return `recovery/scopes/${scope}/decisions/${String(sequence).padStart(6, "0")}-${observationId}.json`;
}

function recoveryObservationId(observation: RecoveryObservationV1): string {
  return createHash("sha256").update(JSON.stringify({
    domain: "brain-hands/recovery-observation-id",
    version: 1,
    run_id: observation.run_id,
    scope_id: observation.scope_id,
    effect_attempt_id: observation.effect_attempt_id,
  })).digest("hex");
}

function recoveryDecisionEventId(
  observation: RecoveryObservationV1,
  previousDecisionEventId: string | null,
): string {
  return `recovery-decision:${createHash("sha256").update(JSON.stringify({
    domain: "brain-hands/recovery-decision-event",
    version: 1,
    run_id: observation.run_id,
    scope_id: observation.scope_id,
    effect_attempt_id: observation.effect_attempt_id,
    previous_decision_event_id: previousDecisionEventId,
  })).digest("hex")}`;
}

export const recoveryDecisionArtifactV1Schema: z.ZodType<RecoveryDecisionArtifactV1> = z.object({
  version: z.literal(1),
  run_id: z.string().refine((value) => value.trim().length > 0),
  scope_id: recoveryScopeIdSchema,
  sequence: z.number().int().positive().refine(Number.isSafeInteger),
  observation: recoveryObservationV1Schema,
  requested_effect: recoveryRequestedEffectSchema,
  requested_effect_reason: z.string().refine((value) => value.trim().length > 0),
  previous_state: recoveryScopeStateV1Schema.nullable(),
  next_state: recoveryScopeStateV1Schema,
  guard_action: recoveryGuardActionSchema,
  previous_decision_event_id: z.string().regex(/^recovery-decision:[a-f0-9]{64}$/).nullable(),
  decision_event_id: z.string().regex(/^recovery-decision:[a-f0-9]{64}$/),
  diagnostic_intent: diagnosticRecoveryArtifactV1Schema.optional(),
  recorded_at: z.string().datetime(),
}).strict().superRefine((decision, context) => {
  const expectedPath = recoveryDecisionPath(
    decision.scope_id,
    decision.sequence,
    recoveryObservationId(decision.observation),
  );
  if (decision.run_id !== decision.observation.run_id) {
    context.addIssue({ code: "custom", path: ["run_id"], message: "Decision run must match its observation" });
  }
  if (decision.scope_id !== decision.observation.scope_id) {
    context.addIssue({ code: "custom", path: ["scope_id"], message: "Decision scope must match its observation" });
  }
  if (decision.next_state.head_sequence !== decision.sequence) {
    context.addIssue({ code: "custom", path: ["next_state", "head_sequence"], message: "Decision head sequence must match its sequence" });
  }
  if (decision.next_state.head_decision_path !== expectedPath) {
    context.addIssue({ code: "custom", path: ["next_state", "head_decision_path"], message: "Decision head path must match its canonical artifact path" });
  }
  if (decision.decision_event_id !== recoveryDecisionEventId(
    decision.observation,
    decision.previous_decision_event_id,
  )) {
    context.addIssue({ code: "custom", path: ["decision_event_id"], message: "Decision event identity must match its observation" });
  }
  if ((decision.sequence === 1) !== (decision.previous_state === null)) {
    context.addIssue({ code: "custom", path: ["previous_state"], message: "Only the first recovery decision may omit previous state" });
  }
  if (decision.previous_state !== null && decision.previous_state.head_sequence !== decision.sequence - 1) {
    context.addIssue({ code: "custom", path: ["previous_state", "head_sequence"], message: "Previous recovery head must immediately precede the decision" });
  }
  const terminalGuard = decision.guard_action === "diagnostic_stop" || decision.guard_action === "exhausted_stop";
  if (terminalGuard !== (decision.diagnostic_intent !== undefined)) {
    context.addIssue({
      code: "custom",
      path: ["diagnostic_intent"],
      message: terminalGuard
        ? "Terminal recovery decisions require an exact diagnostic intent"
        : "Nonterminal recovery decisions must not contain a diagnostic intent",
    });
  }
  if (decision.diagnostic_intent !== undefined && (
    decision.diagnostic_intent.run_id !== decision.run_id
    || decision.diagnostic_intent.scope_id !== decision.scope_id
    || decision.diagnostic_intent.journal_sequence !== decision.sequence
    || decision.diagnostic_intent.decision_path !== expectedPath
    || decision.diagnostic_intent.guard_action !== decision.guard_action
    || !exactEqual(decision.diagnostic_intent.current_observation, decision.observation)
    || decision.diagnostic_intent.requested_effect !== decision.requested_effect
    || decision.diagnostic_intent.requested_effect_reason !== decision.requested_effect_reason
    || decision.diagnostic_intent.recorded_at !== decision.recorded_at
  )) {
    context.addIssue({
      code: "custom",
      path: ["diagnostic_intent"],
      message: "Recovery diagnostic intent must match its immutable decision",
    });
  }
  try {
    const expectedGuard = evaluateRecoveryGuard({
      previous: decision.previous_state ?? undefined,
      observation: decision.observation,
      requestedEffect: decision.requested_effect,
      requestedEffectReason: decision.requested_effect_reason,
    });
    const expectedNext = {
      ...nextStateAfterAuthorizationConsumption(decision.previous_state, expectedGuard.next),
      head_sequence: decision.sequence,
      head_decision_path: expectedPath,
    };
    if (decision.guard_action !== expectedGuard.action || !exactEqual(decision.next_state, expectedNext)) {
      context.addIssue({ code: "custom", path: ["next_state"], message: "Decision next state must match the recovery guard semantics" });
    }
  } catch (error) {
    context.addIssue({
      code: "custom",
      path: ["next_state"],
      message: `Decision recovery guard semantics are invalid: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
});

interface ScopeJournal {
  decisions: RecoveryDecisionArtifactV1[];
  paths: string[];
  authorizations: BoundAuthorization[];
}

interface BoundAuthorization {
  authorization: DiagnosticRecoveryAuthorizationV1;
  path: string;
  consumption: DiagnosticRecoveryConsumptionV1 | null;
}

interface BoundDecision {
  decision: RecoveryDecisionArtifactV1;
  path: string;
}

interface DirectoryIdentity {
  path: string;
  realPath: string;
  dev: number;
  ino: number;
}

interface DirectoryEntrySnapshot {
  name: string;
  type: "file" | "directory" | "symlink" | "other";
}

function errorCode(error: unknown): unknown {
  return error && typeof error === "object" && "code" in error ? error.code : undefined;
}

function exactEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

interface OwnedFileSnapshot {
  path: string;
  realPath: string;
  dev: number;
  ino: number;
  size: number;
  sha256: string;
}

async function captureOwnedFileSnapshot(
  runDir: string,
  path: string,
  readBytes: () => Promise<Buffer>,
  label: string,
): Promise<{ bytes: Buffer; snapshot: OwnedFileSnapshot }> {
  const absolutePath = join(runDir, path);
  const before = await lstat(absolutePath);
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error(`${label} must be a real file`);
  }
  const realPath = await realpath(absolutePath);
  const bytes = await readBytes();
  const after = await lstat(absolutePath);
  if (
    after.isSymbolicLink()
    || !after.isFile()
    || before.dev !== after.dev
    || before.ino !== after.ino
    || before.size !== after.size
    || realPath !== await realpath(absolutePath)
  ) {
    throw new Error(`${label} identity changed while it was read`);
  }
  return {
    bytes,
    snapshot: {
      path,
      realPath,
      dev: after.dev,
      ino: after.ino,
      size: after.size,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
  };
}

async function assertOwnedFileSnapshot(
  runDir: string,
  expected: OwnedFileSnapshot,
  readBytes: () => Promise<Buffer>,
  label: string,
): Promise<void> {
  const current = await captureOwnedFileSnapshot(runDir, expected.path, readBytes, label);
  if (!exactEqual(current.snapshot, expected)) {
    throw new Error(`${label} bytes or identity changed during journal scan`);
  }
}

async function validateDiagnosticOwnedEvidence(
  runDir: string,
  artifact: DiagnosticRecoveryArtifactV1,
  workItemId: string,
): Promise<Array<{ snapshot: OwnedFileSnapshot; root: string; label: string }>> {
  const ownedEvidence = [
    {
      path: artifact.owned_evidence_refs.implementation_path,
      sha256: artifact.progress.subject.implementation_artifact_sha256,
      root: "implementation/",
      schema: implementationResultSchema,
      label: "implementation",
    },
    {
      path: artifact.owned_evidence_refs.verification_path,
      sha256: artifact.progress.subject.verification_artifact_sha256,
      root: "verification/",
      schema: verificationEvidenceSchema,
      label: "verification",
    },
    {
      path: artifact.owned_evidence_refs.review_path,
      sha256: artifact.progress.subject.review_artifact_sha256,
      root: "reviews/",
      schema: persistedVerifierReviewSchema,
      label: "review",
    },
  ] as const;
  const snapshots: Array<{ snapshot: OwnedFileSnapshot; root: string; label: string }> = [];
  for (const evidence of ownedEvidence) {
    if ((evidence.path === null) !== (evidence.sha256 === null)) {
      throw new Error(`Recovery diagnostic ${evidence.label} reference and content hash must be paired`);
    }
    if (evidence.path === null || evidence.sha256 === null) continue;
    try {
      const captured = await captureOwnedFileSnapshot(
        runDir,
        evidence.path,
        () => readOwnedEvidenceFile(runDir, evidence.path!, evidence.root),
        `Recovery diagnostic ${evidence.label} owned evidence`,
      );
      const value = evidence.schema.parse(JSON.parse(captured.bytes.toString("utf8")));
      if (
        !("work_item_id" in value)
        || value.work_item_id !== workItemId
        || captured.snapshot.sha256 !== evidence.sha256
        || (
          evidence.label === "verification"
          && "evidence_path" in value
          && value.evidence_path !== evidence.path
        )
      ) {
        throw new Error("owned evidence identity does not match its diagnostic binding");
      }
      snapshots.push({ snapshot: captured.snapshot, root: evidence.root, label: evidence.label });
    } catch (error) {
      throw new Error(`Recovery diagnostic ${evidence.label} owned evidence is invalid`, { cause: error });
    }
  }
  return snapshots;
}

function diagnosticSubjectId(scopeId: string): string {
  if (scopeId.startsWith("work-item:") && scopeId.length > "work-item:".length) {
    return scopeId.slice("work-item:".length);
  }
  if (scopeId === "integrated:final" || scopeId === "integrated:post-pr") return "integrated";
  if (scopeId.startsWith("integrated")) {
    throw new Error(`Integrated recovery scope is not canonical: ${scopeId}`);
  }
  return scopeId;
}

export function recoveryReviewScopeSubject(
  scopeId: string,
  phase: ReviewPhase,
): string {
  if (scopeId.startsWith("work-item:") && scopeId.length > "work-item:".length) {
    if (phase !== "work_item") throw new Error("Work-item recovery scope does not match the review phase");
    return scopeId.slice("work-item:".length);
  }
  if (scopeId === "integrated:final" && phase === "final_integrated") return "integrated";
  if (scopeId === "integrated:post-pr" && phase === "post_pr") return "integrated";
  throw new Error(`Recovery scope and review phase have no canonical binding: ${scopeId} / ${phase}`);
}

async function validateDiagnosticAuthority(
  runDir: string,
  manifest: RunManifestV2,
  artifact: DiagnosticRecoveryArtifactV1,
  requireCurrentProgress: boolean,
): Promise<void> {
  const subject = artifact.progress.subject;
  if (progressSubjectSha256(subject) !== artifact.progress.sha256) {
    throw new Error("Recovery diagnostic progress subject hash is invalid");
  }
  const approvedRevision = manifest.approved_revision;
  const approvedPlan = approvedRevision === null ? undefined : manifest.plan_revisions[String(approvedRevision)];
  const expectedPlanSha = approvedPlan?.sha256 ?? null;
  if (
    manifest.approved_revision !== manifest.approved_plan_revision
    || subject.approved_plan_sha256 !== expectedPlanSha
    || (requireCurrentProgress && subject.candidate_commit !== manifest.source_commit)
  ) {
    throw new Error("Recovery diagnostic approved plan or candidate commit does not match the locked manifest");
  }
  let workItemId = diagnosticSubjectId(artifact.scope_id);
  const qualityUsage = artifact.quality_recovery_usage;
  if (artifact.classification.kind === "review_policy") {
    const cycle = reviewCycleStateSchema.parse(JSON.parse(
      (await readOwnedRunFile(runDir, artifact.classification.review_cycle_path)).toString("utf8"),
    ));
    workItemId = recoveryReviewScopeSubject(artifact.scope_id, cycle.phase);
    if (qualityUsage === null || qualityUsage.work_item_id !== workItemId) {
      throw new Error("Recovery diagnostic quality usage belongs to a different work item");
    }
    const expectedAccounting = {
      ...cycle.accounting_before,
      review_revision: cycle.review_revision,
    };
    if (
      cycle.decision_path !== artifact.classification.review_cycle_path
      || cycle.effect_id !== artifact.classification.effect_id
      || cycle.effect_id !== artifact.current_observation.effect_attempt_id
      || cycle.work_item_id !== workItemId
      || !exactEqual(cycle.decision, artifact.policy_decision)
      || !exactEqual(cycle.decision.finding_ids, artifact.current_observation.finding_ids)
      || !exactEqual(expectedAccounting, artifact.review_accounting)
      || (requireCurrentProgress && !exactEqual(manifest.review_accounting ?? null, expectedAccounting))
    ) {
      throw new Error("Recovery diagnostic policy or accounting does not match its immutable review cycle");
    }
  } else if (artifact.policy_decision !== null) {
    throw new Error("Operational recovery diagnostics must not contain a review policy decision");
  }
  if (requireCurrentProgress && artifact.classification.kind === "review_policy") {
    const attempts = manifest.work_item_progress[workItemId]?.quality_recovery_attempts ?? 0;
    if (
      qualityUsage === null
      || qualityUsage.active_hands_profile !== manifest.active_hands_profile
      || qualityUsage.attempts_used !== attempts
    ) {
      throw new Error("Recovery diagnostic quality usage does not match the locked manifest");
    }
  }
  await validateDiagnosticOwnedEvidence(runDir, artifact, workItemId);
}

async function captureDirectory(path: string, label: string): Promise<DirectoryIdentity> {
  const status = await lstat(path);
  if (status.isSymbolicLink()) throw new Error(`${label} must not be a symlink`);
  if (!status.isDirectory()) throw new Error(`${label} must be a directory`);
  return { path, realPath: await realpath(path), dev: status.dev, ino: status.ino };
}

async function assertDirectoryIdentity(identity: DirectoryIdentity, label: string): Promise<void> {
  const current = await captureDirectory(identity.path, label);
  if (
    current.realPath !== identity.realPath
    || current.dev !== identity.dev
    || current.ino !== identity.ino
  ) throw new Error(`${label} identity changed during journal scan`);
}

async function captureDirectoryEntries(
  identity: DirectoryIdentity,
  label: string,
): Promise<DirectoryEntrySnapshot[]> {
  await assertDirectoryIdentity(identity, label);
  const names = (await readdir(identity.path)).sort();
  const entries = await Promise.all(names.map(async (name) => {
    const status = await lstat(join(identity.path, name));
    return {
      name,
      type: status.isSymbolicLink()
        ? "symlink" as const
        : status.isFile()
          ? "file" as const
          : status.isDirectory()
            ? "directory" as const
            : "other" as const,
    };
  }));
  await assertDirectoryIdentity(identity, label);
  return entries;
}

async function assertDirectoryEntries(
  identity: DirectoryIdentity,
  expected: DirectoryEntrySnapshot[],
  label: string,
): Promise<void> {
  const current = await captureDirectoryEntries(identity, label);
  if (!exactEqual(current, expected)) {
    throw new Error(`${label} entry snapshot changed during journal scan`);
  }
}

function authorizedScopeState(
  state: RecoveryScopeStateV1,
  authorizationPath: string,
): RecoveryScopeStateV1 {
  return recoveryScopeStateV1Schema.parse({
    ...state,
    disposition: "active",
    diagnostic_path: null,
    authorization_path: authorizationPath,
  });
}

function nextStateAfterAuthorizationConsumption(
  previous: RecoveryScopeStateV1 | null | undefined,
  next: RecoveryScopeStateV1,
): RecoveryScopeStateV1 {
  return previous?.authorization_path == null
    ? next
    : { ...next, authorization_path: null };
}

function authorizationForSequence(
  journal: ScopeJournal,
  sequence: number,
): BoundAuthorization | undefined {
  return journal.authorizations.find(
    ({ authorization }) => authorization.journal_sequence === sequence,
  );
}

async function scanAuthorizationDirectory(input: {
  runDir: string;
  directoryPath: string;
  scopeComponent: string;
  expectedRunId: string;
  decisions: RecoveryDecisionArtifactV1[];
  decisionPaths: string[];
  hooks?: RecoveryLedgerHooks;
}): Promise<{ identity: DirectoryIdentity; authorizations: BoundAuthorization[] }> {
  const identity = await captureDirectory(
    input.directoryPath,
    "Recovery authorizations directory",
  );
  const entries = await captureDirectoryEntries(identity, "Recovery authorizations directory");
  const authorizationById = new Map<string, BoundAuthorization>();
  const artifactSnapshots: Array<{ snapshot: OwnedFileSnapshot; label: string }> = [];
  const pendingConsumptions: Array<{
    path: string;
    consumption: DiagnosticRecoveryConsumptionV1;
  }> = [];
  for (const entry of entries) {
    if (entry.type === "symlink") {
      throw new Error("Recovery authorization must not be a symlink");
    }
    if (entry.type !== "file") {
      throw new Error(`Recovery authorizations contain an unsupported entry: ${entry.name}`);
    }
    const match = AUTHORIZATION_FILE_PATTERN.exec(entry.name);
    if (!match) {
      throw new Error(`Recovery authorizations contain a non-canonical entry: ${entry.name}`);
    }
    const authorizationId = match[1];
    const consumed = match[2] !== undefined;
    const relativePath = `recovery/scopes/${input.scopeComponent}/authorizations/${entry.name}`;
    if (consumed) {
      const captured = await captureOwnedFileSnapshot(
        input.runDir,
        relativePath,
        () => readOwnedRunFile(input.runDir, relativePath),
        "Recovery consumption",
      );
      const consumption = diagnosticRecoveryConsumptionV1Schema.parse(
        JSON.parse(captured.bytes.toString("utf8")),
      );
      artifactSnapshots.push({ snapshot: captured.snapshot, label: "Recovery consumption" });
      if (consumption.authorization_id !== authorizationId) {
        throw new Error("Recovery consumption filename does not match its authorization identity");
      }
      pendingConsumptions.push({ path: relativePath, consumption });
      continue;
    }
    const captured = await captureOwnedFileSnapshot(
      input.runDir,
      relativePath,
      () => readOwnedRunFile(input.runDir, relativePath),
      "Recovery authorization",
    );
    const authorization = diagnosticRecoveryAuthorizationV1Schema.parse(
      JSON.parse(captured.bytes.toString("utf8")),
    );
    artifactSnapshots.push({ snapshot: captured.snapshot, label: "Recovery authorization" });
    if (authorization.authorization_id !== authorizationId) {
      throw new Error("Recovery authorization filename does not match its identity");
    }
    if (authorization.run_id !== input.expectedRunId) {
      throw new Error("Recovery authorization belongs to a foreign run_id");
    }
    if (recoveryScopePathComponent(authorization.scope_id) !== input.scopeComponent) {
      throw new Error("Recovery authorization scope does not match its journal directory");
    }
    if (relativePath !== diagnosticRecoveryAuthorizationPath(
      authorization.scope_id,
      authorization.authorization_id,
    )) {
      throw new Error("Recovery authorization path is not canonical");
    }
    const decision = input.decisions[authorization.journal_sequence - 1];
    const decisionPath = input.decisionPaths[authorization.journal_sequence - 1];
    if (
      decision === undefined
      || decisionPath !== authorization.decision_path
      || decision.scope_id !== authorization.scope_id
      || decision.next_state.disposition !== "diagnostic_stop"
      || decision.next_state.head_sequence !== authorization.journal_sequence
      || decision.next_state.head_decision_path !== authorization.decision_path
      || decision.next_state.blocker_fingerprint !== authorization.blocker_fingerprint
      || decision.next_state.progress_subject_sha256 !== authorization.progress_subject_sha256
    ) {
      throw new Error("Recovery authorization does not match its exact diagnostic decision head binding");
    }
    if ([...authorizationById.values()].some(
      ({ authorization: existing }) =>
        existing.journal_sequence === authorization.journal_sequence,
    )) {
      throw new Error("Recovery diagnostic decision has multiple authorization artifacts");
    }
    authorizationById.set(authorizationId, {
      authorization,
      path: relativePath,
      consumption: null,
    });
  }
  for (const pending of pendingConsumptions) {
    const bound = authorizationById.get(pending.consumption.authorization_id);
    if (bound === undefined) {
      throw new Error("Recovery consumption has no matching authorization artifact");
    }
    if (
      pending.consumption.run_id !== input.expectedRunId
      || pending.consumption.run_id !== bound.authorization.run_id
      || pending.consumption.scope_id !== bound.authorization.scope_id
      || pending.path !== diagnosticRecoveryConsumptionPath(
        bound.authorization.scope_id,
        bound.authorization.authorization_id,
      )
    ) {
      throw new Error("Recovery consumption does not match its run, scope, or authorization binding");
    }
    if (bound.consumption !== null) {
      throw new Error("Recovery authorization has multiple consumption artifacts");
    }
    bound.consumption = pending.consumption;
  }
  await input.hooks?.afterAuthorizationEntriesRead?.(input.directoryPath);
  for (const artifact of artifactSnapshots) {
    await assertOwnedFileSnapshot(
      input.runDir,
      artifact.snapshot,
      () => readOwnedRunFile(input.runDir, artifact.snapshot.path),
      artifact.label,
    );
  }
  await assertDirectoryEntries(identity, entries, "Recovery authorizations directory");
  return {
    identity,
    authorizations: [...authorizationById.values()].sort((left, right) =>
      left.authorization.journal_sequence - right.authorization.journal_sequence),
  };
}

async function scanDiagnosticDirectory(input: {
  runDir: string;
  directoryPath: string;
  scopeComponent: string;
  expectedRunId: string;
  decisions: RecoveryDecisionArtifactV1[];
  decisionPaths: string[];
  hooks?: RecoveryLedgerHooks;
}): Promise<DirectoryIdentity> {
  const manifest = runManifestV2Schema.parse(JSON.parse(
    (await readOwnedRunFile(input.runDir, "manifest.json")).toString("utf8"),
  )) as RunManifestV2;
  const repairedSequences = new Set<number>();
  for (let index = 0; index < input.decisions.length; index += 1) {
    const decision = input.decisions[index];
    const terminal = decision.guard_action === "diagnostic_stop" || decision.guard_action === "exhausted_stop";
    if (!terminal) continue;
    const intent = decision.diagnostic_intent;
    if (intent === undefined || input.decisionPaths[index] !== intent.decision_path) {
      throw new Error("Terminal recovery decision is missing its exact diagnostic intent");
    }
    const diagnosticPath = recoveryDiagnosticPath(decision.scope_id, decision.sequence);
    const existing = await readOptionalValidatedArtifact(
      input.runDir,
      diagnosticPath,
      diagnosticRecoveryArtifactV1Schema,
    );
    await validateDiagnosticAuthority(
      input.runDir,
      manifest,
      intent,
      existing === null || manifest.recovery.active_scope === decision.scope_id,
    );
    await writeDiagnosticRecoveryArtifact({ runDir: input.runDir, artifact: intent });
    if (existing === null) repairedSequences.add(decision.sequence);
  }
  const identity = await captureDirectory(
    input.directoryPath,
    "Recovery diagnostics directory",
  );
  const entries = await captureDirectoryEntries(identity, "Recovery diagnostics directory");
  const seenSequences = new Set<number>();
  const fileSnapshots: Array<{
    diagnostic: OwnedFileSnapshot;
    evidence: Array<{ snapshot: OwnedFileSnapshot; root: string; label: string }>;
  }> = [];
  for (const entry of entries) {
    if (entry.type === "symlink") throw new Error("Recovery diagnostics must not contain a symlink");
    if (entry.type !== "file") {
      throw new Error(`Recovery diagnostics contain an unsupported entry: ${entry.name}`);
    }
    const match = DIAGNOSTIC_FILE_PATTERN.exec(entry.name);
    if (!match) {
      throw new Error(`Recovery diagnostics contain a non-canonical entry: ${entry.name}`);
    }
    const sequence = Number(match[1]);
    if (!Number.isSafeInteger(sequence) || sequence < 1 || seenSequences.has(sequence)) {
      throw new Error(`Recovery diagnostic sequence is invalid or duplicated: ${entry.name}`);
    }
    seenSequences.add(sequence);
    const relativePath = `recovery/scopes/${input.scopeComponent}/diagnostics/${entry.name}`;
    const captured = await captureOwnedFileSnapshot(
      input.runDir,
      relativePath,
      () => readOwnedRunFile(input.runDir, relativePath),
      "Recovery diagnostic artifact",
    );
    const artifact = diagnosticRecoveryArtifactV1Schema.parse(
      JSON.parse(captured.bytes.toString("utf8")),
    );
    const evidenceSnapshots = await validateDiagnosticOwnedEvidence(
      input.runDir,
      artifact,
      diagnosticSubjectId(artifact.scope_id),
    );
    const decision = input.decisions[sequence - 1];
    const decisionPath = input.decisionPaths[sequence - 1];
    if (
      decision === undefined
      || decisionPath === undefined
      || artifact.run_id !== input.expectedRunId
      || artifact.scope_id !== decision.scope_id
      || (
        artifact.classification.kind === "review_policy"
        && (
          artifact.quality_recovery_usage === null
          || artifact.quality_recovery_usage.work_item_id !== diagnosticSubjectId(artifact.scope_id)
        )
      )
      || recoveryScopePathComponent(artifact.scope_id) !== input.scopeComponent
      || artifact.journal_sequence !== decision.sequence
      || artifact.decision_path !== decisionPath
      || relativePath !== recoveryDiagnosticPath(decision.scope_id, decision.sequence)
      || artifact.guard_action !== decision.guard_action
      || !["diagnostic_stop", "exhausted_stop"].includes(decision.guard_action)
      || !exactEqual(artifact.current_observation, decision.observation)
      || !exactEqual(
        artifact.previous_observation,
        input.decisions[sequence - 2]?.observation ?? null,
      )
      || artifact.requested_effect !== decision.requested_effect
      || artifact.requested_effect_reason !== decision.requested_effect_reason
      || artifact.recorded_at !== decision.recorded_at
      || !exactEqual(artifact, decision.diagnostic_intent)
      || artifact.progress.sha256 !== decision.observation.progress_subject_sha256
      || progressSubjectSha256(artifact.progress.subject) !== artifact.progress.sha256
      || !exactEqual(
        [...artifact.progress.subject.finding_ids].sort(),
        [...decision.observation.finding_ids].sort(),
      )
      || (
        artifact.policy_decision !== null
        && !exactEqual(
          [...artifact.policy_decision.finding_ids].sort(),
          [...decision.observation.finding_ids].sort(),
        )
      )
      || (
        decision.guard_action === "diagnostic_stop"
        && decision.next_state.diagnostic_path !== relativePath
      )
      || (
        decision.guard_action === "exhausted_stop"
        && decision.next_state.diagnostic_path !== null
      )
    ) {
      throw new Error("Recovery diagnostic does not match its exact run, scope, head, path, or observation binding");
    }
    await validateDiagnosticAuthority(
      input.runDir,
      manifest,
      artifact,
      repairedSequences.has(sequence) || manifest.recovery.active_scope === artifact.scope_id,
    );
    fileSnapshots.push({ diagnostic: captured.snapshot, evidence: evidenceSnapshots });
  }
  for (const decision of input.decisions) {
    const terminal = decision.guard_action === "diagnostic_stop" || decision.guard_action === "exhausted_stop";
    if (terminal !== seenSequences.has(decision.sequence)) {
      throw new Error(terminal
        ? "Terminal recovery decision is missing its canonical diagnostic artifact"
        : "Recovery diagnostic is orphaned from a terminal decision");
    }
  }
  await input.hooks?.afterDiagnosticEntriesRead?.(input.directoryPath);
  for (const files of fileSnapshots) {
    await assertOwnedFileSnapshot(
      input.runDir,
      files.diagnostic,
      () => readOwnedRunFile(input.runDir, files.diagnostic.path),
      "Recovery diagnostic artifact",
    );
    for (const evidence of files.evidence) {
      await assertOwnedFileSnapshot(
        input.runDir,
        evidence.snapshot,
        () => readOwnedEvidenceFile(input.runDir, evidence.snapshot.path, evidence.root),
        `Recovery diagnostic ${evidence.label} owned evidence`,
      );
    }
  }
  await assertDirectoryEntries(identity, entries, "Recovery diagnostics directory");
  return identity;
}

async function prevalidateMissingDiagnosticDirectory(input: {
  runDir: string;
  expectedRunId: string;
  scopeComponent: string;
  decisions: RecoveryDecisionArtifactV1[];
  decisionPaths: string[];
}): Promise<void> {
  const manifest = runManifestV2Schema.parse(JSON.parse(
    (await readOwnedRunFile(input.runDir, "manifest.json")).toString("utf8"),
  )) as RunManifestV2;
  if (manifest.run_id !== input.expectedRunId) {
    throw new Error("Recovery diagnostic manifest belongs to a foreign run_id");
  }
  for (let index = 0; index < input.decisions.length; index += 1) {
    const decision = input.decisions[index];
    const terminal = decision.guard_action === "diagnostic_stop" || decision.guard_action === "exhausted_stop";
    if (!terminal) continue;
    const intent = decision.diagnostic_intent;
    const decisionPath = input.decisionPaths[index];
    const diagnosticPath = recoveryDiagnosticPath(decision.scope_id, decision.sequence);
    if (
      intent === undefined
      || decisionPath === undefined
      || intent.run_id !== input.expectedRunId
      || recoveryScopePathComponent(intent.scope_id) !== input.scopeComponent
      || intent.decision_path !== decisionPath
      || intent.journal_sequence !== decision.sequence
      || !exactEqual(intent.previous_observation, input.decisions[index - 1]?.observation ?? null)
      || intent.progress.sha256 !== decision.observation.progress_subject_sha256
      || !exactEqual(
        [...intent.progress.subject.finding_ids].sort(),
        [...decision.observation.finding_ids].sort(),
      )
      || (
        intent.policy_decision !== null
        && !exactEqual(
          [...intent.policy_decision.finding_ids].sort(),
          [...decision.observation.finding_ids].sort(),
        )
      )
      || (
        decision.guard_action === "diagnostic_stop"
        && decision.next_state.diagnostic_path !== diagnosticPath
      )
      || (
        decision.guard_action === "exhausted_stop"
        && decision.next_state.diagnostic_path !== null
      )
    ) {
      throw new Error("Terminal recovery decision has an invalid diagnostic intent binding");
    }
    await validateDiagnosticAuthority(input.runDir, manifest, intent, true);
  }
}

async function scanRecoveryJournal(
  runDir: string,
  expectedRunId: string,
  hooks?: RecoveryLedgerHooks,
): Promise<Map<string, ScopeJournal>> {
  const root = join(runDir, "recovery/scopes");
  const rootIdentity = await captureDirectory(root, "Recovery scopes root").catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  const journals = new Map<string, ScopeJournal>();
  if (rootIdentity === null) return journals;
  const scopeEntries = await captureDirectoryEntries(rootIdentity, "Recovery scopes root");
  for (const scopeEntry of scopeEntries) {
    const scopePath = join(root, scopeEntry.name);
    if (!SCOPE_COMPONENT_PATTERN.test(scopeEntry.name)) {
      throw new Error(`Recovery scopes root contains an unsupported entry: ${scopeEntry.name}`);
    }
    if (scopeEntry.type !== "directory") {
      throw new Error(`Recovery scopes root contains an unsupported entry: ${scopeEntry.name}`);
    }
    const scopeIdentity = await captureDirectory(scopePath, "Recovery scope entry");
    let children = await captureDirectoryEntries(scopeIdentity, "Recovery scope entry");
    let diagnosticsPath: string | null = null;
    let authorizationsPath: string | null = null;
    for (const child of children) {
      const childPath = join(scopePath, child.name);
      if (child.type === "symlink") throw new Error("Recovery scope directory must not contain a symlink");
      if (child.type !== "directory" || !SUPPORTED_SCOPE_DIRECTORIES.has(child.name)) {
        throw new Error(`Recovery scope contains an unsupported entry: ${child.name}`);
      }
      if (child.name === "diagnostics") {
        diagnosticsPath = childPath;
      }
      if (child.name === "authorizations") {
        authorizationsPath = childPath;
      }
    }
    if (!children.some((child) => child.name === "decisions")) {
      if (authorizationsPath !== null) {
        await scanAuthorizationDirectory({
          runDir,
          directoryPath: authorizationsPath,
          scopeComponent: scopeEntry.name,
          expectedRunId,
          decisions: [],
          decisionPaths: [],
          hooks,
        });
      }
      if (diagnosticsPath !== null) {
        await scanDiagnosticDirectory({
          runDir,
          directoryPath: diagnosticsPath,
          scopeComponent: scopeEntry.name,
          expectedRunId,
          decisions: [],
          decisionPaths: [],
          hooks,
        });
      }
      await assertDirectoryEntries(scopeIdentity, children, "Recovery scope entry");
      continue;
    }
    const decisionsRoot = join(scopePath, "decisions");
    const decisionsIdentity = await captureDirectory(decisionsRoot, "Recovery decisions directory");
    const decisionEntries = await captureDirectoryEntries(decisionsIdentity, "Recovery decisions directory");
    const parsedEntries = await Promise.all(decisionEntries.map(async (entry) => {
      if (entry.type === "symlink") throw new Error("Recovery decision must not be a symlink");
      if (entry.type !== "file") throw new Error(`Recovery decisions contain an unsupported entry: ${entry.name}`);
      const match = DECISION_FILE_PATTERN.exec(entry.name);
      if (!match) throw new Error(`Recovery decisions contain an unsupported entry: ${entry.name}`);
      const sequence = Number(match[1]);
      if (!Number.isSafeInteger(sequence) || sequence < 1) {
        throw new Error(`Recovery decision sequence is not a positive safe integer: ${entry.name}`);
      }
      return { entry, sequence };
    }));
    parsedEntries.sort((left, right) => left.sequence - right.sequence);
    let scopeId: string | null = null;
    const decisions: RecoveryDecisionArtifactV1[] = [];
    const paths: string[] = [];
    const attempts = new Set<string>();
    for (let index = 0; index < parsedEntries.length; index += 1) {
      const { entry, sequence } = parsedEntries[index];
      if (sequence !== index + 1) throw new Error("Recovery decision sequences must be contiguous and start at one");
      const relativePath = `recovery/scopes/${scopeEntry.name}/decisions/${entry.name}`;
      const decision = await readOptionalValidatedArtifact(
        runDir,
        relativePath,
        recoveryDecisionArtifactV1Schema,
      );
      if (decision === null) throw new Error(`Recovery decision disappeared during reconciliation: ${relativePath}`);
      if (decision.run_id !== expectedRunId) throw new Error("Recovery journal contains a decision for a foreign run_id");
      if (recoveryScopePathComponent(decision.scope_id) !== scopeEntry.name) {
        throw new Error("Recovery decision scope does not match its journal directory");
      }
      if (relativePath !== recoveryDecisionPath(
        decision.scope_id,
        decision.sequence,
        recoveryObservationId(decision.observation),
      )) throw new Error("Recovery decision path does not match its identity");
      if (scopeId !== null && decision.scope_id !== scopeId) {
        throw new Error("Recovery scope journal contains multiple scope identifiers");
      }
      if (attempts.has(decision.observation.effect_attempt_id)) {
        throw new Error("Recovery scope journal contains a duplicate effect attempt");
      }
      attempts.add(decision.observation.effect_attempt_id);
      scopeId = decision.scope_id;
      decisions.push(decision);
      paths.push(relativePath);
    }
    const requiresDiagnostics = decisions.some(
      (decision) => decision.guard_action === "diagnostic_stop" || decision.guard_action === "exhausted_stop",
    );
    if (diagnosticsPath === null && requiresDiagnostics) {
      await prevalidateMissingDiagnosticDirectory({
        runDir,
        expectedRunId,
        scopeComponent: scopeEntry.name,
        decisions,
        decisionPaths: paths,
      });
      await assertDirectoryEntries(scopeIdentity, children, "Recovery scope entry");
      const createdPath = join(scopePath, "diagnostics");
      await mkdir(createdPath, { mode: 0o700 });
      const expectedChildren = [
        ...children,
        { name: "diagnostics", type: "directory" as const },
      ].sort((left, right) => left.name.localeCompare(right.name));
      await assertDirectoryEntries(scopeIdentity, expectedChildren, "Recovery scope entry");
      const createdIdentity = await captureDirectory(createdPath, "Recovery diagnostics directory");
      await assertDirectoryEntries(createdIdentity, [], "Recovery diagnostics directory");
      diagnosticsPath = createdPath;
      children = expectedChildren;
    }
    const diagnosticIdentity = diagnosticsPath === null
      ? null
      : await scanDiagnosticDirectory({
        runDir,
        directoryPath: diagnosticsPath,
        scopeComponent: scopeEntry.name,
        expectedRunId,
        decisions,
        decisionPaths: paths,
        hooks,
      });
    const authorizationScan = authorizationsPath === null
      ? { identity: null, authorizations: [] as BoundAuthorization[] }
      : await scanAuthorizationDirectory({
        runDir,
        directoryPath: authorizationsPath,
        scopeComponent: scopeEntry.name,
        expectedRunId,
        decisions,
        decisionPaths: paths,
        hooks,
      });
    const scopeJournal: ScopeJournal = {
      decisions,
      paths,
      authorizations: authorizationScan.authorizations,
    };
    for (let index = 0; index < decisions.length; index += 1) {
      const previous = decisions[index - 1];
      const previousAuthorization = previous === undefined
        ? undefined
        : authorizationForSequence(scopeJournal, previous.sequence);
      const expectedPrevious = previous === undefined
        ? null
        : previousAuthorization === undefined
          ? previous.next_state
          : previousAuthorization.consumption === null
            ? null
            : authorizedScopeState(previous.next_state, previousAuthorization.path);
      if (expectedPrevious === null && previous !== undefined) {
        throw new Error("Recovery decision follows an unconsumed diagnostic authorization");
      }
      if (!exactEqual(decisions[index].previous_state, expectedPrevious)) {
        throw new Error("Recovery decision previous/next state chain is invalid");
      }
    }
    if (scopeId !== null) {
      if (journals.has(scopeId)) throw new Error("Recovery scope is represented by multiple journal directories");
      journals.set(scopeId, scopeJournal);
    }
    await assertDirectoryEntries(decisionsIdentity, decisionEntries, "Recovery decisions directory");
    if (authorizationScan.identity !== null) {
      await assertDirectoryIdentity(
        authorizationScan.identity,
        "Recovery authorizations directory",
      );
    }
    if (diagnosticIdentity !== null) {
      await assertDirectoryIdentity(
        diagnosticIdentity,
        "Recovery diagnostics directory",
      );
    }
    await assertDirectoryEntries(scopeIdentity, children, "Recovery scope entry");
  }
  await assertDirectoryEntries(rootIdentity, scopeEntries, "Recovery scopes root");
  return journals;
}

function decisionEventInput(decision: RecoveryDecisionArtifactV1, artifactPath: string) {
  return {
    eventId: decision.decision_event_id,
    actor: "recovery-guard",
    stage: decision.observation.stage,
    type: "recovery_decision_recorded",
    timestamp: decision.recorded_at,
    payload: {
      artifact_path: artifactPath,
      scope_id: decision.scope_id,
      sequence: decision.sequence,
      effect_attempt_id: decision.observation.effect_attempt_id,
      requested_effect: decision.requested_effect,
      guard_action: decision.guard_action,
    },
  };
}

function expectedDecisionEvent(decision: RecoveryDecisionArtifactV1, artifactPath: string): RunEvent {
  const input = decisionEventInput(decision, artifactPath);
  return runEventSchema.parse({
    event_id: input.eventId,
    run_id: decision.run_id,
    stage: input.stage,
    type: input.type,
    timestamp: input.timestamp,
    actor: input.actor,
    payload: input.payload,
  }) as RunEvent;
}

function validateGlobalDecisionChain(journals: Map<string, ScopeJournal>): BoundDecision[] {
  const byEventId = new Map<string, BoundDecision>();
  for (const journal of journals.values()) {
    for (let index = 0; index < journal.decisions.length; index += 1) {
      const bound = { decision: journal.decisions[index], path: journal.paths[index] };
      if (byEventId.has(bound.decision.decision_event_id)) {
        throw new Error(`Recovery decision chain contains a duplicate event identity: ${bound.decision.decision_event_id}`);
      }
      byEventId.set(bound.decision.decision_event_id, bound);
    }
  }
  if (byEventId.size === 0) return [];

  const roots: BoundDecision[] = [];
  const childByPredecessor = new Map<string, BoundDecision>();
  for (const bound of byEventId.values()) {
    const predecessor = bound.decision.previous_decision_event_id;
    if (predecessor === null) {
      roots.push(bound);
      continue;
    }
    if (!byEventId.has(predecessor)) {
      throw new Error(`Recovery decision chain predecessor is missing: ${predecessor}`);
    }
    if (childByPredecessor.has(predecessor)) {
      throw new Error(`Recovery decision chain forks after: ${predecessor}`);
    }
    childByPredecessor.set(predecessor, bound);
  }
  if (roots.length !== 1) {
    throw new Error(`Recovery decision chain must contain exactly one root; found ${roots.length}`);
  }

  const ordered: BoundDecision[] = [];
  const visited = new Set<string>();
  const nextSequenceByScope = new Map(
    [...journals.keys()].map((scopeId) => [scopeId, 1]),
  );
  let current: BoundDecision | undefined = roots[0];
  while (current !== undefined) {
    if (visited.has(current.decision.decision_event_id)) {
      throw new Error("Recovery decision chain contains a cycle");
    }
    const expectedSequence = nextSequenceByScope.get(current.decision.scope_id);
    if (expectedSequence === undefined || current.decision.sequence !== expectedSequence) {
      throw new Error(`Recovery decision chain conflicts with scope journal order for ${current.decision.scope_id}`);
    }
    nextSequenceByScope.set(current.decision.scope_id, expectedSequence + 1);
    visited.add(current.decision.decision_event_id);
    ordered.push(current);
    current = childByPredecessor.get(current.decision.decision_event_id);
  }
  if (ordered.length !== byEventId.size) {
    throw new Error("Recovery decision chain is cyclic or disconnected");
  }
  for (const [scopeId, journal] of journals) {
    if (nextSequenceByScope.get(scopeId) !== journal.decisions.length + 1) {
      throw new Error(`Recovery decision chain does not cover scope journal ${scopeId}`);
    }
  }
  validateDiagnosticAttemptBindings(journals, ordered);
  return ordered;
}

function validateDiagnosticAttemptBindings(
  journals: Map<string, ScopeJournal>,
  chain: BoundDecision[],
): void {
  const chainIndexByPath = new Map(chain.map((bound, index) => [bound.path, index]));
  const consumptionByAttempt = new Map<string, {
    authorization: BoundAuthorization;
    expectedDecisionIndex: number;
  }>();
  for (const journal of journals.values()) {
    for (const authorization of journal.authorizations) {
      const headIndex = chainIndexByPath.get(authorization.authorization.decision_path);
      if (headIndex === undefined) {
        throw new Error("Recovery diagnostic authorization head is absent from the global decision chain");
      }
      const next = chain[headIndex + 1];
      if (authorization.consumption === null) {
        if (next !== undefined) {
          throw new Error("Recovery decision follows an unconsumed diagnostic authorization");
        }
        continue;
      }
      const attemptId = authorization.consumption.effect_attempt_id;
      if (consumptionByAttempt.has(attemptId)) {
        throw new Error("Recovery diagnostic attempt is consumed by multiple authorizations");
      }
      consumptionByAttempt.set(attemptId, {
        authorization,
        expectedDecisionIndex: headIndex + 1,
      });
      if (next !== undefined && (
        next.decision.scope_id !== authorization.authorization.scope_id
        || next.decision.observation.effect_attempt_id !== attemptId
      )) {
        throw new Error("Recovery diagnostic authorization must bind the immediate next decision attempt");
      }
    }
  }

  for (let index = 0; index < chain.length; index += 1) {
    const bound = chain[index];
    const attemptId = bound.decision.observation.effect_attempt_id;
    if (!/^recovery-attempt:[a-f0-9]{64}$/.test(attemptId)) continue;
    const consumption = consumptionByAttempt.get(attemptId);
    if (
      consumption === undefined
      || consumption.expectedDecisionIndex !== index
      || consumption.authorization.authorization.scope_id !== bound.decision.scope_id
    ) {
      throw new Error("Recovery diagnostic attempt is detached, delayed, cross-scope, or repeated");
    }
  }
}

function assertObservationAuthorizationBinding(
  manifest: RunManifestV2,
  journals: Map<string, ScopeJournal>,
  chain: BoundDecision[],
  observation: RecoveryObservationV1,
  requestedEffect: RecoveryRequestedEffect,
  requestedEffectReason: string,
): void {
  const tail = chain.at(-1);
  const tailJournal = tail === undefined ? undefined : journals.get(tail.decision.scope_id);
  const pending = tail === undefined || tailJournal === undefined
    ? undefined
    : authorizationForSequence(tailJournal, tail.decision.sequence);
  const canonicalAttempt = /^recovery-attempt:[a-f0-9]{64}$/.test(
    observation.effect_attempt_id,
  );
  if (pending === undefined) {
    if (canonicalAttempt) {
      throw new Error("Recovery diagnostic attempt is detached, delayed, cross-scope, or reused");
    }
    return;
  }
  if (pending.consumption === null) {
    throw new Error("Recovery diagnostic authorization must be consumed before recording its next attempt");
  }
  const projected = ownRecoveryScopeState(
    manifest.recovery.scopes,
    pending.authorization.scope_id,
  );
  if (
    observation.scope_id !== pending.authorization.scope_id
    || observation.effect_attempt_id !== pending.consumption.effect_attempt_id
    || projected?.authorization_path !== pending.path
  ) {
    throw new Error("Recovery observation does not match the immediate authorized diagnostic attempt");
  }
  const authorizedHead = chain.find(
    (bound) => bound.path === pending.authorization.decision_path,
  )?.decision;
  if (authorizedHead === undefined) {
    throw new Error("Recovery authorization head is absent from the immutable decision chain");
  }
  assertExactAuthorizedSubject({
    run_id: observation.run_id,
    scope_id: observation.scope_id,
    stage: observation.stage,
    operation: observation.operation,
    failure_class: observation.failure_class,
    blocker_code: observation.blocker_code,
    finding_ids: observation.finding_ids,
    requested_effect: requestedEffect,
    requested_effect_reason: requestedEffectReason,
    progress_subject_sha256: observation.progress_subject_sha256,
  }, authorizedHead, true);
}

function assertPendingAuthorizationBeforeReconciliation(
  journals: Map<string, ScopeJournal>,
  chain: BoundDecision[],
  observation: RecoveryObservationV1,
  requestedEffect: RecoveryRequestedEffect,
  requestedEffectReason: string,
): void {
  const tail = chain.at(-1);
  const journal = tail === undefined ? undefined : journals.get(tail.decision.scope_id);
  const pending = tail === undefined || journal === undefined
    ? undefined
    : authorizationForSequence(journal, tail.decision.sequence);
  if (pending === undefined) return;
  if (pending.consumption === null) {
    throw new Error("Recovery diagnostic authorization must be consumed before recording its next attempt");
  }
  if (
    observation.scope_id !== pending.authorization.scope_id
    || observation.effect_attempt_id !== pending.consumption.effect_attempt_id
  ) {
    throw new Error("Recovery observation does not match the immediate authorized diagnostic attempt");
  }
  const authorizedHead = chain.find(
    (bound) => bound.path === pending.authorization.decision_path,
  )?.decision;
  if (authorizedHead === undefined) {
    throw new Error("Recovery authorization head is absent from the immutable decision chain");
  }
  assertExactAuthorizedSubject({
    run_id: observation.run_id,
    scope_id: observation.scope_id,
    stage: observation.stage,
    operation: observation.operation,
    failure_class: observation.failure_class,
    blocker_code: observation.blocker_code,
    finding_ids: observation.finding_ids,
    requested_effect: requestedEffect,
    requested_effect_reason: requestedEffectReason,
    progress_subject_sha256: observation.progress_subject_sha256,
  }, authorizedHead, true);
}

async function readValidatedRunEvents(runDir: string, expectedRunId: string): Promise<RunEvent[]> {
  const text = (await readOwnedRunFile(runDir, "events.jsonl")).toString("utf8");
  if (text.length > 0 && !text.endsWith("\n")) {
    throw new Error("Run event stream has non-canonical framing: nonempty events.jsonl must end with a newline");
  }
  if (text.includes("\r")) {
    throw new Error("Run event stream has non-canonical CRLF framing");
  }
  const lines = text.length === 0 ? [] : text.slice(0, -1).split("\n");
  if (lines.some((line) => line.length === 0)) {
    throw new Error("Run event stream has non-canonical blank record framing");
  }
  const events = lines.map((line) => runEventSchema.parse(JSON.parse(line)) as RunEvent);
  if (events.some((event) => event.run_id !== expectedRunId)) {
    throw new Error("Run event stream contains an event for a foreign run");
  }
  return events;
}

function validateRecoveryDecisionEventOrder(
  events: RunEvent[],
  chain: BoundDecision[],
): { missing: BoundDecision[]; latestScope: string | null } {
  const decisionsByEvent = new Map(chain.map((bound) => [bound.decision.decision_event_id, bound]));
  let seen = 0;
  for (const event of events) {
    const bound = decisionsByEvent.get(event.event_id);
    const namesRecoveryDecision = event.type === "recovery_decision_recorded"
      || event.event_id.startsWith("recovery-decision:");
    if (!bound) {
      if (namesRecoveryDecision) {
        throw new Error(`Recovery decision event has no validated journal decision: ${event.event_id}`);
      }
      continue;
    }
    if (!exactEqual(event, expectedDecisionEvent(bound.decision, bound.path))) {
      throw new Error(`Recovery decision event conflicts with its journal decision: ${event.event_id}`);
    }
    const expected = chain[seen];
    if (expected === undefined || event.event_id !== expected.decision.decision_event_id) {
      throw new Error("Recovery decision event order conflicts with the immutable global decision chain");
    }
    seen += 1;
  }
  return {
    missing: chain.slice(seen),
    latestScope: chain.at(-1)?.decision.scope_id ?? null,
  };
}

function projectedStateAtSequence(
  journal: ScopeJournal,
  sequence: number,
): RecoveryScopeStateV1 | undefined {
  const decision = journal.decisions[sequence - 1];
  if (decision === undefined) return undefined;
  const authorization = authorizationForSequence(journal, sequence);
  return authorization === undefined
    ? decision.next_state
    : authorizedScopeState(decision.next_state, authorization.path);
}

async function reconcileRecoveryJournalLocked(
  transaction: RunLedgerTransaction,
  hooks?: RecoveryLedgerHooks,
): Promise<RunManifestV2> {
  const manifest = await transaction.readManifestV2();
  const journals = await scanRecoveryJournal(transaction.runDir, manifest.run_id, hooks);
  const decisionChain = validateGlobalDecisionChain(journals);
  const nextScopes = { ...manifest.recovery.scopes };
  const staleScopes: string[] = [];

  for (const [scopeId, journal] of journals) {
    const head = journal.decisions.at(-1)!;
    const headProjection = projectedStateAtSequence(journal, head.sequence)!;
    const projected = ownRecoveryScopeState(manifest.recovery.scopes, scopeId);
    if (projected !== undefined && projected.head_sequence > head.sequence) {
      throw new Error(`Recovery manifest head is ahead of the journal for ${scopeId}`);
    }
    if (projected !== undefined && projected.head_sequence === head.sequence) {
      if (!exactEqual(projected, headProjection)) {
        const headAuthorization = authorizationForSequence(journal, head.sequence);
        if (headAuthorization === undefined || !exactEqual(projected, head.next_state)) {
          throw new Error(`Recovery manifest head pointer conflicts with the journal for ${scopeId}`);
        }
        nextScopes[scopeId] = headProjection;
        staleScopes.push(scopeId);
      }
    } else {
      if (projected !== undefined) {
        if (projected.head_sequence === 0) {
          throw new Error(`Recovery manifest contains an unjournaled zero head for ${scopeId}`);
        }
        const projectedState = projectedStateAtSequence(journal, projected.head_sequence);
        if (projectedState === undefined || !exactEqual(projected, projectedState)) {
          throw new Error(`Recovery manifest stale head conflicts with the journal for ${scopeId}`);
        }
      }
      const projectedSequence = projected?.head_sequence ?? 0;
      if (head.sequence - projectedSequence !== 1) {
        throw new Error(`Recovery manifest stale head for ${scopeId} must be the immediate journal predecessor`);
      }
      nextScopes[scopeId] = headProjection;
      staleScopes.push(scopeId);
    }
  }
  for (const scopeId of Object.keys(manifest.recovery.scopes)) {
    if (!journals.has(scopeId)) {
      throw new Error(`Recovery manifest contains an unjournaled scope: ${scopeId}`);
    }
  }
  if (staleScopes.length > 1) {
    throw new Error("Recovery journal has multiple unprojected scope heads");
  }

  let events = await readValidatedRunEvents(transaction.runDir, manifest.run_id);
  let eventProjection = validateRecoveryDecisionEventOrder(events, decisionChain);
  if (eventProjection.missing.length > 0) {
    if (
      eventProjection.missing.length !== 1
      || staleScopes.length !== 1
      || staleScopes[0] !== eventProjection.missing[0].decision.scope_id
    ) {
      throw new Error("Recovery journal event projection conflicts with the manifest projection");
    }
    const missing = eventProjection.missing[0];
    await appendRunEventOnce(
      transaction.runDir,
      decisionEventInput(missing.decision, missing.path),
    );
    events = await readValidatedRunEvents(transaction.runDir, manifest.run_id);
    eventProjection = validateRecoveryDecisionEventOrder(events, decisionChain);
    if (eventProjection.missing.length > 0) {
      throw new Error("Recovery decision event projection remains incomplete after reconciliation");
    }
  }

  const activeScope = eventProjection.latestScope;
  if (staleScopes.length === 0 && manifest.recovery.active_scope === activeScope) return manifest;
  return transaction.updateManifestV2({
    recovery: {
      ...manifest.recovery,
      active_scope: activeScope,
      scopes: nextScopes,
    },
  });
}

export async function reconcileRecoveryJournal(
  runDir: string,
  hooks?: Pick<RecoveryLedgerHooks, "afterAuthorizationEntriesRead" | "afterDiagnosticEntriesRead">,
): Promise<RunManifestV2> {
  return withRunLedgerCompoundTransaction(
    runDir,
    (transaction) => reconcileRecoveryJournalLocked(transaction, hooks),
  );
}

async function buildDiagnosticIntent(input: {
  runDir: string;
  manifest: RunManifestV2;
  context: RecoveryDiagnosticContext;
  observation: RecoveryObservationV1;
  previousObservation: RecoveryObservationV1 | null;
  requestedEffect: RecoveryRequestedEffect;
  requestedEffectReason: string;
  guardAction: "diagnostic_stop" | "exhausted_stop";
  sequence: number;
  decisionPath: string;
  recordedAt: string;
}): Promise<DiagnosticRecoveryArtifactV1> {
  const workItemId = diagnosticSubjectId(input.observation.scope_id);
  const attemptsUsed = input.context.classification.kind === "review_policy"
    ? input.manifest.work_item_progress[workItemId]?.quality_recovery_attempts ?? 0
    : null;
  if (attemptsUsed !== null && attemptsUsed !== 0 && attemptsUsed !== 1) {
    throw new Error("Quality recovery attempts must be zero or one");
  }
  if (
    input.context.progress.sha256 !== input.observation.progress_subject_sha256
    || !exactEqual(
      [...input.context.progress.subject.finding_ids].sort(),
      [...input.observation.finding_ids].sort(),
    )
  ) {
    throw new Error("Recovery diagnostic progress does not match its observation");
  }
  const artifact = diagnosticRecoveryArtifactV1Schema.parse({
    version: 1,
    run_id: input.manifest.run_id,
    scope_id: input.observation.scope_id,
    journal_sequence: input.sequence,
    decision_path: input.decisionPath,
    guard_action: input.guardAction,
    previous_observation: input.previousObservation,
    current_observation: input.observation,
    requested_effect: input.requestedEffect,
    requested_effect_reason: input.requestedEffectReason,
    classification: input.context.classification,
    policy_decision: input.context.policy_decision,
    review_accounting: input.context.classification.kind === "review_policy"
      ? input.manifest.review_accounting ?? null
      : null,
    quality_recovery_usage: input.context.classification.kind === "review_policy"
      ? {
          work_item_id: workItemId,
          active_hands_profile: input.manifest.active_hands_profile,
          attempts_used: attemptsUsed!,
        }
      : null,
    owned_evidence_refs: input.context.owned_evidence_refs,
    progress: input.context.progress,
    recorded_at: input.recordedAt,
  });
  await validateDiagnosticAuthority(input.runDir, input.manifest, artifact, true);
  return artifact;
}

export async function recordRecoveryObservation(input: {
  runDir: string;
  observation: RecoveryObservationV1;
  requestedEffect: RecoveryRequestedEffect;
  requestedEffectReason: string;
  diagnosticContext?: RecoveryDiagnosticContext;
  hooks?: RecoveryLedgerHooks;
}): Promise<{
  artifact_path: string;
  decision: RecoveryDecisionArtifactV1;
  manifest: RunManifestV2;
}> {
  const observation = recoveryObservationV1Schema.parse(input.observation) as RecoveryObservationV1;
  const requestedEffect = recoveryRequestedEffectSchema.parse(input.requestedEffect) as RecoveryRequestedEffect;
  const requestedEffectReason = input.requestedEffectReason;
  if (!requestedEffectReason.trim()) throw new Error("Recovery requested effect reason must not be blank");

  return withRunLedgerCompoundTransaction(input.runDir, async (transaction) => {
    let manifest = await transaction.readManifestV2();
    if (manifest.terminal !== null) {
      throw new Error(`Cannot record recovery for terminal outcome ${manifest.terminal.outcome}`);
    }
    if (manifest.abandonment_path !== null || manifest.assurance_outcome === "abandoned") {
      throw new Error("Cannot record recovery for an abandoned run");
    }
    if (observation.run_id !== manifest.run_id) {
      throw new Error("Recovery observation run_id does not match the run ledger");
    }
    const preflightJournals = await scanRecoveryJournal(
      transaction.runDir,
      manifest.run_id,
      input.hooks,
    );
    assertPendingAuthorizationBeforeReconciliation(
      preflightJournals,
      validateGlobalDecisionChain(preflightJournals),
      observation,
      requestedEffect,
      requestedEffectReason,
    );
    manifest = await reconcileRecoveryJournalLocked(transaction, input.hooks);
    const journals = await scanRecoveryJournal(transaction.runDir, manifest.run_id, input.hooks);
    const decisionChain = validateGlobalDecisionChain(journals);
    const scopeJournal = journals.get(observation.scope_id);
    const replayIndex = scopeJournal?.decisions.findIndex((decision) =>
      decision.observation.effect_attempt_id === observation.effect_attempt_id) ?? -1;
    if (scopeJournal && replayIndex >= 0) {
      const existing = scopeJournal.decisions[replayIndex];
      if (
        !exactEqual(existing.observation, observation)
        || existing.requested_effect !== requestedEffect
        || existing.requested_effect_reason !== requestedEffectReason
      ) throw new Error("Same effect attempt replay conflicts with its recorded recovery decision");
      if (existing.diagnostic_intent !== undefined) {
        if (input.diagnosticContext === undefined) {
          throw new Error("Terminal recovery replay requires its exact diagnostic context");
        }
        const expectedIntent = await buildDiagnosticIntent({
          runDir: transaction.runDir,
          manifest,
          context: input.diagnosticContext,
          observation,
          previousObservation: scopeJournal.decisions[replayIndex - 1]?.observation ?? null,
          requestedEffect,
          requestedEffectReason,
          guardAction: existing.guard_action as "diagnostic_stop" | "exhausted_stop",
          sequence: existing.sequence,
          decisionPath: scopeJournal.paths[replayIndex],
          recordedAt: existing.recorded_at,
        });
        if (!exactEqual(expectedIntent, existing.diagnostic_intent)) {
          throw new Error("Same effect attempt replay conflicts with its diagnostic intent");
        }
      }
      return {
        artifact_path: scopeJournal.paths[replayIndex],
        decision: existing,
        manifest,
      };
    }

    assertObservationAuthorizationBinding(
      manifest,
      journals,
      decisionChain,
      observation,
      requestedEffect,
      requestedEffectReason,
    );

    const previous = ownRecoveryScopeState(manifest.recovery.scopes, observation.scope_id);
    const guard = evaluateRecoveryGuard({
      previous,
      observation,
      requestedEffect,
      requestedEffectReason,
    });
    const sequence = (previous?.head_sequence ?? 0) + 1;
    if (!Number.isSafeInteger(sequence) || sequence < 1) {
      throw new Error("Recovery journal sequence successor must be a positive safe integer");
    }
    const artifactPath = recoveryDecisionPath(
      observation.scope_id,
      sequence,
      recoveryObservationId(observation),
    );
    const recordedAt = new Date().toISOString();
    const terminalGuard = guard.action === "diagnostic_stop" || guard.action === "exhausted_stop";
    if (terminalGuard && input.diagnosticContext === undefined) {
      throw new Error("Terminal recovery decisions require diagnostic context before persistence");
    }
    const diagnosticIntent = terminalGuard
      ? await buildDiagnosticIntent({
          runDir: transaction.runDir,
          manifest,
          context: input.diagnosticContext!,
          observation,
          previousObservation: scopeJournal?.decisions.at(-1)?.observation ?? null,
          requestedEffect,
          requestedEffectReason,
          guardAction: guard.action as "diagnostic_stop" | "exhausted_stop",
          sequence,
          decisionPath: artifactPath,
          recordedAt,
        })
      : undefined;
    const decision = recoveryDecisionArtifactV1Schema.parse({
      version: 1,
      run_id: manifest.run_id,
      scope_id: observation.scope_id,
      sequence,
      observation,
      requested_effect: requestedEffect,
      requested_effect_reason: requestedEffectReason,
      previous_state: previous ?? null,
      next_state: {
        ...nextStateAfterAuthorizationConsumption(previous, guard.next),
        head_sequence: sequence,
        head_decision_path: artifactPath,
      },
      guard_action: guard.action,
      previous_decision_event_id: decisionChain.at(-1)?.decision.decision_event_id ?? null,
      decision_event_id: recoveryDecisionEventId(
        observation,
        decisionChain.at(-1)?.decision.decision_event_id ?? null,
      ),
      ...(diagnosticIntent === undefined ? {} : { diagnostic_intent: diagnosticIntent }),
      recorded_at: recordedAt,
    });
    if (terminalGuard) {
      await mkdir(join(
        transaction.runDir,
        "recovery/scopes",
        recoveryScopePathComponent(observation.scope_id),
        "diagnostics",
      ), { recursive: true, mode: 0o700 });
    }
    try {
      await writeCreateOnceValidated(
        transaction.runDir,
        artifactPath,
        decision,
        recoveryDecisionArtifactV1Schema,
      );
    } catch (error: unknown) {
      if (errorCode(error) !== "EEXIST") throw error;
      const existing = await readOptionalValidatedArtifact(
        transaction.runDir,
        artifactPath,
        recoveryDecisionArtifactV1Schema,
      );
      if (existing === null || !exactEqual(existing, decision)) {
        throw new Error(`Recovery decision create-once conflict: ${artifactPath}`);
      }
    }
    await input.hooks?.afterDecisionArtifact?.();
    if (decision.diagnostic_intent !== undefined) {
      await writeDiagnosticRecoveryArtifact({
        runDir: transaction.runDir,
        artifact: decision.diagnostic_intent,
      });
      await input.hooks?.afterDiagnosticArtifact?.();
    }
    await appendRunEventOnce(
      transaction.runDir,
      decisionEventInput(decision, artifactPath),
    );
    await input.hooks?.afterDecisionEvent?.();
    manifest = await transaction.updateManifestV2({
      recovery: {
        ...manifest.recovery,
        active_scope: observation.scope_id,
        scopes: {
          ...manifest.recovery.scopes,
          [observation.scope_id]: decision.next_state,
        },
      },
    });
    await input.hooks?.afterManifestProjection?.();
    return { artifact_path: artifactPath, decision, manifest };
  });
}

const diagnosticAuthorizationInputSchema = z.object({
  actor: z.string().refine((value) => value.trim().length > 0),
  note: recoveryAuthorizationNoteSchema,
}).strict();

function diagnosticAuthorizationId(input: {
  run_id: string;
  scope_id: string;
  journal_sequence: number;
  decision_path: string;
  blocker_fingerprint: string;
  progress_subject_sha256: string;
  actor: string;
  note_sha256: string;
}): string {
  return `diagnostic-authorization:${createHash("sha256")
    .update(JSON.stringify({
      version: 1,
      run_id: input.run_id,
      scope_id: input.scope_id,
      journal_sequence: input.journal_sequence,
      decision_path: input.decision_path,
      blocker_fingerprint: input.blocker_fingerprint,
      progress_subject_sha256: input.progress_subject_sha256,
      actor: input.actor,
      note_sha256: input.note_sha256,
    }))
    .digest("hex")}`;
}

function assertRecoveryMutationAllowed(manifest: RunManifestV2, operation: string): void {
  if (manifest.terminal !== null) {
    throw new Error(`Cannot ${operation} for terminal outcome ${manifest.terminal.outcome}`);
  }
  if (manifest.abandonment_path !== null || manifest.assurance_outcome === "abandoned") {
    throw new Error(`Cannot ${operation} for an abandoned run`);
  }
}

export async function authorizeDiagnosticResume(input: {
  runDir: string;
  actor: string;
  note: string;
  hooks?: Pick<RecoveryLedgerHooks, "afterAuthorizationArtifact" | "afterAuthorizationEntriesRead">;
}): Promise<DiagnosticRecoveryAuthorizationV1> {
  const operator = diagnosticAuthorizationInputSchema.parse({
    actor: input.actor,
    note: input.note,
  });
  return withRunLedgerCompoundTransaction(input.runDir, async (transaction) => {
    let manifest = await transaction.readManifestV2();
    assertRecoveryMutationAllowed(manifest, "authorize diagnostic recovery");
    manifest = await reconcileRecoveryJournalLocked(transaction, input.hooks);
    const journals = await scanRecoveryJournal(transaction.runDir, manifest.run_id, input.hooks);
    const chain = validateGlobalDecisionChain(journals);
    const tail = chain.at(-1);
    const scopeId = tail?.decision.scope_id ?? null;
    if (scopeId === null || manifest.recovery.active_scope !== scopeId) {
      throw new Error("Diagnostic authorization requires the validated active global-chain tail scope");
    }
    const journal = journals.get(scopeId);
    const scope = ownRecoveryScopeState(manifest.recovery.scopes, scopeId);
    const head = journal?.decisions.at(-1);
    if (
      tail === undefined
      || journal === undefined
      || scope === undefined
      || head === undefined
      || tail.path !== journal.paths.at(-1)
      || scope.head_sequence !== head.sequence
      || scope.head_decision_path !== journal.paths.at(-1)
    ) {
      throw new Error("Diagnostic authorization active scope does not match its exact journal head");
    }
    const noteSha256 = createHash("sha256").update(operator.note).digest("hex");
    if (scope.blocker_fingerprint === null || scope.progress_subject_sha256 === null) {
      throw new Error("Diagnostic authorization requires blocker and progress head bindings");
    }
    const authorizationId = diagnosticAuthorizationId({
      run_id: manifest.run_id,
      scope_id: scopeId,
      journal_sequence: scope.head_sequence,
      decision_path: scope.head_decision_path!,
      blocker_fingerprint: scope.blocker_fingerprint,
      progress_subject_sha256: scope.progress_subject_sha256,
      actor: operator.actor,
      note_sha256: noteSha256,
    });
    const existing = authorizationForSequence(journal, head.sequence);
    if (existing !== undefined) {
      const expectedSubject = {
        version: 1 as const,
        authorization_id: authorizationId,
        run_id: manifest.run_id,
        scope_id: scopeId,
        journal_sequence: scope.head_sequence,
        decision_path: scope.head_decision_path!,
        blocker_fingerprint: scope.blocker_fingerprint,
        progress_subject_sha256: scope.progress_subject_sha256,
        actor: operator.actor,
        note: operator.note,
        note_sha256: noteSha256,
      };
      if (
        existing.authorization.authorization_id !== authorizationId
        || !Object.entries(expectedSubject).every(([key, value]) =>
          existing.authorization[key as keyof DiagnosticRecoveryAuthorizationV1] === value)
      ) {
        throw new Error("Diagnostic decision head already has a different authorization");
      }
      if (existing.consumption !== null) {
        throw new Error("Diagnostic recovery authorization has already been consumed");
      }
      if (!exactEqual(scope, authorizedScopeState(head.next_state, existing.path))) {
        throw new Error("Diagnostic recovery authorization manifest pointer conflicts with its artifact");
      }
      return existing.authorization;
    }
    if (scope.disposition !== "diagnostic_stop" || head.next_state.disposition !== "diagnostic_stop") {
      throw new Error("Recovery scope is not at a diagnostic stop");
    }
    if (!exactEqual(scope, head.next_state)) {
      throw new Error("Diagnostic recovery scope projection conflicts with its immutable decision head");
    }
    const artifactPath = diagnosticRecoveryAuthorizationPath(scopeId, authorizationId);
    const authorization = diagnosticRecoveryAuthorizationV1Schema.parse({
      version: 1,
      authorization_id: authorizationId,
      run_id: manifest.run_id,
      scope_id: scopeId,
      journal_sequence: scope.head_sequence,
      decision_path: scope.head_decision_path,
      blocker_fingerprint: scope.blocker_fingerprint,
      progress_subject_sha256: scope.progress_subject_sha256,
      actor: operator.actor,
      note: operator.note,
      note_sha256: noteSha256,
      recorded_at: new Date().toISOString(),
    });
    const nextScope = authorizedScopeState(scope, artifactPath);
    const nextRecovery = {
      ...manifest.recovery,
      active_scope: scopeId,
      scopes: {
        ...manifest.recovery.scopes,
        [scopeId]: nextScope,
      },
    };
    runManifestV2Schema.parse({ ...manifest, recovery: nextRecovery });
    try {
      await writeCreateOnceValidated(
        transaction.runDir,
        artifactPath,
        authorization,
        diagnosticRecoveryAuthorizationV1Schema,
      );
    } catch (error: unknown) {
      if (errorCode(error) !== "EEXIST") throw error;
      const conflicting = await readOptionalValidatedArtifact(
        transaction.runDir,
        artifactPath,
        diagnosticRecoveryAuthorizationV1Schema,
      );
      if (conflicting === null || !exactEqual(conflicting, authorization)) {
        throw new Error(`Diagnostic recovery authorization create-once conflict: ${artifactPath}`);
      }
    }
    await input.hooks?.afterAuthorizationArtifact?.();
    await transaction.updateManifestV2({ recovery: nextRecovery });
    return authorization;
  });
}

export async function claimAuthorizedRecoveryAttempt(input: {
  runDir: string;
  authorization: DiagnosticRecoveryAuthorizationV1;
  expectedSubject?: AuthorizedRecoverySubjectV1;
  hooks?: Pick<RecoveryLedgerHooks, "afterConsumptionArtifact" | "afterAuthorizationEntriesRead">;
}): Promise<DiagnosticRecoveryConsumptionV1> {
  const requestedAuthorization = diagnosticRecoveryAuthorizationV1Schema.parse(
    input.authorization,
  );
  return withRunLedgerCompoundTransaction(input.runDir, async (transaction) => {
    let manifest = await transaction.readManifestV2();
    assertRecoveryMutationAllowed(manifest, "claim diagnostic recovery");
    manifest = await reconcileRecoveryJournalLocked(transaction, input.hooks);
    const journals = await scanRecoveryJournal(transaction.runDir, manifest.run_id, input.hooks);
    const chain = validateGlobalDecisionChain(journals);
    const tail = chain.at(-1);
    if (
      tail === undefined
      || manifest.recovery.active_scope !== requestedAuthorization.scope_id
      || tail.decision.scope_id !== requestedAuthorization.scope_id
      || tail.decision.sequence !== requestedAuthorization.journal_sequence
      || tail.path !== requestedAuthorization.decision_path
    ) {
      throw new Error("Diagnostic recovery authorization is stale for the active global-chain head");
    }
    const journal = journals.get(requestedAuthorization.scope_id);
    const scope = ownRecoveryScopeState(
      manifest.recovery.scopes,
      requestedAuthorization.scope_id,
    );
    const bound = journal?.authorizations.find(
      ({ authorization }) =>
        authorization.authorization_id === requestedAuthorization.authorization_id,
    );
    if (
      journal === undefined
      || scope === undefined
      || bound === undefined
      || !exactEqual(bound.authorization, requestedAuthorization)
      || scope.authorization_path !== bound.path
      || !exactEqual(scope, authorizedScopeState(tail.decision.next_state, bound.path))
    ) {
      throw new Error("Diagnostic recovery authorization does not match the active run, scope, or head binding");
    }
    if (input.expectedSubject !== undefined) {
      assertExactAuthorizedSubject(input.expectedSubject, tail.decision, false);
    }
    if (bound.consumption !== null) return bound.consumption;
    const consumptionPath = diagnosticRecoveryConsumptionPath(
      requestedAuthorization.scope_id,
      requestedAuthorization.authorization_id,
    );
    const consumption = diagnosticRecoveryConsumptionV1Schema.parse({
      version: 1,
      authorization_id: requestedAuthorization.authorization_id,
      run_id: requestedAuthorization.run_id,
      scope_id: requestedAuthorization.scope_id,
      effect_attempt_id: `recovery-attempt:${createHash("sha256")
        .update(`brain-hands-recovery-attempt-v1\0${requestedAuthorization.authorization_id}`)
        .digest("hex")}`,
      consumed_at: new Date().toISOString(),
    });
    try {
      await writeCreateOnceValidated(
        transaction.runDir,
        consumptionPath,
        consumption,
        diagnosticRecoveryConsumptionV1Schema,
      );
    } catch (error: unknown) {
      if (errorCode(error) !== "EEXIST") throw error;
      const conflicting = await readOptionalValidatedArtifact(
        transaction.runDir,
        consumptionPath,
        diagnosticRecoveryConsumptionV1Schema,
      );
      if (conflicting === null || !exactEqual(conflicting, consumption)) {
        throw new Error(`Diagnostic recovery consumption create-once conflict: ${consumptionPath}`);
      }
    }
    await input.hooks?.afterConsumptionArtifact?.();
    return consumption;
  });
}

export async function writeDiagnosticRecoveryArtifact(input: {
  runDir: string;
  artifact: DiagnosticRecoveryArtifactV1;
}): Promise<DiagnosticRecoveryArtifactV1> {
  const artifact = diagnosticRecoveryArtifactV1Schema.parse(input.artifact);
  const path = recoveryDiagnosticPath(artifact.scope_id, artifact.journal_sequence);
  const existing = await readOptionalValidatedArtifact(
    input.runDir,
    path,
    diagnosticRecoveryArtifactV1Schema,
  );
  if (existing !== null) {
    if (!exactEqual(existing, artifact)) {
      throw new Error(`Recovery diagnostic create-once conflict: ${path}`);
    }
    return existing;
  }
  try {
    await writeCreateOnceValidated(
      input.runDir,
      path,
      artifact,
      diagnosticRecoveryArtifactV1Schema,
    );
  } catch (error: unknown) {
    if (errorCode(error) !== "EEXIST") throw error;
    const concurrent = await readOptionalValidatedArtifact(
      input.runDir,
      path,
      diagnosticRecoveryArtifactV1Schema,
    );
    if (concurrent === null || !exactEqual(concurrent, artifact)) {
      throw new Error(`Recovery diagnostic create-once conflict: ${path}`);
    }
    return concurrent;
  }
  return artifact;
}
