import { describe, expect, it } from "vitest";
import type {
  EngineFinding,
  EvaluateReviewPolicyInput,
  FindingSeverity,
  ReviewDisposition,
  ReviewPolicy,
  ReviewPolicyDecision,
  ReviewPolicyOverride,
  WarningContinuationAuthorization,
} from "../../src/core/types.js";
import {
  reviewPolicyDecisionSchema,
  warningContinuationAuthorizationSchema,
} from "../../src/core/schema.js";
import {
  evaluateReviewPolicy,
  isReviewEffectAction,
  qualityRecoveryEligibilitySnapshot,
  resolveReviewPolicy,
} from "../../src/workflow/review-policy.js";

const policy: ReviewPolicy = {
  policy_revision: 4,
  max_fix_cycles: 2,
  on_limit: "auto_replan",
  auto_advance_on_approval: true,
  severity_defaults: {
    critical: "blocking",
    high: "blocking",
    medium: "fix_in_scope",
    low: "advisory",
  },
  pause_on: ["plan_approval", "unresolved_release_blocker"],
};

function finding(
  suffix: string,
  severity: FindingSeverity = "medium",
  disposition: ReviewDisposition = "fix_in_scope",
  source: EngineFinding["source"] = "verifier",
): EngineFinding {
  return {
    finding_id: `finding:${suffix.repeat(64)}`,
    work_item_id: "BH-005",
    criterion_ref: source === "release_guard" ? "release:no-secrets" : "BH-005:AC-1",
    source,
    normalized_location: "src/example.ts:1",
    problem_class: source === "release_guard" ? "release_guard" : "correctness",
    severity,
    disposition,
    first_seen_revision: 1,
    last_seen_revision: 1,
    occurrences: 1,
    problem: "The implementation is incorrect",
    required_fix: "Correct the implementation",
    evidence_refs: ["verification/review.json"],
  };
}

function authorization(
  findings: EngineFinding[],
  overrides: Partial<WarningContinuationAuthorization> = {},
): WarningContinuationAuthorization {
  return {
    actor: "release-manager",
    source: "run_override",
    finding_ids: findings.map(({ finding_id }) => finding_id).sort(),
    reason: "The bounded residual issue is accepted for this run",
    residual_risk: "The medium-severity behavior remains visible to users",
    evidence_snapshot: ["verification/review.json"],
    timestamp: "2026-07-11T12:00:00.000Z",
    policy_revision: policy.policy_revision,
    ...overrides,
  };
}

function input(overrides: Partial<EvaluateReviewPolicyInput> = {}): EvaluateReviewPolicyInput {
  return {
    policy,
    findings: [],
    accounting: {
      review_revision: 3,
      fix_cycles_used: 0,
      self_review_mutations_used: 1,
      plan_revision: 2,
    },
    phase: "work_item",
    operational_blocker: null,
    replan_patch_pending: false,
    authorization: null,
    quality_recovery: {
      configured: false,
      active_hands_profile: "primary",
      attempts_used: 0,
    },
    ...overrides,
  };
}

function exhausted(
  blocker: EngineFinding,
  onLimit: ReviewPolicy["on_limit"],
  auth: WarningContinuationAuthorization | null = null,
): EvaluateReviewPolicyInput {
  return input({
    policy: { ...policy, on_limit: onLimit },
    findings: [blocker],
    accounting: { ...input().accounting, fix_cycles_used: policy.max_fix_cycles },
    authorization: auth,
  });
}

