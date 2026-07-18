import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type { CodexAdapter, CodexInvokeInput, CodexInvokeResult } from "../../src/adapters/codex.js";
import type { GitHubAdapter, OpenPullRequestInput } from "../../src/adapters/github.js";
import { DryRunCodexAdapter } from "../../src/adapters/codex.js";
import { DryRunGitHubAdapter } from "../../src/adapters/github.js";
import { defaultConfig } from "../../src/core/config.js";
import { createRunLedger, readManifest } from "../../src/core/ledger.js";
import type { IssueSpec } from "../../src/core/types.js";
import { planRun } from "../../src/workflow/planner.js";

const codexMetrics = { usage: null, durationMs: 0, processStarted: false, turnStarted: false, structuredTerminalError: false } as const;
let repoRoot: string | null = null;

afterEach(async () => {
  if (repoRoot) {
    await rm(repoRoot, { recursive: true, force: true });
    repoRoot = null;
  }
});

class ScriptedCodexAdapter implements CodexAdapter {
  private readonly results: string[];

  constructor(results: string[]) {
    this.results = [...results];
  }

  async invoke(input: CodexInvokeInput): Promise<CodexInvokeResult> {
    const text = this.results.shift() ?? "[]";
    return {
      text,
      exitCode: 0,
      promptPath: join(input.runDir, "prompts", `${input.artifactName}.md`),
      stdoutPath: join(input.runDir, "responses", `${input.artifactName}.stdout.txt`),
      stderrPath: join(input.runDir, "responses", `${input.artifactName}.stderr.txt`),
      ...codexMetrics,
    };
  }
}

class RecordingGitHubAdapter implements GitHubAdapter {
  public readonly createdIssues: IssueSpec[] = [];

  async createIssue(issue: IssueSpec): Promise<number> {
    this.createdIssues.push(issue);
    return this.createdIssues.length;
  }

  async updateIssue(_issueNumber: number, _issue: IssueSpec): Promise<void> {}

  async addIssueLabels(_issueNumber: number, _labels: string[]): Promise<void> {}

  async openPullRequest(_input: OpenPullRequestInput): Promise<number> {
    throw new Error("Not implemented in test");
  }

  async commentOnPullRequest(_prNumber: number, _body: string): Promise<void> {
    throw new Error("Not implemented in test");
  }
}

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
      required_commands: ["npm test -- tests/cli-smoke.test.ts"],
      manual_checks: [],
      expected_artifacts: [".brain-hands/config.yaml"],
    },
    review_checklist: ["Command stays scoped to config creation."],
    risk_register: ["Overwriting existing config unexpectedly."],
    handoff_prompt: "Implement only the init command path.",
    browser_checks: [],
    ...overrides,
  };
}

