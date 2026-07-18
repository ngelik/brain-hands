import { z } from "zod";
import type { RunStageV2, TerminalOutcome, AssuranceOutcome } from "../core/types.js";
import { safeProgressEventSchema, type SafeProgressEvent } from "./events.js";

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

function safeNonnegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function safeDuration(value: number): boolean {
  return safeNonnegativeInteger(value);
}

const canonicalTimestampSchema = z.string().refine((value) => {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}, "Timestamp must be a canonical UTC ISO timestamp");

/** Run ids emitted by the ledger are timestamped ids followed by a safe slug. */
export const canonicalRunIdSchema = z.string().superRefine((value, context) => {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)-([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(value);
  if (!match) {
    context.addIssue({ code: "custom", message: "Run id is not canonical" });
    return;
  }
  const timestamp = match[1]!.replace(
    /T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/,
    "T$1:$2:$3.$4Z",
  );
  if (!canonicalTimestampSchema.safeParse(timestamp).success) {
    context.addIssue({ code: "custom", message: "Run id timestamp is not canonical" });
  }
});

const commandKeys = ["command", "browser_check", "artifact_check", "commit", "push"] as const;
const invocationKeys = ["brain", "hands", "verifier", "reflection"] as const;
const statusKeys = ["started", "in_progress", "completed", "warning", "failed"] as const;
const sourceKeys = ["brain", "hands", "verification", "verifier", "runtime", "github", "reflection"] as const;
const tokenKeys = ["input_tokens", "cached_input_tokens", "output_tokens", "reasoning_output_tokens"] as const;

type FixedKeys<T extends readonly string[]> = { [K in T[number]]: number };

function fixedCounterSchema<const T extends readonly string[]>(keys: T) {
  return z.object(Object.fromEntries(keys.map((key) => [key, z.number().refine(safeNonnegativeInteger, "Counter must be a safe nonnegative integer")])) as unknown as Record<T[number], z.ZodType<number>>).strict() as z.ZodObject<{ [K in T[number]]: z.ZodType<number> }>;
}

export const sessionCommandCountsSchema = fixedCounterSchema(commandKeys);
export const sessionInvocationCountsSchema = fixedCounterSchema(invocationKeys);
export const sessionStatusCountsSchema = fixedCounterSchema(statusKeys);
export const sessionSourceCountsSchema = fixedCounterSchema(sourceKeys);
export const sessionTokenTotalsSchema = fixedCounterSchema(tokenKeys);

export const SESSION_COMMAND_KEYS = commandKeys;
export const SESSION_INVOCATION_KEYS = invocationKeys;
export const SESSION_STATUS_KEYS = statusKeys;
export const SESSION_SOURCE_KEYS = sourceKeys;
export const SESSION_TOKEN_KEYS = tokenKeys;

const terminalOutcomeSchema = z.enum(["delivered", "human_accepted", "abandoned", "closed_blocked"]);
const assuranceOutcomeSchema = z.enum(["verified_ready", "human_accepted", "blocked", "abandoned"]);
const terminalActorSchema = z.enum(["runtime", "human"]);
const runStageSchema = z.enum([
  "intake", "preflight", "brain_discovery", "awaiting_discovery_answer", "awaiting_discovery_approach",
  "awaiting_discovery_brief_approval", "brain_planning", "awaiting_plan_approval", "worktree_setup",
  "github_issue_sync", "implementing", "verifying", "verifier_review", "fixing", "replanning",
  "final_verification", "delivery", "reflecting", "complete",
]);

export const terminalProvenanceSchema = z.object({
  actor: terminalActorSchema,
  recorded_at: canonicalTimestampSchema,
  source_stage: runStageSchema,
}).strict();

type TerminalProvenance = {
  actor: "runtime" | "human";
  recorded_at: string;
  source_stage: RunStageV2;
};

const sessionFields = {
  schema_version: z.literal(1),
  session_id: z.string().uuid(),
  canonical_event_id: z.string().uuid(),
  run_id: canonicalRunIdSchema,
  created_at: canonicalTimestampSchema,
  updated_at: canonicalTimestampSchema,
  duration_ms: z.number().refine(safeDuration, "Duration must be a safe nonnegative integer"),
  command_counts: sessionCommandCountsSchema,
  invocation_counts: sessionInvocationCountsSchema,
  status_counts: sessionStatusCountsSchema,
  source_counts: sessionSourceCountsSchema,
  token_totals: sessionTokenTotalsSchema,
  terminal_outcome: terminalOutcomeSchema.nullable(),
  assurance_outcome: assuranceOutcomeSchema.nullable(),
  terminal_provenance: terminalProvenanceSchema.nullable(),
} as const;

function validateOrderedTimes(
  createdAt: string,
  updatedAt: string,
  durationMs: number,
  addIssue: (message: string) => void,
): void {
  const created = Date.parse(createdAt);
  const updated = Date.parse(updatedAt);
  if (updated < created) addIssue("updated_at must not precede created_at");
  const expected = updated - created;
  if (!Number.isSafeInteger(expected) || expected < 0) addIssue("Timestamp duration overflows or is negative");
  else if (durationMs !== expected) addIssue("duration_ms does not match timestamps");
}

function validateTerminalPair(value: {
  terminal_outcome: TerminalOutcome | null;
  assurance_outcome: AssuranceOutcome | null;
  terminal_provenance: TerminalProvenance | null;
}, addIssue: (message: string) => void): void {
  const terminalPopulated = value.terminal_outcome !== null;
  const assurancePopulated = value.assurance_outcome !== null;
  if (terminalPopulated !== assurancePopulated) {
    addIssue("terminal_outcome and assurance_outcome must be populated together");
  }
  if (!terminalPopulated && value.terminal_provenance !== null) {
    addIssue("Active sessions cannot contain terminal provenance");
  }
  if (terminalPopulated && value.terminal_provenance === null) {
    addIssue("Finalized sessions require terminal provenance");
  }
  if (value.terminal_provenance && value.terminal_provenance.recorded_at === "") {
    addIssue("Terminal provenance is invalid");
  }
}

export const sessionStateSchema = z.object(sessionFields).strict().superRefine((value, context) => {
  validateOrderedTimes(value.created_at, value.updated_at, value.duration_ms, (message) => {
    context.addIssue({ code: "custom", path: ["updated_at"], message });
  });
  validateTerminalPair(value, (message) => {
    context.addIssue({ code: "custom", path: ["terminal_outcome"], message });
  });
  if (value.terminal_provenance && Date.parse(value.terminal_provenance.recorded_at) !== Date.parse(value.updated_at)) {
    context.addIssue({ code: "custom", path: ["terminal_provenance", "recorded_at"], message: "Terminal timestamp must equal updated_at" });
  }
});

export type SessionState = z.infer<typeof sessionStateSchema>;

export const canonicalSessionEventSchema = z.object({
  schema_version: z.literal(1),
  event_id: z.string().uuid(),
  event_type: z.literal("session_finalized"),
  session_id: z.string().uuid(),
  run_id: canonicalRunIdSchema,
  created_at: canonicalTimestampSchema,
  timestamp: canonicalTimestampSchema,
  duration_ms: z.number().refine(safeDuration, "Duration must be a safe nonnegative integer"),
  command_counts: sessionCommandCountsSchema,
  invocation_counts: sessionInvocationCountsSchema,
  status_counts: sessionStatusCountsSchema,
  source_counts: sessionSourceCountsSchema,
  token_totals: sessionTokenTotalsSchema,
  terminal_outcome: terminalOutcomeSchema,
  assurance_outcome: assuranceOutcomeSchema,
  terminal_provenance: terminalProvenanceSchema,
}).strict().superRefine((value, context) => {
  const created = Date.parse(value.created_at);
  const timestamp = Date.parse(value.timestamp);
  const expectedDuration = timestamp - created;
  if (timestamp < created) {
    context.addIssue({ code: "custom", path: ["timestamp"], message: "Event timestamp must not precede session start" });
  }
  if (!Number.isSafeInteger(expectedDuration) || expectedDuration < 0) {
    context.addIssue({ code: "custom", path: ["duration_ms"], message: "Event duration overflows or is negative" });
  } else if (value.duration_ms !== expectedDuration) {
    context.addIssue({ code: "custom", path: ["duration_ms"], message: "Event duration does not match session timestamps" });
  }
  if (Date.parse(value.timestamp) < Date.parse(value.terminal_provenance.recorded_at)) {
    context.addIssue({ code: "custom", path: ["timestamp"], message: "Event timestamp must not precede terminal provenance" });
  }
  if (value.timestamp !== value.terminal_provenance.recorded_at) {
    context.addIssue({ code: "custom", path: ["timestamp"], message: "Event timestamp must equal terminal provenance timestamp" });
  }
});

export type CanonicalSessionEvent = z.infer<typeof canonicalSessionEventSchema>;

function zeroCounters<const T extends readonly string[]>(keys: T): FixedKeys<T> {
  return Object.fromEntries(keys.map((key) => [key, 0])) as FixedKeys<T>;
}

export function createActiveSessionState(input: {
  runId: string;
  sessionId: string;
  canonicalEventId: string;
  createdAt: string;
}): SessionState {
  return sessionStateSchema.parse({
    schema_version: 1,
    session_id: input.sessionId,
    canonical_event_id: input.canonicalEventId,
    run_id: input.runId,
    created_at: input.createdAt,
    updated_at: input.createdAt,
    duration_ms: 0,
    command_counts: zeroCounters(commandKeys),
    invocation_counts: zeroCounters(invocationKeys),
    status_counts: zeroCounters(statusKeys),
    source_counts: zeroCounters(sourceKeys),
    token_totals: zeroCounters(tokenKeys),
    terminal_outcome: null,
    assurance_outcome: null,
    terminal_provenance: null,
  });
}

function addSafe(left: number, right: number): number {
  if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right) || left < 0 || right < 0 || left > MAX_SAFE - right) {
    throw new Error("Session aggregate overflow");
  }
  return left + right;
}

