# Remote Synchronization Assurance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Use `superpowers:subagent-driven-development` only when the operator explicitly authorizes subagents.

**Goal:** Before a GitHub run can receive final assurance, persist and validate one observation proving that the local candidate SHA, the mapped pull request head SHA, and the remote branch head SHA are the same commit.

**Architecture:** A new workflow boundary resolves the three identities from distinct authoritative sources and writes immutable evidence even when synchronization fails. The manifest points to that evidence. New GitHub runs require it; legacy runs without the new field retain a narrowly scoped live-check recovery path. Assurance validates evidence provenance and freshness instead of accepting a remote-check bypass.

**Tech Stack:** TypeScript 6, Zod 4, existing Git and GitHub adapters, create-once artifact helpers, Brain Hands run ledger, Vitest 4.

## Global Constraints

- Work on `main`; preserve unrelated working-tree changes.
- Resolve the PR by its persisted mapped number, not only by branch search.
- Resolve the remote head with `git ls-remote --refs`; do not trust a local remote-tracking ref.
- Persist failed observations before throwing or blocking.
- Never overwrite a prior synchronization artifact.
- Do not add synchronization failures to `WAIVABLE_BLOCKERS`.
- New GitHub runs must not use `skipRemote` or silently fall back to live inference.
- Local-mode and dry-run semantics must remain unchanged.
- Legacy manifests without the new field must remain parseable and resumable.
- Normalize SHAs to lowercase full hexadecimal values before comparison; accept the repository's existing 40-to-64-character Git object-ID range.
- Do not add GitHub writes; this plan observes state and records evidence only.

---

## File Responsibility Map

- `src/core/types.ts`: evidence and manifest-pointer interfaces.
- `src/core/schema.ts`: strict artifact schema and compatible manifest parsing.
- `src/core/ledger.ts`: initialize and transactionally update the new pointer.
- `src/workflow/remote-synchronization.ts`: resolve, validate, persist, and report the three-SHA observation.
- `src/adapters/git.ts`: existing local and remote SHA resolvers; change only if injection is needed.
- `src/adapters/github.ts`: existing persisted-number PR lookup contract.
- `src/workflow/runtime.ts`: invoke synchronization after push/PR reconciliation and before assurance publication.
- `src/workflow/assurance.ts`: validate durable synchronization evidence for new GitHub runs.
- `src/workflow/github-status.ts`: expose the blocker without weakening assurance.
- `tests/workflow/remote-synchronization.test.ts`: identity, mismatch, and persistence matrix.
- `tests/workflow/runtime-github.test.ts`: exact lifecycle placement and blocking behavior.
- `tests/workflow/assurance.test.ts`: final-evidence enforcement and legacy recovery.

## Task 1: Add the durable evidence contract and manifest pointer

**Files:**
- Modify: `src/core/types.ts:1274-1390`
- Modify: `src/core/schema.ts`
- Modify: `src/core/ledger.ts`
- Modify: `tests/core/schema.test.ts`
- Modify: `tests/core/ledger.test.ts`
- Modify: `tests/fixtures/legacy-run.ts`

**Interfaces:**

```ts
export interface RemoteSynchronizationEvidence {
  version: 1;
  run_id: string;
  branch_name: string;
  remote_name: string;
  pull_request_number: number;
  pull_request_url: string;
  local_candidate_sha: string | null;
  mapped_pr_sha: string | null;
  remote_head_sha: string | null;
  problems: Array<{
    source: "local" | "pull_request" | "remote";
    code: "lookup_unavailable" | "not_found" | "identity_mismatch" | "invalid_response" | "command_failed";
  }>;
  synchronized: boolean;
  observed_at: string;
}
```

Add to `RunManifestV2`:

```ts
remote_synchronization_path?: string | null;
```

The TypeScript field remains optional only for old persisted manifests. Newly initialized v2 manifests always write it as `null`.

- [ ] **Step 1: Write failing schema compatibility tests**

Add cases proving:

```ts
it("parses a legacy manifest without remote_synchronization_path", () => {});
it("parses a new manifest with a null synchronization pointer", () => {});
it("rejects an absolute synchronization path", () => {});
it("rejects a traversal synchronization path", () => {});
```

