import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { createRunLedgerV2, readManifestV2, updateManifestV2, withRunLedgerCompoundTransaction } from "../../src/core/ledger.js";
import { workItemDecisionTransition } from "../../src/core/run-state.js";
import type { ReviewAccounting, ReviewPolicyDecision } from "../../src/core/types.js";
import {
  AmbiguousEffectError,
  beginReviewCycle,
  claimReviewEffect,
  completeReviewEffect,
  incrementSelfReviewMutation,
  incrementSuccessfulFix,
  nextAccounting,
  reserveFixSlot,
  commitReservedFixSlot,
  assertChargedFixSlot,
  loadSuccessfulFixProvenanceLocked,
  reviewDecisionPath,
  validatePersistedReviewEffectState,
} from "../../src/workflow/review-cycle.js";
import { readOperatorStatus, resumeRun } from "../../src/workflow/status.js";

let repoRoot: string | null = null;

afterEach(async () => {
  if (repoRoot) await rm(repoRoot, { recursive: true, force: true });
  repoRoot = null;
});

const decision: ReviewPolicyDecision = {
  action: "fix",
  reason_code: "fix_budget_available",
  finding_ids: [`finding:${"a".repeat(64)}`],
  policy_revision: 2,
  authorization_required: false,
};

function accounting(): ReviewAccounting {
  return { review_revision: 0, fix_cycles_used: 0, self_review_mutations_used: 0, plan_revision: 0 };
}

async function setup(options: { backup?: boolean; maxFixCycles?: number } = {}) {
  repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-review-cycle-"));
  const ledger = await createRunLedgerV2({
    repoRoot,
    originalRequest: "Persist decisions",
    ...(options.backup
      ? {
          intake: {
            task: "Persist decisions",
            repo_root: repoRoot,
            hands_backup: {
              fallback_on_primary_usage_limit: true,
              max_quality_recovery_attempts: 1 as const,
              profile: { model: "backup", reasoning_effort: "medium" as const },
            },
            review_policy: { max_fix_cycles: options.maxFixCycles ?? 3 },
          },
        }
      : {}),
  });
  const manifest = await readManifestV2(ledger.runDir);
  const policyHash = createHash("sha256")
    .update(JSON.stringify(manifest.review_policy_snapshot))
    .digest("hex");
  return { ...ledger, policyHash };
}

