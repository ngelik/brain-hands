# Layered Testing Contract and Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Use `superpowers:subagent-driven-development` only when the operator explicitly authorizes subagents. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add focused and cross-cutting verification intent to new execution plans, reject incomplete impact coverage before approval, and stop verification at the first failed layer while preserving legacy run recovery.

**Architecture:** `ExecutionSpecV2` gains persisted-plan-compatible tier and impact metadata. A focused `testing-funnel` module owns deterministic readiness rules; runtime preserves approved command order and asks the existing verification runner to stop after the first failure. Existing plan bytes remain valid, while new Codex output and new replans must provide the new fields.

**Tech Stack:** TypeScript 6, Zod 4, Vitest 4, existing Brain Hands ledger/runtime architecture.

## Global Constraints

- Work on `main`; do not create a feature branch unless the user asks.
- Preserve unrelated working-tree changes.
- Do not introduce a second narrative-file authorization mechanism.
- Keep `schema_version: "2.0"`; compatibility fields are optional only in persisted-plan parsing.
- New structured Brain output must require command tiers and `cross_cutting_impacts`.
- Missing legacy command tiers mean `focused`; missing legacy impact arrays mean empty.
- Never rewrite approved persisted plan bytes to inject defaults.
- Keep verification commands as frozen direct argv arrays.
- Do not add build, `dist/`, CI, or remote-SHA behavior in this plan.
- Do not enable Vitest parallelism.

---

## File Responsibility Map

- `src/core/types.ts`: public TypeScript contract for tiers and cross-cutting impact records.
- `src/core/schema.ts`: persisted runtime parsing with backward-compatible optional fields.
- `src/core/output-schemas.ts`: strict new Codex output requiring the new fields.
- `src/core/testing-funnel.ts`: tier defaults, critical-surface registry, and funnel-readiness errors.
- `src/core/execution-spec.ts`: aggregate funnel errors into existing Spark/plan readiness.
- `src/verification/runner.ts`: optional fail-fast command execution after evidence persistence.
- `src/workflow/runtime.ts`: opt new work-item and integrated verification into fail-fast behavior.
- `src/workflow/replan.ts`: validate and apply added tiered commands and impact records.
- `prompts/*.md`: make Brain, Hands, Verifier, and replan roles honor the same contract.
- `tests/fixtures/execution-spec.ts`: canonical fixture for all downstream tests.

## Task 1: Add backward-compatible tier and impact types

**Files:**
- Modify: `src/core/types.ts:776-832`
- Modify: `src/core/schema.ts:577-633`
- Modify: `src/core/output-schemas.ts:125-266`
- Modify: `tests/fixtures/execution-spec.ts:1-68`
- Test: `tests/core/schema.test.ts`
- Test: `tests/core/execution-spec.test.ts:14-125`

**Interfaces:**
- Produces: `VerificationTier`, `CrossCuttingCategory`, `ExecutionCrossCuttingImpact`.
- Extends: `ExecutionVerificationCommand.tier` and `ExecutionSpecV2.cross_cutting_impacts`.
- Compatibility: runtime Zod fields optional; new output-schema fields required.

- [ ] **Step 1: Write failing persisted-schema and output-schema tests**

Add tests proving legacy parsing remains exact and new output requires the fields:

```ts
it("keeps legacy v2 plans parseable without funnel metadata", () => {
  const legacy = validExecutionSpec();
  expect(executionSpecV2Schema.parse(legacy)).toEqual(legacy);
});

it("requires funnel metadata in new structured output", () => {
  expect(executionSpecV2OutputSchema.required).toContain("cross_cutting_impacts");
  const command = executionSpecV2OutputSchema.properties.verification_commands.items;
  expect(command.required).toContain("tier");
});
```

Import `executionSpecV2OutputSchema` in `tests/core/execution-spec.test.ts`.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
npx vitest run tests/core/execution-spec.test.ts tests/core/schema.test.ts
```

Expected: FAIL because `cross_cutting_impacts` and command `tier` are absent from the structured output schema.

- [ ] **Step 3: Add the exact TypeScript types**

Insert before `ExecutionVerificationCommand`:

```ts
export type VerificationTier = "focused" | "cross_cutting";

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
```

Change the command and work-item interfaces to:

```ts
export interface ExecutionVerificationCommand {
  id: string;
  argv: readonly string[];
  expected_exit_code: 0;
  tier?: VerificationTier;
}

