# Stable releases with npm Trusted Publishing

Stable releases use two bounded stages:

1. `scripts/release.sh MAJOR.MINOR.PATCH` validates, commits, tags, and
   atomically pushes the release from a maintainer's checkout.
2. `.github/workflows/publish-npm.yml` validates the immutable tag and publishes
   `@ngelik/brain-hands` through npm Trusted Publishing with GitHub Actions OIDC.

The local command does not authenticate to npm and does not publish. A
successful local command means the release was dispatched, not that the package
was published.

## One-time service configuration

The package already exists on npm. Configure its Trusted Publisher with these
exact values:

- GitHub organization or user: `ngelik`
- repository: `brain-hands`
- workflow filename: `publish-npm.yml`
- environment: `npm-publish`
- permitted action: npm publication

Create the `npm-publish` environment in the GitHub repository before dispatching
the first OIDC release. The workflow references that environment, and only its
`publish` job receives `id-token: write`. Add a required reviewer when the
repository's GitHub plan and maintainer topology support an independent
approval. The `validate` job has read-only repository access and a manual
`workflow_dispatch` dry-run never enters the publish job.

Keep token-based publication enabled until one canary release has succeeded
with OIDC and its workflow plus registry integrity have been checked. Then
change npm package access to require two-factor authentication and disallow
tokens, and revoke any obsolete automation write token.

Trusted Publisher identity is exact and case-sensitive. Renaming the workflow,
repository, owner, or environment requires updating the npm configuration.

## Local prerequisites

Before running a stable release, confirm:

- the checkout is on `main`;
- `origin` resolves exactly to `github.com/ngelik/brain-hands`;
- local `main` is current with `origin/main`;
- there are no unrelated tracked or untracked changes;
- dependencies are installed; and
- the maintainer can atomically push `main` and an annotated tag.

The package identity must remain exactly `@ngelik/brain-hands`. Release
arguments must be canonical `MAJOR.MINOR.PATCH` values. Prereleases, build
metadata, leading zeroes, and a leading `v` are rejected.

## Dispatch a release

Run:

```bash
scripts/release.sh MAJOR.MINOR.PATCH
```

The command synchronizes exactly these version surfaces:

- `package.json` `version`;
- `package-lock.json` top-level `version` and `packages[""].version`;
- `.codex-plugin/plugin.json` `version`; and
- `.agents/skills/brain-hands/SKILL.md` `requires.codex_flow` as
  `^MAJOR.MINOR.PATCH`.

It then runs the six dispatcher gates before creating Git state:

```bash
npm test
npm run typecheck
npm run release:e2e
npm run build
npm pack --dry-run --json
npm run validate-release -- --json
```

`npm run release:e2e` is mandatory for dispatches through
`scripts/release.sh`; it is not an enforcement mechanism for arbitrary manual
tags. Pull-request CI, `main` push CI, and tag-publication CI do not run this
manual rehearsal.

The rehearsal builds the checkout CLI at `dist/cli.js` and runs exactly three
local dry-run scenarios: `happy`, `verifier-fix`, and `interrupted-resume`.
Additional infrastructure tests in the manual lane do not add release
scenarios. The rehearsal requires no live model, GitHub mutation, or
credentials. It checks canonical ledger and session artifacts separately from
progress telemetry. For `interrupted-resume`, the harness externally sends
`SIGTERM` to the parked process and resumes the same run.

Successful harness repositories are removed. If a scenario fails, its harness
repository is preserved and the diagnostic prints `scenario`, `repo`, `run`,
and `cleanup` paths. The failure blocks the release commit, tag, and push.
Because version synchronization happens before the gates, the four synchronized
version files may remain modified so the same version can be rerun safely.

After the gates pass, the command creates one
`chore(release): vMAJOR.MINOR.PATCH` commit, creates annotated tag
`vMAJOR.MINOR.PATCH`, and pushes `main` plus the tag in one atomic Git push.
That tag push starts the GitHub Actions workflow.

The command is narrowly resumable. If the release commit and annotated tag
exist locally as the single expected commit ahead of `origin/main`, rerunning
the same version repeats the gates and retries the atomic push. If the exact tag
and commit already exist locally and remotely, it reports the release as
already dispatched. Conflicting, lightweight, moved, stale, or divergent state
fails closed. Never repair a release by moving or recreating a pushed tag.

## CI validation and publication

The workflow uses GitHub-hosted `ubuntu-latest`, Node.js 24, npm 11.5.1 or
newer, and immutable action commit pins. Dependency caching and install scripts
are disabled during `npm ci`.

For tag events, the validation job reruns the ordinary and tag-specific
validation gates on the tagged source. It does not rerun the manual
`release:e2e` dispatcher gate. The validation job requires all of the
following:

- the event is a tag push;
- the tag is annotated;
- the tag dereferences to `GITHUB_SHA`;
- the tag is exactly `vMAJOR.MINOR.PATCH` and matches the package version;
- the repository is exactly `ngelik/brain-hands`;
- the tagged commit is the fetched `origin/main`; and
- the ordinary tests, typecheck, build, package dry-run, and release validation
  pass on the tagged source.

Only after validation succeeds does the `npm-publish` environment admit the
publish job. The publisher packs once in a temporary directory and publishes
that exact tarball. Before publishing, it queries the registry:

- an explicit 404 permits publication;
- an existing version with identical integrity is treated as an idempotent
  success;
- an existing version with different integrity fails closed; and
- any registry error other than an explicit 404 fails closed.

After publication, the helper retries registry reads for a bounded period and
requires the registry integrity to match the packed artifact. npm Trusted
Publishing supplies the short-lived credential. The repository stores no npm
write credential for this workflow.

## Verification

Follow the Actions URL printed by the local command. A release is complete only
when the `Publish npm package` workflow succeeds and registry metadata matches:

```bash
npm view @ngelik/brain-hands@MAJOR.MINOR.PATCH \
  name version repository.url gitHead dist.integrity dist.shasum --json
```

The GitHub repository is public. npm Trusted Publishing should automatically
generate provenance for each public release. Verify that provenance links to
`ngelik/brain-hands`, `publish-npm.yml`, the release tag, and its commit. For a
stable CLI smoke test, install the published version normally and invoke the
installed command; do not use `npm link`:

```bash
npm install -g @ngelik/brain-hands@MAJOR.MINOR.PATCH
brain-hands --version
```

The tagged repository content remains the source of truth for the bundled
`brain-hands` skill. Verify the tag as a Codex marketplace and install the
plugin separately from the npm CLI:

```bash
codex plugin marketplace add ngelik/brain-hands --ref vMAJOR.MINOR.PATCH --json
codex plugin add brain-hands@brain-hands --json
codex plugin list --json
```

For an existing tag-pinned installation, replace only this plugin and its
marketplace source:

```bash
codex plugin remove brain-hands@brain-hands --json
codex plugin marketplace remove brain-hands --json
codex plugin marketplace add ngelik/brain-hands --ref vMAJOR.MINOR.PATCH --json
codex plugin add brain-hands@brain-hands --json
codex plugin list --json
```

The npm version, `.codex-plugin/plugin.json` version, and skill compatibility
range must match. Open a fresh Codex task to verify the updated first-response
contract because existing tasks retain their already-loaded skill snapshot.
Do not use `marketplace upgrade` for a tag-pinned source.

The public skills catalog is a separate index. Its API now requires
deployment-specific Vercel OIDC, so the npm publisher neither stores that
credential nor treats catalog indexing as authority to publish. Check the
public catalog separately after a release when catalog discovery is required.

## Recovery

- If the manual release rehearsal fails during an initial dispatch, inspect the
  preserved repository and run using the printed `scenario`, `repo`, `run`,
  and `cleanup` paths, fix the defect, and rerun the same
  `scripts/release.sh MAJOR.MINOR.PATCH`. No local release commit or tag exists
  and no push occurred; the four synchronized version files may remain
  modified for that safe rerun.
- If a gate, including the rehearsal, fails while replaying a resumable
  dispatch after an atomic push failure, keep the exact local release commit
  and annotated tag. The remote branch and tag remain unchanged. Fix the
  defect and rerun the same `scripts/release.sh MAJOR.MINOR.PATCH`; do not move
  or recreate the tag or bypass the gate.
- If another local gate fails during an initial dispatch, fix the reported
  problem and rerun the same `scripts/release.sh MAJOR.MINOR.PATCH`. No local
  release commit or tag exists and no push occurred.
- If the atomic push fails, leave the exact local release commit and annotated
  tag intact while the remote branch and tag remain unchanged. Restore access
  and rerun the same command without moving or recreating the tag or bypassing
  a gate.
- If workflow validation fails, inspect the failed run. Do not move the tag;
  correct the release process and use a newly approved version.
- If the publish job is waiting, approve the `npm-publish` environment when the
  tag and validation evidence are correct.
- If npm publication fails before npm accepts the version, rerun the failed job
  after correcting Trusted Publisher or environment configuration.
- If npm already contains the version with matching integrity, rerunning the job
  is safe and skips publication. A different integrity is an investigation
  blocker.
- If registry propagation times out after npm accepted the version, rerun the
  job later; it will verify the existing matching artifact without republishing.

Published versions and pushed release tags are immutable. Do not force-push,
retag, edit local evidence to bypass a mismatch, or publish a replacement
artifact under an existing version.
