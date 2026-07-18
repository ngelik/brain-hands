# Hands Self-Review and Ordered Reviewer Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run configurable fresh Hands self-review/fix passes after every mutation and process Reviewer findings as an immutable, sequentially resolved action queue.

**Architecture:** Add strict quality-policy and review contracts, dedicated Hands self-review and focused Verifier roles, and a pure queue state machine. The runtime will wrap every Hands mutation in one resumable quality-gate helper, process one Reviewer action at a time, and persist all substage, evidence, model, cost, and resolution provenance before advancing.

**Tech Stack:** TypeScript 6, Node.js 20+, Zod 4, YAML, Codex CLI structured outputs, GitHub CLI, Vitest.

## Global Constraints

- New generated configuration uses exactly two fresh self-review passes.
- `hands_self_review_passes` accepts only integers from `0` through `3`.
- Existing v2 configuration without `quality_gate` retains the previous behavior.
- Self-review runs after every successful Hands mutation: initial implementation, Reviewer action, normal fix, and quality recovery.
- Self-review never approves delivery or consumes a normal fix/recovery attempt.
- Reviewer actions are immutable within one review revision and execute strictly in validated dependency order.
- Hands sees only the active action, completed-action summaries, approved scope, and relevant evidence.
- An action advances only after deterministic verification, configured self-reviews, regression verification, and focused Verifier `resolved`.
- One complete action queue consumes one normal fix cycle; per-action retries use a separate bounded counter.
- `max_attempts_per_reviewer_action` accepts only integers from `1` through `3`.
- Focused Verifier confirmation is mandatory whenever ordered actions are enabled.
- Usage-limit fallback resumes the same mutation/self-review substage and never resets counters.
- Operational failures block without advancing queue, action, or self-review counters.
- Resume never reorders a queue or repeats completed actions/passes.
- Legacy v1 review/fix commands remain unchanged.

---

## File Structure

**Create:**

- `src/workflow/reviewer-actions.ts` — normalize, validate, order, and cost reviewer action queues.
- `src/workflow/self-review.ts` — invoke Hands self-review and persist structured reports.
- `src/workflow/action-verifier.ts` — invoke focused Verifier for one active action.
- `prompts/hands-self-review-v2.md` — scoped self-inspection/fix prompt.
- `prompts/verifier-action-resolution-v2.md` — focused resolution prompt.
- `tests/workflow/reviewer-actions.test.ts`
- `tests/workflow/self-review.test.ts`
- `tests/workflow/action-verifier.test.ts`

**Modify:**

- `src/core/types.ts`, `src/core/schema.ts`, `src/core/output-schemas.ts`, `src/core/config.ts`, `src/core/ledger.ts` — quality policy, action metadata, structured role outputs, and resumable progress.
- `src/prompts/loader.ts`, `prompts/verifier-review-v2.md` — register prompts and require ordered action metadata.
- `src/workflow/runtime.ts` — reusable mutation quality gate, action queue, retry accounting, resume, backup routing, and final loops.
- `src/workflow/status.ts`, `src/adapters/github.ts` — queue/pass/cost status.
- `src/cli.ts` — ensure snapshotted policy reaches all execution and resume paths.
- `README.md`, `agentic-codex-workflow.md` — operator configuration and state-machine documentation.
- Existing tests listed per task.

---

### Task 1: Add Quality Policy and Durable Queue Contracts

**Files:**

- Modify: `src/core/types.ts`
- Modify: `src/core/schema.ts`
- Modify: `src/core/config.ts`
- Modify: `src/core/ledger.ts`
- Test: `tests/core/config.test.ts`
- Test: `tests/core/schema.test.ts`
- Test: `tests/core/ledger.test.ts`
- Test: `tests/core/intake.test.ts`

**Interfaces:**

- Produces: `QualityGatePolicy`, `ReviewerAction`, `ActionQueueState`, `SelfReviewState`, and explicit `WorkItemProgress` queue fields.
- Produces: `ConfigV2.retry_policy.quality_gate?: QualityGatePolicy`.
- Consumes: existing `VerifierFinding`, `ReasoningEffort`, and v2 manifest schemas.