Use the same safe relative-path schema already applied to assurance and other owned evidence paths.

- [ ] **Step 2: Write failing evidence-schema tests**

Export `remoteSynchronizationEvidenceSchema` and cover:

- exact `version: 1`;
- non-empty run, branch, remote, and URL fields;
- positive integer PR number;
- nullable full 40-to-64-character lowercase SHA for local candidate;
- nullable full 40-to-64-character lowercase SHAs for PR and remote;
- bounded problem sources and codes with no arbitrary stderr or exception text;
- ISO timestamp format consistent with existing artifacts;
- rejection of unknown properties;
- rejection when `synchronized: true` but either peer SHA is null or unequal.

Express the equality invariant in `.superRefine()` so malformed success evidence cannot enter assurance.

- [ ] **Step 3: Run schema and ledger tests and verify RED**

Run:

```bash
npx vitest run tests/core/schema.test.ts tests/core/ledger.test.ts
```

Expected: FAIL because the new contract and manifest field are absent.

- [ ] **Step 4: Add the type and strict Zod schema**

Reuse a single Git object-ID schema where the repository already defines one. If no exported schema exists, define a local `z.string().regex(/^[0-9a-f]{40,64}$/)` and avoid an unrelated refactor.

The evidence schema must enforce:

```ts
const equal = value.problems.length === 0
  && value.local_candidate_sha !== null
  && value.mapped_pr_sha === value.local_candidate_sha
  && value.remote_head_sha === value.local_candidate_sha;
if (value.synchronized !== equal) {
  ctx.addIssue({ code: "custom", message: "synchronized must equal the three-SHA comparison" });
}
```

- [ ] **Step 5: Initialize and preserve the pointer**

Add `remote_synchronization_path: null` to new manifest construction in `src/core/ledger.ts`. Ensure transaction patching permits `null` or a validated relative path and existing create/read/update tests preserve it. Evidence files are create-once, but this pointer may advance to a newer immutable observation after an explicit retry. Do not synthesize it while parsing a legacy manifest.

Update the legacy fixture only where its explicit new-manifest shape is asserted; retain at least one fixture that truly omits the field.

- [ ] **Step 6: Run focused tests and typecheck**

Run:

```bash
npx vitest run tests/core/schema.test.ts tests/core/ledger.test.ts
npm run typecheck
```

Expected: PASS for both old and new manifest shapes.

## Task 2: Resolve and persist the three-SHA observation

**Files:**
- Create: `src/workflow/remote-synchronization.ts`
- Create: `tests/workflow/remote-synchronization.test.ts`
- Modify only if required: `src/adapters/git.ts:630-670`
- Modify: `src/adapters/github.ts:97-112, 745-765`
- Modify: `tests/adapters/github.test.ts`

**Input contract:**

```ts
export interface RecordRemoteSynchronizationInput {
  runDir: string;
  repoRoot: string;
  branchName: string;
  remoteName: string;
  pullRequestNumber: number;
  expectedPullRequestUrl: string;
  github: Pick<GitHubAdapter, "getPullRequest">;
  observedAt?: () => string;
  resolveLocalSha?: typeof resolveLocalHeadSha;
  resolveRemoteSha?: typeof resolveRemoteBranchSha;
}
```

Return `{ evidence, artifactPath }`. If GitHub lacks `getPullRequest`, persist evidence with `mapped_pr_sha: null`, add `{ source: "pull_request", code: "lookup_unavailable" }`, and return an unsynchronized result; do not infer a PR from branch state. Change `getPullRequest` to return `GitHubPullRequestReference | null`: the CLI adapter maps an authoritative not-found response to `null`, while authentication, transport, rate-limit, and malformed-response failures remain distinguishable so the workflow can record bounded problem codes.

- [ ] **Step 1: Write the success-path test first**

Use fixed values and injected resolvers. Assert:

- `resolveLocalSha(repoRoot)` is called once;
- `github.getPullRequest(persistedNumber)` is called once;
- `resolveRemoteSha(repoRoot, branchName, remoteName)` is called once;
- all SHAs are normalized to lowercase;
- the artifact is written under `assurance/remote-synchronization-<digest>.json`;
- the manifest pointer is updated to that relative path;
- parsed evidence has `synchronized: true`.

