import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type { CodexAdapter, CodexInvokeInput } from "../../src/adapters/codex.js";
import { approvePlanRevision, createRunLedgerV2, readManifestV2, recordPlan, updateManifestV2, writeImmutableValidatedJson } from "../../src/core/ledger.js";
import type { ImplementationResult, ResolvedRunIntake, VerificationEvidence, VerifierReview, WorkItem } from "../../src/core/types.js";
import { assertVerifierScopeSnapshot, verifyWorkItem } from "../../src/workflow/verifier.js";
import { executionSpec } from "../fixtures/execution-spec.js";
import { openProgressReporter, readProgressEvents } from "../../src/progress/log.js";
import { implementationResultSchema, persistedVerifierReviewSchema, verificationEvidenceSchema, verificationExecutionResultSchema } from "../../src/core/schema.js";
import { buildVerifierContext, loadRoleContext } from "../../src/workflow/role-context.js";
import { buildVerifierEvidenceIndex } from "../../src/workflow/evidence-index.js";
import { integratedWorkItem } from "../../src/workflow/integrated-work-item.js";
import type { BrainPlan } from "../../src/core/types.js";
import { persistWorkItemSummary } from "../../src/workflow/work-item-summaries.js";
import { execFileSync } from "node:child_process";
import { collectScopedWorktreeDiff } from "../../src/adapters/git.js";
import { readdir } from "node:fs/promises";
import { normalizeReviewerActions, validateReviewerActionQueue } from "../../src/workflow/reviewer-actions.js";
import { createLegacyRunLedgerV2 } from "../fixtures/legacy-run.js";
const codexMetrics = { usage: null, durationMs: 0, processStarted: false, turnStarted: false, structuredTerminalError: false } as const;

