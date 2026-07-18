import { createHash } from "node:crypto";
import { z } from "zod";
import {
  handsBackupPolicySchema,
  phaseReasoningSchema,
  qualityGatePolicySchema,
  reviewPolicySchema,
  roleProfileSchema,
} from "./schema.js";
import { resourceBudgetPolicyV1Schema } from "./resource-budget.js";
import { DEFAULT_PHASE_REASONING, resolveReviewPolicy } from "./config.js";
import type {
  ConfigV2,
  ControllerProvenance,
  PhaseReasoning,
  ReflectionProtocol,
  ResolvedRunIntake,
  RoleName,
  RunIntake,
  RunManifestV2,
  RunMode,
} from "./types.js";

export const RUN_CONFIGURATION_PATH = "run-configuration.json";

const modelSelectionSourceSchema = z.enum(["repository_config", "cli_override"]);
const visibleRoleProfileSchema = roleProfileSchema.extend({ source: modelSelectionSourceSchema }).strict();
const visibleControllerSchema = z.object({
  package_name: z.string().min(1),
  package_version: z.string().regex(/^\d+\.\d+\.\d+$/),
  mode: z.enum(["installed", "development_checkout"]),
}).strict();

const resolvedRunConfigurationFields = {
  repository: z.string().min(1),
  mode: z.enum(["local", "github"]),
  research: z.boolean(),
  reflection: z.boolean(),
  controller: visibleControllerSchema,
  roles: z.object({
    brain: visibleRoleProfileSchema,
    hands: visibleRoleProfileSchema,
    verifier: visibleRoleProfileSchema,
  }).strict(),
  hands_backup: handsBackupPolicySchema.nullable(),
  limits: z.object({
    max_hands_fix_attempts: z.number().int().positive(),
    max_replan_attempts: z.number().int().nonnegative(),
    review_policy: reviewPolicySchema,
    quality_gate: qualityGatePolicySchema.nullable(),
  }).strict(),
  github: z.object({
    effects: z.enum(["none", "issues_and_pull_request"]),
    default_remote: z.string().min(1),
  }).strict(),
} as const;

export const resolvedRunConfigurationV1Schema = z.object({
  version: z.literal(1),
  ...resolvedRunConfigurationFields,
}).strict();

export const resolvedRunConfigurationV2Schema = z.object({
  version: z.literal(2),
  ...resolvedRunConfigurationFields,
  workflow_protocol: z.literal("bounded-context-v1"),
  phase_reasoning: phaseReasoningSchema.optional(),
  reflection_protocol: z.enum(["single-pass-v1", "role-accounts-v1"]).optional(),
  resource_budget: resourceBudgetPolicyV1Schema,
}).strict();

export const resolvedRunConfigurationSchema = z.discriminatedUnion("version", [
  resolvedRunConfigurationV1Schema,
  resolvedRunConfigurationV2Schema,
]).superRefine((configuration, context) => {
  const expectedEffects = configuration.mode === "github"
    ? "issues_and_pull_request"
    : "none";
  if (configuration.github.effects !== expectedEffects) {
    context.addIssue({
      code: "custom",
      path: ["github", "effects"],
      message: "GitHub effects must match the execution mode",
    });
  }
});

export type ResolvedRunConfiguration = z.infer<typeof resolvedRunConfigurationSchema>;
export type ResolvedRunConfigurationV2 = z.infer<typeof resolvedRunConfigurationV2Schema>;

export const HISTORICAL_COMPATIBILITY_DEFAULTS = Object.freeze({
  max_hands_fix_attempts: 3,
  max_replan_attempts: 2,
  github_default_remote: "origin",
});

function sameSnapshot(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalRunConfigurationValue(left))
    === JSON.stringify(canonicalRunConfigurationValue(right));
}

/**
 * Reconstruct only authority that historical pre-feature ledgers durably
 * recorded. Fields absent from that format use fixed compatibility constants,
 * never the caller's current repository configuration.
 */
