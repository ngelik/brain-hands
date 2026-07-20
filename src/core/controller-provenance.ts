import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { execa } from "execa";
import type { ControllerProvenance } from "./types.js";
import type { ControllerRuntimeSnapshotV1, ControllerRuntimeSubjectV1, RunManifestV2 } from "./types.js";
import { controllerRecoveryArtifactV1Schema } from "./schema.js";
import { readOwnedEvidenceFile } from "./owned-evidence.js";

const PACKAGE_NAME = "@ngelik/brain-hands";
const REPOSITORY_IDENTITY = "github.com/ngelik/brain-hands";
const RUNTIME_PATHS = [
  "package.json",
  "dist",
  "prompts",
  "agentic-codex-workflow.md",
  "README.md",
] as const;

export type { ControllerProvenance } from "./types.js";

function normalizeRepository(value: unknown): string {
  const raw = typeof value === "string"
    ? value
    : value && typeof value === "object" && "url" in value
      ? String((value as { url?: unknown }).url ?? "")
      : "";
  return raw.trim().toLowerCase()
    .replace(/^git\+/, "")
    .replace(/^git@github\.com:/, "github.com/")
    .replace(/^[a-z]+:\/\/(?:git@)?/, "")
    .replace(/\.git$/, "")
    .replace(/\/$/, "");
}

async function existingRuntimeFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(path: string): Promise<void> {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) throw new Error(`Controller runtime tree contains a symlink: ${path}`);
    if (stat.isDirectory()) {
      for (const entry of (await readdir(path)).sort()) await visit(join(path, entry));
      return;
    }
    if (stat.isFile()) files.push(path);
  }
  for (const path of RUNTIME_PATHS) {
    try {
      await visit(join(root, path));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        throw new Error(`Required controller runtime path is missing: ${path}`);
      }
      throw error;
    }
  }
  return files;
}

export async function hashRuntimeTree(packageRoot: string): Promise<string> {
  const root = await realpath(packageRoot);
  const hash = createHash("sha256");
  for (const path of await existingRuntimeFiles(root)) {
    const name = relative(root, path).replaceAll("\\", "/");
    hash.update(`${Buffer.byteLength(name)}:${name}:`);
    const bytes = await readFile(path);
    hash.update(`${bytes.byteLength}:`);
    hash.update(bytes);
  }
  return hash.digest("hex");
}

export async function isSelfHostingRepository(repoRoot: string): Promise<boolean> {
  let metadata: { name?: unknown; repository?: unknown } = {};
  try {
    metadata = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8")) as typeof metadata;
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
  }
  if (metadata.name === PACKAGE_NAME || normalizeRepository(metadata.repository) === REPOSITORY_IDENTITY) return true;
  try {
    const { stdout } = await execa("git", ["remote", "get-url", "origin"], { cwd: repoRoot });
    return normalizeRepository(stdout) === REPOSITORY_IDENTITY;
  } catch {
    return false;
  }
}

function contained(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}

export async function assertControllerOutsideCandidate(input: {
  candidateRoot: string;
  controllerExecutable: string;
  controllerPackageRoot: string;
  worktreeRoots?: string[];
}): Promise<void> {
  const roots = await Promise.all([input.candidateRoot, ...(input.worktreeRoots ?? [])].map((path) => realpath(path)));
  const executable = await realpath(input.controllerExecutable);
  const packageRoot = await realpath(input.controllerPackageRoot);
  for (const root of new Set(roots)) {
    if (contained(root, executable) || contained(root, packageRoot)) {
      throw new Error(`Self-hosting controller resolves inside the candidate repository or worktree: ${root}`);
    }
  }
}

export async function findPackageRoot(entrypoint: string): Promise<string> {
  let current = dirname(await realpath(entrypoint));
  while (true) {
    try {
      const metadata = JSON.parse(await readFile(join(current, "package.json"), "utf8")) as { name?: unknown };
      if (metadata.name === PACKAGE_NAME) return current;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    }
    const parent = dirname(current);
    if (parent === current) throw new Error(`Could not locate ${PACKAGE_NAME} package root for ${entrypoint}`);
    current = parent;
  }
}

