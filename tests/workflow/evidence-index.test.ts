import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  artifactRefFromBytes,
  evidenceIndexV1Schema,
  type ArtifactRefV1,
} from "../../src/core/context-contracts.js";
import {
  approvePlanRevision,
  createRunLedgerV2,
  readManifestV2,
  recordTerminalDisposition,
  recordPlan,
  updateManifestV2,
  withRunLedgerTransaction,
  writeImmutableValidatedJson,
} from "../../src/core/ledger.js";
import {
  assuranceAssessmentSchema,
  implementationResultSchema,
  persistedVerifierReviewSchema,
  verificationEvidenceSchema,
  verificationExecutionResultSchema,
} from "../../src/core/schema.js";
import type { VerifierReview, WorkItem } from "../../src/core/types.js";
import {
  buildReflectionEvidenceIndex,
  buildVerifierEvidenceIndex,
  loadEvidenceIndex,
  reflectionEvidenceIndexPath,
  verifierEvidenceIndexPath,
} from "../../src/workflow/evidence-index.js";
import { findingHistoryPath, recordFindingRevision } from "../../src/workflow/findings.js";
import { persistWorkItemSummary } from "../../src/workflow/work-item-summaries.js";

const baseCommit = "a".repeat(40);
const candidateCommit = "b".repeat(40);
const createdAt = "2026-07-16T12:00:00.000Z";

function item(id: string, title = `Implement ${id}`): WorkItem {
  const acceptanceId = `${id}:AC-1`;
  return {
    schema_version: "2.0",
    id,
    title,
    objective: `Complete ${id}.`,
    dependencies: [],
    file_contract: [{ path: `src/${id}.ts`, permission: "modify", targets: [id] }],
    forbidden_changes: [],
    change_units: [{
      id: `${id}:CH-1`,
      path: `src/${id}.ts`,
      target: id,
      operation: "modify",
      requirements: [`Complete ${id}.`],
    }],
    acceptance: [{
      id: acceptanceId,
      statement: `${id} is complete.`,
      satisfied_by: [`${id}:CH-1`, `${id}:TEST-1`],
    }],
    tests: [{
      id: `${id}:TEST-1`,
      path: `tests/${id}.test.ts`,
      assertion: `${id} is verified.`,
      verification_command_ids: [`${id}:VERIFY-1`],
    }],
    verification_commands: [{
      id: `${id}:VERIFY-1`,
      argv: ["npm", "test", "--", `tests/${id}.test.ts`],
      expected_exit_code: 0,
    }],
    expected_artifacts: [],
    browser_checks: [],
    risks: [],
    completion_contract: {
      expected_changed_files: [`src/${id}.ts`],
      allow_additional_files: false,
      required_acceptance_ids: [acceptanceId],
    },
    ambiguity_policy: { default: "stop_and_report", stop_when: ["Evidence is ambiguous."] },
  };
}

const itemA = item("A");
const itemB = item("B");

interface Fixture {
  runDir: string;
  runId: string;
  planRevision: number;
  planSha256: string;
  summaryRefs: ArtifactRefV1[];
  integratedVerificationRef: ArtifactRefV1;
  finalReviewRef: ArtifactRefV1;
}

let root: string | null = null;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = null;
});

function approvedReview(workItem: WorkItem): VerifierReview {
  return {
    work_item_id: workItem.id,
    attempt: 1,
    final: false,
    decision: "approve",
    failure_class: "none",
    blocker: null,
    blocker_code: null,
    acceptance_coverage: [...workItem.completion_contract.required_acceptance_ids],
    evidence_reviewed: [],
    findings: [],
    residual_risks: [],
  };
}