- [ ] **Step 2: Write the full failure matrix**

Table-drive these cases:

| Case | Mapped PR SHA | Remote SHA | Expected |
|---|---:|---:|---|
| PR lookup unavailable | `null` | local | persisted, unsynchronized |
| PR not found | `null` | local | persisted, unsynchronized |
| remote branch missing | local | `null` | persisted, unsynchronized |
| PR differs | other | local | persisted, unsynchronized |
| remote differs | local | other | persisted, unsynchronized |
| all three differ | other A | other B | persisted, unsynchronized |

Also cover PR identity failures independently:

- number differs from the persisted number;
- URL differs from the persisted URL after normalized trailing-slash handling;
- PR is not open;
- PR head ref differs from `branchName`;
- adapter returns a malformed SHA;
- local Git returns a malformed SHA;
- remote Git returns a malformed SHA.

Identity mismatch evidence should set `mapped_pr_sha` only when the returned PR itself is the persisted mapped PR. Otherwise use `null`; never bless an unrelated head SHA. Add adapter tests proving only an authoritative not-found response becomes `null`; every other `gh` failure remains a typed exception that the synchronization workflow records as a bounded `command_failed` or `invalid_response` problem.

- [ ] **Step 3: Test persistence and create-once behavior**

Prove:

- failed observations are on disk and manifest-linked before the caller receives the blocking result;
- retry with identical canonical evidence reuses the same digest path idempotently;
- retry with a changed observation creates a second immutable file and updates the pointer only when the workflow explicitly records a new post-push observation;
- an existing file with different bytes is rejected by the repository's create-once writer;
- artifact and manifest paths remain inside `runDir` with no symlink traversal.

- [ ] **Step 4: Run the new tests and verify RED**

Run:

```bash
npx vitest run tests/workflow/remote-synchronization.test.ts
```

Expected: FAIL because the workflow module does not exist.

- [ ] **Step 5: Implement canonical observation**

Load the manifest at the start and verify `run_id`. Resolve all three sources independently. A null result or adapter exception becomes a null SHA plus a bounded problem source/code, and the other independent lookups still run. Do not persist arbitrary stderr, URLs from exceptions, tokens, or raw command output. Throw only when the evidence itself cannot be safely persisted or linked from the manifest.

Use existing owned-evidence helpers for path validation and atomic/create-once writes. Derive the filename digest from canonical identity JSON that excludes `observed_at`. If that path already exists and its parsed identity fields are equal, reuse the existing immutable artifact and its original `observed_at`; otherwise create it with the current timestamp. Never try to write new timestamp bytes over an existing identity path.

- [ ] **Step 6: Return a typed blocker without deleting evidence**

Define:

```ts
export class RemoteSynchronizationError extends Error {
  readonly code = "remote_synchronization_failed";
  constructor(readonly evidence: RemoteSynchronizationEvidence, readonly artifactPath: string) {}
}
```

Either return an unsynchronized result and let runtime throw this error, or throw it after the manifest pointer update. Choose one convention and test it; do not mix conventions by failure type. The recommended convention is always return evidence, with runtime deciding delivery state.

- [ ] **Step 7: Run focused tests and typecheck**

Run:

```bash
npx vitest run tests/workflow/remote-synchronization.test.ts
npm run typecheck
```

Expected: PASS with failed observations durably inspectable.

## Task 3: Place synchronization at the final GitHub runtime boundary

**Files:**
- Modify: `src/workflow/runtime.ts:6196-6335`
- Modify: `tests/workflow/runtime-github.test.ts`
- Modify if status text is centralized there: `src/workflow/github-status.ts`

**Required lifecycle:**

```text
final integrated commit
  -> atomic push
  -> mapped PR create/update/reconcile
  -> record remote synchronization
  -> assess final delivery
  -> publish verified-ready status
```

- [ ] **Step 1: Add failing runtime placement tests**

Inject or spy on push, PR reconciliation, synchronization, assurance, and status publication. Assert the exact order above. The synchronization call receives:

- current `manifest.repo_root`;
- integrated branch and remote from the approved run configuration;
- the single persisted integrated PR number and URL;
- the same GitHub adapter used for reconciliation.

