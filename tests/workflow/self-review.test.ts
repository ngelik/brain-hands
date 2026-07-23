import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_HANDS_PROMPT_BYTES,
  type CodexAdapter,
  type CodexInvokeInput,
} from "../../src/adapters/codex.js";
import { createRunLedgerV2 } from "../../src/core/ledger.js";
import type { ResourceBudgetPort } from "../../src/core/resource-budget.js";
import type {
  HandsSelfReviewReport,
  ImplementationResult,
  ResolvedRunIntake,
  ReviewerAction,
  VerificationEvidence,
  WorkItem,
} from "../../src/core/types.js";
import { runHandsSelfReview } from "../../src/workflow/self-review.js";
import { executionSpec } from "../fixtures/execution-spec.js";
const codexMetrics = { usage: null, durationMs: 0, processStarted: false, turnStarted: false, structuredTerminalError: false } as const;

const workItem: WorkItem = executionSpec("item-1");

const intake: ResolvedRunIntake = {
  task: "Implement one item",
  repo_root: "/tmp/repo",
  mode: "local",
  research: false,
  reflection: false,
  models: { brain: "brain", hands: "active-hands-model", verifier: "verifier" },
  resolved_models: { brain: "brain", hands: "active-hands-model", verifier: "verifier" },
  roles: {
    brain: { model: "brain", reasoning_effort: "high", sandbox: "read-only" },
    hands: { model: "active-hands-model", reasoning_effort: "medium", sandbox: "workspace-write" },
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

const verification: VerificationEvidence = {
  verification_scope: "local",
  work_item_id: "item-1",
  attempt: 1,
  evidence_path: "verification/local/aXRlbS0x/attempt-1/evidence.json",
  commands: [],
  artifacts: [],
  artifact_checks: [],
  browser_evidence: [],
  created_at: "2026-07-11T00:00:00.000Z",
};

const action: ReviewerAction = {
  action_id: "R2-A1",
  order: 1,
  depends_on: [],
  severity: "medium",
  file: "src/example.ts",
  line: 10,
  acceptance_criterion: "The change works",
  problem: "The example is incomplete",
  required_fix: "Complete the example",
  re_verification: [["npm", "test"]],
};

const validReport: HandsSelfReviewReport = {
  work_item_id: "item-1",
  parent_attempt: 2,
  mutation_kind: "normal_fix",
  pass: 1,
  active_action_id: "R2-A1",
  findings: ["The example needed a guard"],
  fixes_applied: ["Added the guard"],
  changed_files: ["src/example.ts"],
  commands_attempted: [["npm", "test"]],
  remaining_findings: [],
  ready_for_resolution_check: true,
};

function recordingBudget(): ResourceBudgetPort & {
  claims: Parameters<ResourceBudgetPort["claim"]>[0][];
  completions: Parameters<ResourceBudgetPort["complete"]>[0][];
} {
  const claims: Parameters<ResourceBudgetPort["claim"]>[0][] = [];
  const completions: Parameters<ResourceBudgetPort["complete"]>[0][] = [];
  return {
    claims,
    completions,
    usage: async () => { throw new Error("oversized prompt must fail before budget usage"); },
    claim: async (input) => {
      claims.push(input);
      throw new Error("oversized prompt must fail before budget claim");
    },
    complete: async (input) => {
      completions.push(input);
      throw new Error("oversized prompt must fail before budget completion");
    },
    runWorkflowAttempt: async (_key, action) => action(),
    remainingActiveElapsedMs: async () => 1_000,
  };
}

class RecordingHands implements CodexAdapter {
  readonly calls: CodexInvokeInput[] = [];

  constructor(
    private readonly report: HandsSelfReviewReport = validReport,
    private readonly exitCode = 0,
  ) {}

  async invoke(input: CodexInvokeInput) {
    this.calls.push(input);
    return {
      text: JSON.stringify(this.report),
      parsed: this.report,
      exitCode: this.exitCode,
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

async function invoke(report: HandsSelfReviewReport = validReport) {
  root = await mkdtemp(join(tmpdir(), "brain-hands-self-review-"));
  const ledger = await createRunLedgerV2({ repoRoot: root, originalRequest: intake.task });
  const codex = new RecordingHands(report);
  const result = await runHandsSelfReview({
    runDir: ledger.runDir,
    worktreePath: join(root, "worktree"),
    workItem,
    intake: { ...intake, repo_root: root },
    codex,
    parentAttempt: 2,
    mutationKind: "normal_fix" as const,
    pass: 1,
    implementation,
    currentDiff: "diff --git a/src/example.ts b/src/example.ts",
    verification,
    activeAction: action,
    completedActions: [],
    priorPassReports: [],
  });
  return { codex, ledger, result };
}

describe("runHandsSelfReview", () => {
  it("invokes the active Hands profile for one scoped self-review pass", async () => {
    const { codex, result } = await invoke();

    expect(codex.calls[0]).toMatchObject({
      role: "hands",
      model: "active-hands-model",
      sandbox: "workspace-write",
    });
    expect(codex.calls[0].prompt).toContain("R2-A1");
    expect(codex.calls[0].prompt).toContain("preserve completed actions");
    expect(codex.calls[0].prompt).toContain(
      "fixes are limited exclusively to that action, regressions caused by the current mutation, and preservation of completed actions",
    );
    expect(codex.calls[0].prompt).not.toContain("you may fix other defects");
    expect(result.report.pass).toBe(1);
    expect(result.reportPath).toBe("self-review/item-1/attempt-2/pass-1.json");
  });

  it("bounds large self-review context while preserving current intent and action authority", async () => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-self-review-bounded-diff-"));
    const ledger = await createRunLedgerV2({ repoRoot: root, originalRequest: intake.task });
    const codex = new RecordingHands();
    const largeWorkItem: WorkItem = {
      ...workItem,
      objective: [
        "BASE-INTENT: preserve the original migration boundary.",
        "中😀".repeat(50_000),
        "LATEST-INTENT: preserve the final rollout boundary.",
      ].join("\n"),
    };
    const binaryPayload = "A".repeat(1_200_000);
    const textPayload = `+${"x".repeat(700_000)}`;
    const binarySection = [
      "diff --git a/public/planet.webp b/public/planet.webp",
      "new file mode 100644",
      "GIT binary patch",
      "literal 1200000",
      binaryPayload,
      "",
    ].join("\n");
    const textSection = [
      "diff --git a/src/example.ts b/src/example.ts",
      "--- a/src/example.ts",
      "+++ b/src/example.ts",
      "@@ -0,0 +1 @@",
      textPayload,
    ].join("\n");
    const currentDiff = `${binarySection}${textSection}`;
    const completedRequiredFix = `COMPLETED-REQUIRED-FIX:${"r".repeat(80_000)}`;
    const completedActions: ReviewerAction[] = [1, 2].map((order) => ({
      ...action,
      action_id: `R2-A${order + 1}`,
      order: order + 1,
      depends_on: order === 1 ? [] : ["R2-A2"],
      file: `src/completed-${order}.ts`,
      acceptance_criterion: `Completed criterion ${order}`,
      required_fix: completedRequiredFix,
    }));

    await runHandsSelfReview({
      runDir: ledger.runDir,
      worktreePath: join(root, "worktree"),
      workItem: largeWorkItem,
      intake: { ...intake, repo_root: root },
      codex,
      parentAttempt: 2,
      mutationKind: "normal_fix",
      pass: 1,
      implementation,
      currentDiff,
      verification,
      activeAction: action,
      completedActions,
      priorPassReports: [],
    });

    const prompt = codex.calls[0]!.prompt;
    const activeActionJson = prompt
      .split("Active Reviewer action (null means the approved work-item scope is active):\n")[1]!
      .split("\n\nCompleted Reviewer actions:")[0]!;
    const completedActionsJson = prompt
      .split("Completed Reviewer actions:\n")[1]!
      .split("\n\nPrior self-review pass reports:")[0]!;
    expect(Buffer.byteLength(prompt, "utf8")).toBeLessThanOrEqual(MAX_HANDS_PROMPT_BYTES);
    expect(prompt).toContain("BASE-INTENT: preserve the original migration boundary.");
    expect(prompt).toContain("LATEST-INTENT: preserve the final rollout boundary.");
    expect(prompt).toContain("Source patch section summarized for bounded Hands context.");
    expect(prompt).toContain("public/planet.webp");
    expect(prompt).toContain("src/example.ts");
    expect(prompt).toContain(`Git patch section bytes (not file content bytes): ${Buffer.byteLength(binarySection, "utf8")}`);
    expect(prompt).toContain(`Git patch section sha256 (not file content sha256): ${createHash("sha256").update(binarySection).digest("hex")}`);
    expect(prompt).not.toContain(binaryPayload);
    expect(JSON.parse(activeActionJson)).toEqual(action);
    expect(JSON.parse(completedActionsJson)).toEqual(completedActions.map((completed) => ({
      action_id: completed.action_id,
      order: completed.order,
      depends_on: completed.depends_on,
      file: completed.file,
      acceptance_criterion: completed.acceptance_criterion,
    })));
    expect(prompt).not.toContain(completedRequiredFix);
  });

  it("preserves test, command, and mixed acceptance authority in the compact self-review prompt", async () => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-self-review-acceptance-authority-"));
    const ledger = await createRunLedgerV2({ repoRoot: root, originalRequest: intake.task });
    const codex = new RecordingHands();
    const changeUnits = Array.from({ length: 180 }, (_, index) => ({
      ...workItem.change_units[0]!,
      id: `item-1-CH-${String(index + 1).padStart(3, "0")}`,
      target: `approved target ${index + 1}`,
    }));
    const testId = workItem.tests[0]!.id;
    const commandId = workItem.verification_commands[0]!.id;
    const acceptance = [
      { id: "item-1-AC-test", statement: "Test-only authority remains executable.", satisfied_by: [testId] },
      { id: "item-1-AC-command", statement: "Command-only authority remains executable.", satisfied_by: [commandId] },
      {
        id: "item-1-AC-mixed",
        statement: "Mixed authority remains executable.",
        satisfied_by: [testId, changeUnits[1]!.id, commandId, changeUnits[0]!.id],
      },
    ];

    await runHandsSelfReview({
      runDir: ledger.runDir,
      worktreePath: join(root, "worktree"),
      workItem: {
        ...workItem,
        change_units: changeUnits,
        acceptance,
        completion_contract: {
          ...workItem.completion_contract,
          required_acceptance_ids: acceptance.map(({ id }) => id),
        },
      },
      intake: { ...intake, repo_root: root },
      codex,
      parentAttempt: 2,
      mutationKind: "normal_fix",
      pass: 1,
      implementation,
      currentDiff: "diff --git a/src/example.ts b/src/example.ts",
      verification,
      activeAction: action,
      completedActions: [],
      priorPassReports: [],
    });

    const promptWorkItem = JSON.parse(codex.calls[0]!.prompt
      .split("Work item:\n")[1]!
      .split("\n\nParent mutation result:")[0]!) as WorkItem;
    expect(promptWorkItem.acceptance.map((criterion) => criterion.satisfied_by)).toEqual([
      [testId],
      [commandId],
      [testId, "compact-approved-change-units", commandId],
    ]);
  });

  it("derives bounded self-review diff identities from the full raw diff", async () => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-self-review-raw-diff-identity-"));
    const ledger = await createRunLedgerV2({ repoRoot: root, originalRequest: intake.task });
    const binaryPayload = "SMALL-BINARY-PAYLOAD-MUST-NOT-REACH-HANDS";
    const commonHead = `+${"h".repeat(300_000)}`;
    const commonTail = `+${"t".repeat(300_000)}`;
    const binarySection = [
      "diff --git a/public/planet.webp b/public/planet.webp",
      "new file mode 100644",
      "GIT binary patch",
      "literal 42",
      binaryPayload,
      "",
    ].join("\n");
    const textSection = (middle: string) => [
      "diff --git a/src/example.ts b/src/example.ts",
      "--- a/src/example.ts",
      "+++ b/src/example.ts",
      "@@ -0,0 +1 @@",
      commonHead,
      middle,
      commonTail,
      "",
    ].join("\n");
    const rawDiff = (middle: string) => `${binarySection}${textSection(middle)}`;
    const middleA = `+${"a".repeat(180_000)}`;
    const middleB = `+${"b".repeat(180_000)}`;
    const prompts: string[] = [];

    for (const [index, middle] of [middleA, middleB].entries()) {
      const report = { ...validReport, pass: index + 1 };
      const codex = new RecordingHands(report);
      await runHandsSelfReview({
        runDir: ledger.runDir,
        worktreePath: join(root, "worktree"),
        workItem,
        intake: { ...intake, repo_root: root },
        codex,
        parentAttempt: 2,
        mutationKind: "normal_fix",
        pass: index + 1,
        implementation,
        currentDiff: rawDiff(middle),
        verification,
        activeAction: action,
        completedActions: [],
        priorPassReports: [],
      });
      prompts.push(codex.calls[0]!.prompt);
    }

    const renderedDiffs = prompts.map((prompt) => prompt
      .split("Current diff:\n")[1]!
      .split("\n\nCurrent deterministic verification evidence:")[0]!);
    expect(renderedDiffs[0]).not.toBe(renderedDiffs[1]);
    expect(prompts.every((prompt) => Buffer.byteLength(prompt, "utf8") <= MAX_HANDS_PROMPT_BYTES)).toBe(true);
    expect(prompts.every((prompt) => !prompt.includes(binaryPayload))).toBe(true);
    expect(prompts.every((prompt) => prompt.includes(createHash("sha256").update(binarySection).digest("hex")))).toBe(true);
    expect(prompts[0]).toContain(createHash("sha256").update(textSection(middleA)).digest("hex"));
    expect(prompts[1]).toContain(createHash("sha256").update(textSection(middleB)).digest("hex"));
  });

  it("rejects a residual oversized prompt before claim, Codex, or artifact writes", async () => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-self-review-oversized-prompt-"));
    const ledger = await createRunLedgerV2({ repoRoot: root, originalRequest: intake.task });
    const codex = new RecordingHands();
    const budget = recordingBudget();
    const artifactName = "hands-self-review-item-1-attempt-2-pass-1";

    await expect(runHandsSelfReview({
      runDir: ledger.runDir,
      worktreePath: join(root, "worktree"),
      workItem,
      intake: { ...intake, repo_root: root },
      codex,
      parentAttempt: 2,
      mutationKind: "normal_fix",
      pass: 1,
      implementation: {
        ...implementation,
        remaining_risks: [`RESIDUAL-OVERSIZE:${"z".repeat(MAX_HANDS_PROMPT_BYTES)}`],
      },
      currentDiff: "diff",
      verification,
      activeAction: action,
      completedActions: [],
      priorPassReports: [],
      budget,
    })).rejects.toThrow(`Hands self-review prompt exceeds ${MAX_HANDS_PROMPT_BYTES} bytes`);

    expect(codex.calls).toHaveLength(0);
    expect(budget.claims).toHaveLength(0);
    expect(budget.completions).toHaveLength(0);
    for (const relativePath of [
      "self-review/item-1/attempt-2/pass-1.claim.json",
      "self-review/item-1/attempt-2/pass-1.json",
      `prompts/${artifactName}.md`,
      `schemas/${artifactName}.json`,
      `responses/${artifactName}.json`,
    ]) {
      await expect(readFile(join(ledger.runDir, relativePath), "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("writes distinct prompt, schema, response, and immutable report artifacts", async () => {
    const { ledger, result } = await invoke();
    const promptPath = join(ledger.runDir, "prompts/hands-self-review-item-1-attempt-2-pass-1.md");
    const schemaPath = join(ledger.runDir, "schemas/hands-self-review-item-1-attempt-2-pass-1.json");
    const responsePath = join(ledger.runDir, "responses/hands-self-review-item-1-attempt-2-pass-1.json");
    const originalPrompt = await readFile(promptPath, "utf8");
    const originalSchema = await readFile(schemaPath, "utf8");
    const originalResponse = await readFile(responsePath, "utf8");

    expect(originalPrompt).toContain("diff --git");
    expect(originalSchema).toContain("ready_for_resolution_check");
    expect(originalResponse).toContain('"pass": 1');
    expect(JSON.parse(await readFile(join(ledger.runDir, result.reportPath), "utf8"))).toEqual(validReport);

    const duplicateCodex = new RecordingHands();
    await expect(runHandsSelfReview({
      runDir: ledger.runDir,
      worktreePath: join(root!, "worktree"),
      workItem,
      intake: { ...intake, repo_root: root! },
      codex: duplicateCodex,
      parentAttempt: 2,
      mutationKind: "normal_fix" as const,
      pass: 1,
      implementation,
      currentDiff: "same diff",
      verification,
      activeAction: action,
      completedActions: [],
      priorPassReports: [],
    })).rejects.toMatchObject({ code: "EEXIST" });
    expect(duplicateCodex.calls).toHaveLength(0);
    expect(await readFile(promptPath, "utf8")).toBe(originalPrompt);
    expect(await readFile(schemaPath, "utf8")).toBe(originalSchema);
    expect(await readFile(responsePath, "utf8")).toBe(originalResponse);
  });

  it("rejects an already claimed pass before invocation or artifact overwrite", async () => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-self-review-claimed-"));
    const ledger = await createRunLedgerV2({ repoRoot: root, originalRequest: intake.task });
    const claimDir = join(ledger.runDir, "self-review/item-1/attempt-2");
    const promptPath = join(ledger.runDir, "prompts/hands-self-review-item-1-attempt-2-pass-1.md");
    await mkdir(claimDir, { recursive: true });
    await mkdir(join(ledger.runDir, "prompts"), { recursive: true });
    await writeFile(join(claimDir, "pass-1.claim.json"), '{"claimed":true}\n', "utf8");
    await writeFile(promptPath, "original prompt\n", "utf8");
    const codex = new RecordingHands();

    await expect(runHandsSelfReview({
      runDir: ledger.runDir,
      worktreePath: join(root, "worktree"),
      workItem,
      intake: { ...intake, repo_root: root },
      codex,
      parentAttempt: 2,
      mutationKind: "normal_fix" as const,
      pass: 1,
      implementation,
      currentDiff: "replacement diff",
      verification,
      activeAction: action,
      completedActions: [],
      priorPassReports: [],
    })).rejects.toMatchObject({ code: "EEXIST" });
    expect(codex.calls).toHaveLength(0);
    expect(await readFile(promptPath, "utf8")).toBe("original prompt\n");
  });

  it.each([
    ["nonzero exit", () => new RecordingHands(validReport, 1)],
    ["thrown adapter error", () => {
      const calls: CodexInvokeInput[] = [];
      return {
        calls,
        invoke: async (input: CodexInvokeInput) => {
          calls.push(input);
          throw new Error("adapter failed after invocation started");
        },
      };
    }],
    ["malformed output", () => {
      const calls: CodexInvokeInput[] = [];
      return {
        calls,
        invoke: async (input: CodexInvokeInput) => {
          calls.push(input);
          return {
            text: "not parsed",
            exitCode: 0,
            promptPath: "prompt",
            stdoutPath: "stdout",
            stderrPath: "stderr",
            ...codexMetrics,
          };
        },
      };
    }],
  ])("retains a blocked claim after %s and rejects ordinary replay", async (_label, createCodex) => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-self-review-post-invoke-failure-"));
    const ledger = await createRunLedgerV2({ repoRoot: root, originalRequest: intake.task });
    const input = {
      runDir: ledger.runDir,
      worktreePath: join(root, "worktree"),
      workItem,
      intake: { ...intake, repo_root: root },
      parentAttempt: 2,
      mutationKind: "normal_fix" as const,
      pass: 1,
      implementation,
      currentDiff: "diff",
      verification,
      activeAction: action,
      completedActions: [],
      priorPassReports: [],
    };
    const claimPath = join(ledger.runDir, "self-review/item-1/attempt-2/pass-1.claim.json");
    const reportPath = join(ledger.runDir, "self-review/item-1/attempt-2/pass-1.json");
    const promptPath = join(ledger.runDir, "prompts/hands-self-review-item-1-attempt-2-pass-1.md");
    const schemaPath = join(ledger.runDir, "schemas/hands-self-review-item-1-attempt-2-pass-1.json");
    const responsePath = join(ledger.runDir, "responses/hands-self-review-item-1-attempt-2-pass-1.json");
    const codex = createCodex();

    await expect(runHandsSelfReview({ ...input, codex })).rejects.toThrow();
    expect(codex.calls).toHaveLength(1);
    await expect(readFile(reportPath, "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.parse(await readFile(claimPath, "utf8"))).toMatchObject({ state: "blocked" });
    const originalPrompt = await readFile(promptPath, "utf8");
    const originalSchema = await readFile(schemaPath, "utf8");
    await expect(readFile(responsePath, "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });

    const replayCodex = new RecordingHands();
    await expect(runHandsSelfReview({ ...input, codex: replayCodex }))
      .rejects.toMatchObject({ code: "EEXIST" });
    expect(replayCodex.calls).toHaveLength(0);
    expect(await readFile(promptPath, "utf8")).toBe(originalPrompt);
    expect(await readFile(schemaPath, "utf8")).toBe(originalSchema);
    await expect(readFile(responsePath, "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("releases the claim when artifact setup fails before Codex invocation", async () => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-self-review-pre-invoke-failure-"));
    const ledger = await createRunLedgerV2({ repoRoot: root, originalRequest: intake.task });
    const promptPath = join(ledger.runDir, "prompts/hands-self-review-item-1-attempt-2-pass-1.md");
    await mkdir(promptPath, { recursive: true });
    const codex = new RecordingHands();

    await expect(runHandsSelfReview({
      runDir: ledger.runDir,
      worktreePath: join(root, "worktree"),
      workItem,
      intake: { ...intake, repo_root: root },
      codex,
      parentAttempt: 2,
      mutationKind: "normal_fix" as const,
      pass: 1,
      implementation,
      currentDiff: "diff",
      verification,
      activeAction: action,
      completedActions: [],
      priorPassReports: [],
    })).rejects.toMatchObject({ code: "EISDIR" });
    expect(codex.calls).toHaveLength(0);
    await expect(readFile(join(ledger.runDir, "self-review/item-1/attempt-2/pass-1.claim.json"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves a blocked primary claim before the validated backup resumes the same pass", async () => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-self-review-backup-"));
    const ledger = await createRunLedgerV2({ repoRoot: root, originalRequest: intake.task });
    const input = {
      runDir: ledger.runDir,
      worktreePath: join(root, "worktree"),
      workItem,
      intake: { ...intake, repo_root: root },
      parentAttempt: 2,
      mutationKind: "normal_fix" as const,
      pass: 1,
      implementation,
      currentDiff: "diff",
      verification,
      activeAction: action,
      completedActions: [],
      priorPassReports: [],
    };
    await expect(runHandsSelfReview({ ...input, codex: new RecordingHands(validReport, 1) })).rejects.toThrow();

    const backup = new RecordingHands();
    const result = await runHandsSelfReview({ ...input, codex: backup, resumeBlockedClaim: true });

    expect(result.report).toEqual(validReport);
    expect(backup.calls).toHaveLength(1);
    expect(backup.calls[0]!.artifactName).toBe("hands-self-review-item-1-attempt-2-pass-1-resume-2");
    expect(JSON.parse(await readFile(
      join(ledger.runDir, "self-review/item-1/attempt-2/pass-1.claim.json.primary-blocked"),
      "utf8",
    ))).toMatchObject({ state: "blocked" });
  });

  it("retains a blocked claim when response persistence fails after invocation", async () => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-self-review-persistence-failure-"));
    const ledger = await createRunLedgerV2({ repoRoot: root, originalRequest: intake.task });
    const responsePath = join(ledger.runDir, "responses/hands-self-review-item-1-attempt-2-pass-1.json");
    await mkdir(responsePath, { recursive: true });
    const codex = new RecordingHands();
    const input = {
      runDir: ledger.runDir,
      worktreePath: join(root, "worktree"),
      workItem,
      intake: { ...intake, repo_root: root },
      parentAttempt: 2,
      mutationKind: "normal_fix" as const,
      pass: 1,
      implementation,
      currentDiff: "diff",
      verification,
      activeAction: action,
      completedActions: [],
      priorPassReports: [],
    };

    await expect(runHandsSelfReview({ ...input, codex })).rejects.toMatchObject({ code: "EISDIR" });
    expect(codex.calls).toHaveLength(1);
    expect(JSON.parse(await readFile(
      join(ledger.runDir, "self-review/item-1/attempt-2/pass-1.claim.json"),
      "utf8",
    ))).toMatchObject({ state: "blocked" });
    await expect(readFile(join(ledger.runDir, "self-review/item-1/attempt-2/pass-1.json"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });

    const replayCodex = new RecordingHands();
    await expect(runHandsSelfReview({ ...input, codex: replayCodex }))
      .rejects.toMatchObject({ code: "EEXIST" });
    expect(replayCodex.calls).toHaveLength(0);
  });

  it("allows broader approved-work-item fixes only when no action is active", async () => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-self-review-no-action-"));
    const ledger = await createRunLedgerV2({ repoRoot: root, originalRequest: intake.task });
    const codex = new RecordingHands({ ...validReport, active_action_id: null });

    await runHandsSelfReview({
      runDir: ledger.runDir,
      worktreePath: join(root, "worktree"),
      workItem,
      intake: { ...intake, repo_root: root },
      codex,
      parentAttempt: 2,
      mutationKind: "normal_fix" as const,
      pass: 1,
      implementation,
      currentDiff: "diff",
      verification,
      activeAction: null,
      completedActions: [],
      priorPassReports: [],
    });

    expect(codex.calls[0].prompt).toContain(
      "you may fix other defects only when they are inside the approved work-item scope",
    );
    expect(codex.calls[0].prompt).not.toContain("fixes are limited exclusively to that action");
  });

  it.each([
    ["work item", { work_item_id: "item-2" }],
    ["parent attempt", { parent_attempt: 3 }],
    ["mutation kind", { mutation_kind: "quality_recovery" as const }],
    ["pass", { pass: 2 }],
    ["active action", { active_action_id: "R2-A2" }],
  ])("binds a model-mismatched %s to controller-owned provenance", async (_label, patch) => {
    const { result } = await invoke({ ...validReport, ...patch });
    expect(result.report).toMatchObject({
      work_item_id: "item-1",
      parent_attempt: 2,
      mutation_kind: "normal_fix",
      pass: 1,
      active_action_id: "R2-A1",
    });
  });

  it("rejects readiness while findings remain", async () => {
    await expect(invoke({
      ...validReport,
      remaining_findings: ["A problem remains"],
      ready_for_resolution_check: true,
    })).rejects.toThrow("ready_for_resolution_check requires no remaining findings");
  });
});
