import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertCleanSourceCheckout,
  collectCommittedRecoveryEvidence,
  collectScopedWorktreeDiff,
  commitWorkItem,
  createRunWorktree,
  getWorktreeChangedFiles,
  prepareWorkItemCommitIntent,
  pushBranch,
  pushCommitToBranch,
  requireRemoteBranchAtLocalHead,
  resolveLocalCommitProvenance,
  restoreTrackedWorktreeFiles,
} from "../../src/adapters/git.js";
import type { WorkItem } from "../../src/core/types.js";

const execFileAsync = promisify(execFile);
let repositories: string[] = [];

afterEach(async () => {
  await Promise.all(repositories.map((repository) => rm(repository, { recursive: true, force: true })));
  repositories = [];
});

async function git(repository: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", repository, ...args], { encoding: "utf8" });
  return result.stdout;
}

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "brain-hands-git-"));
  repositories.push(root);
  await git(root, "init", "-q");
  await git(root, "config", "user.email", "test@example.com");
  await git(root, "config", "user.name", "Codex Test");
  await writeFile(join(root, "README.md"), "initial\n", "utf8");
  await git(root, "add", "README.md");
  await git(root, "commit", "-qm", "initial");
  return root;
}

function scopedWorkItem(fileContractPaths: string[], expectedChangedFiles: string[]): Pick<WorkItem, "file_contract" | "completion_contract"> {
  return {
    file_contract: fileContractPaths.map((path) => ({ path, permission: "modify", targets: ["test"] })),
    completion_contract: {
      expected_changed_files: expectedChangedFiles,
      allow_additional_files: false,
      required_acceptance_ids: ["AC-1"],
    },
  };
}

describe("scoped worktree diffs", () => {
  it("collects complete tracked, staged, untracked, deleted, and spaced-path patches within the work-item contract", async () => {
    const root = await repository();
    await writeFile(join(root, "tracked.txt"), "tracked before\n", "utf8");
    await writeFile(join(root, "staged.txt"), "staged before\n", "utf8");
    await writeFile(join(root, "deleted.txt"), "delete me\n", "utf8");
    await writeFile(join(root, "path with spaces.txt"), "spaces before\n", "utf8");
    await git(root, "add", "--", "tracked.txt", "staged.txt", "deleted.txt", "path with spaces.txt");
    await git(root, "commit", "-qm", "add scoped fixtures");
    const baseCommit = (await git(root, "rev-parse", "HEAD")).trim();

    await writeFile(join(root, "tracked.txt"), "tracked after\n", "utf8");
    await writeFile(join(root, "staged.txt"), "staged after\n", "utf8");
    await git(root, "add", "--", "staged.txt");
    await rm(join(root, "deleted.txt"));
    await writeFile(join(root, "path with spaces.txt"), "spaces after\n", "utf8");
    const untrackedTail = `untracked ${"é".repeat(4_096)} END-OF-PATCH\n`;
    await writeFile(join(root, "untracked.txt"), untrackedTail, "utf8");
    await writeFile(join(root, "--option-like.txt"), "argv separator protected\n", "utf8");
    await writeFile(join(root, "outside.txt"), "must be filtered\n", "utf8");

    const result = await collectScopedWorktreeDiff({
      repoRoot: root,
      baseCommit,
      workItem: scopedWorkItem(
        ["tracked.txt", "staged.txt", "deleted.txt", "path with spaces.txt", "untracked.txt", "--option-like.txt"],
        ["untracked.txt"],
      ),
    });

    expect(result.base_commit).toBe(baseCommit);
    expect(result.head_commit).toBe(baseCommit);
    expect(result.changed_files).toEqual([
      "--option-like.txt",
      "deleted.txt",
      "path with spaces.txt",
      "staged.txt",
      "tracked.txt",
      "untracked.txt",
    ]);
    expect(result.patch).toContain("-tracked before");
    expect(result.patch).toContain("+tracked after");
    expect(result.patch).toContain("+staged after");
    expect(result.patch).toContain("deleted file mode");
    expect(result.patch).toContain("path with spaces.txt");
    expect(result.patch).toContain("new file mode");
    expect(result.patch).toContain("argv separator protected");
    expect(result.patch).toContain("END-OF-PATCH");
    expect(result.patch).not.toContain("outside.txt");
    expect(result.patch.endsWith("\n")).toBe(true);
    expect(result.patch).not.toContain("\n\ndiff --git");
    expect(result.patch_bytes).toBe(Buffer.byteLength(result.patch, "utf8"));
    expect(result.patch_bytes).toBeGreaterThan(result.patch.length);
  });

  it("includes expected completion paths even when file_contract does not repeat them", async () => {
    const root = await repository();
    const baseCommit = (await git(root, "rev-parse", "HEAD")).trim();
    await writeFile(join(root, "completion-only.txt"), "completion contract\n", "utf8");

    const result = await collectScopedWorktreeDiff({
      repoRoot: root,
      baseCommit,
      workItem: scopedWorkItem(["README.md"], ["completion-only.txt"]),
    });

    expect(result.changed_files).toEqual(["completion-only.txt"]);
    expect(result.patch).toContain("completion contract");
  });

  it("treats approved file names as literal paths instead of widening Git pathspecs", async () => {
    const root = await repository();
    await writeFile(join(root, "*.txt"), "literal before\n", "utf8");
    await writeFile(join(root, ":(glob)*.txt"), "magic before\n", "utf8");
    await writeFile(join(root, "outside.txt"), "outside before\n", "utf8");
    await git(root, "add", "--", "*.txt", ":(glob)*.txt", "outside.txt");
    await git(root, "commit", "-qm", "add literal path fixture");
    const baseCommit = (await git(root, "rev-parse", "HEAD")).trim();
    await writeFile(join(root, "*.txt"), "literal after\n", "utf8");
    await writeFile(join(root, ":(glob)*.txt"), "magic after\n", "utf8");
    await writeFile(join(root, "outside.txt"), "outside secret\n", "utf8");

    const result = await collectScopedWorktreeDiff({
      repoRoot: root,
      baseCommit,
      workItem: scopedWorkItem(["*.txt", ":(glob)*.txt"], []),
    });

    expect(result.changed_files).toEqual(["*.txt", ":(glob)*.txt"]);
    expect(result.patch).toContain("literal after");
    expect(result.patch).toContain("magic after");
    expect(result.patch).not.toContain("outside secret");
  });

  it("does not invoke a configured textconv helper and retains the binary Git patch", async () => {
    const root = await repository();
    const helper = join(root, "textconv-helper.sh");
    const marker = join(root, "textconv-invoked.txt");
    await writeFile(helper, `#!/bin/sh\nprintf invoked > '${marker}'\nprintf TEXTCONV\n`, "utf8");
    await chmod(helper, 0o755);
    await writeFile(join(root, ".gitattributes"), "binary.dat diff=scoped-test\n", "utf8");
    await writeFile(join(root, "binary.dat"), Buffer.from([0, 1, 2, 3, 4, 5]), { flag: "w" });
    await git(root, "add", "--", ".gitattributes", "binary.dat");
    await git(root, "commit", "-qm", "add binary fixture");
    const baseCommit = (await git(root, "rev-parse", "HEAD")).trim();
    await git(root, "config", "diff.scoped-test.textconv", helper);
    await writeFile(join(root, "binary.dat"), Buffer.from([0, 9, 8, 7, 6, 5]), { flag: "w" });

    const result = await collectScopedWorktreeDiff({
      repoRoot: root,
      baseCommit,
      workItem: scopedWorkItem(["binary.dat"], []),
    });

    await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(result.patch).toContain("GIT binary patch");
    expect(result.patch).not.toContain("TEXTCONV");
    expect(result.patch.endsWith("\n")).toBe(true);
  });

  it("fails closed when a directory-like contract path matches undeclared descendants", async () => {
    const root = await repository();
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src/a.ts"), "before\n", "utf8");
    await git(root, "add", "--", "src/a.ts");
    await git(root, "commit", "-qm", "add descendant fixture");
    const baseCommit = (await git(root, "rev-parse", "HEAD")).trim();
    await writeFile(join(root, "src/a.ts"), "after\n", "utf8");
    await writeFile(join(root, "src/b.ts"), "untracked\n", "utf8");

    await expect(collectScopedWorktreeDiff({
      repoRoot: root,
      baseCommit,
      workItem: scopedWorkItem(["src"], []),
    })).rejects.toThrow(/outside the exact approved contract.*src\/a\.ts.*src\/b\.ts/i);
  });

  it("collects committed and worktree divergence from a base older than HEAD", async () => {
    const root = await repository();
    const baseCommit = (await git(root, "rev-parse", "HEAD")).trim();
    await writeFile(join(root, "README.md"), "committed intermediate\n", "utf8");
    await git(root, "add", "--", "README.md");
    await git(root, "commit", "-qm", "advance head");
    const headCommit = (await git(root, "rev-parse", "HEAD")).trim();
    await writeFile(join(root, "README.md"), "final worktree value\n", "utf8");

    const result = await collectScopedWorktreeDiff({
      repoRoot: root,
      baseCommit,
      workItem: scopedWorkItem(["README.md"], []),
    });

    expect(result.base_commit).toBe(baseCommit);
    expect(result.head_commit).toBe(headCommit);
    expect(result.head_commit).not.toBe(result.base_commit);
    expect(result.patch).toContain("-initial");
    expect(result.patch).toContain("+final worktree value");
    expect(result.patch).not.toContain("committed intermediate");
  });

  it("requires the complete canonical object ID in SHA-256 repositories", async (context) => {
    const root = await mkdtemp(join(tmpdir(), "brain-hands-git-sha256-"));
    repositories.push(root);
    try {
      await execFileAsync("git", ["init", "-q", "--object-format=sha256", root], { encoding: "utf8" });
    } catch (error) {
      const stderr = String((error as { stderr?: unknown }).stderr ?? "");
      if (/unknown option|unknown hash algorithm|not supported/i.test(stderr)) {
        context.skip();
        return;
      }
      throw error;
    }
    await git(root, "config", "user.email", "test@example.com");
    await git(root, "config", "user.name", "Codex Test");
    await writeFile(join(root, "sha256.txt"), "before\n", "utf8");
    await git(root, "add", "--", "sha256.txt");
    await git(root, "commit", "-qm", "sha256 initial");
    const fullCommit = (await git(root, "rev-parse", "HEAD")).trim();
    expect(fullCommit).toHaveLength(64);
    await writeFile(join(root, "sha256.txt"), "after\n", "utf8");

    await expect(collectScopedWorktreeDiff({
      repoRoot: root,
      baseCommit: fullCommit.slice(0, 40),
      workItem: scopedWorkItem(["sha256.txt"], []),
    })).rejects.toThrow(/full Git object ID/i);
    await expect(collectScopedWorktreeDiff({
      repoRoot: root,
      baseCommit: fullCommit,
      workItem: scopedWorkItem(["sha256.txt"], []),
    })).resolves.toMatchObject({ base_commit: fullCommit });
  });

  it.each([
    "../escape.txt",
    "/absolute.txt",
    ".git/config",
    "nested/../../escape.txt",
    "C:/absolute.txt",
    "C:\\absolute.txt",
    "\\\\server\\share.txt",
    "\\\\?\\C:\\device.txt",
    "control\u001f.txt",
    "control\u0085.txt",
  ])(
    "rejects unsafe repository-relative contract path %s",
    async (unsafePath) => {
      const root = await repository();
      const baseCommit = (await git(root, "rev-parse", "HEAD")).trim();

      await expect(collectScopedWorktreeDiff({
        repoRoot: root,
        baseCommit,
        workItem: scopedWorkItem([unsafePath], []),
      })).rejects.toThrow(/repository-relative contract path/i);
    },
  );
});

describe("run worktrees", () => {
  it("rejects a dirty source before worktree allocation", async () => {
    const root = await repository();
    await writeFile(join(root, "dirty.txt"), "dirty\n", "utf8");

    await expect(createRunWorktree(root, "run-dirty")).rejects.toThrow(/clean/i);
    await expect(git(root, "worktree", "list", "--porcelain")).resolves.not.toContain("run-dirty");
  });

  it("creates the deterministic branch and records its resolved path", async () => {
    const root = await repository();
    const run = await createRunWorktree(root, "run-1");

    expect(run.worktreePath).toBe(join(root, ".brain-hands", "worktrees", "run-1"));
    expect(run.branchName).toBe("codex/brain-hands/run-1");
    expect(await git(root, "branch", "--list", run.branchName)).toContain(run.branchName);
  });

  it("creates the worktree from the run-pinned source commit", async () => {
    const root = await repository();
    const sourceCommit = (await git(root, "rev-parse", "HEAD")).trim();
    await writeFile(join(root, "README.md"), "later\n", "utf8");
    await git(root, "add", "README.md");
    await git(root, "commit", "-qm", "later");

    const run = await createRunWorktree(root, "run-pinned", sourceCommit);

    expect((await git(run.worktreePath, "rev-parse", "HEAD")).trim()).toBe(sourceCommit);
    await expect(readFile(join(run.worktreePath, "README.md"), "utf8")).resolves.toBe("initial\n");
  });

  it("exposes existing ignored node modules inside the isolated worktree", async () => {
    const root = await repository();
    await writeFile(join(root, ".gitignore"), "node_modules/\n", "utf8");
    await mkdir(join(root, "node_modules", "vitest"), { recursive: true });
    await writeFile(join(root, "node_modules", "vitest", "vitest.mjs"), "export {};\n", "utf8");
    await git(root, "add", ".gitignore");
    await git(root, "commit", "-qm", "ignore dependencies");

    const run = await createRunWorktree(root, "run-dependencies");

    expect((await lstat(join(run.worktreePath, "node_modules"))).isDirectory()).toBe(true);
    expect((await lstat(join(run.worktreePath, "node_modules", "vitest"))).isSymbolicLink()).toBe(true);
    await expect(readFile(join(run.worktreePath, "node_modules", "vitest", "vitest.mjs"), "utf8"))
      .resolves.toBe("export {};\n");
    expect(await git(run.worktreePath, "status", "--short")).toBe("");
  });

  it("rejects an existing destination", async () => {
    const root = await repository();
    await mkdir(join(root, ".brain-hands", "worktrees", "run-existing"), { recursive: true });

    await expect(createRunWorktree(root, "run-existing")).rejects.toThrow(/already exists/i);
  });

  it("commits only approved work with a stable work-item message", async () => {
    const root = await repository();
    const run = await createRunWorktree(root, "run-commit");
    await writeFile(join(run.worktreePath, "change.txt"), "change\n", "utf8");

    await expect(commitWorkItem(run.worktreePath, "", "", false)).rejects.toThrow(/approval/i);
    const sha = await commitWorkItem(run.worktreePath, "WI-1", "Safe change", true);
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(await git(run.worktreePath, "log", "-1", "--format=%s")).toBe("work-item: WI-1 Safe change\n");
    await expect(readFile(join(run.worktreePath, "change.txt"), "utf8")).resolves.toBe("change\n");
  });

  it("lists tracked and untracked worktree paths without rewriting valid whitespace", async () => {
    const root = await repository();
    await writeFile(join(root, "README.md"), "changed\n", "utf8");
    await writeFile(join(root, " leading.txt"), "untracked\n", "utf8");

    await expect(getWorktreeChangedFiles(root)).resolves.toEqual([
      "README.md",
      " leading.txt",
    ]);
  });

  it("captures exact commit/tree and current blob evidence for recovery", async () => {
    const root = await repository();
    const base = (await git(root, "rev-parse", "HEAD")).trim();
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src/fixed.ts"), "export const fixed = true;\n", "utf8");
    await git(root, "add", "src/fixed.ts");
    await git(root, "commit", "-qm", "commit recovered action");
    const evidence = await collectCommittedRecoveryEvidence({ repoRoot: root, baseCommit: base, paths: ["src/fixed.ts"] });
    expect(evidence.head_parents).toEqual([base]);
    expect(evidence.changed_files).toEqual(["src/fixed.ts"]);
    expect(evidence.path_blobs).toEqual([{
      path: "src/fixed.ts",
      head_blob: expect.stringMatching(/^[a-f0-9]{40}$/),
      worktree_blob: expect.stringMatching(/^[a-f0-9]{40}$/),
    }]);
    expect(evidence.path_blobs[0]!.head_blob).toBe(evidence.path_blobs[0]!.worktree_blob);
  });

  it("restores only tracked worktree paths and preserves untracked files", async () => {
    const root = await repository();
    await writeFile(join(root, "stale.txt"), "before\n", "utf8");
    await git(root, "add", "--", "stale.txt");
    await git(root, "commit", "-qm", "add stale fixture");
    await writeFile(join(root, "stale.txt"), "after\n", "utf8");
    await writeFile(join(root, "untracked.txt"), "preserve\n", "utf8");

    await expect(restoreTrackedWorktreeFiles(root, ["stale.txt", "untracked.txt"]))
      .resolves.toEqual(["stale.txt"]);
    await expect(readFile(join(root, "stale.txt"), "utf8")).resolves.toBe("before\n");
    await expect(readFile(join(root, "untracked.txt"), "utf8")).resolves.toBe("preserve\n");
    await expect(getWorktreeChangedFiles(root)).resolves.toEqual(["untracked.txt"]);
  });

  it("records the exact parent, message, and intended tree for commit replay validation", async () => {
    const root = await repository();
    const run = await createRunWorktree(root, "run-intent");
    const parentSha = (await git(run.worktreePath, "rev-parse", "HEAD")).trim();
    await writeFile(join(run.worktreePath, "change.txt"), "change\n", "utf8");

    const intent = await prepareWorkItemCommitIntent(run.worktreePath, "WI-1", "Safe change");
    const sha = await commitWorkItem(run.worktreePath, "WI-1", "Safe change", true);
    const committed = await resolveLocalCommitProvenance(run.worktreePath, sha);

    expect(intent).toEqual({
      parent_sha: parentSha,
      tree_sha: committed.tree_sha,
      message: "work-item: WI-1 Safe change",
    });
    expect(committed).toEqual({
      sha,
      parent_shas: [parentSha],
      tree_sha: intent.tree_sha,
      message: intent.message,
    });
  });

  it("pushes a validated branch and rejects option-like refs", async () => {
    const root = await repository();
    const remote = await mkdtemp(join(tmpdir(), "brain-hands-remote-"));
    repositories.push(remote);
    await git(remote, "init", "--bare", "-q");
    await git(root, "remote", "add", "origin", remote);
    const run = await createRunWorktree(root, "run-push");
    await writeFile(join(run.worktreePath, "push.txt"), "push\n", "utf8");
    await commitWorkItem(run.worktreePath, "WI-push", "Push change", true);

    await expect(pushBranch(run.worktreePath, run.branchName)).resolves.toBeDefined();
    await expect(pushBranch(run.worktreePath, "--delete")).rejects.toThrow(/branch name/i);
    await expect(pushBranch(run.worktreePath, "+main")).rejects.toThrow(/branch name/i);
    await expect(pushBranch(run.worktreePath, run.branchName, "--upload-pack=evil")).rejects.toThrow(/remote name/i);
    await expect(pushBranch(run.worktreePath, "refs/heads/foo:refs/heads/bar")).rejects.toThrow(/branch name/i);
  });

  it("pushes an immutable expected commit when the local branch advances", async () => {
    const root = await repository();
    const remote = await mkdtemp(join(tmpdir(), "brain-hands-remote-"));
    repositories.push(remote);
    await git(remote, "init", "--bare", "-q");
    await git(root, "remote", "add", "origin", remote);
    const run = await createRunWorktree(root, "run-push-commit");
    await writeFile(join(run.worktreePath, "intended.txt"), "intended\n", "utf8");
    const intendedSha = await commitWorkItem(run.worktreePath, "WI-intended", "Intended", true);
    await writeFile(join(run.worktreePath, "unrelated.txt"), "unrelated\n", "utf8");
    const unrelatedSha = await commitWorkItem(run.worktreePath, "WI-unrelated", "Unrelated", true);

    await pushCommitToBranch(run.worktreePath, intendedSha, run.branchName, null);

    expect(unrelatedSha).not.toBe(intendedSha);
    expect((await git(remote, "rev-parse", `refs/heads/${run.branchName}`)).trim()).toBe(intendedSha);
  });

  it("rejects an immutable commit push when the remote moved behind its durable lease", async () => {
    const root = await repository();
    const remote = await mkdtemp(join(tmpdir(), "brain-hands-remote-"));
    repositories.push(remote);
    await git(remote, "init", "--bare", "-q");
    await git(root, "remote", "add", "origin", remote);
    const run = await createRunWorktree(root, "run-push-lease");
    const olderSha = (await git(run.worktreePath, "rev-parse", "HEAD")).trim();
    await writeFile(join(run.worktreePath, "before.txt"), "before\n", "utf8");
    const durableBeforeSha = await commitWorkItem(run.worktreePath, "WI-before", "Before", true);
    await git(run.worktreePath, "push", "origin", `${durableBeforeSha}:refs/heads/${run.branchName}`);
    await writeFile(join(run.worktreePath, "expected.txt"), "expected\n", "utf8");
    const expectedSha = await commitWorkItem(run.worktreePath, "WI-expected", "Expected", true);
    await git(run.worktreePath, "push", "--force", "origin", `${olderSha}:refs/heads/${run.branchName}`);

    await expect(pushCommitToBranch(
      run.worktreePath,
      expectedSha,
      run.branchName,
      durableBeforeSha,
    )).rejects.toThrow(/atomic remote lease/i);
    expect((await git(remote, "rev-parse", `refs/heads/${run.branchName}`)).trim()).toBe(olderSha);
  });

  it("requires an existing remote PR branch to equal local HEAD before commit intent", async () => {
    const root = await repository();
    const remote = await mkdtemp(join(tmpdir(), "brain-hands-remote-"));
    repositories.push(remote);
    await git(remote, "init", "--bare", "-q");
    await git(root, "remote", "add", "origin", remote);
    const run = await createRunWorktree(root, "run-aligned-remote");
    const remoteSha = (await git(run.worktreePath, "rev-parse", "HEAD")).trim();
    await git(run.worktreePath, "push", "origin", `${remoteSha}:refs/heads/${run.branchName}`);
    await writeFile(join(run.worktreePath, "local-only.txt"), "local\n", "utf8");
    await commitWorkItem(run.worktreePath, "WI-local", "Local", true);

    await expect(requireRemoteBranchAtLocalHead(run.worktreePath, run.branchName)).rejects.toThrow(/does not equal local head/i);
    expect((await git(remote, "rev-parse", `refs/heads/${run.branchName}`)).trim()).toBe(remoteSha);

    await git(remote, "update-ref", "-d", `refs/heads/${run.branchName}`);
    await expect(requireRemoteBranchAtLocalHead(run.worktreePath, run.branchName)).rejects.toThrow(/does not exist/i);
    await expect(git(remote, "show-ref", `refs/heads/${run.branchName}`)).rejects.toBeDefined();
  });
});
