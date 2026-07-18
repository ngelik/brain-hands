# Task-Lineage GitHub Effects Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Repository instructions prohibit subagents unless the user explicitly requests them, so inline execution is the default.

**Goal:** Make issue, branch-push, pull-request, and terminal issue effects idempotent under one durable task-lineage identity while retaining run IDs as immutable execution provenance.

**Architecture:** Add a repository-local lineage authority for remote ownership and operation state. Keep immutable effect previews in the producing run ledger, stop at two non-approval visibility boundaries, and apply only a still-current preview under the lineage lock. Persist a complete cleanup batch before abandonment closes anything, then converge close state and terminal labels idempotently.

**Tech Stack:** TypeScript 6, Node.js 20+, Zod 4, Commander 15, Git/GitHub CLI, Vitest 4.

**Design specification:** `docs/superpowers/specs/2026-07-16-task-lineage-github-effects-design.md`

## Global Constraints

- Work on `main`; do not create a feature branch unless the user asks.
- Preserve unrelated worktree changes and do not stage them.
- Follow test-first Red-Green-Refactor for every behavior change.
- Same-run `resume` remains the default recovery mechanism.
- Do not add automatic successor runs or cross-run approval carry-forward.
- Generate `task_lineage_id` in the controller; never derive new-task identity from request text, plan prose, issue titles, or model output.
- Keep `task_lineage_id` distinct from `planning_recovery.lineage_id`.
- Version-one concurrency covers processes sharing one repository `.brain-hands` directory. Do not claim independent-clone safety.
- Status remains observation-only. It must not migrate legacy runs, mutate GitHub, or repair lineage state.
- No issue, label, branch, or PR mutation occurs before controller bootstrap, post-bootstrap viability, and a persisted preview.
- Effect previews are engine projections, not model output and not a second plan approval.
- A normal resume may update or reuse the issue set but cannot add an issue. Only a newly approved replan revision may add a stable work-item ID.
- An unknown create result is never retried automatically.
- GitHub has no multi-issue transaction. Promise atomic local cleanup intent plus idempotent convergence only.
- Never auto-merge or delete a remote branch.
- Add no runtime dependency.
- Runtime package contents remain limited to `dist/`, `prompts/`, `agentic-codex-workflow.md`, `README.md`, and package metadata.

## Success Criteria

1. Every newly created v2 run has one UUID `task_lineage_id` and a matching lineage record.
2. Legacy GitHub runs migrate deterministically only before a producing GitHub command; status does not migrate them.
3. Lineage, run, repository, approved plan, observation, and desired-state hashes bind every preview.
4. Plan approval in GitHub mode stops after a visible issue-effect preview with zero GitHub mutations.
5. Final integrated approval stops after a visible delivery preview with zero branch or PR mutations.
6. `resume` applies an unchanged preview once; remote drift writes a new preview and stops.
7. A lost issue-create response never causes a second automatic create.
8. Marker ambiguity, repository mismatch, plan drift, lineage conflict, and terminal lineage state fail closed.
9. Existing issue mappings are stable by `work_item.id`; approved replans may extend but never detach them.
10. Every remote push uses an exact lease.
11. Abandonment records the complete lineage-owned issue target set in the manifest before the first close.
12. Partial cleanup resumes only incomplete targets.
13. Closed `COMPLETED` issues retain only `brain-hands:complete`; closed `NOT_PLANNED` issues retain only `brain-hands:not-planned` among managed state labels.
14. Full tests, typecheck, build, release validation, package dry-run, isolated package install, and real packaged CLI help/version checks pass.

## File-Level Decomposition

### Create

- `src/core/task-lineage.ts` — lineage schema, paths, lease lock, atomic storage, transitions, binding, and deterministic legacy ID derivation.
- `src/github/effect-plan.ts` — canonical observations, effect schemas, pure planning, hashing, immutable preview I/O, and safe rendering.
- `src/workflow/execution-viability.ts` — focused post-bootstrap checks and safe report persistence.
- `src/workflow/github-delivery-effects.ts` — the only pre-PR push/open/recover gateway.
- `tests/core/task-lineage.test.ts`
- `tests/github/effect-plan.test.ts`
- `tests/workflow/execution-viability.test.ts`
- `tests/workflow/github-delivery-effects.test.ts`

### Modify

- `src/core/types.ts:687` — new stages and public lineage/effect/cleanup types.
- `src/core/types.ts:1274` — manifest additions.
- `src/core/schema.ts:480` — new stages.
- `src/core/schema.ts:1299` — strict manifest defaults and cross-field checks.
- `src/core/run-state.ts:8` — protocol-aware effect-boundary transitions.
- `src/core/ledger.ts:154` — deterministic test injection for lineage ID.
- `src/core/ledger.ts:1440` — new-run lineage creation and interrupted attachment recovery.
- `src/core/ledger.ts:1631` — terminal cleanup batch recording.
- `src/core/github-labels.ts:1` — one shared managed-label catalog.
- `src/adapters/github-setup.ts:12` — inspect/provision every managed label.
- `src/adapters/github.ts:20` — lineage-aware markers and observations.
- `src/adapters/github.ts:97` — all-match lookup and repository identity capabilities.
- `src/adapters/github.ts:188` — issue and parent body markers.
- `src/adapters/github.ts:632` — exhaustive paginated issue lookup.
- `src/adapters/github.ts:801` — lineage PR lookup.
- `src/workflow/github-issue-reconciliation.ts:1` — lineage-owned effect application and ambiguous create recovery.
- `src/workflow/runtime.ts:916` — replace direct issue sync with preview/apply gateway.
- `src/workflow/runtime.ts:1180` — move PR recovery rules behind delivery effects.
- `src/workflow/runtime.ts:5277` and `src/workflow/runtime.ts:5838` — route both push paths through one delivery gateway.
- `src/workflow/runtime.ts:6238` — bootstrap, viability, preview, and resume ordering.
- `src/workflow/status.ts:42` — lineage, effect-boundary, and cleanup projection.
- `src/cli.ts:826` — effect-boundary-aware execution.
- `src/cli.ts:1346` — approve-plan stops after issue preview.
- `src/cli.ts:1408` — resume applies the current phase.
- `src/github/issue-lifecycle.ts:1` — lineage-aware PR block and terminal-label policy.
- `src/github/issue-reconciliation.ts:20` — full cleanup batch convergence.
- `src/github/status-projection.ts:3` — import shared label catalog.
- `src/github/status-sync.ts:139` — observe closed state before active projection.
- `tests/fixtures/legacy-run.ts:44` — explicit legacy protocol defaults.
- Existing focused and end-to-end tests listed in the tasks below.
- `README.md`, `agentic-codex-workflow.md`, `.agents/skills/brain-hands/SKILL.md`, and `.agents/skills/brain-hands/references/cli-contract.md`.

