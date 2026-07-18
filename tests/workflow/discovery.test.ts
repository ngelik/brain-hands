import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CodexInvocationError, type CodexAdapter, type CodexInvokeInput, type CodexInvokeResult } from "../../src/adapters/codex.js";
import {
  readDiscoveryPendingAction,
  recordDiscoveryAnswer,
  recordDiscoveryProceedIntent,
  rejectDiscoveryBrief,
  selectDiscoveryApproach,
} from "../../src/core/discovery-ledger.js";
import { DiscoveryValidationError } from "../../src/core/discovery.js";
import { createRunLedgerV2, readManifestV2, transitionRun } from "../../src/core/ledger.js";
import type {
  DiscoveryApproach,
  DiscoveryBrief,
  DiscoveryOutcome,
  DiscoveryQuestion,
  PlanningDiscoveryGap,
  ResolvedRunIntake,
} from "../../src/core/types.js";
import type { ProgressIntent } from "../../src/progress/events.js";
import type { ProgressReporter } from "../../src/progress/log.js";
import { openProgressReporter, readProgressEvents } from "../../src/progress/log.js";
import { reopenDiscoveryFromPlanningGap, runDiscoveryTurn } from "../../src/workflow/discovery.js";
const codexMetrics = { usage: null, durationMs: 0, processStarted: false, turnStarted: false, structuredTerminalError: false } as const;

const question: DiscoveryQuestion = {
  id: "q-001",
  sequence: 1,
  category: "required",
  text: "Should discovery run for every new workflow?",
  choices: [
    { id: "always", label: "Always", description: "Run discovery for every request." },
    { id: "ambiguous", label: "When ambiguous", description: "Discover only ambiguous requests." },
  ],
  recommended_choice_id: "always",
  recommendation_rationale: "It keeps material workflow choices explicit.",
  rationale: "This changes the workflow boundary.",
  material_effects: ["scope"],
  repository_evidence: ["src/core/run-state.ts"],
  essential_after_soft_limit: null,
};

const approaches: DiscoveryApproach[] = [
  {
    id: "approach-always",
    title: "Always discover",
    summary: "Run discovery before every plan.",
    tradeoffs: ["Adds one approval boundary."],
    recommended: true,
    recommendation_rationale: "It is deterministic.",
  },
  {
    id: "approach-ambiguous",
    title: "Discover when ambiguous",
    summary: "Skip discovery for apparently simple requests.",
    tradeoffs: ["Requires an ambiguity classifier."],
    recommended: false,
    recommendation_rationale: null,
  },
];

const brief: DiscoveryBrief = {
  revision: 1,
  goal: "Persist discovery",
  problem: "Planning starts without a durable discovery boundary.",
  success_criteria: ["Approval pins the exact brief bytes."],
  constraints: ["Keep discovery local."],
  decisions: [],
  assumptions: [],
  selected_approach_id: null,
  selected_approach_rationale: null,
  out_of_scope: ["CLI integration"],
  accepted_risks: [],
  repository_evidence: ["src/core/discovery-ledger.ts"],
};

function intake(repoRoot: string): ResolvedRunIntake {
  return {
    task: "Add durable discovery",
    repo_root: repoRoot,
    mode: "local",
    research: false,
    reflection: false,
    models: { brain: "brain-model", hands: "hands-model", verifier: "verifier-model" },
    resolved_models: { brain: "brain-model", hands: "hands-model", verifier: "verifier-model" },
    roles: {
      brain: { model: "brain-model", reasoning_effort: "high", sandbox: "read-only" },
      hands: { model: "hands-model", reasoning_effort: "medium", sandbox: "workspace-write" },
      verifier: { model: "verifier-model", reasoning_effort: "high", sandbox: "read-only" },
    },
  };
}

type QueuedResult = DiscoveryOutcome | Error;

class QueuedBrain implements CodexAdapter {
  readonly calls: CodexInvokeInput[] = [];

  constructor(private readonly results: QueuedResult[]) {}

  async invoke(input: CodexInvokeInput): Promise<CodexInvokeResult> {
    this.calls.push(input);
    const next = this.results.shift();
    if (next instanceof Error) throw next;
    if (!next) throw new Error("No queued Brain result");
    return {
      text: JSON.stringify(next),
      parsed: next,
      exitCode: 0,
      promptPath: join(input.runDir, "prompts", `${input.artifactName}.md`),
      stdoutPath: join(input.runDir, "responses", `${input.artifactName}.stdout.txt`),
      stderrPath: join(input.runDir, "responses", `${input.artifactName}.stderr.txt`),
      ...codexMetrics,
    };
  }
}

class RecordingProgress implements ProgressReporter {
  readonly path = "/tmp/progress.jsonl";
  readonly sessionId = "4ed9e32e-5787-4aac-9cb0-a531037d4b64";
  readonly workerPid = 1;
  readonly intents: ProgressIntent[] = [];

  async emit(intent: ProgressIntent): Promise<null> {
    this.intents.push(intent);
    return null;
  }
}

let repoRoot: string | null = null;

afterEach(async () => {
  if (repoRoot) await rm(repoRoot, { recursive: true, force: true });
  repoRoot = null;
});

async function createDiscoveryRun() {
  repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-discovery-controller-"));
  const resolved = intake(repoRoot);
  const ledger = await createRunLedgerV2({
    repoRoot,
    originalRequest: resolved.task,
    intake: resolved,
    roles: resolved.roles,
  });
  await transitionRun(ledger.runDir, "preflight", { actor: "test" });
  await transitionRun(ledger.runDir, "brain_discovery", { actor: "test" });
  return { ledger, intake: resolved };
}

type ReadyOutcome = Exclude<DiscoveryOutcome, { outcome: "ask_question" }>;

function ready(overrides: Partial<ReadyOutcome> = {}): ReadyOutcome {
  return {
    outcome: "ready_for_brief",
    rationale: "The material choices are known.",
    repository_evidence: ["src/core/discovery-ledger.ts"],
    approaches,
    alternatives_omitted_reason: null,
    brief,
    ...overrides,
  };
}

describe("adaptive Brain discovery", () => {
  it("normalizes the API-compatible wrapped discovery result before persistence", async () => {
    const run = await createDiscoveryRun();
    const outcome: DiscoveryOutcome = { outcome: "ask_question", question };
    const codex: CodexAdapter = {
      async invoke(input) {
        const parsed = input.outputParser?.parse({ result: outcome });
        return {
          text: JSON.stringify({ result: outcome }),
          parsed,
          exitCode: 0,
          promptPath: join(input.runDir, "prompts", `${input.artifactName}.md`),
          stdoutPath: join(input.runDir, "responses", `${input.artifactName}.stdout.txt`),
          stderrPath: join(input.runDir, "responses", `${input.artifactName}.stderr.txt`),
          ...codexMetrics,
        };
      },
    };

    const pending = await runDiscoveryTurn({ runDir: run.ledger.runDir, intake: run.intake, codex });

    expect(pending).toMatchObject({
      state: "awaiting_discovery_answer",
      question: {
        id: "q-001",
        recommended_choice_id: "always",
        recommendation_rationale: "It keeps material workflow choices explicit.",
      },
    });
  });

  it("emits content-free production progress for discovery start and question boundaries", async () => {
    const run = await createDiscoveryRun();
    const progress = new RecordingProgress();
    await runDiscoveryTurn({
      runDir: run.ledger.runDir,
      intake: run.intake,
      codex: new QueuedBrain([{ outcome: "ask_question", question }]),
      progress,
    });
    expect(progress.intents).toEqual([
      { code: "discovery_started", source: "brain" },
      { code: "discovery_question_ready", source: "brain", discoveryCycle: 1, questionSequence: 1 },
    ]);
    expect(JSON.stringify(progress.intents)).not.toContain(question.text);
  });

  it("persists distinct content-free progress events for multiple discovery questions", async () => {
    const run = await createDiscoveryRun();
    const progress = await openProgressReporter({
      runDir: run.ledger.runDir,
      now: () => "2026-07-12T00:00:00.000Z",
    });
    await runDiscoveryTurn({
      runDir: run.ledger.runDir,
      intake: run.intake,
      codex: new QueuedBrain([{ outcome: "ask_question", question }]),
      progress,
    });
    await recordDiscoveryAnswer(run.ledger.runDir, "q-001", "Always");
    const secondQuestion: DiscoveryQuestion = {
      ...question,
      id: "q-002",
      sequence: 2,
      text: "PRIVATE-SECOND-QUESTION?",
    };
    await runDiscoveryTurn({
      runDir: run.ledger.runDir,
      intake: run.intake,
      codex: new QueuedBrain([{ outcome: "ask_question", question: secondQuestion }]),
      progress,
    });

    const events = [];
    for await (const event of readProgressEvents(run.ledger.runDir)) events.push(event);
    expect(events.filter((event) => event.event_key.includes("discovery_question_ready")).map((event) => event.event_key))
      .toEqual([
        "brain:discovery_question_ready:cycle:1:question:1",
        "brain:discovery_question_ready:cycle:1:question:2",
      ]);
    expect(JSON.stringify(events)).not.toContain("PRIVATE-SECOND-QUESTION");
  });

  it("retries one validation failure with the same sequence and persists only the valid question", async () => {
    const run = await createDiscoveryRun();
    const rejectedSentinel = "REJECTED_RAW_SENTINEL_7f4c";
    const codex = new QueuedBrain([
      { outcome: "ask_question", question: { ...question, text: `${rejectedSentinel}?`, material_effects: [] } },
      { outcome: "ask_question", question },
    ]);

    const pending = await runDiscoveryTurn({ runDir: run.ledger.runDir, intake: run.intake, codex });

    expect(codex.calls).toHaveLength(2);
    expect(codex.calls.map((call) => call.artifactName)).toEqual([
      "brain-discovery-cycle-1-turn-1-attempt-1",
      "brain-discovery-cycle-1-turn-1-attempt-2",
    ]);
    expect(codex.calls[1]?.prompt).toContain("material effect");
    expect(codex.calls[1]?.prompt).not.toContain(rejectedSentinel);
    expect(codex.calls[1]?.prompt).not.toContain(JSON.stringify(codex.calls[0]));
    expect(pending).toMatchObject({ state: "awaiting_discovery_answer", question: { id: "q-001" } });
    expect((await readManifestV2(run.ledger.runDir)).discovery?.asked_questions).toBe(1);
    expect(await readFile(join(run.ledger.runDir, "discovery/questions/001.json"), "utf8"))
      .toContain('"id": "q-001"');
  });

  it("retries a generated question with missing recommendations before persistence", async () => {
    const run = await createDiscoveryRun();
    const { recommended_choice_id: _choice, recommendation_rationale: _rationale, ...invalidQuestion } = question;
    const codex = new QueuedBrain([
      { outcome: "ask_question", question: invalidQuestion },
      { outcome: "ask_question", question },
    ]);

    const pending = await runDiscoveryTurn({ runDir: run.ledger.runDir, intake: run.intake, codex });

    expect(codex.calls).toHaveLength(2);
    expect(codex.calls[1]?.prompt).toContain("recommendation");
    expect(pending).toMatchObject({
      state: "awaiting_discovery_answer",
      question: { recommended_choice_id: "always", recommendation_rationale: "It keeps material workflow choices explicit." },
    });
    expect(await readFile(join(run.ledger.runDir, "discovery/questions/001.json"), "utf8"))
      .toContain('"recommended_choice_id": "always"');
  });

  it("durably forces the next turn to stop questioning and preserve uncertainty", async () => {
    const run = await createDiscoveryRun();
    await runDiscoveryTurn({
      runDir: run.ledger.runDir,
      intake: run.intake,
      codex: new QueuedBrain([{ outcome: "ask_question", question }]),
    });
    await recordDiscoveryProceedIntent(run.ledger.runDir, "q-001", "Assume the safest local boundary");
    const forcedBrief: DiscoveryBrief = {
      ...brief,
      assumptions: [{
        id: "a-001",
        statement: "Operator guidance: Assume the safest local boundary",
        source: "proceed_with_assumptions",
        source_question_ids: ["q-001"],
      }],
    };
    const codex = new QueuedBrain([
      ready({
        approaches: [],
        alternatives_omitted_reason: "An unrelated risk does not preserve the forced choice.",
        brief: { ...brief, accepted_risks: ["An unrelated dependency may change."] },
      }),
      ready({
        approaches: [],
        alternatives_omitted_reason: "Proceeding fixes the boundary as an explicit assumption.",
        brief: forcedBrief,
      }),
    ]);

    const pending = await runDiscoveryTurn({ runDir: run.ledger.runDir, intake: run.intake, codex });

    expect(codex.calls).toHaveLength(2);
    expect(codex.calls[0]?.prompt).toContain('"proceed_with_assumptions"');
    expect(codex.calls[0]?.prompt).toContain('"can_ask": false');
    expect(codex.calls[1]?.prompt).toContain("linked proceed-sourced assumption");
    expect(pending).toMatchObject({ state: "awaiting_discovery_brief_approval", revision: 1 });
    expect(await readManifestV2(run.ledger.runDir)).toMatchObject({
      discovery: {
        asked_questions: 1,
        answered_questions: 1,
        proceed_with_assumptions: {
          cycle: 1,
          question_id: "q-001",
          path: "discovery/proceed-with-assumptions.json",
        },
      },
    });
    expect(JSON.parse(await readFile(
      join(run.ledger.runDir, "discovery/proceed-with-assumptions.json"),
      "utf8",
    ))).toEqual({
      cycle: 1,
      question_id: "q-001",
      guidance: "Assume the safest local boundary",
    });
  });

  it("retries a production-wrapped output validation failure exactly once", async () => {
    const run = await createDiscoveryRun();
    const codex = new QueuedBrain([
      new CodexInvocationError("Codex output failed schema validation", undefined, undefined, {
        kind: "output_validation",
        cause: new Error("question contract invalid"),
      }),
      { outcome: "ask_question", question },
    ]);

    await expect(runDiscoveryTurn({ runDir: run.ledger.runDir, intake: run.intake, codex }))
      .resolves.toMatchObject({ state: "awaiting_discovery_answer" });
    expect(codex.calls).toHaveLength(2);
    expect(codex.calls[1]?.prompt).toContain("schema validation");
  });

  it("retries wrong question identity before ledger persistence", async () => {
    const run = await createDiscoveryRun();
    const codex = new QueuedBrain([
      { outcome: "ask_question", question: { ...question, id: "q-999" } },
      { outcome: "ask_question", question },
    ]);

    await runDiscoveryTurn({ runDir: run.ledger.runDir, intake: run.intake, codex });

    expect(codex.calls).toHaveLength(2);
    expect(codex.calls[1]?.prompt).toContain("expected q-001");
  });

  it("fails transport errors immediately without changing discovery state", async () => {
    const run = await createDiscoveryRun();
    const codex = new QueuedBrain([new Error("permission denied"), { outcome: "ask_question", question }]);

    await expect(runDiscoveryTurn({ runDir: run.ledger.runDir, intake: run.intake, codex }))
      .rejects.toThrow("permission denied");

    expect(codex.calls).toHaveLength(1);
    expect(await readManifestV2(run.ledger.runDir)).toMatchObject({
      stage: "brain_discovery",
      discovery: { asked_questions: 0, answered_questions: 0 },
    });
  });

  it("does not retry a typed missing-output invocation failure", async () => {
    const run = await createDiscoveryRun();
    const codex = new QueuedBrain([
      new CodexInvocationError("missing output", undefined, undefined, { kind: "missing_output" }),
      { outcome: "ask_question", question },
    ]);

    await expect(runDiscoveryTurn({ runDir: run.ledger.runDir, intake: run.intake, codex }))
      .rejects.toThrow("missing output");
    expect(codex.calls).toHaveLength(1);
  });

  it("turns no_discovery_needed into a brief approval boundary", async () => {
    const run = await createDiscoveryRun();
    const codex = new QueuedBrain([{
      outcome: "no_discovery_needed",
      rationale: "The request is already exact.",
      repository_evidence: ["src/core/discovery-ledger.ts"],
      approaches: [],
      alternatives_omitted_reason: "There is one mechanically correct implementation.",
      brief,
    }]);

    const pending = await runDiscoveryTurn({ runDir: run.ledger.runDir, intake: run.intake, codex });

    expect(pending).toEqual({
      state: "awaiting_discovery_brief_approval",
      revision: 1,
      brief,
      readiness_revision: 1,
      readiness_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      permitted_next_actions: ["approve-discovery", "revise-discovery"],
    });
    expect((await readManifestV2(run.ledger.runDir)).stage).toBe("awaiting_discovery_brief_approval");
    const readinessPath = join(run.ledger.runDir, "discovery/readiness/revision-001.json");
    expect(JSON.parse(await readFile(readinessPath, "utf8"))).toEqual({
      outcome: "no_discovery_needed",
      rationale: "The request is already exact.",
      repository_evidence: ["src/core/discovery-ledger.ts"],
      approaches: [],
      alternatives_omitted_reason: "There is one mechanically correct implementation.",
      brief,
    });
    const events = (await readFile(join(run.ledger.runDir, "events.jsonl"), "utf8"))
      .split("\n").filter(Boolean).map((line) => JSON.parse(line));
    expect(events).toContainEqual(expect.objectContaining({
      type: "discovery_readiness_recorded",
      payload: expect.objectContaining({
        cycle: 1,
        outcome: "no_discovery_needed",
        brief_revision: 1,
        path: "discovery/readiness/revision-001.json",
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    }));
  });

  it("creates an approach boundary before persisting the proposed brief", async () => {
    const run = await createDiscoveryRun();

    const pending = await runDiscoveryTurn({
      runDir: run.ledger.runDir,
      intake: run.intake,
      codex: new QueuedBrain([ready()]),
    });

    expect(pending).toEqual({
      state: "awaiting_discovery_approach",
      revision: 1,
      approaches,
      permitted_next_actions: ["select-discovery-approach"],
    });
    await expect(readFile(join(run.ledger.runDir, "discovery/briefs/revision-001.json"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("uses the next immutable approach revision after planning-gap reopen", async () => {
    const run = await createDiscoveryRun();
    await runDiscoveryTurn({ runDir: run.ledger.runDir, intake: run.intake, codex: new QueuedBrain([ready()]) });
    await selectDiscoveryApproach(run.ledger.runDir, 1, "approach-always");
    await runDiscoveryTurn({
      runDir: run.ledger.runDir,
      intake: run.intake,
      codex: new QueuedBrain([ready({ brief: {
        ...brief,
        selected_approach_id: "approach-always",
        selected_approach_rationale: "It is deterministic.",
      } })]),
    });
    const revisionOne = await readFile(
      join(run.ledger.runDir, "discovery/approaches/revision-001.json"),
      "utf8",
    );
    await transitionRun(run.ledger.runDir, "brain_planning", { actor: "test" });
    await reopenDiscoveryFromPlanningGap({
      runDir: run.ledger.runDir,
      gap: {
        outcome: "discovery_gap",
        evidence: ["Planning found another material implementation choice."],
        question: { ...question, text: "Which revised implementation boundary should we use?" },
      },
    });
    await recordDiscoveryAnswer(run.ledger.runDir, "cycle-002-q-001", "Use a revised boundary");
    const revisedApproaches = approaches.map((approach, index) => ({
      ...approach,
      id: `${approach.id}-revised`,
      title: `${approach.title} revised`,
      recommended: index === 1,
      recommendation_rationale: index === 1 ? "The planning evidence supports it." : null,
    }));

    const pending = await runDiscoveryTurn({
      runDir: run.ledger.runDir,
      intake: run.intake,
      codex: new QueuedBrain([ready({
        approaches: revisedApproaches,
        brief: {
          ...brief,
          revision: 2,
          decisions: [{ id: "d-001", statement: "Use the revised boundary.", source_question_ids: ["cycle-002-q-001"] }],
        },
      })]),
    });

    expect(pending).toEqual({
      state: "awaiting_discovery_approach",
      revision: 2,
      approaches: revisedApproaches,
      permitted_next_actions: ["select-discovery-approach"],
    });
    expect(await readFile(join(run.ledger.runDir, "discovery/approaches/revision-001.json"), "utf8"))
      .toBe(revisionOne);
    expect(JSON.parse(await readFile(
      join(run.ledger.runDir, "discovery/approaches/revision-002.json"),
      "utf8",
    ))).toEqual({ revision: 2, approaches: revisedApproaches });
    expect(await readManifestV2(run.ledger.runDir)).toMatchObject({
      discovery: { current_approaches_revision: 2, selected_approach_id: null },
    });
  });

  it("preserves the selected approach when a planning gap needs no new alternatives", async () => {
    const run = await createDiscoveryRun();
    await runDiscoveryTurn({ runDir: run.ledger.runDir, intake: run.intake, codex: new QueuedBrain([ready()]) });
    await selectDiscoveryApproach(run.ledger.runDir, 1, "approach-always");
    const selectedBrief = {
      ...brief,
      selected_approach_id: "approach-always",
      selected_approach_rationale: "It is deterministic.",
    };
    await runDiscoveryTurn({
      runDir: run.ledger.runDir,
      intake: run.intake,
      codex: new QueuedBrain([ready({ brief: selectedBrief })]),
    });
    await transitionRun(run.ledger.runDir, "brain_planning", { actor: "test" });
    await reopenDiscoveryFromPlanningGap({
      runDir: run.ledger.runDir,
      gap: {
        outcome: "discovery_gap",
        evidence: ["Planning needs one implementation detail without changing the selected approach."],
        question: { ...question, text: "Which implementation detail should planning use?" },
      },
    });

    expect(await readManifestV2(run.ledger.runDir)).toMatchObject({
      discovery: {
        current_approaches_revision: 1,
        selected_approach_id: "approach-always",
        current_brief_revision: null,
        approved_brief_revision: null,
      },
    });
    await recordDiscoveryAnswer(run.ledger.runDir, "cycle-002-q-001", "Use the existing deterministic boundary");
    const revisedBrief = {
      ...selectedBrief,
      revision: 2,
      goal: "Persist discovery with the planning detail",
      decisions: [{ id: "d-001", statement: "Use the planning detail.", source_question_ids: ["cycle-002-q-001"] }],
    };
    const brain = new QueuedBrain([ready({
      approaches: [],
      alternatives_omitted_reason: "The planning answer does not change the selected approach.",
      brief: revisedBrief,
    })]);

    const pending = await runDiscoveryTurn({ runDir: run.ledger.runDir, intake: run.intake, codex: brain });

    expect(brain.calls[0]?.prompt).toContain('"approach_id": "approach-always"');
    expect(pending).toEqual({
      state: "awaiting_discovery_brief_approval",
      revision: 2,
      brief: revisedBrief,
      readiness_revision: 3,
      readiness_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      permitted_next_actions: ["approve-discovery", "revise-discovery"],
    });
    expect(await readManifestV2(run.ledger.runDir)).toMatchObject({
      stage: "awaiting_discovery_brief_approval",
      discovery: {
        current_approaches_revision: 1,
        selected_approach_id: "approach-always",
        current_brief_revision: 2,
      },
    });
  });

  it("turns a selected approach into the next brief approval boundary", async () => {
    const run = await createDiscoveryRun();
    await runDiscoveryTurn({ runDir: run.ledger.runDir, intake: run.intake, codex: new QueuedBrain([ready()]) });
    const readinessPath = join(run.ledger.runDir, "discovery/readiness/revision-001.json");
    const originalReadiness = await readFile(readinessPath, "utf8");
    await selectDiscoveryApproach(run.ledger.runDir, 1, "approach-always");
    const selectedBrief = {
      ...brief,
      selected_approach_id: "approach-always",
      selected_approach_rationale: "It is deterministic.",
    };

    await writeFile(readinessPath, `${JSON.stringify({ tampered: true }, null, 2)}\n`);
    const tamperedBrain = new QueuedBrain([ready({ brief: selectedBrief })]);
    await expect(runDiscoveryTurn({ runDir: run.ledger.runDir, intake: run.intake, codex: tamperedBrain }))
      .rejects.toThrow(/readiness.*digest|readiness.*bytes/i);
    await writeFile(readinessPath, originalReadiness);
    const eventsPath = join(run.ledger.runDir, "events.jsonl");
    const originalEvents = await readFile(eventsPath, "utf8");
    await writeFile(eventsPath, originalEvents.replace('"outcome":"ready_for_brief"', '"outcome":"no_discovery_needed"'));
    await expect(runDiscoveryTurn({ runDir: run.ledger.runDir, intake: run.intake, codex: tamperedBrain }))
      .rejects.toThrow(/readiness.*immutable event/i);
    await writeFile(eventsPath, originalEvents);
    const selectedBrain = new QueuedBrain([ready({ brief: { ...selectedBrief, selected_approach_id: null, selected_approach_rationale: null } }), ready({ brief: selectedBrief })]);
    const pending = await runDiscoveryTurn({
      runDir: run.ledger.runDir,
      intake: run.intake,
      codex: selectedBrain,
    });

    expect(pending).toEqual({
      state: "awaiting_discovery_brief_approval",
      revision: 1,
      brief: selectedBrief,
      readiness_revision: 2,
      readiness_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      permitted_next_actions: ["approve-discovery", "revise-discovery"],
    });
    expect(selectedBrain.calls).toHaveLength(2);
    expect(selectedBrain.calls[0]?.prompt).toContain('"approach_id": "approach-always"');
    expect(selectedBrain.calls[1]?.prompt).toContain("selected approach approach-always");
    expect(await readFile(readinessPath, "utf8")).toBe(originalReadiness);
    const readinessEvents = (await readFile(join(run.ledger.runDir, "events.jsonl"), "utf8"))
      .split("\n").filter(Boolean).map((line) => JSON.parse(line))
      .filter((event) => event.type === "discovery_readiness_recorded");
    expect(readinessEvents).toHaveLength(2);
  });

  it("includes the rejected brief and reason in the next Brain history", async () => {
    const run = await createDiscoveryRun();
    const noAlternatives = ready({ approaches: [], alternatives_omitted_reason: "Only one material implementation.", brief });
    await runDiscoveryTurn({ runDir: run.ledger.runDir, intake: run.intake, codex: new QueuedBrain([noAlternatives]) });
    await rejectDiscoveryBrief(run.ledger.runDir, 1, "REJECTION_REASON_SENTINEL");
    const revisedBrief = { ...brief, revision: 2, goal: "Persist revised discovery" };
    const brain = new QueuedBrain([
      ready({
        approaches: [],
        alternatives_omitted_reason: "Only one material implementation.",
        brief: { ...revisedBrief, revision: 3 },
      }),
    ]);

    const pending = await runDiscoveryTurn({ runDir: run.ledger.runDir, intake: run.intake, codex: brain });

    expect(brain.calls[0]?.prompt).toContain('"goal": "Persist discovery"');
    expect(brain.calls[0]?.prompt).toContain("REJECTION_REASON_SENTINEL");
    expect(brain.calls).toHaveLength(1);
    expect(pending).toEqual({
      state: "awaiting_discovery_brief_approval",
      revision: 2,
      brief: revisedBrief,
      readiness_revision: 2,
      readiness_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      permitted_next_actions: ["approve-discovery", "revise-discovery"],
    });
    expect(JSON.parse(await readFile(join(run.ledger.runDir, "discovery/briefs/revision-001.json"), "utf8")))
      .toEqual(brief);
    expect(JSON.parse(await readFile(join(run.ledger.runDir, "discovery/briefs/revision-002.json"), "utf8")))
      .toEqual(revisedBrief);
  });

  it("retries invalid recommendation cardinality before persistence", async () => {
    const run = await createDiscoveryRun();
    const codex = new QueuedBrain([
      ready({ approaches: approaches.map((approach) => ({ ...approach, recommended: false })) }),
      ready(),
    ]);

    await runDiscoveryTurn({ runDir: run.ledger.runDir, intake: run.intake, codex });

    expect(codex.calls).toHaveLength(2);
    expect(codex.calls[1]?.prompt).toContain("exactly one recommended approach");
  });

  it("retries an unrecorded selected approach before persisting readiness", async () => {
    const run = await createDiscoveryRun();
    const noAlternatives = {
      approaches: [],
      alternatives_omitted_reason: "The request already names the implementation direction.",
    };
    const codex = new QueuedBrain([
      ready({
        ...noAlternatives,
        brief: {
          ...brief,
          selected_approach_id: "approach-always",
          selected_approach_rationale: "The request names it.",
        },
      }),
      ready({ ...noAlternatives, brief }),
    ]);

    const pending = await runDiscoveryTurn({ runDir: run.ledger.runDir, intake: run.intake, codex });

    expect(codex.calls).toHaveLength(2);
    expect(codex.calls[1]?.prompt).toContain("unrecorded approach selection");
    expect(pending).toMatchObject({
      state: "awaiting_discovery_brief_approval",
      revision: 1,
      brief: { selected_approach_id: null, selected_approach_rationale: null },
    });
    expect((await readManifestV2(run.ledger.runDir)).discovery?.readiness_revisions)
      .toEqual({ "1": expect.objectContaining({ revision: 1 }) });
  });

  it("requires justification for question six and rejects question seven without consuming budget", async () => {
    const run = await createDiscoveryRun();
    for (let sequence = 1; sequence <= 5; sequence += 1) {
      const nextQuestion = {
        ...question,
        id: `q-${String(sequence).padStart(3, "0")}`,
        sequence,
      } as DiscoveryQuestion;
      await runDiscoveryTurn({
        runDir: run.ledger.runDir,
        intake: run.intake,
        codex: new QueuedBrain([{ outcome: "ask_question", question: nextQuestion }]),
      });
      await recordDiscoveryAnswer(run.ledger.runDir, nextQuestion.id, `answer ${sequence}`);
    }
    const sixth = { ...question, id: "q-006", sequence: 6 } as DiscoveryQuestion;
    const justifiedSixth = { ...sixth, essential_after_soft_limit: "Without it, scope remains unsafe." };
    const sixthBrain = new QueuedBrain([
      { outcome: "ask_question", question: sixth },
      { outcome: "ask_question", question: justifiedSixth },
    ]);

    await runDiscoveryTurn({ runDir: run.ledger.runDir, intake: run.intake, codex: sixthBrain });
    await recordDiscoveryAnswer(run.ledger.runDir, "q-006", "answer 6");
    const seventh = { ...question, id: "q-007", sequence: 7 } as DiscoveryQuestion;
    const seventhBrain = new QueuedBrain([
      { outcome: "ask_question", question: seventh },
      { outcome: "ask_question", question: seventh },
    ]);

    await expect(runDiscoveryTurn({ runDir: run.ledger.runDir, intake: run.intake, codex: seventhBrain }))
      .rejects.toBeInstanceOf(DiscoveryValidationError);
    expect(seventhBrain.calls).toHaveLength(2);
    expect(await readManifestV2(run.ledger.runDir)).toMatchObject({
      stage: "brain_discovery",
      delivery_state: "blocked",
      last_blocker: "Brain discovery failed; resume the run to retry from the same durable stage.",
      discovery: { asked_questions: 6, answered_questions: 6 },
    });
    const failures = await readdir(join(run.ledger.runDir, "failures"));
    expect(failures.some((name) => name.startsWith("brain-discovery-"))).toBe(true);
  });

  it("reopens from a planning gap without a Brain call and permits only one adaptive follow-up", async () => {
    const run = await createDiscoveryRun();
    await runDiscoveryTurn({
      runDir: run.ledger.runDir,
      intake: run.intake,
      codex: new QueuedBrain([{ outcome: "ask_question", question }]),
    });
    await recordDiscoveryAnswer(run.ledger.runDir, "q-001", "Initial cycle answer");
    await runDiscoveryTurn({
      runDir: run.ledger.runDir,
      intake: run.intake,
      codex: new QueuedBrain([{
        outcome: "no_discovery_needed",
        rationale: "The request appears exact.",
        repository_evidence: ["src/core/discovery-ledger.ts"],
        approaches: [],
        alternatives_omitted_reason: "No choice is currently visible.",
        brief: {
          ...brief,
          decisions: [{ id: "d-001", statement: "Use the initial answer.", source_question_ids: ["q-001"] }],
        },
      }]),
    });
    await transitionRun(run.ledger.runDir, "brain_planning", { actor: "test" });
    const gapQuestion = { ...question, text: "Which deployment target should planning use?" };
    const gap: PlanningDiscoveryGap = {
      outcome: "discovery_gap",
      evidence: ["src/workflow/planner.ts requires a deployment target"],
      question: gapQuestion,
    };

    const pending = await reopenDiscoveryFromPlanningGap({ runDir: run.ledger.runDir, gap });
    const normalizedGapQuestion = { ...gapQuestion, id: "cycle-002-q-001" };

    expect(pending).toEqual({
      state: "awaiting_discovery_answer",
      question: normalizedGapQuestion,
      permitted_next_actions: ["answer-discovery", "proceed-discovery"],
    });
    expect(JSON.parse(await readFile(join(run.ledger.runDir, "discovery/questions/001.json"), "utf8")))
      .toEqual(question);
    expect(JSON.parse(await readFile(join(run.ledger.runDir, "discovery/cycles/002/questions/001.json"), "utf8")))
      .toEqual(normalizedGapQuestion);
    expect(await readFile(join(run.ledger.runDir, "discovery/planning-gaps/cycle-002.json"), "utf8"))
      .toContain("requires a deployment target");
    await recordDiscoveryAnswer(run.ledger.runDir, "cycle-002-q-001", "Use the existing target");
    expect(JSON.parse(await readFile(join(run.ledger.runDir, "discovery/answers/001.json"), "utf8")))
      .toEqual({ question_id: "q-001", answer: "Initial cycle answer" });
    expect(JSON.parse(await readFile(join(run.ledger.runDir, "discovery/cycles/002/answers/001.json"), "utf8")))
      .toEqual({ question_id: "cycle-002-q-001", answer: "Use the existing target" });
    const followUp = { ...question, id: "cycle-002-q-002", sequence: 2 } as DiscoveryQuestion;
    const followUpBrain = new QueuedBrain([{ outcome: "ask_question", question: followUp }]);
    await runDiscoveryTurn({
      runDir: run.ledger.runDir,
      intake: run.intake,
      codex: followUpBrain,
    });
    expect(followUpBrain.calls[0]?.prompt).toContain("Use the existing target");
    expect(followUpBrain.calls[0]?.prompt).toContain("Initial cycle answer");
    expect(followUpBrain.calls[0]?.prompt).toContain('"cycle": 1');
    expect(followUpBrain.calls[0]?.prompt).toContain('"cycle": 2');
    await recordDiscoveryAnswer(run.ledger.runDir, "cycle-002-q-002", "Keep it local");
    const third = { ...question, id: "cycle-002-q-003", sequence: 3 } as DiscoveryQuestion;

    await expect(runDiscoveryTurn({
      runDir: run.ledger.runDir,
      intake: run.intake,
      codex: new QueuedBrain([
        { outcome: "ask_question", question: third },
        { outcome: "ask_question", question: third },
      ]),
    })).rejects.toThrow("hard limit");
    const revisedBrief = {
      ...brief,
      revision: 2,
      goal: "Persist planning-gap discovery",
      decisions: [{ id: "d-001", statement: "Use both planning-gap answers.", source_question_ids: ["cycle-002-q-001", "cycle-002-q-002"] }],
    };
    const briefBrain = new QueuedBrain([
      ready({
        approaches: [],
        alternatives_omitted_reason: "The planning gap is resolved.",
        brief: { ...revisedBrief, revision: 3 },
      }),
    ]);
    const briefPending = await runDiscoveryTurn({
      runDir: run.ledger.runDir,
      intake: run.intake,
      codex: briefBrain,
    });
    expect(briefBrain.calls).toHaveLength(1);
    expect(briefPending).toEqual({
      state: "awaiting_discovery_brief_approval",
      revision: 2,
      brief: revisedBrief,
      readiness_revision: 2,
      readiness_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      permitted_next_actions: ["approve-discovery", "revise-discovery"],
    });
    expect(await readManifestV2(run.ledger.runDir)).toMatchObject({
      stage: "awaiting_discovery_brief_approval",
      discovery: { cycle: 2, cycle_kind: "planning_gap", asked_questions: 2, answered_questions: 2 },
    });
    expect(await readDiscoveryPendingAction(run.ledger.runDir)).toEqual(briefPending);
    const manifestPath = join(run.ledger.runDir, "manifest.json");
    const tamperedManifest = JSON.parse(await readFile(manifestPath, "utf8"));
    delete tamperedManifest.discovery.question_artifacts["cycle-001-question-001"];
    delete tamperedManifest.discovery.answer_artifacts["cycle-001-answer-001"];
    await writeFile(manifestPath, JSON.stringify(tamperedManifest, null, 2));
    await expect(readDiscoveryPendingAction(run.ledger.runDir)).rejects.toThrow(/event|provenance/i);
  });

  it("rejects discovery history whose recorded answer digest no longer matches canonical bytes", async () => {
    const run = await createDiscoveryRun();
    await runDiscoveryTurn({
      runDir: run.ledger.runDir,
      intake: run.intake,
      codex: new QueuedBrain([{ outcome: "ask_question", question }]),
    });
    await recordDiscoveryAnswer(run.ledger.runDir, "q-001", "Always");
    await writeFile(
      join(run.ledger.runDir, "discovery/answers/001.json"),
      `${JSON.stringify({ question_id: "q-001", answer: "Tampered" }, null, 2)}\n`,
    );
    const brain = new QueuedBrain([ready({ approaches: [], alternatives_omitted_reason: "Only one." })]);

    await expect(runDiscoveryTurn({ runDir: run.ledger.runDir, intake: run.intake, codex: brain }))
      .rejects.toThrow(/digest|provenance/i);
    expect(brain.calls).toHaveLength(0);
  });
});
