import { access, chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildCli, readWorkflowDesign } from "../src/cli.js";
import type { BrainHandsConfig } from "../src/core/types.js";
import * as configModule from "../src/core/config.js";
import * as discoveryModule from "../src/workflow/discovery.js";
import * as browserVerifier from "../src/browser/verifier.js";
import * as ledgerModule from "../src/core/ledger.js";
import { defaultConfig } from "../src/core/config.js";
import * as preflight from "../src/workflow/preflight.js";
import * as repositoryInitModule from "../src/workflow/repository-init.js";
import * as reviewPackage from "../src/workflow/review-package.js";
import * as reflectionWorkflow from "../src/workflow/reflection.js";
import * as runtimeWorkflow from "../src/workflow/runtime.js";
import * as replanWorkflow from "../src/workflow/replan.js";
import * as verifiedPlanWorkflow from "../src/workflow/verified-plan.js";
import * as githubReconciliation from "../src/github/issue-reconciliation.js";
import * as handsWorker from "../src/workflow/worker.js";
import * as verifierWorkflow from "../src/workflow/verifier.js";
import * as sessionStore from "../src/progress/session-store.js";
import * as assuranceWorkflow from "../src/workflow/assurance.js";
import * as controllerProvenance from "../src/core/controller-provenance.js";
import { abandonRun } from "../src/workflow/assurance.js";
import { acquireExecutionLease, approvePlanRevision, createRunLedger, createRunLedgerV2, readManifestV2, recordPlan, recordTerminalDisposition, recordTerminalDispositionWithCleanup, releaseExecutionLease, updateManifestV2, withRunLedgerTransaction } from "../src/core/ledger.js";
import { executionSpec } from "./fixtures/execution-spec.js";
import { DryRunGitHubAdapter, GhCliGitHubAdapter, ISSUE_LABELS, formatIssueBody } from "../src/adapters/github.js";
import { readOperatorStatus, readRunLog } from "../src/workflow/status.js";
import { createLegacyRunLedgerV2, rewriteLegacyCheckoutSnapshot } from "./fixtures/legacy-run.js";
import { readProgressEvents } from "../src/progress/log.js";
import { canonicalSessionEventSchema } from "../src/progress/session-events.js";
import { approveDiscoveryBrief, recordDiscoveryAnswer } from "../src/core/discovery-ledger.js";
import { recordBrainFailure } from "../src/workflow/brain-failure.js";
import { buildRecoveryProgressSubject, gateOperationalRecoveryAttempt, recordOperationalRecovery } from "../src/workflow/recovery-runtime.js";
import { recoveryScopePathComponent } from "../src/workflow/recovery-policy.js";
import { authorizeDiagnosticResume, claimAuthorizedRecoveryAttempt } from "../src/workflow/recovery-ledger.js";
import * as controllerProvenanceModule from "../src/core/controller-provenance.js";
import * as replacementWorkflow from "../src/workflow/replacement.js";
import { execa } from "execa";
import { planIssueSyncPreview, writeGithubEffectPreview } from "../src/github/effect-plan.js";
import { createTaskLineage, readTaskLineage, withTaskLineageTransaction } from "../src/core/task-lineage.js";
import {
  resolvedRunConfigurationSchema,
  runConfigurationSha256,
  serializeRunConfiguration,
} from "../src/core/run-configuration.js";

let tempRoot: string | null = null;

function parseCanonicalSessionEvent(raw: string) {
  expect(raw).not.toBe("");
  expect(raw.endsWith("\n")).toBe(true);
  expect(raw.trimEnd().split("\n")).toHaveLength(1);
  return canonicalSessionEventSchema.parse(JSON.parse(raw));
}

function cliBrowserIssue(): Record<string, unknown> {
  return {
    type: "implementation_task",
    run_id: "cli-browser-run",
    parent_request: "Verify browser evidence",
    goal: "Capture browser evidence",
    context: "CLI browser verification regression",
    scope: { include: ["src"], exclude: [] },
    dependencies: [],
    implementation_steps: ["Capture browser evidence."],
    acceptance_criteria: ["Browser evidence is scoped."],
    verification: { required_commands: ["true"], manual_checks: [], expected_artifacts: [] },
    review_checklist: ["Evidence has a durable identity."],
    risk_register: [],
    handoff_prompt: "Capture browser evidence.",
  };
}

async function approvedCliRun(mode: "local" | "github", workItemId = "BH-008", reflection = false) {
  if (!tempRoot) tempRoot = await mkdtemp(join(tmpdir(), "brain-hands-cli-provenance-"));
  const ledger = await createLegacyRunLedgerV2({
    repoRoot: tempRoot,
    originalRequest: "Verify provenance",
    slug: `${mode}-provenance`,
    mode,
    intake: { task: "Verify provenance", repo_root: tempRoot, mode, research: false, reflection },
  });
  await sessionStore.initializeSessionArtifacts({
    runDir: ledger.runDir,
    runId: ledger.runId,
    createdAt: ledger.manifest.created_at,
  });
  await recordPlan(ledger.runDir, JSON.stringify({
    summary: "Verify provenance",
    assumptions: [],
    research: [],
    research_sources: [],
    architecture: "test",
    risks: [],
    work_items: [{
      ...executionSpec(workItemId),
      title: workItemId,
      objective: "Verify the work item",
    }],
    integration_verification: [["true"]],
  }));
  await approvePlanRevision(ledger.runDir, 1);
  if (mode === "github") {
    const lineageId = randomUUID();
    await createTaskLineage({ repoRoot: tempRoot, runId: ledger.runId, lineageId });
    const manifest = await readManifestV2(ledger.runDir);
    await writeFile(join(ledger.runDir, "manifest.json"), `${JSON.stringify({
      ...manifest,
      task_lineage_id: lineageId,
      github_effects_protocol: "task-lineage-v1",
    }, null, 2)}\n`, "utf8");
    await updateManifestV2(ledger.runDir, {
      work_item_issue_map: { [workItemId]: 8 },
      github_ids: { ...(await readManifestV2(ledger.runDir)).github_ids, issue_numbers: [8], work_item_issue_map: { [workItemId]: 8 } },
    });
  }
  return ledger;
}

async function attachReadyCliLineage(ledger: Awaited<ReturnType<typeof approvedCliRun>>, workItemId: string): Promise<void> {
  const manifest = await readManifestV2(ledger.runDir);
  const item = { ...executionSpec(workItemId), title: workItemId, objective: "Verify the work item" };
  const desired = {
    title: workItemId,
    body: formatIssueBody(item, { lineageId: manifest.task_lineage_id!, runId: manifest.run_id, workItemId }),
    labels: ISSUE_LABELS.split(","),
    state: "OPEN" as const,
    state_reason: null,
    reason_code: "approved-plan-work-item",
  };
  const preview = planIssueSyncPreview({
    revision: 1, lineage_id: manifest.task_lineage_id!, run_id: manifest.run_id,
    repository: { host: "github.com", name_with_owner: "acme/repo" },
    plan_revision: 1, plan_sha256: manifest.plan_revisions["1"]!.sha256, created_at: manifest.created_at, lineage_state: "active",
    issue_set: { state: "uninitialized", plan_revision: null, plan_sha256: null, parent_issue_number: null, work_item_issue_map: {}, has_prior_owned_state: false },
    approved_replan: false, parent: null, work_items: [{ work_item_id: workItemId, desired, observations: [] }],
  });
  const reference = { ...(await writeGithubEffectPreview({ run_dir: ledger.runDir, preview })), state: "applied" as const };
  const effect = preview.effects[0]!;
  await withTaskLineageTransaction({ repoRoot: tempRoot!, lineageId: manifest.task_lineage_id!, operation: (transaction) => {
    const current = transaction.read();
    return transaction.update({ ...current, repository_key: "github.com/acme/repo", issue_set: {
      ...current.issue_set, state: "ready", plan_revision: 1, plan_sha256: manifest.plan_revisions["1"]!.sha256,
      work_item_issue_map: { [workItemId]: 8 }, preview: reference,
      operations: { [effect.effect_id]: { operation_id: effect.effect_id, target_key: `work_item:${workItemId}`,
        desired_sha256: effect.desired_sha256, state: "complete", issue_number: 8, created_by_run_id: manifest.run_id } },
    } });
  } });
  await updateManifestV2(ledger.runDir, { github_effects: { issue_sync: reference, pull_request_delivery: null } });
}

async function diagnosticCliRun(workItemId = "BH-diagnostic") {
  const ledger = await approvedCliRun("local", workItemId);
  const manifest = await updateManifestV2(ledger.runDir, {
    stage: "implementing",
    delivery_state: "blocked",
    last_blocker: "Repeated implementation failure",
    current_work_item_id: workItemId,
    worktree_path: process.cwd(),
    branch_name: "test-diagnostic-resume",
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
  await recordOperationalRecovery({ ...recovery, effectAttemptId: "diagnostic-attempt-1" });
  const stopped = await recordOperationalRecovery({ ...recovery, effectAttemptId: "diagnostic-attempt-2" });
  expect(stopped.guard_action).toBe("diagnostic_stop");
  return { ...ledger, scopeId: recovery.scopeId, progress };
}

async function plannedDurableCliRun(
  mode: "local" | "github" = "local",
  reflection = false,
) {
  if (!tempRoot) tempRoot = await mkdtemp(join(tmpdir(), "brain-hands-cli-durable-plan-"));
  vi.spyOn(preflight, "runPreflight").mockResolvedValue({
    checks: [], required_checks_failed: false,
    github_auth: { status: "skipped", reason: null, stderr: "" }, github_auth_status: "skipped",
    supports_search: false, github_repository: null, missing_github_labels: [], drifted_github_labels: [],
  });
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  await buildCli().parseAsync([
    "run", "Verify durable plan binding", "--repo", tempRoot, "--mode", mode,
    "--no-research", reflection ? "--reflection" : "--no-reflection", "--dry-run", "--json",
  ], { from: "user" });
  const [runId] = await (await import("node:fs/promises")).readdir(join(tempRoot, ".brain-hands", "runs"));
  const runDir = join(tempRoot, ".brain-hands", "runs", runId);
  const answerPath = join(tempRoot, "answer.txt");
  await writeFile(answerPath, "Use the explicit boundary", "utf8");
  await buildCli().parseAsync([
    "answer-discovery", "--run", runDir, "--question", "q-001", "--input-file", answerPath,
    "--dry-run", "--json",
  ], { from: "user" });
  await buildCli().parseAsync([
    "select-discovery-approach", "--run", runDir, "--revision", "1", "--approach", "approach-explicit",
    "--dry-run", "--json",
  ], { from: "user" });
  await buildCli().parseAsync([
    "approve-discovery", "--run", runDir, "--revision", "1", "--dry-run", "--json",
  ], { from: "user" });
  return { runDir };
}

async function snapshotRunFiles(runDir: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) files[relative(runDir, path)] = (await readFile(path)).toString("base64");
    }
  }
  await walk(runDir);
  return files;
}

async function snapshotRunDirectoryEntries(runDir: string): Promise<string[]> {
  return (await readdir(runDir)).sort();
}

