# Manual Pre-Tag Release Rehearsal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Do not use subagents unless the user explicitly authorizes them.

**Goal:** Add a deterministic manual release-dispatch rehearsal that proves the built local CLI can complete the happy path, a same-run Verifier correction, and an abrupt-process resume before `scripts/release.sh` creates a release commit or tag.

**Architecture:** Keep the existing canonical built-CLI test in the ordinary suite, add a separate three-scenario Vitest lane for release dispatches, and use a narrowly gated internal dry-run control to select the correction fixture or park an execution at a durable checkpoint. The interruption scenario kills the parked child from the test harness, then resumes the same ledger in a new process. `scripts/release.sh` adds this lane to its existing gates without changing CI, npm publication, or the package allowlist.

**Tech Stack:** TypeScript 6, Node.js 20+, Vitest 4, Execa 9, Bash, Git.

## Global Constraints

- This is a mandatory gate for release dispatches performed through `scripts/release.sh`; it cannot prevent a maintainer from manually pushing a tag outside that dispatcher.
- Do not run the rehearsal during ordinary builds, `npm test`, commits, `prepack`, pull-request CI, or tag-publication CI.
- Run it only through `npm run release:e2e`, invoked directly by a maintainer or by `scripts/release.sh`.
- Use exactly three release scenarios: `happy`, `verifier-fix`, and `interrupted-resume`.
- Use the built checkout CLI at `dist/cli.js`; do not use the globally installed `brain-hands` command or `npm link`.
- Use deterministic `--dry-run` fixtures only. Do not invoke live models, require model credentials, mutate GitHub, or add public rehearsal flags.
- Internal rehearsal controls require all of: `NODE_ENV=test`, `BRAIN_HANDS_RELEASE_REHEARSAL=1`, `--dry-run`, local mode, and a recognized scenario.
- Do not add a canary, dependency, network service, sentinel inside the run ledger, package file, version, release commit, tag, push, or publication.
- A rehearsal failure must happen before the release commit, tag, atomic push, or npm publication. Version-sync worktree edits may remain for a safe rerun.
- Remove successful temporary repositories. Preserve and print failed repositories and their run directories.
- Keep runtime package contents limited to `dist/`, `prompts/`, `agentic-codex-workflow.md`, `README.md`, and package metadata.
- Preserve unrelated worktree changes. Every product-code edit must trace directly to this rehearsal.

## Execution Precondition

The implementing worker must execute this plan from the checkout that owns `main`, unless the user explicitly chooses another branch or worktree.

- [ ] Confirm the execution checkout before changing product code.

```bash
pwd
git status --short --branch
git branch --show-current
git rev-parse HEAD
git worktree list
```

Expected: the implementation checkout is on `main`, unrelated changes are identified and preserved, and no release tag points at a new implementation commit.

## File Structure

**Create**

- `vitest.release.config.ts` — discovers only manual release-rehearsal tests.
- `src/testing/release-rehearsal.ts` — resolves the private rehearsal scenario and supplies the interruption dependency.
- `tests/workflow/release-rehearsal-controls.test.ts` — unit coverage for the private gate and checkpoint behavior.
- `tests/release/rehearsal-harness.ts` — owns temporary repositories, child processes, fingerprints, lineage checks, traps, and cleanup.
- `tests/release/release-rehearsal.test.ts` — contains exactly the three release scenarios.

**Modify**

- `package.json` — adds `release:e2e`; leaves `test`, `build`, and `prepack` semantics intact.
- `vitest.config.ts` — excludes `tests/release/**/*.test.ts` from ordinary tests.
- `src/cli.ts` — threads the resolved scenario into dry-run Verifier fixtures, reflection, and local runtime dependencies.
- `tests/workflow/canonical-session-built-cli.test.ts` — remains unchanged in ordinary built-CLI coverage.
- `scripts/release.sh` — runs `npm run release:e2e` before release Git state.
- `tests/scripts/release.test.ts` — proves gate order, failure behavior, and resumable dispatch behavior.
- `tests/scripts/ci-workflow.test.ts` — proves ordinary CI does not run the manual lane.
- `tests/scripts/publish-workflow.test.ts` — proves tag validation/publication does not run the manual lane.
- `docs/RELEASING.md` — documents the dispatcher guarantee, scenarios, diagnostics, and recovery.

---

### Task 1: Create the Manual-Only Test Lane Without Losing Default Coverage

**Files:**

- Create: `vitest.release.config.ts`
- Modify: `package.json:30-41`
- Modify: `vitest.config.ts:1-12`
- Test: Vitest discovery commands

**Interfaces:**

- Consumes: the existing `npm run build` and `dist/cli.js` contract.
- Produces: `npm run release:e2e` and an isolated `tests/release/**/*.test.ts` lane.
- Preserves: `tests/workflow/canonical-session-built-cli.test.ts` in ordinary `npm test`.

