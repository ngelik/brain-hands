import { describe, expect, it } from "vitest";
import {
  ResourceBudgetExceededError,
  reduceResourceBudgetArtifacts,
  resourceBudgetClaimV1Schema,
  resourceBudgetCompletionV1Schema,
  resourceBudgetPolicyV1Schema,
  resourceBudgetReconciliationV1Schema,
  type ResourceBudgetClaimV1,
  type ResourceBudgetCompletionV1,
} from "../../src/core/resource-budget.js";

const policy = resourceBudgetPolicyV1Schema.parse({
  schema_version: 1,
  max_model_invocations: 2,
  max_workflow_attempts: 2,
  max_total_tokens: 100,
  max_active_elapsed_ms: 10_000,
  max_external_effects: 1,
});

function claim(
  kind: ResourceBudgetClaimV1["kind"],
  key: string,
  elapsedReservationMs = kind === "workflow_attempt" ? 0 : 1_000,
): ResourceBudgetClaimV1 {
  const ordinal = key.charCodeAt(0).toString(16).padStart(2, "0");
  return resourceBudgetClaimV1Schema.parse({
    schema_version: 1,
    claim_id: `budget-claim:${ordinal.repeat(32)}`,
    run_id: "run-1",
    kind,
    key,
    reserved_at: "2026-07-16T12:00:00.000Z",
    elapsed_reservation_ms: elapsedReservationMs,
  });
}

function completion(
  budgetClaim: ResourceBudgetClaimV1,
  patch: Partial<ResourceBudgetCompletionV1> = {},
): ResourceBudgetCompletionV1 {
  return resourceBudgetCompletionV1Schema.parse({
    schema_version: 1,
    claim_id: budgetClaim.claim_id,
    completed_at: "2026-07-16T12:00:01.000Z",
    outcome: "succeeded",
    duration_ms: 400,
    process_started: true,
    turn_started: budgetClaim.kind === "model_invocation",
    structured_terminal_error: false,
    token_usage: budgetClaim.kind === "model_invocation"
      ? { input_tokens: 40, cached_input_tokens: 10, output_tokens: 20, reasoning_output_tokens: 5 }
      : null,
    ...patch,
  });
}

describe("resource budget schemas", () => {
  it("accepts exact zero external-effect capacity and rejects unsafe policy values", () => {
    expect(resourceBudgetPolicyV1Schema.parse({ ...policy, max_external_effects: 0 }).max_external_effects).toBe(0);
    expect(resourceBudgetPolicyV1Schema.safeParse({ ...policy, max_model_invocations: 0 }).success).toBe(false);
    expect(resourceBudgetPolicyV1Schema.safeParse({ ...policy, max_total_tokens: Number.MAX_SAFE_INTEGER + 1 }).success).toBe(false);
    expect(resourceBudgetPolicyV1Schema.safeParse({ ...policy, max_active_elapsed_ms: -1 }).success).toBe(false);
    expect(resourceBudgetPolicyV1Schema.safeParse({ ...policy, extra: true }).success).toBe(false);
  });

  it("requires zero elapsed for attempts and a positive reservation for chargeable claims", () => {
    expect(() => claim("workflow_attempt", "a", 1)).toThrow(/elapsed/i);
    expect(() => claim("model_invocation", "a", 0)).toThrow(/elapsed/i);
    expect(() => claim("verification_command", "a", -1)).toThrow(/elapsed/i);
    expect(() => claim("external_effect", "a", Number.MAX_SAFE_INTEGER + 1)).toThrow();
  });

  it("keeps completion token and result evidence strict and safe", () => {
    const modelClaim = claim("model_invocation", "a");
    expect(() => completion(modelClaim, {
      token_usage: { input_tokens: -1, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 },
    })).toThrow();
    expect(() => completion(modelClaim, { result_ref: { path: "../secret", sha256: "a".repeat(64) } })).toThrow();
    expect(() => resourceBudgetCompletionV1Schema.parse({ ...completion(modelClaim), unknown: true })).toThrow();
  });
});