export function reconstructHistoricalRunConfiguration(
  manifest: RunManifestV2,
  intake: RunIntake | ResolvedRunIntake,
): ResolvedRunConfiguration {
  if (manifest.approval_protocol_version !== null || manifest.run_configuration_sha256 !== null) {
    throw new Error("Historical run configuration reconstruction requires an unpinned ledger");
  }
  if (manifest.workflow_protocol === "legacy-v2" && manifest.discovery !== null) {
    throw new Error("Historical run configuration reconstruction requires legacy manifests to omit discovery state");
  }
  if (manifest.workflow_protocol === "durable-discovery-v1" && manifest.discovery === null) {
    throw new Error("Historical run configuration reconstruction requires durable discovery state");
  }
  if (!manifest.controller_provenance) {
    throw new Error("Historical run configuration reconstruction requires durable controller provenance");
  }
  if (intake.repo_root !== manifest.repo_root
    || intake.mode !== manifest.mode
    || manifest.run_mode !== manifest.mode
    || typeof intake.research !== "boolean"
    || typeof intake.reflection !== "boolean") {
    throw new Error("Historical run configuration snapshots contradict repository, mode, or run choices");
  }
  const roles = manifest.role_profiles;
  if (!roles.brain || !roles.hands || !roles.verifier
    || !sameSnapshot(roles, manifest.selected_role_profiles)
    || ("roles" in intake && !sameSnapshot(roles, intake.roles))) {
    throw new Error("Historical run configuration role snapshots are missing or contradictory");
  }
  if (manifest.review_policy_snapshot === undefined) {
    throw new Error("Historical run configuration review policy snapshot is missing");
  }
  const expectedReviewPolicy = intake.review_policy === undefined
    ? manifest.review_policy_snapshot
    : resolveReviewPolicy(
        manifest.review_policy_snapshot.max_fix_cycles,
        undefined,
        intake.review_policy,
      );
  if (!sameSnapshot(expectedReviewPolicy, manifest.review_policy_snapshot)
    || !sameSnapshot(manifest.hands_backup_policy ?? null, intake.hands_backup ?? null)
    || !sameSnapshot(manifest.quality_gate_policy ?? null, intake.quality_gate ?? null)) {
    throw new Error("Historical run configuration policy snapshots are contradictory");
  }
  return resolvedRunConfigurationSchema.parse({
    version: 1,
    repository: manifest.repo_root,
    mode: manifest.mode,
    research: intake.research,
    reflection: intake.reflection,
    controller: {
      package_name: manifest.controller_provenance.package_name,
      package_version: manifest.controller_provenance.package_version,
      mode: manifest.controller_provenance.mode,
    },
    roles: {
      brain: { ...roles.brain, source: "repository_config" },
      hands: { ...roles.hands, source: "repository_config" },
      verifier: { ...roles.verifier, source: "repository_config" },
    },
    hands_backup: manifest.hands_backup_policy ?? null,
    limits: {
      max_hands_fix_attempts: HISTORICAL_COMPATIBILITY_DEFAULTS.max_hands_fix_attempts,
      max_replan_attempts: HISTORICAL_COMPATIBILITY_DEFAULTS.max_replan_attempts,
      review_policy: manifest.review_policy_snapshot,
      quality_gate: manifest.quality_gate_policy ?? null,
    },
    github: {
      effects: manifest.mode === "github" ? "issues_and_pull_request" : "none",
      default_remote: HISTORICAL_COMPATIBILITY_DEFAULTS.github_default_remote,
    },
  });
}

function canonicalRunConfigurationValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalRunConfigurationValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonicalRunConfigurationValue(nested)]));
  }
  return value;
}

export function serializeRunConfiguration(configuration: ResolvedRunConfiguration): string {
  const parsed = resolvedRunConfigurationSchema.parse(configuration);
  return `${JSON.stringify(canonicalRunConfigurationValue(parsed))}\n`;
}

export function runConfigurationSha256(configuration: ResolvedRunConfiguration): string {
  return createHash("sha256").update(serializeRunConfiguration(configuration), "utf8").digest("hex");
}

export const missingRunChoiceSchema = z.enum(["mode", "research", "reflection"]);
export type MissingRunChoice = z.infer<typeof missingRunChoiceSchema>;

