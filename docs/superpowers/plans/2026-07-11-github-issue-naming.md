# GitHub Issue Naming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Generate compact, stable GitHub issue titles from an approved plan, safely reconcile managed issue content on resume, and optionally track a run with a separate parent issue.

**Architecture:** New Brain plans supply one `feature_slug`; existing `WorkItem.id` values remain the canonical item slugs. A pure naming module validates and formats display titles, while hidden run/work-item markers remain authoritative for recovery. Parent issue identity is stored separately from the positionally mapped child issue numbers.

**Tech Stack:** TypeScript, Zod, JSON Schema, Vitest, GitHub CLI adapter.

## Global Constraints

- Feature and item slugs use lowercase kebab case.
- The exact `[feature:item]` prefix is at most 35 characters.
- The complete generated issue title is at most 120 characters.
- Work-item titles are unprefixed; runtime code formats GitHub titles.
- `WorkItem.id` remains the dependency, ledger, marker, and visible item identity.
- Hidden run/work-item markers remain the recovery key.
- Existing saved plans without `feature_slug` remain resumable through deterministic fallback.
- Parent issue numbers never enter the child-only `issue_numbers` arrays.
- User-authored issue content outside Brain Hands managed markers is preserved.

---

### Task 1: Pure issue naming contract

**Files:**
- Create: `src/core/issue-naming.ts`
- Create: `tests/core/issue-naming.test.ts`

**Interfaces:**
- Produces: `resolveFeatureSlug(plan)`, `formatWorkItemIssueTitle(input)`, `formatParentIssueTitle(input)`, and slug/title constants.
- Consumes: `BrainPlan` from `src/core/types.ts`.

- [x] Write tests for valid formatting, fallback derivation, invalid slug characters, the exact 35-character prefix boundary, duplicate embedded prefixes, and total title overflow.
- [x] Run `npx vitest run tests/core/issue-naming.test.ts`; expect failure because the module is missing.
- [x] Implement the minimal pure naming functions and validation errors.
- [x] Re-run the focused test; expect all cases to pass.

### Task 2: Brain plan schema and prompt contract

**Files:**
- Modify: `src/core/types.ts`
- Modify: `src/core/schema.ts`
- Modify: `src/core/output-schemas.ts`
- Modify: `src/workflow/planner.ts`
- Modify: `prompts/brain-plan-v2.md`
- Modify: `tests/core/schema.test.ts`
- Modify: `tests/workflow/planner.test.ts`

**Interfaces:**
- Produces: optional persisted `BrainPlan.feature_slug`, required new-output `feature_slug`, and new-plan validation before approval.
- Consumes: slug validation from Task 1.

- [x] Add failing schema tests proving new structured output requires `feature_slug` with kebab-case constraints while the persisted parser accepts an omitted legacy value.
- [x] Add a failing planner test proving invalid generated naming fails before the approval gate.
- [x] Run focused schema/planner tests and confirm the expected failures.
- [x] Add the type/schema fields, planner validation, and prompt rules with valid and invalid examples.
- [x] Re-run focused tests and expect them to pass.

### Task 3: Deterministic child issue titles and managed bodies

**Files:**
- Modify: `src/core/types.ts`
- Modify: `src/workflow/runtime.ts`
- Modify: `src/adapters/github.ts`
- Modify: `tests/adapters/github.test.ts`
- Modify: `tests/workflow/runtime-github.test.ts`

**Interfaces:**
- Produces: `IssueSpec.title`, `feature_slug`, `work_item_id`, and `plan_revision`; managed body formatting and reconciliation helpers; richer marker lookup results.
- Consumes: Task 1 naming functions and the approved current plan revision.

- [x] Add failing adapter tests proving `issue.title` is passed to `gh`, tracking metadata appears in the managed body, and user text outside the managed block survives reconciliation.
- [x] Add failing runtime tests proving exact generated child titles, marker-based reuse, revision reconciliation, and no duplicate creation after a readable title change.
- [x] Run the two focused suites and confirm the expected failures.
- [x] Extend `IssueSpec`, use the approved revision during issue construction, and generate deterministic titles.
- [x] Return number/title/body from marker lookup and update only changed managed content for new-format issues; leave legacy marker-only bodies untouched.
- [x] Re-run focused suites and expect them to pass.

### Task 4: Optional parent issue tracking

**Files:**
- Modify: `src/core/types.ts`
- Modify: `src/core/schema.ts`
- Modify: `src/core/output-schemas.ts`
- Modify: `src/core/ledger.ts`
- Modify: `src/workflow/runtime.ts`
- Modify: `src/workflow/status.ts`
- Modify: `src/adapters/github.ts`
- Modify: `prompts/brain-plan-v2.md`
- Modify: `tests/core/schema.test.ts`
- Modify: `tests/core/ledger.test.ts`
- Modify: `tests/workflow/runtime-github.test.ts`
- Modify: `tests/workflow/status.test.ts`

**Interfaces:**
- Produces: optional `BrainPlan.parent_issue`, nullable `GitHubIds.parent_issue_number`, a parent marker namespace, and parent checklist reconciliation.
- Consumes: Task 1 parent-title formatter and Task 3 managed-body reconciliation.

- [x] Add failing tests proving the parent number is separate, defaults to null for old manifests, resumes by marker, and never shifts child issue mapping.
- [x] Add failing status and PR-body tests for separate parent reporting and closure.
- [x] Run focused tests and confirm expected failures.
- [x] Implement the optional plan field, manifest default, parent creation/recovery, child parent references, checklist update, and separate status output.
- [x] Re-run focused tests and expect them to pass.

### Task 5: Documentation and release verification

**Files:**
- Modify: `README.md`
- Modify: `agentic-codex-workflow.md`

**Interfaces:**
- Documents: generated-title syntax, canonical identities, managed sections, legacy behavior, and optional parent semantics.

- [x] Update the user and operator documentation without changing unrelated workflow behavior.
- [x] Run `npm run typecheck`.
- [x] Run `npm test`.
- [x] Run `npm run build`.
- [x] Run `node dist/cli.js --version`.
- [x] Run `git diff --check`.
- [x] Run `npm_config_cache=/private/tmp/brain-hands-npm-cache npm pack --dry-run`.
- [x] Review `git diff --stat` and `git status --short`; preserve unrelated changes and report exact verification evidence.
