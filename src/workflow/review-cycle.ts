import { createHash } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type {
  ReviewAccounting,
  ReviewCycleProgressReference,
  ReviewCycleState,
  ReviewPhase,
  ReviewPolicyDecision,
} from "../core/types.js";
import {
  reviewAccountingSchema,
  reviewCycleStateSchema,
  reviewPolicyDecisionSchema,
} from "../core/schema.js";
import {
  readOptionalValidatedArtifact,
  withRunLedgerCompoundTransaction,
  writeCreateOnceValidated,
} from "../core/ledger.js";
import type { RunLedgerTransaction } from "../core/ledger.js";
import { readOwnedEvidenceFile } from "./owned-evidence.js";

export type ReviewAccountingMutationKind =
  | "initial"
  | "failed_fix"
  | "successful_fix"
  | "successful_action_fix"
  | "self_review_fix";

export interface BeginReviewCycleInput {
  run_dir: string;
  work_item_id: string;
  phase: ReviewPhase;
  review_revision: number;
  policy_hash: string;
  finding_ids: string[];
  accounting_before: ReviewAccounting;
  work_item_progress_reference?: ReviewCycleProgressReference;
  evaluate: () => ReviewPolicyDecision;
}

export interface ReviewCycleHooks {
  afterDecisionPersisted?: () => Promise<void>;
  afterReservationPersisted?: () => Promise<void>;
  afterMarkerPersisted?: () => Promise<void>;
  afterReservationCompletionPersisted?: () => Promise<void>;
  afterAccountingPersisted?: () => Promise<void>;
  afterQualityRecoveryAttemptPersisted?: () => Promise<void>;
}

export interface ReviewEffectInput {
  run_dir: string;
  cycle: ReviewCycleState;
  owner: string;
}

export type ReviewEffectClaimResult =
  | { status: "acquired"; cycle: ReviewCycleState }
  | { status: "complete"; cycle: ReviewCycleState }
  | { status: "blocked"; cycle: ReviewCycleState };

export class AmbiguousEffectError extends Error {
  readonly cycle: ReviewCycleState;

  constructor(cycle: ReviewCycleState) {
    super(`Review effect ${cycle.effect_id} has an ambiguous persisted in-progress claim`);
    this.name = "AmbiguousEffectError";
    this.cycle = cycle;
  }
}

export interface CompleteReviewEffectInput extends ReviewEffectInput {
  outcome: "complete" | "blocked";
  result: unknown;
}

export interface IncrementSuccessfulFixInput extends ReviewEffectInput {
  mutation_id: string;
  kind: "successful_fix" | "successful_action_fix";
  effect_action: "fix" | "quality_recovery";
}

export interface IncrementSelfReviewMutationInput {
  run_dir: string;
  mutation_id: string;
}

export interface ReserveFixSlotInput extends ReviewEffectInput {
  mutation_id: string;
  effect_action: "fix" | "quality_recovery";
}

export type ReserveFixSlotResult =
  | { status: "admitted"; mutation_id: string }
  | { status: "exhausted" };

export interface CommitReservedFixSlotInput extends ReviewEffectInput {
  mutation_id: string;
  effect_action: "fix" | "quality_recovery";
}

export type AssertChargedFixSlotInput = Omit<CommitReservedFixSlotInput, "effect_action">;

const accountingMarkerShape = {
  mutation_id: z.string().trim().min(1),
  kind: z.enum(["successful_fix", "successful_action_fix", "self_review_fix"]),
  cycle_id: z.string().regex(/^review-cycle:[a-f0-9]{64}$/).optional(),
  effect_id: z.string().regex(/^review-effect:[a-f0-9]{64}$/).optional(),
  effect_owner: z.string().trim().min(1).optional(),
  effect_action: z.enum(["fix", "quality_recovery"]).optional(),
  accounting_before: reviewAccountingSchema,
  accounting_after: reviewAccountingSchema,
} as const;

function validateAccountingMarker(
  marker: z.infer<typeof accountingMarkerBaseSchema>,
  context: z.core.$RefinementCtx<z.infer<typeof accountingMarkerBaseSchema>>,
  requireEffectAction: boolean,
): void {
  const isSelfReview = marker.kind === "self_review_fix";
  const effectProvenance = [marker.cycle_id, marker.effect_id, marker.effect_owner];
  const hasAnyEffectProvenance = effectProvenance.some((value) => value !== undefined);
  const hasAllEffectProvenance = effectProvenance.every((value) => value !== undefined);
  if (isSelfReview && (hasAnyEffectProvenance || marker.effect_action !== undefined)) {
    context.addIssue({ code: "custom", message: "Self-review accounting is separate from review effects" });
  }
  if (!isSelfReview && (!hasAllEffectProvenance || (requireEffectAction && marker.effect_action === undefined))) {
    context.addIssue({ code: "custom", message: "Fix accounting requires review-effect provenance" });
  }
  const expectedAfter = nextAccounting(marker.accounting_before, { kind: marker.kind });
  if (JSON.stringify(marker.accounting_after) !== JSON.stringify(expectedAfter)) {
    context.addIssue({ code: "custom", message: "Review accounting marker must contain exactly one counter mutation" });
  }
}

const accountingMarkerBaseSchema = z.object(accountingMarkerShape).strict();
const accountingMarkerReadSchema = accountingMarkerBaseSchema
  .superRefine((marker, context) => validateAccountingMarker(marker, context, false));
const accountingMarkerSchema = z.object(accountingMarkerShape).strict()
  .superRefine((marker, context) => validateAccountingMarker(marker, context, true));

const advanceEffectResultSchema = z.object({
  commit_sha: z.string().trim().min(1),
}).strict();

const policyCommitResultSchema = z.object({
  cycle_id: z.string().regex(/^review-cycle:[a-f0-9]{64}$/),
  effect_id: z.string().regex(/^review-effect:[a-f0-9]{64}$/),
  commit_sha: z.string().trim().min(1),
}).strict();

function policyCommitResultPath(effectId: string): string {
  return `reviews/effects/${Buffer.from(effectId, "utf8").toString("base64url")}/commit.json`;
}

export async function recordPolicyCommitResult(
  runDir: string,
  cycle: ReviewCycleState,
  commitSha: string,
): Promise<string> {
  const record = policyCommitResultSchema.parse({ cycle_id: cycle.cycle_id, effect_id: cycle.effect_id, commit_sha: commitSha });
  const path = policyCommitResultPath(cycle.effect_id);
  const existing = await readOptionalValidatedArtifact(runDir, path, policyCommitResultSchema);
  if (existing) {
    if (JSON.stringify(existing) !== JSON.stringify(record)) throw new Error("Policy commit result conflicts with immutable provenance");
    return existing.commit_sha;
  }
  await writeCreateOnceValidated(runDir, path, record, policyCommitResultSchema);
  return record.commit_sha;
}

export async function loadPolicyCommitResult(
  runDir: string,
  cycle: ReviewCycleState,
): Promise<string | null> {
  const record = await readOptionalValidatedArtifact(runDir, policyCommitResultPath(cycle.effect_id), policyCommitResultSchema);
  if (!record) return null;
  if (record.cycle_id !== cycle.cycle_id || record.effect_id !== cycle.effect_id) {
    throw new Error("Policy commit result provenance does not match its review cycle");
  }
  return record.commit_sha;
}

type AccountingMarker = z.infer<typeof accountingMarkerReadSchema>;

const fixReservationShape = {
  mutation_id: z.string().trim().min(1),
  cycle_id: z.string().regex(/^review-cycle:[a-f0-9]{64}$/),
  effect_id: z.string().regex(/^review-effect:[a-f0-9]{64}$/),
  effect_owner: z.string().trim().min(1),
} as const;

const fixReservationReadSchema = z.object({
  ...fixReservationShape,
  effect_action: z.enum(["fix", "quality_recovery"]).optional(),
}).strict();
const fixReservationSchema = z.object({
  ...fixReservationShape,
  effect_action: z.enum(["fix", "quality_recovery"]),
}).strict();

const fixReservationCompletionSchema = fixReservationSchema.extend({
  status: z.literal("charged"),
}).strict();
const fixReservationCompletionReadSchema = fixReservationReadSchema.extend({
  status: z.literal("charged"),
}).strict();

const actionInvocationProfileSchema = z.object({
  kind: z.enum(["primary", "backup"]),
  model: z.string().trim().min(1),
  reasoning_effort: z.string().trim().min(1),
}).strict();

const actionInvocationShape = {
  effect_id: z.string().regex(/^review-effect:[a-f0-9]{64}$/),
  review_revision: z.number().int().positive(),
  action_id: z.string().trim().min(1),
  action_attempt: z.number().int().positive(),
  report_path: z.string().trim().min(1),
  substage: z.enum(["primary_fix", "quality_recovery"]),
  started_profile: actionInvocationProfileSchema,
} as const;

