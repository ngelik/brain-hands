import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildCli } from "../../src/cli.js";
import * as controllerProvenance from "../../src/core/controller-provenance.js";
import type { CodexAdapter, CodexInvokeInput, CodexInvokeResult } from "../../src/adapters/codex.js";
import {
  acquireExecutionLease,
  approvePlanRevision,
  createRunLedgerV2,
  readManifestV2,
  recordPlan,
  requiresPinnedRuntimeAuthority,
  updateReviewAccounting,
  updateManifestV2,
} from "../../src/core/ledger.js";
import { generatedReplanPatchSchema, replanPatchSchema } from "../../src/core/schema.js";
import {
  approvalSha256,
  readVerifiedPlanApprovalRequest,
  requestSha256,
  serializePlanApprovalRequest,
} from "../../src/core/plan-approval.js";
import {
  resolvedRunConfigurationSchema,
  runConfigurationSha256,
  serializeRunConfiguration,
} from "../../src/core/run-configuration.js";
import { replanPatchOutputSchema } from "../../src/core/output-schemas.js";
import { detectSecretMaterial } from "../../src/core/secret-detector.js";
import { verificationIdentityDirectory } from "../../src/core/types.js";
import type { BrainPlan, FindingRevisionInput, ReplanPatch, ResolvedRunIntake, VerifierReview } from "../../src/core/types.js";
import { rewriteLegacyCheckoutSnapshot } from "../fixtures/legacy-run.js";
import { findingHistoryPath, fingerprintFinding, recordFindingRevision } from "../../src/workflow/findings.js";
import {
  approvePreparedReplanRevision as approvePreparedReplanRevisionCore,
  continueApprovedReplanRevision,
  createReplanPatch,
  InvalidReplanCandidateError,
  NoMaterialReplanError,
  prepareReplanApprovalBoundary,
  replanOutputScopeDiagnostics,
  reconcilePendingReplanApprovalBoundary,
  rejectPreparedReplanRevision,
  resolvePendingReplanTarget,
  validateActiveReplanPatch,
  type CreateReplanPatchInput,
} from "../../src/workflow/replan.js";
import * as replanWorkflow from "../../src/workflow/replan.js";
import { executionSpec } from "../fixtures/execution-spec.js";
import { createLegacyRunLedgerV2 } from "../fixtures/legacy-run.js";
import { readOperatorStatus } from "../../src/workflow/status.js";
import {
  beginReviewCycle,
  claimReviewEffect,
  completeReviewEffect,
  reviewCycleIdentity,
  reviewDecisionPath,
  reviewEffectIdentity,
} from "../../src/workflow/review-cycle.js";
import { evaluateReviewPolicy } from "../../src/workflow/review-policy.js";
import { loadVerifiedPlanBundle } from "../../src/workflow/verified-plan.js";

const codexMetrics = { usage: null, durationMs: 0, processStarted: false, turnStarted: false, structuredTerminalError: false } as const;
import { CANONICAL_REVIEW_POLICY } from "../../src/core/config.js";
import type { ControllerProvenance } from "../../src/core/types.js";

const findingRevision = {
  work_item_id: "BH-005",
  source: "verifier" as const,
  severity: "medium" as const,
  disposition: "requires_replan" as const,
  criterion_ref: "BH-001:AC-1",
  normalized_location: "src/target.ts",
  problem_class: "correctness",
  problem: "The verified edge case still fails.",
  required_fix: "Handle the verified edge case.",
  evidence_refs: ["verification/local/QkgtMDA1/attempt-1/evidence.json"],
  review_revision: 1,
};

const recordedController: ControllerProvenance = {
  self_hosting: false,
  mode: "development_checkout",
  executable_path: "/controller/dist/cli.js",
  package_root: "/controller",
  package_name: "@ngelik/brain-hands",
  package_version: "0.4.0",
  package_hash_algorithm: "sha256",
  package_hash: "a".repeat(64),
  candidate_commit: "b".repeat(40),
};

const captureRecordedController = async () => ({
  provenance: recordedController,
  selfHosting: false,
});

function approvePreparedReplanRevision(runDir: string, workItemId: string, revision: number) {
  return approvePreparedReplanRevisionCore(runDir, workItemId, revision, {
    approvalControllerCapture: async () => ({
      provenance: recordedController,
      selfHosting: false,
    }),
  });
}
const findingId = fingerprintFinding(findingRevision);
const convergencePath = "reviews/convergence/work-item-QkgtMDA1-plan-1-review-1.json";
const reviewEvidencePath = "reviews/BH-005/attempt-1.json";
const evidencePath = `${verificationIdentityDirectory({ scope: "local", work_item_id: "BH-005" })}/attempt-1/evidence.json`;
const cycleEvidencePaths = [reviewEvidencePath, evidencePath].sort();

const plan: BrainPlan = {
  summary: "Implement a bounded change",
  assumptions: [],
  research: [],
  research_sources: ["repo"],
  architecture: "Keep identities stable",
  risks: [],
  work_items: [
    {
      ...executionSpec("BH-005"),
      title: "Target item",
      objective: "Repair the target behavior",
      forbidden_changes: [{
        path: "*",
        except: ["src/BH-005.ts", "tests/BH-005.test.ts"],
        reason: "Only the work-item contract may change.",
      }],
    },
    {
      ...executionSpec("BH-006", ["BH-005"]),
      title: "Unrelated completed item",
      objective: "Remain unchanged",
    },
  ],
  integration_verification: [["npm", "test"]],
};

const intake: ResolvedRunIntake = {
  task: "Do the bounded work",
  repo_root: "/tmp/repo",
  mode: "local",
  research: false,
  reflection: false,
  models: { brain: "brain-model", hands: "hands-model", verifier: "verifier-model" },
  resolved_models: { brain: "brain-model", hands: "hands-model", verifier: "verifier-model" },
  roles: {
    brain: { model: "brain-model", reasoning_effort: "high", sandbox: "read-only" },
    hands: { model: "hands-model", reasoning_effort: "medium", sandbox: "workspace-write" },
    verifier: { model: "verifier-model", reasoning_effort: "high", sandbox: "read-only" },
  },
};

function validPatch(overrides: Partial<ReplanPatch> = {}): ReplanPatch {
  return {
    target_work_item_id: "BH-005",
    base_plan_revision: 1,
    unresolved_finding_ids: [findingId],
    revised_objective: "Repair the target behavior with the verified constraint.",
    added_or_changed_criteria: [{ ref: "BH-001:AC-1", text: "The target behavior is correct after the verified edge case." }],
    changed_instructions: ["Handle the verified edge case in the target behavior."],
    added_change_units: [],
    added_verification_commands: [],
    added_cross_cutting_impacts: [],
    added_read_only_file_contracts: [],
    added_expected_artifacts: [],
    explicitly_rejected_hardening: ["Do not refactor unrelated completed work."],
    ...overrides,
  };
}

class RecordingBrain implements CodexAdapter {
  readonly calls: CodexInvokeInput[] = [];

  constructor(private readonly patch: unknown) {}

  async invoke(input: CodexInvokeInput): Promise<CodexInvokeResult> {
    this.calls.push(input);
    return {
      text: `${JSON.stringify(this.patch)}\n`,
      parsed: this.patch,
      exitCode: 0,
      promptPath: join(input.runDir, "prompts", `${input.artifactName}.md`),
      stdoutPath: join(input.runDir, "responses", `${input.artifactName}.stdout.txt`),
      stderrPath: join(input.runDir, "responses", `${input.artifactName}.stderr.txt`),
      ...codexMetrics,
    };
  }
}

let root: string | undefined;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
  vi.restoreAllMocks();
});

async function validInput(
  patch: unknown = validPatch(),
  additionalFindings: FindingRevisionInput[] = [],
  options: { pinRunConfiguration?: boolean; mode?: "local" | "github" } = {},
  inputPlan: BrainPlan = plan,
): Promise<CreateReplanPatchInput & { brain: RecordingBrain }> {
  root = await mkdtemp(join(tmpdir(), "brain-hands-replan-"));
  const mode = options.mode ?? "local";
  const runConfiguration = resolvedRunConfigurationSchema.parse({
    version: 1,
    repository: root,
    mode,
    research: false,
    reflection: false,
    controller: {
      package_name: recordedController.package_name,
      package_version: recordedController.package_version,
      mode: recordedController.mode,
    },
    roles: {
      brain: { ...intake.roles.brain, source: "repository_config" },
      hands: { ...intake.roles.hands, source: "repository_config" },
      verifier: { ...intake.roles.verifier, source: "repository_config" },
    },
    hands_backup: null,
    limits: {
      max_hands_fix_attempts: 3,
      max_replan_attempts: 2,
      review_policy: CANONICAL_REVIEW_POLICY,
      quality_gate: null,
    },
    github: { effects: mode === "github" ? "issues_and_pull_request" : "none", default_remote: "origin" },
  });
  const ledger = await createLegacyRunLedgerV2({
    repoRoot: root,
    originalRequest: intake.task,
    mode,
    intake: { ...intake, repo_root: root, mode },
    roles: intake.roles,
    sourceCommit: recordedController.candidate_commit,
    controllerProvenance: recordedController,
  });
  const revision = await recordPlan(ledger.runDir, `${JSON.stringify(inputPlan, null, 2)}\n`);
  await approvePlanRevision(ledger.runDir, revision.revision, { actor: "human" });
  if (options.pinRunConfiguration !== false) {
    await writeFile(join(ledger.runDir, "run-configuration.json"), serializeRunConfiguration(runConfiguration));
  }
  const recordedFindings = [
    await recordFindingRevision(ledger.runDir, findingRevision),
    ...await Promise.all(additionalFindings.map((finding) => recordFindingRevision(ledger.runDir, finding))),
  ];
  await mkdir(join(ledger.runDir, "reviews/convergence"), { recursive: true });
  await mkdir(join(ledger.runDir, "reviews/BH-005"), { recursive: true });
  await mkdir(join(ledger.runDir, dirname(evidencePath)), { recursive: true });
  await writeFile(join(ledger.runDir, reviewEvidencePath), `${JSON.stringify({
    work_item_id: "BH-005",
    attempt: 1,
    final: false,
    decision: "approve",
    failure_class: "none",
    blocker: null,
    blocker_code: null,
    acceptance_coverage: [],
    evidence_reviewed: [evidencePath],
    findings: [],
    residual_risks: [],
  })}\n`);
  await writeFile(join(ledger.runDir, evidencePath), `${JSON.stringify({
    verification_scope: "local",
    work_item_id: "BH-005",
    attempt: 1,
    evidence_path: evidencePath,
    commands: [],
    artifacts: [],
    artifact_checks: [],
    browser_evidence: [],
    created_at: "2026-07-16T12:00:00.000Z",
  })}\n`);
  await mkdir(join(root, "worktree"));
  const beforeProgress = await readManifestV2(ledger.runDir);
  await updateManifestV2(ledger.runDir, {
    work_item_progress: {
      ...beforeProgress.work_item_progress,
      "BH-005": {
        status: "in_progress",
        attempts: 1,
        review_path: reviewEvidencePath,
        verification_path: evidencePath,
      },
    },
  });
  const beforeCycle = await readManifestV2(ledger.runDir);
  const cycleFindingIds = recordedFindings.map((finding) => finding.finding_id).sort();
  const cycle = await beginReviewCycle({
    run_dir: ledger.runDir,
    work_item_id: "BH-005",
    phase: "work_item",
    review_revision: 1,
    policy_hash: createHash("sha256").update(JSON.stringify(beforeCycle.review_policy_snapshot)).digest("hex"),
    finding_ids: cycleFindingIds,
    accounting_before: beforeCycle.review_accounting!,
    work_item_progress_reference: {
      attempts: 1,
      review_path: reviewEvidencePath,
      verification_path: evidencePath,
    },
    evaluate: () => evaluateReviewPolicy({
      policy: beforeCycle.review_policy_snapshot!,
      findings: recordedFindings,
      accounting: beforeCycle.review_accounting!,
      phase: "work_item",
      operational_blocker: null,
      replan_patch_pending: false,
      authorization: null,
      quality_recovery: {
        configured: false,
        active_hands_profile: "primary",
        attempts_used: 0,
      },
    }),
  });
  await writeFile(join(ledger.runDir, convergencePath), `${JSON.stringify({
    work_item_id: "BH-005",
    policy_revision: beforeCycle.review_policy_snapshot!.policy_revision,
    max_fix_cycles: 3,
    plan_revision: 1,
    review_revision: 1,
    fix_cycles_used: 0,
    self_review_mutations_used: 0,
    unresolved_finding_ids: [findingId],
    resolved_finding_ids: [],
    repeated_finding_ids: [findingId],
    advisory_finding_ids: recordedFindings.filter((finding) => finding.disposition === "advisory").map((finding) => finding.finding_id),
    follow_up_finding_ids: recordedFindings.filter((finding) => finding.disposition === "follow_up").map((finding) => finding.finding_id),
    evidence_refs: cycleEvidencePaths,
    remaining_release_guards: ["release:no-secrets"],
    authorization: null,
    decision_reason_code: "plan_change_required",
    recommended_action: "create_replan",
  }, null, 2)}\n`);
  const manifest = await readManifestV2(ledger.runDir);
  await rewriteLegacyCheckoutSnapshot(ledger.runDir, {
    source_commit: recordedController.candidate_commit,
    worktree_path: join(root, "worktree"),
    branch_name: "brain-hands/test",
  });
  await updateManifestV2(ledger.runDir, {
    convergence_reports: {
      "BH-005": {
        path: convergencePath,
        plan_revision: 1,
        review_revision: 1,
        recommended_action: "create_replan",
      },
    },
    work_item_progress: {
      ...manifest.work_item_progress,
      "BH-005": {
        ...manifest.work_item_progress["BH-005"],
        status: "in_progress",
        attempts: 1,
        review_cycle_path: cycle.decision_path,
        review_effect_id: cycle.effect_id,
        review_revision: cycle.review_revision,
      },
      "BH-006": { status: "complete", attempts: 1, commit_sha: "abc123" },
    },
    current_work_item_id: "BH-005",
  });
  const brain = new RecordingBrain(patch);
  return {
    run_dir: ledger.runDir,
    repo_root: join(root, "worktree"),
    codex: brain,
    target_work_item: inputPlan.work_items[0]!,
    base_plan_revision: 1,
    unresolved_finding_ids: [findingId],
    convergence_report_path: convergencePath,
    release_guards: manifest.release_guards!,
    evidence_paths: cycleEvidencePaths,
    model_profile: intake.roles.brain,
    brain,
  };
}

