import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  artifactRefFromBytes,
  type ArtifactRefV1,
} from "../../src/core/context-contracts.js";
import {
  approvePlanRevision,
  createRunLedgerV2,
  readManifestV2,
  recordPlan,
  updateManifestV2,
  writeImmutableValidatedJson,
} from "../../src/core/ledger.js";
import {
  implementationResultSchema,
  persistedVerifierReviewSchema,
  verificationEvidenceSchema,
  verificationExecutionResultSchema,
} from "../../src/core/schema.js";
import type {
  ImplementationResult,
  ReviewPolicy,
  VerificationEvidence,
  VerifierReview,
  WorkItem,
} from "../../src/core/types.js";
import { loadOrCreateWarningAuthorization } from "../../src/workflow/authorization.js";
import { recordFindingRevision } from "../../src/workflow/findings.js";
import {
  beginReviewCycle,
  claimReviewEffect,
  completeReviewEffect,
} from "../../src/workflow/review-cycle.js";
import {
  assertApprovedAcceptanceCoverage,
  loadWorkItemSummary,
  type PersistWorkItemSummaryInput,
  persistWorkItemSummary,
  workItemSummaryPath,
} from "../../src/workflow/work-item-summaries.js";

const baseCommit = "a".repeat(40);
const commitSha = "b".repeat(40);
const createdAt = "2026-07-16T12:00:00.000Z";
const policy: ReviewPolicy = {
  policy_revision: 2,
  max_fix_cycles: 0,
  on_limit: "continue_with_warning",
  auto_advance_on_approval: true,
  severity_defaults: {
    critical: "blocking",
    high: "blocking",
    medium: "fix_in_scope",
    low: "advisory",
  },
  pause_on: ["plan_approval", "unresolved_release_blocker"],
};

const workItem: WorkItem = {
  schema_version: "2.0",
  id: "BH-001",
  title: "Build the summary",
  objective: "Persist controller-derived evidence.",
  dependencies: [],
  file_contract: [
    { path: "src/a.ts", permission: "modify", targets: ["summary behavior"] },
  ],
  forbidden_changes: [],
  change_units: [{
    id: "CH-1",
    path: "src/a.ts",
    target: "summary behavior",
    operation: "modify",
    requirements: ["Persist the summary."],
  }],
  acceptance: [
    { id: "BH-001:AC-1", statement: "First criterion", satisfied_by: ["CH-1", "TEST-1"] },
    { id: "BH-001:AC-2", statement: "Second criterion", satisfied_by: ["CH-1", "TEST-1"] },
  ],
  tests: [{
    id: "TEST-1",
    path: "tests/a.test.ts",
    assertion: "The summary is persisted.",
    verification_command_ids: ["VERIFY-1"],
  }],
  verification_commands: [{
    id: "VERIFY-1",
    argv: ["npm", "test"],
    expected_exit_code: 0,
  }],
  expected_artifacts: [],
  browser_checks: [],
  risks: [],
  completion_contract: {
    expected_changed_files: ["src/a.ts"],
    allow_additional_files: false,
    required_acceptance_ids: ["BH-001:AC-1", "BH-001:AC-2"],
  },
  ambiguity_policy: {
    default: "stop_and_report",
    stop_when: ["The durable evidence is ambiguous."],
  },
};

let root: string | null = null;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = null;
});

interface Fixture {
  runDir: string;
  runId: string;
  planRevision: number;
  planSha256: string;
  implementationRef: ArtifactRefV1;
  verificationRef: ArtifactRefV1;
  reviewRef: ArtifactRefV1;
  resultPath: string;
  input: PersistWorkItemSummaryInput;
}

function approvedReview(overrides: Partial<VerifierReview> = {}): VerifierReview {
  return {
    work_item_id: workItem.id,
    attempt: 1,
    final: false,
    decision: "approve",
    failure_class: "none",
    blocker: null,
    blocker_code: null,
    acceptance_coverage: ["BH-001:AC-2", "BH-001:AC-1", "BH-001:AC-1"],
    evidence_reviewed: [],
    findings: [],
    residual_risks: ["risk-b", "risk-a", "risk-a"],
    ...overrides,
  };
}

