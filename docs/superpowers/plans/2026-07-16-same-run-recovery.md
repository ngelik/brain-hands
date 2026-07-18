# Same-Run Recovery, Controller Transition, and Replacement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Do not spawn subagents unless the user explicitly requests them. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recover ordinary Brain Hands failures inside one durable run, stop repeated no-progress effects, attest changed self-hosting controllers, and create a fresh linked replacement only after explicit abandonment.

**Architecture:** The existing review-policy engine remains the sole finding-driven decision authority and gains one explicit bounded `quality_recovery` action. An orthogonal recovery guard uses immutable observations, content-derived progress subjects, stable effect-attempt IDs, and a reconcilable journal to allow or refuse the next effect. Controller transitions and replacement runs use chained create-once artifacts; replacement never carries approval or GitHub effects across runs.

**Tech Stack:** TypeScript 6, Node.js 20+, Zod 4, Commander 15, Vitest 4, existing Brain Hands ledger and owned-evidence primitives.

## Global Constraints

- Implement Phases 1 through 4 together; do not publish or install a partial feature.
- Work directly on `main`; do not create a feature branch unless the user asks.
- Preserve unrelated working-tree changes and never reformat adjacent code.
- Ordinary model, invocation, implementation, verification, and replanning failures remain in the same run.
- Review policy is the only authority that chooses `fix`, `quality_recovery`, `create_replan`, `await_plan_approval`, `continue_with_warning`, `advance`, or `stop` from Verifier findings.
- Recovery may allow or refuse a requested effect; it may not replace one review-policy action with another.
- The initial implementation is not a fix cycle.
- Permit at most three successful primary fix cycles and one configured quality-recovery cycle per work item.
- Operational and test-infrastructure failures do not consume fix cycles.
- Replay of one persisted effect-attempt ID is idempotent.
- Two distinct attempts with the same blocker fingerprint and progress subject enter diagnostic stop before a third effect launches.
- Operator recovery notes authorize one new attempt but never count as material progress.
- A changed self-hosting controller requires the operator to supply the exact expected package SHA-256 before resume.
- Replacement requires an already terminal, explicitly abandoned predecessor.
- Replacement receives fresh discovery, plan, approval, warning authority, risk, recovery, worktree, branch, issue, and pull-request state.
- Do not implement cross-run approval reuse, issue reuse, pull-request reuse, worktree reuse, branch reuse, or risk-acceptance reuse.
- Old v2 manifests must remain readable and resumable without an eager rewrite.
- Do not change the package version, publish to npm, or install the package globally.

---

## File Structure

**Create:**

- `src/workflow/recovery-policy.ts` — pure blocker/progress hashing and recovery-guard transitions.
- `src/workflow/recovery-ledger.ts` — immutable decision journal, reconciliation, authorization, and effect-attempt claims.
- `src/workflow/recovery-runtime.ts` — owned-evidence hashing and adapters between runtime effects and the recovery journal.
- `src/workflow/controller-recovery.ts` — controller-subject hashing and chained transition artifacts.
- `src/workflow/run-start.ts` — shared run bootstrap used by `run` and replacement without invoking discovery automatically.
- `src/workflow/replacement.ts` — reservation, successor backlink, and predecessor completion handshake.
- `tests/workflow/recovery-policy.test.ts`
- `tests/workflow/recovery-ledger.test.ts`
- `tests/workflow/recovery-runtime.test.ts`
- `tests/workflow/controller-recovery.test.ts`
- `tests/workflow/run-start.test.ts`
- `tests/workflow/replacement.test.ts`

**Modify:**

- `src/core/types.ts` — recovery, lineage, controller-transition, authorization, and replacement contracts.
- `src/core/schema.ts` — strict schemas and backward-compatible defaults.
- `src/core/ledger.ts` — initialization, immutable fields, monotonic pointers, deterministic events, and reserved run IDs.
- `src/core/controller-provenance.ts` — canonical controller subject versus full audit snapshot.
- `src/workflow/review-policy.ts` — first-class bounded quality-recovery decision.
- `src/workflow/review-cycle.ts` — quality-recovery cycle/effect transitions.
- `src/workflow/convergence.ts` — treat quality recovery as an effect, not a convergence report.
- `src/workflow/hands-recovery.ts` — legacy adapter to canonical policy semantics.
- `src/workflow/runtime.ts` — local, GitHub, integrated, post-PR, and invocation-blocker integration.
- `src/workflow/status.ts` — reconciliation and diagnostic/lineage projection.
- `src/cli.ts` — diagnostic resume options, controller recovery, shared run start, and replacement.
- `README.md`, `agentic-codex-workflow.md`, `.agents/skills/brain-hands/SKILL.md` — operator contract.
- Existing unit, runtime, CLI, skill-layout, and built-CLI tests listed by each task.

---

## Execution Preflight

Before Task 1, run:

```bash
git branch --show-current
git status --short --branch
git rev-parse HEAD
git rev-parse main
```

Expected: branch output is `main`; HEAD equals `main`; unrelated changes, if any,
are identified and left untouched. The planning workspace that produced this file
was detached at `v0.4.0`, so implementation must first move or hand off these two
documentation files to the writable `main` checkout. Do not create a feature branch
to work around the detached planning workspace.

Run the Task 1 focused tests once before editing to establish the baseline. If a
baseline test already fails, stop and record the exact existing failure before
changing recovery code.

---

### Task 1: Add strict recovery and lineage contracts

**Files:**

- Modify: `src/core/types.ts`
- Modify: `src/core/schema.ts`
- Modify: `tests/core/schema.test.ts`
- Modify: `tests/fixtures/legacy-run.ts`

**Interfaces:**

- Consumes: existing `RunManifestV2`, `RunStageV2`, `ReviewPolicyAction`, `HandsProfileKind`.
- Produces: `RecoveryDisposition`, `RecoveryScopeStateV1`, `RunRecoveryStateV1`, `TaskLineageV1`, `ControllerRecoveryStateV1`, and their exported Zod schemas.

- [ ] **Step 1: Add failing schema-default tests**

Add tests that remove the new fields from a valid v2 manifest and assert these parsed defaults:

```ts
expect(runManifestV2Schema.parse(legacyManifest)).toMatchObject({
  recovery: { version: 1, active_scope: null, scopes: {} },
  task_lineage: null,
  controller_recovery: { version: 1, transition_count: 0, head_path: null },
});
```

Add malformed-state cases:

```ts
expect(() => recoveryScopeStateV1Schema.parse({
  version: 1,
  head_sequence: -1,
  head_decision_path: null,
  blocker_fingerprint: null,
  progress_subject_sha256: null,
  consecutive_without_progress: 0,
  disposition: "active",
  diagnostic_path: null,
  authorization_path: null,
})).toThrow();

expect(() => taskLineageV1Schema.parse({
  version: 1,
  lineage_id: "task-lineage:not-a-hash",
  root_run_id: "root",
  predecessor_run_id: null,
  predecessor_abandonment_sha256: "bad",
})).toThrow();
```

- [ ] **Step 2: Run the focused test and confirm failure**

Run:

```bash
npx vitest run tests/core/schema.test.ts
```

Expected: FAIL because the recovery and lineage schemas and manifest fields do not exist.

- [ ] **Step 3: Add the TypeScript contracts**

Add this exact shape to `src/core/types.ts`:

```ts
export type RecoveryDisposition =
  | "active"
  | "awaiting_external_fix"
  | "diagnostic_stop"
  | "exhausted";

export interface RecoveryScopeStateV1 {
  version: 1;
  head_sequence: number;
  head_decision_path: string | null;
  blocker_fingerprint: string | null;
  progress_subject_sha256: string | null;
  consecutive_without_progress: number;
  disposition: RecoveryDisposition;
  diagnostic_path: string | null;
  authorization_path: string | null;
}

export interface RunRecoveryStateV1 {
  version: 1;
  active_scope: string | null;
  scopes: Record<string, RecoveryScopeStateV1>;
}

export interface TaskLineageV1 {
  version: 1;
  lineage_id: `task-lineage:${string}`;
  root_run_id: string;
  predecessor_run_id: string | null;
  predecessor_abandonment_sha256: string | null;
}

export interface ControllerRecoveryStateV1 {
  version: 1;
  transition_count: number;
  head_path: string | null;
}
```

