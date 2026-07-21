import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { z } from "zod";
import type { ReasoningEffort } from "../core/types.js";

export const progressSourceSchema = z.enum([
  "brain", "hands", "verification", "verifier", "runtime", "github", "reflection",
]);
export const progressPhaseSchema = z.enum([
  "starting", "planning", "implementation", "fixing", "model_invocation", "verification",
  "review", "integration", "delivery", "reflection", "awaiting_approval", "warning", "failed",
]);
export const progressStatusSchema = z.enum([
  "started", "in_progress", "completed", "warning", "failed",
]);
const workItemSchema = z.object({
  index: z.number().int().positive(),
  total: z.number().int().positive(),
  attempt: z.number().int().positive(),
  final: z.boolean(),
}).strict().refine((value) => value.index <= value.total, "Work item index must not exceed total");
export type WorkItemCoordinate = z.infer<typeof workItemSchema>;
const operationSchema = z.object({
  index: z.number().int().positive(),
  total: z.number().int().positive(),
  kind: z.enum(["command", "browser_check", "artifact_check", "commit", "push"]),
  safe_tool: z.string().min(1).max(32).optional(),
  duration_ms: z.number().int().nonnegative().optional(),
}).strict().refine((value) => value.index <= value.total, "Operation index must not exceed total");
const usageSchema = z.object({
  input_tokens: z.number().int().nonnegative(),
  cached_input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  reasoning_output_tokens: z.number().int().nonnegative(),
}).strict();

const safeProgressEventStructuralSchema = z.object({
  schema_version: z.literal(1),
  event_id: z.string().uuid(),
  sequence: z.number().int().positive(),
  event_key: z.string().min(1).max(240),
  timestamp: z.string().datetime(),
  source: progressSourceSchema,
  phase: progressPhaseSchema,
  status: progressStatusSchema,
  safe_label: z.string().min(1).max(160),
  work_item: workItemSchema.optional(),
  operation: operationSchema.optional(),
  usage: usageSchema.optional(),
  model: z.string().min(1).max(64).optional(),
  reasoning_effort: z.enum(["minimal", "low", "medium", "high", "xhigh"]).optional(),
  worker_session_id: z.string().uuid().optional(),
  worker_pid: z.number().int().positive().optional(),
  child_pid: z.number().int().positive().optional(),
}).strict();

export type SafeProgressEvent = z.infer<typeof safeProgressEventStructuralSchema>;
export type ProgressCode =
  | "worker_started" | "worker_completed" | "worker_blocked" | "heartbeat"
  | "brain_started" | "planning_started" | "repository_inspection" | "researching_sources"
  | "discovery_started" | "discovery_question_ready" | "discovery_brief_ready" | "discovery_brief_approved"
  | "drafting_work_items" | "brain_turn_completed" | "validating_plan" | "plan_validated"
  | "plan_ready" | "work_item_implementation" | "work_item_fix" | "hands_started"
  | "hands_working" | "hands_checking" | "hands_applying" | "hands_applying_fixes"
  | "hands_turn_completed" | "validating_hands" | "hands_validated" | "implementation_recorded"
  | "verification_started" | "verification_command_started" | "verification_command_passed"
  | "verification_command_failed" | "artifact_checks_started" | "artifact_checks_completed"
  | "browser_checks_started" | "browser_checks_completed" | "verification_recorded"
  | "final_verification_started" | "verifier_started" | "verifier_inspecting"
  | "verifier_reviewing" | "verifier_turn_completed" | "validating_verifier"
  | "verifier_validated" | "verifier_approved" | "verifier_changes" | "verifier_replan"
  | "final_verifier_started" | "final_verifier_approved" | "worktree_preparing"
  | "github_sync" | "changes_committed" | "branch_pushed" | "pull_request_ready"
  | "reflection_started" | "reflection_analyzing" | "reflection_synthesizing"
  | "reflection_recorded" | "local_delivery_ready" | "github_delivery_ready"
  | "progress_warning" | "role_failed";

