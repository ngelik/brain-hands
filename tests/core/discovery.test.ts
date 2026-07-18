import { describe, expect, it } from "vitest";
import { discoveryManifestStateSchema, discoveryOutcomeSchema } from "../../src/core/schema.js";
import {
  discoveryAnswerPath,
  discoveryApproachesPath,
  discoveryBriefPath,
  discoveryPendingActionPath,
  discoveryQuestionPath,
  initialDiscoveryState,
  questionLimit,
  validateDiscoveryBriefSemantics,
  validateDiscoveryOutcome,
} from "../../src/core/discovery.js";
import type { DiscoveryBrief } from "../../src/core/types.js";

const question = {
  id: "q-001",
  sequence: 1,
  category: "required" as const,
  text: "Should discovery run for every new workflow?",
  choices: [
    { id: "every-run", label: "Every run", description: "Record readiness on every run." },
    { id: "ambiguous-only", label: "Ambiguous only", description: "Skip apparently clear work." },
  ],
  recommended_choice_id: "every-run",
  recommendation_rationale: "It keeps material decisions explicit.",
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

  it.each([
    ["missing choice recommendation", { recommended_choice_id: undefined, recommendation_rationale: "It is material." }, "recommendation fields"],
    ["unknown choice recommendation", { recommended_choice_id: "missing", recommendation_rationale: "It is material." }, "offered choice"],
    ["blank recommendation rationale", { recommended_choice_id: "every-run", recommendation_rationale: "   " }, "non-whitespace"],
  ])("rejects %s before persistence", (_label, recommendation, message) => {
    expect(() => validateDiscoveryOutcome({
      outcome: "ask_question",
      question: { ...question, ...recommendation },
    }, initialDiscoveryState())).toThrow(message);
  });

  it("accepts explicit null recommendations when a question has no choices", () => {
    const noChoiceQuestion = {
      ...question,
      choices: [],
      recommended_choice_id: null,
      recommendation_rationale: null,
    };
    expect(validateDiscoveryOutcome(
      { outcome: "ask_question", question: noChoiceQuestion },
      initialDiscoveryState(),
    )).toEqual({ outcome: "ask_question", question: noChoiceQuestion });
  });

  it("requires justification for question six", () => {
    const state = { ...initialDiscoveryState(), asked_questions: 5, answered_questions: 5 };
    expect(() => validateDiscoveryOutcome(
      { outcome: "ask_question", question: { ...question, id: "q-006", sequence: 6 } },
      state,
    )).toThrow("Question 6 requires essential_after_soft_limit");
  });

  it("requires the exact next question id before persistence", () => {
    expect(() => validateDiscoveryOutcome(
      { outcome: "ask_question", question: { ...question, id: "q-999" } },
      initialDiscoveryState(),
    )).toThrow("expected q-001");
  });

  it("requires cycle-qualified question ids after the initial cycle", () => {
    const state = { ...initialDiscoveryState(), cycle: 2, cycle_kind: "planning_gap" as const };
    expect(() => validateDiscoveryOutcome({ outcome: "ask_question", question }, state))
      .toThrow(/cycle-002-q-001/);
    expect(() => validateDiscoveryOutcome({
      outcome: "ask_question",
      question: { ...question, id: "cycle-002-q-001" },
    }, state)).not.toThrow();
  });

  it("requires a ready brief to echo the selected approach and rationale", () => {
    const state = {
      ...initialDiscoveryState(),
      current_approaches_revision: 1,
      selected_approach_id: "approach-always",
    };
    const base = {
      outcome: "ready_for_brief" as const,
      rationale: "Ready",
      repository_evidence: ["src/core/discovery.ts"],
      approaches: [],
      alternatives_omitted_reason: "The approach was already selected.",
      brief: {
        revision: 1,
        goal: "Persist discovery",
        problem: "Planning needs a durable boundary.",
        success_criteria: ["Pin exact bytes"],
        constraints: [],
        decisions: [],
        assumptions: [],
        selected_approach_id: null,
        selected_approach_rationale: null,
        out_of_scope: [],
        accepted_risks: [],
        repository_evidence: [],
      },
    };
    expect(() => validateDiscoveryOutcome(base, state)).toThrow("selected approach approach-always");
    expect(() => validateDiscoveryOutcome({
      ...base,
      brief: { ...base.brief, selected_approach_id: "approach-always" },
    }, state)).toThrow("non-empty selected approach rationale");
  });

  it("rejects a selected approach that has no durable run-local selection", () => {
    const outcome = {
      outcome: "ready_for_brief" as const,
      rationale: "The request already names an approach.",
      repository_evidence: ["src/core/discovery.ts"],
      approaches: [],
      alternatives_omitted_reason: "The operator supplied the implementation direction.",
      brief: {
        revision: 1,
        goal: "Persist discovery",
        problem: "Planning needs a durable boundary.",
        success_criteria: ["Pin exact bytes"],
        constraints: [], decisions: [], assumptions: [],
        selected_approach_id: "approach-always",
        selected_approach_rationale: "The request names it.",
        out_of_scope: [], accepted_risks: [], repository_evidence: [],
      },
    };

    expect(() => validateDiscoveryOutcome(outcome, initialDiscoveryState()))
      .toThrow("unrecorded approach selection");
  });

  it("requires exactly one recommended approach when alternatives are present", () => {
    const approach = {
      id: "approach-always",
      title: "Always",
      summary: "Always discover.",
      tradeoffs: [],
      recommended: false,
      recommendation_rationale: null,
    };
    const outcome = {
      outcome: "ready_for_brief" as const,
      rationale: "Ready",
      repository_evidence: ["src/core/discovery.ts"],
      approaches: [approach, { ...approach, id: "approach-sometimes" }],
      alternatives_omitted_reason: null,
      brief: {
        revision: 1,
        goal: "Persist discovery",
        problem: "Planning needs a durable boundary.",
        success_criteria: [], constraints: [], decisions: [], assumptions: [],
        selected_approach_id: null, selected_approach_rationale: null,
        out_of_scope: [], accepted_risks: [], repository_evidence: [],
      },
    };
    expect(() => validateDiscoveryOutcome(outcome, initialDiscoveryState())).toThrow("exactly one recommended approach");
    expect(() => validateDiscoveryOutcome({
      ...outcome,
      approaches: outcome.approaches.map((item) => ({ ...item, recommended: true })),
    }, initialDiscoveryState())).toThrow("exactly one recommended approach");
    expect(() => validateDiscoveryOutcome({
      ...outcome,
      approaches: [approach],
      alternatives_omitted_reason: "Only one approach exists.",
    }, initialDiscoveryState())).toThrow("2-3 approaches or one alternatives_omitted_reason");
    expect(() => validateDiscoveryOutcome({
      ...outcome,
      approaches: [{ ...approach, recommended: true }, outcome.approaches[1]],
    }, initialDiscoveryState())).toThrow("recommendation rationale");
    expect(() => validateDiscoveryOutcome({
      ...outcome,
      approaches: [{ ...approach, recommended: true, recommendation_rationale: "Deterministic." }, approach],
    }, initialDiscoveryState())).toThrow(/duplicate approach/i);
  });

  it("rejects multi-question text and duplicate choice IDs", () => {
    expect(() => validateDiscoveryOutcome({
      outcome: "ask_question",
      question: { ...question, text: "Choose this? Or that?" },
    }, initialDiscoveryState())).toThrow("exactly one terminal question mark");
    expect(() => validateDiscoveryOutcome({
      outcome: "ask_question",
      question: { ...question, choices: [question.choices[0], question.choices[0]] },
    }, initialDiscoveryState())).toThrow("duplicate choice IDs");
  });

  it("validates brief references, unique IDs, current answers, and confirmed prior content", () => {
    const prior: DiscoveryBrief = {
      revision: 1,
      goal: "Persist discovery",
      problem: "The planner needs a durable contract.",
      success_criteria: ["The contract remains pinned."],
      constraints: [],
      decisions: [{ id: "d-001", statement: "Use the local engine.", source_question_ids: ["q-001"] }],
      assumptions: [{
        id: "a-001",
        statement: "Proceed with the local-only boundary.",
        source: "proceed_with_assumptions",
        source_question_ids: ["q-001"],
      }],
      selected_approach_id: null,
      selected_approach_rationale: null,
      out_of_scope: ["Remote publication"],
      accepted_risks: ["Local state can be deleted by the operator."],
      repository_evidence: ["src/core/discovery.ts"],
    };
    const context = {
      answered_question_ids: ["q-001", "q-002"],
      current_cycle_answered_question_ids: ["q-002"],
      prior_approved_brief: prior,
    };
    const valid: DiscoveryBrief = {
      ...prior,
      revision: 2,
      decisions: [
        { ...prior.decisions[0], statement: "Use the local engine with resumable planning.", source_question_ids: ["q-002"] },
      ],
      assumptions: [...prior.assumptions, {
        id: "a-002",
        statement: "Planning resumes from its active stage.",
        source: "user_instruction",
        source_question_ids: ["q-002"],
      }],
      out_of_scope: [...prior.out_of_scope, "A hosted transcript"],
      accepted_risks: [...prior.accepted_risks, "A failed model turn needs an operator resume."],
    };
    expect(() => validateDiscoveryBriefSemantics(valid, context)).not.toThrow();
    expect(() => validateDiscoveryBriefSemantics({
      ...valid,
      decisions: [valid.decisions[0], { ...valid.decisions[0] }],
    }, context)).toThrow("duplicate decision ID");
    expect(() => validateDiscoveryBriefSemantics({
      ...valid,
      assumptions: valid.assumptions.map((item) => item.id === "a-002"
        ? { ...item, source_question_ids: ["q-999"] }
        : item),
    }, context)).toThrow("unresolved question");
    expect(() => validateDiscoveryBriefSemantics({
      ...prior,
      revision: 2,
      decisions: prior.decisions,
      assumptions: prior.assumptions,
    }, context)).toThrow("current-cycle answer q-002");
    expect(() => validateDiscoveryBriefSemantics({
      ...valid,
      decisions: [],
      assumptions: valid.assumptions.slice(1),
      out_of_scope: [],
      accepted_risks: [],
    }, context)).toThrow(/confirmed decision d-001|proceed-sourced assumption|out-of-scope|accepted risk/i);
  });

  it("hard-stops question seven", () => {
    expect(questionLimit({ ...initialDiscoveryState(), answered_questions: 6 }))
      .toEqual({ canAsk: false, requiresJustification: false });
  });

  it("defaults older durable discovery state to no forced proceed intent", () => {
    const { proceed_with_assumptions: _omitted, ...persisted } = initialDiscoveryState();
    expect(discoveryManifestStateSchema.parse(persisted).proceed_with_assumptions).toBeNull();
  });

  it("rejects an unrelated accepted risk without a linked proceed assumption", () => {
    const state = {
      ...initialDiscoveryState(),
      asked_questions: 1,
      answered_questions: 1,
      proceed_with_assumptions: {
        cycle: 1,
        question_id: "q-001",
        path: "discovery/proceed-with-assumptions.json",
      },
    };
    expect(() => validateDiscoveryOutcome({
      outcome: "no_discovery_needed",
      rationale: "Proceed now",
      repository_evidence: ["src/core/discovery.ts"],
      approaches: [],
      alternatives_omitted_reason: "The operator forced the remaining choice into the brief.",
      brief: {
        revision: 1,
        goal: "Proceed",
        problem: "One uncertainty remains",
        success_criteria: [], constraints: [], decisions: [], assumptions: [],
        selected_approach_id: null, selected_approach_rationale: null,
        out_of_scope: [], accepted_risks: ["An unrelated dependency may change."], repository_evidence: [],
      },
    }, state, "Assume the safest local boundary")).toThrow("linked proceed-sourced assumption");
  });

  it("accepts a linked proceed assumption that preserves the operator guidance", () => {
    const state = {
      ...initialDiscoveryState(),
      asked_questions: 1,
      answered_questions: 1,
      proceed_with_assumptions: {
        cycle: 1,
        question_id: "q-001",
        path: "discovery/proceed-with-assumptions.json",
      },
    };
    const outcome = {
      outcome: "no_discovery_needed" as const,
      rationale: "Proceed now",
      repository_evidence: ["src/core/discovery.ts"],
      approaches: [],
      alternatives_omitted_reason: "The operator forced the remaining choice into the brief.",
      brief: {
        revision: 1,
        goal: "Proceed",
        problem: "One uncertainty remains",
        success_criteria: [], constraints: [], decisions: [],
        assumptions: [{
          id: "a-001",
          statement: "Operator guidance: Assume the safest local boundary",
          source: "proceed_with_assumptions" as const,
          source_question_ids: ["q-001"],
        }],
        selected_approach_id: null, selected_approach_rationale: null,
        out_of_scope: [], accepted_risks: [], repository_evidence: [],
      },
    };

    expect(validateDiscoveryOutcome(outcome, state, "Assume the safest local boundary")).toEqual(outcome);
  });

  it("uses fixed discovery artifact paths", () => {
    expect(discoveryQuestionPath(1)).toBe("discovery/questions/001.json");
    expect(discoveryAnswerPath(2)).toBe("discovery/answers/002.json");
    expect(discoveryQuestionPath(1, 2)).toBe("discovery/cycles/002/questions/001.json");
    expect(discoveryAnswerPath(1, 2)).toBe("discovery/cycles/002/answers/001.json");
    expect(discoveryApproachesPath(1)).toBe("discovery/approaches/revision-001.json");
    expect(discoveryBriefPath(3)).toBe("discovery/briefs/revision-003.json");
    expect(discoveryPendingActionPath()).toBe("discovery/pending-action.json");
  });
});