Add to `RunManifestV2`:

```ts
recovery: RunRecoveryStateV1;
task_lineage: TaskLineageV1 | null;
controller_recovery: ControllerRecoveryStateV1;
```

- [ ] **Step 4: Add strict Zod schemas and manifest defaults**

Export strict schemas. Use `safeEvidenceRefSchema` for artifact paths and
`/^[a-f0-9]{64}$/` for hashes. Add a `superRefine` rule requiring:

```ts
state.head_sequence === 0
  ? state.head_decision_path === null
  : state.head_decision_path !== null;
```

Require `diagnostic_path` only for `diagnostic_stop`, require
`authorization_path` only when non-null, and allow it to coexist with `active`
while one authorized effect is pending.

- [ ] **Step 5: Update the legacy fixture and run tests**

Keep the legacy fixture free of explicit new fields so schema defaults are
exercised.

Run:

```bash
npx vitest run tests/core/schema.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit Task 1**

```bash
git add src/core/types.ts src/core/schema.ts tests/core/schema.test.ts tests/fixtures/legacy-run.ts
git commit -m "feat: add recovery and lineage contracts"
```

---

### Task 2: Initialize new runs and enforce immutable/monotonic ledger state

**Files:**

- Modify: `src/core/ledger.ts`
- Modify: `tests/core/ledger.test.ts`

**Interfaces:**

- Consumes: Task 1 manifest fields and schemas.
- Produces: `taskLineageId(rootRunId)`, reserved `runId` support, immutable lineage, and monotonic recovery/controller pointers.

- [ ] **Step 1: Add failing initialization tests**

Create a new ledger and assert:

```ts
expect(ledger.manifest.recovery).toEqual({
  version: 1,
  active_scope: null,
  scopes: {},
});
expect(ledger.manifest.task_lineage).toEqual({
  version: 1,
  lineage_id: expect.stringMatching(/^task-lineage:[a-f0-9]{64}$/),
  root_run_id: ledger.runId,
  predecessor_run_id: null,
  predecessor_abandonment_sha256: null,
});
expect(ledger.manifest.controller_recovery).toEqual({
  version: 1,
  transition_count: 0,
  head_path: null,
});
```

Add reserved-ID tests:

```ts
await expect(createRunLedgerV2({
  repoRoot,
  originalRequest: "reserved",
  runId: "reserved-successor-01",
})).resolves.toMatchObject({ runId: "reserved-successor-01" });

await expect(createRunLedgerV2({
  repoRoot,
  originalRequest: "escape",
  runId: "../escape",
})).rejects.toThrow("Reserved run ID is invalid");
```

- [ ] **Step 2: Add failing mutation-guard tests**

Prove that `task_lineage` cannot change after creation, recovery head sequence
cannot decrease or skip, and controller transition count cannot decrease or jump
without a new head path.

- [ ] **Step 3: Run the ledger test and confirm failure**

```bash
npx vitest run tests/core/ledger.test.ts
```

Expected: FAIL because run initialization and guards do not yet know the new fields.

- [ ] **Step 4: Implement deterministic root lineage**

Add:

```ts
export function taskLineageId(rootRunId: string): `task-lineage:${string}` {
  return `task-lineage:${createHash("sha256")
    .update(`brain-hands-task-lineage-v1\0${rootRunId}`)
    .digest("hex")}`;
}
```

Extend `CreateRunLedgerV2Input`:

```ts
runId?: string;
taskLineage?: TaskLineageV1;
```

Validate reserved IDs with:

```ts
const RESERVED_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,191}$/;
```

Reject `.` and `..` explicitly even though the regex rejects them as complete
values. Continue using atomic `mkdir(runDir)` so replay sees `EEXIST` rather than
overwriting a successor.

- [ ] **Step 5: Implement manifest mutation invariants**

Exclude `task_lineage` from `MutableRunManifestV2Patch`. In
`writeManifestV2Atomic`, require:

- lineage bytes never change;
- each scope head stays equal or advances by exactly one;
- an advanced head changes `head_decision_path`;
- controller transition count stays equal or advances by exactly one;
- an advanced controller count changes `head_path`;
- terminal runs retain the existing exception that permits only append-only
  `final_artifact_paths`.

- [ ] **Step 6: Create required directories for new runs**

Add these initial directories without changing legacy run layout eagerly:

```text
recovery/scopes
controller-recovery/transitions
lineage
replacement
```

Recovery helpers must lazily create validated subdirectories for old runs.

- [ ] **Step 7: Run focused verification**

```bash
npx vitest run tests/core/ledger.test.ts tests/core/schema.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit Task 2**

```bash
git add src/core/ledger.ts tests/core/ledger.test.ts
git commit -m "feat: initialize durable recovery state"
```

---

### Task 3: Make bounded quality recovery a canonical review-policy action

**Files:**

- Modify: `src/core/types.ts`
- Modify: `src/core/schema.ts`
- Modify: `src/workflow/review-policy.ts`
- Modify: `src/workflow/review-cycle.ts`
- Modify: `src/workflow/convergence.ts`
- Modify: `src/workflow/hands-recovery.ts`
- Modify: `tests/workflow/review-policy.test.ts`
- Modify: `tests/workflow/review-cycle.test.ts`
- Modify: `tests/workflow/convergence.test.ts`
- Modify: `tests/workflow/hands-recovery.test.ts`

**Interfaces:**

- Consumes: existing review policy, accounting, Hands backup policy, and progress.
- Produces: `QualityRecoveryEligibility` and `ReviewPolicyAction = ... | "quality_recovery"`.

- [ ] **Step 1: Add failing policy-order tests**

Add a helper input with `fix_cycles_used: 3` and assert:

```ts
expect(evaluateReviewPolicy({
  ...baseInput,
  findings: [blockingFinding],
  accounting: { ...baseInput.accounting, fix_cycles_used: 3 },
  quality_recovery: {
    configured: true,
    active_hands_profile: "primary",
    attempts_used: 0,
  },
})).toMatchObject({
  action: "quality_recovery",
  reason_code: "bounded_quality_recovery_available",
});
```

Add cases proving:

- `requires_replan` wins over quality recovery;
- critical/high release blockers win;
- pending replan approval wins;
- active backup profile is ineligible;
- `attempts_used: 1` is ineligible;
- absent backup is ineligible;
- after ineligibility the existing `on_limit` result is unchanged.

- [ ] **Step 2: Add failing cycle/effect tests**

Assert `quality_recovery` receives the same deterministic effect claim behavior as
`fix`, transitions to `fixing`, and does not produce a convergence report before
execution.

- [ ] **Step 3: Run focused tests and confirm failure**

```bash
npx vitest run \
  tests/workflow/review-policy.test.ts \
  tests/workflow/review-cycle.test.ts \
  tests/workflow/convergence.test.ts \
  tests/workflow/hands-recovery.test.ts
```

Expected: FAIL because `quality_recovery` is not a review-policy action.

- [ ] **Step 4: Add the exact eligibility contract**

```ts
export interface QualityRecoveryEligibility {
  configured: boolean;
  active_hands_profile: HandsProfileKind;
  attempts_used: 0 | 1;
}
```

Add `quality_recovery: QualityRecoveryEligibility` to
`EvaluateReviewPolicyInput`. Add `quality_recovery` to the action schema and
review-cycle decision schema.

Update every existing `EvaluateReviewPolicyInput` fixture and runtime caller with
an explicit eligibility snapshot. Do not add a default inside
`evaluateReviewPolicy`; callers must prove whether backup is configured, active,
and unused.

