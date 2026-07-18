import { reviewerActionQueueSchema } from "../core/schema.js";
import { z } from "zod";
import type {
  ActionResolutionDecision,
  QualityGatePolicy,
  QueueCostEstimate,
  OperationalBlocker,
  ReviewerAction,
  ReviewerActionQueue,
  VerifierFinding,
  VerifierReview,
  WorkItem,
} from "../core/types.js";
import { fingerprintFinding } from "./findings.js";

export type FixEffectResult =
  | { kind: "complete"; successful_hands_fixes: number; evidence_paths: string[] }
  | { kind: "still_blocking"; successful_hands_fixes: number; evidence_paths: string[] }
  | { kind: "operationally_blocked"; blocker: OperationalBlocker };

const fixEffectResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("complete"), successful_hands_fixes: z.number().int().nonnegative(), evidence_paths: z.array(z.string().trim().min(1)) }).strict(),
  z.object({ kind: z.literal("still_blocking"), successful_hands_fixes: z.number().int().nonnegative(), evidence_paths: z.array(z.string().trim().min(1)) }).strict(),
  z.object({
    kind: z.literal("operationally_blocked"),
    blocker: z.object({
      code: z.enum(["invalid_verifier_contract", "transport_failure", "permission_failure", "network_failure", "catalog_failure", "test_infrastructure_failure", "corrupt_state"]),
      message: z.string().trim().min(1),
      phase: z.enum(["work_item", "final_integrated", "post_pr"]),
      evidence_refs: z.array(z.string().trim().min(1)),
    }).strict(),
  }).strict(),
]);

export function parseFixEffectResult(value: unknown): FixEffectResult {
  return fixEffectResultSchema.parse(value);
}

export type QueueTransition =
  | { kind: "activate" | "retry"; action_id: string; attempt: number }
  | {
    kind: "block";
    blocker_code: "action_fix_exhausted" | "invalid_reviewer_action_queue";
  }
  | { kind: "replan" }
  | { kind: "full_review" };

export interface NextQueueActionInput {
  readonly queue: ReviewerActionQueue;
  readonly completedActionIds: readonly string[];
  readonly activeActionId: string | null;
  readonly activeActionAttempt: number;
  readonly focusedDecision: Exclude<ActionResolutionDecision, "blocked"> | null;
  readonly maxAttemptsPerAction: number;
}

const invalidQueueTransition: QueueTransition = {
  kind: "block",
  blocker_code: "invalid_reviewer_action_queue",
};

function hasActionMetadata(finding: VerifierFinding): finding is ReviewerAction {
  const candidate = finding as Partial<ReviewerAction>;
  return typeof candidate.action_id === "string"
    && typeof candidate.order === "number"
    && Array.isArray(candidate.depends_on);
}

export function validateReviewerActionQueue(
  queue: ReviewerActionQueue,
): ReviewerActionQueue {
  const parsed = reviewerActionQueueSchema.parse(queue);
  const remediationCount = parsed.actions.filter((action) => "remediation" in action && action.remediation !== undefined).length;
  if (parsed.contract_version === "review_fix_packet_v1" && remediationCount !== parsed.actions.length) {
    throw new Error("review_fix_packet_v1 queues require remediation on every action");
  }
  if (parsed.contract_version === undefined && remediationCount > 0) {
    throw new Error("unversioned legacy queues cannot contain remediation");
  }
  const seenIds = new Set<string>();

  for (const [index, action] of parsed.actions.entries()) {
    if (seenIds.has(action.action_id)) {
      throw new Error(`duplicate action_id: ${action.action_id}`);
    }
    if (action.order !== index + 1) {
      throw new Error("action orders must be contiguous and match queue order");
    }
    const expectedActionId = `R${parsed.review_revision}-A${action.order}`;
    if (action.action_id !== expectedActionId) {
      throw new Error(`action_id must be ${expectedActionId}`);
    }
    for (const dependency of action.depends_on) {
      if (!seenIds.has(dependency)) {
        throw new Error(
          `action ${action.action_id} must depend only on an earlier action`,
        );
      }
    }
    seenIds.add(action.action_id);
  }

  return parsed;
}

export function normalizeReviewerActions(
  review: VerifierReview,
  revision: number,
): ReviewerActionQueue {
  const actions = review.findings.map((finding, index): ReviewerAction => {
    if (hasActionMetadata(finding)) {
      return finding;
    }

    return {
      ...finding,
      action_id: `R${revision}-A${index + 1}`,
      order: index + 1,
      depends_on: [],
    };
  });

  return validateReviewerActionQueue({
    ...(actions.length > 0 && actions.every((action) => action.remediation !== undefined)
      ? { contract_version: "review_fix_packet_v1" as const }
      : {}),
    review_revision: revision,
    work_item_id: review.work_item_id,
    actions,
  });
}

function policyFindingId(
  workItem: WorkItem,
  finding: VerifierFinding,
  criterionAliases: Readonly<Record<string, string>> = {},
): string {
  const criterion = workItem.acceptance.find((entry) =>
    entry.id === finding.acceptance_criterion || entry.statement === finding.acceptance_criterion);
  if (!criterion || !finding.problem_class) {
    throw new Error("Policy Reviewer action is missing canonical criterion or problem-class identity");
  }
  return fingerprintFinding({
    work_item_id: workItem.id,
    criterion_ref: criterionAliases[criterion.id] ?? criterion.id,
    source: "verifier",
    normalized_location: finding.line === null ? finding.file : `${finding.file}:${finding.line}`,
    problem_class: finding.problem_class,
  });
}

