import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { TextDecoder } from "node:util";
import { join } from "node:path";
import {
  createActiveSessionState,
  finalizeSessionState,
  materializeCanonicalSessionEvent,
  canonicalSessionEventSchema,
  sessionStateSchema,
  contributeProgressToSession,
  type CanonicalSessionEvent,
  type SessionState,
} from "./session-events.js";
import type { SafeProgressEvent } from "./events.js";
import {
  withRunLedgerTransaction,
  writeTextArtifact,
  type RunLedgerTransaction,
} from "../core/ledger.js";
import { appendOwnedRunFile, readOwnedRunFile } from "../core/owned-evidence.js";
import type { AssuranceOutcome, RunManifestV2, RunStageV2, TerminalOutcome } from "../core/types.js";

const noFollow = constants.O_NOFOLLOW ?? 0;
const stateFile = "session-state.json";
const eventFile = "session-events.jsonl";

function decodeUtf8(bytes: Buffer): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

async function readJsonLines(runDir: string): Promise<unknown[]> {
  const bytes = await readOwnedRunFile(runDir, eventFile);
  if (bytes.length === 0) return [];
  const text = decodeUtf8(bytes);
  if (!text.endsWith("\n")) throw new Error("Canonical session event stream is truncated");
  const lines = text.slice(0, -1).split("\n");
  if (lines.some((line) => line.trim() === "")) throw new Error("Canonical session event stream contains a blank record");
  return lines.map((line) => JSON.parse(line) as unknown);
}

