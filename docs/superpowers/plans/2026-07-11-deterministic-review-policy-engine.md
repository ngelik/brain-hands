# Deterministic Review Policy Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make one deterministic, snapshotted policy engine decide whether every work-item, final-integrated, and post-PR review advances, fixes, replans, awaits approval, continues with an authorized warning, or stops.

**Architecture:** Normalize model and deterministic-verification inputs into engine-owned findings, evaluate them with a pure policy function, persist an immutable decision before one idempotent effect, and keep complete history outside the manifest. Existing Hands self-review, backup routing, ordered action queues, and focused Verifier checks remain effect executors beneath this policy boundary.

**Tech Stack:** TypeScript 6, Node.js 20+, Zod 4, YAML, Vitest, Codex CLI structured outputs, GitHub CLI.

## Global Constraints

- The deterministic engine, never a prompt or model response, owns legal workflow transitions.
- New runs snapshot the resolved review policy; active runs without a snapshot retain legacy behavior.
- `review_revision` increments for every completed policy evaluation.
- `fix_cycles_used` increments only after a successful engine-authorized Hands fix invocation.
- Initial implementation and failed Hands invocations do not consume a fix cycle.
- Hands self-review corrections increment `self_review_mutations_used` and do not consume the policy fix budget.
- Every successful Reviewer-action fix attempt consumes one fix cycle; per-action limits remain a separate bound.
- Product verification failures become engine findings; operational failures consume no review or fix budget.
- Critical and high release blockers never auto-advance or auto-waive.
- Every effect-producing decision is immutable and persisted before the effect starts.
- Resume never repeats a completed model call, command, commit, push, replan reset, or policy effect.
- Replans patch one approved work item and reuse its issue, branch, worktree, commits, evidence, and history.
- GitHub delivery may create, update, commit, and push to a PR, but never merge it.
- V1 behavior remains unchanged.

---

## File Structure

**Create:**

- `src/workflow/review-policy.ts` — policy resolution, validation, and pure decision evaluator.
- `src/workflow/findings.ts` — criterion validation, stable finding fingerprints, repetition tracking, and JSONL persistence.
- `src/workflow/review-normalizer.ts` — convert Verifier claims and verification failures into engine findings or operational blockers.
- `src/workflow/review-cycle.ts` — immutable decision/effect state and idempotent effect ownership.
- `src/workflow/convergence.ts` — immutable convergence reports.
- `src/workflow/replan.ts` — narrow Brain replan patch generation and approved reset.
- `prompts/brain-replan-patch-v2.md` — scoped replan-patch prompt.
- `tests/workflow/review-policy.test.ts`
- `tests/workflow/findings.test.ts`
- `tests/workflow/review-normalizer.test.ts`
- `tests/workflow/review-cycle.test.ts`
- `tests/workflow/convergence.test.ts`
- `tests/workflow/replan.test.ts`

**Modify:**

- `src/core/types.ts`, `src/core/schema.ts`, `src/core/output-schemas.ts`, `src/core/config.ts`, `src/core/intake.ts`, `src/core/ledger.ts`, `src/core/run-state.ts`
- `src/workflow/planner.ts`, `src/workflow/runtime.ts`, `src/workflow/reviewer-actions.ts`, `src/workflow/action-verifier.ts`, `src/workflow/status.ts`
- `src/prompts/loader.ts`, `src/cli.ts`, `prompts/verifier-review-v2.md`
- `tests/core/config.test.ts`, `tests/core/intake.test.ts`, `tests/core/schema.test.ts`, `tests/core/ledger.test.ts`
- `tests/workflow/planner.test.ts`, `tests/workflow/runtime-local.test.ts`, `tests/workflow/runtime-github.test.ts`, `tests/workflow/reviewer-actions.test.ts`, `tests/workflow/status.test.ts`, `tests/workflow/e2e-dry-run.test.ts`
- `README.md`, `agentic-codex-workflow.md`

---

### Task 1: Close and Checkpoint the Paused Ordered-Queue Executor

**Files:**

- Modify: `src/core/ledger.ts`
- Modify: `src/core/schema.ts`
- Modify: `src/core/types.ts`
- Modify: `src/workflow/action-verifier.ts`
- Modify: `src/workflow/runtime.ts`
- Modify: `tests/workflow/runtime-local.test.ts`
- Modify: `tests/workflow/e2e-dry-run.test.ts`

**Interfaces:**

- Produces: a clean, committed queue executor baseline with no known deterministic or resume violation.
- Consumes: approved Tasks 1–6 quality-gate, queue, focused-review, and evidence contracts.

- [ ] **Step 1: Add failing boundary tests for the interrupted Task 7 review findings**

```ts
it.each([
  "after_action_mutation",
  "after_self_review_pass_1",
  "after_post_pass_verification",
  "after_focused_review_write",
  "after_queue_full_review",
])("resumes %s without repeating a completed boundary", async (boundary) => {
  const first = await runInterruptedQueue(boundary);
  const resumed = await resumeInterruptedQueue(first.runDir);
  expect(resumed.calls).toEqual(first.expectedCalls);
  expect(resumed.completedActionIds).toEqual(["R1-A1", "R1-A2"]);
});

it("cannot resolve an action when deterministic verification failed", async () => {
  const result = await runQueueWithFailedCommandAndFocusedResolved();
  expect(result.completedActionIds).toEqual(["R1-A1"]);
  expect(result.actionAttempts["R1-A1"]).toBe(2);
  expect(result.focusedVerifierCallsForFailedEvidence).toBe(0);
});
```

- [ ] **Step 2: Run the queue tests and verify RED**

Run: `npx vitest run tests/workflow/runtime-local.test.ts tests/workflow/e2e-dry-run.test.ts`

