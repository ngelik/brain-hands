# Brain Hands Auto Browser Verify Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `brain-hands implement` automatically run browser checks declared by an issue before PR creation.

**Architecture:** Keep `src/browser/verifier.ts` as the browser evidence producer. Inject a browser verifier dependency into `implementIssue()` so production code calls `verifyBrowserIssue()` and tests can use a fake verifier without launching Chrome. `runVerification()` remains the final evidence gate and reads the generated browser report from `verification.expected_artifacts`.

**Tech Stack:** TypeScript, Node.js, Commander, Zod, Vitest, existing Chrome/CDP browser verifier.

## Global Constraints

- Skip per-issue worktrees for now.
- Do not make browser verification depend on GitHub auth.
- Do not launch Chrome from unit tests.
- Preserve dry-run behavior except that issues with `browser_checks` must still produce/validate browser evidence.
- Preserve backward compatibility for issues without `browser_checks`.
- Browser verification must run before `runVerification()` so artifact and browser evidence checks can consume the report.
- Failed browser verification must stop before PR creation and leave the run in `local_verification`.
- Existing CLI `browser verify` must keep working.

---

## File Structure

- Modify `src/workflow/implementer.ts`: add `browserVerifier` dependency, auto-run it when an issue has `browser_checks`, and fail before PR creation if it returns failed/skipped.
- Modify `tests/workflow/implementer.test.ts`: add fake browser verifier tests for success and failure paths.
- Modify `solar-system-browser/issues/3d-spacecraft-upgrade.json`: remove manual `node dist/cli.js browser verify ...` from `verification.required_commands`; keep `reports/solar-3d-browser-evidence.json` in expected artifacts.
- Modify `README.md` and `solar-system-browser/README.md`: document that `implement` now runs `browser_checks` automatically, while `browser verify` remains a manual/debug command.

---

### Task 1: Implementer Auto-Runs Browser Checks

**Files:**
- Modify: `src/workflow/implementer.ts`
- Test: `tests/workflow/implementer.test.ts`

**Interfaces:**
- Consumes: `verifyBrowserIssue(input)` from `src/browser/verifier.ts`.
- Produces: optional `ImplementIssueInput.browserVerifier`.
- Produces helper behavior: issues with browser checks write `reports/browser-evidence-issue-<n>.json` before `runVerification()`.

- [ ] **Step 1: Write failing success-path test**

Add a test to `tests/workflow/implementer.test.ts`:

```ts
it("auto-runs browser checks before local verification and PR creation", async () => {
  // create temp repo and ledger
  // issue has browser_checks, verification.expected_artifacts includes reports/browser-evidence-issue-1.json
  // fake browserVerifier writes that report and screenshot
  // implementIssue succeeds
  // expect browserVerifier called once before PR opens
  // expect PR body verification.browser_evidence[0].status === "passed"
});
```

Run:

```bash
npm test -- tests/workflow/implementer.test.ts
```

Expected: FAIL because `ImplementIssueInput` has no `browserVerifier` and `implementIssue()` does not auto-run browser checks.

- [ ] **Step 2: Write failing failure-path test**

Add a test:

```ts
it("prevents PR creation when automatic browser verification fails", async () => {
  // fake browserVerifier returns status "failed"
  // expect VerificationFailedError
  // expect no PR creation
  // expect manifest.stage === "local_verification"
});
```

Run:

```bash
npm test -- tests/workflow/implementer.test.ts
```

Expected: FAIL until implementer surfaces browser verification failure before PR creation.

- [ ] **Step 3: Add browser verifier dependency**

In `src/workflow/implementer.ts`:

```ts
import { verifyBrowserIssue, type BrowserVerifyResult } from "../browser/verifier.js";

export interface ImplementIssueInput {
  ...
  browserVerifier?: typeof verifyBrowserIssue;
}
```

Add helper:

```ts
function browserReportPath(issueNumber: number): string {
  return `reports/browser-evidence-issue-${issueNumber}.json`;
}
```

- [ ] **Step 4: Run browser verifier before `runVerification()`**

Before calling `runVerification()`:

```ts
const browserChecks = issue.browser_checks ?? [];
const expectedArtifacts = [...issue.verification.expected_artifacts];

if (browserChecks.length > 0) {
  const verifier = input.browserVerifier ?? verifyBrowserIssue;
  const reportPath = browserReportPath(input.issueNumber);
  const result = await verifier({
    repoRoot: input.repoRoot,
    issue,
    reportPath,
    runDir: input.runDir,
    issueNumber: input.issueNumber,
  });
  if (!expectedArtifacts.includes(reportPath)) expectedArtifacts.push(reportPath);
  if (result.status !== "passed") {
    const evidence = await runVerification({ ...commands..., expectedArtifacts, browserChecks });
    throw new VerificationFailedError(...);
  }
}
```

Then pass `expectedArtifacts` into `runVerification()`.

- [ ] **Step 5: Verify Task 1**

Run:

```bash
npm test -- tests/workflow/implementer.test.ts tests/verification/runner.test.ts tests/browser/verifier.test.ts
npm run typecheck
```

Expected: all selected tests and typecheck pass.

---

### Task 2: Docs And Solar Issue Cleanup

**Files:**
- Modify: `solar-system-browser/issues/3d-spacecraft-upgrade.json`
- Modify: `README.md`
- Modify: `solar-system-browser/README.md`

**Interfaces:**
- Consumes: automatic browser verification from Task 1.
- Preserves manual CLI: `node dist/cli.js browser verify ...`.

- [ ] **Step 1: Remove manual browser verifier command from solar issue required commands**

Delete this command from `verification.required_commands`:

```bash
node dist/cli.js browser verify --issue-file solar-system-browser/issues/3d-spacecraft-upgrade.json --repo . --report reports/solar-3d-browser-evidence.json
```

Keep browser evidence paths in `verification.expected_artifacts`.

- [ ] **Step 2: Update docs**

In `README.md`, clarify:

- `implement` automatically runs issue `browser_checks`.
- `browser verify` is still useful for manual/debug capture.

In `solar-system-browser/README.md`, clarify:

- local standalone verification still uses `browser verify`
- full `brain-hands implement` no longer requires the browser command in `required_commands`

- [ ] **Step 3: Verify Task 2**

Run:

```bash
npm run build
node dist/cli.js browser verify --issue-file solar-system-browser/issues/3d-spacecraft-upgrade.json --repo . --report reports/solar-3d-browser-evidence.json
node solar-system-browser/scripts/verify.mjs
```

Expected: build succeeds, manual browser command still passes, solar verifier passes.

---

### Task 3: Final Verification And Review

**Files:**
- Review all changed files.

**Interfaces:**
- Consumes: all task outputs.
- Produces: verified implementation and follow-up improvement list.

- [ ] **Step 1: Run full verification**

Run:

```bash
npm test
npm run typecheck
npm run build
node dist/cli.js doctor --repo . --strict --no-github
git diff --check
```

- [ ] **Step 2: Inspect browser evidence**

Confirm `reports/solar-3d-browser-evidence.json` has:

- `status: "passed"`
- both declared checks present
- no missing selectors
- no console errors
- no horizontal overflow
- no overlap failures
- nonblank pixel checks

- [ ] **Step 3: Local code review**

Review the diff for:

- browser verifier runs before `runVerification`
- failed browser verification blocks PR creation
- tests do not launch Chrome
- docs do not imply manual browser verifier is still required inside issue commands

- [ ] **Step 4: Suggest next improvements**

Suggest the next 3-5 improvements, excluding per-issue worktrees.
