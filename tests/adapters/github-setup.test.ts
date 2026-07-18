import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("../../src/core/executor.js", () => ({ runCommand: vi.fn() }));

import { inspectGitHubSetup, parseGitHubRemote, provisionGitHubLabels } from "../../src/adapters/github-setup.js";
import { runCommand } from "../../src/core/executor.js";

const mockedRunCommand = vi.mocked(runCommand);
const success = (stdout = "") => ({ command: "", args: [], exitCode: 0, stdout, stderr: "", failed: false, timedOut: false, signal: null });

afterEach(() => mockedRunCommand.mockReset());

describe("parseGitHubRemote", () => {
  it.each([
    ["git@github.com:acme/widget.git", "acme/widget"],
    ["https://github.com/acme/widget.git", "acme/widget"],
    ["ssh://git@github.com/acme/widget.git", "acme/widget"],
  ])("resolves %s", (remote, expected) => {
    expect(parseGitHubRemote(remote)).toMatchObject({ nameWithOwner: expected, host: "github.com" });
  });

  it("rejects a non-GitHub remote", () => {
    expect(() => parseGitHubRemote("/tmp/repo.git")).toThrow("GitHub remote");
  });
});

describe("GitHub setup", () => {
  it("finds missing and drifted labels for the configured remote", async () => {
    mockedRunCommand
      .mockResolvedValueOnce(success("git@github.com:acme/widget.git"))
      .mockResolvedValueOnce(success("gh version 2"))
      .mockResolvedValueOnce(success("logged in"))
      .mockResolvedValueOnce(success('{"nameWithOwner":"acme/widget"}'))
      .mockResolvedValueOnce(success(JSON.stringify([[
        { name: "brain-hands", color: "5319E7", description: "Managed by the Brain Hands workflow." },
        { name: "brain:planned", color: "FFFFFF", description: "custom" },
      ]])));

    const result = await inspectGitHubSetup("/repo", "origin");

    expect(result.repository.nameWithOwner).toBe("acme/widget");
    expect(result.labels.find((label) => label.name === "brain-hands")?.status).toBe("existing");
    expect(result.labels.find((label) => label.name === "brain:planned")?.status).toBe("existing_drifted");
    expect(result.labels.find((label) => label.name === "brain-hands:not-planned")?.status).toBe("missing");
    expect(result.labels.filter((label) => label.status === "missing")).toHaveLength(11);
  });

  it("rejects case-insensitive label collisions instead of selecting one", async () => {
    mockedRunCommand
      .mockResolvedValueOnce(success("git@github.com:acme/widget.git"))
      .mockResolvedValueOnce(success("gh version 2"))
      .mockResolvedValueOnce(success("logged in"))
      .mockResolvedValueOnce(success('{"nameWithOwner":"acme/widget"}'))
      .mockResolvedValueOnce(success(JSON.stringify([[
        { name: "brain-hands:ready", color: "0E8A16", description: "Approved work item is ready for Hands" },
        { name: "BRAIN-HANDS:READY", color: "FFFFFF", description: "collision" },
      ]])));

    await expect(inspectGitHubSetup("/repo", "origin")).rejects.toThrow("case-insensitive label collision");
  });

  it("creates only missing labels and creates none during dry-run", async () => {
    const inspection = {
      repository: { remote: "origin", remoteUrl: "git@github.com:acme/widget.git", host: "github.com", owner: "acme", name: "widget", nameWithOwner: "acme/widget" },
      labels: [
        { name: "brain-hands", status: "existing" as const, expected: { name: "brain-hands", color: "5319E7", description: "Managed by the Brain Hands workflow." } },
        { name: "hands:ready", status: "missing" as const, expected: { name: "hands:ready", color: "0E8A16", description: "Work item is ready for Hands implementation." } },
      ],
    };
    mockedRunCommand.mockResolvedValue(success());

    expect((await provisionGitHubLabels("/repo", inspection, true)).wouldCreate).toEqual(["hands:ready"]);
    expect(mockedRunCommand).not.toHaveBeenCalled();

    expect((await provisionGitHubLabels("/repo", inspection, false)).created).toEqual(["hands:ready"]);
    expect(mockedRunCommand).toHaveBeenCalledTimes(1);
    expect(mockedRunCommand.mock.calls[0]?.[0].args).toContain("hands:ready");
  });
});
