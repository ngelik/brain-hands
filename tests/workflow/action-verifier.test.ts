import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CodexAdapter, CodexInvokeInput } from "../../src/adapters/codex.js";
import { createRunLedgerV2 } from "../../src/core/ledger.js";
import type {
  ActionResolutionReview,
  HandsSelfReviewReport,
  ResolvedRunIntake,
  ReviewerAction,
  VerificationEvidence,
  WorkItem,
} from "../../src/core/types.js";
import {
  MAX_FOCUSED_VERIFIER_PROMPT_BYTES,
  verifyReviewerAction,
} from "../../src/workflow/action-verifier.js";
import { executionSpec } from "../fixtures/execution-spec.js";
const codexMetrics = { usage: null, durationMs: 0, processStarted: false, turnStarted: false, structuredTerminalError: false } as const;

const workItem: WorkItem = executionSpec("item-1");

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

const intake: ResolvedRunIntake = {
  task: "Implement one item",
  repo_root: "/tmp/repo",
  mode: "local",
  research: false,
  reflection: false,
  models: { brain: "brain", hands: "hands", verifier: "focused-verifier" },
  resolved_models: { brain: "brain", hands: "hands", verifier: "focused-verifier" },
  roles: {
    brain: { model: "brain", reasoning_effort: "high", sandbox: "read-only" },
    hands: { model: "hands", reasoning_effort: "medium", sandbox: "workspace-write" },
    verifier: { model: "focused-verifier", reasoning_effort: "high", sandbox: "read-only" },
  },
};

const activeVerification: VerificationEvidence = {
  verification_scope: "local",
  work_item_id: "item-1",
  attempt: 1,
  evidence_path: "verification/action-R2-A1/evidence.json",
  commands: [{
    command: "npm test",
    argv: ["npm", "test"],
    exit_code: 0,
    timed_out: false,
    error_code: null,
    error_message: null,
    signal: null,
    stdout_path: "verification/action-R2-A1/stdout.txt",
    stderr_path: "verification/action-R2-A1/stderr.txt",
    result_path: "verification/action-R2-A1/result.json",
    duration_ms: 12,
  }],
  artifacts: [],
  artifact_checks: [],
  browser_evidence: [],
  created_at: "2026-07-11T00:00:00.000Z",
};

const completedVerification: VerificationEvidence = {
  ...activeVerification,
  evidence_path: "verification/action-R2-A0/evidence.json",
  commands: [],
};

const selfReview: HandsSelfReviewReport = {
  work_item_id: "item-1",
  parent_attempt: 2,
  mutation_kind: "normal_fix",
  pass: 1,
  active_action_id: "R2-A1",
  findings: [],
  fixes_applied: ["Completed the example"],
  changed_files: ["src/example.ts"],
  commands_attempted: [["npm", "test"]],
  remaining_findings: [],
  ready_for_resolution_check: true,
};

const resolvedReview: ActionResolutionReview = {
  review_revision: 2,
  action_id: "R2-A1",
  action_attempt: 1,
  decision: "resolved",
  evidence_reviewed: ["verification/action-R2-A1/evidence.json"],
  remaining_problem: null,
  required_next_fix: null,
};

interface RecordingCodex extends CodexAdapter {
  readonly calls: CodexInvokeInput[];
}

class RecordingVerifier implements RecordingCodex {
  readonly calls: CodexInvokeInput[] = [];

  constructor(private readonly review: ActionResolutionReview = resolvedReview) {}

  async invoke(input: CodexInvokeInput) {
    this.calls.push(input);
    return {
      text: JSON.stringify(this.review),
      parsed: input.outputParser?.parse(this.review),
      exitCode: 0,
      promptPath: join(input.runDir, "prompts", `${input.artifactName}.md`),
      stdoutPath: join(input.runDir, "responses", `${input.artifactName}.stdout.txt`),
      stderrPath: join(input.runDir, "responses", `${input.artifactName}.stderr.txt`),
      ...codexMetrics,
    };
  }
}

