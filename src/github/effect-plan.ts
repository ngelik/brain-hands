import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { writeImmutableTextArtifact } from "../core/ledger.js";
import type {
  GithubEffectPhase,
  GithubEffectPreviewRef as CoreGithubEffectPreviewRef,
} from "../core/types.js";
import type { TaskLineageState } from "../core/task-lineage.js";

export type GithubEffectPreviewRef = CoreGithubEffectPreviewRef;

type IssueState = "OPEN" | "CLOSED";
type IssueStateReason = "COMPLETED" | "NOT_PLANNED" | null;
type PullRequestState = "OPEN" | "CLOSED" | "MERGED";

export interface GithubEffectRepository {
  host: string;
  name_with_owner: string;
}

export interface DesiredIssueMaterial {
  title: string;
  body: string;
  labels: string[];
  state: IssueState;
  state_reason: IssueStateReason;
  reason_code: string;
}

export interface ObservedIssueMaterial {
  number: number;
  title: string;
  body: string;
  labels: string[];
  state: IssueState;
  state_reason: IssueStateReason;
}

export interface IssueSyncPlanningInput {
  revision: number;
  lineage_id: string;
  run_id: string;
  repository: GithubEffectRepository;
  plan_revision: number;
  plan_sha256: string;
  created_at: string;
  lineage_state: TaskLineageState;
  issue_set: {
    state: "uninitialized" | "applying" | "ready" | "ambiguous";
    plan_revision: number | null;
    plan_sha256: string | null;
    parent_issue_number: number | null;
    work_item_issue_map: Record<string, number>;
    has_prior_owned_state: boolean;
  };
  approved_replan: boolean;
  parent: {
    feature_slug: string;
    desired: DesiredIssueMaterial;
    observations: ObservedIssueMaterial[];
  } | null;
  work_items: Array<{
    work_item_id: string;
    desired: DesiredIssueMaterial;
    observations: ObservedIssueMaterial[];
  }>;
}

export interface DesiredPullRequestMaterial {
  title: string;
  body: string;
  head_ref: string;
  head_sha: string;
  base_ref: string;
  closing_issue_numbers: number[];
  reason_code: string;
}

export interface ObservedPullRequestMaterial {
  number: number;
  url: string;
  title: string;
  body: string;
  head_ref: string;
  head_sha: string;
  base_ref: string;
  closing_issue_numbers: number[];
  state: PullRequestState;
}

export interface PullRequestDeliveryPlanningInput {
  revision: number;
  lineage_id: string;
  run_id: string;
  repository: GithubEffectRepository;
  plan_revision: number;
  plan_sha256: string;
  created_at: string;
  lineage_state: TaskLineageState;
  authorized_prior_head_sha?: string | null;
  branch: {
    branch_name: string;
    head_sha: string;
    observed_head_sha: string | null;
    reason_code: string;
  };
  pull_request: {
    desired: DesiredPullRequestMaterial;
    observations: ObservedPullRequestMaterial[];
  };
}

export type GithubEffect =
  | { effect_id: string; target: { kind: "parent"; feature_slug: string }; action: "create" | "reuse" | "update"; existing_number: number | null; observed_sha256: string | null; desired_sha256: string; reason_code: string }
  | { effect_id: string; target: { kind: "work_item"; work_item_id: string }; action: "create" | "reuse" | "update"; existing_number: number | null; observed_sha256: string | null; desired_sha256: string; reason_code: string }
  | { effect_id: string; target: { kind: "branch"; branch_name: string }; action: "push" | "noop"; observed_sha256: string | null; desired_sha256: string; reason_code: string }
  | { effect_id: string; target: { kind: "pull_request" }; action: "open" | "reuse" | "repair" | "noop"; existing_number: number | null; observed_sha256: string | null; desired_sha256: string; reason_code: string };

export interface GithubEffectPreviewV1 {
  version: 1;
  phase: GithubEffectPhase;
  revision: number;
  lineage_id: string;
  run_id: string;
  repository: GithubEffectRepository;
  plan_revision: number;
  plan_sha256: string;
  authorized_prior_head_sha?: string | null;
  observation_sha256: string;
  desired_sha256: string;
  effects: GithubEffect[];
  created_at: string;
  preview_sha256: string;
}

export type GithubEffectPlanningErrorCode =
  | "ambiguous-marker"
  | "missing-owned-issue"
  | "ownership-mismatch"
  | "unapproved-extension"
  | "removed-owned-work-item"
  | "terminal-lineage"
  | "ambiguous-pull-request"
  | "pull-request-target-mismatch"
  | "pull-request-state-mismatch";

export class GithubEffectPlanningError extends Error {
  constructor(
    public readonly code: GithubEffectPlanningErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "GithubEffectPlanningError";
  }
}

