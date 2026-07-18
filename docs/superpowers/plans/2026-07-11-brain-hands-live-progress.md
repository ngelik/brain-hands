# Brain Hands Live Progress Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a safe, append-only, resumable `progress.jsonl` timeline and live CLI following across Brain, Hands, deterministic verification, Verifier, delivery, and reflection without changing any approval or success gate.

**Architecture:** A typed progress catalog constructs every safe label from allowlisted values, and a run-level reporter validates, sequences, deduplicates, appends, and optionally renders those events. Structured Codex calls stream `--json` stdout through a JSONL framer and role-aware normalizer; workflow code emits synthetic events at durable boundaries. CLI producers render persisted events to stderr through the reporter, while `logs` replays and tails the same file.

**Tech Stack:** TypeScript 6, Node.js 20+, Execa 9, Zod 4, Commander 15, Vitest 4.

## Global Constraints

- Work on `main`; do not create a feature branch unless the user changes the instruction.
- Preserve unrelated worktree changes and touch only files listed by the active task.
- `events.jsonl` remains the approval-critical workflow ledger; never write progress records into it.
- `progress.jsonl` contains only schema-approved, Brain Hands-owned labels and numeric/enum context.
- Never persist raw Codex JSONL stdout, prompts, reasoning, agent text, commands, arguments, output, patches, findings, paths, URLs, IDs, or unknown payloads in `progress.jsonl`.
- Existing structured output files and role schemas remain authoritative.
- Existing explicit plan approval, verification evidence, Verifier provenance, and delivery checks remain unchanged.
- Progress failures are observational: preserve the original workflow result and report at most one generic progress warning.
- `--json --follow` is invalid for every producing command; successful `--json` output remains one final JSON value.
- Do not add runtime dependencies.
- Read JSONL incrementally; never implement progress replay with `readFile(...).split(...)`.

## File Structure

**Create**

- `src/progress/events.ts` — Zod schema, safe event types, fixed code-to-label catalog, model/tool sanitizers, deterministic key construction.
- `src/progress/log.ts` — append-only reporter, streaming replay, incremental follower, quiescent-boundary detection.
- `src/progress/codex.ts` — bounded JSONL framer and role-aware Codex event normalization.
- `tests/progress/events.test.ts` — catalog, schema, key, and non-leakage tests.
- `tests/progress/log.test.ts` — sequencing, resume, streaming replay/follow, append failure, and boundary tests.
- `tests/progress/codex.test.ts` — chunk framing, event mapping, unknown/malformed input, and secret exclusion tests.

**Modify**

- `src/core/ledger.ts` — create and protect `progress.jsonl` in every v2 run.
- `tests/core/ledger.test.ts` — assert creation and append-only protection.
- `src/core/executor.ts` — optional ordered stdout chunk callback.
- `tests/core/executor.test.ts` — prove chunks arrive before process completion without changing buffered callers.
- `src/adapters/codex.ts` — add `--json`, progress context/result path, normalized streaming, bounded redacted stderr, and dry-run role progress.
- `tests/adapters/codex.test.ts` — structured streaming and final-output fail-closed tests.
- `src/workflow/planner.ts` — Brain validation and revision-ready events.
- `src/workflow/worker.ts` — Hands validation and recorded-attempt events.
- `src/workflow/verifier.ts` — Verifier validation and persisted-decision events.
- `src/workflow/reflection.ts` — generic reflection phase and saved-artifact events.
- `tests/workflow/planner.test.ts`, `tests/workflow/worker.test.ts`, `tests/workflow/verifier.test.ts`, `tests/workflow/reflection.test.ts` — durable-boundary ordering tests.
- `src/verification/runner.ts` — command, artifact, browser, and evidence progress.
- `tests/verification/runner.test.ts` — pre-completion visibility and count-only safety tests.
- `src/workflow/runtime.ts` — work-item coordinates, attempts, fixes, integration, GitHub, blocker, and delivery progress; pass one reporter through all dependencies.
- `tests/workflow/runtime-local.test.ts`, `tests/workflow/runtime-github.test.ts` — complete lifecycle, retries, resume deduplication, delivery, and GitHub labels.
- `src/cli.ts` — reporter construction, `--follow` options, `logs`, stderr rendering, immediate run identity, JSON/follow conflict.
- `tests/cli-smoke.test.ts` — command registration and output-channel behavior.
- `README.md`, `agentic-codex-workflow.md`, `.agents/skills/brain-hands/SKILL.md` — operator contract and progress artifact guidance.

---

### Task 1: Define the safe progress contract and ledger artifact

**Files:**
- Create: `src/progress/events.ts`
- Modify: `src/core/ledger.ts:175-256,520-532`
- Create: `tests/progress/events.test.ts`
- Modify: `tests/core/ledger.test.ts:60-170`

**Interfaces:**
- Produces: `safeProgressEventSchema`, `SafeProgressEvent`, `ProgressIntent`, `ProgressCode`, `materializeProgressEvent(intent, sequence, timestamp)`, `safeModelLabel(model)`, and `safeToolLabel(executable)`.
- Produces: a zero-byte `progress.jsonl` in every v2 ledger and overwrite protection in `writeTextArtifact()`.

- [ ] **Step 1: Write failing contract and ledger tests**

