import { describe, expect, it } from "vitest";
import {
  reviewerActionSchema,
  strictVerifierReviewSchema,
  verifierFindingSchema,
} from "../../src/core/schema.js";
import { verifierReviewOutputSchema } from "../../src/core/output-schemas.js";

function remediation() {
  return {
    schema_version: 1 as const,
    diagnosis: {
      observed_behavior: "Resume selects a second profile.",
      expected_behavior: "Resume reuses the persisted profile.",
      failure_mechanism: "Selection is persisted after invocation begins.",
      reproduction: ["Interrupt after the invocation claim and resume."],
      evidence_refs: ["verification/item-1/evidence.json"],
    },
    targets: [{ kind: "code" as const, path: "src/runtime.ts", symbol: "resume", line_hint: null }],
    remediation: {
      strategy: "Persist selection before invocation.",
      change_units: [{
        id: "FIX-1", path: "src/runtime.ts", target: "resume", operation: "modify" as const,
        requirements: ["Persist the profile before invocation."], satisfies: ["SC-1"],
      }],
      allowed_files: ["src/runtime.ts"],
      forbidden_changes: [],
    },
    verification: {
      commands: [{ id: "CMD-1", argv: ["npm", "test"] }],
      success_conditions: [{ id: "SC-1", statement: "Resume reuses the profile.", satisfied_by: ["CMD-1", "EVID-1"] }],
      required_evidence: [{ id: "EVID-1", kind: "test_result" as const, source_id: "CMD-1", output_path: "verification/item-1/CMD-1.json" }],
    },
    completion_contract: {
      required_change_unit_ids: ["FIX-1"], expected_changed_files: ["src/runtime.ts"], allow_additional_files: false as const,
    },
  };
}

function action() {
  return {
    severity: "medium" as const,
    file: "src/runtime.ts",
    line: null,
    acceptance_criterion: "Resume is idempotent.",
    problem_class: "correctness" as const,
    problem: "Resume can select another profile.",
    required_fix: "Persist selection before invocation.",
    evidence_refs: ["verification/item-1/evidence.json"],
    action_id: "R1-A1",
    order: 1,
    depends_on: [],
    remediation: remediation(),
  };
}

describe("strict Verifier remediation", () => {
  it("requires remediation for newly generated Reviewer actions", () => {
    const value = action();
    expect(reviewerActionSchema.safeParse(value).success).toBe(true);
    const { remediation: _removed, ...withoutRemediation } = value;
    expect(reviewerActionSchema.safeParse(withoutRemediation).success).toBe(false);
  });

  it("keeps legacy persisted findings readable without remediation", () => {
    expect(verifierFindingSchema.safeParse({
      severity: "medium", file: "src/runtime.ts", line: null,
      acceptance_criterion: "Resume is idempotent.", problem: "It fails.",
      required_fix: "Fix it.", re_verification: [["npm", "test"]],
    }).success).toBe(true);
  });

  it("accepts remediation only for request_changes generated reviews", () => {
    const base = {
      work_item_id: "item-1", attempt: 1, final: false,
      failure_class: "implementation_failure" as const,
      blocker: null, blocker_code: null,
      acceptance_coverage: [], evidence_reviewed: [], residual_risks: [],
      findings: [action()],
    };
    expect(strictVerifierReviewSchema.safeParse({ ...base, decision: "request_changes" }).success).toBe(true);
    expect(strictVerifierReviewSchema.safeParse({ ...base, decision: "approve", failure_class: "none" }).success).toBe(false);
    expect(strictVerifierReviewSchema.safeParse({ ...base, decision: "replan_required", failure_class: "replan_required" }).success).toBe(false);
  });

  it("publishes remediation and omits legacy re_verification in generated JSON schema", () => {
    const finding = verifierReviewOutputSchema.properties.findings.items.anyOf[0];
    expect(finding.properties).toHaveProperty("remediation");
    expect(finding.properties).not.toHaveProperty("re_verification");
    expect(finding.required).toContain("remediation");
    const remediation = finding.properties.remediation;
    expect(remediation.properties.targets.items).toHaveProperty("anyOf");
    expect(remediation.properties.remediation.properties.change_units.items.required).toEqual(["id", "path", "target", "operation", "requirements", "satisfies"]);
    expect(remediation.properties.completion_contract.required).toEqual(
      Object.keys(remediation.properties.completion_contract.properties),
    );
  });

  it("publishes a provider-compatible object and complete strict finding variants", () => {
    const propertyNames = Object.keys(verifierReviewOutputSchema.properties).sort();
    expect([...verifierReviewOutputSchema.required].sort()).toEqual(propertyNames);
    expect(verifierReviewOutputSchema).not.toHaveProperty("anyOf");
    for (const finding of verifierReviewOutputSchema.properties.findings.items.anyOf) {
      expect([...finding.required].sort()).toEqual(Object.keys(finding.properties).sort());
    }

    const visit = (value: unknown): void => {
      if (!value || typeof value !== "object") return;
      const node = value as Record<string, unknown>;
      if (Object.hasOwn(node, "const")) expect(node).toHaveProperty("type");
      for (const child of Object.values(node)) visit(child);
    };
    visit(verifierReviewOutputSchema);
  });
});