const terminalLineageStates = new Set<TaskLineageState>(["completed", "abandoned", "closed_blocked"]);
const sha256Pattern = /^[a-f0-9]{64}$/;

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalValue);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => compareCodePoints(left, right))
      .map(([key, entry]) => [key, canonicalValue(entry)]));
  }
  return value;
}

function canonical(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value), "utf8").digest("hex");
}

function canonicalIssueDesired(desired: DesiredIssueMaterial): DesiredIssueMaterial {
  return {
    title: desired.title,
    body: desired.body,
    labels: [...desired.labels].sort(compareCodePoints),
    state: desired.state,
    state_reason: desired.state_reason,
    reason_code: desired.reason_code,
  };
}

function canonicalIssueObservation(observed: ObservedIssueMaterial): ObservedIssueMaterial {
  return {
    number: observed.number,
    title: observed.title,
    body: observed.body,
    labels: [...observed.labels].sort(compareCodePoints),
    state: observed.state,
    state_reason: observed.state_reason,
  };
}

function issueRemoteMaterial(desired: DesiredIssueMaterial): Omit<DesiredIssueMaterial, "reason_code"> {
  const canonicalDesired = canonicalIssueDesired(desired);
  const { reason_code: _reasonCode, ...remote } = canonicalDesired;
  return remote;
}

function observedIssueRemoteMaterial(observed: ObservedIssueMaterial): Omit<ObservedIssueMaterial, "number"> {
  const canonicalObserved = canonicalIssueObservation(observed);
  const { number: _number, ...remote } = canonicalObserved;
  return remote;
}

function effectId(
  phase: GithubEffectPhase,
  lineageId: string,
  target: GithubEffect["target"],
  observedSha256: string | null,
  desiredSha256: string,
  action: GithubEffect["action"],
): string {
  return digest({ phase, lineage_id: lineageId, target, observed_sha256: observedSha256, desired_sha256: desiredSha256, action });
}

export type IssueTarget = { kind: "parent"; feature_slug: string } | { kind: "work_item"; work_item_id: string };

export function issueDesiredMaterialSha256(target: IssueTarget, desired: DesiredIssueMaterial): string {
  return digest({ target, material: canonicalIssueDesired(desired) });
}

export function issueObservedMaterialSha256(target: IssueTarget, observed: ObservedIssueMaterial): string {
  return digest({ target, material: canonicalIssueObservation(observed) });
}

function planIssueTarget(input: {
  lineageId: string;
  target: IssueTarget;
  desired: DesiredIssueMaterial;
  observations: ObservedIssueMaterial[];
  mappedNumber: number | null;
  allowUnmappedOwnership: boolean;
}): GithubEffect {
  const observations = input.observations.map(canonicalIssueObservation).sort((left, right) => left.number - right.number);
  if (observations.length > 1) {
    throw new GithubEffectPlanningError("ambiguous-marker", "Multiple GitHub issues claim the same lineage target");
  }
  const observed = observations[0] ?? null;
  if (input.mappedNumber !== null && observed === null) {
    throw new GithubEffectPlanningError("missing-owned-issue", "A lineage-owned GitHub issue is missing");
  }
  if (input.mappedNumber !== null && observed?.number !== input.mappedNumber) {
    throw new GithubEffectPlanningError("ownership-mismatch", "Observed GitHub issue does not match the lineage mapping");
  }
  if (input.mappedNumber === null && !input.allowUnmappedOwnership) {
    throw new GithubEffectPlanningError(
      observed === null ? "missing-owned-issue" : "ownership-mismatch",
      observed === null ? "An authoritative GitHub issue mapping is missing" : "Observed GitHub issue has no authoritative lineage mapping",
    );
  }

  const desired = canonicalIssueDesired(input.desired);
  const desiredSha256 = issueDesiredMaterialSha256(input.target, desired);
  const observedSha256 = observed === null ? null : issueObservedMaterialSha256(input.target, observed);
  const action: "create" | "reuse" | "update" = observed === null
    ? "create"
    : canonical(issueRemoteMaterial(desired)) === canonical(observedIssueRemoteMaterial(observed)) ? "reuse" : "update";
  const id = effectId("issue_sync", input.lineageId, input.target, observedSha256, desiredSha256, action);
  const existingNumber = observed?.number ?? null;
  const reasonCode = action === "create" ? "owned-issue-absent" : action === "reuse" ? "owned-issue-exact" : "owned-material-drift";
  return input.target.kind === "parent"
    ? {
        effect_id: id,
        target: input.target,
        action,
        existing_number: existingNumber,
        observed_sha256: observedSha256,
        desired_sha256: desiredSha256,
        reason_code: reasonCode,
      }
    : {
        effect_id: id,
        target: input.target,
        action,
        existing_number: existingNumber,
        observed_sha256: observedSha256,
        desired_sha256: desiredSha256,
        reason_code: reasonCode,
      };
}

