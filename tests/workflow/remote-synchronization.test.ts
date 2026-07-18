import { readdir, rm, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitHubPullRequestReference } from "../../src/adapters/github.js";
import { createRunLedgerV2, readManifestV2, recordTerminalDisposition, taskLineageId, updateManifestV2 } from "../../src/core/ledger.js";
import { remoteSynchronizationEvidenceSchema } from "../../src/core/schema.js";
import {
  recordRemoteSynchronization,
  type RecordRemoteSynchronizationInput,
} from "../../src/workflow/remote-synchronization.js";

const LOCAL = "a".repeat(40);
const OTHER_A = "b".repeat(40);
const OTHER_B = "c".repeat(64);
const BRANCH = "codex/run-1";
const REMOTE = "origin";
const PR_NUMBER = 42;
const PR_URL = "https://github.com/acme/repo/pull/42";

const roots: string[] = [];

function withTamperedRunId(manifest: Record<string, any>, runId: string): Record<string, any> {
  return {
    ...manifest,
    run_id: runId,
    task_lineage: {
      ...manifest.task_lineage,
      root_run_id: runId,
      lineage_id: taskLineageId(runId),
    },
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function runInput(
  overrides: Partial<RecordRemoteSynchronizationInput> = {},
): Promise<RecordRemoteSynchronizationInput> {
  const repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-remote-sync-"));
  roots.push(repoRoot);
  const ledger = await createRunLedgerV2({
    repoRoot,
    originalRequest: "Prove remote synchronization",
    now: new Date("2026-07-16T12:00:00.000Z"),
  });
  await updateManifestV2(ledger.runDir, {
    pull_request_numbers: [PR_NUMBER],
    github_ids: {
      issue_numbers: [],
      work_item_issue_map: {},
      parent_issue_number: null,
      pull_request_numbers: [PR_NUMBER],
      pull_request_urls: { [String(PR_NUMBER)]: PR_URL },
    },
  });
  return {
    runDir: ledger.runDir,
    repoRoot,
    branchName: BRANCH,
    remoteName: REMOTE,
    pullRequestNumber: PR_NUMBER,
    expectedPullRequestUrl: PR_URL,
    github: {
      getPullRequest: async (): Promise<GitHubPullRequestReference> => ({
        number: PR_NUMBER,
        url: PR_URL,
        head_ref: BRANCH,
        head_sha: LOCAL,
        state: "OPEN",
      }),
    },
    observedAt: () => "2026-07-16T12:01:00.000Z",
    resolveLocalSha: async () => LOCAL,
    resolveRemoteSha: async () => LOCAL,
    ...overrides,
  };
}

describe("recordRemoteSynchronization", () => {
  it.each([
    ["one-sided mapping", { pull_request_numbers: [PR_NUMBER], githubPullRequestNumbers: [] }],
    ["divergent mapping", { pull_request_numbers: [PR_NUMBER], githubPullRequestNumbers: [PR_NUMBER + 1] }],
    ["duplicate mapping", { pull_request_numbers: [PR_NUMBER, PR_NUMBER], githubPullRequestNumbers: [PR_NUMBER] }],
  ])("rejects a %s before starting any lookup or writing evidence", async (_name, mapping) => {
    const input = await runInput();
    const manifestPath = join(input.runDir, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.pull_request_numbers = mapping.pull_request_numbers;
    manifest.github_ids.pull_request_numbers = mapping.githubPullRequestNumbers;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    const resolveLocalSha = vi.fn(async () => LOCAL);
    const getPullRequest = vi.fn(async () => null);
    const resolveRemoteSha = vi.fn(async () => LOCAL);

    await expect(recordRemoteSynchronization({
      ...input,
      github: { getPullRequest },
      resolveLocalSha,
      resolveRemoteSha,
    })).rejects.toThrow(/exactly one|identical pull request/i);
    expect(resolveLocalSha).not.toHaveBeenCalled();
    expect(getPullRequest).not.toHaveBeenCalled();
    expect(resolveRemoteSha).not.toHaveBeenCalled();
    expect(await readdir(join(input.runDir, "assurance"))).toEqual([]);
  });
  it("rejects tampered run lineage before starting lookups or writing evidence", async () => {
    const input = await runInput();
    const manifestPath = join(input.runDir, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    await writeFile(manifestPath, `${JSON.stringify(withTamperedRunId(manifest, "tampered-run"), null, 2)}\n`, "utf8");
    const resolveLocalSha = vi.fn(async () => LOCAL);
    const getPullRequest = vi.fn(async () => ({
      number: PR_NUMBER,
      url: PR_URL,
      head_ref: BRANCH,
      head_sha: LOCAL,
      state: "OPEN" as const,
    }));
    const resolveRemoteSha = vi.fn(async () => LOCAL);

    await expect(recordRemoteSynchronization({
      ...input,
      github: { getPullRequest },
      resolveLocalSha,
      resolveRemoteSha,
    })).rejects.toThrow(/run.*(?:identity|lineage|ledger)|(?:identity|lineage).*run/i);

    expect(resolveLocalSha).not.toHaveBeenCalled();
    expect(getPullRequest).not.toHaveBeenCalled();
    expect(resolveRemoteSha).not.toHaveBeenCalled();
    expect(await readdir(join(input.runDir, "assurance"))).toEqual([]);
    expect((await readManifestV2(input.runDir)).remote_synchronization_path).toBeNull();
  });

  it("rejects a non-canonical run ID even when it resolves to the same directory", async () => {
    const input = await runInput();
    const manifestPath = join(input.runDir, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const originalRunId = manifest.run_id as string;
    await writeFile(manifestPath, `${JSON.stringify(withTamperedRunId(manifest, `${originalRunId}/../${originalRunId}`), null, 2)}\n`, "utf8");
    const resolveLocalSha = vi.fn(async () => LOCAL);
    const getPullRequest = vi.fn(async () => null);
    const resolveRemoteSha = vi.fn(async () => LOCAL);

    await expect(recordRemoteSynchronization({
      ...input,
      github: { getPullRequest },
      resolveLocalSha,
      resolveRemoteSha,
    })).rejects.toThrow(/run.*(?:identity|lineage|canonical)|(?:identity|lineage|canonical).*run/i);
    expect(resolveLocalSha).not.toHaveBeenCalled();
    expect(getPullRequest).not.toHaveBeenCalled();
    expect(resolveRemoteSha).not.toHaveBeenCalled();
    expect(await readdir(join(input.runDir, "assurance"))).toEqual([]);
  });

  it("rejects a forged manifest run ID whose ledger entry is a symlink to the real run", async () => {
    const input = await runInput();
    const manifestPath = join(input.runDir, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    await writeFile(manifestPath, `${JSON.stringify(withTamperedRunId(manifest, "forged-run"), null, 2)}\n`, "utf8");
    await symlink(input.runDir, join(input.repoRoot, ".brain-hands", "runs", "forged-run"));
    const resolveLocalSha = vi.fn(async () => LOCAL);
    const getPullRequest = vi.fn(async () => null);
    const resolveRemoteSha = vi.fn(async () => LOCAL);

    await expect(recordRemoteSynchronization({
      ...input,
      github: { getPullRequest },
      resolveLocalSha,
      resolveRemoteSha,
    })).rejects.toThrow(/run.*(?:identity|lineage|symlink|canonical)|(?:identity|lineage|symlink|canonical).*run/i);
    expect(resolveLocalSha).not.toHaveBeenCalled();
    expect(getPullRequest).not.toHaveBeenCalled();
    expect(resolveRemoteSha).not.toHaveBeenCalled();
    expect(await readdir(join(input.runDir, "assurance"))).toEqual([]);
    expect((await readManifestV2(input.runDir)).remote_synchronization_path).toBeNull();
  });

  it("rejects a symlink supplied as the run directory even when it targets the expected run", async () => {
    const input = await runInput();
    const aliasParent = await mkdtemp(join(tmpdir(), "brain-hands-run-alias-"));
    roots.push(aliasParent);
    const runAlias = join(aliasParent, "run-alias");
    await symlink(input.runDir, runAlias);
    const resolveLocalSha = vi.fn(async () => LOCAL);
    const getPullRequest = vi.fn(async () => null);
    const resolveRemoteSha = vi.fn(async () => LOCAL);

    await expect(recordRemoteSynchronization({
      ...input,
      runDir: runAlias,
      github: { getPullRequest },
      resolveLocalSha,
      resolveRemoteSha,
    })).rejects.toThrow(/run.*(?:identity|lineage|symlink|canonical)|(?:identity|lineage|symlink|canonical).*run/i);
    expect(resolveLocalSha).not.toHaveBeenCalled();
    expect(getPullRequest).not.toHaveBeenCalled();
    expect(resolveRemoteSha).not.toHaveBeenCalled();
    expect(await readdir(join(input.runDir, "assurance"))).toEqual([]);
    expect((await readManifestV2(input.runDir)).remote_synchronization_path).toBeNull();
  });

  it("rejects an unrelated source repository before starting any lookup", async () => {
    const input = await runInput();
    const unrelatedRepo = await mkdtemp(join(tmpdir(), "brain-hands-unrelated-repo-"));
    roots.push(unrelatedRepo);
    const resolveLocalSha = vi.fn(async () => LOCAL);
    const getPullRequest = vi.fn(async () => null);
    const resolveRemoteSha = vi.fn(async () => LOCAL);

    await expect(recordRemoteSynchronization({
      ...input,
      repoRoot: unrelatedRepo,
      github: { getPullRequest },
      resolveLocalSha,
      resolveRemoteSha,
    })).rejects.toThrow(/repo(?:sitory)?.*(?:identity|source|manifest)|(?:identity|source|manifest).*repo(?:sitory)?/i);
    expect(resolveLocalSha).not.toHaveBeenCalled();
    expect(getPullRequest).not.toHaveBeenCalled();
    expect(resolveRemoteSha).not.toHaveBeenCalled();
    expect(await readdir(join(input.runDir, "assurance"))).toEqual([]);
    expect((await readManifestV2(input.runDir)).remote_synchronization_path).toBeNull();
  });

  it("accepts a canonical symlink alias to the manifest-bound source repository", async () => {
    const input = await runInput();
    const aliasParent = await mkdtemp(join(tmpdir(), "brain-hands-repo-alias-"));
    roots.push(aliasParent);
    const repoAlias = join(aliasParent, "repo-alias");
    await symlink(input.repoRoot, repoAlias);
    const resolveLocalSha = vi.fn(async () => LOCAL);
    const getPullRequest = vi.fn(async () => ({
      number: PR_NUMBER,
      url: PR_URL,
      head_ref: BRANCH,
      head_sha: LOCAL,
      state: "OPEN" as const,
    }));
    const resolveRemoteSha = vi.fn(async () => LOCAL);

    const result = await recordRemoteSynchronization({
      ...input,
      repoRoot: repoAlias,
      github: { getPullRequest },
      resolveLocalSha,
      resolveRemoteSha,
    });

    expect(result.evidence.synchronized).toBe(true);
    expect(resolveLocalSha).toHaveBeenCalledWith(repoAlias);
    expect(resolveRemoteSha).toHaveBeenCalledWith(repoAlias, BRANCH, REMOTE);
  });

  it("persists and links one normalized successful three-SHA observation", async () => {
    const input = await runInput();
    const resolveLocalSha = vi.fn(async () => LOCAL.toUpperCase());
    const getPullRequest = vi.fn(async () => ({
      number: PR_NUMBER,
      url: `${PR_URL}/`,
      head_ref: BRANCH,
      head_sha: LOCAL.toUpperCase(),
      state: "OPEN" as const,
    }));
    const resolveRemoteSha = vi.fn(async () => LOCAL.toUpperCase());

    const result = await recordRemoteSynchronization({
      ...input,
      github: { getPullRequest },
      resolveLocalSha,
      resolveRemoteSha,
    });

    expect(resolveLocalSha).toHaveBeenCalledOnce();
    expect(resolveLocalSha).toHaveBeenCalledWith(input.repoRoot);
    expect(getPullRequest).toHaveBeenCalledOnce();
    expect(getPullRequest).toHaveBeenCalledWith(PR_NUMBER);
    expect(resolveRemoteSha).toHaveBeenCalledOnce();
    expect(resolveRemoteSha).toHaveBeenCalledWith(input.repoRoot, BRANCH, REMOTE);
    expect(result.artifactPath).toMatch(/^assurance\/remote-synchronization-[0-9a-f]{64}\.json$/);
    expect(result.evidence).toMatchObject({
      run_id: (await readManifestV2(input.runDir)).run_id,
      local_candidate_sha: LOCAL,
      mapped_pr_sha: LOCAL,
      remote_head_sha: LOCAL,
      problems: [],
      synchronized: true,
    });
    expect(remoteSynchronizationEvidenceSchema.parse(
      JSON.parse(await readFile(join(input.runDir, result.artifactPath), "utf8")),
    )).toEqual(result.evidence);
    expect((await readManifestV2(input.runDir)).remote_synchronization_path).toBe(result.artifactPath);
  });

  it.each([
    {
      name: "PR lookup unavailable",
      override: { github: {} },
      expected: { local_candidate_sha: LOCAL, mapped_pr_sha: null, remote_head_sha: LOCAL },
      problem: { source: "pull_request", code: "lookup_unavailable" },
    },
    {
      name: "PR not found",
      override: { github: { getPullRequest: async () => null } },
      expected: { local_candidate_sha: LOCAL, mapped_pr_sha: null, remote_head_sha: LOCAL },
      problem: { source: "pull_request", code: "not_found" },
    },
    {
      name: "remote branch missing",
      override: { resolveRemoteSha: async () => null },
      expected: { local_candidate_sha: LOCAL, mapped_pr_sha: LOCAL, remote_head_sha: null },
      problem: { source: "remote", code: "not_found" },
    },
    {
      name: "PR differs",
      override: { github: { getPullRequest: async () => ({ number: PR_NUMBER, url: PR_URL, head_ref: BRANCH, head_sha: OTHER_A, state: "OPEN" as const }) } },
      expected: { local_candidate_sha: LOCAL, mapped_pr_sha: OTHER_A, remote_head_sha: LOCAL },
      problem: { source: "pull_request", code: "identity_mismatch" },
    },
    {
      name: "remote differs",
      override: { resolveRemoteSha: async () => OTHER_A },
      expected: { local_candidate_sha: LOCAL, mapped_pr_sha: LOCAL, remote_head_sha: OTHER_A },
      problem: { source: "remote", code: "identity_mismatch" },
    },
    {
      name: "all three differ",
      override: {
        github: { getPullRequest: async () => ({ number: PR_NUMBER, url: PR_URL, head_ref: BRANCH, head_sha: OTHER_A, state: "OPEN" as const }) },
        resolveRemoteSha: async () => OTHER_B,
      },
      expected: { local_candidate_sha: LOCAL, mapped_pr_sha: OTHER_A, remote_head_sha: OTHER_B },
      problems: [
        { source: "pull_request", code: "identity_mismatch" },
        { source: "remote", code: "identity_mismatch" },
      ],
    },
  ])("persists an unsynchronized result when $name", async ({ override, expected, problem, problems }) => {
    const input = await runInput(override as Partial<RecordRemoteSynchronizationInput>);
    const result = await recordRemoteSynchronization(input);

    expect(result.evidence).toMatchObject({ ...expected, synchronized: false });
    expect(result.evidence.problems).toEqual(problems ?? [problem]);
    expect(await readFile(join(input.runDir, result.artifactPath), "utf8")).toContain('"synchronized": false');
    expect((await readManifestV2(input.runDir)).remote_synchronization_path).toBe(result.artifactPath);
  });

  it.each([
    {
      name: "wrong PR number",
      patch: { number: 99 },
      mappedSha: null,
      code: "identity_mismatch",
    },
    {
      name: "malformed PR number",
      patch: { number: 0 },
      mappedSha: null,
      code: "invalid_response",
    },
    {
      name: "wrong PR URL",
      patch: { url: "https://github.com/acme/repo/pull/99" },
      mappedSha: null,
      code: "identity_mismatch",
    },
    {
      name: "closed PR",
      patch: { state: "CLOSED" as const },
      mappedSha: LOCAL,
      code: "identity_mismatch",
    },
    {
      name: "wrong head ref",
      patch: { head_ref: "codex/another-run" },
      mappedSha: LOCAL,
      code: "identity_mismatch",
    },
    {
      name: "malformed PR SHA",
      patch: { head_sha: "abc123" },
      mappedSha: null,
      code: "invalid_response",
    },
    {
      name: "malformed PR URL",
      patch: { url: "not a URL" },
      mappedSha: null,
      code: "invalid_response",
    },
  ])("rejects $name without blessing unrelated PR bytes", async ({ patch, mappedSha, code }) => {
    const input = await runInput({
      github: {
        getPullRequest: async () => ({
          number: PR_NUMBER,
          url: PR_URL,
          head_ref: BRANCH,
          head_sha: LOCAL,
          state: "OPEN",
          ...patch,
        }),
      },
    });

    const result = await recordRemoteSynchronization(input);

    expect(result.evidence.mapped_pr_sha).toBe(mappedSha);
    expect(result.evidence.problems).toContainEqual({ source: "pull_request", code });
    expect(result.evidence.synchronized).toBe(false);
  });

  it.each([
    { name: "local", override: { resolveLocalSha: async () => "abc123" }, source: "local" },
    { name: "remote", override: { resolveRemoteSha: async () => "abc123" }, source: "remote" },
  ])("records malformed $name Git SHA as invalid_response", async ({ override, source }) => {
    const input = await runInput(override as Partial<RecordRemoteSynchronizationInput>);
    const result = await recordRemoteSynchronization(input);
    expect(result.evidence.problems).toContainEqual({ source, code: "invalid_response" });
  });

  it("resolves every source even when each lookup fails and does not persist exception details", async () => {
    const input = await runInput();
    const secret = "ghp_DO_NOT_PERSIST";
    const resolveLocalSha = vi.fn(async () => { throw Object.assign(new Error(secret), { exitCode: 1 }); });
    const getPullRequest = vi.fn(async () => { throw Object.assign(new Error(secret), { exitCode: 1 }); });
    const resolveRemoteSha = vi.fn(async () => { throw Object.assign(new Error(secret), { exitCode: 1 }); });

    const result = await recordRemoteSynchronization({
      ...input,
      github: { getPullRequest },
      resolveLocalSha,
      resolveRemoteSha,
    });

    expect(resolveLocalSha).toHaveBeenCalledOnce();
    expect(getPullRequest).toHaveBeenCalledOnce();
    expect(resolveRemoteSha).toHaveBeenCalledOnce();
    expect(result.evidence.problems).toEqual([
      { source: "local", code: "command_failed" },
      { source: "pull_request", code: "command_failed" },
      { source: "remote", code: "command_failed" },
    ]);
    expect(await readFile(join(input.runDir, result.artifactPath), "utf8")).not.toContain(secret);
  });

  it("starts every independent lookup when dependencies throw synchronously", async () => {
    const input = await runInput();
    const resolveLocalSha = vi.fn(() => { throw new Error("local malformed"); });
    const getPullRequest = vi.fn(() => { throw new Error("PR malformed"); });
    const resolveRemoteSha = vi.fn(() => { throw new Error("remote malformed"); });

    const result = await recordRemoteSynchronization({
      ...input,
      github: { getPullRequest },
      resolveLocalSha,
      resolveRemoteSha,
    });

    expect(resolveLocalSha).toHaveBeenCalledOnce();
    expect(getPullRequest).toHaveBeenCalledOnce();
    expect(resolveRemoteSha).toHaveBeenCalledOnce();
    expect(result.evidence.problems).toEqual([
      { source: "local", code: "invalid_response" },
      { source: "pull_request", code: "invalid_response" },
      { source: "remote", code: "invalid_response" },
    ]);
  });

  it("reuses identical canonical evidence and its original timestamp", async () => {
    const input = await runInput();
    const first = await recordRemoteSynchronization(input);
    const second = await recordRemoteSynchronization({
      ...input,
      observedAt: () => "2026-07-16T13:00:00.000Z",
    });

    expect(second).toEqual(first);
    expect(second.evidence.observed_at).toBe("2026-07-16T12:01:00.000Z");
  });

  it("rejects a terminal pointer whose immutable synchronization artifact is missing without recreating it", async () => {
    const input = await runInput();
    const first = await recordRemoteSynchronization(input);
    await updateManifestV2(input.runDir, { stage: "delivery", delivery_state: "ready" });
    await recordTerminalDisposition(input.runDir, {
      outcome: "delivered",
      actor: "runtime",
      reason: "Test delivery is complete",
      residual_risks: [],
    });
    await rm(join(input.runDir, first.artifactPath));

    await expect(recordRemoteSynchronization(input)).rejects.toThrow(/missing|ENOENT|evidence|artifact/i);

    expect(await readdir(join(input.runDir, "assurance"))).toEqual([]);
    expect((await readManifestV2(input.runDir)).remote_synchronization_path).toBe(first.artifactPath);
  });

  it("canonicalizes a trailing slash in the expected PR URL for digest identity", async () => {
    const input = await runInput();
    const first = await recordRemoteSynchronization(input);
    const second = await recordRemoteSynchronization({
      ...input,
      expectedPullRequestUrl: `${PR_URL}/`,
      observedAt: () => "2026-07-16T13:00:00.000Z",
    });

    expect(second).toEqual(first);
    expect(second.evidence.pull_request_url).toBe(PR_URL);
  });

  it("creates a second immutable artifact for a changed explicit observation", async () => {
    const input = await runInput();
    const first = await recordRemoteSynchronization(input);
    const firstBytes = await readFile(join(input.runDir, first.artifactPath), "utf8");
    const second = await recordRemoteSynchronization({
      ...input,
      resolveRemoteSha: async () => OTHER_A,
      observedAt: () => "2026-07-16T13:00:00.000Z",
    });

    expect(second.artifactPath).not.toBe(first.artifactPath);
    expect(second.evidence.observed_at).toBe("2026-07-16T13:00:00.000Z");
    expect(await readFile(join(input.runDir, first.artifactPath), "utf8")).toBe(firstBytes);
    expect((await readManifestV2(input.runDir)).remote_synchronization_path).toBe(second.artifactPath);
  });

  it("rejects different bytes occupying an existing canonical identity path", async () => {
    const input = await runInput();
    const first = await recordRemoteSynchronization(input);
    await writeFile(join(input.runDir, first.artifactPath), "{}\n", "utf8");

    await expect(recordRemoteSynchronization(input)).rejects.toThrow(/existing|identity|evidence|invalid/i);
  });

  it("rejects an assurance-directory symlink before writing or linking evidence", async () => {
    const input = await runInput();
    const outside = await mkdtemp(join(tmpdir(), "brain-hands-remote-sync-outside-"));
    roots.push(outside);
    await rm(join(input.runDir, "assurance"), { recursive: true });
    await symlink(outside, join(input.runDir, "assurance"));

    await expect(recordRemoteSynchronization(input)).rejects.toThrow(/symlink|owned|escaped/i);
    expect((await readManifestV2(input.runDir)).remote_synchronization_path).toBeNull();
  });
});
