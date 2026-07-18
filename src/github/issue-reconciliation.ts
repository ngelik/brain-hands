import { createHash, randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type {
  GitHubAdapter,
  GitHubIssueObservation,
  GitHubIssueStateReference,
  GitHubPullRequestReference,
} from "../adapters/github.js";
import { formatIssueBody, formatParentIssueBody, ISSUE_LABELS, PARENT_ISSUE_LABELS, reconcileManagedIssueBody, type ParentIssueSpec } from "../adapters/github.js";
import type { GithubCleanupBatch, RunManifestV2 } from "../core/types.js";
import { readManifestV2, readVerifiedPlanRevision, withRunLedgerTransaction, type RunLedgerTransaction, type RunLedgerTransactionHooks } from "../core/ledger.js";
import { readTaskLineage, withTaskLineageTransaction, type TaskLineageRecordV1, type TaskLineageTransaction } from "../core/task-lineage.js";
import { brainPlanSchema } from "../core/schema.js";
import { formatParentIssueTitle, formatWorkItemIssueTitle, resolveFeatureSlug } from "../core/issue-naming.js";
import { hasExactManagedStateLabel, managedStateLabelEdit } from "../core/github-labels.js";
import { issueDesiredMaterialSha256, readVerifiedGithubEffectPreview, type DesiredIssueMaterial, type GithubEffect, type GithubEffectPreviewV1 } from "./effect-plan.js";
import { assertReadyAppliedIssueSet } from "../workflow/github-issue-reconciliation.js";
import type { ResourceBudgetPort } from "../core/resource-budget.js";
import { claimExternalEffect, completeExternalEffect } from "../workflow/resource-budget.js";
import {
  deriveIssueLifecycleAction,
  expectedClosingIssueNumbers,
  missingClosingIssueNumbers,
  reconcileClosingLinksBlock,
  type GitHubIssueClosureReason,
} from "./issue-lifecycle.js";

const operationSchema = z.object({
  status: z.enum(["pending", "completed"]),
  kind: z.enum(["pull_request_links", "issue_close"]),
  target_number: z.number().int().positive(),
  reason: z.enum(["completed", "not_planned"]).nullable(),
  desired_hash: z.string().regex(/^[a-f0-9]{64}$/),
  intended_at: z.string().datetime(),
  completed_at: z.string().datetime().nullable(),
}).strict();

export const issueLifecycleCheckpointSchema = z.object({
  version: z.literal(1),
  operations: z.record(z.string().min(1), operationSchema),
}).strict();

export type IssueLifecycleCheckpoint = z.infer<typeof issueLifecycleCheckpointSchema>;

export interface IssueLifecycleReportEntry {
  number: number;
  kind: "parent" | "work_item" | "unmapped";
  work_item_id?: string;
  state: "OPEN" | "CLOSED";
  action: "keep_open" | "none" | "close" | "skip";
  reason?: GitHubIssueClosureReason;
  skip_reason?:
    | "ownership_marker_mismatch"
    | "unmapped_issue_number"
    | "ambiguous_work_item_mapping"
    | "previous_brain_hands_close_was_reopened"
    | "closed_with_different_reason"
    | "terminal_label_mismatch"
    | "remote_state_mismatch";
  applied: boolean;
}

export interface IssueLifecycleReport {
  version: 1;
  run_id: string;
  mode: "dry_run" | "apply";
  default_branch: string;
  pull_request: null | {
    number: number;
    state: "OPEN" | "CLOSED" | "MERGED";
    base_branch: string;
    default_branch_compatible: boolean;
    identity_verified: boolean;
    managed_links_verified: boolean;
    action: "none" | "update";
    edit_skip_reason:
      | "already_reconciled"
      | "identity_mismatch"
      | "non_default_base"
      | "pull_request_not_open"
      | "no_expected_issues"
      | null;
    proposed_body: string | null;
    applied: boolean;
    expected_closing_issue_numbers: number[];
    parsed_closing_issue_numbers: number[];
    missing_closing_issue_numbers: number[];
  };
  issues: IssueLifecycleReportEntry[];
  cleanup?: GithubCleanupBatch | null;
}

export interface AmbiguousIssueReconciliationReport {
  version: 1;
  run_id: string;
  lineage_id: string;
  mode: "dry_run" | "apply";
  state: "ambiguous" | "ready";
  targets: Array<{
    operation_id: string;
    target_key: string;
    match_count: number;
    issue_number?: number;
    outcome: "blocked" | "adopted" | "noop";
  }>;
}

const EMPTY_CHECKPOINT: IssueLifecycleCheckpoint = { version: 1, operations: {} };
const checkpointPath = (runDir: string): string => join(runDir, "github-issue-lifecycle.json");

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function readIssueLifecycleCheckpoint(runDir: string): Promise<IssueLifecycleCheckpoint> {
  try {
    return issueLifecycleCheckpointSchema.parse(JSON.parse(await readFile(checkpointPath(runDir), "utf8")));
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { ...EMPTY_CHECKPOINT, operations: {} };
    throw error;
  }
}

async function updateOperation(
  runDir: string,
  operationId: string,
  operation: z.infer<typeof operationSchema>,
): Promise<void> {
  const current = await readIssueLifecycleCheckpoint(runDir);
  const next = issueLifecycleCheckpointSchema.parse({
    version: 1,
    operations: { ...current.operations, [operationId]: operation },
  });
  const temporary = join(runDir, `.github-issue-lifecycle-${process.pid}-${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  await rename(temporary, checkpointPath(runDir));
}

type ReconciliationTarget =
  | { number: number; kind: "work_item"; workItemId: string }
  | { number: number; kind: "unmapped"; skipReason: "unmapped_issue_number" | "ambiguous_work_item_mapping" };

interface TaskLineageLifecycleAuthority {
  lineageId: string;
  featureSlug: string;
  targets: Array<{ number: number; kind: "parent"; featureSlug: string } | { number: number; kind: "work_item"; workItemId: string }>;
  pullRequestNumber: number;
  pullRequestUrl: string;
  branchName: string;
  headSha: string;
}

function workItemTargets(manifest: RunManifestV2): ReconciliationTarget[] {
  const mapping = { ...manifest.work_item_issue_map, ...(manifest.github_ids.work_item_issue_map ?? {}) };
  const byNumber = new Map<number, string[]>();
  for (const [workItemId, number] of Object.entries(mapping)) {
    byNumber.set(number, [...(byNumber.get(number) ?? []), workItemId]);
  }
  const orderedNumbers = [...manifest.github_ids.issue_numbers];
  for (const number of Object.values(mapping)) if (!orderedNumbers.includes(number)) orderedNumbers.push(number);
  return orderedNumbers.map((number) => {
    const workItemIds = byNumber.get(number) ?? [];
    if (workItemIds.length === 0) return { number, kind: "unmapped" as const, skipReason: "unmapped_issue_number" as const };
    if (workItemIds.length > 1) return { number, kind: "unmapped" as const, skipReason: "ambiguous_work_item_mapping" as const };
    return { number, kind: "work_item" as const, workItemId: workItemIds[0]! };
  });
}

function markerValues(body: string, name: "lineage" | "run" | "work-item" | "parent"): string[] {
  const pattern = new RegExp(`<!--\\s*brain-hands-${name}:([^>]+?)\\s*-->`, "g");
  return [...body.matchAll(pattern)].map((match) => match[1]!.trim());
}

function samePreviewIdentity(left: NonNullable<RunManifestV2["github_effects"]["issue_sync"]>, right: NonNullable<TaskLineageRecordV1["issue_set"]["preview"]>): boolean {
  return left.phase === right.phase && left.revision === right.revision && left.path === right.path
    && left.sha256 === right.sha256 && left.plan_revision === right.plan_revision && left.plan_sha256 === right.plan_sha256;
}

type IssueEffect = Extract<GithubEffect, { target: { kind: "parent" | "work_item" } }>;

function targetKey(effect: IssueEffect): string {
  return effect.target.kind === "parent" ? "parent" : `work_item:${effect.target.work_item_id}`;
}

function assertAmbiguousBinding(
  manifest: RunManifestV2,
  lineage: TaskLineageRecordV1,
  repositoryKey: string,
  preview: GithubEffectPreviewV1,
): void {
  if (manifest.task_lineage_id === null || lineage.lineage_id !== manifest.task_lineage_id
    || lineage.active_run_id !== manifest.run_id || lineage.repository_key !== repositoryKey
    || lineage.state !== "active" || preview.lineage_id !== lineage.lineage_id || preview.run_id !== manifest.run_id
    || lineage.issue_set.preview === null || manifest.github_effects.issue_sync === null
    || lineage.issue_set.preview.state === "invalidated" || manifest.github_effects.issue_sync.state === "invalidated"
    || !samePreviewIdentity(manifest.github_effects.issue_sync, lineage.issue_set.preview)) {
    throw new Error("Ambiguous issue reconciliation requires the exact active lineage, run, repository, and preview binding");
  }
}

function assertCanonicalCandidate(
  body: string,
  lineageId: string,
  runId: string,
  effect: IssueEffect,
  featureSlug: string,
): void {
  const lineage = markerValues(body, "lineage");
  const runs = markerValues(body, "run");
  const workItems = markerValues(body, "work-item");
  const parents = markerValues(body, "parent");
  const exact = lineage.length === 1 && lineage[0] === lineageId && runs.length === 1 && runs[0] === runId
    && (effect.target.kind === "parent"
      ? parents.length === 1 && parents[0] === featureSlug && workItems.length === 0
      : workItems.length === 1 && workItems[0] === effect.target.work_item_id && parents.length === 0);
  if (!exact) throw new Error("Ambiguous issue reconciliation observed malformed, mixed, or other-lineage ownership markers");
}

function desiredMaterialForEffect(
  effect: IssueEffect,
  plan: z.infer<typeof brainPlanSchema>,
  lineageId: string,
  runId: string,
  featureSlug: string,
  planRevision: number,
): DesiredIssueMaterial {
  if (effect.target.kind === "parent") {
    if (!plan.parent_issue) throw new Error("Parent issue effect is absent from the approved plan");
    const spec: ParentIssueSpec = {
      title: formatParentIssueTitle({ featureSlug, title: plan.parent_issue.title }), summary: plan.summary,
      runId, featureSlug, planRevision, workItems: [],
    };
    return { title: spec.title, body: formatParentIssueBody(spec, { lineageId, runId, featureSlug }), labels: PARENT_ISSUE_LABELS.split(","), state: "OPEN", state_reason: null, reason_code: "approved-plan-parent" };
  }
  const workItemId = effect.target.work_item_id;
  const item = plan.work_items.find((candidate) => candidate.id === workItemId);
  if (!item) throw new Error(`Work item ${workItemId} is absent from the approved plan`);
  const sequence = plan.work_items.findIndex((candidate) => candidate.id === workItemId) + 1;
  let title: string;
  try {
    title = formatWorkItemIssueTitle({ featureSlug, sequence, itemSlug: item.id, title: item.title });
  } catch (error) {
    if (plan.feature_slug !== undefined) throw error;
    title = item.title;
  }
  const marker = { lineageId, runId, workItemId: item.id };
  return { title, body: formatIssueBody(item, marker), labels: ISSUE_LABELS.split(","), state: "OPEN", state_reason: null, reason_code: "approved-plan-work-item" };
}

export function issueObservationMatchesDesired(candidate: GitHubIssueObservation, desired: DesiredIssueMaterial, preserveUserText: boolean): boolean {
  return candidate.title === desired.title && candidate.state === desired.state && candidate.state_reason === desired.state_reason
    && isDeepStrictEqual([...candidate.labels].sort(), [...desired.labels].sort())
    && (preserveUserText ? reconcileManagedIssueBody(candidate.body, desired.body) === candidate.body : candidate.body === desired.body);
}

export async function reconcileAmbiguousLineageIssueOperations(input: {
  runDir: string;
  manifest: RunManifestV2;
  github: GitHubAdapter;
  apply: boolean;
  ledgerHooks?: RunLedgerTransactionHooks;
}): Promise<AmbiguousIssueReconciliationReport | null> {
  if (input.manifest.github_effects_protocol !== "task-lineage-v1"
    || input.manifest.task_lineage_id === null
    || input.manifest.github_effects.issue_sync === null
    || input.manifest.stage !== "awaiting_github_issue_effects") return null;
  if (!input.github.getRepositoryIdentity || !input.github.findIssuesByMarker || !input.github.findParentIssuesByMarker) {
    throw new Error("Ambiguous issue reconciliation requires repository identity and exhaustive marker lookup");
  }
  const repository = await input.github.getRepositoryIdentity();
  const repositoryKey = `${repository.host}/${repository.name_with_owner}`.toLowerCase();
  const preview = await readVerifiedGithubEffectPreview({
    run_dir: input.runDir,
    reference: input.manifest.github_effects.issue_sync,
    expected: {
      phase: "issue_sync",
      lineage_id: input.manifest.task_lineage_id,
      run_id: input.manifest.run_id,
      plan_revision: input.manifest.github_effects.issue_sync.plan_revision,
      plan_sha256: input.manifest.github_effects.issue_sync.plan_sha256,
    },
  });
  const planText = await readVerifiedPlanRevision(input.runDir, input.manifest, preview.plan_revision);
  const plan = brainPlanSchema.parse(JSON.parse(planText));
  const featureSlug = resolveFeatureSlug(plan);
  const issueEffects = preview.effects.filter((effect): effect is IssueEffect => effect.target.kind === "parent" || effect.target.kind === "work_item");
  const desiredByEffect = new Map(issueEffects.map((effect) => {
    const desired = desiredMaterialForEffect(effect, plan, preview.lineage_id, preview.run_id, featureSlug, preview.plan_revision);
    if (issueDesiredMaterialSha256(effect.target, desired) !== effect.desired_sha256) throw new Error(`Issue effect ${targetKey(effect)} desired material does not match the approved plan`);
    return [effect.effect_id, desired] as const;
  }));
  const initialLineage = await readTaskLineage(input.manifest.repo_root, input.manifest.task_lineage_id);
  assertAmbiguousBinding(input.manifest, initialLineage, repositoryKey, preview);
  const relevant = issueEffects.filter((effect) => {
    const operation = initialLineage.issue_set.operations[effect.effect_id];
    return operation?.state === "ambiguous" || operation?.state === "complete";
  });
  if (relevant.length === 0) return null;

  const observe = async (effect: IssueEffect) => {
    const candidates = effect.target.kind === "parent"
      ? [
          ...await input.github.findParentIssuesByMarker!({ lineageId: input.manifest.task_lineage_id!, runId: input.manifest.run_id, featureSlug }),
          ...await input.github.findParentIssuesByMarker!({ runId: input.manifest.run_id, featureSlug }),
        ]
      : [
          ...await input.github.findIssuesByMarker!({ lineageId: input.manifest.task_lineage_id!, runId: input.manifest.run_id, workItemId: effect.target.work_item_id }),
          ...await input.github.findIssuesByMarker!({ runId: input.manifest.run_id, workItemId: effect.target.work_item_id }),
        ];
    const byNumber = new Map<number, (typeof candidates)[number]>();
    for (const candidate of candidates) {
      assertCanonicalCandidate(candidate.body, input.manifest.task_lineage_id!, input.manifest.run_id, effect, featureSlug);
      const existing = byNumber.get(candidate.number);
      if (existing && JSON.stringify(existing) !== JSON.stringify(candidate)) throw new Error(`GitHub issue #${candidate.number} returned conflicting observations`);
      byNumber.set(candidate.number, candidate);
    }
    return [...byNumber.values()].sort((left, right) => left.number - right.number);
  };

  if (!input.apply) {
    const targets = [] as AmbiguousIssueReconciliationReport["targets"];
    for (const effect of relevant) {
      const operation = initialLineage.issue_set.operations[effect.effect_id]!;
      if (operation.target_key !== targetKey(effect) || operation.desired_sha256 !== effect.desired_sha256) throw new Error("Ambiguous operation does not match its immutable effect");
      const matches = await observe(effect);
      const exactComplete = operation.state === "complete" && matches.length === 1 && matches[0]!.number === operation.issue_number
        && issueObservationMatchesDesired(matches[0]!, desiredByEffect.get(effect.effect_id)!, effect.action === "update");
      targets.push({ operation_id: effect.effect_id, target_key: targetKey(effect), match_count: matches.length,
        ...(exactComplete ? { issue_number: operation.issue_number! } : {}), outcome: exactComplete ? "noop" : "blocked" });
    }
    return { version: 1, run_id: input.manifest.run_id, lineage_id: input.manifest.task_lineage_id, mode: "dry_run", state: initialLineage.issue_set.state === "ready" ? "ready" : "ambiguous", targets };
  }

  return withTaskLineageTransaction({
    repoRoot: input.manifest.repo_root,
    lineageId: input.manifest.task_lineage_id,
    operation: async (transaction) => {
      let lineage = transaction.read();
      assertAmbiguousBinding(input.manifest, lineage, repositoryKey, preview);
      const targets = [] as AmbiguousIssueReconciliationReport["targets"];
      let allExact = true;
      for (const effect of relevant) {
        let operation = lineage.issue_set.operations[effect.effect_id];
        if (!operation || operation.target_key !== targetKey(effect) || operation.desired_sha256 !== effect.desired_sha256
          || operation.created_by_run_id !== input.manifest.run_id) throw new Error("Ambiguous operation does not match its immutable effect");
        const matches = await observe(effect);
        if (operation.state === "complete") {
          const exact = matches.length === 1 && matches[0]!.number === operation.issue_number
            && issueObservationMatchesDesired(matches[0]!, desiredByEffect.get(effect.effect_id)!, effect.action === "update");
          allExact &&= exact;
          targets.push({ operation_id: effect.effect_id, target_key: targetKey(effect), match_count: matches.length,
            ...(exact ? { issue_number: operation.issue_number! } : {}), outcome: exact ? "noop" : "blocked" });
          continue;
        }
        if (operation.state !== "ambiguous" || matches.length !== 1
          || !issueObservationMatchesDesired(matches[0]!, desiredByEffect.get(effect.effect_id)!, effect.action === "update")) {
          allExact = false;
          targets.push({ operation_id: effect.effect_id, target_key: targetKey(effect), match_count: matches.length, outcome: "blocked" });
          continue;
        }
        const number = matches[0]!.number;
        lineage = await transaction.update({
          ...(effect.target.kind === "parent"
            ? { ...lineage, issue_set: { ...lineage.issue_set, parent_issue_number: number } }
            : { ...lineage, issue_set: { ...lineage.issue_set, work_item_issue_map: { ...lineage.issue_set.work_item_issue_map, [effect.target.work_item_id]: number } } }),
          issue_set: {
            ...(effect.target.kind === "parent"
              ? { ...lineage.issue_set, parent_issue_number: number }
              : { ...lineage.issue_set, work_item_issue_map: { ...lineage.issue_set.work_item_issue_map, [effect.target.work_item_id]: number } }),
            operations: { ...lineage.issue_set.operations, [effect.effect_id]: { ...operation, state: "observed", issue_number: number } },
          },
        });
        operation = lineage.issue_set.operations[effect.effect_id]!;
        lineage = await transaction.update({ ...lineage, issue_set: { ...lineage.issue_set, operations: { ...lineage.issue_set.operations, [effect.effect_id]: { ...operation, state: "complete" } } } });
        targets.push({ operation_id: effect.effect_id, target_key: targetKey(effect), match_count: 1, issue_number: number, outcome: "adopted" });
      }
      const ready = issueEffects.every((effect) => lineage.issue_set.operations[effect.effect_id]?.state === "complete");
      const mappedNumbers = issueEffects.map((effect) => effect.target.kind === "parent"
        ? lineage.issue_set.parent_issue_number
        : lineage.issue_set.work_item_issue_map[effect.target.work_item_id] ?? null);
      const completeUniqueMappings = mappedNumbers.every((number): number is number => number !== null)
        && new Set(mappedNumbers).size === mappedNumbers.length;
      if (!allExact || !ready || !completeUniqueMappings) {
        return { version: 1, run_id: input.manifest.run_id, lineage_id: lineage.lineage_id, mode: "apply", state: "ambiguous", targets };
      }
      if (lineage.issue_set.state !== "ready" || lineage.issue_set.preview?.state !== "applied") {
        const proposedReady = { ...lineage, issue_set: { ...lineage.issue_set, state: "ready" as const, preview: lineage.issue_set.preview ? { ...lineage.issue_set.preview, state: "applied" as const } : null } };
        assertReadyAppliedIssueSet({ repoRoot: input.manifest.repo_root, lineageId: lineage.lineage_id, runId: input.manifest.run_id, repositoryKey, preview }, proposedReady);
        lineage = await transaction.update(proposedReady);
      }
      assertReadyAppliedIssueSet({ repoRoot: input.manifest.repo_root, lineageId: lineage.lineage_id, runId: input.manifest.run_id, repositoryKey, preview }, lineage);
      await withRunLedgerTransaction(input.runDir, async (manifestTransaction) => {
        const manifest = await manifestTransaction.readManifestV2();
        if (manifest.run_id !== input.manifest.run_id || manifest.task_lineage_id !== lineage.lineage_id
          || manifest.github_effects.issue_sync === null || lineage.issue_set.preview === null
          || !samePreviewIdentity(manifest.github_effects.issue_sync, lineage.issue_set.preview)) throw new Error("Manifest mirror binding changed during ambiguous reconciliation");
        const numbers = Object.values(lineage.issue_set.work_item_issue_map);
        const githubIds = { ...manifest.github_ids, issue_numbers: numbers, work_item_issue_map: { ...lineage.issue_set.work_item_issue_map }, parent_issue_number: lineage.issue_set.parent_issue_number };
        if (isDeepStrictEqual(manifest.issue_numbers, numbers)
          && isDeepStrictEqual(manifest.work_item_issue_map, lineage.issue_set.work_item_issue_map)
          && isDeepStrictEqual(manifest.github_ids, githubIds)
          && isDeepStrictEqual(manifest.github_effects.issue_sync, lineage.issue_set.preview)) return;
        await manifestTransaction.updateManifestV2({
          issue_numbers: numbers,
          work_item_issue_map: { ...lineage.issue_set.work_item_issue_map },
          github_ids: githubIds,
          github_effects: { ...manifest.github_effects, issue_sync: lineage.issue_set.preview },
        });
      }, input.ledgerHooks);
      return { version: 1, run_id: input.manifest.run_id, lineage_id: lineage.lineage_id, mode: "apply", state: lineage.issue_set.state === "ready" ? "ready" : "ambiguous", targets };
    },
  });
}

