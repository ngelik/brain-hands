# Durable Brain Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a mandatory, adaptive, resumable Brain discovery stage whose approved local brief is integrity-pinned input to execution planning.

**Architecture:** Keep the existing Brain, Hands, and Verifier roles. Add strict discovery contracts, protocol-versioned manifest state, immutable discovery artifacts/events, and a read-only Brain discovery controller before `brain_planning`. Legacy runs retain their current path; every new run uses `durable-discovery-v1` and must approve a discovery brief before planning.

**Tech Stack:** TypeScript 6, Node.js 20+, Commander 15, Zod 4, Vitest 4, structured Codex CLI output, append-only JSONL ledgers.

## Global Constraints

- Every new run records a discovery decision before planning.
- Ask exactly one adaptive question per Brain turn.
- Initial discovery has a five-answer soft limit and six-answer hard limit.
- A planning-gap cycle permits its evidence-backed question plus at most one adaptive follow-up.
- Limits never permit invented certainty; unsafe unresolved work remains blocked and resumable.
- Discovery artifacts remain local; no transcript content is projected to GitHub.
- Discovery-brief approval and execution-plan approval remain separate exact-revision gates.
- Verify the approved brief SHA-256 before planning and on resume.
- Existing persisted runs without discovery metadata resume under the legacy protocol.
- Do not add a model role, dependency, configuration switch, or terminal wizard.
- Discovery structured output gets exactly two attempts; validation failures do not advance state or consume question budget.
- Preserve the npm runtime package allowlist.

---

## File structure

**Create:**

- `src/core/discovery.ts` — constants, semantic validation, budgets, canonical paths, and pending-action validation.
- `src/core/discovery-ledger.ts` — integrity-pinned artifacts, approvals, idempotency, and events.
- `src/workflow/discovery.ts` — Brain invocation, two-attempt correction, history assembly, and boundary transitions.
- `src/core/operator-input.ts` — non-empty operator text from stdin or one file.
- `prompts/brain-discovery-v1.md` — repository-grounded discovery prompt.
- `tests/core/discovery.test.ts`, `tests/core/discovery-ledger.test.ts`, and `tests/workflow/discovery.test.ts`.

**Modify:**

- `src/core/types.ts`, `src/core/schema.ts`, `src/core/output-schemas.ts`
- `src/core/run-state.ts`, `src/core/ledger.ts`, `src/core/secret-detector.ts`
- `src/prompts/loader.ts`, `src/workflow/planner.ts`, `src/core/execution-spec.ts`
- `prompts/brain-plan-v2.md`, `src/cli.ts`, `src/workflow/status.ts`
- `src/progress/events.ts`, `src/workflow/github-status.ts`
- `.agents/skills/brain-hands/SKILL.md` and `.agents/skills/brain-hands/references/cli-contract.md`
- `README.md`, `agentic-codex-workflow.md`, and focused tests named below.

---

### Task 1: Define strict discovery contracts

**Files:**
- Create: `src/core/discovery.ts`
- Create: `tests/core/discovery.test.ts`
- Modify: `src/core/types.ts`
- Modify: `src/core/schema.ts`
- Modify: `src/core/output-schemas.ts`
- Modify: `tests/core/schema.test.ts`
- Modify: `tests/core/execution-spec.test.ts`

**Interfaces:**
- Produces: `WorkflowProtocol`, `DiscoveryQuestion`, `DiscoveryApproach`, `DiscoveryBrief`, `DiscoveryOutcome`, `DiscoveryManifestState`, `DiscoveryPendingAction`, and `PlanningDiscoveryGap`.
- Produces: `initialDiscoveryState()`, `questionLimit(state)`, and `validateDiscoveryOutcome(outcome, state)`.
- Produces: Zod and Codex JSON schemas for discovery and discovery-backed plans.

- [ ] **Step 1: Write failing contract tests**

Create `tests/core/discovery.test.ts`:

~~~ts
import { describe, expect, it } from "vitest";
import { discoveryOutcomeSchema } from "../../src/core/schema.js";
import { initialDiscoveryState, questionLimit, validateDiscoveryOutcome } from "../../src/core/discovery.js";

const question = {
  id: "q-001",
  sequence: 1,
  category: "required" as const,
  text: "Should discovery run for every new workflow?",
  choices: [
    { id: "every-run", label: "Every run", description: "Record readiness on every run." },
    { id: "ambiguous-only", label: "Ambiguous only", description: "Skip apparently clear work." },
  ],
  rationale: "The answer changes the workflow contract.",
  material_effects: ["architecture" as const],
  repository_evidence: ["src/core/run-state.ts: preflight currently enters brain_planning"],
  essential_after_soft_limit: null,
};