describe("evaluateReviewPolicy", () => {
  const blocker = finding("b");
  const replan = finding("c", "medium", "requires_replan");
  const releaseBlocker = finding("d", "high", "blocking", "release_guard");

  function qualityRecoveryInput(
    overrides: Partial<EvaluateReviewPolicyInput> = {},
  ): EvaluateReviewPolicyInput {
    return input({
      findings: [blocker],
      accounting: { ...input().accounting, fix_cycles_used: policy.max_fix_cycles },
      quality_recovery: {
        configured: true,
        active_hands_profile: "primary",
        attempts_used: 0,
      },
      ...overrides,
    });
  }

  it("selects bounded quality recovery after ordinary fix budget exhaustion", () => {
    expect(evaluateReviewPolicy(qualityRecoveryInput())).toMatchObject({
      action: "quality_recovery",
      reason_code: "bounded_quality_recovery_available",
    });
  });

  it.each([
    [
      "requires_replan",
      { findings: [replan] },
      "create_replan",
      "plan_change_required",
    ],
    [
      "critical/high release blocker",
      { findings: [releaseBlocker] },
      "stop",
      "critical_high_release_blocker",
    ],
    [
      "pending replan approval",
      { replan_patch_pending: true },
      "await_plan_approval",
      "replan_patch_pending",
    ],
  ] satisfies Array<[
    string,
    Partial<EvaluateReviewPolicyInput>,
    ReviewPolicyDecision["action"],
    string,
  ]>)("gives %s precedence over quality recovery", (_name, overrides, action, reasonCode) => {
    expect(evaluateReviewPolicy(qualityRecoveryInput(overrides))).toMatchObject({
      action,
      reason_code: reasonCode,
    });
  });

  it.each([
    ["active backup profile", { configured: true, active_hands_profile: "backup", attempts_used: 0 }],
    ["used recovery attempt", { configured: true, active_hands_profile: "primary", attempts_used: 1 }],
    ["absent backup", { configured: false, active_hands_profile: "primary", attempts_used: 0 }],
  ] as const)("preserves on_limit when quality recovery is ineligible because of %s", (_name, eligibility) => {
    expect(evaluateReviewPolicy(qualityRecoveryInput({ quality_recovery: eligibility }))).toMatchObject({
      action: "create_replan",
      reason_code: "fix_limit_reached",
    });
  });

  it.each([
    ["no findings", input(), "advance", "no_blocking_findings"],
    ["advisory finding", input({ findings: [finding("a", "low", "advisory")] }), "advance", "no_blocking_findings"],
    ["in-scope blocker with budget", input({ findings: [blocker] }), "fix", "fix_budget_available"],
    ["scope change", input({ findings: [replan] }), "create_replan", "plan_change_required"],
    ["unapproved patch", input({ findings: [blocker], replan_patch_pending: true }), "await_plan_approval", "replan_patch_pending"],
    ["limit with auto replan", exhausted(blocker, "auto_replan"), "create_replan", "fix_limit_reached"],
    ["limit with stop", exhausted(blocker, "stop"), "stop", "fix_limit_reached"],
    ["critical release blocker", input({ findings: [releaseBlocker] }), "stop", "critical_high_release_blocker"],
  ] as const)("decides %s", (_name, evaluation, action, reasonCode) => {
    expect(evaluateReviewPolicy(evaluation)).toMatchObject({
      action,
      reason_code: reasonCode,
      policy_revision: policy.policy_revision,
      authorization_required: false,
    });
  });

  it.each([
    ["blocking", "fix"],
    ["fix_in_scope", "fix"],
    ["requires_replan", "create_replan"],
    ["follow_up", "advance"],
    ["advisory", "advance"],
  ] as const)("maps %s disposition to %s", (disposition, action) => {
    expect(evaluateReviewPolicy(input({
      findings: [finding("3", "medium", disposition)],
    })).action).toBe(action);
  });

  it.each(["critical", "high", "medium", "low"] as const)(
    "fixes an in-scope %s finding while budget remains",
    (severity) => {
      expect(evaluateReviewPolicy(input({
        findings: [finding("4", severity, "fix_in_scope")],
      })).action).toBe("fix");
    },
  );

  it.each([
    [policy.max_fix_cycles - 1, "fix"],
    [policy.max_fix_cycles, "create_replan"],
    [policy.max_fix_cycles + 1, "create_replan"],
  ] as const)("enforces fix budget at %i used cycles", (fixCyclesUsed, action) => {
    expect(evaluateReviewPolicy(input({
      findings: [blocker],
      accounting: { ...input().accounting, fix_cycles_used: fixCyclesUsed },
    })).action).toBe(action);
  });

  it.each(["work_item", "final_integrated", "post_pr"] as const)(
    "applies the same authorized-warning policy in the %s phase",
    (phase) => {
      const warningPolicy = { ...policy, on_limit: "continue_with_warning" as const };
      const evaluation = exhausted(blocker, "continue_with_warning", authorization([blocker]));
      const decision = evaluateReviewPolicy({ ...evaluation, policy: warningPolicy, phase });

      expect(decision).toEqual({
        action: "continue_with_warning",
        reason_code: "authorized_warning",
        finding_ids: [blocker.finding_id],
        policy_revision: policy.policy_revision,
        authorization_required: false,
      });
    },
  );

  it.each([
    ["missing", null],
    ["wrong policy revision", authorization([blocker], { policy_revision: policy.policy_revision + 1 })],
    ["wrong finding set", authorization([finding("e")])],
    ["repository default source", authorization([blocker], { source: "repository_default" as never })],
    ["blank actor", authorization([blocker], { actor: " " })],
    ["unsafe evidence", authorization([blocker], { evidence_snapshot: ["../outside.json"] })],
    ["malformed timestamp", authorization([blocker], { timestamp: "yesterday" })],
  ])("does not continue with a warning when authorization is %s", (_name, auth) => {
    expect(evaluateReviewPolicy(exhausted(blocker, "continue_with_warning", auth))).toMatchObject({
      action: "create_replan",
      reason_code: "warning_authorization_required",
      authorization_required: true,
    });
  });

  it.each(["critical", "high"] as const)(
    "never warning-continues a %s blocker",
    (severity) => {
      const severe = finding(severity === "critical" ? "f" : "1", severity, "blocking");
      expect(evaluateReviewPolicy(exhausted(
        severe,
        "continue_with_warning",
        authorization([severe]),
      ))).toMatchObject({
        action: "create_replan",
        reason_code: "critical_high_warning_forbidden",
        authorization_required: false,
      });
    },
  );

  it("gives critical/high release guards precedence over pending replans and remaining budget", () => {
    expect(evaluateReviewPolicy(input({
      findings: [releaseBlocker, replan],
      replan_patch_pending: true,
    }))).toMatchObject({
      action: "stop",
      reason_code: "critical_high_release_blocker",
      finding_ids: [releaseBlocker.finding_id],
    });
  });

  it("reports every critical/high blocker when a release blocker forces stop", () => {
    const criticalProductBlocker = finding("0", "critical", "blocking");
    const highProductBlocker = finding("e", "high", "fix_in_scope");
    expect(evaluateReviewPolicy(input({
      findings: [releaseBlocker, highProductBlocker, criticalProductBlocker, highProductBlocker],
    }))).toMatchObject({
      action: "stop",
      reason_code: "critical_high_release_blocker",
      finding_ids: [
        criticalProductBlocker.finding_id,
        releaseBlocker.finding_id,
        highProductBlocker.finding_id,
      ],
    });
  });

  it("returns sorted unique finding IDs without mutating frozen input", () => {
    const first = finding("2");
    const second = finding("1");
    const evaluation = input({ findings: [first, second, first] });
    Object.freeze(evaluation.policy.severity_defaults);
    Object.freeze(evaluation.policy.pause_on);
    Object.freeze(evaluation.policy);
    for (const current of evaluation.findings) {
      Object.freeze(current.evidence_refs);
      Object.freeze(current);
    }
    Object.freeze(evaluation.findings);
    Object.freeze(evaluation.accounting);
    Object.freeze(evaluation);

    const decision = evaluateReviewPolicy(evaluation);

    expect(decision.finding_ids).toEqual([second.finding_id, first.finding_id]);
    expect(evaluation.findings).toEqual([first, second, first]);
    expect(reviewPolicyDecisionSchema.parse(decision)).toEqual(decision);
  });

  it("rejects operational blockers at the policy boundary", () => {
    expect(() => evaluateReviewPolicy({
      ...input(),
      operational_blocker: {
        code: "network_failure",
        message: "offline",
        phase: "work_item",
        evidence_refs: [],
      },
    } as never)).toThrow("Operational blockers are outside review policy");
  });
});

