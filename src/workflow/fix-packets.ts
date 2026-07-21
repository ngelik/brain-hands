import type { ExecutionSpecV2, VerifierProblemClass } from "../core/types.js";
import { createHash } from "node:crypto";
import type { CodexAdapter } from "../adapters/codex.js";
import type { ResourceBudgetPort } from "../core/resource-budget.js";
import type { ReasoningEffort } from "../core/types.js";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { verifierRemediationClaimV1OutputSchema } from "../core/output-schemas.js";
import { loadPromptTemplate } from "../prompts/loader.js";
import { renderTemplate } from "../prompts/renderer.js";
import {
  canonicalReviewFixPacket,
  hashReviewFixPacket,
  reviewFixPacketReadinessErrors,
  reviewFixPacketV1Schema,
  verifierRemediationClaimV1Schema,
  fixAttemptSupplementV1Schema,
  type FixAttemptSupplementV1,
  type ReviewFixPacketV1,
  type VerifierRemediationClaimV1,
} from "../core/review-fix-packet.js";
import { readManifestV2, readOptionalValidatedArtifact, writeCreateOnceValidated } from "../core/ledger.js";
import { writeImmutableTextArtifact, writeTextArtifact } from "../core/ledger.js";
import { artifactPathSchema, executionSpecV2Schema, reviewCycleStateSchema, reviewerActionQueueSchema } from "../core/schema.js";
import { fingerprintFinding } from "./findings.js";
import { reviewDecisionPath, validatePersistedReviewEffectState } from "./review-cycle.js";
import { assertPolicyReviewerQueueAuthority } from "./reviewer-actions.js";
import { criterionAliasesForAcceptance } from "./review-normalizer.js";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const correctionRequestFields = {
  schema_version: z.literal(1),
  correction_protocol_revision: z.literal(3),
  correction_id: z.string().regex(/^fix-packet-correction:[a-f0-9]{64}$/),
  work_item_id: z.string().min(1),
  review_revision: z.number().int().positive(),
  action_id: z.string().min(1),
  remediation_claim_sha256: sha256Schema,
  approved_plan_sha256: sha256Schema,
  validation_errors_sha256: sha256Schema,
  verifier_model: z.string().min(1),
  verifier_reasoning_effort: z.string().min(1),
};
const correctionRequestSchema = z.object(correctionRequestFields).strict();
const correctionInvocationClaimSchema = z.object({
  ...correctionRequestFields,
  state: z.literal("started"),
}).strict();
const correctionCompletionSchema = z.object({
  ...correctionRequestFields,
  state: z.literal("complete"),
  response_ref: z.object({ path: z.string().min(1), sha256: sha256Schema }).strict(),
}).strict();
import { assertApprovedCommand } from "../core/command.js";

export interface CompileReviewFixPacketInput {
  claim: VerifierRemediationClaimV1;
  work_item: ExecutionSpecV2;
  finding_id: string;
  action_id: string;
  review_revision: number;
  criterion_ref: string;
  severity: "critical" | "high" | "medium" | "low";
  problem_class: VerifierProblemClass;
  approved_plan_sha256: string;
  worktree_path?: string;
  packet_identity?: "legacy" | "scoped";
}

export interface PersistedReviewFixPacket {
  path: string;
  sha256: string;
}

export class FixPacketRequiresReplanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FixPacketRequiresReplanError";
  }
}

export function classifyFixPacketCompilationFailure(error: unknown): "replan" | "invalid_contract" {
  return error instanceof FixPacketRequiresReplanError ? "replan" : "invalid_contract";
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function canonicalizeJson(value: unknown): z.infer<ReturnType<typeof z.json>> {
  const parsed = z.json().parse(value);
  if (Array.isArray(parsed)) return parsed.map(canonicalizeJson);
  if (parsed !== null && typeof parsed === "object") {
    return Object.fromEntries(Object.keys(parsed).sort().map((key) => [key, canonicalizeJson(parsed[key])]));
  }
  return parsed;
}

function canonicalSha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalizeJson(value))).digest("hex");
}

