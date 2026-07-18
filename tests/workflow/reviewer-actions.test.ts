import { describe, expect, it } from "vitest";
import type {
  QualityGatePolicy,
  ReviewerAction,
  VerifierReview,
} from "../../src/core/types.js";
import {
  estimateQueueCost,
  nextQueueAction,
  normalizeReviewerActions,
  normalizePolicyReviewerActions,
  assertPolicyReviewerQueueAuthority,
  validateReviewerActionQueue,
} from "../../src/workflow/reviewer-actions.js";
import { actionAttemptDecision } from "../../src/workflow/action-verifier.js";
import { executionSpec } from "../fixtures/execution-spec.js";
import { fingerprintFinding } from "../../src/workflow/findings.js";

const baseFinding = {
  severity: "medium" as const,
  file: "src/example.ts",
  line: 10,
  acceptance_criterion: "The example works",
  problem: "The example fails",
  required_fix: "Correct the example",
  re_verification: [["npm", "test", "--", "example.test.ts"]],
};

const legacyReview: VerifierReview = {
  work_item_id: "item-1",
  attempt: 2,
  final: false,
  decision: "request_changes",
  failure_class: "implementation_failure",
  blocker: null,
  acceptance_coverage: [],
  evidence_reviewed: [],
  findings: [baseFinding, { ...baseFinding, file: "src/second.ts" }],
  residual_risks: [],
};

const action = (
  action_id: string,
  order: number,
  depends_on: string[] = [],
): ReviewerAction => ({
  ...baseFinding,
  action_id,
  order,
  depends_on,
});