const item: WorkItem = executionSpec("item-1");
const implementation: ImplementationResult = {
  work_item_id: "item-1", changed_files: ["src/example.ts"], tests_added_or_changed: [],
  commands_attempted: [["npm", "test"]], completed_steps: ["Done"], remaining_risks: [],
};
const evidence = {
  verification_scope: "local", work_item_id: "item-1", attempt: 1, evidence_path: "verification/local/aXRlbS0x/attempt-1/evidence.json", commands: [{ command: "npm test", argv: ["npm", "test"], exit_code: 0, timed_out: false, error_code: null, error_message: null, signal: null, stdout_path: "verification/local/aXRlbS0x/attempt-1/stdout.txt", stderr_path: "verification/local/aXRlbS0x/attempt-1/stderr.txt", result_path: "verification/local/aXRlbS0x/attempt-1/result.json" }], artifacts: ["reports/result.json"], artifact_checks: [{ path: "reports/result.json", exists: true, required: true }], browser_evidence: [], created_at: new Date().toISOString(),
} as VerificationEvidence;
const review: VerifierReview = {
  work_item_id: "item-1", attempt: 1, final: false,
  decision: "approve", failure_class: "none", blocker: null,
  blocker_code: null,
  acceptance_coverage: ["The change works"], evidence_reviewed: ["verification"], findings: [], residual_risks: [],
};
const intake: ResolvedRunIntake = {
  task: "Review one item", repo_root: "/tmp/repo", mode: "local", research: false, reflection: false,
  models: { brain: "brain", hands: "hands", verifier: "verifier" }, resolved_models: { brain: "brain", hands: "hands", verifier: "verifier" },
  roles: {
    brain: { model: "brain", reasoning_effort: "high", sandbox: "read-only" }, hands: { model: "hands", reasoning_effort: "medium", sandbox: "workspace-write" }, verifier: { model: "verifier", reasoning_effort: "high", sandbox: "read-only" },
  },
};
class RecordingVerifier implements CodexAdapter {
  calls: CodexInvokeInput[] = [];
  async invoke(input: CodexInvokeInput) {
    this.calls.push(input);
    return { text: JSON.stringify(review), parsed: review, exitCode: 0,
      promptPath: join(input.runDir, "prompts", `${input.artifactName}.md`), stdoutPath: join(input.runDir, "responses", `${input.artifactName}.stdout.txt`), stderrPath: join(input.runDir, "responses", `${input.artifactName}.stderr.txt`), ...codexMetrics };
  }
}
class ExactCoverageVerifier implements CodexAdapter {
  calls: CodexInvokeInput[] = [];
  constructor(private readonly value: VerifierReview = { ...review, acceptance_coverage: item.completion_contract.required_acceptance_ids }) {}
  async invoke(input: CodexInvokeInput) {
    this.calls.push(input);
    return { text: JSON.stringify(this.value), parsed: this.value, exitCode: 0,
      promptPath: join(input.runDir, "prompts", `${input.artifactName}.md`), stdoutPath: join(input.runDir, "responses", `${input.artifactName}.stdout.txt`), stderrPath: join(input.runDir, "responses", `${input.artifactName}.stderr.txt`), ...codexMetrics };
  }
}
class ParserHonoringVerifier implements CodexAdapter {
  calls: CodexInvokeInput[] = [];
  async invoke(input: CodexInvokeInput) {
    this.calls.push(input);
    const generated = {
      work_item_id: "item-1",
      attempt: 1,
      final: false,
      decision: "request_changes",
      failure_class: "implementation_failure",
      blocker: null,
      blocker_code: null,
      acceptance_coverage: [],
      evidence_reviewed: ["verification"],
      findings: [{
        severity: "medium",
        file: "src/item-1.ts",
        line: 10,
        acceptance_criterion: "item-1-AC-01",
        problem_class: "correctness",
        problem: "The change fails",
        required_fix: "Correct the change",
        evidence_refs: ["verification/result.json"],
        remediation: {
          schema_version: 1,
          diagnosis: {
            observed_behavior: "The change fails", expected_behavior: "The change works",
            failure_mechanism: "The required behavior is missing.", reproduction: ["Run npm test."],
            evidence_refs: ["verification/result.json"],
          },
          targets: [{ kind: "code", path: "src/item-1.ts", symbol: "item", line_hint: 10 }],
          remediation: {
            strategy: "Correct the change.",
            change_units: [{ id: "FIX-1", path: "src/item-1.ts", target: "item", operation: "modify", requirements: ["Make item-1 work."], satisfies: ["SC-1"] }],
            allowed_files: ["src/item-1.ts"], forbidden_changes: [],
          },
          verification: {
            commands: [{ id: "CMD-1", argv: ["npm", "test"] }],
            success_conditions: [{ id: "SC-1", statement: "The change works.", satisfied_by: ["CMD-1", "EVID-1"] }],
            required_evidence: [{ id: "EVID-1", kind: "test_result", source_id: "CMD-1", output_path: "verification/result.json" }],
          },
          completion_contract: { required_change_unit_ids: ["FIX-1"], expected_changed_files: ["src/item-1.ts"], allow_additional_files: false },
        },
        action_id: "R1-A1",
        order: 1,
        depends_on: [],
      }],
      residual_risks: [],
    };
    const parsed = input.outputParser?.parse(generated);
    return { text: JSON.stringify(generated), parsed, exitCode: 0,
      promptPath: join(input.runDir, "prompts", `${input.artifactName}.md`), stdoutPath: join(input.runDir, "responses", `${input.artifactName}.stdout.txt`), stderrPath: join(input.runDir, "responses", `${input.artifactName}.stderr.txt`), ...codexMetrics };
  }
}
let root: string | undefined;
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = undefined; });

async function gitWorktree(rootPath: string): Promise<{ worktreePath: string; baseCommit: string }> {
  const worktreePath = join(rootPath, "worktree");
  await mkdir(worktreePath, { recursive: true });
  execFileSync("git", ["init"], { cwd: worktreePath });
  execFileSync("git", ["config", "user.name", "Codex Test"], { cwd: worktreePath });
  execFileSync("git", ["config", "user.email", "codex@example.com"], { cwd: worktreePath });
  execFileSync("git", ["commit", "--allow-empty", "-m", "initial"], { cwd: worktreePath });
  return { worktreePath, baseCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: worktreePath, encoding: "utf8" }).trim() };
}

