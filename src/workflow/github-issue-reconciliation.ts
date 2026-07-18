import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { readTaskLineage, withTaskLineageTransaction, type TaskLineageRecordV1 } from "../core/task-lineage.js";
import { issueDesiredMaterialSha256, issueObservedMaterialSha256, readVerifiedGithubEffectPreview, type DesiredIssueMaterial, type GithubEffect, type GithubEffectPreviewV1, type ObservedIssueMaterial } from "../github/effect-plan.js";
import { reconcileManagedIssueBody } from "../adapters/github.js";
import type { ResourceBudgetPort } from "../core/resource-budget.js";
import { claimExternalEffect, completeExternalEffect } from "./resource-budget.js";

export type IssueReconciliationOutcome = "created" | "updated" | "noop";

const targetSchema = z.object({
  issue_number: z.number().int().positive().nullable(),
  desired_hash: z.string().regex(/^[a-f0-9]{64}$/),
  last_outcome: z.enum(["created", "updated", "noop"]),
  first_resolved_at: z.string().datetime().nullable(),
  last_checked_at: z.string().datetime(),
  operation_id: z.string().uuid(),
  operation_state: z.enum(["pending", "complete"]),
}).strict();

export const issueSyncCheckpointSchema = z.object({
  version: z.literal(1),
  targets: z.record(z.string().min(1).max(300), targetSchema),
}).strict();

export type IssueSyncCheckpoint = z.infer<typeof issueSyncCheckpointSchema>;
type IssueSyncTarget = z.infer<typeof targetSchema>;

export interface IssueReconciliationResult {
  outcome: IssueReconciliationOutcome;
  issue_number: number;
  target_key: string;
  desired_hash: string;
  operation_id: string;
}

export interface ReconcileIssueMutationInput {
  runDir: string;
  targetKey: string;
  desiredHash: string;
  found: number | { number: number } | null;
  matchesDesired: boolean;
  create(): Promise<number>;
  update(): Promise<void>;
  budget?: ResourceBudgetPort;
  now?: () => string;
}

type IssueEffect = Extract<GithubEffect, { target: { kind: "parent" | "work_item" } }>;

export interface ApplyIssueEffectTarget {
  effect: IssueEffect;
  desired: DesiredIssueMaterial;
  lookup(): Promise<ObservedIssueMaterial[]>;
  create(): Promise<number>;
  update(issueNumber: number): Promise<void>;
}

export interface ApplyIssueEffectPreviewInput {
  repoRoot: string;
  runDir?: string;
  lineageId: string;
  runId: string;
  repositoryKey: string;
  preview: GithubEffectPreviewV1;
  targets: Record<string, ApplyIssueEffectTarget>;
  buildReplacement?: (input: { observations: Record<string, ObservedIssueMaterial[]>; lineage: TaskLineageRecordV1 }) => GithubEffectPreviewV1;
  hooks?: {
    beforeLockedArtifactVerification?: () => Promise<void>;
    afterRemoteMutation?: (targetKey: string, issueNumber: number) => Promise<void>;
    afterTargetComplete?: (targetKey: string, issueNumber: number) => Promise<void>;
  };
}

export type ApplyIssueEffectPreviewResult =
  | { outcome: "applied"; parent_issue_number: number | null; work_item_issue_map: Record<string, number> }
  | { outcome: "replacement_preview"; preview: GithubEffectPreviewV1 }
  | { outcome: "ambiguous"; target_key: string };

const terminalLineageStates = new Set(["human_accepted", "completed", "abandoned", "closed_blocked"]);

function effectTargetKey(effect: IssueEffect): string {
  return effect.target.kind === "parent" ? "parent" : `work_item:${effect.target.work_item_id}`;
}

type IssueEffectBindingInput = Pick<ApplyIssueEffectPreviewInput, "repoRoot" | "lineageId" | "runId" | "repositoryKey" | "preview">;

function assertIssueSetBinding(input: IssueEffectBindingInput, lineage: TaskLineageRecordV1): void {
  const previewRepository = `${input.preview.repository.host}/${input.preview.repository.name_with_owner}`.toLowerCase();
  if (input.preview.phase !== "issue_sync"
    || input.preview.lineage_id !== input.lineageId
    || input.preview.run_id !== input.runId
    || lineage.lineage_id !== input.lineageId
    || lineage.active_run_id !== input.runId
    || lineage.repository_key !== input.repositoryKey.toLowerCase()
    || previewRepository !== input.repositoryKey.toLowerCase()) {
    throw new Error("Issue effect application requires the exact lineage, active run, repository, and preview binding");
  }
  if (lineage.issue_set.plan_revision !== input.preview.plan_revision
    || lineage.issue_set.plan_sha256 !== input.preview.plan_sha256
    || lineage.issue_set.preview?.revision !== input.preview.revision
    || lineage.issue_set.preview?.sha256 === undefined) {
    throw new Error("Issue effect preview does not match the authoritative lineage reference");
  }
  if (lineage.issue_set.preview?.state === "invalidated") throw new Error("Invalidated issue preview cannot be applied");
}

