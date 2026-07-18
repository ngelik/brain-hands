# npm Trusted Publishing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move `@ngelik/brain-hands` npm publication from a local authenticated shell to a tag-triggered GitHub Actions OIDC publisher without losing version synchronization, fail-closed release gates, resumability, or exact package verification.

**Architecture:** The local `scripts/release.sh` becomes a bounded prepare-and-dispatch command: it validates repository state, synchronizes the four version surfaces, runs release gates, creates one release commit plus annotated tag, and atomically pushes both. `.github/workflows/publish-npm.yml` validates the immutable tagged commit, then an `npm-publish` GitHub environment grants the publish job OIDC access; a small Node helper packs one artifact, publishes that exact tarball, and verifies its registry integrity. GitHub Actions is authoritative after the tag push, while the local command remains safely resumable before dispatch.

**Tech Stack:** Bash, Node.js 24, npm 11.5.1+, TypeScript/Vitest, GitHub Actions, npm Trusted Publishing/OIDC, GitHub deployment environments.

## Global Constraints

- Package identity remains exactly `@ngelik/brain-hands` with repository `github.com/ngelik/brain-hands`.
- Stable versions remain canonical `MAJOR.MINOR.PATCH`; prereleases, build metadata, leading zeroes, and `v`-prefixed command arguments remain unsupported.
- Runtime support remains Node.js `>=20`; only the release runner is pinned to Node.js 24.
- Trusted publishing requires npm CLI 11.5.1+ and Node.js 22.14.0+; the workflow must fail before packing if either floor is unmet.
- The publisher must run on a GitHub-hosted runner with `contents: read` and job-scoped `id-token: write`.
- The npm trusted publisher must name `ngelik`, `brain-hands`, `publish-npm.yml`, environment `npm-publish`, and allow only `npm publish`.
- No `NPM_TOKEN`, write token, OTP, `NODE_AUTH_TOKEN`, or npm login step may exist in the workflow.
- Release Actions are pinned to immutable commits: `actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd` (v6.0.2) and `actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e` (v6.4.0).
- Release dependency caching stays disabled with `package-manager-cache: false`.
- The four synchronized release surfaces remain `package.json`, `package-lock.json`, `.codex-plugin/plugin.json`, and `.agents/skills/brain-hands/SKILL.md`.
- Required gates remain `npm test`, `npm run typecheck`, `npm run build`, `npm pack --dry-run --json`, and `npm run validate-release -- --json`.
- The local push must use one atomic ref update for `main` and the annotated version tag; never push the tag after a failed branch push.
- Published versions and release tags are immutable. Never move, delete, or recreate a pushed release tag to repair a failed workflow.
- Preserve unrelated worktree changes and perform release work on `main`.
- The GitHub repository is private. Trusted Publishing remains supported, but npm provenance is unavailable unless the source repository becomes public; repository visibility is outside this implementation's authority.

---

## Current-state findings and corrections to the proposal

1. `package.json` is already `0.3.2`, `main` and `origin/main` point to release commit `973fe6408bce08c5279af340e530963990ffc626`, and local/remote `v0.3.2` are matching annotated tags.
2. The one-time bootstrap was completed on 2026-07-13. npm reports `@ngelik/brain-hands@0.3.2` with `gitHead` `973fe6408bce08c5279af340e530963990ffc626` and the integrity produced by the prepared tarball. Do not republish or retag `0.3.2`.
3. Legacy `.git/release-state/v0.3.2.json` still predates the registry acceptance and is not authoritative evidence for the new workflow. It must not be edited to manufacture completion evidence.
4. The former `scripts/release.sh` was 1,919 lines and owned npm authentication/publication plus catalog discovery in addition to Git preparation. The replacement preserves the required local state machine while moving publication authority to GitHub Actions.
5. A bare `v*` trigger is acceptable only as a coarse event filter. The workflow must reject any tag that is not exactly `vMAJOR.MINOR.PATCH`, does not equal `package.json.version`, is not annotated, or does not point at the exact `origin/main` commit.
6. A workflow-tag reference is mutable, so release actions should be pinned to full commits. OIDC removes the npm secret; it does not remove action supply-chain risk.
7. Configure token blocking only after the first OIDC canary succeeds. npm explicitly recommends verifying Trusted Publishing before selecting “Require two-factor authentication and disallow tokens” and revoking legacy automation credentials.

## File map

