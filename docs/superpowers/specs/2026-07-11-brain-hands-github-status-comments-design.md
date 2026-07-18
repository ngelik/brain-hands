# Brain Hands GitHub Status Comments Design

**Date:** 2026-07-11
**Status:** Approved

## Summary

Brain Hands GitHub runs will maintain one mutable status comment on each
work-item issue and create immutable comments only for material workflow events.
The integrated pull request will not mirror work-item status; it will receive one
immutable delivery comment after post-PR verification and final Verifier
approval.

The run ledger remains the workflow authority. GitHub comments and labels are a
best-effort, retryable projection for humans and never become an approval,
verification, or delivery gate.

## Goals

- Give reviewers one current, compact status comment per work-item issue.
- Preserve a concise immutable history of blockers, replans, requested changes,
  and delivery.
- Make GitHub synchronization idempotent across crashes and resume runs.
- Keep one additive, mutually exclusive Brain Hands state label synchronized
  with the projected status.
- Prevent raw logs, secrets, local paths, prompts, and arbitrary model output
  from reaching GitHub status comments.
- Perform no GitHub mutation on a no-op resume.

## Non-Goals

- Using GitHub comments or labels as workflow authority.
- Mirroring every command, model event, progress event, or local artifact.
- Maintaining a second mutable run-level status comment on the pull request.
- Automatically merging a pull request.
- Adding an explicit status-reconciliation CLI command in the first version.
- Replacing existing planning, Hands, or verification labels.
- Depending on the planned `progress.jsonl` feature.

## Decisions

1. Each work-item issue owns its canonical mutable status comment.
2. The integrated pull request receives only the immutable delivery event.
3. Synchronization failures are best-effort: they are recorded and retried but
   never block the workflow.
4. Existing labels remain intact. Brain Hands adds exactly one label from an
   allowlisted, exclusive `brain-hands:*` state family.
5. The implementation uses a durable projector and reconciler rather than
   scattered inline GitHub updates or a separate watcher process.

## Durability and Security Amendment

This amendment supersedes any conflicting detail below. It was added during
pre-implementation review to close crash-recovery, ownership, concurrency, and
public-data gaps without changing the approved user-facing behavior.

### Durable intent and replay

Every desired GitHub projection is represented by a versioned local intent in
`github-status-intents.jsonl`. An intent contains only safe coordinates and
validated local artifact identities: target kind and number, work-item ID,
state, attempt, exact transition timestamp, projection version, and event keys.
It is written after the corresponding workflow boundary is durable and before
the first remote status mutation.

The intent log is not workflow authority. It is a replay queue. On every GitHub
workflow start and before every terminal fast-resume return, Brain Hands derives
the complete desired set from the intent log and the authoritative ledger,
evidence, and review artifacts, then reconciles every target. It does not retry
only checkpoint entries that already have an error. If a process stops between a
workflow boundary and intent append, replay reconstructs the missing intent from
the boundary event or persisted work-item progress and appends it before any
remote mutation.

Every Verifier result stores its validated review path and attempt in
work-item progress before its decision is acted on. Every status-changing
completion or blocker persists an exact `github_status_transition_at` timestamp
in the same manifest write. State transitions that already use `transitionRun()`
use the emitted event timestamp. Replay never uses global `manifest.updated_at`
to render an earlier state.

### Exclusivity and checkpoint recovery

Each reconciliation acquires an atomic per-run status lock. A contending caller
records a retryable local result and makes no remote mutation. The lock owner
writes checkpoint changes with a uniquely named temporary file and atomic
rename. A stale same-host lock may be recovered only after its recorded process
is confirmed absent; an unknown live owner is never stolen.

The checkpoint is rebuildable. Parse, schema, or missing-file failures are
quarantined or treated as an empty checkpoint inside the best-effort status
boundary. They may create a generic local warning but can never block approval,
verification, or delivery.

### Public rendering and ownership

Public comments use fixed copy, safe identifiers, check labels from a fixed
allowlist, browser/artifact counts, and finding severity counts. They do not
render model-generated finding summaries, required-fix text, residual-risk text,
branch names, raw command arguments, or any arbitrary strings.

Markers are built only from safe generated coordinates. A managed comment is
valid only when its marker is the first line and its author equals the currently
authenticated GitHub actor. A foreign, malformed, or duplicate matching marker
is a retryable ownership conflict; Brain Hands never edits it or treats it as a
delivered event.

The GitHub adapter resolves and caches repository hostname, owner/name, and
authenticated actor. API calls use that hostname, including GitHub Enterprise.
The dry-run adapter keeps deterministic in-memory comments and labels so marker
lookup behaves like a real adapter.

