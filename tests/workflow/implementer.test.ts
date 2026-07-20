import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig } from "../../src/core/config.js";
import { createRunLedger, readManifest, updateManifest } from "../../src/core/ledger.js";
import type {
  CodexAdapter,
  CodexInvokeInput,
  CodexInvokeResult,
} from "../../src/adapters/codex.js";
import type { GitHubAdapter, OpenPullRequestInput } from "../../src/adapters/github.js";
import type { IssueSpec } from "../../src/core/types.js";
import type { BrowserVerifyResult, VerifyBrowserIssueInput } from "../../src/browser/verifier.js";
import {
  HandsImplementationFailedError,
  implementIssue,
  VerificationFailedError,
} from "../../src/workflow/implementer.js";

const codexMetrics = { usage: null, durationMs: 0, processStarted: false, turnStarted: false, structuredTerminalError: false } as const;
let repoRoot: string | null = null;

afterEach(async () => {
  if (repoRoot) {
    await rm(repoRoot, { recursive: true, force: true });
    repoRoot = null;
  }
});

function createIssueSpec(overrides: Partial<IssueSpec> = {}): IssueSpec {
  return {
    type: "implementation_task",
    run_id: "2026-07-08T12-00-00-000Z-build-init-command",
    parent_request: "Build init command",
    goal: "Implement the init command",
    context: "The CLI should create an initial workflow config file.",
    scope: {
      include: ["src/cli.ts"],
      exclude: ["network calls"],
    },
    dependencies: [],
    implementation_steps: ["Add the init command."],
    acceptance_criteria: ["The init command writes the config file."],
    verification: {
      required_commands: [`${process.execPath} -e "console.log('verified')"`],
      manual_checks: [],
      expected_artifacts: [],
    },
    review_checklist: ["Command stays scoped to config creation."],
    risk_register: ["Overwriting existing config unexpectedly."],
    handoff_prompt: "Implement only the init command path.",
    ...overrides,
  };
}

class RecordingCodexAdapter implements CodexAdapter {
  public readonly invocations: CodexInvokeInput[] = [];

  constructor(
    private readonly text: string,
    private readonly exitCode = 0,
  ) {}

  async invoke(input: CodexInvokeInput): Promise<CodexInvokeResult> {
    this.invocations.push(input);

    return {
      text: this.text,
      exitCode: this.exitCode,
      promptPath: join(input.runDir, "prompts", `${input.artifactName}.md`),
      stdoutPath: join(input.runDir, "responses", `${input.artifactName}.stdout.txt`),
      stderrPath: join(input.runDir, "responses", `${input.artifactName}.stderr.txt`),
      ...codexMetrics,
    };
  }
}

class RecordingGitHubAdapter implements GitHubAdapter {
  public readonly openPullRequests: OpenPullRequestInput[] = [];

  constructor(private readonly nextPrNumber = 101) {}

  async createIssue(_issue: IssueSpec): Promise<number> {
    throw new Error("Unexpected createIssue call");
  }

  async updateIssue(_issueNumber: number, _issue: IssueSpec): Promise<void> {}

  async addIssueLabels(_issueNumber: number, _labels: string[]): Promise<void> {}

  async openPullRequest(input: OpenPullRequestInput): Promise<number> {
    this.openPullRequests.push(input);
    return this.nextPrNumber + this.openPullRequests.length - 1;
  }

  async commentOnPullRequest(_prNumber: number, _body: string): Promise<void> {}
}

