import type { DiscoveryBrief, DiscoveryManifestState, DiscoveryOutcome, DiscoveryQuestion } from "./types.js";

export const INITIAL_DISCOVERY_SOFT_LIMIT = 5;
export const INITIAL_DISCOVERY_HARD_LIMIT = 6;
export const GAP_DISCOVERY_HARD_LIMIT = 2;
export const DISCOVERY_OUTPUT_ATTEMPTS = 2;

export class DiscoveryValidationError extends Error {
  override readonly name = "DiscoveryValidationError";
}

export interface DiscoveryBriefSemanticContext {
  answered_question_ids: string[];
  current_cycle_answered_question_ids: string[];
  prior_approved_brief: DiscoveryBrief | null;
}

function duplicate(values: string[]): string | null {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) return value;
    seen.add(value);
  }
  return null;
}

function preservesOrderedPrior(prior: string[], next: string[]): boolean {
  let cursor = 0;
  for (const value of next) {
    if (value === prior[cursor]) cursor += 1;
  }
  return cursor === prior.length;
}

function validateQuestionRecommendations(question: DiscoveryQuestion): void {
  const recommendedChoiceId = question.recommended_choice_id;
  const recommendationRationale = question.recommendation_rationale;
  if (recommendedChoiceId === undefined || recommendationRationale === undefined) {
    throw new DiscoveryValidationError("Discovery question recommendation fields are required together");
  }
  if (question.choices.length === 0) {
    if (recommendedChoiceId !== null || recommendationRationale !== null) {
      throw new DiscoveryValidationError("Discovery questions without choices require explicit null recommendations");
    }
    return;
  }
  if (recommendedChoiceId === null
    || !question.choices.some((choice) => choice.id === recommendedChoiceId)) {
    throw new DiscoveryValidationError("Discovery question recommended_choice_id must reference an offered choice");
  }
  if (recommendationRationale === null || !recommendationRationale.trim()) {
    throw new DiscoveryValidationError("Discovery question recommendation rationale must contain non-whitespace text");
  }
}

/** Deterministically bind a proposed brief to canonical answered history and prior approval. */
export function validateDiscoveryBriefSemantics(
  brief: DiscoveryBrief,
  context: DiscoveryBriefSemanticContext,
): void {
  const duplicateDecisionId = duplicate(brief.decisions.map((decision) => decision.id));
  if (duplicateDecisionId !== null) throw new DiscoveryValidationError(`Discovery brief has duplicate decision ID ${duplicateDecisionId}`);
  const duplicateAssumptionId = duplicate(brief.assumptions.map((assumption) => assumption.id));
  if (duplicateAssumptionId !== null) throw new DiscoveryValidationError(`Discovery brief has duplicate assumption ID ${duplicateAssumptionId}`);

  const answered = new Set(context.answered_question_ids);
  for (const row of [...brief.decisions, ...brief.assumptions]) {
    const duplicateSource = duplicate(row.source_question_ids);
    if (duplicateSource !== null) {
      throw new DiscoveryValidationError(`${row.id} has duplicate source question ${duplicateSource}`);
    }
    for (const questionId of row.source_question_ids) {
      if (!answered.has(questionId)) throw new DiscoveryValidationError(`${row.id} references unresolved question ${questionId}`);
    }
  }

  const prior = context.prior_approved_brief;
  const priorDecisions = new Map(prior?.decisions.map((decision) => [decision.id, decision]) ?? []);
  const priorAssumptions = new Map(prior?.assumptions.map((assumption) => [assumption.id, assumption]) ?? []);
  const currentAnswers = new Set(context.current_cycle_answered_question_ids);
  const materialRows = [...brief.decisions, ...brief.assumptions].filter((row) => {
    const previous = "source" in row ? priorAssumptions.get(row.id) : priorDecisions.get(row.id);
    return previous === undefined || JSON.stringify(previous) !== JSON.stringify(row);
  });
  for (const questionId of currentAnswers) {
    if (!materialRows.some((row) => row.source_question_ids.includes(questionId))) {
      throw new DiscoveryValidationError(`Discovery brief does not reference current-cycle answer ${questionId}`);
    }
  }

  if (prior === null) return;
  for (const decision of prior.decisions) {
    const next = brief.decisions.find((candidate) => candidate.id === decision.id);
    if (next === undefined) throw new DiscoveryValidationError(`Discovery brief removed confirmed decision ${decision.id}`);
    if (JSON.stringify(next) !== JSON.stringify(decision)
      && !next.source_question_ids.some((questionId) => currentAnswers.has(questionId))) {
      throw new DiscoveryValidationError(`Revised confirmed decision ${decision.id} must cite a current-cycle answer`);
    }
  }
  for (const assumption of prior.assumptions.filter((candidate) => candidate.source === "proceed_with_assumptions")) {
    const next = brief.assumptions.find((candidate) => candidate.id === assumption.id);
    if (next === undefined || JSON.stringify(next) !== JSON.stringify(assumption)) {
      throw new DiscoveryValidationError(`Discovery brief must preserve proceed-sourced assumption ${assumption.id}`);
    }
  }
  if (!preservesOrderedPrior(prior.accepted_risks, brief.accepted_risks)) {
    throw new DiscoveryValidationError("Discovery brief removed or reordered a previously accepted risk");
  }
  if (!preservesOrderedPrior(prior.out_of_scope, brief.out_of_scope)) {
    throw new DiscoveryValidationError("Discovery brief removed or reordered a confirmed out-of-scope item");
  }
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
    current_readiness_revision: null,
    approved_brief_revision: null,
    approved_brief_sha256: null,
    proceed_with_assumptions: null,
    pending_action_path: null,
    question_artifacts: {},
    answer_artifacts: {},
    readiness_revisions: {},
    brief_revisions: {},
  };
}