const actionInvocationClaimSchema = z.object({
  ...actionInvocationShape,
  state: z.literal("started"),
  completed_profile: z.null(),
}).strict();

const actionInvocationCompletionSchema = z.object({
  ...actionInvocationShape,
  state: z.literal("complete"),
  completed_profile: actionInvocationProfileSchema,
  report_sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

const normalFixEffectResultSchema = z.object({
  attempt: z.number().int().positive(),
  implementation_path: z.string().trim().min(1),
}).strict();

const orderedFixEffectResultSchema = z.object({
  kind: z.enum(["complete", "still_blocking"]),
  successful_hands_fixes: z.number().int().nonnegative(),
  evidence_paths: z.array(z.string().trim().min(1)),
}).strict();

const replanEffectResultSchema = z.object({
  blocker: z.string().trim().min(1),
  replan_patch_path: z.string().trim().min(1),
  target_work_item_id: z.string().trim().min(1).optional(),
}).strict();

const stopEffectResultSchema = z.object({
  blocker: z.string().trim().min(1),
}).strict();

export interface PersistedReviewEffectState {
  decision: ReviewCycleState;
  claim: ReviewCycleState | null;
  completion: ReviewCycleState | null;
  effect_state: ReviewCycleState["effect_state"];
}

/** Shared runtime/status validator for the exact immutable effect state machine. */
export async function validatePersistedReviewEffectState(
  runDir: string,
  cycle: ReviewCycleState,
  owner: string,
): Promise<PersistedReviewEffectState> {
  const expectedOwner = owner.trim();
  if (!expectedOwner) throw new Error("Review effect owner must be non-empty");
  const decision = await loadPersistedDecision(runDir, cycle);
  const claim = await readOptionalValidatedArtifact(
    runDir,
    effectClaimPath(decision.effect_id),
    reviewCycleStateSchema,
  );
  if (claim) {
    if (claim.effect_state !== "in_progress") throw new Error("Persisted review-effect claim must be in_progress");
    assertEffectOwner(assertEffectProvenance(decision, claim), expectedOwner);
  }
  const completion = await readOptionalValidatedArtifact(
    runDir,
    effectCompletionPath(decision.effect_id),
    reviewCycleStateSchema,
  );
  if (completion) {
    if (!claim) throw new Error("Persisted review-effect completion requires its immutable claim");
    if (completion.effect_state !== "complete" && completion.effect_state !== "blocked") {
      throw new Error("Persisted review-effect completion must be complete or blocked");
    }
    assertEffectOwner(assertEffectProvenance(decision, completion), expectedOwner);
    const action = decision.decision.action;
    if (action === "stop" && completion.effect_state !== "blocked") {
      throw new Error("A stop review effect must terminate as blocked");
    }
    if (action !== "stop" && completion.effect_state !== "complete") {
      throw new Error("A non-stop review effect must terminate as complete");
    }
    if (action === "advance" || action === "continue_with_warning") {
      advanceEffectResultSchema.parse(completion.effect_result);
    } else if (action === "fix" || action === "quality_recovery") {
      const normal = normalFixEffectResultSchema.safeParse(completion.effect_result);
      const ordered = orderedFixEffectResultSchema.safeParse(completion.effect_result);
      if (!normal.success && !ordered.success) throw new Error("Completed fix effect result is invalid");
    } else if (action === "create_replan") {
      replanEffectResultSchema.parse(completion.effect_result);
    } else if (action === "stop") {
      stopEffectResultSchema.parse(completion.effect_result);
    } else {
      throw new Error("await_plan_approval cannot have a completed review effect");
    }
  }
  return {
    decision,
    claim,
    completion,
    effect_state: completion?.effect_state ?? claim?.effect_state ?? decision.effect_state,
  };
}

export interface SuccessfulFixProvenance {
  successful_hands_fixes: number;
  evidence_refs: string[];
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function encoded(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

export function reviewDecisionPath(workItemId: string, reviewRevision: number): string {
  return `reviews/decisions/work-item-${encoded(workItemId)}-revision-${reviewRevision}.json`;
}

function effectClaimPath(effectId: string): string {
  return `reviews/effects/${encoded(effectId)}/claim.json`;
}

function effectCompletionPath(effectId: string): string {
  return `reviews/effects/${encoded(effectId)}/completion.json`;
}

function fixAccountingMarkerPath(effectId: string, mutationId?: string): string {
  const markerId = mutationId === undefined ? effectId : `${effectId}:${mutationId}`;
  return `reviews/accounting/fixes/${encoded(markerId)}.json`;
}

function selfReviewAccountingMarkerPath(mutationId: string): string {
  return `reviews/accounting/self-review/${encoded(mutationId)}.json`;
}

function fixReservationRoot(effectId: string, mutationId: string): string {
  return `reviews/accounting/reservations/${encoded(`${effectId}:${mutationId}`)}`;
}

function canonicalActionMutationId(
  cycle: Pick<ReviewCycleState, "review_revision">,
  mutationId: string,
): { actionId: string; attempt: number } {
  const match = /^R([1-9][0-9]*)-A([1-9][0-9]*):attempt-([1-9][0-9]*)$/.exec(mutationId);
  if (!match || Number(match[1]) !== cycle.review_revision) {
    throw new Error("Fix reservation requires a canonical action mutation ID for its review revision");
  }
  return { actionId: `R${match[1]}-A${match[2]}`, attempt: Number(match[3]) };
}

async function activeFixReservations(runDir: string): Promise<number> {
  const root = join(runDir, "reviews/accounting/reservations");
  const entries = await readdir(root, { withFileTypes: true }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  });
  const cyclesByEffect = await readPersistedCyclesByEffect(runDir);
  let active = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) throw new Error("Fix reservation root contains an unexpected entry");
    const reservation = await readOptionalValidatedArtifact(runDir, `reviews/accounting/reservations/${entry.name}/reservation.json`, fixReservationReadSchema);
    if (!reservation) throw new Error("Fix reservation is missing");
    const cycle = cyclesByEffect.get(reservation.effect_id);
    if (!cycle) throw new Error("Fix reservation is missing its immutable review cycle");
    const resolvedReservation = reservationProvenance(reservation, cycle);
    if (entry.name !== encoded(`${reservation.effect_id}:${reservation.mutation_id}`)) {
      throw new Error("Fix reservation path does not match its provenance");
    }
    const completion = await readOptionalValidatedArtifact(runDir, `reviews/accounting/reservations/${entry.name}/completion.json`, fixReservationCompletionReadSchema);
    if (!completion) {
      active += 1;
      continue;
    }
    if (JSON.stringify({ ...reservationProvenance(completion, cycle), status: "charged" })
      !== JSON.stringify({ ...resolvedReservation, status: "charged" })) {
      throw new Error("Fix reservation completion provenance mismatch");
    }
  }
  return active;
}

export function reviewCycleIdentity(input: Omit<BeginReviewCycleInput, "run_dir" | "evaluate">): string {
  return `review-cycle:${hash([
    input.work_item_id,
    input.phase,
    input.review_revision,
    input.policy_hash,
    input.finding_ids,
    input.accounting_before,
    input.work_item_progress_reference ?? null,
  ])}`;
}

export function reviewEffectIdentity(cycleId: string, decision: ReviewPolicyDecision): string {
  return `review-effect:${hash([cycleId, decision])}`;
}

type EffectActionArtifact = {
  cycle_id?: string;
  effect_id?: string;
  effect_action?: "fix" | "quality_recovery";
};

function resolvedEffectAction(
  artifact: EffectActionArtifact,
  cycle: ReviewCycleState,
): "fix" | "quality_recovery" {
  if (
    artifact.cycle_id !== cycle.cycle_id
    || artifact.effect_id !== cycle.effect_id
    || cycle.effect_id !== reviewEffectIdentity(cycle.cycle_id, cycle.decision)
  ) {
    throw new Error("Review-effect artifact does not match its immutable cycle identity");
  }
  if (artifact.effect_action !== undefined) {
    if (cycle.decision.action !== artifact.effect_action) {
      throw new Error("Review-effect action does not match its immutable cycle");
    }
    return artifact.effect_action;
  }
  if (cycle.decision.action !== "fix") {
    throw new Error("Legacy review-effect action can only be inferred from its immutable ordinary-fix cycle");
  }
  return "fix";
}

function reservationProvenance(
  reservation: z.infer<typeof fixReservationReadSchema>,
  cycle: ReviewCycleState,
): z.infer<typeof fixReservationSchema> {
  return fixReservationSchema.parse({
    mutation_id: reservation.mutation_id,
    cycle_id: reservation.cycle_id,
    effect_id: reservation.effect_id,
    effect_owner: reservation.effect_owner,
    effect_action: resolvedEffectAction(reservation, cycle),
  });
}

function accountingMarkerProvenance(
  marker: AccountingMarker,
  cycle: ReviewCycleState,
): z.infer<typeof accountingMarkerSchema> {
  return accountingMarkerSchema.parse({
    mutation_id: marker.mutation_id,
    kind: marker.kind,
    cycle_id: marker.cycle_id,
    effect_id: marker.effect_id,
    effect_owner: marker.effect_owner,
    effect_action: resolvedEffectAction(marker, cycle),
    accounting_before: marker.accounting_before,
    accounting_after: marker.accounting_after,
  });
}

function canonicalFindingIds(findingIds: string[]): string[] {
  const parsed = z.array(z.string().regex(/^finding:[a-f0-9]{64}$/)).parse(findingIds);
  return [...new Set(parsed)].sort();
}

function assertNormalizedFindingIds(findingIds: string[]): void {
  const canonical = canonicalFindingIds(findingIds);
  if (JSON.stringify(canonical) !== JSON.stringify(findingIds)) {
    throw new Error("Review cycle finding_ids must be unique and sorted");
  }
}

function invariantCycle(state: ReviewCycleState): Omit<ReviewCycleState, "effect_state" | "effect_owner" | "effect_result"> {
  const { effect_state: _state, effect_owner: _owner, effect_result: _result, ...invariant } = state;
  return invariant;
}

function assertCycleProvenance(
  existing: ReviewCycleState,
  input: Omit<BeginReviewCycleInput, "evaluate">,
): ReviewCycleState {
  const expectedPath = reviewDecisionPath(input.work_item_id, input.review_revision);
  const expectedCycleId = reviewCycleIdentity(input);
  if (
    existing.work_item_id !== input.work_item_id
    || existing.phase !== input.phase
    || existing.review_revision !== input.review_revision
    || existing.policy_hash !== input.policy_hash
    || JSON.stringify(existing.finding_ids) !== JSON.stringify(input.finding_ids)
    || JSON.stringify(existing.accounting_before) !== JSON.stringify(input.accounting_before)
    || JSON.stringify(existing.work_item_progress_reference) !== JSON.stringify(input.work_item_progress_reference)
    || existing.decision_path !== expectedPath
    || existing.cycle_id !== expectedCycleId
    || existing.effect_id !== reviewEffectIdentity(existing.cycle_id, existing.decision)
    || existing.effect_state !== "pending"
  ) throw new Error("Persisted review cycle provenance does not match the requested evaluation");
  return existing;
}

function progressReferencePatch(
  input: BeginReviewCycleInput,
  cycle: ReviewCycleState,
) {
  const reference = input.work_item_progress_reference;
  if (!reference) return undefined;
  return {
    work_item_id: input.work_item_id,
    review_revision: input.review_revision,
    review_cycle_path: cycle.decision_path,
    review_effect_id: cycle.effect_id,
    attempts: reference.attempts,
    review_path: reference.review_path,
    verification_path: reference.verification_path,
  };
}

async function loadPersistedDecision(
  runDir: string,
  cycle: ReviewCycleState,
): Promise<ReviewCycleState> {
  const persisted = await readOptionalValidatedArtifact(runDir, cycle.decision_path, reviewCycleStateSchema);
  if (!persisted || JSON.stringify(invariantCycle(persisted)) !== JSON.stringify(invariantCycle(cycle))) {
    throw new Error("Review cycle provenance does not match its immutable decision artifact");
  }
  return persisted;
}

function expectedPolicyHash(policy: unknown): string {
  return hash(policy);
}

export async function beginReviewCycle(
  rawInput: BeginReviewCycleInput,
  hooks: ReviewCycleHooks = {},
): Promise<ReviewCycleState> {
  const input = {
    ...rawInput,
    work_item_id: rawInput.work_item_id.trim(),
    accounting_before: reviewAccountingSchema.parse(rawInput.accounting_before),
  };
  if (!input.work_item_id) throw new Error("Review cycle work_item_id must be non-empty");
  if (!Number.isInteger(input.review_revision) || input.review_revision < 1) {
    throw new Error("Review cycle review_revision must be positive");
  }
  assertNormalizedFindingIds(input.finding_ids);
  if (input.review_revision !== input.accounting_before.review_revision + 1) {
    throw new Error("Review cycle revision must follow accounting_before.review_revision");
  }

  return withRunLedgerCompoundTransaction(input.run_dir, async (transaction) => {
    const reconciledAccounting = await reconcileAccountingMarkers(transaction);
    const path = reviewDecisionPath(input.work_item_id, input.review_revision);
    const existing = await readOptionalValidatedArtifact(
      transaction.runDir,
      path,
      reviewCycleStateSchema,
    );
    if (existing) {
      const canonicalRequestedAccounting = await canonicalizeRequestedAccounting(
        transaction.runDir,
        input.accounting_before,
        existing.accounting_before,
      );
      const persisted = assertCycleProvenance(existing, {
        ...input,
        accounting_before: canonicalRequestedAccounting,
      });
      const current = (await transaction.readManifestV2()).review_accounting;
      if (current && JSON.stringify(current) === JSON.stringify(existing.accounting_before)) {
        await transaction.updateReviewAccounting(existing.accounting_before, {
          ...existing.accounting_before,
          review_revision: input.review_revision,
        }, progressReferencePatch(input, persisted));
      } else if (current && current.review_revision === input.review_revision) {
        await transaction.updateReviewAccounting(existing.accounting_before, {
          ...existing.accounting_before,
          review_revision: input.review_revision,
        }, progressReferencePatch(input, persisted));
      } else if (!current || current.review_revision < input.review_revision) {
        throw new Error("Review cycle accounting cannot be repaired from the persisted decision");
      }
      return persisted;
    }

    const manifest = await transaction.readManifestV2();
    if (!manifest.review_policy_snapshot || !manifest.review_accounting) {
      throw new Error("Review cycles are unavailable for a legacy run without policy accounting");
    }
    if (expectedPolicyHash(manifest.review_policy_snapshot) !== input.policy_hash) {
      throw new Error("Review cycle policy hash does not match the snapshotted policy");
    }
    const canonicalRequestedAccounting = await canonicalizeRequestedAccounting(
      transaction.runDir,
      input.accounting_before,
      reconciledAccounting ?? input.accounting_before,
    );

    const effectiveInput = {
      ...input,
      accounting_before: canonicalRequestedAccounting,
    };
    if (effectiveInput.review_revision !== effectiveInput.accounting_before.review_revision + 1) {
      throw new Error("Review cycle revision must follow reconciled accounting review_revision");
    }

    const evaluated = reviewPolicyDecisionSchema.parse(input.evaluate());
    assertNormalizedFindingIds(evaluated.finding_ids);
    const cycleFindingIds = new Set(input.finding_ids);
    if (
      evaluated.policy_revision !== manifest.review_policy_snapshot.policy_revision
      || evaluated.finding_ids.some((findingId) => !cycleFindingIds.has(findingId))
    ) throw new Error("Review policy decision provenance does not match the cycle inputs");

    const cycleId = reviewCycleIdentity(effectiveInput);
    const cycle = reviewCycleStateSchema.parse({
      cycle_id: cycleId,
      work_item_id: input.work_item_id,
      phase: input.phase,
      review_revision: input.review_revision,
      policy_hash: input.policy_hash,
      finding_ids: [...input.finding_ids],
      accounting_before: { ...effectiveInput.accounting_before },
      decision_path: path,
      effect_id: reviewEffectIdentity(cycleId, evaluated),
      effect_state: "pending",
      work_item_progress_reference: input.work_item_progress_reference,
      decision: evaluated,
    });
    await writeCreateOnceValidated(transaction.runDir, path, cycle, reviewCycleStateSchema);
    await hooks.afterDecisionPersisted?.();
    await transaction.updateReviewAccounting(effectiveInput.accounting_before, {
      ...effectiveInput.accounting_before,
      review_revision: input.review_revision,
    }, progressReferencePatch(input, cycle));
    return cycle;
  });
}

export async function claimReviewEffect(input: ReviewEffectInput): Promise<ReviewEffectClaimResult> {
  const owner = input.owner.trim();
  if (!owner) throw new Error("Review effect owner must be non-empty");
  return withRunLedgerCompoundTransaction(input.run_dir, async (transaction) => {
    const decisionState = await loadPersistedDecision(transaction.runDir, input.cycle);
    const completion = await readOptionalValidatedArtifact(
      transaction.runDir,
      effectCompletionPath(decisionState.effect_id),
      reviewCycleStateSchema,
    );
    if (completion) {
      const persisted = assertEffectOwner(assertEffectProvenance(decisionState, completion), owner);
      return { status: persisted.effect_state === "blocked" ? "blocked" : "complete", cycle: persisted };
    }
    const claimPath = effectClaimPath(decisionState.effect_id);
    const claim = await readOptionalValidatedArtifact(transaction.runDir, claimPath, reviewCycleStateSchema);
    if (claim) {
      assertEffectProvenance(decisionState, claim);
      throw new AmbiguousEffectError(claim);
    }
    const claimed = reviewCycleStateSchema.parse({
      ...decisionState,
      effect_state: "in_progress",
      effect_owner: owner,
    });
    return {
      status: "acquired",
      cycle: await writeCreateOnceValidated(
        transaction.runDir,
        claimPath,
        claimed,
        reviewCycleStateSchema,
      ),
    };
  });
}

function assertEffectOwner(state: ReviewCycleState, owner: string): ReviewCycleState {
  if (state.effect_owner !== owner) {
    throw new Error(`Review effect is owned by ${state.effect_owner ?? "an unknown owner"}`);
  }
  return state;
}

function assertEffectProvenance(
  decisionState: ReviewCycleState,
  effectState: ReviewCycleState,
): ReviewCycleState {
  if (JSON.stringify(invariantCycle(decisionState)) !== JSON.stringify(invariantCycle(effectState))) {
    throw new Error("Review effect provenance does not match its immutable decision");
  }
  return effectState;
}

export async function completeReviewEffect(
  input: CompleteReviewEffectInput,
): Promise<ReviewCycleState> {
  const owner = input.owner.trim();
  if (!owner) throw new Error("Review effect owner must be non-empty");
  const canonicalResult = canonicalizeJson(input.result);
  return withRunLedgerCompoundTransaction(input.run_dir, async (transaction) => {
    const decisionState = await loadPersistedDecision(transaction.runDir, input.cycle);
    const completionPath = effectCompletionPath(decisionState.effect_id);
    const existing = await readOptionalValidatedArtifact(
      transaction.runDir,
      completionPath,
      reviewCycleStateSchema,
    );
    if (existing) {
      assertEffectProvenance(decisionState, existing);
      assertEffectOwner(existing, owner);
      if (existing.effect_state !== input.outcome
        || canonicalJsonBytes(existing.effect_result) !== canonicalJsonBytes(canonicalResult)) {
        throw new Error("Review effect is already complete with a different result");
      }
      return existing;
    }
    const claim = await readOptionalValidatedArtifact(
      transaction.runDir,
      effectClaimPath(decisionState.effect_id),
      reviewCycleStateSchema,
    );
    if (!claim) throw new Error("Review effect must be claimed before completion");
    assertEffectProvenance(decisionState, claim);
    assertEffectOwner(claim, owner);
    const completed = reviewCycleStateSchema.parse({
      ...decisionState,
      effect_state: input.outcome,
      effect_owner: owner,
      effect_result: canonicalResult,
    });
    return writeCreateOnceValidated(
      transaction.runDir,
      completionPath,
      completed,
      reviewCycleStateSchema,
    );
  });
}

export async function requireCompletedReviewEffect(
  input: ReviewEffectInput,
): Promise<ReviewCycleState> {
  const owner = input.owner.trim();
  if (!owner) throw new Error("Review effect owner must be non-empty");
  const decisionState = await loadPersistedDecision(input.run_dir, input.cycle);
  const completion = await readOptionalValidatedArtifact(
    input.run_dir,
    effectCompletionPath(decisionState.effect_id),
    reviewCycleStateSchema,
  );
  if (!completion || completion.effect_state !== "complete") {
    throw new Error(`Review effect ${decisionState.effect_id} is not immutably complete`);
  }
  return assertEffectOwner(assertEffectProvenance(decisionState, completion), owner);
}

export async function loadCompletedReviewEffect(
  input: ReviewEffectInput,
): Promise<ReviewCycleState | null> {
  const owner = input.owner.trim();
  if (!owner) throw new Error("Review effect owner must be non-empty");
  const decisionState = await loadPersistedDecision(input.run_dir, input.cycle);
  const completion = await readOptionalValidatedArtifact(
    input.run_dir,
    effectCompletionPath(decisionState.effect_id),
    reviewCycleStateSchema,
  );
  if (!completion) return null;
  return assertEffectOwner(assertEffectProvenance(decisionState, completion), owner);
}

export async function requireClaimedReviewEffect(
  input: ReviewEffectInput,
): Promise<ReviewCycleState> {
  const owner = input.owner.trim();
  if (!owner) throw new Error("Review effect owner must be non-empty");
  const decisionState = await loadPersistedDecision(input.run_dir, input.cycle);
  const completion = await readOptionalValidatedArtifact(
    input.run_dir,
    effectCompletionPath(decisionState.effect_id),
    reviewCycleStateSchema,
  );
  if (completion) {
    throw new Error(`Review effect ${decisionState.effect_id} is already immutably complete`);
  }
  const claim = await readOptionalValidatedArtifact(
    input.run_dir,
    effectClaimPath(decisionState.effect_id),
    reviewCycleStateSchema,
  );
  if (!claim || claim.effect_state !== "in_progress") {
    throw new Error(`Review effect ${decisionState.effect_id} is not immutably claimed`);
  }
  return assertEffectOwner(assertEffectProvenance(decisionState, claim), owner);
}

export async function recoverClaimedReviewEffectBeforeQueue(
  input: ReviewEffectInput & { queue_persisted: boolean },
): Promise<ReviewEffectClaimResult> {
  if (input.queue_persisted) {
    throw new Error(`Review effect ${input.cycle.effect_id} cannot be replayed after its action queue was persisted`);
  }
  return {
    status: "acquired",
    cycle: await requireClaimedReviewEffect(input),
  };
}

export async function requireCompletedAdvanceEffect(
  input: ReviewEffectInput,
): Promise<{ cycle: ReviewCycleState; commit_sha: string }> {
  const cycle = await requireCompletedReviewEffect(input);
  if (cycle.decision.action !== "advance" && cycle.decision.action !== "continue_with_warning") {
    throw new Error(`Review effect ${cycle.effect_id} is not an advance effect`);
  }
  const parsed = advanceEffectResultSchema.safeParse(cycle.effect_result);
  if (!parsed.success) {
    throw new Error(`Review effect ${cycle.effect_id} immutable advance result is invalid`);
  }
  return { cycle, commit_sha: parsed.data.commit_sha };
}

export function nextAccounting(
  current: ReviewAccounting,
  mutation: { kind: ReviewAccountingMutationKind },
): ReviewAccounting {
  const parsed = reviewAccountingSchema.parse(current);
  if (mutation.kind === "successful_fix" || mutation.kind === "successful_action_fix") {
    return { ...parsed, fix_cycles_used: parsed.fix_cycles_used + 1 };
  }
  if (mutation.kind === "self_review_fix") {
    return { ...parsed, self_review_mutations_used: parsed.self_review_mutations_used + 1 };
  }
  return { ...parsed };
}

function assertFixEffectAction(
  cycle: ReviewCycleState,
  effectAction: "fix" | "quality_recovery",
): void {
  if (cycle.decision.action !== effectAction) {
    throw new Error("Fix effect action does not match its immutable review decision");
  }
}

async function assertQualityRecoveryEligibility(
  transaction: RunLedgerTransaction,
  cycle: ReviewCycleState,
  accounting: ReviewAccounting,
): Promise<void> {
  const manifest = await transaction.readManifestV2();
  const maxFixCycles = manifest.review_policy_snapshot?.max_fix_cycles;
  const progress = manifest.work_item_progress[cycle.work_item_id];
  if (
    maxFixCycles === undefined
    || accounting.fix_cycles_used !== maxFixCycles
    || manifest.hands_backup_policy === null
    || manifest.hands_backup_policy === undefined
    || manifest.active_hands_profile !== "primary"
    || !progress
    || (progress.quality_recovery_attempts ?? 0) !== 0
  ) {
    throw new Error("Quality recovery requires exact exhausted-budget eligibility");
  }
}

async function applyAccountingMarker(
  runDir: string,
  markerPath: string,
  proposed: (before: ReviewAccounting) => AccountingMarker,
  hooks: ReviewCycleHooks,
  effectCycle?: ReviewCycleState,
): Promise<ReviewAccounting> {
  return withRunLedgerCompoundTransaction(runDir, async (transaction) => {
    const reconciled = await reconcileAccountingMarkers(transaction);
    const qualityRecoveryTargets = effectCycle?.decision.action === "quality_recovery"
      ? [effectCycle.work_item_id]
      : undefined;
    const existing = await readOptionalValidatedArtifact(
      transaction.runDir,
      markerPath,
      accountingMarkerReadSchema,
    );
    let result: ReviewAccounting;
    if (existing) {
      const expected = proposed(existing.accounting_before);
      const comparable = effectCycle && existing.kind !== "self_review_fix"
        ? accountingMarkerProvenance(existing, effectCycle)
        : existing;
      if (JSON.stringify(comparable) !== JSON.stringify(expected)) {
        throw new Error("Review accounting marker provenance does not match the requested mutation");
      }
      const current = reconciled;
      if (JSON.stringify(current) === JSON.stringify(existing.accounting_after)) {
        result = existing.accounting_after;
      } else if (current && accountingDominates(current, existing.accounting_after)) {
        result = current;
      } else {
        result = await transaction.updateReviewAccounting(
          existing.accounting_before,
          existing.accounting_after,
          undefined,
          qualityRecoveryTargets,
        );
      }
    } else {
      const current = reconciled;
      if (!current) throw new Error("Review accounting is unavailable for this run");
      if (effectCycle?.decision.action === "quality_recovery") {
        await assertQualityRecoveryEligibility(transaction, effectCycle, current);
      }
      const marker = accountingMarkerSchema.parse(proposed(current));
      await writeCreateOnceValidated(transaction.runDir, markerPath, marker, accountingMarkerSchema);
      await hooks.afterMarkerPersisted?.();
      result = await transaction.updateReviewAccounting(
        marker.accounting_before,
        marker.accounting_after,
        undefined,
        qualityRecoveryTargets,
      );
      await hooks.afterAccountingPersisted?.();
    }
    if (effectCycle?.decision.action === "quality_recovery") {
      await hooks.afterQualityRecoveryAttemptPersisted?.();
    }
    return result;
  });
}

function accountingDominates(current: ReviewAccounting, earlier: ReviewAccounting): boolean {
  return current.review_revision >= earlier.review_revision
    && current.self_review_mutations_used >= earlier.self_review_mutations_used
    && current.plan_revision >= earlier.plan_revision
    && (current.plan_revision > earlier.plan_revision
      || current.fix_cycles_used >= earlier.fix_cycles_used);
}

type JsonValue = z.infer<ReturnType<typeof z.json>>;

function canonicalizeJson(value: unknown): JsonValue {
  const parsed = z.json().parse(value);
  if (Array.isArray(parsed)) return parsed.map(canonicalizeJson);
  if (parsed !== null && typeof parsed === "object") {
    return Object.fromEntries(
      Object.keys(parsed).sort().map((key) => [key, canonicalizeJson(parsed[key])]),
    );
  }
  return parsed;
}

function canonicalJsonBytes(value: unknown): string {
  return JSON.stringify(canonicalizeJson(value));
}

interface ResolvedAccountingMarker {
  marker: AccountingMarker;
  qualityRecoveryWorkItemId?: string;
}

async function readAccountingMarkers(runDir: string): Promise<ResolvedAccountingMarker[]> {
  const markers: AccountingMarker[] = [];
  for (const directory of ["reviews/accounting/fixes", "reviews/accounting/self-review"]) {
    const absolute = join(runDir, directory);
    const status = await lstat(absolute).catch((error: unknown) => {
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      if (code === "ENOENT") return null;
      throw error;
    });
    if (status === null) continue;
    if (status.isSymbolicLink()) throw new Error("Review accounting directory must not be a symlink");
    if (!status.isDirectory()) throw new Error("Review accounting path must be a directory");
    const entries = await readdir(absolute, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        throw new Error("Review accounting directory contains an unexpected entry");
      }
      const marker = await readOptionalValidatedArtifact(
        runDir,
        `${directory}/${entry.name}`,
        accountingMarkerReadSchema,
      );
      if (!marker) throw new Error("Review accounting marker disappeared during reconciliation");
      markers.push(marker);
    }
  }
  const cyclesByEffect = await readPersistedCyclesByEffect(runDir);
  return markers.map((marker) => {
    if (marker.kind === "self_review_fix") return { marker };
    const cycle = cyclesByEffect.get(marker.effect_id!);
    if (!cycle) throw new Error("Review accounting marker is missing its immutable review cycle");
    const resolved = accountingMarkerProvenance(marker, cycle);
    return {
      marker: resolved,
      ...(resolved.effect_action === "quality_recovery"
        ? { qualityRecoveryWorkItemId: cycle.work_item_id }
        : {}),
    };
  });
}

