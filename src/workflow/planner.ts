import type { CodexAdapter } from "../adapters/codex.js";
import type { GitHubAdapter } from "../adapters/github.js";
import { z } from "zod";
import {
  readManifest,
  readManifestV2,
  commitClaimedInitialPlan,
  persistClaimedInitialPlanCandidate,
  readClaimedInitialPlanCandidate,
  updateManifest,
  updateManifestV2,
  writeTextArtifact,
} from "../core/ledger.js";
import {
  brainPlanSchema,
  discoveredBrainPlanSchema,
  issueSpecSchema,
  planningDiscoveryGapSchema,
} from "../core/schema.js";
import {
  brainPlanOutputSchema,
  discoveredBrainPlanOutputSchema,
  planningDiscoveryGapOutputSchema,
} from "../core/output-schemas.js";
import {
  PlanReadinessError,
  planReadinessDiagnostics,
  type PlanReadinessDiagnostic,
  parseExecutionPlan,
  validateDiscoveryCoverage,
} from "../core/execution-spec.js";
import { readVerifiedDiscoveryBrief } from "../core/discovery-ledger.js";
import { verifyDiscoveryPlanCandidate } from "./verified-plan.js";
import { reopenDiscoveryFromPlanningGap } from "./discovery.js";
import type {
  BrainPlan,
  BrainHandsConfig,
  DiscoveryBrief,
  DiscoveryPendingAction,
  DiscoveredBrainPlan,
  IssueSpec,
  PlanningDiscoveryGap,
  ResolvedRunIntake,
  RunManifestV2,
} from "../core/types.js";
import { loadPromptTemplate } from "../prompts/loader.js";
import { renderTemplate } from "../prompts/renderer.js";
import { planIssueNamingDiagnostics } from "../core/issue-naming.js";
import type { ProgressReporter } from "../progress/log.js";
import type { ResourceBudgetPort } from "../core/resource-budget.js";
import { usesDurableDiscoveryProtocol } from "../core/run-state.js";
import { brainInvocationArtifactName, claimBrainPlanning, clearBrainFailure, recordBrainFailure, releaseBrainPlanningClaim } from "./brain-failure.js";
import { createHash, randomUUID } from "node:crypto";
import { readOwnedEvidenceFile, readOwnedRunFile, writeOwnedEvidenceFile } from "../core/owned-evidence.js";
import {
  applyPlanRepair,
  candidateSha256,
  diagnosticFingerprint,
  isStrictDiagnosticImprovement,
  planRepairResponseOutputSchema,
  planRepairResponseSchema,
} from "./plan-repair.js";
import {
  buildPlanApprovalRequest,
  planDecisionContractSha256,
} from "../core/plan-approval.js";
import {
  RUN_CONFIGURATION_PATH,
  resolvedRunConfigurationSchema,
  runConfigurationSha256,
  serializeRunConfiguration,
} from "../core/run-configuration.js";
import { buildPlanDelta } from "./plan-delta.js";

export interface PlanRunInput {
  repoRoot: string;
  runDir: string;
  config: BrainHandsConfig;
  codex: CodexAdapter;
  github: GitHubAdapter;
  workflowDesign: string;
  dryRun: boolean;
}

export interface PlanRunResult {
  issueNumbers: number[];
}

export interface PlanRunV2Input {
  runDir: string;
  intake: ResolvedRunIntake;
  codex: CodexAdapter;
  progress?: ProgressReporter;
  maxSemanticRetries?: number;
  budget?: ResourceBudgetPort;
}

export interface PlanRunV2PlanResult {
  kind: "plan";
  plan: BrainPlan;
  revision: Awaited<ReturnType<typeof commitClaimedInitialPlan>>["revision"];
  manifest: RunManifestV2;
}

export interface PlanRunV2DiscoveryGapResult {
  kind: "discovery_gap";
  gap: PlanningDiscoveryGap;
  pending: DiscoveryPendingAction;
}

export type PlanRunV2Result = PlanRunV2PlanResult | PlanRunV2DiscoveryGapResult;

const discoveredPlannerPayloadSchema = z.union([
  discoveredBrainPlanSchema,
  planningDiscoveryGapSchema,
]);

const discoveredPlannerResponseSchema = z.object({
  result: discoveredPlannerPayloadSchema,
}).strict();

const discoveredPlannerResponseOutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    result: {
      anyOf: [discoveredBrainPlanOutputSchema, planningDiscoveryGapOutputSchema],
    },
  },
  required: ["result"],
} as const;

function parseStructuredBrainPlan(
  result: Awaited<ReturnType<CodexAdapter["invoke"]>>,
  intake: ResolvedRunIntake,
): BrainPlan {
  if (result.parsed === undefined) {
    throw new Error("Brain planner did not return a parsed BrainPlan object");
  }

  return brainPlanSchema.parse(result.parsed) as BrainPlan;
}

function parseDiscoveredPlannerResponse(
  result: Awaited<ReturnType<CodexAdapter["invoke"]>>,
  intake: ResolvedRunIntake,
): DiscoveredBrainPlan | PlanningDiscoveryGap {
  if (result.parsed === undefined) {
    throw new Error("Brain planner did not return a parsed discovered plan or discovery gap");
  }
  const response = discoveredPlannerResponseSchema.parse(result.parsed).result;
  const gap = planningDiscoveryGapSchema.safeParse(response);
  if (gap.success) return gap.data as PlanningDiscoveryGap;
  const plan = discoveredBrainPlanSchema.parse(response) as DiscoveredBrainPlan;
  return plan;
}

class PlanCandidateReadinessError extends PlanReadinessError {
  readonly candidate: BrainPlan;

  constructor(candidate: BrainPlan, diagnostics: PlanReadinessDiagnostic[]) {
    super(diagnostics);
    this.name = "PlanCandidateReadinessError";
    this.candidate = candidate;
  }
}

function isPlanningDiscoveryGap(
  value: BrainPlan | PlanningDiscoveryGap,
): value is PlanningDiscoveryGap {
  return "outcome" in value && value.outcome === "discovery_gap";
}

function candidateReadinessDiagnostics(plan: BrainPlan, input: Pick<PlanRunV2Input, "intake">): PlanReadinessDiagnostic[] {
  return [
    ...planReadinessDiagnostics(plan, { mode: input.intake.mode, repoRoot: input.intake.repo_root }),
    ...planIssueNamingDiagnostics(plan),
  ];
}

export { verifyPersistedDiscoveryPlanBinding } from "./verified-plan.js";

/** Run the v2 Brain planning phase and stop at the human approval gate. */
interface PlanningAttemptContext {
  invocationId?: string;
  artifactName?: string;
  attemptKey?: string;
}

async function persistPlanningDraft(runDir: string, invocationId: string, plan: BrainPlan): Promise<string> {
  const path = `plans/drafts/${invocationId}.json`;
  await writeOwnedEvidenceFile(runDir, path, "plans/", `${JSON.stringify(plan, null, 2)}\n`);
  return path;
}

async function readPlanningDraft(runDir: string, path: string): Promise<BrainPlan> {
  return JSON.parse((await readOwnedEvidenceFile(runDir, path, "plans/")).toString("utf8")) as BrainPlan;
}

async function buildInitialPlanApprovalRequest(
  runDir: string,
  manifest: RunManifestV2,
  plan: BrainPlan,
  planText: string,
) {
  const configurationBytes = (await readOwnedRunFile(runDir, RUN_CONFIGURATION_PATH)).toString("utf8");
  const runConfiguration = resolvedRunConfigurationSchema.parse(JSON.parse(configurationBytes));
  if (serializeRunConfiguration(runConfiguration) !== configurationBytes) {
    throw new Error("Run configuration bytes are not canonical");
  }
  if (manifest.run_configuration_sha256 !== runConfigurationSha256(runConfiguration)) {
    throw new Error("Run configuration digest does not match the immutable manifest");
  }
  return buildPlanApprovalRequest({
    manifest,
    runConfiguration,
    reasonCode: "initial_plan",
    revision: 1,
    baseRevision: null,
    planPath: "plans/revision-1.md",
    planSha256: createHash("sha256").update(planText, "utf8").digest("hex"),
    decisionContractSha256: planDecisionContractSha256(plan),
    delta: buildPlanDelta(null, plan, { baseRevision: null, proposedRevision: 1 }),
  });
}

