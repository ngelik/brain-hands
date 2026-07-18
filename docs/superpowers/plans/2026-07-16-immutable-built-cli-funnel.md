# Immutable Built-CLI Funnel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Use `superpowers:subagent-driven-development` only when the operator explicitly authorizes subagents.

**Goal:** Build `dist/` exactly once, prove the built CLI and integrated suite against those exact bytes, and fail immediately if any test or lifecycle command cleans, rebuilds, or directly mutates the frozen artifact.

**Architecture:** A repository coordinator owns stage order and fail-fast behavior. A shared artifact module supplies deterministic `dist/` hashing and the immutable-environment contract. The existing clean lifecycle becomes an explicit guarded Node script, while package, CI, and release entrypoints converge on one canonical funnel.

**Tech Stack:** Node.js ESM scripts, npm lifecycle scripts, TypeScript 6, Vitest 4, GitHub Actions.

## Global Constraints

- Work on `main`; preserve unrelated working-tree changes.
- Build once per funnel invocation, before any built-CLI or integrated test.
- Treat `dist/` as immutable after the digest is frozen.
- Do not enable Vitest file parallelism.
- Do not put repository build mechanics into `ExecutionSpecV2`.
- Keep built-CLI tests responsible for testing an existing build; they must never invoke build or clean.
- Keep normal `prepack` as a defensive standalone packaging lifecycle.
- Use `npm pack --dry-run --json --ignore-scripts` when inspecting the already-frozen candidate.
- Stop on the first failed stage and report that stage's command and exit code.
- Reject symlinks in `dist/`; do not follow them while hashing.
- Do not add new third-party dependencies.

---

## File Responsibility Map

- `scripts/dist-artifact.mjs`: immutable environment name, safe tree walk, and deterministic digest.
- `scripts/clean.mjs`: the only package-owned `dist/` deletion entrypoint and its freeze guard.
- `scripts/verify-repository.mjs`: ordered one-build verification coordinator.
- `package.json`: stable public script names used locally, in CI, and in release checks.
- `.github/workflows/ci.yml`: run the canonical funnel once and inspect its frozen package contents.
- `scripts/release.sh`: reuse the canonical funnel without a second build.
- `tests/scripts/*.test.ts`: unit tests for scripts using temporary directories and injected command runners.
- `tests/workflow/*built-cli*.test.ts`: real tests of the prebuilt CLI only.
- `AGENTS.md` and `README.md`: operator instructions for development and release proof.

## Task 1: Add deterministic artifact hashing and guarded cleaning

**Files:**
- Create: `scripts/dist-artifact.mjs`
- Create: `scripts/clean.mjs`
- Create: `tests/scripts/dist-artifact.test.ts`
- Create: `tests/scripts/clean.test.ts`
- Modify: `package.json`

**Interfaces:**

```js
export const IMMUTABLE_DIST_ENV = "BRAIN_HANDS_DIST_IMMUTABLE";
export function assertDistMutable(env = process.env) {}
export async function hashDirectory(root) {}
```

The digest contract is SHA-256 over a version marker followed by sorted entries. Each entry contributes its normalized relative path, entry kind, byte length, and exact file bytes. Directories are represented even when empty. Symlinks and unsupported entry kinds throw.

- [ ] **Step 1: Write failing digest tests**

Create temporary trees in `tests/scripts/dist-artifact.test.ts` and prove:

```ts
it("returns the same digest regardless of creation order", async () => {});
it("changes when file bytes change", async () => {});
it("changes when a path is renamed", async () => {});
it("includes empty directories", async () => {});
it("rejects symlinks", async () => {});
it("rejects a missing artifact root", async () => {});
```

Use `mkdtemp`, `writeFile`, `mkdir`, and `symlink` under the test's temporary directory. Skip only the symlink case when the platform explicitly denies symlink creation; do not weaken production behavior.

- [ ] **Step 2: Write failing clean-guard tests**

Export a testable `cleanDist({ cwd, env })` function from `scripts/clean.mjs`, and guard direct execution with the existing ESM main-module pattern used by repository scripts.

Test:

```ts
it("removes dist when it is mutable", async () => {});
it("is idempotent when dist is absent", async () => {});
it("refuses to remove dist when the immutable flag is 1", async () => {});
```

The refusal message must contain `BRAIN_HANDS_DIST_IMMUTABLE=1` and the absolute `dist/` path.

- [ ] **Step 3: Run the script tests and verify RED**

Run:

```bash
npx vitest run tests/scripts/dist-artifact.test.ts tests/scripts/clean.test.ts
```

Expected: FAIL because the two script modules do not exist.

