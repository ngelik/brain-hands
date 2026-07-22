import type { CodexAdapter, CodexInvokeResult } from "../adapters/codex.js";
import { implementationResultOutputSchema } from "../core/output-schemas.js";
import { fixPacketResultV1OutputSchema } from "../core/output-schemas.js";
import { executionSpecV2Schema, implementationResultSchema } from "../core/schema.js";
import { assertFixPacketResultMatchesPacket, fixAttemptSupplementV1Schema, fixPacketResultV1Schema, hashReviewFixPacket, reviewFixPacketReadinessErrors, reviewFixPacketV1Schema, type FixAttemptSupplementV1, type FixPacketResultV1, type ReviewFixPacketV1 } from "../core/review-fix-packet.js";
import type {
  ImplementationResult,
  ResolvedRunIntake,
  HandsAttemptKind,
  HandsProfileKind,
  RoleProfile,
  VerifierFinding,
  WorkItem,
} from "../core/types.js";
import { readManifestV2, writeCreateOnceValidated, writeTextArtifact } from "../core/ledger.js";
import { loadPromptTemplate } from "../prompts/loader.js";
import { renderTemplate } from "../prompts/renderer.js";
import type { ProgressReporter } from "../progress/log.js";
import type { ResourceBudgetPort } from "../core/resource-budget.js";
import { reviewFixPacketRoot, validateBoundedFixPacketAuthority } from "./fix-packets.js";
import { z } from "zod";
import { readOptionalValidatedArtifact } from "../core/ledger.js";
import type { ArtifactRefV1, HandsContextV1 } from "../core/context-contracts.js";
import { validateHandsInvocationContext } from "./role-context.js";
import { invocationArtifactName } from "./invocation-artifacts.js";
import { compactModelDiff } from "./model-diff.js";

const legacyHandsWorkItemTemplate = `# Hands: implement one approved work item

You are Hands. Modify only the supplied worktree and only the approved work item.
Do not change the plan, widen scope, use GitHub, push, merge, or approve your own work.
Use the worktree supplied by the caller as your current directory. Return only JSON matching
the supplied implementation result schema.
Treat file_contract, forbidden_changes, change_units, and completion_contract as hard constraints.
Complete change_units in listed order and use their stable ids in completed_steps.
Run approved verification commands in listed order.
Stop after the first failed or timed-out command.
Caller and fixture paths are compatibility evidence, not edit authorization.
If any ambiguity_policy.stop_when condition occurs, stop without guessing and report it in remaining_risks.

## Approved work item

{{work_item_json}}

## Verifier findings to fix (empty for the first attempt)

{{findings_json}}

## Diagnostic context

{{diagnostic_context}}

Report changed files, tests or other commands actually attempted, completed steps, and
remaining risks. Do not claim commands or files that you did not actually run or change.
`;

const legacyHandsRecoveryTemplate = `# Hands recovery attempt

You are Hands. Modify only the supplied worktree and only the approved work item.
Return only JSON matching the supplied implementation result schema.

## Approved work item

{{work_item_json}}

## Verifier findings

{{findings_json}}

## Recovery context

{{diagnostic_context}}

Form an independent diagnosis from the approved criteria, current diff, unresolved
findings, and saved evidence. Do not repeat a prior edit without explaining why the
evidence supports it. Do not widen scope.
`;

const legacyHandsFixPacketTemplate = `# Hands: implement one review fix packet

Implement exactly the active immutable fix packet. Do not redesign the approved work item,
change files outside \`completion_contract.expected_changed_files\`, or act on findings not in
this packet. Complete every required change unit and preserve every forbidden-change rule.
If the packet is contradictory, report the exact unresolved requirement instead of applying
a partial best-effort fix. Return only JSON matching the supplied result schema.
Every \`unresolved_requirements[].requirement\` must quote one requirement string exactly from
the referenced packet change unit. Never turn a verification success condition, command
failure, sandbox limitation, or operational blocker into an unresolved change-unit requirement.
\`status\` reports remediation completion: when every change unit is complete, return
\`implemented\` even if a listed verification command failed or could not start; record that
command outcome only in \`commands_attempted\`. For \`implemented\`, return exactly
\`unresolved_requirements: []\` and \`blocker: null\`; never copy a verification-command failure
into \`blocker\`. The controller independently verifies the change.
Echo this controller-owned packet hash exactly as \`packet_sha256\`: {{fix_packet_sha256}}
Echo this controller-owned packet attempt exactly as \`action_attempt\`: {{action_attempt}}
In \`commands_attempted\`, report only commands whose \`command_id\` and exact \`argv\` appear in
the packet's \`verification.commands\`. Do not invent packet command IDs or report auxiliary commands.

## Active fix packet

{{fix_packet_json}}

## Approved work item

{{work_item_json}}

## Relevant source context

{{source_context_json}}

## Evidence context

{{evidence_context_json}}

## Completed dependency summaries

{{completed_dependencies_json}}

## Current packet-scoped diff

{{current_diff}}

## Retry supplement

{{supplement_json}}
`;

