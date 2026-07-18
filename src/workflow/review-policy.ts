import type {
  EngineFinding,
  EvaluateReviewPolicyInput,
  QualityRecoveryEligibility,
  ReviewPolicy,
  ReviewPolicyAction,
  ReviewPolicyDecision,
  ReviewPolicyOverride,
  RunManifestV2,
  WarningContinuationAuthorization,
} from "../core/types.js";
import {
  reviewPolicySchema,
  warningContinuationAuthorizationSchema,
} from "../core/schema.js";

const BLOCKING_DISPOSITIONS = new Set<EngineFinding["disposition"]>([
  "blocking",
  "fix_in_scope",
  "requires_replan",
]);

export function isReviewEffectAction(
  action: ReviewPolicyAction,
): action is "fix" | "quality_recovery" {
  return action === "fix" || action === "quality_recovery";
}

export function qualityRecoveryEligibilitySnapshot(
  manifest: Pick<RunManifestV2, "hands_backup_policy" | "active_hands_profile" | "work_item_progress">,
  workItemId: string,
): QualityRecoveryEligibility {
  const attempts = manifest.work_item_progress[workItemId]?.quality_recovery_attempts ?? 0;
  if (attempts !== 0 && attempts !== 1) {
    throw new Error("Quality recovery attempts must be zero or one");
  }
  return {
    configured: manifest.hands_backup_policy != null,
    active_hands_profile: manifest.active_hands_profile,
    attempts_used: attempts,
  };
}

export function resolveReviewPolicy(
  config: ReviewPolicy,
  override: ReviewPolicyOverride = {},
): ReviewPolicy {
  const severityOverride = override.severity_defaults;
  return reviewPolicySchema.parse({
    policy_revision: config.policy_revision,
    max_fix_cycles: override.max_fix_cycles ?? config.max_fix_cycles,
    on_limit: override.on_limit ?? config.on_limit,
    auto_advance_on_approval:
      override.auto_advance_on_approval ?? config.auto_advance_on_approval,
    severity_defaults: {
      critical: severityOverride?.critical ?? config.severity_defaults.critical,
      high: severityOverride?.high ?? config.severity_defaults.high,
      medium: severityOverride?.medium ?? config.severity_defaults.medium,
      low: severityOverride?.low ?? config.severity_defaults.low,
    },
    pause_on: [...(override.pause_on ?? config.pause_on)],
  });
}

export function evaluateReviewPolicy(
  input: EvaluateReviewPolicyInput,
): ReviewPolicyDecision {
  if (input.operational_blocker !== null) {
    throw new Error("Operational blockers are outside review policy");
  }

  const blocking = input.findings.filter(isBlockingFinding);
  const criticalHigh = blocking.filter(isCriticalOrHigh);
  const criticalHighReleaseBlockers = criticalHigh.filter(isReleaseGuardFinding);

  if (criticalHighReleaseBlockers.length > 0) {
    return decision(
      "stop",
      "critical_high_release_blocker",
      criticalHigh,
      input,
    );
  }
  if (input.replan_patch_pending) {
    return decision(
      "await_plan_approval",
      "replan_patch_pending",
      blocking,
      input,
    );
  }
  if (blocking.some((finding) => finding.disposition === "requires_replan")) {
    return decision("create_replan", "plan_change_required", blocking, input);
  }
  if (blocking.length === 0) {
    return decision("advance", "no_blocking_findings", input.findings, input);
  }
  if (input.accounting.fix_cycles_used < input.policy.max_fix_cycles) {
    return decision("fix", "fix_budget_available", blocking, input);
  }
  if (
    input.accounting.fix_cycles_used === input.policy.max_fix_cycles
    && input.quality_recovery.configured
    && input.quality_recovery.active_hands_profile === "primary"
    && input.quality_recovery.attempts_used === 0
  ) {
    return decision(
      "quality_recovery",
      "bounded_quality_recovery_available",
      blocking,
      input,
    );
  }
  if (input.policy.on_limit === "stop") {
    return decision("stop", "fix_limit_reached", blocking, input);
  }
  if (input.policy.on_limit === "auto_replan") {
    return decision("create_replan", "fix_limit_reached", blocking, input);
  }
  if (criticalHigh.length > 0) {
    return decision(
      "create_replan",
      "critical_high_warning_forbidden",
      blocking,
      input,
    );
  }
  if (!matchesAuthorization(input.authorization, input.policy, blocking)) {
    return decision(
      "create_replan",
      "warning_authorization_required",
      blocking,
      input,
      true,
    );
  }
  return decision(
    "continue_with_warning",
    "authorized_warning",
    blocking,
    input,
  );
}

function isBlockingFinding(finding: EngineFinding): boolean {
  return BLOCKING_DISPOSITIONS.has(finding.disposition);
}

function isCriticalOrHigh(finding: EngineFinding): boolean {
  return finding.severity === "critical" || finding.severity === "high";
}

function isReleaseGuardFinding(finding: EngineFinding): boolean {
  return finding.source === "release_guard";
}

function matchesAuthorization(
  authorization: WarningContinuationAuthorization | null,
  policy: ReviewPolicy,
  findings: EngineFinding[],
): boolean {
  const parsed = warningContinuationAuthorizationSchema.safeParse(authorization);
  if (!parsed.success || parsed.data.policy_revision !== policy.policy_revision) {
    return false;
  }

  const expectedIds = sortedFindingIds(findings);
  const authorizedIds = [...new Set(parsed.data.finding_ids)].sort();
  return expectedIds.length === authorizedIds.length
    && expectedIds.every((findingId, index) => findingId === authorizedIds[index]);
}

function decision(
  action: ReviewPolicyAction,
  reasonCode: string,
  findings: EngineFinding[],
  input: EvaluateReviewPolicyInput,
  authorizationRequired = false,
): ReviewPolicyDecision {
  return {
    action,
    reason_code: reasonCode,
    finding_ids: sortedFindingIds(findings),
    policy_revision: input.policy.policy_revision,
    authorization_required: authorizationRequired,
  };
}

function sortedFindingIds(findings: EngineFinding[]): string[] {
  return [...new Set(findings.map((finding) => finding.finding_id))].sort();
}