const reviewFixPacketIdentityInputSchema = z.object({
  work_item_id: z.string().min(1),
  review_revision: z.number().int().positive(),
  action_id: z.string().min(1),
  finding_id: z.string().min(1),
  approved_plan_sha256: sha256Schema,
}).strict();

export type ReviewFixPacketIdentityInput = z.infer<typeof reviewFixPacketIdentityInputSchema>;

export function reviewFixPacketIdentity(input: ReviewFixPacketIdentityInput): string {
  const identity = reviewFixPacketIdentityInputSchema.parse(input);
  return `review-fix-packet:${canonicalSha256(identity)}`;
}

export interface FixPacketCorrectionAuthorityInput {
  workItem: ExecutionSpecV2;
  reviewRevision: number;
  actionId: string;
  claim: VerifierRemediationClaimV1;
  approvedPlanSha256: string;
  validationErrors: string[];
  verifierProfile: { model: string; reasoning_effort: ReasoningEffort };
}

export function reviewFixPacketCorrectionAuthority(input: FixPacketCorrectionAuthorityInput) {
  const workItem = executionSpecV2Schema.parse(input.workItem);
  const claim = verifierRemediationClaimV1Schema.parse(input.claim);
  const validationErrors = z.array(z.string().min(1)).min(1).parse(input.validationErrors);
  const identity = {
    correction_protocol_revision: 3 as const,
    work_item_id: workItem.id,
    review_revision: z.number().int().positive().parse(input.reviewRevision),
    action_id: z.string().min(1).parse(input.actionId),
    remediation_claim_sha256: canonicalSha256(claim),
    approved_plan_sha256: sha256Schema.parse(input.approvedPlanSha256),
    validation_errors_sha256: canonicalSha256(validationErrors),
    verifier_model: z.string().min(1).parse(input.verifierProfile.model),
    verifier_reasoning_effort: z.string().min(1).parse(input.verifierProfile.reasoning_effort),
  };
  const request = correctionRequestSchema.parse({
    schema_version: 1,
    correction_id: `fix-packet-correction:${canonicalSha256(identity)}`,
    ...identity,
  });
  const segment = Buffer.from(request.correction_id, "utf8").toString("base64url");
  const root = `reviews/fix-packet-corrections/${segment}`;
  return {
    request,
    root,
    requestPath: `${root}/request.json`,
    claimPath: `${root}/invocation-claim.json`,
    responsePath: `${root}/response.json`,
    completionPath: `${root}/completion.json`,
  };
}

async function loadCompletedVerifierRemediationCorrection(
  runDir: string,
  authorityInput: FixPacketCorrectionAuthorityInput,
): Promise<VerifierRemediationClaimV1 | null> {
  const authority = reviewFixPacketCorrectionAuthority(authorityInput);
  const request = await readOptionalValidatedArtifact(runDir, authority.requestPath, correctionRequestSchema);
  const claim = await readOptionalValidatedArtifact(runDir, authority.claimPath, correctionInvocationClaimSchema);
  const response = await readOptionalValidatedArtifact(runDir, authority.responsePath, verifierRemediationClaimV1Schema);
  const completion = await readOptionalValidatedArtifact(runDir, authority.completionPath, correctionCompletionSchema);
  if (request && !sameJson(request, authority.request)) {
    throw new Error("invalid_verifier_contract: correction request authority mismatch");
  }
  const expectedClaim = correctionInvocationClaimSchema.parse({ ...authority.request, state: "started" });
  if (claim && !sameJson(claim, expectedClaim)) {
    throw new Error("invalid_verifier_contract: correction invocation claim authority mismatch");
  }
  if (completion) {
    if (!request || !claim || !response) {
      throw new Error("invalid_verifier_contract: correction completion is missing request, claim, or response authority");
    }
    const expectedCompletion = correctionCompletionSchema.parse({
      ...authority.request,
      state: "complete",
      response_ref: { path: authority.responsePath, sha256: canonicalSha256(response) },
    });
    if (!sameJson(completion, expectedCompletion)) {
      throw new Error("invalid_verifier_contract: correction response hash or completion authority mismatch");
    }
    return response;
  }
  if (response) {
    throw new Error("invalid_verifier_contract: correction response has no matching immutable completion");
  }
  if (claim) {
    throw new Error(`invalid_verifier_contract: ambiguous correction invocation for ${authority.request.correction_id}`);
  }
  return null;
}

