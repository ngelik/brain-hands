import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_RESOURCE_BUDGET_V1,
  resourceBudgetClaimV1Schema,
  type ResourceBudgetCompletionV1,
  type ResourceBudgetCompletionInput,
  type ResourceBudgetPolicyV1,
} from "../../src/core/resource-budget.js";
import { createRunLedgerV2, readManifestV2, updateManifestV2 } from "../../src/core/ledger.js";
import { createLegacyRunLedgerV2 } from "../fixtures/legacy-run.js";
import {
  initializeResourceBudgetPolicy,
  extendResourceBudget,
  openResourceBudget,
  readEffectiveResourceBudgetPolicy,
  reconcileInterruptedResourceBudgetModelInvocation,
  reconcileResourceBudgetModelInvocation,
} from "../../src/workflow/resource-budget.js";

let repoRoot: string | null = null;

afterEach(async () => {
  if (repoRoot) {
    await rm(repoRoot, { recursive: true, force: true });
    repoRoot = null;
  }
});

async function boundedRun(policy: ResourceBudgetPolicyV1 = DEFAULT_RESOURCE_BUDGET_V1) {
  repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-budget-"));
  const ledger = await createRunLedgerV2({ repoRoot, originalRequest: "Budget run", resourceBudgetPolicy: policy });
  return { ...ledger, policy };
}

function completion(
  claimId: string,
  patch: Partial<ResourceBudgetCompletionV1> = {},
): ResourceBudgetCompletionInput {
  return {
    claim_id: claimId,
    completed_at: "2026-07-17T12:00:01.000Z",
    outcome: "succeeded",
    duration_ms: 100,
    process_started: true,
    turn_started: true,
    structured_terminal_error: false,
    token_usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 5, reasoning_output_tokens: 1 },
    ...patch,
  };
}