- Create `.github/workflows/publish-npm.yml`: dry-runnable validation plus environment-gated OIDC publication from stable tags.
- Create `scripts/release-version.mjs`: pure version parsing/synchronization used by the local release command and direct tests.
- Create `scripts/check-release-toolchain.mjs`: pure Node/npm release-floor validation used before any release build.
- Create `scripts/publish-release.mjs`: CI-only pack, idempotent publication, and registry-integrity verification.
- Rewrite `scripts/release.sh`: local preflight, validation, release commit/tag creation, atomic dispatch, and deterministic resume only.
- Modify `scripts/validate-release.mjs`: add exact tag/repository publish-context validation while retaining the existing release-contract validator.
- Replace `tests/scripts/release.test.ts`: cover the smaller local state machine and prove that it cannot publish to npm.
- Modify `tests/scripts/release-validation.test.ts`: cover tag/repository context validation.
- Create `tests/scripts/check-release-toolchain.test.ts`: cover exact minimum, below-minimum, newer-major, and malformed tool versions.
- Create `tests/scripts/publish-release.test.ts`: cover absent, matching, conflicting, delayed, and already-published registry states.
- Create `tests/scripts/publish-workflow.test.ts`: parse the workflow and enforce permissions, action pins, runner, environment, triggers, commands, and absence of npm secrets.
- Modify `docs/RELEASING.md`: document the split local/CI lifecycle, bootstrap, recovery, environment approval, and post-release proof.
- Modify `README.md`: replace the “sole manual stable-release command” wording with the local dispatch plus GitHub completion model.
- Do not modify the package runtime allowlist, runtime dependencies, CLI behavior, or unrelated workflow code.

### Task 0: Complete the one-time `0.3.2` bootstrap with the existing release implementation

**Files:**
- Read: `.git/release-state/v0.3.2.json`
- No source changes

**Interfaces:**
- Consumes: the existing authoritative release evidence, release commit `973fe6408bce08c5279af340e530963990ffc626`, and annotated `v0.3.2` tag.
- Produces: public `@ngelik/brain-hands@0.3.2`; this makes npm Trusted Publisher configuration possible.

- [ ] **Step 1: Reconfirm the prepared immutable state before the irreversible publish**

Run:

```bash
git status --short --branch
git show v0.3.2 --no-patch --pretty=fuller
git ls-remote --tags origin refs/tags/v0.3.2 'refs/tags/v0.3.2^{}'
npm view @ngelik/brain-hands@0.3.2 version --json
```

Expected: clean `main`, local and remote tag dereference to `973fe6408bce08c5279af340e530963990ffc626`, and npm returns `E404`. Any different commit/tag or a published registry result is a stop-and-investigate condition.

- [ ] **Step 2: Resume through the existing guarded command**

Run only with explicit approval for the irreversible publication:

```bash
scripts/release.sh 0.3.2
```

Expected: the script reuses its prepared Git state, does not create or move Git state, and publishes `0.3.2` once. Registry metadata, tag commit, and tarball integrity are verified independently afterward.

- [ ] **Step 3: Verify bootstrap publication**

Run:

```bash
npm view @ngelik/brain-hands@0.3.2 name version repository.url dist.integrity --json
npm install -g @ngelik/brain-hands@0.3.2
brain-hands --version
```

Expected: npm reports the exact package, version `0.3.2`, expected GitHub repository, and a nonempty SHA-512 integrity; the installed command verification is performed only after installing the stable package normally, never with `npm link`.

### Task 1: Extract and test release-version synchronization

**Files:**
- Create: `scripts/release-version.mjs`
- Modify: `tests/scripts/release-validation.test.ts`

**Interfaces:**
- Produces: `parseCanonicalVersion(value): { version: string; tag: string }`, `readReleaseVersions(root): ReleaseVersions`, `synchronizeReleaseVersion(root, version): void`, and a CLI `node scripts/release-version.mjs sync MAJOR.MINOR.PATCH`.
- Consumes: the four existing version surfaces and `version-compatibility.mjs` for skill-range parsing.

- [ ] **Step 1: Add failing direct tests for canonical parsing and four-file synchronization**

Add tests that create the existing isolated release fixture, invoke the module CLI, and assert:

```ts
expect(parseCanonicalVersion("0.3.3")).toEqual({ version: "0.3.3", tag: "v0.3.3" });
expect(() => parseCanonicalVersion("v0.3.3")).toThrow("canonical stable semantic version");
expect(() => parseCanonicalVersion("0.03.3")).toThrow("canonical stable semantic version");
expect(readFixtureVersions(root)).toEqual({
  packageVersion: "0.3.3",
  lockfileVersion: "0.3.3",
  lockfilePackageVersion: "0.3.3",
  pluginVersion: "0.3.3",
  requiredRange: "^0.3.3",
});
```

Run: `npx vitest run tests/scripts/release-validation.test.ts`

Expected: FAIL because `scripts/release-version.mjs` does not exist.

- [ ] **Step 2: Implement the small synchronization module**

Use JSON parse/stringify with the repository’s existing two-space indentation and final newline. Replace only the `requires.codex_flow` scalar in `SKILL.md`; require exactly one match and fail without writing if any input file is malformed. Stage writes in memory first so validation failure leaves all four files unchanged.

The CLI contract is exactly:

```text
Usage: node scripts/release-version.mjs sync MAJOR.MINOR.PATCH [--root PATH]
```

Run: `npx vitest run tests/scripts/release-validation.test.ts`

Expected: PASS, including malformed JSON, missing `packages[""]`, missing/duplicate skill range, and no-partial-write cases.

- [ ] **Step 3: Commit the extraction**

```bash
git add scripts/release-version.mjs tests/scripts/release-validation.test.ts
git commit -m "refactor: extract release version synchronization"
```

### Task 2: Add toolchain and publish-context validation

**Files:**
- Create: `scripts/check-release-toolchain.mjs`
- Modify: `scripts/validate-release.mjs`
- Create: `tests/scripts/check-release-toolchain.test.ts`
- Modify: `tests/scripts/release-validation.test.ts`

**Interfaces:**
- Produces: `validateReleaseToolchain({ nodeVersion, npmVersion }): { nodeVersion: string; npmVersion: string }` plus CLI `node scripts/check-release-toolchain.mjs`.
- Produces: `validatePublishContext({ tag, repository }, root): ReleaseValidationResult`.
- Consumes: `validateRelease(root)` and its exact package/repository/version checks.

- [ ] **Step 1: Add failing toolchain tests**

```ts
expect(validateReleaseToolchain({
  nodeVersion: "22.14.0",
  npmVersion: "11.5.1",
})).toEqual({ nodeVersion: "22.14.0", npmVersion: "11.5.1" });

expect(() => validateReleaseToolchain({
  nodeVersion: "22.13.9",
  npmVersion: "11.5.1",
})).toThrow("Node.js 22.14.0 or newer");

expect(() => validateReleaseToolchain({
  nodeVersion: "24.0.0",
  npmVersion: "11.5.0",
})).toThrow("npm 11.5.1 or newer");
```

The CLI reads `process.versions.node`, runs `npm --version`, validates both canonical numeric triples, prints both accepted versions, and exits nonzero before any install/build command when a floor is unmet.

Run: `npx vitest run tests/scripts/check-release-toolchain.test.ts`

Expected: FAIL because the helper does not exist.

- [ ] **Step 2: Implement and verify the toolchain helper**

Run: `npx vitest run tests/scripts/check-release-toolchain.test.ts`

Expected: PASS for exact floors, newer major/minor versions, below-floor versions, malformed output, and failed `npm --version` execution.

- [ ] **Step 3: Add failing context tests**

Cover the exact success and failures:

```ts
expect(validatePublishContext(
  { tag: "v0.3.3", repository: "ngelik/brain-hands" },
  fixtureRoot,
).packageVersion).toBe("0.3.3");

expect(() => validatePublishContext(
  { tag: "release-0.3.3", repository: "ngelik/brain-hands" },
  fixtureRoot,
)).toThrow("tag must be exactly v0.3.3");

expect(() => validatePublishContext(
  { tag: "v0.3.4", repository: "ngelik/brain-hands" },
  fixtureRoot,
)).toThrow("tag v0.3.4 does not match package version 0.3.3");

expect(() => validatePublishContext(
  { tag: "v0.3.3", repository: "attacker/brain-hands" },
  fixtureRoot,
)).toThrow("GitHub repository must be exactly ngelik/brain-hands");
```

Run: `npx vitest run tests/scripts/release-validation.test.ts`

Expected: FAIL because `validatePublishContext` is not exported.

- [ ] **Step 4: Implement context validation and CLI flags**

Add optional `--tag` and `--repository` arguments. Require both together. Keep `npm run validate-release -- --json` unchanged for local callers; CI runs:

```bash
npm run validate-release -- \
  --json \
  --tag "$GITHUB_REF_NAME" \
  --repository "$GITHUB_REPOSITORY"
```

Expected JSON adds `tag` and `repository` only when context validation was requested.

- [ ] **Step 5: Verify and commit**

Run:

```bash
npx vitest run \
  tests/scripts/check-release-toolchain.test.ts \
  tests/scripts/release-validation.test.ts
```

Expected: PASS.

```bash
git add \
  scripts/check-release-toolchain.mjs \
  scripts/validate-release.mjs \
  tests/scripts/check-release-toolchain.test.ts \
  tests/scripts/release-validation.test.ts
git commit -m "feat: validate npm publish context"
```

### Task 3: Replace the local publisher with an atomic release dispatcher

**Files:**
- Rewrite: `scripts/release.sh`
- Replace: `tests/scripts/release.test.ts`

**Interfaces:**
- Consumes: `node scripts/release-version.mjs sync`, `npm run validate-release`, Git `main`, `origin`, and one canonical version argument.
- Produces: one `chore(release): vMAJOR.MINOR.PATCH` commit, one annotated tag pointing to that commit, and one atomic push of `main` plus the tag.
- Explicitly does not consume npm credentials and does not publish or call skills.sh.

- [ ] **Step 1: Replace the oversized publication tests with local state-machine tests**

Retain the existing isolated Git fixture/stub strategy, but reduce the suite to these externally visible contracts:

```ts
it("rejects malformed versions before mutation");
it("rejects a dirty worktree, non-main branch, wrong origin, or stale main");
it("synchronizes exactly four release surfaces and runs every release gate");
it("creates one release commit and annotated tag, then pushes both atomically");
it("never invokes npm whoami, npm publish, an OTP, a token, or skills.sh");
it("resumes a clean local release commit and tag after an atomic push failure");
it("reports an already-dispatched matching remote release without mutation");
it("fails closed on lightweight, moved, partial, or conflicting local/remote tags");
it("retains synchronized local files after validation failure for an exact rerun");
```

The successful Git stub assertion must be:

```ts
expect(gitLog).toContain(
  "push --atomic origin main refs/tags/v0.3.3",
);
expect(npmLog).not.toMatch(/whoami|publish|otp/i);
expect(fetchLog).toBe("");
```

Run: `npx vitest run tests/scripts/release.test.ts`

Expected: FAIL against the current publisher.

- [ ] **Step 2: Implement the bounded shell state machine**

Keep `set -euo pipefail`, canonical version validation, exact package/origin identity, clean `main`, fetched `origin/main`, and exact validation commands. Remove npm authentication, npm publication, registry propagation, skills.sh discovery, and `.git/release-state` writes.

The only success paths are:

```text
new:       HEAD == origin/main, no local/remote tag -> sync -> validate -> commit -> annotated tag -> atomic push
resume:    HEAD == origin/main + 1, exact release commit/tag, remote tag absent -> revalidate -> atomic push
dispatched: HEAD == origin/main, exact annotated local/remote tag at HEAD -> print Actions URL -> exit 0
```

All other state combinations fail closed. Use this exact dispatch command:

```bash
git -C "$REPO_ROOT" push --atomic "$ORIGIN_NAME" \
  "$TARGET_BRANCH" "refs/tags/$RELEASE_TAG"
```

End with:

```text
Release v0.3.3 dispatched. GitHub Actions is responsible for npm publication:
https://github.com/ngelik/brain-hands/actions/workflows/publish-npm.yml
```

- [ ] **Step 3: Run the focused suite and prove npm publication is absent**

Run:

```bash
npx vitest run tests/scripts/release.test.ts
rg -n 'npm (whoami|publish)|NPM_TOKEN|NODE_AUTH_TOKEN|skills\.sh' scripts/release.sh
```

Expected: tests PASS and `rg` returns no matches.

- [ ] **Step 4: Commit the local handoff**

```bash
git add scripts/release.sh tests/scripts/release.test.ts
git commit -m "refactor: dispatch releases through immutable tags"
```

### Task 4: Implement exact-artifact OIDC publication and recovery

**Files:**
- Create: `scripts/publish-release.mjs`
- Create: `tests/scripts/publish-release.test.ts`