async function readDirectoryEntries(runDir: string, relativePath: string): Promise<string[]> {
  const absolute = join(runDir, relativePath);
  const status = await lstat(absolute).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (status === null) return [];
  if (status.isSymbolicLink()) {
    throw new Error(`Successful-fix provenance directory must not be a symlink: ${relativePath}`);
  }
  if (!status.isDirectory()) {
    throw new Error(`Successful-fix provenance directory is invalid: ${relativePath}`);
  }
  const entries = await readdir(absolute, { withFileTypes: true });
  return entries.sort((left, right) => left.name.localeCompare(right.name)).map((entry) => {
    if (!entry.isFile() && !entry.isDirectory()) {
      throw new Error(`Successful-fix provenance directory contains an unexpected entry: ${relativePath}`);
    }
    return entry.name;
  });
}

async function requireOwnedFile(runDir: string, path: string, prefix: string): Promise<Buffer> {
  return readOwnedEvidenceFile(runDir, path, prefix);
}

async function readPersistedCycles(runDir: string): Promise<ReviewCycleState[]> {
  const entries = await readDirectoryEntries(runDir, "reviews/decisions");
  const cycles: ReviewCycleState[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) throw new Error("Review decision directory contains an unexpected entry");
    const cycle = await readOptionalValidatedArtifact(
      runDir,
      `reviews/decisions/${entry}`,
      reviewCycleStateSchema,
    );
    if (!cycle) throw new Error("Review decision disappeared during successful-fix provenance read");
    cycles.push(cycle);
  }
  return cycles;
}

