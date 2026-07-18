import { describe, expect, it } from "vitest";
import {
  canonicalSessionEventSchema,
  contributeProgressToSession,
  createActiveSessionState,
  finalizeSessionState,
  materializeCanonicalSessionEvent,
  sessionCommandCountsSchema,
  sessionInvocationCountsSchema,
  sessionSourceCountsSchema,
  sessionStateSchema,
  sessionStatusCountsSchema,
  sessionTokenTotalsSchema,
  SESSION_COMMAND_KEYS,
  SESSION_INVOCATION_KEYS,
  SESSION_SOURCE_KEYS,
  SESSION_STATUS_KEYS,
  SESSION_TOKEN_KEYS,
  type CanonicalSessionEvent,
  type SessionState,
} from "../../src/progress/session-events.js";
import { materializeProgressEvent } from "../../src/progress/events.js";

const runId = "2026-07-15T20-34-01-673Z-session-test";
const createdAt = "2026-07-15T20:34:01.000Z";
const terminalAt = "2026-07-15T20:34:02.000Z";
const sessionId = "4ed9e32e-5787-4aac-9cb0-a531037d4b64";
const eventId = "78d55bed-1287-4d1e-8917-f4c412df1377";

function active(): SessionState {
  return createActiveSessionState({ runId, sessionId, canonicalEventId: eventId, createdAt });
}

function finalized(): SessionState {
  return finalizeSessionState(active(), {
    outcome: "delivered",
    actor: "runtime",
    recorded_at: terminalAt,
    source_stage: "delivery",
  }, "verified_ready");
}

function event(): CanonicalSessionEvent {
  return materializeCanonicalSessionEvent(finalized());
}

function without<T extends object>(value: T, key: string): Record<string, unknown> {
  const copy = { ...value } as Record<string, unknown>;
  delete copy[key];
  return copy;
}

const stateFields = Object.keys(active());
const eventFields = Object.keys(event());
const stateMaps = [
  ["command_counts", sessionCommandCountsSchema, SESSION_COMMAND_KEYS],
  ["invocation_counts", sessionInvocationCountsSchema, SESSION_INVOCATION_KEYS],
  ["status_counts", sessionStatusCountsSchema, SESSION_STATUS_KEYS],
  ["source_counts", sessionSourceCountsSchema, SESSION_SOURCE_KEYS],
  ["token_totals", sessionTokenTotalsSchema, SESSION_TOKEN_KEYS],
] as const;

