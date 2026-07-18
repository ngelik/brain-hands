import { describe, expect, it } from "vitest";
import { topologicallySortWorkItems } from "../../src/core/work-item-order.js";
import type { WorkItem } from "../../src/core/types.js";
import { topologicallySortWorkItems as runtimeTopologicallySortWorkItems } from "../../src/workflow/runtime.js";
import { executionSpec } from "../fixtures/execution-spec.js";

describe("topologicallySortWorkItems", () => {
  it("orders dependencies before their dependents", () => {
    const items = [executionSpec("dependent", ["dependency"]), executionSpec("dependency")] as const;

    expect(topologicallySortWorkItems(items).map((item) => item.id)).toEqual(["dependency", "dependent"]);
  });

  it("preserves plan order for independent work items", () => {
    const items = [executionSpec("second"), executionSpec("first"), executionSpec("third")] as const;

    expect(topologicallySortWorkItems(items).map((item) => item.id)).toEqual(["second", "first", "third"]);
  });

  it("uses plan order to break ties among ready items in mixed graphs", () => {
    const items = [
      executionSpec("dependent", ["dependency"]),
      executionSpec("independent"),
      executionSpec("dependency"),
    ] as const;

    expect(topologicallySortWorkItems(items).map((item) => item.id)).toEqual([
      "independent",
      "dependency",
      "dependent",
    ]);
  });

  it("keeps original-index priority stable across branching dependencies", () => {
    const items = [
      executionSpec("dependent", ["left", "right"]),
      executionSpec("right"),
      executionSpec("independent"),
      executionSpec("left"),
    ] as const;

    expect(topologicallySortWorkItems(items).map((item) => item.id)).toEqual([
      "right",
      "independent",
      "left",
      "dependent",
    ]);
  });

  it("accepts readonly input without mutating items or dependency arrays", () => {
    const first = executionSpec("first");
    const second = executionSpec("second", ["first"]);
    Object.freeze(first.dependencies);
    Object.freeze(second.dependencies);
    const items: readonly WorkItem[] = Object.freeze([second, first]);
    const before = JSON.stringify(items);

    expect(topologicallySortWorkItems(items).map((item) => item.id)).toEqual(["first", "second"]);
    expect(JSON.stringify(items)).toBe(before);
    expect(runtimeTopologicallySortWorkItems).toBe(topologicallySortWorkItems);
  });

  it("rejects duplicate work item IDs", () => {
    expect(() => topologicallySortWorkItems([
      executionSpec("duplicate"),
      executionSpec("duplicate"),
    ])).toThrow(/^Duplicate work item id: duplicate$/);
  });

  it("rejects missing dependencies", () => {
    expect(() => topologicallySortWorkItems([
      executionSpec("dependent", ["missing"]),
    ])).toThrow(/^Work item dependent depends on missing work item missing$/);
  });

  it("rejects cyclic dependencies", () => {
    expect(() => topologicallySortWorkItems([
      executionSpec("first", ["second"]),
      executionSpec("second", ["first"]),
    ])).toThrow(/^Cyclic work item dependency involving first$/);
  });

  it("orders a 15,000-item dependency chain without recursion or quadratic scanning", () => {
    const items = Array.from({ length: 15_000 }, (_, index) => ({
      id: `node-${index}`,
      dependencies: index === 0 ? [] : [`node-${index - 1}`],
    } as WorkItem));

    const ordered = topologicallySortWorkItems(items);

    expect(ordered).toHaveLength(15_000);
    expect(ordered[0]?.id).toBe("node-0");
    expect(ordered.at(-1)?.id).toBe("node-14999");
  }, 10_000);

  it("reports the cycle contract for a 15,000-item cycle instead of overflowing the stack", () => {
    const items = Array.from({ length: 15_000 }, (_, index) => ({
      id: `node-${index}`,
      dependencies: [`node-${(index + 1) % 15_000}`],
    } as WorkItem));

    expect(() => topologicallySortWorkItems(items)).toThrow(/^Cyclic work item dependency involving node-0$/);
  }, 10_000);
});
