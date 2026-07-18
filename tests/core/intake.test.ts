import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig, loadConfig } from "../../src/core/config.js";
import { resolveRunIntake } from "../../src/core/intake.js";
import { configV2Schema } from "../../src/core/schema.js";
import type { ConfigV2, RunIntake } from "../../src/core/types.js";

const config = defaultConfig() as unknown as ConfigV2;
let repoRoot: string | null = null;

afterEach(async () => {
  if (repoRoot) {
    await rm(repoRoot, { recursive: true, force: true });
    repoRoot = null;
  }
});

describe("resolveRunIntake", () => {
  it("resolves complete intake with the three role defaults", () => {
    const intake: RunIntake = {
      task: "Build a CLI",
      repo_root: "/tmp/repo",
      mode: "local",
      research: true,
      reflection: false,
    };

    const resolved = resolveRunIntake(intake, config);

    expect(resolved.mode).toBe("local");
    expect(resolved.research).toBe(true);
    expect(resolved.reflection).toBe(false);
    expect(resolved.models).toEqual({
      brain: "gpt-5.6-sol",
      hands: "gpt-5.6-luna",
      verifier: "gpt-5.6-sol",
    });
  });

  it("rejects an intake missing mode, research, or reflection", () => {
    const base = {
      task: "Build a CLI",
      repo_root: "/tmp/repo",
      mode: "local" as const,
      research: true,
      reflection: false,
    };

    for (const field of ["mode", "research", "reflection"] as const) {
      const incomplete = { ...base };
      delete incomplete[field];

      expect(() => resolveRunIntake(incomplete, config)).toThrow(
        "mode, research, and reflection must be resolved before execution",
      );
    }
  });

  it("uses a supplied role model only for that role", () => {
    const resolved = resolveRunIntake(
      {
        task: "Build a CLI",
        repo_root: "/tmp/repo",
        mode: "github",
        research: false,
        reflection: true,
        hands_model: "custom-hands",
      },
      config,
    );

    expect(resolved.models).toEqual({
      brain: "gpt-5.6-sol",
      hands: "custom-hands",
      verifier: "gpt-5.6-sol",
    });
  });

  it("accepts a partial role model map and defaults only omitted roles", () => {
    const resolved = resolveRunIntake(
      {
        task: "Build a CLI",
        repo_root: "/tmp/repo",
        mode: "local",
        research: false,
        reflection: false,
        models: { hands: "custom-hands" },
      },
      config,
    );

    expect(resolved.models).toEqual({
      brain: "gpt-5.6-sol",
      hands: "custom-hands",
      verifier: "gpt-5.6-sol",
    });
  });

  it("rejects unknown roles in the partial model map", () => {
    expect(() =>
      resolveRunIntake(
        {
          task: "Build a CLI",
          repo_root: "/tmp/repo",
          mode: "local",
          research: false,
          reflection: false,
          models: { unknown: "not-a-role" } as never,
        },
        config,
      ),
    ).toThrow();
  });

  it("resolves repository and run review-policy overrides once", () => {
    const resolved = resolveRunIntake(
      {
        task: "Build a CLI",
        repo_root: "/tmp/repo",
        mode: "local",
        research: false,
        reflection: false,
        review_policy: { on_limit: "stop" },
      },
      {
        ...config,
        retry_policy: { ...config.retry_policy, max_hands_fix_attempts: 4 },
        review_policy: { max_fix_cycles: 5 },
      },
    );

    expect(resolved.review_policy).toMatchObject({
      policy_revision: 2,
      max_fix_cycles: 5,
      on_limit: "stop",
    });
  });

  it("merges nested severity defaults with run overrides taking precedence", () => {
    const resolved = resolveRunIntake(
      {
        task: "Build a CLI",
        repo_root: "/tmp/repo",
        mode: "local",
        research: false,
        reflection: false,
        review_policy: { severity_defaults: { medium: "advisory" } },
      },
      {
        ...config,
        review_policy: {
          severity_defaults: {
            critical: "requires_replan",
            medium: "follow_up",
          },
        },
      },
    );

    expect(resolved.review_policy?.severity_defaults).toEqual({
      critical: "requires_replan",
      high: "blocking",
      medium: "advisory",
      low: "advisory",
    });
  });

  it("maps the legacy Hands fix limit only while resolving a new run", () => {
    const resolved = resolveRunIntake(
      {
        task: "Build a CLI",
        repo_root: "/tmp/repo",
        mode: "local",
        research: false,
        reflection: false,
      },
      {
        ...config,
        review_policy: undefined,
        retry_policy: { ...config.retry_policy, max_hands_fix_attempts: 7 },
      },
    );

    expect(resolved.review_policy?.max_fix_cycles).toBe(7);
  });

  it("records warning authority only for an explicit run override", () => {
    const repositoryDefault = resolveRunIntake(
      {
        task: "Build a CLI",
        repo_root: "/tmp/repo",
        mode: "local",
        research: false,
        reflection: false,
      },
      { ...config, review_policy: { on_limit: "continue_with_warning" } },
    );
    const runOverride = resolveRunIntake(
      {
        task: "Build a CLI",
        repo_root: "/tmp/repo",
        mode: "local",
        research: false,
        reflection: false,
        review_policy: { on_limit: "continue_with_warning" },
      },
      config,
    );

    expect(repositoryDefault.warning_continuation_authority).toBeUndefined();
    expect(runOverride.warning_continuation_authority).toEqual({
      actor: "run-intake",
      source: "run_override",
    });
  });
});