function buildPreview(input: {
  phase: GithubEffectPhase;
  revision: number;
  lineage_id: string;
  run_id: string;
  repository: GithubEffectRepository;
  plan_revision: number;
  plan_sha256: string;
  authorized_prior_head_sha?: string | null;
  observation: unknown;
  desired: unknown;
  effects: GithubEffect[];
  created_at: string;
}): GithubEffectPreviewV1 {
  const unsigned = {
    version: 1 as const,
    phase: input.phase,
    revision: input.revision,
    lineage_id: input.lineage_id,
    run_id: input.run_id,
    repository: { host: input.repository.host, name_with_owner: input.repository.name_with_owner },
    plan_revision: input.plan_revision,
    plan_sha256: input.plan_sha256,
    ...(input.phase === "pull_request_delivery"
      ? { authorized_prior_head_sha: input.authorized_prior_head_sha ?? null }
      : {}),
    observation_sha256: digest(input.observation),
    desired_sha256: digest(input.desired),
    effects: input.effects,
    created_at: input.created_at,
  };
  const previewSha256 = createHash("sha256").update(`${JSON.stringify(unsigned, null, 2)}\n`, "utf8").digest("hex");
  return { ...unsigned, preview_sha256: previewSha256 };
}

export function planIssueSyncPreview(input: IssueSyncPlanningInput): GithubEffectPreviewV1 {
  if (input.issue_set.state === "ambiguous") {
    throw new GithubEffectPlanningError("ambiguous-marker", "An ambiguous issue operation must be reconciled before planning");
  }
  const workItems = [...input.work_items].sort((left, right) => compareCodePoints(left.work_item_id, right.work_item_id));
  if (new Set(workItems.map((item) => item.work_item_id)).size !== workItems.length) {
    throw new GithubEffectPlanningError("ambiguous-marker", "Work-item IDs must be unique");
  }
  const desiredIds = new Set(workItems.map((item) => item.work_item_id));
  const mappedIds = Object.keys(input.issue_set.work_item_issue_map).sort(compareCodePoints);
  if (input.parent === null && input.issue_set.parent_issue_number !== null) {
    throw new GithubEffectPlanningError("removed-owned-work-item", "An approved plan cannot remove a lineage-owned parent issue");
  }
  if (mappedIds.some((id) => !desiredIds.has(id))) {
    throw new GithubEffectPlanningError("removed-owned-work-item", "An approved plan cannot remove a lineage-owned work item");
  }
  const addedIds = workItems.filter((item) => !(item.work_item_id in input.issue_set.work_item_issue_map));
  const isInitial = input.issue_set.state === "uninitialized"
    && input.issue_set.plan_revision === null
    && input.issue_set.plan_sha256 === null
    && input.issue_set.parent_issue_number === null
    && mappedIds.length === 0
    && !input.issue_set.has_prior_owned_state;
  const extendsByApprovedReplan = input.approved_replan
    && input.issue_set.plan_revision !== null
    && input.plan_revision > input.issue_set.plan_revision;
  if (!isInitial && addedIds.length > 0 && !extendsByApprovedReplan) {
    throw new GithubEffectPlanningError("unapproved-extension", "Normal resume cannot add work-item IDs");
  }

  const issueNumberOwners = new Map<number, string>();
  const registerIssueNumber = (number: number, targetKey: string): void => {
    if (!Number.isInteger(number) || number <= 0) {
      throw new GithubEffectPlanningError("ownership-mismatch", "Owned issue numbers must be positive integers");
    }
    const owner = issueNumberOwners.get(number);
    if (owner !== undefined && owner !== targetKey) {
      throw new GithubEffectPlanningError("ownership-mismatch", "One GitHub issue number cannot belong to multiple lineage targets");
    }
    issueNumberOwners.set(number, targetKey);
  };
  if (input.issue_set.parent_issue_number !== null) registerIssueNumber(input.issue_set.parent_issue_number, "parent");
  for (const [workItemId, number] of Object.entries(input.issue_set.work_item_issue_map)) {
    registerIssueNumber(number, `work_item:${workItemId}`);
  }
  for (const observation of input.parent?.observations ?? []) registerIssueNumber(observation.number, "parent");
  for (const item of workItems) {
    for (const observation of item.observations) registerIssueNumber(observation.number, `work_item:${item.work_item_id}`);
  }

  const effects: GithubEffect[] = input.parent === null ? [] : [planIssueTarget({
    lineageId: input.lineage_id,
    target: { kind: "parent", feature_slug: input.parent.feature_slug },
    desired: input.parent.desired,
    observations: input.parent.observations,
    mappedNumber: input.issue_set.parent_issue_number,
    allowUnmappedOwnership: isInitial,
  })];
  for (const item of workItems) {
    effects.push(planIssueTarget({
      lineageId: input.lineage_id,
      target: { kind: "work_item", work_item_id: item.work_item_id },
      desired: item.desired,
      observations: item.observations,
      mappedNumber: input.issue_set.work_item_issue_map[item.work_item_id] ?? null,
      allowUnmappedOwnership: isInitial || (extendsByApprovedReplan && addedIds.includes(item)),
    }));
  }
  if (terminalLineageStates.has(input.lineage_state) && effects.some((effect) => effect.action === "create")) {
    throw new GithubEffectPlanningError("terminal-lineage", "A terminal lineage cannot create GitHub issues");
  }

  const observation = {
    control: {
      lineage_state: input.lineage_state,
      approved_replan: input.approved_replan,
      current_plan_revision: input.plan_revision,
      current_plan_sha256: input.plan_sha256,
      issue_set: {
        state: input.issue_set.state,
        plan_revision: input.issue_set.plan_revision,
        plan_sha256: input.issue_set.plan_sha256,
        parent_issue_number: input.issue_set.parent_issue_number,
        work_item_issue_map: Object.fromEntries(Object.entries(input.issue_set.work_item_issue_map)
          .sort(([left], [right]) => compareCodePoints(left, right))),
        has_prior_owned_state: input.issue_set.has_prior_owned_state,
      },
    },
    parent: input.parent?.observations.map(canonicalIssueObservation) ?? null,
    work_items: workItems.map((item) => ({
      work_item_id: item.work_item_id,
      observations: item.observations.map(canonicalIssueObservation),
    })),
  };
  const desired = {
    parent: input.parent === null ? null : canonicalIssueDesired(input.parent.desired),
    work_items: workItems.map((item) => ({ work_item_id: item.work_item_id, desired: canonicalIssueDesired(item.desired) })),
  };
  return buildPreview({ ...input, phase: "issue_sync", observation, desired, effects });
}

