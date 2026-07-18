import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  GithubEffectPlanningError,
  canonicalGithubEffectPreview,
  planIssueSyncPreview,
  planPullRequestDeliveryPreview,
  readVerifiedGithubEffectPreview,
  renderGithubEffectPreview,
  writeGithubEffectPreview,
  type GithubEffectPreviewRef,
  type IssueSyncPlanningInput,
  type PullRequestDeliveryPlanningInput,
} from "../../src/github/effect-plan.js";

const roots: string[] = [];
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const planSha = "a".repeat(64);
const lineageId = "11111111-1111-4111-8111-111111111111";
const createdAt = "2026-07-16T19:00:00.000Z";

function resealPreview<T extends { preview_sha256: string }>(preview: T): T {
  const { preview_sha256: _old, ...unsigned } = preview;
  preview.preview_sha256 = hash(`${JSON.stringify(unsigned, null, 2)}\n`);
  return preview;
}

async function runDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "brain-hands-effect-plan-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const parentDesired = {
  title: "Feature parent",
  body: "<!-- brain-hands-lineage:11111111-1111-4111-8111-111111111111 -->\nParent body",
  labels: ["brain:planned", "brain-hands"],
  state: "OPEN" as const,
  state_reason: null,
  reason_code: "approved-plan-parent",
};

const itemDesired = (id: string) => ({
  title: `Implement ${id}`,
  body: `<!-- brain-hands-lineage:${lineageId} -->\n<!-- brain-hands-work-item:${id} -->\nFull ${id} body`,
  labels: ["brain-hands:ready", "brain-hands"],
  state: "OPEN" as const,
  state_reason: null,
  reason_code: "approved-plan-work-item",
});

const observedIssue = (number: number, desired: ReturnType<typeof itemDesired> | typeof parentDesired) => ({
  number,
  title: desired.title,
  body: desired.body,
  labels: [...desired.labels].reverse(),
  state: desired.state,
  state_reason: desired.state_reason,
});

function issueInput(overrides: Partial<IssueSyncPlanningInput> = {}): IssueSyncPlanningInput {
  return {
    revision: 1,
    lineage_id: lineageId,
    run_id: "run-1",
    repository: { host: "github.com", name_with_owner: "ngelik/brain-hands" },
    plan_revision: 1,
    plan_sha256: planSha,
    created_at: createdAt,
    lineage_state: "active",
    issue_set: {
      state: "uninitialized",
      plan_revision: null,
      plan_sha256: null,
      parent_issue_number: null,
      work_item_issue_map: {},
      has_prior_owned_state: false,
    },
    approved_replan: false,
    parent: { feature_slug: "feature", desired: parentDesired, observations: [] },
    work_items: [{ work_item_id: "WI-1", desired: itemDesired("WI-1"), observations: [] }],
    ...overrides,
  };
}

function readyIssueInput(): IssueSyncPlanningInput {
  return issueInput({
    issue_set: {
      state: "ready",
      plan_revision: 1,
      plan_sha256: planSha,
      parent_issue_number: 10,
      work_item_issue_map: { "WI-1": 11 },
      has_prior_owned_state: true,
    },
    parent: { feature_slug: "feature", desired: parentDesired, observations: [observedIssue(10, parentDesired)] },
    work_items: [{
      work_item_id: "WI-1",
      desired: itemDesired("WI-1"),
      observations: [observedIssue(11, itemDesired("WI-1"))],
    }],
  });
}

const desiredPullRequest = {
  title: "Deliver approved plan",
  body: "Summary\n<!-- brain-hands:issue-links schema=1 lineage=11111111-1111-4111-8111-111111111111 run=run-1 -->\nCloses #10\nCloses #11\n<!-- /brain-hands:issue-links -->",
  head_ref: "brain-hands/run-1",
  head_sha: "b".repeat(40),
  base_ref: "main",
  closing_issue_numbers: [11, 10],
  reason_code: "verified-delivery",
};

const observedPullRequest = (patch: Record<string, unknown> = {}) => ({
  number: 20,
  url: "https://github.com/ngelik/brain-hands/pull/20",
  title: desiredPullRequest.title,
  body: desiredPullRequest.body,
  head_ref: desiredPullRequest.head_ref,
  head_sha: desiredPullRequest.head_sha,
  base_ref: desiredPullRequest.base_ref,
  closing_issue_numbers: [10, 11],
  state: "OPEN" as const,
  ...patch,
});

