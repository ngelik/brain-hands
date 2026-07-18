import { z, ZodError } from "zod";
import { CodexInvocationError, type CodexAdapter } from "../adapters/codex.js";
import {
  canonicalDiscoveryJson,
  discoveryHistoryArtifactKey,
  discoverySha256,
  readLatestApprovedDiscoveryBrief,
  readVerifiedDiscoveryQuestionAnswerHistory,
  readVerifiedDiscoveryReadinessHistory,
  readDiscoveryPendingAction,
  recordDiscoveryApproaches,
  recordDiscoveryBrief,
  recordDiscoveryQuestion,
  recordDiscoveryReadiness,
} from "../core/discovery-ledger.js";
import {
  DISCOVERY_OUTPUT_ATTEMPTS,
  DiscoveryValidationError,
  type DiscoveryBriefSemanticContext,
  discoveryApproachSelectionPath,
  discoveryApproachesPath,
  discoveryBriefPath,
  discoveryBriefRejectionPath,
  discoveryPendingActionPath,
  discoveryProceedIntentPath,
  discoveryQuestionId,
  discoveryQuestionPath,
  questionLimit,
  validateDiscoveryOutcome,
} from "../core/discovery.js";
import {
  appendRunEvent,
  readManifestV2,
  withRunLedgerCompoundTransaction,
  writeTextArtifact,
} from "../core/ledger.js";
import { discoveryOutcomeOutputSchema } from "../core/output-schemas.js";
import {
  discoveryApproachSchema,
  discoveryBriefSchema,
  discoveryOutcomeSchema,
  planningDiscoveryGapSchema,
} from "../core/schema.js";
import type {
  DiscoveryManifestState,
  DiscoveryOutcome,
  DiscoveryPendingAction,
  DiscoveryQuestion,
  PlanningDiscoveryGap,
  ResolvedRunIntake,
} from "../core/types.js";
import { readOwnedEvidenceFile } from "../core/owned-evidence.js";
import { loadPromptTemplate } from "../prompts/loader.js";
import { renderTemplate } from "../prompts/renderer.js";
import type { ProgressReporter } from "../progress/log.js";
import type { ResourceBudgetPort } from "../core/resource-budget.js";
import { usesDurableDiscoveryProtocol } from "../core/run-state.js";
import { brainInvocationArtifactName, clearBrainFailure, recordBrainFailure } from "./brain-failure.js";

const discoveryInvocationOutputParser = z.union([
  z.object({ result: discoveryOutcomeSchema }).strict().transform(({ result }) => result),
  discoveryOutcomeSchema,
]);

export interface RunDiscoveryTurnInput {
  runDir: string;
  intake: ResolvedRunIntake;
  codex: CodexAdapter;
  progress?: ProgressReporter;
  budget?: ResourceBudgetPort;
}

export interface ReopenDiscoveryFromPlanningGapInput {
  runDir: string;
  gap: PlanningDiscoveryGap;
  progress?: ProgressReporter;
}

interface DiscoveryPromptContext {
  template: string;
  intake: ResolvedRunIntake;
  state: DiscoveryManifestState;
  history: unknown[];
}

function requireDiscoveryState(
  manifest: Awaited<ReturnType<typeof readManifestV2>>,
): DiscoveryManifestState {
  if (!usesDurableDiscoveryProtocol(manifest.workflow_protocol) || manifest.discovery === null) {
    throw new Error("Brain discovery requires durable discovery protocol");
  }
  if (manifest.stage !== "brain_discovery") {
    throw new Error(`Brain discovery turn requires brain_discovery stage, got ${manifest.stage}`);
  }
  return manifest.discovery;
}

function validateMaterialQuestion(question: DiscoveryQuestion): void {
  if (question.material_effects.length === 0) {
    throw new DiscoveryValidationError("Discovery question must identify at least one material effect");
  }
}

async function readHistoryArtifact(runDir: string, relativePath: string): Promise<string> {
  return (await readOwnedEvidenceFile(runDir, relativePath, "discovery/")).toString("utf8");
}

async function readOptionalHistoryArtifact(runDir: string, relativePath: string): Promise<string | null> {
  return readHistoryArtifact(runDir, relativePath).catch((error: unknown) => {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
    throw error;
  });
}

function parseCanonicalHistory<T>(text: string, schema: z.ZodType<T>, relativePath: string): T {
  const parsed = schema.parse(JSON.parse(text));
  if (text !== canonicalDiscoveryJson(parsed)) {
    throw new Error(`Discovery history artifact is not canonical: ${relativePath}`);
  }
  return parsed;
}

