import { link, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { join } from "node:path";
import type { GitHubAdapter } from "../adapters/github.js";
import { StatusCommentOwnershipConflictError } from "../adapters/github.js";
import type { ResourceBudgetPort } from "../core/resource-budget.js";
import { claimExternalEffect, completeExternalEffect } from "../workflow/resource-budget.js";
import {
  desiredManagedStateLabel,
  hasExactManagedStateLabel,
  managedStateLabelEdit,
  type BrainHandsStateLabel,
} from "../core/github-labels.js";
import {
  readGitHubStatusCheckpoint,
  updateGitHubStatusCheckpoint,
} from "./status-checkpoint.js";
import type { DesiredMaterialEvent, DesiredStatusProjection } from "./status-projection.js";

export type GitHubStatusFailureClass =
  | "comment_lookup"
  | "comment_create"
  | "comment_edit"
  | "comment_conflict"
  | "label_sync"
  | "event_create"
  | "lock_contended"
  | "checkpoint_write"
  | "issue_observation"
  | "unsupported";

export type GitHubStatusSyncResult =
  | { status: "synced" }
  | { status: "skipped" }
  | { status: "retry_pending"; failureClass: GitHubStatusFailureClass };

const lockPath = (runDir: string) => join(runDir, ".github-status-sync.lock");
const LOCK_LEASE_FILE = "lease.json";
const LOCK_TTL_MS = 10 * 60 * 1_000;

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== "ESRCH";
  }
}

async function isStaleLock(path: string, now: number): Promise<boolean> {
  try {
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (error) {
      if (errorCode(error) !== "EISDIR") throw error;
      raw = await readFile(join(path, LOCK_LEASE_FILE), "utf8");
    }
    const lease = JSON.parse(raw) as {
      host?: unknown;
      pid?: unknown;
      createdAt?: unknown;
    };
    if (lease.host !== hostname() || typeof lease.pid !== "number" || !Number.isInteger(lease.pid) || lease.pid < 1) return false;
    if (processIsRunning(lease.pid)) return false;
    const createdAt = typeof lease.createdAt === "string" ? Date.parse(lease.createdAt) : Number.NaN;
    return Number.isFinite(createdAt) && now - createdAt > LOCK_TTL_MS;
  } catch {
    return false;
  }
}

async function tryCreateLock(path: string, now: () => string): Promise<boolean> {
  const candidate = `${path}.candidate-${randomUUID()}`;
  await writeFile(candidate, `${JSON.stringify({ host: hostname(), pid: process.pid, createdAt: now() })}\n`, { encoding: "utf8", flag: "wx" });
  try {
    await link(candidate, path);
    return true;
  } catch (error) {
    if (errorCode(error) === "EEXIST") return false;
    throw error;
  } finally {
    await rm(candidate, { force: true });
  }
}

async function reclaimStaleLock(path: string, now: number): Promise<boolean> {
  if (!await isStaleLock(path, now)) return false;
  const quarantine = `${path}.stale-${randomUUID()}`;
  try {
    await rename(path, quarantine);
  } catch (error) {
    return errorCode(error) === "ENOENT";
  }
  await rm(quarantine, { recursive: true, force: true });
  return true;
}

async function withLock<T>(runDir: string, now: () => string, action: () => Promise<T>): Promise<T | null> {
  const path = lockPath(runDir);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (await tryCreateLock(path, now)) {
      try {
        return await action();
      } finally {
        await rm(path, { recursive: true, force: true });
      }
    }
    if (attempt === 0 && await reclaimStaleLock(path, Date.parse(now()))) continue;
    return null;
  }
  return null;
}

function targetKey(kind: "issue" | "pull_request", number: number, workItemId: string): string {
  return `${kind}:${number}:${workItemId}`;
}

function missingCommentCapabilities(github: GitHubAdapter): boolean {
  return !github.findStatusCommentByMarker || !github.createStatusComment || !github.updateStatusComment;
}

function failureClass(error: unknown, current: GitHubStatusFailureClass): GitHubStatusFailureClass {
  return error instanceof StatusCommentOwnershipConflictError ? "comment_conflict" : current;
}

async function recordFailure(
  runDir: string,
  key: string,
  failure: GitHubStatusFailureClass,
  now: () => string,
): Promise<GitHubStatusSyncResult> {
  try {
    await updateGitHubStatusCheckpoint(runDir, key, (current) => ({ ...current, retry: { class: failure, at: now() } }));
    return { status: "retry_pending", failureClass: failure };
  } catch {
    return { status: "retry_pending", failureClass: "checkpoint_write" };
  }
}

