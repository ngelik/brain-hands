import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { approvePlanRevision, createRunLedger, createRunLedgerV2, readManifestV2, recordPlan, transitionRun, updateManifest, updateManifestV2, writeTextArtifact } from "../../src/core/ledger.js";
import { approveDiscoveryBrief, recordDiscoveryBrief, recordDiscoveryReadiness } from "../../src/core/discovery-ledger.js";
import type { BrainPlan, IssueSpec, VerificationEvidence } from "../../src/core/types.js";
import { createReviewPackage } from "../../src/workflow/review-package.js";
import { executionSpec } from "../fixtures/execution-spec.js";
import { createLegacyRunLedgerV2 } from "../fixtures/legacy-run.js";
import { defaultConfig } from "../../src/core/config.js";
import { resolveRunIntake } from "../../src/core/intake.js";
import { resolveRunConfiguration, serializeRunConfiguration } from "../../src/core/run-configuration.js";
import { recordAndApprovePinnedInitialPlan } from "../fixtures/pinned-plan.js";

let repoRoot: string | null = null;

afterEach(async () => {
  if (repoRoot) {
    await rm(repoRoot, { recursive: true, force: true });
    repoRoot = null;
  }
});

function createIssueSpec(): IssueSpec {
  return {
    type: "implementation_task",
    run_id: "2026-07-08T12-00-00-000Z-solar-system",
    parent_request: "Build a solar system browser app",
    goal: "Add an interactive solar system browser with spacecraft focus",
    context: "The reviewer needs to confirm the rendered browser app matches the requested workflow.",
    scope: {
      include: ["solar-system-browser/", "reports/"],
      exclude: ["GitHub automation changes"],
    },
    dependencies: [],
    implementation_steps: [
      "Render the 3D scene.",
      "Add a spacecraft focus control.",
      "Capture browser evidence.",
    ],
    acceptance_criteria: [
      "App renders a nonblank 3D scene.",
      "Spacecraft focus interaction updates the focused body.",
      "No remote runtime assets are loaded.",
    ],
    verification: {
      required_commands: [
        "npm test -- tests/solar.test.ts",
        "node solar-system-browser/scripts/verify.mjs",
      ],
      manual_checks: ["Open desktop and mobile screenshots."],
      expected_artifacts: ["reports/browser-evidence.json", "reports/desktop.png"],
    },
    review_checklist: [
      "All acceptance criteria are backed by evidence.",
      "The diff stays inside the requested scope.",
    ],
    risk_register: ["Browser evidence can become stale if the app changes after capture."],
    handoff_prompt: "Implement the browser app and capture verification evidence.",
    browser_checks: [
      {
        name: "spacecraft focus smoke",
        url: "http://127.0.0.1:5177/solar-system-browser/index.html",
        local_server_command: "node solar-system-browser/scripts/serve.mjs",
        required_selectors: ["#spaceCanvas", "#focusedBodyName"],
        console_error_policy: "no_errors",
        expected_network: ["/solar-system-browser/index.html"],
        screenshot_artifact: "reports/desktop.png",
        viewport: {
          width: 1440,
          height: 900,
          mobile: false,
        },
        wait_ms: 250,
        require_no_horizontal_overflow: true,
      },
    ],
  };
}

function createEvidence(): VerificationEvidence {
  return {
    verification_scope: "github",
    work_item_id: "app",
    issue_number: 1,
    attempt: 1,
    evidence_path: "verification/issue-1/attempt-1/evidence.json",
    commands: [
      {
        command: "npm test -- tests/solar.test.ts",
        exit_code: 0,
        timed_out: false,
        error_code: null,
        error_message: null,
        signal: null,
        stdout_path: "verification/issue-1/command-1.stdout.txt",
        stderr_path: "verification/issue-1/command-1.stderr.txt",
      },
      {
        command: "node solar-system-browser/scripts/verify.mjs",
        exit_code: 0,
        timed_out: false,
        error_code: null,
        error_message: null,
        signal: null,
        stdout_path: "verification/issue-1/command-2.stdout.txt",
        stderr_path: "verification/issue-1/command-2.stderr.txt",
      },
    ],
    artifacts: ["reports/browser-evidence.json", "reports/desktop.png"],
    artifact_checks: [
      {
        path: "reports/browser-evidence.json",
        exists: true,
        required: true,
      },
      {
        path: "reports/desktop.png",
        exists: true,
        required: true,
      },
    ],
    browser_evidence: [
      {
        name: "spacecraft focus smoke",
        url: "http://127.0.0.1:5177/solar-system-browser/index.html",
        status: "passed",
        screenshot_artifact: "reports/desktop.png",
        screenshot_exists: true,
        expected_network: ["/solar-system-browser/index.html"],
        observed_network: ["/solar-system-browser/index.html"],
        missing_network: [],
        console_errors: [],
        missing_selectors: [],
        failure_reasons: [],
        evidence_report_path: "reports/browser-evidence.json",
        skipped_reason: null,
      },
    ],
    created_at: "2026-07-08T12:30:00.000Z",
  };
}