- [ ] **Step 5: Implement the selected decision order**

In `evaluateReviewPolicy`, insert quality recovery only after ordinary fix budget
is exhausted and before `on_limit`:

```ts
if (
  input.quality_recovery.configured
  && input.quality_recovery.active_hands_profile === "primary"
  && input.quality_recovery.attempts_used === 0
) {
  return decision(
    "quality_recovery",
    "bounded_quality_recovery_available",
    blocking,
    input,
  );
}
```

- [ ] **Step 6: Update effect transitions and convergence**

Map `quality_recovery` to `fixing` in review-cycle transitions. Treat both `fix`
and `quality_recovery` as effect actions that do not emit a convergence report.
Keep their effect IDs distinct because the decision action participates in the
cycle hash.

Extend successful-fix reservation input and artifacts with:

```ts
effect_action: "fix" | "quality_recovery";
```

Ordinary `fix` must retain the current `fix_cycles_used < max_fix_cycles` check.
`quality_recovery` must require `fix_cycles_used === max_fix_cycles`, configured
backup, primary active profile, and `quality_recovery_attempts === 0`. A successful
quality-recovery completion increments `fix_cycles_used` once to
`max_fix_cycles + 1` and sets `quality_recovery_attempts: 1`. Update marker replay
validation so a reservation cannot change action after creation.

- [ ] **Step 7: Reduce `hands-recovery.ts` to a legacy adapter**

Preserve the exported legacy API, but make its quality-recovery eligibility match
the canonical order. Add a comment stating that policy-enabled v2 paths must call
`evaluateReviewPolicy` and may not call `decideNextHandsAction` for finding-driven
decisions.

- [ ] **Step 8: Run tests and typecheck**

```bash
npx vitest run \
  tests/workflow/review-policy.test.ts \
  tests/workflow/review-cycle.test.ts \
  tests/workflow/convergence.test.ts \
  tests/workflow/hands-recovery.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 9: Commit Task 3**

```bash
git add src/core/types.ts src/core/schema.ts src/workflow/review-policy.ts src/workflow/review-cycle.ts src/workflow/convergence.ts src/workflow/hands-recovery.ts tests/workflow/review-policy.test.ts tests/workflow/review-cycle.test.ts tests/workflow/convergence.test.ts tests/workflow/hands-recovery.test.ts
git commit -m "feat: make quality recovery a policy action"
```

---

### Task 4: Implement pure recovery fingerprints and guard transitions

**Files:**

- Create: `src/workflow/recovery-policy.ts`
- Create: `tests/workflow/recovery-policy.test.ts`

**Interfaces:**

- Consumes: `RecoveryScopeStateV1`, `RunStageV2`, `ReviewPolicyAction`.
- Produces: canonical fingerprints, `RecoveryObservationV1`, `RecoveryGuardDecision`, and `evaluateRecoveryGuard()`.

- [ ] **Step 1: Write the complete failing table tests**

Cover this table:

| Previous state and observation | Requested effect | Expected guard action |
| --- | --- | --- |
| no previous observation, implementation failure | `fix` | `allow_next_effect` |
| no previous observation, operational blocker | `retry_operation` | `await_external_fix` |
| second distinct attempt, same blocker and progress | any executable effect | `diagnostic_stop` |
| second distinct attempt, changed progress | `fix` | `allow_next_effect`, repetition reset |
| policy selected `stop` for exhausted limit | `stop` | `exhausted_stop` |

Same-attempt replay is a journal concern tested in Task 5. The pure guard receives
only a new distinct observation.

Add canonicalization assertions:

```ts
expect(blockerFingerprint({ ...blockerSubject, finding_ids: ["b", "a"] }))
  .toBe(blockerFingerprint({ ...blockerSubject, finding_ids: ["a", "b"] }));

expect(progressSubjectSha256({
  ...progress,
  implementation_artifact_sha256: "a".repeat(64),
})).not.toBe(progressSubjectSha256({
  ...progress,
  implementation_artifact_sha256: "b".repeat(64),
}));
```

- [ ] **Step 2: Run the new test and confirm failure**

```bash
npx vitest run tests/workflow/recovery-policy.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Add exact pure contracts**

```ts
export type RecoveryFailureClass =
  | "implementation_failure"
  | "invocation_failure"
  | "model_failure"
  | "operational_blocker"
  | "test_infrastructure_blocker";

export type RecoveryRequestedEffect = ReviewPolicyAction | "retry_operation";

export interface RecoveryProgressSubjectV1 {
  version: 1;
  approved_plan_sha256: string | null;
  candidate_commit: string | null;
  implementation_artifact_sha256: string | null;
  verification_artifact_sha256: string | null;
  review_artifact_sha256: string | null;
  review_revision: number | null;
  finding_ids: string[];
}

export interface RecoveryBlockerSubjectV1 {
  version: 1;
  scope_id: string;
  stage: RunStageV2;
  operation: string;
  failure_class: RecoveryFailureClass;
  blocker_code: string;
  finding_ids: string[];
}

export interface RecoveryObservationV1 extends RecoveryBlockerSubjectV1 {
  run_id: string;
  effect_attempt_id: string;
  blocker_fingerprint: string;
  progress_subject_sha256: string;
}

export type RecoveryGuardAction =
  | "allow_next_effect"
  | "await_external_fix"
  | "diagnostic_stop"
  | "exhausted_stop";

export interface RecoveryGuardDecision {
  action: RecoveryGuardAction;
  next: RecoveryScopeStateV1;
}

export function blockerFingerprint(
  input: RecoveryBlockerSubjectV1,
): string;

export function progressSubjectSha256(
  input: RecoveryProgressSubjectV1,
): string;

export function evaluateRecoveryGuard(input: {
  previous: RecoveryScopeStateV1 | undefined;
  observation: RecoveryObservationV1;
  requestedEffect: RecoveryRequestedEffect;
  requestedEffectReason: string;
}): RecoveryGuardDecision;
```

- [ ] **Step 4: Implement canonical hashing**

Construct new objects with fields in the documented order before `JSON.stringify`.
Reject malformed SHA-256 values and blank identifiers before hashing. Do not accept
raw blocker prose, paths, timestamps, PIDs, or attempt counters as hash inputs.

- [ ] **Step 5: Implement guard transitions**

Use the second equal observation as the diagnostic threshold. Preserve the
existing head sequence because journal allocation belongs to Task 5. Set
`awaiting_external_fix` for first operational/invocation/model/test-infrastructure
failure. Set `exhausted` only when the requested effect is policy `stop` with an
exhaustion reason supplied by the caller. Do not convert `create_replan` to a fix
or a stop.

`evaluateRecoveryGuard()` changes only semantic scope fields. Task 5 decorates its
returned `next` state with the allocated `head_sequence` and
`head_decision_path` before validating the decision artifact.

- [ ] **Step 6: Run tests and typecheck**

```bash
npx vitest run tests/workflow/recovery-policy.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit Task 4**

```bash
git add src/workflow/recovery-policy.ts tests/workflow/recovery-policy.test.ts
git commit -m "feat: add deterministic recovery guard"
```

---

### Task 5: Persist and reconcile the immutable recovery journal

**Files:**

- Create: `src/workflow/recovery-ledger.ts`
- Modify: `src/core/types.ts`
- Modify: `src/core/schema.ts`
- Modify: `src/core/ledger.ts`
- Create: `tests/workflow/recovery-ledger.test.ts`
- Modify: `tests/core/ledger.test.ts`

**Interfaces:**

- Consumes: Task 4 observations and guard decisions; Task 2 monotonic manifest state.
- Produces: `recordRecoveryObservation()`, `reconcileRecoveryJournal()`, and deterministic run-event append.

- [ ] **Step 1: Add artifact and fault-hook contracts to the test**

Use this exact decision artifact:

```ts
export interface RecoveryDecisionArtifactV1 {
  version: 1;
  run_id: string;
  scope_id: string;
  sequence: number;
  observation: RecoveryObservationV1;
  requested_effect: RecoveryRequestedEffect;
  requested_effect_reason: string;
  previous_state: RecoveryScopeStateV1 | null;
  next_state: RecoveryScopeStateV1;
  guard_action: RecoveryGuardAction;
  decision_event_id: string;
  recorded_at: string;
}

