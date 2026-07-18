import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolCheck, CommandResult } from "../../src/core/executor.js";
import { checkCommand, runCommand } from "../../src/core/executor.js";
import { defaultConfig } from "../../src/core/config.js";
import { runPreflight } from "../../src/workflow/preflight.js";
import { inspectGitHubSetup } from "../../src/adapters/github-setup.js";

vi.mock("../../src/core/executor.js", () => ({
  checkCommand: vi.fn(),
  runCommand: vi.fn(),
}));
vi.mock("../../src/adapters/github-setup.js", () => ({ inspectGitHubSetup: vi.fn() }));

const mockedCheckCommand = vi.mocked(checkCommand);
const mockedRunCommand = vi.mocked(runCommand);
const mockedInspectGitHubSetup = vi.mocked(inspectGitHubSetup);

function makeCheck(input: Partial<ToolCheck> & Pick<ToolCheck, "command" | "args">): ToolCheck {
  return {
    available: true,
    exitCode: 0,
    stdout: "",
    stderr: "",
    ...input,
  };
}

function catalogCommandResult(): CommandResult {
  return {
    command: "codex",
    args: ["debug", "models"],
    exitCode: 0,
    stdout: JSON.stringify({
      models: [
        { slug: "gpt-5.6-sol", supported_reasoning_levels: [{ effort: "medium" }, { effort: "high" }, { effort: "xhigh" }, { effort: "ultra" }] },
        { slug: "gpt-5.3-codex-spark", supported_reasoning_levels: [{ effort: "medium" }, { effort: "high" }, { effort: "xhigh" }] },
        { slug: "gpt-5.6-terra", supported_reasoning_levels: [{ effort: "medium" }, { effort: "high" }, { effort: "xhigh" }] },
        { slug: "gpt-5.6-luna", supported_reasoning_levels: [{ effort: "medium" }, { effort: "high" }, { effort: "xhigh" }] },
      ],
    }),
    stderr: "",
    failed: false,
    timedOut: false,
    signal: null,
  };
}

function queueBaseChecks(config = defaultConfig(), help = [
  "--ephemeral",
  "--disable",
  "--model",
  "-c",
  "--sandbox",
  "-C",
  "--output-schema",
  "--output-last-message",
].join(" ")): void {
  mockedCheckCommand
    .mockResolvedValueOnce(makeCheck({ command: "git", args: ["--version"], stdout: "git 2.0.0" }))
    .mockResolvedValueOnce(makeCheck({ command: "git", args: ["rev-parse", "--show-toplevel"], stdout: "/tmp/repo" }))
    .mockResolvedValueOnce(makeCheck({ command: config.codex.command, args: ["--version"], stdout: "codex 1.0.0" }))
    .mockResolvedValueOnce(makeCheck({ command: config.codex.command, args: ["exec", "--help"], stdout: help }))
    .mockResolvedValueOnce(makeCheck({ command: config.codex.command, args: ["features", "list"], stdout: "multi_agent\nmulti_agent_v2\nenable_fanout\n" }));
}

afterEach(() => {
  mockedCheckCommand.mockReset();
  mockedRunCommand.mockReset();
  mockedInspectGitHubSetup.mockReset();
});

