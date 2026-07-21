import { createHash } from "node:crypto";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { ZodType } from "zod";
import {
  diagnosticRecoveryAuthorizationV1Schema,
  diagnosticRecoveryConsumptionV1Schema,
  implementationResultSchema,
  persistedVerifierReviewSchema,
  recoveryProgressSubjectV1Schema,
  reviewPolicyDecisionSchema,
  runManifestV2Schema,
  verificationEvidenceSchema,
} from "../core/schema.js";
import { readManifestV2 } from "../core/ledger.js";
import { readOwnedEvidenceFile, readOwnedRunFile } from "../core/owned-evidence.js";
import type {
  DiagnosticRecoveryAuthorizationV1,
  ReviewPolicyDecision,
  RunManifestV2,
} from "../core/types.js";
import {
  blockerFingerprint,
  progressSubjectSha256,
  type RecoveryFailureClass,
  type RecoveryObservationV1,
  type RecoveryProgressSubjectV1,
  type RecoveryRequestedEffect,
} from "./recovery-policy.js";
import {
  claimAuthorizedRecoveryAttempt,
  diagnosticRecoveryAuthorizationPath,
  diagnosticRecoveryConsumptionPath,
  reconcileRecoveryJournal,
  recordRecoveryObservation,
  recoveryDiagnosticPath,
  recoveryDecisionArtifactV1Schema,
  type RecoveryDecisionArtifactV1,
  type RecoveryLedgerHooks,
} from "./recovery-ledger.js";

const FINDING_ID_PATTERN = /^finding:[a-f0-9]{64}$/;

export interface BuiltRecoveryProgress {
  subject: RecoveryProgressSubjectV1;
  sha256: string;
}

export interface RecoveryOwnedEvidenceRefs {
  implementation_path: string | null;
  verification_path: string | null;
  review_path: string | null;
}

export interface RecoveryRuntimeHooks extends RecoveryLedgerHooks {
  afterRecoveryDecision?: () => Promise<void>;
  afterDiagnosticArtifact?: () => Promise<void>;
}

type RecoveryRuntimeResult = {
  guard_action: "allow_next_effect" | "await_external_fix" | "diagnostic_stop" | "exhausted_stop";
  effect_attempt_id: string;
  diagnostic_path: string | null;
  manifest: RunManifestV2;
};

export type ReviewPolicyRecoveryGateResult = RecoveryRuntimeResult & (
  | {
      mode: "ordinary";
      policy_decision: ReviewPolicyDecision;
      recovery_decision: RecoveryDecisionArtifactV1;
      authorization_id: null;
    }
  | {
      mode: "authorized_attempt";
      policy_decision: ReviewPolicyDecision;
      recovery_decision: null;
      authorization_id: string;
    }
);

export type OperationalRecoveryGateResult =
  | {
      mode: "ordinary";
      authorization_id: null;
      effect_attempt_id: null;
      manifest: RunManifestV2;
    }
  | {
      mode: "blocked";
      guard_action: "diagnostic_stop" | "exhausted_stop";
      authorization_id: null;
      effect_attempt_id: null;
      manifest: RunManifestV2;
    }
  | {
      mode: "authorized_attempt";
      authorization_id: string;
      effect_attempt_id: string;
      manifest: RunManifestV2;
    };

function canonicalFindingIds(findingIds: string[]): string[] {
  if (!Array.isArray(findingIds)) throw new Error("Recovery finding identifiers must be an array");
  const sorted = [...findingIds].sort();
  if (sorted.some((findingId) => !FINDING_ID_PATTERN.test(findingId))) {
    throw new Error("Recovery finding identifiers must be canonical finding:<sha256> values");
  }
  if (new Set(sorted).size !== sorted.length) {
    throw new Error("Recovery finding identifiers must be unique");
  }
  return sorted;
}

function exactEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function inside(root: string, target: string): boolean {
  const relation = relative(root, target);
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}

