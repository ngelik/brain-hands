# ExecutionSpecV2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current v2 `WorkItem`/GitHub conversion split with one strict, traceable execution contract that a low-reasoning Hands model can follow deterministically.

**Architecture:** `ExecutionSpecV2` becomes the canonical work-item type emitted by Brain and consumed unchanged by Hands, Verifier, runtime verification, and GitHub issue rendering. The legacy `IssueSpec` path remains available only for the older orchestrator. A readiness validator rejects unresolved references, uncovered files, ambiguous instructions, and acceptance criteria without evidence before plan approval.

**Tech Stack:** TypeScript 6, Zod 4, Codex structured-output JSON Schema, Vitest, GitHub CLI adapter.

## Global Constraints

- Keep the legacy `IssueSpec` workflow operational; do not rewrite the older orchestrator in this change.
- Render v2 GitHub issues from the exact canonical JSON object supplied to Hands and Verifier.
- Store commands as direct argv arrays; never convert v2 commands to shell strings.
- Use stable IDs for change units, acceptance criteria, tests, and verification commands.
- Reject ambiguity before Hands starts; Hands must not make architecture or scope decisions.
- Do not add the proposed Spark A/B benchmark harness in this implementation.

---

### Task 1: Define and validate the canonical execution contract

**Files:**
- Modify: `src/core/types.ts`
- Modify: `src/core/schema.ts`
- Modify: `src/core/output-schemas.ts`
- Create: `src/core/execution-spec.ts`
- Test: `tests/core/execution-spec.test.ts`
- Modify: `tests/core/schema.test.ts`

**Interfaces:**
- Consumes: existing `BrowserCheckSpec` and direct argv verification commands.
- Produces: `ExecutionSpecV2`, `executionSpecV2Schema`, `executionSpecV2OutputSchema`, and `assertSparkReady(spec)`.

- [ ] **Step 1: Write failing contract tests**

Add tests that construct a complete `ExecutionSpecV2`, parse it successfully, and reject duplicate IDs, missing `satisfied_by` references, change paths absent from `file_contract`, completion files that differ from modifiable files, vague change requirements, and multi-file change units.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `npx vitest run tests/core/execution-spec.test.ts tests/core/schema.test.ts`

Expected: FAIL because the v2 schema and readiness validator do not exist.

- [ ] **Step 3: Add the minimal types, Zod schema, output schema, and validator**

Define the canonical shape with these required sections:

```ts
interface ExecutionSpecV2 {
  schema_version: "2.0";
  id: string;
  title: string;
  objective: string;
  dependencies: string[];
  file_contract: FileContractEntry[];
  forbidden_changes: ForbiddenChange[];
  change_units: ChangeUnit[];
  acceptance: AcceptanceCriterion[];
  tests: TestCaseSpec[];
  verification_commands: VerificationCommandSpec[];
  expected_artifacts: string[];
  browser_checks: BrowserCheckSpec[];
  risks: RiskSpec[];
  completion_contract: CompletionContract;
  ambiguity_policy: AmbiguityPolicy;
}
```

`assertSparkReady` must aggregate deterministic validation errors and throw one error containing every problem.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `npx vitest run tests/core/execution-spec.test.ts tests/core/schema.test.ts`

Expected: PASS.

### Task 2: Make Brain, Hands, runtime, and Verifier share the contract

**Files:**
- Modify: `prompts/brain-plan-v2.md`
- Modify: `prompts/hands-work-item-v2.md`
- Modify: `prompts/verifier-review-v2.md`
- Modify: `src/workflow/planner.ts`
- Modify: `src/workflow/worker.ts`
- Modify: `src/workflow/verifier.ts`
- Modify: `src/workflow/runtime.ts`
- Modify: v2 workflow fixtures under `tests/workflow/`

**Interfaces:**
- Consumes: `ExecutionSpecV2` from Task 1.
- Produces: plan validation before approval, unchanged spec JSON in Hands and Verifier prompts, and runtime command execution via `verification_commands[].argv`.

- [ ] **Step 1: Write failing planner, worker, verifier, and runtime tests**

Assert that an invalid execution spec is rejected before plan approval, that the exact serialized spec appears in both role prompts, and that runtime verification receives only argv arrays from the canonical command objects.

- [ ] **Step 2: Run focused workflow tests and verify RED**

Run: `npx vitest run tests/workflow/planner.test.ts tests/workflow/worker.test.ts tests/workflow/verifier.test.ts tests/workflow/runtime-local.test.ts tests/workflow/runtime-github.test.ts`

Expected: FAIL on the old `WorkItem` shape and missing readiness gate.

- [ ] **Step 3: Adapt the v2 workflow with no legacy-orchestrator rewrite**

Replace v2 `WorkItem` consumption with `ExecutionSpecV2`, call `assertSparkReady` for every planned item, map runtime commands through `.argv`, and derive integrated acceptance/file lists from canonical sections.

- [ ] **Step 4: Run focused workflow tests and verify GREEN**

Run the same focused workflow command.

Expected: PASS.

### Task 3: Render exact JSON in GitHub and preserve legacy compatibility

**Files:**
- Modify: `src/adapters/github.ts`
- Modify: `src/workflow/runtime.ts`
- Modify: `src/workflow/review-package.ts`
- Test: `tests/adapters/github.test.ts`
- Test: `tests/workflow/runtime-github.test.ts`
- Test: `tests/workflow/review-package.test.ts`

**Interfaces:**
- Consumes: either legacy `IssueSpec` or canonical `ExecutionSpecV2`, discriminated by `schema_version`.
- Produces: v2 issue bodies with one human summary and one exact `json` fenced payload; no YAML aliases or lossy conversion.

- [ ] **Step 1: Write failing GitHub-format tests**

Assert that the v2 body contains ` ```json `, contains the byte-equivalent pretty-printed execution spec, has no YAML anchors, and that GitHub runtime passes the same object used by Hands.

- [ ] **Step 2: Run adapter/runtime tests and verify RED**

Run: `npx vitest run tests/adapters/github.test.ts tests/workflow/runtime-github.test.ts tests/workflow/review-package.test.ts`

Expected: FAIL because GitHub currently receives a lossy `IssueSpec` conversion.

- [ ] **Step 3: Add discriminated rendering and direct v2 issue sync**

Keep legacy YAML rendering for legacy issues. Render and sync v2 specs directly as JSON, selecting the title from `title` and preserving stable run/work-item markers.

- [ ] **Step 4: Run adapter/runtime tests and verify GREEN**

Run the same adapter/runtime command.

Expected: PASS.

### Task 4: Document the contract and verify the package

**Files:**
- Modify: `agentic-codex-workflow.md`
- Modify: `README.md`
- Modify: `prompts/brain-plan-v2.md`

**Interfaces:**
- Consumes: final schema and readiness rules.
- Produces: maintainer-facing contract documentation and exact Brain authoring guidance.

- [ ] **Step 1: Update documentation**

Document the traceability chain `change unit -> acceptance criterion -> test/evidence -> verification command`, JSON-only GitHub rendering, stop conditions, and the distinction between legacy `IssueSpec` and v2 `ExecutionSpecV2`.

- [ ] **Step 2: Run complete verification**

Run:

```text
npm test
npm run typecheck
npm run build
git diff --check
npm_config_cache=/private/tmp/brain-hands-npm-cache npm pack --dry-run
```

Expected: every command exits 0, all Vitest tests pass, and the package contains only the declared runtime files.

## Self-Review

- Spec coverage: canonical JSON, stable IDs, atomic changes, explicit file permissions, evidence mapping, argv commands, stop conditions, and readiness validation are each assigned to a task.
- Deliberate exclusions: baseline patch capture and the A/B Spark benchmark require separate lifecycle/evaluation designs and are not silently approximated here.
- Placeholder scan: angle-bracket placeholders appear only in explanatory test expectations, not as implementation requirements.
- Type consistency: `ExecutionSpecV2` is the single v2 name across planner, runtime, Hands, Verifier, and GitHub; `IssueSpec` remains the legacy type.
