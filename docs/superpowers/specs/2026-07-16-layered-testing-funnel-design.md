# Layered Testing Funnel Design

**Date:** 2026-07-16

**Status:** Designs 1, 2, and 3 implemented

## Goal

Make Brain Hands verification progress from cheap contract failures to focused
component failures, mandatory cross-cutting regressions, immutable built-CLI
proof, repository-wide confirmation, and exact GitHub candidate synchronization.
No later layer may compensate for a missing or failed earlier layer.

## Scope

This design covers three related but independently testable subsystems:

1. The canonical `ExecutionSpecV2` contract and runtime ordering for focused and
   cross-cutting verification.
2. The Brain Hands repository's own one-build, immutable-`dist/` verification
   coordinator.
3. Durable local-candidate, mapped-PR, and remote-branch synchronization before
   final GitHub assurance.

The implementation is split into three plans in that order. Each plan must
leave the repository in a working, independently reviewable state.

The file-level plans are:

1. `docs/superpowers/plans/2026-07-16-layered-testing-contract-runtime.md`
2. `docs/superpowers/plans/2026-07-16-immutable-built-cli-funnel.md`
3. `docs/superpowers/plans/2026-07-16-remote-synchronization-assurance.md`

## Existing Behavior

At design approval, the execution contract already provided more coverage than
the original proposal assumed:

- Every non-read-only `file_contract` path must have a matching change unit.
- Every file-contract target must map to exactly one change unit.
- `completion_contract.expected_changed_files` must exactly equal the modifiable
  file set.
- Each declared test must reference a known verification command.
- Runtime compares Hands-reported and actual Git changed files with the approved
  completion contract before verification.

Therefore Markdown, prompt, skill, and workflow prose files do not need a
second narrative-specific authorization mechanism. They need regression tests
proving that the existing generic mechanism continues to apply to them.

Before Design 1 was implemented, runtime passed every work-item command to
`runVerification` as one array. The runner executed every command even when an
earlier command failed. It recorded useful evidence, but could not express or
enforce a focused-before-cross-cutting boundary.

Before Design 2 was implemented, the package lifecycle conflicted with an
immutable built artifact:

- `npm test` cleans and builds before running Vitest.
- CI runs `npm test`, then typecheck, then another build.
- `scripts/release.sh` runs `npm test`, then another build.
- `prepack` builds again.
- Built-CLI tests correctly require an existing `dist/cli.js` and do not build
  it themselves.

Before Design 3 was implemented, GitHub assurance resolved local HEAD and the
remote branch and looked up a PR by branch. That proved useful live state but
did not persist a single three-SHA synchronization observation. Status
publication could also request an assessment with `skipRemote: true`, which was
incompatible with a strict assurance invariant.

## Considered Approaches

### Approach A: Put the entire funnel in `ExecutionSpecV2`

This would add static, focused, cross-cutting, build, built-CLI, integrated, and
remote command groups to every plan.

**Advantages:** one visible schema; Brain can describe the whole sequence.

**Rejected because:** it duplicates command ownership, lets model output control
repository build integrity, makes non-CLI target repositories carry irrelevant
`dist/` concepts, and greatly expands replan compatibility work.

### Approach B: Implement only repository scripts and CI ordering

This would leave the execution schema unchanged and add one shell or Node
script that runs narrow tests, builds, runs built tests, and runs the full suite.

**Advantages:** small change; easy to invoke in CI.

**Rejected because:** it cannot prove shared-helper caller/fixture coverage,
cannot make cross-cutting verification mandatory in approved work items, and
does not fix GitHub assurance provenance.

### Approach C: Hybrid ownership by enforcement boundary

The canonical work item owns only durable test intent: each verification
command's tier and explicit cross-cutting impact records. Runtime owns fail-fast
ordering. Repository scripts own build and `dist/` immutability. GitHub runtime
owns remote observation, while assurance validates its durable artifact.

**Selected because:** each rule is enforced by the component that has the
required information and authority. It adds no generic built-CLI abstraction to
external projects and retains one canonical command object per work item.

## Design 1: Contract and Work-Item Funnel

### New durable fields

`ExecutionVerificationCommand` gains an optional persisted-plan-compatible tier:

```ts
export type VerificationTier = "focused" | "cross_cutting";

export interface ExecutionVerificationCommand {
  id: string;
  argv: readonly string[];
  expected_exit_code: 0;
  tier?: VerificationTier;
}
```

`ExecutionSpecV2` gains optional persisted-plan-compatible impact records:

```ts
export type CrossCuttingCategory =
  | "shared_helper"
  | "runtime"
  | "cli_lifecycle"
  | "ledger"
  | "artifact_paths";

export interface ExecutionCrossCuttingImpact {
  change_unit_id: string;
  category: CrossCuttingCategory;
  callers: string[];
  representative_fixtures: string[];
  verification_command_ids: string[];
}

export interface ExecutionSpecV2 {
  // Existing fields remain unchanged.
  cross_cutting_impacts?: ExecutionCrossCuttingImpact[];
}
```

