# Deterministic Plan Approval Requests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Repository instructions permit subagents only when the user explicitly asks for them.

**Goal:** Reduce approval fatigue without weakening safety by asking for plan approval only after the controller has persisted and validated the exact resulting plan, its deterministic delta, and its complete same-run approval subject.

**Architecture:** Treat plan approval as one gate with two presentations: a complete initial-plan summary and a delta-first replan summary. Before entering `awaiting_plan_approval`, persist the exact plan revision plus a canonical `PlanApprovalRequestV1`; a replan must therefore be materialized and pass all readiness checks before the user can approve it. While that replan is pending, `current_revision` and `approved_revision` remain on the executable approved base and `pending_plan_approval.proposed_revision` identifies the unapproved candidate. Approval atomically promotes the proposed revision, clears the pending pointer, and records a subject-bound event. Same-run idempotence remains supported; cross-run carry-forward is explicitly excluded.

**Tech Stack:** TypeScript 6, Node.js 20+, Commander 15, Zod 4, Vitest 4.

## Global Constraints

- Work on `main`; do not create a feature branch unless the user changes the instruction.
- Preserve unrelated worktree changes and touch only files named by the active task.
- Discovery-brief approval and plan approval remain separate gates. Discovery approval never authorizes implementation.
- A plan approval authorizes exact persisted plan bytes. No field inside `plans/revision-N.md` is treated as display-only.
- Controller-authored status wording is display-only and must not participate in the approval subject.
- Same-run `resume` is the normal recovery mechanism. Do not add replacement-run or cross-run approval carry-forward.
- Replan candidates must be materialized, schema-validated, readiness-validated, and discovery-bound before `awaiting_plan_approval` is committed.
- A replan approval command must never create or modify the plan being approved.
- Model prose and semantic similarity never decide approval equivalence, no-op status, or delta classification.
- Approval reuse is exact and same-run only: the same request/subject digest is idempotent; any changed subject component requires a fresh approval event.
- `run-configuration.json`, controller provenance, source commit, workflow protocol, approved discovery brief, authority policy, plan bytes, and decision contract are approval-subject inputs.
- `run-configuration.json` is create-once, its SHA-256 is stored in the manifest, and generic artifact APIs cannot replace it.
- The recorded controller is required to approve the subject. Controller replacement inside the same run is not supported; restore the recorded controller or start a fresh run.
- Do not hash volatile runtime state such as timestamps, stage, retry counters, work-item progress, active Hands profile, findings, or delivery state into the approval subject.
- Invalid, incomplete, corrupted, or no-op replans do not produce an approval prompt. They produce a deterministic blocker.
- Verifier fixes that remain inside the approved execution contract require no new approval.
- GitHub merge remains manual and outside plan approval.
- Detailed plan paths, commands, findings, and deltas remain local. GitHub status projection stays generic.
- Keep `events.jsonl` authoritative and append-only. `progress.jsonl` remains observational only.
- Do not add runtime dependencies.
- Do not change the default behavior of `logs --follow` in this feature. Its detached-worker liveness semantics are a separate problem.
- No version bump, npm publish, global install, or release is part of this implementation.

## Success Criteria

1. Every new initial-plan and replan boundary has one immutable `approvals/plan/revision-N.json` request.
2. A replan's `plans/revision-N.md` exists, has a recorded SHA-256, and passes readiness checks before status offers `approve-plan`.
3. While a replan awaits approval, both `current_revision` and `approved_revision` remain the executable approved base; `pending_plan_approval.proposed_revision` identifies the fully recorded candidate.
4. `approve-plan` validates the request, subject, plan bytes, prerequisite discovery binding, run configuration, controller provenance, and authority contract before recording approval.
5. Replan approval applies only the already-persisted revision plus deterministic progress resets; it never materializes new plan bytes.
6. Repeating approval for the exact same subject is idempotent and does not ask again.
7. A changed plan, discovery prerequisite, source commit, or authority contract changes the subject digest. Run configuration and controller provenance are immutable run inputs; drift fails closed instead of silently regenerating a request.
8. A no-op or invalid replan is blocked before an approval boundary is exposed.
9. Local status renders an initial summary or stable delta-first replan view, the full plan path, exact digests, the reason for approval, and expected future approvals.
10. Discovery `pending_action` remains separate from `plan_approval_request` in JSON and TypeScript types.
11. Legacy runs continue under their existing revision/SHA contract; missing new metadata is never silently upgraded into broader semantic approval.
12. Focused tests, typecheck, build, full tests, skill tests, planner replay tests, and package dry-run all pass.

## What the original proposal should change

1. **Fix sequencing before adding UX.** The current `approveReplanPatch()` materializes `plans/revision-N.md` during approval. Delta rendering is not trustworthy until the exact resulting revision exists before the prompt.
2. **Use one plan gate, not `initial_plan | replan` as separate authorization kinds.** Both authorize an exact `BrainPlan`; `base_revision` and `reason_code` explain why the presentation differs.
3. **Remove `fresh_approval_required` and `reuse_reason` from pending requests.** A pending request is, by definition, awaiting fresh approval. If its exact subject is already approved, the controller should continue idempotently and expose no pending request.
4. **Do not claim an existing bounded repair path for replans.** The bounded semantic repair loop exists for initial planning, not for replan materialization. This first slice should block invalid/no-op replans with exact diagnostics; a model-driven replan repair loop can be a later feature.
5. **Do not make `replanning` globally non-quiescent.** Detached `logs --follow` cannot safely distinguish active replanning from a crashed worker using stage alone. Keep follow-state refactoring out of this approval feature.
6. **Resolve the artifact/display contradiction.** If `artifact_sha256` is in the approval subject, changing any stored plan byte changes the subject. Only controller-rendered status copy may change without approval.
7. **Persist the request, not only a projection.** Reconstructing a request in status creates drift risk. Status should read and verify the same immutable request later consumed by `approve-plan`.
8. **Prefer a single stable delta-entry shape.** A generic, categorized JSON-pointer delta is smaller and easier to validate than many bespoke `FieldChange`, `ScopeChange`, and `CommandChange` types.

