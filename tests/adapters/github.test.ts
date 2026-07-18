import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("../../src/core/executor.js", () => ({
  runCommand: vi.fn(),
}));

import { DryRunGitHubAdapter, GhCliGitHubAdapter, ISSUE_LABELS, PARENT_ISSUE_LABELS, StatusCommentOwnershipConflictError, formatIssueBody, formatParentIssueBody, parseGhCreateResultNumber, reconcileManagedIssueBody } from "../../src/adapters/github.js";
import { runCommand } from "../../src/core/executor.js";

import type { IssueSpec } from "../../src/core/types.js";
import { executionSpec } from "../fixtures/execution-spec.js";
import type { ParentIssueSpec } from "../../src/adapters/github.js";

const mockedRunCommand = vi.mocked(runCommand);
const lineageId = "946c7414-d500-4e65-a596-dcf99f0015c2";

afterEach(() => {
  mockedRunCommand.mockReset();
});

function issue(): IssueSpec {
  return {
    title: "[release-ci:config] Create config",
    feature_slug: "release-ci",
    work_item_id: "config",
    plan_revision: 2,
    type: "implementation_task",
    run_id: "run-1",
    parent_request: "Build CLI",
    goal: "Create config",
    context: "Config lives in .brain-hands/config.yaml",
    scope: { include: ["src/core/config.ts"], exclude: ["network calls"] },
    dependencies: [],
    implementation_steps: ["Create default config"],
    acceptance_criteria: ["init writes config"],
    verification: {
      required_commands: ["npm test -- tests/core/config.test.ts"],
      manual_checks: [],
      expected_artifacts: [".brain-hands/config.yaml"],
    },
    review_checklist: ["No overwrite without force"],
    risk_register: ["Overwriting existing config"],
    handoff_prompt: "Implement config only.",
  };
}

function ghSuccessResult(stdout: string) {
  return {
    command: "gh",
    args: [],
    exitCode: 0,
    stdout,
    stderr: "",
    failed: false,
    timedOut: false,
    signal: null,
  };
}

function parentIssue(): ParentIssueSpec {
  return {
    title: "[release-ci] Manual release",
    summary: "Manual release workflow",
    runId: "run-1",
    featureSlug: "release-ci",
    planRevision: 2,
    workItems: [{ id: "config", issueNumber: 14 }],
  };
}

describe("formatIssueBody", () => {
  it("uses the brain-hands GitHub label marker", () => {
    expect(ISSUE_LABELS.split(",", 1)).toEqual(["brain-hands"]);
  });

  it("includes machine-readable issue spec", () => {
    const body = formatIssueBody(issue());

    expect(body).toContain("```yaml");
    expect(body).toContain("goal: Create config");
    expect(body).toContain("required_commands:");
  });

  it("begins with exactly one lineage, run, and work-item marker", () => {
    const body = formatIssueBody(issue(), { lineageId, runId: "run-1", workItemId: "config" });

    expect(body.split("\n").slice(0, 3)).toEqual([
      `<!-- brain-hands-lineage:${lineageId} -->`,
      "<!-- brain-hands-run:run-1 -->",
      "<!-- brain-hands-work-item:config -->",
    ]);
    expect(body.match(/brain-hands-lineage:/g)).toHaveLength(1);
    expect(body.match(/brain-hands-run:/g)).toHaveLength(1);
    expect(body.match(/brain-hands-work-item:/g)).toHaveLength(1);
    expect(body).toContain("<!-- brain-hands-managed:start -->");
    expect(body).toContain("- Feature: `release-ci`");
    expect(body).toContain("- Work item: `config`");
    expect(body).toContain("- Plan revision: `2`");
    expect(body).toContain("<!-- brain-hands-managed:end -->");
  });

  it("begins parent bodies with lineage, run, and parent markers only", () => {
    const body = formatParentIssueBody(parentIssue(), { lineageId, runId: "run-1", featureSlug: "release-ci" });

    expect(body.split("\n").slice(0, 3)).toEqual([
      `<!-- brain-hands-lineage:${lineageId} -->`,
      "<!-- brain-hands-run:run-1 -->",
      "<!-- brain-hands-parent:release-ci -->",
    ]);
    expect(body.match(/brain-hands-lineage:/g)).toHaveLength(1);
    expect(body.match(/brain-hands-run:/g)).toHaveLength(1);
    expect(body.match(/brain-hands-parent:/g)).toHaveLength(1);
    expect(body).not.toContain("brain-hands-work-item:");
  });

  it("preserves user text outside the managed issue body", () => {
    const current = `${formatIssueBody(issue(), { runId: "run-1", workItemId: "config" })}\nUser notes stay here.\n`;
    const desired = formatIssueBody({ ...issue(), plan_revision: 3 }, { runId: "run-1", workItemId: "config" });

    const reconciled = reconcileManagedIssueBody(current, desired);

    expect(reconciled).toContain("- Plan revision: `3`");
    expect(reconciled).toContain("User notes stay here.");
    expect(reconciled.match(/brain-hands-managed:start/g)).toHaveLength(1);
  });

  it("renders the exact canonical v2 execution spec as JSON without YAML aliases", () => {
    const spec = executionSpec("config");
    const body = formatIssueBody(spec, { runId: "run-1", workItemId: "config" });

    expect(body).toContain("```json\n");
    expect(body).toContain(JSON.stringify(spec, null, 2));
    expect(body).not.toContain("```yaml");
    expect(body).not.toMatch(/&[a-zA-Z0-9_-]+|\*[a-zA-Z0-9_-]+/);
  });
});

describe("parseGhCreateResultNumber", () => {
  it("prefers JSON output when present", () => {
    expect(parseGhCreateResultNumber('{"number":11}')).toBe(11);
  });

  it("falls back to issue and PR URL output", () => {
    expect(parseGhCreateResultNumber("https://github.com/acme/repo/issues/77")).toBe(77);
    expect(parseGhCreateResultNumber("https://github.com/acme/repo/pull/88")).toBe(88);
  });

  it("returns null when output is unrecognized", () => {
    expect(parseGhCreateResultNumber("created successfully")).toBeNull();
  });
});

