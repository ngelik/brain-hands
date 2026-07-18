import { createHash } from "node:crypto";
import type { BrainHandsStateLabel } from "../core/github-labels.js";
export type BrainHandsIssueState =
  | "ready"
  | "implementing"
  | "verifying"
  | "reviewing"
  | "fixing"
  | "blocked"
  | "complete";

export interface StatusCheck {
  index: number;
  rawCommand: string;
  status: "pending" | "passed" | "failed" | "timed_out";
}

export interface StatusFinding {
  severity: "low" | "medium" | "high" | "critical";
  publicLocation?: string;
  summary: string;
}

export interface MaterialEventSnapshot {
  kind: "verification_blocked" | "replan_required" | "reviewer_findings" | "operational_blocker";
  attempt: number;
  blockerClass?: "hands_invalid" | "verification_invalid" | "verifier_invalid" | "attempts_exhausted";
}

export interface WorkItemStatusSnapshot {
  runId: string;
  workItemId: string;
  workItemIndex: number;
  workItemTotal: number;
  /** Accepted for runtime compatibility but intentionally never rendered. */
  branchName: string;
  state: BrainHandsIssueState;
  attempt: number;
  maxAttempts: number;
  transitionAt: string;
  planApproved: boolean;
  implementationRecorded: boolean;
  verification: {
    status: "pending" | "running" | "passed" | "failed";
    checks: StatusCheck[];
    browser: "not_required" | "pending" | "passed" | "failed";
    artifacts: { required: number; present: number };
    browserChecks: { required: number; completed: number };
  };
  verifier: {
    status: "pending" | "running" | "approved" | "request_changes" | "replan_required";
    findings: StatusFinding[];
  };
  materialEvents: MaterialEventSnapshot[];
}

export interface DesiredMaterialEvent {
  key: string;
  marker: string;
  body: string;
}

export interface DesiredStatusProjection {
  marker: string;
  body: string;
  label: BrainHandsStateLabel;
  hash: string;
  events: DesiredMaterialEvent[];
}

const SAFE_MARKER_SEGMENT = /^[A-Za-z0-9._:-]{1,160}$/;
const MAX_EVIDENCE = 8;
const MAX_STATUS_BODY = 6_000;
const MAX_EVENT_BODY = 4_000;

const STATE_COPY: Record<BrainHandsIssueState, { title: string; next: string }> = {
  ready: { title: "Ready", next: "Begin the approved Hands implementation." },
  implementing: { title: "Implementing", next: "Record the Hands result, then run deterministic verification." },
  verifying: { title: "Verifying", next: "Persist complete evidence, then start Verifier review." },
  reviewing: { title: "Verifier review", next: "Await the persisted Verifier decision." },
  fixing: { title: "Fixing", next: "Apply approved fixes, then rerun affected verification." },
  blocked: { title: "Blocked", next: "Resolve the recorded blocker, then resume this run." },
  complete: { title: "Complete", next: "Await integrated delivery review." },
};

const STATE_LABEL: Record<BrainHandsIssueState, BrainHandsStateLabel> = {
  ready: "brain-hands:ready",
  implementing: "brain-hands:implementing",
  verifying: "brain-hands:verifying",
  reviewing: "brain-hands:reviewing",
  fixing: "brain-hands:fixing",
  blocked: "brain-hands:blocked",
  complete: "brain-hands:ready",
};

function safeMarkerSegment(value: string): string {
  if (!SAFE_MARKER_SEGMENT.test(value)) throw new Error("Invalid marker segment");
  return value;
}

function safePositiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) throw new Error(`Invalid ${label}`);
  return value;
}

function formattedTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("Invalid transition timestamp");
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function publicCheckLabel(check: StatusCheck): string {
  const command = check.rawCommand.trim().replace(/\s+/g, " ");
  if (
    command === "npm test" ||
    command === "npm run typecheck" ||
    command === "npm run build" ||
    command === "npm run validate-release" ||
    command === "npm pack --dry-run"
  ) {
    return command;
  }
  return `Verification check ${safePositiveInteger(check.index, "check index")}`;
}

function publicCheckStatus(value: unknown): string {
  switch (value) {
    case "pending": return "pending";
    case "passed": return "passed";
    case "failed": return "failed";
    case "timed_out": return "timed out";
    default: return "unknown";
  }
}

