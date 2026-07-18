import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, rename, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { executionSpec } from "../fixtures/execution-spec.js";
import {
  approvalSha256,
  buildPlanApprovalRequest,
  canonicalApprovalJson,
  readVerifiedPlanApprovalRequest,
  renderPlanApprovalRequest,
  requestSha256,
  serializePlanApprovalRequest,
  writePlanApprovalRequest,
} from "../../src/core/plan-approval.js";
import {
  resolvedRunConfigurationSchema,
  runConfigurationSha256,
} from "../../src/core/run-configuration.js";
import { planApprovalRequestSchema } from "../../src/core/schema.js";
import type {
  BrainPlan,
  PlanApprovalReasonCode,
  RunManifestV2,
} from "../../src/core/types.js";
import {
  buildPlanDelta,
  planDecisionContractSha256,
} from "../../src/workflow/plan-delta.js";

function fixturePlan(): BrainPlan {
  return {
    feature_slug: "approval",
    parent_issue: null,
    summary: "Approve one exact plan.",
    assumptions: ["The run stays local."],
    research: ["Inspected the ledger."],
    research_sources: ["src/core/ledger.ts"],
    architecture: "Persist a deterministic approval request.",
    risks: ["A stale controller could approve the wrong subject."],
    controller_bootstrap: null,
    work_items: [executionSpec("BH-005")],
    integration_verification: [["npm", "test"]],
  };
}

function fixturePlanWithReorderedObjectKeys(): BrainPlan {
  const plan = fixturePlan();
  return {
    integration_verification: plan.integration_verification,
    work_items: plan.work_items.map((item) => ({
      ambiguity_policy: item.ambiguity_policy,
      completion_contract: item.completion_contract,
      risks: item.risks,
      browser_checks: item.browser_checks,
      expected_artifacts: item.expected_artifacts,
      cross_cutting_impacts: item.cross_cutting_impacts,
      verification_commands: item.verification_commands,
      tests: item.tests,
      acceptance: item.acceptance,
      change_units: item.change_units,
      forbidden_changes: item.forbidden_changes,
      file_contract: item.file_contract,
      dependencies: item.dependencies,
      objective: item.objective,
      title: item.title,
      id: item.id,
      schema_version: item.schema_version,
    })),
    controller_bootstrap: plan.controller_bootstrap,
    risks: plan.risks,
    architecture: plan.architecture,
    research_sources: plan.research_sources,
    research: plan.research,
    assumptions: plan.assumptions,
    summary: plan.summary,
    parent_issue: plan.parent_issue,
    feature_slug: plan.feature_slug,
  };
}

const runConfiguration = resolvedRunConfigurationSchema.parse({
  version: 1,
  repository: "/tmp/repo",
  mode: "local",
  research: true,
  reflection: false,
  controller: {
    package_name: "@ngelik/brain-hands",
    package_version: "0.3.5",
    mode: "installed",
  },
  roles: {
    brain: { model: "brain", reasoning_effort: "high", sandbox: "read-only", source: "repository_config" },
    hands: { model: "hands", reasoning_effort: "xhigh", sandbox: "workspace-write", source: "repository_config" },
    verifier: { model: "verifier", reasoning_effort: "high", sandbox: "read-only", source: "repository_config" },
  },
  hands_backup: null,
  limits: {
    max_hands_fix_attempts: 3,
    max_replan_attempts: 2,
    review_policy: {
      policy_revision: 1,
      max_fix_cycles: 2,
      on_limit: "auto_replan",
      auto_advance_on_approval: true,
      severity_defaults: {
        critical: "blocking",
        high: "blocking",
        medium: "fix_in_scope",
        low: "advisory",
      },
      pause_on: ["plan_approval"],
    },
    quality_gate: null,
  },
  github: { effects: "none", default_remote: "origin" },
});

