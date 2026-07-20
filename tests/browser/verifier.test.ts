import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { verificationIdentityDirectory } from "../../src/core/types.js";
import type { BrowserCheckSpec, IssueSpec, VerificationIdentity } from "../../src/core/types.js";
import {
  buildBrowserEvidenceReport,
  assertBrowserProcessTreeSupport,
  captureBrowserCheck,
  verifyBrowserIssue,
  type BrowserCheckCapture,
} from "../../src/browser/verifier.js";
import { runWithExecutionAuthority } from "../../src/core/execution-context.js";
import { runVerification } from "../../src/verification/runner.js";

let tempRoot: string | null = null;

afterEach(async () => {
  if (tempRoot) {
    await rm(tempRoot, { recursive: true, force: true });
    tempRoot = null;
  }
});

function createBrowserCheck(overrides: Partial<BrowserCheckSpec> = {}): BrowserCheckSpec {
  return {
    name: "desktop smoke",
    url: "http://127.0.0.1:5177/app.html",
    local_server_command: "python3 -m http.server 5177 --bind 127.0.0.1",
    required_selectors: ["#app", "#toolbar"],
    console_error_policy: "no_errors",
    expected_network: ["/app.js", "/styles.css"],
    screenshot_artifact: "reports/desktop.png",
    require_no_horizontal_overflow: true,
    forbidden_overlaps: [["#toolbar", "#details"]],
    ...overrides,
  };
}

function createCapture(overrides: Partial<BrowserCheckCapture> = {}): BrowserCheckCapture {
  return {
    observedSelectors: ["#app", "#toolbar"],
    observedNetwork: ["/app.js", "/styles.css", "/favicon.svg"],
    consoleErrors: [],
    screenshotArtifact: "reports/desktop.png",
    screenshotExists: true,
    horizontalOverflow: false,
    overlapFailures: [],
    pixelCheck: {
      sampledPixels: 512,
      nonBlankPixels: 200,
      uniqueColors: 8,
    },
    ...overrides,
  };
}

it("fails approved Windows browser execution before any spawn is possible", async () => {
  await runWithExecutionAuthority({
    claim: { runDir: "/run", token: "token", epoch: 1, invocationId: "test" },
    assert: async () => {},
    beginEffect: async () => "effect",
    recordEffectChild: async () => {},
    endEffect: async () => {},
  }, async () => {
    expect(() => assertBrowserProcessTreeSupport("win32"))
      .toThrow(/unsupported on Windows.*Job Object/i);
  });
});

it("binds a direct browser capture child to one durable execution effect", async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "brain-hands-direct-browser-"));
  const fakeChrome = join(tempRoot, "fake-chrome");
  await writeFile(fakeChrome, "#!/bin/sh\necho 'DevTools listening on ws://127.0.0.1:9/devtools/browser/fake' >&2\nsleep 30\n", "utf8");
  await chmod(fakeChrome, 0o755);
  const events: string[] = [];

  await runWithExecutionAuthority({
    claim: { runDir: "/run", token: "token", epoch: 1, invocationId: "test" },
    assert: async () => {},
    beginEffect: async (kind) => { events.push(`begin:${kind}`); return "browser-effect"; },
    recordEffectChild: async (invocationId, pid) => { events.push(`child:${invocationId}:${pid === null ? "null" : "pid"}`); },
    endEffect: async (invocationId) => { events.push(`end:${invocationId}`); },
  }, async () => {
    await expect(captureBrowserCheck(
      createBrowserCheck({ url: "data:text/plain,ready" }),
      tempRoot!,
      fakeChrome,
    )).rejects.toThrow();
  });

  expect(events).toEqual([
    "begin:browser:capture:desktop smoke",
    "child:browser-effect:pid",
    "end:browser-effect",
  ]);
});

function createIssue(checks: BrowserCheckSpec[]): IssueSpec {
  return {
    type: "implementation_task",
    run_id: "2026-07-08T12-00-00-000Z-browser-verify",
    parent_request: "Verify browser UI",
    goal: "Capture browser evidence",
    context: "The issue declares browser checks.",
    scope: { include: ["index.html"], exclude: [] },
    dependencies: [],
    implementation_steps: ["Run the browser verifier."],
    acceptance_criteria: ["Browser checks pass."],
    verification: {
      required_commands: ["npm test"],
      manual_checks: [],
      expected_artifacts: ["reports/browser-evidence.json"],
    },
    review_checklist: ["Browser evidence is present."],
    risk_register: [],
    handoff_prompt: "Verify browser behavior.",
    browser_checks: checks,
  };
}

