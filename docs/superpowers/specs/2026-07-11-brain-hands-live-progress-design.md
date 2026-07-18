# Brain Hands Live Progress Design

## Summary

Brain Hands currently buffers Codex subprocess output until each role finishes,
and deterministic verification commands are also silent until their evidence is
written. A long run can therefore appear idle during Brain planning, Hands
implementation and fixes, verification, Verifier review, final integration, or
reflection.

This change adds one safe, append-only `progress.jsonl` timeline for the entire
v2 workflow. Brain Hands will run structured Codex invocations with
`codex exec --json`, normalize the JSONL stream into an allowlisted event
contract, and add synthetic progress events around deterministic runtime work.
Operators can observe the same timeline through:

- `brain-hands run ... --follow`
- `brain-hands approve-plan <run> --revision N --follow`
- `brain-hands resume <run> --follow`
- `brain-hands logs [--follow] <run>`

Progress remains informational. Existing structured outputs, schemas,
provenance checks, verification evidence, explicit plan approval, and delivery
gates remain authoritative.

## Goals

- Show useful progress throughout the complete v2 run lifecycle.
- Persist one ordered, resumable, human-safe progress timeline per run.
- Support replay, second-terminal attachment, and same-terminal following.
- Prevent prompts, reasoning, generated content, commands, patches, findings,
  artifact paths, tool payloads, and secrets from entering the safe timeline.
- Preserve machine-readable CLI output and all approval and delivery semantics.
- Make progress idempotent across the runtime's existing resume boundaries.
- Use reusable streaming infrastructure for Brain, Hands, Verifier, and
  reflection Codex calls.

## Non-goals

- Streaming an incomplete plan, implementation report, review, or reflection.
- Showing chain-of-thought, reasoning summaries, command output, or findings.
- Persisting raw Codex JSONL stdout.
- Replacing detailed run artifacts or the approval-critical event ledger.
- Building a TUI, spinner framework, or remote web dashboard.
- Inferring failure from inactivity or from a process disappearing without a
  recorded workflow transition.
- Changing retry counts, work-item ordering, GitHub behavior, or reflection
  policy.

## Existing System

`src/adapters/codex.ts` renders structured `codex exec` commands with
`--output-schema` and `--output-last-message`, then calls the buffered
`runCommand()` helper in `src/core/executor.ts`. The adapter persists stdout and
stderr only after the process exits and validates the final output file.

Brain, Hands, Verifier, and reflection all use the Codex adapter with distinct
artifact names. `src/workflow/runtime.ts` coordinates implementation attempts,
deterministic verification, Verifier decisions, fix loops, final integrated
verification, commits, GitHub delivery, and resume behavior.

The v2 run already contains two evidence concepts:

- `events.jsonl` is the append-only Brain Hands workflow ledger used for stage,
  approval, verification, and delivery provenance.
- `prompts/`, `responses/`, `implementation/`, `verification/`, and `reviews/`
  hold detailed role and evidence artifacts.

The new progress timeline is a third concept. It must not reuse
`events.jsonl`, because human-facing telemetry has different stability and
confidentiality requirements from approval-critical provenance.

## Considered Approaches

### One progress file per Codex invocation

This preserves invocation boundaries, but a complete run follower must discover
new files, merge them with deterministic runtime events, and reconstruct global
ordering. Resume and fix loops make that unnecessarily complex.

### One run-level safe progress timeline

This is the selected approach. Every role and deterministic workflow operation
appends normalized records to `progress.jsonl`. One writer contract provides
global sequence numbers, resume deduplication, and one source for all CLI
followers.

### Derive progress from manifests and existing artifacts

This avoids a new artifact but cannot show activity inside long Codex calls or
verification commands. Polling saved artifacts also creates ambiguous ordering
and cannot distinguish active work from a stalled producer.

## Evidence Boundaries

Each run has three distinct layers:

```text
events.jsonl
  Approval-critical state transitions and delivery provenance

progress.jsonl
  Safe, ordered, human-facing live progress for the entire run

prompts/, responses/, implementation/, verification/, reviews/
  Detailed audit artifacts with their existing access expectations
```

`progress.jsonl` is the only source consumed by `logs` and the `--follow`
options. Detailed artifacts do not become terminal progress, and progress
records never become approval evidence.

## Architecture

Codex-backed progress follows this path:

```text
codex exec --json stdout
          |
          v
streaming executor
          | complete JSONL records
          v
role-aware Codex event normalizer
          |
          v
run-level safe progress writer
          |
          v
progress.jsonl
          |
          v
safe progress formatter and follower
```

