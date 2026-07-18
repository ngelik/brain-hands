import { appendFile, open, readFile, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { join } from "node:path";
import type { RunManifestV2 } from "../core/types.js";
import { readManifestV2 } from "../core/ledger.js";
import {
  canonicalProgressEventKey,
  materializeProgressEvent,
  safeProgressEventSchema,
  type ProgressIntent,
  type SafeProgressEvent,
} from "./events.js";
import { SessionStore } from "./session-store.js";
import { classifySemanticBoundary } from "../workflow/semantic-boundary.js";

export interface ProgressReporter {
  readonly path: string;
  readonly sessionId: string;
  readonly workerPid: number;
  emit(intent: ProgressIntent): Promise<SafeProgressEvent | null>;
}

export interface OpenProgressReporterInput {
  runDir: string;
  now?: () => string;
  onEvent?: (event: SafeProgressEvent) => void | Promise<void>;
  onWarning?: () => unknown | Promise<unknown>;
}

export interface FollowProgressInput {
  runDir: string;
  onEvent: (event: SafeProgressEvent) => void | Promise<void>;
  pollMs?: number;
  signal?: AbortSignal;
}

export interface ProgressActivitySummary {
  latest: SafeProgressEvent;
  phase: SafeProgressEvent["phase"];
  health: "active" | "possibly_stale" | "quiescent" | "terminal";
  age_seconds: number;
  last_heartbeat_at: string | null;
}

const progressPath = (runDir: string): string => join(runDir, "progress.jsonl");

function createProgressEventFilter(): (event: SafeProgressEvent) => boolean {
  let lastSequence = 0;
  const eventIds = new Set<string>();
  const eventKeys = new Set<string>();
  return (event) => {
    const eventKey = canonicalProgressEventKey(event);
    if (event.sequence <= lastSequence || eventIds.has(event.event_id) || eventKeys.has(eventKey)) return false;
    lastSequence = event.sequence;
    eventIds.add(event.event_id);
    eventKeys.add(eventKey);
    return true;
  };
}

function parseLine(line: string): SafeProgressEvent | null {
  try {
    return safeProgressEventSchema.parse(JSON.parse(line));
  } catch {
    return null;
  }
}

/** Stream complete validated records; an unterminated final record is ignored. */
export async function* readProgressEvents(runDir: string): AsyncGenerator<SafeProgressEvent> {
  const stream = createReadStream(progressPath(runDir));
  const decoder = new StringDecoder("utf8");
  const acceptEvent = createProgressEventFilter();
  let carry = "";
  try {
    for await (const chunk of stream) {
      carry += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      let newline = carry.indexOf("\n");
      while (newline >= 0) {
        const line = carry.slice(0, newline).trimEnd();
        carry = carry.slice(newline + 1);
        if (line.trim()) {
          const event = parseLine(line);
          if (event && acceptEvent(event)) yield event;
        }
        newline = carry.indexOf("\n");
      }
    }
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code !== "ENOENT") throw error;
  }
  decoder.end();
}

export async function openProgressReporter(input: OpenProgressReporterInput): Promise<ProgressReporter> {
  const path = progressPath(input.runDir);
  const existingKeys = new Set<string>();
  let sequence = 0;
  let initializationFailed = false;
  try {
    for await (const event of readProgressEvents(input.runDir)) {
      sequence = Math.max(sequence, event.sequence);
      existingKeys.add(event.event_key);
      existingKeys.add(canonicalProgressEventKey(event));
    }
  } catch {
    initializationFailed = true;
  }
  let queue = Promise.resolve();
  let disabled = initializationFailed;
  let warned = false;
  const sessionId = randomUUID();
  const workerPid = process.pid;
  const warnOnce = async (): Promise<void> => {
    if (warned) return;
    warned = true;
    try {
      await input.onWarning?.();
    } catch {
      // Warning delivery is observational and must not escape the reporter.
    }
  };
  let sessionStore: SessionStore | null = null;
  if (!initializationFailed) {
    try {
      const candidate = new SessionStore(input.runDir);
      if (await candidate.isAvailable()) sessionStore = candidate;
    } catch {
      sessionStore = null;
    }
  }
  if (initializationFailed || sessionStore === null) await warnOnce();

  return {
    path,
    sessionId,
    workerPid,
    emit(intent) {
      const task = queue.then(async (): Promise<SafeProgressEvent | null> => {
        if (disabled) {
          await warnOnce();
          return null;
        }
        let candidate: SafeProgressEvent;
        try {
          candidate = materializeProgressEvent({
            ...intent,
            workerSessionId: intent.workerSessionId ?? sessionId,
            workerPid: intent.workerPid ?? workerPid,
          }, sequence + 1, (input.now ?? (() => new Date().toISOString()))());
          if (existingKeys.has(candidate.event_key)) return null;
        } catch {
          disabled = true;
          await warnOnce();
          return null;
        }
        try {
          await appendFile(path, `${JSON.stringify(candidate)}\n`, "utf8");
        } catch {
          disabled = true;
          await warnOnce();
          return null;
        }
        sequence = candidate.sequence;
        existingKeys.add(candidate.event_key);
        if (sessionStore) {
          let contributed = false;
          let finalized = false;
          try {
            const next = await sessionStore.contribute(candidate);
            contributed = next !== null;
            const manifest = await readManifestV2(input.runDir).catch(() => null);
            if (manifest?.terminal && manifest.assurance_outcome !== null) {
              finalized = (await sessionStore.finalize()) !== null;
            }
          } catch {
            // The durable session contribution and finalization are observational.
          }
          if (!contributed && !finalized) await warnOnce();
          if (finalized === false) {
            const manifest = await readManifestV2(input.runDir).catch(() => null);
            if (manifest?.terminal && manifest.assurance_outcome !== null) await warnOnce();
          }
        } else {
          await warnOnce();
        }
        try {
          await input.onEvent?.(candidate);
        } catch {
          await warnOnce();
        }
        return candidate;
      });
      queue = task.then(() => undefined, () => undefined);
      return task;
    },
  };
}

