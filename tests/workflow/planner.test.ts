import { access, readFile, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodexAdapter, CodexInvokeInput, CodexInvokeResult } from "../../src/adapters/codex.js";
import {
  approvePlanRevision,
  commitClaimedInitialPlan,
  persistClaimedInitialPlanCandidate,
  createRunLedgerV2,
  readManifestV2,
  transitionRun,
  updateManifestV2,
  withRunLedgerCompoundTransaction,
} from "../../src/core/ledger.js";
import { approveDiscoveryBrief, recordDiscoveryBrief, recordDiscoveryReadiness } from "../../src/core/discovery-ledger.js";
import type {
  BrainPlan,
  DiscoveryBrief,
  DiscoveredBrainPlan,
  PlanningDiscoveryGap,
  ResolvedRunIntake,
} from "../../src/core/types.js";
import { planRunV2 } from "../../src/workflow/planner.js";
import { claimBrainPlanning, releaseBrainPlanningClaim } from "../../src/workflow/brain-failure.js";
import { writeOwnedEvidenceFile } from "../../src/core/owned-evidence.js";
import { resumeRun } from "../../src/workflow/status.js";
import { executionSpec } from "../fixtures/execution-spec.js";
import { createLegacyRunLedgerV2 } from "../fixtures/legacy-run.js";
import { openProgressReporter, readProgressEvents } from "../../src/progress/log.js";
import * as ledgerModule from "../../src/core/ledger.js";
import { candidateSha256 } from "../../src/workflow/plan-repair.js";
import { checkPlanCandidate } from "../../src/workflow/plan-check.js";
const codexMetrics = { usage: null, durationMs: 0, processStarted: false, turnStarted: false, structuredTerminalError: false } as const;
import { CANONICAL_REVIEW_POLICY } from "../../src/core/config.js";
import {
  buildPlanApprovalRequest,
  planDecisionContractSha256,
  readVerifiedPlanApprovalRequest,
  requestSha256,
  serializePlanApprovalRequest,
} from "../../src/core/plan-approval.js";
import {
  resolvedRunConfigurationSchema,
  runConfigurationSha256,
} from "../../src/core/run-configuration.js";
import type { ControllerProvenance } from "../../src/core/types.js";
import { buildPlanDelta } from "../../src/workflow/plan-delta.js";

const approvedBrief: DiscoveryBrief = {
  revision: 1,
  goal: "Build the requested workflow",
  problem: "Planning must remain bound to approved discovery.",
  success_criteria: ["The approved decision is traceable into execution."],
  constraints: ["Preserve legacy planning behavior."],
  decisions: [{ id: "d-001", statement: "Use one focused implementation item.", source_question_ids: [] }],
  assumptions: [{
    id: "a-001",
    statement: "The existing test command is available in the repository.",
    source: "brain_inference",
    source_question_ids: [],
  }],
  selected_approach_id: null,
  selected_approach_rationale: null,
  out_of_scope: ["Documentation changes"],
  accepted_risks: [],
  repository_evidence: ["src/workflow/planner.ts"],
};

function validPlan(sha256 = "a".repeat(64)): DiscoveredBrainPlan {
  return {
    feature_slug: "planner-contract",
    parent_issue: null,
    summary: "Implement the requested change in one focused sequence.",
    assumptions: approvedBrief.assumptions.map((assumption) => assumption.statement),
    research: ["No external research is required for this task."],
    research_sources: ["repository source and tests"],
    architecture: "Keep the change inside the existing workflow boundary.",
    risks: ["A dependency may expose a different runtime shape than expected."],
    work_items: [executionSpec("item-1")],
    integration_verification: [["npm", "test", "--", "tests/workflow/planner.test.ts"]],
    discovery_brief_revision: approvedBrief.revision,
    discovery_brief_sha256: sha256,
    discovery_decision_coverage: [{
      decision_id: "d-001",
      work_item_ids: ["item-1"],
      acceptance_ids: ["item-1-AC-01"],
      verification_command_ids: ["item-1-VERIFY-01"],
      no_implementation_effect: null,
    }],
    accepted_risks: [...approvedBrief.accepted_risks],
    out_of_scope: [...approvedBrief.out_of_scope],
  };
}

function v2Plan(sha256 = "a".repeat(64)): BrainPlan {
  return {
    summary: "Implement the requested change in one focused sequence.",
    assumptions: [],
    research: [],
    research_sources: ["repository source and tests"],
    architecture: "Keep the change inside the existing workflow boundary.",
    risks: [],
    work_items: [executionSpec()],
    integration_verification: [["npm", "test"]],
    discovery_brief_revision: approvedBrief.revision,
    discovery_brief_sha256: sha256,
    discovery_decision_coverage: [{
      decision_id: "d-001",
      work_item_ids: ["item-1"],
      acceptance_ids: ["item-1-AC-01"],
      verification_command_ids: ["item-1-VERIFY-01"],
      no_implementation_effect: null,
    }],
    accepted_risks: [...approvedBrief.accepted_risks],
    out_of_scope: [...approvedBrief.out_of_scope],
  } as unknown as BrainPlan;
}

function resolvedIntake(research: boolean): ResolvedRunIntake {
  return {
    task: "Build the requested workflow",
    repo_root: "/tmp/repo",
    mode: "local",
    research,
    reflection: false,
    models: { brain: "brain-model", hands: "hands-model", verifier: "verifier-model" },
    resolved_models: { brain: "brain-model", hands: "hands-model", verifier: "verifier-model" },
    roles: {
      brain: { model: "brain-model", reasoning_effort: "high", sandbox: "read-only" },
      hands: { model: "hands-model", reasoning_effort: "medium", sandbox: "workspace-write" },
      verifier: { model: "verifier-model", reasoning_effort: "high", sandbox: "read-only" },
    },
  };
}

const recordedController: ControllerProvenance = {
  self_hosting: false,
  mode: "installed",
  executable_path: "/controller/dist/cli.js",
  package_root: "/controller",
  package_name: "@ngelik/brain-hands",
  package_version: "0.4.0",
  package_hash_algorithm: "sha256",
  package_hash: "a".repeat(64),
  candidate_commit: "b".repeat(40),
};

function plannerRunConfiguration(intake: ResolvedRunIntake, repository: string) {
  return resolvedRunConfigurationSchema.parse({
    version: 1,
    repository,
    mode: intake.mode,
    research: intake.research,
    reflection: intake.reflection,
    controller: {
      package_name: recordedController.package_name,
      package_version: recordedController.package_version,
      mode: recordedController.mode,
    },
    roles: {
      brain: { ...intake.roles.brain, source: "repository_config" },
      hands: { ...intake.roles.hands, source: "repository_config" },
      verifier: { ...intake.roles.verifier, source: "repository_config" },
    },
    hands_backup: null,
    limits: {
      max_hands_fix_attempts: 3,
      max_replan_attempts: 2,
      review_policy: intake.review_policy ?? CANONICAL_REVIEW_POLICY,
      quality_gate: null,
    },
    github: { effects: "none", default_remote: "origin" },
  });
}

class RecordingBrain implements CodexAdapter {
  readonly calls: CodexInvokeInput[] = [];

  constructor(
    private readonly plan: BrainPlan | DiscoveredBrainPlan | PlanningDiscoveryGap,
    private readonly persistOutput = false,
  ) {}

  async invoke(input: CodexInvokeInput): Promise<CodexInvokeResult> {
    this.calls.push(input);
    const outputSchema = input.outputSchema as { properties?: { result?: unknown } } | undefined;
    const response = outputSchema?.properties?.result === undefined
      ? this.plan
      : { result: this.plan };
    const text = `${JSON.stringify(response)}${this.persistOutput ? "" : "\n"}`;
    if (this.persistOutput) {
      await writeOwnedEvidenceFile(
        input.runDir,
        `responses/${input.artifactName}.json`,
        "responses/",
        text,
      );
    }
    return {
      text,
      parsed: input.outputParser?.parse(response) ?? response,
      exitCode: 0,
      promptPath: join(input.runDir, "prompts", `${input.artifactName}.md`),
      stdoutPath: join(input.runDir, "responses", `${input.artifactName}.stdout.txt`),
      stderrPath: join(input.runDir, "responses", `${input.artifactName}.stderr.txt`),
      ...codexMetrics,
    };
  }
}

let repoRoot: string | undefined;

afterEach(async () => {
  if (repoRoot) {
    await rm(repoRoot, { recursive: true, force: true });
    repoRoot = undefined;
  }
});