async function ensureRecoveryRoot(runDir: string, manifest: RunManifestV2): Promise<void> {
  const runRoot = await realpath(resolve(runDir));
  const recoveryRoot = resolve(runRoot, "recovery");
  const scopesRoot = resolve(recoveryRoot, "scopes");
  if (!inside(runRoot, scopesRoot)) throw new Error("Recovery root resolves outside the run ledger");
  for (const path of [recoveryRoot, scopesRoot]) {
    let status = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (status === null) {
      if (manifest.recovery.active_scope !== null || Object.keys(manifest.recovery.scopes).length > 0) {
        throw new Error("Persisted recovery projection is missing its owned journal root");
      }
      await mkdir(path, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
      status = await lstat(path);
    }
    if (status.isSymbolicLink() || !status.isDirectory()) {
      throw new Error("Recovery journal root must be a real directory");
    }
    if (!inside(runRoot, await realpath(path))) {
      throw new Error("Recovery journal root escaped the run ledger");
    }
  }
}

function artifactSha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function artifactBelongsToWorkItem(label: string, actual: unknown, expected: string): boolean {
  if (actual === expected) return true;
  if (label !== "Verification" || typeof actual !== "string") return false;
  const prefix = `${expected}:quality-gate:`;
  if (!actual.startsWith(prefix)) return false;
  const [parentAttempt, pass, ...extra] = actual.slice(prefix.length).split(":");
  return (extra.length === 0 || (extra.length === 1 && /^authority-[a-f0-9]{16}$/.test(extra[0] ?? "")))
    && /^[1-9][0-9]*$/.test(parentAttempt ?? "")
    && (pass === "baseline" || /^[1-9][0-9]*$/.test(pass ?? ""));
}

async function readValidatedOwnedArtifact<T>(input: {
  runDir: string;
  path: string | undefined;
  root: string;
  schema: ZodType<T>;
  label: string;
  workItemId: string;
}): Promise<{ value: T; sha256: string } | null> {
  if (input.path === undefined) return null;
  const bytes = await readOwnedEvidenceFile(input.runDir, input.path, input.root);
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`${input.label} artifact is not valid JSON`, { cause: error });
  }
  const value = input.schema.parse(raw);
  if (
    !value
    || typeof value !== "object"
    || !("work_item_id" in value)
    || !artifactBelongsToWorkItem(input.label, value.work_item_id, input.workItemId)
  ) {
    throw new Error(`${input.label} artifact belongs to a foreign work item; expected ${input.workItemId}`);
  }
  if (
    input.label === "Verification"
    && "evidence_path" in value
    && value.evidence_path !== input.path
  ) {
    throw new Error("Verification artifact path does not match its owned evidence reference");
  }
  return { value, sha256: artifactSha256(bytes) };
}

export async function buildRecoveryProgressSubject(input: {
  runDir: string;
  manifest: RunManifestV2;
  workItemId: string;
  findingIds: string[];
  implementationPath?: string;
  verificationPath?: string;
  reviewPath?: string;
  reviewRevision?: number;
}): Promise<BuiltRecoveryProgress> {
  const suppliedManifest = runManifestV2Schema.parse(input.manifest) as RunManifestV2;
  const currentManifest = await readManifestV2(input.runDir);
  if (suppliedManifest.run_id !== currentManifest.run_id) {
    throw new Error("Recovery progress manifest does not match the run ledger");
  }
  if (
    suppliedManifest.approved_revision === null
    || suppliedManifest.approved_plan_revision === null
    || suppliedManifest.approved_revision !== suppliedManifest.approved_plan_revision
  ) {
    throw new Error("Recovery progress requires one exact approved plan revision");
  }
  const approvedRevision = suppliedManifest.approved_revision;
  const approvedPlan = suppliedManifest.plan_revisions[String(approvedRevision)];
  const currentApprovedPlan = currentManifest.plan_revisions[String(approvedRevision)];
  if (
    approvedPlan === undefined
    || approvedPlan.revision !== approvedRevision
    || currentManifest.approved_revision !== approvedRevision
    || currentManifest.approved_plan_revision !== approvedRevision
    || currentApprovedPlan === undefined
    || !exactEqual(currentApprovedPlan, approvedPlan)
  ) {
    throw new Error("Recovery progress approved plan revision does not match the current manifest");
  }
  if (suppliedManifest.source_commit !== currentManifest.source_commit) {
    throw new Error("Recovery progress candidate commit does not match the current manifest");
  }
  const findingIds = canonicalFindingIds(input.findingIds);
  const implementation = await readValidatedOwnedArtifact({
    runDir: input.runDir,
    path: input.implementationPath,
    root: "implementation/",
    schema: implementationResultSchema,
    label: "Implementation",
    workItemId: input.workItemId,
  });
  const verification = await readValidatedOwnedArtifact({
    runDir: input.runDir,
    path: input.verificationPath,
    root: "verification/",
    schema: verificationEvidenceSchema,
    label: "Verification",
    workItemId: input.workItemId,
  });
  const review = await readValidatedOwnedArtifact({
    runDir: input.runDir,
    path: input.reviewPath,
    root: "reviews/",
    schema: persistedVerifierReviewSchema,
    label: "Review",
    workItemId: input.workItemId,
  });
  const subject = recoveryProgressSubjectV1Schema.parse({
    version: 1,
    approved_plan_sha256: approvedPlan.sha256,
    candidate_commit: suppliedManifest.source_commit,
    implementation_artifact_sha256: implementation?.sha256 ?? null,
    verification_artifact_sha256: verification?.sha256 ?? null,
    review_artifact_sha256: review?.sha256 ?? null,
    review_revision: input.reviewRevision ?? null,
    finding_ids: findingIds,
  }) as RecoveryProgressSubjectV1;
  return { subject, sha256: progressSubjectSha256(subject) };
}