## File Structure

**Create**

- `src/core/plan-approval.ts` — canonical approval subject, authority/execution-context projections, immutable request creation and verification, and request renderer.
- `src/workflow/plan-delta.ts` — canonical decision-contract projection and stable categorized delta calculation.
- `src/workflow/replan-candidate.ts` — pure transformation from an approved base plan plus validated patch to the exact proposed plan.
- `tests/core/plan-approval.test.ts` — digest, artifact, context, authority, prerequisite, legacy, and rendering tests.
- `tests/workflow/plan-delta.test.ts` — stable delta, no-op, ordering, and category tests.
- `tests/workflow/replan-candidate.test.ts` — pure materialization and derived-contract tests.

**Modify**

- `src/core/types.ts` — `PendingPlanApprovalV1`, `PlanApprovalRequestV1`, subject, delta, and plan-revision metadata.
- `src/core/schema.ts` — strict schemas and manifest consistency checks for the new records.
- `src/core/ledger.ts` — commit pending approval metadata, validate exact subjects, record subject-bound approval events, and preserve legacy behavior.
- `src/core/run-configuration.ts` — canonical run-configuration bytes and digest helpers.
- `src/core/controller-provenance.ts` — exact approval-time controller compatibility check for ordinary and self-hosting runs.
- `src/workflow/planner.ts` — create and persist the initial plan approval request before exposing the boundary.
- `src/workflow/replan.ts` — validate replan provenance, prepare the exact candidate/request before approval, and apply only a prepared revision during approval.
- `src/workflow/runtime.ts` — replace patch-only awaiting transitions with prepared replan approval boundaries and deterministic blockers.
- `src/workflow/status.ts` — expose `plan_approval_request`, verify it fail-closed, and render summary/delta-first output.
- `src/cli.ts` — require the exact pending request in `approve-plan`, preserve repeated exact approval idempotence, and print engine-owned approval details.
- `tests/core/schema.test.ts` — strict schema and manifest invariant tests.
- `tests/core/ledger.test.ts` — approval request/event idempotence, conflict, crash, tamper, and legacy tests.
- `tests/core/run-configuration.test.ts` — canonical configuration digest and immutable-write behavior.
- `tests/core/controller-provenance.test.ts` — approval-time installed-controller mismatch behavior.
- `tests/workflow/planner.test.ts` — initial request persistence and crash recovery.
- `tests/workflow/replan.test.ts` — prepared revision lifecycle, provenance, readiness, no-op, and approval application.
- `tests/workflow/runtime-local.test.ts` — local replan boundary and resume behavior.
- `tests/workflow/runtime-github.test.ts` — GitHub-mode replan boundary and generic projection behavior.
- `tests/workflow/status.test.ts` — request verification and local rendering.
- `tests/cli-smoke.test.ts` — JSON/text approval request and exact approval CLI behavior.
- `.agents/skills/brain-hands/SKILL.md` — display the engine-owned request and ask only when a request is pending.
- `.agents/skills/brain-hands/references/cli-contract.md` — machine-readable request and approval semantics.
- `tests/skill-layout.test.ts` — conversational gate wording and separation from discovery actions.
- `README.md` — expected approval counts, same-run recovery, and delta-first examples.

---

### Task 1: Define the canonical approval and delta contracts

**Files:**

- Create: `src/core/plan-approval.ts`
- Create: `src/workflow/plan-delta.ts`
- Modify: `src/core/types.ts`
- Modify: `src/core/schema.ts`
- Modify: `src/core/run-configuration.ts`
- Modify: `src/core/controller-provenance.ts`
- Create: `tests/core/plan-approval.test.ts`
- Create: `tests/workflow/plan-delta.test.ts`
- Modify: `tests/core/schema.test.ts`
- Modify: `tests/core/run-configuration.test.ts`
- Modify: `tests/core/controller-provenance.test.ts`

**Interfaces:**

- Produces: `canonicalApprovalJson(value)`, `approvalSha256(value)`, `planDecisionContract(plan)`, and `planDecisionContractSha256(plan)`.
- Produces: `buildPlanDelta(base, proposed)` returning stable, categorized entries.
- Produces: `buildPlanApprovalRequest(input)`, `writePlanApprovalRequest(runDir, request)`, and `readVerifiedPlanApprovalRequest(runDir, manifest)`.
- Produces: `renderPlanApprovalRequest(request)` for engine-owned local text.
- Adds: `RunManifestV2.pending_plan_approval` and approval metadata on `PlanRevision`.

- [ ] **Step 1: Add failing digest and schema tests**

Create tests that prove deterministic object-key ordering, strict schema rejection, and subject sensitivity:

```ts
const first = buildPlanApprovalRequest(requestInput({ plan: fixturePlan() }));
const second = buildPlanApprovalRequest(requestInput({ plan: fixturePlanWithReorderedObjectKeys() }));
expect(first.approval_subject_sha256).toBe(second.approval_subject_sha256);

for (const mutate of [
  changePlanBytes,
  changeApprovedBriefSha,
  changeSourceCommit,
  changeRunConfiguration,
  changeControllerPackageHash,
  changeAuthorityPolicy,
]) {
  expect(buildPlanApprovalRequest(mutate(requestInput())).approval_subject_sha256)
    .not.toBe(first.approval_subject_sha256);
}

expect(() => planApprovalRequestSchema.parse({ ...first, unknown: true })).toThrow();
```

Assert that changing controller-rendered explanation copy changes neither digest because the copy is not stored in the request. Changing `reason_code` changes both digests.

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `npx vitest run tests/core/plan-approval.test.ts tests/workflow/plan-delta.test.ts tests/core/schema.test.ts`

Expected: FAIL because the new types, schemas, and functions do not exist.

- [ ] **Step 3: Add exact v1 types**

Add these shapes to `src/core/types.ts` and matching strict Zod schemas to `src/core/schema.ts`:

```ts
export type PlanApprovalReasonCode = "initial_plan" | "material_replan";

export type PlanDeltaCategory =
  | "objective"
  | "scope"
  | "files"
  | "acceptance"
  | "verification"
  | "risks"
  | "external_effects"
  | "destructive_actions";

export interface PlanDeltaEntryV1 {
  category: PlanDeltaCategory;
  pointer: string;
  operation: "add" | "remove" | "replace";
  before: unknown | null;
  after: unknown | null;
}

export interface PlanApprovalDeltaV1 {
  schema_version: 1;
  base_revision: number | null;
  proposed_revision: number;
  entries: PlanDeltaEntryV1[];
  unchanged_high_impact_categories: PlanDeltaCategory[];
}

export interface PlanApprovalSubjectV1 {
  schema_version: 1;
  gate: "plan";
  reason_code: PlanApprovalReasonCode;
  run_id: string;
  plan_revision: number;
  base_plan_revision: number | null;
  plan_sha256: string;
  prerequisite_subject_sha256: string;
  execution_context_sha256: string;
  authority_contract_sha256: string;
  decision_contract_sha256: string;
}

export interface PlanApprovalRequestV1 {
  schema_version: 1;
  subject: PlanApprovalSubjectV1;
  approval_subject_sha256: string;
  plan_path: string;
  delta: PlanApprovalDeltaV1;
  additional_approvals_expected: "only_if_material_replan";
}

export interface PendingPlanApprovalV1 {
  schema_version: 1;
  proposed_revision: number;
  base_revision: number | null;
  request_path: string;
  request_sha256: string;
  approval_subject_sha256: string;
}
```

Extend `PlanRevision` with optional legacy-compatible fields:

```ts
origin?: "initial" | "replan";
base_revision?: number | null;
approval_request_path?: string;
approval_request_sha256?: string;
approval_subject_sha256?: string;
decision_contract_sha256?: string;
```

Add `pending_plan_approval: PendingPlanApprovalV1 | null` and `run_configuration_sha256: string | null` to `RunManifestV2`; default both to `null` in the schema for legacy manifests. Exclude `pending_plan_approval` and `run_configuration_sha256` from `MutableRunManifestV2Patch` so only dedicated ledger creation/preparation/approval paths may change them.

- [ ] **Step 4: Add manifest invariants**

In `runManifestV2Schema.superRefine`, enforce:

```ts
if (manifest.stage === "awaiting_plan_approval" && manifest.pending_plan_approval !== null) {
  const pending = manifest.pending_plan_approval;
  const revision = manifest.plan_revisions[String(pending.proposed_revision)];
  if (!revision) issue(["pending_plan_approval"], "Pending approval revision must exist");
  if (revision?.approval_subject_sha256 !== pending.approval_subject_sha256) issue(["pending_plan_approval"], "Pending approval subject must match the revision");
  if (revision?.approval_request_sha256 !== pending.request_sha256) issue(["pending_plan_approval"], "Pending approval request must match the revision");
  if (pending.base_revision === null && manifest.current_revision !== pending.proposed_revision) issue(["current_revision"], "Initial pending revision must be current");
  if (pending.base_revision !== null && (manifest.current_revision !== pending.base_revision || manifest.approved_revision !== pending.base_revision)) issue(["pending_plan_approval"], "Pending replan must preserve the executable approved base");
}
if (manifest.pending_plan_approval !== null && manifest.stage !== "awaiting_plan_approval") {
  issue(["pending_plan_approval"], "Pending plan approval is allowed only at its approval stage");
}
```

Do not require `pending_plan_approval` for legacy awaiting manifests; `null` selects legacy validation.

- [ ] **Step 5: Implement canonical hashing and the exact subject projections**

In `src/core/plan-approval.ts`, recursively sort object keys but preserve array order:

```ts
export function canonicalApprovalJson(value: unknown): string {
  const normalize = (candidate: unknown): unknown => {
    if (Array.isArray(candidate)) return candidate.map(normalize);
    if (candidate && typeof candidate === "object") {
      return Object.fromEntries(Object.entries(candidate as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, normalize(nested)]));
    }
    return candidate;
  };
  return JSON.stringify(normalize(value));
}

export function approvalSha256(value: unknown): string {
  return createHash("sha256").update(canonicalApprovalJson(value), "utf8").digest("hex");
}
```

Build `prerequisite_subject_sha256` from `{ workflow_protocol, approved_discovery_brief_revision, approved_discovery_brief_sha256 }`; use explicit `null` values for legacy discovery.

