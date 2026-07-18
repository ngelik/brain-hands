# Bounded Context and Resource Governance: Reviewed File-Level Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. The repository instructions prohibit subagents unless the user explicitly requests them. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce model context and operator log noise while preserving the complete durable audit trail, then enforce deterministic per-run resource budgets at the actual model, verification, push, and GitHub mutation boundaries.

**Architecture:** Add a new `bounded-context-v1` workflow protocol without migrating active `legacy-v2` or `durable-discovery-v1` runs. Full evidence remains immutable and authoritative. New controller-built summaries, phase indexes, and role packages are immutable projections with byte-accurate caps and hash-validated references. Budget authority lives in create-once claim/completion artifacts protected by the run-ledger transaction; safe progress remains observational and is compacted only when rendered.

**Tech Stack:** TypeScript 6, Node.js 20+, Zod 4, Commander 15, Execa 9, Vitest 4, Git, GitHub CLI.

## Global Constraints

- Work on `main`; do not create a feature branch unless the user changes that instruction.
- Preserve unrelated worktree changes. Every edited line must trace to this feature.
- Do not delete or truncate `events.jsonl`, `progress.jsonl`, prompts, responses, implementation reports, verification bundles, reviews, findings, or assurance artifacts.
- `events.jsonl`, manifest transitions, validated evidence, review artifacts, and assurance remain authoritative. Summaries and indexes are projections and cannot independently prove acceptance.
- `progress.jsonl` remains safe, append-only telemetry. Coalescing happens in the human-readable replay/follow view only; `logs --json` continues to expose validated individual events.
- Every summary, index, role package, budget policy, claim, and completion is strict canonical JSON written create-once.
- Artifact references hash the exact persisted bytes, including the trailing newline.
- Required context is never string-sliced. If required whole sections exceed the role cap, block before invoking the model. Optional whole records may be omitted only with an explicit reference and reason.
- Controller-observed Git state and schema-validated evidence override model-reported changed files, acceptance coverage, command results, and finding status.
- A missing or malformed model token report is not zero usage. A structured terminal error before `turn.started` proves zero token usage and preserves the existing primary-usage-limit backup path; once a turn started, missing valid usage makes accounting uncertain and blocks the next chargeable action.
- Elapsed-time claims reserve a bounded maximum before a subprocess starts. A completed subprocess is charged actual wall time; an unreconciled open claim retains its reservation.
- An external-effect unit is consumed when a new durable mutation intent is recorded. Replaying the same idempotency key consumes no second unit.
- Existing runs keep their recorded protocol. New behavior is activated only in Task 18 after both old and new protocol suites pass.
- Do not add runtime dependencies.

## Assumptions Requiring Product Confirmation Before Activation

Implementation can proceed behind the protocol gate with these proposed defaults, but Task 18 must not make `bounded-context-v1` the new-run default until the maintainer accepts them:

```ts
export const CONTEXT_LIMITS_V1 = {
  hands_total_bytes: 64 * 1024,
  hands_diff_bytes: 32 * 1024,
  hands_evidence_bytes: 16 * 1024,
  verifier_total_bytes: 64 * 1024,
  verifier_diff_bytes: 32 * 1024,
  reflection_total_bytes: 96 * 1024,
} as const;

export const DEFAULT_RESOURCE_BUDGET_V1 = {
  schema_version: 1,
  max_model_invocations: 64,
  max_workflow_attempts: 32,
  max_total_tokens: 4_000_000,
  max_active_elapsed_ms: 4 * 60 * 60 * 1000,
  max_external_effects: 128,
} as const;
```

Token budget is `input_tokens + output_tokens`; cached input and reasoning output remain visible counters and are not added twice.

## One-by-One Review of the Original Ten Tasks

1. **Artifact contracts:** Keep the direction, but split pure schemas from ledger storage. Use phase-specific discriminated unions and exact-byte references; one generic index schema is too easy to misuse.
2. **Work-item summaries:** Keep immutable summaries, but derive them only after commit provenance is known. Version paths by plan revision and attempt, and require exact acceptance-ID coverage on approval.
3. **Evidence indexes:** Replace `final-verifier` with two terminal review phases, `final_integrated` and `post_pr`. Reflection gets a distinct terminal index. The synthetic `integrated` progress entry never receives a work-item summary.
4. **Bounded contexts:** Persist the work-item base commit before Hands starts. Build a path-filtered diff from the approved file contract; do not infer relevance from a model report or slice a repository-wide patch.
5. **Hands and Verifier wiring:** Split this into separate gates. Hands receives the complete work-item spec, the current item diff, only active prior findings, and dependency-summary evidence. Verifier receives the acceptance contract, controller-observed changed files and diff, normalized command evidence, and active findings.
6. **Reflection:** Remove recursive ledger scans only for `bounded-context-v1`. Reflection uses the terminal evidence index plus compact process metrics; legacy protocols retain the current renderer for resume compatibility.
7. **Budget model:** Preserve claim/completion accounting, but version `run-configuration.json` instead of silently changing its strict v1 schema. Define missing token usage and crash recovery explicitly.
8. **Charge boundaries:** Do not add a blanket GitHub adapter decorator. Existing issue, status, PR, lifecycle, and push reconciliation owns idempotency. Charge when those modules persist a new mutation intent, and complete against the same operation identity.
9. **Progress noise:** Keep raw safe heartbeat records. Add a stateful human-view reducer for replay/follow and deduplicate unreadable-stream warnings by source fingerprint. JSON output remains lossless.
10. **Compatibility and activation:** Make this the last task, not a catch-all implementation task. It contains only protocol selection, fixtures, docs, full verification, and compiled lifecycle proof.

## Fixed Artifact Layout

```text
summaries/work-items/<base64url-work-item>/plan-<P>/attempt-<A>.json
evidence-indexes/verifier/final-integrated/attempt-<A>.json
evidence-indexes/verifier/post-pr/attempt-<A>.json
evidence-indexes/reflection/final.json
contexts/hands/<base64url-work-item>/plan-<P>/attempt-<A>/<attempt-kind>.json
contexts/verifier/<base64url-work-item>/<phase>/attempt-<A>.json
contexts/reflection/final.json
budgets/policy.json
budgets/claims/<base64url-claim-id>.json
budgets/completions/<base64url-claim-id>.json
```

Allowed Verifier phases are `work_item`, `final_integrated`, and `post_pr`. `reflection` is not a Verifier phase.

## File Responsibility Map

**Create**

- `src/core/context-contracts.ts` — strict schemas, types, caps, canonical serialization, exact-byte hashing, safe run-relative paths, and base64url identity segments.
- `src/workflow/work-item-summaries.ts` — summary derivation, source validation, persistence, and resume validation.
- `src/workflow/evidence-index.ts` — final-integrated, post-PR, and reflection index builders/loaders.
- `src/workflow/role-context.ts` — scoped-diff selection, whole-record packing, omission records, persistence, and reload validation.
- `src/core/resource-budget.ts` — policy/claim/completion schemas and pure deterministic reduction.
- `src/workflow/resource-budget.ts` — run-ledger-locked claim/completion controller and reconciliation rules.
- `src/progress/view.ts` — pure/stateful human-view coalescer; no filesystem writes.
- `tests/core/context-contracts.test.ts`
- `tests/workflow/work-item-summaries.test.ts`
- `tests/workflow/evidence-index.test.ts`
- `tests/workflow/role-context.test.ts`
- `tests/core/resource-budget.test.ts`
- `tests/workflow/resource-budget.test.ts`
- `tests/progress/view.test.ts`

**Modify**

