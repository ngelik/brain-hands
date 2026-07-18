import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertApprovalControllerMatches,
  assertCurrentControllerMatches,
  assertControllerOutsideCandidate,
  hashRuntimeTree,
  isDevelopmentCheckout,
  isSelfHostingRepository,
  assertInstalledPackageLayout,
  captureVisibleController,
  controllerRuntimeSubject,
  controllerRuntimeSubjectSha256,
  controllerRuntimeMatches,
  candidateCommit,
} from "../../src/core/controller-provenance.js";
import type { ControllerProvenance } from "../../src/core/types.js";
import type { RunManifestV2 } from "../../src/core/types.js";
import {
  controllerRecoveryArtifactV1Schema,
  controllerRuntimeSnapshotV1Schema,
  controllerRuntimeSubjectV1Schema,
} from "../../src/core/schema.js";

async function fixture(name = "@ngelik/brain-hands", includePlugin = true): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "brain-hands-controller-"));
  await mkdir(join(root, "dist"), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({
    name,
    version: "0.2.0",
    repository: "git+https://github.com/ngelik/brain-hands.git",
  }));
  await writeFile(join(root, "dist", "cli.js"), "console.log('brain-hands')\n");
  await mkdir(join(root, "prompts"));
  await writeFile(join(root, "prompts", "brain.md"), "prompt\n");
  await writeFile(join(root, "agentic-codex-workflow.md"), "workflow\n");
  await writeFile(join(root, "README.md"), "readme\n");
  if (includePlugin) {
    await mkdir(join(root, ".agents"));
    await writeFile(join(root, ".agents", "skill.md"), "skill\n");
    await mkdir(join(root, ".codex-plugin"));
    await writeFile(join(root, ".codex-plugin", "plugin.json"), "{}\n");
  }
  return root;
}