- [ ] **Step 4: Implement the artifact module**

Use `lstat` so symlinks are detected before reading. Normalize separators to `/`, sort with byte-stable string ordering, and frame every field with an explicit byte length to avoid concatenation ambiguity.

The algorithm must be equivalent to:

```js
hash.update("brain-hands-dist-v1\0");
for (const entry of sortedEntries) {
  updateFramed(hash, entry.relativePath);
  updateFramed(hash, entry.kind);
  updateFramed(hash, String(entry.bytes.length));
  hash.update(entry.bytes);
}
return hash.digest("hex");
```

Do not include absolute paths, mtimes, permissions, inode numbers, or platform path separators.

- [ ] **Step 5: Implement guarded cleaning**

`assertDistMutable` throws only when the environment value is exactly `"1"`. `cleanDist` calls the assertion before `rm(distPath, { recursive: true, force: true })`.

Replace the inline package script with:

```json
"clean": "node scripts/clean.mjs"
```

Because `npm run build` already depends on `npm run clean`, this single guard blocks both cleaning and rebuilding while the artifact is frozen.

- [ ] **Step 6: Run focused tests and typecheck**

Run:

```bash
npx vitest run tests/scripts/dist-artifact.test.ts tests/scripts/clean.test.ts
npm run typecheck
```

Expected: PASS. Confirm `npm run clean` still removes a disposable locally built `dist/` when the immutable environment is absent.

## Task 2: Implement the fail-fast repository coordinator

**Files:**
- Create: `scripts/verify-repository.mjs`
- Create: `tests/scripts/verify-repository.test.ts`

**Interfaces:**

```js
export const VERIFICATION_STAGES = [/* ordered immutable descriptors */];
export async function verifyRepository(options = {}) {}
```

`options` accepts injected `runCommand`, `hashDist`, `cwd`, and `env` for tests. The executable path uses defaults based on `spawn` with `shell: false` and inherited stdio.

- [ ] **Step 1: Write failing stage-order tests**

Assert the exact successful sequence:

```text
static contract tests
cross-cutting tests
typecheck
build
release metadata validation
freeze dist digest
built-CLI tests
compare dist digest
integrated full suite
compare dist digest
```

The injected runner should record argv arrays, and the injected digest provider should return a known sequence. Never assert a shell command string.

- [ ] **Step 2: Write failing failure-boundary tests**

Parameterize each command stage as the failing stage and prove no later runner or digest operation occurs. Add separate cases for:

- missing `dist/` at the freeze boundary;
- digest mismatch after built-CLI tests;
- digest mismatch after the integrated suite;
- child environment not containing `BRAIN_HANDS_DIST_IMMUTABLE=1` before the freeze;
- child environment containing the flag for both post-freeze test stages.

The mismatch error must show the stage, original digest, and observed digest.

- [ ] **Step 3: Run the coordinator tests and verify RED**

Run:

```bash
npx vitest run tests/scripts/verify-repository.test.ts
```

Expected: FAIL because the coordinator does not exist.

- [ ] **Step 4: Implement a small injected command runner**

Use an argv-only runner:

```js
await runCommand({
  label: "typecheck",
  argv: [npmCommand, "run", "typecheck"],
  cwd,
  env,
});
```

Resolve `npmCommand` to `npm.cmd` on Windows and `npm` otherwise. Reject non-zero exit codes with a `RepositoryVerificationError` containing `stage`, `argv`, and `exitCode`. Do not catch and continue.

- [ ] **Step 5: Encode the exact command groups**

Use stable package entrypoints created in Task 3, but keep the sequence explicit in this module:

```text
npm run test:static-contract
npm run test:cross-cutting
npm run typecheck
npm run build
npm run validate-release
hash dist
npm run test:built-cli
hash dist and compare
npm run test:all:no-build
hash dist and compare
```

Set the immutable environment only after the initial digest succeeds. Freeze a copied environment object rather than mutating `process.env`.

- [ ] **Step 6: Run focused tests**

Run:

```bash
npx vitest run tests/scripts/verify-repository.test.ts tests/scripts/dist-artifact.test.ts tests/scripts/clean.test.ts
```

Expected: PASS, including every fail-fast boundary.

## Task 3: Split package scripts into non-overlapping layers

**Files:**
- Modify: `package.json`
- Create: `tests/scripts/package-scripts.test.ts`
- Modify: `tests/workflow/e2e-dry-run.test.ts`
- Modify: `tests/workflow/canonical-session-built-cli.test.ts`

**Required script contract:**

