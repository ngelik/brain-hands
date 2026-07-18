# Bounded Hands Backup and Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one opt-in Hands backup profile that takes over after a confirmed primary usage limit or performs one quality-recovery attempt after three actionable rejected fixes.

**Architecture:** Add strict configuration and manifest contracts, a Codex model-catalog adapter, an allowlisted usage-limit classifier, and a pure Hands retry policy. The v2 runtime will persist every logical attempt and invocation, route completed verification failures through the Verifier, and reuse one invocation helper across work-item, integrated, and post-PR loops. GitHub mode will upsert one marker-delimited status comment from ledger state.

**Tech Stack:** TypeScript 6, Node.js 20+, Zod 4, YAML, Commander, Vitest, Codex CLI, GitHub CLI.

## Global Constraints

- The initial implementation is not a fix attempt.
- Allow at most three primary fix attempts per work item and one quality-recovery attempt per work item.
- The backup profile is opt-in; omitting `retry_policy.backup` preserves the existing cost ceiling.
- Only Hands may fall back. Brain, Verifier, and reflection retain their configured profiles.
- Automatic availability fallback requires a confirmed account or model usage-exhaustion signal; transient rate limits, authentication failures, generic quota text, and ambiguous non-zero exits block.
- A confirmed usage-limited primary invocation does not consume a logical implementation or fix attempt.
- Once availability fallback activates, `active_hands_profile` remains `backup` for the rest of the run and primary is not probed again.
- If backup is already active, quality exhaustion blocks with `escalation_exhausted`; there is no second fallback.
- Quality recovery uses backup for one attempt only and does not change the active run route.
- Every invocation records exact model, reasoning effort, profile kind, trigger, artifact paths, and outcome.
- Catalog validation must match the exact model slug and requested reasoning effort from `codex debug models`.
- Never substitute a model or lower reasoning effort.
- Completed verification failures must reach Verifier classification; operational failures before usable evidence remain deterministic blockers.
- Recovery cannot change approved scope, acceptance criteria, or the plan.
- Started state is recorded in `events.jsonl` and the manifest. Final attempt and invocation artifacts are written once and never overwritten.
- Legacy v1 review/fix commands retain their existing retry semantics; this feature is confined to the v2 runtime.

---

## File Structure

**Create:**

- `src/adapters/model-catalog.ts` — parse `codex debug models`, validate an exact model/reasoning pair, and return an auditable selection.
- `src/workflow/hands-recovery.ts` — pure retry decisions, backup eligibility, attempt types, recovery context construction, and status rendering input.
- `tests/adapters/model-catalog.test.ts` — catalog parsing and exact-match validation.
- `tests/workflow/hands-recovery.test.ts` — retry state-machine, bounded context, and attempt provenance tests.
- `prompts/hands-recovery-v2.md` — independent-diagnosis instructions for quality recovery and usage-limit continuation.

**Modify:**

- `src/core/types.ts`, `src/core/schema.ts`, `src/core/config.ts`, `src/core/ledger.ts` — backup policy, verifier classification, route state, and attempt provenance contracts.
- `src/core/output-schemas.ts`, `prompts/verifier-review-v2.md` — require failure classification and blocker semantics.
- `src/adapters/codex.ts` — expose exact subprocess failure data and classify confirmed usage exhaustion.
- `src/workflow/preflight.ts` — validate primary and configured backup profiles from the Codex catalog.
- `src/workflow/worker.ts`, `prompts/hands-work-item-v2.md` — explicit profile selection and diagnostic context.
- `src/workflow/verifier.ts` — accept failed verification evidence and enforce the expanded review contract.
- `src/workflow/runtime.ts`, `src/cli.ts` — pass configuration, persist attempt state, run fallback/recovery, and replace hard-coded Verifier-pass limits.
- `src/adapters/github.ts`, `src/workflow/status.ts` — upsert and render durable model-attempt status.
- `README.md`, `agentic-codex-workflow.md` — configuration, state machine, cost ceiling, and blocker behavior.
- Tests under `tests/core/`, `tests/adapters/`, and `tests/workflow/` named in each task.

---

### Task 1: Add Strict Backup, Route, and Attempt Contracts

**Files:**

- Modify: `src/core/types.ts`
- Modify: `src/core/schema.ts`
- Modify: `src/core/config.ts`
- Modify: `src/core/ledger.ts`
- Test: `tests/core/config.test.ts`
- Test: `tests/core/schema.test.ts`
- Test: `tests/core/ledger.test.ts`
- Test: `tests/core/intake.test.ts`

**Interfaces:**

- Produces: `HandsBackupPolicy`, `HandsProfileKind`, `BackupActivationReason`, `RecoveryState`, `VerificationFailureClass`, `HandsAttemptKind`, `HandsAttemptRecord`, and manifest route fields.
- Produces: `ConfigV2.retry_policy.backup?: HandsBackupPolicy`.
- Consumes: existing `RoleProfile`, `ReasoningEffort`, `RunManifestV2`, and `workItemProgressSchema`.

- [ ] **Step 1: Write failing configuration and manifest tests**

Add these assertions to `tests/core/config.test.ts` and `tests/core/schema.test.ts`:

```ts
it("parses one opt-in Hands backup profile", async () => {
  const config = configV2Schema.parse({
    ...defaultConfig(),
    retry_policy: {
      max_hands_fix_attempts: 3,
      max_replan_attempts: 2,
      backup: {
        fallback_on_primary_usage_limit: true,
        max_quality_recovery_attempts: 1,
        profile: { model: "backup-model", reasoning_effort: "medium" },
      },
    },
  });
  expect(config.retry_policy.backup?.profile.model).toBe("backup-model");
});

it.each([0, 2])("rejects %i quality recovery attempts", (maxAttempts) => {
  expect(() => configV2Schema.parse({
    ...defaultConfig(),
    retry_policy: {
      max_hands_fix_attempts: 3,
      max_replan_attempts: 2,
      backup: {
        fallback_on_primary_usage_limit: true,
        max_quality_recovery_attempts: maxAttempts,
        profile: { model: "backup-model", reasoning_effort: "medium" },
      },
    },
  })).toThrow();
});

it("keeps backup absent in the package default", () => {
  expect(defaultConfig().retry_policy.backup).toBeUndefined();
});
```

