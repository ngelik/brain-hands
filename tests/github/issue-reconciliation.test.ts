import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DryRunGitHubAdapter,
  type GitHubIssueStateReference,
  type GitHubPullRequestReference,
} from "../../src/adapters/github.js";
import type {
  ResourceBudgetClaimInput,
  ResourceBudgetClaimV1,
  ResourceBudgetCompletionInput,
  ResourceBudgetPort,
  ResourceBudgetUsage,
} from "../../src/core/resource-budget.js";
import type { RunManifestV2 } from "../../src/core/types.js";
import {
  createRunLedgerV2,
  readManifestV2,
  recordTerminalDispositionWithCleanup,
  updateManifestV2,
} from "../../src/core/ledger.js";
import { readTaskLineage, withTaskLineageTransaction } from "../../src/core/task-lineage.js";
import { planIssueSyncPreview, planPullRequestDeliveryPreview, writeGithubEffectPreview } from "../../src/github/effect-plan.js";
import {
  readIssueLifecycleCheckpoint,
  reconcileGitHubIssues,
} from "../../src/github/issue-reconciliation.js";
import { reconcileClosingLinksBlock } from "../../src/github/issue-lifecycle.js";
import { createLegacyRunLedgerV2 } from "../fixtures/legacy-run.js";

let root: string | null = null;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = null;
});

class LifecycleGitHub extends DryRunGitHubAdapter {
  defaultBranch = "main";
  pullRequest: GitHubPullRequestReference | null = null;
  readonly issues = new Map<number, GitHubIssueStateReference>();
  readonly bodyUpdates: string[] = [];
  readonly closures: Array<{ number: number; reason: "completed" | "not_planned" }> = [];
  readonly labelEdits: Array<{ number: number; add: string[]; remove: string[] }> = [];
  failNextClose = false;
  failNextCloseAfterMutation = false;
  failNextLabel = false;
  failNextLabelAfterMutation = false;
  failNextBodyUpdate = false;
  failNextBodyUpdateAfterMutation = false;

