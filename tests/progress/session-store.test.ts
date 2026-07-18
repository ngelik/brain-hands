import { appendFile, lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  createRunLedgerV2,
  recordTerminalDisposition,
  updateManifestV2,
  withRunLedgerTransaction,
  writeTextArtifact,
} from "../../src/core/ledger.js";
import { canonicalSessionEventSchema, finalizeSessionState, materializeCanonicalSessionEvent } from "../../src/progress/session-events.js";
import { materializeProgressEvent } from "../../src/progress/events.js";
import {
  finalizeSession,
  readSessionState,
  SessionStore,
  updateSessionState,
} from "../../src/progress/session-store.js";
import { createLegacyRunLedgerV2 } from "../fixtures/legacy-run.js";

let root: string | undefined;
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = undefined; });

async function createRun() {
  root = await mkdtemp(join(tmpdir(), "brain-hands-session-store-"));
  return createRunLedgerV2({
    repoRoot: root,
    originalRequest: "Persist a session",
    now: new Date("2026-07-15T20:34:01.000Z"),
    intake: { task: "Persist a session", repo_root: root, mode: "local", research: false, reflection: false },
  });
}

function progress(code: "planning_started" | "repository_inspection", timestamp = "2026-07-15T20:34:02.000Z") {
  return materializeProgressEvent({ code, source: "brain" }, 1, timestamp);
}

async function finalizeRun() {
  const run = await createRun();
  await updateSessionState(run.runDir, progress("planning_started"));
  await updateManifestV2(run.runDir, { delivery_state: "blocked", last_blocker: "test blocker" });
  await updateManifestV2(run.runDir, { assurance_outcome: "blocked" });
  await recordTerminalDisposition(run.runDir, {
    outcome: "closed_blocked",
    actor: "human",
    reason: "Stop",
    residual_risks: ["risk"],
    recorded_at: "2026-07-15T20:34:03.000Z",
  });
  return run;
}

type ArtifactSnapshot = Record<string, { kind: "missing" | "directory" | "file"; bytes?: Buffer }>;

async function snapshot(runDir: string): Promise<ArtifactSnapshot> {
  const result: ArtifactSnapshot = {};
  for (const name of ["manifest.json", "events.jsonl", "progress.jsonl", "session-state.json", "session-events.jsonl"]) {
    const path = join(runDir, name);
    const status = await lstat(path).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    if (status === null) result[name] = { kind: "missing" };
    else if (status.isDirectory()) result[name] = { kind: "directory" };
    else result[name] = { kind: "file", bytes: await readFile(path) };
  }
  return result;
}

