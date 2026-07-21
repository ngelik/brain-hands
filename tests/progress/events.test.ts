import { describe, expect, it } from "vitest";
import {
  materializeProgressEvent,
  safeModelLabel,
  safeProgressEventSchema,
  safeToolLabel,
} from "../../src/progress/events.js";

describe("safe progress events", () => {
  it("materializes a fixed Hands label and safe worker metadata", () => {
    const event = materializeProgressEvent({
      code: "hands_started",
      source: "hands",
      model: "gpt-5.6-luna",
      reasoningEffort: "xhigh",
      workerSessionId: "4ed9e32e-5787-4aac-9cb0-a531037d4b64",
      workerPid: 36551,
      childPid: 36562,
      workItem: { index: 1, total: 3, attempt: 2, final: false },
    }, 7, "2026-07-11T20:00:00.000Z");

    expect(event).toMatchObject({
      schema_version: 1,
      sequence: 7,
      event_key: "hands:hands_started:item:1:attempt:2:final:false:session:4ed9e32e-5787-4aac-9cb0-a531037d4b64",
      safe_label: "Hands started - gpt-5.6-luna/xhigh",
      model: "gpt-5.6-luna",
      reasoning_effort: "xhigh",
      worker_session_id: "4ed9e32e-5787-4aac-9cb0-a531037d4b64",
      worker_pid: 36551,
      child_pid: 36562,
    });
    expect(safeProgressEventSchema.parse(event)).toEqual(event);
  });

  it("gives every heartbeat a session-local durable identity", () => {
    const base = {
      code: "heartbeat" as const,
      source: "hands" as const,
      workerSessionId: "4ed9e32e-5787-4aac-9cb0-a531037d4b64",
      workerPid: 36551,
      childPid: 36562,
      workItem: { index: 1, total: 1, attempt: 1, final: false },
    };
    const first = materializeProgressEvent({ ...base, heartbeatOrdinal: 1 }, 2, "2026-07-11T20:00:45.000Z");
    const second = materializeProgressEvent({ ...base, heartbeatOrdinal: 2 }, 3, "2026-07-11T20:01:30.000Z");

    expect(first.event_key).not.toBe(second.event_key);
    expect(first.safe_label).toBe("Hands is still running");
  });

  it("renders reviewer-action namespaces as readable progress coordinates", () => {
    const fix = materializeProgressEvent({
      code: "work_item_fix",
      source: "hands",
      workItem: { index: 5, total: 5, attempt: 28_000_101, final: false },
    }, 1, "2026-07-11T20:00:00.000Z");
    const verification = materializeProgressEvent({
      code: "verification_started",
      source: "verification",
      workItem: { index: 5, total: 5, attempt: 28_000_102, final: false },
    }, 2, "2026-07-11T20:01:00.000Z");

    expect(fix.safe_label).toBe("Work item 5 of 5 - fix review 28, action 1, attempt 1");
    expect(verification.safe_label).toBe("Verification started - review 28, action 1, attempt 2");
    expect(safeProgressEventSchema.parse({
      ...fix,
      safe_label: "Work item 5 of 5 - fix attempt 28000101",
    })).toMatchObject({ safe_label: "Work item 5 of 5 - fix attempt 28000101" });
  });

  it("keeps retries in one worker session distinct by model invocation", () => {
    const base = {
      code: "brain_turn_completed" as const,
      source: "brain" as const,
      workerSessionId: "4ed9e32e-5787-4aac-9cb0-a531037d4b64",
    };
    const first = materializeProgressEvent({ ...base, modelInvocationId: "1939c335-f3b6-42db-a561-91d6c8d3da2a" }, 1, "2026-07-11T20:00:00.000Z");
    const retry = materializeProgressEvent({ ...base, modelInvocationId: "775a6924-1fc1-4187-8cbf-4aeda1d047ba" }, 2, "2026-07-11T20:01:00.000Z");

    expect(first.event_key).not.toBe(retry.event_key);
    expect(safeProgressEventSchema.parse(first)).toEqual(first);
    expect(safeProgressEventSchema.parse(retry)).toEqual(retry);
  });

  it("falls back for unsafe dynamic labels", () => {
    expect(safeModelLabel("token=sk-secret value")).toBe("configured model");
    expect(safeToolLabel("/repo/private-deploy.sh")).toBe("command");
    expect(safeToolLabel("/usr/local/bin/npm")).toBe("npm");
  });

  it("does not accept caller-provided labels or extra payload", () => {
    expect(() => safeProgressEventSchema.parse({
      schema_version: 1,
      sequence: 1,
      event_key: "unsafe",
      timestamp: new Date().toISOString(),
      source: "hands",
      phase: "implementation",
      status: "in_progress",
      safe_label: "secret",
      raw: "sk-secret",
    })).toThrow();
  });

  it("rejects a structurally valid event whose catalog-owned fields were tampered with", () => {
    const event = materializeProgressEvent({
      code: "planning_started",
      source: "brain",
    }, 1, "2026-07-11T20:00:00.000Z");

    expect(() => safeProgressEventSchema.parse({
      ...event,
      safe_label: "token=sk-secret",
    })).toThrow();
    expect(() => safeProgressEventSchema.parse({
      ...event,
      event_key: "brain:planning_started:tampered",
    })).toThrow();
  });

  it("keeps durable boundary keys stable across worker sessions", () => {
    const first = materializeProgressEvent({
      code: "plan_ready",
      source: "brain",
      revision: 1,
      workerSessionId: "4ed9e32e-5787-4aac-9cb0-a531037d4b64",
    }, 1, "2026-07-11T20:00:00.000Z");
    const resumed = materializeProgressEvent({
      code: "plan_ready",
      source: "brain",
      revision: 1,
      workerSessionId: "1d2a0da4-0754-4f9a-85b1-2b2b68421f65",
    }, 2, "2026-07-11T20:01:00.000Z");

    expect(resumed.event_key).toBe(first.event_key);
  });

  it("materializes only fixed content-free discovery progress labels", () => {
    const started = materializeProgressEvent({
      code: "discovery_started",
      source: "brain",
    }, 1, "2026-07-11T20:00:00.000Z");
    const question = materializeProgressEvent({
      code: "discovery_question_ready",
      source: "brain",
      discoveryCycle: 2,
      questionSequence: 3,
    }, 2, "2026-07-11T20:01:00.000Z");
    const brief = materializeProgressEvent({
      code: "discovery_brief_ready",
      source: "brain",
      revision: 2,
    }, 3, "2026-07-11T20:02:00.000Z");
    const approved = materializeProgressEvent({
      code: "discovery_brief_approved",
      source: "brain",
      revision: 2,
    }, 4, "2026-07-11T20:03:00.000Z");

    expect([started, question, brief, approved].map((event) => event.safe_label)).toEqual([
      "Discovery started",
      "Discovery question ready",
      "Discovery brief ready",
      "Discovery brief approved",
    ]);
    expect(JSON.stringify([started, question, brief, approved])).not.toContain("PRIVATE-DISCOVERY-MARKER");
    expect(question.event_key).toBe("brain:discovery_question_ready:cycle:2:question:3");
    expect(brief.event_key).toBe("brain:discovery_brief_ready:revision:2");
    expect(approved.event_key).toBe("brain:discovery_brief_approved:revision:2");
  });

  it.each(["discovery_brief_ready", "discovery_brief_approved"] as const)(
    "requires a positive numeric revision for %s",
    (code) => {
      expect(() => materializeProgressEvent({ code, source: "brain" }, 1, "2026-07-11T20:00:00.000Z"))
        .toThrow(`Progress code ${code} requires a revision`);
      expect(() => materializeProgressEvent({ code, source: "brain", revision: 0 }, 1, "2026-07-11T20:00:00.000Z"))
        .toThrow(`Progress code ${code} requires a revision`);
    },
  );

  it("requires positive cycle and sequence coordinates for discovery questions", () => {
    expect(() => materializeProgressEvent({
      code: "discovery_question_ready",
      source: "brain",
    }, 1, "2026-07-11T20:00:00.000Z")).toThrow("requires cycle and question sequence");
  });

  it("reports a completed worker in the delivery phase", () => {
    const event = materializeProgressEvent({
      code: "worker_completed",
      source: "runtime",
      workerSessionId: "4ed9e32e-5787-4aac-9cb0-a531037d4b64",
    }, 1, "2026-07-11T20:00:00.000Z");

    expect(event.phase).toBe("delivery");
  });

  it("rejects progress codes emitted by the wrong source", () => {
    expect(() => materializeProgressEvent({
      code: "planning_started",
      source: "hands",
    }, 1, "2026-07-11T20:00:00.000Z")).toThrow("does not allow source hands");

    const event = materializeProgressEvent({
      code: "planning_started",
      source: "brain",
    }, 1, "2026-07-11T20:00:00.000Z");
    expect(() => safeProgressEventSchema.parse({
      ...event,
      source: "hands",
      event_key: event.event_key.replace(/^brain:/, "hands:"),
    })).toThrow();
  });

  it("gives each final Verifier invocation a session-local start identity", () => {
    const base = {
      code: "final_verifier_started" as const,
      source: "verifier" as const,
      model: "gpt-5.6",
      reasoningEffort: "high" as const,
      workItem: { index: 2, total: 2, attempt: 1, final: true },
    };
    const first = materializeProgressEvent({
      ...base,
      workerSessionId: "4ed9e32e-5787-4aac-9cb0-a531037d4b64",
    }, 1, "2026-07-11T20:00:00.000Z");
    const resumed = materializeProgressEvent({
      ...base,
      workerSessionId: "1d2a0da4-0754-4f9a-85b1-2b2b68421f65",
    }, 2, "2026-07-11T20:01:00.000Z");

    expect(resumed.event_key).not.toBe(first.event_key);
    expect(() => safeProgressEventSchema.parse({
      ...first,
      model: undefined,
      reasoning_effort: undefined,
    })).toThrow();
  });
});