describe("review effect classification and quality-recovery snapshots", () => {
  it.each([
    ["fix", true],
    ["quality_recovery", true],
    ["advance", false],
    ["create_replan", false],
    ["await_plan_approval", false],
    ["continue_with_warning", false],
    ["stop", false],
  ] as const)("classifies %s as effect-like = %s", (action, expected) => {
    expect(isReviewEffectAction(action)).toBe(expected);
  });

  it.each([
    ["undefined backup", undefined, "primary", undefined, { configured: false, active_hands_profile: "primary", attempts_used: 0 }],
    ["null backup", null, "primary", undefined, { configured: false, active_hands_profile: "primary", attempts_used: 0 }],
    ["configured primary", { profile: {} }, "primary", undefined, { configured: true, active_hands_profile: "primary", attempts_used: 0 }],
    ["active backup", { profile: {} }, "backup", undefined, { configured: true, active_hands_profile: "backup", attempts_used: 0 }],
    ["used recovery", { profile: {} }, "primary", 1, { configured: true, active_hands_profile: "primary", attempts_used: 1 }],
  ] as const)("builds the exact caller snapshot for %s", (_name, handsBackupPolicy, activeProfile, attempts, expected) => {
    expect(qualityRecoveryEligibilitySnapshot({
      hands_backup_policy: handsBackupPolicy as never,
      active_hands_profile: activeProfile,
      work_item_progress: {
        item: { status: "in_progress", attempts: 1, quality_recovery_attempts: attempts },
      },
    }, "item")).toEqual(expected);
  });

  it("rejects a corrupt persisted quality-recovery attempt count instead of collapsing it", () => {
    expect(() => qualityRecoveryEligibilitySnapshot({
      hands_backup_policy: { profile: {} } as never,
      active_hands_profile: "primary",
      work_item_progress: {
        item: { status: "in_progress", attempts: 1, quality_recovery_attempts: 2 },
      },
    }, "item")).toThrow(/zero or one|0 or 1|attempt/i);
  });
});

