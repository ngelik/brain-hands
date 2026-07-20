import { readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  readManifestV2,
  readOptionalValidatedArtifact,
  updateManifestV2,
  withRunLedgerTransaction,
  writeImmutableValidatedJson,
} from "../core/ledger.js";
import {
  ResourceBudgetExceededError,
  reduceResourceBudgetArtifacts,
  resourceBudgetClaimV1Schema,
  resourceBudgetCompletionV1Schema,
  resourceBudgetPolicyV1Schema,
  resourceBudgetReconciliationV1Schema,
  type ResourceBudgetClaimInput,
  type ResourceBudgetClaimV1,
  type ResourceBudgetCompletionInput,
  type ResourceBudgetCompletionV1,
  type ResourceBudgetPolicyV1,
  type ResourceBudgetReconciliationV1,
  type ResourceBudgetPort,
  type ResourceBudgetUsage,
} from "../core/resource-budget.js";
import { artifactSegment, canonicalJsonBytes, type ArtifactRefV1 } from "../core/context-contracts.js";
import { readOwnedRunFile } from "../core/owned-evidence.js";

const POLICY_PATH = "budgets/policy.json";
const claimIdentitySchema = z.object({
  run_id: z.string().min(1),
  kind: z.enum(["model_invocation", "workflow_attempt", "verification_command", "external_effect"]),
  key: z.string().min(1),
}).strict();

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function claimPath(claimId: string): string {
  return `budgets/claims/${artifactSegment(claimId)}.json`;
}

function completionPath(claimId: string): string {
  return `budgets/completions/${artifactSegment(claimId)}.json`;
}

function reconciliationPath(claimId: string): string {
  return `budgets/reconciliations/${artifactSegment(claimId)}.json`;
}