## Dependency Order

```text
manifest contract
  -> lineage authority
  -> GitHub observations and markers
  -> pure effect preview
  -> legacy migration
  -> execution viability
  -> issue preview boundary
  -> issue application
  -> delivery preview/application
  -> terminal cleanup batch
  -> closed-label reconciliation
  -> docs and packaged verification
```

---

### Task 1: Define the Manifest and Stage Contract

**Files:**

- Modify: `src/core/types.ts:687`
- Modify: `src/core/types.ts:1274`
- Modify: `src/core/schema.ts:480`
- Modify: `src/core/schema.ts:1299`
- Modify: `src/core/run-state.ts:8`
- Modify: `tests/core/schema.test.ts:348`
- Modify: `tests/core/ledger.test.ts:569`

**Produces:**

```ts
export type GithubEffectsProtocol = "legacy-run-v1" | "task-lineage-v1";
export type GithubEffectPhase = "issue_sync" | "pull_request_delivery";

export interface GithubEffectPreviewRef {
  phase: GithubEffectPhase;
  revision: number;
  path: string;
  sha256: string;
  plan_revision: number;
  plan_sha256: string;
  state: "previewed" | "applying" | "applied" | "invalidated";
}

export interface GithubCleanupBatch {
  version: 1;
  lineage_id: string;
  reason: "completed" | "not_planned";
  target_numbers: number[];
  target_sha256: string;
  target_states: Record<string, "pending" | "complete" | "blocked">;
  state: "pending" | "complete" | "blocked";
  started_at: string;
  completed_at: string | null;
}
```

- [ ] **Step 1: Add failing manifest parsing tests**

Add one test that parses a new lineage manifest and one that parses an old fixture:

```ts
const parsed = runManifestV2Schema.parse({
  ...manifestFixture(),
  task_lineage_id: "946c7414-d500-4e65-a596-dcf99f0015c2",
  github_effects_protocol: "task-lineage-v1",
  github_effects: { issue_sync: null, pull_request_delivery: null },
  github_cleanup: null,
});
expect(parsed.task_lineage_id).toBe("946c7414-d500-4e65-a596-dcf99f0015c2");

expect(runManifestV2Schema.parse(manifestFixture())).toMatchObject({
  task_lineage_id: null,
  github_effects_protocol: "legacy-run-v1",
  github_effects: { issue_sync: null, pull_request_delivery: null },
  github_cleanup: null,
});
```

Add rejection cases for:

- `task-lineage-v1` with null or non-UUID lineage;
- `legacy-run-v1` with a non-null lineage;
- preview paths outside `github-effects/`;
- preview SHA values not matching `/^[a-f0-9]{64}$/`;
- duplicate or unsorted cleanup target numbers;
- cleanup keys not matching the target number set.

- [ ] **Step 2: Run RED**

Run:

```bash
npm exec vitest -- run tests/core/schema.test.ts tests/core/ledger.test.ts
```

Expected: FAIL because the fields and stages do not exist.

- [ ] **Step 3: Add types and schemas**

Add stages:

```ts
| "awaiting_github_issue_effects"
| "awaiting_github_delivery_effects"
```

Add the four manifest fields with schema defaults. Use `safeEvidenceRefSchema` plus a refinement requiring `github-effects/<phase>/revision-<positive>.json`.

- [ ] **Step 4: Add exact transition rules**

Use these task-lineage transitions:

```ts
awaiting_plan_approval: ["worktree_setup", "replanning"],
worktree_setup: ["awaiting_github_issue_effects", "implementing"],
awaiting_github_issue_effects: ["github_issue_sync"],
github_issue_sync: ["implementing"],
final_verification: ["verifying", "verifier_review", "awaiting_github_delivery_effects"],
awaiting_github_delivery_effects: ["final_verification"],
```

Keep the existing path for `legacy-run-v1` through a new `GithubEffectsProtocol` argument to `assertTransition()` rather than weakening the common table.

- [ ] **Step 5: Run GREEN**

