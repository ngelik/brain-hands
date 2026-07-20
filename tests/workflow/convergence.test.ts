import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  approvePlanRevision,
  readManifestV2,
  recordPlan,
  updateManifestV2,
} from "../../src/core/ledger.js";
import { createLegacyRunLedgerV2 } from "../fixtures/legacy-run.js";
import { convergenceReportSchema } from "../../src/core/schema.js";
import { verificationIdentityDirectory } from "../../src/core/types.js";
import type { ReviewCycleState, ReviewPolicyDecision } from "../../src/core/types.js";
import { recordFindingRevision } from "../../src/workflow/findings.js";
import {
  beginReviewCycle,
  claimReviewEffect,
  completeReviewEffect,
  incrementSuccessfulFix,
} from "../../src/workflow/review-cycle.js";
import {
  convergenceReportPath,
  loadCurrentCycleEvidence,
  writeConvergenceReport,
  type WriteConvergenceReportInput,
} from "../../src/workflow/convergence.js";

const plan = {
  summary: "Converge",
  assumptions: [],
  research: [],
  research_sources: ["repo"],
  architecture: "local",
  risks: [],
  work_items: [{
    id: "item/with spaces",
    title: "Converge",
    objective: "Converge",
    acceptance_criteria: ["The item converges"],
    dependencies: [],
    implementation_instructions: ["Implement"],
    verification_commands: [["npm", "test"]],
    files_expected_to_change: ["src/item.ts"],
  }],
  integration_verification: [["npm", "test"]],
};

let root: string | undefined;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

async function persistCycleEvidence(runDir: string, workItemId: string, attempt: number) {
  const safeId = workItemId.replace(/[^a-zA-Z0-9._-]/g, "_");
  const reviewPath = `reviews/${safeId}/attempt-${attempt}.json`;
  const verificationIdentity = { scope: "local" as const, work_item_id: workItemId };
  const verificationPath = `${verificationIdentityDirectory(verificationIdentity)}/attempt-${attempt}/evidence.json`;
  await mkdir(join(runDir, `reviews/${safeId}`), { recursive: true });
  await mkdir(join(runDir, verificationIdentityDirectory(verificationIdentity), `attempt-${attempt}`), { recursive: true });
  await writeFile(join(runDir, reviewPath), `${JSON.stringify({
    work_item_id: workItemId,
    attempt,
    final: false,
    decision: "approve",
    failure_class: "none",
    blocker: null,
    blocker_code: null,
    acceptance_coverage: [],
    evidence_reviewed: [verificationPath],
    findings: [],
    residual_risks: [],
  })}\n`);
  await writeFile(join(runDir, verificationPath), `${JSON.stringify({
    verification_scope: "local",
    work_item_id: workItemId,
    attempt,
    evidence_path: verificationPath,
    commands: [],
    artifacts: [],
    artifact_checks: [],
    browser_evidence: [],
    created_at: "2026-07-11T12:00:00.000Z",
  })}\n`);
  return { attempts: attempt, review_path: reviewPath, verification_path: verificationPath };
}