- [ ] **Step 1: Write failing config tests**

```ts
function configWithQualityGate(patch: Partial<QualityGatePolicy>) {
  const config = defaultConfig();
  return {
    ...config,
    retry_policy: {
      ...config.retry_policy,
      quality_gate: {
        hands_self_review_passes: 2,
        max_attempts_per_reviewer_action: 2,
        require_focused_verifier_confirmation: true as const,
        ...patch,
      },
    },
  };
}

it("generates two self-review passes for new configuration", async () => {
  const config = defaultConfig();
  expect(config.retry_policy.quality_gate).toEqual({
    hands_self_review_passes: 2,
    max_attempts_per_reviewer_action: 2,
    require_focused_verifier_confirmation: true,
  });
});

it.each([-1, 4, 1.5])("rejects self-review pass count %s", (passes) => {
  expect(() => configV2Schema.parse(configWithQualityGate({
    hands_self_review_passes: passes,
  }))).toThrow();
});

it.each([0, 4, 1.5])("rejects action attempt limit %s", (attempts) => {
  expect(() => configV2Schema.parse(configWithQualityGate({
    max_attempts_per_reviewer_action: attempts,
  }))).toThrow();
});
```

- [ ] **Step 2: Run the contract tests and verify RED**

Run: `npx vitest run tests/core/config.test.ts tests/core/schema.test.ts tests/core/ledger.test.ts tests/core/intake.test.ts`

Expected: FAIL because `quality_gate` and queue progress fields do not exist.

- [ ] **Step 3: Implement exact policy and progress types**

```ts
export interface QualityGatePolicy {
  hands_self_review_passes: number;
  max_attempts_per_reviewer_action: number;
  require_focused_verifier_confirmation: true;
}

export interface ReviewerAction extends VerifierFinding {
  action_id: string;
  order: number;
  depends_on: string[];
}

export type ActionQueueState = "pending" | "in_progress" | "complete" | "blocked";
export type SelfReviewState = "pending" | "invoking" | "verification_pending" | "complete";
```

Extend `WorkItemProgress` with `review_revision`, `queue_state`, `queue_path`, `active_action_id`, `active_action_attempt`, `completed_action_ids`, `mutation_kind`, `self_review_pass`, `self_review_state`, and `focused_review_path`.

- [ ] **Step 4: Implement strict schemas and backward-compatible config loading**

```ts
export const qualityGatePolicySchema = z.object({
  hands_self_review_passes: z.number().int().min(0).max(3),
  max_attempts_per_reviewer_action: z.number().int().min(1).max(3),
  require_focused_verifier_confirmation: z.literal(true),
}).strict();
```

Add optional `quality_gate` to the v2 config schema. Add the policy to `defaultConfig()` so `init` writes two passes. Preserve `undefined` when loading an existing file that omits the key. Add typed optional queue fields to `workItemProgressSchema`; do not change manifest schema version.

- [ ] **Step 5: Run focused tests and typecheck**

Run: `npx vitest run tests/core/config.test.ts tests/core/schema.test.ts tests/core/ledger.test.ts tests/core/intake.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/types.ts src/core/schema.ts src/core/config.ts src/core/ledger.ts tests/core/config.test.ts tests/core/schema.test.ts tests/core/ledger.test.ts tests/core/intake.test.ts
git commit -m "feat: add Hands quality gate contracts"
```

---

### Task 2: Require and Normalize Ordered Reviewer Actions

**Files:**

- Create: `src/workflow/reviewer-actions.ts`
- Create: `tests/workflow/reviewer-actions.test.ts`
- Modify: `src/core/types.ts`
- Modify: `src/core/schema.ts`
- Modify: `src/core/output-schemas.ts`
- Modify: `prompts/verifier-review-v2.md`
- Test: `tests/workflow/verifier.test.ts`
- Test: `tests/core/schema.test.ts`

**Interfaces:**