async function persistAndCommitPlan(input: {
  runDir: string;
  invocationId: string;
  artifactName: string;
  plan: BrainPlan;
  approvedBrief: DiscoveryBrief | null;
  approvedBriefSha256: string | null;
  progress?: ProgressReporter;
}): Promise<PlanRunV2PlanResult> {
  const plan = input.plan;
  const planText = `${JSON.stringify(plan, null, 2)}\n`;
  await persistClaimedInitialPlanCandidate({
    runDir: input.runDir,
    invocation_id: input.invocationId,
    artifact_name: input.artifactName,
    approved_discovery_brief_revision: input.approvedBrief?.revision ?? null,
    approved_discovery_brief_sha256: input.approvedBriefSha256,
    plan_text: planText,
    artifacts: {
      "research.md": `${plan.research.join("\n")}\n`,
      "research-sources.json": `${JSON.stringify(plan.research_sources, null, 2)}\n`,
      "architecture-plan.md": `${plan.architecture}\n`,
      "work-items.json": `${JSON.stringify(plan.work_items, null, 2)}\n`,
    },
  });
  const manifest = await readManifestV2(input.runDir);
  const approvalRequest = manifest.workflow_protocol === "legacy-v2"
    && manifest.approval_protocol_version === null
    ? undefined
    : await buildInitialPlanApprovalRequest(input.runDir, manifest, plan, planText);
  const committed = await commitClaimedInitialPlan({
    runDir: input.runDir,
    controllerClaimToken: input.invocationId,
    approvalRequest,
  });
  await updateManifestV2(input.runDir, {
    planning_recovery: (await readManifestV2(input.runDir)).planning_recovery
      ? { ...(await readManifestV2(input.runDir)).planning_recovery!, state: "ready" }
      : null,
  });
  await input.progress?.emit({ code: "plan_ready", source: "brain", revision: committed.revision.revision });
  return { kind: "plan", plan, revision: committed.revision, manifest: await readManifestV2(input.runDir) };
}

async function persistPlanningEvidence(runDir: string, path: string, content: string): Promise<void> {
  const ownedRoot = `${path.split("/", 1)[0]}/`;
  try {
    await writeOwnedEvidenceFile(runDir, path, ownedRoot, content);
  } catch (error: unknown) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    if ((await readOwnedEvidenceFile(runDir, path, ownedRoot)).toString("utf8") !== content) {
      throw new Error(`Immutable Brain planning evidence already exists with different bytes: ${path}`);
    }
  }
}