Run the focused command from Step 2. Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/types.ts src/core/schema.ts src/core/run-state.ts tests/core/schema.test.ts tests/core/ledger.test.ts
git commit -m "feat: define task-lineage effect state"
```

---

### Task 2: Add the Repository-Local Lineage Authority

**Files:**

- Create: `src/core/task-lineage.ts`
- Create: `tests/core/task-lineage.test.ts`
- Modify: `src/core/ledger.ts:154`
- Modify: `src/core/ledger.ts:1440`
- Modify: `tests/core/ledger.test.ts:297`

**Produces:**

```ts
export const taskLineageRecordV1Schema: z.ZodType<TaskLineageRecordV1>;
export function taskLineagePath(repoRoot: string, lineageId: string): string;
export function createTaskLineage(input: CreateTaskLineageInput): Promise<TaskLineageRecordV1>;
export function readTaskLineage(repoRoot: string, lineageId: string): Promise<TaskLineageRecordV1>;
export function withTaskLineageTransaction<T>(input: LineageTransactionInput<T>): Promise<T>;
export function attachMissingNewRunLineage(input: AttachMissingLineageInput): Promise<TaskLineageRecordV1>;
export function deriveLegacyTaskLineageId(repositoryKey: string, runId: string): string;
export function transitionTaskLineage(input: TransitionTaskLineageInput): Promise<TaskLineageRecordV1>;
```

- [ ] **Step 1: Write the failing storage tests**

Cover these independent behaviors:

```ts
expect(await createTaskLineage({ repoRoot, runId: "run-a", lineageId, now })).toMatchObject({
  version: 1,
  lineage_id: lineageId,
  root_run_id: "run-a",
  active_run_id: "run-a",
  run_ids: ["run-a"],
  state: "active",
  repository_key: null,
  issue_set: { state: "uninitialized", work_item_issue_map: {} },
  delivery: { state: "uninitialized", pull_request_number: null },
});
```

Also assert:

- concurrent creates have one winner and one `already exists` failure;
- same-host dead-PID lease is recoverable;
- live PID and unknown-host leases are not stolen;
- atomic replacement preserves the previous valid state when rename is interrupted;
- corrupt state is renamed to `state.json.corrupt-<timestamp>-<uuid>` and mutation fails;
- terminal states reject issue/delivery operation changes;
- `active -> delivery_ready -> completed` passes;
- `active -> completed` fails;
- legacy derivation returns the same UUID for the same canonical repository/run and differs for a different repository.

- [ ] **Step 2: Run RED**

```bash
npm exec vitest -- run tests/core/task-lineage.test.ts
```

Expected: FAIL with module-not-found.

- [ ] **Step 3: Define the persisted record**

Use this exact top-level shape:

```ts
interface TaskLineageRecordV1 {
  version: 1;
  lineage_id: string;
  repository_key: string | null;
  root_run_id: string;
  active_run_id: string;
  run_ids: string[];
  state: "active" | "delivery_ready" | "human_accepted" | "completed" | "abandoned" | "closed_blocked";
  created_at: string;
  updated_at: string;
  issue_set: {
    state: "uninitialized" | "applying" | "ready" | "ambiguous";
    plan_revision: number | null;
    plan_sha256: string | null;
    parent_issue_number: number | null;
    work_item_issue_map: Record<string, number>;
    operations: Record<string, {
      operation_id: string;
      target_key: string;
      desired_sha256: string;
      state: "intent" | "observed" | "complete" | "ambiguous";
      issue_number: number | null;
      created_by_run_id: string;
    }>;
    preview: GithubEffectPreviewRef | null;
  };
  delivery: {
    state: "uninitialized" | "applying" | "ready" | "ambiguous";
    branch_name: string | null;
    head_sha: string | null;
    pull_request_number: number | null;
    pull_request_url: string | null;
    preview: GithubEffectPreviewRef | null;
  };
  cleanup_state: "not_required" | "pending" | "complete" | "blocked";
}
```

- [ ] **Step 4: Implement the lease and atomic write rules**

Use `.lock/lease.json`, `mkdir(lockPath)` for acquisition, a unique `state.<uuid>.tmp`, file sync, rename, and parent-directory sync. Do not use age alone to steal a live or unknown-host lease.

- [ ] **Step 5: Bind new ledger creation**

Add `taskLineageId?: string` to `CreateRunLedgerV2Input` for tests only. Production uses `randomUUID()`.

Creation sequence must be visible in the code. Add the four lineage fields directly to the existing manifest literal:

```ts
const taskLineageId = input.taskLineageId ?? randomUUID();
const manifest = runManifestV2Schema.parse({
  task_lineage_id: taskLineageId,
  github_effects_protocol: "task-lineage-v1",
  github_effects: { issue_sync: null, pull_request_delivery: null },
  github_cleanup: null,
});
await createRunDirectoryAndFiles(manifest);
await createTaskLineage({ repoRoot: values.repoRoot, runId, lineageId: taskLineageId });
```

Do not claim those two paths are one filesystem transaction. Add `attachMissingNewRunLineage()` for the exact interrupted state described in the design spec.

- [ ] **Step 6: Run GREEN**

```bash
npm exec vitest -- run tests/core/task-lineage.test.ts tests/core/ledger.test.ts tests/core/schema.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/core/task-lineage.ts src/core/ledger.ts tests/core/task-lineage.test.ts tests/core/ledger.test.ts
git commit -m "feat: persist task lineage authority"
```

---

### Task 3: Make GitHub Observation and Ownership Lineage-Aware

**Files:**

- Modify: `src/adapters/github.ts:20-120`
- Modify: `src/adapters/github.ts:188-270`
- Modify: `src/adapters/github.ts:517-835`
- Modify: `src/github/issue-lifecycle.ts:17`
- Modify: `tests/adapters/github.test.ts:82`
- Modify: `tests/adapters/github.test.ts:502`
- Modify: `tests/github/issue-lifecycle.test.ts:96`

**Produces:**

```ts
export interface GitHubRepositoryIdentity {
  host: string;
  name_with_owner: string;
  actor: string;
}

export interface GitHubIssueMarker {
  lineageId: string;
  runId: string;
  workItemId: string;
}

export interface GitHubIssueObservation extends GitHubIssueStateReference {
  labels: string[];
}

interface GitHubAdapter {
  getRepositoryIdentity?(): Promise<GitHubRepositoryIdentity>;
  findIssuesByMarker?(marker: GitHubIssueMarker): Promise<GitHubIssueObservation[]>;
  findParentIssuesByMarker?(marker: GitHubParentIssueMarker): Promise<GitHubIssueObservation[]>;
  findPullRequestsByLineage?(lineageId: string): Promise<GitHubPullRequestReference[]>;
}
```

- [ ] **Step 1: Write failing marker tests**

Assert issue bodies begin with lineage, run, and target markers exactly once. Assert parent bodies use `parent` rather than `work-item`. Assert a PR block records lineage and run.

Add lookup tests where two remote issues match and verify the adapter returns both sorted instead of selecting the first.

- [ ] **Step 2: Write failing pagination and GHES tests**

Mock `gh api --hostname <host> --paginate --slurp repos/<owner>/<repo>/issues?state=all&per_page=100`. Supply two pages, include a PR-shaped issue entry, and assert only real issues are returned.

For PRs, mock the pulls endpoint and assert `OPEN`, `CLOSED`, and `MERGED` normalization from `state` plus `merged_at`.

- [ ] **Step 3: Run RED**

```bash
npm exec vitest -- run tests/adapters/github.test.ts tests/github/issue-lifecycle.test.ts
```

Expected: FAIL on missing lineage marker and all-match methods.

- [ ] **Step 4: Expose canonical repository identity**

Promote the existing private `repository()` result behind `getRepositoryIdentity()`. Keep its cached GitHub.com/GHES host, `nameWithOwner`, and actor behavior.

- [ ] **Step 5: Implement exhaustive observation**

Parse and validate number, title, body, state, state reason, and sorted label names. Do not hash `updated_at`; comments can change it without changing owned issue material.

Keep `findIssueByMarker()` and `findParentIssueByMarker()` only as `legacy-run-v1` compatibility wrappers that throw if the new all-match method returns more than one result.

- [ ] **Step 6: Run GREEN**

Run the command from Step 3. Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/adapters/github.ts src/github/issue-lifecycle.ts tests/adapters/github.test.ts tests/github/issue-lifecycle.test.ts
git commit -m "feat: observe github ownership by lineage"
```

---

### Task 4: Build Canonical Immutable Effect Previews

**Files:**

- Create: `src/github/effect-plan.ts`
- Create: `tests/github/effect-plan.test.ts`

**Consumes:** verified plan, manifest, lineage, repository identity, remote observations.

**Produces:**

