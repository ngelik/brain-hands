import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRunLedgerV2, readManifestV2, recordPlan, transitionRun, updateManifestV2, approvePlanRevision } from "../../src/core/ledger.js";
import { readTaskLineage, withTaskLineageTransaction } from "../../src/core/task-lineage.js";
import { applyDeliveryEffectPreview, openIntegratedPullRequestThroughDeliveryGateway, prepareDeliveryEffectBoundary } from "../../src/workflow/github-delivery-effects.js";
import { planIssueSyncPreview, planPullRequestDeliveryPreview, writeGithubEffectPreview, type PullRequestDeliveryPlanningInput } from "../../src/github/effect-plan.js";

let root: string | null = null;
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = null; });

async function readyBoundary() {
  root = await mkdtemp(join(tmpdir(), "brain-hands-delivery-effects-"));
  const ledger = await createRunLedgerV2({ repoRoot: root, originalRequest: "ship", mode: "github", branchName: "codex/ship", worktreePath: root });
  await updateManifestV2(ledger.runDir, { workflow_protocol: "legacy-v2" });
  await transitionRun(ledger.runDir, "preflight");
  await transitionRun(ledger.runDir, "brain_planning");
  await recordPlan(ledger.runDir, `${JSON.stringify({ summary: "ship", assumptions: [], research: [], research_sources: ["repo"], architecture: "small", risks: [], work_items: [], integration_verification: [] })}\n`);
  await transitionRun(ledger.runDir, "awaiting_plan_approval");
  await approvePlanRevision(ledger.runDir, 1, { actor: "test" });
  await transitionRun(ledger.runDir, "worktree_setup");
  await transitionRun(ledger.runDir, "implementing");
  await transitionRun(ledger.runDir, "verifying");
  await transitionRun(ledger.runDir, "verifier_review");
  await transitionRun(ledger.runDir, "final_verification");
  const approved = await readManifestV2(ledger.runDir);
  const planSha = approved.plan_revisions["1"]!.sha256;
  const desired = {
    title: "Feature", body: "<!-- brain-hands-managed:start -->\nFeature\n<!-- brain-hands-managed:end -->\n",
    labels: ["brain-hands"], state: "OPEN" as const, state_reason: null, reason_code: "approved-plan-work-item",
  };
  const issuePreview = planIssueSyncPreview({
    revision: 1, lineage_id: approved.task_lineage_id!, run_id: approved.run_id,
    repository: { host: "github.com", name_with_owner: "acme/repo" },
    plan_revision: 1, plan_sha256: planSha, created_at: "2026-07-16T11:00:00.000Z", lineage_state: "active",
    issue_set: { state: "uninitialized", plan_revision: null, plan_sha256: null, parent_issue_number: null, work_item_issue_map: {}, has_prior_owned_state: false },
    approved_replan: false, parent: null,
    work_items: [{ work_item_id: "feature", desired, observations: [] }],
  });
  const written = await writeGithubEffectPreview({ run_dir: ledger.runDir, preview: issuePreview });
  const ref = { ...written, state: "applied" as const };
  const effect = issuePreview.effects[0]!;
  await updateManifestV2(ledger.runDir, {
    issue_numbers: [17], work_item_issue_map: { feature: 17 },
    github_ids: { ...approved.github_ids, issue_numbers: [17], work_item_issue_map: { feature: 17 } },
    github_effects: { ...approved.github_effects, issue_sync: ref },
  });
  await withTaskLineageTransaction({ repoRoot: root, lineageId: approved.task_lineage_id!, operation: (transaction) => {
    const lineage = transaction.read();
    return transaction.update({ ...lineage, repository_key: "github.com/acme/repo", issue_set: {
      ...lineage.issue_set, state: "ready", plan_revision: 1, plan_sha256: planSha,
      work_item_issue_map: { feature: 17 }, preview: ref,
      operations: { [effect.effect_id]: {
        operation_id: effect.effect_id, target_key: "work_item:feature", desired_sha256: effect.desired_sha256,
        state: "complete", issue_number: 17, created_by_run_id: approved.run_id,
      } },
    } });
  } });
  return { ledger, manifest: await readManifestV2(ledger.runDir), lineage: await readTaskLineage(root, approved.task_lineage_id!), planSha };
}

function planning(input: Awaited<ReturnType<typeof readyBoundary>>, remote: string | null = null): PullRequestDeliveryPlanningInput {
  return {
    revision: 1, lineage_id: input.lineage.lineage_id, run_id: input.manifest.run_id,
    repository: { host: "github.com", name_with_owner: "acme/repo" },
    plan_revision: 1, plan_sha256: input.planSha, created_at: "2026-07-16T12:00:00.000Z", lineage_state: "active",
    authorized_prior_head_sha: input.lineage.delivery.head_sha,
    branch: { branch_name: "codex/ship", head_sha: "b".repeat(40), observed_head_sha: remote, reason_code: "verified-delivery-head" },
    pull_request: { desired: {
      title: "Task: ship", body: "ship\n\n<!-- brain-hands:issue-links lineage=" + input.lineage.lineage_id + " run=" + input.manifest.run_id + " schema=1 -->\nCloses #17\n<!-- /brain-hands:issue-links -->",
      head_ref: "codex/ship", head_sha: "b".repeat(40), base_ref: "main", closing_issue_numbers: [17], reason_code: "verified-delivery",
    }, observations: [] },
  };
}