- Produces: `normalizeReviewerActions(review, revision): ReviewerActionQueue`.
- Produces: `validateReviewerActionQueue(queue): ReviewerActionQueue`.
- Produces: `estimateQueueCost(queue, policy): QueueCostEstimate`.
- Consumes: legacy and strict `VerifierFinding` arrays.

- [ ] **Step 1: Write failing queue validation tests**

```ts
const baseFinding = {
  severity: "medium" as const,
  file: "src/example.ts",
  line: 10,
  acceptance_criterion: "The example works",
  problem: "The example fails",
  required_fix: "Correct the example",
  re_verification: [["npm", "test", "--", "example.test.ts"]],
};
const legacyReview: VerifierReview = {
  work_item_id: "item-1",
  attempt: 2,
  final: false,
  decision: "request_changes",
  failure_class: "implementation_failure",
  blocker: null,
  acceptance_coverage: [],
  evidence_reviewed: [],
  findings: [baseFinding, { ...baseFinding, file: "src/second.ts" }],
  residual_risks: [],
};
const action = (action_id: string, order: number, depends_on: string[] = []): ReviewerAction => ({
  ...baseFinding,
  action_id,
  order,
  depends_on,
});
const queueWithDuplicateIds = { review_revision: 2, work_item_id: "item-1", actions: [action("R2-A1", 1), action("R2-A1", 2)] };
const queueWithForwardDependency = { review_revision: 2, work_item_id: "item-1", actions: [action("R2-A1", 1, ["R2-A2"]), action("R2-A2", 2)] };
const queueWithNonContiguousOrder = { review_revision: 2, work_item_id: "item-1", actions: [action("R2-A1", 1), action("R2-A2", 3)] };

expect(normalizeReviewerActions(legacyReview, 2).actions.map((action) => action.action_id))
  .toEqual(["R2-A1", "R2-A2"]);

expect(() => validateReviewerActionQueue(queueWithDuplicateIds))
  .toThrow("duplicate action_id");
expect(() => validateReviewerActionQueue(queueWithForwardDependency))
  .toThrow("must depend only on an earlier action");
expect(() => validateReviewerActionQueue(queueWithNonContiguousOrder))
  .toThrow("orders must be contiguous");
```

- [ ] **Step 2: Run queue tests and verify RED**

Run: `npx vitest run tests/workflow/reviewer-actions.test.ts tests/core/schema.test.ts tests/workflow/verifier.test.ts`

Expected: FAIL because the queue module and strict action metadata do not exist.

- [ ] **Step 3: Implement queue contracts and normalization**

```ts
export interface ReviewerActionQueue {
  review_revision: number;
  work_item_id: string;
  actions: ReviewerAction[];
}

export interface QueueCostEstimate {
  maximum_hands_calls: number;
  maximum_focused_verifier_calls: number;
  final_full_verifier_calls: 1;
}
```

Normalize missing metadata once using `R<revision>-A<index>`, array order, and empty dependencies. Strict new Verifier output requires `action_id`, `order`, and `depends_on`; the persisted-review loader accepts old artifacts and writes a normalized queue artifact before execution.

- [ ] **Step 4: Update Verifier JSON schema and prompt**

Require action metadata for newly generated `request_changes` output. The prompt must say: order fixes by dependency and risk, provide actionable verification for each, and never combine unrelated fixes into one action.

- [ ] **Step 5: Implement cost calculation**

```ts
maximum_hands_calls = actions.length
  * policy.max_attempts_per_reviewer_action
  * (1 + policy.hands_self_review_passes);
maximum_focused_verifier_calls = actions.length
  * policy.max_attempts_per_reviewer_action;
```

- [ ] **Step 6: Run tests and typecheck**

Run: `npx vitest run tests/workflow/reviewer-actions.test.ts tests/core/schema.test.ts tests/workflow/verifier.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/workflow/reviewer-actions.ts tests/workflow/reviewer-actions.test.ts src/core/types.ts src/core/schema.ts src/core/output-schemas.ts prompts/verifier-review-v2.md tests/workflow/verifier.test.ts tests/core/schema.test.ts
git commit -m "feat: normalize ordered Reviewer actions"
```

