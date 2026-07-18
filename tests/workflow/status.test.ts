import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { CodexAdapter, CodexInvokeInput, CodexInvokeResult } from "../../src/adapters/codex.js";
import { DryRunCodexAdapter } from "../../src/adapters/codex.js";
import { defaultConfig, resolveReviewPolicy } from "../../src/core/config.js";
import {
  approveDiscoveryBrief,
  recordDiscoveryAnswer,
  recordDiscoveryApproaches,
  recordDiscoveryBrief,
  recordDiscoveryQuestion,
  recordDiscoveryReadiness,
  selectDiscoveryApproach,
} from "../../src/core/discovery-ledger.js";
import { approvePlanRevision, createRunLedger, createRunLedgerV2, readManifest, readManifestV2, recordPlan, taskLineageId, transitionRun, updateManifest, updateManifestV2, writeTextArtifact } from "../../src/core/ledger.js";
import type { AssuranceAssessment, BrainPlan, DiscoveredBrainPlan, DiscoveryApproach, DiscoveryBrief, DiscoveryQuestion, IssueSpec, PlanApprovalRequestV1, RunManifestV2 } from "../../src/core/types.js";
import { finalAudit } from "../../src/workflow/orchestrator.js";
import { beginReviewCycle, claimReviewEffect, completeReviewEffect, incrementSuccessfulFix } from "../../src/workflow/review-cycle.js";
import { formatRunStatusComment, projectOperatorStatus, readOperatorStatus, readRunLog, renderRunStatus, resumeRun, summarizeRun, summarizeRunV2 } from "../../src/workflow/status.js";
import { blockerFingerprint, progressSubjectSha256, recoveryScopePathComponent } from "../../src/workflow/recovery-policy.js";
import { reconcileRecoveryJournal, recordRecoveryObservation } from "../../src/workflow/recovery-ledger.js";
import { executionSpec } from "../fixtures/execution-spec.js";
const codexMetrics = { usage: null, durationMs: 0, processStarted: false, turnStarted: false, structuredTerminalError: false } as const;
import { classifySemanticBoundary } from "../../src/workflow/semantic-boundary.js";
import { createLegacyRunLedgerV2 } from "../fixtures/legacy-run.js";
import { resolveRunIntake } from "../../src/core/intake.js";
import { resolveRunConfiguration, serializeRunConfiguration } from "../../src/core/run-configuration.js";
import { recordAndApprovePinnedInitialPlan } from "../fixtures/pinned-plan.js";

let repoRoot: string | null = null;

async function recordReadyBrief(runDir: string, brief: DiscoveryBrief): Promise<void> {
  await recordDiscoveryReadiness(runDir, { outcome: "no_discovery_needed", rationale: "Fixture ready.", repository_evidence: ["tests/workflow/status.test.ts"], approaches: [], alternatives_omitted_reason: "No alternative.", brief });
  await recordDiscoveryBrief(runDir, brief);
}

async function createPinnedDiscoveryLedger(task: string) {
  const config = defaultConfig();
  const intake = resolveRunIntake({
    task, repo_root: repoRoot!, mode: "local", research: false, reflection: false,
  }, config);
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
  const runConfiguration = resolveRunConfiguration({ intake, config, controller, overrides: {} });
  const ledger = await createRunLedgerV2({
    repoRoot: repoRoot!, originalRequest: task, intake, roles: intake.roles,
    sourceCommit: controller.candidate_commit, controllerProvenance: controller,
  });
  await writeFile(join(ledger.runDir, "run-configuration.json"), serializeRunConfiguration(runConfiguration));
  return {
    ledger,
    approve: (plan: BrainPlan) => recordAndApprovePinnedInitialPlan(
      ledger.runDir,
      plan,
      async () => ({ provenance: controller, selfHosting: false }),
    ),
  };
}

afterEach(async () => {
  if (repoRoot) {
    await rm(repoRoot, { recursive: true, force: true });
    repoRoot = null;
  }
});

function createIssueSpec(overrides: Partial<IssueSpec> = {}): IssueSpec {
  return {
    type: "implementation_task",
    run_id: "2026-07-08T12-00-00-000Z-build-status-flow",
    parent_request: "Build status flow",
    goal: "Implement workflow status and final audit commands",
    context: "The CLI needs readable run summaries and resume guidance.",
    scope: {
      include: ["src/workflow/status.ts", "src/workflow/orchestrator.ts", "src/cli.ts"],
      exclude: ["automatic merge operations"],
    },
    dependencies: [],
    implementation_steps: ["Add status and final audit workflow helpers."],
    acceptance_criteria: ["Status and resume commands show actionable guidance."],
    verification: {
      required_commands: ["npm test -- tests/workflow/status.test.ts"],
      manual_checks: [],
      expected_artifacts: ["final-audit.md"],
    },
    review_checklist: ["Status output stays aligned with manifest state."],
    risk_register: ["Final audit could mark a run complete without enough evidence."],
    handoff_prompt: "Implement status, resume guidance, and a minimal final audit path.",
    ...overrides,
  };
}