Build `execution_context_sha256` from exactly:

```ts
{
  repo_root: manifest.repo_root,
  source_commit: manifest.source_commit,
  workflow_protocol: manifest.workflow_protocol,
  run_configuration_sha256,
  controller_provenance: manifest.controller_provenance ?? null,
}
```

`run_configuration_sha256` is the digest of the exact canonical bytes written create-once at run creation. Add helpers in `src/core/run-configuration.ts` to serialize and hash those bytes. Add an approval-specific controller assertion in `src/core/controller-provenance.ts` that captures the current runtime for ordinary and self-hosting runs and compares the runtime fields while source commit remains independently bound by the manifest. A mismatch blocks; it does not rewrite the request.

Build `authority_contract_sha256` from immutable manifest/run inputs:

```ts
{
  mode: runConfiguration.mode,
  github: runConfiguration.github,
  review_policy: manifest.review_policy_snapshot ?? runConfiguration.limits.review_policy,
  release_guards: manifest.release_guards ?? [],
  warning_continuation: manifest.warning_continuation_authority ?? (
    (manifest.review_policy_snapshot ?? runConfiguration.limits.review_policy).on_limit === "continue_with_warning"
      ? { source: "approved_plan", actor_scope: "approving_actor" }
      : { source: "none" }
  ),
  merge_authority: "manual_only",
}
```

Do not include timestamps, current stage, work progress, retry counts, or findings.

- [ ] **Step 6: Implement one stable decision contract and delta shape**

In `src/workflow/plan-delta.ts`, project all authorization-relevant plan fields:

```ts
export function planDecisionContract(plan: BrainPlan): unknown {
  return {
    feature_slug: plan.feature_slug ?? null,
    parent_issue: plan.parent_issue ?? null,
    assumptions: plan.assumptions,
    architecture: plan.architecture,
    risks: plan.risks,
    controller_bootstrap: plan.controller_bootstrap ?? null,
    work_items: plan.work_items,
    integration_verification: plan.integration_verification,
    discovery: "discovery_brief_revision" in plan ? {
      discovery_brief_revision: plan.discovery_brief_revision,
      discovery_brief_sha256: plan.discovery_brief_sha256,
      discovery_decision_coverage: plan.discovery_decision_coverage,
      accepted_risks: plan.accepted_risks,
      out_of_scope: plan.out_of_scope,
    } : null,
  };
}
```

Exclude `summary`, `research`, and `research_sources` only from the decision delta. They remain protected by `plan_sha256`, so changing them still requires fresh approval.

Compare stable projections by work-item ID, file path, criterion ID, test ID, command ID, and browser-check name. Emit JSON-pointer-like paths such as `/work_items/BH-005/file_contract/src/workflow/status.ts`. Sort entries by `category`, then `pointer`, then `operation`. Never use model text to categorize changes.

- [ ] **Step 7: Implement request construction and external byte hashing**

`buildPlanApprovalRequest()` must first compute `subject`, then `approval_subject_sha256`. It returns the request without a self-digest. `serializePlanApprovalRequest()` produces canonical newline-terminated bytes and `requestSha256()` hashes those exact bytes for the revision and pending pointer:

```ts
export function buildPlanApprovalRequest(input: {
  manifest: RunManifestV2;
  runConfiguration: ResolvedRunConfiguration;
  reasonCode: PlanApprovalReasonCode;
  revision: number;
  baseRevision: number | null;
  planPath: string;
  planSha256: string;
  decisionContractSha256: string;
  delta: PlanApprovalDeltaV1;
}): PlanApprovalRequestV1;
```

The `requestInput()` test helper serializes its fixture plan, calculates `planSha256`, `decisionContractSha256`, and `delta`, then supplies this exact interface.

```ts
const request = {
  schema_version: 1 as const,
  subject,
  approval_subject_sha256: approvalSha256(subject),
  plan_path,
  delta,
  additional_approvals_expected: "only_if_material_replan" as const,
};
return planApprovalRequestSchema.parse(request);
```

`renderPlanApprovalRequest()` maps `reason_code` to controller-owned explanation text at read time. Explanation copy is not persisted or hashed, and the renderer never accepts model-authored reason text.

- [ ] **Step 8: Run focused tests**

Run: `npx vitest run tests/core/plan-approval.test.ts tests/workflow/plan-delta.test.ts tests/core/schema.test.ts tests/core/run-configuration.test.ts tests/core/controller-provenance.test.ts`

Expected: PASS.

- [ ] **Step 9: Commit the contract slice**

```bash
git add src/core/types.ts src/core/schema.ts src/core/plan-approval.ts src/core/run-configuration.ts src/core/controller-provenance.ts src/workflow/plan-delta.ts tests/core/schema.test.ts tests/core/plan-approval.test.ts tests/core/run-configuration.test.ts tests/core/controller-provenance.test.ts tests/workflow/plan-delta.test.ts
git commit -m "feat: define deterministic plan approval requests"
```

---

### Task 2: Materialize and validate replans before approval

**Files:**

- Create: `src/workflow/replan-candidate.ts`
- Modify: `src/workflow/replan.ts`
- Modify: `src/core/ledger.ts`
- Modify: `src/core/execution-spec.ts`
- Create: `tests/workflow/replan-candidate.test.ts`
- Modify: `tests/workflow/replan.test.ts`
- Modify: `tests/core/ledger.test.ts`
- Modify: `tests/core/execution-spec.test.ts`

**Interfaces:**