function requestChangesReview(attempt = 1): VerifierReview {
  return {
    work_item_id: workItem.id,
    attempt,
    final: false,
    decision: "request_changes",
    failure_class: "implementation_failure",
    blocker: null,
    blocker_code: null,
    acceptance_coverage: ["BH-001:AC-1"],
    evidence_reviewed: [],
    findings: [{
      severity: "medium",
      file: "src/a.ts",
      line: 1,
      acceptance_criterion: "BH-001:AC-2",
      problem: "The second criterion is incomplete.",
      required_fix: "Complete the second criterion.",
      re_verification: [["npm", "test"]],
    }],
    residual_risks: ["incomplete acceptance"],
  };
}

async function persistReview(
  runDir: string,
  path: string,
  review: VerifierReview,
  verificationPath: string,
): Promise<ArtifactRefV1> {
  return writeImmutableValidatedJson(
    runDir,
    path,
    persistedVerifierReviewSchema,
    { ...review, evidence_reviewed: [verificationPath] },
  );
}

async function createFixture(review: VerifierReview = approvedReview()): Promise<Fixture> {
  root = await mkdtemp(join(tmpdir(), "brain-hands-work-item-summary-"));
  const ledger = await createRunLedgerV2({
    repoRoot: root,
    originalRequest: "Build a work-item summary",
    sourceCommit: baseCommit,
    intake: {
      task: "Build a work-item summary",
      repo_root: root,
      review_policy: policy,
    },
  });
  const planText = JSON.stringify({ work_items: [workItem] });
  const plan = await recordPlan(ledger.runDir, planText);
  await approvePlanRevision(ledger.runDir, plan.revision);

  const implementation: ImplementationResult = {
    work_item_id: workItem.id,
    changed_files: ["src/a.ts", "src/a.ts"],
    tests_added_or_changed: ["tests/a.test.ts"],
    commands_attempted: [["npm", "test"]],
    completed_steps: ["CH-1"],
    remaining_risks: ["risk-c", "risk-a"],
  };
  const implementationRef = await writeImmutableValidatedJson(
    ledger.runDir,
    "implementation/BH-001/attempt-1.json",
    implementationResultSchema,
    implementation,
  );
  const resultPath = "verification/local/BH-001/attempt-1/command-1.json";
  await writeImmutableValidatedJson(
    ledger.runDir,
    resultPath,
    verificationExecutionResultSchema,
    {
      argv: ["npm", "test"],
      stdout: "passed\n",
      stderr: "",
      exit_code: 0,
      duration_ms: 10,
      timed_out: false,
      error_code: null,
      error_message: null,
      signal: null,
    },
  );
  const verificationPath = "verification/local/BH-001/attempt-1/evidence.json";
  const verification: VerificationEvidence = {
    verification_scope: "local",
    work_item_id: workItem.id,
    attempt: 1,
    evidence_path: verificationPath,
    commands: [{
      command: "npm test",
      argv: ["npm", "test"],
      exit_code: 0,
      timed_out: false,
      error_code: null,
      error_message: null,
      signal: null,
      stdout_path: "verification/local/BH-001/attempt-1/command-1.stdout.txt",
      stderr_path: "verification/local/BH-001/attempt-1/command-1.stderr.txt",
      result_path: resultPath,
    }],
    artifacts: [],
    artifact_checks: [],
    browser_evidence: [],
    created_at: createdAt,
  };
  const verificationRef = await writeImmutableValidatedJson(
    ledger.runDir,
    verificationPath,
    verificationEvidenceSchema,
    verification,
  );
  const reviewRef = await persistReview(
    ledger.runDir,
    "reviews/BH-001/attempt-1.json",
    review,
    verificationPath,
  );
  let manifest = await readManifestV2(ledger.runDir);
  manifest = await updateManifestV2(ledger.runDir, {
    current_work_item_id: workItem.id,
    work_item_progress: {
      ...manifest.work_item_progress,
      [workItem.id]: {
        status: "in_progress",
        attempts: 1,
        context_base_commit: baseCommit,
        context_plan_revision: plan.revision,
        implementation_path: implementationRef.path,
        verification_path: verificationRef.path,
        review_path: reviewRef.path,
        review_revision: 1,
        commit_sha: commitSha,
      },
    },
  });
  const input: PersistWorkItemSummaryInput = {
    runDir: ledger.runDir,
    workItem,
    planRevision: plan.revision,
    planSha256: plan.sha256,
    attempt: 1,
    baseCommit,
    commitSha,
    completionBasis: "verifier_approve",
    implementationRef,
    verificationRef,
    reviewRef,
    policyDecisionRef: null,
    findingRevision: { reviewRevision: 1, findingIds: [] },
    createdAt,
  };
  return {
    runDir: ledger.runDir,
    runId: manifest.run_id,
    planRevision: plan.revision,
    planSha256: plan.sha256,
    implementationRef,
    verificationRef,
    reviewRef,
    resultPath,
    input,
  };
}