describe("durable discovery contract", () => {
  it("accepts one material question", () => {
    const parsed = discoveryOutcomeSchema.parse({ outcome: "ask_question", question });
    expect(validateDiscoveryOutcome(parsed, initialDiscoveryState())).toEqual(parsed);
  });

  it("requires justification for question six", () => {
    const state = { ...initialDiscoveryState(), asked_questions: 5, answered_questions: 5 };
    expect(() => validateDiscoveryOutcome(
      { outcome: "ask_question", question: { ...question, id: "q-006", sequence: 6 } },
      state,
    )).toThrow("Question 6 requires essential_after_soft_limit");
  });

  it("hard-stops question seven", () => {
    expect(questionLimit({ ...initialDiscoveryState(), answered_questions: 6 }))
      .toEqual({ canAsk: false, requiresJustification: false });
  });
});
~~~

Add strict unknown-key tests to `tests/core/schema.test.ts` and discovery-decision coverage tests to `tests/core/execution-spec.test.ts`.

- [ ] **Step 2: Run the tests and verify failure**

Run: `npx vitest run tests/core/discovery.test.ts tests/core/schema.test.ts tests/core/execution-spec.test.ts`

Expected: FAIL because the discovery exports do not exist.

- [ ] **Step 3: Add exact TypeScript contracts**

Add these declarations to `src/core/types.ts` and add `brain_discovery`, `awaiting_discovery_answer`, `awaiting_discovery_approach`, and `awaiting_discovery_brief_approval` to `RunStageV2`:

~~~ts
export type WorkflowProtocol = "legacy-v2" | "durable-discovery-v1";
export type DiscoveryMaterialEffect = "scope" | "architecture" | "acceptance_criteria" | "verification";

export interface DiscoveryChoice {
  id: string;
  label: string;
  description: string;
}

export interface DiscoveryQuestion {
  id: string;
  sequence: number;
  category: "required" | "high_value_tradeoff";
  text: string;
  choices: DiscoveryChoice[];
  rationale: string;
  material_effects: DiscoveryMaterialEffect[];
  repository_evidence: string[];
  essential_after_soft_limit: string | null;
}

export interface DiscoveryApproach {
  id: string;
  title: string;
  summary: string;
  tradeoffs: string[];
  recommended: boolean;
  recommendation_rationale: string | null;
}

export interface DiscoveryDecision {
  id: string;
  statement: string;
  source_question_ids: string[];
}

export interface DiscoveryAssumption {
  id: string;
  statement: string;
  source: "brain_inference" | "user_instruction" | "proceed_with_assumptions";
  source_question_ids: string[];
}

export interface DiscoveryBrief {
  revision: number;
  goal: string;
  problem: string;
  success_criteria: string[];
  constraints: string[];
  decisions: DiscoveryDecision[];
  assumptions: DiscoveryAssumption[];
  selected_approach_id: string | null;
  selected_approach_rationale: string | null;
  out_of_scope: string[];
  accepted_risks: string[];
  repository_evidence: string[];
}

export type DiscoveryOutcome =
  | { outcome: "ask_question"; question: DiscoveryQuestion }
  | {
      outcome: "ready_for_brief" | "no_discovery_needed";
      rationale: string;
      approaches: DiscoveryApproach[];
      alternatives_omitted_reason: string | null;
      brief: DiscoveryBrief;
    };

export interface DiscoveryArtifactRecord {
  revision: number;
  path: string;
  sha256: string;
}

export interface DiscoveryManifestState {
  cycle: number;
  cycle_kind: "initial" | "planning_gap";
  asked_questions: number;
  answered_questions: number;
  current_question_id: string | null;
  current_approaches_revision: number | null;
  selected_approach_id: string | null;
  current_brief_revision: number | null;
  approved_brief_revision: number | null;
  approved_brief_sha256: string | null;
  pending_action_path: string | null;
  brief_revisions: Record<string, DiscoveryArtifactRecord>;
}

export type DiscoveryPendingAction =
  | { state: "awaiting_discovery_answer"; question: DiscoveryQuestion }
  | { state: "awaiting_discovery_approach"; revision: number; approaches: DiscoveryApproach[] }
  | { state: "awaiting_discovery_brief_approval"; revision: number; brief: DiscoveryBrief };

export interface PlanningDiscoveryGap {
  outcome: "discovery_gap";
  evidence: string[];
  question: DiscoveryQuestion;
}

export interface DiscoveryDecisionCoverage {
  decision_id: string;
  work_item_ids: string[];
  acceptance_ids: string[];
  verification_command_ids: string[];
  no_implementation_effect: string | null;
}

export interface DiscoveredBrainPlan extends BrainPlan {
  discovery_brief_revision: number;
  discovery_brief_sha256: string;
  discovery_decision_coverage: DiscoveryDecisionCoverage[];
}
~~~

Add `workflow_protocol: WorkflowProtocol` and `discovery: DiscoveryManifestState | null` to `RunManifestV2`.

- [ ] **Step 4: Implement strict Zod and JSON schemas**

Use these identity constraints in `src/core/schema.ts`:

~~~ts
const discoveryQuestionIdSchema = z.string().regex(/^q-\d{3}$/);
const discoveryDecisionIdSchema = z.string().regex(/^d-\d{3}$/);
const discoveryAssumptionIdSchema = z.string().regex(/^a-\d{3}$/);
const discoveryApproachIdSchema = z.string().regex(/^approach-[a-z0-9]+(?:-[a-z0-9]+)*$/);
~~~

Build every object with `.strict()`. Mirror the shapes in `src/core/output-schemas.ts` with `additionalProperties: false`. Export `discoveryOutcomeSchema`, `discoveryOutcomeOutputSchema`, `discoveredBrainPlanSchema`, and `discoveredBrainPlanOutputSchema`.

- [ ] **Step 5: Implement semantic budgets**

Create `src/core/discovery.ts`:

~~~ts
import type { DiscoveryManifestState, DiscoveryOutcome } from "./types.js";

export const INITIAL_DISCOVERY_SOFT_LIMIT = 5;
export const INITIAL_DISCOVERY_HARD_LIMIT = 6;
export const GAP_DISCOVERY_HARD_LIMIT = 2;
export const DISCOVERY_OUTPUT_ATTEMPTS = 2;

export class DiscoveryValidationError extends Error {
  override readonly name = "DiscoveryValidationError";
}

export function initialDiscoveryState(): DiscoveryManifestState {
  return {
    cycle: 1,
    cycle_kind: "initial",
    asked_questions: 0,
    answered_questions: 0,
    current_question_id: null,
    current_approaches_revision: null,
    selected_approach_id: null,
    current_brief_revision: null,
    approved_brief_revision: null,
    approved_brief_sha256: null,
    pending_action_path: null,
    brief_revisions: {},
  };
}

export function questionLimit(state: DiscoveryManifestState): { canAsk: boolean; requiresJustification: boolean } {
  if (state.cycle_kind === "planning_gap") {
    return { canAsk: state.answered_questions < GAP_DISCOVERY_HARD_LIMIT, requiresJustification: false };
  }
  return {
    canAsk: state.answered_questions < INITIAL_DISCOVERY_HARD_LIMIT,
    requiresJustification: state.answered_questions >= INITIAL_DISCOVERY_SOFT_LIMIT,
  };
}

export function validateDiscoveryOutcome<T extends DiscoveryOutcome>(outcome: T, state: DiscoveryManifestState): T {
  if (outcome.outcome !== "ask_question") {
    const hasApproaches = outcome.approaches.length >= 2 && outcome.approaches.length <= 3;
    if (hasApproaches === (outcome.alternatives_omitted_reason !== null)) {
      throw new DiscoveryValidationError("Discovery readiness requires 2-3 approaches or one alternatives_omitted_reason");
    }
    return outcome;
  }
  const limit = questionLimit(state);
  if (!limit.canAsk) throw new DiscoveryValidationError("Discovery question hard limit reached");
  if (outcome.question.sequence !== state.asked_questions + 1) {
    throw new DiscoveryValidationError("Discovery question sequence is not monotonic");
  }
  if (limit.requiresJustification && !outcome.question.essential_after_soft_limit) {
    throw new DiscoveryValidationError("Question " + outcome.question.sequence + " requires essential_after_soft_limit");
  }
  return outcome;
}
~~~

Also add fixed path helpers for questions, answers, approaches, briefs, and `discovery/pending-action.json`.

- [ ] **Step 6: Verify and commit**

Run:

~~~bash
npx vitest run tests/core/discovery.test.ts tests/core/schema.test.ts tests/core/execution-spec.test.ts
npm run typecheck
~~~

Expected: PASS.

Commit:

~~~bash
git add src/core/types.ts src/core/schema.ts src/core/output-schemas.ts src/core/discovery.ts tests/core/discovery.test.ts tests/core/schema.test.ts tests/core/execution-spec.test.ts
git commit -m "feat: define durable discovery contracts"
~~~

---

### Task 2: Persist protocol-versioned discovery state

**Files:**
- Create: `src/core/discovery-ledger.ts`
- Create: `tests/core/discovery-ledger.test.ts`
- Modify: `src/core/ledger.ts`
- Modify: `src/core/run-state.ts`
- Modify: `src/core/secret-detector.ts`
- Modify: `tests/core/ledger.test.ts`

**Interfaces:**
- Consumes: Task 1 contracts and path helpers.
- Produces: `recordDiscoveryQuestion`, `recordDiscoveryAnswer`, `recordDiscoveryApproaches`, `recordDiscoveryBrief`, `selectDiscoveryApproach`, `approveDiscoveryBrief`, `rejectDiscoveryBrief`, `readVerifiedDiscoveryBrief`, and `readDiscoveryPendingAction`.
- Produces: `assertTransition(from, to, protocol)`.

- [ ] **Step 1: Write failing ledger tests**