async function readPersistedCyclesByEffect(runDir: string): Promise<Map<string, ReviewCycleState>> {
  const cyclesByEffect = new Map<string, ReviewCycleState>();
  for (const cycle of await readPersistedCycles(runDir)) {
    if (cyclesByEffect.has(cycle.effect_id)) throw new Error("Review effects must map to one immutable cycle");
    cyclesByEffect.set(cycle.effect_id, cycle);
  }
  return cyclesByEffect;
}

interface PersistedReservation {
  reservation: z.infer<typeof fixReservationReadSchema>;
  completion: z.infer<typeof fixReservationCompletionReadSchema>;
}

async function readCompletedReservations(
  runDir: string,
  cyclesByEffect: Map<string, ReviewCycleState>,
): Promise<PersistedReservation[]> {
  const roots = await readDirectoryEntries(runDir, "reviews/accounting/reservations");
  const reservations: PersistedReservation[] = [];
  for (const root of roots) {
    const reservation = await readOptionalValidatedArtifact(
      runDir,
      `reviews/accounting/reservations/${root}/reservation.json`,
      fixReservationReadSchema,
    );
    const completion = await readOptionalValidatedArtifact(
      runDir,
      `reviews/accounting/reservations/${root}/completion.json`,
      fixReservationCompletionReadSchema,
    );
    const cycle = reservation ? cyclesByEffect.get(reservation.effect_id) : undefined;
    if (!reservation || !cycle) throw new Error("Successful-fix reservation is missing its provenance");
    if (root !== encoded(`${reservation.effect_id}:${reservation.mutation_id}`)) {
      throw new Error("Successful-fix reservation path does not match its provenance");
    }
    if (!completion) continue;
    if (JSON.stringify({ ...reservationProvenance(completion, cycle), status: "charged" })
      !== JSON.stringify({ ...reservationProvenance(reservation, cycle), status: "charged" })) {
      throw new Error("Successful-fix reservation completion provenance mismatch");
    }
    reservations.push({ reservation, completion });
  }
  return reservations;
}