function assertApplyBinding(input: IssueEffectBindingInput, lineage: TaskLineageRecordV1): void {
  assertIssueSetBinding(input, lineage);
  if (terminalLineageStates.has(lineage.state)) throw new Error("Terminal task lineage rejects issue effect application");
  if (lineage.state !== "active") throw new Error(`Issue effect application requires an active lineage, got ${lineage.state}`);
}

function mappedNumber(lineage: TaskLineageRecordV1, effect: IssueEffect): number | null {
  return effect.target.kind === "parent"
    ? lineage.issue_set.parent_issue_number
    : lineage.issue_set.work_item_issue_map[effect.target.work_item_id] ?? null;
}

function withMapping(lineage: TaskLineageRecordV1, effect: IssueEffect, issueNumber: number): TaskLineageRecordV1 {
  return effect.target.kind === "parent"
    ? { ...lineage, issue_set: { ...lineage.issue_set, parent_issue_number: issueNumber } }
    : { ...lineage, issue_set: { ...lineage.issue_set, work_item_issue_map: { ...lineage.issue_set.work_item_issue_map, [effect.target.work_item_id]: issueNumber } } };
}

export function assertReadyAppliedIssueSet(input: IssueEffectBindingInput, lineage: TaskLineageRecordV1): void {
  assertIssueSetBinding(input, lineage);
  authoritativeReadyIssueNumbers(input, lineage);
}

export function authoritativeReadyIssueNumbers(
  input: IssueEffectBindingInput,
  lineage: TaskLineageRecordV1,
): number[] {
  assertIssueSetBinding(input, lineage);
  const effects = input.preview.effects.filter((effect): effect is IssueEffect => effect.target.kind === "parent" || effect.target.kind === "work_item");
  const reference = lineage.issue_set.preview;
  if (lineage.issue_set.state !== "ready" || reference?.state !== "applied" || reference.revision !== input.preview.revision
    || reference.plan_revision !== input.preview.plan_revision || reference.plan_sha256 !== input.preview.plan_sha256) {
    throw new Error("Authoritative ready issue set requires its exact applied preview");
  }
  const expectedTargets = new Set(effects.map(effectTargetKey));
  const numbers: number[] = [];
  for (const effect of effects) {
    const key = effectTargetKey(effect);
    const operation = lineage.issue_set.operations[effect.effect_id];
    const mapped = mappedNumber(lineage, effect);
    if (!operation || operation.operation_id !== effect.effect_id || operation.target_key !== key
      || operation.desired_sha256 !== effect.desired_sha256 || operation.created_by_run_id !== input.runId
      || operation.state !== "complete" || operation.issue_number === null || mapped !== operation.issue_number) {
      throw new Error(`Authoritative ready issue set has an inconsistent operation or mapping for ${key}`);
    }
    numbers.push(operation.issue_number);
  }
  const expectedWorkItems = effects.flatMap((effect) => effect.target.kind === "work_item" ? [effect.target.work_item_id] : []).sort();
  if (Object.keys(lineage.issue_set.work_item_issue_map).sort().join("\n") !== expectedWorkItems.join("\n")
    || (effects.some((effect) => effect.target.kind === "parent") !== (lineage.issue_set.parent_issue_number !== null))
    || new Set(numbers).size !== numbers.length) throw new Error("Authoritative ready issue set has incomplete, extra, or duplicate mappings");
  for (const operation of Object.values(lineage.issue_set.operations)) {
    if (!effects.some((effect) => effect.effect_id === operation.operation_id)
      && (expectedTargets.has(operation.target_key) || (operation.issue_number !== null && numbers.includes(operation.issue_number)))) {
      throw new Error("Historical issue operation collides with the current ready issue set");
    }
  }
  return [...numbers].sort((left, right) => left - right);
}