- `src/core/types.ts`, `src/core/schema.ts` — protocol and manifest/progress pointers only; inferred context/budget types remain in their focused modules.
- `src/core/ledger.ts` — directory creation, engine-owned roots, immutable writes, and bounded-protocol manifest invariants.
- `src/adapters/git.ts` — one reusable, path-filtered tracked/untracked diff collector.
- `src/workflow/runtime.ts` — capture base SHA, build/persist summaries and indexes, pass role packages, attach budgets, and gate completion.
- `src/workflow/worker.ts`, `src/workflow/hands-recovery.ts`, `src/workflow/verifier.ts`, `src/workflow/reflection.ts` — protocol-discriminated compact prompt rendering.
- `src/workflow/assurance.ts` — require the phase-matching final index while still validating primary evidence independently.
- `src/adapters/codex.ts`, `src/progress/codex.ts` — always parse structured events, return strict usage/duration, and preserve metrics on errors.
- `src/verification/runner.ts` — budget elapsed time per command and preserve command-ID mapping supplied by runtime.
- `src/workflow/discovery.ts`, `src/workflow/planner.ts`, `src/workflow/plan-repair.ts`, `src/workflow/replan.ts`, `src/workflow/self-review.ts`, `src/workflow/action-verifier.ts`, `src/workflow/fix-packets.ts` — stable invocation/attempt coordinates where these modules invoke Codex.
- `src/workflow/github-issue-reconciliation.ts`, `src/github/status-sync.ts`, `src/github/issue-reconciliation.ts`, `src/workflow/runtime.ts` — charge existing durable external-effect intents.
- `src/core/config.ts`, `src/core/run-configuration.ts`, `src/workflow/status.ts`, `src/cli.ts` — policy snapshot, versioned preview/run config, usage display, and compact human logs.
- Prompt templates under `prompts/` — exact bounded-package contracts without run-root/history placeholders.
- Existing tests named by each task below.
- `README.md`, `agentic-codex-workflow.md`, `.agents/skills/brain-hands/SKILL.md`, `docs/example-config.yaml` — operator contract.

---

### Task 1: Define Strict Context Contracts and Protocol Recognition

**Files:**
- Create: `src/core/context-contracts.ts`
- Create: `tests/core/context-contracts.test.ts`
- Modify: `src/core/types.ts`
- Modify: `src/core/schema.ts`
- Modify: `tests/core/schema.test.ts`

**Interfaces:**
- Produces `artifactRefV1Schema`, `workItemSummaryV1Schema`, `evidenceIndexV1Schema`, `handsContextV1Schema`, `verifierContextV1Schema`, `reflectionContextV1Schema`.
- Produces `canonicalJsonBytes(schema, value): Buffer`, `sha256Bytes(bytes): string`, `artifactRefFromBytes(path, bytes): ArtifactRefV1`, `artifactSegment(identity): string`.
- Recognizes, but does not default to, `bounded-context-v1`.

- [ ] **Step 1: Write failing contract tests**

Test strict unknown-field rejection, UTF-8 byte measurement, exact trailing-newline hashing, base64url collision resistance for `a/b` versus `a_b`, and all three evidence-index phase variants.

```ts
it("hashes exact canonical bytes", () => {
  const bytes = canonicalJsonBytes(artifactRefV1Schema, {
    path: "verification/local/a/attempt-1/evidence.json",
    sha256: "a".repeat(64),
  });
  expect(bytes.at(-1)).toBe(10);
  expect(sha256Bytes(bytes)).toBe(createHash("sha256").update(bytes).digest("hex"));
});

it("keeps unsafe identities distinct", () => {
  expect(artifactSegment("a/b")).not.toBe(artifactSegment("a_b"));
});
```

- [ ] **Step 2: Verify RED**

Run: `npx vitest run tests/core/context-contracts.test.ts tests/core/schema.test.ts`

Expected: FAIL because `src/core/context-contracts.ts` and the new protocol do not exist.

- [ ] **Step 3: Implement the exact contract shapes**

Use this summary payload; do not invent evidence-record IDs that the current verification schema does not provide:

```ts
export const workItemSummaryV1Schema = z.object({
  schema_version: z.literal(1),
  run_id: z.string().min(1),
  work_item_id: z.string().min(1),
  plan_revision: z.number().int().positive(),
  plan_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  attempt: z.number().int().positive(),
  base_commit: z.string().regex(/^[a-f0-9]{40,64}$/),
  commit_sha: z.union([z.string().regex(/^[a-f0-9]{40,64}$/), z.literal("no-op")]),
  completion_basis: z.enum(["verifier_approve", "policy_advance", "policy_warning_continuation"]),
  implementation_ref: artifactRefV1Schema,
  verification_ref: artifactRefV1Schema,
  review_ref: artifactRefV1Schema,
  policy_decision_ref: artifactRefV1Schema.nullable(),
  changed_files: z.array(artifactPathSchema),
  acceptance_ids: z.array(z.string().min(1)),
  command_evidence: z.array(z.object({
    command_id: z.string().min(1),
    argv: z.array(z.string()).min(1),
    exit_code: z.number().int().nullable(),
    timed_out: z.boolean(),
    result_ref: artifactRefV1Schema,
  }).strict()),
  resolved_finding_ids: z.array(z.string().min(1)),
  unresolved_finding_ids: z.array(z.string().min(1)),
  residual_risks: z.array(z.string().min(1)),
  created_at: z.string().datetime(),
}).strict();
```

Define `evidenceIndexV1Schema` as a discriminated union:

- `phase: "final_integrated" | "post_pr"`: `final_review_ref` must be `null`, `terminal` must be `null`.
- `phase: "reflection"`: `final_review_ref` and `terminal` are required; `assurance` contains outcome and optional assessment reference.
- Every variant includes approved-plan reference, candidate commit, ordered work-item summary references, integrated verification reference, and unresolved finding references.

Define role payloads separately so Hands can never accidentally receive `run_history` and Verifier can never receive arbitrary `artifacts_context`.

- [ ] **Step 4: Verify GREEN**

Run: `npx vitest run tests/core/context-contracts.test.ts tests/core/schema.test.ts`

Expected: PASS. Existing `legacy-v2` and `durable-discovery-v1` fixtures still parse.

- [ ] **Step 5: Commit**

```bash
git add src/core/context-contracts.ts src/core/types.ts src/core/schema.ts tests/core/context-contracts.test.ts tests/core/schema.test.ts
git commit -m "feat: define bounded context contracts"
```

### Task 2: Add Immutable Ledger Storage and Manifest Pointers

**Files:**
- Modify: `src/core/ledger.ts`
- Modify: `src/core/types.ts`
- Modify: `src/core/schema.ts`
- Modify: `tests/core/ledger.test.ts`

**Interfaces:**
- Adds `context_base_commit`, `context_plan_revision`, `summary_path`, and `summary_sha256` to `WorkItemProgress`.
- Adds nullable `final_verifier_index_path`, `reflection_index_path`, and optional `resource_budget_policy` to `RunManifestV2`.
- Produces `writeImmutableValidatedJson(runDir, relativePath, schema, value): Promise<ArtifactRefV1>` and `readReferencedJson(runDir, ref, schema): Promise<T>`.

- [ ] **Step 1: Write failing ledger tests**

Cover create-once equality replay, byte mismatch rejection, path traversal rejection, protected-root rejection through `writeTextArtifact`, and bounded-protocol completion without a summary pointer.

- [ ] **Step 2: Verify RED**

Run: `npx vitest run tests/core/ledger.test.ts`

Expected: FAIL on missing directories/helpers/invariants.

- [ ] **Step 3: Extend ledger creation and protection**

Create `summaries/`, `evidence-indexes/`, `contexts/`, and `budgets/{claims,completions}` in `createRunLedgerV2`. Add these roots to `protectedV2ArtifactKind`. Reuse `writeCreateOnceValidated` and `withRunLedgerTransaction`; do not add a second lock implementation.

For `bounded-context-v1`, `writeManifestV2Atomic` must enforce:

```ts
if (workItemId !== "integrated" && progress.status === "complete") {
  if (!progress.summary_path || !progress.summary_sha256) {
    throw new Error(`Completed work item ${workItemId} requires an immutable summary`);
  }
}
```

Do not apply this rule to the synthetic `integrated` progress entry.

- [ ] **Step 4: Verify GREEN**

Run: `npx vitest run tests/core/ledger.test.ts tests/core/schema.test.ts`

Expected: PASS, including unchanged legacy manifest behavior.

