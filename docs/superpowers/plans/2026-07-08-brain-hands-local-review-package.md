# PR-Less Local Review Package Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `brain-hands review-package` command that creates a model-ready local review bundle when GitHub PR review is unavailable.

**Architecture:** Keep the feature as a workflow helper that reads the existing run ledger, copies existing evidence artifacts, captures the current local git diff, and writes a review folder. The CLI only validates arguments, invokes the helper, and prints the generated paths.

**Tech Stack:** TypeScript, Commander, Node.js filesystem APIs, existing `runCommand`, existing issue and verification schemas, Vitest.

## Global Constraints

- Do not require GitHub auth or a pull request.
- Use `.brain-hands/runs/<run-id>/` as the source of truth for request, issue, implementation, and verification artifacts.
- Generate a folder a reviewer can open directly, with `review.md` as the main human-readable entry point.
- Preserve existing dirty worktree content and do not revert unrelated files.
- Follow TDD: write failing tests before implementation.

---

### Task 1: Review Package Generator

**Files:**
- Create: `tests/workflow/review-package.test.ts`
- Create: `src/workflow/review-package.ts`

**Interfaces:**
- Consumes: `readManifest(runDir)`, `issueSpecSchema.array()`, `verificationEvidenceSchema`, `runCommand`.
- Produces: `createReviewPackage(input: CreateReviewPackageInput): Promise<ReviewPackageResult>`.

- [ ] **Step 1: Write failing tests**

Add tests that seed a run ledger with `original-request.md`, `issues.json`, `implementation-issue-1.md`, `verification/issue-1/evidence.json`, browser evidence, screenshots, and a modified git file.

Assert that `createReviewPackage()` writes:
- `review.md`
- `issue.json`
- `implementation.md`
- `verification/evidence.json`
- `browser-evidence.json`
- `diff.patch`
- `screenshots.txt`
- `prompt.md`

Also assert `review.md` contains the original request, issue goal, acceptance criteria, changed files, command results, browser summary, risks, and review checklist.

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
npm test -- tests/workflow/review-package.test.ts
```

Expected: fail because `src/workflow/review-package.ts` does not exist.

- [ ] **Step 3: Implement the generator**

Create `src/workflow/review-package.ts` with:

```ts
export interface CreateReviewPackageInput {
  repoRoot: string;
  runDir: string;
  issueNumber: number;
  outDir: string;
}

export interface ReviewPackageResult {
  packageDir: string;
  reviewPath: string;
  promptPath: string;
  copiedFiles: string[];
}
```

Implementation behavior:
- Resolve issue number through `manifest.issue_numbers`, falling back to one-based issue index.
- Read and schema-validate the selected issue.
- Read optional `original-request.md`, `implementation-issue-<n>.md`, and `verification/issue-<n>/evidence.json`.
- Copy verification evidence to `verification/evidence.json`.
- Copy browser evidence from `evidence.browser_evidence[].evidence_report_path` or `verification/issue-<n>/browser-evidence.json` if present.
- Capture `git diff --no-ext-diff --binary` to `diff.patch`.
- Capture changed files from `git diff --name-only`.
- Write `screenshots.txt` listing browser screenshot artifacts and whether each exists.
- Write `review.md` with the required human-readable sections.
- Write `prompt.md` that instructs the brain reviewer to inspect the package and return approve/request_changes/replan_required.

- [ ] **Step 4: Run focused tests and fix failures**

Run:

```bash
npm test -- tests/workflow/review-package.test.ts
```

Expected: pass.

### Task 2: CLI Command

**Files:**
- Modify: `src/cli.ts`
- Modify: `tests/cli-smoke.test.ts`

**Interfaces:**
- Consumes: `createReviewPackage`.
- Produces: `brain-hands review-package --run <runDir> --issue <number> --out <path> [--repo <path>]`.

- [ ] **Step 1: Write failing CLI smoke test**

Add an assertion that the top-level commands include `review-package`, and that the command exposes `run`, `issue`, `out`, and `repo` options.

- [ ] **Step 2: Run the CLI smoke test and verify RED**

Run:

```bash
npm test -- tests/cli-smoke.test.ts
```

Expected: fail because the command is not registered.

- [ ] **Step 3: Wire the command**

Import `createReviewPackage`, add the command, parse `--issue` with `parsePositiveInteger`, default `--repo` to `process.cwd()`, and print the package directory plus `review.md` path.

- [ ] **Step 4: Run CLI smoke test and focused generator test**

Run:

```bash
npm test -- tests/cli-smoke.test.ts tests/workflow/review-package.test.ts
```

Expected: pass.

### Task 3: Human Docs

**Files:**
- Modify: `README.md`
- Create: `AGENTS.md`

**Interfaces:**
- Produces operator-readable project guidance.

- [ ] **Step 1: Update README**

Make the README concise and human-readable. Include:
- What the project is.
- The brain/hands flow.
- Where run artifacts live.
- How to use `doctor`, `run`, `implement`, `browser verify`, `review-package`, `review`, `fix`, and `final-audit`.
- What to do when GitHub auth is unavailable.

- [ ] **Step 2: Add AGENTS.md**

Add repo-local agent guidance:
- Read README first.
- Preserve dirty worktree state.
- Use review packages when GitHub PR review is unavailable.
- Run focused tests before full verification.
- Use `node dist/cli.js` after build if `tsx` fails in this sandbox.

### Task 4: Final Verification

**Files:**
- No source edits.

- [ ] **Step 1: Run focused tests**

```bash
npm test -- tests/workflow/review-package.test.ts tests/cli-smoke.test.ts
```

- [ ] **Step 2: Run full test suite**

```bash
npm test
```

- [ ] **Step 3: Run typecheck and build**

```bash
npm run typecheck
npm run build
```

- [ ] **Step 4: Run CLI preflight without GitHub**

```bash
node dist/cli.js doctor --repo . --strict --no-github
```

- [ ] **Step 5: Check whitespace**

```bash
git diff --check
```

- [ ] **Step 6: Inspect changed files**

```bash
git status --short
git diff --stat
```

Expected: new review package feature, README updates, and AGENTS.md guidance are present with no unrelated reversions.