- [ ] **Step 1: Create an intentionally empty release-suite placeholder**

Create `tests/release/release-rehearsal.test.ts` with a temporary skipped declaration so discovery can be tested before scenarios exist:

```ts
import { describe, it } from "vitest";

describe.skip("manual release rehearsal", () => {
  it("is populated by Tasks 3 through 5", () => {});
});
```

- [ ] **Step 2: Add the dedicated Vitest configuration**

Create `vitest.release.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    fileParallelism: false,
    globals: true,
    include: ["tests/release/**/*.test.ts"],
    passWithNoTests: false,
    restoreMocks: true,
    testTimeout: 120_000,
    hookTimeout: 30_000,
  },
});
```

- [ ] **Step 3: Exclude the release lane from the default configuration**

Change `vitest.config.ts` to:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    fileParallelism: false,
    globals: true,
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/release/**/*.test.ts"],
    restoreMocks: true,
    testTimeout: 10_000,
  },
});
```

- [ ] **Step 4: Add the package script without changing existing scripts**

Add this entry beside `test`:

```json
"release:e2e": "npm run build && vitest run --config vitest.release.config.ts"
```

Do not remove the build from `test`, `prepack`, or `scripts/release.sh` in this task.

- [ ] **Step 5: Verify discovery boundaries**

Run:

```bash
npx vitest list --config vitest.config.ts
npx vitest list --config vitest.release.config.ts
```

Expected:

- Default output contains `tests/workflow/canonical-session-built-cli.test.ts`.
- Default output contains no `tests/release/` test.
- Release output contains only `tests/release/release-rehearsal.test.ts`.

- [ ] **Step 6: Verify ordinary tests remain green**

Run:

```bash
npm test
```

Expected: PASS, including the existing canonical built-CLI lifecycle test and excluding the skipped release placeholder.

- [ ] **Step 7: Commit the lane**

```bash
git add package.json vitest.config.ts vitest.release.config.ts tests/release/release-rehearsal.test.ts
git commit -m "test: isolate manual release rehearsal"
```

---

### Task 2: Add Fail-Closed Private Rehearsal Controls

**Files:**

- Create: `src/testing/release-rehearsal.ts`
- Create: `tests/workflow/release-rehearsal-controls.test.ts`
- Modify: `src/cli.ts:1-70, 500-780, 787-805, 900-950`

**Interfaces:**

- Produces:

```ts
export type ReleaseRehearsalScenario = "happy" | "verifier-fix" | "interrupted-resume";

export function configuredReleaseRehearsalScenario(input: {
  dryRun: boolean;
  mode: RunMode;
  env?: NodeJS.ProcessEnv;
}): ReleaseRehearsalScenario | null;

export function releaseRehearsalDependencies(
  scenario: ReleaseRehearsalScenario | null,
): LocalRuntimeDependencies | undefined;
```

- Consumes: `RunMode` from `src/core/types.ts`, `LocalRuntimeDependencies` from `src/workflow/runtime.ts`, and the runtime checkpoint `after_work_item_advance_effect`.
- Safety property: the environment variable is not a security boundary; the combined test/dry-run/local gates prevent accidental activation during normal operation.

- [ ] **Step 1: Write resolver tests first**

Create `tests/workflow/release-rehearsal-controls.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import {
  configuredReleaseRehearsalScenario,
  releaseRehearsalDependencies,
} from "../../src/testing/release-rehearsal.js";

const enabled = {
  NODE_ENV: "test",
  BRAIN_HANDS_RELEASE_REHEARSAL: "1",
  BRAIN_HANDS_RELEASE_REHEARSAL_SCENARIO: "happy",
};

