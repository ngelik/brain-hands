import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as controllerProvenance from "../../src/core/controller-provenance.js";
import { SubprocessCodexAdapter } from "../../src/adapters/codex.js";
import { defaultConfig } from "../../src/core/config.js";
import { runWithExecutionAuthority } from "../../src/core/execution-context.js";
import { runCommand } from "../../src/core/executor.js";
import { serializePersistedPlan } from "../../src/core/execution-spec.js";
import { resolveRunIntake } from "../../src/core/intake.js";
import {
  approvePlanRevision,
  createRunLedgerV2,
  derivePlanAcceptanceCriteria,
  readManifestV2,
  recordPlan,
  transitionRun,
  updateManifestV2,
} from "../../src/core/ledger.js";
import { buildPlanApprovalRequest, planDecisionContractSha256, requestSha256, serializePlanApprovalRequest } from "../../src/core/plan-approval.js";
import { buildPlanDelta } from "../../src/core/plan-delta.js";
import { resolveRunConfiguration, serializeRunConfiguration } from "../../src/core/run-configuration.js";
import type { BrainPlan } from "../../src/core/types.js";
import {
  bindApprovedRuntimeAuthority,
  executeGithubWorkflow,
  executeLocalWorkflow,
  loadApprovedRuntimeSnapshot,
  publishGithubWorkflowStatus,
  runGithubWorkflow,
  runLocal,
  runLocalWorkflow,
  runWorkflow,
  withRunExecutionLease,
  type RunGithubWorkflowInput,
} from "../../src/workflow/runtime.js";
import { readOperatorStatus, readRunLog } from "../../src/workflow/status.js";
import { executionSpec } from "../fixtures/execution-spec.js";
import { createLegacyRunLedgerV2, rewriteLegacyCheckoutSnapshot } from "../fixtures/legacy-run.js";
import { recordApprovedDiscoveryForPlan } from "../fixtures/pinned-plan.js";

let root: string | null = null;

const controller = {
  self_hosting: false,
  mode: "development_checkout" as const,
  executable_path: "/test/brain-hands",
  package_root: "/test/package",
  package_name: "@ngelik/brain-hands",
  package_version: "0.4.0",
  package_hash_algorithm: "sha256" as const,
  package_hash: "a".repeat(64),
  candidate_commit: "b".repeat(40),
};

async function approvedPinnedRuntime(
  mode: "local" | "github" = "local",
  approve = true,
  defaultRemote = "origin",
  recordCheckout = true,
  planOverride?: BrainPlan,
) {
  root = await mkdtemp(join(tmpdir(), "brain-hands-runtime-authority-"));
  execFileSync("git", ["init"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Codex Test"], { cwd: root });
  execFileSync("git", ["config", "user.email", "codex@example.com"], { cwd: root });
  await writeFile(join(root, "README.md"), "fixture\n");
  execFileSync("git", ["add", "README.md"], { cwd: root });
  execFileSync("git", ["commit", "-m", "fixture"], { cwd: root });
  controller.candidate_commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const config = defaultConfig();
  config.github.default_remote = defaultRemote;
  const intake = resolveRunIntake({
    task: "Execute only approved authority",
    repo_root: root,
    mode,
    research: false,
    reflection: false,
    quality_gate: config.retry_policy.quality_gate,
    hands_backup: config.retry_policy.backup,
  }, config);
  const runConfiguration = resolveRunConfiguration({ intake, config, controller, overrides: {} });
  const ledger = await createRunLedgerV2({
    repoRoot: root,
    originalRequest: intake.task,
    mode: intake.mode,
    intake,
    roles: intake.roles,
    sourceCommit: controller.candidate_commit,
    controllerProvenance: controller,
    worktreePath: null,
    branchName: null,
  });
  const worktreePath = join(root, ".brain-hands", "worktrees", ledger.runId);
  const branchName = `codex/brain-hands/${ledger.runId}`;
  execFileSync("git", ["worktree", "add", "-b", branchName, worktreePath, controller.candidate_commit], { cwd: root });
  await writeFile(join(ledger.runDir, "run-configuration.json"), serializeRunConfiguration(runConfiguration));
  const plan: BrainPlan = planOverride ?? {
    summary: "Approved runtime authority",
    assumptions: [],
    research: [],
    research_sources: ["repository"],
    architecture: "Use the immutable runtime snapshots.",
    risks: [],
    work_items: [executionSpec("BH-001")],
    integration_verification: [["true"]],
  };
  await transitionRun(ledger.runDir, "preflight", { actor: "test" });
  await transitionRun(ledger.runDir, "brain_discovery", { actor: "test" });
  await recordApprovedDiscoveryForPlan(ledger.runDir, plan);
  const planText = serializePersistedPlan(plan, "durable-discovery-v1");
  const recorded = await recordPlan(ledger.runDir, planText);
  const before = await readManifestV2(ledger.runDir);
  const relativePlanPath = "plans/revision-1.md";
  const request = buildPlanApprovalRequest({
    manifest: before,
    runConfiguration,
    reasonCode: "initial_plan",
    revision: 1,
    baseRevision: null,
    planPath: relativePlanPath,
    planSha256: recorded.sha256,
    decisionContractSha256: planDecisionContractSha256(plan),
    delta: buildPlanDelta(null, plan, { baseRevision: null, proposedRevision: 1 }),
    reconstructInitialAuthority: true,
  });
  const requestPath = "approvals/plan/revision-1.json";
  await mkdir(join(ledger.runDir, "approvals/plan"), { recursive: true });
  await writeFile(join(ledger.runDir, requestPath), serializePlanApprovalRequest(request));
  const pinned = {
    ...before,
    stage: "awaiting_plan_approval" as const,
    plan_revisions: {
      ...before.plan_revisions,
      "1": {
        ...before.plan_revisions["1"]!,
        path: relativePlanPath,
        origin: "initial" as const,
        base_revision: null,
        approval_request_path: requestPath,
        approval_request_sha256: requestSha256(request),
        approval_subject_sha256: request.approval_subject_sha256,
        decision_contract_sha256: planDecisionContractSha256(plan),
      },
    },
    pending_plan_approval: {
      schema_version: 1 as const,
      proposed_revision: 1,
      base_revision: null,
      request_path: requestPath,
      request_sha256: requestSha256(request),
      approval_subject_sha256: request.approval_subject_sha256,
    },
    approval_protocol_version: 1 as const,
    approval_protocol_start_revision: 1,
    run_configuration_sha256: createHash("sha256").update(serializeRunConfiguration(runConfiguration)).digest("hex"),
    worktree_path: recordCheckout ? worktreePath : null,
    branch_name: recordCheckout ? branchName : null,
  };
  await writeFile(join(ledger.runDir, "manifest.json"), `${JSON.stringify(pinned, null, 2)}\n`);
  if (approve) {
    await approvePlanRevision(ledger.runDir, 1, {
      actor: "human",
      approvalControllerCapture: async () => ({ provenance: controller, selfHosting: false }),
    });
    await transitionRun(ledger.runDir, "worktree_setup", { actor: "test" });
  }
  return { runDir: ledger.runDir, worktreePath, branchName, intake, plan, config, runConfiguration };
}

async function approvedLegacyRuntime(mode: "local" | "github" = "local", recordCheckout = true) {
  root = await mkdtemp(join(tmpdir(), "brain-hands-runtime-authority-legacy-"));
  execFileSync("git", ["init"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Codex Test"], { cwd: root });
  execFileSync("git", ["config", "user.email", "codex@example.com"], { cwd: root });
  execFileSync("git", ["commit", "--allow-empty", "-m", "historical source"], { cwd: root });
  const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const config = defaultConfig();
  const intake = resolveRunIntake({
    task: "Execute genuine historical authority", repo_root: root, mode,
    research: false, reflection: false,
  }, config);
  const ledger = await createLegacyRunLedgerV2({
    repoRoot: root, originalRequest: intake.task, intake, roles: intake.roles,
    mode, sourceCommit,
  });
  const worktreePath = join(root, ".brain-hands", "worktrees", ledger.runId);
  const branchName = `codex/brain-hands/${ledger.runId}`;
  if (recordCheckout) {
    execFileSync("git", ["worktree", "add", "-b", branchName, worktreePath, sourceCommit], { cwd: root });
    await rewriteLegacyCheckoutSnapshot(ledger.runDir, {
      source_commit: sourceCommit,
      worktree_path: worktreePath,
      branch_name: branchName,
    });
  }
  await transitionRun(ledger.runDir, "preflight", { actor: "test" });
  await transitionRun(ledger.runDir, "brain_planning", { actor: "test" });
  const plan: BrainPlan = {
    summary: "Genuine historical runtime authority", assumptions: [], research: [],
    research_sources: ["repository"], architecture: "Use the historical approved plan.",
    risks: [], work_items: [executionSpec("BH-001")], integration_verification: [["true"]],
  };
  await recordPlan(ledger.runDir, serializePersistedPlan(plan, "legacy-v2"));
  await transitionRun(ledger.runDir, "awaiting_plan_approval", { actor: "test" });
  await approvePlanRevision(ledger.runDir, 1, { actor: "human" });
  await transitionRun(ledger.runDir, "worktree_setup", { actor: "test" });
  return { runDir: ledger.runDir, worktreePath, branchName, intake, plan, sourceCommit };
}

afterEach(async () => {
  vi.restoreAllMocks();
  if (root) await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  root = null;
});

async function snapshotRunFiles(runDir: string): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  const walk = async (directory: string, prefix = "") => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute, relative);
      else if (entry.isFile()) snapshot[relative] = (await readFile(absolute)).toString("base64");
    }
  };
  await walk(runDir);
  return snapshot;
}