function canonicalPullRequestDesired(desired: DesiredPullRequestMaterial): DesiredPullRequestMaterial {
  return {
    title: desired.title,
    body: desired.body,
    head_ref: desired.head_ref,
    head_sha: desired.head_sha,
    base_ref: desired.base_ref,
    closing_issue_numbers: [...desired.closing_issue_numbers].sort((left, right) => compareCodePoints(String(left), String(right))),
    reason_code: desired.reason_code,
  };
}

function canonicalPullRequestObservation(observed: ObservedPullRequestMaterial): ObservedPullRequestMaterial {
  return {
    number: observed.number,
    url: observed.url,
    title: observed.title,
    body: observed.body,
    head_ref: observed.head_ref,
    head_sha: observed.head_sha,
    base_ref: observed.base_ref,
    closing_issue_numbers: [...observed.closing_issue_numbers].sort((left, right) => compareCodePoints(String(left), String(right))),
    state: observed.state,
  };
}

function pullRequestRemoteMaterial(desired: DesiredPullRequestMaterial): Omit<DesiredPullRequestMaterial, "reason_code"> {
  const canonicalDesired = canonicalPullRequestDesired(desired);
  const { reason_code: _reasonCode, ...remote } = canonicalDesired;
  return remote;
}

function observedPullRequestRemoteMaterial(observed: ObservedPullRequestMaterial): Omit<ObservedPullRequestMaterial, "number" | "url" | "state"> {
  const canonicalObserved = canonicalPullRequestObservation(observed);
  const { number: _number, url: _url, state: _state, ...remote } = canonicalObserved;
  return remote;
}

