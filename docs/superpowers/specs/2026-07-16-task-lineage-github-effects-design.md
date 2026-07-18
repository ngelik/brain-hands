# Task-Lineage GitHub Effects Design

## Status

Approved direction: the user asked to deepen the existing task-lineage proposal into a file-level implementation and testing plan. This specification records the architectural decisions that the implementation plan must preserve.

## Problem

Brain Hands currently owns GitHub issues with `run_id` plus `work_item_id`, creates or updates those issues inside `runGithubWorkflow()`, and identifies the integrated pull request primarily by branch head. That is sufficient for a normal same-run resume, but it makes the execution attempt the durable remote identity. It also leaves four unsafe gaps:

1. a replacement execution identity cannot safely prove that it owns an existing task's GitHub objects;
2. a GitHub create whose response is lost may be retried without a durable task-level ambiguity state;
3. issue and pull-request mutations are not exposed as immutable previews before the mutation boundary;
4. abandonment and closed-issue label cleanup converge one issue at a time without one durable, complete target-set intent.

The goal is to make GitHub effects idempotent by a controller-generated task lineage while retaining `run_id` as immutable execution provenance.

## Current Repository Constraints

- `createRunLedgerV2()` creates `.brain-hands/runs/<run-id>` atomically with `mkdir()` and writes `manifest.json` afterward.
- `runGithubWorkflow()` already runs approved controller bootstrap before issue synchronization, but `assertPlanReady()` is called later inside the local runtime.
- `syncGithubIssues()` performs lookup and mutation in the same pass and uses run-scoped markers.
- `github-issue-sync.json` records per-target create/update intent, but it is run-scoped and cannot represent a task-level ambiguous create result.
- `pushCommitToBranch()` already supports a remote lease, while one legacy delivery path still calls the non-lease `pushBranch()` helper.
- `openOrRecoverIntegratedPullRequest()` recovers by branch head and validates head/base/body metadata.
- `github-issue-lifecycle.json` persists close intents per issue immediately before each close; it does not persist one complete abandonment batch first.
- `reconcileIssueStateLabel()` reconciles only labels and does not account for an issue that GitHub already reports as closed.
- `status` is observation-only. `reconcile-github` is dry-run unless `--apply` is supplied.
- Same-run `resume` is the normal recovery path and must remain the default.

## Approaches Considered

### A. Keep lineage only in each run manifest

Add `task_lineage_id` to `manifest.json` and replace run markers with lineage markers.

Advantages:

- smallest schema and storage change;
- no new repository-level lock or record.

Rejected because:

- there is no authoritative place to reject a second run claiming the same lineage;
- issue and PR mappings remain fragmented across run ledgers;
- terminal lineage state cannot be checked without scanning every run;
- create ambiguity remains tied to one execution attempt.

### B. Repository-local lineage authority plus run-owned immutable previews

Create `.brain-hands/task-lineages/<lineage-id>/state.json` as the authority for remote ownership, issue mappings, PR identity, and effect-operation state. Keep immutable previews below the producing run directory and store verified preview references in both the run manifest and lineage record.

Advantages:

- one local authority for duplicate rejection and terminal lineage state;
- reuses existing run-ledger artifact and status patterns;
- does not require a GitHub mutation merely to reserve a task;
- supports same-run recovery now and leaves an explicit path for future successor-run recovery.

Tradeoffs:

- the lineage record and run manifest are two durable files, so creation and reference updates need explicit crash recovery;
- exactly-once guarantees apply only to controllers sharing the same `.brain-hands` directory.

Selected because it is the smallest design that satisfies the local idempotency and lifecycle requirements without weakening approval boundaries.

### C. Reserve lineage remotely in GitHub

Create a reservation issue, discussion, tag, or repository variable before creating task issues.

Advantages:

- could coordinate independent clones and machines.

Rejected for this version because:

- the reservation is itself a GitHub mutation that would need preview, recovery, and permissions;
- marker search is not a compare-and-swap primitive;
- it materially expands repository administration and failure modes;
- the requested behavior can be delivered for the existing single-control-directory model without it.

## Selected Architecture

### Identity

- `run_id` identifies one execution ledger, its prompts, evidence, reviews, and terminal disposition.
- `task_lineage_id` identifies the GitHub issue set, branch delivery identity, pull request, and cleanup lifecycle.
- New runs receive a controller-generated UUID. No hash of task text, plan prose, issue title, or model output is used as identity.
- `planning_recovery.lineage_id` remains unrelated planning-attempt state and is not renamed or reused.
- Version one does not add a public successor-run command or cross-run approval reuse. The lineage record contains `run_ids` and `active_run_id` so a later, separately approved recovery design can extend it without changing GitHub markers.

### Concurrency Boundary

The exact guarantee is:

> At most one process that shares the same repository `.brain-hands` directory may apply GitHub effects for a lineage at a time.

The guarantee is enforced by a lineage lock directory and a lease record. A live same-host PID is never reclaimed based only on elapsed time. An unknown-host lease is never stolen automatically. Independent clones are outside the version-one guarantee.

### Durable Ownership Record

The lineage record is stored at:

```text
.brain-hands/task-lineages/<task-lineage-id>/state.json
```

It owns:

- lineage and repository identity;
- root and active run IDs;
- lineage lifecycle state;
- parent and work-item issue mappings;
- per-target issue create/update operations;
- branch and pull-request identity;
- the latest immutable effect-preview references;
- cleanup state.

The record does not copy plan prose, issue bodies, prompts, logs, or verification evidence.

### Run Manifest Additions

Every new manifest records:

```ts
task_lineage_id: string | null;
github_effects_protocol: "legacy-run-v1" | "task-lineage-v1";
github_effects: {
  issue_sync: GithubEffectPreviewRef | null;
  pull_request_delivery: GithubEffectPreviewRef | null;
};
github_cleanup: GithubCleanupBatch | null;
```

Legacy manifests default to `legacy-run-v1` and `task_lineage_id: null`. Read-only commands do not migrate them.

### Crash-Safe Run and Lineage Creation

There is no false claim of a transaction across the run directory and lineage directory.

Creation order is:

1. generate `run_id` and `task_lineage_id` in memory;
2. atomically create the run directory;
3. write the manifest containing the lineage ID;
4. create the matching lineage record with `root_run_id` and `active_run_id` equal to the run;
5. before any producing command, verify the bidirectional binding.

If the process stops after step 3, read-only status reports a lineage attachment blocker. The next producing command may create the missing lineage only when the manifest is a new `task-lineage-v1` manifest, the lineage path is absent, and the requested root run matches exactly. Any conflicting record fails closed.

### Legacy Migration

The first producing GitHub command for a legacy run:

1. obtains the canonical GitHub `host` and `nameWithOwner` through read-only adapter calls;
2. derives a deterministic UUID from a fixed namespace, canonical repository identity, and `run_id`;
3. creates or verifies the lineage record under the repository lineage lock;
4. writes the lineage ID and `task-lineage-v1` protocol into the manifest;
5. produces a preview that adds lineage markers to already-owned run-scoped issues and the PR.

Filesystem paths and original request text are excluded from derivation.

### GitHub Markers

New issue bodies start with exactly these markers:

```text
<!-- brain-hands-lineage:<uuid> -->
<!-- brain-hands-run:<run-id> -->
<!-- brain-hands-work-item:<work-item-id> -->
```

Parent issues replace the work-item marker with `brain-hands-parent:<feature-slug>`.

The managed pull-request closing block records both lineage and run provenance. Lineage is authoritative for `task-lineage-v1`; run remains provenance. Duplicate, malformed, or mixed lineage markers fail closed.

