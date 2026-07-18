import type { TerminalOutcome } from "../core/types.js";

export type GitHubIssueClosureReason = "completed" | "not_planned";
export type GitHubIssueLifecycleAction =
  | { action: "keep_open" }
  | { action: "none"; reason: "already_closed" }
  | { action: "close"; reason: GitHubIssueClosureReason };

export interface IssueLifecycleInput {
  terminalOutcome: TerminalOutcome | null;
  pullRequestState: "OPEN" | "CLOSED" | "MERGED" | null;
  pullRequestBase: string | null;
  defaultBranch: string;
  issueState: "OPEN" | "CLOSED";
}

const SAFE_MARKER_SEGMENT = /^[A-Za-z0-9._:-]{1,160}$/;
const CLOSING_BLOCK_END = "<!-- /brain-hands:issue-links -->";
const CLOSING_BLOCK_TOKEN = "brain-hands:issue-links";
const ANY_CLOSING_BLOCK_MARKER = /<!--\s*\/?brain-hands:issue-links\b[^>]*-->/g;

export function deriveIssueLifecycleAction(input: IssueLifecycleInput): GitHubIssueLifecycleAction {
  if (input.issueState === "CLOSED") return { action: "none", reason: "already_closed" };
  if (input.terminalOutcome === "abandoned" || input.terminalOutcome === "closed_blocked") {
    return { action: "close", reason: "not_planned" };
  }
  if (
    input.pullRequestState === "MERGED"
    && input.pullRequestBase === input.defaultBranch
  ) {
    return { action: "close", reason: "completed" };
  }
  return { action: "keep_open" };
}

function assertIssueNumber(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("Invalid GitHub issue number");
}

function closingBlockStart(runId: string, lineageId?: string): string {
  if (!SAFE_MARKER_SEGMENT.test(runId)) throw new Error("Invalid Brain Hands run ID for managed closing-link block");
  if (lineageId !== undefined && !SAFE_MARKER_SEGMENT.test(lineageId)) {
    throw new Error("Invalid Brain Hands lineage ID for managed closing-link block");
  }
  return lineageId === undefined
    ? `<!-- brain-hands:issue-links run=${runId} schema=1 -->`
    : `<!-- brain-hands:issue-links lineage=${lineageId} run=${runId} schema=1 -->`;
}

export function expectedClosingIssueNumbers(input: {
  parentIssueNumber?: number;
  workItems: readonly { id: string; issueNumber: number }[];
}): number[] {
  const ordered = [
    ...(input.parentIssueNumber === undefined ? [] : [input.parentIssueNumber]),
    ...input.workItems.map((item) => item.issueNumber),
  ];
  const seen = new Set<number>();
  return ordered.filter((number) => {
    assertIssueNumber(number);
    if (seen.has(number)) return false;
    seen.add(number);
    return true;
  });
}

export function renderClosingLinksBlock(runId: string, issueNumbers: readonly number[]): string;
export function renderClosingLinksBlock(lineageId: string, runId: string, issueNumbers: readonly number[]): string;
export function renderClosingLinksBlock(
  lineageOrRunId: string,
  runOrIssueNumbers: string | readonly number[],
  lineageIssueNumbers?: readonly number[],
): string {
  const lineageId = typeof runOrIssueNumbers === "string" ? lineageOrRunId : undefined;
  const runId = typeof runOrIssueNumbers === "string" ? runOrIssueNumbers : lineageOrRunId;
  const issueNumbers = typeof runOrIssueNumbers === "string" ? lineageIssueNumbers! : runOrIssueNumbers;
  const start = closingBlockStart(runId, lineageId);
  if (issueNumbers.length === 0) throw new Error("Managed closing-link block requires at least one issue");
  const unique = new Set<number>();
  const relations = issueNumbers.map((number) => {
    assertIssueNumber(number);
    if (unique.has(number)) throw new Error(`Duplicate GitHub issue number #${number}`);
    unique.add(number);
    return `Closes #${number}`;
  });
  return [start, ...relations, CLOSING_BLOCK_END].join("\n");
}

export function reconcileClosingLinksBlock(
  currentBody: string,
  runId: string,
  issueNumbers: readonly number[],
): string;
export function reconcileClosingLinksBlock(
  currentBody: string,
  lineageId: string,
  runId: string,
  issueNumbers: readonly number[],
): string;
export function reconcileClosingLinksBlock(
  currentBody: string,
  lineageOrRunId: string,
  runOrIssueNumbers: string | readonly number[],
  lineageIssueNumbers?: readonly number[],
): string {
  const lineageId = typeof runOrIssueNumbers === "string" ? lineageOrRunId : undefined;
  const runId = typeof runOrIssueNumbers === "string" ? runOrIssueNumbers : lineageOrRunId;
  const issueNumbers = typeof runOrIssueNumbers === "string" ? lineageIssueNumbers! : runOrIssueNumbers;
  const desired = lineageId === undefined
    ? renderClosingLinksBlock(runId, issueNumbers)
    : renderClosingLinksBlock(lineageId, runId, issueNumbers);
  const start = closingBlockStart(runId, lineageId);
  const markers = [...currentBody.matchAll(ANY_CLOSING_BLOCK_MARKER)].map((match) => match[0]);
  if (markers.length === 0) {
    if (currentBody.includes(CLOSING_BLOCK_TOKEN)) {
      throw new Error("PR body has a malformed managed closing-link block");
    }
    if (currentBody.length === 0) return desired;
    const separator = currentBody.endsWith("\n\n") ? "" : currentBody.endsWith("\n") ? "\n" : "\n\n";
    return `${currentBody}${separator}${desired}`;
  }
  if (markers.length !== 2 || markers[0] !== start || markers[1] !== CLOSING_BLOCK_END) {
    throw new Error("PR body has an ambiguous or foreign managed closing-link block");
  }
  const startIndex = currentBody.indexOf(start);
  const endIndex = currentBody.indexOf(CLOSING_BLOCK_END, startIndex + start.length);
  if (startIndex < 0 || endIndex < startIndex) {
    throw new Error("PR body has a malformed managed closing-link block");
  }
  return `${currentBody.slice(0, startIndex)}${desired}${currentBody.slice(endIndex + CLOSING_BLOCK_END.length)}`;
}

export function missingClosingIssueNumbers(
  expected: readonly number[],
  parsed: readonly number[],
): number[] {
  const parsedSet = new Set(parsed);
  return expected.filter((number) => !parsedSet.has(number));
}
