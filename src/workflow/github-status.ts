import type { GitHubAdapter, GitHubPullRequestReference } from "../adapters/github.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { BrainPlan, RunManifestV2, VerificationEvidence, VerifierReview, WorkItem } from "../core/types.js";
import { persistedVerifierReviewSchema, verificationEvidenceSchema } from "../core/schema.js";
import { topologicallySortWorkItems } from "../core/work-item-order.js";
import { appendGitHubStatusIntent, readGitHubStatusIntents } from "../github/status-checkpoint.js";
import {
  projectDeliveryEvent,
  projectWorkItemStatus,
  type BrainHandsIssueState,
  type DesiredMaterialEvent,
  type DesiredStatusProjection,
  type MaterialEventSnapshot,
  type StatusCheck,
  type StatusFinding,
} from "../github/status-projection.js";
import { syncGitHubDeliveryEvent, syncGitHubIssueStatus, type GitHubStatusSyncResult } from "../github/status-sync.js";
import { createWorkItemIssueResolutionContext, type WorkItemIssueResolutionContext } from "./work-item-issue-resolution.js";
import type { ResourceBudgetPort } from "../core/resource-budget.js";

function checkStatus(command: VerificationEvidence["commands"][number]): StatusCheck["status"] {
  if (command.timed_out) return "timed_out";
  if (command.exit_code === 0) return "passed";
  if (command.exit_code === null) return "pending";
  return "failed";
}

function checks(evidence: VerificationEvidence | undefined): StatusCheck[] {
  return (evidence?.commands ?? []).map((command, index) => ({ index: index + 1, rawCommand: command.command, status: checkStatus(command) }));
}

function artifactCounts(evidence: VerificationEvidence | undefined, workItem: WorkItem): { required: number; present: number } {
  const required = (evidence?.artifact_checks ?? []).filter((artifact) => artifact.required);
  const expected = new Set(workItem.expected_artifacts ?? []).size;
  return { required: Math.max(expected, required.length), present: required.filter((artifact) => artifact.exists).length };
}

function browserCounts(evidence: VerificationEvidence | undefined, workItem: WorkItem): {
  status: "not_required" | "pending" | "passed" | "failed";
  required: number;
  completed: number;
} {
  const checks = workItem.browser_checks ?? [];
  if (checks.length === 0) return { status: "not_required", required: 0, completed: 0 };
  const reports = checks.flatMap((check) => {
    const report = evidence?.browser_evidence.find((candidate) => candidate.name === check.name || candidate.screenshot_artifact === check.screenshot_artifact);
    return report ? [report] : [];
  });
  if (reports.length < checks.length) return { status: "pending", required: checks.length, completed: reports.length };
  return { status: reports.every((report) => report.status === "passed") ? "passed" : "failed", required: checks.length, completed: reports.length };
}

function findings(review: VerifierReview | undefined): StatusFinding[] {
  return (review?.findings ?? []).map((finding) => ({ severity: finding.severity, summary: "" }));
}

function verifierStatus(review: VerifierReview | undefined, state: BrainHandsIssueState): "pending" | "running" | "approved" | "request_changes" | "replan_required" {
  if (review?.decision === "approve") return "approved";
  if (review?.decision === "request_changes") return "request_changes";
  if (review?.decision === "replan_required") return "replan_required";
  return state === "reviewing" ? "running" : "pending";
}

interface RuntimeWorkItemStatusInput {
  runDir: string;
  github: GitHubAdapter;
  manifest: RunManifestV2;
  workItem: WorkItem;
  workItemIndex: number;
  workItemTotal: number;
  issueNumber: number;
  state: BrainHandsIssueState;
  attempt: number;
  transitionAt: string;
  evidence?: VerificationEvidence;
  review?: VerifierReview;
  materialEvents?: MaterialEventSnapshot[];
  intentOnly?: boolean;
  eventProjections?: DesiredMaterialEvent[];
  recordIntent?: boolean;
  budget?: ResourceBudgetPort;
}