- [ ] **Step 5: Commit**

```bash
git add src/core/ledger.ts src/core/types.ts src/core/schema.ts tests/core/ledger.test.ts
git commit -m "feat: protect bounded run artifacts"
```

### Task 3: Derive and Persist Work-Item Summaries

**Files:**
- Create: `src/workflow/work-item-summaries.ts`
- Create: `tests/workflow/work-item-summaries.test.ts`
- Modify: `src/workflow/findings.ts`

**Interfaces:**
- Produces `workItemSummaryPath(workItemId, planRevision, attempt): string`.
- Produces `persistWorkItemSummary(input): Promise<ArtifactRefV1>`.
- Produces `loadWorkItemSummary(runDir, ref, expected): Promise<WorkItemSummaryV1>`.
- Consumes validated `ImplementationResult`, `VerificationEvidence`, `VerifierReview`, current finding revisions, and commit provenance.

- [ ] **Step 1: Write failing derivation tests**

Cover wrong plan hash, wrong attempt, non-approving review without policy authority, incomplete acceptance coverage on Verifier approval, warning continuation without its decision/authorization artifact, command-count/argv mismatch, result-path hash mismatch, stale finding revision, and the same work item summarized under two plan revisions.

Approval coverage is exact set equality:

```ts
expect(() => assertApprovedAcceptanceCoverage(
  ["AC-1", "AC-2"],
  ["AC-2", "AC-1"],
)).not.toThrow();
expect(() => assertApprovedAcceptanceCoverage(
  ["AC-1", "AC-2"],
  ["AC-1"],
)).toThrow("Verifier approval does not cover required acceptance IDs");
```

- [ ] **Step 2: Verify RED**

Run: `npx vitest run tests/workflow/work-item-summaries.test.ts tests/workflow/findings.test.ts`

Expected: FAIL because the summary module does not exist.

- [ ] **Step 3: Implement controller-only derivation**

Map `workItem.verification_commands[index].id` to `verification.commands[index]` only after asserting exact argv equality. Hash the referenced command result file and store the reference. Obtain resolved/unresolved finding IDs from the durable finding revisions, never from review prose. Sort and deduplicate every set-like array before schema parsing.

For `completion_basis: "verifier_approve"`, require `review.decision === "approve"`, exact required acceptance-ID coverage, and `policy_decision_ref === null`. For `policy_advance`, require a hash-validated review-cycle decision whose action is `advance`. For `policy_warning_continuation`, require action `continue_with_warning`, its linked authorization proof, and preserve incomplete coverage plus unresolved finding IDs in the summary.

Use this path function:

```ts
export function workItemSummaryPath(id: string, revision: number, attempt: number): string {
  return `summaries/work-items/${artifactSegment(id)}/plan-${revision}/attempt-${attempt}.json`;
}
```

On reload, validate run ID, work-item ID, plan revision/hash, attempt, base commit, commit SHA, and every referenced artifact hash.

- [ ] **Step 4: Verify GREEN**

Run: `npx vitest run tests/workflow/work-item-summaries.test.ts tests/workflow/findings.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/workflow/work-item-summaries.ts src/workflow/findings.ts tests/workflow/work-item-summaries.test.ts tests/workflow/findings.test.ts
git commit -m "feat: build immutable work item summaries"
```

### Task 4: Gate Work-Item Completion and Resume on Summaries

**Files:**
- Modify: `src/workflow/runtime.ts`
- Modify: `tests/workflow/runtime-local.test.ts`
- Modify: `tests/workflow/runtime-github.test.ts`

**Interfaces:**
- Captures `context_base_commit` and `context_plan_revision` before the first Hands mutation for an item/revision.
- Persists a summary before both policy and legacy approval branches write `status: "complete"`.
- Reloads and validates the summary before skipping any completed item on resume.

- [ ] **Step 1: Add failing runtime tests**

Add checkpoint tests for crashes after commit/before summary, after summary/before manifest pointer, and after manifest pointer. Add a replan test proving the old summary remains immutable while the new plan revision receives a new path.

- [ ] **Step 2: Verify RED**

Run: `npx vitest run tests/workflow/runtime-local.test.ts tests/workflow/runtime-github.test.ts`

Expected: FAIL because completion currently has no summary gate.

- [ ] **Step 3: Integrate both completion branches**

In the review-policy `advance` branch near the current work-item commit result and in the legacy `review.decision === "approve"` branch, perform this order:

1. Validate final verification/review and commit provenance.
2. Build the summary from persisted sources.
3. Persist/reload the summary.
4. Write `summary_path`, `summary_sha256`, and `status: "complete"` in one `setProgress` transition.
5. Publish GitHub status only after that manifest write.

If a summary exists but the pointer is missing after a crash, derive the expected path and adopt it only after full validation. Never overwrite it.

- [ ] **Step 4: Verify GREEN**

Run: `npx vitest run tests/workflow/runtime-local.test.ts tests/workflow/runtime-github.test.ts tests/workflow/work-item-summaries.test.ts`

Expected: PASS; spies prove no complete status is published before summary validation.

- [ ] **Step 5: Commit**

```bash
git add src/workflow/runtime.ts tests/workflow/runtime-local.test.ts tests/workflow/runtime-github.test.ts
git commit -m "feat: require summaries for item completion"
```

### Task 5: Build Phase-Specific Evidence Indexes

**Files:**
- Create: `src/workflow/evidence-index.ts`
- Create: `tests/workflow/evidence-index.test.ts`
- Modify: `src/workflow/findings.ts`

**Interfaces:**
- Produces `buildVerifierEvidenceIndex(input): Promise<ArtifactRefV1>` for `final_integrated | post_pr`.
- Produces `buildReflectionEvidenceIndex(input): Promise<ArtifactRefV1>`.
- Produces `loadEvidenceIndex(runDir, ref, expected): Promise<EvidenceIndexV1>`.

- [ ] **Step 1: Write failing completeness tests**

Cover missing summary for an approved item, summary from a superseded plan, duplicate item summary, wrong plan order, wrong candidate commit, stale integrated verification, missing active finding reference, final-integrated index with a final review, and reflection index without the exact terminal review.

- [ ] **Step 2: Verify RED**

Run: `npx vitest run tests/workflow/evidence-index.test.ts`

Expected: FAIL because the builder does not exist.

- [ ] **Step 3: Implement deterministic builders**

The Verifier index path is selected only from its explicit phase:

```ts
export function verifierEvidenceIndexPath(
  phase: "final_integrated" | "post_pr",
  attempt: number,
): string {
  const directory = phase === "final_integrated" ? "final-integrated" : "post-pr";
  return `evidence-indexes/verifier/${directory}/attempt-${attempt}.json`;
}
```

Require exactly one valid current summary for every approved plan work item, ordered by the plan. Exclude `integrated`. Hash current finding revision files. The reflection builder additionally requires the exact final review path, terminal disposition, assurance outcome, and optional assurance assessment reference.

- [ ] **Step 4: Verify GREEN**

Run: `npx vitest run tests/workflow/evidence-index.test.ts tests/workflow/work-item-summaries.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/workflow/evidence-index.ts src/workflow/findings.ts tests/workflow/evidence-index.test.ts
git commit -m "feat: build phase evidence indexes"
```

### Task 6: Gate Final Verifier, Assurance, and Reflection on Indexes

**Files:**
- Modify: `src/workflow/runtime.ts`
- Modify: `src/workflow/assurance.ts`
- Modify: `src/workflow/reflection.ts`
- Modify: `src/progress/session-lifecycle.ts`
- Modify: `tests/workflow/runtime-local.test.ts`
- Modify: `tests/workflow/runtime-github.test.ts`
- Modify: `tests/workflow/assurance.test.ts`
- Modify: `tests/workflow/reflection.test.ts`
- Modify: `tests/progress/session-lifecycle.test.ts`

**Interfaces:**
- Sets `final_verifier_index_path` before each terminal Verifier invocation.
- Sets `reflection_index_path` before the first reflection account invocation.
- Assurance validates the matching index but continues primary evidence validation.