describe("durable session schemas", () => {
  it.each(stateFields)("rejects a state missing top-level field %s", (field) => {
    expect(() => sessionStateSchema.parse(without(active(), field))).toThrow();
  });

  it.each(eventFields)("rejects an event missing top-level field %s", (field) => {
    expect(() => canonicalSessionEventSchema.parse(without(event(), field))).toThrow();
  });

  it("rejects unknown top-level fields and unsupported versions in both schemas", () => {
    expect(() => sessionStateSchema.parse({ ...active(), extra: "prompt text" })).toThrow();
    expect(() => canonicalSessionEventSchema.parse({ ...event(), extra: "model output" })).toThrow();
    expect(() => sessionStateSchema.parse({ ...active(), schema_version: 2 })).toThrow();
    expect(() => canonicalSessionEventSchema.parse({ ...event(), schema_version: 2 })).toThrow();
  });

  it.each([
    ["state session_id", active(), sessionStateSchema, { session_id: "not-a-uuid" }],
    ["state canonical_event_id", active(), sessionStateSchema, { canonical_event_id: "not-a-uuid" }],
    ["event event_id", event(), canonicalSessionEventSchema, { event_id: "not-a-uuid" }],
    ["event session_id", event(), canonicalSessionEventSchema, { session_id: "not-a-uuid" }],
  ] as const)("rejects invalid UUID identity %s", (_label, value, schema, patch) => {
    expect(() => schema.parse({ ...value, ...patch })).toThrow();
  });

  it.each([
    "not-a-run",
    "2026-07-15T20:34:01.000Z-session-test",
    "2026-99-99T99-99-99-999Z-session-test",
    "2026-07-15T20-34-01-673Z-bad slug",
    "2026-07-15T20-34-01-673Z-_bad",
  ])("rejects noncanonical run id %s", (invalidRunId) => {
    expect(() => sessionStateSchema.parse({ ...active(), run_id: invalidRunId })).toThrow();
    expect(() => canonicalSessionEventSchema.parse({ ...event(), run_id: invalidRunId })).toThrow();
  });

  it.each([
    ["state created_at", { created_at: "2026-07-15T20:34:01Z" }],
    ["state updated_at", { updated_at: "2026-07-15T20:34:01Z" }],
    ["event created_at", { created_at: "2026-07-15T20:34:01Z" }],
    ["event timestamp", { timestamp: "2026-07-15T20:34:02Z" }],
    ["state terminal recorded_at", { terminal_provenance: { ...finalized().terminal_provenance!, recorded_at: "2026-07-15T20:34:02Z" } }],
  ] as const)("rejects noncanonical timestamp %s", (label, patch) => {
    if (label.startsWith("state")) expect(() => sessionStateSchema.parse({ ...finalized(), ...patch })).toThrow();
    else expect(() => canonicalSessionEventSchema.parse({ ...event(), ...patch })).toThrow();
  });

  it("rejects unordered and mismatched state chronology", () => {
    expect(() => sessionStateSchema.parse({ ...active(), updated_at: "2026-07-15T20:34:00.000Z" })).toThrow();
    expect(() => sessionStateSchema.parse({ ...active(), updated_at: terminalAt, duration_ms: 0 })).toThrow();
    expect(() => sessionStateSchema.parse({
      ...finalized(),
      terminal_provenance: { ...finalized().terminal_provenance!, recorded_at: "2026-07-15T20:34:01.000Z" },
    })).toThrow();
  });

  it("rejects unordered and mismatched canonical-event chronology", () => {
    expect(() => canonicalSessionEventSchema.parse({ ...event(), timestamp: createdAt, duration_ms: 0 })).toThrow();
    expect(() => canonicalSessionEventSchema.parse({ ...event(), duration_ms: 0 })).toThrow();
    expect(() => canonicalSessionEventSchema.parse({ ...event(), created_at: "2026-07-15T20:34:04.000Z", duration_ms: 0 })).toThrow();
  });

  it.each([
    ["state terminal_outcome", { terminal_outcome: "not-supported" }],
    ["state assurance_outcome", { assurance_outcome: "not-supported" }],
    ["state actor", { terminal_provenance: { ...finalized().terminal_provenance!, actor: "operator" } }],
    ["state source_stage", { terminal_provenance: { ...finalized().terminal_provenance!, source_stage: "unknown-stage" } }],
    ["event terminal_outcome", { terminal_outcome: "not-supported" }],
    ["event assurance_outcome", { assurance_outcome: "not-supported" }],
    ["event actor", { terminal_provenance: { ...event().terminal_provenance, actor: "operator" } }],
    ["event source_stage", { terminal_provenance: { ...event().terminal_provenance, source_stage: "unknown-stage" } }],
  ] as const)("rejects unsupported catalog value %s", (label, patch) => {
    if (label.startsWith("state")) expect(() => sessionStateSchema.parse({ ...finalized(), ...patch })).toThrow();
    else expect(() => canonicalSessionEventSchema.parse({ ...event(), ...patch })).toThrow();
  });

  it.each([
    ["terminal only", { terminal_outcome: "delivered", assurance_outcome: null }],
    ["assurance only", { terminal_outcome: null, assurance_outcome: "verified_ready" }],
  ] as const)("rejects the %s half-final state", (_label, patch) => {
    expect(() => sessionStateSchema.parse({ ...active(), ...patch })).toThrow();
  });

  it("accepts active and fully finalized states", () => {
    expect(sessionStateSchema.parse(active())).toEqual(active());
    expect(sessionStateSchema.parse(finalized())).toEqual(finalized());
    expect(canonicalSessionEventSchema.parse(event())).toEqual(event());
  });

  it.each(stateMaps)("requires every fixed state aggregate key in %s", (name, schema, keys) => {
    const base = active()[name];
    for (const key of keys) {
      const missing = { ...base } as Record<string, unknown>;
      delete missing[key];
      expect(() => schema.parse(missing)).toThrow();
      expect(() => schema.parse({ ...base, extra: 0 })).toThrow();
    }
  });

  it.each(stateMaps)("requires every fixed event aggregate key in %s", (name, schema, keys) => {
    const base = event()[name];
    for (const key of keys) {
      const missing = { ...base } as Record<string, unknown>;
      delete missing[key];
      expect(() => schema.parse(missing)).toThrow();
      expect(() => schema.parse({ ...base, extra: 0 })).toThrow();
    }
  });

  it.each(stateMaps)("rejects invalid fixed aggregate values in %s", (name, schema) => {
    const base = active()[name];
    for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN]) {
      expect(() => schema.parse({ ...base, [Object.keys(base)[0]!]: value })).toThrow();
    }
  });

  it.each(stateMaps)("rejects invalid fixed event aggregate values in %s", (name, schema) => {
    const base = event()[name];
    for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN]) {
      expect(() => schema.parse({ ...base, [Object.keys(base)[0]!]: value })).toThrow();
    }
  });

  it.each([
    ["state terminal_provenance", finalized().terminal_provenance],
    ["event terminal_provenance", event().terminal_provenance],
  ] as const)("rejects unknown or missing nested provenance fields in %s", (label, provenance) => {
    const schemaValue = { ...provenance, extra: "secret" };
    const missing = { ...provenance } as Record<string, unknown>;
    delete missing.actor;
    if (label.startsWith("state")) {
      expect(() => sessionStateSchema.parse({ ...finalized(), terminal_provenance: schemaValue })).toThrow();
      expect(() => sessionStateSchema.parse({ ...finalized(), terminal_provenance: missing })).toThrow();
    } else {
      expect(() => canonicalSessionEventSchema.parse({ ...event(), terminal_provenance: schemaValue })).toThrow();
      expect(() => canonicalSessionEventSchema.parse({ ...event(), terminal_provenance: missing })).toThrow();
    }
  });

  it.each([
    ["command", { operation: { index: 1, total: 1, kind: "command" } }],
    ["invocation", {}],
    ["status", {}],
    ["source", {}],
    ["input_tokens", { usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 } }],
    ["cached_input_tokens", { usage: { input_tokens: 0, cached_input_tokens: 1, output_tokens: 0, reasoning_output_tokens: 0 } }],
    ["output_tokens", { usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } }],
    ["reasoning_output_tokens", { usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 1 } }],
  ] as const)("rejects aggregate overflow for %s", (name, metadata) => {
    const state = active();
    if (name === "command") state.command_counts.command = Number.MAX_SAFE_INTEGER;
    if (name === "invocation") state.invocation_counts.brain = Number.MAX_SAFE_INTEGER;
    if (name === "status") state.status_counts.started = Number.MAX_SAFE_INTEGER;
    if (name === "source") state.source_counts.brain = Number.MAX_SAFE_INTEGER;
    if (name.endsWith("tokens")) state.token_totals[name as keyof typeof state.token_totals] = Number.MAX_SAFE_INTEGER;
    const code = name === "command" ? "verification_command_started" : name === "invocation" ? "brain_started" : "planning_started";
    const source = name === "invocation" ? "brain" : name === "source" ? "brain" : name === "command" ? "verification" : "brain";
    const progress = materializeProgressEvent({
      code,
      source,
      ...(name === "command" ? {
        workItem: { index: 1, total: 1, attempt: 1, final: false },
        operation: { index: 1, total: 1, kind: "command" as const },
      } : {}),
      ...(name === "invocation" ? { model: "model", reasoningEffort: "high" as const } : {}),
      ...(name.endsWith("tokens") ? metadata : {}),
    }, 1, terminalAt);
    expect(() => contributeProgressToSession(state, progress)).toThrow("overflow");
  });

  it("materializes only fixed aggregate and provenance content", () => {
    const progress = materializeProgressEvent({
      code: "planning_started",
      source: "brain",
      model: "model-name",
      workerSessionId: sessionId,
    }, 1, createdAt);
    const contributed = contributeProgressToSession(active(), progress);
    const canonical = materializeCanonicalSessionEvent(finalized());
    expect(contributed).not.toHaveProperty("safe_label");
    expect(JSON.stringify(contributed)).not.toContain("model-name");
    expect(JSON.stringify(contributed)).not.toContain("Planning started");
    expect(Object.keys(canonical).sort()).toEqual([
      "assurance_outcome", "command_counts", "created_at", "duration_ms", "event_id", "event_type",
      "invocation_counts", "run_id", "schema_version", "session_id", "source_counts", "status_counts",
      "terminal_outcome", "terminal_provenance", "timestamp", "token_totals",
    ].sort());
  });
});