async function planRunV2Attempt(
  input: PlanRunV2Input,
  context: PlanningAttemptContext,
  correction: string | null = null,
): Promise<PlanRunV2Result> {
  const manifestBeforePlanning = await readManifestV2(input.runDir);
  if (manifestBeforePlanning.stage !== "brain_planning") {
    throw new Error(`Brain planning requires stage brain_planning, got ${manifestBeforePlanning.stage}`);
  }
  const durableDiscovery = usesDurableDiscoveryProtocol(manifestBeforePlanning.workflow_protocol);
  let approvedBrief: DiscoveryBrief | null = null;
  let approvedBriefSha256: string | null = null;
  if (durableDiscovery) {
    approvedBrief = await readVerifiedDiscoveryBrief(input.runDir);
    approvedBriefSha256 = manifestBeforePlanning.discovery?.approved_brief_sha256 ?? null;
    if (approvedBriefSha256 === null) throw new Error("Approved discovery brief SHA-256 is missing");
  }
  const crashClaim = manifestBeforePlanning.brain_controller_claim ?? null;
  if (crashClaim !== null) {
    const candidate = await readClaimedInitialPlanCandidate(input.runDir, crashClaim.invocation_id);
    if (candidate !== null) {
      context.invocationId = crashClaim.invocation_id;
      context.artifactName = crashClaim.artifact_name;
      const parsedJson = JSON.parse(candidate.plan_text) as unknown;
      const plan = parseExecutionPlan(
        parsedJson,
        { mode: input.intake.mode, repoRoot: input.intake.repo_root },
        durableDiscovery ? "durable-discovery-v1" : undefined,
      );
      const diagnostics = candidateReadinessDiagnostics(plan, input);
      if (diagnostics.length > 0) throw new PlanCandidateReadinessError(plan, diagnostics);
      if (durableDiscovery) {
        await verifyDiscoveryPlanCandidate(input.runDir, manifestBeforePlanning, plan as DiscoveredBrainPlan);
      }
      const committed = await commitClaimedInitialPlan({
        runDir: input.runDir,
        controllerClaimToken: crashClaim.invocation_id,
        approvalRequest: await buildInitialPlanApprovalRequest(
          input.runDir,
          manifestBeforePlanning,
          plan,
          candidate.plan_text,
        ),
      });
      await input.progress?.emit({ code: "plan_ready", source: "brain", revision: committed.revision.revision });
      return { kind: "plan", plan, revision: committed.revision, manifest: committed.manifest };
    }
  }
  const researchInstruction = input.intake.research
    ? "Use live web search and cite primary sources in research_sources."
    : "Research is disabled for this run. Do not use live web search.";
  const verificationPolicy = input.intake.mode === "local"
    ? "Use local-only direct argv commands. Do not use npx, gh, curl, remote Git commands, package installation, shells, shell operators, node -e, node --eval, or inline scripts. Prefer existing repository scripts, focused test commands, and rg."
    : "Use direct argv commands only. Do not use shells, destructive executables, absolute paths, worktree escapes, shell operators, node -e, node --eval, or inline scripts. Prefer existing repository scripts, focused test commands, and rg.";
  const template = await loadPromptTemplate("brain-plan-v2");
  const renderedPrompt = renderTemplate(template, {
    original_request: input.intake.task,
    repo_root: input.intake.repo_root,
    research_instruction: researchInstruction,
    execution_mode: input.intake.mode,
    verification_policy: verificationPolicy,
    workflow_protocol: manifestBeforePlanning.workflow_protocol,
    approved_discovery_brief: approvedBrief === null
      ? "Not applicable to this legacy run."
      : JSON.stringify(approvedBrief, null, 2),
    approved_discovery_brief_revision: approvedBrief === null ? "not applicable" : String(approvedBrief.revision),
    approved_discovery_brief_sha256: approvedBriefSha256 ?? "not applicable",
  });
  const prompt = correction === null
    ? renderedPrompt
    : `${renderedPrompt}\n\n## Controller validation correction\n\nThe previous plan was rejected by Brain Hands. Return a complete replacement plan that fixes every validation error below without weakening scope or verification:\n\n${correction}\n`;
  const outputSchema = durableDiscovery ? discoveredPlannerResponseOutputSchema : brainPlanOutputSchema;
  const outputParser = durableDiscovery ? discoveredPlannerResponseSchema : brainPlanSchema;
  const schemaText = `${JSON.stringify(outputSchema, null, 2)}\n`;
  const artifactName = await brainInvocationArtifactName(input.runDir, "planning", "brain-plan-v2");
  const invocationId = randomUUID();
  await claimBrainPlanning({ runDir: input.runDir, invocationId, artifactName });
  context.invocationId = invocationId;
  context.artifactName = artifactName;

  // Persist the request contract before invoking Codex. The adapter persists the
  // same paths for real and dry-run calls; these writes also keep custom adapters
  // from losing the durable prompt/schema evidence.
  await persistPlanningEvidence(input.runDir, `prompts/${artifactName}.md`, prompt);
  await persistPlanningEvidence(input.runDir, `schemas/${artifactName}.json`, schemaText);

  const brainProfile = input.intake.roles.brain;
  const result = await input.codex.invoke({
    role: "brain",
    model: brainProfile.model,
    reasoningEffort: brainProfile.reasoning_effort,
    sandbox: "read-only",
    cwd: input.intake.repo_root,
    enableWebSearch: input.intake.research,
    prompt,
    runDir: input.runDir,
    artifactName,
    budget: input.budget,
    attemptKey: context.attemptKey,
    outputSchema,
    outputParser,
    ...(input.progress ? { progress: { reporter: input.progress, context: { source: "brain" as const, mode: "planning" as const, model: brainProfile.model, reasoningEffort: brainProfile.reasoning_effort, modelInvocationId: invocationId } } } : {}),
  });

  await persistPlanningEvidence(input.runDir, `responses/${artifactName}.json`, result.text);
  const parsed = durableDiscovery
    ? parseDiscoveredPlannerResponse(result, input.intake)
    : parseStructuredBrainPlan(result, input.intake);
  if (isPlanningDiscoveryGap(parsed)) {
    const pending = await reopenDiscoveryFromPlanningGap({ runDir: input.runDir, gap: parsed, progress: input.progress });
    await releaseBrainPlanningClaim(input.runDir, invocationId);
    return { kind: "discovery_gap", gap: parsed, pending };
  }
  const plan = parsed;
  const diagnostics = candidateReadinessDiagnostics(plan, input);
  if (diagnostics.length > 0) throw new PlanCandidateReadinessError(plan, diagnostics);
  if (durableDiscovery) {
    await verifyDiscoveryPlanCandidate(input.runDir, manifestBeforePlanning, plan);
  }
  return persistAndCommitPlan({
    runDir: input.runDir,
    invocationId,
    artifactName,
    plan,
    approvedBrief,
    approvedBriefSha256,
    progress: input.progress,
  });
}