export function formatProgressEvent(event: SafeProgressEvent): string {
  return `${event.timestamp.slice(0, 19).replace("T", " ")} UTC  ${event.safe_label}`;
}

export function isQuiescentState(input: {
  manifest: RunManifestV2;
  reflectionExpected: boolean;
  reflectionRecorded: boolean;
}): boolean {
  const { manifest } = input;
  const boundary = classifySemanticBoundary(manifest);
  if (boundary === "terminal") return !input.reflectionExpected || input.reflectionRecorded;
  if (manifest.stage === "replanning") return true;
  return boundary !== null;
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    const onAbort = () => done();
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function followProgressEvents(input: FollowProgressInput): Promise<void> {
  const path = progressPath(input.runDir);
  const intake = JSON.parse(await readFile(join(input.runDir, "intake.json"), "utf8")) as { reflection?: unknown };
  const reflectionExpected = intake.reflection === true;
  const decoder = new StringDecoder("utf8");
  let offset = 0;
  let carry = "";
  let reflectionRecorded = false;
  let acceptEvent = createProgressEventFilter();

  const drain = async (): Promise<void> => {
    let size: number;
    try {
      size = (await stat(path)).size;
    } catch {
      // Progress is observational. Missing or unreadable telemetry must not break follow/status.
      return;
    }
    if (size < offset) {
      offset = 0;
      carry = "";
      decoder.end();
      acceptEvent = createProgressEventFilter();
    }
    if (size === offset) return;
    let handle;
    try {
      handle = await open(path, "r");
    } catch {
      return;
    }
    try {
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(1, size - offset)));
      while (offset < size) {
        const length = Math.min(buffer.length, size - offset);
        let bytesRead: number;
        try {
          ({ bytesRead } = await handle.read(buffer, 0, length, offset));
        } catch {
          return;
        }
        if (bytesRead === 0) break;
        offset += bytesRead;
        carry += decoder.write(buffer.subarray(0, bytesRead));
        let newline = carry.indexOf("\n");
        while (newline >= 0) {
          const line = carry.slice(0, newline).trimEnd();
          carry = carry.slice(newline + 1);
          if (line.trim()) {
            const event = parseLine(line);
            if (event && acceptEvent(event)) {
              if (event.event_key.includes("reflection:reflection_recorded")) reflectionRecorded = true;
              await input.onEvent(event);
            }
          }
          newline = carry.indexOf("\n");
        }
      }
    } finally {
      await handle.close().catch(() => undefined);
    }
  };

  while (!input.signal?.aborted) {
    await drain();
    const manifest = await readManifestV2(input.runDir);
    if (isQuiescentState({ manifest, reflectionExpected, reflectionRecorded })) return;
    await delay(input.pollMs ?? 250, input.signal);
  }
  await drain();
}

export async function summarizeProgressActivity(
  runDir: string,
  manifest: RunManifestV2,
  now: () => string = () => new Date().toISOString(),
  staleAfterMs = 5 * 60 * 1_000,
): Promise<ProgressActivitySummary | null> {
  let latest: SafeProgressEvent | undefined;
  let lastHeartbeatAt: string | null = null;
  try {
    for await (const event of readProgressEvents(runDir)) {
      latest = event;
      if (event.event_key.includes(":heartbeat:")) lastHeartbeatAt = event.timestamp;
    }
  } catch {
    return null;
  }
  if (!latest) return null;
  const ageMs = Math.max(0, Date.parse(now()) - Date.parse(latest.timestamp));
  const boundary = classifySemanticBoundary(manifest);
  const terminal = boundary === "terminal";
  const quiescent = boundary !== null
    || manifest.stage === "replanning"
    || latest.event_key.includes(":worker_completed") || latest.event_key.includes(":worker_blocked");
  return {
    latest,
    phase: latest.phase,
    health: terminal ? "terminal" : quiescent ? "quiescent" : ageMs > staleAfterMs ? "possibly_stale" : "active",
    age_seconds: Math.floor(ageMs / 1000),
    last_heartbeat_at: lastHeartbeatAt,
  };
}