### Target mapping and integrated events

Issue association is stored and validated as `work_item_id -> issue_number`, not
only by ordered array position. A replan that would remap a work item to a
different issue fails closed.

The integrated pull request receives only the verified `Delivered for review`
event. Integrated post-PR blockers, replans, and requested changes remain in
the local ledger and do not create PR comments.

## Authority and Architecture

The v2 run ledger remains the source of truth for approval, execution,
verification, review, and delivery. The GitHub projection is derived from:

- `manifest.json`;
- durable records in `events.jsonl`;
- persisted implementation attempts;
- persisted verification evidence;
- persisted Verifier reviews; and
- persisted GitHub issue and pull-request identities.

The status system has four boundaries:

### Pure projection

`src/github/status-projection.ts` maps persisted workflow inputs into a desired
status model. It owns state mapping, safe evidence summaries, material-event
classification, Markdown rendering, deterministic event keys, and projection
hashing. It has no filesystem or GitHub side effects.

### Reconciliation

`src/github/status-sync.ts` loads the persisted inputs and the rebuildable sync
checkpoint, compares the desired projection with the last successful
projection, performs missing GitHub mutations, and atomically persists the
result. It converts remote failures into generic retry state.

### GitHub transport

`src/adapters/github.ts` exposes narrow comment and label primitives. Status
comments are edited by database ID through the GitHub API. Brain Hands never
uses an "edit last comment" operation because another actor may have commented
more recently.

### Runtime integration

`src/workflow/runtime.ts` invokes one typed synchronization helper only after
durable workflow boundaries. It supplies coordinates and artifact references,
not Markdown. Runtime code never renders status content or issues GitHub
commands directly.

The data flow is:

```text
durable workflow transition
        |
        v
manifest + event + persisted evidence/review
        |
        v
pure desired projection
        |
        v
GitHub reconciliation
        |
        v
success checkpoint or generic retry state
        |
        v
workflow continues
```

The planned safe live-progress timeline is observational and intentionally
excluded from this authority path. Both features may observe the same durable
workflow boundaries, but GitHub status never derives approval or completion
from transient progress records.

## Comment Identity

Each mutable status comment contains a marker scoped to the run and work item:

```html
<!-- brain-hands:status run=<run-id> work-item=<work-item-id> schema=1 -->
```

Each immutable event contains a deterministic marker:

```html
<!-- brain-hands:event run=<run-id> work-item=<work-item-id> key=<event-key> -->
```

The integrated pull-request delivery event uses the same event marker with the
synthetic `integrated` work-item ID.

Markers prevent one run from editing another run's status on the same issue.
Before creating a comment, the reconciler searches for its marker. This closes
the crash window where GitHub accepted a comment but the local checkpoint was
not saved.

## State Model and Labels

The mutable status comment and state label change only after durable state
transitions:

| Durable boundary | Display state | Exclusive label |
| --- | --- | --- |
| Issue synchronized after plan approval | Ready | `brain-hands:ready` |
| Hands attempt begins | Implementing | `brain-hands:implementing` |
| Deterministic verification begins | Verifying | `brain-hands:verifying` |
| Evidence is persisted and Verifier begins | Verifier review | `brain-hands:reviewing` |
| Verifier requests changes and Hands begins again | Fixing | `brain-hands:fixing` |
| Verification failure, replan, retry exhaustion, or operational blocker | Blocked | `brain-hands:blocked` |
| Work-item Verifier approval is persisted | Complete | `brain-hands:complete` |

The exclusive family is an exact allowlist. Reconciliation removes stale labels
only from this list and adds the desired label. It never removes unrelated
labels, including unrelated labels that happen to begin with `brain-hands:`.

Missing Brain Hands state labels are created once with fixed descriptions and
colors. Existing labels are reused without overwriting their definitions.

Commands, model messages, token updates, and individual verification checks do
not cause comment edits or label changes.

## Mutable Status Rendering

The status body is deterministic and compact:

```md
<!-- brain-hands:status run=... work-item=model-catalog schema=1 -->

## Brain Hands status

**State:** Verifier review
**Work item:** `model-catalog` (2 of 3)
**Attempt:** 1 of 3
**Run:** `2026-07-11T...`
**Branch:** `codex/release-ci`
**Updated:** 2026-07-11 16:25 UTC

### Progress

- Plan approved
- Implementation recorded
- Verification passed
- Verifier review running

### Evidence

- `npm run typecheck`: passed
- `npm test`: passed
- Browser checks: not required

### Next

Await the persisted Verifier decision.
```

