import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  configPath,
  defaultConfig,
  initConfig,
  loadConfig,
  resolveReviewPolicy,
} from "../../src/core/config.js";
import { DEFAULT_RESOURCE_BUDGET_V1 } from "../../src/core/resource-budget.js";
import { configV2Schema } from "../../src/core/schema.js";
import type { ConfigV2, QualityGatePolicy } from "../../src/core/types.js";

let repoRoot: string | null = null;

function configWithQualityGate(patch: Partial<QualityGatePolicy>) {
  const config = defaultConfig();
  return {
    ...config,
    retry_policy: {
      ...config.retry_policy,
      quality_gate: {
        hands_self_review_passes: 2,
        max_attempts_per_reviewer_action: 2,
        require_focused_verifier_confirmation: true as const,
        ...patch,
      },
    },
  };
}

afterEach(async () => {
  if (repoRoot) {
    await rm(repoRoot, { recursive: true, force: true });
    repoRoot = null;
  }
});

describe("config", () => {
  it("creates the default config file", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-config-"));

    const path = await initConfig(repoRoot);
    const raw = await readFile(path, "utf8");
    const config = (await loadConfig(repoRoot)) as unknown as ConfigV2;

    expect(path.endsWith(".brain-hands/config.yaml")).toBe(true);
    expect(raw).toContain("version: 2");
    expect(config.retry_policy.max_hands_fix_attempts).toBe(3);
    expect(config.codex.command).toBe("codex");
    expect(config.codex.args_template).toEqual([
      "exec",
      "--ephemeral",
      "--model",
      "{{model}}",
    ]);
    expect(config.codex.prompt_transport).toBe("stdin");
    expect(config.profiles.brain.model).toBe("gpt-5.6-sol");
    expect(config.profiles.hands.model).toBe("gpt-5.6-luna");
    expect(config.profiles.verifier.model).toBe("gpt-5.6-sol");
    expect(config.profiles.brain.reasoning_effort).toBe("high");
    expect(config.profiles.hands.reasoning_effort).toBe("high");
    expect(config.profiles.verifier.reasoning_effort).toBe("high");
    expect(config.phase_reasoning).toEqual({
      hands_self_review: "medium",
      reflection: "medium",
    });
    expect(config.resource_budget).toEqual({
      schema_version: 1,
      max_model_invocations: 64,
      max_workflow_attempts: 32,
      max_total_tokens: 4_000_000,
      max_active_elapsed_ms: 14_400_000,
      max_external_effects: 128,
    });
    expect(raw).toContain("resource_budget:");
  });

  it("accepts strict repository budget overrides and rejects unsafe or unknown values", () => {
    const config = defaultConfig();
    expect(configV2Schema.parse({
      ...config,
      resource_budget: { ...config.resource_budget, max_external_effects: 0 },
    }).resource_budget.max_external_effects).toBe(0);
    expect(configV2Schema.safeParse({
      ...config,
      resource_budget: { ...config.resource_budget, max_total_tokens: -1 },
    }).success).toBe(false);
    expect(configV2Schema.safeParse({
      ...config,
      resource_budget: { ...config.resource_budget, unknown_limit: 1 },
    }).success).toBe(false);
  });

  it("defaults an existing version-2 repository config that predates resource budgets", () => {
    const { resource_budget: _resourceBudget, ...existing } = defaultConfig();

    expect(DEFAULT_RESOURCE_BUDGET_V1).toEqual({
      schema_version: 1,
      max_model_invocations: 64,
      max_workflow_attempts: 32,
      max_total_tokens: 4_000_000,
      max_active_elapsed_ms: 14_400_000,
      max_external_effects: 128,
    });
    const first = configV2Schema.parse(existing);
    const second = configV2Schema.parse(existing);
    const explicitDefault = defaultConfig();
    first.resource_budget.max_model_invocations = 1;
    explicitDefault.resource_budget.max_workflow_attempts = 1;

    expect(second.resource_budget).toEqual(DEFAULT_RESOURCE_BUDGET_V1);
    expect(defaultConfig().resource_budget).toEqual(DEFAULT_RESOURCE_BUDGET_V1);
    expect(DEFAULT_RESOURCE_BUDGET_V1).toMatchObject({
      max_model_invocations: 64,
      max_workflow_attempts: 32,
    });
    expect(Object.isFrozen(DEFAULT_RESOURCE_BUDGET_V1)).toBe(true);
  });

  it("accepts an existing valid config and overwrites only when force is enabled", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-config-"));

    await initConfig(repoRoot);

    await expect(initConfig(repoRoot)).resolves.toContain("config.yaml");
    await expect(initConfig(repoRoot, true)).resolves.toContain("config.yaml");
  });

  it("parses one opt-in Hands backup profile", () => {
    const config = configV2Schema.parse({
      ...defaultConfig(),
      retry_policy: {
        max_hands_fix_attempts: 3,
        max_replan_attempts: 2,
        backup: {
          fallback_on_primary_usage_limit: true,
          max_quality_recovery_attempts: 1,
          profile: { model: "backup-model", reasoning_effort: "medium" },
        },
      },
    });

    expect(config.retry_policy.backup?.profile.model).toBe("backup-model");
  });

  it.each([0, 2])("rejects %i quality recovery attempts", (maxAttempts) => {
    expect(() => configV2Schema.parse({
      ...defaultConfig(),
      retry_policy: {
        max_hands_fix_attempts: 3,
        max_replan_attempts: 2,
        backup: {
          fallback_on_primary_usage_limit: true,
          max_quality_recovery_attempts: maxAttempts,
          profile: { model: "backup-model", reasoning_effort: "medium" },
        },
      },
    })).toThrow();
  });

  it("keeps backup absent in the package default", () => {
    expect(defaultConfig().retry_policy.backup).toBeUndefined();
  });

  it("generates one self-review pass for new configuration", () => {
    expect(defaultConfig().retry_policy.quality_gate).toEqual({
      hands_self_review_passes: 1,
      max_attempts_per_reviewer_action: 2,
      require_focused_verifier_confirmation: true,
    });
  });

  it("provides the canonical review policy for new configuration", () => {
    expect(defaultConfig().review_policy).toEqual({
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
    });
  });

  it("accepts a partial repository review-policy override", () => {
    const parsed = configV2Schema.parse({
      ...defaultConfig(),
      review_policy: { max_fix_cycles: 5, on_limit: "stop" },
    });

    expect(parsed.review_policy).toEqual({ max_fix_cycles: 5, on_limit: "stop" });
  });

  it("accepts deep partial severity overrides and rejects engine-owned or unknown keys", () => {
    expect(configV2Schema.safeParse({
      ...defaultConfig(),
      review_policy: { severity_defaults: { medium: "requires_replan" } },
    }).success).toBe(true);
    expect(configV2Schema.safeParse({
      ...defaultConfig(),
      review_policy: { policy_revision: 9 },
    }).success).toBe(false);
    expect(configV2Schema.safeParse({
      ...defaultConfig(),
      review_policy: { severity_defaults: { medium: "advisory", unknown: "blocking" } },
    }).success).toBe(false);
  });

  it("keeps policy revision engine-owned when an unsafe caller bypasses schemas", () => {
    const resolved = resolveReviewPolicy(3, { policy_revision: 9 } as never);

    expect(resolved.policy_revision).toBe(2);
  });

  it.each([-1, 4, 1.5])("rejects self-review pass count %s", (passes) => {
    expect(() => configV2Schema.parse(configWithQualityGate({
      hands_self_review_passes: passes,
    }))).toThrow();
  });

  it.each([0, 4, 1.5])("rejects action attempt limit %s", (attempts) => {
    expect(() => configV2Schema.parse(configWithQualityGate({
      max_attempts_per_reviewer_action: attempts,
    }))).toThrow();
  });

  it("preserves legacy behavior when an existing v2 config omits the quality gate", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-config-"));
    await mkdir(join(repoRoot, ".brain-hands"), { recursive: true });
    const config = defaultConfig();
    const { quality_gate: _qualityGate, ...retryPolicy } = config.retry_policy;
    await writeFile(
      configPath(repoRoot),
      JSON.stringify({ ...config, retry_policy: retryPolicy }),
      "utf8",
    );

    const loaded = (await loadConfig(repoRoot)) as unknown as ConfigV2;

    expect(loaded.retry_policy.quality_gate).toBeUndefined();
  });

  it("loads an existing v2 config without synthesizing review policy", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-config-"));
    await mkdir(join(repoRoot, ".brain-hands"), { recursive: true });
    const config = defaultConfig();
    const { review_policy: _reviewPolicy, ...legacyV2 } = config;
    await writeFile(configPath(repoRoot), JSON.stringify(legacyV2), "utf8");

    const loaded = (await loadConfig(repoRoot)) as unknown as ConfigV2;

    expect(loaded.review_policy).toBeUndefined();
    expect(loaded.retry_policy.max_hands_fix_attempts).toBe(3);
    expect(JSON.parse(await readFile(configPath(repoRoot), "utf8"))).not.toHaveProperty("review_policy");
  });

  it("rejects a V2 config that still carries the obsolete reasoning flag", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-config-"));
    await mkdir(join(repoRoot, ".brain-hands"), { recursive: true });
    const config = defaultConfig();
    await writeFile(
      configPath(repoRoot),
      JSON.stringify({
        ...config,
        codex: { ...config.codex, args_template: ["exec", "--reasoning-effort", "high"] },
      }),
      "utf8",
    );

    await expect(loadConfig(repoRoot)).rejects.toThrow("obsolete --reasoning-effort");
  });

  it("rethrows non-ENOENT filesystem errors during initialization", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-config-"));
    const blockedPath = join(repoRoot, ".brain-hands", "config.yaml");

    await mkdir(blockedPath, { recursive: true });

    await expect(initConfig(repoRoot)).rejects.toMatchObject({
      code: "EISDIR",
    });
  });
});