export function reviewFixPacketRoot(packetId: string): string {
  return `reviews/fix-packets/${Buffer.from(packetId, "utf8").toString("base64url")}`;
}

export function reviewFixPacketPath(packetId: string): string {
  return `${reviewFixPacketRoot(packetId)}/packet.json`;
}

export function fixAttemptSupplementPath(packetId: string, attempt: number): string {
  return `${reviewFixPacketRoot(packetId)}/attempts/${attempt}/attempt-supplement.json`;
}

export function compileReviewFixPacket(input: CompileReviewFixPacketInput): ReviewFixPacketV1 {
  const parsedClaim = verifierRemediationClaimV1Schema.parse(input.claim);
  const criterion = input.work_item.acceptance.find((entry) => entry.id === input.criterion_ref);
  if (!criterion) throw new FixPacketRequiresReplanError(`Unknown approved criterion ${input.criterion_ref}`);
  const successConditionIds = parsedClaim.verification.success_conditions.map(({ id }) => id);
  const contracts = new Map(input.work_item.file_contract.map((entry) => [entry.path, entry]));
  const normalizedChangeUnits = parsedClaim.remediation.change_units.map((unit) => {
    const contract = contracts.get(unit.path);
    return {
      ...unit,
      ...(contract && contract.permission !== "read_only"
        ? {
            operation: contract.permission,
            ...(contract.targets.length === 1 ? { target: contract.targets[0]! } : {}),
          }
        : {}),
      satisfies: [...new Set(unit.satisfies.flatMap((id) =>
        id === input.criterion_ref ? successConditionIds : [id]))],
    };
  });
  const normalizedRequiredEvidence = parsedClaim.verification.required_evidence.map((evidence) => ({
    ...evidence,
    output_path: artifactPathSchema.safeParse(evidence.output_path).success
      ? evidence.output_path
      : `verification/review-fix/${evidence.id.replace(/[^a-zA-Z0-9._-]/g, "_")}.json`,
  }));
  const claim = verifierRemediationClaimV1Schema.parse({
    ...parsedClaim,
    remediation: {
      ...parsedClaim.remediation,
      change_units: normalizedChangeUnits,
    },
    verification: {
      ...parsedClaim.verification,
      required_evidence: normalizedRequiredEvidence,
    },
    completion_contract: {
      ...parsedClaim.completion_contract,
      required_change_unit_ids: normalizedChangeUnits.map((unit) => unit.id),
      expected_changed_files: [...new Set(normalizedChangeUnits.map((unit) => unit.path))],
    },
  });

  for (const path of claim.remediation.allowed_files) {
    const contract = contracts.get(path);
    if (!contract || contract.permission === "read_only") {
      throw new FixPacketRequiresReplanError(`Fix requires unapproved writable path ${path}`);
    }
  }
  for (const unit of claim.remediation.change_units) {
    const contract = contracts.get(unit.path);
    if (!contract || contract.permission === "read_only") {
      throw new FixPacketRequiresReplanError(`Fix unit ${unit.id} requires unapproved path ${unit.path}`);
    }
    if (contract.permission !== unit.operation || !contract.targets.includes(unit.target)) {
      throw new Error(`Fix unit ${unit.id} conflicts with approved file target or operation`);
    }
  }
  for (const command of claim.verification.commands) {
    assertApprovedCommand(command.argv, input.worktree_path);
    if (!input.work_item.verification_commands.some((approved) => sameJson(approved.argv, command.argv))) {
      throw new Error(`Fix command ${command.id} is outside approved verification commands`);
    }
  }

  const packet = reviewFixPacketV1Schema.parse({
    ...claim,
    provenance: {
      packet_id: input.packet_identity === "scoped"
        ? reviewFixPacketIdentity({
            work_item_id: input.work_item.id,
            review_revision: input.review_revision,
            action_id: input.action_id,
            finding_id: input.finding_id,
            approved_plan_sha256: input.approved_plan_sha256,
          })
        : input.action_id,
      finding_id: input.finding_id,
      action_id: input.action_id,
      review_revision: input.review_revision,
      work_item_id: input.work_item.id,
      criterion_ref: input.criterion_ref,
      approved_plan_sha256: input.approved_plan_sha256,
    },
    diagnosis: {
      ...claim.diagnosis,
      severity: input.severity,
      problem_class: input.problem_class,
    },
  });
  const errors = reviewFixPacketReadinessErrors(packet, { approved_plan_sha256: input.approved_plan_sha256 });
  if (errors.length > 0) throw new Error(`Invalid review fix packet: ${errors.join("; ")}`);
  return packet;
}