describe("controller provenance", () => {
  it("hashes runtime paths and bytes deterministically", async () => {
    const root = await fixture();
    const first = await hashRuntimeTree(root);
    await writeFile(join(root, "ignored.txt"), "not packaged\n");
    expect(await hashRuntimeTree(root)).toBe(first);
    await writeFile(join(root, "dist", "cli.js"), "console.log('changed')\n");
    expect(await hashRuntimeTree(root)).not.toBe(first);
  });

  it("hashes exactly the published controller runtime", async () => {
    const root = await fixture("@ngelik/brain-hands", false);
    const first = await hashRuntimeTree(root);
    await mkdir(join(root, ".agents", "skills", "brain-hands"), { recursive: true });
    await writeFile(join(root, ".agents", "skills", "brain-hands", "SKILL.md"), "changed skill\n");
    await mkdir(join(root, ".codex-plugin"), { recursive: true });
    await writeFile(join(root, ".codex-plugin", "plugin.json"), "{}\n");

    expect(await hashRuntimeTree(root)).toBe(first);
  });

  it("accepts an installed runtime without plugin sources", async () => {
    const root = await fixture("@ngelik/brain-hands", false);

    await expect(hashRuntimeTree(root)).resolves.toMatch(/^[a-f0-9]{64}$/);
  });

  it("separates immutable controller bytes from the candidate source commit", () => {
    const recorded: ControllerProvenance = {
      self_hosting: true,
      mode: "development_checkout",
      executable_path: "/controller/dist/cli.js",
      package_root: "/controller",
      package_name: "@ngelik/brain-hands",
      package_version: "0.3.5",
      package_hash_algorithm: "sha256",
      package_hash: "a".repeat(64),
      candidate_commit: "b".repeat(40),
    };

    expect(controllerRuntimeMatches(
      { ...recorded, candidate_commit: "c".repeat(40) },
      recorded,
    )).toBe(true);
    expect(controllerRuntimeMatches(
      { ...recorded, package_hash: "d".repeat(64), candidate_commit: "c".repeat(40) },
      recorded,
    )).toBe(false);
  });

  it("derives canonical subjects from package identity and bytes only", () => {
    const runtime: ControllerProvenance = {
      self_hosting: true,
      mode: "installed",
      executable_path: "/controller-a/dist/cli.js",
      package_root: "/controller-a",
      package_name: "@ngelik/brain-hands",
      package_version: "0.3.5",
      package_hash_algorithm: "sha256",
      package_hash: "a".repeat(64),
      candidate_commit: "b".repeat(40),
    };
    const moved = {
      ...runtime,
      executable_path: "/controller-b/dist/cli.js",
      package_root: "/controller-b",
      candidate_commit: "c".repeat(40),
    };

    expect(controllerRuntimeSubject(moved)).toEqual(controllerRuntimeSubject(runtime));
    expect(controllerRuntimeSubjectSha256(moved)).toBe(controllerRuntimeSubjectSha256(runtime));
    expect(controllerRuntimeSubjectSha256({ ...moved, package_hash: "d".repeat(64) }))
      .not.toBe(controllerRuntimeSubjectSha256(runtime));
  });

  it("keeps controller snapshot, subject, and transition schemas strict", () => {
    const runtime: ControllerProvenance = {
      self_hosting: true,
      mode: "installed",
      executable_path: "/controller/dist/cli.js",
      package_root: "/controller",
      package_name: "@ngelik/brain-hands",
      package_version: "0.4.0",
      package_hash_algorithm: "sha256",
      package_hash: "a".repeat(64),
      candidate_commit: "b".repeat(40),
    };
    const subject = controllerRuntimeSubject(runtime);
    const snapshot = { ...runtime } as Record<string, unknown>;
    delete snapshot.candidate_commit;
    expect(controllerRuntimeSnapshotV1Schema.safeParse(runtime).success).toBe(false);
    expect(controllerRuntimeSnapshotV1Schema.parse(snapshot)).toEqual(snapshot);
    expect(controllerRuntimeSubjectV1Schema.safeParse({ ...subject, package_root: "/controller" }).success).toBe(false);
    const artifact = {
      version: 1,
      run_id: "run-1",
      sequence: 1,
      stage: "intake",
      actor: "operator@example.test",
      reason: "reviewed bytes",
      recorded_at: "2026-07-17T00:00:00.000Z",
      previous_subject_sha256: "c".repeat(64),
      next_subject_sha256: "d".repeat(64),
      previous_runtime: snapshot,
      next_runtime: { ...snapshot, package_hash: "e".repeat(64) },
      candidate_head_at_recovery: "f".repeat(40),
      blocker_fingerprint: null,
      event_id: `controller-recovery:${"1".repeat(64)}`,
    };
    expect(controllerRecoveryArtifactV1Schema.safeParse(artifact).success).toBe(true);
    expect(controllerRecoveryArtifactV1Schema.safeParse({ ...artifact, extra: true }).success).toBe(false);
    const { stage: _stage, ...withoutStage } = artifact;
    expect(controllerRecoveryArtifactV1Schema.safeParse(withoutStage).success).toBe(false);
  });

  it("checks approval controller runtime for ordinary runs while leaving source commit separate", async () => {
    const recorded: ControllerProvenance = {
      self_hosting: false,
      mode: "installed",
      executable_path: "/controller/dist/cli.js",
      package_root: "/controller",
      package_name: "@ngelik/brain-hands",
      package_version: "0.3.5",
      package_hash_algorithm: "sha256",
      package_hash: "a".repeat(64),
      candidate_commit: "b".repeat(40),
    };
    const manifest = {
      repo_root: "/candidate",
      controller_provenance: recorded,
    } as unknown as RunManifestV2;

    await expect(assertApprovalControllerMatches(manifest, async () => ({
      provenance: { ...recorded, candidate_commit: "c".repeat(40) },
      selfHosting: false,
    }))).resolves.toBeUndefined();
    await expect(assertApprovalControllerMatches(manifest, async () => ({
      provenance: { ...recorded, package_hash: "d".repeat(64) },
      selfHosting: false,
    }))).rejects.toThrow(/approval.*controller/i);
  });

  it("fails closed when a required runtime root is missing", async () => {
    const root = await fixture();
    await rm(join(root, "prompts"), { recursive: true });
    await expect(hashRuntimeTree(root)).rejects.toThrow(/required controller runtime path.*prompts/i);
  });

  it("rejects symlinks in the hashed runtime tree", async () => {
    const root = await fixture();
    await symlink(join(root, "package.json"), join(root, "dist", "alias.js"));
    await expect(hashRuntimeTree(root)).rejects.toThrow(/symlink/i);
  });

  it("detects canonical package and repository identity", async () => {
    const canonical = await fixture();
    expect(await isSelfHostingRepository(canonical)).toBe(true);
    const renamed = await fixture("example");
    expect(await isSelfHostingRepository(renamed)).toBe(true);
    await writeFile(join(renamed, "package.json"), JSON.stringify({ name: "example", version: "1.0.0" }));
    expect(await isSelfHostingRepository(renamed)).toBe(false);
  });

  it("rejects a controller package inside the candidate checkout", async () => {
    const candidate = await fixture();
    await expect(assertControllerOutsideCandidate({
      candidateRoot: candidate,
      controllerExecutable: join(candidate, "dist", "cli.js"),
      controllerPackageRoot: candidate,
      worktreeRoots: [candidate],
    })).rejects.toThrow(/inside.*candidate|worktree/i);
  });

  it("distinguishes a git checkout from an installed package tree", async () => {
    const checkout = await fixture();
    const { execa } = await import("execa");
    await execa("git", ["init", "-q"], { cwd: checkout });
    expect(await isDevelopmentCheckout(checkout)).toBe(true);
    expect(await isDevelopmentCheckout(await fixture())).toBe(false);
  });

  it("reports an actionable error for a repository without an initial commit", async () => {
    const candidate = await mkdtemp(join(tmpdir(), "brain-hands-unborn-"));
    const { execa } = await import("execa");
    await execa("git", ["init", "-q"], { cwd: candidate });

    await expect(candidateCommit(candidate)).rejects.toThrow(
      /no HEAD commit.*initial commit.*before running Brain Hands/i,
    );
  });

  it("reports a checkout controller without collecting run provenance", async () => {
    const checkout = await fixture();
    const { execa } = await import("execa");
    await execa("git", ["init", "-q"], { cwd: checkout });

    await expect(captureVisibleController(join(checkout, "dist", "cli.js"))).resolves.toEqual({
      package_name: "@ngelik/brain-hands",
      package_version: "0.2.0",
      mode: "development_checkout",
    });
  });

  it("requires an npm node_modules layout for installed controllers", async () => {
    const copied = await fixture();
    expect(() => assertInstalledPackageLayout(copied)).toThrow(/installed.*node_modules/i);
    const installed = join(await mkdtemp(join(tmpdir(), "brain-hands-prefix-")), "node_modules", "@ngelik", "brain-hands");
    await mkdir(installed, { recursive: true });
    expect(() => assertInstalledPackageLayout(installed)).not.toThrow();
  });

  it("uses durable self-hosting provenance instead of mutable candidate metadata", async () => {
    const candidate = await fixture();
    const { execa } = await import("execa");
    await execa("git", ["init", "-q"], { cwd: candidate });
    await execa("git", ["config", "user.email", "brain-hands@example.test"], { cwd: candidate });
    await execa("git", ["config", "user.name", "Brain Hands"], { cwd: candidate });
    await execa("git", ["add", "."], { cwd: candidate });
    await execa("git", ["commit", "-qm", "candidate"], { cwd: candidate });
    await writeFile(join(candidate, "package.json"), JSON.stringify({ name: "renamed", version: "1.0.0" }));
    const manifest = {
      repo_root: candidate,
      controller_provenance: {
        self_hosting: true,
        mode: "installed",
        executable_path: "/missing/controller",
        package_root: "/missing/package",
        package_name: "@ngelik/brain-hands",
        package_version: "0.2.0",
        package_hash_algorithm: "sha256",
        package_hash: "a".repeat(64),
        candidate_commit: "b".repeat(40),
      },
    } as unknown as RunManifestV2;
    await expect(assertCurrentControllerMatches(candidate, manifest)).rejects.toThrow();
  });
});