export interface ExecutionSpecV2 {
  schema_version: "2.0";
  id: string;
  title: string;
  objective: string;
  dependencies: string[];
  file_contract: ExecutionFileContractEntry[];
  forbidden_changes: ForbiddenChange[];
  change_units: ExecutionChangeUnit[];
  acceptance: ExecutionAcceptanceCriterion[];
  tests: ExecutionTestCase[];
  verification_commands: ExecutionVerificationCommand[];
  cross_cutting_impacts?: ExecutionCrossCuttingImpact[];
  expected_artifacts: string[];
  browser_checks: BrowserCheckSpec[];
  risks: ExecutionRisk[];
  completion_contract: {
    expected_changed_files: string[];
    allow_additional_files: boolean;
    required_acceptance_ids: string[];
  };
  ambiguity_policy: {
    default: "stop_and_report";
    stop_when: string[];
  };
}
```

- [ ] **Step 4: Extend the persisted Zod schema without adding defaults**

Add:

```ts
const verificationTierSchema = z.enum(["focused", "cross_cutting"]);
const crossCuttingCategorySchema = z.enum([
  "shared_helper",
  "runtime",
  "cli_lifecycle",
  "ledger",
  "artifact_paths",
]);

export const executionCrossCuttingImpactSchema = z.object({
  change_unit_id: z.string().min(1),
  category: crossCuttingCategorySchema,
  callers: z.array(z.string().min(1)),
  representative_fixtures: z.array(z.string().min(1)),
  verification_command_ids: z.array(z.string().min(1)).min(1),
}).strict();
```

Add `tier: verificationTierSchema.optional()` to verification command objects and
`cross_cutting_impacts: z.array(executionCrossCuttingImpactSchema).optional()` to `executionSpecV2Schema`.

Do not use `.default()`: parsing must not change legacy approved objects.

- [ ] **Step 5: Require the fields in new Codex output**

Add this property to `executionSpecV2OutputSchema`:

```ts
cross_cutting_impacts: {
  type: "array",
  items: {
    type: "object",
    additionalProperties: false,
    properties: {
      change_unit_id: { type: "string", minLength: 1 },
      category: {
        type: "string",
        enum: ["shared_helper", "runtime", "cli_lifecycle", "ledger", "artifact_paths"],
      },
      callers: stringArray,
      representative_fixtures: stringArray,
      verification_command_ids: nonEmptyStringArray,
    },
    required: [
      "change_unit_id",
      "category",
      "callers",
      "representative_fixtures",
      "verification_command_ids",
    ],
  },
},
```

Add `tier: { type: "string", enum: ["focused", "cross_cutting"] }` to command properties and add `tier` to the command's required array. Add `cross_cutting_impacts` to the work item's required array.

- [ ] **Step 6: Update the canonical execution fixture**

Add `cross_cutting_impacts: []` after `verification_commands` and change its command to:

```ts
{
  id: `${id}-VERIFY-01`,
  argv: ["npx", "vitest", "run", testPath],
  expected_exit_code: 0,
  tier: "focused",
}
```

- [ ] **Step 7: Run the focused tests and verify GREEN**

Run:

```bash
npx vitest run tests/core/execution-spec.test.ts tests/core/schema.test.ts
npm run typecheck
```

Expected: PASS. Legacy fixture tests still load; new output-schema assertions pass.

## Task 2: Implement deterministic funnel readiness

**Files:**
- Create: `src/core/testing-funnel.ts`
- Create: `tests/core/testing-funnel.test.ts`
- Modify: `src/core/execution-spec.ts:57-260`
- Modify: `tests/core/execution-spec.test.ts`

**Interfaces:**
- Consumes: `ExecutionSpecV2`, `ExecutionVerificationCommand`.
- Produces: `effectiveVerificationTier`, `testingFunnelErrors`, `assertTestingFunnelReady`.
- `sparkReadinessErrors` appends `testingFunnelErrors(spec)`.

- [ ] **Step 1: Write failing tests for tier order and impact ownership**

Create `tests/core/testing-funnel.test.ts` with cases that assert these messages:

```ts
expect(testingFunnelErrors(spec)).toContain("BH-001 has no focused verification command");
expect(testingFunnelErrors(spec)).toContain("VERIFY-01 focused command appears after cross-cutting verification");
expect(testingFunnelErrors(spec)).toContain("CH-01 shared_helper impact requires at least one caller");
expect(testingFunnelErrors(spec)).toContain("CH-01 cross-cutting impact requires at least one representative fixture");
expect(testingFunnelErrors(spec)).toContain("VERIFY-02 cross-cutting command is not owned by an impact record");
```

Use `executionSpec("BH-001")` as the fixture and mutate one field per test.

- [ ] **Step 2: Write failing tests for acceptance-command reachability**

Add cases proving:

```ts
const spec = executionSpec("BH-001");
spec.acceptance[0]!.satisfied_by = [spec.change_units[0]!.id];
expect(testingFunnelErrors(spec)).toContain(
  `${spec.acceptance[0]!.id} has no reachable verification command`,
);
```

Also prove acceptance → test → command is valid and acceptance → command is valid.

- [ ] **Step 3: Write failing critical-surface and narrative tests**

Add a table-driven critical path test for every registry entry. For narrative files, add a `README.md` modifiable contract without a matching change unit and verify the existing error remains:

```ts
expect(() => assertSparkReady(spec)).toThrow(/README\.md has no change unit/);
```

Then add the matching change unit and completion path and prove it passes. This is a regression test, not a new narrative classifier.

- [ ] **Step 4: Run the new tests and verify RED**

Run:

```bash
npx vitest run tests/core/testing-funnel.test.ts tests/core/execution-spec.test.ts
```

Expected: FAIL because `src/core/testing-funnel.ts` does not exist.

- [ ] **Step 5: Implement the tier helper and exact critical registry**

Create `src/core/testing-funnel.ts` with:

```ts
import type {
  CrossCuttingCategory,
  ExecutionSpecV2,
  ExecutionVerificationCommand,
  VerificationTier,
} from "./types.js";