afterEach(async () => {
  if (tempRoot) {
    await rm(tempRoot, { recursive: true, force: true });
    tempRoot = null;
  }

  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("buildCli", () => {
  it("reports the package.json release version", async () => {
    const packageJson = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8")) as { version: string };
    expect(buildCli().version()).toBe(packageJson.version);
  });

  it("exposes the Brain Hands product identity", () => {
    const cli = buildCli();

    expect(cli.name()).toBe("brain-hands");
    expect(cli.version()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("registers the expected top-level commands", () => {
    const cli = buildCli();
    const names = cli.commands.map((command) => command.name());

    expect(names).toContain("init");
    expect(names.indexOf("preview")).toBeGreaterThan(names.indexOf("init"));
    expect(names.indexOf("preview")).toBeLessThan(names.indexOf("run"));
    expect(names).toContain("run");
    expect(names).toEqual(expect.arrayContaining([
      "answer-discovery",
      "select-discovery-approach",
      "proceed-discovery",
      "approve-discovery",
      "revise-discovery",
    ]));
    expect(names).toContain("issue");
    expect(names).toContain("implement");
    expect(names).toContain("review-package");
    expect(names).toContain("review");
    expect(names).toContain("reconcile-github");
    expect(names).toContain("fix");
    expect(names).toContain("browser");
    expect(names).toContain("resume");
    expect(names).toContain("close-run");
    expect(names).toContain("status");
    expect(names).toContain("recover-controller");
    expect(names).toContain("accept-risk");
    expect(names).toContain("abandon");
    expect(names).toContain("logs");
    expect(names).toContain("final-audit");
    expect(names).toContain("doctor");
  });

  it("records a controller transition without resuming workflow agents", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "brain-hands-cli-controller-recovery-"));
    const original = {
      self_hosting: true,
      mode: "development_checkout" as const,
      executable_path: "/old/dist/cli.js",
      package_root: "/old",
      package_name: "@ngelik/brain-hands",
      package_version: "0.4.0",
      package_hash_algorithm: "sha256" as const,
      package_hash: "a".repeat(64),
      candidate_commit: "b".repeat(40),
    };
    const ledger = await createRunLedgerV2({
      repoRoot: tempRoot,
      originalRequest: "Recover controller",
      sourceCommit: original.candidate_commit,
      controllerProvenance: original,
    });
    const current = { ...original, executable_path: "/new/dist/cli.js", package_root: "/new", package_hash: "c".repeat(64) };
    vi.spyOn(controllerProvenanceModule, "captureControllerProvenance")
      .mockResolvedValue({ provenance: current, selfHosting: true });
    const runWorkflow = vi.spyOn(runtimeWorkflow, "runWorkflow");
    const discovery = vi.spyOn(discoveryModule, "runDiscoveryTurn");
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await buildCli().parseAsync([
      "recover-controller",
      "--run", ledger.runDir,
      "--actor", "operator@example.test",
      "--reason", "Install the reviewed controller fix",
      "--expected-package-sha256", current.package_hash,
      "--json",
    ], { from: "user" });

    expect((await readManifestV2(ledger.runDir)).controller_recovery.transition_count).toBe(1);
    const rendered = JSON.parse(String(output.mock.calls.at(-1)?.[0])) as Record<string, unknown>;
    expect(rendered).toMatchObject({
      transition: { actor: "operator@example.test", next_runtime: { package_hash: current.package_hash } },
    });
    expect(runWorkflow).not.toHaveBeenCalled();
    expect(discovery).not.toHaveBeenCalled();
  });

  it("blocks normal resume before workflow mutation when controller bytes changed", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "brain-hands-cli-controller-mismatch-"));
    await writeFile(join(tempRoot, "package.json"), JSON.stringify({
      name: "@ngelik/brain-hands",
      version: "0.4.0",
    }));
    await execa("git", ["init", "-q"], { cwd: tempRoot });
    await execa("git", ["config", "user.email", "brain-hands@example.test"], { cwd: tempRoot });
    await execa("git", ["config", "user.name", "Brain Hands"], { cwd: tempRoot });
    await execa("git", ["add", "."], { cwd: tempRoot });
    await execa("git", ["commit", "-qm", "candidate"], { cwd: tempRoot });
    const candidateHead = (await execa("git", ["rev-parse", "HEAD"], { cwd: tempRoot })).stdout;
    const packageMetadata = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8")) as { version: string };
    const recorded = {
      self_hosting: true,
      mode: "development_checkout" as const,
      executable_path: join(process.cwd(), "dist", "cli.js"),
      package_root: process.cwd(),
      package_name: "@ngelik/brain-hands",
      package_version: packageMetadata.version,
      package_hash_algorithm: "sha256" as const,
      package_hash: "a".repeat(64),
      candidate_commit: candidateHead,
    };
    const ledger = await createRunLedgerV2({
      repoRoot: tempRoot,
      originalRequest: "Do not resume with changed controller",
      sourceCommit: candidateHead,
      controllerProvenance: recorded,
    });
    const manifestBefore = await readFile(join(ledger.runDir, "manifest.json"), "utf8");
    const eventsBefore = await readFile(join(ledger.runDir, "events.jsonl"), "utf8");
    const runWorkflow = vi.spyOn(runtimeWorkflow, "runWorkflow");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const previousEntrypoint = process.argv[1];
    const previousMode = process.env.BRAIN_HANDS_CONTROLLER_MODE;
    process.argv[1] = join(process.cwd(), "dist", "cli.js");
    process.env.BRAIN_HANDS_CONTROLLER_MODE = "development_checkout";
    try {
      await expect(buildCli().parseAsync([
        "resume", "--run", ledger.runDir, "--dry-run", "--json",
      ], { from: "user" })).rejects.toThrow(/does not match.*accepted/i);
    } finally {
      process.argv[1] = previousEntrypoint;
      if (previousMode === undefined) delete process.env.BRAIN_HANDS_CONTROLLER_MODE;
      else process.env.BRAIN_HANDS_CONTROLLER_MODE = previousMode;
    }

    expect(await readFile(join(ledger.runDir, "manifest.json"), "utf8")).toBe(manifestBefore);
    expect(await readFile(join(ledger.runDir, "events.jsonl"), "utf8")).toBe(eventsBefore);
    expect(runWorkflow).not.toHaveBeenCalled();
  });

  it("registers partial intake and model options on preview", () => {
    const preview = buildCli().commands.find((command) => command.name() === "preview");

    expect(preview?.options.map((option) => option.name())).toEqual([
      "repo",
      "mode",
      "research",
      "no-research",
      "reflection",
      "no-reflection",
      "brain-model",
      "hands-model",
      "verifier-model",
      "json",
    ]);
  });

  it("returns a complete read-only configuration preview before intake choices", async () => {
    const packageJson = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8")) as { version: string };
    tempRoot = await mkdtemp(join(tmpdir(), "brain-hands-cli-preview-"));
    const configPath = await configModule.initConfig(tempRoot);
    const configBefore = await readFile(configPath, "utf8");
    const entriesBefore = await readdir(join(tempRoot, ".brain-hands"));
    const preflightCall = vi.spyOn(preflight, "runPreflight");
    const discoveryCall = vi.spyOn(discoveryModule, "runDiscoveryTurn");
    const initCall = vi.spyOn(repositoryInitModule, "initializeRepository");
    const ledgerCall = vi.spyOn(ledgerModule, "createRunLedgerV2");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await buildCli().parseAsync(["preview", "--repo", tempRoot, "--json"], { from: "user" });

    expect(log).toHaveBeenCalledTimes(1);
    const output = JSON.parse(String(log.mock.calls[0]?.[0])) as Record<string, unknown> & {
      controller: Record<string, unknown>;
      missing_choices: string[];
      rendered_preview: string;
    };
    expect(output).toMatchObject({
      repository: tempRoot,
      mode: null,
      research: null,
      reflection: null,
      missing_choices: ["mode", "research", "reflection"],
      controller: {
        package_name: "@ngelik/brain-hands",
        package_version: packageJson.version,
        mode: "development_checkout",
      },
      github: { effects: "depends_on_execution_mode", default_remote: "origin" },
    });
    expect(output.rendered_preview).toContain("Brain Hands configuration preview (3 choices pending)");
    expect(output.rendered_preview).toContain("Mode: needs your choice");
    expect(output.rendered_preview).toContain("GitHub effects: depends on execution-mode choice");
    expect(JSON.stringify(output)).not.toMatch(/executable_path|package_root|package_hash|candidate_commit|codex.*command|prompt|credential/);
    expect(preflightCall).not.toHaveBeenCalled();
    expect(discoveryCall).not.toHaveBeenCalled();
    expect(initCall).not.toHaveBeenCalled();
    expect(ledgerCall).not.toHaveBeenCalled();
    expect(await readFile(configPath, "utf8")).toBe(configBefore);
    expect(await readdir(join(tempRoot, ".brain-hands"))).toEqual(entriesBefore);
    await expect(access(join(tempRoot, ".brain-hands", "runs"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("renders supplied preview choices and model overrides without filling missing choices", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "brain-hands-cli-preview-partial-"));
    await configModule.initConfig(tempRoot);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await buildCli().parseAsync([
      "preview",
      "--repo", tempRoot,
      "--mode", "github",
      "--no-research",
      "--hands-model", "hands-override",
    ], { from: "user" });

    const output = String(log.mock.calls[0]?.[0]);
    expect(output).toContain("Brain Hands configuration preview (1 choice pending)");
    expect(output).toContain("Mode: github");
    expect(output).toContain("Research: disabled");
    expect(output).toContain("Reflection: needs your choice");
    expect(output).toContain("Hands: hands-override | high reasoning | workspace-write | CLI override");
    expect(output).toContain("GitHub effects: issues and one pull request");
  });

  it("returns a fully resolved preview with every model override", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "brain-hands-cli-preview-resolved-"));
    await configModule.initConfig(tempRoot);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await buildCli().parseAsync([
      "preview",
      "--repo", tempRoot,
      "--mode", "local",
      "--research", "false",
      "--reflection", "true",
      "--brain-model", "brain-override",
      "--hands-model", "hands-override",
      "--verifier-model", "verifier-override",
      "--json",
    ], { from: "user" });

    const output = JSON.parse(String(log.mock.calls[0]?.[0])) as {
      missing_choices: string[];
      roles: Record<string, { model: string; source: string }>;
      github: { effects: string };
      rendered_preview: string;
    };
    expect(output.missing_choices).toEqual([]);
    expect(output.roles).toMatchObject({
      brain: { model: "brain-override", source: "cli_override" },
      hands: { model: "hands-override", source: "cli_override" },
      verifier: { model: "verifier-override", source: "cli_override" },
    });
    expect(output.github.effects).toBe("none");
    expect(output.rendered_preview).toContain("Brain Hands configuration preview (0 choices pending)");
  });

  it("resolves human model tier wording before rendering the canonical preview", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "brain-hands-cli-preview-model-hint-"));
    await configModule.initConfig(tempRoot);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await buildCli().parseAsync([
      "preview",
      "--repo", tempRoot,
      "--verifier-model", "balanced",
      "--json",
    ], { from: "user" });

    const output = JSON.parse(String(log.mock.calls[0]?.[0])) as {
      roles: Record<string, { model: string; source: string }>;
      rendered_preview: string;
    };
    expect(output.roles.verifier).toMatchObject({ model: "gpt-5.6-terra", source: "cli_override" });
    expect(output.rendered_preview).toContain("Verifier: gpt-5.6-terra");
  });

  it.each([
    [["--mode", "remote"], /--mode must be either local or github/],
    [["--research", "sometimes"], /--research must be explicitly selected as true or false/],
    [["--reflection", "sometimes"], /--reflection must be explicitly selected as true or false/],
  ])("rejects invalid preview choice %j without creating a run", async (choice, expected) => {
    tempRoot = await mkdtemp(join(tmpdir(), "brain-hands-cli-preview-invalid-choice-"));
    await configModule.initConfig(tempRoot);

    await expect(buildCli().parseAsync(["preview", "--repo", tempRoot, ...choice], { from: "user" }))
      .rejects.toThrow(expected);
    await expect(access(join(tempRoot, ".brain-hands", "runs"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("directs an uninitialized preview to local initialization without creating files", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "brain-hands-cli-preview-uninitialized-"));

    await expect(buildCli().parseAsync(["preview", "--repo", tempRoot], { from: "user" }))
      .rejects.toThrow(`Run: brain-hands init --repo ${tempRoot}`);
    await expect(access(join(tempRoot, ".brain-hands"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("previews a v1 config without migrating or backing it up", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "brain-hands-cli-preview-v1-"));
    const configDir = join(tempRoot, ".brain-hands");
    const configPath = join(configDir, "config.yaml");
    const legacy = await readFile(join(process.cwd(), "docs", "example-config.yaml"), "utf8");
    await mkdir(configDir, { recursive: true });
    await writeFile(configPath, legacy, "utf8");
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await buildCli().parseAsync(["preview", "--repo", tempRoot, "--json"], { from: "user" });

    expect(await readFile(configPath, "utf8")).toBe(legacy);
    await expect(access(`${configPath}.v1.bak`)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(configDir, "runs"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects invalid configuration without rewriting it or creating artifacts", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "brain-hands-cli-preview-invalid-config-"));
    const configDir = join(tempRoot, ".brain-hands");
    const configPath = join(configDir, "config.yaml");
    const invalid = "version: 2\nprofiles: []\n";
    await mkdir(configDir, { recursive: true });
    await writeFile(configPath, invalid, "utf8");

    await expect(buildCli().parseAsync(["preview", "--repo", tempRoot, "--json"], { from: "user" }))
      .rejects.toThrow();
    expect(await readFile(configPath, "utf8")).toBe(invalid);
    expect(await readdir(configDir)).toEqual(["config.yaml"]);
  });

  it("requires explicit terminal actor, reason, and gate options", () => {
    const cli = buildCli();
    const acceptRisk = cli.commands.find((command) => command.name() === "accept-risk")!;
    const abandon = cli.commands.find((command) => command.name() === "abandon")!;
    expect(acceptRisk.options.filter((option) => option.required).map((option) => option.name()))
      .toEqual(expect.arrayContaining(["run", "gate", "actor", "reason"]));
    expect(abandon.options.filter((option) => option.required).map((option) => option.name()))
      .toEqual(expect.arrayContaining(["run", "actor", "reason"]));
  });

  it("registers diagnostic recovery options on resume without making them globally required", () => {
    const resume = buildCli().commands.find((command) => command.name() === "resume")!;
    expect(resume.options.map((option) => option.name()))
      .toEqual(expect.arrayContaining(["actor", "recovery-note-file"]));
    expect(resume.options.filter((option) => option.mandatory).map((option) => option.name()))
      .not.toEqual(expect.arrayContaining(["actor", "recovery-note-file"]));
  });

  it.each([
    { label: "plain resume", options: [] },
    { label: "actor only", options: ["--actor", "operator@example.com"] },
    { label: "note only", options: ["--recovery-note-file", "note.txt"] },
  ])("rejects $label at diagnostic stop without changing the run", async ({ options }) => {
    const ledger = await diagnosticCliRun();
    const before = await snapshotRunFiles(ledger.runDir);

    await expect(buildCli().parseAsync([
      "resume", "--run", ledger.runDir, "--dry-run", ...options,
    ], { from: "user" })).rejects.toThrow(/diagnostic.*requires.*actor.*recovery-note-file/i);

    expect(await snapshotRunFiles(ledger.runDir)).toEqual(before);
  });

  it("rejects secret recovery notes before writing authorization artifacts", async () => {
    const ledger = await diagnosticCliRun();
    const notePath = join(tempRoot!, "recovery-note.txt");
    await writeFile(notePath, "api_key=sk-proj-abcdefghijklmnop", "utf8");
    const before = await snapshotRunFiles(ledger.runDir);

    await expect(buildCli().parseAsync([
      "resume", "--run", ledger.runDir, "--actor", "operator@example.com",
      "--recovery-note-file", notePath, "--dry-run",
    ], { from: "user" })).rejects.toThrow(/recovery note contains secret material/i);

    expect(await snapshotRunFiles(ledger.runDir)).toEqual(before);
    await expect(access(join(
      ledger.runDir,
      "recovery/scopes",
      recoveryScopePathComponent(ledger.scopeId),
      "authorizations",
    ))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("persists one deterministic claim and lets exact or plain resume replay after a crash", async () => {
    const ledger = await diagnosticCliRun();
    const notePath = join(tempRoot!, "recovery-note.txt");
    await writeFile(notePath, "The dependency is restored; retry the same exact effect once.", "utf8");
    const firstCrash = new Error("crash after CLI recovery claim");
    const secondCrash = new Error("exact recovery replay reached the runtime");
    const thirdCrash = new Error("plain resume reached the runtime");
    const workflow = vi.spyOn(runtimeWorkflow, "runWorkflow")
      .mockRejectedValueOnce(firstCrash)
      .mockRejectedValueOnce(secondCrash)
      .mockRejectedValueOnce(thirdCrash);

    await expect(buildCli().parseAsync([
      "resume", "--run", ledger.runDir, "--actor", "operator@example.com",
      "--recovery-note-file", notePath, "--dry-run",
    ], { from: "user" })).rejects.toBe(firstCrash);

    const authorizationRoot = join(
      ledger.runDir,
      "recovery/scopes",
      recoveryScopePathComponent(ledger.scopeId),
      "authorizations",
    );
    const claimedEntries = (await readdir(authorizationRoot)).sort();
    expect(claimedEntries).toHaveLength(2);
    expect(claimedEntries.some((entry) => entry.endsWith("-consumed.json"))).toBe(true);
    const runtimeReplay = await gateOperationalRecoveryAttempt({
      runDir: ledger.runDir,
      scopeId: ledger.scopeId,
      operation: "work-item-fix",
      requestedEffect: "retry_operation",
      requestedEffectReason: "implementation_retry",
      findingIds: [],
      classification: {
        failure_class: "implementation_failure",
        blocker_code: "implementation_failed",
      },
      progress: ledger.progress,
    });
    expect(runtimeReplay).toMatchObject({
      mode: "authorized_attempt",
      authorization_id: expect.stringMatching(/^diagnostic-authorization:/),
      effect_attempt_id: expect.stringMatching(/^recovery-attempt:/),
    });
    expect((await readdir(authorizationRoot)).sort()).toEqual(claimedEntries);

    await expect(buildCli().parseAsync([
      "resume", "--run", ledger.runDir, "--actor", "operator@example.com",
      "--recovery-note-file", notePath, "--dry-run",
    ], { from: "user" })).rejects.toBe(secondCrash);
    expect((await readdir(authorizationRoot)).sort()).toEqual(claimedEntries);

    await expect(buildCli().parseAsync([
      "resume", "--run", ledger.runDir, "--dry-run",
    ], { from: "user" })).rejects.toBe(thirdCrash);
    expect(workflow).toHaveBeenCalledTimes(3);
    expect((await readdir(authorizationRoot)).sort()).toEqual(claimedEntries);
  });

  it("replays the exact resume command after an authorization-artifact interruption", async () => {
    const ledger = await diagnosticCliRun("BH-authorization-artifact-crash");
    const actor = "operator@example.com";
    const note = "Retry the exact current-head effect after authorization persistence.";
    const notePath = join(tempRoot!, "authorization-artifact-note.txt");
    await writeFile(notePath, note, "utf8");
    const interruption = new Error("authorization artifact persisted");
    await expect(authorizeDiagnosticResume({
      runDir: ledger.runDir,
      actor,
      note,
      hooks: { afterAuthorizationArtifact: async () => { throw interruption; } },
    })).rejects.toBe(interruption);
    expect((await readManifestV2(ledger.runDir)).recovery.scopes[ledger.scopeId]).toMatchObject({
      disposition: "diagnostic_stop",
      authorization_path: null,
    });
    const authorizationRoot = join(
      ledger.runDir,
      "recovery/scopes",
      recoveryScopePathComponent(ledger.scopeId),
      "authorizations",
    );
    expect(await readdir(authorizationRoot)).toHaveLength(1);
    const continuation = new Error("authorization replay reached workflow");
    const workflow = vi.spyOn(runtimeWorkflow, "runWorkflow").mockRejectedValueOnce(continuation);

    await expect(buildCli().parseAsync([
      "resume", "--run", ledger.runDir, "--actor", actor,
      "--recovery-note-file", notePath, "--dry-run",
    ], { from: "user" })).rejects.toBe(continuation);

    const entries = (await readdir(authorizationRoot)).sort();
    expect(entries).toHaveLength(2);
    expect(entries.filter((entry) => !entry.endsWith("-consumed.json"))).toHaveLength(1);
    const consumption = JSON.parse(await readFile(join(
      authorizationRoot,
      entries.find((entry) => entry.endsWith("-consumed.json"))!,
    ), "utf8"));
    expect(consumption.effect_attempt_id).toMatch(/^recovery-attempt:/);
    expect(workflow).toHaveBeenCalledTimes(1);
  });

  it("replays the exact resume command after a consumption-artifact interruption", async () => {
    const ledger = await diagnosticCliRun("BH-consumption-artifact-crash");
    const actor = "operator@example.com";
    const note = "Retry the exact current-head effect after consumption persistence.";
    const notePath = join(tempRoot!, "consumption-artifact-note.txt");
    await writeFile(notePath, note, "utf8");
    const authorization = await authorizeDiagnosticResume({ runDir: ledger.runDir, actor, note });
    const interruption = new Error("consumption artifact persisted");
    await expect(claimAuthorizedRecoveryAttempt({
      runDir: ledger.runDir,
      authorization,
      hooks: { afterConsumptionArtifact: async () => { throw interruption; } },
    })).rejects.toBe(interruption);
    expect((await readManifestV2(ledger.runDir)).recovery.scopes[ledger.scopeId]).toMatchObject({
      disposition: "active",
      authorization_path: expect.stringMatching(/authorizations\/diagnostic-authorization:/),
    });
    const authorizationRoot = join(
      ledger.runDir,
      "recovery/scopes",
      recoveryScopePathComponent(ledger.scopeId),
      "authorizations",
    );
    const entriesBefore = (await readdir(authorizationRoot)).sort();
    const consumptionPath = join(
      authorizationRoot,
      entriesBefore.find((entry) => entry.endsWith("-consumed.json"))!,
    );
    const attemptBefore = JSON.parse(await readFile(consumptionPath, "utf8")).effect_attempt_id;
    const continuation = new Error("consumption replay reached workflow");
    const workflow = vi.spyOn(runtimeWorkflow, "runWorkflow").mockRejectedValueOnce(continuation);

    await expect(buildCli().parseAsync([
      "resume", "--run", ledger.runDir, "--actor", actor,
      "--recovery-note-file", notePath, "--dry-run",
    ], { from: "user" })).rejects.toBe(continuation);

    expect((await readdir(authorizationRoot)).sort()).toEqual(entriesBefore);
    expect(JSON.parse(await readFile(consumptionPath, "utf8")).effect_attempt_id).toBe(attemptBefore);
    expect(workflow).toHaveBeenCalledTimes(1);
  });

  it.each([
    { actor: "different@example.com", note: "Retry the exact current-head effect." },
    { actor: "operator@example.com", note: "A different recovery note." },
  ])("rejects mismatched $actor replay input for an active diagnostic authorization", async ({ actor, note }) => {
    const ledger = await diagnosticCliRun("BH-mismatched-authorization");
    const originalNote = "Retry the exact current-head effect.";
    await authorizeDiagnosticResume({
      runDir: ledger.runDir,
      actor: "operator@example.com",
      note: originalNote,
    });
    const notePath = join(tempRoot!, "mismatched-recovery-note.txt");
    await writeFile(notePath, note, "utf8");
    const before = await snapshotRunFiles(ledger.runDir);

    await expect(buildCli().parseAsync([
      "resume", "--run", ledger.runDir, "--actor", actor,
      "--recovery-note-file", notePath, "--dry-run",
    ], { from: "user" })).rejects.toThrow(/authorization|replay|diagnostic/i);

    expect(await snapshotRunFiles(ledger.runDir)).toEqual(before);
  });

  it.each([
    ["--actor", "operator@example.com"],
    ["--recovery-note-file", "note.txt"],
    ["--actor", "operator@example.com", "--recovery-note-file", "note.txt"],
  ])("rejects recovery options outside diagnostic stop without changing the run", async (...options) => {
    const ledger = await approvedCliRun("local", "BH-non-diagnostic");
    const before = await snapshotRunFiles(ledger.runDir);

    await expect(buildCli().parseAsync([
      "resume", "--run", ledger.runDir, "--dry-run", ...options,
    ], { from: "user" })).rejects.toThrow(/recovery options.*diagnostic stop/i);

    expect(await snapshotRunFiles(ledger.runDir)).toEqual(before);
  });

  it("registers explicit repository initialization options", () => {
    const init = buildCli().commands.find((command) => command.name() === "init");
    expect(init?.options.map((option) => option.name())).toEqual(expect.arrayContaining([
      "repo", "github", "dry-run", "force", "json",
    ]));
  });

  it("registers follow options on producers and logs", () => {
    const cli = buildCli();
    for (const name of [
      "run",
      "answer-discovery",
      "select-discovery-approach",
      "proceed-discovery",
      "approve-discovery",
      "revise-discovery",
      "approve-plan",
      "resume",
      "logs",
    ]) {
      const command = cli.commands.find((candidate) => candidate.name() === name)!;
      expect(command.options.map((option) => option.name())).toContain("follow");
    }
  });

  it("registers the exact discovery command boundaries", () => {
    const cli = buildCli();
    const optionNames = (name: string) => cli.commands.find((command) => command.name() === name)!
      .options.map((option) => option.name());
    expect(optionNames("answer-discovery")).toEqual(["run", "question", "input-file", "dry-run", "json", "follow"]);
    expect(optionNames("select-discovery-approach")).toEqual(["run", "revision", "approach", "dry-run", "json", "follow"]);
    expect(optionNames("proceed-discovery")).toEqual(["run", "question", "input-file", "dry-run", "json", "follow"]);
    expect(optionNames("approve-discovery")).toEqual(["run", "revision", "dry-run", "json", "follow"]);
    expect(optionNames("revise-discovery")).toEqual(["run", "revision", "input-file", "dry-run", "json", "follow"]);
  });

  it("keeps plan approval explicit and exact", () => {
    const approvePlan = buildCli().commands.find((command) => command.name() === "approve-plan")!;
    expect(approvePlan.options.map((option) => option.name()))
      .toEqual(["revision", "run", "repo", "dry-run", "json", "follow"]);
  });

  it("registers review-package command options", () => {
    const reviewPackage = buildCli().commands.find((command) => command.name() === "review-package");
    if (!reviewPackage) {
      throw new Error("review-package command was not found");
    }

    const optionNames = reviewPackage.options.map((option) => option.name());
    expect(optionNames).toContain("run");
    expect(optionNames).toContain("issue");
    expect(optionNames).toContain("work-item");
    expect(optionNames).toContain("out");
    expect(optionNames).toContain("repo");
  });

  it("registers nested issue import command options", () => {
    const issue = buildCli().commands.find((command) => command.name() === "issue");
    if (!issue) {
      throw new Error("issue command was not found");
    }

    const importCommand = issue.commands.find((command) => command.name() === "import");
    if (!importCommand) {
      throw new Error("issue import command was not found");
    }

    const optionNames = importCommand.options.map((option) => option.name());
    expect(optionNames).toContain("run");
    expect(optionNames).toContain("file");
  });

  it("registers nested browser verify command options", () => {
    const browser = buildCli().commands.find((command) => command.name() === "browser");
    if (!browser) {
      throw new Error("browser command was not found");
    }

    const verify = browser.commands.find((command) => command.name() === "verify");
    if (!verify) {
      throw new Error("browser verify command was not found");
    }

    const optionNames = verify.options.map((option) => option.name());
    expect(optionNames).toContain("issue-file");
    expect(optionNames).toContain("repo");
    expect(optionNames).toContain("report");
    expect(optionNames).toContain("run");
    expect(optionNames).toContain("issue");
    expect(optionNames).toContain("work-item");
    expect(optionNames).toContain("integrated");
    expect(optionNames).toContain("attempt");
    expect(optionNames).toContain("chrome");
  });

  it.each([
    { label: "integrated", mode: "local" as const, args: ["--integrated"], identity: { scope: "integrated", work_item_id: "integrated" } },
    { label: "mapped GitHub", mode: "github" as const, args: ["--issue", "8"], identity: { scope: "github", work_item_id: "BH-008", issue_number: 8 } },
    { label: "local work item", mode: "local" as const, args: ["--work-item", "BH-008"], identity: { scope: "local", work_item_id: "BH-008" } },
  ])("forwards the exact $label browser identity and attempt 2", async ({ mode, args, identity }) => {
    const ledger = await approvedCliRun(mode);
    const issuePath = join(tempRoot!, "browser-issue.json");
    await writeFile(issuePath, `${JSON.stringify(cliBrowserIssue())}\n`, "utf8");
    const verify = vi.spyOn(browserVerifier, "verifyBrowserIssue").mockResolvedValue({} as Awaited<ReturnType<typeof browserVerifier.verifyBrowserIssue>>);

    await buildCli().parseAsync([
      "browser", "verify", "--issue-file", issuePath, "--report", "reports/browser.json", "--run", ledger.runDir,
      ...args, "--attempt", "2", "--repo", tempRoot!,
    ], { from: "user" });

    expect(verify).toHaveBeenCalledWith(expect.objectContaining({ identity, attempt: 2 }));
  });

  it("rejects a browser identity that disagrees with persisted progress before invoking the verifier", async () => {
    const ledger = await approvedCliRun("local");
    await updateManifestV2(ledger.runDir, {
      work_item_progress: { "BH-008": { status: "in_progress", attempts: 2, verification_scope: "local", verification_work_item_id: "other" } },
    });
    const issuePath = join(tempRoot!, "browser-issue.json");
    await writeFile(issuePath, `${JSON.stringify(cliBrowserIssue())}\n`, "utf8");
    const verify = vi.spyOn(browserVerifier, "verifyBrowserIssue");

    await expect(buildCli().parseAsync([
      "browser", "verify", "--issue-file", issuePath, "--report", "reports/browser.json", "--run", ledger.runDir,
      "--work-item", "BH-008", "--attempt", "2", "--repo", tempRoot!,
    ], { from: "user" })).rejects.toThrow(/persisted work item/i);
    expect(verify).not.toHaveBeenCalled();
  });

  it("forwards a local work item to review-package and keeps GitHub packages mapped by issue", async () => {
    const localRun = await approvedCliRun("local");
    const githubRun = await approvedCliRun("github", "BH-009");
    const create = vi.spyOn(reviewPackage, "createReviewPackage").mockResolvedValue({ packageDir: "package", reviewPath: "review.md", promptPath: "prompt.md", copiedFiles: [] });

    await buildCli().parseAsync(["review-package", "--run", localRun.runDir, "--work-item", "BH-008", "--out", "review-local", "--repo", tempRoot!], { from: "user" });
    await buildCli().parseAsync(["review-package", "--run", githubRun.runDir, "--issue", "8", "--out", "review-github", "--repo", tempRoot!], { from: "user" });

    expect(create).toHaveBeenNthCalledWith(1, expect.objectContaining({ workItemId: "BH-008", issueNumber: undefined }));
    expect(create).toHaveBeenNthCalledWith(2, expect.objectContaining({ workItemId: undefined, issueNumber: 8 }));
  });

  it("registers strict no-github doctor options", () => {
    const doctor = buildCli().commands.find((command) => command.name() === "doctor");
    if (!doctor) {
      throw new Error("doctor command was not found");
    }

    const optionNames = doctor.options.map((option) => option.name());
    const optionLongs = doctor.options.map((option) => option.long ?? "");

    expect(optionNames).toContain("repo");
    expect(optionNames).toContain("strict");
    expect(optionNames).toContain("no-github");
    expect(optionLongs).toContain("--strict");
    expect(optionLongs).toContain("--no-github");
  });

  it("uses config.github.enabled to disable GitHub checks during doctor", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "brain-hands-cli-"));
    const baseConfig = defaultConfig();
    const noGithubConfig = {
      ...baseConfig,
      github: { ...baseConfig.github, enabled: false },
    } as BrainHandsConfig;
    const runPreflight = vi
      .spyOn(preflight, "runPreflight")
      .mockResolvedValue({
        checks: [],
        required_checks_failed: false,
        github_auth: { status: "skipped", reason: null, stderr: "" },
        github_auth_status: "skipped",
        supports_search: false,
        github_repository: null,
        missing_github_labels: [],
        drifted_github_labels: [],
      });
    vi.spyOn(configModule, "loadConfig").mockResolvedValue(noGithubConfig);

    const cli = buildCli();
    await cli.parseAsync(["doctor", "--repo", tempRoot, "--mode", "local", "--strict"], {
      from: "user",
    });

    expect(runPreflight).toHaveBeenCalledWith({
      repoRoot: tempRoot,
      config: noGithubConfig,
      strict: true,
      githubMode: false,
    });
  });

  it("requires every non-interactive intake choice before creating a run", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "brain-hands-cli-"));

    await expect(
      buildCli().parseAsync(["run", "Ship the feature", "--repo", tempRoot], { from: "user" }),
    ).rejects.toThrow("Missing required intake choice(s): mode (--mode local|github), research (--research or --no-research), reflection (--reflection or --no-reflection)");
  });

  it("records failed telemetry when preflight fails after run creation", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "brain-hands-cli-preflight-failure-"));
    const sentinel = new Error("preflight sentinel");
    vi.spyOn(preflight, "runPreflight").mockRejectedValueOnce(sentinel);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(buildCli().parseAsync([
      "run", "Record the preflight failure", "--repo", tempRoot, "--mode", "local",
      "--no-research", "--no-reflection", "--dry-run", "--json",
    ], { from: "user" })).rejects.toBe(sentinel);

    const [runId] = await readdir(join(tempRoot, ".brain-hands", "runs"));
    const runDir = join(tempRoot, ".brain-hands", "runs", runId!);
    const progressEvents = [];
    for await (const event of readProgressEvents(runDir)) progressEvents.push(event);
    expect(progressEvents.some((event) => event.event_key.includes("worker_started"))).toBe(true);
    expect(progressEvents.some((event) => event.event_key.includes("role_failed"))).toBe(true);
  });

  it("bypasses external preflight only for a gated release rehearsal", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "brain-hands-cli-release-preflight-"));
    const preflightCall = vi.spyOn(preflight, "runPreflight").mockResolvedValue({
      checks: [], required_checks_failed: false,
      github_auth: { status: "skipped", reason: null, stderr: "" }, github_auth_status: "skipped",
      supports_search: false, github_repository: null, missing_github_labels: [], drifted_github_labels: [],
    });
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("BRAIN_HANDS_RELEASE_REHEARSAL", "1");
    vi.stubEnv("BRAIN_HANDS_RELEASE_REHEARSAL_SCENARIO", "happy");

    await buildCli().parseAsync([
      "run", "Rehearse without external preflight", "--repo", tempRoot, "--mode", "local",
      "--no-research", "--no-reflection", "--dry-run", "--json",
    ], { from: "user" });

    expect(preflightCall).not.toHaveBeenCalled();
    const runRoot = join(tempRoot, ".brain-hands", "runs");
    const rehearsalRun = (await readdir(runRoot)).find((name) => name.endsWith("rehearse-without-external-preflight"));
    expect(rehearsalRun).toBeDefined();
    const persisted = JSON.parse(await readFile(join(runRoot, rehearsalRun!, "preflight.json"), "utf8"));
    expect(persisted).toMatchObject({
      checks: [expect.objectContaining({
        command: "brain-hands-release-rehearsal",
        args: ["happy"],
        required: true,
        status: "OK",
        available: true,
        exit_code: 0,
      })],
      required_checks_failed: false,
      github_auth_status: "skipped",
    });

    vi.stubEnv("BRAIN_HANDS_RELEASE_REHEARSAL", "");
    await buildCli().parseAsync([
      "run", "Ordinary dry run uses preflight", "--repo", tempRoot, "--mode", "local",
      "--no-research", "--no-reflection", "--dry-run", "--json",
    ], { from: "user" });
    expect(preflightCall).toHaveBeenCalledTimes(1);
  });

  it.each(["controller attestation append"] as const)(
    "binds run lifecycle telemetry before a failing %s",
    async (failurePoint) => {
      tempRoot = await mkdtemp(join(tmpdir(), "brain-hands-cli-bootstrap-failure-"));
      const sentinel = new Error(`${failurePoint} sentinel`);
      const createLedger = vi.spyOn(ledgerModule, "createRunLedgerV2");
      const appendRunEvent = ledgerModule.appendRunEvent;
      vi.spyOn(ledgerModule, "appendRunEvent").mockImplementation(async (runDir, input) => {
        if (input.type === "controller_attested") throw sentinel;
        return appendRunEvent(runDir, input);
      });
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await expect(buildCli().parseAsync([
        "run", "Record bootstrap failure", "--repo", tempRoot, "--mode", "local",
        "--no-research", "--no-reflection", "--dry-run", "--json",
      ], { from: "user" })).rejects.toBe(sentinel);

      expect(createLedger).toHaveBeenCalledTimes(1);
      const runIds = await readdir(join(tempRoot, ".brain-hands", "runs"));
      expect(runIds).toHaveLength(1);
      const runDir = join(tempRoot, ".brain-hands", "runs", runIds[0]!);
      expect((await readManifestV2(runDir)).stage).toBe("intake");
      const progressEvents = [];
      for await (const event of readProgressEvents(runDir)) progressEvents.push(event);
      expect(progressEvents).toHaveLength(2);
      expect(progressEvents[0]!.event_key).toContain("worker_started");
      expect(progressEvents[1]!.event_key).toContain("role_failed");
      const sessionState = JSON.parse(await readFile(join(runDir, "session-state.json"), "utf8")) as {
        command_counts: { command: number };
        status_counts: { started: number; failed: number };
        source_counts: { runtime: number };
      };
      expect(sessionState.command_counts.command).toBe(2);
      expect(sessionState.status_counts).toMatchObject({ started: 1, failed: 1 });
      expect(sessionState.source_counts.runtime).toBe(2);
      await expect(readFile(join(runDir, "run-configuration.json"), "utf8")).resolves.toContain('"version":2');
      await expect(readFile(join(runDir, "events.jsonl"), "utf8")).resolves.toBe("");
    },
  );

  it("closes a resumable run explicitly and refuses to resume the terminal ledger", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "brain-hands-cli-close-"));
    const ledger = await createLegacyRunLedgerV2({
      repoRoot: tempRoot,
      originalRequest: "Stop the incomplete run",
      intake: { task: "Stop the incomplete run", repo_root: tempRoot, mode: "local", research: false, reflection: false },
    });
    await updateManifestV2(ledger.runDir, {
      stage: "verifier_review",
      delivery_state: "blocked",
      last_blocker: "The test service is unavailable",
    });

    await buildCli().parseAsync([
      "close-run", "--run", ledger.runDir, "--outcome", "blocked", "--reason", "Stop waiting for the test service",
    ], { from: "user" });

    expect((await readManifestV2(ledger.runDir)).terminal).toMatchObject({
      outcome: "closed_blocked",
      actor: "human",
      reason: "Stop waiting for the test service",
    });
    await expect(buildCli().parseAsync(["resume", "--run", ledger.runDir, "--dry-run"], { from: "user" }))
      .rejects.toThrow("terminal outcome closed_blocked");
  });

  it("retries interrupted post-disposition reflection without replacing the first closure", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "brain-hands-cli-close-reflection-"));
    const ledger = await createLegacyRunLedgerV2({
      repoRoot: tempRoot,
      originalRequest: "Reflect after closing the run",
      mode: "local",
      intake: { task: "Reflect after closing the run", repo_root: tempRoot, mode: "local", research: false, reflection: true },
    });
    await sessionStore.initializeSessionArtifacts({
      runDir: ledger.runDir,
      runId: ledger.runId,
      createdAt: ledger.manifest.created_at,
    });
    await updateManifestV2(ledger.runDir, { stage: "verifier_review", delivery_state: "blocked", last_blocker: "Operator review required" });
    const sentinel = new Error("reflection interrupted");
    const reflection = vi.spyOn(reflectionWorkflow, "runReflection").mockRejectedValueOnce(sentinel);

    await expect(buildCli().parseAsync([
      "close-run", "--run", ledger.runDir, "--outcome", "blocked", "--reason", "Stop after the interruption", "--dry-run",
    ], { from: "user" })).rejects.toBe(sentinel);
    expect((await readManifestV2(ledger.runDir)).terminal).toMatchObject({ outcome: "closed_blocked", reason: "Stop after the interruption" });
    expect(await readFile(join(ledger.runDir, "session-events.jsonl"), "utf8")).toBe("");

    reflection.mockRestore();
    await buildCli().parseAsync([
      "close-run", "--run", ledger.runDir, "--outcome", "blocked", "--reason", "A retry keeps the first closure", "--dry-run",
    ], { from: "user" });
    const terminal = (await readManifestV2(ledger.runDir)).terminal;
    expect(terminal).toMatchObject({ outcome: "closed_blocked", reason: "Stop after the interruption" });
    expect(await readFile(join(ledger.runDir, "reflection.json"), "utf8")).toContain("outcome_summary");
    expect(parseCanonicalSessionEvent(await readFile(join(ledger.runDir, "session-events.jsonl"), "utf8"))).toMatchObject({
      terminal_outcome: "closed_blocked",
      assurance_outcome: "blocked",
    });
  });

  it("reconciles and reflects human acceptance before retrying canonical finalization", async () => {
    const ledger = await approvedCliRun("github", "BH-human-accepted", true);
    await attachReadyCliLineage(ledger, "BH-human-accepted");
    await withTaskLineageTransaction({ repoRoot: tempRoot!, lineageId: (await readManifestV2(ledger.runDir)).task_lineage_id!, operation: (transaction) =>
      transaction.update({ ...transaction.read(), state: "delivery_ready" }) });
    await updateManifestV2(ledger.runDir, { stage: "delivery", delivery_state: "ready" });
    const order: string[] = [];
    const reconcile = vi.spyOn(githubReconciliation, "reconcileGitHubIssues").mockImplementation(async () => {
      expect(await readFile(join(ledger.runDir, "session-events.jsonl"), "utf8")).toBe("");
      order.push("reconcile");
      return {} as never;
    });
    const sentinel = new Error("human acceptance reflection interrupted");
    const reflection = vi.spyOn(reflectionWorkflow, "runReflection")
      .mockRejectedValueOnce(sentinel)
      .mockImplementation(async () => {
        expect(await readFile(join(ledger.runDir, "session-events.jsonl"), "utf8")).toBe("");
        order.push("reflect");
        return {} as never;
      });

    await expect(buildCli().parseAsync([
      "close-run", "--run", ledger.runDir, "--outcome", "human-accepted", "--reason", "Accept the known risk", "--dry-run",
    ], { from: "user" })).rejects.toBe(sentinel);
    expect((await readManifestV2(ledger.runDir)).terminal).toMatchObject({ outcome: "human_accepted", reason: "Accept the known risk" });
    expect(await readFile(join(ledger.runDir, "session-events.jsonl"), "utf8")).toBe("");

    await buildCli().parseAsync([
      "close-run", "--run", ledger.runDir, "--outcome", "human-accepted", "--reason", "A different retry reason", "--dry-run",
    ], { from: "user" });
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(order).toEqual(["reconcile", "reconcile", "reflect"]);
    expect((await readManifestV2(ledger.runDir)).terminal).toMatchObject({ outcome: "human_accepted", reason: "Accept the known risk" });
    expect(parseCanonicalSessionEvent(await readFile(join(ledger.runDir, "session-events.jsonl"), "utf8"))).toMatchObject({
      terminal_outcome: "human_accepted",
      assurance_outcome: "human_accepted",
    });
  });

  it("records resume human intervention as blocked without terminalizing the run", async () => {
    const ledger = await approvedCliRun("local", "BH-resume-blocked");
    await rewriteLegacyCheckoutSnapshot(ledger.runDir, { source_commit: null, worktree_path: process.cwd(), branch_name: "test-resume-blocked" });
    await updateManifestV2(ledger.runDir, { stage: "worktree_setup" });
    const persistedManifest = await readManifestV2(ledger.runDir);
    const workflowResult = {
      status: "human_action_required",
      manifest: persistedManifest,
      orderedWorkItems: [],
      implementationResults: {},
      verification: {},
      reviews: {},
      blocker: "Human action is required",
    } as never;
    vi.spyOn(runtimeWorkflow, "runWorkflow").mockResolvedValue(workflowResult);

    await buildCli().parseAsync(["resume", "--run", ledger.runDir, "--dry-run", "--json"], { from: "user" });

    const progress = [];
    for await (const event of readProgressEvents(ledger.runDir)) progress.push(event);
    expect(progress).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "failed", event_key: expect.stringContaining("worker_blocked") }),
    ]));
    expect((await readManifestV2(ledger.runDir)).terminal).toBeNull();
  });

  it("passes the frozen non-origin GitHub remote into the authoritative runtime flow", async () => {
    const ledger = await approvedCliRun("github", "BH-frozen-remote");
    await updateManifestV2(ledger.runDir, { stage: "worktree_setup", worktree_path: process.cwd(), branch_name: "test-frozen-remote" });
    const configPath = await configModule.initConfig(tempRoot!);
    await writeFile(
      configPath,
      (await readFile(configPath, "utf8")).replace("default_remote: origin", "default_remote: upstream"),
      "utf8",
    );
    const manifest = await readManifestV2(ledger.runDir);
    const workflow = vi.spyOn(runtimeWorkflow, "runWorkflow").mockResolvedValue({
      status: "human_action_required", manifest, orderedWorkItems: [], implementationResults: {}, verification: {}, reviews: {}, blocker: "stop after input capture",
    });

    await buildCli().parseAsync(["resume", "--run", ledger.runDir, "--dry-run", "--json"], { from: "user" });

    expect(workflow).toHaveBeenCalledOnce();
    expect(workflow.mock.calls[0]?.[0]).toMatchObject({ remote: "upstream" });
  });

  it("retains final-delivery assurance in JSON status for a human-action result", async () => {
    const ledger = await approvedCliRun("github", "BH-final-assurance");
    await rewriteLegacyCheckoutSnapshot(ledger.runDir, { source_commit: null, worktree_path: process.cwd(), branch_name: "test-final-assurance" });
    await updateManifestV2(ledger.runDir, {
      stage: "delivery",
      delivery_state: "blocked",
      last_blocker: "Final delivery evidence is incomplete",
    });
    const persistedManifest = await readManifestV2(ledger.runDir);
    vi.spyOn(runtimeWorkflow, "runWorkflow").mockResolvedValue({
      status: "human_action_required",
      manifest: persistedManifest,
      orderedWorkItems: [],
      implementationResults: {},
      verification: {},
      reviews: {},
      blocker: persistedManifest.last_blocker!,
    } as never);
    const assessment = {
      outcome: "blocked" as const,
      assessed_at: "2026-07-17T00:00:00.000Z",
      approved_plan_revision: 1,
      approved_plan_sha256: persistedManifest.plan_revisions["1"]!.sha256,
      candidate_commit: null,
      blocker_code: "unknown_candidate_commit",
      blocker: "The final candidate commit cannot be resolved.",
      missing_evidence: [],
      invalid_evidence: [],
      zero_attempt_work_items: [],
      acceptance_path: null,
    };
    const assure = vi.spyOn(assuranceWorkflow, "assessFinalDelivery").mockResolvedValue(assessment);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await buildCli().parseAsync(["resume", "--run", ledger.runDir, "--dry-run", "--json"], { from: "user" });

    expect(assure).toHaveBeenCalled();
    const status = log.mock.calls
      .map(([value]) => {
        if (typeof value !== "string") return null;
        try { return JSON.parse(value) as Record<string, unknown>; } catch { return null; }
      })
      .find((value) => value?.["workflow_result"] === "human_action_required");
    expect(status).toMatchObject({
      blocker: assessment.blocker,
      assurance_outcome: "blocked",
      assurance_assessment: assessment,
    });
  });

  it("reconciles delivery before enabled reflection and preserves the delivered disposition on retry", async () => {
    const ledger = await approvedCliRun("github", "BH-delivery-retry", true);
    await attachReadyCliLineage(ledger, "BH-delivery-retry");
    await rewriteLegacyCheckoutSnapshot(ledger.runDir, { source_commit: null, worktree_path: process.cwd(), branch_name: "test-delivery-retry" });
    await updateManifestV2(ledger.runDir, {
      stage: "delivery", delivery_state: "ready",
    });
    const readyManifest = await readManifestV2(ledger.runDir);
    await recordTerminalDispositionWithCleanup({
      runDir: ledger.runDir,
      disposition: { outcome: "delivered", actor: "runtime", reason: "Delivery is ready", residual_risks: [] },
      lineage: await readTaskLineage(tempRoot!, readyManifest.task_lineage_id!),
    });
    const persistedManifest = await readManifestV2(ledger.runDir);
    const deliveredProvenance = {
      terminal: persistedManifest.terminal,
      github_ids: persistedManifest.github_ids,
      pull_request_numbers: persistedManifest.pull_request_numbers,
    };
    const workflow = vi.spyOn(runtimeWorkflow, "runWorkflow").mockRejectedValue(new Error("ordinary workflow must not re-enter"));
    const localWorkflow = vi.spyOn(runtimeWorkflow, "runLocalWorkflow").mockRejectedValue(new Error("local workflow must not re-enter"));
    const githubWorkflow = vi.spyOn(runtimeWorkflow, "runGithubWorkflow").mockRejectedValue(new Error("GitHub workflow must not re-enter"));
    const githubStatus = vi.spyOn(runtimeWorkflow, "publishGithubWorkflowStatus").mockRejectedValue(new Error("GitHub status projection must not run"));
    const hands = vi.spyOn(handsWorker, "runHandsWorkItem").mockRejectedValue(new Error("Hands must not run"));
    const verifier = vi.spyOn(verifierWorkflow, "verifyWorkItem").mockRejectedValue(new Error("Verifier must not run"));
    const order: string[] = [];
    const finalizeSession = sessionStore.finalizeSession;
    const finalize = vi.spyOn(sessionStore, "finalizeSession").mockImplementation(async (runDir) => {
      order.push("finalize");
      return finalizeSession(runDir);
    });
    const persistFinalDeliveryAssessment = assuranceWorkflow.persistFinalDeliveryAssessment;
    const assurance = vi.spyOn(assuranceWorkflow, "persistFinalDeliveryAssessment").mockImplementation(async (runDir) => {
      order.push("assure");
      const manifest = await readManifestV2(runDir);
      await writeFile(join(runDir, "manifest.json"), `${JSON.stringify({ ...manifest, assurance_outcome: "verified_ready" }, null, 2)}\n`, "utf8");
      expect((await readManifestV2(runDir)).assurance_outcome).toBe("verified_ready");
      return { outcome: "verified_ready" } as Awaited<ReturnType<typeof persistFinalDeliveryAssessment>>;
    });
    const reconcile = vi.spyOn(githubReconciliation, "reconcileGitHubIssues").mockImplementation(async () => {
      expect(await readFile(join(ledger.runDir, "session-events.jsonl"), "utf8")).toBe("");
      order.push("reconcile");
      return {} as never;
    });
    const sentinel = new Error("delivery reflection interrupted");
    const reflection = vi.spyOn(reflectionWorkflow, "runReflection")
      .mockRejectedValueOnce(sentinel)
      .mockImplementation(async () => {
        expect(await readFile(join(ledger.runDir, "session-events.jsonl"), "utf8")).toBe("");
        order.push("reflect");
        return {} as never;
      });

    await expect(buildCli().parseAsync([
      "resume", "--run", ledger.runDir, "--dry-run", "--json",
    ], { from: "user" })).rejects.toBe(sentinel);
    expect((await readManifestV2(ledger.runDir)).terminal).toMatchObject({ outcome: "delivered", reason: "Delivery is ready" });
    expect(await readFile(join(ledger.runDir, "session-events.jsonl"), "utf8")).toBe("");

    await buildCli().parseAsync(["resume", "--run", ledger.runDir, "--dry-run", "--json"], { from: "user" });
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(workflow).not.toHaveBeenCalled();
    expect(localWorkflow).not.toHaveBeenCalled();
    expect(githubWorkflow).not.toHaveBeenCalled();
    expect(githubStatus).not.toHaveBeenCalled();
    expect(hands).not.toHaveBeenCalled();
    expect(verifier).not.toHaveBeenCalled();
    expect(assurance).toHaveBeenCalledTimes(1);
    expect(finalize).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["reconcile", "assure", "reconcile", "reflect", "finalize"]);
    const finalManifest = await readManifestV2(ledger.runDir);
    expect({
      terminal: finalManifest.terminal,
      github_ids: finalManifest.github_ids,
      pull_request_numbers: finalManifest.pull_request_numbers,
    }).toEqual(deliveredProvenance);
    const finalEventRaw = await readFile(join(ledger.runDir, "session-events.jsonl"), "utf8");
    expect(finalEventRaw.trimEnd().split("\n")).toHaveLength(1);
    expect(parseCanonicalSessionEvent(finalEventRaw)).toMatchObject({
      terminal_outcome: "delivered",
      assurance_outcome: "verified_ready",
    });
  });

  it("reuses the first abandonment artifact when terminal disposition is retried with different arguments", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "brain-hands-cli-abandon-retry-"));
    const ledger = await createRunLedgerV2({
      repoRoot: tempRoot,
      originalRequest: "Preserve abandonment provenance",
      intake: { task: "Preserve abandonment provenance", repo_root: tempRoot, mode: "local", research: false, reflection: false },
    });
    await updateManifestV2(ledger.runDir, { stage: "verifier_review", delivery_state: "blocked", last_blocker: "Operator decision required" });
    await abandonRun(ledger.runDir, "first-actor", "first reason");

    await buildCli().parseAsync([
      "abandon", "--run", ledger.runDir, "--actor", "second-actor", "--reason", "second reason",
    ], { from: "user" });

    const manifest = await readManifestV2(ledger.runDir);
    expect(manifest.abandonment_path).not.toBeNull();
    expect(JSON.parse(await readFile(join(ledger.runDir, manifest.abandonment_path!), "utf8"))).toMatchObject({
      actor: "first-actor",
      reason: "first reason",
    });
    expect(manifest.terminal).toMatchObject({ outcome: "abandoned", reason: "first reason" });
  });

  it("reconciles and reflects abandonment before retrying canonical finalization", async () => {
    const ledger = await approvedCliRun("github", "BH-abandon-retry", true);
    await attachReadyCliLineage(ledger, "BH-abandon-retry");
    await configModule.initConfig(tempRoot!);
    const order: string[] = [];
    const reconcile = vi.spyOn(githubReconciliation, "reconcileGitHubIssues").mockImplementation(async () => {
      expect(await readFile(join(ledger.runDir, "session-events.jsonl"), "utf8")).toBe("");
      order.push("reconcile");
      return {} as never;
    });
    const sentinel = new Error("abandonment reflection interrupted");
    const reflection = vi.spyOn(reflectionWorkflow, "runReflection")
      .mockRejectedValueOnce(sentinel)
      .mockImplementation(async () => {
        expect(await readFile(join(ledger.runDir, "session-events.jsonl"), "utf8")).toBe("");
        order.push("reflect");
        return {} as never;
      });

    await expect(buildCli().parseAsync([
      "abandon", "--run", ledger.runDir, "--actor", "first-actor", "--reason", "first reason",
    ], { from: "user" })).rejects.toBe(sentinel);
    expect((await readManifestV2(ledger.runDir)).terminal).toMatchObject({ outcome: "abandoned", reason: "first reason" });
    expect(await readFile(join(ledger.runDir, "session-events.jsonl"), "utf8")).toBe("");

    await buildCli().parseAsync([
      "abandon", "--run", ledger.runDir, "--actor", "second-actor", "--reason", "second reason",
    ], { from: "user" });
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(order).toEqual(["reconcile", "reconcile", "reflect"]);
    const manifest = await readManifestV2(ledger.runDir);
    expect(JSON.parse(await readFile(join(ledger.runDir, manifest.abandonment_path!), "utf8"))).toMatchObject({
      actor: "first-actor", reason: "first reason",
    });
    expect(parseCanonicalSessionEvent(await readFile(join(ledger.runDir, "session-events.jsonl"), "utf8"))).toMatchObject({
      terminal_outcome: "abandoned",
      assurance_outcome: "abandoned",
    });
  });

  it("rejects a whitespace-only terminal reason", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "brain-hands-cli-close-reason-"));
    const ledger = await createRunLedgerV2({
      repoRoot: tempRoot,
      originalRequest: "Do not accept blank closure reasons",
      intake: { task: "Do not accept blank closure reasons", repo_root: tempRoot, mode: "local", research: false, reflection: false },
    });

    await expect(buildCli().parseAsync([
      "close-run", "--run", ledger.runDir, "--outcome", "abandoned", "--reason", "   ",
    ], { from: "user" })).rejects.toThrow();
    expect((await readManifestV2(ledger.runDir)).terminal).toBeNull();
  });

  it("directs an uninitialized repository to local initialization before a real run", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "brain-hands-cli-"));

    await expect(
      buildCli().parseAsync([
        "run", "Ship the feature", "--repo", tempRoot, "--mode", "local", "--no-research", "--no-reflection",
      ], { from: "user" }),
    ).rejects.toThrow(`Run: brain-hands init --repo ${tempRoot}`);
  });

  it("rejects --json with --follow before creating a run", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "brain-hands-cli-follow-"));
    await expect(buildCli().parseAsync([
      "run", "Ship", "--repo", tempRoot, "--mode", "local", "--no-research", "--no-reflection", "--dry-run", "--json", "--follow",
    ], { from: "user" })).rejects.toThrow("--json and --follow cannot be used together");
    await expect(access(join(tempRoot, ".brain-hands"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("creates a v2 ledger and stops at the first discovery boundary", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "brain-hands-cli-"));
    const progressOutput = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(preflight, "runPreflight").mockResolvedValue({
      checks: [],
      required_checks_failed: false,
      github_auth: { status: "skipped", reason: null, stderr: "" },
      github_auth_status: "skipped",
      supports_search: false,
      github_repository: null,
      missing_github_labels: [],
      drifted_github_labels: [],
    });

    await buildCli().parseAsync([
      "run",
      "Ship the feature",
      "--repo",
      tempRoot,
      "--mode",
      "local",
      "--no-research",
      "--no-reflection",
      "--dry-run",
      "--follow",
    ], { from: "user" });

    const runRoot = join(tempRoot, ".brain-hands", "runs");
    const [runId] = await (await import("node:fs/promises")).readdir(runRoot);
    const manifest = await readManifestV2(join(runRoot, runId));
    expect(manifest.version).toBe(2);
    expect(manifest.stage).toBe("awaiting_discovery_answer");
    expect(manifest.current_revision).toBeNull();
    expect(manifest.approved_revision).toBeNull();
    expect(JSON.parse(await readFile(join(runRoot, runId, "discovery/pending-action.json"), "utf8")))
      .toMatchObject({
        state: "awaiting_discovery_answer",
        question: { id: "q-001" },
        permitted_next_actions: ["answer-discovery", "proceed-discovery"],
      });
    expect(progressOutput.mock.calls.flat().join("\n")).not.toContain("ready for approval");
  });

  it("prints the resolved run configuration before starting Brain discovery", async () => {
    const packageJson = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8")) as { version: string };
    tempRoot = await mkdtemp(join(tmpdir(), "brain-hands-cli-run-configuration-"));
    const preflightCall = vi.spyOn(preflight, "runPreflight").mockResolvedValue({
      checks: [],
      required_checks_failed: false,
      github_auth: { status: "skipped", reason: null, stderr: "" },
      github_auth_status: "skipped",
      supports_search: true,
      github_repository: null,
      missing_github_labels: [],
      drifted_github_labels: [],
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await buildCli().parseAsync([
      "run",
      "Show the effective configuration",
      "--repo",
      tempRoot,
      "--mode",
      "local",
      "--research",
      "--no-reflection",
      "--brain-model",
      "brain-override",
      "--dry-run",
    ], { from: "user" });

    const startup = String(log.mock.calls[0]?.[0]);
    expect(startup).toContain("Brain Hands run configuration (preflight pending)");
    expect(startup).toContain(`Repository: ${tempRoot}`);
    expect(startup).toContain("Mode: local");
    expect(startup).toContain("Research: enabled");
    expect(startup).toContain("Reflection: disabled");
    expect(startup).toMatch(new RegExp(`Controller: @ngelik/brain-hands ${packageJson.version} \\((?:installed|development checkout)\\)`));
    expect(startup).toContain("Brain: brain-override | high reasoning | read-only | CLI override");
    expect(startup).toContain("Hands: gpt-5.6-luna | high reasoning | workspace-write | repository config");
    expect(startup).toContain("Verifier: gpt-5.6-sol | high reasoning | read-only | repository config");
    expect(startup).toContain("Hands backup: disabled");
    expect(startup).toContain("Hands fix attempts: 3");
    expect(startup).toContain("Replan attempts: 2");
    expect(startup).toContain("Review limit: 2 fix cycles; auto replan");
    expect(startup).toContain("Quality gate: 1 Hands self-review passes; 2 reviewer-action attempts; focused Verifier confirmation required");
    expect(startup).toContain("Nested subagents: disabled (controller enforced)");
    expect(startup).toContain("Hands self-review reasoning: medium");
    expect(startup).toContain("Reflection reasoning: medium");
    expect(startup).toContain("Reflection protocol: single pass");
    const preflightProfiles = preflightCall.mock.calls[0]?.[0].config.profiles as unknown as Record<string, { model: string }>;
    expect(preflightProfiles.brain?.model).toBe("brain-override");
    expect(startup).toContain("GitHub effects: none");
    expect(startup).not.toContain("executable_path");
    expect(startup).not.toContain("package_hash");

    const output = log.mock.calls.flat().join("\n");
    expect(output.indexOf("Brain Hands run configuration")).toBeLessThan(output.indexOf("Preflight passed; starting Brain discovery."));
    expect(output.indexOf("Preflight passed; starting Brain discovery.")).toBeLessThan(output.indexOf("Pending discovery action:"));
  });

  it("creates one fully bootstrapped run before exactly one discovery turn", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "brain-hands-cli-run-bootstrap-characterization-"));
    const ledgerCall = vi.spyOn(ledgerModule, "createRunLedgerV2");
    vi.spyOn(preflight, "runPreflight").mockResolvedValue({
      checks: [],
      required_checks_failed: false,
      github_auth: { status: "skipped", reason: null, stderr: "" },
      github_auth_status: "skipped",
      supports_search: true,
      github_repository: null,
      missing_github_labels: [],
      drifted_github_labels: [],
    });
    const originalDiscoveryTurn = discoveryModule.runDiscoveryTurn;
    const discoveryCall = vi.spyOn(discoveryModule, "runDiscoveryTurn")
      .mockImplementation(async (input) => {
        expect((await readManifestV2(input.runDir)).stage).toBe("brain_discovery");
        return originalDiscoveryTurn(input);
      });
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await buildCli().parseAsync([
      "run", "Characterize bootstrap", "--repo", tempRoot, "--mode", "local",
      "--no-research", "--no-reflection", "--dry-run",
    ], { from: "user" });

    expect(ledgerCall).toHaveBeenCalledTimes(1);
    expect(discoveryCall).toHaveBeenCalledTimes(1);
    const runRoot = join(tempRoot, ".brain-hands", "runs");
    const runIds = await readdir(runRoot);
    expect(runIds).toHaveLength(1);
    const runDir = join(runRoot, runIds[0]!);
    await expect(readFile(join(runDir, "run-configuration.json"), "utf8")).resolves.toContain('"version":2');
    await expect(readFile(join(runDir, "preflight.json"), "utf8")).resolves.toContain('"required_checks_failed": false');
    const events = (await readFile(join(runDir, "events.jsonl"), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line) as { type: string });
    expect(events.filter((event) => event.type === "controller_attested")).toHaveLength(1);
    expect(events.filter((event) => event.type === "preflight_completed")).toHaveLength(1);
  });

  it("returns one safe resolved run configuration from run and status JSON", async () => {
    const packageJson = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8")) as { version: string };
    tempRoot = await mkdtemp(join(tmpdir(), "brain-hands-cli-run-configuration-json-"));
    vi.spyOn(preflight, "runPreflight").mockResolvedValue({
      checks: [],
      required_checks_failed: false,
      github_auth: { status: "skipped", reason: null, stderr: "" },
      github_auth_status: "skipped",
      supports_search: false,
      github_repository: null,
      missing_github_labels: [],
      drifted_github_labels: [],
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await buildCli().parseAsync([
      "run",
      "Expose the resolved configuration as JSON",
      "--repo",
      tempRoot,
      "--mode",
      "github",
      "--no-research",
      "--reflection",
      "--hands-model",
      "hands-override",
      "--dry-run",
      "--json",
    ], { from: "user" });

    expect(log).toHaveBeenCalledTimes(1);
    const runOutput = JSON.parse(String(log.mock.calls[0]?.[0])) as {
      run_dir: string;
      run_configuration?: Record<string, unknown>;
    };
    expect(runOutput.run_configuration).toMatchObject({
      version: 2,
      repository: tempRoot,
      mode: "github",
      research: false,
      reflection: true,
      controller: {
        package_name: "@ngelik/brain-hands",
        package_version: packageJson.version,
        mode: expect.stringMatching(/^(?:installed|development_checkout)$/),
      },
      roles: {
        brain: { model: "gpt-5.6-sol", reasoning_effort: "high", sandbox: "read-only", source: "repository_config" },
        hands: { model: "hands-override", reasoning_effort: "high", sandbox: "workspace-write", source: "cli_override" },
        verifier: { model: "gpt-5.6-sol", reasoning_effort: "high", sandbox: "read-only", source: "repository_config" },
      },
      limits: { max_hands_fix_attempts: 3, max_replan_attempts: 2 },
      github: { effects: "issues_and_pull_request", default_remote: "origin" },
      workflow_protocol: "bounded-context-v1",
      phase_reasoning: { hands_self_review: "medium", reflection: "medium" },
      reflection_protocol: "single-pass-v1",
      resource_budget: defaultConfig().resource_budget,
    });
    expect(JSON.stringify(runOutput.run_configuration)).not.toMatch(/executable_path|package_root|package_hash|candidate_commit/);
    const persistedConfiguration = resolvedRunConfigurationSchema.parse(runOutput.run_configuration);
    expect(await readFile(join(runOutput.run_dir, "run-configuration.json"), "utf8"))
      .toBe(serializeRunConfiguration(persistedConfiguration));
    expect((await readManifestV2(runOutput.run_dir)).run_configuration_sha256)
      .toBe(runConfigurationSha256(persistedConfiguration));

    log.mockClear();
    await buildCli().parseAsync(["status", "--run", runOutput.run_dir, "--json"], { from: "user" });
    expect(log).toHaveBeenCalledTimes(1);
    const statusOutput = JSON.parse(String(log.mock.calls[0]?.[0])) as { run_configuration?: Record<string, unknown> };
    expect(statusOutput.run_configuration).toEqual(runOutput.run_configuration);
  });

  it("keeps discovery mutations explicit, rejects invalid input before persistence, and plans only after brief approval", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "brain-hands-cli-discovery-"));
    vi.spyOn(preflight, "runPreflight").mockResolvedValue({
      checks: [],
      required_checks_failed: false,
      github_auth: { status: "skipped", reason: null, stderr: "" },
      github_auth_status: "skipped",
      supports_search: false,
      github_repository: null,
      missing_github_labels: [],
      drifted_github_labels: [],
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await buildCli().parseAsync([
      "run", "Discover the durable CLI", "--repo", tempRoot, "--mode", "local",
      "--no-research", "--no-reflection", "--dry-run", "--json",
    ], { from: "user" });
    const [runId] = await (await import("node:fs/promises")).readdir(join(tempRoot, ".brain-hands", "runs"));
    const runDir = join(tempRoot, ".brain-hands", "runs", runId);
    const answerPath = join(tempRoot, "answer.txt");
    const pendingPath = join(runDir, "discovery/pending-action.json");
    expect(log.mock.calls.at(-1)?.[0]).toContain('"pending_action"');

    const pendingBeforeResume = await readFile(pendingPath, "utf8");
    const responsesBeforeResume = await (await import("node:fs/promises")).readdir(join(runDir, "responses"));
    await buildCli().parseAsync(["resume", "--run", runDir, "--dry-run", "--json"], { from: "user" });
    expect(await readFile(pendingPath, "utf8")).toBe(pendingBeforeResume);
    expect(await (await import("node:fs/promises")).readdir(join(runDir, "responses"))).toEqual(responsesBeforeResume);
    expect(log.mock.calls.at(-1)?.[0]).toContain('"pending_action"');

    await writeFile(answerPath, "   \n", "utf8");
    await expect(buildCli().parseAsync([
      "answer-discovery", "--run", runDir, "--question", "q-001", "--input-file", answerPath, "--dry-run",
    ], { from: "user" })).rejects.toThrow("Operator input must be non-empty");
    await expect(access(join(runDir, "discovery/answers/001.json"))).rejects.toMatchObject({ code: "ENOENT" });

    await writeFile(answerPath, "api_key=sk-proj-abcdefghijklmnopqrstuvwxyz", "utf8");
    await expect(buildCli().parseAsync([
      "answer-discovery", "--run", runDir, "--question", "q-001", "--input-file", answerPath, "--dry-run",
    ], { from: "user" })).rejects.toThrow("contains secret material");
    await expect(access(join(runDir, "discovery/answers/001.json"))).rejects.toMatchObject({ code: "ENOENT" });

    await writeFile(answerPath, "Use an explicit discovery boundary", "utf8");
    await expect(buildCli().parseAsync([
      "answer-discovery", "--run", runDir, "--question", "q-999", "--input-file", answerPath, "--dry-run",
    ], { from: "user" })).rejects.toThrow("q-999 is stale");
    await buildCli().parseAsync([
      "answer-discovery", "--run", runDir, "--question", "q-001", "--input-file", answerPath, "--dry-run", "--json",
    ], { from: "user" });
    expect((await readManifestV2(runDir)).stage).toBe("awaiting_discovery_approach");

    await expect(buildCli().parseAsync([
      "select-discovery-approach", "--run", runDir, "--revision", "2", "--approach", "approach-explicit", "--dry-run",
    ], { from: "user" })).rejects.toThrow("revision 2 is stale");
    await buildCli().parseAsync([
      "select-discovery-approach", "--run", runDir, "--revision", "1", "--approach", "approach-explicit", "--dry-run", "--json",
    ], { from: "user" });
    expect((await readManifestV2(runDir)).stage).toBe("awaiting_discovery_brief_approval");
    await expect(access(join(runDir, "plans/revision-1.md"))).rejects.toMatchObject({ code: "ENOENT" });

    const revisionPath = join(tempRoot, "revision.txt");
    await writeFile(revisionPath, "Clarify that every crossing requires an explicit command", "utf8");
    await expect(buildCli().parseAsync([
      "revise-discovery", "--run", runDir, "--revision", "2", "--input-file", revisionPath, "--dry-run",
    ], { from: "user" })).rejects.toThrow("revision 2 is stale");
    await buildCli().parseAsync([
      "revise-discovery", "--run", runDir, "--revision", "1", "--input-file", revisionPath, "--dry-run", "--json",
    ], { from: "user" });
    expect((await readManifestV2(runDir)).discovery?.current_brief_revision).toBe(2);

    await expect(buildCli().parseAsync([
      "approve-discovery", "--run", runDir, "--revision", "1", "--dry-run",
    ], { from: "user" })).rejects.toThrow("revision 1 is stale");
    await buildCli().parseAsync([
      "approve-discovery", "--run", runDir, "--revision", "2", "--dry-run", "--json",
    ], { from: "user" });
    expect(await readManifestV2(runDir)).toMatchObject({
      stage: "awaiting_plan_approval",
      current_revision: 1,
      approved_revision: null,
      discovery: { approved_brief_revision: 2 },
    });
    const discoveryProgress = [];
    for await (const event of readProgressEvents(runDir)) {
      if (event.event_key.includes("discovery_")) discoveryProgress.push(event);
    }
    expect(discoveryProgress.map((event) => event.event_key)).toEqual([
      "brain:discovery_started",
      "brain:discovery_question_ready:cycle:1:question:1",
      "brain:discovery_brief_ready:revision:1",
      "brain:discovery_brief_ready:revision:2",
      "brain:discovery_brief_approved:revision:2",
    ]);
    expect(JSON.stringify(discoveryProgress)).not.toContain("Use an explicit discovery boundary");
  });

  it("resumes failed active discovery and planning controllers without overwriting Brain evidence", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "brain-hands-cli-brain-resume-"));
    vi.spyOn(preflight, "runPreflight").mockResolvedValue({
      checks: [], required_checks_failed: false,
      github_auth: { status: "skipped", reason: null, stderr: "" }, github_auth_status: "skipped",
      supports_search: false, github_repository: null, missing_github_labels: [], drifted_github_labels: [],
    });
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await buildCli().parseAsync([
      "run", "Resume active Brain stages", "--repo", tempRoot, "--mode", "local",
      "--no-research", "--no-reflection", "--dry-run", "--json",
    ], { from: "user" });
    const [runId] = await readdir(join(tempRoot, ".brain-hands", "runs"));
    const runDir = join(tempRoot, ".brain-hands", "runs", runId);

    await recordDiscoveryAnswer(runDir, "q-001", "Use the explicit boundary");
    await recordBrainFailure({
      runDir, phase: "discovery", cycle: 1, turn: 2, attempt: 2,
      error: new Error("PRIVATE-DISCOVERY-FAILURE"), evidence_refs: [],
    });
    await recordBrainFailure({
      runDir, phase: "discovery", cycle: 1, turn: 2, attempt: 2,
      error: new Error("PRIVATE-DISCOVERY-FAILURE-RETRY"), evidence_refs: [],
    });
    expect((await readdir(join(runDir, "failures"))).filter((name) => name.startsWith("brain-discovery-"))).toHaveLength(2);
    await buildCli().parseAsync(["resume", "--run", runDir, "--dry-run", "--json"], { from: "user" });
    expect((await readManifestV2(runDir)).stage).toBe("awaiting_discovery_approach");
    expect((await readdir(join(runDir, "responses"))).some((name) => name.includes("resume-3"))).toBe(true);

    await buildCli().parseAsync([
      "select-discovery-approach", "--run", runDir, "--revision", "1", "--approach", "approach-explicit", "--dry-run", "--json",
    ], { from: "user" });
    await approveDiscoveryBrief(runDir, 1);
    await recordBrainFailure({
      runDir, phase: "planning", cycle: null, turn: null, attempt: 1,
      error: new Error("PRIVATE-PLANNING-FAILURE"), evidence_refs: [],
    });
    await buildCli().parseAsync(["resume", "--run", runDir, "--dry-run", "--json"], { from: "user" });
    expect(await readManifestV2(runDir)).toMatchObject({
      stage: "awaiting_plan_approval", delivery_state: "pending", last_blocker: null,
    });
    expect((await readdir(join(runDir, "responses"))).some((name) => name.startsWith("brain-plan-v2-resume-2"))).toBe(true);
    const failureText = (await Promise.all((await readdir(join(runDir, "failures"))).map((name) =>
      readFile(join(runDir, "failures", name), "utf8")))).join("\n");
    expect(failureText).not.toContain("PRIVATE-");
  });

  it("proceeds from the current question with explicit documented assumptions", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "brain-hands-cli-proceed-discovery-"));
    vi.spyOn(preflight, "runPreflight").mockResolvedValue({
      checks: [], required_checks_failed: false,
      github_auth: { status: "skipped", reason: null, stderr: "" }, github_auth_status: "skipped",
      supports_search: false, github_repository: null, missing_github_labels: [], drifted_github_labels: [],
    });
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await buildCli().parseAsync([
      "run", "Proceed with assumptions", "--repo", tempRoot, "--mode", "local",
      "--no-research", "--no-reflection", "--dry-run", "--json",
    ], { from: "user" });
    const [runId] = await (await import("node:fs/promises")).readdir(join(tempRoot, ".brain-hands", "runs"));
    const runDir = join(tempRoot, ".brain-hands", "runs", runId);
    const assumptionsPath = join(tempRoot, "assumptions.txt");
    await writeFile(assumptionsPath, "Assume the explicit-boundary approach", "utf8");

    await expect(buildCli().parseAsync([
      "proceed-discovery", "--run", runDir, "--question", "q-stale", "--input-file", assumptionsPath, "--dry-run", "--json",
    ], { from: "user" })).rejects.toThrow(/q-stale is stale/i);
    await buildCli().parseAsync([
      "proceed-discovery", "--run", runDir, "--question", "q-001", "--input-file", assumptionsPath, "--dry-run", "--json",
    ], { from: "user" });

    expect(await readManifestV2(runDir)).toMatchObject({
      stage: "awaiting_discovery_brief_approval",
      discovery: {
        answered_questions: 1,
        current_brief_revision: 1,
        proceed_with_assumptions: {
          cycle: 1,
          question_id: "q-001",
          path: "discovery/proceed-with-assumptions.json",
        },
      },
    });
    expect(await readFile(join(runDir, "discovery/answers/001.json"), "utf8"))
      .toContain("Proceed with documented assumptions: Assume the explicit-boundary approach");
  });

  it("rejects plan approval when approved discovery brief bytes change after planning", async () => {
    const { runDir } = await plannedDurableCliRun();
    const approvedBriefPath = join(runDir, "discovery/approved-brief.json");
    const approvedBrief = JSON.parse(await readFile(approvedBriefPath, "utf8")) as Record<string, unknown>;
    await writeFile(approvedBriefPath, `${JSON.stringify({ ...approvedBrief, goal: "Tampered" }, null, 2)}\n`, "utf8");

    await expect(buildCli().parseAsync([
      "approve-plan", runDir, "--revision", "1", "--dry-run", "--json",
    ], { from: "user" })).rejects.toThrow(/discovery brief.*digest/i);

    expect(await readManifestV2(runDir)).toMatchObject({
      stage: "awaiting_plan_approval",
      approved_revision: null,
      worktree_path: null,
    });
  });

  it("rejects plan approval when a hash-valid persisted plan changes its discovery binding", async () => {
    const { runDir } = await plannedDurableCliRun();
    const manifest = await readManifestV2(runDir);
    const record = manifest.plan_revisions["1"]!;
    const plan = JSON.parse(await readFile(join(runDir, record.path), "utf8")) as Record<string, unknown>;
    const changedPlan = { ...plan, discovery_brief_sha256: "0".repeat(64) };
    const planText = `${JSON.stringify(changedPlan, null, 2)}\n`;
    await writeFile(join(runDir, record.path), planText, "utf8");
    await updateManifestV2(runDir, {
      plan_revisions: {
        ...manifest.plan_revisions,
        "1": { ...record, sha256: createHash("sha256").update(planText, "utf8").digest("hex") },
      },
    });

    await expect(buildCli().parseAsync([
      "approve-plan", runDir, "--revision", "1", "--dry-run", "--json",
    ], { from: "user" })).rejects.toThrow(/plan approval request|plan discovery brief SHA-256/i);
    expect((await readManifestV2(runDir)).approved_revision).toBeNull();
  });

  it("rejects resume before execution when approved discovery bytes change after planning", async () => {
    const { runDir } = await plannedDurableCliRun();
    const pending = await readManifestV2(runDir);
    await approvePlanRevision(runDir, 1, {
      actor: "human",
      approvalControllerCapture: async () => ({
        provenance: pending.controller_provenance!,
        selfHosting: pending.controller_provenance!.self_hosting,
      }),
    });
    const approvedBriefPath = join(runDir, "discovery/approved-brief.json");
    const approvedBrief = JSON.parse(await readFile(approvedBriefPath, "utf8")) as Record<string, unknown>;
    await writeFile(approvedBriefPath, `${JSON.stringify({ ...approvedBrief, goal: "Tampered resume" }, null, 2)}\n`, "utf8");

    await expect(buildCli().parseAsync([
      "resume", runDir, "--dry-run", "--json",
    ], { from: "user" })).rejects.toThrow(/discovery brief.*digest/i);
    expect(await readManifestV2(runDir)).toMatchObject({
      stage: "awaiting_plan_approval",
      worktree_path: null,
    });
  });

  it("rejects resume while another invocation owns the active execution lease", async () => {
    const { runDir } = await plannedDurableCliRun("local", false);
    const pending = await readManifestV2(runDir);
    await approvePlanRevision(runDir, 1, {
      actor: "human",
      approvalControllerCapture: async () => ({
        provenance: pending.controller_provenance!,
        selfHosting: pending.controller_provenance!.self_hosting,
      }),
    });
    await updateManifestV2(runDir, { stage: "worktree_setup", delivery_state: "pending" });
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const claim = await acquireExecutionLease(runDir);
    try {
      await expect(buildCli().parseAsync(["resume", runDir, "--dry-run", "--json"], { from: "user" }))
        .rejects.toThrow(/active execution lease.*blocks this invocation|another producing command owns/i);
      expect((await readManifestV2(runDir)).execution_lease).not.toBeNull();
    } finally {
      await releaseExecutionLease(runDir, claim);
    }
    expect((await readManifestV2(runDir)).execution_lease).toBeNull();
  }, 30_000);

  it("stops at initial plan approval without loading the proposed plan", async () => {
    const { runDir } = await plannedDurableCliRun();
    const planLoads = vi.spyOn(verifiedPlanWorkflow, "loadVerifiedPlanBundle");

    await buildCli().parseAsync([
      "resume", runDir, "--dry-run", "--json",
    ], { from: "user" });

    expect(planLoads).not.toHaveBeenCalled();
    expect(await readManifestV2(runDir)).toMatchObject({
      stage: "awaiting_plan_approval",
      approved_revision: null,
      worktree_path: null,
    });
  });

  it("exposes the verified plan request independently in JSON and renders its initial authorization", async () => {
    const { runDir } = await plannedDurableCliRun();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await buildCli().parseAsync(["status", runDir, "--json"], { from: "user" });
    const json = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as Record<string, any>;
    expect(json.pending_action).toBeNull();
    expect(json.plan_approval_request.subject.plan_revision).toBe(1);

    await buildCli().parseAsync(["status", runDir], { from: "user" });
    const rendered = String(log.mock.calls.at(-1)?.[0]);
    expect(rendered).toContain("Approval required: initial plan");
    expect(rendered).toContain("Authorization summary:");
    expect(rendered).toContain("Merge policy: manual only");
    expect(rendered).toContain(`brain-hands approve-plan --run '${runDir}' --revision 1`);
  });

  it("fails status closed and suppresses approval after exact request bytes drift", async () => {
    const { runDir } = await plannedDurableCliRun();
    const requestPath = join(runDir, "approvals/plan/revision-1.json");
    await writeFile(requestPath, `${await readFile(requestPath, "utf8")} `, "utf8");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await buildCli().parseAsync(["status", runDir, "--json"], { from: "user" });

    const status = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as Record<string, any>;
    expect(status.operator_state).toBe("operationally_blocked");
    expect(status.blocker).toMatch(/^Status provenance invalid:/);
    expect(status.plan_approval_request).toBeNull();
    expect(JSON.stringify(status)).not.toContain("approve-plan");
  });

  it("fails status closed observationally when the pending request path escapes the run", async () => {
    const { runDir } = await plannedDurableCliRun();
    const manifestPath = join(runDir, "manifest.json");
    const manifest = await readManifestV2(runDir);
    const corrupted = structuredClone(manifest);
    corrupted.pending_plan_approval!.request_path = "../outside-request.json";
    corrupted.plan_revisions["1"]!.approval_request_path = "../outside-request.json";
    await writeFile(manifestPath, `${JSON.stringify(corrupted, null, 2)}\n`, "utf8");
    const before = await snapshotRunFiles(runDir);
    const expectedBlocker = "Status provenance invalid: Pending plan approval path is not canonical";
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    log.mockClear();

    await buildCli().parseAsync(["status", runDir, "--json"], { from: "user" });

    const status = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as Record<string, unknown>;
    expect(status).toMatchObject({
      operator_state: "operationally_blocked",
      blocker: expectedBlocker,
      plan_approval_request: null,
    });
    expect(JSON.stringify(status)).not.toContain("approve-plan");
    log.mockClear();
    await buildCli().parseAsync(["status", runDir], { from: "user" });
    const rendered = String(log.mock.calls.at(-1)?.[0]);
    expect(rendered).toContain(`Blocker: ${expectedBlocker}`);
    expect(rendered).not.toContain("approve-plan");
    expect(await snapshotRunFiles(runDir)).toEqual(before);
  });

  it("fails status closed observationally when the approval request is an outside symlink", async () => {
    const { runDir } = await plannedDurableCliRun();
    const requestPath = join(runDir, "approvals/plan/revision-1.json");
    const outsidePath = join(tempRoot!, "outside-plan-approval-request.json");
    const requestBytes = await readFile(requestPath, "utf8");
    await writeFile(outsidePath, requestBytes, "utf8");
    await rm(requestPath);
    await symlink(outsidePath, requestPath);
    const before = await snapshotRunFiles(runDir);
    const linkBefore = await lstat(requestPath);
    const linkTargetBefore = await readlink(requestPath);
    const expectedBlocker = "Status provenance invalid: Plan approval request must be a regular non-symlink file";
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    log.mockClear();

    await buildCli().parseAsync(["status", runDir, "--json"], { from: "user" });

    const status = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as Record<string, unknown>;
    expect(status).toMatchObject({
      operator_state: "operationally_blocked",
      blocker: expectedBlocker,
      plan_approval_request: null,
    });
    expect(JSON.stringify(status)).not.toContain("approve-plan");
    log.mockClear();
    await buildCli().parseAsync(["status", runDir], { from: "user" });
    const rendered = String(log.mock.calls.at(-1)?.[0]);
    expect(rendered).toContain(`Blocker: ${expectedBlocker}`);
    expect(rendered).not.toContain("approve-plan");
    expect(await snapshotRunFiles(runDir)).toEqual(before);
    const linkAfter = await lstat(requestPath);
    expect(linkAfter.isSymbolicLink()).toBe(true);
    expect({ dev: linkAfter.dev, ino: linkAfter.ino, mode: linkAfter.mode, size: linkAfter.size })
      .toEqual({ dev: linkBefore.dev, ino: linkBefore.ino, mode: linkBefore.mode, size: linkBefore.size });
    expect(await readlink(requestPath)).toBe(linkTargetBefore);
    expect(await readFile(outsidePath, "utf8")).toBe(requestBytes);
  });

  it.each([
    "plan bytes",
    "noncanonical run configuration bytes",
    "schema-valid run configuration drift",
    "manifest run configuration digest drift",
    "missing run configuration",
  ] as const)("fails status closed and suppresses approval after %s", async (tamper) => {
    const { runDir } = await plannedDurableCliRun();
    const manifest = await readManifestV2(runDir);
    const configurationPath = join(runDir, "run-configuration.json");
    if (tamper === "plan bytes") {
      const planPath = join(runDir, manifest.plan_revisions["1"]!.path);
      await writeFile(planPath, `${await readFile(planPath, "utf8")} `, "utf8");
    } else if (tamper === "noncanonical run configuration bytes") {
      await writeFile(configurationPath, `${await readFile(configurationPath, "utf8")} `, "utf8");
    } else if (tamper === "schema-valid run configuration drift") {
      const configuration = resolvedRunConfigurationSchema.parse(JSON.parse(await readFile(configurationPath, "utf8")));
      await writeFile(configurationPath, serializeRunConfiguration({
        ...configuration,
        reflection: !configuration.reflection,
      }), "utf8");
    } else if (tamper === "manifest run configuration digest drift") {
      await writeFile(join(runDir, "manifest.json"), `${JSON.stringify({
        ...manifest,
        run_configuration_sha256: "f".repeat(64),
      }, null, 2)}\n`, "utf8");
    } else {
      await rm(configurationPath);
    }
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await buildCli().parseAsync(["status", runDir, "--json"], { from: "user" });

    const status = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as Record<string, any>;
    expect(status.operator_state).toBe("operationally_blocked");
    expect(status.blocker).toMatch(/^Status provenance invalid:/);
    expect(status.plan_approval_request).toBeNull();
    expect(JSON.stringify(status)).not.toContain("approve-plan");
  });

  it("keeps status and log reads observational when the claimed-plan boundary event is missing", async () => {
    const { runDir } = await plannedDurableCliRun();
    const eventsPath = join(runDir, "events.jsonl");
    const events = (await readFile(eventsPath, "utf8")).split("\n").filter(Boolean)
      .filter((line) => {
        const event = JSON.parse(line) as { type?: string; stage?: string };
        return !(event.type === "transition" && event.stage === "awaiting_plan_approval");
      });
    await writeFile(eventsPath, `${events.join("\n")}\n`, "utf8");
    const beforeStatus = await snapshotRunFiles(runDir);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await buildCli().parseAsync(["status", runDir, "--json"], { from: "user" });

    expect(await snapshotRunFiles(runDir)).toEqual(beforeStatus);
    const beforeLog = await snapshotRunFiles(runDir);
    await readRunLog(runDir);
    expect(await snapshotRunFiles(runDir)).toEqual(beforeLog);
  });

  it("projects the exact verified configuration when its file changes after verification", async () => {
    const { runDir } = await plannedDurableCliRun();
    const configurationPath = join(runDir, "run-configuration.json");

    const status = await readOperatorStatus(runDir, {
      approvalVerificationHooks: {
        afterRunConfigurationRead: async (configuration) => {
          await writeFile(configurationPath, serializeRunConfiguration({
            ...configuration,
            reflection: !configuration.reflection,
          }), "utf8");
        },
      },
    });

    const changed = resolvedRunConfigurationSchema.parse(JSON.parse(await readFile(configurationPath, "utf8")));
    expect(changed.reflection).toBe(true);
    expect(status.operator_state).toBe("awaiting_plan_approval");
    expect(status.run_configuration?.reflection).toBe(false);
    expect(status.plan_approval_request?.subject.plan_revision).toBe(1);
  });

  it("requires the exact pending request revision before approval", async () => {
    const { runDir } = await plannedDurableCliRun();

    await expect(buildCli().parseAsync([
      "approve-plan", runDir, "--revision", "2", "--dry-run",
    ], { from: "user" })).rejects.toThrow(/pending plan approval revision 1/i);

    expect((await readManifestV2(runDir)).approved_revision).toBeNull();
  });

  it("announces an already-recorded exact approval before continuing", async () => {
    const { runDir } = await plannedDurableCliRun();
    const pending = await readManifestV2(runDir);
    await approvePlanRevision(runDir, 1, {
      actor: "human",
      approvalControllerCapture: async () => ({
        provenance: pending.controller_provenance!,
        selfHosting: pending.controller_provenance!.self_hosting,
      }),
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(buildCli().parseAsync([
      "approve-plan", runDir, "--revision", "1", "--dry-run",
    ], { from: "user" })).rejects.toThrow(/source checkout/i);

    expect(log.mock.calls.some((call) => call[0] === "Exact approval already recorded for this subject; continuing the approved run."))
      .toBe(true);
  });

  it("continues an advanced exact initial approval without replaying approval mutation", async () => {
    const { runDir } = await plannedDurableCliRun();
    const pending = await readManifestV2(runDir);
    await approvePlanRevision(runDir, 1, {
      actor: "human",
      approvalControllerCapture: async () => ({
        provenance: pending.controller_provenance!,
        selfHosting: pending.controller_provenance!.self_hosting,
      }),
    });
    await updateManifestV2(runDir, { stage: "implementing" });
    const approve = vi.spyOn(ledgerModule, "approvePlanRevision");

    await expect(buildCli().parseAsync([
      "approve-plan", runDir, "--revision", "1", "--dry-run",
    ], { from: "user" })).rejects.toThrow(/source checkout/i);

    expect(approve).not.toHaveBeenCalled();
    expect((await readManifestV2(runDir)).stage).toBe("implementing");
  });

  it("uses the latest stage after concurrent advancement of an exact initial approval", async () => {
    const { runDir } = await plannedDurableCliRun();
    const pending = await readManifestV2(runDir);
    await approvePlanRevision(runDir, 1, {
      actor: "human",
      approvalControllerCapture: async () => ({
        provenance: pending.controller_provenance!,
        selfHosting: pending.controller_provenance!.self_hosting,
      }),
    });
    const originalEnsure = ledgerModule.ensureCompletedPlanApprovalEvent;
    vi.spyOn(ledgerModule, "ensureCompletedPlanApprovalEvent").mockImplementationOnce(async (...args) => {
      await updateManifestV2(runDir, { stage: "implementing" });
      return originalEnsure(...args);
    });
    const approve = vi.spyOn(ledgerModule, "approvePlanRevision");

    await expect(buildCli().parseAsync([
      "approve-plan", runDir, "--revision", "1", "--dry-run",
    ], { from: "user" })).rejects.toThrow(/source checkout/i);

    expect(approve).not.toHaveBeenCalled();
    expect((await readManifestV2(runDir)).stage).toBe("implementing");
  });

  it("repairs a missing initial approval event only at the immediate promoted boundary", async () => {
    const { runDir } = await plannedDurableCliRun();
    const pending = await readManifestV2(runDir);
    await approvePlanRevision(runDir, 1, {
      actor: "human",
      approvalControllerCapture: async () => ({
        provenance: pending.controller_provenance!,
        selfHosting: pending.controller_provenance!.self_hosting,
      }),
    });
    const eventsPath = join(runDir, "events.jsonl");
    const events = (await readFile(eventsPath, "utf8")).split("\n").filter(Boolean)
      .filter((line) => {
        const event = JSON.parse(line) as { type?: string; payload?: { revision?: number } };
        return !(event.type === "plan_approved" && event.payload?.revision === 1);
      });
    await writeFile(eventsPath, `${events.join("\n")}\n`, "utf8");

    await expect(buildCli().parseAsync([
      "approve-plan", runDir, "--revision", "1", "--dry-run",
    ], { from: "user" })).rejects.toThrow(/source checkout/i);

    const repaired = (await readFile(eventsPath, "utf8")).split("\n").filter(Boolean)
      .map((line) => JSON.parse(line) as { type?: string; payload?: { revision?: number } })
      .filter((event) => event.type === "plan_approved" && event.payload?.revision === 1);
    expect(repaired).toHaveLength(1);
  });

  it("plain resume repairs a missing completed initial approval event before controller preflight", async () => {
    const { runDir } = await plannedDurableCliRun();
    const pending = await readManifestV2(runDir);
    await approvePlanRevision(runDir, 1, {
      actor: "human",
      approvalControllerCapture: async () => ({
        provenance: pending.controller_provenance!,
        selfHosting: pending.controller_provenance!.self_hosting,
      }),
    });
    const eventsPath = join(runDir, "events.jsonl");
    const retained = (await readFile(eventsPath, "utf8")).split("\n").filter(Boolean)
      .filter((line) => {
        const event = JSON.parse(line) as { type?: string; payload?: { revision?: number } };
        return !(event.type === "plan_approved" && event.payload?.revision === 1);
      });
    await writeFile(eventsPath, `${retained.join("\n")}\n`, "utf8");
    let approvalWasRepairedBeforeController = false;
    vi.spyOn(controllerProvenance, "assertCurrentControllerMatches").mockImplementationOnce(async () => {
      const events = (await readFile(eventsPath, "utf8")).split("\n").filter(Boolean)
        .map((line) => JSON.parse(line) as { type?: string; payload?: { revision?: number } });
      approvalWasRepairedBeforeController = events.some((event) => event.type === "plan_approved"
        && event.payload?.revision === 1);
      throw new Error("controller preflight stop");
    });

    await expect(buildCli().parseAsync([
      "resume", runDir, "--dry-run", "--json",
    ], { from: "user" })).rejects.toThrow("controller preflight stop");

    expect(approvalWasRepairedBeforeController).toBe(true);
    const repaired = (await readFile(eventsPath, "utf8")).split("\n").filter(Boolean)
      .map((line) => JSON.parse(line) as { type?: string; payload?: { revision?: number } })
      .filter((event) => event.type === "plan_approved" && event.payload?.revision === 1);
    expect(repaired).toHaveLength(1);
  });

  it("plain resume does not recapture controller authority when completed approval events are present", async () => {
    const { runDir } = await plannedDurableCliRun();
    const pending = await readManifestV2(runDir);
    await approvePlanRevision(runDir, 1, {
      actor: "human",
      approvalControllerCapture: async () => ({
        provenance: pending.controller_provenance!,
        selfHosting: pending.controller_provenance!.self_hosting,
      }),
    });
    const capture = vi.spyOn(controllerProvenance, "captureControllerProvenance");

    await expect(buildCli().parseAsync([
      "resume", runDir, "--dry-run", "--json",
    ], { from: "user" })).rejects.toThrow(/source checkout/i);

    expect(capture).not.toHaveBeenCalled();
  });

  it.each([
    { state: "pending", command: "resume" },
    { state: "pending", command: "approve-plan" },
    { state: "promoted", command: "resume" },
    { state: "promoted", command: "approve-plan" },
    { state: "completed", command: "resume" },
    { state: "completed", command: "approve-plan" },
  ] as const)("rejects a $state approval downgrade through $command before controller or file effects", async ({ state, command }) => {
    const { runDir } = await plannedDurableCliRun();
    let manifest = await readManifestV2(runDir);
    const requestPath = manifest.plan_revisions["1"]!.approval_request_path!;
    if (state === "pending") {
      const raw = structuredClone(manifest);
      raw.pending_plan_approval = null;
      await writeFile(join(runDir, "manifest.json"), `${JSON.stringify(raw, null, 2)}\n`, "utf8");
    } else {
      await approvePlanRevision(runDir, 1, {
        actor: "human",
        approvalControllerCapture: async () => ({
          provenance: manifest.controller_provenance!,
          selfHosting: manifest.controller_provenance!.self_hosting,
        }),
      });
      if (state === "completed") {
        await updateManifestV2(runDir, { stage: "delivery", delivery_state: "ready" });
        await withRunLedgerTransaction(runDir, (transaction) => transaction.recordTerminalDisposition({
          outcome: "delivered",
          actor: "runtime",
          reason: "Delivery is ready",
          residual_risks: [],
          recorded_at: new Date().toISOString(),
          source_stage: "delivery",
        }));
      }
      manifest = await readManifestV2(runDir);
      const raw = structuredClone(manifest) as Record<string, any>;
      raw.approval_protocol_version = null;
      raw.approval_protocol_start_revision = null;
      raw.run_configuration_sha256 = null;
      raw.pending_plan_approval = null;
      for (const revision of Object.values(raw.plan_revisions) as Array<Record<string, unknown>>) {
        for (const field of [
          "origin", "base_revision", "approval_request_path", "approval_request_sha256",
          "approval_subject_sha256", "decision_contract_sha256",
        ]) delete revision[field];
      }
      await writeFile(join(runDir, "manifest.json"), `${JSON.stringify(raw, null, 2)}\n`, "utf8");
      await rm(join(runDir, "run-configuration.json"));
      await rm(join(runDir, requestPath));
    }
    const before = await snapshotRunFiles(runDir);
    const capture = vi.spyOn(controllerProvenance, "captureControllerProvenance");
    const reconcile = vi.spyOn(githubReconciliation, "reconcileGitHubIssues");
    const reflect = vi.spyOn(reflectionWorkflow, "runReflection");
    const workflow = vi.spyOn(runtimeWorkflow, "runWorkflow");
    const argv = command === "resume"
      ? ["resume", runDir, "--dry-run", "--json"]
      : ["approve-plan", runDir, "--revision", "1", "--dry-run", "--json"];
    const expected = state === "pending"
      ? /pending approval pointer/i
      : state === "completed" && command === "approve-plan"
        ? /terminal outcome delivered/i
        : /irreversible protocol marker|protocol marker and start revision/i;

    await expect(buildCli().parseAsync(argv, { from: "user" })).rejects.toThrow(expected);

    expect(capture).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
    expect(reflect).not.toHaveBeenCalled();
    expect(workflow).not.toHaveBeenCalled();
    expect(await snapshotRunFiles(runDir)).toEqual(before);
  });

  it("retries exact delivered reflection without session artifacts, controller preflight, or workflow re-entry", async () => {
    const { runDir } = await plannedDurableCliRun("github", true);
    const pending = await readManifestV2(runDir);
    await approvePlanRevision(runDir, 1, {
      actor: "human",
      approvalControllerCapture: async () => ({
        provenance: pending.controller_provenance!,
        selfHosting: pending.controller_provenance!.self_hosting,
      }),
    });
    await updateManifestV2(runDir, {
      stage: "delivery",
      delivery_state: "ready",
      assurance_outcome: "verified_ready",
    });
    const ready = await readManifestV2(runDir);
    await writeFile(join(runDir, "manifest.json"), `${JSON.stringify({
      ...ready,
      github_effects_protocol: "legacy-run-v1",
      task_lineage_id: null,
    }, null, 2)}\n`, "utf8");
    await withRunLedgerTransaction(runDir, (transaction) => transaction.recordTerminalDisposition({
      outcome: "delivered",
      actor: "runtime",
      reason: "Delivery is ready",
      residual_risks: [],
      recorded_at: new Date().toISOString(),
      source_stage: "delivery",
    }));
    const approved = await readManifestV2(runDir);
    const requestPath = approved.plan_revisions["1"]!.approval_request_path!;
    const authorityBefore = await Promise.all([
      readFile(join(runDir, "run-configuration.json"), "utf8"),
      readFile(join(runDir, requestPath), "utf8"),
    ]);
    const approvalEvents = (text: string) => text.split("\n").filter(Boolean)
      .filter((line) => (JSON.parse(line) as { type?: string }).type === "plan_approved");
    const approvalEventsBefore = approvalEvents(await readFile(join(runDir, "events.jsonl"), "utf8"));
    const approvalProjection = (manifest: Awaited<ReturnType<typeof readManifestV2>>) => ({
      approval_protocol_version: manifest.approval_protocol_version,
      run_configuration_sha256: manifest.run_configuration_sha256,
      pending_plan_approval: manifest.pending_plan_approval,
      current_revision: manifest.current_revision,
      approved_revision: manifest.approved_revision,
      current_plan_revision: manifest.current_plan_revision,
      approved_plan_revision: manifest.approved_plan_revision,
      plan_revisions: manifest.plan_revisions,
      terminal: manifest.terminal,
    });
    const approvalBefore = approvalProjection(approved);
    await rm(join(runDir, "session-state.json"));
    await rm(join(runDir, "session-events.jsonl"));
    const controllerCheck = vi.spyOn(controllerProvenance, "assertCurrentControllerMatches");
    const order: string[] = [];
    vi.spyOn(githubReconciliation, "reconcileGitHubIssues").mockImplementation(async () => {
      order.push("reconcile");
      return {} as never;
    });
    const sentinel = new Error("exact delivered reflection interrupted");
    const reflection = vi.spyOn(reflectionWorkflow, "runReflection")
      .mockImplementationOnce(async () => {
        order.push("reflect-failed");
        throw sentinel;
      })
      .mockImplementationOnce(async () => {
        order.push("reflect-retried");
        return {} as never;
      });
    const workflow = vi.spyOn(runtimeWorkflow, "runWorkflow");

    await expect(buildCli().parseAsync(["resume", runDir, "--dry-run", "--json"], { from: "user" }))
      .rejects.toBe(sentinel);
    await buildCli().parseAsync(["resume", runDir, "--dry-run", "--json"], { from: "user" });

    expect(workflow).not.toHaveBeenCalled();
    expect(reflection).toHaveBeenCalledTimes(2);
    expect(order).toEqual(["reconcile", "reflect-failed", "reconcile", "reflect-retried"]);
    expect(approvalProjection(await readManifestV2(runDir))).toEqual(approvalBefore);
    expect((await readManifestV2(runDir)).stage).toBe("complete");
    expect(approvalEvents(await readFile(join(runDir, "events.jsonl"), "utf8"))).toEqual(approvalEventsBefore);
    expect(await Promise.all([
      readFile(join(runDir, "run-configuration.json"), "utf8"),
      readFile(join(runDir, requestPath), "utf8"),
    ])).toEqual(authorityBefore);
  });

  it("fails an advanced initial replay closed when its approval event is missing", async () => {
    const { runDir } = await plannedDurableCliRun();
    const pending = await readManifestV2(runDir);
    await approvePlanRevision(runDir, 1, {
      actor: "human",
      approvalControllerCapture: async () => ({
        provenance: pending.controller_provenance!,
        selfHosting: pending.controller_provenance!.self_hosting,
      }),
    });
    const eventsPath = join(runDir, "events.jsonl");
    const events = (await readFile(eventsPath, "utf8")).split("\n").filter(Boolean)
      .filter((line) => {
        const event = JSON.parse(line) as { type?: string; payload?: { revision?: number } };
        return !(event.type === "plan_approved" && event.payload?.revision === 1);
      });
    await writeFile(eventsPath, `${events.join("\n")}\n`, "utf8");
    await updateManifestV2(runDir, { stage: "implementing" });

    await expect(buildCli().parseAsync([
      "approve-plan", runDir, "--revision", "1", "--dry-run",
    ], { from: "user" })).rejects.toThrow(/cannot repair.*after workflow advancement|approval event is missing/i);
  });

  it.each([
    { provenance: "invalid", tamper: "approved brief" },
    { provenance: "invalid", tamper: "plan binding" },
    { provenance: "valid", tamper: "approved brief" },
    { provenance: "valid", tamper: "plan binding" },
  ] as const)("revalidates completed approval before pending-replan reconciliation when $tamper is tampered ($provenance lineage)", async ({ provenance, tamper }) => {
    const { runDir } = await plannedDurableCliRun();
    const pending = await readManifestV2(runDir);
    await approvePlanRevision(runDir, 1, {
      actor: "human",
      approvalControllerCapture: async () => ({
        provenance: pending.controller_provenance!,
        selfHosting: pending.controller_provenance!.self_hosting,
      }),
    });
    const manifest = await readManifestV2(runDir);
    const planRecord = manifest.plan_revisions["1"]!;
    const plan = JSON.parse(await readFile(join(runDir, planRecord.path), "utf8")) as Record<string, unknown>;
    const workItemId = (plan.work_items as Array<{ id: string }>)[0]!.id;
    await updateManifestV2(runDir, {
      stage: "awaiting_plan_approval",
      current_work_item_id: workItemId,
      work_item_progress: {
        ...manifest.work_item_progress,
        [workItemId]: {
          status: "blocked",
          attempts: 2,
          ...(provenance === "valid" ? { replan_patch_path: `replans/${workItemId}.json` } : {}),
        },
      },
      convergence_reports: {
        ...manifest.convergence_reports,
        [workItemId]: {
          path: `reviews/convergence/${workItemId}.json`,
          plan_revision: 1,
          review_revision: 1,
          recommended_action: "create_replan",
        },
      },
    });
    if (tamper === "approved brief") {
      const approvedBriefPath = join(runDir, "discovery/approved-brief.json");
      const approvedBrief = JSON.parse(await readFile(approvedBriefPath, "utf8")) as Record<string, unknown>;
      await writeFile(approvedBriefPath, `${JSON.stringify({ ...approvedBrief, goal: "Tampered pending replan" }, null, 2)}\n`, "utf8");
    } else {
      const changedPlan = { ...plan, discovery_brief_sha256: "0".repeat(64) };
      const planText = `${JSON.stringify(changedPlan, null, 2)}\n`;
      await writeFile(join(runDir, planRecord.path), planText, "utf8");
      await updateManifestV2(runDir, {
        plan_revisions: {
          ...(await readManifestV2(runDir)).plan_revisions,
          "1": { ...planRecord, sha256: createHash("sha256").update(planText, "utf8").digest("hex") },
        },
      });
    }
    const before = await snapshotRunFiles(runDir);
    const planLoads = vi.spyOn(verifiedPlanWorkflow, "loadVerifiedPlanBundle");

    await expect(buildCli().parseAsync([
      "resume", runDir, "--dry-run", "--json",
    ], { from: "user" })).rejects.toThrow(tamper === "approved brief"
      ? /discovery brief.*(digest|SHA-256)/i
      : /plan approval request does not match the manifest revision/i);

    const after = await snapshotRunFiles(runDir);
    expect(planLoads.mock.calls.some((call) => call[2] === 2)).toBe(false);
    expect((await readManifestV2(runDir))).toMatchObject({ approved_revision: 1, current_revision: 1 });
    expect(await readFile(join(runDir, "plans/revision-2.md"), "utf8").catch(() => null)).toBeNull();
    expect(Object.keys(after).filter((path) => after[path] !== before[path])).toEqual([]);
  });

  it.each([
    { label: "an unverifiable persisted PR head", url: "https://github.com/acme/repo/pull/42", numbers: [42], expected: "blocked" },
    { label: "a missing pull-request URL", url: undefined, numbers: [42], expected: "blocked" },
    { label: "a missing pull-request number", url: undefined, numbers: [], expected: "blocked" },
  ])("routes GitHub $label resumes through strict delivery validation", async ({ url, numbers, expected }) => {
    tempRoot = await mkdtemp(join(tmpdir(), "brain-hands-cli-github-resume-"));
    await mkdir(join(tempRoot, "worktree"));
    const intake = { task: "Resume GitHub delivery", repo_root: tempRoot, mode: "github" as const, research: false, reflection: false };
    const ledger = await createLegacyRunLedgerV2({ repoRoot: tempRoot, originalRequest: intake.task, slug: "github-resume", mode: "github", intake });
    const plan = JSON.stringify({
      summary: "Resume GitHub delivery",
      assumptions: [],
      research: [],
      research_sources: ["repo"],
      architecture: "none",
      risks: [],
      work_items: [executionSpec("item")],
      integration_verification: [["true"]],
    });
    await recordPlan(ledger.runDir, plan);
    await approvePlanRevision(ledger.runDir, 1, { actor: "test" });
    await rewriteLegacyCheckoutSnapshot(ledger.runDir, {
      source_commit: null,
      worktree_path: join(tempRoot, "worktree"),
      branch_name: "codex/brain-hands/resume",
    });
    await updateManifestV2(ledger.runDir, {
      stage: "delivery",
      pull_request_numbers: numbers,
      github_ids: { issue_numbers: [], pull_request_numbers: numbers, pull_request_urls: url ? { "42": url } : {} },
      delivery_state: "pending",
    });

    await buildCli().parseAsync(["resume", ledger.runDir, "--dry-run", "--json"], { from: "user" });

    const manifest = await readManifestV2(ledger.runDir);
    expect(manifest.delivery_state).toBe(expected);
    if (expected === "blocked") expect(manifest.last_blocker).toContain("GitHub runtime failed");
  });

  it("rejects exact-plan approval when the requested revision is stale", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "brain-hands-cli-"));
    const ledger = await createLegacyRunLedgerV2({
      repoRoot: tempRoot,
      originalRequest: "Ship the feature",
      slug: "approval",
      intake: { task: "Ship the feature", repo_root: tempRoot, mode: "local", research: false, reflection: false },
    });
    await expect(
      buildCli().parseAsync(["approve-plan", ledger.runDir, "--revision", "1", "--dry-run"], { from: "user" }),
    ).rejects.toThrow("not the current revision");
  });

  it("validates the persisted execution plan before recording human approval", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "brain-hands-cli-invalid-plan-"));
    const intake = { task: "Reject invalid plan", repo_root: tempRoot, mode: "local" as const, research: false, reflection: false };
    const ledger = await createLegacyRunLedgerV2({
      repoRoot: tempRoot,
      originalRequest: intake.task,
      slug: "invalid-plan",
      intake,
    });
    const invalidItem = executionSpec("item");
    invalidItem.completion_contract.allow_additional_files = true;
    await recordPlan(ledger.runDir, JSON.stringify({
      summary: "Reject invalid plan",
      assumptions: [],
      research: [],
      research_sources: ["repository"],
      architecture: "focused",
      risks: [],
      work_items: [invalidItem],
      integration_verification: [["true"]],
    }));
    await updateManifestV2(ledger.runDir, { stage: "awaiting_plan_approval" });

    await expect(buildCli().parseAsync([
      "approve-plan",
      ledger.runDir,
      "--revision",
      "1",
      "--dry-run",
    ], { from: "user" })).rejects.toThrow(/not execution-ready/);

    expect((await readManifestV2(ledger.runDir)).approved_revision).toBeNull();
  });

  it("rejects metadata-free plan approval under a durable-discovery protocol before plan parsing", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "brain-hands-cli-durable-plan-approval-"));
    const intake = { task: "Reject a downgraded plan", repo_root: tempRoot, mode: "local" as const, research: false, reflection: false };
    const ledger = await createRunLedgerV2({ repoRoot: tempRoot, originalRequest: intake.task, slug: "durable-plan-approval", intake });
    await recordPlan(ledger.runDir, JSON.stringify({
      feature_slug: "downgrade",
      parent_issue: null,
      summary: intake.task,
      assumptions: [],
      research: [],
      research_sources: ["repository"],
      architecture: "Keep the plan focused.",
      risks: [],
      work_items: [executionSpec("item")],
      integration_verification: [["true"]],
    }));
    await updateManifestV2(ledger.runDir, { stage: "awaiting_plan_approval" });

    await expect(buildCli().parseAsync([
      "approve-plan", ledger.runDir, "--revision", "1", "--dry-run",
    ], { from: "user" })).rejects.toThrow(/irreversible protocol marker/i);

    expect((await readManifestV2(ledger.runDir)).approved_plan_revision).toBeNull();
  });

  it("rejects a manually approved metadata-free durable-discovery run at the protocol marker", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "brain-hands-cli-durable-plan-resume-"));
    const intake = { task: "Reject a downgraded resume", repo_root: tempRoot, mode: "local" as const, research: false, reflection: false };
    const ledger = await createRunLedgerV2({ repoRoot: tempRoot, originalRequest: intake.task, slug: "durable-plan-resume", intake });
    await recordPlan(ledger.runDir, JSON.stringify({
      feature_slug: "downgrade",
      parent_issue: null,
      summary: intake.task,
      assumptions: [],
      research: [],
      research_sources: ["repository"],
      architecture: "Keep the plan focused.",
      risks: [],
      work_items: [executionSpec("item")],
      integration_verification: [["true"]],
    }));
    await updateManifestV2(ledger.runDir, {
      approved_revision: 1,
      approved_plan_revision: 1,
    });
    await updateManifestV2(ledger.runDir, { stage: "awaiting_plan_approval" });

    await expect(buildCli().parseAsync([
      "resume", ledger.runDir, "--dry-run", "--json",
    ], { from: "user" })).rejects.toThrow(/irreversible protocol marker/i);
  });

  it("refuses to resume when approved plan bytes no longer match the recorded digest", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "brain-hands-cli-plan-integrity-"));
    const intake = { task: "Protect the approved plan", repo_root: tempRoot, mode: "local" as const, research: false, reflection: false };
    const ledger = await createLegacyRunLedgerV2({ repoRoot: tempRoot, originalRequest: intake.task, slug: "plan-integrity", mode: "local", intake });
    const plan = {
      summary: "Protect the approved plan",
      assumptions: [],
      research: [],
      research_sources: ["repository"],
      architecture: "none",
      risks: [],
      work_items: [executionSpec("item")],
      integration_verification: [["npm", "test"]],
    };
    const record = await recordPlan(ledger.runDir, `${JSON.stringify(plan, null, 2)}\n`);
    await approvePlanRevision(ledger.runDir, 1, { actor: "test" });
    await updateManifestV2(ledger.runDir, { stage: "delivery", delivery_state: "ready" });
    await writeFile(record.path, `${JSON.stringify({ ...plan, summary: "Tampered but structurally valid plan" }, null, 2)}\n`, "utf8");

    await expect(buildCli().parseAsync([
      "resume",
      ledger.runDir,
      "--dry-run",
      "--json",
    ], { from: "user" })).rejects.toThrow(/does not match its recorded SHA-256/);
  });

  it("publishes an incomplete legacy awaiting-replan pointer as operationally blocked", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "brain-hands-cli-replan-resume-"));
    const intake = { task: "Resume replan", repo_root: tempRoot, mode: "local" as const, research: false, reflection: false };
    const ledger = await createLegacyRunLedgerV2({ repoRoot: tempRoot, originalRequest: intake.task, slug: "replan-resume", intake });
    await recordPlan(ledger.runDir, JSON.stringify({
      summary: "Resume replan", assumptions: [], research: [], research_sources: ["repo"], architecture: "none", risks: [],
      work_items: [{ id: "item", title: "Item", objective: "Item", acceptance_criteria: ["Works"], dependencies: [], implementation_instructions: ["Implement"], verification_commands: [["true"]], files_expected_to_change: ["src/item.ts"] }],
      integration_verification: [["true"]],
    }));
    await approvePlanRevision(ledger.runDir, 1, { actor: "test" });
    const manifest = await readManifestV2(ledger.runDir);
    await rewriteLegacyCheckoutSnapshot(ledger.runDir, {
      source_commit: null,
      worktree_path: tempRoot,
      branch_name: "brain-hands/replan-resume",
    });
    await updateManifestV2(ledger.runDir, {
      stage: "awaiting_plan_approval",
      current_work_item_id: "item",
      work_item_progress: {
        ...manifest.work_item_progress,
        item: { status: "blocked", attempts: 2, replan_patch_path: "replans/item.json" },
      },
    });

    await buildCli().parseAsync([
      "resume",
      ledger.runDir,
      "--dry-run",
      "--json",
    ], { from: "user" });

    const blocked = await readManifestV2(ledger.runDir);
    expect(blocked.stage).toBe("awaiting_plan_approval");
    expect(blocked.delivery_state).toBe("blocked");
    expect(blocked.last_blocker).toMatch(/target projection lineage/i);
  });

  it("publishes corrupt multi-item replan resume status to its concrete issue idempotently", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "brain-hands-cli-corrupt-replan-"));
    const intake = { task: "Resume corrupt replan", repo_root: tempRoot, mode: "github" as const, research: false, reflection: false };
    const ledger = await createLegacyRunLedgerV2({ repoRoot: tempRoot, originalRequest: intake.task, slug: "corrupt-replan", mode: "github", intake });
    await recordPlan(ledger.runDir, JSON.stringify({
      summary: intake.task, assumptions: [], research: [], research_sources: ["repo"], architecture: "none", risks: [],
      work_items: [executionSpec("first"), executionSpec("second", ["first"])], integration_verification: [["true"]],
    }));
    await approvePlanRevision(ledger.runDir, 1, { actor: "test" });
    await updateManifestV2(ledger.runDir, {
      stage: "awaiting_plan_approval",
      current_work_item_id: "integrated",
      issue_numbers: [41, 42],
      github_ids: { issue_numbers: [41, 42], pull_request_numbers: [77], pull_request_urls: { "77": "https://github.com/acme/repo/pull/77" } },
      pull_request_numbers: [77],
      delivery_state: "blocked",
      last_blocker: "Review policy requires replanning",
      work_item_progress: {
        first: { status: "complete", attempts: 1 },
        second: { status: "complete", attempts: 1, replan_source_work_item_id: "integrated", replan_patch_path: "replans/second.json" },
        integrated: { status: "blocked", attempts: 2, replan_target_work_item_id: "second" },
      },
    });
    const upsert = vi.spyOn(DryRunGitHubAdapter.prototype, "upsertRunStatus");
    const prComment = vi.spyOn(DryRunGitHubAdapter.prototype, "commentOnPullRequest");
    const verifiedPlanLoads = vi.spyOn(verifiedPlanWorkflow, "loadVerifiedPlanBundle");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await buildCli().parseAsync(["resume", ledger.runDir, "--dry-run", "--json"], { from: "user" });
    await buildCli().parseAsync(["resume", ledger.runDir, "--dry-run", "--json"], { from: "user" });

    expect(upsert).not.toHaveBeenCalled();
    expect(verifiedPlanLoads).toHaveBeenCalledTimes(2);
    expect(verifiedPlanLoads.mock.calls.every((call) => call[2] === 1)).toBe(true);
    expect(prComment).not.toHaveBeenCalled();
    const afterFailure = await readManifestV2(ledger.runDir);
    expect(afterFailure.last_blocker).toContain("Pending replan provenance is invalid");
    log.mockRestore();
  });

  it.each([
    { label: "during reconciliation", timing: "reconciliation", expectedPlanLoads: 0 },
    { label: "before status publication", timing: "publication", expectedPlanLoads: 1 },
  ] as const)("hands off a CLI pending resume when approval wins $label", async ({ timing, expectedPlanLoads }) => {
    vi.spyOn(ledgerModule, "requiresPinnedRuntimeAuthority").mockResolvedValue(true);
    const ledger = await approvedCliRun("github", "feature");
    const base = await readManifestV2(ledger.runDir);
    const requestPath = "approvals/plan/revision-2.json";
    const requestSha256 = "a".repeat(64);
    const approvalSubjectSha256 = "b".repeat(64);
    const patchPath = replanWorkflow.replanPatchPath("feature", 1, 1);
    const pending = {
      schema_version: 1 as const,
      proposed_revision: 2,
      base_revision: 1,
      request_path: requestPath,
      request_sha256: requestSha256,
      approval_subject_sha256: approvalSubjectSha256,
    };
    await writeFile(join(ledger.runDir, "manifest.json"), `${JSON.stringify({
      ...base,
      approval_protocol_version: 1,
      approval_protocol_start_revision: 2,
      stage: "awaiting_plan_approval",
      current_work_item_id: "feature",
      delivery_state: "blocked",
      last_blocker: "Review policy requires replanning feature",
      pending_plan_approval: pending,
      plan_revisions: {
        ...base.plan_revisions,
        "2": {
          ...base.plan_revisions["1"]!,
          revision: 2,
          path: "plans/revision-2.md",
          sha256: "c".repeat(64),
          origin: "replan",
          base_revision: 1,
          approval_request_path: requestPath,
          approval_request_sha256: requestSha256,
          approval_subject_sha256: approvalSubjectSha256,
          decision_contract_sha256: "d".repeat(64),
        },
      },
      work_item_progress: {
        ...base.work_item_progress,
        feature: {
          ...(base.work_item_progress.feature ?? {}),
          status: "blocked",
          attempts: 1,
          replan_patch_path: patchPath,
          replan_target_work_item_id: "feature",
        },
      },
      convergence_reports: {
        ...base.convergence_reports,
        feature: {
          path: "reviews/convergence/feature.json",
          plan_revision: 1,
          review_revision: 1,
          recommended_action: "create_replan",
        },
      },
      updated_at: new Date().toISOString(),
    }, null, 2)}\n`, "utf8");
    const pendingManifest = await readManifestV2(ledger.runDir);
    const coordinates = {
      baseRevision: 1,
      proposedRevision: 2,
      pending,
      canonicalBlocker: pendingManifest.last_blocker!,
    };
    let promoted: Awaited<ReturnType<typeof readManifestV2>> | null = null;
    const promote = async () => {
      if (promoted !== null) return promoted;
      const current = await readManifestV2(ledger.runDir);
      await writeFile(join(ledger.runDir, "manifest.json"), `${JSON.stringify({
        ...current,
        stage: "worktree_setup",
        current_revision: 2,
        current_plan_revision: 2,
        approved_revision: 2,
        approved_plan_revision: 2,
        pending_plan_approval: null,
        execution_lease: null,
        delivery_state: "pending",
        last_blocker: null,
        review_accounting: current.review_accounting
          ? { ...current.review_accounting, plan_revision: 2 }
          : undefined,
        updated_at: new Date().toISOString(),
      }, null, 2)}\n`, "utf8");
      promoted = await readManifestV2(ledger.runDir);
      return promoted;
    };
    vi.spyOn(replanWorkflow, "reconcilePendingReplanApprovalBoundary")
      .mockImplementationOnce(async () => ({
        state: timing === "reconciliation" ? "approved" : "pending",
        manifest: timing === "reconciliation" ? await promote() : pendingManifest,
        request: {} as never,
        coordinates,
      }))
      .mockRejectedValue(new Error("consumer fallback must not be needed for a marked CLI result"));
    const originalLoad = verifiedPlanWorkflow.loadVerifiedPlanBundle;
    const planLoads = vi.spyOn(verifiedPlanWorkflow, "loadVerifiedPlanBundle").mockImplementation(async (...args) => {
      const loaded = await originalLoad(...args);
      if (timing === "publication") await promote();
      return loaded;
    });
    const upsert = vi.spyOn(DryRunGitHubAdapter.prototype, "upsertRunStatus");
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await buildCli().parseAsync(["resume", "--run", ledger.runDir, "--dry-run", "--json"], { from: "user" });

    expect(promoted).not.toBeNull();
    expect(await readManifestV2(ledger.runDir)).toEqual(promoted);
    expect(upsert).not.toHaveBeenCalled();
    expect(planLoads).toHaveBeenCalledTimes(expectedPlanLoads);
    if (expectedPlanLoads === 1) expect(planLoads.mock.calls[0]?.[2]).toBe(1);
  });

  it("rejects retained diagnostics for legacy and unapproved ledgers", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "brain-hands-cli-"));
    const legacy = await createRunLedger({ repoRoot: tempRoot, originalRequest: "Legacy", slug: "legacy" });
    await expect(
      buildCli().parseAsync(["implement", "--run", legacy.runDir, "--issue", "1"], { from: "user" }),
    ).rejects.toThrow("only supports v2 run ledgers");

    const v2 = await createRunLedgerV2({
      repoRoot: tempRoot,
      originalRequest: "Unapproved",
      slug: "unapproved",
      intake: { task: "Unapproved", repo_root: tempRoot, mode: "local", research: false, reflection: false },
    });
    await expect(
      buildCli().parseAsync(["review", "--run", v2.runDir, "--issue", "1", "--pr", "2"], { from: "user" }),
    ).rejects.toThrow("requires explicit approval");
  });

  it("keeps reconcile-github dry-run by default and requires --apply for closures", async () => {
    const ledger = await approvedCliRun("github", "BH-008");
    await attachReadyCliLineage(ledger, "BH-008");
    const beforeTerminal = await readManifestV2(ledger.runDir);
    await updateManifestV2(ledger.runDir, {
      stage: "delivery",
      delivery_state: "blocked",
      github_ids: { ...beforeTerminal.github_ids, issue_numbers: [8, 99] },
    });
    await recordTerminalDispositionWithCleanup({
      runDir: ledger.runDir,
      disposition: {
        outcome: "closed_blocked", actor: "human", reason: "Explicitly closed after an unavailable dependency",
        residual_risks: ["Work remains incomplete"],
      },
      lineage: await readTaskLineage(tempRoot!, beforeTerminal.task_lineage_id!),
    });
    const manifest = await readManifestV2(ledger.runDir);
    vi.spyOn(GhCliGitHubAdapter.prototype, "getRepositoryIdentity").mockResolvedValue({ host: "github.com", name_with_owner: "acme/repo", actor: "operator" });
    let closed = false;
    let labels = ["brain-hands:ready"];
    vi.spyOn(GhCliGitHubAdapter.prototype, "getIssue").mockImplementation(async (number) => ({
      number,
      title: "BH-008",
      body: `<!-- brain-hands-lineage:${manifest.task_lineage_id} -->\n<!-- brain-hands-run:${manifest.run_id} -->\n<!-- brain-hands-work-item:BH-008 -->`,
      state: closed ? "CLOSED" : "OPEN",
      state_reason: closed ? "NOT_PLANNED" : null,
      labels,
    }));
    const closeIssue = vi.spyOn(GhCliGitHubAdapter.prototype, "closeIssue").mockImplementation(async () => { closed = true; });
    vi.spyOn(GhCliGitHubAdapter.prototype, "updateIssueLabels").mockImplementation(async (_number, edit) => {
      labels = labels.filter((label) => !edit.remove.includes(label));
      labels.push(...edit.add);
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await buildCli().parseAsync(["reconcile-github", "--run", ledger.runDir, "--json"], { from: "user" });
    const firstDryRunJson = String(log.mock.calls.at(-1)?.[0]);
    await buildCli().parseAsync(["reconcile-github", "--run", ledger.runDir, "--json"], { from: "user" });
    const secondDryRunJson = String(log.mock.calls.at(-1)?.[0]);
    const dryRun = JSON.parse(firstDryRunJson) as { mode: string; issues: Array<{ number: number; action: string; applied: boolean; skip_reason?: string }> };
    expect(dryRun.mode).toBe("dry_run");
    expect(secondDryRunJson).toBe(firstDryRunJson);
    expect(dryRun.issues).toEqual([expect.objectContaining({ number: 8, action: "close", applied: false })]);
    expect(closeIssue).not.toHaveBeenCalled();

    await buildCli().parseAsync(["reconcile-github", "--run", ledger.runDir, "--apply", "--json"], { from: "user" });
    const applied = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as { mode: string; issues: Array<{ action: string; applied: boolean }> };
    expect(applied.mode).toBe("apply");
    expect(applied.issues).toEqual([expect.objectContaining({ action: "close", applied: true })]);
    expect(closeIssue).toHaveBeenCalledOnce();
  });

  it("keeps GitHub status observation-only", async () => {
    const ledger = await approvedCliRun("github", "BH-008");
    const getDefaultBranch = vi.spyOn(GhCliGitHubAdapter.prototype, "getDefaultBranch");
    const updatePullRequestBody = vi.spyOn(GhCliGitHubAdapter.prototype, "updatePullRequestBody");
    const closeIssue = vi.spyOn(GhCliGitHubAdapter.prototype, "closeIssue");
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await buildCli().parseAsync(["status", "--run", ledger.runDir, "--json"], { from: "user" });

    expect(getDefaultBranch).not.toHaveBeenCalled();
    expect(updatePullRequestBody).not.toHaveBeenCalled();
    expect(closeIssue).not.toHaveBeenCalled();
  });

  it.each([
    ["close-run", ["--outcome", "blocked", "--reason", "Stop waiting for the dependency"]],
    ["abandon", ["--actor", "operator", "--reason", "This work is no longer planned"]],
  ] as const)("reconciles GitHub issues when %s explicitly terminates a run", async (command, arguments_) => {
    const ledger = await approvedCliRun("github", "BH-008");
    await attachReadyCliLineage(ledger, "BH-008");
    if (command === "close-run") {
      await updateManifestV2(ledger.runDir, { stage: "delivery", delivery_state: "blocked", last_blocker: "Dependency unavailable" });
    }
    const manifest = await readManifestV2(ledger.runDir);
    vi.spyOn(GhCliGitHubAdapter.prototype, "getRepositoryIdentity").mockResolvedValue({ host: "github.com", name_with_owner: "acme/repo", actor: "operator" });
    vi.spyOn(GhCliGitHubAdapter.prototype, "getDefaultBranch").mockResolvedValue("main");
    vi.spyOn(GhCliGitHubAdapter.prototype, "getIssue").mockResolvedValue({
      number: 8,
      title: "BH-008",
      body: `<!-- brain-hands-lineage:${manifest.task_lineage_id} -->\n<!-- brain-hands-run:${manifest.run_id} -->\n<!-- brain-hands-work-item:BH-008 -->`,
      state: "OPEN",
      state_reason: null,
      labels: ["brain-hands:ready"],
    });
    const closeIssue = vi.spyOn(GhCliGitHubAdapter.prototype, "closeIssue").mockResolvedValue();
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await buildCli().parseAsync([
      command, "--run", ledger.runDir, ...(command === "close-run" ? [...arguments_, "--dry-run"] : arguments_),
    ], { from: "user" });

    expect(closeIssue).toHaveBeenCalledWith(8, "not_planned");
  });

  it("does not invoke real GitHub reconciliation for a durable dry-run delivery", async () => {
    const ledger = await approvedCliRun("github", "BH-008");
    await attachReadyCliLineage(ledger, "BH-008");
    const manifest = await readManifestV2(ledger.runDir);
    await updateManifestV2(ledger.runDir, {
      pull_request_numbers: [42],
      github_ids: {
        ...manifest.github_ids,
        pull_request_numbers: [42],
        pull_request_urls: { "42": "https://github.com/dry-run/repo/pull/42" },
      },
    });
    const getDefaultBranch = vi.spyOn(GhCliGitHubAdapter.prototype, "getDefaultBranch")
      .mockRejectedValue(new Error("real GitHub must not be called for dry-run delivery"));
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await buildCli().parseAsync([
      "abandon", "--run", ledger.runDir, "--actor", "operator", "--reason", "Dry-run complete",
    ], { from: "user" });

    expect(getDefaultBranch).not.toHaveBeenCalled();
  });

  it("reads v2 status and generates an analysis-only reflection update", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "brain-hands-cli-"));
    const ledger = await createLegacyRunLedgerV2({
      repoRoot: tempRoot,
      originalRequest: "Inspect the completed workflow",
      slug: "status",
      intake: { task: "Inspect the completed workflow", repo_root: tempRoot, mode: "local", research: false, reflection: false },
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { openProgressReporter } = await import("../src/progress/log.js");
    const progress = await openProgressReporter({ runDir: ledger.runDir, now: () => "2000-01-01T00:00:00.000Z" });
    await progress.emit({ code: "planning_started", source: "brain" });
    await buildCli().parseAsync(["status", ledger.runDir], { from: "user" });
    expect(log.mock.calls.flat().join("\n")).toContain("Schema: v2");
    expect(log.mock.calls.flat().join("\n")).toContain("Operator state: Progressing automatically");
    expect(log.mock.calls.flat().join("\n")).toContain("Activity health: possibly stale");
    expect(log.mock.calls.flat().join("\n")).toContain("Worker PID:");
    log.mockClear();
    await buildCli().parseAsync(["logs", ledger.runDir], { from: "user" });
    expect(log.mock.calls.flat().join("\n")).toContain("Planning started");
    log.mockRestore();

    const jsonLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await buildCli().parseAsync(["status", ledger.runDir, "--json"], { from: "user" });
    const statusJson = JSON.parse(String(jsonLog.mock.calls.at(-1)?.[0])) as { operator_state?: string };
    expect(statusJson.operator_state).toBe("progressing_automatically");
    jsonLog.mockClear();
    await buildCli().parseAsync(["logs", ledger.runDir, "--json"], { from: "user" });
    const logsJson = JSON.parse(String(jsonLog.mock.calls.at(-1)?.[0])) as {
      status?: { operator_state?: string };
      events?: unknown[];
      progress_events?: unknown[];
      session_event?: unknown;
    };
    expect(logsJson.status?.operator_state).toBe("progressing_automatically");
    expect(logsJson.events).toEqual([]);
    expect(logsJson.progress_events).toHaveLength(1);
    expect(logsJson.session_event).toBeNull();

    const invalidSessionEvent = "not-json\n";
    await writeFile(join(ledger.runDir, "session-events.jsonl"), invalidSessionEvent, "utf8");
    jsonLog.mockClear();
    await buildCli().parseAsync(["logs", ledger.runDir, "--json"], { from: "user" });
    expect((JSON.parse(String(jsonLog.mock.calls.at(-1)?.[0])) as { session_event?: unknown }).session_event).toBeNull();
    expect(await readFile(join(ledger.runDir, "session-events.jsonl"), "utf8")).toBe(invalidSessionEvent);

    const unreadableSessionEvent = "unreadable-legacy-session-artifact\n";
    const unreadablePath = join(ledger.runDir, "session-events.jsonl");
    await writeFile(unreadablePath, unreadableSessionEvent, "utf8");
    await chmod(unreadablePath, 0o000);
    try {
      jsonLog.mockClear();
      await buildCli().parseAsync(["logs", ledger.runDir, "--json"], { from: "user" });
      expect((JSON.parse(String(jsonLog.mock.calls.at(-1)?.[0])) as { session_event?: unknown }).session_event).toBeNull();
    } finally {
      await chmod(unreadablePath, 0o600);
    }
    expect(await readFile(unreadablePath, "utf8")).toBe(unreadableSessionEvent);
    jsonLog.mockRestore();

    const reflectionPath = join(tempRoot, "reflection.json");
    await writeFile(reflectionPath, `${JSON.stringify({
      outcome_summary: "The run completed.",
      what_worked: ["Approval was explicit."],
      what_was_correct: ["The plan was reviewed."],
      what_failed: [],
      root_causes: [],
      avoidable_rework: [],
      process_improvements: ["Keep the approval gate visible."],
      improvements: ["Keep the approval gate visible."],
      classifications: {
        implementation_defects: [],
        planning_defects: [],
        verification_gaps: [],
        environment_failures: [],
        external_blockers: [],
        unnecessary_cost_or_rework: [],
      },
      candidate_regression_tests: ["Add a CLI smoke test."],
      evidence_paths: ["events.jsonl"],
    }, null, 2)}\n`, "utf8");
    const reflectionLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await buildCli().parseAsync(["reflection", "--update-from-reflection", reflectionPath, "--repo", tempRoot, "--dry-run"], { from: "user" });
    expect(reflectionLog.mock.calls.flat().join("\n")).toContain("Improvement plan written to");
    reflectionLog.mockRestore();
  });

  it("compacts human progress logs while preserving JSON progress events", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "brain-hands-cli-"));
    const ledger = await createRunLedgerV2({
      repoRoot: tempRoot,
      originalRequest: "Compact progress",
      slug: "compact-progress",
      intake: { task: "Compact progress", repo_root: tempRoot, mode: "local", research: false, reflection: false },
    });
    const { openProgressReporter } = await import("../src/progress/log.js");
    const progress = await openProgressReporter({ runDir: ledger.runDir, now: () => "2026-07-16T20:05:00.000Z" });
    const invocation = "7f05a9d1-7635-4895-88bb-94a56510ca54";
    await progress.emit({
      code: "heartbeat",
      source: "hands",
      workerSessionId: progress.sessionId,
      workerPid: progress.workerPid,
      heartbeatOrdinal: 1,
      modelInvocationId: invocation,
      workItem: { index: 1, total: 1, attempt: 1, final: false },
    });
    await progress.emit({
      code: "heartbeat",
      source: "hands",
      workerSessionId: progress.sessionId,
      workerPid: progress.workerPid,
      heartbeatOrdinal: 2,
      modelInvocationId: invocation,
      workItem: { index: 1, total: 1, attempt: 1, final: false },
    });

    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await buildCli().parseAsync(["logs", ledger.runDir], { from: "user" });
    expect(log.mock.calls.flat().join("\n")).toContain("Hands still running (2 heartbeats");
    expect(log.mock.calls.flat().join("\n")).not.toContain("Hands is still running");

    log.mockClear();
    await buildCli().parseAsync(["logs", ledger.runDir, "--json"], { from: "user" });
    const logsJson = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as { progress_events?: unknown[] };
    expect(logsJson.progress_events).toHaveLength(2);
    log.mockRestore();
  });

  it("returns null without mutating when session-state.json is missing", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "brain-hands-cli-missing-session-state-"));
    const ledger = await createRunLedgerV2({
      repoRoot: tempRoot,
      originalRequest: "Inspect a partial session pair",
      intake: { task: "Inspect a partial session pair", repo_root: tempRoot, mode: "local", research: false, reflection: false },
    });
    await rm(join(ledger.runDir, "session-state.json"));
    const beforeFiles = await snapshotRunFiles(ledger.runDir);
    const beforeEntries = await snapshotRunDirectoryEntries(ledger.runDir);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await buildCli().parseAsync(["logs", ledger.runDir, "--json"], { from: "user" });

    expect((JSON.parse(String(log.mock.calls.at(-1)?.[0])) as { session_event?: unknown }).session_event).toBeNull();
    expect(await snapshotRunFiles(ledger.runDir)).toEqual(beforeFiles);
    expect(await snapshotRunDirectoryEntries(ledger.runDir)).toEqual(beforeEntries);
    await expect(access(join(ledger.runDir, "session-state.json"))).rejects.toMatchObject({ code: "ENOENT" });
    log.mockRestore();
  });

  it("returns null without mutating when session-events.jsonl is missing", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "brain-hands-cli-missing-session-events-"));
    const ledger = await createRunLedgerV2({
      repoRoot: tempRoot,
      originalRequest: "Inspect a partial session pair",
      intake: { task: "Inspect a partial session pair", repo_root: tempRoot, mode: "local", research: false, reflection: false },
    });
    await rm(join(ledger.runDir, "session-events.jsonl"));
    const beforeFiles = await snapshotRunFiles(ledger.runDir);
    const beforeEntries = await snapshotRunDirectoryEntries(ledger.runDir);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await buildCli().parseAsync(["logs", ledger.runDir, "--json"], { from: "user" });

    expect((JSON.parse(String(log.mock.calls.at(-1)?.[0])) as { session_event?: unknown }).session_event).toBeNull();
    expect(await snapshotRunFiles(ledger.runDir)).toEqual(beforeFiles);
    expect(await snapshotRunDirectoryEntries(ledger.runDir)).toEqual(beforeEntries);
    await expect(access(join(ledger.runDir, "session-events.jsonl"))).rejects.toMatchObject({ code: "ENOENT" });
    log.mockRestore();
  });

  it("returns null for a schema-valid canonical event copied from another run", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "brain-hands-cli-foreign-session-event-"));
    const first = await createRunLedgerV2({
      repoRoot: tempRoot,
      slug: "first-session-event",
      originalRequest: "First session event",
      intake: { task: "First session event", repo_root: tempRoot, mode: "local", research: false, reflection: false },
    });
    const second = await createRunLedgerV2({
      repoRoot: tempRoot,
      slug: "second-session-event",
      originalRequest: "Second session event",
      intake: { task: "Second session event", repo_root: tempRoot, mode: "local", research: false, reflection: false },
    });
    await updateManifestV2(first.runDir, { stage: "verifier_review", delivery_state: "blocked" });
    await updateManifestV2(second.runDir, { stage: "verifier_review", delivery_state: "blocked" });
    const recordedAt = new Date().toISOString();
    await recordTerminalDisposition(first.runDir, {
      outcome: "closed_blocked", actor: "human", reason: "First", residual_risks: [], recorded_at: recordedAt,
    });
    await recordTerminalDisposition(second.runDir, {
      outcome: "closed_blocked", actor: "human", reason: "Second", residual_risks: [], recorded_at: new Date(Date.now() + 1).toISOString(),
    });
    const foreign = await readFile(join(first.runDir, "session-events.jsonl"), "utf8");
    await writeFile(join(second.runDir, "session-events.jsonl"), foreign, "utf8");
    const before = await readFile(join(second.runDir, "session-events.jsonl"), "utf8");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await buildCli().parseAsync(["logs", second.runDir, "--json"], { from: "user" });

    expect((JSON.parse(String(log.mock.calls.at(-1)?.[0])) as { session_event?: unknown }).session_event).toBeNull();
    expect(await readFile(join(second.runDir, "session-events.jsonl"), "utf8")).toBe(before);
    log.mockRestore();
  });
});