Assert new ledgers use `durable-discovery-v1`, initialize discovery, create discovery directories, and reject `preflight -> brain_planning`. Test matching-answer idempotency, conflicting-answer rejection, stale IDs, stale brief approval, changed brief bytes, and an old manifest defaulting to `legacy-v2` with `discovery: null`.

```ts
const ledger = await createRunLedgerV2({ repoRoot, originalRequest: "Discover before planning" });
expect(ledger.manifest.workflow_protocol).toBe("durable-discovery-v1");
expect(ledger.manifest.discovery).toMatchObject({ cycle: 1, answered_questions: 0 });
await transitionRun(ledger.runDir, "preflight", { actor: "test" });
await expect(transitionRun(ledger.runDir, "brain_planning", { actor: "test" }))
  .rejects.toThrow("durable-discovery-v1");
await transitionRun(ledger.runDir, "brain_discovery", { actor: "test" });
await recordDiscoveryQuestion(ledger.runDir, question);
await recordDiscoveryAnswer(ledger.runDir, "q-001", "Every run");
await expect(recordDiscoveryAnswer(ledger.runDir, "q-001", "Ambiguous only"))
  .rejects.toThrow("conflicts with the recorded answer");
```

- [ ] **Step 2: Verify failure**

Run: `npx vitest run tests/core/discovery-ledger.test.ts tests/core/ledger.test.ts`

Expected: FAIL because new runs have no discovery state.

- [ ] **Step 3: Initialize protocol and state**

In `runManifestV2Schema`:

~~~ts
workflow_protocol: z.enum(["legacy-v2", "durable-discovery-v1"]).default("legacy-v2"),
discovery: discoveryManifestStateSchema.nullable().default(null),
~~~

In `createRunLedgerV2`, set `workflow_protocol: "durable-discovery-v1"` and `discovery: initialDiscoveryState()`. Create `discovery/questions`, `discovery/answers`, `discovery/approaches`, and `discovery/briefs`.

- [ ] **Step 4: Make transitions protocol-aware**

Change the signature:

~~~ts
export function assertTransition(
  from: RunStageV2,
  to: RunStageV2,
  protocol: WorkflowProtocol = "legacy-v2",
): void
~~~

Keep legacy `preflight -> brain_planning`. For durable discovery require:

~~~text
preflight -> brain_discovery
brain_discovery -> awaiting_discovery_answer | awaiting_discovery_approach | awaiting_discovery_brief_approval
awaiting_discovery_answer -> brain_discovery
awaiting_discovery_approach -> brain_discovery
awaiting_discovery_brief_approval -> brain_discovery | brain_planning
brain_planning -> brain_discovery | awaiting_plan_approval
~~~

Pass `manifest.workflow_protocol` from `transitionRunInTransaction`.

- [ ] **Step 5: Implement safe artifact operations**

In `src/core/discovery-ledger.ts` use `withRunLedgerCompoundTransaction` and canonical JSON:

~~~ts
export function canonicalDiscoveryJson(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}

export function discoverySha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
~~~

Before writing an answer:

~~~ts
const normalized = answer.trim();
if (!normalized) throw new Error("Discovery answer must be non-empty");
assertNoSecretMaterial("Discovery answer", normalized);
if (manifest.discovery?.current_question_id !== questionId) {
  throw new Error("Discovery question " + questionId + " is stale");
}
~~~

Every mutation writes one fixed canonical artifact, appends one discovery event, and updates state under the run lock. Approval reads canonical bytes, recomputes SHA-256, requires the current revision and selected approach when alternatives exist, then pins revision and digest. Change `assertNoSecretMaterial` to use a phase-neutral label and update its existing replan caller.

- [ ] **Step 6: Verify and commit**

Run:

~~~bash
npx vitest run tests/core/discovery-ledger.test.ts tests/core/ledger.test.ts tests/core/secret-detector.test.ts
npm run typecheck
~~~

Expected: PASS.

Commit:

~~~bash
git add src/core/discovery-ledger.ts src/core/ledger.ts src/core/run-state.ts src/core/secret-detector.ts tests/core/discovery-ledger.test.ts tests/core/ledger.test.ts tests/core/secret-detector.test.ts
git commit -m "feat: persist discovery workflow state"
~~~

---

### Task 3: Implement adaptive Brain discovery

**Files:**
- Create: `prompts/brain-discovery-v1.md`
- Create: `src/workflow/discovery.ts`
- Create: `tests/workflow/discovery.test.ts`
- Modify: `src/prompts/loader.ts`
- Modify: `tests/prompts/renderer.test.ts`

**Interfaces:**
- Consumes: `CodexAdapter`, resolved Brain profile, Task 1 validation, and Task 2 ledger APIs.
- Produces: `runDiscoveryTurn(input): Promise<DiscoveryPendingAction>` and `reopenDiscoveryFromPlanningGap(input)`.

- [ ] **Step 1: Write failing controller tests**