---

### Task 3: Add Structured Hands Self-Review/Fix Invocations

**Files:**

- Create: `src/workflow/self-review.ts`
- Create: `tests/workflow/self-review.test.ts`
- Create: `prompts/hands-self-review-v2.md`
- Modify: `src/core/types.ts`
- Modify: `src/core/schema.ts`
- Modify: `src/core/output-schemas.ts`
- Modify: `src/prompts/loader.ts`

**Interfaces:**

- Produces: `runHandsSelfReview(input): Promise<HandsSelfReviewResult>`.
- Consumes: active Hands profile, mutation result, current diff, evidence, active action, completed actions, and prior pass reports.
- Produces immutable `self-review/<work-item>/attempt-<n>/pass-<p>.json`.

- [ ] **Step 1: Write failing self-review tests**

```ts
expect(codex.calls[0]).toMatchObject({
  role: "hands",
  model: "active-hands-model",
  sandbox: "workspace-write",
});
expect(codex.calls[0].prompt).toContain("R2-A1");
expect(result.report.pass).toBe(1);
expect(result.reportPath).toBe("self-review/item-1/attempt-2/pass-1.json");
```

Add rejection tests for mismatched work item, parent attempt, pass, and active action ID.

- [ ] **Step 2: Run tests and verify RED**

Run: `npx vitest run tests/workflow/self-review.test.ts`

Expected: FAIL because `runHandsSelfReview` does not exist.

- [ ] **Step 3: Define strict output**

```ts
export interface HandsSelfReviewReport {
  work_item_id: string;
  parent_attempt: number;
  pass: number;
  active_action_id: string | null;
  findings: string[];
  fixes_applied: string[];
  changed_files: string[];
  commands_attempted: readonly string[][];
  remaining_findings: string[];
  ready_for_resolution_check: boolean;
}
```

Create matching Zod and Codex JSON schemas. `ready_for_resolution_check` may be true only when `remaining_findings` is empty.

- [ ] **Step 4: Implement prompt and invocation**

The prompt must instruct Hands to inspect independently, fix only approved/active-action scope, preserve completed actions, and defer unrelated findings. Use distinct artifact names per pass and write the final structured report once.

- [ ] **Step 5: Run tests and typecheck**

Run: `npx vitest run tests/workflow/self-review.test.ts tests/prompts/renderer.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/workflow/self-review.ts tests/workflow/self-review.test.ts prompts/hands-self-review-v2.md src/core/types.ts src/core/schema.ts src/core/output-schemas.ts src/prompts/loader.ts tests/prompts/renderer.test.ts
git commit -m "feat: add Hands self-review passes"
```

---

### Task 4: Add Focused Action Resolution Verifier

**Files:**

- Create: `src/workflow/action-verifier.ts`
- Create: `tests/workflow/action-verifier.test.ts`
- Create: `prompts/verifier-action-resolution-v2.md`
- Modify: `src/core/types.ts`
- Modify: `src/core/schema.ts`
- Modify: `src/core/output-schemas.ts`
- Modify: `src/prompts/loader.ts`

**Interfaces:**

- Produces: `verifyReviewerAction(input): Promise<ActionResolutionResult>`.
- Consumes: one immutable action, before/after diff, active/completed verification evidence, and self-review reports.

- [ ] **Step 1: Write failing focused-review tests**

```ts
expect(result.review).toEqual({
  review_revision: 2,
  action_id: "R2-A1",
  action_attempt: 1,
  decision: "resolved",
  evidence_reviewed: ["verification/action-R2-A1/evidence.json"],
  remaining_problem: null,
  required_next_fix: null,
});
expect(codex.calls[0]).toMatchObject({ role: "verifier", sandbox: "read-only" });
```

Add schema tests: `still_open` requires both remediation fields; `resolved` requires both null; focused review cannot reference another action.

- [ ] **Step 2: Run tests and verify RED**

Run: `npx vitest run tests/workflow/action-verifier.test.ts tests/core/schema.test.ts`

