import { isDeepStrictEqual } from "node:util";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type {
  GitHubAdapter,
  GitHubPullRequestReference,
  OpenIntegratedPullRequestInputCompat,
} from "../adapters/github.js";
import { pushCommitToBranch as pushCommitToBranchDefault } from "../adapters/git.js";
import { appendRunEvent, readManifestV2, transitionRun, withRunLedgerTransaction } from "../core/ledger.js";
import { withTaskLineageTransaction, type TaskLineageRecordV1 } from "../core/task-lineage.js";
import type { GithubEffectPreviewRef, RunManifestV2 } from "../core/types.js";
import { readOwnedRunFile } from "../core/owned-evidence.js";
import { assertReadyAppliedIssueSet } from "./github-issue-reconciliation.js";
import {
  planPullRequestDeliveryPreview,
  readVerifiedGithubEffectPreview,
  writeGithubEffectPreview,
  type DesiredPullRequestMaterial,
  type GithubEffectPreviewV1,
  type ObservedPullRequestMaterial,
  type PullRequestDeliveryPlanningInput,
} from "../github/effect-plan.js";

export async function openIntegratedPullRequestThroughDeliveryGateway(
  github: Pick<GitHubAdapter, "openIntegratedPullRequest">,
  input: OpenIntegratedPullRequestInputCompat,
): Promise<GitHubPullRequestReference> {
  if (!github.openIntegratedPullRequest) throw new Error("GitHub delivery requires integrated pull-request mutation support");
  return github.openIntegratedPullRequest(input);
}

function sameReference(left: GithubEffectPreviewRef | null, right: GithubEffectPreviewRef | null): boolean {
  return left !== null && right !== null
    && left.phase === right.phase && left.revision === right.revision && left.path === right.path
    && left.sha256 === right.sha256 && left.plan_revision === right.plan_revision
    && left.plan_sha256 === right.plan_sha256 && left.state === right.state;
}

function sameReferenceIdentity(left: GithubEffectPreviewRef | null, right: GithubEffectPreviewRef | null): boolean {
  return left !== null && right !== null
    && left.phase === right.phase && left.revision === right.revision && left.path === right.path
    && left.sha256 === right.sha256 && left.plan_revision === right.plan_revision && left.plan_sha256 === right.plan_sha256;
}

function sortedNumbers(values: readonly number[]): number[] {
  const result = [...values].sort((left, right) => left - right);
  if (result.some((value) => !Number.isSafeInteger(value) || value < 1) || new Set(result).size !== result.length) {
    throw new Error("GitHub delivery closing issue numbers must be unique positive integers");
  }
  return result;
}

function authoritativeIssueNumbers(lineage: TaskLineageRecordV1): number[] {
  return sortedNumbers([
    ...(lineage.issue_set.parent_issue_number === null ? [] : [lineage.issue_set.parent_issue_number]),
    ...Object.values(lineage.issue_set.work_item_issue_map),
  ]);
}

function assertRepositoryPullRequestUrl(reference: Pick<ObservedPullRequestMaterial, "number" | "url">, repository: PullRequestDeliveryPlanningInput["repository"]): void {
  const url = new URL(reference.url);
  const expectedPath = `/${repository.name_with_owner.toLowerCase()}/pull/${reference.number}`;
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== repository.host.toLowerCase()
    || url.pathname.toLowerCase() !== expectedPath || url.search !== "" || url.hash !== "") {
    throw new Error(`Pull request #${reference.number} URL is not bound to the preview repository`);
  }
}

function assertPlanningBinding(
  planning: PullRequestDeliveryPlanningInput,
  manifest: RunManifestV2,
  lineage: TaskLineageRecordV1,
): void {
  const hasPersistedPrior = Object.prototype.hasOwnProperty.call(lineage.delivery, "preview_prior_head_sha");
  const expectedPriorHead = lineage.delivery.state === "uninitialized"
    ? lineage.delivery.head_sha
    : lineage.delivery.preview_prior_head_sha;
  if (planning.lineage_id !== lineage.lineage_id || planning.run_id !== manifest.run_id
    || manifest.task_lineage_id !== lineage.lineage_id || lineage.active_run_id !== manifest.run_id
    || lineage.repository_key !== `${planning.repository.host}/${planning.repository.name_with_owner}`.toLowerCase()
    || planning.plan_revision !== manifest.approved_plan_revision
    || manifest.plan_revisions[String(planning.plan_revision)]?.sha256 !== planning.plan_sha256
    || planning.lineage_state !== lineage.state
    || (lineage.delivery.state !== "uninitialized" && !hasPersistedPrior)
    || planning.authorized_prior_head_sha !== expectedPriorHead) {
    throw new Error("GitHub delivery planning is not bound to the active lineage, run, repository, and approved plan");
  }
  if (lineage.issue_set.state !== "ready" || lineage.issue_set.preview?.state !== "applied") {
    throw new Error("GitHub delivery requires the authoritative applied issue set");
  }
  if (!isDeepStrictEqual(sortedNumbers(planning.pull_request.desired.closing_issue_numbers), authoritativeIssueNumbers(lineage))) {
    throw new Error("GitHub delivery closing references do not match the authoritative lineage issue mappings");
  }
  if (planning.branch.branch_name !== manifest.branch_name) throw new Error("GitHub delivery branch does not match the persisted run branch");
  for (const observation of planning.pull_request.observations) assertRepositoryPullRequestUrl(observation, planning.repository);
}