export function planPullRequestDeliveryPreview(input: PullRequestDeliveryPlanningInput): GithubEffectPreviewV1 {
  if (input.branch.branch_name !== input.pull_request.desired.head_ref
    || input.branch.head_sha !== input.pull_request.desired.head_sha) {
    throw new GithubEffectPlanningError("pull-request-target-mismatch", "Desired pull request does not match the delivery branch and head");
  }
  const branchTarget = { kind: "branch" as const, branch_name: input.branch.branch_name };
  const branchDesired = {
    branch_name: input.branch.branch_name,
    head_sha: input.branch.head_sha,
    reason_code: input.branch.reason_code,
  };
  const branchObservation = input.branch.observed_head_sha === null
    ? null
    : { branch_name: input.branch.branch_name, head_sha: input.branch.observed_head_sha };
  const branchDesiredSha256 = digest({ target: branchTarget, material: branchDesired });
  const branchObservedSha256 = branchObservation === null ? null : digest({ target: branchTarget, material: branchObservation });
  const branchAction = input.branch.observed_head_sha === input.branch.head_sha ? "noop" : "push";
  const branchEffect: Extract<GithubEffect, { action: "push" | "noop" }> = {
    effect_id: effectId("pull_request_delivery", input.lineage_id, branchTarget, branchObservedSha256, branchDesiredSha256, branchAction),
    target: branchTarget,
    action: branchAction,
    observed_sha256: branchObservedSha256,
    desired_sha256: branchDesiredSha256,
    reason_code: input.branch.observed_head_sha === null
      ? "branch-absent"
      : branchAction === "noop" ? "branch-head-exact" : "branch-head-drift",
  };

  const observations = input.pull_request.observations
    .map(canonicalPullRequestObservation)
    .sort((left, right) => left.number - right.number);
  if (observations.length > 1) {
    throw new GithubEffectPlanningError("ambiguous-pull-request", "Multiple pull requests claim the task lineage");
  }
  const desired = canonicalPullRequestDesired(input.pull_request.desired);
  const observed = observations[0] ?? null;
  if (observed !== null && (
    observed.head_ref !== desired.head_ref
    || (observed.head_sha !== desired.head_sha && observed.head_sha !== input.authorized_prior_head_sha)
    || observed.base_ref !== desired.base_ref
  )) {
    throw new GithubEffectPlanningError("pull-request-target-mismatch", "Owned pull request head or base does not match delivery");
  }
  const prTarget = { kind: "pull_request" as const };
  const prDesiredSha256 = digest({ target: prTarget, material: desired });
  const prObservedSha256 = observed === null ? null : digest({ target: prTarget, material: observed });
  const exact = observed !== null
    && canonical(pullRequestRemoteMaterial(desired)) === canonical(observedPullRequestRemoteMaterial(observed));
  if (observed?.state === "CLOSED" && !exact) {
    throw new GithubEffectPlanningError("pull-request-state-mismatch", "A closed pull request cannot be repaired");
  }
  if (observed?.state === "MERGED" && !exact) {
    throw new GithubEffectPlanningError("pull-request-state-mismatch", "A merged pull request cannot be repaired");
  }
  const prAction = observed === null ? "open" : observed.state === "MERGED" || observed.state === "CLOSED"
    ? "noop" : exact ? "reuse" : "repair";
  if (prAction === "open" && terminalLineageStates.has(input.lineage_state)) {
    throw new GithubEffectPlanningError("terminal-lineage", "A terminal lineage cannot open a pull request");
  }
  const prEffect: Extract<GithubEffect, { target: { kind: "pull_request" } }> = {
    effect_id: effectId("pull_request_delivery", input.lineage_id, prTarget, prObservedSha256, prDesiredSha256, prAction),
    target: prTarget,
    action: prAction,
    existing_number: observed?.number ?? null,
    observed_sha256: prObservedSha256,
    desired_sha256: prDesiredSha256,
    reason_code: prAction === "open" ? "lineage-pull-request-absent"
      : prAction === "reuse" ? "pull-request-exact"
        : prAction === "repair" ? "pull-request-managed-drift" : "pull-request-terminal",
  };

  return buildPreview({
    ...input,
    phase: "pull_request_delivery",
    authorized_prior_head_sha: input.authorized_prior_head_sha ?? null,
    observation: { authorized_prior_head_sha: input.authorized_prior_head_sha ?? null, branch: branchObservation, pull_requests: observations },
    desired: { authorized_prior_head_sha: input.authorized_prior_head_sha ?? null, branch: branchDesired, pull_request: desired },
    effects: [branchEffect, prEffect],
  });
}

function expectedPath(phase: GithubEffectPhase, revision: number): string {
  const phaseDirectory = phase === "issue_sync" ? "issue-sync" : "pull-request-delivery";
  return `github-effects/${phaseDirectory}/revision-${revision}.json`;
}

function assertPreviewShape(value: unknown): asserts value is GithubEffectPreviewV1 {
  if (value === null || typeof value !== "object") throw new Error("GitHub effect preview must be an object");
  const preview = value as Partial<GithubEffectPreviewV1>;
  if (preview.version !== 1
    || (preview.phase !== "issue_sync" && preview.phase !== "pull_request_delivery")
    || !Number.isInteger(preview.revision) || (preview.revision ?? 0) <= 0
    || typeof preview.lineage_id !== "string"
    || typeof preview.run_id !== "string"
    || preview.repository === undefined
    || typeof preview.repository.host !== "string"
    || typeof preview.repository.name_with_owner !== "string"
    || !Number.isInteger(preview.plan_revision) || (preview.plan_revision ?? 0) <= 0
    || typeof preview.plan_sha256 !== "string" || !sha256Pattern.test(preview.plan_sha256)
    || (preview.phase === "pull_request_delivery"
      && !(preview.authorized_prior_head_sha === null
        || (typeof preview.authorized_prior_head_sha === "string" && /^[a-f0-9]{40,64}$/.test(preview.authorized_prior_head_sha))))
    || (preview.phase === "issue_sync" && preview.authorized_prior_head_sha !== undefined)
    || typeof preview.observation_sha256 !== "string" || !sha256Pattern.test(preview.observation_sha256)
    || typeof preview.desired_sha256 !== "string" || !sha256Pattern.test(preview.desired_sha256)
    || !Array.isArray(preview.effects)
    || typeof preview.created_at !== "string"
    || typeof preview.preview_sha256 !== "string" || !sha256Pattern.test(preview.preview_sha256)) {
    throw new Error("GitHub effect preview is invalid");
  }
}