Add tests that exercise a fixed catalog rather than arbitrary labels:

```ts
// tests/progress/events.test.ts
import { describe, expect, it } from "vitest";
import {
  materializeProgressEvent,
  safeModelLabel,
  safeProgressEventSchema,
  safeToolLabel,
} from "../../src/progress/events.js";

describe("safe progress events", () => {
  it("materializes a fixed Hands label and deterministic safe key", () => {
    const event = materializeProgressEvent({
      code: "hands_started",
      source: "hands",
      model: "gpt-5.6-luna",
      reasoningEffort: "medium",
      workItem: { index: 1, total: 3, attempt: 2, final: false },
    }, 7, "2026-07-11T20:00:00.000Z");

    expect(event).toMatchObject({
      schema_version: 1,
      sequence: 7,
      event_key: "hands:hands_started:item:1:attempt:2:final:false",
      safe_label: "Hands started - gpt-5.6-luna/medium",
    });
    expect(safeProgressEventSchema.parse(event)).toEqual(event);
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
});
```

Extend `tests/core/ledger.test.ts` to assert `progress.jsonl` exists and:

```ts
await expect(writeTextArtifact(ledger.runDir, "progress.jsonl", "overwrite\n"))
  .rejects.toThrow("progress.jsonl is append-only");
```

- [ ] **Step 2: Run the focused tests and confirm they fail**

Run: `npx vitest run tests/progress/events.test.ts tests/core/ledger.test.ts`

Expected: FAIL because `src/progress/events.ts` does not exist and v2 ledgers do not create/protect `progress.jsonl`.

- [ ] **Step 3: Implement the schema, typed intent, catalog, and ledger changes**

Use a discriminated `ProgressCode` union containing every code from the approved spec. Callers provide a code and safe coordinates; only `materializeProgressEvent()` may construct `safe_label`, `phase`, `status`, and `event_key`.

