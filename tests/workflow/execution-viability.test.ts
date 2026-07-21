import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitHubAdapter } from "../../src/adapters/github.js";
import { defaultConfig } from "../../src/core/config.js";
import { approvePlanRevision, recordPlan, transitionRun, updateManifestV2 } from "../../src/core/ledger.js";
import { createTaskLineage } from "../../src/core/task-lineage.js";
import type { BrainPlan, ConfigV2 } from "../../src/core/types.js";
import {
  assertGithubExecutionViable,
  type GithubExecutionViabilityDependencies,
} from "../../src/workflow/execution-viability.js";
import { executionSpec } from "../fixtures/execution-spec.js";
import { createLegacyRunLedgerV2 } from "../fixtures/legacy-run.js";

const plan: BrainPlan = {
  summary: "Ship feature",
  assumptions: [],
  research: [],
  research_sources: ["repo"],
  architecture: "simple",
  risks: [],
  work_items: [executionSpec("feature")],
  integration_verification: [["npm", "test", "--", "integration.test.ts"]],
};

const sourceCommit = "a".repeat(40);
const headCommit = "b".repeat(40);
const branchName = "codex/brain-hands/run-1";
const roots: string[] = [];

function config(withBackup = false): ConfigV2 {
  const value = defaultConfig();
  value.profiles.hands = { model: "hands", reasoning_effort: "medium", sandbox: "workspace-write" };
  value.profiles.verifier = { model: "verifier", reasoning_effort: "high", sandbox: "read-only" };
  if (withBackup) {
    value.retry_policy.backup = {
      fallback_on_primary_usage_limit: true,
      max_quality_recovery_attempts: 1,
      profile: { model: "backup", reasoning_effort: "low" },
    };
  }
  return value;
}

async function setup(withBackup = false) {
  const root = await mkdtemp(join(tmpdir(), "brain-hands-viability-"));
  roots.push(root);
  const worktreePath = join(root, "worktree");
  await mkdir(worktreePath);
  const run = await createLegacyRunLedgerV2({
    repoRoot: root,
    originalRequest: "Ship feature",
    mode: "github",
    worktreePath,
    branchName,
    sourceCommit,
    intake: {
      task: "Ship feature",
      repo_root: root,
      mode: "github",
      research: false,
      reflection: false,
      models: { brain: "brain", hands: "hands", verifier: "verifier" },
      resolved_models: { brain: "brain", hands: "hands", verifier: "verifier" },
      roles: {
        brain: { model: "brain", reasoning_effort: "high", sandbox: "read-only" },
        hands: { model: "hands", reasoning_effort: "medium", sandbox: "workspace-write" },
        verifier: { model: "verifier", reasoning_effort: "high", sandbox: "read-only" },
      },
      ...(withBackup ? { hands_backup: config(true).retry_policy.backup } : {}),
    },
  });
  await transitionRun(run.runDir, "preflight");
  await transitionRun(run.runDir, "brain_planning");
  await recordPlan(run.runDir, `${JSON.stringify(plan)}\n`);
  await transitionRun(run.runDir, "awaiting_plan_approval");
  await approvePlanRevision(run.runDir, 1, { actor: "test" });
  return { root, worktreePath, runDir: run.runDir, config: config(withBackup) };
}

function catalog() {
  return {
    models: [
      { slug: "hands", supported_reasoning_levels: [{ effort: "medium" }] },
      { slug: "verifier", supported_reasoning_levels: [{ effort: "high" }] },
      { slug: "backup", supported_reasoning_levels: [{ effort: "low" }] },
    ],
  };
}

