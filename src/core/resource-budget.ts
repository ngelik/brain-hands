import { z } from "zod";

const safeNonnegativeIntegerSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const safePositiveIntegerSchema = safeNonnegativeIntegerSchema.min(1);
const safeResultRefSchema = z.object({
  path: z.string().trim().min(1).superRefine((value, context) => {
    const normalized = value.replaceAll("\\", "/");
    if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) {
      context.addIssue({ code: "custom", message: "Result reference must be relative" });
    }
    if (normalized.split("/").some((segment) => segment === "..")) {
      context.addIssue({ code: "custom", message: "Result reference must stay inside the run directory" });
    }
  }),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export const resourceBudgetPolicyV1Schema = z.object({
  schema_version: z.literal(1),
  max_model_invocations: safePositiveIntegerSchema,
  max_workflow_attempts: safePositiveIntegerSchema,
  max_total_tokens: safePositiveIntegerSchema,
  max_active_elapsed_ms: safePositiveIntegerSchema,
  max_external_effects: safeNonnegativeIntegerSchema,
}).strict();

export const DEFAULT_RESOURCE_BUDGET_V1 = Object.freeze({
  schema_version: 1,
  max_model_invocations: 64,
  max_workflow_attempts: 32,
  max_total_tokens: 4_000_000,
  max_active_elapsed_ms: 14_400_000,
  max_external_effects: 128,
} satisfies z.infer<typeof resourceBudgetPolicyV1Schema>);

export const resourceBudgetClaimKindSchema = z.enum([
  "model_invocation",
  "workflow_attempt",
  "verification_command",
  "external_effect",
]);

export const resourceBudgetClaimV1Schema = z.object({
  schema_version: z.literal(1),
  claim_id: z.string().regex(/^budget-claim:[a-f0-9]{64}$/),
  run_id: z.string().trim().min(1),
  kind: resourceBudgetClaimKindSchema,
  key: z.string().trim().min(1).max(512),
  reserved_at: z.string().datetime({ offset: true }),
  elapsed_reservation_ms: safeNonnegativeIntegerSchema,
}).strict().superRefine((claim, context) => {
  if (claim.kind === "workflow_attempt" && claim.elapsed_reservation_ms !== 0) {
    context.addIssue({
      code: "custom",
      path: ["elapsed_reservation_ms"],
      message: "Workflow-attempt claims require zero elapsed reservation",
    });
  }
  if (claim.kind !== "workflow_attempt" && claim.elapsed_reservation_ms === 0) {
    context.addIssue({
      code: "custom",
      path: ["elapsed_reservation_ms"],
      message: "Chargeable claims require a positive elapsed reservation",
    });
  }
});

export const tokenUsageSchema = z.object({
  input_tokens: safeNonnegativeIntegerSchema,
  cached_input_tokens: safeNonnegativeIntegerSchema,
  output_tokens: safeNonnegativeIntegerSchema,
  reasoning_output_tokens: safeNonnegativeIntegerSchema,
}).strict();

export const resourceBudgetCompletionV1Schema = z.object({
  schema_version: z.literal(1),
  claim_id: z.string().regex(/^budget-claim:[a-f0-9]{64}$/),
  completed_at: z.string().datetime({ offset: true }),
  outcome: z.enum(["succeeded", "failed", "reconciled"]),
  duration_ms: safeNonnegativeIntegerSchema,
  process_started: z.boolean(),
  turn_started: z.boolean(),
  structured_terminal_error: z.boolean(),
  token_usage: tokenUsageSchema.nullable(),
  result_ref: safeResultRefSchema.optional(),
}).strict().superRefine((completion, context) => {
  if (completion.turn_started && !completion.process_started) {
    context.addIssue({
      code: "custom",
      path: ["turn_started"],
      message: "A turn cannot start before its process",
    });
  }
  if (completion.structured_terminal_error && !completion.process_started) {
    context.addIssue({
      code: "custom",
      path: ["structured_terminal_error"],
      message: "A structured terminal error requires a started process",
    });
  }
});

export type ResourceBudgetPolicyV1 = z.infer<typeof resourceBudgetPolicyV1Schema>;
export type ResourceBudgetClaimKind = z.infer<typeof resourceBudgetClaimKindSchema>;
export type ResourceBudgetClaimV1 = z.infer<typeof resourceBudgetClaimV1Schema>;
export type TokenUsage = z.infer<typeof tokenUsageSchema>;
export type ResourceBudgetCompletionV1 = z.infer<typeof resourceBudgetCompletionV1Schema>;

export interface ResourceBudgetUsage {
  model_invocations: number;
  workflow_attempts: number;
  total_tokens: number;
  cached_input_tokens: number;
  reasoning_output_tokens: number;
  active_elapsed_ms: number;
  external_effects: number;
  token_accounting: "known" | "uncertain";
  uncertain_model_claim_ids: string[];
  token_overshoot: number;
}

export type ResourceBudgetDimension =
  | "model_invocations"
  | "workflow_attempts"
  | "total_tokens"
  | "active_elapsed_ms"
  | "external_effects";

export class ResourceBudgetExceededError extends Error {
  readonly dimension: ResourceBudgetDimension;
  readonly used: number;
  readonly limit: number;
  readonly requested: number;

  constructor(dimension: ResourceBudgetDimension, used: number, limit: number, requested: number) {
    super(`Resource budget exceeded for ${dimension}: used ${used}, limit ${limit}, requested ${requested}`);
    this.name = "ResourceBudgetExceededError";
    this.dimension = dimension;
    this.used = used;
    this.limit = limit;
    this.requested = requested;
  }
}

export interface ResourceBudgetClaimInput {
  kind: ResourceBudgetClaimKind;
  key: string;
  elapsed_reservation_ms: number;
}

export type ResourceBudgetCompletionInput = Omit<
  ResourceBudgetCompletionV1,
  "schema_version" | "completed_at"
> & { completed_at?: string };

export interface ResourceBudgetPort {
  usage(): Promise<ResourceBudgetUsage>;
  claim(input: ResourceBudgetClaimInput): Promise<ResourceBudgetClaimV1>;
  complete(input: ResourceBudgetCompletionInput): Promise<ResourceBudgetCompletionV1>;
  runWorkflowAttempt<T>(key: string, action: () => Promise<T>): Promise<T>;
  remainingActiveElapsedMs(): Promise<number>;
}

function artifactBytes(value: unknown): string {
  return JSON.stringify(value);
}

function safeAdd(total: number, value: number, label: string): number {
  const sum = total + value;
  if (!Number.isSafeInteger(sum)) {
    throw new Error(`Resource budget ${label} exceeds the safe integer range`);
  }
  return sum;
}

function claimIdentity(claim: ResourceBudgetClaimV1): string {
  return `${claim.run_id}\0${claim.kind}\0${claim.key}`;
}

export function reduceResourceBudgetArtifacts(
  rawPolicy: ResourceBudgetPolicyV1,
  rawClaims: readonly ResourceBudgetClaimV1[],
  rawCompletions: readonly ResourceBudgetCompletionV1[],
): ResourceBudgetUsage {
  const policy = resourceBudgetPolicyV1Schema.parse(rawPolicy);
  const claimsByIdentity = new Map<string, ResourceBudgetClaimV1>();
  const claimsById = new Map<string, ResourceBudgetClaimV1>();
  let runId: string | null = null;

  for (const rawClaim of rawClaims) {
    const claim = resourceBudgetClaimV1Schema.parse(rawClaim);
    if (runId !== null && claim.run_id !== runId) {
      throw new Error("Resource budget claims belong to different runs");
    }
    runId = claim.run_id;
    const identity = claimIdentity(claim);
    const existingIdentity = claimsByIdentity.get(identity);
    if (existingIdentity !== undefined) {
      if (artifactBytes(existingIdentity) !== artifactBytes(claim)) {
        throw new Error(`Conflicting resource budget claim for key ${claim.key}`);
      }
      continue;
    }
    const existingId = claimsById.get(claim.claim_id);
    if (existingId !== undefined) {
      throw new Error(`Resource budget claim_id ${claim.claim_id} identifies multiple claims`);
    }
    claimsByIdentity.set(identity, claim);
    claimsById.set(claim.claim_id, claim);
  }

  const completionsByClaimId = new Map<string, ResourceBudgetCompletionV1>();
  for (const rawCompletion of rawCompletions) {
    const completion = resourceBudgetCompletionV1Schema.parse(rawCompletion);
    const claim = claimsById.get(completion.claim_id);
    if (claim === undefined) {
      throw new Error(`Resource budget completion ${completion.claim_id} exists without a claim`);
    }
    const existing = completionsByClaimId.get(completion.claim_id);
    if (existing !== undefined) {
      if (artifactBytes(existing) !== artifactBytes(completion)) {
        throw new Error(`Conflicting resource budget completion for ${completion.claim_id}`);
      }
      continue;
    }
    if (claim.kind !== "workflow_attempt" && completion.duration_ms > claim.elapsed_reservation_ms) {
      throw new Error(`Resource budget completion ${completion.claim_id} exceeds its elapsed reservation`);
    }
    if (claim.kind !== "model_invocation" && completion.token_usage !== null) {
      throw new Error(`Only model-invocation completions may contain token usage`);
    }
    completionsByClaimId.set(completion.claim_id, completion);
  }

  let modelInvocations = 0;
  let workflowAttempts = 0;
  let totalTokens = 0;
  let cachedInputTokens = 0;
  let reasoningOutputTokens = 0;
  let activeElapsedMs = 0;
  let externalEffects = 0;
  const uncertainModelClaimIds: string[] = [];

  for (const claim of claimsByIdentity.values()) {
    if (claim.kind === "model_invocation") modelInvocations = safeAdd(modelInvocations, 1, "model invocation count");
    if (claim.kind === "workflow_attempt") workflowAttempts = safeAdd(workflowAttempts, 1, "workflow attempt count");
    if (claim.kind === "external_effect") externalEffects = safeAdd(externalEffects, 1, "external effect count");

    const completion = completionsByClaimId.get(claim.claim_id);
    if (claim.kind !== "workflow_attempt") {
      activeElapsedMs = safeAdd(
        activeElapsedMs,
        completion?.duration_ms ?? claim.elapsed_reservation_ms,
        "active elapsed time",
      );
    }

    if (claim.kind !== "model_invocation") continue;
    if (completion?.token_usage !== null && completion?.token_usage !== undefined) {
      totalTokens = safeAdd(totalTokens, completion.token_usage.input_tokens, "total tokens");
      totalTokens = safeAdd(totalTokens, completion.token_usage.output_tokens, "total tokens");
      cachedInputTokens = safeAdd(cachedInputTokens, completion.token_usage.cached_input_tokens, "cached input tokens");
      reasoningOutputTokens = safeAdd(reasoningOutputTokens, completion.token_usage.reasoning_output_tokens, "reasoning output tokens");
      continue;
    }
    const provenZero = completion !== undefined
      && (!completion.process_started || (completion.structured_terminal_error && !completion.turn_started));
    if (!provenZero) uncertainModelClaimIds.push(claim.claim_id);
  }

  return {
    model_invocations: modelInvocations,
    workflow_attempts: workflowAttempts,
    total_tokens: totalTokens,
    cached_input_tokens: cachedInputTokens,
    reasoning_output_tokens: reasoningOutputTokens,
    active_elapsed_ms: activeElapsedMs,
    external_effects: externalEffects,
    token_accounting: uncertainModelClaimIds.length === 0 ? "known" : "uncertain",
    uncertain_model_claim_ids: uncertainModelClaimIds.sort(),
    token_overshoot: Math.max(0, totalTokens - policy.max_total_tokens),
  };
}