async function readActionInvocationCompletions(
  runDir: string,
): Promise<Array<z.infer<typeof actionInvocationCompletionSchema>>> {
  const roots = await readDirectoryEntries(runDir, "reviews/action-invocations");
  const completions: Array<z.infer<typeof actionInvocationCompletionSchema>> = [];
  for (const root of roots) {
    const claim = await readOptionalValidatedArtifact(
      runDir,
      `reviews/action-invocations/${root}/claim.json`,
      actionInvocationClaimSchema,
    );
    if (!claim) throw new Error("Action invocation is missing its immutable claim");
    const claimId = [claim.effect_id, claim.review_revision, claim.action_id, claim.action_attempt].join(":");
    if (root !== encoded(claimId)) throw new Error("Action invocation path does not match its claim provenance");
    const completion = await readOptionalValidatedArtifact(
      runDir,
      `reviews/action-invocations/${root}/completion.json`,
      actionInvocationCompletionSchema,
    );
    if (!completion) continue;
    const { state: _claimState, completed_profile: _claimCompletedProfile, ...claimProvenance } = claim;
    const { state: _completionState, completed_profile: _completionProfile, report_sha256: _reportSha256, ...completionProvenance } = completion;
    if (JSON.stringify(completionProvenance) !== JSON.stringify(claimProvenance)) {
      throw new Error("Action invocation completion does not match its claim provenance");
    }
    completions.push(completion);
  }
  return completions;
}