class ReplacingResponseVerifier implements RecordingCodex {
  readonly calls: CodexInvokeInput[] = [];
  private index = 0;

  constructor(private readonly reviews: ActionResolutionReview[]) {}

  async invoke(input: CodexInvokeInput) {
    this.calls.push(input);
    const review = this.reviews[Math.min(this.index++, this.reviews.length - 1)];
    const outputPath = join(input.runDir, "responses", `${input.artifactName}.json`);
    await mkdir(dirname(outputPath), { recursive: true });
    await unlink(outputPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    await writeFile(outputPath, `${JSON.stringify(review, null, 2)}\n`, "utf8");
    return {
      text: JSON.stringify(review),
      parsed: input.outputParser?.parse(review),
      exitCode: 0,
      outputPath,
      promptPath: join(input.runDir, "prompts", `${input.artifactName}.md`),
      stdoutPath: join(input.runDir, "responses", `${input.artifactName}.stdout.txt`),
      stderrPath: join(input.runDir, "responses", `${input.artifactName}.stderr.txt`),
      ...codexMetrics,
    };
  }
}

let root: string | undefined;
let runDir: string | undefined;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
  runDir = undefined;
});

async function persistEvidence(
  targetRunDir: string,
  evidence: VerificationEvidence,
): Promise<void> {
  if (!evidence.evidence_path) throw new Error("test evidence path required");
  const evidencePath = join(targetRunDir, evidence.evidence_path);
  await mkdir(dirname(evidencePath), { recursive: true });
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  for (const command of evidence.commands) {
    const stdoutPath = join(targetRunDir, command.stdout_path);
    const stderrPath = join(targetRunDir, command.stderr_path);
    await mkdir(dirname(stdoutPath), { recursive: true });
    await mkdir(dirname(stderrPath), { recursive: true });
    await writeFile(stdoutPath, "materialized verification proof", "utf8");
    await writeFile(stderrPath, "", "utf8");
    if (!command.result_path) continue;
    const resultPath = join(targetRunDir, command.result_path);
    await mkdir(dirname(resultPath), { recursive: true });
    await writeFile(resultPath, `${JSON.stringify({
      argv: command.argv,
      stdout: "materialized verification proof",
      stderr: "",
      exit_code: command.exit_code,
      duration_ms: command.duration_ms,
      timed_out: command.timed_out,
      error_code: command.error_code,
      error_message: command.error_message,
      signal: command.signal,
    }, null, 2)}\n`, "utf8");
  }
}

interface InvokeOptions {
  review?: ActionResolutionReview;
  workItemOverride?: WorkItem;
  actionOverride?: ReviewerAction;
  ledgerRunDir?: string;
  codex?: RecordingCodex;
  persist?: boolean;
  activeVerificationOverride?: VerificationEvidence;
  completedVerificationOverride?: VerificationEvidence[];
}

async function invoke(options: InvokeOptions = {}) {
  root ??= await mkdtemp(join(tmpdir(), "brain-hands-action-verifier-"));
  const ledger = options.ledgerRunDir
    ? { runDir: options.ledgerRunDir }
    : await createRunLedgerV2({ repoRoot: root, originalRequest: intake.task });
  runDir = ledger.runDir;
  if (options.persist !== false) {
    await persistEvidence(ledger.runDir, activeVerification);
    await persistEvidence(ledger.runDir, completedVerification);
  }
  const selectedAction = options.actionOverride ?? action;
  const review = options.review ?? {
    ...resolvedReview,
    action_id: selectedAction.action_id,
  };
  const codex = options.codex ?? new RecordingVerifier(review);
  const result = await verifyReviewerAction({
    runDir: ledger.runDir,
    worktreePath: join(root, "worktree"),
    workItem: options.workItemOverride ?? workItem,
    intake: { ...intake, repo_root: root },
    codex,
    reviewRevision: 2,
    action: selectedAction,
    actionAttempt: 1,
    beforeDiff: "- incomplete example",
    afterDiff: "+ complete example",
    activeVerification: options.activeVerificationOverride ?? activeVerification,
    completedVerification: options.completedVerificationOverride ?? [completedVerification],
    selfReviewReports: [selfReview],
  });
  return { codex, ledger, result };
}