describe("GhCliGitHubAdapter", () => {
  it("exposes and caches canonical GHES repository identity", async () => {
    mockedRunCommand
      .mockResolvedValueOnce(ghSuccessResult('{"nameWithOwner":"acme/repo","url":"https://github.example/acme/repo"}\n'))
      .mockResolvedValueOnce(ghSuccessResult("brain-hands[bot]\n"));

    const adapter = new GhCliGitHubAdapter("/repo/root");
    await expect(adapter.getRepositoryIdentity()).resolves.toEqual({
      host: "github.example",
      name_with_owner: "acme/repo",
      actor: "brain-hands[bot]",
    });
    await expect(adapter.getRepositoryIdentity()).resolves.toEqual({
      host: "github.example",
      name_with_owner: "acme/repo",
      actor: "brain-hands[bot]",
    });

    expect(mockedRunCommand).toHaveBeenCalledTimes(2);
    expect(mockedRunCommand.mock.calls[1]?.[0].args).toEqual(["api", "--hostname", "github.example", "user", "--jq", ".login"]);
  });

  it("uses the resolved GHES host and authenticated actor for owned status comments", async () => {
    mockedRunCommand
      .mockResolvedValueOnce(ghSuccessResult('{"nameWithOwner":"acme/repo","url":"https://github.example/acme/repo"}\n'))
      .mockResolvedValueOnce(ghSuccessResult("brain-hands[bot]\n"))
      .mockResolvedValueOnce(ghSuccessResult(JSON.stringify([[
        { id: 91, body: "<!-- brain-hands:status run=run-1 work-item=item schema=1 -->\nbody", user: { login: "brain-hands[bot]" } },
      ]])));

    const adapter = new GhCliGitHubAdapter("/repo/root");
    await expect(adapter.findStatusCommentByMarker!({ kind: "issue", number: 7 }, "<!-- brain-hands:status run=run-1 work-item=item schema=1 -->"))
      .resolves.toEqual({ id: 91, body: expect.stringContaining("run=run-1"), authorLogin: "brain-hands[bot]" });

    expect(mockedRunCommand.mock.calls[1]?.[0].args).toEqual(["api", "--hostname", "github.example", "user", "--jq", ".login"]);
    expect(mockedRunCommand.mock.calls[2]?.[0].args).toContain("--hostname");
    expect(mockedRunCommand.mock.calls[2]?.[0].args).toContain("github.example");
  });

  it("refuses foreign or duplicate status markers", async () => {
    mockedRunCommand
      .mockResolvedValueOnce(ghSuccessResult('{"nameWithOwner":"acme/repo","url":"https://github.com/acme/repo"}\n'))
      .mockResolvedValueOnce(ghSuccessResult("brain-hands[bot]\n"))
      .mockResolvedValueOnce(ghSuccessResult(JSON.stringify([[
        { id: 91, body: "<!-- brain-hands:status run=run-1 work-item=item schema=1 -->\nbody", user: { login: "someone" } },
      ]])));

    const adapter = new GhCliGitHubAdapter("/repo/root");
    await expect(adapter.findStatusCommentByMarker!({ kind: "issue", number: 7 }, "<!-- brain-hands:status run=run-1 work-item=item schema=1 -->"))
      .rejects.toBeInstanceOf(StatusCommentOwnershipConflictError);
  });

  it("refuses an otherwise owned marker-only comment as malformed", async () => {
    const marker = "<!-- brain-hands:status run=run-1 work-item=item schema=1 -->";
    mockedRunCommand
      .mockResolvedValueOnce(ghSuccessResult('{"nameWithOwner":"acme/repo","url":"https://github.com/acme/repo"}\n'))
      .mockResolvedValueOnce(ghSuccessResult("brain-hands[bot]\n"))
      .mockResolvedValueOnce(ghSuccessResult(JSON.stringify([[
        { id: 91, body: marker, user: { login: "brain-hands[bot]" } },
      ]])));

    const adapter = new GhCliGitHubAdapter("/repo/root");
    await expect(adapter.findStatusCommentByMarker!({ kind: "issue", number: 7 }, marker))
      .rejects.toBeInstanceOf(StatusCommentOwnershipConflictError);
  });

  it("reconciles the exact managed state set through the resolved GHES repository and preserves unrelated labels", async () => {
    mockedRunCommand
      .mockResolvedValueOnce(ghSuccessResult('{"nameWithOwner":"acme/repo","url":"https://github.example/acme/repo"}\n'))
      .mockResolvedValueOnce(ghSuccessResult("brain-hands[bot]\n"))
      .mockResolvedValueOnce(ghSuccessResult(JSON.stringify({
        number: 7, title: "Issue", body: "body", state: "CLOSED", stateReason: "COMPLETED",
        labels: [{ name: "Brain-Hands:Ready" }, { name: "unmanaged" }],
      })))
      .mockResolvedValueOnce(ghSuccessResult(JSON.stringify([{ name: "brain-hands:ready" }, { name: "BRAIN-HANDS:COMPLETE" }])) )
      .mockResolvedValueOnce(ghSuccessResult(""))
      .mockResolvedValueOnce(ghSuccessResult(JSON.stringify({
        number: 7, title: "Issue", body: "body", state: "CLOSED", stateReason: "COMPLETED",
        labels: [{ name: "unmanaged" }, { name: "BRAIN-HANDS:COMPLETE" }],
      })));

    const adapter = new GhCliGitHubAdapter("/repo/root");
    await expect(adapter.reconcileIssueStateLabel!(7, "brain-hands:complete")).resolves.toBeUndefined();

    for (const call of mockedRunCommand.mock.calls.slice(2)) {
      expect(call[0].args).toContain("--repo");
      expect(call[0].args).toContain("github.example/acme/repo");
    }
    expect(mockedRunCommand.mock.calls[4]?.[0].args).toEqual(expect.arrayContaining([
      "--remove-label", "Brain-Hands:Ready", "--add-label", "brain-hands:complete",
    ]));
    expect(mockedRunCommand.mock.calls[4]?.[0].args).not.toContain("unmanaged");
  });

  it("fails closed without mutating when the required managed label is missing", async () => {
    mockedRunCommand
      .mockResolvedValueOnce(ghSuccessResult('{"nameWithOwner":"acme/repo","url":"https://github.com/acme/repo"}\n'))
      .mockResolvedValueOnce(ghSuccessResult("operator\n"))
      .mockResolvedValueOnce(ghSuccessResult(JSON.stringify({
        number: 7, title: "Issue", body: "body", state: "OPEN", stateReason: null,
        labels: [{ name: "brain-hands:blocked" }],
      })))
      .mockResolvedValueOnce(ghSuccessResult(JSON.stringify([{ name: "brain-hands:blocked" }])));

    const adapter = new GhCliGitHubAdapter("/repo/root");
    await expect(adapter.reconcileIssueStateLabel!(7, "brain-hands:reviewing")).rejects.toThrow("not provisioned");
    expect(mockedRunCommand.mock.calls.some((call) => call[0].args.includes("create"))).toBe(false);
    expect(mockedRunCommand.mock.calls.some((call) => call[0].args.includes("edit"))).toBe(false);
  });

  it("recovers a lost label-edit response only after exact authoritative readback", async () => {
    mockedRunCommand
      .mockResolvedValueOnce(ghSuccessResult('{"nameWithOwner":"acme/repo","url":"https://github.com/acme/repo"}\n'))
      .mockResolvedValueOnce(ghSuccessResult("operator\n"))
      .mockResolvedValueOnce(ghSuccessResult(JSON.stringify({
        number: 7, title: "Issue", body: "body", state: "OPEN", stateReason: null,
        labels: [{ name: "brain-hands:blocked" }, { name: "unrelated" }],
      })))
      .mockResolvedValueOnce(ghSuccessResult(JSON.stringify([{ name: "brain-hands:blocked" }, { name: "brain-hands:reviewing" }])) )
      .mockResolvedValueOnce({ ...ghSuccessResult(""), exitCode: 1, stderr: "connection lost" })
      .mockResolvedValueOnce(ghSuccessResult(JSON.stringify({
        number: 7, title: "Issue", body: "body", state: "OPEN", stateReason: null,
        labels: [{ name: "unrelated" }, { name: "brain-hands:reviewing" }],
      })));

    const adapter = new GhCliGitHubAdapter("/repo/root");
    await expect(adapter.reconcileIssueStateLabel!(7, "brain-hands:reviewing")).resolves.toBeUndefined();
    expect(mockedRunCommand).toHaveBeenCalledTimes(6);
  });

  it("retains dry-run comment state across marker lookup and update", async () => {
    const adapter = new DryRunGitHubAdapter();
    const target = { kind: "issue" as const, number: 1 };
    const marker = "<!-- brain-hands:status run=run-1 work-item=item schema=1 -->";
    const created = await adapter.createStatusComment!(target, `${marker}\nfirst`);
    await adapter.updateStatusComment!(created.id, `${marker}\nsecond`);
    await expect(adapter.findStatusCommentByMarker!(target, marker)).resolves.toEqual({
      id: created.id,
      body: `${marker}\nsecond`,
      authorLogin: "brain-hands-dry-run",
    });
  });

  it("creates one managed run-status comment and skips an unchanged replay", async () => {
    const marker = "<!-- brain-hands-run-status:run-1 -->";
    const body = `${marker}\n## Run status\n\nProgressing automatically`;
    mockedRunCommand
      .mockResolvedValueOnce(ghSuccessResult(JSON.stringify([[]])))
      .mockResolvedValueOnce(ghSuccessResult("{}"));

    const adapter = new GhCliGitHubAdapter("/repo/root");
    await adapter.upsertRunStatus!({ kind: "issue", number: 11 }, marker, body);
    expect(mockedRunCommand.mock.calls[1]?.[0].args).toEqual([
      "api", "--method", "POST", "repos/{owner}/{repo}/issues/11/comments", "-f", `body=${body}`,
    ]);

    mockedRunCommand.mockReset();
    mockedRunCommand.mockResolvedValueOnce(ghSuccessResult(JSON.stringify([[{ id: 91, body }]])));
    await adapter.upsertRunStatus!({ kind: "issue", number: 11 }, marker, body);
    expect(mockedRunCommand).toHaveBeenCalledTimes(1);
  });

  it("updates only the exact marker-keyed run-status comment", async () => {
    const marker = "<!-- brain-hands-run-status:run-1 -->";
    const body = `${marker}\n## Run status\n\nDelivered`;
    mockedRunCommand
      .mockResolvedValueOnce(ghSuccessResult(JSON.stringify([[
        { id: 8, body: `Human context quoting ${marker} must remain untouched` },
        { id: 9, body: `${marker}\nold managed status` },
      ]])))
      .mockResolvedValueOnce(ghSuccessResult("{}"));

    await new GhCliGitHubAdapter("/repo/root").upsertRunStatus!(
      { kind: "pull_request", number: 12 }, marker, body,
    );
    expect(mockedRunCommand).toHaveBeenCalledTimes(2);
    expect(mockedRunCommand.mock.calls[1]?.[0].args).toEqual([
      "api", "--method", "PATCH", "repos/{owner}/{repo}/issues/comments/9", "-f", `body=${body}`,
    ]);
  });

  it("canonically keeps the lowest managed comment id and removes duplicates across pages", async () => {
    const marker = "<!-- brain-hands-run-status:run-1 -->";
    const body = `${marker}\n## Run status\n\nDelivered`;
    mockedRunCommand.mockResolvedValueOnce({
      ...ghSuccessResult(JSON.stringify([
        [{ id: 21, body: `${marker}\nstale second page` }],
        [{ id: 9, body }, { id: 5, body: `${marker}\nstale canonical` }],
      ])), args: [],
    }).mockResolvedValue({ ...ghSuccessResult("{}"), args: [] });

    await new GhCliGitHubAdapter("/repo/root").upsertRunStatus({ kind: "issue", number: 11 }, marker, body);

    expect(mockedRunCommand).toHaveBeenNthCalledWith(2, expect.objectContaining({
      args: ["api", "--method", "PATCH", "repos/{owner}/{repo}/issues/comments/5", "-f", `body=${body}`],
    }));
    expect(mockedRunCommand).toHaveBeenNthCalledWith(3, expect.objectContaining({
      args: ["api", "--method", "DELETE", "repos/{owner}/{repo}/issues/comments/9"],
    }));
    expect(mockedRunCommand).toHaveBeenNthCalledWith(4, expect.objectContaining({
      args: ["api", "--method", "DELETE", "repos/{owner}/{repo}/issues/comments/21"],
    }));
  });

  it("replays duplicate cleanup after a partial delete failure", async () => {
    const marker = "<!-- brain-hands-run-status:run-1 -->";
    const body = `${marker}\ncurrent`;
    mockedRunCommand.mockResolvedValueOnce({
      ...ghSuccessResult(JSON.stringify([[{ id: 4, body }, { id: 7, body: `${marker}\nstale` }]])), args: [],
    }).mockResolvedValueOnce({ ...ghSuccessResult(""), exitCode: 1, stderr: "temporary", args: [] });
    const adapter = new GhCliGitHubAdapter("/repo/root");
    await expect(adapter.upsertRunStatus({ kind: "issue", number: 11 }, marker, body)).rejects.toThrow("remove duplicate");

    mockedRunCommand.mockReset();
    mockedRunCommand.mockResolvedValueOnce({
      ...ghSuccessResult(JSON.stringify([[{ id: 4, body }, { id: 7, body: `${marker}\nstale` }]])), args: [],
    }).mockResolvedValueOnce({ ...ghSuccessResult("{}"), args: [] });
    await adapter.upsertRunStatus({ kind: "issue", number: 11 }, marker, body);
    expect(mockedRunCommand).toHaveBeenCalledTimes(2);
  });

  it("builds issue create command with stable labels and parses URL output", async () => {
    const body = formatIssueBody(issue());
    const expectedArgs = [
      "issue",
      "create",
      "--title",
      issue().goal,
      "--body",
      body,
      "--label",
      ISSUE_LABELS,
    ];
    mockedRunCommand.mockResolvedValue({
      ...ghSuccessResult("https://github.com/acme/repo/issues/11"),
      args: expectedArgs,
    });

    const adapter = new GhCliGitHubAdapter("/repo/root");
    const number = await adapter.createIssue(issue());

    expect(mockedRunCommand).toHaveBeenCalledWith({
      command: "gh",
      args: expectedArgs,
      cwd: "/repo/root",
      timeoutMs: 60_000,
    });
    expect(number).toBe(11);
  });

  it("preserves stable markers when refreshing an existing v2 issue", async () => {
    const spec = executionSpec("config");
    const marker = { runId: "run-1", workItemId: "config" };
    mockedRunCommand.mockResolvedValue({
      ...ghSuccessResult(""),
      args: [],
    });

    const adapter = new GhCliGitHubAdapter("/repo/root");
    await adapter.updateIssue(11, spec, marker);

    expect(mockedRunCommand).toHaveBeenCalledWith(expect.objectContaining({
      command: "gh",
      args: [
        "issue",
        "edit",
        "11",
        "--title",
        spec.title,
        "--body",
        formatIssueBody(spec, marker),
      ],
    }));
  });

  it("builds pull request create command and extracts PR number", async () => {
    const expectedArgs = [
      "pr",
      "create",
      "--title",
      "Fix bug",
      "--body",
      "body",
      "--head",
      "brain-hands/issue-1-fix-bug",
      "--base",
      "main",
    ];
    mockedRunCommand.mockResolvedValue({
      ...ghSuccessResult("https://github.com/acme/repo/pull/22"),
      args: expectedArgs,
    });

    const adapter = new GhCliGitHubAdapter("/repo/root");
    const number = await adapter.openPullRequest({
      title: "Fix bug",
      body: "body",
      head: "brain-hands/issue-1-fix-bug",
      base: "main",
    });

    expect(mockedRunCommand).toHaveBeenCalledWith({
      command: "gh",
      args: expectedArgs,
      cwd: "/repo/root",
      timeoutMs: 60_000,
    });
    expect(number).toBe(22);
  });

  it("continues to parse JSON output for compatibility with custom wrappers", async () => {
    const expectedArgs = [
      "issue",
      "create",
      "--title",
      issue().goal,
      "--body",
      formatIssueBody(issue()),
      "--label",
      ISSUE_LABELS,
    ];
    mockedRunCommand.mockResolvedValue({
      ...ghSuccessResult('{"number":42}'),
      args: expectedArgs,
    });

    const adapter = new GhCliGitHubAdapter("/repo/root");
    const number = await adapter.createIssue(issue());

    expect(number).toBe(42);
  });

  it("updates the generated title and managed body while preserving user notes", async () => {
    const marker = { runId: "run-1", workItemId: "config" };
    const currentBody = `${formatIssueBody(issue(), marker)}\nUser notes stay here.\n`;
    const updatedIssue = { ...issue(), title: "[release-ci:config] Harden config", plan_revision: 3 };
    const desiredBody = formatIssueBody(updatedIssue, marker);
    const reconciledBody = reconcileManagedIssueBody(currentBody, desiredBody);
    const expectedArgs = [
      "issue", "edit", "14", "--title", updatedIssue.title, "--body", reconciledBody,
    ];
    mockedRunCommand.mockResolvedValue({ ...ghSuccessResult(""), args: expectedArgs });

    const adapter = new GhCliGitHubAdapter("/repo/root");
    await adapter.updateIssue(14, updatedIssue, marker, currentBody, updatedIssue.title);

    expect(mockedRunCommand).toHaveBeenCalledWith({
      command: "gh",
      args: expectedArgs,
      cwd: "/repo/root",
      timeoutMs: 60_000,
    });
    expect(reconciledBody).toContain("User notes stay here.");
    expect(reconciledBody).toContain("- Plan revision: `3`");
  });

  it("creates, finds, and updates a marked parent issue", async () => {
    const marker = { lineageId, runId: "run-1", featureSlug: "release-ci" };
    const body = formatParentIssueBody(parentIssue(), marker);
    const currentBody = `${body}\nUser parent notes stay here.\n`;
    const reconciledBody = reconcileManagedIssueBody(currentBody, body);
    mockedRunCommand
      .mockResolvedValueOnce({ ...ghSuccessResult("https://github.com/acme/repo/issues/9"), args: [] })
      .mockResolvedValueOnce(ghSuccessResult('{"nameWithOwner":"acme/repo","url":"https://github.com/acme/repo"}'))
      .mockResolvedValueOnce(ghSuccessResult("actor\n"))
      .mockResolvedValueOnce({ ...ghSuccessResult(JSON.stringify([[
        { number: 9, title: parentIssue().title, body, state: "open", state_reason: null, labels: [{ name: "brain-hands" }] },
      ]])), args: [] })
      .mockResolvedValueOnce({ ...ghSuccessResult(""), args: [] });
    const adapter = new GhCliGitHubAdapter("/repo/root");

    await expect(adapter.createParentIssue(parentIssue(), marker)).resolves.toBe(9);
    await expect(adapter.findParentIssueByMarker(marker)).resolves.toEqual({ number: 9, title: parentIssue().title, body });
    await adapter.updateParentIssue(9, parentIssue(), marker, currentBody);

    expect(mockedRunCommand.mock.calls[0]?.[0].args).toEqual(["issue", "create", "--title", parentIssue().title, "--body", body, "--label", PARENT_ISSUE_LABELS]);
    expect(PARENT_ISSUE_LABELS).not.toContain("hands:ready");
    expect(PARENT_ISSUE_LABELS).not.toContain("verification:required");
    expect(mockedRunCommand.mock.calls[3]?.[0].args).toEqual([
      "api", "--hostname", "github.com", "--paginate", "--slurp",
      "repos/acme/repo/issues?state=all&per_page=100",
    ]);
    expect(mockedRunCommand.mock.calls[4]?.[0].args).toEqual(["issue", "edit", "9", "--title", parentIssue().title, "--body", reconciledBody]);
    expect(body).toContain("- [ ] #14 `config`");
    expect(reconciledBody).toContain("User parent notes stay here.");
  });

  it("preserves runCommand metadata on null exit code failures", async () => {
    mockedRunCommand.mockResolvedValue({
      command: "gh",
      args: [
        "pr",
        "create",
        "--title",
        "Fix bug",
        "--body",
        "body",
        "--head",
        "brain-hands/issue-1-fix-bug",
        "--base",
        "main",
      ],
      exitCode: null,
      stdout: "",
      stderr: "",
      failed: true,
      timedOut: true,
      errorCode: "ETIMEDOUT",
      errorMessage: "timed out",
      signal: "SIGTERM",
    });

    const adapter = new GhCliGitHubAdapter("/repo/root");

    await expect(
      adapter.openPullRequest({
        title: "Fix bug",
        body: "body",
        head: "brain-hands/issue-1-fix-bug",
        base: "main",
      }),
    ).rejects.toMatchObject({
      exitCode: null,
      timedOut: true,
      errorCode: "ETIMEDOUT",
      signal: "SIGTERM",
      command: "gh",
      args: [
        "pr",
        "create",
        "--title",
        "Fix bug",
        "--body",
        "body",
        "--head",
        "brain-hands/issue-1-fix-bug",
        "--base",
        "main",
      ],
    });
  });

  it("finds every lineage-owned issue across pages, filters PR entries, and sorts owned material", async () => {
    const marker = { lineageId, runId: "run-1", workItemId: "config" };
    const body = formatIssueBody(issue(), marker);
    mockedRunCommand
      .mockResolvedValueOnce(ghSuccessResult('{"nameWithOwner":"acme/repo","url":"https://github.example/acme/repo"}'))
      .mockResolvedValueOnce(ghSuccessResult("brain-hands[bot]\n"))
      .mockResolvedValueOnce(ghSuccessResult(JSON.stringify([
        [
          { number: 22, title: "Second", body, state: "closed", state_reason: "not_planned", labels: [{ name: "zeta" }, { name: "alpha" }], updated_at: "2026-07-16T12:00:00Z" },
          { number: 18, title: "PR-shaped issue", body, state: "open", state_reason: null, labels: [], pull_request: { url: "https://api.github.example/repos/acme/repo/pulls/18" } },
        ],
        [
          { number: 7, title: "First", body, state: "open", state_reason: null, labels: [{ name: "brain-hands" }], updated_at: "2026-07-16T13:00:00Z" },
          { number: 3, title: "Other lineage", body: body.replace(lineageId, "946c7414-d500-4e65-a596-dcf99f0015c3"), state: "open", state_reason: null, labels: [] },
        ],
      ])));

    const adapter = new GhCliGitHubAdapter("/repo/root");
    await expect(adapter.findIssuesByMarker(marker)).resolves.toEqual([
      { number: 7, title: "First", body, state: "OPEN", state_reason: null, labels: ["brain-hands"] },
      { number: 22, title: "Second", body, state: "CLOSED", state_reason: "NOT_PLANNED", labels: ["alpha", "zeta"] },
    ]);
    expect(mockedRunCommand.mock.calls[2]?.[0].args).toEqual([
      "api", "--hostname", "github.example", "--paginate", "--slurp",
      "repos/acme/repo/issues?state=all&per_page=100",
    ]);
  });

  it("legacy all-match lookup exposes current-lineage, different-lineage, and legacy candidates", async () => {
    const lineageBody = formatIssueBody(issue(), { lineageId, runId: "run-1", workItemId: "config" });
    const otherLineageBody = formatIssueBody(issue(), { lineageId: "946c7414-d500-4e65-a596-dcf99f0015c3", runId: "run-1", workItemId: "config" });
    const legacyBody = formatIssueBody(issue(), { runId: "run-1", workItemId: "config" });
    mockedRunCommand
      .mockResolvedValueOnce(ghSuccessResult('{"nameWithOwner":"acme/repo","url":"https://github.com/acme/repo"}'))
      .mockResolvedValueOnce(ghSuccessResult("actor\n"))
      .mockResolvedValueOnce(ghSuccessResult(JSON.stringify([[
        { number: 7, title: "Lineage", body: lineageBody, state: "open", state_reason: null, labels: [] },
        { number: 8, title: "Legacy", body: legacyBody, state: "open", state_reason: null, labels: [] },
        { number: 9, title: "Other lineage", body: otherLineageBody, state: "open", state_reason: null, labels: [] },
      ]])));

    await expect(new GhCliGitHubAdapter("/repo/root").findIssuesByMarker(
      { runId: "run-1", workItemId: "config" },
    )).resolves.toEqual([
      { number: 7, title: "Lineage", body: lineageBody, state: "OPEN", state_reason: null, labels: [] },
      { number: 8, title: "Legacy", body: legacyBody, state: "OPEN", state_reason: null, labels: [] },
      { number: 9, title: "Other lineage", body: otherLineageBody, state: "OPEN", state_reason: null, labels: [] },
    ]);
  });

  it("makes legacy find-one issue lookup fail on ambiguous ownership", async () => {
    const marker = { lineageId, runId: "run-1", workItemId: "config" };
    const body = formatIssueBody(issue(), marker);
    mockedRunCommand
      .mockResolvedValueOnce(ghSuccessResult('{"nameWithOwner":"acme/repo","url":"https://github.com/acme/repo"}'))
      .mockResolvedValueOnce(ghSuccessResult("actor\n"))
      .mockResolvedValueOnce(ghSuccessResult(JSON.stringify([[
        { number: 2, title: "Second", body, state: "open", state_reason: null, labels: [] },
        { number: 1, title: "First", body, state: "open", state_reason: null, labels: [] },
      ]])));

    await expect(new GhCliGitHubAdapter("/repo/root").findIssueByMarker(marker))
      .rejects.toThrow(/multiple.*issues.*marker|ambiguous/i);
  });

  it("finds parent issues by lineage and target marker", async () => {
    const marker = { lineageId, runId: "run-1", featureSlug: "release-ci" };
    const body = formatParentIssueBody(parentIssue(), marker);
    mockedRunCommand
      .mockResolvedValueOnce(ghSuccessResult('{"nameWithOwner":"acme/repo","url":"https://github.com/acme/repo"}'))
      .mockResolvedValueOnce(ghSuccessResult("actor\n"))
      .mockResolvedValueOnce(ghSuccessResult(JSON.stringify([[
        { number: 9, title: parentIssue().title, body, state: "open", state_reason: null, labels: [{ name: "brain-hands" }] },
      ]])));

    await expect(new GhCliGitHubAdapter("/repo/root").findParentIssuesByMarker(marker)).resolves.toEqual([
      { number: 9, title: parentIssue().title, body, state: "OPEN", state_reason: null, labels: ["brain-hands"] },
    ]);
  });

  it("finds all lineage-owned pull requests and normalizes open, closed, and merged state", async () => {
    const ownedBody = `Human summary\n\n<!-- brain-hands:issue-links lineage=${lineageId} run=run-1 schema=1 -->\nCloses #14\n<!-- /brain-hands:issue-links -->\n\nHuman footer stays unchanged.`;
    mockedRunCommand
      .mockResolvedValueOnce(ghSuccessResult('{"nameWithOwner":"acme/repo","url":"https://github.example/acme/repo"}'))
      .mockResolvedValueOnce(ghSuccessResult("actor\n"))
      .mockResolvedValueOnce(ghSuccessResult(JSON.stringify([
        [
          { number: 30, html_url: "https://github.example/acme/repo/pull/30", title: "Task: ship", body: ownedBody, state: "closed", merged_at: "2026-07-16T12:00:00Z", head: { ref: "feature", sha: "ABC123" }, base: { ref: "main" } },
          { number: 20, html_url: "https://github.example/acme/repo/pull/20", title: "Task: ship", body: ownedBody, state: "closed", merged_at: null, head: { ref: "feature", sha: "DEF456" }, base: { ref: "main" } },
        ],
        [
          { number: 10, html_url: "https://github.example/acme/repo/pull/10", title: "Task: ship", body: ownedBody, state: "open", merged_at: null, head: { ref: "feature", sha: "FEDCBA" }, base: { ref: "main" } },
          { number: 5, html_url: "https://github.example/acme/repo/pull/5", title: "Other", body: "Unowned", state: "open", merged_at: null, head: { ref: "other", sha: "123456" }, base: { ref: "main" } },
        ],
      ])));

    await expect(new GhCliGitHubAdapter("/repo/root").findPullRequestsByLineage(lineageId)).resolves.toEqual([
      { number: 10, url: "https://github.example/acme/repo/pull/10", title: "Task: ship", head_ref: "feature", head_sha: "fedcba", base_ref: "main", body: ownedBody, closing_issue_numbers: [14], state: "OPEN" },
      { number: 20, url: "https://github.example/acme/repo/pull/20", title: "Task: ship", head_ref: "feature", head_sha: "def456", base_ref: "main", body: ownedBody, closing_issue_numbers: [14], state: "CLOSED" },
      { number: 30, url: "https://github.example/acme/repo/pull/30", title: "Task: ship", head_ref: "feature", head_sha: "abc123", base_ref: "main", body: ownedBody, closing_issue_numbers: [14], state: "MERGED" },
    ]);
    expect(mockedRunCommand.mock.calls[2]?.[0].args).toEqual([
      "api", "--hostname", "github.example", "--paginate", "--slurp",
      "repos/acme/repo/pulls?state=all&per_page=100",
    ]);
  });

  it.each([
    [
      "an end marker before the start marker",
      `<!-- /brain-hands:issue-links -->\n<!-- brain-hands:issue-links lineage=${lineageId} run=run-1 schema=1 -->`,
    ],
    [
      "a stray unsupported-schema start token",
      `<!-- brain-hands:issue-links lineage=${lineageId} run=run-1 schema=1 -->\n<!-- /brain-hands:issue-links -->\n<!-- brain-hands:issue-links lineage=${lineageId} run=run-2 schema=2 -->`,
    ],
    [
      "a stray malformed ownership token",
      `<!-- brain-hands:issue-links lineage=${lineageId} run=run-1 schema=1 -->\n<!-- /brain-hands:issue-links -->\n<!-- brain-hands:issue-links lineage=${lineageId}`,
    ],
    [
      "duplicate starts",
      `<!-- brain-hands:issue-links lineage=${lineageId} run=run-1 schema=1 -->\n<!-- brain-hands:issue-links lineage=${lineageId} run=run-2 schema=1 -->\n<!-- /brain-hands:issue-links -->`,
    ],
    [
      "duplicate ends",
      `<!-- brain-hands:issue-links lineage=${lineageId} run=run-1 schema=1 -->\n<!-- /brain-hands:issue-links -->\n<!-- /brain-hands:issue-links -->`,
    ],
  ])("rejects pull request ownership with %s", async (_label, body) => {
    mockedRunCommand
      .mockResolvedValueOnce(ghSuccessResult('{"nameWithOwner":"acme/repo","url":"https://github.example/acme/repo"}'))
      .mockResolvedValueOnce(ghSuccessResult("actor\n"))
      .mockResolvedValueOnce(ghSuccessResult(JSON.stringify([[
        { number: 10, html_url: "https://github.example/acme/repo/pull/10", body, state: "open", merged_at: null, head: { ref: "feature", sha: "ABC123" }, base: { ref: "main" } },
      ]])));

    await expect(new GhCliGitHubAdapter("/repo/root").findPullRequestsByLineage(lineageId))
      .rejects.toThrow(/ownership|marker|managed|duplicate|malformed|mixed/i);
  });

  it("opens an integrated PR with exact issue closing relations", async () => {
    const expectedArgs = [
      "pr", "create", "--title", "Task: Build CLI", "--body",
      [
        "Summary",
        "",
        "<!-- brain-hands:issue-links run=run-1 schema=1 -->",
        "Closes #14",
        "Closes #15",
        "<!-- /brain-hands:issue-links -->",
      ].join("\n"), "--head", "codex/run-1", "--base", "main",
    ];
    mockedRunCommand.mockResolvedValue({ ...ghSuccessResult("https://github.com/acme/repo/pull/33"), args: expectedArgs });
    const adapter = new GhCliGitHubAdapter("/repo/root");
    const result = await adapter.openIntegratedPullRequest({
      runId: "run-1", title: "Task: Build CLI", summary: "Summary", head: "codex/run-1", base: "main",
      workItems: [{ id: "config", issueNumber: 14 }, { id: "second", issueNumber: 15 }],
    });
    expect(result).toEqual({ number: 33, url: "https://github.com/acme/repo/pull/33" });
    expect(mockedRunCommand).toHaveBeenCalledWith({ command: "gh", args: expectedArgs, cwd: "/repo/root", timeoutMs: 60_000 });
  });

  it("links an optional parent before its child issues", async () => {
    const expectedBody = [
      "Summary",
      "",
      "<!-- brain-hands:issue-links run=run-1 schema=1 -->",
      "Closes #9",
      "Closes #14",
      "<!-- /brain-hands:issue-links -->",
    ].join("\n");
    mockedRunCommand.mockResolvedValue({ ...ghSuccessResult("https://github.com/acme/repo/pull/33"), args: [] });
    const adapter = new GhCliGitHubAdapter("/repo/root");
    await adapter.openIntegratedPullRequest({
      runId: "run-1", title: "Task: Build CLI", summary: "Summary", head: "codex/run-1", base: "main",
      parentIssueNumber: 9, workItems: [{ id: "config", issueNumber: 14 }],
    });
    expect(mockedRunCommand.mock.calls[0]?.[0].args).toContain(expectedBody);
  });

  it("reads the repository default branch", async () => {
    mockedRunCommand.mockResolvedValue(ghSuccessResult(JSON.stringify({ defaultBranchRef: { name: "trunk" } })));
    const adapter = new GhCliGitHubAdapter("/repo/root");

    await expect(adapter.getDefaultBranch()).resolves.toBe("trunk");
    expect(mockedRunCommand.mock.calls[0]?.[0].args).toEqual(["repo", "view", "--json", "defaultBranchRef"]);
  });

  it("reads a pull request with parsed closing references", async () => {
    mockedRunCommand.mockResolvedValue(ghSuccessResult(JSON.stringify({
      number: 33,
      url: "https://github.com/acme/repo/pull/33",
      title: "Task: ship",
      headRefName: "codex/run-1",
      headRefOid: "ABC123",
      baseRefName: "main",
      state: "OPEN",
      body: "Summary",
      closingIssuesReferences: [{ number: 14 }, { number: 15 }],
    })));
    const adapter = new GhCliGitHubAdapter("/repo/root");

    await expect(adapter.getPullRequest(33)).resolves.toEqual({
      number: 33,
      url: "https://github.com/acme/repo/pull/33",
      title: "Task: ship",
      head_ref: "codex/run-1",
      head_sha: "abc123",
      base_ref: "main",
      state: "OPEN",
      body: "Summary",
      closing_issue_numbers: [14, 15],
    });
  });

  it("maps only an authoritative missing pull request response to null", async () => {
    mockedRunCommand.mockResolvedValue({
      ...ghSuccessResult(""),
      exitCode: 1,
      failed: true,
      stderr: "GraphQL: Could not resolve to a PullRequest with the number of 33. (repository.pullRequest)",
    });

    await expect(new GhCliGitHubAdapter("/repo/root").getPullRequest(33)).resolves.toBeNull();
  });

  it("allows only surrounding whitespace around the authoritative missing response", async () => {
    mockedRunCommand.mockResolvedValue({
      ...ghSuccessResult(""),
      exitCode: 1,
      failed: true,
      stderr: "  \nGraphQL: Could not resolve to a PullRequest with the number of 33. (repository.pullRequest)\n  ",
    });

    await expect(new GhCliGitHubAdapter("/repo/root").getPullRequest(33)).resolves.toBeNull();
  });

  it.each([
    "HTTP 401: Requires authentication",
    "HTTP 403: API rate limit exceeded",
    "dial tcp: network is unreachable",
  ])("does not hide a mixed pull request lookup failure: %s", async (additionalFailure) => {
    const stderr = [
      "GraphQL: Could not resolve to a PullRequest with the number of 33. (repository.pullRequest)",
      additionalFailure,
    ].join("\n");
    mockedRunCommand.mockResolvedValue({
      ...ghSuccessResult(""),
      exitCode: 1,
      failed: true,
      stderr,
    });

    await expect(new GhCliGitHubAdapter("/repo/root").getPullRequest(33))
      .rejects.toMatchObject({ exitCode: 1, stderr });
  });

  it.each([
    "HTTP 401: Requires authentication",
    "HTTP 403: API rate limit exceeded",
    "HTTP 404: Not Found",
    "dial tcp: network is unreachable",
  ])("preserves non-authoritative pull request lookup failures: %s", async (stderr) => {
    mockedRunCommand.mockResolvedValue({
      ...ghSuccessResult(""),
      exitCode: 1,
      failed: true,
      stderr,
    });

    const rejection = new GhCliGitHubAdapter("/repo/root").getPullRequest(33);
    await expect(rejection).rejects.toMatchObject({ exitCode: 1, stderr });
  });

  it("keeps malformed successful pull request responses distinct from command failure", async () => {
    mockedRunCommand.mockResolvedValue(ghSuccessResult("not-json"));

    const rejection = new GhCliGitHubAdapter("/repo/root").getPullRequest(33);
    await expect(rejection).rejects.toThrow(/parse pull request response/i);
    await expect(rejection).rejects.not.toHaveProperty("exitCode");
  });

  it("fails closed when GitHub omits parsed closing-reference metadata", async () => {
    mockedRunCommand.mockResolvedValue(ghSuccessResult(JSON.stringify({
      number: 33,
      url: "https://github.com/acme/repo/pull/33",
      title: "Task: ship",
      headRefName: "codex/run-1",
      headRefOid: "ABC123",
      baseRefName: "main",
      state: "OPEN",
      body: "Summary",
    })));

    await expect(new GhCliGitHubAdapter("/repo/root").getPullRequest(33))
      .rejects.toThrow(/closing issue references/i);
  });

  it("updates only the requested pull request body", async () => {
    mockedRunCommand.mockResolvedValue(ghSuccessResult(""));
    const adapter = new GhCliGitHubAdapter("/repo/root");

    await adapter.updatePullRequestBody(33, "Updated body");
    expect(mockedRunCommand.mock.calls[0]?.[0].args).toEqual(["pr", "edit", "33", "--body", "Updated body"]);
  });

  it("reads an issue state and closure reason", async () => {
    mockedRunCommand
      .mockResolvedValueOnce(ghSuccessResult('{"nameWithOwner":"acme/repo","url":"https://github.example/acme/repo"}\n'))
      .mockResolvedValueOnce(ghSuccessResult("operator\n"))
      .mockResolvedValueOnce(ghSuccessResult(JSON.stringify({
        number: 14,
        title: "Config",
        body: "<!-- brain-hands-run:run-1 -->",
        state: "CLOSED",
        stateReason: "COMPLETED",
        labels: [{ name: "brain-hands:complete" }, { name: "brain-hands" }],
      })));
    const adapter = new GhCliGitHubAdapter("/repo/root");

    await expect(adapter.getIssue(14)).resolves.toEqual({
      number: 14,
      title: "Config",
      body: "<!-- brain-hands-run:run-1 -->",
      state: "CLOSED",
      state_reason: "COMPLETED",
      labels: ["brain-hands", "brain-hands:complete"],
    });
    expect(mockedRunCommand.mock.calls[2]?.[0].args).toContain("github.example/acme/repo");
  });

  it("edits terminal labels without creating missing labels implicitly", async () => {
    mockedRunCommand
      .mockResolvedValueOnce(ghSuccessResult('{"nameWithOwner":"acme/repo","url":"https://github.com/acme/repo"}\n'))
      .mockResolvedValueOnce(ghSuccessResult("operator\n"))
      .mockResolvedValueOnce(ghSuccessResult(""));
    const adapter = new GhCliGitHubAdapter("/repo/root");

    await adapter.updateIssueLabels!(14, {
      remove: ["brain-hands:ready", "brain-hands:complete"],
      add: ["brain-hands:not-planned"],
    });

    expect(mockedRunCommand.mock.calls[2]?.[0].args).toEqual([
      "issue", "edit", "14", "--repo", "github.com/acme/repo",
      "--remove-label", "brain-hands:ready", "--remove-label", "brain-hands:complete",
      "--add-label", "brain-hands:not-planned",
    ]);
    expect(mockedRunCommand.mock.calls.some((call) => call[0].args.includes("label") && call[0].args.includes("create"))).toBe(false);
  });

  it.each([
    ["completed", "completed"],
    ["not_planned", "not planned"],
  ] as const)("closes an issue with the %s reason", async (reason, commandReason) => {
    mockedRunCommand.mockResolvedValue(ghSuccessResult(""));
    const adapter = new GhCliGitHubAdapter("/repo/root");

    await adapter.closeIssue(14, reason);
    expect(mockedRunCommand.mock.calls[0]?.[0].args).toEqual(["issue", "close", "14", "--reason", commandReason]);
  });
});

