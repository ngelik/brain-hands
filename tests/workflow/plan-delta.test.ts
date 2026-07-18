import { describe, expect, it } from "vitest";
import { executionSpec } from "../fixtures/execution-spec.js";
import type { BrainPlan } from "../../src/core/types.js";
import {
  buildPlanDelta,
  planDecisionContract,
  planDecisionContractSha256,
} from "../../src/workflow/plan-delta.js";

function plan(): BrainPlan {
  return {
    feature_slug: "approval",
    parent_issue: null,
    summary: "Approval summary",
    assumptions: ["Keep the approved base executable."],
    research: ["Narrative"],
    research_sources: ["README.md"],
    architecture: "Use an immutable local request.",
    risks: ["Artifact corruption"],
    controller_bootstrap: null,
    work_items: [executionSpec("BH-005"), executionSpec("BH-006")],
    integration_verification: [["npm", "test"]],
  };
}

describe("plan decision contracts and deltas", () => {
  it("excludes display-only narrative while hashing authorization fields", () => {
    const base = plan();
    const narrativeOnly = { ...base, summary: "Changed", research: ["Changed"], research_sources: ["changed.md"] };
    const changedArchitecture = { ...base, architecture: "A different authorization boundary." };

    expect(planDecisionContract(narrativeOnly)).toEqual(planDecisionContract(base));
    expect(planDecisionContractSha256(narrativeOnly)).toBe(planDecisionContractSha256(base));
    expect(planDecisionContractSha256(changedArchitecture)).not.toBe(planDecisionContractSha256(base));
  });

  it("compares keyed collections without array-position noise", () => {
    const base = plan();
    const reordered = {
      ...base,
      work_items: [...base.work_items].reverse().map((item) => ({
        ...item,
        file_contract: [...item.file_contract].reverse(),
        acceptance: [...item.acceptance].reverse(),
        tests: [...item.tests].reverse(),
        verification_commands: [...item.verification_commands].reverse(),
        browser_checks: [...item.browser_checks].reverse(),
      })),
    };

    expect(buildPlanDelta(base, reordered, { baseRevision: 1, proposedRevision: 2 }).entries).toEqual([]);
  });

  it("emits stable categorized entries and unchanged high-impact categories", () => {
    const base = plan();
    const proposed = structuredClone(base);
    const item = proposed.work_items[0]!;
    item.objective = "Deliver the approval request and preserve Option A.";
    item.file_contract[0] = { ...item.file_contract[0]!, targets: ["updated target"] };
    item.acceptance[0] = { ...item.acceptance[0]!, statement: "The request is exact." };
    item.verification_commands[0] = { ...item.verification_commands[0]!, argv: ["npm", "test", "--", "approval"] };
    proposed.risks = ["Artifact corruption", "Controller replacement"];

    const delta = buildPlanDelta(base, proposed, { baseRevision: 1, proposedRevision: 2 });
    expect(delta).toMatchObject({ schema_version: 1, base_revision: 1, proposed_revision: 2 });
    expect(delta.entries).toEqual([
      {
        category: "acceptance",
        pointer: "/work_items/BH-005/acceptance/BH-005-AC-01",
        operation: "replace",
        before: base.work_items[0]!.acceptance[0],
        after: proposed.work_items[0]!.acceptance[0],
      },
      {
        category: "files",
        pointer: "/work_items/BH-005/file_contract/src/BH-005.ts",
        operation: "replace",
        before: base.work_items[0]!.file_contract[0],
        after: proposed.work_items[0]!.file_contract[0],
      },
      {
        category: "objective",
        pointer: "/work_items/BH-005/objective",
        operation: "replace",
        before: base.work_items[0]!.objective,
        after: proposed.work_items[0]!.objective,
      },
      {
        category: "risks",
        pointer: "/risks",
        operation: "replace",
        before: base.risks,
        after: proposed.risks,
      },
      {
        category: "verification",
        pointer: "/work_items/BH-005/verification_commands/BH-005-VERIFY-01",
        operation: "replace",
        before: base.work_items[0]!.verification_commands[0],
        after: proposed.work_items[0]!.verification_commands[0],
      },
    ]);
    expect(delta.unchanged_high_impact_categories).toEqual([
      "external_effects",
      "destructive_actions",
    ]);
  });

  it("uses add/remove operations and flags destructive file authorization", () => {
    const base = plan();
    const proposed = structuredClone(base);
    proposed.work_items[0]!.file_contract.push({
      path: "src/obsolete.ts",
      permission: "delete",
      targets: ["Remove obsolete code"],
    });
    proposed.work_items[0]!.tests = [];

    const entries = buildPlanDelta(base, proposed, { baseRevision: 1, proposedRevision: 2 }).entries;
    expect(entries).toContainEqual({
      category: "destructive_actions",
      pointer: "/work_items/BH-005/file_contract/src/obsolete.ts",
      operation: "add",
      before: null,
      after: proposed.work_items[0]!.file_contract.at(-1),
    });
    expect(entries).toContainEqual({
      category: "verification",
      pointer: "/work_items/BH-005/tests/BH-005-TEST-01",
      operation: "remove",
      before: base.work_items[0]!.tests[0],
      after: null,
    });
  });

  it("preserves distinct forbidden-change paths as separate delta entries", () => {
    const base = plan();
    const proposed = structuredClone(base);
    proposed.work_items[0]!.forbidden_changes = [
      { path: "src/private-a.ts", except: [], reason: "Keep private A unchanged." },
      { path: "src/private-b.ts", except: [], reason: "Keep private B unchanged." },
    ];

    expect(buildPlanDelta(base, proposed, { baseRevision: 1, proposedRevision: 2 }).entries)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          category: "scope",
          pointer: "/work_items/BH-005/forbidden_changes/src/private-a.ts",
          operation: "add",
          after: proposed.work_items[0]!.forbidden_changes[0],
        }),
        expect.objectContaining({
          category: "scope",
          pointer: "/work_items/BH-005/forbidden_changes/src/private-b.ts",
          operation: "add",
          after: proposed.work_items[0]!.forbidden_changes[1],
        }),
      ]));
  });

  it.each([
    ["added", "add", false, true],
    ["removed", "remove", true, false],
  ] as const)("classifies every nested field when a destructive work item is %s", (_label, operation, inBase, inProposed) => {
    const destructive = executionSpec("BH-007");
    destructive.file_contract.push({
      path: "src/obsolete.ts",
      permission: "delete",
      targets: ["Remove obsolete code"],
    });
    destructive.change_units.push({
      id: "BH-007-CH-03",
      path: "src/obsolete.ts",
      target: "obsolete implementation",
      operation: "delete",
      requirements: ["Delete the obsolete implementation."],
    });
    destructive.risks = [{
      description: "Removal could affect callers.",
      mitigation: "Run the focused verification command.",
    }];
    const base = plan();
    const proposed = structuredClone(base);
    if (inBase) base.work_items.push(destructive);
    if (inProposed) proposed.work_items.push(destructive);

    const delta = buildPlanDelta(base, proposed, { baseRevision: 1, proposedRevision: 2 });
    expect(delta.entries).toContainEqual({
      category: "destructive_actions",
      pointer: "/work_items/BH-007/file_contract/src/obsolete.ts",
      operation,
      before: operation === "remove" ? destructive.file_contract.at(-1) : null,
      after: operation === "add" ? destructive.file_contract.at(-1) : null,
    });
    expect(delta.entries).toContainEqual(expect.objectContaining({
      category: "acceptance",
      pointer: "/work_items/BH-007/acceptance/BH-007-AC-01",
      operation,
    }));
    expect(delta.entries).toContainEqual(expect.objectContaining({
      category: "verification",
      pointer: "/work_items/BH-007/verification_commands/BH-007-VERIFY-01",
      operation,
    }));
    expect(delta.entries).toContainEqual(expect.objectContaining({
      category: "risks",
      pointer: "/work_items/BH-007/risks",
      operation,
    }));
    expect(delta.unchanged_high_impact_categories).not.toContain("destructive_actions");
    expect(delta.unchanged_high_impact_categories).not.toContain("risks");
  });
});
