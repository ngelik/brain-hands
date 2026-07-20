import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createRunLedgerV2,
  readManifestV2,
  recordTerminalDisposition,
  withRunLedgerCompoundTransaction,
} from "../../src/core/ledger.js";
import {
  assertApprovalControllerMatches,
  assertCurrentControllerMatches,
  captureControllerProvenance,
  hashRuntimeTree,
} from "../../src/core/controller-provenance.js";
import { abandonRun } from "../../src/workflow/assurance.js";
import { execa } from "execa";
import type { ControllerProvenance } from "../../src/core/types.js";
import {
  reconcileControllerRecovery,
  recordControllerRecovery,
} from "../../src/workflow/controller-recovery.js";

vi.mock("../../src/core/controller-provenance.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/core/controller-provenance.js")>();
  return { ...actual, captureControllerProvenance: vi.fn(actual.captureControllerProvenance) };
});

const roots: string[] = [];

async function packageFixture(bytes = "first\n"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "brain-hands-controller-recovery-package-"));
  roots.push(root);
  await mkdir(join(root, "dist"), { recursive: true });
  await mkdir(join(root, "prompts"));
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "@ngelik/brain-hands", version: "0.3.5" }));
  await writeFile(join(root, "dist", "cli.js"), bytes);
  await writeFile(join(root, "prompts", "brain.md"), "prompt\n");
  await writeFile(join(root, "agentic-codex-workflow.md"), "workflow\n");
  await writeFile(join(root, "README.md"), "readme\n");
  return root;
}

function provenance(packageRoot: string, packageHash: string): ControllerProvenance {
  return {
    self_hosting: true,
    mode: "development_checkout",
    executable_path: join(packageRoot, "dist", "cli.js"),
    package_root: packageRoot,
    package_name: "@ngelik/brain-hands",
    package_version: "0.3.5",
    package_hash_algorithm: "sha256",
    package_hash: packageHash,
    candidate_commit: "a".repeat(40),
  };
}