export interface RecoveryLedgerHooks {
  afterDecisionArtifact?: () => Promise<void>;
  afterDecisionEvent?: () => Promise<void>;
  afterManifestProjection?: () => Promise<void>;
}
```

Write tests that throw a sentinel from each hook and then call reconciliation.

- [ ] **Step 2: Add failing idempotency and concurrency tests**

Test these cases:

```ts
const first = await recordRecoveryObservation(input);
const replay = await recordRecoveryObservation(input);
expect(replay.artifact_path).toBe(first.artifact_path);
expect(replay.decision).toEqual(first.decision);

const [left, right] = await Promise.all([
  recordRecoveryObservation({ ...input, observation: attempt("attempt-a") }),
  recordRecoveryObservation({ ...input, observation: attempt("attempt-b") }),
]);
expect(new Set([left.decision.next_state.head_sequence, right.decision.next_state.head_sequence]))
  .toEqual(new Set([1, 2]));
```

Add tamper tests for changed observation bytes, a sequence gap, a foreign run ID,
and a manifest pointer that names the wrong decision.

- [ ] **Step 3: Run focused tests and confirm failure**

```bash
npx vitest run tests/workflow/recovery-ledger.test.ts tests/core/ledger.test.ts
```

Expected: FAIL because journal functions and deterministic events do not exist.

- [ ] **Step 4: Add strict artifact schemas**

Export strict schemas for observations, progress subjects, and decision artifacts.
Require:

- positive `sequence`;
- `decision_event_id` matching `recovery-decision:[a-f0-9]{64}`;
- exact correspondence between `next_state.head_sequence` and `sequence`;
- exact correspondence between `next_state.head_decision_path` and the artifact
  path calculated by `recoveryDecisionPath()`.

- [ ] **Step 5: Add deterministic event append**

Extend `RunEventInput` with optional `eventId`. Add:

```ts
export async function appendRunEventOnce(
  runDir: string,
  input: RunEventInput & { eventId: string },
): Promise<RunEventRecord>;
```

Under the run transaction, scan validated `events.jsonl` for the exact event ID.
Return the existing equal event, reject conflicting bytes, or append one new event.
Do not change ordinary `appendRunEvent()` callers.

- [ ] **Step 6: Implement journal path and replay identity**

Use:

```ts
export function recoveryDecisionPath(
  scopeId: string,
  sequence: number,
  observationId: string,
): string {
  const scope = Buffer.from(scopeId, "utf8").toString("base64url");
  return `recovery/scopes/${scope}/decisions/${String(sequence).padStart(6, "0")}-${observationId}.json`;
}
```

Derive `observationId` from run ID, scope ID, and effect-attempt ID. On `EEXIST`,
read through `readOptionalValidatedArtifact()` and accept only exact schema-equal
content.

- [ ] **Step 7: Implement `recordRecoveryObservation()`**

Signature:

```ts
export async function recordRecoveryObservation(input: {
  runDir: string;
  observation: RecoveryObservationV1;
  requestedEffect: RecoveryRequestedEffect;
  requestedEffectReason: string;
  hooks?: RecoveryLedgerHooks;
}): Promise<{
  artifact_path: string;
  decision: RecoveryDecisionArtifactV1;
  manifest: RunManifestV2;
}>;
```

Inside `withRunLedgerCompoundTransaction`:

1. Reject terminal or abandoned runs.
2. Call the locked reconciliation helper before allocating a sequence.
3. Detect same-attempt replay by scanning the scope journal for the effect-attempt ID.
4. Evaluate the guard against the current projected state.
5. Decorate the guard's semantic next state with the allocated sequence and path.
6. Write/validate the decision artifact.
7. Ensure the deterministic event.
8. Advance the manifest projection exactly one sequence.

- [ ] **Step 8: Implement `reconcileRecoveryJournal()`**

Signature:

```ts
export async function reconcileRecoveryJournal(runDir: string): Promise<RunManifestV2>;
```

Implement an internal locked form used by `recordRecoveryObservation()`:

```ts
async function reconcileRecoveryJournalLocked(
  transaction: RunLedgerTransaction,
): Promise<RunManifestV2>;
```

The public function opens `withRunLedgerCompoundTransaction`; the recording path
calls the locked form directly. Do not nest compound transactions because the
ledger rejects same-run compound reentrancy.

For each scope directory:

- reject symlinks and unsupported entries;
- sort decision files by numeric sequence;
- require contiguous sequences starting at one;
- validate previous/next state chaining;
- ensure each deterministic event;
- update only stale manifest projections;
- reject a manifest head ahead of the journal.

- [ ] **Step 9: Run fault-injection and ledger tests**

```bash
npx vitest run tests/workflow/recovery-ledger.test.ts tests/core/ledger.test.ts
npm run typecheck
```

Expected: PASS, including all three interruption hooks.

- [ ] **Step 10: Commit Task 5**

```bash
git add src/workflow/recovery-ledger.ts src/core/types.ts src/core/schema.ts src/core/ledger.ts tests/workflow/recovery-ledger.test.ts tests/core/ledger.test.ts
git commit -m "feat: add reconcilable recovery journal"
```

---

### Task 6: Add diagnostic authorization and one-attempt consumption

**Files:**

- Modify: `src/core/types.ts`
- Modify: `src/core/schema.ts`
- Modify: `src/workflow/recovery-ledger.ts`
- Modify: `tests/workflow/recovery-ledger.test.ts`

**Interfaces:**

- Consumes: Task 5 journal head and create-once artifact helpers.
- Produces: `authorizeDiagnosticResume()`, `claimAuthorizedRecoveryAttempt()`, and authorization/consumption artifacts.

- [ ] **Step 1: Write failing authorization tests**

Create a run at diagnostic stop and prove:

```ts
const authorization = await authorizeDiagnosticResume({
  runDir,
  actor: "operator@example.test",
  note: "Restored the isolated test service",
});
expect(authorization).toMatchObject({
  run_id: manifest.run_id,
  scope_id: "work-item:item-1",
  blocker_fingerprint: manifest.recovery.scopes["work-item:item-1"]!.blocker_fingerprint,
  progress_subject_sha256: manifest.recovery.scopes["work-item:item-1"]!.progress_subject_sha256,
});
```

Prove authorization fails when the state is not diagnostic stop, when the journal
head changes, when the actor/note is blank, and when an authorization already has a
consumption artifact.

- [ ] **Step 2: Write failing crash tests**

Test:

- crash after authorization artifact but before manifest pointer;
- crash before effect claim leaves authorization reusable;
- crash after consumption artifact returns the same `effect_attempt_id`;
- a second claim cannot create a second attempt.

- [ ] **Step 3: Run and confirm failure**

```bash
npx vitest run tests/workflow/recovery-ledger.test.ts
```

Expected: FAIL because authorization APIs do not exist.

- [ ] **Step 4: Add exact artifacts**

```ts
export interface DiagnosticRecoveryAuthorizationV1 {
  version: 1;
  authorization_id: string;
  run_id: string;
  scope_id: string;
  journal_sequence: number;
  decision_path: string;
  blocker_fingerprint: string;
  progress_subject_sha256: string;
  actor: string;
  note: string;
  note_sha256: string;
  recorded_at: string;
}