async function readDiscoveryHistory(
  runDir: string,
  state: DiscoveryManifestState,
): Promise<{
  entries: unknown[];
  proceedGuidance: string | null;
  semanticContext: DiscoveryBriefSemanticContext;
}> {
  const history: unknown[] = [];
  let proceedGuidance: string | null = null;
  const questionAnswers = await readVerifiedDiscoveryQuestionAnswerHistory(runDir, state);
  history.push(...questionAnswers);
  history.push(...await readVerifiedDiscoveryReadinessHistory(runDir, state));

  if (state.proceed_with_assumptions !== null) {
    const intent = state.proceed_with_assumptions;
    const intentPath = discoveryProceedIntentPath(state.cycle);
    if (intent.cycle !== state.cycle || intent.path !== intentPath) {
      throw new Error("Discovery proceed-with-assumptions intent path is not canonical");
    }
    const recordedIntent = parseCanonicalHistory(
      await readHistoryArtifact(runDir, intentPath),
      z.object({
        cycle: z.literal(state.cycle),
        question_id: z.literal(intent.question_id),
        guidance: z.string().min(1),
      }).strict(),
      intentPath,
    );
    proceedGuidance = recordedIntent.guidance;
    history.push({ proceed_with_assumptions: recordedIntent });
  }

  if (state.current_approaches_revision !== null) {
    const revision = state.current_approaches_revision;
    const approachesPath = discoveryApproachesPath(revision);
    history.push(parseCanonicalHistory(
      await readHistoryArtifact(runDir, approachesPath),
      z.object({ revision: z.literal(revision), approaches: z.array(discoveryApproachSchema) }).strict(),
      approachesPath,
    ));
    if (state.selected_approach_id !== null) {
      const selectionPath = discoveryApproachSelectionPath(revision);
      history.push(parseCanonicalHistory(
        await readHistoryArtifact(runDir, selectionPath),
        z.object({ revision: z.literal(revision), approach_id: z.literal(state.selected_approach_id) }).strict(),
        selectionPath,
      ));
    }
  }

  const recordedRevisions = Object.values(state.brief_revisions).map((record) => record.revision);
  const briefRevision = state.current_brief_revision ?? (recordedRevisions.length > 0 ? Math.max(...recordedRevisions) : null);
  if (briefRevision !== null) {
    const record = state.brief_revisions[String(briefRevision)];
    const canonicalPath = discoveryBriefPath(briefRevision);
    if (!record || record.path !== canonicalPath) {
      throw new Error(`Discovery brief revision ${briefRevision} is not recorded at its canonical path`);
    }
    const briefText = await readHistoryArtifact(runDir, canonicalPath);
    const recordedBrief = parseCanonicalHistory(briefText, discoveryBriefSchema, canonicalPath);
    if (recordedBrief.revision !== briefRevision || discoverySha256(briefText) !== record.sha256) {
      throw new Error(`Discovery brief revision ${briefRevision} does not match its recorded digest`);
    }
    history.push(recordedBrief);
    const rejectionPath = discoveryBriefRejectionPath(briefRevision);
    const rejection = await readOptionalHistoryArtifact(runDir, rejectionPath);
    if (rejection !== null) {
      history.push(parseCanonicalHistory(
        rejection,
        z.object({ revision: z.literal(briefRevision), reason: z.string().min(1) }).strict(),
        rejectionPath,
      ));
    }
  }
  return {
    entries: history,
    proceedGuidance,
    semanticContext: {
      answered_question_ids: [...new Set(questionAnswers.flatMap((entry) =>
        entry.kind === "answer" ? [entry.question_id] : []))],
      current_cycle_answered_question_ids: [...new Set(questionAnswers.flatMap((entry) =>
        entry.kind === "answer" && entry.cycle === state.cycle ? [entry.question_id] : []))],
      prior_approved_brief: await readLatestApprovedDiscoveryBrief(runDir, state),
    },
  };
}

function renderDiscoveryPrompt(context: DiscoveryPromptContext, validationFailure: string | null): string {
  const limit = questionLimit(context.state);
  return renderTemplate(context.template, {
    original_request: context.intake.task,
    repo_root: context.intake.repo_root,
    discovery_state: JSON.stringify(context.state, null, 2),
    discovery_history: JSON.stringify(context.history, null, 2),
    question_budget: JSON.stringify({
      can_ask: limit.canAsk,
      requires_justification: limit.requiresJustification,
      next_sequence: context.state.asked_questions + 1,
    }, null, 2),
    validation_failure: validationFailure ?? "none",
  });
}