function runtimeWorkItemProjection(input: RuntimeWorkItemStatusInput): DesiredStatusProjection {
  const materialEvents = input.materialEvents ?? [];
  const browser = browserCounts(input.evidence, input.workItem);
  const artifacts = artifactCounts(input.evidence, input.workItem);
  const verificationFailed = checks(input.evidence).some((check) => check.status === "failed" || check.status === "timed_out")
    || artifacts.present < artifacts.required
    || browser.status === "failed"
    || (input.evidence !== undefined && browser.status === "pending");
  const projection = projectWorkItemStatus({
    runId: input.manifest.run_id,
    workItemId: input.workItem.id,
    workItemIndex: input.workItemIndex,
    workItemTotal: input.workItemTotal,
    branchName: "",
    state: input.state,
    attempt: Math.max(1, input.attempt),
    maxAttempts: 3,
    transitionAt: input.transitionAt,
    planApproved: input.manifest.approved_revision !== null,
    implementationRecorded: input.state !== "ready",
    verification: {
      status: input.state === "verifying" ? "running" : input.evidence ? (verificationFailed ? "failed" : "passed") : "pending",
      checks: checks(input.evidence),
      browser: browser.status,
      artifacts,
      browserChecks: { required: browser.required, completed: browser.completed },
    },
    verifier: { status: verifierStatus(input.review, input.state), findings: findings(input.review) },
    materialEvents,
  });
  return input.eventProjections ? { ...projection, events: input.eventProjections } : projection;
}

export async function syncRuntimeWorkItemStatus(input: RuntimeWorkItemStatusInput): Promise<GitHubStatusSyncResult> {
  try {
    const materialEvents = input.materialEvents ?? [];
    const projection = runtimeWorkItemProjection(input);
    if (input.recordIntent !== false) {
      await appendGitHubStatusIntent(input.runDir, {
        version: 1,
        id: `issue:${input.issueNumber}:${input.workItem.id}:${input.state}:attempt-${Math.max(1, input.attempt)}`,
        target: { kind: "issue", number: input.issueNumber },
        runId: input.manifest.run_id,
        workItemId: input.workItem.id,
        state: input.state,
        attempt: Math.max(1, input.attempt),
        transitionAt: input.transitionAt,
        evidencePath: input.evidence?.evidence_path,
        reviewPath: typeof input.manifest.work_item_progress[input.workItem.id]?.review_path === "string"
          ? input.manifest.work_item_progress[input.workItem.id]!.review_path as string
          : undefined,
        materialEvents,
      });
    }
    if (input.intentOnly) return { status: "skipped" };
    return await syncGitHubIssueStatus({ runDir: input.runDir, github: input.github, issueNumber: input.issueNumber, workItemId: input.workItem.id, projection, budget: input.budget });
  } catch {
    return { status: "retry_pending", failureClass: "checkpoint_write" };
  }
}

export async function syncRuntimeDeliveryStatus(input: {
  runDir: string;
  github: GitHubAdapter;
  manifest: RunManifestV2;
  pullRequest: GitHubPullRequestReference;
  commitSha: string;
  transitionAt: string;
  evidence: VerificationEvidence;
  review: VerifierReview;
  intentOnly?: boolean;
  budget?: ResourceBudgetPort;
}): Promise<GitHubStatusSyncResult> {
  if (!input.review.final || input.review.decision !== "approve") return { status: "retry_pending", failureClass: "unsupported" };
  try {
    const event = projectDeliveryEvent({
      runId: input.manifest.run_id,
      workItemId: "integrated",
      pullRequestNumber: input.pullRequest.number,
      commitSha: input.commitSha,
      transitionAt: input.transitionAt,
      checks: checks(input.evidence),
      residualRisks: [],
    });
    await appendGitHubStatusIntent(input.runDir, {
      version: 1,
      id: `pull-request:${input.pullRequest.number}:delivery:${input.commitSha}`,
      target: { kind: "pull_request", number: input.pullRequest.number },
      runId: input.manifest.run_id,
      workItemId: "integrated",
      state: "complete",
      attempt: Math.max(1, input.review.attempt),
      transitionAt: input.transitionAt,
      evidencePath: input.evidence.evidence_path,
      reviewPath: typeof input.manifest.work_item_progress.integrated?.review_path === "string"
        ? input.manifest.work_item_progress.integrated.review_path as string
        : undefined,
      commitSha: input.commitSha,
      materialEvents: [],
    });
    if (input.intentOnly) return { status: "skipped" };
    return await syncGitHubDeliveryEvent({ runDir: input.runDir, github: input.github, pullRequestNumber: input.pullRequest.number, event, budget: input.budget });
  } catch {
    return { status: "retry_pending", failureClass: "checkpoint_write" };
  }
}

