# Review Fix Packet Contract Design

**Status:** Approved design

**Date:** 2026-07-12

## Purpose

Make review findings directly executable by a smaller Hands model without
giving that model responsibility for rediscovering the larger Verifier's
reasoning. Each actionable finding becomes a strict, immutable, versioned JSON
fix packet that explains the failure mechanism, bounds the allowed changes, and
defines machine-checkable completion evidence.

The existing review-policy engine remains the only authority that decides
whether a finding advances, fixes, replans, continues with an authorized
warning, or stops. The packet is an execution contract beneath a policy-approved
`fix` effect; it is not a transition command or a replacement plan.

## Problem

Current Verifier findings already carry severity, location, acceptance
criterion, problem class, evidence, a prose `required_fix`, re-verification
commands, action order, and dependencies. The ordered action queue also limits
Hands to one active finding and requires focused resolution before the next
action begins.

The weak boundary is the prose `required_fix`. A large Verifier may understand
a non-obvious failure, but a smaller Hands model still has to infer:

- the causal mechanism rather than only the symptom;
- observed versus required behavior;
- the exact symbols and tests involved;
- which files may change and which changes are forbidden;
- the atomic edits that jointly satisfy the finding;
- how each required behavior will be proven.

That inference burden causes incomplete fixes, unrelated edits, ineffective
tests, repeated findings, and exhausted fix attempts.

## Goals

- Preserve the larger Verifier's technical understanding in a structured
  remediation contract.
- Give Hands one bounded, self-contained fix packet at a time.
- Keep literal code construction with Hands instead of supplying an untested
  generated patch.
- Validate scope, identity, commands, and evidence before Hands is invoked.
- Make retries and resumes reuse exact immutable packet bytes.
- Resolve packets against deterministic evidence and individual success
  conditions.
- Preserve stable engine finding identity, policy authority, retry accounting,
  approval gates, and legacy-run behavior.

## Non-Goals

- Generate exact source patches for Hands to apply.
- Introduce another general-purpose planning language.
- Replace `ExecutionSpecV2` or create a new work item for each finding.
- Change review-policy decisions, review limits, or fix accounting.
- Let Verifier output authorize workflow transitions.
- Let Hands expand the approved work-item scope.
- Automatically migrate active legacy runs.
- Change GitHub status projection, pull-request ownership, merge behavior, or
  the no-auto-merge guarantee.

## Approaches Considered

### Extend each actionable review finding and compile a packet

This is the selected approach. The large Verifier emits a detailed diagnosis
and proposed remediation with the finding. The deterministic engine validates
the claim, adds trusted provenance, intersects the proposal with approved
scope, and persists `ReviewFixPacketV1`.

It adds no extra model call on the normal path and captures the diagnosis at
the point where the reviewing model understands it best.

### Ask Brain to translate every finding in a second model call

A separate large-model call could turn each finding into a fix spec. This adds
latency and cost and risks reinterpreting the original evidence. It is not the
normal design. The same Verifier receives at most one bounded correction call
only when semantic packet validation fails.

### Convert each finding into `ExecutionSpecV2`

This would reuse an existing contract, but it gives a correction the weight and
scope of a newly approved work item. Review fixes must remain subordinate to
the existing approved work item and cannot redefine its plan. A smaller packet
contract is the clearer boundary.

## Architecture

```text
Large Verifier
  -> Verifier finding plus remediation claim
  -> deterministic finding normalization and policy evaluation
  -> policy-approved fix effect
  -> deterministic ReviewFixPacketV1 compilation
  -> immutable packet persistence
  -> one active packet sent to Hands
  -> diff-scope enforcement and deterministic verification
  -> Hands self-review
  -> focused packet resolution
```

The workflow keeps three distinct representations:

1. `VerifierFinding` is an evidence-backed model claim.
2. `EngineFinding` owns stable identity, disposition, occurrence history, and
   policy input.
3. `ReviewFixPacketV1` is the validated execution contract for one
   policy-authorized action.

The packet compiler is deterministic and performs no model call. It never
silently removes invalid scope or invents missing remediation.

## Canonical Packet Contract

