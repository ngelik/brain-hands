import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
vi.mock("../../src/core/executor.js", () => ({
  runCommand: vi.fn(),
}));
import {
  CodexInvocationError,
  disabledCodexAgentFeatureArgs,
  DryRunCodexAdapter,
  SubprocessCodexAdapter,
  classifyCodexFailure,
  modelInvocationBudgetKey,
  renderCodexArgs,
} from "../../src/adapters/codex.js";
import { runCommand } from "../../src/core/executor.js";
import type { CommandResult } from "../../src/core/executor.js";
import { createRunLedgerV2, transitionRun } from "../../src/core/ledger.js";
import type {
  ResourceBudgetClaimInput,
  ResourceBudgetClaimV1,
  ResourceBudgetCompletionInput,
  ResourceBudgetPort,
  ResourceBudgetUsage,
} from "../../src/core/resource-budget.js";
import type { BrainHandsConfig, DiscoveryOutcome, ResolvedRunIntake } from "../../src/core/types.js";
import { openProgressReporter, readProgressEvents } from "../../src/progress/log.js";
import type { ProgressReporter } from "../../src/progress/log.js";
import { runDiscoveryTurn } from "../../src/workflow/discovery.js";

let runDir: string | null = null;

const mockedRunCommand = vi.mocked(runCommand);

function recordingBudget(options: { rejectModelInvocation?: boolean } = {}): ResourceBudgetPort & {
  claims: ResourceBudgetClaimV1[];
  completions: ResourceBudgetCompletionInput[];
} {
  const claims: ResourceBudgetClaimV1[] = [];
  const completions: ResourceBudgetCompletionInput[] = [];
  const usage: ResourceBudgetUsage = {
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
  };
  return {
    claims,
    completions,
    usage: async () => usage,
    claim: async (input: ResourceBudgetClaimInput) => {
      if (options.rejectModelInvocation && input.kind === "model_invocation") {
        throw new Error("budget exhausted before model invocation");
      }
      const claim: ResourceBudgetClaimV1 = {
        schema_version: 1,
        claim_id: `budget-claim:${String(claims.length + 1).repeat(64).slice(0, 64)}`,
        run_id: "run-1",
        kind: input.kind,
        key: input.key,
        reserved_at: "2026-07-17T00:00:00.000Z",
        elapsed_reservation_ms: input.elapsed_reservation_ms,
      };
      claims.push(claim);
      return claim;
    },
    complete: async (input: ResourceBudgetCompletionInput) => {
      completions.push(input);
      return {
        schema_version: 1,
        completed_at: "2026-07-17T00:00:01.000Z",
        ...input,
      };
    },
    runWorkflowAttempt: async (_key, action) => action(),
    remainingActiveElapsedMs: async () => 1_234,
  };
}

function createTestConfig(): BrainHandsConfig {
  return {
    version: 1,
    github: { enabled: true, default_remote: "origin" },
    codex: {
      command: "codex",
      args_template: ["exec", "--ephemeral", "--model", "{{model}}"],
      prompt_transport: "stdin",
      prompt_file_flag: "--prompt-file",
      timeout_seconds: 30,
    },
    retry_policy: { max_hands_fix_attempts: 1, max_replan_attempts: 1 },
    profiles: {
      brain_planner: {
        model: "strongest",
        reasoning_effort: "high",
        temperature: "low",
        responsibilities: [],
      },
      brain_reviewer: {
        model: "strongest",
        reasoning_effort: "high",
        temperature: "low",
        responsibilities: [],
      },
      hands_implementer: {
        model: "cheap_fast",
        reasoning_effort: "low",
        temperature: "low",
        responsibilities: [],
      },
      hands_fixer: {
        model: "cheap_fast",
        reasoning_effort: "low",
        temperature: "low",
        responsibilities: [],
      },
    },
  };
}

function createConfigWithCodexPatch(
  patch: Partial<BrainHandsConfig["codex"]>,
): BrainHandsConfig {
  return {
    ...createTestConfig(),
    codex: {
      ...createTestConfig().codex,
      ...patch,
    },
  };
}

const catalogModelsResult: CommandResult = {
  command: "codex",
  args: ["debug", "models"],
  exitCode: 0,
  stdout: JSON.stringify({
    models: [
      { slug: "gpt-5.5", supported_reasoning_levels: [{ effort: "high" }, { effort: "low" }, { effort: "xhigh" }] },
      { slug: "gpt-5.6-sol", supported_reasoning_levels: [{ effort: "high" }, { effort: "xhigh" }] },
      { slug: "gpt-5.3-codex-spark", supported_reasoning_levels: [{ effort: "xhigh" }] },
      { slug: "gpt-5", supported_reasoning_levels: [{ effort: "high" }] },
    ],
  }),
  stderr: "",
  failed: false,
  timedOut: false,
  signal: null,
};

function mockSuccessfulCatalogThenExec(output: unknown): void {
  mockedRunCommand.mockImplementation(async ({ args, stdin }) => {
    if (args[0] === "debug" && args[1] === "models") {
      return catalogModelsResult;
    }

    const outputPath = args[args.indexOf("--output-last-message") + 1];
    await writeFile(outputPath, JSON.stringify(output), "utf8");
    return {
      command: "codex",
      args,
      exitCode: 0,
      stdout: "progress",
      stderr: "",
      failed: false,
      timedOut: false,
      signal: null,
    };
  });
}

function mockCatalogThenExecResult(result: CommandResult): void {
  mockedRunCommand.mockImplementation(async ({ args }) => {
    if (args[0] === "debug" && args[1] === "models") {
      return catalogModelsResult;
    }
    return result;
  });
}

afterEach(async () => {
  mockedRunCommand.mockReset();
  if (runDir) {
    await rm(runDir, { recursive: true, force: true });
    runDir = null;
  }
});

describe("renderCodexArgs", () => {
  it("renders the current structured Codex argv contract", () => {
    const args = renderCodexArgs({
      model: "gpt-5.5",
      reasoningEffort: "high",
      sandbox: "read-only",
      cwd: "/repo",
      outputSchemaPath: "/run/schemas/brain.json",
      outputPath: "/run/responses/brain.json",
      isolateUserConfig: true,
      enableWebSearch: true,
      jsonEvents: false,
    });

    expect(args).toEqual([
      "exec",
      "--ephemeral",
      ...disabledCodexAgentFeatureArgs(),
      "--ignore-user-config",
      "--model",
      "gpt-5.5",
      "-c",
      'model_reasoning_effort="high"',
      "--sandbox",
      "read-only",
      "-C",
      "/repo",
      "--output-schema",
      "/run/schemas/brain.json",
      "--output-last-message",
      "/run/responses/brain.json",
      "--search",
    ]);
  });

  it("omits isolation and search flags when disabled", () => {
    expect(
      renderCodexArgs({
        model: "gpt-5.5",
        reasoningEffort: "low",
        sandbox: "workspace-write",
        cwd: "/repo",
        outputSchemaPath: "/run/schemas/hands.json",
        outputPath: "/run/responses/hands.json",
        isolateUserConfig: false,
      enableWebSearch: false,
      jsonEvents: false,
      }),
    ).toEqual([
      "exec",
      "--ephemeral",
      ...disabledCodexAgentFeatureArgs(),
      "--model",
      "gpt-5.5",
      "-c",
      'model_reasoning_effort="low"',
      "--sandbox",
      "workspace-write",
      "-C",
      "/repo",
      "--output-schema",
      "/run/schemas/hands.json",
      "--output-last-message",
      "/run/responses/hands.json",
    ]);
  });

  it("enables JSONL events for progress-aware structured invocations", () => {
    const args = renderCodexArgs({
      model: "gpt-5.5", reasoningEffort: "high", sandbox: "read-only", cwd: "/repo",
      outputSchemaPath: "/run/schema.json", outputPath: "/run/output.json",
      isolateUserConfig: true, enableWebSearch: false, jsonEvents: true,
    });
    expect(args).toContain("--json");
    expect(args).toContain("--output-last-message");
  });

  it("can skip the Git repository check for isolated role invocations", () => {
    const args = renderCodexArgs({
      model: "gpt-5.5", reasoningEffort: "high", sandbox: "read-only", cwd: "/tmp/isolated",
      outputSchemaPath: "/run/schema.json", outputPath: "/run/output.json",
      isolateUserConfig: true, enableWebSearch: false, skipGitRepoCheck: true,
    });
    expect(args).toContain("--skip-git-repo-check");
  });

});