```ts
// src/progress/events.ts
import { basename } from "node:path";
import { z } from "zod";
import type { ReasoningEffort } from "../core/types.js";

export const progressSourceSchema = z.enum([
  "brain", "hands", "verification", "verifier", "runtime", "github", "reflection",
]);
export const progressPhaseSchema = z.enum([
  "starting", "planning", "implementation", "fixing", "verification", "review",
  "integration", "delivery", "reflection", "awaiting_approval", "warning", "failed",
]);
export const progressStatusSchema = z.enum([
  "started", "in_progress", "completed", "warning", "failed",
]);
const workItemSchema = z.object({
  index: z.number().int().positive(),
  total: z.number().int().positive(),
  attempt: z.number().int().positive(),
  final: z.boolean(),
}).strict();
export type WorkItemCoordinate = z.infer<typeof workItemSchema>;
const operationSchema = z.object({
  index: z.number().int().positive(),
  total: z.number().int().positive(),
  kind: z.enum(["command", "browser_check", "artifact_check", "commit", "push"]),
  safe_tool: z.string().min(1).max(32).optional(),
  duration_ms: z.number().int().nonnegative().optional(),
}).strict();
const usageSchema = z.object({
  input_tokens: z.number().int().nonnegative(),
  cached_input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  reasoning_output_tokens: z.number().int().nonnegative(),
}).strict();

export const safeProgressEventSchema = z.object({
  schema_version: z.literal(1),
  sequence: z.number().int().positive(),
  event_key: z.string().min(1).max(180),
  timestamp: z.string().datetime(),
  source: progressSourceSchema,
  phase: progressPhaseSchema,
  status: progressStatusSchema,
  safe_label: z.string().min(1).max(160),
  work_item: workItemSchema.optional(),
  operation: operationSchema.optional(),
  usage: usageSchema.optional(),
}).strict();

export type SafeProgressEvent = z.infer<typeof safeProgressEventSchema>;
export type ProgressCode =
  | "brain_started" | "planning_started" | "repository_inspection" | "researching_sources"
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
  workItem?: z.input<typeof workItemSchema>;
  operation?: z.input<typeof operationSchema>;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  revision?: number;
  presentCount?: number;
  decision?: "approve" | "request_changes" | "replan_required";
  usage?: z.input<typeof usageSchema>;
}

const SAFE_TOOLS = new Set(["npm", "pnpm", "yarn", "node", "npx", "vitest", "jest", "pytest", "python", "python3", "go", "cargo"]);
export const safeToolLabel = (value: string): string => SAFE_TOOLS.has(basename(value)) ? basename(value) : "command";
export const safeModelLabel = (value: string): string => /^[A-Za-z0-9._-]{1,64}$/.test(value) ? value : "configured model";

type Descriptor = {
  phase: SafeProgressEvent["phase"];
  status: SafeProgressEvent["status"];
  label: (intent: ProgressIntent) => string;
};
const fixed = (label: string) => (_intent: ProgressIntent): string => label;
const elapsed = (intent: ProgressIntent): string => intent.operation?.duration_ms === undefined
  ? ""
  : ` - ${(intent.operation.duration_ms / 1000).toFixed(1)}s`;
const CATALOG: Record<ProgressCode, Descriptor> = {
  brain_started: { phase: "starting", status: "started", label: (i) => `Brain started - ${safeModelLabel(i.model ?? "")}/${i.reasoningEffort ?? "high"}` },
  planning_started: { phase: "planning", status: "started", label: fixed("Planning started") },
  repository_inspection: { phase: "planning", status: "in_progress", label: fixed("Inspecting repository") },
  researching_sources: { phase: "planning", status: "in_progress", label: fixed("Researching sources") },
  drafting_work_items: { phase: "planning", status: "in_progress", label: fixed("Drafting work items") },
  brain_turn_completed: { phase: "planning", status: "completed", label: fixed("Brain turn completed") },
  validating_plan: { phase: "planning", status: "in_progress", label: fixed("Validating structured plan") },
  plan_validated: { phase: "planning", status: "completed", label: fixed("Structured plan validated") },
  plan_ready: { phase: "awaiting_approval", status: "completed", label: (i) => `Plan revision ${i.revision} ready for approval` },
  work_item_implementation: { phase: "implementation", status: "started", label: (i) => `Work item ${i.workItem!.index} of ${i.workItem!.total} - implementation attempt ${i.workItem!.attempt}` },
  work_item_fix: { phase: "fixing", status: "started", label: (i) => `Work item ${i.workItem!.index} of ${i.workItem!.total} - fix attempt ${i.workItem!.attempt}` },
  hands_started: { phase: "implementation", status: "started", label: (i) => `Hands started - ${safeModelLabel(i.model ?? "")}/${i.reasoningEffort ?? "medium"}` },
  hands_working: { phase: "implementation", status: "in_progress", label: fixed("Working through implementation") },
  hands_checking: { phase: "implementation", status: "in_progress", label: fixed("Running implementation checks") },
  hands_applying: { phase: "implementation", status: "in_progress", label: fixed("Applying approved changes") },
  hands_applying_fixes: { phase: "fixing", status: "in_progress", label: fixed("Applying approved fixes") },
  hands_turn_completed: { phase: "implementation", status: "completed", label: fixed("Hands turn completed") },
  validating_hands: { phase: "implementation", status: "in_progress", label: fixed("Validating Hands result") },
  hands_validated: { phase: "implementation", status: "completed", label: fixed("Hands result validated") },
  implementation_recorded: { phase: "implementation", status: "completed", label: (i) => `Implementation attempt ${i.workItem!.attempt} recorded` },
  verification_started: { phase: "verification", status: "started", label: (i) => `Verification started - attempt ${i.workItem!.attempt}` },
  verification_command_started: { phase: "verification", status: "in_progress", label: (i) => `Verification ${i.operation!.index} of ${i.operation!.total} - running ${safeToolLabel(i.operation!.safe_tool ?? "")}` },
  verification_command_passed: { phase: "verification", status: "completed", label: (i) => `Verification ${i.operation!.index} of ${i.operation!.total} - passed${elapsed(i)}` },
  verification_command_failed: { phase: "verification", status: "failed", label: (i) => `Verification ${i.operation!.index} of ${i.operation!.total} - failed${elapsed(i)}` },
  artifact_checks_started: { phase: "verification", status: "in_progress", label: fixed("Checking required artifacts") },
  artifact_checks_completed: { phase: "verification", status: "completed", label: (i) => `Required artifacts - ${i.presentCount ?? 0} of ${i.operation!.total} present` },
  browser_checks_started: { phase: "verification", status: "in_progress", label: fixed("Checking browser evidence") },
  browser_checks_completed: { phase: "verification", status: "completed", label: (i) => `Browser evidence - ${i.presentCount ?? 0} of ${i.operation!.total} present` },
  verification_recorded: { phase: "verification", status: "completed", label: fixed("Verification evidence recorded") },
  final_verification_started: { phase: "integration", status: "started", label: fixed("Final integrated verification started") },
  verifier_started: { phase: "review", status: "started", label: (i) => `Verifier started - ${safeModelLabel(i.model ?? "")}/${i.reasoningEffort ?? "high"}` },
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
  progress_warning: { phase: "warning", status: "warning", label: fixed("Skipped an unreadable progress event") },
  role_failed: { phase: "failed", status: "failed", label: fixed("Workflow step failed; inspect the run artifacts") },
};

export function materializeProgressEvent(
  intent: ProgressIntent,
  sequence: number,
  timestamp: string,
): SafeProgressEvent {
  const descriptor = CATALOG[intent.code];
  const coordinates = [
    intent.source,
    intent.code,
    ...(intent.workItem ? ["item", intent.workItem.index, "attempt", intent.workItem.attempt, "final", intent.workItem.final] : []),
    ...(intent.operation ? ["operation", intent.operation.kind, intent.operation.index] : []),
  ].map(String);
  return safeProgressEventSchema.parse({
    schema_version: 1,
    sequence,
    event_key: coordinates.join(":"),
    timestamp,
    source: intent.source,
    phase: descriptor.phase,
    status: descriptor.status,
    safe_label: descriptor.label(intent),
    ...(intent.workItem ? { work_item: intent.workItem } : {}),
    ...(intent.operation ? { operation: {
      ...intent.operation,
      ...(intent.operation.kind === "command"
        ? { safe_tool: safeToolLabel(intent.operation.safe_tool ?? "") }
        : {}),
    } } : {}),
    ...(intent.usage ? { usage: intent.usage } : {}),
  });
}
```

