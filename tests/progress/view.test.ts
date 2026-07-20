import { describe, expect, it } from "vitest";
import { materializeProgressEvent, type ProgressIntent, type SafeProgressEvent } from "../../src/progress/events.js";
import { createProgressViewReducer } from "../../src/progress/view.js";

const sessionId = "4ed9e32e-5787-4aac-9cb0-a531037d4b64";
const invocationId = "7f05a9d1-7635-4895-88bb-94a56510ca54";
const otherInvocationId = "265d5130-80eb-4a62-8bb1-e1773f30baef";
const workItem = { index: 1, total: 1, attempt: 1, final: false };

function event(intent: ProgressIntent, sequence: number, timestamp = `2026-07-16T20:05:${String(sequence).padStart(2, "0")}.000Z`): SafeProgressEvent {
  return materializeProgressEvent(intent, sequence, timestamp);
}

function heartbeat(sequence: number, overrides: Partial<ProgressIntent> = {}, timestamp?: string): SafeProgressEvent {
  return event({
    code: "heartbeat",
    source: "hands",
    workerSessionId: sessionId,
    heartbeatOrdinal: sequence,
    modelInvocationId: invocationId,
    workItem,
    ...overrides,
  }, sequence, timestamp);
}

describe("progress human-view reducer", () => {
  it("renders one heartbeat as current-state telemetry on flush", async () => {
    const rows: string[] = [];
    const view = createProgressViewReducer({ emit: (row) => { rows.push(row); } });

    await view.push(heartbeat(1, {}, "2026-07-16T20:05:00.000Z"));
    expect(rows).toEqual([]);
    await view.flush();

    expect(rows).toEqual([
      "2026-07-16 20:05:00 UTC  Hands still running (1 heartbeat, last activity 2026-07-16 20:05:00 UTC)",
    ]);
  });

  it("coalesces 100 consecutive heartbeats for one invocation", async () => {
    const rows: string[] = [];
    const view = createProgressViewReducer({ emit: (row) => { rows.push(row); } });

    for (let index = 1; index <= 100; index += 1) {
      await view.push(heartbeat(index, {}, "2026-07-16T20:05:00.000Z"));
    }
    await view.flush();

    expect(rows).toEqual([
      "2026-07-16 20:05:00 UTC  Hands still running (100 heartbeats, last activity 2026-07-16 20:05:00 UTC)",
    ]);
  });

  it("flushes heartbeats when the invocation key changes or a state transition arrives", async () => {
    const rows: string[] = [];
    const view = createProgressViewReducer({ emit: (row) => { rows.push(row); } });

    await view.push(heartbeat(1));
    await view.push(heartbeat(2, { modelInvocationId: otherInvocationId }));
    await view.push(event({ code: "hands_turn_completed", source: "hands", workItem }, 3));
    await view.flush();

    expect(rows).toEqual([
      expect.stringContaining("(1 heartbeat, last activity"),
      expect.stringContaining("(1 heartbeat, last activity"),
      expect.stringContaining("Hands turn completed"),
    ]);
  });

  it("deduplicates identical progress warnings but preserves distinct fingerprints", async () => {
    const rows: string[] = [];
    const view = createProgressViewReducer({ emit: (row) => { rows.push(row); } });

    await view.push(event({ code: "progress_warning", source: "hands", modelInvocationId: invocationId, warningKind: "malformed_record" }, 1));
    await view.push(event({ code: "progress_warning", source: "hands", modelInvocationId: invocationId, warningKind: "malformed_record" }, 2));
    await view.push(event({ code: "progress_warning", source: "hands", modelInvocationId: invocationId, warningKind: "oversized_record" }, 3));
    await view.flush();

    expect(rows).toEqual([
      "2026-07-16 20:05:02 UTC  Skipped an unreadable progress event (2 identical warnings)",
      "2026-07-16 20:05:03 UTC  Skipped an unreadable progress event",
    ]);
  });

  it("labels model item errors as non-terminal provider progress", async () => {
    const rows: string[] = [];
    const view = createProgressViewReducer({ emit: (row) => { rows.push(row); } });

    await view.push(event({ code: "progress_warning", source: "verifier", modelInvocationId: invocationId, warningKind: "item_error" }, 1));
    await view.flush();

    expect(rows).toEqual([
      "2026-07-16 20:05:01 UTC  Model progress reported a non-terminal item error",
    ]);
  });

  it("emits human rows incrementally when follow receives a transition", async () => {
    const rows: string[] = [];
    const view = createProgressViewReducer({ emit: (row) => { rows.push(row); } });

    await view.push(heartbeat(1));
    await view.push(event({ code: "hands_turn_completed", source: "hands", workItem }, 2));

    expect(rows).toEqual([
      expect.stringContaining("(1 heartbeat, last activity"),
      expect.stringContaining("Hands turn completed"),
    ]);
  });
});