export function issueOwnershipMatches(
  manifest: RunManifestV2,
  target: { kind: "parent" } | { kind: "work_item"; workItemId: string },
  issue: GitHubIssueStateReference,
): boolean {
  const runMarkers = markerValues(issue.body, "run");
  const workItemMarkers = markerValues(issue.body, "work-item");
  const parentMarkers = markerValues(issue.body, "parent");
  if (runMarkers.length !== 1 || runMarkers[0] !== manifest.run_id) return false;
  return target.kind === "parent"
    ? parentMarkers.length === 1 && workItemMarkers.length === 0
    : workItemMarkers.length === 1 && workItemMarkers[0] === target.workItemId && parentMarkers.length === 0;
}

function lineageIssueOwnershipMatches(
  manifest: RunManifestV2,
  lineageId: string,
  target: { kind: "parent"; featureSlug: string } | { kind: "work_item"; workItemId: string },
  issue: GitHubIssueStateReference,
): boolean {
  const lineageMarkers = markerValues(issue.body, "lineage");
  const runMarkers = markerValues(issue.body, "run");
  const workItemMarkers = markerValues(issue.body, "work-item");
  const parentMarkers = markerValues(issue.body, "parent");
  if (lineageMarkers.length !== 1 || lineageMarkers[0] !== lineageId
    || runMarkers.length !== 1 || runMarkers[0] !== manifest.run_id) return false;
  return target.kind === "parent"
    ? parentMarkers.length === 1 && parentMarkers[0] === target.featureSlug && workItemMarkers.length === 0
    : workItemMarkers.length === 1 && workItemMarkers[0] === target.workItemId && parentMarkers.length === 0;
}

