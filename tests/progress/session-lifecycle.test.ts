import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRunLedgerV2, readManifestV2, updateManifestV2, withRunLedgerTransaction } from "../../src/core/ledger.js";
import { canonicalSessionEventSchema } from "../../src/progress/session-events.js";
import { openProgressReporter, readProgressEvents, type ProgressReporter } from "../../src/progress/log.js";
import { finalizeSession, readSessionState, SessionStore } from "../../src/progress/session-store.js";
import * as sessionStore from "../../src/progress/session-store.js";
import {
  PRODUCING_COMMANDS,
  runProducingCommand,
  type LifecycleOutcome,
} from "../../src/progress/session-lifecycle.js";
import { createLegacyRunLedgerV2 } from "../fixtures/legacy-run.js";

let root: string | undefined;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
  vi.restoreAllMocks();
});

function reporter(events: string[]): ProgressReporter {
  return {
    path: "progress.jsonl",
    sessionId: randomUUID(),
    workerPid: process.pid,
    emit: async (intent) => {
      events.push(`${intent.code}:${intent.operation?.safe_tool ?? ""}`);
      return null;
    },
  };
}

describe("producing-command session lifecycle", () => {
  it("preserves one canonical run and session identity across producing invocations", async () => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-session-lifecycle-identity-"));
    const ledger = await createRunLedgerV2({
      repoRoot: root,
      originalRequest: "Preserve session identity",
      now: new Date("2026-07-15T20:34:01.000Z"),
      intake: { task: "Preserve session identity", repo_root: root, mode: "local", research: false, reflection: false },
    });
    const identities: string[] = [];

    for (const command of ["run", "answer-discovery", "resume"] as const) {
      const progress = await openProgressReporter({
        runDir: ledger.runDir,
        now: () => "2026-07-15T20:34:02.000Z",
      });
      await expect(runProducingCommand({
        command,
        runDir: ledger.runDir,
        progress,
        action: async () => ({ status: "ok", command }),
      })).resolves.toMatchObject({ status: "ok", command });
      const state = await readSessionState(ledger.runDir);
      expect(state).not.toBeNull();
      identities.push(`${state!.run_id}:${state!.session_id}:${state!.canonical_event_id}`);
    }

    expect(new Set(identities)).toHaveLength(1);
    const state = await readSessionState(ledger.runDir);
    expect(state).toMatchObject({
      run_id: ledger.runId,
      terminal_outcome: null,
      assurance_outcome: null,
      terminal_provenance: null,
      command_counts: { command: 6, browser_check: 0, artifact_check: 0, commit: 0, push: 0 },
      invocation_counts: { brain: 0, hands: 0, verifier: 0, reflection: 0 },
      status_counts: { started: 3, in_progress: 0, completed: 3, warning: 0, failed: 0 },
      source_counts: { brain: 0, hands: 0, verification: 0, verifier: 0, runtime: 6, github: 0, reflection: 0 },
      token_totals: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 },
    });
    expect(await readFile(join(ledger.runDir, "session-events.jsonl"), "utf8")).toBe("");

    const progressEvents = [];
    for await (const event of readProgressEvents(ledger.runDir)) progressEvents.push(event);
    expect(progressEvents).toHaveLength(6);
    expect(new Set(progressEvents.map((event) => event.worker_session_id))).toHaveLength(3);
    expect(progressEvents.map((event) => event.event_key.replace(/:session:[^:]+$/, ""))).toEqual([
      "runtime:worker_started:operation:command:1",
      "runtime:worker_completed:operation:command:1",
      "runtime:worker_started:operation:command:1",
      "runtime:worker_completed:operation:command:1",
      "runtime:worker_started:operation:command:1",
      "runtime:worker_completed:operation:command:1",
    ]);
  });

  it("validates paired artifacts under the ledger lock and uses manifest terminal provenance", async () => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-session-lifecycle-pair-"));
    const ledger = await createRunLedgerV2({
      repoRoot: root,
      originalRequest: "Finalize paired session artifacts",
      now: new Date("2026-07-15T20:34:01.000Z"),
      intake: { task: "Finalize paired session artifacts", repo_root: root, mode: "local", research: false, reflection: false },
    });
    const progress = await openProgressReporter({ runDir: ledger.runDir, now: () => "2026-07-15T20:34:02.000Z" });
    await progress.emit({ code: "planning_started", source: "brain" });
    expect(await readFile(join(ledger.runDir, "session-events.jsonl"), "utf8")).toBe("");

    await withRunLedgerTransaction(ledger.runDir, async (transaction) => {
      await transaction.updateManifestV2({ assurance_outcome: "blocked", delivery_state: "blocked" });
      await transaction.recordTerminalDisposition({
        outcome: "closed_blocked",
        actor: "human",
        reason: "Stop",
        residual_risks: [],
        recorded_at: "2026-07-15T20:34:03.000Z",
        source_stage: "intake",
      });
    });

    const [first, second] = await Promise.all([finalizeSession(ledger.runDir), finalizeSession(ledger.runDir)]);
    expect(first).not.toBeNull();
    expect(second).toEqual(first);
    const manifest = await readManifestV2(ledger.runDir);
    expect(first).toMatchObject({
      run_id: manifest.run_id,
      terminal_outcome: manifest.terminal!.outcome,
      assurance_outcome: manifest.assurance_outcome,
      terminal_provenance: {
        actor: manifest.terminal!.actor,
        recorded_at: manifest.terminal!.recorded_at,
        source_stage: manifest.terminal!.source_stage,
      },
    });
    expect((await readFile(join(ledger.runDir, "session-events.jsonl"), "utf8")).trim().split("\n")).toHaveLength(1);

    const statePath = join(ledger.runDir, "session-state.json");
    const eventPath = join(ledger.runDir, "session-events.jsonl");
    const validState = await readFile(statePath, "utf8");
    const validEvent = await readFile(eventPath, "utf8");
    await writeFile(statePath, `${JSON.stringify({ ...JSON.parse(validState), unexpected: true })}\n`, "utf8");
    await expect(new SessionStore(ledger.runDir).isAvailable()).resolves.toBe(false);
    await expect(readSessionState(ledger.runDir)).resolves.toBeNull();
    await writeFile(statePath, validState, "utf8");

    const alteredEvent = { ...JSON.parse(validEvent), assurance_outcome: "human_accepted" };
    expect(() => canonicalSessionEventSchema.parse(alteredEvent)).not.toThrow();
    await writeFile(eventPath, `${JSON.stringify(alteredEvent)}\n`, "utf8");
    await expect(new SessionStore(ledger.runDir).isAvailable()).resolves.toBe(false);
    await expect(finalizeSession(ledger.runDir)).resolves.toBeNull();
    expect(await readFile(eventPath, "utf8")).toBe(`${JSON.stringify(alteredEvent)}\n`);
  });

  it("waits for terminal readiness, keeps raw progress separate, and finalizes exactly once", async () => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-session-lifecycle-terminal-"));
    const ledger = await createRunLedgerV2({
      repoRoot: root,
      originalRequest: "Wait for terminal readiness",
      now: new Date("2026-07-15T20:34:01.000Z"),
      intake: { task: "Wait for terminal readiness", repo_root: root, mode: "local", research: false, reflection: false },
    });
    const progress = await openProgressReporter({ runDir: ledger.runDir, now: () => "2026-07-15T20:34:02.000Z" });
    await expect(runProducingCommand({
      command: "run",
      runDir: ledger.runDir,
      progress,
      action: async () => "ready",
    })).resolves.toBe("ready");

    const progressRaw = await readFile(join(ledger.runDir, "progress.jsonl"), "utf8");
    expect(progressRaw.trim().split("\n")).toHaveLength(2);
    expect(() => canonicalSessionEventSchema.parse(JSON.parse(progressRaw.trim().split("\n")[0]!))).toThrow();
    expect(await readFile(join(ledger.runDir, "session-events.jsonl"), "utf8")).toBe("");

    await updateManifestV2(ledger.runDir, { assurance_outcome: "blocked", delivery_state: "blocked" });
    expect(await readFile(join(ledger.runDir, "session-events.jsonl"), "utf8")).toBe("");
    await withRunLedgerTransaction(ledger.runDir, (transaction) => transaction.recordTerminalDisposition({
      outcome: "closed_blocked",
      actor: "human",
      reason: "Stop",
      residual_risks: [],
      recorded_at: "2026-07-15T20:34:03.000Z",
      source_stage: "intake",
    }));

    const final = await runProducingCommand({
      command: "close-run",
      runDir: ledger.runDir,
      action: async () => "retried",
    });
    expect(final).toBe("retried");
    const canonicalRaw = await readFile(join(ledger.runDir, "session-events.jsonl"), "utf8");
    expect(canonicalRaw.trim().split("\n")).toHaveLength(1);
    expect(canonicalSessionEventSchema.parse(JSON.parse(canonicalRaw))).toMatchObject({
      terminal_outcome: "closed_blocked",
      assurance_outcome: "blocked",
    });
    expect(await readFile(join(ledger.runDir, "progress.jsonl"), "utf8")).toBe(progressRaw);
  });

  it("does not backfill canonical session artifacts for legacy runs", async () => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-session-lifecycle-legacy-"));
    const ledger = await createLegacyRunLedgerV2({
      repoRoot: root,
      originalRequest: "Run a legacy workflow",
      now: new Date("2026-07-15T20:34:01.000Z"),
      intake: { task: "Run a legacy workflow", repo_root: root, mode: "local", research: false, reflection: false },
    });
    const progress = await openProgressReporter({ runDir: ledger.runDir, now: () => "2026-07-15T20:34:02.000Z" });
    await expect(runProducingCommand({
      command: "run",
      runDir: ledger.runDir,
      progress,
      action: async () => "legacy-result",
    })).resolves.toBe("legacy-result");

    await expect(lstat(join(ledger.runDir, "session-state.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(join(ledger.runDir, "session-events.jsonl"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readFile(join(ledger.runDir, "progress.jsonl"), "utf8")).trim().split("\n")).toHaveLength(2);
  });

  it("covers the fixed ten-command catalog and classifies successful and blocked results", async () => {
    const seen: string[] = [];
    const outcomes: LifecycleOutcome[] = [];
    for (const command of PRODUCING_COMMANDS) {
      const result = await runProducingCommand({
        command,
        progress: reporter(seen),
        action: async () => command === "resume" ? { status: "human_action_required" } : command === "abandon" ? { status: "failed" } : { status: "ok" },
        classify: (value) => value.status === "human_action_required" ? "blocked" : value.status === "failed" ? "failed" : "successful",
      });
      outcomes.push(result.status === "human_action_required" ? "blocked" : result.status === "failed" ? "failed" : "successful");
    }

    expect(PRODUCING_COMMANDS).toHaveLength(10);
    expect(outcomes).toEqual(PRODUCING_COMMANDS.map((command) => command === "resume" ? "blocked" : command === "abandon" ? "failed" : "successful"));
    expect(seen.filter((event) => event.endsWith(":run")).length).toBe(2);
    expect(seen.filter((event) => event.endsWith(":resume")).length).toBe(2);
    expect(seen).toContain("worker_blocked:resume");
    expect(seen).toContain("role_failed:abandon");
  });

  it("rethrows the exact failure object while containing telemetry and warning failures", async () => {
    const sentinel = new Error("sentinel");
    const emit = vi.fn().mockRejectedValue(new Error("telemetry unavailable"));
    const warning = vi.fn().mockRejectedValue(new Error("warning unavailable"));
    const progress = { ...reporter([]), emit };

    await expect(runProducingCommand({
      command: "run",
      progress,
      onWarning: warning,
      action: async () => { throw sentinel; },
    })).rejects.toBe(sentinel);
    expect(emit).toHaveBeenCalled();
    expect(warning).toHaveBeenCalledTimes(1);
  });

  it("records a failed terminal-work outcome and preserves the callback error", async () => {
    const sentinel = new Error("reflection interrupted");
    const seen: string[] = [];

    await expect(runProducingCommand({
      command: "close-run",
      progress: reporter(seen),
      action: async () => "ready",
      beforeFinalize: async () => { throw sentinel; },
    })).rejects.toBe(sentinel);

    expect(seen).toEqual([
      "worker_started:close-run",
      "worker_completed:close-run",
      "role_failed:close-run",
    ]);
  });

  it("preserves successful workflow results through state and canonical-finalization failures", async () => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-session-lifecycle-faults-"));
    const stateLedger = await createRunLedgerV2({
      repoRoot: root,
      originalRequest: "Contain a session state failure",
      intake: { task: "Contain a session state failure", repo_root: root, mode: "local", research: false, reflection: false },
    });
    const stateWarning = vi.fn();
    const stateFailure = vi.spyOn(SessionStore.prototype, "contribute").mockRejectedValue(new Error("state unavailable"));
    const stateProgress = await openProgressReporter({ runDir: stateLedger.runDir, onWarning: stateWarning });
    const successfulResult = { status: "ok" };

    await expect(runProducingCommand({
      command: "run",
      runDir: stateLedger.runDir,
      progress: stateProgress,
      onWarning: stateWarning,
      action: async () => successfulResult,
    })).resolves.toBe(successfulResult);
    expect(stateFailure).toHaveBeenCalled();
    expect(stateWarning).toHaveBeenCalled();
    stateFailure.mockRestore();

    const finalizationLedger = await createRunLedgerV2({
      repoRoot: root,
      originalRequest: "Contain canonical finalization failure",
      intake: { task: "Contain canonical finalization failure", repo_root: root, mode: "local", research: false, reflection: false },
    });
    const createdAt = (await readManifestV2(finalizationLedger.runDir)).created_at;
    await withRunLedgerTransaction(finalizationLedger.runDir, async (transaction) => {
      await transaction.updateManifestV2({ assurance_outcome: "blocked", delivery_state: "blocked" });
      await transaction.recordTerminalDisposition({
        outcome: "closed_blocked",
        actor: "human",
        reason: "Stop",
        residual_risks: [],
        recorded_at: createdAt,
        source_stage: "intake",
      });
    });
    const invalidCanonicalStream = "not-json\n";
    await writeFile(join(finalizationLedger.runDir, "session-events.jsonl"), invalidCanonicalStream, "utf8");
    const finalizationWarning = vi.fn();
    const finalizationResult = { status: "ready" };

    await expect(runProducingCommand({
      command: "close-run",
      runDir: finalizationLedger.runDir,
      onWarning: finalizationWarning,
      action: async () => finalizationResult,
    })).resolves.toBe(finalizationResult);
    expect(finalizationWarning).toHaveBeenCalledTimes(1);
    expect(await readFile(join(finalizationLedger.runDir, "session-events.jsonl"), "utf8")).toBe(invalidCanonicalStream);
  });

  it("does not replace a terminal-work error when run-directory resolution fails during cleanup", async () => {
    const sentinel = new Error("terminal work failed");
    await expect(runProducingCommand({
      command: "resume",
      runDir: () => { throw sentinel; },
      action: async () => "ready",
    })).rejects.toBe(sentinel);
  });

  it("does not record post-terminal failure telemetry before an interrupted retry", async () => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-session-lifecycle-retry-"));
    const ledger = await createRunLedgerV2({
      repoRoot: root,
      originalRequest: "Retry terminal work",
      intake: { task: "Retry terminal work", repo_root: root, mode: "local", research: false, reflection: false },
    });
    const sentinel = new Error("reflection interrupted");
    const progress = await openProgressReporter({ runDir: ledger.runDir });

    await expect(runProducingCommand({
      command: "close-run",
      runDir: ledger.runDir,
      progress,
      action: async () => "ready",
      beforeFinalize: async () => {
        const manifest = await readManifestV2(ledger.runDir);
        await withRunLedgerTransaction(ledger.runDir, async (transaction) => {
          await transaction.updateManifestV2({ assurance_outcome: "blocked", delivery_state: "blocked" });
          await transaction.recordTerminalDisposition({
            outcome: "closed_blocked",
            actor: "human",
            reason: "Stop",
            residual_risks: [],
            recorded_at: new Date().toISOString(),
            source_stage: manifest.stage,
          });
        });
      },
      reflect: async () => { throw sentinel; },
    })).rejects.toBe(sentinel);

    const progressEvents = [];
    for await (const event of readProgressEvents(ledger.runDir)) progressEvents.push(event);
    expect(progressEvents.some((event) => event.event_key.includes("worker_started"))).toBe(true);
    expect(progressEvents.some((event) => event.event_key.includes("worker_completed"))).toBe(true);
    expect(progressEvents.some((event) => event.event_key.includes("role_failed"))).toBe(false);
    expect(await readFile(join(ledger.runDir, "session-events.jsonl"), "utf8")).toBe("");

    await expect(runProducingCommand({
      command: "close-run",
      runDir: ledger.runDir,
      action: async () => "ready",
      reflect: async () => undefined,
    })).resolves.toBe("ready");

    const raw = await readFile(join(ledger.runDir, "session-events.jsonl"), "utf8");
    expect(raw).not.toBe("");
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw.trimEnd().split("\n")).toHaveLength(1);
    expect(canonicalSessionEventSchema.parse(JSON.parse(raw))).toMatchObject({
      terminal_outcome: "closed_blocked",
      assurance_outcome: "blocked",
    });
  });

  it("finalizes after terminal hooks and keeps repeated concurrent completion idempotent", async () => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-session-lifecycle-"));
    const ledger = await createRunLedgerV2({
      repoRoot: root,
      originalRequest: "Finalize a producing command",
      now: new Date("2026-07-15T20:34:01.000Z"),
      intake: { task: "Finalize a producing command", repo_root: root, mode: "local", research: false, reflection: false },
    });
    const createdAt = (await readManifestV2(ledger.runDir)).created_at;
    await withRunLedgerTransaction(ledger.runDir, async (transaction) => {
      await transaction.updateManifestV2({ assurance_outcome: "blocked", delivery_state: "blocked" });
      await transaction.recordTerminalDisposition({
        outcome: "closed_blocked",
        actor: "human",
        reason: "Stop",
        residual_risks: [],
        recorded_at: createdAt,
        source_stage: "intake",
      });
    });

    const order: string[] = [];
    const finalizeSessionImpl = sessionStore.finalizeSession;
    const finalize = vi.spyOn(sessionStore, "finalizeSession").mockImplementation(async (runDir) => {
      order.push("finalize");
      return finalizeSessionImpl(runDir);
    });
    const input = {
      command: "close-run" as const,
      runDir: ledger.runDir,
      action: async () => ({ status: "human_action_required" }),
      reconcile: async () => { order.push("reconcile"); },
      reflect: async () => { order.push("reflect"); },
      assure: async () => { order.push("assure"); },
    };
    await runProducingCommand(input);
    expect(order).toEqual(["reconcile", "assure", "reflect", "finalize"]);
    finalize.mockRestore();
    const [first, second] = await Promise.all([
      runProducingCommand({ command: "close-run", runDir: ledger.runDir, action: input.action }),
      runProducingCommand({ command: "close-run", runDir: ledger.runDir, action: input.action }),
    ]);
    expect(first).toEqual(second);

    const raw = await readFile(join(ledger.runDir, "session-events.jsonl"), "utf8");
    expect(raw.trim().split("\n")).toHaveLength(1);
    expect(canonicalSessionEventSchema.parse(JSON.parse(raw))).toMatchObject({
      terminal_outcome: "closed_blocked",
      assurance_outcome: "blocked",
    });
  });
});