async function assertAppliedIssueInvariant(
  runDir: string,
  repoRoot: string,
  planning: PullRequestDeliveryPlanningInput,
  lineage: TaskLineageRecordV1,
): Promise<void> {
  const reference = lineage.issue_set.preview;
  if (reference === null || reference.state !== "applied") throw new Error("GitHub delivery requires the exact applied issue preview");
  const preview = await readVerifiedGithubEffectPreview({ run_dir: runDir, reference, expected: {
    phase: "issue_sync", lineage_id: lineage.lineage_id, run_id: planning.run_id,
    plan_revision: reference.plan_revision, plan_sha256: reference.plan_sha256,
  } });
  assertReadyAppliedIssueSet({ repoRoot, lineageId: lineage.lineage_id, runId: planning.run_id,
    repositoryKey: lineage.repository_key!, preview }, lineage);
}

export interface PrepareDeliveryEffectInput {
  runDir: string;
  repoRoot: string;
  planning: PullRequestDeliveryPlanningInput;
  manifest?: RunManifestV2;
  lineage?: TaskLineageRecordV1;
  afterArtifactPersisted?: () => Promise<void>;
  afterLineagePersisted?: () => Promise<void>;
}

async function readDeliveryArtifact(
  runDir: string,
  planning: PullRequestDeliveryPlanningInput,
): Promise<{ preview: GithubEffectPreviewV1; reference: GithubEffectPreviewRef } | null> {
  const path = `github-effects/pull-request-delivery/revision-${planning.revision}.json`;
  let bytes: Buffer;
  try { bytes = await readOwnedRunFile(runDir, path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const reference: GithubEffectPreviewRef = {
    phase: "pull_request_delivery", revision: planning.revision, path,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    plan_revision: planning.plan_revision, plan_sha256: planning.plan_sha256, state: "previewed",
  };
  const preview = await readVerifiedGithubEffectPreview({ run_dir: runDir, reference, expected: {
    phase: "pull_request_delivery", lineage_id: planning.lineage_id, run_id: planning.run_id,
    plan_revision: planning.plan_revision, plan_sha256: planning.plan_sha256,
  } });
  return { preview, reference };
}

function samePlannedEffect(left: GithubEffectPreviewV1, right: GithubEffectPreviewV1): boolean {
  return left.observation_sha256 === right.observation_sha256 && left.desired_sha256 === right.desired_sha256
    && isDeepStrictEqual(left.effects, right.effects);
}

function normalizeLeaseInternals(manifest: RunManifestV2): RunManifestV2 {
  return {
    ...manifest,
    updated_at: "",
    execution_epoch: 0,
    execution_lease: manifest.execution_lease === null || manifest.execution_lease === undefined
      ? null
      : {
        ...manifest.execution_lease,
        heartbeat_at: "",
        authority_sha256: "0".repeat(64),
      },
  };
}

/** Persist the immutable pre-push boundary. This function performs no GitHub or git mutation. */
export async function prepareDeliveryEffectBoundary(input: PrepareDeliveryEffectInput): Promise<GithubEffectPreviewV1> {
  const manifest = input.manifest ?? await readManifestV2(input.runDir);
  if (manifest.stage !== "final_verification" && manifest.stage !== "awaiting_github_delivery_effects") {
    throw new Error(`GitHub delivery preview requires final_verification or its awaiting stage, got ${manifest.stage}`);
  }
  const observedLineage = input.lineage ?? await withTaskLineageTransaction({
    repoRoot: input.repoRoot, lineageId: input.planning.lineage_id, operation: (transaction) => transaction.read(),
  });
  assertPlanningBinding(input.planning, manifest, observedLineage);
  await assertAppliedIssueInvariant(input.runDir, input.repoRoot, input.planning, observedLineage);
  const invalidatedReference = observedLineage.delivery.preview?.state === "invalidated"
    ? observedLineage.delivery.preview
    : null;
  const planning = invalidatedReference === null
    ? input.planning
    : { ...input.planning, revision: invalidatedReference.revision + 1 };
  const artifact = await readDeliveryArtifact(input.runDir, planning);
  const recoveringArtifact = artifact !== null && (
    !sameReferenceIdentity(manifest.github_effects.pull_request_delivery, artifact.reference)
    || !sameReferenceIdentity(observedLineage.delivery.preview, artifact.reference)
  );
  const preview = planPullRequestDeliveryPreview({ ...planning, created_at: artifact?.preview.created_at ?? planning.created_at });
  if (artifact && artifact.preview.authorized_prior_head_sha !== planning.authorized_prior_head_sha) {
    throw new Error("Immutable delivery preview artifact has unauthorized prior-head authority");
  }
  if (artifact && !recoveringArtifact && !samePlannedEffect(preview, artifact.preview)) throw new Error("Immutable delivery preview artifact conflicts with current planning observations");
  const effectivePreview = artifact?.preview ?? preview;
  if (effectivePreview.phase !== "pull_request_delivery") throw new Error("Delivery planner returned the wrong preview phase");
  const reference = artifact?.reference ?? await writeGithubEffectPreview({ run_dir: input.runDir, preview: effectivePreview });
  if (artifact === null) await input.afterArtifactPersisted?.();
  await readVerifiedGithubEffectPreview({
    run_dir: input.runDir,
    reference,
    expected: {
      phase: "pull_request_delivery", lineage_id: effectivePreview.lineage_id, run_id: effectivePreview.run_id,
      plan_revision: effectivePreview.plan_revision, plan_sha256: effectivePreview.plan_sha256,
    },
  });
  await withTaskLineageTransaction({
    repoRoot: input.repoRoot,
    lineageId: effectivePreview.lineage_id,
    operation: async (transaction) => {
      const lineage = transaction.read();
      if (input.lineage && !isDeepStrictEqual(lineage, input.lineage)
        && !sameReferenceIdentity(lineage.delivery.preview, reference)) throw new Error("Task lineage changed after delivery preview observation");
      assertPlanningBinding(planning, manifest, lineage);
      await assertAppliedIssueInvariant(input.runDir, input.repoRoot, planning, lineage);
      const replacingInvalidated = lineage.delivery.preview?.state === "invalidated"
        && invalidatedReference !== null
        && sameReference(lineage.delivery.preview, invalidatedReference);
      if (lineage.delivery.preview !== null && !sameReference(lineage.delivery.preview, reference) && !replacingInvalidated) {
        throw new Error("Task lineage has a conflicting delivery preview");
      }
      if (lineage.delivery.state !== "uninitialized") throw new Error("A new delivery preview requires uninitialized delivery state");
      if (lineage.delivery.preview === null || replacingInvalidated) {
        await transaction.update({
          ...lineage,
          delivery: { ...lineage.delivery, preview: reference, preview_prior_head_sha: planning.authorized_prior_head_sha ?? null },
        });
      }
      await input.afterLineagePersisted?.();
      await withRunLedgerTransaction(input.runDir, async (runTransaction) => {
        const current = await runTransaction.readManifestV2();
        if (!isDeepStrictEqual(normalizeLeaseInternals(current), normalizeLeaseInternals(manifest))) {
          throw new Error("Run manifest changed after delivery preview observation");
        }
        const replacingManifestInvalidated = current.github_effects.pull_request_delivery?.state === "invalidated"
          && invalidatedReference !== null
          && sameReference(current.github_effects.pull_request_delivery, invalidatedReference);
        if (current.github_effects.pull_request_delivery !== null
          && !sameReference(current.github_effects.pull_request_delivery, reference)
          && !replacingManifestInvalidated) {
          throw new Error("Run manifest has a conflicting delivery preview");
        }
        let next = current.github_effects.pull_request_delivery === null || replacingManifestInvalidated
          ? await runTransaction.updateManifestV2({
              github_effects: { ...current.github_effects, pull_request_delivery: reference },
              delivery_state: "pending", last_blocker: null,
            })
          : current;
        if (next.stage !== "awaiting_github_delivery_effects") {
          next = await transitionRun(input.runDir, "awaiting_github_delivery_effects", {
            actor: "runtime",
            payload: { preview_revision: effectivePreview.revision, preview_sha256: effectivePreview.preview_sha256 },
          });
        }
        return next;
      });
    },
  });
  return effectivePreview;
}

export interface ApplyDeliveryEffectInput {
  runDir: string;
  repoRoot: string;
  worktreePath: string;
  remote?: string;
  preview: GithubEffectPreviewV1;
  planning: Omit<PullRequestDeliveryPlanningInput, "revision" | "created_at" | "branch" | "pull_request"> & {
    branch: Omit<PullRequestDeliveryPlanningInput["branch"], "observed_head_sha">;
    pull_request: { desired: DesiredPullRequestMaterial };
  };
  localHead(): Promise<string>;
  remoteHead(): Promise<string | null>;
  observePullRequests(): Promise<ObservedPullRequestMaterial[]>;
  pushCommitToBranch?: typeof pushCommitToBranchDefault;
  openPullRequest(desired: DesiredPullRequestMaterial): Promise<GitHubPullRequestReference>;
  updatePullRequestBody(number: number, body: string): Promise<void>;
  getPullRequest(number: number): Promise<ObservedPullRequestMaterial>;
  afterLineageReady?: () => Promise<void>;
  hooks?: {
    afterLineageInvalidated?: () => Promise<void>;
    afterReplacementArtifact?: () => Promise<void>;
    afterReplacementLineage?: () => Promise<void>;
  };
}

export type ApplyDeliveryEffectResult =
  | { outcome: "applied"; pull_request: GitHubPullRequestReference }
  | { outcome: "replacement_preview"; preview: GithubEffectPreviewV1 };

function exactObserved(reference: ObservedPullRequestMaterial, desired: DesiredPullRequestMaterial): boolean {
  return reference.title === desired.title && reference.body === desired.body
    && reference.head_ref === desired.head_ref && reference.head_sha === desired.head_sha
    && reference.base_ref === desired.base_ref && reference.state === "OPEN"
    && isDeepStrictEqual(sortedNumbers(reference.closing_issue_numbers), sortedNumbers(desired.closing_issue_numbers));
}

function toReference(observed: ObservedPullRequestMaterial): GitHubPullRequestReference {
  return { ...observed, closing_issue_numbers: [...observed.closing_issue_numbers] };
}

async function persistReplacement(
  input: ApplyDeliveryEffectInput,
  lineage: TaskLineageRecordV1,
  replacement: GithubEffectPreviewV1,
): Promise<void> {
  const old = lineage.delivery.preview;
  if (old === null) throw new Error("Delivery replacement requires an attached preview");
  const invalidated = { ...old, state: "invalidated" as const };
  await withTaskLineageTransaction({ repoRoot: input.repoRoot, lineageId: lineage.lineage_id, operation: async (transaction) => {
    let current = transaction.read();
    if (!sameReference(current.delivery.preview, old)) throw new Error("Task lineage changed before delivery preview invalidation");
    current = await transaction.update({ ...current, delivery: { ...current.delivery, preview: invalidated } });
    await input.hooks?.afterLineageInvalidated?.();
    await withRunLedgerTransaction(input.runDir, async (runTransaction) => {
      const manifest = await runTransaction.readManifestV2();
      if (!sameReference(manifest.github_effects.pull_request_delivery, old)) throw new Error("Run manifest changed before delivery preview invalidation");
      await runTransaction.updateManifestV2({ github_effects: { ...manifest.github_effects, pull_request_delivery: invalidated } });
      const events = await readFile(join(input.runDir, "events.jsonl"), "utf8");
      if (!events.includes(`\"old_sha256\":\"${old.sha256}\"`)) {
        await appendRunEvent(input.runDir, { actor: "runtime", type: "github_effect_preview_invalidated", payload: {
          old_phase: old.phase, old_revision: old.revision, old_path: old.path, old_sha256: old.sha256,
          old_plan_revision: old.plan_revision, old_plan_sha256: old.plan_sha256,
          replacement_revision: replacement.revision, reason: "observed_delivery_drift",
        } });
      }
    });
  } });
  const reference = await writeGithubEffectPreview({ run_dir: input.runDir, preview: replacement });
  await input.hooks?.afterReplacementArtifact?.();
  await withTaskLineageTransaction({ repoRoot: input.repoRoot, lineageId: lineage.lineage_id, operation: async (transaction) => {
    const current = transaction.read();
    if (!sameReference(current.delivery.preview, invalidated)) throw new Error("Task lineage changed before delivery replacement attachment");
    await transaction.update({ ...current, delivery: { ...current.delivery, state: "uninitialized", preview: reference } });
    await input.hooks?.afterReplacementLineage?.();
    await withRunLedgerTransaction(input.runDir, async (runTransaction) => {
      const manifest = await runTransaction.readManifestV2();
      if (!sameReference(manifest.github_effects.pull_request_delivery, invalidated)) throw new Error("Run manifest changed before delivery replacement attachment");
      await runTransaction.updateManifestV2({
        github_effects: { ...manifest.github_effects, pull_request_delivery: reference },
        delivery_state: "pending", last_blocker: null,
      });
    });
  } });
}

async function attachReplacementArtifact(
  input: ApplyDeliveryEffectInput,
  lineage: TaskLineageRecordV1,
  reference: GithubEffectPreviewRef,
): Promise<void> {
  const invalidated = lineage.delivery.preview;
  if (invalidated === null || invalidated.state !== "invalidated") {
    throw new Error("Artifact-only delivery replacement recovery requires the invalidated prior preview");
  }
  await withTaskLineageTransaction({ repoRoot: input.repoRoot, lineageId: lineage.lineage_id, operation: async (transaction) => {
    const current = transaction.read();
    if (!sameReference(current.delivery.preview, invalidated)) throw new Error("Task lineage changed before delivery replacement recovery");
    await transaction.update({ ...current, delivery: { ...current.delivery, state: "uninitialized", preview: reference } });
    await withRunLedgerTransaction(input.runDir, async (runTransaction) => {
      const manifest = await runTransaction.readManifestV2();
      if (!sameReference(manifest.github_effects.pull_request_delivery, invalidated)) throw new Error("Run manifest changed before delivery replacement recovery");
      await runTransaction.updateManifestV2({
        github_effects: { ...manifest.github_effects, pull_request_delivery: reference },
        delivery_state: "pending", last_blocker: null,
      });
    });
  } });
}

/** Apply one verified delivery preview with an exact remote lease and lineage-first result persistence. */
export async function applyDeliveryEffectPreview(input: ApplyDeliveryEffectInput): Promise<ApplyDeliveryEffectResult> {
  let manifest = await readManifestV2(input.runDir);
  if (manifest.stage !== "awaiting_github_delivery_effects") throw new Error("GitHub delivery effects apply only from their awaiting stage");
  let reference = manifest.github_effects.pull_request_delivery;
  if (reference === null) throw new Error("Run has no active delivery preview");
  let lineageSnapshot = await withTaskLineageTransaction({ repoRoot: input.repoRoot, lineageId: input.preview.lineage_id, operation: (transaction) => transaction.read() });
  const lineageReference = lineageSnapshot.delivery.preview;
  if (lineageReference !== null && !sameReferenceIdentity(reference, lineageReference)) {
    const newer = lineageReference.revision === reference.revision + 1 ? lineageReference
      : reference.revision === lineageReference.revision + 1 ? reference : null;
    const older = newer === lineageReference ? reference : lineageReference;
    if (newer === null || older.state !== "invalidated" || newer.state !== "previewed") {
      throw new Error("Run and lineage delivery preview references conflict");
    }
    const replacement = await readVerifiedGithubEffectPreview({ run_dir: input.runDir, reference: newer, expected: {
      phase: "pull_request_delivery", lineage_id: input.preview.lineage_id, run_id: input.preview.run_id,
      plan_revision: newer.plan_revision, plan_sha256: newer.plan_sha256,
    } });
    await withTaskLineageTransaction({ repoRoot: input.repoRoot, lineageId: input.preview.lineage_id, operation: async (transaction) => {
      const current = transaction.read();
      if (!sameReferenceIdentity(current.delivery.preview, lineageReference)) throw new Error("Lineage changed during replacement reference recovery");
      if (!sameReference(current.delivery.preview, newer)) await transaction.update({ ...current, delivery: { ...current.delivery, state: "uninitialized", preview: newer } });
      await withRunLedgerTransaction(input.runDir, async (runTransaction) => {
        const currentManifest = await runTransaction.readManifestV2();
        if (!sameReferenceIdentity(currentManifest.github_effects.pull_request_delivery, reference)) throw new Error("Manifest changed during replacement reference recovery");
        if (!sameReference(currentManifest.github_effects.pull_request_delivery, newer)) await runTransaction.updateManifestV2({
          github_effects: { ...currentManifest.github_effects, pull_request_delivery: newer }, delivery_state: "pending", last_blocker: null,
        });
      });
    } });
    return { outcome: "replacement_preview", preview: replacement };
  }
  const invalidated = reference.state === "invalidated" || lineageSnapshot.delivery.preview?.state === "invalidated";
  if (invalidated) {
    if (!sameReferenceIdentity(reference, lineageSnapshot.delivery.preview)) throw new Error("Run and lineage delivery invalidation references conflict");
    const invalidatedReference = { ...reference, state: "invalidated" as const };
    await withTaskLineageTransaction({ repoRoot: input.repoRoot, lineageId: input.preview.lineage_id, operation: async (transaction) => {
      const current = transaction.read();
      if (!sameReferenceIdentity(current.delivery.preview, invalidatedReference)) throw new Error("Lineage changed during delivery invalidation recovery");
      if (current.delivery.preview?.state !== "invalidated") await transaction.update({ ...current, delivery: { ...current.delivery, preview: invalidatedReference } });
      await withRunLedgerTransaction(input.runDir, async (runTransaction) => {
        const currentManifest = await runTransaction.readManifestV2();
        if (!sameReferenceIdentity(currentManifest.github_effects.pull_request_delivery, invalidatedReference)) throw new Error("Manifest changed during delivery invalidation recovery");
        if (currentManifest.github_effects.pull_request_delivery?.state !== "invalidated") {
          await runTransaction.updateManifestV2({ github_effects: { ...currentManifest.github_effects, pull_request_delivery: invalidatedReference } });
        }
      });
    } });
    manifest = await readManifestV2(input.runDir);
    reference = manifest.github_effects.pull_request_delivery!;
    lineageSnapshot = await withTaskLineageTransaction({ repoRoot: input.repoRoot, lineageId: input.preview.lineage_id, operation: (transaction) => transaction.read() });
  }
  const approvedPlanRevision = manifest.approved_plan_revision;
  const approvedPlanSha256 = approvedPlanRevision === null ? undefined : manifest.plan_revisions[String(approvedPlanRevision)]?.sha256;
  const recoverableReadyMirrorPrefix = lineageSnapshot.delivery.state === "ready"
    && lineageSnapshot.delivery.preview?.state === "applied" && reference.state === "previewed"
    && sameReferenceIdentity(reference, lineageSnapshot.delivery.preview);
  if (manifest.task_lineage_id !== lineageSnapshot.lineage_id || lineageSnapshot.active_run_id !== manifest.run_id
    || lineageSnapshot.repository_key === null || approvedPlanRevision === null || approvedPlanSha256 === undefined
    || input.planning.lineage_id !== lineageSnapshot.lineage_id || input.planning.run_id !== manifest.run_id
    || `${input.planning.repository.host}/${input.planning.repository.name_with_owner}`.toLowerCase() !== lineageSnapshot.repository_key
    || input.planning.plan_revision !== approvedPlanRevision || input.planning.plan_sha256 !== approvedPlanSha256
    || input.planning.lineage_state !== lineageSnapshot.state
    || (!sameReference(reference, lineageSnapshot.delivery.preview) && !recoverableReadyMirrorPrefix)
    || reference.phase !== "pull_request_delivery" || reference.revision !== input.preview.revision
    || reference.path !== `github-effects/pull-request-delivery/revision-${reference.revision}.json`
    || reference.plan_revision !== approvedPlanRevision || reference.plan_sha256 !== approvedPlanSha256
    || input.preview.phase !== "pull_request_delivery" || input.preview.lineage_id !== lineageSnapshot.lineage_id
    || input.preview.run_id !== manifest.run_id || input.preview.plan_revision !== approvedPlanRevision
    || input.preview.plan_sha256 !== approvedPlanSha256
    || !isDeepStrictEqual(input.preview.repository, input.planning.repository)
    || input.preview.effects.length !== 2
    || input.preview.effects[0]?.target.kind !== "branch" || input.preview.effects[1]?.target.kind !== "pull_request") {
    throw new Error("GitHub delivery preview is not bound to the current run, lineage, repository, plan, and effect schema authority");
  }
  const preview = await readVerifiedGithubEffectPreview({
    run_dir: input.runDir, reference,
    expected: { phase: "pull_request_delivery", lineage_id: lineageSnapshot.lineage_id, run_id: manifest.run_id,
      plan_revision: approvedPlanRevision, plan_sha256: approvedPlanSha256 },
  });
  if (!isDeepStrictEqual(preview, input.preview)) throw new Error("Supplied delivery preview does not match its immutable artifact");
  const authorityPlanning = {
    ...input.planning, revision: preview.revision, created_at: preview.created_at,
    branch: { ...input.planning.branch, observed_head_sha: null },
    pull_request: { desired: input.planning.pull_request.desired, observations: [] },
  };
  assertPlanningBinding(authorityPlanning, manifest, lineageSnapshot);
  await assertAppliedIssueInvariant(input.runDir, input.repoRoot, authorityPlanning, lineageSnapshot);
  if (preview.authorized_prior_head_sha !== authorityPlanning.authorized_prior_head_sha) {
    throw new Error("GitHub delivery preview prior-head authority does not match the lineage-bound planning input");
  }
  const localHead = await input.localHead();
  const remoteHead = await input.remoteHead();
  const pullRequests = await input.observePullRequests();
  const currentPlanning: PullRequestDeliveryPlanningInput = {
    ...input.planning,
    revision: preview.revision,
    created_at: preview.created_at,
    branch: { ...input.planning.branch, head_sha: localHead, observed_head_sha: remoteHead },
    pull_request: { desired: input.planning.pull_request.desired, observations: pullRequests },
  };
  const readyLineage = lineageSnapshot;
  assertPlanningBinding(currentPlanning, manifest, readyLineage);
  await assertAppliedIssueInvariant(input.runDir, input.repoRoot, currentPlanning, readyLineage);
  if (pullRequests.some((observed) => observed.title !== input.planning.pull_request.desired.title)) {
    await withTaskLineageTransaction({
      repoRoot: input.repoRoot,
      lineageId: preview.lineage_id,
      operation: async (transaction) => {
        const current = transaction.read();
        assertPlanningBinding(currentPlanning, manifest, current);
        if (current.delivery.state !== "ambiguous") {
          await transaction.update({ ...current, delivery: { ...current.delivery, state: "ambiguous" } });
        }
      },
    });
    throw new Error("Owned pull request title drift requires operator reconciliation");
  }
  if (readyLineage.delivery.state === "ready") {
    if (readyLineage.delivery.branch_name !== input.planning.branch.branch_name
      || readyLineage.delivery.head_sha !== localHead || remoteHead !== localHead
      || readyLineage.delivery.pull_request_number === null || readyLineage.delivery.pull_request_url === null
      || pullRequests.length !== 1 || pullRequests[0]!.number !== readyLineage.delivery.pull_request_number
      || pullRequests[0]!.url !== readyLineage.delivery.pull_request_url
      || !exactObserved(pullRequests[0]!, input.planning.pull_request.desired)) {
      throw new Error("Ready delivery state no longer has its exact branch and lineage pull-request identity");
    }
    const appliedReference = readyLineage.delivery.preview;
    if (appliedReference === null || appliedReference.state !== "applied"
      || appliedReference.revision !== reference.revision || appliedReference.sha256 !== reference.sha256) {
      throw new Error("Ready delivery state does not retain its exact applied preview");
    }
    await withTaskLineageTransaction({ repoRoot: input.repoRoot, lineageId: preview.lineage_id, operation: async (transaction) => {
      const currentLineage = transaction.read();
      if (!isDeepStrictEqual(currentLineage, readyLineage)) throw new Error("Ready delivery lineage changed before manifest repair");
      await withRunLedgerTransaction(input.runDir, async (runTransaction) => {
        const current = await runTransaction.readManifestV2();
        if (!sameReference(current.github_effects.pull_request_delivery, reference)) throw new Error("Run delivery preview changed before ready repair");
        await runTransaction.updateManifestV2({
          github_effects: { ...current.github_effects, pull_request_delivery: appliedReference },
          pull_request_numbers: current.pull_request_numbers.includes(pullRequests[0]!.number) ? current.pull_request_numbers : [...current.pull_request_numbers, pullRequests[0]!.number],
          github_ids: { ...current.github_ids,
            pull_request_numbers: current.github_ids.pull_request_numbers.includes(pullRequests[0]!.number)
              ? current.github_ids.pull_request_numbers : [...current.github_ids.pull_request_numbers, pullRequests[0]!.number],
            pull_request_urls: { ...current.github_ids.pull_request_urls, [String(pullRequests[0]!.number)]: pullRequests[0]!.url },
          },
          delivery_state: "pending", last_blocker: null,
        });
      });
    } });
    return { outcome: "applied", pull_request: toReference(pullRequests[0]!) };
  }
  const candidate = planPullRequestDeliveryPreview(currentPlanning);
  if (invalidated || candidate.observation_sha256 !== preview.observation_sha256 || candidate.desired_sha256 !== preview.desired_sha256
    || !isDeepStrictEqual(candidate.effects, preview.effects)) {
    const replacementPlanning = { ...currentPlanning, revision: preview.revision + 1, created_at: new Date().toISOString() };
    const artifact = await readDeliveryArtifact(input.runDir, replacementPlanning);
    const lineage = await withTaskLineageTransaction({ repoRoot: input.repoRoot, lineageId: preview.lineage_id, operation: (transaction) => transaction.read() });
    assertPlanningBinding(currentPlanning, manifest, lineage);
    if (artifact) {
      await attachReplacementArtifact(input, lineage, artifact.reference);
      return { outcome: "replacement_preview", preview: artifact.preview };
    }
    const replacement = planPullRequestDeliveryPreview(replacementPlanning);
    await persistReplacement(input, lineage, replacement);
    return { outcome: "replacement_preview", preview: replacement };
  }

  return withTaskLineageTransaction({ repoRoot: input.repoRoot, lineageId: preview.lineage_id, operation: async (transaction) => {
    let lineage = transaction.read();
    assertPlanningBinding(currentPlanning, manifest, lineage);
    await assertAppliedIssueInvariant(input.runDir, input.repoRoot, currentPlanning, lineage);
    if (!sameReference(lineage.delivery.preview, reference)) throw new Error("Lineage and run delivery preview references conflict");
    if (lineage.delivery.state === "ready") {
      if (lineage.delivery.branch_name !== input.planning.branch.branch_name || lineage.delivery.head_sha !== localHead
        || lineage.delivery.pull_request_number === null || lineage.delivery.pull_request_url === null) {
        throw new Error("Ready delivery state is incomplete or conflicts with the preview");
      }
      const observed = await input.getPullRequest(lineage.delivery.pull_request_number);
      if (observed.url !== lineage.delivery.pull_request_url || !exactObserved(observed, input.planning.pull_request.desired)) {
        throw new Error("Persisted lineage pull request no longer has the exact delivery identity");
      }
      assertRepositoryPullRequestUrl(observed, preview.repository);
      return { outcome: "applied", pull_request: toReference(observed) };
    }
    if (lineage.delivery.state === "ambiguous") throw new Error("Ambiguous delivery requires operator reconciliation");
    lineage = await transaction.update({ ...lineage, delivery: {
      ...lineage.delivery, state: "applying", branch_name: input.planning.branch.branch_name, head_sha: localHead,
    } });

    if (remoteHead !== localHead) {
      const push = input.pushCommitToBranch ?? pushCommitToBranchDefault;
      try {
        await push(input.worktreePath, localHead, input.planning.branch.branch_name, remoteHead, input.remote ?? "origin");
      } catch (error) {
        if (await input.remoteHead() !== localHead) throw error;
      }
      if (await input.remoteHead() !== localHead) throw new Error("GitHub delivery push did not reach the exact preview head");
    }

    let observed: ObservedPullRequestMaterial;
    const latestPullRequests = await input.observePullRequests();
    if (pullRequests.length === 0) {
      if (latestPullRequests.length === 1 && exactObserved(latestPullRequests[0]!, input.planning.pull_request.desired)) {
        observed = latestPullRequests[0]!;
      } else {
        if (latestPullRequests.length !== 0) {
          await transaction.update({ ...lineage, delivery: { ...lineage.delivery, state: "ambiguous" } });
          throw new Error("Pull-request lineage ownership changed after delivery preflight");
        }
        try {
          const opened = await input.openPullRequest(input.planning.pull_request.desired);
          observed = await input.getPullRequest(opened.number);
        } catch (error) {
          const recovered = await input.observePullRequests();
          if (recovered.length !== 1 || !exactObserved(recovered[0]!, input.planning.pull_request.desired)) {
            await transaction.update({ ...lineage, delivery: { ...lineage.delivery, state: "ambiguous" } });
            throw error;
          }
          observed = recovered[0]!;
        }
      }
    } else {
      const preflightPullRequest = pullRequests[0]!;
      const latestPullRequest = latestPullRequests[0];
      const authorizedHeadAdvance = latestPullRequests.length === 1
        && latestPullRequest !== undefined
        && preflightPullRequest.head_sha === input.planning.authorized_prior_head_sha
        && latestPullRequest.head_sha === input.planning.pull_request.desired.head_sha
        && isDeepStrictEqual(
          { ...latestPullRequest, head_sha: preflightPullRequest.head_sha },
          preflightPullRequest,
        );
      if (latestPullRequests.length !== 1
        || (!isDeepStrictEqual(latestPullRequest, preflightPullRequest) && !authorizedHeadAdvance)) {
        await transaction.update({ ...lineage, delivery: { ...lineage.delivery, state: "ambiguous" } });
        throw new Error("Pull-request lineage material changed after delivery preflight");
      }
      observed = latestPullRequest!;
      const prEffect = preview.effects.find((effect) => effect.target.kind === "pull_request");
      if (prEffect?.action === "repair") {
        await input.updatePullRequestBody(observed.number, input.planning.pull_request.desired.body);
        observed = await input.getPullRequest(observed.number);
      }
    }
    if (!exactObserved(observed, input.planning.pull_request.desired)) {
      await transaction.update({ ...lineage, delivery: { ...lineage.delivery, state: "ambiguous" } });
      throw new Error("GitHub pull request does not match the exact lineage delivery identity after application");
    }
    assertRepositoryPullRequestUrl(observed, preview.repository);
    const appliedReference = { ...reference, state: "applied" as const };
    lineage = await transaction.update({ ...lineage, delivery: {
      state: "ready", branch_name: input.planning.branch.branch_name, head_sha: localHead,
      preview_prior_head_sha: lineage.delivery.preview_prior_head_sha,
      pull_request_number: observed.number, pull_request_url: observed.url, preview: appliedReference,
    } });
    await input.afterLineageReady?.();
    await withRunLedgerTransaction(input.runDir, async (runTransaction) => {
      const current = await runTransaction.readManifestV2();
      if (!sameReference(current.github_effects.pull_request_delivery, reference)) throw new Error("Run manifest delivery preview changed before result mirror");
      await runTransaction.updateManifestV2({
        github_effects: { ...current.github_effects, pull_request_delivery: appliedReference },
        pull_request_numbers: current.pull_request_numbers.includes(observed.number) ? current.pull_request_numbers : [...current.pull_request_numbers, observed.number],
        github_ids: {
          ...current.github_ids,
          pull_request_numbers: current.github_ids.pull_request_numbers.includes(observed.number)
            ? current.github_ids.pull_request_numbers : [...current.github_ids.pull_request_numbers, observed.number],
          pull_request_urls: { ...current.github_ids.pull_request_urls, [String(observed.number)]: observed.url },
        },
        delivery_state: "pending", last_blocker: null,
      });
    });
    return { outcome: "applied", pull_request: toReference(observed) };
  } });
}