The `Updated` value is the durable transition timestamp, not rendering time.
Rendering the same projection on resume therefore produces the same body and
hash.

The Progress and Next sections come from fixed state catalogs. The Evidence
section uses only persisted results from the latest applicable attempt. Content
is capped by bullet count and total length; overflow becomes a count summary.

There is no separate Feature field. Brain Hands does not currently have a
first-class feature identifier, and inferring one would introduce drifting
metadata. Work-item ID, run ID, branch, and issue identity are sufficient.

## Public Data Safety

Status and event comments must never contain:

- raw stdout or stderr;
- prompt, reasoning, plan, implementation, or reflection text;
- arbitrary exception messages or stack traces;
- absolute paths or local run-directory paths;
- environment values, tokens, credentials, or secret-like strings;
- command arguments that are not recognized as public-safe;
- unknown structured fields from model or tool output; or
- unbounded finding or evidence text.

Public check labels are constructed conservatively. Recognized safe forms such
as `npm test` and `npm run typecheck` remain recognizable. Unsafe, path-heavy,
or unrecognized commands become `Verification check N`.

A repository-relative source or artifact path may appear only when it was
already declared in the public work-item contract and passes strict
normalization. Otherwise the renderer emits a count summary. Finding text is
drawn only from validated structured reviews, length-capped, and rendered
through a fixed template.

Unsafe operational blocker details remain in local ledger artifacts. GitHub
receives a generic classification and fixed next action.

## Material Events

The reconciler creates immutable comments only for these persisted event
classes:

### Verification blocked

Created when required command, artifact, or browser evidence fails. It contains
the attempt, safe failed-check summaries, and the fixed next action.

### Replan required

Created when the persisted Verifier decision is `replan_required`. It states
that the approved plan must change and that Brain Hands will not bypass plan
approval.

### Reviewer findings

Created once per persisted `request_changes` review attempt, not once per
finding. It may contain capped severity counts, validated concise problem
summaries, public-safe repository-relative locations, and fixed next steps.

### Operational blocker

Created for retry exhaustion or failure to produce valid persisted output. It
uses a safe blocker classification and never copies the thrown error.

### Delivered for review

Created on the integrated pull request only after post-PR verification passes
and the final Verifier approval is persisted. It contains the pull request,
approved commit, safe check summaries, residual-risk count or capped safe
summary, and the reminder that Brain Hands will not merge automatically.

Every material event key is derived from durable coordinates such as event
class, work-item ID, attempt, persisted review identity, or delivery commit.
Before posting, the reconciler searches for the exact marker. Immutable event
comments are never edited.

## Synchronization Checkpoint

GitHub projection metadata is stored in a versioned
`github-status.json` run artifact. Per work item it contains only:

- known status comment database ID;
- last successfully applied projection hash;
- last desired exclusive label;
- emitted material-event keys;
- last successful synchronization timestamp; and
- optional generic retry classification and timestamp.

The checkpoint is not workflow authority and is rebuildable from the ledger and
GitHub markers. It contains no rendered body, raw error, credential, URL, local
path, or model output.

Checkpoint writes use the ledger's atomic JSON-writing pattern so a process
cannot expose a partially written file.

## Synchronization Algorithm

At a real durable state boundary, the reconciler:

1. Loads the current manifest, relevant durable events, latest applicable
   evidence and review artifacts, and the checkpoint.
2. Builds and validates the desired projection through the pure projector.
3. Computes a hash from normalized status Markdown plus the desired state
   label.
4. Returns without a GitHub mutation if the stored successful hash, label, and
   material-event keys already match.
5. Resolves a missing or stale status-comment ID by exact marker.
6. Creates or edits the mutable status comment when required.
7. Reads current issue labels, creates only missing state labels, removes stale
   allowlisted state labels, and adds the desired label.
8. For each missing material event, searches its marker and creates the comment
   only when absent.
9. Atomically records successful IDs, hash, label, keys, and timestamp.

Remote operations should be coalesced. A normal transition performs at most the
lookups and mutations needed for the changed projection. It does not update once
per command.

## Failure and Resume Semantics

Synchronization is best-effort:

1. The workflow transition, evidence, or decision is persisted first.
2. GitHub synchronization is attempted.
3. Success metadata or a generic retry classification is persisted.
4. The workflow continues regardless of synchronization failure.

A status failure never changes the work item to Blocked and never changes a
Verifier or delivery decision. The original exception remains available to
local diagnostics but is not copied into the public checkpoint or GitHub.