async function expectFile(path: string): Promise<void> {
  await expect(access(path)).resolves.toBeUndefined();
}

async function seedReviewRun(): Promise<{ runDir: string; outDir: string }> {
  repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-review-package-"));
  execFileSync("git", ["init"], { cwd: repoRoot });
  execFileSync("git", ["config", "user.name", "Codex Test"], { cwd: repoRoot });
  execFileSync("git", ["config", "user.email", "codex@example.com"], { cwd: repoRoot });

  await writeFile(join(repoRoot, "app.ts"), "export const state = 'initial';\n", "utf8");
  execFileSync("git", ["add", "app.ts"], { cwd: repoRoot });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: repoRoot });
  await writeFile(join(repoRoot, "app.ts"), "export const state = 'implemented feature';\n", "utf8");
  await writeFile(join(repoRoot, "new-panel.ts"), "export const panel = 'untracked review surface';\n", "utf8");

  const ledger = await createRunLedger({
    repoRoot,
    originalRequest: "Build a solar system browser app",
    slug: "solar-system",
    now: new Date("2026-07-08T12:00:00.000Z"),
  });
  const issue = createIssueSpec();
  const evidence = createEvidence();

  await mkdir(join(repoRoot, "reports"), { recursive: true });
  await writeFile(join(repoRoot, "reports", "desktop.png"), "fake image bytes\n", "utf8");
  await writeFile(
    join(repoRoot, "reports", "browser-evidence.json"),
    `${JSON.stringify({
      generated_at: "2026-07-08T12:29:00.000Z",
      status: "passed",
      reports: [
        {
          check_name: "spacecraft focus smoke",
          url: "http://127.0.0.1:5177/solar-system-browser/index.html",
          status: "passed",
          observed_selectors: ["#spaceCanvas", "#focusedBodyName"],
          missing_selectors: [],
          console_errors: [],
          expected_network: ["/solar-system-browser/index.html"],
          observed_network: ["/solar-system-browser/index.html"],
          screenshot_artifact: "reports/desktop.png",
          console_error_policy: "no_errors",
        },
      ],
    }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(join(ledger.runDir, "issues.json"), `${JSON.stringify([issue], null, 2)}\n`, "utf8");
  await writeFile(
    join(ledger.runDir, "implementation-issue-1.md"),
    "Implemented the 3D browser scene and spacecraft focus control.\n",
    "utf8",
  );
  await mkdir(join(ledger.runDir, "verification", "issue-1"), { recursive: true });
  await writeFile(
    join(ledger.runDir, "verification", "issue-1", "evidence.json"),
    `${JSON.stringify(evidence, null, 2)}\n`,
    "utf8",
  );
  await updateManifest(ledger.runDir, {
    stage: "local_verification",
    current_issue: 1,
    issue_numbers: [1],
  });

  return {
    runDir: ledger.runDir,
    outDir: join(ledger.runDir, "review-packages", "issue-1"),
  };
}

describe("createReviewPackage", () => {
  it("rejects a tampered approved brief before creating review-package output", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-review-tamper-"));
    const config = defaultConfig();
    const intake = resolveRunIntake({
      task: "Bind package", repo_root: repoRoot, mode: "local", research: false, reflection: false,
    }, config);
    const controller = {
      self_hosting: false,
      mode: "development_checkout" as const,
      executable_path: "/test/brain-hands",
      package_root: "/test/package",
      package_name: "@ngelik/brain-hands",
      package_version: "0.4.0",
      package_hash_algorithm: "sha256" as const,
      package_hash: "a".repeat(64),
      candidate_commit: "b".repeat(40),
    };
    const runConfiguration = resolveRunConfiguration({ intake, config, controller, overrides: {} });
    const ledger = await createRunLedgerV2({
      repoRoot, originalRequest: intake.task, intake, roles: intake.roles,
      sourceCommit: controller.candidate_commit, controllerProvenance: controller,
    });
    await writeFile(join(ledger.runDir, "run-configuration.json"), serializeRunConfiguration(runConfiguration));
    await transitionRun(ledger.runDir, "preflight"); await transitionRun(ledger.runDir, "brain_discovery");
    const brief = { revision: 1, goal: "Bind package", problem: "Tamper risk", constraints: [], decisions: [], assumptions: [], repository_evidence: ["src/workflow/review-package.ts"], success_criteria: ["Reject tamper"], accepted_risks: [], out_of_scope: [], selected_approach_id: null, selected_approach_rationale: null };
    await recordDiscoveryReadiness(ledger.runDir, { outcome: "no_discovery_needed", rationale: "Fixture ready.", repository_evidence: ["tests/workflow/review-package.test.ts"], approaches: [], alternatives_omitted_reason: "No alternative.", brief });
    await recordDiscoveryBrief(ledger.runDir, brief); await approveDiscoveryBrief(ledger.runDir, 1);
    const digest = (await readManifestV2(ledger.runDir)).discovery!.approved_brief_sha256!;
    const plan = { summary: "Bind", assumptions: [], research: [], research_sources: [], architecture: "local", risks: [], work_items: [executionSpec("app")], integration_verification: [["true"]], discovery_brief_revision: 1, discovery_brief_sha256: digest, discovery_decision_coverage: [], accepted_risks: [], out_of_scope: [] };
    await recordAndApprovePinnedInitialPlan(
      ledger.runDir,
      plan,
      async () => ({ provenance: controller, selfHosting: false }),
    );
    await writeFile(join(ledger.runDir, "discovery/approved-brief.json"), `${JSON.stringify({ ...brief, goal: "TAMPERED" }, null, 2)}\n`);
    const outDir = join(repoRoot, "review-output");
    await expect(createReviewPackage({ repoRoot, runDir: ledger.runDir, workItemId: "app", outDir }))
      .rejects.toThrow(/discovery brief.*digest/i);
    await expect(access(outDir)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("creates a local review package with issue, diff, evidence, screenshots, review, and prompt files", async () => {
    const { runDir, outDir } = await seedReviewRun();

    const result = await createReviewPackage({
      repoRoot: repoRoot!,
      runDir,
      issueNumber: 1,
      outDir,
    });

    expect(result.packageDir).toBe(outDir);
    expect(result.reviewPath).toBe(join(outDir, "review.md"));
    expect(result.promptPath).toBe(join(outDir, "prompt.md"));
    expect(result.copiedFiles).toEqual(
      expect.arrayContaining([
        join(outDir, "issue.json"),
        join(outDir, "implementation.md"),
        join(outDir, "verification", "evidence.json"),
        join(outDir, "browser-evidence.json"),
        join(outDir, "diff.patch"),
        join(outDir, "screenshots.txt"),
        join(outDir, "prompt.md"),
        join(outDir, "review.md"),
      ]),
    );

    await expectFile(join(outDir, "issue.json"));
    await expectFile(join(outDir, "implementation.md"));
    await expectFile(join(outDir, "verification", "evidence.json"));
    await expectFile(join(outDir, "browser-evidence.json"));
    await expectFile(join(outDir, "diff.patch"));
    await expectFile(join(outDir, "screenshots.txt"));
    await expectFile(join(outDir, "prompt.md"));
    await expectFile(join(outDir, "review.md"));

    const review = await readFile(join(outDir, "review.md"), "utf8");
    expect(review).toContain("# Local Review Package: Issue #1");
    expect(review).toContain("## Original Request");
    expect(review).toContain("Build a solar system browser app");
    expect(review).toContain("## Issue Goal");
    expect(review).toContain("Add an interactive solar system browser with spacecraft focus");
    expect(review).toContain("## Acceptance Criteria");
    expect(review).toContain("App renders a nonblank 3D scene.");
    expect(review).toContain("## Changed Files");
    expect(review).toContain("- app.ts");
    expect(review).toContain("- new-panel.ts");
    expect(review).toContain("## Test Commands And Results");
    expect(review).toContain("`npm test -- tests/solar.test.ts` -> exit 0");
    expect(review).toContain("## Browser Evidence Summary");
    expect(review).toContain("- spacecraft focus smoke: passed");
    expect(review).toContain("## Open Risks");
    expect(review).toContain("Browser evidence can become stale if the app changes after capture.");
    expect(review).toContain("## Review Checklist");
    expect(review).toContain("All acceptance criteria are backed by evidence.");

    const diff = await readFile(join(outDir, "diff.patch"), "utf8");
    expect(diff).toContain("app.ts");
    expect(diff).toContain("implemented feature");
    expect(diff).toContain("new-panel.ts");
    expect(diff).toContain("untracked review surface");

    const screenshots = await readFile(join(outDir, "screenshots.txt"), "utf8");
    expect(screenshots).toContain("reports/desktop.png");
    expect(screenshots).toContain("exists");

    const prompt = await readFile(join(outDir, "prompt.md"), "utf8");
    expect(prompt).toContain("review.md");
    expect(prompt).toContain("diff.patch");
    expect(prompt).toContain("approve");
    expect(prompt).toContain("request_changes");
    expect(prompt).toContain("replan_required");
  });

  it("builds a read-only package from an approved v2 plan ledger", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-review-package-v2-"));
    execFileSync("git", ["init"], { cwd: repoRoot });
    execFileSync("git", ["config", "user.name", "Codex Test"], { cwd: repoRoot });
    execFileSync("git", ["config", "user.email", "codex@example.com"], { cwd: repoRoot });
    await writeFile(join(repoRoot, "app.ts"), "export const state = 'clean';\n", "utf8");
    execFileSync("git", ["add", "app.ts"], { cwd: repoRoot });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: repoRoot });

    const ledger = await createLegacyRunLedgerV2({ repoRoot, originalRequest: "Build the v2 app", slug: "v2-package" });
    const plan: BrainPlan = {
      summary: "Build the v2 app",
      assumptions: [],
      research: [],
      research_sources: [],
      architecture: "local",
      risks: [],
      work_items: [{
        ...executionSpec("app"),
        title: "Build app",
        objective: "Build the app",
        file_contract: [{ path: "app.ts", permission: "modify", targets: ["app implementation"] }],
        change_units: [{ id: "app-CH-01", path: "app.ts", target: "app implementation", operation: "modify", requirements: ["Implement the app behavior."] }],
        acceptance: [{ id: "app-AC-01", statement: "The app works.", satisfied_by: ["app-CH-01", "app-VERIFY-01"] }],
        tests: [],
        verification_commands: [{ id: "app-VERIFY-01", argv: ["true"], expected_exit_code: 0 }],
        completion_contract: { expected_changed_files: ["app.ts"], allow_additional_files: false, required_acceptance_ids: ["app-AC-01"] },
      }],
      integration_verification: [["true"]],
    };
    await recordPlan(ledger.runDir, JSON.stringify(plan));
    await approvePlanRevision(ledger.runDir, 1);
    await writeTextArtifact(ledger.runDir, "implementation/app/attempt-1.json", `${JSON.stringify({
      work_item_id: "app", changed_files: ["app.ts"], tests_added_or_changed: [], commands_attempted: [], completed_steps: ["implemented"], remaining_risks: [],
    })}\n`);
    const { issue_number: _legacyIssueNumber, ...localEvidence } = createEvidence();
    const localPrefix = "verification/local/YXBw/attempt-1";
    await writeTextArtifact(ledger.runDir, `${localPrefix}/evidence.json`, `${JSON.stringify({
      ...localEvidence,
      verification_scope: "local",
      work_item_id: "app",
      evidence_path: `${localPrefix}/evidence.json`,
      commands: localEvidence.commands.map((command) => ({
        ...command,
        stdout_path: command.stdout_path.replace(/^verification\/issue-1\//, `${localPrefix}/`),
        stderr_path: command.stderr_path.replace(/^verification\/issue-1\//, `${localPrefix}/`),
      })),
      browser_evidence: localEvidence.browser_evidence.map((browser) => ({
        ...browser,
        screenshot_artifact: `${localPrefix}/reports/desktop.png`,
        evidence_report_path: `${localPrefix}/reports/browser-evidence.json`,
      })),
    })}\n`);
    await updateManifestV2(ledger.runDir, {
      work_item_progress: { app: { status: "complete", attempts: 1, implementation_path: "implementation/app/attempt-1.json", verification_path: "verification/local/YXBw/attempt-1/evidence.json" } },
    });

    const outDir = join(ledger.runDir, "review-packages", "app");
    const result = await createReviewPackage({ repoRoot, runDir: ledger.runDir, workItemId: "app", outDir });

    expect(result.packageDir).toBe(outDir);
    expect(await readFile(join(outDir, "issue.json"), "utf8")).toContain('"schema_version": "2.0"');
    expect(await readFile(join(outDir, "issue.json"), "utf8")).toContain('"title": "Build app"');
    expect(await readFile(join(outDir, "implementation.md"), "utf8")).toContain("implemented");
    expect(await readFile(join(outDir, "review.md"), "utf8")).toContain("Build the v2 app");
    expect((await readManifestV2(ledger.runDir)).stage).toBe("intake");
  });
});