Validate code-specific required context before indexing `workItem` or `operation`; for example, `hands_started` requires both model and work-item coordinates, and verification command codes require an operation. Throw a fixed developer error that names only the `ProgressCode` when a caller violates the typed contract.

In `createRunLedgerV2()`, create `progress.jsonl` beside `events.jsonl` with `flag: "wx"`. In `writeTextArtifact()`, reject both protected absolute targets.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `npx vitest run tests/progress/events.test.ts tests/core/ledger.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/progress/events.ts src/core/ledger.ts tests/progress/events.test.ts tests/core/ledger.test.ts
git commit -m "feat: define safe run progress contract"
```

---

### Task 2: Implement append-only reporting, streaming replay, and following

**Files:**
- Create: `src/progress/log.ts`
- Create: `tests/progress/log.test.ts`

**Interfaces:**
- Consumes: `ProgressIntent`, `SafeProgressEvent`, `materializeProgressEvent()` from Task 1.
- Produces: `ProgressReporter.emit(intent): Promise<SafeProgressEvent | null>`, `openProgressReporter(input)`, `readProgressEvents(runDir)`, `followProgressEvents(input)`, `formatProgressEvent(event)`, and `isQuiescentState(input)`.

- [ ] **Step 1: Write failing reporter and reader tests**

Cover sequence recovery, deterministic-key deduplication, event-after-append callbacks, streaming replay, partial trailing records, malformed historical records, and quiescent exit. Use a reporter callback to prove only persisted events are rendered:

```ts
const rendered: number[] = [];
const reporter = await openProgressReporter({
  runDir: ledger.runDir,
  now: () => "2026-07-11T20:00:00.000Z",
  onEvent: (event) => rendered.push(event.sequence),
});
await reporter.emit({ code: "planning_started", source: "brain" });
await reporter.emit({ code: "planning_started", source: "brain" });
expect(rendered).toEqual([1]);
const replayed: SafeProgressEvent[] = [];
for await (const event of readProgressEvents(ledger.runDir)) replayed.push(event);
expect(replayed.map((event) => event.sequence)).toEqual([1]);
```

Add a large-history test that spies on `node:fs/promises.readFile` and confirms progress replay does not call it.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run tests/progress/log.test.ts`

Expected: FAIL because the progress log module does not exist.

- [ ] **Step 3: Implement the reporter and streaming reader**

Use these exact public interfaces:

```ts
export interface ProgressReporter {
  readonly path: string;
  emit(intent: ProgressIntent): Promise<SafeProgressEvent | null>;
}

export interface OpenProgressReporterInput {
  runDir: string;
  now?: () => string;
  onEvent?: (event: SafeProgressEvent) => void | Promise<void>;
  onWarning?: () => void;
}

export interface FollowProgressInput {
  runDir: string;
  onEvent: (event: SafeProgressEvent) => void | Promise<void>;
  pollMs?: number;
  signal?: AbortSignal;
}

export async function openProgressReporter(input: OpenProgressReporterInput): Promise<ProgressReporter>;
export async function* readProgressEvents(runDir: string): AsyncGenerator<SafeProgressEvent>;
export async function followProgressEvents(input: FollowProgressInput): Promise<void>;
export function formatProgressEvent(event: SafeProgressEvent): string;
export function isQuiescentState(input: {
  manifest: RunManifestV2;
  reflectionExpected: boolean;
  reflectionRecorded: boolean;
}): boolean;
```

Implement replay with `createReadStream()` and `readline.createInterface({ crlfDelay: Infinity })`. The reporter initializes `sequence` and `eventKeys` by iterating `readProgressEvents()`, serializes appends through one promise chain, appends before calling `onEvent`, and returns `null` for a duplicate key.

Implement following with byte offsets and `StringDecoder` so multibyte UTF-8 and partial lines are preserved. Read `intake.json` once to determine whether reflection is enabled, and track whether a valid event key contains `reflection:reflection_recorded`. After every poll: drain complete valid lines, read `manifest.json`, and exit only after draining when `isQuiescentState()` is true. `awaiting_plan_approval`, `replanning`, and `delivery_state: blocked` are always quiescent. `stage: complete` and delivery states `ready` or `complete` are quiescent only when reflection is disabled or `reflection_recorded` has been observed; this prevents a follower from exiting between the runtime's `complete` transition and reflection artifact persistence.

On the first append error, call `onWarning` once, disable later writes for that reporter, and return `null`; never throw the progress error into workflow code.

- [ ] **Step 4: Run focused tests**

Run: `npx vitest run tests/progress/log.test.ts tests/progress/events.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/progress/log.ts tests/progress/log.test.ts
git commit -m "feat: add resumable progress log"
```

---

### Task 3: Stream subprocess stdout and normalize Codex JSONL safely

**Files:**
- Modify: `src/core/executor.ts:3-79`
- Modify: `tests/core/executor.test.ts:1-78`
- Create: `src/progress/codex.ts`
- Create: `tests/progress/codex.test.ts`

**Interfaces:**
- Consumes: `ProgressReporter` and `ProgressIntent`.
- Produces: optional `RunCommandInput.onStdoutChunk` and `createCodexProgressConsumer(input)` with `write(chunk)` and `end()`.

- [ ] **Step 1: Write failing executor and JSONL tests**

Add an executor test whose child prints one chunk immediately and exits later; assert the callback fires while the returned promise is still pending.

Add Codex consumer tests for split records, multiple records per chunk, no-final-newline, oversized records, malformed records, unknown types, role mappings, item-level error warnings, and a payload containing `sk-secret`, command text, output, URLs, paths, and findings. Assert none of those strings occur in serialized emitted events.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run tests/core/executor.test.ts tests/progress/codex.test.ts`

