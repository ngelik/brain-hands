import { appendFile, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { BRAIN_HANDS_STATE_LABELS } from "../core/github-labels.js";

const retrySchema = z.object({
  class: z.enum([
    "comment_lookup",
    "comment_create",
    "comment_edit",
    "comment_conflict",
    "label_sync",
    "event_create",
    "lock_contended",
    "checkpoint_write",
    "issue_observation",
    "unsupported",
  ]),
  at: z.string().datetime(),
}).strict();

const targetSchema = z.object({
  commentId: z.number().int().positive().nullable(),
  projectionHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  label: z.enum(BRAIN_HANDS_STATE_LABELS).nullable(),
  emittedEventKeys: z.array(z.string().min(1).max(200)).default([]),
  syncedAt: z.string().datetime().nullable(),
  retry: retrySchema.nullable(),
}).strict();

export const githubStatusCheckpointSchema = z.object({
  version: z.literal(1),
  targets: z.record(z.string().min(1).max(300), targetSchema),
}).strict();

const materialEventSchema = z.object({
  kind: z.enum(["verification_blocked", "replan_required", "reviewer_findings", "operational_blocker"]),
  attempt: z.number().int().positive(),
  blockerClass: z.enum(["hands_invalid", "verification_invalid", "verifier_invalid", "attempts_exhausted"]).optional(),
}).strict();

const artifactPathSchema = z.string().min(1).max(500).refine(
  (value) => !value.startsWith("/") && !value.includes("\\") && !value.split("/").includes(".."),
  "Artifact path must be a safe relative path",
);

export const githubStatusIntentSchema = z.object({
  version: z.literal(1),
  id: z.string().regex(/^[A-Za-z0-9._:-]{1,300}$/),
  target: z.object({
    kind: z.enum(["issue", "pull_request"]),
    number: z.number().int().positive(),
  }).strict(),
  runId: z.string().regex(/^[A-Za-z0-9._:-]{1,160}$/),
  workItemId: z.string().regex(/^[A-Za-z0-9._:-]{1,160}$/),
  state: z.enum(["ready", "implementing", "verifying", "reviewing", "fixing", "blocked", "complete"]),
  attempt: z.number().int().positive(),
  transitionAt: z.string().datetime(),
  evidencePath: artifactPathSchema.optional(),
  reviewPath: artifactPathSchema.optional(),
  commitSha: z.string().regex(/^[A-Za-z0-9._:-]{1,160}$/).optional(),
  materialEvents: z.array(materialEventSchema).max(20),
}).strict();

export type GitHubStatusCheckpoint = z.infer<typeof githubStatusCheckpointSchema>;
export type GitHubStatusTargetCheckpoint = z.infer<typeof targetSchema>;
export type GitHubStatusIntent = z.infer<typeof githubStatusIntentSchema>;

const EMPTY_TARGET: GitHubStatusTargetCheckpoint = {
  commentId: null,
  projectionHash: null,
  label: null,
  emittedEventKeys: [],
  syncedAt: null,
  retry: null,
};

const EMPTY_CHECKPOINT: GitHubStatusCheckpoint = { version: 1, targets: {} };
const checkpointPath = (runDir: string): string => join(runDir, "github-status.json");
const intentsPath = (runDir: string): string => join(runDir, "github-status-intents.jsonl");

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function cloneTarget(target: GitHubStatusTargetCheckpoint): GitHubStatusTargetCheckpoint {
  return { ...target, emittedEventKeys: [...target.emittedEventKeys], retry: target.retry ? { ...target.retry } : null };
}

async function quarantineCorruptCheckpoint(runDir: string): Promise<void> {
  const source = checkpointPath(runDir);
  const destination = join(runDir, `github-status.json.corrupt-${Date.now()}-${randomUUID()}`);
  await rename(source, destination).catch(() => undefined);
}

export async function readGitHubStatusCheckpoint(runDir: string): Promise<GitHubStatusCheckpoint> {
  let raw: string;
  try {
    raw = await readFile(checkpointPath(runDir), "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { ...EMPTY_CHECKPOINT, targets: {} };
    return { ...EMPTY_CHECKPOINT, targets: {} };
  }

  try {
    return githubStatusCheckpointSchema.parse(JSON.parse(raw));
  } catch {
    await quarantineCorruptCheckpoint(runDir);
    return { ...EMPTY_CHECKPOINT, targets: {} };
  }
}

export async function updateGitHubStatusCheckpoint(
  runDir: string,
  targetKey: string,
  update: (current: GitHubStatusTargetCheckpoint) => GitHubStatusTargetCheckpoint,
): Promise<GitHubStatusCheckpoint> {
  const current = await readGitHubStatusCheckpoint(runDir);
  const previous = current.targets[targetKey] ?? EMPTY_TARGET;
  const target = targetSchema.parse(update(cloneTarget(previous)));
  const next = githubStatusCheckpointSchema.parse({
    ...current,
    targets: { ...current.targets, [targetKey]: target },
  });
  const temporary = join(runDir, `.github-status-${process.pid}-${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  await rename(temporary, checkpointPath(runDir));
  return next;
}

export async function readGitHubStatusIntents(runDir: string): Promise<GitHubStatusIntent[]> {
  let raw: string;
  try {
    raw = await readFile(intentsPath(runDir), "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return [];
    throw error;
  }
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      try {
        return [githubStatusIntentSchema.parse(JSON.parse(line))];
      } catch {
        // A torn intent must not strand later valid intent records. Keep the
        // raw line for inspection and replay the records that validate.
        return [];
      }
    });
}

export async function appendGitHubStatusIntent(runDir: string, intent: GitHubStatusIntent): Promise<void> {
  const parsed = githubStatusIntentSchema.parse(intent);
  const existing = await readGitHubStatusIntents(runDir);
  const serialized = JSON.stringify(parsed);
  if (existing.some((candidate) => candidate.id === parsed.id && JSON.stringify(candidate) === serialized)) return;
  await appendFile(intentsPath(runDir), `${serialized}\n`, "utf8");
}