function exposeCurrent(current: ControllerProvenance): void {
  vi.mocked(captureControllerProvenance).mockResolvedValue({ provenance: current, selfHosting: true });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("controller recovery", () => {
  it("accepts the recovered controller at the plan approval boundary", async () => {
    const repoRoot = await packageFixture();
    const original = provenance(repoRoot, "a".repeat(64));
    const ledger = await createRunLedgerV2({
      repoRoot,
      originalRequest: "recover approval controller",
      sourceCommit: original.candidate_commit,
      controllerProvenance: original,
    });
    const current = { ...original, package_hash: "b".repeat(64) };
    exposeCurrent(current);
    const recovered = await recordControllerRecovery({
      runDir: ledger.runDir,
      actor: "operator@example.test",
      reason: "Install reviewed approval controller bytes",
      expectedPackageSha256: current.package_hash,
    });

    await expect(withRunLedgerCompoundTransaction(ledger.runDir, async (transaction) =>
      assertApprovalControllerMatches(
        transaction.runDir,
        await transaction.readManifestV2(),
        async () => ({ provenance: current, selfHosting: true }),
      ))).resolves.toBeUndefined();
  });

  it("rejects a wrong expected hash without mutating the run", async () => {
    const repoRoot = await packageFixture();
    const original = provenance(repoRoot, "a".repeat(64));
    const ledger = await createRunLedgerV2({
      repoRoot,
      originalRequest: "recover controller",
      sourceCommit: original.candidate_commit,
      controllerProvenance: original,
    });
    const before = await readFile(join(ledger.runDir, "manifest.json"), "utf8");
    exposeCurrent({ ...original, package_hash: "c".repeat(64) });

    await expect(recordControllerRecovery({
      runDir: ledger.runDir,
      actor: "operator@example.test",
      reason: "Install reviewed bytes",
      expectedPackageSha256: "b".repeat(64),
    })).rejects.toThrow(/expected.*package.*hash/i);

    expect(await readFile(join(ledger.runDir, "manifest.json"), "utf8")).toBe(before);
    await expect(readFile(join(ledger.runDir, "events.jsonl"), "utf8")).resolves.toBe("");
  });

  it("records a same-version different-hash transition without changing workflow state", async () => {
    const repoRoot = await packageFixture();
    const original = provenance(repoRoot, "a".repeat(64));
    const ledger = await createRunLedgerV2({
      repoRoot,
      originalRequest: "recover controller",
      sourceCommit: original.candidate_commit,
      controllerProvenance: original,
      worktreePath: "/tmp/worktree",
      branchName: "feature/controller",
      githubIds: { issueNumbers: [11], pullRequestNumbers: [22] },
    });
    const before = await readManifestV2(ledger.runDir);
    const current = { ...original, package_hash: "b".repeat(64), executable_path: "/new/cli.js", package_root: "/new" };
    exposeCurrent(current);

    const result = await recordControllerRecovery({
      runDir: ledger.runDir,
      actor: "operator@example.test",
      reason: "Install reviewed bytes",
      expectedPackageSha256: current.package_hash,
    });

    expect(result.artifact.sequence).toBe(1);
    expect(result.manifest.controller_recovery).toEqual({
      version: 1,
      transition_count: 1,
      head_path: result.artifact_path,
    });
    expect(result.manifest).toMatchObject({
      source_commit: before.source_commit,
      worktree_path: before.worktree_path,
      branch_name: before.branch_name,
      issue_numbers: before.issue_numbers,
      pull_request_numbers: before.pull_request_numbers,
      github_ids: before.github_ids,
      plan_revisions: before.plan_revisions,
      approved_revision: before.approved_revision,
    });
    const { updated_at: _beforeUpdated, controller_recovery: _beforeRecovery, execution_epoch: _beforeEpoch, ...beforeWorkflow } = before;
    const { updated_at: _afterUpdated, controller_recovery: _afterRecovery, execution_epoch: _afterEpoch, ...afterWorkflow } = result.manifest;
    expect(afterWorkflow).toEqual(beforeWorkflow);
    await expect(recordControllerRecovery({
      runDir: ledger.runDir,
      actor: "operator@example.test",
      reason: "redundant",
      expectedPackageSha256: current.package_hash,
    })).rejects.toThrow(/redundant|already accepted/i);
  });

  it("reconciles an interruption after the immutable transition artifact", async () => {
    const repoRoot = await packageFixture();
    const original = provenance(repoRoot, "a".repeat(64));
    const ledger = await createRunLedgerV2({
      repoRoot,
      originalRequest: "recover controller",
      sourceCommit: original.candidate_commit,
      controllerProvenance: original,
    });
    const current = { ...original, package_hash: "b".repeat(64) };
    exposeCurrent(current);

    await expect(recordControllerRecovery({
      runDir: ledger.runDir,
      actor: "operator@example.test",
      reason: "Install reviewed bytes",
      expectedPackageSha256: current.package_hash,
      hooks: { afterTransitionArtifact: async () => { throw new Error("interrupt"); } },
    })).rejects.toThrow("interrupt");

    const reconciled = await reconcileControllerRecovery(ledger.runDir);
    expect(reconciled.controller_recovery.transition_count).toBe(1);
    const events = (await readFile(join(ledger.runDir, "events.jsonl"), "utf8")).trim().split("\n");
    expect(events).toHaveLength(1);
  });

  it("checks the expected package hash before reconciling an interrupted transition", async () => {
    const repoRoot = await packageFixture();
    const original = provenance(repoRoot, "a".repeat(64));
    const ledger = await createRunLedgerV2({
      repoRoot,
      originalRequest: "recover controller",
      sourceCommit: original.candidate_commit,
      controllerProvenance: original,
    });
    exposeCurrent({ ...original, package_hash: "b".repeat(64) });
    await expect(recordControllerRecovery({
      runDir: ledger.runDir,
      actor: "operator@example.test",
      reason: "Install reviewed bytes",
      expectedPackageSha256: "b".repeat(64),
      hooks: { afterTransitionArtifact: async () => { throw new Error("interrupt"); } },
    })).rejects.toThrow("interrupt");
    const manifestBefore = await readFile(join(ledger.runDir, "manifest.json"), "utf8");
    const eventsBefore = await readFile(join(ledger.runDir, "events.jsonl"), "utf8");
    exposeCurrent({ ...original, package_hash: "c".repeat(64) });

    await expect(recordControllerRecovery({
      runDir: ledger.runDir,
      actor: "operator@example.test",
      reason: "Wrong expected bytes",
      expectedPackageSha256: "d".repeat(64),
    })).rejects.toThrow(/expected.*package/i);

    expect(await readFile(join(ledger.runDir, "manifest.json"), "utf8")).toBe(manifestBefore);
    expect(await readFile(join(ledger.runDir, "events.jsonl"), "utf8")).toBe(eventsBefore);
  });

  it("fails closed when only the deterministic transition event stage is tampered", async () => {
    const repoRoot = await packageFixture();
    const original = provenance(repoRoot, "a".repeat(64));
    const ledger = await createRunLedgerV2({
      repoRoot,
      originalRequest: "recover controller",
      sourceCommit: original.candidate_commit,
      controllerProvenance: original,
    });
    exposeCurrent({ ...original, package_hash: "b".repeat(64) });
    await recordControllerRecovery({
      runDir: ledger.runDir,
      actor: "operator@example.test",
      reason: "Install reviewed bytes",
      expectedPackageSha256: "b".repeat(64),
    });
    const eventsPath = join(ledger.runDir, "events.jsonl");
    const event = JSON.parse((await readFile(eventsPath, "utf8")).trim()) as Record<string, unknown>;
    event.stage = "delivery";
    await writeFile(eventsPath, `${JSON.stringify(event)}\n`);

    await expect(reconcileControllerRecovery(ledger.runDir)).rejects.toThrow(/event.*stage|event.*conflict/i);
  });

  it("reconstructs the artifact-bound stage after the manifest stage changes", async () => {
    const repoRoot = await packageFixture();
    const original = provenance(repoRoot, "a".repeat(64));
    const ledger = await createRunLedgerV2({
      repoRoot,
      originalRequest: "recover controller",
      sourceCommit: original.candidate_commit,
      controllerProvenance: original,
    });
    exposeCurrent({ ...original, package_hash: "b".repeat(64) });
    let transitionStage: string | undefined;
    await expect(recordControllerRecovery({
      runDir: ledger.runDir,
      actor: "operator@example.test",
      reason: "Install reviewed bytes",
      expectedPackageSha256: "b".repeat(64),
      hooks: {
        afterTransitionArtifact: async () => {
          const [name] = await readdir(join(ledger.runDir, "controller-recovery", "transitions"));
          const artifact = JSON.parse(await readFile(join(ledger.runDir, "controller-recovery", "transitions", name!), "utf8")) as { stage?: string };
          transitionStage = artifact.stage;
          throw new Error("interrupt");
        },
      },
    })).rejects.toThrow("interrupt");
    await import("../../src/core/ledger.js").then(({ updateManifestV2 }) => updateManifestV2(ledger.runDir, { stage: "preflight" }));

    await reconcileControllerRecovery(ledger.runDir);
    const event = JSON.parse((await readFile(join(ledger.runDir, "events.jsonl"), "utf8")).trim()) as { stage: string };
    expect(transitionStage).toBe("intake");
    expect(event.stage).toBe("intake");
  });

  it("normalizes padded actor and reason once into a reconcilable transition", async () => {
    const repoRoot = await packageFixture();
    const original = provenance(repoRoot, "a".repeat(64));
    const ledger = await createRunLedgerV2({
      repoRoot,
      originalRequest: "recover controller",
      sourceCommit: original.candidate_commit,
      controllerProvenance: original,
    });
    exposeCurrent({ ...original, package_hash: "b".repeat(64) });

    const recorded = await recordControllerRecovery({
      runDir: ledger.runDir,
      actor: "  operator@example.test  ",
      reason: "  Install reviewed bytes  ",
      expectedPackageSha256: "b".repeat(64),
    });
    await expect(reconcileControllerRecovery(ledger.runDir)).resolves.toMatchObject({
      controller_recovery: { transition_count: 1 },
    });
    const event = JSON.parse((await readFile(join(ledger.runDir, "events.jsonl"), "utf8")).trim()) as { actor: string };
    expect(recorded.artifact.actor).toBe("operator@example.test");
    expect(recorded.artifact.reason).toBe("Install reviewed bytes");
    expect(event.actor).toBe(recorded.artifact.actor);
  });

  it("rejects a blank actor before any transition write", async () => {
    const repoRoot = await packageFixture();
    const original = provenance(repoRoot, "a".repeat(64));
    const ledger = await createRunLedgerV2({
      repoRoot,
      originalRequest: "recover controller",
      sourceCommit: original.candidate_commit,
      controllerProvenance: original,
    });
    exposeCurrent({ ...original, package_hash: "b".repeat(64) });
    const manifestBefore = await readFile(join(ledger.runDir, "manifest.json"), "utf8");

    await expect(recordControllerRecovery({
      runDir: ledger.runDir,
      actor: "   ",
      reason: "Install reviewed bytes",
      expectedPackageSha256: "b".repeat(64),
    })).rejects.toThrow(/actor.*non-empty/i);

    expect(await readFile(join(ledger.runDir, "manifest.json"), "utf8")).toBe(manifestBefore);
    expect(await readFile(join(ledger.runDir, "events.jsonl"), "utf8")).toBe("");
    expect(await readdir(join(ledger.runDir, "controller-recovery", "transitions"))).toEqual([]);
  });

  it("blocks an unrecorded controller change before and after a valid transition", async () => {
    const repoRoot = await packageFixture();
    await execa("git", ["init", "-q"], { cwd: repoRoot });
    await execa("git", ["config", "user.email", "brain-hands@example.test"], { cwd: repoRoot });
    await execa("git", ["config", "user.name", "Brain Hands"], { cwd: repoRoot });
    await execa("git", ["add", "."], { cwd: repoRoot });
    await execa("git", ["commit", "-qm", "candidate"], { cwd: repoRoot });
    const candidateHead = (await execa("git", ["rev-parse", "HEAD"], { cwd: repoRoot })).stdout;
    const packageMetadata = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8")) as { version: string };
    const current: ControllerProvenance = {
      self_hosting: true,
      mode: "development_checkout",
      executable_path: join(process.cwd(), "dist", "cli.js"),
      package_root: process.cwd(),
      package_name: "@ngelik/brain-hands",
      package_version: packageMetadata.version,
      package_hash_algorithm: "sha256",
      package_hash: await hashRuntimeTree(process.cwd()),
      candidate_commit: candidateHead,
    };
    const original = { ...current, package_hash: "a".repeat(64) };
    const ledger = await createRunLedgerV2({
      repoRoot,
      originalRequest: "recover controller",
      sourceCommit: original.candidate_commit,
      controllerProvenance: original,
    });
    exposeCurrent(current);
    const previousEntrypoint = process.argv[1];
    const previousMode = process.env.BRAIN_HANDS_CONTROLLER_MODE;
    process.argv[1] = join(process.cwd(), "dist", "cli.js");
    process.env.BRAIN_HANDS_CONTROLLER_MODE = "development_checkout";
    try {
      await expect(assertCurrentControllerMatches(ledger.runDir, await readManifestV2(ledger.runDir)))
        .rejects.toThrow(/does not match/i);
      await recordControllerRecovery({
        runDir: ledger.runDir,
        actor: "operator@example.test",
        reason: "Install reviewed bytes",
        expectedPackageSha256: current.package_hash,
      });
      await expect(assertCurrentControllerMatches(ledger.runDir, await readManifestV2(ledger.runDir)))
        .resolves.toBeUndefined();

      const unrecordedPackage = await packageFixture("unrecorded change\n");
      process.argv[1] = join(unrecordedPackage, "dist", "cli.js");
      await expect(assertCurrentControllerMatches(ledger.runDir, await readManifestV2(ledger.runDir)))
        .rejects.toThrow(/does not match/i);
    } finally {
      process.argv[1] = previousEntrypoint;
      if (previousMode === undefined) delete process.env.BRAIN_HANDS_CONTROLLER_MODE;
      else process.env.BRAIN_HANDS_CONTROLLER_MODE = previousMode;
    }
  });

  it.each(["closed_blocked", "abandoned"] as const)("rejects a transition for a %s run", async (outcome) => {
    const repoRoot = await packageFixture();
    const original = provenance(repoRoot, "a".repeat(64));
    const ledger = await createRunLedgerV2({
      repoRoot,
      originalRequest: "recover controller",
      sourceCommit: original.candidate_commit,
      controllerProvenance: original,
    });
    if (outcome === "abandoned") await abandonRun(ledger.runDir, "operator@example.test", "No longer required");
    else {
      await import("../../src/core/ledger.js").then(({ updateManifestV2 }) => updateManifestV2(ledger.runDir, {
        delivery_state: "blocked",
      }));
      await recordTerminalDisposition(ledger.runDir, {
      outcome,
      actor: "human",
      reason: "closed",
      residual_risks: [],
      });
    }
    exposeCurrent({ ...original, package_hash: "b".repeat(64) });

    await expect(recordControllerRecovery({
      runDir: ledger.runDir,
      actor: "operator@example.test",
      reason: "Install reviewed bytes",
      expectedPackageSha256: "b".repeat(64),
    })).rejects.toThrow(/terminal|abandoned/i);
  });

  it("fails closed when a chained previous subject is tampered", async () => {
    const repoRoot = await packageFixture();
    const original = provenance(repoRoot, "a".repeat(64));
    const ledger = await createRunLedgerV2({
      repoRoot,
      originalRequest: "recover controller",
      sourceCommit: original.candidate_commit,
      controllerProvenance: original,
    });
    exposeCurrent({ ...original, package_hash: "b".repeat(64) });
    const transition = await recordControllerRecovery({
      runDir: ledger.runDir,
      actor: "operator@example.test",
      reason: "Install reviewed bytes",
      expectedPackageSha256: "b".repeat(64),
    });
    const path = join(ledger.runDir, transition.artifact_path);
    const artifact = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    artifact.previous_subject_sha256 = "f".repeat(64);
    await writeFile(path, `${JSON.stringify(artifact, null, 2)}\n`);

    await expect(reconcileControllerRecovery(ledger.runDir)).rejects.toThrow(/previous subject|subject hash/i);
  });

  it.each(["afterTransitionEvent", "afterManifestHead"] as const)(
    "reconciles an interruption at %s without duplicating sequence or event",
    async (hook) => {
      const repoRoot = await packageFixture();
      const original = provenance(repoRoot, "a".repeat(64));
      const ledger = await createRunLedgerV2({
        repoRoot,
        originalRequest: "recover controller",
        sourceCommit: original.candidate_commit,
        controllerProvenance: original,
      });
      exposeCurrent({ ...original, package_hash: "b".repeat(64) });
      await expect(recordControllerRecovery({
        runDir: ledger.runDir,
        actor: "operator@example.test",
        reason: "Install reviewed bytes",
        expectedPackageSha256: "b".repeat(64),
        hooks: { [hook]: async () => { throw new Error("interrupt"); } },
      })).rejects.toThrow("interrupt");

      const reconciled = await reconcileControllerRecovery(ledger.runDir);
      expect(reconciled.controller_recovery.transition_count).toBe(1);
      expect(await readdir(join(ledger.runDir, "controller-recovery", "transitions"))).toHaveLength(1);
      expect((await readFile(join(ledger.runDir, "events.jsonl"), "utf8")).trim().split("\n")).toHaveLength(1);
    },
  );
});