Add a ledger test that creates a v2 run and asserts:

```ts
expect(manifest.active_hands_profile).toBe("primary");
expect(manifest.backup_activation_reason).toBeNull();
expect(manifest.work_item_progress).toEqual({});
```

- [ ] **Step 2: Run the focused tests and verify contract failures**

Run: `npx vitest run tests/core/config.test.ts tests/core/schema.test.ts tests/core/ledger.test.ts tests/core/intake.test.ts`

Expected: FAIL because backup policy and manifest route fields do not exist.

- [ ] **Step 3: Add the exact TypeScript contracts**

Add to `src/core/types.ts`:

```ts
export interface HandsBackupPolicy {
  fallback_on_primary_usage_limit: boolean;
  max_quality_recovery_attempts: 1;
  profile: {
    model: string;
    reasoning_effort: ReasoningEffort;
  };
}

export type HandsProfileKind = "primary" | "backup";
export type BackupActivationReason = "primary_usage_limit" | null;
export type RecoveryState = "not_eligible" | "eligible" | "pending" | "in_progress" | "approved" | "exhausted";
export type HandsAttemptKind = "initial" | "primary_fix" | "quality_recovery";
export type HandsInvocationOutcome = "completed" | "primary_usage_limit" | "operational_blocker";
export type HandsBlockerCode =
  | "operational_blocker"
  | "test_infrastructure_blocker"
  | "backup_profile_unavailable"
  | "primary_usage_limit_no_backup"
  | "ambiguous_hands_invocation"
  | "escalation_exhausted";
export type VerificationFailureClass =
  | "none"
  | "implementation_failure"
  | "operational_blocker"
  | "test_infrastructure_blocker"
  | "replan_required";

export interface HandsInvocationRecord {
  profile: HandsProfileKind;
  model: string;
  reasoning_effort: ReasoningEffort;
  outcome: HandsInvocationOutcome;
  budget_consumed: boolean;
  prompt_path: string;
  stdout_path: string;
  stderr_path: string;
}

export interface HandsAttemptRecord {
  work_item_id: string;
  ordinal: number;
  kind: HandsAttemptKind;
  trigger_review_path: string | null;
  invocations: HandsInvocationRecord[];
  implementation_path: string | null;
  verification_path: string | null;
  review_path: string | null;
  failure_class: VerificationFailureClass | null;
  outcome: "approve" | "request_changes" | "blocked" | "replan_required";
}
```

Extend both v2 config types with `backup?: HandsBackupPolicy`. Add explicit fields to `WorkItemProgress`:

```ts
primary_fix_attempts?: number;
quality_recovery_attempts?: number;
recovery_state?: RecoveryState;
last_attempt_path?: string;
blocker_code?: HandsBlockerCode;
```

Add to `RunManifestV2`:

```ts
active_hands_profile: HandsProfileKind;
backup_activation_reason: BackupActivationReason;
```

- [ ] **Step 4: Add strict Zod schemas and ledger defaults**

In `src/core/schema.ts`, define:

```ts
export const handsBackupPolicySchema = z.object({
  fallback_on_primary_usage_limit: z.boolean().default(false),
  max_quality_recovery_attempts: z.literal(1),
  profile: z.object({
    model: z.string().min(1),
    reasoning_effort: reasoningEffortV2Schema,
  }).strict(),
}).strict();
```

Add `backup: handsBackupPolicySchema.optional()` to `configV2Schema.retry_policy`. Add optional progress counters and recovery state to `workItemProgressSchema`. Add these required manifest defaults:

```ts
active_hands_profile: z.enum(["primary", "backup"]).default("primary"),
backup_activation_reason: z.literal("primary_usage_limit").nullable().default(null),
```

Initialize the same values in `createRunLedgerV2()` and leave `defaultConfig().retry_policy.backup` absent. `persistedConfig()` already copies `retry_policy`; keep that single serialization path.

- [ ] **Step 5: Run focused tests and typecheck**

Run: `npx vitest run tests/core/config.test.ts tests/core/schema.test.ts tests/core/ledger.test.ts tests/core/intake.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 6: Commit the contracts**

```bash
git add src/core/types.ts src/core/schema.ts src/core/config.ts src/core/ledger.ts tests/core/config.test.ts tests/core/schema.test.ts tests/core/ledger.test.ts tests/core/intake.test.ts
git commit -m "feat: add Hands backup policy contracts"
```

---

### Task 2: Validate Exact Model Profiles from the Codex Catalog

**Files:**

- Create: `src/adapters/model-catalog.ts`
- Create: `tests/adapters/model-catalog.test.ts`
- Modify: `src/workflow/preflight.ts`
- Modify: `src/core/types.ts`
- Test: `tests/workflow/preflight.test.ts`

**Interfaces:**

- Produces: `readModelCatalog(input): Promise<ModelCatalogSnapshot>`.
- Produces: `validateCatalogProfile(snapshot, profile, label): ModelCatalogSelection`.
- Consumes: `HandsBackupPolicy.profile`, `runCommand`, and `PreflightCheck`.

- [ ] **Step 1: Write catalog parser and exact-match tests**

Create `tests/adapters/model-catalog.test.ts` with fixtures shaped like the real CLI output:

```ts
const catalog = {
  models: [{
    slug: "backup-model",
    display_name: "Backup Model",
    supported_reasoning_levels: [
      { effort: "low", description: "Fast" },
      { effort: "medium", description: "Balanced" },
    ],
    visibility: "list",
  }],
};