describe("release rehearsal controls", () => {
  it("stays disabled when the private master switch is absent", () => {
    expect(configuredReleaseRehearsalScenario({
      dryRun: true,
      mode: "local",
      env: { NODE_ENV: "test", BRAIN_HANDS_RELEASE_REHEARSAL_SCENARIO: "happy" },
    })).toBeNull();
  });

  it.each([
    ["non-test environment", { ...enabled, NODE_ENV: "production" }, true, "local"],
    ["non-dry-run command", enabled, false, "local"],
    ["GitHub mode", enabled, true, "github"],
  ] as const)("rejects %s", (_name, env, dryRun, mode) => {
    expect(() => configuredReleaseRehearsalScenario({ dryRun, mode, env }))
      .toThrow(/release rehearsal/i);
  });

  it.each(["happy", "verifier-fix", "interrupted-resume"] as const)(
    "accepts the %s scenario under every gate",
    (scenario) => {
      expect(configuredReleaseRehearsalScenario({
        dryRun: true,
        mode: "local",
        env: { ...enabled, BRAIN_HANDS_RELEASE_REHEARSAL_SCENARIO: scenario },
      })).toBe(scenario);
    },
  );

  it("rejects a missing or unknown scenario", () => {
    expect(() => configuredReleaseRehearsalScenario({
      dryRun: true,
      mode: "local",
      env: { ...enabled, BRAIN_HANDS_RELEASE_REHEARSAL_SCENARIO: "unknown" },
    })).toThrow(/unknown release rehearsal scenario/i);
  });

  it("parks only the interruption scenario at the durable work-item checkpoint", async () => {
    vi.useFakeTimers();
    try {
      const dependencies = releaseRehearsalDependencies("interrupted-resume");
      if (!dependencies?.afterCheckpoint) throw new Error("expected interruption dependency");
      await expect(dependencies.afterCheckpoint("after_status_verifying_publication"))
        .resolves.toBeUndefined();

      let settled = false;
      const parked = dependencies.afterCheckpoint("after_work_item_advance_effect")
        .finally(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(settled).toBe(false);
      await vi.runAllTimersAsync();
      await expect(parked).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
```

- [ ] **Step 2: Run the tests and verify they fail**

```bash
npx vitest run tests/workflow/release-rehearsal-controls.test.ts
```

Expected: FAIL because `src/testing/release-rehearsal.ts` does not exist.

- [ ] **Step 3: Implement the resolver and parking dependency**

Create `src/testing/release-rehearsal.ts`:

```ts
import type { RunMode } from "../core/types.js";
import type { LocalRuntimeDependencies } from "../workflow/runtime.js";

export type ReleaseRehearsalScenario =
  | "happy"
  | "verifier-fix"
  | "interrupted-resume";

const scenarios = new Set<ReleaseRehearsalScenario>([
  "happy",
  "verifier-fix",
  "interrupted-resume",
]);

const PARK_MS = 300_000;

export function configuredReleaseRehearsalScenario(input: {
  dryRun: boolean;
  mode: RunMode;
  env?: NodeJS.ProcessEnv;
}): ReleaseRehearsalScenario | null {
  const env = input.env ?? process.env;
  if (env.BRAIN_HANDS_RELEASE_REHEARSAL !== "1") return null;
  if (env.NODE_ENV !== "test") {
    throw new Error("Release rehearsal requires NODE_ENV=test");
  }
  if (!input.dryRun) throw new Error("Release rehearsal requires --dry-run");
  if (input.mode !== "local") throw new Error("Release rehearsal supports local mode only");

  const scenario = env.BRAIN_HANDS_RELEASE_REHEARSAL_SCENARIO;
  if (!scenarios.has(scenario as ReleaseRehearsalScenario)) {
    throw new Error(`Unknown release rehearsal scenario: ${scenario ?? "missing"}`);
  }
  return scenario as ReleaseRehearsalScenario;
}

export function releaseRehearsalDependencies(
  scenario: ReleaseRehearsalScenario | null,
): LocalRuntimeDependencies | undefined {
  if (scenario !== "interrupted-resume") return undefined;
  let parked = false;
  return {
    afterCheckpoint: async (checkpoint) => {
      if (parked || checkpoint !== "after_work_item_advance_effect") return;
      parked = true;
      await new Promise<void>((resolve) => setTimeout(resolve, PARK_MS));
    },
  };
}
```

- [ ] **Step 4: Run focused unit and type tests**

```bash
npx vitest run tests/workflow/release-rehearsal-controls.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Thread the scenario through local dry-run execution**

In `src/cli.ts`, import the new functions and type. Resolve the scenario after `intake` in `executeApprovedRun`:

```ts
const rehearsalScenario = configuredReleaseRehearsalScenario({
  dryRun: options.dryRun === true,
  mode: intake.mode,
});
```

Change the local `runWorkflow` call to:

```ts
: await runWorkflow({
    runDir,
    worktreePath,
    intake,
    plan,
    codex,
    config,
    progress: options.progress,
    deferTerminalDisposition: true,
    dependencies: releaseRehearsalDependencies(rehearsalScenario),
  });
```

Do not pass the dependency to GitHub mode. Do not add a Commander option.

- [ ] **Step 6: Commit the private control**

```bash
git add src/testing/release-rehearsal.ts src/cli.ts tests/workflow/release-rehearsal-controls.test.ts
git commit -m "test: add private release rehearsal controls"
```

---

### Task 3: Build the Harness and Happy-Path Scenario

**Files:**

- Create: `tests/release/rehearsal-harness.ts`
- Replace: `tests/release/release-rehearsal.test.ts`
- Preserve unchanged: `tests/workflow/canonical-session-built-cli.test.ts`

**Interfaces:**

```ts
export type RehearsalScenario = "happy" | "verifier-fix" | "interrupted-resume";
export type ProcessResult = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};
export type RunLineage = { runId: string; sessionId: string; eventId: string };
export type TreeFingerprint = Record<string, {
  type: "file" | "symlink";
  sha256: string;
  size: number;
  mode: number;
  mtimeNs: string;
}>;
```

`RehearsalHarness` produces initialized temporary repositories, built-CLI process control, durable-run readers, read-only fingerprints, and success-only cleanup.

- [ ] **Step 1: Write the happy-path scenario against the planned harness**

Replace the skipped test with:

```ts
import { describe, expect, it } from "vitest";
import { RehearsalHarness } from "./rehearsal-harness.js";

describe("manual release rehearsal", () => {
  it("completes the canonical happy path without external commands", async () => {
    const harness = await RehearsalHarness.create("happy");
    try {
      await harness.initialize();
      await harness.driveDiscoveryToPlanApproval();
      const result = await harness.approvePlan();
      expect(result.workflow_result).toBe("local_ready");
      expect(result.assurance_outcome).toBe("verified_ready");

      await harness.expectOneRun();
      await harness.expectStableLineage();
      await harness.expectWorkItemAttempts("dry-run-item", 1);
      await harness.expectIntegratedVerification();
      await harness.expectReflectionComplete();
      await harness.expectExactlyOneCanonicalFinalEvent();
      await harness.expectStreamSeparation();
      await harness.expectNoGitHubProjection();
      await harness.expectNoExternalCommands();
      await harness.expectReadOnlyLogsAndTerminalResume();
      await harness.cleanup();
    } catch (error) {
      await harness.reportFailure();
      throw error;
    }
  });
});
```

- [ ] **Step 2: Run the focused scenario and verify it fails**

```bash
npm run release:e2e -- -t "canonical happy path"
```

Expected: FAIL because the harness does not exist.

- [ ] **Step 3: Implement repository and process setup**

In `RehearsalHarness.create`:

- Create `repo`, `home`, `xdg`, `codex-home`, `bin`, and `external-command.log` under one `mkdtemp` root.
- Initialize Git, configure a test identity, write `README.md`, and commit it.
- Write executable `gh` and `codex` shims that append `$0 $*` to the log and exit `97`.
- Build a child environment by deleting `GH_TOKEN`, `GITHUB_TOKEN`, `OPENAI_API_KEY`, `BRAIN_HANDS_CONTROLLER_MODE`, and `BRAIN_HANDS_EXECUTABLE_PATH`.
- Set `HOME`, `XDG_CONFIG_HOME`, `CODEX_HOME`, `NODE_ENV=test`, the rehearsal master switch, the scenario, and the shim-first `PATH`.
- Invoke `node dist/cli.js`; never invoke the installed CLI.

Use Execa with `reject: false` and preserve `exitCode` and `signal` separately. A signalled process is not required to have a numeric exit code.

- [ ] **Step 4: Implement the shared lifecycle driver**

The driver must execute these exact commands in order and parse every JSON response:

```text
init --repo <repo>
run <task> --repo <repo> --mode local --no-research --reflection --dry-run --json
answer-discovery --run <run> --question q-001 --dry-run --json
select-discovery-approach --run <run> --revision 1 --approach approach-explicit --dry-run --json
approve-discovery --run <run> --revision 1 --dry-run --json
```

Send `Use the recommended explicit boundary\n` to `answer-discovery`. Adopt the first status exactly once and record `runId`, `runDir`, `sessionId`, and canonical event ID. `approvePlan()` separately invokes `approve-plan <run-id> --revision 1 --repo <repo> --dry-run --json` so the interruption test can start that command without awaiting it.

- [ ] **Step 5: Implement metadata-sensitive fingerprints**

Walk the run directory with `lstat({ bigint: true })`. For regular files, hash bytes with SHA-256. For symlinks, hash the link target string. Record `type`, `size`, `mode`, and `mtimeNs`. Do not record atime.

The map keys must be relative paths so added or removed files change equality. Reject unsupported filesystem entry types rather than silently ignoring them.

- [ ] **Step 6: Implement common durable assertions**

The harness methods must verify:

- `.brain-hands/runs` contains exactly one directory.
- Manifest and session-state run IDs match the adopted run ID.
- Session ID and canonical event ID never change.
- All GitHub ID arrays and maps are empty.
- No GitHub projection/status artifacts exist.
- Every `progress.jsonl` record fails `canonicalSessionEventSchema` parsing.
- `progress.jsonl` bytes differ from `session-events.jsonl` bytes.
- `session-events.jsonl` contains exactly one schema-valid terminal event after success.
- Reflection paths recorded by the manifest exist and parse.
- `logs <run-id> --repo <repo> --json` leaves the fingerprint unchanged.
- Terminal `resume <run-id> --repo <repo> --dry-run --json` leaves the fingerprint unchanged.
- The external-command log is absent or empty.

- [ ] **Step 7: Preserve failures and clean successes**

`cleanup()` removes the harness root only after all assertions pass. `reportFailure()` must print:

```text
Release rehearsal failed
scenario=<scenario>
repo=<absolute repository>
run=<absolute run directory or unknown>
cleanup=rm -rf '<absolute harness root>'
```

Do not register an `afterEach` that deletes failed harnesses.

- [ ] **Step 8: Verify happy path and default regression coverage**

```bash
npm run release:e2e -- -t "canonical happy path"
npx vitest run tests/workflow/canonical-session-built-cli.test.ts
npm run typecheck
```

Expected: PASS. The release test is absent from default discovery, and the ordinary canonical test still runs.

- [ ] **Step 9: Commit the harness and happy path**

```bash
git add tests/release/rehearsal-harness.ts tests/release/release-rehearsal.test.ts
git commit -m "test: add built CLI release rehearsal harness"
```

---

### Task 4: Rehearse a Same-Run Verifier Correction

**Files:**

- Modify: `src/cli.ts:574-780`
- Modify: `tests/release/release-rehearsal.test.ts`
- Test: `tests/core/verifier-remediation.test.ts`

**Interfaces:**

- Consumes: `ReleaseRehearsalScenario`, `strictVerifierReviewSchema`, the dry-run Verifier artifact naming convention, and the existing review-fix-packet runtime.
- Produces: attempt-1 `request_changes`, attempt-2 `approve`, and a two-attempt completion in the original run.

- [ ] **Step 1: Add the failing scenario test**

Add a second test named `performs one same-run verifier correction` that drives the same discovery and plan approval flow, then asserts:

```ts
const first = await harness.readReview("dry-run-item", 1);
expect(first).toMatchObject({
  work_item_id: "dry-run-item",
  attempt: 1,
  final: false,
  decision: "request_changes",
  failure_class: "implementation_failure",
  blocker: null,
  blocker_code: null,
});
expect(first.findings).toHaveLength(1);

const second = await harness.readReview("dry-run-item", 2);
expect(second).toMatchObject({
  work_item_id: "dry-run-item",
  attempt: 2,
  final: false,
  decision: "approve",
  failure_class: "none",
});

await harness.expectWorkItemAttempts("dry-run-item", 2);
await harness.expectProgressOrder([
  "verifier_changes",
  "work_item_fix",
  "verifier_approved",
  "final_verification_started",
]);
```

Also run all common terminal, lineage, reflection, stream, external-command, and read-only assertions.

- [ ] **Step 2: Run it and verify the current fixture fails**

```bash
npm run release:e2e -- -t "same-run verifier correction"
```

Expected: FAIL because the current dry-run Verifier approves attempt 1.

- [ ] **Step 3: Add one strict generated finding fixture**

In `src/cli.ts`, add a helper returning this generated finding when the scenario is `verifier-fix`, the work item is `dry-run-item`, the attempt is `1`, and `final` is false:

```ts
{
  severity: "medium",
  file: "dry-run-artifact",
  line: null,
  acceptance_criterion: "The dry-run lifecycle reaches local_ready.",
  problem_class: "correctness",
  problem: "The first rehearsal attempt intentionally requires one deterministic correction.",
  required_fix: "Complete the dry-run lifecycle marker correction in the same run.",
  evidence_refs: [evidencePath],
  action_id: "R1-A1",
  order: 1,
  depends_on: [],
  remediation: {
    schema_version: 1,
    diagnosis: {
      observed_behavior: "The first deterministic review requests one correction.",
      expected_behavior: "The second attempt satisfies the local-ready criterion.",
      failure_mechanism: "The rehearsal fixture withholds approval on attempt one.",
      reproduction: ["Run the verifier-fix release rehearsal scenario."],
      evidence_refs: [evidencePath],
    },
    targets: [{ kind: "artifact", artifact_id: "dry-run-artifact", path: "dry-run-artifact" }],
    remediation: {
      strategy: "Record the deterministic dry-run correction and re-verify.",
      change_units: [{
        id: "FIX-1",
        path: "dry-run-artifact",
        target: "dry-run lifecycle marker",
        operation: "create",
        requirements: ["Satisfy the local-ready dry-run lifecycle criterion."],
        satisfies: ["SC-1"],
      }],
      allowed_files: ["dry-run-artifact"],
      forbidden_changes: [],
    },
    verification: {
      commands: [{ id: "VERIFY-01", argv: ["true"] }],
      success_conditions: [{
        id: "SC-1",
        statement: "The dry-run lifecycle reaches local_ready.",
        satisfied_by: ["VERIFY-01", "EVID-1"],
      }],
      required_evidence: [{
        id: "EVID-1",
        kind: "command_result",
        source_id: "VERIFY-01",
        output_path: evidencePath,
      }],
    },
    completion_contract: {
      required_change_unit_ids: ["FIX-1"],
      expected_changed_files: ["dry-run-artifact"],
      allow_additional_files: false,
    },
  },
}
```

Return a review with `decision: "request_changes"`, `failure_class: "implementation_failure"`, null blocker fields, that finding, and the current evidence path. All other dry-run reviews remain approvals.

- [ ] **Step 4: Thread the scenario through every lifecycle Codex creation**

Change `createDryRunLifecycleCodex` to accept a nullable scenario. Resolve the same scenario for initial discovery, discovery commands, approved execution, resume, and terminal reflection. This prevents reflection from accidentally ignoring an enabled rehearsal environment while keeping non-rehearsal dry runs unchanged.

Do not apply rehearsal behavior to `doctor`, `reflection --update-from-reflection`, or `final-audit`; those commands are outside the release scenario driver and the harness must not invoke them.

- [ ] **Step 5: Verify schema and runtime behavior**

```bash
npx vitest run tests/core/verifier-remediation.test.ts
npm run release:e2e -- -t "same-run verifier correction"
npx vitest run tests/workflow/e2e-dry-run.test.ts
npm run typecheck
```

Expected: PASS. Attempt 2 occurs in the same run, integrated verification follows it, and ordinary dry-run behavior still approves attempt 1.

- [ ] **Step 6: Commit the correction scenario**

```bash
git add src/cli.ts tests/release/release-rehearsal.test.ts
git commit -m "test: rehearse same-run verifier correction"
```

---

### Task 5: Rehearse Abrupt Process Termination and Resume

**Files:**

- Modify: `tests/release/rehearsal-harness.ts`
- Modify: `tests/release/release-rehearsal.test.ts`
- Verify: `src/testing/release-rehearsal.ts`

**Interfaces:**

- Consumes: the parking dependency from Task 2 and the manifest checkpoint after `dry-run-item` is durably complete.
- Produces: a child-process API with `start`, bounded manifest polling, `terminate`, and `wait`.
- Critical distinction: a thrown checkpoint error is not an interruption because `runLocalWorkflow` catches it. This task must terminate the live parked process externally.

- [ ] **Step 1: Add the failing interrupted-resume scenario**

Add the third and final release test:

```ts
it("resumes the same run after abrupt process termination", async () => {
  const harness = await RehearsalHarness.create("interrupted-resume");
  try {
    await harness.initialize();
    await harness.driveDiscoveryToPlanApproval();

    const child = harness.startApprovePlan();
    await harness.waitForWorkItemComplete("dry-run-item", 10_000);
    child.terminate("SIGTERM");
    const interrupted = await child.wait();
    expect(interrupted.exitCode === 0 && interrupted.signal === null).toBe(false);

    await harness.expectOneRun();
    await harness.expectStableLineage();
    await harness.expectWorkItemAttempts("dry-run-item", 1);
    await harness.expectNonterminalWithoutReflection();

    const resumed = await harness.resume();
    expect(resumed.workflow_result).toBe("local_ready");
    await harness.expectWorkItemAttempts("dry-run-item", 1);
    await harness.expectIntegratedVerification();
    await harness.expectReflectionComplete();
    await harness.expectExactlyOneCanonicalFinalEvent();
    await harness.expectReadOnlyLogsAndTerminalResume();
    await harness.expectNoExternalCommands();
    await harness.cleanup();
  } catch (error) {
    await harness.terminateActiveChild();
    await harness.reportFailure();
    throw error;
  }
});
```

- [ ] **Step 2: Run it and verify harness process control is missing**

```bash
npm run release:e2e -- -t "abrupt process termination"
```

Expected: FAIL because `startApprovePlan`, polling, and termination are not implemented.

- [ ] **Step 3: Implement a live child wrapper**

Use Execa without awaiting it immediately. Capture stdout and stderr, expose `kill(signal)`, and normalize the result to `ProcessResult`. `terminateActiveChild()` must be idempotent and must run in the test catch path so a failed assertion cannot leave the five-minute parking timer alive.

- [ ] **Step 4: Poll only authoritative durable state**

`waitForWorkItemComplete` must repeatedly parse `manifest.json` until:

```ts
manifest.work_item_progress[workItemId]?.status === "complete"
```

Use a 25-50 ms interval and an absolute deadline. On timeout, throw an error containing the last observed stage and progress object. Do not use `progress.jsonl` as the checkpoint authority and do not create a sentinel file.

- [ ] **Step 5: Assert the pre-resume crash boundary**

Before resume, assert:

- exactly one run exists;
- adopted lineage is unchanged;
- `dry-run-item` is complete with attempt 1;
- terminal and assurance fields are null;
- `session-events.jsonl` is empty;
- reflection paths are absent or incomplete;
- no second implementation report exists;
- no second run directory exists.

- [ ] **Step 6: Assert resume idempotence**

After resume, require integrated verification, reflection, `verified_ready`, and one canonical event. Fingerprint before a second terminal resume and require exact equality afterward. Re-read the implementation directory and require only attempt 1 for `dry-run-item`.

- [ ] **Step 7: Run all three scenarios together**

```bash
npm run release:e2e
npm run typecheck
```

Expected: exactly three tests pass. The interrupted scenario terminates promptly rather than waiting for `PARK_MS`.

- [ ] **Step 8: Commit interruption coverage**

```bash
git add tests/release/rehearsal-harness.ts tests/release/release-rehearsal.test.ts
git commit -m "test: rehearse abrupt same-run resume"
```

---

### Task 6: Make the Rehearsal a Fail-Closed Release Dispatcher Gate

**Files:**

- Modify: `scripts/release.sh:127-133`
- Modify: `tests/scripts/release.test.ts:14-155, 180-230`

**Interfaces:**

- Consumes: `npm run release:e2e`.
- Produces: release-dispatch ordering `test -> typecheck -> release:e2e -> build -> pack -> validate-release`.
- Preserves: version synchronization before gates, explicit build, annotated tag behavior, resumable local release commit/tag, and atomic push.

- [ ] **Step 1: Extend the fixture package and npm stub**

Add `"release:e2e": "echo release:e2e"` to the fixture scripts. Extend `StubOptions`:

```ts
type StubOptions = {
  npmTestStatus?: number;
  releaseE2eStatus?: number;
  allowPublish?: boolean;
};
```

Change the `run` case in the npm stub:

```sh
run)
  if [ "$2" = "release:e2e" ]; then
    exit "${NPM_RELEASE_E2E_STATUS:-0}"
  fi
  exit 0
  ;;
```

Add `NPM_RELEASE_E2E_STATUS` to the returned environment.

- [ ] **Step 2: Write the rehearsal-failure test first**

Create a test that records `HEAD` and `origin/main`, invokes the release with `releaseE2eStatus: 9`, and asserts:

```ts
expect(result.code).not.toBe(0);
expect(await git(fixture.root, "rev-parse", "HEAD")).toBe(beforeHead);
expect(await git(fixture.root, "rev-parse", "origin/main")).toBe(beforeRemote);
expect(await git(fixture.root, "tag", "--list", "v0.2.1")).toBe("");
expect((await readFile(stubs.npmLog, "utf8")).trim().split("\n")).toEqual([
  "test",
  "run typecheck",
  "run release:e2e",
]);
```

Also assert `git diff --name-only` contains only the four release version surfaces. This documents the safe rerun state rather than incorrectly claiming a pristine worktree.

- [ ] **Step 3: Run the release tests and verify the new test fails**

```bash
npx vitest run tests/scripts/release.test.ts
```

Expected: FAIL because `release.sh` does not call `release:e2e`.

- [ ] **Step 4: Insert the gate without deleting existing gates**

Change only `run_release_gates`:

```bash
run_release_gates() {
  npm test
  npm run typecheck
  npm run release:e2e
  npm run build
  npm pack --dry-run --json
  npm run validate-release -- --json
}
```

Do not remove `npm run build`. Adding a rehearsal does not authorize refactoring the established release contract.

- [ ] **Step 5: Add complete order and resumability assertions**

On a successful fixture release, assert the npm log is exactly:

```ts
[
  "test",
  "run typecheck",
  "run release:e2e",
  "run build",
  "pack --dry-run --json",
  "run validate-release -- --json",
]
```

In the atomic-push recovery test, clear or snapshot the npm log before rerun and prove `run release:e2e` occurs again before the second push attempt.

- [ ] **Step 6: Re-run release tests**

```bash
npx vitest run tests/scripts/release.test.ts
```

Expected: PASS, including gate failure before commit/tag/push and gate replay during recovery.

- [ ] **Step 7: Commit the dispatcher gate**

```bash
git add scripts/release.sh tests/scripts/release.test.ts
git commit -m "build: require pre-tag release rehearsal"
```

---

### Task 7: Lock the Manual-Only Boundary and Document the Contract

**Files:**

- Modify: `tests/scripts/ci-workflow.test.ts`
- Modify: `tests/scripts/publish-workflow.test.ts`
- Modify: `docs/RELEASING.md:57-115, 145-170`

**Interfaces:**

- Produces: explicit negative CI guarantees and maintainer-facing recovery instructions.
- Preserves: GitHub Actions tag validation and Trusted Publishing unchanged.

- [ ] **Step 1: Add negative workflow assertions**

In both workflow tests, retain access to the workflow source or combined run commands and add:

```ts
expect(runs).not.toContain("npm run release:e2e");
```

The CI test proves pull requests and main pushes remain on ordinary gates. The publish-workflow test proves tag validation and publication do not run the manual rehearsal.

- [ ] **Step 2: Run workflow tests**

```bash
npx vitest run tests/scripts/ci-workflow.test.ts tests/scripts/publish-workflow.test.ts
```

Expected: PASS with current workflows unchanged.

- [ ] **Step 3: Update the release gate list**

Document this exact dispatcher order:

```bash
npm test
npm run typecheck
npm run release:e2e
npm run build
npm pack --dry-run --json
npm run validate-release -- --json
```

- [ ] **Step 4: Document scope and diagnostics precisely**

State that `release:e2e`:

- is mandatory for `scripts/release.sh` dispatches, not an enforcement mechanism for arbitrary manual tags;
- builds the checkout CLI and runs exactly three local dry-run scenarios;
- requires no live model, GitHub mutation, or credentials;
- checks canonical ledger/session artifacts separately from progress telemetry;
- externally terminates the parked interruption process and resumes the same run;
- removes successful harness repositories;
- preserves failed repositories and prints `scenario`, `repo`, `run`, and cleanup paths;
- blocks release commit, tag, and push on failure;
- may leave synchronized version files modified so the same version can be rerun safely.

In Recovery, instruct the maintainer to inspect the preserved run, fix the defect, and rerun the same `scripts/release.sh MAJOR.MINOR.PATCH`. Do not instruct them to move a tag or bypass the gate.

- [ ] **Step 5: Verify documentation and workflow boundaries**

```bash
npx vitest run tests/scripts/ci-workflow.test.ts tests/scripts/publish-workflow.test.ts tests/scripts/release.test.ts
git diff --check
```

Expected: PASS.

- [ ] **Step 6: Commit documentation and boundary tests**

```bash
git add docs/RELEASING.md tests/scripts/ci-workflow.test.ts tests/scripts/publish-workflow.test.ts
git commit -m "docs: define manual release rehearsal contract"
```

---

### Task 8: Run Full Verification Without Creating a Release

**Files:**

- Verify only; do not modify version surfaces or release state.

**Interfaces:**

- Consumes: all prior tasks.
- Produces: evidence that ordinary tests, manual rehearsal, package validation, and release-dispatch tests agree.

- [ ] **Step 1: Verify test discovery one final time**

```bash
npx vitest list --config vitest.config.ts
npx vitest list --config vitest.release.config.ts
```

Expected:

- Default list includes the canonical built-CLI test and excludes `tests/release`.
- Release list contains exactly three tests in one release test file.

- [ ] **Step 2: Run focused regression tests**

```bash
npx vitest run tests/workflow/release-rehearsal-controls.test.ts
npx vitest run tests/workflow/canonical-session-built-cli.test.ts
npx vitest run tests/workflow/e2e-dry-run.test.ts
npx vitest run tests/core/verifier-remediation.test.ts
npx vitest run tests/scripts/release.test.ts
npx vitest run tests/scripts/ci-workflow.test.ts tests/scripts/publish-workflow.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run the manual rehearsal**

```bash
npm run release:e2e
```

Expected: exactly three scenarios pass; no failed repository path is printed; no `gh` or `codex` trap invocation is recorded.

- [ ] **Step 4: Run repository and package gates**

```bash
npm test
npm run typecheck
npm run build
npm run validate-release -- --json
npm pack --dry-run --json
git diff --check
```

Expected: PASS. Package allowlist is unchanged and contains only the established runtime files.

- [ ] **Step 5: Inspect Git state for forbidden release effects**

```bash
git status --short
git log --oneline -8
git tag --points-at HEAD
```

Expected: only intentional implementation commits and no new release tag. Do not invoke `scripts/release.sh` as part of implementation verification.

- [ ] **Step 6: Review completion criteria**

Implementation is complete only when all statements are true:

- `npm run release:e2e` runs exactly the happy, verifier-fix, and interrupted-resume scenarios.
- Ordinary `npm test`, CI, tag validation, and `prepack` do not invoke the manual lane.
- The canonical built-CLI lifecycle remains in default coverage.
- Every scenario creates exactly one run with stable run/session/event lineage.
- The correction scenario performs two focused attempts and one later integrated verification in the same run.
- The interruption scenario is terminated externally after durable work-item completion, resumes the same run, and never reimplements attempt 1.
- Terminal delivery produces exactly one canonical session event and completed reflection.
- `logs --json` and terminal `resume` leave content and metadata fingerprints unchanged.
- Progress telemetry remains schema-distinct from canonical session events.
- `gh` and `codex` traps record no invocation.
- A rehearsal failure leaves `HEAD`, tag refs, and `origin/main` unchanged.
- A resumed release dispatch reruns the rehearsal before retrying its atomic push.
- No release version, tag, push, or publication was created while implementing this plan.
