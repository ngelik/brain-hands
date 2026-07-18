import { describe, expect, it } from "vitest";
import {
  canonicalReviewFixPacket,
  hashReviewFixPacket,
  reviewFixPacketReadinessErrors,
  reviewFixPacketV1Schema,
  type ReviewFixPacketV1,
} from "../../src/core/review-fix-packet.js";

function packet(): ReviewFixPacketV1 {
  return {
    schema_version: 1,
    provenance: {
      packet_id: "R2-A1",
      finding_id: "finding:abc",
      action_id: "R2-A1",
      review_revision: 2,
      work_item_id: "BH-005",
      criterion_ref: "BH-005:AC-2",
      approved_plan_sha256: "a".repeat(64),
    },
    diagnosis: {
      problem_class: "correctness",
      severity: "high",
      observed_behavior: "Resume selects a second profile after interruption.",
      expected_behavior: "Resume reuses the profile persisted before invocation.",
      failure_mechanism: "Profile selection is persisted after the external invocation begins.",
      reproduction: ["Interrupt after invocation claim persistence and resume the run."],
      evidence_refs: ["verification/BH-005/attempt-2/evidence.json"],
    },
    targets: [
      { kind: "code", path: "src/workflow/runtime.ts", symbol: "invokeClaimedActionHands", line_hint: 1847 },
      { kind: "test", path: "tests/workflow/runtime-local.test.ts", test_name: "resumes the persisted profile", line_hint: null },
    ],
    remediation: {
      strategy: "Persist the chosen profile before invoking Hands and load it on resume.",
      change_units: [
        {
          id: "FIX-1",
          path: "src/workflow/runtime.ts",
          target: "invokeClaimedActionHands",
          operation: "modify",
          requirements: ["Persist the selected profile before the external invocation starts."],
          satisfies: ["SC-1"],
        },
        {
          id: "TEST-1",
          path: "tests/workflow/runtime-local.test.ts",
          target: "resumes the persisted profile",
          operation: "modify",
          requirements: ["Prove resume reuses the profile selected before interruption."],
          satisfies: ["SC-1"],
        },
      ],
      allowed_files: ["src/workflow/runtime.ts", "tests/workflow/runtime-local.test.ts"],
      forbidden_changes: [{ path: "src/adapters/model-catalog.ts", reason: "Do not change profile selection policy." }],
    },
    verification: {
      commands: [{ id: "CMD-1", argv: ["npx", "vitest", "run", "tests/workflow/runtime-local.test.ts"] }],
      success_conditions: [{
        id: "SC-1",
        statement: "Resume uses the profile persisted before interruption.",
        satisfied_by: ["TEST-1", "CMD-1", "EVID-1"],
      }],
      required_evidence: [{
        id: "EVID-1",
        kind: "test_result",
        source_id: "CMD-1",
        output_path: "verification/BH-005/R2-A1/attempt-1/CMD-1.json",
      }],
    },
    completion_contract: {
      required_change_unit_ids: ["FIX-1", "TEST-1"],
      expected_changed_files: ["src/workflow/runtime.ts", "tests/workflow/runtime-local.test.ts"],
      allow_additional_files: false,
    },
  };
}

describe("ReviewFixPacketV1", () => {
  it("accepts a complete packet and produces stable canonical bytes and hash", () => {
    const value = packet();
    expect(reviewFixPacketV1Schema.parse(value)).toEqual(value);
    expect(reviewFixPacketReadinessErrors(value, { approved_plan_sha256: "a".repeat(64) })).toEqual([]);
    expect(canonicalReviewFixPacket(value)).toBe(`${JSON.stringify(value, null, 2)}\n`);
    expect(hashReviewFixPacket(value)).toMatch(/^[a-f0-9]{64}$/);
    expect(hashReviewFixPacket(value)).toBe(hashReviewFixPacket(structuredClone(value)));
  });

  it.each([
    ["stale plan", (value: ReviewFixPacketV1) => { value.provenance.approved_plan_sha256 = "b".repeat(64); }, /approved plan hash/i],
    ["duplicate IDs", (value: ReviewFixPacketV1) => { value.remediation.change_units[1]!.id = "FIX-1"; }, /duplicate id FIX-1/i],
    ["unknown condition", (value: ReviewFixPacketV1) => { value.remediation.change_units[0]!.satisfies = ["SC-X"]; }, /unknown success condition SC-X/i],
    ["vague requirement", (value: ReviewFixPacketV1) => { value.remediation.change_units[0]!.requirements = ["Update related changes as needed."]; }, /vague requirement/i],
    ["reserved path", (value: ReviewFixPacketV1) => { value.remediation.allowed_files[0] = ".git/config"; }, /reserved Git metadata/i],
    ["case collision", (value: ReviewFixPacketV1) => { value.remediation.allowed_files.push("SRC/workflow/runtime.ts"); }, /collide case-insensitively/i],
    ["unexpected completion file", (value: ReviewFixPacketV1) => { value.completion_contract.expected_changed_files.push("src/extra.ts"); }, /unexpected changed file/i],
    ["missing executable evidence", (value: ReviewFixPacketV1) => { value.verification.success_conditions[0]!.satisfied_by = ["FIX-1"]; }, /no executable evidence/i],
  ])("rejects %s", (_label, mutate, expected) => {
    const value = packet();
    mutate(value);
    expect(reviewFixPacketReadinessErrors(value, { approved_plan_sha256: "a".repeat(64) })).toEqual(expect.arrayContaining([expect.stringMatching(expected)]));
  });

  it("rejects additional files at the schema boundary", () => {
    const value = structuredClone(packet()) as unknown as { completion_contract: { allow_additional_files: boolean } };
    value.completion_contract.allow_additional_files = true;
    expect(reviewFixPacketV1Schema.safeParse(value).success).toBe(false);
  });
});
