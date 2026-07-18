# Bounded Context and Resource Governance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Do not use subagents unless the user explicitly requests them. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each Brain Hands role a small, deterministic evidence package; compact completed work into immutable summaries; enforce authoritative per-run resource budgets; and remove repeated heartbeat/warning noise from the operator view without weakening the durable audit trail.

**Architecture:** The workflow keeps its full immutable evidence and authoritative `events.jsonl`, but introduces versioned work-item summaries and phase-specific evidence indexes that model-facing context builders consume. Resource budgets use immutable claim/completion artifacts under the run-ledger lock, never the fail-open progress subsystem. `progress.jsonl` remains append-only and safe; a presentation reducer coalesces heartbeats and identical warnings for `--follow`, replay, and status.

**Tech Stack:** TypeScript 6, Node.js 20+, Zod 4, Commander 15, Execa 9, Vitest 4, Git, GitHub CLI.

## Global Constraints

- Work on `main`; do not create a feature branch unless the user changes the instruction.
- Preserve unrelated worktree changes and touch only files listed by the active task.
- Do not delete or rewrite detailed implementation, verification, review, finding, prompt, response, or event artifacts.
- `events.jsonl` remains authoritative workflow history; `progress.jsonl` remains observational safe telemetry.
- Context compaction is a projection, never a replacement for evidence or approval provenance.
- Every generated summary, evidence index, context manifest, budget claim, and budget completion is strict canonical JSON written create-once.
- Context builders must use controller-observed Git state and validated evidence, never model claims alone.
- Required context that exceeds a hard cap blocks the invocation. Optional evidence may be omitted only with an explicit omitted-reference record.
- Budget exhaustion blocks new chargeable work but never removes evidence, rolls back completed work, or converts a blocked result into approval.
- Active elapsed time counts model invocations, deterministic verification commands, push operations, and GitHub mutations; it excludes operator approval waits and controller bookkeeping.
- Token usage is `input_tokens + output_tokens`; cached-input and reasoning-output counters remain visible but are not added a second time.
- A completed model call may cross the token ceiling because Codex reports usage at turn completion. The next chargeable action must then fail closed.
- External-effect claims are consumed when the effect is reserved. Retrying the same idempotency key does not consume another unit.
- Existing `durable-discovery-v1` runs resume under their original contract. New runs use `bounded-context-v1` and require summaries, indexes, and budgets.
- Do not add runtime dependencies.

## Updated Approach and Corrections to the Earlier Plan

1. **Version summaries by plan and attempt.** A fixed `summary.json` cannot survive a narrow replan that reopens the same work item. Use `summaries/work-items/<id>/plan-<P>-attempt-<A>.json` and retain every prior summary.
2. **Use phase-specific evidence indexes.** Final Verifier and reflection need different snapshots. Use immutable `evidence-indexes/final-verifier/attempt-<A>.json` and `evidence-indexes/reflection.json`; do not mutate one top-level index.
3. **Keep indexes non-authoritative.** The index points to validated evidence and hashes it. It does not satisfy acceptance criteria by itself.
4. **Do not use session telemetry for budgets.** `session-state.json` is deliberately fail-open. Budget claims/completions live under the authoritative run ledger.
5. **Decouple token accounting from live progress.** Structured Codex JSON must be consumed internally even when `--follow` is off; otherwise token budgets silently disappear when no reporter is attached.
6. **Define attempt semantics separately from invocation semantics.** A transport retry is a new invocation but the same workflow attempt. Reflection consumes invocation/token/time budget but not workflow-attempt budget.
7. **Bound context with deterministic selection, not string slicing.** Include whole required sections first, rank optional artifacts, and record omissions. Never cut JSON or patches at an arbitrary byte boundary.
8. **Coalesce the operator view, not the durable telemetry file.** Preserve safe append-only heartbeat records for compatibility and recovery. Collapse them only in replay/follow rendering.
9. **Count external effects at their shared boundary.** Decorate GitHub mutations and explicitly wrap Git push; do not scatter ad hoc counters through every workflow branch.
10. **Gate new behavior by protocol version.** Do not attempt an in-place migration of active legacy runs whose earlier work items have no summary or budget claims.
11. **Keep budget state out of evidence indexes.** Budgets are authoritative operator controls, not acceptance evidence. Expose them in preview/status instead of coupling Tasks 1–6 to the accounting engine.

## Protocol Constants

Use these fixed v1 constants rather than adding context-size configuration:

```ts
export const CONTEXT_LIMITS_V1 = {
  hands_total_bytes: 64 * 1024,
  hands_diff_bytes: 32 * 1024,
  hands_evidence_bytes: 16 * 1024,
  verifier_total_bytes: 64 * 1024,
  verifier_diff_bytes: 24 * 1024,
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

At plan approval, read authoritative usage and reject a plan when `used_workflow_attempts + minimum_remaining_attempts` exceeds `max_workflow_attempts`. The minimum remaining count is one initial Hands attempt and one Verifier attempt per incomplete work item, plus one final-Verifier attempt.

## File Structure

**Create**

- `src/core/context-artifacts.ts` — strict summary, evidence-index, artifact-reference, context-manifest schemas; canonical JSON and SHA-256 helpers; fixed context caps.
- `src/workflow/context-artifacts.ts` — build, persist, reload, and validate work-item summaries, phase indexes, relevant diffs, and role context manifests.
- `tests/core/context-artifacts.test.ts` — strict schema, canonical hash, identity, ordering, and cap tests.
- `tests/workflow/context-artifacts.test.ts` — summary/index persistence, stale provenance, deterministic omission, and resume tests.
- `src/core/resource-budget.ts` — strict budget policy/claim/completion schemas, usage reduction, exhaustion decisions, and typed errors.
- `src/workflow/resource-budget.ts` — ledger-locked claim/completion persistence and chargeable-action helper.
- `src/adapters/budgeted-github.ts` — explicit decorator for every mutating `GitHubAdapter` method; read methods pass through unchanged.
- `src/progress/view.ts` — pure reducer that coalesces heartbeat runs and identical warning runs for operator presentation.
- `tests/core/resource-budget.test.ts` — pure accounting, idempotency, overflow, and exhaustion tests.
- `tests/workflow/resource-budget.test.ts` — persistence, concurrent claim, crash/retry, and protocol-gating tests.
- `tests/adapters/budgeted-github.test.ts` — mutation charging and read-only pass-through tests.
- `tests/progress/view.test.ts` — replay/follow coalescing and flush-boundary tests.

**Modify**

- `src/core/types.ts`, `src/core/schema.ts`, `src/core/config.ts` — protocol, manifest, intake, config, work-item-progress, and budget fields.
- `src/core/ledger.ts` — create summary/index/budget/context directories, protect new immutable roots, and validate completed summary pointers.
- `src/core/run-configuration.ts` — preview and resolved configuration budget display.
- `src/adapters/codex.ts`, `src/progress/codex.ts` — always consume structured events, return authoritative usage/duration, and expose workflow-attempt identity.
- `src/adapters/git.ts` — deterministic scoped diff collection with untracked-file support.
- `src/workflow/worker.ts`, `src/workflow/verifier.ts`, `src/workflow/reflection.ts`, `src/workflow/hands-recovery.ts` — consume context manifests instead of broad history.
- `src/workflow/planner.ts`, `src/workflow/self-review.ts`, `src/workflow/action-verifier.ts`, `src/workflow/plan-repair.ts` — attach stable workflow-attempt keys to model calls.
- `src/workflow/runtime.ts` — persist summaries, build final indexes, pass context and budget controllers, and budget push effects.
- `src/verification/runner.ts` — charge deterministic command elapsed time and clamp command timeout to remaining active time.
- `src/workflow/assurance.ts` — require the matching final evidence index without treating it as evidence.
- `src/workflow/status.ts`, `src/progress/log.ts`, `src/cli.ts` — resource usage, compact replay/follow output, and warning counts.
- `prompts/hands-work-item-v2.md`, `prompts/hands-recovery-v2.md`, `prompts/verifier-review-v2.md`, `prompts/reflection-v2.md`, `prompts/reflection-synthesis-v2.md` — role-specific compact contracts.
- `tests/workflow/worker.test.ts`, `tests/workflow/verifier.test.ts`, `tests/workflow/reflection.test.ts`, `tests/workflow/runtime-local.test.ts`, `tests/workflow/runtime-github.test.ts`, `tests/workflow/assurance.test.ts`, `tests/verification/runner.test.ts` — integration coverage.
- `tests/adapters/codex.test.ts`, `tests/progress/codex.test.ts`, `tests/progress/log.test.ts`, `tests/cli-smoke.test.ts`, `tests/core/config.test.ts`, `tests/core/run-configuration.test.ts`, `tests/core/ledger.test.ts`, `tests/core/schema.test.ts` — boundary and compatibility coverage.
- `README.md`, `agentic-codex-workflow.md`, `.agents/skills/brain-hands/SKILL.md`, `docs/example-config.yaml` — operator and maintainer contract.

---

### Task 1: Define Versioned Compact Artifact Contracts

**Files:**
- Create: `src/core/context-artifacts.ts`
- Create: `tests/core/context-artifacts.test.ts`
- Modify: `src/core/types.ts`
- Modify: `src/core/schema.ts`

**Interfaces:**
- Produces: `artifactRefSchema`, `workItemSummaryV1Schema`, `evidenceIndexV1Schema`, `roleContextManifestV1Schema`, `roleContextPackageV1Schema`.
- Produces: `canonicalArtifactJson(schema, value)`, `artifactSha256(schema, value)`, `contextArtifactRef(path, schema, value)`.
- Produces: `WorkItemSummaryV1`, `EvidenceIndexV1`, `RoleContextManifestV1`, `RoleContextPackageV1`, `ArtifactRef`.
- Adds: `bounded-context-v1` as a recognized but not-yet-default `WorkflowProtocol`; runtime activation occurs only after Task 10 lifecycle proof.

- [ ] **Step 1: Write failing strict-contract tests**

Create tests for canonical hashes, strict unknown-field rejection, sorted/deduplicated path arrays, final/reflection phase requirements, and a summary that cannot claim a different work-item or plan revision.

```ts
import { describe, expect, it } from "vitest";
import {
  artifactSha256,
  evidenceIndexV1Schema,
  workItemSummaryV1Schema,
} from "../../src/core/context-artifacts.js";

