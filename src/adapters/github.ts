import YAML from "yaml";
import type { ExecutionSpecV2, IssueSpec, PrReviewFinding } from "../core/types.js";
import type { CommandResult } from "../core/executor.js";
import { runCommand } from "../core/executor.js";
import {
  WORKFLOW_LABEL_NAMES,
  BRAIN_HANDS_STATE_LABEL_DEFINITIONS,
  assertNoCaseInsensitiveLabelCollisions,
  hasExactManagedStateLabel,
  managedStateLabelEdit,
  type BrainHandsStateLabel,
} from "../core/github-labels.js";
import {
  expectedClosingIssueNumbers,
  reconcileClosingLinksBlock,
  type GitHubIssueClosureReason,
} from "../github/issue-lifecycle.js";

export interface OpenPullRequestInput {
  title: string;
  body: string;
  head: string;
  base: string;
}

export interface GitHubIssueMarker {
  lineageId: string;
  runId: string;
  workItemId: string;
}

export interface LegacyGitHubIssueMarker {
  lineageId?: never;
  runId: string;
  workItemId: string;
}

export type GitHubIssueMarkerInput = GitHubIssueMarker | LegacyGitHubIssueMarker;

export interface GitHubRepositoryIdentity {
  host: string;
  name_with_owner: string;
  actor: string;
}

export interface GitHubIssueReference {
  number: number;
  title: string;
  body: string;
}

export interface GitHubParentIssueMarker {
  lineageId: string;
  runId: string;
  featureSlug: string;
}

export interface LegacyGitHubParentIssueMarker {
  lineageId?: never;
  runId: string;
  featureSlug: string;
}

export type GitHubParentIssueMarkerInput = GitHubParentIssueMarker | LegacyGitHubParentIssueMarker;

export interface ParentIssueSpec {
  title: string;
  summary: string;
  runId: string;
  featureSlug: string;
  planRevision: number;
  workItems: readonly IntegratedWorkItemReference[];
}

export interface IntegratedWorkItemReference {
  id: string;
  issueNumber: number;
}

interface IntegratedPullRequestInputBase {
  runId: string;
  title: string;
  summary: string;
  head: string;
  headSha?: string;
  base: string;
  workItems: readonly IntegratedWorkItemReference[];
  parentIssueNumber?: number;
}

export interface OpenIntegratedPullRequestInput extends IntegratedPullRequestInputBase {
  lineageId: string;
}

export interface LegacyOpenIntegratedPullRequestInput extends IntegratedPullRequestInputBase {
  lineageId?: never;
}

export type OpenIntegratedPullRequestInputCompat =
  | OpenIntegratedPullRequestInput
  | LegacyOpenIntegratedPullRequestInput;

export interface GitHubPullRequestReference {
  number: number;
  url: string;
  title?: string;
  head_ref?: string;
  head_sha?: string;
  base_ref?: string;
  body?: string;
  closing_issue_numbers?: number[];
  state?: "OPEN" | "CLOSED" | "MERGED";
}

export interface GitHubIssueStateReference extends GitHubIssueReference {
  state: "OPEN" | "CLOSED";
  state_reason: "COMPLETED" | "NOT_PLANNED" | null;
  labels?: string[];
}

export interface GitHubIssueObservation extends GitHubIssueStateReference {
  labels: string[];
}

export type GitHubIssueSpec = IssueSpec | ExecutionSpecV2;

export interface GitHubCommentTarget {
  kind: "issue" | "pull_request";
  number: number;
}

export interface GitHubCommentReference {
  id: number;
  body: string;
  authorLogin: string;
}

export class StatusCommentOwnershipConflictError extends Error {
  constructor(message = "GitHub status comment marker is ambiguous or not owned by the authenticated actor") {
    super(message);
    this.name = "StatusCommentOwnershipConflictError";
  }
}

export interface GitHubAdapter {
  createIssue(issue: GitHubIssueSpec, marker?: GitHubIssueMarkerInput, title?: string): Promise<number>;
  updateIssue(issueNumber: number, issue: GitHubIssueSpec, marker?: GitHubIssueMarkerInput, currentBody?: string, title?: string): Promise<void>;
  addIssueLabels(issueNumber: number, labels: string[]): Promise<void>;
  openPullRequest(input: OpenPullRequestInput): Promise<number>;
  commentOnPullRequest(prNumber: number, body: string): Promise<void>;
  getRepositoryIdentity?(): Promise<GitHubRepositoryIdentity>;
  findIssuesByMarker?(marker: GitHubIssueMarkerInput): Promise<GitHubIssueObservation[]>;
  findIssueByMarker?(marker: GitHubIssueMarkerInput): Promise<number | GitHubIssueReference | null>;
  createParentIssue?(issue: ParentIssueSpec, marker: GitHubParentIssueMarkerInput): Promise<number>;
  findParentIssuesByMarker?(marker: GitHubParentIssueMarkerInput): Promise<GitHubIssueObservation[]>;
  findParentIssueByMarker?(marker: GitHubParentIssueMarkerInput): Promise<number | GitHubIssueReference | null>;
  updateParentIssue?(issueNumber: number, issue: ParentIssueSpec, marker: GitHubParentIssueMarkerInput, currentBody?: string): Promise<void>;
  openIntegratedPullRequest?(input: OpenIntegratedPullRequestInputCompat): Promise<GitHubPullRequestReference>;
  findPullRequestByHead?(head: string): Promise<GitHubPullRequestReference | null>;
  findPullRequestsByLineage?(lineageId: string): Promise<GitHubPullRequestReference[]>;
  getDefaultBranch?(): Promise<string>;
  getPullRequest?(pullRequestNumber: number): Promise<GitHubPullRequestReference | null>;
  updatePullRequestBody?(pullRequestNumber: number, body: string): Promise<void>;
  getIssue?(issueNumber: number): Promise<GitHubIssueStateReference>;
  closeIssue?(issueNumber: number, reason: GitHubIssueClosureReason): Promise<void>;
  updateIssueLabels?(issueNumber: number, input: { add: string[]; remove: string[] }): Promise<void>;
  commentRunStatus?(target: { kind: "issue" | "pull_request"; number: number } | number, body: string): Promise<void>;
  findStatusCommentByMarker?(target: GitHubCommentTarget, marker: string): Promise<GitHubCommentReference | null>;
  createStatusComment?(target: GitHubCommentTarget, body: string): Promise<GitHubCommentReference>;
  updateStatusComment?(commentId: number, body: string): Promise<void>;
  reconcileIssueStateLabel?(issueNumber: number, desired: BrainHandsStateLabel, options?: {
    withExternalEffect?: <T>(key: string, action: () => Promise<T>) => Promise<T>;
  }): Promise<void>;
  upsertRunStatus?(target: { kind: "issue" | "pull_request"; number: number }, marker: string, body: string): Promise<void>;
}

export const ISSUE_LABELS = WORKFLOW_LABEL_NAMES.join(",");
export const PARENT_ISSUE_LABELS = "brain-hands,brain:planned";

export interface SubprocessFailure extends Error {
  exitCode: number | null;
  errorCode?: string;
  errorMessage?: string;
  timedOut: boolean;
  signal: string | null;
  command: string;
  args: string[];
  stdout: string;
  stderr: string;
}