- [ ] **Step 1: Add failing invocation-gate tests**

Use spies to prove final Verifier is not invoked for a missing/stale final-integrated or post-PR index, reflection is not invoked without its terminal index, and assurance does not accept an index whose underlying evidence was tampered with. Add a session-lifecycle ordering test that records `reconcile`, `assure`, `reflect`, `finalize` in that exact order.

- [ ] **Step 2: Verify RED**

Run: `npx vitest run tests/workflow/runtime-local.test.ts tests/workflow/runtime-github.test.ts tests/workflow/assurance.test.ts tests/workflow/reflection.test.ts tests/progress/session-lifecycle.test.ts`

Expected: FAIL on missing gates.

- [ ] **Step 3: Wire the phase gates**

Build and immediately reload the Verifier index after integrated verification is persisted and before `verifyWorkItem({ final: true })`. Use `final_integrated` for the pre-delivery pass and `post_pr` for the post-PR pass. Record an operational blocker on validation failure.

Build the reflection index only after terminal disposition and assurance outcome exist. Add it to `final_artifact_paths`, then reload it before either reflection account.

In `runProducingCommand.finishTerminalWork`, reorder terminal callbacks from `reconcile -> reflect -> assure` to `reconcile -> assure -> reflect`. Assurance has no reflection dependency; this makes its immutable result available to the reflection index. Preserve the rule that session finalization runs only after both complete.

In `assessFinalDelivery`, compare index phase, attempt, candidate commit, approved-plan ref, and integrated verification ref, then independently run the existing evidence/review checks. An index never converts invalid primary evidence into approval.

- [ ] **Step 4: Verify GREEN**

Run: `npx vitest run tests/workflow/runtime-local.test.ts tests/workflow/runtime-github.test.ts tests/workflow/assurance.test.ts tests/workflow/reflection.test.ts tests/progress/session-lifecycle.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/workflow/runtime.ts src/workflow/assurance.ts src/workflow/reflection.ts src/progress/session-lifecycle.ts tests/workflow/runtime-local.test.ts tests/workflow/runtime-github.test.ts tests/workflow/assurance.test.ts tests/workflow/reflection.test.ts tests/progress/session-lifecycle.test.ts
git commit -m "feat: gate terminal roles on evidence indexes"
```

### Task 7: Add a Reusable Scoped Diff Collector

**Files:**
- Modify: `src/adapters/git.ts`
- Modify: `src/workflow/runtime.ts`
- Modify: `tests/adapters/git-worktree.test.ts`
- Modify: `tests/workflow/runtime-local.test.ts`

**Interfaces:**
- Produces `collectScopedWorktreeDiff(input): Promise<ScopedDiff>`.
- `ScopedDiff` contains `base_commit`, `head_commit`, sorted `changed_files`, `patch`, and `patch_bytes`.
- Runtime injects this helper through `LocalRuntimeDependencies` for deterministic tests.

- [ ] **Step 1: Write failing Git tests**

Cover tracked modifications, staged changes, untracked text files, deleted files, path filtering, path names containing spaces, and rejection of paths outside the approved repository-relative contract.

- [ ] **Step 2: Verify RED**

Run: `npx vitest run tests/adapters/git-worktree.test.ts`

Expected: FAIL because only the runtime-local broad diff helper currently includes untracked files.

- [ ] **Step 3: Extract one collector**

Move the existing tracked-plus-untracked behavior from `runtime.ts` into `adapters/git.ts`. Use direct argv and `--` pathspec separation. Filter paths from `workItem.file_contract` and `completion_contract.expected_changed_files`; do not use `ImplementationResult.changed_files` as the allowlist.

The collector must measure `Buffer.byteLength(patch, "utf8")`. It must return whole patch sections and never truncate a patch.

- [ ] **Step 4: Verify GREEN**

Run: `npx vitest run tests/adapters/git-worktree.test.ts tests/workflow/runtime-local.test.ts`