async function readOptionalEvidence(runDir: string, path: string | undefined): Promise<VerificationEvidence | undefined> {
  if (!safeArtifactPath(path)) return undefined;
  try { return verificationEvidenceSchema.parse(JSON.parse(await readFile(join(runDir, path), "utf8"))); } catch { return undefined; }
}

async function readOptionalReview(runDir: string, path: string | undefined): Promise<VerifierReview | undefined> {
  if (!safeArtifactPath(path)) return undefined;
  try { return persistedVerifierReviewSchema.parse(JSON.parse(await readFile(join(runDir, path), "utf8"))); } catch { return undefined; }
}

function safeArtifactPath(path: string | undefined): path is string {
  return typeof path === "string" && path.length > 0 && !path.startsWith("/") && !path.includes("\\") && !path.split("/").includes("..");
}

function progressValue(manifest: RunManifestV2, workItemId: string, key: string): string | undefined {
  const value = manifest.work_item_progress[workItemId]?.[key];
  return typeof value === "string" ? value : undefined;
}

function transitionAt(manifest: RunManifestV2, workItemId: string): string {
  const persisted = progressValue(manifest, workItemId, "github_status_transition_at");
  return persisted && !Number.isNaN(new Date(persisted).getTime()) ? persisted : manifest.updated_at;
}

async function eventTransitionAt(
  runDir: string,
  fallback: string,
  matches: (event: { stage?: unknown; type?: unknown; timestamp?: unknown; payload?: unknown }) => boolean,
): Promise<string> {
  try {
    const events = (await readFile(join(runDir, "events.jsonl"), "utf8"))
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try { return [JSON.parse(line) as { stage?: unknown; type?: unknown; timestamp?: unknown; payload?: unknown }]; } catch { return []; }
      });
    const event = [...events].reverse().find((candidate) => matches(candidate));
    return event && typeof event.timestamp === "string" && !Number.isNaN(new Date(event.timestamp).getTime())
      ? event.timestamp
      : fallback;
  } catch {
    return fallback;
  }
}

async function reconstructedTransitionAt(runDir: string, manifest: RunManifestV2, workItemId: string, state: BrainHandsIssueState): Promise<string> {
  const persisted = progressValue(manifest, workItemId, "github_status_transition_at");
  if (persisted && !Number.isNaN(new Date(persisted).getTime())) return persisted;
  const stages: Partial<Record<BrainHandsIssueState, string>> = {
    implementing: "implementing",
    verifying: "verifying",
    reviewing: "verifier_review",
    fixing: "fixing",
  };
  const stage = stages[state];
  if (state === "ready") {
    return eventTransitionAt(runDir, manifest.updated_at, (event) =>
      (event.type === "github_issue_created" || event.type === "github_issue_updated") &&
      typeof event.payload === "object" && event.payload !== null &&
      (event.payload as { work_item_id?: unknown }).work_item_id === workItemId,
    );
  }
  if (!stage) return manifest.updated_at;
  return eventTransitionAt(runDir, manifest.updated_at, (event) =>
    event.stage === stage && event.type === "transition" &&
    typeof event.payload === "object" && event.payload !== null &&
    (event.payload as { work_item_id?: unknown }).work_item_id === workItemId,
  );
}

function ledgerState(manifest: RunManifestV2, workItemId: string): BrainHandsIssueState {
  const progress = manifest.work_item_progress[workItemId];
  if (!progress) return "ready";
  if (progress.status === "complete") return "complete";
  if (progress.status === "blocked") return "blocked";
  if (manifest.current_work_item_id !== workItemId) return "implementing";
  switch (manifest.stage) {
    case "verifying": return "verifying";
    case "verifier_review": return "reviewing";
    case "fixing": return "fixing";
    default: return "implementing";
  }
}

