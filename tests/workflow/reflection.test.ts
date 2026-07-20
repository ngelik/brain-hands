import { mkdir, readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodexAdapter, CodexInvokeInput, CodexInvokeResult } from "../../src/adapters/codex.js";
import { appendRunEvent, approvePlanRevision, createRunLedgerV2, readManifestV2, recordPlan, recordTerminalDisposition, updateManifestV2, writeImmutableValidatedJson } from "../../src/core/ledger.js";
import { assuranceAssessmentSchema, persistedVerifierReviewSchema, verificationEvidenceSchema } from "../../src/core/schema.js";
import type { ImprovementPlan, Reflection, ResolvedRunIntake } from "../../src/core/types.js";
import { planFromReflection, runReflection } from "../../src/workflow/reflection.js";
import * as roleContextWorkflow from "../../src/workflow/role-context.js";
import { openProgressReporter, readProgressEvents, type ProgressReporter } from "../../src/progress/log.js";

const codexMetrics = { usage: null, durationMs: 0, processStarted: false, turnStarted: false, structuredTerminalError: false } as const;

const reflection: Reflection = {
  outcome_summary: "The requested change was delivered and verified.",
  what_worked: ["The plan was approved before implementation."],
  what_was_correct: ["The approved scope matched the requested change."],
  what_failed: ["The first verification attempt required a retry."],
  root_causes: ["The initial acceptance criterion was underspecified."],
  avoidable_rework: ["A focused fixture could have caught the issue earlier."],
  process_improvements: ["Add the regression fixture during planning."],
  improvements: ["Make the acceptance criterion testable before Hands starts."],
  classifications: {
    implementation_defects: [],
    planning_defects: ["The initial acceptance criterion was underspecified."],
    verification_gaps: ["The first verification attempt missed the regression."],
    environment_failures: [],
    external_blockers: [],
    unnecessary_cost_or_rework: ["The retry was avoidable with a focused fixture."],
  },
  candidate_regression_tests: ["Exercise the retry path in a focused test."],
  evidence_paths: ["verification/issue-1/attempt-2/evidence.json"],
};

const improvementPlan: ImprovementPlan = {
  reflection_source: "reflection.json",
  observed_problem: ["The first verification attempt missed a regression."],
  evidence: ["verification/issue-1/attempt-2/evidence.json"],
  recommended_changes: ["Add a regression fixture to the planned work item."],
  expected_benefits: ["The retry path will be covered before implementation."],
  implementation_sequence: ["Add the fixture, then run the focused test."],
  tests_and_acceptance_criteria: ["The regression test fails before the fix and passes after it."],
  risks: ["The fixture may need adjustment if the contract changes."],
  out_of_scope: ["Do not implement the plan in this task."],
};

function intake(repoRoot: string, reflectionEnabled = true): ResolvedRunIntake {
  return {
    task: "Deliver the requested change",
    repo_root: repoRoot,
    mode: "local",
    research: false,
    reflection: reflectionEnabled,
    models: { brain: "brain-model", hands: "hands-model", verifier: "verifier-model" },
    resolved_models: { brain: "brain-model", hands: "hands-model", verifier: "verifier-model" },
    roles: {
      brain: { model: "brain-model", reasoning_effort: "high", sandbox: "read-only" },
      hands: { model: "hands-model", reasoning_effort: "medium", sandbox: "workspace-write" },
      verifier: { model: "verifier-model", reasoning_effort: "high", sandbox: "read-only" },
    },
  };
}

class ReflectionCodex implements CodexAdapter {
  readonly calls: CodexInvokeInput[] = [];

  async invoke(input: CodexInvokeInput): Promise<CodexInvokeResult> {
    this.calls.push(input);
    const parsed = input.artifactName.includes("synthesis")
      ? reflection
      : { summary: `${input.role} process account`, strengths: ["The evidence was durable."], weaknesses: ["One retry was needed."], classifications: ["unnecessary cost or rework"], evidence_paths: reflection.evidence_paths };
    return {
      text: `${JSON.stringify(parsed)}\n`,
      parsed,
      exitCode: 0,
      promptPath: join(input.runDir, "prompts", `${input.artifactName}.md`),
      stdoutPath: join(input.runDir, "responses", `${input.artifactName}.stdout.txt`),
      stderrPath: join(input.runDir, "responses", `${input.artifactName}.stderr.txt`),
      ...codexMetrics,
    };
  }
}

class ImprovementPlanner implements CodexAdapter {
  readonly calls: CodexInvokeInput[] = [];

