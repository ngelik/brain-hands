import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { getGitSnapshot, resolveLocalHeadSha, type GitSnapshot } from "../adapters/git.js";
import type { GitHubAdapter, GitHubRepositoryIdentity } from "../adapters/github.js";
import { inspectGitHubSetup, type GitHubSetupInspection } from "../adapters/github-setup.js";
import {
  readModelCatalog,
  validateCatalogProfile,
  type ModelCatalogSelection,
  type ModelCatalogSnapshot,
} from "../adapters/model-catalog.js";
import { assertPlanReady, parseExecutionPlan } from "../core/execution-spec.js";
import { runCommand } from "../core/executor.js";
import { readManifestV2, readVerifiedPlanRevision, writeTextArtifact } from "../core/ledger.js";
import { readTaskLineage } from "../core/task-lineage.js";
import type { BrainPlan, ConfigV2, RunManifestV2 } from "../core/types.js";

export interface ExecutionViabilityReportV1 {
  version: 1;
  run_id: string;
  task_lineage_id: string | null;
  plan_revision: number;
  plan_sha256: string;
  repository_key: string;
  checks: Array<{ name: string; status: "passed" | "failed" }>;
  checked_at: string;
}

export interface GithubExecutionViabilityDependencies {
  assertPlanReady?: typeof assertPlanReady;
  readManifestV2?: typeof readManifestV2;
  readVerifiedPlanRevision?: typeof readVerifiedPlanRevision;
  getGitSnapshot?: (worktreePath: string) => Promise<GitSnapshot>;
  resolveLocalHeadSha?: typeof resolveLocalHeadSha;
  isAncestor?: (worktreePath: string, ancestor: string, descendant: string) => Promise<boolean>;
  readModelCatalog?: typeof readModelCatalog;
  validateCatalogProfile?: typeof validateCatalogProfile;
  inspectGitHubSetup?: (repoRoot: string, remote: string) => Promise<GitHubSetupInspection>;
  readTaskLineage?: typeof readTaskLineage;
  persistReport?: (runDir: string, report: ExecutionViabilityReportV1) => Promise<void>;
  now?: () => string;
}

export interface GithubExecutionViabilityInput {
  runDir: string;
  worktreePath: string;
  plan: BrainPlan;
  config: ConfigV2;
  github: GitHubAdapter;
  dependencies?: GithubExecutionViabilityDependencies;
}

type ViabilityCheckName =
  | "plan-readiness"
  | "worktree-identity"
  | "model-catalog"
  | "github-capabilities"
  | "github-setup";

/** Safe report sentinel used until authenticated repository identity is available. */
const unresolvedRepositoryKey = "unresolved";

const requiredGitHubCapabilities = [
  "getRepositoryIdentity",
  "findIssuesByMarker",
  "findIssueByMarker",
  "createIssue",
  "updateIssue",
  "findParentIssuesByMarker",
  "findParentIssueByMarker",
  "createParentIssue",
  "updateParentIssue",
  "findPullRequestByHead",
  "findPullRequestsByLineage",
  "openIntegratedPullRequest",
  "getDefaultBranch",
  "getPullRequest",
  "updatePullRequestBody",
  "getIssue",
  "closeIssue",
  "findStatusCommentByMarker",
  "createStatusComment",
  "updateStatusComment",
  "reconcileIssueStateLabel",
  "upsertRunStatus",
] as const satisfies readonly (keyof GitHubAdapter)[];

function currentRepositoryRoot(runDir: string, runId: string): string {
  const canonicalRunDir = resolve(runDir);
  if (basename(canonicalRunDir) !== runId) throw new Error("Run directory does not match its manifest run ID");
  const runsDir = dirname(canonicalRunDir);
  const controlDir = dirname(runsDir);
  if (basename(runsDir) !== "runs" || basename(controlDir) !== ".brain-hands") {
    throw new Error("Run directory is outside the canonical Brain Hands run tree");
  }
  return dirname(controlDir);
}

function approvedPlanBinding(manifest: RunManifestV2): { revision: number; sha256: string } {
  const current = manifest.current_revision ?? manifest.current_plan_revision;
  const approved = manifest.approved_revision ?? manifest.approved_plan_revision;
  if (current === null || current === undefined || approved !== current) {
    throw new Error("The current plan revision is not explicitly approved");
  }
  const record = manifest.plan_revisions[String(current)];
  if (!record || !/^[a-f0-9]{64}$/i.test(record.sha256)) {
    throw new Error("The approved plan revision has no valid SHA-256 binding");
  }
  return { revision: current, sha256: record.sha256.toLowerCase() };
}

function canonicalRepositoryKey(repository: Pick<GitHubRepositoryIdentity, "host" | "name_with_owner">): string {
  const host = repository.host.trim().toLowerCase();
  const parts = repository.name_with_owner.trim().split("/");
  if (!/^[a-z0-9.-]+$/.test(host)
    || parts.length !== 2
    || parts.some((part) => !/^[a-z0-9_.-]+$/i.test(part))) {
    throw new Error("GitHub repository identity is invalid");
  }
  return `${host}/${parts.map((part) => part.toLowerCase()).join("/")}`;
}