function reconstructedEvents(manifest: RunManifestV2, workItemId: string, state: BrainHandsIssueState, attempt: number, review: VerifierReview | undefined): MaterialEventSnapshot[] {
  if (state === "fixing" && review?.decision === "request_changes") return [{ kind: "reviewer_findings", attempt: review.attempt }];
  if (state !== "blocked") return [];
  const blocker = progressValue(manifest, workItemId, "blocker") ?? manifest.last_blocker ?? "";
  if (blocker.startsWith("Verification failed")) return [{ kind: "verification_blocked", attempt }];
  if (manifest.stage === "replanning" || blocker.includes("requires replanning") || blocker.includes("requested changes three times")) {
    return [{ kind: "replan_required", attempt }];
  }
  const blockerClass = blocker.includes("Verifier")
    ? "verifier_invalid"
    : blocker.includes("Hands")
      ? "hands_invalid"
      : undefined;
  return [{ kind: "operational_blocker", attempt, ...(blockerClass ? { blockerClass } : {}) }];
}

async function reconstructLedgerProjections(input: {
  runDir: string;
  github: GitHubAdapter;
  manifest: RunManifestV2;
  orderedWorkItems: readonly WorkItem[];
  issueResolution: WorkItemIssueResolutionContext;
}): Promise<void> {
  for (const [index, workItem] of input.orderedWorkItems.entries()) {
    const issueNumber = input.issueResolution.resolve(workItem.id);
    if (!issueNumber) continue;
    const progress = input.manifest.work_item_progress[workItem.id];
    const attempt = Math.max(1, progress?.attempts ?? 1);
    const state = ledgerState(input.manifest, workItem.id);
    const evidence = await readOptionalEvidence(input.runDir, progressValue(input.manifest, workItem.id, "verification_path"));
    const review = await readOptionalReview(input.runDir, progressValue(input.manifest, workItem.id, "review_path"));
    await syncRuntimeWorkItemStatus({
      runDir: input.runDir,
      github: input.github,
      manifest: input.manifest,
      workItem,
      workItemIndex: index + 1,
      workItemTotal: input.orderedWorkItems.length,
      issueNumber,
      state,
      attempt,
      transitionAt: await reconstructedTransitionAt(input.runDir, input.manifest, workItem.id, state),
      evidence,
      review,
      materialEvents: reconstructedEvents(input.manifest, workItem.id, state, attempt, review),
      intentOnly: true,
    });
  }

  const integrated = input.manifest.work_item_progress.integrated;
  if (input.manifest.stage !== "delivery" && input.manifest.stage !== "complete") return;
  const pullRequestNumber = input.manifest.github_ids.pull_request_numbers[0] ?? input.manifest.pull_request_numbers[0];
  const pullRequestUrl = pullRequestNumber ? input.manifest.github_ids.pull_request_urls[String(pullRequestNumber)] : undefined;
  const commitSha = typeof integrated?.commit_sha === "string" ? integrated.commit_sha : "no-op";
  if (!integrated || !pullRequestNumber || !pullRequestUrl) return;
  const evidence = await readOptionalEvidence(input.runDir, progressValue(input.manifest, "integrated", "verification_path"));
  const review = await readOptionalReview(input.runDir, progressValue(input.manifest, "integrated", "review_path"));
  if (!evidence || !review?.final || review.decision !== "approve") return;
  await syncRuntimeDeliveryStatus({
    runDir: input.runDir,
    github: input.github,
    manifest: input.manifest,
    pullRequest: { number: pullRequestNumber, url: pullRequestUrl },
    commitSha,
    transitionAt: await eventTransitionAt(input.runDir, transitionAt(input.manifest, "integrated"), (event) =>
      event.stage === "delivery" && event.type === "transition" &&
      typeof event.payload === "object" && event.payload !== null &&
      (event.payload as { delivery?: unknown }).delivery === "github_ready",
    ),
    evidence,
    review,
    intentOnly: true,
  });
}

