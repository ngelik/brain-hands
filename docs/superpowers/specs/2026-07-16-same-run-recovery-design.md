# Same-Run Recovery, Controller Transition, and Replacement Design

## Summary

Brain Hands will recover ordinary implementation, invocation, model, verification,
and replanning failures inside the same durable run. The existing deterministic
review-policy engine remains the only authority that decides how Verifier findings
advance, fix, replan, or stop. A separate recovery guard records effect attempts,
detects repeated failures without material evidence progress, and refuses unsafe
repetition without inventing a competing finding policy.

When the self-hosting controller changes, the operator must attest the exact new
package hash before the run can resume. When the task cannot safely continue, the
operator must explicitly abandon the run before creating one linked replacement.
Replacement starts with fresh discovery, planning, approval, worktree, branch,
GitHub, risk, and recovery state. Cross-run approval reuse and GitHub-effect reuse
remain out of scope.

Phases 1 through 4 form one delivery. Intermediate commits may be reviewed and
tested independently, but no partial release should expose only some recovery
commands or manifest fields.

## Goals

- Preserve the same run ID, approved discovery brief, approved plan, worktree,
  branch, issue mappings, and pull-request mappings across ordinary recovery.
- Keep the review-policy engine as the sole finding-driven decision authority.
- Preserve the existing maximum of three successful primary fix cycles followed
  by at most one configured quality-recovery cycle.
- Distinguish crash replay from a genuine repeated attempt.
- Stop deterministic loops after two distinct attempts produce the same blocker
  against the same durable progress subject.
- Treat operator recovery notes as bounded authorization, never as proof of
  material progress.
- Make recovery artifacts, events, and manifest pointers crash-reconcilable.
- Require an operator-supplied expected package hash for controller transition.
- Make explicit replacement idempotent across every crash boundary.
- Keep old v2 manifests readable and resumable.

## Non-goals

- Cross-run discovery approval, plan approval, warning authority, or risk
  acceptance reuse.
- Reusing a predecessor worktree, branch, issue, pull request, or GitHub comment.
- Fuzzy task matching, prose similarity, or model-judged equivalence.
- Automatic replacement, automatic abandonment, or automatic controller
  attestation.
- A second model ladder or more than one quality-recovery attempt.
- Retrying corrupt-state, approval-integrity, or provenance-integrity failures.
- A package version bump, release, or npm publication.
- Replacing the existing planning-recovery state machine.

## Existing Contracts That Remain Authoritative

- `src/workflow/review-policy.ts` decides `advance`, `fix`, `create_replan`,
  `await_plan_approval`, `continue_with_warning`, and `stop` from normalized
  findings and snapshotted accounting.
- `src/workflow/review-cycle.ts` owns deterministic cycle IDs, effect IDs, effect
  claims, successful-fix reservations, and accounting updates.
- `src/core/discovery-ledger.ts` binds discovery approval to an immutable brief
  revision and SHA-256.
- `src/core/ledger.ts` binds plan approval to an immutable plan revision and
  SHA-256, serializes same-run mutations, and rejects cross-run nested
  transactions.
- `src/core/controller-provenance.ts` captures the controller package tree and
  blocks unrecorded self-hosting controller changes.
- `src/workflow/assurance.ts` makes abandonment explicit and irreversible.
- `src/workflow/status.ts` projects durable engine state into operator state.

Recovery extends these contracts. It does not replace or weaken them.

## Considered Approaches

### Independent recovery decision engine

The proposed plan defines recovery decisions such as `resume_fix`,
`replan_same_run`, and `exhausted_stop` independently from review policy. This is
rejected because the recovery engine could select a fix while review policy
selects replan or stop. Two deterministic engines are still ambiguous when their
authority overlaps.

### Put every failure into review policy

This would preserve one decision engine but would mix normalized Verifier findings
with network failures, model invocation crashes, controller identity, and
cross-run replacement coordination. Review policy currently rejects operational
blockers intentionally. Expanding it to all recovery concerns would make it harder
to reason about and test.

### Review policy plus recovery guard and immutable journal

This is selected. Review policy owns finding semantics. It gains one explicit
`quality_recovery` action so the bounded backup cycle participates in the same
cycle/effect accounting as ordinary fixes. The recovery guard observes requested
effects and operational failures, detects no-progress repetition, enforces
one-attempt diagnostic authorization, and records immutable decisions. It may
permit or refuse an effect, but it may not turn one review-policy action into
another.