Expected: FAIL because focused action review does not exist.

- [ ] **Step 3: Implement strict result types and schemas**

```ts
export type ActionResolutionDecision = "resolved" | "still_open" | "blocked" | "replan_required";

export interface ActionResolutionReview {
  review_revision: number;
  action_id: string;
  action_attempt: number;
  decision: ActionResolutionDecision;
  evidence_reviewed: string[];
  remaining_problem: string | null;
  required_next_fix: string | null;
}
```

- [ ] **Step 4: Implement read-only focused invocation and provenance checks**

Persist under `action-reviews/<work-item>/revision-<r>/<action-id>/attempt-<n>.json`. Reject mismatched revision, action, or attempt before the runtime can advance.

- [ ] **Step 5: Run tests and typecheck**

Run: `npx vitest run tests/workflow/action-verifier.test.ts tests/core/schema.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/workflow/action-verifier.ts tests/workflow/action-verifier.test.ts prompts/verifier-action-resolution-v2.md src/core/types.ts src/core/schema.ts src/core/output-schemas.ts src/prompts/loader.ts
git commit -m "feat: add focused Reviewer action resolution"
```

---

### Task 5: Implement the Pure Queue State Machine

**Files:**

- Modify: `src/workflow/reviewer-actions.ts`
- Modify: `tests/workflow/reviewer-actions.test.ts`

**Interfaces:**

- Produces: `nextQueueAction(input): QueueTransition`.
- Consumes: immutable queue, completed IDs, active action attempt, focused decision, and policy.

- [ ] **Step 1: Write transition-table tests**

```ts
const action = (action_id: string, order: number, depends_on: string[] = []): ReviewerAction => ({
  action_id,
  order,
  depends_on,
  severity: "medium",
  file: `src/${action_id}.ts`,
  line: 1,
  acceptance_criterion: `${action_id} works`,
  problem: `${action_id} fails`,
  required_fix: `Fix ${action_id}`,
  re_verification: [["npm", "test", "--", `${action_id}.test.ts`]],
});
const queue: ReviewerActionQueue = {
  review_revision: 2,
  work_item_id: "item-1",
  actions: [action("R2-A1", 1), action("R2-A2", 2, ["R2-A1"])],
};
const base = { queue, completedActionIds: [] as string[], activeActionId: null, activeActionAttempt: 0, focusedDecision: null, maxAttemptsPerAction: 2 };
expect(nextQueueAction(base)).toEqual({ kind: "activate", action_id: "R2-A1", attempt: 1 });
expect(nextQueueAction({ ...base, activeActionId: "R2-A1", activeActionAttempt: 1, focusedDecision: "still_open" })).toEqual({ kind: "retry", action_id: "R2-A1", attempt: 2 });
expect(nextQueueAction({ ...base, activeActionId: "R2-A1", activeActionAttempt: 1, focusedDecision: "resolved" })).toEqual({ kind: "activate", action_id: "R2-A2", attempt: 1 });
expect(nextQueueAction({ ...base, activeActionId: "R2-A1", activeActionAttempt: 2, focusedDecision: "still_open" })).toEqual({ kind: "block", blocker_code: "action_fix_exhausted" });
expect(nextQueueAction({ ...base, completedActionIds: ["R2-A1", "R2-A2"] })).toEqual({ kind: "full_review" });
```

- [ ] **Step 2: Run tests and verify RED**

Run: `npx vitest run tests/workflow/reviewer-actions.test.ts`

Expected: FAIL because `nextQueueAction` is missing.

- [ ] **Step 3: Implement the discriminated transition union**

```ts
export type QueueTransition =
  | { kind: "activate" | "retry"; action_id: string; attempt: number }
  | { kind: "block"; blocker_code: "action_fix_exhausted" | "invalid_reviewer_action_queue" }
  | { kind: "replan" }
  | { kind: "full_review" };
```

Resolve the lowest-order action whose dependencies are completed. Never accept caller-supplied reordering.

- [ ] **Step 4: Run tests and commit**