const fixPacketInvocationClaimSchema = z.object({
  packet_id: z.string().min(1), packet_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  action_attempt: z.number().int().positive(), model: z.string().min(1), reasoning_effort: z.string().min(1),
  profile_kind: z.enum(["primary", "backup"]),
  state: z.literal("started"),
}).strict();

const legacyFixPacketInvocationClaimSchema = z.object({
  packet_id: z.string().min(1), packet_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  action_attempt: z.number().int().positive(), model: z.string().min(1), reasoning_effort: z.string().min(1),
  state: z.literal("started"),
}).strict();

const persistedFixPacketInvocationClaimSchema = z.union([
  fixPacketInvocationClaimSchema,
  legacyFixPacketInvocationClaimSchema,
]);

function fixPacketResultOutputSchema(
  packet: ReviewFixPacketV1,
  packetSha256: string,
  actionAttempt: number,
) {
  const commandAttemptSchema = fixPacketResultV1OutputSchema.properties.commands_attempted.items;
  return {
    ...fixPacketResultV1OutputSchema,
    properties: {
      ...fixPacketResultV1OutputSchema.properties,
      packet_id: { type: "string", enum: [packet.provenance.packet_id] },
      packet_sha256: { type: "string", enum: [packetSha256] },
      action_attempt: { type: "integer", enum: [actionAttempt] },
      commands_attempted: {
        type: "array",
        items: {
          anyOf: packet.verification.commands.map((command) => ({
            ...commandAttemptSchema,
            properties: {
              ...commandAttemptSchema.properties,
              command_id: { type: "string", enum: [command.id] },
              argv: { type: "array", const: command.argv },
            },
          })),
        },
      },
    },
  } as const;
}

export type HandsFixPacketInvocationProfile = {
  kind: HandsProfileKind;
  model: string;
  reasoning_effort: string;
};

export interface HandsWorkItemInput {
  runDir: string;
  worktreePath: string;
  workItem: WorkItem;
  intake: ResolvedRunIntake;
  codex: CodexAdapter;
  attempt?: number;
  progress?: ProgressReporter;
  workItemIndex?: number;
  workItemTotal?: number;
  findings?: VerifierFinding[];
  profile?: Pick<RoleProfile, "model" | "reasoning_effort">;
  profileKind?: HandsProfileKind;
  attemptKind?: HandsAttemptKind;
  diagnosticContext?: string;
  contextRef?: ArtifactRefV1;
  context?: HandsContextV1;
  contextPlanRevision?: number;
  budget?: ResourceBudgetPort;
}

export interface HandsWorkItemResult {
  implementation: ImplementationResult;
  reportPath: string;
  invocation: CodexInvokeResult;
}

export interface HandsFixPacketInput {
  runDir: string;
  worktreePath: string;
  workItem: WorkItem;
  packet: ReviewFixPacketV1;
  actionAttempt: number;
  intake: ResolvedRunIntake;
  codex: CodexAdapter;
  relevantSourceContext: unknown[];
  evidenceContext: unknown[];
  completedDependencies: unknown[];
  currentDiff: string;
  supplement: FixAttemptSupplementV1 | null;
  contextRef?: ArtifactRefV1;
  context?: HandsContextV1;
  contextPlanRevision?: number;
  contextAttempt?: number;
  profile?: Pick<RoleProfile, "model" | "reasoning_effort">;
  profileKind?: HandsProfileKind;
  recoverStartedInvocation?: boolean;
  budget?: ResourceBudgetPort;
}