export interface DiagnosticRecoveryConsumptionV1 {
  version: 1;
  authorization_id: string;
  run_id: string;
  scope_id: string;
  effect_attempt_id: string;
  consumed_at: string;
}
```

Use deterministic paths derived from scope and authorization ID. Keep note bytes in
the authorization artifact so the audit does not depend on a mutable input file.

- [ ] **Step 5: Implement authorization without resetting progress**

`authorizeDiagnosticResume()` updates only `authorization_path` and disposition
`active`. It preserves `consecutive_without_progress`, blocker fingerprint,
progress subject, fix accounting, and quality-recovery usage.

Set `diagnostic_path: null` in the active projection. The diagnostic remains
reachable through the previous immutable decision artifact.

Derive `authorization_id` deterministically:

```ts
const authorizationId = `diagnostic-authorization:${createHash("sha256")
  .update(JSON.stringify({
    version: 1,
    run_id: manifest.run_id,
    scope_id: scopeId,
    journal_sequence: scope.head_sequence,
    decision_path: scope.head_decision_path,
    blocker_fingerprint: scope.blocker_fingerprint,
    progress_subject_sha256: scope.progress_subject_sha256,
    actor,
    note_sha256: createHash("sha256").update(note).digest("hex"),
  }))
  .digest("hex")}`;
```

On replay, read and return the first artifact so `recorded_at` remains unchanged.

- [ ] **Step 6: Implement one-attempt claim**

`claimAuthorizedRecoveryAttempt()` writes or replays the consumption artifact. Its
effect-attempt ID is:

```ts
`recovery-attempt:${createHash("sha256")
  .update(`brain-hands-recovery-attempt-v1\0${authorization.authorization_id}`)
  .digest("hex")}`
```

Return the same ID after a crash. Reject a consumption artifact whose run, scope,
or authorization differs.

- [ ] **Step 7: Run tests and typecheck**

```bash
npx vitest run tests/workflow/recovery-ledger.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit Task 6**

```bash
git add src/core/types.ts src/core/schema.ts src/workflow/recovery-ledger.ts tests/workflow/recovery-ledger.test.ts
git commit -m "feat: authorize one diagnostic retry"
```

---

### Task 7: Build owned-evidence progress subjects and the runtime adapter

**Files:**

- Create: `src/workflow/recovery-runtime.ts`
- Create: `tests/workflow/recovery-runtime.test.ts`
- Modify: `src/workflow/runtime.ts`
- Modify: `tests/workflow/runtime-local.test.ts`

**Interfaces:**

- Consumes: Task 5 journal APIs, Task 6 attempt claims, existing owned-evidence readers, plan revisions, and work-item progress.
- Produces: `buildRecoveryProgressSubject()`, `gateReviewPolicyEffect()`, and `recordOperationalRecovery()`.

- [ ] **Step 1: Write failing owned-evidence hash tests**

Create two files with different paths and equal bytes, then assert equal progress
subjects. Change one byte and assert different subjects. Reject a symlink, an
absolute path, a path outside the run, and an artifact that fails its existing
schema.

- [ ] **Step 2: Write failing adapter tests**

Assert:

```ts
const result = await gateReviewPolicyEffect({
  runDir,
  scopeId: "work-item:item-1",
  operation: "work-item-fix",
  effectAttemptId: cycle.effect_id,
  decision: cycle.decision,
  progress,
});
expect(result.guard_action).toBe("allow_next_effect");
```

Add an operational failure case that returns `await_external_fix`, persists a
decision, and leaves `review_accounting.fix_cycles_used` unchanged.

- [ ] **Step 3: Run and confirm failure**

```bash
npx vitest run tests/workflow/recovery-runtime.test.ts
```

Expected: FAIL because the runtime adapter does not exist.

- [ ] **Step 4: Implement content hashing through owned readers**

Signature:

```ts
export async function buildRecoveryProgressSubject(input: {
  runDir: string;
  manifest: RunManifestV2;
  workItemId: string;
  findingIds: string[];
  implementationPath?: string;
  verificationPath?: string;
  reviewPath?: string;
  reviewRevision?: number;
}): Promise<{
  subject: RecoveryProgressSubjectV1;
  sha256: string;
}>;
```

Read the approved plan SHA from `manifest.plan_revisions`. Hash artifact bytes only
after existing containment and schema validation. Use `null` for missing evidence.

- [ ] **Step 5: Implement policy-effect gating**

`gateReviewPolicyEffect()` records the observation and returns the guard action
without changing the review-policy decision. On `diagnostic_stop` or
`exhausted_stop`, it writes a diagnostic artifact containing both observations,
the requested policy action, fix accounting, quality-recovery usage, and owned
evidence paths.

- [ ] **Step 6: Implement operational recovery recording**

Map runtime exceptions to structured classes and blocker codes. Accept an explicit
classification from the caller; do not parse arbitrary error prose in this module.
The caller must choose `corrupt_state` as non-authorizable and bypass diagnostic
authorization.

- [ ] **Step 7: Integrate one local work-item path**

Replace the first policy-enabled local work-item fix launch with:

1. existing review-cycle claim;
2. recovery guard;
3. Hands invocation only when allowed;
4. existing completion and accounting.

Do not change GitHub, integrated, legacy, or post-PR paths in this task.

- [ ] **Step 8: Run focused tests**

```bash
npx vitest run \
  tests/workflow/recovery-runtime.test.ts \
  tests/workflow/runtime-local.test.ts
npm run typecheck
```

Expected: PASS, with the selected local path preserving existing behavior.

- [ ] **Step 9: Commit Task 7**

```bash
git add src/workflow/recovery-runtime.ts src/workflow/runtime.ts tests/workflow/recovery-runtime.test.ts tests/workflow/runtime-local.test.ts
git commit -m "feat: gate runtime effects with recovery state"
```

---

### Task 8: Integrate every local, GitHub, integrated, and legacy recovery path

**Files:**

- Modify: `src/workflow/runtime.ts`
- Modify: `src/workflow/hands-recovery.ts`
- Modify: `tests/workflow/runtime-local.test.ts`
- Modify: `tests/workflow/runtime-github.test.ts`
- Modify: `tests/workflow/hands-recovery.test.ts`

**Interfaces:**

- Consumes: Task 7 runtime adapter.
- Produces: one consistent recovery path for all executable effects and operational failures.

- [ ] **Step 1: Add failing local/GitHub parity tests**

For equivalent persisted review/evidence, assert local and GitHub modes produce the
same guard action, scope ID, blocker fingerprint, progress subject, and repetition
count. Assert mode-specific issue/PR fields remain unchanged.

- [ ] **Step 2: Add failing bounded-recovery tests**

Prove the sequence is exactly:

```text
initial implementation
primary fix 1
primary fix 2
primary fix 3
quality recovery 1
stop, replan, or advance from the next review-policy decision
```

Assert the quality-recovery effect uses backup, is claimed once, and cannot be
re-entered after an interrupted completion.

- [ ] **Step 3: Add failing operational-stall tests**

Cover Hands invocation, Verifier invocation, verification command infrastructure,
ordered Reviewer action, integrated verification, and post-PR verification. Two
distinct failures with unchanged progress must stop diagnostically. A changed
implementation or verification artifact must reset repetition.

- [ ] **Step 4: Run tests and confirm the unintegrated paths fail**

```bash
npx vitest run tests/workflow/runtime-local.test.ts tests/workflow/runtime-github.test.ts
```

Expected: FAIL in paths that still call `recordRuntimeBlocker()` directly.

- [ ] **Step 5: Integrate policy-enabled work-item paths**

Gate ordinary fix, ordered Reviewer-action fix, and quality recovery after the
existing review-cycle claim and before Hands. Preserve `completeReviewEffect()`
and successful-fix reservation accounting.

- [ ] **Step 6: Integrate integrated and post-PR paths**

Use scope IDs:

```text
integrated:final
integrated:post-pr
```

Preserve each path's existing review-cycle phase and evidence namespace. Do not
collapse final and post-PR evidence into one scope.

- [ ] **Step 7: Integrate operational exception paths**

