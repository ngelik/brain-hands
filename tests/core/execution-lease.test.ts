import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireExecutionLease,
  approvePlanRevision,
  assertExecutionLease,
  beginExecutionEffect,
  readManifestV2,
  recordPlan,
  recordExecutionEffectChild,
  endExecutionEffect,
  releaseExecutionLease,
  setRunCheckoutIdentity,
  transitionRun,
  updateManifestV2,
} from "../../src/core/ledger.js";
import { createLegacyRunLedgerV2 } from "../fixtures/legacy-run.js";

let root: string | null = null;

async function fixture() {
  root = await mkdtemp(join(tmpdir(), "brain-hands-execution-lease-"));
  const run = await createLegacyRunLedgerV2({
    repoRoot: root,
    originalRequest: "execute one approved revision",
    sourceCommit: "a".repeat(40),
  });
  await transitionRun(run.runDir, "preflight");
  await transitionRun(run.runDir, "brain_planning");
  await recordPlan(run.runDir, JSON.stringify({ work_items: [] }));
  await transitionRun(run.runDir, "awaiting_plan_approval");
  await approvePlanRevision(run.runDir, 1, { actor: "human" });
  await transitionRun(run.runDir, "worktree_setup");
  return run;
}

async function forcePendingBoundary(runDir: string, baseRevision: number | null): Promise<void> {
  const path = join(runDir, "manifest.json");
  const manifest = await readManifestV2(runDir);
  const proposedRevision = baseRevision === null ? 1 : baseRevision + 1;
  const requestSha = "b".repeat(64);
  const subjectSha = "c".repeat(64);
  const record = {
    ...(manifest.plan_revisions[String(proposedRevision)] ?? {
      revision: proposedRevision,
      path: `plans/revision-${proposedRevision}.md`,
      sha256: "a".repeat(64),
    }),
    origin: baseRevision === null ? "initial" : "replan",
    base_revision: baseRevision,
    approval_request_path: `approvals/plan/revision-${proposedRevision}.json`,
    approval_request_sha256: requestSha,
    approval_subject_sha256: subjectSha,
    decision_contract_sha256: "d".repeat(64),
  };
  await writeFile(path, `${JSON.stringify({
    ...manifest,
    workflow_protocol: baseRevision === null ? "durable-discovery-v1" : manifest.workflow_protocol,
    stage: "awaiting_plan_approval",
    approval_protocol_version: 1,
    approval_protocol_start_revision: proposedRevision,
    current_revision: baseRevision ?? proposedRevision,
    current_plan_revision: baseRevision ?? proposedRevision,
    approved_revision: baseRevision,
    approved_plan_revision: baseRevision,
    plan_revisions: { ...manifest.plan_revisions, [String(proposedRevision)]: record },
    pending_plan_approval: {
      schema_version: 1,
      proposed_revision: proposedRevision,
      base_revision: baseRevision,
      request_path: record.approval_request_path,
      request_sha256: requestSha,
      approval_subject_sha256: subjectSha,
    },
  }, null, 2)}\n`);
}

async function acquireInExitedProcess(
  runDir: string,
  invocationId: string,
  mode: "execution" | "replan_preparation" | "pending_publication" | "initial_pending_publication" = "execution",
  beginEmptyEffect = false,
): Promise<void> {
  const code = [
    "import { acquireExecutionLease, beginExecutionEffect } from './src/core/ledger.ts'",
    `const claim = await acquireExecutionLease(${JSON.stringify(runDir)}, { invocationId: ${JSON.stringify(invocationId)}, mode: ${JSON.stringify(mode)} })`,
    ...(beginEmptyEffect ? [`await beginExecutionEffect(${JSON.stringify(runDir)}, claim, 'crashed-dispatch')`] : []),
  ].join("; ");
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
    cwd: process.cwd(),
    stdio: "inherit",
  });
  const [exitCode] = await once(child, "exit") as [number | null];
  if (exitCode !== 0) throw new Error(`Lease-owner fixture exited ${exitCode ?? "without a code"}`);
}

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = null;
});

