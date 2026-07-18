import { describe, expect, it } from "vitest";
import { recoveryScopeStateV1Schema } from "../../src/core/schema.js";
import type { RecoveryScopeStateV1 } from "../../src/core/types.js";
import {
  blockerFingerprint,
  evaluateRecoveryGuard,
  progressSubjectSha256,
  recoveryScopePathComponent,
  type RecoveryBlockerSubjectV1,
  type RecoveryObservationV1,
  type RecoveryProgressSubjectV1,
} from "../../src/workflow/recovery-policy.js";

const blockerSubject: RecoveryBlockerSubjectV1 = {
  version: 1,
  scope_id: "work-item:item-1",
  stage: "implementing",
  operation: "implement-work-item",
  failure_class: "implementation_failure",
  blocker_code: "hands_failed",
  finding_ids: ["finding-b", "finding-a"],
};

const progressSubject: RecoveryProgressSubjectV1 = {
  version: 1,
  approved_plan_sha256: "1".repeat(64),
  candidate_commit: "abc1234",
  implementation_artifact_sha256: "2".repeat(64),
  verification_artifact_sha256: null,
  review_artifact_sha256: null,
  review_revision: null,
  finding_ids: ["finding-b", "finding-a"],
};

function observation(
  overrides: Partial<RecoveryObservationV1> = {},
): RecoveryObservationV1 {
  return {
    ...blockerSubject,
    run_id: "run-1",
    effect_attempt_id: "attempt-1",
    blocker_fingerprint: blockerFingerprint(blockerSubject),
    progress_subject_sha256: progressSubjectSha256(progressSubject),
    ...overrides,
  };
}

function previousState(
  overrides: Partial<RecoveryScopeStateV1> = {},
): RecoveryScopeStateV1 {
  const first = observation();
  return {
    version: 1,
    head_sequence: 7,
    head_decision_path: "recovery/scopes/item/decisions/000007-first.json",
    blocker_fingerprint: first.blocker_fingerprint,
    progress_subject_sha256: first.progress_subject_sha256,
    consecutive_without_progress: 1,
    disposition: "active",
    diagnostic_path: null,
    authorization_path: null,
    ...overrides,
  };
}

