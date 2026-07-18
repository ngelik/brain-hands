import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GitHubAdapter, GitHubCommentReference, GitHubCommentTarget } from "../../src/adapters/github.js";
import { StatusCommentOwnershipConflictError } from "../../src/adapters/github.js";
import type {
  ResourceBudgetClaimInput,
  ResourceBudgetClaimV1,
  ResourceBudgetCompletionInput,
  ResourceBudgetPort,
  ResourceBudgetUsage,
} from "../../src/core/resource-budget.js";
import { projectDeliveryEvent, projectWorkItemStatus, type WorkItemStatusSnapshot } from "../../src/github/status-projection.js";
import { syncGitHubDeliveryEvent, syncGitHubIssueStatus } from "../../src/github/status-sync.js";
import type { GitHubIssueStateReference } from "../../src/adapters/github.js";
import { readGitHubStatusCheckpoint } from "../../src/github/status-checkpoint.js";

let root: string | undefined;
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = undefined; });

class RecordingGitHub implements GitHubAdapter {
  comments: Array<GitHubCommentReference & { target: GitHubCommentTarget }> = [];
  labels: string[] = [];
  calls: string[] = [];
  conflict = false;
  failLabel = false;
  onFind?: () => Promise<void>;
  issue: GitHubIssueStateReference = { number: 7, title: "Issue", body: "body", state: "OPEN", state_reason: null, labels: [] };

  async createIssue(): Promise<number> { return 1; }
  async updateIssue(): Promise<void> {}
  async addIssueLabels(): Promise<void> {}
  async openPullRequest(): Promise<number> { return 1; }
  async commentOnPullRequest(): Promise<void> {}
  async getIssue(): Promise<GitHubIssueStateReference> {
    this.calls.push("getIssue");
    return { ...this.issue, labels: [...(this.issue.labels ?? [])] };
  }
  async findStatusCommentByMarker(target: GitHubCommentTarget, marker: string): Promise<GitHubCommentReference | null> {
    this.calls.push("find");
    await this.onFind?.();
    if (this.conflict) throw new StatusCommentOwnershipConflictError();
    const matches = this.comments.filter((comment) => comment.target.kind === target.kind && comment.target.number === target.number && comment.body.startsWith(`${marker}\n`));
    return matches[0] ?? null;
  }
  async createStatusComment(target: GitHubCommentTarget, body: string): Promise<GitHubCommentReference> {
    this.calls.push("create");
    const comment = { id: this.comments.length + 1, body, authorLogin: "bot", target };
    this.comments.push(comment);
    return comment;
  }
  async updateStatusComment(id: number, body: string): Promise<void> {
    this.calls.push("update");
    const comment = this.comments.find((entry) => entry.id === id)!;
    comment.body = body;
  }
  async reconcileIssueStateLabel(_issue: number, label: string, options?: {
    withExternalEffect?: <T>(key: string, action: () => Promise<T>) => Promise<T>;
  }): Promise<void> {
    if (this.labels[0] === label) return;
    this.calls.push("label");
    if (this.failLabel) throw new Error("required label is missing");
    this.labels = [label];
    this.issue = { ...this.issue, labels: ["unrelated", label] };
    const apply = async () => { this.labels = [label]; };
    if (options?.withExternalEffect) await options.withExternalEffect("issue-labels", apply);
    else await apply();
  }
}

function recordingBudget(): ResourceBudgetPort & {
  claims: ResourceBudgetClaimV1[];
  completions: ResourceBudgetCompletionInput[];
} {
  const claims: ResourceBudgetClaimV1[] = [];
  const completions: ResourceBudgetCompletionInput[] = [];
  const usage: ResourceBudgetUsage = {
    model_invocations: 0,
    workflow_attempts: 0,
    total_tokens: 0,
    cached_input_tokens: 0,
    reasoning_output_tokens: 0,
    active_elapsed_ms: 0,
    external_effects: 0,
    token_accounting: "known",
    uncertain_model_claim_ids: [],
    token_overshoot: 0,
  };
  return {
    claims,
    completions,
    usage: async () => usage,
    remainingActiveElapsedMs: async () => 1_000,
    claim: async (input: ResourceBudgetClaimInput) => {
      const claim: ResourceBudgetClaimV1 = {
        schema_version: 1,
        claim_id: `budget-claim:${String(claims.length + 1).repeat(64).slice(0, 64)}`,
        run_id: "run-1",
        kind: input.kind,
        key: input.key,
        reserved_at: "2026-07-17T00:00:00.000Z",
        elapsed_reservation_ms: input.elapsed_reservation_ms,
      };
      claims.push(claim);
      return claim;
    },
    complete: async (input: ResourceBudgetCompletionInput) => {
      completions.push(input);
      return { schema_version: 1, completed_at: "2026-07-17T00:00:01.000Z", ...input };
    },
    runWorkflowAttempt: async (_key, action) => action(),
  };
}