function requireCapabilities(github: GitHubAdapter): asserts github is GitHubAdapter & Required<Pick<
  GitHubAdapter,
  "getDefaultBranch" | "getPullRequest" | "updatePullRequestBody" | "getIssue" | "closeIssue" | "updateIssueLabels"
>> {
  if (!github.getDefaultBranch || !github.getPullRequest || !github.updatePullRequestBody || !github.getIssue || !github.closeIssue || !github.updateIssueLabels) {
    throw new Error("GitHub issue lifecycle reconciliation is unsupported by this adapter");
  }
}

async function recordIntent(input: {
  runDir: string;
  operationId: string;
  kind: "pull_request_links" | "issue_close";
  targetNumber: number;
  reason: GitHubIssueClosureReason | null;
  desiredHash: string;
  now: () => string;
  rearmCompleted?: boolean;
  budget?: ResourceBudgetPort;
}): Promise<void> {
  const current = (await readIssueLifecycleCheckpoint(input.runDir)).operations[input.operationId];
  if (current?.status === "completed" && input.rearmCompleted !== true) return;
  const rearmToken = current?.status === "completed" && input.rearmCompleted === true
    ? `:rearm:${current.completed_at ?? current.intended_at}`
    : "";
  const claim = await claimExternalEffect(input.budget, `github-lifecycle:${input.operationId}${rearmToken}`);
  await updateOperation(input.runDir, input.operationId, {
    status: "pending",
    kind: input.kind,
    target_number: input.targetNumber,
    reason: input.reason,
    desired_hash: input.desiredHash,
    intended_at: current?.status === "completed" && input.rearmCompleted === true
      ? input.now()
      : current?.intended_at ?? input.now(),
    completed_at: null,
  });
  await completeExternalEffect(input.budget, claim);
}