```ts
export type GithubEffect =
  | { effect_id: string; target: { kind: "parent" }; action: "create" | "reuse" | "update"; existing_number: number | null; observed_sha256: string | null; desired_sha256: string; reason_code: string }
  | { effect_id: string; target: { kind: "work_item"; work_item_id: string }; action: "create" | "reuse" | "update"; existing_number: number | null; observed_sha256: string | null; desired_sha256: string; reason_code: string }
  | { effect_id: string; target: { kind: "branch"; branch_name: string }; action: "push" | "noop"; observed_sha256: string | null; desired_sha256: string; reason_code: string }
  | { effect_id: string; target: { kind: "pull_request" }; action: "open" | "reuse" | "repair" | "noop"; existing_number: number | null; observed_sha256: string | null; desired_sha256: string; reason_code: string };

export interface GithubEffectPreviewV1 {
  version: 1;
  phase: GithubEffectPhase;
  revision: number;
  lineage_id: string;
  run_id: string;
  repository: { host: string; name_with_owner: string };
  plan_revision: number;
  plan_sha256: string;
  observation_sha256: string;
  desired_sha256: string;
  effects: GithubEffect[];
  created_at: string;
  preview_sha256: string;
}
```

- [ ] **Step 1: Write failing pure issue-plan tests**

Test these table rows separately:

| Lineage | Remote matches | Plan change | Result |
| --- | --- | --- | --- |
| active/uninitialized | 0 | initial | create |
| active/ready | 1 exact | none | reuse |
| active/ready | 1 drifted managed material | none | update |
| active/ready | 0 | none | throw missing-owned-issue |
| active/any | 2 | any | throw ambiguous-marker |
| active/ready | existing IDs plus new ID | normal resume | throw unapproved-extension |
| active/ready | existing IDs plus new ID | newer approved replan | create only new ID |
| completed/abandoned/closed_blocked | any create | any | throw terminal-lineage |

- [ ] **Step 2: Write failing delivery-plan tests**

Test branch absent/push, branch at head/noop, branch at another SHA/push-with-lease, unique exact PR/reuse, unique body drift/repair, wrong head/base/reject by throw, and multiple PRs/throw.

- [ ] **Step 3: Write hashing and rendering tests**

Assert:

- shuffled observation input yields the same hash;
- work items sort by stable ID;
- title, full body, labels, state, reason, branch SHA, base, head, or closing references change the hash;
- `updated_at`, absolute paths, task prose, tokens, and arbitrary error strings are absent from `renderGithubEffectPreview()`;
- existing immutable revision bytes are accepted only when byte-identical.

- [ ] **Step 4: Run RED**

```bash
npm exec vitest -- run tests/github/effect-plan.test.ts
```

Expected: FAIL with module-not-found.

- [ ] **Step 5: Implement canonical JSON and digests**

Sort every map and array before `JSON.stringify()`. Compute `preview_sha256` over the strict object without `preview_sha256`. Compute `effect_id` from phase, lineage, target, observed hash, desired hash, and action.

Do not emit a `reject` effect. Throw a typed planning error before persisting an executable preview.

- [ ] **Step 6: Implement immutable preview I/O**

Use:

```text
github-effects/issue-sync/revision-<n>.json
github-effects/pull-request-delivery/revision-<n>.json
```

Write with `writeImmutableTextArtifact()`. `readVerifiedGithubEffectPreview()` must verify canonical path, recorded digest, internal digest, phase, lineage, run, and plan binding.

- [ ] **Step 7: Run GREEN and commit**

```bash
npm exec vitest -- run tests/github/effect-plan.test.ts
git add src/github/effect-plan.ts tests/github/effect-plan.test.ts
git commit -m "feat: preview canonical github effects"
```

---

### Task 5: Migrate Legacy GitHub Runs Before Their Next Mutation

**Files:**

- Modify: `src/core/task-lineage.ts`
- Modify: `src/workflow/runtime.ts:6238`
- Modify: `src/workflow/status.ts:633`
- Modify: `tests/core/task-lineage.test.ts`
- Modify: `tests/workflow/runtime-github.test.ts`
- Modify: `tests/workflow/status.test.ts`
- Modify: `tests/fixtures/legacy-run.ts`

**Produces:**

```ts
export async function ensureProducingTaskLineage(input: {
  runDir: string;
  repository: GitHubRepositoryIdentity;
}): Promise<{ manifest: RunManifestV2; lineage: TaskLineageRecordV1 }>;
```

- [ ] **Step 1: Write failing migration tests**

Prove:

- `readOperatorStatus()` leaves legacy bytes unchanged;
- the first producer derives the same lineage after the repository is moved to another filesystem path;
- different `host/nameWithOwner` values derive different lineages;
- an existing conflicting lineage record fails before GitHub mutation;
- existing run-marker issues become lineage-marker `update` effects in the first preview;
- duplicate legacy run/work-item matches fail closed.

- [ ] **Step 2: Run RED**

```bash
npm exec vitest -- run tests/core/task-lineage.test.ts tests/workflow/runtime-github.test.ts tests/workflow/status.test.ts
```

Expected: FAIL because legacy runs have no producing migration.

- [ ] **Step 3: Implement deterministic UUID derivation**

Hash the fixed namespace plus lowercase canonical repository key and exact `run_id`, use the first 16 bytes, set RFC 4122 version-5 and variant bits, and format as a UUID. Do not hash `repo_root` or `original_request`.

- [ ] **Step 4: Implement recoverable two-file attachment**

Create/verify the lineage under the repository lineage lock, then update the manifest. On retry:

- matching lineage and manifest converge;
- missing lineage with matching manifest may be created;
- mismatched root/active run or repository blocks.

- [ ] **Step 5: Run GREEN and commit**

```bash
npm exec vitest -- run tests/core/task-lineage.test.ts tests/workflow/runtime-github.test.ts tests/workflow/status.test.ts
git add src/core/task-lineage.ts src/workflow/runtime.ts src/workflow/status.ts tests/core/task-lineage.test.ts tests/workflow/runtime-github.test.ts tests/workflow/status.test.ts tests/fixtures/legacy-run.ts
git commit -m "feat: migrate legacy github runs to lineage"
```

---

### Task 6: Add the Focused Post-Bootstrap Viability Gate

**Files:**

- Create: `src/workflow/execution-viability.ts`
- Create: `tests/workflow/execution-viability.test.ts`
- Modify: `src/workflow/runtime.ts:6238`
- Modify: `tests/workflow/runtime-github.test.ts:433`

**Produces:**

```ts
export interface ExecutionViabilityReportV1 {
  version: 1;
  run_id: string;
  task_lineage_id: string | null;
  plan_revision: number;
  plan_sha256: string;
  repository_key: string;
  checks: Array<{ name: string; status: "passed" | "failed" }>;
  checked_at: string;
}

export async function assertGithubExecutionViable(input: GithubExecutionViabilityInput): Promise<{
  report: ExecutionViabilityReportV1;
  repository: GitHubRepositoryIdentity;
}>;
```

- [ ] **Step 1: Write failing ordering tests**

Use recording dependencies and assert the exact prefix:

```ts
expect(calls).toEqual([
  "controller-bootstrap",
  "plan-readiness",
  "worktree-identity",
  "model-catalog",
  "github-capabilities",
  "github-setup",
  "github-observation",
]);
expect(mutations).toEqual([]);
```

