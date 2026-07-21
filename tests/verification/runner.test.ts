import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("../../src/core/executor.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/core/executor.js")>();
  return { ...actual, runCommand: vi.fn(actual.runCommand) };
});
import { runVerification } from "../../src/verification/runner.js";
import { runCommand } from "../../src/core/executor.js";
import { verificationEvidencePath, verificationIdentityDirectory } from "../../src/core/types.js";
import type { BrowserCheckSpec } from "../../src/core/types.js";
import { openProgressReporter, readProgressEvents } from "../../src/progress/log.js";
import type {
  ResourceBudgetClaimInput,
  ResourceBudgetClaimV1,
  ResourceBudgetCompletionInput,
  ResourceBudgetPort,
  ResourceBudgetUsage,
} from "../../src/core/resource-budget.js";

let runDir: string | null = null;
const mockedRunCommand = vi.mocked(runCommand);

function githubIdentity(issueNumber: number) {
  return { scope: "github" as const, work_item_id: `BH-${issueNumber}`, issue_number: issueNumber };
}

function recordingBudget(options: { remaining?: number; reject?: boolean } = {}): ResourceBudgetPort & {
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
    remainingActiveElapsedMs: async () => options.remaining ?? 1_000,
    claim: async (input: ResourceBudgetClaimInput) => {
      if (options.reject) throw new Error("verification budget exhausted");
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
      return { schema_version: 1, completed_at: "2026-07-17T00:00:01.000Z", ...input };
    },
    runWorkflowAttempt: async (_key, action) => action(),
  };
}

afterEach(async () => {
  mockedRunCommand.mockClear();
  if (runDir) {
    await rm(runDir, { recursive: true, force: true });
    runDir = null;
  }
});