describe("recovery fingerprints", () => {
  it("sorts finding IDs before hashing a blocker subject", () => {
    expect(blockerFingerprint({ ...blockerSubject, finding_ids: ["b", "a"] }))
      .toBe(blockerFingerprint({ ...blockerSubject, finding_ids: ["a", "b"] }));
  });

  it("sorts finding IDs before hashing a progress subject", () => {
    expect(progressSubjectSha256({ ...progressSubject, finding_ids: ["b", "a"] }))
      .toBe(progressSubjectSha256({ ...progressSubject, finding_ids: ["a", "b"] }));
  });

  it("changes the progress hash when an artifact identity changes", () => {
    expect(progressSubjectSha256({
      ...progressSubject,
      implementation_artifact_sha256: "a".repeat(64),
    })).not.toBe(progressSubjectSha256({
      ...progressSubject,
      implementation_artifact_sha256: "b".repeat(64),
    }));
  });

  it.each([
    ["scope ID", { scope_id: " " }],
    ["operation", { operation: "" }],
    ["blocker code", { blocker_code: "\t" }],
    ["finding ID", { finding_ids: ["finding-a", " "] }],
  ])("rejects a blank blocker %s", (_name, override) => {
    expect(() => blockerFingerprint({ ...blockerSubject, ...override }))
      .toThrow(/blank|identifier/i);
  });

  it.each([
    "approved_plan_sha256",
    "implementation_artifact_sha256",
    "verification_artifact_sha256",
    "review_artifact_sha256",
  ] as const)("rejects a malformed progress %s", (field) => {
    expect(() => progressSubjectSha256({ ...progressSubject, [field]: "bad" }))
      .toThrow(/sha-?256/i);
  });

  it.each([
    ["candidate commit", { candidate_commit: " " }],
    ["finding ID", { finding_ids: [""] }],
  ])("rejects a blank progress %s", (_name, override) => {
    expect(() => progressSubjectSha256({ ...progressSubject, ...override }))
      .toThrow(/blank|identifier/i);
  });

  it.each([
    ["string", "ab"],
    ["array-like object", { 0: "a", length: 1 }],
    ["sparse array", new Array(1)],
    ["non-string member", [1]],
    ["duplicate member", ["a", "a"]],
  ])("rejects malformed blocker finding IDs: %s", (_name, findingIds) => {
    expect(() => blockerFingerprint({
      ...blockerSubject,
      finding_ids: findingIds as never,
    })).toThrow(/finding/i);
  });

  it.each([
    ["string", "ab"],
    ["array-like object", { 0: "a", length: 1 }],
    ["sparse array", new Array(1)],
    ["non-string member", [1]],
    ["duplicate member", ["a", "a"]],
  ])("rejects malformed progress finding IDs: %s", (_name, findingIds) => {
    expect(() => progressSubjectSha256({
      ...progressSubject,
      finding_ids: findingIds as never,
    })).toThrow(/finding/i);
  });

  it("does not mutate caller-owned finding ID arrays", () => {
    const blockerFindingIds = Object.freeze(["b", "a"]);
    const progressFindingIds = Object.freeze(["d", "c"]);

    blockerFingerprint({ ...blockerSubject, finding_ids: blockerFindingIds as string[] });
    progressSubjectSha256({ ...progressSubject, finding_ids: progressFindingIds as string[] });

    expect(blockerFindingIds).toEqual(["b", "a"]);
    expect(progressFindingIds).toEqual(["d", "c"]);
  });

  it("derives distinct path components for distinct unpaired surrogates", () => {
    expect(recoveryScopePathComponent("scope:\ud800"))
      .not.toBe(recoveryScopePathComponent("scope:\udc00"));
  });

  it("derives a deterministic fixed-length component for ordinary Unicode", () => {
    const scopeId = "work-item:雪🚀/..";
    const first = recoveryScopePathComponent(scopeId);

    expect(first).toBe(recoveryScopePathComponent(scopeId));
    expect(first).toMatch(/^[a-f0-9]{64}$/);
  });

  it("does not normalize distinct JavaScript strings into one path component", () => {
    expect(recoveryScopePathComponent("scope:\u00e9"))
      .not.toBe(recoveryScopePathComponent("scope:e\u0301"));
  });

  it("keeps very long scope IDs within a fixed safe component length", () => {
    const component = recoveryScopePathComponent(`scope:${"x".repeat(10_000)}`);

    expect(component).toMatch(/^[a-f0-9]{64}$/);
    expect(Buffer.byteLength(component, "utf8")).toBe(64);
  });

  it.each(["", " \t\n"])("rejects a blank scope path identity", (scopeId) => {
    expect(() => recoveryScopePathComponent(scopeId)).toThrow(/scope|blank/i);
  });

  it.each([
    ["null blocker subject", null, blockerFingerprint],
    ["numeric blocker scope", { ...blockerSubject, scope_id: 1 }, blockerFingerprint],
    ["numeric progress commit", { ...progressSubject, candidate_commit: 1 }, progressSubjectSha256],
    ["string progress revision", { ...progressSubject, review_revision: "1" }, progressSubjectSha256],
  ])("rejects malformed primitive shapes: %s", (_name, subject, fingerprint) => {
    expect(() => fingerprint(subject as never)).toThrow();
  });
});