async function boundedVerifierFixture(legacy = false) {
  root = await mkdtemp(join(tmpdir(), "brain-hands-bounded-verifier-"));
  const git = await gitWorktree(root);
  await mkdir(join(git.worktreePath, "src"), { recursive: true });
  await writeFile(join(git.worktreePath, "src/item-1.ts"), "export const item = 1;\n");
  const createLedger = legacy ? createLegacyRunLedgerV2 : createRunLedgerV2;
  const ledger = await createLedger({ repoRoot: root, originalRequest: intake.task, sourceCommit: git.baseCommit, worktreePath: git.worktreePath, branchName: "test-verifier" });
  const plan = await recordPlan(ledger.runDir, JSON.stringify({ work_items: [item] }));
  await approvePlanRevision(ledger.runDir, plan.revision);
  const boundedImplementation = { ...implementation, changed_files: ["src/item-1.ts"] };
  const implementationRef = await writeImmutableValidatedJson(
    ledger.runDir,
    "implementation/item-1/attempt-1.json",
    implementationResultSchema,
    boundedImplementation,
  );
  const namespace = "verification/local/aXRlbS0x/attempt-1";
  const resultRef = await writeImmutableValidatedJson(
    ledger.runDir,
    `${namespace}/result.json`,
    verificationExecutionResultSchema,
    { argv: ["npm", "test"], stdout: "UNRELATED_RAW_STDOUT_SENTINEL\n", stderr: "", exit_code: 0, duration_ms: 1, timed_out: false, error_code: null, error_message: null, signal: null },
  );
  await writeFile(join(ledger.runDir, `${namespace}/stdout.txt`), "UNRELATED_RAW_STDOUT_SENTINEL\n");
  await writeFile(join(ledger.runDir, `${namespace}/stderr.txt`), "");
  const evidenceRef = await writeImmutableValidatedJson(
    ledger.runDir,
    `${namespace}/evidence.json`,
    verificationEvidenceSchema,
    {
      verification_scope: "local", work_item_id: item.id, attempt: 1, evidence_path: `${namespace}/evidence.json`,
      commands: [{ command: "npm test", argv: ["npm", "test"], exit_code: 0, timed_out: false, error_code: null, error_message: null, signal: null, stdout_path: `${namespace}/stdout.txt`, stderr_path: `${namespace}/stderr.txt`, result_path: resultRef.path }],
      artifacts: [], artifact_checks: [{ path: "reports/result.json", exists: true, required: true }], browser_evidence: [], created_at: new Date().toISOString(),
    },
  );
  const manifest = await readManifestV2(ledger.runDir);
  await updateManifestV2(ledger.runDir, { work_item_progress: { ...manifest.work_item_progress, [item.id]: { status: "in_progress", attempts: 1, context_base_commit: git.baseCommit, context_plan_revision: plan.revision, implementation_path: implementationRef.path, verification_path: evidenceRef.path } } });
  const snapshot = await collectScopedWorktreeDiff({ repoRoot: git.worktreePath, baseCommit: git.baseCommit, workItem: item });
  const contextRef = await buildVerifierContext({ runDir: ledger.runDir, workItemId: item.id, phase: "work_item", attempt: 1, acceptanceContract: item.acceptance, changedFiles: snapshot.changed_files, diff: snapshot.patch, evidenceIndexRef: null });
  return { ledger, contextRef, context: await loadRoleContext(ledger.runDir, contextRef, "verifier"), ...git };
}

