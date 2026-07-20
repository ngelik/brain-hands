import { describe, expect, it } from "vitest";
import {
  applyPlanRepair,
  candidateSha256,
  isStrictDiagnosticImprovement,
  planningRepairAttemptLimit,
} from "../../src/workflow/plan-repair.js";

describe("plan repair", () => {
  it("applies a bounded patch against the exact candidate", () => {
    const candidate = { work_items: [{ acceptance_criteria: [{ id: "a", evidence: [] }] }] };
    expect(applyPlanRepair(candidate, {
      schema_version: "1.0",
      candidate_sha256: candidateSha256(candidate),
      operations: [{ op: "replace", path: "/work_items/0/acceptance_criteria/0/evidence", value_json: '["test:a"]' }],
    })).toEqual({ work_items: [{ acceptance_criteria: [{ id: "a", evidence: ["test:a"] }] }] });
  });

  it("applies ordered repeated appends to the same array", () => {
    const candidate = { verification_command_ids: [] };
    expect(applyPlanRepair(candidate, {
      schema_version: "1.0",
      candidate_sha256: candidateSha256(candidate),
      operations: [
        { op: "add", path: "/verification_command_ids/-", value_json: '"unit"' },
        { op: "add", path: "/verification_command_ids/-", value_json: '"lint"' },
      ],
    })).toEqual({ verification_command_ids: ["unit", "lint"] });
  });

  it.each(["/", "/__proto__/polluted", "/discovery_brief_sha256"])("rejects unsafe or protected path %s", (path) => {
    const candidate = { discovery_brief_sha256: "approved", work_items: [] };
    expect(() => applyPlanRepair(candidate, {
      schema_version: "1.0",
      candidate_sha256: candidateSha256(candidate),
      operations: [{ op: "replace", path, value_json: "null" }],
    })).toThrow();
  });

  it("rejects stale candidates and non-improving diagnostic sets", () => {
    expect(() => applyPlanRepair({ a: 1 }, {
      schema_version: "1.0",
      candidate_sha256: "0".repeat(64),
      operations: [{ op: "replace", path: "/a", value_json: "2" }],
    })).toThrow(/stale/);
    const before = [{ code: "plan.evidence" as const, path: "/work_items/0", message: "a" }];
    const after = [{ code: "plan.command_policy" as const, path: "/work_items/0", message: "b" }];
    expect(isStrictDiagnosticImprovement(before, [])).toBe(true);
    expect(isStrictDiagnosticImprovement(before, after)).toBe(false);
  });

  it("accepts a smaller diagnostic set when a repair exposes a derived diagnostic", () => {
    const before = [
      { code: "plan.command_policy" as const, path: "/work_items/0", message: "command must be cross-cutting" },
      { code: "plan.command_policy" as const, path: "/work_items/0", message: "cross-cutting command is orphaned" },
    ];
    const after = [
      { code: "plan.command_policy" as const, path: "/work_items/0", message: "work item has no focused command" },
    ];

    expect(isStrictDiagnosticImprovement(before, after)).toBe(true);
  });

  it("grants a fresh repair budget only after an attested controller transition", () => {
    expect(planningRepairAttemptLimit(2, 0)).toBe(2);
    expect(planningRepairAttemptLimit(2, 1)).toBe(4);
    expect(planningRepairAttemptLimit(0, 3)).toBe(0);
  });
});