export interface ProgressIntent {
  code: ProgressCode;
  source: SafeProgressEvent["source"];
  workItem?: WorkItemCoordinate;
  operation?: z.input<typeof operationSchema>;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  revision?: number;
  discoveryCycle?: number;
  questionSequence?: number;
  presentCount?: number;
  usage?: z.input<typeof usageSchema>;
  workerSessionId?: string;
  workerPid?: number;
  childPid?: number;
  heartbeatOrdinal?: number;
  modelInvocationId?: string;
  warningKind?: string;
}

const SAFE_TOOLS = new Set(["npm", "pnpm", "yarn", "node", "npx", "vitest", "jest", "pytest", "python", "python3", "go", "cargo"]);
export const safeToolLabel = (value: string): string => SAFE_TOOLS.has(basename(value)) ? basename(value) : "command";
export const safeModelLabel = (value: string): string => /^[A-Za-z0-9._-]{1,64}$/.test(value) ? value : "configured model";

type Phase = SafeProgressEvent["phase"];
type Descriptor = {
  phase: Phase | ((intent: ProgressIntent) => Phase);
  status: SafeProgressEvent["status"];
  label: (intent: ProgressIntent) => string;
};
const fixed = (label: string) => (_intent: ProgressIntent): string => label;
const elapsed = (intent: ProgressIntent): string => intent.operation?.duration_ms === undefined ? "" : ` - ${(intent.operation.duration_ms / 1000).toFixed(1)}s`;
const attemptLabel = (intent: ProgressIntent): string => {
  const attempt = intent.workItem!.attempt;
  if (attempt < 1_000_000) return `attempt ${attempt}`;
  const review = Math.floor(attempt / 1_000_000);
  const action = Math.floor((attempt % 1_000_000) / 100);
  const actionAttempt = attempt % 100;
  return action > 0 && actionAttempt > 0
    ? `review ${review}, action ${action}, attempt ${actionAttempt}`
    : `attempt ${attempt}`;
};
const heartbeatPhase = (intent: ProgressIntent): Phase => ({
  brain: "planning", hands: "model_invocation", verifier: "model_invocation", reflection: "reflection",
  verification: "verification", runtime: "starting", github: "delivery",
})[intent.source] as Phase;
const roleName = (source: ProgressIntent["source"]): string => source[0]!.toUpperCase() + source.slice(1);
const progressWarningLabel = (intent: ProgressIntent): string => intent.warningKind === "item_error"
  ? "Model progress reported a non-terminal item error"
  : "Skipped an unreadable progress event";