describe("GitHub delivery effect boundary", () => {
  it("owns the integrated pull-request adapter mutation", async () => {
    const openIntegratedPullRequest = vi.fn(async () => ({ number: 7, url: "https://github.com/acme/repo/pull/7" }));
    const input = {
      lineageId: "946c7414-d500-4e65-a596-dcf99f0015c2",
      runId: "run-1",
      title: "Task: ship",
      summary: "ship",
      head: "codex/ship",
      headSha: "a".repeat(40),
      base: "main",
      workItems: [{ id: "feature", issueNumber: 17 }],
    };

    await expect(openIntegratedPullRequestThroughDeliveryGateway({ openIntegratedPullRequest } as never, input))
      .resolves.toEqual({ number: 7, url: "https://github.com/acme/repo/pull/7" });
    expect(openIntegratedPullRequest).toHaveBeenCalledWith(input);
  });

  it("persists the canonical preview and stops at the exact awaiting stage", async () => {
    const setup = await readyBoundary();
    const preview = await prepareDeliveryEffectBoundary({ runDir: setup.ledger.runDir, repoRoot: root!, planning: planning(setup), manifest: setup.manifest, lineage: setup.lineage });
    expect(preview.effects.map((effect) => effect.action)).toEqual(["push", "open"]);
    expect(await readManifestV2(setup.ledger.runDir)).toMatchObject({
      stage: "awaiting_github_delivery_effects",
      github_effects: { pull_request_delivery: { revision: 1, state: "previewed" } },
    });
  });

  it("recovers an artifact-only initial preview with its original immutable bytes", async () => {
    const setup = await readyBoundary();
    const first = planning(setup);
    await expect(prepareDeliveryEffectBoundary({
      runDir: setup.ledger.runDir, repoRoot: root!, planning: first, manifest: setup.manifest, lineage: setup.lineage,
      afterArtifactPersisted: async () => { throw new Error("artifact failpoint"); },
    })).rejects.toThrow("artifact failpoint");
    const recovered = await prepareDeliveryEffectBoundary({
      runDir: setup.ledger.runDir, repoRoot: root!, planning: { ...first, created_at: "2026-07-16T13:00:00.000Z" },
      manifest: await readManifestV2(setup.ledger.runDir), lineage: await readTaskLineage(root!, setup.lineage.lineage_id),
    });
    expect(recovered.created_at).toBe(first.created_at);
    expect(await readManifestV2(setup.ledger.runDir)).toMatchObject({ stage: "awaiting_github_delivery_effects", github_effects: { pull_request_delivery: { revision: 1 } } });
  });

  it("attaches an artifact-only initial preview before evaluating newer observations", async () => {
    const setup = await readyBoundary();
    const original = planning(setup);
    await expect(prepareDeliveryEffectBoundary({
      runDir: setup.ledger.runDir, repoRoot: root!, planning: original, manifest: setup.manifest, lineage: setup.lineage,
      afterArtifactPersisted: async () => { throw new Error("artifact failpoint"); },
    })).rejects.toThrow("artifact failpoint");
    const changed = planning(setup, "c".repeat(40));
    const recovered = await prepareDeliveryEffectBoundary({
      runDir: setup.ledger.runDir, repoRoot: root!, planning: changed,
      manifest: await readManifestV2(setup.ledger.runDir), lineage: await readTaskLineage(root!, setup.lineage.lineage_id),
    });
    expect(recovered).toMatchObject({ revision: 1, observation_sha256: expect.any(String) });
    expect(recovered.observation_sha256).not.toBe(planPullRequestDeliveryPreview(changed).observation_sha256);
    const result = await applyDeliveryEffectPreview({
      runDir: setup.ledger.runDir, repoRoot: root!, worktreePath: root!, preview: recovered,
      planning: { ...changed, branch: { branch_name: changed.branch.branch_name, head_sha: changed.branch.head_sha, reason_code: changed.branch.reason_code }, pull_request: { desired: changed.pull_request.desired } },
      localHead: async () => "b".repeat(40), remoteHead: async () => "c".repeat(40), observePullRequests: async () => [],
      pushCommitToBranch: vi.fn(), openPullRequest: vi.fn(), updatePullRequestBody: vi.fn(), getPullRequest: vi.fn(),
    });
    expect(result).toMatchObject({ outcome: "replacement_preview", preview: { revision: 2 } });
  });

  it("recovers an initial lineage-only preview prefix into the run manifest and awaiting stage", async () => {
    const setup = await readyBoundary();
    const plan = planning(setup);
    await expect(prepareDeliveryEffectBoundary({
      runDir: setup.ledger.runDir, repoRoot: root!, planning: plan, manifest: setup.manifest, lineage: setup.lineage,
      afterLineagePersisted: async () => { throw new Error("lineage prefix failpoint"); },
    })).rejects.toThrow("lineage prefix failpoint");
    expect((await readTaskLineage(root!, setup.lineage.lineage_id)).delivery.preview).toMatchObject({ revision: 1, state: "previewed" });
    expect((await readManifestV2(setup.ledger.runDir)).github_effects.pull_request_delivery).toBeNull();
    await expect(prepareDeliveryEffectBoundary({
      runDir: setup.ledger.runDir, repoRoot: root!, planning: plan,
      manifest: await readManifestV2(setup.ledger.runDir), lineage: await readTaskLineage(root!, setup.lineage.lineage_id),
    })).resolves.toMatchObject({ revision: 1 });
    expect(await readManifestV2(setup.ledger.runDir)).toMatchObject({
      stage: "awaiting_github_delivery_effects", github_effects: { pull_request_delivery: { revision: 1, state: "previewed" } },
    });
  });

  it("recovers the closest corrupt manifest-only initial prefix by attaching its exact artifact to lineage", async () => {
    const setup = await readyBoundary();
    const plan = planning(setup);
    await expect(prepareDeliveryEffectBoundary({
      runDir: setup.ledger.runDir, repoRoot: root!, planning: plan, manifest: setup.manifest, lineage: setup.lineage,
      afterArtifactPersisted: async () => { throw new Error("artifact failpoint"); },
    })).rejects.toThrow("artifact failpoint");
    const reference = await writeGithubEffectPreview({ run_dir: setup.ledger.runDir, preview: planPullRequestDeliveryPreview(plan) });
    const current = await readManifestV2(setup.ledger.runDir);
    await updateManifestV2(setup.ledger.runDir, {
      github_effects: { ...current.github_effects, pull_request_delivery: reference }, delivery_state: "pending",
    });
    await transitionRun(setup.ledger.runDir, "awaiting_github_delivery_effects");
    expect((await readTaskLineage(root!, setup.lineage.lineage_id)).delivery.preview).toBeNull();
    await expect(prepareDeliveryEffectBoundary({
      runDir: setup.ledger.runDir, repoRoot: root!, planning: plan,
      manifest: await readManifestV2(setup.ledger.runDir), lineage: await readTaskLineage(root!, setup.lineage.lineage_id),
    })).resolves.toMatchObject({ revision: 1 });
    expect((await readTaskLineage(root!, setup.lineage.lineage_id)).delivery.preview).toMatchObject({ revision: 1, state: "previewed" });
  });

  it("pushes only through the exact lease, opens once, and repairs a lineage-first crash by replay", async () => {
    const setup = await readyBoundary();
    const plan = planning(setup);
    const preview = await prepareDeliveryEffectBoundary({ runDir: setup.ledger.runDir, repoRoot: root!, planning: plan, manifest: setup.manifest, lineage: setup.lineage });
    let remote: string | null = null;
    let observed: any[] = [];
    const push = vi.fn(async (_path: string, sha: string, branch: string, lease: string | null) => { expect([sha, branch, lease]).toEqual(["b".repeat(40), "codex/ship", null]); remote = sha; return "pushed"; });
    const open = vi.fn(async (desired: typeof plan.pull_request.desired) => {
      const reference = { number: 42, url: "https://github.com/acme/repo/pull/42", title: desired.title, body: desired.body,
        head_ref: desired.head_ref, head_sha: desired.head_sha, base_ref: desired.base_ref,
        closing_issue_numbers: desired.closing_issue_numbers, state: "OPEN" as const };
      observed = [reference];
      return reference;
    });
    const apply = () => applyDeliveryEffectPreview({
      runDir: setup.ledger.runDir, repoRoot: root!, worktreePath: root!, preview,
      planning: { ...plan, branch: { branch_name: plan.branch.branch_name, head_sha: plan.branch.head_sha, reason_code: plan.branch.reason_code }, pull_request: { desired: plan.pull_request.desired } },
      localHead: async () => "b".repeat(40), remoteHead: async () => remote,
      observePullRequests: async () => observed,
      pushCommitToBranch: push, openPullRequest: open, updatePullRequestBody: vi.fn(),
      getPullRequest: async () => observed[0],
    });
    await expect(apply()).resolves.toMatchObject({ outcome: "applied", pull_request: { number: 42 } });
    await expect(apply()).resolves.toMatchObject({ outcome: "applied", pull_request: { number: 42 } });
    expect(push).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("writes N+1 and performs zero mutation when the remote lease observation drifts", async () => {
    const setup = await readyBoundary();
    const plan = planning(setup, "c".repeat(40));
    const preview = await prepareDeliveryEffectBoundary({ runDir: setup.ledger.runDir, repoRoot: root!, planning: plan, manifest: setup.manifest, lineage: setup.lineage });
    const push = vi.fn();
    const open = vi.fn();
    const result = await applyDeliveryEffectPreview({
      runDir: setup.ledger.runDir, repoRoot: root!, worktreePath: root!, preview,
      planning: { ...plan, branch: { branch_name: plan.branch.branch_name, head_sha: plan.branch.head_sha, reason_code: plan.branch.reason_code }, pull_request: { desired: plan.pull_request.desired } },
      localHead: async () => "b".repeat(40), remoteHead: async () => "d".repeat(40), observePullRequests: async () => [],
      pushCommitToBranch: push, openPullRequest: open, updatePullRequestBody: vi.fn(), getPullRequest: vi.fn(),
    });
    expect(result).toMatchObject({ outcome: "replacement_preview", preview: { revision: 2 } });
    expect(push).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(await readManifestV2(setup.ledger.runDir)).toMatchObject({ github_effects: { pull_request_delivery: { revision: 2, state: "previewed" } } });
  });

  it("recovers an artifact-only N+1 replacement without producing N+2", async () => {
    const setup = await readyBoundary();
    const plan = planning(setup, "c".repeat(40));
    const preview = await prepareDeliveryEffectBoundary({ runDir: setup.ledger.runDir, repoRoot: root!, planning: plan, manifest: setup.manifest, lineage: setup.lineage });
    let fail = true;
    const apply = () => applyDeliveryEffectPreview({
      runDir: setup.ledger.runDir, repoRoot: root!, worktreePath: root!, preview,
      planning: { ...plan, branch: { branch_name: plan.branch.branch_name, head_sha: plan.branch.head_sha, reason_code: plan.branch.reason_code }, pull_request: { desired: plan.pull_request.desired } },
      localHead: async () => "b".repeat(40), remoteHead: async () => "d".repeat(40), observePullRequests: async () => [],
      pushCommitToBranch: vi.fn(), openPullRequest: vi.fn(), updatePullRequestBody: vi.fn(), getPullRequest: vi.fn(),
      hooks: { afterReplacementArtifact: async () => { if (fail) { fail = false; throw new Error("replacement artifact failpoint"); } } },
    });
    await expect(apply()).rejects.toThrow("replacement artifact failpoint");
    const recovered = await apply();
    expect(recovered).toMatchObject({ outcome: "replacement_preview", preview: { revision: 2 } });
    expect((await readManifestV2(setup.ledger.runDir)).github_effects.pull_request_delivery).toMatchObject({ revision: 2, state: "previewed" });
  });

  it("attaches artifact-only N+1 before newer drift creates N+2", async () => {
    const setup = await readyBoundary();
    const plan = planning(setup, "c".repeat(40));
    const preview = await prepareDeliveryEffectBoundary({ runDir: setup.ledger.runDir, repoRoot: root!, planning: plan, manifest: setup.manifest, lineage: setup.lineage });
    let remote = "d".repeat(40);
    let fail = true;
    const apply = (currentPreview: typeof preview) => applyDeliveryEffectPreview({
      runDir: setup.ledger.runDir, repoRoot: root!, worktreePath: root!, preview: currentPreview,
      planning: { ...plan, branch: { branch_name: plan.branch.branch_name, head_sha: plan.branch.head_sha, reason_code: plan.branch.reason_code }, pull_request: { desired: plan.pull_request.desired } },
      localHead: async () => "b".repeat(40), remoteHead: async () => remote, observePullRequests: async () => [],
      pushCommitToBranch: vi.fn(), openPullRequest: vi.fn(), updatePullRequestBody: vi.fn(), getPullRequest: vi.fn(),
      hooks: { afterReplacementArtifact: async () => { if (fail) { fail = false; throw new Error("replacement artifact failpoint"); } } },
    });
    await expect(apply(preview)).rejects.toThrow("replacement artifact failpoint");
    remote = "e".repeat(40);
    const attached = await apply(preview);
    expect(attached).toMatchObject({ outcome: "replacement_preview", preview: { revision: 2 } });
    const next = await apply(attached.outcome === "replacement_preview" ? attached.preview : preview);
    expect(next).toMatchObject({ outcome: "replacement_preview", preview: { revision: 3 } });
  });

  it("repairs split N+1 lineage and manifest references without producing N+2", async () => {
    const setup = await readyBoundary();
    const plan = planning(setup, "c".repeat(40));
    const preview = await prepareDeliveryEffectBoundary({ runDir: setup.ledger.runDir, repoRoot: root!, planning: plan, manifest: setup.manifest, lineage: setup.lineage });
    let fail = true;
    const apply = () => applyDeliveryEffectPreview({
      runDir: setup.ledger.runDir, repoRoot: root!, worktreePath: root!, preview,
      planning: { ...plan, branch: { branch_name: plan.branch.branch_name, head_sha: plan.branch.head_sha, reason_code: plan.branch.reason_code }, pull_request: { desired: plan.pull_request.desired } },
      localHead: async () => "b".repeat(40), remoteHead: async () => "d".repeat(40), observePullRequests: async () => [],
      pushCommitToBranch: vi.fn(), openPullRequest: vi.fn(), updatePullRequestBody: vi.fn(), getPullRequest: vi.fn(),
      hooks: { afterReplacementLineage: async () => { if (fail) { fail = false; throw new Error("replacement lineage failpoint"); } } },
    });
    await expect(apply()).rejects.toThrow("replacement lineage failpoint");
    expect((await readTaskLineage(root!, setup.lineage.lineage_id)).delivery.preview).toMatchObject({ revision: 2, state: "previewed" });
    expect((await readManifestV2(setup.ledger.runDir)).github_effects.pull_request_delivery).toMatchObject({ revision: 1, state: "invalidated" });
    await expect(apply()).resolves.toMatchObject({ outcome: "replacement_preview", preview: { revision: 2 } });
    expect((await readManifestV2(setup.ledger.runDir)).github_effects.pull_request_delivery).toMatchObject({ revision: 2, state: "previewed" });
  });

  it("passes a non-null expected remote head to the exact push lease", async () => {
    const setup = await readyBoundary();
    const expectedRemote = "c".repeat(40);
    const plan = planning(setup, expectedRemote);
    const preview = await prepareDeliveryEffectBoundary({ runDir: setup.ledger.runDir, repoRoot: root!, planning: plan, manifest: setup.manifest, lineage: setup.lineage });
    let remote: string | null = expectedRemote;
    let observed: any[] = [];
    const push = vi.fn(async (_path: string, sha: string, branch: string, lease: string | null) => {
      expect([sha, branch, lease]).toEqual(["b".repeat(40), "codex/ship", expectedRemote]);
      remote = sha;
      return "pushed";
    });
    const open = vi.fn(async (desired: typeof plan.pull_request.desired) => {
      const value = { number: 46, url: "https://github.com/acme/repo/pull/46", title: desired.title, body: desired.body,
        head_ref: desired.head_ref, head_sha: desired.head_sha, base_ref: desired.base_ref,
        closing_issue_numbers: [17], state: "OPEN" as const };
      observed = [value];
      return value;
    });
    await expect(applyDeliveryEffectPreview({
      runDir: setup.ledger.runDir, repoRoot: root!, worktreePath: root!, preview,
      planning: { ...plan, branch: { branch_name: plan.branch.branch_name, head_sha: plan.branch.head_sha, reason_code: plan.branch.reason_code }, pull_request: { desired: plan.pull_request.desired } },
      localHead: async () => "b".repeat(40), remoteHead: async () => remote, observePullRequests: async () => observed,
      pushCommitToBranch: push, openPullRequest: open, updatePullRequestBody: vi.fn(), getPullRequest: async () => observed[0],
    })).resolves.toMatchObject({ outcome: "applied", pull_request: { number: 46 } });
    expect(push).toHaveBeenCalledOnce();
  });

  it("rejects an ambiguous push when the exact local head is not observable", async () => {
    const setup = await readyBoundary();
    const plan = planning(setup);
    const preview = await prepareDeliveryEffectBoundary({ runDir: setup.ledger.runDir, repoRoot: root!, planning: plan, manifest: setup.manifest, lineage: setup.lineage });
    const push = vi.fn(async (): Promise<string> => { throw new Error("push response lost"); });
    const open = vi.fn();
    await expect(applyDeliveryEffectPreview({
      runDir: setup.ledger.runDir, repoRoot: root!, worktreePath: root!, preview,
      planning: { ...plan, branch: { branch_name: plan.branch.branch_name, head_sha: plan.branch.head_sha, reason_code: plan.branch.reason_code }, pull_request: { desired: plan.pull_request.desired } },
      localHead: async () => "b".repeat(40), remoteHead: async () => null, observePullRequests: async () => [],
      pushCommitToBranch: push, openPullRequest: open, updatePullRequestBody: vi.fn(), getPullRequest: vi.fn(),
    })).rejects.toThrow("push response lost");
    expect(open).not.toHaveBeenCalled();
  });

  it("recovers an ambiguous push error only when the remote reaches the exact local head", async () => {
    const setup = await readyBoundary();
    const plan = planning(setup);
    const preview = await prepareDeliveryEffectBoundary({ runDir: setup.ledger.runDir, repoRoot: root!, planning: plan, manifest: setup.manifest, lineage: setup.lineage });
    let remote: string | null = null;
    let observed: any[] = [];
    const push = vi.fn(async (): Promise<string> => { remote = "b".repeat(40); throw new Error("response lost"); });
    const open = vi.fn(async (desired: typeof plan.pull_request.desired) => {
      const value = { number: 43, url: "https://github.com/acme/repo/pull/43", title: desired.title, body: desired.body,
        head_ref: desired.head_ref, head_sha: desired.head_sha, base_ref: desired.base_ref,
        closing_issue_numbers: [17], state: "OPEN" as const };
      observed = [value]; return value;
    });
    await expect(applyDeliveryEffectPreview({
      runDir: setup.ledger.runDir, repoRoot: root!, worktreePath: root!, preview,
      planning: { ...plan, branch: { branch_name: plan.branch.branch_name, head_sha: plan.branch.head_sha, reason_code: plan.branch.reason_code }, pull_request: { desired: plan.pull_request.desired } },
      localHead: async () => "b".repeat(40), remoteHead: async () => remote, observePullRequests: async () => observed,
      pushCommitToBranch: push, openPullRequest: open, updatePullRequestBody: vi.fn(), getPullRequest: async () => observed[0],
    })).resolves.toMatchObject({ outcome: "applied", pull_request: { number: 43 } });
    expect(push).toHaveBeenCalledTimes(1);
  });

  it("rejects a broken applied issue-set operation before any remote mutation", async () => {
    const setup = await readyBoundary();
    const plan = planning(setup);
    const preview = await prepareDeliveryEffectBoundary({ runDir: setup.ledger.runDir, repoRoot: root!, planning: plan, manifest: setup.manifest, lineage: setup.lineage });
    await withTaskLineageTransaction({ repoRoot: root!, lineageId: setup.lineage.lineage_id, operation: (transaction) => {
      const lineage = transaction.read();
      return transaction.update({ ...lineage, issue_set: { ...lineage.issue_set, operations: {} } });
    } });
    const push = vi.fn();
    const open = vi.fn();
    await expect(applyDeliveryEffectPreview({
      runDir: setup.ledger.runDir, repoRoot: root!, worktreePath: root!, preview,
      planning: { ...plan, branch: { branch_name: plan.branch.branch_name, head_sha: plan.branch.head_sha, reason_code: plan.branch.reason_code }, pull_request: { desired: plan.pull_request.desired } },
      localHead: async () => "b".repeat(40), remoteHead: async () => null, observePullRequests: async () => [],
      pushCommitToBranch: push, openPullRequest: open, updatePullRequestBody: vi.fn(), getPullRequest: vi.fn(),
    })).rejects.toThrow("inconsistent operation or mapping");
    expect(push).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it.each(["repository", "run", "lineage", "plan"] as const)("rejects a stale %s authority before adapter observation", async (kind) => {
    const setup = await readyBoundary();
    const plan = planning(setup);
    const preview = await prepareDeliveryEffectBoundary({ runDir: setup.ledger.runDir, repoRoot: root!, planning: plan, manifest: setup.manifest, lineage: setup.lineage });
    let currentPlan = plan;
    if (kind === "repository") currentPlan = { ...plan, repository: { ...plan.repository, name_with_owner: "other/repo" } };
    if (kind === "run") currentPlan = { ...plan, run_id: "other-run" };
    if (kind === "lineage") currentPlan = { ...plan, lineage_id: "11111111-1111-4111-8111-111111111111" };
    if (kind === "plan") {
      const manifest = await readManifestV2(setup.ledger.runDir);
      const replacementSha = "f".repeat(64);
      await updateManifestV2(setup.ledger.runDir, {
        current_plan_revision: 2, approved_plan_revision: 2,
        plan_revisions: { ...manifest.plan_revisions, "2": { ...manifest.plan_revisions["1"]!, revision: 2, sha256: replacementSha } },
      });
      currentPlan = { ...plan, plan_revision: 2, plan_sha256: replacementSha };
    }
    const localHead = vi.fn(async () => "b".repeat(40));
    const remoteHead = vi.fn(async () => null);
    const observePullRequests = vi.fn(async () => []);
    const push = vi.fn();
    const open = vi.fn();
    await expect(applyDeliveryEffectPreview({
      runDir: setup.ledger.runDir, repoRoot: root!, worktreePath: root!, preview,
      planning: { ...currentPlan, branch: { branch_name: currentPlan.branch.branch_name, head_sha: currentPlan.branch.head_sha, reason_code: currentPlan.branch.reason_code }, pull_request: { desired: currentPlan.pull_request.desired } },
      localHead, remoteHead, observePullRequests, pushCommitToBranch: push, openPullRequest: open,
      updatePullRequestBody: vi.fn(), getPullRequest: vi.fn(),
    })).rejects.toThrow(/bound|authority|plan|repository|run/i);
    expect(localHead).not.toHaveBeenCalled();
    expect(remoteHead).not.toHaveBeenCalled();
    expect(observePullRequests).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it("turns a legitimate local HEAD change after preview into N+1 without remote mutation", async () => {
    const setup = await readyBoundary();
    const original = planning(setup);
    const preview = await prepareDeliveryEffectBoundary({ runDir: setup.ledger.runDir, repoRoot: root!, planning: original, manifest: setup.manifest, lineage: setup.lineage });
    const nextHead = "c".repeat(40);
    const changed = {
      ...original,
      branch: { ...original.branch, head_sha: nextHead },
      pull_request: { ...original.pull_request, desired: { ...original.pull_request.desired, head_sha: nextHead } },
    };
    const push = vi.fn(); const open = vi.fn(); const update = vi.fn();
    await expect(applyDeliveryEffectPreview({
      runDir: setup.ledger.runDir, repoRoot: root!, worktreePath: root!, preview,
      planning: { ...changed, branch: { branch_name: changed.branch.branch_name, head_sha: nextHead, reason_code: changed.branch.reason_code }, pull_request: { desired: changed.pull_request.desired } },
      localHead: async () => nextHead, remoteHead: async () => null, observePullRequests: async () => [],
      pushCommitToBranch: push, openPullRequest: open, updatePullRequestBody: update, getPullRequest: vi.fn(),
    })).resolves.toMatchObject({ outcome: "replacement_preview", preview: { revision: 2 } });
    expect(push).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled(); expect(update).not.toHaveBeenCalled();
  });

  it("rejects a forged prior delivery head before every local or remote callback", async () => {
    const setup = await readyBoundary();
    const original = planning(setup);
    const preview = await prepareDeliveryEffectBoundary({ runDir: setup.ledger.runDir, repoRoot: root!, planning: original, manifest: setup.manifest, lineage: setup.lineage });
    const localHead = vi.fn(async () => original.branch.head_sha);
    const remoteHead = vi.fn(async () => null);
    const observePullRequests = vi.fn(async () => []);
    const push = vi.fn(); const open = vi.fn(); const update = vi.fn();
    await expect(applyDeliveryEffectPreview({
      runDir: setup.ledger.runDir, repoRoot: root!, worktreePath: root!, preview,
      planning: {
        ...original,
        authorized_prior_head_sha: "a".repeat(40),
        branch: { branch_name: original.branch.branch_name, head_sha: original.branch.head_sha, reason_code: original.branch.reason_code },
        pull_request: { desired: original.pull_request.desired },
      },
      localHead, remoteHead, observePullRequests, pushCommitToBranch: push,
      openPullRequest: open, updatePullRequestBody: update, getPullRequest: vi.fn(),
    })).rejects.toThrow(/bound|authority|planning/i);
    expect(localHead).not.toHaveBeenCalled(); expect(remoteHead).not.toHaveBeenCalled();
    expect(observePullRequests).not.toHaveBeenCalled(); expect(push).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled(); expect(update).not.toHaveBeenCalled();
  });

  it("rejects forged prepare authority before writing or attaching an artifact", async () => {
    const setup = await readyBoundary();
    const forged = { ...planning(setup), authorized_prior_head_sha: "a".repeat(40) };
    const afterArtifactPersisted = vi.fn();
    await expect(prepareDeliveryEffectBoundary({
      runDir: setup.ledger.runDir, repoRoot: root!, planning: forged,
      manifest: setup.manifest, lineage: setup.lineage, afterArtifactPersisted,
    })).rejects.toThrow(/bound|authority|planning/i);
    expect(afterArtifactPersisted).not.toHaveBeenCalled();
    await expect(readFile(join(setup.ledger.runDir, "github-effects/pull-request-delivery/revision-1.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readManifestV2(setup.ledger.runDir)).github_effects.pull_request_delivery).toBeNull();
    expect((await readTaskLineage(root!, setup.lineage.lineage_id)).delivery.preview).toBeNull();
  });

  it("rejects omitted apply authority before every callback", async () => {
    const setup = await readyBoundary();
    const original = planning(setup);
    const preview = await prepareDeliveryEffectBoundary({ runDir: setup.ledger.runDir, repoRoot: root!, planning: original, manifest: setup.manifest, lineage: setup.lineage });
    const localHead = vi.fn(); const remoteHead = vi.fn(); const observePullRequests = vi.fn();
    const { authorized_prior_head_sha: _omitted, ...omitted } = original;
    await expect(applyDeliveryEffectPreview({
      runDir: setup.ledger.runDir, repoRoot: root!, worktreePath: root!, preview,
      planning: { ...omitted, branch: { branch_name: omitted.branch.branch_name, head_sha: omitted.branch.head_sha, reason_code: omitted.branch.reason_code }, pull_request: { desired: omitted.pull_request.desired } },
      localHead, remoteHead, observePullRequests, pushCommitToBranch: vi.fn(), openPullRequest: vi.fn(), updatePullRequestBody: vi.fn(), getPullRequest: vi.fn(),
    })).rejects.toThrow(/bound|authority|planning/i);
    expect(localHead).not.toHaveBeenCalled(); expect(remoteHead).not.toHaveBeenCalled(); expect(observePullRequests).not.toHaveBeenCalled();
  });

  it("refuses to attach an orphan artifact with forged prior-head authority", async () => {
    const setup = await readyBoundary();
    const legitimate = planning(setup);
    const forged = planPullRequestDeliveryPreview({ ...legitimate, authorized_prior_head_sha: "a".repeat(40) });
    await writeGithubEffectPreview({ run_dir: setup.ledger.runDir, preview: forged });
    await expect(prepareDeliveryEffectBoundary({
      runDir: setup.ledger.runDir, repoRoot: root!, planning: legitimate, manifest: setup.manifest, lineage: setup.lineage,
    })).rejects.toThrow(/unauthorized prior-head authority/i);
    expect((await readManifestV2(setup.ledger.runDir)).github_effects.pull_request_delivery).toBeNull();
    expect((await readTaskLineage(root!, setup.lineage.lineage_id)).delivery.preview).toBeNull();
  });

  it("turns preserved user text added after preview into N+1 without editing the PR", async () => {
    const setup = await readyBoundary();
    const original = planning(setup, "b".repeat(40));
    const observed = { number: 49, url: "https://github.com/acme/repo/pull/49", title: original.pull_request.desired.title,
      body: original.pull_request.desired.body, head_ref: original.pull_request.desired.head_ref, head_sha: original.pull_request.desired.head_sha,
      base_ref: original.pull_request.desired.base_ref, closing_issue_numbers: [17], state: "OPEN" as const };
    original.pull_request.observations = [observed];
    const preview = await prepareDeliveryEffectBoundary({ runDir: setup.ledger.runDir, repoRoot: root!, planning: original, manifest: setup.manifest, lineage: setup.lineage });
    const body = `User-authored context\n\n${observed.body}`;
    const current = { ...observed, body };
    const desired = { ...original.pull_request.desired, body };
    const push = vi.fn(); const open = vi.fn(); const update = vi.fn();
    await expect(applyDeliveryEffectPreview({
      runDir: setup.ledger.runDir, repoRoot: root!, worktreePath: root!, preview,
      planning: { ...original, branch: { branch_name: original.branch.branch_name, head_sha: original.branch.head_sha, reason_code: original.branch.reason_code }, pull_request: { desired } },
      localHead: async () => "b".repeat(40), remoteHead: async () => "b".repeat(40), observePullRequests: async () => [current],
      pushCommitToBranch: push, openPullRequest: open, updatePullRequestBody: update, getPullRequest: async () => current,
    })).resolves.toMatchObject({ outcome: "replacement_preview", preview: { revision: 2 } });
    expect(push).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled(); expect(update).not.toHaveBeenCalled();
  });

  it("recovers the lineage-first ready result after the manifest mirror failpoint", async () => {
    const setup = await readyBoundary();
    const plan = planning(setup);
    const preview = await prepareDeliveryEffectBoundary({ runDir: setup.ledger.runDir, repoRoot: root!, planning: plan, manifest: setup.manifest, lineage: setup.lineage });
    let remote: string | null = null;
    let observed: any[] = [];
    const push = vi.fn(async (_path: string, sha: string) => { remote = sha; return "pushed"; });
    const open = vi.fn(async (desired: typeof plan.pull_request.desired) => {
      const value = { number: 45, url: "https://github.com/acme/repo/pull/45", title: desired.title, body: desired.body,
        head_ref: desired.head_ref, head_sha: desired.head_sha, base_ref: desired.base_ref, closing_issue_numbers: [17], state: "OPEN" as const };
      observed = [value]; return value;
    });
    let fail = true;
    const apply = () => applyDeliveryEffectPreview({
      runDir: setup.ledger.runDir, repoRoot: root!, worktreePath: root!, preview,
      planning: { ...plan, branch: { branch_name: plan.branch.branch_name, head_sha: plan.branch.head_sha, reason_code: plan.branch.reason_code }, pull_request: { desired: plan.pull_request.desired } },
      localHead: async () => "b".repeat(40), remoteHead: async () => remote, observePullRequests: async () => observed,
      pushCommitToBranch: push, openPullRequest: open, updatePullRequestBody: vi.fn(), getPullRequest: async () => observed[0],
      afterLineageReady: async () => { if (fail) { fail = false; throw new Error("lineage-ready failpoint"); } },
    });
    await expect(apply()).rejects.toThrow("lineage-ready failpoint");
    await expect(apply()).resolves.toMatchObject({ outcome: "applied", pull_request: { number: 45 } });
    expect(push).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledOnce();
    expect((await readManifestV2(setup.ledger.runDir)).github_effects.pull_request_delivery?.state).toBe("applied");
  });

  it("repairs only the managed PR body and never opens a second lineage PR", async () => {
    const setup = await readyBoundary();
    const plan = planning(setup, "b".repeat(40));
    const stale = { number: 44, url: "https://github.com/acme/repo/pull/44", title: plan.pull_request.desired.title,
      body: plan.pull_request.desired.body.replace("Closes #17", "Closes #99"), head_ref: "codex/ship", head_sha: "b".repeat(40),
      base_ref: "main", closing_issue_numbers: [99], state: "OPEN" as const };
    plan.pull_request.observations = [stale];
    const preview = await prepareDeliveryEffectBoundary({ runDir: setup.ledger.runDir, repoRoot: root!, planning: plan, manifest: setup.manifest, lineage: setup.lineage });
    let current = stale;
    const update = vi.fn(async (_number: number, body: string) => { current = { ...current, body, closing_issue_numbers: [17] }; });
    const open = vi.fn();
    await expect(applyDeliveryEffectPreview({
      runDir: setup.ledger.runDir, repoRoot: root!, worktreePath: root!, preview,
      planning: { ...plan, branch: { branch_name: plan.branch.branch_name, head_sha: plan.branch.head_sha, reason_code: plan.branch.reason_code }, pull_request: { desired: plan.pull_request.desired } },
      localHead: async () => "b".repeat(40), remoteHead: async () => "b".repeat(40), observePullRequests: async () => [current],
      pushCommitToBranch: vi.fn(), openPullRequest: open, updatePullRequestBody: update, getPullRequest: async () => current,
    })).resolves.toMatchObject({ outcome: "applied", pull_request: { number: 44 } });
    expect(update).toHaveBeenCalledOnce();
    expect(open).not.toHaveBeenCalled();
  });

  it("marks owned title drift ambiguous without push, edit, or open", async () => {
    const setup = await readyBoundary();
    const plan = planning(setup, "b".repeat(40));
    const exact = { number: 46, url: "https://github.com/acme/repo/pull/46", title: plan.pull_request.desired.title,
      body: plan.pull_request.desired.body, head_ref: "codex/ship", head_sha: "b".repeat(40),
      base_ref: "main", closing_issue_numbers: [17], state: "OPEN" as const };
    plan.pull_request.observations = [exact];
    const preview = await prepareDeliveryEffectBoundary({ runDir: setup.ledger.runDir, repoRoot: root!, planning: plan, manifest: setup.manifest, lineage: setup.lineage });
    const drifted = { ...exact, title: "User changed title" };
    const push = vi.fn(); const open = vi.fn(); const update = vi.fn();
    await expect(applyDeliveryEffectPreview({
      runDir: setup.ledger.runDir, repoRoot: root!, worktreePath: root!, preview,
      planning: { ...plan, branch: { branch_name: plan.branch.branch_name, head_sha: plan.branch.head_sha, reason_code: plan.branch.reason_code }, pull_request: { desired: plan.pull_request.desired } },
      localHead: async () => "b".repeat(40), remoteHead: async () => "b".repeat(40), observePullRequests: async () => [drifted],
      pushCommitToBranch: push, openPullRequest: open, updatePullRequestBody: update, getPullRequest: vi.fn(),
    })).rejects.toThrow(/title drift|operator reconciliation/i);
    expect(push).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled(); expect(update).not.toHaveBeenCalled();
    expect((await readTaskLineage(root!, setup.lineage.lineage_id)).delivery.state).toBe("ambiguous");
  });
});