async function createPlanningLedger(intake: ResolvedRunIntake) {
  repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-planner-"));
  const runConfiguration = plannerRunConfiguration(intake, repoRoot);
  const ledger = await createRunLedgerV2({
    repoRoot,
    originalRequest: intake.task,
    slug: "structured-plan",
    intake: { ...intake, repo_root: repoRoot },
    roles: intake.roles,
    controllerProvenance: recordedController,
    sourceCommit: recordedController.candidate_commit,
    runConfiguration,
  });
  await transitionRun(ledger.runDir, "preflight", { actor: "test" });
  await transitionRun(ledger.runDir, "brain_discovery", { actor: "test" });
  await recordDiscoveryReadiness(ledger.runDir, { outcome: "no_discovery_needed", rationale: "Fixture ready.", repository_evidence: ["tests/workflow/planner.test.ts"], approaches: [], alternatives_omitted_reason: "No alternative.", brief: approvedBrief });
  await recordDiscoveryBrief(ledger.runDir, approvedBrief);
  await approveDiscoveryBrief(ledger.runDir, approvedBrief.revision);
  const manifest = await readManifestV2(ledger.runDir);
  return {
    ...ledger,
    approvedBriefSha256: manifest.discovery!.approved_brief_sha256!,
    runConfiguration,
  };
}

const captureRecordedController = async () => ({
  provenance: recordedController,
  selfHosting: false,
});

async function approveInitialPlan(runDir: string, revision = 1, hooks = {}) {
  return approvePlanRevision(runDir, revision, {
    actor: "human",
    approvalControllerCapture: captureRecordedController,
    transactionHooks: hooks,
  });
}

async function initialRequestFor(
  ledger: Awaited<ReturnType<typeof createPlanningLedger>>,
  plan: DiscoveredBrainPlan,
) {
  const manifest = await readManifestV2(ledger.runDir);
  const planText = `${JSON.stringify(plan, null, 2)}\n`;
  return buildPlanApprovalRequest({
    manifest,
    runConfiguration: ledger.runConfiguration,
    reasonCode: "initial_plan",
    revision: 1,
    baseRevision: null,
    planPath: "plans/revision-1.md",
    planSha256: createHash("sha256").update(planText).digest("hex"),
    decisionContractSha256: planDecisionContractSha256(plan),
    delta: buildPlanDelta(null, plan, { baseRevision: null, proposedRevision: 1 }),
  });
}