async function repairPlanCandidate(
  input: PlanRunV2Input,
  candidate: BrainPlan,
  beforeDiagnostics: PlanReadinessDiagnostic[],
  attempt: number,
  context: PlanningAttemptContext,
): Promise<PlanRunV2PlanResult> {
  const manifest = await readManifestV2(input.runDir);
  const durableDiscovery = usesDurableDiscoveryProtocol(manifest.workflow_protocol);
  const approvedBrief = durableDiscovery ? await readVerifiedDiscoveryBrief(input.runDir) : null;
  const approvedBriefSha256 = durableDiscovery ? manifest.discovery?.approved_brief_sha256 ?? null : null;
  const sha256 = candidateSha256(candidate);
  const template = await loadPromptTemplate("brain-plan-repair-v1");
  const prompt = renderTemplate(template, {
    candidate_sha256: sha256,
    approved_discovery_brief_revision: approvedBrief?.revision === undefined ? "not applicable" : String(approvedBrief.revision),
    approved_discovery_brief_sha256: approvedBriefSha256 ?? "not applicable",
    candidate_json: JSON.stringify(candidate, null, 2),
    diagnostics_json: JSON.stringify(beforeDiagnostics, null, 2),
  });
  const artifactName = await brainInvocationArtifactName(input.runDir, "planning", "brain-plan-repair-v1");
  const invocationId = randomUUID();
  await claimBrainPlanning({
    runDir: input.runDir,
    invocationId,
    artifactName,
    attemptKind: "repair",
    attemptOrdinal: attempt,
  });
  context.invocationId = invocationId;
  context.artifactName = artifactName;
  await persistPlanningEvidence(input.runDir, `prompts/${artifactName}.md`, prompt);
  await persistPlanningEvidence(input.runDir, `schemas/${artifactName}.json`, `${JSON.stringify(planRepairResponseOutputSchema, null, 2)}\n`);
  const brainProfile = input.intake.roles.brain;
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
    attemptKey: context.attemptKey,
    outputSchema: planRepairResponseOutputSchema,
    outputParser: planRepairResponseSchema,
    ...(input.progress ? { progress: { reporter: input.progress, context: { source: "brain" as const, mode: "planning" as const, model: brainProfile.model, reasoningEffort: brainProfile.reasoning_effort, modelInvocationId: invocationId } } } : {}),
  });
  await persistPlanningEvidence(input.runDir, `responses/${artifactName}.json`, result.text);
  if (result.parsed === undefined) throw new Error("Brain plan repair did not return a parsed repair object");
  const repairedUnknown = applyPlanRepair(candidate, result.parsed);
  const repaired = durableDiscovery
    ? discoveredBrainPlanSchema.parse(repairedUnknown) as DiscoveredBrainPlan
    : brainPlanSchema.parse(repairedUnknown) as BrainPlan;
  const diagnostics = candidateReadinessDiagnostics(repaired, input);
  if (diagnostics.length > 0) {
    if (!isStrictDiagnosticImprovement(beforeDiagnostics, diagnostics)) {
      throw new Error("Brain plan repair did not strictly reduce the existing diagnostic set");
    }
    throw new PlanCandidateReadinessError(repaired, diagnostics);
  }
  if (durableDiscovery) await verifyDiscoveryPlanCandidate(input.runDir, manifest, repaired as DiscoveredBrainPlan);
  return persistAndCommitPlan({
    runDir: input.runDir,
    invocationId,
    artifactName,
    plan: repaired,
    approvedBrief,
    approvedBriefSha256,
    progress: input.progress,
  });
}