export const runConfigurationPreviewSchema = z.object({
  version: z.literal(1),
  repository: z.string().min(1),
  configuration: z.object({
    path: z.literal(".brain-hands/config.yaml"),
    source: z.literal("repository_config"),
  }).strict(),
  mode: z.enum(["local", "github"]).nullable(),
  research: z.boolean().nullable(),
  reflection: z.boolean().nullable(),
  missing_choices: z.array(missingRunChoiceSchema).max(3),
  controller: visibleControllerSchema,
  roles: z.object({
    brain: visibleRoleProfileSchema,
    hands: visibleRoleProfileSchema,
    verifier: visibleRoleProfileSchema,
  }).strict(),
  hands_backup: handsBackupPolicySchema.nullable(),
  phase_reasoning: phaseReasoningSchema,
  reflection_protocol: z.literal("single-pass-v1"),
  limits: z.object({
    max_hands_fix_attempts: z.number().int().positive(),
    max_replan_attempts: z.number().int().nonnegative(),
    review_policy: reviewPolicySchema,
    quality_gate: qualityGatePolicySchema.nullable(),
  }).strict(),
  github: z.object({
    effects: z.enum(["depends_on_execution_mode", "none", "issues_and_pull_request"]),
    default_remote: z.string().min(1),
  }).strict(),
  resource_budget: resourceBudgetPolicyV1Schema,
}).strict().superRefine((preview, context) => {
  const expected: MissingRunChoice[] = [];
  if (preview.mode === null) expected.push("mode");
  if (preview.research === null) expected.push("research");
  if (preview.reflection === null) expected.push("reflection");
  if (JSON.stringify(preview.missing_choices) !== JSON.stringify(expected)) {
    context.addIssue({
      code: "custom",
      path: ["missing_choices"],
      message: "missing_choices must match unresolved choices in canonical order",
    });
  }
  const effects = preview.mode === null
    ? "depends_on_execution_mode"
    : preview.mode === "github"
      ? "issues_and_pull_request"
      : "none";
  if (preview.github.effects !== effects) {
    context.addIssue({
      code: "custom",
      path: ["github", "effects"],
      message: "GitHub effects must match the execution mode",
    });
  }
});

export type RunConfigurationPreview = z.infer<typeof runConfigurationPreviewSchema>;

export function resolveRunConfigurationPreview(input: {
  repository: string;
  config: ConfigV2;
  controller: ResolvedRunConfiguration["controller"];
  choices: { mode?: RunMode; research?: boolean; reflection?: boolean };
  overrides: Partial<Record<RoleName, string>>;
}): RunConfigurationPreview {
  const role = (name: RoleName): RunConfigurationPreview["roles"][RoleName] => ({
    ...input.config.profiles[name],
    model: input.overrides[name] ?? input.config.profiles[name].model,
    source: input.overrides[name] === undefined ? "repository_config" : "cli_override",
  });
  const mode = input.choices.mode ?? null;
  const research = input.choices.research ?? null;
  const reflection = input.choices.reflection ?? null;
  const missingChoices: MissingRunChoice[] = [];
  if (mode === null) missingChoices.push("mode");
  if (research === null) missingChoices.push("research");
  if (reflection === null) missingChoices.push("reflection");

  return runConfigurationPreviewSchema.parse({
    version: 1,
    repository: input.repository,
    configuration: { path: ".brain-hands/config.yaml", source: "repository_config" },
    mode,
    research,
    reflection,
    missing_choices: missingChoices,
    controller: input.controller,
    roles: { brain: role("brain"), hands: role("hands"), verifier: role("verifier") },
    hands_backup: input.config.retry_policy.backup ?? null,
    phase_reasoning: input.config.phase_reasoning,
    reflection_protocol: "single-pass-v1",
    limits: {
      max_hands_fix_attempts: input.config.retry_policy.max_hands_fix_attempts,
      max_replan_attempts: input.config.retry_policy.max_replan_attempts,
      review_policy: resolveReviewPolicy(
        input.config.retry_policy.max_hands_fix_attempts,
        input.config.review_policy,
      ),
      quality_gate: input.config.retry_policy.quality_gate ?? null,
    },
    github: {
      effects: mode === null
        ? "depends_on_execution_mode"
        : mode === "github"
          ? "issues_and_pull_request"
          : "none",
      default_remote: input.config.github.default_remote,
    },
    resource_budget: { ...input.config.resource_budget },
  });
}