async function requirePendingAction(runDir: string): Promise<DiscoveryPendingAction> {
  const pending = await readDiscoveryPendingAction(runDir);
  if (pending === null) throw new Error("Discovery outcome did not create a pending action");
  return pending;
}

async function persistValidatedOutcome(
  runDir: string,
  outcome: DiscoveryOutcome,
  state: DiscoveryManifestState,
): Promise<DiscoveryPendingAction> {
  if (outcome.outcome === "ask_question") {
    await recordDiscoveryQuestion(runDir, outcome.question);
    return requirePendingAction(runDir);
  }

  const recordedRevisions = Object.keys(state.brief_revisions)
    .map(Number)
    .filter((revision) => Number.isInteger(revision) && revision > 0);
  const expectedRevision = recordedRevisions.length > 0 ? Math.max(...recordedRevisions) + 1 : 1;
  const normalizedOutcome = {
    ...outcome,
    brief: { ...outcome.brief, revision: expectedRevision },
  };

  await recordDiscoveryReadiness(runDir, normalizedOutcome);

  if (normalizedOutcome.approaches.length > 0 && (
    state.selected_approach_id === null || state.cycle_kind === "planning_gap"
  )) {
    const revision = (state.current_approaches_revision ?? 0) + 1;
    await recordDiscoveryApproaches(runDir, revision, normalizedOutcome.approaches);
    return requirePendingAction(runDir);
  }

  await recordDiscoveryBrief(runDir, normalizedOutcome.brief);
  return requirePendingAction(runDir);
}

export async function runDiscoveryTurn(input: RunDiscoveryTurnInput): Promise<DiscoveryPendingAction> {
  const manifest = await readManifestV2(input.runDir);
  const state = requireDiscoveryState(manifest);
  const template = await loadPromptTemplate("brain-discovery-v1");
  const discoveryHistory = await readDiscoveryHistory(input.runDir, state);
  const context: DiscoveryPromptContext = {
    template,
    intake: input.intake,
    state,
    history: discoveryHistory.entries,
  };
  const brainProfile = input.intake.roles.brain;
  if (state.cycle === 1 && state.asked_questions === 0) {
    await input.progress?.emit({ code: "discovery_started", source: "brain" });
  }
  let validationFailure: string | null = null;
  for (let attempt = 1; attempt <= DISCOVERY_OUTPUT_ATTEMPTS; attempt += 1) {
    const prompt = renderDiscoveryPrompt(context, validationFailure);
    const baseArtifactName = `brain-discovery-cycle-${state.cycle}-turn-${state.asked_questions + 1}-attempt-${attempt}`;
    const artifactName = await brainInvocationArtifactName(input.runDir, "discovery", baseArtifactName);
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
        artifactName,
        budget: input.budget,
        attemptKey: `brain:discovery:${state.cycle}:${state.asked_questions + 1}`,
        outputSchema: discoveryOutcomeOutputSchema,
        outputParser: discoveryInvocationOutputParser,
      });
      const parsed = discoveryOutcomeSchema.parse(result.parsed) as DiscoveryOutcome;
      if (parsed.outcome === "ask_question") validateMaterialQuestion(parsed.question);
      const outcome = validateDiscoveryOutcome(
        parsed,
        state,
        discoveryHistory.proceedGuidance,
        discoveryHistory.semanticContext,
      );
      const pending = await persistValidatedOutcome(input.runDir, outcome, state);
      if (pending.state === "awaiting_discovery_answer") {
        await input.progress?.emit({
          code: "discovery_question_ready",
          source: "brain",
          discoveryCycle: state.cycle,
          questionSequence: pending.question.sequence,
        });
      } else if (pending.state === "awaiting_discovery_brief_approval") {
        await input.progress?.emit({ code: "discovery_brief_ready", source: "brain", revision: pending.revision });
      }
      await clearBrainFailure(input.runDir, "discovery");
      return pending;
    } catch (error) {
      const retryable = error instanceof ZodError
        || error instanceof DiscoveryValidationError
        || (error instanceof CodexInvocationError && error.kind === "output_validation");
      if (!retryable) {
        await recordBrainFailure({
          runDir: input.runDir, phase: "discovery", cycle: state.cycle,
          turn: state.asked_questions + 1, attempt, error,
          evidence_refs: [`prompts/${artifactName}.md`, `schemas/${artifactName}.json`, `responses/${artifactName}.json`],
        });
        throw error;
      }
      validationFailure = error instanceof Error ? error.message : String(error);
      if (attempt === DISCOVERY_OUTPUT_ATTEMPTS) {
        await recordBrainFailure({
          runDir: input.runDir, phase: "discovery", cycle: state.cycle,
          turn: state.asked_questions + 1, attempt, error,
          evidence_refs: [`prompts/${artifactName}.md`, `schemas/${artifactName}.json`, `responses/${artifactName}.json`],
        });
        throw error;
      }
    }
  }
  throw new Error("Discovery retry loop exhausted without a result");
}

