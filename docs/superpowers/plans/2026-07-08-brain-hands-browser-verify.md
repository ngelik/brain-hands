# Brain Hands Browser Verify Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a generic `brain-hands browser verify` command that turns issue `browser_checks` into real Chrome evidence, screenshot artifacts, and optional run-ledger evidence.

**Architecture:** Keep browser verification as a reusable workflow module, not a solar-specific script. The CLI reads an `IssueSpec`, runs each declared browser check through a local server plus Chrome DevTools Protocol, writes a normalized report, and exits nonzero when any declared check fails.

**Tech Stack:** TypeScript, Node.js, Commander, Zod, Vitest, Chrome DevTools Protocol over WebSocket, local subprocess server commands.

## Global Constraints

- Preserve the existing `IssueSpec.browser_checks` contract and keep new fields optional/backward compatible.
- Do not use remote browser automation services.
- Do not use shell execution for `local_server_command`; parse into executable and argv.
- Browser evidence must include required selector, expected network, console policy, screenshot, viewport, pixel, overflow, and optional forbidden-overlap outcomes.
- `brain-hands browser verify` must write deterministic JSON and screenshot artifacts.
- When `--run` and `--issue` are supplied, the command must also write ledger evidence under `verification/issue-<n>/browser-evidence.json`.
- Failed browser checks must produce process exit code `1`.
- Existing verification evidence parsing must recognize the new normalized report format.
- Verify with unit tests, typecheck, build, and the real solar-system browser app through Chrome.

---

## File Structure

- Create `src/core/command.ts`: shared no-shell command splitter used by verification commands and browser server commands.
- Modify `src/verification/runner.ts`: import shared command splitter and load normalized browser report bundles.
- Create `src/browser/verifier.ts`: browser verification orchestration, Chrome CDP driver, local-server lifecycle, report writing, and pure report-evaluation helpers.
- Modify `src/core/types.ts`: add optional browser check viewport/layout fields and normalized report bundle types.
- Modify `src/core/schema.ts`: validate optional browser check fields and normalized browser evidence bundles.
- Modify `src/cli.ts`: add `browser verify --issue-file --repo --report [--run --issue --chrome]`.
- Modify `tests/verification/runner.test.ts`: prove normalized browser report bundles are consumed by `runVerification`.
- Create `tests/browser/verifier.test.ts`: prove browser report evaluation and command writing behavior with fake harness dependencies.
- Modify `tests/cli-smoke.test.ts`: prove the new nested browser command and options are registered.
- Modify `solar-system-browser/issues/3d-spacecraft-upgrade.json`: add explicit viewport/overflow fields and use the generic browser verifier in required commands.
- Modify `README.md` and `solar-system-browser/README.md`: document the generic command and the solar app example.

---

### Task 1: Shared Command Parsing And Normalized Report Schema

**Files:**
- Create: `src/core/command.ts`
- Modify: `src/verification/runner.ts`
- Modify: `src/core/types.ts`
- Modify: `src/core/schema.ts`
- Test: `tests/verification/runner.test.ts`
- Test: `tests/core/schema.test.ts`

**Interfaces:**
- Produces: `splitCommand(command: string): { executable: string; args: string[] }`.
- Produces: `BrowserEvidenceBundle` with `generated_at`, `status`, and `reports`.
- Consumes: existing verification command strings and browser evidence artifacts.

- [ ] **Step 1: Add failing tests for normalized browser evidence bundles**

Add a runner test that writes `reports/browser-evidence.json` as:

```json
{
  "generated_at": "2026-07-08T12:00:00.000Z",
  "status": "passed",
  "reports": [
    {
      "check_name": "desktop smoke",
      "url": "http://127.0.0.1:5177/app.html",
      "status": "passed",
      "observed_selectors": ["#app"],
      "missing_selectors": [],
      "console_errors": [],
      "expected_network": ["/app.js"],
      "observed_network": ["/app.js"],
      "screenshot_artifact": "reports/desktop.png",
      "console_error_policy": "no_errors",
      "failure_reasons": [],
      "skipped_reason": null
    }
  ]
}
```

Run:

```bash
npm test -- tests/verification/runner.test.ts
```

Expected: FAIL because `runVerification` does not yet load `reports[]` bundles.

- [ ] **Step 2: Extract command splitter**

Move the existing `splitCommand` implementation from `src/verification/runner.ts` into `src/core/command.ts`:

```ts
export function splitCommand(command: string): { executable: string; args: string[] } {
  // Same no-shell parsing behavior currently used by runVerification.
}
```

Update `src/verification/runner.ts` to import it.

- [ ] **Step 3: Add browser schema/types**

Add optional browser check fields:

```ts
viewport?: { width: number; height: number; mobile?: boolean };
wait_ms?: number;
require_no_horizontal_overflow?: boolean;
forbidden_overlaps?: Array<[string, string]>;
```

Add a bundle schema:

```ts
export const browserEvidenceBundleSchema = z.object({
  generated_at: z.string().datetime(),
  status: z.enum(["passed", "failed", "skipped"]),
  reports: z.array(browserEvidenceReportSchema),
});
```

Allow `BrowserEvidenceReport` to include `failure_reasons?: string[]`.

- [ ] **Step 4: Load normalized bundles**

Update `loadBrowserEvidenceReports` so it accepts:

- one `browserEvidenceReportSchema` object
- one `browserEvidenceBundleSchema` object
- legacy solar aggregate reports under `captures`

- [ ] **Step 5: Verify Task 1**

Run:

```bash
npm test -- tests/core/schema.test.ts tests/verification/runner.test.ts
npm run typecheck
```

Expected: all selected tests and typecheck pass.

---

### Task 2: Generic Browser Verifier Module

