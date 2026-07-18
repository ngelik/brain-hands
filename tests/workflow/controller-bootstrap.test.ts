import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import * as gitAdapter from "../../src/adapters/git.js";

const execFileAsync = promisify(execFile);
const repositories: string[] = [];

async function git(repository: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", repository, ...args], { encoding: "utf8" });
  return result.stdout;
}

async function hash(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

afterEach(async () => {
  await Promise.all(repositories.splice(0).map((repository) => rm(repository, { recursive: true, force: true })));
});

describe("controller-owned worktree bootstrap", () => {
  it("merges and transfers exact bytes once before returning clean durable evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "brain-hands-bootstrap-"));
    repositories.push(root);
    await git(root, "init", "-q");
    await git(root, "config", "user.email", "test@example.com");
    await git(root, "config", "user.name", "Codex Test");
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src/cli.ts"), "baseline\n");
    await writeFile(join(root, "README.md"), "baseline\n");
    await git(root, "add", ".");
    await git(root, "commit", "-qm", "baseline");
    const baseline = (await git(root, "rev-parse", "HEAD")).trim();
    const baselineBranch = (await git(root, "branch", "--show-current")).trim();

    await git(root, "switch", "-qc", "preserved");
    await writeFile(join(root, "delivery.txt"), "preserved delivery\n");
    await git(root, "add", "delivery.txt");
    await git(root, "commit", "-qm", "preserved delivery");
    const preservedHead = (await git(root, "rev-parse", "HEAD")).trim();
    await git(root, "switch", "-q", baselineBranch);

    const sourceWorktree = join(root, ".brain-hands/worktrees/preserved-run");
    await mkdir(join(root, ".brain-hands/worktrees"), { recursive: true });
    await git(root, "worktree", "add", "--detach", sourceWorktree, preservedHead);
    await writeFile(join(sourceWorktree, "src/cli.ts"), "dirty tracked lifecycle\n");
    await writeFile(join(sourceWorktree, "src/session-lifecycle.ts"), "dirty untracked lifecycle\n");
    const trackedHash = await hash(join(sourceWorktree, "src/cli.ts"));
    const untrackedHash = await hash(join(sourceWorktree, "src/session-lifecycle.ts"));

    const run = await gitAdapter.createRunWorktree(root, "run-bootstrap", baseline);
    const runDir = join(root, ".brain-hands/runs/run-bootstrap");
    await mkdir(runDir, { recursive: true });
    const bootstrap = (gitAdapter as unknown as {
      runControllerBootstrap?: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
    }).runControllerBootstrap;
    expect(bootstrap).toBeTypeOf("function");
    if (bootstrap === undefined) return;

    const input = {
      runDir,
      repoRoot: root,
      worktreePath: run.worktreePath,
      sourceCommit: baseline,
      spec: {
        version: 1,
        baseline_commit: baseline,
        preserved_head: preservedHead,
        source_worktree: ".brain-hands/worktrees/preserved-run",
        commit_message: "controller-bootstrap: preserve lifecycle",
        files: [
          { path: "src/cli.ts", source_status: "tracked", sha256: trackedHash },
          { path: "src/session-lifecycle.ts", source_status: "untracked", sha256: untrackedHash },
        ],
      },
    };
    const evidence = await bootstrap(input);
    const firstHead = (await git(run.worktreePath, "rev-parse", "HEAD")).trim();

    expect(await readFile(join(run.worktreePath, "src/cli.ts"), "utf8")).toBe("dirty tracked lifecycle\n");
    expect(await readFile(join(run.worktreePath, "src/session-lifecycle.ts"), "utf8")).toBe("dirty untracked lifecycle\n");
    expect(await git(run.worktreePath, "status", "--short")).toBe("");
    await expect(git(run.worktreePath, "merge-base", "--is-ancestor", baseline, "HEAD")).resolves.toBe("");
    await expect(git(run.worktreePath, "merge-base", "--is-ancestor", preservedHead, "HEAD")).resolves.toBe("");
    expect(await hash(join(sourceWorktree, "src/cli.ts"))).toBe(trackedHash);
    expect(await hash(join(sourceWorktree, "src/session-lifecycle.ts"))).toBe(untrackedHash);
    expect(evidence).toMatchObject({
      version: 1,
      baseline_commit: baseline,
      preserved_head: preservedHead,
      bootstrap_commit: firstHead,
      files: [
        { path: "src/cli.ts", source_before_sha256: trackedHash, source_after_sha256: trackedHash, target_after_sha256: trackedHash },
        { path: "src/session-lifecycle.ts", source_before_sha256: untrackedHash, source_after_sha256: untrackedHash, target_after_sha256: untrackedHash },
      ],
    });
    expect(JSON.parse(await readFile(join(runDir, "controller-bootstrap/evidence.json"), "utf8"))).toEqual(evidence);

    expect(await bootstrap(input)).toEqual(evidence);
    expect((await git(run.worktreePath, "rev-parse", "HEAD")).trim()).toBe(firstHead);

    await rm(join(runDir, "controller-bootstrap/evidence.json"));
    await git(run.worktreePath, "reset", "--hard", String(evidence.merge_commit));
    const recovered = await bootstrap(input);
    expect(recovered).toMatchObject({
      merge_commit: evidence.merge_commit,
      files: evidence.files,
    });
    expect(await git(run.worktreePath, "status", "--short")).toBe("");
    expect(JSON.parse(await readFile(join(runDir, "controller-bootstrap/evidence.json"), "utf8"))).toEqual(recovered);
  });
});