describe("readWorkflowDesign", () => {
  it("prefers the target repo design over the fallback root design", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "brain-hands-cli-"));
    const repoRoot = join(tempRoot, "target-repo");
    const fallbackRoot = join(tempRoot, "cli-checkout");

    await mkdir(repoRoot, { recursive: true });
    await mkdir(fallbackRoot, { recursive: true });
    await writeFile(join(repoRoot, "agentic-codex-workflow.md"), "target design\n", "utf8");
    await writeFile(join(fallbackRoot, "agentic-codex-workflow.md"), "fallback design\n", "utf8");

    const design = await readWorkflowDesign(repoRoot, fallbackRoot);

    expect(design).toBe("target design\n");
  });
});

describe("replace command", () => {
  it("prints the linked successor and a safely quoted resume command without invoking discovery", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "brain-hands-cli-replace-"));
    const predecessor = await createRunLedgerV2({
      repoRoot: tempRoot,
      originalRequest: "Replace safely",
      intake: { task: "Replace safely", repo_root: tempRoot, mode: "local", research: false, reflection: false },
    });
    const successorRunDir = "/tmp/successor's run";
    const replace = vi.spyOn(replacementWorkflow, "replaceAbandonedRun").mockResolvedValue({
      successorRunId: "replacement-1",
      successorRunDir,
      reservation: {} as never,
      predecessorLink: {} as never,
      completion: {} as never,
    });
    const discovery = vi.spyOn(discoveryModule, "runDiscoveryTurn");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await buildCli().parseAsync([
      "replace",
      "--run", predecessor.runDir,
      "--actor", "operator@example.test",
      "--reason", "The original worktree cannot be recovered",
    ], { from: "user" });

    expect(replace).toHaveBeenCalledWith({
      runDir: predecessor.runDir,
      actor: "operator@example.test",
      reason: "The original worktree cannot be recovered",
      dryRun: false,
    });
    expect(log).toHaveBeenCalledWith([
      `Replacement run directory: ${successorRunDir}`,
      `Next command: brain-hands resume --run '/tmp/successor'\"'\"'s run'`,
    ].join("\n"));
    expect(discovery).not.toHaveBeenCalled();
    log.mockRestore();
  });
});
