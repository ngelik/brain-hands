# Bounded Hands Backup and Recovery Design

## Summary

Brain Hands will support one explicit backup profile with two triggers:

1. Availability fallback when the primary Hands profile reaches a confirmed
   usage limit.
2. Quality recovery after the normal Hands fix budget is exhausted.

The initial implementation is not a fix attempt. When the primary profile
remains available, a work item may therefore receive up to three primary fixes
and one backup recovery fix, with deterministic verification and Verifier
review after every successful Hands invocation.

The backup tier is bounded and fail-closed. It is not a model ladder. A
confirmed primary usage limit activates the backup for the same logical Hands
operation and the remainder of the run. If backup is already active, there is
no further model fallback. If the configured recovery attempt is rejected, or
the backup profile cannot be validated, the work item becomes blocked and
requires an approved replan or human decision. Brain Hands never chooses an
unconfigured substitute.

## Goals

- Give a difficult but still well-scoped implementation one independent
  recovery attempt after three rejected primary fixes.
- Continue a run when the primary Hands profile returns a confirmed usage-limit
  error, without charging that failed invocation to the logical fix budget.
- Count actual fix attempts rather than Verifier passes or operational errors.
- Exclude authentication, catalog, GitHub, malformed-output, and test
  infrastructure failures from the implementation retry budget. Treat only a
  confirmed primary usage limit as eligible for automatic backup activation.
- Give the backup profile enough durable evidence to diagnose prior failures
  without replaying an unbounded transcript.
- Record the exact model, reasoning effort, trigger, evidence, and outcome for
  every implementation attempt.
- Preserve deterministic successful-call cost: one initial implementation,
  three primary fixes, and one recovery fix at most per work item. A confirmed
  primary usage-limit invocation may add one failed call before backup takes
  over the same logical attempt.
- Preserve resume safety and never repeat a consumed recovery attempt.

## Non-goals

- Selecting a recovery model dynamically.
- Supporting multiple recovery tiers or silent model fallback.
- Retrying operational failures automatically, except for one confirmed
  primary usage-limit handoff to the configured backup.
- Falling back Brain, Verifier, or reflection roles. This design applies only
  to Hands implementation and fix invocations.
- Letting recovery change the approved plan, acceptance criteria, or scope.
- Replacing `replan_required` when the Verifier determines that the approved
  plan itself is wrong or incomplete.
- Guaranteeing that any example model is present in every Codex catalog.

## Existing Behavior

The v2 runtime currently requires exactly three Verifier passes. Because the
initial implementation consumes the first pass, this permits only two Hands
fixes. It also treats a failed verification command as an immediate blocker,
before the Verifier can determine whether the failure is caused by the
implementation or by infrastructure.

Hands always resolves the same `intake.roles.hands` profile. Work-item progress
stores a generic attempt count, but it does not distinguish the initial
implementation, primary fixes, or a recovery fix. The legacy PR workflow has a
separate `max_hands_fix_attempts` counter, so the new semantics must be applied
consistently or explicitly confined to v2 while legacy behavior is retired.

## Considered Approaches

### Count the initial implementation inside three total passes

This matches the current runtime but leaves only two corrective attempts. The
name `max_hands_fix_attempts` would remain misleading, and a recovery decision
would depend on Verifier-pass bookkeeping rather than actual fixes.

### Add one explicit backup profile after three primary fixes

This is selected for quality failures. It gives the primary profile three
genuine correction cycles and permits one independently prompted backup
recovery attempt. The maximum cost and terminal behavior remain obvious from
configuration.

### Use the same backup for confirmed primary usage limits

This is selected for availability failures. A usage-limited primary invocation
does not represent an implementation attempt, so Brain Hands retries that same
logical operation once with the configured backup and circuit-breaks the
primary profile for the rest of the run. A separate quota-only model ladder
would duplicate configuration and create ambiguous resume behavior.

### Add an ordered model ladder

A ladder could improve recovery probability, but it makes cost, availability,
resume behavior, and issue reporting less predictable. It also encourages
silent substitution. Brain Hands will support exactly one configured backup
profile.

## Configuration

The retry policy will separate the primary fix budget from the optional backup
profile:

```yaml
retry_policy:
  max_hands_fix_attempts: 3
  max_replan_attempts: 2
  backup:
    fallback_on_primary_usage_limit: true
    max_quality_recovery_attempts: 1
    profile:
      model: gpt-5.6-luna
      reasoning_effort: medium
```

Constraints:

- `backup.max_quality_recovery_attempts` is fixed to `1` per work item in the
  first version. Values other than `1` are rejected rather than treated as a
  future extension point.
- `fallback_on_primary_usage_limit` is an explicit boolean and defaults to
  `false` when absent.
- Omitting `backup` disables both fallback and model recovery. Existing v2
  configuration files therefore keep their current cost ceiling until backup
  is added explicitly.
- The package default omits `backup`; enabling additional model spend is an
  explicit repository choice. A repository that enables the example profile
  must pass local Codex catalog validation during preflight.
- The backup sandbox remains `workspace-write` and is not configurable
  independently. Model and reasoning effort are the only recovery overrides.
- The primary Hands profile continues to come from `profiles.hands`.

The runtime refers to `primary` and `backup` profiles. Model family names do
not appear in retry logic.

## Attempt Semantics

The attempt sequence for one work item is:

```text
initial implementation
  -> verification
  -> Verifier
  -> primary fix 1 -> verification -> Verifier
  -> primary fix 2 -> verification -> Verifier
  -> primary fix 3 -> verification -> Verifier
  -> recovery fix 1 -> verification -> Verifier
  -> approved, replan required, or blocked: escalation_exhausted
```

The initial implementation is recorded but does not increment
`primary_fix_attempts`. A fix budget is consumed only after Hands exits
successfully and returns a valid, provenance-matching implementation report.
The corresponding verification and review remain part of that consumed fix
cycle.

An invocation that fails operationally creates a started attempt record and a
blocker, but does not consume a fix budget. Brain Hands does not automatically
retry it because the worktree may have been partially modified. Resume first
requires the operator to resolve or explicitly replan the blocked state.

The sole exception is a confirmed primary usage-limit response. Before
fallback, Brain Hands proves that the failed primary invocation produced no
valid implementation result. It then records the failed invocation and invokes
the backup under the same logical attempt ordinal. A successful backup result
consumes the logical attempt exactly once. The primary invocation and backup
invocation remain separate provenance records.

## Failure Classification

Every unsuccessful cycle receives one structured classification:

| Classification | Examples | Consumes fix budget | Next state |
| --- | --- | ---: | --- |
| `implementation_failure` | Failed assertion, incorrect behavior, missing expected artifact caused by the change, concrete Verifier finding | Yes, after a successful Hands fix | Next primary fix or recovery |
| `primary_usage_limit` | Structured Codex usage-limit or entitlement exhaustion for the primary Hands model | No | Activate backup and retry the same logical operation once |
| `operational_blocker` | Auth, backup usage limit, unavailable model, malformed model output, missing executable, timeout, GitHub failure, sandbox denial | No | Blocked |
| `test_infrastructure_blocker` | Broken fixture, unavailable external service, unrelated test harness failure | No | Blocked |
| `replan_required` | Acceptance criteria or approved architecture must change | No additional attempt | Replanning |

Deterministic pre-invocation failures are classified without a model. Completed
verification commands, including non-zero exits, are persisted and sent to the
Verifier instead of causing an immediate runtime return. The Verifier contract
will classify the evidence and must provide concrete findings for
`implementation_failure`.

`primary_usage_limit` is classified by the Codex adapter from a structured
account or model usage-exhaustion error code when available, with explicitly
tested CLI error signatures as a compatibility fallback. A transient rate
limit, generic non-zero exit, network error, authentication failure, or
ambiguous quota message is not enough. Ambiguity blocks instead of activating
backup.

The runtime validates the classification structurally:

- `implementation_failure` requires at least one actionable finding and a
  re-verification command or check.
- `operational_blocker` and `test_infrastructure_blocker` require a concrete
  blocker description and must not request code changes.
- `replan_required` follows the existing replan path and never triggers
  recovery.

Ambiguous failures fail closed as blocked. The runtime does not spend a retry
based on keyword guessing.

## Recovery Eligibility and State Machine

Recovery is eligible only when all of the following are true:

1. Backup is configured and has not already been activated for a primary usage
   limit.
2. Three primary fixes have been consumed for the current work item.
3. The latest verification and Verifier result are valid and classified as
   `implementation_failure`.
4. The latest review contains concrete unresolved findings.
5. No recovery attempt has previously been consumed or left in an ambiguous
   partially executed state.

Availability fallback is eligible only when all of the following are true:

1. `fallback_on_primary_usage_limit` is enabled.
2. The failed invocation used the primary Hands profile.
3. The adapter classified the failure as `primary_usage_limit`.
4. No valid implementation report was produced by that invocation.
5. Backup has not already failed or entered an ambiguous state.