describe("verifyWorkItem", () => {
  it("renders only the validated immutable package for bounded review", async () => {
    const { ledger, contextRef, context } = await boundedVerifierFixture();
    await mkdir(join(root!, "worktree/unrelated"), { recursive: true });
    await writeFile(join(root!, "worktree/unrelated/history.json"), "UNRELATED_WORKTREE_ARTIFACT_SENTINEL");
    const codex = new ExactCoverageVerifier();
    const result = await verifyWorkItem({ runDir: ledger.runDir, worktreePath: join(root!, "worktree"), workItem: item, contextRef, context, phase: "work_item", final: false, intake: { ...intake, repo_root: root! }, codex, attempt: 1 });

    const prompt = codex.calls[0]!.prompt;
    const normalizedPrompt = prompt.replace(/\s+/g, " ");
    expect(prompt).toContain(contextRef.sha256);
    expect(prompt).toContain('"acceptance_contract"');
    expect(prompt).toContain('"changed_files"');
    expect(prompt).toContain('"command_evidence"');
    expect(prompt).toContain('"artifact_checks"');
    expect(prompt).toContain('"evidence_index_ref": null');
    expect(prompt).not.toContain(ledger.runDir);
    expect(prompt).not.toContain("evidence root");
    expect(prompt).not.toContain("Prior per-item verification evidence");
    expect(prompt).not.toContain("UNRELATED_RAW_STDOUT_SENTINEL");
    expect(prompt).not.toContain("UNRELATED_WORKTREE_ARTIFACT_SENTINEL");
    expect(prompt).not.toContain('"implementation"');
    expect(prompt).not.toContain('"priorVerification"');
    expect(prompt).toContain("satisfied_by");
    expect(prompt).toContain("R<attempt>-A<order>");
    expect(prompt).toContain("Orders must be contiguous and one-based");
    expect(prompt).toContain("depends_on");
    expect(prompt).toContain("problem_class");
    expect(normalizedPrompt).toContain("exactly one approved acceptance ID");
    expect(normalizedPrompt).toContain("Never join, delimit, or otherwise combine multiple IDs");
    expect(normalizedPrompt).toContain("emit a separate finding for each affected ID");
    expect(prompt).toContain("exact allowed files");
    expect(prompt).toContain("single-file change units");
    expect(normalizedPrompt).toContain("argument-vector verification commands");
    expect(normalizedPrompt).toContain("success conditions");
    expect(normalizedPrompt).toContain("required evidence");
    expect(normalizedPrompt).toContain("completion contract");
    expect(prompt).toContain("blocker_code");
    expect(prompt).toContain("test_infrastructure_blocker");
    expect(normalizedPrompt).toContain("A missing evidence report is not test infrastructure");
    expect(normalizedPrompt).toContain("That is an inadequate approved plan: return `replan_required`");
    expect(prompt).toContain("does not authorize a workflow transition");
    expect(prompt).toContain("work_item_id=item-1");
    expect(prompt).toContain("attempt=1");
    expect(prompt).toContain("final=false");
    expect(result.review.evidence_reviewed).toContain(context.verification_ref.path);
  });

  it("suffixes Verifier invocation evidence after an interrupted turn owns the base response", async () => {
    const { ledger, contextRef, context, worktreePath } = await boundedVerifierFixture();
    const base = "verifier-review-item-1-attempt-1";
    await writeFile(join(ledger.runDir, `responses/${base}.json`), "{}\n", "utf8");
    const codex = new ExactCoverageVerifier();

    await verifyWorkItem({
      runDir: ledger.runDir,
      worktreePath,
      workItem: item,
      contextRef,
      context,
      phase: "work_item",
      final: false,
      intake: { ...intake, repo_root: root! },
      codex,
      attempt: 1,
    });

    expect(codex.calls[0]!.artifactName).toBe(`${base}-resume-2`);
  });

  it("fails closed on bounded protocol downgrade and partial-package attempts before artifacts or model work", async () => {
    const { ledger, contextRef, context, worktreePath } = await boundedVerifierFixture();
    const codex = new ExactCoverageVerifier();
    const shared = { runDir: ledger.runDir, worktreePath, workItem: item, intake: { ...intake, repo_root: root! }, codex, attempt: 1 };
    const adversarial = [
      { ...shared, implementation, verification: { ...evidence } },
      { ...shared, contextRef },
      { ...shared, contextRef, context },
      { ...shared, contextRef, context, phase: "work_item" },
      { ...shared, context, phase: "work_item", final: false },
    ];
    Object.defineProperty((adversarial[0] as { verification: object }).verification, "commands", {
      get: () => { throw new Error("recursive legacy evidence must remain unread"); },
    });
    for (const candidate of adversarial) {
      await expect(verifyWorkItem(candidate as never)).rejects.toThrow(/bounded-context-v1.*(complete bounded|legacy broad)/i);
    }
    expect(codex.calls).toHaveLength(0);
    expect(await readdir(join(ledger.runDir, "prompts"))).toEqual([]);
    expect(await readdir(join(ledger.runDir, "schemas"))).toEqual([]);
  });

  it("rejects bounded fields under the legacy manifest instead of upgrading the renderer", async () => {
    const { ledger, contextRef, context, worktreePath } = await boundedVerifierFixture(true);
    const codex = new ExactCoverageVerifier();
    await expect(verifyWorkItem({ runDir: ledger.runDir, worktreePath, workItem: item, contextRef, context, phase: "work_item", final: false, intake: { ...intake, repo_root: root! }, codex, attempt: 1 }))
      .rejects.toThrow(/legacy.*bounded context/i);
    expect(codex.calls).toHaveLength(0);
    expect(await readdir(join(ledger.runDir, "prompts"))).toEqual([]);
  });

  it("rejects mixed legacy fields and phase/final mismatches before model invocation", async () => {
    const { ledger, contextRef, context } = await boundedVerifierFixture();
    const codex = new ExactCoverageVerifier();
    const base = { runDir: ledger.runDir, worktreePath: join(root!, "worktree"), workItem: item, contextRef, context, phase: "work_item" as const, final: false, intake: { ...intake, repo_root: root! }, codex, attempt: 1 };
    await expect(verifyWorkItem({ ...base, verification: evidence } as never)).rejects.toThrow(/legacy broad-context fields/i);
    await expect(verifyWorkItem({ ...base, final: true })).rejects.toThrow(/final coordinate/i);
    expect(codex.calls).toHaveLength(0);
  });

  it("rejects a package after approved files are mutated, added, or deleted on disk", async () => {
    const { ledger, contextRef, context, worktreePath } = await boundedVerifierFixture();
    const codex = new ExactCoverageVerifier();
    const invoke = () => verifyWorkItem({ runDir: ledger.runDir, worktreePath, workItem: item, contextRef, context, phase: "work_item" as const, final: false, intake: { ...intake, repo_root: root! }, codex, attempt: 1 });
    await writeFile(join(worktreePath, "src/item-1.ts"), "export const item = 2;\n");
    await expect(invoke()).rejects.toThrow(/Git snapshot/i);
    await writeFile(join(worktreePath, "src/item-1.ts"), "export const item = 1;\n");
    await mkdir(join(worktreePath, "tests"), { recursive: true });
    await writeFile(join(worktreePath, "tests/item-1.test.ts"), "export const tested = true;\n");
    await expect(invoke()).rejects.toThrow(/Git snapshot/i);
    await rm(join(worktreePath, "tests/item-1.test.ts"));
    await rm(join(worktreePath, "src/item-1.ts"));
    await expect(invoke()).rejects.toThrow(/Git snapshot/i);
    expect(codex.calls).toHaveLength(0);
  });

  it("accepts a work-item package after HEAD advances without changing bounded content", async () => {
    const { ledger, contextRef, context, worktreePath } = await boundedVerifierFixture();
    execFileSync("git", ["commit", "--allow-empty", "-m", "unrelated commit"], { cwd: worktreePath });
    const codex = new ExactCoverageVerifier();
    await expect(verifyWorkItem({ runDir: ledger.runDir, worktreePath, workItem: item, contextRef, context, phase: "work_item", final: false, intake: { ...intake, repo_root: root! }, codex, attempt: 1 }))
      .resolves.toMatchObject({ review: { decision: "approve" } });
    expect(codex.calls).toHaveLength(1);
  });

  it("compares the ordered changed-file list as well as the patch", async () => {
    const { context, baseCommit } = await boundedVerifierFixture();
    expect(() => assertVerifierScopeSnapshot(context, {
      base_commit: baseCommit,
      head_commit: baseCommit,
      changed_files: [...context.changed_files].reverse().concat("tests/item-1.test.ts"),
      patch: context.diff,
      patch_bytes: Buffer.byteLength(context.diff, "utf8"),
    }, { baseCommit, headCommit: baseCommit })).toThrow(/changed files/i);
  });

  it("retains exact HEAD authority for integrated verification", async () => {
    const { context, baseCommit } = await boundedVerifierFixture();
    expect(() => assertVerifierScopeSnapshot({ ...context, phase: "final_integrated" }, {
      base_commit: baseCommit,
      head_commit: "e".repeat(40),
      changed_files: context.changed_files,
      patch: context.diff,
      patch_bytes: Buffer.byteLength(context.diff, "utf8"),
    }, { baseCommit, headCommit: baseCommit })).toThrow(/HEAD.*authority/i);
  });

  it("produces a canonical strict action queue from a bounded request-changes review", async () => {
    const { ledger, contextRef, context, worktreePath } = await boundedVerifierFixture();
    const codex = new ParserHonoringVerifier();
    const result = await verifyWorkItem({ runDir: ledger.runDir, worktreePath, workItem: item, contextRef, context, phase: "work_item", final: false, intake: { ...intake, repo_root: root! }, codex, attempt: 1 });
    const queue = normalizeReviewerActions(result.review, 1);
    expect(() => validateReviewerActionQueue(queue)).not.toThrow();
    expect(queue.actions[0]).toMatchObject({ action_id: "R1-A1", order: 1, depends_on: [] });
  });

  it("reviews a terminal package using its exact phase index without legacy inputs", async () => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-terminal-verifier-"));
    const git = await gitWorktree(root);
    await mkdir(join(git.worktreePath, "src"), { recursive: true });
    await mkdir(join(git.worktreePath, "tests"), { recursive: true });
    await writeFile(join(git.worktreePath, "src/item-1.ts"), "export const item = 1;\n");
    await writeFile(join(git.worktreePath, "tests/item-1.test.ts"), "export const tested = true;\n");
    const ledger = await createRunLedgerV2({ repoRoot: root, originalRequest: intake.task, sourceCommit: git.baseCommit, worktreePath: git.worktreePath, branchName: "test-terminal-verifier" });
    const plan: BrainPlan = { summary: "Terminal package", assumptions: [], research: [], research_sources: ["repo"], architecture: "local", risks: [], work_items: [item], integration_verification: [["npm", "test"]] };
    const recorded = await recordPlan(ledger.runDir, JSON.stringify(plan));
    await approvePlanRevision(ledger.runDir, recorded.revision);
    const completedImplementation = { ...implementation, changed_files: item.completion_contract.expected_changed_files };
    const completedImplementationRef = await writeImmutableValidatedJson(ledger.runDir, "implementation/item-1/attempt-1.json", implementationResultSchema, completedImplementation);
    const completedVerificationPath = "verification/local/aXRlbS0x/attempt-1/evidence.json";
    const completedNamespace = "verification/local/aXRlbS0x/attempt-1";
    await mkdir(join(ledger.runDir, completedNamespace), { recursive: true });
    await writeFile(join(ledger.runDir, `${completedNamespace}/stdout.txt`), "passed\n");
    await writeFile(join(ledger.runDir, `${completedNamespace}/stderr.txt`), "");
    const completedResultRef = await writeImmutableValidatedJson(ledger.runDir, `${completedNamespace}/result.json`, verificationExecutionResultSchema, {
      argv: item.verification_commands[0]!.argv, stdout: "passed\n", stderr: "", exit_code: 0, duration_ms: 1,
      timed_out: false, error_code: null, error_message: null, signal: null,
    });
    const completedVerificationRef = await writeImmutableValidatedJson(ledger.runDir, completedVerificationPath, verificationEvidenceSchema, {
      verification_scope: "local", work_item_id: item.id, attempt: 1, evidence_path: completedVerificationPath,
      commands: [{ command: item.verification_commands[0]!.argv.join(" "), argv: item.verification_commands[0]!.argv, exit_code: 0,
        timed_out: false, error_code: null, error_message: null, signal: null, stdout_path: `${completedNamespace}/stdout.txt`,
        stderr_path: `${completedNamespace}/stderr.txt`, result_path: completedResultRef.path }],
      artifacts: [], artifact_checks: [], browser_evidence: [], created_at: new Date().toISOString(),
    });
    const completedReviewRef = await writeImmutableValidatedJson(ledger.runDir, "reviews/item-1/attempt-1.json", persistedVerifierReviewSchema, {
      work_item_id: item.id, attempt: 1, final: false, decision: "approve", failure_class: "none", blocker: null, blocker_code: null,
      acceptance_coverage: item.completion_contract.required_acceptance_ids, evidence_reviewed: [completedVerificationPath], findings: [], residual_risks: [],
    });
    let manifest = await readManifestV2(ledger.runDir);
    const candidateCommit = git.baseCommit;
    await updateManifestV2(ledger.runDir, { workflow_protocol: "bounded-context-v1", work_item_progress: { ...manifest.work_item_progress, [item.id]: {
      status: "in_progress", attempts: 1, context_base_commit: git.baseCommit, context_plan_revision: recorded.revision,
      implementation_path: completedImplementationRef.path, verification_path: completedVerificationRef.path, review_path: completedReviewRef.path,
      review_revision: 1, commit_sha: candidateCommit,
    } } });
    const summaryRef = await persistWorkItemSummary({
      runDir: ledger.runDir, workItem: item, planRevision: recorded.revision, planSha256: recorded.sha256, attempt: 1,
      baseCommit: git.baseCommit, commitSha: candidateCommit, completionBasis: "verifier_approve",
      implementationRef: completedImplementationRef, verificationRef: completedVerificationRef, reviewRef: completedReviewRef,
      policyDecisionRef: null, findingRevision: { reviewRevision: 1, findingIds: [] }, createdAt: new Date().toISOString(),
    });
    const verificationPath = "verification/integrated/attempt-1/evidence.json";
    const verificationRef = await writeImmutableValidatedJson(ledger.runDir, verificationPath, verificationEvidenceSchema, {
      verification_scope: "integrated", work_item_id: "integrated", attempt: 1, evidence_path: verificationPath,
      commands: [], artifacts: [], artifact_checks: [], browser_evidence: [], created_at: new Date().toISOString(),
    });
    manifest = await readManifestV2(ledger.runDir);
    await updateManifestV2(ledger.runDir, {
      workflow_protocol: "bounded-context-v1",
      work_item_progress: {
        ...manifest.work_item_progress,
        [item.id]: { ...manifest.work_item_progress[item.id]!, status: "complete", summary_path: summaryRef.path, summary_sha256: summaryRef.sha256 },
        integrated: { status: "in_progress", attempts: 1, context_base_commit: git.baseCommit, context_plan_revision: recorded.revision, verification_path: verificationPath, commit_sha: candidateCommit },
      },
    });
    const indexRef = await buildVerifierEvidenceIndex({ runDir: ledger.runDir, phase: "final_integrated", attempt: 1, candidateCommit, workItemSummaryRefs: [summaryRef], integratedVerificationRef: verificationRef });
    await updateManifestV2(ledger.runDir, {
      final_verifier_index_path: indexRef.path,
      final_verifier_index_sha256: indexRef.sha256,
    });
    const finalItem = integratedWorkItem(plan, { includeCompletedDependencies: true });
    const snapshot = await collectScopedWorktreeDiff({ repoRoot: git.worktreePath, baseCommit: git.baseCommit, workItem: finalItem });
    const contextRef = await buildVerifierContext({ runDir: ledger.runDir, workItemId: finalItem.id, phase: "final_integrated", attempt: 1, acceptanceContract: finalItem.acceptance, changedFiles: snapshot.changed_files, diff: snapshot.patch, evidenceIndexRef: indexRef });
    const context = await loadRoleContext(ledger.runDir, contextRef, "verifier");
    const terminalReview: VerifierReview = { ...review, work_item_id: "integrated", final: true, acceptance_coverage: finalItem.completion_contract.required_acceptance_ids };
    const codex = new ExactCoverageVerifier(terminalReview);
    await verifyWorkItem({ runDir: ledger.runDir, worktreePath: git.worktreePath, workItem: finalItem, contextRef, context, phase: "final_integrated", final: true, intake: { ...intake, repo_root: root }, codex, attempt: 1 });
    expect(codex.calls[0]!.prompt).toContain(indexRef.sha256);
    expect(codex.calls[0]!.prompt).not.toContain("Prior per-item verification evidence");
    await writeFile(join(git.worktreePath, "src/item-1.ts"), "export const item = 2;\n");
    const driftCodex = new ExactCoverageVerifier(terminalReview);
    await expect(verifyWorkItem({ runDir: ledger.runDir, worktreePath: git.worktreePath, workItem: finalItem, contextRef, context, phase: "final_integrated", final: true, intake: { ...intake, repo_root: root }, codex: driftCodex, attempt: 1 }))
      .rejects.toThrow(/Git snapshot/i);
    expect(driftCodex.calls).toHaveLength(0);
    await writeFile(join(git.worktreePath, "src/item-1.ts"), "export const item = 1;\n");
    execFileSync("git", ["commit", "--allow-empty", "-m", "unrelated terminal commit"], { cwd: git.worktreePath });
    const headDriftCodex = new ExactCoverageVerifier(terminalReview);
    await expect(verifyWorkItem({ runDir: ledger.runDir, worktreePath: git.worktreePath, workItem: finalItem, contextRef, context, phase: "final_integrated", final: true, intake: { ...intake, repo_root: root }, codex: headDriftCodex, attempt: 1 }))
      .rejects.toThrow(/HEAD.*authority/i);
    expect(headDriftCodex.calls).toHaveLength(0);
  });

  it("rejects non-exact or duplicate approval coverage before persisting review", async () => {
    const { ledger, contextRef, context } = await boundedVerifierFixture();
    for (const acceptance_coverage of [[], [item.acceptance[0]!.id, item.acceptance[0]!.id], ["unknown"]]) {
      const codex = new ExactCoverageVerifier({ ...review, acceptance_coverage });
      await expect(verifyWorkItem({ runDir: ledger.runDir, worktreePath: join(root!, "worktree"), workItem: item, contextRef, context, phase: "work_item", final: false, intake: { ...intake, repo_root: root! }, codex, attempt: 1 }))
        .rejects.toThrow(/acceptance coverage/i);
    }
  });
  it("reviews implementation and saved evidence read-only", async () => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-verifier-"));
    const ledger = await createLegacyRunLedgerV2({ repoRoot: root, originalRequest: intake.task });
    await writeFile(join(ledger.runDir, "verification/stdout.txt"), "verification passed\n", "utf8");
    await writeFile(join(ledger.runDir, "verification/stderr.txt"), "", "utf8");
    await writeFile(join(ledger.runDir, "verification/result.json"), "{\"exit_code\":0}\n", "utf8");
    await mkdir(join(root, "worktree/reports"), { recursive: true });
    await writeFile(join(root, "worktree/reports/result.json"), "{\"artifact\":true}\n", "utf8");
    const codex = new RecordingVerifier();
    const progress = await openProgressReporter({ runDir: ledger.runDir });
    const result = await verifyWorkItem({ runDir: ledger.runDir, worktreePath: join(root, "worktree"), workItem: item, implementation, verification: evidence, priorVerification: [evidence], intake: { ...intake, repo_root: root }, codex, progress, workItemIndex: 1, workItemTotal: 1 });
    expect(result.review).toEqual(review);
    expect(codex.calls[0]).toMatchObject({ role: "verifier", sandbox: "read-only", cwd: join(root, "worktree"), outputSchema: expect.anything(), progress: expect.anything() });
    const prompt = await readFile(join(ledger.runDir, "prompts/verifier-review-item-1-attempt-1.md"), "utf8");
    expect(prompt).toContain("item-1 works");
    expect(prompt).toContain('"schema_version": "2.0"');
    expect(prompt).toContain(JSON.stringify(item, null, 2));
    expect(prompt).toContain("Reject approval when a required cross-cutting command lacks passing evidence");
    expect(prompt).toContain("Do not accept a full-suite result as a substitute for missing focused evidence");
    const normalizedPrompt = prompt.replace(/\s+/g, " ");
    expect(prompt).toContain("verification");
    expect(prompt).toContain(`The durable run directory is \`${ledger.runDir}\``);
    expect(prompt).toContain(`verification evidence root is \`${join(ledger.runDir, "verification")}\``);
    expect(prompt).toContain("\"content\"");
    expect(prompt).toContain("acceptance_criterion");
    expect(prompt).toContain("evidence-backed claims");
    expect(prompt).toContain("must not assign durable finding IDs");
    expect(normalizedPrompt).toContain("does not authorize any workflow transition");
    expect(prompt).toContain("problem_class");
    expect(prompt).toContain("evidence_refs");
    expect(prompt).toContain("blocker_code");
    expect(prompt).toContain("Prior per-item verification evidence");
    expect(prompt).toContain("verification/local/aXRlbS0x/attempt-1/stdout.txt");
    expect(result.reviewPath).toBe("reviews/item-1/attempt-1.json");
    expect(await readFile(join(ledger.runDir, result.reviewPath), "utf8")).toContain('"decision": "approve"');
    const events = []; for await (const event of readProgressEvents(ledger.runDir)) events.push(event);
    expect(events.at(-1)?.safe_label).toBe("Verifier approved work item 1");
  });

  it("preserves strict ordered actions in generated change requests", async () => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-verifier-actions-"));
    const ledger = await createLegacyRunLedgerV2({ repoRoot: root, originalRequest: intake.task });
    const codex = new ParserHonoringVerifier();

    const result = await verifyWorkItem({
      runDir: ledger.runDir,
      worktreePath: join(root, "worktree"),
      workItem: item,
      implementation,
      verification: { ...evidence, artifacts: [], artifact_checks: [] },
      intake: { ...intake, repo_root: root },
      codex,
    });

    expect(result.review.findings).toEqual([expect.objectContaining({
      action_id: "R1-A1",
      order: 1,
      depends_on: [],
    })]);
    expect(codex.calls[0]?.outputParser).toBeDefined();
    expect(JSON.parse(await readFile(join(ledger.runDir, result.reviewPath), "utf8")))
      .toMatchObject({ findings: [{ action_id: "R1-A1", order: 1, depends_on: [] }] });
  });
});
