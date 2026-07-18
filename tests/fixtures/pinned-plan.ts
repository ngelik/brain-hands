import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  approvePlanRevision,
  readManifestV2,
  recordPlan,
  transitionRun,
  type ApprovalControllerCapture,
} from "../../src/core/ledger.js";
import {
  approveDiscoveryBrief,
  recordDiscoveryBrief,
  recordDiscoveryReadiness,
} from "../../src/core/discovery-ledger.js";
import {
  buildPlanApprovalRequest,
  planDecisionContractSha256,
  requestSha256,
  serializePlanApprovalRequest,
} from "../../src/core/plan-approval.js";
import { buildPlanDelta } from "../../src/core/plan-delta.js";
import {
  resolvedRunConfigurationSchema,
  runConfigurationSha256,
} from "../../src/core/run-configuration.js";
import { serializePersistedPlan } from "../../src/core/execution-spec.js";
import type { BrainPlan, DiscoveredBrainPlan, DiscoveryBrief } from "../../src/core/types.js";

function isDiscoveredPlan(plan: BrainPlan): plan is DiscoveredBrainPlan {
  return "discovery_brief_revision" in plan;
}

/** Record the smallest valid durable-discovery history needed by pinned-plan fixtures. */
export async function recordApprovedDiscoveryForPlan(
  runDir: string,
  plan: BrainPlan,
): Promise<DiscoveredBrainPlan> {
  let manifest = await readManifestV2(runDir);
  if ((manifest.workflow_protocol !== "durable-discovery-v1"
    && manifest.workflow_protocol !== "bounded-context-v1") || manifest.discovery === null) {
    throw new Error("Pinned initial approvals require a durable-discovery test ledger");
  }
  if (manifest.discovery.approved_brief_revision === null) {
    if (manifest.stage !== "brain_discovery") {
      throw new Error("Pinned discovery fixtures must start in brain_discovery");
    }
    const brief: DiscoveryBrief = {
      revision: 1,
      goal: manifest.original_request,
      problem: "The approved plan must remain bound to durable discovery.",
      success_criteria: ["The approved plan is executed with pinned runtime authority."],
      constraints: [],
      decisions: [],
      assumptions: [],
      selected_approach_id: null,
      selected_approach_rationale: null,
      out_of_scope: [],
      accepted_risks: [],
      repository_evidence: ["tests/fixtures/pinned-plan.ts"],
    };
    await recordDiscoveryReadiness(runDir, {
      outcome: "no_discovery_needed",
      rationale: "The test fixture has a deterministic approved boundary.",
      repository_evidence: ["tests/fixtures/pinned-plan.ts"],
      approaches: [],
      alternatives_omitted_reason: "No alternative is needed for this focused fixture.",
      brief,
    });
    await recordDiscoveryBrief(runDir, brief);
    await approveDiscoveryBrief(runDir, brief.revision);
    manifest = await readManifestV2(runDir);
  }
  if (manifest.discovery === null) throw new Error("Pinned discovery fixture lost its durable state");
  const revision = manifest.discovery.approved_brief_revision;
  const sha256 = manifest.discovery.approved_brief_sha256;
  if (revision === null || sha256 === null) throw new Error("Pinned discovery fixture was not approved");
  if (isDiscoveredPlan(plan)) return plan;
  Object.assign(plan, {
    discovery_brief_revision: revision,
    discovery_brief_sha256: sha256,
    discovery_decision_coverage: [],
    accepted_risks: [],
    out_of_scope: [],
  });
  return plan as DiscoveredBrainPlan;
}

/** Record a genuine durable-discovery pinned initial approval. */
export async function recordAndApprovePinnedInitialPlan(
  runDir: string,
  plan: BrainPlan,
  approvalControllerCapture: ApprovalControllerCapture,
) {
  const manifestBeforeRecord = await readManifestV2(runDir);
  const pinnedPlan = await recordApprovedDiscoveryForPlan(runDir, plan);
  const planText = serializePersistedPlan(pinnedPlan, manifestBeforeRecord.workflow_protocol);
  const recorded = await recordPlan(runDir, planText);
  const manifest = await readManifestV2(runDir);
  const runConfiguration = resolvedRunConfigurationSchema.parse(
    JSON.parse(await readFile(join(runDir, "run-configuration.json"), "utf8")),
  );
  const request = buildPlanApprovalRequest({
    manifest,
    runConfiguration,
    reasonCode: "initial_plan",
    revision: recorded.revision,
    baseRevision: null,
    planPath: recorded.path,
    planSha256: recorded.sha256,
    decisionContractSha256: planDecisionContractSha256(pinnedPlan),
    delta: buildPlanDelta(null, pinnedPlan, { baseRevision: null, proposedRevision: recorded.revision }),
    reconstructInitialAuthority: true,
  });
  const requestPath = `approvals/plan/revision-${recorded.revision}.json`;
  const pending = {
    schema_version: 1 as const,
    proposed_revision: recorded.revision,
    base_revision: null,
    request_path: requestPath,
    request_sha256: requestSha256(request),
    approval_subject_sha256: request.approval_subject_sha256,
  };
  await mkdir(dirname(join(runDir, requestPath)), { recursive: true });
  await writeFile(join(runDir, requestPath), serializePlanApprovalRequest(request));
  await writeFile(join(runDir, "manifest.json"), `${JSON.stringify({
    ...manifest,
    stage: "awaiting_plan_approval",
    approved_revision: null,
    approved_plan_revision: null,
    worktree_path: join(manifest.repo_root, ".brain-hands", "worktrees", manifest.run_id),
    branch_name: `codex/brain-hands/${manifest.run_id}`,
    approval_protocol_version: 1,
    approval_protocol_start_revision: 1,
    run_configuration_sha256: runConfigurationSha256(runConfiguration),
    plan_revisions: {
      ...manifest.plan_revisions,
      [String(recorded.revision)]: {
        ...manifest.plan_revisions[String(recorded.revision)],
        origin: "initial",
        base_revision: null,
        approval_request_path: requestPath,
        approval_request_sha256: pending.request_sha256,
        approval_subject_sha256: pending.approval_subject_sha256,
        decision_contract_sha256: planDecisionContractSha256(pinnedPlan),
      },
    },
    pending_plan_approval: pending,
  }, null, 2)}\n`);
  await approvePlanRevision(runDir, recorded.revision, {
    actor: "human",
    approvalControllerCapture,
  });
  await transitionRun(runDir, "worktree_setup", { actor: "test" });
  return recorded;
}