## Component Boundaries

### Canonical review policy

`ReviewPolicyAction` gains `quality_recovery`. `EvaluateReviewPolicyInput` gains a
strict snapshot:

```ts
export interface QualityRecoveryEligibility {
  configured: boolean;
  active_hands_profile: HandsProfileKind;
  attempts_used: 0 | 1;
}
```

Finding-driven decision order is:

1. Critical or high release blocker: `stop`.
2. Pending replan approval: `await_plan_approval`.
3. Any `requires_replan` finding: `create_replan`.
4. No blocking findings: `advance`.
5. `fix_cycles_used < max_fix_cycles`: `fix`.
6. Quality recovery configured, primary profile active, and unused:
   `quality_recovery`.
7. Apply the existing `on_limit` behavior.

`quality_recovery` never supersedes `requires_replan`, a release blocker, or a
pending plan-approval boundary. After its Verifier result, the next review cycle
evaluates normally. It cannot be selected twice.

Successful-fix reservation remains the source of accounting truth. An ordinary
`fix` reservation requires `fix_cycles_used < max_fix_cycles`. A
`quality_recovery` reservation requires `fix_cycles_used === max_fix_cycles`, an
eligible primary profile, and no prior quality-recovery claim. Its successful
Hands result advances successful-fix accounting once, so the post-recovery value
may be `max_fix_cycles + 1`. The reservation and completion artifacts record the
effect action so replay cannot reinterpret an ordinary fix as quality recovery.

### Recovery guard

The recovery guard consumes a durable observation and a requested next effect. It
returns only one of:

```ts
export type RecoveryGuardAction =
  | "allow_next_effect"
  | "await_external_fix"
  | "diagnostic_stop"
  | "exhausted_stop";
```

It does not return `fix`, `replan`, or `quality_recovery`. Those are inputs from
review policy or the runtime operation being resumed.

The guard uses these failure classes:

```ts
export type RecoveryFailureClass =
  | "implementation_failure"
  | "invocation_failure"
  | "model_failure"
  | "operational_blocker"
  | "test_infrastructure_blocker";
```

`replan_required` is not a recovery failure class. It remains a review-policy
decision. Corrupt persisted state and approval/provenance integrity failures are
fail-closed runtime blockers and never receive diagnostic authorization.

### Effect-attempt identity

Every effect launch receives a durable `effect_attempt_id` before model, command,
or external execution begins.

- Policy-managed effects use the existing review-cycle `effect_id` plus a
  deterministic attempt ordinal.
- Legacy work-item effects use the persisted fix reservation or a new recovery
  attempt claim.
- Operational retries use a deterministic claim created under the run lock.

Replaying the same `effect_attempt_id` returns the recorded observation and does
not increment repetition. A second real attempt must use a new ID even when its
operation and inputs are identical.

### Blocker fingerprint

The blocker fingerprint hashes canonical structured data:

```ts
{
  version: 1,
  scope_id,
  stage,
  operation,
  failure_class,
  blocker_code,
  finding_ids: [...finding_ids].sort(),
}
```

It excludes raw prose, timestamps, paths, attempts, PIDs, temporary directories,
and model transcripts.

### Material-progress subject

The progress subject hashes content identity rather than path names:

```ts
{
  version: 1,
  approved_plan_sha256,
  candidate_commit,
  implementation_artifact_sha256,
  verification_artifact_sha256,
  review_artifact_sha256,
  review_revision,
  finding_ids: [...finding_ids].sort(),
}
```

Missing artifacts are represented as `null`. Artifact hashes are calculated only
after the existing owned-evidence readers validate containment, regular-file
identity, and expected schema. An invocation failure before new evidence retains
the previous progress subject.

The repetition counter increments only when two observations have distinct
effect-attempt IDs and equal blocker and progress hashes. A changed progress hash
resets the counter. The second equal observation enters diagnostic stop before a
third effect can be launched.

### Recovery journal

The immutable journal is authoritative. Manifest state and events are projections.

