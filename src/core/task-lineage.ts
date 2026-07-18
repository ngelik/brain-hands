import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  unlink,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";
import { githubEffectPreviewRefSchema, runManifestV2Schema } from "./schema.js";
import type { GitHubRepositoryIdentity } from "../adapters/github.js";
import type { GithubEffectPreviewRef, RunManifestV2 } from "./types.js";

export type TaskLineageState =
  | "active"
  | "delivery_ready"
  | "human_accepted"
  | "completed"
  | "abandoned"
  | "closed_blocked";

export interface TaskLineageRecordV1 {
  version: 1;
  lineage_id: string;
  repository_key: string | null;
  root_run_id: string;
  active_run_id: string;
  run_ids: string[];
  state: TaskLineageState;
  created_at: string;
  updated_at: string;
  issue_set: {
    state: "uninitialized" | "applying" | "ready" | "ambiguous";
    plan_revision: number | null;
    plan_sha256: string | null;
    parent_issue_number: number | null;
    work_item_issue_map: Record<string, number>;
    operations: Record<string, {
      operation_id: string;
      target_key: string;
      desired_sha256: string;
      state: "intent" | "observed" | "complete" | "ambiguous";
      issue_number: number | null;
      created_by_run_id: string;
    }>;
    preview: GithubEffectPreviewRef | null;
  };
  delivery: {
    state: "uninitialized" | "applying" | "ready" | "ambiguous";
    branch_name: string | null;
    head_sha: string | null;
    preview_prior_head_sha?: string | null;
    head_transition?: {
      run_id: string;
      work_item_id: string;
      previous_head_sha: string;
      authorized_head_sha: string;
    };
    pull_request_number: number | null;
    pull_request_url: string | null;
    preview: GithubEffectPreviewRef | null;
  };
  cleanup_state: "not_required" | "pending" | "complete" | "blocked";
}

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const issueOperationSchema = z.object({
  operation_id: z.string().min(1),
  target_key: z.string().min(1),
  desired_sha256: sha256Schema,
  state: z.enum(["intent", "observed", "complete", "ambiguous"]),
  issue_number: z.number().int().positive().nullable(),
  created_by_run_id: z.string().min(1),
}).strict();