Use a queued recording adapter. Queue one invalid response and one valid `ask_question`. Assert two calls use the same sequence, only the valid response creates `questions/001.json`, and the manifest count becomes one. Add cases for `no_discovery_needed`, pending approach selection, selected approach to brief, question-six justification, question-seven rejection, and the two-question planning-gap limit.

```ts
const codex = new QueuedBrain([
  { outcome: "ask_question", question: { ...question, material_effects: [] } },
  { outcome: "ask_question", question },
]);
const pending = await runDiscoveryTurn({ runDir: ledger.runDir, intake, codex });
expect(codex.calls).toHaveLength(2);
expect(pending).toMatchObject({ state: "awaiting_discovery_answer", question: { id: "q-001" } });
expect((await readManifestV2(ledger.runDir)).discovery?.asked_questions).toBe(1);
expect(await readFile(join(ledger.runDir, "discovery/questions/001.json"), "utf8"))
  .toContain('"id": "q-001"');
```

- [ ] **Step 2: Verify failure**

Run: `npx vitest run tests/workflow/discovery.test.ts tests/prompts/renderer.test.ts`

Expected: FAIL because the controller and prompt do not exist.

- [ ] **Step 3: Write and register the prompt**

`prompts/brain-discovery-v1.md` must tell Brain to inspect relevant code, tests, config, docs, and recent commits; return one strict outcome; ask only one material question; avoid cosmetic alternatives; preserve decisions and forced assumptions; honor supplied budgets; and never request credentials. Register `brain-discovery-v1` in `PromptTemplateName`.

- [ ] **Step 4: Implement exactly two output attempts**

Import `ZodError` from `zod` and `DiscoveryValidationError` from
`src/core/discovery.ts`. Retry only those validation failures; transport,
catalog, permission, timeout, and filesystem errors fail immediately. Use this
control structure in `src/workflow/discovery.ts`:

~~~ts
let validationFailure: string | null = null;
for (let attempt = 1; attempt <= DISCOVERY_OUTPUT_ATTEMPTS; attempt += 1) {
  const prompt = renderDiscoveryPrompt(context, validationFailure);
  try {
    const result = await input.codex.invoke({
      role: "brain",
      model: brainProfile.model,
      reasoningEffort: brainProfile.reasoning_effort,
      sandbox: "read-only",
      cwd: input.intake.repo_root,
      enableWebSearch: false,
      prompt,
      runDir: input.runDir,
      artifactName: "brain-discovery-cycle-" + state.cycle + "-turn-" + (state.asked_questions + 1) + "-attempt-" + attempt,
      outputSchema: discoveryOutcomeOutputSchema,
      outputParser: discoveryOutcomeSchema,
    });
    const outcome = validateDiscoveryOutcome(result.parsed as DiscoveryOutcome, state);
    return await persistValidatedOutcome(input.runDir, outcome);
  } catch (error) {
    if (!(error instanceof ZodError) && !(error instanceof DiscoveryValidationError)) throw error;
    validationFailure = error instanceof Error ? error.message : String(error);
    if (attempt === DISCOVERY_OUTPUT_ATTEMPTS) throw error;
  }
}
throw new Error("Discovery retry loop exhausted without a result");
~~~

The retry prompt includes only the validation message, not raw rejected output. No failed attempt mutates discovery counters or stages.

- [ ] **Step 5: Implement planning-gap reopening**

`reopenDiscoveryFromPlanningGap` increments the cycle, sets `cycle_kind: "planning_gap"`, clears current approval pointers without deleting old artifacts, persists the planner evidence and supplied question as the first question, and transitions directly to `awaiting_discovery_answer` without another Brain call.

- [ ] **Step 6: Verify and commit**

Run:

~~~bash
npx vitest run tests/workflow/discovery.test.ts tests/prompts/renderer.test.ts
npm run typecheck
~~~

Expected: PASS.

Commit:

~~~bash
git add prompts/brain-discovery-v1.md src/prompts/loader.ts src/workflow/discovery.ts tests/workflow/discovery.test.ts tests/prompts/renderer.test.ts
git commit -m "feat: add adaptive Brain discovery"
~~~

---

### Task 4: Add CLI boundaries and discovery commands

**Files:**
- Create: `src/core/operator-input.ts`
- Modify: `src/cli.ts`
- Modify: `tests/cli-smoke.test.ts`
- Modify: `tests/workflow/e2e-dry-run.test.ts`

**Interfaces:**
- Consumes: `runDiscoveryTurn`, discovery mutations, and `readOperatorStatus`.
- Produces: `readOperatorText(inputFile?)` plus five exact CLI commands.

- [ ] **Step 1: Write failing CLI tests**

Change the dry-run `run` expectation from plan approval to a discovery boundary. Test answer, approach, proceed, approve, and revise commands; stale question/revision rejection; blank input; secret rejection; and `resume --json` returning the same pending artifact without a Codex call.