/**
 * Read and validate all successful fix provenance while the caller owns the
 * run-ledger compound lock. This helper never mutates or reconciles state.
 */
export async function loadSuccessfulFixProvenanceLocked(
  transaction: RunLedgerTransaction,
  rawAccounting: ReviewAccounting,
): Promise<SuccessfulFixProvenance> {
  const accounting = reviewAccountingSchema.parse(rawAccounting);
  const manifest = await transaction.readManifestV2();
  if (JSON.stringify(manifest.review_accounting) !== JSON.stringify(accounting)) {
    throw new Error("Successful-fix provenance accounting does not match the locked manifest");
  }
  const markers = (await readAccountingMarkers(transaction.runDir)).map(({ marker }) => marker)
    .filter((marker) => marker.kind === "successful_fix" || marker.kind === "successful_action_fix");
  const currentMarkers = markers.filter((marker) =>
    marker.accounting_before.plan_revision === accounting.plan_revision);
  if (currentMarkers.length !== accounting.fix_cycles_used) {
    throw new Error("Successful-fix marker count does not match current fix_cycles_used");
  }
  const mutationIds = new Set<string>();
  const effectMarkerCounts = new Map<string, number>();
  const sorted = [...markers].sort((left, right) =>
    left.accounting_before.plan_revision - right.accounting_before.plan_revision
    || left.accounting_before.fix_cycles_used - right.accounting_before.fix_cycles_used);
  let previous: AccountingMarker | null = null;
  for (const marker of sorted) {
    const continuesRevision = previous?.accounting_after.plan_revision
      === marker.accounting_before.plan_revision;
    if (
      marker.accounting_after.fix_cycles_used !== marker.accounting_before.fix_cycles_used + 1
      || marker.accounting_before.review_revision !== marker.accounting_after.review_revision
      || marker.accounting_before.self_review_mutations_used !== marker.accounting_after.self_review_mutations_used
      || marker.accounting_before.plan_revision !== marker.accounting_after.plan_revision
      || marker.accounting_after.plan_revision > accounting.plan_revision
      || (continuesRevision
        ? marker.accounting_before.fix_cycles_used !== previous!.accounting_after.fix_cycles_used
        : marker.accounting_before.fix_cycles_used !== 0)
    ) throw new Error("Successful-fix accounting markers do not form an exactly-once chain");
    if (previous && (
      marker.accounting_before.review_revision < previous.accounting_after.review_revision
      || marker.accounting_before.self_review_mutations_used < previous.accounting_after.self_review_mutations_used
      || marker.accounting_before.plan_revision < previous.accounting_after.plan_revision
    )) throw new Error("Successful-fix accounting marker lineage moves backwards");
    previous = marker;
    effectMarkerCounts.set(marker.effect_id!, (effectMarkerCounts.get(marker.effect_id!) ?? 0) + 1);
  }
  const currentLast = currentMarkers.sort((left, right) =>
    left.accounting_after.fix_cycles_used - right.accounting_after.fix_cycles_used).at(-1);
  if (currentLast && (
    currentLast.accounting_after.fix_cycles_used !== accounting.fix_cycles_used
    || currentLast.accounting_after.review_revision > accounting.review_revision
    || currentLast.accounting_after.self_review_mutations_used > accounting.self_review_mutations_used
  )) throw new Error("Successful-fix accounting chain does not reach current accounting");

  const cycles = await readPersistedCycles(transaction.runDir);
  const cyclesByEffect = new Map<string, ReviewCycleState>();
  for (const cycle of cycles) {
    if (cyclesByEffect.has(cycle.effect_id)) throw new Error("Review effects must map to one immutable cycle");
    cyclesByEffect.set(cycle.effect_id, cycle);
  }
  const reservations = await readCompletedReservations(transaction.runDir, cyclesByEffect);
  const reservationKeys = new Set<string>();
  for (const { reservation } of reservations) {
    const key = `${reservation.effect_id}:${reservation.mutation_id}`;
    if (reservationKeys.has(key)) throw new Error("Successful-fix reservations must be unique");
    reservationKeys.add(key);
  }
  const actionCompletions = await readActionInvocationCompletions(transaction.runDir);
  const usedActionCompletions = new Set<number>();
  const usedReservations = new Set<string>();
  const evidence = new Set<string>();

  for (const marker of sorted) {
    const cycle = cyclesByEffect.get(marker.effect_id!);
    const markerAction = cycle ? resolvedEffectAction(marker, cycle) : undefined;
    if (
      !cycle
      || cycle.cycle_id !== marker.cycle_id
      || (cycle.decision.action !== "fix" && cycle.decision.action !== "quality_recovery")
      || cycle.decision.action !== markerAction
      || cycle.review_revision !== marker.accounting_before.review_revision
      || cycle.accounting_before.plan_revision !== marker.accounting_before.plan_revision
    ) throw new Error("Successful-fix marker does not match its immutable review cycle");
    const completion = await readOptionalValidatedArtifact(
      transaction.runDir,
      effectCompletionPath(cycle.effect_id),
      reviewCycleStateSchema,
    );
    const claim = completion ? null : await readOptionalValidatedArtifact(
      transaction.runDir,
      effectClaimPath(cycle.effect_id),
      reviewCycleStateSchema,
    );
    const persistedEffect = completion ?? claim;
    if (
      !persistedEffect
      || (persistedEffect.effect_state !== "complete" && persistedEffect.effect_state !== "in_progress")
      || persistedEffect.effect_owner !== marker.effect_owner
      || JSON.stringify(invariantCycle(persistedEffect)) !== JSON.stringify(invariantCycle(cycle))
    ) throw new Error("Successful-fix marker requires its matching claimed or completed effect");

    if (marker.kind === "successful_fix") {
      if (mutationIds.has(marker.mutation_id)) throw new Error("Successful-fix mutation IDs must be unique");
      mutationIds.add(marker.mutation_id);
      if (completion) {
        const result = normalFixEffectResultSchema.safeParse(completion.effect_result);
        if (!result.success || result.data.implementation_path !== marker.mutation_id) {
          throw new Error("Successful fix effect evidence does not own its accounting marker");
        }
      }
      const prefix = `implementation/${cycle.work_item_id.replace(/[^a-zA-Z0-9._-]/g, "_")}/`;
      await requireOwnedFile(transaction.runDir, marker.mutation_id, prefix);
      if (marker.accounting_before.plan_revision === accounting.plan_revision) {
        evidence.add(marker.mutation_id);
      }
      continue;
    }

    const reservationKey = `${cycle.effect_id}:${marker.mutation_id}`;
    const reservation = reservations.find(({ reservation: candidate }) =>
      `${candidate.effect_id}:${candidate.mutation_id}` === reservationKey);
    if (
      !reservation
      || reservation.reservation.cycle_id !== cycle.cycle_id
      || reservation.reservation.effect_owner !== marker.effect_owner
      || resolvedEffectAction(reservation.reservation, cycle) !== markerAction
    ) throw new Error("Successful action fix marker is missing its matching charged reservation");
    usedReservations.add(reservationKey);
    const mutation = canonicalActionMutationId(cycle, marker.mutation_id);
    const matches = actionCompletions.map((completion, index) => ({ completion, index })).filter(({ completion: candidate }) =>
      candidate.effect_id === cycle.effect_id
      && candidate.action_id === mutation.actionId
      && candidate.action_attempt === mutation.attempt);
    if (matches.length !== 1) throw new Error("Successful action fix requires exactly one invocation completion");
    const match = matches[0]!;
    if (usedActionCompletions.has(match.index)) {
      throw new Error("Successful action invocation completion cannot satisfy more than one accounting marker");
    }
    if (mutationIds.has(marker.mutation_id)) throw new Error("Successful-fix mutation IDs must be unique");
    mutationIds.add(marker.mutation_id);
    usedActionCompletions.add(match.index);
    if (match.completion.review_revision !== cycle.review_revision) {
      throw new Error("Successful action invocation revision does not match its review cycle");
    }
    const prefix = `implementation/${cycle.work_item_id.replace(/[^a-zA-Z0-9._-]/g, "_")}/`;
    const reportBytes = await requireOwnedFile(transaction.runDir, match.completion.report_path, prefix);
    if (createHash("sha256").update(reportBytes).digest("hex") !== match.completion.report_sha256) {
      throw new Error("Successful action invocation report hash does not match its completion");
    }
    if (marker.accounting_before.plan_revision === accounting.plan_revision) {
      evidence.add(match.completion.report_path);
    }
  }

  if (usedReservations.size !== reservations.length) {
    throw new Error("Successful-fix provenance contains an extra reservation");
  }
  const relevantActionCompletions = actionCompletions.filter((completion) => effectMarkerCounts.has(completion.effect_id));
  if (usedActionCompletions.size !== relevantActionCompletions.length) {
    throw new Error("Successful-fix provenance contains an extra action invocation completion");
  }
  for (const cycle of cycles.filter((candidate) =>
    candidate.decision.action === "fix" || candidate.decision.action === "quality_recovery")) {
    const completion = await readOptionalValidatedArtifact(
      transaction.runDir,
      effectCompletionPath(cycle.effect_id),
      reviewCycleStateSchema,
    );
    if (!completion) continue;
    if (completion.effect_state !== "complete") {
      throw new Error("Successful-fix lineage contains a non-complete persisted fix effect");
    }
    const actualCount = effectMarkerCounts.get(cycle.effect_id) ?? 0;
    const normal = normalFixEffectResultSchema.safeParse(completion.effect_result);
    if (normal.success) {
      if (actualCount !== 1) throw new Error("Completed fix effect is missing its exactly-once accounting marker");
      continue;
    }
    const ordered = orderedFixEffectResultSchema.safeParse(completion.effect_result);
    if (!ordered.success || ordered.data.successful_hands_fixes !== actualCount) {
      throw new Error("Ordered fix effect count does not match its successful action markers");
    }
    for (const path of ordered.data.evidence_paths) {
      await requireOwnedFile(transaction.runDir, path, "verification/");
      if (cycle.accounting_before.plan_revision === accounting.plan_revision) evidence.add(path);
    }
  }
  return {
    successful_hands_fixes: currentMarkers.length,
    evidence_refs: [...evidence].sort(),
  };
}

