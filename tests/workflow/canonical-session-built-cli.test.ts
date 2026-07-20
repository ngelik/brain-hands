import { access, constants } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";
import {
  approvePlanRevision,
  createRunLedgerV2,
  readManifestV2,
  recordPlan,
  updateManifestV2,
} from "../../src/core/ledger.js";
import { canonicalSessionEventSchema, sessionStateSchema } from "../../src/progress/session-events.js";
import { hashRuntimeTree } from "../../src/core/controller-provenance.js";
import { buildRecoveryProgressSubject, recordOperationalRecovery } from "../../src/workflow/recovery-runtime.js";
import { recoveryScopePathComponent } from "../../src/workflow/recovery-policy.js";
import { executionSpec } from "../fixtures/execution-spec.js";

type CliResult = { stdout: string; stderr: string };
type Status = {
  run_id: string;
  run_dir: string | null;
  stage: string;
  delivery_state: string;
  operator_state: string;
  assurance_outcome: string | null;
  pending_action: PendingAction | null;
};
type PendingAction = {
  state: string;
  revision: number;
  question?: {
    id: string;
    recommended_choice_id: string | null;
    recommendation_rationale: string | null;
  };
  approaches?: Array<{
    id: string;
    title: string;
    summary: string;
    tradeoffs: string[];
    recommended: boolean;
    recommendation_rationale: string | null;
  }>;
  brief?: {
    selected_approach_id: string | null;
    selected_approach_rationale: string | null;
  };
};

let repoRoot: string | null = null;
afterEach(async () => {
  if (repoRoot !== null) {
    await rm(repoRoot, { recursive: true, force: true });
    repoRoot = null;
  }
});

async function ensureBuiltCli(projectRoot: string): Promise<void> {
  const cliPath = join(projectRoot, "dist", "cli.js");
  try {
    await new Promise<void>((resolve, reject) => {
      access(cliPath, constants.F_OK, (error) => error ? reject(error) : resolve());
    });
  } catch {
    throw new Error(
      `Built CLI is missing at ${cliPath}. Run npm run build before the canonical session test.`,
    );
  }
}

async function runBuiltCliRaw(
  projectRoot: string,
  args: string[],
  input?: string,
  extraEnv: Record<string, string> = {},
) {
  await ensureBuiltCli(projectRoot);
  const {
    BRAIN_HANDS_CONTROLLER_MODE: _controllerMode,
    BRAIN_HANDS_EXECUTABLE_PATH: _executablePath,
    ...baseEnv
  } = process.env;
  return execa("node", ["dist/cli.js", ...args], {
    cwd: projectRoot,
    env: { ...baseEnv, ...extraEnv },
    extendEnv: false,
    input,
    reject: false,
  });
}

async function runBuiltCli(
  projectRoot: string,
  args: string[],
  input?: string,
  extraEnv: Record<string, string> = {},
): Promise<CliResult> {
  const result = await runBuiltCliRaw(projectRoot, args, input, extraEnv);
  if (result.exitCode !== 0) {
    throw new Error([
      "Built CLI failed: node dist/cli.js " + args.join(" "),
      "exit=" + (result.exitCode ?? "null"),
      result.stdout.trim(),
      result.stderr.trim(),
    ].filter(Boolean).join("\n"));
  }
  return { stdout: result.stdout, stderr: result.stderr };
}