export function effectiveVerificationTier(
  command: ExecutionVerificationCommand,
): VerificationTier {
  return command.tier ?? "focused";
}

export const criticalVerificationSurfaces: Readonly<Record<
  CrossCuttingCategory,
  ReadonlySet<string>
>> = {
  shared_helper: new Set([
    "src/adapters/git.ts",
    "src/adapters/github.ts",
    "src/core/command.ts",
    "src/core/config.ts",
    "src/core/execution-spec.ts",
    "src/core/executor.ts",
    "src/core/output-schemas.ts",
    "src/core/schema.ts",
    "src/core/secret-detector.ts",
    "src/workflow/authorization.ts",
  ]),
  runtime: new Set([
    "src/workflow/runtime.ts",
    "src/workflow/orchestrator.ts",
    "src/workflow/worker.ts",
    "src/workflow/implementer.ts",
  ]),
  cli_lifecycle: new Set([
    "src/cli.ts",
    "src/workflow/preflight.ts",
    "src/workflow/status.ts",
    "src/core/run-state.ts",
    "src/core/run-configuration.ts",
    "src/core/controller-provenance.ts",
  ]),
  ledger: new Set([
    "src/core/ledger.ts",
    "src/core/discovery-ledger.ts",
  ]),
  artifact_paths: new Set([
    "src/verification/runner.ts",
    "src/verification/evidence.ts",
    "src/workflow/owned-evidence.ts",
    "src/core/owned-evidence.ts",
  ]),
};
```

- [ ] **Step 6: Implement funnel error aggregation**

Implement `testingFunnelErrors` using maps for commands/tests, sets for change units/file paths, and the exact rules in the design spec. The core loop must preserve these messages:

```ts
export function testingFunnelErrors(spec: ExecutionSpecV2): string[] {
  const errors: string[] = [];
  const impacts = spec.cross_cutting_impacts ?? [];
  const commands = new Map(spec.verification_commands.map((command) => [command.id, command]));
  const tests = new Map(spec.tests.map((test) => [test.id, test]));
  const changeUnits = new Set(spec.change_units.map((unit) => unit.id));
  const fileContracts = new Set(spec.file_contract.map((entry) => entry.path));
  const impactOwnedCommands = new Set<string>();
  const commandConsumers = new Set<string>();

  let sawCrossCutting = false;
  let focusedCount = 0;
  for (const command of spec.verification_commands) {
    const tier = effectiveVerificationTier(command);
    if (tier === "cross_cutting") sawCrossCutting = true;
    if (tier === "focused") {
      focusedCount += 1;
      if (sawCrossCutting) errors.push(`${command.id} focused command appears after cross-cutting verification`);
    }
  }
  if (focusedCount === 0) errors.push(`${spec.id} has no focused verification command`);

  for (const impact of impacts) {
    if (!changeUnits.has(impact.change_unit_id)) errors.push(`${impact.change_unit_id} impact references an unknown change unit`);
    if (impact.category === "shared_helper" && impact.callers.length === 0) errors.push(`${impact.change_unit_id} shared_helper impact requires at least one caller`);
    if (impact.representative_fixtures.length === 0) errors.push(`${impact.change_unit_id} cross-cutting impact requires at least one representative fixture`);
    for (const path of [...impact.callers, ...impact.representative_fixtures]) {
      if (!fileContracts.has(path)) errors.push(`${impact.change_unit_id} impact path ${path} is not in file_contract`);
    }
    for (const commandId of impact.verification_command_ids) {
      impactOwnedCommands.add(commandId);
      commandConsumers.add(commandId);
      const command = commands.get(commandId);
      if (!command) errors.push(`${impact.change_unit_id} impact references unknown command ${commandId}`);
      else if (effectiveVerificationTier(command) !== "cross_cutting") errors.push(`${impact.change_unit_id} impact command ${commandId} is not cross_cutting`);
    }
  }

  for (const command of spec.verification_commands) {
    if (effectiveVerificationTier(command) === "cross_cutting" && !impactOwnedCommands.has(command.id)) errors.push(`${command.id} cross-cutting command is not owned by an impact record`);
  }

  for (const criterion of spec.acceptance) {
    const reachable = new Set<string>();
    for (const reference of criterion.satisfied_by) {
      if (commands.has(reference)) {
        reachable.add(reference);
        commandConsumers.add(reference);
      }
      const test = tests.get(reference);
      if (test) {
        for (const commandId of test.verification_command_ids) {
          reachable.add(commandId);
          commandConsumers.add(commandId);
        }
      }
    }
    if (reachable.size === 0) errors.push(`${criterion.id} has no reachable verification command`);
  }

  for (const test of spec.tests) {
    for (const commandId of test.verification_command_ids) commandConsumers.add(commandId);
  }
  for (const command of spec.verification_commands) {
    if (!commandConsumers.has(command.id)) errors.push(`${command.id} verification command is orphaned`);
  }

  return errors;
}