describe("evaluateRecoveryGuard", () => {
  it("allows a first implementation fix and starts its repetition streak", () => {
    const current = observation();
    const decision = evaluateRecoveryGuard({
      previous: undefined,
      observation: current,
      requestedEffect: "fix",
      requestedEffectReason: "fix_budget_available",
    });

    expect(decision).toEqual({
      action: "allow_next_effect",
      next: {
        version: 1,
        head_sequence: 0,
        head_decision_path: null,
        blocker_fingerprint: current.blocker_fingerprint,
        progress_subject_sha256: current.progress_subject_sha256,
        consecutive_without_progress: 1,
        disposition: "active",
        diagnostic_path: null,
        authorization_path: null,
      },
    });
  });

  it.each([
    "operational_blocker",
    "invocation_failure",
    "model_failure",
    "test_infrastructure_blocker",
  ] as const)("awaits an external fix for a first %s", (failureClass) => {
    const subject = { ...blockerSubject, failure_class: failureClass };
    const current = observation({
      ...subject,
      blocker_fingerprint: blockerFingerprint(subject),
    });

    expect(evaluateRecoveryGuard({
      previous: undefined,
      observation: current,
      requestedEffect: "retry_operation",
      requestedEffectReason: "retry_blocked_operation",
    })).toMatchObject({
      action: "await_external_fix",
      next: {
        consecutive_without_progress: 1,
        disposition: "awaiting_external_fix",
      },
    });
  });

  it("stops diagnostically on the second distinct equal observation", () => {
    const current = observation({ effect_attempt_id: "attempt-2" });
    const decision = evaluateRecoveryGuard({
      previous: previousState(),
      observation: current,
      requestedEffect: "quality_recovery",
      requestedEffectReason: "bounded_quality_recovery_available",
    });

    expect(decision).toEqual({
      action: "diagnostic_stop",
      next: {
        version: 1,
        head_sequence: 7,
        head_decision_path: "recovery/scopes/item/decisions/000007-first.json",
        blocker_fingerprint: current.blocker_fingerprint,
        progress_subject_sha256: current.progress_subject_sha256,
        consecutive_without_progress: 2,
        disposition: "diagnostic_stop",
        diagnostic_path: `recovery/scopes/${recoveryScopePathComponent(current.scope_id)}/diagnostics/000008.json`,
        authorization_path: null,
      },
    });

    expect(() => recoveryScopeStateV1Schema.parse({
      ...decision.next,
      head_sequence: 8,
      head_decision_path: "recovery/scopes/item/decisions/000008-second.json",
    })).not.toThrow();
  });

  it("allows changed progress and resets the repetition streak", () => {
    const current = observation({
      effect_attempt_id: "attempt-2",
      progress_subject_sha256: "b".repeat(64),
    });

    expect(evaluateRecoveryGuard({
      previous: previousState(),
      observation: current,
      requestedEffect: "fix",
      requestedEffectReason: "fix_budget_available",
    })).toMatchObject({
      action: "allow_next_effect",
      next: {
        progress_subject_sha256: "b".repeat(64),
        consecutive_without_progress: 1,
        disposition: "active",
      },
    });
  });

  it("marks only a policy stop for an exhausted fix limit as exhausted", () => {
    const current = observation();
    const decision = evaluateRecoveryGuard({
      previous: undefined,
      observation: current,
      requestedEffect: "stop",
      requestedEffectReason: "fix_limit_reached",
    });

    expect(decision).toEqual({
      action: "exhausted_stop",
      next: {
        version: 1,
        head_sequence: 0,
        head_decision_path: null,
        blocker_fingerprint: current.blocker_fingerprint,
        progress_subject_sha256: current.progress_subject_sha256,
        consecutive_without_progress: 1,
        disposition: "exhausted",
        diagnostic_path: null,
        authorization_path: null,
      },
    });
    expect(() => recoveryScopeStateV1Schema.parse(decision.next)).not.toThrow();
  });

  it("permits create_replan without converting it to a fix or stop", () => {
    expect(evaluateRecoveryGuard({
      previous: undefined,
      observation: observation(),
      requestedEffect: "create_replan",
      requestedEffectReason: "plan_change_required",
    })).toMatchObject({
      action: "allow_next_effect",
      next: { disposition: "active" },
    });
  });

  it.each([
    ["unsupported stop reason", "stop", "critical_high_release_blocker"],
    ["blank stop reason", "stop", " "],
    ["blank executable reason", "fix", ""],
  ] as const)("fails closed for %s", (_name, requestedEffect, requestedEffectReason) => {
    expect(() => evaluateRecoveryGuard({
      previous: undefined,
      observation: observation(),
      requestedEffect,
      requestedEffectReason,
    })).toThrow(/reason|exhaust/i);
  });

  it.each([
    ["run ID", { run_id: " " }],
    ["effect attempt ID", { effect_attempt_id: "" }],
    ["blocker fingerprint", { blocker_fingerprint: "bad" }],
    ["progress subject hash", { progress_subject_sha256: "A".repeat(64) }],
  ])("fails closed for an invalid observation %s", (_name, override) => {
    expect(() => evaluateRecoveryGuard({
      previous: undefined,
      observation: observation(override),
      requestedEffect: "fix",
      requestedEffectReason: "fix_budget_available",
    })).toThrow(/identifier|sha-?256|fingerprint/i);
  });

  it("rejects an observation whose blocker fingerprint does not match its subject", () => {
    expect(() => evaluateRecoveryGuard({
      previous: undefined,
      observation: observation({ blocker_fingerprint: "f".repeat(64) }),
      requestedEffect: "fix",
      requestedEffectReason: "fix_budget_available",
    })).toThrow(/fingerprint/i);
  });

  it("does not mutate the previous state", () => {
    const previous = Object.freeze(previousState({
      authorization_path: "recovery/scopes/item/authorizations/auth-1.json",
    }));
    const before = structuredClone(previous);

    const decision = evaluateRecoveryGuard({
      previous,
      observation: observation({
        effect_attempt_id: "attempt-2",
        progress_subject_sha256: "c".repeat(64),
      }),
      requestedEffect: "fix",
      requestedEffectReason: "fix_budget_available",
    });

    expect(previous).toEqual(before);
    expect(decision.next).not.toBe(previous);
  });

  it.each([
    ["diagnostic stop", previousState({
      disposition: "diagnostic_stop",
      diagnostic_path: "recovery/scopes/item/diagnostics/000007.json",
    })],
    ["exhausted", previousState({ disposition: "exhausted" })],
  ])("rejects a direct transition from a prior %s", (_name, previous) => {
    expect(() => evaluateRecoveryGuard({
      previous,
      observation: observation({
        effect_attempt_id: "attempt-2",
        progress_subject_sha256: "b".repeat(64),
      }),
      requestedEffect: "fix",
      requestedEffectReason: "fix_budget_available",
    })).toThrow(/diagnostic|exhaust|transition/i);
  });

  it("reevaluates a schema-valid awaiting-external-fix state", () => {
    const subject = { ...blockerSubject, failure_class: "operational_blocker" as const };
    const current = observation({
      ...subject,
      effect_attempt_id: "attempt-2",
      blocker_fingerprint: blockerFingerprint(subject),
    });

    expect(evaluateRecoveryGuard({
      previous: previousState({
        blocker_fingerprint: current.blocker_fingerprint,
        progress_subject_sha256: current.progress_subject_sha256,
        disposition: "awaiting_external_fix",
      }),
      observation: current,
      requestedEffect: "retry_operation",
      requestedEffectReason: "retry_blocked_operation",
    })).toEqual({
      action: "diagnostic_stop",
      next: {
        ...previousState(),
        blocker_fingerprint: current.blocker_fingerprint,
        progress_subject_sha256: current.progress_subject_sha256,
        consecutive_without_progress: 2,
        disposition: "diagnostic_stop",
        diagnostic_path: `recovery/scopes/${recoveryScopePathComponent(current.scope_id)}/diagnostics/000008.json`,
      },
    });
  });

  it("rejects before returning when the next journal sequence is not safe", () => {
    expect(() => evaluateRecoveryGuard({
      previous: previousState({
        head_sequence: Number.MAX_SAFE_INTEGER,
        head_decision_path: "recovery/scopes/item/decisions/max.json",
      }),
      observation: observation({
        effect_attempt_id: "attempt-2",
        progress_subject_sha256: "b".repeat(64),
      }),
      requestedEffect: "fix",
      requestedEffectReason: "fix_budget_available",
    })).toThrow(/safe integer|sequence/i);
  });

  it("rejects before returning when a repeated-observation counter cannot advance safely", () => {
    expect(() => evaluateRecoveryGuard({
      previous: previousState({
        consecutive_without_progress: Number.MAX_SAFE_INTEGER,
      }),
      observation: observation({ effect_attempt_id: "attempt-2" }),
      requestedEffect: "fix",
      requestedEffectReason: "fix_budget_available",
    })).toThrow(/safe integer|counter/i);
  });

  it("accepts the largest safe journal successor and remains schema-valid after decoration", () => {
    const current = observation({ effect_attempt_id: "attempt-2" });
    const decision = evaluateRecoveryGuard({
      previous: previousState({
        head_sequence: Number.MAX_SAFE_INTEGER - 1,
        head_decision_path: "recovery/scopes/item/decisions/previous.json",
      }),
      observation: current,
      requestedEffect: "fix",
      requestedEffectReason: "fix_budget_available",
    });

    expect(decision.next.diagnostic_path).toContain(
      `/diagnostics/${Number.MAX_SAFE_INTEGER}.json`,
    );
    expect(() => recoveryScopeStateV1Schema.parse({
      ...decision.next,
      head_sequence: Number.MAX_SAFE_INTEGER,
      head_decision_path: "recovery/scopes/item/decisions/maximum.json",
    })).not.toThrow();
  });

  it("accepts the largest safe consecutive-observation successor", () => {
    const decision = evaluateRecoveryGuard({
      previous: previousState({
        consecutive_without_progress: Number.MAX_SAFE_INTEGER - 1,
      }),
      observation: observation({ effect_attempt_id: "attempt-2" }),
      requestedEffect: "fix",
      requestedEffectReason: "fix_budget_available",
    });

    expect(decision.next.consecutive_without_progress).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => recoveryScopeStateV1Schema.parse({
      ...decision.next,
      head_sequence: 8,
      head_decision_path: "recovery/scopes/item/decisions/000008.json",
    })).not.toThrow();
  });

  it.each([
    ["NaN counter", { consecutive_without_progress: Number.NaN }],
    ["positive infinite counter", { consecutive_without_progress: Number.POSITIVE_INFINITY }],
    ["negative infinite counter", { consecutive_without_progress: Number.NEGATIVE_INFINITY }],
    ["negative counter", { consecutive_without_progress: -1 }],
    ["fractional counter", { consecutive_without_progress: 1.5 }],
    ["head without path", { head_decision_path: null }],
    ["path without head", { head_sequence: 0 }],
    ["invalid version", { version: 2 }],
    ["invalid blocker hash", { blocker_fingerprint: "bad" }],
    ["invalid progress hash", { progress_subject_sha256: "bad" }],
    ["invalid disposition", { disposition: "unknown" }],
    ["active diagnostic pointer", { diagnostic_path: "recovery/diagnostics/000007.json" }],
    ["diagnostic stop without pointer", { disposition: "diagnostic_stop" }],
  ])("rejects malformed previous state: %s", (_name, override) => {
    expect(() => evaluateRecoveryGuard({
      previous: previousState(override as never),
      observation: observation({ effect_attempt_id: "attempt-2" }),
      requestedEffect: "fix",
      requestedEffectReason: "fix_budget_available",
    })).toThrow();
  });

  it.each(["not-a-stage", undefined, null])(
    "rejects unsupported observation stage %s",
    (stage) => {
      expect(() => blockerFingerprint({ ...blockerSubject, stage } as never)).toThrow(/stage/i);
    },
  );

  it.each(["not-a-failure", undefined, null])(
    "rejects unsupported observation failure class %s",
    (failureClass) => {
      expect(() => blockerFingerprint({
        ...blockerSubject,
        failure_class: failureClass,
      } as never)).toThrow(/failure/i);
    },
  );

  it.each(["not-an-effect", undefined, null])(
    "rejects unsupported requested effect %s",
    (requestedEffect) => {
      expect(() => evaluateRecoveryGuard({
        previous: undefined,
        observation: observation(),
        requestedEffect,
        requestedEffectReason: "runtime boundary",
      } as never)).toThrow(/effect/i);
    },
  );

  it("rejects an unknown failure plus unknown effect before allowing execution", () => {
    expect(() => evaluateRecoveryGuard({
      previous: undefined,
      observation: {
        ...observation(),
        failure_class: "not-a-failure",
      },
      requestedEffect: "not-an-effect",
      requestedEffectReason: "runtime boundary",
    } as never)).toThrow();
  });
});