it("accepts an exact slug and reasoning effort", () => {
  const selected = validateCatalogProfile(catalog, {
    model: "backup-model",
    reasoning_effort: "medium",
  }, "Hands backup");
  expect(selected).toMatchObject({ slug: "backup-model", reasoning_effort: "medium" });
});

it("rejects a missing slug without substitution", () => {
  expect(() => validateCatalogProfile(catalog, {
    model: "nearby-model",
    reasoning_effort: "medium",
  }, "Hands backup")).toThrow("Hands backup model nearby-model is absent");
});

it("rejects an unsupported reasoning effort without downgrade", () => {
  expect(() => validateCatalogProfile(catalog, {
    model: "backup-model",
    reasoning_effort: "high",
  }, "Hands backup")).toThrow("does not support reasoning effort high");
});
```

- [ ] **Step 2: Run the new test and verify it fails**

Run: `npx vitest run tests/adapters/model-catalog.test.ts`

Expected: FAIL because `src/adapters/model-catalog.ts` does not exist.

- [ ] **Step 3: Implement the catalog adapter**

Create exact public contracts:

```ts
export interface ModelCatalogSnapshot {
  models: Array<{
    slug: string;
    display_name?: string;
    supported_reasoning_levels: Array<{ effort: string; description?: string }>;
    visibility?: string;
  }>;
}

export interface ModelCatalogSelection {
  slug: string;
  reasoning_effort: ReasoningEffort;
  supported_reasoning_efforts: string[];
}

export async function readModelCatalog(input: {
  command: string;
  cwd: string;
  timeoutMs: number;
}): Promise<{ snapshot: ModelCatalogSnapshot; commandResult: CommandResult }>;

export function validateCatalogProfile(
  snapshot: ModelCatalogSnapshot,
  profile: { model: string; reasoning_effort: ReasoningEffort },
  label: string,
): ModelCatalogSelection;
```

`readModelCatalog()` must run `["debug", "models"]`, require exit code `0`, parse one top-level object containing `models`, and reject malformed entries. `validateCatalogProfile()` must use exact string equality for `slug` and `effort`.

- [ ] **Step 4: Add required preflight checks for primary and configured backup**

In `runPreflight()`, always inspect the catalog for the primary Hands profile. When `config.retry_policy.backup` exists, validate its profile in the same catalog snapshot. Append one required check with args `["debug", "models"]`; store compact JSON containing the selected entries in `stdout` and the validation error in `stderr`.

Add preflight tests asserting:

```ts
expect(result.required_checks_failed).toBe(false);
expect(result.checks.find((check) => check.args.join(" ") === "debug models")?.stdout)
  .toContain("backup-model");
```

and an unavailable backup case asserting `required_checks_failed === true` and no model substitution.

- [ ] **Step 5: Run catalog and preflight tests**

Run: `npx vitest run tests/adapters/model-catalog.test.ts tests/workflow/preflight.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 6: Commit catalog validation**

```bash
git add src/adapters/model-catalog.ts src/workflow/preflight.ts src/core/types.ts tests/adapters/model-catalog.test.ts tests/workflow/preflight.test.ts
git commit -m "feat: validate configured Codex model profiles"
```

---

### Task 3: Classify Only Confirmed Primary Usage Exhaustion

**Files:**

- Modify: `src/adapters/codex.ts`
- Test: `tests/adapters/codex.test.ts`

**Interfaces:**

- Produces: `CodexFailureKind = "primary_usage_limit" | "other"`.
- Produces: `classifyCodexFailure(result: CommandResult): CodexFailureKind`.
- Consumes: `CodexInvocationError.result` from failed subprocess calls.

- [ ] **Step 1: Write an allowlist classifier test matrix**

Add to `tests/adapters/codex.test.ts`:

```ts
function commandFailure(stderr: string): CommandResult {
  return {
    command: "codex",
    args: ["exec"],
    exitCode: 1,
    stdout: "",
    stderr,
    failed: true,
    timedOut: false,
    signal: null,
  };
}

it.each([
  { stderr: '{"error":{"code":"usage_limit_reached"}}', expected: "primary_usage_limit" },
  { stderr: "You've hit your usage limit. Try again after 3:15 PM.", expected: "primary_usage_limit" },
  { stderr: "rate limit exceeded; retry in 10 seconds", expected: "other" },
  { stderr: "authentication failed", expected: "other" },
  { stderr: "quota problem", expected: "other" },
  { stderr: "", expected: "other" },
])("classifies $stderr as $expected", ({ stderr, expected }) => {
  expect(classifyCodexFailure(commandFailure(stderr))).toBe(expected);
});
```

The helper deliberately leaves `errorCode` and `errorMessage` absent so classification depends only on explicit provider output.

- [ ] **Step 2: Run the classifier tests and verify they fail**

Run: `npx vitest run tests/adapters/codex.test.ts`

Expected: FAIL because `classifyCodexFailure` is not exported.

- [ ] **Step 3: Implement fail-closed classification**

Add:

```ts
export type CodexFailureKind = "primary_usage_limit" | "other";

const USAGE_LIMIT_CODES = new Set([
  "usage_limit_reached",
  "credits_exhausted",
  "insufficient_quota",
]);

export function classifyCodexFailure(result: CommandResult): CodexFailureKind {
  const combined = `${result.stdout}\n${result.stderr}`.trim();
  if (/rate limit/i.test(combined)) return "other";
  try {
    const parsed = JSON.parse(combined) as { error?: { code?: unknown } };
    if (typeof parsed.error?.code === "string" && USAGE_LIMIT_CODES.has(parsed.error.code)) {
      return "primary_usage_limit";
    }
  } catch {
    if (/you(?:'ve| have) hit your usage limit(?:\.|\s|$)/i.test(combined)) {
      return "primary_usage_limit";
    }
  }
  return "other";
}
```

