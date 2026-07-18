import { runCommand, type CommandResult } from "../core/executor.js";
import {
  GITHUB_SETUP_LABELS,
  assertNoCaseInsensitiveLabelCollisions,
  type WorkflowLabel,
} from "../core/github-labels.js";

export interface GitHubRepositoryTarget {
  remote: string;
  remoteUrl: string;
  host: string;
  owner: string;
  name: string;
  nameWithOwner: string;
}

export interface LabelInspection {
  name: string;
  status: "existing" | "existing_drifted" | "missing";
  expected: WorkflowLabel;
  actual?: WorkflowLabel;
}

export interface GitHubSetupInspection {
  repository: GitHubRepositoryTarget;
  labels: LabelInspection[];
}

function requireSuccess(result: CommandResult, message: string): string {
  if (result.exitCode !== 0) throw new Error(`${message}: ${result.stderr || result.stdout || "command failed"}`);
  return result.stdout.trim();
}

export function parseGitHubRemote(remoteUrl: string, remote = "origin"): GitHubRepositoryTarget {
  const normalized = remoteUrl.match(/^git@([^:]+):(.+)$/)
    ? `ssh://git@${remoteUrl.match(/^git@([^:]+):(.+)$/)?.[1]}/${remoteUrl.match(/^git@([^:]+):(.+)$/)?.[2]}`
    : remoteUrl;
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw new Error(`Configured remote '${remote}' is not a GitHub remote: ${remoteUrl}`);
  }
  if (url.hostname !== "github.com") throw new Error(`Configured remote '${remote}' is not a supported GitHub remote: ${remoteUrl}`);
  const parts = url.pathname.replace(/^\//, "").replace(/\.git$/, "").split("/");
  if (parts.length !== 2 || parts.some((part) => !part)) throw new Error(`Configured remote '${remote}' does not identify owner/repo: ${remoteUrl}`);
  const [owner, name] = parts;
  return { remote, remoteUrl, host: url.hostname, owner, name, nameWithOwner: `${owner}/${name}` };
}

export async function inspectGitHubSetup(repoRoot: string, remote: string): Promise<GitHubSetupInspection> {
  const remoteResult = await runCommand({ command: "git", args: ["remote", "get-url", remote], cwd: repoRoot, timeoutMs: 15_000 });
  const repository = parseGitHubRemote(requireSuccess(remoteResult, `Could not resolve Git remote '${remote}'`), remote);
  requireSuccess(await runCommand({ command: "gh", args: ["--version"], cwd: repoRoot, timeoutMs: 15_000 }), "GitHub CLI is unavailable");
  requireSuccess(await runCommand({ command: "gh", args: ["auth", "status"], cwd: repoRoot, timeoutMs: 15_000 }), "GitHub CLI authentication is required");
  const view = requireSuccess(await runCommand({ command: "gh", args: ["repo", "view", repository.nameWithOwner, "--json", "nameWithOwner"], cwd: repoRoot, timeoutMs: 30_000 }), `Cannot access GitHub repository ${repository.nameWithOwner}`);
  const confirmed = JSON.parse(view) as { nameWithOwner?: string };
  if (confirmed.nameWithOwner?.toLowerCase() !== repository.nameWithOwner.toLowerCase()) throw new Error(`GitHub resolved an unexpected repository for ${repository.nameWithOwner}`);
  const rawLabels = requireSuccess(await runCommand({ command: "gh", args: ["api", "--paginate", "--slurp", `repos/${repository.nameWithOwner}/labels?per_page=100`], cwd: repoRoot, timeoutMs: 60_000 }), `Could not list labels in ${repository.nameWithOwner}`);
  const pages = JSON.parse(rawLabels) as Array<Array<{ name: string; color: string; description?: string | null }>>;
  const remoteLabels = pages.flat();
  assertNoCaseInsensitiveLabelCollisions(remoteLabels.map((label) => label.name));
  const existing = new Map(remoteLabels.map((label) => [label.name.toLowerCase(), label]));
  const labels = GITHUB_SETUP_LABELS.map((expected): LabelInspection => {
    const actualRaw = existing.get(expected.name.toLowerCase());
    if (!actualRaw) return { name: expected.name, status: "missing", expected };
    const actual = { name: actualRaw.name, color: actualRaw.color.toUpperCase(), description: actualRaw.description ?? "" };
    const status = actual.color === expected.color && actual.description === expected.description ? "existing" : "existing_drifted";
    return { name: expected.name, status, expected, actual };
  });
  return { repository, labels };
}

export async function provisionGitHubLabels(repoRoot: string, inspection: GitHubSetupInspection, dryRun: boolean): Promise<{ created: string[]; wouldCreate: string[] }> {
  const missing = inspection.labels.filter((label) => label.status === "missing");
  if (dryRun) return { created: [], wouldCreate: missing.map((label) => label.name) };
  const created: string[] = [];
  for (const label of missing) {
    const result = await runCommand({ command: "gh", args: ["label", "create", label.name, "--repo", inspection.repository.nameWithOwner, "--color", label.expected.color, "--description", label.expected.description], cwd: repoRoot, timeoutMs: 60_000 });
    requireSuccess(result, `Failed to create label '${label.name}' in ${inspection.repository.nameWithOwner}; created before failure: ${created.join(", ") || "none"}`);
    created.push(label.name);
  }
  return { created, wouldCreate: [] };
}