Run: `npx vitest run tests/workflow/reviewer-actions.test.ts && npm run typecheck`

Expected: PASS.

```bash
git add src/workflow/reviewer-actions.ts tests/workflow/reviewer-actions.test.ts
git commit -m "feat: add ordered action queue state machine"
```

---

### Task 6: Wrap Every Hands Mutation in a Resumable Quality Gate

**Files:**

- Modify: `src/workflow/runtime.ts`
- Modify: `src/core/ledger.ts`
- Test: `tests/workflow/runtime-local.test.ts`

**Interfaces:**

- Produces private `runMutationQualityGate(input): Promise<MutationQualityGateResult>`.
- Consumes: existing `invokeHands`, deterministic verification runner, `runHandsSelfReview`, active route, and snapshotted policy.

- [ ] **Step 1: Write failing quality-gate runtime tests**

Assert exact call order for two passes:

```ts
expect(calls).toEqual([
  "hands:mutation",
  "verify:mutation",
  "hands:self-review:1",
  "verify:self-review:1",
  "hands:self-review:2",
  "verify:self-review:2",
  "verifier:full",
]);
```

Add zero-pass, unchanged-pass, usage-limit fallback, malformed self-review, and interrupted pass-resume cases.

- [ ] **Step 2: Run runtime tests and verify RED**

Run: `npx vitest run tests/workflow/runtime-local.test.ts`

Expected: FAIL because runtime invokes Verifier immediately after deterministic verification.

- [ ] **Step 3: Add runtime dependency injection and helper contract**

```ts
interface MutationQualityGateInput {
  workItem: WorkItem;
  parentAttempt: number;
  mutationKind: "initial" | "normal_fix" | "reviewer_action" | "quality_recovery";
  activeAction: ReviewerAction | null;
  completedActions: ReviewerAction[];
  implementation: ImplementationResult;
}

interface MutationQualityGateResult {
  implementation: ImplementationResult;
  finalVerification: VerificationEvidence;
  selfReviews: HandsSelfReviewReport[];
}
```

Add injectable `selfReview` and use the existing injectable verification runner.

- [ ] **Step 4: Implement durable substage ordering**

Before each invocation, persist `self_review_state: invoking` and pass number. After a structured report, persist its path. If it changed files, persist `verification_pending`, rerun deterministic verification, then mark the pass complete. When unchanged, reuse the latest valid evidence. Resume consumes completed reports and evidence without reinvocation.

- [ ] **Step 5: Route self-review through the existing backup boundary**

Use the currently active Hands profile. On confirmed primary usage exhaustion, validate backup and resume the same pass. Do not increment pass until the backup result and required verification are saved.

- [ ] **Step 6: Replace all direct mutation-to-Verifier paths**

Apply the helper after initial, normal fix, quality-recovery, integrated-final, and post-PR mutations. Preserve commit/push/delivery gates.

- [ ] **Step 7: Run tests and commit**

Run: `npx vitest run tests/workflow/runtime-local.test.ts tests/workflow/runtime-github.test.ts tests/workflow/self-review.test.ts && npm run typecheck`

Expected: PASS.

```bash
git add src/workflow/runtime.ts src/core/ledger.ts tests/workflow/runtime-local.test.ts tests/workflow/runtime-github.test.ts tests/workflow/self-review.test.ts
git commit -m "feat: run Hands self-review quality gates"
```

---

### Task 7: Integrate Ordered Action Queue Execution and Resume

**Files:**

- Modify: `src/workflow/runtime.ts`
- Modify: `src/core/ledger.ts`
- Test: `tests/workflow/runtime-local.test.ts`
- Test: `tests/workflow/e2e-dry-run.test.ts`

**Interfaces:**

- Consumes: `ReviewerActionQueue`, `nextQueueAction`, `runMutationQualityGate`, and `verifyReviewerAction`.
- Produces immutable queue artifacts under `action-queues/<work-item>/revision-<r>.json`.

- [ ] **Step 1: Write failing sequential-action tests**