```json
{
  "test": "npm run verify:funnel",
  "test:static-contract": "vitest run tests/core/schema.test.ts tests/core/execution-spec.test.ts tests/core/testing-funnel.test.ts tests/prompts/renderer.test.ts tests/workflow/replan.test.ts",
  "test:cross-cutting": "vitest run tests/workflow/runtime-local.test.ts tests/workflow/runtime-github.test.ts tests/workflow/preflight.test.ts tests/workflow/status.test.ts tests/core/ledger.test.ts tests/core/discovery-ledger.test.ts tests/core/run-configuration.test.ts tests/core/controller-provenance.test.ts tests/verification/runner.test.ts",
  "test:built-cli": "vitest run tests/workflow/e2e-dry-run.test.ts tests/workflow/canonical-session-built-cli.test.ts",
  "test:all:no-build": "vitest run",
  "verify:funnel": "node scripts/verify-repository.mjs"
}
```

- [ ] **Step 1: Add failing package-script contract tests**

In `tests/scripts/package-scripts.test.ts`, load `package.json` and assert:

- `test` delegates only to `verify:funnel`;
- `verify:funnel` invokes the coordinator;
- `test:all:no-build` contains no `build`, `clean`, `pretest`, or `posttest` lifecycle;
- `test:built-cli` names only the two existing built-CLI test files;
- `clean` invokes the guarded script;
- no `pretest` or `posttest` script can mutate `dist/`.

- [ ] **Step 2: Prove built-CLI tests require, but never create, `dist/`**

Preserve the current positive behavior and add source-level/lifecycle assertions where missing:

- the tests fail with an actionable message when `dist/cli.js` is absent;
- the tests invoke `node dist/cli.js` directly;
- neither file spawns npm, `tsc`, clean, build, or the coordinator;
- test cleanup affects only temporary run directories.

- [ ] **Step 3: Run package and built-CLI contract tests and verify RED**

Run:

```bash
npx vitest run tests/scripts/package-scripts.test.ts tests/workflow/e2e-dry-run.test.ts tests/workflow/canonical-session-built-cli.test.ts
```

Expected: package-script assertions FAIL until the new scripts exist. Built-CLI tests may require a preceding local build during this transitional red step; do not add one inside the tests.

- [ ] **Step 4: Define explicit static and cross-cutting test lists**

Start from contract and execution surfaces for the static layer:

```text
tests/core/schema.test.ts
tests/core/execution-spec.test.ts
tests/core/testing-funnel.test.ts
tests/prompts/renderer.test.ts
tests/workflow/replan.test.ts
```

Use a conservative repository-owned cross-cutting set covering runtime, CLI lifecycle, ledger, and artifact paths:

```text
tests/workflow/runtime-local.test.ts
tests/workflow/runtime-github.test.ts
tests/workflow/preflight.test.ts
tests/workflow/status.test.ts
tests/core/ledger.test.ts
tests/core/discovery-ledger.test.ts
tests/core/run-configuration.test.ts
tests/core/controller-provenance.test.ts
tests/verification/runner.test.ts
```

Before editing `package.json`, verify each path exists with `rg --files tests`. If an exact filename differs, use the existing equivalent and update the script contract test in the same commit. Do not silently omit a category.

- [ ] **Step 5: Update the package scripts**

Keep `build`, `typecheck`, `validate-release`, `prepack`, and publication commands otherwise unchanged. Ensure none of the three test-layer scripts has an npm lifecycle hook that builds implicitly.

- [ ] **Step 6: Run the layer scripts separately**

Run:

```bash
npm run test:static-contract
npm run test:cross-cutting
npm run build
BRAIN_HANDS_DIST_IMMUTABLE=1 npm run test:built-cli
BRAIN_HANDS_DIST_IMMUTABLE=1 npm run test:all:no-build
```

Expected: every command PASS. The final two commands leave `dist/` byte-identical; Task 2's coordinator tests provide the automated digest assertion.