describe("createReplanPatch", () => {
  it("requires exact command-linked remediation outputs and rejects unrelated artifact widening", () => {
    const baseTarget = plan.work_items[0]!;
    const artifactPath = "artifacts/replan-report.json";
    const review = {
      findings: [{
        problem: findingRevision.problem,
        required_fix: findingRevision.required_fix,
        remediation: {
          verification: {
            commands: [{ id: "CMD-1", argv: [...baseTarget.verification_commands[0]!.argv] }],
            required_evidence: [{ id: "EVID-1", kind: "artifact", source_id: "CMD-1", output_path: artifactPath }],
          },
        },
      }],
    } as VerifierReview;
    const findingRecords = [{
      finding_id: findingId,
      problem_class: findingRevision.problem_class,
      criterion_ref: findingRevision.criterion_ref,
      normalized_location: findingRevision.normalized_location,
      severity: findingRevision.severity,
      disposition: findingRevision.disposition,
      problem: findingRevision.problem,
      required_fix: findingRevision.required_fix,
      evidence_refs: findingRevision.evidence_refs,
    }];

    expect(replanOutputScopeDiagnostics({
      baseTarget,
      proposedTarget: { ...baseTarget, expected_artifacts: [...baseTarget.expected_artifacts, artifactPath] },
      review,
      findingRecords,
    })).toEqual([]);
    expect(replanOutputScopeDiagnostics({ baseTarget, proposedTarget: baseTarget, review, findingRecords }))
      .toContain(`Generated artifact output ${artifactPath} is outside proposed expected_artifacts scope`);
    expect(replanOutputScopeDiagnostics({
      baseTarget,
      proposedTarget: { ...baseTarget, expected_artifacts: [...baseTarget.expected_artifacts, "artifacts/unrelated.json"] },
      review,
      findingRecords,
    })).toContain("Proposed expected artifact artifacts/unrelated.json is not required by exact unresolved remediation evidence");
  });

  it("keeps the TypeScript, Zod, JSON, and prompt objective contract in parity", async () => {
    const base = validPatch();
    expect(replanPatchSchema.safeParse({ ...base, revised_objective: null }).success).toBe(true);
    expect(replanPatchSchema.safeParse({ ...base, revised_objective: "" }).success).toBe(false);
    const { revised_objective: _omitted, ...withoutObjective } = base;
    expect(replanPatchSchema.safeParse(withoutObjective).success).toBe(false);
    expect(replanPatchSchema.safeParse({
      ...base,
      added_or_changed_criteria: [{ ref: "wrong", text: "Malformed" }],
    }).success).toBe(false);
    expect(replanPatchSchema.safeParse({
      ...base,
      added_or_changed_criteria: [base.added_or_changed_criteria[0], base.added_or_changed_criteria[0]],
    }).success).toBe(true);
    const sameRefDifferentText = [
      base.added_or_changed_criteria[0]!,
      { ...base.added_or_changed_criteria[0]!, text: "Different text with the same ref" },
    ];
    expect(replanPatchSchema.safeParse({ ...base, added_or_changed_criteria: sameRefDifferentText }).success)
      .toBe(true);
    expect(new Set(sameRefDifferentText.map((criterion) => JSON.stringify(criterion))).size).toBe(2);
    expect(replanPatchOutputSchema.required).toContain("revised_objective");
    expect(replanPatchOutputSchema.required).toContain("added_change_units");
    expect(replanPatchOutputSchema.required).toContain("added_verification_commands");
    expect(replanPatchOutputSchema.required).toContain("added_cross_cutting_impacts");
    expect(replanPatchOutputSchema.required).toContain("added_read_only_file_contracts");
    expect(replanPatchOutputSchema.required).toContain("added_expected_artifacts");
    expect(replanPatchOutputSchema.properties.added_verification_commands.items.required).toContain("tier");
    expect(replanPatchOutputSchema.properties.added_verification_commands.items.required).toContain("satisfies");
    const { added_change_units: _legacyOmission, ...legacy } = base;
    expect(replanPatchSchema.parse(legacy).added_change_units).toEqual([]);
    const { added_verification_commands: _legacyVerificationOmission, ...legacyVerification } = base;
    expect(replanPatchSchema.parse(legacyVerification).added_verification_commands).toEqual([]);
    const { added_cross_cutting_impacts: _legacyImpactOmission, ...legacyImpacts } = base;
    expect(replanPatchSchema.parse(legacyImpacts).added_cross_cutting_impacts).toEqual([]);
    const { added_read_only_file_contracts: _legacyReadOnlyOmission, ...legacyReadOnly } = base;
    expect(replanPatchSchema.parse(legacyReadOnly).added_read_only_file_contracts).toEqual([]);
    const { added_expected_artifacts: _legacyArtifactOmission, ...legacyArtifact } = base;
    expect(replanPatchSchema.parse(legacyArtifact).added_expected_artifacts).toEqual([]);
    const legacyCommand = replanPatchSchema.parse({
      ...base,
      added_verification_commands: [{
        id: "BH-005-VERIFY-02",
        argv: ["node", "node_modules/vitest/vitest.mjs", "run"],
        expected_exit_code: 0,
      }],
    }).added_verification_commands[0]!;
    expect(legacyCommand.satisfies).toEqual([]);
    expect("tier" in legacyCommand).toBe(false);
    expect(replanPatchOutputSchema.properties.added_or_changed_criteria.items.properties.ref)
      .toMatchObject({ pattern: "^BH-\\d{3}:AC-\\d+$" });
    expect("uniqueItems" in replanPatchOutputSchema.properties.unresolved_finding_ids).toBe(false);
    expect("uniqueItems" in replanPatchOutputSchema.properties.added_or_changed_criteria).toBe(false);
    const prompt = await readFile(join(process.cwd(), "prompts/brain-replan-patch-v2.md"), "utf8");
    expect(prompt).toContain("added_cross_cutting_impacts");
    expect(prompt).toContain("focused");
    expect(prompt).toContain("cross_cutting");
    expect(prompt).toContain("representative_fixtures");
    expect(prompt).toContain("added_expected_artifacts");
    expect(prompt).toContain(
      "either add its path to the reviewed critical-surface registry in the same change or classify its change unit as shared_helper",
    );
    expect(prompt).toContain("Do not use npm test, npm run build, or npm run clean as a work-item verification command");
  });

  it.each([
    ["tier", (() => {
      const patch = validPatch({
        added_verification_commands: [{
          id: "BH-005-VERIFY-02",
          argv: ["node", "node_modules/vitest/vitest.mjs", "run"],
          expected_exit_code: 0,
          satisfies: ["BH-005-AC-01"],
        }],
      });
      return patch;
    })()],
    ["satisfies", (() => {
      const patch = validPatch({
        added_verification_commands: [{
          id: "BH-005-VERIFY-02",
          argv: ["node", "node_modules/vitest/vitest.mjs", "run"],
          expected_exit_code: 0,
          tier: "focused",
        } as ReplanPatch["added_verification_commands"][number]],
      });
      return patch;
    })()],
    ["added_cross_cutting_impacts", (() => {
      const { added_cross_cutting_impacts: _omitted, ...patch } = validPatch();
      return patch;
    })()],
    ["added_read_only_file_contracts", (() => {
      const { added_read_only_file_contracts: _omitted, ...patch } = validPatch();
      return patch;
    })()],
  ])("rejects newly invoked Brain output missing required %s metadata", async (field, patch) => {
    expect(generatedReplanPatchSchema.safeParse(patch).success).toBe(false);
    expect(replanPatchSchema.safeParse(patch).success).toBe(true);
    const input = await validInput(patch);

    await expect(createReplanPatch(input)).rejects.toThrow(new RegExp(field, "i"));
    expect(input.brain.calls[0]!.outputParser).toBe(generatedReplanPatchSchema);
    expect(await readdir(join(input.run_dir, "replans")).catch(() => [])).toEqual([]);
  });

  it("enforces duplicate criterion refs at the runtime validation boundary", async () => {
    const criterion = validPatch().added_or_changed_criteria[0]!;
    const input = await validInput(validPatch({
      added_or_changed_criteria: [criterion, { ...criterion, text: "Different text" }],
    }));

    await expect(createReplanPatch(input)).rejects.toThrow(/duplicate criterion ref/i);
    expect(input.brain.calls).toHaveLength(1);
    expect(await readdir(join(input.run_dir, "replans")).catch(() => [])).toEqual([]);
  });

  it("rejects a cross-cutting impact for an unknown change-unit ID", async () => {
    const command = {
      id: "BH-005-VERIFY-02",
      argv: ["node", "node_modules/vitest/vitest.mjs", "run"],
      expected_exit_code: 0 as const,
      tier: "cross_cutting" as const,
      satisfies: ["BH-005-AC-01"],
    };
    const input = await validInput(validPatch({
      added_verification_commands: [command],
      added_cross_cutting_impacts: [{
        change_unit_id: "BH-005-CH-99",
        category: "shared_helper",
        callers: ["src/BH-005.ts"],
        representative_fixtures: ["tests/BH-005.test.ts"],
        verification_command_ids: [command.id],
      }],
    }));

    await expect(createReplanPatch(input)).rejects.toThrow(/unknown change unit/i);
  });

  it("rejects a focused command referenced by a cross-cutting impact", async () => {
    const input = await validInput(validPatch({
      added_cross_cutting_impacts: [{
        change_unit_id: "BH-005-CH-01",
        category: "shared_helper",
        callers: ["src/BH-005.ts"],
        representative_fixtures: ["tests/BH-005.test.ts"],
        verification_command_ids: ["BH-005-VERIFY-01"],
      }],
    }));

    await expect(createReplanPatch(input)).rejects.toThrow(/not cross[_ -]cutting/i);
  });

  it("canonicalizes an added impact command to the cross-cutting tier", async () => {
    const command = {
      id: "BH-005-VERIFY-02",
      argv: ["node", "node_modules/vitest/vitest.mjs", "run"],
      expected_exit_code: 0 as const,
      tier: "focused" as const,
      satisfies: ["BH-005-AC-01"],
    };
    const input = await validInput(validPatch({
      added_change_units: [{
        id: "BH-005-CH-99",
        path: "src/helper.ts",
        target: "Shared helper",
        operation: "create",
        requirements: ["Provide the verified shared behavior."],
        satisfies: ["BH-005-AC-01"],
      }],
      added_verification_commands: [command],
      added_cross_cutting_impacts: [{
        change_unit_id: "BH-005-CH-99",
        category: "shared_helper",
        callers: ["src/BH-005.ts"],
        representative_fixtures: ["tests/BH-005.test.ts"],
        verification_command_ids: [command.id],
      }],
    }));

    const result = await createReplanPatch(input);
    expect(result.patch.added_verification_commands[0]?.tier).toBe("cross_cutting");
  });

  it("rejects an added verification command linked to an unknown acceptance ID", async () => {
    const input = await validInput(validPatch({
      added_verification_commands: [{
        id: "BH-005-VERIFY-02",
        argv: ["node", "node_modules/vitest/vitest.mjs", "run"],
        expected_exit_code: 0,
        tier: "focused",
        satisfies: ["BH-005-AC-99"],
      }],
    }));

    await expect(createReplanPatch(input)).rejects.toThrow(/unknown acceptance ID/i);
  });

  it("maps canonical criterion refs in satisfies to target-local acceptance IDs", async () => {
    const input = await validInput(validPatch({
      added_change_units: [{
        id: "BH-005-CH-99",
        path: "src/helper.ts",
        target: "Shared helper",
        operation: "create",
        requirements: ["Provide the verified shared behavior."],
        satisfies: ["BH-001:AC-1"],
      }],
    }));

    const result = await createReplanPatch(input);
    expect(result.patch.added_change_units[0]?.satisfies).toEqual(["BH-005-AC-01"]);
  });

  it("removes a redundant browser-report env wrapper around an existing command", async () => {
    const existing = plan.work_items[0]!.verification_commands[0]!;
    const input = await validInput(validPatch({
      added_verification_commands: [{
        id: "BH-005-VERIFY-BROWSER-EVIDENCE",
        argv: ["env", "BRAIN_HANDS_BROWSER_EVIDENCE_REPORT=/tmp/browser-evidence.json", ...existing.argv],
        expected_exit_code: 0,
        tier: "cross_cutting",
        satisfies: ["BH-005-AC-01"],
      }],
    }));

    const result = await createReplanPatch(input);

    expect(result.patch.added_verification_commands).toEqual([]);
  });

  it.each([
    ["mutable conflict", { path: "src/BH-005.ts", targets: ["existing caller"] }, /duplicate file_contract path|conflict/i],
    ["invalid path", { path: "../outside.ts", targets: ["escaped fixture"] }, /repository-relative|normalized/i],
  ])("rejects an added read-only contract with a %s", async (_label, contract, expected) => {
    const input = await validInput(validPatch({ added_read_only_file_contracts: [contract] }));

    await expect(createReplanPatch(input)).rejects.toThrow(expected);
  });

  it("persists one immutable patch without replacing the plan and records model provenance", async () => {
    const input = await validInput();
    const before = await readManifestV2(input.run_dir);

    const result = await createReplanPatch(input);
    expect(input.brain.calls).toHaveLength(1);

    expect(result.patch.target_work_item_id).toBe("BH-005");
    expect(result.patch.unresolved_finding_ids).toEqual([findingId]);
    expect(result.path).toContain("replans/");
    expect(result.model_profile).toEqual(intake.roles.brain);
    expect(JSON.parse(await readFile(result.path, "utf8"))).toMatchObject({
      materialization_version: 2,
      patch: result.patch,
      provenance: {
        base_plan_revision: 1,
        convergence_report_path: convergencePath,
        evidence_paths: cycleEvidencePaths,
        model_profile: intake.roles.brain,
      },
    });
    const after = await readManifestV2(input.run_dir);
    expect(after.current_revision).toBe(before.current_revision);
    expect(after.approved_revision).toBe(before.approved_revision);
    expect(after.branch_name).toBe(before.branch_name);
    expect(after.worktree_path).toBe(before.worktree_path);
    expect(after.work_item_progress["BH-006"]).toEqual(before.work_item_progress["BH-006"]);
  });

  it("accepts repository source alongside run-owned replan evidence", async () => {
    const input = await validInput();
    const repositoryEvidence = "src/replan-evidence.ts";
    const repositoryEvidenceRef = `${repositoryEvidence}:1-1`;
    await mkdir(join(input.repo_root, "src"), { recursive: true });
    await writeFile(join(input.repo_root, repositoryEvidence), "export const evidence = true;\n");
    const convergenceFile = join(input.run_dir, convergencePath);
    const convergence = JSON.parse(await readFile(convergenceFile, "utf8"));
    convergence.evidence_refs = [...cycleEvidencePaths, repositoryEvidenceRef].sort();
    await writeFile(convergenceFile, `${JSON.stringify(convergence)}\n`);
    input.evidence_paths = convergence.evidence_refs;

    await expect(createReplanPatch(input)).resolves.toMatchObject({
      patch: { target_work_item_id: "BH-005" },
    });
    expect(input.brain.calls).toHaveLength(1);
  });

  it("retries a claimed create-replan effect only when no invocation prompt exists", async () => {
    const input = await validInput();
    await expect(createReplanPatch({ ...input, existing_only: true })).resolves.toMatchObject({
      patch: { target_work_item_id: "BH-005" },
    });
    expect(input.brain.calls).toHaveLength(1);

    await rm(root!, { recursive: true, force: true });
    root = undefined;
    const ambiguous = await validInput();
    await mkdir(join(ambiguous.run_dir, "prompts"), { recursive: true });
    await writeFile(
      join(ambiguous.run_dir, "prompts/replans-work-item-QkgtMDA1-base-1-review-1.md"),
      "persisted invocation boundary\n",
    );
    await expect(createReplanPatch({ ...ambiguous, existing_only: true }))
      .rejects.toThrow(/ambiguous create_replan effect/i);
    expect(ambiguous.brain.calls).toHaveLength(0);
  });

  it("recovers a completed replan response when the immutable patch write was interrupted", async () => {
    const input = await validInput();
    const artifactName = "replans-work-item-QkgtMDA1-base-1-review-1";
    await mkdir(join(input.run_dir, "prompts"), { recursive: true });
    await mkdir(join(input.run_dir, "responses"), { recursive: true });
    await writeFile(join(input.run_dir, "prompts", `${artifactName}.md`), "persisted invocation boundary\n");
    await writeFile(join(input.run_dir, "responses", `${artifactName}.json`), `${JSON.stringify(validPatch())}\n`);

    const result = await createReplanPatch({ ...input, existing_only: true });

    expect(result.patch.target_work_item_id).toBe("BH-005");
    expect(input.brain.calls).toHaveLength(0);
    expect(JSON.parse(await readFile(result.path, "utf8"))).toMatchObject({
      patch: { target_work_item_id: "BH-005" },
    });
  });

  it("accepts the run-owned original request as replan evidence", async () => {
    const input = await validInput();
    const convergenceFile = join(input.run_dir, convergencePath);
    const convergence = JSON.parse(await readFile(convergenceFile, "utf8"));
    convergence.evidence_refs = [...cycleEvidencePaths, "original-request.md"].sort();
    await writeFile(convergenceFile, `${JSON.stringify(convergence)}\n`);
    input.evidence_paths = convergence.evidence_refs;

    await expect(createReplanPatch(input)).resolves.toMatchObject({
      patch: { target_work_item_id: "BH-005" },
    });
    expect(input.brain.calls).toHaveLength(1);
  });

  it("accepts controller-owned context fragments as replan evidence", async () => {
    const input = await validInput();
    const contextPath = "contexts/fragments/verification/sha256-test/browser_evidence-0.json";
    await mkdir(join(input.run_dir, "contexts/fragments/verification/sha256-test"), { recursive: true });
    await writeFile(join(input.run_dir, contextPath), "{}\n");
    const convergenceFile = join(input.run_dir, convergencePath);
    const convergence = JSON.parse(await readFile(convergenceFile, "utf8"));
    convergence.evidence_refs = [...cycleEvidencePaths, contextPath].sort();
    await writeFile(convergenceFile, `${JSON.stringify(convergence)}\n`);
    input.evidence_paths = convergence.evidence_refs;

    await expect(createReplanPatch(input)).resolves.toMatchObject({
      patch: { target_work_item_id: "BH-005" },
    });
    expect(input.brain.calls).toHaveLength(1);
  });

  it("accepts a missing repository artifact when canonical verification records it as absent", async () => {
    const input = await validInput();
    const missingPath = "artifacts/screenshots/missing.png";
    const evidenceFile = join(input.run_dir, evidencePath);
    const evidence = JSON.parse(await readFile(evidenceFile, "utf8"));
    evidence.artifact_checks = [{ path: missingPath, exists: false, required: true }];
    await writeFile(evidenceFile, `${JSON.stringify(evidence)}\n`);
    const convergenceFile = join(input.run_dir, convergencePath);
    const convergence = JSON.parse(await readFile(convergenceFile, "utf8"));
    convergence.evidence_refs = [...cycleEvidencePaths, missingPath].sort();
    await writeFile(convergenceFile, `${JSON.stringify(convergence)}\n`);
    input.evidence_paths = convergence.evidence_refs;

    await expect(createReplanPatch(input)).resolves.toMatchObject({
      patch: { target_work_item_id: "BH-005" },
    });
    expect(input.brain.calls).toHaveLength(1);
  });

  it("accepts a missing mutable generated artifact after a failed capture invalidates stale output", async () => {
    const missingPath = "artifacts/screenshots/generated.png";
    const target = plan.work_items[0]!;
    const generatedPlan: BrainPlan = {
      ...plan,
      work_items: [{
        ...target,
        file_contract: [...target.file_contract, {
          path: missingPath,
          permission: "modify",
          targets: ["Regenerated browser evidence"],
        }],
        forbidden_changes: target.forbidden_changes.map((entry) => entry.path === "*"
          ? { ...entry, except: [...entry.except, missingPath] }
          : entry),
        change_units: [...target.change_units, {
          id: "CU-generated-artifact",
          path: missingPath,
          target: "Regenerated browser evidence",
          operation: "modify",
          requirements: ["Regenerate the browser evidence after validation passes."],
        }],
        expected_artifacts: [...target.expected_artifacts, missingPath],
        completion_contract: {
          ...target.completion_contract,
          expected_changed_files: [...target.completion_contract.expected_changed_files, missingPath],
        },
      }, plan.work_items[1]!],
    };
    const input = await validInput(validPatch(), [], {}, generatedPlan);
    const convergenceFile = join(input.run_dir, convergencePath);
    const convergence = JSON.parse(await readFile(convergenceFile, "utf8"));
    convergence.evidence_refs = [...cycleEvidencePaths, missingPath].sort();
    await writeFile(convergenceFile, `${JSON.stringify(convergence)}\n`);
    input.evidence_paths = convergence.evidence_refs;

    await expect(createReplanPatch(input)).resolves.toMatchObject({
      patch: { target_work_item_id: "BH-005" },
    });
    expect(input.brain.calls).toHaveLength(1);
  });

  it("accepts an invented supplemental local verification ref when canonical evidence exists", async () => {
    const input = await validInput();
    const inventedPath = "verification/local/invented/attempt-1/command-2.json";
    const convergenceFile = join(input.run_dir, convergencePath);
    const convergence = JSON.parse(await readFile(convergenceFile, "utf8"));
    convergence.evidence_refs = [...cycleEvidencePaths, inventedPath].sort();
    await writeFile(convergenceFile, `${JSON.stringify(convergence)}\n`);
    input.evidence_paths = convergence.evidence_refs;

    await expect(createReplanPatch(input)).resolves.toMatchObject({
      patch: { target_work_item_id: "BH-005" },
    });
    expect(input.brain.calls).toHaveLength(1);
  });

  it("rejects missing or escaped repository replan evidence", async () => {
    const missing = await validInput();
    const missingPath = "src/missing-evidence.ts";
    const missingConvergenceFile = join(missing.run_dir, convergencePath);
    const missingConvergence = JSON.parse(await readFile(missingConvergenceFile, "utf8"));
    missingConvergence.evidence_refs = [...cycleEvidencePaths, missingPath].sort();
    await writeFile(missingConvergenceFile, `${JSON.stringify(missingConvergence)}\n`);
    missing.evidence_paths = missingConvergence.evidence_refs;
    await expect(createReplanPatch(missing)).rejects.toThrow(/repository evidence.*missing/i);
    expect(missing.brain.calls).toHaveLength(0);

    await rm(root!, { recursive: true, force: true });
    root = undefined;
    const escaped = await validInput();
    const escapedPath = "src/escaped-evidence.ts";
    await mkdir(join(escaped.repo_root, "src"), { recursive: true });
    const outside = join(root!, "outside-evidence.ts");
    await writeFile(outside, "export const outside = true;\n");
    await symlink(outside, join(escaped.repo_root, escapedPath));
    const escapedConvergenceFile = join(escaped.run_dir, convergencePath);
    const escapedConvergence = JSON.parse(await readFile(escapedConvergenceFile, "utf8"));
    escapedConvergence.evidence_refs = [...cycleEvidencePaths, escapedPath].sort();
    await writeFile(escapedConvergenceFile, `${JSON.stringify(escapedConvergence)}\n`);
    escaped.evidence_paths = escapedConvergence.evidence_refs;
    await expect(createReplanPatch(escaped)).rejects.toThrow(/escaped.*authorized checkout/i);
    expect(escaped.brain.calls).toHaveLength(0);
  });

  it("rejects a patch targeting another work item or base revision", async () => {
    const foreign = await validInput(validPatch({ target_work_item_id: "BH-006" }));
    await expect(createReplanPatch(foreign)).rejects.toThrow(/target work item/i);
    await rm(root!, { recursive: true, force: true });
    root = undefined;
    const wrongRevision = await validInput(validPatch({ base_plan_revision: 2 }));
    await expect(createReplanPatch(wrongRevision)).rejects.toThrow(/base plan revision/i);
  });

  it("rejects a mismatched finding set, unknown criterion refs, and completed targets", async () => {
    const mismatch = await validInput(validPatch({ unresolved_finding_ids: [`finding:${"b".repeat(64)}`] }));
    await expect(createReplanPatch(mismatch)).rejects.toThrow(/finding set/i);
    await rm(root!, { recursive: true, force: true });
    root = undefined;
    const unknownCriterion = await validInput(validPatch({
      added_or_changed_criteria: [{ ref: "BH-999:AC-9", text: "Foreign criterion" }],
    }));
    await expect(createReplanPatch(unknownCriterion)).rejects.toThrow(/criterion ref/i);
    await rm(root!, { recursive: true, force: true });
    root = undefined;
    const completed = await validInput();
    const manifest = await readManifestV2(completed.run_dir);
    await updateManifestV2(completed.run_dir, {
      work_item_progress: {
        ...manifest.work_item_progress,
        "BH-005": { status: "complete", attempts: 3, commit_sha: "done123" },
      },
    });
    await expect(createReplanPatch(completed)).rejects.toThrow(/completed target work item/i);
    await expect(createReplanPatch({ ...completed, source_work_item_id: "BH-005" })).rejects.toThrow(/completed target work item/i);
    await expect(createReplanPatch({ ...completed, source_work_item_id: "integrated" })).rejects.toThrow(/authoritative target report|integrated final\/post engine provenance/i);
  });

  it("rejects the completed-target exception when an integrated target has work-item provenance", async () => {
    const input = await validInput();
    const manifest = await readManifestV2(input.run_dir);
    const revision = manifest.plan_revisions["1"]!;
    const planPath = await realpath(revision.path);
    const recordedPlan = JSON.parse(await readFile(planPath, "utf8")) as BrainPlan;
    recordedPlan.work_items[0] = { ...recordedPlan.work_items[0]!, id: "integrated" };
    await writeFile(planPath, `${JSON.stringify(recordedPlan)}\n`);

    const convergence = JSON.parse(await readFile(join(input.run_dir, convergencePath), "utf8")) as Record<string, unknown>;
    convergence.work_item_id = "integrated";
    await writeFile(join(input.run_dir, convergencePath), `${JSON.stringify(convergence)}\n`);

    const sourceProgress = manifest.work_item_progress["BH-005"]!;
    const cyclePath = sourceProgress.review_cycle_path!;
    const cycle = JSON.parse(await readFile(join(input.run_dir, cyclePath), "utf8")) as Record<string, unknown>;
    cycle.work_item_id = "integrated";
    await writeFile(join(input.run_dir, cyclePath), `${JSON.stringify(cycle)}\n`);

    await updateManifestV2(input.run_dir, {
      plan_revisions: {
        ...manifest.plan_revisions,
        "1": {
          ...revision,
          acceptance_criteria: {
            ...revision.acceptance_criteria,
            integrated: revision.acceptance_criteria?.["BH-005"] ?? [],
          },
        },
      },
      convergence_reports: {
        ...manifest.convergence_reports,
        integrated: manifest.convergence_reports?.["BH-005"]!,
      },
      work_item_progress: {
        ...manifest.work_item_progress,
        integrated: { ...sourceProgress, status: "complete", commit_sha: "done123" },
      },
    });

    await expect(createReplanPatch({
      ...input,
      target_work_item: recordedPlan.work_items[0]!,
      source_work_item_id: "integrated",
    })).rejects.toThrow(/integrated final\/post engine provenance|SHA-256/i);
    expect(input.brain.calls).toHaveLength(0);
  });

  it("uses a bounded read-only Brain prompt containing no unrelated item or secret-shaped input", async () => {
    const input = await validInput();
    await createReplanPatch(input);

    expect(input.brain.calls).toHaveLength(1);
    const call = input.brain.calls[0]!;
    expect(call).toMatchObject({
      role: "brain",
      model: "brain-model",
      reasoningEffort: "high",
      sandbox: "read-only",
      enableWebSearch: false,
      outputParser: expect.anything(),
      outputSchema: expect.anything(),
      cwd: await realpath(join(root!, "worktree")),
    });
    expect(call.prompt.length).toBeLessThan(32_000);
    expect(call.prompt).toContain("BH-005");
    expect(call.prompt).toContain(findingId);
    expect(call.prompt).toContain(convergencePath);
    expect(call.prompt).toContain('"problem_class": "correctness"');
    expect(call.prompt).toContain('"criterion_ref": "BH-001:AC-1"');
    expect(call.prompt).toContain('"normalized_location": "src/target.ts"');
    expect(call.prompt).toContain('"disposition": "requires_replan"');
    expect(call.prompt).toContain("The verified edge case still fails.");
    expect(call.prompt).not.toContain("BH-006");
    expect(call.prompt).not.toContain("abc123");
    expect(detectSecretMaterial(call.prompt)).toBeNull();
  });

  it("loads the full mixed cycle and prompts only unresolved findings in convergence order", async () => {
    const advisory: FindingRevisionInput = {
      ...findingRevision,
      disposition: "advisory",
      normalized_location: "src/advisory.ts",
      problem: "Advisory context must stay outside the prompt.",
    };
    const followUp: FindingRevisionInput = {
      ...findingRevision,
      disposition: "follow_up",
      normalized_location: "src/follow-up.ts",
      problem: "Follow-up context must stay outside the prompt.",
    };
    const input = await validInput(validPatch(), [advisory, followUp]);

    const result = await createReplanPatch(input);
    expect(input.brain.calls).toHaveLength(1);
    const prompt = input.brain.calls[0]!.prompt;
    expect(prompt).toContain(findingId);
    expect(prompt).not.toContain(fingerprintFinding(advisory));
    expect(prompt).not.toContain(fingerprintFinding(followUp));
    expect(prompt).not.toContain(advisory.problem);
    expect(prompt).not.toContain(followUp.problem);
    expect(JSON.parse(await readFile(result.path, "utf8")).provenance.finding_records)
      .toEqual([expect.objectContaining({ finding_id: findingId, disposition: "requires_replan" })]);
  });

  it("binds Brain cwd to the canonical manifest-authorized checkout", async () => {
    const unrelated = await validInput();
    await mkdir(join(root!, "unrelated"));
    unrelated.repo_root = join(root!, "unrelated");
    await expect(createReplanPatch(unrelated)).rejects.toThrow(/authorized checkout|canonical.*root|worktree/i);
    expect(unrelated.brain.calls).toHaveLength(0);
    expect((await readdir(join(unrelated.run_dir, "prompts"))).filter((name) => name.startsWith("replans-")))
      .toEqual([]);

    await rm(root!, { recursive: true, force: true });
    root = undefined;
    const alias = await validInput();
    await symlink(join(root!, "worktree"), join(root!, "worktree-alias"));
    alias.repo_root = join(root!, "worktree-alias");
    await createReplanPatch(alias);
    expect(alias.brain.calls[0]!.cwd).toBe(await realpath(join(root!, "worktree")));
  });

  it("uses the canonical manifest repo root when no worktree is recorded", async () => {
    const input = await validInput();
    await rewriteLegacyCheckoutSnapshot(input.run_dir, { source_commit: null, worktree_path: null, branch_name: null });
    input.repo_root = root!;

    await createReplanPatch(input);
    expect(input.brain.calls[0]!.cwd).toBe(await realpath(root!));
  });

  it("fails closed before Brain when immutable finding history is missing or corrupt", async () => {
    const missing = await validInput();
    await rm(findingHistoryPath(missing.run_dir, "BH-005"));
    await expect(createReplanPatch(missing)).rejects.toThrow(/finding|missing|ENOENT/i);
    expect(missing.brain.calls).toHaveLength(0);

    await rm(root!, { recursive: true, force: true });
    root = undefined;
    const corrupt = await validInput();
    await writeFile(findingHistoryPath(corrupt.run_dir, "BH-005"), "not-json\n");
    await expect(createReplanPatch(corrupt)).rejects.toThrow(/finding|json|corrupt/i);
    expect(corrupt.brain.calls).toHaveLength(0);
  });

  it("screens secret material from immutable finding text before constructing the Brain prompt", async () => {
    const input = await validInput();
    const path = findingHistoryPath(input.run_dir, "BH-005");
    const record = JSON.parse((await readFile(path, "utf8")).trim());
    record.problem = "token: abcdefghijklmnopqrstuvwxyz";
    await writeFile(path, `${JSON.stringify(record)}\n`);

    await expect(createReplanPatch(input)).rejects.toThrow(/secret material.*credential_assignment/i);
    expect(input.brain.calls).toHaveLength(0);
  });

  it("rejects oversized immutable finding context before invoking Brain", async () => {
    const input = await validInput();
    const path = findingHistoryPath(input.run_dir, "BH-005");
    const record = JSON.parse((await readFile(path, "utf8")).trim());
    record.problem = "x".repeat(4_001);
    await writeFile(path, `${JSON.stringify(record)}\n`);

    await expect(createReplanPatch(input)).rejects.toThrow(/too_big|4000|4,000|finding.*context/i);
    expect(input.brain.calls).toHaveLength(0);
  });

  it("allows a bounded replan prompt larger than the legacy 32 KB ceiling", async () => {
    const target = plan.work_items[0]!;
    const largePlan: BrainPlan = {
      ...plan,
      work_items: [{
        ...target,
        change_units: target.change_units.map((unit, index) => index === 0
          ? { ...unit, requirements: [...unit.requirements, "x".repeat(40_000)] }
          : unit),
      }, plan.work_items[1]!],
    };
    const input = await validInput(validPatch(), [], {}, largePlan);

    await expect(createReplanPatch(input)).resolves.toMatchObject({
      patch: { target_work_item_id: "BH-005" },
    });
    expect(Buffer.byteLength(input.brain.calls[0]!.prompt, "utf8")).toBeGreaterThan(32_000);
    expect(Buffer.byteLength(input.brain.calls[0]!.prompt, "utf8")).toBeLessThan(96_000);
  });

  it.each([
    ["password assignment", { revised_objective: "password=correct-horse-battery-staple" }],
    ["token assignment", { added_or_changed_criteria: [{ ref: "BH-001:AC-1", text: "token: abcdefghijklmnopqrstuvwxyz" }] }],
    ["OpenAI key", { changed_instructions: ["Use sk-proj-abcdefghijklmnopqrstuvwxyz012345"] }],
    ["GitHub token", { explicitly_rejected_hardening: ["ghp_abcdefghijklmnopqrstuvwxyz0123456789"] }],
    ["AWS key", { changed_instructions: ["AKIAIOSFODNN7EXAMPLE"] }],
    ["private key", { changed_instructions: ["-----BEGIN PRIVATE KEY-----"] }],
    ["JWT", { changed_instructions: ["eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnopqrstuvwxyz0123456789"] }],
  ] satisfies Array<[string, Partial<ReplanPatch>]>)("rejects secret-bearing Brain output: %s", async (_label, overrides) => {
    const input = await validInput(validPatch(overrides));

    await expect(createReplanPatch(input)).rejects.toThrow(/secret material/i);
    expect(input.brain.calls).toHaveLength(1);
    expect(await readdir(join(input.run_dir, "replans")).catch(() => [])).toEqual([]);
  });

  it("rejects a model profile that differs from the run's recorded Brain profile", async () => {
    const input = await validInput();
    input.model_profile = { ...input.model_profile, model: "unrecorded-brain" };

    await expect(createReplanPatch(input)).rejects.toThrow(/model profile.*recorded|durable.*profile/i);
    expect(input.brain.calls).toHaveLength(0);
  });

  it("rejects convergence content that does not match its manifest summary", async () => {
    const input = await validInput();
    const manifest = await readManifestV2(input.run_dir);
    await updateManifestV2(input.run_dir, {
      convergence_reports: {
        ...manifest.convergence_reports,
        "BH-005": { ...manifest.convergence_reports!["BH-005"]!, review_revision: 2 },
      },
    });

    await expect(createReplanPatch(input)).rejects.toThrow(/convergence.*provenance|review revision/i);
    expect(input.brain.calls).toHaveLength(0);
  });

  it("is idempotent for identical output and rejects conflicting create-once replay", async () => {
    const input = await validInput();
    const first = await createReplanPatch(input);
    const invocationPrompt = (await readdir(join(input.run_dir, "prompts")))
      .find((name) => name.startsWith("replans-work-item-"));
    expect(invocationPrompt).toBeDefined();
    await writeFile(join(input.run_dir, "prompts", invocationPrompt!), "replay-must-not-rewrite\n");
    const replay = await createReplanPatch(input);
    expect(replay).toEqual(first);
    expect(input.brain.calls).toHaveLength(1);
    expect(await readFile(join(input.run_dir, "prompts", invocationPrompt!), "utf8"))
      .toBe("replay-must-not-rewrite\n");

    const record = JSON.parse(await readFile(first.path, "utf8"));
    record.provenance.convergence_review_revision = 2;
    await writeFile(first.path, `${JSON.stringify(record, null, 2)}\n`);
    await expect(createReplanPatch(input)).rejects.toThrow(/already exists|different content/i);
    expect(input.brain.calls).toHaveLength(1);
  });
});