Replace only retryable `recordRuntimeBlocker()` calls. Leave these fail-closed and
non-authorizable:

- malformed review-cycle provenance;
- missing approved-plan bytes;
- invalid discovery approval;
- corrupt effect completion;
- symlink/owned-evidence violations;
- release-guard integrity failures.

- [ ] **Step 8: Keep legacy behavior explicit**

Use `hands-recovery.ts` only when `review_policy_snapshot` or
`review_accounting` is absent. Persist recovery observations for stall detection,
but derive legacy quality usage from `WorkItemProgress.quality_recovery_attempts`.

- [ ] **Step 9: Prove runtime never creates a run**

Add a test spy:

```ts
const create = vi.spyOn(ledgerModule, "createRunLedgerV2");
await runLocalWorkflow(input);
expect(create).not.toHaveBeenCalled();
```

Repeat for GitHub mode.

- [ ] **Step 10: Run focused runtime verification**

```bash
npx vitest run \
  tests/workflow/recovery-runtime.test.ts \
  tests/workflow/runtime-local.test.ts \
  tests/workflow/runtime-github.test.ts \
  tests/workflow/hands-recovery.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 11: Commit Task 8**

```bash
git add src/workflow/runtime.ts src/workflow/hands-recovery.ts tests/workflow/runtime-local.test.ts tests/workflow/runtime-github.test.ts tests/workflow/hands-recovery.test.ts
git commit -m "feat: unify same-run runtime recovery"
```

---

### Task 9: Project diagnostic state and require explicit resume authorization

**Files:**

- Modify: `src/workflow/status.ts`
- Modify: `src/cli.ts`
- Modify: `tests/workflow/status.test.ts`
- Modify: `tests/cli-smoke.test.ts`

**Interfaces:**

- Consumes: Task 5 reconciliation and Task 6 authorization APIs.
- Produces: `diagnostic_stop` operator state and `resume --actor --recovery-note-file`.

- [ ] **Step 1: Add failing status projection tests**

Add `diagnostic_stop` to `OperatorState` expectations and assert:

```ts
expect(projectOperatorStatus(manifestWithDiagnosticStop)).toMatchObject({
  operator_state: "diagnostic_stop",
  recovery_disposition: "diagnostic_stop",
  recovery_scope: "work-item:item-1",
  blocker_fingerprint: "a".repeat(64),
  progress_subject_sha256: "b".repeat(64),
  consecutive_without_progress: 2,
  diagnostic_path: "recovery/scopes/d29yay1pdGVtOml0ZW0tMQ/diagnostics/000002.json",
  task_lineage_id: expect.stringMatching(/^task-lineage:/),
  predecessor_run_id: null,
  next_automatic_effect: null,
});
```

Diagnostic stop must outrank generic `delivery_state === "blocked"` but remain
below terminal outcomes.

- [ ] **Step 2: Add failing CLI option and mutation tests**

Assert `resume` options include `actor` and `recovery-note-file`. Test that plain
resume at diagnostic stop rejects without changing manifest, events, or journal.
Test that supplying only one option rejects.

- [ ] **Step 3: Add failing secret test**

Use a note file containing `api_key=sk-proj-...` and assert rejection before an
authorization artifact is written.

- [ ] **Step 4: Run and confirm failure**

```bash
npx vitest run tests/workflow/status.test.ts tests/cli-smoke.test.ts
```

Expected: FAIL because the operator state and CLI options do not exist.

- [ ] **Step 5: Reconcile before status projection**

Call `reconcileRecoveryJournal(runDir)` before reading final status evidence.
If reconciliation detects tampering, preserve the current status behavior that
projects an operational blocker with the exact provenance error.

- [ ] **Step 6: Implement diagnostic rendering**

Render:

```text
Operator state: Diagnostic stop (diagnostic_stop)
Recovery scope: work-item:item-1
Repeated blocker: <fingerprint>
Progress subject: <sha256>
No material progress: 2 distinct attempts
Diagnostic: <run-relative path>
Next command: brain-hands resume --run '<runDir>' --actor <actor> --recovery-note-file <path>
```

Continue using shell quoting for the actual run directory.

- [ ] **Step 7: Implement diagnostic resume gate**

Before ordinary resume execution:

1. reconcile the journal;
2. detect diagnostic stop;
3. require both options;
4. read the note with `readOperatorText()`;
5. call `assertNoSecretMaterial()`;
6. record/replay authorization;
7. claim/replay one effect-attempt ID;
8. continue normal same-run resume.

Normal non-diagnostic resume accepts neither option. Reject recovery options when
the run is not diagnostically stopped so they cannot become unaudited comments.

- [ ] **Step 8: Run focused tests**

```bash
npx vitest run tests/workflow/status.test.ts tests/cli-smoke.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 9: Commit Task 9**

```bash
git add src/workflow/status.ts src/cli.ts tests/workflow/status.test.ts tests/cli-smoke.test.ts
git commit -m "feat: add diagnostic resume authorization"
```

---

### Task 10: Add expected-hash controller transition attestation

**Files:**

- Modify: `src/core/types.ts`
- Modify: `src/core/schema.ts`
- Modify: `src/core/controller-provenance.ts`
- Modify: `src/core/ledger.ts`
- Create: `src/workflow/controller-recovery.ts`
- Modify: `src/cli.ts`
- Modify: `tests/core/controller-provenance.test.ts`
- Create: `tests/workflow/controller-recovery.test.ts`
- Modify: `tests/cli-smoke.test.ts`

**Interfaces:**

- Consumes: immutable original `controller_provenance`, Task 2 controller head, and existing runtime-tree hashing.
- Produces: canonical controller subjects, chained transition artifacts, `recover-controller`, and run-aware controller assertion.

- [ ] **Step 1: Add failing canonical-subject tests**

Assert that changing only `executable_path` and `package_root` does not change the
subject hash, while changing package bytes does. Assert `candidate_commit` never
affects the controller subject.

- [ ] **Step 2: Add failing transition tests**

Cover:

- changed controller blocks normal resume;
- wrong expected hash rejects without mutation;
- same-version/different-hash transition succeeds;
- identical canonical subject refuses a redundant transition;
- a second unrecorded change blocks again;
- terminal and abandoned runs reject transition;
- tampered previous-subject hash fails closed;
- transition never changes source commit, approvals, worktree, branch, issues, or PRs.

- [ ] **Step 3: Add interruption tests**

Inject after transition artifact, deterministic event, and manifest head. Reconcile
to one transition with no duplicate sequence.

- [ ] **Step 4: Run and confirm failure**

```bash
npx vitest run \
  tests/core/controller-provenance.test.ts \
  tests/workflow/controller-recovery.test.ts \
  tests/cli-smoke.test.ts
```

Expected: FAIL because controller transition APIs and command do not exist.

- [ ] **Step 5: Add full snapshot and canonical subject contracts**

```ts
export type ControllerRuntimeSnapshotV1 = Omit<ControllerProvenance, "candidate_commit">;

export interface ControllerRuntimeSubjectV1 {
  version: 1;
  package_name: string;
  package_version: string;
  mode: "installed" | "development_checkout";
  package_hash_algorithm: "sha256";
  package_hash: string;
}

export interface ControllerRecoveryArtifactV1 {
  version: 1;
  run_id: string;
  sequence: number;
  actor: string;
  reason: string;
  recorded_at: string;
  previous_subject_sha256: string;
  next_subject_sha256: string;
  previous_runtime: ControllerRuntimeSnapshotV1;
  next_runtime: ControllerRuntimeSnapshotV1;
  candidate_head_at_recovery: string;
  blocker_fingerprint: string | null;
  event_id: string;
}
```

- [ ] **Step 6: Implement transition capture and chaining**

Use path:

```text
controller-recovery/transitions/000001-<next-subject-sha256>.json
```

Validate the currently accepted subject from the latest valid transition or the
original provenance. Require `--expected-package-sha256` to equal the captured
current package hash before writing. Record full paths for audit but compare
canonical subjects for matching.