describe("classifyCodexFailure", () => {
  function commandFailure(stderr: string): CommandResult {
    return { command: "codex", args: ["exec"], exitCode: 1, stdout: "", stderr, failed: true, timedOut: false, signal: null };
  }

  it.each([
    ["{\"error\":{\"code\":\"usage_limit_reached\"}}", "primary_usage_limit"],
    ["You've hit your usage limit. Try again after 3:15 PM.", "primary_usage_limit"],
    ["rate limit exceeded; retry in 10 seconds", "other"],
    ["authentication failed", "other"],
  ] as const)("classifies %s as %s", (stderr, expected) => {
    expect(classifyCodexFailure(commandFailure(stderr))).toBe(expected);
  });
});

describe("DryRunCodexAdapter", () => {
  it("rejects an oversized prompt before claiming budget or writing artifacts", async () => {
    runDir = await mkdtemp(join(tmpdir(), "brain-hands-codex-prompt-limit-"));
    const budget = recordingBudget();

    await expect(new DryRunCodexAdapter({ ok: true }).invoke({
      role: "verifier",
      model: "gpt-5.5",
      reasoningEffort: "high",
      sandbox: "read-only",
      prompt: "x".repeat(1024 * 1024 + 1),
      runDir,
      artifactName: "oversized-dry-run",
      budget,
      attemptKey: "verifier:1:item:oversized:1",
      outputSchema: { type: "object" },
      outputParser: z.object({ ok: z.boolean() }),
    })).rejects.toThrow("Codex prompt exceeds 1048576 bytes");

    expect(budget.claims).toEqual([]);
    expect(budget.completions).toEqual([]);
    await expect(readdir(runDir)).resolves.toEqual([]);
  });

  it("uses a fresh model budget identity when retrying the same immutable artifact", () => {
    const first = modelInvocationBudgetKey("hands-work-item-foundation-attempt-1");
    const second = modelInvocationBudgetKey("hands-work-item-foundation-attempt-1");

    expect(first).toMatch(/^hands-work-item-foundation-attempt-1:invocation:[0-9a-f-]{36}$/);
    expect(second).not.toBe(first);
  });

  it("rejects a final evidence symlink without changing its outside target", async () => {
    const root = await mkdtemp(join(tmpdir(), "brain-hands-codex-final-link-"));
    const ledger = await createRunLedgerV2({ repoRoot: root, originalRequest: "Keep final evidence owned" });
    const outside = join(root, "outside-prompt.md");
    await writeFile(outside, "unchanged");
    await symlink(outside, join(ledger.runDir, "prompts/owned-test.md"));
    const adapter = new DryRunCodexAdapter({ ok: true });
    await expect(adapter.invoke({
      role: "brain", model: "gpt-5.5", reasoningEffort: "high", sandbox: "read-only",
      prompt: "Plan", runDir: ledger.runDir, artifactName: "owned-test",
      outputSchema: { type: "object" }, outputParser: z.object({ ok: z.boolean() }),
    })).rejects.toThrow(/symlink|owned/i);
    expect(await readFile(outside, "utf8")).toBe("unchanged");
    await rm(root, { recursive: true, force: true });
  });
  it.each(["prompts", "schemas", "responses"])("rejects a symlinked %s evidence root without writing outside the run", async (rootName) => {
    const root = await mkdtemp(join(tmpdir(), "brain-hands-codex-owned-"));
    const ledger = await createRunLedgerV2({ repoRoot: root, originalRequest: "Keep evidence owned" });
    const evidenceRoot = join(ledger.runDir, rootName);
    await rename(evidenceRoot, `${evidenceRoot}-saved`);
    const outside = join(root, `outside-${rootName}`);
    await mkdir(outside);
    await writeFile(join(outside, "sentinel.txt"), "unchanged");
    await symlink(outside, evidenceRoot);
    const adapter = new DryRunCodexAdapter({ ok: true });
    await expect(adapter.invoke({
      role: "brain", model: "gpt-5.5", reasoningEffort: "high", sandbox: "read-only",
      prompt: "Plan", runDir: ledger.runDir, artifactName: "owned-test",
      outputSchema: { type: "object" }, outputParser: z.object({ ok: z.boolean() }),
    })).rejects.toThrow(/symlink|owned/i);
    expect(await readdir(outside)).toEqual(["sentinel.txt"]);
    expect(await readFile(join(outside, "sentinel.txt"), "utf8")).toBe("unchanged");
    await rm(root, { recursive: true, force: true });
  });
  it("stores prompt files and returns deterministic output", async () => {
    runDir = await mkdtemp(join(tmpdir(), "brain-hands-codex-"));
    const adapter = new DryRunCodexAdapter();

    const result = await adapter.invoke({
      role: "brain_planner",
      model: "strongest",
      reasoningEffort: "high",
      prompt: "Plan the task",
      runDir,
      artifactName: "brain-planner",
    });

    const prompt = await readFile(join(runDir, "prompts", "brain-planner.md"), "utf8");

    expect(prompt).toBe("Plan the task");
    expect(result.text).toContain("DRY_RUN");
  });

  it("validates a caller-provided structured fixture with the supplied parser", async () => {
    runDir = await mkdtemp(join(tmpdir(), "brain-hands-codex-"));
    const parser = z.object({ summary: z.string() });
    const adapter = new DryRunCodexAdapter();

    const result = await adapter.invoke({
      role: "brain",
      model: "gpt-5.5",
      reasoningEffort: "high",
      prompt: "Plan the task",
      runDir,
      artifactName: "brain",
      outputSchema: { type: "object", properties: { summary: { type: "string" } } },
      outputParser: parser,
      fixture: { summary: "ready" },
    });

    expect(result.parsed).toEqual({ summary: "ready" });
    expect(result).toMatchObject({
      usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 },
      durationMs: 0,
      processStarted: false,
      turnStarted: false,
      structuredTerminalError: false,
    });
    expect(result.text).toContain('"summary": "ready"');
    expect(await readFile(result.outputPath!, "utf8")).toBe(result.text);
    await expect(
      adapter.invoke({
        role: "brain",
        model: "gpt-5.5",
        reasoningEffort: "high",
        prompt: "Plan the task",
        runDir,
        artifactName: "invalid",
        outputSchema: { type: "object" },
        outputParser: parser,
        fixture: { summary: 42 },
      }),
    ).rejects.toThrow();
  });

  it("parses a JSON string fixture supplied to the adapter constructor", async () => {
    runDir = await mkdtemp(join(tmpdir(), "brain-hands-codex-"));
    const adapter = new DryRunCodexAdapter('{"summary":"from constructor"}');
    const result = await adapter.invoke({
      role: "brain",
      model: "gpt-5.5",
      reasoningEffort: "high",
      prompt: "Plan the task",
      runDir,
      artifactName: "brain-constructor",
      outputSchema: { type: "object" },
      outputParser: z.object({ summary: z.string() }),
    });

    expect(result.parsed).toEqual({ summary: "from constructor" });
  });

  it("records a generic failure when a structured fixture is invalid", async () => {
    runDir = await mkdtemp(join(tmpdir(), "brain-hands-dry-progress-"));
    await writeFile(join(runDir, "progress.jsonl"), "", "utf8");
    const reporter = await openProgressReporter({ runDir });
    await expect(new DryRunCodexAdapter({ invalid: true }).invoke({
      role: "brain",
      model: "gpt",
      reasoningEffort: "high",
      prompt: "Plan",
      runDir,
      artifactName: "invalid-dry-brain",
      outputSchema: { type: "object" },
      outputParser: z.object({ summary: z.string() }),
      progress: { reporter, context: { source: "brain", mode: "planning", model: "gpt", reasoningEffort: "high" } },
    })).rejects.toThrow();
    const labels: string[] = [];
    for await (const event of readProgressEvents(runDir)) labels.push(event.safe_label);
    expect(labels).not.toContain("Brain turn completed");
    expect(labels.at(-1)).toBe("Workflow step failed; inspect the run artifacts");
    expect(labels).not.toContain("Structured plan validated");
  });

  it("preserves ordered action metadata with the default Verifier parser", async () => {
    runDir = await mkdtemp(join(tmpdir(), "brain-hands-codex-"));
    const fixture = {
      work_item_id: "item-1",
      attempt: 1,
      final: false,
      decision: "request_changes",
      failure_class: "implementation_failure",
      blocker: null,
      blocker_code: null,
      acceptance_coverage: [],
      evidence_reviewed: [],
      findings: [{
        severity: "medium",
        file: "src/example.ts",
        line: 1,
        acceptance_criterion: "The example works",
        problem_class: "correctness",
        problem: "The example fails",
        required_fix: "Correct the example",
        evidence_refs: ["verification/example.json"],
        remediation: {
          schema_version: 1,
          diagnosis: { observed_behavior: "The example fails", expected_behavior: "The example works", failure_mechanism: "The required behavior is missing", reproduction: ["Run npm test"], evidence_refs: ["verification/example.json"] },
          targets: [{ kind: "code", path: "src/example.ts", symbol: "example", line_hint: 1 }],
          remediation: { strategy: "Correct the example", change_units: [{ id: "FIX-1", path: "src/example.ts", target: "example", operation: "modify", requirements: ["Make the example work."], satisfies: ["SC-1"] }], allowed_files: ["src/example.ts"], forbidden_changes: [] },
          verification: { commands: [{ id: "CMD-1", argv: ["npm", "test"] }], success_conditions: [{ id: "SC-1", statement: "The example works", satisfied_by: ["CMD-1", "EVID-1"] }], required_evidence: [{ id: "EVID-1", kind: "test_result", source_id: "CMD-1", output_path: "verification/example-result.json" }] },
          completion_contract: { required_change_unit_ids: ["FIX-1"], expected_changed_files: ["src/example.ts"], allow_additional_files: false },
        },
        action_id: "R1-A1",
        order: 1,
        depends_on: [],
      }],
      residual_risks: [],
    };

    const result = await new DryRunCodexAdapter().invoke({
      role: "verifier",
      model: "gpt-5.5",
      reasoningEffort: "high",
      prompt: "Review",
      runDir,
      artifactName: "verifier-default-parser",
      fixture,
    });

    expect(result.parsed).toMatchObject({
      findings: [{ action_id: "R1-A1", order: 1, depends_on: [] }],
    });
  });

  it("does not enable web search for Hands", async () => {
    runDir = await mkdtemp(join(tmpdir(), "brain-hands-codex-"));
    mockSuccessfulCatalogThenExec({ ok: true });

    const adapter = new SubprocessCodexAdapter(createTestConfig(), "/repo/root");
    await adapter.invoke({
      role: "hands",
      model: "gpt-5.5",
      reasoningEffort: "low",
      sandbox: "workspace-write",
      prompt: "Implement",
      runDir,
      artifactName: "hands",
      outputSchema: { type: "object" },
      outputParser: z.object({ ok: z.boolean() }),
      enableWebSearch: true,
    });

    const args = mockedRunCommand.mock.calls.find((call) => call[0].args[0] === "exec")?.[0].args ?? [];
    expect(args).not.toContain("--search");
  });
});