Use two actions where action two depends on action one. Assert Hands receives only `R1-A1`, focused Verifier returns `still_open`, Hands retries `R1-A1`, focused Verifier resolves it, and only then Hands receives `R1-A2`.

Assert completed-action verification commands are included when action two runs.

- [ ] **Step 2: Write queue exhaustion and resume tests**

Interrupt at action mutation, pass one, post-pass verification, and focused review. Assert resume repeats no completed action/pass. Assert the configured second `still_open` result blocks with `action_fix_exhausted`.

- [ ] **Step 3: Run tests and verify RED**

Run: `npx vitest run tests/workflow/runtime-local.test.ts tests/workflow/e2e-dry-run.test.ts`

Expected: FAIL because `request_changes` still feeds all findings to one Hands invocation.

- [ ] **Step 4: Persist and execute one immutable queue revision**

On full `request_changes`, normalize and validate actions, write the queue artifact, reserve one fix cycle after the first successful action mutation, and persist active action/attempt before external work. Feed Hands only the active action plus completed summaries.

- [ ] **Step 5: Enforce resolution and regression gates**

After the mutation quality gate, run the union of current-action and completed-action re-verification commands. Invoke focused Verifier. Advance only on provenance-matching `resolved`; retry same action on `still_open`; block/replan on terminal decisions.

- [ ] **Step 6: Complete queue with full review**

After all actions resolve, mark queue complete, run the work item’s full verification, and invoke a new full Verifier review. A new `request_changes` creates revision `r + 1`; never reopen revision `r`.

- [ ] **Step 7: Run tests and commit**

Run: `npx vitest run tests/workflow/runtime-local.test.ts tests/workflow/e2e-dry-run.test.ts && npm run typecheck`

Expected: PASS.

```bash
git add src/workflow/runtime.ts src/core/ledger.ts tests/workflow/runtime-local.test.ts tests/workflow/e2e-dry-run.test.ts
git commit -m "feat: process Reviewer actions sequentially"
```

---

### Task 8: Apply Queue and Quality Gates to Final and GitHub Paths

**Files:**

- Modify: `src/workflow/runtime.ts`
- Test: `tests/workflow/runtime-github.test.ts`
- Test: `tests/workflow/runtime-local.test.ts`

**Interfaces:**

- Consumes: the same mutation quality gate and queue executor from Tasks 6–7.
- Produces identical behavior for integrated final review and post-PR review.

- [ ] **Step 1: Write failing final/post-PR scenarios**

Cover two self-review passes on an integrated fix, two ordered post-PR actions, one focused `still_open` retry, and backup activation during post-PR self-review.

- [ ] **Step 2: Run tests and verify RED**

Run: `npx vitest run tests/workflow/runtime-github.test.ts tests/workflow/runtime-local.test.ts`

Expected: FAIL because final/post-PR loops do not execute ordered queues or self-review passes.

- [ ] **Step 3: Reuse the shared helpers in both loops**

Delete remaining direct Hands-fix-to-full-Verifier paths. Keep existing commit-before-push, PR recovery, final artifact provenance, and delivery approval checks unchanged.

- [ ] **Step 4: Run tests and commit**

Run: `npx vitest run tests/workflow/runtime-github.test.ts tests/workflow/runtime-local.test.ts && npm run typecheck`

Expected: PASS.

```bash
git add src/workflow/runtime.ts tests/workflow/runtime-github.test.ts tests/workflow/runtime-local.test.ts
git commit -m "feat: enforce quality gates in final review loops"
```

---

### Task 9: Expose Queue, Pass, and Cost Status

**Files:**

- Modify: `src/workflow/status.ts`
- Modify: `src/workflow/runtime.ts`
- Modify: `src/adapters/github.ts`
- Test: `tests/workflow/status.test.ts`
- Test: `tests/workflow/runtime-github.test.ts`
- Test: `tests/adapters/github.test.ts`

**Interfaces:**

- Produces: `formatQualityGateStatus(manifest, queue, cost): string`.
- Consumes: existing marker-based `upsertRunStatus`.

- [ ] **Step 1: Write failing renderer/upsert tests**