export async function planRunV2(input: PlanRunV2Input): Promise<PlanRunV2Result> {
  const maxRepairs = Math.max(0, input.maxSemanticRetries ?? 2);
  let manifest = await readManifestV2(input.runDir);
  if (manifest.stage !== "brain_planning") {
    return planRunV2Attempt(input, { attemptKey: `brain:plan:${manifest.run_id}:full:1` }, null);
  }
  let recovery = manifest.planning_recovery ?? {
    lineage_id: randomUUID(),
    approved_brief_revision: manifest.discovery?.approved_brief_revision ?? null,
    approved_brief_sha256: manifest.discovery?.approved_brief_sha256 ?? null,
    state: "full_generation" as const,
    full_attempts_used: 0,
    repair_attempts_used: 0,
    latest_candidate_ref: null,
    latest_candidate_sha256: null,
    latest_failure_ref: null,
    latest_diagnostic_fingerprint: null,
  };
  let candidate: BrainPlan | null = recovery.latest_candidate_ref
    ? await readPlanningDraft(input.runDir, recovery.latest_candidate_ref)
    : null;
  let diagnostics: PlanReadinessDiagnostic[] = candidate
    ? candidateReadinessDiagnostics(candidate, input)
    : [];

  if (candidate === null) {
    if (recovery.full_attempts_used >= 2) throw new Error("Brain planning full-generation budget is exhausted; inspect the latest failure before retrying");
    recovery = { ...recovery, state: "full_generation", full_attempts_used: recovery.full_attempts_used + 1 };
    await updateManifestV2(input.runDir, { planning_recovery: recovery });
    const context: PlanningAttemptContext = {
      attemptKey: `brain:plan:${recovery.lineage_id}:full:${recovery.full_attempts_used}`,
    };
    try {
      const result = await planRunV2Attempt(input, context, null);
      await clearBrainFailure(input.runDir, "planning");
      return result;
    } catch (error) {
      const current = await readManifestV2(input.runDir);
      if (!(error instanceof PlanCandidateReadinessError)) {
        if (context.invocationId && context.artifactName && current.stage === "brain_planning") {
          const failureRef = await recordBrainFailure({
            runDir: input.runDir, phase: "planning", cycle: null, turn: null,
            attempt: recovery.full_attempts_used, error, artifact_name: context.artifactName,
            controller_claim_token: context.invocationId, attempt_kind: "full",
            evidence_refs: [`prompts/${context.artifactName}.md`, `schemas/${context.artifactName}.json`, `responses/${context.artifactName}.json`],
          });
          await updateManifestV2(input.runDir, { planning_recovery: { ...recovery, state: "blocked", latest_failure_ref: failureRef } });
        }
        throw error;
      }
      candidate = error.candidate;
      diagnostics = error.diagnostics;
      const candidateRef = await persistPlanningDraft(input.runDir, context.invocationId!, candidate);
      const fingerprint = diagnosticFingerprint(diagnostics);
      const failureRef = await recordBrainFailure({
        runDir: input.runDir, phase: "planning", cycle: null, turn: null,
        attempt: recovery.full_attempts_used, error, artifact_name: context.artifactName,
        controller_claim_token: context.invocationId, attempt_kind: "full", diagnostics,
        candidate_ref: candidateRef, candidate_sha256: candidateSha256(candidate), diagnostic_fingerprint: fingerprint,
        evidence_refs: [`prompts/${context.artifactName}.md`, `schemas/${context.artifactName}.json`, `responses/${context.artifactName}.json`, candidateRef],
      });
      recovery = { ...recovery, state: "repairing", latest_candidate_ref: candidateRef, latest_candidate_sha256: candidateSha256(candidate), latest_failure_ref: failureRef, latest_diagnostic_fingerprint: fingerprint };
      await updateManifestV2(input.runDir, { planning_recovery: recovery });
    }
  }

  while (candidate !== null && diagnostics.length > 0 && recovery.repair_attempts_used < maxRepairs) {
    const attempt = recovery.repair_attempts_used + 1;
    recovery = { ...recovery, state: "repairing", repair_attempts_used: attempt };
    await updateManifestV2(input.runDir, { planning_recovery: recovery });
    const context: PlanningAttemptContext = {
      attemptKey: `brain:plan:${recovery.lineage_id}:repair:${attempt}`,
    };
    try {
      const result = await repairPlanCandidate(input, candidate, diagnostics, attempt, context);
      await clearBrainFailure(input.runDir, "planning");
      return result;
    } catch (error) {
      const improved = error instanceof PlanCandidateReadinessError;
      if (improved) {
        candidate = error.candidate;
        diagnostics = error.diagnostics;
      }
      const candidateRef = improved ? await persistPlanningDraft(input.runDir, context.invocationId!, candidate) : recovery.latest_candidate_ref!;
      const fingerprint = diagnosticFingerprint(diagnostics);
      const failureRef = await recordBrainFailure({
        runDir: input.runDir, phase: "planning", cycle: null, turn: null, attempt,
        error, artifact_name: context.artifactName, controller_claim_token: context.invocationId,
        attempt_kind: "repair", diagnostics, candidate_ref: candidateRef,
        candidate_sha256: candidateSha256(candidate), diagnostic_fingerprint: fingerprint,
        evidence_refs: [`prompts/${context.artifactName}.md`, `schemas/${context.artifactName}.json`, `responses/${context.artifactName}.json`, candidateRef],
      });
      recovery = { ...recovery, latest_candidate_ref: candidateRef, latest_candidate_sha256: candidateSha256(candidate), latest_failure_ref: failureRef, latest_diagnostic_fingerprint: fingerprint };
      await updateManifestV2(input.runDir, { planning_recovery: recovery });
    }
  }
  await updateManifestV2(input.runDir, { planning_recovery: { ...recovery, state: "blocked" } });
  throw new PlanReadinessError(diagnostics);
}