export async function captureVisibleController(entrypoint = process.argv[1] ?? ""): Promise<{
  package_name: string;
  package_version: string;
  mode: "installed" | "development_checkout";
}> {
  const packageRoot = await findPackageRoot(entrypoint);
  const metadata = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as {
    name?: unknown;
    version?: unknown;
  };
  if (metadata.name !== PACKAGE_NAME || typeof metadata.version !== "string" || !/^\d+\.\d+\.\d+$/.test(metadata.version)) {
    throw new Error(`Controller must be canonical ${PACKAGE_NAME} with a stable semantic version`);
  }
  const development = process.env.BRAIN_HANDS_CONTROLLER_MODE === "development_checkout"
    || await isDevelopmentCheckout(packageRoot);
  return {
    package_name: metadata.name,
    package_version: metadata.version,
    mode: development ? "development_checkout" : "installed",
  };
}

export async function candidateCommit(repoRoot: string): Promise<string> {
  const result = await execa("git", ["rev-parse", "--verify", "HEAD^{commit}"], {
    cwd: repoRoot,
    reject: false,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      "Candidate repository has no HEAD commit. Create an initial commit before running Brain Hands.",
    );
  }
  const { stdout } = result;
  if (!/^[a-f0-9]{40,64}$/i.test(stdout.trim())) throw new Error("Candidate repository returned invalid HEAD provenance");
  return stdout.trim().toLowerCase();
}

export async function linkedWorktreeRoots(repoRoot: string): Promise<string[]> {
  const { stdout } = await execa("git", ["worktree", "list", "--porcelain"], { cwd: repoRoot });
  return stdout.split("\n").filter((line) => line.startsWith("worktree ")).map((line) => resolve(line.slice("worktree ".length)));
}

export async function gitCommonRoot(repoRoot: string): Promise<string> {
  const { stdout } = await execa("git", ["rev-parse", "--git-common-dir"], { cwd: repoRoot });
  return realpath(resolve(repoRoot, stdout.trim()));
}

export async function isDevelopmentCheckout(packageRoot: string): Promise<boolean> {
  try {
    const { stdout } = await execa("git", ["rev-parse", "--show-toplevel"], { cwd: packageRoot });
    return await realpath(stdout.trim()) === await realpath(packageRoot);
  } catch {
    return false;
  }
}

export function assertInstalledPackageLayout(packageRoot: string): void {
  const normalized = resolve(packageRoot).replaceAll("\\", "/");
  if (!normalized.endsWith("/node_modules/@ngelik/brain-hands")) {
    throw new Error("Installed controller package must resolve under node_modules/@ngelik/brain-hands");
  }
}

export async function captureControllerProvenance(repoRoot: string, options: { dryRun?: boolean } = {}): Promise<{
  provenance: ControllerProvenance;
  selfHosting: boolean;
}> {
  const candidateRoot = await realpath(repoRoot);
  const entrypoint = await realpath(process.argv[1] ?? "");
  const packageRoot = await findPackageRoot(entrypoint);
  const metadata = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as {
    name?: unknown;
    version?: unknown;
  };
  if (typeof metadata.name !== "string" || typeof metadata.version !== "string") {
    throw new Error("Controller package identity or version is missing");
  }
  if (metadata.name !== PACKAGE_NAME || !/^\d+\.\d+\.\d+$/.test(metadata.version)) {
    throw new Error(`Controller must be canonical ${PACKAGE_NAME} with a stable semantic version`);
  }
  const executable = resolve(process.env.BRAIN_HANDS_EXECUTABLE_PATH ?? entrypoint);
  await realpath(executable);
  const mode = process.env.BRAIN_HANDS_CONTROLLER_MODE === "development_checkout"
    ? "development_checkout" as const
    : "installed" as const;
  let commit: string;
  try {
    commit = await candidateCommit(candidateRoot);
  } catch (error) {
    if (!options.dryRun) throw error;
    commit = "0".repeat(40);
  }
  const selfHosting = await isSelfHostingRepository(candidateRoot);
  if (selfHosting && mode !== "development_checkout") {
    if (await isDevelopmentCheckout(packageRoot)) {
      throw new Error("Self-hosting requires an installed @ngelik/brain-hands controller; checkout controllers require --development-controller");
    }
    assertInstalledPackageLayout(packageRoot);
    await assertControllerOutsideCandidate({
      candidateRoot,
      controllerExecutable: executable,
      controllerPackageRoot: packageRoot,
      worktreeRoots: [...await linkedWorktreeRoots(candidateRoot), await gitCommonRoot(candidateRoot)],
    });
  }
  return {
    selfHosting,
    provenance: {
      self_hosting: selfHosting,
      mode,
      executable_path: executable,
      package_root: packageRoot,
      package_name: metadata.name,
      package_version: metadata.version,
      package_hash_algorithm: "sha256",
      package_hash: await hashRuntimeTree(packageRoot),
      candidate_commit: commit,
    },
  };
}

