import { describe, expect, it } from "vitest";
import type { BrainPlan, ReplanPatch } from "../../src/core/types.js";
import { materializeReplanCandidate } from "../../src/workflow/replan-candidate.js";
import { executionSpec } from "../fixtures/execution-spec.js";

const basePlan: BrainPlan = {
  feature_slug: "prepared-replan",
  parent_issue: null,
  summary: "Implement a bounded change",
  assumptions: [],
  research: [],
  research_sources: ["repo"],
  architecture: "Keep identities stable",
  risks: [],
  controller_bootstrap: null,
  work_items: [
    {
      ...executionSpec("BH-005"),
      objective: "Repair the target behavior",
      forbidden_changes: [{
        path: "*",
        except: ["src/BH-005.ts", "tests/BH-005.test.ts"],
        reason: "Only the work-item contract may change.",
      }],
    },
    executionSpec("BH-006", ["BH-005"]),
  ],
  integration_verification: [["npm", "test"]],
};

const patch: ReplanPatch = {
  target_work_item_id: "BH-005",
  base_plan_revision: 1,
  unresolved_finding_ids: [`finding:${"a".repeat(64)}`],
  revised_objective: "Repair the target behavior with the verified constraint.",
  added_or_changed_criteria: [{
    ref: "BH-005:AC-1",
    text: "The target behavior is correct after the verified edge case.",
  }],
  changed_instructions: ["Handle the verified edge case in the target behavior."],
  added_change_units: [{
    id: "BH-005-CH-03",
    path: "src/new.ts",
    target: "verified edge case",
    operation: "create",
    requirements: ["Implement the verified edge case."],
    satisfies: ["BH-005-AC-01"],
  }],
  added_verification_commands: [{
    id: "BH-005-VERIFY-02",
    argv: ["npm", "test"],
    expected_exit_code: 0,
    satisfies: ["BH-005-AC-01"],
  }],
  added_cross_cutting_impacts: [],
  added_read_only_file_contracts: [],
  explicitly_rejected_hardening: [],
};

describe("materializeReplanCandidate", () => {
  it("purely materializes the exact target transformation and preserves unrelated plan data", () => {
    const discoveredBase = {
      ...basePlan,
      discovery_brief_revision: 1,
      discovery_brief_sha256: "b".repeat(64),
      discovery_decision_coverage: [],
      accepted_risks: [],
      out_of_scope: ["Unrelated refactors"],
    };
    const frozenBase = structuredClone(discoveredBase);

    const proposed = materializeReplanCandidate({
      basePlan: discoveredBase,
      targetWorkItemId: "BH-005",
      patch,
      durableCriteria: [{ ref: "BH-005:AC-1", text: "The target behavior is correct." }],
      workflowProtocol: "durable-discovery-v1",
    });

    const target = proposed.work_items[0]!;
    expect(target).toMatchObject({
      objective: patch.revised_objective,
      completion_contract: {
        expected_changed_files: ["src/BH-005.ts", "tests/BH-005.test.ts", "src/new.ts"],
      },
    });
    expect(target.acceptance[0]).toMatchObject({
      statement: patch.added_or_changed_criteria[0]!.text,
      satisfied_by: expect.arrayContaining(["BH-005-CH-03"]),
    });
    expect(target.file_contract).toContainEqual({
      path: "src/new.ts",
      permission: "create",
      targets: ["verified edge case"],
    });
    expect(target.forbidden_changes[0]!.except).toContain("src/new.ts");
    expect(target.change_units).toContainEqual({
      id: "BH-005-CH-03",
      path: "src/new.ts",
      target: "verified edge case",
      operation: "create",
      requirements: ["Implement the verified edge case."],
    });
    expect(target.change_units[0]!.requirements).toEqual(patch.changed_instructions);
    const { satisfies: _satisfies, ...persistedCommand } = patch.added_verification_commands[0]!;
    expect(target.verification_commands).toContainEqual(persistedCommand);
    expect(target.acceptance[0]!.satisfied_by).toContain(persistedCommand.id);
    expect(proposed.work_items[1]).toEqual(discoveredBase.work_items[1]);
    expect(proposed).toMatchObject({
      discovery_brief_revision: 1,
      discovery_brief_sha256: "b".repeat(64),
      discovery_decision_coverage: [],
      accepted_risks: [],
      out_of_scope: ["Unrelated refactors"],
    });
    expect(discoveredBase).toEqual(frozenBase);
  });

  it("rejects a missing target deterministically", () => {
    expect(() => materializeReplanCandidate({
      basePlan,
      targetWorkItemId: "BH-404",
      patch,
      durableCriteria: [{ ref: "BH-005:AC-1", text: "The target behavior is correct." }],
      workflowProtocol: "legacy-v2",
    })).toThrow(/target.*absent/i);

  });
});
