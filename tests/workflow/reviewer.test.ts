import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type {
  CodexAdapter,
  CodexInvokeInput,
  CodexInvokeResult,
} from "../../src/adapters/codex.js";
import type { GitHubAdapter, OpenPullRequestInput } from "../../src/adapters/github.js";
import { defaultConfig } from "../../src/core/config.js";
import { createRunLedger, readManifest, updateManifest } from "../../src/core/ledger.js";
import type { IssueSpec, PrReview } from "../../src/core/types.js";
import {
  BrainReviewFailedError,
  EmptyReviewFindingsError,
  HandsFixFailedError,
  MalformedReviewOutputError,
  RetryLimitExceededError,
  applyFixes,
  reviewPullRequest,
} from "../../src/workflow/reviewer.js";

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
    run_id: "2026-07-08T12-00-00-000Z-build-review-flow",
    parent_request: "Build review flow",
    goal: "Implement the review workflow",
    context: "The CLI needs review and fix entry points.",
    scope: {
      include: ["src/workflow/reviewer.ts", "src/cli.ts"],
      exclude: ["automatic merge operations"],
    },
    dependencies: [],
    implementation_steps: ["Add review and fix workflows."],
    acceptance_criteria: ["Review and fixer commands are wired into the CLI."],
    verification: {
      required_commands: ["npm test -- tests/workflow/reviewer.test.ts"],
      manual_checks: [],
      expected_artifacts: ["reviews/pr-101-review.json", "fixes-pr-101.md"],
    },
    review_checklist: ["Review output is schema-validated."],
    risk_register: ["Malformed model output could incorrectly approve a PR."],
    handoff_prompt: "Implement the review flow without auto-merging.",
    ...overrides,
  };
}

function createReview(overrides: Partial<PrReview> = {}): PrReview {
  return {
    decision: "approve",
    requirement_coverage: {
      passed: ["CLI exposes review and fix commands."],
      failed: [],
    },
    verification: {
      commands_reviewed: ["npm test -- tests/workflow/reviewer.test.ts"],
      commands_missing: [],
      artifacts_reviewed: ["verification/issue-42/evidence.json"],
    },
    findings: [],
    residual_risks: [],
    ...overrides,
  };
}

class RecordingCodexAdapter implements CodexAdapter {
  public readonly invocations: CodexInvokeInput[] = [];

  constructor(
    private readonly text: string,
    private readonly exitCode: number | null = 0,
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
  public readonly comments: Array<{ prNumber: number; body: string }> = [];

  async createIssue(_issue: IssueSpec): Promise<number> {
    throw new Error("Unexpected createIssue call");
  }

  async updateIssue(_issueNumber: number, _issue: IssueSpec): Promise<void> {}

  async addIssueLabels(_issueNumber: number, _labels: string[]): Promise<void> {}

  async openPullRequest(_input: OpenPullRequestInput): Promise<number> {
    throw new Error("Unexpected openPullRequest call");
  }

  async commentOnPullRequest(prNumber: number, body: string): Promise<void> {
    this.comments.push({ prNumber, body });
  }
}

async function seedRun(
  issueNumber = 42,
): Promise<{ runDir: string; issue: IssueSpec }> {
  repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-reviewer-"));
  await writeFile(join(repoRoot, "tracked.txt"), "first\n", "utf8");
  execFileSync("git", ["init"], { cwd: repoRoot });
  execFileSync("git", ["config", "user.name", "Codex Test"], { cwd: repoRoot });
  execFileSync("git", ["config", "user.email", "codex@example.com"], { cwd: repoRoot });
  execFileSync("git", ["add", "tracked.txt"], { cwd: repoRoot });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: repoRoot });
  await writeFile(join(repoRoot, "tracked.txt"), "second\n", "utf8");
  execFileSync("git", ["commit", "-am", "second"], { cwd: repoRoot });

  const ledger = await createRunLedger({
    repoRoot,
    originalRequest: "Build review flow",
    slug: "build-review-flow",
    now: new Date("2026-07-08T12:00:00.000Z"),
  });

  const issue = createIssueSpec();
  await writeFile(join(ledger.runDir, "architecture-plan.md"), "Architecture plan\n", "utf8");
  await writeFile(join(ledger.runDir, "issues.json"), `${JSON.stringify([issue], null, 2)}\n`, "utf8");
  await mkdir(join(ledger.runDir, "verification", `issue-${issueNumber}`), { recursive: true });
  await writeFile(
    join(ledger.runDir, "verification", `issue-${issueNumber}`, "evidence.json"),
    `${JSON.stringify({
      issue_number: issueNumber,
      commands: [
        {
          command: "npm test -- tests/workflow/reviewer.test.ts",
          exit_code: 0,
          timed_out: false,
          error_code: null,
          error_message: null,
          signal: null,
          stdout_path: "stdout.txt",
          stderr_path: "stderr.txt",
        },
      ],
      artifacts: ["dist/index.js"],
      created_at: "2026-07-08T12:00:00.000Z",
    }, null, 2)}\n`,
    "utf8",
  );
  await updateManifest(ledger.runDir, {
    stage: "pull_request",
    current_issue: issueNumber,
    current_pr: 101,
    issue_numbers: [issueNumber],
    pr_numbers: [101],
  });

  return { runDir: ledger.runDir, issue };
}

