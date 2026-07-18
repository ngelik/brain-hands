import { checkCommand, runCommand } from "../core/executor.js";
import type {
  PreflightCheck,
  PreflightResult,
  PreflightStatus,
  ReasoningEffort,
  RoleName,
  RunPreflightInput,
} from "../core/types.js";
import { CodexModelCatalogAdapter, type ValidateModelSelectionInput } from "../adapters/codex-models.js";
import { inspectGitHubSetup } from "../adapters/github-setup.js";
import { DISABLED_CODEX_AGENT_FEATURES, disabledCodexAgentFeatureArgs } from "../adapters/codex.js";
import { DEFAULT_PHASE_REASONING } from "../core/config.js";

export const REQUIRED_CODEX_FLAGS = [
  "--ephemeral",
  "--disable",
  "--model",
  "-c",
  "--sandbox",
  "-C",
  "--output-schema",
  "--output-last-message",
] as const;

function helpIncludesFlag(helpText: string, flag: string): boolean {
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|\\s)${escaped}(?=\\s|[,;:]|$)`, "m").test(helpText);
}

function listedFeatures(output: string): Set<string> {
  return new Set(output.split(/[^A-Za-z0-9_-]+/).filter(Boolean));
}

export type GithubAuthStatus =
  | "authenticated"
  | "unauthenticated"
  | "keyring_unavailable"
  | "sandbox_blocked"
  | "unavailable"
  | "skipped"
  | "unknown";

export interface GithubAuthReport {
  status: GithubAuthStatus;
  reason: string | null;
  stderr: string;
}

export interface RunPreflightOptions extends RunPreflightInput {
  /** Execute a real, read-only model probe. Disabled by default. */
  liveModelCheck?: boolean;
  /** Require Codex search support for a research-enabled run. */
  research?: boolean;
  /** Explicit alias for callers that want to require --search support. */
  requireSearch?: boolean;
  /** Role whose configured model is probed when liveModelCheck is enabled. */
  role?: RoleName;
  /** Explicit model override for the optional live check. */
  model?: string;
}

export type RunPreflightReport = PreflightResult & {
  github_auth: GithubAuthReport;
  /** String alias for consumers that only need the classification. */
  github_auth_status: GithubAuthStatus;
  supports_search: boolean;
  github_repository: string | null;
  missing_github_labels: string[];
  drifted_github_labels: string[];
};

function makePreflightCheck({
  command,
  args,
  required,
  available,
  exitCode,
  stdout,
  stderr,
}: {
  command: string;
  args: string[];
  required: boolean;
  available: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}): PreflightCheck {
  const status: PreflightStatus = available ? "OK" : "FAIL";
  return {
    command,
    args,
    required,
    status,
    available,
    exit_code: exitCode,
    stdout,
    stderr,
  };
}

function makeSkippedCheck(command: string, args: string[], required: boolean): PreflightCheck {
  return {
    command,
    args,
    required,
    status: "SKIP",
    available: false,
    exit_code: null,
    stdout: "",
    stderr: "",
  };
}

function classifyGithubAuth(
  githubMode: boolean,
  authCheck: PreflightCheck | undefined,
  versionCheck: PreflightCheck | undefined,
): GithubAuthReport {
  if (!githubMode || !authCheck || !versionCheck) {
    return { status: "skipped", reason: null, stderr: "" };
  }
  if (versionCheck.status !== "OK") {
    return {
      status: "unavailable",
      reason: "GitHub CLI is unavailable in this environment.",
      stderr: versionCheck.stderr,
    };
  }
  if (authCheck.status === "OK") {
    return { status: "authenticated", reason: null, stderr: authCheck.stderr };
  }

  const details = `${authCheck.stderr}\n${authCheck.stdout}`.trim();
  const lower = details.toLowerCase();
  const keyringFailure =
    lower.includes("keyring") ||
    lower.includes("keychain") ||
    lower.includes("secret service") ||
    lower.includes("credential store") ||
    lower.includes("credential helper") ||
    lower.includes("config access") ||
    lower.includes("configuration access");

  if (keyringFailure) {
    return {
      status: "keyring_unavailable",
      reason: "GitHub CLI could not access the platform keychain, keyring, credential helper, or configuration.",
      stderr: authCheck.stderr,
    };
  }

  const sandboxFailure =
    lower.includes("sandbox") ||
    lower.includes("permission denied") ||
    lower.includes("operation not permitted") ||
    lower.includes("not permitted") ||
    lower.includes("process blocked") ||
    lower.includes("could not connect");

  if (sandboxFailure) {
    return {
      status: "sandbox_blocked",
      reason: "GitHub CLI authentication was blocked by the sandbox or process permissions.",
      stderr: authCheck.stderr,
    };
  }

  return {
    status: "unauthenticated",
    reason: "GitHub CLI is available but no authenticated account was reported.",
    stderr: authCheck.stderr,
  };
}

function selectedModel(options: RunPreflightOptions): {
  model: string | undefined;
  reasoningEffort: string;
} {
  if (options.model) {
    return { model: options.model, reasoningEffort: "high" };
  }

  const role = options.role ?? "brain";
  const profiles = (options.config as unknown as {
    profiles?: Record<string, { model?: string; reasoning_effort?: string }>;
  }).profiles;
  const profile = profiles?.[role];
  if (profile?.model) {
    return {
      model: profile.model,
      reasoningEffort: profile.reasoning_effort ?? "high",
    };
  }

  const legacyRole = role === "brain" ? "brain_planner" : role === "hands" ? "hands_implementer" : "brain_reviewer";
  const legacyProfile = profiles?.[legacyRole];
  return {
    model: legacyProfile?.model,
    reasoningEffort: legacyProfile?.reasoning_effort ?? "high",
  };
}

type CatalogValidator = (input: ValidateModelSelectionInput) => Promise<void>;

function buildLiveProbeArgs(
  options: RunPreflightOptions,
  selectedModel: { model: string; reasoningEffort: string },
): string[] {
  const isolateUserConfig = (
    options.config.codex as typeof options.config.codex & { isolate_user_config?: boolean }
  ).isolate_user_config ?? true;
  return [
    "exec",
    "--ephemeral",
    ...disabledCodexAgentFeatureArgs(),
    ...(isolateUserConfig ? ["--ignore-user-config"] : []),
    "--model",
    selectedModel.model,
    "-c",
    `model_reasoning_effort="${selectedModel.reasoningEffort}"`,
    "--sandbox",
    "read-only",
    "-C",
    options.repoRoot,
  ];
}

async function runLiveModelCheck(
  options: RunPreflightOptions,
  validateModelSelection: CatalogValidator,
): Promise<PreflightCheck> {
  const selected = selectedModel(options);
  if (!selected.model) {
    return makePreflightCheck({
      command: options.config.codex.command,
      args: ["exec"],
      required: true,
      available: false,
      exitCode: null,
      stdout: "",
      stderr: "No selected role model is configured.",
    });
  }
  const selectedProbe = {
    model: selected.model,
    reasoningEffort: selected.reasoningEffort,
  };

  try {
    await validateModelSelection({
      role: options.role ?? "brain",
      ...selectedProbe,
    });
  } catch (error) {
    const args = buildLiveProbeArgs(options, selectedProbe);
    return makePreflightCheck({
      command: options.config.codex.command,
      args,
      required: true,
      available: false,
      exitCode: null,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
    });
  }

  const args = buildLiveProbeArgs(options, selectedProbe);
  const result = await runCommand({
    command: options.config.codex.command,
    args,
    cwd: options.repoRoot,
    timeoutMs: options.config.codex.timeout_seconds * 1000,
    stdin: "Reply with exact text OK",
  });
  return makePreflightCheck({
    command: options.config.codex.command,
    args,
    required: true,
    available: result.exitCode === 0 && result.stdout.trim() === "OK",
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr:
      result.exitCode === 0 && result.stdout.trim() === "OK"
        ? result.stderr
        : result.stderr || "Live model check did not return exact OK.",
    });
}

async function runCatalogValidationCheck(
  options: RunPreflightOptions,
  role: RoleName,
  validateModelSelection: CatalogValidator,
): Promise<PreflightCheck> {
  const profiles = options.config.profiles as unknown as Partial<
    Record<RoleName, { model?: string; reasoning_effort?: string }>
  >;
  const profile = profiles[role];
  const selectedModel = profile?.model;
  const reasoningEffort = profile?.reasoning_effort ?? "high";
  if (!selectedModel) {
    return makePreflightCheck({
      command: options.config.codex.command,
      args: ["debug", "models"],
      required: true,
      available: false,
      exitCode: null,
      stdout: "",
      stderr: `No model is configured for role "${role}".`,
    });
  }

  try {
    await validateModelSelection({ role, model: selectedModel, reasoningEffort });
    return makePreflightCheck({
      command: options.config.codex.command,
      args: ["debug", "models"],
      required: true,
      available: true,
      exitCode: null,
      stdout: "",
      stderr: "",
    });
  } catch (error) {
    return makePreflightCheck({
      command: options.config.codex.command,
      args: ["debug", "models"],
      required: true,
      available: false,
      exitCode: null,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
    });
  }
}

async function runCatalogProfileValidationCheck(
  options: RunPreflightOptions,
  label: string,
  role: RoleName,
  profile: { model?: string; reasoning_effort?: string } | undefined,
  validateModelSelection: CatalogValidator,
): Promise<PreflightCheck> {
  const selectedModel = profile?.model;
  const reasoningEffort = profile?.reasoning_effort ?? "high";
  if (!selectedModel) {
    return makePreflightCheck({
      command: options.config.codex.command,
      args: ["debug", "models"],
      required: true,
      available: false,
      exitCode: null,
      stdout: "",
      stderr: `No model is configured for ${label}.`,
    });
  }

  try {
    await validateModelSelection({ role, model: selectedModel, reasoningEffort });
    return makePreflightCheck({
      command: options.config.codex.command,
      args: ["debug", "models"],
      required: true,
      available: true,
      exitCode: null,
      stdout: "",
      stderr: "",
    });
  } catch (error) {
    return makePreflightCheck({
      command: options.config.codex.command,
      args: ["debug", "models"],
      required: true,
      available: false,
      exitCode: null,
      stdout: "",
      stderr: `${label}: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