**Interfaces:**
- Produces: `publishRelease(options): Promise<PublishReleaseResult>` and CLI `node scripts/publish-release.mjs --tag TAG --commit SHA`.
- Consumes: `validatePublishContext`, npm CLI, registry metadata, and injected command and sleep functions in tests.
- Result fields: `{ version, tag, commit, tarball, integrity, published, registryVerified }`.

- [ ] **Step 1: Write failing unit tests with no live network or publication**

Cover:

```ts
it("packs once and publishes that exact tarball when the version is absent");
it("skips republishing when registry integrity already equals the packed artifact");
it("fails closed when an existing version has different integrity");
it("fails closed on registry errors other than an explicit 404");
it("retries delayed registry propagation and verifies the exact SHA-512 integrity");
it("never reads or requires an npm token or OTP");
```

The core successful command sequence is:

```ts
expect(commands).toEqual([
  ["npm", ["pack", "--json", "--pack-destination", packDir]],
  ["npm", ["publish", `./${tarball}`, "--access", "public"]],
]);
```

Run: `npx vitest run tests/scripts/publish-release.test.ts`

Expected: FAIL because the helper does not exist.

- [ ] **Step 2: Implement pack-once publication**

Parse the single-object `npm pack --json` result and require exact `filename`, `integrity`, package name, and version. Publish the relative tarball path so npm uploads the same bytes that were inspected. Query `@ngelik/brain-hands@VERSION` for `version` and `dist.integrity`:

- 404 before publish: publish.
- matching version and integrity: treat as an idempotent rerun and do not publish.
- any other error or integrity: fail closed.

After publication, retry registry reads with bounded delays `0, 2, 5, 10, 20, 30` seconds.

Always remove the temporary tarball in `finally`. Never print OIDC environment variables.

- [ ] **Step 3: Verify and commit**

Run: `npx vitest run tests/scripts/publish-release.test.ts`

Expected: PASS with zero network calls and zero real publishes.

```bash
git add scripts/publish-release.mjs tests/scripts/publish-release.test.ts
git commit -m "feat: publish exact npm artifacts with oidc"
```

### Task 5: Add the dry-runnable, environment-gated GitHub workflow

**Files:**
- Create: `.github/workflows/publish-npm.yml`
- Create: `tests/scripts/publish-workflow.test.ts`

**Interfaces:**
- `workflow_dispatch`: validation only; never requests OIDC and never publishes.
- stable tag push: validation job followed by serialized `npm-publish` environment job.
- npm Trusted Publisher claim: exact workflow filename `publish-npm.yml` and environment `npm-publish`.

- [ ] **Step 1: Add a failing structural workflow test**

Parse YAML with the existing `yaml` dependency. Assert exact action SHAs, Node 24, cache disabled, GitHub-hosted runner, tag plus manual triggers, serialized concurrency, environment name, job-scoped OIDC permission, `persist-credentials: false`, `npm ci --ignore-scripts`, all five gates, exact tag/main checks, and `scripts/publish-release.mjs`. Recursively serialize the parsed workflow and assert it does not match:

```ts
expect(serialized).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN|npm whoami|--otp/i);
```

Run: `npx vitest run tests/scripts/publish-workflow.test.ts`

Expected: FAIL because the workflow does not exist.

- [ ] **Step 2: Add the exact workflow**

```yaml
name: Publish npm package

on:
  push:
    tags:
      - "v*"
  workflow_dispatch:

permissions:
  contents: read

concurrency:
  group: npm-publish-${{ github.repository }}
  cancel-in-progress: false

jobs:
  validate:
    if: github.repository == 'ngelik/brain-hands'
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2
        with:
          fetch-depth: 0
          fetch-tags: true
          persist-credentials: false
      - uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e # v6.4.0
        with:
          node-version: "24"
          registry-url: "https://registry.npmjs.org"
          package-manager-cache: false
      - name: Verify release toolchain
        run: node scripts/check-release-toolchain.mjs
      - name: Verify immutable tag context
        if: github.event_name == 'push'
        run: |
          test "$(git cat-file -t "refs/tags/$GITHUB_REF_NAME")" = "tag"
          git fetch --no-tags origin main
          test "$(git rev-parse HEAD)" = "$(git rev-parse FETCH_HEAD)"
      - run: npm ci --ignore-scripts
      - run: npm run build
      - name: Verify release identity and tag version
        if: github.event_name == 'push'
        run: npm run validate-release -- --json --tag "$GITHUB_REF_NAME" --repository "$GITHUB_REPOSITORY"
      - run: npm test
      - run: npm run typecheck
      - run: npm pack --dry-run --json
      - run: npm run validate-release -- --json

  publish:
    if: github.event_name == 'push'
    needs: validate
    runs-on: ubuntu-latest
    timeout-minutes: 20
    environment: npm-publish
    permissions:
      contents: read
      id-token: write
    steps:
      - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2
        with:
          fetch-depth: 0
          fetch-tags: true
          persist-credentials: false
      - uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e # v6.4.0
        with:
          node-version: "24"
          registry-url: "https://registry.npmjs.org"
          package-manager-cache: false
      - run: npm ci --ignore-scripts
      - name: Revalidate publish context
        run: |
          npm run build
          npm run validate-release -- --json --tag "$GITHUB_REF_NAME" --repository "$GITHUB_REPOSITORY"
      - name: Publish and verify
        run: node scripts/publish-release.mjs --tag "$GITHUB_REF_NAME" --commit "$GITHUB_SHA" --repository "$GITHUB_REPOSITORY"
```