Expected: FAIL because chunk callbacks and the Codex consumer are missing.

- [ ] **Step 3: Add an ordered optional stdout callback to the executor**

Extend the input without changing existing callers:

```ts
export interface RunCommandInput {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  stdin?: string;
  onStdoutChunk?: (chunk: string) => void | Promise<void>;
}
```

Create the Execa subprocess before awaiting it, attach a `data` listener when the callback exists, and serialize callbacks:

```ts
const subprocess = execa(input.command, input.args, {
  cwd: input.cwd,
  input: input.stdin,
  reject: false,
  timeout: input.timeoutMs,
});
let stdoutCallbacks = Promise.resolve();
if (input.onStdoutChunk && subprocess.stdout) {
  subprocess.stdout.on("data", (chunk: Buffer | string) => {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    stdoutCallbacks = stdoutCallbacks.then(() => input.onStdoutChunk!(text));
  });
}
const result = await subprocess;
await stdoutCallbacks;
```

Preserve the existing `CommandResult` fields and exception normalization.

- [ ] **Step 4: Implement the bounded role-aware Codex consumer**

Use these interfaces:

```ts
export interface CodexProgressContext {
  source: "brain" | "hands" | "verifier" | "reflection";
  mode: "planning" | "implementation" | "fix" | "review" | "final_review" | "reflection_account" | "reflection_synthesis";
  model: string;
  reasoningEffort: ReasoningEffort;
  workItem?: { index: number; total: number; attempt: number; final: boolean };
}

export interface CodexProgressConsumer {
  write(chunk: string): Promise<void>;
  end(): Promise<void>;
}

export function createCodexProgressConsumer(input: {
  reporter: ProgressReporter;
  context: CodexProgressContext;
  maxRecordBytes?: number;
}): CodexProgressConsumer;
```

Maintain a carry buffer capped at 1 MiB. Parse complete lines into `unknown`, inspect only `type`, `item.type`, and numeric `usage`, and emit fixed intents. Deduplicate repeated item phases within the consumer. Never include a rejected line in a warning or thrown error.

- [ ] **Step 5: Run focused tests and typecheck**

Run: `npx vitest run tests/core/executor.test.ts tests/progress/codex.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/executor.ts src/progress/codex.ts tests/core/executor.test.ts tests/progress/codex.test.ts
git commit -m "feat: stream and normalize Codex progress"
```

---

### Task 4: Integrate safe streaming into the Codex adapter

**Files:**
- Modify: `src/adapters/codex.ts:23-117,143-155,243-280,311-395`
- Modify: `tests/adapters/codex.test.ts:82-410`

**Interfaces:**
- Consumes: `ProgressReporter`, `CodexProgressContext`, `createCodexProgressConsumer()`.
- Extends: `CodexInvokeInput.progress?: { reporter: ProgressReporter; context: CodexProgressContext }`.
- Extends: `CodexInvokeResult.progressPath?: string` and `CodexInvocationError.paths.progressPath?: string`.

- [ ] **Step 1: Write failing adapter tests**

Update argument tests to require `--json` when progress is supplied while retaining `--output-schema`, `--output-last-message`, sandbox, search, and isolation flags. Mock `runCommand()` so it calls `onStdoutChunk` before writing the final output file; assert normalized events exist before the invocation resolves.