function githubAdapter(mutations: string[]): GitHubAdapter {
  return {
    createIssue: async () => { mutations.push("createIssue"); return 1; },
    updateIssue: async () => { mutations.push("updateIssue"); },
    addIssueLabels: async () => { mutations.push("addIssueLabels"); },
    openPullRequest: async () => { mutations.push("openPullRequest"); return 1; },
    commentOnPullRequest: async () => { mutations.push("commentOnPullRequest"); },
    getRepositoryIdentity: async () => ({ host: "github.com", name_with_owner: "Acme/Repo", actor: "operator" }),
    findIssuesByMarker: async () => [],
    findIssueByMarker: async () => null,
    createParentIssue: async () => { mutations.push("createParentIssue"); return 1; },
    findParentIssuesByMarker: async () => [],
    findParentIssueByMarker: async () => null,
    updateParentIssue: async () => { mutations.push("updateParentIssue"); },
    openIntegratedPullRequest: async () => { mutations.push("openIntegratedPullRequest"); return { number: 1, url: "https://github.com/acme/repo/pull/1" }; },
    findPullRequestByHead: async () => null,
    findPullRequestsByLineage: async () => [],
    getDefaultBranch: async () => "main",
    getPullRequest: async () => ({ number: 1, url: "https://github.com/acme/repo/pull/1" }),
    updatePullRequestBody: async () => { mutations.push("updatePullRequestBody"); },
    getIssue: async () => ({ number: 1, title: "issue", body: "body", state: "OPEN", state_reason: null }),
    closeIssue: async () => { mutations.push("closeIssue"); },
    findStatusCommentByMarker: async () => null,
    createStatusComment: async () => { mutations.push("createStatusComment"); return { id: 1, body: "body", authorLogin: "operator" }; },
    updateStatusComment: async () => { mutations.push("updateStatusComment"); },
    reconcileIssueStateLabel: async () => { mutations.push("reconcileIssueStateLabel"); },
    upsertRunStatus: async () => { mutations.push("upsertRunStatus"); },
  };
}