- [ ] **Step 3: Run workflow and release tests**

```bash
npx vitest run \
  tests/scripts/publish-workflow.test.ts \
  tests/scripts/publish-release.test.ts \
  tests/scripts/release.test.ts \
  tests/scripts/check-release-toolchain.test.ts \
  tests/scripts/release-validation.test.ts
```

Expected: PASS.

- [ ] **Step 4: Commit the workflow**

```bash
git add .github/workflows/publish-npm.yml tests/scripts/publish-workflow.test.ts
git commit -m "ci: publish npm releases with trusted publishing"
```

### Task 6: Rewrite operator documentation around the ownership boundary

**Files:**
- Modify: `docs/RELEASING.md`
- Modify: `README.md`

**Interfaces:**
- Produces: one documented operator command, one GitHub completion surface, and explicit recovery rules.

- [ ] **Step 1: Update the release lifecycle documentation**

Document this exact sequence:

```text
local:  preflight -> sync -> gates -> release commit -> annotated tag -> atomic push
CI:     validate immutable tag -> environment approval -> OIDC -> pack once -> publish exact tarball -> registry verify
proof:  successful publish-npm.yml run + npm version/integrity; provenance only if the repository becomes public
```

Replace npm authentication and local publication prerequisites with GitHub push permission and access to approve the `npm-publish` environment. State that `scripts/release.sh` returning success means “dispatched,” not “published.”

Recovery rules must be explicit:

- Before atomic push: fix the failure and rerun the same version; exact local commit/tag state may resume.
- After atomic push but before npm publication: correct external GitHub/npm environment configuration and rerun the same workflow if the tagged workflow code is sound.
- If tagged workflow code itself is defective: do not move the tag; fix `main` and release the next version.
- After npm accepted the version: rerun the same workflow; integrity matching skips republish and resumes registry verification.
- Never edit local evidence, delete a pushed tag, force-push a release, or try to reuse an npm version.

- [ ] **Step 2: Update the README pointer**

Replace “sole manual stable-release command” with “local stable-release dispatch command and GitHub Trusted Publishing completion procedure,” still linking to `docs/RELEASING.md`.

- [ ] **Step 3: Commit documentation**

```bash
git add docs/RELEASING.md README.md
git commit -m "docs: describe trusted npm release flow"
```

### Task 7: Run the full local verification and a non-publishing Actions rehearsal

**Files:**
- Verify only

- [ ] **Step 1: Run all repository gates**

```bash
npm test
npm run typecheck
npm run build
npm pack --dry-run --json
npm run validate-release -- --json
node dist/cli.js --version
git diff --check
```

Expected: every command passes; pack output contains only the approved runtime package contents; CLI version matches the current package version.

- [ ] **Step 2: Push the implementation commits to `main` without a release tag**

The workflow file must exist on the default branch before npm will accept it as a Trusted Publisher configuration. This is a normal implementation push, not `scripts/release.sh`.

- [ ] **Step 3: Run the `workflow_dispatch` rehearsal**

Run the `Publish npm package` workflow manually from `main`.

Expected: `validate` passes and `publish` is skipped. Confirm the run never requests environment approval, never requests an OIDC token, and never invokes `npm publish`.

### Task 8: Configure the two external trust boundaries

**Files:**
- GitHub repository settings
- npm package settings

- [ ] **Step 1: Create the GitHub environment**