function fallbackDryRunIssue(runId: string, originalRequest: string): IssueSpec {
  return {
    type: "implementation_task",
    run_id: runId,
    parent_request: originalRequest,
    goal: "Dry-run planning follow-up",
    context: "Generated because planner output could not be parsed into IssueSpec JSON.",
    scope: {
      include: ["src"],
      exclude: ["generated artifacts", "automatic merge operations"],
    },
    dependencies: [],
    implementation_steps: [
      "Replace the dry-run planning fallback with a real planner response.",
    ],
    acceptance_criteria: [
      "Planning artifacts are persisted in the run ledger.",
      "The workflow can advance to ready_for_hands with at least one issue.",
    ],
    verification: {
      required_commands: ["npm test -- tests/workflow/orchestrator.test.ts"],
      manual_checks: [],
      expected_artifacts: [
        "research.md",
        "architecture-plan.md",
        "issues.json",
        "issue-review.md",
      ],
    },
    review_checklist: [
      "Issue preserves the original request context.",
      "Verification commands remain explicit.",
    ],
    risk_register: [
      "Fallback issue is suitable for dry-run or malformed planner output only.",
    ],
    handoff_prompt:
      "Use this fallback issue only when the planning model does not return valid IssueSpec JSON.",
  };
}

function extractMarkdownSection(text: string, heading: string): string | null {
  const pattern = new RegExp(
    `(^|\\n)#{1,6}\\s+${heading}\\s*\\n([\\s\\S]*?)(?=\\n#{1,6}\\s+|$)`,
    "i",
  );
  const match = text.match(pattern);
  return match?.[2]?.trim() || null;
}

function buildPlannerArtifact(text: string, heading: string, fallbackLabel: string): string {
  const section = extractMarkdownSection(text, heading);
  if (section) {
    return `${section}\n`;
  }

  return `${fallbackLabel}\n\n${text.trim()}\n`;
}

function findBalancedJsonSegment(text: string): string | null {
  const fencedMatches = text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi);
  for (const match of fencedMatches) {
    const candidate = match[1]?.trim();
    if (candidate) {
      try {
        JSON.parse(candidate);
        return candidate;
      } catch {
        // Keep scanning for another fenced JSON candidate.
      }
    }
  }

  const startCandidates = [text.indexOf("["), text.indexOf("{")]
    .filter((index) => index >= 0)
    .sort((left, right) => left - right);

  for (const start of startCandidates) {
    const opening = text[start];
    const closing = opening === "[" ? "]" : "}";
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let index = start; index < text.length; index += 1) {
      const char = text[index];

      if (inString) {
        if (escaped) {
          escaped = false;
          continue;
        }
        if (char === "\\") {
          escaped = true;
          continue;
        }
        if (char === "\"") {
          inString = false;
        }
        continue;
      }

      if (char === "\"") {
        inString = true;
        continue;
      }

      if (char === opening) {
        depth += 1;
      } else if (char === closing) {
        depth -= 1;
        if (depth === 0) {
          return text.slice(start, index + 1);
        }
      }
    }
  }

  return null;
}