export function assertTestingFunnelReady(spec: ExecutionSpecV2): void {
  const errors = testingFunnelErrors(spec);
  if (errors.length > 0) throw new Error(`Execution spec ${spec.id} has an invalid testing funnel:\n- ${errors.join("\n- ")}`);
}
```

Add the critical-path loop before returning: for each change unit whose path is in `criticalVerificationSurfaces[category]`, require exactly one impact with that `change_unit_id` and category. Also add deterministic duplicate checks for impact `(change_unit_id, category)`, callers, fixtures, and command IDs. A plan that creates a reusable helper must either add its path to the reviewed registry in the same change or classify that change unit as `shared_helper`; make this requirement explicit in the Brain prompt and reviewer tests.

- [ ] **Step 7: Aggregate funnel errors into Spark readiness**

Import `testingFunnelErrors` and append its result immediately before `return errors` in `sparkReadinessErrors`:

```ts
errors.push(...testingFunnelErrors(spec));
return errors;
```

- [ ] **Step 8: Run focused tests and verify GREEN**

Run:

```bash
npx vitest run tests/core/testing-funnel.test.ts tests/core/execution-spec.test.ts
npm run typecheck
```

Expected: PASS, including every critical-path table row.

## Task 3: Propagate funnel metadata through prompts and replans

**Files:**
- Modify: `prompts/brain-plan-v2.md`
- Modify: `prompts/hands-work-item-v2.md`
- Modify: `prompts/verifier-review-v2.md`
- Modify: `prompts/brain-replan-patch-v2.md`
- Modify: `src/core/types.ts:90-115`
- Modify: `src/core/schema.ts:300-340`
- Modify: `src/core/output-schemas.ts:870-930`
- Modify: `src/workflow/replan.ts:235-320, 860-920`
- Test: `tests/workflow/planner.test.ts`
- Test: `tests/workflow/replan.test.ts`
- Test: `tests/workflow/worker.test.ts`
- Test: `tests/workflow/verifier.test.ts`

**Interfaces:**
- Adds: `ReplanPatch.added_cross_cutting_impacts`.
- New replan output requires `tier` on added commands and always returns the impact array.
- Replan application preserves old impact records and appends validated new records.

- [ ] **Step 1: Write failing prompt-contract tests**

Add assertions that rendered prompts contain the exact tokens:

```ts
expect(prompt).toContain("cross_cutting_impacts");
expect(prompt).toContain("focused");
expect(prompt).toContain("cross_cutting");
expect(prompt).toContain("representative_fixtures");
expect(prompt).toContain("Do not use npm test, npm run build, or npm run clean as a work-item verification command");
```

Hands and Verifier tests must assert they receive the approved fields unchanged.

- [ ] **Step 2: Write failing replan schema and application tests**

Extend the valid replan fixture with:

```ts
added_cross_cutting_impacts: [],
```

Add one replan test that adds a tiered cross-cutting command and matching impact and verifies the approved plan contains both. Add rejection tests for an unknown change-unit ID and a focused command referenced by an impact.

- [ ] **Step 3: Run the tests and verify RED**

Run:

```bash
npx vitest run tests/workflow/planner.test.ts tests/workflow/replan.test.ts tests/workflow/worker.test.ts tests/workflow/verifier.test.ts
```

Expected: FAIL on missing prompt text and replan fields.

- [ ] **Step 4: Extend `ReplanPatch` and its schemas**

Add:

```ts
added_cross_cutting_impacts: ExecutionCrossCuttingImpact[];
```

to `ReplanPatch`. In persisted Zod parsing use:

```ts
added_cross_cutting_impacts: z.array(executionCrossCuttingImpactSchema).default([]),
```

This default is allowed for a replan patch because patch application creates a new plan revision; it does not rewrite old approved plan bytes. In structured output, require the array and require `tier` on each added command.

- [ ] **Step 5: Validate and apply replan impacts**

Build the complete candidate work item in memory during `validatePatch`, then call `assertSparkReady(candidate)`. Reuse the same candidate construction during approval. The candidate fields must include:

```ts
cross_cutting_impacts: [
  ...(target.cross_cutting_impacts ?? []),
  ...patch.added_cross_cutting_impacts,
],
verification_commands: [
  ...target.verification_commands,
  ...patch.added_verification_commands,
],
```

- [ ] **Step 6: Update role prompts**

Add these exact requirements:

```text
Brain:
- Give every verification command tier focused or cross_cutting.
- Keep all focused commands before cross_cutting commands.
- Add one cross_cutting_impacts row for every shared helper or critical surface.
- When creating a reusable helper, classify its change unit as shared_helper and enumerate its callers.
- Include callers and representative fixtures as read_only file_contract paths when they are not modified.
- Do not use npm test, npm run build, or npm run clean as a work-item verification command.