Resume retries projections whose checkpoint records pending work. Marker lookup
prevents duplicate comments after interrupted writes.

A pure no-op resume trusts the successful local checkpoint and performs zero
GitHub mutations. Human edits to the owned mutable comment are restored at the
next real state transition. A deleted status comment is recreated at that next
transition when the stored ID is found stale. The first version does not add a
remote-drift polling or explicit reconciliation command.

## GitHub Adapter Contract

The GitHub adapter gains narrow typed operations equivalent to:

- find an issue or pull-request comment by exact marker;
- create a comment and return its stable database ID;
- edit a comment by database ID;
- read current issue label names;
- list or create a missing Brain Hands state label without overwriting an
  existing definition; and
- reconcile one desired label against the exact state-label allowlist.

The dry-run and recording adapters implement deterministic no-op or in-memory
versions. Existing broader comment APIs remain available for current review
behavior.

## Runtime Boundaries

GitHub synchronization is invoked after:

- an approved work item is associated with an issue;
- Hands starts a first or fix attempt;
- deterministic verification starts;
- evidence is persisted and Verifier review starts;
- a request-changes, replan, or blocker decision is persisted;
- work-item approval is persisted; and
- integrated PR delivery readiness is persisted.

Runtime passes only typed coordinates and artifact references. A single helper
contains best-effort error conversion so sync error handling is not duplicated
across branches.

Local mode does not create a GitHub checkpoint or invoke any status operation.

## Testing Strategy

### Projection tests

- Map every durable boundary to exactly one display state and exclusive label.
- Prove commands inside a state do not change the projection.
- Cover first attempts, fixes, replans, blockers, approval, and delivery.
- Prove deterministic hashes and transition timestamps across resumes.
- Verify content caps and safe fallback labels.
- Seed absolute paths, secret-like strings, raw errors, and oversized content
  and prove they do not render.

### Adapter tests

- Parse paginated comment and label responses.
- Find exact markers without matching another run or work item.
- Create comments with stable IDs and edit only that ID.
- Create only missing state labels and preserve existing definitions.
- Remove only stale labels from the exact allowlist.
- Report malformed or failed GitHub responses without partial success.

### Reconciler tests

- Initial sync creates one status comment and one desired state label.
- A transition edits the same comment and replaces only the exclusive label.
- A no-op resume performs zero GitHub mutations.
- Marker discovery prevents duplication after remote success and local
  checkpoint failure.
- A stale stored comment ID recovers on the next real transition.
- Material events post once per deterministic key across interrupted resumes.
- GitHub failures persist generic retry state and never block workflow results.
- Multiple work items cannot edit one another's comments.

### Runtime tests

- Happy path: Ready -> Implementing -> Verifying -> Verifier review -> Complete.
- Fix path: Verifier review -> Fixing -> Verifying -> Verifier review ->
  Complete.
- Verification failure and replan produce Blocked plus one material event.
- PR delivery emits exactly one immutable comment only after post-PR
  verification and final Verifier approval.
- A merely opened, pending, or failing pull request receives no delivery
  comment.
- Local mode, explicit plan approval, verification provenance, bounded retries,
  and no-auto-merge behavior remain unchanged.

### Required verification

Run focused projection, adapter, reconciler, and GitHub runtime tests, followed
by:

```text
npm test
npm run typecheck
npm run build
npm_config_cache=/private/tmp/brain-hands-npm-cache npm pack --dry-run
git diff --check
```

## Implementation Sequence

1. Define pure projection types, state mapping, safe renderers, event keys, and
   tests.
2. Add the versioned, atomic synchronization checkpoint and tests.
3. Extend the GitHub adapter with marker-addressed comments and exclusive-label
   reconciliation.
4. Implement the best-effort reconciler and crash/resume tests.
5. Wire approved durable runtime boundaries to the reconciler.
6. Add integrated GitHub-mode, no-op resume, failure, and delivery tests.
7. Document the operator contract and run the complete release-readiness suite.

## Acceptance Criteria

- Every GitHub work-item issue has at most one Brain Hands mutable status
  comment for a given run and work item.
- The comment changes only at durable state transitions.
- Every issue has exactly one allowlisted `brain-hands:*` state label after a
  successful sync.
- Material event comments are limited to the approved classes and are
  idempotent across resume.
- The integrated PR receives one delivery comment only after verified final
  approval.
- No-op resumes perform no GitHub mutation.
- Status synchronization failure never changes workflow approval, verification,
  or delivery truth.
- Public comments never contain prohibited data.
- Existing GitHub workflow, local workflow, approval, verification, and package
  tests remain green.
