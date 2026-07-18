import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";
import { formatIssueBody } from "../../src/adapters/github.js";
import { formatRunStatusComment, readOperatorStatus } from "../../src/workflow/status.js";

let repoRoot: string | null = null;

afterEach(async () => {
  if (repoRoot) {
    await rm(repoRoot, { recursive: true, force: true });
    repoRoot = null;
  }
});

async function ensureBuiltCli(projectRoot: string): Promise<string> {
  const cliPath = join(projectRoot, "dist", "cli.js");
  try {
    await access(cliPath, constants.F_OK);
    return cliPath;
  } catch {
    throw new Error(
      `Built CLI is missing at ${cliPath}. Run npm run build before the E2E dry-run test.`,
    );
  }
}

async function runBuiltCli(
  projectRoot: string,
  args: string[],
  env: NodeJS.ProcessEnv = {},
  input?: string,
): Promise<{ stdout: string; stderr: string }> {
  const cliPath = await ensureBuiltCli(projectRoot);
  const {
    BRAIN_HANDS_CONTROLLER_MODE: _controllerMode,
    BRAIN_HANDS_EXECUTABLE_PATH: _executablePath,
    ...baseEnv
  } = process.env;
  const result = await execa("node", [cliPath, ...args], {
    cwd: projectRoot,
    reject: false,
    extendEnv: false,
    env: { ...baseEnv, ...env },
    input,
  });

  if (result.exitCode !== 0) {
    throw new Error(
      [
        `Built CLI failed for args: ${args.join(" ")}`,
        `exit=${result.exitCode ?? "null"}`,
        result.stdout.trim(),
        result.stderr.trim(),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  return {
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

async function expectNoGitHubProjectionBeforePlanApproval(runDir: string): Promise<void> {
  const manifest = JSON.parse(await readFile(join(runDir, "manifest.json"), "utf8")) as {
    stage: string;
    issue_numbers: number[];
    pull_request_numbers: number[];
    work_item_issue_map: Record<string, number>;
    github_ids: {
      issue_numbers: number[];
      work_item_issue_map: Record<string, number>;
      parent_issue_number: number | null;
      pull_request_numbers: number[];
      pull_request_urls: Record<string, string>;
    };
  };
  expect(manifest.issue_numbers).toEqual([]);
  expect(manifest.pull_request_numbers).toEqual([]);
  expect(manifest.work_item_issue_map).toEqual({});
  expect(manifest.github_ids).toEqual({
    issue_numbers: [],
    work_item_issue_map: {},
    parent_issue_number: null,
    pull_request_numbers: [],
    pull_request_urls: {},
  });
  for (const artifact of ["github-map.json", "github-issue-sync.json"]) {
    await expect(access(join(runDir, artifact), constants.F_OK)).rejects.toMatchObject({ code: "ENOENT" });
  }
  if (manifest.stage.startsWith("awaiting_discovery_")) {
    const comment = formatRunStatusComment(await readOperatorStatus(runDir));
    expect(comment.body).toBe(`${comment.marker}\nAwaiting local discovery input.`);
  }
}

describe("built CLI artifact prerequisite", () => {
  it("fails clearly without invoking package build or clean when dist/cli.js is absent", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-missing-built-cli-"));
    const lifecycleMarker = join(repoRoot, "lifecycle-invoked.txt");
    await writeFile(
      join(repoRoot, "record-lifecycle.mjs"),
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(lifecycleMarker)}, process.argv[2]);\n`,
    );
    await writeFile(join(repoRoot, "package.json"), JSON.stringify({
      scripts: {
        build: "node record-lifecycle.mjs build",
        clean: "node record-lifecycle.mjs clean",
      },
    }));

    await expect(runBuiltCli(repoRoot, ["--help"])).rejects.toThrow(
      `Built CLI is missing at ${join(repoRoot, "dist", "cli.js")}. Run npm run build before the E2E dry-run test.`,
    );
    await expect(access(join(repoRoot, "dist"), constants.F_OK)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(access(lifecycleMarker, constants.F_OK)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function readRunTextFiles(runDir: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  async function visit(directory: string, prefix = ""): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path, relativePath);
      else if (entry.isFile()) files[relativePath] = await readFile(path, "utf8");
    }
  }
  await visit(runDir);
  return files;
}

async function advanceBuiltDiscovery(
  projectRoot: string,
  runId: string,
  targetRepo: string,
  options: { answer?: string; afterBoundary?: (runDir: string) => Promise<void> } = {},
): Promise<void> {
  const runDir = join(targetRepo, ".brain-hands", "runs", runId);
  await runBuiltCli(projectRoot, [
    "answer-discovery", "--run", runDir, "--question", "q-001", "--dry-run", "--json",
  ], {}, `${options.answer ?? "Use explicit durable boundaries"}\n`);
  let manifest = JSON.parse(await readFile(join(runDir, "manifest.json"), "utf8")) as {
    stage: string;
    discovery: { approved_brief_revision: number | null; approved_brief_sha256: string | null };
  };
  expect(manifest.stage).toBe("awaiting_discovery_approach");
  const pendingApproachBytes = await readFile(join(runDir, "discovery/pending-action.json"), "utf8");
  const pendingApproach = JSON.parse(pendingApproachBytes) as {
    state: string;
    revision: number;
    approaches: Array<{
      id: string;
      title: string;
      summary: string;
      tradeoffs: string[];
      recommended: boolean;
      recommendation_rationale: string | null;
    }>;
    permitted_next_actions: string[];
  };
  expect(pendingApproach).toEqual({
    state: "awaiting_discovery_approach",
    revision: 1,
    approaches: [
      {
        id: "approach-explicit",
        title: "Explicit boundaries",
        summary: "Stop at each durable user boundary.",
        tradeoffs: ["Requires a separate operator command for each decision."],
        recommended: true,
        recommendation_rationale: "It preserves exact durable intent.",
      },
      {
        id: "approach-minimal",
        title: "Minimal boundaries",
        summary: "Stop only for approvals.",
        tradeoffs: ["Intermediate decisions are less visible."],
        recommended: false,
        recommendation_rationale: null,
      },
    ],
    permitted_next_actions: ["select-discovery-approach"],
  });
  expect(pendingApproach.approaches.filter((approach) => approach.recommended)).toHaveLength(1);
  const resumedApproach = JSON.parse((await runBuiltCli(
    projectRoot,
    ["resume", runId, "--repo", targetRepo, "--dry-run", "--json"],
  )).stdout) as { pending_action: typeof pendingApproach };
  expect(resumedApproach.pending_action).toEqual(pendingApproach);
  const approachStatus = await runBuiltCli(projectRoot, ["status", runId, "--repo", targetRepo]);
  expect(approachStatus.stdout).toContain("Recommended approach: approach-explicit");
  expect(approachStatus.stdout).toContain("Recommendation rationale: It preserves exact durable intent.");
  expect(await readFile(join(runDir, "discovery/pending-action.json"), "utf8")).toBe(pendingApproachBytes);
  expect(await readdir(join(runDir, "implementation"))).toEqual([]);
  expect((await readdir(join(runDir, "responses"))).some((name) => name.startsWith("hands-"))).toBe(false);
  await options.afterBoundary?.(runDir);

  await runBuiltCli(projectRoot, [
    "select-discovery-approach", "--run", runDir, "--revision", "1", "--approach", "approach-explicit", "--dry-run", "--json",
  ]);
  manifest = JSON.parse(await readFile(join(runDir, "manifest.json"), "utf8"));
  expect(manifest.stage).toBe("awaiting_discovery_brief_approval");
  const pendingBrief = JSON.parse(await readFile(join(runDir, "discovery/pending-action.json"), "utf8")) as {
    state: string;
    revision: number;
    brief: { selected_approach_id: string; selected_approach_rationale: string | null };
  };
  expect(pendingBrief).toMatchObject({
    state: "awaiting_discovery_brief_approval",
    revision: 1,
    brief: {
      selected_approach_id: "approach-explicit",
      selected_approach_rationale: "It preserves exact durable intent.",
    },
  });
  const resumedBrief = JSON.parse((await runBuiltCli(
    projectRoot,
    ["resume", runId, "--repo", targetRepo, "--dry-run", "--json"],
  )).stdout) as { pending_action: typeof pendingBrief };
  expect(resumedBrief.pending_action).toEqual(pendingBrief);
  expect(await readdir(join(runDir, "plans"))).toEqual([]);
  expect(await readdir(join(runDir, "implementation"))).toEqual([]);
  await options.afterBoundary?.(runDir);

  await runBuiltCli(projectRoot, [
    "approve-discovery", "--run", runDir, "--revision", "1", "--dry-run", "--json",
  ]);
  manifest = JSON.parse(await readFile(join(runDir, "manifest.json"), "utf8"));
  expect(manifest.stage).toBe("awaiting_plan_approval");
  expect(manifest.discovery.approved_brief_revision).toBe(1);
  const approvedBriefBytes = await readFile(join(runDir, "discovery/approved-brief.json"), "utf8");
  const approvedBriefSha256 = createHash("sha256").update(approvedBriefBytes).digest("hex");
  expect(manifest.discovery.approved_brief_sha256).toBe(approvedBriefSha256);
  const plan = JSON.parse(await readFile(join(runDir, "plans/revision-1.md"), "utf8")) as {
    discovery_brief_revision: number;
    discovery_brief_sha256: string;
  };
  expect(plan.discovery_brief_revision).toBe(1);
  expect(plan.discovery_brief_sha256).toBe(approvedBriefSha256);
  expect(await readdir(join(runDir, "implementation"))).toEqual([]);
  expect((await readdir(join(runDir, "responses"))).some((name) => name.startsWith("hands-"))).toBe(false);
  await options.afterBoundary?.(runDir);
}

describe("built CLI dry-run workflow", () => {
  it("completes a normal local dry run with exactly one discovery and one initial-plan approval", async () => {
    const projectRoot = process.cwd();
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-e2e-"));

    await execa("git", ["init", "-q"], { cwd: repoRoot });
    await execa("git", ["config", "user.email", "brain-hands@example.test"], { cwd: repoRoot });
    await execa("git", ["config", "user.name", "Brain Hands"], { cwd: repoRoot });
    await writeFile(join(repoRoot, "README.md"), "dry-run\n", "utf8");
    await execa("git", ["add", "README.md"], { cwd: repoRoot });
    await execa("git", ["commit", "-qm", "initial"], { cwd: repoRoot });

    const initResult = await runBuiltCli(projectRoot, ["init", "--repo", repoRoot]);
    const configPath = join(repoRoot, ".brain-hands", "config.yaml");

    await access(configPath, constants.F_OK);
    expect(initResult.stdout).toContain("Brain Hands repository initialized");
    expect(initResult.stdout).toContain("config.yaml (created)");
    expect(initResult.stderr).toBe("");

    const request = "Implement Task 14 E2E dry-run coverage";
    const runResult = await runBuiltCli(projectRoot, ["run", request, "--repo", repoRoot, "--mode", "local", "--no-research", "--reflection", "--dry-run"]);
    const runsDir = join(repoRoot, ".brain-hands", "runs");
    const runEntries = await readdir(runsDir);

    expect(runEntries).toHaveLength(1);

    const runId = runEntries[0];
    const runDir = join(runsDir, runId);
    const manifest = JSON.parse(await readFile(join(runDir, "manifest.json"), "utf8")) as {
      stage: string;
      original_request: string;
      current_revision: number | null;
      approved_revision: number | null;
      mode: string;
      review_policy_snapshot?: { max_fix_cycles: number; on_limit: string };
      quality_gate_policy?: { hands_self_review_passes: number };
      release_guards?: Array<{ id: string }>;
      controller_provenance?: { package_name: string; package_hash: string; candidate_commit: string };
      source_commit: string | null;
    };
    const originalRequest = await readFile(join(runDir, "original-request.md"), "utf8");
    const pendingPath = join(runDir, "discovery/pending-action.json");
    const pendingBeforeResume = await readFile(pendingPath, "utf8");
    const persistedQuestion = JSON.parse(
      await readFile(join(runDir, "discovery/questions/001.json"), "utf8"),
    ) as Record<string, unknown>;
    const pendingAction = JSON.parse(pendingBeforeResume) as {
      question: typeof persistedQuestion;
    };

    expect(runResult.stdout).toContain(`Run ${runId} reached its first user boundary`);
    expect(runResult.stdout).toContain(`Run directory: ${runDir}`);
    expect(runResult.stdout).toContain("awaiting_discovery_answer");
    expect(runResult.stderr).toBe("");

    expect(manifest.stage).toBe("awaiting_discovery_answer");
    expect(persistedQuestion).toMatchObject({
      recommended_choice_id: "explicit",
      recommendation_rationale: "Explicit boundaries preserve durable operator intent.",
    });
    expect(pendingAction.question).toMatchObject({
      recommended_choice_id: "explicit",
      recommendation_rationale: "Explicit boundaries preserve durable operator intent.",
    });
    expect(pendingAction.question).toEqual(persistedQuestion);
    expect(manifest.original_request).toBe(request);
    expect(manifest.current_revision).toBeNull();
    expect(manifest.approved_revision).toBeNull();
    expect(manifest.mode).toBe("local");
    expect(manifest.review_policy_snapshot).toMatchObject({ max_fix_cycles: 2, on_limit: "auto_replan" });
    expect(manifest.quality_gate_policy).toMatchObject({ hands_self_review_passes: 1 });
    expect(manifest.release_guards?.map((guard) => guard.id)).toContain("release:no-auto-merge");
    expect(manifest.controller_provenance?.package_name).toBe("@ngelik/brain-hands");
    expect(manifest.controller_provenance?.package_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.source_commit).toBe(manifest.controller_provenance?.candidate_commit);
    expect(originalRequest).toBe(`${request}\n`);

    const resumeBoundary = await runBuiltCli(projectRoot, ["resume", runId, "--repo", repoRoot, "--dry-run", "--json"]);
    expect(resumeBoundary.stdout).toContain('"pending_action"');
    expect((JSON.parse(resumeBoundary.stdout) as { pending_action: typeof pendingAction }).pending_action.question)
      .toEqual(pendingAction.question);
    expect(await readFile(pendingPath, "utf8")).toBe(pendingBeforeResume);
    const statusBoundary = await runBuiltCli(projectRoot, ["status", runId, "--repo", repoRoot]);
    expect(statusBoundary.stdout).toContain("Next command (answer-discovery)");
    expect(statusBoundary.stdout).toContain("Next command (proceed-discovery)");
    expect(statusBoundary.stdout).toContain("Recommended choice: explicit");
    expect(statusBoundary.stdout).toContain("Recommendation rationale: Explicit boundaries preserve durable operator intent.");

    await advanceBuiltDiscovery(projectRoot, runId, repoRoot);
    const research = await readFile(join(runDir, "research.md"), "utf8");
    const architecturePlan = await readFile(join(runDir, "architecture-plan.md"), "utf8");
    expect(research).toContain("No external research");
    expect(architecturePlan).toContain("No source changes");

    const approvalRequestPath = join(runDir, "approvals/plan/revision-1.json");
    const approvalRequestBytes = await readFile(approvalRequestPath, "utf8");
    const approvalRequest = JSON.parse(approvalRequestBytes) as {
      subject: { reason_code: string; plan_revision: number; base_plan_revision: number | null };
    };
    expect(approvalRequest.subject).toMatchObject({
      reason_code: "initial_plan",
      plan_revision: 1,
      base_plan_revision: null,
    });
    const approvalRequestEntries = await readdir(join(runDir, "approvals/plan"));
    const beforeApprovalEvents = (await readFile(join(runDir, "events.jsonl"), "utf8"))
      .split("\n").filter(Boolean).map((line) => JSON.parse(line) as { type?: string; payload?: { revision?: number } });
    expect(beforeApprovalEvents.filter((event) => event.type === "discovery_brief_approved")).toHaveLength(1);
    expect(beforeApprovalEvents.filter((event) => event.type === "plan_approved")).toHaveLength(0);
    expect(approvalRequestEntries).toEqual(["revision-1.json"]);

    const approveResult = await runBuiltCli(projectRoot, ["approve-plan", runId, "--revision", "1", "--repo", repoRoot, "--dry-run"]);
    expect(approveResult.stdout).toContain("local_ready");
    const completedManifest = JSON.parse(await readFile(join(runDir, "manifest.json"), "utf8")) as {
      stage: string;
      delivery_state: string;
      terminal: { outcome: string; actor: string } | null;
      review_accounting: { review_revision: number; fix_cycles_used: number };
      pending_plan_approval: unknown;
    };
    expect(completedManifest.stage).toBe("complete");
    expect(completedManifest.delivery_state).toBe("ready");
    expect(completedManifest.terminal).toMatchObject({ outcome: "delivered", actor: "runtime" });
    expect(completedManifest.review_accounting).toMatchObject({ review_revision: 2, fix_cycles_used: 0 });
    expect(completedManifest.pending_plan_approval).toBeNull();
    expect(await readdir(join(runDir, "reviews/decisions"))).toHaveLength(2);
    await access(join(runDir, "reflection.json"), constants.F_OK);
    await access(join(runDir, "reflection.md"), constants.F_OK);
    const progress = await readFile(join(runDir, "progress.jsonl"), "utf8");
    expect(progress).toContain("Work item 1 of 1 - implementation attempt 1");
    expect(progress).toContain("Verifier approved work item 1");
    expect(await readdir(join(runDir, "implementation"))).not.toEqual([]);

    const afterApprovalEvents = (await readFile(join(runDir, "events.jsonl"), "utf8"))
      .split("\n").filter(Boolean).map((line) => JSON.parse(line) as {
        type?: string;
        stage?: string;
        payload?: { revision?: number; approval_semantics_version?: number };
      });
    expect(afterApprovalEvents.filter((event) => event.type === "discovery_brief_approved")).toHaveLength(1);
    expect(afterApprovalEvents.filter((event) => event.type === "plan_approved")).toEqual([
      expect.objectContaining({
        type: "plan_approved",
        stage: "awaiting_plan_approval",
        payload: expect.objectContaining({ revision: 1, approval_semantics_version: 1 }),
      }),
    ]);
    expect(await readdir(join(runDir, "approvals/plan"))).toEqual(approvalRequestEntries);
    expect(await readFile(approvalRequestPath, "utf8")).toBe(approvalRequestBytes);

    const completedManifestText = await readFile(join(runDir, "manifest.json"), "utf8");
    const completedEvents = await readFile(join(runDir, "events.jsonl"), "utf8");
    const completedRunTree = await readRunTextFiles(runDir);
    const resumeResult = await runBuiltCli(projectRoot, ["resume", runId, "--repo", repoRoot, "--dry-run"]);
    expect(resumeResult.stdout).toContain(`Run ${runId}: local_ready (complete)`);
    expect(await readFile(join(runDir, "manifest.json"), "utf8")).toBe(completedManifestText);
    expect(await readFile(join(runDir, "events.jsonl"), "utf8")).toBe(completedEvents);
    expect(await readRunTextFiles(runDir)).toEqual(completedRunTree);
    expect(JSON.parse(await readFile(join(runDir, "manifest.json"), "utf8"))).toMatchObject({
      stage: "complete",
      pending_plan_approval: null,
    });
    expect(await readdir(join(runDir, "approvals/plan"))).toEqual(approvalRequestEntries);
    expect(await readFile(approvalRequestPath, "utf8")).toBe(approvalRequestBytes);

    await Promise.all(
      [
        "manifest.json",
        "original-request.md",
        "research.md",
        "architecture-plan.md",
      ].map((artifact) => access(join(runDir, artifact), constants.F_OK)),
    );
  }, 120_000);

  it("records forced discovery assumptions at an explicit fresh-process boundary", async () => {
    const projectRoot = process.cwd();
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-e2e-proceed-"));
    await execa("git", ["init", "-q"], { cwd: repoRoot });
    await execa("git", ["config", "user.email", "brain-hands@example.test"], { cwd: repoRoot });
    await execa("git", ["config", "user.name", "Brain Hands"], { cwd: repoRoot });
    await writeFile(join(repoRoot, "README.md"), "forced assumptions\n", "utf8");
    await execa("git", ["add", "README.md"], { cwd: repoRoot });
    await execa("git", ["commit", "-qm", "initial"], { cwd: repoRoot });

    await runBuiltCli(projectRoot, [
      "run", "Proceed with documented uncertainty", "--repo", repoRoot, "--mode", "local",
      "--no-research", "--no-reflection", "--dry-run", "--json",
    ]);
    const [runId] = await readdir(join(repoRoot, ".brain-hands", "runs"));
    const runDir = join(repoRoot, ".brain-hands", "runs", runId);
    const proceed = await runBuiltCli(projectRoot, [
      "proceed-discovery", "--run", runDir, "--question", "q-001", "--dry-run", "--json",
    ], {}, "Proceed and record the remaining uncertainty\n");
    expect(proceed.stdout).toContain("awaiting_discovery_brief_approval");
    const pendingPath = join(runDir, "discovery/pending-action.json");
    const pendingBytes = await readFile(pendingPath, "utf8");
    const pending = JSON.parse(pendingBytes) as {
      brief: {
        assumptions: Array<{ source: string; statement: string }>;
        selected_approach_id: string | null;
        selected_approach_rationale: string | null;
      };
    };
    expect(pending.brief.assumptions).toContainEqual(expect.objectContaining({
      source: "proceed_with_assumptions",
      statement: "Operator guidance: Proceed and record the remaining uncertainty",
    }));
    expect(pending.brief).toMatchObject({
      selected_approach_id: null,
      selected_approach_rationale: null,
    });
    const responsesBefore = await readdir(join(runDir, "responses"));
    const resumed = await runBuiltCli(projectRoot, ["resume", runId, "--repo", repoRoot, "--dry-run", "--json"]);
    expect(resumed.stdout).toContain("awaiting_discovery_brief_approval");
    expect((JSON.parse(resumed.stdout) as { pending_action: typeof pending }).pending_action).toEqual(pending);
    expect(await readFile(pendingPath, "utf8")).toBe(pendingBytes);
    expect(await readdir(join(runDir, "responses"))).toEqual(responsesBefore);
    expect(await readdir(join(runDir, "plans"))).toEqual([]);
    expect(await readdir(join(runDir, "implementation"))).toEqual([]);
  }, 20_000);

  it("rejects an unmarked checkout controller for a self-hosting candidate before ledger creation", async () => {
    const projectRoot = process.cwd();
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-self-host-"));
    await execa("git", ["init", "-q"], { cwd: repoRoot });
    await execa("git", ["config", "user.email", "brain-hands@example.test"], { cwd: repoRoot });
    await execa("git", ["config", "user.name", "Brain Hands"], { cwd: repoRoot });
    await writeFile(join(repoRoot, "package.json"), JSON.stringify({ name: "@ngelik/brain-hands", version: "0.2.0" }));
    await execa("git", ["add", "package.json"], { cwd: repoRoot });
    await execa("git", ["commit", "-qm", "candidate"], { cwd: repoRoot });

    await expect(runBuiltCli(projectRoot, [
      "run", "Self host", "--repo", repoRoot, "--mode", "local", "--no-research", "--no-reflection", "--dry-run",
    ])).rejects.toThrow(/requires an installed.*checkout controllers require --development-controller/i);
    await expect(access(join(repoRoot, ".brain-hands", "runs"), constants.F_OK)).rejects.toMatchObject({ code: "ENOENT" });

    await runBuiltCli(projectRoot, [
      "run", "Develop self host", "--repo", repoRoot, "--mode", "local", "--no-research", "--no-reflection", "--dry-run",
    ], { BRAIN_HANDS_CONTROLLER_MODE: "development_checkout" });
    const [runId] = await readdir(join(repoRoot, ".brain-hands", "runs"));
    const manifestPath = join(repoRoot, ".brain-hands", "runs", runId, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      controller_provenance: { mode: string; package_hash: string };
    };
    expect(manifest.controller_provenance.mode).toBe("development_checkout");
    manifest.controller_provenance.package_hash = "f".repeat(64);
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await expect(runBuiltCli(projectRoot, [
      "answer-discovery", "--run", join(repoRoot, ".brain-hands", "runs", runId), "--question", "q-001", "--dry-run",
    ], { BRAIN_HANDS_CONTROLLER_MODE: "development_checkout" }, "Use explicit boundaries\n"))
      .rejects.toThrow(/does not match the accepted self-hosting run controller/i);
  }, 20_000);

  it("completes a GitHub-mode dry run without requiring a real remote", async () => {
    const projectRoot = process.cwd();
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-e2e-github-"));
    await execa("git", ["init", "-q"], { cwd: repoRoot });
    await execa("git", ["config", "user.email", "brain-hands@example.test"], { cwd: repoRoot });
    await execa("git", ["config", "user.name", "Brain Hands"], { cwd: repoRoot });
    await writeFile(join(repoRoot, "README.md"), "dry-run\n", "utf8");
    await execa("git", ["add", "README.md"], { cwd: repoRoot });
    await execa("git", ["commit", "-qm", "initial"], { cwd: repoRoot });

    const privateAnswer = "PRIVATE_GITHUB_DISCOVERY_7f9c2f11 never publish this answer";
    await runBuiltCli(projectRoot, ["run", "Verify GitHub dry-run delivery", "--repo", repoRoot, "--mode", "github", "--no-research", "--no-reflection", "--dry-run"]);
    const [runId] = await readdir(join(repoRoot, ".brain-hands", "runs"));
    const runDir = join(repoRoot, ".brain-hands", "runs", runId);
    const initialPending = JSON.parse(await readFile(join(runDir, "discovery/pending-action.json"), "utf8")) as {
      question: {
        text: string;
        choices: Array<{ label: string; description: string }>;
        rationale: string;
      };
    };
    await expectNoGitHubProjectionBeforePlanApproval(runDir);
    await advanceBuiltDiscovery(projectRoot, runId, repoRoot, {
      answer: privateAnswer,
      afterBoundary: expectNoGitHubProjectionBeforePlanApproval,
    });
    const approaches = JSON.parse(await readFile(join(runDir, "discovery/approaches/revision-001.json"), "utf8")) as {
      approaches: Array<{
        title: string;
        summary: string;
        tradeoffs: string[];
        recommendation_rationale: string | null;
      }>;
    };
    const brief = JSON.parse(await readFile(join(runDir, "discovery/briefs/revision-001.json"), "utf8")) as {
      goal: string;
      problem: string;
      success_criteria: string[];
      constraints: string[];
      selected_approach_rationale: string | null;
      out_of_scope: string[];
    };
    const plan = JSON.parse(await readFile(join(runDir, "plans", "revision-1.md"), "utf8")) as {
      work_items: Array<Parameters<typeof formatIssueBody>[0] & {
        id: string;
        objective: string;
        acceptance: Array<{ statement: string }>;
      }>;
    };
    expect(plan.work_items[0]?.objective).toContain("GitHub lifecycle");
    expect(plan.work_items[0]?.acceptance.map((criterion) => criterion.statement)).toContain("The dry-run lifecycle reaches github_ready.");
    const approve = await runBuiltCli(projectRoot, ["approve-plan", runId, "--revision", "1", "--repo", repoRoot, "--dry-run"]);
    expect(approve.stdout).toContain("awaiting_github_effects");
    expect(approve.stdout).toContain("awaiting_github_issue_effects");
    const manifest = JSON.parse(await readFile(join(runDir, "manifest.json"), "utf8")) as {
      stage: string;
      delivery_state: string;
      last_blocker: string | null;
      task_lineage_id: string;
      branch_name: string;
      work_item_issue_map: Record<string, number>;
      github_ids: { issue_numbers: number[]; pull_request_numbers: number[] };
    };
    expect(manifest).toMatchObject({ stage: "awaiting_github_issue_effects", delivery_state: "pending", last_blocker: null });
    expect(manifest.github_ids.issue_numbers).toEqual([]);
    expect(manifest.github_ids.pull_request_numbers).toEqual([]);
    expect(manifest).toMatchObject({ terminal: null });
    await expect(access(join(runDir, "github-map.json"), constants.F_OK)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(runDir, "github-issue-sync.json"), constants.F_OK)).rejects.toMatchObject({ code: "ENOENT" });
    const preview = await readFile(join(runDir, "github-effects/issue-sync/revision-1.json"), "utf8");
    expect(approve.stdout).toContain(preview);
    const jsonStatus = await runBuiltCli(projectRoot, ["status", runId, "--repo", repoRoot, "--json"]);
    expect((JSON.parse(jsonStatus.stdout) as { effect_boundary: { rendered_preview: string } }).effect_boundary.rendered_preview).toBe(preview);

    const approvedIdentity = {
      task_lineage_id: manifest.task_lineage_id,
      branch_name: manifest.branch_name,
    };
    const issueApply = await runBuiltCli(projectRoot, ["resume", runId, "--repo", repoRoot, "--dry-run", "--json"]);
    expect(issueApply.stdout).toContain("awaiting_github_effects");
    const afterIssueApply = JSON.parse(await readFile(join(runDir, "manifest.json"), "utf8")) as {
      stage: string;
      task_lineage_id: string;
      branch_name: string;
      work_item_issue_map: Record<string, number>;
      github_ids: { issue_numbers: number[]; pull_request_numbers: number[]; pull_request_urls: Record<string, string> };
    };
    expect(afterIssueApply).toMatchObject({
      stage: "awaiting_github_delivery_effects",
      task_lineage_id: approvedIdentity.task_lineage_id,
      branch_name: approvedIdentity.branch_name,
    });
    expect(afterIssueApply.work_item_issue_map).toEqual({ [plan.work_items[0]!.id]: 1 });
    expect(afterIssueApply.github_ids.issue_numbers).toEqual([1]);
    const deliveryPreview = await readFile(join(runDir, "github-effects/pull-request-delivery/revision-1.json"), "utf8");
    const deliveryStatus = JSON.parse((await runBuiltCli(projectRoot, ["status", runId, "--repo", repoRoot, "--json"])).stdout) as {
      effect_boundary: { rendered_preview: string };
    };
    expect(deliveryStatus.effect_boundary.rendered_preview).toBe(deliveryPreview);

    const deliveryApply = await runBuiltCli(projectRoot, ["resume", runId, "--repo", repoRoot, "--dry-run", "--json"]);
    expect(deliveryApply.stdout).toContain("github_ready");
    const delivered = JSON.parse(await readFile(join(runDir, "manifest.json"), "utf8")) as {
      stage: string;
      delivery_state: string;
      last_blocker: string | null;
      task_lineage_id: string;
      branch_name: string;
      work_item_issue_map: Record<string, number>;
      remote_synchronization_path: string | null;
      github_ids: { issue_numbers: number[]; pull_request_numbers: number[]; pull_request_urls: Record<string, string> };
    };
    expect(delivered).toMatchObject({
      stage: "delivery",
      delivery_state: "ready",
      last_blocker: null,
      task_lineage_id: approvedIdentity.task_lineage_id,
      branch_name: approvedIdentity.branch_name,
      work_item_issue_map: afterIssueApply.work_item_issue_map,
    });
    expect(delivered.github_ids).toMatchObject({
      issue_numbers: afterIssueApply.github_ids.issue_numbers,
      pull_request_numbers: [1],
      pull_request_urls: { "1": "https://github.com/dry-run/repo/pull/1" },
    });
    expect(delivered.remote_synchronization_path).toMatch(/^assurance\/remote-synchronization-[0-9a-f]{64}\.json$/);
    const synchronization = JSON.parse(await readFile(join(runDir, delivered.remote_synchronization_path!), "utf8"));
    const worktreeHead = (await execa("git", ["rev-parse", "HEAD"], { cwd: join(repoRoot, ".brain-hands", "worktrees", runId) })).stdout.trim();
    expect(synchronization).toMatchObject({
      synchronized: true,
      local_candidate_sha: worktreeHead,
      mapped_pr_sha: worktreeHead,
      remote_head_sha: worktreeHead,
      problems: [],
    });
    await access(join(runDir, "github-map.json"), constants.F_OK);
    await expect(access(join(runDir, "github-issue-sync.json"), constants.F_OK)).rejects.toMatchObject({ code: "ENOENT" });

    const runFiles = await readRunTextFiles(runDir);
    const githubProjectionPaths = Object.keys(runFiles).filter((path) =>
      path.startsWith("github-")
      || path === "manifest.json"
      || path === "events.jsonl"
      || path === "progress.jsonl");
    expect(githubProjectionPaths).toEqual(expect.arrayContaining([
      "github-effects/issue-sync/revision-1.json",
      "github-effects/pull-request-delivery/revision-1.json",
      "github-map.json",
      "manifest.json",
      "events.jsonl",
      "progress.jsonl",
    ]));
    const finalStatus = await runBuiltCli(projectRoot, ["status", runId, "--repo", repoRoot]);
    const githubStatusComment = formatRunStatusComment(await readOperatorStatus(runDir));
    const issueBody = formatIssueBody(plan.work_items[0]!, { runId, workItemId: plan.work_items[0]!.id });
    const projectionCorpus = [
      ...githubProjectionPaths.map((path) => runFiles[path]),
      approve.stdout,
      issueApply.stdout,
      deliveryApply.stdout,
      finalStatus.stdout,
      githubStatusComment.body,
      issueBody,
    ].join("\n");
    const privateDiscoveryContent = [
      privateAnswer,
      initialPending.question.text,
      ...initialPending.question.choices.flatMap((choice) => [choice.label, choice.description]),
      initialPending.question.rationale,
      ...approaches.approaches.flatMap((approach) => [
        approach.title,
        approach.summary,
        ...approach.tradeoffs,
        approach.recommendation_rationale,
      ]),
      brief.goal,
      brief.problem,
      ...brief.success_criteria,
      ...brief.constraints,
      brief.selected_approach_rationale,
      ...brief.out_of_scope,
    ].filter((content): content is string => content !== null);
    for (const content of privateDiscoveryContent) {
      expect(projectionCorpus).not.toContain(content);
    }

    const deliveredManifestBytes = await readFile(join(runDir, "manifest.json"), "utf8");
    const idempotentResume = await runBuiltCli(projectRoot, ["resume", runId, "--repo", repoRoot, "--dry-run", "--json"]);
    expect(idempotentResume.stdout).toContain("github_ready");
    expect(await readFile(join(runDir, "manifest.json"), "utf8")).toBe(deliveredManifestBytes);
  }, 120_000);
});