function canonicalPersistedRepositoryKey(value: string): string {
  const [host, owner, name, ...extra] = value.split("/");
  if (!host || !owner || !name || extra.length > 0) throw new Error("Persisted repository key is invalid");
  return canonicalRepositoryKey({ host, name_with_owner: `${owner}/${name}` });
}

async function defaultIsAncestor(worktreePath: string, ancestor: string, descendant: string): Promise<boolean> {
  const result = await runCommand({
    command: "git",
    args: ["merge-base", "--is-ancestor", ancestor, descendant],
    cwd: worktreePath,
    timeoutMs: 15_000,
  });
  if (result.exitCode === 0) return true;
  if (result.exitCode === 1) return false;
  throw new Error("Git ancestry inspection failed");
}

function assertGithubCapabilities(github: GitHubAdapter): void {
  if (requiredGitHubCapabilities.some((capability) => typeof github[capability] !== "function")) {
    throw new Error("GitHub adapter is missing a required execution capability");
  }
}

async function assertBoundGitIdentity(input: {
  manifest: RunManifestV2;
  repoRoot: string;
  worktreePath: string;
  getSnapshot: (worktreePath: string) => Promise<GitSnapshot>;
  getHead: typeof resolveLocalHeadSha;
  isAncestor: (worktreePath: string, ancestor: string, descendant: string) => Promise<boolean>;
}): Promise<void> {
  const { manifest } = input;
  if (!manifest.worktree_path || !manifest.branch_name || !manifest.source_commit) {
    throw new Error("Persisted worktree, branch, and source commit identity are required");
  }
  if (!isAbsolute(manifest.repo_root) || !isAbsolute(manifest.worktree_path)) {
    throw new Error("Persisted repository and worktree identity must be absolute");
  }
  const historicalRelative = relative(resolve(manifest.repo_root), resolve(manifest.worktree_path));
  if (historicalRelative === ""
    || historicalRelative === ".."
    || historicalRelative.startsWith(`..${sep}`)
    || isAbsolute(historicalRelative)) {
    throw new Error("Persisted worktree identity is outside its repository");
  }
  const [expectedWorktree, suppliedWorktree] = await Promise.all([
    realpath(resolve(input.repoRoot, historicalRelative)),
    realpath(input.worktreePath),
  ]);
  if (expectedWorktree !== suppliedWorktree) throw new Error("Supplied worktree does not match the persisted identity");

  const snapshot = await input.getSnapshot(input.worktreePath);
  if (snapshot.branch !== manifest.branch_name || !snapshot.isLinkedWorktree || snapshot.status.trim() !== "") {
    throw new Error("Bound worktree branch or clean linked-worktree state is invalid");
  }
  const head = await input.getHead(input.worktreePath);
  if (!/^[a-f0-9]{40,64}$/i.test(manifest.source_commit)
    || !/^[a-f0-9]{40,64}$/i.test(head)
    || !(await input.isAncestor(input.worktreePath, manifest.source_commit, head))) {
    throw new Error("Run-pinned source commit is not an ancestor of the worktree HEAD");
  }
}

function selectedProfile(manifest: RunManifestV2, config: ConfigV2, role: "hands" | "verifier") {
  const profile = manifest.selected_role_profiles[role] ?? manifest.role_profiles[role] ?? config.profiles[role];
  if (!profile) throw new Error(`The ${role} profile is not configured`);
  return profile;
}

function validateModels(
  snapshot: ModelCatalogSnapshot,
  manifest: RunManifestV2,
  config: ConfigV2,
  validate: (snapshot: ModelCatalogSnapshot, profile: { model: string; reasoning_effort: ConfigV2["profiles"]["hands"]["reasoning_effort"] }, label: string) => ModelCatalogSelection,
): void {
  validate(snapshot, selectedProfile(manifest, config, "hands"), "Hands");
  validate(snapshot, selectedProfile(manifest, config, "verifier"), "Verifier");
  const backup = manifest.hands_backup_policy ?? config.retry_policy.backup;
  if (backup) validate(snapshot, backup.profile, "Hands backup");
}

async function persistReport(runDir: string, report: ExecutionViabilityReportV1): Promise<void> {
  await writeTextArtifact(runDir, "execution-viability.json", `${JSON.stringify(report, null, 2)}\n`);
}