describe("planRunV2", () => {
  async function persistCandidate(runDir: string, invocationId: string, artifactName: string, plan: DiscoveredBrainPlan): Promise<void> {
    const value = {
      invocation_id: invocationId,
      artifact_name: artifactName,
      approved_discovery_brief_revision: plan.discovery_brief_revision,
      approved_discovery_brief_sha256: plan.discovery_brief_sha256,
      plan_text: `${JSON.stringify(plan, null, 2)}\n`,
      artifacts: {
        "research.md": `${plan.research.join("\n")}\n`,
        "research-sources.json": `${JSON.stringify(plan.research_sources, null, 2)}\n`,
        "architecture-plan.md": `${plan.architecture}\n`,
        "work-items.json": `${JSON.stringify(plan.work_items, null, 2)}\n`,
      },
    };
    await writeOwnedEvidenceFile(
      runDir,
      `plans/candidates/${invocationId}.json`,
      "plans/",
      `${JSON.stringify(value, null, 2)}\n`,
    );
  }

  it("blocks an old live-owner claim and reclaims only a provably dead owner", async () => {
    const intake = resolvedIntake(false);
    const ledger = await createPlanningLedger(intake);
    const oldClaim = await claimBrainPlanning({
      runDir: ledger.runDir,
      invocationId: "00000000-0000-4000-8000-000000000001",
      artifactName: "brain-plan-v2",
      ownerPid: process.pid,
      now: new Date("2000-01-01T00:00:00.000Z"),
    });
    const brain = new RecordingBrain(validPlan(ledger.approvedBriefSha256));
    await expect(planRunV2({ runDir: ledger.runDir, intake: { ...intake, repo_root: repoRoot! }, codex: brain }))
      .rejects.toThrow(/already claimed/);
    expect(brain.calls).toHaveLength(0);
    await updateManifestV2(ledger.runDir, { brain_controller_claim: { ...oldClaim, owner_pid: 2_147_483_647 } });
    await expect(planRunV2({ runDir: ledger.runDir, intake: { ...intake, repo_root: repoRoot! }, codex: brain }))
      .resolves.toMatchObject({ kind: "plan" });
    expect(brain.calls).toHaveLength(1);
  });
  it("allows only one concurrent planner claimant and one plan revision", async () => {
    const intake = resolvedIntake(false);
    const ledger = await createPlanningLedger(intake);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const brain = new RecordingBrain(validPlan(ledger.approvedBriefSha256));
    const originalInvoke = brain.invoke.bind(brain);
    brain.invoke = async (input) => { await gate; return originalInvoke(input); };
    const first = planRunV2({ runDir: ledger.runDir, intake: { ...intake, repo_root: repoRoot! }, codex: brain });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const second = planRunV2({ runDir: ledger.runDir, intake: { ...intake, repo_root: repoRoot! }, codex: brain });
    void second.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 50));
    release();
    const results = await Promise.allSettled([first, second]);
    expect(brain.calls).toHaveLength(1);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(await readManifestV2(ledger.runDir)).toMatchObject({ stage: "awaiting_plan_approval", current_revision: 1 });
  });
  it("commits a claimed plan and approval stage without a separate transition call", async () => {
    const intake = resolvedIntake(false);
    const ledger = await createPlanningLedger(intake);
    const transition = vi.spyOn(ledgerModule, "transitionRun").mockRejectedValue(new Error("separate transition must not run"));
    const result = await planRunV2({
      runDir: ledger.runDir,
      intake: { ...intake, repo_root: repoRoot! },
      codex: new RecordingBrain(validPlan(ledger.approvedBriefSha256)),
    });
    expect(result).toMatchObject({ kind: "plan", revision: { revision: 1 }, manifest: { stage: "awaiting_plan_approval" } });
    expect(transition).not.toHaveBeenCalled();
    await approveInitialPlan(ledger.runDir);
    await expect(planRunV2({
      runDir: ledger.runDir,
      intake: { ...intake, repo_root: repoRoot! },
      codex: new RecordingBrain(validPlan(ledger.approvedBriefSha256)),
    })).rejects.toThrow(/brain_planning/);
  });
  it("recovers one committed revision after a post-manifest fault", async () => {
    const intake = resolvedIntake(false);
    const ledger = await createPlanningLedger(intake);
    const invocationId = "00000000-0000-4000-8000-000000000099";
    const plan = validPlan(ledger.approvedBriefSha256);
    await claimBrainPlanning({ runDir: ledger.runDir, invocationId, artifactName: "faulted-plan" });
    await persistClaimedInitialPlanCandidate({
      runDir: ledger.runDir,
      invocation_id: invocationId,
      artifact_name: "faulted-plan",
      approved_discovery_brief_revision: approvedBrief.revision,
      approved_discovery_brief_sha256: ledger.approvedBriefSha256,
      plan_text: `${JSON.stringify(plan, null, 2)}\n`,
      artifacts: {
        "research.md": "\n",
        "research-sources.json": "[]\n",
        "architecture-plan.md": "durable architecture\n",
        "work-items.json": "[]\n",
      },
    });
    const request = {
      runDir: ledger.runDir,
      controllerClaimToken: invocationId,
      approvalRequest: await initialRequestFor(ledger, plan),
    };
    await expect(commitClaimedInitialPlan({
      ...request,
      approvalRequest: {
        ...request.approvalRequest,
        delta: {
          ...request.approvalRequest.delta,
          entries: request.approvalRequest.delta.entries.slice(1),
        },
      },
    })).rejects.toThrow(/delta|request/i);
    expect((await readManifestV2(ledger.runDir)).stage).toBe("brain_planning");
    expect(await readFile(join(ledger.runDir, "plans/revision-1.md"), "utf8").catch(() => null)).toBeNull();
    expect(await readFile(join(ledger.runDir, "approvals/plan/revision-1.json"), "utf8").catch(() => null)).toBeNull();
    await expect((async () => {
      await commitClaimedInitialPlan(request);
      throw new Error("post-manifest fault");
    })()).rejects.toThrow("post-manifest fault");
    expect(await readManifestV2(ledger.runDir)).toMatchObject({
      stage: "awaiting_plan_approval", current_revision: 1, brain_controller_claim: null,
    });
    await expect(commitClaimedInitialPlan({
      ...request,
      approvalRequest: {
        ...request.approvalRequest,
        delta: {
          ...request.approvalRequest.delta,
          entries: [...request.approvalRequest.delta.entries, {
            category: "risks",
            pointer: "/risks/0",
            operation: "replace",
            before: null,
            after: "drifted replay request",
          }],
        },
      },
    })).rejects.toThrow(/candidate-bound request/i);
    await expect(commitClaimedInitialPlan(request)).resolves.toMatchObject({
      revision: { revision: 1 }, manifest: { stage: "awaiting_plan_approval" },
    });
    const transitions = (await readFile(join(ledger.runDir, "events.jsonl"), "utf8"))
      .split("\n").filter(Boolean).map((line) => JSON.parse(line))
      .filter((event) => event.type === "transition" && event.stage === "awaiting_plan_approval");
    expect(transitions).toHaveLength(1);
  });

  it.each(["plan", "request"] as const)(
    "rejects an initial approval boundary with broken canonical %s bytes",
    async (brokenArtifact) => {
      const intake = resolvedIntake(false);
      const ledger = await createPlanningLedger(intake);
      const plan = validPlan(ledger.approvedBriefSha256);
      const planText = `${JSON.stringify(plan, null, 2)}\n`;
      const request = await initialRequestFor(ledger, plan);
      const manifest = await readManifestV2(ledger.runDir);
      const revision = {
        revision: 1,
        path: "plans/revision-1.md",
        sha256: request.subject.plan_sha256,
        origin: "initial" as const,
        base_revision: null,
        approval_request_path: "approvals/plan/revision-1.json",
        approval_request_sha256: requestSha256(request),
        approval_subject_sha256: request.approval_subject_sha256,
        decision_contract_sha256: request.subject.decision_contract_sha256,
      };
      const pending = {
        schema_version: 1 as const,
        proposed_revision: 1,
        base_revision: null,
        request_path: revision.approval_request_path,
        request_sha256: revision.approval_request_sha256,
        approval_subject_sha256: revision.approval_subject_sha256,
      };
      await writeFile(
        join(ledger.runDir, revision.path),
        brokenArtifact === "plan" ? "not-a-canonical-plan\n" : planText,
      );
      await writeFile(
        join(ledger.runDir, revision.approval_request_path),
        brokenArtifact === "request" ? "not-a-canonical-request\n" : serializePlanApprovalRequest(request),
      );

      await expect(withRunLedgerCompoundTransaction(ledger.runDir, (transaction) =>
        transaction.commitInitialPlanApprovalBoundary({
          revision,
          pending,
          expected_manifest: manifest,
        }))).rejects.toThrow(/plan|request|canonical|digest|json/i);
      expect((await readManifestV2(ledger.runDir)).stage).toBe("brain_planning");
    },
  );
  it("ignores later Brain replan boundaries when reconciling the claimed initial plan", async () => {
    const intake = resolvedIntake(false);
    const ledger = await createPlanningLedger(intake);
    const invocationId = "00000000-0000-4000-8000-000000000103";
    await claimBrainPlanning({ runDir: ledger.runDir, invocationId, artifactName: "initial-plan" });
    await persistCandidate(
      ledger.runDir,
      invocationId,
      "initial-plan",
      validPlan(ledger.approvedBriefSha256),
    );
    const request = {
      runDir: ledger.runDir,
      controllerClaimToken: invocationId,
      approvalRequest: await initialRequestFor(ledger, validPlan(ledger.approvedBriefSha256)),
    };
    await commitClaimedInitialPlan(request);
    const eventsPath = join(ledger.runDir, "events.jsonl");
    const events = await readFile(eventsPath, "utf8");
    const replanBoundary = {
      event_id: "00000000-0000-4000-8000-000000000104",
      run_id: ledger.manifest.run_id,
      stage: "awaiting_plan_approval",
      type: "transition",
      timestamp: new Date().toISOString(),
      actor: "brain",
      payload: {
        work_item_id: "work-item",
        base_plan_revision: 1,
        replan_patch_path: "replans/work-item-base-1-review-1.json",
      },
    };
    await writeFile(eventsPath, `${events}${JSON.stringify(replanBoundary)}\n`);

    await expect(commitClaimedInitialPlan(request)).resolves.toMatchObject({
      revision: { revision: 1 }, manifest: { stage: "awaiting_plan_approval" },
    });
  });
  it.each([false, true])(
    "resumes a claim-owned candidate after %s canonical promotion without invoking Brain",
    async (canonicalPromoted) => {
      const intake = resolvedIntake(false);
      const ledger = await createPlanningLedger(intake);
      const invocationId = canonicalPromoted
        ? "00000000-0000-4000-8000-000000000102"
        : "00000000-0000-4000-8000-000000000101";
      const artifactName = `crash-candidate-${canonicalPromoted ? "promoted" : "staged"}`;
      const plan = validPlan(ledger.approvedBriefSha256);
      await claimBrainPlanning({ runDir: ledger.runDir, invocationId, artifactName, ownerPid: 2_147_483_647 });
      await persistCandidate(ledger.runDir, invocationId, artifactName, plan);
      if (canonicalPromoted) {
        await writeOwnedEvidenceFile(ledger.runDir, "plans/revision-1.md", "plans/", `${JSON.stringify(plan, null, 2)}\n`);
      }
      const brain = new RecordingBrain(plan);

      await expect(planRunV2({
        runDir: ledger.runDir,
        intake: { ...intake, repo_root: repoRoot! },
        codex: brain,
      })).resolves.toMatchObject({ kind: "plan", revision: { revision: 1 } });
      expect(brain.calls).toHaveLength(0);
      expect(await readManifestV2(ledger.runDir)).toMatchObject({ stage: "awaiting_plan_approval", current_revision: 1 });
      const transitions = (await readFile(join(ledger.runDir, "events.jsonl"), "utf8"))
        .split("\n").filter(Boolean).map((line) => JSON.parse(line))
        .filter((event) => event.type === "transition" && event.stage === "awaiting_plan_approval" && event.actor === "brain");
      expect(transitions).toHaveLength(1);
    },
  );
  it("repairs naming diagnostics from a claim-owned crash candidate", async () => {
    const intake = resolvedIntake(false);
    const ledger = await createPlanningLedger(intake);
    const invocationId = "00000000-0000-4000-8000-000000000103";
    const artifactName = "crash-candidate-naming-invalid";
    const invalid = validPlan(ledger.approvedBriefSha256);
    invalid.work_items = Array.from({ length: 10 }, (_, index) => executionSpec(`item-${index + 1}`));
    invalid.work_items[0]!.title = "x".repeat(92);
    await claimBrainPlanning({ runDir: ledger.runDir, invocationId, artifactName, ownerPid: 2_147_483_647 });
    await persistCandidate(ledger.runDir, invocationId, artifactName, invalid);
    const codex: CodexAdapter = {
      invoke: vi.fn(async (input: CodexInvokeInput) => {
        const response = {
          schema_version: "1.0",
          candidate_sha256: candidateSha256(invalid),
          operations: [{ op: "replace", path: "/work_items/0/title", value_json: JSON.stringify("Implement item-1") }],
        };
        return {
          text: JSON.stringify(response),
          parsed: input.outputParser?.parse(response) ?? response,
          exitCode: 0,
          promptPath: join(input.runDir, "prompts", `${input.artifactName}.md`),
          stdoutPath: join(input.runDir, "responses", `${input.artifactName}.stdout.txt`),
          stderrPath: join(input.runDir, "responses", `${input.artifactName}.stderr.txt`),
          usage: null, durationMs: 0, processStarted: false, turnStarted: false, structuredTerminalError: false,
        };
      }),
    };

    const result = await planRunV2({
      runDir: ledger.runDir,
      intake: { ...intake, repo_root: repoRoot! },
      codex,
      maxSemanticRetries: 1,
    });

    expect(result.kind).toBe("plan");
    expect(codex.invoke).toHaveBeenCalledOnce();
    expect((await readManifestV2(ledger.runDir)).planning_recovery?.latest_candidate_ref).toBe(
      `plans/drafts/${invocationId}.json`,
    );
  });

  it("resumes an exact pre-funnel durable-discovery candidate through compatibility parsing", async () => {
    const intake = resolvedIntake(false);
    const ledger = await createPlanningLedger(intake);
    const invocationId = "00000000-0000-4000-8000-000000000105";
    const artifactName = "pre-funnel-durable-candidate";
    const item = executionSpec("item-1");
    const legacyCommands = item.verification_commands.map(({ tier: _tier, ...command }) => command);
    const legacyItem = {
      ...item,
      verification_commands: legacyCommands,
    };
    const plan = {
      ...validPlan(ledger.approvedBriefSha256),
      work_items: [legacyItem],
    } as unknown as DiscoveredBrainPlan;
    await claimBrainPlanning({ runDir: ledger.runDir, invocationId, artifactName, ownerPid: 2_147_483_647 });
    await persistCandidate(ledger.runDir, invocationId, artifactName, plan);
    const brain = new RecordingBrain(validPlan(ledger.approvedBriefSha256));

    await expect(planRunV2({
      runDir: ledger.runDir,
      intake: { ...intake, repo_root: repoRoot! },
      codex: brain,
    })).resolves.toMatchObject({ kind: "plan", revision: { revision: 1 } });
    expect(brain.calls).toHaveLength(0);
  });
  it("binds recovery to candidate B when stale candidate A has identical plan bytes", async () => {
    const intake = resolvedIntake(false);
    const ledger = await createPlanningLedger(intake);
    const plan = validPlan(ledger.approvedBriefSha256);
    const candidateA = "00000000-0000-4000-8000-000000000201";
    const candidateB = "00000000-0000-4000-8000-000000000202";
    await claimBrainPlanning({ runDir: ledger.runDir, invocationId: candidateA, artifactName: "candidate-a" });
    await persistCandidate(ledger.runDir, candidateA, "candidate-a", plan);
    await releaseBrainPlanningClaim(ledger.runDir, candidateA);
    await claimBrainPlanning({ runDir: ledger.runDir, invocationId: candidateB, artifactName: "candidate-b" });
    await persistCandidate(ledger.runDir, candidateB, "candidate-b", plan);
    await commitClaimedInitialPlan({
      runDir: ledger.runDir,
      controllerClaimToken: candidateB,
      approvalRequest: await initialRequestFor(ledger, plan),
    });
    const manifest = await readManifestV2(ledger.runDir);
    expect(manifest.plan_revisions["1"]).toMatchObject({
      candidate_invocation_id: candidateB,
      candidate_path: `plans/candidates/${candidateB}.json`,
    });
    const eventsPath = join(ledger.runDir, "events.jsonl");
    const events = (await readFile(eventsPath, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
    await writeFile(eventsPath, `${events.filter((event) => !(event.type === "transition" && event.stage === "awaiting_plan_approval" && event.actor === "brain")).map((event) => JSON.stringify(event)).join("\n")}\n`);

    await expect(resumeRun({ runDir: ledger.runDir })).resolves.toContain("plan revision 1");
    const boundary = (await readFile(eventsPath, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line))
      .filter((event) => event.type === "transition" && event.stage === "awaiting_plan_approval" && event.actor === "brain");
    expect(boundary).toHaveLength(1);
    expect(boundary[0].payload).toMatchObject({ candidate_invocation_id: candidateB });
  });
  it("refuses to repair through a recorded candidate with the wrong approved brief binding", async () => {
    const intake = resolvedIntake(false);
    const ledger = await createPlanningLedger(intake);
    const plan = validPlan(ledger.approvedBriefSha256);
    await planRunV2({
      runDir: ledger.runDir,
      intake: { ...intake, repo_root: repoRoot! },
      codex: new RecordingBrain(plan),
    });
    const manifestPath = join(ledger.runDir, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const committedInvocation = manifest.plan_revisions["1"].candidate_invocation_id;
    const committedCandidatePath = join(ledger.runDir, manifest.plan_revisions["1"].candidate_path);
    const wrongInvocation = "00000000-0000-4000-8000-000000000299";
    const wrongCandidate = {
      ...JSON.parse(await readFile(committedCandidatePath, "utf8")),
      invocation_id: wrongInvocation,
      artifact_name: "wrong-binding",
      approved_discovery_brief_sha256: "0".repeat(64),
    };
    await writeOwnedEvidenceFile(
      ledger.runDir,
      `plans/candidates/${wrongInvocation}.json`,
      "plans/",
      `${JSON.stringify(wrongCandidate, null, 2)}\n`,
    );
    manifest.plan_revisions["1"].candidate_invocation_id = wrongInvocation;
    manifest.plan_revisions["1"].candidate_path = `plans/candidates/${wrongInvocation}.json`;
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
    expect(committedInvocation).not.toBe(wrongInvocation);

    await expect(resumeRun({ runDir: ledger.runDir })).rejects.toThrow(/approved discovery brief binding/i);
  });
  it("repairs a missing committed plan boundary event during ordinary resume without Brain", async () => {
    const intake = resolvedIntake(false);
    const ledger = await createPlanningLedger(intake);
    const brain = new RecordingBrain(validPlan(ledger.approvedBriefSha256));
    await planRunV2({ runDir: ledger.runDir, intake: { ...intake, repo_root: repoRoot! }, codex: brain });
    const eventsPath = join(ledger.runDir, "events.jsonl");
    const events = (await readFile(eventsPath, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
    await writeFile(eventsPath, `${events.filter((event) => !(event.type === "transition" && event.stage === "awaiting_plan_approval")).map((event) => JSON.stringify(event)).join("\n")}\n`);

    await expect(resumeRun({ runDir: ledger.runDir })).resolves.toContain("plan revision 1");

    const repaired = (await readFile(eventsPath, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line))
      .filter((event) => event.type === "transition" && event.stage === "awaiting_plan_approval");
    expect(repaired).toHaveLength(1);
    expect(brain.calls).toHaveLength(1);
  });
  it.each(["duplicate", "conflicting", "wrong-run"])(
    "rejects a %s claimed-plan boundary event during resume",
    async (mutation) => {
      const intake = resolvedIntake(false);
      const ledger = await createPlanningLedger(intake);
      await planRunV2({
        runDir: ledger.runDir,
        intake: { ...intake, repo_root: repoRoot! },
        codex: new RecordingBrain(validPlan(ledger.approvedBriefSha256)),
      });
      const eventsPath = join(ledger.runDir, "events.jsonl");
      const boundary = (await readFile(eventsPath, "utf8")).split("\n").filter(Boolean)
        .map((line) => JSON.parse(line)).find((event) => event.type === "transition"
          && event.stage === "awaiting_plan_approval" && event.actor === "brain");
      const extra = mutation === "duplicate" ? boundary
        : mutation === "wrong-run" ? { ...boundary, event_id: "wrong-run-plan-boundary", run_id: "wrong-run" }
          : { ...boundary, event_id: "conflicting-plan-boundary", payload: { ...boundary.payload, revision: 2 } };
      await writeFile(eventsPath, `${await readFile(eventsPath, "utf8")}${JSON.stringify(extra)}\n`);

      await expect(resumeRun({ runDir: ledger.runDir })).rejects.toThrow(/boundary|duplicate|conflicting|run_id/i);
    },
  );
  it("rejects planning outside brain_planning before any artifact or Brain mutation", async () => {
    const intake = resolvedIntake(false);
    const ledger = await createPlanningLedger(intake);
    await transitionRun(ledger.runDir, "awaiting_plan_approval", { actor: "test" });
    const manifestBefore = await readFile(join(ledger.runDir, "manifest.json"), "utf8");
    const codex = new RecordingBrain(validPlan(ledger.approvedBriefSha256), true);

    await expect(planRunV2({
      runDir: ledger.runDir,
      intake: { ...intake, repo_root: repoRoot! },
      codex,
    })).rejects.toThrow(/brain_planning/);

    expect(codex.calls).toHaveLength(0);
    expect(await readFile(join(ledger.runDir, "manifest.json"), "utf8")).toBe(manifestBefore);
    await expect(access(join(ledger.runDir, "prompts/brain-plan-v2.md"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(ledger.runDir, "schemas/brain-plan-v2.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it.each([
    ["missing", async (runDir: string) => rm(join(runDir, "discovery/approved-brief.json"))],
    ["tampered", async (runDir: string) => writeFile(
      join(runDir, "discovery/approved-brief.json"),
      `${JSON.stringify({ ...approvedBrief, goal: "Tampered goal" }, null, 2)}\n`,
      "utf8",
    )],
    ["unapproved", async (runDir: string) => {
      const manifest = await readManifestV2(runDir);
      await updateManifestV2(runDir, {
        discovery: {
          ...manifest.discovery!,
          approved_brief_revision: null,
          approved_brief_sha256: null,
        },
      });
    }],
  ])("rejects a %s approved brief before invoking Brain or writing planning evidence", async (_label, corrupt) => {
    const intake = resolvedIntake(false);
    const ledger = await createPlanningLedger(intake);
    await corrupt(ledger.runDir);
    const codex = new RecordingBrain(validPlan(ledger.approvedBriefSha256));

    await expect(planRunV2({
      runDir: ledger.runDir,
      intake: { ...intake, repo_root: repoRoot! },
      codex,
    })).rejects.toThrow(/Discovery brief|approved discovery brief/i);

    expect(codex.calls).toHaveLength(0);
    await expect(access(join(ledger.runDir, "prompts/brain-plan-v2.md"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(ledger.runDir, "research.md"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readManifestV2(ledger.runDir)).current_plan_revision).toBeNull();
    await expect(access(join(ledger.runDir, "failures"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects tampered discovery approval readiness before planning evidence", async () => {
    const intake = resolvedIntake(false);
    const ledger = await createPlanningLedger(intake);
    const approvalPath = join(ledger.runDir, "discovery/briefs/revision-001-approval.json");
    const approval = JSON.parse(await readFile(approvalPath, "utf8"));
    await writeFile(approvalPath, `${JSON.stringify({ ...approval, readiness_revision: 99 }, null, 2)}\n`);
    const codex = new RecordingBrain(validPlan(ledger.approvedBriefSha256));
    await expect(planRunV2({ runDir: ledger.runDir, intake: { ...intake, repo_root: repoRoot! }, codex }))
      .rejects.toThrow(/approval|readiness/i);
    expect(codex.calls).toHaveLength(0);
    await expect(access(join(ledger.runDir, "prompts/brain-plan-v2.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    ["revision", { discovery_brief_revision: 2 }, /revision does not match/i],
    ["digest", { discovery_brief_sha256: "b".repeat(64) }, /SHA-256 does not match/i],
  ])("rejects a plan whose discovery %s echo differs from the approved brief", async (_label, override, expected) => {
    const intake = resolvedIntake(false);
    const ledger = await createPlanningLedger(intake);

    await expect(planRunV2({
      runDir: ledger.runDir,
      intake: { ...intake, repo_root: repoRoot! },
      codex: new RecordingBrain({ ...validPlan(ledger.approvedBriefSha256), ...override }),
    })).rejects.toThrow(expected);

    expect(await readManifestV2(ledger.runDir)).toMatchObject({
      current_plan_revision: null,
      stage: "brain_planning",
      delivery_state: "blocked",
      last_blocker: "Brain planning failed; resume the run to retry from the same durable stage.",
    });
    const failure = (await readdir(join(ledger.runDir, "failures"))).find((name) => name.startsWith("brain-planning-"));
    expect(failure).toBeDefined();
    const failureJson = JSON.parse(await readFile(join(ledger.runDir, "failures", failure!), "utf8"));
    expect(failureJson).toMatchObject({ attempt: 1, attempt_kind: "full", phase: "planning" });
    await expect(access(join(ledger.runDir, "research.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reopens discovery directly from a structured planning gap without recording a plan", async () => {
    const intake = resolvedIntake(false);
    const ledger = await createPlanningLedger(intake);
    const gap: PlanningDiscoveryGap = {
      outcome: "discovery_gap",
      evidence: ["src/core/run-state.ts conflicts with decision d-001"],
      question: {
        id: "q-001",
        sequence: 1,
        category: "required",
        text: "Which planner boundary should take precedence?",
        choices: [],
        recommended_choice_id: null,
        recommendation_rationale: null,
        rationale: "Repository evidence conflicts with the approved decision.",
        material_effects: ["architecture"],
        repository_evidence: ["src/core/run-state.ts"],
        essential_after_soft_limit: null,
      },
    };

    const result = await planRunV2({
      runDir: ledger.runDir,
      intake: { ...intake, repo_root: repoRoot! },
      codex: new RecordingBrain(gap),
    });

    expect(result).toMatchObject({
      kind: "discovery_gap",
      pending: { state: "awaiting_discovery_answer", question: { ...gap.question, id: "cycle-002-q-001" } },
    });
    expect(await readManifestV2(ledger.runDir)).toMatchObject({
      stage: "awaiting_discovery_answer",
      current_plan_revision: null,
      discovery: { cycle_kind: "planning_gap", approved_brief_revision: null },
    });
    await expect(access(join(ledger.runDir, "plans/revision-1.md"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(ledger.runDir, "research.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects forbidden verification commands before the approval gate", async () => {
    const intake = { ...resolvedIntake(false), repo_root: "/tmp/repo" };
    const ledger = await createPlanningLedger(intake);
    const plan = v2Plan(ledger.approvedBriefSha256);
    const item = plan.work_items[0] as unknown as ReturnType<typeof executionSpec>;
    item.verification_commands[0].argv = ["bash", "-c", "npm test"];

    await expect(planRunV2({
      runDir: ledger.runDir,
      intake: { ...intake, repo_root: repoRoot! },
      codex: new RecordingBrain(plan),
    })).rejects.toThrow(/Shell executable is not allowed/);

    expect((await readManifestV2(ledger.runDir)).stage).toBe("brain_planning");
  });

  it("rejects a structurally valid plan that is not Spark-ready before approval", async () => {
    const intake = { ...resolvedIntake(false), repo_root: "/tmp/repo" };
    const ledger = await createPlanningLedger(intake);
    const plan = v2Plan(ledger.approvedBriefSha256);
    const item = plan.work_items[0] as unknown as ReturnType<typeof executionSpec>;
    item.acceptance[0].satisfied_by = ["missing-evidence"];

    await expect(planRunV2({
      runDir: ledger.runDir,
      intake: { ...intake, repo_root: repoRoot! },
      codex: new RecordingBrain(plan),
    })).rejects.toThrow(/not execution-ready[\s\S]*missing-evidence/);

    expect((await readManifestV2(ledger.runDir)).stage).toBe("brain_planning");
  });

  it("invokes only Brain read-only planning, persists the structured plan revision, and awaits approval", async () => {
    const intake = { ...resolvedIntake(false), repo_root: "/tmp/repo" };
    const ledger = await createPlanningLedger(intake);
    await updateManifestV2(ledger.runDir, {
      delivery_state: "blocked",
      last_blocker: "Brain planning failed; resume the run to retry from the same durable stage.",
    });
    const codex = new RecordingBrain(validPlan(ledger.approvedBriefSha256));
    const progress = await openProgressReporter({ runDir: ledger.runDir });

    const result = await planRunV2({ runDir: ledger.runDir, intake: { ...intake, repo_root: repoRoot! }, codex, progress });

    expect(codex.calls).toHaveLength(1);
    expect(codex.calls[0]).toMatchObject({
      role: "brain",
      model: "brain-model",
      reasoningEffort: "high",
      sandbox: "read-only",
      cwd: repoRoot,
      enableWebSearch: false,
      outputParser: expect.anything(),
      outputSchema: expect.anything(),
      progress: expect.anything(),
    });
    expect(result.kind).toBe("plan");
    expect(await readManifestV2(ledger.runDir)).toMatchObject({ delivery_state: "pending", last_blocker: null });
    if (result.kind !== "plan") throw new Error("Expected a plan result");
    expect(result.plan).toEqual(validPlan(ledger.approvedBriefSha256));
    expect(result.revision.revision).toBe(1);
    expect(JSON.parse(await readFile(join(ledger.runDir, "schemas/brain-plan-v2.json"), "utf8"))).toMatchObject({
      type: "object",
      additionalProperties: false,
      properties: {
        result: {
          anyOf: [
            { type: "object", additionalProperties: false },
            { type: "object", additionalProperties: false },
          ],
        },
      },
      required: ["result"],
    });
    expect(JSON.parse(await readFile(join(ledger.runDir, "responses/brain-plan-v2.json"), "utf8"))).toEqual(
      { result: validPlan(ledger.approvedBriefSha256) },
    );
    expect(await readFile(join(ledger.runDir, "plans/revision-1.md"), "utf8")).toContain('"work_items"');
    const prompt = await readFile(join(ledger.runDir, "prompts/brain-plan-v2.md"), "utf8");
    expect(prompt).toContain("Never use the reserved work-item id integrated");
    expect(prompt).toContain("Map every file_contract target to exactly one change unit");
    expect(prompt).toContain("browser_checks[].local_server_command");
    expect(prompt).toContain("Keep every set-like array duplicate-free");
    expect(prompt).toContain("Never target .git or a path below it");
    expect(prompt).toContain("case-insensitively unique");
    expect(prompt).toContain(JSON.stringify(approvedBrief, null, 2));
    expect(prompt).toContain(`Approved discovery brief revision: ${approvedBrief.revision}`);
    expect(prompt).toContain(`Approved discovery brief SHA-256: ${ledger.approvedBriefSha256}`);
    expect(prompt).toContain("Return a discovery_gap instead of an execution plan");
    expect(prompt).toContain("return one `result` object");
    expect(prompt).toContain("no_implementation_effect");
    expect(prompt).toContain("cross_cutting_impacts");
    expect(prompt).toContain("focused");
    expect(prompt).toContain("cross_cutting");
    expect(prompt).toContain("representative_fixtures");
    expect(prompt).toContain(
      "either add its path to the reviewed critical-surface registry in the same change or classify its change unit as shared_helper",
    );
    expect(prompt).toContain("Do not use npm test, npm run build, or npm run clean as a work-item verification command");
    expect(await readFile(join(ledger.runDir, "research-sources.json"), "utf8")).toContain(
      "repository source and tests",
    );

    const manifest = await readManifestV2(ledger.runDir);
    expect(manifest.stage).toBe("awaiting_plan_approval");
    expect(manifest.current_plan_revision).toBe(1);
    expect(manifest.plan_revisions["1"]).toEqual(result.revision);
    expect(manifest.run_configuration_sha256).toBe(runConfigurationSha256(ledger.runConfiguration));
    expect(manifest.pending_plan_approval).toMatchObject({
      proposed_revision: 1,
      base_revision: null,
      request_path: "approvals/plan/revision-1.json",
    });
    expect(manifest.plan_revisions["1"]).toMatchObject({
      origin: "initial",
      base_revision: null,
      approval_request_path: "approvals/plan/revision-1.json",
    });
    const request = await readVerifiedPlanApprovalRequest(ledger.runDir, manifest);
    expect(request.subject).toMatchObject({
      reason_code: "initial_plan",
      plan_revision: 1,
      base_plan_revision: null,
      plan_sha256: manifest.plan_revisions["1"]!.sha256,
    });
    expect(await readFile(join(ledger.runDir, "approvals/plan/revision-1.json"), "utf8"))
      .toBe(serializePlanApprovalRequest(request));
    const events = []; for await (const event of readProgressEvents(ledger.runDir)) events.push(event);
    expect(events.at(-1)?.safe_label).toBe("Plan revision 1 ready for approval");

    const approved = await approveInitialPlan(ledger.runDir);
    expect(approved.plan_revisions["1"].acceptance_criteria).toEqual({
      "item-1": [{ ref: "BH-001:AC-1", text: "item-1 works" }],
    });
  });

  async function preparedInitialBoundary() {
    const intake = resolvedIntake(false);
    const ledger = await createPlanningLedger(intake);
    await planRunV2({
      runDir: ledger.runDir,
      intake: { ...intake, repo_root: repoRoot! },
      codex: new RecordingBrain(validPlan(ledger.approvedBriefSha256)),
    });
    return { ledger, manifest: await readManifestV2(ledger.runDir) };
  }

  it.each([
    ["plan bytes", "plans/revision-1.md"],
    ["request bytes", "approvals/plan/revision-1.json"],
    ["run configuration bytes", "run-configuration.json"],
    ["approved discovery prerequisite bytes", "discovery/approved-brief.json"],
  ])("rejects initial approval after %s drift without mutating the boundary", async (_label, path) => {
    const { ledger } = await preparedInitialBoundary();
    const manifestBefore = await readFile(join(ledger.runDir, "manifest.json"), "utf8");
    const eventsBefore = await readFile(join(ledger.runDir, "events.jsonl"), "utf8");
    await writeFile(join(ledger.runDir, path), `${await readFile(join(ledger.runDir, path), "utf8")} `);

    await expect(approveInitialPlan(ledger.runDir)).rejects.toThrow(/plan|request|configuration|canonical|digest/i);

    expect(await readFile(join(ledger.runDir, "manifest.json"), "utf8")).toBe(manifestBefore);
    expect(await readFile(join(ledger.runDir, "events.jsonl"), "utf8")).toBe(eventsBefore);
  });

  it.each(["all revision metadata", "partial revision metadata", "pending pointer"])(
    "rejects a pinned initial boundary missing %s without legacy fallback",
    async (kind) => {
      const { ledger, manifest } = await preparedInitialBoundary();
      const corrupted = structuredClone(manifest);
      if (kind === "pending pointer") {
        corrupted.pending_plan_approval = null;
      } else {
        const revision = corrupted.plan_revisions["1"]! as unknown as Record<string, unknown>;
        for (const field of [
          "origin",
          "base_revision",
          "approval_request_path",
          "approval_request_sha256",
          "approval_subject_sha256",
          "decision_contract_sha256",
        ]) {
          if (kind === "partial revision metadata" && field !== "approval_request_sha256") continue;
          delete revision[field];
        }
        corrupted.pending_plan_approval = null;
      }
      const manifestPath = join(ledger.runDir, "manifest.json");
      await writeFile(manifestPath, JSON.stringify(corrupted, null, 2));
      const before = await readFile(manifestPath, "utf8");
      const eventsBefore = await readFile(join(ledger.runDir, "events.jsonl"), "utf8");

      await expect(approveInitialPlan(ledger.runDir)).rejects.toThrow(/approval|metadata|pending|pinned/i);

      expect(await readFile(manifestPath, "utf8")).toBe(before);
      expect(await readFile(join(ledger.runDir, "events.jsonl"), "utf8")).toBe(eventsBefore);
    },
  );

  it("rejects a schema-valid initial request with a misleading deterministic delta", async () => {
    const { ledger, manifest } = await preparedInitialBoundary();
    const request = await readVerifiedPlanApprovalRequest(ledger.runDir, manifest);
    const changed = {
      ...request,
      delta: {
        ...request.delta,
        entries: [...request.delta.entries, {
          category: "risks" as const,
          pointer: "/risks/0",
          operation: "replace" as const,
          before: null,
          after: "misleading operator delta",
        }],
      },
    };
    const changedSha256 = requestSha256(changed);
    await writeFile(
      join(ledger.runDir, "approvals/plan/revision-1.json"),
      serializePlanApprovalRequest(changed),
    );
    const corrupted = structuredClone(manifest);
    corrupted.pending_plan_approval!.request_sha256 = changedSha256;
    corrupted.plan_revisions["1"]!.approval_request_sha256 = changedSha256;
    await writeFile(join(ledger.runDir, "manifest.json"), JSON.stringify(corrupted, null, 2));
    const before = await readFile(join(ledger.runDir, "manifest.json"), "utf8");

    await expect(approveInitialPlan(ledger.runDir)).rejects.toThrow(/delta/i);

    expect(await readFile(join(ledger.runDir, "manifest.json"), "utf8")).toBe(before);
  });

  it("rejects an ordinary installed-controller mismatch before approval mutation", async () => {
    const { ledger } = await preparedInitialBoundary();
    const before = await readFile(join(ledger.runDir, "manifest.json"), "utf8");

    await expect(approvePlanRevision(ledger.runDir, 1, {
      actor: "human",
      approvalControllerCapture: async () => ({
        provenance: { ...recordedController, package_hash: "f".repeat(64) },
        selfHosting: false,
      }),
    })).rejects.toThrow(/approval controller/i);

    expect(await readFile(join(ledger.runDir, "manifest.json"), "utf8")).toBe(before);
  });

  it("repairs one subject-bound approval event after a post-promotion crash", async () => {
    const { ledger, manifest: pendingManifest } = await preparedInitialBoundary();
    const request = await readVerifiedPlanApprovalRequest(ledger.runDir, pendingManifest);

    await expect(approveInitialPlan(ledger.runDir, 1, {
      afterPlanApprovalManifestPersisted: async () => {
        throw new Error("injected subject-event crash");
      },
    })).rejects.toThrow("injected subject-event crash");

    const durable = await readManifestV2(ledger.runDir);
    expect(durable.pending_plan_approval).toBeNull();
    expect(await readFile(join(ledger.runDir, "events.jsonl"), "utf8")).not.toContain("plan_approved");

    await approveInitialPlan(ledger.runDir);
    await approveInitialPlan(ledger.runDir);
    const events = (await readFile(join(ledger.runDir, "events.jsonl"), "utf8"))
      .split("\n").filter(Boolean).map((line) => JSON.parse(line))
      .filter((event) => event.type === "plan_approved");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actor: "human",
      payload: {
        revision: 1,
        plan_sha256: request.subject.plan_sha256,
        request_sha256: pendingManifest.pending_plan_approval!.request_sha256,
        approval_subject_sha256: request.approval_subject_sha256,
        approval_semantics_version: 1,
      },
    });
  });

  it("rejects a changed retry actor while repairing a new-style approval event", async () => {
    const { ledger } = await preparedInitialBoundary();
    await expect(approveInitialPlan(ledger.runDir, 1, {
      afterPlanApprovalManifestPersisted: async () => {
        throw new Error("injected actor-repair crash");
      },
    })).rejects.toThrow("injected actor-repair crash");

    await expect(approvePlanRevision(ledger.runDir, 1, {
      actor: "system",
      approvalControllerCapture: captureRecordedController,
    })).rejects.toThrow(/actor|human|authority/i);
    expect(await readFile(join(ledger.runDir, "events.jsonl"), "utf8")).not.toContain("plan_approved");
  });

  it("repairs a subject event after warning authority is concretized by promotion", async () => {
    const intake = {
      ...resolvedIntake(false),
      review_policy: { ...CANONICAL_REVIEW_POLICY, on_limit: "continue_with_warning" as const },
    };
    const ledger = await createPlanningLedger(intake);
    await planRunV2({
      runDir: ledger.runDir,
      intake: { ...intake, repo_root: repoRoot! },
      codex: new RecordingBrain(validPlan(ledger.approvedBriefSha256)),
    });

    await expect(approveInitialPlan(ledger.runDir, 1, {
      afterPlanApprovalManifestPersisted: async () => {
        throw new Error("injected warning-authority event crash");
      },
    })).rejects.toThrow("injected warning-authority event crash");
    expect((await readManifestV2(ledger.runDir)).warning_continuation_authority)
      .toEqual({ actor: "human", source: "approved_plan" });

    await expect(approveInitialPlan(ledger.runDir)).resolves.toMatchObject({ approved_revision: 1 });
    const events = (await readFile(join(ledger.runDir, "events.jsonl"), "utf8"))
      .split("\n").filter(Boolean).map((line) => JSON.parse(line))
      .filter((event) => event.type === "plan_approved");
    expect(events).toHaveLength(1);
  });

  it.each(["duplicate", "conflicting"])("fails closed on a %s subject-bound approval event id", async (kind) => {
    const { ledger } = await preparedInitialBoundary();
    await approveInitialPlan(ledger.runDir);
    const eventPath = join(ledger.runDir, "events.jsonl");
    const lines = (await readFile(eventPath, "utf8")).split("\n").filter(Boolean);
    const approved = JSON.parse(lines.find((line) => JSON.parse(line).type === "plan_approved")!);
    const extra = kind === "duplicate"
      ? approved
      : { ...approved, payload: { ...approved.payload, plan_sha256: "0".repeat(64) } };
    await writeFile(eventPath, kind === "duplicate"
      ? `${lines.join("\n")}\n${JSON.stringify(extra)}\n`
      : `${lines.filter((line) => JSON.parse(line).type !== "plan_approved").join("\n")}\n${JSON.stringify(extra)}\n`);

    await expect(approveInitialPlan(ledger.runDir)).rejects.toThrow(/duplicate|conflict/i);
  });

  it.each(["same subject", "different subject"])(
    "rejects a single %s approval record under a different event id",
    async (kind) => {
      const { ledger, manifest } = await preparedInitialBoundary();
      const request = await readVerifiedPlanApprovalRequest(ledger.runDir, manifest);
      const event = {
        event_id: `noncanonical-${kind.replace(" ", "-")}`,
        run_id: manifest.run_id,
        stage: manifest.stage,
        type: "plan_approved",
        timestamp: manifest.updated_at,
        actor: "human",
        payload: {
          revision: 1,
          plan_sha256: request.subject.plan_sha256,
          request_sha256: manifest.pending_plan_approval!.request_sha256,
          approval_subject_sha256: kind === "same subject"
            ? request.approval_subject_sha256
            : "0".repeat(64),
          approval_semantics_version: 1,
        },
      };
      const eventPath = join(ledger.runDir, "events.jsonl");
      await writeFile(eventPath, `${await readFile(eventPath, "utf8")}${JSON.stringify(event)}\n`);
      const manifestBefore = await readFile(join(ledger.runDir, "manifest.json"), "utf8");

      await expect(approveInitialPlan(ledger.runDir)).rejects.toThrow(/approval event|conflict/i);
      expect(await readFile(join(ledger.runDir, "manifest.json"), "utf8")).toBe(manifestBefore);
    },
  );

  it("feeds execution-readiness errors into one bounded corrective planning attempt", async () => {
    const intake = { ...resolvedIntake(false), repo_root: "/tmp/repo" };
    const ledger = await createPlanningLedger(intake);
    const invalid = validPlan(ledger.approvedBriefSha256);
    invalid.work_items[0]!.acceptance[0]!.satisfied_by = ["missing-evidence"];
    const calls: CodexInvokeInput[] = [];
    const codex: CodexAdapter = {
      invoke: vi.fn(async (input: CodexInvokeInput) => {
        calls.push(input);
        const response = calls.length === 1 ? { result: invalid } : {
          schema_version: "1.0",
          candidate_sha256: candidateSha256(invalid),
          operations: [{
            op: "replace",
            path: "/work_items/0/acceptance/0/satisfied_by",
            value_json: JSON.stringify(["item-1-CH-01", "item-1-TEST-01"]),
          }],
        };
        return {
          text: JSON.stringify(response),
          parsed: input.outputParser?.parse(response) ?? response,
          exitCode: 0,
          promptPath: join(input.runDir, "prompts", `${input.artifactName}.md`),
          stdoutPath: join(input.runDir, "responses", `${input.artifactName}.stdout.txt`),
          stderrPath: join(input.runDir, "responses", `${input.artifactName}.stderr.txt`),
          ...codexMetrics,
        };
      }),
    };

    const result = await planRunV2({
      runDir: ledger.runDir,
      intake,
      codex,
      maxSemanticRetries: 1,
    });

    expect(result.kind).toBe("plan");
    expect(calls).toHaveLength(2);
    expect(calls[1]!.artifactName).toBe("brain-plan-repair-v1-resume-2");
    expect(calls[1]!.prompt).toContain("Structured readiness diagnostics");
    expect(calls[1]!.prompt).toContain("missing-evidence");
    expect(await readManifestV2(ledger.runDir)).toMatchObject({
      current_plan_revision: 1,
      planning_recovery: { state: "ready", full_attempts_used: 1, repair_attempts_used: 1 },
    });
    expect((await readdir(join(ledger.runDir, "failures"))).some((name) => name.includes("attempt-1"))).toBe(true);
  });

  it("repairs a title that fits sequence 1 but exceeds the limit at sequence 10", async () => {
    const intake = { ...resolvedIntake(false), repo_root: "/tmp/repo" };
    const ledger = await createPlanningLedger(intake);
    const invalid = validPlan(ledger.approvedBriefSha256);
    invalid.work_items = Array.from({ length: 10 }, (_, index) => executionSpec(`item-${index + 1}`));
    invalid.work_items[0]!.title = "x".repeat(92);
    const calls: CodexInvokeInput[] = [];
    const codex: CodexAdapter = {
      invoke: vi.fn(async (input: CodexInvokeInput) => {
        calls.push(input);
        const response = calls.length === 1 ? { result: invalid } : {
          schema_version: "1.0",
          candidate_sha256: candidateSha256(invalid),
          operations: [{ op: "replace", path: "/work_items/0/title", value_json: JSON.stringify("Implement item-1") }],
        };
        return {
          text: JSON.stringify(response),
          parsed: input.outputParser?.parse(response) ?? response,
          exitCode: 0,
          promptPath: join(input.runDir, "prompts", `${input.artifactName}.md`),
          stdoutPath: join(input.runDir, "responses", `${input.artifactName}.stdout.txt`),
          stderrPath: join(input.runDir, "responses", `${input.artifactName}.stderr.txt`),
          ...codexMetrics,
        };
      }),
    };

    const result = await planRunV2({ runDir: ledger.runDir, intake, codex, maxSemanticRetries: 1 });

    expect(result.kind).toBe("plan");
    if (result.kind !== "plan") throw new Error("Expected a repaired plan");
    expect(result.plan.work_items[0]!.title).toBe("Implement item-1");
    expect(calls).toHaveLength(2);
    expect(calls[1]!.prompt).toContain("plan.issue_naming");
    expect(calls[1]!.prompt).toContain("/work_items/0/title");
  });

  it("replays multiple prior readiness failures as monotonic incremental repairs", async () => {
    const intake = { ...resolvedIntake(false), repo_root: "/tmp/repo" };
    const ledger = await createPlanningLedger(intake);
    const invalid = validPlan(ledger.approvedBriefSha256);
    invalid.work_items[0]!.acceptance[0]!.satisfied_by = ["missing-evidence"];
    const intermediate = structuredClone(invalid);
    intermediate.work_items[0]!.acceptance[0]!.satisfied_by = ["item-1-CH-01"];
    const calls: CodexInvokeInput[] = [];
    const codex: CodexAdapter = {
      invoke: vi.fn(async (input: CodexInvokeInput) => {
        calls.push(input);
        const response = calls.length === 1 ? { result: invalid } : calls.length === 2 ? {
          schema_version: "1.0",
          candidate_sha256: candidateSha256(invalid),
          operations: [{ op: "replace", path: "/work_items/0/acceptance/0/satisfied_by", value_json: '["item-1-CH-01"]' }],
        } : {
          schema_version: "1.0",
          candidate_sha256: candidateSha256(intermediate),
          operations: [{ op: "replace", path: "/work_items/0/acceptance/0/satisfied_by", value_json: '["item-1-CH-01","item-1-TEST-01"]' }],
        };
        return {
          text: JSON.stringify(response),
          parsed: input.outputParser?.parse(response) ?? response,
          exitCode: 0,
          promptPath: join(input.runDir, "prompts", `${input.artifactName}.md`),
          stdoutPath: join(input.runDir, "responses", `${input.artifactName}.stdout.txt`),
          stderrPath: join(input.runDir, "responses", `${input.artifactName}.stderr.txt`),
          ...codexMetrics,
        };
      }),
    };

    await expect(planRunV2({ runDir: ledger.runDir, intake, codex, maxSemanticRetries: 2 }))
      .resolves.toMatchObject({ kind: "plan" });
    expect(calls.map((call) => call.artifactName)).toEqual([
      "brain-plan-v2",
      "brain-plan-repair-v1-resume-2",
      "brain-plan-repair-v1-resume-3",
    ]);
    expect(await readManifestV2(ledger.runDir)).toMatchObject({
      planning_recovery: { state: "ready", full_attempts_used: 1, repair_attempts_used: 2 },
    });
  });

  it("preserves repair budgets and the last improving candidate across resume", async () => {
    const intake = { ...resolvedIntake(false), repo_root: "/tmp/repo" };
    const ledger = await createPlanningLedger(intake);
    const invalid = validPlan(ledger.approvedBriefSha256);
    invalid.work_items[0]!.acceptance[0]!.satisfied_by = ["missing-evidence"];
    let call = 0;
    const codex: CodexAdapter = {
      invoke: vi.fn(async (input: CodexInvokeInput) => {
        call += 1;
        const response = call === 1 ? { result: invalid } : call === 2 ? {
          schema_version: "1.0",
          candidate_sha256: candidateSha256(invalid),
          operations: [{ op: "replace", path: "/work_items/0/acceptance/0/satisfied_by", value_json: '["other-missing"]' }],
        } : {
          schema_version: "1.0",
          candidate_sha256: candidateSha256(invalid),
          operations: [{ op: "replace", path: "/work_items/0/acceptance/0/satisfied_by", value_json: '["item-1-CH-01","item-1-TEST-01"]' }],
        };
        return {
          text: JSON.stringify(response),
          parsed: input.outputParser?.parse(response) ?? response,
          exitCode: 0,
          promptPath: join(input.runDir, "prompts", `${input.artifactName}.md`),
          stdoutPath: join(input.runDir, "responses", `${input.artifactName}.stdout.txt`),
          stderrPath: join(input.runDir, "responses", `${input.artifactName}.stderr.txt`),
          ...codexMetrics,
        };
      }),
    };

    await expect(planRunV2({ runDir: ledger.runDir, intake, codex, maxSemanticRetries: 1 }))
      .rejects.toThrow(/not execution-ready/);
    expect(await readManifestV2(ledger.runDir)).toMatchObject({
      planning_recovery: { state: "blocked", full_attempts_used: 1, repair_attempts_used: 1 },
    });
    await expect(planRunV2({ runDir: ledger.runDir, intake, codex, maxSemanticRetries: 2 }))
      .resolves.toMatchObject({ kind: "plan" });
    expect(call).toBe(3);
    expect(await readManifestV2(ledger.runDir)).toMatchObject({
      planning_recovery: { state: "ready", full_attempts_used: 1, repair_attempts_used: 2 },
    });
  });

  it("plan-check diagnoses a persisted failed candidate without mutating the run", async () => {
    const intake = { ...resolvedIntake(false), repo_root: "/tmp/repo" };
    const ledger = await createPlanningLedger(intake);
    const invalid = validPlan(ledger.approvedBriefSha256);
    invalid.work_items[0]!.acceptance[0]!.satisfied_by = ["missing-evidence"];
    await expect(planRunV2({
      runDir: ledger.runDir,
      intake,
      codex: new RecordingBrain(invalid),
      maxSemanticRetries: 0,
    })).rejects.toThrow(/not execution-ready/);
    const manifest = await readManifestV2(ledger.runDir);
    const candidatePath = manifest.planning_recovery!.latest_candidate_ref!;
    const before = await readFile(join(ledger.runDir, "manifest.json"), "utf8");

    const checked = await checkPlanCandidate(ledger.runDir, candidatePath);
    expect(checked.ready).toBe(false);
    expect(checked.diagnostics).toHaveLength(3);
    expect(checked.diagnostics[0]).toMatchObject({ code: "plan.evidence", path: "/work_items/0/acceptance" });
    expect(await readFile(join(ledger.runDir, "manifest.json"), "utf8")).toBe(before);
  });

  it("plan-check reports exact naming paths and keeps graph failures separate", async () => {
    const intake = { ...resolvedIntake(false), repo_root: "/tmp/repo" };
    const ledger = await createPlanningLedger(intake);
    const namingInvalid = validPlan(ledger.approvedBriefSha256);
    delete namingInvalid.feature_slug;
    delete namingInvalid.parent_issue;
    namingInvalid.work_items[0]!.id = "ITEM";
    namingInvalid.work_items[0]!.title = "x".repeat(121);
    await writeOwnedEvidenceFile(ledger.runDir, "plans/naming-invalid.json", "plans/", `${JSON.stringify(namingInvalid)}\n`);

    const naming = await checkPlanCandidate(ledger.runDir, "plans/naming-invalid.json");
    expect(naming.ready).toBe(false);
    expect(naming.diagnostics.filter((diagnostic) => diagnostic.code === "plan.issue_naming").map((diagnostic) => diagnostic.path)).toEqual([
      "/feature_slug",
      "/parent_issue",
      "/work_items/0/id",
      "/work_items/0/title",
    ]);

    const parentTitleInvalid = validPlan(ledger.approvedBriefSha256);
    parentTitleInvalid.parent_issue = { title: "x".repeat(121) };
    await writeOwnedEvidenceFile(ledger.runDir, "plans/parent-title-invalid.json", "plans/", `${JSON.stringify(parentTitleInvalid)}\n`);
    const parentTitle = await checkPlanCandidate(ledger.runDir, "plans/parent-title-invalid.json");
    expect(parentTitle.diagnostics.filter((diagnostic) => diagnostic.code === "plan.issue_naming")).toEqual([
      expect.objectContaining({ path: "/parent_issue/title" }),
    ]);

    const graphInvalid = validPlan(ledger.approvedBriefSha256);
    graphInvalid.work_items[0]!.dependencies = ["missing-item"];
    await writeOwnedEvidenceFile(ledger.runDir, "plans/graph-invalid.json", "plans/", `${JSON.stringify(graphInvalid)}\n`);
    const graph = await checkPlanCandidate(ledger.runDir, "plans/graph-invalid.json");
    expect(graph.diagnostics).toEqual([
      expect.objectContaining({ code: "plan.graph", path: "/work_items/0/dependencies" }),
    ]);
  });

  it("plan-check returns schema diagnostics for an empty candidate without running naming checks", async () => {
    const intake = { ...resolvedIntake(false), repo_root: "/tmp/repo" };
    const ledger = await createPlanningLedger(intake);
    await writeOwnedEvidenceFile(ledger.runDir, "plans/empty.json", "plans/", "{}\n");

    const checked = await checkPlanCandidate(ledger.runDir, "plans/empty.json");

    expect(checked.ready).toBe(false);
    expect(checked.diagnostics.length).toBeGreaterThan(0);
    expect(checked.diagnostics.every((diagnostic) => diagnostic.code === "plan.schema")).toBe(true);
  });

  it("enables live search only for research-enabled intake and renders an explicit prompt instruction", async () => {
    const intake = resolvedIntake(true);
    const ledger = await createPlanningLedger(intake);
    const codex = new RecordingBrain(validPlan(ledger.approvedBriefSha256));

    await planRunV2({ runDir: ledger.runDir, intake: { ...intake, repo_root: repoRoot! }, codex });

    expect(codex.calls[0]?.enableWebSearch).toBe(true);
    const prompt = await readFile(join(ledger.runDir, "prompts/brain-plan-v2.md"), "utf8");
    expect(prompt).toContain("Use live web search and cite primary sources in research_sources");
    expect(prompt).not.toContain("{{research_instruction}}");
    expect(await readFile(join(ledger.runDir, "research-sources.json"), "utf8")).toContain(
      "repository source and tests",
    );
  });

  it("does not accept a plan hidden inside Markdown", async () => {
    const intake = resolvedIntake(false);
    const ledger = await createPlanningLedger(intake);
    const codex: CodexAdapter = {
      invoke: vi.fn(async (input: CodexInvokeInput) => ({
        text: `Here is the plan:\n\`\`\`json\n${JSON.stringify(validPlan(ledger.approvedBriefSha256))}\n\`\`\``,
        exitCode: 0,
        promptPath: join(input.runDir, "prompts", `${input.artifactName}.md`),
        stdoutPath: join(input.runDir, "responses", `${input.artifactName}.stdout.txt`),
        stderrPath: join(input.runDir, "responses", `${input.artifactName}.stderr.txt`),
        ...codexMetrics,
      })),
    };

    await expect(
      planRunV2({ runDir: ledger.runDir, intake: { ...intake, repo_root: repoRoot! }, codex }),
    ).rejects.toThrow();
  });

  it("preserves legacy parsing and planning for an older persisted run", async () => {
    const intake = resolvedIntake(false);
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-planner-legacy-"));
    const ledger = await createLegacyRunLedgerV2({
      repoRoot,
      originalRequest: intake.task,
      slug: "legacy-structured-plan",
      intake: { ...intake, repo_root: repoRoot },
      roles: intake.roles,
    });
    await transitionRun(ledger.runDir, "preflight", { actor: "test" });
    await transitionRun(ledger.runDir, "brain_planning", { actor: "test" });
    const {
      discovery_brief_revision: _revision,
      discovery_brief_sha256: _sha256,
      discovery_decision_coverage: _coverage,
      accepted_risks: _acceptedRisks,
      out_of_scope: _outOfScope,
      ...legacyPlan
    } = validPlan("a".repeat(64));

    const result = await planRunV2({
      runDir: ledger.runDir,
      intake: { ...intake, repo_root: repoRoot! },
      codex: new RecordingBrain(legacyPlan),
    });

    expect(result.kind).toBe("plan");
    if (result.kind !== "plan") throw new Error("Expected legacy plan result");
    expect(result.plan).toEqual(legacyPlan);
    expect(result.revision.revision).toBe(1);
    expect(await readManifestV2(ledger.runDir)).toMatchObject({
      workflow_protocol: "legacy-v2",
      approval_protocol_version: null,
      approval_protocol_start_revision: null,
      run_configuration_sha256: null,
    });
    await expect(access(join(ledger.runDir, "run-configuration.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(ledger.runDir, "approvals/plan/revision-1.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a newly generated plan without the naming contract before approval", async () => {
    const intake = resolvedIntake(false);
    const ledger = await createPlanningLedger(intake);
    const { feature_slug: _featureSlug, ...legacyPlan } = validPlan(ledger.approvedBriefSha256);
    const codex = new RecordingBrain(legacyPlan as BrainPlan);

    await expect(
      planRunV2({ runDir: ledger.runDir, intake: { ...intake, repo_root: repoRoot! }, codex }),
    ).rejects.toThrow("feature_slug");

    expect((await readManifestV2(ledger.runDir)).stage).toBe("brain_planning");
  });

  it("rejects a prefixed parent title before the approval gate", async () => {
    const intake = resolvedIntake(false);
    const ledger = await createPlanningLedger(intake);
    const codex = new RecordingBrain({
      ...validPlan(ledger.approvedBriefSha256),
      parent_issue: { title: "[planner-contract] Grouped delivery" },
    });

    await expect(
      planRunV2({ runDir: ledger.runDir, intake: { ...intake, repo_root: repoRoot! }, codex }),
    ).rejects.toThrow("must not include a prefix");
    expect((await readManifestV2(ledger.runDir)).stage).toBe("brain_planning");
  });
});