- Produces: `materializeReplanCandidate(input): BrainPlan` as a pure function.
- Produces: `prepareReplanApprovalBoundary(input)` that persists the exact unapproved revision and request.
- Produces: `NoMaterialReplanError` and `InvalidReplanCandidateError` with deterministic diagnostics.
- Replaces: plan construction inside `approveReplanPatch()`.
- Updates: `resolvePendingReplanTarget()` to trust the verified `pending_plan_approval` revision/base coordinates for new runs while retaining patch-lineage validation and the legacy inference path.

- [ ] **Step 1: Add failing pure materialization tests**

Move the existing expected revision-2 assertions from `approveReplanPatch` tests into direct pure-function tests. Cover revised objective, changed criterion text, added file contract, wildcard exception, change units, command, completion contract, discovery metadata preservation, and unchanged unrelated work items.

```ts
const proposed = materializeReplanCandidate({
  basePlan,
  targetWorkItemId: "BH-005",
  patch,
  durableCriteria,
  workflowProtocol: "durable-discovery-v1",
});
expect(proposed.work_items.find(({ id }) => id === "BH-005")).toMatchObject({
  objective: patch.revised_objective,
  completion_contract: { expected_changed_files: expect.arrayContaining(["src/new.ts"]) },
});
expect(basePlan).toEqual(frozenBasePlan);
```

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `npx vitest run tests/workflow/replan-candidate.test.ts tests/workflow/replan.test.ts`

Expected: FAIL because the pure materializer and prepared boundary do not exist.

- [ ] **Step 3: Extract the current transformation without changing semantics**

Move only the deterministic transformation currently in `approveReplanPatch()` into `src/workflow/replan-candidate.ts`. The function must not read files, write files, inspect the manifest, or mutate the base plan. It must finish with:

```ts
return parsePersistedPlan({
  ...basePlan,
  work_items: basePlan.work_items.map((item, index) =>
    index === targetIndex ? nextTarget : item),
}, workflowProtocol);
```

Keep all provenance checks in `src/workflow/replan.ts`.

- [ ] **Step 4: Add prepared-boundary validation**

After validating the immutable patch, convergence report, review effect, base revision, and criteria provenance, `prepareReplanApprovalBoundary()` must:

1. Load the verified base plan.
2. Materialize the proposed plan.
3. Run `assertPlanReady(proposed, { mode: manifest.mode, repoRoot: manifest.repo_root })` so preparation and later persisted-plan loading use identical validation coordinates.
4. For `durable-discovery-v1`, load the verified approved brief and run `validateDiscoveryCoverage(proposed as DiscoveredBrainPlan, brief)`.
5. Compute base and proposed decision-contract digests.
6. Serialize the candidate and throw `NoMaterialReplanError` only when its exact plan SHA-256 matches the approved base plan SHA-256; decision-contract equality alone is not a no-op rule.
7. Write `plans/revision-N.md` create-once.
8. Build and write `approvals/plan/revision-N.json` create-once.
9. Commit the revision record and `pending_plan_approval` in one ledger transaction.

Add a dedicated `commitPreparedPlanApprovalBoundary()` ledger operation; do not re-enable generic mutation of `pending_plan_approval`.

The manifest transition must be:

```ts
{
  stage: "awaiting_plan_approval",
  current_revision: baseRevision,
  current_plan_revision: baseRevision,
  approved_revision: baseRevision,
  approved_plan_revision: baseRevision,
  plan_revisions: { ...existing, [String(proposedRevision)]: proposedRecord },
  pending_plan_approval: pending,
}
```

- [ ] **Step 5: Add crash and conflict tests**

Test crashes after each durable write:

- orphaned plan bytes with no manifest pointer are reused only if bytes match;
- orphaned request bytes are reused only if their strict schema, canonical bytes, and externally calculated request SHA-256 match;
- a conflicting orphan causes a blocker;
- replay returns the same pending request and never creates revision `N+1`;
- a candidate with invalid command policy never reaches `awaiting_plan_approval`;
- a no-op patch never writes a request and never exposes `approve-plan`.

- [ ] **Step 6: Run focused tests**