function validateProgress(
  progress: BuiltRecoveryProgress,
  findingIds: string[],
): BuiltRecoveryProgress {
  const subject = recoveryProgressSubjectV1Schema.parse(progress.subject) as RecoveryProgressSubjectV1;
  const expectedSha256 = progressSubjectSha256(subject);
  if (progress.sha256 !== expectedSha256) {
    throw new Error("Recovery progress SHA-256 does not match its subject");
  }
  if (!exactEqual(subject.finding_ids, canonicalFindingIds(findingIds))) {
    throw new Error(`Recovery progress finding identifiers do not match the recovery observation: progress=${subject.finding_ids.join(",") || "none"}; observation=${canonicalFindingIds(findingIds).join(",") || "none"}`);
  }
  return { subject, sha256: expectedSha256 };
}

function defaultEvidenceRefs(input?: Partial<RecoveryOwnedEvidenceRefs>): RecoveryOwnedEvidenceRefs {
  return {
    implementation_path: input?.implementation_path ?? null,
    verification_path: input?.verification_path ?? null,
    review_path: input?.review_path ?? null,
  };
}

async function activeAuthorization(
  runDir: string,
  manifest: RunManifestV2,
  scopeId: string,
  progressSha256: string,
): Promise<DiagnosticRecoveryAuthorizationV1 | null> {
  if (manifest.recovery.active_scope !== scopeId) return null;
  const scope = Object.prototype.hasOwnProperty.call(manifest.recovery.scopes, scopeId)
    ? manifest.recovery.scopes[scopeId]
    : undefined;
  if (scope?.authorization_path == null) return null;
  const authorization = diagnosticRecoveryAuthorizationV1Schema.parse(JSON.parse(
    (await readOwnedRunFile(runDir, scope.authorization_path)).toString("utf8"),
  ));
  if (
    authorization.run_id !== manifest.run_id
    || authorization.scope_id !== scopeId
    || authorization.progress_subject_sha256 !== progressSha256
  ) {
    throw new Error("Active diagnostic authorization does not match the requested recovery progress");
  }
  return authorization;
}

function observation(input: {
  manifest: RunManifestV2;
  scopeId: string;
  operation: string;
  failureClass: RecoveryFailureClass;
  blockerCode: string;
  findingIds: string[];
  effectAttemptId: string;
  progress: BuiltRecoveryProgress;
}): RecoveryObservationV1 {
  const subject = {
    version: 1 as const,
    scope_id: input.scopeId,
    stage: input.manifest.stage,
    operation: input.operation,
    failure_class: input.failureClass,
    blocker_code: input.blockerCode,
    finding_ids: canonicalFindingIds(input.findingIds),
  };
  return {
    ...subject,
    run_id: input.manifest.run_id,
    effect_attempt_id: input.effectAttemptId,
    blocker_fingerprint: blockerFingerprint(subject),
    progress_subject_sha256: input.progress.sha256,
  };
}

function ledgerHooks(hooks?: RecoveryRuntimeHooks): RecoveryLedgerHooks | undefined {
  if (hooks === undefined) return undefined;
  return {
    ...hooks,
    afterDecisionArtifact: async () => {
      await hooks.afterDecisionArtifact?.();
      await hooks.afterRecoveryDecision?.();
    },
  };
}