function matchesDesiredMaterial(observed: ObservedIssueMaterial, desired: DesiredIssueMaterial, preserveUserText: boolean): boolean {
  return observed.title === desired.title
    && observed.state === desired.state
    && observed.state_reason === desired.state_reason
    && [...observed.labels].sort().join("\n") === [...desired.labels].sort().join("\n")
    && (preserveUserText ? reconcileManagedIssueBody(observed.body, desired.body) === observed.body : observed.body === desired.body);
}

export async function applyIssueEffectPreview(input: ApplyIssueEffectPreviewInput): Promise<ApplyIssueEffectPreviewResult> {
  const initialLineage = await readTaskLineage(input.repoRoot, input.lineageId);
  const authoritativeReference = initialLineage.issue_set.preview;
  if (authoritativeReference === null || authoritativeReference.state === "invalidated") {
    throw new Error("Issue effect application requires a current immutable preview artifact reference");
  }
  const authenticatedPreview = await readVerifiedGithubEffectPreview({
    run_dir: input.runDir ?? input.repoRoot,
    reference: authoritativeReference,
    expected: {
      phase: "issue_sync",
      lineage_id: input.lineageId,
      run_id: input.runId,
      plan_revision: authoritativeReference.plan_revision,
      plan_sha256: authoritativeReference.plan_sha256,
    },
  });
  if (!isDeepStrictEqual(input.preview, authenticatedPreview)) {
    throw new Error("Caller issue preview does not equal the authenticated immutable preview artifact");
  }
  input = { ...input, preview: authenticatedPreview };
  const effects = input.preview.effects.filter((effect): effect is IssueEffect => effect.target.kind === "parent" || effect.target.kind === "work_item");
  if (effects.length !== input.preview.effects.length) throw new Error("Issue preview contains a non-issue effect");
  const expectedKeys = effects.map(effectTargetKey);
  if (new Set(expectedKeys).size !== expectedKeys.length
    || Object.keys(input.targets).sort().join("\n") !== [...expectedKeys].sort().join("\n")) {
    throw new Error("Issue effect targets do not exactly match the immutable preview");
  }
  return withTaskLineageTransaction({
    repoRoot: input.repoRoot,
    lineageId: input.lineageId,
    operation: async (transaction) => {
      let lineage = transaction.read();
      if (!isDeepStrictEqual(lineage.issue_set.preview, authoritativeReference)) {
        throw new Error("Authoritative issue preview reference changed before application");
      }
      await input.hooks?.beforeLockedArtifactVerification?.();
      const lockedPreview = await readVerifiedGithubEffectPreview({
        run_dir: input.runDir ?? input.repoRoot,
        reference: lineage.issue_set.preview!,
        expected: {
          phase: "issue_sync",
          lineage_id: input.lineageId,
          run_id: input.runId,
          plan_revision: lineage.issue_set.preview!.plan_revision,
          plan_sha256: lineage.issue_set.preview!.plan_sha256,
        },
      });
      if (!isDeepStrictEqual(input.preview, lockedPreview)) {
        throw new Error("Immutable issue preview artifact changed before locked application");
      }
      input = { ...input, preview: lockedPreview };
      assertApplyBinding(input, lineage);
      if (lineage.issue_set.state === "ready") {
        assertReadyAppliedIssueSet(input, lineage);
        return { outcome: "applied", parent_issue_number: lineage.issue_set.parent_issue_number, work_item_issue_map: { ...lineage.issue_set.work_item_issue_map } };
      }
      const prepared = new Map<string, { operation: TaskLineageRecordV1["issue_set"]["operations"][string] | undefined; matches: ObservedIssueMaterial[] }>();
      let blocked: { effect: IssueEffect; targetKey: string; operation: TaskLineageRecordV1["issue_set"]["operations"][string] | undefined } | null = null;
      let drifted = false;
      for (const effect of effects) {
        const targetKey = effectTargetKey(effect);
        const target = input.targets[targetKey]!;
        if (target.effect.effect_id !== effect.effect_id) throw new Error(`Issue effect target ${targetKey} changed after preview verification`);
        const operation = lineage.issue_set.operations[effect.effect_id];
        if (operation && (operation.target_key !== targetKey || operation.desired_sha256 !== effect.desired_sha256 || operation.created_by_run_id !== input.runId)) {
          throw new Error(`Issue operation ${effect.effect_id} conflicts with the immutable preview`);
        }
        const conflictingTarget = Object.values(lineage.issue_set.operations)
          .find((candidate) => candidate.operation_id !== effect.effect_id && candidate.target_key === targetKey);
        if (conflictingTarget) throw new Error(`Multiple issue operations claim immutable target ${targetKey}`);
        if (issueDesiredMaterialSha256(effect.target, target.desired) !== effect.desired_sha256) {
          throw new Error(`Issue effect target ${targetKey} desired material changed after preview verification`);
        }
        if (operation?.state === "ambiguous") return { outcome: "ambiguous", target_key: targetKey };
        if (operation?.state === "complete") {
          if (operation.issue_number === null || mappedNumber(lineage, effect) !== operation.issue_number) {
            throw new Error(`Completed issue operation ${effect.effect_id} has an inconsistent mapping`);
          }
          prepared.set(effect.effect_id, { operation, matches: [] });
          continue;
        }
        prepared.set(effect.effect_id, { operation, matches: [] });
      }
      for (const effect of effects) {
        const preparedEffect = prepared.get(effect.effect_id)!;
        if (preparedEffect.operation?.state !== "complete") preparedEffect.matches = await input.targets[effectTargetKey(effect)]!.lookup();
      }
      for (const effect of effects) {
        const targetKey = effectTargetKey(effect);
        const target = input.targets[targetKey]!;
        const preparedEffect = prepared.get(effect.effect_id)!;
        const { operation, matches } = preparedEffect;
        if (operation?.state === "complete") continue;
        if (operation !== undefined) {
          const recovered = matches.length === 1
            && (effect.existing_number === null || matches[0]!.number === effect.existing_number)
            && matchesDesiredMaterial(matches[0]!, target.desired, effect.action === "update");
          if (!recovered && blocked === null) blocked = { effect, targetKey, operation };
          continue;
        }
        if (matches.length > 1) {
          blocked ??= { effect, targetKey, operation };
          continue;
        }
        if (effect.action === "create") {
          if (matches.length !== 0) drifted = true;
          continue;
        }
        if (matches.length !== 1 || matches[0]!.number !== effect.existing_number
          || issueObservedMaterialSha256(effect.target, matches[0]!) !== effect.observed_sha256) {
          drifted = true;
          continue;
        }
        if (effect.action === "reuse" && !matchesDesiredMaterial(matches[0]!, target.desired, false)) {
          drifted = true;
        }
      }
      if (blocked !== null) {
        const operation = blocked.operation ?? {
          operation_id: blocked.effect.effect_id,
          target_key: blocked.targetKey,
          desired_sha256: blocked.effect.desired_sha256,
          state: "ambiguous" as const,
          issue_number: null,
          created_by_run_id: input.runId,
        };
        await transaction.update({
          ...lineage,
          issue_set: {
            ...lineage.issue_set,
            state: "ambiguous",
            operations: { ...lineage.issue_set.operations, [blocked.effect.effect_id]: { ...operation, state: "ambiguous" } },
          },
        });
        return { outcome: "ambiguous", target_key: blocked.targetKey };
      }
      if (drifted) {
        if (!input.buildReplacement) throw new Error("Issue effect preflight drift requires a replacement preview planner");
        const replacement = input.buildReplacement({
          lineage,
          observations: Object.fromEntries(effects.map((effect) => [effectTargetKey(effect), prepared.get(effect.effect_id)!.matches])),
        });
        if (replacement.revision !== input.preview.revision + 1 || replacement.lineage_id !== input.lineageId || replacement.run_id !== input.runId) {
          throw new Error("Replacement issue preview planner returned the wrong immutable identity");
        }
        return { outcome: "replacement_preview", preview: replacement };
      }
      for (const effect of effects) {
        const targetKey = effectTargetKey(effect);
        const target = input.targets[targetKey]!;
        let operation = prepared.get(effect.effect_id)!.operation;
        if (operation?.state === "complete") {
          continue;
        }
        const intentAlreadyExisted = operation !== undefined;
        if (!operation) {
          operation = {
            operation_id: effect.effect_id,
            target_key: targetKey,
            desired_sha256: effect.desired_sha256,
            state: "intent",
            issue_number: null,
            created_by_run_id: input.runId,
          };
          lineage = await transaction.update({
            ...lineage,
            issue_set: { ...lineage.issue_set, state: "applying", operations: { ...lineage.issue_set.operations, [effect.effect_id]: operation } },
          });
        }
        let matches = prepared.get(effect.effect_id)!.matches;
        if (!intentAlreadyExisted && effect.action === "create") {
          matches = await target.lookup();
          const exact = matches.length === 1 && matchesDesiredMaterial(matches[0]!, target.desired, false);
          if (matches.length > 1 || (matches.length === 1 && !exact)) {
            await transaction.update({ ...lineage, issue_set: { ...lineage.issue_set, state: "ambiguous", operations: { ...lineage.issue_set.operations, [effect.effect_id]: { ...operation, state: "ambiguous" } } } });
            return { outcome: "ambiguous", target_key: targetKey };
          }
        }
        let issueNumber = matches[0]?.number ?? null;
        if (issueNumber !== null && effect.existing_number !== null && issueNumber !== effect.existing_number) {
          throw new Error(`Issue effect ${targetKey} no longer matches its authoritative issue number`);
        }
        if (issueNumber === null) {
          if (effect.action !== "create") throw new Error(`Issue effect ${targetKey} lost its uniquely owned issue`);
          try {
            issueNumber = await target.create();
          } catch (error) {
            await transaction.update({
              ...lineage,
              issue_set: { ...lineage.issue_set, state: "ambiguous", operations: { ...lineage.issue_set.operations, [effect.effect_id]: { ...operation, state: "ambiguous" } } },
            });
            return { outcome: "ambiguous", target_key: targetKey };
          }
          if (!Number.isInteger(issueNumber) || issueNumber < 1) throw new Error(`GitHub returned an invalid issue number for ${targetKey}`);
          await input.hooks?.afterRemoteMutation?.(targetKey, issueNumber);
        } else if (effect.action === "update" && !intentAlreadyExisted) {
          try {
            await target.update(issueNumber);
          } catch (error) {
            await transaction.update({
              ...lineage,
              issue_set: { ...lineage.issue_set, state: "ambiguous", operations: { ...lineage.issue_set.operations, [effect.effect_id]: { ...operation, state: "ambiguous", issue_number: issueNumber } } },
            });
            return { outcome: "ambiguous", target_key: targetKey };
          }
          await input.hooks?.afterRemoteMutation?.(targetKey, issueNumber);
        }
        const alreadyOwned = [
          ...(lineage.issue_set.parent_issue_number === null ? [] : [lineage.issue_set.parent_issue_number]),
          ...Object.values(lineage.issue_set.work_item_issue_map),
        ];
        if (mappedNumber(lineage, effect) !== issueNumber && alreadyOwned.includes(issueNumber)) {
          throw new Error(`GitHub issue #${issueNumber} cannot be mapped to more than one lineage target`);
        }
        lineage = await transaction.update({
          ...withMapping(lineage, effect, issueNumber),
          issue_set: {
            ...withMapping(lineage, effect, issueNumber).issue_set,
            operations: { ...lineage.issue_set.operations, [effect.effect_id]: { ...operation, state: "observed", issue_number: issueNumber } },
          },
        });
        lineage = await transaction.update({
          ...lineage,
          issue_set: { ...lineage.issue_set, operations: { ...lineage.issue_set.operations, [effect.effect_id]: { ...lineage.issue_set.operations[effect.effect_id]!, state: "complete" } } },
        });
        await input.hooks?.afterTargetComplete?.(targetKey, issueNumber);
      }
      const proposedReady = {
        ...lineage,
        issue_set: {
          ...lineage.issue_set,
          state: "ready",
          preview: lineage.issue_set.preview === null ? null : { ...lineage.issue_set.preview, state: "applied" },
        },
      } satisfies TaskLineageRecordV1;
      assertReadyAppliedIssueSet(input, proposedReady);
      lineage = await transaction.update(proposedReady);
      return { outcome: "applied", parent_issue_number: lineage.issue_set.parent_issue_number, work_item_issue_map: { ...lineage.issue_set.work_item_issue_map } };
    },
  });
}