Keep `CodexInvocationError.result` and artifact paths unchanged so runtime can classify and audit the failure. Do not classify schema-validation failures as usage exhaustion.

- [ ] **Step 4: Run adapter tests and typecheck**

Run: `npx vitest run tests/adapters/codex.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit the classifier**

```bash
git add src/adapters/codex.ts tests/adapters/codex.test.ts
git commit -m "feat: classify confirmed Codex usage exhaustion"
```

---

### Task 4: Make Verifier Classify Failed Evidence

**Files:**

- Modify: `src/core/types.ts`
- Modify: `src/core/schema.ts`
- Modify: `src/core/output-schemas.ts`
- Modify: `prompts/verifier-review-v2.md`
- Modify: `src/workflow/verifier.ts`
- Test: `tests/core/schema.test.ts`
- Test: `tests/workflow/verifier.test.ts`
- Modify fixtures: `tests/workflow/runtime-local.test.ts`
- Modify fixtures: `tests/workflow/runtime-github.test.ts`
- Modify fixtures: `tests/workflow/reflection.test.ts`

**Interfaces:**

- Consumes: `VerificationFailureClass` from Task 1.
- Produces: expanded `VerifierReview` classification fields and decision variants.
- Consumes: saved successful or failed `VerificationEvidence`.
- Produces decisions: `approve`, `request_changes`, `blocked`, or `replan_required`.

- [ ] **Step 1: Write strict Verifier contract tests**

Add cases to `tests/core/schema.test.ts` for these valid pairs:

```ts
const finding = {
  severity: "medium" as const,
  file: "src/example.ts",
  line: 10,
  acceptance_criterion: "The example returns the expected value",
  problem: "The implementation returns the wrong value",
  required_fix: "Return the expected value",
  re_verification: [["npm", "test", "--", "example.test.ts"]],
};

const validPairs = [
  { decision: "approve", failure_class: "none", blocker: null, findings: [] },
  { decision: "request_changes", failure_class: "implementation_failure", blocker: null, findings: [finding] },
  { decision: "blocked", failure_class: "operational_blocker", blocker: "test runner unavailable", findings: [] },
  { decision: "blocked", failure_class: "test_infrastructure_blocker", blocker: "fixture service is down", findings: [] },
  { decision: "replan_required", failure_class: "replan_required", blocker: null, findings: [] },
] as const;
```

Add invalid cases proving that `request_changes` cannot omit findings or re-verification commands, `blocked` cannot contain code findings, and `approve` cannot carry a failure classification.

- [ ] **Step 2: Run schema and Verifier tests and verify failures**

Run: `npx vitest run tests/core/schema.test.ts tests/workflow/verifier.test.ts`

Expected: FAIL because the review schema lacks `failure_class`, `blocker`, and `blocked`.

- [ ] **Step 3: Implement the expanded review contract**

Use the `VerificationFailureClass` union created in Task 1 and replace `VerifierReview` with:

```ts
export interface VerifierReview {
  work_item_id: string;
  attempt: number;
  final: boolean;
  decision: "approve" | "request_changes" | "blocked" | "replan_required";
  failure_class: VerificationFailureClass;
  blocker: string | null;
  acceptance_coverage: string[];
  evidence_reviewed: string[];
  findings: VerifierFinding[];
  residual_risks: string[];
}
```

Update the Zod and JSON output schemas with discriminated refinements matching the valid pairs. Change each `re_verification` array for a `request_changes` finding to require at least one command.

- [ ] **Step 4: Update the Verifier prompt and fixtures**

Add explicit prompt rules:

```md
Classify the result before deciding:
- `approve` + `none`: all acceptance criteria pass.
- `request_changes` + `implementation_failure`: code or product behavior is wrong; include concrete findings and re-verification commands.
- `blocked` + `operational_blocker`: usable verification could not complete for an operational reason.
- `blocked` + `test_infrastructure_blocker`: the harness, fixture, or required external test service is broken independently of the implementation.
- `replan_required` + `replan_required`: approved scope or architecture must change.

Do not classify transient infrastructure failure as an implementation defect.
```

Update every `VerifierReview` factory in the listed tests so approved reviews include `failure_class: "none"` and `blocker: null`; request-change fixtures include `failure_class: "implementation_failure"`, `blocker: null`, and at least one re-verification command.

- [ ] **Step 5: Run all review consumers**

Run: `npx vitest run tests/core/schema.test.ts tests/workflow/verifier.test.ts tests/workflow/runtime-local.test.ts tests/workflow/runtime-github.test.ts tests/workflow/reflection.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 6: Commit Verifier classification**

```bash
git add src/core/types.ts src/core/schema.ts src/core/output-schemas.ts prompts/verifier-review-v2.md src/workflow/verifier.ts tests/core/schema.test.ts tests/workflow/verifier.test.ts tests/workflow/runtime-local.test.ts tests/workflow/runtime-github.test.ts tests/workflow/reflection.test.ts
git commit -m "feat: classify verification failures"
```

---

### Task 5: Add the Pure Retry Policy and Bounded Recovery Packet

**Files:**

- Create: `src/workflow/hands-recovery.ts`
- Create: `tests/workflow/hands-recovery.test.ts`
- Create: `prompts/hands-recovery-v2.md`

**Interfaces:**

- Produces: `decideNextHandsAction(input): HandsRecoveryAction`.
- Produces: `buildHandsRecoveryPacket(input): string`.
- Produces: `attemptArtifactPath(workItemId, ordinal): string`.
- Consumes: `VerifierReview`, `HandsBackupPolicy`, `HandsAttemptRecord`, and current route state.