export function controllerRuntimeMatches(
  current: ControllerProvenance | ControllerRuntimeSnapshotV1,
  recorded: ControllerProvenance | ControllerRuntimeSnapshotV1,
): boolean {
  return controllerRuntimeSubjectSha256(current) === controllerRuntimeSubjectSha256(recorded);
}

export function controllerRuntimeSnapshot(
  provenance: ControllerProvenance,
): ControllerRuntimeSnapshotV1 {
  const { candidate_commit: _candidateCommit, ...runtime } = provenance;
  return runtime;
}

export function controllerRuntimeSubject(
  runtime: ControllerProvenance | ControllerRuntimeSnapshotV1,
): ControllerRuntimeSubjectV1 {
  return {
    version: 1,
    package_name: runtime.package_name,
    package_version: runtime.package_version,
    mode: runtime.mode,
    package_hash_algorithm: runtime.package_hash_algorithm,
    package_hash: runtime.package_hash,
  };
}

export function controllerRuntimeSubjectSha256(
  runtime: ControllerProvenance | ControllerRuntimeSnapshotV1,
): string {
  return createHash("sha256").update(JSON.stringify(controllerRuntimeSubject(runtime))).digest("hex");
}

export async function assertCurrentControllerMatches(
  runDir: string,
  manifest: RunManifestV2,
): Promise<void> {
  if (!manifest.controller_provenance) {
    if (await isSelfHostingRepository(manifest.repo_root)) {
      throw new Error("Self-hosting run predates controller provenance and cannot be mutated; start a fresh run");
    }
    return;
  }
  if (!manifest.controller_provenance.self_hosting) return;
  const { reconcileControllerRecovery } = await import("../workflow/controller-recovery.js");
  const reconciled = await reconcileControllerRecovery(runDir);
  if (reconciled.run_id !== manifest.run_id || !reconciled.controller_provenance?.self_hosting) {
    throw new Error("Run directory does not match the supplied self-hosting manifest");
  }
  let recorded: ControllerRuntimeSnapshotV1 = controllerRuntimeSnapshot(reconciled.controller_provenance);
  if (reconciled.controller_recovery.head_path !== null) {
    const artifact = controllerRecoveryArtifactV1Schema.parse(JSON.parse((await readOwnedEvidenceFile(
      runDir,
      reconciled.controller_recovery.head_path,
      "controller-recovery",
    )).toString("utf8")));
    recorded = artifact.next_runtime;
  }
  const current = (await captureControllerProvenance(reconciled.repo_root)).provenance;
  if (!controllerRuntimeMatches(current, recorded)) {
    throw new Error("Current controller provenance does not match the accepted self-hosting run controller");
  }
}

type CaptureController = typeof captureControllerProvenance;

export async function assertApprovalControllerMatches(
  runDir: string,
  manifest: RunManifestV2,
  capture: CaptureController = captureControllerProvenance,
): Promise<void> {
  if (!manifest.controller_provenance) {
    throw new Error("Plan approval requires immutable controller provenance");
  }
  let recorded: ControllerRuntimeSnapshotV1 = controllerRuntimeSnapshot(manifest.controller_provenance);
  if ((manifest.controller_recovery?.transition_count ?? 0) > 0) {
    if (manifest.controller_recovery.head_path === null) {
      throw new Error("Plan approval controller recovery is missing its accepted head");
    }
    const artifact = controllerRecoveryArtifactV1Schema.parse(JSON.parse((await readOwnedEvidenceFile(
      runDir,
      manifest.controller_recovery.head_path,
      "controller-recovery",
    )).toString("utf8")));
    if (artifact.run_id !== manifest.run_id
      || artifact.sequence !== manifest.controller_recovery.transition_count) {
      throw new Error("Plan approval controller recovery does not match the supplied run manifest");
    }
    recorded = artifact.next_runtime;
  }
  const current = (await capture(manifest.repo_root)).provenance;
  if (!controllerRuntimeMatches(current, recorded)) {
    throw new Error("Current approval controller does not match the accepted run controller");
  }
}