const taskLineageRecordSchema = z.object({
  version: z.literal(1),
  lineage_id: z.string().uuid(),
  repository_key: z.string().min(1).nullable(),
  root_run_id: z.string().min(1),
  active_run_id: z.string().min(1),
  run_ids: z.array(z.string().min(1)).min(1),
  state: z.enum(["active", "delivery_ready", "human_accepted", "completed", "abandoned", "closed_blocked"]),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  issue_set: z.object({
    state: z.enum(["uninitialized", "applying", "ready", "ambiguous"]),
    plan_revision: z.number().int().positive().nullable(),
    plan_sha256: sha256Schema.nullable(),
    parent_issue_number: z.number().int().positive().nullable(),
    work_item_issue_map: z.record(z.string().min(1), z.number().int().positive()),
    operations: z.record(z.string().min(1), issueOperationSchema),
    preview: githubEffectPreviewRefSchema.nullable(),
  }).strict(),
  delivery: z.object({
    state: z.enum(["uninitialized", "applying", "ready", "ambiguous"]),
    branch_name: z.string().min(1).nullable(),
    head_sha: z.string().min(1).nullable(),
    preview_prior_head_sha: z.string().regex(/^[a-f0-9]{40,64}$/).nullable().optional(),
    head_transition: z.object({
      run_id: z.string().min(1),
      work_item_id: z.string().min(1),
      previous_head_sha: z.string().regex(/^[a-f0-9]{40,64}$/),
      authorized_head_sha: z.string().regex(/^[a-f0-9]{40,64}$/),
    }).strict().optional(),
    pull_request_number: z.number().int().positive().nullable(),
    pull_request_url: z.string().url().nullable(),
    preview: githubEffectPreviewRefSchema.nullable(),
  }).strict(),
  cleanup_state: z.enum(["not_required", "pending", "complete", "blocked"]),
}).strict().superRefine((record, context) => {
  if (new Set(record.run_ids).size !== record.run_ids.length) {
    context.addIssue({ code: "custom", path: ["run_ids"], message: "Task lineage run IDs must be unique" });
  }
  if (!record.run_ids.includes(record.root_run_id)) {
    context.addIssue({ code: "custom", path: ["root_run_id"], message: "Task lineage root run must be in run_ids" });
  }
  if (!record.run_ids.includes(record.active_run_id)) {
    context.addIssue({ code: "custom", path: ["active_run_id"], message: "Task lineage active run must be in run_ids" });
  }
  if ((record.issue_set.plan_revision === null) !== (record.issue_set.plan_sha256 === null)) {
    context.addIssue({ code: "custom", path: ["issue_set"], message: "Issue plan revision and digest must be set together" });
  }
  if (record.issue_set.preview !== null && record.issue_set.preview.phase !== "issue_sync") {
    context.addIssue({ code: "custom", path: ["issue_set", "preview"], message: "Issue-set preview must be issue_sync" });
  }
  if (record.issue_set.preview !== null && (
    record.issue_set.preview.plan_revision !== record.issue_set.plan_revision
    || record.issue_set.preview.plan_sha256 !== record.issue_set.plan_sha256
  )) {
    context.addIssue({ code: "custom", path: ["issue_set", "preview"], message: "Issue preview plan binding must match the issue set" });
  }
  if (record.delivery.preview !== null && record.delivery.preview.phase !== "pull_request_delivery") {
    context.addIssue({ code: "custom", path: ["delivery", "preview"], message: "Delivery preview must be pull_request_delivery" });
  }
  for (const [operationId, operation] of Object.entries(record.issue_set.operations)) {
    if (operation.operation_id !== operationId) {
      context.addIssue({ code: "custom", path: ["issue_set", "operations", operationId], message: "Issue operation key must match operation_id" });
    }
    if (!record.run_ids.includes(operation.created_by_run_id)) {
      context.addIssue({ code: "custom", path: ["issue_set", "operations", operationId, "created_by_run_id"], message: "Issue operation creator must be in lineage run_ids" });
    }
  }
});

export const taskLineageRecordV1Schema: z.ZodType<TaskLineageRecordV1> = taskLineageRecordSchema;

export interface CreateTaskLineageInput {
  repoRoot: string;
  runId: string;
  lineageId: string;
  repositoryKey?: string | null;
  now?: Date;
}

export interface TaskLineageTransaction {
  read(): TaskLineageRecordV1;
  update(next: TaskLineageRecordV1): Promise<TaskLineageRecordV1>;
}

export interface TaskLineageTransactionHooks {
  beforeStateRename?: () => Promise<void>;
}

export interface LineageTransactionInput<T> {
  repoRoot: string;
  lineageId: string;
  operation: (transaction: TaskLineageTransaction) => Promise<T> | T;
  now?: Date;
  hooks?: TaskLineageTransactionHooks;
}

export interface AttachMissingLineageInput {
  repoRoot: string;
  runId: string;
  lineageId: string;
  now?: Date;
}

export interface EnsureProducingTaskLineageInput {
  runDir: string;
  repository: GitHubRepositoryIdentity;
}

export interface TransitionTaskLineageInput {
  repoRoot: string;
  lineageId: string;
  to: TaskLineageState;
  now?: Date;
}

interface DirectoryIdentity {
  path: string;
  realPath: string;
  dev: number;
  ino: number;
}

interface FileIdentity {
  dev: number;
  ino: number;
}

interface LineageLease {
  token: string;
  host: string;
  pid: number;
  created_at: string;
}

const noFollow = constants.O_NOFOLLOW ?? 0;
interface LineageQueueEntry {
  tail: Promise<void>;
  pending: number;
}
const lineageQueues = new Map<string, LineageQueueEntry>();
const terminalStates = new Set<TaskLineageState>(["completed", "abandoned", "closed_blocked"]);
const allowedTransitions: Readonly<Record<TaskLineageState, readonly TaskLineageState[]>> = {
  active: ["delivery_ready", "abandoned", "closed_blocked"],
  delivery_ready: ["human_accepted", "completed", "abandoned", "closed_blocked"],
  human_accepted: ["completed"],
  completed: [],
  abandoned: [],
  closed_blocked: [],
};

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function withLineageQueue<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const entry = lineageQueues.get(path) ?? { tail: Promise.resolve(), pending: 0 };
  if (!lineageQueues.has(path)) lineageQueues.set(path, entry);
  entry.pending += 1;
  const result = entry.tail.then(operation, operation);
  entry.tail = result.then(() => undefined, () => undefined);
  return result.finally(() => {
    entry.pending -= 1;
    if (entry.pending === 0 && lineageQueues.get(path) === entry) lineageQueues.delete(path);
  });
}

