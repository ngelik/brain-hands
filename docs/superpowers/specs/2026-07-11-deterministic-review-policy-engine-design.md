# Deterministic Review Policy Engine Design

**Status:** Approved design

**Date:** 2026-07-11

## Purpose

Make progress-by-default a deterministic engine invariant. Verifier output supplies evidence and recommendations, but only the engine may decide whether a run advances, fixes, replans, awaits approval, continues with an authorized warning, or stops.

This design extends the existing quality-gate, Hands backup, ordered Reviewer-action, and focused-action Verifier work. Those components remain execution mechanisms beneath the policy engine; they do not acquire transition authority.

## Goals

- Separate review evaluations, successful fix invocations, self-review mutations, and approved plan revisions.
- Apply one policy evaluator to work-item, final-integrated, and post-PR review phases.
- Validate model classifications before they influence workflow state.
- Normalize deterministic verification failures into engine-authored findings.
- Keep operational failures outside review and fix budgets.
- Generate stable finding identity and immutable history outside the manifest.
- Support narrow, approval-gated replan patches without replacing the worktree or prior history.
- Make every policy decision and effect crash-safe and idempotent.
- Preserve approval gates, irreversible-action authority, and the no-auto-merge guarantee.

## Non-Goals

- The policy engine does not merge pull requests.
- It does not let prompts define legal state transitions.
- It does not silently migrate active legacy runs to new policy semantics.
- It does not make critical or high release blockers waivable.
- It does not replace existing Hands self-review, backup routing, evidence validation, or focused-action verification.

## Architectural Boundary

The workflow is split into five deterministic layers:

1. **Input adapters** collect Verifier reviews and deterministic verification evidence.
2. **Normalizer** converts those inputs into validated engine findings or operational blockers.
3. **Policy evaluator** returns one legal action without side effects.
4. **Decision ledger** persists the immutable decision before any external effect.
5. **Effect executor** performs exactly one idempotent effect and records its completion.

```text
Verifier claims + verification evidence
  -> normalize and validate
  -> assign stable finding identity
  -> evaluate pure review policy
  -> persist decision and effect identity
  -> execute exactly one effect
  -> persist effect completion
```

The existing ordered action queue is invoked only when the evaluator chooses `fix`. The queue cannot independently advance, waive, replan, or stop a run.

## Canonical Policy

```yaml
review_policy:
  max_fix_cycles: 3
  on_limit: auto_replan
  auto_advance_on_approval: true

  severity_defaults:
    critical: blocking
    high: blocking
    medium: fix_in_scope
    low: advisory

  pause_on:
    - plan_approval
    - irreversible_external_action
    - unresolved_release_blocker
```

Allowed `on_limit` values are `auto_replan`, `stop`, and `continue_with_warning`. Warning continuation is authority only when explicitly selected for the run or approved with its plan. A repository default alone cannot authorize a waiver.

Per-run overrides use the same fields and vocabulary as repository configuration. The engine resolves repository policy plus run override once, validates it, and snapshots the effective policy into the run ledger at creation. Later configuration edits cannot affect an active run.

Existing active manifests without a policy snapshot continue under legacy behavior. They are not inferred or silently upgraded. New runs receive the canonical default unless explicitly overridden.

## Release Guards and Criterion Identity

At approved-plan persistence, every acceptance criterion receives a stable reference:

```text
BH-005:AC-1
BH-005:AC-2
```

The approved plan also snapshots these default release guards:

- `release:no-secrets`
- `release:no-auto-merge`
- `release:no-critical-regression`
- `release:required-verification`

Additional approved guards may be added by the plan. A blocking finding must reference an approved acceptance criterion or release guard. The engine rejects unknown references.

## Finding Contract

Normalized findings use one engine-owned contract:

