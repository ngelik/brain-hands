import { constants } from "node:fs";
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { execa } from "execa";
import { expect } from "vitest";
import { readManifestV2, type RunManifestV2Ledger } from "../../src/core/ledger.js";
import {
  persistedVerifierReviewSchema,
  reflectionSchema,
  verificationEvidenceSchema,
} from "../../src/core/schema.js";
import {
  canonicalSessionEventSchema,
  sessionStateSchema,
  type SessionState,
} from "../../src/progress/session-events.js";

export type RehearsalScenario = "happy" | "verifier-fix" | "interrupted-resume";

export type ProcessResult = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

export type RehearsalChild = {
  terminate(signal: NodeJS.Signals): boolean;
  wait(): Promise<ProcessResult>;
};

export type RunLineage = { runId: string; sessionId: string; eventId: string };

export type TreeFingerprint = Record<string, {
  type: "directory" | "file" | "symlink";
  sha256: string | null;
  size: number;
  mode: number;
  mtimeNs: string;
}>;

type Status = {
  run_id: string;
  run_dir: string | null;
  stage: string;
  assurance_outcome: string | null;
  workflow_result?: string;
};

const task = "Rehearse the canonical built CLI release lifecycle";
const githubArtifacts = new Set([
  "github-map.json",
  "github-issue-sync.json",
  "github-issue-lifecycle.json",
  "github-status.json",
  "github-status-intents.jsonl",
]);

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function parseJson<T>(raw: string): T {
  return JSON.parse(raw) as T;
}