Packets use canonical JSON. YAML is not used because aliases, implicit types,
duplicate keys, and serializer variation create avoidable ambiguity for small
models and durable hashes.

```ts
interface ReviewFixPacketV1 {
  schema_version: 1;
  provenance: FixPacketProvenance;
  diagnosis: FixPacketDiagnosis;
  targets: FixTarget[];
  remediation: FixPacketRemediation;
  verification: FixPacketVerification;
  completion_contract: FixPacketCompletionContract;
}
```

### Provenance

```ts
interface FixPacketProvenance {
  packet_id: string;
  finding_id: string;
  action_id: string;
  review_revision: number;
  work_item_id: string;
  criterion_ref: string;
  approved_plan_sha256: string;
}
```

All provenance fields are engine-owned. Model output cannot choose or override
them. `packet_id` is revision-scoped action identity. The stable `finding_id`
continues to come from normalized engine finding identity rather than model
wording. The approved plan hash prevents a packet from being applied to stale
scope after a replan.

### Diagnosis

```ts
interface FixPacketDiagnosis {
  problem_class: VerifierProblemClass;
  severity: "critical" | "high" | "medium" | "low";
  observed_behavior: string;
  expected_behavior: string;
  failure_mechanism: string;
  reproduction: string[];
  evidence_refs: string[];
}
```

Every actionable finding explains the observable failure, required behavior,
causal mechanism, reproduction path, and immutable supporting evidence. Vague
phrases such as `as needed`, `where appropriate`, `if necessary`, `properly`,
`related changes`, and `etc.` fail readiness validation.

### Typed Targets

```ts
type FixTarget =
  | { kind: "code"; path: string; symbol: string; line_hint: number | null }
  | { kind: "test"; path: string; test_name: string; line_hint: number | null }
  | { kind: "command"; command_id: string }
  | { kind: "artifact"; artifact_id: string; path: string }
  | { kind: "browser"; check_id: string; selector: string | null }
  | { kind: "release_guard"; guard_id: string };
```

Line numbers are hints rather than identity. Symbols, test names, declared
command IDs, artifact IDs, browser-check IDs, and release-guard IDs provide the
stable target vocabulary.

### Remediation

```ts
interface FixPacketRemediation {
  strategy: string;
  change_units: FixChangeUnit[];
  allowed_files: string[];
  forbidden_changes: ForbiddenChange[];
}

interface FixChangeUnit {
  id: string;
  path: string;
  target: string;
  operation: "modify" | "create" | "delete";
  requirements: string[];
  satisfies: string[];
}

interface ForbiddenChange {
  path: string;
  reason: string;
}
```

Each change unit describes one edit responsibility in one file and target.
Requirements state observable behavior and invariants, not literal patches.
`satisfies` contains success-condition IDs. Every writable file and target maps
to at least one change unit, and unrelated concerns cannot share a change unit.

### Verification

```ts
interface FixPacketVerification {
  commands: FixVerificationCommand[];
  success_conditions: FixSuccessCondition[];
  required_evidence: RequiredFixEvidence[];
}

interface FixVerificationCommand {
  id: string;
  argv: readonly string[];
}

interface FixSuccessCondition {
  id: string;
  statement: string;
  satisfied_by: string[];
}

interface RequiredFixEvidence {
  id: string;
  kind: "command_result" | "test_result" | "artifact" | "browser";
  source_id: string;
  output_path: string;
}
```

Commands are argument vectors, never shell strings. Every success condition
references at least one executable test or verification command. All command,
change-unit, condition, and evidence references must resolve to unique declared
IDs.

### Completion Contract

```ts
interface FixPacketCompletionContract {
  required_change_unit_ids: string[];
  expected_changed_files: string[];
  allow_additional_files: false;
}
```

All change units are required. `expected_changed_files` exactly equals the
writable packet files. Additional files are never allowed.

## Verifier Output Changes

Newly generated actionable `request_changes` findings require a structured
`remediation` claim containing diagnosis detail, typed targets, proposed change
units, allowed files, forbidden changes, commands, and success conditions.

The model-owned claim excludes trusted provenance and uses the same nested
diagnosis, target, remediation, and verification shapes as the packet:

```ts
interface VerifierRemediationClaimV1 {
  schema_version: 1;
  diagnosis: Omit<FixPacketDiagnosis, "problem_class" | "severity">;
  targets: FixTarget[];
  remediation: FixPacketRemediation;
  verification: FixPacketVerification;
  completion_contract: FixPacketCompletionContract;
}
```

`problem_class`, severity, criterion identity, finding identity, review/action
identity, work-item identity, and plan hash come from separately validated
review and engine state. The compiler rejects any remediation content that
conflicts with those trusted inputs.

The strict output rules are:

- Actionable `request_changes` findings require remediation.
- `replan_required`, advisory-only, and operational findings do not carry an
  executable remediation claim.
- Approval cannot contain blocking remediation.
- Operational blockers cannot masquerade as code remediation.
- Newly generated output is strict and rejects unknown fields.
- Legacy persisted reviews remain readable without remediation.

For new generated output, `remediation.verification.commands` replaces the
top-level finding field `re_verification`. The legacy persisted-review parser
continues to accept `re_verification`; the strict generated-output schema does
not require or accept both representations. This prevents duplicated commands
from drifting apart.

The Verifier describes technical meaning. It does not assign durable finding
identity, approved-plan identity, final allowed scope, or workflow action.

## Packet Compilation and Scope Enforcement

The compiler receives the validated Verifier action, stable Engine finding,
approved `ExecutionSpecV2` work item, review revision, and approved-plan hash.

It validates:

- every allowed path is normalized and repository-relative;
- `.git`, absolute paths, parent traversal, globs, control characters, and
  case-insensitive collisions are rejected;
- every writable file already has writable permission in the approved work
  item;
- each operation matches the approved file permission;
- every target is declared for that file;
- completion files exactly match the packet's writable files;
- all IDs are unique and all references resolve;
- each success condition has executable evidence;
- verification commands pass repository command policy;
- evidence references use safe run-relative paths;
- the approved-plan hash matches the active approved revision;
- dependency IDs reference only earlier active or completed actions.

The compiler never narrows invalid model-proposed scope silently. If the
required correction genuinely needs a file, target, operation, criterion, or
architecture outside the approved work item, the finding routes to
`requires_replan`. If the conflict reflects malformed or contradictory model
output rather than legitimate scope insufficiency, it is an invalid Verifier
contract.

## Invalid Contract Correction

Syntactically valid model output can still fail semantic readiness. Brain Hands
allows at most one correction call to the same large Verifier. The correction
prompt contains only:

- the original finding and remediation claim;
- deterministic validation errors;
- the approved work-item scope required to correct those errors.

The Verifier may return a corrected remediation, declare `replan_required`, or
report an operational blocker. This correction consumes no Hands fix attempt.

If the second response remains invalid, the workflow stops with
`invalid_verifier_contract`. It never falls back to sending a prose-only
finding to Hands.

## Hands Input

Hands receives exactly one active packet plus bounded context:

```ts
interface FixPacketHandsInput {
  active_fix_packet: ReviewFixPacketV1;
  approved_work_item: ExecutionSpecV2;
  relevant_source_context: SourceContext[];
  evidence_context: EvidenceContext[];
  completed_dependencies: CompletedFixSummary[];
  current_diff: string;
  prior_attempt: FixAttemptSupplementV1 | null;
}
```

The engine prepares context from packet-allowed files, identified symbols and
tests, referenced evidence, completed dependencies, and the diff restricted to
packet files. Hands does not receive future packets, unrelated repository
files, other unresolved actions, raw secrets, unrestricted logs, or permission
to reinterpret the approved criterion.

The prompt requires Hands to complete every change unit, modify only expected
files, preserve forbidden-change constraints, avoid weakening tests, run only
approved commands, and report an exact contradiction instead of applying a
partial best-effort fix.

## Hands Result

```ts
interface FixPacketResultV1 {
  schema_version: 1;
  packet_id: string;
  packet_sha256: string;
  action_attempt: number;
  status: "implemented" | "packet_contradiction" | "operationally_blocked";
  change_units: FixChangeUnitResult[];
  changed_files: string[];
  commands_attempted: FixCommandAttempt[];
  unresolved_requirements: UnresolvedFixRequirement[];
  blocker: OperationalBlocker | null;
}
```

