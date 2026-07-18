import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import YAML from "yaml";
import type {
  BrainHandsConfig,
  ConfigV2,
  LegacyModelRole,
  ModelProfile,
  RoleName,
  RoleProfile,
  PhaseReasoning,
  ReleaseGuard,
  ReviewPolicy,
  ReviewPolicyOverride,
} from "./types.js";
import { DEFAULT_RESOURCE_BUDGET_V1 } from "./resource-budget.js";
import { configV2Schema, legacyConfigSchema } from "./schema.js";

const DEFAULT_ROLE_PROFILES: Record<RoleName, RoleProfile> = {
  brain: { model: "gpt-5.6-sol", reasoning_effort: "high", sandbox: "read-only" },
  hands: { model: "gpt-5.6-luna", reasoning_effort: "high", sandbox: "workspace-write" },
  verifier: { model: "gpt-5.6-sol", reasoning_effort: "high", sandbox: "read-only" },
};

export const DEFAULT_PHASE_REASONING: PhaseReasoning = {
  hands_self_review: "medium",
  reflection: "medium",
};

export const CANONICAL_REVIEW_POLICY: ReviewPolicy = {
  policy_revision: 2,
  max_fix_cycles: 2,
  on_limit: "auto_replan",
  auto_advance_on_approval: true,
  severity_defaults: {
    critical: "blocking",
    high: "blocking",
    medium: "fix_in_scope",
    low: "advisory",
  },
  pause_on: [
    "plan_approval",
    "irreversible_external_action",
    "unresolved_release_blocker",
  ],
};

const DEFAULT_REVIEW_POLICY: ReviewPolicyOverride = {
  max_fix_cycles: CANONICAL_REVIEW_POLICY.max_fix_cycles,
  on_limit: CANONICAL_REVIEW_POLICY.on_limit,
  auto_advance_on_approval: CANONICAL_REVIEW_POLICY.auto_advance_on_approval,
  severity_defaults: { ...CANONICAL_REVIEW_POLICY.severity_defaults },
  pause_on: [...CANONICAL_REVIEW_POLICY.pause_on],
};

export const DEFAULT_RELEASE_GUARDS: ReleaseGuard[] = [
  { id: "release:no-secrets", description: "No secrets are introduced by the change." },
  { id: "release:no-auto-merge", description: "Delivery never merges the pull request." },
  { id: "release:no-critical-regression", description: "No critical regression remains unresolved." },
  { id: "release:required-verification", description: "All required verification completes successfully." },
];

export function resolveReviewPolicy(
  maxHandsFixAttempts: number,
  repositoryPolicy?: ReviewPolicyOverride,
  runPolicy?: ReviewPolicyOverride,
): ReviewPolicy {
  const legacyMapped = repositoryPolicy?.max_fix_cycles === undefined
    ? { max_fix_cycles: maxHandsFixAttempts }
    : {};
  return {
    ...CANONICAL_REVIEW_POLICY,
    ...legacyMapped,
    ...repositoryPolicy,
    ...runPolicy,
    policy_revision: CANONICAL_REVIEW_POLICY.policy_revision,
    severity_defaults: {
      ...CANONICAL_REVIEW_POLICY.severity_defaults,
      ...repositoryPolicy?.severity_defaults,
      ...runPolicy?.severity_defaults,
    },
    pause_on: runPolicy?.pause_on ?? repositoryPolicy?.pause_on ?? CANONICAL_REVIEW_POLICY.pause_on,
  };
}

const CURRENT_ARGS_TEMPLATE = ["exec", "--ephemeral", "--model", "{{model}}"];

const LEGACY_RESPONSIBILITIES: Record<LegacyModelRole, string[]> = {
  brain_planner: ["research", "architecture", "decomposition", "risk analysis", "issue authoring"],
  brain_reviewer: ["diff review", "requirement audit", "verification review", "final approval"],
  hands_implementer: ["code changes", "focused tests", "implementation notes"],
  hands_fixer: ["apply review comments", "preserve scope", "rerun checks"],
};

function legacyProfile(
  role: LegacyModelRole,
  model: string,
  reasoning_effort: ModelProfile["reasoning_effort"],
): ModelProfile {
  return {
    model,
    reasoning_effort,
    temperature: role === "hands_implementer" || role === "hands_fixer" ? "low" : "low",
    responsibilities: LEGACY_RESPONSIBILITIES[role],
  };
}

function withLegacyAliases(config: ConfigV2): BrainHandsConfig & ConfigV2 {
  const brain = config.profiles.brain;
  const hands = config.profiles.hands;
  const verifier = config.profiles.verifier;
  const legacyProfiles = {
    brain_planner: legacyProfile("brain_planner", brain.model, brain.reasoning_effort),
    brain_reviewer: legacyProfile("brain_reviewer", verifier.model, verifier.reasoning_effort),
    hands_implementer: legacyProfile("hands_implementer", hands.model, hands.reasoning_effort),
    hands_fixer: legacyProfile("hands_fixer", hands.model, hands.reasoning_effort),
  };

  const profiles = { ...config.profiles } as ConfigV2["profiles"] & Record<LegacyModelRole, ModelProfile>;
  Object.defineProperties(profiles, {
    brain_planner: { value: legacyProfiles.brain_planner, enumerable: false },
    brain_reviewer: { value: legacyProfiles.brain_reviewer, enumerable: false },
    hands_implementer: { value: legacyProfiles.hands_implementer, enumerable: false },
    hands_fixer: { value: legacyProfiles.hands_fixer, enumerable: false },
  });

  const github = { ...config.github };
  Object.defineProperty(github, "enabled", {
    value: config.github.enabled ?? true,
    enumerable: false,
  });

  const codex = { ...config.codex };
  Object.defineProperties(codex, {
    args_template: {
      value: CURRENT_ARGS_TEMPLATE,
      enumerable: false,
    },
    prompt_transport: { value: config.codex.prompt_transport ?? "stdin", enumerable: false },
    prompt_file_flag: { value: config.codex.prompt_file_flag ?? "--prompt-file", enumerable: false },
  });

  return {
    ...config,
    github,
    codex,
    profiles,
  } as BrainHandsConfig & ConfigV2;
}