describe("planRun", () => {
  it("stores planning artifacts, updates reviewed issues, and advances stage", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-plan-"));
    const ledger = await createRunLedger({
      repoRoot,
      originalRequest: "Build init command",
      slug: "build-init-command",
      now: new Date("2026-07-08T12:00:00.000Z"),
    });

    const draftedIssue = createIssueSpec({
      goal: "Draft init issue",
      context: "Initial planner output.",
    });
    const reviewedIssue = createIssueSpec({
      goal: "Reviewed init issue",
      context: "Critic tightened the scope.",
    });

    const codex = new ScriptedCodexAdapter([
      [
        "# Research",
        "Understand the CLI entrypoint.",
        "",
        "## Architecture Plan",
        "Use the workflow planner to create reviewed issues before GitHub issue creation.",
        "",
        "```json",
        JSON.stringify([draftedIssue], null, 2),
        "```",
      ].join("\n"),
      JSON.stringify([reviewedIssue], null, 2),
    ]);
    const github = new RecordingGitHubAdapter();

    const result = await planRun({
      repoRoot,
      runDir: ledger.runDir,
      config: defaultConfig(),
      codex,
      github,
      workflowDesign: "design",
      dryRun: false,
    });

    const manifest = await readManifest(ledger.runDir);
    const research = await readFile(join(ledger.runDir, "research.md"), "utf8");
    const architecturePlan = await readFile(
      join(ledger.runDir, "architecture-plan.md"),
      "utf8",
    );
    const issues = JSON.parse(await readFile(join(ledger.runDir, "issues.json"), "utf8")) as IssueSpec[];
    const issueReview = await readFile(join(ledger.runDir, "issue-review.md"), "utf8");

    expect(result.issueNumbers).toEqual([1]);
    expect(manifest.stage).toBe("ready_for_hands");
    expect(manifest.issue_numbers).toEqual([1]);
    expect(research).toContain("Understand the CLI entrypoint.");
    expect(architecturePlan).toContain(
      "Use the workflow planner to create reviewed issues before GitHub issue creation.",
    );
    expect(issueReview).toContain("Reviewed init issue");
    expect(issues).toEqual([reviewedIssue]);
    expect(github.createdIssues).toEqual([reviewedIssue]);
  });

  it("falls back to a deterministic dry-run issue when planner output is not valid issue JSON", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-plan-"));
    const ledger = await createRunLedger({
      repoRoot,
      originalRequest: "Build init command",
      slug: "build-init-command",
      now: new Date("2026-07-08T12:00:00.000Z"),
    });

    const result = await planRun({
      repoRoot,
      runDir: ledger.runDir,
      config: defaultConfig(),
      codex: new DryRunCodexAdapter(),
      github: new DryRunGitHubAdapter(),
      workflowDesign: "design",
      dryRun: true,
    });

    const manifest = await readManifest(ledger.runDir);
    const research = await readFile(join(ledger.runDir, "research.md"), "utf8");
    const issues = JSON.parse(await readFile(join(ledger.runDir, "issues.json"), "utf8")) as IssueSpec[];
    const fallbackIssue = issues[0];

    expect(result.issueNumbers).toEqual([1]);
    expect(manifest.stage).toBe("ready_for_hands");
    expect(manifest.issue_numbers).toEqual([1]);
    expect(research).toContain("DRY_RUN");
    expect(fallbackIssue.run_id).toBe(ledger.runId);
    expect(fallbackIssue.parent_request).toBe("Build init command");
    expect(fallbackIssue.goal).toBe("Dry-run planning follow-up");
    expect(fallbackIssue.verification.required_commands).toEqual([
      "npm test -- tests/workflow/orchestrator.test.ts",
    ]);
  });

  it("fails closed on invalid planner JSON outside dry-run mode", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-plan-"));
    const ledger = await createRunLedger({
      repoRoot,
      originalRequest: "Build init command",
      slug: "build-init-command",
      now: new Date("2026-07-08T12:00:00.000Z"),
    });

    await expect(
      planRun({
        repoRoot,
        runDir: ledger.runDir,
        config: defaultConfig(),
        codex: new ScriptedCodexAdapter(["not valid issue json"]),
        github: new RecordingGitHubAdapter(),
        workflowDesign: "design",
        dryRun: false,
      }),
    ).rejects.toThrow("Failed to parse planner output into IssueSpec JSON");
  });

  it("rejects empty planner issues outside dry-run mode", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-plan-"));
    const ledger = await createRunLedger({
      repoRoot,
      originalRequest: "Build init command",
      slug: "build-init-command",
      now: new Date("2026-07-08T12:00:00.000Z"),
    });

    await expect(
      planRun({
        repoRoot,
        runDir: ledger.runDir,
        config: defaultConfig(),
        codex: new ScriptedCodexAdapter(["[]"]),
        github: new RecordingGitHubAdapter(),
        workflowDesign: "design",
        dryRun: false,
      }),
    ).rejects.toThrow("planner output produced zero issues");
  });

  it("rejects empty critic issues outside dry-run mode", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-plan-"));
    const ledger = await createRunLedger({
      repoRoot,
      originalRequest: "Build init command",
      slug: "build-init-command",
      now: new Date("2026-07-08T12:00:00.000Z"),
    });

    const draftedIssue = createIssueSpec({
      goal: "Draft init issue",
      context: "Initial planner output.",
    });

    await expect(
      planRun({
        repoRoot,
        runDir: ledger.runDir,
        config: defaultConfig(),
        codex: new ScriptedCodexAdapter([JSON.stringify([draftedIssue]), "[]"]),
        github: new RecordingGitHubAdapter(),
        workflowDesign: "design",
        dryRun: false,
      }),
    ).rejects.toThrow("critic output produced zero issues");
  });
});