Add tests proving raw JSONL is absent from every `responses/*.stdout.txt`, final output remains required and schema-validated, item errors do not force failure, top-level failure does not override a later non-zero process error, and stderr is capped/redacted.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run tests/adapters/codex.test.ts`

Expected: FAIL because the adapter does not accept progress or render `--json`.

- [ ] **Step 3: Add progress-aware arguments and result contracts**

Add `jsonEvents: boolean` to `RenderCodexArgsInput` and insert `--json` immediately after `--ephemeral` when true. Set it only when `input.progress` is present, leaving retained legacy roles buffered.

Replace raw structured stdout persistence with:

```ts
const progressPath = input.progress?.reporter.path;
const stdoutPath = progressPath ?? join(input.runDir, "responses", `${input.artifactName}.stdout.txt`);
```

Persist only redacted/capped stderr for progress-aware calls. Keep legacy `writeResponseArtifacts()` behavior for calls without progress.

- [ ] **Step 4: Wire JSONL consumption and validation lifecycle**

Before `runCommand()`, emit the role start intent and create the consumer. Pass `onStdoutChunk: (chunk) => consumer.write(chunk)`, then `await consumer.end()` after the command returns. Emit the role-specific `validating_*` intent immediately before reading/parsing the final output and the role-specific validated intent only after Zod succeeds.

Return `progressPath`; set `stdoutPath` to the same safe file. Include both in `CodexInvocationError.paths`. Do not change the existing requirement for exit code zero or the output-last-message artifact.

For `DryRunCodexAdapter`, emit the same role start/turn/validation intents through the supplied reporter around fixture parsing, without fabricated commands, usage, or thread IDs.

- [ ] **Step 5: Run focused tests**

Run: `npx vitest run tests/adapters/codex.test.ts tests/progress/codex.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/adapters/codex.ts tests/adapters/codex.test.ts
git commit -m "feat: stream structured role progress"
```

---

### Task 5: Emit Brain, Hands, Verifier, and reflection durable-boundary events

**Files:**
- Modify: `src/workflow/planner.ts:31-109`
- Modify: `src/workflow/worker.ts:12-123`
- Modify: `src/workflow/verifier.ts:14-178`
- Modify: `src/workflow/reflection.ts:243-321`
- Modify: `tests/workflow/planner.test.ts`, `tests/workflow/worker.test.ts`, `tests/workflow/verifier.test.ts`, `tests/workflow/reflection.test.ts`

**Interfaces:**
- Adds optional `progress?: ProgressReporter` and safe coordinate fields to workflow inputs.
- Passes exact `CodexProgressContext` into every structured invocation.
- Emits recorded/decision/reflection events only after durable artifacts exist.

- [ ] **Step 1: Write failing durable-boundary tests**

For each role, inject a recording `ProgressReporter` and assert ordering:

```ts
expect(codes).toEqual(expect.arrayContaining([
  "validating_hands",
  "hands_validated",
  "implementation_recorded",
]));
expect(await readFile(result.reportPath, "utf8")).toContain("work_item_id");
```

Add negative cases: mismatched Hands item emits no `implementation_recorded`; mismatched Verifier provenance emits no decision; failed plan revision recording emits no `plan_ready`; failed reflection persistence emits no `reflection_recorded`.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run tests/workflow/planner.test.ts tests/workflow/worker.test.ts tests/workflow/verifier.test.ts tests/workflow/reflection.test.ts`

Expected: FAIL because workflow inputs do not accept or emit progress.

- [ ] **Step 3: Integrate Brain and Hands**

Extend `PlanRunV2Input` with `progress?: ProgressReporter`; pass planning context to Codex. After `transitionRun(..., "awaiting_plan_approval")` succeeds, emit:

```ts
await input.progress?.emit({
  code: "plan_ready",
  source: "brain",
  revision: revision.revision,
});
```

Extend `HandsWorkItemInput` with `progress?`, `workItemIndex`, and `workItemTotal`. Pass implementation/fix context based on `findings.length`. After the implementation report is saved, emit `implementation_recorded` with the exact attempt coordinates.

- [ ] **Step 4: Integrate Verifier and reflection**

Extend `VerifyWorkItemInput` with `progress?`, `workItemIndex`, and `workItemTotal`. Pass review/final-review context. After `reviews/...json` is saved, map the parsed decision to `verifier_approved`, `verifier_changes`, or `verifier_replan`.

Extend `ReflectionRunInput` with `progress?`. Emit `reflection_started` before accounts, use `reflection_account` and `reflection_synthesis` contexts for Codex, and emit `reflection_recorded` only after both `reflection.json` and `reflection.md` are saved and the manifest is updated.

- [ ] **Step 5: Run focused tests and typecheck**

Run: `npx vitest run tests/workflow/planner.test.ts tests/workflow/worker.test.ts tests/workflow/verifier.test.ts tests/workflow/reflection.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/workflow/planner.ts src/workflow/worker.ts src/workflow/verifier.ts src/workflow/reflection.ts tests/workflow/planner.test.ts tests/workflow/worker.test.ts tests/workflow/verifier.test.ts tests/workflow/reflection.test.ts
git commit -m "feat: record role progress at durable boundaries"
```

---

### Task 6: Instrument deterministic verification safely

**Files:**
- Modify: `src/verification/runner.ts:8-35,223-327`
- Modify: `tests/verification/runner.test.ts`

**Interfaces:**
- Extends `RunVerificationInput` with `progress?: ProgressReporter` and `progressContext?: { workItem: WorkItemCoordinate }`.
- Consumes: `safeToolLabel()` indirectly through the event catalog.

- [ ] **Step 1: Write failing verification progress tests**

Use a Node command that writes a marker and waits briefly. Start `runVerification()` without awaiting it; poll the recording reporter and assert `verification_command_started` appears before the promise settles. Then assert pass/fail, integer `duration_ms`, safe tool fallback, artifact counts, browser counts, and `verification_recorded` after evidence persistence.