describe("runVerification", () => {
  it("uses collision-free local identities and a dedicated integrated namespace", async () => {
    runDir = await mkdtemp(join(tmpdir(), "brain-hands-verification-"));
    const local = await runVerification({
      repoRoot: process.cwd(),
      runDir,
      mode: "local",
      identity: { scope: "local", work_item_id: "BH/008" },
      commands: [[process.execPath, "-e", "process.stdout.write('local')"]],
    });
    expect(local.evidence_path).toBe(verificationEvidencePath({ scope: "local", work_item_id: "BH/008" }, 1));
    expect(local).not.toHaveProperty("issue_number");
    expect(local.commands[0].stdout_path).toContain("verification/local/");

    const integrated = await runVerification({
      repoRoot: process.cwd(),
      runDir,
      identity: { scope: "integrated", work_item_id: "integrated" },
      commands: [[process.execPath, "-e", "process.stdout.write('integrated')"]],
    });
    expect(integrated.evidence_path).toBe("verification/integrated/attempt-1/evidence.json");
    expect(integrated.commands[0].stdout_path).toContain("verification/integrated/attempt-1/");
  });

  it("exposes the verification phase and controller-owned browser report path", async () => {
    runDir = await mkdtemp(join(tmpdir(), "brain-hands-verification-"));
    const evidence = await runVerification({
      repoRoot: process.cwd(),
      runDir,
      identity: { scope: "local", work_item_id: "browser-proof" },
      phase: "post_pr",
      commands: [[process.execPath, "-e", "process.stdout.write(JSON.stringify({phase:process.env.BRAIN_HANDS_VERIFICATION_PHASE,report:process.env.BRAIN_HANDS_BROWSER_EVIDENCE_REPORT}))"]],
      browserChecks: [{
        name: "desktop",
        url: "http://127.0.0.1:4173/",
        local_server_command: "npx vite preview --host 127.0.0.1 --port 4173",
        required_selectors: ["#app"],
        console_error_policy: "no_errors",
        expected_network: [],
        screenshot_artifact: "artifacts/desktop.png",
      }],
    });
    const commandOutput = JSON.parse(await readFile(join(runDir, evidence.commands[0]!.stdout_path), "utf8"));

    expect(commandOutput).toEqual({
      phase: "post_pr",
      report: join(runDir, "verification/local/YnJvd3Nlci1wcm9vZg/attempt-1/browser-evidence.json"),
    });
  });

  it("rejects issue-number-only run-scoped calls before writing", async () => {
    runDir = await mkdtemp(join(tmpdir(), "brain-hands-verification-"));
    await expect(runVerification({
      repoRoot: process.cwd(),
      runDir,
      issueNumber: 7,
      commands: [[process.execPath, "-e", "process.stdout.write('must not run')"]],
    } as never)).rejects.toThrow(/durable identity/i);
    await expect(readFile(join(runDir, "verification/issue-7/evidence.json"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    { label: "mapped GitHub", identity: githubIdentity(8) },
    { label: "local", identity: { scope: "local" as const, work_item_id: "BH/008" } },
    { label: "integrated", identity: { scope: "integrated" as const, work_item_id: "integrated" as const } },
  ])("fails closed when the $label verification target is already contaminated", async ({ identity }) => {
    runDir = await mkdtemp(join(tmpdir(), "brain-hands-verification-"));
    const target = join(runDir, verificationIdentityDirectory(identity), "attempt-1");
    await mkdir(target, { recursive: true });
    const sentinelPath = join(target, "evidence.json");
    const commandSentinelPath = join(target, "command-1.stdout.txt");
    const sentinel = JSON.stringify({ verification_scope: "foreign", work_item_id: "foreign" });
    const commandSentinel = "foreign command sentinel\n";
    await writeFile(sentinelPath, sentinel, "utf8");
    await writeFile(commandSentinelPath, commandSentinel, "utf8");

    await expect(runVerification({
      repoRoot: process.cwd(),
      runDir,
      identity,
      commands: [[process.execPath, "-e", "process.stdout.write('must not run')"]],
    })).rejects.toThrow(/already contains artifacts/i);
    expect(await readFile(sentinelPath, "utf8")).toBe(sentinel);
    expect(await readFile(commandSentinelPath, "utf8")).toBe(commandSentinel);
    expect(await readdir(target)).toEqual(["command-1.stdout.txt", "evidence.json"]);
  });

  it("rejects a later attempt when an earlier attempt declares a foreign identity", async () => {
    runDir = await mkdtemp(join(tmpdir(), "brain-hands-verification-"));
    const target = join(runDir, "verification/issue-8/attempt-1");
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "evidence.json"), `${JSON.stringify({
      verification_scope: "github",
      work_item_id: "BH-999",
      issue_number: 999,
      attempt: 1,
      evidence_path: "verification/issue-8/attempt-1/evidence.json",
      commands: [{
        command: "true",
        argv: ["true"],
        exit_code: 0,
        timed_out: false,
        error_code: null,
        error_message: null,
        signal: null,
        stdout_path: "verification/issue-8/attempt-1/command-1.stdout.txt",
        stderr_path: "verification/issue-8/attempt-1/command-1.stderr.txt",
        result_path: "verification/issue-8/attempt-1/command-1.json",
      }],
      artifacts: [],
      artifact_checks: [],
      browser_evidence: [],
      created_at: new Date().toISOString(),
    })}\n`, "utf8");

    await expect(runVerification({
      repoRoot: process.cwd(),
      runDir,
      identity: githubIdentity(8),
      attempt: 2,
      commands: [[process.execPath, "-e", "process.stdout.write('must not run')"]],
    })).rejects.toThrow(/different identity|provenance/i);
    await expect(readFile(join(runDir, "verification/issue-8/attempt-2/evidence.json"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("emits safe command progress before completion and records evidence last", async () => {
    runDir = await mkdtemp(join(tmpdir(), "brain-hands-verification-"));
    await writeFile(join(runDir, "progress.jsonl"), "", "utf8");
    const rendered: string[] = [];
    const progress = await openProgressReporter({ runDir, onEvent: (event) => { rendered.push(event.safe_label); } });
    let settled = false;
    const running = runVerification({
      repoRoot: process.cwd(), runDir, identity: githubIdentity(1), attempt: 1,
      commands: [[process.execPath, "-e", "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,200)"]],
      progress,
      progressContext: { workItem: { index: 1, total: 1, attempt: 1, final: false } },
    }).finally(() => { settled = true; });
    for (let attempt = 0; attempt < 20 && rendered.length < 2; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(rendered).toContain("Verification 1 of 1 - running node");
    expect(settled).toBe(false);
    await running;
    const labels: string[] = [];
    for await (const event of readProgressEvents(runDir)) labels.push(event.safe_label);
    expect(labels.at(-1)).toBe("Verification evidence recorded");
    expect(JSON.stringify(labels)).not.toContain("sk-secret");
  });

  it("stores stdout, stderr, and evidence JSON", async () => {
    runDir = await mkdtemp(join(tmpdir(), "brain-hands-verification-"));

    const evidence = await runVerification({
      repoRoot: process.cwd(),
      runDir,
      identity: githubIdentity(12),
      commands: [`${process.execPath} -e "console.log('verified')"`],
    });

    const output = await readFile(
      join(runDir, evidence.commands[0].stdout_path),
      "utf8",
    );
    const error = await readFile(
      join(runDir, evidence.commands[0].stderr_path),
      "utf8",
    );
    const evidenceJson = await readFile(join(runDir, "verification/issue-12/attempt-1/evidence.json"), "utf8");
    const parsedEvidence = JSON.parse(evidenceJson) as Record<string, unknown>;

    expect(evidence.issue_number).toBe(12);
    expect(output.trim()).toBe("verified");
    expect(error).toBe("");
    expect(parsedEvidence.issue_number).toBe(12);
    expect(Array.isArray(parsedEvidence.commands)).toBe(true);
    expect(evidence.commands[0].timed_out).toBe(false);
    expect(evidence.commands[0].error_code).toBeNull();
    expect(evidence.commands[0].error_message).toBeNull();
    expect(evidence.commands[0].signal).toBeNull();
  });

  it("stops after persisting the first failed command when fail-fast is enabled", async () => {
    runDir = await mkdtemp(join(tmpdir(), "brain-hands-verification-"));
    const marker = join(runDir, "later-command.txt");

    const evidence = await runVerification({
      repoRoot: process.cwd(),
      runDir,
      identity: githubIdentity(24),
      commands: [
        [process.execPath, "-e", "process.stdout.write('failed-out'),process.stderr.write('failed-err'),process.exit(1)"],
        [process.execPath, "-e", `require("node:fs").appendFileSync(${JSON.stringify(marker)}, "ran")`],
      ],
      stopOnFailure: true,
    });

    expect(evidence.commands).toHaveLength(1);
    expect(await readFile(join(runDir, evidence.commands[0].stdout_path), "utf8")).toBe("failed-out");
    expect(await readFile(join(runDir, evidence.commands[0].stderr_path), "utf8")).toBe("failed-err");
    const result = JSON.parse(await readFile(join(runDir, evidence.commands[0].result_path!), "utf8"));
    expect(result).toMatchObject({ exit_code: 1, timed_out: false });
    await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("runs all commands after a failure when fail-fast is absent", async () => {
    runDir = await mkdtemp(join(tmpdir(), "brain-hands-verification-"));
    const marker = join(runDir, "later-command.txt");

    const evidence = await runVerification({
      repoRoot: process.cwd(),
      runDir,
      identity: githubIdentity(25),
      commands: [
        [process.execPath, "-e", "process.exit(1)"],
        [process.execPath, "-e", `require("node:fs").appendFileSync(${JSON.stringify(marker)}, "ran")`],
      ],
    });

    expect(evidence.commands).toHaveLength(2);
    expect(await readFile(marker, "utf8")).toBe("ran");
  });

  it("stops after persisting an unstartable command when fail-fast is enabled", async () => {
    runDir = await mkdtemp(join(tmpdir(), "brain-hands-verification-"));
    const marker = join(runDir, "later-command.txt");

    const evidence = await runVerification({
      repoRoot: process.cwd(),
      runDir,
      identity: githubIdentity(32),
      commands: [
        ["definitely-missing-verification-command"],
        [process.execPath, "-e", `require("node:fs").appendFileSync(${JSON.stringify(marker)}, "ran")`],
      ],
      stopOnFailure: true,
    });

    expect(evidence.commands).toHaveLength(1);
    expect(evidence.commands[0]).toMatchObject({ exit_code: null, timed_out: false });
    expect(evidence.commands[0].error_code).toBeDefined();
    expect(await readFile(join(runDir, evidence.commands[0].stdout_path), "utf8")).toBe("");
    expect(await readFile(join(runDir, evidence.commands[0].stderr_path), "utf8")).toEqual(expect.any(String));
    const result = JSON.parse(await readFile(join(runDir, evidence.commands[0].result_path!), "utf8"));
    expect(result).toMatchObject({ exit_code: null, timed_out: false });
    await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("stops after persisting a timed-out command when fail-fast is enabled", async () => {
    runDir = await mkdtemp(join(tmpdir(), "brain-hands-verification-"));
    const marker = join(runDir, "later-command.txt");
    const timeoutScript = "process.stdout.write('partial'),Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1000)";
    mockedRunCommand.mockResolvedValueOnce({
      command: process.execPath,
      args: ["-e", timeoutScript],
      exitCode: 0,
      stdout: "partial",
      stderr: "timed out",
      failed: true,
      timedOut: true,
      errorCode: "ETIMEDOUT",
      errorMessage: "Command timed out",
      signal: "SIGTERM",
    });

    const evidence = await runVerification({
      repoRoot: process.cwd(),
      runDir,
      identity: githubIdentity(33),
      commands: [
        [process.execPath, "-e", timeoutScript],
        [process.execPath, "-e", `require("node:fs").appendFileSync(${JSON.stringify(marker)}, "ran")`],
      ],
      stopOnFailure: true,
    });

    expect(evidence.commands).toHaveLength(1);
    expect(evidence.commands[0]).toMatchObject({ exit_code: 0, timed_out: true });
    expect(await readFile(join(runDir, evidence.commands[0].stdout_path), "utf8")).toBe("partial");
    expect(await readFile(join(runDir, evidence.commands[0].stderr_path), "utf8")).toBe("timed out");
    const result = JSON.parse(await readFile(join(runDir, evidence.commands[0].result_path!), "utf8"));
    expect(result).toMatchObject({ exit_code: 0, timed_out: true, error_code: "ETIMEDOUT", signal: "SIGTERM" });
    await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("runs direct argv and persists complete JSON result metadata", async () => {
    runDir = await mkdtemp(join(tmpdir(), "brain-hands-verification-"));

    const evidence = await runVerification({
      repoRoot: process.cwd(),
      runDir,
      identity: githubIdentity(26),
      commands: [[process.execPath, "-e", "process.stdout.write('argv-out'),process.stderr.write('argv-err')"]],
    });

    const command = evidence.commands[0];
    expect(command.argv).toEqual([
      process.execPath,
      "-e",
      "process.stdout.write('argv-out'),process.stderr.write('argv-err')",
    ]);
    expect(command.result_path).toBe("verification/issue-26/attempt-1/command-1.json");
    expect(command.duration_ms).toEqual(expect.any(Number));
    const result = JSON.parse(await readFile(join(runDir, command.result_path!), "utf8")) as Record<string, unknown>;
    expect(result).toMatchObject({
      stdout: "argv-out",
      stderr: "argv-err",
      exit_code: 0,
    });
    expect(result.duration_ms).toEqual(expect.any(Number));
    expect(result.timed_out).toBe(false);
  });

  it("budgets each verification command with the approved command id", async () => {
    runDir = await mkdtemp(join(tmpdir(), "brain-hands-verification-budget-"));
    const budget = recordingBudget({ remaining: 123 });

    await runVerification({
      repoRoot: process.cwd(),
      runDir,
      identity: { scope: "local", work_item_id: "BH-030" },
      mode: "local",
      attempt: 2,
      commands: [[process.execPath, "-e", "process.stdout.write('budgeted')"]],
      commandIds: ["CMD-1"],
      budget,
    });

    expect(budget.claims.map(({ kind, key, elapsed_reservation_ms }) => ({ kind, key, elapsed_reservation_ms }))).toEqual([
      { kind: "verification_command", key: "verification:local:BH-030:2:CMD-1", elapsed_reservation_ms: 123 },
    ]);
    expect(budget.completions).toHaveLength(1);
    expect(budget.completions[0]).toMatchObject({
      claim_id: budget.claims[0]!.claim_id,
      outcome: "succeeded",
      process_started: true,
      turn_started: false,
      structured_terminal_error: false,
      token_usage: null,
    });
  });

  it("does not run verification commands when elapsed budget is exhausted", async () => {
    runDir = await mkdtemp(join(tmpdir(), "brain-hands-verification-budget-block-"));
    const marker = join(runDir, "should-not-exist.txt");
    const budget = recordingBudget({ reject: true });

    await expect(runVerification({
      repoRoot: process.cwd(),
      runDir,
      identity: { scope: "local", work_item_id: "BH-031" },
      mode: "local",
      commands: [[process.execPath, "-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`]],
      commandIds: ["CMD-1"],
      budget,
    })).rejects.toThrow("verification budget exhausted");

    await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(budget.completions).toEqual([]);
  });

  it("keeps retry command and evidence artifacts in an attempt-specific directory", async () => {
    runDir = await mkdtemp(join(tmpdir(), "brain-hands-verification-"));

    const evidence = await runVerification({
      repoRoot: process.cwd(),
      runDir,
      identity: githubIdentity(27),
      attempt: 2,
      commands: [[process.execPath, "-e", "process.stdout.write('retry')"]],
    });

    expect(evidence.evidence_path).toBe("verification/issue-27/attempt-2/evidence.json");
    expect(evidence.commands[0].stdout_path).toBe(
      "verification/issue-27/attempt-2/command-1.stdout.txt",
    );
    expect(await readFile(join(runDir, evidence.evidence_path!), "utf8")).toContain('"issue_number": 27');
  });

  it("keeps mutation and self-review verification artifacts under distinct durable identities", async () => {
    runDir = await mkdtemp(join(tmpdir(), "brain-hands-verification-"));
    const namespaces = ["mutation", "self-review-pass-1", "self-review-pass-2"];

    const evidence = await Promise.all(namespaces.map((artifactNamespace) => runVerification({
      repoRoot: process.cwd(),
      runDir: runDir!,
      identity: { scope: "local", work_item_id: `BH-28:${artifactNamespace}` },
      attempt: 1,
      commands: [[process.execPath, "-e", `process.stdout.write('${artifactNamespace}')`]],
    })));

    expect(new Set(evidence.map((entry) => entry.evidence_path)).size).toBe(namespaces.length);
    for (const [index, artifactNamespace] of namespaces.entries()) {
      const current = evidence[index]!;
      expect(current.commands[0].stdout_path).toContain("/attempt-1/");
      expect(await readFile(join(runDir, current.commands[0].stdout_path), "utf8")).toBe(artifactNamespace);
      await expect(readFile(join(runDir, current.evidence_path!), "utf8")).resolves.toContain(`"attempt": 1`);
    }
  });

  it("refuses to overwrite an already persisted verification namespace", async () => {
    runDir = await mkdtemp(join(tmpdir(), "brain-hands-verification-"));
    const counterPath = join(runDir, "counter.txt");
    const increment = `require('node:fs').appendFileSync(${JSON.stringify(counterPath)}, 'x')`;
    const input = {
      repoRoot: process.cwd(),
      runDir,
      identity: githubIdentity(29),
      attempt: 1,
    };
    const first = await runVerification({ ...input, commands: [[process.execPath, "-e", increment]] });

    await expect(runVerification({ ...input, commands: [[process.execPath, "-e", increment]] }))
      .rejects.toThrow(/already contains artifacts/i);
    expect(await readFile(counterPath, "utf8")).toBe("x");
    expect(await readFile(join(runDir, first.evidence_path!), "utf8")).toContain('"issue_number": 29');
  });

  it("resumes after a completed command without executing that command twice", async () => {
    runDir = await mkdtemp(join(tmpdir(), "brain-hands-verification-"));
    const input = {
      repoRoot: process.cwd(),
      runDir,
      identity: githubIdentity(34),
      attempt: 1,
      commands: [
        [process.execPath, "-e", "process.stdout.write('first')"],
        [process.execPath, "-e", "process.stdout.write('second')"],
      ],
    };
    mockedRunCommand
      .mockResolvedValueOnce({
        command: process.execPath, args: ["-e", "process.stdout.write('first')"],
        exitCode: 0, stdout: "first", stderr: "", failed: false, timedOut: false,
      })
      .mockRejectedValueOnce(new Error("controller interrupted"));

    await expect(runVerification(input)).rejects.toThrow("controller interrupted");
    mockedRunCommand.mockClear();
    mockedRunCommand.mockResolvedValueOnce({
      command: process.execPath, args: ["-e", "process.stdout.write('second')"],
      exitCode: 0, stdout: "second", stderr: "", failed: false, timedOut: false,
    });

    const resumed = await runVerification({ ...input, resumeExistingNamespace: true });

    expect(mockedRunCommand).toHaveBeenCalledTimes(1);
    expect(resumed.commands.map((command) => command.stdout_path)).toEqual([
      "verification/issue-34/attempt-1/command-1.stdout.txt",
      "verification/issue-34/attempt-1/command-2.stdout.txt",
    ]);
    expect(await readFile(join(runDir, resumed.commands[0]!.stdout_path), "utf8")).toBe("first");
    expect(await readFile(join(runDir, resumed.commands[1]!.stdout_path), "utf8")).toBe("second");
  });

  it("pre-authorizes a command-produced browser report and adopts it on resume", async () => {
    runDir = await mkdtemp(join(tmpdir(), "brain-hands-verification-"));
    const priorReportPath = "verification/issue-2/attempt-29/browser-evidence.json";
    const check: BrowserCheckSpec = {
      name: "desktop",
      url: "http://127.0.0.1:4173/",
      local_server_command: "npx vite preview --host 127.0.0.1 --port 4173",
      required_selectors: ["#app"],
      console_error_policy: "no_errors",
      expected_network: [],
      screenshot_artifact: "artifacts/desktop.png",
    };
    const input = {
      repoRoot: process.cwd(),
      runDir,
      identity: { scope: "local" as const, work_item_id: "browser-proof" },
      attempt: 1,
      commands: [[process.execPath, "first"], [process.execPath, "second"]],
      expectedArtifacts: [priorReportPath],
      browserChecks: [check],
    };
    await mkdir(join(runDir, "verification/issue-2/attempt-29"), { recursive: true });
    await writeFile(join(runDir, priorReportPath), `${JSON.stringify({
      generated_at: "2026-07-20T00:00:00.000Z",
      status: "failed",
      reports: [{
        check_name: check.name,
        url: check.url,
        status: "failed",
        observed_selectors: [],
        missing_selectors: check.required_selectors,
        console_errors: [],
        expected_network: [],
        observed_network: [],
        screenshot_artifact: check.screenshot_artifact,
        console_error_policy: check.console_error_policy,
        failure_reasons: ["stale report"],
        skipped_reason: null,
      }],
    })}\n`);
    mockedRunCommand.mockImplementationOnce(async (command) => {
      const reportPath = command.env?.BRAIN_HANDS_BROWSER_EVIDENCE_REPORT;
      if (!reportPath) throw new Error("browser report path missing");
      await writeFile(reportPath, `${JSON.stringify({
        generated_at: "2026-07-21T00:00:00.000Z",
        status: "passed",
        reports: [{
          check_name: check.name,
          url: check.url,
          status: "passed",
          observed_selectors: check.required_selectors,
          missing_selectors: [],
          console_errors: [],
          expected_network: [],
          observed_network: [],
          screenshot_artifact: check.screenshot_artifact,
          console_error_policy: check.console_error_policy,
          failure_reasons: [],
          skipped_reason: null,
        }],
      })}\n`);
      return { command: process.execPath, args: ["first"], exitCode: 0, stdout: "first", stderr: "", failed: false, timedOut: false };
    }).mockRejectedValueOnce(new Error("controller interrupted"));

    await expect(runVerification(input)).rejects.toThrow("controller interrupted");
    mockedRunCommand.mockClear();
    mockedRunCommand.mockResolvedValueOnce({
      command: process.execPath, args: ["second"], exitCode: 0, stdout: "second", stderr: "", failed: false, timedOut: false,
    });

    const resumed = await runVerification({ ...input, resumeExistingNamespace: true });

    expect(mockedRunCommand).toHaveBeenCalledTimes(1);
    expect(resumed.commands).toHaveLength(2);
    expect(resumed.browser_evidence[0]?.evidence_report_path)
      .toBe("verification/local/YnJvd3Nlci1wcm9vZg/attempt-1/browser-evidence.json");

    mockedRunCommand.mockClear();
    const replayed = await runVerification({ ...input, resumeExistingNamespace: true });
    expect(mockedRunCommand).not.toHaveBeenCalled();
    expect(replayed).toEqual(resumed);
  });

  it("rejects undeclared artifacts in an in-progress durable namespace before running commands", async () => {
    runDir = await mkdtemp(join(tmpdir(), "brain-hands-verification-"));
    const counterPath = join(runDir, "counter.txt");
    const prefix = "verification/issue-30/attempt-1";
    await mkdir(join(runDir, prefix), { recursive: true });
    await writeFile(join(runDir, prefix, "identity.json"), `${JSON.stringify({ verification_scope: "github", work_item_id: "BH-30", issue_number: 30, attempt: 1, artifact_paths: [] })}\n`, "utf8");
    await writeFile(join(runDir, prefix, "command-1.stdout.txt"), "collision", "utf8");
    const input = {
      repoRoot: process.cwd(),
      runDir,
      identity: githubIdentity(30),
      attempt: 1,
      commands: [[process.execPath, "-e", `require('node:fs').appendFileSync(${JSON.stringify(counterPath)}, 'x')`]],
    };

    await expect(runVerification(input)).rejects.toThrow(/undeclared in-progress artifacts/i);
    await expect(readFile(counterPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["evidence", "result", "path"] as const)(
    "blocks corrupt completed namespace %s with zero command executions",
    async (corruption) => {
      runDir = await mkdtemp(join(tmpdir(), "brain-hands-verification-"));
      const counterPath = join(runDir, "counter.txt");
      const input = {
        repoRoot: process.cwd(), runDir, identity: githubIdentity(31), attempt: 2,
        commands: [[process.execPath, "-e", `require('node:fs').appendFileSync(${JSON.stringify(counterPath)}, 'x')`]],
      };
      const completed = await runVerification(input);
      if (corruption === "evidence" || corruption === "path") {
        const evidence = JSON.parse(await readFile(join(runDir, completed.evidence_path!), "utf8")) as any;
        if (corruption === "evidence") evidence.issue_number = 99;
        else {
          evidence.commands[0].stdout_path = "../outside.txt";
          evidence.artifact_checks = [{ path: "../repo-escape", exists: true, required: true }];
        }
        await writeFile(join(runDir, completed.evidence_path!), JSON.stringify(evidence), "utf8");
      } else {
        const resultPath = completed.commands[0].result_path!;
        const result = JSON.parse(await readFile(join(runDir, resultPath), "utf8"));
        result.stdout = "tampered";
        await writeFile(join(runDir, resultPath), JSON.stringify(result), "utf8");
      }

      await expect(runVerification({ ...input, resumeExistingNamespace: true })).rejects.toThrow();
      expect(await readFile(counterPath, "utf8")).toBe("x");
    },
  );

  it("preserves failure metadata when a command cannot be started", async () => {
    runDir = await mkdtemp(join(tmpdir(), "brain-hands-verification-"));

    const evidence = await runVerification({
      repoRoot: process.cwd(),
      runDir,
      identity: githubIdentity(13),
      commands: ["definitely-missing-verification-command"],
    });

    expect(evidence.commands).toHaveLength(1);
    expect(evidence.commands[0].exit_code).toBeNull();
    expect(evidence.commands[0].timed_out).toBe(false);
    expect(evidence.commands[0].error_code).toBeDefined();
    expect(evidence.commands[0].error_message).toBeDefined();
  });

  it("records expected artifact existence", async () => {
    runDir = await mkdtemp(join(tmpdir(), "brain-hands-verification-"));
    const repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-repo-"));
    await writeFile(join(repoRoot, "present.txt"), "present\n", "utf8");

    try {
      const evidence = await runVerification({
        repoRoot,
        runDir,
        identity: githubIdentity(20),
        commands: [`${process.execPath} -e "console.log('verified')"`],
        expectedArtifacts: ["present.txt", "missing.txt"],
      });

      expect(evidence.artifacts).toEqual(["present.txt"]);
      expect(evidence.artifact_checks).toEqual([
        { path: "present.txt", exists: true, required: true },
        { path: "missing.txt", exists: false, required: true },
      ]);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it.each([
    {
      label: "safe expected_artifacts",
      repoAction: async (repoRoot: string) => {
        await writeFile(join(repoRoot, "present.txt"), "present\n", "utf8");
      },
      expectedArtifacts: ["present.txt"],
      browserChecks: [] as BrowserCheckSpec[],
      issueNumber: 29,
    },
    {
      label: "safe browser screenshots",
      repoAction: async (repoRoot: string) => {
        await mkdir(join(repoRoot, "reports"), { recursive: true });
        await writeFile(join(repoRoot, "reports", "browser.png"), "png\n", "utf8");
      },
      expectedArtifacts: [],
      browserChecks: [{
        name: "desktop smoke",
        url: "https://example.com/",
        local_server_command: "npm run dev",
        required_selectors: ["#app"],
        console_error_policy: "no_errors",
        expected_network: [],
        screenshot_artifact: "reports/browser.png",
      }] as BrowserCheckSpec[],
      issueNumber: 30,
    },
  ])("accepts portable verification artifact paths for %s", async ({ repoAction, expectedArtifacts, browserChecks, issueNumber }) => {
    runDir = await mkdtemp(join(tmpdir(), "brain-hands-verification-"));
    const repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-repo-"));
    try {
      await repoAction(repoRoot);
      const evidence = await runVerification({
        repoRoot,
        runDir,
        identity: githubIdentity(issueNumber),
        commands: [`${process.execPath} -e "console.log('verified')"`],
        expectedArtifacts,
        browserChecks,
      });

      expect(evidence.issue_number).toBe(issueNumber);
      expect(evidence.commands).toHaveLength(1);
      if (browserChecks.length > 0) {
        expect(evidence.browser_evidence[0]?.screenshot_artifact).toBe(
          `verification/issue-${issueNumber}/attempt-1/reports/browser.png`,
        );
      }
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("keeps missing browser artifacts inside the verification identity", async () => {
    runDir = await mkdtemp(join(tmpdir(), "brain-hands-verification-"));
    const repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-repo-"));
    try {
      const evidence = await runVerification({
        repoRoot,
        runDir,
        identity: githubIdentity(33),
        commands: [[process.execPath, "-e", "process.exit(1)"]],
        browserChecks: [{
          name: "failed browser check",
          url: "http://127.0.0.1:5177/",
          local_server_command: "npm run dev",
          required_selectors: ["#app"],
          console_error_policy: "no_errors",
          expected_network: [],
          screenshot_artifact: "artifacts/playwright/missing.png",
        }],
      });

      expect(evidence.browser_evidence[0]).toMatchObject({
        status: "failed",
        screenshot_exists: false,
        screenshot_artifact: "verification/issue-33/attempt-1/artifacts/playwright/missing.png",
      });
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it.each([
    {
      label: "prose expected artifact entry",
      expectedArtifacts: ["Passing schema contract tests"],
      browserChecks: [] as BrowserCheckSpec[],
      issueNumber: 31,
    },
    {
      label: "unsafe browser screenshot",
      expectedArtifacts: [],
      browserChecks: [{
        name: "desktop smoke",
        url: "https://example.com/",
        local_server_command: "npm run dev",
        required_selectors: ["#app"],
        console_error_policy: "no_errors",
        expected_network: [],
        screenshot_artifact: "reports\\browser.png",
      }] as BrowserCheckSpec[],
      issueNumber: 32,
    },
    {
      label: "empty artifact segment",
      expectedArtifacts: ["reports//result.json"],
      browserChecks: [] as BrowserCheckSpec[],
      issueNumber: 33,
    },
    {
      label: "whitespace artifact",
      expectedArtifacts: ["result file.json"],
      browserChecks: [] as BrowserCheckSpec[],
      issueNumber: 34,
    },
    {
      label: "absolute artifact path",
      expectedArtifacts: ["/tmp/result.json"],
      browserChecks: [] as BrowserCheckSpec[],
      issueNumber: 35,
    },
    {
      label: "unsafe browser screenshot whitespace",
      expectedArtifacts: [],
      browserChecks: [{
        name: "desktop smoke",
        url: "https://example.com/",
        local_server_command: "npm run dev",
        required_selectors: ["#app"],
        console_error_policy: "no_errors",
        expected_network: [],
        screenshot_artifact: "reports/my artifact.png",
      }] as BrowserCheckSpec[],
      issueNumber: 36,
    },
    {
      label: "unsafe browser screenshot URL",
      expectedArtifacts: [],
      browserChecks: [{
        name: "desktop smoke",
        url: "https://example.com/",
        local_server_command: "npm run dev",
        required_selectors: ["#app"],
        console_error_policy: "no_errors",
        expected_network: [],
        screenshot_artifact: "https://example.com/browser.png",
      }] as BrowserCheckSpec[],
      issueNumber: 37,
    },
  ])("rejects malformed artifact paths for $label before command execution", async ({ expectedArtifacts, browserChecks, issueNumber }) => {
    runDir = await mkdtemp(join(tmpdir(), "brain-hands-verification-"));
    const repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-repo-"));
    try {
      await expect(
        runVerification({
          repoRoot,
          runDir,
          identity: githubIdentity(issueNumber),
          commands: [`${process.execPath} -e "console.log('verified')"`],
          expectedArtifacts,
          browserChecks,
        }),
      ).rejects.toThrow();
      await expect(
        readFile(join(runDir, `verification/issue-${issueNumber}/evidence.json`), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("validates browser checks against aggregate browser evidence reports", async () => {
    runDir = await mkdtemp(join(tmpdir(), "brain-hands-verification-"));
    const repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-repo-"));
    await mkdir(join(repoRoot, "reports"), { recursive: true });
    await writeFile(join(repoRoot, "reports/desktop.png"), "png\n", "utf8");
    await writeFile(
      join(repoRoot, "reports/browser-evidence.json"),
      `${JSON.stringify({
        appUrl: "http://127.0.0.1:5177/app.html",
        status: "pass",
        captures: [
          {
            name: "desktop",
            passed: true,
            screenshotPath: "reports/desktop.png",
            layout: {
              resources: ["/app.js", "/styles.css"],
            },
            console: [],
            blockingConsole: [],
          },
        ],
      }, null, 2)}\n`,
      "utf8",
    );

    try {
      const evidence = await runVerification({
        repoRoot,
        runDir,
        identity: githubIdentity(21),
        commands: [`${process.execPath} -e "console.log('verified')"`],
        expectedArtifacts: ["reports/browser-evidence.json"],
        browserChecks: [
          {
            name: "desktop smoke",
            url: "http://127.0.0.1:5177/app.html",
            local_server_command: "python3 -m http.server 5177 --bind 127.0.0.1",
            required_selectors: ["#app"],
            console_error_policy: "no_errors",
            expected_network: ["/app.js"],
            screenshot_artifact: "reports/desktop.png",
          },
        ],
      });

      expect(evidence.browser_evidence).toHaveLength(1);
      expect(evidence.browser_evidence[0]).toMatchObject({
        name: "desktop smoke",
        status: "passed",
        screenshot_exists: true,
        observed_network: ["/app.js", "/styles.css"],
        missing_network: [],
        screenshot_artifact: "verification/issue-21/attempt-1/reports/desktop.png",
        evidence_report_path: "verification/issue-21/attempt-1/reports/browser-evidence.json",
      });
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("validates browser checks against normalized browser evidence bundles", async () => {
    runDir = await mkdtemp(join(tmpdir(), "brain-hands-verification-"));
    const repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-repo-"));
    await mkdir(join(repoRoot, "reports"), { recursive: true });
    await writeFile(join(repoRoot, "reports/desktop.png"), "png\n", "utf8");
    await writeFile(
      join(repoRoot, "reports/browser-evidence.json"),
      `${JSON.stringify({
        generated_at: "2026-07-08T12:00:00.000Z",
        status: "passed",
        reports: [
          {
            check_name: "desktop smoke",
            url: "http://127.0.0.1:5177/app.html",
            status: "passed",
            observed_selectors: ["#app"],
            missing_selectors: [],
            console_errors: [],
            expected_network: ["/app.js"],
            observed_network: ["/app.js", "/styles.css"],
            screenshot_artifact: "reports/desktop.png",
            console_error_policy: "no_errors",
            failure_reasons: [],
            skipped_reason: null,
          },
        ],
      }, null, 2)}\n`,
      "utf8",
    );

    try {
      const evidence = await runVerification({
        repoRoot,
        runDir,
        identity: githubIdentity(24),
        commands: [`${process.execPath} -e "console.log('verified')"`],
        expectedArtifacts: ["reports/browser-evidence.json"],
        browserChecks: [
          {
            name: "desktop smoke",
            url: "http://127.0.0.1:5177/app.html",
            local_server_command: "python3 -m http.server 5177 --bind 127.0.0.1",
            required_selectors: ["#app"],
            console_error_policy: "no_errors",
            expected_network: ["/app.js"],
            screenshot_artifact: "reports/desktop.png",
          },
        ],
      });

      expect(evidence.browser_evidence[0]).toMatchObject({
        name: "desktop smoke",
        status: "passed",
        observed_network: ["/app.js", "/styles.css"],
        missing_network: [],
        missing_selectors: [],
        screenshot_artifact: "verification/issue-24/attempt-1/reports/desktop.png",
        evidence_report_path: "verification/issue-24/attempt-1/reports/browser-evidence.json",
      });
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("records schema diagnostics for an invalid normalized browser evidence bundle", async () => {
    runDir = await mkdtemp(join(tmpdir(), "brain-hands-verification-"));
    const repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-repo-"));
    await mkdir(join(repoRoot, "reports"), { recursive: true });
    await writeFile(join(repoRoot, "reports/desktop.png"), "png\n", "utf8");
    await writeFile(
      join(repoRoot, "reports/browser-evidence.json"),
      `${JSON.stringify({
        generated_at: "2026-07-08T12:00:00.000Z",
        status: "successful",
        reports: [{
          check_name: "desktop smoke",
          url: "http://127.0.0.1:5177/app.html",
          status: "successful",
          observed_selectors: ["#app"],
          missing_selectors: [],
          console_errors: [],
          expected_network: [],
          observed_network: [],
          screenshot_artifact: "reports/desktop.png",
          console_error_policy: "no_errors",
          horizontal_overflow: { passed: true },
        }],
      }, null, 2)}\n`,
      "utf8",
    );

    try {
      const evidence = await runVerification({
        repoRoot,
        runDir,
        identity: githubIdentity(35),
        commands: [[process.execPath, "-e", "process.stdout.write('verified')"]],
        expectedArtifacts: ["reports/browser-evidence.json"],
        browserChecks: [{
          name: "desktop smoke",
          url: "http://127.0.0.1:5177/app.html",
          local_server_command: "python3 -m http.server 5177 --bind 127.0.0.1",
          required_selectors: ["#app"],
          console_error_policy: "no_errors",
          expected_network: [],
          screenshot_artifact: "reports/desktop.png",
        }],
      });

      expect(evidence.browser_evidence[0]).toMatchObject({
        status: "failed",
        evidence_report_path: "verification/issue-35/attempt-1/reports/browser-evidence.json",
        skipped_reason: "No valid browser evidence report matched this check.",
      });
      expect(evidence.browser_evidence[0]?.failure_reasons.join(" ")).toMatch(/status.*Invalid option/i);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("stages and normalizes scenario-named browser evidence reports", async () => {
    runDir = await mkdtemp(join(tmpdir(), "brain-hands-verification-"));
    const repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-repo-"));
    await mkdir(join(repoRoot, "artifacts/playwright"), { recursive: true });
    await writeFile(join(repoRoot, "artifacts/playwright/desktop-overview.png"), "png\n", "utf8");
    await writeFile(
      join(repoRoot, "artifacts/playwright/desktop-overview.json"),
      `${JSON.stringify({
        checkName: "desktop-overview",
        status: "passed",
        screenshotArtifact: "artifacts/playwright/desktop-overview.png",
        observedRequests: [{ method: "GET", url: "http://127.0.0.1:4173/" }],
        observedRequestOrigins: ["http://127.0.0.1:4173"],
        pageErrors: [],
        consoleErrors: [],
        failedRequests: [],
        nonLocalRequests: [],
        assertions: { requiredSelectors: true },
      }, null, 2)}\n`,
      "utf8",
    );

    try {
      const evidence = await runVerification({
        repoRoot,
        runDir,
        identity: githubIdentity(25),
        commands: [[process.execPath, "-e", "process.stdout.write('verified')"]],
        expectedArtifacts: ["artifacts/playwright/desktop-overview.json"],
        browserChecks: [{
          name: "production-desktop-overview",
          url: "http://127.0.0.1:4173",
          local_server_command: "npm run preview:app",
          required_selectors: ["#app"],
          console_error_policy: "no_errors",
          expected_network: ["http://127.0.0.1:4173"],
          screenshot_artifact: "artifacts/playwright/desktop-overview.png",
        }],
      });

      expect(evidence.browser_evidence[0]).toMatchObject({
        status: "passed",
        observed_network: ["http://127.0.0.1:4173", "GET http://127.0.0.1:4173/"],
        missing_network: [],
        missing_selectors: [],
        screenshot_artifact: "verification/issue-25/attempt-1/artifacts/playwright/desktop-overview.png",
        evidence_report_path: "verification/issue-25/attempt-1/artifacts/playwright/desktop-overview.json",
      });
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("loads a browser report from the browser check artifact path itself", async () => {
    runDir = await mkdtemp(join(tmpdir(), "brain-hands-verification-"));
    const repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-browser-artifact-"));
    await mkdir(join(repoRoot, "reports"), { recursive: true });
    await writeFile(
      join(repoRoot, "reports/browser-evidence.json"),
      `${JSON.stringify({
        generated_at: "2026-07-10T12:00:00.000Z",
        status: "passed",
        reports: [{
          check_name: "artifact report",
          url: "https://example.com/",
          status: "passed",
          observed_selectors: ["#app"],
          missing_selectors: [],
          console_errors: [],
          expected_network: [],
          observed_network: [],
          screenshot_artifact: "reports/browser-evidence.json",
          console_error_policy: "no_errors",
          failure_reasons: [],
          skipped_reason: null,
        }],
      }, null, 2)}\n`,
      "utf8",
    );
    try {
      const evidence = await runVerification({
        repoRoot,
        runDir,
        identity: githubIdentity(28),
        commands: [[process.execPath, "-e", "process.stdout.write('ok')"]],
        browserChecks: [{
          name: "artifact report",
          url: "https://example.com/",
          local_server_command: "npm run dev",
          required_selectors: ["#app"],
          console_error_policy: "no_errors",
          expected_network: [],
          screenshot_artifact: "reports/browser-evidence.json",
        }],
      });
      expect(evidence.browser_evidence[0]).toMatchObject({
        status: "passed",
        screenshot_artifact: "verification/issue-28/attempt-1/reports/browser-evidence.json",
        evidence_report_path: "verification/issue-28/attempt-1/reports/browser-evidence.json",
      });
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("marks browser checks failed when expected network is missing", async () => {
    runDir = await mkdtemp(join(tmpdir(), "brain-hands-verification-"));
    const repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-repo-"));
    await mkdir(join(repoRoot, "reports"), { recursive: true });
    await writeFile(join(repoRoot, "reports/desktop.png"), "png\n", "utf8");
    await writeFile(
      join(repoRoot, "reports/browser-evidence.json"),
      `${JSON.stringify({
        appUrl: "http://127.0.0.1:5177/app.html",
        status: "pass",
        captures: [
          {
            name: "desktop",
            passed: true,
            screenshotPath: "reports/desktop.png",
            layout: {
              resources: ["/styles.css"],
            },
            console: [],
            blockingConsole: [],
          },
        ],
      }, null, 2)}\n`,
      "utf8",
    );

    try {
      const evidence = await runVerification({
        repoRoot,
        runDir,
        identity: githubIdentity(22),
        commands: [`${process.execPath} -e "console.log('verified')"`],
        expectedArtifacts: ["reports/browser-evidence.json"],
        browserChecks: [
          {
            name: "desktop smoke",
            url: "http://127.0.0.1:5177/app.html",
            local_server_command: "python3 -m http.server 5177 --bind 127.0.0.1",
            required_selectors: ["#app"],
            console_error_policy: "no_errors",
            expected_network: ["/app.js"],
            screenshot_artifact: "reports/desktop.png",
          },
        ],
      });

      expect(evidence.browser_evidence[0]).toMatchObject({
        status: "failed",
        missing_network: ["/app.js"],
      });
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("preserves normalized browser failure reasons in verification evidence", async () => {
    runDir = await mkdtemp(join(tmpdir(), "brain-hands-verification-"));
    const repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-repo-"));
    await mkdir(join(repoRoot, "reports"), { recursive: true });
    await writeFile(join(repoRoot, "reports/desktop.png"), "png\n", "utf8");
    await writeFile(
      join(repoRoot, "reports/browser-evidence.json"),
      `${JSON.stringify({
        generated_at: "2026-07-08T12:00:00.000Z",
        status: "failed",
        reports: [
          {
            check_name: "desktop smoke",
            url: "http://127.0.0.1:5177/app.html",
            status: "failed",
            observed_selectors: ["#app"],
            missing_selectors: [],
            console_errors: [],
            expected_network: ["/app.js"],
            observed_network: ["/app.js"],
            screenshot_artifact: "reports/desktop.png",
            console_error_policy: "no_errors",
            failure_reasons: ["horizontal overflow detected"],
            skipped_reason: null,
          },
        ],
      }, null, 2)}\n`,
      "utf8",
    );

    try {
      const evidence = await runVerification({
        repoRoot,
        runDir,
        identity: githubIdentity(25),
        commands: [`${process.execPath} -e "console.log('verified')"`],
        expectedArtifacts: ["reports/browser-evidence.json"],
        browserChecks: [
          {
            name: "desktop smoke",
            url: "http://127.0.0.1:5177/app.html",
            local_server_command: "python3 -m http.server 5177 --bind 127.0.0.1",
            required_selectors: ["#app"],
            console_error_policy: "no_errors",
            expected_network: ["/app.js"],
            screenshot_artifact: "reports/desktop.png",
          },
        ],
      });

      expect(evidence.browser_evidence[0]).toMatchObject({
        status: "failed",
        failure_reasons: ["horizontal overflow detected"],
      });
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("handles quoted command arguments without shell execution", async () => {
    runDir = await mkdtemp(join(tmpdir(), "brain-hands-verification-"));

    const evidence = await runVerification({
      repoRoot: process.cwd(),
      runDir,
      identity: githubIdentity(14),
      commands: [
        `${process.execPath} -e "console.log(process.argv.slice(1).join(' '))" "hello world" "a b"`,
      ],
    });

    const output = await readFile(
      join(runDir, evidence.commands[0].stdout_path),
      "utf8",
    );

    expect(output.trim()).toBe("hello world a b");
  });

  it("rejects quoted backslash-quote arguments", async () => {
    runDir = await mkdtemp(join(tmpdir(), "brain-hands-verification-"));
    const quotedValue = String.raw`a\\\"b`;

    await expect(
      runVerification({
        repoRoot: process.cwd(),
        runDir,
        identity: githubIdentity(18),
        commands: [
          `${process.execPath} -e "console.log('check')" "${quotedValue}"`,
        ],
      }),
    ).rejects.toThrow(/Unsupported escaped quote in quoted argument/i);
  });

  it("preserves empty quoted arguments", async () => {
    runDir = await mkdtemp(join(tmpdir(), "brain-hands-verification-"));

    const evidence = await runVerification({
      repoRoot: process.cwd(),
      runDir,
      identity: githubIdentity(15),
      commands: [
        `${process.execPath} -e "console.log(JSON.stringify(process.argv.slice(1)))" "" "alpha beta"`,
      ],
    });

    const output = await readFile(
      join(runDir, evidence.commands[0].stdout_path),
      "utf8",
    );

    expect(JSON.parse(output)).toEqual(["", "alpha beta"]);
  });

  it("rejects unmatched quotes", async () => {
    runDir = await mkdtemp(join(tmpdir(), "brain-hands-verification-"));

    await expect(
      runVerification({
        repoRoot: process.cwd(),
        runDir,
        identity: githubIdentity(16),
        commands: [`${process.execPath} -e "console.log('unterminated')" "oops`],
      }),
    ).rejects.toThrow(/Unterminated quoted argument/i);
  });

  it("keeps Windows-style backslashes literal", async () => {
    runDir = await mkdtemp(join(tmpdir(), "brain-hands-verification-"));
    const windowsPath = String.raw`C:\temp\codex\bin`;

    const evidence = await runVerification({
      repoRoot: process.cwd(),
      runDir,
      identity: githubIdentity(17),
      commands: [
        `${process.execPath} -e "console.log(process.argv.slice(1)[0])" "${windowsPath}"`,
      ],
    });

    const output = await readFile(
      join(runDir, evidence.commands[0].stdout_path),
      "utf8",
    );

    expect(output.trim()).toBe(windowsPath);
  });

  it("rejects quoted Windows path fragments that look like escaped quotes", async () => {
    runDir = await mkdtemp(join(tmpdir(), "brain-hands-verification-"));
    const windowsPath = String.raw`C:\\path\\\"tail`;

    await expect(
      runVerification({
        repoRoot: process.cwd(),
        runDir,
        identity: githubIdentity(19),
        commands: [
          `${process.execPath} -e "console.log('check')" "${windowsPath}"`,
        ],
      }),
    ).rejects.toThrow(/Unsupported escaped quote in quoted argument/i);
  });
});