- [ ] **Step 1: Write state-machine tests for every terminal and retry path**

Create tests asserting:

```ts
const configuredBackup: HandsBackupPolicy = {
  fallback_on_primary_usage_limit: true,
  max_quality_recovery_attempts: 1,
  profile: { model: "backup-model", reasoning_effort: "medium" },
};
const implementationFailureReview: VerifierReview = {
  work_item_id: "item-1",
  attempt: 1,
  final: false,
  decision: "request_changes",
  failure_class: "implementation_failure",
  blocker: null,
  acceptance_coverage: [],
  evidence_reviewed: ["verification/issue-1/attempt-1/evidence.json"],
  findings: [{
    severity: "medium",
    file: "src/item.ts",
    line: 10,
    acceptance_criterion: "The item works",
    problem: "The item fails",
    required_fix: "Correct the item",
    re_verification: [["npm", "test", "--", "item.test.ts"]],
  }],
  residual_risks: [],
};

expect(decideNextHandsAction({
  review: implementationFailureReview,
  primaryFixAttempts: 0,
  qualityRecoveryAttempts: 0,
  activeProfile: "primary",
  backup: configuredBackup,
})).toEqual({ kind: "primary_fix", profile: "primary" });

expect(decideNextHandsAction({
  review: implementationFailureReview,
  primaryFixAttempts: 3,
  qualityRecoveryAttempts: 0,
  activeProfile: "primary",
  backup: configuredBackup,
})).toEqual({ kind: "quality_recovery", profile: "backup" });

expect(decideNextHandsAction({
  review: implementationFailureReview,
  primaryFixAttempts: 3,
  qualityRecoveryAttempts: 0,
  activeProfile: "backup",
  backup: configuredBackup,
})).toEqual({ kind: "block", blockerCode: "escalation_exhausted" });
```

Also cover approve, blocked, replan, absent backup, and consumed quality recovery.

- [ ] **Step 2: Write bounded packet and artifact-path tests**

Assert the packet contains approved criteria, scope exclusions, current diff, latest findings, attempt summaries, and evidence paths. Assert it does not include supplied raw transcript bodies. Assert unsafe work-item IDs become safe path components.

- [ ] **Step 3: Run the new tests and verify they fail**

Run: `npx vitest run tests/workflow/hands-recovery.test.ts`

Expected: FAIL because the recovery module does not exist.

- [ ] **Step 4: Implement exact policy types and decisions**

Create:

```ts
export type HandsRecoveryAction =
  | { kind: "approve" }
  | { kind: "primary_fix"; profile: "primary" | "backup" }
  | { kind: "quality_recovery"; profile: "backup" }
  | { kind: "block"; blockerCode: HandsBlockerCode }
  | { kind: "replan" };

export interface DecideNextHandsActionInput {
  review: VerifierReview;
  primaryFixAttempts: number;
  qualityRecoveryAttempts: number;
  activeProfile: HandsProfileKind;
  backup: HandsBackupPolicy | undefined;
}
```

Decision order must be approve, replan, classified blocker, primary fix while count is below three, quality recovery only when primary remains active and backup is configured, otherwise `escalation_exhausted`.

- [ ] **Step 5: Implement the bounded recovery packet**

Define `BuildHandsRecoveryPacketInput` with exact fields: `workItem`, `currentDiff`, `latestFindings`, `attempts`, and `verificationPaths`. Render JSON sections under fixed Markdown headings and include this instruction:

```md
Form an independent diagnosis from the approved criteria, current diff, unresolved findings, and saved evidence. Do not repeat a prior edit without explaining why the evidence supports it. Do not widen scope.
```

Cap `currentDiff` at 24,000 bytes and the total rendered packet at 32,000 bytes. Include artifact paths and attempt summaries, never response stdout/stderr contents.

- [ ] **Step 6: Run recovery tests and typecheck**

Run: `npx vitest run tests/workflow/hands-recovery.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 7: Commit the policy and packet**

```bash
git add src/workflow/hands-recovery.ts tests/workflow/hands-recovery.test.ts prompts/hands-recovery-v2.md
git commit -m "feat: add bounded Hands recovery policy"
```

---

### Task 6: Make Hands Invocations Profile-Aware and Auditable

**Files:**

- Modify: `src/workflow/worker.ts`
- Modify: `prompts/hands-work-item-v2.md`
- Modify: `src/prompts/loader.ts`
- Test: `tests/workflow/worker.test.ts`

**Interfaces:**

- Consumes: `HandsAttemptKind`, `HandsProfileKind`, the model/reasoning portion of `RoleProfile`, and optional diagnostic context.
- Produces: distinct invocation artifacts per logical attempt and profile.
- Preserves: one implementation report path per successful logical attempt.

- [ ] **Step 1: Write profile-selection and artifact-collision tests**

Add tests invoking the same ordinal once as primary and once as backup. Assert recorded adapter inputs are:

```ts
expect(invocations.map(({ model, reasoningEffort }) => ({ model, reasoningEffort }))).toEqual([
  { model: "primary-model", reasoningEffort: "xhigh" },
  { model: "backup-model", reasoningEffort: "medium" },
]);
expect(invocations[1].prompt).toContain("Form an independent diagnosis");
expect(invocations[0].artifactName).not.toBe(invocations[1].artifactName);
```

- [ ] **Step 2: Run worker tests and verify they fail**

Run: `npx vitest run tests/workflow/worker.test.ts`

Expected: FAIL because `runHandsWorkItem()` always uses `intake.roles.hands`.

- [ ] **Step 3: Extend the worker input without implicit fallback**

Add fields:

```ts
profile?: Pick<RoleProfile, "model" | "reasoning_effort">;
profileKind?: HandsProfileKind;
attemptKind?: HandsAttemptKind;
diagnosticContext?: string;
```

Resolve `profile` to `input.profile ?? input.intake.roles.hands`. Use artifact name:

```ts
const profileKind = input.profileKind ?? "primary";
const attemptKind = input.attemptKind ?? (attempt === 1 ? "initial" : "primary_fix");
const artifactName = `hands-work-item-${id}-attempt-${attempt}-${attemptKind}-${profileKind}`;
```

Select `hands-recovery-v2` when `attemptKind === "quality_recovery"` or diagnostic context is non-empty; otherwise keep `hands-work-item-v2`. Add `{{diagnostic_context}}` to both templates. The worker must never choose backup on its own.

- [ ] **Step 4: Run worker tests and typecheck**

Run: `npx vitest run tests/workflow/worker.test.ts tests/prompts/renderer.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit profile-aware Hands calls**