export async function loadSuccessfulFixProvenance(
  runDir: string,
  accounting: ReviewAccounting,
): Promise<SuccessfulFixProvenance> {
  return withRunLedgerCompoundTransaction(runDir, (transaction) =>
    loadSuccessfulFixProvenanceLocked(transaction, accounting));
}

function sameAccounting(left: ReviewAccounting, right: ReviewAccounting): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function canonicalizeRequestedAccounting(
  runDir: string,
  requested: ReviewAccounting,
  expected: ReviewAccounting,
): Promise<ReviewAccounting> {
  let current = reviewAccountingSchema.parse(requested);
  const markers = (await readAccountingMarkers(runDir)).map(({ marker }) => marker);
  const seen = new Set<string>();
  while (!sameAccounting(current, expected)) {
    const candidates = markers.filter((marker) => sameAccounting(marker.accounting_before, current));
    if (candidates.length === 0) {
      throw new Error("Review cycle accounting_before does not match durable marker provenance");
    }
    const distinctAfter = new Set(candidates.map((marker) => JSON.stringify(marker.accounting_after)));
    if (distinctAfter.size !== 1) {
      throw new Error("Review cycle accounting_before has an ambiguous durable marker chain");
    }
    const next = candidates[0]!.accounting_after;
    const identity = JSON.stringify(next);
    if (seen.has(identity)) {
      throw new Error("Review cycle accounting marker chain contains a cycle");
    }
    seen.add(identity);
    current = next;
  }
  return expected;
}

async function reconcileAccountingMarkers(
  transaction: RunLedgerTransaction,
): Promise<ReviewAccounting | undefined> {
  let current = (await transaction.readManifestV2()).review_accounting;
  if (!current) return undefined;
  const initial = current;
  const resolvedMarkers = await readAccountingMarkers(transaction.runDir);
  const markers = resolvedMarkers.map(({ marker }) => marker);
  const qualityRecoveryTargets = [...new Set(resolvedMarkers.flatMap(({ qualityRecoveryWorkItemId }) =>
    qualityRecoveryWorkItemId === undefined ? [] : [qualityRecoveryWorkItemId]))];
  const manifest = await transaction.readManifestV2();
  for (const workItemId of qualityRecoveryTargets) {
    const progress = manifest.work_item_progress[workItemId];
    if (!progress) throw new Error(`Quality recovery progress is missing for ${workItemId}`);
    const attempts = progress.quality_recovery_attempts ?? 0;
    if (attempts !== 0 && attempts !== 1) {
      throw new Error(`Quality recovery attempts must be zero or one for ${workItemId}`);
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const marker of markers) {
      if (accountingDominates(current, marker.accounting_after)) continue;
      if (JSON.stringify(current) !== JSON.stringify(marker.accounting_before)) continue;
      current = marker.accounting_after;
      changed = true;
    }
  }
  const unresolved = markers.find((marker) => !accountingDominates(current!, marker.accounting_after));
  if (unresolved) {
    throw new Error(`Review accounting marker ${unresolved.mutation_id} cannot be reconciled`);
  }
  if (
    !sameAccounting(initial, current)
    || qualityRecoveryTargets.some((workItemId) =>
      manifest.work_item_progress[workItemId]?.quality_recovery_attempts !== 1)
  ) {
    current = await transaction.updateReviewAccounting(
      initial,
      current,
      undefined,
      qualityRecoveryTargets,
    );
  }
  return current;
}

export async function incrementSuccessfulFix(
  input: IncrementSuccessfulFixInput,
  hooks: ReviewCycleHooks = {},
): Promise<ReviewAccounting> {
  const mutationId = input.mutation_id.trim();
  if (!mutationId) throw new Error("Successful fix mutation_id must be non-empty");
  const decisionState = await loadPersistedDecision(input.run_dir, input.cycle);
  if (decisionState.decision.action !== "fix" && decisionState.decision.action !== "quality_recovery") {
    throw new Error("Successful fix accounting requires an engine-authorized fix decision");
  }
  assertFixEffectAction(decisionState, input.effect_action);
  if (input.kind === "successful_action_fix") {
    canonicalActionMutationId(decisionState, mutationId);
    const completion = await readOptionalValidatedArtifact(
      input.run_dir,
      effectCompletionPath(decisionState.effect_id),
      reviewCycleStateSchema,
    );
    if (completion) {
      assertEffectProvenance(decisionState, completion);
      assertEffectOwner(completion, input.owner.trim());
    } else {
      await requireClaimedReviewEffect(input);
    }
  } else {
    const completion = await readOptionalValidatedArtifact(
      input.run_dir,
      effectCompletionPath(decisionState.effect_id),
      reviewCycleStateSchema,
    );
    if (!completion || completion.effect_state !== "complete") {
      throw new Error("Successful fix accounting requires a completed effect");
    }
    assertEffectProvenance(decisionState, completion);
    assertEffectOwner(completion, input.owner.trim());
  }
  const markerPath = fixAccountingMarkerPath(
    decisionState.effect_id,
    input.kind === "successful_action_fix" ? mutationId : undefined,
  );
  return applyAccountingMarker(input.run_dir, markerPath, (before) => ({
    mutation_id: mutationId,
    kind: input.kind,
    cycle_id: decisionState.cycle_id,
    effect_id: decisionState.effect_id,
    effect_owner: input.owner.trim(),
    effect_action: input.effect_action,
    accounting_before: before,
    accounting_after: nextAccounting(before, { kind: input.kind }),
  }), hooks, decisionState);
}