async function artifactRef(runDir: string, path: string): Promise<ArtifactRefV1> {
  return artifactRefFromBytes(path, await readFile(join(runDir, path)));
}

async function completeAdvanceCycle(fixture: Fixture) {
  const manifest = await readManifestV2(fixture.runDir);
  const cycle = await beginReviewCycle({
    run_dir: fixture.runDir,
    work_item_id: workItem.id,
    phase: "work_item",
    review_revision: 1,
    policy_hash: createHash("sha256").update(JSON.stringify(manifest.review_policy_snapshot)).digest("hex"),
    finding_ids: [],
    accounting_before: manifest.review_accounting!,
    work_item_progress_reference: {
      attempts: 1,
      review_path: fixture.reviewRef.path,
      verification_path: fixture.verificationRef.path,
    },
    evaluate: () => ({
      action: "advance",
      reason_code: "no_blocking_findings",
      finding_ids: [],
      policy_revision: manifest.review_policy_snapshot!.policy_revision,
      authorization_required: false,
    }),
  });
  const owner = `runtime:work-item:${workItem.id}`;
  await claimReviewEffect({ run_dir: fixture.runDir, cycle, owner });
  await completeReviewEffect({
    run_dir: fixture.runDir,
    cycle,
    owner,
    outcome: "complete",
    result: { commit_sha: commitSha },
  });
  return { cycle, policyDecisionRef: await artifactRef(fixture.runDir, cycle.decision_path) };
}