Deterministic workflow progress follows this path:

```text
runtime / verification boundary
          |
          v
typed safe event constructor
          |
          v
the same run-level progress writer
```

The implementation should use five focused units:

1. A streaming executor reports stdout chunks and still returns process status
   and bounded diagnostic metadata.
2. A JSONL framer emits complete records in arrival order while retaining an
   incomplete suffix.
3. A role-aware Codex normalizer projects recognized upstream events into
   predefined Brain Hands events.
4. A run-level progress writer validates records, assigns sequence numbers,
   deduplicates semantic keys, and appends serially.
5. A follower replays and tails validated records and renders safe labels.

Runtime and verification code never construct arbitrary progress labels. They
call typed helpers that select labels from the same fixed catalog used by the
Codex normalizer.

## Safe Progress Event Contract

The durable record is owned and versioned by Brain Hands:

```ts
interface SafeProgressEvent {
  schema_version: 1;
  sequence: number;
  event_key: string;
  timestamp: string;
  source:
    | "brain"
    | "hands"
    | "verification"
    | "verifier"
    | "runtime"
    | "github"
    | "reflection";
  phase:
    | "starting"
    | "planning"
    | "implementation"
    | "fixing"
    | "verification"
    | "review"
    | "integration"
    | "delivery"
    | "reflection"
    | "awaiting_approval"
    | "warning"
    | "failed";
  status: "started" | "in_progress" | "completed" | "warning" | "failed";
  safe_label: string;
  work_item?: {
    index: number;
    total: number;
    attempt: number;
    final: boolean;
  };
  operation?: {
    index: number;
    total: number;
    kind:
      | "command"
      | "browser_check"
      | "artifact_check"
      | "commit"
      | "push";
    safe_tool?: string;
    duration_ms?: number;
  };
  usage?: {
    input_tokens: number;
    cached_input_tokens: number;
    output_tokens: number;
    reasoning_output_tokens: number;
  };
}
```

All fields are required unless marked optional. No additional properties are
permitted. Each record is schema-validated before append and again when read.

`sequence` starts at 1 and increases across the entire run, including resumes.
`timestamp` is assigned when Brain Hands accepts the event because upstream
Codex events do not guarantee timestamps.

`event_key` is a deterministic semantic identity based only on safe coordinates,
for example:

```text
brain:planning:started
hands:item:1:attempt:2:started
verification:item:1:attempt:2:command:3:completed
verifier:item:1:attempt:2:decision:request_changes
runtime:integrated:delivery:completed
```

The key makes resume idempotent. It is not an approval or delivery identifier.

## Safe Labels and Dynamic Values

Every `safe_label` comes from a Brain Hands-owned template. Model output and
exception text are never interpolated.

Allowed dynamic values are limited to:

- Positive integer ordinals, totals, attempts, and revision numbers.
- Boolean final-review state.
- Token usage reported as non-negative integers.
- Durations rounded to one decimal second for display and stored as
  non-negative integer milliseconds.
- Reasoning effort from the existing enum.
- A model identifier only when it matches a strict length and character
  allowlist; otherwise display `configured model`.
- An executable basename only when it is in an explicit safe-tool allowlist;
  otherwise display `command`.

The initial safe-tool allowlist is `npm`, `pnpm`, `yarn`, `node`, `npx`,
`vitest`, `jest`, `pytest`, `python`, `python3`, `go`, and `cargo`. Arguments are
never shown.

## Brain Progress Mapping

| Trigger | Safe label |
| --- | --- |
| Invocation begins | `Brain started - <model>/<effort>` |
| `turn.started` | `Planning started` |
| First `command_execution` item | `Inspecting repository` |
| First `web_search` item | `Researching sources` |
| First `reasoning` or `todo_list` item | `Drafting work items` |
| `turn.completed` | `Brain turn completed` plus numeric usage |
| Final output read begins | `Validating structured plan` |
| JSON and schema validation pass | `Structured plan validated` |
| Revision recording and manifest transition pass | `Plan revision N ready for approval` |

`turn.completed` is not planning success. The approval-ready event is appended
only after `recordPlan()` succeeds and the manifest reaches
`awaiting_plan_approval`.

## Hands Progress Mapping

