import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { GitHubAdapter, GitHubPullRequestReference } from "../adapters/github.js";
import { resolveLocalHeadSha, resolveRemoteBranchSha } from "../adapters/git.js";
import { readManifestV2, updateManifestV2 } from "../core/ledger.js";
import { readOwnedEvidenceFile, writeOwnedEvidenceFile } from "../core/owned-evidence.js";
import { remoteSynchronizationEvidenceSchema } from "../core/schema.js";
import type { RemoteSynchronizationEvidence } from "../core/types.js";
import { requirePersistedPullRequestMapping } from "../core/github-pull-request-mapping.js";

type SynchronizationProblem = RemoteSynchronizationEvidence["problems"][number];

export interface RecordRemoteSynchronizationInput {
  runDir: string;
  repoRoot: string;
  branchName: string;
  remoteName: string;
  pullRequestNumber: number;
  expectedPullRequestUrl: string;
  github: Pick<GitHubAdapter, "getPullRequest">;
  observedAt?: () => string;
  resolveLocalSha?: typeof resolveLocalHeadSha;
  resolveRemoteSha?: typeof resolveRemoteBranchSha;
}

export interface RecordRemoteSynchronizationResult {
  evidence: RemoteSynchronizationEvidence;
  artifactPath: string;
}

export class RemoteSynchronizationError extends Error {
  readonly code = "remote_synchronization_failed";

  constructor(
    readonly evidence: RemoteSynchronizationEvidence,
    readonly artifactPath: string,
  ) {
    super("The local candidate, mapped pull request, and remote branch are not synchronized");
    this.name = "RemoteSynchronizationError";
  }
}

function normalizeSha(value: unknown): string | null {
  return typeof value === "string" && /^[0-9a-f]{40,64}$/i.test(value)
    ? value.toLowerCase()
    : null;
}

function normalizePullRequestUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  try {
    const parsed = new URL(value);
    if ((parsed.protocol !== "https:" && parsed.protocol !== "http:")
      || parsed.username !== "" || parsed.password !== ""
      || parsed.search !== "" || parsed.hash !== "") return null;
    return parsed.href.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

function commandFailed(error: unknown): boolean {
  return error !== null && typeof error === "object"
    && Object.prototype.hasOwnProperty.call(error, "exitCode");
}

function addProblem(problems: SynchronizationProblem[], problem: SynchronizationProblem): void {
  if (!problems.some((entry) => entry.source === problem.source && entry.code === problem.code)) {
    problems.push(problem);
  }
}

function canonicalIdentity(evidence: RemoteSynchronizationEvidence): Omit<RemoteSynchronizationEvidence, "observed_at"> {
  const { observed_at: _observedAt, ...identity } = evidence;
  return identity;
}

function canonicalIdentityText(evidence: RemoteSynchronizationEvidence): string {
  return JSON.stringify(canonicalIdentity(evidence));
}

async function assertRunLineage(
  runDir: string,
  repoRoot: string,
  manifest: { run_id: string; repo_root: string },
): Promise<void> {
  if (manifest.run_id === "." || manifest.run_id === ".." || /[\\/]/.test(manifest.run_id)) {
    throw new Error("Run manifest identity must be one canonical run-directory segment");
  }
  let canonicalRepoRoot: string;
  let canonicalInputRepoRoot: string;
  try {
    [canonicalRepoRoot, canonicalInputRepoRoot] = await Promise.all([
      realpath(resolve(manifest.repo_root)),
      realpath(resolve(repoRoot)),
    ]);
  } catch {
    throw new Error("Source repository identity cannot be verified against the run manifest");
  }
  if (canonicalInputRepoRoot !== canonicalRepoRoot) {
    throw new Error("Source repository does not match the manifest-bound repository identity");
  }

  const lexicalRunDir = resolve(runDir);
  const lexicalManifestRunDir = join(canonicalRepoRoot, ".brain-hands", "runs", manifest.run_id);
  let runEntry: Awaited<ReturnType<typeof lstat>>;
  let manifestRunEntry: Awaited<ReturnType<typeof lstat>>;
  try {
    [runEntry, manifestRunEntry] = await Promise.all([
      lstat(lexicalRunDir),
      lstat(lexicalManifestRunDir),
    ]);
  } catch {
    throw new Error("Run ledger lineage cannot be verified from the manifest identity");
  }
  if (runEntry.isSymbolicLink() || manifestRunEntry.isSymbolicLink()
    || !runEntry.isDirectory() || !manifestRunEntry.isDirectory()) {
    throw new Error("Run ledger identity must use real canonical directory entries");
  }
  let canonicalRunDir: string;
  let canonicalManifestRunDir: string;
  try {
    [canonicalRunDir, canonicalManifestRunDir] = await Promise.all([
      realpath(lexicalRunDir),
      realpath(lexicalManifestRunDir),
    ]);
  } catch {
    throw new Error("Run ledger lineage cannot be verified from the manifest identity");
  }
  if (canonicalRunDir !== canonicalManifestRunDir
    || runEntry.dev !== manifestRunEntry.dev || runEntry.ino !== manifestRunEntry.ino) {
    throw new Error("Run ledger directory does not match the manifest run identity");
  }
}

async function persistEvidence(
  runDir: string,
  candidate: RemoteSynchronizationEvidence,
): Promise<RecordRemoteSynchronizationResult> {
  const digest = createHash("sha256").update(canonicalIdentityText(candidate)).digest("hex");
  const artifactPath = `assurance/remote-synchronization-${digest}.json`;
  const manifest = await readManifestV2(runDir);
  if (manifest.terminal !== null) {
    if (manifest.remote_synchronization_path !== artifactPath) {
      throw new Error("Terminal remote synchronization evidence cannot be created or replaced");
    }
    const existing = remoteSynchronizationEvidenceSchema.parse(JSON.parse(
      (await readOwnedEvidenceFile(runDir, artifactPath, "assurance/")).toString("utf8"),
    ));
    if (canonicalIdentityText(existing) !== canonicalIdentityText(candidate)) {
      throw new Error(`Terminal remote synchronization artifact has a different canonical identity: ${artifactPath}`);
    }
    return { evidence: existing, artifactPath };
  }
  let evidence = candidate;
  try {
    await writeOwnedEvidenceFile(
      runDir,
      artifactPath,
      "assurance/",
      `${JSON.stringify(candidate, null, 2)}\n`,
    );
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = remoteSynchronizationEvidenceSchema.parse(JSON.parse(
      (await readOwnedEvidenceFile(runDir, artifactPath, "assurance/")).toString("utf8"),
    ));
    if (canonicalIdentityText(existing) !== canonicalIdentityText(candidate)) {
      throw new Error(`Existing remote synchronization artifact has a different canonical identity: ${artifactPath}`);
    }
    evidence = existing;
  }
  if (manifest.remote_synchronization_path !== artifactPath) {
    await updateManifestV2(runDir, { remote_synchronization_path: artifactPath });
  }
  return { evidence, artifactPath };
}

function pullRequestObservation(
  reference: GitHubPullRequestReference,
  input: RecordRemoteSynchronizationInput,
  problems: SynchronizationProblem[],
): string | null {
  const expectedUrl = normalizePullRequestUrl(input.expectedPullRequestUrl);
  if (expectedUrl === null) throw new Error("Expected pull request URL is invalid");
  const actualUrl = normalizePullRequestUrl(reference.url);
  if (actualUrl === null) {
    addProblem(problems, { source: "pull_request", code: "invalid_response" });
    return null;
  }
  if (!Number.isSafeInteger(reference.number) || reference.number < 1) {
    addProblem(problems, { source: "pull_request", code: "invalid_response" });
    return null;
  }
  if (reference.number !== input.pullRequestNumber || actualUrl !== expectedUrl) {
    addProblem(problems, { source: "pull_request", code: "identity_mismatch" });
    return null;
  }

  const sha = normalizeSha(reference.head_sha);
  if (sha === null) addProblem(problems, { source: "pull_request", code: "invalid_response" });
  if (reference.state !== "OPEN") {
    addProblem(problems, {
      source: "pull_request",
      code: reference.state === "CLOSED" || reference.state === "MERGED"
        ? "identity_mismatch"
        : "invalid_response",
    });
  }
  if (typeof reference.head_ref !== "string" || reference.head_ref.trim() === "") {
    addProblem(problems, { source: "pull_request", code: "invalid_response" });
  } else if (reference.head_ref !== input.branchName) {
    addProblem(problems, { source: "pull_request", code: "identity_mismatch" });
  }
  return sha;
}

export async function recordRemoteSynchronization(
  input: RecordRemoteSynchronizationInput,
): Promise<RecordRemoteSynchronizationResult> {
  const manifest = await readManifestV2(input.runDir);
  await assertRunLineage(input.runDir, input.repoRoot, manifest);
  const mapping = requirePersistedPullRequestMapping(manifest);
  if (mapping.number !== input.pullRequestNumber
    || normalizePullRequestUrl(mapping.url) !== normalizePullRequestUrl(input.expectedPullRequestUrl)) {
    throw new Error("Remote synchronization input does not match the exact persisted pull request mapping");
  }
  const expectedPullRequestUrl = normalizePullRequestUrl(input.expectedPullRequestUrl);
  if (expectedPullRequestUrl === null) throw new Error("Expected pull request URL is invalid");
  const observedAt = input.observedAt ?? (() => new Date().toISOString());
  const resolveLocal = input.resolveLocalSha ?? resolveLocalHeadSha;
  const resolveRemote = input.resolveRemoteSha ?? resolveRemoteBranchSha;

  const localPromise = Promise.resolve().then(() => resolveLocal(input.repoRoot));
  const pullRequestPromise = input.github.getPullRequest === undefined
    ? null
    : Promise.resolve().then(() => input.github.getPullRequest!(input.pullRequestNumber));
  const remotePromise = Promise.resolve().then(
    () => resolveRemote(input.repoRoot, input.branchName, input.remoteName),
  );
  const [localResult, pullRequestResult, remoteResult] = await Promise.all([
    Promise.resolve(localPromise).then(
      (value) => ({ status: "fulfilled" as const, value }),
      (reason: unknown) => ({ status: "rejected" as const, reason }),
    ),
    pullRequestPromise === null
      ? Promise.resolve({ status: "unavailable" as const })
      : Promise.resolve(pullRequestPromise).then(
        (value) => ({ status: "fulfilled" as const, value }),
        (reason: unknown) => ({ status: "rejected" as const, reason }),
      ),
    Promise.resolve(remotePromise).then(
      (value) => ({ status: "fulfilled" as const, value }),
      (reason: unknown) => ({ status: "rejected" as const, reason }),
    ),
  ]);

  const problems: SynchronizationProblem[] = [];
  let localCandidateSha: string | null = null;
  if (localResult.status === "rejected") {
    addProblem(problems, { source: "local", code: commandFailed(localResult.reason) ? "command_failed" : "invalid_response" });
  } else {
    localCandidateSha = normalizeSha(localResult.value);
    if (localCandidateSha === null) addProblem(problems, { source: "local", code: "invalid_response" });
  }

  let mappedPrSha: string | null = null;
  if (pullRequestResult.status === "unavailable") {
    addProblem(problems, { source: "pull_request", code: "lookup_unavailable" });
  } else if (pullRequestResult.status === "rejected") {
    addProblem(problems, { source: "pull_request", code: commandFailed(pullRequestResult.reason) ? "command_failed" : "invalid_response" });
  } else if (pullRequestResult.value === null) {
    addProblem(problems, { source: "pull_request", code: "not_found" });
  } else {
    mappedPrSha = pullRequestObservation(pullRequestResult.value, input, problems);
  }

  let remoteHeadSha: string | null = null;
  if (remoteResult.status === "rejected") {
    addProblem(problems, { source: "remote", code: commandFailed(remoteResult.reason) ? "command_failed" : "invalid_response" });
  } else if (remoteResult.value === null) {
    addProblem(problems, { source: "remote", code: "not_found" });
  } else {
    remoteHeadSha = normalizeSha(remoteResult.value);
    if (remoteHeadSha === null) addProblem(problems, { source: "remote", code: "invalid_response" });
  }

  if (localCandidateSha !== null && mappedPrSha !== null && mappedPrSha !== localCandidateSha) {
    addProblem(problems, { source: "pull_request", code: "identity_mismatch" });
  }
  if (localCandidateSha !== null && remoteHeadSha !== null && remoteHeadSha !== localCandidateSha) {
    addProblem(problems, { source: "remote", code: "identity_mismatch" });
  }

  const evidence = remoteSynchronizationEvidenceSchema.parse({
    version: 1,
    run_id: manifest.run_id,
    branch_name: input.branchName,
    remote_name: input.remoteName,
    pull_request_number: input.pullRequestNumber,
    pull_request_url: expectedPullRequestUrl,
    local_candidate_sha: localCandidateSha,
    mapped_pr_sha: mappedPrSha,
    remote_head_sha: remoteHeadSha,
    problems,
    synchronized: problems.length === 0
      && localCandidateSha !== null
      && mappedPrSha === localCandidateSha
      && remoteHeadSha === localCandidateSha,
    observed_at: observedAt(),
  });
  return persistEvidence(input.runDir, evidence);
}