function deliveryInput(overrides: Partial<PullRequestDeliveryPlanningInput> = {}): PullRequestDeliveryPlanningInput {
  return {
    revision: 1,
    lineage_id: lineageId,
    run_id: "run-1",
    repository: { host: "github.com", name_with_owner: "ngelik/brain-hands" },
    plan_revision: 1,
    plan_sha256: planSha,
    created_at: createdAt,
    lineage_state: "delivery_ready",
    branch: {
      branch_name: desiredPullRequest.head_ref,
      head_sha: desiredPullRequest.head_sha,
      observed_head_sha: null,
      reason_code: "verified-delivery-head",
    },
    pull_request: { desired: desiredPullRequest, observations: [] },
    ...overrides,
  };
}

function planningCode(operation: () => unknown): string | undefined {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(GithubEffectPlanningError);
    return (error as GithubEffectPlanningError).code;
  }
  return undefined;
}

describe("issue effect planning", () => {
  it("plans creates for an active uninitialized lineage with no remote matches", () => {
    const effects = planIssueSyncPreview(issueInput()).effects;
    expect(effects.map((effect) => effect.action)).toEqual(["create", "create"]);
    expect(effects.filter((effect) => effect.target.kind === "parent")).toHaveLength(1);
  });

  it("omits the parent effect when the approved plan has no parent issue", () => {
    const input = issueInput();
    input.parent = null;
    const preview = planIssueSyncPreview(input);

    expect(preview.effects).toHaveLength(1);
    expect(preview.effects[0]?.target).toEqual({ kind: "work_item", work_item_id: "WI-1" });
  });

  it("plans reuse for exact uniquely owned issues", () => {
    expect(planIssueSyncPreview(readyIssueInput()).effects.map((effect) => effect.action)).toEqual(["reuse", "reuse"]);
  });

  it("plans update when uniquely owned managed material drifts", () => {
    const input = readyIssueInput();
    input.work_items[0]!.observations[0] = { ...input.work_items[0]!.observations[0]!, title: "stale" };
    expect(planIssueSyncPreview(input).effects[1]).toMatchObject({ action: "update", existing_number: 11 });
  });

  it("rejects a missing mapped owned issue", () => {
    const input = readyIssueInput();
    input.work_items[0]!.observations = [];
    expect(planningCode(() => planIssueSyncPreview(input))).toBe("missing-owned-issue");
  });

  it("rejects a ready parent with no authoritative mapping and no observation", () => {
    const input = readyIssueInput();
    input.issue_set.parent_issue_number = null;
    input.parent!.observations = [];
    expect(planningCode(() => planIssueSyncPreview(input))).toBe("missing-owned-issue");
  });

  it("rejects a ready parent observation with no authoritative mapping", () => {
    const input = readyIssueInput();
    input.issue_set.parent_issue_number = null;
    expect(planningCode(() => planIssueSyncPreview(input))).toBe("ownership-mismatch");
  });

  it("rejects a ready mapped work item with no observation", () => {
    const input = readyIssueInput();
    input.work_items[0]!.observations = [];
    expect(planningCode(() => planIssueSyncPreview(input))).toBe("missing-owned-issue");
  });

  it("rejects an unmapped ready work-item observation during normal resume", () => {
    const input = readyIssueInput();
    input.work_items.push({
      work_item_id: "WI-2",
      desired: itemDesired("WI-2"),
      observations: [observedIssue(12, itemDesired("WI-2"))],
    });
    expect(planningCode(() => planIssueSyncPreview(input))).toBe("unapproved-extension");
  });

  it("rejects ambiguous marker ownership before producing a preview", () => {
    const input = readyIssueInput();
    input.parent!.observations.push({ ...input.parent!.observations[0]!, number: 99 });
    expect(planningCode(() => planIssueSyncPreview(input))).toBe("ambiguous-marker");
  });

  it("rejects a lineage whose prior issue application is ambiguous", () => {
    const input = readyIssueInput();
    input.issue_set.state = "ambiguous";
    expect(planningCode(() => planIssueSyncPreview(input))).toBe("ambiguous-marker");
  });

  it("rejects an observation whose number does not match the lineage mapping", () => {
    const input = readyIssueInput();
    input.parent!.observations = [{ ...input.parent!.observations[0]!, number: 99 }];
    expect(planningCode(() => planIssueSyncPreview(input))).toBe("ownership-mismatch");
  });

  it("rejects work-item extension during normal resume", () => {
    const input = readyIssueInput();
    input.work_items.push({ work_item_id: "WI-2", desired: itemDesired("WI-2"), observations: [] });
    expect(planningCode(() => planIssueSyncPreview(input))).toBe("unapproved-extension");
  });

  it("creates only a new stable ID for a newer approved replan", () => {
    const input = readyIssueInput();
    input.plan_revision = 2;
    input.approved_replan = true;
    input.work_items.push({ work_item_id: "WI-2", desired: itemDesired("WI-2"), observations: [] });
    const preview = planIssueSyncPreview(input);
    expect(preview.effects.map((effect) => [effect.target.kind, effect.action])).toEqual([
      ["parent", "reuse"],
      ["work_item", "reuse"],
      ["work_item", "create"],
    ]);
  });

  it("allows a uniquely observed new stable ID only for a newer approved replan", () => {
    const input = readyIssueInput();
    input.plan_revision = 2;
    input.approved_replan = true;
    input.work_items.push({
      work_item_id: "WI-2",
      desired: itemDesired("WI-2"),
      observations: [observedIssue(12, itemDesired("WI-2"))],
    });
    expect(planIssueSyncPreview(input).effects[2]).toMatchObject({ action: "reuse", existing_number: 12 });
  });

  it("does not treat a ready null-plan issue set as initial", () => {
    const input = readyIssueInput();
    input.issue_set.plan_revision = null;
    input.issue_set.plan_sha256 = null;
    input.issue_set.work_item_issue_map = {};
    input.issue_set.parent_issue_number = null;
    input.issue_set.has_prior_owned_state = false;
    input.parent!.observations = [];
    input.work_items[0]!.observations = [];
    expect(planningCode(() => planIssueSyncPreview(input))).toBe("unapproved-extension");
  });

  it("does not treat uninitialized issue state with prior owned state as initial", () => {
    const input = issueInput();
    input.issue_set.has_prior_owned_state = true;
    expect(planningCode(() => planIssueSyncPreview(input))).toBe("unapproved-extension");
  });

  it.each([
    ["mapping collision", (input: IssueSyncPlanningInput) => { input.issue_set.work_item_issue_map["WI-1"] = 10; }],
    ["observation collision", (input: IssueSyncPlanningInput) => { input.work_items[0]!.observations[0]!.number = 10; }],
    ["mapping/observation collision", (input: IssueSyncPlanningInput) => {
      input.issue_set.work_item_issue_map["WI-1"] = 12;
      input.work_items[0]!.observations[0]!.number = 10;
    }],
  ])("rejects cross-target issue-number %s", (_label, mutate) => {
    const input = readyIssueInput();
    mutate(input);
    expect(planningCode(() => planIssueSyncPreview(input))).toBe("ownership-mismatch");
  });

  it("rejects the same observation number across two work-item targets", () => {
    const input = readyIssueInput();
    input.issue_set.work_item_issue_map["WI-2"] = 11;
    input.work_items.push({ work_item_id: "WI-2", desired: itemDesired("WI-2"), observations: [observedIssue(11, itemDesired("WI-2"))] });
    expect(planningCode(() => planIssueSyncPreview(input))).toBe("ownership-mismatch");
  });

  it.each(["completed", "abandoned", "closed_blocked"] as const)("rejects creates for terminal lineage %s", (state) => {
    expect(planningCode(() => planIssueSyncPreview(issueInput({ lineage_state: state })))).toBe("terminal-lineage");
  });
});