async function setupQualityRecoveryCycle(maxFixCycles = 3) {
  const setupResult = await setup({ backup: true, maxFixCycles });
  const manifestPath = join(setupResult.runDir, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.review_accounting.fix_cycles_used = manifest.review_policy_snapshot.max_fix_cycles;
  manifest.work_item_progress = {
    "item/one": {
      status: "in_progress",
      attempts: 4,
      quality_recovery_attempts: 0,
    },
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
  const accountingBefore = (await readManifestV2(setupResult.runDir)).review_accounting!;
  const qualityDecision: ReviewPolicyDecision = {
    ...decision,
    action: "quality_recovery",
    reason_code: "bounded_quality_recovery_available",
  };
  const cycle = await beginReviewCycle({
    ...cycleInput(setupResult.runDir, setupResult.policyHash, () => qualityDecision),
    accounting_before: accountingBefore,
  });
  return { ...setupResult, cycle, qualityDecision };
}

function cycleInput(runDir: string, policyHash: string, evaluate: () => ReviewPolicyDecision) {
  return {
    run_dir: runDir,
    work_item_id: "item/one",
    phase: "work_item" as const,
    review_revision: 1,
    policy_hash: policyHash,
    finding_ids: decision.finding_ids,
    accounting_before: accounting(),
    evaluate,
  };
}

async function leaveCrashLeftFixMarker(runDir: string, policyHash: string) {
  const firstCycle = await beginReviewCycle(cycleInput(runDir, policyHash, () => decision));
  await claimReviewEffect({ run_dir: runDir, cycle: firstCycle, owner: "worker-1" });
  await completeReviewEffect({
    run_dir: runDir, cycle: firstCycle, owner: "worker-1", outcome: "complete", result: null,
  });
  await expect(incrementSuccessfulFix({
    run_dir: runDir,
    cycle: firstCycle,
    owner: "worker-1",
    mutation_id: "fix:crash-left",
    kind: "successful_fix",
    effect_action: "fix",
  }, {
    afterMarkerPersisted: async () => { throw new Error("crash after marker"); },
  })).rejects.toThrow("crash after marker");
  return (await readManifestV2(runDir)).review_accounting!;
}

async function removeEffectAction(path: string): Promise<string> {
  const artifact = JSON.parse(await readFile(path, "utf8"));
  delete artifact.effect_action;
  const parentBytes = `${JSON.stringify(artifact, null, 2)}\n`;
  await writeFile(path, parentBytes, "utf8");
  return parentBytes;
}

async function directoryEntries(path: string): Promise<string[]> {
  return readdir(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
}

async function accountingArtifacts(runDir: string) {
  return {
    fixes: await directoryEntries(join(runDir, "reviews/accounting/fixes")),
    self_review: await directoryEntries(join(runDir, "reviews/accounting/self-review")),
    reservations: await directoryEntries(join(runDir, "reviews/accounting/reservations")),
    decisions: await directoryEntries(join(runDir, "reviews/decisions")),
  };
}

async function interruptedLegacyQualityMarker() {
  const setupResult = await setupQualityRecoveryCycle();
  const implementationPath = "implementation/item_one/legacy-quality.json";
  await mkdir(join(setupResult.runDir, "implementation/item_one"), { recursive: true });
  await writeFile(join(setupResult.runDir, implementationPath), "{}\n");
  const input = {
    run_dir: setupResult.runDir,
    cycle: setupResult.cycle,
    owner: "worker-1",
    mutation_id: implementationPath,
    kind: "successful_fix" as const,
    effect_action: "quality_recovery" as const,
  };
  await claimReviewEffect(input);
  await completeReviewEffect({
    ...input,
    outcome: "complete",
    result: { attempt: 4, implementation_path: implementationPath },
  });
  await expect(incrementSuccessfulFix(input, {
    afterMarkerPersisted: async () => { throw new Error("crash after quality marker"); },
  })).rejects.toThrow("crash after quality marker");
  const markerPath = join(
    setupResult.runDir,
    "reviews/accounting/fixes",
    `${Buffer.from(setupResult.cycle.effect_id).toString("base64url")}.json`,
  );
  const markerBytes = await removeEffectAction(markerPath);
  return {
    ...setupResult,
    input,
    markerPath,
    markerBytes,
    manifestBefore: await readManifestV2(setupResult.runDir),
    artifactsBefore: await accountingArtifacts(setupResult.runDir),
  };
}

async function interruptedStrictQualityMarker(mode: "direct" | "reserved") {
  const setupResult = await setupQualityRecoveryCycle(0);
  const common = {
    run_dir: setupResult.runDir,
    cycle: setupResult.cycle,
    owner: "worker-1",
    effect_action: "quality_recovery" as const,
  };
  await claimReviewEffect(common);
  if (mode === "direct") {
    const implementationPath = "implementation/item_one/quality-reconcile.json";
    await mkdir(join(setupResult.runDir, "implementation/item_one"), { recursive: true });
    await writeFile(join(setupResult.runDir, implementationPath), "{}\n");
    const input = {
      ...common,
      mutation_id: implementationPath,
      kind: "successful_fix" as const,
    };
    await completeReviewEffect({
      ...input,
      outcome: "complete",
      result: { attempt: 4, implementation_path: implementationPath },
    });
    await expect(incrementSuccessfulFix(input, {
      afterMarkerPersisted: async () => { throw new Error("crash after strict direct marker"); },
    })).rejects.toThrow("crash after strict direct marker");
    const markerPath = join(
      setupResult.runDir,
      "reviews/accounting/fixes",
      `${Buffer.from(setupResult.cycle.effect_id).toString("base64url")}.json`,
    );
    return {
      ...setupResult,
      mode,
      input,
      markerPath,
      reservationRoot: null,
      markerBytes: await readFile(markerPath, "utf8"),
    };
  }

  const input = { ...common, mutation_id: "R1-A1:attempt-1" };
  await reserveFixSlot(input);
  await expect(commitReservedFixSlot(input, {
    afterMarkerPersisted: async () => { throw new Error("crash after strict reserved marker"); },
  })).rejects.toThrow("crash after strict reserved marker");
  const reservationRoot = join(
    setupResult.runDir,
    "reviews/accounting/reservations",
    Buffer.from(`${setupResult.cycle.effect_id}:${input.mutation_id}`).toString("base64url"),
  );
  const markerPath = join(
    setupResult.runDir,
    "reviews/accounting/fixes",
    `${Buffer.from(`${setupResult.cycle.effect_id}:${input.mutation_id}`).toString("base64url")}.json`,
  );
  const reportPath = "implementation/item_one/quality-reserved.json";
  const reportBytes = "{}\n";
  await mkdir(join(setupResult.runDir, "implementation/item_one"), { recursive: true });
  await writeFile(join(setupResult.runDir, reportPath), reportBytes);
  await mkdir(join(setupResult.runDir, "reviews/action-invocations/quality-reserved"), { recursive: true });
  await writeFile(
    join(setupResult.runDir, "reviews/action-invocations/quality-reserved/completion.json"),
    `${JSON.stringify({
      effect_id: setupResult.cycle.effect_id,
      review_revision: setupResult.cycle.review_revision,
      action_id: "R1-A1",
      action_attempt: 1,
      report_path: reportPath,
      substage: "primary_fix",
      state: "complete",
      started_profile: { kind: "backup", model: "backup", reasoning_effort: "medium" },
      completed_profile: { kind: "backup", model: "backup", reasoning_effort: "medium" },
      report_sha256: createHash("sha256").update(reportBytes).digest("hex"),
    })}\n`,
  );
  await completeReviewEffect({
    ...input,
    outcome: "complete",
    result: { kind: "complete", successful_hands_fixes: 1, evidence_paths: [] },
  });
  return {
    ...setupResult,
    mode,
    input,
    markerPath,
    reservationRoot,
    markerBytes: await readFile(markerPath, "utf8"),
  };
}

async function expectLegacyQualityStateUnchanged(
  context: Awaited<ReturnType<typeof interruptedLegacyQualityMarker>>,
): Promise<void> {
  const manifestAfter = await readManifestV2(context.runDir);
  expect(manifestAfter.review_accounting).toEqual(context.manifestBefore.review_accounting);
  expect(manifestAfter.work_item_progress[context.cycle.work_item_id]?.quality_recovery_attempts)
    .toBe(context.manifestBefore.work_item_progress[context.cycle.work_item_id]?.quality_recovery_attempts);
  expect(await readFile(context.markerPath, "utf8")).toBe(context.markerBytes);
  expect(await accountingArtifacts(context.runDir)).toEqual(context.artifactsBefore);
}

describe("review cycle persistence", () => {
  it("gives quality recovery deterministic distinct effect identity, claim replay, and fixing transition", async () => {
    const { runDir, cycle, qualityDecision } = await setupQualityRecoveryCycle();
    const qualityEffectId = `review-effect:${createHash("sha256")
      .update(JSON.stringify([cycle.cycle_id, qualityDecision]))
      .digest("hex")}`;
    const ordinaryFixEffectId = `review-effect:${createHash("sha256")
      .update(JSON.stringify([cycle.cycle_id, decision]))
      .digest("hex")}`;

    expect(cycle.effect_id).toBe(qualityEffectId);
    expect(cycle.effect_id).not.toBe(ordinaryFixEffectId);
    expect(workItemDecisionTransition(cycle.decision.action)).toBe("fixing");
    await expect(claimReviewEffect({ run_dir: runDir, cycle, owner: "worker-1" }))
      .resolves.toMatchObject({ status: "acquired" });
    await expect(claimReviewEffect({ run_dir: runDir, cycle, owner: "worker-1" }))
      .rejects.toBeInstanceOf(AmbiguousEffectError);
  });

  it("shares strict claim, completion, owner, and result validation with status projection", async () => {
    const { runDir, policyHash } = await setup();
    const cycle = await beginReviewCycle(cycleInput(runDir, policyHash, () => decision));
    const claimed = await claimReviewEffect({ run_dir: runDir, cycle, owner: "worker-1" });
    if (claimed.status !== "acquired") throw new Error("expected acquired effect");
    await expect(validatePersistedReviewEffectState(runDir, cycle, "worker-1")).resolves.toMatchObject({ effect_state: "in_progress" });
    const effectRoot = join(runDir, "reviews", "effects", Buffer.from(cycle.effect_id, "utf8").toString("base64url"));
    await writeFile(join(effectRoot, "claim.json"), `${JSON.stringify({
      ...claimed.cycle,
      effect_state: "complete",
      effect_result: { attempt: 1, implementation_path: "implementation/item.json" },
    }, null, 2)}\n`, "utf8");
    await expect(validatePersistedReviewEffectState(runDir, cycle, "worker-1")).rejects.toThrow(/claim must be in_progress/i);
    await writeFile(join(effectRoot, "claim.json"), `${JSON.stringify(claimed.cycle, null, 2)}\n`, "utf8");
    await writeFile(join(effectRoot, "completion.json"), `${JSON.stringify({
      ...claimed.cycle,
      effect_state: "complete",
      effect_result: { schema_valid_but_wrong: true },
    }, null, 2)}\n`, "utf8");
    await expect(validatePersistedReviewEffectState(runDir, cycle, "worker-1")).rejects.toThrow(/fix effect result is invalid/i);
  });

  it("rejects a stop effect that is schema-valid but terminates as complete", async () => {
    const { runDir, policyHash } = await setup();
    const stop = { ...decision, action: "stop" as const, reason_code: "release_blocker" };
    const cycle = await beginReviewCycle(cycleInput(runDir, policyHash, () => stop));
    await claimReviewEffect({ run_dir: runDir, cycle, owner: "worker-1" });
    await completeReviewEffect({
      run_dir: runDir,
      cycle,
      owner: "worker-1",
      outcome: "complete",
      result: { blocker: "release blocker" },
    });
    await expect(validatePersistedReviewEffectState(runDir, cycle, "worker-1"))
      .rejects.toThrow(/stop review effect must terminate as blocked/i);
  });

  it("reuses a persisted decision without reevaluating", async () => {
    const { runDir, policyHash } = await setup();
    let evaluatorCalls = 0;
    const input = cycleInput(runDir, policyHash, () => {
      evaluatorCalls += 1;
      return decision;
    });

    const first = await beginReviewCycle(input);
    const resumed = await beginReviewCycle(input);

    expect(resumed).toEqual(first);
    expect(evaluatorCalls).toBe(1);
    expect((await readManifestV2(runDir)).review_accounting?.review_revision).toBe(1);
    expect(JSON.parse(await readFile(join(runDir, first.decision_path), "utf8"))).toEqual(first);
  });

  it("persists the decision before updating its accounting summary and repairs replay", async () => {
    const { runDir, policyHash } = await setup();
    const input = cycleInput(runDir, policyHash, () => decision);

    await expect(beginReviewCycle(input, {
      afterDecisionPersisted: async () => { throw new Error("crash after decision"); },
    })).rejects.toThrow("crash after decision");
    expect((await readManifestV2(runDir)).review_accounting?.review_revision).toBe(0);

    let replayCalls = 0;
    const resumed = await beginReviewCycle({ ...input, evaluate: () => {
      replayCalls += 1;
      return decision;
    } });
    expect(replayCalls).toBe(0);
    expect(resumed.effect_state).toBe("pending");
    expect((await readManifestV2(runDir)).review_accounting?.review_revision).toBe(1);
  });

  it("serializes concurrent creation and evaluates exactly once", async () => {
    const { runDir, policyHash } = await setup();
    let calls = 0;
    const input = cycleInput(runDir, policyHash, () => { calls += 1; return decision; });

    const [first, second] = await Promise.all([beginReviewCycle(input), beginReviewCycle(input)]);

    expect(second).toEqual(first);
    expect(calls).toBe(1);
  });

  it("persists the full cycle finding set with a canonical decision subset", async () => {
    const { runDir, policyHash } = await setup();
    const advisoryId = `finding:${"b".repeat(64)}`;
    const cycle = await beginReviewCycle({
      ...cycleInput(runDir, policyHash, () => decision),
      finding_ids: [...decision.finding_ids, advisoryId],
      evaluate: () => decision,
    });

    expect(cycle.finding_ids).toEqual([...decision.finding_ids, advisoryId]);
    expect(cycle.decision.finding_ids).toEqual(decision.finding_ids);
  });

  it("atomically repairs accounting and exact work-item references on concurrent replay", async () => {
    const { runDir, policyHash } = await setup();
    await updateManifestV2(runDir, {
      current_work_item_id: "item/one",
      work_item_progress: { "item/one": { status: "in_progress", attempts: 1 } },
    });
    let evaluatorCalls = 0;
    const input = {
      ...cycleInput(runDir, policyHash, () => { evaluatorCalls += 1; return decision; }),
      work_item_progress_reference: {
        attempts: 1,
        review_path: "reviews/item-one/attempt-1.json",
        verification_path: "verification/issue-1/attempt-1/evidence.json",
      },
    };
    await expect(beginReviewCycle(input, {
      afterDecisionPersisted: async () => { throw new Error("crash before manifest CAS"); },
    })).rejects.toThrow("crash before manifest CAS");
    expect(evaluatorCalls).toBe(1);
    expect((await readManifestV2(runDir)).work_item_progress["item/one"]).not.toHaveProperty("review_cycle_path");

    const [first, second] = await Promise.all([beginReviewCycle(input), beginReviewCycle(input)]);
    expect(second).toEqual(first);
    expect(evaluatorCalls).toBe(1);
    const manifest = await readManifestV2(runDir);
    expect(manifest.review_accounting?.review_revision).toBe(1);
    expect(manifest.work_item_progress["item/one"]).toMatchObject({
      attempts: 1,
      review_revision: 1,
      review_cycle_path: first.decision_path,
      review_effect_id: first.effect_id,
      review_path: input.work_item_progress_reference.review_path,
      verification_path: input.work_item_progress_reference.verification_path,
    });
  });

  it.each([
    ["policy_hash", { policy_hash: "b".repeat(64) }],
    ["finding_ids", { finding_ids: [`finding:${"c".repeat(64)}`] }],
    ["phase", { phase: "post_pr" as const }],
    ["accounting_before", { accounting_before: { ...accounting(), plan_revision: 1 } }],
  ])("rejects replay with changed %s provenance", async (_field, patch) => {
    const { runDir, policyHash } = await setup();
    const input = cycleInput(runDir, policyHash, () => decision);
    await beginReviewCycle(input);

    await expect(beginReviewCycle({ ...input, ...patch })).rejects.toThrow("provenance");
  });

  it("rejects a policy hash that does not match the run snapshot", async () => {
    const { runDir, policyHash } = await setup();
    await expect(beginReviewCycle({
      ...cycleInput(runDir, policyHash, () => decision),
      policy_hash: "0".repeat(64),
    })).rejects.toThrow("policy hash");
  });

  it("distinguishes a new acquisition from an ambiguous persisted claim", async () => {
    const { runDir, policyHash } = await setup();
    const cycle = await beginReviewCycle(cycleInput(runDir, policyHash, () => decision));
    const claimed = await claimReviewEffect({ run_dir: runDir, cycle, owner: "worker-1" });
    expect(claimed.status).toBe("acquired");
    expect(claimed.cycle.effect_state).toBe("in_progress");
    expect(claimed.cycle.effect_owner).toBe("worker-1");
    await expect(claimReviewEffect({ run_dir: runDir, cycle, owner: "worker-1" }))
      .rejects.toBeInstanceOf(AmbiguousEffectError);
    await expect(claimReviewEffect({ run_dir: runDir, cycle, owner: "worker-2" }))
      .rejects.toBeInstanceOf(AmbiguousEffectError);
  });

  it("never generically retries after an effect ran but completion was not persisted", async () => {
    const { runDir, policyHash } = await setup();
    const cycle = await beginReviewCycle(cycleInput(runDir, policyHash, () => decision));
    let externalEffectCalls = 0;
    const first = await claimReviewEffect({ run_dir: runDir, cycle, owner: "worker-1" });
    if (first.status === "acquired") externalEffectCalls += 1;

    await expect(claimReviewEffect({ run_dir: runDir, cycle, owner: "worker-1" }))
      .rejects.toBeInstanceOf(AmbiguousEffectError);
    expect(externalEffectCalls).toBe(1);
  });

  it.each(["complete", "blocked"] as const)("replays a %s effect result", async (outcome) => {
    const { runDir, policyHash } = await setup();
    const cycle = await beginReviewCycle(cycleInput(runDir, policyHash, () => decision));
    await claimReviewEffect({ run_dir: runDir, cycle, owner: "worker-1" });
    const first = await completeReviewEffect({
      run_dir: runDir,
      cycle,
      owner: "worker-1",
      outcome,
      result: { report_path: "implementation/item.json" },
    });
    const resumed = await claimReviewEffect({ run_dir: runDir, cycle, owner: "worker-1" });

    expect(resumed.status).toBe(outcome);
    expect(resumed.cycle).toEqual(first);
    expect(resumed.cycle.effect_state).toBe(outcome);
    expect(resumed.cycle.effect_result).toEqual({ report_path: "implementation/item.json" });
    await expect(completeReviewEffect({
      run_dir: runDir, cycle, owner: "worker-1", outcome,
      result: { report_path: "implementation/other.json" },
    })).rejects.toThrow("different result");
  });

  it("does not complete an unclaimed effect", async () => {
    const { runDir, policyHash } = await setup();
    const cycle = await beginReviewCycle(cycleInput(runDir, policyHash, () => decision));
    await expect(completeReviewEffect({
      run_dir: runDir, cycle, owner: "worker-1", outcome: "complete", result: null,
    })).rejects.toThrow("must be claimed");
  });

  it("rejects a claim marker whose cycle provenance was altered", async () => {
    const { runDir, policyHash } = await setup();
    const cycle = await beginReviewCycle(cycleInput(runDir, policyHash, () => decision));
    const claim = await claimReviewEffect({ run_dir: runDir, cycle, owner: "worker-1" });
    const claimPath = join(
      runDir,
      "reviews/effects",
      Buffer.from(cycle.effect_id).toString("base64url"),
      "claim.json",
    );
    await writeFile(claimPath, `${JSON.stringify({ ...claim.cycle, work_item_id: "other-item" })}\n`);

    await expect(completeReviewEffect({
      run_dir: runDir, cycle, owner: "worker-1", outcome: "complete", result: null,
    })).rejects.toThrow("provenance");
  });

  it("rejects non-JSON effect results before persistence", async () => {
    const { runDir, policyHash } = await setup();
    const cycle = await beginReviewCycle(cycleInput(runDir, policyHash, () => decision));
    await claimReviewEffect({ run_dir: runDir, cycle, owner: "worker-1" });

    await expect(completeReviewEffect({
      run_dir: runDir,
      cycle,
      owner: "worker-1",
      outcome: "complete",
      result: { invalid: undefined },
    })).rejects.toThrow();
  });

  it("treats recursively reordered JSON object keys as the same completion result", async () => {
    const { runDir, policyHash } = await setup();
    const cycle = await beginReviewCycle(cycleInput(runDir, policyHash, () => decision));
    await claimReviewEffect({ run_dir: runDir, cycle, owner: "worker-1" });
    const first = await completeReviewEffect({
      run_dir: runDir,
      cycle,
      owner: "worker-1",
      outcome: "complete",
      result: { z: 1, nested: { b: 2, a: 1 } },
    });
    const replay = await completeReviewEffect({
      run_dir: runDir,
      cycle,
      owner: "worker-1",
      outcome: "complete",
      result: { nested: { a: 1, b: 2 }, z: 1 },
    });

    expect(replay).toEqual(first);
    expect(Object.keys(replay.effect_result as object)).toEqual(["nested", "z"]);
  });

  it.each([
    undefined,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    { nested: undefined },
  ])("rejects invalid JSON completion replay %s", async (invalidResult) => {
    const { runDir, policyHash } = await setup();
    const cycle = await beginReviewCycle(cycleInput(runDir, policyHash, () => decision));
    await claimReviewEffect({ run_dir: runDir, cycle, owner: "worker-1" });
    await completeReviewEffect({
      run_dir: runDir, cycle, owner: "worker-1", outcome: "complete", result: { valid: true },
    });

    await expect(completeReviewEffect({
      run_dir: runDir, cycle, owner: "worker-1", outcome: "complete", result: invalidResult,
    })).rejects.toThrow();
  });

  it("rejects symlinked decision artifact directories", async () => {
    const { runDir, policyHash } = await setup();
    const outside = join(repoRoot!, "outside-decisions");
    await mkdir(outside);
    await mkdir(join(runDir, "reviews"), { recursive: true });
    await symlink(outside, join(runDir, "reviews", "decisions"));

    await expect(beginReviewCycle(cycleInput(runDir, policyHash, () => decision)))
      .rejects.toThrow("must not be a symlink");
  });
});

describe("review accounting", () => {
  it("rejects direct replay of a missing-action quality marker without projecting accounting", async () => {
    const context = await interruptedLegacyQualityMarker();

    await expect(incrementSuccessfulFix(context.input))
      .rejects.toThrow(/legacy review-effect action|immutable ordinary-fix cycle/i);

    await expectLegacyQualityStateUnchanged(context);
  });

  it("rejects unrelated reconciliation of a missing-action quality marker before any mutation", async () => {
    const context = await interruptedLegacyQualityMarker();

    await expect(incrementSelfReviewMutation({
      run_dir: context.runDir,
      mutation_id: "self:after-legacy-quality",
    })).rejects.toThrow(/legacy review-effect action|immutable ordinary-fix cycle/i);

    await expectLegacyQualityStateUnchanged(context);
  });

  it("rejects an explicit marker action that conflicts with its immutable quality cycle", async () => {
    const context = await interruptedLegacyQualityMarker();
    const marker = JSON.parse(await readFile(context.markerPath, "utf8"));
    marker.effect_action = "fix";
    context.markerBytes = `${JSON.stringify(marker, null, 2)}\n`;
    await writeFile(context.markerPath, context.markerBytes, "utf8");

    await expect(incrementSelfReviewMutation({
      run_dir: context.runDir,
      mutation_id: "self:after-conflicting-quality",
    })).rejects.toThrow(/action|immutable cycle/i);

    await expectLegacyQualityStateUnchanged(context);
  });

  it("rejects cycle canonicalization through a missing-action quality marker before persisting a decision", async () => {
    const context = await interruptedLegacyQualityMarker();

    await expect(beginReviewCycle({
      ...cycleInput(context.runDir, context.policyHash, () => decision),
      work_item_id: "item/two",
      review_revision: 2,
      accounting_before: context.manifestBefore.review_accounting!,
    })).rejects.toThrow(/legacy review-effect action|immutable ordinary-fix cycle/i);

    await expectLegacyQualityStateUnchanged(context);
  });

  it("rejects a missing-action quality reservation before it can count toward admission", async () => {
    const { runDir, cycle } = await setupQualityRecoveryCycle();
    await claimReviewEffect({ run_dir: runDir, cycle, owner: "worker-1" });
    const first = {
      run_dir: runDir,
      cycle,
      owner: "worker-1",
      mutation_id: "R1-A1:attempt-1",
      effect_action: "quality_recovery" as const,
    };
    await reserveFixSlot(first);
    const reservationPath = join(
      runDir,
      "reviews/accounting/reservations",
      Buffer.from(`${cycle.effect_id}:${first.mutation_id}`).toString("base64url"),
      "reservation.json",
    );
    const reservationBytes = await removeEffectAction(reservationPath);
    const manifestBefore = await readManifestV2(runDir);
    const artifactsBefore = await accountingArtifacts(runDir);

    await expect(reserveFixSlot({ ...first, mutation_id: "R1-A2:attempt-1" }))
      .rejects.toThrow(/legacy review-effect action|immutable ordinary-fix cycle/i);

    const manifestAfter = await readManifestV2(runDir);
    expect(manifestAfter.review_accounting).toEqual(manifestBefore.review_accounting);
    expect(manifestAfter.work_item_progress[cycle.work_item_id]?.quality_recovery_attempts)
      .toBe(manifestBefore.work_item_progress[cycle.work_item_id]?.quality_recovery_attempts);
    expect(await readFile(reservationPath, "utf8")).toBe(reservationBytes);
    expect(await accountingArtifacts(runDir)).toEqual(artifactsBefore);
  });

  it.each(["reservation", "completion"] as const)(
    "rejects a missing-action charged quality %s before completion or accounting projection",
    async (legacyArtifact) => {
      const { runDir, cycle } = await setupQualityRecoveryCycle();
      await claimReviewEffect({ run_dir: runDir, cycle, owner: "worker-1" });
      const input = {
        run_dir: runDir,
        cycle,
        owner: "worker-1",
        mutation_id: "R1-A1:attempt-1",
        effect_action: "quality_recovery" as const,
      };
      await reserveFixSlot(input);
      await expect(commitReservedFixSlot(input, {
        afterReservationCompletionPersisted: async () => { throw new Error("crash after quality completion"); },
      })).rejects.toThrow("crash after quality completion");
      const reservationRoot = join(
        runDir,
        "reviews/accounting/reservations",
        Buffer.from(`${cycle.effect_id}:${input.mutation_id}`).toString("base64url"),
      );
      const markerPath = join(
        runDir,
        "reviews/accounting/fixes",
        `${Buffer.from(`${cycle.effect_id}:${input.mutation_id}`).toString("base64url")}.json`,
      );
      const artifactPaths = [
        join(reservationRoot, "reservation.json"),
        join(reservationRoot, "completion.json"),
        markerPath,
      ];
      const legacyPath = legacyArtifact === "reservation" ? artifactPaths[0]! : artifactPaths[1]!;
      const legacyBytes = await removeEffectAction(legacyPath);
      const artifactBytes = await Promise.all(artifactPaths.map((path) => readFile(path, "utf8")));
      const manifestBefore = await readManifestV2(runDir);
      const artifactsBefore = await accountingArtifacts(runDir);

      await expect(commitReservedFixSlot(input))
        .rejects.toThrow(/legacy review-effect action|immutable ordinary-fix cycle/i);

      const manifestAfter = await readManifestV2(runDir);
      expect(manifestAfter.review_accounting).toEqual(manifestBefore.review_accounting);
      expect(manifestAfter.work_item_progress[cycle.work_item_id]?.quality_recovery_attempts)
        .toBe(manifestBefore.work_item_progress[cycle.work_item_id]?.quality_recovery_attempts);
      expect(await readFile(legacyPath, "utf8")).toBe(legacyBytes);
      await expect(Promise.all(artifactPaths.map((path) => readFile(path, "utf8"))))
        .resolves.toEqual(artifactBytes);
      expect(await accountingArtifacts(runDir)).toEqual(artifactsBefore);
    },
  );

  it("replays a parent-format ordinary marker without rewriting its bytes or inferring quality recovery", async () => {
    const { runDir, policyHash } = await setup();
    const cycle = await beginReviewCycle(cycleInput(runDir, policyHash, () => decision));
    const input = {
      run_dir: runDir,
      cycle,
      owner: "worker-1",
      mutation_id: "fix:legacy-marker",
      kind: "successful_fix" as const,
      effect_action: "fix" as const,
    };
    await claimReviewEffect(input);
    await completeReviewEffect({
      ...input,
      outcome: "complete",
      result: { attempt: 2, implementation_path: input.mutation_id },
    });
    const charged = await incrementSuccessfulFix(input);
    const markerPath = join(
      runDir,
      "reviews/accounting/fixes",
      `${Buffer.from(cycle.effect_id).toString("base64url")}.json`,
    );
    const parentBytes = await removeEffectAction(markerPath);

    await expect(incrementSuccessfulFix(input)).resolves.toEqual(charged);
    await expect(incrementSuccessfulFix({ ...input, effect_action: "quality_recovery" }))
      .rejects.toThrow(/action|quality recovery|provenance/i);
    expect(await readFile(markerPath, "utf8")).toBe(parentBytes);
  });

  it("replays a parent-format active reservation as ordinary fix without rewriting it", async () => {
    const { runDir, policyHash } = await setup();
    const cycle = await beginReviewCycle(cycleInput(runDir, policyHash, () => decision));
    const input = {
      run_dir: runDir,
      cycle,
      owner: "worker-1",
      mutation_id: "R1-A1:attempt-1",
      effect_action: "fix" as const,
    };
    await claimReviewEffect(input);
    await reserveFixSlot(input);
    const reservationPath = join(
      runDir,
      "reviews/accounting/reservations",
      Buffer.from(`${cycle.effect_id}:${input.mutation_id}`).toString("base64url"),
      "reservation.json",
    );
    const parentBytes = await removeEffectAction(reservationPath);

    await expect(reserveFixSlot(input)).resolves.toEqual({ status: "admitted", mutation_id: input.mutation_id });
    await expect(reserveFixSlot({ ...input, effect_action: "quality_recovery" }))
      .rejects.toThrow(/action|quality recovery|provenance/i);
    expect(await readFile(reservationPath, "utf8")).toBe(parentBytes);
  });

  it("replays parent-format charged reservation artifacts without rewriting them", async () => {
    const { runDir, policyHash } = await setup();
    const cycle = await beginReviewCycle(cycleInput(runDir, policyHash, () => decision));
    const input = {
      run_dir: runDir,
      cycle,
      owner: "worker-1",
      mutation_id: "R1-A1:attempt-1",
      effect_action: "fix" as const,
    };
    await claimReviewEffect(input);
    await reserveFixSlot(input);
    const charged = await commitReservedFixSlot(input);
    const reservationRoot = join(
      runDir,
      "reviews/accounting/reservations",
      Buffer.from(`${cycle.effect_id}:${input.mutation_id}`).toString("base64url"),
    );
    const markerPath = join(
      runDir,
      "reviews/accounting/fixes",
      `${Buffer.from(`${cycle.effect_id}:${input.mutation_id}`).toString("base64url")}.json`,
    );
    const artifacts = [join(reservationRoot, "reservation.json"), join(reservationRoot, "completion.json"), markerPath];
    const parentBytes = await Promise.all(artifacts.map(removeEffectAction));

    await expect(commitReservedFixSlot(input)).resolves.toEqual(charged);
    await expect(commitReservedFixSlot({ ...input, effect_action: "quality_recovery" }))
      .rejects.toThrow(/action|quality recovery|provenance/i);
    await expect(Promise.all(artifacts.map((path) => readFile(path, "utf8"))))
      .resolves.toEqual(parentBytes);
  });

  it("reconciles and proves successful-fix provenance from a parent-format ordinary marker", async () => {
    const { runDir, policyHash } = await setup();
    const cycle = await beginReviewCycle(cycleInput(runDir, policyHash, () => decision));
    const implementationPath = "implementation/item_one/legacy-attempt.json";
    await mkdir(join(runDir, "implementation/item_one"), { recursive: true });
    await writeFile(join(runDir, implementationPath), "{}\n");
    await claimReviewEffect({ run_dir: runDir, cycle, owner: "worker-1" });
    await completeReviewEffect({
      run_dir: runDir,
      cycle,
      owner: "worker-1",
      outcome: "complete",
      result: { attempt: 2, implementation_path: implementationPath },
    });
    await expect(incrementSuccessfulFix({
      run_dir: runDir,
      cycle,
      owner: "worker-1",
      mutation_id: implementationPath,
      kind: "successful_fix",
      effect_action: "fix",
    }, {
      afterMarkerPersisted: async () => { throw new Error("crash after parent marker"); },
    })).rejects.toThrow("crash after parent marker");
    const markerPath = join(
      runDir,
      "reviews/accounting/fixes",
      `${Buffer.from(cycle.effect_id).toString("base64url")}.json`,
    );
    const parentBytes = await removeEffectAction(markerPath);
    const stale = (await readManifestV2(runDir)).review_accounting!;

    const next = await beginReviewCycle({
      ...cycleInput(runDir, policyHash, () => decision),
      work_item_id: "item/two",
      review_revision: 2,
      accounting_before: stale,
    });
    const current = (await readManifestV2(runDir)).review_accounting!;
    const provenance = await withRunLedgerCompoundTransaction(runDir, (transaction) =>
      loadSuccessfulFixProvenanceLocked(transaction, current));

    expect(next.accounting_before.fix_cycles_used).toBe(1);
    expect(provenance).toEqual({ successful_hands_fixes: 1, evidence_refs: [implementationPath] });
    expect(await readFile(markerPath, "utf8")).toBe(parentBytes);
  });

  it("reserves and charges quality recovery exactly once with immutable action provenance", async () => {
    const { runDir, cycle } = await setupQualityRecoveryCycle();
    await claimReviewEffect({ run_dir: runDir, cycle, owner: "worker-1" });
    const input = {
      run_dir: runDir,
      cycle,
      owner: "worker-1",
      mutation_id: "R1-A1:attempt-1",
      effect_action: "quality_recovery" as const,
    };

    await expect(reserveFixSlot(input)).resolves.toEqual({
      status: "admitted",
      mutation_id: input.mutation_id,
    });
    await expect(reserveFixSlot({ ...input, effect_action: "fix" }))
      .rejects.toThrow(/action|provenance/i);

    const charged = await commitReservedFixSlot(input);
    const markerPath = join(
      runDir,
      "reviews/accounting/fixes",
      `${Buffer.from(`${cycle.effect_id}:${input.mutation_id}`).toString("base64url")}.json`,
    );
    const marker = JSON.parse(await readFile(markerPath, "utf8"));
    expect(marker.effect_action).toBe("quality_recovery");
    expect(marker.accounting_after.fix_cycles_used).toBe(4);
    expect(charged.fix_cycles_used).toBe(4);
    expect((await readManifestV2(runDir)).review_accounting?.fix_cycles_used).toBe(4);
    expect((await readManifestV2(runDir)).work_item_progress[cycle.work_item_id]?.quality_recovery_attempts).toBe(1);
    const replay = await commitReservedFixSlot(input);
    await expect(commitReservedFixSlot({ ...input, effect_action: "fix" }))
      .rejects.toThrow(/action|provenance/i);
    const manifest = await readManifestV2(runDir);
    expect(replay).toEqual(charged);
    expect(manifest.review_accounting?.fix_cycles_used).toBe(4);
    expect(manifest.work_item_progress[cycle.work_item_id]?.quality_recovery_attempts).toBe(1);
  });

  it("atomically admits only one of two distinct concurrent quality-recovery reservations", async () => {
    const { runDir, cycle } = await setupQualityRecoveryCycle();
    await claimReviewEffect({ run_dir: runDir, cycle, owner: "worker-1" });
    const base = { run_dir: runDir, cycle, owner: "worker-1", effect_action: "quality_recovery" as const };

    const [first, second] = await Promise.all([
      reserveFixSlot({ ...base, mutation_id: "R1-A1:attempt-1" }),
      reserveFixSlot({ ...base, mutation_id: "R1-A2:attempt-1" }),
    ]);

    expect([first.status, second.status].sort()).toEqual(["admitted", "exhausted"]);
    const admitted = first.status === "admitted" ? first : second;
    if (admitted.status !== "admitted") throw new Error("expected one admitted quality reservation");
    const charged = await commitReservedFixSlot({ ...base, mutation_id: admitted.mutation_id });
    const manifest = await readManifestV2(runDir);
    expect(charged.fix_cycles_used).toBe(4);
    expect(manifest.review_accounting?.fix_cycles_used).toBe(4);
    expect(manifest.work_item_progress[cycle.work_item_id]?.quality_recovery_attempts).toBe(1);
    await expect(reserveFixSlot({ ...base, mutation_id: "R1-A3:attempt-1" }))
      .rejects.toThrow(/quality recovery|eligible|exhausted/i);
  });

  it.each([
    ["marker", "afterMarkerPersisted"],
    ["accounting projection", "afterAccountingPersisted"],
    ["attempt projection", "afterQualityRecoveryAttemptPersisted"],
  ] as const)("replays direct quality recovery after interruption at the %s boundary", async (_name, hookName) => {
    const { runDir, cycle } = await setupQualityRecoveryCycle();
    const implementationPath = "implementation/item_one/quality-direct.json";
    await mkdir(join(runDir, "implementation/item_one"), { recursive: true });
    await writeFile(join(runDir, implementationPath), "{}\n");
    const input = {
      run_dir: runDir,
      cycle,
      owner: "worker-1",
      mutation_id: implementationPath,
      kind: "successful_fix" as const,
      effect_action: "quality_recovery" as const,
    };
    await claimReviewEffect(input);
    await completeReviewEffect({
      ...input,
      outcome: "complete",
      result: { attempt: 4, implementation_path: implementationPath },
    });

    await expect(incrementSuccessfulFix(input, {
      [hookName]: async () => {
        if (hookName === "afterAccountingPersisted") {
          const projected = await readManifestV2(runDir);
          expect(projected.review_accounting?.fix_cycles_used).toBe(4);
          expect(projected.work_item_progress[cycle.work_item_id]?.quality_recovery_attempts).toBe(1);
        }
        throw new Error(`crash after ${hookName}`);
      },
    })).rejects.toThrow(`crash after ${hookName}`);
    const replay = await incrementSuccessfulFix(input);
    const manifest = await readManifestV2(runDir);
    const markerPath = join(
      runDir,
      "reviews/accounting/fixes",
      `${Buffer.from(cycle.effect_id).toString("base64url")}.json`,
    );
    const marker = JSON.parse(await readFile(markerPath, "utf8"));

    expect(replay.fix_cycles_used).toBe(4);
    expect(manifest.review_accounting?.fix_cycles_used).toBe(4);
    expect(manifest.work_item_progress[cycle.work_item_id]?.quality_recovery_attempts).toBe(1);
    expect(marker.effect_action).toBe("quality_recovery");
    await expect(incrementSuccessfulFix({ ...input, effect_action: "fix" }))
      .rejects.toThrow(/action|provenance/i);
  });

  it.each([
    ["reservation", "reserve", "afterReservationPersisted"],
    ["marker", "commit", "afterMarkerPersisted"],
    ["completion", "commit", "afterReservationCompletionPersisted"],
    ["accounting projection", "commit", "afterAccountingPersisted"],
    ["attempt projection", "commit", "afterQualityRecoveryAttemptPersisted"],
  ] as const)("replays reserved quality recovery after interruption at the %s boundary", async (_name, operation, hookName) => {
    const { runDir, cycle } = await setupQualityRecoveryCycle();
    await claimReviewEffect({ run_dir: runDir, cycle, owner: "worker-1" });
    const input = {
      run_dir: runDir,
      cycle,
      owner: "worker-1",
      mutation_id: "R1-A1:attempt-1",
      effect_action: "quality_recovery" as const,
    };
    const hooks = {
      [hookName]: async () => {
        if (hookName === "afterAccountingPersisted") {
          const projected = await readManifestV2(runDir);
          expect(projected.review_accounting?.fix_cycles_used).toBe(4);
          expect(projected.work_item_progress[cycle.work_item_id]?.quality_recovery_attempts).toBe(1);
        }
        throw new Error(`crash after ${hookName}`);
      },
    };

    if (operation === "reserve") {
      await expect(reserveFixSlot(input, hooks)).rejects.toThrow(`crash after ${hookName}`);
      await expect(reserveFixSlot({ ...input, mutation_id: "R1-A2:attempt-1" }))
        .resolves.toEqual({ status: "exhausted" });
      await expect(reserveFixSlot(input)).resolves.toEqual({ status: "admitted", mutation_id: input.mutation_id });
    } else {
      await reserveFixSlot(input);
      await expect(commitReservedFixSlot(input, hooks)).rejects.toThrow(`crash after ${hookName}`);
    }

    const replay = await commitReservedFixSlot(input);
    const manifest = await readManifestV2(runDir);
    const reservationRoot = join(
      runDir,
      "reviews/accounting/reservations",
      Buffer.from(`${cycle.effect_id}:${input.mutation_id}`).toString("base64url"),
    );
    const reservation = JSON.parse(await readFile(join(reservationRoot, "reservation.json"), "utf8"));
    const completion = JSON.parse(await readFile(join(reservationRoot, "completion.json"), "utf8"));
    const roots = await readdir(join(runDir, "reviews/accounting/reservations"));

    expect(replay.fix_cycles_used).toBe(4);
    expect(manifest.review_accounting?.fix_cycles_used).toBe(4);
    expect(manifest.work_item_progress[cycle.work_item_id]?.quality_recovery_attempts).toBe(1);
    expect(reservation.effect_action).toBe("quality_recovery");
    expect(completion).toEqual({ ...reservation, status: "charged" });
    expect(roots).toHaveLength(1);
    await expect(commitReservedFixSlot({ ...input, effect_action: "fix" }))
      .rejects.toThrow(/action|provenance/i);
    await expect(reserveFixSlot({ ...input, mutation_id: "R1-A3:attempt-1" }))
      .rejects.toThrow(/quality recovery|eligible|exhausted/i);
  });

  it.each([
    ["direct", "self-review mutation"],
    ["reserved", "self-review mutation"],
    ["direct", "cycle creation"],
    ["reserved", "cycle creation"],
  ] as const)("atomically reconciles a strict %s quality marker through %s", async (mode, consumer) => {
    const context = await interruptedStrictQualityMarker(mode);
    const before = await readManifestV2(context.runDir);
    const maxFixCycles = before.review_policy_snapshot!.max_fix_cycles;
    expect(before.review_accounting?.fix_cycles_used).toBe(maxFixCycles);
    expect(before.work_item_progress[context.cycle.work_item_id]?.quality_recovery_attempts).toBe(0);

    if (consumer === "self-review mutation") {
      const reconciled = await incrementSelfReviewMutation({
        run_dir: context.runDir,
        mutation_id: `self:reconcile:${mode}`,
      });
      expect(reconciled.self_review_mutations_used).toBe(1);
    } else {
      const next = await beginReviewCycle({
        run_dir: context.runDir,
        work_item_id: "item/two",
        phase: "work_item",
        review_revision: 2,
        policy_hash: context.policyHash,
        finding_ids: [],
        accounting_before: before.review_accounting!,
        evaluate: () => ({
          action: "advance",
          reason_code: "no_blocking_findings",
          finding_ids: [],
          policy_revision: context.cycle.decision.policy_revision,
          authorization_required: false,
        }),
      });
      expect(next.accounting_before.fix_cycles_used).toBe(maxFixCycles + 1);
    }

    const reconciled = await readManifestV2(context.runDir);
    expect(reconciled.review_accounting?.fix_cycles_used).toBe(maxFixCycles + 1);
    expect(reconciled.work_item_progress[context.cycle.work_item_id]?.quality_recovery_attempts).toBe(1);
    expect(await readFile(context.markerPath, "utf8")).toBe(context.markerBytes);

    const replay = context.mode === "direct"
      ? await incrementSuccessfulFix(context.input)
      : await commitReservedFixSlot(context.input);
    expect(replay.fix_cycles_used).toBe(maxFixCycles + 1);
    expect(await directoryEntries(join(context.runDir, "reviews/accounting/fixes"))).toHaveLength(1);
    if (context.reservationRoot) {
      expect(await directoryEntries(join(context.runDir, "reviews/accounting/reservations"))).toHaveLength(1);
      expect(await directoryEntries(context.reservationRoot)).toEqual(["completion.json", "reservation.json"]);
    }
    expect((await readOperatorStatus(context.runDir)).operator_state).not.toBe("operationally_blocked");
    await expect(resumeRun({ runDir: context.runDir })).resolves.toContain("resume");
    const afterReads = await readManifestV2(context.runDir);
    expect(afterReads.review_accounting?.fix_cycles_used).toBe(maxFixCycles + 1);
    expect(afterReads.work_item_progress[context.cycle.work_item_id]?.quality_recovery_attempts).toBe(1);
    expect(await readFile(context.markerPath, "utf8")).toBe(context.markerBytes);
  });

  it.each([
    ["direct", "missing progress"],
    ["reserved", "missing progress"],
    ["direct", "corrupt attempt count"],
    ["reserved", "corrupt attempt count"],
  ] as const)("rejects %s quality-marker reconciliation with %s before any projection", async (mode, corruption) => {
    const context = await interruptedStrictQualityMarker(mode);
    const manifestPath = join(context.runDir, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    if (corruption === "missing progress") {
      delete manifest.work_item_progress[context.cycle.work_item_id];
    } else {
      manifest.work_item_progress[context.cycle.work_item_id].quality_recovery_attempts = 2;
    }
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
    const before = await readManifestV2(context.runDir);
    const artifactsBefore = await accountingArtifacts(context.runDir);

    await expect(incrementSelfReviewMutation({
      run_dir: context.runDir,
      mutation_id: `self:invalid:${mode}:${corruption}`,
    })).rejects.toThrow(/quality recovery|progress|attempt/i);

    const after = await readManifestV2(context.runDir);
    expect(after.review_accounting).toEqual(before.review_accounting);
    expect(after.work_item_progress).toEqual(before.work_item_progress);
    expect(await accountingArtifacts(context.runDir)).toEqual(artifactsBefore);
    expect(await readFile(context.markerPath, "utf8")).toBe(context.markerBytes);
  });

  it("rejects quality-recovery reservation without the exact canonical eligibility snapshot", async () => {
    const { runDir, cycle } = await setupQualityRecoveryCycle();
    await claimReviewEffect({ run_dir: runDir, cycle, owner: "worker-1" });
    const manifestPath = join(runDir, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.active_hands_profile = "backup";
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);

    await expect(reserveFixSlot({
      run_dir: runDir,
      cycle,
      owner: "worker-1",
      mutation_id: "R1-A1:attempt-1",
      effect_action: "quality_recovery",
    })).rejects.toThrow(/quality recovery|eligible|primary/i);
  });

  it("derives a continuous successful-fix chain and owned evidence under the ledger lock", async () => {
    const { runDir, policyHash } = await setup();
    const cycle = await beginReviewCycle(cycleInput(runDir, policyHash, () => decision));
    const implementationPath = "implementation/item_one/attempt-2.json";
    await mkdir(join(runDir, "implementation/item_one"), { recursive: true });
    await writeFile(join(runDir, implementationPath), "{}\n");
    await claimReviewEffect({ run_dir: runDir, cycle, owner: "worker-1" });
    await completeReviewEffect({
      run_dir: runDir,
      cycle,
      owner: "worker-1",
      outcome: "complete",
      result: { attempt: 2, implementation_path: implementationPath },
    });
    await incrementSuccessfulFix({
      run_dir: runDir,
      cycle,
      owner: "worker-1",
      mutation_id: implementationPath,
      kind: "successful_fix",
      effect_action: "fix",
    });
    const current = (await readManifestV2(runDir)).review_accounting!;

    const provenance = await withRunLedgerCompoundTransaction(runDir, (transaction) =>
      loadSuccessfulFixProvenanceLocked(transaction, current));

    expect(provenance).toEqual({
      successful_hands_fixes: 1,
      evidence_refs: [implementationPath],
    });
  });

  it("keeps historical fix markers valid after a replan resets the current revision count", async () => {
    const { runDir, policyHash } = await setup();
    const cycle = await beginReviewCycle(cycleInput(runDir, policyHash, () => decision));
    const implementationPath = "implementation/item_one/attempt-2.json";
    await mkdir(join(runDir, "implementation/item_one"), { recursive: true });
    await writeFile(join(runDir, implementationPath), "{}\n");
    await claimReviewEffect({ run_dir: runDir, cycle, owner: "worker-1" });
    await completeReviewEffect({
      run_dir: runDir,
      cycle,
      owner: "worker-1",
      outcome: "complete",
      result: { attempt: 2, implementation_path: implementationPath },
    });
    await incrementSuccessfulFix({
      run_dir: runDir,
      cycle,
      owner: "worker-1",
      mutation_id: implementationPath,
      kind: "successful_fix",
      effect_action: "fix",
    });
    const manifestPath = join(runDir, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.review_accounting = {
      ...manifest.review_accounting,
      fix_cycles_used: 0,
      plan_revision: manifest.review_accounting.plan_revision + 1,
    };
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
    const resetAccounting = (await readManifestV2(runDir)).review_accounting!;

    const provenance = await withRunLedgerCompoundTransaction(runDir, (transaction) =>
      loadSuccessfulFixProvenanceLocked(transaction, resetAccounting));

    expect(provenance).toEqual({ successful_hands_fixes: 0, evidence_refs: [] });

    const next = await beginReviewCycle({
      ...cycleInput(runDir, policyHash, () => decision),
      work_item_id: "item/two",
      review_revision: resetAccounting.review_revision + 1,
      accounting_before: resetAccounting,
    });
    expect(next.accounting_before).toEqual(resetAccounting);
    expect((await readManifestV2(runDir)).review_accounting).toEqual({
      ...resetAccounting,
      review_revision: resetAccounting.review_revision + 1,
    });
  });

  it("rejects successful-fix evidence below a symlinked owned parent", async () => {
    const { runDir, policyHash } = await setup();
    const cycle = await beginReviewCycle(cycleInput(runDir, policyHash, () => decision));
    const implementationPath = "implementation/item_one/attempt-2.json";
    const outside = join(repoRoot!, "outside-implementation");
    await mkdir(outside);
    await writeFile(join(outside, "attempt-2.json"), "{}\n");
    await symlink(outside, join(runDir, "implementation/item_one"));
    await claimReviewEffect({ run_dir: runDir, cycle, owner: "worker-1" });
    await completeReviewEffect({
      run_dir: runDir,
      cycle,
      owner: "worker-1",
      outcome: "complete",
      result: { attempt: 2, implementation_path: implementationPath },
    });
    await incrementSuccessfulFix({
      run_dir: runDir,
      cycle,
      owner: "worker-1",
      mutation_id: implementationPath,
      kind: "successful_fix",
      effect_action: "fix",
    });
    const current = (await readManifestV2(runDir)).review_accounting!;

    await expect(withRunLedgerCompoundTransaction(runDir, (transaction) =>
      loadSuccessfulFixProvenanceLocked(transaction, current)))
      .rejects.toThrow(/symlink|outside|confined/i);
  });

  it("atomically admits exactly one concurrent caller for the last fix slot", async () => {
    const { runDir, policyHash } = await setup();
    const cycle = await beginReviewCycle(cycleInput(runDir, policyHash, () => decision));
    await claimReviewEffect({ run_dir: runDir, cycle, owner: "worker-1" });
    const manifestPath = join(runDir, "manifest.json");
    const current = JSON.parse(await readFile(manifestPath, "utf8"));
    current.review_policy_snapshot.max_fix_cycles = 1;
    await writeFile(manifestPath, `${JSON.stringify(current)}\n`);
    const base = { run_dir: runDir, cycle, owner: "worker-1", effect_action: "fix" as const };

    const [first, second] = await Promise.all([
      reserveFixSlot({ ...base, mutation_id: "R1-A1:attempt-1" }),
      reserveFixSlot({ ...base, mutation_id: "R1-A2:attempt-1" }),
    ]);

    expect([first.status, second.status].sort()).toEqual(["admitted", "exhausted"]);
    const admitted = first.status === "admitted" ? first : second;
    if (admitted.status !== "admitted") throw new Error("expected one admitted reservation");
    const charged = await commitReservedFixSlot({
      run_dir: runDir,
      cycle,
      owner: "worker-1",
      mutation_id: admitted.mutation_id,
      effect_action: "fix",
    });
    expect(charged.fix_cycles_used).toBe(1);
    expect((await commitReservedFixSlot({
      run_dir: runDir,
      cycle,
      owner: "worker-1",
      mutation_id: admitted.mutation_id,
      effect_action: "fix",
    })).fix_cycles_used).toBe(1);
    expect((await assertChargedFixSlot({
      run_dir: runDir,
      cycle,
      owner: "worker-1",
      mutation_id: admitted.mutation_id,
    })).fix_cycles_used).toBe(1);
    const unrelatedMutationId = admitted.mutation_id === "R1-A1:attempt-1"
      ? "R1-A2:attempt-1"
      : "R1-A1:attempt-1";
    await expect(assertChargedFixSlot({
      run_dir: runDir,
      cycle,
      owner: "worker-1",
      mutation_id: unrelatedMutationId,
    })).rejects.toThrow(/not provably charged/i);
    expect((await reserveFixSlot({ ...base, mutation_id: admitted.mutation_id })).status).toBe("admitted");
  });

  it.each([
    "R1-A1:attempt-01",
    "R1-A1:attempt-0",
    "R01-A1:attempt-1",
    "R1-A01:attempt-1",
  ])("rejects non-canonical action mutation id %s before reservation", async (mutationId) => {
    const { runDir, policyHash } = await setup();
    const cycle = await beginReviewCycle(cycleInput(runDir, policyHash, () => decision));
    await claimReviewEffect({ run_dir: runDir, cycle, owner: "worker-1" });

    await expect(reserveFixSlot({
      run_dir: runDir,
      cycle,
      owner: "worker-1",
      mutation_id: mutationId,
      effect_action: "fix",
    })).rejects.toThrow(/canonical action mutation/i);
    const accountingEntries = await readdir(join(runDir, "reviews/accounting")).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    expect(accountingEntries).not.toContain("reservations");
  });

  it("rejects fix-slot admission without a snapshotted policy", async () => {
    const { runDir, policyHash } = await setup();
    const cycle = await beginReviewCycle(cycleInput(runDir, policyHash, () => decision));
    await claimReviewEffect({ run_dir: runDir, cycle, owner: "worker-1" });
    const manifestPath = join(runDir, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    delete manifest.review_policy_snapshot;
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);

    await expect(reserveFixSlot({
      run_dir: runDir,
      cycle,
      owner: "worker-1",
      mutation_id: "R1-A1:attempt-1",
      effect_action: "fix",
    })).rejects.toThrow("snapshotted review policy");
  });

  it.each([
    ["initial", false, false],
    ["failed_fix", false, false],
    ["successful_fix", true, false],
    ["successful_action_fix", true, false],
    ["self_review_fix", false, true],
  ] as const)("accounts for %s", (kind, consumesFixCycle, consumesSelfReviewMutation) => {
    const next = nextAccounting(accounting(), { kind });
    expect(next.fix_cycles_used).toBe(consumesFixCycle ? 1 : 0);
    expect(next.self_review_mutations_used).toBe(consumesSelfReviewMutation ? 1 : 0);
  });

  it("charges a completed engine-authorized fix exactly once across replay", async () => {
    const { runDir, policyHash } = await setup();
    const cycle = await beginReviewCycle(cycleInput(runDir, policyHash, () => decision));
    await claimReviewEffect({ run_dir: runDir, cycle, owner: "worker-1" });
    await completeReviewEffect({ run_dir: runDir, cycle, owner: "worker-1", outcome: "complete", result: null });

    const input = {
      run_dir: runDir, cycle, owner: "worker-1", mutation_id: "fix:item-one:1", kind: "successful_fix" as const, effect_action: "fix" as const,
    };
    const first = await incrementSuccessfulFix(input);
    const replay = await incrementSuccessfulFix(input);

    expect(first.fix_cycles_used).toBe(1);
    expect(replay).toEqual(first);
    expect((await readManifestV2(runDir)).review_accounting?.fix_cycles_used).toBe(1);
  });

  it("repairs a crash after the immutable charge marker without double charging", async () => {
    const { runDir, policyHash } = await setup();
    const cycle = await beginReviewCycle(cycleInput(runDir, policyHash, () => decision));
    await claimReviewEffect({ run_dir: runDir, cycle, owner: "worker-1" });
    await completeReviewEffect({ run_dir: runDir, cycle, owner: "worker-1", outcome: "complete", result: null });
    const input = {
      run_dir: runDir, cycle, owner: "worker-1", mutation_id: "R1-A1:attempt-1", kind: "successful_action_fix" as const, effect_action: "fix" as const,
    };
    await expect(incrementSuccessfulFix(input, {
      afterMarkerPersisted: async () => { throw new Error("crash after marker"); },
    })).rejects.toThrow("crash after marker");
    expect((await readManifestV2(runDir)).review_accounting?.fix_cycles_used).toBe(0);

    const repaired = await incrementSuccessfulFix(input);
    expect(repaired.fix_cycles_used).toBe(1);
    expect((await readManifestV2(runDir)).review_accounting?.fix_cycles_used).toBe(1);
  });

  it("repairs an earlier pending marker before applying a different counter mutation", async () => {
    const { runDir, policyHash } = await setup();
    const cycle = await beginReviewCycle(cycleInput(runDir, policyHash, () => decision));
    await claimReviewEffect({ run_dir: runDir, cycle, owner: "worker-1" });
    await completeReviewEffect({ run_dir: runDir, cycle, owner: "worker-1", outcome: "complete", result: null });
    const fix = {
      run_dir: runDir, cycle, owner: "worker-1", mutation_id: "fix:pending", kind: "successful_fix" as const, effect_action: "fix" as const,
    };
    await expect(incrementSuccessfulFix(fix, {
      afterMarkerPersisted: async () => { throw new Error("crash after marker"); },
    })).rejects.toThrow("crash after marker");

    const repairedAndIncremented = await incrementSelfReviewMutation({
      run_dir: runDir,
      mutation_id: "self:later",
    });
    expect(repairedAndIncremented.fix_cycles_used).toBe(1);
    expect(repairedAndIncremented.self_review_mutations_used).toBe(1);
    expect((await incrementSuccessfulFix(fix)).fix_cycles_used).toBe(1);
  });

  it("fails closed on a marker that fabricates counter values", async () => {
    const { runDir, policyHash } = await setup();
    const cycle = await beginReviewCycle(cycleInput(runDir, policyHash, () => decision));
    await claimReviewEffect({ run_dir: runDir, cycle, owner: "worker-1" });
    await completeReviewEffect({ run_dir: runDir, cycle, owner: "worker-1", outcome: "complete", result: null });
    const input = {
      run_dir: runDir, cycle, owner: "worker-1", mutation_id: "fix:corrupt", kind: "successful_fix" as const, effect_action: "fix" as const,
    };
    await expect(incrementSuccessfulFix(input, {
      afterMarkerPersisted: async () => { throw new Error("crash after marker"); },
    })).rejects.toThrow("crash after marker");
    const markerPath = join(
      runDir,
      "reviews/accounting/fixes",
      `${Buffer.from(cycle.effect_id).toString("base64url")}.json`,
    );
    const marker = JSON.parse(await readFile(markerPath, "utf8"));
    marker.accounting_after.fix_cycles_used = 99;
    await writeFile(markerPath, `${JSON.stringify(marker)}\n`);

    await expect(incrementSelfReviewMutation({ run_dir: runDir, mutation_id: "self:after-corrupt" }))
      .rejects.toThrow();
    expect((await readManifestV2(runDir)).review_accounting?.fix_cycles_used).toBe(0);
  });

  it("rejects charging a pending, blocked, failed, or non-fix decision", async () => {
    const { runDir, policyHash } = await setup();
    const cycle = await beginReviewCycle(cycleInput(runDir, policyHash, () => decision));
    await expect(incrementSuccessfulFix({
      run_dir: runDir, cycle, owner: "worker-1", mutation_id: "pending", kind: "successful_fix", effect_action: "fix",
    })).rejects.toThrow("completed effect");

    const advance = { ...decision, action: "advance" as const, reason_code: "no_blocking_findings", finding_ids: [] };
    const second = await beginReviewCycle({
      ...cycleInput(runDir, policyHash, () => advance),
      work_item_id: "item/two", review_revision: 2, finding_ids: [],
      accounting_before: { ...accounting(), review_revision: 1 },
    });
    await claimReviewEffect({ run_dir: runDir, cycle: second, owner: "worker-1" });
    await completeReviewEffect({ run_dir: runDir, cycle: second, owner: "worker-1", outcome: "complete", result: null });
    await expect(incrementSuccessfulFix({
      run_dir: runDir, cycle: second, owner: "worker-1", mutation_id: "advance", kind: "successful_fix", effect_action: "fix",
    })).rejects.toThrow("fix decision");
  });

  it("tracks self-review corrections independently and idempotently", async () => {
    const { runDir } = await setup();
    const first = await incrementSelfReviewMutation({ run_dir: runDir, mutation_id: "self:item:pass-1" });
    const replay = await incrementSelfReviewMutation({ run_dir: runDir, mutation_id: "self:item:pass-1" });

    expect(first.self_review_mutations_used).toBe(1);
    expect(first.fix_cycles_used).toBe(0);
    expect(replay).toEqual(first);
  });

  it("binds one fix charge to the immutable effect id", async () => {
    const { runDir, policyHash } = await setup();
    const cycle = await beginReviewCycle(cycleInput(runDir, policyHash, () => decision));
    await claimReviewEffect({ run_dir: runDir, cycle, owner: "worker-1" });
    await completeReviewEffect({ run_dir: runDir, cycle, owner: "worker-1", outcome: "complete", result: null });
    const firstInput = {
      run_dir: runDir, cycle, owner: "worker-1", mutation_id: "fix:first", kind: "successful_fix" as const, effect_action: "fix" as const,
    };
    await incrementSuccessfulFix(firstInput);
    await expect(incrementSuccessfulFix({ ...firstInput, mutation_id: "fix:second" }))
      .rejects.toThrow("provenance");
    await incrementSelfReviewMutation({ run_dir: runDir, mutation_id: "self:later" });

    const replay = await incrementSuccessfulFix(firstInput);
    expect(replay.fix_cycles_used).toBe(1);
    expect(replay.self_review_mutations_used).toBe(1);
  });

  it("reconciles a crash-left fix marker before beginning the next review", async () => {
    const { runDir, policyHash } = await setup();
    const staleAccounting = await leaveCrashLeftFixMarker(runDir, policyHash);

    const secondCycle = await beginReviewCycle({
      ...cycleInput(runDir, policyHash, () => decision),
      review_revision: 2,
      accounting_before: staleAccounting,
    });
    const finalAccounting = (await readManifestV2(runDir)).review_accounting!;
    expect(secondCycle.accounting_before.fix_cycles_used).toBe(1);
    expect(finalAccounting.review_revision).toBe(2);
    expect(finalAccounting.fix_cycles_used).toBe(1);
  });

  it("replays a cycle from the same marker-stale accounting without reevaluating", async () => {
    const { runDir, policyHash } = await setup();
    const staleAccounting = await leaveCrashLeftFixMarker(runDir, policyHash);
    let evaluatorCalls = 0;
    const input = {
      ...cycleInput(runDir, policyHash, () => { evaluatorCalls += 1; return decision; }),
      review_revision: 2,
      accounting_before: staleAccounting,
    };

    const first = await beginReviewCycle(input);
    const replay = await beginReviewCycle(input);
    expect(replay).toEqual(first);
    expect(evaluatorCalls).toBe(1);
    expect((await readManifestV2(runDir)).review_accounting).toMatchObject({
      review_revision: 2,
      fix_cycles_used: 1,
    });
  });

  it("repairs revision advancement after a decision-persistence crash with marker-stale input", async () => {
    const { runDir, policyHash } = await setup();
    const staleAccounting = await leaveCrashLeftFixMarker(runDir, policyHash);
    const input = {
      ...cycleInput(runDir, policyHash, () => decision),
      review_revision: 2,
      accounting_before: staleAccounting,
    };
    await expect(beginReviewCycle(input, {
      afterDecisionPersisted: async () => { throw new Error("crash after decision"); },
    })).rejects.toThrow("crash after decision");
    const persistedBeforeResume = JSON.parse(await readFile(
      join(runDir, reviewDecisionPath("item/one", 2)),
      "utf8",
    ));
    expect((await readManifestV2(runDir)).review_accounting?.review_revision).toBe(1);

    let replayCalls = 0;
    const resumed = await beginReviewCycle({
      ...input,
      evaluate: () => { replayCalls += 1; return decision; },
    });
    expect(resumed).toEqual(persistedBeforeResume);
    expect(replayCalls).toBe(0);
    expect((await readManifestV2(runDir)).review_accounting).toMatchObject({
      review_revision: 2,
      fix_cycles_used: 1,
    });
    expect(await beginReviewCycle(input)).toEqual(resumed);
  });

  it("converges concurrent cycle calls from the same marker-stale accounting", async () => {
    const { runDir, policyHash } = await setup();
    const staleAccounting = await leaveCrashLeftFixMarker(runDir, policyHash);
    let evaluatorCalls = 0;
    const input = {
      ...cycleInput(runDir, policyHash, () => { evaluatorCalls += 1; return decision; }),
      review_revision: 2,
      accounting_before: staleAccounting,
    };

    const [first, second] = await Promise.all([beginReviewCycle(input), beginReviewCycle(input)]);
    expect(second).toEqual(first);
    expect(evaluatorCalls).toBe(1);
    expect((await readManifestV2(runDir)).review_accounting).toMatchObject({
      review_revision: 2,
      fix_cycles_used: 1,
    });
  });
});