export interface HandsFixPacketResult {
  result: FixPacketResultV1;
  reportPath: string;
  invocation: CodexInvokeResult;
  profile: HandsFixPacketInvocationProfile;
}

export class HandsWorkItemFailedError extends Error {
  constructor(message: string, readonly result: CodexInvokeResult) {
    super(message);
    this.name = "HandsWorkItemFailedError";
  }
}

export class ImplementationResultMismatchError extends Error {
  constructor(expectedWorkItemId: string, actualWorkItemId: string) {
    super(`Hands returned work item ${actualWorkItemId}, expected ${expectedWorkItemId}`);
    this.name = "ImplementationResultMismatchError";
  }
}

export async function readHandsFixPacketInvocationProfile(
  runDir: string,
  packet: ReviewFixPacketV1,
  actionAttempt: number,
): Promise<HandsFixPacketInvocationProfile> {
  const root = `${reviewFixPacketRoot(packet.provenance.packet_id)}/attempts/${actionAttempt}`;
  const claim = await readOptionalValidatedArtifact(
    runDir,
    `${root}/hands-invocation-claim.json`,
    persistedFixPacketInvocationClaimSchema,
  );
  if (!claim) throw new Error("Persisted Hands fix packet result is missing its invocation claim");
  if (
    claim.packet_id !== packet.provenance.packet_id
    || claim.packet_sha256 !== hashReviewFixPacket(packet)
    || claim.action_attempt !== actionAttempt
  ) throw new Error("Persisted Hands fix packet invocation claim provenance does not match the active packet");
  if ("profile_kind" in claim) {
    return { kind: claim.profile_kind, model: claim.model, reasoning_effort: claim.reasoning_effort };
  }
  const manifest = await readManifestV2(runDir);
  const primary = manifest.selected_role_profiles.hands ?? manifest.role_profiles.hands;
  if (!primary || primary.model !== claim.model || primary.reasoning_effort !== claim.reasoning_effort) {
    throw new Error("Legacy Hands fix packet claim does not match the snapshotted primary profile");
  }
  return { kind: "primary", model: claim.model, reasoning_effort: claim.reasoning_effort };
}