When availability fallback is activated, the runtime records
`backup_activation_reason: primary_usage_limit`, sets the backup as the active
Hands profile for the rest of the run, and retries the same logical operation
once. Subsequent Hands calls use backup directly. Brain Hands does not probe the
primary profile again during that run. The fallback context includes a fresh
worktree snapshot and current diff so backup can reconcile any partial edits
left by the interrupted primary invocation.

Before invoking recovery, the runtime transitions durably to
`recovery_pending`, records the triggering review and evidence paths, validates
the configured profile, and then transitions to `recovery_in_progress`.
These are recovery states within work-item progress; they do not add generic
top-level workflow stages.

Recovery ends in exactly one of these outcomes:

- Verifier approval: complete the work item normally.
- `replan_required`: enter the existing replanning path.
- Actionable rejection: set the item to blocked with reason code
  `escalation_exhausted`.
- Operational or infrastructure failure: set the item to blocked with the
  corresponding reason code; do not call a substitute model.

If backup was activated earlier because of a primary usage limit, exhausting
three actionable fix attempts does not invoke backup again as a separate
quality recovery tier. The run blocks with `escalation_exhausted` because its
only configured backup is already active.

Resuming an exhausted or ambiguous recovery state never invokes Hands again.
Only a new approved plan revision or an explicit future operator command may
reset the recovery state.

## Model Catalog Validation

Preflight runs `codex debug models` and validates both the primary Hands profile
and the configured backup profile against the returned catalog. It checks the
exact model slug and requested reasoning effort. If the catalog cannot prove
support, preflight fails with a profile-specific diagnostic.

The runtime repeats backup-profile validation immediately before either
availability fallback or quality recovery to detect catalog or entitlement
drift during a long run. The catalog result,
selected entry, and validation timestamp are stored in the run ledger. Catalog
validation never substitutes a nearby model or lowers reasoning effort.

## Recovery Context Packet

The recovery prompt uses a bounded, structured packet containing:

- The approved work item and acceptance criteria.
- Scope exclusions and implementation constraints.
- The current diff and changed-file list.
- The latest unresolved Verifier findings.
- A compact table of previous attempt profiles and outcomes.
- Verification commands already run and their evidence paths.
- Summaries from prior implementation reports and remaining risks.
- An explicit instruction to form an independent diagnosis before editing.

Full stdout, stderr, and prior prompts remain linked as ledger artifacts but are
not concatenated into the recovery prompt. This limits context growth and
reduces the chance that recovery merely repeats the last primary attempt. The
rendered packet is persisted before invocation so the recovery decision is
auditable and resumable.

## Ledger and Provenance

Each logical implementation attempt receives an immutable record such as:

```yaml
ordinal: 5
kind: recovery_fix
status: completed
model: gpt-5.6-luna
reasoning_effort: medium
trigger_review_path: reviews/item-1/attempt-4.json
implementation_path: implementation/item-1/attempt-5.json
verification_path: verification/issue-1/attempt-5/evidence.json
review_path: reviews/item-1/attempt-5.json
failure_class: implementation_failure
outcome: request_changes
```

An availability fallback record additionally contains both invocations:

```yaml
ordinal: 2
kind: primary_fix
active_profile: backup
backup_activation_reason: primary_usage_limit
invocations:
  - profile: primary
    model: gpt-5.3-codex-spark
    outcome: primary_usage_limit
    budget_consumed: false
  - profile: backup
    model: gpt-5.6-luna
    outcome: implementation_completed
    budget_consumed: true
```

The manifest keeps only resumable summary state:

```yaml
primary_fix_attempts: 3
quality_recovery_attempts: 1
recovery_state: exhausted
active_hands_profile: primary
backup_activation_reason: null
last_attempt_path: attempts/item-1/attempt-5.json
blocker_code: escalation_exhausted
```

`active_hands_profile` changes to `backup` only for availability fallback and
is global to the run. A quality-recovery invocation uses backup for that one
work-item attempt without changing the primary route for later work items.

Attempt records, model invocations, verification evidence, and Verifier reviews
must agree on work-item ID and ordinal. Delivery remains impossible when these
provenance links disagree.

## GitHub Status Reporting

GitHub mode maintains one marker-delimited Brain Hands status comment per work
item and updates it instead of adding an unbounded comment for every attempt.
The status table includes logical attempt, invocation profile, model, reasoning
effort, activation reason, and outcome.

When recovery starts, the comment includes:

```md
## Model recovery

The primary Hands profile exhausted 3 corrective fix attempts after actionable
Verifier rejection.

Recovery attempt 1/1: `gpt-5.6-luna` with `medium` reasoning.
The recovery context includes prior findings and verification evidence.

Next: deterministic verification and Verifier review.
```

If recovery is rejected, the same comment is updated with
`blocked: escalation_exhausted` and the exact ledger artifact paths needed for
a human decision. Local mode reports the equivalent information through status
output and the run ledger.

When availability fallback activates, the comment states that the primary
usage limit did not consume a logical attempt, names the selected backup
profile, and records that primary is circuit-broken for the remainder of the
run.

## Resume and Concurrency Safety

- Persist `recovery_pending` before catalog validation and invocation.
- Persist the attempt record as `started` before launching Codex.
- Persist backup activation before retrying a usage-limited logical operation.
- Mark the fix budget consumed only after a successful structured Hands result.
- Never launch a second recovery invocation when a started recovery record
  already exists; block for inspection if completion cannot be proven.
- Never probe primary again after `active_hands_profile` becomes `backup`.
- Use the existing append-only event ledger for transitions and immutable
  attempt artifacts for detailed provenance.
- Derive issue status from ledger state so repeating GitHub synchronization is
  idempotent.

## Testing Strategy

### Configuration and migration

- Parse a configured single backup profile.
- Reject zero, two, or more quality-recovery attempts.
- Preserve existing v2 configuration behavior when `backup` is absent.
- Persist model and reasoning effort without legacy alias drift.

### Counting and routing

- Prove the initial implementation does not consume a primary fix.
- Prove three successful primary fixes are allowed.
- Prove recovery becomes eligible only after the third actionable rejection.
- Prove at most one recovery invocation occurs across fresh and resumed runs.
- Prove a confirmed primary usage limit retries the same logical operation on
  backup without consuming the attempt twice.
- Prove subsequent Hands operations stay on backup after activation.
- Prove backup already active prevents a second quality-fallback activation.
- Prove `replan_required` bypasses recovery.

### Failure classification

- Route a failed product test to Verifier classification.
- Distinguish a confirmed primary usage limit from auth, generic quota,
  catalog, timeout, malformed-output, and missing-command failures.
- Block ambiguous usage-limit and all backup-profile failures without consuming
  the logical attempt.
- Reject `implementation_failure` without actionable findings.
- Fail closed on ambiguous or malformed classifications.

### Catalog and prompt context

- Validate exact model and reasoning support from a catalog fixture.
- Revalidate immediately before recovery and block on drift.
- Prove no substitute model or reasoning downgrade is invoked.
- Snapshot the bounded recovery context packet and ensure it references all
  prior artifacts without embedding raw transcripts.

### Ledger, resume, and GitHub

- Record exact profile provenance for initial, primary-fix, and recovery
  attempts.
- Resume safely from every recovery boundary without duplicating an attempt.
- Resume safely between the primary usage-limit record and backup invocation.
- Block delivery on mismatched attempt, evidence, or review provenance.
- Upsert one status comment and render `escalation_exhausted` accurately.

### End-to-end ceilings

- Approved initial implementation: one Hands call and one Verifier call.
- Approval after primary fix three: four Hands calls and four Verifier calls.
- Approval after recovery: five Hands calls and five Verifier calls.
- Rejected recovery: five Hands calls, five Verifier calls, and a durable
  `escalation_exhausted` blocker.
- Primary usage limit: one failed primary invocation plus one backup invocation
  for the same logical attempt; only the successful backup invocation consumes
  the logical attempt budget.

## Acceptance Criteria

- The initial implementation is excluded from `max_hands_fix_attempts`.
- A work item can receive exactly three primary fixes and at most one configured
  recovery fix.
- A confirmed primary usage limit activates the same configured backup for the
  current logical operation and the remainder of the run.
- A usage-limited primary invocation never consumes the logical fix budget, and
  backup activation can happen at most once per run.
- Only validated actionable implementation failures advance toward recovery.
- Operational and test-infrastructure failures consume no fix budget and do
  not trigger fallback.
- Both configured profiles are catalog-validated at preflight, and recovery is
  revalidated immediately before use.
- Every attempt records its model, reasoning effort, artifact links, failure
  classification, and outcome.
- Recovery receives the bounded diagnostic packet and cannot alter approved
  scope.
- A rejected recovery ends in `blocked: escalation_exhausted` without another
  model invocation.
- Resume and GitHub synchronization are idempotent at every recovery boundary.