export async function gateReviewPolicyEffect(input: {
  runDir: string;
  scopeId: string;
  operation: string;
  effectAttemptId: string;
  decision: ReviewPolicyDecision;
  observationStage?: RunManifestV2["stage"];
  reviewCyclePath?: string;
  progress: BuiltRecoveryProgress;
  ownedEvidenceRefs?: Partial<RecoveryOwnedEvidenceRefs>;
  hooks?: RecoveryRuntimeHooks;
}): Promise<ReviewPolicyRecoveryGateResult> {
  const decision = reviewPolicyDecisionSchema.parse(input.decision) as ReviewPolicyDecision;
  const progress = validateProgress(input.progress, decision.finding_ids);
  let manifest = await readManifestV2(input.runDir);
  await ensureRecoveryRoot(input.runDir, manifest);
  manifest = await reconcileRecoveryJournal(input.runDir);
  const observationStage = input.observationStage ?? manifest.stage;
  const authorization = await activeAuthorization(input.runDir, manifest, input.scopeId, progress.sha256);
  if (authorization !== null) {
    const claimed = await claimAuthorizedRecoveryAttempt({
      runDir: input.runDir,
      authorization,
      expectedSubject: {
        run_id: manifest.run_id,
        scope_id: input.scopeId,
        stage: observationStage,
        operation: input.operation,
        failure_class: "implementation_failure",
        blocker_code: decision.reason_code,
        finding_ids: decision.finding_ids,
        requested_effect: decision.action,
        requested_effect_reason: decision.reason_code,
        progress_subject_sha256: progress.sha256,
      },
      hooks: input.hooks,
    });
    manifest = await readManifestV2(input.runDir);
    return {
      mode: "authorized_attempt",
      guard_action: "allow_next_effect",
      effect_attempt_id: claimed.effect_attempt_id,
      policy_decision: decision,
      recovery_decision: null,
      authorization_id: authorization.authorization_id,
      diagnostic_path: null,
      manifest,
    };
  }
  const recovery = await recordRecoveryObservation({
    runDir: input.runDir,
    observation: observation({
      manifest: observationStage === manifest.stage ? manifest : { ...manifest, stage: observationStage },
      scopeId: input.scopeId,
      operation: input.operation,
      failureClass: "implementation_failure",
      blockerCode: decision.reason_code,
      findingIds: decision.finding_ids,
      effectAttemptId: input.effectAttemptId,
      progress,
    }),
    requestedEffect: decision.action,
    requestedEffectReason: decision.reason_code,
    ...(input.reviewCyclePath === undefined ? {} : {
      diagnosticContext: {
        classification: {
          kind: "review_policy" as const,
          review_cycle_path: input.reviewCyclePath,
          effect_id: input.effectAttemptId,
        },
        policy_decision: decision,
        owned_evidence_refs: defaultEvidenceRefs(input.ownedEvidenceRefs),
        progress,
      },
    }),
    hooks: ledgerHooks(input.hooks),
  });
  const diagnosticPath = recovery.decision.diagnostic_intent === undefined
    ? null
    : recoveryDiagnosticPath(recovery.decision.scope_id, recovery.decision.sequence);
  return {
    mode: "ordinary",
    guard_action: recovery.decision.guard_action,
    effect_attempt_id: recovery.decision.observation.effect_attempt_id,
    policy_decision: decision,
    recovery_decision: recovery.decision,
    authorization_id: null,
    diagnostic_path: diagnosticPath,
    manifest: recovery.manifest,
  };
}