describe("buildBrowserEvidenceReport", () => {
  it("passes when selectors, network, console, screenshot, pixels, overflow, and overlaps satisfy the check", () => {
    const report = buildBrowserEvidenceReport(createBrowserCheck(), createCapture());

    expect(report).toMatchObject({
      check_name: "desktop smoke",
      status: "passed",
      observed_selectors: ["#app", "#toolbar"],
      missing_selectors: [],
      observed_network: ["/app.js", "/styles.css", "/favicon.svg"],
      console_errors: [],
      horizontal_overflow: false,
      overlap_failures: [],
      pixel_check: {
        sampled_pixels: 512,
        non_blank_pixels: 200,
        unique_colors: 8,
      },
      failure_reasons: [],
    });
  });

  it("fails with concrete reasons for missing browser requirements", () => {
    const report = buildBrowserEvidenceReport(
      createBrowserCheck(),
      createCapture({
        observedSelectors: ["#app"],
        observedNetwork: ["/app.js"],
        consoleErrors: ["warning: hydration mismatch"],
        screenshotExists: false,
        horizontalOverflow: true,
        overlapFailures: ["#toolbar overlaps #details"],
        pixelCheck: {
          sampledPixels: 512,
          nonBlankPixels: 0,
          uniqueColors: 1,
        },
      }),
    );

    expect(report.status).toBe("failed");
    expect(report.missing_selectors).toEqual(["#toolbar"]);
    expect(report.failure_reasons).toEqual([
      "missing selector: #toolbar",
      "missing expected network: /styles.css",
      "console error policy violated: 1 blocking console entries",
      "screenshot missing: reports/desktop.png",
      "horizontal overflow detected",
      "forbidden overlap: #toolbar overlaps #details",
      "screenshot pixel check failed",
    ]);
  });
});

