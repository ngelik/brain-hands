import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readManifestV2, taskLineageId, transitionRun } from "../../src/core/ledger.js";
import type { TaskLineageV1 } from "../../src/core/types.js";
import * as preflight from "../../src/workflow/preflight.js";
import {
  advancePreparedRunToDiscovery,
  prepareFreshRun,
  retryRunPreflightToDiscovery,
} from "../../src/workflow/run-start.js";

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

const requiredFailureCheck = {
  command: "git",
  args: ["rev-parse", "--show-toplevel"],
  required: true,
  status: "FAIL" as const,
  available: false,
  exit_code: 1,
  stdout: "",
  stderr: "not a repository",
};

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("fresh run bootstrap", () => {
  it("prepares the exact reserved run through intake without running preflight", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-run-start-prepare-"));
    roots.push(repoRoot);
    const lineage: TaskLineageV1 = {
      version: 1,
      lineage_id: taskLineageId("root-run"),
      root_run_id: "root-run",
      predecessor_run_id: "predecessor-run",
      predecessor_abandonment_sha256: "b".repeat(64),
    };
    const preflightCall = vi.spyOn(preflight, "runPreflight");

    const prepared = await prepareFreshRun({
      task: "Prepare a replacement boundary",
      repoRoot,
      choices: {
        mode: "local",
        research: false,
        reflection: true,
        model_overrides: { hands: "hands-override" },
      },
      dryRun: true,
      reservedRunId: "reserved-successor",
      taskLineage: lineage,
    });

    expect(prepared.ledger.runId).toBe("reserved-successor");
    expect(prepared.ledger.runDir).toBe(join(repoRoot, ".brain-hands", "runs", "reserved-successor"));
    expect(prepared.intake).toMatchObject({
      task: "Prepare a replacement boundary",
      repo_root: repoRoot,
      mode: "local",
      research: false,
      reflection: true,
      roles: { hands: { model: "hands-override" } },
    });
    expect(prepared.config).toBeDefined();
    expect(prepared.run_configuration.roles.hands.source).toBe("cli_override");
    expect(await readManifestV2(prepared.ledger.runDir)).toMatchObject({
      stage: "intake",
      task_lineage: lineage,
    });
    expect(JSON.parse(await readFile(join(prepared.ledger.runDir, "run-configuration.json"), "utf8")))
      .toEqual(prepared.run_configuration);
    const events = (await readFile(join(prepared.ledger.runDir, "events.jsonl"), "utf8")).trim().split("\n");
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0]!)).toMatchObject({ type: "controller_attested", stage: "intake" });
    expect(preflightCall).not.toHaveBeenCalled();
  });

  it("advances through preflight to brain discovery without invoking Brain", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-run-start-advance-"));
    roots.push(repoRoot);
    vi.spyOn(preflight, "runPreflight").mockResolvedValue(preflightReport);
    const prepared = await prepareFreshRun({
      task: "Advance to discovery",
      repoRoot,
      choices: { mode: "github", research: true, reflection: false, model_overrides: {} },
      dryRun: true,
    });

    const manifest = await advancePreparedRunToDiscovery(prepared, { dryRun: true });

    expect(manifest.stage).toBe("brain_discovery");
    expect(JSON.parse(await readFile(join(prepared.ledger.runDir, "preflight.json"), "utf8")))
      .toEqual(preflightReport);
    expect(await readdir(join(prepared.ledger.runDir, "responses"))).toEqual([]);
    const events = (await readFile(join(prepared.ledger.runDir, "events.jsonl"), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line) as { type: string });
    expect(events.map((event) => event.type)).toEqual([
      "controller_attested",
      "transition",
      "preflight_completed",
      "transition",
    ]);
  });

  it("reuses a valid persisted preflight report after interruption", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-run-start-replay-"));
    roots.push(repoRoot);
    const preflightCall = vi.spyOn(preflight, "runPreflight");
    const prepared = await prepareFreshRun({
      task: "Replay preflight",
      repoRoot,
      choices: { mode: "local", research: false, reflection: false, model_overrides: {} },
      dryRun: true,
    });
    await transitionRun(prepared.ledger.runDir, "preflight", { actor: "cli" });
    await writeFile(join(prepared.ledger.runDir, "preflight.json"), `${JSON.stringify(preflightReport, null, 2)}\n`);

    const manifest = await advancePreparedRunToDiscovery(prepared, { dryRun: true });

    expect(manifest.stage).toBe("brain_discovery");
    expect(preflightCall).not.toHaveBeenCalled();
    const events = (await readFile(join(prepared.ledger.runDir, "events.jsonl"), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line) as { type: string });
    expect(events.filter((event) => event.type === "preflight_completed")).toHaveLength(1);
  });

  it("persists a required-check failure and stops before discovery", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-run-start-required-check-"));
    roots.push(repoRoot);
    vi.spyOn(preflight, "runPreflight").mockResolvedValue({
      ...preflightReport,
      required_checks_failed: true,
    });
    const prepared = await prepareFreshRun({
      task: "Enforce preflight",
      repoRoot,
      choices: { mode: "local", research: false, reflection: false, model_overrides: {} },
      dryRun: true,
    });

    await expect(advancePreparedRunToDiscovery(prepared, { dryRun: false }))
      .rejects.toThrow("Preflight failed; inspect preflight.json before retrying.");

    expect((await readManifestV2(prepared.ledger.runDir)).stage).toBe("preflight");
    expect(JSON.parse(await readFile(join(prepared.ledger.runDir, "preflight.json"), "utf8")))
      .toMatchObject({ required_checks_failed: true });
  });

  it("rechecks a failed preflight during same-run recovery", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-run-start-retry-"));
    roots.push(repoRoot);
    const runPreflight = vi.spyOn(preflight, "runPreflight")
      .mockResolvedValueOnce({
        ...preflightReport,
        checks: [requiredFailureCheck],
        required_checks_failed: true,
      })
      .mockResolvedValueOnce(preflightReport);
    const prepared = await prepareFreshRun({
      task: "Retry repaired preflight",
      repoRoot,
      choices: { mode: "local", research: false, reflection: false, model_overrides: {} },
      dryRun: true,
    });
    await expect(advancePreparedRunToDiscovery(prepared, { dryRun: false }))
      .rejects.toThrow("Preflight failed");

    const manifest = await retryRunPreflightToDiscovery(prepared.ledger.runDir, {
      dryRun: true,
    });

    expect(manifest.stage).toBe("brain_discovery");
    expect(runPreflight).toHaveBeenCalledTimes(2);
    expect(JSON.parse(await readFile(join(prepared.ledger.runDir, "preflight.json"), "utf8")))
      .toEqual(preflightReport);
    const events = (await readFile(join(prepared.ledger.runDir, "events.jsonl"), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line) as { type: string });
    expect(events.filter((event) => event.type === "preflight_completed")).toHaveLength(2);
  });

  it("rejects an incomplete persisted preflight report", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-run-start-invalid-report-"));
    roots.push(repoRoot);
    const preflightCall = vi.spyOn(preflight, "runPreflight");
    const prepared = await prepareFreshRun({
      task: "Reject incomplete preflight",
      repoRoot,
      choices: { mode: "local", research: false, reflection: false, model_overrides: {} },
      dryRun: true,
    });
    await transitionRun(prepared.ledger.runDir, "preflight", { actor: "cli" });
    await writeFile(join(prepared.ledger.runDir, "preflight.json"), JSON.stringify({
      checks: [],
      required_checks_failed: false,
      missing_github_labels: [],
    }));

    await expect(advancePreparedRunToDiscovery(prepared, { dryRun: true }))
      .rejects.toThrow("valid persisted preflight.json report");

    expect((await readManifestV2(prepared.ledger.runDir)).stage).toBe("preflight");
    expect(preflightCall).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "a malformed check entry",
      report: { ...preflightReport, checks: [{ ...requiredFailureCheck, unexpected: true }], required_checks_failed: true },
    },
    {
      label: "conflicting GitHub auth aliases",
      report: { ...preflightReport, github_auth_status: "authenticated" },
    },
    {
      label: "a false required-check summary",
      report: { ...preflightReport, checks: [requiredFailureCheck], required_checks_failed: false },
    },
  ])("rejects $label without mutating replay state", async ({ report }) => {
    const repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-run-start-corrupt-report-"));
    roots.push(repoRoot);
    const preflightCall = vi.spyOn(preflight, "runPreflight");
    const prepared = await prepareFreshRun({
      task: "Reject corrupt preflight semantics",
      repoRoot,
      choices: { mode: "local", research: false, reflection: false, model_overrides: {} },
      dryRun: true,
    });
    await transitionRun(prepared.ledger.runDir, "preflight", { actor: "cli" });
    const artifactPath = join(prepared.ledger.runDir, "preflight.json");
    await writeFile(artifactPath, `${JSON.stringify(report, null, 2)}\n`);
    const manifestBefore = await readFile(join(prepared.ledger.runDir, "manifest.json"));
    const eventsBefore = await readFile(join(prepared.ledger.runDir, "events.jsonl"));
    const artifactBefore = await readFile(artifactPath);

    await expect(advancePreparedRunToDiscovery(prepared, { dryRun: true }))
      .rejects.toThrow("valid persisted preflight.json report");

    expect(await readFile(join(prepared.ledger.runDir, "manifest.json"))).toEqual(manifestBefore);
    expect(await readFile(join(prepared.ledger.runDir, "events.jsonl"))).toEqual(eventsBefore);
    expect(await readFile(artifactPath)).toEqual(artifactBefore);
    expect(preflightCall).not.toHaveBeenCalled();
  });
});