export async function persistReviewFixPacket(
  runDir: string,
  packetInput: ReviewFixPacketV1,
): Promise<PersistedReviewFixPacket> {
  const packet = reviewFixPacketV1Schema.parse(packetInput);
  const path = reviewFixPacketPath(packet.provenance.packet_id);
  const sha256 = hashReviewFixPacket(packet);
  const existing = await readOptionalValidatedArtifact(runDir, path, reviewFixPacketV1Schema);
  if (existing) {
    if (canonicalReviewFixPacket(existing) !== canonicalReviewFixPacket(packet)) {
      throw new Error(`Review fix packet conflicts with immutable artifact ${path}`);
    }
    await writeImmutableTextArtifact(runDir, path.replace(/packet\.json$/, "packet.sha256"), `${sha256}\n`).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    await loadReviewFixPacket(runDir, path, sha256);
    return { path, sha256 };
  }
  await writeCreateOnceValidated(runDir, path, packet, reviewFixPacketV1Schema);
  await writeImmutableTextArtifact(runDir, path.replace(/packet\.json$/, "packet.sha256"), `${sha256}\n`);
  return { path, sha256 };
}

export async function loadReviewFixPacket(
  runDir: string,
  path: string,
  expectedSha256: string,
): Promise<ReviewFixPacketV1> {
  const packet = await readOptionalValidatedArtifact(runDir, path, reviewFixPacketV1Schema);
  if (!packet) throw new Error(`Review fix packet is missing: ${path}`);
  const actual = hashReviewFixPacket(packet);
  if (actual !== expectedSha256) throw new Error(`Review fix packet hash mismatch: ${path}`);
  const sidecar = (await readFile(resolve(runDir, path.replace(/packet\.json$/, "packet.sha256")), "utf8")).trim();
  if (sidecar !== actual) throw new Error(`Review fix packet hash sidecar mismatch: ${path}`);
  return packet;
}

export async function persistFixAttemptSupplement(
  runDir: string,
  supplementInput: FixAttemptSupplementV1,
): Promise<string> {
  const supplement = fixAttemptSupplementV1Schema.parse(supplementInput);
  const path = fixAttemptSupplementPath(supplement.packet_id, supplement.next_attempt);
  const existing = await readOptionalValidatedArtifact(runDir, path, fixAttemptSupplementV1Schema);
  if (existing) {
    if (!sameJson(existing, supplement)) throw new Error(`Fix attempt supplement conflicts with immutable artifact ${path}`);
    return path;
  }
  await writeCreateOnceValidated(runDir, path, supplement, fixAttemptSupplementV1Schema);
  return path;
}