- [ ] **Step 2: Add blocking tests for incomplete mappings**

Before observation, runtime must block deterministically when:

- there are zero mapped PRs for a deliverable GitHub run;
- there is more than one candidate integrated PR mapping;
- the number exists but its URL is absent;
- the mapped URL's number conflicts with the number key;
- the integrated commit SHA is absent;
- local HEAD differs from the manifest integrated commit even before remote comparison.

No synchronization artifact should be fabricated when the input mapping itself is ambiguous. The runtime blocker must name the missing or conflicting field.

- [ ] **Step 3: Add mismatch lifecycle tests**

For PR-head and remote-head mismatch, prove:

- the artifact and pointer exist;
- delivery becomes blocked;
- verified-ready status is not published;
- assurance cannot be persisted as `verified_ready`;
- retry after a corrected push records a fresh successful observation and can continue;
- no GitHub issue or PR is closed as delivered on the failed attempt.

- [ ] **Step 4: Run runtime GitHub tests and verify RED**

Run:

```bash
npx vitest run tests/workflow/runtime-github.test.ts
```

Expected: FAIL because runtime does not call the synchronization boundary.

- [ ] **Step 5: Integrate with the smallest dependency seam**

Add `recordRemoteSynchronization` to the existing runtime dependency object if one exists; otherwise import the function directly and spy at the module boundary using the repository's current test style. Do not refactor unrelated runtime orchestration.

After the PR reconciliation state is persisted, read a fresh manifest, resolve the exact mapping, record evidence, and reject `synchronized: false` with a blocker that includes all three SHA values and the relative evidence path.

- [ ] **Step 6: Remove the runtime remote bypass**

At `publishGithubWorkflowStatus`, remove construction of assurance options containing `skipRemote: true`. Status publication must consume a validated durable assessment or call assurance without a remote bypass.

If this changes the function signature, update only direct callers and focused tests.

- [ ] **Step 7: Run runtime tests**

Run:

```bash
npx vitest run tests/workflow/runtime-github.test.ts tests/workflow/runtime-local.test.ts
npm run typecheck
```

Expected: GitHub synchronization cases PASS; local-mode behavior is unchanged.

## Task 4: Make assurance validate evidence provenance and freshness

**Files:**
- Modify: `src/workflow/assurance.ts:26-280`
- Modify: `tests/workflow/assurance.test.ts`
- Modify: `src/workflow/status.ts` only if needed for read-only legacy inspection
- Modify: `tests/workflow/status.test.ts` only if behavior changes

- [ ] **Step 1: Write failing new-run assurance tests**

For a current GitHub manifest with the new field present, assert these blocker codes:

```text
missing_remote_synchronization
invalid_remote_synchronization
stale_remote_synchronization
remote_candidate_mismatch
```

Cover:

- pointer is `null`;
- path is missing, absolute, traversal, or symlinked;
- JSON fails the strict schema;
- artifact `run_id`, branch, remote, PR number, or URL differs from manifest;
- local candidate differs from `work_item_progress.integrated.commit_sha`;
- any of the three SHAs differ;
- `synchronized` is false;
- artifact predates the current final integrated commit/push boundary if a durable boundary timestamp is available.

Do not accept a successful artifact for commit A after the manifest advances to commit B.

- [ ] **Step 2: Preserve an explicit legacy recovery test**

A manifest that truly omits `remote_synchronization_path` follows the existing live check using:

```text
resolveLocalHeadSha
resolveRemoteBranchSha
GitHub PR lookup
```

It may recover, but it must not write the new field implicitly or claim durable three-source evidence. A manifest that contains the field with value `null` is new-shape and must block; it must not take the legacy path.

- [ ] **Step 3: Remove `skipRemote` from the public assessment contract**

Delete `skipRemote?: boolean` from `AssuranceAssessmentOptions` after all call sites are migrated. Keep other test injection options such as candidate commit and worktree state only when they do not bypass evidence validation.

Add a compile-time or source contract test proving `publishGithubWorkflowStatus` cannot request remote skipping again.

- [ ] **Step 4: Run assurance tests and verify RED**

Run:

```bash
npx vitest run tests/workflow/assurance.test.ts tests/workflow/status.test.ts
```

Expected: FAIL until evidence loading and validation are implemented.

- [ ] **Step 5: Implement strict evidence loading**

Use no-follow safe reads and validate the relative path before joining it to `runDir`. Parse with `remoteSynchronizationEvidenceSchema`. Compare the artifact against the manifest and integrated commit with explicit blocker messages.

Successful final assurance for new GitHub runs requires:

```ts
evidence.synchronized === true
&& evidence.local_candidate_sha === integratedCommit
&& evidence.mapped_pr_sha === integratedCommit
&& evidence.remote_head_sha === integratedCommit
```

Also require the mapped PR number and URL to remain present and equal to the artifact.

- [ ] **Step 6: Keep remote blockers non-waivable**

Inspect `WAIVABLE_BLOCKERS` and any `acceptFinalDeliveryRisk` mapping. Add tests that every new remote blocker remains `blocked` when a human tries to accept final delivery risk. Do not add these codes to a generic waiver group.

- [ ] **Step 7: Run assurance and CLI smoke tests**

Run:

```bash
npx vitest run tests/workflow/assurance.test.ts tests/workflow/status.test.ts tests/cli-smoke.test.ts
npm run typecheck
```

Expected: PASS. New GitHub runs fail closed; legacy recovery remains available.

## Task 5: Document and verify the complete remote-assurance boundary

**Files:**
- Modify: `README.md`
- Modify: `agentic-codex-workflow.md`
- Modify: `prompts/verifier-review-v2.md` only if it describes final assurance evidence
- Test: all files above

- [ ] **Step 1: Document operator-visible evidence**

Describe where the artifact is stored, the three authoritative SHA sources, and what to do on mismatch:

```text
1. Inspect assurance/remote-synchronization-*.json.
2. Compare local_candidate_sha, mapped_pr_sha, and remote_head_sha.
3. Correct the push or PR mapping; do not edit the artifact.
4. Resume so Brain Hands records a new observation.
```

Do not imply that risk acceptance can waive this blocker.

- [ ] **Step 2: Run the focused implementation tests**

Run:

```bash
npx vitest run tests/core/schema.test.ts tests/core/ledger.test.ts tests/workflow/remote-synchronization.test.ts tests/workflow/runtime-github.test.ts tests/workflow/runtime-local.test.ts tests/workflow/assurance.test.ts tests/workflow/status.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run the repository funnel**

After the immutable built-CLI plan is implemented, run:

```bash
npm run verify:funnel
```

If this plan is implemented first, use the repository's then-current canonical full gate and record the exact command in the implementation report.

Expected: PASS.

- [ ] **Step 4: Verify generated and documentation hygiene**

Run:

```bash
git diff --check
git status --short
```

Expected: no whitespace errors; only intended implementation, tests, prompts, and docs are changed.

## Final Acceptance Checklist

- [ ] The local candidate comes from the actual candidate worktree HEAD.
- [ ] The PR head comes from `getPullRequest` using the persisted PR number.
- [ ] The remote head comes from `git ls-remote --refs` for the configured branch.
- [ ] Failed observations are durably persisted and inspectable.
- [ ] Successful evidence requires all three full SHAs to be equal.
- [ ] The evidence matches the current run, integrated commit, branch, remote, PR number, and PR URL.
- [ ] New manifests with a null pointer fail closed.
- [ ] Only manifests that omit the field use legacy live recovery.
- [ ] Runtime cannot request `skipRemote`.
- [ ] Remote synchronization blockers cannot be risk-accepted.
- [ ] Local and dry-run workflows remain unchanged.

## Self-Review Before Implementation

- Confirm the exact integrated branch, remote, PR number, URL, and commit fields in the current manifest before coding the mapper.
- Confirm `GitHubPullRequestReference` exposes state, head ref, head SHA, number, and URL; extend only the missing property.
- Confirm owned-evidence helpers provide no-follow reads and create-once writes before adding new filesystem code.
- Confirm retry semantics never overwrite an observation and never accept an artifact for an older integrated commit.
- Confirm adapter failures remain distinguishable from authoritative null results.
- Confirm every blocker code is tested through both assessment and risk-acceptance paths.
