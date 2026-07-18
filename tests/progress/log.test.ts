import { appendFile, mkdir, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRunLedgerV2, readManifestV2, recordTerminalDisposition, transitionRun, updateManifestV2, withRunLedgerTransaction } from "../../src/core/ledger.js";
import { materializeProgressEvent, safeProgressEventSchema, type SafeProgressEvent } from "../../src/progress/events.js";
import { canonicalSessionEventSchema, sessionStateSchema } from "../../src/progress/session-events.js";
import { runEventSchema } from "../../src/core/schema.js";
import {
  followProgressEvents,
  formatProgressEvent,
  isQuiescentState,
  openProgressReporter,
  readProgressEvents,
  summarizeProgressActivity,
} from "../../src/progress/log.js";
import { readSessionState } from "../../src/progress/session-store.js";
import { createLegacyRunLedgerV2 } from "../fixtures/legacy-run.js";
import { classifySemanticBoundary } from "../../src/workflow/semantic-boundary.js";

const canonicalAppendFailure = vi.hoisted(() => ({ enabled: false, paths: [] as string[] }));
vi.mock("../../src/core/owned-evidence.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/core/owned-evidence.js")>();
  return {
    ...actual,
    appendOwnedRunFile: vi.fn(async (runDir: string, path: string, content: string | Buffer) => {
      canonicalAppendFailure.paths.push(path);
      if (canonicalAppendFailure.enabled && path === "session-events.jsonl") throw new Error("canonical append failed");
      return actual.appendOwnedRunFile(runDir, path, content);
    }),
  };
});

let root: string | undefined;
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = undefined; });

async function ledger() {
  root = await mkdtemp(join(tmpdir(), "brain-hands-progress-"));
  return createLegacyRunLedgerV2({ repoRoot: root, originalRequest: "Observe progress", intake: { task: "Observe progress", repo_root: root, mode: "local", research: false, reflection: false } });
}

async function durableLedger() {
  root = await mkdtemp(join(tmpdir(), "brain-hands-progress-durable-"));
  return createRunLedgerV2({
    repoRoot: root,
    originalRequest: "Observe durable progress",
    now: new Date("2026-07-11T19:59:59.000Z"),
    intake: { task: "Observe durable progress", repo_root: root, mode: "local", research: false, reflection: false },
  });
}

async function collect(runDir: string): Promise<SafeProgressEvent[]> {
  const result: SafeProgressEvent[] = [];
  for await (const event of readProgressEvents(runDir)) result.push(event);
  return result;
}

