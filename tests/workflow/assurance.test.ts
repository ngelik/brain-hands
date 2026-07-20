import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { approvePlanRevision, createRunLedgerV2, readManifestV2, recordPlan, transitionRun, updateManifestV2, writeImmutableValidatedJson, writeTextArtifact } from "../../src/core/ledger.js";
import { implementationResultSchema, persistedVerifierReviewSchema, verificationEvidenceSchema, verificationExecutionResultSchema } from "../../src/core/schema.js";
import { approveDiscoveryBrief, recordDiscoveryBrief, recordDiscoveryReadiness } from "../../src/core/discovery-ledger.js";
import { abandonRun, acceptFinalDeliveryRisk, assessFinalDelivery, assertNotAbandoned, persistFinalDeliveryAssessmentAtBoundary } from "../../src/workflow/assurance.js";
import { replaceAbandonedRun } from "../../src/workflow/replacement.js";
import { executionSpec } from "../fixtures/execution-spec.js";
import { defaultConfig, resolveReviewPolicy } from "../../src/core/config.js";
import { recordRemoteSynchronization } from "../../src/workflow/remote-synchronization.js";
import { buildVerifierEvidenceIndex, loadEvidenceIndex } from "../../src/workflow/evidence-index.js";
import { artifactRefFromBytes } from "../../src/core/context-contracts.js";
import { persistWorkItemSummary } from "../../src/workflow/work-item-summaries.js";
import { recordFindingRevision } from "../../src/workflow/findings.js";
import { createLegacyRunLedgerV2, rewriteLegacyCheckoutSnapshot } from "../fixtures/legacy-run.js";
import { resolveRunIntake } from "../../src/core/intake.js";
import { resolveRunConfiguration, serializeRunConfiguration } from "../../src/core/run-configuration.js";
import { recordAndApprovePinnedInitialPlan } from "../fixtures/pinned-plan.js";

function assurancePlan(ids: string[]): string {
  return `${JSON.stringify({
    summary: "Assurance plan", assumptions: [], research: [], research_sources: [], architecture: "Assurance",
    risks: [], work_items: ids.map((id) => ({ ...executionSpec(id), id })), integration_verification: [["true"]],
  })}\n`;
}

const exec = promisify(execFile);

async function gitRepo(): Promise<{ root: string; worktree: string }> {
  const root = await mkdtemp(join(tmpdir(), "brain-hands-assurance-repo-"));
  const worktree = join(root, "worktree");
  await mkdir(worktree);
  await exec("git", ["init", "-q"], { cwd: worktree });
  await exec("git", ["config", "user.email", "assurance@example.test"], { cwd: worktree });
  await exec("git", ["config", "user.name", "Assurance Test"], { cwd: worktree });
  await writeFile(join(worktree, "README.md"), "candidate\n");
  await exec("git", ["add", "README.md"], { cwd: worktree });
  await exec("git", ["commit", "-qm", "candidate"], { cwd: worktree });
  return { root, worktree };
}

const TEST_SHA = "a".repeat(40);