async function recordCompletion(input: {
  runDir: string;
  operationId: string;
  now: () => string;
}): Promise<void> {
  const operation = (await readIssueLifecycleCheckpoint(input.runDir)).operations[input.operationId];
  if (!operation) throw new Error(`Lifecycle operation ${input.operationId} has no durable intent`);
  await updateOperation(input.runDir, input.operationId, {
    ...operation,
    status: "completed",
    completed_at: operation.completed_at ?? input.now(),
  });
}

function integratedPullRequestNumber(manifest: RunManifestV2): number | null {
  return manifest.github_ids.pull_request_numbers[0] ?? manifest.pull_request_numbers[0] ?? null;
}

function pullRequestState(reference: GitHubPullRequestReference): "OPEN" | "CLOSED" | "MERGED" {
  if (reference.state !== "OPEN" && reference.state !== "CLOSED" && reference.state !== "MERGED") {
    throw new Error(`Pull request #${reference.number} has no verified state`);
  }
  return reference.state;
}

function normalizedIssueNumbers(numbers: readonly number[]): number[] {
  return [...new Set(numbers)].sort((left, right) => left - right);
}

function hasExactClosingIssueSet(expected: readonly number[], observed: readonly number[]): boolean {
  return observed.length === expected.length
    && isDeepStrictEqual(normalizedIssueNumbers(observed), normalizedIssueNumbers(expected));
}

function exactManagedClosingLinksVerified(input: {
  body: string;
  lineageId?: string;
  runId: string;
  expectedIssueNumbers: readonly number[];
  observedIssueNumbers: readonly number[];
}): boolean {
  if (input.expectedIssueNumbers.length === 0) return false;
  try {
    const desired = input.lineageId === undefined
      ? reconcileClosingLinksBlock(input.body, input.runId, input.expectedIssueNumbers)
      : reconcileClosingLinksBlock(input.body, input.lineageId, input.runId, input.expectedIssueNumbers);
    return desired === input.body
      && hasExactClosingIssueSet(input.expectedIssueNumbers, input.observedIssueNumbers);
  } catch {
    return false;
  }
}