describe("progress log", () => {
  it("reports an explicitly closed blocked run as terminal while an ordinary blocker stays quiescent", async () => {
    const run = await ledger();
    const reporter = await openProgressReporter({ runDir: run.runDir, now: () => "2026-07-11T20:00:00.000Z" });
    await reporter.emit({ code: "worker_blocked", source: "runtime" });
    await updateManifestV2(run.runDir, { delivery_state: "blocked", last_blocker: "Dependency unavailable" });
    const blocked = await readManifestV2(run.runDir);
    expect((await summarizeProgressActivity(run.runDir, blocked, () => "2026-07-11T20:01:00.000Z"))?.health).toBe("quiescent");

    await recordTerminalDisposition(run.runDir, {
      outcome: "closed_blocked",
      actor: "human",
      reason: "Stop waiting",
      residual_risks: ["Delivery incomplete"],
    });
    const terminal = await readManifestV2(run.runDir);
    expect((await summarizeProgressActivity(run.runDir, terminal, () => "2026-07-11T20:01:00.000Z"))?.health).toBe("terminal");
    expect(isQuiescentState({ manifest: terminal, reflectionExpected: true, reflectionRecorded: false })).toBe(false);
    expect(isQuiescentState({ manifest: terminal, reflectionExpected: true, reflectionRecorded: true })).toBe(true);
  });

  it("keeps following a terminal approval-stage run until its enabled reflection is recorded", async () => {
    const run = await ledger();
    await updateManifestV2(run.runDir, { stage: "awaiting_plan_approval" });
    await recordTerminalDisposition(run.runDir, {
      outcome: "abandoned",
      actor: "human",
      reason: "The request is no longer needed",
      residual_risks: [],
    });
    const manifest = await readManifestV2(run.runDir);

    expect(isQuiescentState({ manifest, reflectionExpected: true, reflectionRecorded: false })).toBe(false);
    expect(isQuiescentState({ manifest, reflectionExpected: true, reflectionRecorded: true })).toBe(true);
  });

  it("keeps the legacy follower quiescent in replanning while the shared classifier remains non-boundary", async () => {
    const run = await ledger();
    const replanning = await updateManifestV2(run.runDir, {
      stage: "replanning",
      delivery_state: "pending",
      work_item_progress: {
        issue: {
          status: "in_progress",
          attempts: 1,
          review_revision: 1,
          replan_patch_path: "replans/work-item-aXNzdWU-base-1-review-1.json",
        },
      },
    });

    expect(isQuiescentState({ manifest: replanning, reflectionExpected: false, reflectionRecorded: false })).toBe(true);
    expect(classifySemanticBoundary(replanning)).toBeNull();

    const approval = await updateManifestV2(run.runDir, { stage: "awaiting_plan_approval" });
    expect(isQuiescentState({ manifest: approval, reflectionExpected: false, reflectionRecorded: false })).toBe(true);
    expect(classifySemanticBoundary(approval)).toBe("plan_approval");
  });

  it("sequences, persists, renders, and deduplicates before callbacks", async () => {
    const run = await ledger();
    const rendered: number[] = [];
    const reporter = await openProgressReporter({
      runDir: run.runDir,
      now: () => "2026-07-11T20:00:00.000Z",
      onEvent: (event) => { rendered.push(event.sequence); },
    });

    expect(await reporter.emit({ code: "planning_started", source: "brain" })).toMatchObject({ sequence: 1 });
    expect(await reporter.emit({ code: "planning_started", source: "brain" })).toBeNull();
    expect(rendered).toEqual([1]);
    expect(await collect(run.runDir)).toHaveLength(1);
    expect(formatProgressEvent((await collect(run.runDir))[0]!)).toBe("2026-07-11 20:00:00 UTC  Planning started");

    const resumed = await openProgressReporter({ runDir: run.runDir, now: () => "2026-07-11T20:01:00.000Z" });
    expect(await resumed.emit({ code: "repository_inspection", source: "brain" })).toMatchObject({ sequence: 2 });
  });

  it("starts progress safely when an older v2 run has no progress file", async () => {
    const run = await ledger();
    await unlink(join(run.runDir, "progress.jsonl"));
    expect(await collect(run.runDir)).toEqual([]);
    const reporter = await openProgressReporter({ runDir: run.runDir, now: () => "2026-07-11T20:00:00.000Z" });
    expect(await reporter.emit({ code: "planning_started", source: "brain" })).toMatchObject({ sequence: 1 });
  });

  it("ignores an incomplete trailing record until its newline arrives", async () => {
    const run = await ledger();
    const reporter = await openProgressReporter({ runDir: run.runDir, now: () => "2026-07-11T20:00:00.000Z" });
    await reporter.emit({ code: "planning_started", source: "brain" });
    const event = materializeProgressEvent({
      code: "repository_inspection",
      source: "brain",
      workerSessionId: reporter.sessionId,
      workerPid: reporter.workerPid,
    }, 2, "2026-07-11T20:00:01.000Z");
    await appendFile(join(run.runDir, "progress.jsonl"), JSON.stringify(event).slice(0, -1));
    expect(await collect(run.runDir)).toHaveLength(1);
    await appendFile(join(run.runDir, "progress.jsonl"), "}\n");
    expect(await collect(run.runDir)).toHaveLength(2);
  });

  it("reports stale activity without changing authoritative state", async () => {
    const run = await ledger();
    const reporter = await openProgressReporter({ runDir: run.runDir, now: () => "2026-07-11T20:00:00.000Z" });
    await reporter.emit({
      code: "heartbeat", source: "hands", heartbeatOrdinal: 1,
      workerSessionId: "4ed9e32e-5787-4aac-9cb0-a531037d4b64", workerPid: 36551,
      workItem: { index: 1, total: 1, attempt: 1, final: false },
    });
    const manifest = await updateManifestV2(run.runDir, { stage: "implementing" });

    const activity = await summarizeProgressActivity(run.runDir, manifest, () => "2026-07-11T20:06:00.000Z");
    expect(activity).toMatchObject({ health: "possibly_stale", age_seconds: 360, phase: "model_invocation" });
    expect(activity?.latest.worker_pid).toBe(36551);
  });

  it("follows appended events and exits at an approval boundary", async () => {
    const run = await ledger();
    await transitionRun(run.runDir, "preflight");
    await transitionRun(run.runDir, "brain_planning");
    const seen: number[] = [];
    const following = followProgressEvents({ runDir: run.runDir, pollMs: 10, onEvent: (event) => { seen.push(event.sequence); } });
    const reporter = await openProgressReporter({ runDir: run.runDir, now: () => "2026-07-11T20:00:00.000Z" });
    await reporter.emit({ code: "planning_started", source: "brain" });
    await transitionRun(run.runDir, "awaiting_plan_approval");
    await following;
    expect(seen).toEqual([1]);
  });

  it("leaves a durable session unchanged when progress append fails and warns once", async () => {
    const run = await durableLedger();
    const stateBefore = await readFile(join(run.runDir, "session-state.json"));
    const canonicalBefore = await readFile(join(run.runDir, "session-events.jsonl"));
    let warnings = 0;
    const reporter = await openProgressReporter({ runDir: run.runDir, onWarning: () => warnings += 1 });
    await rename(join(run.runDir, "progress.jsonl"), join(run.runDir, "progress.old"));
    await mkdir(join(run.runDir, "progress.jsonl"));
    expect(await reporter.emit({ code: "planning_started", source: "brain" })).toBeNull();
    expect(await reporter.emit({ code: "repository_inspection", source: "brain" })).toBeNull();
    expect(warnings).toBe(1);
    expect(await readFile(join(run.runDir, "session-state.json"))).toEqual(stateBefore);
    expect(await readFile(join(run.runDir, "session-events.jsonl"))).toEqual(canonicalBefore);
    expect(await readFile(join(run.runDir, "progress.old"), "utf8")).toBe("");
  });

  it("returns a disabled reporter when an existing progress path is unreadable", async () => {
    const run = await ledger();
    await unlink(join(run.runDir, "progress.jsonl"));
    await mkdir(join(run.runDir, "progress.jsonl"));
    let warnings = 0;
    const reporter = await openProgressReporter({ runDir: run.runDir, onWarning: () => { warnings += 1; } });
    expect(await reporter.emit({ code: "planning_started", source: "brain" })).toBeNull();
    expect(warnings).toBe(1);
  });

  it("skips a catalog-tampered persisted event", async () => {
    const run = await ledger();
    const reporter = await openProgressReporter({ runDir: run.runDir, now: () => "2026-07-11T20:00:00.000Z" });
    const event = await reporter.emit({ code: "planning_started", source: "brain" });
    await appendFile(join(run.runDir, "progress.jsonl"), `${JSON.stringify({
      ...event,
      sequence: 2,
      event_id: "78d55bed-1287-4d1e-8917-f4c412df1377",
      safe_label: "token=sk-secret",
    })}\n`);

    expect(await collect(run.runDir)).toEqual([event]);
  });

  it("treats an unreadable progress path as unavailable status telemetry", async () => {
    const run = await ledger();
    await unlink(join(run.runDir, "progress.jsonl"));
    await mkdir(join(run.runDir, "progress.jsonl"));
    const manifest = await updateManifestV2(run.runDir, { stage: "implementing" });

    await expect(summarizeProgressActivity(run.runDir, manifest)).resolves.toBeNull();
  });

  it("exits follow cleanly for a quiescent older run without a progress file", async () => {
    const run = await ledger();
    await transitionRun(run.runDir, "preflight");
    await transitionRun(run.runDir, "brain_planning");
    await transitionRun(run.runDir, "awaiting_plan_approval");
    await unlink(join(run.runDir, "progress.jsonl"));

    const seen: SafeProgressEvent[] = [];
    await expect(followProgressEvents({
      runDir: run.runDir,
      pollMs: 10,
      onEvent: (event) => { seen.push(event); },
    })).resolves.toBeUndefined();
    expect(seen).toEqual([]);
  });

  it("does not hide follower callback failures as telemetry read failures", async () => {
    const run = await ledger();
    const reporter = await openProgressReporter({ runDir: run.runDir });
    await reporter.emit({ code: "planning_started", source: "brain" });
    await transitionRun(run.runDir, "preflight");
    await transitionRun(run.runDir, "brain_planning");
    await transitionRun(run.runDir, "awaiting_plan_approval");

    await expect(followProgressEvents({
      runDir: run.runDir,
      onEvent: () => { throw new Error("renderer failed"); },
    })).rejects.toThrow("renderer failed");
  });

  it("deduplicates a legacy session-scoped durable key after resume", async () => {
    const run = await ledger();
    const sessionId = "4ed9e32e-5787-4aac-9cb0-a531037d4b64";
    const event = materializeProgressEvent({
      code: "plan_ready",
      source: "brain",
      revision: 1,
      workerSessionId: sessionId,
    }, 1, "2026-07-11T20:00:00.000Z");
    await appendFile(join(run.runDir, "progress.jsonl"), `${JSON.stringify({
      ...event,
      event_key: `${event.event_key}:session:${sessionId}`,
    })}\n`);

    expect(await collect(run.runDir)).toHaveLength(1);
    const resumed = await openProgressReporter({ runDir: run.runDir });
    expect(await resumed.emit({ code: "plan_ready", source: "brain", revision: 1 })).toBeNull();
  });

  it("skips duplicate and non-monotonic records during replay", async () => {
    const run = await ledger();
    const reporter = await openProgressReporter({ runDir: run.runDir });
    const first = await reporter.emit({ code: "planning_started", source: "brain" });
    const duplicateSequence = materializeProgressEvent({
      code: "repository_inspection",
      source: "brain",
      workerSessionId: reporter.sessionId,
      workerPid: reporter.workerPid,
    }, 1, "2026-07-11T20:00:01.000Z");
    const duplicateKey = materializeProgressEvent({
      code: "planning_started",
      source: "brain",
      workerSessionId: reporter.sessionId,
      workerPid: reporter.workerPid,
    }, 2, "2026-07-11T20:00:02.000Z");
    await appendFile(join(run.runDir, "progress.jsonl"), `${JSON.stringify(duplicateSequence)}\n${JSON.stringify(duplicateKey)}\n`);

    expect(await collect(run.runDir)).toEqual([first]);
  });

  it("persists progress before an unavailable session contribution and warns once", async () => {
    const run = await durableLedger();
    const warnings: number[] = [];
    const reporter = await openProgressReporter({ runDir: run.runDir, onWarning: async () => { warnings.push(1); throw new Error("warning sink failed"); } });
    await unlink(join(run.runDir, "session-state.json"));
    const event = await reporter.emit({ code: "planning_started", source: "brain" });
    expect(event).not.toBeNull();
    expect(await collect(run.runDir)).toHaveLength(1);
    expect(await readSessionState(run.runDir)).toBeNull();
    expect(warnings).toHaveLength(1);
    await reporter.emit({ code: "repository_inspection", source: "brain" });
    expect(warnings).toHaveLength(1);
  });

  it("contains construction-time unavailable session artifacts and warns once", async () => {
    const run = await durableLedger();
    await unlink(join(run.runDir, "session-state.json"));
    let warnings = 0;
    const reporter = await openProgressReporter({ runDir: run.runDir, onWarning: () => { warnings += 1; throw new Error("warning sink failed"); } });
    expect(warnings).toBe(1);
    expect(await reporter.emit({ code: "planning_started", source: "brain" })).not.toBeNull();
    expect(await reporter.emit({ code: "repository_inspection", source: "brain" })).not.toBeNull();
    expect(warnings).toBe(1);
    expect(await collect(run.runDir)).toHaveLength(2);
  });

  it("contains a failed durable state update after progress persistence", async () => {
    const run = await durableLedger();
    let warnings = 0;
    const reporter = await openProgressReporter({ runDir: run.runDir, onWarning: () => { warnings += 1; } });
    const statePath = join(run.runDir, "session-state.json");
    await rename(statePath, `${statePath}.saved`);
    await mkdir(statePath);
    expect(await reporter.emit({ code: "planning_started", source: "brain" })).not.toBeNull();
    expect(await collect(run.runDir)).toHaveLength(1);
    expect(await readSessionState(run.runDir)).toBeNull();
    expect(warnings).toBe(1);
  });

  it("contains a failed canonical append after state finalization and retries exactly once", async () => {
    const run = await durableLedger();
    let warnings = 0;
    const reporter = await openProgressReporter({
      runDir: run.runDir,
      now: () => "2026-07-11T20:00:01.000Z",
      onWarning: () => { warnings += 1; throw new Error("warning sink failed"); },
    });
    const eventPath = join(run.runDir, "session-events.jsonl");
    await updateManifestV2(run.runDir, { delivery_state: "blocked", last_blocker: "test blocker" });
    await updateManifestV2(run.runDir, { assurance_outcome: "blocked" });
    await withRunLedgerTransaction(run.runDir, (transaction) => transaction.recordTerminalDisposition({
      outcome: "closed_blocked", actor: "human", reason: "Stop", residual_risks: [],
      recorded_at: "2026-07-11T20:00:02.000Z", source_stage: "intake",
    }));
    canonicalAppendFailure.enabled = true;
    canonicalAppendFailure.paths.length = 0;
    try {
      expect(await reporter.emit({ code: "planning_started", source: "brain" })).not.toBeNull();
    } finally {
      canonicalAppendFailure.enabled = false;
    }
    expect(await collect(run.runDir)).toHaveLength(1);
    expect(canonicalAppendFailure.paths).toContain("session-events.jsonl");
    expect(warnings).toBe(1);
    const finalizedState = JSON.parse(await readFile(join(run.runDir, "session-state.json"), "utf8"));
    expect(finalizedState.terminal_outcome).toBe("closed_blocked");
    expect(finalizedState.assurance_outcome).toBe("blocked");
    expect(await readFile(eventPath, "utf8")).toBe("");

    const retry = await openProgressReporter({ runDir: run.runDir, now: () => "2026-07-11T20:00:04.000Z" });
    expect(await retry.emit({ code: "repository_inspection", source: "brain" })).not.toBeNull();
    expect((await readFile(eventPath, "utf8")).trim().split("\n")).toHaveLength(1);
  });

  it("keeps fixed session aggregates free of progress labels and callback failures", async () => {
    const run = await durableLedger();
    const reporter = await openProgressReporter({
      runDir: run.runDir,
      now: () => "2026-07-11T20:00:00.000Z",
      onEvent: async () => { throw new Error("observer failed"); },
    });
    const event = await reporter.emit({ code: "planning_started", source: "brain" });
    expect(event).not.toBeNull();
    const state = await readSessionState(run.runDir);
    expect(state?.status_counts.started).toBe(1);
    expect(JSON.stringify(state)).not.toContain("Planning started");
    expect(JSON.stringify(state)).not.toContain("safe_label");
  });

  it("keeps authoritative, progress, state, and canonical streams schema-distinct", async () => {
    const run = await durableLedger();
    const reporter = await openProgressReporter({ now: () => "2026-07-11T20:00:00.000Z", runDir: run.runDir });
    const progressEvent = await reporter.emit({ code: "planning_started", source: "brain" });
    expect(progressEvent).not.toBeNull();
    const stateBeforeFinalization = sessionStateSchema.parse(JSON.parse(await readFile(join(run.runDir, "session-state.json"), "utf8")));
    const progressRaw = await readFile(join(run.runDir, "progress.jsonl"), "utf8");
    expect(() => canonicalSessionEventSchema.parse(JSON.parse(progressRaw))).toThrow();
    expect(() => safeProgressEventSchema.parse(JSON.parse(progressRaw))).not.toThrow();
    const rawState = await readFile(join(run.runDir, "session-state.json"), "utf8");
    expect(() => sessionStateSchema.parse(JSON.parse(rawState))).not.toThrow();

    await updateManifestV2(run.runDir, { delivery_state: "blocked", last_blocker: "test blocker" });
    await updateManifestV2(run.runDir, { assurance_outcome: "blocked" });
    await recordTerminalDisposition(run.runDir, {
      outcome: "closed_blocked", actor: "human", reason: "Stop", residual_risks: [],
      recorded_at: "2026-07-11T20:00:02.000Z",
    });
    const canonicalRaw = await readFile(join(run.runDir, "session-events.jsonl"), "utf8");
    const canonicalEvent = JSON.parse(canonicalRaw);
    expect(() => canonicalSessionEventSchema.parse(canonicalEvent)).not.toThrow();
    expect(() => safeProgressEventSchema.parse(canonicalEvent)).toThrow();
    expect(() => sessionStateSchema.parse(canonicalEvent)).toThrow();
    expect(runEventSchema.parse(JSON.parse((await readFile(join(run.runDir, "events.jsonl"), "utf8")).trim()))).toMatchObject({ type: "run_terminalized" });
    expect(stateBeforeFinalization.status_counts.started).toBe(1);
    expect(progressEvent?.safe_label).toBe("Planning started");
  });
});