Create one test per failing viability check and assert that `createIssue`, `updateIssue`, `reconcileIssueStateLabel`, push, and PR open/update were not called.

- [ ] **Step 2: Run RED**

```bash
npm exec vitest -- run tests/workflow/execution-viability.test.ts tests/workflow/runtime-github.test.ts
```

Expected: FAIL because `assertPlanReady()` still occurs after issue synchronization.

- [ ] **Step 3: Implement focused checks**

Reuse:

- `assertPlanReady()` from `src/core/execution-spec.ts`;
- `getGitSnapshot()`, `resolveLocalHeadSha()`, and manifest source/branch/worktree identity;
- one `readModelCatalog()` call plus `validateCatalogProfile()` for Hands, Verifier, and Hands backup;
- adapter capability presence checks;
- `inspectGitHubSetup()` for repository/default labels.

Do not call all of `runPreflight()` and do not invoke a model.

- [ ] **Step 4: Persist only safe report fields**

Write `execution-viability.json` with check names and pass/fail. Do not persist command output, environment values, absolute worktree paths, or GitHub error bodies.

- [ ] **Step 5: Move orchestration before observation**

In `runGithubWorkflow()` the order must be:

```ts
await prepareApprovedControllerBootstrap(input);
const viability = await assertGithubExecutionViable({
  runDir: input.runDir,
  worktreePath: input.worktreePath,
  plan: input.plan,
  config: input.config,
  github: input.dependencies.github,
});
const binding = await ensureProducingTaskLineage({
  runDir: input.runDir,
  repository: viability.repository,
});
```

Only after these statements may `runGithubWorkflow()` call the adapter's all-match issue methods and `planIssueEffects()`. The lineage migration may use repository identity obtained by viability, but no effect observation or mutation occurs before viability passes.

- [ ] **Step 6: Run GREEN and commit**

```bash
npm exec vitest -- run tests/workflow/execution-viability.test.ts tests/workflow/controller-bootstrap.test.ts tests/workflow/runtime-github.test.ts
git add src/workflow/execution-viability.ts src/workflow/runtime.ts tests/workflow/execution-viability.test.ts tests/workflow/runtime-github.test.ts
git commit -m "fix: gate github effects on execution viability"
```

---

### Task 7: Expose the Issue Preview as a Non-Approval Boundary

**Files:**

- Modify: `src/workflow/status.ts:42-253`
- Modify: `src/workflow/status.ts:685`
- Modify: `src/workflow/runtime.ts:916`
- Modify: `src/cli.ts:826`
- Modify: `src/cli.ts:1346`
- Modify: `src/cli.ts:1408`
- Modify: `tests/workflow/status.test.ts:204`
- Modify: `tests/cli-smoke.test.ts:1373`
- Modify: `tests/workflow/e2e-dry-run.test.ts:442`

**Produces:**

```ts
export interface GithubEffectBoundary {
  phase: GithubEffectPhase;
  rendered_preview: string;
  preview_path: string;
  preview_sha256: string;
  permitted_next_actions: ["resume", "abandon"];
}
```

- [ ] **Step 1: Write failing status tests**

Assert:

```ts
expect(await readOperatorStatus(runDir)).toMatchObject({
  operator_state: "awaiting_github_effect_application",
  approval_boundary: "none",
  effect_boundary: {
    phase: "issue_sync",
    permitted_next_actions: ["resume", "abandon"],
  },
});
```

Read status twice, compare the run tree byte-for-byte, and prove status did not migrate or write anything.

- [ ] **Step 2: Write failing CLI boundary tests**

Run the GitHub dry-run through plan approval. Assert:

- command exit is zero;
- workflow result is `awaiting_github_effects`;
- stage is `awaiting_github_issue_effects`;
- issue, label, push, and PR mutation arrays are empty;
- the human output includes the full `rendered_preview`;
- `--json` includes the same preview string.

- [ ] **Step 3: Run RED**

```bash
npm exec vitest -- run tests/workflow/status.test.ts tests/cli-smoke.test.ts tests/workflow/e2e-dry-run.test.ts
```

Expected: FAIL because approve-plan executes issue synchronization immediately.

- [ ] **Step 4: Add the sibling status boundary**

Do not extend `DiscoveryPendingAction`. Add `effect_boundary` independently and add `awaiting_github_effect_application` to `OperatorState`.

`renderRunStatus()` must render lineage ID, phase, immutable path/digest, preview text, and next commands without calling GitHub.

- [ ] **Step 5: Stop approve-plan after preview**

After approval, worktree, bootstrap, viability, observation, and immutable preview persistence:

```ts
await transitionRun(runDir, "awaiting_github_issue_effects", {
  actor: "runtime",
  payload: {
    preview_revision: preview.revision,
    preview_sha256: preview.preview_sha256,
  },
});
return {
  status: "awaiting_github_effects",
  manifest: await readManifestV2(runDir),
  orderedWorkItems,
  implementationResults: {},
  verification: {},
  reviews: {},
};
```

Update `beforeFinalize` so `awaiting_github_effects` never records a delivered terminal disposition.

- [ ] **Step 6: Run GREEN and commit**

```bash
npm exec vitest -- run tests/workflow/status.test.ts tests/cli-smoke.test.ts tests/workflow/e2e-dry-run.test.ts
git add src/workflow/status.ts src/workflow/runtime.ts src/cli.ts tests/workflow/status.test.ts tests/cli-smoke.test.ts tests/workflow/e2e-dry-run.test.ts
git commit -m "feat: stop before github issue effects"
```

---

### Task 8: Apply Issue Effects Exactly Once per Lineage

**Files:**

- Modify: `src/workflow/github-issue-reconciliation.ts`
- Modify: `src/workflow/runtime.ts:916-1115`
- Modify: `tests/workflow/runtime-github.test.ts:1705`
- Modify: `tests/github/effect-plan.test.ts`

**Produces:**

```ts
export async function applyIssueEffectPreview(input: ApplyIssueEffectPreviewInput): Promise<
  | { outcome: "applied"; parent_issue_number: number | null; work_item_issue_map: Record<string, number> }
  | { outcome: "replacement_preview"; preview: GithubEffectPreviewV1 }
  | { outcome: "ambiguous"; target_key: string }
>;
```

- [ ] **Step 1: Write failing idempotency tests**

Cover:

- first create persists lineage operation intent before adapter create;
- returned number is persisted to lineage before manifest;
- crash after remote create but before number persistence recovers one marker match;
- pending intent plus zero matches performs no create and becomes ambiguous;
- two matches perform no mutation and become ambiguous;
- replay after complete returns the same mappings with zero mutation;
- terminal lineage rejects;
- another `active_run_id` rejects;
- normal resume cannot add a new ID;
- newly approved replan adds exactly one ID and retains all prior mappings.