export function resolveRunConfiguration(input: {
  intake: ResolvedRunIntake;
  config: ConfigV2;
  controller: ControllerProvenance;
  overrides: Partial<Record<RoleName, string>>;
}): ResolvedRunConfigurationV2 {
  const role = (name: RoleName): ResolvedRunConfigurationV2["roles"][RoleName] => ({
    ...input.intake.roles[name],
    source: input.overrides[name] === undefined ? "repository_config" : "cli_override",
  });
  return resolvedRunConfigurationV2Schema.parse({
    version: 2,
    repository: input.intake.repo_root,
    mode: input.intake.mode,
    research: input.intake.research,
    reflection: input.intake.reflection,
    controller: {
      package_name: input.controller.package_name,
      package_version: input.controller.package_version,
      mode: input.controller.mode,
    },
    roles: { brain: role("brain"), hands: role("hands"), verifier: role("verifier") },
    hands_backup: input.intake.hands_backup ?? null,
    phase_reasoning: input.intake.phase_reasoning ?? DEFAULT_PHASE_REASONING,
    limits: {
      max_hands_fix_attempts: input.config.retry_policy.max_hands_fix_attempts,
      max_replan_attempts: input.config.retry_policy.max_replan_attempts,
      review_policy: input.intake.review_policy,
      quality_gate: input.intake.quality_gate ?? null,
    },
    github: {
      effects: input.intake.mode === "github" ? "issues_and_pull_request" : "none",
      default_remote: input.config.github.default_remote,
    },
    workflow_protocol: "bounded-context-v1",
    reflection_protocol: "single-pass-v1",
    resource_budget: { ...input.config.resource_budget },
  });
}

type VisibleRole = ResolvedRunConfiguration["roles"][RoleName];
type VisibleLimits = ResolvedRunConfiguration["limits"];

function formatController(controller: ResolvedRunConfiguration["controller"]): string {
  return `${controller.package_name} ${controller.package_version} (${controller.mode.replaceAll("_", " ")})`;
}

function formatRole(label: string, profile: VisibleRole): string {
  const source = profile.source === "cli_override" ? "CLI override" : "repository config";
  return `${label}: ${profile.model} | ${profile.reasoning_effort} reasoning | ${profile.sandbox} | ${source}`;
}

function formatHandsBackup(handsBackup: ResolvedRunConfiguration["hands_backup"]): string {
  return `Hands backup: ${handsBackup === null
    ? "disabled"
    : `${handsBackup.profile.model} | ${handsBackup.profile.reasoning_effort} reasoning | usage-limit fallback ${handsBackup.fallback_on_primary_usage_limit ? "enabled" : "disabled"} | ${handsBackup.max_quality_recovery_attempts} quality-recovery attempt`}`;
}

function formatReviewPolicy(reviewPolicy: VisibleLimits["review_policy"]): string {
  return `Review limit: ${reviewPolicy.max_fix_cycles} fix cycles; ${reviewPolicy.on_limit.replaceAll("_", " ")}`;
}

function formatQualityGate(qualityGate: VisibleLimits["quality_gate"]): string {
  return `Quality gate: ${qualityGate === null
    ? "disabled"
    : `${qualityGate.hands_self_review_passes} Hands self-review passes; ${qualityGate.max_attempts_per_reviewer_action} reviewer-action attempts; focused Verifier confirmation required`}`;
}

const DEFAULT_RUNTIME_PHASE_REASONING: PhaseReasoning = {
  hands_self_review: "medium",
  reflection: "medium",
};

function formatReflectionProtocol(protocol: ReflectionProtocol): string {
  return `Reflection protocol: ${protocol === "single-pass-v1" ? "single pass" : "role accounts"}`;
}

function configurationPhaseReasoning(configuration: ResolvedRunConfiguration): PhaseReasoning {
  return "phase_reasoning" in configuration && configuration.phase_reasoning
    ? configuration.phase_reasoning
    : DEFAULT_RUNTIME_PHASE_REASONING;
}