describe("Reviewer action queues", () => {
  it("does not let focused resolved override deterministic failure", () => {
    expect(actionAttemptDecision({
      deterministicFailures: ["npm test exited 1"],
      focusedDecision: "resolved",
    })).toBe("still_open");
  });

  it("treats focused replanning as still blocking evidence, not queue authority", () => {
    expect(actionAttemptDecision({
      deterministicFailures: [],
      focusedDecision: "replan_required",
    })).toBe("still_open");
  });

  it("normalizes legacy findings into ordered actions", () => {
    const queue = normalizeReviewerActions(legacyReview, 2);

    expect(queue).toMatchObject({ review_revision: 2, work_item_id: "item-1" });
    expect(queue.actions.map((entry) => entry.action_id)).toEqual(["R2-A1", "R2-A2"]);
    expect(queue.actions.map((entry) => entry.order)).toEqual([1, 2]);
    expect(queue.actions.map((entry) => entry.depends_on)).toEqual([[], []]);
    expect(queue.contract_version).toBeUndefined();
  });

  it("versions queues created from structured remediation", () => {
    const remediation = {
      schema_version: 1 as const,
      diagnosis: { observed_behavior: "Wrong", expected_behavior: "Right", failure_mechanism: "Missing", reproduction: ["Run test"], evidence_refs: ["verification/evidence.json"] },
      targets: [{ kind: "code" as const, path: "src/example.ts", symbol: "example", line_hint: 10 }],
      remediation: { strategy: "Fix", change_units: [{ id: "FIX-1", path: "src/example.ts", target: "example", operation: "modify" as const, requirements: ["Make it right."], satisfies: ["SC-1"] }], allowed_files: ["src/example.ts"], forbidden_changes: [] },
      verification: { commands: [{ id: "CMD-1", argv: ["npm", "test"] }], success_conditions: [{ id: "SC-1", statement: "Right", satisfied_by: ["CMD-1", "EVID-1"] }], required_evidence: [{ id: "EVID-1", kind: "test_result" as const, source_id: "CMD-1", output_path: "verification/result.json" }] },
      completion_contract: { required_change_unit_ids: ["FIX-1"], expected_changed_files: ["src/example.ts"], allow_additional_files: false as const },
    };
    const { re_verification: _legacy, ...strictAction } = action("R3-A1", 1);
    const review: VerifierReview = { ...legacyReview, findings: [{ ...strictAction, problem_class: "correctness", evidence_refs: ["verification/evidence.json"], remediation }] };
    expect(normalizeReviewerActions(review, 3).contract_version).toBe("review_fix_packet_v1");
  });

  it("preserves valid strict action metadata", () => {
    const strictReview: VerifierReview = {
      ...legacyReview,
      findings: [action("R3-A1", 1), action("R3-A2", 2, ["R3-A1"])],
    };

    expect(normalizeReviewerActions(strictReview, 3).actions).toEqual(strictReview.findings);
  });

  it("maps policy decision findings one-to-one and excludes advisory findings", () => {
    const workItem = executionSpec("item-1");
    const remediation = {
      schema_version: 1 as const,
      diagnosis: { observed_behavior: "Wrong", expected_behavior: "Right", failure_mechanism: "Missing", reproduction: ["Run"], evidence_refs: ["verification/evidence.json"] },
      targets: [{ kind: "code" as const, path: "src/item-1.ts", symbol: "item-1 implementation", line_hint: null }],
      remediation: { strategy: "Fix", change_units: [{ id: "FIX-1", path: "src/item-1.ts", target: "item-1 implementation", operation: "modify" as const, requirements: ["Make right."], satisfies: ["SC-1"] }], allowed_files: ["src/item-1.ts"], forbidden_changes: [] },
      verification: { commands: [{ id: "CMD-1", argv: ["npm", "test", "--", "tests/item-1.test.ts"] }], success_conditions: [{ id: "SC-1", statement: "Right", satisfied_by: ["CMD-1", "EVID-1"] }], required_evidence: [{ id: "EVID-1", kind: "test_result" as const, source_id: "CMD-1", output_path: "verification/result.json" }] },
      completion_contract: { required_change_unit_ids: ["FIX-1"], expected_changed_files: ["src/item-1.ts"], allow_additional_files: false as const },
    };
    const strict = (severity: "medium" | "low", file: string) => ({
      severity, file, line: null, acceptance_criterion: workItem.acceptance[0]!.id,
      problem_class: "correctness" as const, problem: `${severity} problem`, required_fix: `${severity} fix`,
      evidence_refs: ["verification/evidence.json"], remediation,
    });
    const medium = strict("medium", "src/item-1.ts");
    const low = strict("low", "tests/item-1.test.ts");
    const mediumId = fingerprintFinding({ work_item_id: workItem.id, criterion_ref: workItem.acceptance[0]!.id, source: "verifier", normalized_location: medium.file, problem_class: medium.problem_class });
    const lowId = fingerprintFinding({ work_item_id: workItem.id, criterion_ref: workItem.acceptance[0]!.id, source: "verifier", normalized_location: low.file, problem_class: low.problem_class });
    const review: VerifierReview = { ...legacyReview, work_item_id: workItem.id, findings: [medium, low] };
    const queue = normalizePolicyReviewerActions(review, 1, workItem, [mediumId]);
    expect(queue.actions).toHaveLength(1);
    expect(queue.actions[0]!.file).toBe(medium.file);
    expect(() => normalizePolicyReviewerActions(review, 1, workItem, [`finding:${"f".repeat(64)}`])).toThrow(/exactly one action/i);
    expect(() => normalizePolicyReviewerActions({ ...review, findings: [medium, { ...medium, problem: "duplicate" }] }, 1, workItem, [mediumId])).toThrow(/more than one action/i);
    const extraQueue = normalizePolicyReviewerActions(review, 1, workItem, [mediumId, lowId]);
    expect(() => assertPolicyReviewerQueueAuthority(extraQueue, workItem, [mediumId])).toThrow(/exactly one action/i);
  });

  it("rejects duplicate action IDs", () => {
    const queue = {
      review_revision: 2,
      work_item_id: "item-1",
      actions: [action("R2-A1", 1), action("R2-A1", 2)],
    };

    expect(() => validateReviewerActionQueue(queue)).toThrow("duplicate action_id");
  });

  it("rejects forward dependencies", () => {
    const queue = {
      review_revision: 2,
      work_item_id: "item-1",
      actions: [action("R2-A1", 1, ["R2-A2"]), action("R2-A2", 2)],
    };

    expect(() => validateReviewerActionQueue(queue)).toThrow(
      "must depend only on an earlier action",
    );
  });

  it("rejects non-contiguous action orders", () => {
    const queue = {
      review_revision: 2,
      work_item_id: "item-1",
      actions: [action("R2-A1", 1), action("R2-A2", 3)],
    };

    expect(() => validateReviewerActionQueue(queue)).toThrow("orders must be contiguous");
  });

  it("rejects an action ID from the wrong review revision", () => {
    const queue = {
      review_revision: 2,
      work_item_id: "item-1",
      actions: [action("R1-A1", 1)],
    };

    expect(() => validateReviewerActionQueue(queue)).toThrow(
      "action_id must be R2-A1",
    );
  });

  it("rejects an action ID whose suffix does not match its order", () => {
    const queue = {
      review_revision: 2,
      work_item_id: "item-1",
      actions: [action("R2-A2", 1)],
    };

    expect(() => validateReviewerActionQueue(queue)).toThrow(
      "action_id must be R2-A1",
    );
  });

  it("estimates the maximum queue call cost", () => {
    const policy: QualityGatePolicy = {
      hands_self_review_passes: 2,
      max_attempts_per_reviewer_action: 3,
      require_focused_verifier_confirmation: true,
    };
    const queue = {
      review_revision: 2,
      work_item_id: "item-1",
      actions: [action("R2-A1", 1), action("R2-A2", 2)],
    };

    expect(estimateQueueCost(queue, policy)).toEqual({
      maximum_hands_calls: 18,
      maximum_focused_verifier_calls: 6,
      final_full_verifier_calls: 1,
    });
  });

  it("advances through the ordered queue transition table", () => {
    const queue = {
      review_revision: 2,
      work_item_id: "item-1",
      actions: [action("R2-A1", 1), action("R2-A2", 2, ["R2-A1"])],
    };
    const base = {
      queue,
      completedActionIds: [] as string[],
      activeActionId: null,
      activeActionAttempt: 0,
      focusedDecision: null,
      maxAttemptsPerAction: 2,
    };

    expect(nextQueueAction(base)).toEqual({
      kind: "activate",
      action_id: "R2-A1",
      attempt: 1,
    });
    expect(nextQueueAction({
      ...base,
      activeActionId: "R2-A1",
      activeActionAttempt: 1,
      focusedDecision: "still_open",
    })).toEqual({ kind: "retry", action_id: "R2-A1", attempt: 2 });
    expect(nextQueueAction({
      ...base,
      activeActionId: "R2-A1",
      activeActionAttempt: 1,
      focusedDecision: "resolved",
    })).toEqual({ kind: "activate", action_id: "R2-A2", attempt: 1 });
    expect(nextQueueAction({
      ...base,
      activeActionId: "R2-A1",
      activeActionAttempt: 2,
      focusedDecision: "still_open",
    })).toEqual({ kind: "block", blocker_code: "action_fix_exhausted" });
    expect(nextQueueAction({
      ...base,
      completedActionIds: ["R2-A1", "R2-A2"],
    })).toEqual({ kind: "full_review" });
  });

  it("requests replanning without advancing the active action", () => {
    const queue = {
      review_revision: 2,
      work_item_id: "item-1",
      actions: [action("R2-A1", 1)],
    };

    expect(nextQueueAction({
      queue,
      completedActionIds: [],
      activeActionId: "R2-A1",
      activeActionAttempt: 1,
      focusedDecision: "replan_required",
      maxAttemptsPerAction: 2,
    })).toEqual({ kind: "replan" });
  });

  it("fails closed for a reordered queue or inconsistent progress", () => {
    const reorderedQueue = {
      review_revision: 2,
      work_item_id: "item-1",
      actions: [action("R2-A2", 2, ["R2-A1"]), action("R2-A1", 1)],
    };
    const queue = {
      review_revision: 2,
      work_item_id: "item-1",
      actions: [action("R2-A1", 1)],
    };

    expect(nextQueueAction({
      queue: reorderedQueue,
      completedActionIds: [],
      activeActionId: null,
      activeActionAttempt: 0,
      focusedDecision: null,
      maxAttemptsPerAction: 2,
    })).toEqual({ kind: "block", blocker_code: "invalid_reviewer_action_queue" });
    expect(nextQueueAction({
      queue,
      completedActionIds: ["R2-A2"],
      activeActionId: null,
      activeActionAttempt: 0,
      focusedDecision: null,
      maxAttemptsPerAction: 2,
    })).toEqual({ kind: "block", blocker_code: "invalid_reviewer_action_queue" });
  });
});