function increment<T extends Record<string, number>>(map: T, key: keyof T): T {
  return { ...map, [key]: addSafe(map[key], 1) } as T;
}

function invocationFor(event: SafeProgressEvent): keyof FixedKeys<typeof invocationKeys> | null {
  if (event.event_key.startsWith("brain:brain_started")) return "brain";
  if (event.event_key.startsWith("hands:hands_started")) return "hands";
  if (event.event_key.startsWith("verifier:verifier_started") || event.event_key.startsWith("verifier:final_verifier_started")) return "verifier";
  if (event.event_key.startsWith("reflection:reflection_started")) return "reflection";
  return null;
}

export function contributeProgressToSession(stateInput: SessionState, eventInput: SafeProgressEvent): SessionState {
  const state = sessionStateSchema.parse(stateInput);
  const event = safeProgressEventSchema.parse(eventInput);
  if (state.terminal_outcome !== null || state.assurance_outcome !== null) {
    throw new Error("Finalized session state cannot receive progress");
  }
  const eventTime = Date.parse(event.timestamp);
  const priorTime = Date.parse(state.updated_at);
  if (eventTime < priorTime) throw new Error("Session event timestamps must be ordered");
  if (event.operation?.duration_ms !== undefined && !safeDuration(event.operation.duration_ms)) {
    throw new Error("Progress operation duration must be a safe nonnegative integer");
  }
  const command = event.operation?.kind;
  const nextCommandCounts = command ? increment(state.command_counts, command) : state.command_counts;
  const invocation = invocationFor(event);
  const nextInvocationCounts = invocation ? increment(state.invocation_counts, invocation) : state.invocation_counts;
  const nextStatusCounts = increment(state.status_counts, event.status);
  const nextSourceCounts = increment(state.source_counts, event.source);
  const usage = event.usage ?? { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 };
  const nextTokens = {
    input_tokens: addSafe(state.token_totals.input_tokens, usage.input_tokens),
    cached_input_tokens: addSafe(state.token_totals.cached_input_tokens, usage.cached_input_tokens),
    output_tokens: addSafe(state.token_totals.output_tokens, usage.output_tokens),
    reasoning_output_tokens: addSafe(state.token_totals.reasoning_output_tokens, usage.reasoning_output_tokens),
  };
  return sessionStateSchema.parse({
    ...state,
    updated_at: event.timestamp,
    duration_ms: eventTime - Date.parse(state.created_at),
    command_counts: nextCommandCounts,
    invocation_counts: nextInvocationCounts,
    status_counts: nextStatusCounts,
    source_counts: nextSourceCounts,
    token_totals: nextTokens,
  });
}

