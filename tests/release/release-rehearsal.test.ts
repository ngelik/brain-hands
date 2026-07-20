import { chmod, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { persistedVerifierReviewSchema } from "../../src/core/schema.js";
import { RehearsalHarness } from "./rehearsal-harness.js";

async function readReview(harness: RehearsalHarness, workItemId: string, attempt: number) {
  return persistedVerifierReviewSchema.parse(JSON.parse(await readFile(
    join(harness.runDir!, "reviews", workItemId, `attempt-${attempt}.json`),
    "utf8",
  )));
}

async function expectProgressOrder(harness: RehearsalHarness, expected: string[]): Promise<void> {
  const progress = (await readFile(join(harness.runDir!, "progress.jsonl"), "utf8"))
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as { event_key?: string });
  let previous = -1;
  for (const code of expected) {
    const index = progress.findIndex((event, candidate) => (
      candidate > previous && event.event_key?.split(":")[1] === code
    ));
    expect(index, `missing progress code ${code} after index ${previous}`).toBeGreaterThan(previous);
    previous = index;
  }
}

describe("manual release rehearsal", () => {
  it("completes the canonical happy path without external commands", async () => {
    const harness = await RehearsalHarness.create("happy");
    try {
      await harness.initialize();
      await harness.driveDiscoveryToPlanApproval();
      const result = await harness.approvePlan();
      expect(result.workflow_result).toBe("local_ready");
      expect(result.assurance_outcome).toBe("verified_ready");

      await harness.expectOneRun();
      await harness.expectStableLineage();
      await harness.expectWorkItemAttempts("dry-run-item", 1);
      await harness.expectIntegratedVerification();
      await harness.expectReflectionComplete();
      await harness.expectExactlyOneCanonicalFinalEvent();
      await harness.expectStreamSeparation();
      await harness.expectNoGitHubProjection();
      const oneRun = vi.spyOn(harness, "expectOneRun");
      const noExternalCommands = vi.spyOn(harness, "expectNoExternalCommands");
      await harness.expectNoExternalCommands();
      await harness.expectReadOnlyLogsAndTerminalResume();
      expect(oneRun).toHaveBeenCalledOnce();
      expect(noExternalCommands).toHaveBeenCalledTimes(2);
      await harness.cleanup();
    } catch (error) {
      await harness.reportFailure();
      throw error;
    }
  });

  it("performs one same-run verifier correction", async () => {
    const harness = await RehearsalHarness.create("verifier-fix");
    try {
      await harness.initialize();
      await harness.driveDiscoveryToPlanApproval();
      const result = await harness.approvePlan();
      expect(result.workflow_result).toBe("local_ready");
      expect(result.assurance_outcome).toBe("verified_ready");

      const first = await readReview(harness, "dry-run-item", 1);
      expect(first).toMatchObject({
        work_item_id: "dry-run-item",
        attempt: 1,
        final: false,
        decision: "request_changes",
        failure_class: "implementation_failure",
        blocker: null,
        blocker_code: null,
      });
      expect(first.findings).toHaveLength(1);

      const second = await readReview(harness, "dry-run-item", 2);
      expect(second).toMatchObject({
        work_item_id: "dry-run-item",
        attempt: 2,
        final: false,
        decision: "approve",
        failure_class: "none",
      });

      await harness.expectOneRun();
      await harness.expectStableLineage();
      await harness.expectWorkItemAttempts("dry-run-item", 2);
      await expectProgressOrder(harness, [
        "verifier_changes",
        "work_item_fix",
        "verifier_approved",
        "final_verification_started",
      ]);
      await harness.expectIntegratedVerification();
      await harness.expectReflectionComplete();
      await harness.expectExactlyOneCanonicalFinalEvent();
      await harness.expectStreamSeparation();
      await harness.expectNoGitHubProjection();
      await harness.expectNoExternalCommands();
      await harness.expectReadOnlyLogsAndTerminalResume();
      await harness.cleanup();
    } catch (error) {
      await harness.reportFailure();
      throw error;
    }
  });

  it("resumes the same run after abrupt process termination", async () => {
    const harness = await RehearsalHarness.create("interrupted-resume");
    try {
      await harness.initialize();
      await harness.driveDiscoveryToPlanApproval();

      const child = harness.startApprovePlan();
      await harness.waitForWorkItemComplete("dry-run-item", 30_000);
      await harness.waitForLedgerUnlocked(10_000);
      expect(child.terminate("SIGTERM")).toBe(true);
      const interrupted = await child.wait();
      expect(interrupted).toMatchObject({ exitCode: null, signal: "SIGTERM" });
      await harness.waitForLedgerRecoverable(31_000);

      await harness.expectOneRun();
      await harness.expectStableLineage();
      await harness.expectWorkItemAttempts("dry-run-item", 1);
      await harness.expectNonterminalWithoutReflection();

      const resumed = await harness.resume();
      expect(resumed.workflow_result).toBe("local_ready");
      await harness.expectWorkItemAttempts("dry-run-item", 1);
      await harness.expectIntegratedVerification();
      await harness.expectReflectionComplete();
      await harness.expectExactlyOneCanonicalFinalEvent();
      await harness.expectStreamSeparation();
      await harness.expectNoGitHubProjection();
      await harness.expectNoExternalCommands();
      await harness.expectReadOnlyLogsAndTerminalResume();
      await harness.expectWorkItemAttempts("dry-run-item", 1);
      await harness.expectOnlyImplementationAttempt("dry-run-item", 1);
      await harness.cleanup();
    } catch (error) {
      await harness.terminateActiveChild();
      await harness.reportFailure();
      throw error;
    }
  });

  it("waits for the run ledger lock to clear before declaring interruption readiness", async () => {
    const harness = await RehearsalHarness.create("happy");
    try {
      await harness.initialize();
      await harness.driveDiscoveryToPlanApproval();
      const lockPath = join(harness.runDir!, ".ledger.lock");
      await mkdir(lockPath);

      let settled = false;
      const readiness = harness.waitForLedgerUnlocked(1_000).finally(() => { settled = true; });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
      await rm(lockPath, { recursive: true });
      await readiness;

      await mkdir(lockPath);
      await expect(harness.waitForLedgerUnlocked(0)).rejects.toThrow(/\.ledger\.lock.*present/);
      await rm(lockPath, { recursive: true });
      await harness.cleanup();
    } catch (error) {
      await harness.reportFailure();
      throw error;
    }
  });

  it("fingerprints empty-directory additions and removals", async () => {
    const harness = await RehearsalHarness.create("happy");
    try {
      await harness.initialize();
      await harness.driveDiscoveryToPlanApproval();
      const before = await harness.fingerprint();
      const emptyDirectory = join(harness.runDir!, "empty-directory");

      await mkdir(emptyDirectory);
      const added = await harness.fingerprint();
      expect(added).not.toEqual(before);
      expect(added["empty-directory"]).toMatchObject({ type: "directory" });

      await rm(emptyDirectory, { recursive: true });
      expect(await harness.fingerprint()).toEqual(before);
      await harness.cleanup();
    } catch (error) {
      await harness.reportFailure();
      throw error;
    }
  });

  it("fingerprints directory metadata changes", async () => {
    const harness = await RehearsalHarness.create("happy");
    try {
      await harness.initialize();
      await harness.driveDiscoveryToPlanApproval();
      const directory = join(harness.runDir!, "metadata-directory");
      await mkdir(directory, { mode: 0o700 });
      const before = await harness.fingerprint();

      await chmod(directory, 0o755);
      await utimes(directory, new Date(1_700_000_000_000), new Date(1_700_000_000_000));
      const after = await harness.fingerprint();
      expect(after["metadata-directory"]).not.toEqual(before["metadata-directory"]);
      expect(after["metadata-directory"]?.mode).not.toBe(before["metadata-directory"]?.mode);
      expect(after["metadata-directory"]?.mtimeNs).not.toBe(before["metadata-directory"]?.mtimeNs);

      await harness.cleanup();
    } catch (error) {
      await harness.reportFailure();
      throw error;
    }
  });

  it("isolates temporary Git setup from ambient config, repository overrides, hooks, and templates", async () => {
    const poisonRoot = await mkdtemp(join(tmpdir(), "brain-hands-release-git-poison-"));
    const poisonHome = join(poisonRoot, "home");
    const poisonHooks = join(poisonRoot, "hooks");
    const poisonTemplate = join(poisonRoot, "template");
    await mkdir(poisonHome);
    await mkdir(poisonHooks);
    await mkdir(join(poisonTemplate, "hooks"), { recursive: true });
    await writeFile(join(poisonHome, ".gitconfig"), [
      "[user]",
      "\tname = Ambient User",
      "\temail = ambient@example.test",
      "[core]",
      `\thooksPath = ${poisonHooks}`,
      "",
    ].join("\n"), "utf8");
    for (const hook of [join(poisonHooks, "pre-commit"), join(poisonTemplate, "hooks", "pre-commit")]) {
      await writeFile(hook, "#!/bin/sh\nexit 96\n", "utf8");
      await chmod(hook, 0o755);
    }

    const ambient = {
      HOME: process.env.HOME,
      GIT_DIR: process.env.GIT_DIR,
      GIT_CONFIG_SYSTEM: process.env.GIT_CONFIG_SYSTEM,
      GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
      GIT_CONFIG_COUNT: process.env.GIT_CONFIG_COUNT,
      GIT_CONFIG_KEY_0: process.env.GIT_CONFIG_KEY_0,
      GIT_CONFIG_VALUE_0: process.env.GIT_CONFIG_VALUE_0,
      GIT_TEMPLATE_DIR: process.env.GIT_TEMPLATE_DIR,
    };
    let harness: RehearsalHarness | undefined;
    try {
      process.env.HOME = poisonHome;
      process.env.GIT_DIR = join(poisonRoot, "wrong-repository");
      process.env.GIT_CONFIG_SYSTEM = join(poisonHome, ".gitconfig");
      process.env.GIT_CONFIG_GLOBAL = join(poisonHome, ".gitconfig");
      process.env.GIT_CONFIG_COUNT = "1";
      process.env.GIT_CONFIG_KEY_0 = "core.hooksPath";
      process.env.GIT_CONFIG_VALUE_0 = poisonHooks;
      process.env.GIT_TEMPLATE_DIR = poisonTemplate;

      harness = await RehearsalHarness.create("happy");
      expect(harness.childEnv.GIT_DIR).toBeUndefined();
      expect(harness.childEnv.GIT_CONFIG_COUNT).toBeUndefined();
      expect(harness.childEnv.GIT_CONFIG_KEY_0).toBeUndefined();
      expect(harness.childEnv.GIT_CONFIG_VALUE_0).toBeUndefined();
      expect(harness.childEnv.HOME).toBe(harness.home);
      expect(harness.childEnv.GIT_CONFIG_NOSYSTEM).toBe("1");
      expect(harness.childEnv.GIT_CONFIG_SYSTEM).toBe(join(harness.root, "git-system-config"));
      expect(harness.childEnv.GIT_CONFIG_GLOBAL).toBe(join(harness.root, "git-global-config"));
      expect(harness.childEnv.GIT_TEMPLATE_DIR).toBe(join(harness.root, "git-template"));
      await expect(readFile(join(harness.repo, ".git", "hooks", "pre-commit"), "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(join(harness.repo, ".git", "config"), "utf8")).toContain("Brain Hands");
      await harness.cleanup();
      harness = undefined;
    } catch (error) {
      if (harness !== undefined) await harness.reportFailure();
      throw error;
    } finally {
      for (const [name, value] of Object.entries(ambient)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      await rm(poisonRoot, { recursive: true, force: true });
    }
  });

  it("reports and preserves setup failures after creating the harness root", async () => {
    const fakeBin = await mkdtemp(join(tmpdir(), "brain-hands-release-failing-git-"));
    const fakeGit = join(fakeBin, "git");
    await writeFile(fakeGit, "#!/bin/sh\nexit 95\n", "utf8");
    await chmod(fakeGit, 0o755);
    const originalPath = process.env.PATH;
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let preservedRoot: string | undefined;
    try {
      process.env.PATH = `${fakeBin}${delimiter}${originalPath ?? ""}`;
      await expect(RehearsalHarness.create("happy")).rejects.toBeDefined();
      expect(error).toHaveBeenCalledOnce();
      const report = String(error.mock.calls[0]?.[0]);
      const lines = report.split("\n");
      expect(lines).toHaveLength(5);
      expect(lines[0]).toBe("Release rehearsal failed");
      expect(lines[1]).toBe("scenario=happy");
      preservedRoot = lines[4]?.match(/^cleanup=rm -rf '(.+)'$/)?.[1];
      expect(preservedRoot).toEqual(expect.any(String));
      expect(lines[2]).toBe(`repo=${join(preservedRoot!, "repo")}`);
      expect(lines[3]).toBe("run=unknown");
      await expect(readFile(join(preservedRoot!, "external-command.log"), "utf8")).resolves.toBe("");
    } finally {
      process.env.PATH = originalPath;
      error.mockRestore();
      if (preservedRoot !== undefined) await rm(preservedRoot, { recursive: true, force: true });
      await rm(fakeBin, { recursive: true, force: true });
    }
  });
});
