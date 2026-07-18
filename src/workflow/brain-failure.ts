import { readManifestV2, updateManifestV2, withRunLedgerCompoundTransaction } from "../core/ledger.js";
import { z } from "zod";
import { readdir } from "node:fs/promises";
import { basename } from "node:path";
import type { BrainControllerClaim } from "../core/types.js";
import { PlanReadinessError, type PlanReadinessDiagnostic } from "../core/execution-spec.js";
import { readOwnedEvidenceFile } from "../core/owned-evidence.js";
import { writeOwnedEvidenceFile } from "../core/owned-evidence.js";

export type BrainFailurePhase = "discovery" | "planning";

const brainFailureSchema = z.object({
  phase: z.enum(["discovery", "planning"]),
  cycle: z.number().int().positive().nullable(),
  turn: z.number().int().positive().nullable(),
  attempt: z.number().int().positive(),
  failure_kind: z.enum(["output_validation", "discovery_validation", "plan_readiness", "codex_invocation", "brain_invocation"]),
  evidence_refs: z.array(z.string().min(1)),
  detail: z.object({
    code: z.enum(["output_validation", "discovery_validation", "plan_readiness", "codex_invocation", "brain_invocation"]),
    message: z.string().min(1).max(160),
  }).strict(),
  diagnostics: z.array(z.object({ code: z.string().min(1).max(64), path: z.string().min(1).max(512), message: z.string().min(1).max(240) }).strict()).max(128).optional(),
  candidate_ref: z.string().min(1).optional(),
  candidate_sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  attempt_kind: z.enum(["full", "repair"]).optional(),
  diagnostic_fingerprint: z.string().max(4096).optional(),
}).strict();

export type BrainFailure = z.infer<typeof brainFailureSchema>;

export function brainFailureBlocker(phase: BrainFailurePhase): string {
  return `Brain ${phase} failed; resume the run to retry from the same durable stage.`;
}

export async function brainInvocationArtifactName(
  runDir: string,
  phase: BrainFailurePhase,
  base: string,
): Promise<string> {
  const entries = await Promise.all(["prompts", "schemas", "responses", "failures"].map(async (directory) => ({
    directory,
    names: await readdir(`${runDir}/${directory}`).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
      throw error;
    }),
  })));
  const isUsed = (candidate: string): boolean => entries.some(({ directory, names }) => names.some((name) => {
    if (directory === "prompts") return name === `${candidate}.md`;
    if (directory === "schemas") return name === `${candidate}.json`;
    if (directory === "responses") return name === `${candidate}.json` || name.startsWith(`${candidate}.`);
    return name.startsWith(`brain-${phase}-${candidate}-`);
  }));
  const priorFailures = entries.find(({ directory }) => directory === "failures")?.names
    .filter((name) => name.startsWith(`brain-${phase}-`)).length ?? 0;
  for (let ordinal = 1; ; ordinal += 1) {
    const candidate = ordinal === 1 ? base : `${base}-resume-${ordinal}`;
    if (ordinal > priorFailures && !isUsed(candidate)) return candidate;
  }
}

export async function claimBrainPlanning(input: {
  runDir: string;
  invocationId: string;
  artifactName: string;
  owner?: string;
  ownerPid?: number;
  now?: Date;
  attemptKind?: "full" | "repair";
  attemptOrdinal?: number;
}): Promise<BrainControllerClaim> {
  return withRunLedgerCompoundTransaction(input.runDir, async (transaction) => {
    const manifest = await transaction.readManifestV2();
    if (manifest.stage !== "brain_planning") throw new Error(`Brain planning requires stage brain_planning, got ${manifest.stage}`);
    if ((manifest.current_revision ?? manifest.current_plan_revision) !== null) {
      throw new Error("Brain planning cannot claim a run that already has a current plan revision");
    }
    const now = input.now ?? new Date();
    const current = manifest.brain_controller_claim ?? null;
    if (current !== null) {
      let ownerProvablyDead = false;
      try {
        process.kill(current.owner_pid, 0);
      } catch (error: unknown) {
        ownerProvablyDead = error instanceof Error && "code" in error && error.code === "ESRCH";
      }
      if (!ownerProvablyDead) {
        throw new Error(`Brain planning is already claimed by invocation ${current.invocation_id}`);
      }
    }
    const claim: BrainControllerClaim = {
      phase: "planning",
      invocation_id: input.invocationId,
      owner: input.owner ?? "brain-planner",
      owner_pid: input.ownerPid ?? process.pid,
      artifact_name: input.artifactName,
      claimed_at: now.toISOString(),
      ...(input.attemptKind ? { attempt_kind: input.attemptKind } : {}),
      ...(input.attemptOrdinal ? { attempt_ordinal: input.attemptOrdinal } : {}),
    };
    await transaction.updateManifestV2({ brain_controller_claim: claim });
    return claim;
  });
}