  async invoke(input: CodexInvokeInput): Promise<CodexInvokeResult> {
    this.calls.push(input);
    return {
      text: `${JSON.stringify(improvementPlan)}\n`,
      parsed: improvementPlan,
      exitCode: 0,
      promptPath: join(input.runDir, "prompts", `${input.artifactName}.md`),
      stdoutPath: join(input.runDir, "responses", `${input.artifactName}.stdout.txt`),
      stderrPath: join(input.runDir, "responses", `${input.artifactName}.stderr.txt`),
      ...codexMetrics,
    };
  }
}

class InterruptAfterBrainAccount extends ReflectionCodex {
  override async invoke(input: CodexInvokeInput): Promise<CodexInvokeResult> {
    if (input.artifactName === "reflection-hands-account") throw new Error("simulated reflection interruption");
    return super.invoke(input);
  }
}

let roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  roots = [];
});

async function completeLedger(reflectionEnabled = true) {
  const repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-reflection-"));
  roots.push(repoRoot);
  await writeFile(join(repoRoot, "process-note.md"), "process evidence\n", "utf8");
  const run = await createRunLedgerV2({
    repoRoot,
    originalRequest: "Deliver the requested change",
    slug: "reflection",
    intake: { ...intake(repoRoot, reflectionEnabled) },
    roles: intake(repoRoot).roles,
  });
  await overwriteManifestForAuthorityTest(run.runDir, {
    workflow_protocol: "legacy-v2",
    reflection_protocol: undefined,
    discovery: null,
    resource_budget_policy: undefined,
    stage: "complete",
    retry_counts: { "item-1": 1 },
  });
  await writeFile(join(run.runDir, "plans/revision-1.md"), "Approved plan\n", "utf8");
  await mkdir(join(run.runDir, "implementation/item-1"), { recursive: true });
  await mkdir(join(run.runDir, "verification/issue-1/attempt-2"), { recursive: true });
  await writeFile(join(run.runDir, "implementation/item-1/attempt-1.json"), "{\"work_item_id\":\"item-1\"}\n", "utf8");
  await writeFile(join(run.runDir, "verification/issue-1/attempt-2/evidence.json"), "{}\n", "utf8");
  return { run, repoRoot };
}

async function overwriteManifestForAuthorityTest(runDir: string, patch: Record<string, unknown>): Promise<void> {
  const path = join(runDir, "manifest.json");
  const manifest = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  await writeFile(path, `${JSON.stringify({ ...manifest, ...patch }, null, 2)}\n`, "utf8");
}

