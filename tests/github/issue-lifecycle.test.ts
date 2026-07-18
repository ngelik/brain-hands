import { describe, expect, it } from "vitest";
import {
  deriveIssueLifecycleAction,
  expectedClosingIssueNumbers,
  missingClosingIssueNumbers,
  reconcileClosingLinksBlock,
  renderClosingLinksBlock,
} from "../../src/github/issue-lifecycle.js";

describe("deriveIssueLifecycleAction", () => {
  it.each([
    { label: "verified work", terminalOutcome: null, pullRequestState: null },
    { label: "an open pull request", terminalOutcome: "delivered" as const, pullRequestState: "OPEN" as const },
    { label: "a closed unmerged pull request", terminalOutcome: "delivered" as const, pullRequestState: "CLOSED" as const },
    { label: "a resumable blocker", terminalOutcome: null, pullRequestState: null },
  ])("keeps $label open", ({ terminalOutcome, pullRequestState }) => {
    expect(deriveIssueLifecycleAction({
      terminalOutcome,
      pullRequestState,
      pullRequestBase: pullRequestState ? "main" : null,
      defaultBranch: "main",
      issueState: "OPEN",
    })).toEqual({ action: "keep_open" });
  });

  it.each(["delivered", "human_accepted"] as const)(
    "closes a merged %s delivery as completed",
    (terminalOutcome) => {
      expect(deriveIssueLifecycleAction({
        terminalOutcome,
        pullRequestState: "MERGED",
        pullRequestBase: "main",
        defaultBranch: "main",
        issueState: "OPEN",
      })).toEqual({ action: "close", reason: "completed" });
    },
  );

  it("closes a verified default-branch merge even when the terminal record was interrupted", () => {
    expect(deriveIssueLifecycleAction({
      terminalOutcome: null,
      pullRequestState: "MERGED",
      pullRequestBase: "main",
      defaultBranch: "main",
      issueState: "OPEN",
    })).toEqual({ action: "close", reason: "completed" });
  });

  it("keeps a pull request merged outside the default branch open", () => {
    expect(deriveIssueLifecycleAction({
      terminalOutcome: "delivered",
      pullRequestState: "MERGED",
      pullRequestBase: "release",
      defaultBranch: "main",
      issueState: "OPEN",
    })).toEqual({ action: "keep_open" });
  });

  it.each(["abandoned", "closed_blocked"] as const)(
    "closes an explicitly %s run as not planned",
    (terminalOutcome) => {
      expect(deriveIssueLifecycleAction({
        terminalOutcome,
        pullRequestState: null,
        pullRequestBase: null,
        defaultBranch: "main",
        issueState: "OPEN",
      })).toEqual({ action: "close", reason: "not_planned" });
    },
  );

  it("never changes an issue that is already closed", () => {
    expect(deriveIssueLifecycleAction({
      terminalOutcome: "delivered",
      pullRequestState: "MERGED",
      pullRequestBase: "main",
      defaultBranch: "main",
      issueState: "CLOSED",
    })).toEqual({ action: "none", reason: "already_closed" });
  });
});

describe("managed closing links", () => {
  const lineageId = "946c7414-d500-4e65-a596-dcf99f0015c2";

  it("orders the parent first and deduplicates children in approved order", () => {
    expect(expectedClosingIssueNumbers({
      parentIssueNumber: 9,
      workItems: [
        { id: "first", issueNumber: 14 },
        { id: "duplicate-parent", issueNumber: 9 },
        { id: "second", issueNumber: 15 },
        { id: "duplicate-child", issueNumber: 14 },
      ],
    })).toEqual([9, 14, 15]);
  });

  it("renders one exact GitHub closing keyword per issue", () => {
    expect(renderClosingLinksBlock("run-1", [9, 14, 15])).toBe([
      "<!-- brain-hands:issue-links run=run-1 schema=1 -->",
      "Closes #9",
      "Closes #14",
      "Closes #15",
      "<!-- /brain-hands:issue-links -->",
    ].join("\n"));
  });

  it("records lineage ownership and run provenance in the managed block", () => {
    expect(renderClosingLinksBlock(lineageId, "run-1", [14])).toBe([
      `<!-- brain-hands:issue-links lineage=${lineageId} run=run-1 schema=1 -->`,
      "Closes #14",
      "<!-- /brain-hands:issue-links -->",
    ].join("\n"));

    expect(reconcileClosingLinksBlock("Summary", lineageId, "run-1", [14])).toContain(
      `<!-- brain-hands:issue-links lineage=${lineageId} run=run-1 schema=1 -->`,
    );
  });

  it("appends a missing managed block without changing user content", () => {
    expect(reconcileClosingLinksBlock("User summary\n\nExtra details", "run-1", [14])).toBe([
      "User summary",
      "",
      "Extra details",
      "",
      "<!-- brain-hands:issue-links run=run-1 schema=1 -->",
      "Closes #14",
      "<!-- /brain-hands:issue-links -->",
    ].join("\n"));
  });

  it("preserves trailing user whitespace byte-for-byte when appending a block", () => {
    const current = "User summary  \n\n";

    expect(reconcileClosingLinksBlock(current, "run-1", [14])).toBe(
      `${current}<!-- brain-hands:issue-links run=run-1 schema=1 -->\nCloses #14\n<!-- /brain-hands:issue-links -->`,
    );
  });

  it("replaces exactly one owned block and preserves surrounding content", () => {
    const current = [
      "Summary",
      "",
      "<!-- brain-hands:issue-links run=run-1 schema=1 -->",
      "Closes #12",
      "<!-- /brain-hands:issue-links -->",
      "",
      "Reviewer note",
    ].join("\n");
    expect(reconcileClosingLinksBlock(current, "run-1", [14, 15])).toBe([
      "Summary",
      "",
      "<!-- brain-hands:issue-links run=run-1 schema=1 -->",
      "Closes #14",
      "Closes #15",
      "<!-- /brain-hands:issue-links -->",
      "",
      "Reviewer note",
    ].join("\n"));
  });

  it.each([
    ["duplicate starts", "<!-- brain-hands:issue-links run=run-1 schema=1 -->\n<!-- brain-hands:issue-links run=run-1 schema=1 -->\n<!-- /brain-hands:issue-links -->"],
    ["duplicate ends", "<!-- brain-hands:issue-links run=run-1 schema=1 -->\n<!-- /brain-hands:issue-links -->\n<!-- /brain-hands:issue-links -->"],
    ["foreign run", "<!-- brain-hands:issue-links run=run-2 schema=1 -->\nCloses #14\n<!-- /brain-hands:issue-links -->"],
  ])("fails closed for %s", (_label, body) => {
    expect(() => reconcileClosingLinksBlock(body, "run-1", [14])).toThrow(/managed closing-link block/i);
  });

  it("fails closed for an unterminated raw ownership marker", () => {
    expect(() => reconcileClosingLinksBlock(
      "Summary\n\n<!-- brain-hands:issue-links run=run-1 schema=1",
      "run-1",
      [14],
    )).toThrow(/malformed managed closing-link block/i);
  });

  it("reports only expected references GitHub did not parse", () => {
    expect(missingClosingIssueNumbers([9, 14, 15], [15, 99, 9])).toEqual([14]);
  });
});