Create environment `npm-publish`. Restrict deployment tags to `v*`. Add the maintainer as required reviewer; if a one-maintainer repository needs self-approval, leave “Prevent self-review” disabled. Do not store an npm secret in the environment.

- [ ] **Step 2: Register the npm Trusted Publisher**

In `@ngelik/brain-hands` package settings use:

```text
Provider: GitHub Actions
Organization or user: ngelik
Repository: brain-hands
Workflow filename: publish-npm.yml
Environment: npm-publish
Allowed actions: npm publish only
```

The filename is only `publish-npm.yml`, not `.github/workflows/publish-npm.yml`. All fields are case-sensitive. Keep existing manual/token access temporarily for canary recovery.

- [ ] **Step 3: Audit repository release protections**

Require workflow changes to be reviewed, retain branch protection for `main`, and add a tag ruleset limiting creation/deletion/update of `v*` tags to maintainers. Enable the repository policy requiring full-length action SHAs if compatible with all workflows.

### Task 9: Perform the first OIDC canary with `0.3.3`, then remove token publishing

**Files:**
- Release-generated changes only: `package.json`, `package-lock.json`, `.codex-plugin/plugin.json`, `.agents/skills/brain-hands/SKILL.md`

- [ ] **Step 1: Confirm no prior publish is still running**

Verify the `0.3.2` bootstrap and all earlier publish workflow runs are complete. Do not dispatch another release while `npm-publish` has running or queued work.

- [ ] **Step 2: Dispatch the canary using the new local command**

Run only with explicit approval for the irreversible tag/publish sequence:

```bash
scripts/release.sh 0.3.3
```

Expected locally: synchronized files, passing gates, `chore(release): v0.3.3`, annotated tag, atomic push, and a GitHub Actions URL. No npm authentication prompt occurs locally.

- [ ] **Step 3: Approve and observe the protected publish job**

Approve the `npm-publish` environment deployment. Confirm `validate` completed first, the job uses a GitHub-hosted runner, and no npm secret is present.

- [ ] **Step 4: Verify the public package release**

```bash
npm view @ngelik/brain-hands@0.3.3 \
  name version repository.url dist.integrity dist.tarball --json
```

Expected: exact package/version/repository, nonempty integrity and tarball URL, and a successful workflow. npm does not generate provenance while `ngelik/brain-hands` is private. If repository visibility is separately changed to public, verify that provenance links to the workflow, tag, and release commit. Catalog discovery is a separate post-release check because the public catalog API now requires deployment-specific Vercel OIDC.

- [ ] **Step 5: Close the token path only after the canary succeeds**

In npm package Settings → Publishing access, select **Require two-factor authentication and disallow tokens**. Revoke any now-unused granular automation/write token. Keep account-level 2FA enabled. Do not remove the Trusted Publisher.

## Acceptance criteria

- `scripts/release.sh` contains no npm authentication, npm publication, OTP/token handling, registry propagation, skills.sh HTTP logic, or durable npm evidence.
- The local script retains exact version synchronization, full validation gates, annotated tags, fail-closed state classification, and atomic dispatch/resume.
- `workflow_dispatch` proves validation without any publish-capable job running.
- Only the tag-triggered `publish` job has `id-token: write`, and it is bound to environment `npm-publish`.
- The workflow rejects malformed/mismatched tags, wrong repositories, lightweight tags, and tags not equal to `origin/main`.
- The workflow uses Node 24, verifies Node/npm floors, disables dependency caching, pins actions to the reviewed full SHAs, and contains no npm secret.
- CI packs once, publishes that exact tarball, compares registry integrity, and safely resumes post-publish verification without attempting to overwrite a version.
- All focused and full test/release gates pass.
- `0.3.3` is published by OIDC; provenance is expected only if the source repository is public.
- Traditional npm token publication is disabled only after the OIDC canary is proven.

## Sources

- npm Trusted Publishing: https://docs.npmjs.com/trusted-publishers/
- npm trust CLI and package-exists prerequisite: https://docs.npmjs.com/cli/v11/commands/npm-trust/
- npm publish package/tarball behavior: https://docs.npmjs.com/cli/publish/
- GitHub OIDC permissions: https://docs.github.com/en/actions/reference/security/oidc
- GitHub secure-use guidance for full-SHA action pins: https://docs.github.com/en/actions/reference/security/secure-use
- GitHub workflow concurrency/queueing: https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax
