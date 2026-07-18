import { createHash } from "node:crypto";
import { z } from "zod";
import {
  discoveryApproachSchema,
  discoveryBriefSchema,
  discoveryOutcomeSchema,
  discoveryPendingActionSchema,
  discoveryQuestionSchema,
  runEventSchema,
} from "./schema.js";
import {
  approvedDiscoveryBriefPath,
  discoveryAnswerPath,
  discoveryApproachSelectionPath,
  discoveryApproachesPath,
  discoveryBriefApprovalPath,
  discoveryBriefPath,
  discoveryBriefRejectionPath,
  discoveryPendingActionPath,
  discoveryProceedIntentPath,
  discoveryQuestionPath,
  discoveryQuestionId,
  discoveryQuestionSequence,
  discoveryReadinessPath,
  validateDiscoveryBriefSemantics,
} from "./discovery.js";
import {
  appendRunEvent,
  readManifestV2,
  withRunLedgerCompoundTransaction,
  writeTextArtifact,
  type RunManifestV2Ledger,
} from "./ledger.js";
import { assertNoSecretMaterial } from "./secret-detector.js";
import { readOwnedEvidenceFile, readOwnedRunFile } from "./owned-evidence.js";
import { usesDurableDiscoveryProtocol } from "./run-state.js";
import type {
  DiscoveryApproach,
  DiscoveryBrief,
  DiscoveryManifestState,
  DiscoveryPendingAction,
  DiscoveryQuestion,
  DiscoveryOutcome,
} from "./types.js";

const approachesArtifactSchema = z.object({
  revision: z.number().int().positive(),
  approaches: z.array(discoveryApproachSchema),
}).strict().superRefine((artifact, context) => {
  const ids = artifact.approaches.map((approach) => approach.id);
  if (new Set(ids).size !== ids.length) context.addIssue({ code: "custom", path: ["approaches"], message: "Duplicate approach IDs" });
});
const answerArtifactSchema = z.object({
  question_id: z.string().regex(/^(?:q-\d{3}|cycle-\d{3}-q-\d{3})$/),
  answer: z.string().min(1),
}).strict();
const approvalArtifactSchema = z.object({
  revision: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  readiness_revision: z.number().int().positive(),
  readiness_sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export function discoveryHistoryArtifactKey(kind: "question" | "answer", cycle: number, sequence: number): string {
  return `cycle-${String(cycle).padStart(3, "0")}-${kind}-${String(sequence).padStart(3, "0")}`;
}

export function canonicalDiscoveryJson(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}

export function discoverySha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function requireDiscovery(manifest: RunManifestV2Ledger): DiscoveryManifestState {
  if (!usesDurableDiscoveryProtocol(manifest.workflow_protocol) || manifest.discovery === null) {
    throw new Error("Discovery persistence requires durable discovery protocol");
  }
  return manifest.discovery;
}

async function readOptionalArtifact(runDir: string, relativePath: string): Promise<string | null> {
  return readOwnedEvidenceFile(runDir, relativePath, "discovery/")
    .then((bytes) => bytes.toString("utf8"))
    .catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
}

function provenanceRecord(
  kind: "question" | "answer",
  cycle: number,
  sequence: number,
  questionId: string,
  path: string,
  text: string,
) {
  return {
    key: discoveryHistoryArtifactKey(kind, cycle, sequence),
    record: { cycle, sequence, question_id: questionId, path, sha256: discoverySha256(text) },
  };
}

export async function readVerifiedDiscoveryQuestionAnswerHistory(
  runDir: string,
  state: DiscoveryManifestState,
): Promise<Array<{ cycle: number; kind: "question"; question: DiscoveryQuestion } | {
  cycle: number; kind: "answer"; question_id: string; answer: string;
}>> {
  const entries: Array<{ cycle: number; kind: "question"; question: DiscoveryQuestion } | {
    cycle: number; kind: "answer"; question_id: string; answer: string;
  }> = [];
  const questionRecords = Object.values(state.question_artifacts).sort((left, right) =>
    left.cycle - right.cycle || left.sequence - right.sequence);
  const answerRecords = new Map(Object.values(state.answer_artifacts).map((record) => [
    discoveryHistoryArtifactKey("answer", record.cycle, record.sequence),
    record,
  ]));
  const eventLines = (await readOwnedRunFile(runDir, "events.jsonl")).toString("utf8").split("\n").filter(Boolean);
  const manifest = await readManifestV2(runDir);
  const questionEvents = new Map<string, Array<{ path: unknown; sha256: unknown }>>();
  const answerEvents = new Map<string, Array<{ path: unknown; sha256: unknown }>>();
  const addEvent = (target: Map<string, Array<{ path: unknown; sha256: unknown }>>, key: string, value: { path: unknown; sha256: unknown }) => {
    target.set(key, [...(target.get(key) ?? []), value]);
  };
  for (const line of eventLines) {
    const event = runEventSchema.parse(JSON.parse(line));
    if (event.run_id !== manifest.run_id) throw new Error("Discovery immutable event has wrong run_id");
    const payload = event.payload;
    if (event.type === "discovery_question_recorded") {
      const cycle = Number(payload.cycle);
      const sequence = Number(payload.sequence);
      addEvent(questionEvents, discoveryHistoryArtifactKey("question", cycle, sequence), {
        path: payload.path,
        sha256: payload.sha256,
      });
    } else if (event.type === "planning_gap_discovery_reopened") {
      const cycle = Number(payload.cycle);
      addEvent(questionEvents, discoveryHistoryArtifactKey("question", cycle, 1), {
        path: payload.question_path,
        sha256: payload.question_sha256,
      });
    } else if (event.type === "discovery_answer_recorded") {
      const cycle = Number(payload.cycle);
      const sequence = Number(payload.sequence);
      addEvent(answerEvents, discoveryHistoryArtifactKey("answer", cycle, sequence), {
        path: payload.path,
        sha256: payload.sha256,
      });
    } else if (event.type === "discovery_proceed_with_assumptions_recorded") {
      const cycle = Number(payload.cycle);
      const questionId = String(payload.question_id);
      const sequence = discoveryQuestionSequence(questionId, cycle);
      addEvent(answerEvents, discoveryHistoryArtifactKey("answer", cycle, sequence), {
        path: payload.answer_path,
        sha256: payload.answer_sha256,
      });
    }
  }
  if (questionRecords.length === 0 && state.asked_questions > 0) {
    throw new Error("Discovery question provenance is missing for durable history");
  }
  const seen = new Set<string>();
  const seenQuestionIds = new Set<string>();
  for (const record of questionRecords) {
    const key = discoveryHistoryArtifactKey("question", record.cycle, record.sequence);
    const expectedId = discoveryQuestionId(record.cycle, record.sequence);
    const expectedPath = discoveryQuestionPath(record.sequence, record.cycle);
    if (seen.has(key) || seenQuestionIds.has(record.question_id) || state.question_artifacts[key] !== record) {
      throw new Error(`Discovery question provenance key is invalid: ${key}`);
    }
    seen.add(key);
    seenQuestionIds.add(record.question_id);
    if (record.question_id !== expectedId || record.path !== expectedPath) {
      throw new Error(`Discovery question provenance does not match cycle ${record.cycle} sequence ${record.sequence}`);
    }
    const questionEvent = questionEvents.get(key) ?? [];
    if (questionEvent.length !== 1 || questionEvent[0]?.path !== record.path || questionEvent[0]?.sha256 !== record.sha256) {
      throw new Error(`Discovery question provenance does not match its immutable event: ${key}`);
    }
    questionEvents.delete(key);
    const text = await readOptionalArtifact(runDir, record.path);
    if (text === null) throw new Error(`Discovery question provenance artifact is missing: ${record.path}`);
    const question = discoveryQuestionSchema.parse(JSON.parse(text)) as DiscoveryQuestion;
    if (
      text !== canonicalDiscoveryJson(question)
      || question.id !== expectedId
      || question.sequence !== record.sequence
      || discoverySha256(text) !== record.sha256
    ) throw new Error(`Discovery question provenance digest or canonical bytes are invalid: ${record.path}`);
    entries.push({ cycle: record.cycle, kind: "question", question });

    const answerKey = discoveryHistoryArtifactKey("answer", record.cycle, record.sequence);
    const answerRecord = answerRecords.get(answerKey);
    if (answerRecord === undefined) continue;
    if (
      state.answer_artifacts[answerKey] !== answerRecord
      || answerRecord.cycle !== record.cycle
      || answerRecord.sequence !== record.sequence
      || answerRecord.question_id !== expectedId
      || answerRecord.path !== discoveryAnswerPath(record.sequence, record.cycle)
    ) throw new Error(`Discovery answer provenance does not match ${answerKey}`);
    const answerEvent = answerEvents.get(answerKey) ?? [];
    if (answerEvent.length !== 1 || answerEvent[0]?.path !== answerRecord.path || answerEvent[0]?.sha256 !== answerRecord.sha256) {
      throw new Error(`Discovery answer provenance does not match its immutable event: ${answerKey}`);
    }
    answerEvents.delete(answerKey);
    const answerText = await readOptionalArtifact(runDir, answerRecord.path);
    if (answerText === null) throw new Error(`Discovery answer provenance artifact is missing: ${answerRecord.path}`);
    const answer = answerArtifactSchema.parse(JSON.parse(answerText));
    if (
      answerText !== canonicalDiscoveryJson(answer)
      || answer.question_id !== expectedId
      || discoverySha256(answerText) !== answerRecord.sha256
    ) throw new Error(`Discovery answer provenance digest or canonical bytes are invalid: ${answerRecord.path}`);
    entries.push({ cycle: record.cycle, kind: "answer", ...answer });
    answerRecords.delete(answerKey);
  }
  if (answerRecords.size > 0) throw new Error("Discovery answer provenance has no matching question");
  if (questionEvents.size > 0 || answerEvents.size > 0) {
    throw new Error("Discovery immutable events have missing question or answer provenance");
  }
  for (let cycle = 1; cycle <= state.cycle; cycle += 1) {
    const cycleQuestions = questionRecords.filter((record) => record.cycle === cycle);
    const cycleAnswers = Object.values(state.answer_artifacts).filter((record) => record.cycle === cycle);
    if (cycleQuestions.some((record, index) => record.sequence !== index + 1)) {
      throw new Error(`Discovery question provenance is not contiguous for cycle ${cycle}`);
    }
    if (cycle < state.cycle && cycleAnswers.length !== cycleQuestions.length) {
      throw new Error(`Discovery answer provenance is incomplete for prior cycle ${cycle}`);
    }
    if (cycle === state.cycle && (
      cycleQuestions.length !== state.asked_questions
      || cycleAnswers.length !== state.answered_questions
    )) throw new Error("Discovery provenance does not match current cycle counters");
  }
  return entries;
}

export async function readVerifiedDiscoveryReadinessHistory(
  runDir: string,
  state: DiscoveryManifestState,
): Promise<Array<{ kind: "readiness"; revision: number; outcome: Exclude<DiscoveryOutcome, { outcome: "ask_question" }> }>> {
  const manifest = await readManifestV2(runDir);
  const events = (await readOwnedRunFile(runDir, "events.jsonl")).toString("utf8")
    .split("\n").filter(Boolean)
    .map((line) => runEventSchema.parse(JSON.parse(line)))
    .map((event) => {
      if (event.run_id !== manifest.run_id) throw new Error("Discovery readiness event has wrong run_id");
      return event;
    })
    .filter((event) => event.type === "discovery_readiness_recorded");
  const entries: Array<{
    kind: "readiness";
    revision: number;
    outcome: Exclude<DiscoveryOutcome, { outcome: "ask_question" }>;
  }> = [];
  for (const record of Object.values(state.readiness_revisions).sort((left, right) => left.revision - right.revision)) {
    const expectedPath = discoveryReadinessPath(record.revision);
    const text = await readOptionalArtifact(runDir, expectedPath);
    if (text === null) throw new Error(`Discovery readiness revision ${record.revision} artifact is missing`);
    let outcome: DiscoveryOutcome;
    try {
      outcome = discoveryOutcomeSchema.parse(JSON.parse(text)) as DiscoveryOutcome;
    } catch (error) {
      throw new Error(`Discovery readiness revision ${record.revision} canonical bytes are invalid`, { cause: error });
    }
    if (
      outcome.outcome === "ask_question"
      || record.path !== expectedPath
      || text !== canonicalDiscoveryJson(outcome)
      || discoverySha256(text) !== record.sha256
    ) throw new Error(`Discovery readiness revision ${record.revision} digest or canonical bytes are invalid`);
    const matches = events.filter((event) => Number(event.payload.readiness_revision ?? event.payload.brief_revision) === record.revision
      && event.payload.path === record.path
      && event.payload.sha256 === record.sha256
      && event.payload.outcome === outcome.outcome
      && event.payload.brief_revision === outcome.brief.revision
      && Number.isInteger(event.payload.cycle)
      && Number(event.payload.cycle) >= 1
      && Number(event.payload.cycle) <= state.cycle);
    if (matches.length !== 1) {
      throw new Error(`Discovery readiness revision ${record.revision} does not match one immutable event`);
    }
    entries.push({ kind: "readiness", revision: record.revision, outcome });
  }
  if (events.length !== entries.length) throw new Error("Discovery readiness event has no manifest provenance");
  return entries;
}

async function persistFixedArtifact(runDir: string, relativePath: string, content: string): Promise<void> {
  const existing = await readOptionalArtifact(runDir, relativePath);
  if (existing !== null) {
    if (existing !== content) throw new Error(`Discovery artifact conflicts with recorded content: ${relativePath}`);
    return;
  }
  await writeTextArtifact(runDir, relativePath, content);
}

async function persistPendingAction(runDir: string, pending: DiscoveryPendingAction): Promise<void> {
  await writeTextArtifact(runDir, discoveryPendingActionPath(), canonicalDiscoveryJson(pending));
}

async function appendDiscoveryEvent(
  runDir: string,
  stage: RunManifestV2Ledger["stage"],
  type: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await appendRunEvent(runDir, { actor: "discovery", stage, type, payload });
}

async function validateBriefAgainstDurableContext(
  runDir: string,
  state: DiscoveryManifestState,
  brief: DiscoveryBrief,
): Promise<void> {
  const history = await readVerifiedDiscoveryQuestionAnswerHistory(runDir, state);
  validateDiscoveryBriefSemantics(brief, {
    answered_question_ids: [...new Set(history.flatMap((entry) => entry.kind === "answer" ? [entry.question_id] : []))],
    current_cycle_answered_question_ids: [...new Set(history.flatMap((entry) =>
      entry.kind === "answer" && entry.cycle === state.cycle ? [entry.question_id] : []))],
    prior_approved_brief: await readLatestApprovedDiscoveryBrief(runDir, state, brief.revision),
  });
}

async function currentReadinessForBrief(runDir: string, state: DiscoveryManifestState, brief: DiscoveryBrief) {
  if (state.current_readiness_revision === null) throw new Error("Discovery brief requires immutable readiness evidence");
  const history = await readVerifiedDiscoveryReadinessHistory(runDir, state);
  const readiness = history.find((entry) => entry.revision === state.current_readiness_revision);
  const record = state.readiness_revisions[String(state.current_readiness_revision)];
  if (!readiness || !record || canonicalDiscoveryJson(readiness.outcome.brief) !== canonicalDiscoveryJson(brief)) {
    throw new Error("Discovery brief does not match its immutable readiness evidence");
  }
  return { readiness, record };
}

async function readDiscoveryEvents(runDir: string) {
  return (await readOwnedRunFile(runDir, "events.jsonl")).toString("utf8")
    .split("\n").filter(Boolean)
    .map((line) => runEventSchema.parse(JSON.parse(line)));
}

async function readDiscoveryApprovalEvents(runDir: string) {
  const events = (await readDiscoveryEvents(runDir)).filter((event) => event.type === "discovery_brief_approved");
  for (const event of events) {
    if (typeof event.payload.revision !== "number"
      || !Number.isInteger(event.payload.revision)
      || event.payload.revision <= 0) {
      throw new Error("Discovery brief approval event revision must be a positive integer");
    }
  }
  return events;
}

async function readVerifiedDiscoveryApproval(
  runDir: string,
  state: DiscoveryManifestState,
  revision: number,
  requireCurrentReadiness: boolean,
): Promise<{ brief: DiscoveryBrief; text: string; sha256: string }> {
  const manifest = await readManifestV2(runDir);
  const verified = await readCanonicalBrief(runDir, revision, state);
  const approvalText = await readOptionalArtifact(runDir, discoveryBriefApprovalPath(revision));
  if (approvalText === null) throw new Error(`Discovery brief approval ${revision} artifact is missing`);
  const approval = approvalArtifactSchema.parse(JSON.parse(approvalText));
  if (approvalText !== canonicalDiscoveryJson(approval)
    || approval.revision !== revision
    || approval.sha256 !== verified.sha256) {
    throw new Error(`Discovery brief approval ${revision} digest does not match canonical recorded bytes`);
  }
  if (requireCurrentReadiness && state.current_readiness_revision !== approval.readiness_revision) {
    throw new Error(`Discovery brief approval ${revision} does not match manifest readiness binding`);
  }
  const readinessHistory = await readVerifiedDiscoveryReadinessHistory(runDir, state);
  const readinessRecord = state.readiness_revisions[String(approval.readiness_revision)];
  const readiness = readinessHistory.find((entry) => entry.revision === approval.readiness_revision);
  if (!readinessRecord
    || readinessRecord.revision !== approval.readiness_revision
    || readinessRecord.path !== discoveryReadinessPath(approval.readiness_revision)
    || readinessRecord.sha256 !== approval.readiness_sha256
    || !readiness
    || canonicalDiscoveryJson(readiness.outcome.brief) !== verified.text) {
    throw new Error(`Discovery brief approval ${revision} does not match immutable readiness evidence`);
  }
  const semanticEvents = (await readDiscoveryApprovalEvents(runDir))
    .filter((event) => event.payload.revision === revision);
  if (semanticEvents.some((event) => event.run_id !== manifest.run_id)) {
    throw new Error(`Discovery brief approval ${revision} event has wrong run_id`);
  }
  if (semanticEvents.length !== 1) {
    throw new Error(`Discovery brief approval ${revision} does not match exactly one immutable approval event`);
  }
  const [event] = semanticEvents;
  if (event.actor !== "discovery"
    || event.stage !== "brain_planning"
    || event.payload.sha256 !== approval.sha256
    || event.payload.readiness_revision !== approval.readiness_revision
    || event.payload.readiness_sha256 !== approval.readiness_sha256) {
    throw new Error(`Discovery brief approval ${revision} event conflicts with immutable approval evidence`);
  }
  return verified;
}

export async function recordDiscoveryQuestion(
  runDir: string,
  input: DiscoveryQuestion,
): Promise<RunManifestV2Ledger> {
  const question = discoveryQuestionSchema.parse(input) as DiscoveryQuestion;
  return withRunLedgerCompoundTransaction(runDir, async (transaction) => {
    const manifest = await transaction.readManifestV2();
    const state = requireDiscovery(manifest);
    const expectedSequence = state.asked_questions + 1;
    const expectedId = discoveryQuestionId(state.cycle, question.sequence);
    if (question.sequence !== expectedSequence || question.id !== expectedId) {
      throw new Error("Discovery question sequence or id is not monotonic");
    }
    if (manifest.stage !== "brain_discovery" || state.current_question_id !== null) {
      throw new Error("Discovery question cannot be recorded outside brain_discovery");
    }
    if (state.asked_questions > 0) await readVerifiedDiscoveryQuestionAnswerHistory(transaction.runDir, state);
    const pending: DiscoveryPendingAction = {
      state: "awaiting_discovery_answer",
      question,
      permitted_next_actions: ["answer-discovery", "proceed-discovery"],
    };
    const relativePath = discoveryQuestionPath(question.sequence, state.cycle);
    const text = canonicalDiscoveryJson(question);
    const provenance = provenanceRecord("question", state.cycle, question.sequence, question.id, relativePath, text);
    await persistFixedArtifact(
      transaction.runDir,
      relativePath,
      text,
    );
    await persistPendingAction(transaction.runDir, pending);
    const next = await transaction.updateManifestV2({
      stage: "awaiting_discovery_answer",
      discovery: {
        ...state,
        asked_questions: question.sequence,
        current_question_id: question.id,
        pending_action_path: discoveryPendingActionPath(),
        question_artifacts: { ...state.question_artifacts, [provenance.key]: provenance.record },
      },
    });
    await appendDiscoveryEvent(transaction.runDir, next.stage, "discovery_question_recorded", {
      question_id: question.id,
      sequence: question.sequence,
      cycle: state.cycle,
      path: relativePath,
      sha256: provenance.record.sha256,
    });
    return next;
  });
}

export async function recordDiscoveryAnswer(
  runDir: string,
  questionId: string,
  answer: string,
): Promise<RunManifestV2Ledger> {
  const normalized = answer.trim();
  if (!normalized) throw new Error("Discovery answer must be non-empty");
  assertNoSecretMaterial("Discovery answer", normalized);
  const artifact = { question_id: questionId, answer: normalized };
  return withRunLedgerCompoundTransaction(runDir, async (transaction) => {
    const manifest = await transaction.readManifestV2();
    const state = requireDiscovery(manifest);
    const sequence = discoveryQuestionSequence(questionId, state.cycle);
    if (state.current_question_id !== questionId || manifest.stage !== "awaiting_discovery_answer") {
      throw new Error(`Discovery question ${questionId} is stale`);
    }
    await readVerifiedDiscoveryQuestionAnswerHistory(transaction.runDir, state);
    const relativePath = discoveryAnswerPath(sequence, state.cycle);
    const text = canonicalDiscoveryJson(artifact);
    const existingText = await readOptionalArtifact(transaction.runDir, relativePath);
    if (existingText !== null) {
      const existing = answerArtifactSchema.parse(JSON.parse(existingText));
      if (existing.question_id !== questionId || existing.answer !== normalized || existingText !== text) {
        throw new Error(`Discovery answer for ${questionId} conflicts with the recorded answer`);
      }
    }
    await persistFixedArtifact(transaction.runDir, relativePath, text);
    const provenance = provenanceRecord("answer", state.cycle, sequence, questionId, relativePath, text);
    const next = await transaction.updateManifestV2({
      stage: "brain_discovery",
      discovery: {
        ...state,
        answered_questions: state.answered_questions + 1,
        current_question_id: null,
        pending_action_path: null,
        answer_artifacts: { ...state.answer_artifacts, [provenance.key]: provenance.record },
      },
    });
    await appendDiscoveryEvent(transaction.runDir, next.stage, "discovery_answer_recorded", {
      question_id: questionId,
      sequence,
      cycle: state.cycle,
      path: relativePath,
      sha256: provenance.record.sha256,
    });
    return next;
  });
}

export async function recordDiscoveryProceedIntent(
  runDir: string,
  questionId: string,
  guidance: string,
): Promise<RunManifestV2Ledger> {
  const normalized = guidance.trim();
  if (!normalized) throw new Error("Discovery proceed guidance must be non-empty");
  assertNoSecretMaterial("Discovery proceed guidance", normalized);
  return withRunLedgerCompoundTransaction(runDir, async (transaction) => {
    const manifest = await transaction.readManifestV2();
    const state = requireDiscovery(manifest);
    const sequence = discoveryQuestionSequence(questionId, state.cycle);
    if (state.current_question_id !== questionId || manifest.stage !== "awaiting_discovery_answer") {
      throw new Error(`Discovery question ${questionId} is stale`);
    }
    await readVerifiedDiscoveryQuestionAnswerHistory(transaction.runDir, state);
    const answer = `Proceed with documented assumptions: ${normalized}`;
    const answerPath = discoveryAnswerPath(sequence, state.cycle);
    const answerText = canonicalDiscoveryJson({ question_id: questionId, answer });
    const intentPath = discoveryProceedIntentPath(state.cycle);
    await persistFixedArtifact(
      transaction.runDir,
      answerPath,
      answerText,
    );
    await persistFixedArtifact(
      transaction.runDir,
      intentPath,
      canonicalDiscoveryJson({ cycle: state.cycle, question_id: questionId, guidance: normalized }),
    );
    const next = await transaction.updateManifestV2({
      stage: "brain_discovery",
      discovery: {
        ...state,
        answered_questions: state.answered_questions + 1,
        current_question_id: null,
        proceed_with_assumptions: { cycle: state.cycle, question_id: questionId, path: intentPath },
        pending_action_path: null,
        answer_artifacts: {
          ...state.answer_artifacts,
          [discoveryHistoryArtifactKey("answer", state.cycle, sequence)]: provenanceRecord(
            "answer", state.cycle, sequence, questionId, answerPath, answerText,
          ).record,
        },
      },
    });
    await appendDiscoveryEvent(transaction.runDir, next.stage, "discovery_proceed_with_assumptions_recorded", {
      cycle: state.cycle,
      question_id: questionId,
      path: intentPath,
      answer_path: answerPath,
      answer_sha256: discoverySha256(answerText),
    });
    return next;
  });
}

export async function recordDiscoveryReadiness(
  runDir: string,
  input: Exclude<DiscoveryOutcome, { outcome: "ask_question" }>,
): Promise<RunManifestV2Ledger> {
  const outcome = discoveryOutcomeSchema.parse(input) as Exclude<DiscoveryOutcome, { outcome: "ask_question" }>;
  const text = canonicalDiscoveryJson(outcome);
  const sha256 = discoverySha256(text);
  return withRunLedgerCompoundTransaction(runDir, async (transaction) => {
    const manifest = await transaction.readManifestV2();
    const state = requireDiscovery(manifest);
    if (manifest.stage !== "brain_discovery") {
      throw new Error("Discovery readiness cannot be recorded outside brain_discovery");
    }
    const history = await readVerifiedDiscoveryReadinessHistory(transaction.runDir, state);
    const latest = history.at(-1);
    if (latest && canonicalDiscoveryJson(latest.outcome) === text) {
      if (state.current_readiness_revision === latest.revision) return manifest;
      return transaction.updateManifestV2({ discovery: { ...state, current_readiness_revision: latest.revision } });
    }
    const revision = Math.max(0, ...Object.values(state.readiness_revisions).map((record) => record.revision)) + 1;
    const path = discoveryReadinessPath(revision);
    if (await readOptionalArtifact(transaction.runDir, path) !== null) throw new Error(`Discovery readiness revision ${revision} exists without manifest provenance`);
    await persistFixedArtifact(transaction.runDir, path, text);
    const next = await transaction.updateManifestV2({
      discovery: {
        ...state,
        current_readiness_revision: revision,
        readiness_revisions: {
          ...state.readiness_revisions,
          [String(revision)]: { revision, path, sha256 },
        },
      },
    });
    await appendDiscoveryEvent(transaction.runDir, next.stage, "discovery_readiness_recorded", {
      cycle: state.cycle,
      outcome: outcome.outcome,
      readiness_revision: revision,
      brief_revision: outcome.brief.revision,
      path,
      sha256,
    });
    return next;
  });
}

export async function recordDiscoveryApproaches(
  runDir: string,
  revision: number,
  input: DiscoveryApproach[],
): Promise<RunManifestV2Ledger> {
  const artifact = approachesArtifactSchema.parse({ revision, approaches: input }) as {
    revision: number;
    approaches: DiscoveryApproach[];
  };
  return withRunLedgerCompoundTransaction(runDir, async (transaction) => {
    const manifest = await transaction.readManifestV2();
    const state = requireDiscovery(manifest);
    if (manifest.stage !== "brain_discovery") {
      throw new Error("Discovery approaches cannot be recorded outside brain_discovery");
    }
    const pending: DiscoveryPendingAction = {
      state: "awaiting_discovery_approach",
      revision,
      approaches: artifact.approaches,
      permitted_next_actions: ["select-discovery-approach"],
    };
    await persistFixedArtifact(
      transaction.runDir,
      discoveryApproachesPath(revision),
      canonicalDiscoveryJson(artifact),
    );
    await persistPendingAction(transaction.runDir, pending);
    const next = await transaction.updateManifestV2({
      stage: "awaiting_discovery_approach",
      discovery: {
        ...state,
        current_approaches_revision: revision,
        selected_approach_id: null,
        pending_action_path: discoveryPendingActionPath(),
      },
    });
    await appendDiscoveryEvent(transaction.runDir, next.stage, "discovery_approaches_recorded", { revision });
    return next;
  });
}

export async function selectDiscoveryApproach(
  runDir: string,
  revision: number,
  approachId: string,
): Promise<RunManifestV2Ledger> {
  return withRunLedgerCompoundTransaction(runDir, async (transaction) => {
    const manifest = await transaction.readManifestV2();
    const state = requireDiscovery(manifest);
    if (state.current_approaches_revision !== revision || manifest.stage !== "awaiting_discovery_approach") {
      throw new Error(`Discovery approaches revision ${revision} is stale`);
    }
    const raw = await readOptionalArtifact(transaction.runDir, discoveryApproachesPath(revision));
    if (raw === null) throw new Error("Current discovery approaches artifact is missing");
    const artifact = approachesArtifactSchema.parse(JSON.parse(raw));
    if (artifact.revision !== revision) throw new Error(`Discovery approaches revision ${revision} is stale`);
    if (!artifact.approaches.some((approach) => approach.id === approachId)) {
      throw new Error(`Discovery approach ${approachId} is not available in revision ${revision}`);
    }
    await persistFixedArtifact(
      transaction.runDir,
      discoveryApproachSelectionPath(revision),
      canonicalDiscoveryJson({ revision, approach_id: approachId }),
    );
    const next = await transaction.updateManifestV2({
      stage: "brain_discovery",
      discovery: { ...state, selected_approach_id: approachId, pending_action_path: null },
    });
    await appendDiscoveryEvent(transaction.runDir, next.stage, "discovery_approach_selected", {
      revision,
      approach_id: approachId,
    });
    return next;
  });
}

export async function recordDiscoveryBrief(
  runDir: string,
  input: DiscoveryBrief,
): Promise<RunManifestV2Ledger> {
  const brief = discoveryBriefSchema.parse(input) as DiscoveryBrief;
  return withRunLedgerCompoundTransaction(runDir, async (transaction) => {
    const manifest = await transaction.readManifestV2();
    const state = requireDiscovery(manifest);
    if (manifest.stage !== "brain_discovery") {
      throw new Error("Discovery brief cannot be recorded outside brain_discovery");
    }
    if (state.current_approaches_revision !== null && (
      state.selected_approach_id === null || brief.selected_approach_id !== state.selected_approach_id
    )) throw new Error("Discovery brief does not use the selected approach");
    await validateBriefAgainstDurableContext(transaction.runDir, state, brief);
    const readiness = await currentReadinessForBrief(transaction.runDir, state, brief);
    const relativePath = discoveryBriefPath(brief.revision);
    const text = canonicalDiscoveryJson(brief);
    const digest = discoverySha256(text);
    const pending: DiscoveryPendingAction = {
      state: "awaiting_discovery_brief_approval",
      revision: brief.revision,
      brief,
      readiness_revision: readiness.readiness.revision,
      readiness_sha256: readiness.record.sha256,
      permitted_next_actions: ["approve-discovery", "revise-discovery"],
    };
    await persistFixedArtifact(transaction.runDir, relativePath, text);
    await persistPendingAction(transaction.runDir, pending);
    const next = await transaction.updateManifestV2({
      stage: "awaiting_discovery_brief_approval",
      discovery: {
        ...state,
        current_brief_revision: brief.revision,
        approved_brief_revision: null,
        approved_brief_sha256: null,
        pending_action_path: discoveryPendingActionPath(),
        brief_revisions: {
          ...state.brief_revisions,
          [String(brief.revision)]: { revision: brief.revision, path: relativePath, sha256: digest },
        },
      },
    });
    await appendDiscoveryEvent(transaction.runDir, next.stage, "discovery_brief_recorded", {
      revision: brief.revision,
      sha256: digest,
      readiness_revision: readiness.readiness.revision,
      readiness_sha256: readiness.record.sha256,
    });
    return next;
  });
}

async function readCanonicalBrief(
  runDir: string,
  revision: number,
  state: DiscoveryManifestState,
): Promise<{ brief: DiscoveryBrief; text: string; sha256: string }> {
  const record = state.brief_revisions[String(revision)];
  if (!record || record.revision !== revision || record.path !== discoveryBriefPath(revision)) {
    throw new Error(`Discovery brief revision ${revision} is not recorded`);
  }
  const text = await readOptionalArtifact(runDir, record.path);
  if (text === null) throw new Error(`Discovery brief revision ${revision} is missing`);
  const brief = discoveryBriefSchema.parse(JSON.parse(text)) as DiscoveryBrief;
  if (brief.revision !== revision || text !== canonicalDiscoveryJson(brief)) {
    throw new Error(`Discovery brief revision ${revision} does not contain canonical bytes`);
  }
  return { brief, text, sha256: discoverySha256(text) };
}

export async function approveDiscoveryBrief(runDir: string, revision: number): Promise<RunManifestV2Ledger> {
  return withRunLedgerCompoundTransaction(runDir, async (transaction) => {
    const manifest = await transaction.readManifestV2();
    const state = requireDiscovery(manifest);
    await readVerifiedDiscoveryQuestionAnswerHistory(transaction.runDir, state);
    if (manifest.stage === "brain_planning"
      && state.approved_brief_revision === revision
      && state.approved_brief_sha256 !== null) {
      const verified = await readVerifiedDiscoveryBrief(transaction.runDir);
      await validateBriefAgainstDurableContext(transaction.runDir, state, verified);
      await currentReadinessForBrief(transaction.runDir, state, verified);
      return manifest;
    }
    if (state.current_brief_revision !== revision || manifest.stage !== "awaiting_discovery_brief_approval") {
      throw new Error(`Discovery brief revision ${revision} is stale`);
    }
    const verified = await readCanonicalBrief(transaction.runDir, revision, state);
    const record = state.brief_revisions[String(revision)];
    if (verified.sha256 !== record.sha256) {
      throw new Error(`Discovery brief revision ${revision} digest does not match its recorded bytes`);
    }
    await validateBriefAgainstDurableContext(transaction.runDir, state, verified.brief);
    const readiness = await currentReadinessForBrief(transaction.runDir, state, verified.brief);
    const pendingText = await readOptionalArtifact(transaction.runDir, discoveryPendingActionPath());
    if (pendingText === null) throw new Error("Discovery brief approval pending action is missing");
    const pending = discoveryPendingActionSchema.parse(JSON.parse(pendingText));
    if (pending.state !== "awaiting_discovery_brief_approval"
      || pending.revision !== revision
      || pendingText !== canonicalDiscoveryJson(pending)
      || canonicalDiscoveryJson(pending.brief) !== canonicalDiscoveryJson(verified.brief)
      || pending.readiness_revision !== readiness.readiness.revision
      || pending.readiness_sha256 !== readiness.record.sha256) {
      throw new Error("Discovery brief approval does not match its pending readiness binding");
    }
    if (state.current_approaches_revision !== null && (
      state.selected_approach_id === null || verified.brief.selected_approach_id !== state.selected_approach_id
    )) throw new Error("Discovery brief approval requires the selected approach");
    await persistFixedArtifact(
      transaction.runDir,
      discoveryBriefApprovalPath(revision),
      canonicalDiscoveryJson({
        revision,
        sha256: verified.sha256,
        readiness_revision: readiness.readiness.revision,
        readiness_sha256: readiness.record.sha256,
      }),
    );
    await writeTextArtifact(transaction.runDir, approvedDiscoveryBriefPath(), verified.text);
    if (state.approved_brief_revision === revision && state.approved_brief_sha256 === verified.sha256) {
      return manifest;
    }
    const next = await transaction.updateManifestV2({
      stage: "brain_planning",
      discovery: {
        ...state,
        approved_brief_revision: revision,
        approved_brief_sha256: verified.sha256,
        pending_action_path: null,
      },
    });
    await appendDiscoveryEvent(transaction.runDir, next.stage, "discovery_brief_approved", {
      revision,
      sha256: verified.sha256,
      readiness_revision: readiness.readiness.revision,
      readiness_sha256: readiness.record.sha256,
    });
    return next;
  });
}

export async function rejectDiscoveryBrief(
  runDir: string,
  revision: number,
  reason: string,
): Promise<RunManifestV2Ledger> {
  const normalized = reason.trim();
  if (!normalized) throw new Error("Discovery brief rejection reason must be non-empty");
  assertNoSecretMaterial("Discovery brief rejection reason", normalized);
  return withRunLedgerCompoundTransaction(runDir, async (transaction) => {
    const manifest = await transaction.readManifestV2();
    const state = requireDiscovery(manifest);
    if (state.current_brief_revision !== revision || manifest.stage !== "awaiting_discovery_brief_approval") {
      throw new Error(`Discovery brief revision ${revision} is stale`);
    }
    await persistFixedArtifact(
      transaction.runDir,
      discoveryBriefRejectionPath(revision),
      canonicalDiscoveryJson({ revision, reason: normalized }),
    );
    const next = await transaction.updateManifestV2({
      stage: "brain_discovery",
      discovery: {
        ...state,
        current_brief_revision: null,
        approved_brief_revision: null,
        approved_brief_sha256: null,
        pending_action_path: null,
      },
    });
    await appendDiscoveryEvent(transaction.runDir, next.stage, "discovery_brief_rejected", {
      revision,
      reason: normalized,
    });
    return next;
  });
}

export async function readVerifiedDiscoveryBrief(runDir: string): Promise<DiscoveryBrief> {
  const manifest = await readManifestV2(runDir);
  const state = requireDiscovery(manifest);
  return readVerifiedDiscoveryBriefForState(runDir, state);
}

/** Verify one approved discovery prerequisite against an already-locked manifest snapshot. */
export async function readVerifiedDiscoveryBriefForState(
  runDir: string,
  state: DiscoveryManifestState,
): Promise<DiscoveryBrief> {
  await readVerifiedDiscoveryQuestionAnswerHistory(runDir, state);
  const revision = state.approved_brief_revision;
  if (revision === null || state.approved_brief_sha256 === null) {
    throw new Error("Discovery brief is not approved");
  }
  const verified = await readVerifiedDiscoveryApproval(runDir, state, revision, true);
  if (verified.sha256 !== state.approved_brief_sha256) {
    throw new Error(`Discovery brief revision ${revision} digest does not match its approval`);
  }
  const approvedText = await readOptionalArtifact(runDir, approvedDiscoveryBriefPath());
  if (approvedText === null) throw new Error("Approved discovery brief artifact is missing");
  const approvedBrief = discoveryBriefSchema.parse(JSON.parse(approvedText)) as DiscoveryBrief;
  if (
    approvedBrief.revision !== revision
    || approvedText !== canonicalDiscoveryJson(approvedBrief)
    || discoverySha256(approvedText) !== state.approved_brief_sha256
    || approvedText !== verified.text
  ) {
    throw new Error(`Discovery brief revision ${revision} digest does not match its approval`);
  }
  return verified.brief;
}

export async function readLatestApprovedDiscoveryBrief(
  runDir: string,
  state: DiscoveryManifestState,
  beforeRevision = Number.POSITIVE_INFINITY,
): Promise<DiscoveryBrief | null> {
  const approvalEvents = (await readDiscoveryApprovalEvents(runDir))
    .filter((event) => (event.payload.revision as number) < beforeRevision);
  for (const event of approvalEvents) {
    if (!state.brief_revisions[String(event.payload.revision)]) {
      throw new Error(`Discovery brief approval ${String(event.payload.revision)} event has no manifest provenance`);
    }
  }
  const revisions = Object.values(state.brief_revisions)
    .map((record) => record.revision)
    .filter((revision) => revision < beforeRevision)
    .sort((left, right) => right - left);
  for (const revision of revisions) {
    const approvalPath = discoveryBriefApprovalPath(revision);
    const approvalText = await readOptionalArtifact(runDir, approvalPath);
    const hasEvent = approvalEvents.some((event) => event.payload.revision === revision);
    if (approvalText === null && !hasEvent) continue;
    return (await readVerifiedDiscoveryApproval(runDir, state, revision, false)).brief;
  }
  return null;
}

export async function readDiscoveryPendingAction(runDir: string): Promise<DiscoveryPendingAction | null> {
  const manifest = await readManifestV2(runDir);
  const state = requireDiscovery(manifest);
  if (state.pending_action_path === null) return null;
  if (state.pending_action_path !== discoveryPendingActionPath()) {
    throw new Error("Discovery pending action path is not canonical");
  }
  const raw = await readOptionalArtifact(runDir, state.pending_action_path);
  if (raw === null) throw new Error("Discovery pending action artifact is missing");
  const pending = discoveryPendingActionSchema.parse(JSON.parse(raw)) as DiscoveryPendingAction;
  if (raw !== canonicalDiscoveryJson(pending) || pending.state !== manifest.stage) {
    throw new Error("Discovery pending action does not match the manifest stage");
  }
  const history = await readVerifiedDiscoveryQuestionAnswerHistory(runDir, state);
  const readinessHistory = await readVerifiedDiscoveryReadinessHistory(runDir, state);
  if (pending.state === "awaiting_discovery_answer") {
    const recorded = history.find((entry) =>
      entry.kind === "question"
      && entry.cycle === state.cycle
      && entry.question.id === pending.question.id);
    if (recorded?.kind !== "question" || canonicalDiscoveryJson(recorded.question) !== canonicalDiscoveryJson(pending.question)) {
      throw new Error("Discovery pending question does not match its recorded provenance");
    }
  } else if (pending.state === "awaiting_discovery_brief_approval") {
    const readiness = readinessHistory.find((entry) => entry.revision === pending.readiness_revision);
    const record = state.readiness_revisions[String(pending.readiness_revision)];
    if (state.current_readiness_revision !== pending.readiness_revision
      || !readiness || !record
      || record.sha256 !== pending.readiness_sha256
      || canonicalDiscoveryJson(readiness.outcome.brief) !== canonicalDiscoveryJson(pending.brief)) {
      throw new Error("Discovery pending brief does not match immutable readiness evidence");
    }
  }
  return pending;
}
