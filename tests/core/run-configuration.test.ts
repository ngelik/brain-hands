import { describe, expect, it } from "vitest";
import { defaultConfig } from "../../src/core/config.js";
import { resolveRunIntake } from "../../src/core/intake.js";
import {
  renderRunConfiguration,
  renderRunConfigurationPreview,
  reconstructHistoricalRunConfiguration,
  resolveRunConfiguration,
  resolveRunConfigurationPreview,
  resolvedRunConfigurationSchema,
  resolvedRunConfigurationV1Schema,
  runConfigurationSha256,
  runConfigurationPreviewSchema,
  serializeRunConfiguration,
} from "../../src/core/run-configuration.js";
import { runManifestV2Schema } from "../../src/core/schema.js";

const controller = {
  package_name: "@ngelik/brain-hands",
  package_version: "0.3.5",
  mode: "installed" as const,
};

describe("run configuration preview", () => {
  it("renders every known setting while all intake choices are pending", () => {
    const preview = resolveRunConfigurationPreview({
      repository: "/tmp/example",
      config: defaultConfig(),
      controller,
      choices: {},
      overrides: {},
    });

    expect(preview).toMatchObject({
      version: 1,
      repository: "/tmp/example",
      configuration: {
        path: ".brain-hands/config.yaml",
        source: "repository_config",
      },
      mode: null,
      research: null,
      reflection: null,
      missing_choices: ["mode", "research", "reflection"],
      controller,
      roles: {
        brain: { model: "gpt-5.6-sol", reasoning_effort: "high", sandbox: "read-only", source: "repository_config" },
        hands: { model: "gpt-5.6-luna", reasoning_effort: "high", sandbox: "workspace-write", source: "repository_config" },
        verifier: { model: "gpt-5.6-sol", reasoning_effort: "high", sandbox: "read-only", source: "repository_config" },
      },
      hands_backup: null,
      phase_reasoning: {
        hands_self_review: "medium",
        reflection: "medium",
      },
      reflection_protocol: "single-pass-v1",
      limits: {
        max_hands_fix_attempts: 3,
        max_replan_attempts: 2,
        review_policy: { max_fix_cycles: 2, on_limit: "auto_replan" },
        quality_gate: {
          hands_self_review_passes: 1,
          max_attempts_per_reviewer_action: 2,
          require_focused_verifier_confirmation: true,
        },
      },
      github: { effects: "depends_on_execution_mode", default_remote: "origin" },
    });

    expect(renderRunConfigurationPreview(preview)).toBe([
      "Brain Hands configuration preview (3 choices pending)",
      "",
      "Repository: /tmp/example",
      "Initialized: .brain-hands/config.yaml",
      "Controller: @ngelik/brain-hands 0.3.5 (installed)",
      "",
      "Mode: needs your choice",
      "Research: needs your choice",
      "Reflection: needs your choice",
      "",
      "Roles:",
      "Brain: gpt-5.6-sol | high reasoning | read-only | repository config",
      "Hands: gpt-5.6-luna | high reasoning | workspace-write | repository config",
      "Verifier: gpt-5.6-sol | high reasoning | read-only | repository config",
      "",
      "Hands backup: disabled",
      "Hands fix attempts: 3",
      "Replan attempts: 2",
      "Review limit: 2 fix cycles; auto replan",
      "Quality gate: 1 Hands self-review passes; 2 reviewer-action attempts; focused Verifier confirmation required",
      "Nested subagents: disabled (controller enforced)",
      "Hands self-review reasoning: medium",
      "Reflection reasoning: medium",
      "Reflection protocol: single pass",
      "Resource budget:",
      "Model invocations: 64",
      "Workflow attempts: 32",
      "Total tokens: 4000000",
      "Active elapsed: 14400000 ms",
      "External effects: 128",
      "GitHub remote: origin",
      "GitHub effects: depends on execution-mode choice",
    ].join("\n"));
  });

  it("derives missing choices, GitHub effects, overrides, and legacy review defaults", () => {
    const config = defaultConfig();
    const withoutReviewPolicy = { ...config, review_policy: undefined };
    const preview = resolveRunConfigurationPreview({
      repository: "/tmp/example",
      config: withoutReviewPolicy,
      controller,
      choices: { mode: "github", research: false },
      overrides: { hands: "hands-override" },
    });

    expect(preview.missing_choices).toEqual(["reflection"]);
    expect(preview.github.effects).toBe("issues_and_pull_request");
    expect(preview.roles.hands).toEqual({
      model: "hands-override",
      reasoning_effort: "high",
      sandbox: "workspace-write",
      source: "cli_override",
    });
    expect(preview.limits.review_policy.max_fix_cycles).toBe(3);
    expect(renderRunConfigurationPreview(preview)).toContain("Brain Hands configuration preview (1 choice pending)");
  });

  it("matches the durable projection when every choice is resolved", () => {
    const config = defaultConfig();
    const overrides = { hands: "hands-override" };
    const choices = { mode: "github" as const, research: false, reflection: true };
    const preview = resolveRunConfigurationPreview({
      repository: "/tmp/example",
      config,
      controller,
      choices,
      overrides,
    });
    const intake = resolveRunIntake({
      task: "Verify preview parity",
      repo_root: "/tmp/example",
      ...choices,
      hands_model: overrides.hands,
      hands_backup: config.retry_policy.backup,
      quality_gate: config.retry_policy.quality_gate,
      review_policy: config.review_policy,
    }, config);
    const resolved = resolveRunConfiguration({
      intake,
      config,
      controller: {
        self_hosting: false,
        ...controller,
        executable_path: "/tmp/controller",
        package_root: "/tmp/package",
        package_hash_algorithm: "sha256",
        package_hash: "a".repeat(64),
        candidate_commit: "b".repeat(40),
      },
      overrides,
    });
    const { configuration: _configuration, missing_choices: missingChoices, ...sharedPreview } = preview;

    expect(missingChoices).toEqual([]);
    expect(resolved).toMatchObject({
      ...sharedPreview,
      version: 2,
      workflow_protocol: "bounded-context-v1",
      resource_budget: config.resource_budget,
    });
  });

  it("rejects preview metadata that disagrees with the selected choices", () => {
    const preview = resolveRunConfigurationPreview({
      repository: "/tmp/example",
      config: defaultConfig(),
      controller,
      choices: { mode: "local", research: true, reflection: false },
      overrides: {},
    });

    expect(() => runConfigurationPreviewSchema.parse({
      ...preview,
      missing_choices: ["mode"],
    })).toThrow(/missing_choices/);
    expect(() => runConfigurationPreviewSchema.parse({
      ...preview,
      github: { ...preview.github, effects: "issues_and_pull_request" },
    })).toThrow(/GitHub effects/);
  });

  it("does not project controller internals or configuration secrets", () => {
    const preview = resolveRunConfigurationPreview({
      repository: "/tmp/example",
      config: { ...defaultConfig(), codex: { ...defaultConfig().codex, command: "/secret/codex" } },
      controller,
      choices: {},
      overrides: {},
    });
    const serialized = JSON.stringify(preview);

    expect(serialized).not.toMatch(/executable_path|package_root|package_hash|candidate_commit|secret\/codex|prompt|credential/);
  });
});