describe("SubprocessCodexAdapter", () => {
  it("rejects an oversized prompt before claiming budget, writing artifacts, or invoking Codex", async () => {
    runDir = await mkdtemp(join(tmpdir(), "brain-hands-codex-prompt-limit-"));
    const budget = recordingBudget();
    const adapter = new SubprocessCodexAdapter(createTestConfig(), "/repo/root", async () => {
      throw new Error("model validation should not run");
    });

    await expect(adapter.invoke({
      role: "verifier",
      model: "gpt-5.5",
      reasoningEffort: "high",
      sandbox: "read-only",
      prompt: "x".repeat(1024 * 1024 + 1),
      runDir,
      artifactName: "oversized-subprocess",
      budget,
      attemptKey: "verifier:1:item:oversized:1",
      outputSchema: { type: "object" },
      outputParser: z.object({ ok: z.boolean() }),
    })).rejects.toThrow("Codex prompt exceeds 1048576 bytes");

    expect(budget.claims).toEqual([]);
    expect(budget.completions).toEqual([]);
    expect(mockedRunCommand).not.toHaveBeenCalled();
    await expect(readdir(runDir)).resolves.toEqual([]);
  });

  it("classifies only output JSON/schema failures as retryable validation failures", async () => {
    runDir = await mkdtemp(join(tmpdir(), "brain-hands-codex-validation-kind-"));
    mockedRunCommand.mockImplementation(async ({ args }) => {
      const outputPath = args[args.indexOf("--output-last-message") + 1]!;
      await writeFile(outputPath, '{"summary":42}', "utf8");
      return { command: "codex", args, exitCode: 0, stdout: "", stderr: "", failed: false, timedOut: false, signal: null };
    });
    const adapter = new SubprocessCodexAdapter(createTestConfig(), "/repo/root", async () => {});

    const failure = await adapter.invoke({
      role: "brain", model: "gpt-5.5", reasoningEffort: "high", prompt: "Plan", runDir,
      artifactName: "invalid-output", outputSchema: { type: "object" },
      outputParser: z.object({ summary: z.string() }),
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(CodexInvocationError);
    expect(failure).toMatchObject({ kind: "output_validation" });
    expect((failure as CodexInvocationError).cause).toBeInstanceOf(Error);
  });

  it("does not classify successful-validation progress failures as output validation", async () => {
    runDir = await mkdtemp(join(tmpdir(), "brain-hands-codex-progress-validation-"));
    mockSuccessfulCatalogThenExec({ summary: "valid" });
    const progressFailure = new Error("progress filesystem denied");
    const reporter: ProgressReporter = {
      path: join(runDir, "progress.jsonl"),
      sessionId: "session-1",
      workerPid: process.pid,
      async emit(intent) {
        if (intent.code === "plan_validated") throw progressFailure;
        return null;
      },
    };

    const failure = await new SubprocessCodexAdapter(createTestConfig(), "/repo/root").invoke({
      role: "brain", model: "gpt-5.5", reasoningEffort: "high", prompt: "Plan", runDir,
      artifactName: "valid-output-progress-failure", outputSchema: { type: "object" },
      outputParser: z.object({ summary: z.string() }),
      progress: { reporter, context: { source: "brain", mode: "planning", model: "gpt-5.5", reasoningEffort: "high" } },
    }).catch((error: unknown) => error);

    expect(failure).toBe(progressFailure);
    expect(failure).not.toBeInstanceOf(CodexInvocationError);
  });

  it("lets discovery correct one schema-invalid production output through the subprocess adapter", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-codex-discovery-retry-"));
    try {
      const intake: ResolvedRunIntake = {
        task: "Discover the workflow boundary",
        repo_root: repoRoot,
        mode: "local",
        research: false,
        reflection: false,
        models: { brain: "gpt-5.5", hands: "gpt-5.5", verifier: "gpt-5.5" },
        resolved_models: { brain: "gpt-5.5", hands: "gpt-5.5", verifier: "gpt-5.5" },
        roles: {
          brain: { model: "gpt-5.5", reasoning_effort: "high", sandbox: "read-only" },
          hands: { model: "gpt-5.5", reasoning_effort: "low", sandbox: "workspace-write" },
          verifier: { model: "gpt-5.5", reasoning_effort: "high", sandbox: "read-only" },
        },
      };
      const ledger = await createRunLedgerV2({ repoRoot, originalRequest: intake.task, intake, roles: intake.roles });
      await transitionRun(ledger.runDir, "preflight", { actor: "test" });
      await transitionRun(ledger.runDir, "brain_discovery", { actor: "test" });
      const valid: DiscoveryOutcome = {
        outcome: "ask_question",
        question: {
          id: "q-001", sequence: 1, category: "required", text: "Which boundary?",
          choices: [], recommended_choice_id: null, recommendation_rationale: null,
          rationale: "It changes scope.", material_effects: ["scope"],
          repository_evidence: ["src/workflow/discovery.ts"], essential_after_soft_limit: null,
        },
      };
      const outputs = [{ outcome: "ask_question", question: { id: "q-001" } }, valid];
      let execCalls = 0;
      mockedRunCommand.mockImplementation(async ({ args }) => {
        const outputPath = args[args.indexOf("--output-last-message") + 1]!;
        await writeFile(outputPath, JSON.stringify(outputs[execCalls]), "utf8");
        execCalls += 1;
        return { command: "codex", args, exitCode: 0, stdout: "", stderr: "", failed: false, timedOut: false, signal: null };
      });
      const adapter = new SubprocessCodexAdapter(createTestConfig(), repoRoot, async () => {});

      await expect(runDiscoveryTurn({ runDir: ledger.runDir, intake, codex: adapter }))
        .resolves.toMatchObject({ state: "awaiting_discovery_answer", question: { id: "q-001" } });
      expect(execCalls).toBe(2);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("streams safe JSONL progress and heartbeats without persisting raw stdout", async () => {
    runDir = await mkdtemp(join(tmpdir(), "brain-hands-codex-progress-"));
    const reporter = await openProgressReporter({ runDir });
    mockedRunCommand.mockImplementation(async (input) => {
      if (input.args[0] === "debug" && input.args[1] === "models") return catalogModelsResult;
      const outputPath = input.args[input.args.indexOf("--output-last-message") + 1]!;
      await input.onStarted?.({ pid: 8765 });
      await input.onStdoutChunk?.('{"type":"item.completed","item":{"type":"reasoning","text":"sk-secret"}}\n');
      await input.onHeartbeat?.({ pid: 8765 });
      await input.onStdoutChunk?.('{"type":"turn.completed","usage":{"input_tokens":4}}\n');
      await writeFile(outputPath, '{"ok":true}', "utf8");
      return { command: "codex", args: input.args, exitCode: 0, stdout: "raw sk-secret jsonl", stderr: "", failed: false, timedOut: false, signal: null };
    });

    const adapter = new SubprocessCodexAdapter(createTestConfig(), "/repo/root");
    const result = await adapter.invoke({
      role: "hands", model: "gpt-5.6-sol", reasoningEffort: "xhigh", sandbox: "workspace-write",
      prompt: "Implement", runDir, artifactName: "hands-progress", outputSchema: { type: "object" },
      outputParser: z.object({ ok: z.boolean() }),
      progress: {
        reporter,
        context: { source: "hands", mode: "implementation", model: "gpt-5.6-sol", reasoningEffort: "xhigh", workItem: { index: 1, total: 1, attempt: 1, final: false } },
      },
    });

    const events = [];
    for await (const event of readProgressEvents(runDir)) events.push(event);
    const execCall = mockedRunCommand.mock.calls.find((call) => call[0].args[0] === "exec");
    expect(execCall?.[0].args).toContain("--json");
    expect(events.map((event) => event.safe_label)).toEqual(expect.arrayContaining([
      "Hands started - gpt-5.6-sol/xhigh", "Hands is still running", "Hands result validated",
    ]));
    expect(events.find((event) => event.safe_label.startsWith("Hands started"))).toMatchObject({ child_pid: 8765 });
    expect(JSON.stringify(events)).not.toContain("sk-secret");
    expect(result.progressPath).toBe(join(runDir, "progress.jsonl"));
    expect(result.stdoutPath).toBe(result.progressPath);
    await expect(readFile(join(runDir, "responses", "hands-progress.stdout.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("writes structured invocation artifacts, parses the output, and passes stdin", async () => {
    runDir = await mkdtemp(join(tmpdir(), "brain-hands-codex-"));
    await writeFile(join(runDir, "progress.jsonl"), "", "utf8");
    const reporter = await openProgressReporter({ runDir });
    mockedRunCommand.mockImplementation(async (input) => {
      if (input.args[0] === "debug" && input.args[1] === "models") {
        return catalogModelsResult;
      }
      const outputPath = input.args[input.args.indexOf("--output-last-message") + 1];
      await input.onStdoutChunk?.('{"type":"turn.started"}\n{"type":"item.completed","item":{"type":"reasoning","text":"sk-secret"}}\n');
      await writeFile(outputPath, '{"summary":"ready"}', "utf8");
      return { command: "codex", args: input.args, exitCode: 0, stdout: "raw-sk-secret", stderr: "", failed: false, timedOut: false, signal: null };
    });
    const result = await new SubprocessCodexAdapter(createTestConfig(), "/repo/root").invoke({
      role: "brain", model: "gpt-5.5", reasoningEffort: "high", sandbox: "read-only",
      prompt: "Plan", runDir, artifactName: "brain", outputSchema: { type: "object" },
      outputParser: z.object({ summary: z.string() }),
      progress: { reporter, context: { source: "brain", mode: "planning", model: "gpt-5.5", reasoningEffort: "high" } },
    });
    const labels: string[] = [];
    for await (const event of readProgressEvents(runDir)) labels.push(event.safe_label);
    expect(labels).toContain("Planning started");
    expect(labels).toContain("Structured plan validated");
    expect(JSON.stringify(labels)).not.toContain("sk-secret");
    expect(result.stdoutPath).toBe(join(runDir, "progress.jsonl"));
    await expect(readFile(join(runDir, "responses/brain.stdout.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("parses structured usage without a progress reporter", async () => {
    runDir = await mkdtemp(join(tmpdir(), "brain-hands-codex-no-progress-"));
    mockedRunCommand.mockImplementation(async (input) => {
      if (input.args[0] === "debug" && input.args[1] === "models") return catalogModelsResult;
      const outputPath = input.args[input.args.indexOf("--output-last-message") + 1]!;
      await input.onStarted?.({ pid: 4321 });
      await input.onStdoutChunk?.('{"type":"turn.started"}\n');
      await input.onStdoutChunk?.('{"type":"turn.completed","usage":{"input_tokens":7,"cached_input_tokens":2,"output_tokens":3,"reasoning_output_tokens":1}}\n');
      await writeFile(outputPath, '{"summary":"ready"}', "utf8");
      return { command: "codex", args: input.args, exitCode: 0, stdout: "raw jsonl", stderr: "", failed: false, timedOut: false, signal: null };
    });

    const result = await new SubprocessCodexAdapter(createTestConfig(), "/repo/root").invoke({
      role: "brain", model: "gpt-5.5", reasoningEffort: "high", sandbox: "read-only",
      prompt: "Plan", runDir, artifactName: "brain-no-progress", outputSchema: { type: "object" },
      outputParser: z.object({ summary: z.string() }),
    });
    const execCall = mockedRunCommand.mock.calls.find((call) => call[0].args[0] === "exec");

    expect(execCall?.[0].args).toContain("--json");
    expect(result).toMatchObject({
      usage: { input_tokens: 7, cached_input_tokens: 2, output_tokens: 3, reasoning_output_tokens: 1 },
      processStarted: true,
      turnStarted: true,
      structuredTerminalError: false,
    });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("preserves uncertain usage and structured terminal error metrics on invocation errors", async () => {
    runDir = await mkdtemp(join(tmpdir(), "brain-hands-codex-error-metrics-"));
    mockedRunCommand.mockImplementation(async (input) => {
      if (input.args[0] === "debug" && input.args[1] === "models") return catalogModelsResult;
      await input.onStarted?.({ pid: 4321 });
      await input.onStdoutChunk?.('{"type":"turn.started"}\n');
      await input.onStdoutChunk?.('{"type":"turn.completed","usage":{"input_tokens":"bad","cached_input_tokens":0,"output_tokens":1,"reasoning_output_tokens":0}}\n');
      return { command: "codex", args: input.args, exitCode: 2, stdout: "", stderr: "failed", failed: true, timedOut: false, signal: null };
    });

    await expect(new SubprocessCodexAdapter(createTestConfig(), "/repo/root").invoke({
      role: "brain", model: "gpt-5.5", reasoningEffort: "high", sandbox: "read-only",
      prompt: "Plan", runDir, artifactName: "brain-error-metrics", outputSchema: { type: "object" },
      outputParser: z.object({ summary: z.string() }),
    })).rejects.toMatchObject({
      usage: null,
      processStarted: true,
      turnStarted: true,
      structuredTerminalError: false,
    });

    mockedRunCommand.mockReset();
    mockedRunCommand.mockImplementation(async (input) => {
      if (input.args[0] === "debug" && input.args[1] === "models") return catalogModelsResult;
      await input.onStarted?.({ pid: 4321 });
      await input.onStdoutChunk?.('{"type":"error","error":{"message":"usage limit"}}\n');
      return { command: "codex", args: input.args, exitCode: 2, stdout: "", stderr: "failed", failed: true, timedOut: false, signal: null };
    });

    await expect(new SubprocessCodexAdapter(createTestConfig(), "/repo/root").invoke({
      role: "brain", model: "gpt-5.5", reasoningEffort: "high", sandbox: "read-only",
      prompt: "Plan", runDir, artifactName: "brain-terminal-error", outputSchema: { type: "object" },
      outputParser: z.object({ summary: z.string() }),
    })).rejects.toMatchObject({
      usage: null,
      processStarted: true,
      turnStarted: false,
      structuredTerminalError: true,
    });
  });

  it("redacts progress-aware failures and records a generic failed event", async () => {
    runDir = await mkdtemp(join(tmpdir(), "brain-hands-codex-"));
    await writeFile(join(runDir, "progress.jsonl"), "", "utf8");
    const reporter = await openProgressReporter({ runDir });
    mockCatalogThenExecResult({ command: "codex", args: [], exitCode: 2, stdout: "", stderr: "OPENAI_API_KEY=sk-supersecretvalue", failed: true, timedOut: false, signal: null });
    const adapter = new SubprocessCodexAdapter(createTestConfig(), "/repo/root");
    await expect(adapter.invoke({
      role: "brain", model: "gpt-5", reasoningEffort: "high", prompt: "Plan", runDir,
      artifactName: "failed-brain", outputSchema: { type: "object" }, outputParser: z.object({}),
      progress: { reporter, context: { source: "brain", mode: "planning", model: "gpt-5", reasoningEffort: "high" } },
    })).rejects.not.toThrow("sk-supersecretvalue");
    const labels: string[] = [];
    for await (const event of readProgressEvents(runDir)) labels.push(event.safe_label);
    expect(labels.at(-1)).toBe("Workflow step failed; inspect the run artifacts");
    expect(await readFile(join(runDir, "responses/failed-brain.stderr.txt"), "utf8")).toBe("Codex emitted stderr; details are omitted from live progress.\n");
  });

  it("redacts non-OpenAI credential shapes from bounded stderr", async () => {
    runDir = await mkdtemp(join(tmpdir(), "brain-hands-codex-"));
    await writeFile(join(runDir, "progress.jsonl"), "", "utf8");
    const reporter = await openProgressReporter({ runDir });
    const secrets = "GITHUB_TOKEN=github_pat_abcdefghijklmnopqrstuvwxyz123456 Bearer bearer-secret-value AKIA1234567890ABCDEF xoxb-1234567890-secret";
    mockCatalogThenExecResult({ command: "codex", args: [], exitCode: 2, stdout: "", stderr: secrets, failed: true, timedOut: false, signal: null });
    await expect(new SubprocessCodexAdapter(createTestConfig(), "/repo/root").invoke({
      role: "brain", model: "gpt-5", reasoningEffort: "high", prompt: "Plan", runDir,
      artifactName: "credential-stderr", outputSchema: { type: "object" }, outputParser: z.object({}),
      progress: { reporter, context: { source: "brain", mode: "planning", model: "gpt-5", reasoningEffort: "high" } },
    })).rejects.not.toThrow(/github_pat_|bearer-secret|AKIA|xoxb-/);
    const saved = await readFile(join(runDir, "responses/credential-stderr.stderr.txt"), "utf8");
    expect(saved).not.toMatch(/github_pat_|bearer-secret|AKIA|xoxb-/);
    expect(saved).toBe("Codex emitted stderr; details are omitted from live progress.\n");
  });

  it("records bounded stderr truncation without copying the discarded suffix", async () => {
    runDir = await mkdtemp(join(tmpdir(), "brain-hands-codex-"));
    await writeFile(join(runDir, "progress.jsonl"), "", "utf8");
    const reporter = await openProgressReporter({ runDir });
    mockCatalogThenExecResult({ command: "codex", args: [], exitCode: 2, stdout: "", stderr: `${"🙂".repeat(20_000)}discarded-secret`, failed: true, timedOut: false, signal: null });
    await expect(new SubprocessCodexAdapter(createTestConfig(), "/repo/root").invoke({
      role: "brain", model: "gpt-5", reasoningEffort: "high", prompt: "Plan", runDir,
      artifactName: "long-stderr", outputSchema: { type: "object" }, outputParser: z.object({}),
      progress: { reporter, context: { source: "brain", mode: "planning", model: "gpt-5", reasoningEffort: "high" } },
    })).rejects.not.toThrow("discarded-secret");
    const saved = await readFile(join(runDir, "responses/long-stderr.stderr.txt"), "utf8");
    expect(saved).toBe("Codex emitted stderr; details are omitted from live progress.\n");
    expect(saved).not.toContain("discarded-secret");
  });

  it("runs the catalog debug before codex exec for valid selections", async () => {
    runDir = await mkdtemp(join(tmpdir(), "brain-hands-codex-"));
    const commandCalls: Array<{ args: string[]; stdin: string | undefined }> = [];
    mockedRunCommand.mockImplementation(async ({ args, stdin }) => {
      commandCalls.push({ args, stdin });
      if (args[0] === "debug" && args[1] === "models") {
        return catalogModelsResult;
      }

      const outputPath = args[args.indexOf("--output-last-message") + 1];
      await writeFile(outputPath, JSON.stringify(output), "utf8");
      return {
        command: "codex",
        args,
        exitCode: 0,
        stdout: "progress",
        stderr: "",
        failed: false,
        timedOut: false,
        signal: null,
      };
    });

    const output = { summary: "ready" };
    const parser = z.object({ summary: z.string() });
    const adapter = new SubprocessCodexAdapter(createTestConfig(), "/repo/root");
    await adapter.invoke({
      role: "brain",
      model: "gpt-5.5",
      reasoningEffort: "high",
      sandbox: "read-only",
      prompt: "Plan the task",
      runDir,
      artifactName: "brain-planner",
      outputSchema: { type: "object", properties: { summary: { type: "string" } } },
      outputParser: parser,
      isolateUserConfig: true,
    });

    expect(commandCalls).toHaveLength(2);
    expect(commandCalls[0]?.args).toEqual(["debug", "models"]);
    expect(commandCalls[1]?.args).toContain("exec");
  });

  it("revalidates the catalog for each invocation on the same adapter instance", async () => {
    runDir = await mkdtemp(join(tmpdir(), "brain-hands-codex-"));
    const commandCalls: Array<{ args: string[] }> = [];
    let catalogCalls = 0;
    mockedRunCommand.mockImplementation(async ({ args }) => {
      commandCalls.push({ args });
      if (args[0] === "debug" && args[1] === "models") {
        catalogCalls += 1;
        if (catalogCalls === 1) {
          return catalogModelsResult;
        }

        return {
          ...catalogModelsResult,
          stdout: JSON.stringify({
            models: [{ slug: "gpt-5-other", supported_reasoning_levels: [{ effort: "high" }] }],
          }),
        };
      }

      const outputPath = args[args.indexOf("--output-last-message") + 1];
      await writeFile(outputPath, JSON.stringify({ summary: "ready" }), "utf8");
      return {
        command: "codex",
        args,
        exitCode: 0,
        stdout: "progress",
        stderr: "",
        failed: false,
        timedOut: false,
        signal: null,
      };
    });

    const parser = z.object({ summary: z.string() });
    const adapter = new SubprocessCodexAdapter(createTestConfig(), "/repo/root");
    await adapter.invoke({
      role: "brain",
      model: "gpt-5.5",
      reasoningEffort: "high",
      sandbox: "read-only",
      prompt: "Plan the task",
      runDir,
      artifactName: "brain-planner-1",
      outputSchema: { type: "object", properties: { summary: { type: "string" } } },
      outputParser: parser,
      isolateUserConfig: true,
    });

    await expect(
      adapter.invoke({
        role: "brain",
        model: "gpt-5.5",
        reasoningEffort: "high",
        sandbox: "read-only",
        prompt: "Plan the task",
        runDir,
        artifactName: "brain-planner-2",
        outputSchema: { type: "object", properties: { summary: { type: "string" } } },
        outputParser: parser,
        isolateUserConfig: true,
      }),
    ).rejects.toThrow("Configured model/reasoning pair for role \"brain\" is invalid");

    expect(commandCalls).toHaveLength(3);
    expect(commandCalls[0]?.args).toEqual(["debug", "models"]);
    expect(commandCalls[1]?.args).toContain("exec");
    expect(commandCalls[2]?.args).toEqual(["debug", "models"]);
    expect(commandCalls.filter((call) => call.args[0] === "exec")).toHaveLength(1);
  });

  it("rejects missing model selections before any exec command", async () => {
    runDir = await mkdtemp(join(tmpdir(), "brain-hands-codex-"));
    const commandCalls: Array<{ args: string[] }> = [];
    mockedRunCommand.mockImplementation(async (input) => {
      commandCalls.push({ args: input.args });
      if (input.args[0] === "debug" && input.args[1] === "models") {
        return catalogModelsResult;
      }
      const outputPath = input.args[input.args.indexOf("--output-last-message") + 1];
      await writeFile(outputPath, "{}" , "utf8");
      return { command: "codex", args: input.args, exitCode: 0, stdout: "", stderr: "", failed: false, timedOut: false, signal: null };
    });

    const adapter = new SubprocessCodexAdapter(createTestConfig(), "/repo/root");
    await expect(adapter.invoke({
      role: "brain",
      model: "",
      reasoningEffort: "high",
      sandbox: "read-only",
      prompt: "Plan the task",
      runDir,
      artifactName: "brain-planner",
      outputSchema: { type: "object" },
      outputParser: z.object({ ok: z.boolean() }),
    })).rejects.toThrow();
    expect(commandCalls).toHaveLength(1);
    expect(commandCalls[0]?.args).toEqual(["debug", "models"]);
  });

  it("rejects unsupported reasoning effort before any exec command", async () => {
    runDir = await mkdtemp(join(tmpdir(), "brain-hands-codex-"));
    const commandCalls: Array<{ args: string[] }> = [];
    mockedRunCommand.mockImplementation(async (input) => {
      commandCalls.push({ args: input.args });
      if (input.args[0] === "debug" && input.args[1] === "models") {
        return catalogModelsResult;
      }
      const outputPath = input.args[input.args.indexOf("--output-last-message") + 1];
      await writeFile(outputPath, "{}" , "utf8");
      return { command: "codex", args: input.args, exitCode: 0, stdout: "", stderr: "", failed: false, timedOut: false, signal: null };
    });

    const adapter = new SubprocessCodexAdapter(createTestConfig(), "/repo/root");
    await expect(adapter.invoke({
      role: "brain",
      model: "gpt-5.5",
      reasoningEffort: "ultra",
      sandbox: "read-only",
      prompt: "Plan the task",
      runDir,
      artifactName: "brain-planner",
      outputSchema: { type: "object" },
      outputParser: z.object({ ok: z.boolean() }),
    })).rejects.toThrow();
    expect(commandCalls).toHaveLength(1);
    expect(commandCalls[0]?.args).toEqual(["debug", "models"]);
  });

  it("rejects malformed catalog payloads before exec", async () => {
    runDir = await mkdtemp(join(tmpdir(), "brain-hands-codex-"));
    const commandCalls: Array<{ args: string[] }> = [];
    mockedRunCommand.mockImplementation(async (input) => {
      commandCalls.push({ args: input.args });
      if (input.args[0] === "debug" && input.args[1] === "models") {
        return { ...catalogModelsResult, stdout: "{broken" };
      }
      const outputPath = input.args[input.args.indexOf("--output-last-message") + 1];
      await writeFile(outputPath, "{}" , "utf8");
      return { command: "codex", args: input.args, exitCode: 0, stdout: "", stderr: "", failed: false, timedOut: false, signal: null };
    });

    const adapter = new SubprocessCodexAdapter(createTestConfig(), "/repo/root");
    await expect(adapter.invoke({
      role: "brain",
      model: "gpt-5.5",
      reasoningEffort: "high",
      sandbox: "read-only",
      prompt: "Plan the task",
      runDir,
      artifactName: "brain-planner",
      outputSchema: { type: "object" },
      outputParser: z.object({ ok: z.boolean() }),
    })).rejects.toThrow("Malformed Codex model catalog");
    expect(commandCalls).toHaveLength(1);
    expect(commandCalls[0]?.args).toEqual(["debug", "models"]);
  });

  it("rejects catalog command failures before exec", async () => {
    runDir = await mkdtemp(join(tmpdir(), "brain-hands-codex-"));
    const commandCalls: Array<{ args: string[] }> = [];
    mockedRunCommand.mockImplementation(async (input) => {
      commandCalls.push({ args: input.args });
      if (input.args[0] === "debug" && input.args[1] === "models") {
        return {
          command: "codex",
          args: input.args,
          exitCode: 1,
          stdout: "",
          stderr: "debug models failed",
          failed: true,
          timedOut: false,
          signal: null,
        };
      }
      const outputPath = input.args[input.args.indexOf("--output-last-message") + 1];
      await writeFile(outputPath, "{}" , "utf8");
      return { command: "codex", args: input.args, exitCode: 0, stdout: "", stderr: "", failed: false, timedOut: false, signal: null };
    });

    const adapter = new SubprocessCodexAdapter(createTestConfig(), "/repo/root");
    await expect(adapter.invoke({
      role: "brain",
      model: "gpt-5.5",
      reasoningEffort: "high",
      sandbox: "read-only",
      prompt: "Plan the task",
      runDir,
      artifactName: "brain-planner",
      outputSchema: { type: "object" },
      outputParser: z.object({ ok: z.boolean() }),
    })).rejects.toThrow("Codex model catalog request failed.");
    expect(commandCalls).toHaveLength(1);
    expect(commandCalls[0]?.args).toEqual(["debug", "models"]);
  });

  it("writes structured invocation artifacts, parses the output, and passes stdin", async () => {
    runDir = await mkdtemp(join(tmpdir(), "brain-hands-codex-"));
    const output = { summary: "ready" };
    mockSuccessfulCatalogThenExec(output);

    const parser = z.object({ summary: z.string() });
    const adapter = new SubprocessCodexAdapter(createTestConfig(), "/repo/root");
    const result = await adapter.invoke({
      role: "brain",
      model: "gpt-5.5",
      reasoningEffort: "high",
      sandbox: "read-only",
      prompt: "Plan the task",
      runDir,
      artifactName: "brain-planner",
      outputSchema: { type: "object", properties: { summary: { type: "string" } } },
      outputParser: parser,
      isolateUserConfig: true,
    });

    expect(result.parsed).toEqual(output);
    expect(await readFile(join(runDir, "prompts", "brain-planner.md"), "utf8")).toBe(
      "Plan the task",
    );
    expect(await readFile(join(runDir, "schemas", "brain-planner.json"), "utf8")).toContain(
      '"summary"',
    );
  });

  it("throws a structured error containing stderr on a non-zero invocation", async () => {
    runDir = await mkdtemp(join(tmpdir(), "brain-hands-codex-"));
    mockedRunCommand.mockImplementation(async ({ args }) => {
      if (args[0] === "debug" && args[1] === "models") {
        return catalogModelsResult;
      }
      return {
        command: "codex",
        args: [],
        exitCode: 2,
        stdout: "",
        stderr: "invalid sandbox",
        failed: true,
        timedOut: false,
        signal: null,
      };
    });

    const adapter = new SubprocessCodexAdapter(createTestConfig(), "/repo/root");
    await expect(
      adapter.invoke({
        role: "hands",
        model: "gpt-5.5",
        reasoningEffort: "low",
        sandbox: "workspace-write",
        prompt: "Implement",
        runDir,
        artifactName: "hands",
        outputSchema: { type: "object" },
        outputParser: z.object({ ok: z.boolean() }),
      }),
    ).rejects.toThrow("invalid sandbox");
  });

  it("requires the output-last-message file", async () => {
    runDir = await mkdtemp(join(tmpdir(), "brain-hands-codex-"));
    await mkdir(join(runDir, "responses"), { recursive: true });
    const staleOutputPath = join(runDir, "responses", "verifier.json");
    await writeFile(staleOutputPath, '{"ok":true}', "utf8");
    mockedRunCommand.mockImplementation(async ({ args }) => {
      if (args[0] === "debug" && args[1] === "models") {
        return catalogModelsResult;
      }
      return {
        command: "codex",
        args: [],
        exitCode: 0,
        stdout: "{}",
        stderr: "",
        failed: false,
        timedOut: false,
        signal: null,
      };
    });
    const adapter = new SubprocessCodexAdapter(createTestConfig(), "/repo/root");
    await expect(
      adapter.invoke({
        role: "verifier",
        model: "gpt-5.5",
        reasoningEffort: "high",
        sandbox: "read-only",
        prompt: "Review",
        runDir,
        artifactName: "verifier",
        outputSchema: { type: "object" },
        outputParser: z.object({ ok: z.boolean() }),
      }),
    ).rejects.toThrow("Immutable Codex output evidence already exists");
    await expect(readFile(staleOutputPath, "utf8")).resolves.toBe('{"ok":true}');
  });

  it("does not reserve the output-last-message path before Codex writes it", async () => {
    runDir = await mkdtemp(join(tmpdir(), "brain-hands-codex-output-staging-"));
    mockedRunCommand.mockImplementation(async ({ args }) => {
      if (args[0] === "debug" && args[1] === "models") return catalogModelsResult;
      const outputPath = args[args.indexOf("--output-last-message") + 1]!;
      await expect(readFile(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
      await writeFile(outputPath, JSON.stringify({ ok: true }), "utf8");
      return {
        command: "codex", args, exitCode: 0, stdout: "", stderr: "",
        failed: false, timedOut: false, signal: null,
      };
    });
    const adapter = new SubprocessCodexAdapter(createTestConfig(), "/repo/root");

    await expect(adapter.invoke({
      role: "verifier",
      model: "gpt-5.5",
      reasoningEffort: "high",
      sandbox: "read-only",
      prompt: "Review",
      runDir,
      artifactName: "swapped-verifier",
      outputSchema: { type: "object" },
      outputParser: z.object({ ok: z.boolean() }),
    })).resolves.toMatchObject({ parsed: { ok: true } });
    await expect(readFile(join(runDir, "responses/swapped-verifier.json"), "utf8")).resolves.toBe('{"ok":true}');
  });

  it("uses stdin and current structured argv even for retained legacy role names", async () => {
    runDir = await mkdtemp(join(tmpdir(), "brain-hands-codex-"));
    mockSuccessfulCatalogThenExec({ ok: true });

    const adapter = new SubprocessCodexAdapter(createConfigWithCodexPatch({ prompt_transport: "file" }), "/repo/root");

    await adapter.invoke({
      role: "brain_planner",
      model: "gpt-5.5",
      reasoningEffort: "high",
      prompt: "Plan the task",
      runDir,
      artifactName: "brain-planner",
    });

    const args = mockedRunCommand.mock.calls.find((call) => call[0].args[0] === "exec")?.[0].args ?? [];
    expect(args).not.toContain("--reasoning-effort");
    expect(args).toContain("--output-last-message");
    expect(mockedRunCommand.mock.calls.find((call) => call[0].args[0] === "exec")?.[0].stdin).toBe("Plan the task");
    expect(await readFile(join(runDir, "schemas", "brain-planner.json"), "utf8")).toContain(
      '"additionalProperties": true',
    );
  });

  it("fails closed when the subprocess has no exit code", async () => {
    runDir = await mkdtemp(join(tmpdir(), "brain-hands-codex-"));
    mockedRunCommand.mockImplementation(async ({ args }) => {
      if (args[0] === "debug" && args[1] === "models") {
        return catalogModelsResult;
      }
      return {
        command: "codex",
        args: [],
        exitCode: null,
        stdout: "",
        stderr: "process terminated",
        failed: true,
        timedOut: false,
        signal: "SIGTERM",
      };
    });

    const adapter = new SubprocessCodexAdapter(createTestConfig(), "/repo/root");
    await expect(adapter.invoke({
      role: "verifier",
      model: "gpt-5.5",
      reasoningEffort: "high",
      sandbox: "read-only",
      prompt: "Review",
      runDir,
      artifactName: "verifier",
      outputSchema: { type: "object" },
      outputParser: z.object({ ok: z.boolean() }),
    })).rejects.toThrow("process terminated");
  });

  it("claims one workflow attempt and one model invocation around a structured dry-run", async () => {
    runDir = await mkdtemp(join(tmpdir(), "brain-hands-codex-budget-"));
    const budget = recordingBudget();
    const adapter = new DryRunCodexAdapter({ ok: true });

    await expect(adapter.invoke({
      role: "verifier",
      model: "gpt-5.5",
      reasoningEffort: "high",
      sandbox: "read-only",
      prompt: "Review",
      runDir,
      artifactName: "verifier-budgeted",
      budget,
      attemptKey: "verifier:1:item:work_item:1",
      outputSchema: { type: "object" },
      outputParser: z.object({ ok: z.boolean() }),
    })).resolves.toMatchObject({
      parsed: { ok: true },
      usage: {
        input_tokens: 0,
        cached_input_tokens: 0,
        output_tokens: 0,
        reasoning_output_tokens: 0,
      },
    });

    expect(budget.claims[0]).toMatchObject({
      kind: "workflow_attempt",
      key: "verifier:1:item:work_item:1",
      elapsed_reservation_ms: 0,
    });
    expect(budget.claims[1]).toMatchObject({
      kind: "model_invocation",
      elapsed_reservation_ms: 1_234,
    });
    expect(budget.claims[1]!.key).toMatch(/^verifier-budgeted:invocation:[0-9a-f-]{36}$/);
    expect(budget.completions).toHaveLength(1);
    expect(budget.completions[0]).toMatchObject({
      claim_id: budget.claims[1]!.claim_id,
      outcome: "succeeded",
      duration_ms: 0,
      process_started: false,
      turn_started: false,
      structured_terminal_error: false,
      token_usage: {
        input_tokens: 0,
        cached_input_tokens: 0,
        output_tokens: 0,
        reasoning_output_tokens: 0,
      },
    });
  });

  it("completes a budgeted model invocation when Codex exits with an invocation error", async () => {
    runDir = await mkdtemp(join(tmpdir(), "brain-hands-codex-budget-error-"));
    const budget = recordingBudget();
    mockedRunCommand.mockImplementation(async ({ args, onStarted }) => {
      if (args[0] === "debug" && args[1] === "models") return catalogModelsResult;
      onStarted?.({ pid: 123 });
      return {
        command: "codex",
        args: [],
        exitCode: 1,
        stdout: "",
        stderr: "model failed",
        failed: true,
        timedOut: false,
        signal: null,
      };
    });
    const adapter = new SubprocessCodexAdapter(createTestConfig(), "/repo/root");

    await expect(adapter.invoke({
      role: "verifier",
      model: "gpt-5.5",
      reasoningEffort: "high",
      sandbox: "read-only",
      prompt: "Review",
      runDir,
      artifactName: "verifier-budgeted-error",
      budget,
      outputSchema: { type: "object" },
      outputParser: z.object({ ok: z.boolean() }),
    })).rejects.toThrow(CodexInvocationError);

    expect(budget.claims).toHaveLength(1);
    expect(budget.claims[0]).toMatchObject({ kind: "model_invocation" });
    expect(budget.claims[0]!.key).toMatch(/^verifier-budgeted-error:invocation:[0-9a-f-]{36}$/);
    expect(budget.completions).toHaveLength(1);
    expect(budget.completions[0]).toMatchObject({
      claim_id: budget.claims[0]!.claim_id,
      outcome: "failed",
      process_started: true,
      token_usage: null,
    });
  });

  it("does not invoke Codex when the budget rejects a model invocation claim", async () => {
    runDir = await mkdtemp(join(tmpdir(), "brain-hands-codex-budget-reject-"));
    const budget = recordingBudget({ rejectModelInvocation: true });
    const adapter = new SubprocessCodexAdapter(createTestConfig(), "/repo/root");

    await expect(adapter.invoke({
      role: "verifier",
      model: "gpt-5.5",
      reasoningEffort: "high",
      sandbox: "read-only",
      prompt: "Review",
      runDir,
      artifactName: "verifier-budget-rejected",
      budget,
      outputSchema: { type: "object" },
      outputParser: z.object({ ok: z.boolean() }),
    })).rejects.toThrow("budget exhausted before model invocation");

    expect(mockedRunCommand).not.toHaveBeenCalled();
    expect(budget.completions).toEqual([]);
  });

  it("preserves metrics when final output evidence appears after Codex already ran", async () => {
    runDir = await mkdtemp(join(tmpdir(), "brain-hands-codex-budget-output-race-"));
    const budget = recordingBudget();
    mockedRunCommand.mockImplementation(async ({ args, onStarted }) => {
      if (args[0] === "debug" && args[1] === "models") return catalogModelsResult;
      onStarted?.({ pid: 456 });
      const outputPath = args[args.indexOf("--output-last-message") + 1]!;
      await writeFile(outputPath, JSON.stringify({ ok: true }), "utf8");
      await mkdir(join(runDir!, "responses"), { recursive: true });
      await writeFile(join(runDir!, "responses", "verifier-race.json"), '{"stale":true}', "utf8");
      return {
        command: "codex",
        args,
        exitCode: 0,
        stdout: "",
        stderr: "",
        failed: false,
        timedOut: false,
        signal: null,
      };
    });
    const adapter = new SubprocessCodexAdapter(createTestConfig(), "/repo/root");

    await expect(adapter.invoke({
      role: "verifier",
      model: "gpt-5.5",
      reasoningEffort: "high",
      sandbox: "read-only",
      prompt: "Review",
      runDir,
      artifactName: "verifier-race",
      budget,
      outputSchema: { type: "object" },
      outputParser: z.object({ ok: z.boolean() }),
    })).rejects.toThrow("Immutable Codex output evidence already exists");

    expect(budget.completions).toHaveLength(1);
    expect(budget.completions[0]).toMatchObject({
      outcome: "failed",
      process_started: true,
      token_usage: null,
    });
  });
});