describe("delivery effect planning", () => {
  it("plans push for an absent branch", () => {
    expect(planPullRequestDeliveryPreview(deliveryInput()).effects[0]).toMatchObject({ action: "push", observed_sha256: null });
  });

  it("plans noop for a branch already at the desired head", () => {
    const input = deliveryInput();
    input.branch.observed_head_sha = input.branch.head_sha;
    expect(planPullRequestDeliveryPreview(input).effects[0]).toMatchObject({ action: "noop" });
  });

  it("plans a leased push when the branch points at another SHA", () => {
    const input = deliveryInput();
    input.branch.observed_head_sha = "c".repeat(40);
    expect(planPullRequestDeliveryPreview(input).effects[0]).toMatchObject({ action: "push", reason_code: "branch-head-drift" });
  });

  it("opens a PR when no lineage PR exists", () => {
    expect(planPullRequestDeliveryPreview(deliveryInput()).effects[1]).toMatchObject({ action: "open", existing_number: null });
  });

  it("reuses one exact open PR", () => {
    const input = deliveryInput();
    input.pull_request.observations = [observedPullRequest()];
    expect(planPullRequestDeliveryPreview(input).effects[1]).toMatchObject({ action: "reuse", existing_number: 20 });
  });

  it("repairs managed body drift on the uniquely owned PR", () => {
    const input = deliveryInput();
    input.pull_request.observations = [observedPullRequest({ body: "stale" })];
    expect(planPullRequestDeliveryPreview(input).effects[1]).toMatchObject({ action: "repair", existing_number: 20 });
  });

  it("uses noop for an exact merged PR", () => {
    const input = deliveryInput();
    input.pull_request.observations = [observedPullRequest({ state: "MERGED" })];
    expect(planPullRequestDeliveryPreview(input).effects[1]).toMatchObject({ action: "noop" });
  });

  it("permits only the explicitly authorized prior head to advance to the desired head", () => {
    const input = deliveryInput({ authorized_prior_head_sha: "a".repeat(40) });
    input.pull_request.observations = [observedPullRequest({ head_sha: "a".repeat(40) })];
    expect(planPullRequestDeliveryPreview(input).effects[1]).toMatchObject({ action: "repair" });
    input.authorized_prior_head_sha = "9".repeat(40);
    expect(planningCode(() => planPullRequestDeliveryPreview(input))).toBe("pull-request-target-mismatch");
  });

  it.each([
    ["wrong-head", { head_ref: "other" }],
    ["wrong-head-sha", { head_sha: "d".repeat(40) }],
    ["wrong-base", { base_ref: "develop" }],
  ])("rejects %s PR ownership", (_label, patch) => {
    const input = deliveryInput();
    input.pull_request.observations = [observedPullRequest(patch)];
    expect(planningCode(() => planPullRequestDeliveryPreview(input))).toBe("pull-request-target-mismatch");
  });

  it("rejects multiple lineage PRs", () => {
    const input = deliveryInput();
    input.pull_request.observations = [observedPullRequest(), observedPullRequest({ number: 21 })];
    expect(planningCode(() => planPullRequestDeliveryPreview(input))).toBe("ambiguous-pull-request");
  });

  it.each([
    ["branch name", (input: PullRequestDeliveryPlanningInput) => { input.branch.branch_name = "other"; }],
    ["delivery head SHA", (input: PullRequestDeliveryPlanningInput) => { input.branch.head_sha = "d".repeat(40); }],
  ])("rejects desired PR %s drift from the delivery branch", (_label, mutate) => {
    const input = deliveryInput();
    mutate(input);
    expect(planningCode(() => planPullRequestDeliveryPreview(input))).toBe("pull-request-target-mismatch");
  });

  it("rejects PR creation for a terminal lineage", () => {
    expect(planningCode(() => planPullRequestDeliveryPreview(deliveryInput({ lineage_state: "completed" })))).toBe("terminal-lineage");
  });
});