async function githubAssuranceRun(): Promise<{ runDir: string; worktree: string; head: string; syncPath: string }> {
  const repo = await gitRepo();
  const head = (await exec("git", ["rev-parse", "HEAD"], { cwd: repo.worktree })).stdout.trim();
  const config = defaultConfig();
  const intake = resolveRunIntake({
    task: "Prove GitHub delivery",
    repo_root: repo.root,
    mode: "github",
    research: false,
    reflection: false,
  }, config);
  const controllerProvenance = {
    self_hosting: false,
    mode: "development_checkout" as const,
    executable_path: "/test/brain-hands",
    package_root: "/test/package",
    package_name: "@ngelik/brain-hands",
    package_version: "0.4.0",
    package_hash_algorithm: "sha256" as const,
    package_hash: "a".repeat(64),
    candidate_commit: head,
  };
  const runConfiguration = resolveRunConfiguration({ intake, config, controller: controllerProvenance, overrides: {} });
  const ledger = await createRunLedgerV2({
    repoRoot: repo.root,
    originalRequest: intake.task,
    mode: "github",
    intake,
    roles: intake.roles,
    sourceCommit: head,
    worktreePath: repo.worktree,
    branchName: "candidate",
    controllerProvenance,
  });
  await writeFile(join(ledger.runDir, "run-configuration.json"), serializeRunConfiguration(runConfiguration));
  await transitionRun(ledger.runDir, "preflight");
  await transitionRun(ledger.runDir, "brain_discovery");
  const approvedPlan = JSON.parse(assurancePlan(["feature"]));
  const revision = await recordAndApprovePinnedInitialPlan(
    ledger.runDir,
    approvedPlan,
    async () => ({ provenance: controllerProvenance, selfHosting: false }),
  );
  const workItem = approvedPlan.work_items[0]!;
  const implementationRef = await writeImmutableValidatedJson(
    ledger.runDir,
    "implementation/feature/attempt-1.json",
    implementationResultSchema,
    { work_item_id: workItem.id, changed_files: ["src/feature.ts"], tests_added_or_changed: [], commands_attempted: [], completed_steps: ["feature"], remaining_risks: [] },
  );
  const itemResultPath = "verification/local/feature/attempt-1/command-1.json";
  await writeTextArtifact(ledger.runDir, "verification/local/feature/attempt-1/command-1.stdout.txt", "passed\n");
  await writeTextArtifact(ledger.runDir, "verification/local/feature/attempt-1/command-1.stderr.txt", "");
  await writeImmutableValidatedJson(ledger.runDir, itemResultPath, verificationExecutionResultSchema, {
    argv: workItem.verification_commands[0]!.argv,
    stdout: "passed\n", stderr: "", exit_code: 0, duration_ms: 1, timed_out: false,
    error_code: null, error_message: null, signal: null,
  });
  const itemEvidencePath = "verification/local/feature/attempt-1/evidence.json";
  const itemEvidenceRef = await writeImmutableValidatedJson(ledger.runDir, itemEvidencePath, verificationEvidenceSchema, {
    verification_scope: "local", work_item_id: workItem.id, attempt: 1, evidence_path: itemEvidencePath,
    commands: [{
      command: workItem.verification_commands[0]!.argv.join(" "), argv: workItem.verification_commands[0]!.argv,
      exit_code: 0, timed_out: false, error_code: null, error_message: null, signal: null,
      stdout_path: "verification/local/feature/attempt-1/command-1.stdout.txt",
      stderr_path: "verification/local/feature/attempt-1/command-1.stderr.txt", result_path: itemResultPath,
    }],
    artifacts: [], artifact_checks: [], browser_evidence: [], created_at: new Date().toISOString(),
  });
  const itemReviewRef = await writeImmutableValidatedJson(
    ledger.runDir,
    "reviews/feature/attempt-1.json",
    persistedVerifierReviewSchema,
    {
      work_item_id: workItem.id, attempt: 1, final: false, decision: "approve", failure_class: "none",
      blocker: null, blocker_code: null, acceptance_coverage: workItem.completion_contract.required_acceptance_ids,
      evidence_reviewed: [itemEvidencePath], findings: [], residual_risks: [],
    },
  );
  await updateManifestV2(ledger.runDir, {
    work_item_progress: {
      feature: {
        status: "in_progress", attempts: 1, context_base_commit: head, context_plan_revision: revision.revision,
        implementation_path: implementationRef.path, verification_path: itemEvidenceRef.path,
        review_path: itemReviewRef.path, review_revision: 1, commit_sha: head,
      },
    },
  });
  const summaryRef = await persistWorkItemSummary({
    runDir: ledger.runDir, workItem, planRevision: revision.revision, planSha256: revision.sha256,
    attempt: 1, baseCommit: head, commitSha: head, completionBasis: "verifier_approve",
    implementationRef, verificationRef: itemEvidenceRef, reviewRef: itemReviewRef, policyDecisionRef: null,
    findingRevision: { reviewRevision: 1, findingIds: [] }, createdAt: new Date().toISOString(),
  });
  const evidencePath = "verification/integrated/attempt-1/evidence.json";
  const reviewPath = "reviews/integrated/final-attempt-1.json";
  const resultPath = "verification/integrated/attempt-1/command-1.json";
  await mkdir(join(ledger.runDir, "verification/integrated/attempt-1"), { recursive: true });
  await mkdir(join(ledger.runDir, "reviews/integrated"), { recursive: true });
  await writeTextArtifact(ledger.runDir, "verification/integrated/attempt-1/command-1.stdout.txt", "");
  await writeTextArtifact(ledger.runDir, "verification/integrated/attempt-1/command-1.stderr.txt", "");
  await writeTextArtifact(ledger.runDir, resultPath, `${JSON.stringify({ argv: ["true"], stdout: "", stderr: "", exit_code: 0, duration_ms: 1, timed_out: false, error_code: null, error_message: null, signal: null })}\n`);
  await writeTextArtifact(ledger.runDir, evidencePath, `${JSON.stringify({
    verification_scope: "integrated", work_item_id: "integrated", attempt: 1, evidence_path: evidencePath,
    commands: [{ command: "true", argv: ["true"], exit_code: 0, timed_out: false, error_code: null, error_message: null, signal: null, stdout_path: "verification/integrated/attempt-1/command-1.stdout.txt", stderr_path: "verification/integrated/attempt-1/command-1.stderr.txt", result_path: resultPath, duration_ms: 1 }],
    artifacts: [], artifact_checks: [], browser_evidence: [], created_at: new Date().toISOString(),
  })}\n`);
  await writeTextArtifact(ledger.runDir, reviewPath, `${JSON.stringify({ work_item_id: "integrated", attempt: 1, final: true, decision: "approve", acceptance_coverage: [], evidence_reviewed: [evidencePath], findings: [], residual_risks: [] })}\n`);
  let manifest = await readManifestV2(ledger.runDir);
  await updateManifestV2(ledger.runDir, {
    current_revision: revision.revision, current_plan_revision: revision.revision,
    approved_revision: revision.revision, approved_plan_revision: revision.revision,
    mode: "github", run_mode: "github", delivery_state: "ready",
    pull_request_numbers: [42],
    github_ids: { issue_numbers: [], pull_request_numbers: [42], pull_request_urls: { "42": "https://github.test/org/repo/pull/42/" } },
    final_artifact_paths: [evidencePath, reviewPath],
    work_item_progress: {
      ...manifest.work_item_progress,
      feature: { ...manifest.work_item_progress.feature!, status: "complete", summary_path: summaryRef.path, summary_sha256: summaryRef.sha256 },
      integrated: { status: "in_progress", attempts: 1, commit_sha: head, verification_path: evidencePath, review_path: reviewPath, github_status_transition_at: "2026-07-16T12:00:00.000Z" },
    },
  });
  const integratedRef = artifactRefFromBytes(evidencePath, await readFile(join(ledger.runDir, evidencePath)));
  const indexRef = await buildVerifierEvidenceIndex({
    runDir: ledger.runDir,
    phase: "final_integrated",
    attempt: 1,
    candidateCommit: head,
    workItemSummaryRefs: [summaryRef],
    integratedVerificationRef: integratedRef,
  });
  manifest = await readManifestV2(ledger.runDir);
  await updateManifestV2(ledger.runDir, {
    stage: "delivery",
    final_verifier_index_path: indexRef.path,
    final_verifier_index_sha256: indexRef.sha256,
    final_artifact_paths: [evidencePath, reviewPath, indexRef.path],
    work_item_progress: {
      ...manifest.work_item_progress,
      integrated: { ...manifest.work_item_progress.integrated!, status: "complete" },
    },
  });
  const syncPath = "assurance/remote-synchronization-proof.json";
  return { runDir: ledger.runDir, worktree: repo.worktree, head, syncPath };
}

async function writeSynchronizationEvidence(input: Awaited<ReturnType<typeof githubAssuranceRun>>, patch: Record<string, unknown> = {}): Promise<void> {
  const manifest = await readManifestV2(input.runDir);
  if (manifest.branch_name === null) throw new Error("Assurance fixture requires a pinned branch");
  const value = {
    version: 1, run_id: manifest.run_id, branch_name: manifest.branch_name,
    remote_name: "origin", pull_request_number: 42,
    pull_request_url: "https://github.test/org/repo/pull/42", local_candidate_sha: input.head,
    mapped_pr_sha: input.head, remote_head_sha: input.head, problems: [], synchronized: true,
    observed_at: "2026-07-16T12:00:01.000Z", ...patch,
  };
  await mkdir(join(input.runDir, "assurance"), { recursive: true });
  await writeFile(join(input.runDir, input.syncPath), `${JSON.stringify(value, null, 2)}\n`);
  await updateManifestV2(input.runDir, { remote_synchronization_path: input.syncPath });
}