function configurationReflectionProtocol(configuration: ResolvedRunConfiguration): ReflectionProtocol {
  return "reflection_protocol" in configuration && configuration.reflection_protocol
    ? configuration.reflection_protocol
    : "role-accounts-v1";
}

function formatResourceBudget(configuration: ResolvedRunConfiguration | RunConfigurationPreview): string[] {
  if (!("resource_budget" in configuration)) return [];
  const budget = configuration.resource_budget;
  return [
    "Resource budget:",
    `Model invocations: ${budget.max_model_invocations}`,
    `Workflow attempts: ${budget.max_workflow_attempts}`,
    `Total tokens: ${budget.max_total_tokens}`,
    `Active elapsed: ${budget.max_active_elapsed_ms} ms`,
    `External effects: ${budget.max_external_effects}`,
  ];
}

export function renderRunConfiguration(configuration: ResolvedRunConfiguration): string {
  const phaseReasoning = configurationPhaseReasoning(configuration);
  return [
    "Brain Hands run configuration (preflight pending)",
    `Repository: ${configuration.repository}`,
    `Mode: ${configuration.mode}`,
    `Research: ${configuration.research ? "enabled" : "disabled"}`,
    `Reflection: ${configuration.reflection ? "enabled" : "disabled"}`,
    `Controller: ${formatController(configuration.controller)}`,
    "Roles:",
    formatRole("Brain", configuration.roles.brain),
    formatRole("Hands", configuration.roles.hands),
    formatRole("Verifier", configuration.roles.verifier),
    formatHandsBackup(configuration.hands_backup),
    `Hands fix attempts: ${configuration.limits.max_hands_fix_attempts}`,
    `Replan attempts: ${configuration.limits.max_replan_attempts}`,
    formatReviewPolicy(configuration.limits.review_policy),
    formatQualityGate(configuration.limits.quality_gate),
    "Nested subagents: disabled (controller enforced)",
    `Hands self-review reasoning: ${phaseReasoning.hands_self_review}`,
    `Reflection reasoning: ${phaseReasoning.reflection}`,
    formatReflectionProtocol(configurationReflectionProtocol(configuration)),
    ...formatResourceBudget(configuration),
    `GitHub remote: ${configuration.github.default_remote}`,
    `GitHub effects: ${configuration.github.effects === "none" ? "none" : `issues and pull request via ${configuration.github.default_remote}`}`,
  ].join("\n");
}

export function renderRunConfigurationPreview(preview: RunConfigurationPreview): string {
  const count = preview.missing_choices.length;
  return [
    `Brain Hands configuration preview (${count} ${count === 1 ? "choice" : "choices"} pending)`,
    "",
    `Repository: ${preview.repository}`,
    `Initialized: ${preview.configuration.path}`,
    `Controller: ${formatController(preview.controller)}`,
    "",
    `Mode: ${preview.mode ?? "needs your choice"}`,
    `Research: ${preview.research === null ? "needs your choice" : preview.research ? "enabled" : "disabled"}`,
    `Reflection: ${preview.reflection === null ? "needs your choice" : preview.reflection ? "enabled" : "disabled"}`,
    "",
    "Roles:",
    formatRole("Brain", preview.roles.brain),
    formatRole("Hands", preview.roles.hands),
    formatRole("Verifier", preview.roles.verifier),
    "",
    formatHandsBackup(preview.hands_backup),
    `Hands fix attempts: ${preview.limits.max_hands_fix_attempts}`,
    `Replan attempts: ${preview.limits.max_replan_attempts}`,
    formatReviewPolicy(preview.limits.review_policy),
    formatQualityGate(preview.limits.quality_gate),
    "Nested subagents: disabled (controller enforced)",
    `Hands self-review reasoning: ${preview.phase_reasoning.hands_self_review}`,
    `Reflection reasoning: ${preview.phase_reasoning.reflection}`,
    formatReflectionProtocol(preview.reflection_protocol),
    ...formatResourceBudget(preview),
    `GitHub remote: ${preview.github.default_remote}`,
    `GitHub effects: ${preview.github.effects === "depends_on_execution_mode"
      ? "depends on execution-mode choice"
      : preview.github.effects === "none"
        ? "none"
        : "issues and one pull request"}`,
  ].join("\n");
}