export async function runPreflight(options: RunPreflightOptions): Promise<RunPreflightReport> {
  const {
    repoRoot,
    config,
    githubMode,
    liveModelCheck = false,
    research = false,
    requireSearch = false,
  } = options;
  const checks: PreflightCheck[] = [];

  const gitVersion = await checkCommand("git", ["--version"], repoRoot);
  checks.push(
    makePreflightCheck({
      command: "git",
      args: ["--version"],
      required: true,
      available: gitVersion.available,
      exitCode: gitVersion.exitCode,
      stdout: gitVersion.stdout,
      stderr: gitVersion.stderr,
    }),
  );

  const gitRoot = await checkCommand("git", ["rev-parse", "--show-toplevel"], repoRoot);
  checks.push(
    makePreflightCheck({
      command: "git",
      args: ["rev-parse", "--show-toplevel"],
      required: true,
      available: gitRoot.available,
      exitCode: gitRoot.exitCode,
      stdout: gitRoot.stdout,
      stderr: gitRoot.stderr,
    }),
  );

  const codexVersion = await checkCommand(config.codex.command, ["--version"], repoRoot);
  checks.push(
    makePreflightCheck({
      command: config.codex.command,
      args: ["--version"],
      required: true,
      available: codexVersion.available,
      exitCode: codexVersion.exitCode,
      stdout: codexVersion.stdout,
      stderr: codexVersion.stderr,
    }),
  );

  const codexHelp = await checkCommand(config.codex.command, ["exec", "--help"], repoRoot);
  const helpText = `${codexHelp.stdout}\n${codexHelp.stderr}`;
  const missingFlags = REQUIRED_CODEX_FLAGS.filter((flag) => !helpIncludesFlag(helpText, flag));
  const supportsSearch = helpIncludesFlag(helpText, "--search");
  const searchRequired = research || requireSearch;
  const searchBlocker =
    searchRequired && !supportsSearch
      ? "Research capability blocker: Codex exec --help does not advertise --search."
      : null;
  const helpAvailable = codexHelp.available && missingFlags.length === 0 && searchBlocker === null;
  checks.push(
    makePreflightCheck({
      command: config.codex.command,
      args: ["exec", "--help"],
      required: true,
      available: helpAvailable,
      exitCode: codexHelp.exitCode,
      stdout: codexHelp.stdout,
      stderr:
        missingFlags.length > 0 || searchBlocker
          ? [
              codexHelp.stderr,
              missingFlags.length > 0 ? `Missing Codex flags: ${missingFlags.join(", ")}` : "",
              searchBlocker ?? "",
            ]
              .filter(Boolean)
              .join("\n")
      : codexHelp.stderr,
    }),
  );

  const codexFeatures = await checkCommand(config.codex.command, ["features", "list"], repoRoot);
  const featureNames = listedFeatures(`${codexFeatures.stdout}\n${codexFeatures.stderr}`);
  const missingFeatures = DISABLED_CODEX_AGENT_FEATURES.filter((feature) => !featureNames.has(feature));
  checks.push(
    makePreflightCheck({
      command: config.codex.command,
      args: ["features", "list"],
      required: true,
      available: codexFeatures.available && missingFeatures.length === 0,
      exitCode: codexFeatures.exitCode,
      stdout: codexFeatures.stdout,
      stderr: missingFeatures.length > 0
        ? [codexFeatures.stderr, `Missing Codex features: ${missingFeatures.join(", ")}`].filter(Boolean).join("\n")
        : codexFeatures.stderr,
    }),
  );

  const catalogAdapter = new CodexModelCatalogAdapter({
    command: options.config.codex.command,
    cwd: repoRoot,
    timeoutMs: options.config.codex.timeout_seconds * 1000,
  });
  const validateModelSelection: CatalogValidator = (input) =>
    catalogAdapter.assertExactModelSelection(input);

  checks.push(
    await runCatalogValidationCheck(options, "brain", validateModelSelection),
  );
  checks.push(
    await runCatalogValidationCheck(options, "hands", validateModelSelection),
  );
  checks.push(
    await runCatalogValidationCheck(options, "verifier", validateModelSelection),
  );
  const profiles = options.config.profiles as unknown as Partial<
    Record<RoleName, { model?: string; reasoning_effort?: string }>
  >;
  const phaseReasoning = (options.config as typeof options.config & {
    phase_reasoning?: { hands_self_review?: ReasoningEffort; reflection?: ReasoningEffort };
  }).phase_reasoning ?? DEFAULT_PHASE_REASONING;
  checks.push(
    await runCatalogProfileValidationCheck(
      options,
      "phase_reasoning.hands_self_review",
      "hands",
      {
        model: profiles.hands?.model,
        reasoning_effort: phaseReasoning.hands_self_review ?? DEFAULT_PHASE_REASONING.hands_self_review,
      },
      validateModelSelection,
    ),
  );
  const backup = options.config.retry_policy.backup;
  if (backup !== undefined) {
    checks.push(
      await runCatalogProfileValidationCheck(
        options,
        "phase_reasoning.hands_self_review backup Hands",
        "hands",
        {
          model: backup.profile.model,
          reasoning_effort: phaseReasoning.hands_self_review ?? DEFAULT_PHASE_REASONING.hands_self_review,
        },
        validateModelSelection,
      ),
    );
  }
  checks.push(
    await runCatalogProfileValidationCheck(
      options,
      "phase_reasoning.reflection",
      "brain",
      {
        model: profiles.brain?.model,
        reasoning_effort: phaseReasoning.reflection ?? DEFAULT_PHASE_REASONING.reflection,
      },
      validateModelSelection,
    ),
  );

  let authCheck: PreflightCheck | undefined;
  let githubVersionCheck: PreflightCheck | undefined;
  if (githubMode) {
    const ghVersion = await checkCommand("gh", ["--version"], repoRoot);
    githubVersionCheck = makePreflightCheck({
        command: "gh",
        args: ["--version"],
        required: true,
        available: ghVersion.available,
        exitCode: ghVersion.exitCode,
        stdout: ghVersion.stdout,
        stderr: ghVersion.stderr,
      });
    checks.push(githubVersionCheck);

    const ghAuth = await checkCommand("gh", ["auth", "status"], repoRoot);
    authCheck = makePreflightCheck({
      command: "gh",
      args: ["auth", "status"],
      required: true,
      available: ghAuth.available,
      exitCode: ghAuth.exitCode,
      stdout: ghAuth.stdout,
      stderr: ghAuth.stderr,
    });
    checks.push(authCheck);
  } else {
    checks.push(makeSkippedCheck("gh", ["--version"], false));
    checks.push(makeSkippedCheck("gh", ["auth", "status"], false));
  }

  const githubAuth = classifyGithubAuth(githubMode, authCheck, githubVersionCheck);
  let githubRepository: string | null = null;
  let missingGithubLabels: string[] = [];
  let driftedGithubLabels: string[] = [];
  if (githubAuth.status === "authenticated") {
    try {
      const inspection = await inspectGitHubSetup(repoRoot, config.github.default_remote);
      githubRepository = inspection.repository.nameWithOwner;
      missingGithubLabels = inspection.labels.filter((label) => label.status === "missing").map((label) => label.name);
      driftedGithubLabels = inspection.labels.filter((label) => label.status === "existing_drifted").map((label) => label.name);
      checks.push(makePreflightCheck({
        command: "gh",
        args: ["label", "list", "--repo", githubRepository],
        required: true,
        available: missingGithubLabels.length === 0,
        exitCode: missingGithubLabels.length === 0 ? 0 : 1,
        stdout: inspection.labels.map((label) => `${label.status} ${label.name}`).join("\n"),
        stderr: missingGithubLabels.length === 0 ? "" : `Missing GitHub workflow labels: ${missingGithubLabels.join(", ")}.\nRun: brain-hands init --repo . --github`,
      }));
    } catch (error) {
      checks.push(makePreflightCheck({ command: "gh", args: ["label", "list"], required: true, available: false, exitCode: 1, stdout: "", stderr: error instanceof Error ? error.message : String(error) }));
    }
  } else if (githubMode) {
    checks.push(makeSkippedCheck("gh", ["label", "list"], true));
  }

  const codexCapabilityFailed = checks.some((check) =>
    check.required
    && check.status === "FAIL"
    && check.command === config.codex.command
    && (check.args.join(" ") === "exec --help" || check.args.join(" ") === "features list"));
  if (liveModelCheck && !codexCapabilityFailed) {
    checks.push(await runLiveModelCheck(options, validateModelSelection));
  } else {
    checks.push(makeSkippedCheck(config.codex.command, ["exec", "--live-model-check"], false));
  }

  return {
    checks,
    required_checks_failed: checks.some((check) => check.required && check.status === "FAIL"),
    github_auth: githubAuth,
    github_auth_status: githubAuth.status,
    supports_search: supportsSearch,
    github_repository: githubRepository,
    missing_github_labels: missingGithubLabels,
    drifted_github_labels: driftedGithubLabels,
  };
}
