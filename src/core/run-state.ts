import type { GithubEffectsProtocol, ReviewPolicyAction, RunStageV2, WorkflowProtocol } from "./types.js";

/**
 * The only stage transitions the v2 control plane may perform.  Keeping this
 * table in one place makes resume behavior deterministic and prevents a
 * caller from jumping over approval or verification gates.
 */
export const ALLOWED_TRANSITIONS: Readonly<Record<RunStageV2, readonly RunStageV2[]>> = {
  intake: ["preflight"],
  preflight: ["brain_planning"],
  brain_discovery: [],
  awaiting_discovery_answer: [],
  awaiting_discovery_approach: [],
  awaiting_discovery_brief_approval: [],
  brain_planning: ["awaiting_plan_approval"],
  awaiting_plan_approval: ["worktree_setup", "github_issue_sync", "replanning"],
  worktree_setup: ["github_issue_sync", "implementing"],
  awaiting_github_issue_effects: [],
  github_issue_sync: ["worktree_setup", "implementing"],
  implementing: ["verifying"],
  verifying: ["verifier_review"],
  verifier_review: ["verifying", "fixing", "replanning", "implementing", "final_verification", "delivery"],
  fixing: ["verifying", "final_verification"],
  replanning: ["brain_planning", "awaiting_plan_approval"],
  final_verification: ["verifying", "verifier_review"],
  awaiting_github_delivery_effects: [],
  delivery: ["reflecting", "complete"],
  reflecting: ["complete"],
  complete: [],
};

const DURABLE_DISCOVERY_TRANSITIONS: Readonly<Record<RunStageV2, readonly RunStageV2[]>> = {
  ...ALLOWED_TRANSITIONS,
  preflight: ["brain_discovery"],
  brain_discovery: ["awaiting_discovery_answer", "awaiting_discovery_approach", "awaiting_discovery_brief_approval"],
  awaiting_discovery_answer: ["brain_discovery"],
  awaiting_discovery_approach: ["brain_discovery"],
  awaiting_discovery_brief_approval: ["brain_discovery", "brain_planning"],
  brain_planning: ["brain_discovery", "awaiting_plan_approval"],
};

const TASK_LINEAGE_TRANSITIONS: Readonly<Record<RunStageV2, readonly RunStageV2[]>> = {
  ...ALLOWED_TRANSITIONS,
  awaiting_plan_approval: ["worktree_setup", "replanning"],
  worktree_setup: ["awaiting_github_issue_effects", "implementing"],
  awaiting_github_issue_effects: ["github_issue_sync"],
  github_issue_sync: ["implementing"],
  final_verification: ["verifying", "verifier_review", "awaiting_github_delivery_effects"],
  awaiting_github_delivery_effects: ["final_verification"],
};

const DURABLE_DISCOVERY_TASK_LINEAGE_TRANSITIONS: Readonly<Record<RunStageV2, readonly RunStageV2[]>> = {
  ...DURABLE_DISCOVERY_TRANSITIONS,
  awaiting_plan_approval: ["worktree_setup", "replanning"],
  worktree_setup: ["awaiting_github_issue_effects", "implementing"],
  awaiting_github_issue_effects: ["github_issue_sync"],
  github_issue_sync: ["implementing"],
  final_verification: ["verifying", "verifier_review", "awaiting_github_delivery_effects"],
  awaiting_github_delivery_effects: ["final_verification"],
};

export function usesDurableDiscoveryProtocol(protocol: WorkflowProtocol): boolean {
  return protocol === "durable-discovery-v1" || protocol === "bounded-context-v1";
}

export function assertTransition(
  from: RunStageV2,
  to: RunStageV2,
  workflowProtocol: WorkflowProtocol = "legacy-v2",
  githubEffectsProtocol: GithubEffectsProtocol = "legacy-run-v1",
): void {
  const transitions = githubEffectsProtocol === "task-lineage-v1"
    ? usesDurableDiscoveryProtocol(workflowProtocol)
      ? DURABLE_DISCOVERY_TASK_LINEAGE_TRANSITIONS
      : TASK_LINEAGE_TRANSITIONS
    : usesDurableDiscoveryProtocol(workflowProtocol)
      ? DURABLE_DISCOVERY_TRANSITIONS
      : ALLOWED_TRANSITIONS;
  if (!transitions[from].includes(to)) {
    throw new Error(`Illegal run stage transition for ${workflowProtocol}/${githubEffectsProtocol}: ${from} -> ${to}`);
  }
}

/** The stage mutation, if any, owned by a persisted work-item policy effect. */
export function workItemDecisionTransition(action: ReviewPolicyAction): RunStageV2 | null {
  if (action === "fix" || action === "quality_recovery") return "fixing";
  if (action === "create_replan" || action === "await_plan_approval") return "replanning";
  return null;
}
