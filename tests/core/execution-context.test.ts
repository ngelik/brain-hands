import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  runWithExecutionAuthority,
  runWithCheckoutAllocationAuthority,
  recordActiveExecutionChild,
  withCurrentExecutionEffect,
  type ExecutionAuthorityContext,
} from "../../src/core/execution-context.js";
import { runCommand } from "../../src/core/executor.js";
import { createRunWorktree, runWorktreeBranchName, runWorktreePath } from "../../src/adapters/git.js";
import {
  approvePlanRevision,
  markRunCheckoutReady,
  recordPlan,
  transitionRun,
} from "../../src/core/ledger.js";
import { acquireRunExecutionScope } from "../../src/workflow/runtime.js";
import { createLegacyRunLedgerV2 } from "../fixtures/legacy-run.js";

let root: string | null = null;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = null;
});

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await runCommand({ command: "git", args, cwd, timeoutMs: 10_000 });
  if (result.exitCode !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

async function runCrashedScopeScript(code: string): Promise<void> {
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
    cwd: process.cwd(),
    stdio: "inherit",
  });
  const [exitCode] = await once(child, "exit") as [number | null];
  if (exitCode !== 0) throw new Error(`Crashed-scope fixture exited ${exitCode ?? "without a code"}`);
}

function context(overrides: Partial<ExecutionAuthorityContext> = {}): ExecutionAuthorityContext {
  return {
    claim: { runDir: "/run", token: "token", epoch: 1, invocationId: "runtime" },
    assert: async () => {},
    beginEffect: async () => "effect",
    recordEffectChild: async () => {},
    endEffect: async () => {},
    ...overrides,
  };
}

describe("execution effect serialization", () => {
  it("releases the process queue when begin fails", async () => {
    let attempts = 0;
    const authority = context({
      beginEffect: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("begin failed");
        return `effect-${attempts}`;
      },
    });
    await runWithExecutionAuthority(authority, async () => {
      await expect(withCurrentExecutionEffect("first", async () => {})).rejects.toThrow("begin failed");
      await expect(withCurrentExecutionEffect("second", async () => "ok")).resolves.toBe("ok");
    });
  });

  it("releases the process queue when end fails", async () => {
    let ends = 0;
    const authority = context({
      endEffect: async () => {
        ends += 1;
        if (ends === 1) throw new Error("end failed");
      },
    });
    await runWithExecutionAuthority(authority, async () => {
      await expect(withCurrentExecutionEffect("first", async () => "first")).rejects.toThrow("end failed");
      await expect(withCurrentExecutionEffect("second", async () => "second")).resolves.toBe("second");
    });
  });

  it("leaves a child-binding failure tainted instead of clearing its durable effect", async () => {
    let ends = 0;
    const authority = context({
      recordEffectChild: async () => { throw new Error("child binding failed"); },
      endEffect: async () => { ends += 1; },
    });
    await runWithExecutionAuthority(authority, async () => {
      await expect(withCurrentExecutionEffect("spawn", async () => {
        await recordActiveExecutionChild(process.pid);
      })).rejects.toThrow("child binding failed");
    });
    expect(ends).toBe(0);
  });

  it("serializes concurrent top-level effects and nests grouped children", async () => {
    let active = 0;
    let maxActive = 0;
    const authority = context({
      beginEffect: async (kind) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        return kind;
      },
      endEffect: async () => { active -= 1; },
    });
    await runWithExecutionAuthority(authority, async () => {
      await Promise.all([
        withCurrentExecutionEffect("one", async () => new Promise((resolve) => setTimeout(resolve, 5))),
        withCurrentExecutionEffect("two", async () => {}),
      ]);
      await withCurrentExecutionEffect("browser", async () => {
        await withCurrentExecutionEffect("nested-server", async () => {});
        await withCurrentExecutionEffect("nested-chrome", async () => {});
      });
    });
    expect(maxActive).toBe(1);
  });

  it("revalidates a real pinned checkout before a command without deadlocking its effect queue", async () => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-execution-scope-"));
    await git(root, ["init"]);
    await git(root, ["config", "user.email", "test@example.invalid"]);
    await git(root, ["config", "user.name", "Brain Hands Test"]);
    await writeFile(join(root, "README.md"), "fixture\n", "utf8");
    await git(root, ["add", "README.md"]);
    await git(root, ["commit", "-m", "fixture"]);
    const sourceCommit = await git(root, ["rev-parse", "HEAD"]);
    const run = await createLegacyRunLedgerV2({
      repoRoot: root,
      originalRequest: "prove checkout effect ordering",
      sourceCommit,
    });
    await transitionRun(run.runDir, "preflight");
    await transitionRun(run.runDir, "brain_planning");
    await recordPlan(run.runDir, JSON.stringify({ work_items: [] }));
    await transitionRun(run.runDir, "awaiting_plan_approval");
    await approvePlanRevision(run.runDir, 1, { actor: "human" });
    await transitionRun(run.runDir, "worktree_setup");

    const worktreePath = runWorktreePath(root, run.runId);
    const branchName = runWorktreeBranchName(run.runId);
    await runCrashedScopeScript([
      "import { runWithCheckoutAllocationAuthority } from './src/core/execution-context.ts'",
      "import { acquireRunExecutionScope } from './src/workflow/runtime.ts'",
      "import { setRunCheckoutIdentity } from './src/core/ledger.ts'",
      `await runWithCheckoutAllocationAuthority(async () => { const scope = await acquireRunExecutionScope(${JSON.stringify(run.runDir)}); await scope.run(() => setRunCheckoutIdentity(${JSON.stringify(run.runDir)}, scope.claim, { worktreePath: ${JSON.stringify(worktreePath)}, branchName: ${JSON.stringify(branchName)} })) })`,
    ].join("; "));
    await runWithCheckoutAllocationAuthority(async () => {
      const beforeCreateRecovery = await acquireRunExecutionScope(run.runDir);
      try {
        await beforeCreateRecovery.run(() => createRunWorktree(root!, run.runId, sourceCommit));
        await beforeCreateRecovery.run(() => markRunCheckoutReady(run.runDir, beforeCreateRecovery.claim));
      } finally {
        await beforeCreateRecovery.release();
      }
    });
    await runCrashedScopeScript([
      "import { acquireRunExecutionScope } from './src/workflow/runtime.ts'",
      "import { runCommand } from './src/core/executor.ts'",
      `const scope = await acquireRunExecutionScope(${JSON.stringify(run.runDir)})`,
      `await scope.run(() => runCommand({ command: 'git', args: ['status', '--short'], cwd: ${JSON.stringify(worktreePath)}, timeoutMs: 10000 }))`,
    ].join("; "));
    const afterCreateRecovery = await acquireRunExecutionScope(run.runDir);
    try {
      await afterCreateRecovery.run(async () => {
        const completed = await Promise.race([
          runCommand({ command: "git", args: ["status", "--short"], cwd: worktreePath, timeoutMs: 10_000 }),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("effect queue deadlocked")), 8_000)),
        ]);
        expect(completed.exitCode).toBe(0);
      });
    } finally {
      await afterCreateRecovery.release();
    }
  }, 20_000);
});