async function writePassingBrowserEvidence(
  repoRoot: string,
  reportPath: string,
  screenshotPath: string,
): Promise<void> {
  await mkdir(join(repoRoot, "reports"), { recursive: true });
  await writeFile(join(repoRoot, screenshotPath), "png\n", "utf8");
  await writeFile(
    join(repoRoot, reportPath),
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
          observed_network: ["/app.js"],
          screenshot_artifact: screenshotPath,
          console_error_policy: "no_errors",
          viewport: { width: 1512, height: 738, mobile: false },
          horizontal_overflow: false,
          overlap_failures: [],
          pixel_check: {
            sampled_pixels: 100,
            non_blank_pixels: 75,
            unique_colors: 8,
          },
          failure_reasons: [],
          skipped_reason: null,
        },
      ],
    }, null, 2)}\n`,
    "utf8",
  );
}

function parseVerificationFromPrBody(body: string): Record<string, unknown> {
  const match = body.match(/```json\n([\s\S]*?)\n```/);
  if (!match) {
    throw new Error("PR body did not contain verification JSON");
  }
  return JSON.parse(match[1]) as Record<string, unknown>;
}

describe("implementIssue", () => {
  it("invokes hands, runs verification, opens a PR, and advances the manifest to pull_request", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-implementer-"));
    const ledger = await createRunLedger({
      repoRoot,
      originalRequest: "Build init command",
      slug: "build-init-command",
      now: new Date("2026-07-08T12:00:00.000Z"),
    });

    const issue = createIssueSpec();
    await writeFile(join(ledger.runDir, "architecture-plan.md"), "Architecture plan\n", "utf8");
    await writeFile(join(ledger.runDir, "issues.json"), `${JSON.stringify([issue], null, 2)}\n`, "utf8");
    await updateManifest(ledger.runDir, {
      stage: "ready_for_hands",
      issue_numbers: [1],
    });

    const codex = new RecordingCodexAdapter("Implementation complete.\n");
    const github = new RecordingGitHubAdapter(77);

    const result = await implementIssue({
      repoRoot,
      runDir: ledger.runDir,
      issueNumber: 1,
      config: defaultConfig(),
      codex,
      github,
      dryRun: true,
    });

    const manifest = await readManifest(ledger.runDir);

    expect(result.issueNumber).toBe(1);
    expect(codex.invocations).toHaveLength(1);
    expect(codex.invocations[0].role).toBe("hands_implementer");
    expect(codex.invocations[0].prompt).toContain("Implement the init command");
    expect(codex.invocations[0].prompt).toContain("Include:");
    expect(codex.invocations[0].prompt).toContain("Exclude:");
    expect(github.openPullRequests).toHaveLength(1);
    expect(github.openPullRequests[0].title).toContain("Implement issue #1");
    expect(manifest.stage).toBe("pull_request");
    expect(manifest.current_pr).toBe(77);
    expect(manifest.issue_numbers).toEqual([1]);
  });

  it("prevents PR creation when verification fails and leaves the manifest before pull_request", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-implementer-"));
    const ledger = await createRunLedger({
      repoRoot,
      originalRequest: "Build init command",
      slug: "build-init-command",
      now: new Date("2026-07-08T12:00:00.000Z"),
    });

    const issue = createIssueSpec({
      verification: {
        required_commands: [
          `${process.execPath} -e "process.exit(1)"`,
        ],
        manual_checks: [],
        expected_artifacts: [".brain-hands/config.yaml"],
      },
    });

    await writeFile(join(ledger.runDir, "architecture-plan.md"), "Architecture plan\n", "utf8");
    await writeFile(join(ledger.runDir, "issues.json"), `${JSON.stringify([issue], null, 2)}\n`, "utf8");
    await updateManifest(ledger.runDir, {
      stage: "ready_for_hands",
      issue_numbers: [1],
    });

    const codex = new RecordingCodexAdapter("Implementation complete.\n");
    const github = new RecordingGitHubAdapter(78);

    await expect(
      implementIssue({
        repoRoot,
        runDir: ledger.runDir,
        issueNumber: 1,
        config: defaultConfig(),
        codex,
        github,
        dryRun: true,
      }),
    ).rejects.toBeInstanceOf(VerificationFailedError);

    const manifest = await readManifest(ledger.runDir);

    expect(github.openPullRequests).toHaveLength(0);
    expect(manifest.stage).toBe("local_verification");
    expect(manifest.current_pr).toBeNull();
    expect(manifest.current_issue).toBe(1);
  });

  it("prevents PR creation when an expected artifact is missing", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-implementer-"));
    const ledger = await createRunLedger({
      repoRoot,
      originalRequest: "Build init command",
      slug: "build-init-command",
      now: new Date("2026-07-08T12:00:00.000Z"),
    });

    const issue = createIssueSpec({
      verification: {
        required_commands: [`${process.execPath} -e "console.log('verified')"`],
        manual_checks: [],
        expected_artifacts: ["missing-artifact.txt"],
      },
    });

    await writeFile(join(ledger.runDir, "architecture-plan.md"), "Architecture plan\n", "utf8");
    await writeFile(join(ledger.runDir, "issues.json"), `${JSON.stringify([issue], null, 2)}\n`, "utf8");
    await updateManifest(ledger.runDir, {
      stage: "ready_for_hands",
      issue_numbers: [1],
    });

    const github = new RecordingGitHubAdapter(82);

    await expect(
      implementIssue({
        repoRoot,
        runDir: ledger.runDir,
        issueNumber: 1,
        config: defaultConfig(),
        codex: new RecordingCodexAdapter("Implementation complete.\n"),
        github,
        dryRun: true,
      }),
    ).rejects.toThrow(/required artifact missing: missing-artifact\.txt/);

    expect(github.openPullRequests).toHaveLength(0);
  });

  it("prevents PR creation when browser evidence is missing", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-implementer-"));
    const currentRepoRoot = repoRoot;
    const ledger = await createRunLedger({
      repoRoot: currentRepoRoot,
      originalRequest: "Build init command",
      slug: "build-init-command",
      now: new Date("2026-07-08T12:00:00.000Z"),
    });

    const issue = createIssueSpec({
      verification: {
        required_commands: [`${process.execPath} -e "console.log('verified')"`],
        manual_checks: [],
        expected_artifacts: [],
      },
      browser_checks: [
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

    await writeFile(join(ledger.runDir, "architecture-plan.md"), "Architecture plan\n", "utf8");
    await writeFile(join(ledger.runDir, "issues.json"), `${JSON.stringify([issue], null, 2)}\n`, "utf8");
    await updateManifest(ledger.runDir, {
      stage: "ready_for_hands",
      issue_numbers: [1],
    });

    const github = new RecordingGitHubAdapter(83);

    await expect(
      implementIssue({
        repoRoot: currentRepoRoot,
        runDir: ledger.runDir,
        issueNumber: 1,
        config: defaultConfig(),
        codex: new RecordingCodexAdapter("Implementation complete.\n"),
        github,
        dryRun: true,
        browserVerifier: async (input): Promise<BrowserVerifyResult> => ({
          status: "passed",
          reportPath: join(currentRepoRoot, input.reportPath),
          ledgerReportPath: null,
          bundle: {
            generated_at: "2026-07-08T12:00:00.000Z",
            status: "passed",
            reports: [],
          },
        }),
      }),
    ).rejects.toThrow(/browser check "desktop smoke" failed/);

    expect(github.openPullRequests).toHaveLength(0);
  });

  it("auto-runs browser checks before local verification and PR creation", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-implementer-"));
    const currentRepoRoot = repoRoot;
    const ledger = await createRunLedger({
      repoRoot: currentRepoRoot,
      originalRequest: "Build browser evidence",
      slug: "build-browser-evidence",
      now: new Date("2026-07-08T12:00:00.000Z"),
    });
    const browserVerifierCalls: VerifyBrowserIssueInput[] = [];
    const issue = createIssueSpec({
      verification: {
        required_commands: [`${process.execPath} -e "console.log('verified')"`],
        manual_checks: [],
        expected_artifacts: [],
      },
      browser_checks: [
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

    await writeFile(join(ledger.runDir, "architecture-plan.md"), "Architecture plan\n", "utf8");
    await writeFile(join(ledger.runDir, "issues.json"), `${JSON.stringify([issue], null, 2)}\n`, "utf8");
    await updateManifest(ledger.runDir, {
      stage: "ready_for_hands",
      issue_numbers: [1],
    });

    const codex = new RecordingCodexAdapter("Implementation complete.\n");
    const github = new RecordingGitHubAdapter(84);

    const result = await implementIssue({
      repoRoot: currentRepoRoot,
      runDir: ledger.runDir,
      issueNumber: 1,
      config: defaultConfig(),
      codex,
      github,
      dryRun: true,
      browserVerifier: async (input): Promise<BrowserVerifyResult> => {
        browserVerifierCalls.push(input);
        await writePassingBrowserEvidence(currentRepoRoot, input.reportPath, "reports/desktop.png");
        return {
          status: "passed",
          reportPath: join(currentRepoRoot, input.reportPath),
          ledgerReportPath: join(ledger.runDir, "verification/issue-1/attempt-1/browser-evidence.json"),
          bundle: {
            generated_at: "2026-07-08T12:00:00.000Z",
            status: "passed",
            reports: [],
          },
        };
      },
    });

    const evidenceRaw = await readFile(join(ledger.runDir, "verification/issue-1/attempt-1/evidence.json"), "utf8");
    const evidence = JSON.parse(evidenceRaw) as {
      artifacts: string[];
      browser_evidence: Array<{ status: string; evidence_report_path: string | null }>;
    };
    const prVerification = parseVerificationFromPrBody(github.openPullRequests[0].body) as {
      browser_evidence: Array<{ status: string }>;
    };

    expect(result.pullRequestNumber).toBe(84);
    expect(browserVerifierCalls).toHaveLength(1);
    expect(browserVerifierCalls[0]).toMatchObject({
      repoRoot: currentRepoRoot,
      runDir: ledger.runDir,
      identity: { scope: "github", work_item_id: "legacy-issue-1", issue_number: 1 },
      reportPath: "reports/browser-evidence-issue-1.json",
    });
    expect(evidence.artifacts).not.toContain("reports/browser-evidence-issue-1.json");
    expect(evidence.browser_evidence[0]).toMatchObject({
      status: "passed",
      evidence_report_path: "verification/issue-1/attempt-1/reports/browser-evidence-issue-1.json",
    });
    expect(prVerification.browser_evidence[0].status).toBe("passed");
    expect(github.openPullRequests).toHaveLength(1);
  });

  it("prevents PR creation when automatic browser verification fails", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-implementer-"));
    const currentRepoRoot = repoRoot;
    const ledger = await createRunLedger({
      repoRoot: currentRepoRoot,
      originalRequest: "Build browser evidence",
      slug: "build-browser-evidence",
      now: new Date("2026-07-08T12:00:00.000Z"),
    });
    const issue = createIssueSpec({
      verification: {
        required_commands: [`${process.execPath} -e "console.log('verified')"`],
        manual_checks: [],
        expected_artifacts: [],
      },
      browser_checks: [
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

    await writeFile(join(ledger.runDir, "architecture-plan.md"), "Architecture plan\n", "utf8");
    await writeFile(join(ledger.runDir, "issues.json"), `${JSON.stringify([issue], null, 2)}\n`, "utf8");
    await updateManifest(ledger.runDir, {
      stage: "ready_for_hands",
      issue_numbers: [1],
    });

    const github = new RecordingGitHubAdapter(85);

    await expect(
      implementIssue({
        repoRoot: currentRepoRoot,
        runDir: ledger.runDir,
        issueNumber: 1,
        config: defaultConfig(),
        codex: new RecordingCodexAdapter("Implementation complete.\n"),
        github,
        dryRun: true,
        browserVerifier: async (input): Promise<BrowserVerifyResult> => ({
          status: "failed",
          reportPath: join(currentRepoRoot, input.reportPath),
          ledgerReportPath: null,
          bundle: {
            generated_at: "2026-07-08T12:00:00.000Z",
            status: "failed",
            reports: [],
          },
        }),
      }),
    ).rejects.toThrow(/automatic browser verification failed for issue 1/);

    const manifest = await readManifest(ledger.runDir);
    expect(github.openPullRequests).toHaveLength(0);
    expect(manifest.stage).toBe("local_verification");
    expect(manifest.current_pr).toBeNull();
  });

  it("fails closed when the hands model exits non-zero and does not start verification", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-implementer-"));
    const ledger = await createRunLedger({
      repoRoot,
      originalRequest: "Build init command",
      slug: "build-init-command",
      now: new Date("2026-07-08T12:00:00.000Z"),
    });

    const issue = createIssueSpec();
    await writeFile(join(ledger.runDir, "architecture-plan.md"), "Architecture plan\n", "utf8");
    await writeFile(join(ledger.runDir, "issues.json"), `${JSON.stringify([issue], null, 2)}\n`, "utf8");
    await updateManifest(ledger.runDir, {
      stage: "ready_for_hands",
      issue_numbers: [1],
    });

    const codex = new RecordingCodexAdapter("hands failed\n", 1);
    const github = new RecordingGitHubAdapter(80);

    await expect(
      implementIssue({
        repoRoot,
        runDir: ledger.runDir,
        issueNumber: 1,
        config: defaultConfig(),
        codex,
        github,
        dryRun: true,
      }),
    ).rejects.toThrow(HandsImplementationFailedError);

    await expect(
      implementIssue({
        repoRoot,
        runDir: ledger.runDir,
        issueNumber: 1,
        config: defaultConfig(),
        codex: new RecordingCodexAdapter("hands failed\n", 1),
        github: new RecordingGitHubAdapter(81),
        dryRun: true,
      }),
    ).rejects.toThrow(/Hands implementation failed for issue 1: exitCode=1/);

    const manifest = await readManifest(ledger.runDir);

    expect(github.openPullRequests).toHaveLength(0);
    expect(manifest.stage).toBe("implementing");
    expect(manifest.current_issue).toBe(1);
    expect(manifest.current_pr).toBeNull();
    await expect(
      access(join(ledger.runDir, "verification/issue-1/attempt-1/evidence.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("uses manifest.issue_numbers to select issues.json[0] for issueNumber 42", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-implementer-"));
    const ledger = await createRunLedger({
      repoRoot,
      originalRequest: "Build init command",
      slug: "build-init-command",
      now: new Date("2026-07-08T12:00:00.000Z"),
    });

    const selectedIssue = createIssueSpec({
      goal: "Selected issue",
      context: "This issue should be chosen by manifest order.",
    });
    const ignoredIssue = createIssueSpec({
      goal: "Ignored issue",
      context: "This issue should not be chosen.",
    });

    await writeFile(
      join(ledger.runDir, "architecture-plan.md"),
      "Architecture plan\n",
      "utf8",
    );
    await writeFile(
      join(ledger.runDir, "issues.json"),
      `${JSON.stringify([selectedIssue, ignoredIssue], null, 2)}\n`,
      "utf8",
    );
    await updateManifest(ledger.runDir, {
      stage: "ready_for_hands",
      issue_numbers: [42],
    });

    const codex = new RecordingCodexAdapter("Implementation complete.\n");
    const github = new RecordingGitHubAdapter(79);

    const result = await implementIssue({
      repoRoot,
      runDir: ledger.runDir,
      issueNumber: 42,
      config: defaultConfig(),
      codex,
      github,
      dryRun: true,
    });

    const manifest = await readManifest(ledger.runDir);

    expect(result.issueNumber).toBe(42);
    expect(codex.invocations).toHaveLength(1);
    expect(codex.invocations[0].prompt).toContain("Selected issue");
    expect(codex.invocations[0].prompt).not.toContain("Ignored issue");
    expect(github.openPullRequests).toHaveLength(1);
    expect(github.openPullRequests[0].title).toContain("Selected issue");
    expect(manifest.stage).toBe("pull_request");
    expect(manifest.current_pr).toBe(79);
  });
});