async function persistCompletedSummary(
  runDir: string,
  runId: string,
  workItem: WorkItem,
  planRevision: number,
  planSha256: string,
): Promise<ArtifactRefV1> {
  const implementationRef = await writeImmutableValidatedJson(
    runDir,
    `implementation/${workItem.id}/attempt-1.json`,
    implementationResultSchema,
    {
      work_item_id: workItem.id,
      changed_files: [`src/${workItem.id}.ts`],
      tests_added_or_changed: [],
      commands_attempted: [],
      completed_steps: [`${workItem.id}:CH-1`],
      remaining_risks: [],
    },
  );
  const verificationPath = `verification/local/${workItem.id}/attempt-1/evidence.json`;
  const resultPath = `verification/local/${workItem.id}/attempt-1/result.json`;
  await writeImmutableValidatedJson(
    runDir,
    resultPath,
    verificationExecutionResultSchema,
    {
      argv: workItem.verification_commands[0]!.argv,
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
  const verificationRef = await writeImmutableValidatedJson(
    runDir,
    verificationPath,
    verificationEvidenceSchema,
    {
      verification_scope: "local",
      work_item_id: workItem.id,
      attempt: 1,
      evidence_path: verificationPath,
      commands: [{
        command: workItem.verification_commands[0]!.argv.join(" "),
        argv: workItem.verification_commands[0]!.argv,
        exit_code: 0,
        timed_out: false,
        error_code: null,
        error_message: null,
        signal: null,
        stdout_path: `verification/local/${workItem.id}/attempt-1/stdout.txt`,
        stderr_path: `verification/local/${workItem.id}/attempt-1/stderr.txt`,
        result_path: resultPath,
      }],
      artifacts: [],
      artifact_checks: [],
      browser_evidence: [],
      created_at: createdAt,
    },
  );
  const reviewPath = `reviews/${workItem.id}/attempt-1.json`;
  const reviewRef = await writeImmutableValidatedJson(
    runDir,
    reviewPath,
    persistedVerifierReviewSchema,
    { ...approvedReview(workItem), evidence_reviewed: [verificationPath] },
  );
  let manifest = await readManifestV2(runDir);
  await updateManifestV2(runDir, {
    work_item_progress: {
      ...manifest.work_item_progress,
      [workItem.id]: {
        status: "in_progress",
        attempts: 1,
        context_base_commit: baseCommit,
        context_plan_revision: planRevision,
        implementation_path: implementationRef.path,
        verification_path: verificationRef.path,
        review_path: reviewRef.path,
        review_revision: 1,
        commit_sha: candidateCommit,
      },
    },
  });
  const summaryRef = await persistWorkItemSummary({
    runDir,
    workItem,
    planRevision,
    planSha256,
    attempt: 1,
    baseCommit,
    commitSha: candidateCommit,
    completionBasis: "verifier_approve",
    implementationRef,
    verificationRef,
    reviewRef,
    policyDecisionRef: null,
    findingRevision: { reviewRevision: 1, findingIds: [] },
    createdAt,
  });
  manifest = await readManifestV2(runDir);
  await updateManifestV2(runDir, {
    work_item_progress: {
      ...manifest.work_item_progress,
      [workItem.id]: {
        ...manifest.work_item_progress[workItem.id],
        status: "complete",
        summary_path: summaryRef.path,
        summary_sha256: summaryRef.sha256,
      },
    },
  });
  expect((await readManifestV2(runDir)).run_id).toBe(runId);
  return summaryRef;
}

async function persistIntegratedAttempt(runDir: string, attempt: number): Promise<ArtifactRefV1> {
  const path = `verification/integrated/attempt-${attempt}/evidence.json`;
  const ref = await writeImmutableValidatedJson(runDir, path, verificationEvidenceSchema, {
    verification_scope: "integrated",
    work_item_id: "integrated",
    attempt,
    evidence_path: path,
    commands: [],
    artifacts: [],
    artifact_checks: [],
    browser_evidence: [],
    created_at: createdAt,
  });
  const manifest = await readManifestV2(runDir);
  await updateManifestV2(runDir, {
    work_item_progress: {
      ...manifest.work_item_progress,
      integrated: {
        ...manifest.work_item_progress.integrated,
        status: "in_progress",
        attempts: attempt,
        verification_path: path,
        review_revision: attempt,
        commit_sha: candidateCommit,
      },
    },
  });
  return ref;
}

async function createFixture(finalReviewOverrides: Partial<VerifierReview> = {}): Promise<Fixture> {
  root = await mkdtemp(join(tmpdir(), "brain-hands-evidence-index-"));
  const ledger = await createRunLedgerV2({
    repoRoot: root,
    originalRequest: "Build evidence indexes",
    sourceCommit: baseCommit,
    intake: { task: "Build evidence indexes", repo_root: root },
  });
  const plan = await recordPlan(ledger.runDir, JSON.stringify({ work_items: [itemA, itemB] }));
  await approvePlanRevision(ledger.runDir, plan.revision);
  const summaryRefs = [
    await persistCompletedSummary(ledger.runDir, ledger.runId, itemA, plan.revision, plan.sha256),
    await persistCompletedSummary(ledger.runDir, ledger.runId, itemB, plan.revision, plan.sha256),
  ];
  const integratedVerificationRef = await persistIntegratedAttempt(ledger.runDir, 1);
  const finalReviewPath = "reviews/integrated/final-attempt-1.json";
  const finalReviewRef = await writeImmutableValidatedJson(
    ledger.runDir,
    finalReviewPath,
    persistedVerifierReviewSchema,
    {
      work_item_id: "integrated",
      attempt: 1,
      final: true,
      decision: "approve",
      failure_class: "none",
      blocker: null,
      blocker_code: null,
      acceptance_coverage: [],
      evidence_reviewed: [integratedVerificationRef.path],
      findings: [],
      residual_risks: [],
      ...finalReviewOverrides,
    },
  );
  let manifest = await readManifestV2(ledger.runDir);
  await updateManifestV2(ledger.runDir, {
    workflow_protocol: "bounded-context-v1",
    work_item_progress: {
      ...manifest.work_item_progress,
      integrated: {
        ...manifest.work_item_progress.integrated,
        review_path: finalReviewPath,
      },
    },
    final_artifact_paths: [integratedVerificationRef.path, finalReviewPath],
  });
  return {
    runDir: ledger.runDir,
    runId: ledger.runId,
    planRevision: plan.revision,
    planSha256: plan.sha256,
    summaryRefs,
    integratedVerificationRef,
    finalReviewRef,
  };
}

function verifierInput(fixture: Fixture) {
  return {
    runDir: fixture.runDir,
    phase: "final_integrated" as const,
    attempt: 1,
    candidateCommit,
    workItemSummaryRefs: fixture.summaryRefs,
    integratedVerificationRef: fixture.integratedVerificationRef,
    createdAt,
  };
}

async function terminalize(
  fixture: Fixture,
  options: {
    assuranceOutcome?: "verified_ready" | "human_accepted" | "blocked" | "abandoned";
    terminalOutcome?: "delivered" | "human_accepted" | "abandoned" | "closed_blocked";
    assessmentCandidate?: string | null;
  } = {},
): Promise<void> {
  const assuranceOutcome = options.assuranceOutcome ?? "verified_ready";
  const terminalOutcome = options.terminalOutcome ?? "delivered";
  const assessmentPath = "assurance/final.json";
  await writeImmutableValidatedJson(fixture.runDir, assessmentPath, assuranceAssessmentSchema, {
    outcome: assuranceOutcome,
    assessed_at: createdAt,
    approved_plan_revision: fixture.planRevision,
    approved_plan_sha256: fixture.planSha256,
    candidate_commit: Object.prototype.hasOwnProperty.call(options, "assessmentCandidate")
      ? options.assessmentCandidate
      : candidateCommit,
    blocker_code: null,
    blocker: null,
    missing_evidence: [],
    invalid_evidence: [],
    zero_attempt_work_items: [],
    acceptance_path: null,
  });
  const manifest = await readManifestV2(fixture.runDir);
  await updateManifestV2(fixture.runDir, {
    delivery_state: terminalOutcome === "delivered" ? "ready" : terminalOutcome === "closed_blocked" ? "blocked" : "pending",
    assurance_outcome: assuranceOutcome,
    assurance_assessment_path: assessmentPath,
    work_item_progress: {
      ...manifest.work_item_progress,
      integrated: { ...manifest.work_item_progress.integrated, status: "complete" },
    },
  });
  await recordTerminalDisposition(fixture.runDir, {
    outcome: terminalOutcome,
    actor: terminalOutcome === "delivered" ? "runtime" : "human",
    reason: "All gates passed.",
    residual_risks: [],
    recorded_at: createdAt,
  });
}

describe("phase evidence indexes", () => {
  it("selects a verifier path only from the explicit phase", () => {
    expect(verifierEvidenceIndexPath("final_integrated", 2)).toBe(
      "evidence-indexes/verifier/final-integrated/attempt-2.json",
    );
    expect(verifierEvidenceIndexPath("post_pr", 2)).toBe(
      "evidence-indexes/verifier/post-pr/attempt-2.json",
    );
    expect(reflectionEvidenceIndexPath).toBe("evidence-indexes/reflection/final.json");
  });

  it("adopts a fully revalidated verifier index on timestamp-free replay", async () => {
    const fixture = await createFixture();
    const { createdAt: _createdAt, ...input } = verifierInput(fixture);
    const first = await buildVerifierEvidenceIndex(input);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await buildVerifierEvidenceIndex(input);
    expect(second).toEqual(first);
  });

  it("adopts a fully revalidated reflection index on timestamp-free replay", async () => {
    const fixture = await createFixture();
    await terminalize(fixture);
    const input = {
      runDir: fixture.runDir,
      attempt: 1,
      candidateCommit,
      workItemSummaryRefs: fixture.summaryRefs,
      integratedVerificationRef: fixture.integratedVerificationRef,
      finalReviewRef: fixture.finalReviewRef,
    };
    const first = await buildReflectionEvidenceIndex(input);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await buildReflectionEvidenceIndex(input);
    expect(second).toEqual(first);
  });

  it("rejects timestamp-free verifier replay with changed caller references", async () => {
    const fixture = await createFixture();
    const { createdAt: _createdAt, ...input } = verifierInput(fixture);
    await buildVerifierEvidenceIndex(input);
    await expect(buildVerifierEvidenceIndex({
      ...input,
      workItemSummaryRefs: [fixture.summaryRefs[0]!],
    })).rejects.toThrow(/replay.*summary references/i);
    await expect(buildVerifierEvidenceIndex({
      ...input,
      workItemSummaryRefs: [...fixture.summaryRefs].reverse(),
    })).rejects.toThrow(/replay.*summary references/i);
    await expect(buildVerifierEvidenceIndex({
      ...input,
      integratedVerificationRef: fixture.summaryRefs[0]!,
    })).rejects.toThrow(/replay.*integrated verification reference/i);
  });

  it("rejects timestamp-free reflection replay with a noncanonical final-review reference", async () => {
    const fixture = await createFixture();
    await terminalize(fixture);
    const input = {
      runDir: fixture.runDir,
      attempt: 1,
      candidateCommit,
      workItemSummaryRefs: fixture.summaryRefs,
      integratedVerificationRef: fixture.integratedVerificationRef,
      finalReviewRef: fixture.finalReviewRef,
    };
    await buildReflectionEvidenceIndex(input);
    await expect(buildReflectionEvidenceIndex({
      ...input,
      finalReviewRef: {
        ...fixture.finalReviewRef,
        path: "reviews/integrated/final-attempt-2.json",
      },
    })).rejects.toThrow(/replay.*final review reference/i);
  });

  it("rejects a missing summary for an approved item", async () => {
    const fixture = await createFixture();
    await expect(buildVerifierEvidenceIndex({
      ...verifierInput(fixture),
      workItemSummaryRefs: [fixture.summaryRefs[0]!],
    })).rejects.toThrow(/missing work-item summary.*B/i);
  });

  it("rejects a superseded summary when the current item contract changed", async () => {
    const fixture = await createFixture();
    const changedB = item("B", "Changed B contract");
    const plan2 = await recordPlan(fixture.runDir, JSON.stringify({ work_items: [itemA, changedB] }));
    await approvePlanRevision(fixture.runDir, plan2.revision);

    await expect(buildVerifierEvidenceIndex(verifierInput(fixture))).rejects.toThrow(
      /summary.*B.*current approved plan|contract/i,
    );
  });

  it("accepts an untouched historical summary after another item is replanned", async () => {
    const fixture = await createFixture();
    const changedB = item("B", "Changed B contract");
    const plan2 = await recordPlan(fixture.runDir, JSON.stringify({ work_items: [itemA, changedB] }));
    await approvePlanRevision(fixture.runDir, plan2.revision);
    const summaryB = await persistCompletedSummary(
      fixture.runDir,
      fixture.runId,
      changedB,
      plan2.revision,
      plan2.sha256,
    );

    const ref = await buildVerifierEvidenceIndex({
      ...verifierInput(fixture),
      workItemSummaryRefs: [fixture.summaryRefs[0]!, summaryB],
    });
    const loaded = await loadEvidenceIndex(fixture.runDir, ref, {
      phase: "final_integrated",
      attempt: 1,
      candidateCommit,
    });
    expect(loaded.work_item_summary_refs).toEqual([fixture.summaryRefs[0], summaryB]);
  });

  it("rejects duplicate item summaries", async () => {
    const fixture = await createFixture();
    await expect(buildVerifierEvidenceIndex({
      ...verifierInput(fixture),
      workItemSummaryRefs: [fixture.summaryRefs[0]!, fixture.summaryRefs[0]!],
    })).rejects.toThrow(/duplicate work-item summary.*A/i);
  });

  it("rejects summary references in the wrong approved-plan order", async () => {
    const fixture = await createFixture();
    await expect(buildVerifierEvidenceIndex({
      ...verifierInput(fixture),
      workItemSummaryRefs: [...fixture.summaryRefs].reverse(),
    })).rejects.toThrow(/approved-plan order/i);
  });

  it("rejects a candidate commit outside current integrated authority", async () => {
    const fixture = await createFixture();
    await expect(buildVerifierEvidenceIndex({
      ...verifierInput(fixture),
      candidateCommit: "c".repeat(40),
    })).rejects.toThrow(/candidate commit.*current integrated authority/i);
  });

  it("rejects stale integrated verification", async () => {
    const fixture = await createFixture();
    const ref = await buildVerifierEvidenceIndex(verifierInput(fixture));
    await persistIntegratedAttempt(fixture.runDir, 2);
    await expect(loadEvidenceIndex(fixture.runDir, ref, {
      phase: "final_integrated",
      attempt: 1,
      candidateCommit,
    })).rejects.toThrow(
      /integrated verification.*current durable authority/i,
    );
  });

  it("revalidates after an injected integrated mutation before immutable creation", async () => {
    const fixture = await createFixture();
    const path = verifierEvidenceIndexPath("final_integrated", 1);
    await expect(buildVerifierEvidenceIndex({
      ...verifierInput(fixture),
      hooks: {
        afterAuthorityValidated: async () => {
          await persistIntegratedAttempt(fixture.runDir, 2);
        },
      },
    })).rejects.toThrow(/integrated verification.*current durable authority/i);
    await expect(readFile(join(fixture.runDir, path), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not return an index after an injected mutation during load", async () => {
    const fixture = await createFixture();
    const ref = await buildVerifierEvidenceIndex(verifierInput(fixture));
    await expect(loadEvidenceIndex(fixture.runDir, ref, {
      phase: "final_integrated",
      attempt: 1,
      candidateCommit,
      hooks: {
        afterArtifactRead: async () => {
          await persistIntegratedAttempt(fixture.runDir, 2);
        },
      },
    })).rejects.toThrow(/integrated verification.*current durable authority/i);
  });

  it("serializes a queued progress mutation before build and creates no stale index", async () => {
    const fixture = await createFixture();
    const manifest = await readManifestV2(fixture.runDir);
    let release!: () => void;
    let locked!: () => void;
    const releaseGate = new Promise<void>((resolve) => { release = resolve; });
    const lockedGate = new Promise<void>((resolve) => { locked = resolve; });
    const holder = withRunLedgerTransaction(fixture.runDir, async () => {
      locked();
      await releaseGate;
    });
    await lockedGate;
    const mutation = updateManifestV2(fixture.runDir, {
      work_item_progress: {
        ...manifest.work_item_progress,
        integrated: {
          ...manifest.work_item_progress.integrated,
          attempts: 2,
          verification_path: "verification/integrated/attempt-2/evidence.json",
        },
      },
    });
    const build = buildVerifierEvidenceIndex(verifierInput(fixture));
    release();
    await holder;
    await mutation;
    await expect(build).rejects.toThrow(/integrated verification.*current durable authority/i);
    await expect(readFile(
      join(fixture.runDir, verifierEvidenceIndexPath("final_integrated", 1)),
      "utf8",
    )).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("revalidates an injected replan before immutable creation", async () => {
    const fixture = await createFixture();
    await expect(buildVerifierEvidenceIndex({
      ...verifierInput(fixture),
      hooks: {
        afterAuthorityValidated: async () => {
          const plan2 = await recordPlan(
            fixture.runDir,
            JSON.stringify({ work_items: [itemA, item("B", "Changed B contract")] }),
          );
          await approvePlanRevision(fixture.runDir, plan2.revision);
        },
      },
    })).rejects.toThrow(/summary.*B.*current approved plan|contract/i);
    await expect(readFile(
      join(fixture.runDir, verifierEvidenceIndexPath("final_integrated", 1)),
      "utf8",
    )).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an index missing an active finding reference", async () => {
    const fixture = await createFixture();
    await recordFindingRevision(fixture.runDir, {
      work_item_id: "integrated",
      source: "verifier",
      severity: "high",
      disposition: "blocking",
      criterion_ref: "BH-001:AC-1",
      normalized_location: "src/A.ts:1",
      problem_class: "correctness",
      problem: "Integrated behavior regressed.",
      required_fix: "Restore integrated behavior.",
      evidence_refs: [fixture.integratedVerificationRef.path],
      review_revision: 1,
    });
    const currentRef = await buildVerifierEvidenceIndex({
      ...verifierInput(fixture),
      phase: "post_pr",
    });
    const current = await loadEvidenceIndex(fixture.runDir, currentRef, {
      phase: "post_pr",
      attempt: 1,
      candidateCommit,
    });
    expect(current.unresolved_finding_refs).toHaveLength(1);
    expect(current.unresolved_finding_refs[0]?.path).toMatch(/^findings\/work-item-/);
    const manifest = await readManifestV2(fixture.runDir);
    const plan = manifest.plan_revisions[String(fixture.planRevision)]!;
    const invalid = evidenceIndexV1Schema.parse({
      schema_version: 1,
      run_id: fixture.runId,
      phase: "final_integrated",
      attempt: 1,
      approved_plan_ref: { path: `plans/revision-${fixture.planRevision}.md`, sha256: plan.sha256 },
      candidate_commit: candidateCommit,
      work_item_summary_refs: fixture.summaryRefs,
      integrated_verification_ref: fixture.integratedVerificationRef,
      unresolved_finding_refs: [],
      final_review_ref: null,
      terminal: null,
      created_at: createdAt,
    });
    const ref = await writeImmutableValidatedJson(
      fixture.runDir,
      verifierEvidenceIndexPath("final_integrated", 1),
      evidenceIndexV1Schema,
      invalid,
    );

    await expect(loadEvidenceIndex(fixture.runDir, ref, {
      phase: "final_integrated",
      attempt: 1,
      candidateCommit,
    })).rejects.toThrow(/active finding reference/i);
    expect(await readFile(findingHistoryPath(fixture.runDir, "integrated"), "utf8")).toContain(
      "Integrated behavior regressed",
    );
  });

  it("accepts indexed findings resolved only by the matching terminal review", async () => {
    const fixture = await createFixture();
    await recordFindingRevision(fixture.runDir, {
      work_item_id: "integrated",
      source: "verifier",
      severity: "high",
      disposition: "blocking",
      criterion_ref: "BH-001:AC-1",
      normalized_location: "src/A.ts:1",
      problem_class: "correctness",
      problem: "Integrated behavior regressed.",
      required_fix: "Restore integrated behavior.",
      evidence_refs: [fixture.integratedVerificationRef.path],
      review_revision: 1,
    });
    const ref = await buildVerifierEvidenceIndex(verifierInput(fixture));
    const manifest = await readManifestV2(fixture.runDir);
    await updateManifestV2(fixture.runDir, {
      work_item_progress: {
        ...manifest.work_item_progress,
        integrated: { ...manifest.work_item_progress.integrated!, review_revision: 2 },
      },
    });

    const loaded = await loadEvidenceIndex(fixture.runDir, ref, {
      phase: "final_integrated",
      attempt: 1,
      candidateCommit,
      findingValidation: { mode: "post_review", finalReviewRef: fixture.finalReviewRef },
    });

    expect(loaded.unresolved_finding_refs).toHaveLength(1);
  });

  it("rejects tampering of indexed finding history after terminal review", async () => {
    const fixture = await createFixture();
    await recordFindingRevision(fixture.runDir, {
      work_item_id: "integrated",
      source: "verifier",
      severity: "high",
      disposition: "blocking",
      criterion_ref: "BH-001:AC-1",
      normalized_location: "src/A.ts:1",
      problem_class: "correctness",
      problem: "Integrated behavior regressed.",
      required_fix: "Restore integrated behavior.",
      evidence_refs: [fixture.integratedVerificationRef.path],
      review_revision: 1,
    });
    const ref = await buildVerifierEvidenceIndex(verifierInput(fixture));
    const manifest = await readManifestV2(fixture.runDir);
    await updateManifestV2(fixture.runDir, {
      work_item_progress: {
        ...manifest.work_item_progress,
        integrated: { ...manifest.work_item_progress.integrated!, review_revision: 2 },
      },
    });
    await writeFile(findingHistoryPath(fixture.runDir, "integrated"), "tampered\n", { flag: "a" });

    await expect(loadEvidenceIndex(fixture.runDir, ref, {
      phase: "final_integrated",
      attempt: 1,
      candidateCommit,
      findingValidation: { mode: "post_review", finalReviewRef: fixture.finalReviewRef },
    })).rejects.toThrow(/finding|hash|reference/i);
  });

  it("rejects a new unresolved finding from the matching terminal review", async () => {
    const fixture = await createFixture();
    const finding = {
      work_item_id: "integrated",
      source: "verifier" as const,
      severity: "high" as const,
      disposition: "blocking" as const,
      criterion_ref: "BH-001:AC-1",
      normalized_location: "src/A.ts:1",
      problem_class: "correctness",
      problem: "Integrated behavior regressed.",
      required_fix: "Restore integrated behavior.",
      evidence_refs: [fixture.integratedVerificationRef.path],
    };
    await recordFindingRevision(fixture.runDir, { ...finding, review_revision: 1 });
    const ref = await buildVerifierEvidenceIndex(verifierInput(fixture));
    await recordFindingRevision(fixture.runDir, { ...finding, review_revision: 2 });
    const manifest = await readManifestV2(fixture.runDir);
    await updateManifestV2(fixture.runDir, {
      work_item_progress: {
        ...manifest.work_item_progress,
        integrated: { ...manifest.work_item_progress.integrated!, review_revision: 2 },
      },
    });

    await expect(loadEvidenceIndex(fixture.runDir, ref, {
      phase: "final_integrated",
      attempt: 1,
      candidateCommit,
      findingValidation: { mode: "post_review", finalReviewRef: fixture.finalReviewRef },
    })).rejects.toThrow(/finding|stale|reference/i);
  });

  it("rejects unresolved finding authority without a current progress revision", async () => {
    const fixture = await createFixture();
    await recordFindingRevision(fixture.runDir, {
      work_item_id: "integrated",
      source: "verifier",
      severity: "high",
      disposition: "blocking",
      criterion_ref: "BH-001:AC-1",
      normalized_location: "src/A.ts:1",
      problem_class: "correctness",
      problem: "Integrated behavior regressed.",
      required_fix: "Restore integrated behavior.",
      evidence_refs: [fixture.integratedVerificationRef.path],
      review_revision: 1,
    });
    const manifest = await readManifestV2(fixture.runDir);
    const { review_revision: _reviewRevision, ...integrated } = manifest.work_item_progress.integrated!;
    await updateManifestV2(fixture.runDir, {
      work_item_progress: { ...manifest.work_item_progress, integrated },
    });

    await expect(buildVerifierEvidenceIndex(verifierInput(fixture))).rejects.toThrow(
      /unresolved finding.*current.*review revision/i,
    );
  });

  it("rejects a current finding append injected after authority validation", async () => {
    const fixture = await createFixture();
    const finding = {
      work_item_id: "integrated",
      source: "verifier" as const,
      severity: "high" as const,
      disposition: "blocking" as const,
      criterion_ref: "BH-001:AC-1",
      normalized_location: "src/A.ts:1",
      problem_class: "correctness",
      problem: "Integrated behavior regressed.",
      required_fix: "Restore integrated behavior.",
      evidence_refs: [fixture.integratedVerificationRef.path],
    };
    await recordFindingRevision(fixture.runDir, { ...finding, review_revision: 1 });
    await expect(buildVerifierEvidenceIndex({
      ...verifierInput(fixture),
      hooks: {
        afterAuthorityValidated: async () => {
          await recordFindingRevision(fixture.runDir, { ...finding, review_revision: 2 });
        },
      },
    })).rejects.toThrow(/older than the current durable finding history/i);
    await expect(readFile(
      join(fixture.runDir, verifierEvidenceIndexPath("final_integrated", 1)),
      "utf8",
    )).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a final-integrated index containing a final review", async () => {
    const fixture = await createFixture();
    const manifest = await readManifestV2(fixture.runDir);
    const plan = manifest.plan_revisions[String(fixture.planRevision)]!;
    const path = verifierEvidenceIndexPath("final_integrated", 1);
    const raw = {
      schema_version: 1,
      run_id: fixture.runId,
      phase: "final_integrated",
      attempt: 1,
      approved_plan_ref: { path: `plans/revision-${fixture.planRevision}.md`, sha256: plan.sha256 },
      candidate_commit: candidateCommit,
      work_item_summary_refs: fixture.summaryRefs,
      integrated_verification_ref: fixture.integratedVerificationRef,
      unresolved_finding_refs: [],
      final_review_ref: fixture.finalReviewRef,
      terminal: null,
      created_at: createdAt,
    };
    const bytes = Buffer.from(`${JSON.stringify(raw, null, 2)}\n`);
    await mkdir(join(fixture.runDir, "evidence-indexes/verifier/final-integrated"), { recursive: true });
    await writeFile(join(fixture.runDir, path), bytes);

    await expect(loadEvidenceIndex(
      fixture.runDir,
      artifactRefFromBytes(path, bytes),
      { phase: "final_integrated", attempt: 1, candidateCommit },
    )).rejects.toThrow();
  });

  it("rejects reflection without the exact terminal review", async () => {
    const fixture = await createFixture();
    await terminalize(fixture);
    await expect(buildReflectionEvidenceIndex({
      runDir: fixture.runDir,
      attempt: 1,
      candidateCommit,
      workItemSummaryRefs: fixture.summaryRefs,
      integratedVerificationRef: fixture.integratedVerificationRef,
      finalReviewRef: fixture.summaryRefs[0]!,
      createdAt,
    })).rejects.toThrow(/final review.*current durable authority/i);
  });

  it("rejects a non-approving final review for delivered verified reflection", async () => {
    const fixture = await createFixture({
      decision: "request_changes",
      failure_class: "implementation_failure",
      acceptance_coverage: [],
      findings: [{
        severity: "high",
        file: "src/A.ts",
        line: 1,
        acceptance_criterion: "BH-001:AC-1",
        problem: "Integrated behavior regressed.",
        required_fix: "Restore it.",
        re_verification: [["npm", "test"]],
      }],
    });
    await terminalize(fixture);
    await expect(buildReflectionEvidenceIndex({
      runDir: fixture.runDir,
      attempt: 1,
      candidateCommit,
      workItemSummaryRefs: fixture.summaryRefs,
      integratedVerificationRef: fixture.integratedVerificationRef,
      finalReviewRef: fixture.finalReviewRef,
      createdAt,
    })).rejects.toThrow(/final review.*approve/i);
  });

  it("rejects an incompatible terminal and assurance pair", async () => {
    const fixture = await createFixture();
    await terminalize(fixture, { assuranceOutcome: "human_accepted", terminalOutcome: "delivered" });
    await expect(buildReflectionEvidenceIndex({
      runDir: fixture.runDir,
      attempt: 1,
      candidateCommit,
      workItemSummaryRefs: fixture.summaryRefs,
      integratedVerificationRef: fixture.integratedVerificationRef,
      finalReviewRef: fixture.finalReviewRef,
      createdAt,
    })).rejects.toThrow(/terminal.*assurance.*incompatible/i);
  });

  it("builds and loads closed-blocked reflection with an exact failing final review", async () => {
    const fixture = await createFixture({
      decision: "request_changes",
      failure_class: "implementation_failure",
      acceptance_coverage: [],
      findings: [{
        severity: "high",
        file: "src/A.ts",
        line: 1,
        acceptance_criterion: "BH-001:AC-1",
        problem: "Integrated behavior regressed.",
        required_fix: "Restore it.",
        re_verification: [["npm", "test"]],
      }],
    });
    await terminalize(fixture, { assuranceOutcome: "blocked", terminalOutcome: "closed_blocked" });
    const ref = await buildReflectionEvidenceIndex({
      runDir: fixture.runDir,
      attempt: 1,
      candidateCommit,
      workItemSummaryRefs: fixture.summaryRefs,
      integratedVerificationRef: fixture.integratedVerificationRef,
      finalReviewRef: fixture.finalReviewRef,
      createdAt,
    });
    const loaded = await loadEvidenceIndex(fixture.runDir, ref, {
      phase: "reflection",
      attempt: 1,
      candidateCommit,
    });
    expect(loaded.phase).toBe("reflection");
    expect(loaded.terminal?.outcome).toBe("closed_blocked");
  });

  it("builds and loads abandoned reflection with a null assessment candidate", async () => {
    const fixture = await createFixture({
      decision: "blocked",
      failure_class: "operational_blocker",
      blocker: "The operator abandoned the run.",
      blocker_code: "permission_failure",
      acceptance_coverage: [],
      findings: [],
    });
    await terminalize(fixture, {
      assuranceOutcome: "abandoned",
      terminalOutcome: "abandoned",
      assessmentCandidate: null,
    });
    const ref = await buildReflectionEvidenceIndex({
      runDir: fixture.runDir,
      attempt: 1,
      candidateCommit,
      workItemSummaryRefs: fixture.summaryRefs,
      integratedVerificationRef: fixture.integratedVerificationRef,
      finalReviewRef: fixture.finalReviewRef,
      createdAt,
    });
    const loaded = await loadEvidenceIndex(fixture.runDir, ref, {
      phase: "reflection",
      attempt: 1,
      candidateCommit,
    });
    expect(loaded.phase).toBe("reflection");
    if (loaded.phase === "reflection") {
      expect(loaded.terminal.outcome).toBe("abandoned");
      expect(loaded.assurance.outcome).toBe("abandoned");
    }
  });

  it("rejects incompatible reflection authority again on load", async () => {
    const fixture = await createFixture({
      decision: "request_changes",
      failure_class: "implementation_failure",
      acceptance_coverage: [],
      findings: [{
        severity: "high",
        file: "src/A.ts",
        line: 1,
        acceptance_criterion: "BH-001:AC-1",
        problem: "Integrated behavior regressed.",
        required_fix: "Restore it.",
        re_verification: [["npm", "test"]],
      }],
    });
    await terminalize(fixture);
    const manifest = await readManifestV2(fixture.runDir);
    const plan = manifest.plan_revisions[String(fixture.planRevision)]!;
    const assessmentBytes = await readFile(join(fixture.runDir, "assurance/final.json"));
    const invalid = evidenceIndexV1Schema.parse({
      schema_version: 1,
      run_id: fixture.runId,
      phase: "reflection",
      attempt: 1,
      approved_plan_ref: { path: `plans/revision-${fixture.planRevision}.md`, sha256: plan.sha256 },
      candidate_commit: candidateCommit,
      work_item_summary_refs: fixture.summaryRefs,
      integrated_verification_ref: fixture.integratedVerificationRef,
      unresolved_finding_refs: [],
      final_review_ref: fixture.finalReviewRef,
      terminal: manifest.terminal,
      assurance: {
        outcome: "verified_ready",
        assessment_ref: artifactRefFromBytes("assurance/final.json", assessmentBytes),
      },
      created_at: createdAt,
    });
    const ref = await writeImmutableValidatedJson(
      fixture.runDir,
      reflectionEvidenceIndexPath,
      evidenceIndexV1Schema,
      invalid,
    );
    await expect(loadEvidenceIndex(fixture.runDir, ref, {
      phase: "reflection",
      attempt: 1,
      candidateCommit,
    })).rejects.toThrow(/final review.*approve/i);
  });

  it("builds and reloads exact verifier and reflection indexes", async () => {
    const fixture = await createFixture();
    const verifierRef = await buildVerifierEvidenceIndex(verifierInput(fixture));
    expect(verifierRef.path).toBe(verifierEvidenceIndexPath("final_integrated", 1));
    expect((await loadEvidenceIndex(fixture.runDir, verifierRef, {
      phase: "final_integrated",
      attempt: 1,
      candidateCommit,
    })).work_item_summary_refs).toEqual(fixture.summaryRefs);

    await terminalize(fixture);
    const reflectionRef = await buildReflectionEvidenceIndex({
      runDir: fixture.runDir,
      attempt: 1,
      candidateCommit,
      workItemSummaryRefs: fixture.summaryRefs,
      integratedVerificationRef: fixture.integratedVerificationRef,
      finalReviewRef: fixture.finalReviewRef,
      createdAt,
    });
    const reflection = await loadEvidenceIndex(fixture.runDir, reflectionRef, {
      phase: "reflection",
      attempt: 1,
      candidateCommit,
    });
    expect(reflection.phase).toBe("reflection");
    if (reflection.phase === "reflection") {
      expect(reflection.final_review_ref).toEqual(fixture.finalReviewRef);
      expect(reflection.assurance.outcome).toBe("verified_ready");
      expect(reflection.assurance.assessment_ref?.path).toBe("assurance/final.json");
    }
  });
});