describe("approvePreparedReplanRevision", () => {
  async function pendingApproval(
    patch = validPatch(),
    prepareOrPlan: boolean | BrainPlan = true,
    additionalFindings: FindingRevisionInput[] = [],
    options: { pinRunConfiguration?: boolean; mode?: "local" | "github" } = {},
  ) {
    const prepare = typeof prepareOrPlan === "boolean" ? prepareOrPlan : true;
    const inputPlan = typeof prepareOrPlan === "boolean" ? plan : prepareOrPlan;
    const input = await validInput(patch, additionalFindings, options, inputPlan);
    const created = await createReplanPatch(input);
    const manifest = await readManifestV2(input.run_dir);
    const cyclePath = manifest.work_item_progress["BH-005"]!.review_cycle_path as string;
    const cycle = JSON.parse(await readFile(join(input.run_dir, cyclePath), "utf8"));
    const owner = "runtime:work-item:BH-005";
    await claimReviewEffect({ run_dir: input.run_dir, cycle, owner });
    await completeReviewEffect({
      run_dir: input.run_dir,
      cycle,
      owner,
      outcome: "complete",
      result: {
        blocker: "Review policy requires replanning for work item BH-005",
        replan_patch_path: created.path.slice(input.run_dir.length + 1),
      },
    });
    await updateReviewAccounting(input.run_dir, manifest.review_accounting!, {
      ...manifest.review_accounting!,
      fix_cycles_used: 2,
    });
    const current = await readManifestV2(input.run_dir);
    await updateManifestV2(input.run_dir, {
      stage: "replanning",
      last_blocker: "Review policy requires replanning for work item BH-005",
      work_item_progress: {
        ...current.work_item_progress,
        "BH-005": {
          ...current.work_item_progress["BH-005"],
          fix_cycles_used: 2,
          plan_revision: 1,
          verification_path: evidencePath,
          review_path: "reviews/BH-005/attempt-1.json",
          queue_state: "complete",
          queue_path: "action-queues/BH-005/revision-1.json",
          active_action_id: "R1-A1",
          completed_action_ids: ["R1-A1"],
          self_review_pass: 2,
          self_review_paths: { "1": "self-reviews/BH-005/pass-1.json" },
          replan_patch_path: created.path.slice(input.run_dir.length + 1),
          replan_target_work_item_id: "BH-005",
        },
      },
    });
    if (prepare) {
      await prepareReplanApprovalBoundary({
        runDir: input.run_dir,
        targetWorkItemId: "BH-005",
      });
    }
    return input;
  }

  async function expectApprovalRejectedWithoutMutation(
    input: Awaited<ReturnType<typeof pendingApproval>>,
    expected: RegExp,
  ) {
    const manifestBefore = await readFile(join(input.run_dir, "manifest.json"), "utf8");
    const eventsBefore = await readFile(join(input.run_dir, "events.jsonl"), "utf8");

    await expect(approvePreparedReplanRevision(input.run_dir, "BH-005", 2)).rejects.toThrow(expected);

    expect(await readFile(join(input.run_dir, "manifest.json"), "utf8")).toBe(manifestBefore);
    expect(await readFile(join(input.run_dir, "events.jsonl"), "utf8")).toBe(eventsBefore);
    expect(await readFile(join(input.run_dir, "plans/revision-2.md"), "utf8")).not.toBe("");
  }

  async function prepareInput(patch = validPatch()) {
    return pendingApproval(patch, false);
  }

  it.each(["local", "github"] as const)("migrates a genuine historical %s patch-only run without current config authority", async (mode) => {
    const input = await pendingApproval(validPatch(), false, [], {
      pinRunConfiguration: false,
      mode,
    });
    await expect(readFile(join(input.run_dir, "run-configuration.json"), "utf8"))
      .rejects.toThrow("ENOENT");

    const prepared = await prepareReplanApprovalBoundary({
      runDir: input.run_dir,
      targetWorkItemId: "BH-005",
    });

    const bytes = await readFile(join(input.run_dir, "run-configuration.json"), "utf8");
    const configuration = resolvedRunConfigurationSchema.parse(JSON.parse(bytes));
    expect(bytes).toBe(serializeRunConfiguration(configuration));
    expect(configuration).toMatchObject({
      repository: root,
      mode,
      research: false,
      reflection: false,
      roles: {
        brain: { ...intake.roles.brain, source: "repository_config" },
        hands: { ...intake.roles.hands, source: "repository_config" },
        verifier: { ...intake.roles.verifier, source: "repository_config" },
      },
      limits: { max_hands_fix_attempts: 3, max_replan_attempts: 2 },
      github: {
        effects: mode === "github" ? "issues_and_pull_request" : "none",
        default_remote: "origin",
      },
    });
    expect(prepared.manifest).toMatchObject({
      approval_protocol_version: 1,
      run_configuration_sha256: runConfigurationSha256(configuration),
      pending_plan_approval: { proposed_revision: 2, base_revision: 1 },
    });
    expect(prepared.request.subject.authority_contract_sha256).toBe(approvalSha256({
      mode,
      github: configuration.github,
      review_policy: prepared.manifest.review_policy_snapshot,
      release_guards: prepared.manifest.release_guards,
      warning_continuation: { source: "none" },
      merge_authority: "manual_only",
    }));
  });

  it("reuses exact historical configuration bytes after a crash before boundary CAS", async () => {
    const input = await pendingApproval(validPatch(), false, [], { pinRunConfiguration: false });
    let interrupt = true;
    await expect(prepareReplanApprovalBoundary({
      runDir: input.run_dir,
      targetWorkItemId: "BH-005",
      afterRunConfigurationWrite: async () => {
        if (interrupt) {
          interrupt = false;
          throw new Error("crash after historical config write");
        }
      },
    })).rejects.toThrow("crash after historical config write");
    const orphan = await readFile(join(input.run_dir, "run-configuration.json"), "utf8");
    expect((await readManifestV2(input.run_dir))).toMatchObject({
      approval_protocol_version: null,
      run_configuration_sha256: null,
      pending_plan_approval: null,
    });

    const recovered = await prepareReplanApprovalBoundary({
      runDir: input.run_dir,
      targetWorkItemId: "BH-005",
    });

    expect(await readFile(join(input.run_dir, "run-configuration.json"), "utf8")).toBe(orphan);
    expect(recovered.manifest).toMatchObject({
      approval_protocol_version: 1,
      run_configuration_sha256: createHash("sha256").update(orphan).digest("hex"),
      pending_plan_approval: { proposed_revision: 2 },
    });
  });

  it("recovers a historical config, plan, and request orphan after a crash before boundary CAS", async () => {
    const input = await pendingApproval(validPatch(), false, [], { pinRunConfiguration: false });
    await expect(prepareReplanApprovalBoundary({
      runDir: input.run_dir,
      targetWorkItemId: "BH-005",
      afterRequestWrite: async () => { throw new Error("crash after historical request write"); },
    })).rejects.toThrow("crash after historical request write");
    const interrupted = await readManifestV2(input.run_dir);
    expect(interrupted).toMatchObject({
      approval_protocol_version: null,
      run_configuration_sha256: null,
      pending_plan_approval: null,
    });
    expect(await requiresPinnedRuntimeAuthority(input.run_dir, interrupted, {
      allowHistoricalPatchOnlyConfigurationOrphan: true,
    })).toBe(false);

    const recovered = await reconcilePendingReplanApprovalBoundary({ runDir: input.run_dir });

    expect(recovered?.manifest).toMatchObject({
      approval_protocol_version: 1,
      pending_plan_approval: { proposed_revision: 2, base_revision: 1 },
    });
    expect(await readFile(join(input.run_dir, "plans/revision-3.md"), "utf8").catch(() => null)).toBeNull();
  });

  it("rejects CLI resume when a migrated legacy promotion retains only its rich approval event", async () => {
    const input = await pendingApproval(validPatch(), false, [], { pinRunConfiguration: false });
    const prepared = await prepareReplanApprovalBoundary({
      runDir: input.run_dir,
      targetWorkItemId: "BH-005",
    });
    await approvePreparedReplanRevision(input.run_dir, "BH-005", 2);
    const promoted = await readManifestV2(input.run_dir);
    const raw = structuredClone(promoted) as Record<string, any>;
    raw.approval_protocol_version = null;
    raw.approval_protocol_start_revision = null;
    raw.run_configuration_sha256 = null;
    raw.pending_plan_approval = null;
    for (const revision of Object.values(raw.plan_revisions) as Array<Record<string, unknown>>) {
      for (const field of [
        "origin", "base_revision", "approval_request_path", "approval_request_sha256",
        "approval_subject_sha256", "decision_contract_sha256",
      ]) delete revision[field];
    }
    await writeFile(join(input.run_dir, "manifest.json"), `${JSON.stringify(raw, null, 2)}\n`);
    await rm(join(input.run_dir, "run-configuration.json"));
    await rm(join(input.run_dir, prepared.coordinates.pending.request_path));
    const manifestBefore = await readFile(join(input.run_dir, "manifest.json"), "utf8");
    const eventsBefore = await readFile(join(input.run_dir, "events.jsonl"), "utf8");
    const progressBefore = await readFile(join(input.run_dir, "progress.jsonl"), "utf8");
    const capture = vi.spyOn(controllerProvenance, "captureControllerProvenance");
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(buildCli().parseAsync([
      "resume", input.run_dir, "--dry-run", "--json",
    ], { from: "user" })).rejects.toThrow(/modern plan approval event.*irreversible protocol marker/i);

    expect(capture).not.toHaveBeenCalled();
    expect(await readFile(join(input.run_dir, "manifest.json"), "utf8")).toBe(manifestBefore);
    expect(await readFile(join(input.run_dir, "events.jsonl"), "utf8")).toBe(eventsBefore);
    expect(await readFile(join(input.run_dir, "progress.jsonl"), "utf8")).toBe(progressBefore);
    await expect(readFile(join(input.run_dir, "run-configuration.json"), "utf8")).rejects.toThrow("ENOENT");
    await expect(readFile(join(input.run_dir, prepared.coordinates.pending.request_path), "utf8")).rejects.toThrow("ENOENT");
  });

  it.each(["advanced stage", "missing patch lineage", "conflicting configuration"] as const)(
    "does not apply the historical config-orphan exception to a near miss: %s",
    async (kind) => {
      const input = await pendingApproval(validPatch(), false, [], { pinRunConfiguration: false });
      await expect(prepareReplanApprovalBoundary({
        runDir: input.run_dir,
        targetWorkItemId: "BH-005",
        afterRunConfigurationWrite: async () => { throw new Error("interrupt historical migration"); },
      })).rejects.toThrow("interrupt historical migration");
      if (kind === "conflicting configuration") {
        const bytes = await readFile(join(input.run_dir, "run-configuration.json"), "utf8");
        const configuration = resolvedRunConfigurationSchema.parse(JSON.parse(bytes));
        await writeFile(join(input.run_dir, "run-configuration.json"), serializeRunConfiguration({
          ...configuration,
          research: !configuration.research,
        }));
      } else {
        const manifest = await readManifestV2(input.run_dir);
        const changed = structuredClone(manifest);
        if (kind === "advanced stage") changed.stage = "worktree_setup";
        else delete changed.work_item_progress[changed.current_work_item_id!]!.replan_patch_path;
        await writeFile(join(input.run_dir, "manifest.json"), JSON.stringify(changed, null, 2));
      }
      const nearMiss = await readManifestV2(input.run_dir);

      await expect(requiresPinnedRuntimeAuthority(input.run_dir, nearMiss, {
        allowHistoricalPatchOnlyConfigurationOrphan: true,
      })).rejects.toThrow(/run configuration.*protocol marker/i);
    },
  );

  it("rejects conflicting historical configuration orphan bytes without overwriting them", async () => {
    const input = await pendingApproval(validPatch(), false, [], { pinRunConfiguration: false });
    const conflict = serializeRunConfiguration(resolvedRunConfigurationSchema.parse({
      version: 1,
      repository: root,
      mode: "local",
      research: true,
      reflection: false,
      controller: {
        package_name: recordedController.package_name,
        package_version: recordedController.package_version,
        mode: recordedController.mode,
      },
      roles: {
        brain: { ...intake.roles.brain, source: "repository_config" },
        hands: { ...intake.roles.hands, source: "repository_config" },
        verifier: { ...intake.roles.verifier, source: "repository_config" },
      },
      hands_backup: null,
      limits: {
        max_hands_fix_attempts: 3,
        max_replan_attempts: 2,
        review_policy: (await readManifestV2(input.run_dir)).review_policy_snapshot,
        quality_gate: null,
      },
      github: { effects: "none", default_remote: "origin" },
    }));
    await writeFile(join(input.run_dir, "run-configuration.json"), conflict);
    const manifestBefore = await readFile(join(input.run_dir, "manifest.json"), "utf8");

    await expect(prepareReplanApprovalBoundary({
      runDir: input.run_dir,
      targetWorkItemId: "BH-005",
    })).rejects.toThrow(/conflicts with deterministic reconstruction/i);

    expect(await readFile(join(input.run_dir, "run-configuration.json"), "utf8")).toBe(conflict);
    expect(await readFile(join(input.run_dir, "manifest.json"), "utf8")).toBe(manifestBefore);
  });

  it("rejects a symlinked historical configuration orphan without changing its outside target", async () => {
    const input = await pendingApproval(validPatch(), false, [], { pinRunConfiguration: false });
    const outside = join(root!, "outside-configuration.json");
    const outsideBytes = "outside\n";
    await writeFile(outside, outsideBytes);
    await symlink(outside, join(input.run_dir, "run-configuration.json"));

    await expect(prepareReplanApprovalBoundary({
      runDir: input.run_dir,
      targetWorkItemId: "BH-005",
    })).rejects.toThrow(/symlink|owned run/i);

    expect(await readFile(outside, "utf8")).toBe(outsideBytes);
    expect((await readManifestV2(input.run_dir)).pending_plan_approval).toBeNull();
  });

  it("rejects canonical-path replacement during historical configuration creation", async () => {
    const input = await pendingApproval(validPatch(), false, [], { pinRunConfiguration: false });
    const path = join(input.run_dir, "run-configuration.json");
    const replacement = "replacement\n";

    await expect(prepareReplanApprovalBoundary({
      runDir: input.run_dir,
      targetWorkItemId: "BH-005",
      runConfigurationIoHooks: {
        afterDescriptorIo: async () => {
          await rename(path, `${path}.saved`);
          await writeFile(path, replacement);
        },
      },
    })).rejects.toThrow(/identity changed/i);

    expect(await readFile(path, "utf8")).toBe(replacement);
    expect((await readManifestV2(input.run_dir)).pending_plan_approval).toBeNull();
  });

  it.each(["controller", "roles", "review policy"] as const)("fails historical configuration reconstruction closed when %s authority is missing", async (missing) => {
    const input = await pendingApproval(validPatch(), false, [], { pinRunConfiguration: false });
    const manifestPath = join(input.run_dir, "manifest.json");
    const raw = JSON.parse(await readFile(manifestPath, "utf8"));
    if (missing === "controller") delete raw.controller_provenance;
    if (missing === "roles") raw.selected_role_profiles = {};
    if (missing === "review policy") delete raw.review_policy_snapshot;
    await writeFile(manifestPath, `${JSON.stringify(raw, null, 2)}\n`);

    await expect(prepareReplanApprovalBoundary({
      runDir: input.run_dir,
      targetWorkItemId: "BH-005",
    })).rejects.toThrow(new RegExp(missing === "roles" ? "role" : missing.replace(" ", ".*"), "i"));
    await expect(readFile(join(input.run_dir, "run-configuration.json"), "utf8"))
      .rejects.toThrow("ENOENT");
  });

  async function projectPreparedApprovalToIntegrated(
    input: Awaited<ReturnType<typeof pendingApproval>>,
    phase: "final_integrated" | "post_pr" = "final_integrated",
  ): Promise<void> {
    const integratedEvidencePath = `${verificationIdentityDirectory({ scope: "integrated", work_item_id: "integrated" })}/attempt-1/evidence.json`;
    const integratedReviewPath = "reviews/integrated/final-attempt-1.json";
    await mkdir(join(input.run_dir, dirname(integratedEvidencePath)), { recursive: true });
    await mkdir(join(input.run_dir, dirname(integratedReviewPath)), { recursive: true });
    await writeFile(join(input.run_dir, integratedEvidencePath), `${JSON.stringify({
      verification_scope: "integrated",
      work_item_id: "integrated",
      attempt: 1,
      evidence_path: integratedEvidencePath,
      commands: [], artifacts: [], artifact_checks: [], browser_evidence: [],
      created_at: "2026-07-16T12:00:00.000Z",
    })}\n`);
    await writeFile(join(input.run_dir, integratedReviewPath), `${JSON.stringify({
      work_item_id: "integrated",
      attempt: 1,
      final: true,
      decision: "replan_required",
      failure_class: "replan_required",
      blocker: null,
      blocker_code: null,
      acceptance_coverage: [],
      evidence_reviewed: [integratedEvidencePath],
      findings: [],
      residual_risks: [],
    })}\n`);
    const integratedFinding = await recordFindingRevision(input.run_dir, {
      ...findingRevision,
      work_item_id: "integrated",
      evidence_refs: [integratedEvidencePath],
    });
    const manifest = await readManifestV2(input.run_dir);
    const target = manifest.work_item_progress["BH-005"]!;
    const patchPath = target.replan_patch_path as string;
    const patchRecordPath = join(input.run_dir, patchPath);
    const patchRecord = JSON.parse(await readFile(patchRecordPath, "utf8"));
    const originalDecisionPath = target.review_cycle_path as string;
    const decision = JSON.parse(await readFile(join(input.run_dir, originalDecisionPath), "utf8"));
    const originalEffectId = decision.effect_id as string;
    decision.work_item_id = "integrated";
    decision.phase = phase;
    decision.finding_ids = [integratedFinding.finding_id];
    decision.decision.finding_ids = [integratedFinding.finding_id];
    decision.work_item_progress_reference = {
      attempts: 1,
      review_path: integratedReviewPath,
      verification_path: integratedEvidencePath,
    };
    decision.decision_path = reviewDecisionPath("integrated", decision.review_revision);
    decision.cycle_id = reviewCycleIdentity({
      work_item_id: decision.work_item_id,
      phase: decision.phase,
      review_revision: decision.review_revision,
      policy_hash: decision.policy_hash,
      finding_ids: decision.finding_ids,
      accounting_before: decision.accounting_before,
      work_item_progress_reference: decision.work_item_progress_reference,
    });
    decision.effect_id = reviewEffectIdentity(decision.cycle_id, decision.decision);
    await writeFile(join(input.run_dir, decision.decision_path), `${JSON.stringify(decision)}\n`);
    const originalCompletionPath = join(
      input.run_dir,
      "reviews/effects",
      Buffer.from(originalEffectId, "utf8").toString("base64url"),
      "completion.json",
    );
    const originalClaimPath = join(dirname(originalCompletionPath), "claim.json");
    await readFile(originalClaimPath, "utf8");
    await readFile(originalCompletionPath, "utf8");
    const projectedOwner = `runtime:${phase}:integrated`;
    const projectedClaim = {
      ...decision,
      effect_state: "in_progress",
      effect_owner: projectedOwner,
    };
    const projectedCompletion = {
      ...decision,
      effect_state: "complete",
      effect_owner: projectedOwner,
      effect_result: {
        blocker: `Review policy requires replanning BH-005 from ${phase}`,
        replan_patch_path: patchPath,
        target_work_item_id: "BH-005",
      },
    };
    const projectedEffectDir = join(
      input.run_dir,
      "reviews/effects",
      Buffer.from(decision.effect_id, "utf8").toString("base64url"),
    );
    await mkdir(projectedEffectDir, { recursive: true });
    await writeFile(join(projectedEffectDir, "claim.json"), `${JSON.stringify(projectedClaim)}\n`);
    await writeFile(join(projectedEffectDir, "completion.json"), `${JSON.stringify(projectedCompletion)}\n`);
    const originalConvergencePath = manifest.convergence_reports!["BH-005"]!.path;
    const convergencePath = "reviews/convergence/work-item-aW50ZWdyYXRlZA-plan-1-review-1.json";
    const convergence = JSON.parse(await readFile(join(input.run_dir, originalConvergencePath), "utf8"));
    convergence.work_item_id = "integrated";
    convergence.unresolved_finding_ids = [integratedFinding.finding_id];
    convergence.repeated_finding_ids = [];
    convergence.evidence_refs = [integratedReviewPath, integratedEvidencePath].sort();
    await writeFile(join(input.run_dir, convergencePath), `${JSON.stringify(convergence)}\n`);
    patchRecord.patch.unresolved_finding_ids = [integratedFinding.finding_id];
    patchRecord.provenance.convergence_report_path = convergencePath;
    patchRecord.provenance.unresolved_finding_ids = [integratedFinding.finding_id];
    patchRecord.provenance.evidence_paths = convergence.evidence_refs;
    patchRecord.provenance.finding_records = [{
      finding_id: integratedFinding.finding_id,
      problem_class: integratedFinding.problem_class,
      criterion_ref: integratedFinding.criterion_ref,
      normalized_location: integratedFinding.normalized_location,
      severity: integratedFinding.severity,
      disposition: integratedFinding.disposition,
      problem: integratedFinding.problem,
      required_fix: integratedFinding.required_fix,
      evidence_refs: integratedFinding.evidence_refs,
    }];
    await writeFile(patchRecordPath, `${JSON.stringify(patchRecord, null, 2)}\n`);
    const projected = structuredClone(manifest);
    const projectedTarget = {
      ...target,
      replan_patch_path: patchPath,
      replan_source_work_item_id: "integrated",
    } as typeof target;
    delete projectedTarget.replan_target_work_item_id;
    projected.current_work_item_id = "integrated";
    projected.convergence_reports = {
      ...projected.convergence_reports,
      integrated: { ...projected.convergence_reports!["BH-005"]!, path: convergencePath },
    };
    projected.work_item_progress = {
      ...projected.work_item_progress,
      integrated: {
        ...target,
        ...(phase === "post_pr" ? { delivery_phase: "post_pr" as const } : {}),
        review_path: integratedReviewPath,
        verification_path: integratedEvidencePath,
        review_cycle_path: decision.decision_path,
        review_effect_id: decision.effect_id,
        replan_patch_path: patchPath,
        replan_target_work_item_id: "BH-005",
      },
      "BH-005": projectedTarget,
    };
    await writeFile(join(input.run_dir, "manifest.json"), JSON.stringify(projected, null, 2));
  }

  async function completedReviewArtifacts(
    runDir: string,
    source: "direct" | "integrated",
  ) {
    const manifest = await readManifestV2(runDir);
    const sourceId = source === "integrated" ? "integrated" : "BH-005";
    const sourceProgress = manifest.work_item_progress[sourceId]!;
    const decisionPath = source === "integrated"
      ? (sourceProgress.approved_replan_history as Array<{ review_cycle_path: string }>)[0]!.review_cycle_path
      : reviewDecisionPath(sourceId, manifest.convergence_reports![sourceId]!.review_revision);
    const decision = JSON.parse(await readFile(join(runDir, decisionPath), "utf8"));
    const effectDir = `reviews/effects/${Buffer.from(decision.effect_id, "utf8").toString("base64url")}`;
    return {
      decision,
      decisionPath,
      claimPath: `${effectDir}/claim.json`,
      completionPath: `${effectDir}/completion.json`,
    };
  }

  async function replaceCompletedReviewEffect(
    runDir: string,
    decisionPath: string,
    mutate: (decision: Record<string, any>) => void,
  ): Promise<void> {
    const original = JSON.parse(await readFile(join(runDir, decisionPath), "utf8"));
    const originalEffectDir = join(
      runDir,
      "reviews/effects",
      Buffer.from(original.effect_id, "utf8").toString("base64url"),
    );
    const claim = JSON.parse(await readFile(join(originalEffectDir, "claim.json"), "utf8"));
    const completion = JSON.parse(await readFile(join(originalEffectDir, "completion.json"), "utf8"));
    mutate(original);
    original.cycle_id = reviewCycleIdentity({
      work_item_id: original.work_item_id,
      phase: original.phase,
      review_revision: original.review_revision,
      policy_hash: original.policy_hash,
      finding_ids: original.finding_ids,
      accounting_before: original.accounting_before,
      work_item_progress_reference: original.work_item_progress_reference,
    });
    original.effect_id = reviewEffectIdentity(original.cycle_id, original.decision);
    await writeFile(join(runDir, decisionPath), `${JSON.stringify(original, null, 2)}\n`);
    const replacementEffectDir = join(
      runDir,
      "reviews/effects",
      Buffer.from(original.effect_id, "utf8").toString("base64url"),
    );
    await mkdir(replacementEffectDir, { recursive: true });
    await writeFile(join(replacementEffectDir, "claim.json"), `${JSON.stringify({
      ...original,
      effect_state: "in_progress",
      effect_owner: claim.effect_owner,
    }, null, 2)}\n`);
    await writeFile(join(replacementEffectDir, "completion.json"), `${JSON.stringify({
      ...original,
      effect_state: "complete",
      effect_owner: completion.effect_owner,
      effect_result: completion.effect_result,
    }, null, 2)}\n`);
  }

  async function expectPreparationRejectedWithoutMutation(
    input: Awaited<ReturnType<typeof prepareInput>>,
    expected: RegExp,
  ) {
    const manifestBefore = await readFile(join(input.run_dir, "manifest.json"), "utf8");

    await expect(prepareReplanApprovalBoundary({
      runDir: input.run_dir,
      targetWorkItemId: "BH-005",
    })).rejects.toThrow(expected);

    expect(await readFile(join(input.run_dir, "manifest.json"), "utf8")).toBe(manifestBefore);
    expect(await readFile(join(input.run_dir, "plans/revision-2.md"), "utf8").catch(() => null)).toBeNull();
    expect(await readFile(join(input.run_dir, "approvals/plan/revision-2.json"), "utf8").catch(() => null)).toBeNull();
  }

  async function snapshotArtifactTree(directory: string, relative = ""): Promise<Record<string, string>> {
    const snapshot: Record<string, string> = {};
    for (const entry of await readdir(join(directory, relative), { withFileTypes: true })) {
      const path = join(relative, entry.name);
      if (entry.isDirectory()) Object.assign(snapshot, await snapshotArtifactTree(directory, path));
      else snapshot[path] = await readFile(join(directory, path), "utf8");
    }
    return snapshot;
  }

  it("rejects foreign replan preparation under an active owner with the full run tree unchanged", async () => {
    const input = await prepareInput();
    await acquireExecutionLease(input.run_dir, { invocationId: "runtime-a" });
    const before = await snapshotArtifactTree(input.run_dir);

    await expect(prepareReplanApprovalBoundary({
      runDir: input.run_dir,
      targetWorkItemId: "BH-005",
    })).rejects.toThrow(/active execution lease owner/i);

    expect(await snapshotArtifactTree(input.run_dir)).toEqual(before);
  });

  it("prepares the exact unapproved revision and request while preserving the executable base", async () => {
    const input = await prepareInput();
    const before = await readManifestV2(input.run_dir);

    const prepared = await prepareReplanApprovalBoundary({
      runDir: input.run_dir,
      targetWorkItemId: "BH-005",
    });

    expect(prepared.manifest).toMatchObject({
      stage: "awaiting_plan_approval",
      current_revision: 1,
      current_plan_revision: 1,
      approved_revision: 1,
      approved_plan_revision: 1,
      pending_plan_approval: {
        proposed_revision: 2,
        base_revision: 1,
        request_path: "approvals/plan/revision-2.json",
      },
    });
    expect(prepared.manifest.plan_revisions["2"]).toMatchObject({
      revision: 2,
      origin: "replan",
      base_revision: 1,
      approval_request_path: "approvals/plan/revision-2.json",
    });
    expect(prepared.manifest.run_configuration_sha256).toBe(runConfigurationSha256(
      resolvedRunConfigurationSchema.parse(JSON.parse(await readFile(join(input.run_dir, "run-configuration.json"), "utf8"))),
    ));
    expect(prepared.manifest.work_item_progress).toEqual(before.work_item_progress);
    expect(prepared.request.subject).toMatchObject({
      reason_code: "material_replan",
      plan_revision: 2,
      base_plan_revision: 1,
    });
    expect(prepared.request.delta.entries.length).toBeGreaterThan(0);
    await expect(readVerifiedPlanApprovalRequest(input.run_dir, prepared.manifest))
      .resolves.toEqual(prepared.request);

    const replay = await prepareReplanApprovalBoundary({
      runDir: input.run_dir,
      targetWorkItemId: "BH-005",
    });
    expect(replay).toEqual(prepared);
    expect(await readFile(join(input.run_dir, "plans/revision-3.md"), "utf8").catch(() => null)).toBeNull();
  });

  it("durably rejects an exact pending replan and allocates the next candidate above the rejected revision", async () => {
    const input = await prepareInput();
    await prepareReplanApprovalBoundary({ runDir: input.run_dir, targetWorkItemId: "BH-005" });
    const pendingManifest = await readManifestV2(input.run_dir);
    pendingManifest.review_accounting!.fix_cycles_used = 0;
    pendingManifest.work_item_progress["BH-005"]!.fix_cycles_used = 0;
    await writeFile(join(input.run_dir, "manifest.json"), JSON.stringify(pendingManifest, null, 2));

    let manifest = await rejectPreparedReplanRevision({
      runDir: input.run_dir,
      revision: 2,
      actor: "operator",
      reason: "The candidate does not authorize its exact generated artifact output.",
    });
    expect(manifest).toMatchObject({ stage: "replanning", pending_plan_approval: null });
    expect(manifest.plan_revisions["2"]?.origin).toBe("replan");
    expect(manifest.review_accounting?.review_revision).toBe(2);
    const progress = manifest.work_item_progress["BH-005"]!;
    expect(progress.replan_patch_path).toBeUndefined();
    const cycle = JSON.parse(await readFile(join(input.run_dir, progress.review_cycle_path!), "utf8"));
    expect(cycle.decision.action).toBe("create_replan");

    const summary = manifest.convergence_reports!["BH-005"]!;
    const report = JSON.parse(await readFile(join(input.run_dir, summary.path), "utf8"));
    const regenerated = await createReplanPatch({
      ...input,
      target_work_item: plan.work_items[0]!,
      base_plan_revision: 1,
      unresolved_finding_ids: report.unresolved_finding_ids,
      convergence_report_path: summary.path,
      evidence_paths: report.evidence_refs,
    });
    const patchPath = regenerated.path.slice(input.run_dir.length + 1);
    await claimReviewEffect({ run_dir: input.run_dir, cycle, owner: "runtime:work-item:BH-005" });
    await completeReviewEffect({
      run_dir: input.run_dir,
      cycle,
      owner: "runtime:work-item:BH-005",
      outcome: "complete",
      result: { blocker: "Review policy requires replanning for work item BH-005", replan_patch_path: patchPath },
    });
    manifest = await readManifestV2(input.run_dir);
    await updateManifestV2(input.run_dir, {
      work_item_progress: {
        ...manifest.work_item_progress,
        "BH-005": { ...manifest.work_item_progress["BH-005"]!, replan_patch_path: patchPath, replan_target_work_item_id: "BH-005" },
      },
    });

    const prepared = await prepareReplanApprovalBoundary({ runDir: input.run_dir, targetWorkItemId: "BH-005" });
    expect(prepared.coordinates).toMatchObject({ baseRevision: 1, proposedRevision: 3 });
    expect(prepared.manifest.plan_revisions["2"]?.origin).toBe("replan");
    expect(prepared.manifest.pending_plan_approval?.proposed_revision).toBe(3);
  });

  it("rejects noncanonical run-configuration bytes before exposing a replan boundary", async () => {
    const input = await prepareInput();
    const configPath = join(input.run_dir, "run-configuration.json");
    await writeFile(configPath, `${await readFile(configPath, "utf8")} `);

    await expectPreparationRejectedWithoutMutation(input, /configuration|canonical|digest/i);
  });

  it("rejects a direct replan source without its explicit self-target projection before persistence", async () => {
    const input = await prepareInput();
    const manifest = await readManifestV2(input.run_dir);
    const source = { ...manifest.work_item_progress["BH-005"] };
    delete source.replan_target_work_item_id;
    await updateManifestV2(input.run_dir, {
      work_item_progress: { ...manifest.work_item_progress, "BH-005": source },
    });

    await expectPreparationRejectedWithoutMutation(input, /source target projection lineage/i);
  });

  it.each([
    ["missing backpointer", (target: Record<string, unknown>) => {
      delete target.replan_source_work_item_id;
    }],
    ["mismatched backpointer", (target: Record<string, unknown>) => {
      target.replan_source_work_item_id = "other-source";
    }],
    ["missing patch path", (target: Record<string, unknown>) => {
      target.replan_source_work_item_id = "integrated";
      delete target.replan_patch_path;
    }],
    ["mismatched patch path", (target: Record<string, unknown>) => {
      target.replan_source_work_item_id = "integrated";
      target.replan_patch_path = "replans/wrong.json";
    }],
  ])("rejects projected-target lineage with a %s before persistence", async (_label, corruptTarget) => {
    const input = await prepareInput();
    const manifest = await readManifestV2(input.run_dir);
    const patchPath = manifest.work_item_progress["BH-005"]!.replan_patch_path;
    const target = { ...manifest.work_item_progress["BH-005"] } as Record<string, unknown>;
    delete target.replan_target_work_item_id;
    corruptTarget(target);
    await updateManifestV2(input.run_dir, {
      current_work_item_id: "integrated",
      convergence_reports: {
        ...manifest.convergence_reports,
        integrated: manifest.convergence_reports!["BH-005"]!,
      },
      work_item_progress: {
        ...manifest.work_item_progress,
        integrated: {
          status: "blocked",
          attempts: 1,
          replan_patch_path: patchPath,
          replan_target_work_item_id: "BH-005",
        },
        "BH-005": target as never,
      },
    });

    await expectPreparationRejectedWithoutMutation(input, /concrete target projection lineage/i);
  });

  it("reconciles matching plan and request orphans without allocating another revision", async () => {
    const input = await prepareInput();
    const prepared = await prepareReplanApprovalBoundary({
      runDir: input.run_dir,
      targetWorkItemId: "BH-005",
    });
    const manifestPath = join(input.run_dir, "manifest.json");
    const interrupted = structuredClone(prepared.manifest);
    interrupted.stage = "replanning";
    interrupted.pending_plan_approval = null;
    interrupted.approval_protocol_version = null;
    interrupted.approval_protocol_start_revision = null;
    interrupted.run_configuration_sha256 = null;
    delete interrupted.plan_revisions["2"];
    await writeFile(manifestPath, JSON.stringify(interrupted, null, 2));

    const recovered = await prepareReplanApprovalBoundary({
      runDir: input.run_dir,
      targetWorkItemId: "BH-005",
    });

    expect(recovered.request).toEqual(prepared.request);
    expect(recovered.manifest.pending_plan_approval).toEqual(prepared.manifest.pending_plan_approval);
    expect(await readFile(join(input.run_dir, "approvals/plan/revision-2.json"), "utf8"))
      .toBe(serializePlanApprovalRequest(prepared.request));
    expect(await readFile(join(input.run_dir, "plans/revision-3.md"), "utf8").catch(() => null)).toBeNull();
  });

  it("recovers a plan-only orphan by creating the matching request at the same revision", async () => {
    const input = await prepareInput();
    const prepared = await prepareReplanApprovalBoundary({ runDir: input.run_dir, targetWorkItemId: "BH-005" });
    const interrupted = structuredClone(prepared.manifest);
    interrupted.stage = "replanning";
    interrupted.pending_plan_approval = null;
    interrupted.approval_protocol_version = null;
    interrupted.approval_protocol_start_revision = null;
    interrupted.run_configuration_sha256 = null;
    delete interrupted.plan_revisions["2"];
    await writeFile(join(input.run_dir, "manifest.json"), JSON.stringify(interrupted, null, 2));
    await rm(join(input.run_dir, "approvals/plan/revision-2.json"));

    const recovered = await prepareReplanApprovalBoundary({ runDir: input.run_dir, targetWorkItemId: "BH-005" });

    expect(recovered.request).toEqual(prepared.request);
    expect(recovered.manifest.pending_plan_approval?.proposed_revision).toBe(2);
    expect(await readFile(join(input.run_dir, "plans/revision-3.md"), "utf8").catch(() => null)).toBeNull();
  });

  it.each([
    ["invalid", (_request: import("../../src/core/types.js").PlanApprovalRequestV1) => "{\"unexpected\":true}\n"],
    ["noncanonical", (request: import("../../src/core/types.js").PlanApprovalRequestV1) => `${JSON.stringify(request, null, 2)}\n`],
    ["conflicting", (request: import("../../src/core/types.js").PlanApprovalRequestV1) => serializePlanApprovalRequest({
      ...request,
      delta: { ...request.delta, unchanged_high_impact_categories: [] },
    })],
  ])("rejects a %s request orphan without allocating N+1", async (_kind, orphanBytes) => {
    const input = await prepareInput();
    const prepared = await prepareReplanApprovalBoundary({ runDir: input.run_dir, targetWorkItemId: "BH-005" });
    const interrupted = structuredClone(prepared.manifest);
    interrupted.stage = "replanning";
    interrupted.pending_plan_approval = null;
    interrupted.approval_protocol_version = null;
    interrupted.approval_protocol_start_revision = null;
    interrupted.run_configuration_sha256 = null;
    delete interrupted.plan_revisions["2"];
    await writeFile(join(input.run_dir, "manifest.json"), JSON.stringify(interrupted, null, 2));
    await writeFile(join(input.run_dir, "approvals/plan/revision-2.json"), orphanBytes(prepared.request));

    await expect(prepareReplanApprovalBoundary({
      runDir: input.run_dir,
      targetWorkItemId: "BH-005",
    })).rejects.toThrow(/orphaned approval request|invalid orphaned approval request/i);
    expect(await readFile(join(input.run_dir, "plans/revision-3.md"), "utf8").catch(() => null)).toBeNull();
    expect((await readManifestV2(input.run_dir)).pending_plan_approval).toBeNull();
  });

  it("blocks conflicting orphan bytes", async () => {
    const input = await prepareInput();
    await writeFile(join(input.run_dir, "plans/revision-2.md"), "conflicting orphan\n");

    await expect(prepareReplanApprovalBoundary({
      runDir: input.run_dir,
      targetWorkItemId: "BH-005",
    })).rejects.toThrow(/conflicting orphan|different content/i);
    expect((await readManifestV2(input.run_dir)).pending_plan_approval).toBeNull();
  });

  it("rejects an invalid candidate before exposing an approval boundary", async () => {
    const input = await prepareInput(validPatch({
      added_verification_commands: [{
        id: "BH-005-VERIFY-02",
        argv: ["bash", "-lc", "curl https://example.com"],
        expected_exit_code: 0,
        tier: "focused",
        satisfies: ["BH-005-AC-01"],
      }],
    }));

    await expect(prepareReplanApprovalBoundary({
      runDir: input.run_dir,
      targetWorkItemId: "BH-005",
    })).rejects.toBeInstanceOf(InvalidReplanCandidateError);
    const manifest = await readManifestV2(input.run_dir);
    expect(manifest.stage).toBe("replanning");
    expect(manifest.pending_plan_approval).toBeNull();
    expect(await readFile(join(input.run_dir, "plans/revision-2.md"), "utf8").catch(() => null)).toBeNull();
    expect(await readFile(join(input.run_dir, "approvals/plan/revision-2.json"), "utf8").catch(() => null)).toBeNull();
  });

  it("rejects a schema-valid material-replan request with a misleading deterministic delta", async () => {
    const input = await pendingApproval();
    const manifest = await readManifestV2(input.run_dir);
    const request = await readVerifiedPlanApprovalRequest(input.run_dir, manifest);
    const changed = {
      ...request,
      delta: {
        ...request.delta,
        entries: request.delta.entries.slice(1),
      },
    };
    const changedSha256 = requestSha256(changed);
    await writeFile(
      join(input.run_dir, "approvals/plan/revision-2.json"),
      serializePlanApprovalRequest(changed),
    );
    const corrupted = structuredClone(manifest);
    corrupted.pending_plan_approval!.request_sha256 = changedSha256;
    corrupted.plan_revisions["2"]!.approval_request_sha256 = changedSha256;
    await writeFile(join(input.run_dir, "manifest.json"), JSON.stringify(corrupted, null, 2));

    await expectApprovalRejectedWithoutMutation(input, /delta/i);
  });

  it("preserves concrete approved-plan authority in later replan subjects", async () => {
    const input = await prepareInput();
    const beforePreparation = await readManifestV2(input.run_dir);
    const withAuthority = structuredClone(beforePreparation);
    withAuthority.warning_continuation_authority = { actor: "original-approver", source: "approved_plan" };
    await writeFile(join(input.run_dir, "manifest.json"), JSON.stringify(withAuthority, null, 2));
    await prepareReplanApprovalBoundary({ runDir: input.run_dir, targetWorkItemId: "BH-005" });
    const prepared = await readManifestV2(input.run_dir);
    const drifted = structuredClone(prepared);
    drifted.warning_continuation_authority = { actor: "drifted-approver", source: "approved_plan" };
    await writeFile(join(input.run_dir, "manifest.json"), JSON.stringify(drifted, null, 2));

    await expectApprovalRejectedWithoutMutation(input, /authority|subject|request/i);
  });

  it("repairs direct replan approval events after pending state was durably cleared", async () => {
    const input = await pendingApproval();
    await expect(approvePreparedReplanRevisionCore(input.run_dir, "BH-005", 2, {
      approvalControllerCapture: async () => ({ provenance: recordedController, selfHosting: false }),
      transactionHooks: {
        afterPlanApprovalManifestPersisted: async () => {
          throw new Error("injected direct replan event crash");
        },
      },
    })).rejects.toThrow("injected direct replan event crash");
    const crashed = await readManifestV2(input.run_dir);
    expect(crashed.pending_plan_approval).toBeNull();
    const legacyProgress = { ...crashed.work_item_progress["BH-005"]! };
    delete legacyProgress.approved_replan_history;
    delete legacyProgress.last_approved_replan_target_work_item_id;
    delete legacyProgress.last_approved_replan_revision;
    delete legacyProgress.last_approved_replan_patch_path;
    await updateManifestV2(input.run_dir, {
      work_item_progress: { ...crashed.work_item_progress, "BH-005": legacyProgress },
    });

    await approvePreparedReplanRevision(input.run_dir, "BH-005", 2);
    await approvePreparedReplanRevision(input.run_dir, "BH-005", 2);
    expect((await readManifestV2(input.run_dir)).work_item_progress["BH-005"])
      .toMatchObject({ approved_replan_history: [expect.objectContaining({ review_revision: 1 })] });
    const events = (await readFile(join(input.run_dir, "events.jsonl"), "utf8"))
      .split("\n").filter(Boolean).map((line) => JSON.parse(line));
    expect(events.filter((event) => event.type === "plan_approved" && event.payload.revision === 2)).toHaveLength(1);
  });

  it("repairs projected replan approval events after pending state was durably cleared", async () => {
    const input = await pendingApproval();
    await projectPreparedApprovalToIntegrated(input);
    expect((await readManifestV2(input.run_dir)).work_item_progress.integrated.review_revision).toBe(1);
    await expect(approvePreparedReplanRevisionCore(input.run_dir, "BH-005", 2, {
      approvalControllerCapture: async () => ({ provenance: recordedController, selfHosting: false }),
      transactionHooks: {
        afterPlanApprovalManifestPersisted: async () => {
          throw new Error("injected projected replan event crash");
        },
      },
    })).rejects.toThrow("injected projected replan event crash");
    const crashed = await readManifestV2(input.run_dir);
    expect(crashed.pending_plan_approval).toBeNull();
    expect((crashed.work_item_progress.integrated.approved_replan_history as Array<{ review_revision?: number }>)[0]?.review_revision).toBe(1);

    await approvePreparedReplanRevision(input.run_dir, "BH-005", 2);
    await approvePreparedReplanRevision(input.run_dir, "BH-005", 2);
    const events = (await readFile(join(input.run_dir, "events.jsonl"), "utf8"))
      .split("\n").filter(Boolean).map((line) => JSON.parse(line));
    expect(events.filter((event) => event.type === "plan_approved" && event.payload.revision === 2)).toHaveLength(1);
  });

  it("replays an approved direct replan after later convergence replaces the manifest summary", async () => {
    const input = await pendingApproval();
    await approvePreparedReplanRevision(input.run_dir, "BH-005", 2);
    const approved = await readManifestV2(input.run_dir);
    await updateManifestV2(input.run_dir, {
      stage: "implementing",
      convergence_reports: {
        ...approved.convergence_reports,
        "BH-005": {
          path: "reviews/convergence/later-advance.json",
          plan_revision: 2,
          review_revision: 2,
          recommended_action: "advance",
        },
      },
    });

    await continueApprovedReplanRevision(input.run_dir, 2, {
      approvalControllerCapture: async () => ({ provenance: recordedController, selfHosting: false }),
    });
    expect((await readManifestV2(input.run_dir)).approved_revision).toBe(2);
  });

  it("rejects an exact serialized no-op before writing a request", async () => {
    const input = await prepareInput(validPatch({
      revised_objective: null,
      added_or_changed_criteria: [],
      changed_instructions: [],
    }));

    await expect(prepareReplanApprovalBoundary({
      runDir: input.run_dir,
      targetWorkItemId: "BH-005",
    })).rejects.toBeInstanceOf(NoMaterialReplanError);
    const manifest = await readManifestV2(input.run_dir);
    expect(manifest.stage).toBe("replanning");
    expect(manifest.pending_plan_approval).toBeNull();
    expect(await readFile(join(input.run_dir, "approvals/plan/revision-2.json"), "utf8").catch(() => null)).toBeNull();
    const status = await readOperatorStatus(input.run_dir, { assessAssurance: false });
    expect(status.pending_action).toBeNull();
    expect(status.approval_boundary).not.toMatch(/approve-plan|approval.*plan revision/i);
  });

  it("rejects malformed prepared replan coordinates and mandatory lineage", async () => {
    const input = await prepareInput();
    const prepared = await prepareReplanApprovalBoundary({ runDir: input.run_dir, targetWorkItemId: "BH-005" });
    const wrongRevision = structuredClone(prepared.manifest);
    wrongRevision.plan_revisions["2"]!.revision = 3;
    expect(() => resolvePendingReplanTarget(wrongRevision)).toThrow(/revision or base coordinates/i);

    const missingPatch = structuredClone(prepared.manifest);
    delete missingPatch.work_item_progress["BH-005"]!.replan_patch_path;
    expect(() => resolvePendingReplanTarget(missingPatch)).toThrow(/lineage|patch pointer/i);

    const missingProjection = structuredClone(prepared.manifest);
    delete missingProjection.work_item_progress["BH-005"]!.replan_target_work_item_id;
    expect(() => resolvePendingReplanTarget(missingProjection)).toThrow(/lineage|target projection/i);

    const missingConvergence = structuredClone(prepared.manifest);
    delete missingConvergence.convergence_reports!["BH-005"];
    expect(() => resolvePendingReplanTarget(missingConvergence)).toThrow(/lineage|convergence/i);
  });

  it("resolves a phase source to its exact concrete target and rejects split lineage", async () => {
    const input = await pendingApproval();
    const manifest = await readManifestV2(input.run_dir);
    const patchPath = manifest.work_item_progress["BH-005"]!.replan_patch_path;
    const projected = {
      ...manifest,
      current_work_item_id: "integrated",
      convergence_reports: {
        ...manifest.convergence_reports,
        integrated: manifest.convergence_reports!["BH-005"]!,
      },
      work_item_progress: {
        ...manifest.work_item_progress,
        integrated: {
          status: "blocked" as const,
          attempts: 1,
          replan_patch_path: patchPath,
          replan_target_work_item_id: "BH-005",
        },
        "BH-005": {
          ...manifest.work_item_progress["BH-005"],
          replan_source_work_item_id: "integrated",
        },
      },
    };
    expect(resolvePendingReplanTarget(projected)).toBe("BH-005");
    expect(() => resolvePendingReplanTarget({
      ...projected,
      work_item_progress: {
        ...projected.work_item_progress,
        "BH-005": { ...projected.work_item_progress["BH-005"], replan_patch_path: "replans/other.json" },
      },
    })).toThrow(/lineage/i);
    const missingSourcePointer = structuredClone(projected);
    delete missingSourcePointer.work_item_progress.integrated.replan_patch_path;
    expect(() => resolvePendingReplanTarget(missingSourcePointer)).toThrow(/source patch pointer.*missing/i);
  });

  it("projects a deleted pending-replan pointer as operational corruption", async () => {
    const input = await pendingApproval();
    const manifest = await readManifestV2(input.run_dir);
    const progress = { ...manifest.work_item_progress["BH-005"] };
    delete progress.replan_patch_path;
    await updateManifestV2(input.run_dir, {
      work_item_progress: { ...manifest.work_item_progress, "BH-005": progress },
    });

    const status = await readOperatorStatus(input.run_dir);
    expect(status.operator_state).toBe("operationally_blocked");
    expect(status.blocker).toMatch(/source patch pointer.*missing|provenance invalid/i);
  });

  it("validates the active patch against its canonical path, convergence, and completed effect", async () => {
    const input = await pendingApproval();
    const manifest = await readManifestV2(input.run_dir);
    const progress = manifest.work_item_progress["BH-005"]!;
    const cycle = JSON.parse(await readFile(join(input.run_dir, progress.review_cycle_path!), "utf8"));
    const completionPath = join(input.run_dir, "reviews", "effects", Buffer.from(cycle.effect_id, "utf8").toString("base64url"), "completion.json");
    const completion = JSON.parse(await readFile(completionPath, "utf8"));
    const activePatchPath = progress.replan_patch_path as string;
    await expect(validateActiveReplanPatch(
      input.run_dir, manifest, "BH-005", activePatchPath, cycle, completion,
    )).resolves.toMatchObject({ patch: { target_work_item_id: "BH-005", base_plan_revision: 1 } });

    const patchPath = join(input.run_dir, activePatchPath);
    const savedPatchPath = `${patchPath}.saved`;
    await rename(patchPath, savedPatchPath);
    await expect(validateActiveReplanPatch(
      input.run_dir, manifest, "BH-005", activePatchPath, cycle, completion,
    )).rejects.toThrow(/missing/i);
    await symlink(savedPatchPath, patchPath);
    await expect(validateActiveReplanPatch(
      input.run_dir, manifest, "BH-005", activePatchPath, cycle, completion,
    )).rejects.toThrow(/symlink/i);
    await rm(patchPath);
    await rename(savedPatchPath, patchPath);
    await expect(validateActiveReplanPatch(
      input.run_dir, manifest, "BH-005", activePatchPath, cycle, {
        ...completion,
        effect_result: { ...completion.effect_result, replan_patch_path: "replans/wrong.json" },
      },
    )).rejects.toThrow(/completed create_replan effect/i);
    const record = JSON.parse(await readFile(patchPath, "utf8"));
    await writeFile(patchPath, `${JSON.stringify({
      ...record,
      provenance: { ...record.provenance, convergence_review_revision: 2 },
    }, null, 2)}\n`);
    await expect(validateActiveReplanPatch(
      input.run_dir, manifest, "BH-005", activePatchPath, cycle, completion,
    )).rejects.toThrow(/path or base provenance/i);
  });

  it("rejects an otherwise valid extra finding record outside the unresolved set", async () => {
    const input = await pendingApproval();
    const manifest = await readManifestV2(input.run_dir);
    const progress = manifest.work_item_progress["BH-005"]!;
    const cycle = JSON.parse(await readFile(join(input.run_dir, progress.review_cycle_path!), "utf8"));
    const completion = JSON.parse(await readFile(join(
      input.run_dir,
      "reviews/effects",
      Buffer.from(cycle.effect_id, "utf8").toString("base64url"),
      "completion.json",
    ), "utf8"));
    const activePatchPath = progress.replan_patch_path as string;
    const patchPath = join(input.run_dir, activePatchPath);
    const record = JSON.parse(await readFile(patchPath, "utf8"));
    record.provenance.finding_records.push({
      ...record.provenance.finding_records[0],
      finding_id: `finding:${"f".repeat(64)}`,
    });
    await writeFile(patchPath, `${JSON.stringify(record, null, 2)}\n`);

    await expect(validateActiveReplanPatch(
      input.run_dir, manifest, "BH-005", activePatchPath, cycle, completion,
    )).rejects.toThrow(/exactly equal unresolved findings/i);
  });

  it("rejects a coherently retargeted record and completed effect at the old canonical path", async () => {
    const input = await pendingApproval();
    const manifest = await readManifestV2(input.run_dir);
    const progress = manifest.work_item_progress["BH-005"]!;
    const cycle = JSON.parse(await readFile(join(input.run_dir, progress.review_cycle_path!), "utf8"));
    const completion = JSON.parse(await readFile(join(
      input.run_dir,
      "reviews/effects",
      Buffer.from(cycle.effect_id, "utf8").toString("base64url"),
      "completion.json",
    ), "utf8"));
    const activePatchPath = progress.replan_patch_path as string;
    const patchPath = join(input.run_dir, activePatchPath);
    const record = JSON.parse(await readFile(patchPath, "utf8"));
    record.patch.target_work_item_id = "BH-006";
    await writeFile(patchPath, `${JSON.stringify(record, null, 2)}\n`);

    await expect(validateActiveReplanPatch(
      input.run_dir,
      manifest,
      "BH-005",
      activePatchPath,
      cycle,
      { ...completion, effect_result: { ...completion.effect_result, target_work_item_id: "BH-006" } },
    )).rejects.toThrow(/path or base provenance/i);
  });

  it("rejects byte drift in the approved base plan before applying a revision", async () => {
    const input = await pendingApproval();
    const manifest = await readManifestV2(input.run_dir);
    const basePath = manifest.plan_revisions["1"]!.path;
    await writeFile(basePath, `${await readFile(basePath, "utf8")}\n`);

    await expectApprovalRejectedWithoutMutation(input, /sha-?256|hash|approved base plan/i);
  });

  it("rejects an extra finding record at approval without mutating ledger state", async () => {
    const input = await pendingApproval();
    const manifest = await readManifestV2(input.run_dir);
    const patchPath = join(input.run_dir, manifest.work_item_progress["BH-005"]!.replan_patch_path as string);
    const record = JSON.parse(await readFile(patchPath, "utf8"));
    record.provenance.finding_records.push({
      ...record.provenance.finding_records[0],
      finding_id: `finding:${"f".repeat(64)}`,
    });
    await writeFile(patchPath, `${JSON.stringify(record, null, 2)}\n`);

    await expectApprovalRejectedWithoutMutation(input, /exactly equal unresolved findings/i);
  });

  it("rejects canonical finding-history drift at preparation and approval without mutation", async () => {
    const preparing = await prepareInput();
    await writeFile(findingHistoryPath(preparing.run_dir, "BH-005"), "");
    await expectPreparationRejectedWithoutMutation(preparing, /finding.*missing|finding.*provenance/i);

    const approving = await pendingApproval();
    await writeFile(findingHistoryPath(approving.run_dir, "BH-005"), "");
    await expectApprovalRejectedWithoutMutation(approving, /finding.*missing|finding.*provenance/i);
  });

  it("rejects deleted or substituted reviewed evidence before approval without mutation", async () => {
    const deleted = await pendingApproval();
    await rm(join(deleted.run_dir, evidencePath));
    await expectApprovalRejectedWithoutMutation(deleted, /evidence|verification|missing/i);

    const linked = await pendingApproval();
    const evidence = join(linked.run_dir, evidencePath);
    const outside = join(root!, "outside-evidence.json");
    await writeFile(outside, await readFile(evidence));
    await rm(evidence);
    await symlink(outside, evidence);
    await expectApprovalRejectedWithoutMutation(linked, /symlink|owned evidence|verification/i);
  });

  it("revalidates projected integrated canonical finding and evidence history on completed replay", async () => {
    const input = await pendingApproval();
    await projectPreparedApprovalToIntegrated(input);
    await approvePreparedReplanRevision(input.run_dir, "BH-005", 2);
    const manifestBefore = await readFile(join(input.run_dir, "manifest.json"), "utf8");
    const eventsBefore = await readFile(join(input.run_dir, "events.jsonl"), "utf8");
    await writeFile(findingHistoryPath(input.run_dir, "integrated"), "");

    await expect(approvePreparedReplanRevisionCore(input.run_dir, "BH-005", 2, {
      verifyCurrentController: false,
      completedReplay: true,
    })).rejects.toThrow(/finding.*missing|finding.*provenance/i);

    expect(await readFile(join(input.run_dir, "manifest.json"), "utf8")).toBe(manifestBefore);
    expect(await readFile(join(input.run_dir, "events.jsonl"), "utf8")).toBe(eventsBefore);
  });

  it("revalidates archived post-PR reviewed evidence on completed replay", async () => {
    const input = await pendingApproval();
    await projectPreparedApprovalToIntegrated(input, "post_pr");
    await approvePreparedReplanRevision(input.run_dir, "BH-005", 2);
    const manifestBefore = await readFile(join(input.run_dir, "manifest.json"), "utf8");
    const eventsBefore = await readFile(join(input.run_dir, "events.jsonl"), "utf8");
    const integratedEvidence = `${verificationIdentityDirectory({ scope: "integrated", work_item_id: "integrated" })}/attempt-1/evidence.json`;
    await rm(join(input.run_dir, integratedEvidence));

    await expect(approvePreparedReplanRevisionCore(input.run_dir, "BH-005", 2, {
      verifyCurrentController: false,
      completedReplay: true,
    })).rejects.toThrow(/evidence|verification|missing/i);

    expect(await readFile(join(input.run_dir, "manifest.json"), "utf8")).toBe(manifestBefore);
    expect(await readFile(join(input.run_dir, "events.jsonl"), "utf8")).toBe(eventsBefore);
  });

  it("rejects an omitted-target retarget at approval without mutating ledger state", async () => {
    const input = await pendingApproval();
    const manifest = await readManifestV2(input.run_dir);
    const patchPath = join(input.run_dir, manifest.work_item_progress["BH-005"]!.replan_patch_path as string);
    const record = JSON.parse(await readFile(patchPath, "utf8"));
    record.patch.target_work_item_id = "BH-006";
    await writeFile(patchPath, `${JSON.stringify(record, null, 2)}\n`);

    await expectApprovalRejectedWithoutMutation(input, /target|path or base provenance/i);
  });

  it("rejects a symlinked approved base plan that resolves outside plans", async () => {
    const input = await pendingApproval();
    const manifest = await readManifestV2(input.run_dir);
    const basePath = manifest.plan_revisions["1"]!.path;
    const outside = join(root!, "outside-plan.json");
    await writeFile(outside, await readFile(basePath));
    await rm(basePath);
    await symlink(outside, basePath);

    await expectApprovalRejectedWithoutMutation(input, /symlink|owned evidence|plans\/|canonical ledger path/i);
  });

  it("rejects a base plan whose approved revision hash no longer matches", async () => {
    const input = await pendingApproval();
    const manifest = await readManifestV2(input.run_dir);
    await updateManifestV2(input.run_dir, {
      plan_revisions: {
        ...manifest.plan_revisions,
        "1": { ...manifest.plan_revisions["1"]!, sha256: "0".repeat(64) },
      },
    });

    await expectApprovalRejectedWithoutMutation(input, /sha-?256|hash|approved base plan/i);
  });

  it("applies only the approved target patch and reuses its worktree", async () => {
    const input = await pendingApproval();
    await updateManifestV2(input.run_dir, {
      recovery: {
        version: 1,
        active_scope: "work-item:BH-005",
        scopes: {
          "work-item:BH-005": {
            version: 1,
            head_sequence: 1,
            head_decision_path: "recovery/scopes/test/decisions/000001.json",
            blocker_fingerprint: "a".repeat(64),
            progress_subject_sha256: "b".repeat(64),
            consecutive_without_progress: 1,
            disposition: "active",
            diagnostic_path: null,
            authorization_path: null,
          },
        },
      },
    });
    const before = await readManifestV2(input.run_dir);
    const preparedPlanBytes = await readFile(join(input.run_dir, "plans/revision-2.md"), "utf8");
    const request = await readVerifiedPlanApprovalRequest(input.run_dir, before);

    const after = await approvePreparedReplanRevision(input.run_dir, "BH-005", 2);

    expect(after.stage).toBe("worktree_setup");
    expect(after.pending_plan_approval).toBeNull();
    expect(after.delivery_state).toBe("pending");
    expect(after.worktree_path).toBe(before.worktree_path);
    expect(after.branch_name).toBe(before.branch_name);
    expect(after.source_commit).toBe(before.source_commit);
    expect(after.recovery.active_scope).toBeNull();
    expect(after.work_item_progress["BH-006"]).toEqual(before.work_item_progress["BH-006"]);
    expect(after.work_item_progress["BH-005"]).toMatchObject({
      fix_cycles_used: 0,
      plan_revision: 2,
      attempts: before.work_item_progress["BH-005"]!.attempts + 1,
      completed_action_ids: ["R1-A1"],
      self_review_pass: 2,
      self_review_paths: { "1": "self-reviews/BH-005/pass-1.json" },
      approved_replan_history: [expect.objectContaining({
        target_work_item_id: "BH-005",
        plan_revision: 2,
        review_revision: before.work_item_progress["BH-005"]!.review_revision,
      })],
    });
    expect(after.work_item_progress["BH-005"]).not.toHaveProperty("verification_path");
    expect(after.work_item_progress["BH-005"]).not.toHaveProperty("review_cycle_path");
    expect(after.work_item_progress["BH-005"]).not.toHaveProperty("queue_path");
    expect(after.review_accounting).toEqual({
      ...before.review_accounting!,
      fix_cycles_used: 0,
      plan_revision: 2,
    });
    expect(await readFile(join(input.run_dir, "plans/revision-2.md"), "utf8")).toBe(preparedPlanBytes);
    const planEvents = (await readFile(join(input.run_dir, "events.jsonl"), "utf8"))
      .split("\n").filter(Boolean).map((line) => JSON.parse(line))
      .filter((event) => event.type === "plan_approved");
    expect(planEvents).toHaveLength(2);
    expect(planEvents.at(-1)).toMatchObject({
      payload: {
        revision: 2,
        plan_sha256: request.subject.plan_sha256,
        request_sha256: before.pending_plan_approval!.request_sha256,
        approval_subject_sha256: request.approval_subject_sha256,
        approval_semantics_version: 1,
      },
    });

    const applied = JSON.parse(await readFile(join(input.run_dir, after.plan_revisions["2"]!.path), "utf8")) as BrainPlan;
    expect(applied.work_items[0]).toMatchObject({
      id: "BH-005",
      objective: [validPatch().revised_objective, ...validPatch().changed_instructions].join("\n"),
    });
    expect(applied.work_items[0]!.acceptance.map((criterion) => criterion.statement)).toEqual([
      validPatch().added_or_changed_criteria[0]!.text,
    ]);
    expect(applied.work_items[0]!.change_units[0]!.requirements).toEqual(plan.work_items[0]!.change_units[0]!.requirements);
    expect(applied.work_items[1]).toEqual(plan.work_items[1]);
  });

  it("reloads a mixed revision after replanning one exact pre-funnel item", async () => {
    const legacyPlan = structuredClone(plan);
    for (const item of legacyPlan.work_items) {
      delete item.cross_cutting_impacts;
      for (const command of item.verification_commands) delete command.tier;
    }
    Object.assign(legacyPlan.work_items[1]!, {
      file_contract: [{ path: "src/core/ledger.ts", permission: "modify", targets: ["untouched legacy resume"] }],
      change_units: [{ id: "BH-006-CH-01", path: "src/core/ledger.ts", target: "untouched legacy resume", operation: "modify", requirements: ["Preserve the untouched legacy item."] }],
      tests: [{ id: "BH-006-TEST-01", path: "src/core/ledger.ts", assertion: "The untouched legacy item remains loadable.", verification_command_ids: ["BH-006-VERIFY-01"] }],
      completion_contract: { expected_changed_files: ["src/core/ledger.ts"], allow_additional_files: false, required_acceptance_ids: ["BH-006-AC-01"] },
    });
    const input = await pendingApproval(validPatch(), legacyPlan);

    const after = await approvePreparedReplanRevision(input.run_dir, "BH-005", 2);
    const loaded = await loadVerifiedPlanBundle(input.run_dir, after, 2);

    expect(loaded.plan.work_items[0]).toHaveProperty("cross_cutting_impacts", []);
    expect(loaded.plan.work_items[1]).not.toHaveProperty("cross_cutting_impacts");
    expect(loaded.plan.work_items[1]!.verification_commands[0]).not.toHaveProperty("tier");
    expect(loaded.plan.work_items[1]!.change_units[0]!.path).toBe("src/core/ledger.ts");
  });

  it("derives execution contracts for approved added change units", async () => {
    const added = {
      id: "BH-005-CH-03",
      path: "src/runtime.ts",
      target: "report path validation",
      operation: "modify" as const,
      requirements: ["Reject absolute report paths before normalization."],
      satisfies: ["BH-005-AC-01"],
    };
    const input = await pendingApproval(validPatch({ added_change_units: [added] }));

    const after = await approvePreparedReplanRevision(input.run_dir, "BH-005", 2);
    const applied = JSON.parse(await readFile(join(input.run_dir, after.plan_revisions["2"]!.path), "utf8")) as BrainPlan;
    const target = applied.work_items[0]!;

    expect(target.file_contract).toContainEqual({
      path: added.path,
      permission: added.operation,
      targets: [added.target],
    });
    expect(target.change_units).toContainEqual({
      id: added.id,
      path: added.path,
      target: added.target,
      operation: added.operation,
      requirements: added.requirements,
    });
    expect(target.acceptance[0]!.satisfied_by).toContain(added.id);
    expect(target.completion_contract.expected_changed_files).toContain(added.path);
    expect(target.forbidden_changes[0]!.except).toContain(added.path);
  });

  it("appends an approved tiered cross-cutting command and matching impact", async () => {
    const existingCommand = {
      id: "BH-005-VERIFY-BASE-CROSS",
      argv: ["npm", "run", "typecheck"],
      expected_exit_code: 0 as const,
      tier: "cross_cutting" as const,
    };
    const existingImpact = {
      change_unit_id: "BH-005-CH-01",
      category: "runtime" as const,
      callers: ["src/BH-005.ts"],
      representative_fixtures: ["tests/BH-005.test.ts"],
      verification_command_ids: [existingCommand.id],
    };
    const baseTarget = {
      ...plan.work_items[0]!,
      verification_commands: [
        ...plan.work_items[0]!.verification_commands,
        existingCommand,
      ],
      cross_cutting_impacts: [existingImpact],
    };
    const basePlan = {
      ...plan,
      work_items: [baseTarget, plan.work_items[1]!],
    };
    const added = {
      id: "BH-005-VERIFY-02",
      argv: ["node", "node_modules/vitest/vitest.mjs", "run"],
      expected_exit_code: 0 as const,
      tier: "cross_cutting" as const,
      satisfies: ["BH-005-AC-01"],
    };
    const impact = {
      change_unit_id: "BH-005-CH-01",
      category: "shared_helper" as const,
      callers: ["src/shared-caller.ts"],
      representative_fixtures: ["tests/shared-fixture.ts"],
      verification_command_ids: [added.id],
    };
    const readOnlyContracts = [
      { path: "src/shared-caller.ts", targets: ["shared helper caller"] },
      { path: "tests/shared-fixture.ts", targets: ["representative shared fixture"] },
    ];
    const input = await pendingApproval(validPatch({
      added_verification_commands: [added],
      added_cross_cutting_impacts: [impact],
      added_read_only_file_contracts: readOnlyContracts,
    }), basePlan);

    const after = await approvePreparedReplanRevision(input.run_dir, "BH-005", 2);
    const applied = JSON.parse(await readFile(join(input.run_dir, after.plan_revisions["2"]!.path), "utf8")) as BrainPlan;

    expect(applied.work_items[0]!.verification_commands).toEqual([
      ...baseTarget.verification_commands,
      { id: added.id, argv: added.argv, expected_exit_code: 0, tier: added.tier },
    ]);
    expect(applied.work_items[0]!.cross_cutting_impacts).toEqual([existingImpact, impact]);
    expect(applied.work_items[0]!.cross_cutting_impacts![0]).toEqual(existingImpact);
    expect(applied.work_items[0]!.file_contract).toEqual(expect.arrayContaining(
      readOnlyContracts.map((contract) => ({ ...contract, permission: "read_only" })),
    ));
    expect(applied.work_items[0]!.forbidden_changes[0]!.except).toEqual(expect.arrayContaining(
      readOnlyContracts.map((contract) => contract.path),
    ));
    expect(applied.work_items[0]!.completion_contract.expected_changed_files).not.toEqual(expect.arrayContaining(
      readOnlyContracts.map((contract) => contract.path),
    ));
    expect(applied.work_items[1]).toEqual(plan.work_items[1]);
  });

  it("replaces an approved same-key cross-cutting impact without duplicating it", async () => {
    const existingCommand = {
      id: "BH-005-VERIFY-BASE-CROSS",
      argv: ["npm", "run", "typecheck"],
      expected_exit_code: 0 as const,
      tier: "cross_cutting" as const,
    };
    const existingImpact = {
      change_unit_id: plan.work_items[0]!.change_units[0]!.id,
      category: "runtime" as const,
      callers: ["src/BH-005.ts"],
      representative_fixtures: ["tests/BH-005.test.ts"],
      verification_command_ids: [existingCommand.id],
    };
    const replacementImpact = {
      ...existingImpact,
      callers: ["src/BH-005.ts", "tests/BH-005.test.ts"],
    };
    const baseTarget = {
      ...plan.work_items[0]!,
      verification_commands: [...plan.work_items[0]!.verification_commands, existingCommand],
      cross_cutting_impacts: [existingImpact],
    };
    const input = await pendingApproval(validPatch({
      added_cross_cutting_impacts: [replacementImpact],
    }), {
      ...plan,
      work_items: [baseTarget, plan.work_items[1]!],
    });

    const after = await approvePreparedReplanRevision(input.run_dir, "BH-005", 2);
    const applied = JSON.parse(await readFile(join(input.run_dir, after.plan_revisions["2"]!.path), "utf8")) as BrainPlan;

    expect(applied.work_items[0]!.cross_cutting_impacts).toEqual([replacementImpact]);
  });

  it("promotes an approved read-only file contract to modify", async () => {
    const target = plan.work_items[0]!;
    const promotedPath = "src/inspected.ts";
    const promotedTarget = "approved write boundary";
    const inspectedContract = {
      path: promotedPath,
      permission: "read_only" as const,
      targets: ["inspected dependency"],
    };
    const baseTarget = {
      ...target,
      file_contract: [...target.file_contract, inspectedContract],
      forbidden_changes: target.forbidden_changes.map((forbidden) => forbidden.path === "*"
        ? { ...forbidden, except: [...forbidden.except, promotedPath] }
        : forbidden),
    };
    const input = await pendingApproval(validPatch({
      added_change_units: [{
        id: "BH-005-CH-READ-ONLY-PROMOTION",
        path: promotedPath,
        target: promotedTarget,
        operation: "modify",
        requirements: ["Modify the previously inspected dependency."],
        satisfies: [target.acceptance[0]!.id],
      }],
    }), {
      ...plan,
      work_items: [baseTarget, plan.work_items[1]!],
    });

    const after = await approvePreparedReplanRevision(input.run_dir, "BH-005", 2);
    const applied = JSON.parse(await readFile(join(input.run_dir, after.plan_revisions["2"]!.path), "utf8")) as BrainPlan;

    expect(applied.work_items[0]!.file_contract).toContainEqual({
      ...inspectedContract,
      permission: "modify",
      targets: [promotedTarget],
    });
  });

  it("appends an approved focused command through explicit acceptance linkage", async () => {
    const added = {
      id: "BH-005-VERIFY-02",
      argv: ["node", "node_modules/vitest/vitest.mjs", "run", "tests/BH-005.test.ts", "--reporter=dot"],
      expected_exit_code: 0 as const,
      tier: "focused" as const,
      satisfies: ["BH-005-AC-01"],
    };
    const input = await pendingApproval(validPatch({ added_verification_commands: [added] }));

    const after = await approvePreparedReplanRevision(input.run_dir, "BH-005", 2);
    const applied = JSON.parse(await readFile(join(input.run_dir, after.plan_revisions["2"]!.path), "utf8")) as BrainPlan;
    const target = applied.work_items[0]!;

    expect(target.verification_commands).toContainEqual({
      id: added.id,
      argv: added.argv,
      expected_exit_code: 0,
      tier: added.tier,
    });
    expect(target.acceptance[0]!.satisfied_by).toContain(added.id);
  });

  it("does not reset twice after duplicate approval", async () => {
    const input = await pendingApproval();
    const first = await approvePreparedReplanRevision(input.run_dir, "BH-005", 2);
    const second = await approvePreparedReplanRevision(input.run_dir, "BH-005", 2);
    expect(second).toEqual(first);
    let events = (await readFile(join(input.run_dir, "events.jsonl"), "utf8"))
      .split("\n").filter(Boolean).map((line) => JSON.parse(line));
    expect(events.filter((event) => event.type === "approved_replan_attempt_reset")).toHaveLength(1);

    await writeFile(join(input.run_dir, "events.jsonl"), `${events
      .filter((event) => event.type !== "approved_replan_attempt_reset")
      .map((event) => JSON.stringify(event)).join("\n")}\n`);
    await approvePreparedReplanRevision(input.run_dir, "BH-005", 2);
    await approvePreparedReplanRevision(input.run_dir, "BH-005", 2);
    events = (await readFile(join(input.run_dir, "events.jsonl"), "utf8"))
      .split("\n").filter(Boolean).map((line) => JSON.parse(line));
    expect(events.filter((event) => event.type === "approved_replan_attempt_reset")).toHaveLength(1);
  });

  it("rejects a canonical event-log replacement during the reset-event append", async () => {
    const input = await pendingApproval();
    const eventsPath = join(input.run_dir, "events.jsonl");
    const replacement = "replacement-events\n";
    await expect(approvePreparedReplanRevisionCore(input.run_dir, "BH-005", 2, {
      approvalControllerCapture: captureRecordedController,
      eventIoHooks: {
        resetAppend: {
          afterDescriptorIo: async () => {
            await rename(eventsPath, `${eventsPath}.saved`);
            await writeFile(eventsPath, replacement);
          },
        },
      },
    })).rejects.toThrow(/identity|changed|owned/i);
    expect(await readFile(eventsPath, "utf8")).toBe(replacement);
  });

  it("rejects a symlink swap before the reset-event append without changing its target", async () => {
    const input = await pendingApproval();
    const eventsPath = join(input.run_dir, "events.jsonl");
    const outside = join(input.repo_root, "outside-events.jsonl");
    const outsideBytes = "outside-events-must-not-change\n";
    await writeFile(outside, outsideBytes);
    await expect(approvePreparedReplanRevisionCore(input.run_dir, "BH-005", 2, {
      approvalControllerCapture: captureRecordedController,
      eventIoHooks: {
        resetAppend: {
          beforeDescriptorOpen: async () => {
            await rename(eventsPath, `${eventsPath}.saved`);
            await symlink(outside, eventsPath);
          },
        },
      },
    })).rejects.toThrow(/symlink|loop|nofollow|owned/i);
    expect(await readFile(outside, "utf8")).toBe(outsideBytes);
  });

  it.each([
    "status drift",
    "fix cycle drift",
    "retained cleared pointer",
    "mismatched reset event",
    "duplicate reset event",
  ] as const)("fails an immediate default retry closed on %s without repairing events", async (tamper) => {
    const input = await pendingApproval();
    await approvePreparedReplanRevision(input.run_dir, "BH-005", 2);
    const eventsPath = join(input.run_dir, "events.jsonl");
    if (tamper === "status drift" || tamper === "fix cycle drift" || tamper === "retained cleared pointer") {
      const manifest = await readManifestV2(input.run_dir);
      await updateManifestV2(input.run_dir, {
        work_item_progress: {
          ...manifest.work_item_progress,
          "BH-005": tamper === "status drift"
            ? { ...manifest.work_item_progress["BH-005"], status: "in_progress" }
            : tamper === "fix cycle drift"
              ? { ...manifest.work_item_progress["BH-005"], fix_cycles_used: 1 }
              : {
                ...manifest.work_item_progress["BH-005"],
                review_cycle_path: reviewDecisionPath("BH-005", 1),
              },
        },
      });
    } else {
      const events = (await readFile(eventsPath, "utf8")).split("\n").filter(Boolean)
        .map((line) => JSON.parse(line));
      const reset = events.find((event) => event.type === "approved_replan_attempt_reset");
      const tampered = tamper === "mismatched reset event"
        ? events.map((event) => event === reset
          ? {
              ...event,
              event_id: "approved-replan-reset:drifted",
              payload: { ...event.payload, work_item_id: "BH-006" },
            }
          : event)
        : [...events, { ...reset, event_id: "approved-replan-reset:duplicate" }];
      await writeFile(eventsPath, `${tampered.map((event) => JSON.stringify(event)).join("\n")}\n`);
    }
    const eventsBefore = await readFile(eventsPath, "utf8");

    await expect(approvePreparedReplanRevision(input.run_dir, "BH-005", 2))
      .rejects.toThrow(/progress|reset|event|approval|replan/i);
    expect(await readFile(eventsPath, "utf8")).toBe(eventsBefore);
  });

  it("fully verifies and observationally continues a genuinely promoted advanced replan", async () => {
    const input = await pendingApproval();
    await approvePreparedReplanRevision(input.run_dir, "BH-005", 2);
    await updateManifestV2(input.run_dir, { stage: "implementing" });
    const beforeManifest = await readFile(join(input.run_dir, "manifest.json"), "utf8");
    const beforeEvents = await readFile(join(input.run_dir, "events.jsonl"), "utf8");

    const continued = await continueApprovedReplanRevision(input.run_dir, 2, {
      approvalControllerCapture: async () => ({ provenance: recordedController, selfHosting: false }),
    });

    expect(continued.stage).toBe("implementing");
    expect(await readFile(join(input.run_dir, "manifest.json"), "utf8")).toBe(beforeManifest);
    expect(await readFile(join(input.run_dir, "events.jsonl"), "utf8")).toBe(beforeEvents);
  });

  it("observationally continues a genuinely completed direct target", async () => {
    const input = await pendingApproval();
    await approvePreparedReplanRevision(input.run_dir, "BH-005", 2);
    const promoted = await readManifestV2(input.run_dir);
    await updateManifestV2(input.run_dir, {
      stage: "implementing",
      work_item_progress: {
        ...promoted.work_item_progress,
        "BH-005": {
          ...promoted.work_item_progress["BH-005"],
          status: "complete",
          commit_sha: "c".repeat(40),
        },
      },
    });
    const beforeManifest = await readFile(join(input.run_dir, "manifest.json"), "utf8");
    const beforeEvents = await readFile(join(input.run_dir, "events.jsonl"), "utf8");

    const continued = await continueApprovedReplanRevision(input.run_dir, 2, {
      approvalControllerCapture: async () => ({ provenance: recordedController, selfHosting: false }),
    });

    expect(continued.work_item_progress["BH-005"]?.status).toBe("complete");
    expect(await readFile(join(input.run_dir, "manifest.json"), "utf8")).toBe(beforeManifest);
    expect(await readFile(join(input.run_dir, "events.jsonl"), "utf8")).toBe(beforeEvents);
  });

  it("repairs both genuine approval crash-gap events only at the immediate promoted boundary", async () => {
    const input = await pendingApproval();
    await approvePreparedReplanRevision(input.run_dir, "BH-005", 2);
    const eventsPath = join(input.run_dir, "events.jsonl");
    const events = (await readFile(eventsPath, "utf8")).split("\n").filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((event) => !(event.type === "plan_approved" && event.payload?.revision === 2)
        && event.type !== "approved_replan_attempt_reset");
    await writeFile(eventsPath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);

    await continueApprovedReplanRevision(input.run_dir, 2, {
      approvalControllerCapture: async () => ({ provenance: recordedController, selfHosting: false }),
    });
    await continueApprovedReplanRevision(input.run_dir, 2, {
      approvalControllerCapture: async () => ({ provenance: recordedController, selfHosting: false }),
    });

    const repaired = (await readFile(eventsPath, "utf8")).split("\n").filter(Boolean)
      .map((line) => JSON.parse(line));
    expect(repaired.filter((event) => event.type === "plan_approved" && event.payload?.revision === 2)).toHaveLength(1);
    expect(repaired.filter((event) => event.type === "approved_replan_attempt_reset")).toHaveLength(1);
  });

  it.each([
    "plan approval",
    "approved reset",
    "both",
  ] as const)("plain CLI resume repairs the missing replan %s event before controller preflight", async (missing) => {
    const input = await pendingApproval();
    await approvePreparedReplanRevision(input.run_dir, "BH-005", 2);
    const eventsPath = join(input.run_dir, "events.jsonl");
    const retained = (await readFile(eventsPath, "utf8")).split("\n").filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((event) => !((missing === "plan approval" || missing === "both")
          && event.type === "plan_approved" && event.payload?.revision === 2)
        && !((missing === "approved reset" || missing === "both")
          && event.type === "approved_replan_attempt_reset"));
    await writeFile(eventsPath, `${retained.map((event) => JSON.stringify(event)).join("\n")}\n`);
    let repairedBeforeController = false;
    vi.spyOn(controllerProvenance, "assertCurrentControllerMatches").mockImplementationOnce(async () => {
      const events = (await readFile(eventsPath, "utf8")).split("\n").filter(Boolean)
        .map((line) => JSON.parse(line));
      repairedBeforeController = events.filter((event) => event.type === "plan_approved"
        && event.payload?.revision === 2).length === 1
        && events.filter((event) => event.type === "approved_replan_attempt_reset").length === 1;
      throw new Error("controller preflight stop");
    });
    const capture = vi.spyOn(controllerProvenance, "captureControllerProvenance");

    await expect(buildCli().parseAsync([
      "resume", input.run_dir, "--dry-run", "--json",
    ], { from: "user" })).rejects.toThrow("controller preflight stop");

    expect(repairedBeforeController).toBe(true);
    expect(capture).not.toHaveBeenCalled();
  });

  it("rejects a canonical event-log replacement during multi-event repair", async () => {
    const input = await pendingApproval();
    await approvePreparedReplanRevision(input.run_dir, "BH-005", 2);
    const eventsPath = join(input.run_dir, "events.jsonl");
    const events = (await readFile(eventsPath, "utf8")).split("\n").filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((event) => !(event.type === "plan_approved" && event.payload?.revision === 2)
        && event.type !== "approved_replan_attempt_reset");
    await writeFile(eventsPath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
    const replacement = "replacement-events\n";
    await expect(continueApprovedReplanRevision(input.run_dir, 2, {
      approvalControllerCapture: captureRecordedController,
      eventIoHooks: {
        repairAppend: {
          afterDescriptorIo: async () => {
            await rename(eventsPath, `${eventsPath}.saved`);
            await writeFile(eventsPath, replacement);
          },
        },
      },
    })).rejects.toThrow(/identity|changed|owned/i);
    expect(await readFile(eventsPath, "utf8")).toBe(replacement);
  });

  it("rejects a canonical event-log replacement during completed replay read", async () => {
    const input = await pendingApproval();
    await approvePreparedReplanRevision(input.run_dir, "BH-005", 2);
    await updateManifestV2(input.run_dir, { stage: "implementing" });
    const eventsPath = join(input.run_dir, "events.jsonl");
    const replacement = "replacement-events\n";
    await expect(continueApprovedReplanRevision(input.run_dir, 2, {
      approvalControllerCapture: captureRecordedController,
      eventIoHooks: {
        resetRead: {
          afterDescriptorIo: async () => {
            await rename(eventsPath, `${eventsPath}.saved`);
            await writeFile(eventsPath, replacement);
          },
        },
      },
    })).rejects.toThrow(/identity|changed|owned/i);
    expect(await readFile(eventsPath, "utf8")).toBe(replacement);
  });

  it.each([
    "missing plan approval event",
    "missing reset event",
    "mismatched reset event",
    "target progress drift",
    "patch drift",
    "convergence drift",
  ] as const)("fails an advanced genuine replan replay closed on %s", async (tamper) => {
    const input = await pendingApproval();
    await approvePreparedReplanRevision(input.run_dir, "BH-005", 2);
    await updateManifestV2(input.run_dir, { stage: "implementing" });
    const manifest = await readManifestV2(input.run_dir);
    if (tamper.includes("event")) {
      const eventsPath = join(input.run_dir, "events.jsonl");
      let events = (await readFile(eventsPath, "utf8")).split("\n").filter(Boolean)
        .map((line) => JSON.parse(line));
      if (tamper === "missing plan approval event") {
        events = events.filter((event) => !(event.type === "plan_approved" && event.payload?.revision === 2));
      } else if (tamper === "missing reset event") {
        events = events.filter((event) => event.type !== "approved_replan_attempt_reset");
      } else {
        events = events.map((event) => event.type === "approved_replan_attempt_reset"
          ? { ...event, payload: { ...event.payload, work_item_id: "BH-006" } }
          : event);
      }
      await writeFile(eventsPath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
    } else if (tamper === "target progress drift") {
      await updateManifestV2(input.run_dir, {
        work_item_progress: {
          ...manifest.work_item_progress,
          "BH-005": { ...manifest.work_item_progress["BH-005"], plan_revision: 1 },
        },
      });
    } else if (tamper === "patch drift") {
      const reset = (await readFile(join(input.run_dir, "events.jsonl"), "utf8")).split("\n").filter(Boolean)
        .map((line) => JSON.parse(line))
        .find((event) => event.type === "approved_replan_attempt_reset");
      const patchPath = reset.payload.replan_patch_path as string;
      const patch = JSON.parse(await readFile(join(input.run_dir, patchPath), "utf8"));
      patch.patch.revised_objective = "Tampered after promotion";
      await writeFile(join(input.run_dir, patchPath), `${JSON.stringify(patch, null, 2)}\n`);
    } else {
      const convergencePath = manifest.convergence_reports!["BH-005"]!.path;
      const convergence = JSON.parse(await readFile(join(input.run_dir, convergencePath), "utf8"));
      await writeFile(join(input.run_dir, convergencePath), `${JSON.stringify({
        ...convergence,
        review_revision: convergence.review_revision + 1,
      }, null, 2)}\n`);
    }

    await expect(continueApprovedReplanRevision(input.run_dir, 2, {
      approvalControllerCapture: async () => ({ provenance: recordedController, selfHosting: false }),
    })).rejects.toThrow(/approval|replan|event|progress|patch|convergence/i);
  });

  it("fails an advanced integrated-source replay closed on archived lineage drift", async () => {
    const input = await pendingApproval();
    await projectPreparedApprovalToIntegrated(input);
    await approvePreparedReplanRevision(input.run_dir, "BH-005", 2);
    await updateManifestV2(input.run_dir, { stage: "implementing" });
    const manifest = await readManifestV2(input.run_dir);
    await updateManifestV2(input.run_dir, {
      work_item_progress: {
        ...manifest.work_item_progress,
        integrated: {
          ...manifest.work_item_progress.integrated,
          last_approved_replan_patch_path: "replans/wrong.json",
        },
      },
    });

    await expect(continueApprovedReplanRevision(input.run_dir, 2, {
      approvalControllerCapture: async () => ({ provenance: recordedController, selfHosting: false }),
    })).rejects.toThrow(/lineage|patch|source|replan/i);
  });

  it.each([
    ["direct", "decision", "missing"],
    ["direct", "decision", "drifted"],
    ["direct", "completion", "missing"],
    ["direct", "completion", "drifted"],
    ["integrated", "decision", "missing"],
    ["integrated", "decision", "drifted"],
    ["integrated", "completion", "missing"],
    ["integrated", "completion", "drifted"],
  ] as const)("fails %s advanced replay closed on %s artifact %s", async (source, artifact, tamper) => {
    const input = await pendingApproval();
    if (source === "integrated") await projectPreparedApprovalToIntegrated(input);
    await approvePreparedReplanRevision(input.run_dir, "BH-005", 2);
    await updateManifestV2(input.run_dir, { stage: "implementing" });
    const manifest = await readManifestV2(input.run_dir);
    const sourceId = source === "integrated" ? "integrated" : "BH-005";
    const sourceProgress = manifest.work_item_progress[sourceId]!;
    const decisionPath = source === "integrated"
      ? (sourceProgress.approved_replan_history as Array<{ review_cycle_path: string }>)[0]!.review_cycle_path
      : reviewDecisionPath(sourceId, manifest.convergence_reports![sourceId]!.review_revision);
    const decision = JSON.parse(await readFile(join(input.run_dir, decisionPath), "utf8"));
    const artifactPath = artifact === "decision"
      ? decisionPath
      : `reviews/effects/${Buffer.from(decision.effect_id, "utf8").toString("base64url")}/completion.json`;
    if (tamper === "missing") {
      await rm(join(input.run_dir, artifactPath));
    } else {
      const value = JSON.parse(await readFile(join(input.run_dir, artifactPath), "utf8"));
      if (artifact === "decision") value.policy_hash = "f".repeat(64);
      else value.accounting_before = { ...value.accounting_before, fix_cycles_used: value.accounting_before.fix_cycles_used + 1 };
      await writeFile(join(input.run_dir, artifactPath), `${JSON.stringify(value, null, 2)}\n`);
    }

    await expect(continueApprovedReplanRevision(input.run_dir, 2, {
      approvalControllerCapture: async () => ({ provenance: recordedController, selfHosting: false }),
    })).rejects.toThrow(/review|decision|effect|completion|provenance|lineage/i);
  });

  it.each([
    ["direct", "immediate", "missing claim"],
    ["direct", "immediate", "claim owner"],
    ["direct", "immediate", "completion owner"],
    ["direct", "advanced", "missing claim"],
    ["direct", "advanced", "claim owner"],
    ["direct", "advanced", "completion owner"],
    ["integrated", "immediate", "missing claim"],
    ["integrated", "immediate", "claim owner"],
    ["integrated", "immediate", "completion owner"],
    ["integrated", "advanced", "missing claim"],
    ["integrated", "advanced", "claim owner"],
    ["integrated", "advanced", "completion owner"],
  ] as const)("fails %s %s retry closed on %s drift", async (source, timing, tamper) => {
    const input = await pendingApproval();
    if (source === "integrated") await projectPreparedApprovalToIntegrated(input);
    await approvePreparedReplanRevision(input.run_dir, "BH-005", 2);
    if (timing === "advanced") await updateManifestV2(input.run_dir, { stage: "implementing" });
    const artifacts = await completedReviewArtifacts(input.run_dir, source);
    if (tamper === "missing claim") {
      await rm(join(input.run_dir, artifacts.claimPath));
    } else {
      const path = tamper === "claim owner" ? artifacts.claimPath : artifacts.completionPath;
      const artifact = JSON.parse(await readFile(join(input.run_dir, path), "utf8"));
      artifact.effect_owner = "runtime:wrong-owner";
      await writeFile(join(input.run_dir, path), `${JSON.stringify(artifact, null, 2)}\n`);
    }

    const replay = timing === "immediate"
      ? approvePreparedReplanRevision(input.run_dir, "BH-005", 2)
      : continueApprovedReplanRevision(input.run_dir, 2, {
          approvalControllerCapture: async () => ({ provenance: recordedController, selfHosting: false }),
        });
    await expect(replay).rejects.toThrow(/review|effect|claim|completion|owner|provenance/i);
  });

  it("does not repair immediate crash-gap events before exact effect provenance passes", async () => {
    const input = await pendingApproval();
    await expect(approvePreparedReplanRevisionCore(input.run_dir, "BH-005", 2, {
      approvalControllerCapture: async () => ({ provenance: recordedController, selfHosting: false }),
      transactionHooks: {
        afterPlanApprovalManifestPersisted: async () => {
          throw new Error("injected pre-event crash");
        },
      },
    })).rejects.toThrow("injected pre-event crash");
    const artifacts = await completedReviewArtifacts(input.run_dir, "direct");
    await rm(join(input.run_dir, artifacts.claimPath));
    const eventsBefore = await readFile(join(input.run_dir, "events.jsonl"), "utf8");

    await expect(approvePreparedReplanRevision(input.run_dir, "BH-005", 2))
      .rejects.toThrow(/review|effect|claim|provenance/i);
    expect(await readFile(join(input.run_dir, "events.jsonl"), "utf8")).toBe(eventsBefore);
  });

  const advisoryFinding: FindingRevisionInput = {
    ...findingRevision,
    severity: "low",
    disposition: "advisory",
    normalized_location: "src/advisory.ts",
    problem: "A non-blocking issue should remain in the canonical cycle.",
    required_fix: "Track the advisory without blocking the replan.",
  };
  const followUpFinding: FindingRevisionInput = {
    ...findingRevision,
    severity: "low",
    disposition: "follow_up",
    normalized_location: "src/follow-up.ts",
    problem: "A follow-up should remain in the canonical cycle.",
    required_fix: "Retain the follow-up for later work.",
  };

  it("continues a direct replay with the genuine complete finding set and evidence reference", async () => {
    const input = await pendingApproval(validPatch(), true, [advisoryFinding, followUpFinding]);
    await approvePreparedReplanRevision(input.run_dir, "BH-005", 2);
    await updateManifestV2(input.run_dir, { stage: "implementing" });

    await expect(continueApprovedReplanRevision(input.run_dir, 2, {
      approvalControllerCapture: async () => ({ provenance: recordedController, selfHosting: false }),
    })).resolves.toMatchObject({ approved_plan_revision: 2, stage: "implementing" });
  });

  it("rejects a recomputed direct cycle that drops a durable advisory finding", async () => {
    const input = await pendingApproval(validPatch(), true, [advisoryFinding, followUpFinding]);
    await approvePreparedReplanRevision(input.run_dir, "BH-005", 2);
    await updateManifestV2(input.run_dir, { stage: "implementing" });
    const artifacts = await completedReviewArtifacts(input.run_dir, "direct");
    const advisoryId = fingerprintFinding(advisoryFinding);
    await replaceCompletedReviewEffect(input.run_dir, artifacts.decisionPath, (decision) => {
      decision.finding_ids = decision.finding_ids.filter((findingId: string) => findingId !== advisoryId);
    });

    await expect(continueApprovedReplanRevision(input.run_dir, 2, {
      approvalControllerCapture: async () => ({ provenance: recordedController, selfHosting: false }),
    })).rejects.toThrow(/finding|cycle|provenance/i);
  });

  it("rejects a recomputed direct cycle with a drifted evidence reference", async () => {
    const input = await pendingApproval(validPatch(), true, [advisoryFinding, followUpFinding]);
    await approvePreparedReplanRevision(input.run_dir, "BH-005", 2);
    await updateManifestV2(input.run_dir, { stage: "implementing" });
    const artifacts = await completedReviewArtifacts(input.run_dir, "direct");
    await replaceCompletedReviewEffect(input.run_dir, artifacts.decisionPath, (decision) => {
      decision.work_item_progress_reference = {
        ...decision.work_item_progress_reference,
        verification_path: "verification/local/QkgtMDA1/attempt-1/drifted.json",
      };
    });

    await expect(continueApprovedReplanRevision(input.run_dir, 2, {
      approvalControllerCapture: async () => ({ provenance: recordedController, selfHosting: false }),
    })).rejects.toThrow(/evidence|verification|cycle|provenance/i);
  });

  it("routes CLI exact material replay through genuine completed-promotion verification before runtime checkout preflight", async () => {
    const input = await pendingApproval();
    await approvePreparedReplanRevision(input.run_dir, "BH-005", 2);
    await updateManifestV2(input.run_dir, { stage: "implementing" });
    vi.spyOn(controllerProvenance, "captureControllerProvenance").mockResolvedValue({
      provenance: recordedController,
      selfHosting: false,
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const promote = vi.spyOn(replanWorkflow, "approvePreparedReplanRevision");

    await expect(buildCli().parseAsync([
      "approve-plan", input.run_dir, "--revision", "2", "--dry-run",
    ], { from: "user" })).rejects.toThrow(/deterministic repository\/run identity/i);

    expect(promote).not.toHaveBeenCalled();
    expect(log.mock.calls.some((call) => call[0] === "Exact approval already recorded for this subject; continuing the approved run."))
      .toBe(true);
    expect((await readManifestV2(input.run_dir)).approved_revision).toBe(2);
  });

  it("rejects approval when target, base, effect, convergence, or requested revision drifts", async () => {
    const input = await pendingApproval();
    await expect(approvePreparedReplanRevision(input.run_dir, "BH-006", 2)).rejects.toThrow(/target/i);
    await expect(approvePreparedReplanRevision(input.run_dir, "BH-005", 3)).rejects.toThrow(/revision/i);
    const manifest = await readManifestV2(input.run_dir);
    await updateManifestV2(input.run_dir, {
      work_item_progress: {
        ...manifest.work_item_progress,
        "BH-005": { ...manifest.work_item_progress["BH-005"], review_effect_id: `review-effect:${"0".repeat(64)}` },
      },
    });
    await expect(approvePreparedReplanRevision(input.run_dir, "BH-005", 2)).rejects.toThrow(/effect|provenance/i);
  });
});