describe("canonical hashes and rendering", () => {
  it("is invariant to input ordering and sorts work items by stable ID", () => {
    const input = readyIssueInput();
    input.issue_set.work_item_issue_map = { "WI-2": 12, "WI-1": 11 };
    input.work_items = [
      { work_item_id: "WI-2", desired: { ...itemDesired("WI-2"), labels: ["brain-hands", "brain-hands:ready"] }, observations: [observedIssue(12, itemDesired("WI-2"))] },
      input.work_items[0]!,
    ];
    const shuffled = structuredClone(input);
    shuffled.work_items.reverse();
    shuffled.parent!.desired.labels.reverse();
    shuffled.parent!.observations[0]!.labels.reverse();
    const first = planIssueSyncPreview(input);
    const second = planIssueSyncPreview(shuffled);
    expect(second.observation_sha256).toBe(first.observation_sha256);
    expect(second.desired_sha256).toBe(first.desired_sha256);
    expect(second.effects.map((effect) => effect.effect_id)).toEqual(first.effects.map((effect) => effect.effect_id));
    expect(first.effects.map((effect) => effect.target.kind === "work_item" ? effect.target.work_item_id : "parent")).toEqual(["parent", "WI-1", "WI-2"]);
  });

  it("uses locale-independent stable-ID ordering rather than other work-item fields", () => {
    const input = readyIssueInput();
    input.issue_set.work_item_issue_map = { "WI-2": 12, "WI-10": 13, "WI-1": 11 };
    input.work_items.push(
      { work_item_id: "WI-2", desired: { ...itemDesired("WI-2"), title: "A sorts first by material" }, observations: [observedIssue(12, itemDesired("WI-2"))] },
      { work_item_id: "WI-10", desired: { ...itemDesired("WI-10"), title: "Z sorts last by material" }, observations: [observedIssue(13, itemDesired("WI-10"))] },
    );
    input.work_items[1]!.observations[0]!.title = input.work_items[1]!.desired.title;
    input.work_items[2]!.observations[0]!.title = input.work_items[2]!.desired.title;
    expect(planIssueSyncPreview(input).effects.map((effect) => effect.target.kind === "work_item" ? effect.target.work_item_id : "parent"))
      .toEqual(["parent", "WI-1", "WI-10", "WI-2"]);
  });

  it("keeps control hashes stable across map insertion order", () => {
    const first = readyIssueInput();
    first.issue_set.work_item_issue_map = { "WI-2": 12, "WI-1": 11 };
    first.work_items.push({ work_item_id: "WI-2", desired: itemDesired("WI-2"), observations: [observedIssue(12, itemDesired("WI-2"))] });
    const second = structuredClone(first);
    second.issue_set.work_item_issue_map = { "WI-1": 11, "WI-2": 12 };
    expect(planIssueSyncPreview(second).observation_sha256).toBe(planIssueSyncPreview(first).observation_sha256);
  });

  it.each([
    ["issue-set state", (input: IssueSyncPlanningInput) => { input.issue_set.state = "applying"; }],
    ["prior plan digest", (input: IssueSyncPlanningInput) => { input.issue_set.plan_sha256 = "b".repeat(64); }],
    ["prior owned state", (input: IssueSyncPlanningInput) => { input.issue_set.has_prior_owned_state = false; }],
    ["parent mapping", (input: IssueSyncPlanningInput) => {
      input.issue_set.parent_issue_number = 12;
      input.parent!.observations[0]!.number = 12;
    }],
    ["work-item mapping", (input: IssueSyncPlanningInput) => {
      input.issue_set.work_item_issue_map["WI-1"] = 12;
      input.work_items[0]!.observations[0]!.number = 12;
    }],
    ["approved-replan control", (input: IssueSyncPlanningInput) => { input.approved_replan = true; }],
    ["lineage state", (input: IssueSyncPlanningInput) => { input.lineage_state = "delivery_ready"; }],
  ])("binds observation/control hash to %s", (_label, mutate) => {
    const original = readyIssueInput();
    const changed = structuredClone(original);
    mutate(changed);
    expect(planIssueSyncPreview(changed).observation_sha256).not.toBe(planIssueSyncPreview(original).observation_sha256);
  });

  it.each([
    ["title", (input: IssueSyncPlanningInput) => { input.work_items[0]!.desired.title = "changed"; }],
    ["body", (input: IssueSyncPlanningInput) => { input.work_items[0]!.desired.body = "changed"; }],
    ["labels", (input: IssueSyncPlanningInput) => { input.work_items[0]!.desired.labels.push("extra"); }],
    ["state", (input: IssueSyncPlanningInput) => { input.work_items[0]!.desired.state = "CLOSED"; }],
    ["state reason", (input: IssueSyncPlanningInput) => { input.work_items[0]!.desired.state_reason = "COMPLETED"; }],
    ["reason", (input: IssueSyncPlanningInput) => { input.work_items[0]!.desired.reason_code = "changed"; }],
  ])("binds issue desired hash to %s", (_label, mutate) => {
    const original = readyIssueInput();
    const changed = structuredClone(original);
    mutate(changed);
    expect(planIssueSyncPreview(changed).desired_sha256).not.toBe(planIssueSyncPreview(original).desired_sha256);
  });

  it.each([
    ["number", (input: IssueSyncPlanningInput) => { input.work_items[0]!.observations[0]!.number = 12; input.issue_set.work_item_issue_map["WI-1"] = 12; }],
    ["title", (input: IssueSyncPlanningInput) => { input.work_items[0]!.observations[0]!.title = "changed"; }],
    ["body", (input: IssueSyncPlanningInput) => { input.work_items[0]!.observations[0]!.body = "changed"; }],
    ["labels", (input: IssueSyncPlanningInput) => { input.work_items[0]!.observations[0]!.labels.push("extra"); }],
    ["state", (input: IssueSyncPlanningInput) => { input.work_items[0]!.observations[0]!.state = "CLOSED"; }],
    ["state reason", (input: IssueSyncPlanningInput) => { input.work_items[0]!.observations[0]!.state_reason = "COMPLETED"; }],
  ])("binds issue observation hash to %s", (_label, mutate) => {
    const original = readyIssueInput();
    const changed = structuredClone(original);
    mutate(changed);
    expect(planIssueSyncPreview(changed).observation_sha256).not.toBe(planIssueSyncPreview(original).observation_sha256);
  });

  it.each([
    ["branch SHA", (input: PullRequestDeliveryPlanningInput) => { input.branch.head_sha = "d".repeat(40); input.pull_request.desired.head_sha = "d".repeat(40); }],
    ["authorized prior head", (input: PullRequestDeliveryPlanningInput) => { input.authorized_prior_head_sha = "a".repeat(40); }],
    ["base", (input: PullRequestDeliveryPlanningInput) => { input.pull_request.desired.base_ref = "develop"; }],
    ["head", (input: PullRequestDeliveryPlanningInput) => { input.pull_request.desired.head_ref = "other"; input.branch.branch_name = "other"; }],
    ["closing references", (input: PullRequestDeliveryPlanningInput) => { input.pull_request.desired.closing_issue_numbers.push(12); }],
  ])("binds delivery desired hash to %s", (_label, mutate) => {
    const original = deliveryInput();
    const changed = structuredClone(original);
    mutate(changed);
    expect(planPullRequestDeliveryPreview(changed).desired_sha256).not.toBe(planPullRequestDeliveryPreview(original).desired_sha256);
  });

  it("binds delivery observation hash to the authorized prior head", () => {
    const original = deliveryInput({ authorized_prior_head_sha: null });
    const changed = deliveryInput({ authorized_prior_head_sha: "a".repeat(40) });
    expect(planPullRequestDeliveryPreview(changed).observation_sha256).not.toBe(
      planPullRequestDeliveryPreview(original).observation_sha256,
    );
  });

  it("excludes volatile, local, prose, token, and arbitrary error fields from hashes and rendering", () => {
    const input = readyIssueInput() as IssueSyncPlanningInput & Record<string, unknown>;
    input.updated_at = "later";
    input.absolute_path = "/Users/secret/repo";
    input.task_prose = "private task prose";
    input.token = "ghp_secret";
    input.error = "arbitrary remote error";
    const preview = planIssueSyncPreview(input);
    const rendered = renderGithubEffectPreview({
      ...preview,
      updated_at: "later",
      absolute_path: "/Users/secret/repo",
      task_prose: "private task prose",
      token: "ghp_secret",
      error: "arbitrary remote error",
    } as typeof preview);
    for (const forbidden of ["updated_at", "/Users/secret", "private task prose", "ghp_secret", "arbitrary remote error"]) {
      expect(rendered).not.toContain(forbidden);
    }
    expect(planIssueSyncPreview({ ...input, updated_at: "even-later" } as IssueSyncPlanningInput).preview_sha256).toBe(preview.preview_sha256);
  });

  it("does not render unknown fields nested inside an effect", () => {
    const preview = planIssueSyncPreview(issueInput());
    const tainted = structuredClone(preview) as typeof preview & { effects: Array<Record<string, unknown>> };
    tainted.effects[0]!.error = "arbitrary nested error";
    tainted.effects[0]!.token = "ghp_nested_secret";
    expect(renderGithubEffectPreview(tainted)).not.toContain("arbitrary nested error");
    expect(renderGithubEffectPreview(tainted)).not.toContain("ghp_nested_secret");
  });

  it("computes the internal preview digest over canonical bytes without preview_sha256", () => {
    const preview = planIssueSyncPreview(issueInput());
    const { preview_sha256: _digest, ...unsigned } = preview;
    expect(preview.preview_sha256).toBe(hash(`${JSON.stringify(unsigned, null, 2)}\n`));
  });
});