describe("resource budget controller", () => {
  it("extends an exhausted token budget append-only with owned evidence", async () => {
    const policy = { ...DEFAULT_RESOURCE_BUDGET_V1, max_total_tokens: 10 };
    const { runDir } = await boundedRun(policy);
    await initializeResourceBudgetPolicy(runDir, policy);
    const budget = await openResourceBudget(runDir);
    const claim = await budget.claim({ kind: "model_invocation", key: "large", elapsed_reservation_ms: 1_000 });
    await budget.complete(completion(claim.claim_id, {
      token_usage: { input_tokens: 15, cached_input_tokens: 10, output_tokens: 5, reasoning_output_tokens: 1 },
    }));
    await expect(budget.claim({ kind: "model_invocation", key: "blocked", elapsed_reservation_ms: 100 }))
      .rejects.toThrow(/total_tokens/i);
    await writeFile(join(runDir, "responses", "operator-evidence.txt"), "approved extension\n", "utf8");

    const extension = await extendResourceBudget({
      runDir,
      actor: "operator@example.test",
      reason: "Continue after an approved external recovery.",
      evidenceRefs: ["responses/operator-evidence.txt"],
      policy: { ...policy, max_total_tokens: 100 },
    });

    expect(extension.previous_policy.max_total_tokens).toBe(10);
    expect(extension.policy.max_total_tokens).toBe(100);
    await expect(budget.claim({ kind: "model_invocation", key: "unblocked", elapsed_reservation_ms: 100 }))
      .resolves.toMatchObject({ key: "unblocked" });
    expect((await readManifestV2(runDir)).resource_budget_policy).toEqual(policy);
    await expect(extendResourceBudget({
      runDir,
      actor: "operator@example.test",
      reason: "Invalid reduction.",
      evidenceRefs: ["responses/operator-evidence.txt"],
      policy: { ...policy, max_total_tokens: 50 },
    })).rejects.toThrow(/cannot reduce/i);
  });

  it("extends non-token resource dimensions through the same append-only policy chain", async () => {
    const policy = { ...DEFAULT_RESOURCE_BUDGET_V1, max_workflow_attempts: 2 };
    const { runDir } = await boundedRun(policy);
    await initializeResourceBudgetPolicy(runDir, policy);
    await writeFile(join(runDir, "responses", "operator-evidence.txt"), "approved extension\n", "utf8");

    const extension = await extendResourceBudget({
      runDir,
      actor: "operator@example.test",
      reason: "Continue the approved workflow after controller recovery.",
      evidenceRefs: ["responses/operator-evidence.txt"],
      policy: {
        ...policy,
        max_workflow_attempts: 8,
        max_model_invocations: policy.max_model_invocations + 10,
      },
    });

    expect(extension.previous_policy.max_workflow_attempts).toBe(2);
    expect(extension.policy).toMatchObject({
      max_workflow_attempts: 8,
      max_model_invocations: policy.max_model_invocations + 10,
    });
    await expect(readEffectiveResourceBudgetPolicy(runDir)).resolves.toMatchObject({
      max_workflow_attempts: 8,
      max_model_invocations: policy.max_model_invocations + 10,
    });
  });
  it("initializes policy once and stores the identical bounded manifest snapshot", async () => {
    const { runDir, policy } = await boundedRun();

    const ref = await initializeResourceBudgetPolicy(runDir, policy);

    expect(ref.path).toBe("budgets/policy.json");
    expect(JSON.parse(await readFile(join(runDir, "budgets/policy.json"), "utf8"))).toEqual(policy);
    expect((await readManifestV2(runDir)).resource_budget_policy).toEqual(policy);
    await expect(initializeResourceBudgetPolicy(runDir, { ...policy })).resolves.toEqual(ref);
    await expect(initializeResourceBudgetPolicy(runDir, {
      ...policy,
      max_model_invocations: policy.max_model_invocations + 1,
    })).rejects.toThrow(/different bytes|resource budget policy/i);
  });

  it("requires bounded policy file and manifest snapshot to match while legacy runs need neither", async () => {
    const { runDir, policy } = await boundedRun();
    await rm(join(runDir, "budgets", "policy.json"));
    await expect(openResourceBudget(runDir)).rejects.toThrow(/budget.*policy|policy\.json/i);

    await mkdir(join(runDir, "budgets"), { recursive: true });
    await writeFile(join(runDir, "budgets/policy.json"), `${JSON.stringify(policy, null, 2)}\n`, "utf8");
    await updateManifestV2(runDir, { resource_budget_policy: { ...policy, max_external_effects: 0 } });
    await expect(openResourceBudget(runDir)).rejects.toThrow(/mismatch|corrupt/i);

    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-budget-legacy-"));
    const legacy = await createLegacyRunLedgerV2({ repoRoot, originalRequest: "Legacy run" });
    await expect(openResourceBudget(legacy.runDir)).rejects.toThrow(/bounded-context-v1/i);
  });

  it("deduplicates concurrent identical claims into one artifact and one usage unit", async () => {
    const { runDir, policy } = await boundedRun();
    await initializeResourceBudgetPolicy(runDir, policy);
    const budget = await openResourceBudget(runDir);

    const [first, second] = await Promise.all([
      budget.claim({ kind: "model_invocation", key: "brain:first", elapsed_reservation_ms: 1_000 }),
      budget.claim({ kind: "model_invocation", key: "brain:first", elapsed_reservation_ms: 1_000 }),
    ]);

    expect(second).toEqual(first);
    expect(await budget.usage()).toMatchObject({ model_invocations: 1, active_elapsed_ms: 1_000 });
    const encoded = Buffer.from(first.claim_id).toString("base64url");
    expect(resourceBudgetClaimV1Schema.parse(JSON.parse(
      await readFile(join(runDir, "budgets/claims", `${encoded}.json`), "utf8"),
    ))).toEqual(first);
  });

  it("validates existing budget state before returning an idempotent claim replay", async () => {
    const { runDir, policy } = await boundedRun();
    await initializeResourceBudgetPolicy(runDir, policy);
    const budget = await openResourceBudget(runDir);
    await budget.claim({ kind: "model_invocation", key: "brain:first", elapsed_reservation_ms: 1_000 });
    const orphanId = `budget-claim:${"e".repeat(64)}`;
    await writeFile(
      join(runDir, "budgets/completions", `${Buffer.from(orphanId).toString("base64url")}.json`),
      `${JSON.stringify({ schema_version: 1, ...completion(orphanId) }, null, 2)}\n`,
      "utf8",
    );

    await expect(budget.claim({ kind: "model_invocation", key: "brain:first", elapsed_reservation_ms: 1_000 }))
      .rejects.toThrow(/without a claim/i);
  });

  it("fails closed on conflicting claims and completions", async () => {
    const { runDir, policy } = await boundedRun();
    await initializeResourceBudgetPolicy(runDir, policy);
    const budget = await openResourceBudget(runDir);
    const claim = await budget.claim({ kind: "model_invocation", key: "brain:first", elapsed_reservation_ms: 1_000 });

    await expect(budget.claim({
      kind: "model_invocation",
      key: "brain:first",
      elapsed_reservation_ms: 2_000,
    })).rejects.toThrow(/conflict|different/i);
    await expect(budget.complete({ ...completion("budget-claim:" + "0".repeat(64)) }))
      .rejects.toThrow(/without a claim|missing claim/i);

    await expect(budget.complete(completion(claim.claim_id))).resolves.toMatchObject({ claim_id: claim.claim_id });
    await expect(budget.complete(completion(claim.claim_id))).resolves.toMatchObject({ claim_id: claim.claim_id });
    await expect(budget.complete({ ...completion(claim.claim_id), duration_ms: 200 }))
      .rejects.toThrow(/conflict|different/i);
  });

  it("accepts the declared completion input shape and fails closed on corrupt existing completions", async () => {
    const { runDir, policy } = await boundedRun();
    await initializeResourceBudgetPolicy(runDir, policy);
    const budget = await openResourceBudget(runDir);
    const claim = await budget.claim({ kind: "model_invocation", key: "brain:first", elapsed_reservation_ms: 1_000 });

    await expect(budget.complete({
      claim_id: claim.claim_id,
      outcome: "succeeded",
      duration_ms: 100,
      process_started: true,
      turn_started: true,
      structured_terminal_error: false,
      token_usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 },
    })).resolves.toMatchObject({ schema_version: 1, claim_id: claim.claim_id });

    const second = await budget.claim({ kind: "model_invocation", key: "brain:second", elapsed_reservation_ms: 1_000 });
    const orphanId = `budget-claim:${"f".repeat(64)}`;
    const orphanPath = join(runDir, "budgets/completions", `${Buffer.from(orphanId).toString("base64url")}.json`);
    await writeFile(orphanPath, `${JSON.stringify({ schema_version: 1, ...completion(orphanId) }, null, 2)}\n`, "utf8");

    await expect(budget.complete(completion(second.claim_id)))
      .rejects.toThrow(/without a claim/i);
  });

  it("charges open reservations, records proven-zero failures, and blocks uncertain future chargeable work", async () => {
    const { runDir, policy } = await boundedRun({ ...DEFAULT_RESOURCE_BUDGET_V1, max_active_elapsed_ms: 2_000 });
    await initializeResourceBudgetPolicy(runDir, policy);
    const budget = await openResourceBudget(runDir);

    const open = await budget.claim({ kind: "verification_command", key: "npm test", elapsed_reservation_ms: 1_200 });
    expect(open.kind).toBe("verification_command");
    expect(await budget.usage()).toMatchObject({ active_elapsed_ms: 1_200 });
    expect(await budget.remainingActiveElapsedMs()).toBe(800);

    const preTurn = await budget.claim({ kind: "model_invocation", key: "hands:pre-turn", elapsed_reservation_ms: 100 });
    await budget.complete(completion(preTurn.claim_id, {
      duration_ms: 50,
      process_started: true,
      turn_started: false,
      structured_terminal_error: true,
      token_usage: null,
    }));
    expect(await budget.usage()).toMatchObject({ token_accounting: "known", total_tokens: 0 });

    const uncertain = await budget.claim({ kind: "model_invocation", key: "hands:uncertain", elapsed_reservation_ms: 100 });
    await budget.complete(completion(uncertain.claim_id, {
      structured_terminal_error: true,
      token_usage: null,
    }));
    expect(await budget.usage()).toMatchObject({
      token_accounting: "uncertain",
      uncertain_model_claim_ids: [uncertain.claim_id],
    });
    await expect(budget.claim({ kind: "model_invocation", key: "blocked", elapsed_reservation_ms: 100 }))
      .rejects.toThrow(/uncertain/i);

    await writeFile(join(runDir, "responses", "uncertain.stdout.txt"), "structured terminal error\n", "utf8");
    await reconcileResourceBudgetModelInvocation({
      runDir,
      claimId: uncertain.claim_id,
      actor: "operator@example.test",
      reason: "The provider rejected the request schema before model sampling.",
      evidenceRefs: ["responses/uncertain.stdout.txt"],
      tokenUsage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 },
    });
    expect(await budget.usage()).toMatchObject({ token_accounting: "known", uncertain_model_claim_ids: [] });
    await expect(budget.claim({ kind: "model_invocation", key: "unblocked", elapsed_reservation_ms: 100 }))
      .resolves.toMatchObject({ key: "unblocked" });
  });

  it("settles an interrupted started model claim with explicit conservative usage", async () => {
    const { runDir, policy } = await boundedRun({ ...DEFAULT_RESOURCE_BUDGET_V1, max_active_elapsed_ms: 2_000 });
    await initializeResourceBudgetPolicy(runDir, policy);
    const budget = await openResourceBudget(runDir);
    const interrupted = await budget.claim({ kind: "model_invocation", key: "verifier:interrupted", elapsed_reservation_ms: 1_200 });
    await writeFile(join(runDir, "responses", "interrupted.stderr.txt"), "worker interrupted after the model turn started\n", "utf8");

    await reconcileInterruptedResourceBudgetModelInvocation({
      runDir,
      claimId: interrupted.claim_id,
      actor: "operator@example.test",
      reason: "Charge a conservative upper bound derived from the neighboring completed invocation.",
      evidenceRefs: ["responses/interrupted.stderr.txt"],
      durationMs: 600,
      tokenUsage: { input_tokens: 1_000, cached_input_tokens: 500, output_tokens: 200, reasoning_output_tokens: 100 },
    });

    expect(await budget.usage()).toMatchObject({
      active_elapsed_ms: 600,
      total_tokens: 1_200,
      cached_input_tokens: 500,
      reasoning_output_tokens: 100,
      token_accounting: "known",
      uncertain_model_claim_ids: [],
    });
  });

  it("reconciles an already-recorded uncertain completion without replacing its immutable bytes", async () => {
    const { runDir, policy } = await boundedRun({ ...DEFAULT_RESOURCE_BUDGET_V1, max_active_elapsed_ms: 2_000 });
    await initializeResourceBudgetPolicy(runDir, policy);
    const budget = await openResourceBudget(runDir);
    const interrupted = await budget.claim({ kind: "model_invocation", key: "hands:failed", elapsed_reservation_ms: 1_200 });
    const recorded = await budget.complete(completion(interrupted.claim_id, {
      outcome: "failed",
      duration_ms: 300,
      process_started: true,
      turn_started: true,
      structured_terminal_error: true,
      token_usage: null,
    }));
    await writeFile(join(runDir, "responses", "failed.stderr.txt"), "model process exited after turn start\n", "utf8");

    const settled = await reconcileInterruptedResourceBudgetModelInvocation({
      runDir,
      claimId: interrupted.claim_id,
      actor: "operator@example.test",
      reason: "Charge a conservative token bound while preserving measured duration.",
      evidenceRefs: ["responses/failed.stderr.txt"],
      durationMs: 300,
      tokenUsage: { input_tokens: 1_000, cached_input_tokens: 500, output_tokens: 200, reasoning_output_tokens: 100 },
    });

    expect(settled.completion).toEqual(recorded);
    expect(await budget.usage()).toMatchObject({
      active_elapsed_ms: 300,
      total_tokens: 1_200,
      token_accounting: "known",
      uncertain_model_claim_ids: [],
    });
  });

  it("reconciles measured usage for a successful invocation with additive telemetry", async () => {
    const { runDir, policy } = await boundedRun();
    await initializeResourceBudgetPolicy(runDir, policy);
    const budget = await openResourceBudget(runDir);
    const claim = await budget.claim({ kind: "model_invocation", key: "brain:successful", elapsed_reservation_ms: 1_200 });
    await budget.complete(completion(claim.claim_id, {
      outcome: "succeeded",
      duration_ms: 300,
      process_started: true,
      turn_started: true,
      structured_terminal_error: false,
      token_usage: null,
    }));
    await writeFile(
      join(runDir, "responses", "successful.stdout.txt"),
      '{"type":"turn.completed","usage":{"input_tokens":80132,"cached_input_tokens":54528,"cache_write_input_tokens":0,"output_tokens":4971,"reasoning_output_tokens":1664}}\n',
      "utf8",
    );

    await reconcileResourceBudgetModelInvocation({
      runDir,
      claimId: claim.claim_id,
      actor: "operator@example.test",
      reason: "Charge the exact terminal usage preserved by Codex.",
      evidenceRefs: ["responses/successful.stdout.txt"],
      tokenUsage: { input_tokens: 80132, cached_input_tokens: 54528, output_tokens: 4971, reasoning_output_tokens: 1664 },
    });

    expect(await budget.usage()).toMatchObject({
      total_tokens: 85103,
      cached_input_tokens: 54528,
      reasoning_output_tokens: 1664,
      token_accounting: "known",
      uncertain_model_claim_ids: [],
    });
  });

  it("enforces zero external-effect capacity before writing a new claim", async () => {
    const { runDir, policy } = await boundedRun({ ...DEFAULT_RESOURCE_BUDGET_V1, max_external_effects: 0 });
    await initializeResourceBudgetPolicy(runDir, policy);
    const budget = await openResourceBudget(runDir);

    await expect(budget.claim({ kind: "external_effect", key: "github:create", elapsed_reservation_ms: 1 }))
      .rejects.toMatchObject({ dimension: "external_effects", used: 0, limit: 0, requested: 1 });
    await expect(readFile(join(runDir, "budgets/claims"))).rejects.toThrow();
  });

  it("claims workflow attempts exactly once around an action", async () => {
    const { runDir, policy } = await boundedRun();
    await initializeResourceBudgetPolicy(runDir, policy);
    const budget = await openResourceBudget(runDir);

    await expect(budget.runWorkflowAttempt("item:first", async () => "ok")).resolves.toBe("ok");
    await expect(budget.runWorkflowAttempt("item:first", async () => "ok-again")).resolves.toBe("ok-again");

    expect(await budget.usage()).toMatchObject({ workflow_attempts: 1, active_elapsed_ms: 0 });
  });
});