export function questionLimit(state: DiscoveryManifestState): { canAsk: boolean; requiresJustification: boolean } {
  if (state.proceed_with_assumptions !== null) {
    return { canAsk: false, requiresJustification: false };
  }
  if (state.cycle_kind === "planning_gap") {
    return { canAsk: state.answered_questions < GAP_DISCOVERY_HARD_LIMIT, requiresJustification: false };
  }
  if (state.answered_questions >= INITIAL_DISCOVERY_HARD_LIMIT) {
    return { canAsk: false, requiresJustification: false };
  }
  return {
    canAsk: true,
    requiresJustification: state.answered_questions >= INITIAL_DISCOVERY_SOFT_LIMIT,
  };
}

export function validateDiscoveryOutcome<T extends DiscoveryOutcome>(
  outcome: T,
  state: DiscoveryManifestState,
  proceedGuidance: string | null = null,
  semanticContext: DiscoveryBriefSemanticContext | null = null,
): T {
  const proceedIntent = state.proceed_with_assumptions;
  if (proceedIntent !== null && outcome.outcome === "ask_question") {
    throw new DiscoveryValidationError("Proceed with assumptions forbids further discovery questions");
  }
  if (outcome.outcome !== "ask_question") {
    if (duplicate(outcome.approaches.map((approach) => approach.id)) !== null) {
      throw new DiscoveryValidationError("Discovery readiness contains duplicate approach IDs");
    }
    const alternativesOmitted = outcome.alternatives_omitted_reason !== null;
    const validApproachCount = outcome.approaches.length >= 2 && outcome.approaches.length <= 3;
    if ((alternativesOmitted && outcome.approaches.length !== 0) || (!alternativesOmitted && !validApproachCount)) {
      throw new DiscoveryValidationError("Discovery readiness requires 2-3 approaches or one alternatives_omitted_reason");
    }
    if (outcome.approaches.length > 0 && outcome.approaches.filter((approach) => approach.recommended).length !== 1) {
      throw new DiscoveryValidationError("Discovery readiness requires exactly one recommended approach");
    }
    const recommended = outcome.approaches.find((approach) => approach.recommended);
    if (recommended !== undefined && !recommended.recommendation_rationale?.trim()) {
      throw new DiscoveryValidationError("Recommended discovery approach requires a non-empty recommendation rationale");
    }
    if (state.selected_approach_id === null && outcome.approaches.length === 0 && (
      outcome.brief.selected_approach_id !== null
      || outcome.brief.selected_approach_rationale !== null
    )) {
      throw new DiscoveryValidationError("Discovery brief cannot claim an unrecorded approach selection");
    }
    if (state.selected_approach_id !== null && (
      outcome.approaches.length === 0 || state.cycle_kind !== "planning_gap"
    )) {
      if (outcome.brief.selected_approach_id !== state.selected_approach_id) {
        throw new DiscoveryValidationError(`Discovery brief must use selected approach ${state.selected_approach_id}`);
      }
      if (!outcome.brief.selected_approach_rationale?.trim()) {
        throw new DiscoveryValidationError("Discovery brief requires a non-empty selected approach rationale");
      }
    }
    if (proceedIntent !== null) {
      const proceedAssumption = outcome.brief.assumptions.find((assumption) =>
        assumption.source === "proceed_with_assumptions"
        && assumption.source_question_ids.includes(proceedIntent.question_id));
      if (proceedAssumption === undefined) {
        throw new DiscoveryValidationError(
          "Proceed with assumptions requires a linked proceed-sourced assumption",
        );
      }
      if (proceedGuidance !== null && !proceedAssumption.statement.includes(proceedGuidance)) {
        throw new DiscoveryValidationError(
          "Proceed-sourced assumption must preserve the operator guidance in its statement",
        );
      }
    }
    if (semanticContext !== null) validateDiscoveryBriefSemantics(outcome.brief, semanticContext);
    return outcome;
  }
  if (!/^[^?]*\?$/.test(outcome.question.text) || outcome.question.text.trim() !== outcome.question.text) {
    throw new DiscoveryValidationError("Discovery question text must contain exactly one terminal question mark");
  }
  validateQuestionRecommendations(outcome.question);
  if (duplicate(outcome.question.choices.map((choice) => choice.id)) !== null) {
    throw new DiscoveryValidationError("Discovery question contains duplicate choice IDs");
  }
  const limit = questionLimit(state);
  if (!limit.canAsk) throw new DiscoveryValidationError("Discovery question hard limit reached");
  const expectedSequence = state.asked_questions + 1;
  const expectedId = discoveryQuestionId(state.cycle, expectedSequence);
  if (outcome.question.sequence !== expectedSequence || outcome.question.id !== expectedId) {
    throw new DiscoveryValidationError(`Discovery question expected ${expectedId} at sequence ${expectedSequence}`);
  }
  if (limit.requiresJustification && !outcome.question.essential_after_soft_limit) {
    throw new DiscoveryValidationError("Question " + outcome.question.sequence + " requires essential_after_soft_limit");
  }
  return outcome;
}