function dependencies(calls: string[], overrides: Partial<GithubExecutionViabilityDependencies> = {}): GithubExecutionViabilityDependencies {
  return {
    assertPlanReady: () => { calls.push("plan-readiness"); },
    readVerifiedPlanRevision: async () => `${JSON.stringify(plan)}\n`,
    getGitSnapshot: async () => {
      calls.push("worktree-identity");
      return { branch: branchName, status: "", gitDir: ".git/worktrees/run", gitCommonDir: ".git", isLinkedWorktree: true };
    },
    resolveLocalHeadSha: async () => headCommit,
    isAncestor: async () => true,
    readModelCatalog: async () => {
      calls.push("model-catalog");
      return { snapshot: catalog(), commandResult: {} as never };
    },
    inspectGitHubSetup: async () => {
      calls.push("github-setup");
      return {
        repository: { remote: "origin", remoteUrl: "git@github.com:Acme/Repo.git", host: "github.com", owner: "Acme", name: "Repo", nameWithOwner: "Acme/Repo" },
        labels: [{ name: "brain-hands", status: "existing", expected: { name: "brain-hands", color: "000000", description: "workflow" } }],
      };
    },
    now: () => "2026-07-16T12:00:00.000Z",
    ...overrides,
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("assertGithubExecutionViable", () => {
  it("runs every focused check in order, reads the catalog once, validates backup, and writes an allowlisted report", async () => {
    const fixture = await setup(true);
    const calls: string[] = [];
    const mutations: string[] = [];
    const validate = vi.fn((snapshot: ReturnType<typeof catalog>, profile: { model: string; reasoning_effort: string }) => {
      if (!snapshot.models.some((model) => model.slug === profile.model)) throw new Error("missing model");
      return { slug: profile.model, reasoning_effort: profile.reasoning_effort, supported_reasoning_efforts: [profile.reasoning_effort] } as never;
    });
    const result = await assertGithubExecutionViable({
      runDir: fixture.runDir,
      worktreePath: fixture.worktreePath,
      plan,
      config: fixture.config,
      github: githubAdapter(mutations),
      dependencies: dependencies(calls, { validateCatalogProfile: validate as never }),
    });

    expect(calls).toEqual(["plan-readiness", "worktree-identity", "model-catalog", "github-setup"]);
    expect(validate.mock.calls.map((call) => call[1].model)).toEqual(["hands", "verifier", "backup"]);
    expect(mutations).toEqual([]);
    expect(result.repository).toEqual({ host: "github.com", name_with_owner: "Acme/Repo", actor: "operator" });
    expect(result.plan).toEqual(plan);
    expect(result.report).toEqual({
      version: 1,
      run_id: expect.any(String),
      task_lineage_id: null,
      plan_revision: 1,
      plan_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      repository_key: "github.com/acme/repo",
      checks: [
        { name: "plan-readiness", status: "passed" },
        { name: "worktree-identity", status: "passed" },
        { name: "model-catalog", status: "passed" },
        { name: "github-capabilities", status: "passed" },
        { name: "github-setup", status: "passed" },
      ],
      checked_at: "2026-07-16T12:00:00.000Z",
    });
    expect(JSON.parse(await readFile(join(fixture.runDir, "execution-viability.json"), "utf8"))).toEqual(result.report);
  });

  const failures = [
    {
      name: "plan-readiness",
      override: () => ({ assertPlanReady: () => { throw new Error("plan body secret"); } }),
    },
    {
      name: "worktree-identity",
      override: () => ({ getGitSnapshot: async () => ({ branch: branchName, status: " M secret.env\n", gitDir: ".git", gitCommonDir: ".git", isLinkedWorktree: false }) }),
    },
    {
      name: "model-catalog",
      override: () => ({ readModelCatalog: async () => { throw new Error("catalog stderr token"); } }),
    },
  ] as const;

  for (const failure of failures) {
    it(`fails closed at ${failure.name} without invoking any mutation`, async () => {
      const fixture = await setup();
      const mutations: string[] = [];
      await expect(assertGithubExecutionViable({
        runDir: fixture.runDir,
        worktreePath: fixture.worktreePath,
        plan,
        config: fixture.config,
        github: githubAdapter(mutations),
        dependencies: dependencies([], failure.override() as Partial<GithubExecutionViabilityDependencies>),
      })).rejects.toThrow(`GitHub execution viability failed: ${failure.name}`);
      expect(mutations).toEqual([]);
      const raw = await readFile(join(fixture.runDir, "execution-viability.json"), "utf8");
      const report = JSON.parse(raw);
      expect(report.repository_key).toBe("unresolved");
      expect(report.checks.at(-1)).toEqual({ name: failure.name, status: "failed" });
      expect(raw).not.toMatch(/secret|token|stderr|\/tmp\//i);
    });
  }

  it("permits the bound worktree to stay dirty while resuming an active work item", async () => {
    const fixture = await setup();
    await updateManifestV2(fixture.runDir, { current_work_item_id: "feature", stage: "fixing" });
    const calls: string[] = [];
    await expect(assertGithubExecutionViable({
      runDir: fixture.runDir,
      worktreePath: fixture.worktreePath,
      plan,
      config: fixture.config,
      github: githubAdapter([]),
      dependencies: dependencies(calls, {
        getGitSnapshot: async () => ({
          branch: branchName,
          status: " M package-lock.json\n",
          gitDir: ".git/worktrees/run",
          gitCommonDir: ".git",
          isLinkedWorktree: true,
        }),
      }),
    })).resolves.toBeDefined();
    expect(calls).toContain("plan-readiness");
  });

  it("fails closed when any downstream GitHub effect capability is absent", async () => {
    const fixture = await setup();
    const mutations: string[] = [];
    const github = githubAdapter(mutations);
    delete github.reconcileIssueStateLabel;

    await expect(assertGithubExecutionViable({
      runDir: fixture.runDir,
      worktreePath: fixture.worktreePath,
      plan,
      config: fixture.config,
      github,
      dependencies: dependencies([]),
    })).rejects.toThrow("GitHub execution viability failed: github-capabilities");
    expect(mutations).toEqual([]);
    expect(JSON.parse(await readFile(join(fixture.runDir, "execution-viability.json"), "utf8"))).toMatchObject({
      repository_key: "unresolved",
      checks: expect.arrayContaining([{ name: "github-capabilities", status: "failed" }]),
    });
  });

  it("persists a redacted failed report after repository binding when setup is incomplete", async () => {
    const fixture = await setup();
    const mutations: string[] = [];
    const github = githubAdapter(mutations);
    github.getDefaultBranch = async () => { throw new Error("remote body token=secret"); };

    await expect(assertGithubExecutionViable({
      runDir: fixture.runDir,
      worktreePath: fixture.worktreePath,
      plan,
      config: fixture.config,
      github,
      dependencies: dependencies([]),
    })).rejects.toThrow("GitHub execution viability failed: github-setup");

    const raw = await readFile(join(fixture.runDir, "execution-viability.json"), "utf8");
    const report = JSON.parse(raw);
    expect(report.checks.at(-1)).toEqual({ name: "github-setup", status: "failed" });
    expect(Object.keys(report).sort()).toEqual([
      "checked_at", "checks", "plan_revision", "plan_sha256", "repository_key", "run_id", "task_lineage_id", "version",
    ]);
    expect(raw).not.toMatch(/secret|token|remote body|\/tmp\//i);
    expect(mutations).toEqual([]);
  });

  it("uses an already-bound lineage repository key for an early failed report", async () => {
    const fixture = await setup();
    const lineageId = "11111111-1111-4111-8111-111111111111";
    const manifest = JSON.parse(await readFile(join(fixture.runDir, "manifest.json"), "utf8"));
    await createTaskLineage({
      repoRoot: fixture.root,
      runId: manifest.run_id,
      lineageId,
      repositoryKey: "github.com/acme/repo",
    });
    await updateManifestV2(fixture.runDir, { task_lineage_id: lineageId, github_effects_protocol: "task-lineage-v1" });

    await expect(assertGithubExecutionViable({
      runDir: fixture.runDir,
      worktreePath: fixture.worktreePath,
      plan,
      config: fixture.config,
      github: githubAdapter([]),
      dependencies: dependencies([], { assertPlanReady: () => { throw new Error("unsafe plan details"); } }),
    })).rejects.toThrow("GitHub execution viability failed: plan-readiness");

    const report = JSON.parse(await readFile(join(fixture.runDir, "execution-viability.json"), "utf8"));
    expect(report).toMatchObject({
      task_lineage_id: lineageId,
      repository_key: "github.com/acme/repo",
      checks: [{ name: "plan-readiness", status: "failed" }],
    });
  });

  it("rejects an independently valid caller plan that differs from the verified approved bytes", async () => {
    const fixture = await setup();
    const mutations: string[] = [];
    const substitutedPlan = { ...plan, summary: "Different but independently valid summary" };

    await expect(assertGithubExecutionViable({
      runDir: fixture.runDir,
      worktreePath: fixture.worktreePath,
      plan: substitutedPlan,
      config: fixture.config,
      github: githubAdapter(mutations),
      dependencies: dependencies([]),
    })).rejects.toThrow("GitHub execution viability failed: plan-readiness");

    const report = JSON.parse(await readFile(join(fixture.runDir, "execution-viability.json"), "utf8"));
    expect(report).toMatchObject({
      repository_key: "unresolved",
      checks: [{ name: "plan-readiness", status: "failed" }],
    });
    expect(mutations).toEqual([]);
  });

  it("accepts a structurally identical caller plan with different object key insertion order", async () => {
    const fixture = await setup();
    const reorderedPlan: BrainPlan = {
      work_items: plan.work_items,
      risks: plan.risks,
      architecture: plan.architecture,
      research_sources: plan.research_sources,
      research: plan.research,
      assumptions: plan.assumptions,
      summary: plan.summary,
      integration_verification: plan.integration_verification,
    };

    const result = await assertGithubExecutionViable({
      runDir: fixture.runDir,
      worktreePath: fixture.worktreePath,
      plan: reorderedPlan,
      config: fixture.config,
      github: githubAdapter([]),
      dependencies: dependencies([]),
    });

    expect(result.plan).toEqual(plan);
    expect(result.report.repository_key).toBe("github.com/acme/repo");
  });

  it("sanitizes a safe-report persistence failure", async () => {
    const fixture = await setup();

    await expect(assertGithubExecutionViable({
      runDir: fixture.runDir,
      worktreePath: fixture.worktreePath,
      plan,
      config: fixture.config,
      github: githubAdapter([]),
      dependencies: dependencies([], {
        assertPlanReady: () => { throw new Error("plan failed"); },
        persistReport: async () => { throw new Error("write failed at /private/secret/manifest.json"); },
      }),
    })).rejects.toThrow("GitHub execution viability failed: plan-readiness; safe report persistence failed");

    await expect(assertGithubExecutionViable({
      runDir: fixture.runDir,
      worktreePath: fixture.worktreePath,
      plan,
      config: fixture.config,
      github: githubAdapter([]),
      dependencies: dependencies([], {
        assertPlanReady: () => { throw new Error("plan failed"); },
        persistReport: async () => { throw new Error("write failed at /private/secret/manifest.json"); },
      }),
    })).rejects.not.toThrow(/private|secret|manifest\.json|write failed/i);
  });
});