async function readState(runDir: string): Promise<SessionState> {
  const bytes = await readOwnedRunFile(runDir, stateFile);
  return sessionStateSchema.parse(JSON.parse(decodeUtf8(bytes)));
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

interface SessionPair {
  state: SessionState;
  event: CanonicalSessionEvent | null;
}

function matchesManifestProvenance(
  state: SessionState,
  event: CanonicalSessionEvent | null,
  manifest: RunManifestV2,
): boolean {
  if (state.terminal_outcome === null || state.assurance_outcome === null || state.terminal_provenance === null) return false;
  const terminal = manifest.terminal;
  if (terminal === null || manifest.assurance_outcome === null) return false;
  if (state.terminal_outcome !== terminal.outcome || state.assurance_outcome !== manifest.assurance_outcome) return false;
  if (state.terminal_provenance.actor !== terminal.actor
    || state.terminal_provenance.recorded_at !== terminal.recorded_at
    || state.terminal_provenance.source_stage !== terminal.source_stage) return false;
  if (event === null) return true;
  return event.terminal_outcome === terminal.outcome
    && event.assurance_outcome === manifest.assurance_outcome
    && event.terminal_provenance.actor === terminal.actor
    && event.terminal_provenance.recorded_at === terminal.recorded_at
    && event.terminal_provenance.source_stage === terminal.source_stage;
}

/** Validate both paired artifacts. The half-final state is only usable by retrying finalization. */
async function readPair(
  transaction: RunLedgerTransaction,
  allowFinalizedWithoutEvent: boolean,
): Promise<SessionPair | null> {
  let state: SessionState;
  let events: unknown[];
  try {
    const manifest = await transaction.readManifestV2();
    state = await readState(transaction.runDir);
    events = await readJsonLines(transaction.runDir);
    if (state.run_id !== manifest.run_id) return null;
    if (events.length > 1) return null;
    if (events.length === 0) {
      const finalized = state.terminal_outcome !== null && state.assurance_outcome !== null;
      if (state.terminal_outcome !== null || state.assurance_outcome !== null) {
        if (!finalized || !allowFinalizedWithoutEvent || !matchesManifestProvenance(state, null, manifest)) return null;
      }
      return { state, event: null };
    }
    const event = canonicalSessionEventSchema.parse(events[0]);
    if (event.run_id !== state.run_id || event.session_id !== state.session_id || event.event_id !== state.canonical_event_id) return null;
    if (state.terminal_outcome === null || state.assurance_outcome === null) return null;
    const expected = materializeCanonicalSessionEvent(state);
    if (!sameJson(event, expected) || !matchesManifestProvenance(state, event, manifest)) return null;
    return { state, event };
  } catch {
    return null;
  }
}

async function writeExclusive(path: string, content: string): Promise<void> {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export interface InitializeSessionArtifactsInput {
  runDir: string;
  runId: string;
  createdAt: string;
  sessionId?: string;
  canonicalEventId?: string;
}

/** Initialize only new durable runs; callers intentionally decide whether failures are fail-open. */
export async function initializeSessionArtifacts(input: InitializeSessionArtifactsInput): Promise<SessionState> {
  const state = createActiveSessionState({
    runId: input.runId,
    sessionId: input.sessionId ?? randomUUID(),
    canonicalEventId: input.canonicalEventId ?? randomUUID(),
    createdAt: input.createdAt,
  });
  await writeExclusive(join(input.runDir, stateFile), `${JSON.stringify(state)}\n`);
  await writeExclusive(join(input.runDir, eventFile), "");
  return state;
}

/** Read a valid paired session or return null without repairing either artifact. */
export async function readSessionState(runDir: string): Promise<SessionState | null> {
  try {
    const pair = await withRunLedgerTransaction(runDir, (transaction) => readPair(transaction, false));
    return pair?.state ?? null;
  } catch {
    return null;
  }
}

async function updateSessionStateLocked(
  transaction: RunLedgerTransaction,
  event: SafeProgressEvent,
): Promise<SessionState | null> {
  const pair = await readPair(transaction, false);
  if (!pair || pair.event !== null || pair.state.terminal_outcome !== null || pair.state.assurance_outcome !== null) return null;
  let next: SessionState;
  try {
    next = contributeProgressToSession(pair.state, event);
  } catch {
    return null;
  }
  try {
    await writeTextArtifact(transaction.runDir, stateFile, `${JSON.stringify(next)}\n`);
  } catch {
    return null;
  }
  return next;
}

/** Add one already-persisted safe progress event to the durable aggregate. */
export async function updateSessionState(runDir: string, event: SafeProgressEvent): Promise<SessionState | null> {
  try {
    return await withRunLedgerTransaction(runDir, (transaction) => updateSessionStateLocked(transaction, event));
  } catch {
    return null;
  }
}

async function finalizeSessionLocked(transaction: RunLedgerTransaction): Promise<CanonicalSessionEvent | null> {
  const pair = await readPair(transaction, true);
  if (!pair) return null;
  if (pair.event) return pair.event;
  const state = pair.state;
  if (state.terminal_outcome !== null || state.assurance_outcome !== null) {
    if (state.terminal_outcome === null || state.assurance_outcome === null) return null;
    const event = materializeCanonicalSessionEvent(state);
    try {
      await appendOwnedRunFile(transaction.runDir, eventFile, `${JSON.stringify(event)}\n`);
      return event;
    } catch {
      return null;
    }
  }
  let manifest;
  try {
    manifest = await transaction.readManifestV2();
  } catch {
    return null;
  }
  if (!manifest.terminal || manifest.assurance_outcome === null) return null;
  let finalized: SessionState;
  try {
    finalized = finalizeSessionState(
      state,
      {
        outcome: manifest.terminal.outcome as TerminalOutcome,
        actor: manifest.terminal.actor,
        recorded_at: manifest.terminal.recorded_at,
        source_stage: manifest.terminal.source_stage as RunStageV2,
      },
      manifest.assurance_outcome as AssuranceOutcome,
    );
  } catch {
    return null;
  }
  try {
    await writeTextArtifact(transaction.runDir, stateFile, `${JSON.stringify(finalized)}\n`);
    const event = materializeCanonicalSessionEvent(finalized);
    await appendOwnedRunFile(transaction.runDir, eventFile, `${JSON.stringify(event)}\n`);
    return event;
  } catch {
    return null;
  }
}

/** Finalize from the manifest's terminal and assurance fields, preserving the preallocated event id. */
export async function finalizeSession(runDir: string): Promise<CanonicalSessionEvent | null> {
  try {
    return await withRunLedgerTransaction(runDir, finalizeSessionLocked);
  } catch {
    return null;
  }
}

export class SessionStore {
  readonly runDir: string;
  private readonly constructionValidation: Promise<SessionState | null>;

  constructor(input: string | { runDir: string }) {
    this.runDir = typeof input === "string" ? input : input.runDir;
    this.constructionValidation = readSessionState(this.runDir);
  }

  async isAvailable(): Promise<boolean> {
    return (await this.constructionValidation) !== null;
  }

  async readState(): Promise<SessionState | null> {
    if ((await this.constructionValidation.catch(() => null)) === null) return null;
    return readSessionState(this.runDir);
  }

  async contribute(event: SafeProgressEvent): Promise<SessionState | null> {
    if ((await this.constructionValidation.catch(() => null)) === null) return null;
    return updateSessionState(this.runDir, event);
  }

  async update(event: SafeProgressEvent): Promise<SessionState | null> {
    return this.contribute(event);
  }

  async finalize(): Promise<CanonicalSessionEvent | null> {
    return finalizeSession(this.runDir);
  }
}

export async function openSessionStore(runDir: string): Promise<SessionStore | null> {
  const store = new SessionStore(runDir);
  return (await store.isAvailable()) ? store : null;
}

export const createSessionStore = openSessionStore;
export const readSession = readSessionState;