const CATALOG: Record<ProgressCode, Descriptor> = {
  worker_started: { phase: "starting", status: "started", label: fixed("Worker session started") },
  worker_completed: { phase: "delivery", status: "completed", label: fixed("Worker session completed") },
  worker_blocked: { phase: "failed", status: "failed", label: fixed("Worker session requires operator action") },
  heartbeat: { phase: heartbeatPhase, status: "in_progress", label: (i) => `${roleName(i.source)} is still running` },
  brain_started: { phase: "model_invocation", status: "started", label: (i) => `Brain started - ${safeModelLabel(i.model ?? "")}/${i.reasoningEffort ?? "high"}` },
  planning_started: { phase: "planning", status: "started", label: fixed("Planning started") },
  discovery_started: { phase: "planning", status: "started", label: fixed("Discovery started") },
  discovery_question_ready: { phase: "awaiting_approval", status: "completed", label: fixed("Discovery question ready") },
  discovery_brief_ready: { phase: "awaiting_approval", status: "completed", label: fixed("Discovery brief ready") },
  discovery_brief_approved: { phase: "planning", status: "completed", label: fixed("Discovery brief approved") },
  repository_inspection: { phase: "planning", status: "in_progress", label: fixed("Inspecting repository") },
  researching_sources: { phase: "planning", status: "in_progress", label: fixed("Researching sources") },
  drafting_work_items: { phase: "planning", status: "in_progress", label: fixed("Drafting work items") },
  brain_turn_completed: { phase: "planning", status: "completed", label: fixed("Brain turn completed") },
  validating_plan: { phase: "planning", status: "in_progress", label: fixed("Validating structured plan") },
  plan_validated: { phase: "planning", status: "completed", label: fixed("Structured plan validated") },
  plan_ready: { phase: "awaiting_approval", status: "completed", label: (i) => `Plan revision ${i.revision} ready for approval` },
  work_item_implementation: { phase: "implementation", status: "started", label: (i) => `Work item ${i.workItem!.index} of ${i.workItem!.total} - implementation attempt ${i.workItem!.attempt}` },
  work_item_fix: { phase: "fixing", status: "started", label: (i) => `Work item ${i.workItem!.index} of ${i.workItem!.total} - fix ${attemptLabel(i)}` },
  hands_started: { phase: "model_invocation", status: "started", label: (i) => `Hands started - ${safeModelLabel(i.model ?? "")}/${i.reasoningEffort ?? "medium"}` },
  hands_working: { phase: "implementation", status: "in_progress", label: fixed("Working through implementation") },
  hands_checking: { phase: "implementation", status: "in_progress", label: fixed("Running implementation checks") },
  hands_applying: { phase: "implementation", status: "in_progress", label: fixed("Applying approved changes") },
  hands_applying_fixes: { phase: "fixing", status: "in_progress", label: fixed("Applying approved fixes") },
  hands_turn_completed: { phase: "implementation", status: "completed", label: fixed("Hands turn completed") },
  validating_hands: { phase: "implementation", status: "in_progress", label: fixed("Validating Hands result") },
  hands_validated: { phase: "implementation", status: "completed", label: fixed("Hands result validated") },
  implementation_recorded: { phase: "implementation", status: "completed", label: (i) => `Implementation ${attemptLabel(i)} recorded` },
  verification_started: { phase: "verification", status: "started", label: (i) => `Verification started - ${attemptLabel(i)}` },
  verification_command_started: { phase: "verification", status: "in_progress", label: (i) => `Verification ${i.operation!.index} of ${i.operation!.total} - running ${safeToolLabel(i.operation!.safe_tool ?? "")}` },
  verification_command_passed: { phase: "verification", status: "completed", label: (i) => `Verification ${i.operation!.index} of ${i.operation!.total} - passed${elapsed(i)}` },
  verification_command_failed: { phase: "verification", status: "failed", label: (i) => `Verification ${i.operation!.index} of ${i.operation!.total} - failed${elapsed(i)}` },
  artifact_checks_started: { phase: "verification", status: "in_progress", label: fixed("Checking required artifacts") },
  artifact_checks_completed: { phase: "verification", status: "completed", label: (i) => `Required artifacts - ${i.presentCount ?? 0} of ${i.operation!.total} present` },
  browser_checks_started: { phase: "verification", status: "in_progress", label: fixed("Checking browser evidence") },
  browser_checks_completed: { phase: "verification", status: "completed", label: (i) => `Browser evidence - ${i.presentCount ?? 0} of ${i.operation!.total} present` },
  verification_recorded: { phase: "verification", status: "completed", label: fixed("Verification evidence recorded") },
  final_verification_started: { phase: "integration", status: "started", label: fixed("Final integrated verification started") },
  verifier_started: { phase: "model_invocation", status: "started", label: (i) => `Verifier started - ${safeModelLabel(i.model ?? "")}/${i.reasoningEffort ?? "high"}` },
  verifier_inspecting: { phase: "review", status: "in_progress", label: fixed("Inspecting saved evidence") },
  verifier_reviewing: { phase: "review", status: "in_progress", label: fixed("Reviewing acceptance criteria") },
  verifier_turn_completed: { phase: "review", status: "completed", label: fixed("Verifier turn completed") },
  validating_verifier: { phase: "review", status: "in_progress", label: fixed("Validating Verifier result") },
  verifier_validated: { phase: "review", status: "completed", label: fixed("Verifier result validated") },
  verifier_approved: { phase: "review", status: "completed", label: (i) => `Verifier approved work item ${i.workItem!.index}` },
  verifier_changes: { phase: "review", status: "completed", label: fixed("Verifier requested changes") },
  verifier_replan: { phase: "review", status: "completed", label: fixed("Verifier requires replanning") },
  final_verifier_started: { phase: "integration", status: "started", label: fixed("Final Verifier review started") },
  final_verifier_approved: { phase: "integration", status: "completed", label: fixed("Final Verifier approved delivery") },
  worktree_preparing: { phase: "starting", status: "in_progress", label: fixed("Preparing isolated worktree") },
  github_sync: { phase: "delivery", status: "in_progress", label: fixed("Synchronizing GitHub work items") },
  changes_committed: { phase: "delivery", status: "completed", label: fixed("Approved changes committed") },
  branch_pushed: { phase: "delivery", status: "completed", label: fixed("Branch pushed") },
  pull_request_ready: { phase: "delivery", status: "completed", label: fixed("Pull request ready") },
  reflection_started: { phase: "reflection", status: "started", label: fixed("Reflection started") },
  reflection_analyzing: { phase: "reflection", status: "in_progress", label: fixed("Analyzing run evidence") },
  reflection_synthesizing: { phase: "reflection", status: "in_progress", label: fixed("Synthesizing reflection") },
  reflection_recorded: { phase: "reflection", status: "completed", label: fixed("Reflection recorded") },
  local_delivery_ready: { phase: "delivery", status: "completed", label: fixed("Run ready for local delivery") },
  github_delivery_ready: { phase: "delivery", status: "completed", label: fixed("Run ready for GitHub delivery") },
  progress_warning: { phase: "warning", status: "warning", label: progressWarningLabel },
  role_failed: { phase: "failed", status: "failed", label: fixed("Workflow step failed; inspect the run artifacts") },
};