  override async getDefaultBranch(): Promise<string> { return this.defaultBranch; }
  override async getPullRequest(): Promise<GitHubPullRequestReference> {
    if (!this.pullRequest) throw new Error("pull request missing");
    return { ...this.pullRequest, closing_issue_numbers: [...(this.pullRequest.closing_issue_numbers ?? [])] };
  }
  override async updatePullRequestBody(_number: number, body: string): Promise<void> {
    if (!this.pullRequest) throw new Error("pull request missing");
    if (this.failNextBodyUpdate) {
      this.failNextBodyUpdate = false;
      throw new Error("simulated PR edit interruption");
    }
    this.bodyUpdates.push(body);
    this.pullRequest = {
      ...this.pullRequest,
      body,
      closing_issue_numbers: [...body.matchAll(/^Closes #(\d+)$/gm)].map((match) => Number(match[1])),
    };
    if (this.failNextBodyUpdateAfterMutation) {
      this.failNextBodyUpdateAfterMutation = false;
      throw new Error("simulated lost PR edit response");
    }
  }
  async getIssue(number: number): Promise<GitHubIssueStateReference> {
    const issue = this.issues.get(number);
    if (!issue) throw new Error(`issue ${number} missing`);
    return { ...issue, ...(issue.labels ? { labels: [...issue.labels] } : {}) };
  }
  async closeIssue(number: number, reason: "completed" | "not_planned"): Promise<void> {
    if (this.failNextClose) {
      this.failNextClose = false;
      throw new Error("simulated close interruption");
    }
    const issue = await this.getIssue(number);
    this.closures.push({ number, reason });
    this.issues.set(number, {
      ...issue,
      state: "CLOSED",
      state_reason: reason === "completed" ? "COMPLETED" : "NOT_PLANNED",
    });
    if (this.failNextCloseAfterMutation) {
      this.failNextCloseAfterMutation = false;
      throw new Error("simulated lost close response");
    }
  }
  async updateIssueLabels(number: number, input: { add: string[]; remove: string[] }): Promise<void> {
    if (this.failNextLabel) { this.failNextLabel = false; throw new Error("simulated label interruption"); }
    const issue = await this.getIssue(number);
    const labels = (issue.labels ?? []).filter((label) => !input.remove.includes(label));
    for (const label of input.add) if (!labels.includes(label)) labels.push(label);
    this.labelEdits.push({ number, add: [...input.add], remove: [...input.remove] });
    this.issues.set(number, { ...issue, labels });
    if (this.failNextLabelAfterMutation) { this.failNextLabelAfterMutation = false; throw new Error("simulated lost label response"); }
  }
}

class CleanupGitHub extends DryRunGitHubAdapter {
  readonly observations = new Map<number, GitHubIssueStateReference & { labels: string[] }>();
  readonly closures: number[] = [];
  readonly labelEdits: Array<{ number: number; add: string[]; remove: string[] }> = [];
  readonly issueReads: number[] = [];
  failNumber: number | null = null;
  throwAfterCloseNumber: number | null = null;
  failLabelNumber: number | null = null;
  throwAfterLabelNumber: number | null = null;
  beforeFirstClose: (() => Promise<void>) | null = null;
  pullRequest: GitHubPullRequestReference | null = null;
  repository = { host: "github.com", name_with_owner: "acme/repo", actor: "operator" };

  override async getRepositoryIdentity() {
    return this.repository;
  }

  override async getPullRequest(): Promise<GitHubPullRequestReference> {
    if (!this.pullRequest) throw new Error("pull request missing");
    return { ...this.pullRequest, closing_issue_numbers: [...(this.pullRequest.closing_issue_numbers ?? [])] };
  }

  override async updatePullRequestBody(_number: number, body: string): Promise<void> {
    if (!this.pullRequest) throw new Error("pull request missing");
    this.pullRequest = { ...this.pullRequest, body, closing_issue_numbers: [...body.matchAll(/^Closes #(\d+)$/gm)].map((match) => Number(match[1])) };
  }

  override async getIssue(number: number): Promise<GitHubIssueStateReference & { labels: string[] }> {
    this.issueReads.push(number);
    const issue = this.observations.get(number);
    if (!issue) throw new Error(`issue ${number} missing`);
    return { ...issue, labels: [...issue.labels] };
  }

  override async closeIssue(number: number, reason: "completed" | "not_planned"): Promise<void> {
    if (this.closures.length === 0) await this.beforeFirstClose?.();
    if (this.failNumber === number) throw new Error(`simulated close failure for #${number}`);
    const issue = await this.getIssue(number);
    this.closures.push(number);
    this.observations.set(number, {
      ...issue,
      state: "CLOSED",
      state_reason: reason === "completed" ? "COMPLETED" : "NOT_PLANNED",
    });
    if (this.throwAfterCloseNumber === number) throw new Error(`simulated lost response for #${number}`);
  }

  async updateIssueLabels(number: number, input: { add: string[]; remove: string[] }): Promise<void> {
    if (this.failLabelNumber === number) throw new Error(`simulated label failure for #${number}`);
    const issue = await this.getIssue(number);
    this.labelEdits.push({ number, add: [...input.add], remove: [...input.remove] });
    const labels = issue.labels.filter((label) => !input.remove.includes(label));
    for (const label of input.add) if (!labels.includes(label)) labels.push(label);
    this.observations.set(number, { ...issue, labels });
    if (this.throwAfterLabelNumber === number) throw new Error(`simulated lost label response for #${number}`);
  }
}

async function cleanupFixture(recordTerminal = true) {
  root = await mkdtemp(join(tmpdir(), "brain-hands-lineage-cleanup-"));
  const ledger = await createRunLedgerV2({
    repoRoot: root,
    originalRequest: "cleanup",
    mode: "github",
    worktreePath: root,
    branchName: "codex/cleanup",
  });
  const manifest = await updateManifestV2(ledger.runDir, { stage: "verifier_review", delivery_state: "blocked" });
  const desired = (title: string, reason_code: string) => ({ title, body: `${title}\n`, labels: ["brain-hands"], state: "OPEN" as const, state_reason: null, reason_code });
  const preview = planIssueSyncPreview({
    revision: 1, lineage_id: manifest.task_lineage_id!, run_id: manifest.run_id,
    repository: { host: "github.com", name_with_owner: "acme/repo" },
    plan_revision: 1, plan_sha256: "a".repeat(64), created_at: "2026-07-17T11:00:00.000Z", lineage_state: "active",
    issue_set: { state: "uninitialized", plan_revision: null, plan_sha256: null, parent_issue_number: null, work_item_issue_map: {}, has_prior_owned_state: false },
    approved_replan: false,
    parent: { feature_slug: "cleanup", desired: desired("Parent", "approved-plan-parent"), observations: [] },
    work_items: [
      { work_item_id: "first", desired: desired("First", "approved-plan-work-item"), observations: [] },
      { work_item_id: "second", desired: desired("Second", "approved-plan-work-item"), observations: [] },
    ],
  });
  const reference = { ...(await writeGithubEffectPreview({ run_dir: ledger.runDir, preview })), state: "applied" as const };
  const numbers = new Map<string, number>([["parent", 9], ["work_item:first", 14], ["work_item:second", 27]]);
  await withTaskLineageTransaction({ repoRoot: root, lineageId: manifest.task_lineage_id!, operation: (transaction) => {
    const current = transaction.read();
    return transaction.update({ ...current, repository_key: "github.com/acme/repo", issue_set: {
      ...current.issue_set, state: "ready", plan_revision: 1, plan_sha256: "a".repeat(64), parent_issue_number: 9,
      work_item_issue_map: { first: 14, second: 27 }, preview: reference,
      operations: Object.fromEntries(preview.effects.map((effect) => {
        if (effect.target.kind !== "parent" && effect.target.kind !== "work_item") throw new Error("invalid fixture effect");
        const key = effect.target.kind === "parent" ? "parent" : `work_item:${effect.target.work_item_id}`;
        return [effect.effect_id, { operation_id: effect.effect_id, target_key: key, desired_sha256: effect.desired_sha256,
          state: "complete" as const, issue_number: numbers.get(key)!, created_by_run_id: manifest.run_id }];
      })),
    } });
  } });
  await updateManifestV2(ledger.runDir, {
    issue_numbers: [14, 27], work_item_issue_map: { first: 14, second: 27 },
    github_ids: { ...manifest.github_ids, issue_numbers: [14, 27], work_item_issue_map: { first: 14, second: 27 }, parent_issue_number: 9 },
    github_effects: { ...manifest.github_effects, issue_sync: reference },
  });
  const lineage = await readTaskLineage(root, manifest.task_lineage_id!);
  if (recordTerminal) {
    await recordTerminalDispositionWithCleanup({ runDir: ledger.runDir, disposition: {
      outcome: "abandoned", actor: "human", reason: "Stop", residual_risks: [], recorded_at: "2026-07-17T12:00:00.000Z",
    }, lineage });
  }
  const github = new CleanupGitHub();
  github.observations.set(9, { number: 9, title: "Parent", body: `<!-- brain-hands-lineage:${lineage.lineage_id} -->\n<!-- brain-hands-run:${manifest.run_id} -->\n<!-- brain-hands-parent:cleanup -->`, state: "OPEN", state_reason: null, labels: ["brain-hands:ready"] });
  github.observations.set(14, { number: 14, title: "First", body: `<!-- brain-hands-lineage:${lineage.lineage_id} -->\n<!-- brain-hands-run:${manifest.run_id} -->\n<!-- brain-hands-work-item:first -->`, state: "OPEN", state_reason: null, labels: ["brain-hands:ready"] });
  github.observations.set(27, { number: 27, title: "Second", body: `<!-- brain-hands-lineage:${lineage.lineage_id} -->\n<!-- brain-hands-run:${manifest.run_id} -->\n<!-- brain-hands-work-item:second -->`, state: "OPEN", state_reason: null, labels: ["brain-hands:ready"] });
  return { ledger, github, lineage };
}

async function attachMergedDeliveryAuthority(runDir: string, head: string) {
  const manifest = await readManifestV2(runDir);
  const lineage = await readTaskLineage(root!, manifest.task_lineage_id!);
  const numbers = [9, 14, 27];
  const body = reconcileClosingLinksBlock("Merged", lineage.lineage_id, manifest.run_id, numbers);
  const preview = planPullRequestDeliveryPreview({
    revision: 1, lineage_id: lineage.lineage_id, run_id: manifest.run_id,
    repository: { host: "github.com", name_with_owner: "acme/repo" },
    plan_revision: lineage.issue_set.plan_revision!, plan_sha256: lineage.issue_set.plan_sha256!,
    created_at: "2026-07-17T11:30:00.000Z", lineage_state: "active", authorized_prior_head_sha: head,
    branch: { branch_name: "codex/cleanup", head_sha: head, observed_head_sha: head, reason_code: "verified-delivery" },
    pull_request: {
      desired: { title: "Task: cleanup", body, head_ref: "codex/cleanup", head_sha: head, base_ref: "main", closing_issue_numbers: numbers, reason_code: "verified-delivery" },
      observations: [{ number: 33, url: "https://github.com/acme/repo/pull/33", title: "Task: cleanup", body,
        head_ref: "codex/cleanup", head_sha: head, base_ref: "main", closing_issue_numbers: numbers, state: "MERGED" }],
    },
  });
  const reference = { ...(await writeGithubEffectPreview({ run_dir: runDir, preview })), state: "applied" as const };
  await withTaskLineageTransaction({ repoRoot: root!, lineageId: lineage.lineage_id, operation: (transaction) => {
    const current = transaction.read();
    return transaction.update({ ...current, delivery: { ...current.delivery, state: "ready", branch_name: "codex/cleanup",
      head_sha: head, preview_prior_head_sha: head, pull_request_number: 33,
      pull_request_url: "https://github.com/acme/repo/pull/33", preview: reference } });
  } });
  await updateManifestV2(runDir, { github_effects: { ...manifest.github_effects, pull_request_delivery: reference } });
  return readTaskLineage(root!, lineage.lineage_id);
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

async function fixture(outcome: "delivered" | "human_accepted" | "abandoned" | "closed_blocked" = "delivered") {
  root = await mkdtemp(join(tmpdir(), "brain-hands-issue-reconciliation-"));
  const ledger = await createLegacyRunLedgerV2({
    repoRoot: root,
    originalRequest: "Ship feature",
    mode: "github",
    slug: "issue-reconciliation",
  });
  const recordedAt = "2026-07-13T12:00:00.000Z";
  const manifest: RunManifestV2 = {
    ...ledger.manifest,
    stage: "delivery",
    delivery_state: outcome === "closed_blocked" ? "blocked" : "ready",
    branch_name: "brain-hands/issue-reconciliation",
    work_item_progress: {
      ...ledger.manifest.work_item_progress,
      integrated: { status: "complete", attempts: 1, commit_sha: "abc123" },
    },
    work_item_issue_map: { child: 14 },
    github_ids: {
      issue_numbers: [14],
      work_item_issue_map: { child: 14 },
      parent_issue_number: 9,
      pull_request_numbers: outcome === "abandoned" || outcome === "closed_blocked" ? [] : [33],
      pull_request_urls: outcome === "abandoned" || outcome === "closed_blocked" ? {} : { "33": "https://github.com/acme/repo/pull/33" },
    },
    terminal: {
      outcome,
      actor: outcome === "delivered" ? "runtime" : "human",
      reason: "Terminal decision",
      recorded_at: recordedAt,
      source_stage: "delivery",
      residual_risks: [],
    },
  };
  const github = new LifecycleGitHub();
  github.issues.set(9, {
    number: 9,
    title: "Parent",
    body: `<!-- brain-hands-run:${manifest.run_id} -->\n<!-- brain-hands-parent:ship-feature -->`,
    state: "OPEN",
    state_reason: null,
  });
  github.issues.set(14, {
    number: 14,
    title: "Child",
    body: `<!-- brain-hands-run:${manifest.run_id} -->\n<!-- brain-hands-work-item:child -->`,
    state: "OPEN",
    state_reason: null,
  });
  return { ledger, manifest, github };
}

describe("reconcileGitHubIssues", () => {
  const mergedBody = (manifest: RunManifestV2) => reconcileClosingLinksBlock("Merged", manifest.run_id, [9, 14]);

  it("reports completed closures after a default-branch merge without mutating in dry-run mode", async () => {
    const { ledger, manifest, github } = await fixture();
    github.pullRequest = {
      number: 33,
      url: "https://github.com/acme/repo/pull/33",
      state: "MERGED",
      head_ref: "brain-hands/issue-reconciliation",
      head_sha: "abc123",
      base_ref: "main",
      body: mergedBody(manifest),
      closing_issue_numbers: [9, 14],
    };

    const report = await reconcileGitHubIssues({ runDir: ledger.runDir, manifest, github, apply: false });

    expect(report.mode).toBe("dry_run");
    expect(report.issues).toEqual([
      expect.objectContaining({ number: 9, kind: "parent", action: "close", reason: "completed", applied: false }),
      expect.objectContaining({ number: 14, kind: "work_item", work_item_id: "child", action: "close", reason: "completed", applied: false }),
    ]);
    expect(github.closures).toEqual([]);
    expect(await readIssueLifecycleCheckpoint(ledger.runDir)).toEqual({ version: 1, operations: {} });
  });

  it("closes merged parent and child issues once and records durable completion", async () => {
    const { ledger, manifest, github } = await fixture("human_accepted");
    github.pullRequest = {
      number: 33,
      url: "https://github.com/acme/repo/pull/33",
      state: "MERGED",
      head_ref: "brain-hands/issue-reconciliation",
      head_sha: "abc123",
      base_ref: "main",
      body: mergedBody(manifest),
      closing_issue_numbers: [9, 14],
    };

    await reconcileGitHubIssues({ runDir: ledger.runDir, manifest, github, apply: true });
    await reconcileGitHubIssues({ runDir: ledger.runDir, manifest, github, apply: true });

    expect(github.closures).toEqual([
      { number: 9, reason: "completed" },
      { number: 14, reason: "completed" },
    ]);
    const checkpoint = await readIssueLifecycleCheckpoint(ledger.runDir);
    expect(Object.values(checkpoint.operations)).toEqual([
      expect.objectContaining({ status: "completed", kind: "issue_close", target_number: 9, reason: "completed" }),
      expect.objectContaining({ status: "completed", kind: "issue_close", target_number: 14, reason: "completed" }),
    ]);
  });

  it("converges already-completed merged issues to only the complete managed label", async () => {
    const { ledger, manifest, github } = await fixture("human_accepted");
    github.pullRequest = {
      number: 33, url: "https://github.com/acme/repo/pull/33", state: "MERGED",
      head_ref: "brain-hands/issue-reconciliation", head_sha: "abc123", base_ref: "main", body: mergedBody(manifest), closing_issue_numbers: [9, 14],
    };
    for (const number of [9, 14]) github.issues.set(number, {
      ...(await github.getIssue(number)), state: "CLOSED", state_reason: "COMPLETED",
      labels: ["brain-hands:ready", "brain-hands:blocked", "keep-me"],
    });

    await reconcileGitHubIssues({ runDir: ledger.runDir, manifest, github, apply: true });

    expect(github.closures).toEqual([]);
    for (const number of [9, 14]) {
      expect((await github.getIssue(number)).labels).toEqual(["keep-me", "brain-hands:complete"]);
    }
    expect(Object.values((await readIssueLifecycleCheckpoint(ledger.runDir)).operations))
      .toEqual(expect.arrayContaining([expect.objectContaining({ target_number: 9, status: "completed" }), expect.objectContaining({ target_number: 14, status: "completed" })]));
  });

  it("keeps a merged close operation pending when terminal-label mutation fails, then retries", async () => {
    const { ledger, manifest, github } = await fixture("human_accepted");
    github.pullRequest = {
      number: 33, url: "https://github.com/acme/repo/pull/33", state: "MERGED",
      head_ref: "brain-hands/issue-reconciliation", head_sha: "abc123", base_ref: "main", body: mergedBody(manifest), closing_issue_numbers: [9, 14],
    };
    github.failNextLabel = true;

    await expect(reconcileGitHubIssues({ runDir: ledger.runDir, manifest, github, apply: true }))
      .rejects.toThrow(/terminal state or managed labels did not converge/i);
    expect(Object.values((await readIssueLifecycleCheckpoint(ledger.runDir)).operations)[0]).toMatchObject({ status: "pending" });

    await reconcileGitHubIssues({ runDir: ledger.runDir, manifest, github, apply: true });
    expect(Object.values((await readIssueLifecycleCheckpoint(ledger.runDir)).operations)
      .every((operation) => operation.status === "completed")).toBe(true);
  });

  it("recovers a lost terminal-label response from fresh completed-state readback", async () => {
    const { ledger, manifest, github } = await fixture("human_accepted");
    github.pullRequest = {
      number: 33, url: "https://github.com/acme/repo/pull/33", state: "MERGED",
      head_ref: "brain-hands/issue-reconciliation", head_sha: "abc123", base_ref: "main", body: mergedBody(manifest), closing_issue_numbers: [9, 14],
    };
    github.failNextLabelAfterMutation = true;

    await reconcileGitHubIssues({ runDir: ledger.runDir, manifest, github, apply: true });

    expect(Object.values((await readIssueLifecycleCheckpoint(ledger.runDir)).operations)
      .every((operation) => operation.status === "completed")).toBe(true);
    expect((await github.getIssue(9)).labels).toEqual(["brain-hands:complete"]);
  });

  it.each(["abandoned", "closed_blocked"] as const)("closes an explicitly %s run as not planned", async (outcome) => {
    const { ledger, manifest, github } = await fixture(outcome);

    await reconcileGitHubIssues({ runDir: ledger.runDir, manifest, github, apply: true });

    expect(github.closures).toEqual([
      { number: 9, reason: "not_planned" },
      { number: 14, reason: "not_planned" },
    ]);
  });

  it("treats an assurance abandonment as an explicit not-planned outcome", async () => {
    const { ledger, manifest, github } = await fixture("delivered");
    const abandonedManifest: RunManifestV2 = {
      ...manifest,
      terminal: null,
      assurance_outcome: "abandoned",
      github_ids: { ...manifest.github_ids, pull_request_numbers: [], pull_request_urls: {} },
    };

    await reconcileGitHubIssues({ runDir: ledger.runDir, manifest: abandonedManifest, github, apply: true });

    expect(github.closures).toEqual([
      { number: 9, reason: "not_planned" },
      { number: 14, reason: "not_planned" },
    ]);
  });

  it("skips a mapped issue whose durable ownership markers do not match", async () => {
    const { ledger, manifest, github } = await fixture("abandoned");
    github.issues.set(14, { ...(await github.getIssue(14)), body: "User-owned issue" });

    const report = await reconcileGitHubIssues({ runDir: ledger.runDir, manifest, github, apply: true });

    expect(report.issues.find((issue) => issue.number === 14)).toMatchObject({ action: "skip", skip_reason: "ownership_marker_mismatch", applied: false });
    expect(github.closures).toEqual([{ number: 9, reason: "not_planned" }]);
  });

  it("fails marker authorization when ownership markers are ambiguous", async () => {
    const { ledger, manifest, github } = await fixture("abandoned");
    github.issues.set(14, {
      ...(await github.getIssue(14)),
      body: `<!-- brain-hands-run:${manifest.run_id} -->\n<!-- brain-hands-run:foreign-run -->\n<!-- brain-hands-work-item:child -->`,
    });

    const report = await reconcileGitHubIssues({ runDir: ledger.runDir, manifest, github, apply: true });

    expect(report.issues.find((issue) => issue.number === 14)).toMatchObject({
      action: "skip",
      skip_reason: "ownership_marker_mismatch",
      applied: false,
    });
    expect(github.closures).toEqual([{ number: 9, reason: "not_planned" }]);
  });

  it("never adds a foreign mapped issue to the managed PR closing block", async () => {
    const { ledger, manifest, github } = await fixture();
    github.issues.set(14, { ...(await github.getIssue(14)), body: "Foreign issue" });
    github.pullRequest = {
      number: 33,
      url: "https://github.com/acme/repo/pull/33",
      state: "OPEN",
      head_ref: "brain-hands/issue-reconciliation",
      head_sha: "abc123",
      base_ref: "main",
      body: "Summary",
      closing_issue_numbers: [],
    };

    const report = await reconcileGitHubIssues({ runDir: ledger.runDir, manifest, github, apply: true });

    expect(report.pull_request).toMatchObject({
      identity_verified: true,
      default_branch_compatible: true,
      action: "update",
      proposed_body: expect.stringContaining("Closes #9"),
      expected_closing_issue_numbers: [9],
    });
    expect(github.bodyUpdates[0]).not.toContain("Closes #14");
    expect(report.issues.find((issue) => issue.number === 14)).toMatchObject({ action: "skip", skip_reason: "ownership_marker_mismatch" });
  });

  it("reports persisted issue numbers that have no durable work-item mapping", async () => {
    const { ledger, manifest, github } = await fixture("abandoned");
    const manifestWithUnmapped: RunManifestV2 = {
      ...manifest,
      github_ids: { ...manifest.github_ids, issue_numbers: [14, 99] },
    };
    github.issues.set(99, { number: 99, title: "Unmapped", body: "User issue", state: "OPEN", state_reason: null });

    const report = await reconcileGitHubIssues({ runDir: ledger.runDir, manifest: manifestWithUnmapped, github, apply: true });

    expect(report.issues.find((issue) => issue.number === 99)).toMatchObject({
      kind: "unmapped",
      state: "OPEN",
      action: "skip",
      skip_reason: "unmapped_issue_number",
      applied: false,
    });
    expect(github.closures).not.toContainEqual(expect.objectContaining({ number: 99 }));
  });

  it("audits an unmapped-only run with a PR without inventing closing links", async () => {
    const { ledger, manifest, github } = await fixture();
    const unmappedManifest: RunManifestV2 = {
      ...manifest,
      work_item_issue_map: {},
      github_ids: {
        ...manifest.github_ids,
        issue_numbers: [99],
        work_item_issue_map: {},
        parent_issue_number: null,
      },
    };
    github.issues.set(99, { number: 99, title: "Unmapped", body: "Foreign", state: "OPEN", state_reason: null });
    github.pullRequest = {
      number: 33,
      url: "https://github.com/acme/repo/pull/33",
      state: "OPEN",
      head_ref: "brain-hands/issue-reconciliation",
      head_sha: "abc123",
      base_ref: "main",
      body: "Summary",
      closing_issue_numbers: [],
    };

    const report = await reconcileGitHubIssues({ runDir: ledger.runDir, manifest: unmappedManifest, github, apply: true });

    expect(report.pull_request).toMatchObject({
      action: "none",
      edit_skip_reason: "no_expected_issues",
      expected_closing_issue_numbers: [],
      proposed_body: null,
    });
    expect(report.issues).toEqual([expect.objectContaining({ number: 99, kind: "unmapped", action: "skip" })]);
    expect(github.bodyUpdates).toEqual([]);
  });

  it("normalizes parsed closing-reference order and duplicates in reports", async () => {
    const { ledger, manifest, github } = await fixture();
    const body = reconcileClosingLinksBlock("Summary", manifest.run_id, [9, 14]);
    github.pullRequest = {
      number: 33,
      url: "https://github.com/acme/repo/pull/33",
      state: "OPEN",
      head_ref: "brain-hands/issue-reconciliation",
      head_sha: "abc123",
      base_ref: "main",
      body,
      closing_issue_numbers: [99, 14, 9, 14],
    };

    const report = await reconcileGitHubIssues({ runDir: ledger.runDir, manifest, github, apply: false });

    expect(report.pull_request?.parsed_closing_issue_numbers).toEqual([9, 14, 99]);
  });

  it("repairs an open pull request and verifies every parsed closing reference", async () => {
    const { ledger, manifest, github } = await fixture();
    github.pullRequest = {
      number: 33,
      url: "https://github.com/acme/repo/pull/33",
      state: "OPEN",
      head_ref: "brain-hands/issue-reconciliation",
      head_sha: "abc123",
      base_ref: "main",
      body: "User summary",
      closing_issue_numbers: [],
    };

    const report = await reconcileGitHubIssues({ runDir: ledger.runDir, manifest, github, apply: true });

    expect(report.pull_request).toMatchObject({ number: 33, action: "update", applied: true, managed_links_verified: true, expected_closing_issue_numbers: [9, 14], missing_closing_issue_numbers: [] });
    expect(github.bodyUpdates[0]).toContain("User summary");
    expect(github.bodyUpdates[0]).toContain("Closes #9\nCloses #14");
    expect(report.issues.every((issue) => issue.action === "keep_open")).toBe(true);
  });

  it("repairs managed closing links again after remote drift", async () => {
    const { ledger, manifest, github } = await fixture();
    github.pullRequest = {
      number: 33,
      url: "https://github.com/acme/repo/pull/33",
      state: "OPEN",
      head_ref: "brain-hands/issue-reconciliation",
      head_sha: "abc123",
      base_ref: "main",
      body: "User summary",
      closing_issue_numbers: [],
    };
    await reconcileGitHubIssues({ runDir: ledger.runDir, manifest, github, apply: true });
    github.pullRequest = {
      ...github.pullRequest,
      body: "User summary",
      closing_issue_numbers: [],
    };

    const report = await reconcileGitHubIssues({ runDir: ledger.runDir, manifest, github, apply: true });

    expect(report.pull_request).toMatchObject({ action: "update", applied: true, missing_closing_issue_numbers: [] });
    expect(github.bodyUpdates).toHaveLength(2);
    expect(github.bodyUpdates[1]).toContain("User summary");
  });

  it("re-arms durable PR-edit intent before retrying an invalidated completed operation", async () => {
    const { ledger, manifest, github } = await fixture();
    const budget = recordingBudget();
    github.pullRequest = {
      number: 33,
      url: "https://github.com/acme/repo/pull/33",
      state: "OPEN",
      head_ref: "brain-hands/issue-reconciliation",
      head_sha: "abc123",
      base_ref: "main",
      body: "User summary",
      closing_issue_numbers: [],
    };
    await reconcileGitHubIssues({ runDir: ledger.runDir, manifest, github, apply: true, budget });
    github.pullRequest = { ...github.pullRequest, body: "User summary", closing_issue_numbers: [] };
    github.failNextBodyUpdate = true;

    await expect(reconcileGitHubIssues({ runDir: ledger.runDir, manifest, github, apply: true, budget }))
      .rejects.toThrow("simulated PR edit interruption");

    expect(Object.values((await readIssueLifecycleCheckpoint(ledger.runDir)).operations))
      .toEqual([expect.objectContaining({ kind: "pull_request_links", status: "pending" })]);
    expect(budget.claims.map((claim) => claim.key)).toEqual([
      expect.stringMatching(/^github-lifecycle:pull_request:33:links:[a-f0-9]{64}$/),
      expect.stringMatching(/^github-lifecycle:pull_request:33:links:[a-f0-9]{64}:rearm:/),
    ]);
  });

  it("completes a pending PR-edit intent when the remote edit already succeeded", async () => {
    const { ledger, manifest, github } = await fixture();
    github.pullRequest = {
      number: 33,
      url: "https://github.com/acme/repo/pull/33",
      state: "OPEN",
      head_ref: "brain-hands/issue-reconciliation",
      head_sha: "abc123",
      base_ref: "main",
      body: "Summary",
      closing_issue_numbers: [],
    };
    github.failNextBodyUpdateAfterMutation = true;

    await expect(reconcileGitHubIssues({ runDir: ledger.runDir, manifest, github, apply: true }))
      .rejects.toThrow("simulated lost PR edit response");
    expect(Object.values((await readIssueLifecycleCheckpoint(ledger.runDir)).operations)[0]).toMatchObject({ status: "pending" });

    const report = await reconcileGitHubIssues({ runDir: ledger.runDir, manifest, github, apply: true });

    expect(report.pull_request).toMatchObject({ action: "none", edit_skip_reason: "already_reconciled", applied: false });
    expect(Object.values((await readIssueLifecycleCheckpoint(ledger.runDir)).operations)[0]).toMatchObject({ status: "completed" });
    expect(github.bodyUpdates).toHaveLength(1);
  });

  it("does not edit or close from a pull request whose durable identity does not match", async () => {
    const { ledger, manifest, github } = await fixture();
    github.pullRequest = {
      number: 33,
      url: "https://github.com/acme/repo/pull/33",
      state: "MERGED",
      head_ref: "foreign/branch",
      head_sha: "def456",
      base_ref: "main",
      body: "Summary",
      closing_issue_numbers: [],
    };

    const report = await reconcileGitHubIssues({ runDir: ledger.runDir, manifest, github, apply: true });

    expect(report.pull_request).toMatchObject({ identity_verified: false, action: "none", edit_skip_reason: "identity_mismatch" });
    expect(report.issues.every((issue) => issue.action === "keep_open")).toBe(true);
    expect(github.bodyUpdates).toEqual([]);
    expect(github.closures).toEqual([]);
  });

  it("does not close issues from a merged pull request with extra closing links", async () => {
    const { ledger, manifest, github } = await fixture();
    const body = reconcileClosingLinksBlock("Merged", manifest.run_id, [9, 14]);
    github.pullRequest = {
      number: 33,
      url: "https://github.com/acme/repo/pull/33",
      state: "MERGED",
      head_ref: "brain-hands/issue-reconciliation",
      head_sha: "abc123",
      base_ref: "main",
      body,
      closing_issue_numbers: [9, 14, 99],
    };

    const report = await reconcileGitHubIssues({ runDir: ledger.runDir, manifest, github, apply: true });

    expect(report.pull_request).toMatchObject({
      identity_verified: true,
      managed_links_verified: false,
      action: "none",
      missing_closing_issue_numbers: [],
    });
    expect(report.issues.every((issue) => issue.action === "keep_open")).toBe(true);
    expect(github.closures).toEqual([]);
    expect(github.labelEdits).toEqual([]);
  });

  it("does not close issues from a merged pull request with a foreign managed closing block", async () => {
    const { ledger, manifest, github } = await fixture();
    github.pullRequest = {
      number: 33,
      url: "https://github.com/acme/repo/pull/33",
      state: "MERGED",
      head_ref: "brain-hands/issue-reconciliation",
      head_sha: "abc123",
      base_ref: "main",
      body: "<!-- brain-hands:issue-links lineage=other run=other schema=1 -->\nCloses #9\nCloses #14\n<!-- /brain-hands:issue-links -->",
      closing_issue_numbers: [9, 14],
    };

    const report = await reconcileGitHubIssues({ runDir: ledger.runDir, manifest, github, apply: true });

    expect(report.pull_request).toMatchObject({ identity_verified: true, managed_links_verified: false, action: "none" });
    expect(report.issues.every((issue) => issue.action === "keep_open")).toBe(true);
    expect(github.closures).toEqual([]);
    expect(github.labelEdits).toEqual([]);
  });

  it("does not install ineffective closing links on a non-default base branch", async () => {
    const { ledger, manifest, github } = await fixture();
    github.pullRequest = {
      number: 33,
      url: "https://github.com/acme/repo/pull/33",
      state: "OPEN",
      head_ref: "brain-hands/issue-reconciliation",
      head_sha: "abc123",
      base_ref: "release",
      body: "User summary",
      closing_issue_numbers: [],
    };

    const report = await reconcileGitHubIssues({ runDir: ledger.runDir, manifest, github, apply: true });

    expect(report.pull_request).toMatchObject({ base_branch: "release", action: "none", applied: false });
    expect(report.issues.every((issue) => issue.action === "keep_open")).toBe(true);
    expect(github.bodyUpdates).toEqual([]);
    expect(github.closures).toEqual([]);
  });

  it("leaves a pending intent after interruption and completes it on retry", async () => {
    const { ledger, manifest, github } = await fixture("abandoned");
    github.failNextClose = true;

    await expect(reconcileGitHubIssues({ runDir: ledger.runDir, manifest, github, apply: true }))
      .rejects.toThrow(/did not converge to NOT_PLANNED/i);
    expect(Object.values((await readIssueLifecycleCheckpoint(ledger.runDir)).operations)[0]).toMatchObject({ status: "pending" });

    await reconcileGitHubIssues({ runDir: ledger.runDir, manifest, github, apply: true });
    expect(github.closures).toEqual([
      { number: 9, reason: "not_planned" },
      { number: 14, reason: "not_planned" },
    ]);
    expect(await readFile(join(ledger.runDir, "github-issue-lifecycle.json"), "utf8")).toContain('"status": "completed"');
  });

  it("completes a pending close intent without closing an already-closed issue again", async () => {
    const { ledger, manifest, github } = await fixture("abandoned");
    github.failNextCloseAfterMutation = true;

    await reconcileGitHubIssues({ runDir: ledger.runDir, manifest, github, apply: true });
    expect(github.closures).toEqual([
      { number: 9, reason: "not_planned" },
      { number: 14, reason: "not_planned" },
    ]);

    await reconcileGitHubIssues({ runDir: ledger.runDir, manifest, github, apply: true });

    expect(github.closures).toEqual([
      { number: 9, reason: "not_planned" },
      { number: 14, reason: "not_planned" },
    ]);
    expect(Object.values((await readIssueLifecycleCheckpoint(ledger.runDir)).operations))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ target_number: 9, status: "completed" }),
        expect.objectContaining({ target_number: 14, status: "completed" }),
      ]));
  });

  it("leaves a pending close incomplete when a human used a different closure reason", async () => {
    const { ledger, manifest, github } = await fixture("abandoned");
    github.failNextClose = true;
    await expect(reconcileGitHubIssues({ runDir: ledger.runDir, manifest, github, apply: true }))
      .rejects.toThrow(/did not converge to NOT_PLANNED/i);
    github.issues.set(9, { ...(await github.getIssue(9)), state: "CLOSED", state_reason: "COMPLETED" });

    const report = await reconcileGitHubIssues({ runDir: ledger.runDir, manifest, github, apply: true });

    expect(report.issues.find((issue) => issue.number === 9)).toMatchObject({ action: "skip", skip_reason: "closed_with_different_reason" });
    expect(Object.values((await readIssueLifecycleCheckpoint(ledger.runDir)).operations)
      .find((operation) => operation.target_number === 9)).toMatchObject({ status: "pending", reason: "not_planned" });
  });

  it("serializes concurrent reconciliation so closures and checkpoints are not duplicated or lost", async () => {
    const { ledger, manifest, github } = await fixture("abandoned");

    await Promise.all([
      reconcileGitHubIssues({ runDir: ledger.runDir, manifest, github, apply: true }),
      reconcileGitHubIssues({ runDir: ledger.runDir, manifest, github, apply: true }),
    ]);

    expect(github.closures).toEqual([
      { number: 9, reason: "not_planned" },
      { number: 14, reason: "not_planned" },
    ]);
    expect(Object.values((await readIssueLifecycleCheckpoint(ledger.runDir)).operations)).toHaveLength(2);
  });

  it("does not close an issue again after a completed Brain Hands closure was manually reopened", async () => {
    const { ledger, manifest, github } = await fixture("abandoned");
    await reconcileGitHubIssues({ runDir: ledger.runDir, manifest, github, apply: true });
    github.issues.set(9, { ...(await github.getIssue(9)), state: "OPEN", state_reason: null });

    const report = await reconcileGitHubIssues({ runDir: ledger.runDir, manifest, github, apply: true });

    expect(report.issues.find((issue) => issue.number === 9)).toMatchObject({
      action: "skip",
      skip_reason: "previous_brain_hands_close_was_reopened",
      applied: false,
    });
    expect(github.closures).toEqual([
      { number: 9, reason: "not_planned" },
      { number: 14, reason: "not_planned" },
    ]);
  });

  it("advances delivered and human-accepted lineage lifecycle only after a verified default-branch merge", async () => {
    const { ledger, github, lineage: initialLineage } = await cleanupFixture(false);
    const before = await readManifestV2(ledger.runDir);
    const head = "b".repeat(40);
    const deliveredManifest = await updateManifestV2(ledger.runDir, {
      stage: "delivery",
      delivery_state: "ready",
      worktree_path: root!,
      branch_name: "codex/cleanup",
      work_item_progress: { ...before.work_item_progress, integrated: { status: "complete", attempts: 1, commit_sha: head } },
      pull_request_numbers: [33],
      github_ids: { ...before.github_ids, pull_request_numbers: [33], pull_request_urls: { "33": "https://github.com/acme/repo/pull/33" } },
    });
    const lineage = await attachMergedDeliveryAuthority(ledger.runDir, head);
    await recordTerminalDispositionWithCleanup({
      runDir: ledger.runDir,
      disposition: { outcome: "delivered", actor: "runtime", reason: "Ready", residual_risks: [] },
      lineage,
    });
    expect(await readTaskLineage(root!, lineage.lineage_id)).toMatchObject({ state: "delivery_ready" });
    await withTaskLineageTransaction({ repoRoot: root!, lineageId: lineage.lineage_id, operation: (transaction) =>
      transaction.update({ ...transaction.read(), state: "human_accepted" }) });
    const body = reconcileClosingLinksBlock("Merged", initialLineage.lineage_id, deliveredManifest.run_id, [9, 14, 27]);
    github.pullRequest = {
      number: 33,
      url: "https://github.com/acme/repo/pull/33",
      state: "MERGED",
      head_ref: "codex/cleanup",
      head_sha: head,
      base_ref: "main",
      body,
      closing_issue_numbers: [9, 14, 27],
    };
    const manifestPath = join(ledger.runDir, "manifest.json");
    const stale = await readManifestV2(ledger.runDir);
    await writeFile(manifestPath, `${JSON.stringify({ ...stale,
      issue_numbers: [999], work_item_issue_map: { forged: 999 }, pull_request_numbers: [999],
      github_ids: { ...stale.github_ids, issue_numbers: [999], work_item_issue_map: { forged: 999 }, parent_issue_number: 998,
        pull_request_numbers: [999], pull_request_urls: { "999": "https://github.com/other/repo/pull/999" } },
    }, null, 2)}\n`, "utf8");

    await reconcileGitHubIssues({ runDir: ledger.runDir, manifest: await readManifestV2(ledger.runDir), github, apply: true });

    expect(await readTaskLineage(root!, lineage.lineage_id)).toMatchObject({ state: "completed" });
  });

  it("makes the complete cleanup intent visible before the first close and preserves a partial failure", async () => {
    const { ledger, github } = await cleanupFixture();
    github.failNumber = 14;
    github.beforeFirstClose = async () => {
      expect((await readManifestV2(ledger.runDir)).github_cleanup).toMatchObject({
        target_numbers: [9, 14, 27],
        target_states: { "9": "pending", "14": "pending", "27": "pending" },
        state: "pending",
      });
    };

    const report = await reconcileGitHubIssues({
      runDir: ledger.runDir,
      manifest: await readManifestV2(ledger.runDir),
      github,
      apply: true,
    });

    expect(report.cleanup).toMatchObject({ state: "blocked", target_states: { "9": "complete", "14": "blocked", "27": "pending" } });
    expect(github.closures).toEqual([9]);
    expect((await readManifestV2(ledger.runDir)).github_cleanup).toMatchObject({
      state: "blocked",
      target_states: { "9": "complete", "14": "blocked", "27": "pending" },
    });
  });

  it("resumes only incomplete cleanup targets and never shrinks the immutable batch after mirror drift", async () => {
    const { ledger, github } = await cleanupFixture();
    github.failNumber = 14;
    await reconcileGitHubIssues({ runDir: ledger.runDir, manifest: await readManifestV2(ledger.runDir), github, apply: true });
    github.failNumber = null;
    const path = join(ledger.runDir, "manifest.json");
    const drifted = JSON.parse(await readFile(path, "utf8")) as RunManifestV2;
    await (await import("node:fs/promises")).writeFile(path, `${JSON.stringify({
      ...drifted,
      issue_numbers: [14],
      work_item_issue_map: { first: 14 },
      github_ids: { ...drifted.github_ids, issue_numbers: [14], work_item_issue_map: { first: 14 }, parent_issue_number: null },
    }, null, 2)}\n`, "utf8");

    const report = await reconcileGitHubIssues({ runDir: ledger.runDir, manifest: await readManifestV2(ledger.runDir), github, apply: true });

    expect(github.closures).toEqual([9, 14, 27]);
    expect(report.cleanup).toMatchObject({ state: "complete", target_numbers: [9, 14, 27] });
    expect((await readManifestV2(ledger.runDir)).github_cleanup).toMatchObject({ state: "complete", target_numbers: [9, 14, 27] });
  });

  it("previews every pending cleanup closure without mutating GitHub or the batch", async () => {
    const { ledger, github } = await cleanupFixture();

    const report = await reconcileGitHubIssues({ runDir: ledger.runDir, manifest: await readManifestV2(ledger.runDir), github, apply: false });

    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ number: 9, action: "close", reason: "not_planned", applied: false }),
      expect.objectContaining({ number: 14, action: "close", reason: "not_planned", applied: false }),
      expect.objectContaining({ number: 27, action: "close", reason: "not_planned", applied: false }),
    ]));
    expect(github.closures).toEqual([]);
    expect((await readManifestV2(ledger.runDir)).github_cleanup).toMatchObject({ state: "pending", target_states: { "9": "pending", "14": "pending", "27": "pending" } });
  });

  it("recovers a lost close response from a fresh observation and repairs a stale lineage mirror", async () => {
    const { ledger, github, lineage } = await cleanupFixture();
    github.throwAfterCloseNumber = 14;

    const report = await reconcileGitHubIssues({ runDir: ledger.runDir, manifest: await readManifestV2(ledger.runDir), github, apply: true });

    expect(report.cleanup).toMatchObject({ state: "complete" });
    expect(github.closures).toEqual([9, 14, 27]);
    await withTaskLineageTransaction({ repoRoot: root!, lineageId: lineage.lineage_id, operation: (transaction) =>
      transaction.update({ ...transaction.read(), cleanup_state: "blocked" }) });

    await reconcileGitHubIssues({ runDir: ledger.runDir, manifest: await readManifestV2(ledger.runDir), github, apply: true });

    expect(github.closures).toEqual([9, 14, 27]);
    expect(await readTaskLineage(root!, lineage.lineage_id)).toMatchObject({ cleanup_state: "complete" });
  });

  it("blocks on an exact lineage marker mismatch without touching later cleanup targets", async () => {
    const { ledger, github } = await cleanupFixture();
    github.observations.set(14, { ...(await github.getIssue(14)), body: "foreign" });

    const report = await reconcileGitHubIssues({ runDir: ledger.runDir, manifest: await readManifestV2(ledger.runDir), github, apply: true });

    expect(report.cleanup).toMatchObject({ state: "blocked", target_states: { "9": "complete", "14": "blocked", "27": "pending" } });
    expect(github.closures).toEqual([9]);
  });

  it("reconciles the exact not-planned managed label set before completing cleanup", async () => {
    const { ledger, github } = await cleanupFixture();
    github.observations.set(9, {
      ...(await github.getIssue(9)),
      labels: ["brain-hands", "brain-hands:ready", "brain-hands:reviewing", "brain-hands:blocked", "brain-hands:complete"],
    });

    const report = await reconcileGitHubIssues({ runDir: ledger.runDir, manifest: await readManifestV2(ledger.runDir), github, apply: true });

    expect(report.cleanup).toMatchObject({ state: "complete" });
    for (const number of [9, 14, 27]) {
      const managed = (await github.getIssue(number)).labels.filter((label) => label.startsWith("brain-hands:"));
      expect(managed).toEqual(["brain-hands:not-planned"]);
    }
    expect(github.labelEdits.find((edit) => edit.number === 9)).toEqual({
      number: 9,
      add: ["brain-hands:not-planned"],
      remove: ["brain-hands:ready", "brain-hands:reviewing", "brain-hands:blocked", "brain-hands:complete"],
    });
  });

  it("matches managed cleanup labels case-insensitively while preserving unrelated labels", async () => {
    const { ledger, github } = await cleanupFixture();
    github.observations.set(9, {
      ...(await github.getIssue(9)),
      labels: ["Brain-Hands:Ready", "User:Keep"],
    });

    const report = await reconcileGitHubIssues({ runDir: ledger.runDir, manifest: await readManifestV2(ledger.runDir), github, apply: true });

    expect(report.cleanup).toMatchObject({ state: "complete" });
    expect((await github.getIssue(9)).labels).toEqual(expect.arrayContaining(["User:Keep", "brain-hands:not-planned"]));
    expect((await github.getIssue(9)).labels).not.toContain("Brain-Hands:Ready");
  });

  it("keeps cleanup incomplete when terminal label mutation is not observed", async () => {
    const { ledger, github } = await cleanupFixture();
    github.failLabelNumber = 14;

    const report = await reconcileGitHubIssues({ runDir: ledger.runDir, manifest: await readManifestV2(ledger.runDir), github, apply: true });

    expect(report.cleanup).toMatchObject({ state: "blocked", target_states: { "9": "complete", "14": "blocked", "27": "pending" } });
    expect(report.issues.find((issue) => issue.number === 14)).toMatchObject({ skip_reason: "terminal_label_mismatch" });
    expect((await github.getIssue(14)).state).toBe("CLOSED");
    expect((await github.getIssue(14)).labels).not.toContain("brain-hands:not-planned");
  });

  it("recovers a lost terminal-label response only from a fresh exact observation", async () => {
    const { ledger, github } = await cleanupFixture();
    github.throwAfterLabelNumber = 14;

    const report = await reconcileGitHubIssues({ runDir: ledger.runDir, manifest: await readManifestV2(ledger.runDir), github, apply: true });

    expect(report.cleanup).toMatchObject({ state: "complete", target_states: { "14": "complete" } });
    expect((await github.getIssue(14)).labels).toContain("brain-hands:not-planned");
  });

  it.each([
    ["wrong", "<!-- brain-hands-parent:other -->"],
    ["multiple", "<!-- brain-hands-parent:cleanup -->\n<!-- brain-hands-parent:other -->"],
  ])("blocks a parent with %s immutable target markers before remote mutation", async (_caseName, parentMarkers) => {
    const { ledger, github } = await cleanupFixture();
    const parent = await github.getIssue(9);
    github.observations.set(9, {
      ...parent,
      body: `<!-- brain-hands-lineage:${(await readManifestV2(ledger.runDir)).task_lineage_id} -->\n<!-- brain-hands-run:${(await readManifestV2(ledger.runDir)).run_id} -->\n${parentMarkers}`,
    });
    github.issueReads.length = 0;

    const report = await reconcileGitHubIssues({ runDir: ledger.runDir, manifest: await readManifestV2(ledger.runDir), github, apply: true });

    expect(report.cleanup).toMatchObject({ state: "blocked", target_states: { "9": "blocked", "14": "pending", "27": "pending" } });
    expect(github.closures).toEqual([]);
    expect(github.labelEdits).toEqual([]);
  });

  it("rejects repository drift before reading or mutating any issue", async () => {
    const { ledger, github } = await cleanupFixture();
    github.repository = { host: "github.com", name_with_owner: "other/repo", actor: "operator" };
    github.issueReads.length = 0;

    await expect(reconcileGitHubIssues({ runDir: ledger.runDir, manifest: await readManifestV2(ledger.runDir), github, apply: true }))
      .rejects.toThrow(/repository/i);
    expect(github.issueReads).toEqual([]);
    expect(github.closures).toEqual([]);
    expect(github.labelEdits).toEqual([]);
  });

  it("routes a stale pre-terminal snapshot through fresh cleanup authority", async () => {
    const { ledger, github, lineage } = await cleanupFixture(false);
    const stale = await readManifestV2(ledger.runDir);
    await recordTerminalDispositionWithCleanup({
      runDir: ledger.runDir,
      disposition: { outcome: "abandoned", actor: "human", reason: "Stop", residual_risks: [] },
      lineage,
    });
    const defaultBranch = vi.spyOn(github, "getDefaultBranch");

    const report = await reconcileGitHubIssues({ runDir: ledger.runDir, manifest: stale, github, apply: true });

    expect(report.cleanup).toMatchObject({ state: "complete" });
    expect(defaultBranch).not.toHaveBeenCalled();
    expect(github.labelEdits).toHaveLength(3);
  });

  it("does not mutate issues when a merged PR is incompatible with the fresh active lineage", async () => {
    const { ledger, github, lineage } = await cleanupFixture(false);
    const manifest = await readManifestV2(ledger.runDir);
    const head = "b".repeat(40);
    const ready = await updateManifestV2(ledger.runDir, {
      stage: "delivery",
      delivery_state: "ready",
      worktree_path: root!,
      branch_name: "codex/cleanup",
      work_item_progress: { ...manifest.work_item_progress, integrated: { status: "complete", attempts: 1, commit_sha: head } },
      pull_request_numbers: [33],
      github_ids: { ...manifest.github_ids, pull_request_numbers: [33], pull_request_urls: { "33": "https://github.com/acme/repo/pull/33" } },
    });
    await attachMergedDeliveryAuthority(ledger.runDir, head);
    github.pullRequest = {
      number: 33, url: "https://github.com/acme/repo/pull/33", state: "MERGED", head_ref: "codex/cleanup", head_sha: head,
      base_ref: "main", body: reconcileClosingLinksBlock("Merged", lineage.lineage_id, ready.run_id, [9, 14, 27]), closing_issue_numbers: [9, 14, 27],
    };

    await expect(reconcileGitHubIssues({ runDir: ledger.runDir, manifest: ready, github, apply: true }))
      .rejects.toThrow(/active|completed|transition/i);
    expect(github.closures).toEqual([]);
    expect(github.labelEdits).toEqual([]);
    expect(await readTaskLineage(root!, lineage.lineage_id)).toMatchObject({ state: "active" });
  });

  it("does not complete authoritative lineage from a merged PR with extra closing links", async () => {
    const { ledger, github, lineage } = await cleanupFixture(false);
    const manifest = await readManifestV2(ledger.runDir);
    const head = "c".repeat(40);
    const ready = await updateManifestV2(ledger.runDir, {
      stage: "delivery",
      delivery_state: "ready",
      worktree_path: root!,
      branch_name: "codex/cleanup",
      work_item_progress: { ...manifest.work_item_progress, integrated: { status: "complete", attempts: 1, commit_sha: head } },
      pull_request_numbers: [33],
      github_ids: { ...manifest.github_ids, pull_request_numbers: [33], pull_request_urls: { "33": "https://github.com/acme/repo/pull/33" } },
    });
    await attachMergedDeliveryAuthority(ledger.runDir, head);
    github.pullRequest = {
      number: 33, url: "https://github.com/acme/repo/pull/33", state: "MERGED", head_ref: "codex/cleanup", head_sha: head,
      base_ref: "main", body: reconcileClosingLinksBlock("Merged", lineage.lineage_id, ready.run_id, [9, 14, 27]), closing_issue_numbers: [9, 14, 27, 99],
    };

    const report = await reconcileGitHubIssues({ runDir: ledger.runDir, manifest: ready, github, apply: true });

    expect(report.pull_request).toMatchObject({ identity_verified: true, managed_links_verified: false });
    expect(report.issues.every((issue) => issue.action === "keep_open")).toBe(true);
    expect(github.closures).toEqual([]);
    expect(github.labelEdits).toEqual([]);
    expect(await readTaskLineage(root!, lineage.lineage_id)).toMatchObject({ state: "active" });
  });

  it("rejects a lineage-terminal mirror prefix before any adapter read", async () => {
    const { ledger, github, lineage } = await cleanupFixture(false);
    await withTaskLineageTransaction({ repoRoot: root!, lineageId: lineage.lineage_id, operation: (transaction) =>
      transaction.update({ ...transaction.read(), state: "delivery_ready" }) });
    github.issueReads.length = 0;
    const repository = vi.spyOn(github, "getRepositoryIdentity");

    await expect(reconcileGitHubIssues({ runDir: ledger.runDir, manifest: await readManifestV2(ledger.runDir), github, apply: true }))
      .rejects.toThrow(/delivery.ready|terminal|mirror/i);
    expect(repository).not.toHaveBeenCalled();
    expect(github.issueReads).toEqual([]);
    expect(github.closures).toEqual([]);
  });
});