- [ ] **Step 2: Write failing drift tests**

Change one observed title/body/label/state between preview and apply. Assert the old preview becomes `invalidated`, revision N+1 is written, stage remains awaiting issue effects, and no mutation occurs.

- [ ] **Step 3: Run RED**

```bash
npm exec vitest -- run tests/workflow/runtime-github.test.ts tests/github/effect-plan.test.ts
```

Expected: FAIL because current reconciliation may call create again after an unresolved pending state.

- [ ] **Step 4: Replace run-scoped mutation ownership**

For `create`, enforce this exact sequence inside `withTaskLineageTransaction()`:

```ts
persistIntent();
const matches = await findAllMatches();
if (matches.length > 1) return persistAmbiguous();
if (matches.length === 1) return persistObservedThenComplete(matches[0].number);
if (intentAlreadyExisted) return persistAmbiguous();
const number = await createOnce();
return persistObservedThenComplete(number);
```

Keep the lineage lock across lookup, one mutation, and result persistence. Do not wait on a model while holding it.

- [ ] **Step 5: Mirror lineage to manifest**

After lineage persistence, update `issue_numbers`, both work-item maps, and parent number. If the manifest write fails, resume repairs it from lineage only after exact lineage/run/repository validation.

Retain `reconcileManagedIssueBody()` so user text outside markers is preserved.

- [ ] **Step 6: Support ambiguous recovery without retry**

`reconcile-github --apply` may adopt one later unique lineage/target match into an ambiguous operation. Zero or multiple matches remain blocked. It never creates the issue.

- [ ] **Step 7: Run GREEN and commit**

```bash
npm exec vitest -- run tests/workflow/runtime-github.test.ts tests/adapters/github.test.ts tests/github/effect-plan.test.ts tests/github/issue-reconciliation.test.ts
git add src/workflow/github-issue-reconciliation.ts src/workflow/runtime.ts tests/workflow/runtime-github.test.ts tests/github/effect-plan.test.ts tests/github/issue-reconciliation.test.ts
git commit -m "feat: apply lineage issue effects once"
```

---

### Task 9: Centralize Delivery Preview and Lease-Based Application

**Files:**

- Create: `src/workflow/github-delivery-effects.ts`
- Create: `tests/workflow/github-delivery-effects.test.ts`
- Modify: `src/workflow/runtime.ts:1180-1292`
- Modify: `src/workflow/runtime.ts:5277-5304`
- Modify: `src/workflow/runtime.ts:5484`
- Modify: `src/workflow/runtime.ts:5838-5905`
- Modify: `src/workflow/status.ts`
- Modify: `tests/workflow/runtime-github.test.ts:1385`

**Produces:**

```ts
export async function prepareDeliveryEffectBoundary(input: PrepareDeliveryEffectInput): Promise<GithubEffectPreviewV1>;
export async function applyDeliveryEffectPreview(input: ApplyDeliveryEffectInput): Promise<
  | { outcome: "applied"; pull_request: GitHubPullRequestReference }
  | { outcome: "replacement_preview"; preview: GithubEffectPreviewV1 }
>;
```

- [ ] **Step 1: Write failing shared-gateway tests**

Test that both the policy-enabled path and legacy-compatible path call the same gateway. Before resume, assert no push, PR open, or PR edit.

Test exact stage/result:

```ts
expect(result.status).toBe("awaiting_github_effects");
expect(result.manifest.stage).toBe("awaiting_github_delivery_effects");
```

- [ ] **Step 2: Write failing lease and identity tests**

Cover remote absent, remote at expected SHA, remote drift before apply, push error followed by observed success, unique exact PR, unique wrong head/base/lineage PR, multiple lineage PRs, and body-only repair.

Assert `pushBranch()` is never called by pre-PR delivery; only `pushCommitToBranch(localHead, branch, observedRemoteSha)` is allowed.

- [ ] **Step 3: Run RED**

```bash
npm exec vitest -- run tests/workflow/github-delivery-effects.test.ts tests/workflow/runtime-github.test.ts
```

Expected: FAIL because both runtime branches push/open inline.

- [ ] **Step 4: Prepare the immutable boundary**

Immediately before the first pre-PR remote push, persist:

- local HEAD;
- branch name and remote;
- observed remote SHA;
- default base;
- sorted closing issue numbers;
- parent issue number;
- all lineage PR observations;
- desired PR body hash.

Transition to `awaiting_github_delivery_effects` and stop. Post-PR verification does not run until resume creates or recovers the PR.

- [ ] **Step 5: Apply with exact revalidation**

On resume:

1. verify preview bytes and bindings;
2. verify local HEAD still equals preview head;
3. verify issue mappings and closing references;
4. re-read remote branch and PR observations;
5. write a replacement preview on drift;
6. push with exact lease when required;
7. recover exactly one lineage PR or open one;
8. verify lineage, URL, head, head SHA, base, state, body, and closing references;
9. persist delivery state to lineage, then manifest;
10. resume the existing post-PR loop.

- [ ] **Step 6: Preserve fast resume after PR creation**

The existing delivery/complete recovery path must validate the lineage PR, not merely the branch head. A persisted PR number and URL must match the lineage record and current observation.

- [ ] **Step 7: Run GREEN and commit**

```bash
npm exec vitest -- run tests/workflow/github-delivery-effects.test.ts tests/workflow/runtime-github.test.ts tests/adapters/github.test.ts tests/github/effect-plan.test.ts
git add src/workflow/github-delivery-effects.ts src/workflow/runtime.ts src/workflow/status.ts tests/workflow/github-delivery-effects.test.ts tests/workflow/runtime-github.test.ts
git commit -m "feat: preview and lease github delivery"
```

---

### Task 10: Record a Complete Terminal Cleanup Batch Before Closing

**Files:**

- Modify: `src/core/ledger.ts:1631`
- Modify: `src/github/issue-reconciliation.ts:20-525`
- Modify: `src/github/issue-lifecycle.ts:22`
- Modify: `src/cli.ts:1475`
- Modify: `src/workflow/status.ts:42`
- Modify: `tests/core/ledger.test.ts:119`
- Modify: `tests/github/issue-reconciliation.test.ts:160`
- Modify: `tests/cli-smoke.test.ts:785`
- Modify: `tests/workflow/status.test.ts`

**Produces:**

```ts
export async function recordTerminalDispositionWithCleanup(input: {
  runDir: string;
  disposition: RecordTerminalDispositionInput;
  lineage: TaskLineageRecordV1;
}): Promise<RunManifestV2>;
```