async function reconcileGitHubPullRequestLinksUnlocked(input: {
  runDir: string;
  runId: string;
  lineageId?: string;
  github: GitHubAdapter;
  pullRequestNumber: number;
  expectedIssueNumbers: number[];
  defaultBranch: string;
  expectedUrl: string | null;
  expectedHeadRef: string | null;
  expectedHeadSha: string | null;
  apply: boolean;
  budget?: ResourceBudgetPort;
  now?: () => string;
}): Promise<{
  reference: GitHubPullRequestReference;
  report: NonNullable<IssueLifecycleReport["pull_request"]>;
}> {
  if (!input.github.getPullRequest || !input.github.updatePullRequestBody) {
    throw new Error("GitHub pull-request metadata reconciliation is unsupported by this adapter");
  }
  const now = input.now ?? (() => new Date().toISOString());
  let pullRequest = await input.github.getPullRequest(input.pullRequestNumber);
  if (pullRequest === null) throw new Error(`Pull request #${input.pullRequestNumber} does not exist`);
  const state = pullRequestState(pullRequest);
  if (typeof pullRequest.base_ref !== "string") throw new Error(`Pull request #${pullRequest.number} has no verified base branch`);
  const baseBranch = pullRequest.base_ref;
  if (typeof pullRequest.body !== "string") throw new Error(`Pull request #${pullRequest.number} has no verified body`);
  const parsedRaw = pullRequest.closing_issue_numbers ?? [];
  const parsed = normalizedIssueNumbers(parsedRaw);
  let missing = missingClosingIssueNumbers(input.expectedIssueNumbers, parsed);
  const defaultBranchCompatible = baseBranch === input.defaultBranch;
  const identityVerified = input.expectedUrl !== null
    && input.expectedHeadRef !== null
    && input.expectedHeadSha !== null
    && pullRequest.url === input.expectedUrl
    && pullRequest.head_ref === input.expectedHeadRef
    && pullRequest.head_sha === input.expectedHeadSha;
  const hasExpectedIssues = input.expectedIssueNumbers.length > 0;
  const canEdit = state === "OPEN" && defaultBranchCompatible && identityVerified && hasExpectedIssues;
  let managedLinksVerified = exactManagedClosingLinksVerified({
    body: pullRequest.body,
    ...(input.lineageId === undefined ? {} : { lineageId: input.lineageId }),
    runId: input.runId,
    expectedIssueNumbers: input.expectedIssueNumbers,
    observedIssueNumbers: parsedRaw,
  });
  const desiredBody = canEdit
    ? input.lineageId === undefined
      ? reconcileClosingLinksBlock(pullRequest.body, input.runId, input.expectedIssueNumbers)
      : reconcileClosingLinksBlock(pullRequest.body, input.lineageId, input.runId, input.expectedIssueNumbers)
    : pullRequest.body;
  const action = canEdit && (desiredBody !== pullRequest.body || missing.length > 0) ? "update" : "none";
  const editSkipReason: NonNullable<IssueLifecycleReport["pull_request"]>["edit_skip_reason"] = action === "update"
    ? null
    : !identityVerified
      ? "identity_mismatch"
      : !hasExpectedIssues
        ? "no_expected_issues"
        : !defaultBranchCompatible
          ? "non_default_base"
          : state !== "OPEN"
            ? "pull_request_not_open"
            : "already_reconciled";
  let applied = false;
  if (action === "update" && input.apply) {
    const desiredHash = sha256(desiredBody);
    const operationId = `pull_request:${pullRequest.number}:links:${desiredHash}`;
    await recordIntent({
      runDir: input.runDir,
      operationId,
      kind: "pull_request_links",
      targetNumber: pullRequest.number,
      reason: null,
      desiredHash,
      now,
      rearmCompleted: true,
      budget: input.budget,
    });
    await input.github.updatePullRequestBody(pullRequest.number, desiredBody);
    const updated = await input.github.getPullRequest(pullRequest.number);
    if (updated === null) throw new Error(`Pull request #${pullRequest.number} disappeared during closing-link reconciliation`);
    if (
      updated.url !== input.expectedUrl
      || updated.head_ref !== input.expectedHeadRef
      || updated.head_sha !== input.expectedHeadSha
      || updated.base_ref !== baseBranch
      || updated.state !== state
      || updated.body !== desiredBody
    ) {
      throw new Error(`Pull request #${pullRequest.number} changed during closing-link reconciliation`);
    }
    const updatedParsedRaw = updated.closing_issue_numbers ?? [];
    const updatedParsed = normalizedIssueNumbers(updatedParsedRaw);
    missing = missingClosingIssueNumbers(input.expectedIssueNumbers, updatedParsed);
    if (missing.length > 0) throw new Error(`Pull request #${pullRequest.number} is missing parsed closing references for ${missing.map((number) => `#${number}`).join(", ")}`);
    managedLinksVerified = exactManagedClosingLinksVerified({
      body: updated.body,
      ...(input.lineageId === undefined ? {} : { lineageId: input.lineageId }),
      runId: input.runId,
      expectedIssueNumbers: input.expectedIssueNumbers,
      observedIssueNumbers: updatedParsedRaw,
    });
    if (!managedLinksVerified) throw new Error(`Pull request #${pullRequest.number} managed closing-link identity did not converge`);
    await recordCompletion({ runDir: input.runDir, operationId, now });
    pullRequest = { ...updated, closing_issue_numbers: updatedParsed };
    applied = true;
  } else if (
    action === "none"
    && identityVerified
    && defaultBranchCompatible
    && hasExpectedIssues
    && missing.length === 0
    && managedLinksVerified
    && input.apply
  ) {
    const desiredHash = sha256(pullRequest.body);
    const operationId = `pull_request:${pullRequest.number}:links:${desiredHash}`;
    const operation = (await readIssueLifecycleCheckpoint(input.runDir)).operations[operationId];
    if (operation?.status === "pending") await recordCompletion({ runDir: input.runDir, operationId, now });
  }
  return {
    reference: pullRequest,
    report: {
      number: pullRequest.number,
      state,
      base_branch: baseBranch,
      default_branch_compatible: defaultBranchCompatible,
      identity_verified: identityVerified,
      managed_links_verified: managedLinksVerified,
      action,
      edit_skip_reason: editSkipReason,
      proposed_body: action === "update" ? desiredBody : null,
      applied,
      expected_closing_issue_numbers: input.expectedIssueNumbers,
      parsed_closing_issue_numbers: normalizedIssueNumbers(pullRequest.closing_issue_numbers ?? []),
      missing_closing_issue_numbers: missing,
    },
  };
}

export async function reconcileGitHubPullRequestLinks(
  input: Parameters<typeof reconcileGitHubPullRequestLinksUnlocked>[0],
): ReturnType<typeof reconcileGitHubPullRequestLinksUnlocked> {
  return withRunLedgerTransaction(input.runDir, () => reconcileGitHubPullRequestLinksUnlocked(input));
}

function cleanupWithTargetState(
  cleanup: GithubCleanupBatch,
  number: number,
  state: "complete" | "blocked",
  now: () => string,
): GithubCleanupBatch {
  const targetStates = { ...cleanup.target_states, [String(number)]: state };
  const values = cleanup.target_numbers.map((target) => targetStates[String(target)]!);
  const aggregate = values.every((value) => value === "complete")
    ? "complete" as const
    : values.some((value) => value === "blocked") ? "blocked" as const : "pending" as const;
  return {
    ...cleanup,
    target_states: targetStates,
    state: aggregate,
    completed_at: aggregate === "complete" ? cleanup.completed_at ?? now() : null,
  };
}

function cleanupTargets(
  manifest: RunManifestV2,
  lineage: TaskLineageRecordV1,
  preview: GithubEffectPreviewV1,
): Map<number, { kind: "parent"; featureSlug: string } | { kind: "work_item"; workItemId: string }> {
  const targets = new Map<number, { kind: "parent"; featureSlug: string } | { kind: "work_item"; workItemId: string }>();
  for (const effect of preview.effects) {
    if (effect.target.kind !== "parent" && effect.target.kind !== "work_item") continue;
    const operation = lineage.issue_set.operations[effect.effect_id];
    const number = operation?.state === "complete" ? operation.issue_number : null;
    if (number === null || number === undefined) throw new Error(`Cleanup effect ${effect.effect_id} has no complete authoritative issue mapping`);
    if (targets.has(number)) throw new Error(`Authoritative lineage has duplicate cleanup target #${number}`);
    targets.set(number, effect.target.kind === "parent"
      ? { kind: "parent", featureSlug: effect.target.feature_slug }
      : { kind: "work_item", workItemId: effect.target.work_item_id });
  }
  const expected = [...targets.keys()].sort((left, right) => left - right);
  if (manifest.github_cleanup === null
    || manifest.github_cleanup.lineage_id !== lineage.lineage_id
    || JSON.stringify(manifest.github_cleanup.target_numbers) !== JSON.stringify(expected)) {
    throw new Error("GitHub cleanup batch does not match the immutable authoritative lineage target set");
  }
  return targets;
}

async function reconcileGithubCleanupUnlocked(input: {
  runDir: string;
  manifest: RunManifestV2;
  github: GitHubAdapter;
  apply: boolean;
  now?: () => string;
  runTransaction: RunLedgerTransaction;
  lineageTransaction: TaskLineageTransaction;
}): Promise<IssueLifecycleReport> {
  if (!input.github.getRepositoryIdentity || !input.github.getIssue || !input.github.closeIssue || !input.github.updateIssueLabels) {
    throw new Error("GitHub cleanup reconciliation is unsupported by this adapter");
  }
  const now = input.now ?? (() => new Date().toISOString());
  let manifest = await input.runTransaction.readManifestV2();
  let lineage = input.lineageTransaction.read();
  if (manifest.run_id !== input.manifest.run_id || manifest.task_lineage_id === null
    || manifest.task_lineage_id !== lineage.lineage_id || lineage.active_run_id !== manifest.run_id
    || manifest.terminal === null || manifest.github_cleanup === null
    || manifest.github_cleanup.reason !== "not_planned"
    || (manifest.terminal.outcome !== "abandoned" && manifest.terminal.outcome !== "closed_blocked")
      || lineage.state !== manifest.terminal.outcome) {
    throw new Error("GitHub cleanup requires the exact terminal run and lineage binding");
  }
  let cleanup: GithubCleanupBatch = manifest.github_cleanup;
  if (cleanup.target_numbers.length === 0) {
    if (cleanup.state !== "complete" || cleanup.completed_at === null
      || Object.keys(cleanup.target_states).length !== 0 || lineage.cleanup_state !== "complete") {
      throw new Error("Empty GitHub cleanup batch must already be durably complete");
    }
    return {
      version: 1,
      run_id: manifest.run_id,
      mode: input.apply ? "apply" : "dry_run",
      default_branch: "",
      pull_request: null,
      issues: [],
      cleanup,
    };
  }
  const reference = manifest.github_effects.issue_sync;
  if (reference === null || lineage.issue_set.preview === null
    || !samePreviewIdentity(reference, lineage.issue_set.preview) || reference.state !== "applied") {
    throw new Error("GitHub cleanup requires the exact applied lineage issue preview");
  }
  const preview = await readVerifiedGithubEffectPreview({
    run_dir: input.runDir,
    reference,
    expected: {
      phase: "issue_sync",
      lineage_id: lineage.lineage_id,
      run_id: manifest.run_id,
      plan_revision: reference.plan_revision,
      plan_sha256: reference.plan_sha256,
    },
  });
  const repository = await input.github.getRepositoryIdentity();
  const repositoryKey = `${repository.host}/${repository.name_with_owner}`.toLowerCase();
  const previewRepositoryKey = `${preview.repository.host}/${preview.repository.name_with_owner}`.toLowerCase();
  if (repositoryKey !== previewRepositoryKey || repositoryKey !== lineage.repository_key?.toLowerCase()) {
    throw new Error("GitHub cleanup repository identity does not match its immutable lineage preview");
  }
  const targets = cleanupTargets(manifest, lineage, preview);
  const issues: IssueLifecycleReportEntry[] = [];
  for (const number of cleanup.target_numbers) {
    const target = targets.get(number)!;
    const persistedState = cleanup.target_states[String(number)]!;
    if (persistedState === "complete") {
      issues.push({ number, kind: target.kind, ...(target.kind === "work_item" ? { work_item_id: target.workItemId } : {}), state: "CLOSED", action: "none", applied: false });
      continue;
    }
    let issue: GitHubIssueStateReference;
    try {
      issue = await input.github.getIssue(number);
    } catch {
      if (input.apply) {
        cleanup = cleanupWithTargetState(cleanup, number, "blocked", now);
        manifest = await input.runTransaction.updateManifestV2({ github_cleanup: cleanup });
        if (lineage.cleanup_state !== cleanup.state) lineage = await input.lineageTransaction.update({ ...lineage, cleanup_state: cleanup.state });
      }
      break;
    }
    const owned = lineageIssueOwnershipMatches(manifest, lineage.lineage_id, target, issue);
    if (!owned || !Array.isArray(issue.labels)) {
      issues.push({ number, kind: target.kind, ...(target.kind === "work_item" ? { work_item_id: target.workItemId } : {}), state: issue.state, action: "skip", skip_reason: "ownership_marker_mismatch", applied: false });
      if (input.apply) {
        cleanup = cleanupWithTargetState(cleanup, number, "blocked", now);
        manifest = await input.runTransaction.updateManifestV2({ github_cleanup: cleanup });
        if (lineage.cleanup_state !== cleanup.state) lineage = await input.lineageTransaction.update({ ...lineage, cleanup_state: cleanup.state });
      }
      break;
    }
    const expectedStateReason = "NOT_PLANNED";
    let applied = false;
    if (issue.state === "OPEN" && !input.apply) {
      issues.push({ number, kind: target.kind, ...(target.kind === "work_item" ? { work_item_id: target.workItemId } : {}), state: issue.state, action: "close", reason: cleanup.reason, applied: false });
      continue;
    }
    if (issue.state === "OPEN" && input.apply) {
      try {
        await input.github.closeIssue(number, cleanup.reason);
        applied = true;
      } catch {
        // A lost response is recovered only from a fresh exact observation below.
      }
      try {
        issue = await input.github.getIssue(number);
      } catch {
        issue = { ...issue, state: "OPEN", state_reason: null };
      }
    }
    if (input.apply && issue.state === "CLOSED" && issue.state_reason === expectedStateReason
      && lineageIssueOwnershipMatches(manifest, lineage.lineage_id, target, issue)) {
      const { add, remove } = managedStateLabelEdit({ ...issue, labels: issue.labels ?? [] }, "brain-hands:not-planned");
      if (add.length > 0 || remove.length > 0) {
        try {
          await input.github.updateIssueLabels(number, { add, remove });
          applied = true;
        } catch {
          // A lost label-update response is resolved only by the fresh observation below.
        }
        try {
          issue = await input.github.getIssue(number);
        } catch {
          issue = { ...issue, labels: undefined };
        }
      }
    }
    const labelVerified = Array.isArray(issue.labels) && hasExactManagedStateLabel(issue.labels, "brain-hands:not-planned");
    if (issue.state !== "CLOSED" || issue.state_reason !== expectedStateReason
      || !lineageIssueOwnershipMatches(manifest, lineage.lineage_id, target, issue) || !labelVerified) {
      const skipReason = issue.state !== "CLOSED"
        ? "remote_state_mismatch" as const
        : issue.state_reason !== expectedStateReason
          ? "closed_with_different_reason" as const
          : !lineageIssueOwnershipMatches(manifest, lineage.lineage_id, target, issue)
            ? "ownership_marker_mismatch" as const
            : "terminal_label_mismatch" as const;
      issues.push({ number, kind: target.kind, ...(target.kind === "work_item" ? { work_item_id: target.workItemId } : {}), state: issue.state, action: "skip", skip_reason: skipReason, applied: false });
      if (input.apply) {
        cleanup = cleanupWithTargetState(cleanup, number, "blocked", now);
        manifest = await input.runTransaction.updateManifestV2({ github_cleanup: cleanup });
        if (lineage.cleanup_state !== cleanup.state) lineage = await input.lineageTransaction.update({ ...lineage, cleanup_state: cleanup.state });
      }
      break;
    }
    issues.push({ number, kind: target.kind, ...(target.kind === "work_item" ? { work_item_id: target.workItemId } : {}), state: issue.state, action: "close", reason: cleanup.reason, applied });
    if (input.apply) {
      cleanup = cleanupWithTargetState(cleanup, number, "complete", now);
      manifest = await input.runTransaction.updateManifestV2({ github_cleanup: cleanup });
      if (lineage.cleanup_state !== cleanup.state) lineage = await input.lineageTransaction.update({ ...lineage, cleanup_state: cleanup.state });
    }
  }
  // Repair the lineage mirror after a crash between the authoritative run-ledger
  // update and its lineage projection. Completed targets remain immutable and are
  // not re-read or re-mutated during this repair-only resume.
  if (input.apply && lineage.cleanup_state !== cleanup.state) {
    lineage = await input.lineageTransaction.update({ ...lineage, cleanup_state: cleanup.state });
  }
  return {
    version: 1,
    run_id: manifest.run_id,
    mode: input.apply ? "apply" : "dry_run",
    default_branch: "",
    pull_request: null,
    issues,
    cleanup: manifest.github_cleanup,
  };
}

async function reconcileGitHubIssuesUnlocked(input: {
  runDir: string;
  manifest: RunManifestV2;
  github: GitHubAdapter;
  apply: boolean;
  budget?: ResourceBudgetPort;
  now?: () => string;
  lineageState?: TaskLineageRecordV1["state"];
  taskAuthority?: TaskLineageLifecycleAuthority;
}): Promise<IssueLifecycleReport> {
  requireCapabilities(input.github);
  const now = input.now ?? (() => new Date().toISOString());
  const defaultBranch = await input.github.getDefaultBranch();
  const workItems = input.taskAuthority ? [] : workItemTargets(input.manifest);
  const targets = input.taskAuthority?.targets ?? [
    ...(input.manifest.github_ids.parent_issue_number
      ? [{ number: input.manifest.github_ids.parent_issue_number, kind: "parent" as const }]
      : []), ...workItems,
  ];
  const observations = [] as Array<{
    target: (typeof targets)[number];
    issue: GitHubIssueStateReference;
    owned: boolean;
  }>;
  for (const target of targets) {
    const issue = await input.github.getIssue(target.number);
    const owned = target.kind === "unmapped"
      ? false
      : input.taskAuthority
        ? lineageIssueOwnershipMatches(input.manifest, input.taskAuthority.lineageId,
            target.kind === "parent"
              ? { kind: "parent", featureSlug: input.taskAuthority.featureSlug }
              : { kind: "work_item", workItemId: target.workItemId }, issue)
        : issueOwnershipMatches(
          input.manifest,
          target.kind === "parent" ? target : { kind: "work_item", workItemId: target.workItemId },
          issue,
        );
    observations.push({ target, issue, owned });
  }
  const authorizedParent = observations.find((observation) => observation.target.kind === "parent" && observation.owned);
  const authorizedWorkItems = observations.flatMap((observation) =>
    observation.target.kind === "work_item" && observation.owned ? [observation.target] : []);
  const expectedIssueNumbers = expectedClosingIssueNumbers({
    parentIssueNumber: authorizedParent?.target.number,
    workItems: authorizedWorkItems.map((target) => ({ id: target.workItemId, issueNumber: target.number })),
  });

  let pullRequest: GitHubPullRequestReference | null = null;
  let pullRequestReport: IssueLifecycleReport["pull_request"] = null;
  const pullRequestNumber = input.taskAuthority?.pullRequestNumber ?? integratedPullRequestNumber(input.manifest);
  if (pullRequestNumber !== null) {
    const reconciled = await reconcileGitHubPullRequestLinksUnlocked({
      runDir: input.runDir,
      runId: input.manifest.run_id,
      ...(input.manifest.task_lineage_id === null ? {} : { lineageId: input.manifest.task_lineage_id }),
      github: input.github,
      pullRequestNumber,
      expectedIssueNumbers,
      defaultBranch,
      expectedUrl: input.taskAuthority?.pullRequestUrl ?? input.manifest.github_ids.pull_request_urls[String(pullRequestNumber)] ?? null,
      expectedHeadRef: input.taskAuthority?.branchName ?? input.manifest.branch_name,
      expectedHeadSha: input.taskAuthority?.headSha ?? (typeof input.manifest.work_item_progress.integrated?.commit_sha === "string"
        ? input.manifest.work_item_progress.integrated.commit_sha : null),
      apply: input.apply,
      budget: input.budget,
      now,
    });
    pullRequest = reconciled.reference;
    pullRequestReport = reconciled.report;
  }

  if (pullRequestReport?.identity_verified === true
    && pullRequestReport.managed_links_verified === true
    && pullRequestReport.default_branch_compatible
    && pullRequestReport.state === "MERGED"
    && input.lineageState !== undefined
    && input.lineageState !== "delivery_ready"
    && input.lineageState !== "human_accepted"
    && input.lineageState !== "completed") {
    throw new Error(`Task lineage state ${input.lineageState} cannot transition to completed after merge`);
  }

  if (input.apply && input.taskAuthority && pullRequestReport?.identity_verified === true
    && pullRequestReport.managed_links_verified === true
    && pullRequestReport.default_branch_compatible && pullRequestReport.state === "MERGED") {
    const checkpoint = await readIssueLifecycleCheckpoint(input.runDir);
    for (const { target, issue, owned } of observations) {
      if (target.kind === "unmapped" || !owned || !Array.isArray(issue.labels)) {
        await recordIntent({ runDir: input.runDir, operationId: `issue:${target.number}:close:completed`,
          kind: "issue_close", targetNumber: target.number, reason: "completed",
          desiredHash: sha256(`${input.manifest.run_id}:${target.number}:completed:brain-hands:complete`), now,
          rearmCompleted: true });
        throw new Error(`Authoritative merged target #${target.number} failed exact lineage ownership preflight`);
      }
      if (issue.state === "CLOSED" && issue.state_reason !== "COMPLETED") {
        await recordIntent({ runDir: input.runDir, operationId: `issue:${target.number}:close:completed`,
          kind: "issue_close", targetNumber: target.number, reason: "completed",
          desiredHash: sha256(`${input.manifest.run_id}:${target.number}:completed:brain-hands:complete`), now,
          rearmCompleted: true });
        throw new Error(`Authoritative merged target #${target.number} was closed with a different reason`);
      }
      if (issue.state === "OPEN" && checkpoint.operations[`issue:${target.number}:close:completed`]?.status === "completed") {
        await recordIntent({ runDir: input.runDir, operationId: `issue:${target.number}:close:completed`,
          kind: "issue_close", targetNumber: target.number, reason: "completed",
          desiredHash: sha256(`${input.manifest.run_id}:${target.number}:completed:brain-hands:complete`), now,
          rearmCompleted: true });
        throw new Error(`Authoritative merged target #${target.number} was reopened after completed reconciliation`);
      }
    }
  }

  const issues: IssueLifecycleReportEntry[] = [];
  for (const { target, issue, owned } of observations) {
    if (target.kind === "unmapped") {
      issues.push({
        number: target.number,
        kind: "unmapped",
        state: issue.state,
        action: "skip",
        skip_reason: target.skipReason,
        applied: false,
      });
      continue;
    }
    if (!owned) {
      issues.push({
        number: target.number,
        kind: target.kind,
        ...(target.kind === "work_item" ? { work_item_id: target.workItemId } : {}),
        state: issue.state,
        action: "skip",
        skip_reason: "ownership_marker_mismatch",
        applied: false,
      });
      continue;
    }
    const desiredLifecycle = deriveIssueLifecycleAction({
      terminalOutcome: input.manifest.terminal?.outcome
        ?? (input.manifest.assurance_outcome === "abandoned" ? "abandoned" : null),
      pullRequestState: pullRequestReport?.identity_verified === true && pullRequestReport.managed_links_verified === true
        ? pullRequest?.state ?? null : null,
      pullRequestBase: pullRequestReport?.identity_verified === true && pullRequestReport.managed_links_verified === true
        ? pullRequest?.base_ref ?? null : null,
      defaultBranch,
      issueState: "OPEN",
    });
    if (desiredLifecycle.action !== "close") {
      issues.push({
        number: target.number,
        kind: target.kind,
        ...(target.kind === "work_item" ? { work_item_id: target.workItemId } : {}),
        state: issue.state,
        action: desiredLifecycle.action === "none" ? "none" : "keep_open",
        applied: false,
      });
      continue;
    }
    let applied = false;
    const operationId = `issue:${target.number}:close:${desiredLifecycle.reason}`;
    const expectedStateReason = desiredLifecycle.reason === "completed" ? "COMPLETED" : "NOT_PLANNED";
    const terminalLabel = desiredLifecycle.reason === "completed" ? "brain-hands:complete" : "brain-hands:not-planned";
    let currentIssue = issue;
    const priorOperation = (await readIssueLifecycleCheckpoint(input.runDir)).operations[operationId];
    if (currentIssue.state === "CLOSED" && currentIssue.state_reason !== expectedStateReason) {
      issues.push({
        number: target.number,
        kind: target.kind,
        ...(target.kind === "work_item" ? { work_item_id: target.workItemId } : {}),
        state: currentIssue.state,
        action: "skip",
        skip_reason: "closed_with_different_reason",
        applied: false,
      });
      continue;
    }
    if (priorOperation?.status === "completed" && currentIssue.state === "OPEN") {
      issues.push({
        number: target.number,
        kind: target.kind,
        ...(target.kind === "work_item" ? { work_item_id: target.workItemId } : {}),
        state: currentIssue.state,
        action: "skip",
        skip_reason: "previous_brain_hands_close_was_reopened",
        applied: false,
      });
      continue;
    }
    if (input.apply) {
      const prior = priorOperation;
      const alreadyConverged = currentIssue.state === "CLOSED"
        && currentIssue.state_reason === expectedStateReason
        && Array.isArray(currentIssue.labels)
        && hasExactManagedStateLabel(currentIssue.labels, terminalLabel);
      if (!alreadyConverged || prior?.status !== "completed") {
      await recordIntent({
        runDir: input.runDir,
        operationId,
        kind: "issue_close",
        targetNumber: target.number,
        reason: desiredLifecycle.reason,
        desiredHash: sha256(`${input.manifest.run_id}:${target.number}:${desiredLifecycle.reason}:${terminalLabel}`),
        now,
        rearmCompleted: prior?.status === "completed",
        budget: input.budget,
      });
      if (currentIssue.state === "OPEN") {
        try {
          await input.github.closeIssue(target.number, desiredLifecycle.reason);
          applied = true;
        } catch {
          // Recover a lost close response from the mandatory fresh read below.
        }
        currentIssue = await input.github.getIssue(target.number);
      }
      if (currentIssue.state !== "CLOSED" || currentIssue.state_reason !== expectedStateReason) {
        throw new Error(`GitHub issue #${target.number} did not converge to ${expectedStateReason}`);
      }
      const edit = managedStateLabelEdit({ ...currentIssue, labels: currentIssue.labels ?? [] }, terminalLabel);
      if (edit.add.length > 0 || edit.remove.length > 0) {
        try {
          await input.github.updateIssueLabels(target.number, { add: edit.add, remove: edit.remove });
          applied = true;
        } catch {
          // Recover a lost label response from the mandatory fresh read below.
        }
        currentIssue = await input.github.getIssue(target.number);
      }
      if (currentIssue.state !== "CLOSED" || currentIssue.state_reason !== expectedStateReason
        || !Array.isArray(currentIssue.labels) || !hasExactManagedStateLabel(currentIssue.labels, terminalLabel)) {
        throw new Error(`GitHub issue #${target.number} terminal state or managed labels did not converge`);
      }
      await recordCompletion({ runDir: input.runDir, operationId, now });
      }
    }
    issues.push({
      number: target.number,
      kind: target.kind,
      ...(target.kind === "work_item" ? { work_item_id: target.workItemId } : {}),
      state: currentIssue.state,
      action: "close",
      reason: desiredLifecycle.reason,
      applied,
    });
  }

  return {
    version: 1,
    run_id: input.manifest.run_id,
    mode: input.apply ? "apply" : "dry_run",
    default_branch: defaultBranch,
    pull_request: pullRequestReport,
    issues,
  };
}

async function authoritativeTaskLineageLifecycle(input: {
  runDir: string;
  manifest: RunManifestV2;
  lineage: TaskLineageRecordV1;
  runTransaction: RunLedgerTransaction;
}): Promise<{ manifest: RunManifestV2; authority: TaskLineageLifecycleAuthority }> {
  const { manifest: supplied, lineage } = input;
  const issueReference = lineage.issue_set.preview;
  const deliveryReference = lineage.delivery.preview;
  if (issueReference?.state !== "applied" || deliveryReference?.state !== "applied"
    || supplied.github_effects.issue_sync === null || supplied.github_effects.pull_request_delivery === null
    || !samePreviewIdentity(supplied.github_effects.issue_sync, issueReference)
    || supplied.github_effects.pull_request_delivery.phase !== deliveryReference.phase
    || supplied.github_effects.pull_request_delivery.revision !== deliveryReference.revision
    || supplied.github_effects.pull_request_delivery.path !== deliveryReference.path
    || supplied.github_effects.pull_request_delivery.sha256 !== deliveryReference.sha256
    || supplied.github_effects.pull_request_delivery.plan_revision !== deliveryReference.plan_revision
    || supplied.github_effects.pull_request_delivery.plan_sha256 !== deliveryReference.plan_sha256
    || lineage.issue_set.state !== "ready" || lineage.delivery.state !== "ready"
    || lineage.repository_key === null || lineage.delivery.pull_request_number === null
    || lineage.delivery.pull_request_url === null || lineage.delivery.branch_name === null || lineage.delivery.head_sha === null) {
    throw new Error("Merge reconciliation requires exact applied issue and delivery lineage authority");
  }
  const issuePreview = await readVerifiedGithubEffectPreview({ run_dir: input.runDir, reference: issueReference, expected: {
    phase: "issue_sync", lineage_id: lineage.lineage_id, run_id: supplied.run_id,
    plan_revision: issueReference.plan_revision, plan_sha256: issueReference.plan_sha256,
  } });
  assertReadyAppliedIssueSet({ repoRoot: supplied.repo_root, lineageId: lineage.lineage_id, runId: supplied.run_id,
    repositoryKey: lineage.repository_key, preview: issuePreview }, lineage);
  const deliveryPreview = await readVerifiedGithubEffectPreview({ run_dir: input.runDir, reference: deliveryReference, expected: {
    phase: "pull_request_delivery", lineage_id: lineage.lineage_id, run_id: supplied.run_id,
    plan_revision: deliveryReference.plan_revision, plan_sha256: deliveryReference.plan_sha256,
  } });
  if (!isDeepStrictEqual(issuePreview.repository, deliveryPreview.repository)
    || deliveryReference.plan_revision !== issueReference.plan_revision
    || deliveryReference.plan_sha256 !== issueReference.plan_sha256
    || `${deliveryPreview.repository.host}/${deliveryPreview.repository.name_with_owner}`.toLowerCase() !== lineage.repository_key.toLowerCase()) {
    throw new Error("Applied delivery preview repository does not match issue and lineage authority");
  }
  const pullRequestUrl = new URL(lineage.delivery.pull_request_url);
  const expectedPullRequestPath = `/${deliveryPreview.repository.name_with_owner}/pull/${lineage.delivery.pull_request_number}`.toLowerCase();
  if (pullRequestUrl.protocol !== "https:" || pullRequestUrl.hostname.toLowerCase() !== deliveryPreview.repository.host.toLowerCase()
    || pullRequestUrl.pathname.toLowerCase() !== expectedPullRequestPath || pullRequestUrl.search !== "" || pullRequestUrl.hash !== "") {
    throw new Error("Authoritative lineage pull request URL does not match the applied delivery repository");
  }
  const branchEffect = deliveryPreview.effects.find((effect): effect is Extract<GithubEffect, { target: { kind: "branch" } }> => effect.target.kind === "branch");
  const pullRequestEffect = deliveryPreview.effects.find((effect): effect is Extract<GithubEffect, { target: { kind: "pull_request" } }> => effect.target.kind === "pull_request");
  if (deliveryPreview.effects.length !== 2 || branchEffect?.target.kind !== "branch"
    || branchEffect.target.branch_name !== lineage.delivery.branch_name
    || pullRequestEffect?.target.kind !== "pull_request"
    || (pullRequestEffect.action === "open"
      ? pullRequestEffect.existing_number !== null
      : pullRequestEffect.existing_number !== lineage.delivery.pull_request_number)) {
    throw new Error("Applied delivery preview does not match the authoritative branch and pull request identity");
  }
  const targets = issuePreview.effects.map((effect) => {
    if (effect.target.kind !== "parent" && effect.target.kind !== "work_item") throw new Error("Applied issue preview has a non-issue target");
    const operation = lineage.issue_set.operations[effect.effect_id];
    if (operation?.state !== "complete" || operation.issue_number === null) throw new Error("Applied issue preview target has no completed lineage mapping");
    return effect.target.kind === "parent"
      ? { number: operation.issue_number, kind: "parent" as const, featureSlug: effect.target.feature_slug }
      : { number: operation.issue_number, kind: "work_item" as const, workItemId: effect.target.work_item_id };
  });
  const featureSlug = targets.find((target) => target.kind === "parent")?.featureSlug
    ?? resolveFeatureSlug(brainPlanSchema.parse(JSON.parse(await readVerifiedPlanRevision(input.runDir, supplied, issueReference.plan_revision))));
  const workMap = { ...lineage.issue_set.work_item_issue_map };
  const workNumbers = Object.values(workMap);
  const githubIds = {
    ...supplied.github_ids,
    issue_numbers: workNumbers,
    work_item_issue_map: workMap,
    parent_issue_number: lineage.issue_set.parent_issue_number,
    pull_request_numbers: [lineage.delivery.pull_request_number],
    pull_request_urls: { [String(lineage.delivery.pull_request_number)]: lineage.delivery.pull_request_url },
  };
  const mirrorsExact = isDeepStrictEqual(supplied.issue_numbers, workNumbers)
    && isDeepStrictEqual(supplied.work_item_issue_map, workMap)
    && isDeepStrictEqual(supplied.github_ids, githubIds)
    && isDeepStrictEqual(supplied.pull_request_numbers, [lineage.delivery.pull_request_number])
    && supplied.branch_name === lineage.delivery.branch_name;
  const manifest = mirrorsExact ? supplied
    : await input.runTransaction.updateManifestV2({
        issue_numbers: workNumbers,
        work_item_issue_map: workMap,
        github_ids: githubIds,
        pull_request_numbers: [lineage.delivery.pull_request_number],
        branch_name: lineage.delivery.branch_name,
      });
  return { manifest, authority: {
    lineageId: lineage.lineage_id, featureSlug, targets,
    pullRequestNumber: lineage.delivery.pull_request_number,
    pullRequestUrl: lineage.delivery.pull_request_url,
    branchName: lineage.delivery.branch_name,
    headSha: lineage.delivery.head_sha,
  } };
}

export async function reconcileGitHubIssues(
  input: Parameters<typeof reconcileGitHubIssuesUnlocked>[0],
): ReturnType<typeof reconcileGitHubIssuesUnlocked> {
  const observed = await readManifestV2(input.runDir);
  if (observed.run_id !== input.manifest.run_id || observed.repo_root !== input.manifest.repo_root) {
    throw new Error("GitHub lifecycle reconciliation input does not identify the current run ledger");
  }
  if (observed.task_lineage_id !== null) {
    return withTaskLineageTransaction({
      repoRoot: observed.repo_root,
      lineageId: observed.task_lineage_id,
      operation: (lineageTransaction) => withRunLedgerTransaction(input.runDir, async (runTransaction) => {
        const manifest = await runTransaction.readManifestV2();
        const lineage = lineageTransaction.read();
        if (manifest.run_id !== input.manifest.run_id || manifest.repo_root !== observed.repo_root
          || manifest.task_lineage_id !== lineage.lineage_id || lineage.active_run_id !== manifest.run_id) {
          throw new Error("GitHub lifecycle reconciliation binding changed");
        }
        if (manifest.github_cleanup !== null) {
          return reconcileGithubCleanupUnlocked({ ...input, manifest, runTransaction, lineageTransaction });
        }
        if (lineage.state === "abandoned" || lineage.state === "closed_blocked"
          || manifest.terminal?.outcome === "abandoned" || manifest.terminal?.outcome === "closed_blocked"
          || manifest.assurance_outcome === "abandoned") {
          throw new Error("Terminal not-planned GitHub lineage is missing its durable cleanup batch");
        }
        const terminalOutcome = manifest.terminal?.outcome ?? null;
        const terminalMirrorValid = lineage.state === "active"
          ? terminalOutcome === null
          : lineage.state === "delivery_ready"
            ? terminalOutcome === "delivered"
            : lineage.state === "human_accepted" || lineage.state === "completed"
              ? terminalOutcome === "delivered" || terminalOutcome === "human_accepted"
              : false;
        if (!terminalMirrorValid) {
          throw new Error(`Task lineage state ${lineage.state} does not match the durable terminal disposition`);
        }
        const authoritative = await authoritativeTaskLineageLifecycle({ runDir: input.runDir, manifest, lineage, runTransaction });
        const report = await reconcileGitHubIssuesUnlocked({ ...input, manifest: authoritative.manifest,
          lineageState: lineage.state, taskAuthority: authoritative.authority });
        if (input.apply && report.pull_request?.identity_verified === true
          && report.pull_request.managed_links_verified === true
          && report.pull_request.default_branch_compatible
          && report.pull_request.state === "MERGED") {
          const expectedTargets = authoritative.authority.targets.map((target) => target.number).sort((left, right) => left - right);
          const completedTargets = report.issues
            .filter((issue) => issue.state === "CLOSED" && issue.action === "close" && issue.skip_reason === undefined)
            .map((issue) => issue.number).sort((left, right) => left - right);
          if (!isDeepStrictEqual(completedTargets, expectedTargets)) {
            throw new Error("Merged lineage cannot complete until every authoritative issue target has an exact completed checkpoint");
          }
          const checkpoint = await readIssueLifecycleCheckpoint(input.runDir);
          for (const number of expectedTargets) {
            const operation = checkpoint.operations[`issue:${number}:close:completed`];
            if (operation?.status !== "completed" || operation.target_number !== number || operation.reason !== "completed") {
              throw new Error(`Merged lineage target #${number} has no exact durable completed checkpoint`);
            }
          }
          if (lineage.state !== "completed") {
            await lineageTransaction.update({ ...lineage, state: "completed" });
          }
        }
        return report;
      }),
    });
  }
  return withRunLedgerTransaction(input.runDir, async (transaction) => {
    const manifest = await transaction.readManifestV2();
    if (manifest.run_id !== input.manifest.run_id || manifest.task_lineage_id !== null) {
      throw new Error("Legacy GitHub lifecycle reconciliation binding changed");
    }
    return reconcileGitHubIssuesUnlocked(input);
  });
}