```bash
git add src/workflow/worker.ts prompts/hands-work-item-v2.md src/prompts/loader.ts tests/workflow/worker.test.ts tests/prompts/renderer.test.ts
git commit -m "feat: make Hands attempts profile aware"
```

---

### Task 7: Integrate Primary Fixes, Usage Fallback, and Recovery into Work-Item Runtime

**Files:**

- Modify: `src/workflow/runtime.ts`
- Modify: `src/cli.ts`
- Modify: `src/core/ledger.ts`
- Test: `tests/workflow/runtime-local.test.ts`
- Test: `tests/workflow/e2e-dry-run.test.ts`
- Test: `tests/cli-smoke.test.ts`

**Interfaces:**

- Consumes: `ConfigV2`, `decideNextHandsAction`, `classifyCodexFailure`, `validateCatalogProfile`, and profile-aware `runHandsWorkItem`.
- Produces: immutable files under `attempts/<work-item>/attempt-<ordinal>.json` and catalog revalidation artifacts under `catalog/`.
- Changes: `RunLocalWorkflowInput.config` becomes required; `executeApprovedRun()` passes the loaded config.

- [ ] **Step 1: Write failing count and route tests**

Add runtime tests proving these call sequences:

```ts
expect(handsCalls).toEqual([
  "initial:primary",
  "primary_fix:primary",
  "primary_fix:primary",
  "primary_fix:primary",
  "quality_recovery:backup",
]);
expect(verifierCalls).toHaveLength(5);
```

Add a confirmed usage-limit case where the first primary invocation throws `CodexInvocationError` with `usage_limit_reached`; assert backup retries ordinal one, only one logical attempt is counted, and every later Hands call uses backup.

Add negative cases for rate limit, auth error, backup usage limit, absent backup, and catalog revalidation failure. Assert each blocks and never invokes another model. Assert absent backup records `primary_usage_limit_no_backup`, catalog mismatch records `backup_profile_unavailable`, and an interrupted invocation without a terminal artifact records `ambiguous_hands_invocation`.

- [ ] **Step 2: Write failed-verification routing and resume tests**

Return verification evidence with exit code `1` and assert Verifier receives it. Return `blocked + test_infrastructure_blocker` and assert no fix attempt is consumed. Interrupt after `backup_activated` and resume; assert primary is not called and backup is invoked once for the persisted ordinal.

- [ ] **Step 3: Run runtime tests and verify current semantics fail**

Run: `npx vitest run tests/workflow/runtime-local.test.ts tests/workflow/e2e-dry-run.test.ts tests/cli-smoke.test.ts`

Expected: FAIL because runtime hard-codes three Verifier passes, blocks before Verifier on failed commands, and has no backup route.

- [ ] **Step 4: Pass configuration into the v2 runtime**

Change `RunLocalWorkflowInput`:

```ts
config: ConfigV2;
```

Remove `maxVerifierPasses`. In `executeApprovedRun()`, pass the loaded `config` into both local and GitHub runtime inputs. Update direct runtime tests to use `defaultConfig()` or a configured backup fixture.

- [ ] **Step 5: Add one persisted Hands invocation boundary**

Implement a private `invokeHandsAttempt()` in `runtime.ts` with this contract:

```ts
interface InvokeHandsAttemptInput {
  item: WorkItem;
  ordinal: number;
  kind: HandsAttemptKind;
  findings: VerifierFinding[];
  triggerReviewPath: string | null;
  diagnosticContext: string;
}

interface InvokeHandsAttemptResult {
  result: HandsWorkItemResult;
  invocationPaths: string[];
  profile: HandsProfileKind;
}
```

The helper must:

1. Append an invocation-started event and persist current ordinal/kind in progress.
2. Resolve primary or globally active backup explicitly.
3. On primary `primary_usage_limit`, require configured fallback, re-run `codex debug models`, persist the selected catalog entry, persist route activation, snapshot the current diff, and retry the same ordinal on backup.
4. On every other error, call `recordRuntimeBlocker()` without consuming the logical attempt.
5. After a valid Hands result, persist its implementation and response paths in progress but do not increment a logical counter yet. Do not write the final attempt artifact until verification and Verifier review are both persisted.

- [ ] **Step 6: Replace the per-item pass loop with policy decisions**

After every Verifier review call:

```ts
const action = decideNextHandsAction({
  review: reviewResult.review,
  primaryFixAttempts: progress.primary_fix_attempts ?? 0,
  qualityRecoveryAttempts: progress.quality_recovery_attempts ?? 0,
  activeProfile: manifest.active_hands_profile,
  backup: input.config.retry_policy.backup,
});
```