function jsonLines(raw: string): unknown[] {
  return raw.trim() === "" ? [] : raw.trimEnd().split("\n").map((line) => parseJson<unknown>(line));
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function failureReport(scenario: RehearsalScenario, root: string, runDir: string | null): string {
  return [
    "Release rehearsal failed",
    `scenario=${scenario}`,
    `repo=${join(root, "repo")}`,
    `run=${runDir ?? "unknown"}`,
    `cleanup=rm -rf ${shellQuote(root)}`,
  ].join("\n");
}

export class RehearsalHarness {
  readonly projectRoot: string;
  readonly root: string;
  readonly repo: string;
  readonly home: string;
  readonly xdg: string;
  readonly codexHome: string;
  readonly bin: string;
  readonly externalCommandLog: string;
  readonly scenario: RehearsalScenario;
  readonly childEnv: Record<string, string>;

  runId: string | null = null;
  runDir: string | null = null;

  private lineage: RunLineage | null = null;
  private activeChild: RehearsalChild | null = null;

  private constructor(input: {
    projectRoot: string;
    root: string;
    scenario: RehearsalScenario;
    childEnv: Record<string, string>;
  }) {
    this.projectRoot = input.projectRoot;
    this.root = input.root;
    this.repo = join(input.root, "repo");
    this.home = join(input.root, "home");
    this.xdg = join(input.root, "xdg");
    this.codexHome = join(input.root, "codex-home");
    this.bin = join(input.root, "bin");
    this.externalCommandLog = join(input.root, "external-command.log");
    this.scenario = input.scenario;
    this.childEnv = input.childEnv;
  }

  static async create(scenario: RehearsalScenario): Promise<RehearsalHarness> {
    const projectRoot = process.cwd();
    await access(join(projectRoot, "dist", "cli.js"), constants.F_OK);

    const root = await mkdtemp(join(tmpdir(), "brain-hands-release-rehearsal-"));
    try {
      const childEnv = Object.fromEntries(
        Object.entries(process.env).filter((entry): entry is [string, string] => (
          entry[1] !== undefined && !entry[0].startsWith("GIT_")
        )),
      );
      for (const name of [
        "GH_TOKEN",
        "GITHUB_TOKEN",
        "OPENAI_API_KEY",
        "BRAIN_HANDS_CONTROLLER_MODE",
        "BRAIN_HANDS_EXECUTABLE_PATH",
      ]) {
        delete childEnv[name];
      }
      const harness = new RehearsalHarness({ projectRoot, root, scenario, childEnv });
      const gitSystemConfig = join(root, "git-system-config");
      const gitGlobalConfig = join(root, "git-global-config");
      const gitHooks = join(root, "git-hooks");
      const gitTemplate = join(root, "git-template");
      Object.assign(childEnv, {
        HOME: harness.home,
        XDG_CONFIG_HOME: harness.xdg,
        CODEX_HOME: harness.codexHome,
        NODE_ENV: "test",
        BRAIN_HANDS_RELEASE_REHEARSAL: "1",
        BRAIN_HANDS_RELEASE_REHEARSAL_SCENARIO: scenario,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_SYSTEM: gitSystemConfig,
        GIT_CONFIG_GLOBAL: gitGlobalConfig,
        GIT_TEMPLATE_DIR: gitTemplate,
        PATH: `${harness.bin}:${childEnv.PATH ?? ""}`,
      });
      await Promise.all([
        harness.repo,
        harness.home,
        harness.xdg,
        harness.codexHome,
        harness.bin,
        gitHooks,
        gitTemplate,
      ].map((path) => mkdir(path)));
      await Promise.all([
        writeFile(harness.externalCommandLog, "", "utf8"),
        writeFile(gitSystemConfig, "", "utf8"),
        writeFile(gitGlobalConfig, "", "utf8"),
      ]);

      for (const command of ["gh", "codex"]) {
        const path = join(harness.bin, command);
        await writeFile(path, [
          "#!/bin/sh",
          `printf '%s %s\\n' "$0" "$*" >> ${shellQuote(harness.externalCommandLog)}`,
          "exit 97",
          "",
        ].join("\n"), "utf8");
        await chmod(path, 0o755);
      }

      const git = (args: string[]) => execa("git", ["-c", `core.hooksPath=${gitHooks}`, ...args], {
        cwd: harness.repo,
        env: childEnv,
        extendEnv: false,
      });
      await git(["init", `--template=${gitTemplate}`, "-q"]);
      await git(["config", "core.hooksPath", gitHooks]);
      await git(["config", "user.email", "brain-hands@example.test"]);
      await git(["config", "user.name", "Brain Hands"]);
      await writeFile(join(harness.repo, "README.md"), "release rehearsal repository\n", "utf8");
      await git(["add", "README.md"]);
      await git(["commit", "-qm", "initial"]);

      return harness;
    } catch (error) {
      console.error(failureReport(scenario, root, null));
      throw error;
    }
  }

  async initialize(): Promise<void> {
    await this.expectSuccessful(this.runCli(["init", "--repo", this.repo]));
  }

  async driveDiscoveryToPlanApproval(): Promise<void> {
    const started = await this.runJson<Status>([
      "run",
      task,
      "--repo", this.repo,
      "--mode", "local",
      "--no-research",
      "--reflection",
      "--dry-run",
      "--json",
    ]);
    await this.adopt(started);
    const runDir = this.requireRunDir();

    await this.runJson<Status>([
      "answer-discovery", "--run", runDir, "--question", "q-001", "--dry-run", "--json",
    ], "Use the recommended explicit boundary\n");
    await this.expectStableLineage();
    await this.runJson<Status>([
      "select-discovery-approach", "--run", runDir, "--revision", "1",
      "--approach", "approach-explicit", "--dry-run", "--json",
    ]);
    await this.expectStableLineage();
    await this.runJson<Status>([
      "approve-discovery", "--run", runDir, "--revision", "1", "--dry-run", "--json",
    ]);
    await this.expectStableLineage();
  }

  async approvePlan(): Promise<Status> {
    return this.runJson<Status>([
      "approve-plan", this.requireRunId(), "--revision", "1", "--repo", this.repo, "--dry-run", "--json",
    ]);
  }

  startApprovePlan(): RehearsalChild {
    const subprocess = execa("node", [
      "dist/cli.js",
      "approve-plan", this.requireRunId(),
      "--revision", "1",
      "--repo", this.repo,
      "--dry-run",
      "--json",
    ], {
      cwd: this.projectRoot,
      env: this.childEnv,
      extendEnv: false,
      reject: false,
    });
    let child!: RehearsalChild;
    const result = subprocess.then((completed) => ({
      exitCode: completed.exitCode ?? null,
      signal: (completed.signal as NodeJS.Signals | undefined) ?? null,
      stdout: completed.stdout,
      stderr: completed.stderr,
    })).finally(() => {
      if (this.activeChild === child) this.activeChild = null;
    });
    child = {
      terminate: (signal) => subprocess.kill(signal),
      wait: () => result,
    };
    this.activeChild = child;
    return child;
  }

  async terminateActiveChild(): Promise<void> {
    const child = this.activeChild;
    if (child === null) return;
    child.terminate("SIGTERM");
    await child.wait();
  }

  async waitForWorkItemComplete(workItemId: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastStage: string = "unknown";
    let lastProgress: RunManifestV2Ledger["work_item_progress"][string] | undefined;
    while (true) {
      const manifest = await this.readManifest();
      lastStage = manifest.stage;
      lastProgress = manifest.work_item_progress[workItemId];
      if (lastProgress?.status === "complete") return;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(
          `Timed out waiting for work item ${workItemId} to complete: stage=${lastStage} progress=${JSON.stringify(lastProgress ?? null)}`,
        );
      }
      await delay(Math.min(25, remaining));
    }
  }

  async waitForLedgerUnlocked(timeoutMs: number): Promise<void> {
    const lockPath = join(this.requireRunDir(), ".ledger.lock");
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const lock = await lstat(lockPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (lock === null) return;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(
          `Timed out waiting for run ledger lock readiness: path=${lockPath} state=present mtimeMs=${lock.mtimeMs}`,
        );
      }
      await delay(Math.min(25, remaining));
    }
  }

  async resume(): Promise<Status> {
    return this.runJson<Status>([
      "resume", this.requireRunId(), "--repo", this.repo, "--dry-run", "--json",
    ]);
  }

  async runCli(args: string[], input?: string): Promise<ProcessResult> {
    const result = await execa("node", ["dist/cli.js", ...args], {
      cwd: this.projectRoot,
      env: this.childEnv,
      extendEnv: false,
      input,
      reject: false,
    });
    return {
      exitCode: result.exitCode ?? null,
      signal: (result.signal as NodeJS.Signals | undefined) ?? null,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  async readManifest(): Promise<RunManifestV2Ledger> {
    return readManifestV2(this.requireRunDir());
  }

  async readSessionState(): Promise<SessionState> {
    return sessionStateSchema.parse(parseJson<unknown>(
      await readFile(join(this.requireRunDir(), "session-state.json"), "utf8"),
    ));
  }

  async fingerprint(): Promise<TreeFingerprint> {
    const runDir = this.requireRunDir();
    const fingerprint: TreeFingerprint = {};

    const visit = async (directory: string): Promise<void> => {
      for (const name of (await readdir(directory)).sort()) {
        const path = join(directory, name);
        const stats = await lstat(path, { bigint: true });
        if (stats.isDirectory()) {
          fingerprint[relative(runDir, path)] = {
            type: "directory",
            sha256: null,
            size: Number(stats.size),
            mode: Number(stats.mode),
            mtimeNs: stats.mtimeNs.toString(),
          };
          await visit(path);
          continue;
        }

        let type: "file" | "symlink";
        let digest: string;
        if (stats.isFile()) {
          type = "file";
          digest = sha256(await readFile(path));
        } else if (stats.isSymbolicLink()) {
          type = "symlink";
          digest = sha256(await readlink(path));
        } else {
          throw new Error(`Unsupported run entry type: ${relative(runDir, path)}`);
        }
        fingerprint[relative(runDir, path)] = {
          type,
          sha256: digest,
          size: Number(stats.size),
          mode: Number(stats.mode),
          mtimeNs: stats.mtimeNs.toString(),
        };
      }
    };

    await visit(runDir);
    return fingerprint;
  }

  async expectOneRun(): Promise<void> {
    const runsDir = join(this.repo, ".brain-hands", "runs");
    const entries = await readdir(runsDir, { withFileTypes: true });
    const directories = entries.filter((entry) => entry.isDirectory());
    expect(directories).toHaveLength(1);
    expect(directories[0]!.name).toBe(this.requireRunId());
  }

  async expectStableLineage(): Promise<void> {
    const expected = this.requireLineage();
    const manifest = await this.readManifest();
    const state = await this.readSessionState();
    expect(manifest.run_id).toBe(expected.runId);
    expect(state.run_id).toBe(expected.runId);
    expect(state.session_id).toBe(expected.sessionId);
    expect(state.canonical_event_id).toBe(expected.eventId);
  }

  async expectWorkItemAttempts(workItemId: string, attempts: number): Promise<void> {
    const progress = (await this.readManifest()).work_item_progress[workItemId];
    expect(progress).toBeDefined();
    expect(progress).toMatchObject({ status: "complete", attempts });
  }

  async expectOnlyImplementationAttempt(workItemId: string, attempt: number): Promise<void> {
    expect(await readdir(join(this.requireRunDir(), "implementation", workItemId))).toEqual([
      `attempt-${attempt}.json`,
    ]);
  }

  async expectNonterminalWithoutReflection(): Promise<void> {
    const runDir = this.requireRunDir();
    const manifest = await this.readManifest();
    const state = await this.readSessionState();
    expect(manifest.stage).toBe("verifier_review");
    expect(manifest.terminal).toBeNull();
    expect(manifest.assurance_outcome).toBeNull();
    expect(state.terminal_outcome).toBeNull();
    expect(state.assurance_outcome).toBeNull();
    expect(state.terminal_provenance).toBeNull();
    expect(await readFile(join(runDir, "session-events.jsonl"), "utf8")).toBe("");
    expect(manifest.final_artifact_paths.filter((path) => path.includes("reflection"))).toEqual([]);
    const events = jsonLines(await readFile(join(runDir, "events.jsonl"), "utf8")) as Array<{ type?: unknown }>;
    expect(events.filter((event) => event.type === "reflection_completed")).toEqual([]);
    for (const path of [
      "reflection.json",
      "reflection.md",
      "responses/reflection-brain-account.json",
      "responses/reflection-hands-account.json",
      "responses/reflection-synthesis.json",
    ]) {
      await expect(access(join(runDir, path))).rejects.toMatchObject({ code: "ENOENT" });
    }
    expect(await readdir(join(runDir, "implementation"))).toEqual(["dry-run-item"]);
    await this.expectOnlyImplementationAttempt("dry-run-item", 1);
  }

  async expectIntegratedVerification(): Promise<void> {
    const manifest = await this.readManifest();
    const progress = manifest.work_item_progress.integrated;
    expect(progress).toBeDefined();
    expect(progress).toMatchObject({ status: "complete", attempts: 1 });
    expect(progress?.verification_path).toEqual(expect.any(String));
    expect(progress?.review_path).toEqual(expect.any(String));
    const evidence = verificationEvidenceSchema.parse(parseJson<unknown>(
      await readFile(join(this.requireRunDir(), progress!.verification_path as string), "utf8"),
    ));
    const review = persistedVerifierReviewSchema.parse(parseJson<unknown>(
      await readFile(join(this.requireRunDir(), progress!.review_path as string), "utf8"),
    ));
    expect(evidence).toMatchObject({ verification_scope: "integrated", work_item_id: "integrated", attempt: 1 });
    expect(review).toMatchObject({ work_item_id: "integrated", attempt: 1, final: true, decision: "approve" });
  }

  async expectReflectionComplete(): Promise<void> {
    const manifest = await this.readManifest();
    const reflectionPaths = manifest.final_artifact_paths.filter((path) => path.includes("reflection"));
    expect(reflectionPaths).toEqual(expect.arrayContaining([
      "reflection.json",
      "reflection.md",
      "responses/reflection-brain-account.json",
      "responses/reflection-hands-account.json",
      "responses/reflection-synthesis.json",
    ]));
    for (const path of reflectionPaths) {
      const raw = await readFile(join(this.requireRunDir(), path), "utf8");
      if (path.endsWith(".json")) parseJson<unknown>(raw);
      else expect(raw.trim()).not.toBe("");
    }
    reflectionSchema.parse(parseJson<unknown>(
      await readFile(join(this.requireRunDir(), "reflection.json"), "utf8"),
    ));
    const events = jsonLines(await readFile(join(this.requireRunDir(), "events.jsonl"), "utf8")) as Array<{ type?: unknown }>;
    expect(events.filter((event) => event.type === "reflection_completed")).toHaveLength(1);
  }

  async expectExactlyOneCanonicalFinalEvent(): Promise<void> {
    const events = jsonLines(await readFile(join(this.requireRunDir(), "session-events.jsonl"), "utf8"));
    expect(events).toHaveLength(1);
    const event = canonicalSessionEventSchema.parse(events[0]);
    const lineage = this.requireLineage();
    expect(event).toMatchObject({
      event_type: "session_finalized",
      run_id: lineage.runId,
      session_id: lineage.sessionId,
      event_id: lineage.eventId,
      terminal_outcome: "delivered",
      assurance_outcome: "verified_ready",
    });
  }

  async expectStreamSeparation(): Promise<void> {
    const runDir = this.requireRunDir();
    const progressRaw = await readFile(join(runDir, "progress.jsonl"), "utf8");
    const canonicalRaw = await readFile(join(runDir, "session-events.jsonl"), "utf8");
    const progress = jsonLines(progressRaw);
    expect(progress.length).toBeGreaterThan(0);
    for (const record of progress) expect(canonicalSessionEventSchema.safeParse(record).success).toBe(false);
    expect(progressRaw).not.toBe(canonicalRaw);
  }

  async expectNoGitHubProjection(): Promise<void> {
    const manifest = await this.readManifest();
    expect(manifest.issue_numbers).toEqual([]);
    expect(manifest.pull_request_numbers).toEqual([]);
    expect(manifest.work_item_issue_map).toEqual({});
    expect(manifest.github_ids.issue_numbers).toEqual([]);
    expect(manifest.github_ids.work_item_issue_map).toEqual({});
    expect(manifest.github_ids.parent_issue_number).toBeNull();
    expect(manifest.github_ids.pull_request_numbers).toEqual([]);
    expect(manifest.github_ids.pull_request_urls).toEqual({});

    const files = Object.keys(await this.fingerprint());
    expect(files.filter((path) => {
      const name = path.split("/").at(-1)!;
      return githubArtifacts.has(name) || name.startsWith(".github-status-") || name.startsWith("github-status.json.corrupt-");
    })).toEqual([]);
    for (const path of [...githubArtifacts, ".github-status-sync.lock"]) {
      await expect(access(join(this.requireRunDir(), path))).rejects.toMatchObject({ code: "ENOENT" });
    }
  }

  async expectNoExternalCommands(): Promise<void> {
    const raw = await readFile(this.externalCommandLog, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    expect(raw).toBe("");
  }

  async expectReadOnlyLogsAndTerminalResume(): Promise<void> {
    const beforeLogs = await this.fingerprint();
    await this.runJson<unknown>(["logs", this.requireRunId(), "--repo", this.repo, "--json"]);
    expect(await this.fingerprint()).toEqual(beforeLogs);

    const resumed = await this.runJson<Status>([
      "resume", this.requireRunId(), "--repo", this.repo, "--dry-run", "--json",
    ]);
    expect(resumed).toMatchObject({
      assurance_outcome: "verified_ready",
      workflow_result: "local_ready",
    });
    expect(await this.fingerprint()).toEqual(beforeLogs);
    await this.expectStableLineage();
    await this.expectNoExternalCommands();
    await this.expectOneRun();
  }

  async cleanup(): Promise<void> {
    await this.terminateActiveChild();
    await rm(this.root, { recursive: true, force: true });
  }

  async reportFailure(): Promise<void> {
    console.error(failureReport(this.scenario, this.root, this.runDir));
  }

  private async adopt(status: Status): Promise<void> {
    if (this.lineage !== null || this.runId !== null || this.runDir !== null) {
      throw new Error("Release rehearsal run status was already adopted");
    }
    if (status.run_dir === null) throw new Error("Release rehearsal status omitted run_dir");
    this.runId = status.run_id;
    this.runDir = status.run_dir;
    expect(this.runDir).toBe(join(this.repo, ".brain-hands", "runs", this.runId));
    const state = await this.readSessionState();
    this.lineage = {
      runId: state.run_id,
      sessionId: state.session_id,
      eventId: state.canonical_event_id,
    };
    await this.expectStableLineage();
  }

  private async runJson<T>(args: string[], input?: string): Promise<T> {
    const result = await this.expectSuccessful(this.runCli(args, input));
    return parseJson<T>(result.stdout);
  }

  private async expectSuccessful(resultPromise: Promise<ProcessResult>): Promise<ProcessResult> {
    const result = await resultPromise;
    if (result.exitCode !== 0 || result.signal !== null) {
      throw new Error([
        "Built CLI failed: node dist/cli.js",
        `exit=${result.exitCode ?? "null"}`,
        `signal=${result.signal ?? "null"}`,
        result.stdout.trim(),
        result.stderr.trim(),
      ].filter(Boolean).join("\n"));
    }
    return result;
  }

  private requireRunId(): string {
    if (this.runId === null) throw new Error("Release rehearsal run has not been adopted");
    return this.runId;
  }

  private requireRunDir(): string {
    if (this.runDir === null) throw new Error("Release rehearsal run has not been adopted");
    return this.runDir;
  }

  private requireLineage(): RunLineage {
    if (this.lineage === null) throw new Error("Release rehearsal lineage has not been adopted");
    return this.lineage;
  }
}