async function writeStoredReview(runDir: string, review: PrReview): Promise<void> {
  await writeFile(
    join(runDir, "reviews", "pr-101-review.json"),
    `${JSON.stringify(review, null, 2)}\n`,
    "utf8",
  );
}

describe("reviewPullRequest", () => {
  it("stores a fallback approval during dry-run malformed reviewer output and advances to merge_ready", async () => {
    const { runDir } = await seedRun();
    const codex = new RecordingCodexAdapter("not valid json");
    const github = new RecordingGitHubAdapter();

    const result = await reviewPullRequest({
      repoRoot: repoRoot!,
      runDir,
      issueNumber: 42,
      prNumber: 101,
      config: defaultConfig(),
      codex,
      github,
      dryRun: true,
    });

    const manifest = await readManifest(runDir);
    const storedReview = JSON.parse(
      await readFile(join(runDir, "reviews", "pr-101-review.json"), "utf8"),
    ) as PrReview;

    expect(result.review.decision).toBe("approve");
    expect(storedReview.decision).toBe("approve");
    expect(storedReview.residual_risks).toContain(
      "Reviewer output could not be parsed in dry-run mode.",
    );
    expect(manifest.stage).toBe("merge_ready");
    expect(github.comments).toHaveLength(0);
  });

  it("rejects malformed live reviewer output and does not advance to merge_ready", async () => {
    const { runDir } = await seedRun();

    await expect(
      reviewPullRequest({
        repoRoot: repoRoot!,
        runDir,
        issueNumber: 42,
        prNumber: 101,
        config: defaultConfig(),
        codex: new RecordingCodexAdapter("definitely not json"),
        github: new RecordingGitHubAdapter(),
        dryRun: false,
      }),
    ).rejects.toBeInstanceOf(MalformedReviewOutputError);

    const manifest = await readManifest(runDir);

    expect(manifest.stage).toBe("brain_review");
    expect(manifest.current_pr).toBe(101);
    await expect(access(join(runDir, "reviews", "pr-101-review.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("fails closed when request_changes has zero findings", async () => {
    const { runDir } = await seedRun();
    const github = new RecordingGitHubAdapter();
    const review = createReview({
      decision: "request_changes",
      findings: [],
    });

    await expect(
      reviewPullRequest({
        repoRoot: repoRoot!,
        runDir,
        issueNumber: 42,
        prNumber: 101,
        config: defaultConfig(),
        codex: new RecordingCodexAdapter(JSON.stringify(review)),
        github,
        dryRun: false,
      }),
    ).rejects.toBeInstanceOf(EmptyReviewFindingsError);

    const manifest = await readManifest(runDir);
    const storedReview = JSON.parse(
      await readFile(join(runDir, "reviews", "pr-101-review.json"), "utf8"),
    ) as PrReview;

    expect(storedReview.decision).toBe("request_changes");
    expect(storedReview.findings).toEqual([]);
    expect(manifest.stage).toBe("brain_review");
    expect(manifest.retry_counts["pr:101"]).toBeUndefined();
    expect(github.comments).toHaveLength(0);
  });

  it("comments request_changes findings and advances to fixing", async () => {
    const { runDir } = await seedRun();
    const github = new RecordingGitHubAdapter();
    const review = createReview({
      decision: "request_changes",
      findings: [
        {
          severity: "high",
          file: "src/cli.ts",
          line: 110,
          problem: "Review command skips validation.",
          required_fix: "Validate the PR number before invoking the reviewer.",
          verification_after_fix: "npm test -- tests/workflow/reviewer.test.ts",
        },
        {
          severity: "medium",
          file: "src/workflow/reviewer.ts",
          line: 40,
          problem: "Malformed reviewer output is silently accepted.",
          required_fix: "Fail closed outside dry-run mode.",
          verification_after_fix: "npm test -- tests/workflow/reviewer.test.ts",
        },
      ],
    });

    const result = await reviewPullRequest({
      repoRoot: repoRoot!,
      runDir,
      issueNumber: 42,
      prNumber: 101,
      config: defaultConfig(),
      codex: new RecordingCodexAdapter(`\`\`\`json\n${JSON.stringify(review, null, 2)}\n\`\`\``),
      github,
      dryRun: false,
    });

    const manifest = await readManifest(runDir);

    expect(result.commentCount).toBe(2);
    expect(result.retryCount).toBe(0);
    expect(github.comments).toHaveLength(2);
    expect(github.comments[0].body).toContain("**HIGH** src/cli.ts:110");
    expect(github.comments[1].body).toContain("Fail closed outside dry-run mode.");
    expect(manifest.stage).toBe("fixing");
    expect(manifest.retry_counts["pr:101"]).toBeUndefined();
  });

  it.each([1, null])("fails closed when reviewer Codex exits %s", async (exitCode) => {
    const { runDir } = await seedRun();

    await expect(
      reviewPullRequest({
        repoRoot: repoRoot!,
        runDir,
        issueNumber: 42,
        prNumber: 101,
        config: defaultConfig(),
        codex: new RecordingCodexAdapter("{}", exitCode),
        github: new RecordingGitHubAdapter(),
        dryRun: false,
      }),
    ).rejects.toBeInstanceOf(BrainReviewFailedError);

    const manifest = await readManifest(runDir);

    expect(manifest.stage).toBe("brain_review");
    await expect(access(join(runDir, "reviews", "pr-101-review.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

describe("applyFixes", () => {
  it("invokes hands_fixer using stored findings and advances to local_verification", async () => {
    const { runDir } = await seedRun();
    const storedReview = createReview({
      decision: "request_changes",
      findings: [
        {
          severity: "medium",
          file: "src/workflow/reviewer.ts",
          line: 88,
          problem: "Fix workflow does not mention findings in the prompt.",
          required_fix: "Pass the stored findings into hands-fixer.",
          verification_after_fix: "npm test -- tests/workflow/reviewer.test.ts",
        },
      ],
    });
    await writeStoredReview(runDir, storedReview);
    await updateManifest(runDir, {
      stage: "fixing",
      retry_counts: {
        "pr:101": 1,
      },
    });

    const codex = new RecordingCodexAdapter("Fixed the stored findings.\n");
    const result = await applyFixes({
      repoRoot: repoRoot!,
      runDir,
      issueNumber: 42,
      prNumber: 101,
      config: defaultConfig(),
      codex,
      dryRun: false,
    });

    const manifest = await readManifest(runDir);
    const fixesArtifact = await readFile(join(runDir, "fixes-pr-101.md"), "utf8");

    expect(codex.invocations).toHaveLength(1);
    expect(codex.invocations[0].role).toBe("hands_fixer");
    expect(codex.invocations[0].prompt).toContain("Pass the stored findings into hands-fixer.");
    expect(result.retryCount).toBe(2);
    expect(fixesArtifact).toContain("Fixed the stored findings.");
    expect(manifest.stage).toBe("local_verification");
    expect(manifest.retry_counts["pr:101"]).toBe(2);
  });

  it("counts actual fix attempts and then rejects at the retry limit", async () => {
    const { runDir } = await seedRun();
    const storedReview = createReview({
      decision: "request_changes",
      findings: [
        {
          severity: "low",
          file: "src/workflow/reviewer.ts",
          line: 10,
          problem: "Retry enforcement is missing.",
          required_fix: "Respect max_hands_fix_attempts.",
          verification_after_fix: "npm test -- tests/workflow/reviewer.test.ts",
        },
      ],
    });
    await writeStoredReview(runDir, storedReview);

    const config = defaultConfig();
    for (let attempt = 1; attempt <= config.retry_policy.max_hands_fix_attempts; attempt += 1) {
      const result = await applyFixes({
        repoRoot: repoRoot!,
        runDir,
        issueNumber: 42,
        prNumber: 101,
        config,
        codex: new RecordingCodexAdapter(`attempt ${attempt}\n`),
        dryRun: false,
      });

      expect(result.retryCount).toBe(attempt);
      await updateManifest(runDir, {
        stage: "fixing",
        current_issue: 42,
        current_pr: 101,
      });
    }

    await expect(
      applyFixes({
        repoRoot: repoRoot!,
        runDir,
        issueNumber: 42,
        prNumber: 101,
        config,
        codex: new RecordingCodexAdapter("should not run"),
        dryRun: false,
      }),
    ).rejects.toBeInstanceOf(RetryLimitExceededError);

    const manifest = await readManifest(runDir);
    expect(manifest.retry_counts["pr:101"]).toBe(config.retry_policy.max_hands_fix_attempts);
  });

  it.each([1, null])("fails closed when hands fixer Codex exits %s", async (exitCode) => {
    const { runDir } = await seedRun();
    const storedReview = createReview({
      decision: "request_changes",
      findings: [
        {
          severity: "medium",
          file: "src/workflow/reviewer.ts",
          line: 12,
          problem: "Fix attempts should count even if the fixer fails.",
          required_fix: "Pre-increment the fix attempt counter.",
          verification_after_fix: "npm test -- tests/workflow/reviewer.test.ts",
        },
      ],
    });
    await writeStoredReview(runDir, storedReview);

    await expect(
      applyFixes({
        repoRoot: repoRoot!,
        runDir,
        issueNumber: 42,
        prNumber: 101,
        config: defaultConfig(),
        codex: new RecordingCodexAdapter("fix failed", exitCode),
        dryRun: false,
      }),
    ).rejects.toBeInstanceOf(HandsFixFailedError);

    const manifest = await readManifest(runDir);

    expect(manifest.stage).toBe("fixing");
    expect(manifest.retry_counts["pr:101"]).toBe(1);
    await expect(access(join(runDir, "fixes-pr-101.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