describe("locked paired session store", () => {
  it("initializes separate state and canonical streams and reads across openings", async () => {
    const run = await createRun();
    expect(await readFile(join(run.runDir, "session-events.jsonl"), "utf8")).toBe("");
    const first = new SessionStore(run.runDir);
    await expect(first.isAvailable()).resolves.toBe(true);
    await expect(first.readState()).resolves.toMatchObject({ run_id: run.runId, terminal_outcome: null, assurance_outcome: null });

    await updateSessionState(run.runDir, progress("planning_started"));
    const reopened = new SessionStore(run.runDir);
    const state = await reopened.readState();
    expect(state?.status_counts.started).toBe(1);
    expect(state?.source_counts.brain).toBe(1);
  });

  it("serializes concurrent cross-open contributions without reconstructing from progress", async () => {
    const run = await createRun();
    const first = new SessionStore(run.runDir);
    const second = new SessionStore(run.runDir);
    await Promise.all([first.isAvailable(), second.isAvailable()]);
    const [left, right] = await Promise.all([
      first.contribute(progress("planning_started")),
      second.contribute(progress("repository_inspection")),
    ]);
    expect(left ?? right).not.toBeNull();
    expect((await readSessionState(run.runDir))?.status_counts.started).toBe(1);
    expect((await readSessionState(run.runDir))?.status_counts.in_progress).toBe(1);
    expect(await readFile(join(run.runDir, "progress.jsonl"), "utf8")).toBe("");
  });

  it("freezes manifest-authorized provenance and appends exactly one exact event across retries", async () => {
    const run = await finalizeRun();
    const first = await finalizeSession(run.runDir);
    const second = await finalizeSession(run.runDir);
    expect(first).not.toBeNull();
    expect(second).toEqual(first);
    const raw = await readFile(join(run.runDir, "session-events.jsonl"), "utf8");
    expect(raw.trim().split("\n")).toHaveLength(1);
    const state = await readSessionState(run.runDir);
    expect(state?.terminal_provenance).toEqual({
      actor: "human", recorded_at: "2026-07-15T20:34:03.000Z", source_stage: "intake",
    });
    expect(canonicalSessionEventSchema.parse(JSON.parse(raw))).toEqual(materializeCanonicalSessionEvent(state!));
  });

  it("returns the same exact event for concurrent finalization and never duplicates the stream", async () => {
    const run = await createRun();
    await updateSessionState(run.runDir, progress("planning_started"));
    await withRunLedgerTransaction(run.runDir, async (transaction) => {
      await transaction.updateManifestV2({ delivery_state: "blocked", last_blocker: "test blocker", assurance_outcome: "blocked" });
      await transaction.recordTerminalDisposition({
        outcome: "closed_blocked",
        actor: "human",
        reason: "Stop",
        residual_risks: [],
        recorded_at: "2026-07-15T20:34:03.000Z",
        source_stage: "intake",
      });
    });
    const active = await readSessionState(run.runDir);
    expect(active).toMatchObject({ terminal_outcome: null, assurance_outcome: null });
    expect(await readFile(join(run.runDir, "session-events.jsonl"), "utf8")).toBe("");

    const results = await Promise.all(Array.from({ length: 8 }, () => finalizeSession(run.runDir)));
    expect(results.every((result) => JSON.stringify(result) === JSON.stringify(results[0]))).toBe(true);
    const finalized = await readSessionState(run.runDir);
    expect(finalized).not.toBeNull();
    expect(results[0]).toEqual(materializeCanonicalSessionEvent(finalized!));
    const raw = await readFile(join(run.runDir, "session-events.jsonl"), "utf8");
    expect(raw.trim()).not.toBe("");
    expect(raw.trim().split("\n")).toHaveLength(1);
  });

  it("recovers a fully finalized state with its preallocated exact event after an append gap", async () => {
    const run = await createRun();
    await updateSessionState(run.runDir, progress("planning_started"));
    await updateManifestV2(run.runDir, { delivery_state: "blocked", last_blocker: "test blocker" });
    await updateManifestV2(run.runDir, { assurance_outcome: "blocked" });
    await withRunLedgerTransaction(run.runDir, async (transaction) => transaction.recordTerminalDisposition({
      outcome: "closed_blocked",
      actor: "human",
      reason: "Stop",
      residual_risks: [],
      recorded_at: "2026-07-15T20:34:03.000Z",
      source_stage: "intake",
    }));
    const active = await readSessionState(run.runDir);
    expect(active).not.toBeNull();
    const halfFinal = finalizeSessionState(active!, {
      outcome: "closed_blocked", actor: "human", recorded_at: "2026-07-15T20:34:03.000Z", source_stage: "intake",
    }, "blocked");
    await unlink(join(run.runDir, "session-events.jsonl"));
    await writeFile(join(run.runDir, "session-events.jsonl"), "");
    await writeTextArtifact(run.runDir, "session-state.json", `${JSON.stringify(halfFinal)}\n`);
    expect(await readSessionState(run.runDir)).toBeNull();
    const recovered = await finalizeSession(run.runDir);
    expect(recovered).toEqual(materializeCanonicalSessionEvent(halfFinal));
    expect(await readSessionState(run.runDir)).toEqual(halfFinal);
  });

it.each([
    ["outcome", { outcome: "abandoned" as const, actor: "human" as const, recorded_at: "2026-07-15T20:34:03.000Z", source_stage: "intake" as const }, "blocked" as const],
    ["assurance", { outcome: "closed_blocked" as const, actor: "human" as const, recorded_at: "2026-07-15T20:34:03.000Z", source_stage: "intake" as const }, "abandoned" as const],
    ["actor", { outcome: "delivered" as const, actor: "runtime" as const, recorded_at: "2026-07-15T20:34:03.000Z", source_stage: "intake" as const }, "blocked" as const],
    ["recorded_at", { outcome: "closed_blocked" as const, actor: "human" as const, recorded_at: "2026-07-15T20:34:04.000Z", source_stage: "intake" as const }, "blocked" as const],
    ["source_stage", { outcome: "closed_blocked" as const, actor: "human" as const, recorded_at: "2026-07-15T20:34:03.000Z", source_stage: "delivery" as const }, "blocked" as const],
  ] as const)("rejects finalized state and event with manifest provenance conflict in %s", async (_label, terminal, assurance) => {
    const run = await finalizeRun();
    const state = await readSessionState(run.runDir);
    expect(state).not.toBeNull();
    const altered = finalizeSessionState({ ...state!, terminal_outcome: null, assurance_outcome: null, terminal_provenance: null, updated_at: "2026-07-15T20:34:02.000Z", duration_ms: 1000 }, terminal, assurance);
    const alteredEvent = materializeCanonicalSessionEvent(altered);
    await writeTextArtifact(run.runDir, "session-state.json", `${JSON.stringify(altered)}\n`);
    await writeFile(join(run.runDir, "session-events.jsonl"), `${JSON.stringify(alteredEvent)}\n`);
    const before = await snapshot(run.runDir);
    const store = new SessionStore(run.runDir);
    await expect(store.isAvailable()).resolves.toBe(false);
    expect(await readSessionState(run.runDir)).toBeNull();
    expect(await store.readState()).toBeNull();
    expect(await snapshot(run.runDir)).toEqual(before);
  });

it.each(["missing", "unreadable", "malformed", "truncated", "duplicate", "wrong-run", "wrong-session"] as const)(
    "invalid session-state artifact %s is unavailable through direct and already-open reads without mutation",
    async (kind) => {
      const run = await finalizeRun();
      const statePath = join(run.runDir, "session-state.json");
      const original = await readFile(statePath);
      const store = new SessionStore(run.runDir);
      await expect(store.isAvailable()).resolves.toBe(true);
      if (kind === "missing") await unlink(statePath);
      else if (kind === "unreadable") {
        await rename(statePath, `${statePath}.saved`);
        await mkdir(statePath);
      } else if (kind === "malformed") await writeFile(statePath, "not json\n");
      else if (kind === "truncated") await writeFile(statePath, original.subarray(0, original.length - 4));
      else if (kind === "duplicate") await writeFile(statePath, Buffer.concat([original, original]));
      else {
        const state = JSON.parse(original.toString("utf8")) as Record<string, unknown>;
        if (kind === "wrong-run") state.run_id = `${state.run_id}-wrong`;
        else state.session_id = "78d55bed-1287-4d1e-8917-f4c412df1377";
        await writeFile(statePath, `${JSON.stringify(state)}\n`);
      }
      const before = await snapshot(run.runDir);
      expect(await readSessionState(run.runDir)).toBeNull();
      expect(await store.readState()).toBeNull();
      expect(await snapshot(run.runDir)).toEqual(before);
    },
  );

it.each(["missing", "unreadable", "malformed", "truncated", "duplicate", "wrong-run", "wrong-session"] as const)(
    "invalid session-events stream %s is unavailable through direct and already-open reads without mutation",
    async (kind) => {
      const run = await finalizeRun();
      const eventPath = join(run.runDir, "session-events.jsonl");
      const original = await readFile(eventPath);
      const event = JSON.parse(original.toString("utf8")) as Record<string, unknown>;
      const store = new SessionStore(run.runDir);
      await expect(store.isAvailable()).resolves.toBe(true);
      if (kind === "missing") await unlink(eventPath);
      else if (kind === "unreadable") {
        await rename(eventPath, `${eventPath}.saved`);
        await mkdir(eventPath);
      } else if (kind === "malformed") await writeFile(eventPath, "not json\n");
      else if (kind === "truncated") await writeFile(eventPath, original.subarray(0, original.length - 1));
      else if (kind === "duplicate") await appendFile(eventPath, original);
      else {
        event[kind === "wrong-run" ? "run_id" : "session_id"] = kind === "wrong-run"
          ? `${event.run_id}-wrong`
          : "78d55bed-1287-4d1e-8917-f4c412df1377";
        await writeFile(eventPath, `${JSON.stringify(event)}\n`);
      }
      const before = await snapshot(run.runDir);
      expect(await readSessionState(run.runDir)).toBeNull();
      expect(await store.readState()).toBeNull();
      expect(await snapshot(run.runDir)).toEqual(before);
    },
  );

  it("does not create session artifacts while reading a legacy run", async () => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-session-legacy-"));
    const run = await createLegacyRunLedgerV2({
      repoRoot: root,
      originalRequest: "Read historical run",
      now: new Date("2026-07-15T20:34:01.000Z"),
      intake: { task: "Read historical run", repo_root: root, mode: "local", research: false, reflection: false },
    });
    const before = await snapshot(run.runDir);
    expect(await readSessionState(run.runDir)).toBeNull();
    expect(await new SessionStore(run.runDir).readState()).toBeNull();
    expect(await snapshot(run.runDir)).toEqual(before);
    await expect(lstat(join(run.runDir, "session-state.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(join(run.runDir, "session-events.jsonl"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