async function exhaustedInput(): Promise<WriteConvergenceReportInput> {
  root = await mkdtemp(join(tmpdir(), "brain-hands-convergence-"));
  const ledger = await createLegacyRunLedgerV2({
    repoRoot: root,
    originalRequest: "Converge safely",
    intake: {
      task: "Converge safely",
      repo_root: root,
      mode: "local",
      research: false,
      reflection: false,
      review_policy: { max_fix_cycles: 3 },
    },
  });
  const revision = await recordPlan(ledger.runDir, `${JSON.stringify(plan)}\n`);
  await approvePlanRevision(ledger.runDir, revision.revision, { actor: "test" });
  let manifest = await readManifestV2(ledger.runDir);
  const findingInput = (reviewRevision: number) => ({
    work_item_id: "item/with spaces",
    source: "verifier" as const,
    severity: "medium" as const,
    disposition: "fix_in_scope" as const,
    criterion_ref: "BH-001:AC-1",
    normalized_location: "src/item.ts",
    problem_class: "correctness",
    problem: "Still broken",
    required_fix: "Fix it",
    evidence_refs: [`${verificationIdentityDirectory({ scope: "local", work_item_id: "item/with spaces" })}/attempt-${reviewRevision}/evidence.json`],
    review_revision: reviewRevision,
  });
  let finding = await recordFindingRevision(ledger.runDir, findingInput(1));
  for (let reviewRevision = 1; reviewRevision <= 3; reviewRevision += 1) {
    if (reviewRevision > 1) finding = await recordFindingRevision(ledger.runDir, findingInput(reviewRevision));
    manifest = await readManifestV2(ledger.runDir);
    const cycle = await beginReviewCycle({
      run_dir: ledger.runDir,
      work_item_id: finding.work_item_id,
      phase: "work_item",
      review_revision: reviewRevision,
      policy_hash: createHash("sha256").update(JSON.stringify(manifest.review_policy_snapshot)).digest("hex"),
      finding_ids: [finding.finding_id],
      accounting_before: manifest.review_accounting!,
      evaluate: () => ({
        action: "fix",
        reason_code: "fix_budget_available",
        finding_ids: [finding.finding_id],
        policy_revision: manifest.review_policy_snapshot!.policy_revision,
        authorization_required: false,
      }),
    });
    const implementationPath = `implementation/item_with_spaces/attempt-${reviewRevision + 1}.json`;
    await mkdir(join(ledger.runDir, "implementation/item_with_spaces"), { recursive: true });
    await writeFile(join(ledger.runDir, implementationPath), "{}\n");
    await claimReviewEffect({ run_dir: ledger.runDir, cycle, owner: "test" });
    await completeReviewEffect({
      run_dir: ledger.runDir,
      cycle,
      owner: "test",
      outcome: "complete",
      result: { attempt: reviewRevision + 1, implementation_path: implementationPath },
    });
    await incrementSuccessfulFix({
      run_dir: ledger.runDir,
      cycle,
      owner: "test",
      mutation_id: implementationPath,
      kind: "successful_fix",
      effect_action: "fix",
    });
  }
  finding = await recordFindingRevision(ledger.runDir, findingInput(4));
  manifest = await readManifestV2(ledger.runDir);
  const terminalReference = await persistCycleEvidence(ledger.runDir, finding.work_item_id, 4);
  await updateManifestV2(ledger.runDir, {
    current_work_item_id: finding.work_item_id,
    work_item_progress: {
      [finding.work_item_id]: {
        status: "in_progress",
        attempts: terminalReference.attempts,
        review_path: terminalReference.review_path,
        verification_path: terminalReference.verification_path,
      },
    },
  });
  manifest = await readManifestV2(ledger.runDir);
  const decision: ReviewPolicyDecision = {
    action: "create_replan",
    reason_code: "fix_limit_reached",
    finding_ids: [finding.finding_id],
    policy_revision: manifest.review_policy_snapshot!.policy_revision,
    authorization_required: false,
  };
  const cycle = await beginReviewCycle({
    run_dir: ledger.runDir,
    work_item_id: finding.work_item_id,
    phase: "work_item",
    review_revision: 4,
    policy_hash: createHash("sha256").update(JSON.stringify(manifest.review_policy_snapshot)).digest("hex"),
    finding_ids: [finding.finding_id],
    accounting_before: manifest.review_accounting!,
    work_item_progress_reference: terminalReference,
    evaluate: () => decision,
  });
  manifest = await readManifestV2(ledger.runDir);
  return {
    run_dir: ledger.runDir,
    cycle,
    policy: manifest.review_policy_snapshot!,
    accounting: manifest.review_accounting!,
    finding_index: manifest.finding_index!,
    findings: [finding],
    release_guards: manifest.release_guards!,
    authorization: null,
  };
}

function changedDecision(cycle: ReviewCycleState): ReviewCycleState {
  return {
    ...cycle,
    decision: { ...cycle.decision, action: "stop" },
  };
}