export async function gateOperationalRecoveryAttempt(input: {
  runDir: string;
  scopeId: string;
  operation: string;
  requestedEffect: RecoveryRequestedEffect;
  requestedEffectReason: string;
  findingIds: string[];
  classification: { failure_class: RecoveryFailureClass; blocker_code: string };
  progress: BuiltRecoveryProgress;
  allowDifferentAuthorizedSubject?: boolean;
  hooks?: RecoveryRuntimeHooks;
}): Promise<OperationalRecoveryGateResult> {
  const findingIds = canonicalFindingIds(input.findingIds);
  const progress = validateProgress(input.progress, findingIds);
  let manifest = await readManifestV2(input.runDir);
  await ensureRecoveryRoot(input.runDir, manifest);
  manifest = await reconcileRecoveryJournal(input.runDir);
  const scopeBeforeGate = Object.prototype.hasOwnProperty.call(manifest.recovery.scopes, input.scopeId)
    ? manifest.recovery.scopes[input.scopeId]
    : undefined;
  if (scopeBeforeGate?.authorization_path) {
    const pendingAuthorization = diagnosticRecoveryAuthorizationV1Schema.parse(JSON.parse(
      (await readOwnedRunFile(input.runDir, scopeBeforeGate.authorization_path)).toString("utf8"),
    ));
    const consumption = await readOwnedRunFile(
      input.runDir,
      diagnosticRecoveryConsumptionPath(input.scopeId, pendingAuthorization.authorization_id),
    ).then((bytes) => diagnosticRecoveryConsumptionV1Schema.parse(JSON.parse(bytes.toString("utf8"))))
      .catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      });
    if (consumption !== null && pendingAuthorization.progress_subject_sha256 !== progress.sha256) {
      const authorizedDecision = recoveryDecisionArtifactV1Schema.parse(JSON.parse(
        (await readOwnedRunFile(input.runDir, pendingAuthorization.decision_path)).toString("utf8"),
      ));
      const authorizedFindingIds = canonicalFindingIds(authorizedDecision.observation.finding_ids);
      const authorizedProgressSubject = recoveryProgressSubjectV1Schema.parse({
        ...progress.subject,
        finding_ids: authorizedFindingIds,
      }) as RecoveryProgressSubjectV1;
      await recordAuthorizedRecoveryOutcome({
        runDir: input.runDir,
        scopeId: input.scopeId,
        operation: authorizedDecision.observation.operation,
        authorizationId: pendingAuthorization.authorization_id,
        effectAttemptId: consumption.effect_attempt_id,
        outcome: {
          kind: "success",
          requestedEffect: authorizedDecision.requested_effect,
          requestedEffectReason: authorizedDecision.requested_effect_reason,
          findingIds: authorizedFindingIds,
          classification: {
            failure_class: authorizedDecision.observation.failure_class,
            blocker_code: authorizedDecision.observation.blocker_code,
          },
        },
        progress: {
          subject: authorizedProgressSubject,
          sha256: progressSubjectSha256(authorizedProgressSubject),
        },
        observationStage: authorizedDecision.observation.stage,
      });
      manifest = await readManifestV2(input.runDir);
    }
  }
  const authorization = await activeAuthorization(
    input.runDir,
    manifest,
    input.scopeId,
    progress.sha256,
  );
  if (authorization === null) {
    const scope = Object.prototype.hasOwnProperty.call(manifest.recovery.scopes, input.scopeId)
      ? manifest.recovery.scopes[input.scopeId]
      : undefined;
    if (scope?.disposition === "diagnostic_stop" || scope?.disposition === "exhausted") {
      return {
        mode: "blocked",
        guard_action: scope.disposition === "diagnostic_stop" ? "diagnostic_stop" : "exhausted_stop",
        authorization_id: null,
        effect_attempt_id: null,
        manifest,
      };
    }
    return {
      mode: "ordinary",
      authorization_id: null,
      effect_attempt_id: null,
      manifest,
    };
  }
  if (input.allowDifferentAuthorizedSubject === true) {
    const scope = manifest.recovery.scopes[input.scopeId];
    const head = scope?.head_decision_path === null || scope?.head_decision_path === undefined
      ? null
      : recoveryDecisionArtifactV1Schema.parse(JSON.parse(
          (await readOwnedRunFile(input.runDir, scope.head_decision_path)).toString("utf8"),
        ));
    const exactSubject = head !== null
      && head.observation.run_id === manifest.run_id
      && head.observation.scope_id === input.scopeId
      && head.observation.stage === manifest.stage
      && head.observation.operation === input.operation
      && head.observation.failure_class === input.classification.failure_class
      && head.observation.blocker_code === input.classification.blocker_code
      && exactEqual(head.observation.finding_ids, findingIds)
      && head.requested_effect === input.requestedEffect
      && head.requested_effect_reason === input.requestedEffectReason
      && head.observation.progress_subject_sha256 === progress.sha256;
    if (!exactSubject) {
      return {
        mode: "ordinary",
        authorization_id: null,
        effect_attempt_id: null,
        manifest,
      };
    }
  }
  const claimed = await claimAuthorizedRecoveryAttempt({
    runDir: input.runDir,
    authorization,
    expectedSubject: {
      run_id: manifest.run_id,
      scope_id: input.scopeId,
      stage: manifest.stage,
      operation: input.operation,
      failure_class: input.classification.failure_class,
      blocker_code: input.classification.blocker_code,
      finding_ids: findingIds,
      requested_effect: input.requestedEffect,
      requested_effect_reason: input.requestedEffectReason,
      progress_subject_sha256: progress.sha256,
    },
    hooks: input.hooks,
  });
  return {
    mode: "authorized_attempt",
    authorization_id: authorization.authorization_id,
    effect_attempt_id: claimed.effect_attempt_id,
    manifest: await readManifestV2(input.runDir),
  };
}