```text
recovery/scopes/<scope-base64url>/decisions/000001-<observation-id>.json
recovery/scopes/<scope-base64url>/diagnostics/000001.json
recovery/scopes/<scope-base64url>/authorizations/<authorization-id>.json
recovery/scopes/<scope-base64url>/authorizations/<authorization-id>-consumed.json
```

Each decision records the observation, requested effect, previous state, next
state, guard action, artifact hashes, and deterministic event ID. Scope sequence
numbers are contiguous and start at one.

The write order is:

1. Validate the current manifest, journal head, and effect-attempt identity.
2. Write or validate the create-once decision artifact.
3. Ensure the deterministic event exists exactly once.
4. Update the manifest projection.

This is not described as a multi-file atomic write. `reconcileRecoveryJournal()`
runs before status and resume. It completes missing event or manifest projections,
rejects gaps or conflicts, and never invents a missing decision artifact.

### Manifest projection

New root runs initialize:

```ts
recovery: {
  version: 1,
  active_scope: null,
  scopes: {},
},
task_lineage: {
  version: 1,
  lineage_id: taskLineageId(runId),
  root_run_id: runId,
  predecessor_run_id: null,
  predecessor_abandonment_sha256: null,
},
controller_recovery: {
  version: 1,
  transition_count: 0,
  head_path: null,
},
```

Old manifests load with empty recovery state, `task_lineage: null`, and an empty
controller-recovery head. Loading an old manifest does not write a migration.

Recovery scope state stores only the journal head and current projection. It does
not duplicate `review_accounting.fix_cycles_used` or successful-fix markers.

### Diagnostic authorization

Diagnostic stop is an operator state, not a workflow stage. Plain `resume` at this
boundary is read-only and refuses to execute.

The explicit command is:

```bash
brain-hands resume \
  --run <run> \
  --actor <actor> \
  --recovery-note-file <path>
```

The note is read through the existing operator-input reader and rejected if it
contains detected secret material. The authorization binds to run, scope,
blocker fingerprint, progress subject, decision path, journal sequence, actor,
and note digest.

Authorization permits exactly one new effect claim. Claiming writes a create-once
consumption artifact. A crash before claim leaves authorization available; a crash
after claim resumes the same attempt. The authorization does not reset repetition,
fix cycles, or quality-recovery usage. Only a changed progress subject resets the
no-progress count.

The authorization ID is deterministic over run, scope, journal sequence, decision
path, blocker fingerprint, progress subject, actor, and note SHA-256. Repeating the
same command after an interrupted write returns the first artifact and timestamp.
Moving from diagnostic stop to an authorized active state clears the projected
`diagnostic_path`, retains the diagnostic in the immutable journal, and sets only
the new authorization pointer.

### Controller transition

The original `controller_provenance` and `source_commit` remain immutable. A
canonical controller subject contains:

```ts
{
  package_name,
  package_version,
  mode,
  package_hash_algorithm,
  package_hash,
}
```

Executable and package paths remain in the full audit snapshot but do not define
package identity. `candidate_commit` is candidate provenance, not controller
identity.

The operator command requires the expected new package hash:

```bash
brain-hands recover-controller \
  --run <run> \
  --actor <actor> \
  --reason "<why the controller changed>" \
  --expected-package-sha256 <64-hex>
```

The command validates that the current controller is canonical and outside the
self-hosting candidate, verifies the supplied hash, records a chained transition,
updates the head projection, and stops. It never resumes the workflow. A same
version with a different hash requires transition; identical bytes at a different
installed path do not.

`reconcileControllerRecovery()` validates contiguous transition sequence,
previous/next subject chaining, deterministic events, and the manifest head before
controller matching, status mutation, or another transition. It repairs a missing
event or stale head after interruption and rejects a head ahead of the journal.

### Explicit replacement

Replacement requires `terminal.outcome === "abandoned"` and a valid abandonment
artifact. `closed_blocked`, `delivered`, `human_accepted`, active, or merely blocked
runs cannot be replaced.

Cross-run nested ledger transactions remain forbidden. Replacement uses three
create-once records:

```text
predecessor/replacement/reservation.json
successor/lineage/predecessor.json
predecessor/replacement/completion.json
```

The algorithm is:

1. Lock predecessor, validate abandonment, and create or validate a reservation
   containing one predetermined successor run ID and lineage.