async function addPendingModernReplan(fixture: Awaited<ReturnType<typeof approvedPinnedRuntime>>) {
  const manifest = await readManifestV2(fixture.runDir);
  const proposedPlan: BrainPlan = {
    ...fixture.plan,
    summary: "Pending material revision must not become execution authority",
    work_items: fixture.plan.work_items.map((item, index) => index === 0
      ? { ...item, objective: `${item.objective} with an approved-base-safe revision` }
      : item),
  };
  const planText = serializePersistedPlan(proposedPlan, manifest.workflow_protocol);
  const planSha256 = createHash("sha256").update(planText).digest("hex");
  const request = buildPlanApprovalRequest({
    manifest,
    runConfiguration: fixture.runConfiguration,
    reasonCode: "material_replan",
    revision: 2,
    baseRevision: 1,
    planPath: "plans/revision-2.md",
    planSha256,
    decisionContractSha256: planDecisionContractSha256(proposedPlan),
    delta: buildPlanDelta(fixture.plan, proposedPlan, { baseRevision: 1, proposedRevision: 2 }),
  });
  const requestPath = "approvals/plan/revision-2.json";
  const pending = {
    schema_version: 1 as const,
    proposed_revision: 2,
    base_revision: 1,
    request_path: requestPath,
    request_sha256: requestSha256(request),
    approval_subject_sha256: request.approval_subject_sha256,
  };
  await writeFile(join(fixture.runDir, "plans/revision-2.md"), planText);
  await writeFile(join(fixture.runDir, requestPath), serializePlanApprovalRequest(request));
  await writeFile(join(fixture.runDir, "manifest.json"), `${JSON.stringify({
    ...manifest,
    stage: "awaiting_plan_approval",
    pending_plan_approval: pending,
    plan_revisions: {
      ...manifest.plan_revisions,
      "2": {
        revision: 2,
        path: "plans/revision-2.md",
        sha256: planSha256,
        origin: "replan",
        base_revision: 1,
        approval_request_path: requestPath,
        approval_request_sha256: pending.request_sha256,
        approval_subject_sha256: pending.approval_subject_sha256,
        decision_contract_sha256: planDecisionContractSha256(proposedPlan),
        acceptance_criteria: derivePlanAcceptanceCriteria(proposedPlan),
      },
    },
    last_blocker: "Plan revision 2 requires explicit approval",
  }, null, 2)}\n`);
  return { pending, proposedPlan };
}

async function stripInitialPinnedManifestMarkers(fixture: Awaited<ReturnType<typeof approvedPinnedRuntime>>) {
  const manifestPath = join(fixture.runDir, "manifest.json");
  const manifest = await readManifestV2(fixture.runDir);
  const revision = manifest.plan_revisions["1"]!;
  await writeFile(manifestPath, `${JSON.stringify({
    ...manifest,
    approval_protocol_version: null,
    approval_protocol_start_revision: null,
    run_configuration_sha256: null,
    pending_plan_approval: null,
    plan_revisions: {
      ...manifest.plan_revisions,
      "1": {
        revision: revision.revision,
        path: revision.path,
        sha256: revision.sha256,
        ...(revision.acceptance_criteria === undefined ? {} : { acceptance_criteria: revision.acceptance_criteria }),
      },
    },
  }, null, 2)}\n`);
  return manifest;
}

async function rewriteModernApprovalEvents(
  runDir: string,
  rewrite: (event: Record<string, unknown>) => Record<string, unknown> | Record<string, unknown>[],
) {
  const lines = (await readFile(join(runDir, "events.jsonl"), "utf8")).split("\n").filter(Boolean);
  const rewritten = lines.flatMap((line) => {
    const event = JSON.parse(line) as Record<string, unknown>;
    const payload = event.payload as Record<string, unknown> | undefined;
    return event.type === "plan_approved" && payload?.approval_semantics_version === 1
      ? rewrite(event)
      : [event];
  });
  await writeFile(join(runDir, "events.jsonl"), `${rewritten.map((event) => JSON.stringify(event)).join("\n")}\n`);
}