function parseIssueArray(value: unknown): IssueSpec[] {
  const candidate =
    Array.isArray(value)
      ? value
      : value && typeof value === "object" && "issues" in value
        ? (value as { issues?: unknown }).issues
        : null;

  if (!Array.isArray(candidate)) {
    throw new Error("Planner response did not contain an issue array");
  }

  return candidate.map((issue) => issueSpecSchema.parse(issue));
}

function parseIssuesOrFallback(
  text: string,
  runId: string,
  originalRequest: string,
  dryRun: boolean,
  phase: "planner" | "critic",
): IssueSpec[] {
  try {
    const direct = JSON.parse(text) as unknown;
    return parseIssueArray(direct);
  } catch {
    const extracted = findBalancedJsonSegment(text);
    if (extracted) {
      try {
        const parsed = JSON.parse(extracted) as unknown;
        return parseIssueArray(parsed);
      } catch {
        // Fall through to the deterministic fallback issue.
      }
    }
  }

  if (!dryRun) {
    throw new Error(`Failed to parse ${phase} output into IssueSpec JSON`);
  }

  return [fallbackDryRunIssue(runId, originalRequest)];
}

function assertNonEmptyIssues(
  issues: IssueSpec[],
  phase: "planner" | "critic",
): IssueSpec[] {
  if (issues.length === 0) {
    throw new Error(`${phase} output produced zero issues`);
  }

  return issues;
}

export async function planRun(input: PlanRunInput): Promise<PlanRunResult> {
  const manifest = await readManifest(input.runDir);

  await updateManifest(input.runDir, { stage: "planning" });

  const plannerTemplate = await loadPromptTemplate("brain-planner");
  const plannerPrompt = renderTemplate(plannerTemplate, {
    original_request: manifest.original_request,
    repo_root: input.repoRoot,
    workflow_design: input.workflowDesign,
  });
  const plannerResult = await input.codex.invoke({
    role: "brain_planner",
    model: input.config.profiles.brain_planner.model,
    reasoningEffort: input.config.profiles.brain_planner.reasoning_effort,
    prompt: plannerPrompt,
    runDir: input.runDir,
    artifactName: "brain-planner",
  });

  await writeTextArtifact(
    input.runDir,
    "research.md",
    buildPlannerArtifact(plannerResult.text, "Research", "Research notes"),
  );
  await writeTextArtifact(
    input.runDir,
    "architecture-plan.md",
    buildPlannerArtifact(plannerResult.text, "Architecture Plan", "Architecture plan"),
  );

  const draftedIssues = assertNonEmptyIssues(
    parseIssuesOrFallback(
      plannerResult.text,
      manifest.run_id,
      manifest.original_request,
      input.dryRun,
      "planner",
    ),
    "planner",
  );

  await updateManifest(input.runDir, { stage: "issue_drafting" });
  await writeTextArtifact(
    input.runDir,
    "issues.json",
    `${JSON.stringify(draftedIssues, null, 2)}\n`,
  );

  await updateManifest(input.runDir, { stage: "issue_critique" });

  const criticTemplate = await loadPromptTemplate("brain-issue-critic");
  const criticPrompt = renderTemplate(criticTemplate, {
    original_request: manifest.original_request,
    issues_json: JSON.stringify(draftedIssues, null, 2),
  });
  const criticResult = await input.codex.invoke({
    role: "brain_planner",
    model: input.config.profiles.brain_planner.model,
    reasoningEffort: input.config.profiles.brain_planner.reasoning_effort,
    prompt: criticPrompt,
    runDir: input.runDir,
    artifactName: "brain-issue-critic",
  });

  await writeTextArtifact(input.runDir, "issue-review.md", criticResult.text);

  const reviewedIssues = assertNonEmptyIssues(
    parseIssuesOrFallback(
      criticResult.text,
      manifest.run_id,
      manifest.original_request,
      input.dryRun,
      "critic",
    ),
    "critic",
  );

  await writeTextArtifact(
    input.runDir,
    "issues.json",
    `${JSON.stringify(reviewedIssues, null, 2)}\n`,
  );

  const issueNumbers: number[] = [];
  for (const issue of reviewedIssues) {
    issueNumbers.push(await input.github.createIssue(issue));
  }

  await updateManifest(input.runDir, {
    stage: "ready_for_hands",
    issue_numbers: issueNumbers,
  });

  return { issueNumbers };
}