export async function syncGitHubIssueStatus(input: {
  runDir: string;
  github: GitHubAdapter;
  issueNumber: number;
  workItemId: string;
  projection: DesiredStatusProjection;
  budget?: ResourceBudgetPort;
  now?: () => string;
}): Promise<GitHubStatusSyncResult> {
  const now = input.now ?? (() => new Date().toISOString());
  const key = targetKey("issue", input.issueNumber, input.workItemId);
  const result = await withLock(input.runDir, now, async (): Promise<GitHubStatusSyncResult> => {
    if (!input.github.getIssue || !input.github.reconcileIssueStateLabel) return recordFailure(input.runDir, key, "unsupported", now);
    const checkpoint = await readGitHubStatusCheckpoint(input.runDir);
    const previous = checkpoint.targets[key];
    const eventKeys = input.projection.events.map((event) => event.key).sort();
    const effectKey = `github-status:issue:${input.issueNumber}:${input.workItemId}:${input.projection.hash}`;
    let stage: GitHubStatusFailureClass = "issue_observation";
    try {
      let issue = await input.github.getIssue!(input.issueNumber);
      if (!Array.isArray(issue.labels)) throw new Error(`Issue ${input.issueNumber} labels are incomplete`);
      let desired: BrainHandsStateLabel = managedStateLabelEdit({ ...issue, labels: issue.labels }, input.projection.label).desired;
      if (issue.state === "OPEN" && missingCommentCapabilities(input.github)) {
        return recordFailure(input.runDir, key, "unsupported", now);
      }
      if (!hasExactManagedStateLabel(issue.labels, desired)) {
        stage = "label_sync";
        let mutationError: unknown = null;
        try {
          await input.github.reconcileIssueStateLabel!(input.issueNumber, desired, {
            withExternalEffect: async (labelEffectKey, action) => {
              const claim = await claimExternalEffect(input.budget, `${effectKey}:label:${labelEffectKey}:${input.projection.label}`);
              try {
                const output = await action();
                await completeExternalEffect(input.budget, claim);
                return output;
              } catch (error) {
                await completeExternalEffect(input.budget, claim, "failed");
                throw error;
              }
            },
          });
        } catch (error) {
          mutationError = error;
        }
        stage = "issue_observation";
        try {
          issue = await input.github.getIssue!(input.issueNumber);
        } catch (error) {
          throw mutationError ?? error;
        }
        if (!Array.isArray(issue.labels)) throw mutationError ?? new Error(`Issue ${input.issueNumber} labels are incomplete after reconciliation`);
        desired = desiredManagedStateLabel(issue, input.projection.label);
        stage = "label_sync";
        if (!hasExactManagedStateLabel(issue.labels, desired)) {
          throw mutationError ?? new Error(`Failed to observe exact GitHub status labels for issue ${input.issueNumber}`);
        }
      }

      if (issue.state === "CLOSED") {
        if (previous?.projectionHash === null && previous.label === desired && previous.retry === null) {
          return { status: "skipped" };
        }
        await updateGitHubStatusCheckpoint(input.runDir, key, (current) => ({
          ...current,
          projectionHash: null,
          label: desired,
          syncedAt: now(),
          retry: null,
        }));
        return { status: "synced" };
      }

      if (previous?.projectionHash === input.projection.hash && previous.label === desired && previous.retry === null && JSON.stringify(previous.emittedEventKeys) === JSON.stringify(eventKeys)) {
        return { status: "skipped" };
      }
      const target = { kind: "issue" as const, number: input.issueNumber };
      stage = "comment_lookup";
      const existing = await input.github.findStatusCommentByMarker!(target, input.projection.marker);
      if (!existing) {
        stage = "comment_create";
        const claim = await claimExternalEffect(input.budget, `${effectKey}:comment:create`);
        await input.github.createStatusComment!(target, input.projection.body);
        await completeExternalEffect(input.budget, claim);
      } else if (existing.body !== input.projection.body) {
        stage = "comment_edit";
        const claim = await claimExternalEffect(input.budget, `${effectKey}:comment:update`);
        await input.github.updateStatusComment!(existing.id, input.projection.body);
        await completeExternalEffect(input.budget, claim);
      }
      for (const event of input.projection.events) {
        stage = "comment_lookup";
        const existingEvent = await input.github.findStatusCommentByMarker!(target, event.marker);
        if (!existingEvent) {
          stage = "event_create";
          const claim = await claimExternalEffect(input.budget, `${effectKey}:event:${event.key}`);
          await input.github.createStatusComment!(target, event.body);
          await completeExternalEffect(input.budget, claim);
        }
      }
      await updateGitHubStatusCheckpoint(input.runDir, key, (current) => ({
        ...current,
        commentId: null,
        projectionHash: input.projection.hash,
        label: desired,
        emittedEventKeys: eventKeys,
        syncedAt: now(),
        retry: null,
      }));
      return { status: "synced" };
    } catch (error) {
      return recordFailure(input.runDir, key, failureClass(error, stage), now);
    }
  });
  return result ?? { status: "retry_pending", failureClass: "lock_contended" };
}

export async function syncGitHubDeliveryEvent(input: {
  runDir: string;
  github: GitHubAdapter;
  pullRequestNumber: number;
  event: DesiredMaterialEvent;
  budget?: ResourceBudgetPort;
  now?: () => string;
}): Promise<GitHubStatusSyncResult> {
  const now = input.now ?? (() => new Date().toISOString());
  const key = targetKey("pull_request", input.pullRequestNumber, "delivery");
  const result = await withLock(input.runDir, now, async (): Promise<GitHubStatusSyncResult> => {
    if (missingCommentCapabilities(input.github)) return recordFailure(input.runDir, key, "unsupported", now);
    const checkpoint = await readGitHubStatusCheckpoint(input.runDir);
    const previous = checkpoint.targets[key];
    if (previous?.emittedEventKeys.includes(input.event.key) && previous.retry === null) return { status: "skipped" };
    try {
      const target = { kind: "pull_request" as const, number: input.pullRequestNumber };
      const existing = await input.github.findStatusCommentByMarker!(target, input.event.marker);
      if (!existing) {
        const claim = await claimExternalEffect(input.budget, `github-status:pull-request:${input.pullRequestNumber}:event:${input.event.key}`);
        await input.github.createStatusComment!(target, input.event.body);
        await completeExternalEffect(input.budget, claim);
      }
      await updateGitHubStatusCheckpoint(input.runDir, key, (current) => ({
        ...current,
        emittedEventKeys: [...new Set([...current.emittedEventKeys, input.event.key])].sort(),
        syncedAt: now(),
        retry: null,
      }));
      return { status: "synced" };
    } catch (error) {
      return recordFailure(input.runDir, key, failureClass(error, "event_create"), now);
    }
  });
  return result ?? { status: "retry_pending", failureClass: "lock_contended" };
}