function parseLineageId(lineageId: string): string {
  return z.string().uuid().parse(lineageId);
}

export function taskLineagePath(repoRoot: string, lineageId: string): string {
  return join(resolve(repoRoot), ".brain-hands", "task-lineages", parseLineageId(lineageId), "state.json");
}

async function fsyncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | noFollow);
  try {
    const status = await handle.stat();
    if (!status.isDirectory()) throw new Error(`Expected a directory while syncing ${path}`);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function captureDirectory(path: string, label: string): Promise<DirectoryIdentity> {
  const status = await lstat(path);
  if (status.isSymbolicLink()) throw new Error(`${label} must not be a symlink`);
  if (!status.isDirectory()) throw new Error(`${label} must be a directory`);
  return { path, realPath: await realpath(path), dev: status.dev, ino: status.ino };
}

async function assertDirectory(identity: DirectoryIdentity, label: string): Promise<void> {
  const current = await captureDirectory(identity.path, label);
  if (current.dev !== identity.dev || current.ino !== identity.ino || current.realPath !== identity.realPath) {
    throw new Error(`${label} identity changed during access`);
  }
}

async function assertOwnedFileIdentity(
  path: string,
  parent: DirectoryIdentity,
  expected: FileIdentity,
  label: string,
): Promise<void> {
  await assertDirectory(parent, `${label} parent`);
  const status = await lstat(path);
  if (status.isSymbolicLink()) throw new Error(`${label} must not be a symlink`);
  if (!status.isFile()) throw new Error(`${label} must be a regular file`);
  if (status.dev !== expected.dev || status.ino !== expected.ino) throw new Error(`${label} identity changed during access`);
  if (dirname(await realpath(path)) !== parent.realPath) throw new Error(`${label} escaped its lineage directory`);
}

async function ensureDirectory(path: string, label: string): Promise<DirectoryIdentity> {
  const parent = dirname(path);
  let created = false;
  try {
    await mkdir(path, { mode: 0o700 });
    created = true;
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
  }
  const identity = await captureDirectory(path, label);
  if (created) await fsyncDirectory(parent);
  return identity;
}

async function lineageDirectory(repoRoot: string, lineageId: string): Promise<DirectoryIdentity> {
  // Version one coordinates cooperative processes sharing this trusted
  // repository control directory. These checks refuse symlinks and detect
  // ordinary replacement, but do not claim dirfd/openat protection from a
  // hostile same-user process swapping trusted ancestors between path calls.
  parseLineageId(lineageId);
  const root = await captureDirectory(resolve(repoRoot), "Repository root");
  const brainHands = await ensureDirectory(join(root.path, ".brain-hands"), "Brain Hands directory");
  await assertDirectory(root, "Repository root");
  const lineages = await ensureDirectory(join(brainHands.path, "task-lineages"), "Task lineages directory");
  await assertDirectory(brainHands, "Brain Hands directory");
  const lineage = await ensureDirectory(join(lineages.path, lineageId), "Task lineage directory");
  await assertDirectory(lineages, "Task lineages directory");
  return lineage;
}

async function readOwnedFile(path: string, parent: DirectoryIdentity, label: string): Promise<string> {
  await assertDirectory(parent, `${label} parent`);
  const status = await lstat(path);
  if (status.isSymbolicLink()) throw new Error(`${label} must not be a symlink`);
  if (!status.isFile()) throw new Error(`${label} must be a regular file`);
  const handle = await open(path, constants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) throw new Error(`${label} must be a regular open file`);
    if (dirname(await realpath(path)) !== parent.realPath) throw new Error(`${label} escaped its lineage directory`);
    await assertDirectory(parent, `${label} parent`);
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

function parseLease(raw: string): LineageLease {
  const value = JSON.parse(raw) as Partial<LineageLease>;
  if (
    typeof value.token !== "string"
    || !z.string().uuid().safeParse(value.token).success
    || typeof value.host !== "string"
    || value.host.length === 0
    || typeof value.pid !== "number"
    || !Number.isInteger(value.pid)
    || value.pid <= 0
    || typeof value.created_at !== "string"
    || !Number.isFinite(Date.parse(value.created_at))
  ) throw new Error("Task lineage lease is invalid");
  return value as LineageLease;
}

function sameLease(left: LineageLease, right: LineageLease): boolean {
  return left.token === right.token
    && left.host === right.host
    && left.pid === right.pid
    && left.created_at === right.created_at;
}

function leaseIsLive(lease: LineageLease): boolean {
  if (lease.host !== hostname()) return true;
  try {
    process.kill(lease.pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== "ESRCH";
  }
}

async function writeLease(lock: DirectoryIdentity, lease: LineageLease): Promise<void> {
  const path = join(lock.path, "lease.json");
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600);
  try {
    await assertDirectory(lock, "Task lineage lock");
    await handle.writeFile(`${JSON.stringify(lease)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsyncDirectory(lock.path);
}

async function readLease(lock: DirectoryIdentity): Promise<LineageLease> {
  return parseLease(await readOwnedFile(join(lock.path, "lease.json"), lock, "Task lineage lease"));
}

async function removeLockDirectory(
  lock: DirectoryIdentity,
  expectedLease?: LineageLease,
): Promise<void> {
  await assertDirectory(lock, "Task lineage lock");
  if (expectedLease) {
    const currentLease = await readLease(lock);
    if (!sameLease(currentLease, expectedLease)) throw new Error("Task lineage lease ownership changed before cleanup");
  }
  try {
    await unlink(join(lock.path, "lease.json"));
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
  // A lock directory is trusted controller state and should contain only its
  // lease. rmdir intentionally fails closed if it was replaced or populated.
  await rmdir(lock.path);
  await fsyncDirectory(dirname(lock.path));
}

async function acquireLock(lineage: DirectoryIdentity): Promise<() => Promise<void>> {
  const lockPath = join(lineage.path, ".lock");
  const lease: LineageLease = {
    token: randomUUID(),
    host: hostname(),
    pid: process.pid,
    created_at: new Date().toISOString(),
  };

  while (true) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      const lock = await captureDirectory(lockPath, "Task lineage lock");
      try {
        await writeLease(lock, lease);
        await fsyncDirectory(lineage.path);
      } catch (error) {
        await removeLockDirectory(lock);
        throw error;
      }
      return async () => {
        await assertDirectory(lineage, "Task lineage directory");
        const currentLock = await captureDirectory(lockPath, "Task lineage lock");
        if (currentLock.dev !== lock.dev || currentLock.ino !== lock.ino) {
          throw new Error("Task lineage lock ownership changed before release");
        }
        await removeLockDirectory(currentLock, lease);
      };
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }

    const lock = await captureDirectory(lockPath, "Task lineage lock");
    const existing = await readLease(lock);
    if (leaseIsLive(existing)) {
      throw new Error(existing.host === hostname()
        ? "Task lineage lock is held by a live same-host PID"
        : "Task lineage lock is held by an unknown-host lease");
    }

    const stalePath = join(lineage.path, `.lock.stale-${randomUUID()}`);
    await assertDirectory(lineage, "Task lineage directory");
    try {
      await rename(lockPath, stalePath);
    } catch (error) {
      if (["ENOENT", "EEXIST", "ENOTEMPTY"].includes(errorCode(error) ?? "")) continue;
      throw error;
    }
    await fsyncDirectory(lineage.path);
    const stale = await captureDirectory(stalePath, "Stale task lineage lock");
    const movedLease = await readLease(stale);
    if (!sameLease(existing, movedLease) || leaseIsLive(movedLease)) {
      await rename(stalePath, lockPath).catch(() => undefined);
      await fsyncDirectory(lineage.path);
      throw new Error("Task lineage lease changed or became live during recovery");
    }
    await removeLockDirectory(stale, movedLease);
  }
}

async function quarantines(directory: DirectoryIdentity): Promise<string[]> {
  await assertDirectory(directory, "Task lineage directory");
  return (await readdir(directory.path)).filter((name) => name.startsWith("state.json.corrupt-"));
}

async function quarantineCorruptState(directory: DirectoryIdentity, cause: unknown): Promise<never> {
  const statePath = join(directory.path, "state.json");
  const destination = join(directory.path, `state.json.corrupt-${Date.now()}-${randomUUID()}`);
  await assertDirectory(directory, "Task lineage directory");
  await rename(statePath, destination);
  await fsyncDirectory(directory.path);
  throw new Error(`Task lineage state is corrupt and was quarantined: ${cause instanceof Error ? cause.message : String(cause)}`);
}

async function readState(directory: DirectoryIdentity, quarantineInvalid: boolean): Promise<TaskLineageRecordV1> {
  const statePath = join(directory.path, "state.json");
  let raw: string;
  try {
    raw = await readOwnedFile(statePath, directory, "Task lineage state");
  } catch (error) {
    if (errorCode(error) === "ENOENT" && (await quarantines(directory)).length > 0) {
      throw new Error("Task lineage state is corrupt and quarantined");
    }
    throw error;
  }
  try {
    return taskLineageRecordV1Schema.parse(JSON.parse(raw));
  } catch (error) {
    if (quarantineInvalid) return quarantineCorruptState(directory, error);
    throw new Error(`Task lineage state is corrupt: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function writeState(
  directory: DirectoryIdentity,
  record: TaskLineageRecordV1,
  hooks: TaskLineageTransactionHooks = {},
): Promise<void> {
  const temporary = join(directory.path, `state.${randomUUID()}.tmp`);
  const target = join(directory.path, "state.json");
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  let renamed = false;
  try {
    await assertDirectory(directory, "Task lineage directory");
    handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600);
    const opened = await handle.stat();
    if (!opened.isFile()) throw new Error("Task lineage temporary state must be a regular open file");
    const temporaryIdentity = { dev: opened.dev, ino: opened.ino };
    await assertOwnedFileIdentity(temporary, directory, temporaryIdentity, "Task lineage temporary state");
    await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await assertOwnedFileIdentity(temporary, directory, temporaryIdentity, "Task lineage temporary state");
    await hooks.beforeStateRename?.();
    await assertOwnedFileIdentity(temporary, directory, temporaryIdentity, "Task lineage temporary state");
    await rename(temporary, target);
    renamed = true;
    await fsyncDirectory(directory.path);
  } finally {
    if (handle) await handle.close().catch(() => undefined);
    if (!renamed) await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function assertRecordMutation(previous: TaskLineageRecordV1, next: TaskLineageRecordV1): void {
  if (
    next.version !== previous.version
    || next.lineage_id !== previous.lineage_id
    || next.root_run_id !== previous.root_run_id
    || next.created_at !== previous.created_at
  ) throw new Error("Task lineage identity fields are immutable");
  if (previous.repository_key !== null && next.repository_key !== previous.repository_key) {
    throw new Error("Task lineage repository identity is immutable once set");
  }
  if (previous.run_ids.some((runId, index) => next.run_ids[index] !== runId)) {
    throw new Error("Task lineage run IDs are append-only");
  }
  if (next.state !== previous.state && !allowedTransitions[previous.state].includes(next.state)) {
    throw new Error(`Illegal task lineage transition: ${previous.state} -> ${next.state}`);
  }
  if (terminalStates.has(previous.state)) {
    if (JSON.stringify(next.issue_set) !== JSON.stringify(previous.issue_set)) {
      throw new Error("Terminal task lineage rejects issue operation changes");
    }
    if (JSON.stringify(next.delivery) !== JSON.stringify(previous.delivery)) {
      throw new Error("Terminal task lineage rejects delivery operation changes");
    }
  }
}

function initialRecord(input: CreateTaskLineageInput): TaskLineageRecordV1 {
  const createdAt = (input.now ?? new Date()).toISOString();
  return taskLineageRecordV1Schema.parse({
    version: 1,
    lineage_id: input.lineageId,
    repository_key: input.repositoryKey ?? null,
    root_run_id: input.runId,
    active_run_id: input.runId,
    run_ids: [input.runId],
    state: "active",
    created_at: createdAt,
    updated_at: createdAt,
    issue_set: {
      state: "uninitialized",
      plan_revision: null,
      plan_sha256: null,
      parent_issue_number: null,
      work_item_issue_map: {},
      operations: {},
      preview: null,
    },
    delivery: {
      state: "uninitialized",
      branch_name: null,
      head_sha: null,
      pull_request_number: null,
      pull_request_url: null,
      preview: null,
    },
    cleanup_state: "not_required",
  });
}

function recordSnapshot(record: TaskLineageRecordV1): TaskLineageRecordV1 {
  return taskLineageRecordV1Schema.parse(structuredClone(record));
}

export async function createTaskLineage(input: CreateTaskLineageInput): Promise<TaskLineageRecordV1> {
  const statePath = taskLineagePath(input.repoRoot, input.lineageId);
  if (!input.runId.trim()) throw new Error("Task lineage run ID must be non-empty");
  return withLineageQueue(statePath, async () => {
    const directory = await lineageDirectory(input.repoRoot, input.lineageId);
    const release = await acquireLock(directory);
    try {
      try {
        await readState(directory, true);
        throw new Error(`Task lineage ${input.lineageId} already exists`);
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
        if ((await quarantines(directory)).length > 0) {
          throw new Error("Task lineage state is corrupt and quarantined");
        }
      }
      const record = initialRecord(input);
      await writeState(directory, record);
      return record;
    } finally {
      await release();
    }
  });
}

export async function readTaskLineage(repoRoot: string, lineageId: string): Promise<TaskLineageRecordV1> {
  const statePath = taskLineagePath(repoRoot, lineageId);
  const directoryPath = dirname(statePath);
  const directory = await captureDirectory(directoryPath, "Task lineage directory");
  const record = await readState(directory, false);
  if (record.lineage_id !== lineageId) throw new Error("Task lineage record identity does not match its lineage path");
  return record;
}

export async function withTaskLineageTransaction<T>(input: LineageTransactionInput<T>): Promise<T> {
  const statePath = taskLineagePath(input.repoRoot, input.lineageId);
  return withLineageQueue(statePath, async () => {
    const directory = await lineageDirectory(input.repoRoot, input.lineageId);
    const release = await acquireLock(directory);
    try {
      let current = await readState(directory, true);
      if (current.lineage_id !== input.lineageId) throw new Error("Task lineage path and record identity differ");
      let updateActive = false;
      const transaction: TaskLineageTransaction = {
        read: () => recordSnapshot(current),
        update: async (candidate) => {
          if (updateActive) throw new Error("Concurrent updates in one task lineage transaction are not allowed");
          updateActive = true;
          try {
            const next = taskLineageRecordV1Schema.parse({
              ...structuredClone(candidate),
              updated_at: (input.now ?? new Date()).toISOString(),
            });
            assertRecordMutation(current, next);
            await writeState(directory, next, input.hooks);
            current = recordSnapshot(next);
            return recordSnapshot(current);
          } finally {
            updateActive = false;
          }
        },
      };
      return await input.operation(transaction);
    } finally {
      await release();
    }
  });
}

export async function transitionTaskLineage(input: TransitionTaskLineageInput): Promise<TaskLineageRecordV1> {
  return withTaskLineageTransaction({
    repoRoot: input.repoRoot,
    lineageId: input.lineageId,
    now: input.now,
    operation: (transaction) => transaction.update({ ...transaction.read(), state: input.to }),
  });
}

const legacyLineageNamespace = "2820d49f-684f-5ba4-bf7d-4754c4b810c1";

function uuidBytes(value: string): Buffer {
  return Buffer.from(value.replaceAll("-", ""), "hex");
}

export function deriveLegacyTaskLineageId(repositoryKey: string, runId: string): string {
  const normalizedRepository = repositoryKey.trim().toLowerCase();
  if (!normalizedRepository || !runId.trim()) throw new Error("Repository key and run ID are required for legacy lineage derivation");
  const digest = createHash("sha1")
    .update(uuidBytes(legacyLineageNamespace))
    .update(`${normalizedRepository}\n${runId}`)
    .digest()
    .subarray(0, 16);
  digest[6] = (digest[6]! & 0x0f) | 0x50;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = digest.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function canonicalRepositoryKey(repository: GitHubRepositoryIdentity): string {
  const host = repository.host.trim().toLowerCase();
  const nameWithOwner = repository.name_with_owner.trim().toLowerCase();
  if (!host || host.includes("/") || nameWithOwner.split("/").length !== 2
    || nameWithOwner.split("/").some((segment) => segment.length === 0)) {
    throw new Error("Canonical GitHub repository identity is invalid");
  }
  return `${host}/${nameWithOwner}`;
}

function assertProducingBinding(
  record: TaskLineageRecordV1,
  lineageId: string,
  runId: string,
  repositoryKey: string,
): TaskLineageRecordV1 {
  if (
    record.lineage_id !== lineageId
    || record.root_run_id !== runId
    || record.active_run_id !== runId
    || record.run_ids.length !== 1
    || record.run_ids[0] !== runId
    || record.repository_key !== repositoryKey
  ) throw new Error("Task lineage does not match the exact repository and root-active run binding");
  return record;
}

function currentRepositoryRoot(runDir: string, runId: string): string {
  const canonicalRunDir = resolve(runDir);
  if (basename(canonicalRunDir) !== runId) throw new Error("Run directory does not match its manifest run ID");
  const runsDir = dirname(canonicalRunDir);
  const controlDir = dirname(runsDir);
  if (basename(runsDir) !== "runs" || basename(controlDir) !== ".brain-hands") {
    throw new Error("Run directory is outside the canonical Brain Hands run tree");
  }
  return dirname(controlDir);
}

async function readProducingManifest(runDir: string): Promise<RunManifestV2> {
  const directory = await captureDirectory(resolve(runDir), "Run directory");
  const raw = await readOwnedFile(join(directory.path, "manifest.json"), directory, "Run manifest");
  return runManifestV2Schema.parse(JSON.parse(raw));
}

async function bindInitialRepository(
  repoRoot: string,
  lineageId: string,
  runId: string,
  repositoryKey: string,
): Promise<TaskLineageRecordV1> {
  return withTaskLineageTransaction({
    repoRoot,
    lineageId,
    operation: (transaction) => {
      const current = assertExactRootBinding(transaction.read(), lineageId, runId);
      return transaction.update({ ...current, repository_key: repositoryKey });
    },
  });
}

/**
 * Attach or verify the task lineage immediately before a GitHub-producing path.
 * Lineage state is created or verified first under its own lock; the manifest
 * update is a separate durable write and deliberately is not presented as a
 * transaction spanning both files.
 */
export async function ensureProducingTaskLineage(
  input: EnsureProducingTaskLineageInput,
): Promise<{ manifest: RunManifestV2; lineage: TaskLineageRecordV1 }> {
  let manifest = await readProducingManifest(input.runDir);
  if (!manifest.run_id || basename(manifest.run_id) !== manifest.run_id) throw new Error("Run manifest has an invalid run ID");
  const repoRoot = currentRepositoryRoot(input.runDir, manifest.run_id);
  const repositoryKey = canonicalRepositoryKey(input.repository);

  if (manifest.github_effects_protocol === "legacy-run-v1") {
    const lineageId = deriveLegacyTaskLineageId(repositoryKey, manifest.run_id);
    let lineage: TaskLineageRecordV1;
    try {
      lineage = await createTaskLineage({
        repoRoot,
        runId: manifest.run_id,
        lineageId,
        repositoryKey,
      });
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("already exists")) throw error;
      lineage = assertProducingBinding(
        await readTaskLineage(repoRoot, lineageId),
        lineageId,
        manifest.run_id,
        repositoryKey,
      );
      assertExactInitialEffects(lineage);
    }

    const { migrateLegacyGithubManifest } = await import("./ledger.js");
    manifest = await migrateLegacyGithubManifest(input.runDir, lineageId);
    return {
      manifest,
      lineage: assertProducingBinding(lineage, lineageId, manifest.run_id, repositoryKey),
    };
  }

  const lineageId = manifest.task_lineage_id;
  if (lineageId === null) throw new Error("Task-lineage GitHub effects require a task lineage ID");
  let lineage: TaskLineageRecordV1;
  try {
    lineage = await readTaskLineage(repoRoot, lineageId);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
    lineage = await attachMissingNewRunLineage({ repoRoot, runId: manifest.run_id, lineageId });
  }
  if (lineage.repository_key === null) {
    lineage = await bindInitialRepository(repoRoot, lineageId, manifest.run_id, repositoryKey);
  }
  return {
    manifest,
    lineage: assertProducingBinding(lineage, lineageId, manifest.run_id, repositoryKey),
  };
}

function assertExactInitialEffects(record: TaskLineageRecordV1): void {
  const issueSet = record.issue_set;
  const delivery = record.delivery;
  if (
    record.state !== "active"
    || issueSet.state !== "uninitialized"
    || issueSet.plan_revision !== null
    || issueSet.plan_sha256 !== null
    || issueSet.parent_issue_number !== null
    || Object.keys(issueSet.work_item_issue_map).length !== 0
    || Object.keys(issueSet.operations).length !== 0
    || issueSet.preview !== null
    || delivery.state !== "uninitialized"
    || delivery.branch_name !== null
    || delivery.head_sha !== null
    || delivery.pull_request_number !== null
    || delivery.pull_request_url !== null
    || delivery.preview !== null
    || record.cleanup_state !== "not_required"
  ) throw new Error("Existing legacy task lineage is not the exact initial producing binding");
}

function assertExactRootBinding(record: TaskLineageRecordV1, lineageId: string, runId: string): TaskLineageRecordV1 {
  const exactInitialIssueSet = record.issue_set.state === "uninitialized"
    && record.issue_set.plan_revision === null
    && record.issue_set.plan_sha256 === null
    && record.issue_set.parent_issue_number === null
    && Object.keys(record.issue_set.work_item_issue_map).length === 0
    && Object.keys(record.issue_set.operations).length === 0
    && record.issue_set.preview === null;
  const exactInitialDelivery = record.delivery.state === "uninitialized"
    && record.delivery.branch_name === null
    && record.delivery.head_sha === null
    && record.delivery.pull_request_number === null
    && record.delivery.pull_request_url === null
    && record.delivery.preview === null;
  if (
    record.lineage_id !== lineageId
    || record.root_run_id !== runId
    || record.active_run_id !== runId
    || record.run_ids.length !== 1
    || record.run_ids[0] !== runId
    || record.repository_key !== null
    || record.state !== "active"
    || !exactInitialIssueSet
    || !exactInitialDelivery
    || record.cleanup_state !== "not_required"
  ) throw new Error("Existing task lineage is not the exact initial record for the requested root run binding");
  return record;
}

export async function attachMissingNewRunLineage(input: AttachMissingLineageInput): Promise<TaskLineageRecordV1> {
  if (!input.runId || basename(input.runId) !== input.runId) throw new Error("Requested root run ID is invalid");
  parseLineageId(input.lineageId);
  const runDir = join(resolve(input.repoRoot), ".brain-hands", "runs", input.runId);
  const runDirectory = await captureDirectory(runDir, "Run directory");
  const raw = await readOwnedFile(join(runDir, "manifest.json"), runDirectory, "Run manifest");
  const manifest = runManifestV2Schema.parse(JSON.parse(raw));
  if (manifest.run_id !== input.runId) throw new Error("Run manifest does not match the requested root run");
  if (resolve(manifest.repo_root) !== resolve(input.repoRoot)) throw new Error("Run manifest repository does not match the requested repository");
  if (manifest.github_effects_protocol !== "task-lineage-v1") {
    throw new Error("Only a new task-lineage-v1 manifest can repair a missing lineage");
  }
  if (manifest.task_lineage_id !== input.lineageId) throw new Error("Run manifest lineage does not match the requested lineage");

  try {
    return await createTaskLineage({
      repoRoot: input.repoRoot,
      runId: input.runId,
      lineageId: input.lineageId,
      now: input.now,
    });
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("already exists")) throw error;
    return assertExactRootBinding(await readTaskLineage(input.repoRoot, input.lineageId), input.lineageId, input.runId);
  }
}