```ts
await buildCli().parseAsync([
  "answer-discovery",
  "--run", runDir,
  "--question", "q-001",
  "--input-file", answerPath,
  "--dry-run",
  "--json",
], { from: "user" });
expect(["awaiting_discovery_approach", "awaiting_discovery_brief_approval"])
  .toContain((await readManifestV2(runDir)).stage);
const before = await readFile(join(runDir, "discovery/pending-action.json"), "utf8");
await buildCli().parseAsync(["resume", "--run", runDir, "--dry-run", "--json"], { from: "user" });
expect(await readFile(join(runDir, "discovery/pending-action.json"), "utf8")).toBe(before);
```

- [ ] **Step 2: Verify failure**

Run: `npx vitest run tests/cli-smoke.test.ts tests/workflow/e2e-dry-run.test.ts`

Expected: FAIL because `run` still plans and commands are unknown.

- [ ] **Step 3: Implement operator input**

Create `src/core/operator-input.ts`:

~~~ts
import { readFile } from "node:fs/promises";

export async function readOperatorText(inputFile?: string): Promise<string> {
  const text = inputFile === undefined
    ? await new Promise<string>((resolve, reject) => {
        let value = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (chunk: string) => { value += chunk; });
        process.stdin.on("end", () => resolve(value));
        process.stdin.on("error", reject);
      })
    : await readFile(inputFile, "utf8");
  const normalized = text.trim();
  if (!normalized) throw new Error("Operator input must be non-empty");
  return normalized;
}
~~~

- [ ] **Step 4: Change `run` to stop at first user boundary**

After preflight, transition to `brain_discovery` and call `runDiscoveryTurn`. Change the description to “Start a v2 workflow and stop at the first user boundary.” Extend the dry-run adapter with deterministic discovery fixtures.

- [ ] **Step 5: Add exact commands**

Implement:

~~~text
answer-discovery --run <run-dir> --question <id> [--input-file <path>] [--dry-run] [--json] [--follow]
select-discovery-approach --run <run-dir> --revision <number> --approach <id> [--dry-run] [--json] [--follow]
proceed-discovery --run <run-dir> [--input-file <path>] [--dry-run] [--json] [--follow]
approve-discovery --run <run-dir> --revision <number> [--dry-run] [--json] [--follow]
revise-discovery --run <run-dir> --revision <number> [--input-file <path>] [--dry-run] [--json] [--follow]
~~~

`approve-discovery` verifies the brief, records approval, enters `brain_planning`, and calls `planRunV2`. Other commands stop at the next user boundary. `resume` at all discovery boundaries reads status only.

- [ ] **Step 6: Verify and commit**

Run:

~~~bash
npx vitest run tests/cli-smoke.test.ts tests/workflow/e2e-dry-run.test.ts
npm run typecheck
~~~

Expected: PASS.

Commit:

~~~bash
git add src/core/operator-input.ts src/cli.ts tests/cli-smoke.test.ts tests/workflow/e2e-dry-run.test.ts
git commit -m "feat: expose discovery user boundaries"
~~~

---

### Task 5: Bind execution planning to the approved brief

**Files:**
- Modify: `prompts/brain-plan-v2.md`
- Modify: `src/workflow/planner.ts`
- Modify: `src/core/execution-spec.ts`
- Modify: `tests/workflow/planner.test.ts`
- Modify: `tests/core/execution-spec.test.ts`

**Interfaces:**
- Consumes: `readVerifiedDiscoveryBrief`, discovered-plan schemas, and `reopenDiscoveryFromPlanningGap`.
- Produces: a result union with `kind: "plan"` or `kind: "discovery_gap"`.

- [ ] **Step 1: Write failing planner tests**

Seed and approve a brief before planning. Test changed brief bytes, wrong digest, missing/duplicate coverage, nonexistent work-item/acceptance/verification references, and a `discovery_gap` returning to `awaiting_discovery_answer` without a plan revision.

```ts
const result = await planRunV2({
  runDir: ledger.runDir,
  intake,
  codex: new RecordingBrain({
    outcome: "discovery_gap",
    evidence: ["src/core/run-state.ts conflicts with decision d-001"],
    question: gapQuestion,
  }),
});
expect(result.kind).toBe("discovery_gap");
const manifest = await readManifestV2(ledger.runDir);
expect(manifest.stage).toBe("awaiting_discovery_answer");
expect(manifest.discovery?.cycle_kind).toBe("planning_gap");
expect(manifest.current_plan_revision).toBeNull();
```

- [ ] **Step 2: Verify failure**

Run: `npx vitest run tests/workflow/planner.test.ts tests/core/execution-spec.test.ts`

Expected: FAIL because planning does not consume discovery.

- [ ] **Step 3: Render frozen brief input**

For `durable-discovery-v1`, require approved revision/digest, call `readVerifiedDiscoveryBrief`, and render:

~~~ts
approved_discovery_brief: JSON.stringify(brief, null, 2),
approved_discovery_brief_revision: String(brief.revision),
approved_discovery_brief_sha256: manifest.discovery.approved_brief_sha256,
~~~

Legacy runs retain the current parser when resuming an older workflow.

- [ ] **Step 4: Enforce decision traceability**

Update the prompt to return either a strict discovered plan or `PlanningDiscoveryGap`. Implement `validateDiscoveryCoverage(plan, brief)` in `src/core/execution-spec.ts`: exact decision-ID set equality, unique rows, valid work-item/acceptance/verification references, and exactly one of concrete mappings or `no_implementation_effect`.

- [ ] **Step 5: Reopen discovery fail-closed**

Parse the planning response union. On a gap, call `reopenDiscoveryFromPlanningGap` and do not call `recordPlan`. On a plan, verify the echoed revision/digest and coverage before any plan artifact or `awaiting_plan_approval` transition.

- [ ] **Step 6: Verify and commit**

Run:

~~~bash
npx vitest run tests/workflow/planner.test.ts tests/core/execution-spec.test.ts
npm run typecheck
~~~

Expected: PASS.

Commit:

~~~bash
git add prompts/brain-plan-v2.md src/workflow/planner.ts src/core/execution-spec.ts tests/workflow/planner.test.ts tests/core/execution-spec.test.ts
git commit -m "feat: bind plans to approved discovery"
~~~

---

### Task 6: Report truthful local boundaries without leaks

**Files:**
- Modify: `src/workflow/status.ts`
- Modify: `src/progress/events.ts`
- Modify: `src/workflow/github-status.ts`
- Modify: `tests/workflow/status.test.ts`
- Modify: `tests/progress/events.test.ts`
- Modify: `tests/workflow/github-status.test.ts`

**Interfaces:**
- Consumes: pending-action artifacts and fixed progress labels.
- Produces: `V2StatusSummary.pending_action` and content-free discovery progress events.

- [ ] **Step 1: Write failing status and privacy tests**

Cover all three pending stages. Assert local JSON includes the validated pending action and readable output names the exact next command. Put `PRIVATE-DISCOVERY-MARKER` in a question and assert no GitHub adapter argument contains it.

```ts
const status = await readOperatorStatus(runDir);
expect(status).toMatchObject({
  operator_state: "awaiting_discovery_answer",
  pending_action: { state: "awaiting_discovery_answer", question: { id: "q-001" } },
});
expect(renderRunStatus(status)).toContain("answer-discovery");
expect(JSON.stringify(github.calls)).not.toContain("PRIVATE-DISCOVERY-MARKER");
```

- [ ] **Step 2: Verify failure**

Run: `npx vitest run tests/workflow/status.test.ts tests/progress/events.test.ts tests/workflow/github-status.test.ts`

Expected: FAIL because discovery status is not projected.

- [ ] **Step 3: Implement exact operator status**

Add the three operator states. Read only fixed `discovery/pending-action.json` through an owned-file helper and validate it. Never reconstruct question text from counters. Local readable output may show the question; generic and GitHub output says only “Awaiting local discovery input.”

- [ ] **Step 4: Add safe progress codes**

Add `discovery_started`, `discovery_question_ready`, `discovery_brief_ready`, and `discovery_brief_approved`. Labels are fixed; brief codes require a numeric revision. Do not add question, answer, rationale, path, or arbitrary text to `ProgressIntent`.

- [ ] **Step 5: Verify and commit**

Run:

~~~bash
npx vitest run tests/workflow/status.test.ts tests/progress/events.test.ts tests/workflow/github-status.test.ts
npm run typecheck
~~~

Expected: PASS.

Commit:

~~~bash
git add src/workflow/status.ts src/progress/events.ts src/workflow/github-status.ts tests/workflow/status.test.ts tests/progress/events.test.ts tests/workflow/github-status.test.ts
git commit -m "feat: report private discovery boundaries"
~~~

---

### Task 7: Update the skill and operator documentation

**Files:**
- Modify: `.agents/skills/brain-hands/SKILL.md`
- Modify: `.agents/skills/brain-hands/references/cli-contract.md`
- Modify: `README.md`
- Modify: `agentic-codex-workflow.md`
- Modify: `tests/skill-layout.test.ts`
- Modify: `tests/scripts/brain-hands-wrapper.test.ts`

**Interfaces:**
- Consumes: Task 4 commands and Task 6 status.
- Produces: one consistent conversational and direct-CLI contract.

- [ ] **Step 1: Write failing distribution tests**

Require all five command names, one-question language, local-only discovery, exact brief approval, separate plan approval, and wrapper acceptance of discovery boundaries.

```ts
const skill = await readFile(join(skillRoot, "SKILL.md"), "utf8");
for (const command of [
  "answer-discovery",
  "select-discovery-approach",
  "proceed-discovery",
  "approve-discovery",
  "revise-discovery",
]) expect(skill).toContain(command);
expect(skill).toMatch(/one question at a time/i);
expect(skill).toMatch(/discovery.*local/is);
expect(skill.indexOf("approve-discovery")).toBeLessThan(skill.indexOf("approve-plan"));
```