async function compileAuthoritativeQueuePacket(input: {
  runDir: string;
  workItem: ExecutionSpecV2;
  action: z.infer<typeof reviewerActionQueueSchema>["actions"][number];
  findingId: string;
  criterionRef: string;
  reviewRevision: number;
  approvedPlanSha256: string;
  verifierProfile: { model: string; reasoning_effort: ReasoningEffort };
}): Promise<ReviewFixPacketV1> {
  if (!("remediation" in input.action) || !input.action.remediation || !input.action.problem_class) {
    throw new Error("Bounded fix packet requires an exact strict Reviewer remediation action");
  }
  const authoritativeClaim = input.action.remediation;
  const compile = (claim: VerifierRemediationClaimV1) => compileReviewFixPacket({
    claim,
    work_item: input.workItem,
    finding_id: input.findingId,
    action_id: input.action.action_id,
    review_revision: input.reviewRevision,
    criterion_ref: input.criterionRef,
    severity: input.action.severity,
    problem_class: input.action.problem_class!,
    approved_plan_sha256: input.approvedPlanSha256,
    packet_identity: "scoped",
  });
  try {
    return compile(authoritativeClaim);
  } catch (error) {
    if (error instanceof FixPacketRequiresReplanError) throw error;
    assertFixPacketCorrectionAvailable(0);
    const corrected = await loadCompletedVerifierRemediationCorrection(input.runDir, {
      workItem: input.workItem,
      reviewRevision: input.reviewRevision,
      actionId: input.action.action_id,
      claim: authoritativeClaim,
      approvedPlanSha256: input.approvedPlanSha256,
      validationErrors: [error instanceof Error ? error.message : String(error)],
      verifierProfile: input.verifierProfile,
    });
    if (!corrected) {
      throw new Error("Bounded fix packet has no exact controller-owned correction authority");
    }
    return compile(corrected);
  }
}