function evidenceLines(checks: StatusCheck[]): string[] {
  if (checks.length === 0) return ["- No verification checks recorded"];
  const visible = checks.slice(0, MAX_EVIDENCE).map((check) => `- \`${publicCheckLabel(check)}\`: ${publicCheckStatus(check.status)}`);
  if (checks.length > MAX_EVIDENCE) visible.push(`- ${checks.length - MAX_EVIDENCE} additional checks recorded`);
  return visible;
}

function severityLines(findings: StatusFinding[]): string[] {
  const counts = new Map<StatusFinding["severity"], number>();
  for (const finding of findings) counts.set(finding.severity, (counts.get(finding.severity) ?? 0) + 1);
  const order: StatusFinding["severity"][] = ["critical", "high", "medium", "low"];
  return order.flatMap((severity) => {
    const count = counts.get(severity);
    return count ? [`- ${severity[0]!.toUpperCase()}${severity.slice(1)}: ${count}`] : [];
  });
}

function progressLines(snapshot: WorkItemStatusSnapshot): string[] {
  const lines: string[] = [];
  if (snapshot.planApproved) lines.push("- Plan approved");
  if (snapshot.implementationRecorded) lines.push("- Implementation recorded");
  if (snapshot.verification.status === "passed") lines.push("- Verification passed");
  if (snapshot.verification.status === "failed") lines.push("- Verification blocked");
  if (snapshot.verifier.status === "running") lines.push("- Verifier review running");
  if (snapshot.verifier.status === "approved") lines.push("- Verifier approved work item");
  if (snapshot.verifier.status === "request_changes") lines.push("- Verifier requested changes");
  if (snapshot.verifier.status === "replan_required") lines.push("- Verifier requires replanning");
  return lines.length > 0 ? lines : ["- Workflow state recorded"];
}

function browserLine(
  browser: WorkItemStatusSnapshot["verification"]["browser"],
  counts: WorkItemStatusSnapshot["verification"]["browserChecks"],
): string {
  const suffix = counts.required > 0 ? ` (${counts.completed} of ${counts.required})` : "";
  switch (browser) {
    case "not_required": return "- Browser checks: not required";
    case "pending": return `- Browser checks: pending${suffix}`;
    case "passed": return `- Browser checks: passed${suffix}`;
    case "failed": return `- Browser checks: failed${suffix}`;
    default: return `- Browser checks: unknown${suffix}`;
  }
}

function artifactLine(counts: WorkItemStatusSnapshot["verification"]["artifacts"]): string {
  return `- Required artifacts: ${counts.present} of ${counts.required} present`;
}