function claimIdFor(runId: string, kind: ResourceBudgetClaimInput["kind"], key: string): string {
  const bytes = canonicalJsonBytes(claimIdentitySchema, { run_id: runId, kind, key });
  return `budget-claim:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function readBudgetArtifacts(runDir: string): Promise<{
  policy: ResourceBudgetPolicyV1;
  claims: ResourceBudgetClaimV1[];
  completions: ResourceBudgetCompletionV1[];
  reconciliations: ResourceBudgetReconciliationV1[];
}> {
  const manifest = await readManifestV2(runDir);
  if (manifest.workflow_protocol !== "bounded-context-v1") {
    throw new Error("Resource budgets require a bounded-context-v1 run");
  }
  if (manifest.resource_budget_policy === undefined) {
    throw new Error("Bounded run manifest is missing resource budget policy");
  }
  const manifestPolicy = resourceBudgetPolicyV1Schema.parse(manifest.resource_budget_policy);
  const filePolicy = await readOptionalValidatedArtifact(runDir, POLICY_PATH, resourceBudgetPolicyV1Schema);
  if (filePolicy === null) throw new Error("Bounded run is missing budgets/policy.json");
  if (!sameJson(manifestPolicy, filePolicy)) {
    throw new Error("Resource budget policy mismatch between manifest and budgets/policy.json");
  }

  const claims = await readArtifactDirectory(runDir, "budgets/claims", resourceBudgetClaimV1Schema);
  const completions = await readArtifactDirectory(runDir, "budgets/completions", resourceBudgetCompletionV1Schema);
  const reconciliations = await readArtifactDirectory(
    runDir,
    "budgets/reconciliations",
    resourceBudgetReconciliationV1Schema,
  );
  return { policy: filePolicy, claims, completions, reconciliations };
}

async function readArtifactDirectory<T>(
  runDir: string,
  directory: string,
  schema: z.ZodType<T>,
): Promise<T[]> {
  const entries = await readdir(`${runDir}/${directory}`, { withFileTypes: true }).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  });
  const values: T[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const value = await readOptionalValidatedArtifact(runDir, `${directory}/${entry.name}`, schema);
    if (value !== null) values.push(value);
  }
  return values;
}

function assertClaimAllowed(
  policy: ResourceBudgetPolicyV1,
  usage: ResourceBudgetUsage,
  input: ResourceBudgetClaimInput,
): void {
  const isChargeable = input.kind !== "workflow_attempt";
  if (isChargeable && usage.token_accounting === "uncertain") {
    throw new Error(`Resource budget token accounting is uncertain for ${usage.uncertain_model_claim_ids.join(", ")}`);
  }
  if (isChargeable && usage.token_overshoot > 0) {
    throw new ResourceBudgetExceededError("total_tokens", usage.total_tokens, policy.max_total_tokens, 0);
  }
  if (input.kind === "model_invocation" && usage.model_invocations + 1 > policy.max_model_invocations) {
    throw new ResourceBudgetExceededError("model_invocations", usage.model_invocations, policy.max_model_invocations, 1);
  }
  if (input.kind === "workflow_attempt" && usage.workflow_attempts + 1 > policy.max_workflow_attempts) {
    throw new ResourceBudgetExceededError("workflow_attempts", usage.workflow_attempts, policy.max_workflow_attempts, 1);
  }
  if (input.kind === "external_effect" && usage.external_effects + 1 > policy.max_external_effects) {
    throw new ResourceBudgetExceededError("external_effects", usage.external_effects, policy.max_external_effects, 1);
  }
  if (isChargeable && usage.active_elapsed_ms + input.elapsed_reservation_ms > policy.max_active_elapsed_ms) {
    throw new ResourceBudgetExceededError(
      "active_elapsed_ms",
      usage.active_elapsed_ms,
      policy.max_active_elapsed_ms,
      input.elapsed_reservation_ms,
    );
  }
}

export async function initializeResourceBudgetPolicy(
  runDir: string,
  policy: ResourceBudgetPolicyV1,
): Promise<ArtifactRefV1> {
  const parsed = resourceBudgetPolicyV1Schema.parse(policy);
  return withRunLedgerTransaction(runDir, async () => {
    const ref = await writeImmutableValidatedJson(runDir, POLICY_PATH, resourceBudgetPolicyV1Schema, parsed);
    const manifest = await readManifestV2(runDir);
    if (
      manifest.resource_budget_policy !== undefined
      && !sameJson(resourceBudgetPolicyV1Schema.parse(manifest.resource_budget_policy), parsed)
    ) {
      throw new Error("Manifest resource budget policy already exists with different values");
    }
    await updateManifestV2(runDir, { resource_budget_policy: { ...parsed } });
    return ref;
  });
}

export async function openResourceBudget(runDir: string): Promise<ResourceBudgetController> {
  await withRunLedgerTransaction(runDir, async () => {
    await readBudgetArtifacts(runDir);
  });
  return new ResourceBudgetController(runDir);
}

export class ResourceBudgetController implements ResourceBudgetPort {
  constructor(private readonly runDir: string) {}

  async usage(): Promise<ResourceBudgetUsage> {
    return withRunLedgerTransaction(this.runDir, async () => {
      const { policy, claims, completions, reconciliations } = await readBudgetArtifacts(this.runDir);
      return reduceResourceBudgetArtifacts(policy, claims, completions, reconciliations);
    });
  }

  async claim(input: ResourceBudgetClaimInput): Promise<ResourceBudgetClaimV1> {
    return withRunLedgerTransaction(this.runDir, async () => {
      const { policy, claims, completions, reconciliations } = await readBudgetArtifacts(this.runDir);
      const manifest = await readManifestV2(this.runDir);
      const claimId = claimIdFor(manifest.run_id, input.kind, input.key);
      const usage = reduceResourceBudgetArtifacts(policy, claims, completions, reconciliations);
      const existing = claims.find((claim) => claim.claim_id === claimId);
      if (existing !== undefined) {
        if (
          existing.kind !== input.kind
          || existing.key !== input.key
          || existing.elapsed_reservation_ms !== input.elapsed_reservation_ms
          || existing.run_id !== manifest.run_id
        ) {
          throw new Error(`Resource budget claim ${claimId} already exists with different bytes`);
        }
        return existing;
      }
      assertClaimAllowed(policy, usage, input);
      const claim = resourceBudgetClaimV1Schema.parse({
        schema_version: 1,
        claim_id: claimId,
        run_id: manifest.run_id,
        kind: input.kind,
        key: input.key,
        reserved_at: new Date().toISOString(),
        elapsed_reservation_ms: input.elapsed_reservation_ms,
      });
      await writeImmutableValidatedJson(this.runDir, claimPath(claim.claim_id), resourceBudgetClaimV1Schema, claim);
      return claim;
    });
  }

  async complete(input: ResourceBudgetCompletionInput): Promise<ResourceBudgetCompletionV1> {
    return withRunLedgerTransaction(this.runDir, async () => {
      const { policy, claims, completions, reconciliations } = await readBudgetArtifacts(this.runDir);
      reduceResourceBudgetArtifacts(policy, claims, completions, reconciliations);
      const claim = claims.find((candidate) => candidate.claim_id === input.claim_id);
      if (claim === undefined) {
        throw new Error(`Resource budget completion ${input.claim_id} exists without a claim`);
      }
      const existing = await readOptionalValidatedArtifact(
        this.runDir,
        completionPath(input.claim_id),
        resourceBudgetCompletionV1Schema,
      );
      const completion = resourceBudgetCompletionV1Schema.parse({
        schema_version: 1,
        ...input,
        completed_at: input.completed_at ?? existing?.completed_at ?? new Date().toISOString(),
      });
      if (existing !== null) {
        if (!sameJson(existing, completion)) {
          throw new Error(`Resource budget completion ${completion.claim_id} already exists with different bytes`);
        }
        return existing;
      }
      reduceResourceBudgetArtifacts(
        policy,
        claims,
        [...completions, completion],
        reconciliations,
      );
      await writeImmutableValidatedJson(
        this.runDir,
        completionPath(completion.claim_id),
        resourceBudgetCompletionV1Schema,
        completion,
      );
      return completion;
    });
  }

  async runWorkflowAttempt<T>(key: string, action: () => Promise<T>): Promise<T> {
    await this.claim({ kind: "workflow_attempt", key, elapsed_reservation_ms: 0 });
    return action();
  }

  async remainingActiveElapsedMs(): Promise<number> {
    return withRunLedgerTransaction(this.runDir, async () => {
      const { policy, claims, completions, reconciliations } = await readBudgetArtifacts(this.runDir);
      const usage = reduceResourceBudgetArtifacts(policy, claims, completions, reconciliations);
      return Math.max(0, policy.max_active_elapsed_ms - usage.active_elapsed_ms);
    });
  }
}

export async function reconcileResourceBudgetModelInvocation(input: {
  runDir: string;
  claimId: string;
  actor: string;
  reason: string;
  evidenceRefs: string[];
  tokenUsage: ResourceBudgetReconciliationV1["token_usage"];
}): Promise<ResourceBudgetReconciliationV1> {
  return withRunLedgerTransaction(input.runDir, async () => {
    const { policy, claims, completions, reconciliations } = await readBudgetArtifacts(input.runDir);
    for (const evidenceRef of input.evidenceRefs) {
      await readOwnedRunFile(input.runDir, evidenceRef);
    }
    const reconciliation = resourceBudgetReconciliationV1Schema.parse({
      schema_version: 1,
      claim_id: input.claimId,
      reconciled_at: new Date().toISOString(),
      actor: input.actor,
      reason: input.reason,
      evidence_refs: input.evidenceRefs,
      token_usage: input.tokenUsage,
    });
    reduceResourceBudgetArtifacts(policy, claims, completions, [...reconciliations, reconciliation]);
    await writeImmutableValidatedJson(
      input.runDir,
      reconciliationPath(input.claimId),
      resourceBudgetReconciliationV1Schema,
      reconciliation,
    );
    return reconciliation;
  });
}

export async function reconcileInterruptedResourceBudgetModelInvocation(input: {
  runDir: string;
  claimId: string;
  actor: string;
  reason: string;
  evidenceRefs: string[];
  durationMs: number;
  tokenUsage: ResourceBudgetReconciliationV1["token_usage"];
}): Promise<{ completion: ResourceBudgetCompletionV1; reconciliation: ResourceBudgetReconciliationV1 }> {
  return withRunLedgerTransaction(input.runDir, async () => {
    const { policy, claims, completions, reconciliations } = await readBudgetArtifacts(input.runDir);
    for (const evidenceRef of input.evidenceRefs) await readOwnedRunFile(input.runDir, evidenceRef);
    const claim = claims.find((candidate) => candidate.claim_id === input.claimId);
    if (claim?.kind !== "model_invocation") {
      throw new Error(`Interrupted model reconciliation requires a model-invocation claim: ${input.claimId}`);
    }
    const existingCompletion = completions.find((candidate) => candidate.claim_id === input.claimId);
    const existingReconciliation = reconciliations.find((candidate) => candidate.claim_id === input.claimId);
    if (existingCompletion && (
      !existingCompletion.process_started
      || !existingCompletion.turn_started
      || !existingCompletion.structured_terminal_error
      || existingCompletion.token_usage !== null
    )) throw new Error(`Interrupted model reconciliation requires an uncertain started completion: ${input.claimId}`);
    if (existingCompletion && existingCompletion.duration_ms !== input.durationMs) {
      throw new Error(`Interrupted model reconciliation duration must match the immutable completion: ${existingCompletion.duration_ms}`);
    }
    const completion = existingCompletion ?? resourceBudgetCompletionV1Schema.parse({
      schema_version: 1,
      claim_id: input.claimId,
      completed_at: new Date().toISOString(),
      outcome: "reconciled",
      duration_ms: input.durationMs,
      process_started: true,
      turn_started: true,
      structured_terminal_error: true,
      token_usage: null,
    });
    const reconciliation = resourceBudgetReconciliationV1Schema.parse({
      schema_version: 1,
      claim_id: input.claimId,
      reconciled_at: existingReconciliation?.reconciled_at ?? new Date().toISOString(),
      actor: input.actor,
      reason: input.reason,
      evidence_refs: input.evidenceRefs,
      token_usage: input.tokenUsage,
    });
    if (existingReconciliation && !sameJson(existingReconciliation, reconciliation)) {
      throw new Error(`Resource budget reconciliation ${input.claimId} already exists with different bytes`);
    }
    reduceResourceBudgetArtifacts(
      policy,
      claims,
      existingCompletion ? completions : [...completions, completion],
      existingReconciliation ? reconciliations : [...reconciliations, reconciliation],
    );
    if (!existingCompletion) {
      await writeImmutableValidatedJson(input.runDir, completionPath(input.claimId), resourceBudgetCompletionV1Schema, completion);
    }
    if (!existingReconciliation) {
      await writeImmutableValidatedJson(input.runDir, reconciliationPath(input.claimId), resourceBudgetReconciliationV1Schema, reconciliation);
    }
    return { completion, reconciliation };
  });
}

export async function claimExternalEffect(
  budget: ResourceBudgetPort | undefined,
  key: string,
): Promise<ResourceBudgetClaimV1 | null> {
  return budget
    ? budget.claim({ kind: "external_effect", key, elapsed_reservation_ms: 1 })
    : null;
}

export async function completeExternalEffect(
  budget: ResourceBudgetPort | undefined,
  claim: ResourceBudgetClaimV1 | null,
  outcome: "succeeded" | "failed" | "reconciled" = "succeeded",
): Promise<void> {
  if (budget === undefined || claim === null) return;
  await budget.complete({
    claim_id: claim.claim_id,
    outcome,
    duration_ms: 0,
    process_started: false,
    turn_started: false,
    structured_terminal_error: false,
    token_usage: null,
  });
}