Run: `npx vitest run tests/workflow/replan-candidate.test.ts tests/workflow/replan.test.ts tests/core/execution-spec.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit the pre-materialization slice**

```bash
git add src/workflow/replan-candidate.ts src/workflow/replan.ts src/core/ledger.ts src/core/execution-spec.ts tests/workflow/replan-candidate.test.ts tests/workflow/replan.test.ts tests/core/ledger.test.ts tests/core/execution-spec.test.ts
git commit -m "feat: prepare exact replan revisions before approval"
```

---

### Task 3: Persist initial-plan requests and bind approval events to subjects

**Files:**

- Modify: `src/core/ledger.ts`
- Modify: `src/cli.ts`
- Modify: `src/workflow/planner.ts`
- Modify: `src/workflow/replan.ts`
- Modify: `tests/core/ledger.test.ts`
- Modify: `tests/cli-smoke.test.ts`
- Modify: `tests/workflow/planner.test.ts`
- Modify: `tests/workflow/replan.test.ts`

**Interfaces:**

- `commitClaimedInitialPlan()` commits revision 1 and its request together.
- `approvePlanRevision()` validates a new-style pending request before approval.
- `approvePreparedReplanRevision()` applies the prepared revision and progress reset without changing plan bytes.
- `plan_approved` events contain request and subject digests.

- [ ] **Step 1: Add failing initial-boundary and event tests**

Assert that a new initial boundary contains:

```ts
expect(manifest.pending_plan_approval).toMatchObject({
  proposed_revision: 1,
  base_revision: null,
  request_path: "approvals/plan/revision-1.json",
});
expect(manifest.plan_revisions["1"]).toMatchObject({
  origin: "initial",
  base_revision: null,
  approval_request_path: "approvals/plan/revision-1.json",
});
```

Assert the event payload equals:

```ts
{
  revision: 1,
  plan_sha256: request.subject.plan_sha256,
  request_sha256: manifest.pending_plan_approval!.request_sha256,
  approval_subject_sha256: request.approval_subject_sha256,
  approval_semantics_version: 1,
}
```

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `npx vitest run tests/core/ledger.test.ts tests/workflow/planner.test.ts tests/workflow/replan.test.ts`

Expected: FAIL because initial requests and subject-bound events are not persisted.

- [ ] **Step 3: Commit the initial request before exposing the boundary**

At run creation, pass the already resolved run configuration into `createRunLedgerV2()`. Write its canonical bytes create-once, store `run_configuration_sha256` in the initial manifest, and add `run-configuration.json` plus `approvals/` to protected engine artifact roots. Remove the later mutable `writeTextArtifact()` call from `src/cli.ts`.

In `persistAndCommitPlan()`, build the request from the validated plan, exact serialized bytes, current manifest, and verified `run-configuration.json`. Pass that request into `commitClaimedInitialPlan({ ..., approvalRequest })`. The ledger function validates the strict schema plus revision/plan-SHA/run-ID bindings, writes the request create-once after `plans/revision-1.md`, then stores its path and digests in both the revision and `pending_plan_approval`. Apply the same construction before the crash-recovery call at `src/workflow/planner.ts:270` so ledger code never imports from `src/workflow/`.

On crash replay, validate all existing bytes and return the same boundary. Never regenerate a different request from drifted context.

- [ ] **Step 4: Verify a request at approval time**

Before any approval mutation:

```ts
const request = await readVerifiedPlanApprovalRequest(transaction.runDir, manifest);
if (request.subject.plan_revision !== revision) throw new Error("Approval request revision mismatch");
if (request.subject.plan_sha256 !== recorded.sha256) throw new Error("Approval request plan digest mismatch");
```

Recompute prerequisite, execution-context, authority, and decision-contract hashes from the current immutable artifacts. Capture and compare the current controller runtime even for ordinary installed runs. Reject any mismatch before changing the manifest.

- [ ] **Step 5: Replace replan approval-time materialization**

Rename `approveReplanPatch()` to `approvePreparedReplanRevision()`. It may still validate patch/effect provenance and apply deterministic progress resets, but it must load the already-recorded revision and request. Remove all code that constructs `nextTarget`, serializes `nextPlan`, writes `plans/revision-N.md`, or calculates a new plan SHA during approval.

- [ ] **Step 6: Record one subject-bound event idempotently**

Use:

```ts
const eventId = `plan-approved:${approvalSha256({
  run_id: manifest.run_id,
  approval_subject_sha256: request.approval_subject_sha256,
})}`;
```

If the same event exists, require canonical byte-equivalent content. If the manifest is durably approved but the matching event is absent after an injected crash, an identical retry must reverify the request and append exactly the missing event. Duplicate or conflicting events fail closed. On successful promotion, clear `pending_plan_approval`.

For a legacy revision with no request metadata, preserve the current event and revision/SHA behavior. Never synthesize a v1 subject for an already-approved legacy event.

- [ ] **Step 7: Add tamper and idempotence tests**

Cover plan-byte tampering, request-byte tampering, changed config bytes, installed-controller mismatch, missing event repair after manifest approval, duplicate/conflicting event IDs, repeated exact approval, protected run-configuration writes, and legacy exact-revision approval.

- [ ] **Step 8: Run focused tests**

Run: `npx vitest run tests/core/ledger.test.ts tests/workflow/planner.test.ts tests/workflow/replan.test.ts tests/cli-smoke.test.ts tests/core/run-configuration.test.ts tests/core/controller-provenance.test.ts`

Expected: PASS.

- [ ] **Step 9: Commit the durable approval slice**

```bash
git add src/core/ledger.ts src/cli.ts src/workflow/planner.ts src/workflow/replan.ts tests/core/ledger.test.ts tests/cli-smoke.test.ts tests/workflow/planner.test.ts tests/workflow/replan.test.ts
git commit -m "feat: bind plan approvals to immutable subjects"
```

---

### Task 4: Route runtime replans through the prepared boundary

**Files:**

- Modify: `src/workflow/runtime.ts`
- Modify: `tests/workflow/runtime-local.test.ts`
- Modify: `tests/workflow/runtime-github.test.ts`

**Interfaces:**

- Runtime calls `prepareReplanApprovalBoundary()` after the create-replan effect is durably complete.
- Runtime calls `reconcilePendingReplanApprovalBoundary()` on resume to finish a crash-interrupted or legacy patch-only preparation without invoking Brain again.
- Runtime returns `human_action_required` only after the exact request is committed.
- Invalid/no-op candidates become deterministic blockers without an approval command.

- [ ] **Step 1: Add failing local and GitHub runtime tests**

For both modes, assert that a material replan returns:

```ts
expect(result.manifest.stage).toBe("awaiting_plan_approval");
expect(result.manifest.current_revision).toBe(1);
expect(result.manifest.approved_revision).toBe(1);
expect(result.manifest.pending_plan_approval?.proposed_revision).toBe(2);
expect(await readFile(join(runDir, "plans/revision-2.md"), "utf8")).toContain('"schema_version": "2.0"');
```

Add no-op and invalid-candidate cases that assert `operator_state` is blocked and `pending_plan_approval` is `null`.

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `npx vitest run tests/workflow/runtime-local.test.ts tests/workflow/runtime-github.test.ts`

Expected: FAIL because runtime currently records a patch pointer and enters approval before revision 2 exists.

- [ ] **Step 3: Replace patch-only awaiting transitions**

At both create-replan paths in `src/workflow/runtime.ts`:

1. Persist/validate the immutable patch and complete the review effect as today.
2. Record source/target patch lineage.
3. Call `prepareReplanApprovalBoundary()`.
4. Return `human_action_required` only from the returned prepared manifest.

Delete the direct `transitionRun(..., "awaiting_plan_approval")` calls for replans; the prepared-boundary transaction owns that transition.

Before normal execution on `resume`, call `reconcilePendingReplanApprovalBoundary()`. For a legacy patch-only `awaiting_plan_approval` manifest, preparation may create the exact candidate/request but must return at the new boundary; it must never treat the earlier human command as approval. Existing already-approved legacy revisions remain unchanged.

In `executeApprovedRun()`, resolve and verify `pending_plan_approval` before calling `loadPlan()`. A pending replan must not load the proposed unapproved revision as the executable plan. If GitHub status needs the approved baseline, load `approved_revision` explicitly; detailed proposed-plan content remains local.

- [ ] **Step 4: Handle deterministic preparation failures**

Catch only `NoMaterialReplanError` and `InvalidReplanCandidateError`. Persist `delivery_state: "blocked"`, keep the stage at `replanning`, set an exact controller-authored `last_blocker`, and emit `worker_blocked`. Do not offer `approve-plan`.

Unexpected I/O, schema, or provenance errors continue through the existing operational blocker path.

- [ ] **Step 5: Prove resume is idempotent**

Add crash checkpoints after patch write, effect completion, plan write, request write, and manifest boundary commit. A resume must either finish the same prepared boundary or fail on conflicting bytes; it must not call Brain again after the immutable patch exists. Add a legacy patch-only fixture proving `resume` prepares and stops, and only a later `approve-plan` promotes it.

- [ ] **Step 6: Run focused tests**

Run: `npx vitest run tests/workflow/runtime-local.test.ts tests/workflow/runtime-github.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit the runtime slice**

```bash
git add src/workflow/runtime.ts tests/workflow/runtime-local.test.ts tests/workflow/runtime-github.test.ts
git commit -m "fix: prepare replans before human approval"
```

---

### Task 5: Expose and render the verified approval request

**Files:**

- Modify: `src/workflow/status.ts`
- Modify: `src/cli.ts`
- Modify: `tests/workflow/status.test.ts`
- Modify: `tests/cli-smoke.test.ts`

**Interfaces:**

- Adds: `V2StatusSummary.plan_approval_request: PlanApprovalRequestV1 | null`.
- Uses: `readVerifiedPlanApprovalRequest()` in status and approval CLI.
- Removes: inferred `pendingPlanApprovalRevision()` for new-style runs.

- [ ] **Step 1: Add failing JSON and text status tests**

Assert discovery and plan actions remain separate:

```ts
expect(status.pending_action).toBeNull();
expect(status.plan_approval_request?.subject.plan_revision).toBe(2);
```

For a replan, assert rendered output contains base/proposed revisions, plan and subject digests, categorized changes, unchanged high-impact categories, full plan path, and expected future approvals. For an initial plan, assert it renders a concise complete authorization summary rather than an empty delta.

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `npx vitest run tests/workflow/status.test.ts tests/cli-smoke.test.ts`

Expected: FAIL because status has only a one-line inferred approval boundary.

- [ ] **Step 3: Read and verify the immutable request in status**

When `manifest.pending_plan_approval !== null`, call `readVerifiedPlanApprovalRequest()`. Any mismatch must make status `operationally_blocked` with `Status provenance invalid: ...`; status must not print an approval command.

For legacy initial-plan awaiting runs with no pending record, retain the current revision/SHA message and mark the request as `null`. For legacy patch-only replans, report that `resume` must prepare an exact request and do not render an approval command. Status itself remains observational and never performs preparation.

- [ ] **Step 4: Render controller-owned approval explanations**

Render this order for a replan:

```text
Approval required: material replan
Why: Verifier findings require changes outside the currently approved decision contract.
Base revision: 1
Proposed revision: 2
Plan SHA-256: 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
Approval subject SHA-256: abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789
Full plan: plans/revision-2.md

Changed files:
  add /work_items/BH-005/file_contract/src/core/plan-approval.ts
Unchanged high-impact categories: risks, external effects, destructive actions
Additional approvals expected: only if another material replan is prepared.
```

For the initial plan, summarize work-item count, changeable files, verification command count, browser checks, destructive file operations, risks, GitHub effects, and manual merge policy.

- [ ] **Step 5: Make `approve-plan` consume the exact pending request**

For new-style boundaries, require `--revision` to equal `pending_plan_approval.proposed_revision`; read and verify the request before choosing initial or replan application. A replan uses `approvePreparedReplanRevision()`. An initial plan uses `approvePlanRevision()`.

After an exact approval is already recorded, print:

```text
Exact approval already recorded for this subject; continuing the approved run.
```

Do not add an `--approve-all`, `--yes`, or implicit approval flag.

- [ ] **Step 6: Keep GitHub status generic**