Add:

```ts
export async function reconcileControllerRecovery(
  runDir: string,
): Promise<RunManifestV2>;
```

Require contiguous sequence, exact previous/next subject chaining, one
deterministic event per artifact, and a manifest head no newer than the journal.
Repair missing events and stale manifest heads after interruption.

Implement a locked helper for use while recording a transition:

```ts
async function reconcileControllerRecoveryLocked(
  transaction: RunLedgerTransaction,
): Promise<RunManifestV2>;
```

The public function opens the compound transaction. Transition recording calls the
locked helper directly and must not nest same-run compound transactions.

- [ ] **Step 7: Update controller assertion**

Change signature to:

```ts
export async function assertCurrentControllerMatches(
  runDir: string,
  manifest: RunManifestV2,
): Promise<void>;
```

Validate the transition chain before comparing current runtime. Update every CLI
caller. Legacy self-hosting runs without original provenance retain the current
fail-closed behavior.

- [ ] **Step 8: Register the command**

```bash
brain-hands recover-controller \
  --run /tmp/example-run \
  --actor operator@example.test \
  --reason "Install the reviewed controller fix" \
  --expected-package-sha256 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
```

The command records the transition and prints status. It does not call workflow,
Hands, Verifier, or resume.

- [ ] **Step 9: Run focused tests**

```bash
npx vitest run \
  tests/core/controller-provenance.test.ts \
  tests/workflow/controller-recovery.test.ts \
  tests/cli-smoke.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 10: Commit Task 10**

```bash
git add src/core/types.ts src/core/schema.ts src/core/controller-provenance.ts src/core/ledger.ts src/workflow/controller-recovery.ts src/cli.ts tests/core/controller-provenance.test.ts tests/workflow/controller-recovery.test.ts tests/cli-smoke.test.ts
git commit -m "feat: attest controller recovery by package hash"
```

---

### Task 11: Extract shared fresh-run bootstrap for normal and replacement runs

**Files:**

- Create: `src/workflow/run-start.ts`
- Modify: `src/cli.ts`
- Create: `tests/workflow/run-start.test.ts`
- Modify: `tests/cli-smoke.test.ts`

**Interfaces:**

- Consumes: existing config loading, intake resolution, controller capture, preflight, ledger creation, and run-configuration rendering.
- Produces: `prepareFreshRun()` and `advancePreparedRunToDiscovery()` without duplicating CLI setup.

- [ ] **Step 1: Add characterization tests for the current `run` command**

Before extraction, capture that one dry-run invocation creates exactly one ledger,
writes `run-configuration.json`, appends `controller_attested`, persists preflight,
and transitions to `brain_discovery` before invoking the discovery turn.

- [ ] **Step 2: Add failing service tests**

Use exact contracts:

```ts
export interface FreshRunChoices {
  mode: RunMode;
  research: boolean;
  reflection: boolean;
  model_overrides: Partial<Record<RoleName, string>>;
}

export interface PrepareFreshRunInput {
  task: string;
  repoRoot: string;
  choices: FreshRunChoices;
  dryRun: boolean;
  reservedRunId?: string;
  taskLineage?: TaskLineageV1;
}

export interface PreparedFreshRun {
  ledger: RunLedgerV2;
  intake: ResolvedRunIntake;
  config: ConfigV2;
  run_configuration: ResolvedRunConfiguration;
}
```

Assert `prepareFreshRun()` stops at `intake` after writing configuration and
controller provenance. Assert `advancePreparedRunToDiscovery()` runs preflight and
stops at `brain_discovery` without invoking Brain.

- [ ] **Step 3: Run and confirm failure**

```bash
npx vitest run tests/workflow/run-start.test.ts tests/cli-smoke.test.ts
```

Expected: FAIL because the shared service does not exist.

- [ ] **Step 4: Move only run-bootstrap logic**

Extract config loading, controller capture, `resolveRunIntake`,
`resolveRunConfiguration`, ledger creation, configuration artifact, and controller
event. Leave CLI option parsing, console formatting, progress reporter creation,
and discovery-turn invocation in `src/cli.ts`.

- [ ] **Step 5: Add preflight advancement**

`advancePreparedRunToDiscovery()` transitions `intake -> preflight`, persists the
existing report, enforces required checks, then transitions to `brain_discovery`.
It must be idempotent when resumed from `preflight` with a valid persisted report.

- [ ] **Step 6: Rewire ordinary `run`**

Call the shared service, preserve current user-visible configuration output, then
invoke the discovery turn exactly as before. Characterization tests must remain
unchanged.

- [ ] **Step 7: Run focused tests**

```bash
npx vitest run tests/workflow/run-start.test.ts tests/cli-smoke.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit Task 11**

```bash
git add src/workflow/run-start.ts src/cli.ts tests/workflow/run-start.test.ts tests/cli-smoke.test.ts
git commit -m "refactor: share fresh run bootstrap"
```

---

### Task 12: Implement abandonment-bound crash-safe replacement

**Files:**

- Modify: `src/core/types.ts`
- Modify: `src/core/schema.ts`
- Modify: `src/core/ledger.ts`
- Create: `src/workflow/replacement.ts`
- Modify: `src/workflow/status.ts`
- Modify: `src/cli.ts`
- Modify: `tests/workflow/assurance.test.ts`
- Create: `tests/workflow/replacement.test.ts`
- Modify: `tests/cli-smoke.test.ts`

**Interfaces:**

- Consumes: explicit abandonment, Task 2 reserved run IDs/lineage, and Task 11 shared bootstrap.
- Produces: reservation/backlink/completion artifacts and `brain-hands replace`.

- [ ] **Step 1: Add failing eligibility tests**

Reject active, blocked-but-active, `closed_blocked`, `delivered`, and
`human_accepted` runs. Accept only a run with both `terminal.outcome ===
"abandoned"` and a valid matching abandonment artifact.

- [ ] **Step 2: Add failing fresh-boundary tests**

After replacement, assert:

```ts
expect(successor.task_lineage).toMatchObject({
  lineage_id: predecessor.task_lineage!.lineage_id,
  root_run_id: predecessor.task_lineage!.root_run_id,
  predecessor_run_id: predecessor.run_id,
  predecessor_abandonment_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
});
expect(successor).toMatchObject({
  stage: "brain_discovery",
  approved_revision: null,
  approved_plan_revision: null,
  worktree_path: null,
  branch_name: null,
  issue_numbers: [],
  pull_request_numbers: [],
  delivery_state: "pending",
  assurance_outcome: null,
  terminal: null,
  recovery: { version: 1, active_scope: null, scopes: {} },
  controller_recovery: { version: 1, transition_count: 0, head_path: null },
});
```

Assert discovery answers, plan revisions, warning authority, risk history, final
artifacts, and GitHub mappings are absent.

- [ ] **Step 3: Add crash-boundary tests**

Add hooks after:

1. predecessor reservation;
2. successor directory creation;
3. successor backlink;
4. successor preflight;
5. predecessor completion artifact;
6. predecessor final-artifact append.

Rerun after each sentinel. Assert exactly one successor run directory and one
completion record.

- [ ] **Step 4: Run and confirm failure**

```bash
npx vitest run \
  tests/workflow/assurance.test.ts \
  tests/workflow/replacement.test.ts \
  tests/cli-smoke.test.ts
```

Expected: FAIL because replacement contracts and command do not exist.

- [ ] **Step 5: Add exact replacement artifacts**

```ts
export interface ReplacementReservationV1 {
  version: 1;
  predecessor_run_id: string;
  predecessor_abandonment_path: string;
  predecessor_abandonment_sha256: string;
  successor_run_id: string;
  task_lineage: TaskLineageV1;
  actor: string;
  reason: string;
  created_at: string;
}

export interface ReplacementPredecessorLinkV1 {
  version: 1;
  predecessor_run_id: string;
  predecessor_reservation_sha256: string;
  successor_run_id: string;
  task_lineage: TaskLineageV1;
}

export interface ReplacementCompletionV1 {
  version: 1;
  predecessor_run_id: string;
  successor_run_id: string;
  reservation_sha256: string;
  predecessor_link_sha256: string;
  completed_at: string;
}
```