async function seedRun(overrides: Partial<IssueSpec> = {}) {
  repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-status-"));
  const ledger = await createRunLedger({
    repoRoot,
    originalRequest: "Implement status and final audit commands",
    slug: "implement-status-and-final-audit-commands",
    now: new Date("2026-07-08T12:00:00.000Z"),
  });

  const issue = createIssueSpec(overrides);
  await writeFile(join(ledger.runDir, "issues.json"), `${JSON.stringify([issue], null, 2)}\n`, "utf8");
  await mkdir(join(ledger.runDir, "verification", "issue-7"), { recursive: true });
  await writeFile(
    join(ledger.runDir, "verification", "issue-7", "evidence.json"),
    `${JSON.stringify({
      issue_number: 7,
      commands: [
        {
          command: "npm test -- tests/workflow/status.test.ts",
          exit_code: 0,
          timed_out: false,
          error_code: null,
          error_message: null,
          signal: null,
          stdout_path: "verification/issue-7/command-1.stdout.txt",
          stderr_path: "verification/issue-7/command-1.stderr.txt",
        },
      ],
      artifacts: ["verification/issue-7/command-1.stdout.txt"],
      created_at: "2026-07-08T12:30:00.000Z",
    }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    join(ledger.runDir, "verification", "issue-7", "command-1.stdout.txt"),
    "ok\n",
    "utf8",
  );

  await updateManifest(ledger.runDir, {
    stage: "ready_for_hands",
    current_issue: 7,
    current_pr: 21,
    issue_numbers: [7],
    pr_numbers: [21],
  });

  return ledger.runDir;
}

async function expectNoFinalAuditArtifact(runDir: string) {
  await expect(access(join(runDir, "final-audit.md"))).rejects.toMatchObject({
    code: "ENOENT",
  });
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

describe("summarizeRun", () => {
  it("includes stage, issues, PRs, and the next action", async () => {
    const runDir = await seedRun();

    const summary = await summarizeRun(runDir);

    expect(summary).toContain("Stage: ready_for_hands");
    expect(summary).toContain("Issue numbers: #7");
    expect(summary).toContain("PR numbers: #21");
    expect(summary).toContain(`Next action: Run brain-hands implement --run "${runDir}" --issue 7.`);
  });
});

describe("v2 operator status projection", () => {
  const verifiedAssessment: AssuranceAssessment = {
    outcome: "verified_ready",
    assessed_at: "2026-07-12T00:00:00.000Z",
    approved_plan_revision: 1,
    approved_plan_sha256: "a".repeat(64),
    candidate_commit: "b".repeat(40),
    blocker_code: null,
    blocker: null,
    missing_evidence: [],
    invalid_evidence: [],
    zero_attempt_work_items: [],
    acceptance_path: null,
  };

  async function seedInjectedAssuranceStatus(): Promise<string> {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-status-assurance-"));
    const ledger = await createRunLedgerV2({ repoRoot, originalRequest: "Validate supplied assurance" });
    await updateManifestV2(ledger.runDir, {
      mode: "github",
      run_mode: "github",
      stage: "delivery",
      delivery_state: "ready",
    });
    return ledger.runDir;
  }

  function planApprovalBlock(rendered: string): string[] {
    const lines = rendered.split("\n");
    const start = lines.findIndex((line) => line.startsWith("Approval required:"));
    const end = lines.findIndex((line, index) => index >= start && line.startsWith("Next command (approve-plan):"));
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    return lines.slice(start, end + 1);
  }

  function fixture(overrides: Partial<RunManifestV2> = {}): RunManifestV2 {
    return {
      version: 2,
      schema_version: 2,
      run_id: "run-status",
      original_request: "Status",
      repo_root: "/repo",
      created_at: "2026-07-12T00:00:00.000Z",
      updated_at: "2026-07-12T00:00:00.000Z",
      stage: "implementing",
      workflow_protocol: "legacy-v2",
      task_lineage_id: null,
      github_effects_protocol: "legacy-run-v1",
      github_effects: { issue_sync: null, pull_request_delivery: null },
      github_cleanup: null,
      legacy_github_restore: null,
      discovery: null,
      current_work_item_id: "item",
      retry_counts: {}, issue_numbers: [], work_item_issue_map: {}, pull_request_numbers: [], events: ["events.jsonl"],
      mode: "local", run_mode: "local", active_hands_profile: "primary", backup_activation_reason: null,
      review_policy_snapshot: resolveReviewPolicy(3),
      review_accounting: { review_revision: 2, fix_cycles_used: 1, self_review_mutations_used: 2, plan_revision: 1 },
      role_profiles: {}, selected_role_profiles: {}, current_revision: 1, approved_revision: 1,
      current_plan_revision: 1, approved_plan_revision: 1, plan_revisions: {},
      pending_plan_approval: null, run_configuration_sha256: null, source_commit: "abc",
      worktree_path: "/repo/worktree", branch_name: "codex/run-status",
      work_item_progress: { item: { status: "in_progress", attempts: 2, review_revision: 2 } },
      github_ids: { issue_numbers: [], pull_request_numbers: [], pull_request_urls: {} },
      delivery_state: "pending", final_artifact_paths: [], last_blocker: null, intake_path: "intake.json",
      assurance_outcome: null, assurance_assessment_path: null, risk_acceptance_path: null,
      risk_acceptance_history: [], abandonment_path: null,
      terminal: null,
      ...overrides,
      recovery: overrides.recovery ?? { version: 1, active_scope: null, scopes: {} },
      task_lineage: overrides.task_lineage ?? null,
      controller_recovery: overrides.controller_recovery ?? { version: 1, transition_count: 0, head_path: null },
    };
  }

  it("classifies semantic boundaries with replanning and verifier activity as non-boundaries", () => {
    expect(classifySemanticBoundary(fixture({ stage: "replanning" }))).toBeNull();
    expect(classifySemanticBoundary(fixture({
      stage: "replanning",
      work_item_progress: {
        item: {
          status: "in_progress",
          attempts: 2,
          review_revision: 2,
          replan_patch_path: "replans/work-item-a-base-1-review-2.json",
        },
      },
    }))).toBeNull();
    expect(classifySemanticBoundary(fixture({ stage: "implementing" }))).toBeNull();
    expect(classifySemanticBoundary(fixture({ stage: "awaiting_discovery_answer" }))).toBe("discovery_answer");
    expect(classifySemanticBoundary(fixture({ stage: "awaiting_discovery_approach" }))).toBe("discovery_approach");
    expect(classifySemanticBoundary(fixture({ stage: "awaiting_discovery_brief_approval" }))).toBe("discovery_brief_approval");
    expect(classifySemanticBoundary(fixture({ stage: "awaiting_plan_approval" }))).toBe("plan_approval");
    expect(classifySemanticBoundary(fixture({
      mode: "github",
      run_mode: "github",
      stage: "delivery",
      delivery_state: "ready",
    }))).toBe("manual_delivery_authority");
    expect(classifySemanticBoundary(fixture({
      stage: "implementing",
      delivery_state: "blocked",
      last_blocker: "Network unavailable",
    }))).toBe("operational_blocker");
    expect(classifySemanticBoundary(fixture({
      stage: "awaiting_plan_approval",
      delivery_state: "blocked",
      last_blocker: "Approval request artifact is corrupt",
    }))).toBe("operational_blocker");
    expect(classifySemanticBoundary(fixture({
      stage: "complete",
      delivery_state: "complete",
    }))).toBe("terminal");
  });

  function approvalRequest(reasonCode: "initial_plan" | "material_replan" = "material_replan"): PlanApprovalRequestV1 {
    const initial = reasonCode === "initial_plan";
    return {
      schema_version: 1,
      subject: {
        schema_version: 1,
        gate: "plan",
        reason_code: reasonCode,
        run_id: "run-status",
        plan_revision: initial ? 1 : 2,
        base_plan_revision: initial ? null : 1,
        plan_sha256: "0".repeat(64),
        prerequisite_subject_sha256: "1".repeat(64),
        execution_context_sha256: "2".repeat(64),
        authority_contract_sha256: "3".repeat(64),
        decision_contract_sha256: "4".repeat(64),
      },
      approval_subject_sha256: "a".repeat(64),
      plan_path: initial ? "plans/revision-1.md" : "plans/revision-2.md",
      delta: initial ? {
        schema_version: 1,
        base_revision: null,
        proposed_revision: 1,
        entries: [
          { category: "objective", pointer: "/work_items/BH-005/objective", operation: "add", before: null, after: "Implement approval status." },
          { category: "files", pointer: "/work_items/BH-005/file_contract/src/status.ts", operation: "add", before: null, after: { path: "src/status.ts", permission: "modify" } },
          { category: "destructive_actions", pointer: "/work_items/BH-005/file_contract/src/obsolete.ts", operation: "add", before: null, after: { path: "src/obsolete.ts", permission: "delete" } },
          { category: "verification", pointer: "/work_items/BH-005/verification_commands/BH-005-VERIFY-01", operation: "add", before: null, after: { id: "BH-005-VERIFY-01", argv: ["npm", "test"] } },
          { category: "verification", pointer: "/work_items/BH-005/browser_checks/status", operation: "add", before: null, after: { name: "status" } },
          { category: "verification", pointer: "/integration_verification", operation: "add", before: null, after: [["npm", "run", "typecheck"]] },
          { category: "risks", pointer: "/risks", operation: "add", before: null, after: ["Status disclosure", "Stale approval"] },
        ],
        unchanged_high_impact_categories: ["external_effects"],
      } : {
        schema_version: 1,
        base_revision: 1,
        proposed_revision: 2,
        entries: [{
          category: "files",
          pointer: "/work_items/BH-005/file_contract/src/core/plan-approval.ts",
          operation: "add",
          before: null,
          after: { path: "src/core/plan-approval.ts", permission: "modify" },
        }],
        unchanged_high_impact_categories: ["risks", "external_effects", "destructive_actions"],
      },
      additional_approvals_expected: "only_if_material_replan",
    };
  }

  it.each([
    [fixture(), "progressing_automatically", "Progressing automatically"],
    [fixture({ stage: "awaiting_plan_approval", approved_revision: null }), "awaiting_plan_approval", "Awaiting plan approval"],
    [fixture({ mode: "github", run_mode: "github", stage: "delivery", delivery_state: "ready", pull_request_numbers: [7] }), "awaiting_irreversible_action_authority", "Awaiting irreversible-action authority"],
    [fixture({ delivery_state: "blocked", last_blocker: "Network unavailable" }), "operationally_blocked", "Operationally blocked"],
    [fixture({ delivery_state: "blocked", last_blocker: "Release blocker remains" }), "unresolved_release_blocker", "Unresolved release blocker"],
    [fixture({ stage: "delivery", delivery_state: "ready" }), "delivered", "Delivered"],
    [fixture({ terminal: { outcome: "human_accepted", actor: "human", reason: "Accepted incomplete", recorded_at: "2026-07-12T01:00:00.000Z", source_stage: "verifier_review", residual_risks: ["Incomplete"] } }), "human_accepted", "Human accepted"],
    [fixture({ terminal: { outcome: "abandoned", actor: "human", reason: "No longer needed", recorded_at: "2026-07-12T01:00:00.000Z", source_stage: "implementing", residual_risks: [] } }), "abandoned", "Abandoned"],
    [fixture({ delivery_state: "blocked", terminal: { outcome: "closed_blocked", actor: "human", reason: "Dependency unavailable", recorded_at: "2026-07-12T01:00:00.000Z", source_stage: "verifier_review", residual_risks: ["Incomplete"] } }), "closed_blocked", "Closed blocked"],
  ])("renders %s", (manifest, state, label) => {
    const status = projectOperatorStatus(manifest, {
      force_release_blocker: state === "unresolved_release_blocker",
    });
    expect(status.operator_state).toBe(state);
    expect(renderRunStatus(status)).toContain(label);
  });

  it("exposes counters, findings, next effect, and the exact approval boundary", () => {
    const status = projectOperatorStatus(fixture(), {
      active_finding_ids: ["finding-2", "finding-1"],
      latest_decision: "fix",
      latest_effect_state: "pending",
    });
    expect(status).toMatchObject({
      review_revision: 2,
      fix_cycles_used: 1,
      max_fix_cycles: 3,
      plan_revision: 1,
      active_finding_ids: ["finding-1", "finding-2"],
      next_automatic_effect: "fix",
      approval_boundary: "none",
    });
  });

  it("projects and renders a diagnostic stop above a generic blocked state but below terminal outcomes", () => {
    const scopeId = "work-item:item-1";
    const scopeComponent = recoveryScopePathComponent(scopeId);
    const diagnosticPath = `recovery/scopes/${scopeComponent}/diagnostics/000002.json`;
    const diagnosticManifest = fixture({
      delivery_state: "blocked",
      last_blocker: "Repeated implementation failure",
      recovery: {
        version: 1,
        active_scope: scopeId,
        scopes: {
          [scopeId]: {
            version: 1,
            head_sequence: 2,
            head_decision_path: `recovery/scopes/${scopeComponent}/decisions/000002-${"c".repeat(64)}.json`,
            blocker_fingerprint: "a".repeat(64),
            progress_subject_sha256: "b".repeat(64),
            consecutive_without_progress: 2,
            disposition: "diagnostic_stop",
            diagnostic_path: diagnosticPath,
            authorization_path: null,
          },
        },
      },
      task_lineage: {
        version: 1,
        lineage_id: taskLineageId("run-status"),
        root_run_id: "run-status",
        predecessor_run_id: null,
        predecessor_abandonment_sha256: null,
      },
    });
    const hostileRunDir = "/tmp/run $HOME $(touch PWNED) `id` O'Brien";

    const status = projectOperatorStatus(
      diagnosticManifest,
      {},
      null,
      null,
      hostileRunDir,
    );

    expect(status).toMatchObject({
      operator_state: "diagnostic_stop",
      recovery_disposition: "diagnostic_stop",
      recovery_scope: scopeId,
      blocker_fingerprint: "a".repeat(64),
      progress_subject_sha256: "b".repeat(64),
      consecutive_without_progress: 2,
      diagnostic_path: diagnosticPath,
      task_lineage_id: taskLineageId("run-status"),
      predecessor_run_id: null,
      next_automatic_effect: null,
    });
    expect(renderRunStatus(status)).toContain([
      "Operator state: Diagnostic stop (diagnostic_stop)",
      `Recovery scope: ${scopeId}`,
      `Repeated blocker: ${"a".repeat(64)}`,
      `Progress subject: ${"b".repeat(64)}`,
      "No material progress: 2 distinct attempts",
      `Diagnostic: ${diagnosticPath}`,
      "Next command: brain-hands resume --run '/tmp/run $HOME $(touch PWNED) `id` O'\"'\"'Brien' --actor <actor> --recovery-note-file <path>",
    ].join("\n"));

    const terminal = projectOperatorStatus({
      ...diagnosticManifest,
      terminal: {
        outcome: "closed_blocked",
        actor: "human",
        reason: "Stop the run",
        recorded_at: "2026-07-12T01:00:00.000Z",
        source_stage: "implementing",
        residual_risks: [],
      },
    });
    expect(terminal.operator_state).toBe("closed_blocked");
  });

  it("reconciles diagnostic evidence before projection and reports exact journal tampering", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-status-recovery-"));
    const ledger = await createRunLedgerV2({ repoRoot, originalRequest: "Reconcile diagnostic status" });
    const scopeId = "work-item:item-1";
    const blockerSubject = {
      version: 1 as const,
      scope_id: scopeId,
      stage: "implementing" as const,
      operation: "work-item-fix",
      failure_class: "implementation_failure" as const,
      blocker_code: "implementation_failed",
      finding_ids: [] as string[],
    };
    const progressSubject = {
      version: 1 as const,
      approved_plan_sha256: null,
      candidate_commit: null,
      implementation_artifact_sha256: null,
      verification_artifact_sha256: null,
      review_artifact_sha256: null,
      review_revision: null,
      finding_ids: [] as string[],
    };
    const progressSha256 = progressSubjectSha256(progressSubject);
    const input = (effectAttemptId: string) => ({
      runDir: ledger.runDir,
      observation: {
        ...blockerSubject,
        run_id: ledger.runId,
        effect_attempt_id: effectAttemptId,
        blocker_fingerprint: blockerFingerprint(blockerSubject),
        progress_subject_sha256: progressSha256,
      },
      requestedEffect: "retry_operation" as const,
      requestedEffectReason: "implementation_retry",
      diagnosticContext: {
        classification: {
          kind: "operational" as const,
          failure_class: blockerSubject.failure_class,
          blocker_code: blockerSubject.blocker_code,
        },
        policy_decision: null,
        owned_evidence_refs: {
          implementation_path: null,
          verification_path: null,
          review_path: null,
        },
        progress: { subject: progressSubject, sha256: progressSha256 },
      },
    });
    await recordRecoveryObservation(input("status-attempt-1"));
    const interruption = new Error("after diagnostic artifact");
    await expect(recordRecoveryObservation({
      ...input("status-attempt-2"),
      hooks: { afterDiagnosticArtifact: async () => { throw interruption; } },
    })).rejects.toBe(interruption);

    const reconciled = await readOperatorStatus(ledger.runDir);
    expect(reconciled).toMatchObject({
      operator_state: "diagnostic_stop",
      recovery_scope: scopeId,
      recovery_disposition: "diagnostic_stop",
      consecutive_without_progress: 2,
      diagnostic_path: `recovery/scopes/${recoveryScopePathComponent(scopeId)}/diagnostics/000002.json`,
    });

    const manifest = await readManifestV2(ledger.runDir);
    const decisionPath = manifest.recovery.scopes[scopeId]!.head_decision_path!;
    const decision = JSON.parse(await readFile(join(ledger.runDir, decisionPath), "utf8"));
    decision.requested_effect_reason = "tampered_reason";
    await writeFile(join(ledger.runDir, decisionPath), `${JSON.stringify(decision, null, 2)}\n`, "utf8");
    let provenanceError: unknown;
    try {
      await reconcileRecoveryJournal(ledger.runDir);
    } catch (error) {
      provenanceError = error;
    }
    expect(provenanceError).toBeInstanceOf(Error);

    expect(await readOperatorStatus(ledger.runDir)).toMatchObject({
      operator_state: "operationally_blocked",
      blocker: `Status provenance invalid: ${(provenanceError as Error).message}`,
    });
  });

  it("keeps discovery actions separate from a verified replan approval request", () => {
    const request = approvalRequest();
    const pending = {
      schema_version: 1 as const,
      proposed_revision: 2,
      base_revision: 1,
      request_path: "approvals/plan/revision-2.json",
      request_sha256: "b".repeat(64),
      approval_subject_sha256: request.approval_subject_sha256,
    };
    const status = projectOperatorStatus(fixture({
      stage: "awaiting_plan_approval",
      delivery_state: "blocked",
      pending_plan_approval: pending,
      plan_revisions: {
        "2": {
          revision: 2,
          path: request.plan_path,
          sha256: request.subject.plan_sha256,
          origin: "replan",
          base_revision: 1,
          approval_request_path: pending.request_path,
          approval_request_sha256: pending.request_sha256,
          approval_subject_sha256: pending.approval_subject_sha256,
          decision_contract_sha256: request.subject.decision_contract_sha256,
        },
      },
      work_item_progress: {
        item: {
          status: "blocked",
          attempts: 2,
          replan_patch_path: "replans/item-base-1-review-4.json",
        },
      },
    }), {}, null, null, "/runs/status", null, null, null, request);

    expect(status.current_revision).toBe(1);
    expect(status.approved_revision).toBe(1);
    expect(status.pending_action).toBeNull();
    expect(status.plan_approval_request?.subject.plan_revision).toBe(2);
    expect(status.approval_boundary).toBe("Explicit approval is required for plan revision 2.");
    expect(planApprovalBlock(renderRunStatus(status))).toEqual([
      "Approval required: material replan",
      "Why: Verifier findings require changes outside the currently approved decision contract.",
      "Base revision: 1",
      "Proposed revision: 2",
      `Plan SHA-256: ${"0".repeat(64)}`,
      `Approval subject SHA-256: ${"a".repeat(64)}`,
      "Full plan: plans/revision-2.md",
      "",
      "Changed files:",
      "  add /work_items/BH-005/file_contract/src/core/plan-approval.ts",
      "Unchanged high-impact categories: risks, external effects, destructive actions",
      "Additional approvals expected: only if another material replan is prepared.",
      "Next command (approve-plan): brain-hands approve-plan --run '/runs/status' --revision 2",
    ]);
  });

  it("renders the complete initial authorization summary from the verified request", () => {
    const request = approvalRequest("initial_plan");
    const status = projectOperatorStatus(
      fixture({ stage: "awaiting_plan_approval", current_revision: 1, approved_revision: null }),
      {}, null, null, "/runs/status",
      { github: { effects: "none", default_remote: "origin" } } as never,
      null,
      null,
      request,
    );

    expect(planApprovalBlock(renderRunStatus(status))).toEqual([
      "Approval required: initial plan",
      "Why: The exact initial plan must be approved before implementation begins.",
      "Proposed revision: 1",
      `Plan SHA-256: ${"0".repeat(64)}`,
      `Approval subject SHA-256: ${"a".repeat(64)}`,
      "Full plan: plans/revision-1.md",
      "",
      "Authorization summary:",
      "  Work items: 1",
      "  Changeable files: 2",
      "  Verification commands: 2",
      "  Browser checks: 1",
      "  Destructive file operations: 1",
      "  Risks: 2",
      "  GitHub effects: none",
      "  Merge policy: manual only",
      "Additional approvals expected: only if another material replan is prepared.",
      "Next command (approve-plan): brain-hands approve-plan --run '/runs/status' --revision 1",
    ]);
  });

  it("keeps legacy patch-only replans observational and requires resume preparation", () => {
    const status = projectOperatorStatus(fixture({
      stage: "awaiting_plan_approval",
      work_item_progress: { item: { status: "blocked", attempts: 2, replan_patch_path: "replans/item.json" } },
    }));

    expect(status.plan_approval_request).toBeNull();
    expect(status.approval_boundary).toBe("Run resume to prepare an exact plan approval request before approval.");
    expect(renderRunStatus(status)).not.toContain("approve-plan");
  });

  it("exposes bounded resource budget status and blocks on malformed authoritative budget artifacts", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-status-budget-"));
    const ledger = await createRunLedgerV2({ repoRoot, originalRequest: "Show budget status" });

    const status = await readOperatorStatus(ledger.runDir);
    expect(status.resource_budget).toMatchObject({
      policy: { schema_version: 1, max_model_invocations: 64 },
      usage: {
        model_invocations: 0,
        workflow_attempts: 0,
        total_tokens: 0,
        active_elapsed_ms: 0,
        external_effects: 0,
        token_accounting: "known",
      },
      remaining: {
        model_invocations: 64,
        workflow_attempts: 32,
        total_tokens: 4_000_000,
        active_elapsed_ms: 14_400_000,
        external_effects: 128,
      },
      token_budget_overshot_by: 0,
    });
    expect(renderRunStatus(status)).toContain("Resource budget model invocations: 0/64 used; 64 remaining");

    await writeFile(join(ledger.runDir, "budgets", "policy.json"), "{malformed\n", "utf8");
    const blocked = await readOperatorStatus(ledger.runDir);
    expect(blocked.operator_state).toBe("operationally_blocked");
    expect(blocked.resource_budget).toBeNull();
    expect(blocked.blocker).toMatch(/resource budget|json|validated artifact/i);
  });

  it("projects each validated local discovery boundary and its exact next command", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-status-discovery-"));
    const config = defaultConfig();
    const intake = resolveRunIntake({
      task: "Discover status boundaries",
      repo_root: repoRoot,
      mode: "local",
      research: false,
      reflection: false,
    }, config);
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
    const runConfiguration = resolveRunConfiguration({ intake, config, controller, overrides: {} });
    const ledger = await createRunLedgerV2({
      repoRoot,
      originalRequest: intake.task,
      intake,
      roles: intake.roles,
      sourceCommit: controller.candidate_commit,
      controllerProvenance: controller,
      runConfiguration,
    });
    await transitionRun(ledger.runDir, "preflight", { actor: "test" });
    await transitionRun(ledger.runDir, "brain_discovery", { actor: "test" });
    const question: DiscoveryQuestion = {
      id: "q-001",
      sequence: 1,
      category: "required",
      text: "Choose PRIVATE-DISCOVERY-MARKER behavior?",
      choices: [{ id: "local", label: "Local", description: "Keep discovery local." }],
      recommended_choice_id: "local",
      recommendation_rationale: "It keeps the private boundary explicit.",
      rationale: "This changes the privacy boundary.",
      material_effects: ["architecture"],
      repository_evidence: ["src/workflow/status.ts"],
      essential_after_soft_limit: null,
    };
    const approaches: DiscoveryApproach[] = [{
      id: "approach-local",
      title: "Local only PRIVATE-DISCOVERY-MARKER",
      summary: "Keep all discovery content local.",
      tradeoffs: ["Remote observers see only a generic boundary."],
      recommended: true,
      recommendation_rationale: "It preserves privacy.",
    }];
    const brief: DiscoveryBrief = {
      revision: 1,
      goal: "Keep PRIVATE-DISCOVERY-MARKER local",
      problem: "Discovery content must not reach generic projections.",
      success_criteria: ["Local status exposes the exact pending action."],
      constraints: ["No GitHub disclosure."],
      decisions: [{ id: "d-001", statement: "Keep discovery local.", source_question_ids: ["q-001"] }], assumptions: [],
      selected_approach_id: "approach-local",
      selected_approach_rationale: "It is the private option.",
      out_of_scope: [], accepted_risks: [],
      repository_evidence: ["src/workflow/status.ts"],
    };

    await recordDiscoveryQuestion(ledger.runDir, question);
    let status = await readOperatorStatus(ledger.runDir);
    expect(status).toMatchObject({
      operator_state: "awaiting_discovery_answer",
      run_dir: ledger.runDir,
      pending_action: {
        state: "awaiting_discovery_answer",
        question: {
          id: "q-001",
          recommended_choice_id: "local",
          recommendation_rationale: "It keeps the private boundary explicit.",
        },
      },
    });
    expect(renderRunStatus(status)).toContain(
      `brain-hands answer-discovery --run '${ledger.runDir}' --question q-001 --input-file <path>`,
    );
    expect(renderRunStatus(status)).toContain(
      `brain-hands proceed-discovery --run '${ledger.runDir}' --question q-001 --input-file <path>`,
    );
    expect(renderRunStatus(status)).toContain("PRIVATE-DISCOVERY-MARKER");
    expect(renderRunStatus(status)).toContain("Recommended choice: local");
    expect(renderRunStatus(status)).toContain("Recommendation rationale: It keeps the private boundary explicit.");
    expect(formatRunStatusComment(status).body).toBe("<!-- brain-hands-run-status:" + status.run_id + " -->\nAwaiting local discovery input.");

    await recordDiscoveryAnswer(ledger.runDir, "q-001", "Keep it local");
    await recordDiscoveryApproaches(ledger.runDir, 1, approaches);
    status = await readOperatorStatus(ledger.runDir);
    expect(status).toMatchObject({
      operator_state: "awaiting_discovery_approach",
      pending_action: { state: "awaiting_discovery_approach", revision: 1 },
    });
    expect(renderRunStatus(status)).toContain(
      `brain-hands select-discovery-approach --run '${ledger.runDir}' --revision 1 --approach approach-local`,
    );
    expect(renderRunStatus(status)).toContain("Recommended approach: approach-local");
    expect(renderRunStatus(status)).toContain("Recommendation rationale: It preserves privacy.");

    await selectDiscoveryApproach(ledger.runDir, 1, "approach-local");
    await recordReadyBrief(ledger.runDir, brief);
    status = await readOperatorStatus(ledger.runDir);
    expect(status).toMatchObject({
      operator_state: "awaiting_discovery_brief_approval",
      pending_action: { state: "awaiting_discovery_brief_approval", revision: 1 },
    });
    expect(renderRunStatus(status)).toContain(
      `brain-hands approve-discovery --run '${ledger.runDir}' --revision 1`,
    );
    expect(renderRunStatus(status)).toContain(
      `brain-hands revise-discovery --run '${ledger.runDir}' --revision 1 --input-file <path>`,
    );
    expect(formatRunStatusComment(status).body).not.toContain("PRIVATE-DISCOVERY-MARKER");

    const legacyPending = {
      state: "awaiting_discovery_answer" as const,
      question: (() => {
        const { recommended_choice_id: _choice, recommendation_rationale: _rationale, ...legacy } = question;
        return legacy;
      })(),
      permitted_next_actions: ["answer-discovery", "proceed-discovery"] as ["answer-discovery", "proceed-discovery"],
    };
    expect(renderRunStatus(projectOperatorStatus(
      fixture({ stage: "awaiting_discovery_answer" }), {}, null, legacyPending, ledger.runDir,
    ))).not.toContain("Recommended choice:");
  });

  it("keeps GitHub status generic by discovery stage when pending-action parsing fails", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-status-private-failure-"));
    const ledger = await createRunLedgerV2({ repoRoot, originalRequest: "Keep corrupt discovery local" });
    await transitionRun(ledger.runDir, "preflight", { actor: "test" });
    await transitionRun(ledger.runDir, "brain_discovery", { actor: "test" });
    await recordDiscoveryQuestion(ledger.runDir, {
      id: "q-001", sequence: 1, category: "required",
      text: "Original private question?",
      choices: [{ id: "yes", label: "Yes", description: "Keep local." }],
      rationale: "Privacy boundary", material_effects: ["architecture"],
      repository_evidence: ["src/workflow/status.ts"], essential_after_soft_limit: null,
    });
    await writeFile(join(ledger.runDir, "discovery/pending-action.json"), "PRIVATE-PARSER-BLOCKER", "utf8");

    const status = await readOperatorStatus(ledger.runDir);

    expect(status.operator_state).toBe("operationally_blocked");
    expect(status.blocker).toBe("Status provenance invalid: discovery pending action validation failed");
    expect(JSON.stringify(status)).not.toContain("PRIVATE-PARSER-BLOCKER");
    expect(formatRunStatusComment(status).body)
      .toBe(`<!-- brain-hands-run-status:${status.run_id} -->\nAwaiting local discovery input.`);
    await expect(access(join(ledger.runDir, ".ledger.lock"))).rejects.toThrow();
  });

  it("keeps every replan GitHub projection generic while local status retains diagnostics", () => {
    const privateBlocker = "PRIVATE finding:deadbeef src/secret.ts npm run exploit";
    const status = projectOperatorStatus(fixture({
      stage: "replanning",
      delivery_state: "blocked",
      last_blocker: privateBlocker,
    }), {
      operational_blocker: true,
      projection_blocker: privateBlocker,
      active_finding_ids: [`finding:${"a".repeat(64)}`],
      latest_decision: "create_replan",
      latest_effect_state: "complete",
    });

    expect(status.blocker).toBe(privateBlocker);
    expect(status.active_finding_ids).toEqual([`finding:${"a".repeat(64)}`]);
    expect(formatRunStatusComment(status).body).toBe(
      `<!-- brain-hands-run-status:${status.run_id} -->\nLocal replan status requires attention.`,
    );
  });

  it("renders hostile run directories as literal POSIX shell arguments", () => {
    const hostileRunDir = "/tmp/run $HOME $(touch PWNED) `id` O'Brien";
    const question: DiscoveryQuestion = {
      id: "q-001", sequence: 1, category: "required", text: "Choose safely?",
      choices: [{ id: "yes", label: "Yes", description: "Continue." }],
      rationale: "Shell safety", material_effects: ["architecture"],
      repository_evidence: ["src/workflow/status.ts"], essential_after_soft_limit: null,
    };
    const status = projectOperatorStatus(
      fixture({ stage: "awaiting_discovery_answer" }),
      {},
      null,
      {
        state: "awaiting_discovery_answer",
        question,
        permitted_next_actions: ["answer-discovery", "proceed-discovery"],
      },
      hostileRunDir,
    );

    expect(renderRunStatus(status)).toContain(
      "--run '/tmp/run $HOME $(touch PWNED) `id` O'\"'\"'Brien' --question q-001",
    );
    expect(renderRunStatus(status)).not.toContain(`--run ${JSON.stringify(hostileRunDir)}`);
  });

  it("fails closed when a pending question differs from its immutable question artifact", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-status-question-tamper-"));
    const ledger = await createRunLedgerV2({ repoRoot, originalRequest: "Validate pending question" });
    await transitionRun(ledger.runDir, "preflight", { actor: "test" });
    await transitionRun(ledger.runDir, "brain_discovery", { actor: "test" });
    const question: DiscoveryQuestion = {
      id: "q-001", sequence: 1, category: "required", text: "Immutable question?",
      choices: [{ id: "yes", label: "Yes", description: "Keep local." }],
      rationale: "Coordinate validation", material_effects: ["architecture"],
      repository_evidence: ["src/workflow/status.ts"], essential_after_soft_limit: null,
    };
    await recordDiscoveryQuestion(ledger.runDir, question);
    await writeFile(join(ledger.runDir, "discovery/pending-action.json"), `${JSON.stringify({
      state: "awaiting_discovery_answer", question: { ...question, text: "Tampered pending question" },
      permitted_next_actions: ["answer-discovery", "proceed-discovery"],
    }, null, 2)}\n`, "utf8");

    expect(await readOperatorStatus(ledger.runDir)).toMatchObject({
      operator_state: "operationally_blocked",
      pending_action: null,
    });
  });

  it("fails closed when pending approaches use a stale manifest revision", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-status-approach-tamper-"));
    const ledger = await createRunLedgerV2({ repoRoot, originalRequest: "Validate pending approaches" });
    await transitionRun(ledger.runDir, "preflight", { actor: "test" });
    await transitionRun(ledger.runDir, "brain_discovery", { actor: "test" });
    const approaches: DiscoveryApproach[] = [{
      id: "approach-local", title: "Local", summary: "Keep local", tradeoffs: ["None"],
      recommended: true, recommendation_rationale: "Privacy",
    }];
    await recordDiscoveryApproaches(ledger.runDir, 1, approaches);
    await writeFile(join(ledger.runDir, "discovery/pending-action.json"), `${JSON.stringify({
      state: "awaiting_discovery_approach", revision: 2, approaches,
      permitted_next_actions: ["select-discovery-approach"],
    }, null, 2)}\n`, "utf8");

    expect(await readOperatorStatus(ledger.runDir)).toMatchObject({
      operator_state: "operationally_blocked",
      pending_action: null,
    });
  });

  it("fails closed when immutable brief bytes no longer match the recorded digest", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-status-brief-tamper-"));
    const ledger = await createRunLedgerV2({ repoRoot, originalRequest: "Validate pending brief" });
    await transitionRun(ledger.runDir, "preflight", { actor: "test" });
    await transitionRun(ledger.runDir, "brain_discovery", { actor: "test" });
    const brief: DiscoveryBrief = {
      revision: 1, goal: "Immutable goal", problem: "Validate bytes", success_criteria: ["Fail closed"],
      constraints: ["Local only"], decisions: [], assumptions: [], selected_approach_id: null,
      selected_approach_rationale: null, out_of_scope: [], accepted_risks: [],
      repository_evidence: ["src/workflow/status.ts"],
    };
    await recordReadyBrief(ledger.runDir, brief);
    await writeFile(join(ledger.runDir, "discovery/briefs/revision-001.json"), `${JSON.stringify({
      ...brief, goal: "Tampered immutable goal",
    }, null, 2)}\n`, "utf8");

    expect(await readOperatorStatus(ledger.runDir)).toMatchObject({
      operator_state: "operationally_blocked",
      pending_action: null,
    });
  });

  it("fails closed when canonical pending and immutable brief bytes carry a different nested revision", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-status-brief-revision-"));
    const ledger = await createRunLedgerV2({ repoRoot, originalRequest: "Validate nested brief revision" });
    await transitionRun(ledger.runDir, "preflight", { actor: "test" });
    await transitionRun(ledger.runDir, "brain_discovery", { actor: "test" });
    const brief: DiscoveryBrief = {
      revision: 1, goal: "Revision one", problem: "Validate revision ownership", success_criteria: ["Fail closed"],
      constraints: ["Local only"], decisions: [], assumptions: [], selected_approach_id: null,
      selected_approach_rationale: null, out_of_scope: [], accepted_risks: [],
      repository_evidence: ["src/workflow/status.ts"],
    };
    await recordReadyBrief(ledger.runDir, brief);
    const mismatchedBrief = { ...brief, revision: 2 };
    const briefText = `${JSON.stringify(mismatchedBrief, null, 2)}\n`;
    await writeFile(join(ledger.runDir, "discovery/briefs/revision-001.json"), briefText, "utf8");
    await writeFile(join(ledger.runDir, "discovery/pending-action.json"), `${JSON.stringify({
      state: "awaiting_discovery_brief_approval", revision: 1, brief: mismatchedBrief,
      permitted_next_actions: ["approve-discovery", "revise-discovery"],
    }, null, 2)}\n`, "utf8");
    const manifest = await readManifestV2(ledger.runDir);
    await updateManifestV2(ledger.runDir, {
      discovery: {
        ...manifest.discovery!,
        brief_revisions: {
          "1": {
            ...manifest.discovery!.brief_revisions["1"]!,
            sha256: createHash("sha256").update(briefText).digest("hex"),
          },
        },
      },
    });

    expect(await readOperatorStatus(ledger.runDir)).toMatchObject({
      operator_state: "operationally_blocked",
      pending_action: null,
    });
  });

  it("fails closed when awaiting-approval discovery state already records approval", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-status-brief-approved-"));
    const ledger = await createRunLedgerV2({ repoRoot, originalRequest: "Reject preapproved pending brief" });
    await transitionRun(ledger.runDir, "preflight", { actor: "test" });
    await transitionRun(ledger.runDir, "brain_discovery", { actor: "test" });
    const brief: DiscoveryBrief = {
      revision: 1, goal: "Await approval", problem: "Approval must be unset", success_criteria: ["Fail closed"],
      constraints: ["Local only"], decisions: [], assumptions: [], selected_approach_id: null,
      selected_approach_rationale: null, out_of_scope: [], accepted_risks: [],
      repository_evidence: ["src/workflow/status.ts"],
    };
    await recordReadyBrief(ledger.runDir, brief);
    const manifest = await readManifestV2(ledger.runDir);
    await updateManifestV2(ledger.runDir, {
      discovery: {
        ...manifest.discovery!,
        approved_brief_revision: 1,
        approved_brief_sha256: manifest.discovery!.brief_revisions["1"]!.sha256,
      },
    });

    expect(await readOperatorStatus(ledger.runDir)).toMatchObject({
      operator_state: "operationally_blocked",
      pending_action: null,
    });
  });

  it("fails closed when the selected approach artifact disagrees with pending brief ownership", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-status-brief-selection-"));
    const ledger = await createRunLedgerV2({ repoRoot, originalRequest: "Validate brief selection" });
    await transitionRun(ledger.runDir, "preflight", { actor: "test" });
    await transitionRun(ledger.runDir, "brain_discovery", { actor: "test" });
    const approaches: DiscoveryApproach[] = [
      { id: "approach-local", title: "Local", summary: "Keep local", tradeoffs: ["None"], recommended: true, recommendation_rationale: "Private" },
      { id: "approach-other", title: "Other", summary: "Other option", tradeoffs: ["Different"], recommended: false, recommendation_rationale: null },
    ];
    await recordDiscoveryApproaches(ledger.runDir, 1, approaches);
    await selectDiscoveryApproach(ledger.runDir, 1, "approach-local");
    await recordReadyBrief(ledger.runDir, {
      revision: 1, goal: "Selected local", problem: "Bind selection", success_criteria: ["Fail closed"],
      constraints: ["Local only"], decisions: [], assumptions: [], selected_approach_id: "approach-local",
      selected_approach_rationale: "It is private.", out_of_scope: [], accepted_risks: [],
      repository_evidence: ["src/workflow/status.ts"],
    });
    await writeFile(join(ledger.runDir, "discovery/approaches/revision-001-selection.json"), `${JSON.stringify({
      revision: 1, approach_id: "approach-other",
    }, null, 2)}\n`, "utf8");

    expect(await readOperatorStatus(ledger.runDir)).toMatchObject({
      operator_state: "operationally_blocked",
      pending_action: null,
    });
  });

  it("fails closed when the immutable approaches artifact no longer contains the selected brief approach", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-status-brief-approaches-"));
    const ledger = await createRunLedgerV2({ repoRoot, originalRequest: "Validate selected approach membership" });
    await transitionRun(ledger.runDir, "preflight", { actor: "test" });
    await transitionRun(ledger.runDir, "brain_discovery", { actor: "test" });
    const selected: DiscoveryApproach = {
      id: "approach-local", title: "Local", summary: "Keep local", tradeoffs: ["None"],
      recommended: true, recommendation_rationale: "Private",
    };
    const remaining: DiscoveryApproach = {
      id: "approach-other", title: "Other", summary: "Other option", tradeoffs: ["Different"],
      recommended: false, recommendation_rationale: null,
    };
    await recordDiscoveryApproaches(ledger.runDir, 1, [selected, remaining]);
    await selectDiscoveryApproach(ledger.runDir, 1, selected.id);
    await recordReadyBrief(ledger.runDir, {
      revision: 1, goal: "Selected local", problem: "Bind approach membership", success_criteria: ["Fail closed"],
      constraints: ["Local only"], decisions: [], assumptions: [], selected_approach_id: selected.id,
      selected_approach_rationale: "It is private.", out_of_scope: [], accepted_risks: [],
      repository_evidence: ["src/workflow/status.ts"],
    });
    await writeFile(join(ledger.runDir, "discovery/approaches/revision-001.json"), `${JSON.stringify({
      revision: 1, approaches: [remaining],
    }, null, 2)}\n`, "utf8");

    expect(await readOperatorStatus(ledger.runDir)).toMatchObject({
      operator_state: "operationally_blocked",
      pending_action: null,
    });
  });

  it("fails closed when a brief without a selection retains an approaches revision", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-status-brief-stale-approaches-"));
    const ledger = await createRunLedgerV2({ repoRoot, originalRequest: "Reject stale approach coordinates" });
    await transitionRun(ledger.runDir, "preflight", { actor: "test" });
    await transitionRun(ledger.runDir, "brain_discovery", { actor: "test" });
    await recordReadyBrief(ledger.runDir, {
      revision: 1, goal: "No approach", problem: "No approach was selected", success_criteria: ["Fail closed"],
      constraints: ["Local only"], decisions: [], assumptions: [], selected_approach_id: null,
      selected_approach_rationale: null, out_of_scope: [], accepted_risks: [],
      repository_evidence: ["src/workflow/status.ts"],
    });
    const manifest = await readManifestV2(ledger.runDir);
    await updateManifestV2(ledger.runDir, {
      discovery: { ...manifest.discovery!, current_approaches_revision: 1 },
    });

    expect(await readOperatorStatus(ledger.runDir)).toMatchObject({
      operator_state: "operationally_blocked",
      pending_action: null,
    });
  });

  it("distinguishes an authorized warning continuation", () => {
    const status = projectOperatorStatus(fixture(), {
      active_finding_ids: ["medium-1"],
      latest_decision: "continue_with_warning",
      latest_effect_state: "complete",
      warning_authorized: true,
    });
    expect(status.operator_state).toBe("authorized_warning_continuation");
    expect(renderRunStatus(status)).toContain("Authorized warning continuation");
  });

  it("never projects delivered when terminal assurance is blocked", () => {
    const manifest = fixture({ stage: "delivery", delivery_state: "ready" });
    const status = projectOperatorStatus(manifest, {}, {
      outcome: "blocked", assessed_at: "2026-07-12T00:00:00.000Z",
      approved_plan_revision: 1, approved_plan_sha256: "a".repeat(64), candidate_commit: "b".repeat(40),
      blocker_code: "invalid_final_evidence", blocker: "Evidence is invalid",
      missing_evidence: [], invalid_evidence: ["verification/integrated/attempt-1/evidence.json"],
      zero_attempt_work_items: [], acceptance_path: null,
    });
    expect(status.operator_state).toBe("operationally_blocked");
    expect(status.assurance_outcome).toBe("blocked");
  });

  it("fails closed when supplied verified assurance has no durable manifest pointer", async () => {
    const runDir = await seedInjectedAssuranceStatus();

    const status = await readOperatorStatus(runDir, { assuranceAssessment: verifiedAssessment });

    expect(status.operator_state).toBe("operationally_blocked");
    expect(status.blocker).toMatch(/assurance.*pointer/i);
    expect(status.assurance_assessment).toBeNull();
  });

  it.each([
    ["missing", null],
    ["corrupt", "{}\n"],
    ["mismatched", `${JSON.stringify({ ...verifiedAssessment, candidate_commit: "c".repeat(40) })}\n`],
  ])("fails closed when the supplied assurance artifact is %s", async (_label, artifact) => {
    const runDir = await seedInjectedAssuranceStatus();
    const path = "assurance/status-assessment.json";
    if (artifact !== null) await writeTextArtifact(runDir, path, artifact);
    await updateManifestV2(runDir, {
      assurance_outcome: verifiedAssessment.outcome,
      assurance_assessment_path: path,
    });

    const status = await readOperatorStatus(runDir, { assuranceAssessment: verifiedAssessment });

    expect(status.operator_state).toBe("operationally_blocked");
    expect(status.blocker).toMatch(/status provenance invalid/i);
    expect(status.assurance_assessment).toBeNull();
  });

  it("fails closed when the supplied assurance outcome differs from the manifest", async () => {
    const runDir = await seedInjectedAssuranceStatus();
    const path = "assurance/status-assessment.json";
    await writeTextArtifact(runDir, path, `${JSON.stringify(verifiedAssessment)}\n`);
    await updateManifestV2(runDir, {
      assurance_outcome: "blocked",
      assurance_assessment_path: path,
    });

    const status = await readOperatorStatus(runDir, { assuranceAssessment: verifiedAssessment });

    expect(status.operator_state).toBe("operationally_blocked");
    expect(status.blocker).toMatch(/assurance.*outcome/i);
    expect(status.assurance_assessment).toBeNull();
  });

  it("fails closed when the assurance pointer is outside the owned assurance path", async () => {
    const runDir = await seedInjectedAssuranceStatus();
    const path = "verification/status-assessment.json";
    await writeTextArtifact(runDir, path, `${JSON.stringify(verifiedAssessment)}\n`);
    await updateManifestV2(runDir, {
      assurance_outcome: verifiedAssessment.outcome,
      assurance_assessment_path: path,
    });

    const status = await readOperatorStatus(runDir, { assuranceAssessment: verifiedAssessment });

    expect(status.operator_state).toBe("operationally_blocked");
    expect(status.blocker).toMatch(/assurance\//i);
    expect(status.assurance_assessment).toBeNull();
  });

  it("projects supplied assurance only when it exactly matches durable state", async () => {
    const runDir = await seedInjectedAssuranceStatus();
    const path = "assurance/status-assessment.json";
    await writeTextArtifact(runDir, path, `${JSON.stringify(verifiedAssessment)}\n`);
    await updateManifestV2(runDir, {
      assurance_outcome: verifiedAssessment.outcome,
      assurance_assessment_path: path,
    });

    const status = await readOperatorStatus(runDir, { assuranceAssessment: verifiedAssessment });

    expect(status.operator_state).toBe("awaiting_irreversible_action_authority");
    expect(status.assurance_assessment).toEqual(verifiedAssessment);
  });

  it("keeps a mid-run runtime blocker authoritative over speculative final assurance", () => {
    const status = projectOperatorStatus(
      fixture({
        stage: "verifier_review",
        delivery_state: "blocked",
        last_blocker: "GitHub runtime failed: review evidence binding is invalid",
      }),
      {},
      {
        outcome: "blocked", assessed_at: "2026-07-12T00:00:00.000Z",
        approved_plan_revision: 1, approved_plan_sha256: "a".repeat(64), candidate_commit: "b".repeat(40),
        blocker_code: "dirty_candidate_worktree", blocker: "The candidate worktree is not clean.",
        missing_evidence: [], invalid_evidence: [], zero_attempt_work_items: [], acceptance_path: null,
      },
    );

    expect(status.operator_state).toBe("operationally_blocked");
    expect(status.blocker).toBe("GitHub runtime failed: review evidence binding is invalid");
    expect(status.assurance_outcome).toBeNull();
    expect(status.assurance_assessment).toBeNull();
  });

  it("does not project speculative assurance during final verification", () => {
    const status = projectOperatorStatus(
      fixture({ stage: "final_verification", current_work_item_id: "integrated" }),
      {},
      {
        outcome: "blocked", assessed_at: "2026-07-12T00:00:00.000Z",
        approved_plan_revision: 1, approved_plan_sha256: "a".repeat(64), candidate_commit: "b".repeat(40),
        blocker_code: "dirty_candidate_worktree", blocker: "The candidate worktree is not clean.",
        missing_evidence: [], invalid_evidence: [], zero_attempt_work_items: [], acceptance_path: null,
      },
    );

    expect(status.operator_state).toBe("progressing_automatically");
    expect(status.blocker).toBeNull();
    expect(status.assurance_outcome).toBeNull();
    expect(status.assurance_assessment).toBeNull();
  });

  it("keeps an in-budget release finding automatic while its fix effect remains available", () => {
    const status = projectOperatorStatus(fixture(), {
      active_finding_ids: ["high-1"],
      latest_decision: "fix",
      latest_effect_state: "pending",
      force_release_blocker: true,
    });
    expect(status.operator_state).toBe("progressing_automatically");
    expect(status.next_automatic_effect).toBe("fix");
  });

  it.each([
    ["awaiting_plan_approval", { stage: "awaiting_plan_approval" as const }],
    ["pending replan", { stage: "awaiting_plan_approval" as const, work_item_progress: { item: { status: "blocked" as const, attempts: 1, replan_patch_path: "replans/item.json" } } }],
    ["delivered", { stage: "complete" as const, delivery_state: "complete" as const }],
  ])("gives corrupt operational provenance precedence over %s", (_label, overrides) => {
    const status = projectOperatorStatus(fixture(overrides), {
      operational_blocker: true,
      projection_blocker: "Status provenance invalid: corrupt evidence",
    });
    expect(status.operator_state).toBe("operationally_blocked");
    expect(status.blocker).toContain("corrupt evidence");
  });

  it("fails closed when a manifest review-cycle pointer is missing", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-status-corrupt-"));
    const ledger = await createRunLedgerV2({ repoRoot, originalRequest: "Status corrupt state", slug: "status-corrupt" });
    await updateManifestV2(ledger.runDir, {
      stage: "awaiting_plan_approval",
      current_work_item_id: "item",
      work_item_progress: {
        item: {
          status: "in_progress",
          attempts: 1,
          review_revision: 1,
          review_cycle_path: "reviews/decisions/work-item-aXRlbQ-revision-1.json",
          review_effect_id: `review-effect:${"a".repeat(64)}`,
          replan_patch_path: "replans/item.json",
        },
      },
    });

    const status = await readOperatorStatus(ledger.runDir);
    expect(status.operator_state).toBe("operationally_blocked");
    expect(status.blocker).toMatch(/status provenance invalid|missing/i);
  });

  it("fails closed when the immutable event log is replaced by a symlink", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-status-events-"));
    const ledger = await createRunLedgerV2({ repoRoot, originalRequest: "Status event state", slug: "status-events" });
    const outside = join(repoRoot, "outside-events.jsonl");
    await writeFile(outside, "", "utf8");
    await rm(join(ledger.runDir, "events.jsonl"));
    await symlink(outside, join(ledger.runDir, "events.jsonl"));

    const log = await readRunLog(ledger.runDir);
    expect(log.status.operator_state).toBe("operationally_blocked");
    expect(log.status.blocker).toMatch(/status provenance invalid|symlink/i);
    expect(log.events).toEqual([]);
  });

  it("detects schema-valid review-cycle identity tampering", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-status-cycle-"));
    const ledger = await createLegacyRunLedgerV2({ repoRoot, originalRequest: "Status cycle state", slug: "status-cycle" });
    const plan: BrainPlan = {
      summary: "Status", assumptions: [], research: [], research_sources: [], architecture: "local", risks: [],
      work_items: [executionSpec("item")],
      integration_verification: [["true"]],
    };
    await recordPlan(ledger.runDir, `${JSON.stringify(plan)}\n`);
    await approvePlanRevision(ledger.runDir, 1);
    let manifest = await readManifestV2(ledger.runDir);
    const policy = manifest.review_policy_snapshot!;
    const cycle = await beginReviewCycle({
      run_dir: ledger.runDir,
      work_item_id: "item",
      phase: "work_item",
      review_revision: 1,
      policy_hash: createHash("sha256").update(JSON.stringify(policy)).digest("hex"),
      finding_ids: [],
      accounting_before: manifest.review_accounting!,
      evaluate: () => ({ action: "fix", reason_code: "fix_required", finding_ids: [], policy_revision: policy.policy_revision, authorization_required: false }),
    });
    manifest = await updateManifestV2(ledger.runDir, {
      current_work_item_id: "item",
      work_item_progress: { item: { status: "in_progress", attempts: 1, review_revision: 1, review_cycle_path: cycle.decision_path, review_effect_id: cycle.effect_id } },
    });
    expect((await readOperatorStatus(ledger.runDir)).operator_state).toBe("progressing_automatically");

    await updateManifestV2(ledger.runDir, {
      work_item_progress: { item: { ...manifest.work_item_progress.item!, review_revision: 1, review_cycle_path: undefined, review_effect_id: cycle.effect_id } },
    });
    expect((await readOperatorStatus(ledger.runDir)).operator_state).toBe("operationally_blocked");
    await updateManifestV2(ledger.runDir, {
      work_item_progress: { item: { status: "in_progress", attempts: 1, review_revision: 1, review_cycle_path: cycle.decision_path, review_effect_id: cycle.effect_id } },
    });

    const effectRoot = join(ledger.runDir, "reviews", "effects", Buffer.from(cycle.effect_id, "utf8").toString("base64url"));
    await mkdir(effectRoot, { recursive: true });
    await writeFile(join(effectRoot, "claim.json"), `${JSON.stringify({
      ...cycle,
      effect_state: "complete",
      effect_owner: "runtime:work_item:item",
      effect_result: { attempt: 1, implementation_path: "implementation/item.json" },
    }, null, 2)}\n`, "utf8");
    expect((await readOperatorStatus(ledger.runDir)).blocker).toMatch(/claim must be in_progress/i);
    await rm(join(effectRoot, "claim.json"));

    await writeFile(join(ledger.runDir, cycle.decision_path), `${JSON.stringify({
      ...cycle,
      decision: { ...cycle.decision, reason_code: "schema_valid_tamper" },
    }, null, 2)}\n`, "utf8");
    const status = await readOperatorStatus(ledger.runDir);
    expect(status.operator_state).toBe("operationally_blocked");
    expect(status.blocker).toMatch(/identity|provenance/i);
    expect(manifest.review_accounting?.review_revision).toBe(1);
  });

  it("requires every manifest convergence pointer to resolve", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-status-convergence-"));
    const ledger = await createRunLedgerV2({ repoRoot, originalRequest: "Status convergence state", slug: "status-convergence" });
    await updateManifestV2(ledger.runDir, {
      convergence_reports: {
        item: {
          path: "reviews/convergence/work-item-aXRlbQ-plan-1-review-1.json",
          plan_revision: 1,
          review_revision: 1,
          recommended_action: "stop",
        },
      },
    });
    const status = await readOperatorStatus(ledger.runDir);
    expect(status.operator_state).toBe("operationally_blocked");
    expect(status.blocker).toMatch(/convergence|missing/i);
  });

  it("requires completed non-fix effects to retain their exact convergence pointer", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-status-completed-"));
    const ledger = await createLegacyRunLedgerV2({ repoRoot, originalRequest: "Status completed state", slug: "status-completed" });
    const plan: BrainPlan = {
      summary: "Status", assumptions: [], research: [], research_sources: [], architecture: "local", risks: [],
      work_items: [executionSpec("item")],
      integration_verification: [["true"]],
    };
    await recordPlan(ledger.runDir, `${JSON.stringify(plan)}\n`);
    await approvePlanRevision(ledger.runDir, 1);
    const manifest = await readManifestV2(ledger.runDir);
    const policy = manifest.review_policy_snapshot!;
    const cycle = await beginReviewCycle({
      run_dir: ledger.runDir, work_item_id: "item", phase: "work_item", review_revision: 1,
      policy_hash: createHash("sha256").update(JSON.stringify(policy)).digest("hex"), finding_ids: [], accounting_before: manifest.review_accounting!,
      evaluate: () => ({ action: "advance", reason_code: "approved", finding_ids: [], policy_revision: policy.policy_revision, authorization_required: false }),
    });
    await claimReviewEffect({ run_dir: ledger.runDir, cycle, owner: "runtime:work-item:item" });
    await completeReviewEffect({ run_dir: ledger.runDir, cycle, owner: "runtime:work-item:item", outcome: "complete", result: { commit_sha: "no-op" } });
    await updateManifestV2(ledger.runDir, {
      current_work_item_id: "item",
      work_item_progress: { item: { status: "complete", attempts: 1, review_revision: 1, review_cycle_path: cycle.decision_path, review_effect_id: cycle.effect_id, commit_sha: "no-op" } },
    });
    const status = await readOperatorStatus(ledger.runDir);
    expect(status.operator_state).toBe("operationally_blocked");
    expect(status.blocker).toMatch(/advance.*convergence/i);
  });

  it("reads status and resume guidance from a parent-format ordinary fix marker without rewriting it", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-status-legacy-fix-"));
    const ledger = await createRunLedgerV2({ repoRoot, originalRequest: "Resume an ordinary fix", slug: "status-legacy-fix" });
    const plan: BrainPlan = {
      summary: "Status", assumptions: [], research: [], research_sources: [], architecture: "local", risks: [],
      work_items: [executionSpec("item")],
      integration_verification: [["true"]],
    };
    await recordPlan(ledger.runDir, `${JSON.stringify(plan)}\n`);
    await approvePlanRevision(ledger.runDir, 1);
    const manifest = await readManifestV2(ledger.runDir);
    const policy = manifest.review_policy_snapshot!;
    const cycle = await beginReviewCycle({
      run_dir: ledger.runDir,
      work_item_id: "item",
      phase: "work_item",
      review_revision: 1,
      policy_hash: createHash("sha256").update(JSON.stringify(policy)).digest("hex"),
      finding_ids: [],
      accounting_before: manifest.review_accounting!,
      evaluate: () => ({ action: "fix", reason_code: "fix_required", finding_ids: [], policy_revision: policy.policy_revision, authorization_required: false }),
    });
    const implementationPath = "implementation/item/attempt-2.json";
    await mkdir(join(ledger.runDir, "implementation/item"), { recursive: true });
    await writeFile(join(ledger.runDir, implementationPath), "{}\n", "utf8");
    const owner = "runtime:work-item:item";
    await claimReviewEffect({ run_dir: ledger.runDir, cycle, owner });
    await completeReviewEffect({
      run_dir: ledger.runDir,
      cycle,
      owner,
      outcome: "complete",
      result: { attempt: 2, implementation_path: implementationPath },
    });
    await incrementSuccessfulFix({
      run_dir: ledger.runDir,
      cycle,
      owner,
      mutation_id: implementationPath,
      kind: "successful_fix",
      effect_action: "fix",
    });
    const markerPath = join(
      ledger.runDir,
      "reviews/accounting/fixes",
      `${Buffer.from(cycle.effect_id).toString("base64url")}.json`,
    );
    const marker = JSON.parse(await readFile(markerPath, "utf8"));
    delete marker.effect_action;
    const parentBytes = `${JSON.stringify(marker, null, 2)}\n`;
    await writeFile(markerPath, parentBytes, "utf8");
    await updateManifestV2(ledger.runDir, {
      current_work_item_id: "item",
      work_item_progress: {
        item: {
          status: "in_progress",
          attempts: 2,
          implementation_path: implementationPath,
          review_revision: 1,
          review_cycle_path: cycle.decision_path,
          review_effect_id: cycle.effect_id,
        },
      },
    });

    expect((await readOperatorStatus(ledger.runDir)).operator_state).not.toBe("operationally_blocked");
    await expect(resumeRun({ runDir: ledger.runDir })).resolves.toContain("resume it with brain-hands resume");
    expect(await readFile(markerPath, "utf8")).toBe(parentBytes);
  });

  it("fails closed in status and resume on an interrupted missing-action quality marker", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-status-legacy-quality-"));
    const ledger = await createRunLedgerV2({
      repoRoot,
      originalRequest: "Reject ambiguous quality recovery",
      intake: {
        task: "Reject ambiguous quality recovery",
        repo_root: repoRoot,
        review_policy: { max_fix_cycles: 0 },
        hands_backup: {
          fallback_on_primary_usage_limit: true,
          max_quality_recovery_attempts: 1,
          profile: { model: "backup-hands", reasoning_effort: "medium" },
        },
      },
    });
    const manifest = await readManifestV2(ledger.runDir);
    await updateManifestV2(ledger.runDir, {
      current_work_item_id: "item",
      work_item_progress: {
        item: { status: "in_progress", attempts: 2, quality_recovery_attempts: 0 },
      },
    });
    const policy = manifest.review_policy_snapshot!;
    const cycle = await beginReviewCycle({
      run_dir: ledger.runDir,
      work_item_id: "item",
      phase: "work_item",
      review_revision: 1,
      policy_hash: createHash("sha256").update(JSON.stringify(policy)).digest("hex"),
      finding_ids: [],
      accounting_before: manifest.review_accounting!,
      evaluate: () => ({
        action: "quality_recovery",
        reason_code: "bounded_quality_recovery_available",
        finding_ids: [],
        policy_revision: policy.policy_revision,
        authorization_required: false,
      }),
    });
    const implementationPath = "implementation/item/legacy-quality.json";
    await mkdir(join(ledger.runDir, "implementation/item"), { recursive: true });
    await writeFile(join(ledger.runDir, implementationPath), "{}\n", "utf8");
    const owner = "runtime:work-item:item";
    const input = {
      run_dir: ledger.runDir,
      cycle,
      owner,
      mutation_id: implementationPath,
      kind: "successful_fix" as const,
      effect_action: "quality_recovery" as const,
    };
    await claimReviewEffect(input);
    await completeReviewEffect({
      ...input,
      outcome: "complete",
      result: { attempt: 2, implementation_path: implementationPath },
    });
    await expect(incrementSuccessfulFix(input, {
      afterMarkerPersisted: async () => { throw new Error("crash after status quality marker"); },
    })).rejects.toThrow("crash after status quality marker");
    const markerPath = join(
      ledger.runDir,
      "reviews/accounting/fixes",
      `${Buffer.from(cycle.effect_id).toString("base64url")}.json`,
    );
    const marker = JSON.parse(await readFile(markerPath, "utf8"));
    delete marker.effect_action;
    const markerBytes = `${JSON.stringify(marker, null, 2)}\n`;
    await writeFile(markerPath, markerBytes, "utf8");
    const manifestBefore = await readManifestV2(ledger.runDir);

    const status = await readOperatorStatus(ledger.runDir);
    expect(status.operator_state).toBe("operationally_blocked");
    expect(status.blocker).toMatch(/status provenance invalid|legacy review-effect action|immutable ordinary-fix cycle/i);
    await expect(resumeRun({ runDir: ledger.runDir }))
      .rejects.toThrow(/status provenance invalid|legacy review-effect action|immutable ordinary-fix cycle/i);

    const manifestAfter = await readManifestV2(ledger.runDir);
    expect(manifestAfter.review_accounting).toEqual(manifestBefore.review_accounting);
    expect(manifestAfter.work_item_progress.item?.quality_recovery_attempts)
      .toBe(manifestBefore.work_item_progress.item?.quality_recovery_attempts);
    expect(await readFile(markerPath, "utf8")).toBe(markerBytes);
    await expect(access(join(ledger.runDir, "reviews/accounting/reservations")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not require convergence for a completed quality-recovery effect", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-status-quality-recovery-"));
    const ledger = await createRunLedgerV2({
      repoRoot,
      originalRequest: "Project quality recovery",
      intake: {
        task: "Project quality recovery",
        repo_root: repoRoot,
        review_policy: { max_fix_cycles: 0 },
        hands_backup: {
          fallback_on_primary_usage_limit: true,
          max_quality_recovery_attempts: 1,
          profile: { model: "backup-hands", reasoning_effort: "medium" },
        },
      },
    });
    const plan: BrainPlan = {
      summary: "Status", assumptions: [], research: [], research_sources: [], architecture: "local", risks: [],
      work_items: [executionSpec("item")],
      integration_verification: [["true"]],
    };
    await recordPlan(ledger.runDir, `${JSON.stringify(plan)}\n`);
    await approvePlanRevision(ledger.runDir, 1);
    let manifest = await updateManifestV2(ledger.runDir, {
      current_work_item_id: "item",
      work_item_progress: {
        item: { status: "in_progress", attempts: 2, quality_recovery_attempts: 0 },
      },
    });
    const policy = manifest.review_policy_snapshot!;
    const cycle = await beginReviewCycle({
      run_dir: ledger.runDir,
      work_item_id: "item",
      phase: "work_item",
      review_revision: 1,
      policy_hash: createHash("sha256").update(JSON.stringify(policy)).digest("hex"),
      finding_ids: [],
      accounting_before: manifest.review_accounting!,
      evaluate: () => ({ action: "quality_recovery", reason_code: "bounded_quality_recovery_available", finding_ids: [], policy_revision: policy.policy_revision, authorization_required: false }),
    });
    const implementationPath = "implementation/item/attempt-2.json";
    await mkdir(join(ledger.runDir, "implementation/item"), { recursive: true });
    await writeFile(join(ledger.runDir, implementationPath), "{}\n", "utf8");
    const owner = "runtime:work-item:item";
    await claimReviewEffect({ run_dir: ledger.runDir, cycle, owner });
    await completeReviewEffect({
      run_dir: ledger.runDir,
      cycle,
      owner,
      outcome: "complete",
      result: { attempt: 2, implementation_path: implementationPath },
    });
    await incrementSuccessfulFix({
      run_dir: ledger.runDir,
      cycle,
      owner,
      mutation_id: implementationPath,
      kind: "successful_fix",
      effect_action: "quality_recovery",
    });
    manifest = await readManifestV2(ledger.runDir);
    await updateManifestV2(ledger.runDir, {
      work_item_progress: {
        item: {
          ...manifest.work_item_progress.item!,
          review_revision: 1,
          review_cycle_path: cycle.decision_path,
          review_effect_id: cycle.effect_id,
        },
      },
    });

    const status = await readOperatorStatus(ledger.runDir);
    expect(status.operator_state).not.toBe("operationally_blocked");
    expect(status.latest_decision).toBe("quality_recovery");
    expect(status.latest_effect_state).toBe("complete");
    expect((await readManifestV2(ledger.runDir)).convergence_reports?.item).toBeUndefined();
  });
});

describe("summarizeRunV2", () => {
  it("reports a parent issue separately from child issues", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-parent-status-"));
    const ledger = await createRunLedgerV2({ repoRoot, originalRequest: "Grouped delivery" });
    await updateManifestV2(ledger.runDir, {
      issue_numbers: [14],
      work_item_issue_map: { delivery: 14 },
      github_ids: {
        issue_numbers: [14],
        parent_issue_number: 9,
        work_item_issue_map: { delivery: 14 },
        pull_request_numbers: [],
        pull_request_urls: {},
      },
    });

    const machine = await summarizeRunV2(ledger.runDir);
    const text = await summarizeRun(ledger.runDir);

    expect(machine.parent_issue_number).toBe(9);
    expect(machine.issue_numbers).toEqual([14]);
    expect(machine.work_item_issue_map).toEqual({ delivery: 14 });
    expect(text).toContain("Parent issue: #9");
    expect(text).toContain("Issue numbers: #14");
  });
});

describe("resumeRun", () => {
  it("changes guidance across key workflow stages", async () => {
    const runDir = await seedRun();

    await updateManifest(runDir, { stage: "ready_for_hands", current_issue: 7, current_pr: null });
    const ready = await resumeRun({ runDir });

    await updateManifest(runDir, { stage: "fixing", current_issue: 7, current_pr: 21 });
    const fixing = await resumeRun({ runDir });

    await updateManifest(runDir, { stage: "merge_ready", current_issue: 7, current_pr: 21 });
    const mergeReady = await resumeRun({ runDir });

    await updateManifest(runDir, { stage: "complete", current_issue: 7, current_pr: 21 });
    await writeFile(join(runDir, "final-audit.md"), "# Final Audit\n", "utf8");
    const complete = await resumeRun({ runDir });

    expect(ready).toContain("ready for hands work on issue #7");
    expect(ready).toContain("brain-hands implement");

    expect(fixing).toContain("PR #21 needs fixes for issue #7");
    expect(fixing).toContain("brain-hands fix");

    expect(mergeReady).toContain("merge-ready");
    expect(mergeReady).toContain("brain-hands final-audit");

    expect(complete).toContain("The run is complete.");
    expect(complete).toContain("final-audit.md");
  });
});

describe("finalAudit", () => {
  it("rejects a tampered approved brief before writing final-audit output", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-final-audit-tamper-"));
    const { ledger, approve } = await createPinnedDiscoveryLedger("Bind final audit");
    await transitionRun(ledger.runDir, "preflight"); await transitionRun(ledger.runDir, "brain_discovery");
    const brief: DiscoveryBrief = { revision: 1, goal: "Bind final audit", problem: "Tamper risk", constraints: [], decisions: [], assumptions: [], repository_evidence: ["src/workflow/orchestrator.ts"], success_criteria: ["Reject tamper"], accepted_risks: [], out_of_scope: [], selected_approach_id: null, selected_approach_rationale: null };
    await recordReadyBrief(ledger.runDir, brief); await approveDiscoveryBrief(ledger.runDir, 1);
    const digest = (await readManifestV2(ledger.runDir)).discovery!.approved_brief_sha256!;
    const plan: DiscoveredBrainPlan = { summary: "Bind", assumptions: [], research: [], research_sources: [], architecture: "local", risks: [], work_items: [executionSpec("audit-item")], integration_verification: [["true"]], discovery_brief_revision: 1, discovery_brief_sha256: digest, discovery_decision_coverage: [], accepted_risks: [], out_of_scope: [] };
    await approve(plan);
    await updateManifestV2(ledger.runDir, { stage: "delivery" });
    await writeFile(join(ledger.runDir, "discovery/approved-brief.json"), `${JSON.stringify({ ...brief, goal: "TAMPERED" }, null, 2)}\n`);
    await expect(finalAudit({ runDir: ledger.runDir, repoRoot, config: defaultConfig(), codex: new DryRunCodexAdapter(), dryRun: true }))
      .rejects.toThrow(/discovery brief.*digest/i);
    await expect(access(join(ledger.runDir, "final-audit.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("rejects when manifest is not merge_ready", async () => {
    const runDir = await seedRun();

    await expect(
      finalAudit({
        runDir,
        repoRoot: repoRoot!,
        config: defaultConfig(),
        codex: new DryRunCodexAdapter(),
        dryRun: true,
      }),
    ).rejects.toThrow("manifest.stage to be merge_ready or final_audit");

    const manifest = await readManifest(runDir);
    expect(manifest.stage).toBe("ready_for_hands");
    await expectNoFinalAuditArtifact(runDir);
  });

  it("rejects when there are no PR numbers", async () => {
    const runDir = await seedRun();
    await updateManifest(runDir, {
      stage: "merge_ready",
      current_issue: 7,
      current_pr: 21,
      issue_numbers: [7],
      pr_numbers: [],
    });

    await expect(
      finalAudit({
        runDir,
        repoRoot: repoRoot!,
        config: defaultConfig(),
        codex: new DryRunCodexAdapter(),
        dryRun: true,
      }),
    ).rejects.toThrow("at least one recorded pull request number");

    const manifest = await readManifest(runDir);
    expect(manifest.stage).toBe("merge_ready");
    await expectNoFinalAuditArtifact(runDir);
  });

  it("rejects when verification evidence is missing for recorded issues", async () => {
    const runDir = await seedRun();
    await updateManifest(runDir, {
      stage: "merge_ready",
      current_issue: 7,
      current_pr: 21,
      issue_numbers: [7, 8],
      pr_numbers: [21],
    });

    await expect(
      finalAudit({
        runDir,
        repoRoot: repoRoot!,
        config: defaultConfig(),
        codex: new DryRunCodexAdapter(),
        dryRun: true,
      }),
    ).rejects.toThrow("Missing evidence for: #8");

    const manifest = await readManifest(runDir);
    expect(manifest.stage).toBe("merge_ready");
    await expectNoFinalAuditArtifact(runDir);
  });

  it("rejects when verification evidence is entirely missing", async () => {
    const runDir = await seedRun();
    await rm(join(runDir, "verification"), { recursive: true, force: true });
    await updateManifest(runDir, {
      stage: "merge_ready",
      current_issue: 7,
      current_pr: 21,
      issue_numbers: [],
      pr_numbers: [21],
    });

    await expect(
      finalAudit({
        runDir,
        repoRoot: repoRoot!,
        config: defaultConfig(),
        codex: new DryRunCodexAdapter(),
        dryRun: true,
      }),
    ).rejects.toThrow("non-empty verification evidence");

    const manifest = await readManifest(runDir);
    expect(manifest.stage).toBe("merge_ready");
    await expectNoFinalAuditArtifact(runDir);
  });

  it("renders a read-only final audit from an approved delivered v2 ledger", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-status-v2-"));
    const { ledger, approve } = await createPinnedDiscoveryLedger("Build the v2 status flow");
    await transitionRun(ledger.runDir, "preflight", { actor: "test" });
    await transitionRun(ledger.runDir, "brain_discovery", { actor: "test" });
    const approvedBrief: DiscoveryBrief = {
      revision: 1,
      goal: "Build the v2 status flow",
      problem: "Final audit must read a discovery-bound plan.",
      success_criteria: ["Status delivery remains auditable."],
      constraints: ["Keep the final audit read-only."],
      decisions: [{ id: "d-001", statement: "Implement one status work item.", source_question_ids: [] }],
      assumptions: [], selected_approach_id: null, selected_approach_rationale: null,
      out_of_scope: [], accepted_risks: [], repository_evidence: ["src/workflow/status.ts"],
    };
    await recordReadyBrief(ledger.runDir, approvedBrief);
    await approveDiscoveryBrief(ledger.runDir, approvedBrief.revision);
    const approvedBriefSha256 = (await readManifestV2(ledger.runDir)).discovery?.approved_brief_sha256;
    if (!approvedBriefSha256) throw new Error("Expected an approved discovery brief digest");
    const plan: DiscoveredBrainPlan = {
      feature_slug: "status-flow",
      parent_issue: null,
      summary: "Build the v2 status flow",
      assumptions: [],
      research: [],
      research_sources: [],
      architecture: "local",
      risks: [],
      work_items: [executionSpec("status")],
      integration_verification: [["true"]],
      discovery_brief_revision: approvedBrief.revision,
      discovery_brief_sha256: approvedBriefSha256,
      discovery_decision_coverage: [{
        decision_id: "d-001",
        work_item_ids: ["status"],
        acceptance_ids: ["status-AC-01"],
        verification_command_ids: ["status-VERIFY-01"],
        no_implementation_effect: null,
      }],
      accepted_risks: [...approvedBrief.accepted_risks],
      out_of_scope: [...approvedBrief.out_of_scope],
    };
    await approve(plan);
    await writeTextArtifact(ledger.runDir, "verification/issue-1/attempt-1/evidence.json", `${JSON.stringify({
      issue_number: 1,
      attempt: 1,
      evidence_path: "verification/issue-1/attempt-1/evidence.json",
      commands: [{ command: "true", argv: ["true"], exit_code: 0, timed_out: false, error_code: null, error_message: null, signal: null, stdout_path: "verification/issue-1/attempt-1/command-1.stdout.txt", stderr_path: "verification/issue-1/attempt-1/command-1.stderr.txt" }],
      artifacts: [],
      artifact_checks: [],
      browser_evidence: [],
      created_at: "2026-07-10T12:00:00.000Z",
    })}\n`);
    await updateManifestV2(ledger.runDir, {
      stage: "delivery",
      issue_numbers: [1],
      work_item_issue_map: { status: 1 },
      github_ids: {
        issue_numbers: [1],
        work_item_issue_map: { status: 1 },
        pull_request_numbers: [],
        pull_request_urls: {},
      },
    });

    const report = await finalAudit({
      runDir: ledger.runDir,
      repoRoot,
      config: defaultConfig(),
      codex: new DryRunCodexAdapter(),
      dryRun: true,
    });

    expect(report).toContain("# Final Audit");
    expect(report).toContain("Issue #1: Deliver status without widening scope.");
    expect((await readManifestV2(ledger.runDir)).stage).toBe("delivery");
    expect(await readFile(join(ledger.runDir, "final-audit.md"), "utf8")).toBe(report);
  });

  it("rejects malformed live auditor output without persisting a report", async () => {
    const runDir = await seedRun();
    await updateManifest(runDir, {
      stage: "merge_ready",
      current_issue: 7,
      current_pr: 21,
      issue_numbers: [7],
      pr_numbers: [21],
    });

    await expect(
      finalAudit({
        runDir,
        repoRoot: repoRoot!,
        config: defaultConfig(),
        codex: new RecordingCodexAdapter("not usable markdown"),
        dryRun: false,
      }),
    ).rejects.toThrow("auditor returned unusable Markdown output");

    const manifest = await readManifest(runDir);
    expect(manifest.stage).toBe("final_audit");
    await expectNoFinalAuditArtifact(runDir);
  });

  it("persists final-audit.md and marks the manifest complete during dry-run", async () => {
    const runDir = await seedRun();
    await updateManifest(runDir, {
      stage: "merge_ready",
      current_issue: 7,
      current_pr: 21,
      issue_numbers: [7],
      pr_numbers: [21],
    });

    const report = await finalAudit({
      runDir,
      repoRoot: repoRoot!,
      config: defaultConfig(),
      codex: new DryRunCodexAdapter(),
      dryRun: true,
    });

    const manifest = await readManifest(runDir);
    const storedReport = await readFile(join(runDir, "final-audit.md"), "utf8");

    expect(report).toContain("# Final Audit");
    expect(report).toContain("Issue #7:");
    expect(report).toContain("## Verification evidence reviewed");
    expect(storedReport).toBe(report);
    expect(manifest.stage).toBe("complete");
  });

  it("allows retry from final_audit with a usable live audit report", async () => {
    const runDir = await seedRun();
    await updateManifest(runDir, {
      stage: "final_audit",
      current_issue: 7,
      current_pr: 21,
      issue_numbers: [7],
      pr_numbers: [21],
    });

    const liveReport = [
      "# Final Audit",
      "",
      "## Completed requirements",
      "- Status and resume guidance implemented.",
      "",
      "## Missing requirements",
      "- None.",
      "",
      "## Verification evidence reviewed",
      "- verification/issue-7/evidence.json",
      "",
      "## Residual risks",
      "- Manual merge remains required.",
      "",
      "## Merge recommendation",
      "- Ready for human review and merge.",
      "",
    ].join("\n");

    const report = await finalAudit({
      runDir,
      repoRoot: repoRoot!,
      config: defaultConfig(),
      codex: new RecordingCodexAdapter(liveReport),
      dryRun: false,
    });

    const manifest = await readManifest(runDir);
    const storedReport = await readFile(join(runDir, "final-audit.md"), "utf8");

    expect(report).toBe(liveReport);
    expect(storedReport).toBe(liveReport);
    expect(manifest.stage).toBe("complete");
  });

  it("passes each issue's browser checks into the final auditor prompt payload", async () => {
    const runDir = await seedRun({
      browser_checks: [
        {
          name: "desktop 3d smoke",
          url: "http://127.0.0.1:5177/solar-system-browser/index.html",
          local_server_command: "python3 -m http.server 5177 --bind 127.0.0.1",
          required_selectors: ["#spaceCanvas"],
          console_error_policy: "no_errors",
          expected_network: ["/solar-system-browser/solar-system.js"],
          screenshot_artifact: "reports/solar-3d-desktop.png",
        },
      ],
    });
    await updateManifest(runDir, {
      stage: "merge_ready",
      current_issue: 7,
      current_pr: 21,
      issue_numbers: [7],
      pr_numbers: [21],
    });

    const finalReport = [
      "# Final Audit",
      "",
      "## Completed requirements",
      "- Browser evidence was reviewed.",
      "",
      "## Missing requirements",
      "- None.",
      "",
      "## Verification evidence reviewed",
      "- verification/issue-7/evidence.json",
      "",
      "## Residual risks",
      "- Human merge review required.",
      "",
      "## Merge recommendation",
      "- Manual merge decision required after reviewing the final audit.",
      "",
    ].join("\n");

    const adapter = new RecordingCodexAdapter(finalReport);
    await finalAudit({
      runDir,
      repoRoot: repoRoot!,
      config: defaultConfig(),
      codex: adapter,
      dryRun: false,
    });

    const promptPayload = adapter.invocations[0]?.prompt ?? "";
    expect(promptPayload).toContain('"name": "desktop 3d smoke"');
    expect(promptPayload).toContain('"url": "http://127.0.0.1:5177/solar-system-browser/index.html"');
    expect(promptPayload).toContain('"required_selectors":');
    expect(promptPayload).toContain('"#spaceCanvas"');
    expect(finalReport).toContain("## Completed requirements");
    expect(adapter.invocations).toHaveLength(1);
    expect(adapter.invocations[0]?.artifactName).toBe("brain-final-auditor");
  });
});