describe("writeConvergenceReport", () => {
  it("loads current strict review findings without legacy re_verification", async () => {
    const input = await exhaustedInput();
    const reference = input.cycle.work_item_progress_reference!;
    await writeFile(join(input.run_dir, reference.review_path), `${JSON.stringify({
      work_item_id: input.cycle.work_item_id,
      attempt: reference.attempts,
      final: false,
      decision: "replan_required",
      failure_class: "replan_required",
      blocker: null,
      blocker_code: null,
      acceptance_coverage: [],
      evidence_reviewed: [reference.verification_path],
      findings: [{
        severity: "medium",
        file: "src/item.ts",
        line: null,
        acceptance_criterion: "BH-001:AC-1",
        problem_class: "correctness",
        problem: "The current strict review still requires a replan.",
        required_fix: "Revise the approved work item.",
        evidence_refs: [reference.verification_path],
        action_id: "R4-A1",
        order: 1,
        depends_on: [],
      }],
      residual_risks: [],
    })}\n`);

    await expect(loadCurrentCycleEvidence(input.run_dir, input.cycle)).resolves.toEqual([
      reference.review_path,
      reference.verification_path,
    ]);
  });

  it("accepts an immutable resumed Verifier artifact for the same work item and attempt", async () => {
    const input = await exhaustedInput();
    const reference = input.cycle.work_item_progress_reference!;
    const resumedPath = reference.review_path.replace(/\.json$/, "-resume-2.json");
    await writeFile(join(input.run_dir, resumedPath), await readFile(join(input.run_dir, reference.review_path)));

    await expect(loadCurrentCycleEvidence(input.run_dir, {
      ...input.cycle,
      work_item_progress_reference: { ...reference, review_path: resumedPath },
    })).resolves.toEqual([resumedPath, reference.verification_path]);
  });

  it("accepts legacy bounded reviews that name owned command evidence from the canonical attempt", async () => {
    const input = await exhaustedInput();
    const reference = input.cycle.work_item_progress_reference!;
    const reviewPath = join(input.run_dir, reference.review_path);
    const persisted = JSON.parse(await readFile(reviewPath, "utf8")) as Record<string, unknown>;
    await writeFile(reviewPath, `${JSON.stringify({
      ...persisted,
      evidence_reviewed: [`${dirname(reference.verification_path)}/command-1.json`],
    })}\n`);

    await expect(loadCurrentCycleEvidence(input.run_dir, input.cycle)).resolves.toEqual([
      reference.review_path,
      reference.verification_path,
    ]);
  });

  it("rejects a resumed Verifier artifact outside the owned attempt namespace", async () => {
    const input = await exhaustedInput();
    const reference = input.cycle.work_item_progress_reference!;

    await expect(loadCurrentCycleEvidence(input.run_dir, {
      ...input.cycle,
      work_item_progress_reference: {
        ...reference,
        review_path: `reviews/item_with_spaces/attempt-${reference.attempts + 1}-resume-2.json`,
      },
    })).rejects.toThrow("Cycle-owned review path");
  });

  it("records exhausted convergence without rewriting history", async () => {
    const input = await exhaustedInput();
    const path = await writeConvergenceReport(input);
    const report = convergenceReportSchema.parse(JSON.parse(await readFile(path, "utf8")));

    expect(report).toMatchObject({
      policy_revision: 2,
      max_fix_cycles: 3,
      plan_revision: 1,
      review_revision: 4,
      fix_cycles_used: 3,
      unresolved_finding_ids: [input.findings[0]!.finding_id],
      resolved_finding_ids: [],
      repeated_finding_ids: [input.findings[0]!.finding_id],
      advisory_finding_ids: [],
      follow_up_finding_ids: [],
      evidence_refs: [
        "implementation/item_with_spaces/attempt-2.json",
        "implementation/item_with_spaces/attempt-3.json",
        "implementation/item_with_spaces/attempt-4.json",
        "reviews/item_with_spaces/attempt-4.json",
        `${verificationIdentityDirectory({ scope: "local", work_item_id: "item/with spaces" })}/attempt-4/evidence.json`,
      ],
      remaining_release_guards: [],
      authorization: null,
      recommended_action: "create_replan",
    });
    expect(relative(input.run_dir, path)).toBe(convergenceReportPath("item/with spaces", 1, 4));

    expect(await writeConvergenceReport(input)).toBe(path);
    await expect(writeConvergenceReport({ ...input, cycle: changedDecision(input.cycle) }))
      .rejects.toThrow(/already exists|provenance/i);
  });

  it("classifies resolved, repeated, advisory, follow-up, and guard findings exactly", async () => {
    const input = await exhaustedInput();
    const resolved = await recordFindingRevision(input.run_dir, {
      work_item_id: input.cycle.work_item_id,
      source: "verifier",
      severity: "medium",
      disposition: "fix_in_scope",
      criterion_ref: "BH-001:AC-1",
      normalized_location: "src/resolved.ts",
      problem_class: "correctness",
      problem: "Was broken",
      required_fix: "Fix it",
      evidence_refs: ["verification/resolved.json"],
      review_revision: 4,
    });
    const active = await recordFindingRevision(input.run_dir, {
      work_item_id: input.findings[0]!.work_item_id,
      source: input.findings[0]!.source,
      severity: input.findings[0]!.severity,
      disposition: input.findings[0]!.disposition,
      criterion_ref: input.findings[0]!.criterion_ref,
      normalized_location: input.findings[0]!.normalized_location,
      problem_class: input.findings[0]!.problem_class,
      problem: input.findings[0]!.problem,
      required_fix: input.findings[0]!.required_fix,
      evidence_refs: input.findings[0]!.evidence_refs,
      review_revision: 5,
    });
    const advisory = await recordFindingRevision(input.run_dir, {
      work_item_id: active.work_item_id,
      source: "verifier",
      severity: "low",
      disposition: "advisory",
      criterion_ref: "BH-001:AC-1",
      normalized_location: "src/advisory.ts",
      problem_class: "maintainability",
      problem: "Optional cleanup",
      required_fix: null,
      evidence_refs: ["verification/advisory.json"],
      review_revision: 5,
    });
    const guard = await recordFindingRevision(input.run_dir, {
      work_item_id: active.work_item_id,
      source: "release_guard",
      severity: "medium",
      disposition: "blocking",
      criterion_ref: "release:required-verification",
      normalized_location: "release:required-verification",
      problem_class: "release_guard",
      problem: "Required verification remains",
      required_fix: "Run verification",
      evidence_refs: ["verification/guard.json"],
      review_revision: 5,
    });
    const followUp = await recordFindingRevision(input.run_dir, {
      work_item_id: active.work_item_id,
      source: "verifier",
      severity: "low",
      disposition: "follow_up",
      criterion_ref: "BH-001:AC-1",
      normalized_location: "src/follow-up.ts",
      problem_class: "maintainability",
      problem: "Deferred cleanup",
      required_fix: null,
      evidence_refs: ["verification/follow-up.json"],
      review_revision: 5,
    });
    const findings = [active, advisory, followUp, guard].sort((a, b) => a.finding_id.localeCompare(b.finding_id));
    const findingIndex = (await readManifestV2(input.run_dir)).finding_index!;
    const before = (await readManifestV2(input.run_dir)).review_accounting!;
    const reference = await persistCycleEvidence(input.run_dir, active.work_item_id, 5);
    await updateManifestV2(input.run_dir, {
      current_work_item_id: active.work_item_id,
      work_item_progress: {
        [active.work_item_id]: {
          status: "in_progress",
          attempts: reference.attempts,
          review_path: reference.review_path,
          verification_path: reference.verification_path,
        },
      },
    });
    const cycle = await beginReviewCycle({
      run_dir: input.run_dir,
      work_item_id: active.work_item_id,
      phase: "work_item",
      review_revision: 5,
      policy_hash: createHash("sha256").update(JSON.stringify(input.policy)).digest("hex"),
      finding_ids: findings.map((finding) => finding.finding_id),
      accounting_before: before,
      work_item_progress_reference: reference,
      evaluate: () => ({
        action: "create_replan",
        reason_code: "fix_limit_reached",
        finding_ids: findings.map((finding) => finding.finding_id),
        policy_revision: input.policy.policy_revision,
        authorization_required: false,
      }),
    });
    const accounting = (await readManifestV2(input.run_dir)).review_accounting!;

    const path = await writeConvergenceReport({
      ...input,
      cycle,
      accounting,
      finding_index: findingIndex,
      findings,
      authorization: null,
    });
    const report = convergenceReportSchema.parse(JSON.parse(await readFile(path, "utf8")));
    expect(report.resolved_finding_ids).toEqual([resolved.finding_id]);
    expect(report.repeated_finding_ids).toEqual([active.finding_id]);
    expect(report.advisory_finding_ids).toEqual([advisory.finding_id]);
    expect(report.follow_up_finding_ids).toEqual([followUp.finding_id]);
    expect(report.remaining_release_guards).toEqual(["release:required-verification"]);
    expect(report.authorization).toBeNull();
    expect(report.recommended_action).toBe("create_replan");
  });

  it("rejects authorization until Task 13 persists an authoritative artifact", async () => {
    const input = await exhaustedInput();
    await expect(writeConvergenceReport({
      ...input,
      authorization: {
        actor: "release-manager",
        source: "run_override",
        finding_ids: [input.findings[0]!.finding_id],
        reason: "Not authoritative yet",
        residual_risk: "Unknown",
        evidence_snapshot: ["authorization/fake.json"],
        timestamp: "2026-07-11T12:00:00.000Z",
        policy_revision: input.policy.policy_revision,
      },
    })).rejects.toThrow(/Task 13|authoritative authorization/i);
  });

  it("rejects await_plan_approval because it must reuse the pending replan report", async () => {
    const input = await exhaustedInput();
    await expect(writeConvergenceReport({
      ...input,
      cycle: {
        ...input.cycle,
        decision: { ...input.cycle.decision, action: "await_plan_approval" },
      },
    })).rejects.toThrow(/await_plan_approval|pending replan/i);
  });

  it("does not write convergence before a quality-recovery effect executes", async () => {
    const input = await exhaustedInput();
    const path = convergenceReportPath(
      input.cycle.work_item_id,
      input.accounting.plan_revision,
      input.accounting.review_revision,
    );
    await expect(writeConvergenceReport({
      ...input,
      cycle: {
        ...input.cycle,
        decision: {
          ...input.cycle.decision,
          action: "quality_recovery",
          reason_code: "bounded_quality_recovery_available",
        },
      },
    })).rejects.toThrow("Fix decisions do not produce convergence reports");
    await expect(readFile(join(input.run_dir, path), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects caller-supplied current evidence authority", async () => {
    const input = await exhaustedInput();
    await expect(writeConvergenceReport({
      ...input,
      evidence_refs: ["reviews/caller-selected.json"],
    } as never)).rejects.toThrow(/caller.*evidence|cycle-owned/i);
  });

  it("rejects a missing cycle-owned evidence artifact", async () => {
    const input = await exhaustedInput();
    await rm(join(input.run_dir, input.cycle.work_item_progress_reference!.review_path));
    await expect(writeConvergenceReport(input)).rejects.toThrow(/review.*missing|artifact/i);
  });

  it("rejects mismatched cycle-owned evidence provenance", async () => {
    const input = await exhaustedInput();
    const reviewPath = join(input.run_dir, input.cycle.work_item_progress_reference!.review_path);
    const review = JSON.parse(await readFile(reviewPath, "utf8"));
    review.work_item_id = "other-item";
    await writeFile(reviewPath, `${JSON.stringify(review)}\n`);
    await expect(writeConvergenceReport(input)).rejects.toThrow(/work item|provenance/i);
  });

  it("rejects mismatched cycle-owned verification provenance", async () => {
    const input = await exhaustedInput();
    const verificationPath = join(input.run_dir, input.cycle.work_item_progress_reference!.verification_path);
    const verification = JSON.parse(await readFile(verificationPath, "utf8"));
    verification.attempt = 99;
    await writeFile(verificationPath, `${JSON.stringify(verification)}\n`);
    await expect(writeConvergenceReport(input)).rejects.toThrow(/verification.*provenance|revision/i);
  });

  it.each([
    ["missing", []],
    ["different", ["verification/issue-1/attempt-99/evidence.json"]],
    ["contradictory", [
      "verification/issue-1/attempt-4/evidence.json",
      "verification/issue-1/attempt-99/evidence.json",
    ]],
  ])("rejects %s review binding to the cycle verification", async (_case, evidenceReviewed) => {
    const input = await exhaustedInput();
    const reviewPath = join(input.run_dir, input.cycle.work_item_progress_reference!.review_path);
    const review = JSON.parse(await readFile(reviewPath, "utf8"));
    review.evidence_reviewed = evidenceReviewed;
    await writeFile(reviewPath, `${JSON.stringify(review)}\n`);

    await expect(writeConvergenceReport(input)).rejects.toThrow(/review.*verification|evidence_reviewed|binding/i);
  });

  it("accepts canonical command artifacts from the cycle verification directory", async () => {
    const input = await exhaustedInput();
    const reference = input.cycle.work_item_progress_reference!;
    const reviewPath = join(input.run_dir, reference.review_path);
    const review = JSON.parse(await readFile(reviewPath, "utf8"));
    review.evidence_reviewed = [
      reference.verification_path,
      `${dirname(reference.verification_path)}/command-1.json`,
      `${dirname(reference.verification_path)}/command-1.stdout.txt`,
    ];
    await writeFile(reviewPath, `${JSON.stringify(review)}\n`);

    await expect(writeConvergenceReport(input)).resolves.toMatch(/convergence/);
  });

  it("accepts canonical verification evidence from another work item", async () => {
    const input = await exhaustedInput();
    const reference = input.cycle.work_item_progress_reference!;
    const reviewPath = join(input.run_dir, reference.review_path);
    const review = JSON.parse(await readFile(reviewPath, "utf8"));
    review.evidence_reviewed = [
      reference.verification_path,
      "verification/issue-2/attempt-1/evidence.json",
    ];
    await writeFile(reviewPath, `${JSON.stringify(review)}\n`);

    await expect(writeConvergenceReport(input)).resolves.toMatch(/convergence/);
  });

  it("accepts current-run-prefixed canonical verification artifacts", async () => {
    const input = await exhaustedInput();
    const reference = input.cycle.work_item_progress_reference!;
    const reviewPath = join(input.run_dir, reference.review_path);
    const review = JSON.parse(await readFile(reviewPath, "utf8"));
    const runPrefix = `runs/${basename(input.run_dir)}`;
    review.evidence_reviewed = [
      `${runPrefix}/${reference.verification_path}`,
      `${runPrefix}/${dirname(reference.verification_path)}/command-1.json`,
    ];
    await writeFile(reviewPath, `${JSON.stringify(review)}\n`);

    await expect(writeConvergenceReport(input)).resolves.toMatch(/convergence/);
  });

  it("rejects another-run-prefixed verification artifact", async () => {
    const input = await exhaustedInput();
    const reference = input.cycle.work_item_progress_reference!;
    const reviewPath = join(input.run_dir, reference.review_path);
    const review = JSON.parse(await readFile(reviewPath, "utf8"));
    review.evidence_reviewed = [
      reference.verification_path,
      `runs/another-run/${reference.verification_path}`,
    ];
    await writeFile(reviewPath, `${JSON.stringify(review)}\n`);

    await expect(writeConvergenceReport(input)).rejects.toThrow(/evidence_reviewed|binding/i);
  });

  it("rejects a POSIX filename containing backslashes instead of canonical separators", async () => {
    const input = await exhaustedInput();
    const reference = input.cycle.work_item_progress_reference!;
    const backslashPath = "verification\\issue-1\\attempt-4\\evidence.json";
    await writeFile(join(input.run_dir, backslashPath), `${JSON.stringify({
      issue_number: 1,
      attempt: 4,
      evidence_path: backslashPath,
      commands: [],
      artifacts: [],
      artifact_checks: [],
      browser_evidence: [],
      created_at: "2026-07-11T12:00:00.000Z",
    })}\n`);
    const reviewPath = join(input.run_dir, reference.review_path);
    const review = JSON.parse(await readFile(reviewPath, "utf8"));
    review.evidence_reviewed = [backslashPath];
    await writeFile(reviewPath, `${JSON.stringify(review)}\n`);
    input.cycle = {
      ...input.cycle,
      work_item_progress_reference: { ...reference, verification_path: backslashPath },
    };
    await writeFile(join(input.run_dir, input.cycle.decision_path), `${JSON.stringify(input.cycle, null, 2)}\n`);

    await expect(writeConvergenceReport(input)).rejects.toThrow(/backslash|canonical|separator/i);
  });

  it("rejects a symlinked verification parent that resolves to an outside target", async () => {
    const input = await exhaustedInput();
    const verificationPath = input.cycle.work_item_progress_reference!.verification_path;
    const parent = join(input.run_dir, dirname(input.cycle.work_item_progress_reference!.verification_path));
    const outsideParent = join(root!, "outside-verification");
    await mkdir(outsideParent);
    await writeFile(join(outsideParent, "evidence.json"), await readFile(join(input.run_dir, verificationPath)));
    await rm(parent, { recursive: true });
    await symlink(outsideParent, parent);

    await expect(writeConvergenceReport(input)).rejects.toThrow(/symlink|outside|confined/i);
  });

  it("rejects symlinked cycle-owned evidence", async () => {
    const input = await exhaustedInput();
    const reviewPath = join(input.run_dir, input.cycle.work_item_progress_reference!.review_path);
    const outside = join(root!, "outside-review.json");
    await writeFile(outside, await readFile(reviewPath));
    await rm(reviewPath);
    await symlink(outside, reviewPath);

    await expect(writeConvergenceReport(input)).rejects.toThrow(/symlink|regular/i);
  });
});
