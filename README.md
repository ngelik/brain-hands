# Brain Hands / brain-hands

[![CI](https://github.com/ngelik/brain-hands/actions/workflows/ci.yml/badge.svg)](https://github.com/ngelik/brain-hands/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/%40ngelik%2Fbrain-hands)](https://www.npmjs.com/package/@ngelik/brain-hands)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

Brain Hands is a Codex skill with `brain-hands` as its deterministic workflow
engine. A strong Brain model researches and plans, Hands implements approved
work, and an independent Verifier checks every result. The skill asks only for
missing execution choices and never infers approval from silence.

The CLI is the control plane. It stores every run on disk, carries work through issue-sized tasks, captures verification evidence, and keeps review/fix loops explicit. GitHub issues and PRs are supported, but GitHub is not required for review because the tool can generate local review packages.

Brain Hands is under active pre-1.0 development. Release notes and migration
guidance accompany breaking changes.

On the first Brain Hands task in a repository, the conversational skill checks
for `.brain-hands/config.yaml` and asks permission to run local-only
initialization. Once initialized, it prints the complete engine-owned
configuration preview before asking only for the remaining run choices.

## Durable Brain discovery

Every new run stops successfully at its first user boundary and completes
repository-grounded discovery before Brain drafts an execution plan. Brain asks
one question at a time. The engine persists the exact question, answer,
approaches, brief revision, and approval; discovery remains local-only even in
GitHub mode. `resume` is read-only at a discovery boundary and returns the
already persisted pending action without invoking Brain again.

The five discovery actions are explicit:

```text
brain-hands answer-discovery --run <run-dir> --question <id> [--input-file <path>]
brain-hands select-discovery-approach --run <run-dir> --revision <number> --approach <id>
brain-hands proceed-discovery --run <run-dir> --question <id> [--input-file <path>]
brain-hands revise-discovery --run <run-dir> --revision <number> [--input-file <path>]
brain-hands approve-discovery --run <run-dir> --revision <number>
```

Text defaults to standard input so answers do not have to enter shell history.
Each machine-readable pending action includes the fixed
`permitted_next_actions` for its boundary. `proceed-discovery` records a durable
forced-proceed intent; Brain cannot ask another question and must carry the
remaining uncertainty into the brief as a linked proceed-sourced assumption
whose statement preserves the operator guidance.
Suspected secrets are rejected before ordinary persistence or model reuse.
Initial discovery has a five-answer soft limit and six-answer hard limit; a
planning gap allows its evidence-backed question and at most one follow-up.
The engine verifies the exact brief revision's SHA-256 before planning and
on resume. Discovery-brief approval and execution-plan approval are separate:
only a later exact `approve-plan` authorization starts Hands or target/GitHub
mutation. Legacy runs resume under their original protocol without synthetic
discovery state.

## Deterministic plan approval requests

At a plan boundary, `brain-hands status --json` exposes the verified structured
`plan_approval_request` separately from discovery `pending_action`. The JSON
read detects the boundary and verifies its exact revision and subject; the
object is not the rendered approval display. The conversational skill does not
display, re-stringify, reorder, or summarize it for approval. When a request is
pending, the skill runs human-readable `brain-hands status` as a second full
verification and relays the exact engine-rendered approval block from
`Approval required:` through `Next command (approve-plan):` verbatim and in
full.

An initial block summarizes the complete authorization: scope, commands,
risks, external effects, and authority. A material replan is fully persisted
and validated before prompting, and its human status block uses delta-first
ordering: the deterministic delta, unchanged high-impact categories,
additional-approval expectations, and the exact next command. Invalid or
byte-identical no-op replans block before an approval prompt.

Approval is durable within one run. Internal retries and fixes inside the
approved contract do not create a new request, repeated approval of the exact
subject is idempotent, and same-run `resume` continues without asking for
approval again. Cross-run approval carry-forward is unsupported; each new run
establishes its own approval subjects. Merge remains a separate manual action.

| Scenario | New approval prompts |
| --- | ---: |
| Normal run | 2: discovery brief and initial plan |
| Hands retry inside approved contract | 0 |
| Verifier fix inside approved contract | 0 |
| Process restart after approval | 0 |
| Repeated exact `approve-plan` | 0 |
| Material replan | 1 |
| Invalid or no-op replan | 0; block before prompting |
| GitHub merge | Separate manual action |

## Core Flow

1. **Interactive intake and discovery**
   `$brain-hands` asks for only omitted local/GitHub mode, research, and
   reflection choices. `brain-hands run` creates `.brain-hands/runs/<run-id>/`,
   stores the original request, and stops at the first durable discovery
   boundary. The skill presents engine-authored content verbatim and records
   one user action at a time.

2. **Brief and plan approval**
   The exact discovery brief revision and digest are approved first. Brain then
   creates the execution plan, which has its own explicit approval gate.

3. **Issue handoff**
   Each v2 issue contains the exact `ExecutionSpecV2` JSON object approved in
   the Brain plan. The same object is supplied to Hands, Verifier, GitHub, and
   local review packages; no role receives a lossy projection.
   GitHub-mode work-item titles use the generated form
   `[<feature-slug>:<execution-sequence>:<work-item-id>] <action-oriented title>`.
   Models supply unprefixed titles; the runtime alone topologically orders the
   approved work items and adds the prefix and sequence. Dependencies precede
   dependents, and approved plan order breaks ties between independent items.
   The sequence is presentation-only; the work-item ID and hidden markers remain
   the dependency, ledger, and recovery identities. A dependency change may
   renumber visible titles without changing issue numbers or mappings. Run IDs
   and plan revisions stay in the issue body rather than the title.

4. **Hands implementation and verification**
   After explicit plan approval, `brain-hands approve-plan` or `resume` invokes
   Hands one work item at a time in an isolated worktree. Verifier runs the
   frozen verification commands and records attempt-scoped evidence before any
   commit or delivery.

5. **Delivery**
   Local mode reaches delivery with a verified branch/worktree. GitHub mode
   creates or recovers labeled issues and one pull request, then runs a final
   post-PR Verifier gate. Brain Hands never merges automatically.
   A plan may request one `[<feature-slug>] <title>` parent issue. Its title
   remains unnumbered, its issue number is stored separately from child issue
   mappings, and the integrated pull request closes both the parent and its
   children.

6. **Bounded fix loop**
   Requested changes stay on the same worktree and pull request. The engine
   classifies findings, fixes one Reviewer action at a time, and never starts
   the next action until the previous action passes focused verification.
   Hands performs the configured self-review passes before Verifier review.
   Roles run sequentially under the controller; nested agents and fan-out are
   disabled inside Brain, Hands, Verifier, self-review, and reflection calls.

7. **Reflection (optional terminal step)**
   When enabled, Brain writes a single process reflection after any terminal
   outcome: delivered, human accepted, abandoned, or explicitly closed while
   blocked. A resumable blocker is quiescent, not terminal. Reflection never
   reopens implementation.

`brain-hands` does not auto-merge. Approval and final audit are evidence, not
deployment triggers.

## Models and reasoning

The V2 defaults are intentionally explicit:

| Role | Model | `reasoning_effort` | Sandbox |
| --- | --- | --- | --- |
| Brain | `gpt-5.6-sol` | `high` | `read-only` |
| Hands | `gpt-5.6-luna` | `high` | `workspace-write` |
| Verifier | `gpt-5.6-sol` | `high` | `read-only` |

Hands self-review and terminal reflection use phase-specific `medium`
reasoning by default. `brain-hands preview` displays those effective phase
settings and the controller-enforced nested-agent prohibition.

Before conversational intake or direct CLI execution, inspect the effective
configuration without starting a workflow:

```bash
brain-hands preview --repo . --json
brain-hands preview --repo . --mode local --no-research
```

Choices may be supplied independently. JSON returns the safe effective
settings, canonical `missing_choices`, and the exact engine-rendered
`rendered_preview` that the skill displays verbatim before any question. An
all-pending preview looks like:

```text
Brain Hands configuration preview (3 choices pending)

Repository: /path/to/repository
Initialized: .brain-hands/config.yaml
Controller: @ngelik/brain-hands <version> (installed)

Mode: needs your choice
Research: needs your choice
Reflection: needs your choice

Roles:
Brain: gpt-5.6-sol | high reasoning | read-only | repository config
Hands: gpt-5.6-luna | high reasoning | workspace-write | repository config
Verifier: gpt-5.6-sol | high reasoning | read-only | repository config

Hands backup: disabled
Hands fix attempts: 3
Replan attempts: 2
Review limit: 2 fix cycles; auto replan
Quality gate: 1 Hands self-review passes; 2 reviewer-action attempts; focused Verifier confirmation required
Nested subagents: disabled (controller enforced)
Hands self-review reasoning: medium
Reflection reasoning: medium
Reflection protocol: single pass
GitHub remote: origin
GitHub effects: depends on execution-mode choice
```

`preview` reads validated repository configuration without migrating it. It
does not create a run or write any workflow artifact. It does not run preflight,
invoke a model, inspect GitHub, or mutate GitHub. Omitted YAML policy values are
resolved through the same schema and policy functions used by `run`.

Before preflight or any model call, `brain-hands run` prints the resolved run
configuration: mode, research and reflection choices, controller version,
each role's model/reasoning/sandbox and whether it came from repository config
or a CLI override, backup policy, retry/review/quality limits, and GitHub
effects. `run --json` and `status --json` expose the same allowlisted object as
`run_configuration`; the durable copy is `run-configuration.json` in the run
directory. Internal executable paths, package hashes, and candidate commits are
not included in this operator-facing projection.

Preview output is ephemeral. `run-configuration.json` is created only after
all choices are supplied and `run` creates the durable ledger. A fully
specified preview and a newly created run resolve the same visible settings;
preview is configuration visibility, not execution-readiness proof.

The supplied model matrix is a reference for planning and documentation. It
is separate from the authoritative live catalog returned by `codex debug
models`:

| Supplied model ID | Supported reasoning levels |
| --- | --- |
| `gpt-5.6-sol` | `low`, `medium`, `high`, `xhigh`, `max`, `ultra` |
| `gpt-5.6-terra` | `low`, `medium`, `high`, `xhigh`, `max`, `ultra` |
| `gpt-5.6-luna` | `low`, `medium`, `high`, `xhigh`, `max` |
| `gpt-5.3-codex-spark` | `low`, `medium`, `high`, `xhigh` |

At runtime, Brain Hands reads the authoritative live catalog and matches the
full configured model ID and its `supported_reasoning_levels` exactly. It does
not guess, use aliases, substitute another model, fall back, or maintain a
runtime reasoning-effort allowlist. Validation runs during required preflight,
before every `SubprocessCodexAdapter` execution, and before the optional live
preflight probe; a failed validation prevents the corresponding Codex
execution.

If validation fails, update Codex, inspect the live catalog with `codex debug
models`, then change the exact configured profile `model` or
`reasoning_effort`. Raw Codex calls configure reasoning through
`-c 'model_reasoning_effort="high"'`.

## Install Brain Hands

Install the stable CLI from npm, or build the development checkout directly:

```bash
npm install -g @ngelik/brain-hands
npm run build
```

The repository also contains the Codex skill at `.agents/skills/brain-hands/`
and the plugin manifest at `.codex-plugin/plugin.json`. These repository
integration sources are intentionally not included in the npm runtime tarball.
Install a tag-pinned skill snapshot separately through the repository
marketplace:

```bash
codex plugin marketplace add ngelik/brain-hands --ref vMAJOR.MINOR.PATCH --json
codex plugin add brain-hands@brain-hands --json
codex plugin list --json
```

To replace an existing tag-pinned installation, remove only this plugin and
marketplace before adding the new tag:

```bash
codex plugin remove brain-hands@brain-hands --json
codex plugin marketplace remove brain-hands --json
codex plugin marketplace add ngelik/brain-hands --ref vMAJOR.MINOR.PATCH --json
codex plugin add brain-hands@brain-hands --json
```

A fresh Codex task is required to load updated skill instructions; an existing
task retains its already-loaded snapshot. Do not use `marketplace upgrade` for
a tag-pinned source because its ref is intentionally immutable.
The skill wrapper requires the compatible installed `brain-hands` command and
performs version and `doctor` capability handshakes. It never silently falls
back to checkout code. Explicit wrapper development may use
`--development-controller`; direct development uses `npm run dev` or
`node dist/cli.js`. Do not use `npm link` for the stable command.

Runs against the Brain Hands package or canonical repository are automatically
classified as self-hosting. Stable self-hosting requires an installed package
outside every candidate checkout/worktree and records the controller launcher,
package root, version, runtime-tree SHA-256, and candidate commit. `approve-plan`
and `resume` fail closed if that provenance changes. Checkout-controller runs
are development-only and remain visibly marked in the run manifest.

## Run Artifacts

Run state lives under `.brain-hands/runs/<run-id>/`.

Common files:

- `manifest.json`
- `run-configuration.json`
- `session-state.json`
- `session-events.jsonl`
- `progress.jsonl`
- `original-request.md`
- `discovery/pending-action.json`, `discovery/questions/`, and `discovery/answers/`
- `discovery/proceed-with-assumptions.json` when the operator stops questioning
- `discovery/approaches/revision-<n>.json` and its selection artifact
- `discovery/briefs/revision-<n>.json` and `discovery/approved-brief.json`
- `research.md`
- `architecture-plan.md`
- `issues.json`
- `issue-review.md`
- `implementation-issue-<n>.md`
- `verification/issue-<n>/evidence.json`
- `verification/issue-<n>/browser-evidence.json`
- `reviews/pr-<n>-review.json`
- `fixes-pr-<n>.md`
- `review-packages/issue-<n>/review.md`
- `summaries/work-items/<work-item>/plan-<n>/attempt-<n>.json`
- `evidence-indexes/verifier/final-integrated/attempt-<n>.json`
- `evidence-indexes/verifier/post-pr/attempt-<n>.json`
- `evidence-indexes/reflection/final.json`
- `contexts/hands/`, `contexts/verifier/`, and `contexts/reflection/`
- `budgets/policy.json`, `budgets/claims/`, and `budgets/completions/`
- `prompts/` and `responses/`

The run ledger is the source of truth for resume, review, and audit behavior.
GitHub issue titles and their execution sequences are presentation only. Hidden
run/work-item markers and stable work-item IDs remain authoritative, and Brain
Hands only rewrites content inside its managed body markers so user notes outside
that section survive resume and replanning.

### Canonical session artifacts

Every new run preallocates one run-wide `run_id`, `session_id`, and
`canonical_event_id`. Those identities remain stable across the separate CLI
processes used for discovery approval, plan approval, implementation, and
resume. A worker's process or progress-session identifier is observational and
does not replace the run-wide identity.

The three session artifacts have different authority:

- `session-state.json` is the canonical summary. It contains the bounded
  command, role-invocation, status, source, and token aggregates, timestamps,
  duration, and terminal fields; it is not a copy of the progress log.
- `session-events.jsonl` is the canonical finalized event stream. It is empty
  while the run is active and contains one `session_finalized` event at the
  terminal boundary. The event carries the same run/session/event identity,
  aggregates, and terminal provenance as the finalized summary.
- `progress.jsonl` is the raw operator progress stream: normalized safe labels,
  coordinates, heartbeats, usage, and durations. It is useful for observation
  and `logs --follow`, but it is not the canonical summary, approval evidence,
  verification evidence, or terminal event.

Session reads use strict paired validation under the run ledger lock. The state
and event schemas, run/session/event IDs, terminal fields, and manifest terminal
provenance must agree; an active pair has no canonical event, and a finalized
pair has exactly one event materialized from the state. A finalized state with
the event append still missing is only a retryable finalization gap, not a valid
ordinary read. Canonical counters accept only bounded non-negative values from
validated progress contributions; the session summary is never reconstructed
from `progress.jsonl`.

Session observation is fail-open. If either canonical artifact is missing,
unreadable, malformed, truncated, duplicated, or mismatched, progress and the
workflow command remain authoritative and the canonical observation is
unavailable. `logs --json` is read-only inspection: it returns
`"session_event": null` when either `session-state.json` or
`session-events.jsonl` is missing or cannot validate, and it does not repair,
create, or rewrite either artifact. Legacy runs are read without creating these
files; reads, logs, and resume never backfill legacy session artifacts.

Terminal handling is ordered and retryable. A producing command records its
settled outcome before terminal disposition; terminal provenance is then
recorded, GitHub reconciliation runs when applicable, reflection runs after
terminalization, assurance is recomputed, and finalization writes the
summary/event pair. Finalization preserves the preallocated event identity and
is exactly once: concurrent or repeated attempts return the same event and
never append a duplicate. If finalization is interrupted, a later producing
command or `resume` retries the missing append without re-entering delivered
implementation or delivery work. The delivered-resume short-circuit returns
the persisted result with the canonical artifacts unchanged.

### Bounded context and resource governance

New runs use `bounded-context-v1`. The full ledger remains immutable, but model
inputs are compact packages: Hands receives only the work-item spec, scoped diff,
active prior finding, dependency summaries, and bounded evidence; Verifier
receives the acceptance contract, controller-observed changed files/diff,
normalized command/artifact/browser evidence, active findings, and the required
terminal evidence index for final phases. Default caps are 64 KiB for Hands and
Verifier packages, 32 KiB for scoped diffs, 16 KiB for Hands evidence, and 96 KiB
for reflection.

Every completed non-integrated work item records an immutable summary. Final
Verifier phases use distinct `final-integrated` and `post-pr` indexes, and
reflection uses its own terminal index instead of recursively scanning the run
directory. Legacy and durable-discovery runs resume under their original rules.

Resource budgets are authoritative in `budgets/`: model invocations, workflow
attempts, total tokens, active elapsed time, and external effects. Missing token
usage after a started turn makes accounting uncertain and blocks the next
chargeable action; a structured terminal error before `turn.started` is recorded
as proven zero-token usage. `brain-hands status --json` exposes policy, usage,
remaining limits, token-accounting state, and overshoot.

In GitHub mode, `delivered` means that one open, unmerged pull request is ready
for human review at the verified candidate; it is not an automatic merge or a
release action. The pull request and mapped issue lifecycle remain subject to
the documented GitHub delivery rules below.

### Terminal assurance outcomes

Workflow stage and PR existence are not proof of readiness. Brain Hands recomputes one
terminal assurance outcome from the approved plan bytes, candidate commit, completed
attempts, and final evidence whenever delivery is entered or resumed and whenever
`status` or `final-audit` is run:

- `verified_ready`: current evidence proves the exact candidate.
- `human_accepted`: a human accepted a specific final-delivery evidence gap.
- `blocked`: readiness cannot currently be established.
- `abandoned`: a human explicitly ended the run.

Active runs have no terminal outcome. Risk acceptance is exact and becomes ineffective
if the plan, commit, blocker, or missing-evidence snapshot changes:

#### Remote synchronization assurance

For a new GitHub run, final assurance also requires durable remote
synchronization evidence under
`assurance/remote-synchronization-*.json`. Its three authoritative commit
sources are:

- `local_candidate_sha`: the actual candidate worktree HEAD, resolved with
  `git rev-parse HEAD`.
- `mapped_pr_sha`: GitHub `getPullRequest` for the persisted PR number, with
  the returned PR identity checked against the persisted PR URL and configured
  branch.
- `remote_head_sha`: `git ls-remote --refs` for the configured remote and the
  configured branch.

All three full SHAs must equal the final integrated commit. If they do not:

1. Inspect `assurance/remote-synchronization-*.json`.
2. Compare `local_candidate_sha`, `mapped_pr_sha`, and `remote_head_sha`.
3. Correct the push or persisted PR mapping; do not edit the artifact.
4. Resume so Brain Hands records a new observation.

Remote synchronization blockers cannot be waived by risk acceptance.

#### Risk acceptance and legacy recovery

```sh
brain-hands accept-risk --run <run-dir> --gate final-delivery --actor <identity> --reason <reason>
brain-hands abandon --run <run-dir> --actor <identity> --reason <reason>
```

Corrupt provenance, an unknown candidate commit, a plan mismatch, and unfinished or
zero-attempt work cannot be waived. Abandonment is irreversible.

### Same-run recovery order

When a run is interrupted or blocked, keep recovery in the original run until
the engine proves that is unsafe. The operator order is:

1. inspect status/logs with `brain-hands status --run <run-dir>` and
   `brain-hands logs --run <run-dir> --follow`.
2. resume the existing run with `brain-hands resume --run <run-dir>`.
3. authorize one diagnostic retry when required with
   `brain-hands resume --run <run-dir> --actor <identity> --recovery-note-file <path>`.
4. attest an expected controller hash when required with
   `brain-hands recover-controller --run <run-dir> --actor <identity> --reason <reason> --expected-package-sha256 <sha256>`.
5. explicitly abandon only when same-run recovery is unsafe with
   `brain-hands abandon --run <run-dir> --actor <identity> --reason <reason>`.
6. replace only an abandoned run with
   `brain-hands replace --run <run-dir> --actor <identity> --reason <reason>`.
7. never use ordinary run for recovery; `brain-hands run` starts a new root task,
   not a recovery attempt.
8. never reuse approval or GitHub effects across replacement; the successor
   shares lineage but begins with fresh approvals, worktree, branch, issues,
   pull requests, delivery state, and final artifacts.

Diagnostic authorization does not approve implementation; it permits one exact
retry only. Controller attestation does not approve implementation; it permits
continuation under a named controller hash only.

Legacy saved plans derive a feature slug when their existing work-item IDs fit
the new contract; older nonconforming IDs retain their original unprefixed
display titles so recovery is not blocked.
Approved revisions may insert, reorder, or change dependencies between work
items because marker lookup is authoritative. Such revisions may renumber
visible child titles without changing issue numbers or work-item mappings. They
may not silently remove an already persisted issue; detachment stops with a
human-action blocker.

## Deterministic review policy

New v2 runs resolve and snapshot this canonical policy. Editing repository
configuration later does not change an active run.

```yaml
review_policy:
  max_fix_cycles: 2
  on_limit: auto_replan # auto_replan | stop | continue_with_warning
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

`review_revision` counts every Verifier evaluation. `fix_cycles_used` counts
only successful engine-authorized Hands fixes, including each successful item
in an ordered Reviewer action queue. Initial implementation, failed calls,
usage-limit failures, operational failures, and Hands self-review corrections
do not consume that budget. `self_review_mutations_used` records successful
self-review corrections separately, and `plan_revision` identifies the
approved plan lineage. The default therefore permits two successful fix
cycles: initial review, fix, review, fix, review, then the configured limit
action (normally a consolidated narrow replan). Existing active runs retain
their snapshotted limit, and an explicit repository override remains
authoritative.

Approved plans receive stable criterion references such as `BH-005:AC-2` and
the release guards `release:no-secrets`, `release:no-auto-merge`,
`release:no-critical-regression`, and `release:required-verification`.
Critical/high release blockers cannot be waived or auto-advanced. The engine,
not the Verifier prompt, decides whether to advance, fix, create a narrow
replan, wait for approval, continue with a preauthorized warning, or stop.

Full immutable records are kept outside the compact manifest:

```text
findings/<base64url-work-item-id>.jsonl
reviews/decisions/work-item-<base64url-work-item-id>-revision-<R>.json
reviews/effects/<base64url-effect-id>/{claim,completion}.json
reviews/fix-packets/<base64url-packet-id>/{packet.json,packet.sha256}
reviews/fix-packets/<base64url-packet-id>/attempts/<N>/{hands-invocation-claim,hands-result,attempt-supplement,focused-resolution}.json
reviews/convergence/work-item-<base64url-work-item-id>-plan-<P>-review-<R>.json
replans/work-item-<base64url-work-item-id>-base-<P>-review-<R>.json
authorizations/<base64url-work-item-id>/revision-<R>.json
```

A replan is a patch against one approved work item. Approval preserves its
issue, branch, worktree, commits, evidence, and history, increments the plan
lineage, resets only that item's fix budget, and resumes idempotently. Warning
continuation is legal only when the run override or approved plan grants
authority; the ledger records actor, source, findings, reason, residual risk,
evidence snapshot, timestamp, and policy revision.

### Review fix packets

New actionable Verifier findings are not handed to Hands as prose. Each new
ordered queue is marked `contract_version: review_fix_packet_v1`, and the
engine compiles its active finding into canonical JSON containing observed and
expected behavior, the causal failure mechanism, approved targets, atomic
change units, forbidden changes, verification commands, success conditions,
and an exact changed-file contract. Engine-owned finding, action, criterion,
work-item, and approved-plan identities are added before persistence.

Hands receives only the immutable active packet, approved work item,
packet-scoped source/evidence context, completed dependency summaries, and an
immutable retry supplement when applicable. The runtime checks the real Git
changed-file set before verification. A focused Verifier returns one
evidence-backed result for every success condition. `still_open` creates a new
attempt supplement without changing the packet; contradictions route to the
approval-gated narrow replan. Invalid remediation gets at most one correction
call and never falls back to prose.

Persisted queues without `contract_version` remain on the legacy
`re_verification` path and are never silently upgraded.

`brain-hands status <run>` and `brain-hands logs <run>` show the same operator
state in text or with `--json`: progressing automatically, awaiting plan
approval, awaiting irreversible-action authority, operationally blocked,
unresolved release blocker, authorized warning continuation, human accepted,
abandoned, closed blocked, or delivered.
Automatic progress prints no reply menu. GitHub mode upserts one marker-owned
status comment on the current work item's durable issue (the first issue is the
integrated/final run anchor), never on the pull request. Replays update the
canonical lowest-ID managed comment, remove managed duplicates, and leave
unrelated comments unchanged.
The runtime refreshes that comment at bounded implementation, verification,
fix, and policy-decision checkpoints, so long-running work exposes automatic
progress before its terminal delivery or blocker update.

## Self-review, escalation, and usage-limit fallback

The quality gate is configurable under `retry_policy.quality_gate`. The default
is one Hands self-review pass, two attempts per Reviewer action, and focused
Verifier confirmation. `hands_self_review_passes` may be set to `0`, `1`, `2`,
or `3`. Reviewer actions execute serially; a deterministic
failure blocks the queue instead of skipping forward.

One optional backup profile may be configured:

```yaml
retry_policy:
  max_hands_fix_attempts: 3
  max_replan_attempts: 2
  quality_gate:
    hands_self_review_passes: 1
    max_attempts_per_reviewer_action: 2
    require_focused_verifier_confirmation: true
  backup:
    fallback_on_primary_usage_limit: true
    max_quality_recovery_attempts: 1
    profile:
      model: gpt-5.6-luna
      reasoning_effort: medium
phase_reasoning:
  hands_self_review: medium
  reflection: medium
```

Fallback occurs only after a confirmed primary Hands usage limit. The engine
validates the backup profile against the captured model catalog, records the
route activation before retrying, and
resumes without charging the failed call as a fix cycle. This operational
failover is persistent for the remainder of the run; it is not the bounded
quality-escalation attempt. Product verification
failures stay in the bounded policy loop; auth, permissions, network, catalog,
quota-without-backup, and test-infrastructure failures are operational blockers.
There is no silent second fallback.

`max_quality_recovery_attempts: 1` preserves the one-shot backup escalation for
the work-item loop of active legacy v2 runs that have no review-policy snapshot:
after the configured primary fix attempts, one actionable recovery may run on
backup without changing the active route; a rejected recovery records
`escalation_exhausted`. New
policy-enabled runs do not receive a hidden extra fix. Their snapshotted
`review_policy.max_fix_cycles` and `review_policy.on_limit` decision are
authoritative, normally producing a narrow replan when blockers remain.

Existing v2 configurations without `review_policy` still load. Active legacy
manifests without a policy snapshot remain on the legacy decision path and are
not silently upgraded. Existing quality-gate and backup snapshots remain
authoritative on resume.

## Install And Build

```bash
npm install
npm run build
```

The project targets Node.js 20+.

## Daily Commands

### Follow safe live progress

Add `--follow` to any command that produces workflow work:

```bash
npm run dev -- run "<task>" --mode local --no-research --no-reflection --follow
npm run dev -- approve-plan <run-id> --revision <revision> --follow
npm run dev -- resume <run-id> --follow
```

Replay or attach from another terminal:

```bash
npm run dev -- logs --run .brain-hands/runs/<run-id>
npm run dev -- logs --follow --run .brain-hands/runs/<run-id>
```

`progress.jsonl` contains only normalized labels, ordinals, safe tool/model
families, usage, and durations. `events.jsonl` remains workflow provenance, and
detailed role artifacts remain under `responses/`, `implementation/`,
`verification/`, and `reviews/`. Live progress is not plan approval or delivery
approval; validated artifacts and explicit approval gates remain authoritative.

`--json` and `--follow` cannot be combined because successful JSON output stays
one final machine-readable value.

### Initialize a repository

Initialize a repository locally. This is safe to rerun and never accesses
GitHub:

```bash
brain-hands init --repo .
```

Preview the complete effective configuration before choosing run options:

```bash
brain-hands preview --repo .
brain-hands preview --repo . --mode local --no-research --json
```

Inspect and then provision the required GitHub workflow labels:

```bash
brain-hands init --repo . --github --dry-run
brain-hands init --repo . --github
```

GitHub initialization resolves `github.default_remote`, creates only missing
labels, and reports metadata drift without editing or deleting existing labels.
`--force` overwrites only the local config.

Check local dependencies:

```bash
npm run dev -- doctor --repo . --mode local
```

Skip GitHub checks when auth is unavailable:

```bash
node dist/cli.js doctor --repo . --mode local --strict --no-github
```

Start a dry-run local workflow (the command stops at the first user boundary):

```bash
npm run dev -- run "Build a sample feature" --repo . --mode local --no-research --no-reflection --dry-run
```

Continue the displayed discovery action. Answers and revision guidance use
standard input unless `--input-file` is provided:

```bash
npm run dev -- answer-discovery --run .brain-hands/runs/<run-id> --question <id> --input-file <path>
npm run dev -- select-discovery-approach --run .brain-hands/runs/<run-id> --revision <revision> --approach <id>
npm run dev -- proceed-discovery --run .brain-hands/runs/<run-id> --question <id> --input-file <path>
npm run dev -- revise-discovery --run .brain-hands/runs/<run-id> --revision <revision> --input-file <path>
npm run dev -- approve-discovery --run .brain-hands/runs/<run-id> --revision <revision>
```

Start a real local workflow with Codex web research:

```bash
npm run dev -- run "Build a sample feature" --repo . --mode local --research --no-reflection
```

Run in GitHub mode (issues plus one non-merging pull request):

```bash
npm run dev -- run "Build a sample feature" --repo . --mode github --research --reflection
```

### GitHub status comments

In GitHub mode, every work-item issue has one Brain Hands-owned mutable status
comment and one `brain-hands:*` state label. Brain Hands updates them only at
durable workflow boundaries. Verification blockers, replans, and requested
changes are immutable issue comments; the integrated pull request receives only
the final verified delivery comment.

The local ledger remains authoritative. Status synchronization is best-effort,
locked per run, and replayed from durable intents on resume. It never changes
plan approval, verification, delivery, or merge behavior. Public comments use
fixed safe summaries rather than logs, prompts, paths, secrets, or model text.

Issue-body reconciliation returns `created`, `updated`, or `noop`. Creation and
material updates append immutable ledger events. No-op observations and
crash-recovery operation state stay in the rebuildable
`github-issue-sync.json` checkpoint, so repeated reconciliation does not grow
the material event stream. Stable operation IDs recover a GitHub mutation that
succeeded immediately before a local interruption without duplicating its
issue or material event.

### GitHub issue lifecycle

The `brain-hands:complete` label means that an individual work item passed
Verifier review. It does not mean the integrated change was delivered, so the
issue remains open while its pull request is open or closed without merge.

Before Brain Hands reports `github_ready`, the pull request must target the
repository's actual default branch and GitHub must parse every mapped parent
and child issue from the Brain Hands-owned block in the pull request body:

```text
<!-- brain-hands:issue-links run=<run-id> schema=1 -->
Closes #<parent-number>
Closes #<child-number>
<!-- /brain-hands:issue-links -->
```

GitHub's native close-on-merge behavior closes those issues as completed when
the pull request merges into the default branch. Brain Hands never merges the
pull request. A `human_accepted` run with a pull request follows the same rule:
its issues wait for that default-branch merge, then close as completed. Explicit
`abandoned` and `closed_blocked` terminal actions close owned, mapped issues as
not planned; ordinary resumable blockers leave issues open.

Audit or repair lifecycle state with the reconciliation command. It is a
read-only dry run unless `--apply` is present:

```bash
npm run dev -- reconcile-github --run .brain-hands/runs/<run-id> --json
npm run dev -- reconcile-github --run .brain-hands/runs/<run-id> --apply --json
```

Apply mode can repair an open pull request's owned block, close still-open
mapped issues after a verified default-branch merge, or apply an explicit
not-planned outcome. It preserves pull request text outside the owned block,
skips foreign or unmarked issues, and records intent and completion in the
atomic `github-issue-lifecycle.json` checkpoint so interrupted operations are
retryable and idempotent. `status` remains observation-only.

After reviewing the Brain plan, approve the exact revision:

```bash
npm run dev -- approve-plan --run .brain-hands/runs/<run-id> --revision <revision>
```

Inspect or resume an approved run:

```bash
npm run dev -- status --run .brain-hands/runs/<run-id>
npm run dev -- resume --run .brain-hands/runs/<run-id>
```

Explicitly close a resumable incomplete run. This does not mark delivery ready
or bypass release guards. The command-line `blocked` choice records the explicit
terminal outcome `closed_blocked`; it is distinct from an ordinary resumable
runtime blocker. In GitHub mode, `abandoned` and this explicit `blocked` choice
reconcile owned issues as not planned:

```bash
npm run dev -- close-run --run .brain-hands/runs/<run-id> \
  --outcome human-accepted|abandoned|blocked \
  --reason "Why this run is ending"
```

### Live progress

Producing commands can render durable progress as it is appended:

```bash
npm run dev -- run "Build a sample feature" --repo . --mode local --no-research --no-reflection --follow
npm run dev -- approve-plan --run .brain-hands/runs/<run-id> --revision <revision> --follow
npm run dev -- resume --run .brain-hands/runs/<run-id> --follow
```

Attach from another terminal or replay the safe history:

```bash
npm run dev -- logs --follow --run .brain-hands/runs/<run-id>
npm run dev -- status --run .brain-hands/runs/<run-id>
```

`progress.jsonl` contains only schema-validated Brain Hands labels, numeric
coordinates, sanitized model/tool names, process/session identifiers, and
heartbeats. It never contains prompts, reasoning, commands, output, paths,
findings, URLs, or secrets. A five-minute gap is reported as `possibly stale`
but never starts another worker. Progress is observational and cannot approve a
plan, satisfy verification, authorize delivery, or change the manifest.
Plain `logs` and `logs --follow` coalesce heartbeat runs and duplicate progress
warnings for human readability; `logs --json` remains lossless and returns every
validated raw progress event.

Generate a standalone improvement plan from a reflection. This command stops
after writing the plan; implement it in a separate task/thread:

```bash
npm run dev -- reflection \
  --update-from-reflection .brain-hands/runs/<run-id>/reflection.json \
  --repo .
```

The exact command and option contract is in
[`.agents/skills/brain-hands/references/cli-contract.md`](.agents/skills/brain-hands/references/cli-contract.md).

For the local stable-release dispatch command, GitHub Trusted Publishing flow,
and recovery procedure, see
[`docs/RELEASING.md`](docs/RELEASING.md).

Inspect persisted state:

```bash
npm run dev -- status --run .brain-hands/runs/<run-id>
npm run dev -- resume --run .brain-hands/runs/<run-id>
```

## Local Review Packages

Use a local review package when there is no PR, no GitHub auth, or the brain reviewer should review from disk.

```bash
node dist/cli.js review-package \
  --run .brain-hands/runs/<run-id> \
  --issue 1 \
  --repo . \
  --out .brain-hands/runs/<run-id>/review-packages/issue-1
```

The package contains:

- `review.md`: main human-readable review entry point
- `prompt.md`: model-ready brain review prompt
- `issue.json`: selected issue spec
- `implementation.md`: hands implementation notes
- `verification/evidence.json`: command and artifact evidence
- `browser-evidence.json`: browser evidence when available
- `diff.patch`: current local git diff, including untracked files when Git can render them
- `screenshots.txt`: screenshot artifact paths and existence status

A reviewer should be able to open `review.md` and understand the request, issue goal, acceptance criteria, changed files, verification results, browser evidence, risks, and review checklist without using GitHub.

## Browser Verification

Issues can declare `browser_checks`. During `implement`, those checks run automatically before local verification and PR creation.

Manual browser evidence capture is also available:

```bash
npm run dev -- browser verify \
  --issue-file solar-system-browser/issues/3d-spacecraft-upgrade.json \
  --repo . \
  --report reports/solar-3d-browser-evidence.json
```

Add `--run .brain-hands/runs/<run-id> --issue <number>` to also copy normalized browser evidence into the run ledger.

## ExecutionSpecV2 Contract

Current runs use one strict, JSON-only execution contract. Every newly generated
spec includes:

- exact `file_contract` permissions and named code/test targets;
- one-file `change_units` with stable IDs, concrete requirements, and exactly one unit per declared target;
- acceptance IDs linked through `satisfied_by` to changes, tests, or commands;
- test IDs linked to verification-command IDs;
- verification commands stored as direct `argv` arrays with explicit `focused`
  or `cross_cutting` tiers;
- `cross_cutting_impacts` that connect affected change units to representative
  fixtures, required cross-cutting commands, and callers where applicable;
- a complete allowed changed-file set in `completion_contract`;
- explicit `forbidden_changes`, risk mitigations, and stop conditions.

### Artifact paths

`expected_artifacts` contains only safe, repository-relative filesystem paths,
or an empty array when no artifact is required. For example:

```yaml
expected_artifacts:
  - reports/verification.json
```

Descriptions, summaries, URLs, and other prose are not artifacts and are
rejected there. Put prose evidence requirements in `acceptance_criteria`.

The stronger the issue contract, the cheaper and safer the hands implementation becomes.

Markdown, prompts, skills, and other narrative files use the same ordinary
`file_contract`, `change_units`, and `completion_contract` authorization as
code. There is no separate narrative-file bypass or classifier. Caller and
representative-fixture paths used only as compatibility evidence must be
declared `read_only`; that makes them inspectable without authorizing edits or
adding them to `completion_contract.expected_changed_files`.

Before plan approval, the Spark-readiness gate rejects unsafe or colliding work-item
IDs, duplicate set entries, duplicate or unresolved evidence IDs, uncovered file targets,
case-insensitive path and browser-evidence collisions, reserved `.git` paths, contradictory
completion scope, disallowed verification or browser-server commands, tests without
commands, and vague phrases such as “as needed.” Approved plan bytes are SHA-256
verified again whenever execution or audit tooling reloads them. Hands must stop and report when an
`ambiguity_policy.stop_when` condition applies; it must not make an architecture
or scope decision.

The required testing-funnel traceability chain is:

```text
change unit
  -> acceptance criterion
  -> focused test/command
  -> optional required cross-cutting impact
  -> cross-cutting command
```

Every acceptance criterion must reach a verification command either directly
or through a declared test. Focused commands come first. A cross-cutting impact
is required when a change affects a registered critical surface or otherwise
declares shared compatibility risk; it owns the corresponding cross-cutting
commands and names representative fixtures. A `shared_helper` impact must also
name at least one caller; other impact categories name callers where applicable.
Runtime preserves the approved command order and stops after persisting evidence
for the first failed, unstartable, or timed-out command. A broad suite never
substitutes for missing focused or required cross-cutting evidence.

Compatibility is fail-closed for new model output without rewriting old
approved bytes. Persisted legacy plans may omit command tiers and impact arrays;
an omitted tier is interpreted as `focused` and omitted impacts as empty. New
plans require a tier on every command and require `cross_cutting_impacts`, even
when empty. Newly generated replan patches additionally require `tier` and a
nonempty acceptance `satisfies` list on each added command, plus explicit
`added_cross_cutting_impacts` and `added_read_only_file_contracts` arrays. The
generated boundary links added command IDs into the named acceptance criteria
and validates the complete candidate. Persisted legacy replan artifacts remain
loadable when those fields are absent.

The older `IssueSpec` YAML contract remains supported only by the legacy
orchestrator. V2 GitHub issues and v2 review packages preserve the canonical
`ExecutionSpecV2` JSON object exactly. Marker-matched GitHub issues are refreshed
from the current approved spec before execution resumes.

## Development

For development iteration, run the source CLI directly or build once and run
the compiled checkout:

```bash
npm run dev -- ...
npm run build && node dist/cli.js ...
```

For release-candidate proof, use the layered funnel and then inspect the exact
tested package without running lifecycle scripts:

```bash
npm run verify:funnel
npm pack --dry-run --json --ignore-scripts
```

The funnel runs static and cross-cutting checks before one build. Post-build
tests inherit `BRAIN_HANDS_DIST_IMMUTABLE=1`, and `dist/` is digest-checked
after built-CLI proof and again after the integrated suite. Test workers must
not invoke clean, build, or `npm test`; those commands would either mutate the
frozen candidate or recursively start the coordinator. A later standalone real
pack or publish still retains `prepack` as a separate defensive lifecycle
boundary.

In this sandbox, `npm run dev -- ...` can fail when `tsx` cannot create its IPC
pipe. If that happens, build once and use the compiled CLI:

```bash
npm run build
node dist/cli.js doctor --repo . --mode local
```

## Contributing, support, and security

Public issues and fork-based pull requests are welcome. `@ngelik` is the sole
maintainer and the only account authorized to push, tag releases, or merge.
Read [CONTRIBUTING.md](CONTRIBUTING.md) before proposing a change and
[SUPPORT.md](SUPPORT.md) for usage help.

Do not report vulnerabilities in public issues. Follow [SECURITY.md](SECURITY.md)
to submit a private security advisory.

## License

Licensed under the [Apache License 2.0](LICENSE).