Runtime Zod schemas accept missing fields for exact legacy-plan recovery. New
Codex structured output requires `tier` on every command and requires
`cross_cutting_impacts`, even when it is empty. Runtime treats a missing legacy
tier as `focused` and missing legacy impacts as an empty array. Parsing must not
rewrite persisted approved plan bytes.

### Static funnel rules

Plan readiness rejects a new work item when any of these is true:

1. It has no focused verification command.
2. A focused command follows a cross-cutting command.
3. An acceptance criterion cannot reach a command directly or through a test.
4. A command is orphaned from acceptance, tests, and impact records.
5. An impact references an unknown change unit or command.
6. An impact command is not marked `cross_cutting`.
7. A cross-cutting command is not owned by at least one impact record.
8. A `shared_helper` impact has no callers.
9. Any impact has no representative fixtures.
10. Caller or fixture paths are not declared in `file_contract`.
11. A known critical Brain Hands path lacks its required impact category.

Callers and fixtures that are inspected but not changed use `read_only`
file-contract entries. This makes impact evidence part of the approved scope
without authorizing Hands to modify it.

The initial exact critical-path registry is:

```text
shared_helper:
  src/adapters/git.ts
  src/adapters/github.ts
  src/core/command.ts
  src/core/config.ts
  src/core/execution-spec.ts
  src/core/executor.ts
  src/core/output-schemas.ts
  src/core/schema.ts
  src/core/secret-detector.ts
  src/workflow/authorization.ts

runtime:
  src/workflow/runtime.ts
  src/workflow/orchestrator.ts
  src/workflow/worker.ts
  src/workflow/implementer.ts

cli_lifecycle:
  src/cli.ts
  src/workflow/preflight.ts
  src/workflow/status.ts
  src/core/run-state.ts
  src/core/run-configuration.ts
  src/core/controller-provenance.ts

ledger:
  src/core/ledger.ts
  src/core/discovery-ledger.ts

artifact_paths:
  src/verification/runner.ts
  src/verification/evidence.ts
  src/workflow/owned-evidence.ts
  src/core/owned-evidence.ts
```

`src/core/types.ts` is not globally classified because many harmless type-only
changes occur there. A change unit that modifies shared workflow, ledger,
identity, or evidence types must declare `shared_helper` explicitly. Likewise,
a newly introduced helper does not become critical merely because it lives in a
particular directory: the same change must add it to this reviewed registry or
declare its impact explicitly. Static import-graph discovery remains excluded.

### Runtime execution

Approved commands remain in approved array order. Readiness proves that all
focused commands precede cross-cutting commands. Runtime does not silently sort
or rewrite the approved plan.

Work-item verification uses frozen direct local argv, for example `node
node_modules/vitest/vitest.mjs run tests/example.test.ts`. New Brain output must
not use lifecycle-owning `npm test`, `npm run build`, or `npm run clean` as a
work-item verification command.

`runVerification` gains `stopOnFailure?: boolean`. New work-item and integrated
calls use `true`; legacy callers retain run-all behavior when absent. The runner
persists stdout, stderr, and result JSON for the failing command before it stops.
Artifact checks still run so failed evidence remains auditable.

This produces the behavior:

```text
focused pass -> next focused -> cross-cutting pass -> next layer
focused fail -> persist failure -> stop
cross-cutting fail -> persist failure -> stop
```

The full repository suite is never substituted for a missing focused or
cross-cutting command.

### Replan behavior

New replan output is parsed through a strict generated-output schema. Each added
verification command requires `tier` and a nonempty `satisfies` list of local
acceptance IDs, and every response includes `added_cross_cutting_impacts` and
`added_read_only_file_contracts`, even when those arrays are empty. The persisted
replan schema remains recovery-compatible: it accepts omitted legacy arrays,
defaults omitted command linkage to empty, and preserves an omitted legacy tier.

Candidate construction links added command IDs into their declared acceptance
criteria, removes patch-only `satisfies` metadata from the canonical command,
and appends added caller or fixture contracts with `permission: "read_only"`.
Those read-only paths enter wildcard authorization exceptions but never
`completion_contract.expected_changed_files`. Both generated-patch validation
and approval build the same complete candidate and apply Spark/funnel readiness
before a new plan revision is persisted.

## Design 2: One-Build Immutable Built-CLI Proof

This subsystem is repository-owned. No generic `ExecutionSpecV2` field mentions
`dist/` or npm lifecycle commands.

### Coordinator sequence

`scripts/verify-repository.mjs` owns this exact sequence:

1. Static contract tests.
2. Conservative Brain Hands cross-cutting tests.
3. Typecheck.
4. One build.
5. Release metadata validation against that build.
6. Freeze the deterministic `dist/` digest.
7. Built-CLI lifecycle tests with `BRAIN_HANDS_DIST_IMMUTABLE=1`.
8. Verify the digest is unchanged.
9. Full Vitest suite with the same immutable environment.
10. Verify the digest is unchanged again.

The full suite intentionally repeats earlier tests. Its role is confirmation,
not initial localization.

### Mutation guard

