# Issue Execution Sequence Implementation Plan

**Goal:** Generate GitHub child issue titles as `[feature-slug:execution-sequence:work-item-id] Title`, where sequence is the one-based canonical execution order.

**Architecture:** Extract the runtime's stable topological sorter into a pure core module shared by execution and GitHub status replay. Keep sequence presentation-only: work-item IDs, durable markers, issue numbers, manifests, and maps remain authoritative. New plans validate worst-case title capacity without reclassifying graph failures as naming failures.

**Tech stack:** TypeScript, Node.js 20+, Vitest, Zod, GitHub adapter abstractions.

## Global Constraints

- Work in the existing host-managed worktree; do not create a branch or mutate live GitHub issues.
- Follow strict TDD: add a focused failing test, observe the expected RED result, implement minimally, then observe GREEN.
- Exact child title format: `[<feature-slug>:<execution-sequence>:<work-item-id>] <action-oriented title>`.
- Sequence is a positive safe integer and is one-based.
- Dependency order wins; approved plan order is the deterministic tie-breaker for independent work items.
- Sequence is presentation only. Do not add it to `ExecutionSpecV2`, schemas, persisted plans, markers, manifests, `github-map.json`, or issue identity.
- Parent issue titles remain `[<feature-slug>] <title>`.
- Legacy plans with invalid work-item IDs retain their unprefixed title fallback.
- Preserve the existing `topologicallySortWorkItems` export from `src/workflow/runtime.ts` for compatibility.
- Planning-time naming validation uses `plan.work_items.length` as the worst-case sequence width and must not topologically sort or turn graph failures into `plan.issue_naming` diagnostics.
- Do not modify `src/core/types.ts`, `src/core/schema.ts`, `src/core/output-schemas.ts`, `src/core/ledger.ts`, or `src/adapters/github.ts`.
- Do not use `npm link`. Do not publish or install a stable package.
- Do not stage or commit in this detached, host-managed worktree. Keep each task's diff limited to its listed files so it can be reviewed independently.

### Task 1: Centralize canonical work-item ordering

**Files:**
- Create: `src/core/work-item-order.ts`
- Create: `tests/core/work-item-order.test.ts`
- Modify: `src/workflow/runtime.ts`

**Requirements:**
- Export `topologicallySortWorkItems(items: readonly WorkItem[]): WorkItem[]` from the new core module.
- Preserve the current behavior and error messages for duplicate IDs, missing dependencies, cycles, dependency-first order, and plan-order tie-breaking.
- Replace runtime-local calls with the imported helper.
- Re-export the helper from `src/workflow/runtime.ts`.
- Add focused unit coverage for dependency order, independent-item stability, duplicate ID, missing dependency, and cycle.
- Verify RED before creating the production module.
- GREEN commands: `npm test -- tests/core/work-item-order.test.ts tests/workflow/runtime-local.test.ts tests/workflow/runtime-github.test.ts` and `npm run typecheck`.
- Report the exact files changed and the RED/GREEN test evidence; do not stage or commit.

### Task 2: Add execution sequence to generated issue titles

**Files:**
- Modify: `src/core/issue-naming.ts`
- Modify: `src/workflow/planner.ts`
- Modify: `src/workflow/plan-check.ts`
- Modify: `src/workflow/runtime.ts`
- Modify: `tests/core/issue-naming.test.ts`
- Modify: `tests/workflow/runtime-github.test.ts`

**Requirements:**
- Require `sequence: number` in `formatWorkItemIssueTitle`.
- Reject zero, negative, fractional, and unsafe integer sequences with an error containing `positive safe integer`.
- Generate `[featureSlug:sequence:itemSlug] title`.
- Raise the bounded maximum prefix length to 52 while keeping the complete title maximum at 120.
- Cover one-digit, multi-digit, invalid sequence, maximum safe-integer prefix, exact 120-character acceptance, and 121-character rejection.
- In planner and plan-check naming validation, pass `plan.work_items.length` for every item to validate worst-case digit width without sorting.
- Change runtime title generation to accept and pass `index + 1` from `orderedWorkItems.entries()`.
- Preserve the legacy catch that returns the raw item title only when `feature_slug` is absent.
- Make the runtime GitHub test double record and apply explicit update titles.
- Assert the one-item title, two-item dependency order, stale-title reconciliation, legacy fallback, and unchanged parent title.
- Verify RED before production changes.
- GREEN commands: `npm test -- tests/core/issue-naming.test.ts tests/workflow/planner.test.ts tests/workflow/runtime-github.test.ts` and `npm run typecheck`.
- Report the exact files changed and the RED/GREEN test evidence; do not stage or commit.

### Task 3: Align GitHub status replay with canonical execution order

**Files:**
- Modify: `src/workflow/github-status.ts`
- Modify: `tests/workflow/github-status.test.ts`

**Requirements:**
- Add a RED regression with raw plan order `[dependent, dependency]` proving current replay renders the wrong positions.
- Import `topologicallySortWorkItems` from the core helper.
- In both `reconstructLedgerProjections` and replay's final work-item loop, iterate the canonical ordered list and use its length for `workItemTotal`.
- Do not alter status intent identity, marker ownership, or immutable event identity.
- Assert the dependency status contains `(1 of 2)` and the dependent status contains `(2 of 2)`.
- GREEN commands: `npm test -- tests/workflow/github-status.test.ts tests/github/status-projection.test.ts tests/github/status-sync.test.ts tests/workflow/runtime-github.test.ts` and `npm run typecheck`.
- Report the exact files changed and the RED/GREEN test evidence; do not stage or commit.

### Task 4: Update prompt and operator documentation

**Files:**
- Modify: `prompts/brain-plan-v2.md`
- Modify: `README.md`
- Modify: `agentic-codex-workflow.md`

**Requirements:**
- Replace the old title formula with `[feature_slug:execution-sequence:work-item-id]` or the documentation's angle-bracket equivalent.
- State that runtime topologically orders approved work items and alone adds the prefix and execution sequence.
- State that dependencies precede dependents and approved plan order breaks ties.
- State that sequence is presentation-only; marker and work-item identities remain authoritative.
- State that dependency changes may renumber visible titles without changing issue numbers or mappings.
- Keep parent titles unnumbered and model-authored work-item titles unprefixed.
- Verify no obsolete formula remains in these three files with `rg`.
- Run `npm test -- tests/prompts/renderer.test.ts tests/workflow/planner.test.ts` and `npm run typecheck`.
- Report the exact files changed and validation evidence; do not stage or commit.

### Task 5: Whole-change verification and closure

**Requirements:**
- Run an independent whole-change review against this plan and fix every Critical or Important finding, then re-review.
- Run: `npm test`.
- Run: `npm run typecheck`.
- Run: `npm run build`.
- Run: `git diff --check`.
- Run: `node dist/cli.js --version`.
- Run: `npm pack --dry-run` with `npm_config_cache=/private/tmp/brain-hands-npm-cache` if the default cache is unavailable.
- Inspect the final diff for unrelated changes and confirm live GitHub issues were not mutated.