function artifactId(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function assertSuccessfulInvocation(
  workItem: WorkItem,
  result: CodexInvokeResult,
): void {
  if (result.exitCode === 0) return;
  throw new HandsWorkItemFailedError(
    `Hands implementation failed for ${workItem.id}: exitCode=${result.exitCode ?? "null"}`,
    result,
  );
}

function parseImplementation(result: CodexInvokeResult): ImplementationResult {
  if (result.parsed === undefined) {
    throw new Error("Hands did not return a parsed implementation result");
  }
  return implementationResultSchema.parse(result.parsed);
}

async function validatedBoundedContext(
  runDir: string,
  contextRef: ArtifactRefV1 | undefined,
  context: HandsContextV1 | undefined,
  workItem: WorkItem,
  expected: { planRevision?: number; attempt: number; attemptKind: HandsAttemptKind },
): Promise<{
  context_ref: ArtifactRefV1;
  context: HandsContextV1;
  plan_revision: number;
  plan_sha256: string;
} | null> {
  if (contextRef === undefined && context === undefined) return null;
  if (contextRef === undefined || context === undefined) {
    throw new Error("Bounded Hands context requires both contextRef and context");
  }
  return validateHandsInvocationContext({
    runDir,
    contextRef,
    context,
    workItem,
    workItemId: workItem.id,
    planRevision: expected.planRevision,
    attempt: expected.attempt,
    attemptKind: expected.attemptKind,
  });
}

/** Invoke Hands for exactly one approved work item in the isolated worktree. */
export async function runHandsWorkItem(input: HandsWorkItemInput): Promise<HandsWorkItemResult> {
  if (input.worktreePath.trim() === "") {
    throw new Error("Hands worktree path is required");
  }

  const profileKind = input.profileKind ?? "primary";
  const attemptKind = input.attemptKind ?? (input.attempt === undefined || input.attempt === 1 ? "initial" : "primary_fix");
  const attempt = input.attempt ?? 1;
  const boundedContext = await validatedBoundedContext(
    input.runDir,
    input.contextRef,
    input.context,
    input.workItem,
    { planRevision: input.contextPlanRevision, attempt, attemptKind },
  );
  const recovery = attemptKind === "quality_recovery"
    || (boundedContext === null && input.diagnosticContext !== undefined);
  const template = boundedContext
    ? await loadPromptTemplate(recovery ? "hands-recovery-v2" : "hands-work-item-v2")
    : recovery ? legacyHandsRecoveryTemplate : legacyHandsWorkItemTemplate;
  const prompt = boundedContext
    ? renderTemplate(template, { context_package_json: JSON.stringify({
        context_ref: boundedContext.context_ref,
        context: boundedContext.context,
      }, null, 2) })
    : renderTemplate(template, {
        work_item_json: JSON.stringify(input.workItem, null, 2),
        findings_json: JSON.stringify(input.findings ?? [], null, 2),
        diagnostic_context: input.diagnosticContext ?? "No recovery context supplied.",
      });
  const id = artifactId(input.workItem.id);
  const workItemCoordinate = {
    index: input.workItemIndex ?? 1,
    total: input.workItemTotal ?? 1,
    attempt,
    final: input.workItem.id === "integrated",
  };
  const suffix = profileKind === "backup" || attemptKind === "quality_recovery" ? `-${attemptKind}-${profileKind}` : "";
  const artifactName = await invocationArtifactName(
    input.runDir,
    `hands-work-item-${id}-attempt-${attempt}${suffix}`,
  );
  await writeTextArtifact(input.runDir, `prompts/${artifactName}.md`, prompt);
  await writeTextArtifact(
    input.runDir,
    `schemas/${artifactName}.json`,
    `${JSON.stringify(implementationResultOutputSchema, null, 2)}\n`,
  );

  const profile = input.profile ?? input.intake.roles.hands;
  const invocation = await input.codex.invoke({
    role: "hands",
    model: profile.model,
    reasoningEffort: profile.reasoning_effort,
    sandbox: "workspace-write",
    cwd: input.worktreePath,
    prompt,
    runDir: input.runDir,
    artifactName,
    budget: input.budget,
    attemptKey: boundedContext === null
      ? undefined
      : `hands:${boundedContext.plan_revision}:${input.workItem.id}:${attempt}:${attemptKind}`,
    outputSchema: implementationResultOutputSchema,
    outputParser: implementationResultSchema,
    progress: input.progress ? { reporter: input.progress, context: { source: "hands", mode: (boundedContext?.context.active_findings.length ?? input.findings?.length ?? 0) > 0 ? "fix" : "implementation", model: profile.model, reasoningEffort: profile.reasoning_effort, workItem: workItemCoordinate } } : undefined,
  });
  assertSuccessfulInvocation(input.workItem, invocation);
  const implementation = parseImplementation(invocation);
  if (implementation.work_item_id !== input.workItem.id) {
    throw new ImplementationResultMismatchError(input.workItem.id, implementation.work_item_id);
  }

  await writeTextArtifact(
    input.runDir,
    `responses/${artifactName}.json`,
    `${JSON.stringify(implementation, null, 2)}\n`,
  );
  const reportPath = await writeTextArtifact(
    input.runDir,
    `implementation/${id}/attempt-${attempt}.json`,
    `${JSON.stringify({
      ...implementation,
      summary: implementation.completed_steps.join("\n"),
      known_limitations: implementation.remaining_risks,
      model: profile.model,
      reasoning_effort: profile.reasoning_effort,
      profile_kind: profileKind,
    }, null, 2)}\n`,
  );
  await input.progress?.emit({ code: "implementation_recorded", source: "hands", workItem: workItemCoordinate });

  return { implementation, reportPath, invocation };
}

/** Explicit alias used by callers that describe Hands as a worker. */
export const executeHandsWorkItem = runHandsWorkItem;
export const implementWorkItem = runHandsWorkItem;
export const runHands = runHandsWorkItem;

export async function runHandsFixPacket(input: HandsFixPacketInput): Promise<HandsFixPacketResult> {
  if (!Number.isSafeInteger(input.actionAttempt) || input.actionAttempt < 1) {
    throw new Error("Hands fix packet action attempt must be a positive safe integer");
  }
  if (input.worktreePath.trim() === "") throw new Error("Hands worktree path is required");
  const workItem = executionSpecV2Schema.parse(input.workItem);
  let packet = reviewFixPacketV1Schema.parse(input.packet);
  let supplement = fixAttemptSupplementV1Schema.nullable().parse(input.supplement);
  if (packet.provenance.work_item_id !== workItem.id) {
    throw new Error("Hands fix packet work-item provenance does not match the invocation");
  }
  const packetSha256 = hashReviewFixPacket(packet);
  if (supplement !== null) {
    if (supplement.packet_id !== packet.provenance.packet_id) throw new Error("Hands fix packet supplement packet ID does not match");
    if (supplement.base_packet_sha256 !== packetSha256) throw new Error("Hands fix packet supplement base packet hash does not match");
    if (supplement.next_attempt !== input.actionAttempt) throw new Error("Hands fix packet supplement next attempt does not match action attempt");
    if (new Set(supplement.unsatisfied_condition_ids).size !== supplement.unsatisfied_condition_ids.length) {
      throw new Error("Hands fix packet supplement contains duplicate unsatisfied condition IDs");
    }
    const conditionIds = new Set(packet.verification.success_conditions.map(({ id }) => id));
    for (const id of supplement.unsatisfied_condition_ids) {
      if (!conditionIds.has(id)) throw new Error(`Hands fix packet supplement references unknown success condition ${id}`);
    }
  }
  const hasBoundedContext = input.contextRef !== undefined || input.context !== undefined;
  if (hasBoundedContext && input.contextAttempt === undefined) {
    throw new Error("Bounded Hands fix packet requires its context attempt coordinate");
  }
  const boundedContext = await validatedBoundedContext(
    input.runDir,
    input.contextRef,
    input.context,
    workItem,
    { planRevision: input.contextPlanRevision, attempt: input.contextAttempt ?? input.actionAttempt, attemptKind: "fix_packet" },
  );
  if (boundedContext !== null && packet.provenance.approved_plan_sha256 !== boundedContext.plan_sha256) {
    throw new Error("Hands fix packet approved plan hash does not match bounded context authority");
  }
  if (boundedContext !== null) {
    const durable = await validateBoundedFixPacketAuthority({
      runDir: input.runDir,
      workItem,
      packet,
      actionAttempt: input.actionAttempt,
      supplement,
      verifierProfile: input.intake.roles.verifier,
    });
    packet = durable.packet;
    supplement = durable.supplement;
    const readinessErrors = reviewFixPacketReadinessErrors(packet, { approved_plan_sha256: boundedContext.plan_sha256 });
    if (readinessErrors.length > 0) {
      throw new Error(`Hands fix packet is not ready for bounded execution: ${readinessErrors.join("; ")}`);
    }
  }
  const root = `${reviewFixPacketRoot(packet.provenance.packet_id)}/attempts/${input.actionAttempt}`;
  const primaryReportPath = `${root}/hands-result.json`;
  let reportPath = primaryReportPath;
  const claimPath = `${root}/hands-invocation-claim.json`;
  const existingResult = await readOptionalValidatedArtifact(input.runDir, primaryReportPath, fixPacketResultV1Schema);
  const retryOperationalBlock = existingResult?.status === "operationally_blocked" && input.recoverStartedInvocation === true;
  if (existingResult && !retryOperationalBlock) {
    if (existingResult.packet_id !== packet.provenance.packet_id || existingResult.packet_sha256 !== packetSha256 || existingResult.action_attempt !== input.actionAttempt) {
      throw new Error("Persisted Hands fix packet result provenance does not match the active packet");
    }
    assertFixPacketResultMatchesPacket(input.packet, existingResult);
    return {
      result: existingResult,
      reportPath,
      invocation: {} as never,
      profile: await readHandsFixPacketInvocationProfile(input.runDir, input.packet, input.actionAttempt),
    };
  }
  if (retryOperationalBlock) {
    reportPath = `${root}/hands-result-recovery.json`;
    const recoveredResult = await readOptionalValidatedArtifact(input.runDir, reportPath, fixPacketResultV1Schema);
    if (recoveredResult) {
      assertFixPacketResultMatchesPacket(input.packet, recoveredResult);
      return {
        result: recoveredResult,
        reportPath,
        invocation: {} as never,
        profile: await readHandsFixPacketInvocationProfile(input.runDir, input.packet, input.actionAttempt),
      };
    }
  }
  const existingClaim = await readOptionalValidatedArtifact(input.runDir, claimPath, fixPacketInvocationClaimSchema);
  const profile = input.profile ?? input.intake.roles.hands;
  const profileKind = input.profileKind ?? "primary";
  if (existingClaim && !input.recoverStartedInvocation) {
    throw new Error(`Ambiguous Hands fix packet invocation for ${packet.provenance.packet_id} attempt ${input.actionAttempt}`);
  }
  if (existingClaim && (
    existingClaim.packet_id !== packet.provenance.packet_id
    || existingClaim.packet_sha256 !== packetSha256
    || existingClaim.action_attempt !== input.actionAttempt
    || existingClaim.model !== profile.model
    || existingClaim.reasoning_effort !== profile.reasoning_effort
    || ("profile_kind" in existingClaim && existingClaim.profile_kind !== profileKind)
  )) throw new Error("Authorized Hands fix packet recovery does not match its immutable invocation claim");
  const template = boundedContext ? await loadPromptTemplate("hands-fix-packet-v1") : legacyHandsFixPacketTemplate;
  const prompt = boundedContext
    ? renderTemplate(template, {
        context_package_json: JSON.stringify({
          context_ref: boundedContext.context_ref,
          context: boundedContext.context,
          fix_packet: packet,
          fix_packet_sha256: packetSha256,
          action_attempt: input.actionAttempt,
          retry_supplement: supplement,
        }, null, 2),
      })
    : renderTemplate(template, {
        fix_packet_json: JSON.stringify(packet, null, 2), work_item_json: JSON.stringify(workItem, null, 2),
        source_context_json: JSON.stringify(input.relevantSourceContext, null, 2), evidence_context_json: JSON.stringify(input.evidenceContext, null, 2),
        completed_dependencies_json: JSON.stringify(input.completedDependencies, null, 2), current_diff: compactModelDiff(input.currentDiff),
        supplement_json: JSON.stringify(supplement, null, 2), fix_packet_sha256: packetSha256,
        action_attempt: String(input.actionAttempt),
      });
  const baseArtifactName = `hands-fix-packet-${artifactId(packet.provenance.packet_id)}-attempt-${input.actionAttempt}`;
  const artifactName = existingClaim
    ? await invocationArtifactName(input.runDir, baseArtifactName)
    : baseArtifactName;
  await writeTextArtifact(input.runDir, `prompts/${artifactName}.md`, prompt);
  const outputSchema = fixPacketResultOutputSchema(
    packet,
    packetSha256,
    input.actionAttempt,
  );
  await writeTextArtifact(input.runDir, `schemas/${artifactName}.json`, `${JSON.stringify(outputSchema, null, 2)}\n`);
  if (!existingClaim) {
    await writeCreateOnceValidated(input.runDir, claimPath, {
      packet_id: packet.provenance.packet_id, packet_sha256: packetSha256,
      action_attempt: input.actionAttempt, model: profile.model, reasoning_effort: profile.reasoning_effort,
      profile_kind: profileKind, state: "started",
    }, fixPacketInvocationClaimSchema);
  }
  const invocation = await input.codex.invoke({
    role: "hands", model: profile.model, reasoningEffort: profile.reasoning_effort, sandbox: "workspace-write", cwd: input.worktreePath,
    prompt, runDir: input.runDir, artifactName, outputSchema, outputParser: fixPacketResultV1Schema,
    budget: input.budget,
    attemptKey: boundedContext === null
      ? undefined
      : `hands:${boundedContext.plan_revision}:${workItem.id}:${input.contextAttempt ?? input.actionAttempt}:fix_packet`,
  });
  if (invocation.exitCode !== 0 || invocation.parsed === undefined) throw new HandsWorkItemFailedError(`Hands fix packet failed for ${packet.provenance.packet_id}`, invocation);
  const result = fixPacketResultV1Schema.parse(invocation.parsed);
  if (result.packet_id !== packet.provenance.packet_id || result.packet_sha256 !== packetSha256 || result.action_attempt !== input.actionAttempt) {
    throw new Error("Hands fix packet result provenance does not match the active packet");
  }
  assertFixPacketResultMatchesPacket(packet, result);
  await writeCreateOnceValidated(input.runDir, reportPath, result, fixPacketResultV1Schema);
  return {
    result,
    reportPath,
    invocation,
    profile: { kind: profileKind, model: profile.model, reasoning_effort: profile.reasoning_effort },
  };
}