export async function validateBoundedFixPacketAuthority(input: {
  runDir: string;
  workItem: ExecutionSpecV2;
  packet: ReviewFixPacketV1;
  actionAttempt: number;
  supplement: FixAttemptSupplementV1 | null;
  verifierProfile: { model: string; reasoning_effort: ReasoningEffort };
}): Promise<{ packet: ReviewFixPacketV1; supplement: FixAttemptSupplementV1 | null }> {
  const manifest = await readManifestV2(input.runDir);
  if (manifest.workflow_protocol !== "bounded-context-v1") {
    throw new Error("Bounded fix packet requires bounded-context-v1 authority");
  }
  const progress = manifest.work_item_progress[input.workItem.id];
  if (!progress) throw new Error(`Bounded fix packet has no durable progress for ${input.workItem.id}`);
  if (
    progress.review_revision !== input.packet.provenance.review_revision
    || progress.active_action_id !== input.packet.provenance.action_id
    || progress.active_action_attempt !== input.actionAttempt
    || progress.fix_packet_attempt !== input.actionAttempt
  ) {
    throw new Error("Bounded fix packet does not match current review action authority");
  }
  if (typeof progress.queue_path !== "string") {
    throw new Error("Bounded fix packet has no current Reviewer action queue pointer");
  }
  const queueArtifactId = input.workItem.id.replace(/[^a-zA-Z0-9._-]/g, "_");
  const expectedQueuePath = `action-queues/${queueArtifactId}/revision-${progress.review_revision}.json`;
  if (progress.queue_path !== expectedQueuePath) {
    throw new Error("Bounded fix packet Reviewer queue pointer is not canonical");
  }
  const queue = await readOptionalValidatedArtifact(input.runDir, progress.queue_path, reviewerActionQueueSchema);
  if (!queue) throw new Error(`Bounded fix packet Reviewer action queue is missing: ${progress.queue_path}`);
  if (queue.work_item_id !== input.workItem.id || queue.review_revision !== progress.review_revision) {
    throw new Error("Bounded fix packet Reviewer action queue provenance is stale");
  }
  const action = queue.actions.find(({ action_id }) => action_id === progress.active_action_id);
  if (!action) throw new Error("Bounded fix packet active Reviewer action is missing from its queue");
  if (queue.contract_version !== "review_fix_packet_v1") {
    throw new Error("Bounded fix packet requires a strict Reviewer action queue contract");
  }
  const criterion = input.workItem.acceptance.find((entry) =>
    entry.id === action.acceptance_criterion || entry.statement === action.acceptance_criterion);
  if (!criterion || input.packet.provenance.criterion_ref !== criterion.id) {
    throw new Error("Bounded fix packet criterion provenance does not match the active Reviewer action");
  }
  const approvedRevision = manifest.approved_revision ?? manifest.approved_plan_revision;
  const approvedPlanSha256 = approvedRevision === null
    ? undefined
    : manifest.plan_revisions[String(approvedRevision)]?.sha256;
  if (!approvedPlanSha256 || input.packet.provenance.approved_plan_sha256 !== approvedPlanSha256) {
    throw new Error("Bounded fix packet does not match the current approved plan authority");
  }
  const approvedCriteria = approvedRevision === null
    ? undefined
    : manifest.plan_revisions[String(approvedRevision)]?.acceptance_criteria?.[input.workItem.id];
  const canonicalFindingCriterionRef = manifest.review_policy_snapshot
    ? (() => {
        const matches = (approvedCriteria ?? []).filter((candidate) => candidate.text === criterion.statement);
        if (matches.length !== 1) {
          throw new Error("Policy-enabled bounded fix packet criterion does not resolve to exact approved policy authority");
        }
        return matches[0]!.ref;
      })()
    : criterion.id;
  const findingId = fingerprintFinding({
    work_item_id: input.workItem.id,
    criterion_ref: canonicalFindingCriterionRef,
    source: "verifier",
    normalized_location: action.line === null ? action.file : `${action.file}:${action.line}`,
    problem_class: action.problem_class ?? input.packet.diagnosis.problem_class,
  });
  const expectedPacketId = reviewFixPacketIdentity({
    work_item_id: input.workItem.id,
    review_revision: progress.review_revision,
    action_id: action.action_id,
    finding_id: findingId,
    approved_plan_sha256: approvedPlanSha256,
  });
  if (input.packet.provenance.packet_id !== expectedPacketId) {
    throw new Error("Bounded fix packet ID does not match its canonical scoped identity");
  }
  if (
    input.packet.provenance.finding_id !== findingId
    || input.packet.diagnosis.problem_class !== action.problem_class
    || input.packet.diagnosis.severity !== action.severity
  ) {
    throw new Error("Bounded fix packet finding provenance does not match the active Reviewer action");
  }
  const expectedPacketPath = reviewFixPacketPath(input.packet.provenance.packet_id);
  const expectedPacketSha256 = hashReviewFixPacket(input.packet);
  if (progress.fix_packet_path !== expectedPacketPath || progress.fix_packet_sha256 !== expectedPacketSha256) {
    throw new Error("Bounded fix packet path or hash pointer does not match current progress");
  }
  const loadedPacket = await loadReviewFixPacket(input.runDir, expectedPacketPath, expectedPacketSha256);
  if (canonicalReviewFixPacket(loadedPacket) !== canonicalReviewFixPacket(input.packet)) {
    throw new Error("Supplied fix packet does not match its immutable authoritative artifact");
  }
  const authoritativePacket = await compileAuthoritativeQueuePacket({
    runDir: input.runDir,
    workItem: input.workItem,
    action,
    findingId,
    criterionRef: criterion.id,
    reviewRevision: progress.review_revision,
    approvedPlanSha256,
    verifierProfile: input.verifierProfile,
  });
  if (canonicalReviewFixPacket(loadedPacket) !== canonicalReviewFixPacket(authoritativePacket)) {
    throw new Error("Bounded fix packet payload does not match its exact Reviewer queue authority");
  }
  if (manifest.review_policy_snapshot) {
    if (typeof progress.review_cycle_path !== "string" || typeof progress.review_effect_id !== "string") {
      throw new Error("Policy-enabled bounded fix packet requires exact review-cycle and effect pointers");
    }
    if (progress.review_cycle_path !== reviewDecisionPath(input.workItem.id, progress.review_revision)) {
      throw new Error("Policy-enabled bounded fix packet review-cycle path is not canonical");
    }
    const cycle = await readOptionalValidatedArtifact(input.runDir, progress.review_cycle_path, reviewCycleStateSchema);
    if (!cycle) throw new Error(`Bounded fix packet review cycle is missing: ${progress.review_cycle_path}`);
    const policyHash = createHash("sha256").update(JSON.stringify(manifest.review_policy_snapshot)).digest("hex");
    if (
      cycle.decision_path !== progress.review_cycle_path
      || cycle.effect_id !== progress.review_effect_id
      || cycle.work_item_id !== input.workItem.id
      || cycle.phase !== "work_item"
      || cycle.review_revision !== progress.review_revision
      || cycle.policy_hash !== policyHash
      || cycle.decision.policy_revision !== manifest.review_policy_snapshot.policy_revision
      || cycle.accounting_before.plan_revision !== approvedRevision
      || cycle.accounting_before.plan_revision !== manifest.review_accounting?.plan_revision
      || cycle.decision.action !== "fix"
      || !cycle.finding_ids.includes(findingId)
      || !cycle.decision.finding_ids.includes(findingId)
    ) {
      throw new Error("Bounded fix packet review-cycle authority is stale");
    }
    assertPolicyReviewerQueueAuthority(
      queue,
      input.workItem,
      cycle.decision.finding_ids,
      criterionAliasesForAcceptance(input.workItem.acceptance, approvedCriteria ?? []),
    );
    const effect = await validatePersistedReviewEffectState(
      input.runDir,
      cycle,
      `runtime:work-item:${input.workItem.id}`,
    );
    if (!effect.claim || effect.completion || effect.effect_state !== "in_progress") {
      throw new Error("Bounded fix packet review effect is not immutably claimed and active");
    }
  } else if (progress.review_cycle_path !== undefined || progress.review_effect_id !== undefined) {
    throw new Error("Legacy bounded fix packet has partial policy authority");
  }
  if (input.actionAttempt === 1) {
    if (input.supplement !== null || progress.fix_packet_supplement_path !== null) {
      throw new Error("First bounded fix-packet attempt cannot use a supplement");
    }
    return { packet: loadedPacket, supplement: null };
  }
  const expectedSupplementPath = fixAttemptSupplementPath(input.packet.provenance.packet_id, input.actionAttempt);
  if (progress.fix_packet_supplement_path !== expectedSupplementPath || input.supplement === null) {
    throw new Error("Bounded fix packet retry supplement pointer is missing or stale");
  }
  const loadedSupplement = await readOptionalValidatedArtifact(input.runDir, expectedSupplementPath, fixAttemptSupplementV1Schema);
  if (!loadedSupplement) throw new Error(`Bounded fix packet retry supplement is missing: ${expectedSupplementPath}`);
  if (!sameJson(loadedSupplement, input.supplement)) {
    throw new Error("Supplied fix packet retry supplement does not match durable authority");
  }
  return { packet: loadedPacket, supplement: loadedSupplement };
}