function commandFailureError(
  result: CommandResult,
  fallbackMessage: string,
): SubprocessFailure {
  const details = [
    `command=${result.command}`,
    `args=${JSON.stringify(result.args)}`,
    `exitCode=${result.exitCode === null ? "null" : result.exitCode}`,
    `errorCode=${result.errorCode ?? "unknown"}`,
    `timedOut=${result.timedOut}`,
    `signal=${result.signal ?? "none"}`,
    `stdout=${result.stdout ? result.stdout.trim() : "<empty>"}`,
    `stderr=${result.stderr ? result.stderr.trim() : "<empty>"}`,
  ].join(" | ");

  const error = new Error(
    `${fallbackMessage}: ${details}${
      result.errorMessage ? ` :: ${result.errorMessage}` : ""
    }`,
  ) as SubprocessFailure;

  error.exitCode = result.exitCode;
  error.errorCode = result.errorCode;
  error.errorMessage = result.errorMessage;
  error.timedOut = result.timedOut;
  error.signal = result.signal ?? null;
  error.command = result.command;
  error.args = result.args;
  error.stdout = result.stdout;
  error.stderr = result.stderr;
  return error;
}

function isExecutionSpecV2(issue: GitHubIssueSpec): issue is ExecutionSpecV2 {
  return "schema_version" in issue && issue.schema_version === "2.0";
}

function issueTitle(issue: GitHubIssueSpec): string {
  return isExecutionSpecV2(issue) ? issue.title : issue.goal;
}

export function formatIssueBody(issue: GitHubIssueSpec, marker?: GitHubIssueMarkerInput): string {
  const markerLines = marker
    ? [
        ...(marker.lineageId ? [`<!-- brain-hands-lineage:${marker.lineageId} -->`] : []),
        `<!-- brain-hands-run:${marker.runId} -->`,
        `<!-- brain-hands-work-item:${marker.workItemId} -->`,
        "",
      ]
    : [];
  if (isExecutionSpecV2(issue)) {
    return [
      ...markerLines,
      "<!-- brain-hands-managed:start -->",
      "## Goal",
      issue.title,
      "",
      "## Context",
      issue.objective,
      "",
      "## Machine-Readable Spec",
      "```json",
      JSON.stringify(issue, null, 2),
      "```",
      "<!-- brain-hands-managed:end -->",
      "",
    ].join("\n");
  }
  return [
    ...markerLines,
    "<!-- brain-hands-managed:start -->",
    ...(issue.feature_slug && issue.work_item_id && issue.plan_revision
      ? [
          "## Tracking",
          "",
          `- Feature: \`${issue.feature_slug}\``,
          `- Work item: \`${issue.work_item_id}\``,
          `- Plan revision: \`${issue.plan_revision}\``,
          `- Run: \`${issue.run_id}\``,
          ...(issue.parent_issue_number ? [`- Parent: #${issue.parent_issue_number}`] : []),
          ...(issue.dependencies.length > 0 ? [`- Dependencies: ${issue.dependencies.map((number) => `#${number}`).join(", ")}`] : []),
          "",
        ]
      : []),
    "## Goal",
    issue.goal,
    "",
    "## Context",
    issue.context,
    "",
    "## Machine-Readable Spec",
    "```yaml",
    YAML.stringify(issue).trim(),
    "```",
    "<!-- brain-hands-managed:end -->",
    "",
  ].join("\n");
}

const MANAGED_START = "<!-- brain-hands-managed:start -->";
const MANAGED_END = "<!-- brain-hands-managed:end -->";

export function reconcileManagedIssueBody(currentBody: string, desiredBody: string): string {
  const currentStart = currentBody.indexOf(MANAGED_START);
  const currentEnd = currentBody.indexOf(MANAGED_END, currentStart);
  const desiredStart = desiredBody.indexOf(MANAGED_START);
  const desiredEnd = desiredBody.indexOf(MANAGED_END, desiredStart);
  if (currentStart < 0 || currentEnd < 0 || desiredStart < 0 || desiredEnd < 0) return currentBody;
  const desiredManaged = desiredBody.slice(desiredStart, desiredEnd + MANAGED_END.length);
  return `${currentBody.slice(0, currentStart)}${desiredManaged}${currentBody.slice(currentEnd + MANAGED_END.length)}`;
}

export function formatParentIssueBody(issue: ParentIssueSpec, marker: GitHubParentIssueMarkerInput): string {
  return [
    ...(marker.lineageId ? [`<!-- brain-hands-lineage:${marker.lineageId} -->`] : []),
    `<!-- brain-hands-run:${marker.runId} -->`,
    `<!-- brain-hands-parent:${marker.featureSlug} -->`,
    "",
    MANAGED_START,
    "## Initiative",
    issue.summary,
    "",
    "## Tracking",
    "",
    `- Feature: \`${issue.featureSlug}\``,
    `- Plan revision: \`${issue.planRevision}\``,
    `- Run: \`${issue.runId}\``,
    "",
    "## Work items",
    "",
    ...(issue.workItems.length > 0
      ? issue.workItems.map((item) => `- [ ] #${item.issueNumber} \`${item.id}\``)
      : ["Work items are being synchronized."]),
    MANAGED_END,
    "",
  ].join("\n");
}

export function formatReviewComment(finding: PrReviewFinding): string {
  return [
    `**${finding.severity.toUpperCase()}** ${finding.file}:${finding.line}`,
    "",
    `Problem: ${finding.problem}`,
    "",
    `Required fix: ${finding.required_fix}`,
    "",
    `Verify after fix: ${finding.verification_after_fix}`,
  ].join("\n");
}

export function parseGhCreateResultNumber(output: string): number | null {
  const trimmed = output.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed === "object" && parsed !== null && "number" in parsed) {
      const value = (parsed as { number?: unknown }).number;
      if (typeof value === "number" && Number.isFinite(value)) {
        return value;
      }
      if (typeof value === "string" && /^\d+$/.test(value)) {
        return Number(value);
      }
    }
    if (Array.isArray(parsed) && parsed.length > 0) {
      const first = parsed[0];
      if (first && typeof first === "object" && "number" in first) {
        const value = (first as { number?: unknown }).number;
        if (typeof value === "number" && Number.isFinite(value)) {
          return value;
        }
        if (typeof value === "string" && /^\d+$/.test(value)) {
          return Number(value);
        }
      }
    }
  } catch {
    // Fall back to human-readable URL parsing when JSON mode is unavailable.
  }

  const match = trimmed.match(/\/issues\/(\d+)/) ?? trimmed.match(/\/pull\/(\d+)/);
  if (!match) {
    return null;
  }

  return Number(match[1]);
}

function parsePullRequestReference(value: unknown, source: string): GitHubPullRequestReference {
  if (!value || typeof value !== "object") throw new Error(`${source} response is invalid`);
  const input = value as {
    number?: unknown;
    url?: unknown;
    title?: unknown;
    headRefName?: unknown;
    headRefOid?: unknown;
    baseRefName?: unknown;
    state?: unknown;
    body?: unknown;
    closingIssuesReferences?: unknown;
  };
  if (!Number.isSafeInteger(input.number) || (input.number as number) < 1 || typeof input.url !== "string") {
    throw new Error(`${source} response is incomplete`);
  }
  if (!Array.isArray(input.closingIssuesReferences)) {
    throw new Error(`${source} response has no verified closing issue references`);
  }
  const closing = input.closingIssuesReferences.map((entry) => {
    const number = entry && typeof entry === "object" ? (entry as { number?: unknown }).number : undefined;
    if (!Number.isSafeInteger(number) || (number as number) < 1) throw new Error(`${source} has an invalid closing issue reference`);
    return number as number;
  });
  return {
    number: input.number as number,
    url: input.url,
    ...(typeof input.title === "string" ? { title: input.title } : {}),
    ...(typeof input.headRefName === "string" ? { head_ref: input.headRefName } : {}),
    ...(typeof input.headRefOid === "string" ? { head_sha: input.headRefOid.toLowerCase() } : {}),
    ...(typeof input.baseRefName === "string" ? { base_ref: input.baseRefName } : {}),
    ...(typeof input.body === "string" ? { body: input.body } : {}),
    closing_issue_numbers: closing,
    ...(input.state === "OPEN" || input.state === "CLOSED" || input.state === "MERGED" ? { state: input.state } : {}),
  };
}