describe("verifyReviewerAction", () => {
  it("reviews exactly one action and its evidence read-only", async () => {
    const { codex, ledger, result } = await invoke();

    expect(result.review).toEqual(resolvedReview);
    expect(codex.calls[0]).toMatchObject({
      role: "verifier",
      model: "focused-verifier",
      sandbox: "read-only",
      cwd: join(root!, "worktree"),
    });
    expect(codex.calls[0].prompt).toContain('"action_id": "R2-A1"');
    expect(codex.calls[0].prompt).toContain("- incomplete example");
    expect(codex.calls[0].prompt).toContain("+ complete example");
    expect(codex.calls[0].prompt).toContain("verification/action-R2-A0/evidence.json");
    expect(codex.calls[0].prompt).toContain("materialized verification proof");
    expect(codex.calls[0].prompt).toContain("ready_for_resolution_check");
    expect(codex.calls[0].prompt).toContain("Do not review or introduce another action");
    expect(result.reviewPath).toMatch(
      /^action-reviews\/id-[A-Za-z0-9_-]+\/revision-2\/id-[A-Za-z0-9_-]+\/attempt-1\.json$/,
    );
    expect(JSON.parse(await readFile(join(ledger.runDir, result.reviewPath), "utf8")))
      .toEqual(resolvedReview);
  });

  it.each([
    ["revision", { review_revision: 3 }],
    ["action", { action_id: "R2-A2" }],
    ["attempt", { action_attempt: 2 }],
  ])("rejects mismatched %s provenance before persisting a review", async (_label, patch) => {
    await expect(invoke({ review: { ...resolvedReview, ...patch } })).rejects.toThrow(
      "action resolution provenance does not match",
    );

    await expect(readFile(join(runDir!, "action-reviews"), "utf8"))
      .rejects.toThrow();
  });

  it("rejects missing persisted evidence before invoking Codex or persisting resolution", async () => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-action-verifier-missing-evidence-"));
    const ledger = await createRunLedgerV2({ repoRoot: root, originalRequest: intake.task });
    runDir = ledger.runDir;
    const codex = new RecordingVerifier();

    await expect(verifyReviewerAction({
      runDir: ledger.runDir,
      worktreePath: join(root, "worktree"),
      workItem,
      intake: { ...intake, repo_root: root },
      codex,
      reviewRevision: 2,
      action,
      actionAttempt: 1,
      beforeDiff: "before",
      afterDiff: "after",
      activeVerification,
      completedVerification: [],
      selfReviewReports: [selfReview],
    })).rejects.toThrow("Unable to materialize required verification evidence");

    expect(codex.calls).toHaveLength(0);
    await expect(readFile(join(ledger.runDir, "action-reviews"), "utf8"))
      .rejects.toThrow();
  });

  it("rejects corrupt command result evidence before invoking Codex", async () => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-action-verifier-corrupt-evidence-"));
    const ledger = await createRunLedgerV2({ repoRoot: root, originalRequest: intake.task });
    await persistEvidence(ledger.runDir, activeVerification);
    await writeFile(join(ledger.runDir, activeVerification.commands[0].result_path!), "not json\n", "utf8");
    const codex = new RecordingVerifier();

    await expect(verifyReviewerAction({
      runDir: ledger.runDir,
      worktreePath: join(root, "worktree"),
      workItem,
      intake: { ...intake, repo_root: root },
      codex,
      reviewRevision: 2,
      action,
      actionAttempt: 1,
      beforeDiff: "before",
      afterDiff: "after",
      activeVerification,
      completedVerification: [],
      selfReviewReports: [selfReview],
    })).rejects.toThrow("Unable to materialize required verification evidence");

    expect(codex.calls).toHaveLength(0);
  });

  it("rejects stdout or stderr proof that contradicts the command result", async () => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-action-verifier-mismatched-output-"));
    const ledger = await createRunLedgerV2({ repoRoot: root, originalRequest: intake.task });
    await persistEvidence(ledger.runDir, activeVerification);
    await writeFile(
      join(ledger.runDir, activeVerification.commands[0].stdout_path),
      "contradictory stdout\n",
      "utf8",
    );
    const codex = new RecordingVerifier();

    await expect(verifyReviewerAction({
      runDir: ledger.runDir,
      worktreePath: join(root, "worktree"),
      workItem,
      intake: { ...intake, repo_root: root },
      codex,
      reviewRevision: 2,
      action,
      actionAttempt: 1,
      beforeDiff: "before",
      afterDiff: "after",
      activeVerification,
      completedVerification: [],
      selfReviewReports: [selfReview],
    })).rejects.toThrow("stdout does not match command result");

    expect(codex.calls).toHaveLength(0);
  });

  it("rejects a deterministic command without a current-run result path", async () => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-action-verifier-missing-result-path-"));
    const ledger = await createRunLedgerV2({ repoRoot: root, originalRequest: intake.task });
    const missingResult = {
      ...activeVerification,
      commands: activeVerification.commands.map(({ result_path: _resultPath, ...command }) => command),
    };
    await persistEvidence(ledger.runDir, missingResult);
    const codex = new RecordingVerifier();

    await expect(verifyReviewerAction({
      runDir: ledger.runDir,
      worktreePath: join(root, "worktree"),
      workItem,
      intake: { ...intake, repo_root: root },
      codex,
      reviewRevision: 2,
      action,
      actionAttempt: 1,
      beforeDiff: "before",
      afterDiff: "after",
      activeVerification: missingResult,
      completedVerification: [],
      selfReviewReports: [selfReview],
    })).rejects.toThrow("result_path is required");

    expect(codex.calls).toHaveLength(0);
  });

  it("rejects active evidence that omits an action-required verification command", async () => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-action-verifier-missing-action-command-"));
    const ledger = await createRunLedgerV2({ repoRoot: root, originalRequest: intake.task });
    const noCommands = { ...activeVerification, commands: [] };
    await persistEvidence(ledger.runDir, noCommands);
    const codex = new RecordingVerifier();

    await expect(verifyReviewerAction({
      runDir: ledger.runDir,
      worktreePath: join(root, "worktree"),
      workItem,
      intake: { ...intake, repo_root: root },
      codex,
      reviewRevision: 2,
      action,
      actionAttempt: 1,
      beforeDiff: "before",
      afterDiff: "after",
      activeVerification: noCommands,
      completedVerification: [],
      selfReviewReports: [selfReview],
    })).rejects.toThrow("Action-required verification command has no current result");

    expect(codex.calls).toHaveLength(0);
  });

  it.each([
    ["required checked artifact", {
      artifacts: ["reports/required.json"],
      artifact_checks: [{ path: "reports/required.json", exists: true, required: true }],
    }],
    ["browser screenshot", {
      browser_evidence: [{
        name: "desktop",
        url: "https://example.com/",
        status: "passed" as const,
        screenshot_artifact: "reports/desktop.png",
        screenshot_exists: true,
        expected_network: [],
        observed_network: [],
        missing_network: [],
        console_errors: [],
        missing_selectors: [],
        failure_reasons: [],
        evidence_report_path: null,
        skipped_reason: null,
      }],
    }],
  ])("rejects a missing %s used as proof", async (_label, patch) => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-action-verifier-missing-proof-"));
    const ledger = await createRunLedgerV2({ repoRoot: root, originalRequest: intake.task });
    const evidence = { ...activeVerification, ...patch };
    await persistEvidence(ledger.runDir, evidence);
    const codex = new RecordingVerifier();

    await expect(verifyReviewerAction({
      runDir: ledger.runDir,
      worktreePath: join(root, "worktree"),
      workItem,
      intake: { ...intake, repo_root: root },
      codex,
      reviewRevision: 2,
      action,
      actionAttempt: 1,
      beforeDiff: "before",
      afterDiff: "after",
      activeVerification: evidence,
      completedVerification: [],
      selfReviewReports: [selfReview],
    })).rejects.toThrow("Unable to materialize required verification evidence");

    expect(codex.calls).toHaveLength(0);
  });

  it("rejects evidence references outside the verification root", async () => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-action-verifier-escaped-evidence-"));
    const ledger = await createRunLedgerV2({ repoRoot: root, originalRequest: intake.task });
    const escaped = { ...activeVerification, evidence_path: "responses/evidence.json", commands: [] };
    await mkdir(join(ledger.runDir, "responses"), { recursive: true });
    await writeFile(
      join(ledger.runDir, escaped.evidence_path),
      `${JSON.stringify(escaped)}\n`,
      "utf8",
    );
    const codex = new RecordingVerifier();

    await expect(verifyReviewerAction({
      runDir: ledger.runDir,
      worktreePath: join(root, "worktree"),
      workItem,
      intake: { ...intake, repo_root: root },
      codex,
      reviewRevision: 2,
      action,
      actionAttempt: 1,
      beforeDiff: "before",
      afterDiff: "after",
      activeVerification: escaped,
      completedVerification: [],
      selfReviewReports: [selfReview],
    })).rejects.toThrow("must stay within the verification root");

    expect(codex.calls).toHaveLength(0);
  });

  it("rejects evidence reached through a symlinked path component", async () => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-action-verifier-read-symlink-"));
    const ledger = await createRunLedgerV2({ repoRoot: root, originalRequest: intake.task });
    await mkdir(join(ledger.runDir, "verification"), { recursive: true });
    await mkdir(join(ledger.runDir, "outside-evidence"), { recursive: true });
    await symlink("../outside-evidence", join(ledger.runDir, "verification/link"));
    const linkedEvidence = {
      ...activeVerification,
      evidence_path: "verification/link/evidence.json",
      commands: activeVerification.commands.map((command) => ({
        ...command,
        stdout_path: "verification/link/stdout.txt",
        stderr_path: "verification/link/stderr.txt",
        result_path: "verification/link/result.json",
      })),
    };
    await persistEvidence(ledger.runDir, linkedEvidence);
    const codex = new RecordingVerifier();

    await expect(verifyReviewerAction({
      runDir: ledger.runDir,
      worktreePath: join(root, "worktree"),
      workItem,
      intake: { ...intake, repo_root: root },
      codex,
      reviewRevision: 2,
      action,
      actionAttempt: 1,
      beforeDiff: "before",
      afterDiff: "after",
      activeVerification: linkedEvidence,
      completedVerification: [],
      selfReviewReports: [selfReview],
    })).rejects.toThrow("symlink");

    expect(codex.calls).toHaveLength(0);
  });

  it("keeps distinct work-item and action IDs collision-free", async () => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-action-verifier-collisions-"));
    const ledger = await createRunLedgerV2({ repoRoot: root, originalRequest: intake.task });
    await persistEvidence(ledger.runDir, activeVerification);
    await persistEvidence(ledger.runDir, completedVerification);
    const paths: string[] = [];

    for (const [workItemId, actionId] of [
      ["a/b", "x/y"],
      ["a_b", "x_y"],
    ]) {
      const selectedAction = { ...action, action_id: actionId };
      const { result } = await invoke({
        ledgerRunDir: ledger.runDir,
        workItemOverride: { ...workItem, id: workItemId },
        actionOverride: selectedAction,
      });
      paths.push(result.reviewPath);
    }

    expect(new Set(paths).size).toBe(2);
    for (const path of paths) {
      expect(JSON.parse(await readFile(join(ledger.runDir, path), "utf8")))
        .toHaveProperty("decision", "resolved");
    }
  });

  it.each([".", ".."])("encodes dot-segment ID %s safely", async (id) => {
    const selectedAction = { ...action, action_id: id };
    const { result } = await invoke({
      workItemOverride: { ...workItem, id },
      actionOverride: selectedAction,
    });

    expect(result.reviewPath).toMatch(
      /^action-reviews\/id-[A-Za-z0-9_-]+\/revision-2\/id-[A-Za-z0-9_-]+\/attempt-1\.json$/,
    );
    expect(JSON.parse(await readFile(join(runDir!, result.reviewPath), "utf8")))
      .toHaveProperty("action_id", id);
  });

  it("returns the existing artifact when repeated provenance has identical content", async () => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-action-verifier-idempotent-"));
    const ledger = await createRunLedgerV2({ repoRoot: root, originalRequest: intake.task });
    await persistEvidence(ledger.runDir, activeVerification);
    await persistEvidence(ledger.runDir, completedVerification);

    const first = await invoke({ ledgerRunDir: ledger.runDir });
    const second = await invoke({ ledgerRunDir: ledger.runDir });

    expect(second.result.reviewPath).toBe(first.result.reviewPath);
    expect(await readFile(join(ledger.runDir, second.result.reviewPath), "utf8"))
      .toBe(await readFile(join(ledger.runDir, first.result.reviewPath), "utf8"));
  });

  it("rejects repeated provenance with different content without overwriting", async () => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-action-verifier-conflict-"));
    const ledger = await createRunLedgerV2({ repoRoot: root, originalRequest: intake.task });
    await persistEvidence(ledger.runDir, activeVerification);
    await persistEvidence(ledger.runDir, completedVerification);
    const first = await invoke({ ledgerRunDir: ledger.runDir });
    const original = await readFile(join(ledger.runDir, first.result.reviewPath), "utf8");

    await expect(invoke({
      ledgerRunDir: ledger.runDir,
      review: {
        ...resolvedReview,
        decision: "still_open",
        remaining_problem: "The defect remains",
        required_next_fix: "Fix the remaining defect",
      },
    })).rejects.toThrow("already exists with different content");

    expect(await readFile(join(ledger.runDir, first.result.reviewPath), "utf8"))
      .toBe(original);
  });

  it("stages adapter output away from the canonical response before conflict comparison", async () => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-action-verifier-adapter-replace-"));
    const ledger = await createRunLedgerV2({ repoRoot: root, originalRequest: intake.task });
    await persistEvidence(ledger.runDir, activeVerification);
    await persistEvidence(ledger.runDir, completedVerification);
    const stillOpen: ActionResolutionReview = {
      ...resolvedReview,
      decision: "still_open",
      remaining_problem: "The defect remains",
      required_next_fix: "Fix the remaining defect",
    };
    const codex = new ReplacingResponseVerifier([resolvedReview, stillOpen]);

    await invoke({ ledgerRunDir: ledger.runDir, codex });
    const canonicalFiles = (await readdir(join(ledger.runDir, "responses")))
      .filter((file) => file.endsWith(".json"));
    expect(canonicalFiles).toHaveLength(1);
    const canonicalPath = join(ledger.runDir, "responses", canonicalFiles[0]);
    const original = await readFile(canonicalPath, "utf8");

    await expect(invoke({ ledgerRunDir: ledger.runDir, codex }))
      .rejects.toThrow("already exists with different content");

    expect(await readFile(canonicalPath, "utf8")).toBe(original);
    expect(JSON.parse(original)).toHaveProperty("decision", "resolved");
  });

  it("rejects a symlinked canonical write parent before invoking Codex", async () => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-action-verifier-write-symlink-"));
    const ledger = await createRunLedgerV2({ repoRoot: root, originalRequest: intake.task });
    await persistEvidence(ledger.runDir, activeVerification);
    await persistEvidence(ledger.runDir, completedVerification);
    const outside = join(ledger.runDir, "outside-reviews");
    await mkdir(outside, { recursive: true });
    await symlink("outside-reviews", join(ledger.runDir, "action-reviews"));
    const codex = new RecordingVerifier();

    await expect(invoke({ ledgerRunDir: ledger.runDir, codex }))
      .rejects.toThrow("symlink");

    expect(codex.calls).toHaveLength(0);
    expect(await readdir(outside)).toEqual([]);
  });

  it("bounds large command streams while retaining hashes, sizes, and truncation metadata", async () => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-action-verifier-large-stream-"));
    const ledger = await createRunLedgerV2({ repoRoot: root, originalRequest: intake.task });
    const largeStdout = "stream-proof-".repeat(40_000);
    const largeStderr = "stderr-proof-".repeat(40_000);
    await persistEvidence(ledger.runDir, activeVerification);
    await persistEvidence(ledger.runDir, completedVerification);
    await writeFile(
      join(ledger.runDir, activeVerification.commands[0].stdout_path),
      largeStdout,
      "utf8",
    );
    await writeFile(
      join(ledger.runDir, activeVerification.commands[0].stderr_path),
      largeStderr,
      "utf8",
    );
    await writeFile(
      join(ledger.runDir, activeVerification.commands[0].result_path!),
      `${JSON.stringify({
        argv: activeVerification.commands[0].argv,
        stdout: largeStdout,
        stderr: largeStderr,
        exit_code: 0,
        duration_ms: 12,
        timed_out: false,
        error_code: null,
        error_message: null,
        signal: null,
      })}\n`,
      "utf8",
    );
    const codex = new RecordingVerifier();

    await invoke({ ledgerRunDir: ledger.runDir, codex, persist: false });

    const prompt = codex.calls[0].prompt;
    expect(Buffer.byteLength(prompt, "utf8")).toBeLessThan(80_000);
    expect(prompt).toContain(createHash("sha256").update(largeStdout).digest("hex"));
    expect(prompt).toContain(`"size_bytes": ${Buffer.byteLength(largeStdout)}`);
    expect(prompt).toContain("[truncated: showing");
    expect(prompt).not.toContain(largeStdout);
  });

  it("omits large binary proof content while retaining canonical paths, hashes, and sizes", async () => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-action-verifier-large-binary-"));
    const ledger = await createRunLedgerV2({ repoRoot: root, originalRequest: intake.task });
    const artifact = Buffer.alloc(400_000, 0xa5);
    const screenshot = Buffer.alloc(500_000, 0x5a);
    const proofEvidence: VerificationEvidence = {
      ...activeVerification,
      artifacts: ["reports/build.bin", "reports/desktop.png"],
      artifact_checks: [
        { path: "reports/build.bin", exists: true, required: true },
        { path: "reports/desktop.png", exists: true, required: true },
      ],
      browser_evidence: [{
        name: "desktop",
        url: "https://example.com/",
        status: "passed",
        screenshot_artifact: "reports/desktop.png",
        screenshot_exists: true,
        expected_network: [],
        observed_network: [],
        missing_network: [],
        console_errors: [],
        missing_selectors: [],
        failure_reasons: [],
        evidence_report_path: null,
        skipped_reason: null,
      }],
    };
    await persistEvidence(ledger.runDir, proofEvidence);
    await persistEvidence(ledger.runDir, completedVerification);
    await mkdir(join(root, "worktree/reports"), { recursive: true });
    await writeFile(join(root, "worktree/reports/build.bin"), artifact);
    await writeFile(join(root, "worktree/reports/desktop.png"), screenshot);
    const codex = new RecordingVerifier();

    await invoke({
      ledgerRunDir: ledger.runDir,
      codex,
      persist: false,
      activeVerificationOverride: proofEvidence,
    });

    const prompt = codex.calls[0].prompt;
    expect(Buffer.byteLength(prompt, "utf8")).toBeLessThan(80_000);
    expect(prompt).toContain(createHash("sha256").update(artifact).digest("hex"));
    expect(prompt).toContain(createHash("sha256").update(screenshot).digest("hex"));
    expect(prompt).toContain(`"size_bytes": ${artifact.byteLength}`);
    expect(prompt).toContain(`"size_bytes": ${screenshot.byteLength}`);
    expect(prompt).toContain(join(root, "worktree/reports/build.bin"));
    expect(prompt).toContain('"content_omitted": true');
    expect(prompt).not.toContain(artifact.toString("base64"));
    expect(prompt).not.toContain(screenshot.toString("base64"));
  });

  it("bounds the complete prompt for metadata-heavy active and completed evidence", async () => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-action-verifier-heavy-metadata-"));
    const ledger = await createRunLedgerV2({ repoRoot: root, originalRequest: intake.task });
    const hugeCommandLabel = "metadata-command-".repeat(20_000);
    const hugeError = "metadata-error-".repeat(20_000);
    const hugePaths = Array.from(
      { length: 2_000 },
      (_entry, index) => `reports/metadata-${index}-${"p".repeat(80)}.json`,
    );
    const hugeConsole = Array.from(
      { length: 2_000 },
      (_entry, index) => `console-${index}-${"e".repeat(100)}`,
    );
    const metadataHeavy: VerificationEvidence = {
      ...activeVerification,
      commands: activeVerification.commands.map((command) => ({
        ...command,
        command: hugeCommandLabel,
        error_code: "E_METADATA",
        error_message: hugeError,
      })),
      artifacts: hugePaths,
      browser_evidence: [{
        name: "metadata-only-browser",
        url: "https://example.com/",
        status: "failed",
        screenshot_artifact: "reports/not-used.png",
        screenshot_exists: false,
        expected_network: hugePaths,
        observed_network: [],
        missing_network: hugePaths,
        console_errors: hugeConsole,
        missing_selectors: hugeConsole,
        failure_reasons: hugeConsole,
        evidence_report_path: null,
        skipped_reason: null,
      }],
    };
    const completedHeavy: VerificationEvidence = {
      ...metadataHeavy,
      evidence_path: "verification/action-R2-A0/evidence.json",
      commands: [],
    };
    await persistEvidence(ledger.runDir, metadataHeavy);
    await persistEvidence(ledger.runDir, completedHeavy);
    const evidenceBytes = await readFile(join(ledger.runDir, metadataHeavy.evidence_path!));
    const codex = new RecordingVerifier();

    await invoke({
      ledgerRunDir: ledger.runDir,
      codex,
      persist: false,
      activeVerificationOverride: metadataHeavy,
      completedVerificationOverride: [completedHeavy],
    });

    const prompt = codex.calls[0].prompt;
    expect(Buffer.byteLength(prompt, "utf8")).toBeLessThanOrEqual(
      MAX_FOCUSED_VERIFIER_PROMPT_BYTES,
    );
    expect(prompt).toContain('"action_id": "R2-A1"');
    expect(prompt).toContain(createHash("sha256").update(evidenceBytes).digest("hex"));
    expect(prompt).toContain(createHash("sha256").update(hugeError).digest("hex"));
    expect(prompt).toContain(`"size_bytes": ${evidenceBytes.byteLength}`);
    expect(prompt).toContain("[truncated:");
    expect(prompt).not.toContain(hugeCommandLabel);
    expect(prompt).not.toContain(hugeError);
    expect(prompt).not.toContain(hugeConsole.at(-1)!);
  });
});