## Task 4: Converge CI and release checks on the canonical funnel

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/publish-npm.yml`
- Modify: `scripts/release.sh`
- Modify: `tests/scripts/ci-workflow.test.ts`
- Modify: `tests/scripts/release.test.ts`
- Modify: `tests/scripts/publish-workflow.test.ts`

- [ ] **Step 1: Write failing CI workflow assertions**

Assert the verification job:

- invokes `npm run verify:funnel` exactly once;
- does not separately invoke `npm test`, `npm run build`, or `npm run typecheck`;
- performs package inspection only after the funnel;
- uses `npm pack --dry-run --json --ignore-scripts` for that inspection;
- retains the existing generated-diff cleanliness check after verification.

- [ ] **Step 2: Write failing release-script assertions**

Assert `scripts/release.sh`:

- invokes `npm run verify:funnel` once;
- does not run a second build or typecheck before packaging;
- uses lifecycle-suppressed dry-run inspection for the frozen candidate;
- leaves the actual publish step's existing defensive lifecycle intact.

Update `tests/scripts/publish-workflow.test.ts` only where it asserts the verification command surface. Do not broaden this task into release-policy changes.

- [ ] **Step 3: Run release tests and verify RED**

Run:

```bash
npx vitest run tests/scripts/ci-workflow.test.ts tests/scripts/release.test.ts tests/scripts/publish-workflow.test.ts tests/scripts/package-scripts.test.ts
```

Expected: FAIL on the old duplicate build/test sequence.

- [ ] **Step 4: Update CI**

Replace overlapping test/typecheck/build/validate steps with one named `Layered verification funnel` step. Keep dependency installation, supported Node versions, package inspection, and Git cleanliness semantics unchanged.

Apply the same convergence to the validation job in `.github/workflows/publish-npm.yml`: it runs `npm run verify:funnel` once, then preserves its immutable-tag checks and publication handoff. The publish job remains unchanged.

- [ ] **Step 5: Update release verification**

Replace the prepublication verification block with `npm run verify:funnel`. Run the dry-run package inspection with `--ignore-scripts` so it inspects the tested build. Do not remove `prepack`; document that a real standalone pack/publish may rebuild at the publication boundary.

- [ ] **Step 6: Run release-focused tests**

Run:

```bash
npx vitest run tests/scripts/ci-workflow.test.ts tests/scripts/release.test.ts tests/scripts/publish-workflow.test.ts tests/scripts/package-scripts.test.ts
```

Expected: PASS with no duplicate verification build in CI or the release verification phase.

## Task 5: Document and prove the complete immutable funnel

**Files:**
- Modify: `AGENTS.md`
- Modify: `README.md`
- Test: all files above

- [ ] **Step 1: Update operator guidance**

Document these two distinct workflows:

```text
Development iteration:
  npm run dev -- ...
  or npm run build && node dist/cli.js ...

Release candidate proof:
  npm run verify:funnel
  npm pack --dry-run --json --ignore-scripts
```

State that post-build tests inherit `BRAIN_HANDS_DIST_IMMUTABLE=1`, `dist/` is digest-checked, and test workers must not invoke clean, build, or `npm test`.

- [ ] **Step 2: Run the focused implementation tests**

Run:

```bash
npx vitest run tests/scripts/dist-artifact.test.ts tests/scripts/clean.test.ts tests/scripts/verify-repository.test.ts tests/scripts/package-scripts.test.ts tests/scripts/ci-workflow.test.ts tests/scripts/release.test.ts tests/scripts/publish-workflow.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run the real funnel from a mutable starting state**

Run:

```bash
npm run verify:funnel
```

Expected: PASS. Logs show exactly one build, then built-CLI proof, then the integrated suite. No post-freeze command invokes clean or build.

- [ ] **Step 4: Inspect the tested package without lifecycle mutation**

Run:

```bash
npm pack --dry-run --json --ignore-scripts
```

Expected: PASS and runtime contents remain restricted to `dist/`, `prompts/`, `agentic-codex-workflow.md`, `README.md`, and package metadata.

- [ ] **Step 5: Verify repository hygiene**

Run:

```bash
git diff --check
git status --short
```

Expected: no whitespace errors; only intended implementation and documentation files are changed.

## Final Acceptance Checklist

- [ ] A successful funnel performs exactly one build before tests of `dist/`.
- [ ] Static and cross-cutting failures stop before build.
- [ ] Build and release-metadata failures stop before freezing `dist/`.
- [ ] Built-CLI failure stops before the integrated full suite.
- [ ] `npm run clean`, `npm run build`, and `npm test` cannot run under the immutable flag without failing safely.
- [ ] Direct post-freeze mutations are detected by digest comparison.
- [ ] Built-CLI tests never build or clean.
- [ ] CI and release verification use the same coordinator.
- [ ] Package inspection does not run lifecycle scripts against the frozen candidate.
- [ ] The integrated suite remains confirmation after narrower discovery layers.

## Self-Review Before Implementation

- Confirm the static and cross-cutting file lists against the actual checkout before editing scripts.
- Confirm the existing build command reaches `clean`; otherwise guard every mutation entrypoint explicitly.
- Confirm the ESM main-module guard works on supported Node versions.
- Confirm all spawned processes use argv arrays and `shell: false`.
- Confirm no test expectation relies on platform-specific absolute paths or executable names.
- Confirm standalone `npm pack` and publish behavior remain intentionally unchanged.