describe("renderRunConfiguration", () => {
  it("reconstructs historical durable-discovery runs without pinned configuration bytes", () => {
    const roles = {
      brain: { model: "brain-model", reasoning_effort: "high", sandbox: "read-only" },
      hands: { model: "hands-model", reasoning_effort: "xhigh", sandbox: "workspace-write" },
      verifier: { model: "verifier-model", reasoning_effort: "high", sandbox: "read-only" },
    } as const;
    const reviewPolicy = {
      policy_revision: 1,
      max_fix_cycles: 2,
      on_limit: "auto_replan",
      auto_advance_on_approval: true,
      severity_defaults: {
        critical: "blocking",
        high: "fix_in_scope",
        medium: "fix_in_scope",
        low: "advisory",
      },
      pause_on: ["plan_approval"],
    } as const;
    const manifest = runManifestV2Schema.parse({
      version: 2,
      run_id: "historical-durable-discovery",
      original_request: "Migrate a durable discovery prefix",
      repo_root: "/tmp/repo",
      created_at: "2026-07-16T12:00:00.000Z",
      updated_at: "2026-07-16T12:00:00.000Z",
      stage: "awaiting_plan_approval",
      workflow_protocol: "durable-discovery-v1",
      discovery: {
        cycle: 1,
        cycle_kind: "initial",
        asked_questions: 0,
        answered_questions: 0,
        current_question_id: null,
        current_approaches_revision: null,
        selected_approach_id: null,
        current_brief_revision: 1,
        current_readiness_revision: 1,
        approved_brief_revision: 1,
        approved_brief_sha256: "a".repeat(64),
        proceed_with_assumptions: null,
        pending_action_path: null,
        question_artifacts: {},
        answer_artifacts: {},
        readiness_revisions: {},
        brief_revisions: {},
      },
      current_work_item_id: null,
      retry_counts: {}, issue_numbers: [], pull_request_numbers: [], events: [],
      current_revision: 1,
      approved_revision: 1,
      current_plan_revision: 1,
      approved_plan_revision: 1,
      plan_revisions: { "1": { revision: 1, path: "plans/revision-1.md", sha256: "b".repeat(64) } },
      mode: "local",
      run_mode: "local",
      source_commit: "d".repeat(40),
      role_profiles: roles,
      selected_role_profiles: roles,
      review_policy_snapshot: reviewPolicy,
      controller_provenance: {
        self_hosting: false,
        mode: "development_checkout",
        executable_path: "/tmp/brain-hands",
        package_root: "/tmp/package",
        package_name: "@ngelik/brain-hands",
        package_version: "0.4.0",
        package_hash_algorithm: "sha256",
        package_hash: "c".repeat(64),
        candidate_commit: "d".repeat(40),
      },
    });

    const reconstructed = reconstructHistoricalRunConfiguration(manifest, {
      task: manifest.original_request,
      repo_root: manifest.repo_root,
      mode: "local",
      research: false,
      reflection: false,
    });

    expect(reconstructed).toMatchObject({
      repository: "/tmp/repo",
      mode: "local",
      research: false,
      reflection: false,
      controller: { package_name: "@ngelik/brain-hands", package_version: "0.4.0" },
      limits: { review_policy: reviewPolicy },
      github: { effects: "none", default_remote: "origin" },
    });
  });

  it("rejects GitHub effects that contradict the selected execution mode", () => {
    const base = resolveRunConfiguration({
      intake: resolveRunIntake({
        task: "Reject contradictory effects",
        repo_root: "/tmp/example",
        mode: "local",
        research: false,
        reflection: false,
      }, defaultConfig()),
      config: defaultConfig(),
      controller: {
        self_hosting: false,
        ...controller,
        executable_path: "/tmp/controller",
        package_root: "/tmp/package",
        package_hash_algorithm: "sha256",
        package_hash: "a".repeat(64),
        candidate_commit: "b".repeat(40),
      },
      overrides: {},
    });

    expect(() => resolvedRunConfigurationSchema.parse({
      ...base,
      mode: "github",
      github: { ...base.github, effects: "none" },
    })).toThrow(/GitHub effects must match the execution mode/);
    expect(() => resolvedRunConfigurationSchema.parse({
      ...base,
      github: { ...base.github, effects: "issues_and_pull_request" },
    })).toThrow(/GitHub effects must match the execution mode/);
  });

  it("serializes canonical newline-terminated bytes and hashes those exact bytes", () => {
    const configuration = resolvedRunConfigurationSchema.parse({
      version: 1,
      repository: "/tmp/example",
      mode: "local",
      research: false,
      reflection: false,
      controller,
      roles: {
        brain: { model: "brain", reasoning_effort: "high", sandbox: "read-only", source: "repository_config" },
        hands: { model: "hands", reasoning_effort: "xhigh", sandbox: "workspace-write", source: "repository_config" },
        verifier: { model: "verifier", reasoning_effort: "high", sandbox: "read-only", source: "repository_config" },
      },
      hands_backup: null,
      limits: {
        max_hands_fix_attempts: 3,
        max_replan_attempts: 2,
        review_policy: {
          policy_revision: 1,
          max_fix_cycles: 2,
          on_limit: "auto_replan",
          auto_advance_on_approval: true,
          severity_defaults: {
            critical: "blocking",
            high: "blocking",
            medium: "fix_in_scope",
            low: "advisory",
          },
          pause_on: ["plan_approval"],
        },
        quality_gate: null,
      },
      github: { effects: "none", default_remote: "origin" },
    });
    const bytes = serializeRunConfiguration(configuration);

    expect(bytes.endsWith("\n")).toBe(true);
    expect(bytes).toBe(`${JSON.stringify(JSON.parse(bytes))}\n`);
    expect(runConfigurationSha256(configuration)).toMatch(/^[a-f0-9]{64}$/);
    expect(runConfigurationSha256({ ...configuration, reflection: true }))
      .not.toBe(runConfigurationSha256(configuration));
  });

  it("shows the enabled Hands backup model and policy", () => {
    const configuration = resolvedRunConfigurationSchema.parse({
      version: 1,
      repository: "/tmp/example",
      mode: "local",
      research: false,
      reflection: false,
      controller: {
        package_name: "@ngelik/brain-hands",
        package_version: "0.3.0",
        mode: "installed",
      },
      roles: {
        brain: { model: "brain-model", reasoning_effort: "high", sandbox: "read-only", source: "repository_config" },
        hands: { model: "hands-model", reasoning_effort: "xhigh", sandbox: "workspace-write", source: "repository_config" },
        verifier: { model: "verifier-model", reasoning_effort: "high", sandbox: "read-only", source: "repository_config" },
      },
      hands_backup: {
        fallback_on_primary_usage_limit: true,
        max_quality_recovery_attempts: 1,
        profile: { model: "backup-model", reasoning_effort: "medium" },
      },
      limits: {
        max_hands_fix_attempts: 3,
        max_replan_attempts: 2,
        review_policy: {
          policy_revision: 1,
          max_fix_cycles: 2,
          on_limit: "auto_replan",
          auto_advance_on_approval: true,
          severity_defaults: {
            critical: "blocking",
            high: "fix_in_scope",
            medium: "fix_in_scope",
            low: "advisory",
          },
          pause_on: ["plan_approval"],
        },
        quality_gate: null,
      },
      github: { effects: "none", default_remote: "origin" },
    });

    expect(renderRunConfiguration(configuration)).toContain(
      "Hands backup: backup-model | medium reasoning | usage-limit fallback enabled | 1 quality-recovery attempt",
    );
  });
});
