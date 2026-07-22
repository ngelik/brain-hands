import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_HANDS_PROMPT_BYTES, type CodexAdapter, type CodexInvokeInput } from "../../src/adapters/codex.js";
import type { ResourceBudgetPort } from "../../src/core/resource-budget.js";
import { approvePlanRevision, createRunLedgerV2, recordPlan, updateManifestV2 } from "../../src/core/ledger.js";
import { artifactRefFromBytes, canonicalJsonBytes, handsContextV1Schema } from "../../src/core/context-contracts.js";
import type { ImplementationResult, ResolvedRunIntake, WorkItem } from "../../src/core/types.js";
import { ImplementationResultMismatchError, runHandsWorkItem } from "../../src/workflow/worker.js";
import { buildHandsContext, loadRoleContext, type HandsAttemptKind } from "../../src/workflow/role-context.js";
import { executionSpec } from "../fixtures/execution-spec.js";
import { openProgressReporter, readProgressEvents } from "../../src/progress/log.js";
const codexMetrics = { usage: null, durationMs: 0, processStarted: false, turnStarted: false, structuredTerminalError: false } as const;

const item: WorkItem = executionSpec("item-1");

const intake: ResolvedRunIntake = {
  task: "Implement one item",
  repo_root: "/tmp/repo",
  mode: "local",
  research: false,
  reflection: false,
  models: { brain: "brain", hands: "hands", verifier: "verifier" },
  resolved_models: { brain: "brain", hands: "hands", verifier: "verifier" },
  roles: {
    brain: { model: "brain", reasoning_effort: "high", sandbox: "read-only" },
    hands: { model: "hands", reasoning_effort: "medium", sandbox: "workspace-write" },
    verifier: { model: "verifier", reasoning_effort: "high", sandbox: "read-only" },
  },
};

const implementation: ImplementationResult = {
  work_item_id: "item-1",
  changed_files: ["src/example.ts"],
  tests_added_or_changed: ["tests/example.test.ts"],
  commands_attempted: [["npm", "test"]],
  completed_steps: ["Implemented the item"],
  remaining_risks: [],
};

function recordingBudget(): ResourceBudgetPort {
  return {
    usage: async () => ({
      model_invocations: 0,
      workflow_attempts: 0,
      total_tokens: 0,
      cached_input_tokens: 0,
      reasoning_output_tokens: 0,
      active_elapsed_ms: 0,
      external_effects: 0,
      token_accounting: "known",
      uncertain_model_claim_ids: [],
      token_overshoot: 0,
    }),
    claim: async () => { throw new Error("workflow tests should only pass the budget port through"); },
    complete: async () => { throw new Error("workflow tests should only pass the budget port through"); },
    runWorkflowAttempt: async (_key, action) => action(),
    remainingActiveElapsedMs: async () => 1_000,
  };
}

class RecordingHands implements CodexAdapter {
  calls: CodexInvokeInput[] = [];
  async invoke(input: CodexInvokeInput) {
    this.calls.push(input);
    return {
      text: JSON.stringify(implementation),
      parsed: implementation,
      exitCode: 0,
      promptPath: join(input.runDir, "prompts", `${input.artifactName}.md`),
      stdoutPath: join(input.runDir, "responses", `${input.artifactName}.stdout.txt`),
      stderrPath: join(input.runDir, "responses", `${input.artifactName}.stderr.txt`),
      ...codexMetrics,
    };
  }
}

let root: string | undefined;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

async function boundedLedger(repoRoot: string, workItem: WorkItem) {
  const ledger = await createRunLedgerV2({ repoRoot, originalRequest: intake.task });
  await updateManifestV2(ledger.runDir, { workflow_protocol: "bounded-context-v1" });
  const recorded = await recordPlan(ledger.runDir, JSON.stringify({
    summary: "Bounded worker plan",
    assumptions: [], research: [], research_sources: ["repo"], architecture: "local", risks: [],
    work_items: [workItem], integration_verification: [],
  }));
  await approvePlanRevision(ledger.runDir, recorded.revision);
  return { ledger, recorded };
}