export async function releaseBrainPlanningClaim(runDir: string, invocationId: string): Promise<void> {
  await withRunLedgerCompoundTransaction(runDir, async (transaction) => {
    const manifest = await transaction.readManifestV2();
    const claim = manifest.brain_controller_claim ?? null;
    if (claim === null) return;
    if (claim.invocation_id !== invocationId) {
      throw new Error("Brain planning claim cannot be released by another invocation");
    }
    await transaction.updateManifestV2({ brain_controller_claim: null });
  });
}

function safeFailureMessage(kind: z.infer<typeof brainFailureSchema>["failure_kind"]): string {
  if (kind === "output_validation") return "Brain output did not match the required schema.";
  if (kind === "discovery_validation") return "Brain discovery output did not satisfy the semantic contract.";
  if (kind === "plan_readiness") return "Brain plan did not satisfy execution-readiness checks.";
  if (kind === "codex_invocation") return "Codex invocation did not complete successfully.";
  return "Brain invocation did not complete successfully.";
}

export async function recordBrainFailure(input: {
  runDir: string;
  phase: BrainFailurePhase;
  cycle: number | null;
  turn: number | null;
  attempt: number;
  error: unknown;
  evidence_refs: string[];
  artifact_name?: string;
  controller_claim_token?: string;
  diagnostics?: PlanReadinessDiagnostic[];
  candidate_ref?: string;
  candidate_sha256?: string;
  attempt_kind?: "full" | "repair";
  diagnostic_fingerprint?: string;
}): Promise<string> {
  const errorName = input.error instanceof Error ? input.error.name : "";
  const failureKind = input.error instanceof PlanReadinessError ? "plan_readiness"
    : errorName === "ZodError" ? "output_validation"
    : errorName === "DiscoveryValidationError" ? "discovery_validation"
      : errorName === "CodexInvocationError" ? "codex_invocation"
        : "brain_invocation";
  const stamp = new Date().toISOString().replaceAll(/[^0-9]/g, "");
  const inferredName = input.evidence_refs.map((path) => basename(path).replace(/\.(?:md|json|stdout\.txt|stderr\.txt)$/, "")).find(Boolean);
  const artifactName = input.artifact_name ?? inferredName ?? "unknown-invocation";
  const path = `failures/brain-${input.phase}-${artifactName}-${stamp}-${process.hrtime.bigint()}-attempt-${input.attempt}.json`;
  const failure = brainFailureSchema.parse({
    phase: input.phase,
    cycle: input.cycle,
    turn: input.turn,
    attempt: input.attempt,
    failure_kind: failureKind,
    evidence_refs: input.evidence_refs,
    detail: { code: failureKind, message: safeFailureMessage(failureKind) },
    ...(input.diagnostics ? { diagnostics: input.diagnostics } : {}),
    ...(input.candidate_ref ? { candidate_ref: input.candidate_ref } : {}),
    ...(input.candidate_sha256 ? { candidate_sha256: input.candidate_sha256 } : {}),
    ...(input.attempt_kind ? { attempt_kind: input.attempt_kind } : {}),
    ...(input.diagnostic_fingerprint ? { diagnostic_fingerprint: input.diagnostic_fingerprint } : {}),
  });
  await writeOwnedEvidenceFile(input.runDir, path, "failures/", `${JSON.stringify(failure, null, 2)}\n`);
  await withRunLedgerCompoundTransaction(input.runDir, async (transaction) => {
    const manifest = await transaction.readManifestV2();
    const claim = manifest.brain_controller_claim ?? null;
    if (input.controller_claim_token !== undefined && claim !== null && claim.invocation_id !== input.controller_claim_token) {
      throw new Error("Brain failure cannot clear a controller claim owned by another invocation");
    }
    await transaction.updateManifestV2({
      ...(input.controller_claim_token !== undefined && claim?.invocation_id === input.controller_claim_token
        ? { brain_controller_claim: null }
        : {}),
      delivery_state: "blocked",
      last_blocker: brainFailureBlocker(input.phase),
    });
  });
  return path;
}

export async function readLatestBrainFailure(runDir: string, phase: BrainFailurePhase): Promise<{ path: string; failure: BrainFailure } | null> {
  const names = (await readdir(`${runDir}/failures`).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  })).filter((name) => name.startsWith(`brain-${phase}-`) && name.endsWith(".json")).sort();
  const name = names.at(-1);
  if (!name) return null;
  const path = `failures/${name}`;
  const failure = brainFailureSchema.parse(JSON.parse((await readOwnedEvidenceFile(runDir, path, "failures/")).toString("utf8")));
  return { path, failure };
}

export async function clearBrainFailure(runDir: string, phase: BrainFailurePhase): Promise<void> {
  const manifest = await readManifestV2(runDir);
  if (manifest.last_blocker !== brainFailureBlocker(phase)) return;
  await updateManifestV2(runDir, { delivery_state: "pending", last_blocker: null });
}