function boundedBody(lines: string[], maximum: number, fallbackTitle: string): string {
  const body = `${lines.join("\n")}\n`;
  if (body.length <= maximum) return body;
  return `${lines[0]}\n\n## ${fallbackTitle}\n\nDetails are recorded in the Brain Hands run ledger.\n`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function eventKey(kind: MaterialEventSnapshot["kind"], workItemId: string, attempt: number): string {
  const safeItem = safeMarkerSegment(workItemId);
  const safeAttempt = safePositiveInteger(attempt, "event attempt");
  const prefix: Record<MaterialEventSnapshot["kind"], string> = {
    verification_blocked: "verification-blocked",
    replan_required: "replan-required",
    reviewer_findings: "reviewer-findings",
    operational_blocker: "operational-blocker",
  };
  return `${prefix[kind]}:${safeItem}:attempt-${safeAttempt}`;
}

function renderMaterialEvent(snapshot: WorkItemStatusSnapshot, event: MaterialEventSnapshot): DesiredMaterialEvent {
  const key = eventKey(event.kind, snapshot.workItemId, event.attempt);
  const marker = eventMarker(snapshot.runId, snapshot.workItemId, key);
  const attempt = safePositiveInteger(event.attempt, "event attempt");
  const lines = [marker, ""];

  if (event.kind === "verification_blocked") {
    lines.push("## Verification blocked", "", `Attempt ${attempt} has required verification failures.`, "", "### Evidence", "", ...evidenceLines(snapshot.verification.checks.filter((check) => check.status === "failed" || check.status === "timed_out")), "", "### Next", "", "Resolve the recorded verification failure, then resume this run.");
  } else if (event.kind === "replan_required") {
    lines.push("## Replan required", "", `Verifier requires a revised approved plan after attempt ${attempt}.`, "", "### Next", "", "Brain Hands will not bypass plan approval.");
  } else if (event.kind === "reviewer_findings") {
    lines.push("## Verifier requested changes", "", `Attempt ${attempt} produced recorded findings.`, "", `Findings recorded: ${snapshot.verifier.findings.length}`, "", "### Severity", "", ...severityLines(snapshot.verifier.findings), "", "### Next", "", "Hands will apply approved fixes, then rerun verification and Verifier review.");
  } else {
    lines.push("## Workflow blocked", "", `Attempt ${attempt} requires operator intervention.`, "", "### Next", "", "Resolve the recorded blocker, then resume this run.");
  }

  return { key, marker, body: boundedBody(lines, MAX_EVENT_BODY, "Brain Hands event") };
}

export function statusMarker(runId: string, workItemId: string): string {
  return `<!-- brain-hands:status run=${safeMarkerSegment(runId)} work-item=${safeMarkerSegment(workItemId)} schema=1 -->`;
}

export function eventMarker(runId: string, workItemId: string, key: string): string {
  return `<!-- brain-hands:event run=${safeMarkerSegment(runId)} work-item=${safeMarkerSegment(workItemId)} key=${safeMarkerSegment(key)} -->`;
}

export function projectWorkItemStatus(snapshot: WorkItemStatusSnapshot): DesiredStatusProjection {
  const marker = statusMarker(snapshot.runId, snapshot.workItemId);
  const index = safePositiveInteger(snapshot.workItemIndex, "work item index");
  const total = safePositiveInteger(snapshot.workItemTotal, "work item total");
  if (index > total) throw new Error("Invalid work item order");
  const attempt = safePositiveInteger(snapshot.attempt, "attempt");
  const maxAttempts = safePositiveInteger(snapshot.maxAttempts, "maximum attempts");
  const copy = STATE_COPY[snapshot.state];
  const lines = [
    marker,
    "",
    "## Brain Hands status",
    "",
    `**State:** ${copy.title}`,
    `**Work item:** \`${safeMarkerSegment(snapshot.workItemId)}\` (${index} of ${total})`,
    `**Attempt:** ${attempt} of ${maxAttempts}`,
    `**Run:** \`${safeMarkerSegment(snapshot.runId)}\``,
    `**Updated:** ${formattedTimestamp(snapshot.transitionAt)}`,
    "",
    "### Progress",
    "",
    ...progressLines(snapshot),
    "",
    "### Evidence",
    "",
    ...evidenceLines(snapshot.verification.checks),
    artifactLine(snapshot.verification.artifacts),
    browserLine(snapshot.verification.browser, snapshot.verification.browserChecks),
    "",
    "### Next",
    "",
    copy.next,
    "",
  ];
  const body = boundedBody(lines, MAX_STATUS_BODY, "Brain Hands status");
  const label = STATE_LABEL[snapshot.state];
  return {
    marker,
    body,
    label,
    hash: sha256(`${body}\n${label}`),
    events: snapshot.materialEvents.map((event) => renderMaterialEvent(snapshot, event)),
  };
}

export function projectDeliveryEvent(input: {
  runId: string;
  workItemId: "integrated";
  pullRequestNumber: number;
  commitSha: string;
  transitionAt: string;
  checks: StatusCheck[];
  /** Accepted for runtime compatibility but intentionally never rendered. */
  residualRisks: string[];
}): DesiredMaterialEvent {
  const pullRequestNumber = safePositiveInteger(input.pullRequestNumber, "pull request number");
  const commitSha = safeMarkerSegment(input.commitSha);
  const key = `delivered-for-review:pr-${pullRequestNumber}:commit-${commitSha}`;
  const marker = eventMarker(input.runId, input.workItemId, key);
  const lines = [
    marker,
    "",
    "## Delivered for review",
    "",
    `Pull request: #${pullRequestNumber}`,
    `Commit: \`${commitSha}\``,
    `Updated: ${formattedTimestamp(input.transitionAt)}`,
    "",
    "### Checks",
    "",
    ...evidenceLines(input.checks),
    "",
    "Brain Hands will not merge automatically.",
    "",
  ];
  return { key, marker, body: boundedBody(lines, MAX_EVENT_BODY, "Delivered for review") };
}