After Verifier returns, determine budget consumption before calling `decideNextHandsAction()`: initial implementations never consume a fix; classified operational or test-infrastructure blockers consume no fix; a primary fix with a usable approve, request-changes, or replan review increments `primary_fix_attempts`; a quality-recovery fix with a usable review increments `quality_recovery_attempts`. Write the final logical attempt artifact exactly once with those budget decisions and the invocation, implementation, verification, and review paths. Then route `approve`, `replan`, classified blockers, `primary_fix`, and `quality_recovery` exactly. For quality recovery, revalidate backup, build and persist the bounded recovery packet, transition progress through `eligible`, `pending`, and `in_progress`, and invoke ordinal five with backup. A rejected quality recovery sets `blocker_code: "escalation_exhausted"`, `recovery_state: "exhausted"`, and `delivery_state: "blocked"`.

Delete the early return driven by `verificationFailureReasons()`. Persist evidence and let Verifier classify completed command, artifact, and browser failures.

- [ ] **Step 7: Make resume fail closed at every invocation boundary**

On resume:

- A final attempt artifact is consumed without reinvocation.
- A persisted `primary_usage_limit` activation with no backup result resumes backup at the same ordinal.
- A started invocation with neither a classified usage-limit artifact nor a final result blocks as ambiguous.
- `recovery_state: exhausted` never invokes Hands.

Write an event before every external boundary and validate work-item ID, ordinal, profile, and paths when loading attempt artifacts.

- [ ] **Step 8: Run local runtime, CLI, and type checks**

Run: `npx vitest run tests/workflow/runtime-local.test.ts tests/workflow/e2e-dry-run.test.ts tests/cli-smoke.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 9: Commit work-item runtime integration**

```bash
git add src/workflow/runtime.ts src/cli.ts src/core/ledger.ts tests/workflow/runtime-local.test.ts tests/workflow/e2e-dry-run.test.ts tests/cli-smoke.test.ts
git commit -m "feat: run bounded Hands backup recovery"
```

---

### Task 8: Apply the Same Policy to Integrated and Post-PR Loops

**Files:**

- Modify: `src/workflow/runtime.ts`
- Test: `tests/workflow/runtime-github.test.ts`
- Test: `tests/workflow/runtime-local.test.ts`

**Interfaces:**

- Consumes: the single `invokeHandsAttempt()` boundary and `decideNextHandsAction()` from Task 7.
- Produces: identical retry, classification, provenance, and resume semantics for `integrated` final verification and post-PR correction.

- [ ] **Step 1: Write failing integrated and post-PR ceiling tests**

Add one local integrated test and one GitHub post-PR test asserting five successful Hands calls and five Verifier calls when quality recovery is reached. Add an exhaustion case asserting:

```ts
expect(result.status).toBe("human_action_required");
expect(result.blocker).toContain("escalation_exhausted");
expect(manifest.work_item_progress.integrated?.quality_recovery_attempts).toBe(1);
```

Add a post-PR primary usage-limit case proving the same ordinal is retried on backup before commit and push.

- [ ] **Step 2: Run the integrated tests and verify they fail**

Run: `npx vitest run tests/workflow/runtime-local.test.ts tests/workflow/runtime-github.test.ts`

Expected: FAIL because final and post-PR loops still use `maxVerifierPasses` and direct `hands()` calls.

- [ ] **Step 3: Replace all remaining direct Hands fix calls**

Replace the direct calls at the integrated final loop and inside `runPostPrLoop()` with `invokeHandsAttempt()`. Use the same per-item counters under `work_item_progress.integrated`; do not create a second retry counter for post-PR work.

Remove every `maxVerifierPasses` comparison and derive the next action only from persisted counters plus the classified review. Preserve commit-before-push and pull-request recovery boundaries exactly.

- [ ] **Step 4: Add provenance checks to final delivery**

Before delivery, require the final attempt record, implementation report, verification evidence, and review to share work-item ID `integrated` and the same ordinal. Require the final approving review to be the review referenced by the final attempt record. Reject delivery when a recovery artifact is missing or points to a different ordinal.

- [ ] **Step 5: Run both runtime suites and typecheck**

Run: `npx vitest run tests/workflow/runtime-local.test.ts tests/workflow/runtime-github.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 6: Commit integrated runtime parity**

```bash
git add src/workflow/runtime.ts tests/workflow/runtime-local.test.ts tests/workflow/runtime-github.test.ts
git commit -m "feat: enforce backup policy in final review loops"
```

---

### Task 9: Upsert One GitHub Attempt Status and Improve Local Status

**Files:**

- Modify: `src/adapters/github.ts`
- Modify: `src/workflow/runtime.ts`
- Modify: `src/workflow/status.ts`
- Test: `tests/adapters/github.test.ts`
- Test: `tests/workflow/runtime-github.test.ts`
- Test: `tests/workflow/status.test.ts`

**Interfaces:**

- Produces: `GitHubAdapter.upsertRunStatus(target, marker, body): Promise<void>`.
- Produces: `formatHandsAttemptStatus(manifest, workItemId): string`.
- Consumes: immutable attempt records and manifest summary state.

- [ ] **Step 1: Write marker upsert adapter tests**

Use marker `<!-- brain-hands-status:run-1:item-1 -->`. Test that no matching comment runs:

```text
gh api repos/{owner}/{repo}/issues/17/comments --paginate
gh api --method POST repos/{owner}/{repo}/issues/17/comments -f body="<!-- brain-hands-status:run-1:item-1 -->"
```

Test that a matching comment ID `91` runs:

```text
gh api repos/{owner}/{repo}/issues/17/comments --paginate
gh api --method PATCH repos/{owner}/{repo}/issues/comments/91 -f body="<!-- brain-hands-status:run-1:item-1 -->"
```

Assert two matching markers fail closed instead of updating an arbitrary comment.

- [ ] **Step 2: Write status rendering tests**

Seed attempt artifacts for primary, usage-limit, backup, and quality recovery. Assert one table includes logical ordinal, kind, profile, model, reasoning effort, and outcome. Assert the exhausted footer is exactly `blocked: escalation_exhausted`.