Expected: PASS with no duplicate broad-diff implementation left in runtime.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/git.ts src/workflow/runtime.ts tests/adapters/git-worktree.test.ts tests/workflow/runtime-local.test.ts
git commit -m "refactor: centralize scoped worktree diffs"
```

### Task 8: Build and Persist Bounded Role Packages

**Files:**
- Create: `src/workflow/role-context.ts`
- Create: `tests/workflow/role-context.test.ts`

**Interfaces:**
- Produces `buildHandsContext(input): Promise<ArtifactRefV1>`.
- Produces `buildVerifierContext(input): Promise<ArtifactRefV1>`.
- Produces `buildReflectionContext(input): Promise<ArtifactRefV1>`.
- Produces `loadRoleContext(runDir, ref, expectedRole): Promise<HandsContextV1 | VerifierContextV1 | ReflectionContextV1>`.

- [ ] **Step 1: Write failing selection/cap tests**

Assert deterministic ordering, exact UTF-8 cap behavior, required-section overflow blocking, optional whole-record omission, omission references, stale source hashes, and no keys named `run_history`, `events`, `run_dir`, `evidence_root`, or `artifacts_context`.

- [ ] **Step 2: Verify RED**

Run: `npx vitest run tests/workflow/role-context.test.ts`

Expected: FAIL because the package builder does not exist.

- [ ] **Step 3: Implement role-specific packing**

Hands required payload:

```ts
{
  work_item,
  diff,
  active_findings,
  dependency_summaries,
  bounded_evidence,
  omitted_evidence,
}
```

Verifier required payload:

```ts
{
  phase,
  work_item_id,
  acceptance_contract,
  changed_files,
  diff,
  command_evidence,
  artifact_checks,
  browser_evidence,
  active_findings,
  evidence_index_ref,
  omitted_evidence,
}
```

Reflection required payload:

```ts
{
  evidence_index,
  work_item_summaries,
  active_findings,
  process_metrics,
  omitted_evidence,
}
```

Pack required records first. Rank optional records by explicit type priority and path, not discovery order. If an optional record does not fit, add `{ ref, reason: "role_byte_limit" }`; do not partially include it.

- [ ] **Step 4: Verify GREEN**

Run: `npx vitest run tests/workflow/role-context.test.ts tests/core/context-contracts.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/workflow/role-context.ts tests/workflow/role-context.test.ts
git commit -m "feat: build bounded role packages"
```

### Task 9: Give Hands Only Its Bounded Package

**Files:**
- Modify: `src/workflow/worker.ts`
- Modify: `src/workflow/hands-recovery.ts`
- Modify: `src/workflow/runtime.ts`
- Modify: `prompts/hands-work-item-v2.md`
- Modify: `prompts/hands-fix-packet-v1.md`
- Modify: `prompts/hands-recovery-v2.md`
- Modify: `tests/workflow/worker.test.ts`
- Modify: `tests/workflow/hands-recovery.test.ts`
- Modify: `tests/workflow/fix-packet-worker.test.ts`
- Modify: `tests/workflow/runtime-local.test.ts`

**Interfaces:**
- Replaces broad `findings`, `diagnosticContext`, `relevantSourceContext`, and `evidenceContext` prompt fields with one `contextRef` plus the validated `HandsContextV1` value.
- Runtime builds a context for `initial`, `primary_fix`, `fix_packet`, and `quality_recovery` attempts.

- [ ] **Step 1: Add failing prompt non-leakage tests**

Seed unrelated events, prompts, verification output, and completed work. Assert none appears in the Hands prompt. Assert the exact work-item spec, current scoped patch, active current-item finding, and dependency summary do appear.

- [ ] **Step 2: Verify RED**

Run: `npx vitest run tests/workflow/worker.test.ts tests/workflow/hands-recovery.test.ts tests/workflow/fix-packet-worker.test.ts`

Expected: FAIL because current renderers accept broad context strings.

- [ ] **Step 3: Replace Hands rendering under the protocol gate**

For `bounded-context-v1`, render exactly one controller-owned JSON package. Keep the existing renderer unchanged for older protocols. Remove run-root and history language from the bounded prompt templates. The model may inspect files in its worktree, but the controller supplies no run-history path.

Before the first attempt for an item/revision, persist `context_base_commit`. Every later fix for that item/revision diffs from the same base so Verifier sees the complete item change, not only the latest edit.

- [ ] **Step 4: Verify GREEN**

Run: `npx vitest run tests/workflow/worker.test.ts tests/workflow/hands-recovery.test.ts tests/workflow/fix-packet-worker.test.ts tests/workflow/runtime-local.test.ts`

Expected: PASS for both bounded and legacy prompt fixtures.

- [ ] **Step 5: Commit**

```bash
git add src/workflow/worker.ts src/workflow/hands-recovery.ts src/workflow/runtime.ts prompts/hands-work-item-v2.md prompts/hands-fix-packet-v1.md prompts/hands-recovery-v2.md tests/workflow/worker.test.ts tests/workflow/hands-recovery.test.ts tests/workflow/fix-packet-worker.test.ts tests/workflow/runtime-local.test.ts
git commit -m "feat: bound Hands context"
```

### Task 10: Give Verifier Only Its Acceptance and Evidence Package

**Files:**
- Modify: `src/workflow/verifier.ts`
- Modify: `src/workflow/runtime.ts`
- Modify: `prompts/verifier-review-v2.md`
- Modify: `tests/workflow/verifier.test.ts`
- Modify: `tests/workflow/runtime-local.test.ts`
- Modify: `tests/workflow/runtime-github.test.ts`

**Interfaces:**
- Replaces `priorVerification` and recursive artifact reads with `contextRef` plus validated `VerifierContextV1`.
- Requires exact required acceptance IDs when a bounded-protocol review returns `approve`.

- [ ] **Step 1: Add failing Verifier-scope tests**

Assert prompts contain the acceptance contract, controller-observed changed files, normalized command statuses/refs, browser/artifact checks, current active findings, and terminal evidence-index ref when final. Assert they omit prior raw verification arrays, run/evidence roots, unrelated stdout, and arbitrary worktree artifacts.

- [ ] **Step 2: Verify RED**

Run: `npx vitest run tests/workflow/verifier.test.ts tests/workflow/runtime-local.test.ts tests/workflow/runtime-github.test.ts`

Expected: FAIL because `buildArtifactsContext` recursively reads prior evidence.

- [ ] **Step 3: Replace bounded Verifier rendering**

Delete `readContextFile` and `buildArtifactsContext` only after the legacy renderer is isolated. Under `bounded-context-v1`, pass the complete package JSON and no run-root placeholders. For work-item review, `evidence_index_ref` is `null`; for `final_integrated` and `post_pr`, it is required and phase-matched.

On an approving review, compare `review.acceptance_coverage` as an exact set to `workItem.completion_contract.required_acceptance_ids`. A request-changes/blocked/replan review may report a subset.

- [ ] **Step 4: Verify GREEN**

Run: `npx vitest run tests/workflow/verifier.test.ts tests/workflow/runtime-local.test.ts tests/workflow/runtime-github.test.ts`

Expected: PASS; final Verifier invocation spies receive only a phase-matching package.

- [ ] **Step 5: Commit**

```bash
git add src/workflow/verifier.ts src/workflow/runtime.ts prompts/verifier-review-v2.md tests/workflow/verifier.test.ts tests/workflow/runtime-local.test.ts tests/workflow/runtime-github.test.ts
git commit -m "feat: bound Verifier context"
```

### Task 11: Replace Reflection Ledger Scans with a Terminal Package

**Files:**
- Modify: `src/workflow/reflection.ts`
- Modify: `prompts/reflection-v2.md`
- Modify: `prompts/reflection-synthesis-v2.md`
- Modify: `tests/workflow/reflection.test.ts`

**Interfaces:**
- Bounded reflection consumes `contexts/reflection/final.json`.
- `process_metrics` includes retry counts, review accounting, summarized budget usage, terminal disposition, and delivery identifiers; it excludes raw event lines and raw prompt/response bodies.

- [ ] **Step 1: Add failing reflection non-leakage tests**

Create a large ledger with secrets in old prompt/response fixtures and repeated events. Assert bounded account/synthesis prompts contain the terminal index and compact metrics but none of the seeded raw history. Assert legacy protocol still uses the current recovery-compatible path.

- [ ] **Step 2: Verify RED**

Run: `npx vitest run tests/workflow/reflection.test.ts`

Expected: FAIL because `runLedgerContext` recursively scans the run directory.

- [ ] **Step 3: Add protocol-discriminated rendering**

For bounded runs, reload `reflection_index_path`, build/persist the reflection role package once, and use the same immutable package for Brain account, Hands account, and synthesis. Do not rebuild context between calls. Leave standalone `reflection --update-from-reflection` unchanged because it is not reflecting a run ledger.

- [ ] **Step 4: Verify GREEN**

Run: `npx vitest run tests/workflow/reflection.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/workflow/reflection.ts prompts/reflection-v2.md prompts/reflection-synthesis-v2.md tests/workflow/reflection.test.ts
git commit -m "feat: bound terminal reflection context"
```

### Task 12: Define the Pure Resource-Budget Model and Versioned Configuration

**Files:**
- Create: `src/core/resource-budget.ts`
- Create: `tests/core/resource-budget.test.ts`
- Modify: `src/core/config.ts`
- Modify: `src/core/types.ts`
- Modify: `src/core/schema.ts`
- Modify: `src/core/run-configuration.ts`
- Modify: `tests/core/config.test.ts`
- Modify: `tests/core/run-configuration.test.ts`
- Modify: `docs/example-config.yaml`

**Interfaces:**
- Produces `resourceBudgetPolicyV1Schema`, `resourceBudgetClaimV1Schema`, `resourceBudgetCompletionV1Schema`, `reduceResourceBudgetArtifacts`, `ResourceBudgetPort`, and `ResourceBudgetExceededError`.
- Keeps persisted run-configuration v1 readable; new run configurations use version 2 with `workflow_protocol` and `resource_budget`.

- [ ] **Step 1: Write failing pure accounting tests**

Cover each dimension, same-key idempotency, conflicting same-key claim, safe-integer overflow, completed actual elapsed, open reserved elapsed, token overshoot, unknown token accounting, and zero external-effect limit.

- [ ] **Step 2: Verify RED**

Run: `npx vitest run tests/core/resource-budget.test.ts tests/core/config.test.ts tests/core/run-configuration.test.ts`

Expected: FAIL because budget schemas and run-configuration v2 do not exist.

- [ ] **Step 3: Implement strict policy and accounting**

Use claim kinds `model_invocation`, `workflow_attempt`, `verification_command`, and `external_effect`. Every claim contains `claim_id`, `run_id`, `kind`, `key`, `reserved_at`, and `elapsed_reservation_ms`. Only model, verification, and external-effect claims reserve elapsed time.

Every completion contains `claim_id`, `completed_at`, `outcome: "succeeded" | "failed" | "reconciled"`, `duration_ms`, `process_started`, `turn_started`, `structured_terminal_error`, `token_usage`, and optional safe result reference. Model accounting is recorded when usage validates, proven zero only when the process never started or when a structured terminal error arrived before `turn.started`, and uncertain when a turn started without valid terminal usage.

Represent persisted run configuration as a union:

```ts
export const resolvedRunConfigurationSchema = z.discriminatedUnion("version", [
  resolvedRunConfigurationV1Schema,
  resolvedRunConfigurationV2Schema,
]);
```

Do not add CLI budget overrides in this feature. Repository configuration supplies defaults; the resolved policy is snapshotted per run.

- [ ] **Step 4: Verify GREEN**

Run: `npx vitest run tests/core/resource-budget.test.ts tests/core/config.test.ts tests/core/run-configuration.test.ts tests/core/schema.test.ts`

Expected: PASS, including parsing an existing version-1 `run-configuration.json`.

- [ ] **Step 5: Commit**

```bash
git add src/core/resource-budget.ts src/core/config.ts src/core/types.ts src/core/schema.ts src/core/run-configuration.ts tests/core/resource-budget.test.ts tests/core/config.test.ts tests/core/run-configuration.test.ts docs/example-config.yaml
git commit -m "feat: define run resource budgets"
```

### Task 13: Persist Budget Claims and Completions Under the Ledger Lock

**Files:**
- Create: `src/workflow/resource-budget.ts`
- Create: `tests/workflow/resource-budget.test.ts`
- Modify: `src/core/ledger.ts`
- Modify: `tests/core/ledger.test.ts`

**Interfaces:**
- Produces `openResourceBudget(runDir): Promise<ResourceBudgetController>`.
- Produces `initializeResourceBudgetPolicy(runDir, policy): Promise<ArtifactRefV1>` for bounded test fixtures and new-ledger creation.
- `ResourceBudgetController` implements the `ResourceBudgetPort` interface exported by `src/core/resource-budget.ts`, keeping adapters independent from workflow modules.
- Controller methods: `usage()`, `claim(input)`, `complete(input)`, `runWorkflowAttempt(key, action)`, `remainingActiveElapsedMs()`.
- Claim ID is SHA-256 of canonical `{run_id, kind, key}`.

- [ ] **Step 1: Write failing persistence/concurrency tests**

Cover two concurrent identical claims producing one file/unit, conflicting claim bytes, completion without claim, duplicate completion, crash-open elapsed reservation, pre-turn structured usage-limit failure with proven zero usage, started turn with missing usage, and no invocation after accounting becomes uncertain.

- [ ] **Step 2: Verify RED**

Run: `npx vitest run tests/workflow/resource-budget.test.ts tests/core/ledger.test.ts`

Expected: FAIL because the controller does not exist.

- [ ] **Step 3: Implement locked claim/complete operations**

`initializeResourceBudgetPolicy` writes `budgets/policy.json` create-once and stores the same strict snapshot in `manifest.resource_budget_policy`. A mismatch between file and manifest is an authoritative corruption blocker. Once Task 13 lands, bounded manifests require both; legacy manifests require neither.

Inside `withRunLedgerTransaction`:

1. Load `budgets/policy.json` and all strict claims/completions.
2. Reduce current usage.
3. Reject a new key when its prospective count or reservation exceeds a limit, or token accounting is uncertain.
4. Write the claim create-once.
5. On completion, validate identity and duration not exceeding the reservation, then write completion create-once.

An identical existing claim is returned. An open claim is not automatically converted from logs. Its reserved elapsed remains charged. A started model claim without a validated usage completion blocks future chargeable work; surface an exact recovery blocker rather than treating it as zero.

- [ ] **Step 4: Verify GREEN**

Run: `npx vitest run tests/workflow/resource-budget.test.ts tests/core/ledger.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/workflow/resource-budget.ts src/core/ledger.ts tests/workflow/resource-budget.test.ts tests/core/ledger.test.ts
git commit -m "feat: persist authoritative budget claims"
```

### Task 14: Return Strict Codex Usage and Duration Without Depending on Progress

**Files:**
- Modify: `src/progress/codex.ts`
- Modify: `src/adapters/codex.ts`
- Modify: `tests/progress/codex.test.ts`
- Modify: `tests/adapters/codex.test.ts`

**Interfaces:**
- Adds `TokenUsage` strict type/schema.
- Adds `usage: TokenUsage | null`, `durationMs`, `processStarted`, `turnStarted`, and `structuredTerminalError` to `CodexInvokeResult`.
- Adds the same metrics to `CodexInvocationError`.
- Structured invocations always use `--json`; the progress reporter remains optional.

- [ ] **Step 1: Write failing adapter tests**

Feed valid `turn.completed`, malformed usage after `turn.started`, structured error before `turn.started`, nonzero exit, pre-spawn validation failure, and invocation without a progress reporter. Assert valid usage is returned exactly, the pre-turn terminal error is distinguishable, and malformed values are `null`, never coerced to zero.

- [ ] **Step 2: Verify RED**

Run: `npx vitest run tests/progress/codex.test.ts tests/adapters/codex.test.ts`

Expected: FAIL because `usage()` is currently observational and malformed counters become zero.

- [ ] **Step 3: Separate parsing from emission**

Change the consumer API to:

```ts
export interface CodexEventConsumer {
  write(chunk: string): Promise<void>;
  end(): Promise<void>;
  terminalUsage(): TokenUsage | null;
  turnStarted(): boolean;
  structuredTerminalError(): boolean;
  warningCount(): number;
}
```

The consumer always parses structured stdout. It emits safe progress only when a reporter exists. It retains the last valid terminal usage record, whether `turn.started` occurred, and whether a structured terminal error occurred. Measure duration around `runCommand`; set `processStarted` from `onStarted`. Preserve all metrics when throwing for exit, missing output, or output validation.

Dry-run structured calls return zero token counters, zero duration, `processStarted: false`, `turnStarted: false`, and `structuredTerminalError: false` because no external model process ran.

- [ ] **Step 4: Verify GREEN**

Run: `npx vitest run tests/progress/codex.test.ts tests/adapters/codex.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/progress/codex.ts src/adapters/codex.ts tests/progress/codex.test.ts tests/adapters/codex.test.ts
git commit -m "feat: return authoritative Codex usage"
```

### Task 15: Budget Model Invocations and Logical Workflow Attempts

**Files:**
- Modify: `src/adapters/codex.ts`
- Modify: `src/workflow/discovery.ts`
- Modify: `src/workflow/planner.ts`
- Modify: `src/workflow/plan-repair.ts`
- Modify: `src/workflow/replan.ts`
- Modify: `src/workflow/worker.ts`
- Modify: `src/workflow/self-review.ts`
- Modify: `src/workflow/action-verifier.ts`
- Modify: `src/workflow/fix-packets.ts`
- Modify: `src/workflow/verifier.ts`
- Modify: `src/workflow/reflection.ts`
- Modify: `src/workflow/runtime.ts`
- Modify: `src/cli.ts`
- Modify: `tests/workflow/discovery.test.ts`
- Modify: `tests/workflow/planner.test.ts`
- Modify: `tests/workflow/plan-repair.test.ts`
- Modify: `tests/workflow/replan.test.ts`
- Modify: `tests/workflow/worker.test.ts`
- Modify: `tests/workflow/self-review.test.ts`
- Modify: `tests/workflow/action-verifier.test.ts`
- Modify: `tests/workflow/fix-packets.test.ts`
- Modify: `tests/workflow/verifier.test.ts`
- Modify: `tests/workflow/reflection.test.ts`
- Modify: `tests/workflow/runtime-local.test.ts`
- Modify: `tests/workflow/runtime-github.test.ts`
- Modify: `tests/cli-smoke.test.ts`

**Interfaces:**
- Adds `budget?: ResourceBudgetPort` and `attemptKey?: string` to `CodexInvokeInput`.
- Every actual call gets a unique invocation key derived from its immutable artifact name.
- Logical attempt claims deduplicate multiple calls belonging to the same attempt.

- [ ] **Step 1: Add failing call-inventory tests**

Test every bounded-v2 `codex.invoke` call site. Assert two invocations in one Hands mutation consume two invocation units and one workflow-attempt unit. Reflection consumes invocation/token/time but no workflow-attempt unit. Standalone improvement-plan analysis has no run budget. `implementer.ts`, `reviewer.ts`, and `orchestrator.ts` remain explicit legacy-protocol exemptions because old runs do not acquire a retroactive budget.

- [ ] **Step 2: Verify RED**

Run: `npx vitest run tests/workflow/discovery.test.ts tests/workflow/planner.test.ts tests/workflow/plan-repair.test.ts tests/workflow/replan.test.ts tests/workflow/worker.test.ts tests/workflow/self-review.test.ts tests/workflow/action-verifier.test.ts tests/workflow/fix-packets.test.ts tests/workflow/verifier.test.ts tests/workflow/reflection.test.ts tests/workflow/runtime-local.test.ts tests/workflow/runtime-github.test.ts tests/cli-smoke.test.ts`

Expected: FAIL on missing budget coordinates.

- [ ] **Step 3: Attach exact stable attempt keys**

Use these namespaces:

```text
brain:discovery:<cycle>:<sequence>
brain:plan:<lineage>:full:<ordinal>
brain:plan:<lineage>:repair:<ordinal>
brain:replan:<plan-revision>:<work-item>:<ordinal>
hands:<plan-revision>:<work-item>:<attempt>:<attempt-kind>
verifier:<plan-revision>:<work-item>:<phase>:<attempt>
hands-self-review:<plan-revision>:<work-item>:<attempt>:<pass>
focused-verifier:<plan-revision>:<work-item>:<review-revision>:<action-id>:<action-attempt>
```

Each invocation claims `model_invocation` before calling the base adapter with an elapsed reservation clamped to remaining active time. If `attemptKey` exists, claim `workflow_attempt` once. Complete invocation claims on success and every thrown `CodexInvocationError` using its metrics. If budget validation fails, do not call the base adapter.

At each CLI boundary, read the manifest protocol. Open and pass the authoritative controller only for `bounded-context-v1`; pass no budget to legacy protocols. Runtime opens one controller per execution/resume call and passes the same port through Hands, verification, Verifier, final review, and reflection callbacks.

- [ ] **Step 4: Verify GREEN**

Run the Step 2 command again.

Expected: PASS, and `rg -n "codex\.invoke\(" src/workflow` shows every bounded-v2 call passes budget coordinates; the only unbudgeted matches are the named legacy modules and standalone improvement-plan path.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/codex.ts src/workflow/discovery.ts src/workflow/planner.ts src/workflow/plan-repair.ts src/workflow/replan.ts src/workflow/worker.ts src/workflow/self-review.ts src/workflow/action-verifier.ts src/workflow/fix-packets.ts src/workflow/verifier.ts src/workflow/reflection.ts src/workflow/runtime.ts src/cli.ts tests/workflow/discovery.test.ts tests/workflow/planner.test.ts tests/workflow/plan-repair.test.ts tests/workflow/replan.test.ts tests/workflow/worker.test.ts tests/workflow/self-review.test.ts tests/workflow/action-verifier.test.ts tests/workflow/fix-packets.test.ts tests/workflow/verifier.test.ts tests/workflow/reflection.test.ts tests/workflow/runtime-local.test.ts tests/workflow/runtime-github.test.ts tests/cli-smoke.test.ts
git commit -m "feat: budget model workflow attempts"
```