Assert serialized progress excludes the complete argv, stdout, stderr, artifact paths, browser names, and fake secret content.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run tests/verification/runner.test.ts`

Expected: FAIL because verification accepts no progress reporter.

- [ ] **Step 3: Add command and evidence events**

Before the command loop, emit `verification_started` or `final_verification_started`. For each command, emit `verification_command_started` before `runCommand()` and a passed/failed event immediately after it returns:

```ts
await input.progress?.emit({
  code: result.exitCode === 0 && !result.timedOut
    ? "verification_command_passed"
    : "verification_command_failed",
  source: "verification",
  workItem: input.progressContext?.workItem,
  operation: {
    index: index + 1,
    total: input.commands.length,
    kind: "command",
    safe_tool: safeToolLabel(executable),
    duration_ms: durationMs,
  },
});
```

Emit artifact/browser start and count-complete intents around the existing builders. Emit `verification_recorded` only after `evidence.json` is successfully written.

- [ ] **Step 4: Run focused tests**

Run: `npx vitest run tests/verification/runner.test.ts tests/progress/events.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/verification/runner.ts tests/verification/runner.test.ts
git commit -m "feat: stream safe verification progress"
```

---

### Task 7: Thread one reporter through runtime, retries, GitHub delivery, and resume

**Files:**
- Modify: `src/workflow/runtime.ts:39-88,152-176,368-429,503-523,532-1535`
- Modify: `tests/workflow/runtime-local.test.ts`
- Modify: `tests/workflow/runtime-github.test.ts`

**Interfaces:**
- Extends `RunLocalWorkflowInput.progress?: ProgressReporter` and therefore `RunGithubWorkflowInput`.
- Passes the same reporter and `{ index, total, attempt, final }` coordinates to Hands, verification, Verifier, and reflection callers.
- Emits fixed runtime/GitHub boundary events.

- [ ] **Step 1: Write failing complete-lifecycle and resume tests**

Add one local test with two work items where the first Verifier requests changes once. Assert the single timeline contains, in order, implementation attempt 1, verification attempt 1, change request, fix attempt 2, verification attempt 2, approval, second item, final verification, final approval, and local delivery.

Add interruption/resume tests from `implementing`, `verifying`, `verifier_review`, `fixing`, and `final_verification`. Open a second reporter over the same file and assert event keys are unique after resume.

Add a GitHub test asserting only fixed labels for issue sync, push, PR ready, and GitHub delivery; serialized progress must not contain issue/PR numbers, branch, remote, SHA, or URL.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run tests/workflow/runtime-local.test.ts tests/workflow/runtime-github.test.ts`

Expected: FAIL because runtime does not accept or propagate progress.

- [ ] **Step 3: Add safe coordinates and role propagation**

At the top of the work-item loop compute:

```ts
const workItem = {
  index: index + 1,
  total: orderedWorkItems.length,
  attempt: Math.max(1, progress?.attempts ?? 1),
  final: false,
};
```

Emit `work_item_implementation` before first Hands and `work_item_fix` before every fix Hands call. Pass `progress`, `workItemIndex`, and `workItemTotal` to Hands and Verifier. Pass `progress` plus updated attempt coordinates to `runVerification()`.

Use `{ index: orderedWorkItems.length + 1, total: orderedWorkItems.length + 1, attempt, final: true }` for the synthetic integrated item so its event keys cannot collide with a real item.

- [ ] **Step 4: Add runtime, GitHub, blocker, and delivery events**

Emit fixed events immediately after the durable boundary succeeds:

- `worktree_preparing` before worktree setup begins.
- `github_sync` when sync begins.
- `changes_committed` after an approved commit returns.
- `branch_pushed` after push returns.
- `pull_request_ready` after the PR reference is persisted and validated.
- `local_delivery_ready` or `github_delivery_ready` after the existing delivery transition and manifest updates succeed.
- `role_failed` before returning `human_action_required`, without blocker text.

Do not emit from `transitionRun()` itself; keep the approval ledger independent and avoid duplicating generic transitions.

- [ ] **Step 5: Run focused runtime tests and typecheck**

Run: `npx vitest run tests/workflow/runtime-local.test.ts tests/workflow/runtime-github.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/workflow/runtime.ts tests/workflow/runtime-local.test.ts tests/workflow/runtime-github.test.ts
git commit -m "feat: report complete workflow progress"
```

---

### Task 8: Add `--follow` producer output and the `logs` command

**Files:**
- Modify: `src/cli.ts:122-151,205-333,350-500`
- Modify: `tests/cli-smoke.test.ts:20-310`

**Interfaces:**
- Consumes: `openProgressReporter()`, `followProgressEvents()`, `formatProgressEvent()`.
- Adds: `--follow` to `run`, `approve-plan`, and `resume`; top-level `logs [runId] --run <runDir> --follow`.

- [ ] **Step 1: Write failing CLI registration and channel tests**

Assert `logs` is registered, producing commands expose `follow`, and `logs` exposes `run`, `repo`, and `follow`.

Spy on `console.log` and `console.error`:

```ts
expect(stderr.mock.calls.flat().join("\n")).toContain("Hands started");
expect(stdout.mock.calls.flat().join("\n")).toContain("local_ready");
```

Add tests that every `--json --follow` combination rejects before workflow mutation. Add a deferred preflight/adapter test proving non-JSON `run` prints the run ID and absolute run directory before planning completes. Add `logs` replay/follow tests and quiescent exit tests for approval, blocked, delivery-ready, and complete manifests.

- [ ] **Step 2: Run the CLI tests and confirm they fail**

Run: `npx vitest run tests/cli-smoke.test.ts`

Expected: FAIL because the flags and command do not exist.

- [ ] **Step 3: Centralize producer reporter construction**

Add:

```ts
function assertFollowOptions(options: Record<string, unknown>): void {
  if (options.json === true && options.follow === true) {
    throw new Error("--json and --follow cannot be used together");
  }
}

async function progressReporterForCommand(
  runDir: string,
  follow: boolean,
): Promise<ProgressReporter> {
  let warned = false;
  return openProgressReporter({
    runDir,
    onEvent: follow ? (event) => console.error(formatProgressEvent(event)) : undefined,
    onWarning: () => {
      if (!warned) console.error("Live progress is unavailable; workflow execution is continuing.");
      warned = true;
    },
  });
}
```

Construct one reporter per producing command and pass it into `planRunV2()`, `executeApprovedRun()`, `runWorkflow()`, and `runReflection()`.

For non-JSON `run`, print `Run <id> started.\nRun directory: <absolute path>` immediately after ledger creation. Keep the existing final approval message.

- [ ] **Step 4: Register and implement `logs`**

Use the same positional/`--run` resolution pattern as `status`. Without follow, iterate `readProgressEvents()` and `console.log(formatProgressEvent(event))`; print `No progress events recorded.` if none. With follow, call `followProgressEvents()` and render each event to stdout because `logs` itself is a log-producing read command, not a workflow producer.

Reject legacy ledgers using `requireV2Manifest()` before replay.

- [ ] **Step 5: Run CLI and dry-run tests**

Run: `npx vitest run tests/cli-smoke.test.ts tests/workflow/e2e-dry-run.test.ts`

Expected: PASS, including deterministic full-lifecycle progress.

- [ ] **Step 6: Commit**

```bash
git add src/cli.ts tests/cli-smoke.test.ts tests/workflow/e2e-dry-run.test.ts
git commit -m "feat: follow workflow progress from the CLI"
```

---

### Task 9: Document the operator contract and run full release verification

**Files:**
- Modify: `README.md`
- Modify: `agentic-codex-workflow.md`
- Modify: `.agents/skills/brain-hands/SKILL.md`

**Interfaces:**
- Documents the stable commands and safety boundaries implemented by Tasks 1-8.

- [ ] **Step 1: Add documentation checks to existing smoke/layout tests**

Extend `tests/skill-layout.test.ts` or `tests/cli-smoke.test.ts` to assert the skill names `logs --follow`, `approve-plan --follow`, and the explicit statement that progress is not approval.

- [ ] **Step 2: Run the focused documentation tests and confirm they fail**

Run: `npx vitest run tests/skill-layout.test.ts tests/cli-smoke.test.ts`

Expected: FAIL because the docs do not describe the new contract.

- [ ] **Step 3: Update README, workflow design, and skill guidance**

Document these exact operator flows:

```text
brain-hands run "<task>" ... --follow
brain-hands logs --follow --run <run-dir>
brain-hands approve-plan <run-id> --revision <n> --follow
brain-hands resume <run-id> --follow
```

State that `progress.jsonl` is safe normalized telemetry, `events.jsonl` is workflow provenance, detailed artifacts remain under their role directories, and only validated/persisted artifacts plus explicit approval determine success.

- [ ] **Step 4: Run the complete verification sequence**

Run, in order:

```bash
npm run typecheck
npm test
npm run build
git diff --check
npm_config_cache=/private/tmp/brain-hands-npm-cache npm pack --dry-run
```

Expected: every command exits 0; package contents remain limited to `dist/`, `prompts/`, `agentic-codex-workflow.md`, `README.md`, `.agents/`, `.codex-plugin/`, and package metadata.

- [ ] **Step 5: Perform a real local CLI smoke without replacing the stable npm command**

Run the development checkout, not `npm link`:

```bash
npm run dev -- run "Verify live progress" --repo . --mode local --no-research --no-reflection --dry-run --follow
```

Expected: progress appears before the final result, the run stops at exact plan approval, and the printed run directory contains valid `progress.jsonl` with no raw prompt or structured result text.

Then approve that dry-run using its printed run ID:

```bash
npm run dev -- approve-plan <run-id> --revision 1 --dry-run --follow
```

Expected: Hands, verification, Verifier, final integration, and local delivery progress appear; the final status is `local_ready`.

- [ ] **Step 6: Commit**

```bash
git add README.md agentic-codex-workflow.md .agents/skills/brain-hands/SKILL.md tests/skill-layout.test.ts tests/cli-smoke.test.ts
git commit -m "docs: explain live workflow progress"
```

## Final Review Checklist

- [ ] `progress.jsonl` is created only for v2 ledgers and cannot be overwritten.
- [ ] Every progress label is produced by the fixed catalog.
- [ ] Raw Codex JSONL is never persisted.
- [ ] Existing final structured artifacts and schemas are unchanged.
- [ ] Plan readiness follows revision recording and manifest transition.
- [ ] Hands recorded status follows report persistence and item provenance.
- [ ] Verifier decision status follows review persistence and provenance.
- [ ] Verification progress contains only ordinals, safe tool family, status, counts, and duration.
- [ ] Resume produces no duplicate semantic keys.
- [ ] Followers read incrementally and exit only at specified quiescent boundaries.
- [ ] `--json` output stays one final JSON value.
- [ ] Progress failures cannot change workflow success or mask the original error.
- [ ] Local and GitHub delivery gates retain their existing tests.
- [ ] Reflection progress contains no reflection text.
- [ ] Full test, typecheck, build, diff, package, and dry-run smoke checks pass.