describe("work-item summary derivation", () => {
  it("uses plan-revision-separated paths and exact approval coverage", () => {
    expect(workItemSummaryPath("BH-001", 2, 3)).toBe(
      "summaries/work-items/QkgtMDAx/plan-2/attempt-3.json",
    );
    expect(() => assertApprovedAcceptanceCoverage(
      ["AC-1", "AC-2"],
      ["AC-2", "AC-1"],
    )).not.toThrow();
    expect(() => assertApprovedAcceptanceCoverage(
      ["AC-1", "AC-2"],
      ["AC-1"],
    )).toThrow("Verifier approval does not cover required acceptance IDs");
  });

  it("rejects the wrong approved plan hash", async () => {
    const fixture = await createFixture();

    await expect(persistWorkItemSummary({
      ...fixture.input,
      planSha256: "0".repeat(64),
    })).rejects.toThrow(/approved plan hash/i);
  });

  it("rejects a source artifact from the wrong attempt", async () => {
    const fixture = await createFixture(approvedReview({ attempt: 2 }));

    await expect(persistWorkItemSummary(fixture.input)).rejects.toThrow(/attempt/i);
  });

  it("rejects a non-approving review without policy authority", async () => {
    const fixture = await createFixture(requestChangesReview());

    await expect(persistWorkItemSummary(fixture.input)).rejects.toThrow(/Verifier approval/i);
  });

  it("requires exact acceptance coverage for direct Verifier approval", async () => {
    const fixture = await createFixture(approvedReview({
      acceptance_coverage: ["BH-001:AC-1"],
    }));

    await expect(persistWorkItemSummary(fixture.input))
      .rejects.toThrow("Verifier approval does not cover required acceptance IDs");
  });

  it("requires both a warning decision and its durable authorization artifact", async () => {
    const fixture = await createFixture(requestChangesReview());

    await expect(persistWorkItemSummary({
      ...fixture.input,
      completionBasis: "policy_warning_continuation",
    })).rejects.toThrow(/policy decision/i);

    const finding = await recordFindingRevision(fixture.runDir, {
      work_item_id: workItem.id,
      source: "verifier",
      severity: "medium",
      disposition: "fix_in_scope",
      criterion_ref: "BH-001:AC-2",
      normalized_location: "src/a.ts:1",
      problem_class: "correctness",
      problem: "The second criterion is incomplete.",
      required_fix: "Complete the second criterion.",
      evidence_refs: [fixture.verificationRef.path],
      review_revision: 1,
    });
    const manifest = await readManifestV2(fixture.runDir);
    await updateManifestV2(fixture.runDir, {
      current_work_item_id: workItem.id,
      work_item_progress: {
        ...manifest.work_item_progress,
        [workItem.id]: {
          ...manifest.work_item_progress[workItem.id],
          status: "in_progress",
          attempts: 1,
          review_path: fixture.reviewRef.path,
          verification_path: fixture.verificationRef.path,
        },
      },
    });
    const cycle = await beginReviewCycle({
      run_dir: fixture.runDir,
      work_item_id: workItem.id,
      phase: "work_item",
      review_revision: 1,
      policy_hash: createHash("sha256").update(JSON.stringify(manifest.review_policy_snapshot)).digest("hex"),
      finding_ids: [finding.finding_id],
      accounting_before: manifest.review_accounting!,
      work_item_progress_reference: {
        attempts: 1,
        review_path: fixture.reviewRef.path,
        verification_path: fixture.verificationRef.path,
      },
      evaluate: () => ({
        action: "continue_with_warning",
        reason_code: "authorized_warning",
        finding_ids: [finding.finding_id],
        policy_revision: manifest.review_policy_snapshot!.policy_revision,
        authorization_required: false,
      }),
    });
    const policyDecisionRef = await artifactRef(fixture.runDir, cycle.decision_path);
    await claimReviewEffect({
      run_dir: fixture.runDir,
      cycle,
      owner: `runtime:work-item:${workItem.id}`,
    });
    await completeReviewEffect({
      run_dir: fixture.runDir,
      cycle,
      owner: `runtime:work-item:${workItem.id}`,
      outcome: "complete",
      result: { commit_sha: commitSha },
    });
    const warningInput: PersistWorkItemSummaryInput = {
      ...fixture.input,
      completionBasis: "policy_warning_continuation",
      policyDecisionRef,
      findingRevision: { reviewRevision: 1, findingIds: [finding.finding_id] },
    };

    await expect(persistWorkItemSummary(warningInput)).rejects.toThrow(/authorization/i);

    await loadOrCreateWarningAuthorization({
      run_dir: fixture.runDir,
      work_item_id: workItem.id,
      review_revision: 1,
      policy: manifest.review_policy_snapshot!,
      findings: [finding],
      evidence_snapshot: [fixture.reviewRef.path, fixture.verificationRef.path],
    });
    const ref = await persistWorkItemSummary(warningInput);
    const summary = await loadWorkItemSummary(fixture.runDir, ref, {
      runId: fixture.runId,
      workItemId: workItem.id,
      planRevision: fixture.planRevision,
      planSha256: fixture.planSha256,
      attempt: 1,
      baseCommit,
      commitSha,
    });

    expect(summary.acceptance_ids).toEqual(["BH-001:AC-1"]);
    expect(summary.unresolved_finding_ids).toEqual([finding.finding_id]);
  });

  it("rejects command-count and exact argv mismatches", async () => {
    const fixture = await createFixture();
    const verification = verificationEvidenceSchema.parse(
      JSON.parse(await readFile(join(fixture.runDir, fixture.verificationRef.path), "utf8")),
    );
    const extraRef = await writeImmutableValidatedJson(
      fixture.runDir,
      "verification/local/BH-001/attempt-1/evidence-extra.json",
      verificationEvidenceSchema,
      { ...verification, evidence_path: "verification/local/BH-001/attempt-1/evidence-extra.json", commands: [] },
    );
    const extraReviewRef = await persistReview(
      fixture.runDir,
      "reviews/BH-001/attempt-1-extra.json",
      approvedReview(),
      extraRef.path,
    );
    let current = await readManifestV2(fixture.runDir);
    await updateManifestV2(fixture.runDir, {
      work_item_progress: {
        ...current.work_item_progress,
        [workItem.id]: {
          ...current.work_item_progress[workItem.id],
          verification_path: extraRef.path,
          review_path: extraReviewRef.path,
        },
      },
    });
    await expect(persistWorkItemSummary({
      ...fixture.input,
      verificationRef: extraRef,
      reviewRef: extraReviewRef,
    }))
      .rejects.toThrow(/command count/i);

    const argvRef = await writeImmutableValidatedJson(
      fixture.runDir,
      "verification/local/BH-001/attempt-1/evidence-argv.json",
      verificationEvidenceSchema,
      {
        ...verification,
        evidence_path: "verification/local/BH-001/attempt-1/evidence-argv.json",
        commands: verification.commands.map((command) => ({ ...command, argv: ["npm", "run", "test"] })),
      },
    );
    const argvReviewRef = await persistReview(
      fixture.runDir,
      "reviews/BH-001/attempt-1-argv.json",
      approvedReview(),
      argvRef.path,
    );
    current = await readManifestV2(fixture.runDir);
    await updateManifestV2(fixture.runDir, {
      work_item_progress: {
        ...current.work_item_progress,
        [workItem.id]: {
          ...current.work_item_progress[workItem.id],
          verification_path: argvRef.path,
          review_path: argvReviewRef.path,
        },
      },
    });
    await expect(persistWorkItemSummary({
      ...fixture.input,
      verificationRef: argvRef,
      reviewRef: argvReviewRef,
    }))
      .rejects.toThrow(/argv/i);
  });

  it("detects a result-path byte hash mismatch on reload", async () => {
    const fixture = await createFixture();
    const ref = await persistWorkItemSummary(fixture.input);
    const expected = {
      runId: fixture.runId,
      workItemId: workItem.id,
      planRevision: fixture.planRevision,
      planSha256: fixture.planSha256,
      attempt: 1,
      baseCommit,
      commitSha,
    };
    const loaded = await loadWorkItemSummary(fixture.runDir, ref, expected);
    expect(loaded).toMatchObject({
      changed_files: ["src/a.ts"],
      acceptance_ids: ["BH-001:AC-1", "BH-001:AC-2"],
      residual_risks: ["risk-a", "risk-b", "risk-c"],
    });

    const mismatches = [
      { runId: "wrong-run" },
      { workItemId: "wrong-item" },
      { planRevision: 2 },
      { planSha256: "0".repeat(64) },
      { attempt: 2 },
      { baseCommit: "c".repeat(40) },
      { commitSha: "d".repeat(40) },
    ];
    for (const mismatch of mismatches) {
      await expect(loadWorkItemSummary(fixture.runDir, ref, { ...expected, ...mismatch }))
        .rejects.toThrow(/controller provenance/i);
    }

    await writeFile(join(fixture.runDir, fixture.resultPath), "{}\n", "utf8");

    await expect(loadWorkItemSummary(fixture.runDir, ref, expected)).rejects.toThrow(/SHA-256/i);
  });

  it("rejects a stale finding revision", async () => {
    const fixture = await createFixture();
    const finding = await recordFindingRevision(fixture.runDir, {
      work_item_id: workItem.id,
      source: "verifier",
      severity: "medium",
      disposition: "fix_in_scope",
      criterion_ref: "BH-001:AC-1",
      normalized_location: "src/a.ts:1",
      problem_class: "correctness",
      problem: "The first criterion regressed.",
      required_fix: "Restore it.",
      evidence_refs: [fixture.verificationRef.path],
      review_revision: 1,
    });

    await expect(persistWorkItemSummary({
      ...fixture.input,
      findingRevision: { reviewRevision: 2, findingIds: [finding.finding_id] },
    })).rejects.toThrow(/current durable review revision|revision 2.*missing|missing.*revision 2/i);
  });

  it("rejects an arbitrary empty finding revision that hides an active finding", async () => {
    const fixture = await createFixture();
    await recordFindingRevision(fixture.runDir, {
      work_item_id: workItem.id,
      source: "verifier",
      severity: "medium",
      disposition: "fix_in_scope",
      criterion_ref: "BH-001:AC-1",
      normalized_location: "src/a.ts:1",
      problem_class: "correctness",
      problem: "The first criterion regressed.",
      required_fix: "Restore it.",
      evidence_refs: [fixture.verificationRef.path],
      review_revision: 1,
    });

    await expect(persistWorkItemSummary({
      ...fixture.input,
      findingRevision: { reviewRevision: 2, findingIds: [] },
    })).rejects.toThrow(/current durable review revision|complete finding set/i);
  });

  it("rejects an omitted active finding at the current revision", async () => {
    const fixture = await createFixture();
    await recordFindingRevision(fixture.runDir, {
      work_item_id: workItem.id,
      source: "verifier",
      severity: "medium",
      disposition: "fix_in_scope",
      criterion_ref: "BH-001:AC-1",
      normalized_location: "src/a.ts:1",
      problem_class: "correctness",
      problem: "The first criterion regressed.",
      required_fix: "Restore it.",
      evidence_refs: [fixture.verificationRef.path],
      review_revision: 1,
    });

    await expect(persistWorkItemSummary(fixture.input)).rejects.toThrow(/complete finding set|extra/i);
  });

  it("rejects plan-1 source artifacts for a changed plan-2 work item", async () => {
    const fixture = await createFixture();
    const revisedWorkItem = { ...workItem, objective: "Persist revised controller evidence." };
    const secondPlan = await recordPlan(fixture.runDir, JSON.stringify({ work_items: [revisedWorkItem] }));
    await approvePlanRevision(fixture.runDir, secondPlan.revision);

    await expect(persistWorkItemSummary({
      ...fixture.input,
      workItem: revisedWorkItem,
      planRevision: secondPlan.revision,
      planSha256: secondPlan.sha256,
    })).rejects.toThrow(/context plan revision|current authority/i);
  });

  it("reloads a hash-verified historical summary while its durable progress still points to that revision", async () => {
    const fixture = await createFixture();
    const ref = await persistWorkItemSummary(fixture.input);
    const secondPlan = await recordPlan(fixture.runDir, JSON.stringify({ work_items: [workItem] }));
    await approvePlanRevision(fixture.runDir, secondPlan.revision);

    const loaded = await loadWorkItemSummary(fixture.runDir, ref, {
      runId: fixture.runId,
      workItemId: workItem.id,
      planRevision: fixture.planRevision,
      planSha256: fixture.planSha256,
      attempt: 1,
      baseCommit,
      commitSha,
    });

    expect(loaded.plan_revision).toBe(fixture.planRevision);
  });

  it("rejects historical summary adoption after the durable progress moves revisions", async () => {
    const fixture = await createFixture();
    const ref = await persistWorkItemSummary(fixture.input);
    const secondPlan = await recordPlan(fixture.runDir, JSON.stringify({ work_items: [workItem] }));
    await approvePlanRevision(fixture.runDir, secondPlan.revision);
    const current = await readManifestV2(fixture.runDir);
    await updateManifestV2(fixture.runDir, {
      work_item_progress: {
        ...current.work_item_progress,
        [workItem.id]: {
          ...current.work_item_progress[workItem.id],
          context_plan_revision: secondPlan.revision,
        },
      },
    });

    await expect(loadWorkItemSummary(fixture.runDir, ref, {
      runId: fixture.runId,
      workItemId: workItem.id,
      planRevision: fixture.planRevision,
      planSha256: fixture.planSha256,
      attempt: 1,
      baseCommit,
      commitSha,
    })).rejects.toThrow(/context plan revision|current authority/i);
  });

  it("rejects a stale current-cycle pointer", async () => {
    const fixture = await createFixture();
    const { cycle, policyDecisionRef } = await completeAdvanceCycle(fixture);
    const current = await readManifestV2(fixture.runDir);
    await updateManifestV2(fixture.runDir, {
      work_item_progress: {
        ...current.work_item_progress,
        [workItem.id]: {
          ...current.work_item_progress[workItem.id],
          review_cycle_path: "reviews/decisions/stale.json",
          review_effect_id: cycle.effect_id,
        },
      },
    });

    await expect(persistWorkItemSummary({
      ...fixture.input,
      completionBasis: "policy_advance",
      policyDecisionRef,
    })).rejects.toThrow(/current review cycle|current authority/i);
  });

  it("rejects a commit not authorized by the completed advance effect", async () => {
    const fixture = await createFixture();
    const { policyDecisionRef } = await completeAdvanceCycle(fixture);
    const arbitraryCommit = "c".repeat(40);
    const current = await readManifestV2(fixture.runDir);
    await updateManifestV2(fixture.runDir, {
      work_item_progress: {
        ...current.work_item_progress,
        [workItem.id]: {
          ...current.work_item_progress[workItem.id],
          commit_sha: arbitraryCommit,
        },
      },
    });

    await expect(persistWorkItemSummary({
      ...fixture.input,
      completionBasis: "policy_advance",
      commitSha: arbitraryCommit,
      policyDecisionRef,
    })).rejects.toThrow(/advance effect commit provenance/i);
  });

  it("rejects reload after a newer current finding revision appears", async () => {
    const fixture = await createFixture();
    const ref = await persistWorkItemSummary(fixture.input);
    await recordFindingRevision(fixture.runDir, {
      work_item_id: workItem.id,
      source: "verifier",
      severity: "medium",
      disposition: "fix_in_scope",
      criterion_ref: "BH-001:AC-1",
      normalized_location: "src/a.ts:2",
      problem_class: "correctness",
      problem: "A newer review found a regression.",
      required_fix: "Fix the regression.",
      evidence_refs: [fixture.verificationRef.path],
      review_revision: 2,
    });
    const current = await readManifestV2(fixture.runDir);
    await updateManifestV2(fixture.runDir, {
      work_item_progress: {
        ...current.work_item_progress,
        [workItem.id]: {
          ...current.work_item_progress[workItem.id],
          review_revision: 2,
        },
      },
    });

    await expect(loadWorkItemSummary(fixture.runDir, ref, {
      runId: fixture.runId,
      workItemId: workItem.id,
      planRevision: fixture.planRevision,
      planSha256: fixture.planSha256,
      attempt: 1,
      baseCommit,
      commitSha,
    })).rejects.toThrow(/current.*finding|unresolved finding|current authority/i);
  });

  it("rejects a command result reference substituted to a different path", async () => {
    const fixture = await createFixture();
    const ref = await persistWorkItemSummary(fixture.input);
    const summaryPath = join(fixture.runDir, ref.path);
    const summary = JSON.parse(await readFile(summaryPath, "utf8"));
    const substitutePath = "verification/local/BH-001/attempt-1/command-substitute.json";
    const substituteBytes = await readFile(join(fixture.runDir, fixture.resultPath));
    await writeFile(join(fixture.runDir, substitutePath), substituteBytes);
    summary.command_evidence[0].result_ref = artifactRefFromBytes(substitutePath, substituteBytes);
    const forgedBytes = Buffer.from(`${JSON.stringify(summary, null, 2)}\n`, "utf8");
    await writeFile(summaryPath, forgedBytes);
    const forgedRef = artifactRefFromBytes(ref.path, forgedBytes);

    await expect(loadWorkItemSummary(fixture.runDir, forgedRef, {
      runId: fixture.runId,
      workItemId: workItem.id,
      planRevision: fixture.planRevision,
      planSha256: fixture.planSha256,
      attempt: 1,
      baseCommit,
      commitSha,
    })).rejects.toThrow(/result reference path|result path/i);
  });

  it("persists the same work item independently under two plan revisions", async () => {
    const fixture = await createFixture();
    const firstRef = await persistWorkItemSummary(fixture.input);
    const revisedWorkItem = { ...workItem, objective: "Persist revised controller evidence." };
    const secondPlan = await recordPlan(fixture.runDir, JSON.stringify({
      work_items: [revisedWorkItem],
    }));
    await approvePlanRevision(fixture.runDir, secondPlan.revision);
    const implementationRef = await writeImmutableValidatedJson(
      fixture.runDir,
      "implementation/BH-001/plan-2-attempt-1.json",
      implementationResultSchema,
      JSON.parse(await readFile(join(fixture.runDir, fixture.implementationRef.path), "utf8")),
    );
    const resultPath = "verification/local/BH-001/plan-2-attempt-1/command-1.json";
    await writeImmutableValidatedJson(
      fixture.runDir,
      resultPath,
      verificationExecutionResultSchema,
      JSON.parse(await readFile(join(fixture.runDir, fixture.resultPath), "utf8")),
    );
    const priorVerification = verificationEvidenceSchema.parse(JSON.parse(
      await readFile(join(fixture.runDir, fixture.verificationRef.path), "utf8"),
    ));
    const verificationPath = "verification/local/BH-001/plan-2-attempt-1/evidence.json";
    const verificationRef = await writeImmutableValidatedJson(
      fixture.runDir,
      verificationPath,
      verificationEvidenceSchema,
      {
        ...priorVerification,
        evidence_path: verificationPath,
        commands: priorVerification.commands.map((command) => ({
          ...command,
          result_path: resultPath,
          stdout_path: "verification/local/BH-001/plan-2-attempt-1/command-1.stdout.txt",
          stderr_path: "verification/local/BH-001/plan-2-attempt-1/command-1.stderr.txt",
        })),
      },
    );
    const reviewRef = await persistReview(
      fixture.runDir,
      "reviews/BH-001/plan-2-attempt-1.json",
      approvedReview(),
      verificationPath,
    );
    const current = await readManifestV2(fixture.runDir);
    await updateManifestV2(fixture.runDir, {
      current_work_item_id: workItem.id,
      work_item_progress: {
        ...current.work_item_progress,
        [workItem.id]: {
          status: "in_progress",
          attempts: 1,
          context_base_commit: baseCommit,
          context_plan_revision: secondPlan.revision,
          implementation_path: implementationRef.path,
          verification_path: verificationRef.path,
          review_path: reviewRef.path,
          review_revision: 1,
          commit_sha: commitSha,
        },
      },
    });
    const secondRef = await persistWorkItemSummary({
      ...fixture.input,
      workItem: revisedWorkItem,
      planRevision: secondPlan.revision,
      planSha256: secondPlan.sha256,
      implementationRef,
      verificationRef,
      reviewRef,
    });

    expect(firstRef.path).toBe(workItemSummaryPath(workItem.id, 1, 1));
    expect(secondRef.path).toBe(workItemSummaryPath(workItem.id, 2, 1));
    expect(secondRef.path).not.toBe(firstRef.path);
    expect(await readFile(join(fixture.runDir, firstRef.path), "utf8")).toContain(`"plan_revision": 1`);
    expect(await readFile(join(fixture.runDir, secondRef.path), "utf8")).toContain(`"plan_revision": 2`);
  });
});