const WORK_ITEM_REQUIRED = new Set<ProgressCode>([
  "work_item_implementation", "work_item_fix", "hands_started", "implementation_recorded",
  "verification_started", "verification_command_started", "verification_command_passed",
  "verification_command_failed", "artifact_checks_started", "artifact_checks_completed",
  "browser_checks_started", "browser_checks_completed", "verification_recorded", "verifier_started",
  "verifier_approved", "verifier_changes", "verifier_replan",
]);
const OPERATION_REQUIRED = new Set<ProgressCode>([
  "verification_command_started", "verification_command_passed", "verification_command_failed",
  "artifact_checks_completed", "browser_checks_completed",
]);
const SESSION_SCOPED = new Set<ProgressCode>([
  "worker_started", "worker_completed", "worker_blocked", "heartbeat",
  "brain_started", "planning_started", "repository_inspection", "researching_sources",
  "drafting_work_items", "brain_turn_completed", "hands_started", "hands_working",
  "hands_checking", "hands_applying", "hands_applying_fixes", "hands_turn_completed",
  "verifier_started", "verifier_inspecting", "verifier_reviewing", "verifier_turn_completed",
  "final_verifier_started",
  "reflection_started", "reflection_analyzing", "reflection_synthesizing", "progress_warning",
  "role_failed",
]);
const ANY_SOURCE = new Set<ProgressCode>(["heartbeat", "progress_warning", "role_failed"]);
const SOURCE_CODES: Record<SafeProgressEvent["source"], ReadonlySet<ProgressCode>> = {
  brain: new Set([
    "brain_started", "planning_started", "repository_inspection", "researching_sources",
    "discovery_started", "discovery_question_ready", "discovery_brief_ready", "discovery_brief_approved",
    "drafting_work_items", "brain_turn_completed", "validating_plan", "plan_validated", "plan_ready",
  ]),
  hands: new Set([
    "work_item_implementation", "work_item_fix", "hands_started", "hands_working", "hands_checking",
    "hands_applying", "hands_applying_fixes", "hands_turn_completed", "validating_hands",
    "hands_validated", "implementation_recorded",
  ]),
  verification: new Set([
    "verification_started", "verification_command_started", "verification_command_passed",
    "verification_command_failed", "artifact_checks_started", "artifact_checks_completed",
    "browser_checks_started", "browser_checks_completed", "verification_recorded",
    "final_verification_started",
  ]),
  verifier: new Set([
    "verifier_started", "verifier_inspecting", "verifier_reviewing", "verifier_turn_completed",
    "validating_verifier", "verifier_validated", "verifier_approved", "verifier_changes",
    "verifier_replan", "final_verifier_started", "final_verifier_approved",
  ]),
  runtime: new Set([
    "worker_started", "worker_completed", "worker_blocked", "worktree_preparing", "changes_committed",
    "local_delivery_ready", "github_delivery_ready",
  ]),
  github: new Set(["github_sync", "branch_pushed", "pull_request_ready"]),
  reflection: new Set([
    "reflection_started", "reflection_analyzing", "reflection_synthesizing", "reflection_recorded",
  ]),
};