function isAuthoritativeMissingPullRequest(result: CommandResult, pullRequestNumber: number): boolean {
  const exact = `GraphQL: Could not resolve to a PullRequest with the number of ${pullRequestNumber}. (repository.pullRequest)`;
  return result.stderr.trim() === exact;
}

const SAFE_OWNERSHIP_SEGMENT = /^[A-Za-z0-9._:-]{1,160}$/;
const PR_OWNERSHIP_TOKEN = /<!--\s*\/?brain-hands:issue-links\b[^>]*-->/g;
const PR_OWNERSHIP_START = /^<!-- brain-hands:issue-links lineage=([A-Za-z0-9._:-]{1,160}) run=([A-Za-z0-9._:-]{1,160}) schema=1 -->$/;
const PR_OWNERSHIP_END = "<!-- /brain-hands:issue-links -->";

function parseSlurpedPages(output: string, source: string): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch (error) {
    throw new Error(`Failed to parse ${source}`, { cause: error });
  }
  if (!Array.isArray(parsed) || parsed.some((page) => !Array.isArray(page))) {
    throw new Error(`${source} response is invalid`);
  }
  return parsed.flat();
}

function literalCount(value: string, literal: string): number {
  return value.split(literal).length - 1;
}

function matchesIssueOwnership(
  body: string,
  marker: GitHubIssueMarkerInput | GitHubParentIssueMarkerInput,
  target: { kind: "work_item"; value: string } | { kind: "parent"; value: string },
): boolean {
  if (!SAFE_OWNERSHIP_SEGMENT.test(marker.runId)
    || !SAFE_OWNERSHIP_SEGMENT.test(target.value)
    || (marker.lineageId !== undefined && !SAFE_OWNERSHIP_SEGMENT.test(marker.lineageId))) {
    throw new Error("Invalid GitHub ownership marker");
  }
  const lineageMarker = marker.lineageId === undefined
    ? null
    : `<!-- brain-hands-lineage:${marker.lineageId} -->`;
  const runMarker = `<!-- brain-hands-run:${marker.runId} -->`;
  const targetMarker = target.kind === "work_item"
    ? `<!-- brain-hands-work-item:${target.value} -->`
    : `<!-- brain-hands-parent:${target.value} -->`;
  const expected = [...(lineageMarker ? [lineageMarker] : []), runMarker, targetMarker];
  const hasEveryMarker = expected.every((value) => body.includes(value));
  const isPotentialMatch = lineageMarker
    ? body.includes(lineageMarker) && body.includes(targetMarker)
    : body.includes(runMarker) && body.includes(targetMarker);
  if (!hasEveryMarker) {
    if (isPotentialMatch) throw new Error("GitHub issue has malformed or mixed ownership markers");
    return false;
  }
  const exactHeader = `${expected.join("\n")}\n`;
  const oppositeMarker = target.kind === "work_item" ? "brain-hands-parent:" : "brain-hands-work-item:";
  if (lineageMarker === null && body.startsWith("<!-- brain-hands-lineage:")) {
    const lineageHeader = body.match(/^<!-- brain-hands-lineage:([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}) -->\n/i)?.[0];
    const validLineageOwnedTarget = lineageHeader !== undefined
      && body.startsWith(`${lineageHeader}${runMarker}\n${targetMarker}\n`)
      && [...body.matchAll(/<!-- brain-hands-lineage:[^>]*-->/g)].length === 1
      && literalCount(body, runMarker) === 1
      && literalCount(body, targetMarker) === 1
      && !body.includes(oppositeMarker);
    if (validLineageOwnedTarget) return true;
    throw new Error("GitHub issue has duplicate, malformed, or mixed ownership markers");
  }
  const valid = body.startsWith(exactHeader)
    && expected.every((value) => literalCount(body, value) === 1)
    && !body.includes(oppositeMarker)
    && [...body.matchAll(/<!-- brain-hands-lineage:[^>]*-->/g)].length === (lineageMarker ? 1 : 0)
    && [...body.matchAll(/<!-- brain-hands-run:[^>]*-->/g)].length === 1
    && [...body.matchAll(/<!-- brain-hands-(?:work-item|parent):[^>]*-->/g)].length === 1;
  if (!valid) throw new Error("GitHub issue has duplicate, malformed, or mixed ownership markers");
  return true;
}

function parseIssueObservation(value: unknown, source: string): GitHubIssueObservation {
  if (!value || typeof value !== "object") throw new Error(`${source} is invalid`);
  const input = value as {
    number?: unknown;
    title?: unknown;
    body?: unknown;
    state?: unknown;
    state_reason?: unknown;
    labels?: unknown;
  };
  if (!Number.isSafeInteger(input.number) || (input.number as number) < 1
    || typeof input.title !== "string" || typeof input.body !== "string") {
    throw new Error(`${source} owned material is incomplete`);
  }
  const state = input.state === "open" || input.state === "OPEN"
    ? "OPEN"
    : input.state === "closed" || input.state === "CLOSED"
      ? "CLOSED"
      : null;
  const stateReason = input.state_reason === null || input.state_reason === undefined
    ? null
    : input.state_reason === "completed" || input.state_reason === "COMPLETED"
      ? "COMPLETED"
      : input.state_reason === "not_planned" || input.state_reason === "NOT_PLANNED"
        ? "NOT_PLANNED"
        : undefined;
  if (state === null || stateReason === undefined || !Array.isArray(input.labels)) {
    throw new Error(`${source} owned state is invalid`);
  }
  const labels = input.labels.map((label) => {
    const name = label && typeof label === "object" ? (label as { name?: unknown }).name : undefined;
    if (typeof name !== "string" || name.length === 0) throw new Error(`${source} has an invalid label`);
    return name;
  }).sort();
  return {
    number: input.number as number,
    title: input.title,
    body: input.body,
    state,
    state_reason: stateReason,
    labels,
  };
}

function matchesPullRequestLineage(body: string, lineageId: string): boolean {
  if (!SAFE_OWNERSHIP_SEGMENT.test(lineageId)) throw new Error("Invalid GitHub lineage marker");
  if (!body.includes("brain-hands:issue-links")) return false;
  const tokens = [...body.matchAll(PR_OWNERSHIP_TOKEN)];
  const start = tokens[0];
  const end = tokens[1];
  const parsedStart = start?.[0].match(PR_OWNERSHIP_START);
  if (tokens.length !== 2
    || literalCount(body, "brain-hands:issue-links") !== 2
    || !parsedStart
    || end?.[0] !== PR_OWNERSHIP_END
    || start.index === undefined || end.index === undefined || start.index >= end.index) {
    throw new Error("Pull request has malformed, duplicate, or mixed lineage ownership markers");
  }
  return parsedStart[1] === lineageId;
}