function persistedConfig(config: ConfigV2): ConfigV2 {
  return configV2Schema.parse({
    version: 2,
    github: { default_remote: config.github.default_remote },
    codex: {
      command: config.codex.command,
      timeout_seconds: config.codex.timeout_seconds,
      isolate_user_config: config.codex.isolate_user_config,
    },
    retry_policy: config.retry_policy,
    profiles: {
      brain: config.profiles.brain,
      hands: config.profiles.hands,
      verifier: config.profiles.verifier,
    },
    phase_reasoning: config.phase_reasoning,
    review_policy: config.review_policy,
    resource_budget: config.resource_budget,
  });
}

export function defaultConfig(): BrainHandsConfig & ConfigV2 {
  const config: ConfigV2 = {
    version: 2,
    github: { default_remote: "origin", enabled: true },
    codex: {
      command: "codex",
      timeout_seconds: 3600,
      isolate_user_config: true,
      args_template: CURRENT_ARGS_TEMPLATE,
      prompt_transport: "stdin",
      prompt_file_flag: "--prompt-file",
    },
    retry_policy: {
      max_hands_fix_attempts: 3,
      max_replan_attempts: 2,
      quality_gate: {
        hands_self_review_passes: 1,
        max_attempts_per_reviewer_action: 2,
        require_focused_verifier_confirmation: true,
      },
    },
    profiles: DEFAULT_ROLE_PROFILES,
    phase_reasoning: { ...DEFAULT_PHASE_REASONING },
    review_policy: DEFAULT_REVIEW_POLICY,
    resource_budget: { ...DEFAULT_RESOURCE_BUDGET_V1 },
  };

  return withLegacyAliases(config);
}

export function configPath(repoRoot: string): string {
  return join(repoRoot, ".brain-hands", "config.yaml");
}

export async function initConfig(repoRoot: string, force = false): Promise<string> {
  const targetPath = configPath(repoRoot);
  await mkdir(join(repoRoot, ".brain-hands"), { recursive: true });

  if (!force) {
    try {
      await loadConfig(repoRoot, { migrate: false });
      return targetPath;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
        throw error;
      }
    }
  }

  await writeFile(targetPath, YAML.stringify(persistedConfig(defaultConfig())), "utf8");
  return targetPath;
}

function migrateV1(rawConfig: unknown): ConfigV2 {
  if (rawConfig === null || typeof rawConfig !== "object" || Array.isArray(rawConfig)) {
    throw new Error("Config must be a YAML object");
  }

  const legacy = rawConfig as Record<string, unknown>;
  const profiles =
    legacy.profiles !== null &&
    typeof legacy.profiles === "object" &&
    !Array.isArray(legacy.profiles)
      ? (legacy.profiles as Record<string, unknown>)
      : {};
  const fixer = profiles.hands_fixer;
  const completeProfiles = {
    ...profiles,
    ...(profiles.hands_implementer === undefined && fixer !== undefined
      ? { hands_implementer: fixer }
      : {}),
  };
  const parsed = legacyConfigSchema.parse({ ...legacy, profiles: completeProfiles });

  const migrated: ConfigV2 = {
    version: 2,
    github: { default_remote: parsed.github.default_remote, enabled: parsed.github.enabled },
    codex: {
      command: parsed.codex.command,
      timeout_seconds: parsed.codex.timeout_seconds,
      isolate_user_config: true,
    },
    retry_policy: parsed.retry_policy,
    profiles: {
      brain: {
        model: parsed.profiles.brain_planner.model,
        reasoning_effort: parsed.profiles.brain_planner.reasoning_effort,
        sandbox: "read-only",
      },
      hands: {
        model: parsed.profiles.hands_implementer.model,
        reasoning_effort: parsed.profiles.hands_implementer.reasoning_effort,
        sandbox: "workspace-write",
      },
      verifier: {
        model: parsed.profiles.brain_reviewer.model,
        reasoning_effort: parsed.profiles.brain_reviewer.reasoning_effort,
        sandbox: "read-only",
      },
    },
    phase_reasoning: { ...DEFAULT_PHASE_REASONING },
    resource_budget: { ...DEFAULT_RESOURCE_BUDGET_V1 },
  };

  return configV2Schema.parse(migrated);
}

export async function loadConfig(repoRoot: string, options: { migrate?: boolean } = {}): Promise<BrainHandsConfig> {
  const targetPath = configPath(repoRoot);
  const raw = await readFile(targetPath, "utf8");
  const parsed = YAML.parse(raw) as unknown;

  if (
    parsed !== null &&
    typeof parsed === "object" &&
    !Array.isArray(parsed) &&
    (parsed as Record<string, unknown>).version === 1
  ) {
    const migrated = migrateV1(parsed);
    if (options.migrate !== false) {
      const backupPath = `${targetPath}.v1.bak`;
      await writeFile(backupPath, raw, { encoding: "utf8", flag: "wx" });
      await writeFile(targetPath, YAML.stringify(persistedConfig(migrated)), "utf8");
    }
    return withLegacyAliases(migrated);
  }

  const validated = configV2Schema.parse(parsed);
  return withLegacyAliases(validated);
}