Hands:
- Run approved verification commands in listed order.
- Stop after the first failed or timed-out command.
- Caller and fixture paths are compatibility evidence, not edit authorization.

Verifier:
- Reject approval when a required cross-cutting command lacks passing evidence.
- Do not accept a full-suite result as a substitute for missing focused evidence.
```

- [ ] **Step 7: Run focused tests and verify GREEN**

Run:

```bash
npx vitest run tests/workflow/planner.test.ts tests/workflow/replan.test.ts tests/workflow/worker.test.ts tests/workflow/verifier.test.ts
npm run typecheck
```

Expected: PASS.

## Task 4: Add fail-fast verification and runtime adoption

**Files:**
- Modify: `src/verification/runner.ts:18-45, 305-382`
- Modify: `src/workflow/runtime.ts:1788-1805, 2887-2900, 5015-5026, 5617-5628`
- Test: `tests/verification/runner.test.ts`
- Test: `tests/workflow/runtime-local.test.ts`
- Test: `tests/workflow/runtime-github.test.ts`
- Test: `tests/workflow/action-verifier.test.ts`

**Interfaces:**
- Adds: `RunVerificationInput.stopOnFailure?: boolean`.
- New runtime calls pass `true`; absent retains legacy run-all behavior.

- [ ] **Step 1: Write failing runner tests**

Use `process.execPath -e` commands that append markers to a temporary file:

```ts
const commands = [
  [process.execPath, "-e", "process.exit(1)"],
  [process.execPath, "-e", `require("node:fs").appendFileSync(${JSON.stringify(marker)}, "ran")`],
] as const;
```

With `stopOnFailure: true`, assert the evidence contains one command and the marker file does not exist. Without the option, assert both commands are recorded and the marker contains `ran`.

- [ ] **Step 2: Write failing runtime tests**

Capture `RunVerificationInput` calls and assert every new quality-gate, work-item, and integrated call contains `stopOnFailure: true`. Add a focused-failure fixture and assert no integrated verification invocation occurs.

- [ ] **Step 3: Run focused tests and verify RED**

Run:

```bash
npx vitest run tests/verification/runner.test.ts tests/workflow/runtime-local.test.ts tests/workflow/runtime-github.test.ts
```

Expected: FAIL because the runner ignores `stopOnFailure` and runtime does not supply it.

- [ ] **Step 4: Implement fail-fast after evidence persistence**

Add to `RunVerificationInput`:

```ts
/** Stop after persisting the first failed or timed-out command. */
stopOnFailure?: boolean;
```

After `commands.push(...)`, add:

```ts
const failed = result.exitCode !== 0 || result.timedOut;
if (input.stopOnFailure === true && failed) break;
```

Do not place the break before stdout, stderr, and result JSON writes.

- [ ] **Step 5: Opt runtime verification into fail-fast behavior**

Add `stopOnFailure: true` to every `verificationRunner` invocation in the v2 runtime, including post-PR and final integrated verification. Do not change the injected dependency signature.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run:

```bash
npx vitest run tests/verification/runner.test.ts tests/workflow/runtime-local.test.ts tests/workflow/runtime-github.test.ts tests/workflow/action-verifier.test.ts
npm run typecheck
```

Expected: PASS. The failure artifact exists and later commands do not run.

## Task 5: Document and verify the contract/runtime subsystem

**Files:**
- Modify: `README.md:787-861`
- Modify: `agentic-codex-workflow.md:500-680`
- Modify: `docs/superpowers/specs/2026-07-16-layered-testing-funnel-design.md` only if implementation reveals a contradiction
- Test: all contract/runtime tests

**Interfaces:**
- Documents traceability and compatibility behavior.
- Produces an independently green repository before built-CLI funnel work starts.

- [ ] **Step 1: Update maintainer documentation**

Document this exact chain:

```text
change unit
  -> acceptance criterion
  -> focused test/command
  -> optional required cross-cutting impact
  -> cross-cutting command