Adapter lookup methods return every match sorted by number. The adapter never silently chooses the first match.

### Read-Only Effect Planning

Effect planning consumes only:

- the verified approved plan and recorded SHA-256;
- the verified manifest and lineage record;
- canonical repository identity;
- read-only issue, label, branch, default-branch, and PR observations.

It emits immutable run artifacts:

```text
github-effects/issue-sync/revision-<n>.json
github-effects/pull-request-delivery/revision-<n>.json
```

Each preview contains identity, plan binding, repository binding, ordered effects, observation hash, desired hash, and its own digest. It stores hashes and stable identifiers, not full task prose or remote error text.

Planning throws on unsafe states. `reject` is not represented as an executable effect.

### Preview Visibility Boundaries

There are two non-approval boundaries:

1. after plan approval, worktree creation, controller bootstrap, execution viability, and GitHub observation, but before issue mutation;
2. after integrated local verification, Verifier approval, and the local delivery commit, but before branch push or PR mutation.

At either boundary:

- the CLI returns `awaiting_github_effects` successfully;
- `approval_boundary` remains `none`;
- status exposes the exact engine-rendered preview and allows only `resume` or `abandon`;
- `resume` re-observes remote state and applies only an unchanged preview;
- drift invalidates the preview, writes the next immutable revision, and stops again.

This is visibility and replay protection, not another plan approval.

### Post-Bootstrap Execution Viability

The viability gate runs after controller bootstrap and before the first GitHub observation used for a preview. It verifies:

- current approved plan revision and bytes;
- `assertPlanReady()` against the bootstrapped worktree;
- worktree path, branch, source commit ancestry, and clean status;
- one current Codex model catalog snapshot for Hands, Verifier, and configured Hands backup;
- required GitHub adapter read and write capabilities;
- authenticated repository identity, configured default branch, and every required label.

It reuses `readModelCatalog()`, `validateCatalogProfile()`, and `inspectGitHubSetup()` rather than rerunning all of `runPreflight()`.

Any failure records a safe local report and causes zero issue, label, branch, or PR mutations.

### Issue Effect Application

Before applying, the controller verifies the preview bytes and digest, approved plan binding, lineage binding, repository binding, and current observations.

For a create effect:

1. acquire the lineage transaction;
2. reject a terminal lineage or a different `active_run_id`;
3. persist an `intent` operation containing target key, desired hash, and creating run ID;
4. repeat exhaustive marker lookup;
5. recover one match, reject multiple matches, or call create only if this is the first execution of the intent;
6. persist the observed issue number to the lineage record;
7. mark the operation complete;
8. mirror the mapping into the run manifest.

If the create call returns an unknown result and no unique marker match can be recovered, the operation becomes `ambiguous`. Automatic create retry is forbidden. `reconcile-github --apply` may adopt a later unique marker match; zero or multiple matches remain blocked.

A normal resume may update or reuse mapped issues but may not add a work item. A newly approved replan revision may add an issue while preserving every prior mapping. Removing or remapping an owned issue fails closed.

### Delivery Effect Application

Both existing push/PR call sites in `runtime.ts` must route through one shared delivery-effect module. That module:

- records local head and observed remote head;
- uses `pushCommitToBranch()` with an exact lease, never the non-lease push helper;
- recovers PRs by lineage marker and validates exact branch, head SHA, base, state, URL, and closing issue references;
- rejects multiple lineage PRs;
- persists PR identity to lineage before mirroring it to the run manifest;
- then resumes the existing post-PR verification loop.

### Lineage Lifecycle

Allowed transitions are:

```text
active -> delivery_ready | abandoned | closed_blocked
delivery_ready -> human_accepted | completed | abandoned | closed_blocked
human_accepted -> completed
completed -> terminal
abandoned -> terminal
closed_blocked -> terminal
```

`delivered` run disposition maps to `delivery_ready`, not `completed`. Only reconciliation of a verified merge into the default branch sets `completed`.