describe("compact context artifacts", () => {
  it("hashes canonical validated JSON", () => {
    const summary = workItemSummaryV1Schema.parse({
      schema_version: 1,
      run_id: "run-1",
      work_item_id: "item-1",
      plan_revision: 2,
      plan_sha256: "a".repeat(64),
      attempt: 3,
      commit_sha: "b".repeat(40),
      implementation_ref: { path: "implementation/item-1/attempt-3.json", sha256: "c".repeat(64) },
      verification_ref: { path: "verification/local/item-1/attempt-3/evidence.json", sha256: "d".repeat(64) },
      review_ref: { path: "reviews/item-1/attempt-3.json", sha256: "e".repeat(64) },
      changed_files: ["src/a.ts"],
      acceptance_coverage: [{ criterion_ref: "BH-001:AC-1", evidence_record_ids: ["command:test"] }],
      resolved_finding_ids: [],
      unresolved_finding_ids: [],
      residual_risks: [],
      created_at: "2026-07-16T12:00:00.000Z",
    });
    expect(artifactSha256(workItemSummaryV1Schema, summary)).toMatch(/^[a-f0-9]{64}$/);
    expect(() => workItemSummaryV1Schema.parse({ ...summary, extra: true })).toThrow();
  });

  it("requires final review only for reflection indexes", () => {
    const base = {
      schema_version: 1,
      run_id: "run-1",
      phase: "reflection" as const,
      attempt: 1,
      approved_plan: { revision: 1, sha256: "a".repeat(64) },
      candidate_commit: "b".repeat(40),
      work_item_summaries: [],
      integrated_verification_ref: { path: "verification/integrated/attempt-1/evidence.json", sha256: "c".repeat(64) },
      integrated_review_ref: null,
      unresolved_finding_ids: [],
      created_at: "2026-07-16T12:00:00.000Z",
    };
    expect(() => evidenceIndexV1Schema.parse(base)).toThrow("reflection index requires integrated review");
  });
});
```

- [ ] **Step 2: Run the tests and verify RED**

Run: `npx vitest run tests/core/context-artifacts.test.ts`

Expected: FAIL because `src/core/context-artifacts.ts` does not exist.

- [ ] **Step 3: Implement the exact schemas and canonical helpers**

Use strict schemas and infer exported TypeScript types from them. Do not duplicate hand-written interfaces in `types.ts`; only add manifest/progress references there.

```ts
const safeRunArtifactPathSchema = z.string().min(1).refine((value) => {
  if (path.posix.isAbsolute(value) || value.includes("\\")) return false;
  const normalized = path.posix.normalize(value);
  return normalized === value && normalized !== "." && !normalized.startsWith("../") && !normalized.includes("/../");
}, "expected a normalized run-relative artifact path");

