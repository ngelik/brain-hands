import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createRunLedgerV2,
  readManifestV2,
  recordTerminalDisposition,
  updateManifestV2,
} from "../../src/core/ledger.js";
import { abandonRun } from "../../src/workflow/assurance.js";
import * as preflight from "../../src/workflow/preflight.js";
import { replaceAbandonedRun, type ReplacementHooks } from "../../src/workflow/replacement.js";
import { prepareFreshRun } from "../../src/workflow/run-start.js";
import { readOperatorStatus } from "../../src/workflow/status.js";

const roots: string[] = [];
const preflightReport = {
  checks: [],
  required_checks_failed: false,
  github_auth: { status: "skipped" as const, reason: null, stderr: "" },
  github_auth_status: "skipped" as const,
  supports_search: true,
  github_repository: null,
  missing_github_labels: [],
  drifted_github_labels: [],
};

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function runFixture(options: { terminal?: "abandoned" | "closed_blocked" | "human_accepted" | "delivered" } = {}) {
  const root = await mkdtemp(join(tmpdir(), "brain-hands-replacement-"));
  roots.push(root);
  const { ledger } = await prepareFreshRun({
    repoRoot: root,
    task: "Replace an unrecoverable run",
    choices: {
      mode: "local",
      research: true,
      reflection: false,
      model_overrides: { hands: "explicit-hands" },
    },
    dryRun: true,
  });
  if (options.terminal === "abandoned") {
    const abandonment = await abandonRun(ledger.runDir, "operator@example.test", "The source cannot be recovered");
    await recordTerminalDisposition(ledger.runDir, {
      outcome: "abandoned",
      actor: "human",
      reason: abandonment.reason,
      residual_risks: [],
    });
  } else if (options.terminal) {
    if (options.terminal === "closed_blocked") {
      await updateManifestV2(ledger.runDir, { delivery_state: "blocked" });
    } else if (options.terminal === "human_accepted") {
      await updateManifestV2(ledger.runDir, { delivery_state: "ready" });
    } else if (options.terminal === "delivered") {
      await updateManifestV2(ledger.runDir, { stage: "complete", delivery_state: "complete" });
    }
    await recordTerminalDisposition(ledger.runDir, {
      outcome: options.terminal,
      actor: options.terminal === "delivered" ? "runtime" : "human",
      reason: "Closed without replacement",
      residual_risks: [],
    });
  }
  return ledger;
}