describe("v1 config migration", () => {
  it("backs up v1 config and persists version 2 role profiles", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-intake-"));
    const configDir = join(repoRoot, ".brain-hands");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(configDir, { recursive: true }));
    const legacy = {
      version: 1,
      github: { enabled: true, default_remote: "origin" },
      codex: {
        command: "codex",
        args_template: ["exec", "--ephemeral"],
        prompt_transport: "stdin",
        prompt_file_flag: "--prompt-file",
        timeout_seconds: 60,
      },
      retry_policy: { max_hands_fix_attempts: 1, max_replan_attempts: 0 },
      profiles: {
        brain_planner: {
          model: "legacy-brain",
          reasoning_effort: "high",
          temperature: "low",
          responsibilities: ["plan"],
        },
        brain_reviewer: {
          model: "legacy-reviewer",
          reasoning_effort: "high",
          temperature: "low",
          responsibilities: ["review"],
        },
        hands_fixer: {
          model: "legacy-fixer",
          reasoning_effort: "low",
          temperature: "low",
          responsibilities: ["fix"],
        },
      },
    };
    await writeFile(join(configDir, "config.yaml"), (await import("yaml")).default.stringify(legacy));

    const migrated = await loadConfig(repoRoot);
    const backup = await readFile(join(configDir, "config.yaml.v1.bak"), "utf8");
    const persisted = await readFile(join(configDir, "config.yaml"), "utf8");

    expect(backup).toContain("brain_planner");
    expect(migrated.version).toBe(2);
    const migratedV2 = migrated as unknown as ConfigV2;
    expect(migratedV2.profiles.brain.model).toBe("legacy-brain");
    expect(migratedV2.profiles.hands.model).toBe("legacy-fixer");
    expect(migratedV2.profiles.verifier.model).toBe("legacy-reviewer");
    expect(migratedV2.retry_policy.quality_gate).toBeUndefined();
    expect(persisted).toContain("version: 2");
    expect(persisted).toContain("brain:");
    expect(persisted).not.toContain("quality_gate:");
  });

  it("rejects invalid reasoning effort, sandbox, and unknown role", () => {
    const invalid = {
      ...config,
      profiles: {
        ...config.profiles,
        brain: { ...config.profiles.brain, reasoning_effort: "invalid" },
        hands: { ...config.profiles.hands, sandbox: "invalid" },
        unknown: config.profiles.brain,
      },
    };

    expect(configV2Schema.safeParse(invalid).success).toBe(false);
  });
});