function validateIntent(intent: ProgressIntent): void {
  if (!ANY_SOURCE.has(intent.code) && !SOURCE_CODES[intent.source].has(intent.code)) {
    throw new Error(`Progress code ${intent.code} does not allow source ${intent.source}`);
  }
  if (WORK_ITEM_REQUIRED.has(intent.code) && !intent.workItem) throw new Error(`Progress code ${intent.code} requires work-item coordinates`);
  if (OPERATION_REQUIRED.has(intent.code) && !intent.operation) throw new Error(`Progress code ${intent.code} requires operation coordinates`);
  if (["brain_started", "hands_started", "verifier_started", "final_verifier_started"].includes(intent.code) && (!intent.model || !intent.reasoningEffort)) {
    throw new Error(`Progress code ${intent.code} requires model metadata`);
  }
  if (["plan_ready", "discovery_brief_ready", "discovery_brief_approved"].includes(intent.code)
    && (!Number.isInteger(intent.revision) || (intent.revision ?? 0) < 1)) {
    throw new Error(`Progress code ${intent.code} requires a revision`);
  }
  if (intent.code === "discovery_question_ready" && (
    !Number.isInteger(intent.discoveryCycle)
    || (intent.discoveryCycle ?? 0) < 1
    || !Number.isInteger(intent.questionSequence)
    || (intent.questionSequence ?? 0) < 1
  )) throw new Error("Progress code discovery_question_ready requires cycle and question sequence");
  if (intent.code === "heartbeat" && (!intent.workerSessionId || !Number.isInteger(intent.heartbeatOrdinal) || (intent.heartbeatOrdinal ?? 0) < 1)) {
    throw new Error("Progress code heartbeat requires session metadata");
  }
  if (intent.modelInvocationId && !z.string().uuid().safeParse(intent.modelInvocationId).success) {
    throw new Error("Progress model invocation ID must be a UUID");
  }
  if (intent.warningKind !== undefined && !/^[a-z0-9_-]{1,48}$/.test(intent.warningKind)) {
    throw new Error("Progress warning kind must be a safe identifier");
  }
}