2. Release predecessor.
3. Atomically create the successor run directory with the reserved ID and backlink.
4. Bootstrap current configuration, controller provenance, and preflight.
5. Stop the successor at `brain_discovery` before invoking Brain.
6. Lock predecessor again, validate the successor backlink, write completion, and
   append completion to terminal `final_artifact_paths`.

Rerunning after any interruption finds the reservation and completes the same
successor. It never allocates a second successor.

If the reserved successor directory already exists, replacement treats it as
replay only after validating the manifest run ID, repository, original request,
task lineage, source controller provenance, and predecessor backlink. A missing
backlink may be completed only while the successor remains at its bootstrap
boundary with no approvals or external-effect mappings. Conflicting existing state
fails closed instead of being adopted.

The successor copies only the original request, repository, mode, research and
reflection choices, and model choices whose resolved source was `cli_override`.
It re-resolves current configuration. It never copies discovery, plans, approvals,
warning authority, risk acceptance, recovery state, controller transitions,
worktree, branch, issues, pull requests, final artifacts, assurance, or terminal
state.

### Status and operator workflow

`diagnostic_stop` is added to `OperatorState`. Status exposes the recovery scope,
disposition, blocker fingerprint, progress subject, repetition count, diagnostic
path, lineage ID, and predecessor run ID.

The documented recovery order is deterministic:

1. Inspect `status` and `logs`.
2. Resume the existing run.
3. Restore an external dependency and resume the same run.
4. At diagnostic stop, authorize one exact retry.
5. If the controller changed, attest the expected package hash.
6. Resume the same run.
7. If unsafe to continue, explicitly abandon.
8. Create one linked replacement.
9. Never use ordinary `run` as recovery.
10. Never reuse approvals or external effects across replacement.

## Error Handling

- Journal gaps, conflicting artifacts, invalid hashes, tampered controller chains,
  and mismatched replacement backlinks fail closed.
- Operational and test-infrastructure blockers do not consume fix cycles.
- Corrupt state and approval/provenance failures cannot be authorized through the
  diagnostic-recovery command.
- An unavailable or invalid backup profile blocks; it does not select another model.
- A replacement preflight failure leaves the reserved successor resumable and does
  not create another successor.
- Terminal runs accept only the existing allowed final-artifact append used to
  record replacement completion.

## Testing Strategy

### Pure policy tests

- Review-policy ordering, bounded quality recovery, on-limit behavior, and no
  recovery for replan/release blockers.
- Blocker and progress hash canonicalization.
- Same-attempt replay versus distinct-attempt repetition.

### Ledger and crash tests

- Decision replay, concurrent sequence allocation, and tamper rejection.
- Interrupt after decision artifact, event, and manifest projection.
- Authorization claim and consumption interruption.
- Controller transition chain interruption.
- Replacement interruption after reservation, successor creation, preflight, and
  before completion.

### Runtime tests

- Equivalent local and GitHub decisions.
- Preservation of run ID, worktree, branch, issue, and pull-request mappings.
- Exactly three primary fix cycles and one quality-recovery cycle.
- No runtime call to `createRunLedgerV2`.
- Replan remains same-run and separately approval-gated.

### Built-CLI tests

- Failure, resume, diagnostic authorization, and successful same-run continuation.
- Controller mismatch, expected-hash transition, and same-run resume.
- Abandon, replace, interruption replay, and fresh successor boundaries.
- Legacy manifest load and resume.

### Repository gates

```bash
npm run typecheck
npm run build
npm run validate-release -- --json
npm test
git diff --check
npm pack --dry-run --json
```

The package version remains unchanged and the package contents remain limited to
the declared runtime surface.

## Acceptance Criteria

- Ordinary failures never create a second run.
- Review policy remains the sole finding-driven decision authority.
- Three successful primary fixes permit at most one quality recovery.
- Replay of one effect attempt is idempotent.
- Two distinct identical no-progress failures enter diagnostic stop.
- An operator note authorizes one attempt but never counts as progress.
- Controller transition requires the exact expected package hash.
- Replacement is impossible before explicit abandonment.
- Replacement is linked, crash-safe, and idempotent.
- Replacement begins with fresh approvals and external-effect state.
- Old manifests remain readable and resumable.
- Cross-run approval and GitHub-effect reuse do not exist.