- [ ] **Step 1: Write failing atomic-intent tests**

Intercept the first `closeIssue()` call and read the manifest inside it. Assert the manifest already contains parent and every work-item number, sorted, with every target `pending`.

Simulate failure on target two and assert target one is `complete`, target two remains `pending` or `blocked`, target three remains `pending`, and overall state is not complete.

- [ ] **Step 2: Write failing resume and shrink-protection tests**

Resume reconciliation and assert only incomplete targets mutate. Alter later manifest mappings and prove the original cleanup batch cannot shrink.

Add lineage transition tests:

- delivered run -> lineage `delivery_ready`;
- human accepted -> `human_accepted`;
- verified default-branch merge -> `completed`;
- abandonment -> `abandoned`;
- blocked closure -> `closed_blocked`.

- [ ] **Step 3: Run RED**

```bash
npm exec vitest -- run tests/core/ledger.test.ts tests/github/issue-reconciliation.test.ts tests/cli-smoke.test.ts tests/workflow/status.test.ts
```

Expected: FAIL because current close intent is persisted one issue at a time.

- [ ] **Step 4: Record terminal and cleanup in one manifest replacement**

For GitHub `abandoned` or `closed_blocked`, derive the full set from the authoritative lineage issue set, build `GithubCleanupBatch`, and write it with terminal disposition in the same `transaction.updateManifestV2()` call.

Local runs keep `github_cleanup: null`.

- [ ] **Step 5: Converge per target**

For each target:

- re-read issue;
- verify exact lineage and target markers;
- close only if still open;
- observe the requested state reason;
- reconcile terminal label;
- mark target complete only after both state and label are observed.

Marker mismatch blocks that target and keeps overall cleanup incomplete.

- [ ] **Step 6: Project cleanup honestly**

Human and JSON status must distinguish terminal run outcome from `GitHub cleanup: pending|blocked|complete` and show `reconcile-github --apply` for pending cleanup.

- [ ] **Step 7: Run GREEN and commit**

```bash
npm exec vitest -- run tests/core/ledger.test.ts tests/github/issue-reconciliation.test.ts tests/cli-smoke.test.ts tests/workflow/status.test.ts
git add src/core/ledger.ts src/github/issue-reconciliation.ts src/github/issue-lifecycle.ts src/cli.ts src/workflow/status.ts tests/core/ledger.test.ts tests/github/issue-reconciliation.test.ts tests/cli-smoke.test.ts tests/workflow/status.test.ts
git commit -m "fix: persist whole-lineage cleanup intent"
```

---

### Task 11: Make Closed-Issue Labels Terminal-Aware

**Files:**

- Modify: `src/core/github-labels.ts`
- Modify: `src/github/status-projection.ts:3-13`
- Modify: `src/adapters/github-setup.ts:12-96`
- Modify: `src/adapters/github.ts:125-134`
- Modify: `src/adapters/github.ts:882-919`
- Modify: `src/github/status-sync.ts:117-190`
- Modify: `src/github/issue-reconciliation.ts`
- Modify: `tests/core/github-labels.test.ts`
- Modify: `tests/github/status-projection.test.ts:38`
- Modify: `tests/adapters/github-setup.test.ts:27`
- Modify: `tests/adapters/github.test.ts:176`
- Modify: `tests/github/status-sync.test.ts:65`
- Modify: `tests/github/issue-reconciliation.test.ts`

**Produces:**

```ts
export const TRANSIENT_BRAIN_HANDS_STATE_LABELS = [
  "brain-hands:ready",
  "brain-hands:implementing",
  "brain-hands:verifying",
  "brain-hands:reviewing",
  "brain-hands:fixing",
  "brain-hands:blocked",
] as const;

export const TERMINAL_BRAIN_HANDS_STATE_LABELS = [
  "brain-hands:complete",
  "brain-hands:not-planned",
] as const;
```

- [ ] **Step 1: Write failing label-catalog tests**

Assert all setup and state labels are unique case-insensitively and that GitHub setup reports `brain-hands:not-planned` as missing/provisionable.

- [ ] **Step 2: Write failing closed-state tests**

Table-test:

| Remote state | Remote reason | Existing managed labels | Desired result |
| --- | --- | --- | --- |
| CLOSED | COMPLETED | ready, blocked | complete only |
| CLOSED | NOT_PLANNED | reviewing, complete | not-planned only |
| OPEN | null | blocked | requested active label |

Add a status-sync test proving a closed issue receives no new active status comment or material event.

- [ ] **Step 3: Run RED**

```bash
npm exec vitest -- run tests/core/github-labels.test.ts tests/github/status-projection.test.ts tests/adapters/github-setup.test.ts tests/adapters/github.test.ts tests/github/status-sync.test.ts tests/github/issue-reconciliation.test.ts
```

Expected: FAIL because `not-planned` is absent and status sync does not observe closed state.

- [ ] **Step 4: Consolidate label definitions**

Move state-label definitions into `src/core/github-labels.ts`. Import them from projection, setup, and adapter modules. Remove the adapter's lazy label creation; a missing label is a viability/setup blocker.

- [ ] **Step 5: Observe before active projection**

Require `getIssue` for issue status sync. If closed, derive the terminal label from `state_reason`, reconcile that label, record a terminal checkpoint, and skip comment/event projection.

If open, preserve the current projection behavior.

- [ ] **Step 6: Complete cleanup only after label observation**

After close or label edit, re-read issue and labels. Mark the cleanup target complete only when state reason and exact managed terminal-label set both match.

- [ ] **Step 7: Run GREEN and commit**

```bash
npm exec vitest -- run tests/core/github-labels.test.ts tests/github/status-projection.test.ts tests/adapters/github-setup.test.ts tests/adapters/github.test.ts tests/github/status-sync.test.ts tests/github/issue-reconciliation.test.ts
git add src/core/github-labels.ts src/github/status-projection.ts src/adapters/github-setup.ts src/adapters/github.ts src/github/status-sync.ts src/github/issue-reconciliation.ts tests/core/github-labels.test.ts tests/github/status-projection.test.ts tests/adapters/github-setup.test.ts tests/adapters/github.test.ts tests/github/status-sync.test.ts tests/github/issue-reconciliation.test.ts
git commit -m "fix: reconcile closed issue labels"
```

---

### Task 12: Update Operator Contracts and Prove the Packaged Surface

**Files:**

- Modify: `README.md`
- Modify: `agentic-codex-workflow.md`
- Modify: `.agents/skills/brain-hands/SKILL.md`
- Modify: `.agents/skills/brain-hands/references/cli-contract.md`
- Modify: `tests/skill-layout.test.ts:151`
- Modify: `tests/cli-smoke.test.ts`
- Modify: `tests/workflow/e2e-dry-run.test.ts:442`
- Modify: `tests/scripts/release-validation.test.ts`