export function finalizeSessionState(
  stateInput: SessionState,
  terminal: { outcome: TerminalOutcome; actor: "runtime" | "human"; recorded_at: string; source_stage: RunStageV2 },
  assuranceOutcome: AssuranceOutcome,
): SessionState {
  const state = sessionStateSchema.parse(stateInput);
  if (state.terminal_outcome !== null || state.assurance_outcome !== null) return state;
  const recordedAt = canonicalTimestampSchema.parse(terminal.recorded_at);
  if (Date.parse(recordedAt) < Date.parse(state.updated_at)) throw new Error("Terminal timestamp must not precede session state");
  return sessionStateSchema.parse({
    ...state,
    updated_at: recordedAt,
    duration_ms: Date.parse(recordedAt) - Date.parse(state.created_at),
    terminal_outcome: terminal.outcome,
    assurance_outcome: assuranceOutcome,
    terminal_provenance: {
      actor: terminal.actor,
      recorded_at: recordedAt,
      source_stage: terminal.source_stage,
    },
  });
}

export function materializeCanonicalSessionEvent(stateInput: SessionState): CanonicalSessionEvent {
  const state = sessionStateSchema.parse(stateInput);
  if (state.terminal_outcome === null || state.assurance_outcome === null || state.terminal_provenance === null) {
    throw new Error("Only a fully finalized session can materialize a canonical event");
  }
  return canonicalSessionEventSchema.parse({
    schema_version: 1,
    event_id: state.canonical_event_id,
    event_type: "session_finalized",
    session_id: state.session_id,
    run_id: state.run_id,
    created_at: state.created_at,
    timestamp: state.updated_at,
    duration_ms: state.duration_ms,
    command_counts: state.command_counts,
    invocation_counts: state.invocation_counts,
    status_counts: state.status_counts,
    source_counts: state.source_counts,
    token_totals: state.token_totals,
    terminal_outcome: state.terminal_outcome,
    assurance_outcome: state.assurance_outcome,
    terminal_provenance: state.terminal_provenance,
  });
}

export const sessionState = sessionStateSchema;
export const canonicalEventSchema = canonicalSessionEventSchema;
export const materializeSessionEvent = materializeCanonicalSessionEvent;
