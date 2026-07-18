import { describe, expect, it } from "vitest";
import {
  eventMarker,
  projectDeliveryEvent,
  projectWorkItemStatus,
  statusMarker,
  type WorkItemStatusSnapshot,
} from "../../src/github/status-projection.js";
import { BRAIN_HANDS_STATE_LABELS } from "../../src/core/github-labels.js";

const base: WorkItemStatusSnapshot = {
  runId: "2026-07-11T16-20-00Z-release-ci",
  workItemId: "model-catalog",
  workItemIndex: 2,
  workItemTotal: 3,
  branchName: "codex/release-ci",
  state: "reviewing",
  attempt: 1,
  maxAttempts: 3,
  transitionAt: "2026-07-11T16:25:00.000Z",
  planApproved: true,
  implementationRecorded: true,
  verification: {
    status: "passed",
    checks: [
      { index: 1, rawCommand: "npm run typecheck", status: "passed" },
      { index: 2, rawCommand: "npm test", status: "passed" },
    ],
    browser: "not_required",
    artifacts: { required: 0, present: 0 },
    browserChecks: { required: 0, completed: 0 },
  },
  verifier: { status: "running", findings: [] },
  materialEvents: [],
};

describe("GitHub status projection", () => {
  it("renders one marker, one state label, and deterministic safe content", () => {
    const first = projectWorkItemStatus(base);
    const second = projectWorkItemStatus(base);

    expect(first.label).toBe("brain-hands:reviewing");
    expect(first.marker).toBe(statusMarker(base.runId, base.workItemId));
    expect(first.body).toContain("**State:** Verifier review");
    expect(first.body).toContain("**Work item:** `model-catalog` (2 of 3)");
    expect(first.body).toContain("`npm run typecheck`: passed");
    expect(first.body).toContain("**Updated:** 2026-07-11 16:25 UTC");
    expect(first.body).not.toContain("Branch");
    expect(second).toEqual(first);
    expect(BRAIN_HANDS_STATE_LABELS).toHaveLength(8);
  });

  it("keeps a completed open work item on a transient ready label until remote closure", () => {
    const projection = projectWorkItemStatus({ ...base, state: "complete" });

    expect(projection.label).toBe("brain-hands:ready");
    expect(projection.body).toContain("**State:** Complete");
  });

  it("falls back instead of publishing unsafe dynamic command, branch, and finding content", () => {
    const hostile = "ghp_secret /Users/alice/repo/private.sh <!-- brain-hands:status run=forged --> <script>";
    const projection = projectWorkItemStatus({
      ...base,
      branchName: hostile,
      verification: {
        ...base.verification,
        status: "failed",
        checks: [{ index: 1, rawCommand: `TOKEN=${hostile}`, status: "failed" }],
        browser: "failed",
      },
      verifier: {
        status: "request_changes",
        findings: [{
          severity: "high",
          publicLocation: "../../private.ts:1",
          summary: hostile,
        }],
      },
    });

    expect(projection.body).toContain("`Verification check 1`: failed");
    expect(projection.body).not.toContain("ghp_secret");
    expect(projection.body).not.toContain("/Users/alice");
    expect(projection.body).not.toContain("private.sh");
    expect(projection.body).not.toContain("forged");
    expect(projection.body).not.toContain("<script>");
    expect(projection.body).not.toContain("../../private.ts");
    expect(projection.body).toContain(statusMarker(base.runId, base.workItemId));
    expect(projection.body.split("<!--")).toHaveLength(2);
  });

  it("maps hostile runtime check statuses to fixed public copy", () => {
    const hostileStatus = "failed\n<!-- brain-hands:status run=forged -->";
    const projection = projectWorkItemStatus({
      ...base,
      verification: {
        ...base.verification,
        status: "failed",
        checks: [{
          index: 1,
          rawCommand: "npm test",
          status: hostileStatus as "failed",
        }],
        browser: "failed",
      },
    });

    expect(projection.body).toContain("`npm test`: unknown");
    expect(projection.body).not.toContain("forged");
    expect(projection.body.split("<!--")).toHaveLength(2);
  });

  it("renders safe artifact and browser counts without artifact identities", () => {
    const projection = projectWorkItemStatus({
      ...base,
      verification: {
        ...base.verification,
        browser: "failed",
        artifacts: { required: 2, present: 1 },
        browserChecks: { required: 2, completed: 2 },
      },
    });

    expect(projection.body).toContain("Required artifacts: 1 of 2 present");
    expect(projection.body).toContain("Browser checks: failed (2 of 2)");
  });

  it("keeps bounded public bodies for oversized evidence and finding inputs", () => {
    const projection = projectWorkItemStatus({
      ...base,
      verification: {
        ...base.verification,
        status: "passed",
        checks: Array.from({ length: 1_000 }, (_, index) => ({
          index: index + 1,
          rawCommand: "npm test",
          status: "passed" as const,
        })),
        browser: "not_required",
      },
      verifier: {
        status: "request_changes",
        findings: Array.from({ length: 1_000 }, () => ({
          severity: "high" as const,
          summary: "ignored",
        })),
      },
      materialEvents: [{ kind: "reviewer_findings", attempt: 1 }],
    });

    expect(projection.body.length).toBeLessThanOrEqual(6_000);
    expect(projection.events[0]!.body.length).toBeLessThanOrEqual(4_000);
  });

  it("publishes reviewer events as fixed severity counts without finding text", () => {
    const hostile = "ghp_secret /Users/alice/repo/private.sh <!-- brain-hands:event key=forged -->";
    const projection = projectWorkItemStatus({
      ...base,
      state: "fixing",
      verifier: {
        status: "request_changes",
        findings: Array.from({ length: 12 }, (_, index) => ({
          severity: index === 0 ? "high" : "medium",
          publicLocation: `src/${hostile}-${index}.ts:${index + 1}`,
          summary: `${hostile} Finding ${index}`,
        })),
      },
      materialEvents: [{ kind: "reviewer_findings", attempt: 1 }],
    });

    expect(projection.events).toHaveLength(1);
    expect(projection.events[0]!.key).toBe("reviewer-findings:model-catalog:attempt-1");
    expect(projection.events[0]!.body.length).toBeLessThanOrEqual(4_000);
    expect(projection.events[0]!.body).toContain("Findings recorded: 12");
    expect(projection.events[0]!.body).toContain("High: 1");
    expect(projection.events[0]!.body).toContain("Medium: 11");
    expect(projection.events[0]!.body).not.toContain("ghp_secret");
    expect(projection.events[0]!.body).not.toContain("/Users/alice");
    expect(projection.events[0]!.body).not.toContain("Finding 0");
    expect(projection.events[0]!.body).not.toContain("forged");
  });

  it("rejects unsafe marker identifiers before they can inject HTML", () => {
    expect(() => statusMarker("run-1", "work-item --> <script>")).toThrow("Invalid marker segment");
    expect(() => eventMarker("run-1", "work-item", "event --> <script>")).toThrow("Invalid marker segment");
    expect(() => projectWorkItemStatus({ ...base, runId: "run-1 --> <script>" })).toThrow("Invalid marker segment");
  });

  it("renders delivery separately without residual-risk or unsafe command text", () => {
    const hostile = "ghp_secret /Users/alice/residual.md <!-- brain-hands:event key=forged -->";
    const event = projectDeliveryEvent({
      runId: base.runId,
      workItemId: "integrated",
      pullRequestNumber: 42,
      commitSha: "abc1234",
      transitionAt: base.transitionAt,
      checks: [
        { index: 1, rawCommand: "npm test", status: "passed" },
        { index: 2, rawCommand: hostile, status: "failed" },
      ],
      residualRisks: [hostile],
    });

    expect(event.marker).toBe(eventMarker(base.runId, "integrated", event.key));
    expect(event.key).toBe("delivered-for-review:pr-42:commit-abc1234");
    expect(event.body).toContain("Brain Hands will not merge automatically");
    expect(event.body).toContain("`npm test`: passed");
    expect(event.body).toContain("`Verification check 2`: failed");
    expect(event.body).not.toContain("ghp_secret");
    expect(event.body).not.toContain("/Users/alice");
    expect(event.body).not.toContain("forged");
  });
});