describe("verifyBrowserIssue", () => {
  it("writes normalized report and optional run-ledger browser evidence", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "brain-hands-browser-"));
    const repoRoot = join(tempRoot, "repo");
    const runDir = join(tempRoot, "run");
    await mkdir(repoRoot, { recursive: true });
    await mkdir(runDir, { recursive: true });
    const check = createBrowserCheck();
    const stopped: string[] = [];

    const result = await verifyBrowserIssue(
      {
        repoRoot,
        issue: createIssue([check]),
        reportPath: "reports/browser-evidence.json",
        runDir,
        identity: { scope: "github", work_item_id: "BH-007", issue_number: 7 },
      },
      {
        now: () => new Date("2026-07-08T12:00:00.000Z"),
        startServer: async (command) => ({
          command,
          stop: async () => {
            stopped.push(command);
          },
        }),
        captureCheck: async () => createCapture(),
      },
    );

    const reportRaw = await readFile(join(runDir, "verification/issue-7/attempt-1/browser-evidence.json"), "utf8");
    const ledgerRaw = await readFile(join(runDir, "verification/issue-7/attempt-1/browser-evidence.json"), "utf8");
    const report = JSON.parse(reportRaw) as Record<string, unknown>;
    const ledger = JSON.parse(ledgerRaw) as Record<string, unknown>;

    expect(result.status).toBe("passed");
    expect(result.reportPath).toBe(join(runDir, "verification/issue-7/attempt-1/browser-evidence.json"));
    expect(report).toMatchObject({
      generated_at: "2026-07-08T12:00:00.000Z",
      status: "passed",
    });
    expect(ledger).toEqual(report);
    expect(stopped).toEqual([check.local_server_command]);
  });

  it("rejects issue-number-only run-scoped browser writes before capture", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "brain-hands-browser-"));
    const repoRoot = join(tempRoot, "repo");
    const runDir = join(tempRoot, "run");
    await mkdir(repoRoot, { recursive: true });
    await mkdir(runDir, { recursive: true });

    await expect(verifyBrowserIssue({
      repoRoot,
      issue: createIssue([createBrowserCheck()]),
      reportPath: "reports/browser-evidence.json",
      runDir,
      issueNumber: 7,
    }, {
      startServer: async () => { throw new Error("server must not be started"); },
      captureCheck: async () => { throw new Error("capture must not be started"); },
    })).rejects.toThrow(/verification identity is required/i);
    await expect(readFile(join(runDir, "verification/issue-7/attempt-1/browser-evidence.json"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(runDir, "reports/browser-evidence.json"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    { label: "mapped GitHub", identity: { scope: "github" as const, work_item_id: "BH-008", issue_number: 8 } },
    { label: "local", identity: { scope: "local" as const, work_item_id: "BH/008" } },
    { label: "integrated", identity: { scope: "integrated" as const, work_item_id: "integrated" as const } },
  ])("fails closed when the $label browser target contains a sentinel", async ({ identity }: { identity: VerificationIdentity }) => {
    tempRoot = await mkdtemp(join(tmpdir(), "brain-hands-browser-"));
    const repoRoot = join(tempRoot, "repo");
    const runDir = join(tempRoot, "run");
    await mkdir(repoRoot, { recursive: true });
    await mkdir(runDir, { recursive: true });
    const target = join(runDir, verificationIdentityDirectory(identity), "attempt-1");
    await mkdir(target, { recursive: true });
    const sentinelPath = join(target, "browser-evidence.json");
    const sentinel = "foreign browser sentinel\n";
    await writeFile(sentinelPath, sentinel, "utf8");

    await expect(verifyBrowserIssue({
      repoRoot,
      issue: createIssue([createBrowserCheck()]),
      reportPath: "reports/browser-evidence.json",
      runDir,
      identity,
    }, {
      startServer: async () => { throw new Error("server must not be started"); },
      captureCheck: async () => { throw new Error("capture must not be started"); },
    })).rejects.toThrow(/already contains artifacts/i);
    expect(await readFile(sentinelPath, "utf8")).toBe(sentinel);
    await expect(readFile(join(runDir, "reports/browser-evidence.json"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a later attempt when an earlier attempt declares a foreign identity", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "brain-hands-browser-"));
    const repoRoot = join(tempRoot, "repo");
    const runDir = join(tempRoot, "run");
    await mkdir(repoRoot, { recursive: true });
    await mkdir(join(runDir, "verification/issue-8/attempt-1"), { recursive: true });
    await writeFile(join(runDir, "verification/issue-8/attempt-1/evidence.json"), `${JSON.stringify({
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

    await expect(verifyBrowserIssue({
      repoRoot,
      issue: createIssue([createBrowserCheck()]),
      reportPath: "reports/browser-evidence.json",
      runDir,
      identity: { scope: "github", work_item_id: "BH-008", issue_number: 8 },
      attempt: 2,
    }, {
      startServer: async () => { throw new Error("server must not be started"); },
      captureCheck: async () => { throw new Error("capture must not be started"); },
    })).rejects.toThrow(/different identity|provenance/i);
    await expect(readFile(join(runDir, "verification/issue-8/attempt-2/browser-evidence.json"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(runDir, "reports/browser-evidence.json"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects screenshot artifacts that escape the v2 run directory before capture", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "brain-hands-browser-"));
    const repoRoot = join(tempRoot, "repo");
    const runDir = join(tempRoot, "run");
    const sourceTarget = join(repoRoot, "source-write.png");
    await mkdir(repoRoot, { recursive: true });
    await mkdir(runDir, { recursive: true });

    await expect(
      verifyBrowserIssue(
        {
          repoRoot,
          issue: createIssue([createBrowserCheck({ screenshot_artifact: "../repo/source-write.png" })]),
          reportPath: "reports/browser-evidence.json",
          runDir,
          identity: { scope: "github", work_item_id: "BH-007", issue_number: 7 },
        },
        {
          startServer: async () => {
            throw new Error("server must not be started");
          },
          captureCheck: async () => {
            throw new Error("capture must not be started");
          },
        },
      ),
    ).rejects.toThrow(/run directory/i);

    await expect(readFile(sourceTarget, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("writes integrated browser evidence below the integrated identity", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "brain-hands-browser-"));
    const repoRoot = join(tempRoot, "repo");
    const runDir = join(tempRoot, "run");
    await mkdir(repoRoot, { recursive: true });
    await mkdir(runDir, { recursive: true });
    const check = createBrowserCheck();
    const result = await verifyBrowserIssue(
      {
        repoRoot,
        issue: createIssue([check]),
        reportPath: "reports/browser-evidence.json",
        runDir,
        identity: { scope: "integrated", work_item_id: "integrated" },
        attempt: 3,
      },
      {
        startServer: async (command) => ({ command, stop: async () => {} }),
        captureCheck: async () => createCapture(),
      },
    );
    expect(result.ledgerReportPath).toBe(join(runDir, "verification/integrated/attempt-3/browser-evidence.json"));
    await expect(readFile(join(runDir, "verification/issue-3/browser-evidence.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("completes an integrated browser transaction with command verification in one namespace", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "brain-hands-browser-"));
    const repoRoot = join(tempRoot, "repo");
    const runDir = join(tempRoot, "run");
    await mkdir(repoRoot, { recursive: true });
    await mkdir(runDir, { recursive: true });
    const check = createBrowserCheck();
    const identity = { scope: "integrated" as const, work_item_id: "integrated" as const };
    const prefix = "verification/integrated/attempt-1/";

    const browser = await verifyBrowserIssue(
      {
        repoRoot,
        issue: createIssue([check]),
        reportPath: "reports/browser-evidence.json",
        runDir,
        identity,
        attempt: 1,
      },
      {
        startServer: async (command) => ({ command, stop: async () => {} }),
        captureCheck: async (scopedCheck, _repoRoot, _chromePath, artifactRoot) => {
          const screenshotPath = join(artifactRoot!, scopedCheck.screenshot_artifact);
          await mkdir(dirname(screenshotPath), { recursive: true });
          await writeFile(screenshotPath, "screenshot\n", "utf8");
          return createCapture({ screenshotArtifact: scopedCheck.screenshot_artifact });
        },
      },
    );
    const evidence = await runVerification({
      repoRoot,
      runDir,
      identity,
      commands: [[process.execPath, "-e", "process.stdout.write('integrated')"]],
      expectedArtifacts: [],
      browserChecks: [check],
      attempt: 1,
    });

    expect(browser.reportPath).toBe(join(runDir, `${prefix}browser-evidence.json`));
    expect(browser.reportPath.replace(runDir, "")).toContain(`/${prefix}`);
    expect(evidence.evidence_path).toBe(`${prefix}evidence.json`);
    expect(evidence.commands.every((command) => command.stdout_path.startsWith(prefix) && command.stderr_path.startsWith(prefix) && command.result_path?.startsWith(prefix))).toBe(true);
    expect(evidence.browser_evidence[0]?.screenshot_artifact.startsWith(prefix)).toBe(true);
    expect(evidence.browser_evidence[0]?.evidence_report_path?.startsWith(prefix)).toBe(true);
    expect(evidence.artifact_checks.every((artifact) => artifact.path.startsWith(prefix))).toBe(true);
    expect(await readFile(join(runDir, evidence.evidence_path), "utf8")).toContain('"verification_scope": "integrated"');
  });

  it("returns failed status when any declared check fails", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "brain-hands-browser-"));
    const repoRoot = join(tempRoot, "repo");
    await mkdir(repoRoot, { recursive: true });

    const result = await verifyBrowserIssue(
      {
        repoRoot,
        issue: createIssue([createBrowserCheck()]),
        reportPath: "reports/browser-evidence.json",
      },
      {
        now: () => new Date("2026-07-08T12:00:00.000Z"),
        startServer: async (command) => ({ command, stop: async () => {} }),
        captureCheck: async () => createCapture({ observedSelectors: [] }),
      },
    );

    expect(result.status).toBe("failed");
    expect(result.bundle.reports[0].failure_reasons).toContain("missing selector: #app");
  });

  it.each([
    "sh -c echo unsafe",
    "rm -rf reports",
    `${process.execPath} -e "console.log('unsafe')"`,
    "python3 -m http.server ../outside",
  ])("rejects unsafe local server command %s before spawn", async (localServerCommand) => {
    tempRoot = await mkdtemp(join(tmpdir(), "brain-hands-browser-"));
    const repoRoot = join(tempRoot, "repo");
    await mkdir(repoRoot, { recursive: true });
    const startServer = async () => {
      throw new Error("server must not be started");
    };

    await expect(
      verifyBrowserIssue(
        {
          repoRoot,
          issue: createIssue([createBrowserCheck({ local_server_command: localServerCommand })]),
          reportPath: "reports/browser-evidence.json",
        },
        { startServer },
      ),
    ).rejects.toThrow(/(shell|destructive|absolute|escapes|path)/i);
  });
});
