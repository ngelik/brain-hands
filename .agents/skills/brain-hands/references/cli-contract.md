# brain-hands CLI contract

The skill wrapper requires a compatible installed `brain-hands` command. It
does not silently use the checkout controller. Checkout development may opt in
with wrapper-only `--development-controller`, which is stripped before command
dispatch. The commands below are the supported v2 control surface. Every path
is interpreted relative to the target repository unless an absolute path is
supplied.

Self-hosting is detected from the canonical package or repository identity.
Those runs persist controller executable, package version and runtime-tree
SHA-256, plus the candidate commit. Mutating continuations must reproduce the
same provenance. Stable self-hosting rejects controllers from any checkout or
candidate-linked worktree.

## Workflow commands

```text
brain-hands preview --repo <path>
  [--mode <local|github>]
  [--research | --no-research]
  [--reflection | --no-reflection]
  [--brain-model <model>] [--hands-model <model>] [--verifier-model <model>]
  [--json]

brain-hands run <task> --repo <path> --mode <local|github>
  --research | --no-research
  --reflection | --no-reflection
  [--brain-model <model>] [--hands-model <model>] [--verifier-model <model>]
  [--dry-run] [--json | --follow]

brain-hands answer-discovery --run <run-dir> --question <id>
  [--input-file <path>] [--dry-run] [--json | --follow]

brain-hands select-discovery-approach --run <run-dir> --revision <number>
  --approach <id> [--dry-run] [--json | --follow]

brain-hands proceed-discovery --run <run-dir> --question <id>
  [--input-file <path>] [--dry-run] [--json | --follow]

brain-hands approve-discovery --run <run-dir> --revision <number>
  [--dry-run] [--json | --follow]

brain-hands revise-discovery --run <run-dir> --revision <number>
  [--input-file <path>] [--dry-run] [--json | --follow]

brain-hands approve-plan <run-id> --revision <number>
brain-hands approve-plan --run <run-dir> --revision <number>
  [--repo <path>] [--dry-run] [--json | --follow]

brain-hands resume <run-id>
brain-hands resume --run <run-dir>
  [--repo <path>] [--dry-run] [--json | --follow]

brain-hands close-run --run <run-dir>
  --outcome <human-accepted|abandoned|blocked> --reason <text>
  [--repo <path>] [--dry-run]

brain-hands status <run-id>
brain-hands status --run <run-dir>
  [--repo <path>] [--json] [--include-progress]

brain-hands logs <run-id>
brain-hands logs --run <run-dir>
  [--repo <path>] [--follow] [--json]

brain-hands reflection --update-from-reflection <path> --repo <path>
  [--brain-model <model>] [--dry-run]
```

For `approve-plan`, `resume`, `status`, and `logs`, the positional `<run-id>`
and `--run <run-dir>` forms shown above are alternatives. Choose exactly one;
never combine both selectors in one command.

`preview` validates the initialized repository config without migrating it and
resolves any supplied subset of intake choices. Human output is the complete
safe projection. JSON adds canonical `missing_choices` in `mode`, `research`,
`reflection` order and the exact `rendered_preview` string the conversational
skill displays verbatim before asking those questions.

The command does not create a run or write a workflow artifact. It does not run
preflight, invoke a model, inspect GitHub, or mutate GitHub. Pending mode yields
conditional GitHub effects; local mode yields none; GitHub mode reports issues
and one pull request. Internal executable/package paths, hashes, commits, Codex
commands, prompts, configuration secrets, and credentials are never projected.

Preview is ephemeral. `run-configuration.json` exists only after all choices
are resolved and `run` creates a ledger. Fully specified preview fields must
match the later resolved run configuration, but preview does not establish
execution readiness.

For a new run, `run` enters `durable-discovery-v1` and stops successfully at the
first user boundary. Brain asks one question at a time. Each discovery command
records exactly one user action and advances only to the next boundary:

- `answer-discovery` accepts the current question ID.
- `select-discovery-approach` accepts the current approaches revision and one
  approach ID.
- `proceed-discovery` atomically records an engine-owned forced-proceed intent
  and answer. Brain cannot ask another question in that discovery cycle and the
  brief must preserve the remaining uncertainty as a proceed-sourced assumption
  whose statement preserves the operator guidance; the command does not approve
  the resulting brief.
- `revise-discovery` rejects the exact displayed brief revision and records
  guidance for the next revision.
- `approve-discovery` verifies and pins the exact brief revision and its
  recorded SHA-256 before entering planning.

The `--json` `pending_action` contains the engine-authored question, approaches,
or exact brief plus a fixed `permitted_next_actions` command allowlist. Readable
output identifies the boundary and every valid next command.
Direct CLI users respond to the pending action without the command combining or
rewriting it. The discovery state flow is:

```text
preflight -> brain_discovery
  -> awaiting_discovery_answer <-> brain_discovery
  -> awaiting_discovery_approach -> brain_discovery
  -> awaiting_discovery_brief_approval
  -> brain_planning -> awaiting_plan_approval
```

Canonical local artifacts are revisioned and immutable where historical:

```text
discovery/pending-action.json
discovery/questions/001.json
discovery/answers/001.json
discovery/proceed-with-assumptions.json
discovery/approaches/revision-001.json
discovery/approaches/revision-001-selection.json
discovery/briefs/revision-001.json
discovery/briefs/revision-001-approval.json
discovery/approved-brief.json
```

Later planning-gap cycles keep their questions and answers under
`discovery/cycles/<cycle>/`; immutable events preserve every boundary and
decision while the manifest stores only current pointers and counters.

Text for `answer-discovery`, `proceed-discovery`, and `revise-discovery` comes
from standard input unless `--input-file <path>` is supplied. Suspected secret
material is rejected before it enters the ordinary discovery record or a Brain
prompt. Mutations reject stale question IDs or revisions and use the run lock.

Initial discovery has a five-answer soft limit and a six-answer hard limit. A
sixth question requires a concrete essential-decision justification. A planning
gap permits its evidence-backed question plus at most one adaptive follow-up.
Invalid structured output receives at most two attempts without consuming the
question budget or advancing state.

Discovery remains local-only, including questions, answers, approaches, draft
briefs, approvals, and rejected alternatives. GitHub may expose only the fixed
fact that local discovery input is pending. `status` is read-only, and `resume`
is read-only at discovery boundaries: both return the already persisted pending
action without invoking Brain or creating a new artifact.

Discovery-brief approval and execution-plan approval are separate gates.
`approve-plan` requires the exact current plan revision. In GitHub mode it
prepares and persists the issue-effect preview, then stops without issue
mutation; `resume` applies the unchanged preview, and only then may Hands start
or the target repository change. Planning and resume verify the approved brief
SHA-256 and fail closed if the approved bytes are missing or changed. Legacy
runs without discovery metadata resume under `legacy-v2`; they do not receive
fabricated discovery artifacts or approvals.

At a plan boundary, `status --json` keeps the discovery `pending_action` and
the verified structured `plan_approval_request` as independent fields. The
latter is non-null only for an exact request that is pending approval. Its
subject binds the run, proposed and base revisions, plan and decision-contract
digests, discovery, source, immutable run configuration, controller, external
effects, and authority. This JSON object is a detection and verification
surface, not the engine-rendered approval display; operators must not reorder,
stringify, summarize, or relay it as that display.

After JSON reports a pending request, run human-readable `status` as a second
observational read. It fully verifies the request again and renders one
contiguous local approval block from `Approval required:` through
`Next command (approve-plan):`. Relay that block verbatim and in full. Initial
requests contain the complete authorization summary. Material replans use
delta-first ordering: base and proposed revisions, the deterministic delta,
unchanged high-impact categories, additional-approval expectation, and exact
next command. Detailed requests and deltas remain local.

An initial request authorizes its exact complete plan. A material replan first
persists and validates the exact proposed revision, then exposes one new
request. Invalid or byte-identical no-op replans block before prompting.
Internal Hands retries and Verifier fixes inside the approved contract require
no new plan approval. Repeating the exact `approve-plan` subject is idempotent,
and same-run `resume` continues the durable approval without asking for
approval again. Cross-run approval carry-forward is unsupported: another run
must establish its own approval subjects. GitHub merge remains a separate
manual action.

`close-run` explicitly makes a resumable incomplete run terminal without
marking it delivered or bypassing release guards. `logs` reads the safe
`progress.jsonl` timeline; its follow mode never starts or resumes a worker.
Progress is not approval, verification, or delivery evidence. `reflection`
writes only a separate improvement plan and never invokes Hands.

## Capability and recovery commands

```text
brain-hands init [--repo <path>] [--github] [--dry-run] [--force] [--json]
brain-hands doctor --repo <path> --mode <local|github>
  [--live-model-check] [--strict] [--no-github]
brain-hands final-audit --run <run-dir> [--repo <path>] [--dry-run]
```

`init` is idempotent. Without `--github` it performs local Git/config work only.
With `--github` it resolves the configured default remote and creates only
missing workflow labels. Existing labels are never edited. `--dry-run` performs
read-only discovery without writing the config or creating labels, while
`--force` applies only to the local config.

The existing `implement`, `review`, `fix`, `review-package`, `issue import`,
and `browser verify` commands remain read-only diagnostic/recovery helpers.
They cannot bypass plan approval.

## Task-lineage GitHub effect boundaries

The task lineage owns GitHub effects; the run ID records execution provenance. Exact task-lineage plus target markers are ownership authority, and issue identity uses a stable work-item-keyed mapping rather than list position. `approve-plan` stops at the issue preview before any issue mutation. Final integrated approval stops at the delivery preview before any branch push or pull-request mutation. Each preview is engine-authored and must be displayed verbatim.

Resume applies the persisted preview but does not approve it. At an effect boundary, the only permitted actions are `resume` and `abandon`; an ambiguous create never retries automatically. Cleanup may remain pending after a terminal run outcome because GitHub cannot close multiple issues atomically. `reconcile-github` is dry-run without `--apply`. Version one does not coordinate independent clones.