### Task 16: Budget Verification Elapsed Time and Existing External Effects

**Files:**
- Modify: `src/verification/runner.ts`
- Modify: `src/workflow/github-issue-reconciliation.ts`
- Modify: `src/workflow/github-status.ts`
- Modify: `src/github/status-sync.ts`
- Modify: `src/github/issue-reconciliation.ts`
- Modify: `src/workflow/runtime.ts`
- Modify: `tests/verification/runner.test.ts`
- Modify: `tests/workflow/github-issue-reconciliation.test.ts`
- Modify: `tests/workflow/github-status.test.ts`
- Modify: `tests/workflow/runtime-github.test.ts`

**Interfaces:**
- Adds `budget?: ResourceBudgetPort` and optional `commandIds?: readonly string[]` to `RunVerificationInput`.
- Existing reconciliation operations claim external effects when they first persist a new mutation intent.
- Git push key is `git-push:<remote>:<branch>:<expected-sha>`.

- [ ] **Step 1: Write failing boundary tests**

Verification tests cover timeout clamping, failed/timed-out command actual duration, open reservation after simulated crash, and no subprocess when elapsed budget is exhausted. GitHub tests prove lookup/no-op/replay costs zero, create/update/status/PR-body/close each cost one new unit, and ambiguous-after-error reconciliation reuses the same claim. Push tests prove read-back recovery does not double-charge.