| Trigger | Safe label |
| --- | --- |
| Runtime selects an unimplemented item | `Work item X of Y - implementation attempt N` |
| Runtime starts a fix cycle | `Work item X of Y - fix attempt N` |
| Invocation begins | `Hands started - <model>/<effort>` |
| First `reasoning` or `todo_list` item | `Working through implementation` |
| First `command_execution` item | `Running implementation checks` |
| First `file_change` item | `Applying approved changes` or `Applying approved fixes` |
| `turn.completed` | `Hands turn completed` plus numeric usage |
| Final output read begins | `Validating Hands result` |
| Schema and expected work-item provenance pass | `Hands result validated` |
| Implementation report is saved | `Implementation attempt N recorded` |

The normalizer receives safe invocation context from the caller: role, work-item
ordinal and total, attempt, final state, and whether the invocation is an
implementation or fix. It does not parse artifact names or work-item IDs to
recover that context.

## Deterministic Verification Progress

Each verification pass emits:

```text
Verification started - attempt N
Verification 1 of M - running npm
Verification 1 of M - passed - 12.4s
Verification 2 of M - running command
Verification 2 of M - failed - 3.1s
Checking required artifacts
Required artifacts - 3 of 3 present
Checking browser evidence
Browser evidence - 2 of 2 present
Verification evidence recorded
```

The runtime emits command-start before awaiting `runCommand()` and command-end
after it returns. Pass or fail reflects the actual exit status and timeout
metadata, but output and error text remain only in existing verification
artifacts.

Artifact and browser checks emit counts only. Names, paths, screenshots, URLs,
and failure reasons never enter progress.

Final integrated verification uses `final: true` context and labels its first
event `Final integrated verification started`.

## Verifier Progress Mapping

| Trigger | Safe label |
| --- | --- |
| Invocation begins | `Verifier started - <model>/<effort>` |
| First `command_execution` item | `Inspecting saved evidence` |
| First `reasoning` or `todo_list` item | `Reviewing acceptance criteria` |
| `turn.completed` | `Verifier turn completed` plus numeric usage |
| Final output read begins | `Validating Verifier result` |
| Schema and review provenance pass | `Verifier result validated` |
| Review artifact is saved with `approve` | `Verifier approved work item X` |
| Review artifact is saved with `request_changes` | `Verifier requested changes` |
| Review artifact is saved with `replan_required` | `Verifier requires replanning` |

Final integrated review uses `Final Verifier review started` and, on approval,
`Final Verifier approved delivery`.

No decision event is emitted from model text or an unpersisted object. The
structured review must pass schema validation, match the expected item, attempt,
and final flag, and be saved under `reviews/` first.

## Runtime, GitHub, and Reflection Progress

Typed runtime helpers add safe events around:

- Isolated worktree preparation.
- GitHub issue synchronization.
- Approved commit creation.
- Branch push.
- Pull-request creation or verification.
- Fix-loop transitions.
- Final integrated verification and review.
- Local or GitHub delivery readiness.
- Reflection synthesis, when enabled.

Representative labels are:

```text
Preparing isolated worktree
Synchronizing GitHub work items
Approved changes committed
Branch pushed
Pull request ready
Reflection started
Reflection recorded
Run ready for local delivery
Run ready for GitHub delivery
```

Issue numbers, PR numbers, branch names, commit hashes, remotes, URLs, findings,
and blocker text remain in their current manifest or artifact locations.

Reflection Codex calls use the same JSONL normalizer but emit only generic
`Analyzing run evidence` and `Synthesizing reflection` states. Reflection text
is never shown before its structured artifact is validated and saved.

## Codex Event Handling

The normalizer uses only top-level event type, item type, terminal status, and
numeric token usage. It never copies an upstream event and deletes fields.

Recognized top-level families are `thread.started`, `turn.started`,
`turn.completed`, `turn.failed`, `item.started`, `item.updated`,
`item.completed`, and `error`. Recognized item categories are limited to those
needed for fixed role mappings.

Unknown top-level or item types are ignored. This is forward-compatible with
additive Codex event changes and prevents new payload fields from being
persisted accidentally.

A top-level `error` or `turn.failed` creates a generic role failure event. An
item whose type is `error` creates a generic warning because item-level errors
can be non-fatal. The process exit code and final structured artifact remain
authoritative.

## Data Exclusion and Secret Safety

The following data must never be persisted or displayed by progress:

- Prompt, task, plan, implementation, review, finding, or reflection text.
- Agent-message or reasoning text.
- Work-item IDs and titles.
- Command strings, arguments, output, environment values, or error messages.
- File names, paths, contents, diffs, or patch bodies.
- MCP or collaboration tool names, arguments, prompts, results, or errors.
- Web-search queries, result titles, or URLs.
- Artifact names, screenshot paths, and browser-check names.
- Issue and pull-request numbers, branch names, commit hashes, remotes, and URLs.
- Unknown upstream payloads.

The security boundary is constructive allowlisting: build a new record from
typed safe values. Regex redaction is a secondary defense only for bounded
stderr diagnostics.

Raw Codex JSONL stdout is processed in memory and is not persisted. Structured
final output remains in the existing `responses/<artifact>.json` file because
it is a deliberate, validated workflow artifact.

For streamed invocations, `CodexInvokeResult.progressPath` identifies the
run-level timeline. The legacy `stdoutPath` field points to the safe progress
artifact for compatibility and never to raw JSONL.

Stderr is not used for progress. Before persistence it is redacted and capped
to a documented maximum. Truncation is recorded without copying discarded
content.

## JSONL Framing and Persistence

Stdout can split one JSON object across chunks or combine several records in
one chunk. The framer:

1. Appends decoded chunks to a carry buffer.
2. Emits newline-terminated records in order.
3. Retains the incomplete suffix.
4. Processes a non-empty final suffix when the stream closes.

The framer enforces a maximum record size. An oversized or malformed record is
skipped with a payload-free warning. Progress parsing problems do not make a
valid final structured result fail and do not make an invalid result succeed.

The progress writer creates `progress.jsonl` when the v2 ledger is created.
All writes pass through one append queue so sequence numbers cannot race and
readers never observe interleaved JSON.

`writeTextArtifact()` rejects attempts to overwrite `progress.jsonl`, matching
the existing protection for `events.jsonl`.

## Resume and Deduplication

When a producer starts or resumes, the progress writer:

1. Streams and validates existing complete records.
2. Recovers the highest sequence number.
3. Builds a set of existing deterministic event keys.
4. Ignores a final incomplete line until it is completed.
5. Skips event keys already present.
6. Appends new events with the next sequence number.

The file must be read as a stream rather than with an unbounded
`readFile().split()` operation.

A malformed newline-terminated historical record produces a generic reader
warning and is skipped without exposing its content. It does not reset the
sequence or discard later valid records.

The workflow assumes one active producer for a run. Followers are read-only.
This feature does not add multi-producer workflow execution.

## CLI Behavior

### Producing commands

Every command that can perform workflow work accepts `--follow`:

```text
brain-hands run ... --follow
brain-hands approve-plan <run> --revision N --follow
brain-hands resume <run> --follow
```

Progress is rendered to stderr. The existing final human or JSON result remains
on stdout.

`--json --follow` is rejected with a usage error for every producing command.
Successful `--json` output remains one final JSON value with no progress lines.

Non-JSON `run` prints the run ID and absolute run directory immediately after
ledger creation, before preflight. This enables second-terminal attachment even
without same-terminal following.

### Logs command

`logs` accepts a run ID or directory with the same resolution rules as
`status`:

```text
brain-hands logs <run-id>
brain-hands logs --run <run-dir>
brain-hands logs --follow <run-id>
brain-hands logs --follow --run <run-dir>
```

Without `--follow`, it streams and renders existing valid records, then exits.
If the file contains no records, it reports that progress is not available and
exits successfully.

With `--follow`, it replays history, then reads appended complete lines without
duplicating them. It drains remaining records and exits successfully at a
quiescent boundary:

- `awaiting_plan_approval`.
- `replanning`.
- A recorded blocker requiring human action.
- Local delivery ready.
- Pull request ready.
- `complete`.

The user can invoke `logs --follow` again after approving or resuming the run.
If a producer dies without recording a boundary, the follower waits until
interrupted; it does not infer failure from inactivity.

The formatter emits one line per event and does not use ANSI control sequences
when stderr is not a TTY.

## Workflow Success and Failure Semantics

Progress is observational and never changes an approval or delivery decision.

- Codex success still requires exit code zero, the output-last-message file,
  valid JSON, the role schema, and role-specific provenance checks.
- Verification success still uses saved command, artifact, and browser evidence.
- Verifier approval still requires a saved matching structured review.
- Delivery still requires the existing final verification and final Verifier
  review provenance.
- Plan approval remains an explicit human action for an exact recorded revision.

A progress normalization failure does not change workflow success. If an append
fails, the producer prints one generic warning to stderr, disables further live
progress for that process, and continues the underlying workflow. The original
workflow error always wins over a progress error.