Assert status contains review revision, active action and attempt, completed/remaining counts, self-review pass, active model/reasoning, focused decision, blocker code, and exact maximum Hands/focused-Verifier calls.

- [ ] **Step 2: Run tests and verify RED**

Run: `npx vitest run tests/workflow/status.test.ts tests/workflow/runtime-github.test.ts tests/adapters/github.test.ts`

Expected: FAIL because current status reports only the active Hands profile and backup activation.

- [ ] **Step 3: Implement pure status rendering and idempotent synchronization**

Update the one marker-delimited comment after queue creation, action activation, self-review completion, focused review, action resolution, queue completion, and blocker. Local status renders the same state without GitHub.

- [ ] **Step 4: Run tests and commit**

Run: `npx vitest run tests/workflow/status.test.ts tests/workflow/runtime-github.test.ts tests/adapters/github.test.ts && npm run typecheck`

Expected: PASS.

```bash
git add src/workflow/status.ts src/workflow/runtime.ts src/adapters/github.ts tests/workflow/status.test.ts tests/workflow/runtime-github.test.ts tests/adapters/github.test.ts
git commit -m "feat: report quality gate and action queue status"
```

---

### Task 10: Document and Verify the Complete Workflow

**Files:**

- Modify: `README.md`
- Modify: `agentic-codex-workflow.md`
- Modify: `tests/workflow/e2e-dry-run.test.ts`
- Modify: `tests/cli-smoke.test.ts`

**Interfaces:**

- Consumes: all public behavior from Tasks 1–9.
- Produces: operator documentation and final release evidence.

- [ ] **Step 1: Add end-to-end cost and resume scenarios**

Cover default two-pass approval, zero-pass compatibility, multiple ordered actions, same-action retry, action exhaustion, self-review usage fallback, queue revision two, and maximum invocation count assertions.

- [ ] **Step 2: Run end-to-end tests**

Run: `npx vitest run tests/workflow/e2e-dry-run.test.ts tests/cli-smoke.test.ts`

Expected: PASS.

- [ ] **Step 3: Document configuration and state machine**

Add the exact `quality_gate` YAML, per-mutation flow, ordered-action resolution rules, compatibility behavior, blocker codes, resume semantics, and cost formula to both operator documents.

- [ ] **Step 4: Run release verification**

Run: `npm test`

Expected: all tests pass.

Run: `npm run typecheck`

Expected: PASS.

Run: `npm run build`

Expected: PASS.

Run: `git diff --check`

Expected: no output.

Run: `npm_config_cache=/private/tmp/brain-hands-npm-cache npm pack --dry-run`

Expected: PASS with the new prompts included and package contents confined to the existing release allowlist.

- [ ] **Step 5: Commit**

```bash
git add README.md agentic-codex-workflow.md tests/workflow/e2e-dry-run.test.ts tests/cli-smoke.test.ts
git commit -m "docs: explain Hands self-review action queues"
```

---

## Final Acceptance Checklist

- [ ] New generated configuration defaults to two fresh self-review passes.
- [ ] Existing configuration without `quality_gate` keeps prior behavior.
- [ ] Every Hands mutation runs the configured number of self-review/fix passes.
- [ ] Self-review passes use distinct invocations and immutable artifacts.
- [ ] Reviewer findings normalize into a validated immutable ordered queue.
- [ ] Hands sees only the active action and completed-action summaries.
- [ ] Focused Verifier `resolved` is required before action advancement.
- [ ] `still_open` retries only the active action within its bound.
- [ ] Completed-action verification prevents regressions during later actions.
- [ ] One queue consumes one normal fix cycle.
- [ ] Usage-limit fallback resumes the exact mutation or self-review substage.
- [ ] Resume duplicates no completed action, pass, verification, or review.
- [ ] Final/post-PR paths use the same quality and queue gates.
- [ ] Local/GitHub status exposes queue, pass, profile, evidence, cost, and blockers.
- [ ] Full verification and full Verifier review run after every completed queue.
- [ ] Full test, typecheck, build, diff, and package gates pass.