const snapshot: WorkItemStatusSnapshot = {
  runId: "run-1", workItemId: "item", workItemIndex: 1, workItemTotal: 1,
  branchName: "ignored", state: "ready", attempt: 1, maxAttempts: 3,
  transitionAt: "2026-07-11T16:25:00.000Z", planApproved: true,
  implementationRecorded: false,
  verification: {
    status: "pending",
    checks: [],
    browser: "not_required",
    artifacts: { required: 0, present: 0 },
    browserChecks: { required: 0, completed: 0 },
  },
  verifier: { status: "pending", findings: [] }, materialEvents: [],
};

describe("GitHub status synchronization", () => {
  it("creates once, edits the owned status, and performs no remote mutation on a no-op", async () => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-sync-"));
    const github = new RecordingGitHub();
    const ready = projectWorkItemStatus(snapshot);
    expect((await syncGitHubIssueStatus({ runDir: root, github, issueNumber: 7, workItemId: "item", projection: ready })).status).toBe("synced");
    expect(github.comments).toHaveLength(1);
    expect(github.labels).toEqual(["brain-hands:ready"]);

    const reviewing = projectWorkItemStatus({ ...snapshot, state: "reviewing" });
    expect((await syncGitHubIssueStatus({ runDir: root, github, issueNumber: 7, workItemId: "item", projection: reviewing })).status).toBe("synced");
    expect(github.calls).toContain("update");
    const calls = github.calls.length;
    expect((await syncGitHubIssueStatus({ runDir: root, github, issueNumber: 7, workItemId: "item", projection: reviewing })).status).toBe("skipped");
    expect(github.calls).toHaveLength(calls + 1);
    expect(github.calls.at(-1)).toBe("getIssue");
  });

  it.each([
    ["COMPLETED", "brain-hands:complete"],
    ["NOT_PLANNED", "brain-hands:not-planned"],
  ] as const)("reconciles a closed %s issue without active comments or material events", async (reason, desired) => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-sync-"));
    const github = new RecordingGitHub();
    github.issue = {
      ...github.issue,
      state: "CLOSED",
      state_reason: reason,
      labels: ["unrelated", "brain-hands:ready", "brain-hands:blocked"],
    };
    const projection = projectWorkItemStatus({
      ...snapshot,
      state: "blocked",
      materialEvents: [{ kind: "operational_blocker", attempt: 1 }],
    });

    await expect(syncGitHubIssueStatus({ runDir: root, github, issueNumber: 7, workItemId: "item", projection }))
      .resolves.toEqual({ status: "synced" });
    expect(github.comments).toEqual([]);
    expect(github.calls).not.toContain("find");
    expect(github.calls).not.toContain("create");
    expect(github.labels).toEqual([desired]);
    expect((await readGitHubStatusCheckpoint(root)).targets["issue:7:item"]).toMatchObject({
      projectionHash: null,
      label: desired,
      emittedEventKeys: [],
      retry: null,
    });

    const calls = github.calls.length;
    await expect(syncGitHubIssueStatus({ runDir: root, github, issueNumber: 7, workItemId: "item", projection }))
      .resolves.toEqual({ status: "skipped" });
    expect(github.calls).toHaveLength(calls + 1);
    expect(github.comments).toEqual([]);
  });

  it("fails closed on an unknown closed reason without active projection", async () => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-sync-"));
    const github = new RecordingGitHub();
    github.issue = { ...github.issue, state: "CLOSED", state_reason: null, labels: ["brain-hands:ready"] };

    await expect(syncGitHubIssueStatus({ runDir: root, github, issueNumber: 7, workItemId: "item", projection: projectWorkItemStatus(snapshot) }))
      .resolves.toEqual({ status: "retry_pending", failureClass: "issue_observation" });
    expect(github.comments).toEqual([]);
    expect(github.calls).not.toContain("find");
    expect(github.calls).not.toContain("label");
  });

  it("reconciles a closed issue without requiring unused comment capabilities", async () => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-sync-"));
    const github = new RecordingGitHub();
    github.issue = { ...github.issue, state: "CLOSED", state_reason: "COMPLETED", labels: ["brain-hands:ready"] };
    github.findStatusCommentByMarker = undefined as never;
    github.createStatusComment = undefined as never;
    github.updateStatusComment = undefined as never;

    await expect(syncGitHubIssueStatus({ runDir: root, github, issueNumber: 7, workItemId: "item", projection: projectWorkItemStatus(snapshot) }))
      .resolves.toEqual({ status: "synced" });
    expect(github.labels).toEqual(["brain-hands:complete"]);
  });

  it("reports a missing required label as label sync failure without active projection", async () => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-sync-"));
    const github = new RecordingGitHub();
    github.failLabel = true;

    await expect(syncGitHubIssueStatus({ runDir: root, github, issueNumber: 7, workItemId: "item", projection: projectWorkItemStatus(snapshot) }))
      .resolves.toEqual({ status: "retry_pending", failureClass: "label_sync" });
    expect(github.comments).toEqual([]);
    expect(github.calls).not.toContain("find");
  });

  it("budgets status labels only when label reconciliation mutates remotely", async () => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-sync-"));
    const github = new RecordingGitHub();
    const budget = recordingBudget();

    expect((await syncGitHubIssueStatus({ runDir: root, github, issueNumber: 7, workItemId: "item", projection: projectWorkItemStatus(snapshot), budget })).status).toBe("synced");
    const claimsAfterCreate = budget.claims.length;
    expect(budget.claims.map((claim) => claim.key)).toEqual(expect.arrayContaining([
      expect.stringContaining(":comment:create"),
      expect.stringContaining(":label:issue-labels:brain-hands:ready"),
    ]));

    expect((await syncGitHubIssueStatus({
      runDir: root,
      github,
      issueNumber: 7,
      workItemId: "item",
      projection: projectWorkItemStatus({ ...snapshot, attempt: 2 }),
      budget,
    })).status).toBe("synced");

    const newClaimKeys = budget.claims.slice(claimsAfterCreate).map((claim) => claim.key);
    expect(newClaimKeys).toEqual([expect.stringContaining(":comment:update")]);
  });

  it("publishes a complete lease atomically before the first remote lookup", async () => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-sync-"));
    const github = new RecordingGitHub();
    github.onFind = async () => {
      const lease = JSON.parse(await readFile(join(root!, ".github-status-sync.lock"), "utf8")) as { host?: unknown; pid?: unknown; createdAt?: unknown };
      expect(lease).toMatchObject({ host: hostname(), pid: process.pid });
      expect(typeof lease.createdAt).toBe("string");
    };

    await expect(syncGitHubIssueStatus({ runDir: root, github, issueNumber: 7, workItemId: "item", projection: projectWorkItemStatus(snapshot) }))
      .resolves.toEqual({ status: "synced" });
  });

  it("turns marker ownership ambiguity and lock contention into retry-pending results", async () => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-sync-"));
    const github = new RecordingGitHub();
    github.conflict = true;
    const projection = projectWorkItemStatus(snapshot);
    await expect(syncGitHubIssueStatus({ runDir: root, github, issueNumber: 7, workItemId: "item", projection }))
      .resolves.toEqual({ status: "retry_pending", failureClass: "comment_conflict" });

    await mkdir(join(root, ".github-status-sync.lock"));
    github.conflict = false;
    await expect(syncGitHubIssueStatus({ runDir: root, github, issueNumber: 7, workItemId: "item", projection }))
      .resolves.toEqual({ status: "retry_pending", failureClass: "lock_contended" });
  });

  it("reclaims a stale lease while retaining a live lock", async () => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-sync-"));
    const github = new RecordingGitHub();
    const projection = projectWorkItemStatus(snapshot);
    const lock = join(root, ".github-status-sync.lock");
    await mkdir(lock);
    await writeFile(join(lock, "lease.json"), JSON.stringify({ host: hostname(), pid: 999_999, createdAt: "2000-01-01T00:00:00.000Z" }));

    await expect(syncGitHubIssueStatus({ runDir: root, github, issueNumber: 7, workItemId: "item", projection }))
      .resolves.toEqual({ status: "synced" });
    expect(github.comments).toHaveLength(1);
  });

  it("does not steal a stale-looking lock from an unknown host", async () => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-sync-"));
    const github = new RecordingGitHub();
    const lock = join(root, ".github-status-sync.lock");
    await mkdir(lock);
    await writeFile(join(lock, "lease.json"), JSON.stringify({ host: "other-host", pid: 999_999, createdAt: "2000-01-01T00:00:00.000Z" }));

    await expect(syncGitHubIssueStatus({ runDir: root, github, issueNumber: 7, workItemId: "item", projection: projectWorkItemStatus(snapshot) }))
      .resolves.toEqual({ status: "retry_pending", failureClass: "lock_contended" });
  });

  it("posts a verified delivery event once without creating a mutable PR status", async () => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-sync-"));
    const github = new RecordingGitHub();
    const event = projectDeliveryEvent({ runId: "run-1", workItemId: "integrated", pullRequestNumber: 42, commitSha: "abc1234", transitionAt: snapshot.transitionAt, checks: [], residualRisks: [] });
    await syncGitHubDeliveryEvent({ runDir: root, github, pullRequestNumber: 42, event });
    await syncGitHubDeliveryEvent({ runDir: root, github, pullRequestNumber: 42, event });
    expect(github.comments).toHaveLength(1);
    expect(github.comments[0]!.body).toContain("Delivered for review");
  });
});
