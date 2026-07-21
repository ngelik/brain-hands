import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, mkdir, open, readdir, realpath, symlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { runCommand } from "../core/executor.js";
import type { CommandResult } from "../core/executor.js";
import type { ControllerBootstrapEvidence, ControllerBootstrapSpec, ReviewCycleState, WorkItem } from "../core/types.js";
import { controllerBootstrapEvidenceSchema, controllerBootstrapSpecSchema, convergenceReportSchema } from "../core/schema.js";
import { readManifestV2, readOptionalValidatedArtifact } from "../core/ledger.js";
import { readOwnedEvidenceFile, writeOwnedEvidenceFile } from "../core/owned-evidence.js";
import { loadFindingRevisionRecords } from "../workflow/findings.js";
import { loadSuccessfulFixProvenance, requireCompletedAdvanceEffect } from "../workflow/review-cycle.js";
import { validatePersistedWarningAuthorization } from "../workflow/authorization.js";
import { convergenceReportPath, loadCurrentCycleEvidence } from "../workflow/convergence.js";

export interface GitSnapshot {
  branch: string;
  status: string;
  gitDir: string;
  gitCommonDir: string;
  isLinkedWorktree: boolean;
}

export interface ScopedDiff {
  base_commit: string;
  head_commit: string;
  changed_files: string[];
  patch: string;
  patch_bytes: number;
}

export interface CollectScopedWorktreeDiffInput {
  repoRoot: string;
  baseCommit: string;
  workItem: Pick<WorkItem, "file_contract" | "completion_contract">;
}

async function git(repoRoot: string, args: string[]) {
  return runCommand({
    command: "git",
    args,
    cwd: repoRoot,
    timeoutMs: 30_000,
  });
}

export interface RunWorktree {
  runId: string;
  worktreePath: string;
  /** Short alias retained for callers that refer to the resolved path as path. */
  path: string;
  branchName: string;
  /** Short alias retained for callers that refer to the branch as branch. */
  branch: string;
}

/** Deterministic branch identity used by both allocation and pre-allocation authority checks. */
export function runWorktreeBranchName(runId: string): string {
  validateRunId(runId);
  return `codex/brain-hands/${runId}`;
}

/** Deterministic checkout identity used by both allocation and pre-allocation authority checks. */
export function runWorktreePath(sourceRepo: string, runId: string): string {
  validateRunId(runId);
  return resolve(sourceRepo, ".brain-hands", "worktrees", runId);
}

async function gitCheckoutIdentity(root: string, label: string): Promise<{
  topLevel: string;
  commonDir: string;
  branch: string;
}> {
  const result = await git(root, [
    "rev-parse",
    "--show-toplevel",
    "--git-common-dir",
    "--abbrev-ref",
    "HEAD",
  ]);
  if (result.exitCode !== 0) throw commandFailureError(result, `Failed to resolve ${label} Git identity`);
  const [topLevel, commonDir, branch, ...extra] = result.stdout.trim().split("\n");
  if (!topLevel || !commonDir || !branch || extra.length > 0) {
    throw new Error(`${label} Git identity output is invalid`);
  }
  return { topLevel, commonDir, branch };
}

/** Prove the pinned checkout is the deterministic linked worktree for this run. */
export async function verifyRunWorktreeIdentity(input: {
  repoRoot: string;
  runId: string;
  worktreePath: string;
  branchName: string;
  sourceCommit: string;
}): Promise<void> {
  const expectedPath = runWorktreePath(input.repoRoot, input.runId);
  const expectedBranch = runWorktreeBranchName(input.runId);
  if (resolve(input.worktreePath) !== expectedPath || input.branchName !== expectedBranch) {
    throw new Error("Run checkout does not match its deterministic repository/run identity");
  }
  for (const [path, label] of [[input.repoRoot, "Repository"], [input.worktreePath, "Run worktree"]] as const) {
    const status = await lstat(path);
    if (status.isSymbolicLink() || !status.isDirectory()) throw new Error(`${label} must be a real directory, not a symbolic link`);
  }
  const [sourceRoot, targetRoot] = await Promise.all([realpath(input.repoRoot), realpath(input.worktreePath)]);
  const expectedCanonicalPath = resolve(sourceRoot, ".brain-hands", "worktrees", input.runId);
  if (targetRoot !== expectedCanonicalPath) throw new Error("Run worktree canonical path differs from its pinned identity");

  // Keep verifier children fully settled before propagating any identity
  // failure; a rejected Promise.all could leave another tracked child queued.
  const sourceIdentity = await gitCheckoutIdentity(sourceRoot, "source checkout");
  const targetIdentity = await gitCheckoutIdentity(targetRoot, "run worktree");
  if (await realpath(sourceIdentity.topLevel) !== sourceRoot || await realpath(targetIdentity.topLevel) !== targetRoot) {
    throw new Error("Run checkout Git top-level identity is inconsistent");
  }
  const sourceCommonPath = await realpath(resolve(sourceRoot, sourceIdentity.commonDir));
  const targetCommonPath = await realpath(resolve(targetRoot, targetIdentity.commonDir));
  if (sourceCommonPath !== targetCommonPath) throw new Error("Run checkout belongs to the wrong Git common directory");
  if (targetIdentity.branch !== expectedBranch) throw new Error("Run checkout is on the wrong branch");
  const ancestry = await git(targetRoot, ["merge-base", "--is-ancestor", input.sourceCommit, "HEAD"]);
  if (ancestry.exitCode !== 0) throw new Error("Run checkout does not descend from the pinned source commit");
}