```ts
type FindingSource = "verifier" | "verification" | "release_guard";
type FindingDisposition =
  | "blocking"
  | "fix_in_scope"
  | "requires_replan"
  | "follow_up"
  | "advisory";

interface EngineFinding {
  finding_id: string;
  work_item_id: string;
  source: FindingSource;
  severity: "critical" | "high" | "medium" | "low";
  disposition: FindingDisposition;
  criterion_ref: string;
  normalized_location: string;
  problem_class: string;
  problem: string;
  required_fix: string | null;
  evidence_refs: string[];
  first_seen_revision: number;
  last_seen_revision: number;
  occurrences: number;
  repeated_from?: string;
}
```

The engine computes `finding_id` from normalized `work_item_id`, `criterion_ref`, `source`, location, and problem class. Model wording and model-generated IDs are excluded. Repeated findings update occurrence metadata while preserving immutable revision records.

## Model Claim Validation

Verifier fields are claims, not commands. Normalization enforces:

- A blocker references a known acceptance criterion or release guard.
- `critical` and `high` findings remain blocking and cannot be advisory, follow-up, or automatically waived.
- `requires_replan` findings never go directly to Hands.
- `request_changes` containing only advisory or follow-up findings normalizes to no blocking findings.
- `approve` containing any blocking finding is invalid and becomes an operational review-contract blocker.
- Unknown criterion references, contradictory classifications, and malformed evidence references fail closed.

## Verification Normalization

Product failures from deterministic commands, checked artifacts, and browser checks become engine-authored findings. Each finding references the failed approved criterion or `release:required-verification` and the immutable evidence paths.

Examples include failing tests, missing required generated artifacts, browser assertion failures, and regressions in completed Reviewer actions. These enter the same bounded policy flow as validated Verifier findings.

Environment and runtime failures remain separate:

- Codex unavailable or malformed transport response
- permissions or filesystem access failure
- network or service outage
- invalid or unavailable model catalog
- corrupt or ambiguous persisted state

These produce `operationally_blocked`, consume no review or fix budget, and never masquerade as a request for user authority.

## Counters

Each work item tracks independent counters:

```ts
interface ReviewAccounting {
  review_revision: number;
  fix_cycles_used: number;
  self_review_mutations_used: number;
  plan_revision: number;
}
```

- `review_revision` increments for every completed policy evaluation, including approval and advisory-only reviews.
- `fix_cycles_used` increments only after a successful engine-authorized Hands fix invocation. It includes normal fixes, Reviewer-action attempts, recovery fixes, final-integrated fixes, and post-PR fixes.
- A failed primary usage-limit call does not increment the counter. A successful backup fix does.
- Initial implementation does not increment the counter.
- Hands self-review corrections do not consume the policy fix budget; they increment `self_review_mutations_used`.
- `plan_revision` is the approved plan lineage for the item.
- Operational failures increment none of these counters.

This supersedes the earlier rule that an entire Reviewer action queue consumes one fix cycle. Every successful action fix attempt consumes one fix cycle; per-action retry limits remain an additional bound.

## Pure Policy Evaluator

```ts
type ReviewAction =
  | "advance"
  | "fix"
  | "create_replan"
  | "await_plan_approval"
  | "continue_with_warning"
  | "stop";

interface ReviewPolicyDecision {
  action: ReviewAction;
  reason_code: string;
  finding_ids: string[];
  policy_revision: number;
  authorization_required: boolean;
}
```

`evaluateReviewPolicy` is a pure function. It receives the effective policy, normalized findings, deterministic verification status, accounting state, phase, and any valid authorization. It cannot read files, call models, mutate the manifest, or perform Git operations.

The canonical decision table is:

| Condition | Action |
|---|---|
| No blocking findings | Record advisory/follow-ups and `advance` |
| In-scope blocker and fix budget remains | `fix` |
| Blocker requires approved-plan change | `create_replan` |
| Replan patch exists but is unapproved | `await_plan_approval` |
| Fix limit reached with no blockers | Write convergence report and `advance` |
| Fix limit reached with blockers | Write convergence report and `create_replan` |
| Authorized warning continuation and no critical/high blocker | `continue_with_warning` |
| Critical/high release blocker remains | `stop` |
| External/runtime failure | Record `operationally_blocked`; no policy action is executed |

## Decision and Effect Idempotency