export async function reserveFixSlot(
  input: ReserveFixSlotInput,
  hooks: ReviewCycleHooks = {},
): Promise<ReserveFixSlotResult> {
  const mutationId = input.mutation_id.trim();
  if (!mutationId) throw new Error("Fix reservation mutation_id must be non-empty");
  return withRunLedgerCompoundTransaction(input.run_dir, async (transaction) => {
    const cycle = await loadPersistedDecision(transaction.runDir, input.cycle);
    if (cycle.decision.action !== "fix" && cycle.decision.action !== "quality_recovery") {
      throw new Error("Fix reservation requires an authorized fix decision");
    }
    assertFixEffectAction(cycle, input.effect_action);
    canonicalActionMutationId(cycle, mutationId);
    await requireClaimedReviewEffect(input);
    const reservation = fixReservationSchema.parse({
      mutation_id: mutationId,
      cycle_id: cycle.cycle_id,
      effect_id: cycle.effect_id,
      effect_owner: input.owner.trim(),
      effect_action: input.effect_action,
    });
    const root = fixReservationRoot(cycle.effect_id, mutationId);
    const existing = await readOptionalValidatedArtifact(transaction.runDir, `${root}/reservation.json`, fixReservationReadSchema);
    if (existing) {
      if (JSON.stringify(reservationProvenance(existing, cycle)) !== JSON.stringify(reservation)) {
        throw new Error("Fix reservation provenance mismatch");
      }
      return { status: "admitted", mutation_id: mutationId };
    }
    const manifest = await transaction.readManifestV2();
    const maxFixCycles = manifest.review_policy_snapshot?.max_fix_cycles;
    if (maxFixCycles === undefined) throw new Error("Fix reservation requires a snapshotted review policy");
    const accounting = await reconcileAccountingMarkers(transaction);
    if (!accounting) throw new Error("Review accounting is unavailable for fix reservation");
    const activeReservations = await activeFixReservations(transaction.runDir);
    if (input.effect_action === "quality_recovery") {
      await assertQualityRecoveryEligibility(transaction, cycle, accounting);
      if (activeReservations > 0) return { status: "exhausted" };
    } else if (accounting.fix_cycles_used + activeReservations >= maxFixCycles) {
      return { status: "exhausted" };
    }
    await writeCreateOnceValidated(transaction.runDir, `${root}/reservation.json`, reservation, fixReservationSchema);
    await hooks.afterReservationPersisted?.();
    return { status: "admitted", mutation_id: mutationId };
  });
}

export async function commitReservedFixSlot(
  input: CommitReservedFixSlotInput,
  hooks: ReviewCycleHooks = {},
): Promise<ReviewAccounting> {
  const mutationId = input.mutation_id.trim();
  if (!mutationId) throw new Error("Fix reservation mutation_id must be non-empty");
  return withRunLedgerCompoundTransaction(input.run_dir, async (transaction) => {
    const cycle = await loadPersistedDecision(transaction.runDir, input.cycle);
    assertFixEffectAction(cycle, input.effect_action);
    canonicalActionMutationId(cycle, mutationId);
    const root = fixReservationRoot(cycle.effect_id, mutationId);
    const reservation = await readOptionalValidatedArtifact(transaction.runDir, `${root}/reservation.json`, fixReservationReadSchema);
    if (!reservation) throw new Error("Fix reservation is missing");
    const expected = fixReservationSchema.parse({
      mutation_id: mutationId,
      cycle_id: cycle.cycle_id,
      effect_id: cycle.effect_id,
      effect_owner: input.owner.trim(),
      effect_action: input.effect_action,
    });
    const resolvedReservation = reservationProvenance(reservation, cycle);
    if (JSON.stringify(resolvedReservation) !== JSON.stringify(expected)) throw new Error("Fix reservation provenance mismatch");
    const existingCompletion = await readOptionalValidatedArtifact(transaction.runDir, `${root}/completion.json`, fixReservationCompletionReadSchema);
    if (existingCompletion && (
      JSON.stringify(reservationProvenance(existingCompletion, cycle)) !== JSON.stringify(expected)
      || existingCompletion.status !== "charged"
    )) throw new Error("Fix reservation completion provenance mismatch");
    let current = await reconcileAccountingMarkers(transaction);
    if (!current) throw new Error("Review accounting is unavailable for fix reservation");
    const markerPath = fixAccountingMarkerPath(cycle.effect_id, mutationId);
    const existingMarker = await readOptionalValidatedArtifact(transaction.runDir, markerPath, accountingMarkerReadSchema);
    if (existingMarker) {
      if (
        existingMarker.mutation_id !== mutationId
        || existingMarker.cycle_id !== cycle.cycle_id
        || existingMarker.effect_id !== cycle.effect_id
        || existingMarker.effect_owner !== input.owner.trim()
        || resolvedEffectAction(existingMarker, cycle) !== input.effect_action
      ) throw new Error("Reserved fix accounting marker provenance mismatch");
      if (!existingCompletion) {
        await writeCreateOnceValidated(transaction.runDir, `${root}/completion.json`, { ...resolvedReservation, status: "charged" }, fixReservationCompletionSchema);
        await hooks.afterReservationCompletionPersisted?.();
      }
      if (input.effect_action === "quality_recovery") {
        await hooks.afterQualityRecoveryAttemptPersisted?.();
      }
      return current;
    }
    if (input.effect_action === "quality_recovery") {
      await assertQualityRecoveryEligibility(transaction, cycle, current);
    }
    const marker = accountingMarkerSchema.parse({
      mutation_id: mutationId,
      kind: "successful_action_fix",
      cycle_id: cycle.cycle_id,
      effect_id: cycle.effect_id,
      effect_owner: input.owner.trim(),
      effect_action: input.effect_action,
      accounting_before: current,
      accounting_after: nextAccounting(current, { kind: "successful_action_fix" }),
    });
    await writeCreateOnceValidated(transaction.runDir, markerPath, marker, accountingMarkerSchema);
    await hooks.afterMarkerPersisted?.();
    await writeCreateOnceValidated(transaction.runDir, `${root}/completion.json`, { ...resolvedReservation, status: "charged" }, fixReservationCompletionSchema);
    await hooks.afterReservationCompletionPersisted?.();
    current = await transaction.updateReviewAccounting(
      marker.accounting_before,
      marker.accounting_after,
      undefined,
      input.effect_action === "quality_recovery" ? [cycle.work_item_id] : undefined,
    );
    await hooks.afterAccountingPersisted?.();
    if (input.effect_action === "quality_recovery") {
      await hooks.afterQualityRecoveryAttemptPersisted?.();
    }
    return current;
  });
}

export async function assertChargedFixSlot(input: AssertChargedFixSlotInput): Promise<ReviewAccounting> {
  const mutationId = input.mutation_id.trim();
  if (!mutationId) throw new Error("Fix reservation mutation_id must be non-empty");
  return withRunLedgerCompoundTransaction(input.run_dir, async (transaction) => {
    const cycle = await loadPersistedDecision(transaction.runDir, input.cycle);
    canonicalActionMutationId(cycle, mutationId);
    if (cycle.decision.action !== "fix" && cycle.decision.action !== "quality_recovery") {
      throw new Error("Charged fix reservation requires a fix or quality-recovery cycle");
    }
    const expected = fixReservationSchema.parse({
      mutation_id: mutationId,
      cycle_id: cycle.cycle_id,
      effect_id: cycle.effect_id,
      effect_owner: input.owner.trim(),
      effect_action: cycle.decision.action,
    });
    const root = fixReservationRoot(cycle.effect_id, mutationId);
    const reservation = await readOptionalValidatedArtifact(
      transaction.runDir,
      `${root}/reservation.json`,
      fixReservationReadSchema,
    );
    const completion = await readOptionalValidatedArtifact(
      transaction.runDir,
      `${root}/completion.json`,
      fixReservationCompletionReadSchema,
    );
    if (
      !reservation
      || JSON.stringify(reservationProvenance(reservation, cycle)) !== JSON.stringify(expected)
      || !completion
      || JSON.stringify({ ...reservationProvenance(completion, cycle), status: completion.status })
        !== JSON.stringify({ ...expected, status: "charged" })
    ) throw new Error("Matching fix reservation is not provably charged");
    const marker = await readOptionalValidatedArtifact(
      transaction.runDir,
      fixAccountingMarkerPath(cycle.effect_id, mutationId),
      accountingMarkerReadSchema,
    );
    if (
      !marker
      || marker.kind !== "successful_action_fix"
      || marker.mutation_id !== mutationId
      || marker.cycle_id !== cycle.cycle_id
      || marker.effect_id !== cycle.effect_id
      || marker.effect_owner !== input.owner.trim()
    ) throw new Error("Charged fix reservation is missing its matching accounting marker");
    const accounting = await reconcileAccountingMarkers(transaction);
    if (!accounting) throw new Error("Review accounting is unavailable for charged fix reservation");
    return accounting;
  });
}

export async function incrementSelfReviewMutation(
  input: IncrementSelfReviewMutationInput,
  hooks: ReviewCycleHooks = {},
): Promise<ReviewAccounting> {
  const mutationId = input.mutation_id.trim();
  if (!mutationId) throw new Error("Self-review mutation_id must be non-empty");
  const markerPath = selfReviewAccountingMarkerPath(mutationId);
  return applyAccountingMarker(input.run_dir, markerPath, (before) => ({
    mutation_id: mutationId,
    kind: "self_review_fix",
    accounting_before: before,
    accounting_after: nextAccounting(before, { kind: "self_review_fix" }),
  }), hooks);
}
