import { describe, expect, it } from "vitest";
import type { BrainPlan } from "../../src/core/types.js";
import { integratedWorkItem } from "../../src/workflow/integrated-work-item.js";
import { executionSpec } from "../fixtures/execution-spec.js";

describe("integratedWorkItem", () => {
  it("merges duplicate forbidden paths across approved work items", () => {
    const first = executionSpec("first");
    const second = executionSpec("second");
    first.forbidden_changes = [{ path: ".brain-hands", except: ["first"], reason: "Controller-owned." }];
    second.forbidden_changes = [{ path: ".brain-hands", except: ["second"], reason: "Do not modify." }];
    const plan: BrainPlan = {
      summary: "Integrated delivery",
      assumptions: [],
      research: [],
      research_sources: ["repo"],
      architecture: "local",
      risks: [],
      work_items: [first, second],
      integration_verification: [["npm", "test"]],
    };

    expect(integratedWorkItem(plan).forbidden_changes).toEqual([{
      path: ".brain-hands",
      except: ["first", "second"],
      reason: "Controller-owned. Do not modify.",
    }]);
  });
});