Before throwing, role and runtime boundaries attempt to append one generic
failure event. Failure to append it must not replace the original error.

Invalid structured output never emits validated, recorded, decision, approval,
or delivery-ready progress.

## Dry-run Behavior

Dry-run uses the same progress writer and emits a deterministic complete
lifecycle without fabricating Codex thread IDs, commands, searches, usage,
files, or findings.

A successful local dry-run includes:

1. Brain planning and validated revision.
2. Approval boundary.
3. Hands implementation.
4. Deterministic verification.
5. Verifier approval.
6. Final integrated verification and review.
7. Local delivery readiness.
8. Reflection progress when reflection is enabled.

## Testing

### Executor and framing tests

- A record split across arbitrary stdout chunks is emitted once.
- Several records in one chunk are emitted in order.
- A final record without a newline is processed at stream close.
- Oversized and malformed records produce payload-free warnings.
- Progress becomes readable before the subprocess exits.
- Raw JSONL is never persisted.

### Progress writer and reader tests

- Sequence numbers remain monotonic across rapid events and resumes.
- Deterministic keys prevent duplicates after resume.
- Existing files are read as streams, not loaded wholesale.
- An incomplete trailing line is tolerated.
- A malformed historical line does not expose content or block later records.
- General artifact writes cannot overwrite `progress.jsonl`.
- A failed progress append leaves the underlying workflow result unchanged.

### Safety tests

- Prompts, agent text, reasoning, commands, arguments, output, patches,
  findings, files, tool payloads, artifact paths, URLs, and representative fake
  secrets are absent from the progress file and rendered output.
- Unknown upstream event and item types are ignored.
- Unrecognized executable and unsafe model identifiers use generic labels.
- Artifact and browser progress contains counts only.

### Role mapping tests

- Brain readiness appears only after revision recording and manifest transition.
- Hands recorded status appears only after schema, work-item provenance, and
  implementation report persistence.
- Verification command-start is visible before command completion.
- Command pass, failure, timeout, and rounded duration map correctly.
- Verifier decisions appear only after review schema, provenance, and durable
  persistence.
- Final review uses final-specific labels.
- Reflection exposes only generic phases.

### Runtime and resume tests

- Multiple work items share one ordered timeline.
- Multiple fix attempts use distinct deterministic keys.
- Resume from implementing, verifying, verifier review, fixing, and final
  verification does not duplicate completed progress.
- GitHub issue sync, commit, push, PR readiness, local delivery, and GitHub
  delivery use fixed safe labels.
- Blocked and replanning flows stop followers at the human boundary.

### CLI tests

- `run --follow`, `approve-plan --follow`, and `resume --follow` write progress
  to stderr and preserve final stdout.
- All producing commands reject `--json --follow`.
- Non-JSON `run` prints the run ID and directory before planning completes.
- `logs` accepts positional runs and the `--run` alias.
- `logs` replays history without loading the whole file.
- `logs --follow` renders appended records without duplicating history.
- Followers exit after draining at every quiescent boundary.
- Full-lifecycle dry-run progress is deterministic.

### Regression verification

- Existing planner, worker, verifier, runtime, ledger, status, approval,
  reflection, GitHub, and dry-run tests retain their meaning and pass.
- `npm run typecheck`, `npm test`, `npm run build`, and `git diff --check` pass.
- Before stable publication, `npm pack --dry-run` also passes as required by
  repository operating instructions.

## Documentation

Update the README and operator workflow documentation with:

- `--follow` on every producing command.
- `logs` replay and follow usage.
- The distinction between progress, workflow provenance, and detailed artifacts.
- The location and safe content contract of `progress.jsonl`.
- Resume and quiescent-boundary behavior.
- The guarantee that progress cannot approve a plan or delivery.

## Acceptance Criteria

- A real long-running run shows safe progress during Brain, Hands, deterministic
  verification, Verifier, fix loops, final integration, delivery, and optional
  reflection.
- Another terminal can attach, replay history, follow new events, and exit at
  the next human or terminal boundary.
- `progress.jsonl` is append-only, ordered, schema-valid, resumable, and free of
  all prohibited free-form upstream data.
- Resume does not duplicate previously recorded semantic events.
- No plan appears ready before validation, revision recording, and the approval
  boundary.
- No implementation or Verifier decision appears recorded before its structured
  artifact passes provenance checks and is saved.
- Existing verification, approval, and delivery gates remain the only success
  criteria.
- Existing `--json` automation receives one final JSON value.