export async function recordOperationalRecovery(input: {
  runDir: string;
  scopeId: string;
  operation: string;
  effectAttemptId: string;
  requestedEffect: RecoveryRequestedEffect;
  requestedEffectReason: string;
  findingIds: string[];
  classification:
    | { failure_class: RecoveryFailureClass; blocker_code: string }
    | { failure_class: "corrupt_state"; blocker_code: "corrupt_state" };
  error: unknown;
  progress: BuiltRecoveryProgress;
  ownedEvidenceRefs?: Partial<RecoveryOwnedEvidenceRefs>;
  hooks?: RecoveryRuntimeHooks;
}): Promise<RecoveryRuntimeResult & { recovery_decision: RecoveryDecisionArtifactV1 }> {
  void input.error;
  if (input.classification.failure_class === "corrupt_state") {
    throw new Error("Corrupt state is non-authorizable and must fail closed outside recovery recording");
  }
  const findingIds = canonicalFindingIds(input.findingIds);
  const progress = validateProgress(input.progress, findingIds);
  let manifest = await readManifestV2(input.runDir);
  await ensureRecoveryRoot(input.runDir, manifest);
  manifest = await reconcileRecoveryJournal(input.runDir);
  const recovery = await recordRecoveryObservation({
    runDir: input.runDir,
    observation: observation({
      manifest,
      scopeId: input.scopeId,
      operation: input.operation,
      failureClass: input.classification.failure_class,
      blockerCode: input.classification.blocker_code,
      findingIds,
      effectAttemptId: input.effectAttemptId,
      progress,
    }),
    requestedEffect: input.requestedEffect,
    requestedEffectReason: input.requestedEffectReason,
    diagnosticContext: {
      classification: {
        kind: "operational",
        failure_class: input.classification.failure_class,
        blocker_code: input.classification.blocker_code,
      },
      policy_decision: null,
      owned_evidence_refs: defaultEvidenceRefs(input.ownedEvidenceRefs),
      progress,
    },
    hooks: ledgerHooks(input.hooks),
  });
  const diagnosticPath = recovery.decision.diagnostic_intent === undefined
    ? null
    : recoveryDiagnosticPath(recovery.decision.scope_id, recovery.decision.sequence);
  return {
    guard_action: recovery.decision.guard_action,
    effect_attempt_id: recovery.decision.observation.effect_attempt_id,
    recovery_decision: recovery.decision,
    diagnostic_path: diagnosticPath,
    manifest: recovery.manifest,
  };
}