async function writeRunConfiguration(runDir: string, remoteName: string): Promise<void> {
  const config = defaultConfig();
  await writeFile(join(runDir, "run-configuration.json"), `${JSON.stringify({
    version: 1,
    repository: runDir,
    mode: "github",
    research: false,
    reflection: false,
    controller: { package_name: "@ngelik/brain-hands", package_version: "0.4.0", mode: "development_checkout" },
    roles: Object.fromEntries(Object.entries(config.profiles).map(([name, profile]) => [name, { ...profile, source: "repository_config" }])),
    hands_backup: config.retry_policy.backup ?? null,
    limits: {
      max_hands_fix_attempts: config.retry_policy.max_hands_fix_attempts,
      max_replan_attempts: config.retry_policy.max_replan_attempts,
      review_policy: resolveReviewPolicy(config.retry_policy.max_hands_fix_attempts, config.review_policy),
      quality_gate: config.retry_policy.quality_gate ?? null,
    },
    github: { effects: "issues_and_pull_request", default_remote: remoteName },
  }, null, 2)}\n`);
}

describe("terminal assurance", () => {
  it("blocks a new-shape GitHub run with no durable synchronization pointer", async () => {
    const run = await githubAssuranceRun();
    let legacyCalls = 0;
    expect(await assessFinalDelivery(run.runDir, {
      candidateCommit: run.head,
      worktreeClean: true,
      legacyRemoteCandidate: {
        resolveRemoteSha: async () => { legacyCalls += 1; return run.head; },
        getPullRequest: async () => { legacyCalls += 1; return null; },
      },
    }))
      .toMatchObject({ outcome: "blocked", blocker_code: "missing_remote_synchronization" });
    expect(legacyCalls).toBe(0);
  });

  it("does not exempt an explicit dry-run pull request URL from durable synchronization", async () => {
    const run = await githubAssuranceRun();
    const manifest = await readManifestV2(run.runDir);
    await updateManifestV2(run.runDir, {
      github_ids: {
        ...manifest.github_ids,
        pull_request_urls: { "42": "https://github.com/dry-run/repo/pull/42" },
      },
    });
    expect(await assessFinalDelivery(run.runDir, { candidateCommit: run.head, worktreeClean: true }))
      .toMatchObject({ outcome: "blocked", blocker_code: "missing_remote_synchronization" });
  });

  it.each([
    ["missing artifact", async (run: Awaited<ReturnType<typeof githubAssuranceRun>>) => updateManifestV2(run.runDir, { remote_synchronization_path: run.syncPath })],
    ["corrupt JSON", async (run: Awaited<ReturnType<typeof githubAssuranceRun>>) => {
      await mkdir(join(run.runDir, "assurance"), { recursive: true });
      await writeFile(join(run.runDir, run.syncPath), "{not-json\n");
      await updateManifestV2(run.runDir, { remote_synchronization_path: run.syncPath });
    }],
    ["symlink", async (run: Awaited<ReturnType<typeof githubAssuranceRun>>) => {
      await mkdir(join(run.runDir, "assurance"), { recursive: true });
      await writeFile(join(run.runDir, "outside.json"), "{}\n");
      await symlink(join(run.runDir, "outside.json"), join(run.runDir, run.syncPath));
      await updateManifestV2(run.runDir, { remote_synchronization_path: run.syncPath });
    }],
  ])("blocks invalid remote synchronization evidence: %s", async (_name, arrange) => {
    const run = await githubAssuranceRun();
    await arrange(run);
    expect(await assessFinalDelivery(run.runDir, { candidateCommit: run.head, worktreeClean: true }))
      .toMatchObject({ outcome: "blocked", blocker_code: "invalid_remote_synchronization" });
  });

  it.each([
    ["run", { run_id: "other-run" }],
    ["branch", { branch_name: "other-branch" }],
    ["remote", { remote_name: "upstream" }],
    ["PR number", { pull_request_number: 43 }],
    ["PR URL", { pull_request_url: "https://github.test/org/repo/pull/43" }],
  ])("rejects synchronization evidence with mismatched %s provenance", async (_name, patch) => {
    const run = await githubAssuranceRun();
    await writeSynchronizationEvidence(run, patch);
    expect(await assessFinalDelivery(run.runDir, { candidateCommit: run.head, worktreeClean: true }))
      .toMatchObject({ outcome: "blocked", blocker_code: "invalid_remote_synchronization" });
  });

  it.each([
    ["one-sided", [42], []],
    ["divergent", [42], [43]],
    ["duplicated", [42, 42], [42]],
  ])("rejects a %s persisted pull request mapping before trusting durable evidence", async (_name, top, nested) => {
    const run = await githubAssuranceRun();
    const manifest = await readManifestV2(run.runDir);
    await updateManifestV2(run.runDir, {
      pull_request_numbers: top,
      github_ids: {
        ...manifest.github_ids,
        pull_request_numbers: nested,
        pull_request_urls: {
          ...manifest.github_ids.pull_request_urls,
          "43": "https://github.test/org/repo/pull/43",
        },
      },
    });
    await writeSynchronizationEvidence(run);
    expect(await assessFinalDelivery(run.runDir, { candidateCommit: run.head, worktreeClean: true }))
      .toMatchObject({ outcome: "blocked", blocker_code: "invalid_remote_synchronization" });
  });

  it.each([
    ["local candidate", { local_candidate_sha: TEST_SHA, mapped_pr_sha: TEST_SHA, remote_head_sha: TEST_SHA }],
    ["PR head", { mapped_pr_sha: TEST_SHA, problems: [{ source: "pull_request", code: "identity_mismatch" }], synchronized: false }],
    ["remote head", { remote_head_sha: TEST_SHA, problems: [{ source: "remote", code: "identity_mismatch" }], synchronized: false }],
    ["unsynchronized result", { mapped_pr_sha: null, problems: [{ source: "pull_request", code: "not_found" }], synchronized: false }],
  ])("blocks a remote candidate mismatch for %s", async (_name, patch) => {
    const run = await githubAssuranceRun();
    await writeSynchronizationEvidence(run, patch);
    expect(await assessFinalDelivery(run.runDir, { candidateCommit: run.head, worktreeClean: true }))
      .toMatchObject({ outcome: "blocked", blocker_code: "remote_candidate_mismatch", invalid_evidence: [run.syncPath] });
  });

  it("rejects synchronization evidence older than the durable integrated boundary", async () => {
    const run = await githubAssuranceRun();
    await writeSynchronizationEvidence(run, { observed_at: "2026-07-16T11:59:59.999Z" });
    expect(await assessFinalDelivery(run.runDir, { candidateCommit: run.head, worktreeClean: true }))
      .toMatchObject({ outcome: "blocked", blocker_code: "stale_remote_synchronization" });
  });

  it("blocks new-shape durable assurance when the integrated freshness boundary is missing", async () => {
    const run = await githubAssuranceRun();
    const manifestPath = join(run.runDir, "manifest.json");
    const raw = JSON.parse(await readFile(manifestPath, "utf8"));
    delete raw.work_item_progress.integrated.github_status_transition_at;
    await writeFile(manifestPath, `${JSON.stringify(raw, null, 2)}\n`);
    await writeSynchronizationEvidence(run);
    expect(await assessFinalDelivery(run.runDir, { candidateCommit: run.head, worktreeClean: true }))
      .toMatchObject({ outcome: "blocked", blocker_code: "invalid_remote_synchronization" });
  });

  it("accepts exact current durable synchronization evidence", async () => {
    const run = await githubAssuranceRun();
    await writeSynchronizationEvidence(run);
    expect(await assessFinalDelivery(run.runDir, { candidateCommit: run.head, worktreeClean: true }))
      .toMatchObject({ outcome: "verified_ready", blocker_code: null });
  });

  it("fails closed when a new-shape run has lost its frozen run configuration", async () => {
    const run = await githubAssuranceRun();
    await unlink(join(run.runDir, "run-configuration.json"));
    await writeSynchronizationEvidence(run);
    expect(await assessFinalDelivery(run.runDir, { candidateCommit: run.head, worktreeClean: true }))
      .toMatchObject({ outcome: "blocked", blocker_code: "invalid_remote_synchronization" });
  });

  it("binds durable evidence to the frozen non-origin remote", async () => {
    const run = await githubAssuranceRun();
    await writeRunConfiguration(run.runDir, "upstream");
    await writeSynchronizationEvidence(run);
    expect(await assessFinalDelivery(run.runDir, { candidateCommit: run.head, worktreeClean: true }))
      .toMatchObject({ outcome: "blocked", blocker_code: "invalid_remote_synchronization" });
  });

  it("rejects a self-consistent evidence URL when the persisted URL does not identify the mapped PR", async () => {
    const run = await githubAssuranceRun();
    const manifest = await readManifestV2(run.runDir);
    await updateManifestV2(run.runDir, {
      github_ids: { ...manifest.github_ids, pull_request_urls: { "42": "https://github.test/org/repo/pull/43" } },
    });
    await writeSynchronizationEvidence(run, { pull_request_url: "https://github.test/org/repo/pull/43" });
    expect(await assessFinalDelivery(run.runDir, { candidateCommit: run.head, worktreeClean: true }))
      .toMatchObject({ outcome: "blocked", blocker_code: "invalid_remote_synchronization" });
  });

  it("uses live three-source recovery only when the manifest truly omits the new field", async () => {
    const run = await githubAssuranceRun();
    const branchName = (await readManifestV2(run.runDir)).branch_name!;
    const manifestPath = join(run.runDir, "manifest.json");
    const raw = JSON.parse(await readFile(manifestPath, "utf8"));
    delete raw.remote_synchronization_path;
    await writeFile(manifestPath, `${JSON.stringify(raw, null, 2)}\n`);
    let calls = 0;
    const assessment = await assessFinalDelivery(run.runDir, {
      candidateCommit: run.head,
      worktreeClean: true,
      legacyRemoteCandidate: {
        resolveRemoteSha: async () => { calls += 1; return run.head; },
        getPullRequest: async () => { calls += 1; return { number: 42, url: "https://github.test/org/repo/pull/42", head_ref: branchName, head_sha: run.head, base_ref: "main", state: "OPEN" }; },
      },
    });
    expect(assessment.outcome).toBe("verified_ready");
    expect(calls).toBe(2);
    expect(await readManifestV2(run.runDir)).not.toHaveProperty("remote_synchronization_path");
  });

  it.each(["malformed", "symlink"])("ignores a %s frozen configuration during true legacy recovery", async (kind) => {
    const run = await githubAssuranceRun();
    const branchName = (await readManifestV2(run.runDir)).branch_name!;
    const manifestPath = join(run.runDir, "manifest.json");
    const raw = JSON.parse(await readFile(manifestPath, "utf8"));
    delete raw.remote_synchronization_path;
    await writeFile(manifestPath, `${JSON.stringify(raw, null, 2)}\n`);
    const configurationPath = join(run.runDir, "run-configuration.json");
    if (kind === "malformed") {
      await writeFile(configurationPath, "{}\n");
    } else {
      await unlink(configurationPath);
      const outside = join(run.runDir, "outside-configuration.json");
      await writeFile(outside, "{}\n");
      await symlink(outside, configurationPath);
    }
    expect(await assessFinalDelivery(run.runDir, {
      candidateCommit: run.head,
      worktreeClean: true,
      legacyRemoteCandidate: {
        resolveRemoteSha: async () => run.head,
        getPullRequest: async () => ({ number: 42, url: "https://github.test/org/repo/pull/42", head_ref: branchName, head_sha: run.head, base_ref: "main", state: "OPEN" }),
      },
    })).toMatchObject({ outcome: "verified_ready", blocker_code: null });
  });

  it.each([
    "/tmp/proof.json",
    "assurance/../proof.json",
    "  /tmp/proof.json  ",
    "\tassurance/../proof.json\n",
    "   ",
  ])("classifies an unsafe synchronization manifest path without reading it: %j", async (path) => {
    const run = await githubAssuranceRun();
    const manifestPath = join(run.runDir, "manifest.json");
    const raw = JSON.parse(await readFile(manifestPath, "utf8"));
    raw.remote_synchronization_path = path;
    await writeFile(manifestPath, `${JSON.stringify(raw, null, 2)}\n`);
    expect(await assessFinalDelivery(run.runDir, { candidateCommit: run.head, worktreeClean: true }))
      .toMatchObject({ outcome: "blocked", blocker_code: "invalid_remote_synchronization" });
  });

  it("does not let unsafe-pointer preclassification mask another invalid manifest field", async () => {
    const run = await githubAssuranceRun();
    const manifestPath = join(run.runDir, "manifest.json");
    const raw = JSON.parse(await readFile(manifestPath, "utf8"));
    raw.remote_synchronization_path = "/tmp/proof.json";
    raw.version = 99;
    await writeFile(manifestPath, `${JSON.stringify(raw, null, 2)}\n`);
    await expect(assessFinalDelivery(run.runDir)).rejects.toThrow();
  });

  it("reuses same-commit synchronization evidence after a repeated integrated completion", async () => {
    const run = await githubAssuranceRun();
    const manifest = await readManifestV2(run.runDir);
    const input = {
      runDir: run.runDir,
      repoRoot: manifest.repo_root,
      branchName: manifest.branch_name!,
      remoteName: "origin",
      pullRequestNumber: 42,
      expectedPullRequestUrl: "https://github.test/org/repo/pull/42",
      github: { getPullRequest: async () => ({ number: 42, url: "https://github.test/org/repo/pull/42", head_ref: manifest.branch_name!, head_sha: run.head, base_ref: "main", state: "OPEN" as const }) },
      resolveLocalSha: async () => run.head,
      resolveRemoteSha: async () => run.head,
      observedAt: () => "2026-07-16T12:00:01.000Z",
    };
    const first = await recordRemoteSynchronization(input);
    const firstBoundary = (await readManifestV2(run.runDir)).work_item_progress.integrated!.github_status_transition_at;
    const beforeRetry = await readManifestV2(run.runDir);
    await updateManifestV2(run.runDir, {
      work_item_progress: {
        ...beforeRetry.work_item_progress,
        integrated: { ...beforeRetry.work_item_progress.integrated!, status: "in_progress", github_status_transition_at: "2026-07-16T12:00:02.000Z" },
      },
    });
    const duringRetry = await readManifestV2(run.runDir);
    await updateManifestV2(run.runDir, {
      work_item_progress: {
        ...duringRetry.work_item_progress,
        integrated: { ...duringRetry.work_item_progress.integrated!, status: "complete", github_status_transition_at: "2026-07-16T12:00:03.000Z" },
      },
    });
    expect((await readManifestV2(run.runDir)).work_item_progress.integrated!.github_status_transition_at).toBe(firstBoundary);
    const repeated = await recordRemoteSynchronization(input);
    expect(repeated.artifactPath).toBe(first.artifactPath);
    expect(await assessFinalDelivery(run.runDir, { candidateCommit: run.head, worktreeClean: true }))
      .toMatchObject({ outcome: "verified_ready", blocker_code: null });

    const beforeCommitChange = await readManifestV2(run.runDir);
    await updateManifestV2(run.runDir, {
      work_item_progress: {
        ...beforeCommitChange.work_item_progress,
        integrated: { ...beforeCommitChange.work_item_progress.integrated!, commit_sha: TEST_SHA },
      },
    });
    expect((await readManifestV2(run.runDir)).work_item_progress.integrated!.github_status_transition_at).not.toBe(firstBoundary);
    expect(await assessFinalDelivery(run.runDir, { candidateCommit: run.head, worktreeClean: true }))
      .toMatchObject({ outcome: "blocked", blocker_code: "remote_candidate_mismatch" });
  });

  it.each([
    ["missing", async (_run: Awaited<ReturnType<typeof githubAssuranceRun>>) => {}],
    ["invalid", async (run: Awaited<ReturnType<typeof githubAssuranceRun>>) => {
      await updateManifestV2(run.runDir, { remote_synchronization_path: run.syncPath });
    }],
    ["stale", async (run: Awaited<ReturnType<typeof githubAssuranceRun>>) => {
      await writeSynchronizationEvidence(run, { observed_at: "2026-07-16T11:59:59.999Z" });
    }],
    ["mismatch", async (run: Awaited<ReturnType<typeof githubAssuranceRun>>) => {
      await writeSynchronizationEvidence(run, { local_candidate_sha: TEST_SHA, mapped_pr_sha: TEST_SHA, remote_head_sha: TEST_SHA });
    }],
  ])("does not let risk acceptance waive %s remote synchronization blockers", async (_name, arrange) => {
    const run = await githubAssuranceRun();
    await arrange(run);
    await expect(acceptFinalDeliveryRisk(run.runDir, "operator@example.test", "Ignore remote mismatch"))
      .rejects.toThrow(/waivable evidence blocker/i);
  });

  it("keeps remote-skip bypasses out of assurance and status publication contracts", async () => {
    const [assuranceSource, runtimeSource] = await Promise.all([
      readFile(join(process.cwd(), "src/workflow/assurance.ts"), "utf8"),
      readFile(join(process.cwd(), "src/workflow/runtime.ts"), "utf8"),
    ]);
    expect(assuranceSource).not.toContain("skipRemote");
    expect(runtimeSource).not.toContain("skipRemote");
  });
  it("rejects a final-Verifier index whose work-item evidence was tampered with", async () => {
    const repo = await gitRepo();
    const head = (await exec("git", ["rev-parse", "HEAD"], { cwd: repo.worktree })).stdout.trim();
    const config = defaultConfig();
    const intake = resolveRunIntake({
      task: "Validate indexed evidence",
      repo_root: repo.root,
      mode: "local",
      research: false,
      reflection: false,
    }, config);
    const controllerProvenance = {
      self_hosting: false,
      mode: "development_checkout" as const,
      executable_path: "/test/brain-hands",
      package_root: "/test/package",
      package_name: "@ngelik/brain-hands",
      package_version: "0.4.0",
      package_hash_algorithm: "sha256" as const,
      package_hash: "a".repeat(64),
      candidate_commit: head,
    };
    const runConfiguration = resolveRunConfiguration({ intake, config, controller: controllerProvenance, overrides: {} });
    const ledger = await createRunLedgerV2({
      repoRoot: repo.root,
      originalRequest: intake.task,
      mode: "local",
      intake,
      roles: intake.roles,
      sourceCommit: head,
      worktreePath: repo.worktree,
      branchName: "candidate",
      controllerProvenance,
    });
    await writeFile(join(ledger.runDir, "run-configuration.json"), serializeRunConfiguration(runConfiguration));
    await transitionRun(ledger.runDir, "preflight");
    await transitionRun(ledger.runDir, "brain_discovery");
    const workItem = executionSpec("feature");
    const plan = JSON.parse(assurancePlan([workItem.id]));
    const recorded = await recordAndApprovePinnedInitialPlan(
      ledger.runDir,
      plan,
      async () => ({ provenance: controllerProvenance, selfHosting: false }),
    );
    const implementationRef = await writeImmutableValidatedJson(
      ledger.runDir,
      "implementation/feature/attempt-1.json",
      implementationResultSchema,
      { work_item_id: workItem.id, changed_files: ["src/feature.ts"], tests_added_or_changed: [], commands_attempted: [], completed_steps: ["feature"], remaining_risks: [] },
    );
    const itemResultPath = "verification/local/feature/attempt-1/command-1.json";
    await writeTextArtifact(ledger.runDir, "verification/local/feature/attempt-1/command-1.stdout.txt", "passed\n");
    await writeTextArtifact(ledger.runDir, "verification/local/feature/attempt-1/command-1.stderr.txt", "");
    await writeImmutableValidatedJson(ledger.runDir, itemResultPath, verificationExecutionResultSchema, {
      argv: workItem.verification_commands[0]!.argv,
      stdout: "passed\n", stderr: "", exit_code: 0, duration_ms: 1, timed_out: false,
      error_code: null, error_message: null, signal: null,
    });
    const itemEvidencePath = "verification/local/feature/attempt-1/evidence.json";
    const itemEvidenceRef = await writeImmutableValidatedJson(ledger.runDir, itemEvidencePath, verificationEvidenceSchema, {
      verification_scope: "local", work_item_id: workItem.id, attempt: 1, evidence_path: itemEvidencePath,
      commands: [{
        command: workItem.verification_commands[0]!.argv.join(" "), argv: workItem.verification_commands[0]!.argv,
        exit_code: 0, timed_out: false, error_code: null, error_message: null, signal: null,
        stdout_path: "verification/local/feature/attempt-1/command-1.stdout.txt",
        stderr_path: "verification/local/feature/attempt-1/command-1.stderr.txt", result_path: itemResultPath,
      }],
      artifacts: [], artifact_checks: [], browser_evidence: [], created_at: new Date().toISOString(),
    });
    const itemReviewRef = await writeImmutableValidatedJson(
      ledger.runDir,
      "reviews/feature/attempt-1.json",
      persistedVerifierReviewSchema,
      {
        work_item_id: workItem.id, attempt: 1, final: false, decision: "approve", failure_class: "none",
        blocker: null, blocker_code: null, acceptance_coverage: workItem.completion_contract.required_acceptance_ids,
        evidence_reviewed: [itemEvidencePath], findings: [], residual_risks: [],
      },
    );
    let manifest = await readManifestV2(ledger.runDir);
    await updateManifestV2(ledger.runDir, {
      work_item_progress: {
        ...manifest.work_item_progress,
        feature: {
          status: "in_progress", attempts: 1, context_base_commit: head, context_plan_revision: recorded.revision,
          implementation_path: implementationRef.path, verification_path: itemEvidenceRef.path,
          review_path: itemReviewRef.path, review_revision: 1, commit_sha: head,
        },
      },
    });
    const summaryRef = await persistWorkItemSummary({
      runDir: ledger.runDir, workItem, planRevision: recorded.revision, planSha256: recorded.sha256,
      attempt: 1, baseCommit: head, commitSha: head, completionBasis: "verifier_approve",
      implementationRef, verificationRef: itemEvidenceRef, reviewRef: itemReviewRef, policyDecisionRef: null,
      findingRevision: { reviewRevision: 1, findingIds: [] }, createdAt: new Date().toISOString(),
    });
    const integratedPath = "verification/integrated/attempt-1/evidence.json";
    const integratedRef = await writeImmutableValidatedJson(ledger.runDir, integratedPath, verificationEvidenceSchema, {
      verification_scope: "integrated", work_item_id: "integrated", attempt: 1, evidence_path: integratedPath,
      commands: [], artifacts: [], artifact_checks: [], browser_evidence: [], created_at: new Date().toISOString(),
    });
    manifest = await readManifestV2(ledger.runDir);
    await updateManifestV2(ledger.runDir, {
      work_item_progress: {
        ...manifest.work_item_progress,
        feature: { ...manifest.work_item_progress.feature!, status: "complete", summary_path: summaryRef.path, summary_sha256: summaryRef.sha256 },
        integrated: { status: "in_progress", attempts: 1, commit_sha: head, verification_path: integratedPath, review_revision: 1 },
      },
    });
    await recordFindingRevision(ledger.runDir, {
      work_item_id: "integrated",
      source: "verifier",
      severity: "high",
      disposition: "blocking",
      criterion_ref: "BH-001:AC-1",
      normalized_location: "src/feature.ts:1",
      problem_class: "correctness",
      problem: "The pre-terminal candidate still had a blocking finding.",
      required_fix: "Resolve the blocking finding before approval.",
      evidence_refs: [integratedPath],
      review_revision: 1,
    });
    const indexRef = await buildVerifierEvidenceIndex({
      runDir: ledger.runDir, phase: "final_integrated", attempt: 1, candidateCommit: head,
      workItemSummaryRefs: [summaryRef], integratedVerificationRef: integratedRef,
    });
    const finalReviewPath = "reviews/integrated/final-attempt-1.json";
    await writeImmutableValidatedJson(ledger.runDir, finalReviewPath, persistedVerifierReviewSchema, {
      work_item_id: "integrated", attempt: 1, final: true, decision: "approve", failure_class: "none",
      blocker: null, blocker_code: null, acceptance_coverage: [], evidence_reviewed: [integratedPath], findings: [], residual_risks: [],
    });
    manifest = await readManifestV2(ledger.runDir);
    await updateManifestV2(ledger.runDir, {
      stage: "delivery", delivery_state: "ready", final_verifier_index_path: indexRef.path,
      final_verifier_index_sha256: indexRef.sha256,
      final_artifact_paths: [integratedPath, finalReviewPath, indexRef.path],
      work_item_progress: {
        ...manifest.work_item_progress,
        integrated: { ...manifest.work_item_progress.integrated!, status: "complete", review_path: finalReviewPath, review_revision: 2 },
      },
    });
    const options = { candidateCommit: head, worktreeClean: true };
    expect(await assessFinalDelivery(ledger.runDir, options)).toMatchObject({ outcome: "verified_ready", blocker_code: null });

    const originalIndexBytes = await readFile(join(ledger.runDir, indexRef.path));
    const replacement = {
      ...JSON.parse(originalIndexBytes.toString("utf8")),
      unresolved_finding_refs: [],
    };
    const replacementBytes = Buffer.from(`${JSON.stringify(replacement, null, 2)}\n`);
    await writeFile(join(ledger.runDir, indexRef.path), replacementBytes);
    const transientRef = artifactRefFromBytes(indexRef.path, replacementBytes);
    await expect(loadEvidenceIndex(ledger.runDir, transientRef, {
      phase: "final_integrated",
      attempt: 1,
      candidateCommit: head,
      findingValidation: {
        mode: "post_review",
        finalReviewRef: artifactRefFromBytes(finalReviewPath, await readFile(join(ledger.runDir, finalReviewPath))),
      },
    })).resolves.toMatchObject({ unresolved_finding_refs: [] });
    expect(await assessFinalDelivery(ledger.runDir, options)).toMatchObject({
      outcome: "blocked",
      blocker_code: "invalid_final_evidence",
    });

    await writeFile(join(ledger.runDir, indexRef.path), originalIndexBytes);

    await writeFile(join(ledger.runDir, implementationRef.path), "{}\n");

    expect(await assessFinalDelivery(ledger.runDir, options)).toMatchObject({
      outcome: "blocked",
      blocker_code: "invalid_final_evidence",
    });
  });

  it("does not persist final assurance during a work-item verification block", async () => {
    const repo = await gitRepo();
    const ledger = await createRunLedgerV2({ repoRoot: repo.root, originalRequest: "Keep assurance final" });
    const head = (await exec("git", ["rev-parse", "HEAD"], { cwd: repo.worktree })).stdout.trim();
    await rewriteLegacyCheckoutSnapshot(ledger.runDir, { source_commit: head, worktree_path: repo.worktree, branch_name: "candidate" });
    await updateManifestV2(ledger.runDir, {
      stage: "verifying",
      delivery_state: "blocked",
      last_blocker: "Verification runtime unavailable",
    });

    expect(await persistFinalDeliveryAssessmentAtBoundary(ledger.runDir)).toBeNull();
    expect(await readManifestV2(ledger.runDir)).toMatchObject({
      assurance_outcome: null,
      assurance_assessment_path: null,
      last_blocker: "Verification runtime unavailable",
    });
  });

  it("rejects a tampered approved discovery brief without mutating assurance state", async () => {
    const repo = await gitRepo();
    const ledger = await createRunLedgerV2({ repoRoot: repo.root, originalRequest: "Bind assurance" });
    await transitionRun(ledger.runDir, "preflight"); await transitionRun(ledger.runDir, "brain_discovery");
    const brief = { revision: 1, goal: "Bind assurance", problem: "Tamper risk", constraints: [], decisions: [], assumptions: [], repository_evidence: ["src/workflow/assurance.ts"], success_criteria: ["Reject tamper"], accepted_risks: [], out_of_scope: [], selected_approach_id: null, selected_approach_rationale: null };
    await recordDiscoveryReadiness(ledger.runDir, { outcome: "no_discovery_needed", rationale: "Fixture ready.", repository_evidence: ["tests/workflow/assurance.test.ts"], approaches: [], alternatives_omitted_reason: "No alternative.", brief });
    await recordDiscoveryBrief(ledger.runDir, brief); await approveDiscoveryBrief(ledger.runDir, 1);
    const digest = (await readManifestV2(ledger.runDir)).discovery!.approved_brief_sha256!;
    const base = JSON.parse(assurancePlan(["feature"]));
    await recordPlan(ledger.runDir, JSON.stringify({ ...base, discovery_brief_revision: 1, discovery_brief_sha256: digest, discovery_decision_coverage: [], accepted_risks: [], out_of_scope: [] }));
    await updateManifestV2(ledger.runDir, { current_revision: 1, current_plan_revision: 1, approved_revision: 1, approved_plan_revision: 1 });
    await writeFile(join(ledger.runDir, "discovery/approved-brief.json"), `${JSON.stringify({ ...brief, goal: "TAMPERED" }, null, 2)}\n`);
    const before = await readFile(join(ledger.runDir, "manifest.json"), "utf8");
    expect(await assessFinalDelivery(ledger.runDir)).toMatchObject({ blocker_code: "invalid_plan_provenance" });
    expect(await readFile(join(ledger.runDir, "manifest.json"), "utf8")).toBe(before);
  });
  it("requires every planned item, a clean exact candidate, and canonical command evidence", async () => {
    const repo = await gitRepo();
    const ledger = await createLegacyRunLedgerV2({ repoRoot: repo.root, originalRequest: "Prove readiness" });
    const revision = await recordPlan(ledger.runDir, assurancePlan(["feature", "required-but-missing"]));
    await approvePlanRevision(ledger.runDir, revision.revision, { actor: "test" });
    const head = (await exec("git", ["rev-parse", "HEAD"], { cwd: repo.worktree })).stdout.trim();
    await rewriteLegacyCheckoutSnapshot(ledger.runDir, { source_commit: head, worktree_path: repo.worktree, branch_name: "candidate" });
    await updateManifestV2(ledger.runDir, {
      delivery_state: "ready",
      work_item_progress: { feature: { status: "complete", attempts: 1, commit_sha: head } },
    });
    expect(await assessFinalDelivery(ledger.runDir)).toMatchObject({ outcome: "blocked", blocker_code: "work_incomplete" });

    const evidencePath = "verification/integrated/attempt-1/evidence.json";
    const reviewPath = "reviews/integrated/final-attempt-1.json";
    const resultPath = "verification/integrated/attempt-1/command-1.json";
    await mkdir(join(ledger.runDir, "verification/integrated/attempt-1"), { recursive: true });
    await mkdir(join(ledger.runDir, "reviews/integrated"), { recursive: true });
    await writeTextArtifact(ledger.runDir, "verification/integrated/attempt-1/command-1.stdout.txt", "");
    await writeTextArtifact(ledger.runDir, "verification/integrated/attempt-1/command-1.stderr.txt", "");
    await writeTextArtifact(ledger.runDir, resultPath, `${JSON.stringify({ argv: ["true"], stdout: "", stderr: "", exit_code: 0, duration_ms: 1, timed_out: false, error_code: null, error_message: null, signal: null })}\n`);
    await writeTextArtifact(ledger.runDir, evidencePath, `${JSON.stringify({
      verification_scope: "integrated", work_item_id: "integrated", attempt: 1, evidence_path: evidencePath,
      commands: [{ command: "true", argv: ["true"], exit_code: 0, timed_out: false, error_code: null, error_message: null, signal: null, stdout_path: "verification/integrated/attempt-1/command-1.stdout.txt", stderr_path: "verification/integrated/attempt-1/command-1.stderr.txt", result_path: resultPath, duration_ms: 1 }],
      artifacts: [], artifact_checks: [], browser_evidence: [], created_at: new Date().toISOString(),
    })}\n`);
    await writeTextArtifact(ledger.runDir, reviewPath, `${JSON.stringify({ work_item_id: "integrated", attempt: 1, final: true, decision: "approve", acceptance_coverage: [], evidence_reviewed: [evidencePath], findings: [], residual_risks: [] })}\n`);
    await updateManifestV2(ledger.runDir, {
      final_artifact_paths: [evidencePath, reviewPath],
      work_item_progress: {
        feature: { status: "complete", attempts: 1, commit_sha: head },
        "required-but-missing": { status: "complete", attempts: 1, commit_sha: head },
        integrated: { status: "complete", attempts: 1, commit_sha: head, verification_path: evidencePath, review_path: reviewPath },
      },
    });
    expect((await assessFinalDelivery(ledger.runDir)).outcome).toBe("verified_ready");

    await updateManifestV2(ledger.runDir, { approved_revision: null, approved_plan_revision: null });
    expect(await assessFinalDelivery(ledger.runDir)).toMatchObject({ outcome: "blocked", blocker_code: "invalid_plan_provenance" });
    await updateManifestV2(ledger.runDir, { approved_revision: revision.revision, approved_plan_revision: revision.revision });

    await writeFile(join(repo.worktree, "dirty.txt"), "dirty\n");
    expect(await assessFinalDelivery(ledger.runDir)).toMatchObject({ outcome: "blocked", blocker_code: "dirty_candidate_worktree" });
  });

  it("binds human acceptance to an exact evidence blocker, plan, and commit", async () => {
    const repo = await gitRepo();
    const ledger = await createLegacyRunLedgerV2({ repoRoot: repo.root, originalRequest: "Accept missing final evidence" });
    const revision = await recordPlan(ledger.runDir, assurancePlan(["feature"]));
    await approvePlanRevision(ledger.runDir, revision.revision, { actor: "test" });
    const head = (await exec("git", ["rev-parse", "HEAD"], { cwd: repo.worktree })).stdout.trim();
    await rewriteLegacyCheckoutSnapshot(ledger.runDir, { source_commit: head, worktree_path: repo.worktree, branch_name: "candidate" });
    await updateManifestV2(ledger.runDir, {
      stage: "final_verification", delivery_state: "blocked", last_blocker: "Missing final evidence",
      work_item_progress: { feature: { status: "complete", attempts: 1, commit_sha: "no-op" } },
    });

    const before = await assessFinalDelivery(ledger.runDir);
    expect(before).toMatchObject({ outcome: "blocked", blocker_code: "missing_final_evidence" });
    const acceptance = await acceptFinalDeliveryRisk(ledger.runDir, "operator@example.test", "Ship with documented evidence gap");
    expect(acceptance).toMatchObject({ gate: "final-delivery", blocker_code: "missing_final_evidence", actor: "operator@example.test" });
    expect((await assessFinalDelivery(ledger.runDir)).outcome).toBe("human_accepted");
    expect(await acceptFinalDeliveryRisk(ledger.runDir, "operator@example.test", "Ship with documented evidence gap")).toEqual(acceptance);
    const replacement = await acceptFinalDeliveryRisk(ledger.runDir, "second@example.test", "Independent approval");
    expect(replacement.actor).toBe("second@example.test");
    expect((await readManifestV2(ledger.runDir)).risk_acceptance_history).toHaveLength(2);
    await Promise.all([
      acceptFinalDeliveryRisk(ledger.runDir, "third@example.test", "Third approval"),
      acceptFinalDeliveryRisk(ledger.runDir, "fourth@example.test", "Fourth approval"),
    ]);
    expect((await readManifestV2(ledger.runDir)).risk_acceptance_history).toHaveLength(4);

    await writeFile(join(repo.worktree, "README.md"), "changed candidate\n");
    await exec("git", ["add", "README.md"], { cwd: repo.worktree });
    await exec("git", ["commit", "-qm", "different candidate"], { cwd: repo.worktree });
    expect((await assessFinalDelivery(ledger.runDir)).outcome).toBe("blocked");
  });

  it("makes abandonment immutable and non-resumable", async () => {
    const repo = await gitRepo();
    const ledger = await createRunLedgerV2({ repoRoot: repo.root, originalRequest: "Stop this run" });
    await abandonRun(ledger.runDir, "operator@example.test", "Requirements withdrawn");
    const manifest = await readManifestV2(ledger.runDir);
    expect((await assessFinalDelivery(ledger.runDir)).outcome).toBe("abandoned");
    expect(() => assertNotAbandoned(manifest)).toThrow(/cannot be resumed/i);
    await expect(replaceAbandonedRun({
      runDir: ledger.runDir,
      actor: "operator@example.test",
      reason: "Replacement requires explicit terminal closure",
      dryRun: true,
    })).rejects.toThrow(/terminal abandoned/i);
    await expect(acceptFinalDeliveryRisk(ledger.runDir, "operator@example.test", "No")).rejects.toThrow(/final-delivery gate/i);
  });
});