describe("immutable preview artifacts", () => {
  it("accepts an existing revision only when its bytes are identical", async () => {
    const directory = await runDir();
    const preview = planIssueSyncPreview(issueInput());
    const first = await writeGithubEffectPreview({ run_dir: directory, preview });
    await expect(writeGithubEffectPreview({ run_dir: directory, preview })).resolves.toEqual(first);
    await writeFile(join(directory, first.path), `${canonicalGithubEffectPreview(preview)} `, "utf8");
    await expect(writeGithubEffectPreview({ run_dir: directory, preview })).rejects.toThrow(/immutable.*different bytes/i);
  });

  it("does not accept byte-identical content through a symlink collision", async () => {
    const directory = await runDir();
    const preview = planIssueSyncPreview(issueInput());
    const path = "github-effects/issue-sync/revision-1.json";
    const outside = join(directory, "outside.json");
    await writeFile(outside, canonicalGithubEffectPreview(preview), "utf8");
    await mkdir(join(directory, "github-effects", "issue-sync"), { recursive: true });
    await symlink(outside, join(directory, path));
    await expect(writeGithubEffectPreview({ run_dir: directory, preview })).rejects.toThrow(/regular file|symlink/i);
  });

  it("refuses a symlink run directory", async () => {
    const directory = await runDir();
    const alias = `${directory}-alias`;
    roots.push(alias);
    await symlink(directory, alias);
    await expect(writeGithubEffectPreview({ run_dir: alias, preview: planIssueSyncPreview(issueInput()) }))
      .rejects.toThrow(/run directory.*symlink|canonical run directory/i);
  });

  it("refuses an ancestor symlink during write even when the target bytes would match", async () => {
    const directory = await runDir();
    const outside = await runDir();
    await mkdir(join(outside, "issue-sync"), { recursive: true });
    const preview = planIssueSyncPreview(issueInput());
    await writeFile(join(outside, "issue-sync", "revision-1.json"), canonicalGithubEffectPreview(preview), "utf8");
    await symlink(outside, join(directory, "github-effects"));
    await expect(writeGithubEffectPreview({ run_dir: directory, preview })).rejects.toThrow(/symlink|escaped/i);
  });

  it("refuses to persist a preview whose internal digest is stale", async () => {
    const directory = await runDir();
    const preview = planIssueSyncPreview(issueInput());
    preview.preview_sha256 = "0".repeat(64);
    await expect(writeGithubEffectPreview({ run_dir: directory, preview })).rejects.toThrow(/internal.*digest/i);
  });

  it.each([
    ["issue create with existing number", () => {
      const preview = planIssueSyncPreview(issueInput());
      const effect = preview.effects[0]!;
      if (effect.target.kind !== "parent" || !("existing_number" in effect)) throw new Error("test setup");
      effect.existing_number = 99;
      return resealPreview(preview);
    }],
    ["issue reuse without observed hash", () => {
      const preview = planIssueSyncPreview(readyIssueInput());
      preview.effects[0]!.observed_sha256 = null;
      return resealPreview(preview);
    }],
    ["PR open with existing number", () => {
      const preview = planPullRequestDeliveryPreview(deliveryInput());
      const effect = preview.effects[1]!;
      if (effect.target.kind !== "pull_request" || !("existing_number" in effect)) throw new Error("test setup");
      effect.existing_number = 20;
      return resealPreview(preview);
    }],
    ["PR reuse without observed hash", () => {
      const input = deliveryInput();
      input.pull_request.observations = [observedPullRequest()];
      const preview = planPullRequestDeliveryPreview(input);
      preview.effects[1]!.observed_sha256 = null;
      return resealPreview(preview);
    }],
    ["branch noop without observed hash", () => {
      const input = deliveryInput();
      input.branch.observed_head_sha = input.branch.head_sha;
      const preview = planPullRequestDeliveryPreview(input);
      preview.effects[0]!.observed_sha256 = null;
      return resealPreview(preview);
    }],
  ])("rejects invalid action-specific effect semantics: %s", async (_label, preview) => {
    await expect(writeGithubEffectPreview({ run_dir: await runDir(), preview: preview() }))
      .rejects.toThrow(/effect.*invalid|requires/i);
  });

  it.each([
    ["duplicate issue target and effect ID", () => {
      const preview = planIssueSyncPreview(issueInput());
      preview.effects.push(structuredClone(preview.effects[0]!));
      return resealPreview(preview);
    }],
    ["duplicate delivery branch", () => {
      const preview = planPullRequestDeliveryPreview(deliveryInput());
      preview.effects.push(structuredClone(preview.effects[0]!));
      return resealPreview(preview);
    }],
    ["missing delivery pull request", () => {
      const preview = planPullRequestDeliveryPreview(deliveryInput());
      preview.effects.pop();
      return resealPreview(preview);
    }],
  ])("rejects invalid effect cardinality: %s", async (_label, preview) => {
    await expect(writeGithubEffectPreview({ run_dir: await runDir(), preview: preview() }))
      .rejects.toThrow(/duplicate|exactly one|effect/i);
  });

  it("writes and reads an issue preview with zero parent effects", async () => {
    const directory = await runDir();
    const input = issueInput();
    input.parent = null;
    const preview = planIssueSyncPreview(input);
    const reference = await writeGithubEffectPreview({ run_dir: directory, preview });

    await expect(readVerifiedGithubEffectPreview({
      run_dir: directory,
      reference,
      expected: {
        phase: "issue_sync",
        lineage_id: preview.lineage_id,
        run_id: preview.run_id,
        plan_revision: preview.plan_revision,
        plan_sha256: preview.plan_sha256,
      },
    })).resolves.toEqual(preview);
  });

  it("reads only a preview bound to canonical path, external and internal SHA, phase, lineage, run, and plan", async () => {
    const directory = await runDir();
    const preview = planIssueSyncPreview(issueInput());
    const reference = await writeGithubEffectPreview({ run_dir: directory, preview });
    const expected: {
      phase: "issue_sync" | "pull_request_delivery";
      lineage_id: string;
      run_id: string;
      plan_revision: number;
      plan_sha256: string;
    } = {
      phase: "issue_sync",
      lineage_id: lineageId,
      run_id: "run-1",
      plan_revision: 1,
      plan_sha256: planSha,
    };
    await expect(readVerifiedGithubEffectPreview({ run_dir: directory, reference, expected })).resolves.toEqual(preview);

    const cases: Array<[string, GithubEffectPreviewRef, Partial<typeof expected>]> = [
      ["path", { ...reference, path: "../revision-1.json" }, {}],
      ["recorded digest", { ...reference, sha256: "0".repeat(64) }, {}],
      ["phase", reference, { phase: "pull_request_delivery" }],
      ["lineage", reference, { lineage_id: randomUUID() }],
      ["run", reference, { run_id: "run-2" }],
      ["plan revision", reference, { plan_revision: 2 }],
      ["plan digest", reference, { plan_sha256: "b".repeat(64) }],
    ];
    for (const [_label, changedReference, changedExpected] of cases) {
      await expect(readVerifiedGithubEffectPreview({
        run_dir: directory,
        reference: changedReference,
        expected: { ...expected, ...changedExpected },
      })).rejects.toThrow();
    }

    const raw = await readFile(join(directory, reference.path), "utf8");
    const altered = JSON.parse(raw) as typeof preview;
    altered.preview_sha256 = "0".repeat(64);
    await writeFile(join(directory, reference.path), `${JSON.stringify(altered, null, 2)}\n`, "utf8");
    const alteredReference = { ...reference, sha256: hash(`${JSON.stringify(altered, null, 2)}\n`) };
    await expect(readVerifiedGithubEffectPreview({ run_dir: directory, reference: alteredReference, expected })).rejects.toThrow(/internal.*digest/i);
  });

  it("rejects canonically rehashed artifact bytes with invalid action semantics", async () => {
    const directory = await runDir();
    const preview = planIssueSyncPreview(issueInput());
    const reference = await writeGithubEffectPreview({ run_dir: directory, preview });
    const altered = structuredClone(preview);
    const effect = altered.effects[0]!;
    if (effect.target.kind !== "parent" || !("existing_number" in effect)) throw new Error("test setup");
    effect.existing_number = 99;
    resealPreview(altered);
    const bytes = `${JSON.stringify(altered, null, 2)}\n`;
    await writeFile(join(directory, reference.path), bytes, "utf8");
    await expect(readVerifiedGithubEffectPreview({
      run_dir: directory,
      reference: { ...reference, sha256: hash(bytes) },
      expected: { phase: "issue_sync", lineage_id: lineageId, run_id: "run-1", plan_revision: 1, plan_sha256: planSha },
    })).rejects.toThrow(/effect.*invalid|requires/i);
  });

  it("refuses an ancestor symlink during verified read", async () => {
    const directory = await runDir();
    const outside = await runDir();
    const preview = planIssueSyncPreview(issueInput());
    const reference = await writeGithubEffectPreview({ run_dir: directory, preview });
    const bytes = await readFile(join(directory, reference.path), "utf8");
    await mkdir(join(outside, "issue-sync"), { recursive: true });
    await writeFile(join(outside, "issue-sync", "revision-1.json"), bytes, "utf8");
    await rm(join(directory, "github-effects"), { recursive: true });
    await symlink(outside, join(directory, "github-effects"));
    await expect(readVerifiedGithubEffectPreview({
      run_dir: directory,
      reference,
      expected: { phase: "issue_sync", lineage_id: lineageId, run_id: "run-1", plan_revision: 1, plan_sha256: planSha },
    })).rejects.toThrow(/symlink|escaped/i);
  });

  it("rejects a coherently rehashed preview revision that disagrees with its canonical reference path", async () => {
    const directory = await runDir();
    const preview = planIssueSyncPreview(issueInput());
    const reference = await writeGithubEffectPreview({ run_dir: directory, preview });
    const changed = { ...preview, revision: 2, preview_sha256: "" };
    const { preview_sha256: _ignored, ...unsigned } = changed;
    changed.preview_sha256 = hash(`${JSON.stringify(unsigned, null, 2)}\n`);
    const bytes = `${JSON.stringify(changed, null, 2)}\n`;
    await writeFile(join(directory, reference.path), bytes, "utf8");
    await expect(readVerifiedGithubEffectPreview({
      run_dir: directory,
      reference: { ...reference, sha256: hash(bytes) },
      expected: {
        phase: "issue_sync",
        lineage_id: lineageId,
        run_id: "run-1",
        plan_revision: 1,
        plan_sha256: planSha,
      },
    })).rejects.toThrow(/revision/i);
  });
});
