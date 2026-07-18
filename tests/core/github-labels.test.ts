import { describe, expect, it } from "vitest";
import {
  BRAIN_HANDS_STATE_LABELS,
  GITHUB_SETUP_LABELS,
  TERMINAL_BRAIN_HANDS_STATE_LABELS,
  TRANSIENT_BRAIN_HANDS_STATE_LABELS,
  WORKFLOW_LABELS,
  WORKFLOW_LABEL_NAMES,
  hasExactManagedStateLabel,
  managedStateLabelEdit,
} from "../../src/core/github-labels.js";

describe("workflow label manifest", () => {
  it("defines the stable workflow labels with valid GitHub metadata", () => {
    expect(WORKFLOW_LABEL_NAMES).toEqual([
      "brain-hands",
      "brain:planned",
      "brain:critiqued",
      "hands:ready",
      "verification:required",
    ]);
    expect(new Set(WORKFLOW_LABEL_NAMES.map((name) => name.toLowerCase())).size).toBe(WORKFLOW_LABELS.length);
    for (const label of WORKFLOW_LABELS) {
      expect(label.color).toMatch(/^[0-9A-F]{6}$/);
      expect(label.description.length).toBeGreaterThan(0);
      expect(label.description.length).toBeLessThanOrEqual(100);
    }
  });

  it("defines one case-insensitively unique setup and managed-state catalog", () => {
    expect(TRANSIENT_BRAIN_HANDS_STATE_LABELS).toEqual([
      "brain-hands:ready",
      "brain-hands:implementing",
      "brain-hands:verifying",
      "brain-hands:reviewing",
      "brain-hands:fixing",
      "brain-hands:blocked",
    ]);
    expect(TERMINAL_BRAIN_HANDS_STATE_LABELS).toEqual([
      "brain-hands:complete",
      "brain-hands:not-planned",
    ]);
    expect(BRAIN_HANDS_STATE_LABELS).toEqual([
      ...TRANSIENT_BRAIN_HANDS_STATE_LABELS,
      ...TERMINAL_BRAIN_HANDS_STATE_LABELS,
    ]);
    const names = GITHUB_SETUP_LABELS.map((label) => label.name.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
  });

  it.each([
    {
      state: "CLOSED" as const,
      state_reason: "COMPLETED" as const,
      labels: ["unrelated", "Brain-Hands:Ready", "brain-hands:blocked"],
      requested: "brain-hands:reviewing" as const,
      desired: "brain-hands:complete" as const,
      remove: ["Brain-Hands:Ready", "brain-hands:blocked"],
    },
    {
      state: "CLOSED" as const,
      state_reason: "NOT_PLANNED" as const,
      labels: ["unrelated", "brain-hands:reviewing", "BRAIN-HANDS:COMPLETE"],
      requested: "brain-hands:reviewing" as const,
      desired: "brain-hands:not-planned" as const,
      remove: ["brain-hands:reviewing", "BRAIN-HANDS:COMPLETE"],
    },
    {
      state: "OPEN" as const,
      state_reason: null,
      labels: ["unrelated", "brain-hands:blocked"],
      requested: "brain-hands:reviewing" as const,
      desired: "brain-hands:reviewing" as const,
      remove: ["brain-hands:blocked"],
    },
  ])("reconciles $state/$state_reason to exactly $desired", ({ state, state_reason, labels, requested, desired, remove }) => {
    expect(managedStateLabelEdit({ state, state_reason, labels }, requested)).toEqual({
      desired,
      add: [desired],
      remove,
    });
    expect(hasExactManagedStateLabel([...labels.filter((label) => !remove.includes(label)), desired], desired)).toBe(true);
  });

  it("fails closed for a closed issue with no authoritative terminal reason", () => {
    expect(() => managedStateLabelEdit({ state: "CLOSED", state_reason: null, labels: [] }, "brain-hands:ready"))
      .toThrow("terminal reason");
  });

  it.each(["brain-hands:complete", "brain-hands:not-planned"] as const)(
    "rejects projecting terminal label %s onto an open issue",
    (label) => {
      expect(() => managedStateLabelEdit({ state: "OPEN", state_reason: null, labels: [] }, label))
        .toThrow("open GitHub issue");
    },
  );
});