describe("DryRunGitHubAdapter", () => {
  it("allocates deterministic issue and PR numbers", async () => {
    const adapter = new DryRunGitHubAdapter();

    const issueNumber = await adapter.createIssue(issue());
    const prNumber = await adapter.openPullRequest({
      title: "Issue 1",
      body: "body",
      head: "brain-hands/issue-1",
      base: "main",
    });

    expect(issueNumber).toBe(1);
    expect(prNumber).toBe(1);
  });

  it("persists created issue labels in authoritative issue state", async () => {
    const adapter = new DryRunGitHubAdapter();

    const number = await adapter.createIssue(issue());

    await expect(adapter.getIssue(number)).resolves.toMatchObject({ labels: ISSUE_LABELS.split(",") });
  });

  it("reconciles authoritative labels case-insensitively and preserves unrelated labels", async () => {
    const adapter = new DryRunGitHubAdapter();
    const number = await adapter.createIssue(issue());
    await adapter.addIssueLabels(number, ["User:Keep", "Brain-Hands:Blocked", "brain-hands:ready"]);

    await adapter.reconcileIssueStateLabel(number, "brain-hands:reviewing");

    await expect(adapter.getIssue(number)).resolves.toMatchObject({
      labels: [...ISSUE_LABELS.split(","), "User:Keep", "brain-hands:reviewing"],
    });
  });

  it("fails honestly when a fresh replay adapter has not hydrated a mapped issue", async () => {
    const producer = new DryRunGitHubAdapter();
    const number = await producer.createIssue(issue());
    const replay = new DryRunGitHubAdapter();

    await expect(replay.getIssue(number)).rejects.toThrow(`Issue ${number} does not exist`);
  });

  it("hydrates authoritative issue and pull-request observations for a fresh process", async () => {
    const issueBody = formatIssueBody(issue(), { lineageId, runId: "run-1", workItemId: "config" });
    const pullRequestBody = [
      "Summary",
      "",
      `<!-- brain-hands:issue-links lineage=${lineageId} run=run-1 schema=1 -->`,
      "Closes #14",
      "<!-- /brain-hands:issue-links -->",
    ].join("\n");
    const adapter = new DryRunGitHubAdapter({
      issues: [{ number: 14, title: "[release-ci:config] Create config", body: issueBody, state: "OPEN", state_reason: null, labels: ISSUE_LABELS.split(",") }],
      pullRequests: [{ number: 9, url: "https://github.com/dry-run/repo/pull/9", title: "Task: ship", body: pullRequestBody,
        head_ref: "brain-hands/run-1", head_sha: "a".repeat(40), base_ref: "main", closing_issue_numbers: [14], state: "OPEN" }],
    });

    await expect(adapter.findIssuesByMarker({ lineageId, runId: "run-1", workItemId: "config" }))
      .resolves.toEqual([expect.objectContaining({ number: 14, body: issueBody })]);
    await expect(adapter.findPullRequestsByLineage(lineageId))
      .resolves.toEqual([expect.objectContaining({ number: 9, body: pullRequestBody })]);
    await expect(adapter.createIssue(issue())).resolves.toBe(15);
  });
});