- [ ] **Step 2: Verify failure**

Run: `npx vitest run tests/skill-layout.test.ts tests/scripts/brain-hands-wrapper.test.ts`

Expected: FAIL because the skill launches directly to plan approval.

- [ ] **Step 3: Update the conversational protocol**

Require the skill to start the engine, read one pending action, present engine-authored content without rewriting it, record the user's response, show the exact brief revision for approval, and only then enter plan approval. State that `resume` is read-only at discovery boundaries and transcript content remains local.

- [ ] **Step 4: Update CLI and architecture docs**

Document exact commands, state flow, artifacts, question budgets, secret rejection, hash verification, legacy behavior, and “first user boundary” semantics in the CLI reference, README, and workflow guide.

- [ ] **Step 5: Verify and commit**

Run:

~~~bash
npx vitest run tests/skill-layout.test.ts tests/scripts/brain-hands-wrapper.test.ts tests/scripts/release-validation.test.ts
~~~

Expected: PASS.

Commit:

~~~bash
git add .agents/skills/brain-hands/SKILL.md .agents/skills/brain-hands/references/cli-contract.md README.md agentic-codex-workflow.md tests/skill-layout.test.ts tests/scripts/brain-hands-wrapper.test.ts
git commit -m "docs: expose durable Brain discovery"
~~~

---

### Task 8: Verify the full lifecycle and release surface

**Files:**
- Modify: `tests/workflow/e2e-dry-run.test.ts`
- Modify: `tests/cli-smoke.test.ts`
- Modify: `tests/scripts/release-validation.test.ts`
- Verify: `package.json`
- Verify: `.codex-plugin/plugin.json`

**Interfaces:**
- Consumes: all prior task interfaces.
- Produces: full dry-run, packaged-CLI, and authenticated Brain evidence.

- [ ] **Step 1: Add full dry-run regression**

Drive this exact sequence:

~~~text
run -> q-001 -> answer-discovery -> approaches -> select-discovery-approach
-> brief -> approve-discovery -> plan -> approve-plan
-> existing local Hands and Verifier lifecycle
~~~

Assert artifacts survive a fresh CLI instance, brief bytes match the approved digest, the plan echoes it, GitHub is unused, and Hands starts only after both approvals.

- [ ] **Step 2: Run full-story tests**

Run:

~~~bash
npx vitest run tests/workflow/e2e-dry-run.test.ts tests/cli-smoke.test.ts tests/workflow/discovery.test.ts tests/workflow/planner.test.ts
~~~

Expected: PASS.

- [ ] **Step 3: Run repository release gates**

Run:

~~~bash
npm run typecheck
npm test
npm run build
npm pack --dry-run
git diff --check
~~~

Expected: all exit 0. Package output includes `dist/`, `prompts/brain-discovery-v1.md`, skill files, README, workflow guide, and metadata; it excludes `src/`, `tests/`, `docs/`, and `.brain-hands/`.

- [ ] **Step 4: Run authenticated Brain smoke**

Initialize `/private/tmp/brain-hands-discovery-smoke` as a disposable Git repository and Brain Hands repository, then run:

~~~bash
node dist/cli.js run "Add configurable export behavior" --repo /private/tmp/brain-hands-discovery-smoke --mode local --no-research --no-reflection --json
~~~

Expected: exit 0 at `awaiting_discovery_answer` or `awaiting_discovery_brief_approval`. Any question has one material-effect set. A subsequent `status --json` and `resume --json` return the same pending action without adding a Brain response artifact.

- [ ] **Step 5: Verify privacy and final status**

Restart the CLI process and repeat status/resume. Compare pending-action bytes and digest. Confirm no discovery question, answer, approaches, or brief content appears in GitHub adapter fixtures or progress events.

- [ ] **Step 6: Commit final regression coverage**

~~~bash
git add tests/workflow/e2e-dry-run.test.ts tests/cli-smoke.test.ts tests/scripts/release-validation.test.ts
git commit -m "test: verify durable discovery lifecycle"
~~~

---

## Final review checklist

- [ ] Every approved design acceptance criterion maps to a task and test.
- [ ] New runs cannot go directly from preflight to planning.
- [ ] Legacy manifests still parse and resume.
- [ ] No command crosses an answer, approach, brief approval, or plan approval boundary automatically.
- [ ] Initial and planning-gap budgets are deterministic.
- [ ] Rejected model output changes neither counters nor stages.
- [ ] Secret-like answer bytes do not enter ordinary artifacts, prompts, progress, or GitHub.
- [ ] Brief and plan hashes are verified from canonical bytes on execution and resume.
- [ ] GitHub projection contains only generic discovery status.
- [ ] The stable package includes the prompt and remains independent of the mutable checkout.