- [ ] **Step 6: Implement explicit-intake reconstruction**

Read persisted `intake.json` and `run-configuration.json`. Copy mode, research,
reflection, and only model roles whose configuration source is `cli_override`.
Call Task 11 bootstrap so current repository config and current controller are
resolved. Never copy resolved backup or review policy snapshots directly.

- [ ] **Step 7: Implement the three-record handshake**

1. Lock predecessor and create/replay `replacement/reservation.json`.
2. Release predecessor.
3. Create/replay the reserved successor.
4. Write/validate `lineage/predecessor.json` in successor.
5. Advance successor through preflight to `brain_discovery` without Brain.
6. Lock predecessor and validate backlink plus successor manifest.
7. Write/replay `replacement/completion.json`.
8. Append completion path to terminal `final_artifact_paths`.

Never hold both run locks simultaneously.

When the reserved successor directory already exists, validate its run ID,
repository, original request, lineage, controller provenance, and predecessor
backlink before treating it as replay. A missing backlink may be created only if
the successor has no approvals, worktree, branch, issue, PR, risk, assurance, or
terminal state. Reject every conflicting existing directory.

- [ ] **Step 8: Register `replace`**

```bash
brain-hands replace \
  --run /tmp/abandoned-run \
  --actor operator@example.test \
  --reason "The original worktree cannot be recovered"
```

Print the successor run directory and:

```text
Next command: brain-hands resume --run '<successor-run-dir>'
```

Do not invoke discovery Brain inside `replace`.

- [ ] **Step 9: Run focused replacement tests**

```bash
npx vitest run \
  tests/workflow/run-start.test.ts \
  tests/workflow/assurance.test.ts \
  tests/workflow/replacement.test.ts \
  tests/cli-smoke.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 10: Commit Task 12**

```bash
git add src/core/types.ts src/core/schema.ts src/core/ledger.ts src/workflow/replacement.ts src/workflow/status.ts src/cli.ts tests/workflow/assurance.test.ts tests/workflow/replacement.test.ts tests/cli-smoke.test.ts
git commit -m "feat: add explicit linked replacement runs"
```

---

### Task 13: Document the operator contract and run full built-surface verification

**Files:**

- Modify: `README.md`
- Modify: `agentic-codex-workflow.md`
- Modify: `.agents/skills/brain-hands/SKILL.md`
- Modify: `tests/skill-layout.test.ts`
- Modify: `tests/workflow/canonical-session-built-cli.test.ts`
- Modify: `tests/cli-smoke.test.ts`

**Interfaces:**

- Consumes: every command and status field from Tasks 1 through 12.
- Produces: exact operator recovery instructions and built-package acceptance evidence.

- [ ] **Step 1: Add failing documentation-surface tests**

Require all three operator documents to state, in order:

1. inspect status/logs;
2. resume the existing run;
3. authorize one diagnostic retry when required;
4. attest an expected controller hash when required;
5. explicitly abandon only when same-run recovery is unsafe;
6. replace only an abandoned run;
7. never use ordinary `run` for recovery;
8. never reuse approval or GitHub effects across replacement.

Require the skill to mention `--recovery-note-file` and
`--expected-package-sha256` exactly.

- [ ] **Step 2: Add process-separated built-CLI tests**

In `canonical-session-built-cli.test.ts`, run `node dist/cli.js` scenarios proving:

- failure then resume leaves one run directory;
- diagnostic stop creates no run;
- authorized retry retains the run ID;
- controller mismatch blocks before workflow execution;
- expected-hash transition retains the run ID;
- abandon then replace creates one successor;
- replacement replay returns that successor;
- successor lacks approvals and GitHub IDs;
- each durable run retains its own canonical session event.

- [ ] **Step 3: Run the new tests and confirm documentation failure**

```bash
npm run build
npx vitest run tests/skill-layout.test.ts tests/workflow/canonical-session-built-cli.test.ts tests/cli-smoke.test.ts
```

Expected: FAIL until documentation and built CLI expose the new contract.

- [ ] **Step 4: Update README and canonical workflow**

Document exact commands, state meanings, immutable artifacts, and the distinction
between `verified_ready`, `human_accepted`, `blocked`, and `abandoned`. State that
controller attestation and diagnostic authorization do not approve implementation.

- [ ] **Step 5: Update the Brain Hands skill**

At a recovery boundary, instruct the agent to display the engine-authored status
and exact next command. Do not offer an interactive resume-versus-replacement menu
when the engine state determines the only permitted action. Preserve discovery and
plan approval as separate gates.

- [ ] **Step 6: Run targeted tests**

```bash
npm run build
npx vitest run \
  tests/skill-layout.test.ts \
  tests/workflow/canonical-session-built-cli.test.ts \
  tests/cli-smoke.test.ts
```

Expected: PASS.

- [ ] **Step 7: Run all repository gates**

```bash
npm run typecheck
npm run build
npm run validate-release -- --json
npm test
git diff --check
npm pack --dry-run --json
```

Expected:

- TypeScript reports no errors.
- Release validation reports success.
- Full Vitest suite passes.
- `git diff --check` prints no output.
- Dry-run package includes only `dist/`, `prompts/`,
  `agentic-codex-workflow.md`, `README.md`, and package metadata.
- `package.json` version remains `0.4.0` unless main has advanced before execution;
  in all cases this task does not modify the version.

- [ ] **Step 8: Inspect the final diff for forbidden scope**

Run:

```bash
git diff --name-only HEAD
rg -n "carry.forward|reuse.*approval|reuse.*pull.request|reuse.*issue" src README.md agentic-codex-workflow.md .agents/skills/brain-hands/SKILL.md
```

Expected: only planned files changed; no implementation of cross-run approval or
GitHub-effect reuse.

- [ ] **Step 9: Commit Task 13**

```bash
git add README.md agentic-codex-workflow.md .agents/skills/brain-hands/SKILL.md tests/skill-layout.test.ts tests/workflow/canonical-session-built-cli.test.ts tests/cli-smoke.test.ts
git commit -m "docs: define same-run recovery workflow"
```

---

## Final Acceptance Checklist

- [ ] New root runs have deterministic task lineage and empty recovery/controller heads.
- [ ] Old v2 manifests load without an eager rewrite.
- [ ] Review policy is the sole finding-driven action authority.
- [ ] Three successful primary fixes permit exactly one configured quality recovery.
- [ ] `replan_required` never triggers quality recovery.
- [ ] Operational failures never consume fix accounting.
- [ ] Same-attempt replay is idempotent.
- [ ] Two distinct equal blocker/progress observations enter diagnostic stop.
- [ ] Changed owned-evidence bytes reset no-progress repetition.
- [ ] Recovery journal, deterministic event, and manifest projection reconcile after interruption.
- [ ] Plain resume cannot cross diagnostic stop.
- [ ] Diagnostic authorization is secret-scanned, exact-subject-bound, and consumed once.
- [ ] Operator notes never count as evidence progress.
- [ ] Unrecorded self-hosting controller changes block resume.
- [ ] Controller transition requires the expected package SHA-256.
- [ ] Controller transition preserves source, approvals, worktree, branch, issues, and PRs.
- [ ] Only explicitly abandoned runs can be replaced.
- [ ] Replacement interruption always returns the same successor.
- [ ] Successor shares lineage but begins with fresh approval and external-effect state.
- [ ] Runtime never calls `createRunLedgerV2` for ordinary recovery.
- [ ] Cross-run approval and GitHub-effect reuse are absent.
- [ ] Full typecheck, build, release validation, Vitest, diff check, and package dry run pass.