describe("durable execution lease", () => {
  it("allows one owner and rejects a concurrent owner", async () => {
    const run = await fixture();
    const first = await acquireExecutionLease(run.runDir, { invocationId: "runtime-a" });

    await expect(acquireExecutionLease(run.runDir, { invocationId: "runtime-b" }))
      .rejects.toThrow(/active execution lease/i);
    await expect(assertExecutionLease(run.runDir, first)).resolves.toBeUndefined();
  });

  it("rejects generic checkout drift while a dedicated set-once transaction is idempotent", async () => {
    const run = await fixture();
    const lease = await acquireExecutionLease(run.runDir, { invocationId: "runtime-a" });
    const worktree = join(root!, ".brain-hands", "worktrees", run.runId);
    const branch = `codex/brain-hands/${run.runId}`;

    await setRunCheckoutIdentity(run.runDir, lease, { worktreePath: worktree, branchName: branch });
    await expect(setRunCheckoutIdentity(run.runDir, lease, { worktreePath: worktree, branchName: branch }))
      .resolves.toMatchObject({ worktree_path: worktree, branch_name: branch });
    await expect(updateManifestV2(run.runDir, { worktree_path: `${worktree}-forged` } as never))
      .rejects.toThrow(/immutable checkout/i);
    await expect(updateManifestV2(run.runDir, { checkout_allocation_state: "pending" } as never))
      .rejects.toThrow(/immutable checkout/i);
    await expect(updateManifestV2(run.runDir, { source_commit: "b".repeat(40) } as never))
      .rejects.toThrow(/immutable checkout/i);
  });

  it("releases only the matching token", async () => {
    const run = await fixture();
    const lease = await acquireExecutionLease(run.runDir, { invocationId: "runtime-a" });
    await expect(releaseExecutionLease(run.runDir, { ...lease, token: "forged" }))
      .rejects.toThrow(/lease token/i);
    await releaseExecutionLease(run.runDir, lease);
    expect((await readManifestV2(run.runDir)).execution_lease).toBeNull();
  });

  it("reclaims only a provably dead same-host owner with no uncertain effect", async () => {
    const run = await fixture();
    await acquireInExitedProcess(run.runDir, "dead-runtime");

    await expect(acquireExecutionLease(run.runDir, { invocationId: "reclaimer" }))
      .resolves.toMatchObject({ invocationId: "reclaimer" });
  });

  it("keeps a crashed dispatch with no bound child blocked as uncertain", async () => {
    const run = await fixture();
    await acquireInExitedProcess(run.runDir, "uncertain-runtime", "execution", true);
    const path = join(run.runDir, "manifest.json");
    const before = await readFile(path, "utf8");

    await expect(acquireExecutionLease(run.runDir, { invocationId: "other-runtime" }))
      .rejects.toThrow(/active execution lease/i);
    expect(await readFile(path, "utf8")).toBe(before);
  });

  it("rejects a forged remote/dead owner before reclaim", async () => {
    const run = await fixture();
    await acquireExecutionLease(run.runDir, { invocationId: "runtime" });
    const path = join(run.runDir, "manifest.json");
    const manifest = await readManifestV2(run.runDir);
    await writeFile(path, `${JSON.stringify({
      ...manifest,
      execution_lease: {
        ...manifest.execution_lease!,
        owner: { ...manifest.execution_lease!.owner, hostname: "remote.invalid", pid: 2_147_483_647 },
      },
    }, null, 2)}\n`);
    const before = await readFile(path, "utf8");
    await expect(acquireExecutionLease(run.runDir, { invocationId: "forged-reclaimer" }))
      .rejects.toThrow(/authority is corrupt/i);
    expect(await readFile(path, "utf8")).toBe(before);
  });

  it("does not reclaim a dead lease whose bound authority drifted", async () => {
    const run = await fixture();
    await acquireInExitedProcess(run.runDir, "dead-runtime");
    const path = join(run.runDir, "manifest.json");
    const manifest = await readManifestV2(run.runDir);
    await writeFile(path, `${JSON.stringify({
      ...manifest,
      stage: "implementing",
      execution_lease: manifest.execution_lease,
    }, null, 2)}\n`);
    const before = await readFile(path, "utf8");

    await expect(acquireExecutionLease(run.runDir, { invocationId: "reclaimer" }))
      .rejects.toThrow(/authority is corrupt/i);
    expect(await readFile(path, "utf8")).toBe(before);
  });

  it("retains the durable effect when a recorded child is still live", async () => {
    const run = await fixture();
    const lease = await acquireExecutionLease(run.runDir, { invocationId: "runtime" });
    const effect = await beginExecutionEffect(run.runDir, lease, "stubborn-child");
    await recordExecutionEffectChild(run.runDir, lease, effect, process.pid);

    await expect(endExecutionEffect(run.runDir, lease, effect)).rejects.toThrow(/live or uncertain/i);
    expect((await readManifestV2(run.runDir)).execution_lease?.active_effect?.child_pids)
      .toContain(process.pid);
  });

  it.skipIf(process.platform === "win32")("retains the durable effect while a dead wrapper's process group still has a descendant", async () => {
    const run = await fixture();
    const lease = await acquireExecutionLease(run.runDir, { invocationId: "runtime" });
    const effect = await beginExecutionEffect(run.runDir, lease, "forking-child");
    const wrapper = spawn(process.execPath, ["-e", [
      "const { spawn } = require('node:child_process')",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })",
      "child.unref()",
      "process.exit(0)",
    ].join("; ")], { detached: true, stdio: "ignore" });
    const wrapperPid = wrapper.pid!;
    const wrapperExit = once(wrapper, "exit");
    await recordExecutionEffectChild(run.runDir, lease, effect, wrapperPid);
    await wrapperExit;

    try {
      await expect(endExecutionEffect(run.runDir, lease, effect)).rejects.toThrow(/live or uncertain/i);
      expect((await readManifestV2(run.runDir)).execution_lease?.active_effect?.child_pids)
        .toContain(wrapperPid);
    } finally {
      try { process.kill(-wrapperPid, "SIGKILL"); } catch { /* already dead */ }
    }
  });

  it("rejects approval promotion and repair while any execution lease is active", async () => {
    const run = await fixture();
    await acquireExecutionLease(run.runDir, { invocationId: "runtime" });
    const manifestPath = join(run.runDir, "manifest.json");
    const eventsPath = join(run.runDir, "events.jsonl");
    const before = [await readFile(manifestPath, "utf8"), await readFile(eventsPath, "utf8")];

    await expect(approvePlanRevision(run.runDir, 1, { actor: "human" }))
      .rejects.toThrow(/active execution lease/i);
    expect([await readFile(manifestPath, "utf8"), await readFile(eventsPath, "utf8")]).toEqual(before);
  });

  it("keeps pending-publication approval blocked across dead-owner reclaim and replay", async () => {
    const run = await fixture();
    await forcePendingBoundary(run.runDir, 1);
    await acquireInExitedProcess(run.runDir, "publisher-a", "pending_publication");
    const first = (await readManifestV2(run.runDir)).execution_lease!;
    await expect(approvePlanRevision(run.runDir, 2, { actor: "human" }))
      .rejects.toThrow(/active execution lease/i);
    const reclaimed = await acquireExecutionLease(run.runDir, { invocationId: "publisher-b", mode: "pending_publication" });
    expect(reclaimed.token).not.toBe(first.token);
    await releaseExecutionLease(run.runDir, reclaimed);
    const replay = await acquireExecutionLease(run.runDir, { invocationId: "publisher-c", mode: "pending_publication" });
    await releaseExecutionLease(run.runDir, replay);
    expect((await readManifestV2(run.runDir)).pending_plan_approval?.proposed_revision).toBe(2);
  });

  it("reclaims an initial-pending publication only after its crashed owner is provably dead", async () => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-initial-publication-"));
    const run = await createLegacyRunLedgerV2({ repoRoot: root, originalRequest: "publish initial approval" });
    await transitionRun(run.runDir, "preflight");
    await transitionRun(run.runDir, "brain_planning");
    await recordPlan(run.runDir, JSON.stringify({ work_items: [] }));
    await forcePendingBoundary(run.runDir, null);
    await acquireInExitedProcess(run.runDir, "initial-a", "initial_pending_publication");
    const reclaimed = await acquireExecutionLease(run.runDir, { invocationId: "initial-b", mode: "initial_pending_publication" });
    await releaseExecutionLease(run.runDir, reclaimed);
    expect((await readManifestV2(run.runDir)).pending_plan_approval?.base_revision).toBeNull();
  });
});