function fixtureManifest(overrides: Partial<RunManifestV2> = {}): RunManifestV2 {
  return {
    version: 2,
    schema_version: 2,
    run_id: "run-approval",
    original_request: "Add deterministic approval requests",
    repo_root: "/tmp/repo",
    created_at: "2026-07-16T12:00:00.000Z",
    updated_at: "2026-07-16T12:00:00.000Z",
    stage: "awaiting_plan_approval",
    workflow_protocol: "durable-discovery-v1",
    task_lineage_id: null,
    github_effects_protocol: "legacy-run-v1",
    github_effects: { issue_sync: null, pull_request_delivery: null },
    github_cleanup: null,
    discovery: {
      cycle: 1,
      cycle_kind: "initial",
      asked_questions: 0,
      answered_questions: 0,
      current_question_id: null,
      current_approaches_revision: null,
      selected_approach_id: null,
      current_brief_revision: 1,
      current_readiness_revision: 1,
      approved_brief_revision: 1,
      approved_brief_sha256: "b".repeat(64),
      proceed_with_assumptions: null,
      pending_action_path: null,
      question_artifacts: {},
      answer_artifacts: {},
      readiness_revisions: {},
      brief_revisions: {},
    },
    current_work_item_id: null,
    retry_counts: {},
    issue_numbers: [],
    pull_request_numbers: [],
    events: [],
    mode: "local",
    run_mode: "local",
    active_hands_profile: "primary",
    backup_activation_reason: null,
    role_profiles: {},
    selected_role_profiles: {},
    current_revision: 1,
    approved_revision: null,
    current_plan_revision: 1,
    approved_plan_revision: null,
    plan_revisions: {},
    pending_plan_approval: null,
    run_configuration_sha256: runConfigurationSha256(runConfiguration),
    source_commit: "a".repeat(40),
    worktree_path: null,
    branch_name: null,
    work_item_progress: {},
    work_item_issue_map: {},
    github_ids: { issue_numbers: [], pull_request_numbers: [], pull_request_urls: {} },
    delivery_state: "pending",
    assurance_outcome: null,
    assurance_assessment_path: null,
    risk_acceptance_path: null,
    risk_acceptance_history: [],
    abandonment_path: null,
    terminal: null,
    final_artifact_paths: [],
    last_blocker: null,
    intake_path: "intake.json",
    controller_provenance: {
      self_hosting: false,
      mode: "installed",
      executable_path: "/controller/dist/cli.js",
      package_root: "/controller",
      package_name: "@ngelik/brain-hands",
      package_version: "0.3.5",
      package_hash_algorithm: "sha256",
      package_hash: "c".repeat(64),
      candidate_commit: "a".repeat(40),
    },
    brain_controller_claim: null,
    planning_recovery: null,
    recovery: { version: 1, active_scope: null, scopes: {} },
    task_lineage: null,
    controller_recovery: { version: 1, transition_count: 0, head_path: null },
    ...overrides,
  };
}

function requestInput(overrides: {
  plan?: BrainPlan;
  manifest?: RunManifestV2;
  configuration?: typeof runConfiguration;
  reasonCode?: PlanApprovalReasonCode;
} = {}) {
  const plan = overrides.plan ?? fixturePlan();
  const manifest = overrides.manifest ?? fixtureManifest();
  const configuration = overrides.configuration ?? runConfiguration;
  const planBytes = `${canonicalApprovalJson(plan)}\n`;
  return {
    manifest,
    runConfiguration: configuration,
    reasonCode: overrides.reasonCode ?? "initial_plan" as const,
    revision: 1,
    baseRevision: null,
    planPath: "plans/revision-1.md",
    planSha256: createHash("sha256").update(planBytes, "utf8").digest("hex"),
    decisionContractSha256: planDecisionContractSha256(plan),
    delta: buildPlanDelta(null, plan, { baseRevision: null, proposedRevision: 1 }),
  };
}