const controllerBootstrapEvidencePath = "controller-bootstrap/evidence.json";

function pathInside(root: string, target: string): boolean {
  const relation = relative(root, target);
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}

async function gitValue(repoRoot: string, args: string[], failure: string): Promise<string> {
  const result = await git(repoRoot, args);
  if (result.exitCode !== 0) throw commandFailureError(result, failure);
  return result.stdout.trim().toLowerCase();
}

async function gitText(repoRoot: string, args: string[], failure: string): Promise<string> {
  const result = await git(repoRoot, args);
  if (result.exitCode !== 0) throw commandFailureError(result, failure);
  return result.stdout.trim();
}

async function hashRegularFile(root: string, relativePath: string): Promise<{ bytes: Buffer; sha256: string }> {
  const canonicalRoot = await realpath(root);
  const target = resolve(canonicalRoot, relativePath);
  const parent = await realpath(dirname(target));
  if (!pathInside(canonicalRoot, parent)) throw new Error(`Bootstrap file escaped its worktree: ${relativePath}`);
  const before = await lstat(target);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error(`Bootstrap file must be regular: ${relativePath}`);
  const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const descriptor = await handle.stat();
    if (!descriptor.isFile() || descriptor.dev !== before.dev || descriptor.ino !== before.ino) {
      throw new Error(`Bootstrap file identity changed during read: ${relativePath}`);
    }
    const bytes = await handle.readFile();
    return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
  } finally {
    await handle.close();
  }
}

async function writeRegularFile(root: string, relativePath: string, bytes: Buffer): Promise<void> {
  const canonicalRoot = await realpath(root);
  const target = resolve(canonicalRoot, relativePath);
  const parent = await realpath(dirname(target));
  if (!pathInside(canonicalRoot, parent)) throw new Error(`Bootstrap target escaped its worktree: ${relativePath}`);
  const existing = await lstat(target).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (existing?.isSymbolicLink() || (existing !== null && !existing.isFile())) {
    throw new Error(`Bootstrap target must be a regular file: ${relativePath}`);
  }
  const flags = existing === null
    ? constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0)
    : constants.O_WRONLY | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0);
  const handle = await open(target, flags, 0o644);
  try {
    if (!(await handle.stat()).isFile()) throw new Error(`Bootstrap target must be a regular file: ${relativePath}`);
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readControllerBootstrapEvidence(runDir: string): Promise<ControllerBootstrapEvidence | null> {
  return readOwnedEvidenceFile(runDir, controllerBootstrapEvidencePath, "controller-bootstrap/")
    .then((bytes) => controllerBootstrapEvidenceSchema.parse(JSON.parse(bytes.toString("utf8"))))
    .catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
}

export async function runControllerBootstrap(input: {
  runDir: string;
  repoRoot: string;
  worktreePath: string;
  sourceCommit: string;
  spec: ControllerBootstrapSpec;
}): Promise<ControllerBootstrapEvidence> {
  const spec = controllerBootstrapSpecSchema.parse(input.spec);
  if (input.sourceCommit !== spec.baseline_commit) {
    throw new Error("Bootstrap baseline does not match the run-pinned source commit");
  }
  const sourceRoot = await realpath(resolve(input.repoRoot, spec.source_worktree));
  const worktreesRoot = await realpath(resolve(input.repoRoot, ".brain-hands/worktrees"));
  const targetRoot = await realpath(input.worktreePath);
  if (!pathInside(worktreesRoot, sourceRoot) || sourceRoot === worktreesRoot || sourceRoot === targetRoot) {
    throw new Error("Bootstrap source must be a distinct Brain Hands worktree");
  }

  const existing = await readControllerBootstrapEvidence(input.runDir);
  if (existing !== null) {
    if (existing.baseline_commit !== spec.baseline_commit
      || existing.preserved_head !== spec.preserved_head
      || existing.source_worktree !== spec.source_worktree
      || JSON.stringify(existing.files.map(({ path, source_status, sha256 }) => ({ path, source_status, sha256 })))
        !== JSON.stringify(spec.files)) {
      throw new Error("Persisted bootstrap evidence conflicts with the approved plan");
    }
    for (const file of existing.files) {
      const current = await hashRegularFile(sourceRoot, file.path);
      if (current.sha256 !== file.source_after_sha256) throw new Error(`Bootstrap source changed after completion: ${file.path}`);
    }
    const ancestry = await git(targetRoot, ["merge-base", "--is-ancestor", existing.bootstrap_commit, "HEAD"]);
    if (ancestry.exitCode !== 0) throw commandFailureError(ancestry, "Bootstrap commit is not an ancestor of target HEAD");
    return existing;
  }

  const [targetHead, sourceHead] = await Promise.all([
    gitValue(targetRoot, ["rev-parse", "HEAD"], "Failed to resolve bootstrap target HEAD"),
    gitValue(sourceRoot, ["rev-parse", "HEAD"], "Failed to resolve bootstrap source HEAD"),
  ]);
  if (sourceHead !== spec.preserved_head) throw new Error("Bootstrap source does not match the approved preserved head");

  const sourceBefore = [] as Array<ControllerBootstrapEvidence["files"][number] & { bytes: Buffer }>;
  for (const file of spec.files) {
    const tracked = await git(sourceRoot, ["ls-files", "--error-unmatch", "--", file.path]);
    const actualStatus = tracked.exitCode === 0 ? "tracked" : "untracked";
    if (actualStatus !== file.source_status) throw new Error(`Bootstrap source status mismatch: ${file.path}`);
    const current = await hashRegularFile(sourceRoot, file.path);
    if (current.sha256 !== file.sha256) throw new Error(`Bootstrap source hash mismatch: ${file.path}`);
    sourceBefore.push({
      ...file,
      bytes: current.bytes,
      source_before_sha256: current.sha256,
      source_after_sha256: current.sha256,
      target_after_sha256: current.sha256,
    });
  }

  const expected = spec.files.map((file) => file.path).sort();
  let changed = (await getWorktreeChangedFiles(targetRoot)).sort();
  let mergeCommit: string;
  let bootstrapCommit: string | null = null;
  if (targetHead === spec.baseline_commit) {
    if (changed.length > 0) throw new Error("Bootstrap target must be clean before merge");
    const merge = await git(targetRoot, ["merge", "--no-ff", "--no-edit", spec.preserved_head]);
    if (merge.exitCode !== 0) throw commandFailureError(merge, "Controller bootstrap merge failed");
    mergeCommit = await gitValue(targetRoot, ["rev-parse", "HEAD"], "Failed to resolve bootstrap merge commit");
  } else {
    const [baselineAncestor, preservedAncestor] = await Promise.all([
      git(targetRoot, ["merge-base", "--is-ancestor", spec.baseline_commit, "HEAD"]),
      git(targetRoot, ["merge-base", "--is-ancestor", spec.preserved_head, "HEAD"]),
    ]);
    if (baselineAncestor.exitCode !== 0 || preservedAncestor.exitCode !== 0) {
      throw new Error("Bootstrap target does not match the approved integration ancestry");
    }
    if (changed.some((path) => !expected.includes(path))) {
      throw new Error(`Bootstrap changed paths outside the approved allowlist: ${changed.join(", ")}`);
    }
    const message = await gitText(targetRoot, ["show", "-s", "--format=%s", "HEAD"], "Failed to inspect bootstrap checkpoint");
    const targetMatches = await Promise.all(sourceBefore.map(async (file) =>
      hashRegularFile(targetRoot, file.path).then((target) => target.sha256 === file.sha256).catch(() => false)));
    if (changed.length === 0 && message === spec.commit_message && targetMatches.every(Boolean)) {
      bootstrapCommit = targetHead;
      mergeCommit = await gitValue(targetRoot, ["rev-parse", "HEAD^"], "Failed to resolve bootstrap merge parent");
    } else {
      const parents = (await gitValue(targetRoot, ["show", "-s", "--format=%P", "HEAD"], "Failed to inspect merge checkpoint"))
        .split(/\s+/).filter(Boolean);
      if (parents.length < 2) throw new Error("Bootstrap recovery requires the approved merge checkpoint");
      mergeCommit = targetHead;
    }
  }

  if (bootstrapCommit === null) {
    for (const file of sourceBefore) await writeRegularFile(targetRoot, file.path, file.bytes);
    changed = (await getWorktreeChangedFiles(targetRoot)).sort();
    if (JSON.stringify(changed) !== JSON.stringify(expected)) {
      throw new Error(`Bootstrap changed paths outside the approved allowlist: ${changed.join(", ")}`);
    }
  }
  for (const file of sourceBefore) {
    const [sourceAfter, targetAfter] = await Promise.all([
      hashRegularFile(sourceRoot, file.path),
      hashRegularFile(targetRoot, file.path),
    ]);
    if (sourceAfter.sha256 !== file.source_before_sha256 || targetAfter.sha256 !== file.source_before_sha256) {
      throw new Error(`Bootstrap byte identity check failed: ${file.path}`);
    }
    file.source_after_sha256 = sourceAfter.sha256;
    file.target_after_sha256 = targetAfter.sha256;
  }

  if (bootstrapCommit === null) {
    const add = await git(targetRoot, ["add", "--", ...spec.files.map((file) => file.path)]);
    if (add.exitCode !== 0) throw commandFailureError(add, "Failed to stage controller bootstrap files");
    const commit = await git(targetRoot, ["commit", "-m", spec.commit_message]);
    if (commit.exitCode !== 0) throw commandFailureError(commit, "Failed to commit controller bootstrap files");
    bootstrapCommit = await gitValue(targetRoot, ["rev-parse", "HEAD"], "Failed to resolve bootstrap commit");
  }
  if ((await getWorktreeChangedFiles(targetRoot)).length > 0) throw new Error("Bootstrap target is not clean after commit");

  const evidence: ControllerBootstrapEvidence = {
    version: 1,
    baseline_commit: spec.baseline_commit,
    preserved_head: spec.preserved_head,
    source_worktree: spec.source_worktree,
    merge_commit: mergeCommit,
    bootstrap_commit: bootstrapCommit,
    files: sourceBefore.map(({ bytes: _bytes, ...file }) => file),
    completed_at: new Date().toISOString(),
  };
  await writeOwnedEvidenceFile(
    input.runDir,
    controllerBootstrapEvidencePath,
    "controller-bootstrap/",
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
  return evidence;
}

function validateRunId(runId: string): void {
  if (runId.trim() === "" || runId === "." || runId === ".." || isAbsolute(runId)) {
    throw new Error("Run ID must be a non-empty relative path segment");
  }
  if (runId.includes("/") || runId.includes("\\") || /[\u0000;|&<>`$]/.test(runId)) {
    throw new Error("Run ID contains unsafe path characters");
  }
}

function validateRef(value: string, label: string): void {
  if (
    value.trim() === "" ||
    value === "." ||
    value === ".." ||
    value.startsWith("-") ||
    value.startsWith("+") ||
    isAbsolute(value)
  ) {
    throw new Error(`${label} must be non-empty and relative`);
  }
  if (/[\u0000;|&<>`$\s:@{}~^?*\[\]]/.test(value) || value.includes("\\")) {
    throw new Error(`${label} contains unsafe characters`);
  }
}

async function exposeWorktreeNodeModules(sourceRepo: string, worktreePath: string): Promise<void> {
  const source = join(sourceRepo, "node_modules");
  let entries;
  try {
    entries = await readdir(source, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const target = join(worktreePath, "node_modules");
  await mkdir(target, { recursive: true });
  for (const entry of entries) {
    if (entry.name === ".vite") continue;
    const type = entry.isDirectory()
      ? (process.platform === "win32" ? "junction" : "dir")
      : "file";
    await symlink(join(source, entry.name), join(target, entry.name), type);
  }
}

/** Ensure the source checkout has no tracked, untracked, or ignored changes. */
export async function assertCleanSourceCheckout(repoRoot: string): Promise<void> {
  const result = await git(repoRoot, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (result.exitCode !== 0) {
    throw commandFailureError(result, "Failed to inspect source checkout");
  }
  const dirtyEntries = result.stdout
    .split("\n")
    .map((entry) => entry.trimEnd())
    .filter((entry) => entry.length > 0)
    // .brain-hands is this tool's own run/worktree ledger area. It is safe to
    // leave it untracked; source files and user-owned paths remain strict.
    .filter((entry) => !/^\?\? \.brain-hands(?:\/|$)/.test(entry));
  if (dirtyEntries.length > 0) {
    throw new Error(`Source checkout must be clean before worktree allocation: ${dirtyEntries.join("\n")}`);
  }
}

/**
 * Allocate the deterministic run worktree only after the source is proven
 * clean. The returned path is exposed only after git worktree add succeeds.
 */
export async function createRunWorktree(
  sourceRepo: string,
  runId: string,
  sourceCommit?: string,
): Promise<RunWorktree> {
  await assertCleanSourceCheckout(sourceRepo);
  validateRunId(runId);
  if (sourceCommit !== undefined) validateRef(sourceCommit, "Source commit");

  const worktreePath = runWorktreePath(sourceRepo, runId);
  const worktreeRoot = resolve(sourceRepo, ".brain-hands", "worktrees");
  const branchName = runWorktreeBranchName(runId);

  try {
    await access(worktreePath);
    throw new Error(`Run worktree destination already exists: ${worktreePath}`);
  } catch (error: unknown) {
    if (error instanceof Error && error.message.startsWith("Run worktree destination")) {
      throw error;
    }
    const code = (error as { code?: string }).code;
    if (code !== "ENOENT") {
      throw error;
    }
  }

  await mkdir(worktreeRoot, { recursive: true });
  const result = await git(sourceRepo, [
    "worktree",
    "add",
    "-b",
    branchName,
    worktreePath,
    ...(sourceCommit === undefined ? [] : [sourceCommit]),
  ]);
  if (result.exitCode !== 0) {
    throw commandFailureError(result, `Failed to create run worktree ${worktreePath}`);
  }
  await exposeWorktreeNodeModules(sourceRepo, worktreePath);

  return {
    runId,
    worktreePath,
    path: worktreePath,
    branchName,
    branch: branchName,
  };
}

export interface CommitWorkItemInput {
  worktreePath?: string;
  repoRoot?: string;
  workItemId?: string;
  id?: string;
  title: string;
  verifierApproved?: boolean;
  policyProof?: { runDir: string; cycle: ReviewCycleState; owner: string };
  approved?: boolean;
  verifierDecision?: string;
}

export async function validatePolicyCommitProof(input: {
  runDir: string;
  cycle: ReviewCycleState;
  owner: string;
  workItemId: string;
}): Promise<void> {
  const completed = await requireCompletedAdvanceEffect({ run_dir: input.runDir, cycle: input.cycle, owner: input.owner });
  const cycle = completed.cycle;
  if (!["advance", "continue_with_warning"].includes(cycle.decision.action)) {
    throw new Error("Policy commit proof requires an advance decision");
  }
  if (cycle.work_item_id !== input.workItemId) throw new Error("Policy commit proof belongs to a different work item");
  const findings = await loadFindingRevisionRecords(input.runDir, cycle.work_item_id, cycle.review_revision, cycle.finding_ids);
  const blocking = findings.filter((finding) => ["blocking", "fix_in_scope", "requires_replan"].includes(finding.disposition));
  if (cycle.decision.action === "advance" && blocking.length > 0) {
    throw new Error("Policy delivery proof contains blocking normalized findings");
  }
  if (cycle.decision.action === "continue_with_warning" && blocking.some((finding) => finding.severity === "critical" || finding.severity === "high")) {
    throw new Error("Policy warning proof cannot waive a critical/high blocker");
  }
  const manifest = await readManifestV2(input.runDir);
  if (!manifest.review_policy_snapshot || !manifest.review_accounting) throw new Error("Policy commit proof is missing immutable policy accounting");
  const progress = manifest.work_item_progress[cycle.work_item_id];
  const summary = manifest.convergence_reports?.[cycle.work_item_id];
  if (
    progress?.review_cycle_path !== cycle.decision_path
    || progress.review_effect_id !== cycle.effect_id
    || progress.review_revision !== cycle.review_revision
    || progress.review_path !== cycle.work_item_progress_reference?.review_path
    || progress.verification_path !== cycle.work_item_progress_reference?.verification_path
    || summary?.review_revision !== cycle.review_revision
    || summary.recommended_action !== "advance"
  ) throw new Error("Policy delivery proof does not match durable progress or convergence provenance");
  const convergence = await readOptionalValidatedArtifact(input.runDir, summary.path, convergenceReportSchema);
  if (!convergence) throw new Error("Policy delivery convergence artifact is missing");
  if (
    summary.path !== convergenceReportPath(cycle.work_item_id, convergence.plan_revision, cycle.review_revision)
    || convergence.work_item_id !== cycle.work_item_id
    || convergence.review_revision !== cycle.review_revision
    || convergence.policy_revision !== cycle.decision.policy_revision
    || convergence.decision_reason_code !== cycle.decision.reason_code
  ) throw new Error("Policy delivery convergence proof is invalid");
  const currentEvidence = await loadCurrentCycleEvidence(input.runDir, cycle);
  const fixProvenance = await loadSuccessfulFixProvenance(input.runDir, manifest.review_accounting);
  const exactEvidence = [...new Set([
    ...findings.flatMap((finding) => finding.evidence_refs),
    ...fixProvenance.evidence_refs,
    ...currentEvidence,
    ...(convergence.authorization?.evidence_snapshot ?? []),
  ])].sort();
  if (JSON.stringify(convergence.evidence_refs) !== JSON.stringify(exactEvidence)) {
    throw new Error("Policy delivery convergence evidence does not exactly match canonical provenance");
  }
  const unresolvedIds = [...new Set(blocking.map((finding) => finding.finding_id))].sort();
  if (JSON.stringify(convergence.unresolved_finding_ids) !== JSON.stringify(unresolvedIds)) {
    throw new Error("Policy delivery convergence unresolved findings do not match normalized findings");
  }
  if (cycle.decision.action === "continue_with_warning") {
    if (!convergence.authorization) throw new Error("Policy delivery warning proof is missing authorization");
    await validatePersistedWarningAuthorization({
      run_dir: input.runDir,
      work_item_id: cycle.work_item_id,
      review_revision: cycle.review_revision,
      policy: manifest.review_policy_snapshot,
      findings,
      evidence_snapshot: [...new Set([
        ...findings.flatMap((finding) => finding.evidence_refs),
        ...currentEvidence,
      ])].sort(),
      authorization: convergence.authorization,
    });
  } else if (convergence.unresolved_finding_ids.length > 0 || convergence.authorization !== null) {
    throw new Error("Policy delivery convergence proof contains unresolved unauthorized findings");
  }
}

export interface WorkItemCommitIntentProvenance {
  parent_sha: string;
  tree_sha: string;
  message: string;
}

export interface LocalCommitProvenance {
  sha: string;
  parent_shas: string[];
  tree_sha: string;
  message: string;
}

function workItemCommitMessage(workItemId: string, title: string): string {
  return `work-item: ${workItemId.trim()} ${title.trim()}`;
}

function requireCommitSha(value: string, label: string): string {
  const sha = value.trim().toLowerCase();
  if (!/^[a-f0-9]{40,64}$/.test(sha)) throw new Error(`${label} returned invalid commit provenance`);
  return sha;
}

export async function prepareWorkItemCommitIntent(
  repoRoot: string,
  workItemId: string,
  title: string,
): Promise<WorkItemCommitIntentProvenance> {
  const message = workItemCommitMessage(workItemId, title);
  const addResult = await git(repoRoot, ["add", "-A"]);
  if (addResult.exitCode !== 0) throw commandFailureError(addResult, "Failed to stage work-item changes");
  const [parent, tree] = await Promise.all([
    git(repoRoot, ["rev-parse", "HEAD"]),
    git(repoRoot, ["write-tree"]),
  ]);
  if (parent.exitCode !== 0) throw commandFailureError(parent, "Failed to resolve work-item commit parent");
  if (tree.exitCode !== 0) throw commandFailureError(tree, "Failed to resolve intended work-item tree");
  return {
    parent_sha: requireCommitSha(parent.stdout, "Work-item commit parent"),
    tree_sha: requireCommitSha(tree.stdout, "Intended work-item tree"),
    message,
  };
}

export async function resolveLocalCommitProvenance(
  repoRoot: string,
  sha: string,
): Promise<LocalCommitProvenance> {
  const commitSha = requireCommitSha(sha, "Local commit");
  const [parents, tree, message] = await Promise.all([
    git(repoRoot, ["show", "-s", "--format=%P", commitSha, "--"]),
    git(repoRoot, ["show", "-s", "--format=%T", commitSha, "--"]),
    git(repoRoot, ["show", "-s", "--format=%B", commitSha, "--"]),
  ]);
  if (parents.exitCode !== 0) throw commandFailureError(parents, "Failed to resolve local commit parents");
  if (tree.exitCode !== 0) throw commandFailureError(tree, "Failed to resolve local commit tree");
  if (message.exitCode !== 0) throw commandFailureError(message, "Failed to resolve local commit message");
  return {
    sha: commitSha,
    parent_shas: parents.stdout.trim().split(/\s+/).filter(Boolean).map((parent) => requireCommitSha(parent, "Local commit parent")),
    tree_sha: requireCommitSha(tree.stdout, "Local commit tree"),
    message: message.stdout.trimEnd(),
  };
}

function normalizeCommitInput(
  inputOrPath: CommitWorkItemInput | string,
  workItemId?: string,
  title?: string,
  verifierApproved?: boolean,
): { worktreePath: string; workItemId: string; title: string; deliveryApproved: boolean } {
  if (typeof inputOrPath === "string") {
    return {
      worktreePath: inputOrPath,
      workItemId: workItemId ?? "",
      title: title ?? "",
      deliveryApproved: verifierApproved === true,
    };
  }

  return {
    worktreePath: inputOrPath.worktreePath ?? inputOrPath.repoRoot ?? "",
    workItemId: inputOrPath.workItemId ?? inputOrPath.id ?? "",
    title: inputOrPath.title,
    deliveryApproved:
      inputOrPath.verifierApproved === true ||
      inputOrPath.approved === true ||
      inputOrPath.verifierDecision === "approve",
  };
}

/** Stage and commit one work item after (and only after) Verifier approval. */
export async function commitWorkItem(
  input: CommitWorkItemInput | string,
  workItemId?: string,
  title?: string,
  verifierApproved?: boolean,
): Promise<string> {
  const normalized = normalizeCommitInput(input, workItemId, title, verifierApproved);
  let policyApproved = false;
  if (typeof input !== "string" && input.policyProof) {
    const proof = input.policyProof;
    await validatePolicyCommitProof({ ...proof, workItemId: normalized.workItemId });
    policyApproved = true;
  }
  if (!normalized.deliveryApproved && !policyApproved) {
    throw new Error("Cannot commit work item before Verifier or policy approval");
  }
  if (normalized.worktreePath.trim() === "") {
    throw new Error("Worktree path is required to commit a work item");
  }
  if (normalized.workItemId.trim() === "" || normalized.title.trim() === "") {
    throw new Error("Work item ID and title are required to commit");
  }

  const message = workItemCommitMessage(normalized.workItemId, normalized.title);
  const addResult = await git(normalized.worktreePath, ["add", "-A"]);
  if (addResult.exitCode !== 0) {
    throw commandFailureError(addResult, "Failed to stage work-item changes");
  }
  const commitResult = await git(normalized.worktreePath, ["commit", "-m", message]);
  if (commitResult.exitCode !== 0) {
    throw commandFailureError(commitResult, "Failed to commit work item");
  }

  const head = await git(normalized.worktreePath, ["rev-parse", "HEAD"]);
  if (head.exitCode !== 0) {
    throw commandFailureError(head, "Failed to resolve work-item commit");
  }
  return head.stdout.trim();
}

export async function pushBranch(
  repoRoot: string,
  branchName: string,
  remote = "origin",
): Promise<string> {
  validateRef(branchName, "Branch name");
  validateRef(remote, "Remote name");
  const result = await git(repoRoot, ["push", "--", remote, branchName]);
  if (result.exitCode !== 0) {
    throw commandFailureError(result, `Failed to push branch ${branchName}`);
  }
  return result.stdout.trim();
}

export async function pushCommitToBranch(
  repoRoot: string,
  commitSha: string,
  branchName: string,
  expectedRemoteSha: string | null,
  remote = "origin",
): Promise<string> {
  const sha = requireCommitSha(commitSha, "Push commit");
  const before = expectedRemoteSha === null ? "" : requireCommitSha(expectedRemoteSha, "Push remote lease");
  validateRef(branchName, "Branch name");
  validateRef(remote, "Remote name");
  const remoteRef = `refs/heads/${branchName}`;
  const result = await git(repoRoot, [
    "push",
    `--force-with-lease=${remoteRef}:${before}`,
    "--",
    remote,
    `${sha}:${remoteRef}`,
  ]);
  if (result.exitCode !== 0) {
    throw commandFailureError(result, `Atomic remote lease rejected commit ${sha} for branch ${branchName}`);
  }
  return result.stdout.trim();
}

export async function resolveRemoteBranchSha(
  repoRoot: string,
  branchName: string,
  remote = "origin",
): Promise<string | null> {
  validateRef(branchName, "Branch name");
  validateRef(remote, "Remote name");
  const result = await git(repoRoot, ["ls-remote", "--refs", remote, `refs/heads/${branchName}`]);
  if (result.exitCode !== 0) {
    throw commandFailureError(result, `Failed to resolve remote branch ${branchName}`);
  }
  const output = result.stdout.trim();
  if (!output) return null;
  const [sha, ref, ...extra] = output.split(/\s+/);
  if (!sha || !/^[a-f0-9]{40,64}$/i.test(sha) || ref !== `refs/heads/${branchName}` || extra.length > 0) {
    throw new Error(`Remote branch ${branchName} returned invalid ref provenance`);
  }
  return sha.toLowerCase();
}

export async function resolveLocalHeadSha(repoRoot: string): Promise<string> {
  const result = await git(repoRoot, ["rev-parse", "HEAD"]);
  if (result.exitCode !== 0) throw commandFailureError(result, "Failed to resolve local HEAD");
  const sha = result.stdout.trim();
  if (!/^[a-f0-9]{40,64}$/i.test(sha)) throw new Error("Local HEAD returned invalid commit provenance");
  return sha.toLowerCase();
}

export async function requireRemoteBranchAtLocalHead(
  repoRoot: string,
  branchName: string,
  remote = "origin",
): Promise<string> {
  const [localSha, remoteSha] = await Promise.all([
    resolveLocalHeadSha(repoRoot),
    resolveRemoteBranchSha(repoRoot, branchName, remote),
  ]);
  if (remoteSha === null) throw new Error(`Remote PR branch ${branchName} does not exist`);
  if (remoteSha !== localSha) throw new Error(`Remote PR branch ${branchName} does not equal local HEAD`);
  return localSha;
}

interface CommandFailureMetadata extends Error {
  exitCode: number | null;
  errorCode?: string;
  errorMessage?: string;
  timedOut: boolean;
  signal: string | null;
  command: string;
  args: string[];
  stdout: string;
  stderr: string;
}

function commandFailureError(result: CommandResult, fallbackMessage: string): Error {
  const details = [
    `command=${result.command}`,
    `args=${JSON.stringify(result.args)}`,
    `exitCode=${result.exitCode === null ? "null" : result.exitCode}`,
    `errorCode=${result.errorCode ?? "unknown"}`,
    `timedOut=${result.timedOut}`,
    `signal=${result.signal ?? "none"}`,
    `stdout=${result.stdout ? result.stdout.trim() : "<empty>"}`,
    `stderr=${result.stderr ? result.stderr.trim() : "<empty>"}`,
  ].join(" | ");

  const error = new Error(
    `${fallbackMessage}: ${details}${
      result.errorMessage ? ` :: ${result.errorMessage}` : ""
    }`,
  ) as CommandFailureMetadata;

  error.exitCode = result.exitCode;
  error.errorCode = result.errorCode;
  error.errorMessage = result.errorMessage;
  error.timedOut = result.timedOut;
  error.signal = result.signal ?? null;
  error.command = result.command;
  error.args = result.args;
  error.stdout = result.stdout;
  error.stderr = result.stderr;
  return error;
}

export async function getGitSnapshot(repoRoot: string): Promise<GitSnapshot> {
  const branch = await git(repoRoot, ["branch", "--show-current"]);
  const status = await git(repoRoot, ["status", "--short"]);
  const gitDir = await git(repoRoot, ["rev-parse", "--git-dir"]);
  const gitCommonDir = await git(repoRoot, ["rev-parse", "--git-common-dir"]);

  for (const result of [branch, status, gitDir, gitCommonDir]) {
    if (result.exitCode !== 0) {
      throw commandFailureError(result, "Failed to inspect git repository");
    }
  }

  const gitDirValue = gitDir.stdout.trim();
  const gitCommonDirValue = gitCommonDir.stdout.trim();

  return {
    branch: branch.stdout.trim(),
    status: status.stdout,
    gitDir: gitDirValue,
    gitCommonDir: gitCommonDirValue,
    isLinkedWorktree: gitDirValue !== gitCommonDirValue,
  };
}

/** List tracked and untracked files that would be included by a worktree commit. */
export async function getWorktreeChangedFiles(repoRoot: string): Promise<string[]> {
  const tracked = await git(repoRoot, ["diff", "--name-only", "-z", "--relative", "HEAD"]);
  const untracked = await git(repoRoot, ["ls-files", "--others", "--exclude-standard", "-z"]);
  for (const result of [tracked, untracked]) {
    if (result.exitCode !== 0) {
      throw commandFailureError(result, "Failed to list worktree changes");
    }
  }

  return [...new Set(
    [...tracked.stdout.split("\0"), ...untracked.stdout.split("\0")]
      .filter((path) => path.length > 0),
  )];
}

/** Restore only tracked paths that an isolated run worktree inherited from a rejected attempt. */
export async function restoreTrackedWorktreeFiles(repoRoot: string, paths: readonly string[]): Promise<string[]> {
  const requested = [...new Set(paths)];
  for (const path of requested) validateContractPath(path);
  if (requested.length === 0) return [];
  const listed = await git(repoRoot, ["ls-files", "-z", "--", ...requested]);
  if (listed.exitCode !== 0) throw commandFailureError(listed, "Failed to identify tracked rejected-attempt files");
  const tracked = listed.stdout.split("\0").filter((path) => path.length > 0);
  if (tracked.length === 0) return [];
  const restored = await git(repoRoot, ["restore", "--source=HEAD", "--worktree", "--", ...tracked]);
  if (restored.exitCode !== 0) throw commandFailureError(restored, "Failed to restore tracked rejected-attempt files");
  return tracked;
}

function validateContractPath(path: string): void {
  const segments = path.split("/");
  if (
    path.length === 0
    || isAbsolute(path)
    || /^[a-zA-Z]:[\\/]/.test(path)
    || path.includes("\\")
    || /\p{Cc}/u.test(path)
    || segments.some((segment) => segment.length === 0 || segment === "." || segment === ".." || segment === ".git")
  ) {
    throw new Error(`Invalid repository-relative contract path: ${path}`);
  }
}

/** Collect the complete worktree patch for only the paths approved by a work item. */
export async function collectScopedWorktreeDiff(input: CollectScopedWorktreeDiffInput): Promise<ScopedDiff> {
  if (!/^[a-f0-9]{40,64}$/i.test(input.baseCommit)) {
    throw new Error("Scoped diff base commit must be a full Git object ID");
  }
  const baseCommit = await gitValue(
    input.repoRoot,
    ["rev-parse", "--verify", `${input.baseCommit}^{commit}`],
    "Failed to resolve scoped diff base commit",
  );
  if (baseCommit !== input.baseCommit.toLowerCase()) {
    throw new Error("Scoped diff base commit must be the full Git object ID");
  }
  const headCommit = await gitValue(input.repoRoot, ["rev-parse", "HEAD"], "Failed to resolve scoped diff HEAD");
  const approvedPaths = [...new Set([
    ...input.workItem.file_contract.map((entry) => entry.path),
    ...input.workItem.completion_contract.expected_changed_files,
  ])];
  for (const path of approvedPaths) validateContractPath(path);
  approvedPaths.sort();

  if (approvedPaths.length === 0) {
    return {
      base_commit: baseCommit,
      head_commit: headCommit,
      changed_files: [],
      patch: "",
      patch_bytes: 0,
    };
  }

  const approvedPathspecs = approvedPaths.map((path) => `:(literal)${path}`);

  const tracked = await git(input.repoRoot, [
    "diff", "--name-only", "-z", "--relative", baseCommit, "--", ...approvedPathspecs,
  ]);
  const untracked = await git(input.repoRoot, [
    "ls-files", "--others", "--exclude-standard", "-z", "--", ...approvedPathspecs,
  ]);
  for (const result of [tracked, untracked]) {
    if (result.exitCode !== 0) throw commandFailureError(result, "Failed to list scoped worktree changes");
  }

  const approved = new Set(approvedPaths);
  const trackedFiles = tracked.stdout.split("\0").filter((path) => path.length > 0).sort();
  const untrackedFiles = untracked.stdout.split("\0").filter((path) => path.length > 0).sort();
  const unexpectedScopedFiles = [...new Set([...trackedFiles, ...untrackedFiles].filter((path) => !approved.has(path)))].sort();
  if (unexpectedScopedFiles.length > 0) {
    throw new Error(`Scoped diff matched paths outside the exact approved contract: ${unexpectedScopedFiles.join(", ")}`);
  }
  const changedFiles = [...new Set([...trackedFiles, ...untrackedFiles])].sort();
  const patchSections: string[] = [];

  if (trackedFiles.length > 0) {
    const rendered = await git(input.repoRoot, [
      "diff", "--no-ext-diff", "--no-textconv", "--binary", baseCommit, "--", ...trackedFiles.map((path) => `:(literal)${path}`),
    ]);
    if (rendered.exitCode !== 0) throw commandFailureError(rendered, "Failed to render scoped tracked changes");
    if (rendered.stdout.length > 0) patchSections.push(`${rendered.stdout}\n`);
  }
  for (const path of untrackedFiles) {
    const rendered = await git(input.repoRoot, [
      "diff", "--no-ext-diff", "--no-textconv", "--binary", "--no-index", "--", "/dev/null", path,
    ]);
    if (rendered.exitCode !== 0 && rendered.exitCode !== 1) {
      throw commandFailureError(rendered, `Failed to render scoped untracked file ${path}`);
    }
    if (rendered.stdout.length > 0) patchSections.push(`${rendered.stdout}\n`);
  }

  const patch = patchSections.join("");
  return {
    base_commit: baseCommit,
    head_commit: headCommit,
    changed_files: changedFiles,
    patch,
    patch_bytes: Buffer.byteLength(patch, "utf8"),
  };
}

export async function createIssueBranch(
  repoRoot: string,
  issueNumber: number,
  slug: string,
): Promise<string> {
  const branchName = `brain-hands/issue-${issueNumber}-${slug}`;
  const result = await git(repoRoot, ["switch", "-c", branchName]);

  if (result.exitCode !== 0) {
    throw commandFailureError(result, `Failed to create branch ${branchName}`);
  }

  return branchName;
}

export async function collectDiff(repoRoot: string, baseRef = "HEAD~1"): Promise<string> {
  const result = await git(repoRoot, ["diff", baseRef, "HEAD"]);
  if (result.exitCode !== 0) {
    throw commandFailureError(result, `Failed to collect diff from ${baseRef}`);
  }
  return result.stdout;
}