`implemented` requires every change unit complete and no unresolved
requirements. `packet_contradiction` requires at least one precise unresolved
requirement. Reported changed files must equal the union of completed
change-unit files and cannot escape packet scope. Attempted commands reference
declared command IDs. The result is a model claim; the engine independently
checks the worktree and evidence.

## Post-Mutation Quality Gate

After a Hands result, the runtime executes these gates in order:

1. Verify packet ID, packet hash, action attempt, work-item identity, and
   approved-plan hash.
2. Compare the real Git diff with `expected_changed_files` and block any
   unexpected file.
3. Confirm every required change unit is complete and maps to a real changed
   file.
4. Run packet verification commands through the safe command executor.
5. Resolve each success condition against its required evidence.
6. Run configured Hands self-review passes using the same packet and actual
   diff.
7. Ask the focused Verifier to resolve the packet against the immutable packet,
   before-and-after diff, deterministic evidence, and self-review reports.

Self-review may correct only a missed packet requirement, a regression
introduced by the packet, or damage to a previously resolved dependency.

## Focused Packet Resolution

The focused Verifier returns packet identity, packet hash, attempt, a result for
every success condition, evidence references, and one decision:

- `resolved`
- `still_open`
- `packet_contradiction`
- `operationally_blocked`

`resolved` requires every condition satisfied by deterministic evidence.
`still_open` identifies unsatisfied condition IDs and a bounded next-fix
clarification. The focused Verifier cannot change the packet, add unrelated
findings, resolve another action, change the criterion, or override failed
deterministic verification.

A `still_open` decision creates an immutable attempt supplement:

```ts
interface FixAttemptSupplementV1 {
  packet_id: string;
  base_packet_sha256: string;
  next_attempt: number;
  unsatisfied_condition_ids: string[];
  remaining_problem: string;
  required_next_fix: string;
  additional_evidence_refs: string[];
}
```

The next Hands attempt receives the original packet plus the supplement. The
original packet is never edited. A packet contradiction routes to replanning
instead of consuming an ordinary retry.

## Persistence and Resume

Packets and attempts use create-once artifacts:

```text
reviews/
  findings/<finding-id>/
    revision-<n>.json
  fix-packets/<packet-id>/
    packet.json
    packet.sha256
    attempts/
      1/
        hands-result.json
        diff.patch
        verification.json
        self-review-1.json
        self-review-2.json
        focused-resolution.json
      2/
        attempt-supplement.json
        hands-result.json
        ...
```

Resume follows persisted state without regenerating completed artifacts:

- No packet persisted: compile and persist it.
- Packet persisted without Hands result: invoke Hands with the stored bytes.
- Hands result persisted with incomplete verification: continue verification.
- Verification complete without focused resolution: invoke focused Verifier.
- `still_open`: load the supplement and begin the next bounded attempt.
- `resolved`: mark the ordered queue action complete.
- Ambiguous external mutation: fail closed until reconciliation proves its
  outcome.

Neither retry nor resume regenerates an already persisted packet.

## Accounting and Policy

The deterministic policy evaluator remains unchanged. It decides whether a
normalized finding is eligible for `fix`. Packet validation and execution occur
only inside that authorized effect.

- Contract-correction calls consume no Hands fix attempts.
- Successful Hands mutations consume the existing fix budget.
- Hands self-review retains separate accounting.
- Operational failures consume no fix budget.
- Replanning remains narrow and approval-gated.
- Packet execution cannot advance, waive, replan, or stop independently of the
  policy engine.

## Compatibility

New runs use `ReviewFixPacketV1`. Existing active runs with persisted legacy
queues continue through the legacy action path. Resume detects the persisted
queue contract version and does not synthesize a new packet after legacy work
has begun.

Current stable finding identity and convergence history remain readable. An
explicit legacy-run migration command is outside this feature.

The generic `hands-fixer.md` prompt remains for legacy GitHub review flows. The
new ordered packet path uses `hands-fix-packet-v1.md` and the unified
`verification.commands` vocabulary instead of the older
`verification_after_fix`/`re_verification` drift.