export async function assertGithubExecutionViable(input: GithubExecutionViabilityInput): Promise<{
  report: ExecutionViabilityReportV1;
  repository: GitHubRepositoryIdentity;
  plan: BrainPlan;
}> {
  const dependencies = input.dependencies ?? {};
  const manifest = await (dependencies.readManifestV2 ?? readManifestV2)(input.runDir);
  const repoRoot = currentRepositoryRoot(input.runDir, manifest.run_id);
  let planBinding: { revision: number; sha256: string } | null = null;
  let repositoryKey = unresolvedRepositoryKey;
  let repository: GitHubRepositoryIdentity | null = null;
  let verifiedPlan: BrainPlan | null = null;
  const checks: ExecutionViabilityReportV1["checks"] = [];
  const now = dependencies.now ?? (() => new Date().toISOString());

  const existingRepositoryKey = async (): Promise<string | null> => {
    if (manifest.task_lineage_id === null) return null;
    try {
      const lineage = await (dependencies.readTaskLineage ?? readTaskLineage)(repoRoot, manifest.task_lineage_id);
      if (lineage.active_run_id !== manifest.run_id
        || !lineage.run_ids.includes(manifest.run_id)
        || lineage.repository_key === null) return null;
      return canonicalPersistedRepositoryKey(lineage.repository_key);
    } catch {
      return null;
    }
  };

  const report = (): ExecutionViabilityReportV1 | null => planBinding ? {
    version: 1,
    run_id: manifest.run_id,
    task_lineage_id: manifest.task_lineage_id,
    plan_revision: planBinding.revision,
    plan_sha256: planBinding.sha256,
    repository_key: repositoryKey,
    checks: [...checks],
    checked_at: now(),
  } : null;
  const writeReport = dependencies.persistReport ?? persistReport;

  const check = async (name: ViabilityCheckName, operation: () => void | Promise<void>): Promise<void> => {
    try {
      await operation();
      checks.push({ name, status: "passed" });
    } catch {
      checks.push({ name, status: "failed" });
      if (repositoryKey === unresolvedRepositoryKey) repositoryKey = await existingRepositoryKey() ?? repositoryKey;
      const failedReport = report();
      if (failedReport) {
        try {
          await writeReport(input.runDir, failedReport);
        } catch {
          throw new Error(`GitHub execution viability failed: ${name}; safe report persistence failed`);
        }
      }
      throw new Error(`GitHub execution viability failed: ${name}`);
    }
  };

  await check("plan-readiness", async () => {
    planBinding = approvedPlanBinding(manifest);
    const bytes = await (dependencies.readVerifiedPlanRevision ?? readVerifiedPlanRevision)(input.runDir, manifest, planBinding.revision);
    verifiedPlan = parseExecutionPlan(
      JSON.parse(bytes),
      { mode: "github", repoRoot: input.worktreePath },
      manifest.workflow_protocol,
    );
    if (!isDeepStrictEqual(verifiedPlan, input.plan)) {
      throw new Error("Caller plan differs from the verified approved plan revision");
    }
    (dependencies.assertPlanReady ?? assertPlanReady)(verifiedPlan, { mode: "github", repoRoot: input.worktreePath });
  });

  await check("worktree-identity", () => assertBoundGitIdentity({
    manifest,
    repoRoot,
    worktreePath: input.worktreePath,
    getSnapshot: dependencies.getGitSnapshot ?? getGitSnapshot,
    getHead: dependencies.resolveLocalHeadSha ?? resolveLocalHeadSha,
    isAncestor: dependencies.isAncestor ?? defaultIsAncestor,
  }));

  await check("model-catalog", async () => {
    const catalog = await (dependencies.readModelCatalog ?? readModelCatalog)({
      command: input.config.codex.command,
      cwd: input.worktreePath,
      timeoutMs: input.config.codex.timeout_seconds * 1000,
    });
    validateModels(catalog.snapshot, manifest, input.config, dependencies.validateCatalogProfile ?? validateCatalogProfile);
  });

  await check("github-capabilities", () => assertGithubCapabilities(input.github));

  await check("github-setup", async () => {
    const inspection = await (dependencies.inspectGitHubSetup ?? inspectGitHubSetup)(repoRoot, input.config.github.default_remote);
    repositoryKey = canonicalRepositoryKey({ host: inspection.repository.host, name_with_owner: inspection.repository.nameWithOwner });
    if (inspection.labels.some((label) => label.status === "missing")) {
      throw new Error("Required GitHub workflow labels are missing");
    }
    repository = await input.github.getRepositoryIdentity!();
    if (canonicalRepositoryKey(repository) !== repositoryKey) {
      throw new Error("Authenticated GitHub repository identity does not match the configured remote");
    }
    const defaultBranch = await input.github.getDefaultBranch!();
    if (!defaultBranch.trim()) throw new Error("GitHub repository default branch is unavailable");
  });

  const passedReport = report();
  if (!passedReport || !repository || !verifiedPlan) throw new Error("GitHub execution viability did not produce verified execution bindings");
  try {
    await writeReport(input.runDir, passedReport);
  } catch {
    throw new Error("GitHub execution viability failed: safe report persistence failed");
  }
  return { report: passedReport, repository, plan: verifiedPlan };
}