function exactFindingIdSet(actual: string[], expectedInput: readonly string[]): void {
  const expected = [...expectedInput];
  if (new Set(expected).size !== expected.length) {
    throw new Error("Policy decision finding IDs must be unique");
  }
  if (new Set(actual).size !== actual.length) {
    throw new Error("Policy Reviewer queue maps more than one action to a decision finding");
  }
  if (JSON.stringify([...actual].sort()) !== JSON.stringify([...expected].sort())) {
    throw new Error(`Policy Reviewer queue must map exactly one action to every authorized decision finding (actual ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`);
  }
}

export function assertPolicyReviewerQueueAuthority(
  queueInput: ReviewerActionQueue,
  workItem: WorkItem,
  decisionFindingIds: readonly string[],
  criterionAliases: Readonly<Record<string, string>> = {},
): ReviewerActionQueue {
  const queue = validateReviewerActionQueue(queueInput);
  if (queue.contract_version !== "review_fix_packet_v1") {
    throw new Error("Policy Reviewer queue requires strict fix-packet remediation actions");
  }
  exactFindingIdSet(
    queue.actions.map((action) => policyFindingId(workItem, action, criterionAliases)),
    decisionFindingIds,
  );
  return queue;
}

export function normalizePolicyReviewerActions(
  review: VerifierReview,
  revision: number,
  workItem: WorkItem,
  decisionFindingIds: readonly string[],
  criterionAliases: Readonly<Record<string, string>> = {},
): ReviewerActionQueue {
  const authorized = new Set(decisionFindingIds);
  const selected = review.findings.filter((finding) =>
    authorized.has(policyFindingId(workItem, finding, criterionAliases)));
  const actions = selected.map((finding, index): ReviewerAction => {
    const clean = { ...finding } as Record<string, unknown>;
    delete clean.action_id;
    delete clean.order;
    delete clean.depends_on;
    delete clean.re_verification;
    return {
      ...(clean as unknown as VerifierFinding),
      action_id: `R${revision}-A${index + 1}`,
      order: index + 1,
      depends_on: [],
    };
  });
  return assertPolicyReviewerQueueAuthority(validateReviewerActionQueue({
    contract_version: "review_fix_packet_v1",
    review_revision: revision,
    work_item_id: review.work_item_id,
    actions,
  }), workItem, decisionFindingIds, criterionAliases);
}

export function estimateQueueCost(
  queue: ReviewerActionQueue,
  policy: QualityGatePolicy,
): QueueCostEstimate {
  const validatedQueue = validateReviewerActionQueue(queue);
  const maximumActionAttempts = validatedQueue.actions.length
    * policy.max_attempts_per_reviewer_action;

  return {
    maximum_hands_calls: maximumActionAttempts
      * (1 + policy.hands_self_review_passes),
    maximum_focused_verifier_calls: maximumActionAttempts,
    final_full_verifier_calls: 1,
  };
}

export function nextQueueAction(input: NextQueueActionInput): QueueTransition {
  let queue: ReviewerActionQueue;
  try {
    queue = validateReviewerActionQueue(input.queue);
  } catch {
    return invalidQueueTransition;
  }

  if (!Number.isInteger(input.maxAttemptsPerAction)
    || input.maxAttemptsPerAction < 1
    || input.maxAttemptsPerAction > 3
    || !Number.isInteger(input.activeActionAttempt)
    || input.activeActionAttempt < 0) {
    return invalidQueueTransition;
  }

  const completed = new Set(input.completedActionIds);
  if (completed.size !== input.completedActionIds.length) {
    return invalidQueueTransition;
  }
  for (const [index, action] of queue.actions.entries()) {
    if (completed.has(action.action_id) !== (index < completed.size)) {
      return invalidQueueTransition;
    }
  }

  const nextAction = queue.actions.find((action) =>
    !completed.has(action.action_id)
    && action.depends_on.every((dependency) => completed.has(dependency)));

  if (input.activeActionId === null) {
    if (input.activeActionAttempt !== 0 || input.focusedDecision !== null) {
      return invalidQueueTransition;
    }
    return nextAction
      ? { kind: "activate", action_id: nextAction.action_id, attempt: 1 }
      : completed.size === queue.actions.length
        ? { kind: "full_review" }
        : invalidQueueTransition;
  }

  if (!nextAction
    || input.activeActionId !== nextAction.action_id
    || input.activeActionAttempt < 1
    || input.activeActionAttempt > input.maxAttemptsPerAction
    || input.focusedDecision === null) {
    return invalidQueueTransition;
  }

  if (input.focusedDecision === "replan_required") {
    return { kind: "replan" };
  }
  if (input.focusedDecision === "still_open") {
    return input.activeActionAttempt < input.maxAttemptsPerAction
      ? {
        kind: "retry",
        action_id: input.activeActionId,
        attempt: input.activeActionAttempt + 1,
      }
      : { kind: "block", blocker_code: "action_fix_exhausted" };
  }

  completed.add(input.activeActionId);
  const followingAction = queue.actions.find((action) =>
    !completed.has(action.action_id)
    && action.depends_on.every((dependency) => completed.has(dependency)));

  return followingAction
    ? { kind: "activate", action_id: followingAction.action_id, attempt: 1 }
    : completed.size === queue.actions.length
      ? { kind: "full_review" }
      : invalidQueueTransition;
}