describe("resolveReviewPolicy", () => {
  it("deeply applies an override without changing either input", () => {
    const config = structuredClone(policy);
    const override: ReviewPolicyOverride = {
      max_fix_cycles: 7,
      severity_defaults: { medium: "requires_replan" },
      pause_on: ["plan_approval"],
    };
    const configBefore = structuredClone(config);
    const overrideBefore = structuredClone(override);

    expect(resolveReviewPolicy(config, override)).toEqual({
      ...policy,
      max_fix_cycles: 7,
      severity_defaults: { ...policy.severity_defaults, medium: "requires_replan" },
      pause_on: ["plan_approval"],
    });
    expect(config).toEqual(configBefore);
    expect(override).toEqual(overrideBefore);
  });

  it("keeps the engine-owned policy revision when an unsafe override supplies one", () => {
    expect(resolveReviewPolicy(policy, { policy_revision: 99 } as never).policy_revision).toBe(4);
  });

  it("ignores explicit undefined override values, including nested severities", () => {
    const unsafeOverride = {
      max_fix_cycles: undefined,
      on_limit: undefined,
      auto_advance_on_approval: undefined,
      severity_defaults: {
        critical: undefined,
        high: undefined,
        medium: undefined,
        low: undefined,
      },
      pause_on: undefined,
    } as never;

    expect(resolveReviewPolicy(policy, unsafeOverride)).toEqual(policy);
  });

  it.each([
    ["negative fix limit", { max_fix_cycles: -1 }],
    ["invalid nested severity", { severity_defaults: { medium: "ignore" } }],
    ["invalid pause condition", { pause_on: ["model_request"] }],
  ])("strictly validates the resolved policy: %s", (_name, override) => {
    expect(() => resolveReviewPolicy(policy, override as never)).toThrow();
  });
});

describe("warning authorization schema", () => {
  it("accepts only explicit run or approved-plan authority", () => {
    expect(warningContinuationAuthorizationSchema.parse(authorization([finding("a")]))).toBeTruthy();
    expect(() => warningContinuationAuthorizationSchema.parse(
      authorization([finding("a")], { source: "repository_default" as never }),
    )).toThrow();
  });
});