describe("runPreflight", () => {
  it("checks the current Codex capability flags and Git root", async () => {
    const config = defaultConfig();
    queueBaseChecks(config);
    mockedRunCommand.mockResolvedValueOnce(catalogCommandResult());

    const result = await runPreflight({
      repoRoot: "/tmp/repo",
      config,
      strict: true,
      githubMode: false,
    });

    expect(mockedCheckCommand).toHaveBeenCalledTimes(5);
    expect(mockedCheckCommand).toHaveBeenNthCalledWith(2, "git", ["rev-parse", "--show-toplevel"], "/tmp/repo");
    expect(mockedCheckCommand).toHaveBeenNthCalledWith(4, "codex", ["exec", "--help"], "/tmp/repo");
    expect(mockedCheckCommand).toHaveBeenNthCalledWith(5, "codex", ["features", "list"], "/tmp/repo");
    expect(mockedRunCommand).toHaveBeenCalledWith({
      command: "codex",
      args: ["debug", "models"],
      cwd: "/tmp/repo",
      timeoutMs: config.codex.timeout_seconds * 1000,
    });
    expect(result.checks.filter((check) => check.args.join(" ") === "debug models")).toHaveLength(5);
    expect(result.checks.find((check) => check.args.join(" ") === "exec --help")?.status).toBe("OK");
    expect(result.checks.find((check) => check.args.join(" ") === "exec --live-model-check")?.status).toBe("SKIP");
    expect(result.required_checks_failed).toBe(false);
    expect(result.github_auth_status).toBe("skipped");
  });

  it("fails the Codex capability check when a required flag is absent", async () => {
    const config = defaultConfig();
    queueBaseChecks(config, "--ephemeral --model -c --sandbox -C --output-schema");
    mockedRunCommand.mockResolvedValueOnce(catalogCommandResult());

    const result = await runPreflight({
      repoRoot: "/tmp/repo",
      config,
      strict: false,
      githubMode: false,
    });

    const helpCheck = result.checks.find((check) => check.args.join(" ") === "exec --help");
    expect(helpCheck?.status).toBe("FAIL");
    expect(helpCheck?.stderr).toContain("--output-last-message");
    expect(result.required_checks_failed).toBe(true);
  });

  it("requires search capability only when research is enabled", async () => {
    const config = defaultConfig();
    queueBaseChecks(config);
    mockedRunCommand.mockResolvedValueOnce(catalogCommandResult());
    const researchDisabled = await runPreflight({
      repoRoot: "/tmp/repo",
      config,
      strict: true,
      githubMode: false,
      research: false,
    });
    expect(researchDisabled.supports_search).toBe(false);
    expect(researchDisabled.required_checks_failed).toBe(false);

    mockedCheckCommand.mockReset();
    mockedRunCommand.mockReset();
    queueBaseChecks(config);
    mockedRunCommand.mockResolvedValueOnce(catalogCommandResult());
    const researchEnabled = await runPreflight({
      repoRoot: "/tmp/repo",
      config,
      strict: true,
      githubMode: false,
      research: true,
    });
    const blockedHelp = researchEnabled.checks.find((check) => check.args.join(" ") === "exec --help");
    expect(researchEnabled.supports_search).toBe(false);
    expect(blockedHelp?.status).toBe("FAIL");
    expect(blockedHelp?.stderr).toContain("Research capability blocker");
    expect(researchEnabled.required_checks_failed).toBe(true);

    mockedCheckCommand.mockReset();
    mockedRunCommand.mockReset();
    queueBaseChecks(config, "--ephemeral --disable --model -c --sandbox -C --output-schema --output-last-message --search");
    mockedRunCommand.mockResolvedValueOnce(catalogCommandResult());
    const supported = await runPreflight({
      repoRoot: "/tmp/repo",
      config,
      strict: true,
      githubMode: false,
      requireSearch: true,
    });
    expect(supported.supports_search).toBe(true);
    expect(supported.required_checks_failed).toBe(false);
  });

  it("requires gh checks only in GitHub mode", async () => {
    const config = defaultConfig();
    queueBaseChecks(config);
    mockedRunCommand.mockResolvedValueOnce(catalogCommandResult());
    const localResult = await runPreflight({ repoRoot: "/tmp/repo", config, strict: false, githubMode: false });
    expect(mockedCheckCommand).toHaveBeenCalledTimes(5);
    expect(localResult.checks.filter((check) => check.command === "gh").every((check) => check.status === "SKIP")).toBe(true);

    mockedCheckCommand.mockReset();
    mockedRunCommand.mockReset();
    queueBaseChecks(config);
    mockedRunCommand.mockResolvedValueOnce(catalogCommandResult());
    mockedCheckCommand
      .mockResolvedValueOnce(makeCheck({ command: "gh", args: ["--version"], stdout: "gh 2.0.0" }))
      .mockResolvedValueOnce(makeCheck({ command: "gh", args: ["auth", "status"], stdout: "Logged in" }));
    mockedInspectGitHubSetup.mockResolvedValue({
      repository: { remote: "origin", remoteUrl: "git@github.com:acme/repo.git", host: "github.com", owner: "acme", name: "repo", nameWithOwner: "acme/repo" },
      labels: [],
    });
    const githubResult = await runPreflight({ repoRoot: "/tmp/repo", config, strict: false, githubMode: true });
    expect(mockedCheckCommand).toHaveBeenCalledTimes(7);
    expect(githubResult.github_auth_status).toBe("authenticated");
    expect(githubResult.required_checks_failed).toBe(false);
  });

  it("fails GitHub preflight with an actionable missing-label report", async () => {
    const config = defaultConfig();
    queueBaseChecks(config);
    mockedCheckCommand
      .mockResolvedValueOnce(makeCheck({ command: "gh", args: ["--version"], stdout: "gh 2.0.0" }))
      .mockResolvedValueOnce(makeCheck({ command: "gh", args: ["auth", "status"], stdout: "Logged in" }));
    mockedInspectGitHubSetup.mockResolvedValue({
      repository: { remote: "origin", remoteUrl: "git@github.com:acme/repo.git", host: "github.com", owner: "acme", name: "repo", nameWithOwner: "acme/repo" },
      labels: [{ name: "hands:ready", status: "missing", expected: { name: "hands:ready", color: "0E8A16", description: "ready" } }],
    });

    const result = await runPreflight({ repoRoot: "/tmp/repo", config, strict: false, githubMode: true });

    expect(result.github_repository).toBe("acme/repo");
    expect(result.missing_github_labels).toEqual(["hands:ready"]);
    expect(result.required_checks_failed).toBe(true);
    expect(result.checks.at(-2)?.stderr).toContain("brain-hands init --repo . --github");
  });

  it("distinguishes unauthenticated, keyring, keychain, and sandbox GitHub failures", async () => {
    const config = defaultConfig();

    queueBaseChecks(config);
    mockedRunCommand.mockResolvedValueOnce(catalogCommandResult());
    mockedCheckCommand
      .mockResolvedValueOnce(makeCheck({ command: "gh", args: ["--version"], stdout: "gh 2.0.0" }))
      .mockResolvedValueOnce(makeCheck({
        command: "gh",
        args: ["auth", "status"],
        available: false,
        exitCode: 1,
        stderr: "not logged in",
      }));
    const unauthenticated = await runPreflight({ repoRoot: "/tmp/repo", config, strict: false, githubMode: true });
    expect(unauthenticated.github_auth_status).toBe("unauthenticated");

    mockedCheckCommand.mockReset();
    mockedRunCommand.mockReset();
    queueBaseChecks(config);
    mockedRunCommand.mockResolvedValueOnce(catalogCommandResult());
    mockedCheckCommand
      .mockResolvedValueOnce(makeCheck({ command: "gh", args: ["--version"], stdout: "gh 2.0.0" }))
      .mockResolvedValueOnce(makeCheck({
        command: "gh",
        args: ["auth", "status"],
        available: false,
        exitCode: 1,
        stderr: "platform keyring unavailable in sandbox",
      }));
    const unavailable = await runPreflight({ repoRoot: "/tmp/repo", config, strict: false, githubMode: true });
    expect(unavailable.github_auth_status).toBe("keyring_unavailable");
    expect(unavailable.github_auth.reason).toContain("keychain");

    mockedCheckCommand.mockReset();
    mockedRunCommand.mockReset();
    queueBaseChecks(config);
    mockedRunCommand.mockResolvedValueOnce(catalogCommandResult());
    mockedCheckCommand
      .mockResolvedValueOnce(makeCheck({ command: "gh", args: ["--version"], stdout: "gh 2.0.0" }))
      .mockResolvedValueOnce(makeCheck({
        command: "gh",
        args: ["auth", "status"],
        available: false,
        exitCode: 1,
        stderr: "macOS keychain access denied",
      }));
    const keychain = await runPreflight({ repoRoot: "/tmp/repo", config, strict: false, githubMode: true });
    expect(keychain.github_auth_status).toBe("keyring_unavailable");

    mockedCheckCommand.mockReset();
    mockedRunCommand.mockReset();
    queueBaseChecks(config);
    mockedRunCommand.mockResolvedValueOnce(catalogCommandResult());
    mockedCheckCommand
      .mockResolvedValueOnce(makeCheck({ command: "gh", args: ["--version"], stdout: "gh 2.0.0" }))
      .mockResolvedValueOnce(makeCheck({
        command: "gh",
        args: ["auth", "status"],
        available: false,
        exitCode: 1,
        stderr: "process blocked by sandbox",
      }));
    const sandbox = await runPreflight({ repoRoot: "/tmp/repo", config, strict: false, githubMode: true });
    expect(sandbox.github_auth_status).toBe("sandbox_blocked");
    expect(sandbox.github_auth.reason).toContain("sandbox");
  });

  it("runs the optional live model check with a read-only ephemeral prompt", async () => {
    const config = defaultConfig();
    queueBaseChecks(config);
    mockedRunCommand
      .mockResolvedValueOnce(catalogCommandResult())
      .mockResolvedValueOnce({
        command: "codex",
        args: [],
        exitCode: 0,
        stdout: "OK\n",
        stderr: "",
        failed: false,
        timedOut: false,
        signal: null,
      });

    const result = await runPreflight({
      repoRoot: "/tmp/repo",
      config,
      strict: true,
      githubMode: false,
      liveModelCheck: true,
      role: "brain",
    });

    expect(mockedRunCommand).toHaveBeenNthCalledWith(1, {
      command: "codex",
      args: ["debug", "models"],
      cwd: "/tmp/repo",
      timeoutMs: config.codex.timeout_seconds * 1000,
    });
    expect(mockedRunCommand).toHaveBeenNthCalledWith(2, {
      command: "codex",
      args: [
        "exec",
        "--ephemeral",
        "--disable",
        "multi_agent",
        "--disable",
        "multi_agent_v2",
        "--disable",
        "enable_fanout",
        "--ignore-user-config",
        "--model",
        config.profiles.brain.model,
        "-c",
        `model_reasoning_effort="${config.profiles.brain.reasoning_effort}"`,
        "--sandbox",
        "read-only",
        "-C",
        "/tmp/repo",
      ],
      cwd: "/tmp/repo",
      timeoutMs: config.codex.timeout_seconds * 1000,
      stdin: "Reply with exact text OK",
    });
    const liveCheck = result.checks.find((check) => check.args.includes("--ignore-user-config"));
    expect(liveCheck?.status).toBe("OK");
  });

  it("does not probe the selected role when its catalog selection is invalid", async () => {
    const config = defaultConfig();
    config.profiles.brain.model = "gpt-5.6-missing";
    queueBaseChecks(config);
    mockedRunCommand.mockResolvedValueOnce(catalogCommandResult());

    const result = await runPreflight({
      repoRoot: "/tmp/repo",
      config,
      strict: false,
      githubMode: false,
      liveModelCheck: true,
      role: "brain",
    });

    expect(mockedRunCommand).toHaveBeenCalledTimes(1);
    expect(result.required_checks_failed).toBe(true);
    const liveCheck = result.checks.find((check) => check.args.includes("-C"));
    expect(liveCheck?.status).toBe("FAIL");
    expect(liveCheck?.stderr).toContain('Configured model/reasoning pair for role "brain" is invalid');
  });
});