## Repository Changes

### New files

- `src/core/review-fix-packet.ts`: packet and result types, schemas, readiness
  validation, canonical serialization, and hashing.
- `src/workflow/fix-packets.ts`: compilation, persistence, loading, semantic
  correction, and attempt supplements.
- `prompts/hands-fix-packet-v1.md`: bounded small-model fixer prompt.
- `tests/core/review-fix-packet.test.ts`: contract and readiness tests.
- `tests/workflow/fix-packets.test.ts`: compilation and persistence tests.

### Existing files

- `src/core/types.ts`: Verifier remediation claim and packet-facing shared
  types.
- `src/core/schema.ts`: strict runtime schemas plus legacy persisted-review
  compatibility.
- `src/core/output-schemas.ts`: strict generated Verifier and Hands JSON output
  schemas.
- `prompts/verifier-review-v2.md`: require detailed actionable remediation.
- `src/workflow/reviewer-actions.ts`: queue packet references and version
  validation.
- `src/workflow/runtime.ts`: packet lifecycle beneath policy-approved fix
  effects.
- `src/workflow/self-review.ts`: packet-scoped self-review context.
- `src/workflow/action-verifier.ts`: condition-level packet resolution.
- `src/core/ledger.ts`: create-once packet and attempt artifact helpers.
- relevant schema, verifier, runtime, ledger, and CLI lifecycle tests.
- `README.md` and `agentic-codex-workflow.md`: operator contract and durable
  artifact behavior.

## Testing

### Contract and schema

Cover canonical bytes and hash stability, duplicate IDs, unknown references,
missing executable evidence, vague requirements, unsafe paths,
case-insensitive collisions, operation mismatches, unexpected writable files,
additional-file permission, stale plan hash, malformed target unions, strict
unknown-field rejection, actionable remediation requirements, replan and
operational exclusions, and legacy persisted-review compatibility.

### Compiler and ledger

Cover engine-derived provenance, approved-scope intersection, legitimate replan
classification, invalid-contract correction, second-invalid-response blocking,
create-once persistence, conflicting rewrite rejection, exact resume bytes, and
immutable supplements.

### Runtime

Cover first-attempt resolution, dependent packet order, absence of future
packets from Hands context, unexpected real-diff files, `still_open` retry,
packet contradiction, crashes after packet persistence, Hands mutation, and
verification, no duplicate invocation after completion, accounting invariants,
and legacy-queue resume.

### Adversarial small-model fixture

Add a non-obvious crash/resume defect for which the old prose `required_fix` is
insufficient. The packet supplies failure mechanism, exact targets, constraints,
regression test, and success conditions. A constrained mock Hands path succeeds
using only packet context. Removing each critical packet component causes
readiness validation to fail.

This deterministic fixture proves contract completeness without asserting that
one live model always behaves identically. A final manual lifecycle validates
the actual configured smaller Hands model.

## Acceptance Criteria

1. Every new actionable review finding produces a valid immutable packet before
   Hands invocation.
2. The new path never sends an unvalidated prose-only finding to Hands.
3. Packets cannot broaden approved work-item scope.
4. Every packet requirement maps to a deterministic success condition.
5. Real diff state, not model reporting, determines file-scope compliance.
6. Focused resolution evaluates every success condition.
7. Resume reuses exact persisted packet bytes and hash.
8. Invalid packets receive at most one large-Verifier correction attempt.
9. Legacy active runs retain their previous semantics.
10. A built-CLI lifecycle demonstrates a complex review finding being fixed by
    the configured smaller Hands model with complete packet, result,
    verification, resolution, and delivery artifacts.

## Verification Gates

Implementation is not complete until all of these pass independently:

```text
npm run typecheck
npm test
npm run build
git diff --check
node dist/cli.js --version
npm_config_cache=/private/tmp/brain-hands-npm-cache npm pack --dry-run
```

The final lifecycle uses a larger Verifier, the configured smaller Hands model,
and an intentionally non-obvious review defect. The run must retain the packet,
Hands result, deterministic verification evidence, focused condition results,
and final delivery proof.