function discoverySequence(value: number): string {
  return String(value).padStart(3, "0");
}

export function discoveryQuestionId(cycle: number, sequence: number): string {
  return cycle === 1
    ? `q-${discoverySequence(sequence)}`
    : `cycle-${discoverySequence(cycle)}-q-${discoverySequence(sequence)}`;
}

export function discoveryQuestionSequence(questionId: string, cycle: number): number {
  const match = questionId.match(cycle === 1 ? /^q-(\d{3})$/ : new RegExp(`^cycle-${discoverySequence(cycle)}-q-(\\d{3})$`));
  if (!match) throw new Error(`Discovery question ${questionId} is stale`);
  return Number(match[1]);
}

export function discoveryQuestionPath(sequence: number, cycle = 1): string {
  return cycle === 1
    ? `discovery/questions/${discoverySequence(sequence)}.json`
    : `discovery/cycles/${discoverySequence(cycle)}/questions/${discoverySequence(sequence)}.json`;
}

export function discoveryAnswerPath(sequence: number, cycle = 1): string {
  return cycle === 1
    ? `discovery/answers/${discoverySequence(sequence)}.json`
    : `discovery/cycles/${discoverySequence(cycle)}/answers/${discoverySequence(sequence)}.json`;
}

export function discoveryProceedIntentPath(cycle = 1): string {
  return cycle === 1
    ? "discovery/proceed-with-assumptions.json"
    : `discovery/cycles/${discoverySequence(cycle)}/proceed-with-assumptions.json`;
}

export function discoveryApproachesPath(revision: number): string {
  return `discovery/approaches/revision-${discoverySequence(revision)}.json`;
}

export function discoveryApproachSelectionPath(revision: number): string {
  return `discovery/approaches/revision-${discoverySequence(revision)}-selection.json`;
}

export function discoveryBriefPath(revision: number): string {
  return `discovery/briefs/revision-${discoverySequence(revision)}.json`;
}

export function discoveryReadinessPath(revision: number): string {
  return `discovery/readiness/revision-${discoverySequence(revision)}.json`;
}

export function discoveryBriefRejectionPath(revision: number): string {
  return `discovery/briefs/revision-${discoverySequence(revision)}-rejection.json`;
}

export function discoveryBriefApprovalPath(revision: number): string {
  return `discovery/briefs/revision-${discoverySequence(revision)}-approval.json`;
}

export function approvedDiscoveryBriefPath(): string {
  return "discovery/approved-brief.json";
}

export function discoveryPendingActionPath(): string {
  return "discovery/pending-action.json";
}