function positiveNumberOrNull(value: unknown, label: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) throw new Error(`${label} is invalid`);
  return value;
}

function effectDigest(value: unknown, label: string, nullable = false): string | null {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || !sha256Pattern.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function sanitizeEffect(effect: GithubEffect): GithubEffect {
  if (effect === null || typeof effect !== "object" || effect.target === null || typeof effect.target !== "object") {
    throw new Error("GitHub effect is invalid");
  }
  const effectIdValue = effectDigest(effect.effect_id, "GitHub effect ID")!;
  const observedSha256 = effectDigest(effect.observed_sha256, "GitHub effect observed digest", true);
  const desiredSha256 = effectDigest(effect.desired_sha256, "GitHub effect desired digest")!;
  const reasonCode = typeof effect.reason_code === "string" && effect.reason_code.length > 0
    ? effect.reason_code
    : (() => { throw new Error("GitHub effect reason code is invalid"); })();
  if (effect.target.kind === "parent") {
    if (typeof effect.target.feature_slug !== "string" || effect.target.feature_slug.length === 0) throw new Error("Parent effect feature slug is invalid");
    if (!(["create", "reuse", "update"] as const).includes(effect.action as "create")) throw new Error("Parent effect action is invalid");
    const existingNumber = positiveNumberOrNull("existing_number" in effect ? effect.existing_number : undefined, "Parent issue number");
    if (effect.action === "create" && (existingNumber !== null || observedSha256 !== null)) {
      throw new Error("Issue create effect requires null existing number and observed digest");
    }
    if (effect.action !== "create" && (existingNumber === null || observedSha256 === null)) {
      throw new Error("Issue reuse/update effect requires an existing number and observed digest");
    }
    return {
      effect_id: effectIdValue,
      target: { kind: "parent", feature_slug: effect.target.feature_slug },
      action: effect.action as "create" | "reuse" | "update",
      existing_number: existingNumber,
      observed_sha256: observedSha256,
      desired_sha256: desiredSha256,
      reason_code: reasonCode,
    };
  }
  if (effect.target.kind === "work_item") {
    if (typeof effect.target.work_item_id !== "string" || effect.target.work_item_id.length === 0) throw new Error("Work-item effect ID is invalid");
    if (!(["create", "reuse", "update"] as const).includes(effect.action as "create")) throw new Error("Work-item effect action is invalid");
    const existingNumber = positiveNumberOrNull("existing_number" in effect ? effect.existing_number : undefined, "Work-item issue number");
    if (effect.action === "create" && (existingNumber !== null || observedSha256 !== null)) {
      throw new Error("Issue create effect requires null existing number and observed digest");
    }
    if (effect.action !== "create" && (existingNumber === null || observedSha256 === null)) {
      throw new Error("Issue reuse/update effect requires an existing number and observed digest");
    }
    return {
      effect_id: effectIdValue,
      target: { kind: "work_item", work_item_id: effect.target.work_item_id },
      action: effect.action as "create" | "reuse" | "update",
      existing_number: existingNumber,
      observed_sha256: observedSha256,
      desired_sha256: desiredSha256,
      reason_code: reasonCode,
    };
  }
  if (effect.target.kind === "branch") {
    if (typeof effect.target.branch_name !== "string" || effect.target.branch_name.length === 0) throw new Error("Branch effect name is invalid");
    if (effect.action !== "push" && effect.action !== "noop") throw new Error("Branch effect action is invalid");
    if (effect.action === "noop" && observedSha256 === null) throw new Error("Branch noop effect requires an observed digest");
    return {
      effect_id: effectIdValue,
      target: { kind: "branch", branch_name: effect.target.branch_name },
      action: effect.action,
      observed_sha256: observedSha256,
      desired_sha256: desiredSha256,
      reason_code: reasonCode,
    };
  }
  if (effect.target.kind === "pull_request") {
    if (!(["open", "reuse", "repair", "noop"] as const).includes(effect.action as "open")) throw new Error("Pull-request effect action is invalid");
    const existingNumber = positiveNumberOrNull("existing_number" in effect ? effect.existing_number : undefined, "Pull-request number");
    if (effect.action === "open" && (existingNumber !== null || observedSha256 !== null)) {
      throw new Error("Pull-request open effect requires null existing number and observed digest");
    }
    if (effect.action !== "open" && (existingNumber === null || observedSha256 === null)) {
      throw new Error("Pull-request reuse/repair/noop effect requires an existing number and observed digest");
    }
    return {
      effect_id: effectIdValue,
      target: { kind: "pull_request" },
      action: effect.action as "open" | "reuse" | "repair" | "noop",
      existing_number: existingNumber,
      observed_sha256: observedSha256,
      desired_sha256: desiredSha256,
      reason_code: reasonCode,
    };
  }
  throw new Error("GitHub effect target is invalid");
}

function effectOrder(effect: GithubEffect): string {
  if (effect.target.kind === "parent") return `0-parent:${effect.target.feature_slug}`;
  if (effect.target.kind === "work_item") return `1-work-item:${effect.target.work_item_id}`;
  if (effect.target.kind === "branch") return `0-branch:${effect.target.branch_name}`;
  return "1-pull-request";
}

function sanitizePreview(preview: GithubEffectPreviewV1): GithubEffectPreviewV1 {
  assertPreviewShape(preview);
  const effects = preview.effects.map(sanitizeEffect);
  const effectIds = new Set<string>();
  const targetKeys = new Set<string>();
  for (const effect of effects) {
    if (effectIds.has(effect.effect_id)) throw new Error("GitHub effect preview contains a duplicate effect ID");
    effectIds.add(effect.effect_id);
    const targetKey = effectOrder(effect);
    if (targetKeys.has(targetKey)) throw new Error("GitHub effect preview contains a duplicate target");
    targetKeys.add(targetKey);
  }
  if (preview.phase === "issue_sync" && effects.some((effect) => effect.target.kind === "branch" || effect.target.kind === "pull_request")) {
    throw new Error("Issue-sync preview contains a delivery effect");
  }
  if (preview.phase === "pull_request_delivery" && effects.some((effect) => effect.target.kind === "parent" || effect.target.kind === "work_item")) {
    throw new Error("Delivery preview contains an issue effect");
  }
  if (preview.phase === "issue_sync" && effects.filter((effect) => effect.target.kind === "parent").length > 1) {
    throw new Error("Issue-sync preview permits at most one parent effect");
  }
  if (preview.phase === "pull_request_delivery" && (
    effects.filter((effect) => effect.target.kind === "branch").length !== 1
    || effects.filter((effect) => effect.target.kind === "pull_request").length !== 1
    || effects.length !== 2
  )) {
    throw new Error("Delivery preview requires exactly one branch and one pull-request effect");
  }
  effects.sort((left, right) => compareCodePoints(effectOrder(left), effectOrder(right)));
  for (const effect of effects) {
    const expected = effectId(
      preview.phase,
      preview.lineage_id,
      effect.target,
      effect.observed_sha256,
      effect.desired_sha256,
      effect.action,
    );
    if (effect.effect_id !== expected) throw new Error("GitHub effect ID does not match its canonical binding");
  }
  return {
    version: 1,
    phase: preview.phase,
    revision: preview.revision,
    lineage_id: preview.lineage_id,
    run_id: preview.run_id,
    repository: { host: preview.repository.host, name_with_owner: preview.repository.name_with_owner },
    plan_revision: preview.plan_revision,
    plan_sha256: preview.plan_sha256,
    ...(preview.phase === "pull_request_delivery"
      ? { authorized_prior_head_sha: preview.authorized_prior_head_sha ?? null }
      : {}),
    observation_sha256: preview.observation_sha256,
    desired_sha256: preview.desired_sha256,
    effects,
    created_at: preview.created_at,
    preview_sha256: preview.preview_sha256,
  };
}

function internalPreviewDigest(preview: GithubEffectPreviewV1): string {
  const { preview_sha256: _recorded, ...unsigned } = preview;
  return createHash("sha256").update(`${JSON.stringify(unsigned, null, 2)}\n`, "utf8").digest("hex");
}

export function canonicalGithubEffectPreview(preview: GithubEffectPreviewV1): string {
  return `${JSON.stringify(sanitizePreview(preview), null, 2)}\n`;
}

export function renderGithubEffectPreview(preview: GithubEffectPreviewV1): string {
  return canonicalGithubEffectPreview(preview);
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code : undefined;
}

function isContained(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

async function captureRunDirectory(runDir: string): Promise<string> {
  const lexical = resolve(runDir);
  const status = await lstat(lexical);
  if (status.isSymbolicLink()) throw new Error("GitHub effect run directory must not be a symlink");
  if (!status.isDirectory()) throw new Error("GitHub effect run directory must be a directory");
  return realpath(lexical);
}

async function captureArtifactDirectory(
  runRoot: string,
  parent: string,
  name: string,
  create: boolean,
): Promise<string> {
  if (!isContained(runRoot, parent)) throw new Error("GitHub effect artifact parent escaped the run directory");
  const target = resolve(parent, name);
  if (!isContained(runRoot, target)) throw new Error("GitHub effect artifact directory escaped the run directory");
  let status = await lstat(target).catch((error: unknown) => {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  });
  if (status === null) {
    if (!create) throw new Error("GitHub effect artifact directory is missing");
    await mkdir(target);
    status = await lstat(target);
  }
  if (status.isSymbolicLink()) throw new Error("GitHub effect artifact directory must not be a symlink");
  if (!status.isDirectory()) throw new Error("GitHub effect artifact path component must be a directory");
  const captured = await realpath(target);
  if (!isContained(runRoot, captured)) throw new Error("GitHub effect artifact directory escaped the run directory");
  return captured;
}

async function captureArtifactParent(runRoot: string, phase: GithubEffectPhase, create: boolean): Promise<string> {
  const effects = await captureArtifactDirectory(runRoot, runRoot, "github-effects", create);
  return captureArtifactDirectory(
    runRoot,
    effects,
    phase === "issue_sync" ? "issue-sync" : "pull-request-delivery",
    create,
  );
}

async function captureArtifactFile(runRoot: string, parent: string, filename: string): Promise<string> {
  const target = resolve(parent, filename);
  if (!isContained(runRoot, target)) throw new Error("GitHub effect artifact file escaped the run directory");
  const status = await lstat(target);
  if (status.isSymbolicLink() || !status.isFile()) throw new Error("GitHub effect preview must be a regular file, not a symlink");
  const captured = await realpath(target);
  if (!isContained(runRoot, captured)) throw new Error("GitHub effect artifact file escaped the run directory");
  return captured;
}

export async function writeGithubEffectPreview(input: {
  run_dir: string;
  preview: GithubEffectPreviewV1;
}): Promise<GithubEffectPreviewRef> {
  const path = expectedPath(input.preview.phase, input.preview.revision);
  const sanitized = sanitizePreview(input.preview);
  if (sanitized.preview_sha256 !== internalPreviewDigest(sanitized)) {
    throw new Error("GitHub effect preview internal digest does not match");
  }
  const bytes = canonicalGithubEffectPreview(sanitized);
  const runRoot = await captureRunDirectory(input.run_dir);
  const parent = await captureArtifactParent(runRoot, input.preview.phase, true);
  try {
    await writeImmutableTextArtifact(runRoot, path, bytes);
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
    const existingPath = await captureArtifactFile(runRoot, parent, `revision-${input.preview.revision}.json`);
    const existing = await readFile(existingPath, "utf8");
    if (existing !== bytes) throw new Error("Existing immutable GitHub effect preview has different bytes");
  }
  return {
    phase: input.preview.phase,
    revision: input.preview.revision,
    path,
    sha256: createHash("sha256").update(bytes, "utf8").digest("hex"),
    plan_revision: input.preview.plan_revision,
    plan_sha256: input.preview.plan_sha256,
    state: "previewed",
  };
}

export async function readVerifiedGithubEffectPreview(input: {
  run_dir: string;
  reference: GithubEffectPreviewRef;
  expected: {
    phase: GithubEffectPhase;
    lineage_id: string;
    run_id: string;
    plan_revision: number;
    plan_sha256: string;
  };
}): Promise<GithubEffectPreviewV1> {
  const canonicalPath = expectedPath(input.reference.phase, input.reference.revision);
  if (input.reference.path !== canonicalPath) throw new Error("GitHub effect preview path is not canonical");
  if (input.reference.phase !== input.expected.phase) throw new Error("GitHub effect preview reference phase does not match");
  if (input.reference.plan_revision !== input.expected.plan_revision
    || input.reference.plan_sha256 !== input.expected.plan_sha256) {
    throw new Error("GitHub effect preview reference plan binding does not match");
  }
  const runRoot = await captureRunDirectory(input.run_dir);
  const parent = await captureArtifactParent(runRoot, input.reference.phase, false);
  const target = await captureArtifactFile(runRoot, parent, `revision-${input.reference.revision}.json`);
  const bytes = await readFile(target, "utf8");
  const externalSha256 = createHash("sha256").update(bytes, "utf8").digest("hex");
  if (externalSha256 !== input.reference.sha256) throw new Error("GitHub effect preview recorded digest does not match bytes");
  const preview = JSON.parse(bytes) as unknown;
  assertPreviewShape(preview);
  if (canonicalGithubEffectPreview(preview) !== bytes) throw new Error("GitHub effect preview bytes are not canonical");
  const recordedInternalSha256 = preview.preview_sha256;
  const internalSha256 = internalPreviewDigest(preview);
  if (recordedInternalSha256 !== internalSha256) throw new Error("GitHub effect preview internal digest does not match");
  if (preview.revision !== input.reference.revision) throw new Error("GitHub effect preview revision does not match its canonical path");
  if (preview.phase !== input.expected.phase
    || preview.lineage_id !== input.expected.lineage_id
    || preview.run_id !== input.expected.run_id
    || preview.plan_revision !== input.expected.plan_revision
    || preview.plan_sha256 !== input.expected.plan_sha256) {
    throw new Error("GitHub effect preview identity or plan binding does not match");
  }
  return preview;
}