/** Replay every durable projection intent without allowing a status error to affect workflow state. */
export async function replayGitHubStatusIntents(input: {
  runDir: string;
  github: GitHubAdapter;
  manifest: RunManifestV2;
  plan: BrainPlan;
  publishIntegratedDelivery?: boolean;
}): Promise<void> {
  try {
    if (
      input.manifest.stage === "awaiting_discovery_answer"
      || input.manifest.stage === "awaiting_discovery_approach"
      || input.manifest.stage === "awaiting_discovery_brief_approval"
    ) return;
    const orderedWorkItems = topologicallySortWorkItems(input.plan.work_items);
    const issueResolution = createWorkItemIssueResolutionContext(input.manifest, input.plan.work_items);
    await reconstructLedgerProjections({ ...input, orderedWorkItems, issueResolution });
    const intents = await readGitHubStatusIntents(input.runDir);
    const events = new Map<string, Map<string, { intent: typeof intents[number]; event: MaterialEventSnapshot }>>();
    for (const intent of intents) {
      if (intent.target.kind !== "issue") continue;
      if (intent.runId !== input.manifest.run_id) continue;
      if (issueResolution.resolve(intent.workItemId) !== intent.target.number) continue;
      const recorded = events.get(intent.workItemId) ?? new Map();
      for (const event of intent.materialEvents) {
        const key = `${event.kind}:${event.attempt}:${event.blockerClass ?? ""}`;
        const preferred = event.kind === "reviewer_findings" ? intent.state === "fixing" : intent.state === "blocked";
        const previous = recorded.get(key);
        if (!previous || preferred) recorded.set(key, { intent, event });
      }
      events.set(intent.workItemId, recorded);
    }
    for (const [index, workItem] of orderedWorkItems.entries()) {
      const issueNumber = issueResolution.resolve(workItem.id);
      if (!issueNumber) continue;
      const progress = input.manifest.work_item_progress[workItem.id];
      const state = ledgerState(input.manifest, workItem.id);
      const attempt = Math.max(1, progress?.attempts ?? 1);
      const evidence = await readOptionalEvidence(input.runDir, progressValue(input.manifest, workItem.id, "verification_path"));
      const review = await readOptionalReview(input.runDir, progressValue(input.manifest, workItem.id, "review_path"));
      const eventProjections = [] as DesiredMaterialEvent[];
      for (const origin of events.get(workItem.id)?.values() ?? []) {
        const originProjection = runtimeWorkItemProjection({
          runDir: input.runDir,
          github: input.github,
          manifest: input.manifest,
          workItem,
          workItemIndex: index + 1,
          workItemTotal: orderedWorkItems.length,
          issueNumber,
          state: origin.intent.state,
          attempt: origin.intent.attempt,
          transitionAt: origin.intent.transitionAt,
          evidence: await readOptionalEvidence(input.runDir, origin.intent.evidencePath),
          review: await readOptionalReview(input.runDir, origin.intent.reviewPath),
          materialEvents: [origin.event],
        });
        if (originProjection.events[0]) eventProjections.push(originProjection.events[0]);
      }
      await syncRuntimeWorkItemStatus({
        runDir: input.runDir,
        github: input.github,
        manifest: input.manifest,
        workItem,
        workItemIndex: index + 1,
        workItemTotal: orderedWorkItems.length,
        issueNumber,
        state,
        attempt,
        transitionAt: await reconstructedTransitionAt(input.runDir, input.manifest, workItem.id, state),
        evidence,
        review,
        materialEvents: reconstructedEvents(input.manifest, workItem.id, state, attempt, review),
        eventProjections,
        recordIntent: false,
      });
    }
    if (input.publishIntegratedDelivery !== true) return;
    for (const intent of intents.filter((candidate) =>
      candidate.runId === input.manifest.run_id && candidate.target.kind === "pull_request" && candidate.workItemId === "integrated")) {
      if (!input.manifest.github_ids.pull_request_numbers.includes(intent.target.number) && !input.manifest.pull_request_numbers.includes(intent.target.number)) continue;
      const url = input.manifest.github_ids.pull_request_urls[String(intent.target.number)];
      const evidence = await readOptionalEvidence(input.runDir, intent.evidencePath);
      const review = await readOptionalReview(input.runDir, intent.reviewPath);
      if (!url || !intent.commitSha || !evidence || !review) continue;
      await syncRuntimeDeliveryStatus({
        runDir: input.runDir,
        github: input.github,
        manifest: input.manifest,
        pullRequest: { number: intent.target.number, url },
        commitSha: intent.commitSha,
        transitionAt: intent.transitionAt,
        evidence,
        review,
      });
    }
  } catch {
    // Status projection is observational and must not change workflow truth.
  }
}