export function assertFixPacketCorrectionAvailable(completedCorrectionCalls: number): void {
  if (!Number.isInteger(completedCorrectionCalls) || completedCorrectionCalls < 0 || completedCorrectionCalls >= 1) {
    throw new Error("invalid_verifier_contract: review fix packet correction limit exhausted");
  }
}

export function assertFixPacketChangedFiles(packet: ReviewFixPacketV1, actualChangedFiles: readonly string[]): void {
  const expected = new Set(packet.completion_contract.expected_changed_files);
  const actual = new Set(actualChangedFiles);
  for (const path of actual) if (!expected.has(path)) throw new Error(`unexpected changed file ${path}`);
  for (const path of expected) if (!actual.has(path)) throw new Error(`required changed file is missing: ${path}`);
}

export interface CorrectVerifierRemediationClaimInput {
  runDir: string;
  worktreePath: string;
  actionId: string;
  actionAttempt?: number;
  reviewRevision: number;
  approvedPlanSha256: string;
  claim: VerifierRemediationClaimV1;
  validationErrors: string[];
  workItem: ExecutionSpecV2;
  verifierProfile: { model: string; reasoning_effort: ReasoningEffort };
  codex: CodexAdapter;
  approvedPlanRevision?: number;
  budget?: ResourceBudgetPort;
}