- [ ] **Step 3: Run adapter and status tests and verify failures**

Run: `npx vitest run tests/adapters/github.test.ts tests/workflow/status.test.ts tests/workflow/runtime-github.test.ts`

Expected: FAIL because the adapter only appends comments and status omits attempt provenance.

- [ ] **Step 4: Implement marker-delimited upsert**

Replace optional `commentRunStatus` use in v2 with:

```ts
upsertRunStatus(
  target: { kind: "issue" | "pull_request"; number: number },
  marker: string,
  body: string,
): Promise<void>;
```

For both issues and PRs, use the shared GitHub issue-comments API because PR comments are issue comments. Parse numeric REST comment IDs, require zero or one marker match, create on zero, and PATCH on one. Keep the dry-run adapter deterministic.

- [ ] **Step 5: Render and synchronize status from ledger state**

Implement `formatHandsAttemptStatus()` as a pure renderer. Call `upsertRunStatus()` after a successful attempt, usage-limit activation, quality-recovery start, Verifier decision, and terminal blocker. Repeating synchronization after resume must produce identical body text and update the same comment.

Extend local `summarizeRun()` and `summarizeRunV2()` with active Hands profile, backup activation reason, current counters, recovery state, and blocker code.

- [ ] **Step 6: Run GitHub and status tests**

Run: `npx vitest run tests/adapters/github.test.ts tests/workflow/status.test.ts tests/workflow/runtime-github.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 7: Commit status reporting**

```bash
git add src/adapters/github.ts src/workflow/runtime.ts src/workflow/status.ts tests/adapters/github.test.ts tests/workflow/runtime-github.test.ts tests/workflow/status.test.ts
git commit -m "feat: report Hands backup attempts durably"
```

---

### Task 10: Document, Regression-Test, and Package the Complete Behavior

**Files:**

- Modify: `README.md`
- Modify: `agentic-codex-workflow.md`
- Modify: `tests/workflow/e2e-dry-run.test.ts`
- Modify: `tests/cli-smoke.test.ts`
- Verify: `package.json`

**Interfaces:**

- Consumes: all public configuration and status behavior from Tasks 1–9.
- Produces: operator documentation and end-to-end proof of cost ceilings, blockers, and resume behavior.

- [ ] **Step 1: Add end-to-end configuration fixtures**

Add a dry-run scenario with `backup` configured and scripted reviews that reject initial plus three fixes, then approve quality recovery. Assert five successful Hands invocations, five Verifier reviews, exact backup model/reasoning provenance, and final `local_ready`.

Add a second scenario with confirmed primary usage exhaustion, backup continuation, three rejected fixes, and no second recovery activation. Assert terminal `escalation_exhausted` and active profile `backup`.

- [ ] **Step 2: Run end-to-end tests before documentation changes**

Run: `npx vitest run tests/workflow/e2e-dry-run.test.ts tests/cli-smoke.test.ts`

Expected: PASS, proving the implemented public behavior before documenting it.

- [ ] **Step 3: Document exact configuration and flows**

Add the approved YAML example to `README.md`. Document these ceilings:

```text
Initial approval: 1 Hands + 1 Verifier
Approval on primary fix 3: 4 Hands + 4 Verifier
Approval on quality recovery: 5 Hands + 5 Verifier
Primary usage limit: failed primary invocation + backup continuation of the same logical attempt
Backup already active after 3 rejected fixes: blocked: escalation_exhausted
```

In `agentic-codex-workflow.md`, document catalog validation, the usage-limit circuit breaker, immutable attempt artifacts, issue status upsert, and the human/replan requirement after exhaustion.

- [ ] **Step 4: Run the full release verification gate**

Run: `npm test`

Expected: PASS.

Run: `npm run typecheck`

Expected: PASS.

Run: `npm run build`

Expected: PASS.

Run: `git diff --check`

Expected: no output.

Run: `npm_config_cache=/private/tmp/brain-hands-npm-cache npm pack --dry-run`

Expected: PASS and package contents remain limited to `dist/`, `prompts/`, `agentic-codex-workflow.md`, `README.md`, `.agents/`, `.codex-plugin/`, and package metadata.

- [ ] **Step 5: Commit documentation and regression coverage**

```bash
git add README.md agentic-codex-workflow.md tests/workflow/e2e-dry-run.test.ts tests/cli-smoke.test.ts
git commit -m "docs: explain bounded Hands backup recovery"
```

---

## Final Acceptance Checklist

- [ ] Existing v2 configs without `backup` load unchanged and do not spend on another model.
- [ ] The initial implementation does not increment `primary_fix_attempts`.
- [ ] Three real primary fixes are allowed before quality recovery.
- [ ] Quality recovery invokes the exact configured backup once per work item.
- [ ] Confirmed primary usage exhaustion retries the same logical ordinal on backup.
- [ ] Transient rate limits and ambiguous quota failures do not trigger fallback.
- [ ] Primary is never probed again after availability fallback activates.
- [ ] Backup already active cannot trigger another model fallback.
- [ ] Completed failed verification evidence reaches Verifier classification.
- [ ] Operational and infrastructure blockers consume no logical fix attempt.
- [ ] Model and reasoning support are validated during preflight and immediately before backup use.
- [ ] Every invocation and logical attempt has provenance-linked artifacts.
- [ ] Resume cannot duplicate primary, backup, or quality-recovery invocations.
- [ ] Recovery exhaustion is durable and blocks until human direction or approved replan.
- [ ] One GitHub status comment is upserted idempotently from ledger state.
- [ ] Local status displays route, counters, recovery state, and blocker code.
- [ ] `npm test`, `npm run typecheck`, `npm run build`, `git diff --check`, and `npm pack --dry-run` pass.