function buildEventKey(intent: ProgressIntent, sessionScoped = SESSION_SCOPED.has(intent.code)): string {
  return [
    intent.source,
    intent.code,
    ...(intent.workItem ? ["item", intent.workItem.index, "attempt", intent.workItem.attempt, "final", intent.workItem.final] : []),
    ...(intent.operation ? ["operation", intent.operation.kind, intent.operation.index] : []),
    ...(intent.revision ? ["revision", intent.revision] : []),
    ...(intent.discoveryCycle ? ["cycle", intent.discoveryCycle] : []),
    ...(intent.questionSequence ? ["question", intent.questionSequence] : []),
    ...(intent.modelInvocationId ? ["invocation", intent.modelInvocationId] : []),
    ...(intent.warningKind ? ["warning", intent.warningKind] : []),
    ...(sessionScoped && intent.workerSessionId ? ["session", intent.workerSessionId] : []),
    ...(intent.heartbeatOrdinal ? ["heartbeat", intent.heartbeatOrdinal] : []),
  ].map(String).join(":");
}

function legacySessionEventKey(intent: ProgressIntent): string | undefined {
  if (!intent.workerSessionId) return undefined;
  if (!SESSION_SCOPED.has(intent.code)) return buildEventKey(intent, true);
  return intent.code === "final_verifier_started" ? buildEventKey(intent, false) : undefined;
}

function progressCodeFromKey(event: SafeProgressEvent): ProgressCode | undefined {
  const [source, code] = event.event_key.split(":", 2);
  return source === event.source && code && Object.hasOwn(CATALOG, code) ? code as ProgressCode : undefined;
}