function parseObservedPullRequest(value: unknown, source: string): GitHubPullRequestReference {
  if (!value || typeof value !== "object") throw new Error(`${source} is invalid`);
  const input = value as {
    number?: unknown;
    html_url?: unknown;
    title?: unknown;
    body?: unknown;
    state?: unknown;
    merged_at?: unknown;
    head?: { ref?: unknown; sha?: unknown };
    base?: { ref?: unknown };
  };
  if (!Number.isSafeInteger(input.number) || (input.number as number) < 1
    || typeof input.html_url !== "string" || typeof input.title !== "string" || typeof input.body !== "string"
    || (input.state !== "open" && input.state !== "closed")
    || (input.merged_at !== null && typeof input.merged_at !== "string")
    || typeof input.head?.ref !== "string" || typeof input.head.sha !== "string"
    || typeof input.base?.ref !== "string") {
    throw new Error(`${source} owned material is incomplete`);
  }
  return {
    number: input.number as number,
    url: input.html_url,
    title: input.title,
    head_ref: input.head.ref,
    head_sha: input.head.sha.toLowerCase(),
    base_ref: input.base.ref,
    body: input.body,
    closing_issue_numbers: [...input.body.matchAll(/^Closes #(\d+)$/gm)].map((match) => Number(match[1])),
    state: input.merged_at !== null ? "MERGED" : input.state === "open" ? "OPEN" : "CLOSED",
  };
}

export interface DryRunGitHubState {
  issues?: readonly GitHubIssueObservation[];
  pullRequests?: readonly GitHubPullRequestReference[];
}

export class DryRunGitHubAdapter implements GitHubAdapter {
  private issueCounter = 0;
  private prCounter = 0;
  private commentCounter = 0;
  private readonly comments = new Map<number, { target: GitHubCommentTarget; body: string }>();
  private readonly pullRequests = new Map<number, GitHubPullRequestReference>();
  private readonly issueStates = new Map<number, GitHubIssueStateReference>();

  constructor(state: DryRunGitHubState = {}) {
    for (const issue of state.issues ?? []) {
      if (!Number.isSafeInteger(issue.number) || issue.number < 1 || this.issueStates.has(issue.number)) {
        throw new Error("Dry-run GitHub issue state has an invalid or duplicate number");
      }
      this.issueCounter = Math.max(this.issueCounter, issue.number);
      this.issueStates.set(issue.number, { ...issue, labels: [...issue.labels] });
    }
    for (const pullRequest of state.pullRequests ?? []) {
      if (!Number.isSafeInteger(pullRequest.number) || pullRequest.number < 1 || this.pullRequests.has(pullRequest.number)) {
        throw new Error("Dry-run GitHub pull-request state has an invalid or duplicate number");
      }
      this.prCounter = Math.max(this.prCounter, pullRequest.number);
      this.pullRequests.set(pullRequest.number, {
        ...pullRequest,
        ...(pullRequest.closing_issue_numbers ? { closing_issue_numbers: [...pullRequest.closing_issue_numbers] } : {}),
      });
    }
  }

  async getRepositoryIdentity(): Promise<GitHubRepositoryIdentity> {
    return { host: "github.com", name_with_owner: "dry-run/repo", actor: "brain-hands-dry-run" };
  }

  async findIssuesByMarker(marker: GitHubIssueMarkerInput): Promise<GitHubIssueObservation[]> {
    return [...this.issueStates.values()]
      .filter((issue) => matchesIssueOwnership(issue.body, marker, { kind: "work_item", value: marker.workItemId }))
      .map((issue) => {
        if (!Array.isArray(issue.labels)) throw new Error(`Dry-run GitHub issue ${issue.number} labels are incomplete`);
        return { ...issue, labels: [...issue.labels].sort() };
      })
      .sort((left, right) => left.number - right.number);
  }

  async findParentIssuesByMarker(marker: GitHubParentIssueMarkerInput): Promise<GitHubIssueObservation[]> {
    return [...this.issueStates.values()]
      .filter((issue) => matchesIssueOwnership(issue.body, marker, { kind: "parent", value: marker.featureSlug }))
      .map((issue) => {
        if (!Array.isArray(issue.labels)) throw new Error(`Dry-run GitHub issue ${issue.number} labels are incomplete`);
        return { ...issue, labels: [...issue.labels].sort() };
      })
      .sort((left, right) => left.number - right.number);
  }

  async createIssue(issue: GitHubIssueSpec, marker?: GitHubIssueMarkerInput, title?: string): Promise<number> {
    this.issueCounter += 1;
    this.issueStates.set(this.issueCounter, {
      number: this.issueCounter,
      title: title ?? issueTitle(issue),
      body: formatIssueBody(issue, marker),
      state: "OPEN",
      state_reason: null,
      labels: ISSUE_LABELS.split(","),
    });
    return this.issueCounter;
  }

  async updateIssue(issueNumber: number, issue: GitHubIssueSpec, marker?: GitHubIssueMarkerInput, _currentBody?: string, title?: string): Promise<void> {
    const current = this.issueStates.get(issueNumber);
    if (!current) return;
    this.issueStates.set(issueNumber, { ...current, title: title ?? issueTitle(issue), body: formatIssueBody(issue, marker) });
  }

  async addIssueLabels(issueNumber: number, labels: string[]): Promise<void> {
    await this.updateIssueLabels(issueNumber, { add: labels, remove: [] });
  }

  async openPullRequest(_input: OpenPullRequestInput): Promise<number> {
    this.prCounter += 1;
    return this.prCounter;
  }

  async commentOnPullRequest(_prNumber: number, _body: string): Promise<void> {}

  async findIssueByMarker(marker: GitHubIssueMarkerInput): Promise<number | null> {
    const matches = await this.findIssuesByMarker(marker);
    return matches.length === 1 ? matches[0]!.number : null;
  }

  async createParentIssue(issue: ParentIssueSpec, marker: GitHubParentIssueMarkerInput): Promise<number> {
    this.issueCounter += 1;
    this.issueStates.set(this.issueCounter, {
      number: this.issueCounter,
      title: issue.title,
      body: formatParentIssueBody(issue, marker),
      state: "OPEN",
      state_reason: null,
      labels: PARENT_ISSUE_LABELS.split(","),
    });
    return this.issueCounter;
  }

  async findParentIssueByMarker(marker: GitHubParentIssueMarkerInput): Promise<number | null> {
    const matches = await this.findParentIssuesByMarker(marker);
    return matches.length === 1 ? matches[0]!.number : null;
  }

  async updateParentIssue(issueNumber: number, issue: ParentIssueSpec, marker: GitHubParentIssueMarkerInput): Promise<void> {
    const current = this.issueStates.get(issueNumber);
    if (!current) return;
    this.issueStates.set(issueNumber, { ...current, title: issue.title, body: formatParentIssueBody(issue, marker) });
  }

  async openIntegratedPullRequest(input: OpenIntegratedPullRequestInputCompat): Promise<GitHubPullRequestReference> {
    this.prCounter += 1;
    const issueNumbers = expectedClosingIssueNumbers(input);
    const body = input.lineageId
      ? reconcileClosingLinksBlock(input.summary, input.lineageId, input.runId, issueNumbers)
      : reconcileClosingLinksBlock(input.summary, input.runId, issueNumbers);
    const reference: GitHubPullRequestReference = {
      number: this.prCounter,
      url: `https://github.com/dry-run/repo/pull/${this.prCounter}`,
      title: input.title,
      head_ref: input.head,
      ...(input.headSha ? { head_sha: input.headSha } : {}),
      base_ref: input.base,
      body,
      closing_issue_numbers: issueNumbers,
      state: "OPEN",
    };
    this.pullRequests.set(reference.number, reference);
    return reference;
  }

  async findPullRequestByHead(head: string): Promise<GitHubPullRequestReference | null> {
    const matches = [...this.pullRequests.values()].filter((pullRequest) => pullRequest.head_ref === head);
    if (matches.length !== 1) return null;
    return { ...matches[0]!, closing_issue_numbers: [...(matches[0]!.closing_issue_numbers ?? [])] };
  }

  async findPullRequestsByLineage(lineageId: string): Promise<GitHubPullRequestReference[]> {
    return [...this.pullRequests.values()]
      .filter((pullRequest) => matchesPullRequestLineage(pullRequest.body ?? "", lineageId))
      .sort((left, right) => left.number - right.number)
      .map((pullRequest) => ({ ...pullRequest, closing_issue_numbers: [...(pullRequest.closing_issue_numbers ?? [])] }));
  }

  async getDefaultBranch(): Promise<string> { return "main"; }

  async getPullRequest(pullRequestNumber: number): Promise<GitHubPullRequestReference | null> {
    const pullRequest = this.pullRequests.get(pullRequestNumber);
    if (!pullRequest) return null;
    return { ...pullRequest, closing_issue_numbers: [...(pullRequest.closing_issue_numbers ?? [])] };
  }

  async updatePullRequestBody(pullRequestNumber: number, body: string): Promise<void> {
    const pullRequest = await this.getPullRequest(pullRequestNumber);
    if (pullRequest === null) throw new Error(`Pull request ${pullRequestNumber} does not exist`);
    this.pullRequests.set(pullRequestNumber, {
      ...pullRequest,
      body,
      closing_issue_numbers: [...body.matchAll(/^Closes #(\d+)$/gm)].map((match) => Number(match[1])),
    });
  }

  async getIssue(issueNumber: number): Promise<GitHubIssueStateReference> {
    const issue = this.issueStates.get(issueNumber);
    if (!issue) throw new Error(`Issue ${issueNumber} does not exist`);
    return { ...issue, ...(issue.labels ? { labels: [...issue.labels] } : {}) };
  }

  async closeIssue(issueNumber: number, reason: GitHubIssueClosureReason): Promise<void> {
    const issue = await this.getIssue(issueNumber);
    this.issueStates.set(issueNumber, {
      ...issue,
      state: "CLOSED",
      state_reason: reason === "completed" ? "COMPLETED" : "NOT_PLANNED",
    });
  }

  async updateIssueLabels(issueNumber: number, input: { add: string[]; remove: string[] }): Promise<void> {
    const issue = await this.getIssue(issueNumber);
    const removals = new Set(input.remove.map((label) => label.toLowerCase()));
    const labels = (issue.labels ?? []).filter((label) => !removals.has(label.toLowerCase()));
    const known = new Set(labels.map((label) => label.toLowerCase()));
    for (const label of input.add) {
      if (known.has(label.toLowerCase())) continue;
      labels.push(label);
      known.add(label.toLowerCase());
    }
    this.issueStates.set(issueNumber, { ...issue, labels });
  }

  async commentRunStatus(_target: { kind: "issue" | "pull_request"; number: number } | number, _body: string): Promise<void> {}

  async findStatusCommentByMarker(target: GitHubCommentTarget, marker: string): Promise<GitHubCommentReference | null> {
    const matches = [...this.comments.entries()].filter(([, comment]) =>
      comment.target.kind === target.kind && comment.target.number === target.number && comment.body.startsWith(`${marker}\n`));
    if (matches.length > 1) throw new StatusCommentOwnershipConflictError();
    const match = matches[0];
    return match ? { id: match[0], body: match[1].body, authorLogin: "brain-hands-dry-run" } : null;
  }

  async createStatusComment(target: GitHubCommentTarget, body: string): Promise<GitHubCommentReference> {
    this.commentCounter += 1;
    this.comments.set(this.commentCounter, { target, body });
    return { id: this.commentCounter, body, authorLogin: "brain-hands-dry-run" };
  }

  async updateStatusComment(commentId: number, body: string): Promise<void> {
    const previous = this.comments.get(commentId);
    if (!previous) throw new Error(`Status comment ${commentId} does not exist`);
    this.comments.set(commentId, { ...previous, body });
  }

  async reconcileIssueStateLabel(issueNumber: number, desired: BrainHandsStateLabel, options?: {
    withExternalEffect?: <T>(key: string, action: () => Promise<T>) => Promise<T>;
  }): Promise<void> {
    const current = await this.getIssue(issueNumber);
    if (!Array.isArray(current.labels)) throw new Error(`Issue ${issueNumber} labels are incomplete`);
    const { add, remove, desired: resolved } = managedStateLabelEdit({ ...current, labels: current.labels }, desired);
    const apply = () => this.updateIssueLabels(issueNumber, { add, remove });
    if (options?.withExternalEffect) await options.withExternalEffect("issue-labels", apply);
    else await apply();
    const observed = await this.getIssue(issueNumber);
    if (!Array.isArray(observed.labels) || !hasExactManagedStateLabel(observed.labels, resolved)) {
      throw new Error(`Failed to observe exact dry-run GitHub status labels for issue ${issueNumber}`);
    }
  }

  async upsertRunStatus(_target: { kind: "issue" | "pull_request"; number: number }, _marker: string, _body: string): Promise<void> {}
}

export class GhCliGitHubAdapter implements GitHubAdapter {
  private repositoryPromise?: Promise<{ host: string; nameWithOwner: string; actor: string }>;

  constructor(private readonly repoRoot: string) {}

  private async repository(): Promise<{ host: string; nameWithOwner: string; actor: string }> {
    this.repositoryPromise ??= (async () => {
      const repository = await runCommand({ command: "gh", args: ["repo", "view", "--json", "nameWithOwner,url"], cwd: this.repoRoot, timeoutMs: 60_000 });
      if (repository.exitCode !== 0) throw commandFailureError(repository, "Failed to resolve GitHub repository");
      let parsed: unknown;
      try { parsed = JSON.parse(repository.stdout); } catch (error) { throw new Error("Failed to parse GitHub repository response", { cause: error }); }
      const nameWithOwner = parsed && typeof parsed === "object" ? (parsed as { nameWithOwner?: unknown }).nameWithOwner : undefined;
      const url = parsed && typeof parsed === "object" ? (parsed as { url?: unknown }).url : undefined;
      if (typeof nameWithOwner !== "string" || typeof url !== "string") throw new Error("GitHub repository response is incomplete");
      const host = new URL(url).hostname;
      const actorResult = await runCommand({ command: "gh", args: ["api", "--hostname", host, "user", "--jq", ".login"], cwd: this.repoRoot, timeoutMs: 60_000 });
      if (actorResult.exitCode !== 0 || actorResult.stdout.trim() === "") throw commandFailureError(actorResult, "Failed to resolve authenticated GitHub actor");
      return { host, nameWithOwner, actor: actorResult.stdout.trim() };
    })();
    return this.repositoryPromise;
  }

  async getRepositoryIdentity(): Promise<GitHubRepositoryIdentity> {
    const repository = await this.repository();
    return {
      host: repository.host,
      name_with_owner: repository.nameWithOwner,
      actor: repository.actor,
    };
  }

  async createIssue(issue: GitHubIssueSpec, marker?: GitHubIssueMarkerInput, title?: string): Promise<number> {
    const result = await runCommand({
      command: "gh",
      args: [
        "issue",
        "create",
        "--title",
        title ?? issueTitle(issue),
        "--body",
        formatIssueBody(issue, marker),
        "--label",
        ISSUE_LABELS,
      ],
      cwd: this.repoRoot,
      timeoutMs: 60_000,
    });
    const number = parseGhCreateResultNumber(result.stdout);
    if (result.exitCode !== 0 || number === null) {
      throw commandFailureError(
        result,
        `Failed to create GitHub issue in ${this.repoRoot}`,
      );
    }
    return number;
  }

  async updateIssue(issueNumber: number, issue: GitHubIssueSpec, marker?: GitHubIssueMarkerInput, currentBody?: string, title?: string): Promise<void> {
    const desiredBody = formatIssueBody(issue, marker);
    const body = currentBody === undefined ? desiredBody : reconcileManagedIssueBody(currentBody, desiredBody);
    const result = await runCommand({
      command: "gh",
      args: ["issue", "edit", String(issueNumber), "--title", title ?? issueTitle(issue), "--body", body],
      cwd: this.repoRoot,
      timeoutMs: 60_000,
    });
    if (result.exitCode !== 0) {
      throw commandFailureError(
        result,
        `Failed to update issue ${issueNumber}`,
      );
    }
  }

  async addIssueLabels(issueNumber: number, labels: string[]): Promise<void> {
    const result = await runCommand({
      command: "gh",
      args: ["issue", "edit", String(issueNumber), "--add-label", labels.join(",")],
      cwd: this.repoRoot,
      timeoutMs: 60_000,
    });
    if (result.exitCode !== 0) {
      throw commandFailureError(
        result,
        `Failed to label issue ${issueNumber}`,
      );
    }
  }

  async openPullRequest(input: OpenPullRequestInput): Promise<number> {
    const result = await runCommand({
      command: "gh",
      args: [
        "pr",
        "create",
        "--title",
        input.title,
        "--body",
        input.body,
        "--head",
        input.head,
        "--base",
        input.base,
      ],
      cwd: this.repoRoot,
      timeoutMs: 60_000,
    });
    const number = parseGhCreateResultNumber(result.stdout);
    if (result.exitCode !== 0 || number === null) {
      throw commandFailureError(result, "Failed to open pull request");
    }
    return number;
  }

  async commentOnPullRequest(prNumber: number, body: string): Promise<void> {
    const result = await runCommand({
      command: "gh",
      args: ["pr", "comment", String(prNumber), "--body", body],
      cwd: this.repoRoot,
      timeoutMs: 60_000,
    });
    if (result.exitCode !== 0) {
      throw commandFailureError(
        result,
        `Failed to comment on PR ${prNumber}`,
      );
    }
  }

  private async findIssueObservations(
    marker: GitHubIssueMarkerInput | GitHubParentIssueMarkerInput,
    target: { kind: "work_item"; value: string } | { kind: "parent"; value: string },
  ): Promise<GitHubIssueObservation[]> {
    const repository = await this.repository();
    const result = await runCommand({
      command: "gh",
      args: [
        "api", "--hostname", repository.host, "--paginate", "--slurp",
        `repos/${repository.nameWithOwner}/issues?state=all&per_page=100`,
      ],
      cwd: this.repoRoot,
      timeoutMs: 60_000,
    });
    if (result.exitCode !== 0) {
      throw commandFailureError(result, "Failed to search GitHub issues");
    }
    const issues = parseSlurpedPages(result.stdout, "GitHub issue search response");
    return issues.flatMap((entry) => {
      if (!entry || typeof entry !== "object" || "pull_request" in entry) return [];
      const body = (entry as { body?: unknown }).body;
      if (typeof body !== "string" || !matchesIssueOwnership(body, marker, target)) return [];
      return [parseIssueObservation(entry, "GitHub issue")];
    }).sort((left, right) => left.number - right.number);
  }

  async findIssuesByMarker(marker: GitHubIssueMarkerInput): Promise<GitHubIssueObservation[]> {
    return this.findIssueObservations(marker, { kind: "work_item", value: marker.workItemId });
  }

  async findIssueByMarker(marker: GitHubIssueMarkerInput): Promise<GitHubIssueReference | null> {
    const matches = "lineageId" in marker && marker.lineageId !== undefined
      ? await this.findIssuesByMarker(marker)
      : await this.findIssueObservations(marker, { kind: "work_item", value: marker.workItemId });
    if (matches.length > 1) throw new Error("Multiple GitHub issues match the ownership marker; lookup is ambiguous");
    const match = matches[0];
    return match ? { number: match.number, title: match.title, body: match.body } : null;
  }

  async createParentIssue(issue: ParentIssueSpec, marker: GitHubParentIssueMarkerInput): Promise<number> {
    const result = await runCommand({
      command: "gh",
      args: ["issue", "create", "--title", issue.title, "--body", formatParentIssueBody(issue, marker), "--label", PARENT_ISSUE_LABELS],
      cwd: this.repoRoot,
      timeoutMs: 60_000,
    });
    const number = parseGhCreateResultNumber(result.stdout);
    if (result.exitCode !== 0 || number === null) throw commandFailureError(result, "Failed to create GitHub parent issue");
    return number;
  }

  async findParentIssuesByMarker(marker: GitHubParentIssueMarkerInput): Promise<GitHubIssueObservation[]> {
    return this.findIssueObservations(marker, { kind: "parent", value: marker.featureSlug });
  }

  async findParentIssueByMarker(marker: GitHubParentIssueMarkerInput): Promise<GitHubIssueReference | null> {
    const matches = "lineageId" in marker && marker.lineageId !== undefined
      ? await this.findParentIssuesByMarker(marker)
      : await this.findIssueObservations(marker, { kind: "parent", value: marker.featureSlug });
    if (matches.length > 1) throw new Error("Multiple GitHub parent issues match the ownership marker; lookup is ambiguous");
    const match = matches[0];
    return match ? { number: match.number, title: match.title, body: match.body } : null;
  }

  async updateParentIssue(issueNumber: number, issue: ParentIssueSpec, marker: GitHubParentIssueMarkerInput, currentBody?: string): Promise<void> {
    const desiredBody = formatParentIssueBody(issue, marker);
    const body = currentBody === undefined ? desiredBody : reconcileManagedIssueBody(currentBody, desiredBody);
    const result = await runCommand({
      command: "gh",
      args: ["issue", "edit", String(issueNumber), "--title", issue.title, "--body", body],
      cwd: this.repoRoot,
      timeoutMs: 60_000,
    });
    if (result.exitCode !== 0) throw commandFailureError(result, `Failed to update parent issue ${issueNumber}`);
  }

  async openIntegratedPullRequest(input: OpenIntegratedPullRequestInputCompat): Promise<GitHubPullRequestReference> {
    const issueNumbers = expectedClosingIssueNumbers(input);
    const body = input.lineageId
      ? reconcileClosingLinksBlock(input.summary, input.lineageId, input.runId, issueNumbers)
      : reconcileClosingLinksBlock(input.summary, input.runId, issueNumbers);
    const result = await runCommand({
      command: "gh",
      args: ["pr", "create", "--title", input.title, "--body", body, "--head", input.head, "--base", input.base],
      cwd: this.repoRoot,
      timeoutMs: 60_000,
    });
    const number = parseGhCreateResultNumber(result.stdout);
    if (result.exitCode !== 0 || number === null) {
      throw commandFailureError(result, "Failed to open integrated pull request");
    }
    const url = result.stdout.trim().match(/https?:\/\/[^\s]+\/pull\/\d+/)?.[0] ?? `#${number}`;
    return { number, url };
  }

  async getDefaultBranch(): Promise<string> {
    const result = await runCommand({
      command: "gh",
      args: ["repo", "view", "--json", "defaultBranchRef"],
      cwd: this.repoRoot,
      timeoutMs: 60_000,
    });
    if (result.exitCode !== 0) throw commandFailureError(result, "Failed to resolve GitHub default branch");
    let parsed: unknown;
    try { parsed = JSON.parse(result.stdout); } catch (error) { throw new Error("Failed to parse GitHub default branch response", { cause: error }); }
    const branch = parsed && typeof parsed === "object"
      ? (parsed as { defaultBranchRef?: { name?: unknown } }).defaultBranchRef?.name
      : undefined;
    if (typeof branch !== "string" || branch.trim() === "") throw new Error("GitHub default branch response is incomplete");
    return branch;
  }

  async getPullRequest(pullRequestNumber: number): Promise<GitHubPullRequestReference | null> {
    if (!Number.isSafeInteger(pullRequestNumber) || pullRequestNumber < 1) throw new Error("Invalid pull request number");
    const result = await runCommand({
      command: "gh",
      args: ["pr", "view", String(pullRequestNumber), "--json", "number,url,title,headRefName,headRefOid,baseRefName,state,body,closingIssuesReferences"],
      cwd: this.repoRoot,
      timeoutMs: 60_000,
    });
    if (result.exitCode !== 0) {
      if (isAuthoritativeMissingPullRequest(result, pullRequestNumber)) return null;
      throw commandFailureError(result, `Failed to read pull request ${pullRequestNumber}`);
    }
    let parsed: unknown;
    try { parsed = JSON.parse(result.stdout); } catch (error) { throw new Error("Failed to parse pull request response", { cause: error }); }
    return parsePullRequestReference(parsed, `Pull request ${pullRequestNumber}`);
  }

  async updatePullRequestBody(pullRequestNumber: number, body: string): Promise<void> {
    if (!Number.isSafeInteger(pullRequestNumber) || pullRequestNumber < 1) throw new Error("Invalid pull request number");
    const result = await runCommand({
      command: "gh",
      args: ["pr", "edit", String(pullRequestNumber), "--body", body],
      cwd: this.repoRoot,
      timeoutMs: 60_000,
    });
    if (result.exitCode !== 0) throw commandFailureError(result, `Failed to update pull request ${pullRequestNumber}`);
  }

  async getIssue(issueNumber: number): Promise<GitHubIssueStateReference> {
    if (!Number.isSafeInteger(issueNumber) || issueNumber < 1) throw new Error("Invalid issue number");
    const repository = await this.repository();
    const repo = `${repository.host}/${repository.nameWithOwner}`;
    const result = await runCommand({
      command: "gh",
      args: ["issue", "view", String(issueNumber), "--repo", repo, "--json", "number,title,body,state,stateReason,labels"],
      cwd: this.repoRoot,
      timeoutMs: 60_000,
    });
    if (result.exitCode !== 0) throw commandFailureError(result, `Failed to read issue ${issueNumber}`);
    let parsed: unknown;
    try { parsed = JSON.parse(result.stdout); } catch (error) { throw new Error("Failed to parse issue response", { cause: error }); }
    if (!parsed || typeof parsed !== "object") throw new Error(`Issue ${issueNumber} response is invalid`);
    const issue = parsed as { number?: unknown; title?: unknown; body?: unknown; state?: unknown; stateReason?: unknown; labels?: unknown };
    if (issue.number !== issueNumber || typeof issue.title !== "string" || typeof issue.body !== "string" || (issue.state !== "OPEN" && issue.state !== "CLOSED")) {
      throw new Error(`Issue ${issueNumber} response is incomplete`);
    }
    const stateReason = issue.stateReason === "COMPLETED" || issue.stateReason === "NOT_PLANNED" ? issue.stateReason : null;
    if (!Array.isArray(issue.labels) || !issue.labels.every((label) => label && typeof label === "object" && typeof (label as { name?: unknown }).name === "string")) {
      throw new Error(`Issue ${issueNumber} labels are incomplete`);
    }
    return {
      number: issueNumber,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      state_reason: stateReason,
      labels: issue.labels.map((label) => (label as { name: string }).name).sort(),
    };
  }

  async closeIssue(issueNumber: number, reason: GitHubIssueClosureReason): Promise<void> {
    if (!Number.isSafeInteger(issueNumber) || issueNumber < 1) throw new Error("Invalid issue number");
    const result = await runCommand({
      command: "gh",
      args: ["issue", "close", String(issueNumber), "--reason", reason === "not_planned" ? "not planned" : "completed"],
      cwd: this.repoRoot,
      timeoutMs: 60_000,
    });
    if (result.exitCode !== 0) throw commandFailureError(result, `Failed to close issue ${issueNumber}`);
  }

  async updateIssueLabels(issueNumber: number, input: { add: string[]; remove: string[] }): Promise<void> {
    if (!Number.isSafeInteger(issueNumber) || issueNumber < 1) throw new Error("Invalid issue number");
    if (input.add.length === 0 && input.remove.length === 0) return;
    const repository = await this.repository();
    const repo = `${repository.host}/${repository.nameWithOwner}`;
    const result = await runCommand({
      command: "gh",
      args: [
        "issue", "edit", String(issueNumber), "--repo", repo,
        ...input.remove.flatMap((label) => ["--remove-label", label]),
        ...input.add.flatMap((label) => ["--add-label", label]),
      ],
      cwd: this.repoRoot,
      timeoutMs: 60_000,
    });
    if (result.exitCode !== 0) throw commandFailureError(result, `Failed to reconcile issue ${issueNumber} labels`);
  }

  async findPullRequestByHead(head: string): Promise<GitHubPullRequestReference | null> {
    const result = await runCommand({
      command: "gh",
      args: ["pr", "list", "--state", "open", "--head", head, "--json", "number,url,title,headRefName,headRefOid,baseRefName,state,body,closingIssuesReferences", "--limit", "20"],
      cwd: this.repoRoot,
      timeoutMs: 60_000,
    });
    if (result.exitCode !== 0) {
      throw commandFailureError(result, `Failed to search pull requests for ${head}`);
    }
    let prs: unknown;
    try {
      prs = JSON.parse(result.stdout);
    } catch (error) {
      throw new Error("Failed to parse pull request search response", { cause: error });
    }
    if (!Array.isArray(prs)) return null;
    const first = prs[0];
    if (!first || typeof first !== "object") return null;
    return parsePullRequestReference(first, `Pull request for ${head}`);
  }

  async findPullRequestsByLineage(lineageId: string): Promise<GitHubPullRequestReference[]> {
    const repository = await this.repository();
    const result = await runCommand({
      command: "gh",
      args: [
        "api", "--hostname", repository.host, "--paginate", "--slurp",
        `repos/${repository.nameWithOwner}/pulls?state=all&per_page=100`,
      ],
      cwd: this.repoRoot,
      timeoutMs: 60_000,
    });
    if (result.exitCode !== 0) throw commandFailureError(result, "Failed to search GitHub pull requests by lineage");
    const pullRequests = parseSlurpedPages(result.stdout, "GitHub pull request search response");
    return pullRequests.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const body = (entry as { body?: unknown }).body;
      if (typeof body !== "string" || !matchesPullRequestLineage(body, lineageId)) return [];
      return [parseObservedPullRequest(entry, "GitHub pull request")];
    }).sort((left, right) => left.number - right.number);
  }

  async commentRunStatus(target: { kind: "issue" | "pull_request"; number: number } | number, body: string): Promise<void> {
    const normalized = typeof target === "number" ? { kind: "pull_request" as const, number: target } : target;
    const command = normalized.kind === "issue" ? "issue" : "pr";
    const result = await runCommand({
      command: "gh",
      args: [command, "comment", String(normalized.number), "--body", body],
      cwd: this.repoRoot,
      timeoutMs: 60_000,
    });
    if (result.exitCode !== 0) {
      throw commandFailureError(result, `Failed to comment run status on ${command} ${normalized.number}`);
    }
  }

  async findStatusCommentByMarker(target: GitHubCommentTarget, marker: string): Promise<GitHubCommentReference | null> {
    const repository = await this.repository();
    const result = await runCommand({
      command: "gh",
      args: ["api", "--hostname", repository.host, "--paginate", "--slurp", `repos/${repository.nameWithOwner}/issues/${target.number}/comments`],
      cwd: this.repoRoot,
      timeoutMs: 60_000,
    });
    if (result.exitCode !== 0) throw commandFailureError(result, "Failed to list GitHub status comments");
    let parsed: unknown;
    try { parsed = JSON.parse(result.stdout); } catch (error) { throw new Error("Failed to parse GitHub status comments", { cause: error }); }
    const comments = (Array.isArray(parsed) ? parsed.flat() : []).flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const id = (entry as { id?: unknown }).id;
      const body = (entry as { body?: unknown }).body;
      const authorLogin = (entry as { user?: { login?: unknown } }).user?.login;
      return typeof id === "number" && Number.isInteger(id) && id > 0 && typeof body === "string" && typeof authorLogin === "string"
        ? [{ id, body, authorLogin }]
        : [];
    });
    const marked = comments.filter((comment) => comment.body === marker || comment.body.startsWith(`${marker}\n`));
    if (marked.length === 0) return null;
    const managed = marked.filter((comment) => comment.body.startsWith(`${marker}\n`));
    if (marked.length !== 1 || managed.length !== 1 || managed[0]!.authorLogin !== repository.actor) throw new StatusCommentOwnershipConflictError();
    return managed[0]!;
  }

  async createStatusComment(target: GitHubCommentTarget, body: string): Promise<GitHubCommentReference> {
    const repository = await this.repository();
    const result = await runCommand({
      command: "gh",
      args: ["api", "--hostname", repository.host, "--method", "POST", `repos/${repository.nameWithOwner}/issues/${target.number}/comments`, "-f", `body=${body}`],
      cwd: this.repoRoot,
      timeoutMs: 60_000,
    });
    if (result.exitCode !== 0) throw commandFailureError(result, "Failed to create GitHub status comment");
    let parsed: unknown;
    try { parsed = JSON.parse(result.stdout); } catch (error) { throw new Error("Failed to parse created GitHub status comment", { cause: error }); }
    const id = parsed && typeof parsed === "object" ? (parsed as { id?: unknown }).id : undefined;
    if (typeof id !== "number" || !Number.isInteger(id) || id < 1) throw new Error("Created GitHub status comment has invalid ID");
    return { id, body, authorLogin: repository.actor };
  }

  async updateStatusComment(commentId: number, body: string): Promise<void> {
    if (!Number.isInteger(commentId) || commentId < 1) throw new Error("Invalid GitHub status comment ID");
    const repository = await this.repository();
    const result = await runCommand({
      command: "gh",
      args: ["api", "--hostname", repository.host, "--method", "PATCH", `repos/${repository.nameWithOwner}/issues/comments/${commentId}`, "-f", `body=${body}`],
      cwd: this.repoRoot,
      timeoutMs: 60_000,
    });
    if (result.exitCode !== 0) throw commandFailureError(result, "Failed to update GitHub status comment");
  }

  async reconcileIssueStateLabel(issueNumber: number, desired: BrainHandsStateLabel, options?: {
    withExternalEffect?: <T>(key: string, action: () => Promise<T>) => Promise<T>;
  }): Promise<void> {
    const repository = await this.repository();
    const repo = `${repository.host}/${repository.nameWithOwner}`;
    const current = await this.getIssue(issueNumber);
    if (!Array.isArray(current.labels)) throw new Error(`Issue ${issueNumber} labels are incomplete`);
    const available = await runCommand({ command: "gh", args: ["label", "list", "--repo", repo, "--limit", "1000", "--json", "name"], cwd: this.repoRoot, timeoutMs: 60_000 });
    if (available.exitCode !== 0) throw commandFailureError(available, "Failed to read GitHub labels");
    let parsed: unknown;
    try { parsed = JSON.parse(available.stdout); } catch (error) { throw new Error("Failed to parse GitHub label list", { cause: error }); }
    if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "object" && entry !== null && typeof (entry as { name?: unknown }).name === "string")) {
      throw new Error("GitHub label list is incomplete");
    }
    const known = parsed.map((entry) => (entry as { name: string }).name);
    assertNoCaseInsensitiveLabelCollisions(known);
    const edit = managedStateLabelEdit({ ...current, labels: current.labels }, desired);
    if (!known.some((label) => label.toLowerCase() === edit.desired.toLowerCase())) {
      throw new Error(`Required GitHub status label '${edit.desired}' is not provisioned`);
    }
    if (edit.add.length === 0 && edit.remove.length === 0) return;

    let mutationError: unknown = null;
    try {
      const update = () => this.updateIssueLabels(issueNumber, edit);
      if (options?.withExternalEffect) await options.withExternalEffect("issue-labels", update);
      else await update();
    } catch (error) {
      mutationError = error;
    }
    let observed: GitHubIssueStateReference;
    try {
      observed = await this.getIssue(issueNumber);
    } catch (error) {
      throw mutationError ?? error;
    }
    if (!Array.isArray(observed.labels)) throw mutationError ?? new Error(`Issue ${issueNumber} labels are incomplete after reconciliation`);
    const observedDesired = managedStateLabelEdit({ ...observed, labels: observed.labels }, desired).desired;
    if (!hasExactManagedStateLabel(observed.labels, observedDesired)) {
      throw mutationError ?? new Error(`Failed to observe exact GitHub status labels for issue ${issueNumber}`);
    }
  }

  async upsertRunStatus(target: { kind: "issue" | "pull_request"; number: number }, marker: string, body: string): Promise<void> {
    if (!/^<!-- brain-hands-[a-z-]+:[^\r\n]+ -->$/.test(marker)) {
      throw new Error("GitHub run-status marker is invalid");
    }
    if (!body.startsWith(`${marker}\n`) || body.indexOf(marker, marker.length) !== -1) {
      throw new Error("GitHub run-status body must contain its marker exactly once at the start");
    }
    const comments = await runCommand({
      command: "gh",
      args: ["api", "repos/{owner}/{repo}/issues/" + String(target.number) + "/comments", "--paginate", "--slurp"],
      cwd: this.repoRoot,
      timeoutMs: 60_000,
    });
    if (comments.exitCode !== 0) throw commandFailureError(comments, "Failed to list GitHub run-status comments");
    let parsed: unknown;
    try {
      parsed = JSON.parse(comments.stdout) as unknown;
    } catch (error) {
      throw new Error("Failed to parse GitHub run-status comments", { cause: error });
    }
    const entries = Array.isArray(parsed) && parsed.every(Array.isArray)
      ? parsed.flat()
      : parsed;
    const matches = Array.isArray(entries)
      ? entries.filter((entry): entry is { id: number; body: string } => typeof entry === "object" && entry !== null && typeof (entry as { id?: unknown }).id === "number" && typeof (entry as { body?: unknown }).body === "string" && ((entry as { body: string }).body === marker || (entry as { body: string }).body.startsWith(`${marker}\n`)))
      : [];
    const byId = new Map<number, { id: number; body: string }>();
    for (const match of matches) {
      const existing = byId.get(match.id);
      if (existing && existing.body !== match.body) {
        throw new Error(`GitHub returned conflicting bodies for run-status comment ${match.id}`);
      }
      byId.set(match.id, match);
    }
    const managed = [...byId.values()].sort((left, right) => left.id - right.id);
    if (managed.length > 0) {
      const canonical = managed[0]!;
      if (canonical.body !== body) {
        const result = await runCommand({ command: "gh", args: ["api", "--method", "PATCH", "repos/{owner}/{repo}/issues/comments/" + String(canonical.id), "-f", `body=${body}`], cwd: this.repoRoot, timeoutMs: 60_000 });
        if (result.exitCode !== 0) throw commandFailureError(result, "Failed to update GitHub run-status comment");
      }
      for (const duplicate of managed.slice(1)) {
        const result = await runCommand({ command: "gh", args: ["api", "--method", "DELETE", "repos/{owner}/{repo}/issues/comments/" + String(duplicate.id)], cwd: this.repoRoot, timeoutMs: 60_000 });
        if (result.exitCode !== 0) throw commandFailureError(result, "Failed to remove duplicate GitHub run-status comment");
      }
      return;
    }
    const result = await runCommand({ command: "gh", args: ["api", "--method", "POST", "repos/{owner}/{repo}/issues/" + String(target.number) + "/comments", "-f", `body=${body}`], cwd: this.repoRoot, timeoutMs: 60_000 });
    if (result.exitCode !== 0) throw commandFailureError(result, "Failed to create GitHub run-status comment");
  }
}