- [ ] **Step 2: Verify RED**

Run: `npx vitest run tests/verification/runner.test.ts tests/workflow/github-issue-reconciliation.test.ts tests/workflow/github-status.test.ts tests/workflow/runtime-github.test.ts`

Expected: FAIL because these boundaries are not budget-aware.

- [ ] **Step 3: Charge verification commands**

Before each command, claim key `verification:<scope>:<work-item>:<attempt>:<command-id-or-index>` with reservation `min(15 minutes, remaining active elapsed)`. Pass that reservation to `runCommand.timeoutMs`. Complete with actual duration for pass, fail, timeout, or spawn error.

- [ ] **Step 4: Charge existing durable external-effect intents**

Do not decorate `GitHubAdapter`. Integrate the budget controller at these points:

- `reconcileIssueMutation`: after determining create/update and before persisting its pending operation.
- `syncGitHubIssueStatus` and `syncGitHubDeliveryEvent`: before a new comment/label/event mutation, keyed by target and desired projection/event hash.
- `reconcileGitHubPullRequestLinksUnlocked` and issue close operations: when `recordIntent` creates/rearms a pending operation.
- `openOrRecoverIntegratedPullRequest`: charge only when no matching PR exists and a new PR will be opened.
- Runtime push branches: claim before push intent/invocation, then complete after remote SHA read-back. Reconciliation of the same expected SHA reuses the claim.

Read-only lookups, already-matching projections, local commits, and controller ledger writes are not external effects.

- [ ] **Step 5: Verify GREEN**

Run the Step 2 command again.

Expected: PASS; exhausted budget prevents any new subprocess or remote mutation but permits read-only reconciliation.

- [ ] **Step 6: Commit**

```bash
git add src/verification/runner.ts src/workflow/github-issue-reconciliation.ts src/workflow/github-status.ts src/github/status-sync.ts src/github/issue-reconciliation.ts src/workflow/runtime.ts tests/verification/runner.test.ts tests/workflow/github-issue-reconciliation.test.ts tests/workflow/github-status.test.ts tests/workflow/runtime-github.test.ts
git commit -m "feat: budget verification and external effects"
```

### Task 17: Coalesce Human Progress Views and Deduplicate Warnings

**Files:**
- Create: `src/progress/view.ts`
- Create: `tests/progress/view.test.ts`
- Modify: `src/progress/codex.ts`
- Modify: `src/progress/log.ts`
- Modify: `src/cli.ts`
- Modify: `tests/progress/codex.test.ts`
- Modify: `tests/progress/log.test.ts`
- Modify: `tests/cli-smoke.test.ts`

**Interfaces:**
- Produces `createProgressViewReducer({ emit }): ProgressViewReducer` with `push(event)` and `flush()`.
- Produces synthetic human-view rows only; it never writes them to `progress.jsonl`.
- JSON logs remain one validated event per durable record.

- [ ] **Step 1: Write failing reducer tests**

Cover one heartbeat, 100 consecutive heartbeats for one invocation, interleaved invocation IDs, heartbeat flush before a state transition, final flush at quiescence, identical progress warnings, distinct warning fingerprints, and follow mode receiving events incrementally.

Expected compact text for a run of heartbeats:

```text
2026-07-16 20:05:00 UTC  Hands still running (5 heartbeats, last activity 2026-07-16 20:05:00 UTC)
```

- [ ] **Step 2: Verify RED**

Run: `npx vitest run tests/progress/view.test.ts tests/progress/codex.test.ts tests/progress/log.test.ts tests/cli-smoke.test.ts`

Expected: FAIL because human replay/follow prints every heartbeat.

- [ ] **Step 3: Implement presentation-only coalescing**

Group consecutive heartbeats by `{workerSessionId, modelInvocationId, source, workItem}`. Flush the group before any non-heartbeat event, when the key changes, and when follow exits. For identical warnings, dedupe by `{source, modelInvocationId, warningKind}` and retain a count in the human row.

In the Codex event consumer, emit at most one unreadable/oversized warning per invocation and warning kind. `openProgressReporter.warnOnce` remains the per-reporter guard for an unreadable progress path. Do not use one global boolean that suppresses distinct failures from different runs.

- [ ] **Step 4: Wire CLI behavior**