The inline `clean` package script moves to `scripts/clean.mjs`. It refuses to
remove `dist/` when `BRAIN_HANDS_DIST_IMMUTABLE=1`. Since child test processes
inherit the environment, `npm run clean`, `npm run build`, and the current
build-owning `npm test` cannot mutate `dist/` inside a worker.

`scripts/dist-artifact.mjs` computes a deterministic digest from sorted relative
paths, entry kind, file length, and exact bytes. Symlinks are rejected so a
worker cannot change resolution without changing the digest contract. The
after-stage digest catches direct filesystem mutations that bypass npm scripts.

Vitest parallelism remains disabled in this change. Making future parallelism
safe is in scope; enabling it is not.

### Package and release lifecycle

`npm test` becomes the canonical `npm run verify:funnel` entrypoint. CI and the
release verification phase call the funnel once instead of invoking test,
typecheck, build, and validation as overlapping stages.

Package inspection after the frozen build uses `npm pack --dry-run --json
--ignore-scripts`, matching the existing release packer's lifecycle-output
avoidance. Normal `prepack` remains defensive for a real standalone npm pack or
publish; publication is a later mutation boundary, not part of candidate test
funnel immutability.

## Design 3: Durable Remote Synchronization

### Evidence artifact

GitHub delivery records an immutable artifact:

```ts
export interface RemoteSynchronizationEvidence {
  version: 1;
  run_id: string;
  branch_name: string;
  remote_name: string;
  pull_request_number: number;
  pull_request_url: string;
  local_candidate_sha: string | null;
  mapped_pr_sha: string | null;
  remote_head_sha: string | null;
  problems: Array<{
    source: "local" | "pull_request" | "remote";
    code: "lookup_unavailable" | "not_found" | "identity_mismatch" | "invalid_response" | "command_failed";
  }>;
  synchronized: boolean;
  observed_at: string;
}
```

The run manifest gains `remote_synchronization_path: string | null`.

The three identities are resolved from distinct authoritative paths:

```text
local_candidate_sha = git rev-parse HEAD
mapped_pr_sha       = getPullRequest(persisted PR number).head_sha
remote_head_sha     = git ls-remote --refs <remote> refs/heads/<branch>
```

The PR is fetched by the persisted mapped number, not inferred only from a
branch search. Its URL, state, head ref, and number must agree with the manifest.

The observation is persisted when a lookup fails or the SHAs do not match,
giving the operator exact blocker evidence without copying arbitrary command
stderr into the artifact. A successful synchronization requires an empty
`problems` array and all three non-null SHAs to be equal.

### Assurance boundary

Synchronization runs after final commit, push, and PR reconciliation, and
immediately before final assurance. Assurance requires the artifact to match the
current run, branch, PR mapping, and integrated commit.

New GitHub runs cannot use `skipRemote`. Legacy runs without the new pointer may
use the existing live lookup for recovery. A synchronization artifact for an
older commit cannot authorize a later candidate.

Remote synchronization blockers are not added to `WAIVABLE_BLOCKERS`; they
cannot become `human_accepted` assurance through the final-evidence risk gate.

## Error Handling

- Contract gaps are plan-readiness diagnostics before approval.
- Focused and cross-cutting command failures are deterministic verification
  failures with attempt-scoped evidence.
- Build or digest mutations are test-infrastructure blockers; they do not become
  product findings.
- Missing PR or remote SHAs persist a failed synchronization artifact and block
  delivery.
- Invalid or stale synchronization artifacts are `invalid_final_evidence`, not
  silent live fallbacks for new runs.
- Existing approved plan and replan bytes remain compatible and are never
  silently upgraded.

## Testing Strategy

Each subsystem uses red-green tests before broader integration:

1. Schema and readiness tests for tier, impact, narrative authorization, command
   reachability, and critical paths.
2. Planner/replan/prompt propagation tests.
3. Runner and runtime tests for fail-fast tier order and persisted failure
   evidence.
4. Script unit tests with injected command runners and digest providers.
5. Real built-CLI lifecycle tests against one frozen `dist/` tree.
6. Remote synchronization unit tests for every null and mismatch permutation.
7. Runtime GitHub and assurance integration tests.
8. The real repository funnel, frozen package inspection, and `git diff --check`.

## Deliberate Exclusions

- Enabling Vitest file parallelism.
- Building a generic build-artifact DSL for arbitrary target repositories.
- Static TypeScript import-graph analysis for automatic shared-helper discovery.
- Changing npm publication semantics or removing defensive `prepack`.
- Automatically merging a verified pull request.

## Success Criteria

- All changed files, including narrative files, remain under one authorization
  mechanism.
- Every new work item has focused verification and explicit machine-readable
  cross-cutting impacts when required.
- Focused failure prevents cross-cutting execution.
- Critical Brain Hands surfaces cannot omit cross-cutting verification.
- One coordinator build produces the exact `dist/` tested by built-CLI and full
  suite stages.
- Tests cannot clean or rebuild frozen `dist/` through package scripts.
- Direct `dist/` mutation is caught by digest comparison.
- Integrated full-suite proof occurs after narrow discovery layers.
- Final GitHub assurance requires one durable observation where local candidate,
  mapped PR head, and remote head are identical.
- Legacy plan, replan, and run recovery remains operational.