function planningGapPath(cycle: number): string {
  return `discovery/planning-gaps/cycle-${String(cycle).padStart(3, "0")}.json`;
}

async function persistFixedArtifact(runDir: string, relativePath: string, content: string): Promise<void> {
  const existing = await readHistoryArtifact(runDir, relativePath).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (existing !== null) {
    if (existing !== content) throw new Error(`Discovery artifact conflicts with recorded content: ${relativePath}`);
    return;
  }
  await writeTextArtifact(runDir, relativePath, content);
}

export async function reopenDiscoveryFromPlanningGap(
  input: ReopenDiscoveryFromPlanningGapInput,
): Promise<DiscoveryPendingAction> {
  const gap = planningDiscoveryGapSchema.parse(input.gap) as PlanningDiscoveryGap;
  validateMaterialQuestion(gap.question);
  if (gap.question.sequence !== 1) throw new DiscoveryValidationError("Planning-gap discovery must start at sequence 1");

  await withRunLedgerCompoundTransaction(input.runDir, async (transaction) => {
    const manifest = await transaction.readManifestV2();
    if (!usesDurableDiscoveryProtocol(manifest.workflow_protocol) || manifest.discovery === null) {
      throw new Error("Planning-gap discovery requires durable discovery protocol");
    }
    if (manifest.stage !== "brain_planning") {
      throw new Error(`Planning-gap discovery requires brain_planning stage, got ${manifest.stage}`);
    }
    const cycle = manifest.discovery.cycle + 1;
    const normalizedQuestion = { ...gap.question, id: discoveryQuestionId(cycle, 1) };
    const pending: DiscoveryPendingAction = {
      state: "awaiting_discovery_answer",
      question: normalizedQuestion,
      permitted_next_actions: ["answer-discovery", "proceed-discovery"],
    };
    const questionPath = discoveryQuestionPath(normalizedQuestion.sequence, cycle);
    const questionText = canonicalDiscoveryJson(normalizedQuestion);
    await persistFixedArtifact(
      transaction.runDir,
      planningGapPath(cycle),
      canonicalDiscoveryJson({ outcome: gap.outcome, evidence: gap.evidence, question: normalizedQuestion }),
    );
    await persistFixedArtifact(
      transaction.runDir,
      questionPath,
      questionText,
    );
    await writeTextArtifact(
      transaction.runDir,
      discoveryPendingActionPath(),
      canonicalDiscoveryJson(pending),
    );
    const next = await transaction.updateManifestV2({
      stage: "awaiting_discovery_answer",
      discovery: {
        ...manifest.discovery,
        cycle,
        cycle_kind: "planning_gap",
        asked_questions: 1,
        answered_questions: 0,
        current_question_id: normalizedQuestion.id,
        current_brief_revision: null,
        approved_brief_revision: null,
        approved_brief_sha256: null,
        proceed_with_assumptions: null,
        pending_action_path: discoveryPendingActionPath(),
        question_artifacts: {
          ...manifest.discovery.question_artifacts,
          [discoveryHistoryArtifactKey("question", cycle, normalizedQuestion.sequence)]: {
            cycle,
            sequence: normalizedQuestion.sequence,
            question_id: normalizedQuestion.id,
            path: questionPath,
            sha256: discoverySha256(questionText),
          },
        },
      },
    });
    await appendRunEvent(transaction.runDir, {
      actor: "discovery",
      stage: next.stage,
      type: "planning_gap_discovery_reopened",
      payload: {
        cycle,
        evidence: gap.evidence,
        question_id: normalizedQuestion.id,
        question_path: questionPath,
        question_sha256: discoverySha256(questionText),
      },
    });
  });

  const reopened = await requirePendingAction(input.runDir);
  const reopenedManifest = await readManifestV2(input.runDir);
  if (reopened.state !== "awaiting_discovery_answer" || reopenedManifest.discovery === null) {
    throw new Error("Planning-gap discovery did not persist a question boundary");
  }
  await input.progress?.emit({
    code: "discovery_question_ready",
    source: "brain",
    discoveryCycle: reopenedManifest.discovery.cycle,
    questionSequence: reopened.question.sequence,
  });

  return reopened;
}