Expected: FAIL at the accepted Task 7 interruption and deterministic-failure assertions.

- [ ] **Step 3: Finish the paused safety fixes without adding policy authority**

Persist the successful action mutation before verification, discover an already-written canonical focused-review artifact on resume, keep the queue active until its full review is durably consumed, and reject focused `resolved` when deterministic evidence has a failure reason.

```ts
const deterministicFailures = verificationFailureReasons(actionEvidence, scopedBrowserChecks);
if (deterministicFailures.length > 0) {
  focusedDecision = "still_open";
  focusedRemainingProblem = deterministicFailures.join("; ");
  focusedRequiredNextFix = active.required_fix;
}

const focusedPath = progress.focused_review_path
  ?? actionResolutionReviewPath(item.id, reviewRevision, active.action_id, actionAttempt);
const focused = await loadExistingFocusedReviewIfPresent(runDir, focusedPath);

async function loadExistingFocusedReviewIfPresent(
  runDir: string,
  relativePath: string,
): Promise<ActionResolutionReview | null> {
  const absolutePath = resolveRunArtifactPath(runDir, relativePath);
  try {
    return actionResolutionReviewSchema.parse(JSON.parse(await readFile(absolutePath, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
```

- [ ] **Step 4: Verify the checkpoint**

Run: `npx vitest run tests/workflow/runtime-local.test.ts tests/workflow/e2e-dry-run.test.ts && npm run typecheck && npm run build`

Expected: PASS, with each interruption resuming without duplicate Hands, verification, focused-review, or full-review calls.

- [ ] **Step 5: Commit the clean checkpoint**

```bash
git add src/core/ledger.ts src/core/schema.ts src/core/types.ts src/workflow/action-verifier.ts src/workflow/runtime.ts tests/workflow/runtime-local.test.ts tests/workflow/e2e-dry-run.test.ts
git commit -m "feat: checkpoint resumable ordered action queues"
```

---

### Task 2: Add Canonical Policy, Release Guard, and Snapshot Contracts

**Files:**

- Modify: `src/core/types.ts`
- Modify: `src/core/schema.ts`
- Modify: `src/core/config.ts`
- Modify: `src/core/intake.ts`
- Modify: `src/core/ledger.ts`
- Modify: `src/workflow/planner.ts`
- Test: `tests/core/config.test.ts`
- Test: `tests/core/intake.test.ts`
- Test: `tests/core/schema.test.ts`
- Test: `tests/core/ledger.test.ts`
- Test: `tests/workflow/planner.test.ts`

**Interfaces:**

- Produces: `ReviewPolicy`, `ReleaseGuard`, `AcceptanceCriterion`, `ReviewAccounting`, and `RunManifestV2.review_policy_snapshot`.
- Consumes: existing v2 config, intake, manifest, and approved plan records.

- [ ] **Step 1: Write failing default, override, snapshot, and legacy tests**

```ts
it("snapshots canonical review policy and release guards for a new run", async () => {
  const manifest = await createRunLedger(newRunInput());
  expect(manifest.review_policy_snapshot?.max_fix_cycles).toBe(3);
  expect(manifest.release_guards.map((guard) => guard.id)).toEqual([
    "release:no-secrets",
    "release:no-auto-merge",
    "release:no-critical-regression",
    "release:required-verification",
  ]);
});

it("does not synthesize a policy for an existing active manifest", () => {
  const parsed = runManifestV2Schema.parse(legacyActiveManifest());
  expect(parsed.review_policy_snapshot).toBeUndefined();
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `npx vitest run tests/core/config.test.ts tests/core/intake.test.ts tests/core/schema.test.ts tests/core/ledger.test.ts tests/workflow/planner.test.ts`

Expected: FAIL because policy snapshots, release guards, and stable criterion references do not exist.

- [ ] **Step 3: Add strict contracts and canonical defaults**

```ts
export type ReviewDisposition = "blocking" | "fix_in_scope" | "requires_replan" | "follow_up" | "advisory";
export type ReviewLimitAction = "auto_replan" | "stop" | "continue_with_warning";

export interface ReviewPolicy {
  policy_revision: number;
  max_fix_cycles: number;
  on_limit: ReviewLimitAction;
  auto_advance_on_approval: boolean;
  severity_defaults: Record<"critical" | "high" | "medium" | "low", ReviewDisposition>;
  pause_on: Array<"plan_approval" | "irreversible_external_action" | "unresolved_release_blocker">;
}

export interface ReleaseGuard { id: string; description: string; }
export interface AcceptanceCriterion { ref: string; text: string; }
export interface ReviewAccounting {
  review_revision: number;
  fix_cycles_used: number;
  self_review_mutations_used: number;
  plan_revision: number;
}
```

Use `z.object(...).strict()` schemas. Map `max_hands_fix_attempts` to `max_fix_cycles` only while creating a new snapshot. Assign `BH-<sequence>:AC-<sequence>` references at approved-plan persistence and never regenerate them during resume.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `npx vitest run tests/core/config.test.ts tests/core/intake.test.ts tests/core/schema.test.ts tests/core/ledger.test.ts tests/workflow/planner.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/types.ts src/core/schema.ts src/core/config.ts src/core/intake.ts src/core/ledger.ts src/workflow/planner.ts tests/core/config.test.ts tests/core/intake.test.ts tests/core/schema.test.ts tests/core/ledger.test.ts tests/workflow/planner.test.ts
git commit -m "feat: snapshot deterministic review policy"
```

---

### Task 3: Generate Stable Finding Identity and Immutable History

**Files:**

- Create: `src/workflow/findings.ts`
- Create: `tests/workflow/findings.test.ts`
- Modify: `src/core/types.ts`
- Modify: `src/core/schema.ts`
- Modify: `src/core/ledger.ts`

**Interfaces:**

- Produces: `fingerprintFinding`, `recordFindingRevision`, `readFindingIndex`, and `EngineFinding`.
- Consumes: approved criterion references, release guards, and immutable ledger primitives.

```ts
export interface FindingIdentityInput {
  work_item_id: string;
  criterion_ref: string;
  source: "verifier" | "verification" | "release_guard";
  normalized_location: string;
  problem_class: string;
}