Each review revision produces an immutable review-cycle artifact containing normalized inputs, the policy snapshot hash, counters before evaluation, and the decision.

Before any external effect, the engine persists:

```ts
interface ReviewCycleState {
  cycle_id: string;
  work_item_id: string;
  phase: "work_item" | "final_integrated" | "post_pr";
  review_revision: number;
  decision_path: string;
  effect_id: string;
  effect_state: "pending" | "in_progress" | "complete" | "blocked";
}
```

Resume loads and validates this state. It never reevaluates a completed revision under different policy and never performs a second effect for the same `effect_id`. Ambiguous post-effect failures remain blocked until a dedicated reconciliation path proves whether the effect completed.

## Ordered Reviewer Actions

When policy chooses `fix` for multiple in-scope findings, the engine may create an immutable ordered action queue. Existing guarantees remain:

- Actions have engine-normalized, revision-scoped identity.
- Hands receives only the active action, completed-action summaries, approved scope, and relevant evidence.
- Actions execute in validated dependency order.
- Deterministic verification must pass before focused Verifier resolution.
- Configured self-review passes run after each successful Hands mutation.
- A focused `resolved` claim cannot override failed deterministic evidence.
- The active action advances only when the policy-authorized fix effect completes and all gates pass.
- Each successful action Hands invocation increments `fix_cycles_used`.
- Per-action attempts remain bounded separately.

The currently paused Task 7 runtime diff is treated as partial queue-executor work. Its useful artifact and resume machinery will be retained, but its direct transition decisions must be replaced by policy decisions before it is committed.

## Convergence Reports

When the fix budget is exhausted or a repeated finding prevents convergence, the engine writes an immutable report containing:

- policy and plan revision;
- review and fix counters;
- unresolved, repeated, resolved, advisory, and follow-up finding IDs;
- attempted fixes and immutable evidence references;
- remaining release guards;
- recommended next action;
- warning-continuation authorization, if applicable.

The manifest stores only the current report pointer and compact summary.

## Narrow Replan Patches

```ts
interface ReplanPatch {
  target_work_item_id: string;
  base_plan_revision: number;
  unresolved_finding_ids: string[];
  revised_objective?: string;
  added_or_changed_criteria: AcceptanceCriterion[];
  changed_instructions: string[];
  explicitly_rejected_hardening: string[];
}
```

Brain receives only the approved target item, unresolved blockers, convergence report, current release guards, and immutable evidence references. It produces a patch, not a replacement plan.

Approval preserves the work-item ID, issue, branch, worktree, commits, evidence, and finding history. It increments only that item’s `plan_revision`, resets only its `fix_cycles_used`, clears only active evidence/review/decision pointers, and returns to `worktree_setup` without creating another worktree. Completed items remain untouched.

The reset persists an idempotent `approved_replan_attempt_reset` event. Duplicate approval or resume cannot reset the item twice.

The CLI accepts `replanning` and `awaiting_plan_approval` as first-class resume stages. It can generate or display the patch, await approval, apply an approved reset, and continue the same run.

## Final-Integrated and Post-PR Phases

Both phases normalize evidence and reviews through the same policy kernel. They do not maintain independent retry decision tables.

- Final-integrated blockers may fix, replan, stop, or advance according to the same snapshot.
- Post-PR fixes may commit and push to the existing PR after approval by the policy and verification gates.
- Brain Hands never merges the PR.
- Strict delivery proof remains mandatory before delivery state becomes complete.

## Waiver Authorization

Waiver support is implemented only after the base evaluator, replanning, and convergence paths are complete.

```ts
interface WarningContinuationAuthorization {
  actor: string;
  source: "run_override" | "approved_plan";
  finding_ids: string[];
  reason: string;
  residual_risk: string;
  evidence_snapshot: string[];
  timestamp: string;
  policy_revision: number;
}
```

Schema and runtime both reject authorizations covering a critical or high release blocker. A repository default is never sufficient waiver authority.

## Persistence Layout

The manifest remains compact:

```ts
finding_index: Record<string, FindingSummary>;
review_cycles: Record<string, ReviewCycleState>;
artifact_paths: {
  findings: string;
  convergence_reports: string[];
};
```

Complete immutable records are stored under:

```text
findings/<encoded-work-item-id>.jsonl
reviews/<encoded-work-item-id>/revision-N.json
decisions/<encoded-work-item-id>/revision-N.json
convergence/<encoded-work-item-id>/revision-N.json
replans/<encoded-work-item-id>/plan-revision-N.json
authorizations/<encoded-work-item-id>/revision-N.json
```

All paths use collision-free encoded identifiers, root confinement, create-once writes, schema validation, provenance validation, and bounded prompt materialization.

## Operator States

Status, logs, JSON output, and GitHub status comments expose these states directly:

- `progressing_automatically`
- `awaiting_plan_approval`
- `awaiting_irreversible_action_authority`
- `operationally_blocked`
- `unresolved_release_blocker`
- `delivered`

Normal automatic execution does not return a reply menu. Human input is requested only for an explicit approval/authority boundary or an unresolved release blocker that policy cannot legally advance.

## Migration and Compatibility

- V1 behavior remains unchanged.
- Existing V2 configuration without `review_policy` continues to load.
- New V2 runs resolve canonical defaults and persist a policy snapshot.
- Existing active V2 runs without a snapshot continue through the legacy decision path.
- Existing quality-gate and backup snapshots remain authoritative for active runs.
- The old `max_hands_fix_attempts` value maps to `max_fix_cycles` only when creating a new policy snapshot; it is not reread during resume.
- Manifest additions remain backward-compatible optional fields until a run opts into the new policy snapshot.

## Testing Strategy

1. Schema and configuration tests cover defaults, overrides, release guards, authorization restrictions, and legacy loading.
2. Table-driven evaluator tests cover every decision-table row, severity/disposition combination, phase, budget boundary, and authorization rule.
3. Finding tests cover fingerprint stability across wording changes, repetition, unknown criteria, contradictory approval, and immutable JSONL history.
4. Verification normalization tests distinguish product failures from operational blockers.
5. Counter tests prove reviews, successful fixes, self-review corrections, initial implementation, usage-limit failures, and backup successes affect only their intended counters.
6. Queue tests prove one action at a time, deterministic failure cannot advance, every successful action fix consumes one fix cycle, and resume repeats no completed boundary.
7. Replan tests cover patch scope, approval, targeted reset, duplicate approval, same-worktree reuse, and completed-item preservation.
8. Final-integrated and post-PR tests prove evaluator parity and no-auto-merge behavior.
9. Crash/replay tests interrupt after normalization, decision persistence, effect start, effect completion, convergence report, replan patch, and approved reset.
10. End-to-end tests cover automatic progression, operational blocking, unresolved release blockers, authorized warning continuation, final delivery, and old-run compatibility.

## Rollout Order

1. Add policy, guard, finding, decision, and persistence contracts.
2. Build finding normalization and the pure evaluator with no runtime behavior change.
3. Introduce separate accounting and immutable review-cycle persistence.
4. Refactor work-item execution to decision-then-effect.
5. Adapt the ordered action executor beneath `fix` decisions and close its paused review findings.
6. Add convergence reports and narrow replanning/reset.
7. Apply evaluator parity to final-integrated and post-PR phases.
8. Add waiver authorization.
9. Complete operator surfaces and end-to-end crash/replay coverage.

## Acceptance Criteria

- No prompt or model response directly chooses a legal workflow transition.
- Every transition-producing review has an immutable engine decision record.
- Counters follow the definitions in this design and remain stable across resume.
- Product verification failures enter the bounded fix policy; operational failures do not consume policy budget.
- Critical/high release blockers never auto-advance or auto-waive.
- Replans are narrow, approval-gated patches that preserve existing worktree and history.
- Work-item, final-integrated, and post-PR phases use the same evaluator.
- Duplicate resume cannot repeat a completed model call, command, commit, push, replan reset, or policy effect.
- Existing active runs without a policy snapshot retain legacy behavior.
- No workflow path auto-merges a pull request.