describe("reduceResourceBudgetArtifacts", () => {
  it("counts all claim dimensions and counts cached/reasoning tokens without double charging", () => {
    const model = claim("model_invocation", "a");
    const attempt = claim("workflow_attempt", "b");
    const verification = claim("verification_command", "c", 2_000);
    const effect = claim("external_effect", "d", 3_000);

    expect(reduceResourceBudgetArtifacts(policy, [model, attempt, verification, effect], [
      completion(model),
      completion(verification, { duration_ms: 500 }),
      completion(effect, { duration_ms: 600 }),
    ])).toEqual({
      model_invocations: 1,
      workflow_attempts: 1,
      total_tokens: 60,
      cached_input_tokens: 10,
      reasoning_output_tokens: 5,
      active_elapsed_ms: 1_500,
      external_effects: 1,
      token_accounting: "known",
      uncertain_model_claim_ids: [],
      token_overshoot: 0,
    });
  });

  it("charges completed actual elapsed and open reserved elapsed", () => {
    const completedModel = claim("model_invocation", "a", 4_000);
    const openVerification = claim("verification_command", "b", 3_000);
    const attempt = claim("workflow_attempt", "c");

    const usage = reduceResourceBudgetArtifacts(policy, [completedModel, openVerification, attempt], [
      completion(completedModel, { duration_ms: 250 }),
    ]);

    expect(usage.active_elapsed_ms).toBe(3_250);
  });

  it("deduplicates identical same-key artifacts and rejects conflicting duplicates", () => {
    const original = claim("model_invocation", "a");
    const finished = completion(original);
    expect(reduceResourceBudgetArtifacts(policy, [original, { ...original }], [finished, { ...finished }]).model_invocations).toBe(1);

    expect(() => reduceResourceBudgetArtifacts(policy, [original, { ...original, elapsed_reservation_ms: 2_000 }], [])).toThrow(/conflicting.*claim/i);
    expect(() => reduceResourceBudgetArtifacts(policy, [original], [finished, { ...finished, duration_ms: 300 }])).toThrow(/conflicting.*completion/i);
  });

  it("rejects claim identity collisions and orphaned or over-reservation completions", () => {
    const original = claim("model_invocation", "a");
    const collision = { ...claim("model_invocation", "b"), claim_id: original.claim_id };
    expect(() => reduceResourceBudgetArtifacts(policy, [original, collision], [])).toThrow(/claim_id/i);
    expect(() => reduceResourceBudgetArtifacts(policy, [], [completion(original)])).toThrow(/without.*claim/i);
    expect(() => reduceResourceBudgetArtifacts(policy, [original], [completion(original, { duration_ms: 1_001 })])).toThrow(/reservation/i);
  });

  it("reports one-call token overshoot without rejecting the completed usage", () => {
    const model = claim("model_invocation", "a");
    const usage = reduceResourceBudgetArtifacts(policy, [model], [completion(model, {
      token_usage: { input_tokens: 90, cached_input_tokens: 80, output_tokens: 25, reasoning_output_tokens: 20 },
    })]);

    expect(usage.total_tokens).toBe(115);
    expect(usage.token_overshoot).toBe(15);
    expect(usage.token_accounting).toBe("known");
  });

  it("proves zero only before process or before turn on structured terminal error", () => {
    const neverStarted = claim("model_invocation", "a");
    const preTurnError = claim("model_invocation", "b");
    const startedUnknown = claim("model_invocation", "c");
    const processUnknown = claim("model_invocation", "d");
    const openUnknown = claim("model_invocation", "e");
    const usage = reduceResourceBudgetArtifacts(
      { ...policy, max_model_invocations: 5 },
      [neverStarted, preTurnError, startedUnknown, processUnknown, openUnknown],
      [
        completion(neverStarted, { process_started: false, turn_started: false, token_usage: null, duration_ms: 0 }),
        completion(preTurnError, { process_started: true, turn_started: false, structured_terminal_error: true, token_usage: null }),
        completion(startedUnknown, { process_started: true, turn_started: true, token_usage: null }),
        completion(processUnknown, { process_started: true, turn_started: false, structured_terminal_error: false, token_usage: null }),
      ],
    );

    expect(usage.total_tokens).toBe(0);
    expect(usage.token_accounting).toBe("uncertain");
    expect(usage.uncertain_model_claim_ids).toEqual([
      startedUnknown.claim_id,
      processUnknown.claim_id,
      openUnknown.claim_id,
    ]);
  });

  it("reconciles an evidenced failed pre-turn provider rejection only as zero usage", () => {
    const model = claim("model_invocation", "a");
    const rejected = completion(model, {
      outcome: "failed",
      process_started: true,
      turn_started: false,
      structured_terminal_error: false,
      token_usage: null,
    });
    const zero = resourceBudgetReconciliationV1Schema.parse({
      schema_version: 1,
      claim_id: model.claim_id,
      reconciled_at: "2026-07-16T12:00:02.000Z",
      actor: "operator@example.test",
      reason: "Provider rejected the request before starting a model turn.",
      evidence_refs: ["responses/provider-rejection.stderr.txt"],
      token_usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 },
    });

    expect(reduceResourceBudgetArtifacts(policy, [model], [rejected], [zero])).toMatchObject({
      token_accounting: "known",
      uncertain_model_claim_ids: [],
      total_tokens: 0,
    });
    expect(() => reduceResourceBudgetArtifacts(policy, [model], [rejected], [{
      ...zero,
      token_usage: { ...zero.token_usage, input_tokens: 1 },
    }])).toThrow(/pre-turn.*zero/i);
  });

  it("reduces uncertain claim identities in canonical order", () => {
    const later = claim("model_invocation", "b");
    const earlier = claim("model_invocation", "a");

    expect(reduceResourceBudgetArtifacts(policy, [later, earlier], []).uncertain_model_claim_ids).toEqual([
      earlier.claim_id,
      later.claim_id,
    ]);
  });

  it("fails closed on safe-integer overflow", () => {
    const one = claim("model_invocation", "a");
    const two = claim("model_invocation", "b");
    expect(() => reduceResourceBudgetArtifacts(
      { ...policy, max_total_tokens: Number.MAX_SAFE_INTEGER },
      [one, two],
      [
        completion(one, { token_usage: { input_tokens: Number.MAX_SAFE_INTEGER, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 } }),
        completion(two, { token_usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 } }),
      ],
    )).toThrow(/safe integer/i);
  });

  it("reports exact budget-exhaustion coordinates", () => {
    const error = new ResourceBudgetExceededError("external_effects", 0, 0, 1);
    expect(error).toMatchObject({ dimension: "external_effects", used: 0, limit: 0, requested: 1 });
    expect(error.message).toContain("external_effects");
  });
});