describe("approved runtime authority", () => {
  it("allows canonical aliases for nested same-run lease reuse but rejects a distinct run", async () => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-run-alias-"));
    const otherRun = join(root, "other-run");
    await mkdir(otherRun);
    let assertions = 0;

    await runWithExecutionAuthority({
      claim: { runDir: await realpath(root), token: "token", epoch: 1, invocationId: "alias-test" },
      assert: async () => { assertions += 1; },
      beginEffect: async () => "effect",
      recordEffectChild: async () => {},
      endEffect: async () => {},
    }, async () => {
      await expect(withRunExecutionLease(root!, async () => "same-run")).resolves.toBe("same-run");
      await expect(withRunExecutionLease(otherRun, async () => "wrong-run")).rejects.toThrow(/cross-run execution lease reuse/i);
    });

    expect(assertions).toBe(1);
  });

  it.each([
    ["pending", "rewritten"],
    ["pending", "deleted"],
    ["completed", "rewritten"],
    ["completed", "deleted"],
  ] as const)(
    "rejects %s plan-revision acceptance-criterion metadata when %s before runtime effects",
    async (state, tamper) => {
      const fixture = await approvedPinnedRuntime();
      if (state === "pending") await addPendingModernReplan(fixture);
      const manifestPath = join(fixture.runDir, "manifest.json");
      const manifest = await readManifestV2(fixture.runDir);
      const revision = state === "pending" ? 2 : 1;
      const revisionRecord = manifest.plan_revisions[String(revision)]!;
      const tamperedRevision = { ...revisionRecord } as Record<string, unknown>;
      if (tamper === "deleted") {
        delete tamperedRevision.acceptance_criteria;
      } else {
        tamperedRevision.acceptance_criteria = {
          "BH-001": [{ ref: "BH-001:AC-1", text: "forged mutable criterion" }],
        };
      }
      await writeFile(manifestPath, `${JSON.stringify({
        ...manifest,
        plan_revisions: {
          ...manifest.plan_revisions,
          [String(revision)]: tamperedRevision,
        },
      }, null, 2)}\n`);
      let bootstrapCalls = 0;
      let handsCalls = 0;
      let progressCalls = 0;
      const before = await snapshotRunFiles(fixture.runDir);

      const result = await runLocalWorkflow({
        runDir: fixture.runDir,
        worktreePath: fixture.worktreePath,
        intake: fixture.intake,
        plan: fixture.plan,
        codex: {} as never,
        progress: {
          path: join(fixture.runDir, "progress.jsonl"),
          sessionId: `criteria-${state}`,
          workerPid: process.pid,
          emit: async () => { progressCalls += 1; return null; },
        },
        dependencies: {
          controllerBootstrap: async () => { bootstrapCalls += 1; return {} as never; },
          hands: async () => { handsCalls += 1; throw new Error("Hands must not run"); },
        },
      });

      expect(result.status).toBe("human_action_required");
      expect(result.blocker).toMatch(/acceptance-criterion metadata.*canonical plan/i);
      expect(bootstrapCalls).toBe(0);
      expect(handsCalls).toBe(0);
      expect(progressCalls).toBe(0);
      expect(await snapshotRunFiles(fixture.runDir)).toEqual(before);
    },
  );

  it("verifies a genuine pending modern replan separately and keeps its approved base authoritative", async () => {
    const fixture = await approvedPinnedRuntime("github");
    await addPendingModernReplan(fixture);

    const snapshot = await loadApprovedRuntimeSnapshot(fixture.runDir, fixture.config);

    expect(snapshot?.plan.summary).toBe(fixture.plan.summary);
    expect(snapshot?.plan.work_items.map((item) => item.id)).toEqual(fixture.plan.work_items.map((item) => item.id));
    expect(snapshot?.manifest.pending_plan_approval?.proposed_revision).toBe(2);
  });

  it("loads a migrated historical approval prefix as the approved runtime base", async () => {
    const fixture = await approvedLegacyRuntime("local");
    const config = defaultConfig();
    const historicalController = { ...controller, candidate_commit: fixture.sourceCommit };
    const runConfiguration = resolveRunConfiguration({
      intake: fixture.intake,
      config,
      controller: historicalController,
      overrides: {},
    });
    const manifest = await readManifestV2(fixture.runDir);
    const proposedPlan: BrainPlan = {
      ...fixture.plan,
      summary: "First exact migrated replan",
    };
    const planText = serializePersistedPlan(proposedPlan, manifest.workflow_protocol);
    const planSha256 = createHash("sha256").update(planText).digest("hex");
    const request = buildPlanApprovalRequest({
      manifest: { ...manifest, controller_provenance: historicalController },
      runConfiguration,
      reasonCode: "material_replan",
      revision: 2,
      baseRevision: 1,
      planPath: "plans/revision-2.md",
      planSha256,
      decisionContractSha256: planDecisionContractSha256(proposedPlan),
      delta: buildPlanDelta(fixture.plan, proposedPlan, { baseRevision: 1, proposedRevision: 2 }),
    });
    const requestPath = "approvals/plan/revision-2.json";
    await mkdir(join(fixture.runDir, "approvals/plan"), { recursive: true });
    await writeFile(join(fixture.runDir, "run-configuration.json"), serializeRunConfiguration(runConfiguration));
    await writeFile(join(fixture.runDir, "plans/revision-2.md"), planText);
    await writeFile(join(fixture.runDir, requestPath), serializePlanApprovalRequest(request));
    await writeFile(join(fixture.runDir, "manifest.json"), `${JSON.stringify({
      ...manifest,
      stage: "awaiting_plan_approval",
      controller_provenance: historicalController,
      pending_plan_approval: {
        schema_version: 1,
        proposed_revision: 2,
        base_revision: 1,
        request_path: requestPath,
        request_sha256: requestSha256(request),
        approval_subject_sha256: request.approval_subject_sha256,
      },
      plan_revisions: {
        ...manifest.plan_revisions,
        "2": {
          revision: 2,
          path: "plans/revision-2.md",
          sha256: planSha256,
          origin: "replan",
          base_revision: 1,
          approval_request_path: requestPath,
          approval_request_sha256: requestSha256(request),
          approval_subject_sha256: request.approval_subject_sha256,
          decision_contract_sha256: planDecisionContractSha256(proposedPlan),
          acceptance_criteria: derivePlanAcceptanceCriteria(proposedPlan),
        },
      },
      approval_protocol_version: 1,
      approval_protocol_start_revision: 2,
      run_configuration_sha256: createHash("sha256").update(serializeRunConfiguration(runConfiguration)).digest("hex"),
      last_blocker: "Plan revision 2 requires explicit approval",
    }, null, 2)}\n`);

    const snapshot = await loadApprovedRuntimeSnapshot(fixture.runDir, config);

    expect(snapshot?.plan.summary).toBe(fixture.plan.summary);
    expect(snapshot?.manifest.pending_plan_approval?.proposed_revision).toBe(2);
    expect(snapshot?.config.profiles.hands.model).toBe(fixture.intake.roles.hands.model);
  });

  it.each([
    { mode: "local" as const, pointerKind: "null" as const },
    { mode: "local" as const, pointerKind: "pending" as const },
    { mode: "github" as const, pointerKind: "null" as const },
    { mode: "github" as const, pointerKind: "pending" as const },
  ])("rejects a combined $mode/$pointerKind pinned-authority downgrade before effects", async ({ mode, pointerKind }) => {
    const fixture = await approvedPinnedRuntime(mode);
    if (pointerKind === "pending") await addPendingModernReplan(fixture);
    const manifestPath = join(fixture.runDir, "manifest.json");
    const manifest = await readManifestV2(fixture.runDir);
    const revision = manifest.plan_revisions["1"]!;
    const changedPlan = { ...fixture.plan, summary: "Tampered plan with rewritten digest" };
    const changedPlanText = serializePersistedPlan(changedPlan, manifest.workflow_protocol);
    const changedPlanSha256 = createHash("sha256").update(changedPlanText).digest("hex");
    await writeFile(join(fixture.runDir, "plans/revision-1.md"), changedPlanText);
    const strippedRevision = {
      revision: revision.revision,
      path: revision.path,
      sha256: changedPlanSha256,
      ...(revision.acceptance_criteria === undefined ? {} : { acceptance_criteria: revision.acceptance_criteria }),
    };
    const pending = pointerKind === "pending" ? manifest.pending_plan_approval : null;
    await writeFile(manifestPath, `${JSON.stringify({
      ...manifest,
      run_configuration_sha256: null,
      plan_revisions: { ...manifest.plan_revisions, "1": strippedRevision },
      pending_plan_approval: pending,
    }, null, 2)}\n`);
    let bootstrapCalls = 0;
    let handsCalls = 0;
    let progressCalls = 0;
    let githubCalls = 0;
    const github = new Proxy({}, {
      get: () => async () => { githubCalls += 1; throw new Error("GitHub must not run"); },
    });
    const before = await snapshotRunFiles(fixture.runDir);

    const localInput = {
      runDir: fixture.runDir,
      worktreePath: fixture.worktreePath,
      intake: fixture.intake,
      plan: changedPlan,
      codex: {} as never,
      progress: {
        path: join(fixture.runDir, "progress.jsonl"), sessionId: "corrupt", workerPid: process.pid,
        emit: async () => { progressCalls += 1; return null; },
      },
      dependencies: {
        controllerBootstrap: async () => { bootstrapCalls += 1; return {} as never; },
        hands: async () => { handsCalls += 1; throw new Error("Hands must not run"); },
      },
    };
    const execute = () => mode === "local"
      ? runLocalWorkflow(localInput)
      : runGithubWorkflow({
          ...localInput,
          repoRoot: root!,
          branchName: fixture.branchName,
          dependencies: { ...localInput.dependencies, github: github as never },
        });
    await expect(execute()).rejects.toThrow(/approval protocol version 1.*exact revision metadata|exact approval start.*complete exact metadata/i);
    expect(bootstrapCalls).toBe(0);
    expect(handsCalls).toBe(0);
    expect(progressCalls).toBe(0);
    expect(githubCalls).toBe(0);
    expect(await snapshotRunFiles(fixture.runDir)).toEqual(before);
  });

  it("keeps rich approval events authoritative after every canonical modern artifact marker is stripped", async () => {
    const fixture = await approvedPinnedRuntime();
    const original = await stripInitialPinnedManifestMarkers(fixture);
    await rm(join(fixture.runDir, "run-configuration.json"));
    await rm(join(fixture.runDir, original.plan_revisions["1"]!.approval_request_path!));
    let progressCalls = 0;
    let handsCalls = 0;
    const before = await snapshotRunFiles(fixture.runDir);

    const result = await runLocalWorkflow({
      runDir: fixture.runDir,
      worktreePath: fixture.worktreePath,
      intake: fixture.intake,
      plan: fixture.plan,
      codex: {} as never,
      progress: {
        path: join(fixture.runDir, "progress.jsonl"), sessionId: "rich-event", workerPid: process.pid,
        emit: async () => { progressCalls += 1; return null; },
      },
      dependencies: { hands: async () => { handsCalls += 1; throw new Error("Hands must not run"); } },
    });

    expect(result.status).toBe("human_action_required");
    expect(result.blocker).toMatch(/immutable plan approval|run configuration|approval evidence|protocol marker/i);
    expect(progressCalls).toBe(0);
    expect(handsCalls).toBe(0);
    expect(await snapshotRunFiles(fixture.runDir)).toEqual(before);
    expect((await readOperatorStatus(fixture.runDir)).operator_state).toBe("operationally_blocked");
    expect((await readRunLog(fixture.runDir)).status.operator_state).toBe("operationally_blocked");
    expect(await snapshotRunFiles(fixture.runDir)).toEqual(before);
  });

  it("keeps a genuine legacy approval event without modern artifacts on the legacy path", async () => {
    const fixture = await approvedLegacyRuntime();
    const input = {
      runDir: fixture.runDir,
      worktreePath: fixture.worktreePath,
      intake: fixture.intake,
      plan: fixture.plan,
      codex: {} as never,
    };

    expect(await bindApprovedRuntimeAuthority(input)).toEqual(input);
    expect((await readOperatorStatus(fixture.runDir)).operator_state).not.toBe("operationally_blocked");
    expect((await readRunLog(fixture.runDir)).status.operator_state).not.toBe("operationally_blocked");
    expect(await readManifestV2(fixture.runDir)).toMatchObject({
      workflow_protocol: "legacy-v2",
      approval_protocol_version: null,
      approval_protocol_start_revision: null,
      run_configuration_sha256: null,
    });
    await expect(access(join(fixture.runDir, "run-configuration.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(fixture.runDir, "approvals/plan/revision-1.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a forged local caller checkout for a genuine legacy approval before Hands", async () => {
    const fixture = await approvedLegacyRuntime();
    const forgedWorktree = join(root!, "forged-worktree");
    await mkdir(forgedWorktree);
    let handsCalls = 0;

    const result = await runLocalWorkflow({
      runDir: fixture.runDir,
      worktreePath: forgedWorktree,
      intake: fixture.intake,
      plan: fixture.plan,
      codex: {} as never,
      dependencies: { hands: async () => { handsCalls += 1; throw new Error("Hands must not run"); } },
    });

    expect(result.status).toBe("human_action_required");
    expect(result.blocker).toMatch(/caller worktree.*canonical manifest checkout/i);
    expect(handsCalls).toBe(0);
    expect((await readManifestV2(fixture.runDir)).execution_lease).toBeNull();
  });

  it("rejects a forged GitHub caller branch for a genuine legacy approval before effects", async () => {
    const fixture = await approvedLegacyRuntime("github");
    let handsCalls = 0;
    let githubCalls = 0;
    const github = new Proxy({}, {
      get: () => async () => { githubCalls += 1; throw new Error("GitHub must not run"); },
    });

    const result = await runGithubWorkflow({
      runDir: fixture.runDir,
      repoRoot: root!,
      worktreePath: fixture.worktreePath,
      branchName: "codex/forged",
      intake: fixture.intake,
      plan: fixture.plan,
      codex: {} as never,
      dependencies: {
        github: github as never,
        hands: async () => { handsCalls += 1; throw new Error("Hands must not run"); },
      },
    });

    expect(result.status).toBe("human_action_required");
    expect(result.blocker).toMatch(/caller branch.*canonical manifest branch/i);
    expect(handsCalls).toBe(0);
    expect(githubCalls).toBe(0);
    expect((await readManifestV2(fixture.runDir)).execution_lease).toBeNull();
  });

  it.each(["malformed", "duplicate", "conflicting"] as const)("rejects %s rich approval-event provenance", async (kind) => {
    const fixture = await approvedPinnedRuntime();
    const original = await stripInitialPinnedManifestMarkers(fixture);
    await rm(join(fixture.runDir, "run-configuration.json"));
    await rm(join(fixture.runDir, original.plan_revisions["1"]!.approval_request_path!));
    await rewriteModernApprovalEvents(fixture.runDir, (event) => {
      if (kind === "duplicate") return [event, event];
      if (kind === "conflicting") return [{ ...event, run_id: "different-run" }];
      return [{ ...event, payload: { ...(event.payload as Record<string, unknown>), request_sha256: "invalid" } }];
    });
    const before = await snapshotRunFiles(fixture.runDir);

    await expect(bindApprovedRuntimeAuthority({
      runDir: fixture.runDir,
      worktreePath: fixture.worktreePath,
      intake: fixture.intake,
      plan: fixture.plan,
      codex: {} as never,
    })).rejects.toThrow(/modern plan approval event|duplicate modern plan approval event/i);
    expect(await snapshotRunFiles(fixture.runDir)).toEqual(before);
  });
  it.each(["intake research", "manifest roles", "selected manifest roles", "manifest backup"] as const)("rejects %s drift at the approval boundary", async (kind) => {
    const fixture = await approvedPinnedRuntime("local", false);
    if (kind === "intake research") {
      const path = join(fixture.runDir, "intake.json");
      const persisted = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
      await writeFile(path, `${JSON.stringify({ ...persisted, research: true }, null, 2)}\n`);
    } else {
      const path = join(fixture.runDir, "manifest.json");
      const persisted = await readManifestV2(fixture.runDir);
      const changed = kind === "manifest roles"
        ? { ...persisted, role_profiles: { ...persisted.role_profiles, hands: { ...persisted.role_profiles.hands!, model: "drifted-hands" } } }
        : kind === "selected manifest roles"
          ? { ...persisted, selected_role_profiles: { ...persisted.selected_role_profiles, hands: { ...persisted.selected_role_profiles.hands!, model: "drifted-hands" } } }
        : { ...persisted, hands_backup_policy: { fallback_on_primary_usage_limit: true, max_quality_recovery_attempts: 1, profile: { model: "backup", reasoning_effort: "medium" } } };
      await writeFile(path, `${JSON.stringify(changed, null, 2)}\n`);
    }

    await expect(approvePlanRevision(fixture.runDir, 1, {
      actor: "human",
      approvalControllerCapture: async () => ({ provenance: controller, selfHosting: false }),
    })).rejects.toThrow(/run configuration authority.*snapshots/i);
    expect((await readManifestV2(fixture.runDir)).approved_revision).toBeNull();
  });

  it.each(["missing", "noncanonical", "digest drift"] as const)("fails closed for %s run configuration evidence", async (kind) => {
    const fixture = await approvedPinnedRuntime();
    const path = join(fixture.runDir, "run-configuration.json");
    if (kind === "missing") await rm(path);
    if (kind === "noncanonical") await writeFile(path, `${await readFile(path, "utf8")} `);
    if (kind === "digest drift") {
      await writeFile(path, serializeRunConfiguration({ ...fixture.runConfiguration, reflection: true }));
    }
    let bootstrapCalls = 0;
    let handsCalls = 0;
    const before = await snapshotRunFiles(fixture.runDir);

    const result = await runLocalWorkflow({
      runDir: fixture.runDir,
      worktreePath: fixture.worktreePath,
      intake: fixture.intake,
      plan: fixture.plan,
      codex: {} as never,
      dependencies: {
        controllerBootstrap: async () => { bootstrapCalls += 1; return {} as never; },
        hands: async () => { handsCalls += 1; throw new Error("Hands must not run"); },
      },
    });

    expect(result.status).toBe("human_action_required");
    expect(result.blocker).toMatch(/run[- ]configuration|runtime execution|ENOENT/i);
    expect(bootstrapCalls).toBe(0);
    expect(handsCalls).toBe(0);
    expect(await snapshotRunFiles(fixture.runDir)).toEqual(before);
    expect(await readOperatorStatus(fixture.runDir)).toMatchObject({
      operator_state: "operationally_blocked",
      blocker: expect.stringMatching(/^Status provenance invalid: .*run-configuration|^Status provenance invalid: .*Run configuration/i),
    });
    expect((await readRunLog(fixture.runDir)).status.operator_state).toBe("operationally_blocked");
    expect(await snapshotRunFiles(fixture.runDir)).toEqual(before);
  });

  it.each(["plan", "summary", "research", "bootstrap", "worktree"] as const)("rejects caller-supplied %s authority before effects", async (kind) => {
    const fixture = await approvedPinnedRuntime();
    const callerPlan = kind === "plan"
      ? { ...fixture.plan, architecture: "caller-modified" }
      : kind === "summary"
        ? { ...fixture.plan, summary: "caller-modified summary" }
        : kind === "research"
          ? { ...fixture.plan, research_sources: ["repository", "caller-source"] }
      : kind === "bootstrap"
        ? { ...fixture.plan, controller_bootstrap: {
            version: 1 as const,
            baseline_commit: "1".repeat(40),
            preserved_head: "2".repeat(40),
            source_worktree: ".brain-hands/worktrees/forged",
            commit_message: "forged bootstrap",
            files: [{ path: "src/forged.ts", source_status: "tracked" as const, sha256: "3".repeat(64) }],
          } }
        : fixture.plan;
    let bootstrapCalls = 0;
    let handsCalls = 0;
    const before = await snapshotRunFiles(fixture.runDir);
    const result = await runLocalWorkflow({
      runDir: fixture.runDir,
      worktreePath: kind === "worktree" ? join(root!, "other-worktree") : fixture.worktreePath,
      intake: fixture.intake,
      plan: callerPlan,
      codex: {} as never,
      dependencies: {
        controllerBootstrap: async () => { bootstrapCalls += 1; return {} as never; },
        hands: async () => { handsCalls += 1; throw new Error("Hands must not run"); },
      },
    });

    expect(result.status).toBe("human_action_required");
    expect(result.blocker).toMatch(/caller (plan|worktree)|approved recorded plan|canonical manifest checkout/i);
    expect(bootstrapCalls).toBe(0);
    expect(handsCalls).toBe(0);
    expect(await snapshotRunFiles(fixture.runDir)).toEqual(before);
  });

  it("replaces mutable caller roles and retry policy with the approved configuration snapshot", async () => {
    const fixture = await approvedPinnedRuntime();
    const driftedConfig = defaultConfig();
    driftedConfig.profiles.hands = { ...driftedConfig.profiles.hands, model: "drifted-hands" };
    driftedConfig.retry_policy.max_hands_fix_attempts = 99;
    driftedConfig.retry_policy.quality_gate = undefined;
    const bound = await bindApprovedRuntimeAuthority({
      runDir: fixture.runDir,
      worktreePath: fixture.worktreePath,
      intake: {
        ...fixture.intake,
        roles: { ...fixture.intake.roles, hands: { ...fixture.intake.roles.hands, model: "drifted-hands" } },
      },
      plan: fixture.plan,
      codex: {} as never,
      config: driftedConfig,
    });

    expect(bound.intake.roles).toEqual(fixture.intake.roles);
    expect(bound.config?.profiles).toEqual(fixture.intake.roles);
    expect(bound.config?.retry_policy.max_hands_fix_attempts).toBe(fixture.runConfiguration.limits.max_hands_fix_attempts);
    expect(bound.config?.retry_policy.quality_gate).toEqual(fixture.runConfiguration.limits.quality_gate ?? undefined);
  });

  it("replaces every caller-controlled Codex transport setting with controller-owned defaults", async () => {
    const fixture = await approvedPinnedRuntime();
    const driftedConfig = defaultConfig();
    driftedConfig.codex = {
      command: "/tmp/forged-codex",
      timeout_seconds: 1,
      isolate_user_config: false,
      args_template: ["forged", "{{model}}"],
      prompt_transport: "file",
      prompt_file_flag: "--forged-prompt",
    };

    const callerAdapter = new SubprocessCodexAdapter(driftedConfig, fixture.worktreePath, async () => {});
    const bound = await bindApprovedRuntimeAuthority({
      runDir: fixture.runDir,
      worktreePath: fixture.worktreePath,
      intake: fixture.intake,
      plan: fixture.plan,
      codex: callerAdapter,
      config: driftedConfig,
    });

    expect(bound.config?.codex).toEqual(defaultConfig().codex);
    expect(bound.codex).toBeInstanceOf(SubprocessCodexAdapter);
    expect(bound.codex).not.toBe(callerAdapter);
  });

  it.each([
    ["runLocalWorkflow", runLocalWorkflow],
    ["executeLocalWorkflow", executeLocalWorkflow],
    ["runLocal", runLocal],
    ["runWorkflow(local)", runWorkflow],
  ] as const)("checks controller provenance at the direct %s entry before progress or effects", async (_name, entrypoint) => {
    const fixture = await approvedPinnedRuntime();
    let progressCalls = 0;
    let handsCalls = 0;
    vi.spyOn(controllerProvenance, "assertCurrentControllerMatches")
      .mockRejectedValueOnce(new Error("controller mismatch"));
    const before = await snapshotRunFiles(fixture.runDir);

    await expect(entrypoint({
      runDir: fixture.runDir,
      worktreePath: fixture.worktreePath,
      intake: fixture.intake,
      plan: fixture.plan,
      codex: {} as never,
      progress: {
        path: join(fixture.runDir, "progress.jsonl"), sessionId: "controller", workerPid: process.pid,
        emit: async () => { progressCalls += 1; return null; },
      },
      dependencies: { hands: async () => { handsCalls += 1; throw new Error("Hands must not run"); } },
    })).rejects.toThrow(/controller mismatch/i);

    expect(progressCalls).toBe(0);
    expect(handsCalls).toBe(0);
    expect(await snapshotRunFiles(fixture.runDir)).toEqual(before);
  });

  it.each([
    ["runGithubWorkflow", runGithubWorkflow],
    ["executeGithubWorkflow", executeGithubWorkflow],
    ["runWorkflow(github)", runWorkflow],
  ] as const)("checks controller provenance at the direct %s entry before progress or effects", async (_name, entrypoint) => {
    const fixture = await approvedPinnedRuntime("github");
    let progressCalls = 0;
    let githubCalls = 0;
    const github = new Proxy({}, {
      get: () => async () => { githubCalls += 1; throw new Error("GitHub must not run"); },
    });
    vi.spyOn(controllerProvenance, "assertCurrentControllerMatches")
      .mockRejectedValueOnce(new Error("controller mismatch"));
    const before = await snapshotRunFiles(fixture.runDir);

    await expect(entrypoint({
      runDir: fixture.runDir,
      repoRoot: root!,
      worktreePath: fixture.worktreePath,
      branchName: fixture.branchName,
      intake: fixture.intake,
      plan: fixture.plan,
      codex: {} as never,
      progress: {
        path: join(fixture.runDir, "progress.jsonl"), sessionId: "controller", workerPid: process.pid,
        emit: async () => { progressCalls += 1; return null; },
      },
      dependencies: { github: github as never },
    })).rejects.toThrow(/controller mismatch/i);

    expect(progressCalls).toBe(0);
    expect(githubCalls).toBe(0);
    expect(await snapshotRunFiles(fixture.runDir)).toEqual(before);
  });

  it("rejects a GitHub caller checkout before bootstrap, Hands, or GitHub mutation", async () => {
    const fixture = await approvedPinnedRuntime("github");
    const manifest = await readManifestV2(fixture.runDir);
    await updateManifestV2(fixture.runDir, {
      github_ids: { ...manifest.github_ids, issue_numbers: [7] },
    });
    let bootstrapCalls = 0;
    let handsCalls = 0;
    let githubCalls = 0;
    const github = new Proxy({}, {
      get: () => async () => { githubCalls += 1; throw new Error("GitHub must not run"); },
    });
    const before = await snapshotRunFiles(fixture.runDir);

    const result = await runGithubWorkflow({
      runDir: fixture.runDir,
      repoRoot: root!,
      worktreePath: join(root!, "other-worktree"),
      branchName: fixture.branchName,
      intake: fixture.intake,
      plan: fixture.plan,
      codex: {} as never,
      dependencies: {
        github: github as never,
        controllerBootstrap: async () => { bootstrapCalls += 1; return {} as never; },
        hands: async () => { handsCalls += 1; throw new Error("Hands must not run"); },
      },
    });

    expect(result.status).toBe("human_action_required");
    expect(result.blocker).toMatch(/canonical manifest checkout/i);
    expect(bootstrapCalls).toBe(0);
    expect(handsCalls).toBe(0);
    expect(githubCalls).toBe(0);
    expect(await snapshotRunFiles(fixture.runDir)).toEqual(before);
  });

  it.each(["symlink", "missing", "wrong_branch", "wrong_repository", "unrelated_head"] as const)("rejects a %s replacement of the pinned checkout before effects", async (kind) => {
    const fixture = await approvedPinnedRuntime("local");
    if (kind === "symlink") {
      const displaced = `${fixture.worktreePath}-displaced`;
      await rename(fixture.worktreePath, displaced);
      await symlink(displaced, fixture.worktreePath, "dir");
    } else if (kind === "missing") {
      execFileSync("git", ["worktree", "remove", "--force", fixture.worktreePath], { cwd: root! });
    } else if (kind === "wrong_branch") {
      execFileSync("git", ["checkout", "-b", "forged-branch"], { cwd: fixture.worktreePath });
    } else if (kind === "wrong_repository") {
      execFileSync("git", ["worktree", "remove", "--force", fixture.worktreePath], { cwd: root! });
      await mkdir(fixture.worktreePath, { recursive: true });
      execFileSync("git", ["init"], { cwd: fixture.worktreePath });
      execFileSync("git", ["config", "user.name", "Codex Test"], { cwd: fixture.worktreePath });
      execFileSync("git", ["config", "user.email", "codex@example.com"], { cwd: fixture.worktreePath });
      await writeFile(join(fixture.worktreePath, "README.md"), "independent fixture\n");
      execFileSync("git", ["add", "README.md"], { cwd: fixture.worktreePath });
      execFileSync("git", ["commit", "-m", "independent fixture"], { cwd: fixture.worktreePath });
      execFileSync("git", ["checkout", "-b", fixture.branchName], { cwd: fixture.worktreePath });
    } else {
      execFileSync("git", ["checkout", "--orphan", "unrelated-head"], { cwd: fixture.worktreePath });
      execFileSync("git", ["rm", "-rf", "."], { cwd: fixture.worktreePath });
      await writeFile(join(fixture.worktreePath, "ORPHAN.md"), "unrelated history\n");
      execFileSync("git", ["add", "ORPHAN.md"], { cwd: fixture.worktreePath });
      execFileSync("git", ["commit", "-m", "unrelated history"], { cwd: fixture.worktreePath });
      execFileSync("git", ["branch", "-M", fixture.branchName], { cwd: fixture.worktreePath });
    }
    let handsCalls = 0;

    const operation = runLocalWorkflow({
      runDir: fixture.runDir,
      worktreePath: fixture.worktreePath,
      intake: fixture.intake,
      plan: fixture.plan,
      codex: {} as never,
      dependencies: { hands: async () => { handsCalls += 1; throw new Error("Hands must not run"); } },
    });

    const result = await operation;

    expect(result.status).toBe("human_action_required");
    expect(result.blocker).toMatch(/checkout|worktree|symbolic link|branch|source commit/i);
    expect(handsCalls).toBe(0);
    expect((await readManifestV2(fixture.runDir)).execution_lease).toBeNull();
  });

  it.each(["stage", "selected_roles"] as const)("blocks all effects when %s authority changes after the last approved bind", async (kind) => {
    const fixture = await approvedPinnedRuntime("local");
    const manifestPath = join(fixture.runDir, "manifest.json");
    let handsCalls = 0;
    let bootstrapCalls = 0;
    const checkoutBefore = await readFile(join(fixture.worktreePath, "README.md"), "utf8");

    await expect(runLocalWorkflow({
      runDir: fixture.runDir,
      worktreePath: fixture.worktreePath,
      intake: fixture.intake,
      plan: fixture.plan,
      codex: {} as never,
      dependencies: {
        afterCheckpoint: async (checkpoint) => {
          if (checkpoint !== "after_initial_runtime_authority_bind") return;
          const current = await readManifestV2(fixture.runDir);
          const changed = kind === "stage"
            ? { ...current, stage: "implementing" as const }
            : {
                ...current,
                selected_role_profiles: {
                  ...current.selected_role_profiles,
                  hands: { ...current.selected_role_profiles.hands!, model: "forged-post-bind-model" },
                },
              };
          await writeFile(manifestPath, `${JSON.stringify(changed, null, 2)}\n`);
        },
        controllerBootstrap: async () => { bootstrapCalls += 1; return {} as never; },
        hands: async () => { handsCalls += 1; throw new Error("Hands must not run"); },
      },
    })).rejects.toThrow(/execution lease authority|authority changed/i);

    expect(bootstrapCalls).toBe(0);
    expect(handsCalls).toBe(0);
    expect(await readFile(join(fixture.worktreePath, "README.md"), "utf8")).toBe(checkoutBefore);
  });

  it.each(["remote", "branch"] as const)("rejects a forged GitHub %s before progress or external effects", async (kind) => {
    const fixture = await approvedPinnedRuntime("github", true, "upstream");
    let progressCalls = 0;
    let githubCalls = 0;
    const github = new Proxy({}, {
      get: () => async () => { githubCalls += 1; throw new Error("GitHub must not run"); },
    });
    const before = await snapshotRunFiles(fixture.runDir);

    const result = await runGithubWorkflow({
      runDir: fixture.runDir,
      repoRoot: root!,
      worktreePath: fixture.worktreePath,
      branchName: kind === "branch" ? "codex/forged" : fixture.branchName,
      remote: kind === "remote" ? "origin" : "upstream",
      intake: fixture.intake,
      plan: fixture.plan,
      codex: {} as never,
      progress: {
        path: join(fixture.runDir, "progress.jsonl"), sessionId: "authority", workerPid: process.pid,
        emit: async () => { progressCalls += 1; return null; },
      },
      dependencies: { github: github as never },
    });

    expect(result.status).toBe("human_action_required");
    expect(result.blocker).toMatch(/remote|branch/i);
    expect(progressCalls).toBe(0);
    expect(githubCalls).toBe(0);
    expect(await snapshotRunFiles(fixture.runDir)).toEqual(before);
  });

  it("rebinds an omitted GitHub remote to the approved non-origin remote", async () => {
    const fixture = await approvedPinnedRuntime("github", true, "upstream");
    const bound = await bindApprovedRuntimeAuthority<RunGithubWorkflowInput>({
      runDir: fixture.runDir,
      repoRoot: root!,
      worktreePath: fixture.worktreePath,
      branchName: fixture.branchName,
      intake: fixture.intake,
      plan: fixture.plan,
      codex: {} as never,
      dependencies: { github: {} as never },
    });
    expect(bound.remote).toBe("upstream");
  });

  it("publishes direct status to the canonical approved-plan issue despite a reordered caller plan", async () => {
    const canonicalPlan: BrainPlan = {
      summary: "Canonical publication order",
      assumptions: [],
      research: [],
      research_sources: ["repository"],
      architecture: "Publish from approved authority.",
      risks: [],
      work_items: [executionSpec("A"), executionSpec("B")],
      integration_verification: [["true"]],
    };
    const fixture = await approvedPinnedRuntime("github", true, "origin", true, canonicalPlan);
    const manifest = await updateManifestV2(fixture.runDir, {
      stage: "implementing",
      current_work_item_id: "B",
      issue_numbers: [11, 22],
      github_ids: { ...(await readManifestV2(fixture.runDir)).github_ids, issue_numbers: [11, 22] },
      work_item_progress: {
        A: { status: "pending", attempts: 0 },
        B: { status: "in_progress", attempts: 1 },
      },
    });
    const targets: number[] = [];
    const result = await publishGithubWorkflowStatus({
      runDir: fixture.runDir,
      plan: { ...canonicalPlan, work_items: [...canonicalPlan.work_items].reverse() },
      dependencies: {
        github: {
          upsertRunStatus: async (target: { number: number }) => { targets.push(target.number); },
        } as never,
      },
    }, {
      status: "human_action_required",
      manifest,
      orderedWorkItems: [],
      implementationResults: {},
      verification: {},
      reviews: {},
      blocker: "Awaiting canonical status publication",
    });

    expect(result.status).toBe("human_action_required");
    expect(targets).toEqual([22]);
  });

  it("leases direct GitHub status publication for an initial pending approval boundary", async () => {
    const fixture = await approvedPinnedRuntime("github", false, "origin", false);
    const manifest = await updateManifestV2(fixture.runDir, {
      issue_numbers: [11],
      github_ids: {
        ...(await readManifestV2(fixture.runDir)).github_ids,
        issue_numbers: [11],
        parent_issue_number: 11,
      },
    });
    let observedMode: string | null = null;

    const published = await publishGithubWorkflowStatus({
      runDir: fixture.runDir,
      plan: fixture.plan,
      dependencies: {
        github: {
          upsertRunStatus: async () => {
            observedMode = (await readManifestV2(fixture.runDir)).execution_lease?.mode ?? null;
          },
        } as never,
      },
    }, {
      status: "human_action_required",
      manifest,
      orderedWorkItems: [],
      implementationResults: {},
      verification: {},
      reviews: {},
      blocker: "Initial plan approval required",
    });

    expect(observedMode, published.blocker).toBe("initial_pending_publication");
    expect((await readManifestV2(fixture.runDir)).execution_lease).toBeNull();
  });

  it.each([
    { label: "initial pending", initial: true },
    { label: "pending replan", initial: false },
  ])("rejects commands under the $label publication-only lease before spawn", async ({ initial }) => {
    const fixture = await approvedPinnedRuntime("github", !initial, "origin", !initial);
    if (!initial) await addPendingModernReplan(fixture);
    const markerPath = join(root!, `publication-command-${initial ? "initial" : "replan"}.txt`);
    let started = false;

    await expect(withRunExecutionLease(fixture.runDir, () => runCommand({
      command: process.execPath,
      args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'spawned')`],
      cwd: root!,
      timeoutMs: 10_000,
      onStarted: () => { started = true; },
    }))).rejects.toThrow(/publication.*status|status.*publication/i);

    expect(started).toBe(false);
    await expect(access(markerPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readManifestV2(fixture.runDir)).execution_lease).toBeNull();
  });

  it.each([
    { mode: "local" as const, alias: "current_plan_revision" as const },
    { mode: "local" as const, alias: "approved_plan_revision" as const },
    { mode: "github" as const, alias: "current_plan_revision" as const },
    { mode: "github" as const, alias: "approved_plan_revision" as const },
  ])("rejects $alias drift before $mode progress, external effects, or run mutation", async ({ mode, alias }) => {
    const fixture = await approvedPinnedRuntime(mode);
    const path = join(fixture.runDir, "manifest.json");
    const persisted = await readManifestV2(fixture.runDir);
    await writeFile(path, `${JSON.stringify({ ...persisted, [alias]: null }, null, 2)}\n`);
    let progressCalls = 0;
    let bootstrapCalls = 0;
    let handsCalls = 0;
    let githubCalls = 0;
    const github = new Proxy({}, {
      get: () => async () => { githubCalls += 1; throw new Error("GitHub must not run"); },
    });
    const before = await snapshotRunFiles(fixture.runDir);

    const localInput = {
      runDir: fixture.runDir,
      worktreePath: fixture.worktreePath,
      intake: fixture.intake,
      plan: fixture.plan,
      codex: {} as never,
      progress: {
        path: join(fixture.runDir, "progress.jsonl"), sessionId: "authority", workerPid: process.pid,
        emit: async () => { progressCalls += 1; return null; },
      },
      dependencies: {
        controllerBootstrap: async () => { bootstrapCalls += 1; return {} as never; },
        hands: async () => { handsCalls += 1; throw new Error("Hands must not run"); },
      },
    };
    const result = mode === "local"
      ? await runLocalWorkflow(localInput)
      : await runGithubWorkflow({
          ...localInput,
          repoRoot: root!,
          branchName: fixture.branchName,
          dependencies: { ...localInput.dependencies, github: github as never },
        });

    expect(result.status).toBe("human_action_required");
    expect(result.blocker).toMatch(/plan revision aliases do not match/i);
    expect(progressCalls).toBe(0);
    expect(bootstrapCalls).toBe(0);
    expect(handsCalls).toBe(0);
    expect(githubCalls).toBe(0);
    expect(await snapshotRunFiles(fixture.runDir)).toEqual(before);
  });

  it("does not mask an independent manifest defect as recoverable alias drift", async () => {
    const fixture = await approvedPinnedRuntime();
    const path = join(fixture.runDir, "manifest.json");
    const persisted = await readManifestV2(fixture.runDir);
    await writeFile(path, `${JSON.stringify({
      ...persisted,
      approved_plan_revision: null,
      approval_protocol_version: null,
    }, null, 2)}\n`);
    let progressCalls = 0;
    const before = await snapshotRunFiles(fixture.runDir);

    await expect(runLocalWorkflow({
      runDir: fixture.runDir,
      worktreePath: fixture.worktreePath,
      intake: fixture.intake,
      plan: fixture.plan,
      codex: {} as never,
      progress: {
        path: join(fixture.runDir, "progress.jsonl"), sessionId: "authority", workerPid: process.pid,
        emit: async () => { progressCalls += 1; return null; },
      },
    })).rejects.toThrow(/approval protocol|revision aliases/i);

    expect(progressCalls).toBe(0);
    expect(await snapshotRunFiles(fixture.runDir)).toEqual(before);
  });

  it("rejects an approved exact run whose checkout was never durably pinned", async () => {
    const fixture = await approvedPinnedRuntime("github", true, "upstream", false);
    const manifest = await readManifestV2(fixture.runDir);
    const branchName = `codex/brain-hands/${manifest.run_id}`;
    const worktreePath = join(root!, ".brain-hands", "worktrees", manifest.run_id);
    const input: RunGithubWorkflowInput = {
      runDir: fixture.runDir,
      repoRoot: root!,
      worktreePath,
      branchName,
      intake: fixture.intake,
      plan: fixture.plan,
      codex: {} as never,
      dependencies: { github: {} as never },
    };

    await expect(bindApprovedRuntimeAuthority(input))
      .rejects.toThrow(/manifest checkout differs from the deterministic approved run worktree/i);
    await expect(bindApprovedRuntimeAuthority({ ...input, branchName: "codex/forged" }))
      .rejects.toThrow(/manifest checkout differs from the deterministic approved run worktree/i);
  });

  it.each(["absent", "present"] as const)("rejects a historical null-source checkout before %s worktree allocation", async (presence) => {
    const fixture = await approvedLegacyRuntime("local", false);
    const manifestPath = join(fixture.runDir, "manifest.json");
    const manifest = await readManifestV2(fixture.runDir);
    const worktreePath = join(root!, ".brain-hands", "worktrees", manifest.run_id);
    const branchName = `codex/brain-hands/${manifest.run_id}`;
    const exactRecord = {
      ...manifest.plan_revisions["1"]!,
      revision: 2,
      path: "plans/revision-2.md",
      origin: "replan" as const,
      base_revision: 1,
      approval_request_path: "approvals/plan/revision-2.json",
      approval_request_sha256: "a".repeat(64),
      approval_subject_sha256: "b".repeat(64),
      decision_contract_sha256: "c".repeat(64),
    };
    await writeFile(manifestPath, `${JSON.stringify({
      ...manifest,
      current_revision: 2,
      current_plan_revision: 2,
      approved_revision: 2,
      approved_plan_revision: 2,
      plan_revisions: { ...manifest.plan_revisions, "2": exactRecord },
      approval_protocol_version: 1,
      approval_protocol_start_revision: 2,
      run_configuration_sha256: "d".repeat(64),
      source_commit: null,
      worktree_path: null,
      branch_name: null,
    }, null, 2)}\n`);
    if (presence === "present") {
      await mkdir(worktreePath, { recursive: true });
      await writeFile(join(worktreePath, "sentinel"), "unchanged\n");
    }
    const before = await readFile(manifestPath, "utf8");

    await expect(runLocalWorkflow({
      runDir: fixture.runDir,
      worktreePath,
      intake: fixture.intake,
      plan: fixture.plan,
      codex: {} as never,
    })).rejects.toThrow(/pinned source commit before worktree allocation/i);

    expect(await readFile(manifestPath, "utf8")).toBe(before);
    expect(await access(worktreePath).then(() => true).catch(() => false)).toBe(presence === "present");
    if (presence === "present") expect(await readFile(join(worktreePath, "sentinel"), "utf8")).toBe("unchanged\n");
  });

  it.each(["absent", "present"] as const)("rejects incomplete historical pinned-source approval evidence when checkout is %s", async (presence) => {
    const fixture = await approvedLegacyRuntime("local", false);
    const sourceCommit = fixture.sourceCommit;
    const manifestPath = join(fixture.runDir, "manifest.json");
    const manifest = await readManifestV2(fixture.runDir);
    const worktreePath = join(root!, ".brain-hands", "worktrees", manifest.run_id);
    const branchName = `codex/brain-hands/${manifest.run_id}`;
    const exactRecord = {
      ...manifest.plan_revisions["1"]!, revision: 2, path: "plans/revision-2.md",
      origin: "replan" as const, base_revision: 1,
      approval_request_path: "approvals/plan/revision-2.json",
      approval_request_sha256: "a".repeat(64), approval_subject_sha256: "b".repeat(64),
      decision_contract_sha256: "c".repeat(64),
    };
    await writeFile(manifestPath, `${JSON.stringify({
      ...manifest,
      current_revision: 2, current_plan_revision: 2,
      approved_revision: 2, approved_plan_revision: 2,
      plan_revisions: { ...manifest.plan_revisions, "2": exactRecord },
      approval_protocol_version: 1, approval_protocol_start_revision: 2,
      run_configuration_sha256: "d".repeat(64), source_commit: sourceCommit,
      worktree_path: null, branch_name: null, checkout_allocation_state: null,
    }, null, 2)}\n`);
    if (presence === "present") {
      execFileSync("git", ["worktree", "add", "-b", branchName, worktreePath, sourceCommit], { cwd: root! });
    }

    await expect(runLocalWorkflow({
      runDir: fixture.runDir,
      worktreePath,
      intake: fixture.intake,
      plan: fixture.plan,
      codex: {} as never,
    })).rejects.toThrow(/approval directory is missing/i);
    expect(await readFile(manifestPath, "utf8")).toContain('"checkout_allocation_state": null');
  });

  it("blocks runtime and observational reads when selected role profiles drift", async () => {
    const fixture = await approvedPinnedRuntime();
    const path = join(fixture.runDir, "manifest.json");
    const persisted = await readManifestV2(fixture.runDir);
    await writeFile(path, `${JSON.stringify({
      ...persisted,
      selected_role_profiles: {
        ...persisted.selected_role_profiles,
        hands: { ...persisted.selected_role_profiles.hands!, model: "drifted-hands" },
      },
    }, null, 2)}\n`);
    const before = await snapshotRunFiles(fixture.runDir);

    const result = await runLocalWorkflow({
      runDir: fixture.runDir,
      worktreePath: fixture.worktreePath,
      intake: fixture.intake,
      plan: fixture.plan,
      codex: {} as never,
    });

    expect(result.status).toBe("human_action_required");
    expect(result.blocker).toMatch(/roles/i);
    expect(await readOperatorStatus(fixture.runDir)).toMatchObject({
      operator_state: "operationally_blocked",
      blocker: expect.stringMatching(/roles/i),
    });
    expect((await readRunLog(fixture.runDir)).status.operator_state).toBe("operationally_blocked");
    expect(await snapshotRunFiles(fixture.runDir)).toEqual(before);
  });
});