export const artifactRefSchema = z.object({
  path: safeRunArtifactPathSchema,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export const workItemSummaryV1Schema = z.object({
  schema_version: z.literal(1),
  run_id: z.string().min(1),
  work_item_id: z.string().min(1),
  plan_revision: z.number().int().positive(),
  plan_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  attempt: z.number().int().positive(),
  commit_sha: z.union([z.string().regex(/^[a-f0-9]{40,64}$/), z.literal("no-op")]),
  implementation_ref: artifactRefSchema,
  verification_ref: artifactRefSchema,
  review_ref: artifactRefSchema,
  changed_files: z.array(artifactPathSchema),
  acceptance_coverage: z.array(z.object({
    criterion_ref: z.string().min(1),
    evidence_record_ids: z.array(z.string().min(1)).min(1),
  }).strict()),
  resolved_finding_ids: z.array(z.string().min(1)),
  unresolved_finding_ids: z.array(z.string().min(1)),
  residual_risks: z.array(z.string().min(1)),
  created_at: z.string().datetime(),
}).strict();

export function canonicalArtifactJson<T>(schema: z.ZodType<T>, value: unknown): string {
  return `${JSON.stringify(schema.parse(value), null, 2)}\n`;
}

export function artifactSha256<T>(schema: z.ZodType<T>, value: unknown): string {
  return createHash("sha256").update(canonicalArtifactJson(schema, value), "utf8").digest("hex");
}
```

Define `EvidenceIndexV1.phase` as `final_verifier | reflection`. Require `integrated_review_ref === null` for final-Verifier indexes and non-null for reflection indexes. Define `RoleContextManifestV1.role` as `hands | verifier | reflection`, include `selected_artifacts`, `omitted_artifacts`, `payload_bytes`, and exact scope coordinates. Extend the workflow-protocol schema with `bounded-context-v1`, but keep new-run selection on `durable-discovery-v1` until all bounded-path gates pass in Task 10.

Define `RoleContextPackageV1` as one strict object containing `{ schema_version: 1, manifest, payload }`. Context files persist and hash the complete package, not the manifest independently from its payload.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `npx vitest run tests/core/context-artifacts.test.ts tests/core/schema.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/context-artifacts.ts src/core/types.ts src/core/schema.ts tests/core/context-artifacts.test.ts tests/core/schema.test.ts
git commit -m "feat: define bounded context artifacts"
```

### Task 2: Persist Immutable Work-Item Summaries

**Files:**
- Create: `src/workflow/context-artifacts.ts`
- Create: `tests/workflow/context-artifacts.test.ts`
- Modify: `src/core/ledger.ts`
- Modify: `src/core/types.ts`
- Modify: `src/core/schema.ts`
- Modify: `src/workflow/runtime.ts`
- Modify: `tests/core/ledger.test.ts`
- Modify: `tests/workflow/runtime-local.test.ts`
- Modify: `tests/workflow/runtime-github.test.ts`

**Interfaces:**
- Consumes: approved `BrainPlan`, `WorkItem`, validated `ImplementationResult`, `VerificationEvidence`, `VerifierReview`, manifest finding index, and resulting commit SHA.
- Produces: `persistWorkItemSummary(input): Promise<ArtifactRef>`.
- Produces: `loadWorkItemSummary(runDir, ref, expected): Promise<WorkItemSummaryV1>`.
- Adds: `summary_path?: string`, `summary_sha256?: string` to `WorkItemProgress` and its Zod schema.

- [ ] **Step 1: Write failing summary persistence tests**

Test create-once behavior, plan/attempt versioned paths, artifact hash validation, mismatched commit rejection, and reopening the same item under a later plan revision without overwriting its first summary.

```ts
const summaryInput: PersistWorkItemSummaryInput = {
  runDir: ledger.runDir,
  manifest: approvedManifest,
  workItem,
  attempt: 1,
  commitSha: "a".repeat(40),
  implementationRef,
  verificationRef,
  reviewRef,
  changedFiles: ["src/a.ts"],
  acceptanceCoverage: [{ criterion_ref: "BH-001:AC-1", evidence_record_ids: ["command:test"] }],
  resolvedFindingIds: [],
  unresolvedFindingIds: [],
  residualRisks: [],
  createdAt: "2026-07-16T12:00:00.000Z",
};
const first = await persistWorkItemSummary(summaryInput);
expect(first.path).toBe("summaries/work-items/aXRlbS0x/plan-1-attempt-1.json");

await expect(persistWorkItemSummary({
  ...summaryInput,
  createdAt: "2026-07-16T12:00:01.000Z",
})).rejects.toThrow("immutable work-item summary already exists");
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npx vitest run tests/workflow/context-artifacts.test.ts tests/core/ledger.test.ts`

Expected: FAIL on missing persistence functions and summary fields.

- [ ] **Step 3: Implement summary path, hashing, and provenance validation**

Use base64url work-item IDs, current approved plan revision/hash, and the final attempt. Parse implementation, verification, and review artifacts with their existing schemas, but hash their exact persisted UTF-8 bytes so the reference detects formatting changes as well as semantic changes. Make every derived summary field an explicit controller input so the persistence function contains no model-dependent inference.

```ts
export function workItemSummaryPath(workItemId: string, planRevision: number, attempt: number): string {
  return `summaries/work-items/${Buffer.from(workItemId, "utf8").toString("base64url")}/plan-${planRevision}-attempt-${attempt}.json`;
}

export interface PersistWorkItemSummaryInput {
  runDir: string;
  manifest: RunManifestV2;
  workItem: WorkItem;
  attempt: number;
  commitSha: string;
  implementationRef: ArtifactRef;
  verificationRef: ArtifactRef;
  reviewRef: ArtifactRef;
  changedFiles: string[];
  acceptanceCoverage: WorkItemSummaryV1["acceptance_coverage"];
  resolvedFindingIds: string[];
  unresolvedFindingIds: string[];
  residualRisks: string[];
  createdAt: string;
}

export async function persistWorkItemSummary(input: PersistWorkItemSummaryInput): Promise<ArtifactRef> {
  const revision = input.manifest.approved_revision ?? input.manifest.approved_plan_revision;
  if (revision === null) throw new Error("Work-item summary requires an approved plan revision");
  const plan = input.manifest.plan_revisions[String(revision)];
  if (!plan) throw new Error(`Approved plan revision ${revision} is missing`);
  await validateSummarySourceRefs(input.runDir, input.implementationRef, input.verificationRef, input.reviewRef, {
    workItemId: input.workItem.id,
    attempt: input.attempt,
    commitSha: input.commitSha,
  });
  const value = workItemSummaryV1Schema.parse({
    schema_version: 1,
    run_id: input.manifest.run_id,
    work_item_id: input.workItem.id,
    plan_revision: revision,
    plan_sha256: plan.sha256,
    attempt: input.attempt,
    commit_sha: input.commitSha,
    implementation_ref: input.implementationRef,
    verification_ref: input.verificationRef,
    review_ref: input.reviewRef,
    changed_files: [...new Set(input.changedFiles)].sort(),
    acceptance_coverage: input.acceptanceCoverage,
    resolved_finding_ids: [...new Set(input.resolvedFindingIds)].sort(),
    unresolved_finding_ids: [...new Set(input.unresolvedFindingIds)].sort(),
    residual_risks: [...new Set(input.residualRisks)].sort(),
    created_at: input.createdAt,
  });
  const path = workItemSummaryPath(input.workItem.id, revision, input.attempt);
  await writeCreateOnceValidated(input.runDir, path, value, workItemSummaryV1Schema);
  return { path, sha256: artifactSha256(workItemSummaryV1Schema, value) };
}
```

`validateSummarySourceRefs` must read each referenced file, parse it with the existing implementation/verification/review schema, SHA-256 the exact raw UTF-8 bytes, compare the supplied `ArtifactRef`, and validate work-item, attempt, commit, and approving-review provenance. Runtime constructs `acceptanceCoverage` by joining the approved criterion IDs to stable evidence record IDs inside the hash-validated verification artifact before calling this function.

Protect `summaries/`, `evidence-indexes/`, `contexts/`, and `budgets/` as engine-owned roots in `protectedV2ArtifactKind`. Create their directories in `createRunLedgerV2`.

- [ ] **Step 4: Require a summary before a new-protocol item becomes complete**

In each runtime approval branch, persist the summary before `setProgress(... status: "complete")`, then store both pointer fields. In `writeManifestV2Atomic`, enforce only for `workflow_protocol === "bounded-context-v1"`:

```ts
if (manifest.workflow_protocol === "bounded-context-v1" && progress.status === "complete") {
  if (typeof progress.summary_path !== "string" || typeof progress.summary_sha256 !== "string") {
    throw new Error(`Completed work item ${workItemId} requires an immutable summary`);
  }
}
```

On resume, call `loadWorkItemSummary` before skipping a completed item. Validate plan revision/hash, work-item ID, attempt, commit SHA, and referenced artifact hashes.

- [ ] **Step 5: Run focused runtime tests and verify GREEN**

Run: `npx vitest run tests/workflow/context-artifacts.test.ts tests/core/ledger.test.ts tests/workflow/runtime-local.test.ts tests/workflow/runtime-github.test.ts`

Expected: PASS, including one replan fixture that retains two immutable summaries for the same work item.

- [ ] **Step 6: Commit**

```bash
git add src/workflow/context-artifacts.ts src/core/ledger.ts src/core/types.ts src/core/schema.ts src/workflow/runtime.ts tests/workflow/context-artifacts.test.ts tests/core/ledger.test.ts tests/workflow/runtime-local.test.ts tests/workflow/runtime-github.test.ts
git commit -m "feat: compact completed work items"
```

### Task 3: Build and Enforce Phase-Specific Evidence Indexes

**Files:**
- Modify: `src/workflow/context-artifacts.ts`
- Modify: `src/workflow/runtime.ts`
- Modify: `src/workflow/assurance.ts`
- Modify: `src/workflow/reflection.ts`
- Modify: `tests/workflow/context-artifacts.test.ts`
- Modify: `tests/workflow/runtime-local.test.ts`
- Modify: `tests/workflow/runtime-github.test.ts`
- Modify: `tests/workflow/assurance.test.ts`
- Modify: `tests/workflow/reflection.test.ts`

**Interfaces:**
- Produces: `buildFinalVerifierEvidenceIndex(input): Promise<ArtifactRef>`.
- Produces: `buildReflectionEvidenceIndex(input): Promise<ArtifactRef>`.
- Produces: `loadEvidenceIndex(runDir, ref, expected): Promise<EvidenceIndexV1>`.

- [ ] **Step 1: Write failing index completeness tests**

Cover missing summary, stale plan hash, wrong candidate commit, duplicate work-item summary, unresolved finding absent from `finding_index`, final index containing a final review, reflection index missing a final review, and tampered referenced evidence.

```ts
await expect(buildFinalVerifierEvidenceIndex({
  runDir: ledger.runDir,
  manifest,
  orderedWorkItems: [item1, item2],
  integratedVerification,
  attempt: 1,
})).rejects.toThrow("Missing work-item summary for item-2");
```

- [ ] **Step 2: Run tests and verify RED**

Run: `npx vitest run tests/workflow/context-artifacts.test.ts tests/workflow/assurance.test.ts tests/workflow/reflection.test.ts`

Expected: FAIL on missing index builders and gates.

- [ ] **Step 3: Implement deterministic phase snapshots**

Sort summaries by approved plan order, findings by stable finding ID, and every evidence reference by path. Use these exact paths:

```ts
export function finalVerifierEvidenceIndexPath(attempt: number): string {
  return `evidence-indexes/final-verifier/attempt-${attempt}.json`;
}

export const reflectionEvidenceIndexPath = "evidence-indexes/reflection.json";
```

The final-Verifier index contains current integrated verification and `integrated_review_ref: null`. The reflection index contains the exact final integrated verification and approving final review, terminal disposition, assurance outcome, all current work-item summary references, and unresolved findings. Budget state is deliberately absent because it is not acceptance evidence.

- [ ] **Step 4: Gate final Verifier before invocation**

Immediately after integrated verification is persisted and before `verifyWorkItem({ final: true })`, build and reload the final index. Pass its reference to Verifier. A missing or invalid index records a runtime blocker and does not invoke Verifier.

- [ ] **Step 5: Gate reflection and assurance**

Build `evidence-indexes/reflection.json` after the terminal disposition exists and before either reflection account is invoked. Add the path to `final_artifact_paths`, which is already the only allowed terminal manifest extension.

In assurance, require the matching final-Verifier index for `integrated.attempts`, validate its candidate commit and integrated verification reference, but continue validating the actual evidence/review artifacts independently.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run: `npx vitest run tests/workflow/context-artifacts.test.ts tests/workflow/runtime-local.test.ts tests/workflow/runtime-github.test.ts tests/workflow/assurance.test.ts tests/workflow/reflection.test.ts`

Expected: PASS; invocation spies prove final Verifier and reflection are not called when their index is missing or stale.

- [ ] **Step 7: Commit**

```bash
git add src/workflow/context-artifacts.ts src/workflow/runtime.ts src/workflow/assurance.ts src/workflow/reflection.ts tests/workflow/context-artifacts.test.ts tests/workflow/runtime-local.test.ts tests/workflow/runtime-github.test.ts tests/workflow/assurance.test.ts tests/workflow/reflection.test.ts
git commit -m "feat: require phase evidence indexes"
```

### Task 4: Build Deterministic Bounded Role Contexts

**Files:**
- Modify: `src/adapters/git.ts`
- Modify: `src/workflow/context-artifacts.ts`
- Modify: `tests/adapters/git-worktree.test.ts`
- Modify: `tests/workflow/context-artifacts.test.ts`

**Interfaces:**
- Produces: `collectScopedDiff(repoRoot, files, maxBytes): Promise<ScopedDiff>`.
- Produces: `buildHandsContext(input): Promise<RoleContextArtifact>`.
- Produces: `buildVerifierContext(input): Promise<RoleContextArtifact>`.
- Produces: `buildReflectionContext(input): Promise<RoleContextArtifact>`.

```ts
export interface ScopedDiff {
  patch: string;
  included_files: string[];
  omitted_files: Array<{ path: string; reason: "diff_budget_exhausted" }>;
  bytes: number;
}

export interface RoleContextArtifact {
  ref: ArtifactRef;
  package: RoleContextPackageV1;
}
```

- [ ] **Step 1: Write failing selection and cap tests**

Test path ranking: active-finding target files first, then work-item change-unit files, then dependency-summary files. Assert whole-file patches are included or omitted—never byte-sliced. Assert required spec/finding overflow blocks and optional evidence overflow records `omitted_artifacts`.

```ts
const scoped = await collectScopedDiff(repo, ["src/a.ts", "src/b.ts"], 200);
expect(scoped.patch.endsWith("\n")).toBe(true);
expect(scoped.included_files).toEqual(["src/a.ts"]);
expect(scoped.omitted_files).toEqual([{ path: "src/b.ts", reason: "diff_budget_exhausted" }]);
expect(Buffer.byteLength(scoped.patch, "utf8")).toBeLessThanOrEqual(200);
```

- [ ] **Step 2: Run tests and verify RED**

Run: `npx vitest run tests/adapters/git-worktree.test.ts tests/workflow/context-artifacts.test.ts`

Expected: FAIL on missing scoped diff/context builders.

- [ ] **Step 3: Implement scoped diff collection**

For each safe repo-relative file in priority order, run direct argv `git diff --no-ext-diff --binary HEAD -- <file>`. For untracked files, use `git diff --no-index -- /dev/null <file>` and accept exit code 1. Append a file patch only when the complete UTF-8 bytes fit. Reject duplicate, absolute, `..`, `.git`, and file-contract-excluded paths.

- [ ] **Step 4: Implement role-specific payload selection**

Hands payload order:

1. Exact approved work item.
2. One active fix packet or one prior finding; never the whole review history.
3. Relevant scoped diff.
4. Latest validated verification summary and explicitly referenced evidence only.
5. Immutable summaries of declared completed dependencies.

Verifier payload order:

1. Acceptance/release contract.
2. Controller-observed changed files and scoped diff.
3. Current normalized command/artifact/browser evidence records and their run-relative references; no stdout/stderr bodies.
4. Current unresolved finding records.
5. Final evidence-index reference when `final === true`.

Reflection payload order:

1. Reflection evidence index.
2. Referenced work-item summaries.
3. Terminal and assurance outcome.
4. Convergence summary and terminal rationale.

Persist each complete `{ manifest, payload }` package at `contexts/<role>/<artifact-name>.json`. The manifest records selected refs, omitted refs, payload byte count, and role coordinates. Serialize the complete package with `roleContextPackageV1Schema`, validate that final byte count against the role cap, then write and hash those exact bytes. Context payloads expose only run-relative evidence references. If direct evidence inspection is required, include a bounded normalized record or safe excerpt in the payload rather than exposing the generic run directory.

- [ ] **Step 5: Run tests and verify GREEN**

Run: `npx vitest run tests/adapters/git-worktree.test.ts tests/workflow/context-artifacts.test.ts`

Expected: PASS with fixtures containing a secret sentinel, unrelated event history, and oversized optional evidence; none appears in the context payload.

- [ ] **Step 6: Commit**

```bash
git add src/adapters/git.ts src/workflow/context-artifacts.ts tests/adapters/git-worktree.test.ts tests/workflow/context-artifacts.test.ts
git commit -m "feat: build bounded role contexts"
```

### Task 5: Wire Hands and Verifier to Compact Contexts

**Files:**
- Modify: `src/workflow/worker.ts`
- Modify: `src/workflow/verifier.ts`
- Modify: `src/workflow/hands-recovery.ts`
- Modify: `src/workflow/runtime.ts`
- Modify: `prompts/hands-work-item-v2.md`
- Modify: `prompts/hands-recovery-v2.md`
- Modify: `prompts/verifier-review-v2.md`
- Modify: `tests/workflow/worker.test.ts`
- Modify: `tests/workflow/verifier.test.ts`
- Modify: `tests/workflow/hands-recovery.test.ts`
- Modify: `tests/workflow/runtime-local.test.ts`

**Interfaces:**
- `HandsWorkItemInput` and `VerifyWorkItemInput` become protocol-discriminated unions: `bounded-context-v1` requires `context: RoleContextArtifact`; `durable-discovery-v1` retains the existing legacy fields for resume compatibility.
- Prompts receive `context_artifact_ref` and `context_json`; the reference authenticates the separately serialized package without attempting a self-hash.

- [ ] **Step 1: Write failing prompt non-leakage tests**

Assert that bounded-protocol Hands and Verifier prompts contain the context manifest hash, work-item ID, and selected evidence, but do not contain `events.jsonl`, `original_request`, unrelated work-item IDs, prior review bodies, absolute run directory, or raw command output sentinels. Add a legacy fixture proving an active `durable-discovery-v1` run still renders its existing prompt contract.

```ts
expect(invocation.prompt).toContain('"work_item_id": "item-1"');
expect(invocation.prompt).toContain(context.ref.sha256);
expect(invocation.prompt).not.toContain("events.jsonl");
expect(invocation.prompt).not.toContain("UNRELATED_HISTORY_SENTINEL");
expect(invocation.prompt).not.toContain(runDir);
```

- [ ] **Step 2: Run tests and verify RED**

Run: `npx vitest run tests/workflow/worker.test.ts tests/workflow/verifier.test.ts tests/workflow/hands-recovery.test.ts`

Expected: FAIL because current Verifier expands artifact contents and current recovery embeds attempt history.

- [ ] **Step 3: Replace Hands prompt assembly**

Render only:

```md
## Controller-owned bounded context

Artifact reference: `{{context_artifact_ref}}`

{{context_json}}

Use only the approved work item, active finding/fix packet, selected evidence, and repository files needed by that work item. `omitted_artifacts` means the controller intentionally excluded optional context; do not infer its contents.
```

Keep the existing structured implementation output and scope validation. For bounded runs, remove arbitrary `diagnostic_context` truncation from `hands-recovery.ts` and use the same context builder with one active finding and current evidence. Keep the legacy renderer reachable only through the legacy union arm.

- [ ] **Step 4: Replace Verifier broad context assembly**

Move `MAX_CONTEXT_BYTES`, `readContextFile`, `buildArtifactsContext`, `priorVerification`, generic `run_dir`, and generic `evidence_root` behind a named `renderLegacyVerifierContext` path used only for `durable-discovery-v1` resume. The bounded renderer carries only run-relative `ArtifactRef` values plus bounded normalized evidence records; it never advertises the run root or recursively opens arbitrary artifacts. Remove the legacy helper only when support for the legacy protocol is deliberately retired.

- [ ] **Step 5: Update runtime call sites**

Before every bounded-protocol initial/fix Hands call and every Verifier call, build the matching context artifact. For bounded final Verifier, require the Task 3 index reference. On resume, dispatch by the manifest's immutable protocol; reload and hash-check an existing context artifact before reusing a bounded immutable model output, while leaving legacy resume behavior unchanged.

- [ ] **Step 6: Run workflow tests and verify GREEN**

Run: `npx vitest run tests/workflow/worker.test.ts tests/workflow/verifier.test.ts tests/workflow/hands-recovery.test.ts tests/workflow/runtime-local.test.ts tests/workflow/runtime-github.test.ts`

Expected: PASS; prompt snapshots contain only the bounded context object.

- [ ] **Step 7: Commit**

```bash
git add src/workflow/worker.ts src/workflow/verifier.ts src/workflow/hands-recovery.ts src/workflow/runtime.ts prompts/hands-work-item-v2.md prompts/hands-recovery-v2.md prompts/verifier-review-v2.md tests/workflow/worker.test.ts tests/workflow/verifier.test.ts tests/workflow/hands-recovery.test.ts tests/workflow/runtime-local.test.ts tests/workflow/runtime-github.test.ts
git commit -m "feat: bound hands and verifier context"
```

### Task 6: Replace Reflection History Scans with the Reflection Index

**Files:**
- Modify: `src/workflow/reflection.ts`
- Modify: `prompts/reflection-v2.md`
- Modify: `prompts/reflection-synthesis-v2.md`
- Modify: `tests/workflow/reflection.test.ts`

**Interfaces:**
- Isolates: `listFiles`, `readCapped`, `runLedgerContext`, `MAX_FILE_BYTES`, and `MAX_CONTEXT_BYTES` in a legacy-only reflection renderer.
- Consumes: `buildReflectionContext()` from Task 4.

- [ ] **Step 1: Write failing reflection-scope tests**

Create a bounded-protocol run containing oversized `events.jsonl`, old prompts, raw response sentinels, and unrelated files. Assert neither account prompt nor synthesis prompt contains them. Assert both prompts contain the reflection evidence-index hash and the same compact work-item summary references. Keep one legacy test proving an old run can still use its historical renderer.

- [ ] **Step 2: Run tests and verify RED**

Run: `npx vitest run tests/workflow/reflection.test.ts`

Expected: FAIL because `runLedgerContext` currently scans run files and includes events.

- [ ] **Step 3: Use one immutable reflection context**

For bounded runs, build or reload `contexts/reflection/reflection.json` after `evidence-indexes/reflection.json` is valid. Pass the same context JSON to Brain account, Hands account, and synthesis. Keep role-specific focus text, but do not rebuild or expand context between calls. Dispatch legacy runs to the isolated old renderer without requiring new artifacts.

```ts
const context = await buildReflectionContext({ runDir: input.runDir, manifest });
const contextJson = canonicalArtifactJson(roleContextPackageV1Schema, context.package);
for (const role of ["brain", "hands"] as const) {
  const prompt = renderTemplate(template, {
    account_role: role,
    role_focus: reflectionRoleFocus(role),
    process_context_ref: JSON.stringify(context.ref),
    process_context: contextJson,
  });
  // invoke unchanged structured account output
}
```

- [ ] **Step 4: Run tests and verify GREEN**

Run: `npx vitest run tests/workflow/reflection.test.ts tests/cli-smoke.test.ts`

Expected: PASS, including terminal recovery that reuses the existing reflection index and context.

- [ ] **Step 5: Commit**

```bash
git add src/workflow/reflection.ts prompts/reflection-v2.md prompts/reflection-synthesis-v2.md tests/workflow/reflection.test.ts tests/cli-smoke.test.ts
git commit -m "feat: reflect from compact evidence index"
```

### Task 7: Define Authoritative Resource Budget Accounting

**Files:**
- Create: `src/core/resource-budget.ts`
- Create: `src/workflow/resource-budget.ts`
- Create: `tests/core/resource-budget.test.ts`
- Create: `tests/workflow/resource-budget.test.ts`
- Modify: `src/core/types.ts`
- Modify: `src/core/schema.ts`
- Modify: `src/core/config.ts`
- Modify: `src/core/ledger.ts`
- Modify: `tests/core/config.test.ts`
- Modify: `tests/core/schema.test.ts`
- Modify: `tests/core/ledger.test.ts`

**Interfaces:**
- Produces: `resourceBudgetPolicyV1Schema`, `resourceBudgetClaimV1Schema`, `resourceBudgetCompletionV1Schema`.
- Produces: `readResourceBudgetUsage(runDir, now): Promise<ResourceBudgetUsage>`.
- Produces: `claimResourceBudget(input): Promise<ResourceBudgetClaimV1>`.
- Produces: `completeResourceBudgetClaim(input): Promise<ResourceBudgetCompletionV1>`.
- Produces: `ResourceBudgetExceededError` with `dimension`, `used`, `limit`, and `requested`.

- [ ] **Step 1: Write failing pure accounting tests**

Cover unique claims, same-key idempotency, conflicting same-key claims, token totals from completions, open-claim elapsed charging, safe-integer overflow, and dimension-specific exhaustion.

```ts
const usage = reduceResourceBudgetArtifacts(policy, [
  claim("model_invocation", "invoke:1", "2026-07-16T12:00:00.000Z"),
  claim("workflow_attempt", "hands:item-1:1", "2026-07-16T12:00:00.000Z"),
], [
  completion("invoke:1", { input_tokens: 80, cached_input_tokens: 20, output_tokens: 20, reasoning_output_tokens: 5, duration_ms: 1000 }),
], "2026-07-16T12:00:02.000Z");

expect(usage).toEqual({
  model_invocations: 1,
  workflow_attempts: 1,
  total_tokens: 100,
  active_elapsed_ms: 1000,
  external_effects: 0,
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `npx vitest run tests/core/resource-budget.test.ts tests/workflow/resource-budget.test.ts`

Expected: FAIL because budget modules do not exist.

- [ ] **Step 3: Implement strict policy, claim, and completion schemas**

```ts
export const resourceBudgetPolicyV1Schema = z.object({
  schema_version: z.literal(1),
  max_model_invocations: z.number().int().positive(),
  max_workflow_attempts: z.number().int().positive(),
  max_total_tokens: z.number().int().positive(),
  max_active_elapsed_ms: z.number().int().positive(),
  max_external_effects: z.number().int().nonnegative(),
}).strict();

export const resourceBudgetClaimV1Schema = z.object({
  schema_version: z.literal(1),
  claim_id: z.string().regex(/^budget-claim:[a-f0-9]{64}$/),
  run_id: z.string().min(1),
  kind: z.enum(["model_invocation", "workflow_attempt", "active_elapsed", "external_effect"]),
  key: z.string().min(1).max(512),
  started_at: z.string().datetime(),
  max_duration_ms: z.number().int().positive().nullable(),
}).strict();
```

Completion includes claim identity, completed timestamp, token dimensions, duration, outcome `completed | failed | ambiguous`, and optional safe result reference. Require `max_duration_ms: null` for `workflow_attempt`; require a positive cap for chargeable elapsed kinds. Invocation/attempt/external counts are consumed by claims. Tokens are consumed by model completions. Active elapsed is the sum of completion durations for `model_invocation`, `active_elapsed`, and `external_effect` claims plus `min(now - started_at, max_duration_ms)` for still-open claims of those kinds. `workflow_attempt` claims never contribute elapsed time.

- [ ] **Step 4: Implement ledger-locked persistence**

Derive claim IDs from `run_id + kind + key`. Under `withRunLedgerTransaction`, read usage, validate the prospective claim against the manifest’s immutable `resource_budget_policy`, and write:

```text
budgets/claims/<base64url-claim-id>.json
budgets/completions/<base64url-claim-id>.json
```

If an identical claim exists, return it. If its bytes conflict, fail. Completions are create-once and must match their claim. On resume, reconcile open chargeable claims into `ambiguous` completions using the bounded open duration before starting new work; this is intentionally conservative but cannot charge unlimited controller downtime.

- [ ] **Step 5: Add config and budget snapshot for the declared protocol**

Add `resource_budget` to `ConfigV2`, `RunIntake`, and `ResolvedRunIntake`. `configV2Schema` defaults missing existing configs to `DEFAULT_RESOURCE_BUDGET_V1`; `initConfig` writes it explicitly. Add immutable `resource_budget_policy` to new manifests and include it in `assertMutableManifestPatch`.

Task 1 already makes `bounded-context-v1` a recognized protocol. Only this protocol requires budget policy and summary/index invariants. Keep new-run selection on the legacy protocol until Task 10.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run: `npx vitest run tests/core/resource-budget.test.ts tests/workflow/resource-budget.test.ts tests/core/config.test.ts tests/core/schema.test.ts tests/core/ledger.test.ts`

Expected: PASS, including two concurrent claim attempts that produce one immutable claim and one consumed unit.

- [ ] **Step 7: Commit**

```bash
git add src/core/resource-budget.ts src/workflow/resource-budget.ts src/core/types.ts src/core/schema.ts src/core/config.ts src/core/ledger.ts tests/core/resource-budget.test.ts tests/workflow/resource-budget.test.ts tests/core/config.test.ts tests/core/schema.test.ts tests/core/ledger.test.ts
git commit -m "feat: add authoritative run budgets"
```

### Task 8: Charge Model, Verification, Push, and GitHub Boundaries

**Files:**
- Modify: `src/adapters/codex.ts`
- Modify: `src/progress/codex.ts`
- Create: `src/adapters/budgeted-github.ts`
- Create: `tests/adapters/budgeted-github.test.ts`
- Modify: `src/verification/runner.ts`
- Modify: `src/workflow/planner.ts`
- Modify: `src/workflow/worker.ts`
- Modify: `src/workflow/verifier.ts`
- Modify: `src/workflow/self-review.ts`
- Modify: `src/workflow/action-verifier.ts`
- Modify: `src/workflow/plan-repair.ts`
- Modify: `src/workflow/runtime.ts`
- Modify: `src/cli.ts`
- Modify: `src/core/run-configuration.ts`
- Modify: `src/workflow/status.ts`
- Modify: `tests/adapters/codex.test.ts`
- Modify: `tests/progress/codex.test.ts`
- Modify: `tests/verification/runner.test.ts`
- Modify: `tests/core/run-configuration.test.ts`
- Modify: `tests/workflow/status.test.ts`
- Modify: `tests/cli-smoke.test.ts`

**Interfaces:**
- Adds to `CodexInvokeResult`: `usage: TokenUsage`, `durationMs: number`.
- Adds to `CodexInvokeInput`: `workflowAttempt?: { key: string; kind: "brain" | "hands" | "verifier" | "self_review" | "focused_verifier" }`.
- Produces: `createBudgetedCodexAdapter(base, controller): CodexAdapter`.
- Produces: `createBudgetedGitHubAdapter(base, controller): GitHubAdapter`.

- [ ] **Step 1: Write failing authoritative-usage tests**

Invoke Codex without a progress reporter and feed structured `turn.completed` JSON. Assert usage is returned and budgeted. Test one failed invocation consumes invocation/time but zero tokens when no valid usage was reported. Test two invocations with the same workflow-attempt key consume two invocation units and one attempt unit.

- [ ] **Step 2: Run adapter tests and verify RED**

Run: `npx vitest run tests/adapters/codex.test.ts tests/progress/codex.test.ts tests/adapters/budgeted-github.test.ts tests/verification/runner.test.ts`

Expected: FAIL because structured events currently depend on `input.progress` and no budget wrappers exist.

- [ ] **Step 3: Decouple structured event consumption from progress rendering**

Always pass `--json` for structured Codex calls. Extend the consumer with `usage()` while keeping the reporter optional:

```ts
export interface CodexProgressConsumer {
  write(chunk: string): Promise<void>;
  end(): Promise<void>;
  usage(): TokenUsage;
}
```

Accumulate the last validated `turn.completed.usage` independently of progress emission. Return that usage and measured duration from both subprocess and dry-run adapters.

- [ ] **Step 4: Implement the budgeted Codex decorator**

Before `base.invoke`, claim a unique model invocation with `max_duration_ms` equal to the smaller of the adapter timeout and remaining active-time budget, plus the optional idempotent workflow attempt. Pass the same cap to the subprocess timeout. After success or failure, complete the model-invocation claim with usage and duration; do not create a second active-elapsed claim for the same call. If budget validation fails, do not call the base adapter.

Reflection calls omit `workflowAttempt` but still consume invocation/token/time. The standalone `reflection --update-from-reflection` command has no run ledger and remains outside per-run budgets.

- [ ] **Step 5: Charge deterministic verification commands**

Add `budget?: ResourceBudgetController` to `RunVerificationInput`. Before each command, claim active elapsed using `verification:<scope>:<work-item>:<attempt>:command:<index>`. Clamp timeout:

```ts
const remaining = await input.budget?.remainingActiveElapsedMs();
const timeoutMs = Math.min(15 * 60 * 1000, remaining ?? Number.MAX_SAFE_INTEGER);
if (timeoutMs <= 0) throw new ResourceBudgetExceededError("active_elapsed_ms", 0, 0, 1);
```

Complete the claim with actual duration even when the command fails or times out.

- [ ] **Step 6: Implement the explicit GitHub mutation decorator**

Manually wrap every mutating adapter method (`createIssue`, `updateIssue`, labels, PR creation/body update, comments, close, status comment create/update, and label reconciliation). Pass read-only methods through unchanged. Derive keys from the method, target identity, and SHA-256 of canonical desired content.

```ts
const effectKey = `github:update-issue:${issueNumber}:${sha256(canonicalIssueBody)}`;
return budget.runExternalEffect(effectKey, () => base.updateIssue(issueNumber, issue, marker, currentBody, title));
```

Budget Git push separately in runtime with `git-push:<remote>:<branch>:<commit-sha>`. Local commits are not external effects.

`runExternalEffect` persists a safe result reference on completion. When the same key is already complete, return the validated saved result without repeating the mutation. When the claim is open after a crash, first perform a method-specific read-only reconciliation against the desired remote state; complete it as `ambiguous` if the state already matches, otherwise retry under the same claim so no second external-effect unit is consumed.

- [ ] **Step 7: Attach stable workflow-attempt keys**

Use exact keys:

```text
brain:discovery:<cycle>:<sequence>
brain:plan:<lineage>:full:<ordinal>
brain:plan:<lineage>:repair:<ordinal>
hands:<work-item>:<attempt>:<attempt-kind>
verifier:<work-item>:<attempt>:<final>
hands-self-review:<work-item>:<attempt>:<pass>
focused-verifier:<work-item>:<review-revision>:<action-id>:<action-attempt>
```

The decorator deduplicates workflow-attempt claims by key but always creates a new invocation claim.

- [ ] **Step 8: Show budgets in preview and status**

Add all five limits to `run-configuration.json`, preview rendering, status JSON, and human status output. Show `used/limit/remaining`; show `token_budget_overshot_by` when a completed call crossed the cap.

- [ ] **Step 9: Run focused tests and verify GREEN**

Run: `npx vitest run tests/adapters/codex.test.ts tests/progress/codex.test.ts tests/adapters/budgeted-github.test.ts tests/verification/runner.test.ts tests/core/run-configuration.test.ts tests/workflow/status.test.ts tests/cli-smoke.test.ts tests/workflow/runtime-local.test.ts tests/workflow/runtime-github.test.ts`

Expected: PASS; spies prove exhausted budgets prevent the next model, command, push, or GitHub mutation.

- [ ] **Step 10: Commit**

```bash
git add src/adapters/codex.ts src/progress/codex.ts src/adapters/budgeted-github.ts src/verification/runner.ts src/workflow/planner.ts src/workflow/worker.ts src/workflow/verifier.ts src/workflow/self-review.ts src/workflow/action-verifier.ts src/workflow/plan-repair.ts src/workflow/runtime.ts src/cli.ts src/core/run-configuration.ts src/workflow/status.ts tests/adapters/codex.test.ts tests/progress/codex.test.ts tests/adapters/budgeted-github.test.ts tests/verification/runner.test.ts tests/core/run-configuration.test.ts tests/workflow/status.test.ts tests/cli-smoke.test.ts tests/workflow/runtime-local.test.ts tests/workflow/runtime-github.test.ts
git commit -m "feat: enforce run budgets at effect boundaries"
```

### Task 9: Coalesce Heartbeats and Identical Warnings in Operator Views

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
- Produces: `createProgressViewReducer(options): ProgressViewReducer`.
- Produces: `ProgressViewRecord = material | heartbeat_summary | warning_summary`.
- Keeps: `progress.jsonl` schema and append-only persistence unchanged.

- [ ] **Step 1: Write failing reducer tests**

Feed 100 heartbeat events for one invocation followed by a material completion event. Expect one heartbeat summary with count 100 before completion. Feed 20 identical unreadable-progress warnings and expect one warning summary with count 20. A heartbeat from a different invocation flushes the first summary and starts another.

```ts
const reducer = createProgressViewReducer();
for (let ordinal = 1; ordinal <= 100; ordinal += 1) {
  reducer.push(heartbeatEvent({ invocation: "inv-1", ordinal }));
}
const records = reducer.push(materialEvent("hands_turn_completed"));
expect(records).toEqual([
  expect.objectContaining({ kind: "heartbeat_summary", count: 100 }),
  expect.objectContaining({ kind: "material" }),
]);
```

- [ ] **Step 2: Run tests and verify RED**

Run: `npx vitest run tests/progress/view.test.ts tests/progress/log.test.ts tests/progress/codex.test.ts tests/cli-smoke.test.ts`

Expected: FAIL because every heartbeat currently reaches the formatter independently.

- [ ] **Step 3: Implement the pure presentation reducer**

Group heartbeats by source, worker session, and model invocation. Group warnings by `source + code + model invocation`. Preserve first timestamp, last timestamp, count, and latest safe label. Flush pending summaries before a material event, at stream end, or when the group key changes.

Do not mutate, delete, or rewrite `progress.jsonl`.

- [ ] **Step 4: Deduplicate unreadable-progress emission inside one consumer**

Change the current warning helper to use normal per-consumer deduplication:

```ts
const warning = (): Promise<void> => emit({ code: "progress_warning", source: input.context.source });
```

The reporter’s existing canonical event-key deduplication remains the cross-resume guard. The view reducer still coalesces duplicate warnings from legacy or malformed ledgers.

- [ ] **Step 5: Wire replay and follow rendering**

`logs` replay sends validated events through the reducer and flushes at EOF. `logs --follow` and producer `--follow` use the same reducer. In a TTY, a heartbeat summary may update one carriage-return line; in non-TTY output, emit one summary only when flushed. Material events remain one line each.

- [ ] **Step 6: Run tests and verify GREEN**

Run: `npx vitest run tests/progress/view.test.ts tests/progress/log.test.ts tests/progress/codex.test.ts tests/cli-smoke.test.ts`

Expected: PASS; safe-progress ledger contents remain byte-for-byte unchanged while rendered output is compact.

- [ ] **Step 7: Commit**

```bash
git add src/progress/view.ts src/progress/codex.ts src/progress/log.ts src/cli.ts tests/progress/view.test.ts tests/progress/codex.test.ts tests/progress/log.test.ts tests/cli-smoke.test.ts
git commit -m "feat: coalesce operator progress noise"
```

### Task 10: Protocol Compatibility, Documentation, and End-to-End Proof

**Files:**
- Modify: `README.md`
- Modify: `agentic-codex-workflow.md`
- Modify: `.agents/skills/brain-hands/SKILL.md`
- Modify: `docs/example-config.yaml`
- Modify: `tests/skill-layout.test.ts`
- Modify: `tests/workflow/e2e-dry-run.test.ts`
- Modify: `tests/workflow/canonical-session-built-cli.test.ts`
- Modify: `tests/cli-smoke.test.ts`
- Modify: `src/core/ledger.ts`
- Modify: `src/workflow/runtime.ts`

**Interfaces:**
- Consumes: all new protocol artifacts and status fields.
- Produces: documented operator contract and compiled lifecycle proof.

- [ ] **Step 1: Add legacy/new protocol compatibility tests**

Prove:

- A `durable-discovery-v1` fixture resumes without budget, summary, or evidence-index enforcement.
- A `bounded-context-v1` fixture fails closed when any required artifact is absent.
- Preview displays all five configured budget limits before intake questions.
- Final Verifier receives the exact final index hash.
- Reflection receives the exact reflection index hash.
- `progress.jsonl` contains all safe heartbeat records while `logs` output contains compact summaries.

- [ ] **Step 2: Run lifecycle tests and verify RED where documentation/fixtures lag**

Run: `npx vitest run tests/workflow/e2e-dry-run.test.ts tests/workflow/canonical-session-built-cli.test.ts tests/cli-smoke.test.ts tests/skill-layout.test.ts`

Expected: FAIL until fixtures, preview expectations, and skill text describe the new protocol.

- [ ] **Step 3: Update documentation, skill contract, and fixtures**

Document:

- Full audit trail versus compact model contexts.
- Work-item summary and evidence-index paths.
- Context caps and deterministic omission behavior.
- Budget definitions, recommended defaults, token overshoot limitation, and exhaustion recovery.
- Heartbeat/warning coalescing as presentation-only behavior.
- New-run protocol gating and legacy-run resume behavior.
- Evidence indexes as navigational artifacts, not acceptance evidence.

Update the skill’s configuration preview requirements to include invocation, attempt, token, active-elapsed, and external-effect budgets.

- [ ] **Step 4: Verify both protocols before changing the default**

Run: `npx vitest run tests/workflow/e2e-dry-run.test.ts tests/workflow/canonical-session-built-cli.test.ts tests/cli-smoke.test.ts tests/skill-layout.test.ts`

Expected: PASS with fixtures that select each protocol explicitly.

- [ ] **Step 5: Activate the new protocol only after compatibility is green**

Change new-run creation to snapshot `workflow_protocol: "bounded-context-v1"`. Do not rewrite existing manifests. Re-run the Step 4 command immediately; if either compatibility fixture fails, keep legacy as the default and treat activation as blocked.

- [ ] **Step 6: Run all focused tests**

Run:

```text
npx vitest run tests/core/context-artifacts.test.ts tests/workflow/context-artifacts.test.ts
npx vitest run tests/core/resource-budget.test.ts tests/workflow/resource-budget.test.ts tests/adapters/budgeted-github.test.ts
npx vitest run tests/progress/view.test.ts tests/progress/log.test.ts tests/progress/codex.test.ts
npx vitest run tests/workflow/worker.test.ts tests/workflow/verifier.test.ts tests/workflow/reflection.test.ts tests/workflow/assurance.test.ts
npx vitest run tests/workflow/runtime-local.test.ts tests/workflow/runtime-github.test.ts tests/workflow/e2e-dry-run.test.ts
```

Expected: every command exits 0.

- [ ] **Step 7: Run complete repository verification**

Run each command separately:

```text
npm test
npm run typecheck
npm run build
npm run validate-release -- --json
git diff --check
npm_config_cache=/private/tmp/brain-hands-npm-cache npm pack --dry-run --json
```

Expected: every command exits 0; release validation reports success; the package contains only `dist/`, `prompts/`, `agentic-codex-workflow.md`, `README.md`, and package metadata.

- [ ] **Step 8: Run a fresh compiled local lifecycle**

Use `node dist/cli.js` with deterministic dry-run fixtures to create a new `bounded-context-v1` run, complete discovery and plan approval, execute at least two work items, final verification, final Verifier, and reflection.

Inspect and assert:

```text
summaries/work-items/*/plan-*-attempt-*.json
evidence-indexes/final-verifier/attempt-*.json
evidence-indexes/reflection.json
contexts/hands/*.json
contexts/verifier/*.json
contexts/reflection/reflection.json
budgets/claims/*.json
budgets/completions/*.json
```

Confirm no context artifact contains `events.jsonl`, raw command output sentinels, unrelated work-item content, or secret-shaped fixture values.

- [ ] **Step 9: Run a fresh compiled GitHub dry-run lifecycle**

Use the dry-run GitHub adapter. Confirm issue/status/PR mutations create external-effect claims; read-only discovery calls do not; identical resume projections reuse existing effect keys; and push/PR readiness cannot proceed after external-effect exhaustion.

- [ ] **Step 10: Commit**

```bash
git add README.md agentic-codex-workflow.md .agents/skills/brain-hands/SKILL.md docs/example-config.yaml src/core/ledger.ts src/workflow/runtime.ts tests/skill-layout.test.ts tests/workflow/e2e-dry-run.test.ts tests/workflow/canonical-session-built-cli.test.ts tests/cli-smoke.test.ts
git commit -m "docs: document bounded context governance"
```

## Final Acceptance Checklist

- [ ] Hands receives one approved work item, one active finding/fix packet, one scoped diff, selected evidence, and declared dependency summaries only.
- [ ] Verifier receives acceptance/release contracts, controller-observed changed files, current command/artifact/browser evidence, unresolved findings, and the required final evidence index only.
- [ ] Reflection consumes one immutable reflection context and never scans `events.jsonl` or arbitrary run files.
- [ ] Every completed new-protocol work item points to a hash-validated immutable summary versioned by plan revision and attempt.
- [ ] Final Verifier and reflection cannot start without their exact phase evidence index.
- [ ] Evidence indexes point to evidence but never replace underlying verification or review validation.
- [ ] Invocation, attempt, token, active-elapsed, and external-effect budgets are authoritative, crash-safe, idempotent, visible in preview/status, and fail closed.
- [ ] Token overrun after one completed invocation is represented honestly and blocks the next chargeable action.
- [ ] `progress.jsonl` stays append-only and safe; operator replay/follow coalesces heartbeat and identical-warning runs.
- [ ] Legacy runs retain their original workflow contract.
- [ ] Full tests, typecheck, build, release validation, diff check, package dry-run, and compiled local/GitHub lifecycle proofs pass.

## Self-Review

- **Spec coverage:** Every Priority 6 requirement maps to at least one task: role context in Tasks 4–6, immutable summaries in Task 2, telemetry coalescing in Task 9, budgets in Tasks 7–8, and evidence indexes in Task 3.
- **Simplification:** The plan does not introduce a mutable operator-state file, a generic event-sourcing framework, configurable context caps, or deletion of detailed evidence.
- **Authority:** Budgets and evidence gates are ledger-backed; progress remains observational.
- **Crash recovery:** Create-once summary/index/context artifacts and idempotent budget claims can be reloaded and validated on resume; bounded claim durations prevent abandoned work from charging unlimited downtime.
- **Type consistency:** `ArtifactRef`, `WorkItemSummaryV1`, `EvidenceIndexV1`, `RoleContextManifestV1`, `RoleContextPackageV1`, `ResourceBudgetPolicyV1`, `ResourceBudgetClaimV1`, and `ResourceBudgetCompletionV1` are defined once and used consistently.
- **Placeholder scan:** The plan contains no deferred implementation placeholders. Angle-bracket notation appears only in documented deterministic path shapes.
- **Deliberate limitation:** Exact token preemption inside a running Codex turn is impossible with the current end-of-turn usage signal; the plan records and enforces bounded one-invocation overshoot instead of claiming a strict instantaneous token stop.