describe("runReflection", () => {
  it("does not invoke either reflection account without a valid terminal evidence index", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-reflection-index-gate-"));
    roots.push(repoRoot);
    const run = await createRunLedgerV2({
      repoRoot,
      originalRequest: "Reflect only from terminal evidence",
      intake: intake(repoRoot),
      roles: intake(repoRoot).roles,
    });
    await updateManifestV2(run.runDir, {
      workflow_protocol: "bounded-context-v1",
      assurance_outcome: "blocked",
      delivery_state: "blocked",
      last_blocker: "Final evidence is incomplete",
    });
    await recordTerminalDisposition(run.runDir, {
      outcome: "closed_blocked",
      actor: "human",
      reason: "Stop without terminal evidence",
      residual_risks: ["Final evidence is incomplete"],
    });
    const codex = new ReflectionCodex();
    const invoke = vi.spyOn(codex, "invoke");

    await expect(runReflection({ runDir: run.runDir, sourceRepo: repoRoot, codex })).rejects.toThrow(
      /evidence index|integrated verification|approved plan/i,
    );
    expect(invoke).toHaveBeenCalledTimes(0);
  });

  it("publishes a bounded terminal index before accounts and reuses it after a crash", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-reflection-bounded-valid-"));
    roots.push(repoRoot);
    const run = await createRunLedgerV2({
      repoRoot,
      originalRequest: "Reflect from bounded terminal evidence",
      sourceCommit: "a".repeat(40),
      intake: intake(repoRoot),
      roles: intake(repoRoot).roles,
    });
    const recorded = await recordPlan(run.runDir, `${JSON.stringify({ work_items: [] })}\n`);
    await approvePlanRevision(run.runDir, recorded.revision, { actor: "test" });
    const evidencePath = "verification/integrated/attempt-1/evidence.json";
    const reviewPath = "reviews/integrated/final-attempt-1.json";
    await writeImmutableValidatedJson(run.runDir, evidencePath, verificationEvidenceSchema, {
      verification_scope: "integrated",
      work_item_id: "integrated",
      attempt: 1,
      evidence_path: evidencePath,
      commands: [],
      artifacts: [],
      artifact_checks: [],
      browser_evidence: [],
      created_at: "2026-07-16T12:00:00.000Z",
    });
    await writeImmutableValidatedJson(run.runDir, reviewPath, persistedVerifierReviewSchema, {
      work_item_id: "integrated",
      attempt: 1,
      final: true,
      decision: "approve",
      failure_class: "none",
      blocker: null,
      blocker_code: null,
      acceptance_coverage: [],
      evidence_reviewed: [evidencePath],
      findings: [],
      residual_risks: [],
    });
    const assessmentPath = "assurance/final.json";
    await writeImmutableValidatedJson(run.runDir, assessmentPath, assuranceAssessmentSchema, {
      outcome: "verified_ready",
      assessed_at: "2026-07-16T12:00:00.000Z",
      approved_plan_revision: recorded.revision,
      approved_plan_sha256: recorded.sha256,
      candidate_commit: "b".repeat(40),
      blocker_code: null,
      blocker: null,
      missing_evidence: [],
      invalid_evidence: [],
      zero_attempt_work_items: [],
      acceptance_path: null,
    });
    const beforeTerminal = await readManifestV2(run.runDir);
    await updateManifestV2(run.runDir, {
      workflow_protocol: "bounded-context-v1",
      reflection_protocol: "role-accounts-v1",
      stage: "complete",
      delivery_state: "ready",
      assurance_outcome: "verified_ready",
      assurance_assessment_path: assessmentPath,
      work_item_progress: {
        ...beforeTerminal.work_item_progress,
        integrated: {
          status: "complete",
          attempts: 1,
          verification_path: evidencePath,
          review_path: reviewPath,
          commit_sha: "b".repeat(40),
        },
      },
      final_artifact_paths: [evidencePath, reviewPath],
    });
    await recordTerminalDisposition(run.runDir, {
      outcome: "delivered",
      actor: "runtime",
      reason: "Bounded delivery is ready",
      residual_risks: [],
    });
    const rawHistorySecret = "RAW_REFLECTION_HISTORY_SECRET";
    await mkdir(join(run.runDir, "prompts", "historical"), { recursive: true });
    await mkdir(join(run.runDir, "responses", "historical"), { recursive: true });
    await writeFile(join(run.runDir, "prompts", "historical", "old.md"), `${rawHistorySecret}_PROMPT\n`, "utf8");
    await writeFile(join(run.runDir, "responses", "historical", "old.json"), `${JSON.stringify({ raw_response: `${rawHistorySecret}_RESPONSE` })}\n`, "utf8");
    for (let index = 0; index < 25; index += 1) {
      await appendRunEvent(run.runDir, {
        actor: "engine",
        stage: "complete",
        type: "historical_test_event",
        payload: { raw_event: `${rawHistorySecret}_EVENT_${index}` },
      });
    }

    const raced = new ReflectionCodex();
    const contextConstructions = vi.spyOn(roleContextWorkflow, "buildReflectionContext");
    const racedInvoke = vi.spyOn(raced, "invoke").mockRejectedValue(new Error("model must not see raced authority"));
    let raceEmitted = false;
    const racingProgress: ProgressReporter = {
      path: join(run.runDir, "progress.jsonl"),
      sessionId: "reflection-authority-race",
      workerPid: process.pid,
      async emit() {
        if (!raceEmitted) {
          raceEmitted = true;
          await overwriteManifestForAuthorityTest(run.runDir, {
            reflection_index_path: "evidence-indexes/reflection/raced.json",
          });
        }
        return null;
      },
    };
    await expect(runReflection({ runDir: run.runDir, sourceRepo: repoRoot, codex: raced, progress: racingProgress }))
      .rejects.toThrow(/reflection index|canonical|authority|pointer/i);
    expect(racedInvoke).toHaveBeenCalledTimes(0);
    expect(contextConstructions).toHaveBeenCalledTimes(1);
    await expect(readFile(join(run.runDir, "prompts", "reflection-brain-account.md"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
    await overwriteManifestForAuthorityTest(run.runDir, {
      reflection_index_path: "evidence-indexes/reflection/final.json",
    });

    const interrupted = new InterruptAfterBrainAccount();
    await expect(runReflection({ runDir: run.runDir, sourceRepo: repoRoot, codex: interrupted }))
      .rejects.toThrow("simulated reflection interruption");
    const afterCrash = await readManifestV2(run.runDir);
    expect(afterCrash.reflection_index_path).toBe("evidence-indexes/reflection/final.json");
    expect(afterCrash.final_artifact_paths).toContain("evidence-indexes/reflection/final.json");
    expect(afterCrash.final_artifact_paths).toContain("contexts/reflection/final.json");
    expect(interrupted.calls.map((call) => call.artifactName)).toEqual(["reflection-brain-account"]);
    expect(contextConstructions).toHaveBeenCalledTimes(1);
    const contextJson = (await readFile(join(run.runDir, "contexts/reflection/final.json"), "utf8")).trim();
    expect(interrupted.calls[0]?.prompt).toContain(contextJson);
    expect(interrupted.calls[0]?.prompt).toContain('"phase": "reflection"');
    expect(interrupted.calls[0]?.prompt).toContain('"retry_counts"');
    expect(interrupted.calls[0]?.prompt).toContain('"work_item_attempts"');
    expect(interrupted.calls[0]?.prompt).toContain('"review_accounting"');
    expect(interrupted.calls[0]?.prompt).toContain('"finding_history"');
    expect(interrupted.calls[0]?.prompt).toContain('"budget_usage"');
    expect(interrupted.calls[0]?.prompt).toContain('"terminal_disposition"');
    expect(interrupted.calls[0]?.prompt).toContain('"delivery_identifiers"');
    expect(interrupted.calls[0]?.prompt).toContain('"path": "contexts/reflection/final.json"');
    const reflectionIndexBytes = await readFile(join(run.runDir, "evidence-indexes/reflection/final.json"));
    expect(interrupted.calls[0]?.prompt).toContain('"path": "evidence-indexes/reflection/final.json"');
    expect(interrupted.calls[0]?.prompt).toContain(createHash("sha256").update(reflectionIndexBytes).digest("hex"));
    expect(interrupted.calls[0]?.prompt).not.toContain(rawHistorySecret);

    const contextPath = join(run.runDir, "contexts/reflection/final.json");
    await writeFile(contextPath, contextJson.replace('"budget_usage": null', '"budget_usage": {"forged": true}') + "\n", "utf8");
    const contextCollision = new ReflectionCodex();
    await expect(runReflection({ runDir: run.runDir, sourceRepo: repoRoot, codex: contextCollision }))
      .rejects.toThrow(/immutable|different content|already exists|stale process metrics/i);
    expect(contextCollision.calls).toHaveLength(0);
    expect(contextConstructions).toHaveBeenCalledTimes(1);
    await writeFile(contextPath, `${contextJson}\n`, "utf8");

    const indexPath = join(run.runDir, "evidence-indexes/reflection/final.json");
    const indexJson = await readFile(indexPath, "utf8");
    await writeFile(
      indexPath,
      indexJson.replace(`"candidate_commit": "${"b".repeat(40)}"`, `"candidate_commit": "${"c".repeat(40)}"`),
      "utf8",
    );
    const staleIndex = new ReflectionCodex();
    await expect(runReflection({ runDir: run.runDir, sourceRepo: repoRoot, codex: staleIndex }))
      .rejects.toThrow(/immutable|different content|phase|authority|final_review_ref|unrecognized/i);
    expect(staleIndex.calls).toHaveLength(0);
    await writeFile(indexPath, indexJson, "utf8");

    const resumed = new ReflectionCodex();
    await runReflection({ runDir: run.runDir, sourceRepo: repoRoot, codex: resumed });

    expect(resumed.calls.map((call) => call.artifactName)).toEqual([
      "reflection-hands-account",
      "reflection-synthesis",
    ]);
    expect(resumed.calls.every((call) => call.prompt.includes(contextJson))).toBe(true);
    expect(resumed.calls.every((call) => !call.prompt.includes(rawHistorySecret))).toBe(true);
    expect(await readFile(contextPath, "utf8")).toBe(`${contextJson}\n`);
    expect(contextConstructions).toHaveBeenCalledTimes(1);
    const completed = await readManifestV2(run.runDir);
    expect(completed.reflection_index_path).toBe("evidence-indexes/reflection/final.json");
    expect(completed.final_artifact_paths).toEqual(expect.arrayContaining([
      "evidence-indexes/reflection/final.json",
      "contexts/reflection/final.json",
      "reflection.json",
      "reflection.md",
    ]));

    const completedManifest = await readManifestV2(run.runDir);
    const completedEvents = await readFile(join(run.runDir, "events.jsonl"), "utf8");
    const completedContext = await readFile(contextPath, "utf8");
    const completedIndex = await readFile(indexPath, "utf8");
    const completedReflectionJson = await readFile(join(run.runDir, "reflection.json"), "utf8");
    const completedReflectionMarkdown = await readFile(join(run.runDir, "reflection.md"), "utf8");
    const assertRecoveryRejectsWithoutMutation = async (pattern: RegExp): Promise<void> => {
      const recovery = new ReflectionCodex();
      await expect(runReflection({ runDir: run.runDir, sourceRepo: repoRoot, codex: recovery }))
        .rejects.toThrow(pattern);
      expect(recovery.calls).toHaveLength(0);
      expect(await readManifestV2(run.runDir)).toEqual(completedManifest);
      expect(await readFile(join(run.runDir, "events.jsonl"), "utf8")).toBe(completedEvents);
      expect(await readFile(join(run.runDir, "reflection.json"), "utf8")).toBe(completedReflectionJson);
      expect(await readFile(join(run.runDir, "reflection.md"), "utf8")).toBe(completedReflectionMarkdown);
    };

    await rm(indexPath);
    await assertRecoveryRejectsWithoutMutation(/reflection index|ENOENT|missing/i);
    await writeFile(indexPath, completedIndex);
    await writeFile(
      indexPath,
      completedIndex.replace(
        `"candidate_commit": "${"b".repeat(40)}"`,
        `"candidate_commit": "${"c".repeat(40)}"`,
      ),
    );
    await assertRecoveryRejectsWithoutMutation(/reflection index|candidate|stale|authority|immutable/i);
    await writeFile(indexPath, completedIndex);
    await rm(contextPath);
    await assertRecoveryRejectsWithoutMutation(/reflection context|ENOENT|missing/i);
    await writeFile(contextPath, completedContext);
    await writeFile(contextPath, completedContext.replace('"budget_usage": null', '"budget_usage": {"forged": true}'));
    await assertRecoveryRejectsWithoutMutation(/immutable|different content|authority|hash|stale process metrics/i);
    await writeFile(contextPath, completedContext);

    await overwriteManifestForAuthorityTest(run.runDir, {
      reflection_index_path: "evidence-indexes/reflection/mismatched.json",
    });
    const mismatchedManifest = await readManifestV2(run.runDir);
    const mismatchedEvents = await readFile(join(run.runDir, "events.jsonl"), "utf8");
    const mismatchRecovery = new ReflectionCodex();
    await expect(runReflection({ runDir: run.runDir, sourceRepo: repoRoot, codex: mismatchRecovery }))
      .rejects.toThrow(/reflection index|canonical|authority|pointer/i);
    expect(mismatchRecovery.calls).toHaveLength(0);
    expect(await readManifestV2(run.runDir)).toEqual(mismatchedManifest);
    expect(await readFile(join(run.runDir, "events.jsonl"), "utf8")).toBe(mismatchedEvents);
    expect(contextConstructions).toHaveBeenCalledTimes(1);
  });

  it("uses one medium-effort Brain call for new single-pass reflection runs", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-reflection-single-"));
    roots.push(repoRoot);
    const run = await createRunLedgerV2({
      repoRoot,
      originalRequest: "Reflect in one pass",
      sourceCommit: "a".repeat(40),
      intake: intake(repoRoot),
      roles: intake(repoRoot).roles,
    });
    const recorded = await recordPlan(run.runDir, `${JSON.stringify({ work_items: [] })}\n`);
    await approvePlanRevision(run.runDir, recorded.revision, { actor: "test" });
    const evidencePath = "verification/integrated/attempt-1/evidence.json";
    const reviewPath = "reviews/integrated/final-attempt-1.json";
    await writeImmutableValidatedJson(run.runDir, evidencePath, verificationEvidenceSchema, {
      verification_scope: "integrated",
      work_item_id: "integrated",
      attempt: 1,
      evidence_path: evidencePath,
      commands: [],
      artifacts: [],
      artifact_checks: [],
      browser_evidence: [],
      created_at: "2026-07-16T12:00:00.000Z",
    });
    await writeImmutableValidatedJson(run.runDir, reviewPath, persistedVerifierReviewSchema, {
      work_item_id: "integrated",
      attempt: 1,
      final: true,
      decision: "approve",
      failure_class: "none",
      blocker: null,
      blocker_code: null,
      acceptance_coverage: [],
      evidence_reviewed: [evidencePath],
      findings: [],
      residual_risks: [],
    });
    const beforeTerminal = await readManifestV2(run.runDir);
    await updateManifestV2(run.runDir, {
      stage: "complete",
      delivery_state: "ready",
      assurance_outcome: "verified_ready",
      work_item_progress: {
        ...beforeTerminal.work_item_progress,
        integrated: {
          status: "complete",
          attempts: 1,
          verification_path: evidencePath,
          review_path: reviewPath,
          commit_sha: "b".repeat(40),
        },
      },
      final_artifact_paths: [evidencePath, reviewPath],
    });
    await recordTerminalDisposition(run.runDir, {
      outcome: "delivered",
      actor: "runtime",
      reason: "Delivered",
      residual_risks: [],
    });

    const codex = new ReflectionCodex();
    await runReflection({ runDir: run.runDir, sourceRepo: repoRoot, codex });

    expect(codex.calls.map((call) => call.artifactName)).toEqual(["reflection-synthesis"]);
    expect(codex.calls[0]).toMatchObject({ role: "brain", sandbox: "read-only", reasoningEffort: "medium" });
    await expect(readFile(join(run.runDir, "prompts", "reflection-brain-account.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(run.runDir, "reflection.md"), "utf8")).not.toContain("## Process accounts");
    expect((await readManifestV2(run.runDir)).final_artifact_paths).toEqual([
      evidencePath,
      reviewPath,
      "reflection.json",
      "reflection.md",
      "responses/reflection-synthesis.json",
    ]);
  });

  it("fails closed before legacy history rendering when a legacy manifest contains bounded authority", async () => {
    const { run, repoRoot } = await completeLedger();
    const legacySecret = "LEGACY_RECOVERY_CONTEXT_SECRET";
    await writeFile(join(run.runDir, "responses", "legacy-history.json"), `${JSON.stringify({ legacySecret })}\n`, "utf8");
    await updateManifestV2(run.runDir, {
      reflection_index_path: "evidence-indexes/reflection/final.json",
    });
    const codex = new ReflectionCodex();

    await expect(runReflection({ runDir: run.runDir, sourceRepo: repoRoot, codex }))
      .rejects.toThrow(/legacy reflection|bounded|mixed|authority/i);

    expect(codex.calls).toHaveLength(0);
    await expect(readFile(join(run.runDir, "prompts", "reflection-brain-account.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(run.runDir, "contexts/reflection/final.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed on a terminal bounded-context artifact in a legacy run without recursively reading history", async () => {
    const { run, repoRoot } = await completeLedger();
    const mixedSecret = "LEGACY_CONTEXT_ONLY_MIXED_SECRET";
    await mkdir(join(run.runDir, "contexts", "reflection"), { recursive: true });
    await writeFile(join(run.runDir, "contexts", "reflection", "final.json"), `${JSON.stringify({ mixedSecret })}\n`, "utf8");
    await writeFile(join(run.runDir, "responses", "legacy-mixed-secret.json"), `${JSON.stringify({ mixedSecret })}\n`, "utf8");
    const codex = new ReflectionCodex();

    await expect(runReflection({ runDir: run.runDir, sourceRepo: repoRoot, codex }))
      .rejects.toThrow(/legacy reflection|bounded|mixed|authority/i);

    expect(codex.calls).toHaveLength(0);
    await expect(readFile(join(run.runDir, "prompts", "reflection-brain-account.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("runs only for a complete reflection-enabled ledger and keeps every account read-only", async () => {
    const { run, repoRoot } = await completeLedger();
    const codex = new ReflectionCodex();
    const progress = await openProgressReporter({ runDir: run.runDir });

    const result = await runReflection({ runDir: run.runDir, sourceRepo: repoRoot, codex, progress });

    expect(codex.calls).toHaveLength(3);
    expect(codex.calls.map((call) => call.role)).toEqual(["brain", "hands", "brain"]);
    expect(codex.calls.every((call) => call.sandbox === "read-only")).toBe(true);
    expect(codex.calls.every((call) => call.skipGitRepoCheck === true)).toBe(true);
    expect(codex.calls.every((call) => call.cwd !== repoRoot && call.cwd !== run.runDir)).toBe(true);
    expect(codex.calls.map((call) => call.model)).toEqual(["brain-model", "hands-model", "brain-model"]);
    expect(codex.calls.every((call) => call.progress !== undefined)).toBe(true);
    expect(codex.calls[0].prompt).toContain("planning/research quality");
    expect(codex.calls[1].prompt).toContain("implementation/verification quality");
    expect(codex.calls[0].prompt).toContain("Deliver the requested change");
    expect(codex.calls[0].prompt).toContain("verification/issue-1/attempt-2/evidence.json");
    expect(codex.calls[2].prompt).toContain("Brain's final process-reflection synthesizer");
    expect(codex.calls[2].prompt).toContain("what_was_correct");
    expect(codex.calls[2].prompt).toContain("improvements");
    for (const category of [
      "implementation_defects",
      "planning_defects",
      "verification_gaps",
      "environment_failures",
      "external_blockers",
      "unnecessary_cost_or_rework",
    ]) {
      expect(codex.calls[2].prompt).toContain(`\`${category}\``);
    }
    expect(codex.calls[2].prompt).not.toContain("process account. Review the completed run as a process");
    expect(result.reflection).toEqual(reflection);
    expect(await readFile(join(run.runDir, "reflection.json"), "utf8")).toContain("outcome_summary");
    expect(await readFile(join(run.runDir, "reflection.md"), "utf8")).toContain("unnecessary_cost_or_rework");
    expect(await readFile(join(run.runDir, "reflection.md"), "utf8")).toContain("Process reflection");
    expect(result.reflectionJsonPath).toBe(join(run.runDir, "reflection.json"));
    const manifest = await readManifestV2(run.runDir);
    expect(manifest.stage).toBe("complete");
    expect(manifest.final_artifact_paths).toEqual(expect.arrayContaining(["reflection.json", "reflection.md"]));
    const labels: string[] = [];
    for await (const event of readProgressEvents(run.runDir)) labels.push(event.safe_label);
    expect(labels).toEqual(["Reflection started", "Reflection recorded"]);
  });

  it("rejects an incomplete or reflection-disabled ledger", async () => {
    const disabled = await completeLedger(false);
    await expect(runReflection({ runDir: disabled.run.runDir, sourceRepo: disabled.repoRoot, codex: new ReflectionCodex() })).rejects.toThrow(
      "Reflection is not enabled",
    );

    const incompleteRoot = await mkdtemp(join(tmpdir(), "brain-hands-reflection-incomplete-"));
    roots.push(incompleteRoot);
    const run = await createRunLedgerV2({
      repoRoot: incompleteRoot,
      originalRequest: "Deliver the requested change",
      slug: "incomplete",
      intake: intake(incompleteRoot),
    });
    await expect(runReflection({ runDir: run.runDir, sourceRepo: incompleteRoot, codex: new ReflectionCodex() })).rejects.toThrow(
      "terminal ledger",
    );
  });

  it("reflects a terminal blocked outcome without converting it into successful delivery and reuses the result", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-reflection-blocked-"));
    roots.push(repoRoot);
    const run = await createRunLedgerV2({
      repoRoot,
      originalRequest: "Attempt the blocked delivery",
      intake: intake(repoRoot),
      roles: intake(repoRoot).roles,
    });
    await overwriteManifestForAuthorityTest(run.runDir, {
      workflow_protocol: "legacy-v2",
      reflection_protocol: undefined,
      discovery: null,
      stage: "verifier_review",
      delivery_state: "blocked",
      last_blocker: "External verification is unavailable",
    });
    await recordTerminalDisposition(run.runDir, {
      outcome: "closed_blocked",
      actor: "human",
      reason: "Stop after the external dependency remained unavailable",
      residual_risks: ["Delivery proof is incomplete"],
    });
    const codex = new ReflectionCodex();

    const first = await runReflection({ runDir: run.runDir, sourceRepo: repoRoot, codex });
    const repeated = await runReflection({ runDir: run.runDir, sourceRepo: repoRoot, codex });

    expect(codex.calls).toHaveLength(3);
    expect(codex.calls[0]?.prompt).toContain('"outcome": "closed_blocked"');
    expect(codex.calls[0]?.prompt).toContain("External verification is unavailable");
    expect(repeated.reflection).toEqual(first.reflection);
    const manifest = await readManifestV2(run.runDir);
    expect(manifest.stage).toBe("verifier_review");
    expect(manifest.delivery_state).toBe("blocked");
    const events = (await readFile(join(run.runDir, "events.jsonl"), "utf8"))
      .split("\n").filter(Boolean).map((line) => JSON.parse(line) as { type: string });
    expect(events.filter((event) => event.type === "reflection_completed")).toHaveLength(1);
  });

  it("validates a supplied resolved intake before invoking Codex", async () => {
    const { run, repoRoot } = await completeLedger();
    const codex = new ReflectionCodex();
    const invalid = { ...intake(repoRoot), mode: undefined } as unknown as ResolvedRunIntake;

    await expect(runReflection({ runDir: run.runDir, sourceRepo: repoRoot, intake: invalid, codex })).rejects.toThrow(
      "mode, research, and reflection must be resolved",
    );
    expect(codex.calls).toHaveLength(0);
  });

  it("repairs the durable completion record when reflection artifacts survived an interruption", async () => {
    const { run, repoRoot } = await completeLedger();
    await writeFile(join(run.runDir, "reflection.json"), `${JSON.stringify(reflection)}\n`, "utf8");
    await writeFile(join(run.runDir, "reflection.md"), "# Process reflection\n", "utf8");
    const codex = new ReflectionCodex();
    const progress = await openProgressReporter({ runDir: run.runDir });

    await runReflection({ runDir: run.runDir, sourceRepo: repoRoot, codex, progress });

    expect(codex.calls).toHaveLength(0);
    expect((await readManifestV2(run.runDir)).final_artifact_paths).toEqual(expect.arrayContaining(["reflection.json", "reflection.md"]));
    const events = (await readFile(join(run.runDir, "events.jsonl"), "utf8"))
      .split("\n").filter(Boolean).map((line) => JSON.parse(line) as { type: string });
    expect(events.filter((event) => event.type === "reflection_completed")).toHaveLength(1);
    const progressLabels: string[] = [];
    for await (const event of readProgressEvents(run.runDir)) progressLabels.push(event.safe_label);
    expect(progressLabels).toEqual(["Reflection recorded"]);
  });

  it("reuses completed account evidence after an interrupted reflection", async () => {
    const { run, repoRoot } = await completeLedger();
    const interrupted = new InterruptAfterBrainAccount();
    await expect(runReflection({ runDir: run.runDir, sourceRepo: repoRoot, codex: interrupted })).rejects.toThrow(
      "simulated reflection interruption",
    );
    expect(interrupted.calls.map((call) => call.artifactName)).toEqual(["reflection-brain-account"]);

    const resumed = new ReflectionCodex();
    await runReflection({ runDir: run.runDir, sourceRepo: repoRoot, codex: resumed });

    expect(resumed.calls.map((call) => call.artifactName)).toEqual([
      "reflection-hands-account",
      "reflection-synthesis",
    ]);
    expect(await readFile(join(run.runDir, "reflection.json"), "utf8")).toContain("outcome_summary");
  });

  it("accepts an engine-resolved policy revision without treating it as a run override", async () => {
    const { run, repoRoot } = await completeLedger();
    const codex = new ReflectionCodex();
    const resolved = {
      ...intake(repoRoot),
      review_policy: {
        policy_revision: 1,
        max_fix_cycles: 3,
        on_limit: "auto_replan",
        auto_advance_on_approval: true,
        severity_defaults: {
          critical: "blocking",
          high: "blocking",
          medium: "fix_in_scope",
          low: "advisory",
        },
        pause_on: ["plan_approval"],
      },
    } as ResolvedRunIntake;

    await runReflection({ runDir: run.runDir, sourceRepo: repoRoot, intake: resolved, codex });

    expect(codex.calls).toHaveLength(3);
  });
});

describe("planFromReflection", () => {
  it("invokes only Brain read-only and writes a standalone improvement plan", async () => {
    const { repoRoot } = await completeLedger();
    const reflectionPath = join(repoRoot, "reflection-input.json");
    await writeFile(reflectionPath, `${JSON.stringify(reflection, null, 2)}\n`, "utf8");
    await mkdir(join(repoRoot, ".git"), { recursive: true });
    await writeFile(join(repoRoot, ".git", "private-note.txt"), "TOP_SECRET_GIT_ONLY\n", "utf8");
    await writeFile(join(repoRoot, "source-note.ts"), "export const sourceSnapshot = true;\n", "utf8");
    const before = await readFile(join(repoRoot, "process-note.md"), "utf8");
    const codex = new ImprovementPlanner();

    const result = await planFromReflection({
      reflectionPath,
      sourceRepo: repoRoot,
      codex,
      brainModel: "brain-model",
      reasoningEffort: "high",
    });

    expect(codex.calls).toHaveLength(1);
    expect(codex.calls[0]).toMatchObject({ role: "brain", model: "brain-model", sandbox: "read-only", cwd: repoRoot });
    expect(codex.calls.every((call) => call.role !== "hands")).toBe(true);
    expect(codex.calls[0].prompt).toContain("source-note.ts");
    expect(codex.calls[0].prompt).not.toContain("TOP_SECRET_GIT_ONLY");
    expect(result.message).toContain("separate task");
    expect(result.jsonPath).toContain(join(repoRoot, ".brain-hands", "improvement-plans"));
    expect(await readFile(result.jsonPath, "utf8")).toContain("recommended_changes");
    expect(await readFile(result.markdownPath, "utf8")).toContain("Improvement plan");
    expect(await readFile(join(repoRoot, "process-note.md"), "utf8")).toBe(before);
  });

  it("accepts the Markdown reflection artifact and rejects malformed input", async () => {
    const { repoRoot } = await completeLedger();
    const markdownPath = join(repoRoot, "reflection.md");
    await writeFile(markdownPath, `# Process reflection\n\n\`\`\`json\n${JSON.stringify(reflection)}\n\`\`\`\n`, "utf8");
    const codex = new ImprovementPlanner();
    await expect(planFromReflection({ reflectionPath: markdownPath, sourceRepo: repoRoot, codex })).resolves.toMatchObject({ plan: improvementPlan });

    const malformedPath = join(repoRoot, "bad-reflection.md");
    await writeFile(malformedPath, "not a reflection\n", "utf8");
    await expect(planFromReflection({ reflectionPath: malformedPath, sourceRepo: repoRoot, codex })).rejects.toThrow(
      "valid Reflection",
    );
  });
});