```

Explain that narrative files use ordinary file authorization, legacy missing tiers default to focused, and new plans require explicit tiers.

- [ ] **Step 2: Run the complete subsystem suite**

Run:

```bash
npx vitest run \
  tests/core/execution-spec.test.ts \
  tests/core/testing-funnel.test.ts \
  tests/core/schema.test.ts \
  tests/workflow/planner.test.ts \
  tests/workflow/replan.test.ts \
  tests/workflow/worker.test.ts \
  tests/workflow/verifier.test.ts \
  tests/verification/runner.test.ts \
  tests/workflow/runtime-local.test.ts \
  tests/workflow/runtime-github.test.ts \
  tests/workflow/action-verifier.test.ts
npm run typecheck
git diff --check
```

Expected: every command exits 0.

- [ ] **Step 3: Inspect scope manually**

Run:

```bash
git diff --stat
git status --short
```

Expected: only files named in this plan are changed. Do not stage or commit unless the user separately asks.

## Plan Self-Review

- Spec coverage: narrative authorization, acceptance-command reachability, shared callers, representative fixtures, focused order, cross-cutting order, critical surfaces, fail-fast execution, replan compatibility, and legacy recovery are assigned to tasks.
- Deliberate exclusions: build/`dist/` lifecycle and remote synchronization are in their own plans.
- Type consistency: `VerificationTier`, `CrossCuttingCategory`, `ExecutionCrossCuttingImpact`, `cross_cutting_impacts`, `added_cross_cutting_impacts`, and `stopOnFailure` use one spelling throughout.
- No product implementation begins until this plan is explicitly selected for execution.