describe("explicit linked replacement", () => {
  it.each([
    ["active", undefined],
    ["blocked active", undefined],
    ["closed blocked", "closed_blocked"],
    ["human accepted", "human_accepted"],
    ["delivered", "delivered"],
  ] as const)("rejects %s predecessors", async (_label, terminal) => {
    const ledger = await runFixture({ terminal });
    if (_label === "blocked active") await updateManifestV2(ledger.runDir, { delivery_state: "blocked" });
    await expect(replaceAbandonedRun({
      runDir: ledger.runDir,
      actor: "operator@example.test",
      reason: "Start over safely",
      dryRun: true,
    })).rejects.toThrow(/terminal.*abandoned/i);
  });

  it("requires an intact matching abandonment artifact", async () => {
    const ledger = await runFixture({ terminal: "abandoned" });
    const manifest = await readManifestV2(ledger.runDir);
    await writeFile(join(ledger.runDir, manifest.abandonment_path!), "{}\n");
    await expect(replaceAbandonedRun({
      runDir: ledger.runDir,
      actor: "operator@example.test",
      reason: "Start over safely",
      dryRun: true,
    })).rejects.toThrow(/abandonment/i);
  });

  it("starts a fresh successor with only explicit intake choices and lineage", async () => {
    const ledger = await runFixture({ terminal: "abandoned" });
    vi.spyOn(preflight, "runPreflight").mockResolvedValue(preflightReport);

    const result = await replaceAbandonedRun({
      runDir: ledger.runDir,
      actor: " operator@example.test ",
      reason: " Start over safely ",
      dryRun: true,
    });
    const predecessor = await readManifestV2(ledger.runDir);
    const successor = await readManifestV2(result.successorRunDir);
    expect(result.reservation).toMatchObject({ actor: "operator@example.test", reason: "Start over safely" });
    expect(successor.task_lineage).toMatchObject({
      lineage_id: predecessor.task_lineage!.lineage_id,
      root_run_id: predecessor.task_lineage!.root_run_id,
      predecessor_run_id: predecessor.run_id,
      predecessor_abandonment_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(successor).toMatchObject({
      stage: "brain_discovery",
      approved_revision: null,
      approved_plan_revision: null,
      worktree_path: null,
      branch_name: null,
      issue_numbers: [],
      pull_request_numbers: [],
      delivery_state: "pending",
      assurance_outcome: null,
      terminal: null,
      recovery: { version: 1, active_scope: null, scopes: {} },
      controller_recovery: { version: 1, transition_count: 0, head_path: null },
    });
    expect(successor.discovery).toMatchObject({ answered_questions: 0, approved_brief_revision: null });
    expect(successor.plan_revisions).toEqual({});
    expect(successor.warning_continuation_authority).toBeUndefined();
    expect(successor.risk_acceptance_history).toEqual([]);
    expect(successor.final_artifact_paths).toEqual([]);
    expect(successor.github_ids).toEqual({
      issue_numbers: [], work_item_issue_map: {}, parent_issue_number: null,
      pull_request_numbers: [], pull_request_urls: {},
    });
    const configuration = JSON.parse(await readFile(join(result.successorRunDir, "run-configuration.json"), "utf8"));
    expect(configuration).toMatchObject({ mode: "local", research: true, reflection: false });
    expect(configuration.roles.hands).toMatchObject({ model: "explicit-hands", source: "cli_override" });
    expect(configuration.roles.brain.source).toBe("repository_config");
    expect(await readdir(join(result.successorRunDir, "responses"))).toEqual([]);
    expect(predecessor.final_artifact_paths).toContain("replacement/completion.json");
    expect(await readOperatorStatus(result.successorRunDir)).toMatchObject({
      task_lineage_id: predecessor.task_lineage!.lineage_id,
      predecessor_run_id: predecessor.run_id,
    });
  });

  it.each([
    "afterReservation",
    "afterSuccessorDirectoryCreated",
    "afterSuccessorBacklink",
    "afterSuccessorPreflight",
    "afterCompletionArtifact",
    "afterFinalArtifactAppend",
  ] as const)("replays a crash at %s without allocating another successor", async (boundary) => {
    const ledger = await runFixture({ terminal: "abandoned" });
    vi.spyOn(preflight, "runPreflight").mockResolvedValue(preflightReport);
    const sentinel = new Error(`crash:${boundary}`);
    let armed = true;
    const hooks: ReplacementHooks = {
      [boundary]: async () => {
        if (armed) {
          armed = false;
          throw sentinel;
        }
      },
    };
    await expect(replaceAbandonedRun({
      runDir: ledger.runDir,
      actor: "operator@example.test",
      reason: "Start over safely",
      dryRun: true,
      hooks,
    })).rejects.toBe(sentinel);

    const replay = await replaceAbandonedRun({
      runDir: ledger.runDir,
      actor: "operator@example.test",
      reason: "Start over safely",
      dryRun: true,
      hooks,
    });
    const runs = (await readdir(join(ledger.manifest.repo_root, ".brain-hands", "runs")))
      .filter((entry) => entry !== ledger.runId);
    expect(runs).toEqual([replay.successorRunId]);
    expect(JSON.parse(await readFile(join(ledger.runDir, "replacement/completion.json"), "utf8")))
      .toMatchObject({ successor_run_id: replay.successorRunId });
    expect((await readManifestV2(ledger.runDir)).final_artifact_paths
      .filter((path) => path === "replacement/completion.json")).toHaveLength(1);
  });

  it("fails closed for a conflicting reserved successor", async () => {
    const ledger = await runFixture({ terminal: "abandoned" });
    const sentinel = new Error("reservation created");
    await expect(replaceAbandonedRun({
      runDir: ledger.runDir,
      actor: "operator@example.test",
      reason: "Start over safely",
      dryRun: true,
      hooks: { afterReservation: async () => { throw sentinel; } },
    })).rejects.toBe(sentinel);
    const reservation = JSON.parse(await readFile(join(ledger.runDir, "replacement/reservation.json"), "utf8"));
    const conflicting = await createRunLedgerV2({
      repoRoot: ledger.manifest.repo_root,
      originalRequest: "foreign request",
      runId: reservation.successor_run_id,
    });
    await expect(replaceAbandonedRun({
      runDir: ledger.runDir,
      actor: "operator@example.test",
      reason: "Start over safely",
      dryRun: true,
    })).rejects.toThrow(/conflict|does not match/i);
    expect(createHash("sha256").update(await readFile(join(conflicting.runDir, "manifest.json"))).digest("hex"))
      .toMatch(/^[a-f0-9]{64}$/);
  });

  it("fails closed when the successor backlink is tampered", async () => {
    const ledger = await runFixture({ terminal: "abandoned" });
    vi.spyOn(preflight, "runPreflight").mockResolvedValue(preflightReport);
    const sentinel = new Error("backlink persisted");
    await expect(replaceAbandonedRun({
      runDir: ledger.runDir,
      actor: "operator@example.test",
      reason: "Start over safely",
      dryRun: true,
      hooks: { afterSuccessorBacklink: async () => { throw sentinel; } },
    })).rejects.toBe(sentinel);
    const reservation = JSON.parse(await readFile(join(ledger.runDir, "replacement/reservation.json"), "utf8"));
    const linkPath = join(ledger.manifest.repo_root, ".brain-hands", "runs", reservation.successor_run_id, "lineage/predecessor.json");
    const link = JSON.parse(await readFile(linkPath, "utf8"));
    await writeFile(linkPath, `${JSON.stringify({ ...link, predecessor_reservation_sha256: "f".repeat(64) }, null, 2)}\n`);

    await expect(replaceAbandonedRun({
      runDir: ledger.runDir,
      actor: "operator@example.test",
      reason: "Start over safely",
      dryRun: true,
    })).rejects.toThrow(/conflicts/i);
  });

  it("rejects a symlink at the reserved successor path", async () => {
    const ledger = await runFixture({ terminal: "abandoned" });
    const sentinel = new Error("reservation persisted");
    await expect(replaceAbandonedRun({
      runDir: ledger.runDir,
      actor: "operator@example.test",
      reason: "Start over safely",
      dryRun: true,
      hooks: { afterReservation: async () => { throw sentinel; } },
    })).rejects.toBe(sentinel);
    const reservation = JSON.parse(await readFile(join(ledger.runDir, "replacement/reservation.json"), "utf8"));
    const outside = join(ledger.manifest.repo_root, "outside-successor");
    await mkdir(outside);
    await symlink(outside, join(ledger.manifest.repo_root, ".brain-hands", "runs", reservation.successor_run_id));

    await expect(replaceAbandonedRun({
      runDir: ledger.runDir,
      actor: "operator@example.test",
      reason: "Start over safely",
      dryRun: true,
    })).rejects.toThrow(/conflicts with a run directory/i);
  });
});