### Abandonment and Terminal Cleanup

For GitHub abandonment or `closed_blocked`, the manifest atomically records one `github_cleanup` batch together with the terminal disposition. The batch contains:

- lineage ID;
- terminal reason;
- complete sorted parent and work-item target numbers;
- a hash of the target set;
- per-target completion state;
- overall `pending`, `complete`, or `blocked` state.

No GitHub close is attempted before that full target set is durable. GitHub mutations then converge one issue at a time. A partial failure leaves cleanup pending and `reconcile-github --apply` resumes only incomplete targets.

GitHub cannot atomically close multiple issues; the documented guarantee is atomic local intent plus idempotent convergence.

### Closed-Issue Labels

Managed labels are divided into:

- transient: `ready`, `implementing`, `verifying`, `reviewing`, `fixing`, `blocked`;
- terminal-compatible: `complete`, `not-planned`.

For a closed issue:

- `COMPLETED` requires exactly `brain-hands:complete`;
- `NOT_PLANNED` requires exactly `brain-hands:not-planned`;
- every other managed state label is removed.

Status synchronization observes issue state first. For a closed issue it reconciles only the terminal label and does not replay active status comments or material events.

All managed state labels are provisioned through GitHub setup. The adapter no longer silently creates a missing label during status synchronization.

## Error Handling

- Corrupt lineage state is quarantined and blocks mutation; it is never replaced with an empty record.
- Missing new-run lineage state is recoverable only under the exact manifest/root-run binding described above.
- Ambiguous marker lookup is a blocker, not a lowest-number selection.
- Preview path, bytes, digest, plan binding, or repository drift blocks mutation.
- A remote mutation with an unknown result becomes an explicit ambiguous operation.
- Manifest/lineage mirror drift is repaired only from the authoritative lineage record when identities match exactly.
- Terminal lineage states reject issue creation and PR opening.
- Status remains observation-only and never performs migration or cleanup.

## Testing Strategy

### Pure contract tests

- Zod schema defaults and cross-field invariants;
- lineage lifecycle transitions;
- deterministic legacy UUID derivation;
- canonical observation/effect hashing and ordering;
- marker parsing and ownership decisions;
- terminal label selection.

### Durable storage tests

- concurrent lineage creation;
- lock contention and stale same-host lease recovery;
- atomic state replacement and fsync behavior;
- corrupt-state quarantine;
- interrupted run-to-lineage attachment recovery;
- manifest/lineage mirror repair.

### Adapter tests

- GitHub.com and GHES repository identity;
- REST pagination and PR filtering;
- all-match marker lookup;
- exact issue/PR observation parsing;
- no lazy state-label creation;
- closed-state label reconciliation.

### Runtime tests

- bootstrap and every viability check precede GitHub observation and mutation;
- issue preview stops before mutation;
- unchanged resume applies once;
- drift produces a replacement preview without mutation;
- lost create response never triggers a second create;
- replan extension preserves existing mappings;
- both delivery paths stop before push and use the shared lease-based apply function;
- post-PR verification still follows PR creation;
- terminal batch exists before the first close;
- partial cleanup resumes only incomplete targets.

### CLI and packaged-surface tests

- JSON and human status render both effect boundaries;
- `approval_boundary` stays `none`;
- `resume` and `abandon` are the only permitted actions;
- `reconcile-github` stays dry-run by default;
- docs and skill display `rendered_preview` verbatim;
- full test, typecheck, build, release validation, package dry-run, isolated tarball install, `--version`, and relevant `--help` commands pass.

## Explicit Non-Goals

- automatic replacement-run creation;
- cross-run discovery or plan approval carry-forward;
- distributed locking across independent clones;
- remote task reservation;
- automatic PR merge;
- remote branch deletion during abandonment;
- automatic retry of an ambiguous create;
- reopening terminal issues;
- model judgment about task equivalence.