- Plain `brain-hands logs` and `logs --follow`: pass events through the view reducer.
- Producing commands with `--follow`: use the same reducer and flush in `finally`.
- `logs --json`: preserve the current full validated event array/stream.
- `status`: keep using `summarizeProgressActivity`, which already reports latest state rather than history.

- [ ] **Step 5: Verify GREEN**

Run the Step 2 command again.

Expected: PASS; raw `progress.jsonl` line count is unchanged while plain output is compact.

- [ ] **Step 6: Commit**

```bash
git add src/progress/view.ts src/progress/codex.ts src/progress/log.ts src/cli.ts tests/progress/view.test.ts tests/progress/codex.test.ts tests/progress/log.test.ts tests/cli-smoke.test.ts
git commit -m "feat: compact operator progress views"
```

### Task 18: Expose Budgets, Activate the Protocol, Document, and Prove Both Paths

**Files:**
- Modify: `src/workflow/status.ts`
- Modify: `src/core/run-configuration.ts`
- Modify: `src/core/ledger.ts`
- Modify: `src/cli.ts`
- Modify: `tests/workflow/status.test.ts`
- Modify: `tests/core/run-configuration.test.ts`
- Modify: `tests/cli-smoke.test.ts`
- Modify: `tests/workflow/e2e-dry-run.test.ts`
- Modify: `tests/fixtures/legacy-run.ts`
- Modify: `README.md`
- Modify: `agentic-codex-workflow.md`
- Modify: `.agents/skills/brain-hands/SKILL.md`
- Modify: `docs/example-config.yaml`

**Interfaces:**
- Status JSON exposes `resource_budget: { policy, usage, remaining, token_accounting, token_budget_overshot_by } | null`.
- Human status prints all five `used/limit/remaining` values and uncertainty/overshoot.
- `createRunLedgerV2` selects `bounded-context-v1` only after this task's compatibility checks pass.

- [ ] **Step 1: Add failing status and compatibility tests**

Test legacy runs with no budget artifacts, durable-discovery runs with existing run-configuration v1, bounded runs with complete usage, token overshoot, uncertain accounting, and exhausted external effects. Add E2E assertions for summary/index/context/budget paths.

- [ ] **Step 2: Verify RED**

Run: `npx vitest run tests/workflow/status.test.ts tests/core/run-configuration.test.ts tests/cli-smoke.test.ts tests/workflow/e2e-dry-run.test.ts`

Expected: FAIL on missing budget projection and bounded default.

- [ ] **Step 3: Render operator-visible limits and usage**

Add proposed policy values to preview and resolved configuration. Status reads budget usage independently from observational session telemetry. A malformed authoritative budget artifact makes bounded status operationally blocked; it is not hidden as unavailable telemetry.

- [ ] **Step 4: Update documentation and skill contract**

Document:

- exact role inputs and byte caps;
- full evidence retention versus compact model inputs;
- summary and phase-index paths;
- five budget dimensions and crash/unknown-usage behavior;
- compact human progress versus lossless JSON progress;
- unchanged explicit approvals, terminal assurance outcomes, and no automatic merge;
- old-run resume behavior.

- [ ] **Step 5: Activate new-run selection**

After focused compatibility tests are green, change only the new-ledger default from `durable-discovery-v1` to `bounded-context-v1`. Extend `CreateRunLedgerV2Input` with the resolved resource policy, write `budgets/policy.json` during ledger creation, and snapshot the identical value in the manifest. The CLI passes the policy from resolved repository configuration. Never rewrite a persisted protocol value. Keep schema defaulting a missing old manifest protocol to `legacy-v2`.

- [ ] **Step 6: Run all focused suites**

Run:

```bash
npx vitest run \
  tests/core/context-contracts.test.ts \
  tests/workflow/work-item-summaries.test.ts \
  tests/workflow/evidence-index.test.ts \
  tests/workflow/role-context.test.ts \
  tests/core/resource-budget.test.ts \
  tests/workflow/resource-budget.test.ts \
  tests/adapters/codex.test.ts \
  tests/progress/codex.test.ts \
  tests/progress/view.test.ts \
  tests/progress/log.test.ts \
  tests/verification/runner.test.ts \
  tests/workflow/runtime-local.test.ts \
  tests/workflow/runtime-github.test.ts \
  tests/workflow/assurance.test.ts \
  tests/workflow/reflection.test.ts \
  tests/workflow/status.test.ts \
  tests/cli-smoke.test.ts \
  tests/workflow/e2e-dry-run.test.ts
```

Expected: PASS.

- [ ] **Step 7: Run repository release gates**

Run, in order:

```bash
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

Expected: all exit 0. Pack output remains limited to `dist/`, `prompts/`, `agentic-codex-workflow.md`, `README.md`, and package metadata.

- [ ] **Step 8: Run compiled lifecycle proof**

Use a temporary initialized fixture repository and `node dist/cli.js`, not the stable npm command and not `npm link`:

1. Create a local dry-run through discovery and plan approval.
2. Resume through all work items and terminal verification.
3. Assert every approved item has a summary, final Verifier has the correct phase index, reflection has its terminal index, and budget usage is nonnegative and within limits except permitted final-call token overshoot.
4. Replay plain logs and assert heartbeat groups are compact.
5. Replay JSON logs and assert all original heartbeat events remain.
6. Run one frozen legacy fixture and prove it resumes without requiring summaries or budgets.

- [ ] **Step 9: Commit**

```bash
git add src/workflow/status.ts src/core/run-configuration.ts src/core/ledger.ts src/cli.ts tests/workflow/status.test.ts tests/core/run-configuration.test.ts tests/cli-smoke.test.ts tests/workflow/e2e-dry-run.test.ts tests/fixtures/legacy-run.ts README.md agentic-codex-workflow.md .agents/skills/brain-hands/SKILL.md docs/example-config.yaml
git commit -m "feat: activate bounded workflow governance"
```

## Final Acceptance Checklist

- [ ] Hands prompts contain only the exact work-item spec, current scoped diff, active prior finding(s), dependency summaries, and explicitly bounded evidence.
- [ ] Verifier prompts contain only the acceptance contract, controller-observed changed files/diff, normalized command/artifact/browser evidence, active findings, and the required terminal index when final.
- [ ] Every approved plan work item, excluding synthetic `integrated`, has one current immutable summary whose source hashes validate.
- [ ] Final-integrated and post-PR Verifier passes use distinct immutable indexes.
- [ ] Reflection uses a terminal index and one immutable bounded package; it does not recursively scan the run ledger.
- [ ] Raw progress and workflow evidence remain unchanged; plain human output coalesces heartbeat/warning runs.
- [ ] Model invocation, logical attempt, token, active elapsed, and external-effect usage are authoritative, idempotent, and shown in preview/status.
- [ ] Missing usage after `turn.started` blocks future chargeable work; a structured pre-turn terminal error is recorded as proven zero and may follow existing backup policy.
- [ ] GitHub/push retries reuse existing reconciliation identities and do not consume duplicate external-effect units.
- [ ] Legacy protocols resume under their original rules.
- [ ] Typecheck, full tests, build, dry pack, compiled bounded lifecycle, and compiled legacy resume all pass.

## Self-Review Checklist

- [ ] Map every original priority bullet to at least one task and acceptance check.
- [ ] Run the writing-plans placeholder-pattern scan and remove every match.
- [ ] Verify all paths and symbol names used by later tasks are introduced by an earlier task.
- [ ] Verify `integrated` is excluded from summary requirements everywhere.
- [ ] Verify `final_integrated`, `post_pr`, and `reflection` phase names and paths are consistent.
- [ ] Verify no budget rule reads `progress.jsonl`, `session-state.json`, or human-rendered output as authority.
- [ ] Verify external-effect accounting is integrated with existing reconciliation rather than a generic adapter wrapper.
- [ ] Verify activation remains the final code change after compatibility proof.

## Execution Handoff

Because repository instructions prohibit subagents unless the user explicitly asks for them, execute this plan inline with `superpowers:executing-plans`, one task and reviewer gate at a time. Stop before Task 18 protocol activation if the proposed default limits have not been accepted.