**Files:**
- Create: `src/browser/verifier.ts`
- Create: `tests/browser/verifier.test.ts`

**Interfaces:**
- Produces: `verifyBrowserIssue(input: VerifyBrowserIssueInput): Promise<BrowserVerifyResult>`.
- Produces pure helper: `buildBrowserEvidenceReport(check, capture): BrowserEvidenceReport`.
- Consumes: `IssueSpec.browser_checks`.

- [ ] **Step 1: Write failing report-evaluation tests**

Create tests proving:

- missing required selectors fail the report
- missing expected network entries fail the report
- console warnings/errors fail when policy is `no_errors`
- missing screenshot or blank screenshot fails the report
- horizontal overflow fails when `require_no_horizontal_overflow` is true
- forbidden selector overlap fails when declared

Run:

```bash
npm test -- tests/browser/verifier.test.ts
```

Expected: FAIL because `src/browser/verifier.ts` does not exist.

- [ ] **Step 2: Implement pure report evaluation**

Implement `buildBrowserEvidenceReport` so it returns a normalized `BrowserEvidenceReport` with concrete `failure_reasons`, `observed_selectors`, `missing_selectors`, `observed_network`, and `status`.

- [ ] **Step 3: Implement local server and Chrome harness**

Implement:

- `startLocalServer(command, repoRoot)`
- `ChromeCdpSession`
- `captureBrowserCheck(check, repoRoot, chromePath?)`
- screenshot writing to `repoRoot/check.screenshot_artifact`

The browser capture must collect:

- selectors from `check.required_selectors`
- network resource paths from `performance.getEntriesByType("resource")`
- console/log exceptions
- document horizontal overflow
- declared forbidden overlaps
- screenshot pixel diversity

- [ ] **Step 4: Implement report writing and ledger writing**

Implement `verifyBrowserIssue` so it writes:

- report path under repo root from `--report`
- optional run artifact `verification/issue-<n>/browser-evidence.json`

It returns `status: "passed" | "failed" | "skipped"` and an absolute `reportPath`.

- [ ] **Step 5: Verify Task 2**

Run:

```bash
npm test -- tests/browser/verifier.test.ts
npm run typecheck
```

Expected: all selected tests and typecheck pass.

---

### Task 3: CLI Wiring, Docs, And Solar Integration

**Files:**
- Modify: `src/cli.ts`
- Modify: `tests/cli-smoke.test.ts`
- Modify: `solar-system-browser/issues/3d-spacecraft-upgrade.json`
- Modify: `README.md`
- Modify: `solar-system-browser/README.md`

**Interfaces:**
- Produces CLI: `brain-hands browser verify --issue-file <issue.json> --repo <repo> --report <path> [--run <runDir> --issue <number> --chrome <path>]`.
- Consumes: current solar issue JSON.

- [ ] **Step 1: Write failing CLI smoke test**

Assert that `buildCli()` has a `browser` command with nested `verify` command and options:

```ts
expect(optionNames).toContain("issue-file");
expect(optionNames).toContain("repo");
expect(optionNames).toContain("report");
expect(optionNames).toContain("run");
expect(optionNames).toContain("issue");
expect(optionNames).toContain("chrome");
```

Run:

```bash
npm test -- tests/cli-smoke.test.ts
```

Expected: FAIL because the command is not registered.

- [ ] **Step 2: Wire the command**

Add the `browser verify` command to `src/cli.ts`. It must parse the issue file with `issueSpecSchema`, call `verifyBrowserIssue`, print a per-check summary, and set `process.exitCode = 1` on failed status.

- [ ] **Step 3: Update solar issue**

Add explicit viewports to the two browser checks:

```json
"viewport": { "width": 1512, "height": 738, "mobile": false },
"require_no_horizontal_overflow": true
```

and:

```json
"viewport": { "width": 390, "height": 844, "mobile": true },
"require_no_horizontal_overflow": true
```

Add the generic verifier command to `verification.required_commands`:

```bash
node dist/cli.js browser verify --issue-file solar-system-browser/issues/3d-spacecraft-upgrade.json --repo . --report reports/solar-3d-browser-evidence.json
```

- [ ] **Step 4: Update docs**

Document the generic browser command in `README.md` and reference it from `solar-system-browser/README.md`.

- [ ] **Step 5: Verify Task 3**

Run:

```bash
npm test -- tests/cli-smoke.test.ts
npm run build
node dist/cli.js browser verify --issue-file solar-system-browser/issues/3d-spacecraft-upgrade.json --repo . --report reports/solar-3d-browser-evidence.json
node solar-system-browser/scripts/verify.mjs
```

Expected: tests pass, build succeeds, Chrome evidence command exits `0`, and the solar verifier exits `0`.

---

### Task 4: Final Verification And Review Loop

**Files:**
- Review all changed files.
- No new source files unless review finds a defect.

**Interfaces:**
- Consumes: all previous task outputs.
- Produces: final verified worktree.

- [ ] **Step 1: Run full verification**

Run:

```bash
npm test
npm run typecheck
npm run build
node dist/cli.js doctor --repo . --strict --no-github
git diff --check
```

- [ ] **Step 2: Inspect generated report**

Open `reports/solar-3d-browser-evidence.json` and confirm:

- `status` is `passed`
- both declared checks are present
- no `missing_selectors`
- no `missing_network`
- no `console_errors`
- screenshots exist

- [ ] **Step 3: Code review**

Review the branch diff against this plan. Fix all Critical or Important findings, rerun the relevant tests, and repeat until no blocking findings remain.

- [ ] **Step 4: Final status**

Confirm `git status --short` only shows intentional changed files and generated evidence. Then provide the commands run and remaining risks, if any.