describe("built CLI artifact prerequisite", () => {
  it("fails clearly without invoking package build or clean when dist/cli.js is absent", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-missing-built-cli-"));
    const lifecycleMarker = join(repoRoot, "lifecycle-invoked.txt");
    await writeFile(
      join(repoRoot, "record-lifecycle.mjs"),
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(lifecycleMarker)}, process.argv[2]);\n`,
    );
    await writeFile(join(repoRoot, "package.json"), JSON.stringify({
      scripts: {
        build: "node record-lifecycle.mjs build",
        clean: "node record-lifecycle.mjs clean",
      },
    }));

    await expect(runBuiltCli(repoRoot, ["--help"])).rejects.toThrow(
      `Built CLI is missing at ${join(repoRoot, "dist", "cli.js")}. Run npm run build before the canonical session test.`,
    );
    await expect(new Promise<void>((resolve, reject) => {
      access(join(repoRoot!, "dist"), constants.F_OK, (error) =>
        error ? reject(error) : resolve());
    })).rejects.toMatchObject({ code: "ENOENT" });
    await expect(new Promise<void>((resolve, reject) => {
      access(lifecycleMarker, constants.F_OK, (error) => error ? reject(error) : resolve());
    })).rejects.toMatchObject({ code: "ENOENT" });
  });
});

function parseJson<T>(raw: string): T {
  return JSON.parse(raw) as T;
}

async function createIsolatedGitRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "brain-hands-built-session-"));
  await execa("git", ["init", "-q", "--initial-branch=main"], { cwd: root });
  await execa("git", ["config", "user.email", "brain-hands@example.test"], { cwd: root });
  await execa("git", ["config", "user.name", "Brain Hands"], { cwd: root });
  await writeFile(join(root, "README.md"), "built canonical session proof\n", "utf8");
  await execa("git", ["add", "README.md"], { cwd: root });
  await execa("git", ["commit", "-qm", "initial"], { cwd: root });
  return root;
}

async function writeSupportedLocalConfig(root: string): Promise<void> {
  await writeFile(join(root, ".brain-hands", "config.yaml"), [
    "version: 2",
    "",
    "github:",
    "  default_remote: origin",
    "",
    "codex:",
    "  command: codex",
    "  timeout_seconds: 3600",
    "  isolate_user_config: true",
    "",
    "retry_policy:",
    "  max_hands_fix_attempts: 3",
    "  max_replan_attempts: 2",
    "",
    "profiles:",
    "  brain:",
    "    model: gpt-5.4",
    "    reasoning_effort: high",
    "    sandbox: read-only",
    "",
    "  hands:",
    "    model: gpt-5.4",
    "    reasoning_effort: high",
    "    sandbox: workspace-write",
    "",
    "  verifier:",
    "    model: gpt-5.4",
    "    reasoning_effort: high",
    "    sandbox: read-only",
    "",
  ].join("\n"), "utf8");
  await execa("git", ["add", ".brain-hands/config.yaml"], { cwd: root });
  await execa("git", ["commit", "-qm", "configure brain hands"], { cwd: root });
}

async function createSelfHostingCandidateRepository(projectRoot: string): Promise<string> {
  const root = await createIsolatedGitRepository();
  await writeFile(join(root, "package.json"), `${JSON.stringify({
    name: "@ngelik/brain-hands",
    version: "0.4.0",
  }, null, 2)}\n`, "utf8");
  await execa("git", ["add", "package.json"], { cwd: root });
  await execa("git", ["commit", "-qm", "self-hosting candidate"], { cwd: root });
  await runBuiltCli(projectRoot, ["init", "--repo", root], undefined, {
    BRAIN_HANDS_CONTROLLER_MODE: "development_checkout",
  });
  await writeSupportedLocalConfig(root);
  return root;
}

async function createApprovedDiagnosticRun(root: string): Promise<{
  runDir: string;
  runId: string;
  scopeId: string;
}> {
  const workItemId = "BH-built-diagnostic";
  const ledger = await createRunLedgerV2({
    repoRoot: root,
    originalRequest: "Exercise built diagnostic recovery",
    slug: "built-diagnostic",
    mode: "local",
    intake: { task: "Exercise built diagnostic recovery", repo_root: root, mode: "local", research: false, reflection: false },
  });
  const initialManifest = await readManifestV2(ledger.runDir);
  await writeFile(join(ledger.runDir, "manifest.json"), `${JSON.stringify({
    ...initialManifest,
    workflow_protocol: "legacy-v2",
    discovery: null,
    updated_at: new Date().toISOString(),
  }, null, 2)}\n`, "utf8");
  await recordPlan(ledger.runDir, JSON.stringify({
    summary: "Exercise built diagnostic recovery",
    assumptions: [],
    research: [],
    research_sources: [],
    architecture: "test",
    risks: [],
    work_items: [{
      ...executionSpec(workItemId),
      title: workItemId,
      objective: "Exercise diagnostic retry",
    }],
    integration_verification: [["true"]],
  }));
  await approvePlanRevision(ledger.runDir, 1);
  const manifest = await updateManifestV2(ledger.runDir, {
    stage: "implementing",
    delivery_state: "blocked",
    last_blocker: "Repeated implementation failure",
    current_work_item_id: workItemId,
    worktree_path: root,
    branch_name: "built-diagnostic",
  });
  const progress = await buildRecoveryProgressSubject({
    runDir: ledger.runDir,
    manifest,
    workItemId,
    findingIds: [],
  });
  const recovery = {
    runDir: ledger.runDir,
    scopeId: `work-item:${workItemId}`,
    operation: "work-item-fix",
    requestedEffect: "retry_operation" as const,
    requestedEffectReason: "implementation_retry",
    findingIds: [],
    classification: {
      failure_class: "implementation_failure" as const,
      blocker_code: "implementation_failed",
    },
    error: new Error("implementation failed"),
    progress,
  };
  await recordOperationalRecovery({ ...recovery, effectAttemptId: "built-diagnostic-attempt-1" });
  const stopped = await recordOperationalRecovery({ ...recovery, effectAttemptId: "built-diagnostic-attempt-2" });
  expect(stopped.guard_action).toBe("diagnostic_stop");
  return { runDir: ledger.runDir, runId: ledger.runId, scopeId: recovery.scopeId };
}

async function readLineage(runDir: string) {
  const manifest = parseJson<{ run_id: string; terminal: { outcome: string } | null; assurance_outcome: string | null }>(
    await readFile(join(runDir, "manifest.json"), "utf8"),
  );
  const state = sessionStateSchema.parse(parseJson<unknown>(await readFile(join(runDir, "session-state.json"), "utf8")));
  expect(state.run_id).toBe(manifest.run_id);
  expect(state.terminal_outcome).toBe(manifest.terminal?.outcome ?? null);
  expect(state.assurance_outcome).toBe(manifest.assurance_outcome);
  return {
    runId: state.run_id,
    sessionId: state.session_id,
    eventId: state.canonical_event_id,
  };
}

async function expectSameLineage(runDir: string, expected: { runId: string; sessionId: string; eventId: string }): Promise<void> {
  await expect(readLineage(runDir)).resolves.toEqual(expected);
}

async function expectNoCanonicalEvent(runDir: string): Promise<void> {
  expect(await readFile(join(runDir, "session-events.jsonl"), "utf8")).toBe("");
  const state = sessionStateSchema.parse(parseJson<unknown>(await readFile(join(runDir, "session-state.json"), "utf8")));
  expect(state.terminal_outcome).toBeNull();
  expect(state.assurance_outcome).toBeNull();
  expect(state.terminal_provenance).toBeNull();
}

async function readCanonicalEvents(runDir: string): Promise<unknown[]> {
  const raw = await readFile(join(runDir, "session-events.jsonl"), "utf8");
  return raw.trim() === "" ? [] : raw.trimEnd().split("\n").map((line) => parseJson<unknown>(line));
}

async function readRunEvents(runDir: string): Promise<Array<{
  type: string;
  stage: string;
  timestamp: string;
  actor: string;
}>> {
  const raw = await readFile(join(runDir, "events.jsonl"), "utf8");
  return raw.trim() === "" ? [] : raw.trimEnd().split("\n").map((line) => parseJson<{
    type: string;
    stage: string;
    timestamp: string;
    actor: string;
  }>(line));
}

async function readProgressEvents(runDir: string): Promise<Array<{
  event_key: string;
  timestamp: string;
  source: string;
  work_item?: { index: number; total: number; attempt: number; final: boolean };
}>> {
  const raw = await readFile(join(runDir, "progress.jsonl"), "utf8");
  return raw.trim() === "" ? [] : raw.trimEnd().split("\n").map((line) => parseJson<{
    event_key: string;
    timestamp: string;
    source: string;
    work_item?: { index: number; total: number; attempt: number; final: boolean };
  }>(line));
}

function expectProgressCodeSequence(
  events: Array<{ event_key: string }>,
  expectedCodes: string[],
): void {
  let previousIndex = -1;
  for (const code of expectedCodes) {
    const index = events.findIndex((event, eventIndex) => eventIndex > previousIndex && event.event_key.split(":", 3)[1] === code);
    expect(index, `Expected progress code ${code} after index ${previousIndex}`).toBeGreaterThan(previousIndex);
    previousIndex = index;
  }
}

async function expectDurableWorkItemReferences(
  runDir: string,
  itemId: string,
  expected: { implementationPath: string | null; verificationPath: string; reviewPath: string; final: boolean },
): Promise<void> {
  const manifest = parseJson<{ work_item_progress: Record<string, Record<string, unknown>> }>(
    await readFile(join(runDir, "manifest.json"), "utf8"),
  );
  const progress = manifest.work_item_progress[itemId];
  expect(progress).toBeDefined();
  expect(progress).toMatchObject({
    status: "complete",
    attempts: 1,
    verification_path: expected.verificationPath,
    review_path: expected.reviewPath,
  });

  if (expected.implementationPath !== null) {
    expect(progress).toMatchObject({ implementation_path: expected.implementationPath });
    const implementation = parseJson<{ work_item_id: string }>(
      await readFile(join(runDir, expected.implementationPath), "utf8"),
    );
    expect(implementation.work_item_id).toBe(itemId);
    expect(progress.summary_path).toEqual(expect.stringMatching(/^summaries\/work-items\//));
    const summary = parseJson<{ work_item_id: string; implementation_ref: { path: string } }>(
      await readFile(join(runDir, String(progress.summary_path)), "utf8"),
    );
    expect(summary).toMatchObject({
      work_item_id: itemId,
      implementation_ref: { path: expected.implementationPath },
    });
  } else {
    expect(progress).not.toHaveProperty("implementation_path");
    const finalVerifierPrompt = await readFile(
      join(runDir, "prompts", "verifier-review-integrated-final-attempt-1.md"),
      "utf8",
    );
    expect(finalVerifierPrompt).toContain('"work_item_id": "integrated"');
    expect(finalVerifierPrompt).toContain('"acceptance_contract"');
    expect(finalVerifierPrompt).toContain('"command_evidence"');
    expect(finalVerifierPrompt).toContain('"evidence_index_ref"');
    expect(finalVerifierPrompt).not.toContain("Dry-run implementation completed without source changes.");
  }

  const verification = parseJson<{ verification_scope: string; work_item_id: string; evidence_path: string; attempt: number }>(
    await readFile(join(runDir, expected.verificationPath), "utf8"),
  );
  expect(verification).toMatchObject({
    verification_scope: expected.final ? "integrated" : "local",
    work_item_id: itemId,
    evidence_path: expected.verificationPath,
    attempt: 1,
  });

  const review = parseJson<{ work_item_id: string; attempt: number; final: boolean; decision: string }>(
    await readFile(join(runDir, expected.reviewPath), "utf8"),
  );
  expect(review).toMatchObject({ work_item_id: itemId, attempt: 1, final: expected.final, decision: "approve" });
}

async function snapshotRunFiles(runDir: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files[relative(runDir, path)] = await readFile(path, "utf8");
    }
  }
  await visit(runDir);
  return files;
}

describe("canonical session lifecycle through the built CLI", () => {
  it("preserves the approval-separated lifecycle and finalizes exactly once across processes", async () => {
    const projectRoot = process.cwd();
    repoRoot = await createIsolatedGitRepository();

    const packageVersion = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8")) as { version: string };
    expect((await runBuiltCli(projectRoot, ["--version"])).stdout.trim()).toBe(packageVersion.version);
    await runBuiltCli(projectRoot, ["init", "--repo", repoRoot]);

    const started = await runBuiltCli(projectRoot, [
      "run",
      "Prove canonical session lifecycle through the built CLI",
      "--repo", repoRoot,
      "--mode", "local",
      "--no-research",
      "--reflection",
      "--dry-run",
      "--json",
    ]);
    const initialStatus = parseJson<Status>(started.stdout);
    expect(initialStatus.stage).toBe("awaiting_discovery_answer");
    expect(initialStatus.pending_action?.question).toMatchObject({
      id: "q-001",
      recommended_choice_id: "explicit",
      recommendation_rationale: "Explicit boundaries preserve durable operator intent.",
    });
    expect(initialStatus.run_dir).not.toBeNull();
    const runId = initialStatus.run_id;
    const runDir = join(repoRoot, ".brain-hands", "runs", runId);
    expect(initialStatus.run_dir).toBe(runDir);
    const lineage = await readLineage(runDir);
    expect(lineage.runId).toBe(runId);
    await expectNoCanonicalEvent(runDir);

    const initialStatusText = await runBuiltCli(projectRoot, ["status", runId, "--repo", repoRoot]);
    expect(initialStatusText.stdout).toContain("Recommended choice: explicit");
    expect(initialStatusText.stdout).toContain("Recommendation rationale: Explicit boundaries preserve durable operator intent.");
    await expectSameLineage(runDir, lineage);

    const answered = await runBuiltCli(projectRoot, [
      "answer-discovery", "--run", runDir, "--question", "q-001", "--dry-run", "--json",
    ], "Use the recommended explicit boundary\n");
    const approachStatus = parseJson<Status>(answered.stdout);
    expect(approachStatus.stage).toBe("awaiting_discovery_approach");
    expect(approachStatus.pending_action?.approaches).toEqual([
      {
        id: "approach-explicit",
        title: "Explicit boundaries",
        summary: "Stop at each durable user boundary.",
        tradeoffs: ["Requires a separate operator command for each decision."],
        recommended: true,
        recommendation_rationale: "It preserves exact durable intent.",
      },
      {
        id: "approach-minimal",
        title: "Minimal boundaries",
        summary: "Stop only for approvals.",
        tradeoffs: ["Intermediate decisions are less visible."],
        recommended: false,
        recommendation_rationale: null,
      },
    ]);
    await expectNoCanonicalEvent(runDir);
    await expectSameLineage(runDir, lineage);

    const resumedApproach = parseJson<Status>(
      (await runBuiltCli(projectRoot, ["resume", runId, "--repo", repoRoot, "--dry-run", "--json"])).stdout,
    );
    expect(resumedApproach.pending_action).toEqual(approachStatus.pending_action);
    const approachStatusText = await runBuiltCli(projectRoot, ["status", runId, "--repo", repoRoot]);
    expect(approachStatusText.stdout).toContain("Recommended approach: approach-explicit");
    expect(approachStatusText.stdout).toContain("Recommendation rationale: It preserves exact durable intent.");
    await expectSameLineage(runDir, lineage);

    const selected = parseJson<Status>(
      (await runBuiltCli(projectRoot, [
        "select-discovery-approach", "--run", runDir, "--revision", "1", "--approach", "approach-explicit", "--dry-run", "--json",
      ])).stdout,
    );
    expect(selected.stage).toBe("awaiting_discovery_brief_approval");
    expect(selected.pending_action?.brief).toMatchObject({
      selected_approach_id: "approach-explicit",
      selected_approach_rationale: "It preserves exact durable intent.",
    });
    await expectNoCanonicalEvent(runDir);
    await expectSameLineage(runDir, lineage);

    const resumedBrief = parseJson<Status>(
      (await runBuiltCli(projectRoot, ["resume", runId, "--repo", repoRoot, "--dry-run", "--json"])).stdout,
    );
    expect(resumedBrief.pending_action).toEqual(selected.pending_action);
    await expectSameLineage(runDir, lineage);

    const approvedBrief = parseJson<Status>(
      (await runBuiltCli(projectRoot, [
        "approve-discovery", "--run", runDir, "--revision", "1", "--dry-run", "--json",
      ])).stdout,
    );
    expect(approvedBrief).toMatchObject({ stage: "awaiting_plan_approval", plan_revision: 1 });
    await expectNoCanonicalEvent(runDir);
    await expectSameLineage(runDir, lineage);

    const planApproval = parseJson<Status & { workflow_result: string }>(
      (await runBuiltCli(projectRoot, [
        "approve-plan", runId, "--revision", "1", "--repo", repoRoot, "--dry-run", "--json",
      ])).stdout,
    );
    expect(planApproval).toMatchObject({
      stage: "delivery",
      delivery_state: "ready",
      operator_state: "delivered",
      assurance_outcome: "verified_ready",
      workflow_result: "local_ready",
    });

    const finalManifest = parseJson<{
      stage: string;
      delivery_state: string;
      assurance_outcome: string | null;
      assurance_assessment_path: string | null;
      terminal: { outcome: string; actor: string; source_stage: string; recorded_at: string } | null;
    }>(await readFile(join(runDir, "manifest.json"), "utf8"));
    expect(finalManifest).toMatchObject({
      stage: "complete",
      delivery_state: "ready",
      assurance_outcome: "verified_ready",
      terminal: { outcome: "delivered", actor: "runtime", source_stage: "delivery" },
    });
    expect(finalManifest.assurance_assessment_path).not.toBeNull();
    expect(finalManifest.terminal).not.toBeNull();
    await expectDurableWorkItemReferences(runDir, "dry-run-item", {
      implementationPath: "implementation/dry-run-item/attempt-1.json",
      verificationPath: "verification/local/ZHJ5LXJ1bi1pdGVt/attempt-1/evidence.json",
      reviewPath: "reviews/dry-run-item/attempt-1.json",
      final: false,
    });
    await expectDurableWorkItemReferences(runDir, "integrated", {
      implementationPath: null,
      verificationPath: "verification/integrated/attempt-1/evidence.json",
      reviewPath: "reviews/integrated/final-attempt-1.json",
      final: true,
    });
    const events = await readRunEvents(runDir);
    const terminalIndex = events.findIndex((event) => event.type === "run_terminalized");
    const reflectionIndex = events.findIndex((event) => event.type === "reflection_completed");
    expect(terminalIndex).toBeGreaterThanOrEqual(0);
    expect(reflectionIndex).toBeGreaterThan(terminalIndex);
    expect(Date.parse(events[reflectionIndex]!.timestamp)).toBeGreaterThanOrEqual(Date.parse(events[terminalIndex]!.timestamp));
    expect(events[terminalIndex]!.stage).toBe("delivery");

    const canonicalBeforeResume = await readCanonicalEvents(runDir);
    expect(canonicalBeforeResume).toHaveLength(1);
    const finalEvent = canonicalSessionEventSchema.parse(canonicalBeforeResume[0]);
    expect(finalEvent).toMatchObject({
      event_type: "session_finalized",
      run_id: lineage.runId,
      session_id: lineage.sessionId,
      event_id: lineage.eventId,
      terminal_outcome: "delivered",
      assurance_outcome: "verified_ready",
    });
    expect(finalEvent.timestamp).toBe(finalManifest.terminal!.recorded_at);
    for (const role of ["brain", "hands", "verifier"] as const) {
      expect(finalEvent.invocation_counts[role], `${role} invocation count`).toBeGreaterThan(0);
    }
    expect(finalEvent.invocation_counts.reflection).toBe(0);
    for (const source of ["brain", "hands", "verification", "verifier", "runtime"] as const) {
      expect(finalEvent.source_counts[source], `${source} source count`).toBeGreaterThan(0);
    }
    expect(finalEvent.source_counts.reflection).toBe(0);
    expect(finalEvent.source_counts.github).toBe(0);

    const progressEvents = await readProgressEvents(runDir);
    expectProgressCodeSequence(progressEvents, [
      "discovery_started",
      "discovery_question_ready",
      "discovery_brief_ready",
      "discovery_brief_approved",
      "plan_ready",
      "work_item_implementation",
      "hands_started",
      "implementation_recorded",
      "verification_started",
      "verification_recorded",
      "verifier_started",
      "verifier_approved",
      "final_verification_started",
      "final_verifier_started",
      "final_verifier_approved",
      "local_delivery_ready",
    ]);
    expect(progressEvents.filter((event) => event.event_key.split(":", 3)[1] === "work_item_implementation")).toEqual([
      expect.objectContaining({ work_item: { index: 1, total: 1, attempt: 1, final: false } }),
    ]);
    expect(progressEvents.filter((event) => event.event_key.split(":", 3)[1] === "implementation_recorded")).toEqual([
      expect.objectContaining({ work_item: { index: 1, total: 1, attempt: 1, final: false } }),
    ]);
    expect(progressEvents.filter((event) => event.event_key.split(":", 3)[1] === "verification_recorded")).toContainEqual(
      expect.objectContaining({ work_item: { index: 1, total: 1, attempt: 1, final: false } }),
    );
    expect(progressEvents.filter((event) => event.event_key.split(":", 3)[1] === "verifier_approved")).toContainEqual(
      expect.objectContaining({ work_item: { index: 1, total: 1, attempt: 1, final: false } }),
    );
    for (const code of ["final_verification_started", "final_verifier_started", "final_verifier_approved"]) {
      expect(progressEvents.filter((event) => event.event_key.split(":", 3)[1] === code)).toEqual([
        expect.objectContaining({ work_item: { index: 2, total: 2, attempt: 1, final: true } }),
      ]);
    }
    await expectSameLineage(runDir, lineage);

    const logsBeforeResume = parseJson<{
      status: Status;
      events: unknown[];
      progress_events: Array<Record<string, unknown>>;
      session_event: unknown;
    }>((await runBuiltCli(projectRoot, ["logs", runId, "--repo", repoRoot, "--json"])).stdout);
    expect(logsBeforeResume.status.assurance_outcome).toBe("verified_ready");
    expect(logsBeforeResume.session_event).toEqual(finalEvent);
    expect(logsBeforeResume.events).toHaveLength(events.length);
    const progressRaw = await readFile(join(runDir, "progress.jsonl"), "utf8");
    const progressRecords = progressRaw.trimEnd().split("\n").filter(Boolean).map((line) => parseJson<Record<string, unknown>>(line));
    expect(progressRecords.length).toBeGreaterThan(0);
    expect(logsBeforeResume.progress_events).toEqual(progressRecords);
    expect(progressRecords[0]).toHaveProperty("sequence");
    expect(progressRecords[0]).not.toHaveProperty("event_type");
    expect(() => canonicalSessionEventSchema.parse(progressRecords[0])).toThrow();
    expect(await readFile(join(runDir, "session-events.jsonl"), "utf8")).not.toBe(progressRaw);

    const filesBeforeResume = await snapshotRunFiles(runDir);
    const resumedDelivered = parseJson<Status & { workflow_result: string }>(
      (await runBuiltCli(projectRoot, ["resume", runId, "--repo", repoRoot, "--dry-run", "--json"])).stdout,
    );
    expect(resumedDelivered).toMatchObject({
      stage: "complete",
      operator_state: "delivered",
      assurance_outcome: "verified_ready",
      workflow_result: "local_ready",
    });
    expect(await snapshotRunFiles(runDir)).toEqual(filesBeforeResume);
    const canonicalAfterResume = await readCanonicalEvents(runDir);
    expect(canonicalAfterResume).toHaveLength(1);
    expect(canonicalAfterResume[0]).toEqual(finalEvent);
    await expectSameLineage(runDir, lineage);

    const logsAfterResume = parseJson<{ session_event: unknown; progress_events: unknown[] }>(
      (await runBuiltCli(projectRoot, ["logs", runId, "--repo", repoRoot, "--json"])).stdout,
    );
    expect(logsAfterResume.session_event).toEqual(finalEvent);
    expect(logsAfterResume.progress_events).toEqual(logsBeforeResume.progress_events);
  }, 90_000);

  it("keeps diagnostic recovery in the predecessor run through built CLI authorization", async () => {
    const projectRoot = process.cwd();
    repoRoot = await createIsolatedGitRepository();
    const diagnostic = await createApprovedDiagnosticRun(repoRoot);
    const runRoot = join(repoRoot, ".brain-hands", "runs");
    const initialFiles = await snapshotRunFiles(diagnostic.runDir);

    expect(await readdir(runRoot)).toEqual([diagnostic.runId]);
    const stopped = parseJson<Status>((await runBuiltCli(projectRoot, [
      "status",
      "--run", diagnostic.runDir,
      "--json",
    ])).stdout);
    expect(stopped).toMatchObject({
      run_id: diagnostic.runId,
      operator_state: "diagnostic_stop",
    });

    const unauthorized = await runBuiltCliRaw(projectRoot, [
      "resume",
      "--run", diagnostic.runDir,
      "--dry-run",
      "--json",
    ]);
    expect(unauthorized.exitCode).not.toBe(0);
    expect(`${unauthorized.stdout}\n${unauthorized.stderr}`).toMatch(/diagnostic.*requires.*actor.*recovery-note-file/i);
    expect(await snapshotRunFiles(diagnostic.runDir)).toEqual(initialFiles);
    expect(await readdir(runRoot)).toEqual([diagnostic.runId]);

    const notePath = join(repoRoot, "recovery-note.txt");
    await writeFile(notePath, "Retry the exact current diagnostic effect once.", "utf8");
    await runBuiltCliRaw(projectRoot, [
      "resume",
      "--run", diagnostic.runDir,
      "--actor", "operator@example.test",
      "--recovery-note-file", notePath,
      "--dry-run",
      "--json",
    ]);

    expect(await readdir(runRoot)).toEqual([diagnostic.runId]);
    const authorizationRoot = join(
      diagnostic.runDir,
      "recovery/scopes",
      recoveryScopePathComponent(diagnostic.scopeId),
      "authorizations",
    );
    const authorizationEntries = (await readdir(authorizationRoot)).sort();
    expect(authorizationEntries).toHaveLength(2);
    expect(authorizationEntries.some((entry) => entry.endsWith("-consumed.json"))).toBe(true);
    const manifest = await readManifestV2(diagnostic.runDir);
    expect(manifest.recovery.scopes[diagnostic.scopeId]?.authorization_path)
      .toMatch(/^recovery\/scopes\/[^/]+\/authorizations\/diagnostic-authorization:[a-f0-9]{64}\.json$/);
  }, 60_000);

  it("blocks controller mismatch before mutation and recovers the same built-CLI run", async () => {
    const projectRoot = process.cwd();
    repoRoot = await createSelfHostingCandidateRepository(projectRoot);
    const packageMetadata = parseJson<{ version: string }>(
      await readFile(join(projectRoot, "package.json"), "utf8"),
    );
    const candidateHead = (await execa("git", ["rev-parse", "HEAD"], { cwd: repoRoot })).stdout.trim();
    const currentHash = await hashRuntimeTree(projectRoot);
    const staleHash = currentHash === "a".repeat(64) ? "b".repeat(64) : "a".repeat(64);
    const ledger = await createRunLedgerV2({
      repoRoot,
      originalRequest: "Prove controller recovery through the built CLI",
      slug: "built-controller",
      mode: "local",
      intake: {
        task: "Prove controller recovery through the built CLI",
        repo_root: repoRoot,
        mode: "local",
        research: false,
        reflection: false,
      },
      sourceCommit: candidateHead,
      controllerProvenance: {
        self_hosting: true,
        mode: "development_checkout",
        executable_path: join(projectRoot, "dist", "cli.js"),
        package_root: projectRoot,
        package_name: "@ngelik/brain-hands",
        package_version: packageMetadata.version,
        package_hash_algorithm: "sha256",
        package_hash: staleHash,
        candidate_commit: candidateHead,
      },
    });
    await updateManifestV2(ledger.runDir, { stage: "brain_discovery" });
    const runRoot = join(repoRoot, ".brain-hands", "runs");
    const manifestBeforeResume = await readFile(join(ledger.runDir, "manifest.json"), "utf8");
    const eventsBeforeResume = await readFile(join(ledger.runDir, "events.jsonl"), "utf8");

    expect(await readdir(runRoot)).toEqual([ledger.runId]);
    const blocked = await runBuiltCliRaw(projectRoot, [
      "resume",
      "--run", ledger.runDir,
      "--dry-run",
      "--json",
    ], undefined, { BRAIN_HANDS_CONTROLLER_MODE: "development_checkout" });
    expect(blocked.exitCode).not.toBe(0);
    expect(`${blocked.stdout}\n${blocked.stderr}`)
      .toMatch(/current controller provenance does not match the accepted self-hosting run controller/i);
    expect(await readFile(join(ledger.runDir, "manifest.json"), "utf8")).toBe(manifestBeforeResume);
    expect(await readFile(join(ledger.runDir, "events.jsonl"), "utf8")).toBe(eventsBeforeResume);
    expect(await readdir(runRoot)).toEqual([ledger.runId]);

    const recovered = parseJson<{
      transition: { next_runtime: { package_hash: string } };
      transition_path: string;
      status: Status;
    }>((await runBuiltCli(projectRoot, [
      "recover-controller",
      "--run", ledger.runDir,
      "--actor", "operator@example.test",
      "--reason", "Accept the reviewed built CLI controller bytes",
      "--expected-package-sha256", currentHash,
      "--json",
    ], undefined, { BRAIN_HANDS_CONTROLLER_MODE: "development_checkout" })).stdout);
    expect(recovered.transition.next_runtime.package_hash).toBe(currentHash);
    expect(recovered.transition_path).toMatch(/^controller-recovery\/transitions\/000001-[a-f0-9]{64}\.json$/);
    expect(recovered.status.run_id).toBe(ledger.runId);
    expect((await readManifestV2(ledger.runDir)).controller_recovery.transition_count).toBe(1);

    const resumed = parseJson<Status>((await runBuiltCli(projectRoot, [
      "resume",
      "--run", ledger.runDir,
      "--dry-run",
      "--json",
    ], undefined, { BRAIN_HANDS_CONTROLLER_MODE: "development_checkout" })).stdout);
    expect(resumed).toMatchObject({
      run_id: ledger.runId,
      run_dir: ledger.runDir,
    });
    expect(await readdir(runRoot)).toEqual([ledger.runId]);
  }, 60_000);

  it("replaces only an abandoned built-CLI run and replays to the same fresh successor", async () => {
    const projectRoot = process.cwd();
    repoRoot = await createIsolatedGitRepository();
    expect((await execa("git", ["branch", "--show-current"], { cwd: repoRoot })).stdout).toBe("main");
    await runBuiltCli(projectRoot, ["init", "--repo", repoRoot]);
    await writeSupportedLocalConfig(repoRoot);

    const started = parseJson<Status>((await runBuiltCli(projectRoot, [
      "run",
      "Prove replacement through the built CLI",
      "--repo", repoRoot,
      "--mode", "local",
      "--no-research",
      "--no-reflection",
      "--dry-run",
      "--json",
    ])).stdout);
    expect(started.run_dir).not.toBeNull();
    const predecessorRunDir = started.run_dir!;
    const predecessorRunId = started.run_id;
    expect(await readdir(join(repoRoot, ".brain-hands", "runs"))).toEqual([predecessorRunId]);

    await runBuiltCli(projectRoot, [
      "abandon",
      "--run", predecessorRunDir,
      "--actor", "operator@example.test",
      "--reason", "Same-run recovery is unsafe in this fixture",
      "--json",
    ]);
    const predecessorAfterAbandon = parseJson<{
      terminal: { outcome: string } | null;
      assurance_outcome: string | null;
    }>(await readFile(join(predecessorRunDir, "manifest.json"), "utf8"));
    expect(predecessorAfterAbandon).toMatchObject({
      terminal: { outcome: "abandoned" },
      assurance_outcome: "abandoned",
    });
    expect(await readCanonicalEvents(predecessorRunDir)).toHaveLength(1);

    const replacement = parseJson<{
      predecessor_run_dir: string;
      successor_run_id: string;
      successor_run_dir: string;
      next_command: string;
    }>((await runBuiltCli(projectRoot, [
      "replace",
      "--run", predecessorRunDir,
      "--actor", "operator@example.test",
      "--reason", "The original worktree cannot be recovered",
      "--json",
    ])).stdout);
    expect(replacement.predecessor_run_dir).toBe(predecessorRunDir);
    expect(replacement.next_command).toContain("brain-hands resume --run");
    expect((await readdir(join(repoRoot, ".brain-hands", "runs"))).sort())
      .toEqual([predecessorRunId, replacement.successor_run_id].sort());

    const replay = parseJson<{ successor_run_id: string; successor_run_dir: string }>(
      (await runBuiltCli(projectRoot, [
        "replace",
        "--run", predecessorRunDir,
        "--actor", "operator@example.test",
        "--reason", "The original worktree cannot be recovered",
        "--json",
      ])).stdout,
    );
    expect(replay).toMatchObject({
      successor_run_id: replacement.successor_run_id,
      successor_run_dir: replacement.successor_run_dir,
    });
    expect((await readdir(join(repoRoot, ".brain-hands", "runs"))).sort())
      .toEqual([predecessorRunId, replacement.successor_run_id].sort());

    const successor = parseJson<{
      stage: string;
      approved_revision: number | null;
      approved_plan_revision: number | null;
      worktree_path: string | null;
      branch_name: string | null;
      issue_numbers: number[];
      pull_request_numbers: number[];
      final_artifact_paths: string[];
      github_ids: {
        issue_numbers: number[];
        work_item_issue_map: Record<string, number>;
        parent_issue_number: number | null;
        pull_request_numbers: number[];
        pull_request_urls: Record<string, string>;
      };
      terminal: unknown;
      task_lineage: { predecessor_run_id: string | null };
    }>(await readFile(join(replacement.successor_run_dir, "manifest.json"), "utf8"));
    expect(successor).toMatchObject({
      stage: "brain_discovery",
      approved_revision: null,
      approved_plan_revision: null,
      worktree_path: null,
      branch_name: null,
      issue_numbers: [],
      pull_request_numbers: [],
      final_artifact_paths: [],
      github_ids: {
        issue_numbers: [],
        work_item_issue_map: {},
        parent_issue_number: null,
        pull_request_numbers: [],
        pull_request_urls: {},
      },
      terminal: null,
      task_lineage: { predecessor_run_id: predecessorRunId },
    });
    const successorStatus = parseJson<Status>((await runBuiltCli(projectRoot, [
      "resume",
      "--run", replacement.successor_run_dir,
      "--dry-run",
      "--json",
    ])).stdout);
    expect(successorStatus).toMatchObject({
      run_id: replacement.successor_run_id,
      run_dir: replacement.successor_run_dir,
    });
    const successorLogs = parseJson<{ session_event: unknown }>((await runBuiltCli(projectRoot, [
      "logs",
      "--run", replacement.successor_run_dir,
      "--json",
    ])).stdout);
    expect(successorLogs.session_event).toBeNull();
  }, 60_000);
});