async function persistedContext(
  runDir: string,
  revision: number,
  workItem: WorkItem,
  attempt: number,
  attemptKind: HandsAttemptKind,
  diff = "diff",
) {
  const contextRef = await buildHandsContext({
    runDir, workItemId: workItem.id, planRevision: revision, attempt, attemptKind, workItem, diff,
  });
  return { contextRef, context: await loadRoleContext(runDir, contextRef, "hands") };
}

describe("runHandsWorkItem", () => {
  it("suffixes Hands invocation evidence when an interrupted turn already owns the base response", async () => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-worker-resume-evidence-"));
    const ledger = await createRunLedgerV2({ repoRoot: root, originalRequest: intake.task });
    await writeFile(
      join(ledger.runDir, "responses/hands-work-item-item-1-attempt-1.json"),
      `${JSON.stringify(implementation, null, 2)}\n`,
      "utf8",
    );
    const codex = new RecordingHands();

    await runHandsWorkItem({
      runDir: ledger.runDir,
      worktreePath: join(root, "worktree"),
      workItem: item,
      intake: { ...intake, repo_root: root },
      codex,
    });

    expect(codex.calls[0]!.artifactName).toBe("hands-work-item-item-1-attempt-1-resume-2");
    await expect(readFile(
      join(ledger.runDir, "prompts/hands-work-item-item-1-attempt-1-resume-2.md"),
      "utf8",
    )).resolves.toContain('"id": "item-1"');
  });

  it("passes only the approved item to Hands in the isolated worktree", async () => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-worker-"));
    const ledger = await createRunLedgerV2({ repoRoot: root, originalRequest: intake.task });
    const codex = new RecordingHands();
    const progress = await openProgressReporter({ runDir: ledger.runDir });
    const result = await runHandsWorkItem({
      runDir: ledger.runDir,
      worktreePath: join(root, "worktree"),
      workItem: item,
      intake: { ...intake, repo_root: root },
      codex,
      progress,
      workItemIndex: 1,
      workItemTotal: 1,
    });

    expect(result.implementation).toEqual(implementation);
    expect(codex.calls[0]).toMatchObject({
      role: "hands",
      sandbox: "workspace-write",
      cwd: join(root, "worktree"),
      outputSchema: expect.anything(),
      progress: expect.anything(),
    });
    const prompt = await readFile(join(ledger.runDir, "prompts/hands-work-item-item-1-attempt-1.md"), "utf8");
    expect(prompt).toContain('"id": "item-1"');
    expect(prompt).toContain('"schema_version": "2.0"');
    expect(prompt).toContain('"completion_contract"');
    expect(prompt).toContain(JSON.stringify(item, null, 2));
    expect(prompt).toContain("Run approved verification commands in listed order");
    expect(prompt).toContain("Stop after the first failed or timed-out command");
    expect(prompt).toContain("Caller and fixture paths are compatibility evidence, not edit authorization");
    expect(prompt).toContain("Verifier findings to fix");
    expect(await readFile(result.reportPath, "utf8")).toContain("known_limitations");
    const events = []; for await (const event of readProgressEvents(ledger.runDir)) events.push(event);
    expect(events.at(-1)?.safe_label).toBe("Implementation attempt 1 recorded");
  });

  it("renders one validated bounded context without leaking broad worker inputs or run artifacts", async () => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-worker-bounded-"));
    const boundedItem = { ...item, objective: "CANONICAL_WORK_ITEM_SENTINEL" };
    const { ledger, recorded } = await boundedLedger(root, boundedItem);
    const budget = recordingBudget();
    const { contextRef, context } = await persistedContext(
      ledger.runDir, recorded.revision, boundedItem, 2, "primary_fix", "COMPLETE_SCOPED_DIFF_SENTINEL",
    );
    await writeFile(join(ledger.runDir, "events.jsonl"), "UNRELATED_EVENT_SENTINEL\n", "utf8");
    await writeFile(join(ledger.runDir, "responses/unrelated.stdout.txt"), "RAW_STDOUT_SENTINEL\n", "utf8");
    await writeFile(join(ledger.runDir, "prompts/unrelated.md"), "UNRELATED_PROMPT_SENTINEL\n", "utf8");
    const codex = new RecordingHands();

    await runHandsWorkItem({
      runDir: ledger.runDir,
      worktreePath: join(root, "worktree"),
      workItem: boundedItem,
      intake: { ...intake, repo_root: root },
      codex,
      attempt: 2,
      attemptKind: "primary_fix",
      findings: [{ severity: "medium", file: "src/legacy.ts", line: null, acceptance_criterion: "LEGACY_FINDING_SENTINEL", problem: "legacy", required_fix: "legacy", re_verification: [] }],
      diagnosticContext: "BROAD_DIAGNOSTIC_SENTINEL",
      contextRef,
      context,
      budget,
    } as Parameters<typeof runHandsWorkItem>[0]);

    expect(codex.calls[0]?.budget).toBe(budget);
    expect(codex.calls[0]?.attemptKey).toBe(`hands:${recorded.revision}:item-1:2:primary_fix`);
    const prompt = codex.calls[0]!.prompt;
    expect(prompt).toContain("# Hands: implement one approved work item");
    expect(prompt).toContain(contextRef.path);
    expect(prompt).toContain(contextRef.sha256);
    expect(prompt).toContain("CANONICAL_WORK_ITEM_SENTINEL");
    expect(prompt).toContain("COMPLETE_SCOPED_DIFF_SENTINEL");
    for (const leaked of [
      "LEGACY_FINDING_SENTINEL",
      "BROAD_DIAGNOSTIC_SENTINEL",
      "UNRELATED_EVENT_SENTINEL",
      "RAW_STDOUT_SENTINEL",
      "UNRELATED_PROMPT_SENTINEL",
      ledger.runDir,
    ]) expect(prompt).not.toContain(leaked);
  });

  it.each(["normal", "recovery"] as const)(
    "rejects an oversized %s Hands prompt before budget, Codex, or invocation artifacts",
    async (route) => {
      root = await mkdtemp(join(tmpdir(), `brain-hands-worker-oversized-${route}-`));
      const ledger = await createRunLedgerV2({ repoRoot: root, originalRequest: intake.task });
      const codex = new RecordingHands();
      let budgetClaims = 0;
      const budget: ResourceBudgetPort = {
        ...recordingBudget(),
        claim: async () => { budgetClaims += 1; throw new Error("must not claim budget"); },
      };
      const recovery = route === "recovery";
      const attempt = recovery ? 2 : 1;
      const artifactName = recovery
        ? "hands-work-item-item-1-attempt-2-quality_recovery-primary"
        : "hands-work-item-item-1-attempt-1";

      await expect(runHandsWorkItem({
        runDir: ledger.runDir,
        worktreePath: join(root, "worktree"),
        workItem: recovery ? item : { ...item, objective: "x".repeat(MAX_HANDS_PROMPT_BYTES) },
        intake: { ...intake, repo_root: root },
        codex,
        budget,
        ...(recovery ? {
          attempt,
          attemptKind: "quality_recovery" as const,
          diagnosticContext: "x".repeat(MAX_HANDS_PROMPT_BYTES),
        } : {}),
      })).rejects.toThrow(
        `${recovery ? "Hands recovery prompt" : "Hands work-item prompt"} exceeds ${MAX_HANDS_PROMPT_BYTES} bytes`,
      );

      expect(codex.calls).toHaveLength(0);
      expect(budgetClaims).toBe(0);
      for (const relativePath of [
        `prompts/${artifactName}.md`,
        `schemas/${artifactName}.json`,
        `responses/${artifactName}.json`,
        `responses/${artifactName}.stdout.txt`,
        `responses/${artifactName}.stderr.txt`,
        `implementation/item-1/attempt-${attempt}.json`,
      ]) {
        await expect(readFile(join(ledger.runDir, relativePath), "utf8"))
          .rejects.toMatchObject({ code: "ENOENT" });
      }
    },
  );

  it.each([
    ["wrong work-item path", "contexts/hands/aXRlbS0y/plan-1/attempt-2/primary_fix.json"],
    ["wrong attempt", "contexts/hands/aXRlbS0x/plan-1/attempt-3/primary_fix.json"],
    ["wrong attempt kind", "contexts/hands/aXRlbS0x/plan-1/attempt-2/quality_recovery.json"],
    ["noncanonical base64 identity", "contexts/hands/aXRl.bS0x/plan-1/attempt-2/primary_fix.json"],
    ["arbitrary context path", "contexts/hands/aXRlbS0x/plan-1/attempt-2/arbitrary.json"],
  ])("rejects bounded context coordinates with a %s", async (_label, path) => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-worker-coordinates-"));
    const { ledger, recorded } = await boundedLedger(root, item);
    const persisted = await persistedContext(ledger.runDir, recorded.revision, item, 2, "primary_fix");
    const context = persisted.context;
    const effectivePath = path.replace("plan-1", `plan-${recorded.revision}`);
    const contextRef = artifactRefFromBytes(effectivePath, canonicalJsonBytes(handsContextV1Schema, context));
    const codex = new RecordingHands();
    await expect(runHandsWorkItem({
      runDir: ledger.runDir, worktreePath: root, workItem: item,
      intake: { ...intake, repo_root: root }, codex, attempt: 2, attemptKind: "primary_fix",
      contextRef, context,
    })).rejects.toThrow(/context|path|attempt|work.item|identity/i);
    expect(codex.calls).toHaveLength(0);
  });

  it.each(["missing immutable artifact", "caller-forged context and self-hash"])(
    "rejects bounded dispatch with %s",
    async (scenario) => {
      root = await mkdtemp(join(tmpdir(), "brain-hands-worker-artifact-authority-"));
      const { ledger, recorded } = await boundedLedger(root, item);
      const persisted = await persistedContext(ledger.runDir, recorded.revision, item, 2, "primary_fix", "authoritative");
      const context = scenario === "missing immutable artifact"
        ? persisted.context
        : handsContextV1Schema.parse({ ...persisted.context, diff: "caller forged" });
      const contextRef = scenario === "missing immutable artifact"
        ? artifactRefFromBytes(
            `contexts/hands/aXRlbS0x/plan-${recorded.revision}/attempt-3/primary_fix.json`,
            canonicalJsonBytes(handsContextV1Schema, context),
          )
        : artifactRefFromBytes(
            persisted.contextRef.path,
            canonicalJsonBytes(handsContextV1Schema, context),
          );
      const codex = new RecordingHands();
      await expect(runHandsWorkItem({
        runDir: ledger.runDir, worktreePath: root, workItem: item,
        intake: { ...intake, repo_root: root }, codex,
        attempt: scenario === "missing immutable artifact" ? 3 : 2, attemptKind: "primary_fix",
        contextPlanRevision: recorded.revision, contextRef, context,
      })).rejects.toThrow(/context|artifact|missing|ENOENT|hash/i);
      expect(codex.calls).toHaveLength(0);
      const attempted = scenario === "missing immutable artifact" ? 3 : 2;
      await expect(readFile(join(ledger.runDir, `prompts/hands-work-item-item-1-attempt-${attempted}.md`), "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("rejects a structured result for a different work item before recording it", async () => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-worker-mismatch-"));
    const ledger = await createRunLedgerV2({ repoRoot: root, originalRequest: intake.task });
    const codex: CodexAdapter = {
      invoke: async (input) => ({
        text: JSON.stringify({ ...implementation, work_item_id: "item-2" }),
        parsed: { ...implementation, work_item_id: "item-2" },
        exitCode: 0,
        promptPath: join(input.runDir, "prompts", `${input.artifactName}.md`),
        stdoutPath: join(input.runDir, "responses", `${input.artifactName}.stdout.txt`),
        stderrPath: join(input.runDir, "responses", `${input.artifactName}.stderr.txt`),
        ...codexMetrics,
      }),
    };

    await expect(runHandsWorkItem({
      runDir: ledger.runDir,
      worktreePath: join(root, "worktree"),
      workItem: item,
      intake: { ...intake, repo_root: root },
      codex,
    })).rejects.toBeInstanceOf(ImplementationResultMismatchError);
    await expect(readFile(join(ledger.runDir, "implementation/item-1/attempt-1.json"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });
});