describe("canonical plan approval requests", () => {
  it("sorts object keys recursively while preserving array order", () => {
    expect(canonicalApprovalJson({ z: 1, nested: { b: 2, a: 1 }, list: [{ y: 2, x: 1 }, 3] }))
      .toBe('{"list":[{"x":1,"y":2},3],"nested":{"a":1,"b":2},"z":1}');
    expect(approvalSha256({ values: [1, 2] })).not.toBe(approvalSha256({ values: [2, 1] }));
  });

  it("binds every stable authorization input but ignores object key order", () => {
    const first = buildPlanApprovalRequest(requestInput({ plan: fixturePlan() }));
    const reordered = buildPlanApprovalRequest(requestInput({ plan: fixturePlanWithReorderedObjectKeys() }));
    expect(first.approval_subject_sha256).toBe(reordered.approval_subject_sha256);

    const changedPlan = fixturePlan();
    changedPlan.summary = "Changed exact plan bytes.";
    const changedConfiguration = resolvedRunConfigurationSchema.parse({
      ...runConfiguration,
      reflection: true,
    });
    const mutations = [
      requestInput({ plan: changedPlan }),
      requestInput({ manifest: fixtureManifest({
        discovery: { ...fixtureManifest().discovery!, approved_brief_sha256: "d".repeat(64) },
      }) }),
      requestInput({ manifest: fixtureManifest({ source_commit: "e".repeat(40) }) }),
      requestInput({
        configuration: changedConfiguration,
        manifest: fixtureManifest({ run_configuration_sha256: runConfigurationSha256(changedConfiguration) }),
      }),
      requestInput({ manifest: fixtureManifest({
        controller_provenance: { ...fixtureManifest().controller_provenance!, package_hash: "f".repeat(64) },
      }) }),
      requestInput({ manifest: fixtureManifest({
        review_policy_snapshot: { ...runConfiguration.limits.review_policy, on_limit: "stop" },
      }) }),
    ];
    for (const mutation of mutations) {
      expect(buildPlanApprovalRequest(mutation).approval_subject_sha256)
        .not.toBe(first.approval_subject_sha256);
    }
  });

  it("keeps explanation copy outside both digests and binds reason codes", () => {
    const initial = buildPlanApprovalRequest(requestInput());
    const replan = buildPlanApprovalRequest(requestInput({ reasonCode: "material_replan" }));
    const rendered = renderPlanApprovalRequest(initial);
    const revisedControllerCopy = rendered.replace("Initial plan", "First executable plan");

    expect(initial).toMatchObject({
      gate: "initial_plan",
      requested_revision: 1,
      base_revision: null,
      artifact_path: "plans/revision-1.md",
      artifact_sha256: initial.subject.plan_sha256,
      fresh_approval_required: true,
      reuse_reason: null,
      reason_code: "initial_plan",
      reason: "The exact initial plan must be approved before implementation begins.",
    });
    expect(replan.gate).toBe("replan");
    expect(replan.reason_code).toBe("material_replan");
    expect(revisedControllerCopy).not.toBe(rendered);
    expect(rendered).toContain("Why: The exact initial plan must be approved before implementation begins.");
    expect(renderPlanApprovalRequest(replan)).toContain(
      "Why: Verifier findings require changes outside the currently approved decision contract.",
    );
    expect(initial).not.toHaveProperty("explanation");
    expect(requestSha256(initial)).toBe(
      createHash("sha256").update(serializePlanApprovalRequest(initial), "utf8").digest("hex"),
    );
    expect(replan.approval_subject_sha256).not.toBe(initial.approval_subject_sha256);
    expect(requestSha256(replan)).not.toBe(requestSha256(initial));
  });

  it("uses a strict request schema", () => {
    const request = buildPlanApprovalRequest(requestInput());
    expect(() => planApprovalRequestSchema.parse({ ...request, unknown: true })).toThrow();
    expect(() => planApprovalRequestSchema.parse({
      ...request,
      subject: { ...request.subject, unknown: true },
    })).toThrow();
  });

  it("writes canonical bytes once and verifies the pending manifest binding", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "brain-hands-plan-approval-"));
    const request = buildPlanApprovalRequest(requestInput());
    const written = await writePlanApprovalRequest(runDir, request);
    expect(written).toEqual({
      path: "approvals/plan/revision-1.json",
      sha256: requestSha256(request),
    });
    expect(await readFile(join(runDir, written.path), "utf8")).toBe(serializePlanApprovalRequest(request));
    await expect(writePlanApprovalRequest(runDir, request)).rejects.toThrow();

    const manifest = fixtureManifest({
      plan_revisions: {
        "1": {
          revision: 1,
          path: "plans/revision-1.md",
          sha256: request.subject.plan_sha256,
          approval_request_path: written.path,
          approval_request_sha256: written.sha256,
          approval_subject_sha256: request.approval_subject_sha256,
          decision_contract_sha256: request.subject.decision_contract_sha256,
        },
      },
      pending_plan_approval: {
        schema_version: 1,
        proposed_revision: 1,
        base_revision: null,
        request_path: written.path,
        request_sha256: written.sha256,
        approval_subject_sha256: request.approval_subject_sha256,
      },
    });
    await expect(readVerifiedPlanApprovalRequest(runDir, manifest)).resolves.toEqual(request);

    await writeFile(join(runDir, written.path), `${serializePlanApprovalRequest(request)} `);
    await expect(readVerifiedPlanApprovalRequest(runDir, manifest)).rejects.toThrow(/digest|canonical/i);
  });

  it("rejects approval parent swaps before write and read access", async () => {
    const request = buildPlanApprovalRequest(requestInput());
    const writeRunDir = await mkdtemp(join(tmpdir(), "brain-hands-plan-approval-swap-write-"));
    const outsideWrite = await mkdtemp(join(tmpdir(), "brain-hands-plan-approval-outside-write-"));
    await mkdir(join(writeRunDir, "approvals", "plan"), { recursive: true });
    await mkdir(join(outsideWrite, "plan"));
    const outsideTarget = join(outsideWrite, "plan", "revision-1.json");
    const outsideBytes = Buffer.from([0, 1, 2, 255, 10]);
    await writeFile(outsideTarget, outsideBytes);

    await expect(writePlanApprovalRequest(writeRunDir, request, {
      afterRequestOpen: async () => {
        await rename(join(writeRunDir, "approvals"), join(writeRunDir, "approvals-saved"));
        await symlink(outsideWrite, join(writeRunDir, "approvals"), "dir");
      },
    })).rejects.toThrow(/identity|symlink|escaped/i);
    expect(await readdir(join(outsideWrite, "plan"))).toEqual(["revision-1.json"]);
    expect(await readFile(outsideTarget)).toEqual(outsideBytes);

    const readRunDir = await mkdtemp(join(tmpdir(), "brain-hands-plan-approval-swap-read-"));
    const written = await writePlanApprovalRequest(readRunDir, request);
    const outsideRead = await mkdtemp(join(tmpdir(), "brain-hands-plan-approval-outside-read-"));
    await mkdir(join(outsideRead, "plan"));
    await writeFile(join(outsideRead, "plan", "revision-1.json"), serializePlanApprovalRequest(request));
    const manifest = fixtureManifest({
      plan_revisions: {
        "1": {
          revision: 1,
          path: request.plan_path,
          sha256: request.subject.plan_sha256,
          approval_request_path: written.path,
          approval_request_sha256: written.sha256,
          approval_subject_sha256: request.approval_subject_sha256,
          decision_contract_sha256: request.subject.decision_contract_sha256,
        },
      },
      pending_plan_approval: {
        schema_version: 1,
        proposed_revision: 1,
        base_revision: null,
        request_path: written.path,
        request_sha256: written.sha256,
        approval_subject_sha256: request.approval_subject_sha256,
      },
    });

    await expect(readVerifiedPlanApprovalRequest(readRunDir, manifest, {
      afterRequestOpen: async () => {
        await rename(join(readRunDir, "approvals"), join(readRunDir, "approvals-saved"));
        await symlink(outsideRead, join(readRunDir, "approvals"), "dir");
      },
    })).rejects.toThrow(/identity|symlink|escaped/i);
  });

  it("rejects a canonical request replacement after write descriptor open", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "brain-hands-plan-approval-file-swap-write-"));
    const request = buildPlanApprovalRequest(requestInput());
    const target = join(runDir, "approvals", "plan", "revision-1.json");
    const saved = `${target}.saved`;
    const replacement = Buffer.from("replacement-request-bytes\n", "utf8");

    await expect(writePlanApprovalRequest(runDir, request, {
      afterRequestOpen: async () => {
        await rename(target, saved);
        await writeFile(target, replacement);
      },
    })).rejects.toThrow(/identity|changed/i);
    expect(await readFile(target)).toEqual(replacement);
  });

  it("rejects a canonical request replacement after read descriptor open", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "brain-hands-plan-approval-file-swap-read-"));
    const request = buildPlanApprovalRequest(requestInput());
    const written = await writePlanApprovalRequest(runDir, request);
    const target = join(runDir, written.path);
    const saved = `${target}.saved`;
    const replacement = Buffer.from("replacement-request-bytes\n", "utf8");
    const manifest = fixtureManifest({
      plan_revisions: {
        "1": {
          revision: 1,
          path: request.plan_path,
          sha256: request.subject.plan_sha256,
          approval_request_path: written.path,
          approval_request_sha256: written.sha256,
          approval_subject_sha256: request.approval_subject_sha256,
          decision_contract_sha256: request.subject.decision_contract_sha256,
        },
      },
      pending_plan_approval: {
        schema_version: 1,
        proposed_revision: 1,
        base_revision: null,
        request_path: written.path,
        request_sha256: written.sha256,
        approval_subject_sha256: request.approval_subject_sha256,
      },
    });

    await expect(readVerifiedPlanApprovalRequest(runDir, manifest, {
      afterRequestOpen: async () => {
        await rename(target, saved);
        await writeFile(target, replacement);
      },
    })).rejects.toThrow(/identity|changed/i);
    expect(await readFile(target)).toEqual(replacement);
  });

  it("removes a partial request and preserves the write error so retry can succeed", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "brain-hands-plan-approval-write-failure-"));
    const request = buildPlanApprovalRequest(requestInput());
    const failure = new Error("injected request write failure");

    await expect(writePlanApprovalRequest(runDir, request, {
      beforeRequestWrite: async () => { throw failure; },
    })).rejects.toBe(failure);
    await expect(access(join(runDir, "approvals", "plan", "revision-1.json")))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(writePlanApprovalRequest(runDir, request)).resolves.toMatchObject({
      path: "approvals/plan/revision-1.json",
    });
  });
});