Assert GitHub projection says only that a local plan approval is required and identifies the revision. It must not include local paths, commands, detailed delta entries, findings, or model content.

- [ ] **Step 7: Run focused tests**

Run: `npx vitest run tests/workflow/status.test.ts tests/cli-smoke.test.ts tests/workflow/runtime-github.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit the operator surface**

```bash
git add src/workflow/status.ts src/cli.ts tests/workflow/status.test.ts tests/cli-smoke.test.ts tests/workflow/runtime-github.test.ts
git commit -m "feat: render verified plan approval requests"
```

---

### Task 6: Update the conversational and operator contracts

**Files:**

- Modify: `.agents/skills/brain-hands/SKILL.md`
- Modify: `.agents/skills/brain-hands/references/cli-contract.md`
- Modify: `tests/skill-layout.test.ts`
- Modify: `README.md`

**Interfaces:**

- Skill displays only the engine-owned request and asks only when it is pending.
- Documentation states exact expected approval counts and same-run recovery behavior.

- [ ] **Step 1: Add failing skill-layout assertions**

Require the skill to contain all of these semantics:

- discovery brief and plan are distinct approvals;
- display `plan_approval_request` verbatim/in full at the boundary;
- Brain may recommend discovery choices but never recommends approval of its own plan;
- initial approval authorizes exact scope, commands, risks, external effects, and authority;
- replan approval authorizes the exact proposed plan with a delta-first display;
- internal fixes do not require approval;
- identical same-run resume does not ask again;
- merge remains manual;
- cross-run carry-forward is unsupported.

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `npx vitest run tests/skill-layout.test.ts`

Expected: FAIL because the current skill does not define the new request surface.

- [ ] **Step 3: Update the skill gate**

At the plan boundary, require this sequence:

1. Read `status --json`.
2. If `plan_approval_request` is present, display the engine-rendered request in full.
3. Ask for explicit approval of its exact revision and subject digest.
4. On approval, run `approve-plan --revision N --follow`.
5. If no request is pending and exact approval is already recorded, use `resume --follow` without asking again.
6. Never summarize a delta from model prose or reconstruct one from the patch.

Do not change discovery question wording or combine `pending_action` with the plan request.

- [ ] **Step 4: Document expected approvals**

Add this table to `README.md`:

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

- [ ] **Step 5: Run focused documentation tests**

Run: `npm run test:skill`

Expected: PASS.

- [ ] **Step 6: Commit the conversational contract**

```bash
git add .agents/skills/brain-hands/SKILL.md .agents/skills/brain-hands/references/cli-contract.md tests/skill-layout.test.ts README.md
git commit -m "docs: define deterministic approval request workflow"
```

---

### Task 7: Full regression, package, and adversarial verification

**Files:**

- Modify only files required to fix regressions caused by Tasks 1-6.

- [ ] **Step 1: Run focused approval suites together**

Run:

```bash
npx vitest run \
  tests/core/plan-approval.test.ts \
  tests/workflow/plan-delta.test.ts \
  tests/workflow/replan-candidate.test.ts \
  tests/workflow/replan.test.ts \
  tests/workflow/status.test.ts \
  tests/core/ledger.test.ts \
  tests/cli-smoke.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run adversarial artifact tests**

Verify each mutation fails closed: plan byte change, request byte change, request-path escape, request symlink, subject mismatch, discovery brief mismatch, run-config mismatch, installed-controller mismatch, base-revision mismatch, duplicate/conflicting approval event, and stale pending pointer. Verify a crash-left missing approval event is repaired exactly once after full subject revalidation.

Expected: every case reports a deterministic blocker and offers no approval command.

- [ ] **Step 3: Run static and replay gates**

Run:

```bash
npm run typecheck
npm run test:planner-replay
npm run test:skill
```

Expected: all commands exit 0.

- [ ] **Step 4: Run full repository tests and build**

Run:

```bash
npm test
npm run build
```

Expected: both commands exit 0.

- [ ] **Step 5: Verify package contents**

Run: `npm pack --dry-run`

Expected: exit 0; package contents remain limited to `dist/`, `prompts/`, `agentic-codex-workflow.md`, `README.md`, and package metadata.

- [ ] **Step 6: Run two deterministic CLI dry runs**

Run one normal local dry run through discovery and initial plan approval, then a fixture-driven material replan. Verify:

- exactly two prompts on the normal run;
- no prompt on resume after exact approval;
- the replan revision and request exist before approval;
- the replan view is delta-first;
- approval does not change plan bytes;
- one new approval event is recorded for the material replan.

Also run compatibility fixtures proving: an already-approved legacy revision remains usable; a legacy initial pending plan retains revision/SHA approval; and a legacy patch-only replan requires `resume` to prepare a request followed by a separate later `approve-plan` command.

- [ ] **Step 7: Review the final diff for scope**

Run:

```bash
git status --short
git diff --stat
git diff --check
```

Expected: only planned files are changed, no whitespace errors are reported, and no release/version files are modified.

## Deferred follow-ups

- Cross-run approval carry-forward or replacement-run lineage.
- Decision-level equivalence across different plan artifacts.
- Delta approval that authorizes only part of a plan rather than the exact resulting revision.
- Automatic model-driven repair for invalid/no-op replans.
- A global semantic-boundary classifier for detached `logs --follow`.
- CLI flags that implicitly approve or batch approvals.
- Release, version bump, npm publication, or installed-surface verification.

These are intentionally deferred until same-run request artifacts have production audit evidence. The v1 subject fields make later analysis possible without committing to unsafe reuse now.