export async function correctVerifierRemediationClaim(
  input: CorrectVerifierRemediationClaimInput,
): Promise<VerifierRemediationClaimV1> {
  assertFixPacketCorrectionAvailable(0);
  const authorityInput: FixPacketCorrectionAuthorityInput = {
    workItem: input.workItem,
    reviewRevision: input.reviewRevision,
    actionId: input.actionId,
    claim: input.claim,
    approvedPlanSha256: input.approvedPlanSha256,
    validationErrors: input.validationErrors,
    verifierProfile: input.verifierProfile,
  };
  const authority = reviewFixPacketCorrectionAuthority(authorityInput);
  const existing = await loadCompletedVerifierRemediationCorrection(input.runDir, authorityInput);
  if (existing) return existing;
  await writeCreateOnceValidated(input.runDir, authority.requestPath, authority.request, correctionRequestSchema);
  const template = await loadPromptTemplate("verifier-fix-packet-correction-v1");
  const prompt = renderTemplate(template, {
    remediation_json: JSON.stringify(input.claim, null, 2),
    validation_errors_json: JSON.stringify(input.validationErrors, null, 2),
    work_item_json: JSON.stringify(input.workItem, null, 2),
  });
  await writeTextArtifact(input.runDir, `${authority.root}/prompt.md`, prompt);
  await writeTextArtifact(input.runDir, `${authority.root}/schema.json`, `${JSON.stringify(verifierRemediationClaimV1OutputSchema, null, 2)}\n`);
  await writeCreateOnceValidated(input.runDir, authority.claimPath, {
    ...authority.request,
    state: "started",
  }, correctionInvocationClaimSchema);
  const invocation = await input.codex.invoke({
    role: "verifier", model: input.verifierProfile.model, reasoningEffort: input.verifierProfile.reasoning_effort,
    sandbox: "read-only", cwd: input.worktreePath, prompt, runDir: input.runDir,
    artifactName: `verifier-fix-packet-correction-${Buffer.from(authority.request.correction_id, "utf8").toString("base64url")}`, outputSchema: verifierRemediationClaimV1OutputSchema,
    outputParser: verifierRemediationClaimV1Schema,
    budget: input.budget,
    attemptKey: input.approvedPlanRevision === undefined
      ? undefined
      : `focused-verifier:${input.approvedPlanRevision}:${input.workItem.id}:${input.reviewRevision}:${input.actionId}:${input.actionAttempt ?? 1}`,
  });
  if (invocation.exitCode !== 0 || invocation.parsed === undefined) throw new Error(`invalid_verifier_contract: correction failed for ${input.actionId}`);
  const corrected = verifierRemediationClaimV1Schema.parse(invocation.parsed);
  await writeCreateOnceValidated(input.runDir, authority.responsePath, corrected, verifierRemediationClaimV1Schema);
  await writeCreateOnceValidated(input.runDir, authority.completionPath, {
    ...authority.request,
    state: "complete",
    response_ref: { path: authority.responsePath, sha256: canonicalSha256(corrected) },
  }, correctionCompletionSchema);
  return corrected;
}