export interface FindingSummary {
  finding_id: string;
  work_item_id: string;
  severity: "critical" | "high" | "medium" | "low";
  disposition: ReviewDisposition;
  first_seen_revision: number;
  last_seen_revision: number;
  occurrences: number;
}
```

- [ ] **Step 1: Write failing identity and append-only tests**

```ts
it("keeps identity stable across wording changes", () => {
  const first = fingerprintFinding(findingInput({ problem: "test is red" }));
  const reworded = fingerprintFinding(findingInput({ problem: "the test failed" }));
  expect(first).toBe(reworded);
});

it("records repetition without rewriting prior revisions", async () => {
  await recordFindingRevision(runDir, firstRevision);
  await recordFindingRevision(runDir, secondRevision);
  const lines = await readFileLines(findingHistoryPath(runDir, "BH-005"));
  expect(lines).toHaveLength(2);
  expect(JSON.parse(lines[1]!).occurrences).toBe(2);
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `npx vitest run tests/workflow/findings.test.ts tests/core/ledger.test.ts`

Expected: FAIL because the finding module and compact index are absent.

- [ ] **Step 3: Implement deterministic fingerprints and safe JSONL appends**

```ts
export function fingerprintFinding(input: FindingIdentityInput): string {
  const canonical = JSON.stringify([
    input.work_item_id,
    input.criterion_ref,
    input.source,
    normalizeLocation(input.normalized_location),
    normalizeProblemClass(input.problem_class),
  ]);
  return `finding:${createHash("sha256").update(canonical).digest("hex")}`;
}
```

Validate every record before append, lock the work-item history for one writer, append one newline-terminated JSON object, fsync, and update only the compact manifest summary after the immutable record succeeds.

- [ ] **Step 4: Verify and commit**

Run: `npx vitest run tests/workflow/findings.test.ts tests/core/ledger.test.ts && npm run typecheck`

```bash
git add src/workflow/findings.ts tests/workflow/findings.test.ts src/core/types.ts src/core/schema.ts src/core/ledger.ts
git commit -m "feat: track stable review findings"
```

---

### Task 4: Normalize Verifier Claims and Deterministic Verification Failures

**Files:**

- Create: `src/workflow/review-normalizer.ts`
- Create: `tests/workflow/review-normalizer.test.ts`
- Modify: `src/core/types.ts`
- Modify: `src/core/schema.ts`
- Modify: `prompts/verifier-review-v2.md`
- Modify: `tests/workflow/verifier.test.ts`

**Interfaces:**

- Produces: `normalizeReviewInputs(input): NormalizedReviewInput`.
- Consumes: `VerifierReview`, `VerificationEvidence`, approved criteria, release guards, and severity defaults.

```ts
export interface OperationalBlocker {
  code: "invalid_verifier_contract" | "transport_failure" | "permission_failure" | "network_failure" | "catalog_failure" | "corrupt_state";
  message: string;
  phase: "work_item" | "final_integrated" | "post_pr";
  evidence_refs: string[];
}
```

- [ ] **Step 1: Write failing claim-validation and failure-classification tests**

```ts
it.each([
  ["approve_with_blocker", "invalid_verifier_contract"],
  ["unknown_criterion", "invalid_verifier_contract"],
  ["high_advisory", "invalid_verifier_contract"],
])("rejects %s", (fixture, code) => {
  expect(normalizeReviewInputs(reviewFixture(fixture))).toMatchObject({ operational_blocker: { code } });
});

it("turns a failed required command into an engine finding", () => {
  const result = normalizeReviewInputs(failedCommandFixture());
  expect(result.findings[0]).toMatchObject({
    source: "verification",
    severity: "high",
    disposition: "fix_in_scope",
    criterion_ref: "BH-005:AC-3",
  });
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `npx vitest run tests/workflow/review-normalizer.test.ts tests/workflow/verifier.test.ts`

Expected: FAIL because Verifier output still directly controls decision fields and verification failures are not findings.

- [ ] **Step 3: Implement fail-closed normalization**

```ts
export type NormalizedReviewInput =
  | { findings: EngineFinding[]; operational_blocker: null }
  | { findings: []; operational_blocker: OperationalBlocker };

export function normalizeReviewInputs(input: NormalizeReviewInput): NormalizedReviewInput {
  const claimError = validateVerifierClaims(input.review, input.criteria, input.releaseGuards);
  if (claimError) return { findings: [], operational_blocker: claimError };
  return {
    findings: mergeAndFingerprint([
      ...normalizeVerifierFindings(input),
      ...normalizeVerificationFailures(input),
      ...normalizeReleaseGuardFailures(input),
    ]),
    operational_blocker: null,
  };
}
```

Keep transport, permission, network, model-catalog, and corrupt-state failures as operational blockers. Update the prompt to request evidence-backed claims without durable IDs or transition commands.

- [ ] **Step 4: Verify and commit**

Run: `npx vitest run tests/workflow/review-normalizer.test.ts tests/workflow/verifier.test.ts && npm run typecheck`

```bash
git add src/workflow/review-normalizer.ts tests/workflow/review-normalizer.test.ts src/core/types.ts src/core/schema.ts prompts/verifier-review-v2.md tests/workflow/verifier.test.ts
git commit -m "feat: normalize review evidence into findings"
```

---

### Task 5: Build the Pure Review Policy Evaluator

**Files:**

- Create: `src/workflow/review-policy.ts`
- Create: `tests/workflow/review-policy.test.ts`
- Modify: `src/core/types.ts`
- Modify: `src/core/schema.ts`

**Interfaces:**

- Produces: `evaluateReviewPolicy(input): ReviewPolicyDecision` and `resolveReviewPolicy(config, override)`.
- Consumes: `ReviewPolicy`, normalized findings, verification status, accounting, phase, and optional authorization.

```ts
export interface ReviewPolicyDecision {
  action: "advance" | "fix" | "create_replan" | "await_plan_approval" | "continue_with_warning" | "stop";
  reason_code: string;
  finding_ids: string[];
  policy_revision: number;
  authorization_required: boolean;
}

export interface EvaluateReviewPolicyInput {
  policy: ReviewPolicy;
  findings: EngineFinding[];
  accounting: ReviewAccounting;
  phase: "work_item" | "final_integrated" | "post_pr";
  operational_blocker: null;
  replan_patch_pending: boolean;
  authorization: WarningContinuationAuthorization | null;
}
```

- [ ] **Step 1: Write the table-driven decision tests**

```ts
it.each([
  ["no findings", noFindings(), "advance"],
  ["in-scope blocker with budget", blockerWithBudget(), "fix"],
  ["scope change", requiresReplan(), "create_replan"],
  ["unapproved patch", unapprovedPatch(), "await_plan_approval"],
  ["limit with blockers", exhaustedWithBlockers(), "create_replan"],
  ["authorized warning", authorizedWarning(), "continue_with_warning"],
  ["critical release blocker", criticalReleaseBlocker(), "stop"],
])("decides %s", (_name, input, action) => {
  expect(evaluateReviewPolicy(input).action).toBe(action);
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `npx vitest run tests/workflow/review-policy.test.ts`

Expected: FAIL because the evaluator does not exist.

- [ ] **Step 3: Implement a total, side-effect-free evaluator**

```ts
export function evaluateReviewPolicy(input: EvaluateReviewPolicyInput): ReviewPolicyDecision {
  if (input.operational_blocker) throw new Error("Operational blockers are outside review policy");
  const blocking = input.findings.filter(isBlockingFinding);
  const criticalHigh = blocking.filter((finding) => finding.severity === "critical" || finding.severity === "high");
  if (criticalHigh.some(isReleaseGuardFinding)) return decision("stop", "critical_high_release_blocker", criticalHigh, input);
  if (input.replan_patch_pending) return decision("await_plan_approval", "replan_patch_pending", blocking, input);
  if (blocking.some((finding) => finding.disposition === "requires_replan")) return decision("create_replan", "plan_change_required", blocking, input);
  if (blocking.length === 0) return decision("advance", "no_blocking_findings", input.findings, input);
  if (input.accounting.fix_cycles_used < input.policy.max_fix_cycles) return decision("fix", "fix_budget_available", blocking, input);
  if (canContinueWithWarning(input, blocking)) return decision("continue_with_warning", "authorized_warning", blocking, input);
  return input.policy.on_limit === "stop"
    ? decision("stop", "fix_limit_reached", blocking, input)
    : decision("create_replan", "fix_limit_reached", blocking, input);
}
```

Ensure all actions have deterministic reason codes and sorted finding IDs. Freeze inputs in tests and prove the evaluator does not mutate them.

- [ ] **Step 4: Verify and commit**

Run: `npx vitest run tests/workflow/review-policy.test.ts && npm run typecheck`

```bash
git add src/workflow/review-policy.ts tests/workflow/review-policy.test.ts src/core/types.ts src/core/schema.ts
git commit -m "feat: add pure review policy evaluator"
```

---

### Task 6: Persist Review Accounting and Idempotent Decision Cycles

**Files:**

- Create: `src/workflow/review-cycle.ts`
- Create: `tests/workflow/review-cycle.test.ts`
- Modify: `src/core/types.ts`
- Modify: `src/core/schema.ts`
- Modify: `src/core/ledger.ts`
- Modify: `tests/core/ledger.test.ts`

**Interfaces:**

- Produces: `beginReviewCycle`, `claimReviewEffect`, `completeReviewEffect`, and `incrementSuccessfulFix`.
- Consumes: immutable ledger writes, policy hash, normalized finding IDs, and `ReviewPolicyDecision`.

```ts
export interface ReviewCycleState {
  cycle_id: string;
  work_item_id: string;
  phase: "work_item" | "final_integrated" | "post_pr";
  review_revision: number;
  decision_path: string;
  effect_id: string;
  effect_state: "pending" | "in_progress" | "complete" | "blocked";
  decision: ReviewPolicyDecision;
}
```

- [ ] **Step 1: Write failing crash/replay and counter tests**

```ts
it("reuses a persisted decision without reevaluating", async () => {
  const first = await beginReviewCycle(input);
  const resumed = await beginReviewCycle(input);
  expect(resumed).toEqual(first);
  expect(evaluatorCalls).toBe(1);
});

it.each([
  ["initial", false],
  ["failed_fix", false],
  ["successful_fix", true],
  ["successful_action_fix", true],
  ["self_review_fix", false],
])("accounts for %s", (_kind, consumesFixCycle) => {
  expect(nextAccounting(accounting(), mutationFixture(_kind)).fix_cycles_used).toBe(consumesFixCycle ? 1 : 0);
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `npx vitest run tests/workflow/review-cycle.test.ts tests/core/ledger.test.ts`

Expected: FAIL because decisions and effects are not first-class persisted state.

- [ ] **Step 3: Implement decision-before-effect persistence**

```ts
export async function beginReviewCycle(input: BeginReviewCycleInput): Promise<ReviewCycleState> {
  const path = reviewDecisionPath(input.work_item_id, input.review_revision);
  const existing = await readOptionalValidatedArtifact(input.run_dir, path, reviewCycleStateSchema);
  if (existing) return assertCycleProvenance(existing, input);
  const decision = input.evaluate();
  return writeCreateOnceValidated(input.run_dir, path, {
    cycle_id: cycleId(input),
    work_item_id: input.work_item_id,
    phase: input.phase,
    review_revision: input.review_revision,
    decision_path: path,
    effect_id: effectId(input, decision),
    effect_state: "pending",
    decision,
  });
}
```

Use a claim marker before every effect. A completed claim returns its persisted result; a blocked or ambiguous claim cannot be generically retried.

- [ ] **Step 4: Verify and commit**

Run: `npx vitest run tests/workflow/review-cycle.test.ts tests/core/ledger.test.ts && npm run typecheck`

```bash
git add src/workflow/review-cycle.ts tests/workflow/review-cycle.test.ts src/core/types.ts src/core/schema.ts src/core/ledger.ts tests/core/ledger.test.ts
git commit -m "feat: persist idempotent review decisions"
```

---

### Task 7: Refactor the Work-Item Loop to Decision Then Effect

**Files:**

- Modify: `src/workflow/runtime.ts`
- Modify: `src/core/run-state.ts`
- Modify: `tests/workflow/runtime-local.test.ts`
- Modify: `tests/workflow/e2e-dry-run.test.ts`

**Interfaces:**

- Produces: one work-item review path using normalize → record findings → evaluate → persist → effect.
- Consumes: Tasks 3–6 and the existing mutation quality gate.

- [ ] **Step 1: Add failing work-item policy scenarios**

```ts
it.each([
  ["advisory request_changes", "local_ready", 0],
  ["verification failure", "local_ready", 1],
  ["operational failure", "human_action_required", 0],
  ["replan finding", "human_action_required", 0],
])("routes %s through policy", async (_name, status, fixCycles) => {
  const result = await runPolicyScenario(_name);
  expect(result.status).toBe(status);
  expect(result.accounting.fix_cycles_used).toBe(fixCycles);
  expect(result.decisionArtifacts).toHaveLength(result.accounting.review_revision);
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `npx vitest run tests/workflow/runtime-local.test.ts tests/workflow/e2e-dry-run.test.ts`

Expected: FAIL because `runtime.ts` still branches directly on Verifier decisions and pass numbers.

- [ ] **Step 3: Replace the policy-enabled work-item branch**

```ts
const normalized = normalizeReviewInputs(reviewInput);
if (normalized.operational_blocker) return recordOperationalBlocker(normalized.operational_blocker);
const recorded = await recordFindingRevision(runDir, normalized.findings);
const cycle = await beginReviewCycle({
  run_dir: runDir,
  work_item_id: item.id,
  phase: "work_item",
  review_revision: accounting.review_revision + 1,
  policy_hash: hashPolicy(policy),
  finding_ids: recorded.map((finding) => finding.finding_id),
  evaluate: () => evaluateReviewPolicy(policyInput(recorded)),
});
return executeWorkItemDecision(cycle);
```

Keep the old loop only for manifests without `review_policy_snapshot`. Remove hard-coded three-pass decisions from the policy-enabled branch. Increment `fix_cycles_used` only after the Hands report is validated and durably persisted.

- [ ] **Step 4: Verify and commit**

Run: `npx vitest run tests/workflow/runtime-local.test.ts tests/workflow/e2e-dry-run.test.ts && npm run typecheck && npm run build`

```bash
git add src/workflow/runtime.ts src/core/run-state.ts tests/workflow/runtime-local.test.ts tests/workflow/e2e-dry-run.test.ts
git commit -m "feat: drive work items with review policy"
```

---

### Task 8: Put Ordered Actions Beneath the Fix Effect

**Files:**

- Modify: `src/workflow/runtime.ts`
- Modify: `src/workflow/reviewer-actions.ts`
- Modify: `src/workflow/action-verifier.ts`
- Modify: `tests/workflow/reviewer-actions.test.ts`
- Modify: `tests/workflow/runtime-local.test.ts`

**Interfaces:**

- Produces: `executeOrderedFixEffect(cycle, queue): FixEffectResult`.
- Consumes: a persisted policy decision whose action is exactly `fix`.

- [ ] **Step 1: Write failing authority and accounting tests**

```ts
it("does not let focused resolved override deterministic failure", async () => {
  const result = await executeQueue(queueFixture(), { commandExitCode: 1, focusedDecision: "resolved" });
  expect(result.advanced).toBe(false);
});

it("charges each successful action attempt to the fix budget", async () => {
  const result = await executeQueue(twoActionsWithOneRetry());
  expect(result.accounting.fix_cycles_used).toBe(3);
  expect(result.completed_action_ids).toEqual(["R1-A1", "R1-A2"]);
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `npx vitest run tests/workflow/reviewer-actions.test.ts tests/workflow/runtime-local.test.ts`

Expected: FAIL because the checkpointed queue still has direct replan/advance authority and queue-level accounting.

- [ ] **Step 3: Restrict the queue to effect execution**

```ts
export type FixEffectResult =
  | { kind: "complete"; successful_hands_fixes: number; evidence_paths: string[] }
  | { kind: "still_blocking"; successful_hands_fixes: number; evidence_paths: string[] }
  | { kind: "operationally_blocked"; blocker: OperationalBlocker };
```

The queue returns evidence and completion state only. It cannot transition the run or create a replan. After the effect, the engine performs a new review revision and policy evaluation. Persist the fix counter immediately after each successful Hands invocation so a crash cannot make it free or double-charge it.

- [ ] **Step 4: Verify and commit**

Run: `npx vitest run tests/workflow/reviewer-actions.test.ts tests/workflow/runtime-local.test.ts tests/workflow/e2e-dry-run.test.ts && npm run typecheck`

```bash
git add src/workflow/runtime.ts src/workflow/reviewer-actions.ts src/workflow/action-verifier.ts tests/workflow/reviewer-actions.test.ts tests/workflow/runtime-local.test.ts tests/workflow/e2e-dry-run.test.ts
git commit -m "refactor: execute Reviewer actions under policy"
```

---

### Task 9: Add Convergence Reports

**Files:**

- Create: `src/workflow/convergence.ts`
- Create: `tests/workflow/convergence.test.ts`
- Modify: `src/core/types.ts`
- Modify: `src/core/schema.ts`
- Modify: `src/core/ledger.ts`
- Modify: `src/workflow/runtime.ts`

**Interfaces:**

- Produces: `writeConvergenceReport(input): string`.
- Consumes: policy snapshot, accounting, finding index, fix effects, release guards, and authorization.

- [ ] **Step 1: Write failing immutable report tests**

```ts
it("records exhausted convergence without rewriting history", async () => {
  const path = await writeConvergenceReport(exhaustedInput());
  const report = convergenceReportSchema.parse(await readJson(path));
  expect(report.unresolved_finding_ids).toEqual(["finding:a"]);
  expect(report.fix_cycles_used).toBe(3);
  await expect(writeConvergenceReport(conflictingExhaustedInput())).rejects.toThrow(/already exists/i);
});
```

- [ ] **Step 2: Run RED, implement, and verify**

Run: `npx vitest run tests/workflow/convergence.test.ts`

```ts
export interface ConvergenceReport {
  work_item_id: string;
  plan_revision: number;
  review_revision: number;
  fix_cycles_used: number;
  unresolved_finding_ids: string[];
  resolved_finding_ids: string[];
  repeated_finding_ids: string[];
  advisory_finding_ids: string[];
  evidence_refs: string[];
  remaining_release_guards: string[];
  recommended_action: "advance" | "create_replan" | "stop";
}
```

Run: `npx vitest run tests/workflow/convergence.test.ts tests/workflow/runtime-local.test.ts && npm run typecheck`

- [ ] **Step 3: Commit**

```bash
git add src/workflow/convergence.ts tests/workflow/convergence.test.ts src/core/types.ts src/core/schema.ts src/core/ledger.ts src/workflow/runtime.ts
git commit -m "feat: write immutable convergence reports"
```

---

### Task 10: Generate Narrow Replan Patches

**Files:**

- Create: `src/workflow/replan.ts`
- Create: `prompts/brain-replan-patch-v2.md`
- Create: `tests/workflow/replan.test.ts`
- Modify: `src/core/types.ts`
- Modify: `src/core/schema.ts`
- Modify: `src/core/output-schemas.ts`
- Modify: `src/prompts/loader.ts`
- Modify: `src/workflow/runtime.ts`

**Interfaces:**

- Produces: `createReplanPatch(input): ReplanPatchResult`.
- Consumes: target work item, base plan revision, unresolved finding IDs, convergence report, guards, and evidence paths.

- [ ] **Step 1: Write failing scope and structured-output tests**

```ts
it("rejects a patch targeting another work item or base revision", async () => {
  await expect(createReplanPatch(inputWithForeignTarget())).rejects.toThrow(/target work item/i);
  await expect(createReplanPatch(inputWithWrongBaseRevision())).rejects.toThrow(/base plan revision/i);
});

it("persists one immutable patch without replacing the plan", async () => {
  const result = await createReplanPatch(validInput());
  expect(result.patch.target_work_item_id).toBe("BH-005");
  expect(result.patch.unresolved_finding_ids).toEqual(["finding:a"]);
  expect(result.path).toContain("replans/");
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `npx vitest run tests/workflow/replan.test.ts tests/prompts/renderer.test.ts`

Expected: FAIL because the Brain replan role and schema do not exist.

- [ ] **Step 3: Implement the strict patch contract and prompt**

```ts
export interface ReplanPatch {
  target_work_item_id: string;
  base_plan_revision: number;
  unresolved_finding_ids: string[];
  revised_objective?: string;
  added_or_changed_criteria: AcceptanceCriterion[];
  changed_instructions: string[];
  explicitly_rejected_hardening: string[];
}
```

The prompt receives no unrelated work items and explicitly forbids replacing IDs, branches, issues, worktrees, commits, or completed-item state.

- [ ] **Step 4: Verify and commit**

Run: `npx vitest run tests/workflow/replan.test.ts tests/prompts/renderer.test.ts && npm run typecheck`

```bash
git add src/workflow/replan.ts prompts/brain-replan-patch-v2.md tests/workflow/replan.test.ts src/core/types.ts src/core/schema.ts src/core/output-schemas.ts src/prompts/loader.ts src/workflow/runtime.ts
git commit -m "feat: create narrow replan patches"
```

---

### Task 11: Approve and Resume Replans Idempotently

**Files:**

- Modify: `src/cli.ts`
- Modify: `src/core/run-state.ts`
- Modify: `src/core/ledger.ts`
- Modify: `src/workflow/replan.ts`
- Modify: `tests/cli-smoke.test.ts`
- Modify: `tests/workflow/replan.test.ts`
- Modify: `tests/workflow/runtime-local.test.ts`

**Interfaces:**

- Produces: `approveReplanPatch(runDir, workItemId, planRevision)`.
- Consumes: an immutable pending replan patch and existing worktree/branch state.

- [ ] **Step 1: Write failing targeted-reset and duplicate-approval tests**

```ts
it("resets only the approved target and reuses its worktree", async () => {
  const before = await readManifestV2(runDir);
  const after = await approveReplanPatch(runDir, "BH-005", 2);
  expect(after.worktree_path).toBe(before.worktree_path);
  expect(after.work_item_progress["BH-005"]?.fix_cycles_used).toBe(0);
  expect(after.work_item_progress["BH-004"]).toEqual(before.work_item_progress["BH-004"]);
});

it("does not reset twice after duplicate approval", async () => {
  await approveReplanPatch(runDir, "BH-005", 2);
  await approveReplanPatch(runDir, "BH-005", 2);
  expect(eventsOfType(runDir, "approved_replan_attempt_reset")).toHaveLength(1);
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `npx vitest run tests/workflow/replan.test.ts tests/workflow/runtime-local.test.ts tests/cli-smoke.test.ts`

Expected: FAIL because CLI resume rejects `replanning` and no targeted reset exists.

- [ ] **Step 3: Implement approval and first-class resume**

On approval, validate the patch, append the plan revision, set the item’s `plan_revision`, reset `fix_cycles_used`, clear only active evidence/review/decision/queue pointers, append the idempotency event, transition to `worktree_setup`, and retain `worktree_path` and `branch_name`.

```ts
if (manifest.stage === "replanning") return createOrShowPendingPatch(runDir);
if (manifest.stage === "awaiting_plan_approval" && pendingPatch(manifest)) {
  return approveReplanPatch(runDir, manifest.current_work_item_id!, approvedRevision);
}
```

- [ ] **Step 4: Verify and commit**

Run: `npx vitest run tests/workflow/replan.test.ts tests/workflow/runtime-local.test.ts tests/cli-smoke.test.ts && npm run typecheck && npm run build`

```bash
git add src/cli.ts src/core/run-state.ts src/core/ledger.ts src/workflow/replan.ts tests/cli-smoke.test.ts tests/workflow/replan.test.ts tests/workflow/runtime-local.test.ts
git commit -m "feat: resume approved replan patches"
```

---

### Task 12: Apply Policy Parity to Final-Integrated and Post-PR Review

**Files:**

- Modify: `src/workflow/runtime.ts`
- Modify: `src/adapters/github.ts`
- Modify: `tests/workflow/runtime-local.test.ts`
- Modify: `tests/workflow/runtime-github.test.ts`

**Interfaces:**

- Produces: final-integrated and post-PR decisions using Tasks 3–6 with phase-specific effects only.
- Consumes: the same policy snapshot, finding normalizer, decision ledger, counters, and convergence/replan paths.

- [ ] **Step 1: Write failing phase-parity tests**

```ts
it.each(["final_integrated", "post_pr"] as const)("uses policy in %s", async (phase) => {
  const result = await runPhaseScenario(phase, "medium_fix_then_approve");
  expect(result.decisions.map((decision) => decision.phase)).toEqual([phase, phase]);
  expect(result.accounting.fix_cycles_used).toBe(1);
});

it("pushes an approved post-PR fix but never merges", async () => {
  const result = await runPhaseScenario("post_pr", "approved_fix");
  expect(result.github.pushCalls).toBe(1);
  expect(result.github.mergeCalls).toBe(0);
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `npx vitest run tests/workflow/runtime-local.test.ts tests/workflow/runtime-github.test.ts`

Expected: FAIL because final and post-PR loops still have independent pass-limit branches.

- [ ] **Step 3: Replace both duplicated decision loops**

Call the same normalize, record, evaluate, persist, and effect functions with `phase: "final_integrated"` or `phase: "post_pr"`. Retain strict delivery proof, PR identity validation, commit/push idempotency, and no merge method in the effect executor.

- [ ] **Step 4: Verify and commit**

Run: `npx vitest run tests/workflow/runtime-local.test.ts tests/workflow/runtime-github.test.ts tests/workflow/e2e-dry-run.test.ts && npm run typecheck && npm run build`

```bash
git add src/workflow/runtime.ts src/adapters/github.ts tests/workflow/runtime-local.test.ts tests/workflow/runtime-github.test.ts tests/workflow/e2e-dry-run.test.ts
git commit -m "refactor: unify final review policy"
```

---

### Task 13: Add Explicit Warning-Continuation Authorization

**Files:**

- Modify: `src/core/types.ts`
- Modify: `src/core/schema.ts`
- Modify: `src/core/intake.ts`
- Modify: `src/core/ledger.ts`
- Modify: `src/workflow/review-policy.ts`
- Modify: `src/workflow/runtime.ts`
- Test: `tests/core/intake.test.ts`
- Test: `tests/workflow/review-policy.test.ts`
- Test: `tests/workflow/runtime-local.test.ts`

**Interfaces:**

- Produces: `WarningContinuationAuthorization` and immutable authorization artifacts.
- Consumes: unresolved finding IDs, evidence snapshot, policy revision, and actor/source authority.

- [ ] **Step 1: Write failing schema and runtime rejection tests**

```ts
it("rejects repository-default waiver authority", () => {
  expect(() => authorizationSchema.parse(repoDefaultAuthorization())).toThrow();
});

it.each(["critical", "high"])("cannot waive a %s release blocker", (severity) => {
  expect(evaluateReviewPolicy(authorizedReleaseBlocker(severity)).action).toBe("stop");
});
```

- [ ] **Step 2: Run RED and implement the exact record**

Run: `npx vitest run tests/core/intake.test.ts tests/workflow/review-policy.test.ts tests/workflow/runtime-local.test.ts`

```ts
export interface WarningContinuationAuthorization {
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

Persist the record create-once under `authorizations/`; bind it to the exact policy revision and finding set before allowing `continue_with_warning`.

- [ ] **Step 3: Verify and commit**

Run: `npx vitest run tests/core/intake.test.ts tests/workflow/review-policy.test.ts tests/workflow/runtime-local.test.ts && npm run typecheck`

```bash
git add src/core/types.ts src/core/schema.ts src/core/intake.ts src/core/ledger.ts src/workflow/review-policy.ts src/workflow/runtime.ts tests/core/intake.test.ts tests/workflow/review-policy.test.ts tests/workflow/runtime-local.test.ts
git commit -m "feat: authorize warning continuation"
```

---

### Task 14: Update Operator States, GitHub Status, and Documentation

**Files:**

- Modify: `src/workflow/status.ts`
- Modify: `src/adapters/github.ts`
- Modify: `src/cli.ts`
- Modify: `tests/workflow/status.test.ts`
- Modify: `tests/adapters/github.test.ts`
- Modify: `tests/cli-smoke.test.ts`
- Modify: `README.md`
- Modify: `agentic-codex-workflow.md`

**Interfaces:**

- Produces: explicit operator state in text, JSON, logs, and idempotent GitHub status comments.
- Consumes: manifest stage, policy decision, operational blocker, release blocker, authorization, and delivery proof.

- [ ] **Step 1: Write failing state-rendering tests**

```ts
it.each([
  ["progressing_automatically", "Progressing automatically"],
  ["awaiting_plan_approval", "Awaiting plan approval"],
  ["awaiting_irreversible_action_authority", "Awaiting irreversible-action authority"],
  ["operationally_blocked", "Operationally blocked"],
  ["unresolved_release_blocker", "Unresolved release blocker"],
  ["delivered", "Delivered"],
])("renders %s", (state, label) => {
  expect(renderRunStatus(statusFixture(state))).toContain(label);
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `npx vitest run tests/workflow/status.test.ts tests/adapters/github.test.ts tests/cli-smoke.test.ts`

Expected: FAIL because status still collapses many cases into `human_action_required`.

- [ ] **Step 3: Implement explicit status projection**

Map internal state to one operator state without changing policy decisions. Include review revision, fix usage/limit, plan revision, active finding IDs, next automatic effect, and exact approval boundary. Upsert one marker-keyed GitHub status comment; do not append duplicates. Normal automatic execution prints no reply menu.

- [ ] **Step 4: Update docs and verify**

Document policy YAML, counter semantics, release guards, finding artifacts, replans, authorizations, resume behavior, and no-auto-merge guarantee.

Run: `npx vitest run tests/workflow/status.test.ts tests/adapters/github.test.ts tests/cli-smoke.test.ts && npm run typecheck`

- [ ] **Step 5: Commit**

```bash
git add src/workflow/status.ts src/adapters/github.ts src/cli.ts tests/workflow/status.test.ts tests/adapters/github.test.ts tests/cli-smoke.test.ts README.md agentic-codex-workflow.md
git commit -m "docs: expose deterministic review policy status"
```

---

### Task 15: Complete Crash, Replay, Compatibility, and Release Verification

**Files:**

- Modify: `tests/workflow/e2e-dry-run.test.ts`
- Modify: `tests/workflow/runtime-local.test.ts`
- Modify: `tests/workflow/runtime-github.test.ts`
- Modify: `tests/core/config.test.ts`
- Modify: `tests/core/ledger.test.ts`

**Interfaces:**

- Produces: end-to-end proof for the full design and release gates.
- Consumes: all prior tasks.

- [ ] **Step 1: Add the complete interruption matrix**

```ts
it.each([
  "after_normalization",
  "after_decision_write",
  "after_effect_claim",
  "after_hands_success",
  "after_effect_completion",
  "after_convergence_report",
  "after_replan_patch",
  "after_replan_approval_reset",
  "after_commit",
  "after_push",
])("resumes %s exactly once", async (boundary) => {
  const interrupted = await runToBoundary(boundary);
  const resumed = await resumeRun(interrupted.runDir);
  expect(resumed.duplicateExternalEffects).toEqual([]);
  expect(resumed.manifest.review_policy_snapshot).toEqual(interrupted.policySnapshot);
});
```

- [ ] **Step 2: Add compatibility and scenario coverage**

Cover automatic advisory advancement, command failure followed by fix, operational blocker with zero budget use, repeated finding identity, unresolved release blocker, authorized warning continuation, narrow replan and duplicate approval, final-integrated fix, post-PR push, old V2 config loading, active manifest without snapshot, and V1 unchanged behavior.

- [ ] **Step 3: Run focused and full verification**

Run: `npx vitest run tests/workflow/e2e-dry-run.test.ts tests/workflow/runtime-local.test.ts tests/workflow/runtime-github.test.ts tests/core/config.test.ts tests/core/ledger.test.ts`

Expected: PASS.

Run: `npm test && npm run typecheck && npm run build && npm pack --dry-run && git diff --check`

Expected: all tests pass, typecheck/build succeed, package contents remain within the declared runtime surface, and no whitespace errors exist.

- [ ] **Step 4: Final design-conformance review**

Search for direct decision branches in policy-enabled runtime code:

Run: `rg -n "review\.decision|finalReview\.decision|maxHandsFixAttempts|human_action_required" src/workflow/runtime.ts`

Expected: remaining matches are limited to the explicitly named legacy path, adapter normalization, or operator projection; no policy-enabled branch performs a direct transition from model output.

- [ ] **Step 5: Commit**

```bash
git add tests/workflow/e2e-dry-run.test.ts tests/workflow/runtime-local.test.ts tests/workflow/runtime-github.test.ts tests/core/config.test.ts tests/core/ledger.test.ts
git commit -m "test: verify deterministic review policy recovery"
```