export async function recordAuthorizedRecoveryOutcome(input: {
  runDir: string;
  scopeId: string;
  operation: string;
  authorizationId: string;
  effectAttemptId: string;
  outcome: {
    kind: "success" | "failure";
    decision?: ReviewPolicyDecision;
    requestedEffect?: RecoveryRequestedEffect;
    requestedEffectReason?: string;
    findingIds?: string[];
    classification?: { failure_class: RecoveryFailureClass; blocker_code: string };
    error?: unknown;
  };
  progress: BuiltRecoveryProgress;
  observationStage?: RunManifestV2["stage"];
  ownedEvidenceRefs?: Partial<RecoveryOwnedEvidenceRefs>;
  hooks?: RecoveryRuntimeHooks;
}): Promise<RecoveryRuntimeResult & { recovery_decision: RecoveryDecisionArtifactV1 }> {
  void input.outcome.error;
  let manifest = await readManifestV2(input.runDir);
  await ensureRecoveryRoot(input.runDir, manifest);
  manifest = await reconcileRecoveryJournal(input.runDir);
  const scope = Object.prototype.hasOwnProperty.call(manifest.recovery.scopes, input.scopeId)
    ? manifest.recovery.scopes[input.scopeId]
    : undefined;
  const authorizationPath = diagnosticRecoveryAuthorizationPath(
    input.scopeId,
    input.authorizationId,
  );
  const authorization = diagnosticRecoveryAuthorizationV1Schema.parse(JSON.parse(
    (await readOwnedRunFile(input.runDir, authorizationPath)).toString("utf8"),
  ));
  if (
    authorization.authorization_id !== input.authorizationId
    || authorization.run_id !== manifest.run_id
    || authorization.scope_id !== input.scopeId
  ) {
    throw new Error("Claimed diagnostic authorization does not match its immediate recovery binding");
  }
  const consumption = diagnosticRecoveryConsumptionV1Schema.parse(JSON.parse(
    (await readOwnedRunFile(input.runDir, diagnosticRecoveryConsumptionPath(
      input.scopeId,
      input.authorizationId,
    ))).toString("utf8"),
  ));
  if (
    consumption.authorization_id !== input.authorizationId
    || consumption.run_id !== manifest.run_id
    || consumption.scope_id !== input.scopeId
    || consumption.effect_attempt_id !== input.effectAttemptId
  ) {
    throw new Error("Claimed diagnostic recovery consumption does not match the authorized attempt");
  }
  const activeBinding = manifest.recovery.active_scope === input.scopeId
    && scope?.authorization_path === authorizationPath
    && authorization.journal_sequence === scope.head_sequence
    && authorization.decision_path === scope.head_decision_path
    && authorization.blocker_fingerprint === scope.blocker_fingerprint
    && authorization.progress_subject_sha256 === scope.progress_subject_sha256;
  const replayBinding = manifest.recovery.active_scope === input.scopeId
    && scope?.authorization_path === null
    && scope.head_sequence === authorization.journal_sequence + 1;
  if (!activeBinding && !replayBinding) {
    throw new Error("Claimed diagnostic authorization does not match the active recovery scope");
  }

  const decision = input.outcome.decision === undefined
    ? undefined
    : reviewPolicyDecisionSchema.parse(input.outcome.decision) as ReviewPolicyDecision;
  const requestedEffect = decision?.action ?? input.outcome.requestedEffect;
  const requestedEffectReason = decision?.reason_code ?? input.outcome.requestedEffectReason;
  const findingIds = canonicalFindingIds(decision?.finding_ids ?? input.outcome.findingIds ?? []);
  if (requestedEffect === undefined || requestedEffectReason === undefined) {
    throw new Error("Authorized recovery outcome requires an exact requested effect and reason");
  }
  const progress = validateProgress(input.progress, findingIds);
  if (
    input.outcome.kind === "success"
    && progress.sha256 === authorization.progress_subject_sha256
  ) {
    throw new Error("Authorized recovery success requires changed owned-evidence progress");
  }
  const classification = input.outcome.kind === "success" && decision !== undefined
    ? { failure_class: "implementation_failure" as const, blocker_code: decision.reason_code }
    : input.outcome.classification;
  if (classification === undefined) {
    throw new Error("Authorized recovery outcome requires an explicit failure classification");
  }
  const recovery = await recordRecoveryObservation({
    runDir: input.runDir,
    observation: observation({
      manifest: input.observationStage === undefined ? manifest : { ...manifest, stage: input.observationStage },
      scopeId: input.scopeId,
      operation: input.operation,
      failureClass: classification.failure_class,
      blockerCode: classification.blocker_code,
      findingIds,
      effectAttemptId: input.effectAttemptId,
      progress,
    }),
    requestedEffect,
    requestedEffectReason,
    ...(input.outcome.kind === "failure" ? {
      diagnosticContext: {
        classification: {
          kind: "operational" as const,
          failure_class: classification.failure_class,
          blocker_code: classification.blocker_code,
        },
        policy_decision: null,
        owned_evidence_refs: defaultEvidenceRefs(input.ownedEvidenceRefs),
        progress,
      },
    } : {}),
    hooks: ledgerHooks(input.hooks),
  });
  return {
    guard_action: recovery.decision.guard_action,
    effect_attempt_id: recovery.decision.observation.effect_attempt_id,
    recovery_decision: recovery.decision,
    diagnostic_path: recovery.decision.diagnostic_intent === undefined
      ? null
      : recoveryDiagnosticPath(recovery.decision.scope_id, recovery.decision.sequence),
    manifest: recovery.manifest,
  };
}