function positiveCoordinate(eventKey: string, name: string): number | undefined {
  const parts = eventKey.split(":");
  const index = parts.lastIndexOf(name);
  if (index < 0 || index + 1 >= parts.length) return undefined;
  const value = Number(parts[index + 1]);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

function stringCoordinate(eventKey: string, name: string): string | undefined {
  const parts = eventKey.split(":");
  const index = parts.lastIndexOf(name);
  return index >= 0 && index + 1 < parts.length ? parts[index + 1] : undefined;
}

function countFromLabel(event: SafeProgressEvent, code: ProgressCode): number | undefined {
  if (code !== "artifact_checks_completed" && code !== "browser_checks_completed") return undefined;
  const prefix = code === "artifact_checks_completed" ? "Required artifacts" : "Browser evidence";
  const match = event.safe_label.match(new RegExp(`^${prefix} - (\\d+) of (\\d+) present$`));
  if (!match || Number(match[2]) !== event.operation?.total) return undefined;
  const count = Number(match[1]);
  return Number.isSafeInteger(count) && count >= 0 && count <= Number(match[2]) ? count : undefined;
}

function intentFromEvent(event: SafeProgressEvent, code: ProgressCode): ProgressIntent {
  return {
    code,
    source: event.source,
    ...(event.work_item ? { workItem: event.work_item } : {}),
    ...(event.operation ? { operation: event.operation } : {}),
    ...(event.model ? { model: event.model } : {}),
    ...(event.reasoning_effort ? { reasoningEffort: event.reasoning_effort } : {}),
    ...(["plan_ready", "discovery_brief_ready", "discovery_brief_approved"].includes(code)
      ? { revision: positiveCoordinate(event.event_key, "revision") }
      : {}),
    ...(code === "discovery_question_ready" ? {
      discoveryCycle: positiveCoordinate(event.event_key, "cycle"),
      questionSequence: positiveCoordinate(event.event_key, "question"),
    } : {}),
    ...(["artifact_checks_completed", "browser_checks_completed"].includes(code)
      ? { presentCount: countFromLabel(event, code) }
      : {}),
    ...(event.usage ? { usage: event.usage } : {}),
    ...(event.worker_session_id ? { workerSessionId: event.worker_session_id } : {}),
    ...(event.worker_pid ? { workerPid: event.worker_pid } : {}),
    ...(event.child_pid ? { childPid: event.child_pid } : {}),
    ...(stringCoordinate(event.event_key, "invocation") ? { modelInvocationId: stringCoordinate(event.event_key, "invocation") } : {}),
    ...(code === "progress_warning" && stringCoordinate(event.event_key, "warning") ? { warningKind: stringCoordinate(event.event_key, "warning") } : {}),
    ...(code === "heartbeat" ? { heartbeatOrdinal: positiveCoordinate(event.event_key, "heartbeat") } : {}),
  };
}

export const safeProgressEventSchema = safeProgressEventStructuralSchema.superRefine((event, context) => {
  const code = progressCodeFromKey(event);
  if (!code) {
    context.addIssue({ code: "custom", message: "Event key does not select a known progress catalog entry" });
    return;
  }
  const intent = intentFromEvent(event, code);
  const legacyDiscoveryQuestion = code === "discovery_question_ready"
    && event.event_key === "brain:discovery_question_ready";
  try {
    validateIntent(intent);
  } catch {
    if (!legacyDiscoveryQuestion) {
      context.addIssue({ code: "custom", message: "Event is missing required safe catalog coordinates" });
      return;
    }
  }
  const descriptor = CATALOG[code];
  const expectedPhase = typeof descriptor.phase === "function" ? descriptor.phase(intent) : descriptor.phase;
  if (![buildEventKey(intent), legacySessionEventKey(intent)].includes(event.event_key)) context.addIssue({ code: "custom", path: ["event_key"], message: "Event key does not match safe catalog coordinates" });
  const legacyCompletedPhase = code === "worker_completed" && event.phase === "starting";
  if (event.phase !== expectedPhase && !legacyCompletedPhase) context.addIssue({ code: "custom", path: ["phase"], message: "Phase does not match safe progress catalog" });
  if (event.status !== descriptor.status) context.addIssue({ code: "custom", path: ["status"], message: "Status does not match safe progress catalog" });
  const legacyNamespacedLabel = intent.workItem !== undefined && intent.workItem.attempt >= 1_000_000
    ? code === "work_item_fix"
      ? `Work item ${intent.workItem.index} of ${intent.workItem.total} - fix attempt ${intent.workItem.attempt}`
      : code === "implementation_recorded"
        ? `Implementation attempt ${intent.workItem.attempt} recorded`
        : code === "verification_started"
          ? `Verification started - attempt ${intent.workItem.attempt}`
          : null
    : null;
  if (event.safe_label !== descriptor.label(intent) && event.safe_label !== legacyNamespacedLabel) {
    context.addIssue({ code: "custom", path: ["safe_label"], message: "Label does not match safe progress catalog" });
  }
});

export function canonicalProgressEventKey(event: SafeProgressEvent): string {
  const code = progressCodeFromKey(event);
  return code ? buildEventKey(intentFromEvent(event, code)) : event.event_key;
}

export function materializeProgressEvent(intent: ProgressIntent, sequence: number, timestamp: string): SafeProgressEvent {
  validateIntent(intent);
  const descriptor = CATALOG[intent.code];
  const model = intent.model === undefined ? undefined : safeModelLabel(intent.model);
  return safeProgressEventSchema.parse({
    schema_version: 1,
    event_id: randomUUID(),
    sequence,
    event_key: buildEventKey(intent),
    timestamp,
    source: intent.source,
    phase: typeof descriptor.phase === "function" ? descriptor.phase(intent) : descriptor.phase,
    status: descriptor.status,
    safe_label: descriptor.label(intent),
    ...(intent.workItem ? { work_item: intent.workItem } : {}),
    ...(intent.operation ? { operation: { ...intent.operation, ...(intent.operation.kind === "command" ? { safe_tool: safeToolLabel(intent.operation.safe_tool ?? "") } : {}) } } : {}),
    ...(intent.usage ? { usage: intent.usage } : {}),
    ...(model ? { model } : {}),
    ...(intent.reasoningEffort ? { reasoning_effort: intent.reasoningEffort } : {}),
    ...(intent.workerSessionId ? { worker_session_id: intent.workerSessionId } : {}),
    ...(intent.workerPid ? { worker_pid: intent.workerPid } : {}),
    ...(intent.childPid ? { child_pid: intent.childPid } : {}),
  });
}
