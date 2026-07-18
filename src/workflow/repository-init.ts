import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { inspectGitHubSetup, provisionGitHubLabels, type GitHubSetupInspection } from "../adapters/github-setup.js";
import { configPath, defaultConfig, initConfig, loadConfig } from "../core/config.js";
import { runCommand } from "../core/executor.js";
import type { BrainHandsConfig } from "../core/types.js";

export type ConfigInitAction = "created" | "validated" | "overwritten" | "would_create" | "would_overwrite";

export interface RepositoryInitResult {
  repoRoot: string;
  config: { path: string; action: ConfigInitAction };
  github: (GitHubSetupInspection & { created: string[]; wouldCreate: string[] }) | null;
}

export async function initializeRepository(options: { repoRoot: string; github: boolean; dryRun: boolean; force: boolean }): Promise<RepositoryInitResult> {
  const requested = resolve(options.repoRoot);
  const rootResult = await runCommand({ command: "git", args: ["rev-parse", "--show-toplevel"], cwd: requested, timeoutMs: 15_000 });
  if (rootResult.exitCode !== 0 || !rootResult.stdout.trim()) throw new Error(`${requested} is not inside a Git repository`);
  const repoRoot = resolve(rootResult.stdout.trim());
  const path = configPath(repoRoot);
  let exists = true;
  try { await access(path); } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") exists = false;
    else throw error;
  }

  let config: BrainHandsConfig;
  let action: ConfigInitAction;
  if (options.dryRun) {
    if (exists && !options.force) {
      config = await loadConfig(repoRoot, { migrate: false });
      action = "validated";
    } else {
      config = defaultConfig();
      action = exists ? "would_overwrite" : "would_create";
    }
  } else {
    await initConfig(repoRoot, options.force);
    config = await loadConfig(repoRoot, { migrate: false });
    action = exists ? (options.force ? "overwritten" : "validated") : "created";
  }

  let github: RepositoryInitResult["github"] = null;
  if (options.github) {
    const inspection = await inspectGitHubSetup(repoRoot, config.github.default_remote);
    const changes = await provisionGitHubLabels(repoRoot, inspection, options.dryRun);
    github = { ...inspection, ...changes };
  }
  return { repoRoot, config: { path, action }, github };
}