const checkpointPath = (runDir: string): string => join(runDir, "github-issue-sync.json");

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

async function quarantine(runDir: string): Promise<void> {
  await rename(
    checkpointPath(runDir),
    join(runDir, `github-issue-sync.json.corrupt-${Date.now()}-${randomUUID()}`),
  ).catch(() => undefined);
}

export async function readIssueSyncCheckpoint(runDir: string): Promise<IssueSyncCheckpoint> {
  try {
    return issueSyncCheckpointSchema.parse(JSON.parse(await readFile(checkpointPath(runDir), "utf8")));
  } catch (error) {
    if (errorCode(error) !== "ENOENT") await quarantine(runDir);
    return { version: 1, targets: {} };
  }
}

async function writeCheckpoint(runDir: string, checkpoint: IssueSyncCheckpoint): Promise<void> {
  const parsed = issueSyncCheckpointSchema.parse(checkpoint);
  const temporary = join(runDir, `.github-issue-sync-${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(parsed, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  await rename(temporary, checkpointPath(runDir));
}

async function setTarget(runDir: string, targetKey: string, target: IssueSyncTarget): Promise<void> {
  const checkpoint = await readIssueSyncCheckpoint(runDir);
  await writeCheckpoint(runDir, {
    version: 1,
    targets: { ...checkpoint.targets, [targetKey]: targetSchema.parse(target) },
  });
}

function issueNumber(found: ReconcileIssueMutationInput["found"]): number | null {
  if (found === null) return null;
  return typeof found === "number" ? found : found.number;
}

export async function reconcileIssueMutation(input: ReconcileIssueMutationInput): Promise<IssueReconciliationResult> {
  const now = input.now ?? (() => new Date().toISOString());
  const checkedAt = now();
  const checkpoint = await readIssueSyncCheckpoint(input.runDir);
  const previous = checkpoint.targets[input.targetKey];
  const foundNumber = issueNumber(input.found);
  if (previous?.operation_state === "pending"
    && previous.desired_hash === input.desiredHash
    && foundNumber !== null
    && (previous.issue_number === foundNumber
      || (previous.issue_number === null && previous.last_outcome === "created"))
    && input.matchesDesired
    && previous.last_outcome !== "noop") {
    if (previous.issue_number === null) {
      await setTarget(input.runDir, input.targetKey, {
        ...previous,
        issue_number: foundNumber,
        first_resolved_at: previous.first_resolved_at ?? checkedAt,
        last_checked_at: checkedAt,
      });
    }
    return {
      outcome: previous.last_outcome,
      issue_number: foundNumber,
      target_key: input.targetKey,
      desired_hash: input.desiredHash,
      operation_id: previous.operation_id,
    };
  }

  if (foundNumber !== null && input.matchesDesired) {
    const operationId = randomUUID();
    await setTarget(input.runDir, input.targetKey, {
      issue_number: foundNumber,
      desired_hash: input.desiredHash,
      last_outcome: "noop",
      first_resolved_at: previous?.first_resolved_at ?? checkedAt,
      last_checked_at: checkedAt,
      operation_id: operationId,
      operation_state: "complete",
    });
    return { outcome: "noop", issue_number: foundNumber, target_key: input.targetKey, desired_hash: input.desiredHash, operation_id: operationId };
  }

  const outcome: Exclude<IssueReconciliationOutcome, "noop"> = foundNumber === null ? "created" : "updated";
  const operationId = randomUUID();
  const effectClaim = await claimExternalEffect(
    input.budget,
    `github-issue:${input.targetKey}:${input.desiredHash}:${outcome}`,
  );
  await setTarget(input.runDir, input.targetKey, {
    issue_number: foundNumber,
    desired_hash: input.desiredHash,
    last_outcome: outcome,
    first_resolved_at: previous?.first_resolved_at ?? null,
    last_checked_at: checkedAt,
    operation_id: operationId,
    operation_state: "pending",
  });
  let resolvedNumber = foundNumber!;
  try {
    resolvedNumber = outcome === "created" ? await input.create() : foundNumber!;
    if (outcome === "updated") await input.update();
    await completeExternalEffect(input.budget, effectClaim, "succeeded");
  } catch (error) {
    await completeExternalEffect(input.budget, effectClaim, "failed");
    throw error;
  }
  await setTarget(input.runDir, input.targetKey, {
    issue_number: resolvedNumber,
    desired_hash: input.desiredHash,
    last_outcome: outcome,
    first_resolved_at: previous?.first_resolved_at ?? checkedAt,
    last_checked_at: checkedAt,
    operation_id: operationId,
    operation_state: "pending",
  });
  return { outcome, issue_number: resolvedNumber, target_key: input.targetKey, desired_hash: input.desiredHash, operation_id: operationId };
}

export async function completeIssueReconciliation(
  runDir: string,
  result: IssueReconciliationResult,
  now: () => string = () => new Date().toISOString(),
): Promise<void> {
  const checkpoint = await readIssueSyncCheckpoint(runDir);
  const current = checkpoint.targets[result.target_key];
  if (!current || current.operation_id !== result.operation_id || current.issue_number !== result.issue_number) {
    throw new Error(`Issue reconciliation checkpoint changed for ${result.target_key}`);
  }
  await setTarget(runDir, result.target_key, {
    ...current,
    operation_state: "complete",
    last_checked_at: now(),
  });
}