- [ ] **Step 1: Write failing documentation-contract tests**

Assert every operator surface says:

- lineage owns GitHub effects and run ID is provenance;
- approve-plan stops at the issue preview;
- final integrated approval stops at the delivery preview;
- the displayed preview is engine-authored and must be shown verbatim;
- `resume` applies but does not approve;
- only `resume` and `abandon` are permitted at an effect boundary;
- ambiguous create never retries automatically;
- cleanup can remain pending after a terminal run outcome;
- `reconcile-github` remains dry-run without `--apply`;
- v1 does not coordinate independent clones.

- [ ] **Step 2: Run RED**

```bash
npm exec vitest -- run tests/skill-layout.test.ts tests/cli-smoke.test.ts tests/workflow/e2e-dry-run.test.ts tests/scripts/release-validation.test.ts
```

Expected: FAIL because the new contract is undocumented.

- [ ] **Step 3: Update the conversational skill**

At either effect boundary, the skill must:

1. call `status --json` through the wrapper;
2. display `effect_boundary.rendered_preview` verbatim;
3. state that the plan is already approved;
4. ask whether to run `resume` or `abandon`;
5. never reconstruct, summarize, or silently apply the preview.

- [ ] **Step 4: Add a fresh-process end-to-end scenario**

The GitHub dry-run must cross these separate processes:

```text
approve-plan -> awaiting issue effects
resume -> issues applied and execution reaches delivery preview
resume -> branch/PR effects applied and post-PR verification completes
resume -> idempotent delivered result
```

Assert the same lineage, issue mapping, branch, and PR are reported throughout.

- [ ] **Step 5: Run GREEN focused regression groups**

```bash
npm exec vitest -- run tests/core/task-lineage.test.ts tests/github/effect-plan.test.ts tests/workflow/execution-viability.test.ts
npm exec vitest -- run tests/adapters/github.test.ts tests/workflow/runtime-github.test.ts tests/workflow/github-delivery-effects.test.ts
npm exec vitest -- run tests/github/issue-reconciliation.test.ts tests/github/status-sync.test.ts tests/workflow/status.test.ts
npm exec vitest -- run tests/cli-smoke.test.ts tests/workflow/e2e-dry-run.test.ts tests/skill-layout.test.ts
```

Expected: every command exits 0.

- [ ] **Step 6: Run full repository gates**

If dependencies are absent, restore exactly from the lockfile first:

```bash
npm ci
```

Then run:

```bash
npm test
npm run typecheck
npm run build
npm run validate-release
git diff --check
npm pack --dry-run
```

Expected: all commands exit 0. Package dry-run includes only the declared runtime allowlist.

- [ ] **Step 7: Verify the packed artifact, not the checkout CLI**

Pack once, install the tarball into a temporary prefix without network dependency resolution, and run:

```bash
brain-hands --version
brain-hands approve-plan --help
brain-hands resume --help
brain-hands reconcile-github --help
```

Expected: version equals `package.json`; help exposes the documented boundaries; `reconcile-github` still requires explicit `--apply` for mutation.

- [ ] **Step 8: Perform the final requirements audit**

Check every numbered success criterion against a named passing test. Search the diff for:

```bash
rg -n "task_lineage_id|brain-hands-lineage|awaiting_github_(issue|delivery)_effects|github_cleanup|brain-hands:not-planned" src tests README.md agentic-codex-workflow.md .agents/skills/brain-hands
```

Confirm no direct pre-PR `pushBranch()` or `openIntegratedPullRequest()` call remains outside `github-delivery-effects.ts`.

- [ ] **Step 9: Commit**

```bash
git add README.md agentic-codex-workflow.md .agents/skills/brain-hands/SKILL.md .agents/skills/brain-hands/references/cli-contract.md tests/skill-layout.test.ts tests/cli-smoke.test.ts tests/workflow/e2e-dry-run.test.ts tests/scripts/release-validation.test.ts
git commit -m "docs: document task-lineage github effects"
```

## Requirements Traceability

| Success criterion | Implementation task | Primary proof |
| --- | --- | --- |
| New UUID lineage and record | Tasks 1-2 | `tests/core/ledger.test.ts`, `tests/core/task-lineage.test.ts` |
| Producing-only legacy migration | Task 5 | `tests/core/task-lineage.test.ts`, `tests/workflow/status.test.ts` |
| Preview identity/hash binding | Tasks 3-4 | `tests/adapters/github.test.ts`, `tests/github/effect-plan.test.ts` |
| Issue preview before mutation | Tasks 6-7 | `tests/workflow/execution-viability.test.ts`, `tests/cli-smoke.test.ts` |
| Delivery preview before mutation | Task 9 | `tests/workflow/github-delivery-effects.test.ts`, `tests/workflow/runtime-github.test.ts` |
| Drift creates replacement preview | Tasks 8-9 | effect-plan and runtime drift cases |
| Unknown create never retries | Task 8 | interrupted-create runtime cases |
| Ambiguity and identity fail closed | Tasks 3, 5, 8, 9 | adapter, migration, issue, and delivery tests |
| Stable mapping and approved extension | Tasks 4 and 8 | effect-plan replan table and runtime mapping tests |
| Exact push lease | Task 9 | delivery-effects dependency-call assertions |
| Full cleanup batch before close | Task 10 | checkpoint-inside-first-close test |
| Partial cleanup convergence | Task 10 | failure-on-second-target resume test |
| Terminal closed labels | Task 11 | closed-state label table and lifecycle integration tests |
| Packaged surface passes | Task 12 | full gates, tarball install, CLI version/help checks |

The self-review found no uncovered success criterion. Distributed cross-clone coordination remains explicitly deferred rather than partially implemented.

## Review Gates

1. After Tasks 1-2, review only local durability and schema compatibility.
2. After Tasks 3-5, review identity, observation completeness, preview determinism, and legacy migration with no orchestration mutation.
3. After Tasks 6-8, prove issue effects cannot occur before viability/preview and ambiguous creates cannot retry.
4. After Task 9, prove both delivery paths use one exact-lease gateway.
5. After Tasks 10-11, prove whole-set cleanup intent and terminal label convergence independently.
6. After Task 12, verify the packed CLI and operator contract.

Do not combine Tasks 8-11 into one commit. They are separate crash-recovery state machines and need independent review/revert boundaries.

## Deferred Follow-Up: Distributed Controllers

If independent clones must operate on one lineage concurrently, design a remote compare-and-swap reservation as a separate project. It must reserve lineage ownership before issue creation and must itself appear in the effect preview. Repeating marker search or selecting the lowest duplicate issue number is not a distributed uniqueness solution.
