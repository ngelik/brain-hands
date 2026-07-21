import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  approvePlanRevision,
  readManifestV2,
  recordPlan,
  transitionRun,
  updateManifestV2,
  writeTextArtifact,
} from "../../src/core/ledger.js";
import type {
  BrainPlan,
  ImplementationResult,
  ReviewPolicyDecision,
  RunManifestV2,
  VerificationEvidence,
  VerifierReview,
} from "../../src/core/types.js";
import { verificationEvidencePath } from "../../src/core/types.js";
import { recoveryProgressSubjectV1Schema } from "../../src/core/schema.js";
import {
  authorizeDiagnosticResume,
  diagnosticRecoveryAuthorizationPath,
  diagnosticRecoveryArtifactV1Schema,
  diagnosticRecoveryConsumptionPath,
  reconcileRecoveryJournal,
  recoveryDecisionArtifactV1Schema,
} from "../../src/workflow/recovery-ledger.js";
import {
  buildRecoveryProgressSubject,
  gateOperationalRecoveryAttempt,
  gateReviewPolicyEffect as gateReviewPolicyEffectRaw,
  recordAuthorizedRecoveryOutcome,
  recordOperationalRecovery,
} from "../../src/workflow/recovery-runtime.js";
import { progressSubjectSha256, recoveryScopePathComponent } from "../../src/workflow/recovery-policy.js";
import { createLegacyRunLedgerV2 } from "../fixtures/legacy-run.js";
import { executionSpec } from "../fixtures/execution-spec.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const findingId = `finding:${"a".repeat(64)}`;
const secondFindingId = `finding:${"b".repeat(64)}`;

const plan: BrainPlan = {
  summary: "Recover one work item",
  assumptions: [],
  research: [],
  research_sources: ["repo"],
  architecture: "local",
  risks: [],
  work_items: [executionSpec("item-1")],
  integration_verification: [["npm", "test"]],
};

function implementation(step = "a", workItemId = "item-1"): ImplementationResult {
  return {
    work_item_id: workItemId,
    changed_files: ["src/item.ts"],
    tests_added_or_changed: ["tests/item.test.ts"],
    commands_attempted: [],
    completed_steps: [step],
    remaining_risks: [],
  };
}

function verification(workItemId = "item-1"): VerificationEvidence {
  const evidencePath = verificationEvidencePath({ scope: "local", work_item_id: workItemId }, 1);
  const root = evidencePath.slice(0, -"evidence.json".length);
  return {
    verification_scope: "local",
    work_item_id: workItemId,
    attempt: 1,
    evidence_path: evidencePath,
    commands: [{
      command: "npm test",
      argv: ["npm", "test"],
      exit_code: 0,
      timed_out: false,
      error_code: null,
      error_message: null,
      signal: null,
      stdout_path: `${root}command-1.stdout.txt`,
      stderr_path: `${root}command-1.stderr.txt`,
      result_path: `${root}command-1.json`,
    }],
    artifacts: [],
    artifact_checks: [],
    browser_evidence: [],
    created_at: "2026-07-16T00:00:00.000Z",
  };
}

function review(workItemId = "item-1"): VerifierReview {
  return {
    work_item_id: workItemId,
    attempt: 1,
    final: false,
    decision: "request_changes",
    failure_class: "implementation_failure",
    blocker: null,
    blocker_code: null,
    acceptance_coverage: [],
    evidence_reviewed: [],
    findings: [{
      severity: "medium",
      file: "src/item.ts",
      line: 1,
      acceptance_criterion: "The item works",
      problem: "The item is incomplete",
      required_fix: "Complete the item",
      re_verification: [["npm", "test"]],
    }],
    residual_risks: [],
  };
}

const policyDecision: ReviewPolicyDecision = {
  action: "fix",
  reason_code: "fix_budget_available",
  finding_ids: [findingId],
  policy_revision: 1,
  authorization_required: false,
};

async function setup(): Promise<{ root: string; runDir: string; manifest: RunManifestV2 }> {
  const root = await mkdtemp(join(tmpdir(), "brain-hands-recovery-runtime-"));
  roots.push(root);
  const ledger = await createLegacyRunLedgerV2({
    repoRoot: root,
    originalRequest: "Recover one work item",
  });
  await transitionRun(ledger.runDir, "preflight");
  await transitionRun(ledger.runDir, "brain_planning");
  await transitionRun(ledger.runDir, "awaiting_plan_approval");
  await transitionRun(ledger.runDir, "worktree_setup");
  await transitionRun(ledger.runDir, "implementing");
  await transitionRun(ledger.runDir, "verifying");
  await transitionRun(ledger.runDir, "verifier_review");
  await transitionRun(ledger.runDir, "fixing");
  const recorded = await recordPlan(ledger.runDir, `${JSON.stringify(plan)}\n`);
  await approvePlanRevision(ledger.runDir, recorded.revision, { actor: "test" });
  const manifest = await updateManifestV2(ledger.runDir, {
    source_commit: "c".repeat(40),
    work_item_progress: {
      "item-1": {
        status: "in_progress",
        attempts: 1,
        quality_recovery_attempts: 0,
      },
    },
  });
  const withReviewCycleAccounting = {
    ...manifest,
    review_accounting: {
      ...manifest.review_accounting!,
      review_revision: 1,
    },
  };
  await writeFile(join(ledger.runDir, "manifest.json"), `${JSON.stringify(withReviewCycleAccounting)}\n`);
  return { root, runDir: ledger.runDir, manifest: withReviewCycleAccounting };
}

async function persistEvidence(runDir: string, input: {
  implementationPath?: string;
  implementationValue?: ImplementationResult;
  verificationPath?: string;
  verificationValue?: VerificationEvidence;
  reviewPath?: string;
  reviewValue?: VerifierReview;
} = {}) {
  const implementationPath = input.implementationPath ?? "implementation/item-1/attempt-1.json";
  const verificationValue = input.verificationValue ?? verification();
  const verificationPath = input.verificationPath ?? verificationValue.evidence_path;
  const reviewPath = input.reviewPath ?? "reviews/item-1/attempt-1.json";
  await writeTextArtifact(
    runDir,
    implementationPath,
    `${JSON.stringify(input.implementationValue ?? implementation())}\n`,
  );
  await writeTextArtifact(runDir, verificationPath, `${JSON.stringify(verificationValue)}\n`);
  await writeTextArtifact(runDir, reviewPath, `${JSON.stringify(input.reviewValue ?? review())}\n`);
  return { implementationPath, verificationPath, reviewPath };
}

async function progressInput(runDir: string, manifest: RunManifestV2) {
  const paths = await persistEvidence(runDir);
  const progress = await buildRecoveryProgressSubject({
    runDir,
    manifest,
    workItemId: "item-1",
    findingIds: [findingId],
    implementationPath: paths.implementationPath,
    verificationPath: paths.verificationPath,
    reviewPath: paths.reviewPath,
    reviewRevision: 1,
  });
  return { paths, progress };
}

function ownedEvidenceRefs(paths: Awaited<ReturnType<typeof persistEvidence>>) {
  return {
    implementation_path: paths.implementationPath,
    verification_path: paths.verificationPath,
    review_path: paths.reviewPath,
  };
}

async function recordOperationalStop(input: {
  runDir: string;
  progress: Awaited<ReturnType<typeof buildRecoveryProgressSubject>>;
  paths: Awaited<ReturnType<typeof persistEvidence>>;
}) {
  const base = {
    runDir: input.runDir,
    scopeId: "work-item:item-1",
    operation: "work-item-fix",
    requestedEffect: "fix" as const,
    requestedEffectReason: "fix_budget_available",
    findingIds: [findingId],
    classification: {
      failure_class: "operational_blocker" as const,
      blocker_code: "network_failure",
    },
    error: new Error("network unavailable"),
    progress: input.progress,
    ownedEvidenceRefs: ownedEvidenceRefs(input.paths),
  };
  await recordOperationalRecovery({ ...base, effectAttemptId: "operational-attempt:first" });
  return recordOperationalRecovery({ ...base, effectAttemptId: "operational-attempt:second" });
}

async function recoveryBytes(runDir: string, scopeId = "work-item:item-1") {
  const component = recoveryScopePathComponent(scopeId);
  const decisions = join(runDir, "recovery/scopes", component, "decisions");
  return {
    manifest: await readFile(join(runDir, "manifest.json")),
    events: await readFile(join(runDir, "events.jsonl")),
    decisions: await readdir(decisions).catch((error: NodeJS.ErrnoException) =>
      error.code === "ENOENT" ? [] : Promise.reject(error)),
  };
}

async function gateReviewPolicyEffect(
  input: Parameters<typeof gateReviewPolicyEffectRaw>[0],
): ReturnType<typeof gateReviewPolicyEffectRaw> {
  if (input.reviewCyclePath !== undefined) return gateReviewPolicyEffectRaw(input);
  let manifest = await readManifestV2(input.runDir);
  const accounting = manifest.review_accounting;
  if (accounting === undefined) throw new Error("Recovery runtime test requires review accounting");
  const reviewRevision = Math.max(1, accounting.review_revision);
  if (accounting.review_revision !== reviewRevision) {
    manifest = {
      ...manifest,
      review_accounting: { ...accounting, review_revision: reviewRevision },
    };
    await writeFile(join(input.runDir, "manifest.json"), `${JSON.stringify(manifest)}\n`);
  }
  const path = `reviews/decisions/recovery-${sha(input.effectAttemptId)}.json`;
  const cycle = {
    cycle_id: `review-cycle:${sha(`cycle:${input.effectAttemptId}`)}`,
    work_item_id: "item-1",
    phase: "work_item" as const,
    review_revision: reviewRevision,
    policy_hash: sha("policy"),
    finding_ids: [...input.decision.finding_ids],
    accounting_before: {
      ...manifest.review_accounting!,
      review_revision: reviewRevision - 1,
    },
    decision_path: path,
    effect_id: input.effectAttemptId,
    effect_state: "pending" as const,
    decision: input.decision,
  };
  const existing = await readFile(join(input.runDir, path), "utf8").catch(
    (error: NodeJS.ErrnoException) => error.code === "ENOENT" ? null : Promise.reject(error),
  );
  if (existing === null) {
    await mkdir(join(input.runDir, "reviews/decisions"), { recursive: true });
    await writeFile(join(input.runDir, path), `${JSON.stringify(cycle)}\n`);
  }
  return gateReviewPolicyEffectRaw({ ...input, reviewCyclePath: path });
}

describe("buildRecoveryProgressSubject", () => {
  it("uses validated content identity rather than owned artifact paths", async () => {
    const { runDir, manifest } = await setup();
    const firstPath = "implementation/item-1/a.json";
    const secondPath = "implementation/item-1/b.json";
    const bytes = `${JSON.stringify(implementation("a"))}\n`;
    await writeTextArtifact(runDir, firstPath, bytes);
    await writeTextArtifact(runDir, secondPath, bytes);

    const first = await buildRecoveryProgressSubject({
      runDir,
      manifest,
      workItemId: "item-1",
      findingIds: [findingId],
      implementationPath: firstPath,
      reviewRevision: 1,
    });
    const second = await buildRecoveryProgressSubject({
      runDir,
      manifest,
      workItemId: "item-1",
      findingIds: [findingId],
      implementationPath: secondPath,
      reviewRevision: 1,
    });

    expect(first).toEqual(second);
    expect(first.subject.approved_plan_sha256).toBe(
      manifest.plan_revisions[String(manifest.approved_plan_revision)]!.sha256,
    );
    expect(first.subject.candidate_commit).toBe(manifest.source_commit);
  });

  it("changes the subject when one validated content byte changes", async () => {
    const { runDir, manifest } = await setup();
    const firstPath = "implementation/item-1/a.json";
    const secondPath = "implementation/item-1/b.json";
    await writeTextArtifact(runDir, firstPath, `${JSON.stringify(implementation("a"))}\n`);
    await writeTextArtifact(runDir, secondPath, `${JSON.stringify(implementation("b"))}\n`);

    const first = await buildRecoveryProgressSubject({
      runDir, manifest, workItemId: "item-1", findingIds: [], implementationPath: firstPath,
    });
    const second = await buildRecoveryProgressSubject({
      runDir, manifest, workItemId: "item-1", findingIds: [], implementationPath: secondPath,
    });

    expect(first.sha256).not.toBe(second.sha256);
    expect(first.subject.implementation_artifact_sha256)
      .not.toBe(second.subject.implementation_artifact_sha256);
  });

  it("hashes implementation, verification, and review bytes only after schema-aware owned reads", async () => {
    const { runDir, manifest } = await setup();
    const paths = await persistEvidence(runDir);
    const result = await buildRecoveryProgressSubject({
      runDir,
      manifest,
      workItemId: "item-1",
      findingIds: [secondFindingId, findingId],
      implementationPath: paths.implementationPath,
      verificationPath: paths.verificationPath,
      reviewPath: paths.reviewPath,
      reviewRevision: 4,
    });

    expect(result.subject).toEqual({
      version: 1,
      approved_plan_sha256: manifest.plan_revisions[String(manifest.approved_plan_revision)]!.sha256,
      candidate_commit: manifest.source_commit,
      implementation_artifact_sha256: sha(await readFile(join(runDir, paths.implementationPath), "utf8")),
      verification_artifact_sha256: sha(await readFile(join(runDir, paths.verificationPath), "utf8")),
      review_artifact_sha256: sha(await readFile(join(runDir, paths.reviewPath), "utf8")),
      review_revision: 4,
      finding_ids: [findingId, secondFindingId],
    });
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each([
    "item-1:quality-gate:1:baseline",
    "item-1:quality-gate:1:baseline:authority-0123456789abcdef",
  ])("accepts an owned quality-gate verification identity for its base work item: %s", async (identity) => {
    const { runDir, manifest } = await setup();
    const verificationValue = verification(identity);
    await writeTextArtifact(
      runDir,
      verificationValue.evidence_path,
      `${JSON.stringify(verificationValue)}\n`,
    );

    await expect(buildRecoveryProgressSubject({
      runDir,
      manifest,
      workItemId: "item-1",
      findingIds: [],
      verificationPath: verificationValue.evidence_path,
    })).resolves.toMatchObject({
      subject: { verification_artifact_sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
    });
  });

  it.each([
    ["absolute", (runDir: string, root: string) => join(runDir, "implementation/item-1/a.json")],
    ["traversal", (_runDir: string, _root: string) => "../outside.json"],
    ["outside owned root", (_runDir: string, _root: string) => "reviews/item-1/a.json"],
  ])("rejects an %s implementation reference", async (_label, pathFor) => {
    const { root, runDir, manifest } = await setup();
    await expect(buildRecoveryProgressSubject({
      runDir,
      manifest,
      workItemId: "item-1",
      findingIds: [],
      implementationPath: pathFor(runDir, root),
    })).rejects.toThrow(/relative|traversal|confined|implementation/i);
  });

  it("rejects symlinked, schema-invalid, and foreign-work-item evidence", async () => {
    const { root, runDir, manifest } = await setup();
    const target = join(root, "target.json");
    await writeFile(target, `${JSON.stringify(implementation())}\n`);
    await mkdir(join(runDir, "implementation/item-1"), { recursive: true });
    await symlink(target, join(runDir, "implementation/item-1/link.json"));
    await writeTextArtifact(runDir, "implementation/item-1/invalid.json", "{}\n");
    await writeTextArtifact(
      runDir,
      "implementation/item-1/foreign.json",
      `${JSON.stringify(implementation("a", "other-item"))}\n`,
    );

    for (const implementationPath of [
      "implementation/item-1/link.json",
      "implementation/item-1/invalid.json",
      "implementation/item-1/foreign.json",
    ]) {
      await expect(buildRecoveryProgressSubject({
        runDir, manifest, workItemId: "item-1", findingIds: [], implementationPath,
      })).rejects.toThrow(/symlink|invalid|required|work item|belongs|expected/i);
    }
  });

  it("rejects a manifest from another run, a non-approved revision, and noncanonical or duplicate finding IDs", async () => {
    const first = await setup();
    const second = await setup();
    const missingApproval = { ...first.manifest, approved_revision: null, approved_plan_revision: null };

    await expect(buildRecoveryProgressSubject({
      runDir: first.runDir,
      manifest: second.manifest,
      workItemId: "item-1",
      findingIds: [],
    })).rejects.toThrow(/manifest|run/i);
    await expect(buildRecoveryProgressSubject({
      runDir: first.runDir,
      manifest: missingApproval,
      workItemId: "item-1",
      findingIds: [],
    })).rejects.toThrow(/approved plan revision/i);
    for (const findingIds of [["plain-finding"], [findingId, findingId]]) {
      await expect(buildRecoveryProgressSubject({
        runDir: first.runDir,
        manifest: first.manifest,
        workItemId: "item-1",
        findingIds,
      })).rejects.toThrow(/finding/i);
    }
  });
});

describe("recovery runtime adapter", () => {
  it("preserves the review-policy decision and accounting while allowing the first effect", async () => {
    const { runDir, manifest } = await setup();
    const { paths, progress } = await progressInput(runDir, manifest);
    const beforeAccounting = (await readManifestV2(runDir)).review_accounting;

    const result = await gateReviewPolicyEffect({
      runDir,
      scopeId: "work-item:item-1",
      operation: "work-item-fix",
      effectAttemptId: `review-effect:${"1".repeat(64)}`,
      decision: policyDecision,
      progress,
      ownedEvidenceRefs: {
        implementation_path: paths.implementationPath,
        verification_path: paths.verificationPath,
        review_path: paths.reviewPath,
      },
    });

    expect(result.guard_action).toBe("allow_next_effect");
    expect(result.policy_decision).toEqual(policyDecision);
    expect(result.effect_attempt_id).toBe(`review-effect:${"1".repeat(64)}`);
    expect(result.mode).toBe("ordinary");
    expect((await readManifestV2(runDir)).review_accounting).toEqual(beforeAccounting);
  });

  it("records explicit operational classifications without parsing prose or consuming a fix cycle", async () => {
    const { runDir, manifest } = await setup();
    const { paths, progress } = await progressInput(runDir, manifest);
    const beforeAccounting = (await readManifestV2(runDir)).review_accounting;

    const result = await recordOperationalRecovery({
      runDir,
      scopeId: "work-item:item-1",
      operation: "work-item-fix",
      effectAttemptId: "operational-attempt:1",
      requestedEffect: "fix",
      requestedEffectReason: "fix_budget_available",
      findingIds: [findingId],
      classification: {
        failure_class: "operational_blocker",
        blocker_code: "network_failure",
      },
      error: new Error("arbitrary changing prose that must not be parsed"),
      progress,
      ownedEvidenceRefs: {
        implementation_path: paths.implementationPath,
        verification_path: paths.verificationPath,
        review_path: paths.reviewPath,
      },
    });

    expect(result.guard_action).toBe("await_external_fix");
    expect(result.recovery_decision.observation.blocker_code).toBe("network_failure");
    expect((await readManifestV2(runDir)).review_accounting).toEqual(beforeAccounting);
  });

  it("keeps local and GitHub operational recovery decisions identical while preserving mode fields", async () => {
    const local = await setup();
    const github = await setup();
    const githubBefore = await updateManifestV2(github.runDir, {
      work_item_issue_map: { "item-1": 17 },
      pull_request_numbers: [42],
      github_ids: {
        ...github.manifest.github_ids,
        work_item_issue_map: { "item-1": 17 },
        pull_request_numbers: [42],
        pull_request_urls: { "42": "https://github.test/acme/repo/pull/42" },
      },
    });
    const localInput = await progressInput(local.runDir, local.manifest);
    const githubInput = await progressInput(github.runDir, githubBefore);
    expect(githubInput.progress).toEqual(localInput.progress);

    const record = (runDir: string, current: typeof localInput) => recordOperationalRecovery({
      runDir,
      scopeId: "work-item:item-1",
      operation: "verifier-invocation",
      effectAttemptId: "operational-attempt:parity",
      requestedEffect: "retry_operation",
      requestedEffectReason: "retryable_runtime_failure",
      findingIds: [findingId],
      classification: { failure_class: "invocation_failure" as const, blocker_code: "verifier_invocation_failed" },
      error: new Error("same failure"),
      progress: current.progress,
      ownedEvidenceRefs: ownedEvidenceRefs(current.paths),
    });
    const [localResult, githubResult] = await Promise.all([
      record(local.runDir, localInput),
      record(github.runDir, githubInput),
    ]);
    const projection = (result: typeof localResult) => ({
      guard_action: result.guard_action,
      scope_id: result.recovery_decision.scope_id,
      blocker_fingerprint: result.recovery_decision.observation.blocker_fingerprint,
      progress_subject_sha256: result.recovery_decision.observation.progress_subject_sha256,
      consecutive_without_progress: result.recovery_decision.next_state.consecutive_without_progress,
    });

    expect(projection(githubResult)).toEqual(projection(localResult));
    expect(projection(localResult)).toMatchObject({
      guard_action: "await_external_fix",
      scope_id: "work-item:item-1",
      consecutive_without_progress: 1,
    });
    expect((await readManifestV2(github.runDir))).toMatchObject({
      work_item_issue_map: githubBefore.work_item_issue_map,
      pull_request_numbers: githubBefore.pull_request_numbers,
      github_ids: githubBefore.github_ids,
    });
  });

  it("fails closed without a recovery decision for corrupt persisted state", async () => {
    const { runDir, manifest } = await setup();
    const { progress } = await progressInput(runDir, manifest);
    const scopeRoot = join(runDir, "recovery/scopes", recoveryScopePathComponent("work-item:item-1"));

    await expect(recordOperationalRecovery({
      runDir,
      scopeId: "work-item:item-1",
      operation: "work-item-fix",
      effectAttemptId: "corrupt-attempt:1",
      requestedEffect: "fix",
      requestedEffectReason: "fix_budget_available",
      findingIds: [findingId],
      classification: { failure_class: "corrupt_state", blocker_code: "corrupt_state" },
      error: new Error("do not parse me"),
      progress,
    })).rejects.toThrow(/corrupt state|non-authorizable|fail.closed/i);
    await expect(readdir(scopeRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects reusing a pre-effect gate ID for a conflicting operational outcome", async () => {
    const { runDir, manifest } = await setup();
    const { progress } = await progressInput(runDir, manifest);
    const effectAttemptId = `review-effect:${"2".repeat(64)}`;
    await gateReviewPolicyEffect({
      runDir,
      scopeId: "work-item:item-1",
      operation: "work-item-fix",
      effectAttemptId,
      decision: policyDecision,
      progress,
    });

    await expect(recordOperationalRecovery({
      runDir,
      scopeId: "work-item:item-1",
      operation: "work-item-fix",
      effectAttemptId,
      requestedEffect: "fix",
      requestedEffectReason: "fix_budget_available",
      findingIds: [findingId],
      classification: { failure_class: "invocation_failure", blocker_code: "hands_invocation_failed" },
      error: new Error("failed"),
      progress,
    })).rejects.toThrow(/same effect attempt|conflict/i);
  });

  it("writes one strict diagnostic with current and previous observations on repeated no-progress", async () => {
    const { runDir, manifest } = await setup();
    const { paths, progress } = await progressInput(runDir, manifest);
    const base = {
      runDir,
      scopeId: "work-item:item-1",
      operation: "work-item-fix",
      decision: policyDecision,
      progress,
      ownedEvidenceRefs: {
        implementation_path: paths.implementationPath,
        verification_path: paths.verificationPath,
        review_path: paths.reviewPath,
      },
    };
    const first = await gateReviewPolicyEffect({ ...base, effectAttemptId: `review-effect:${"3".repeat(64)}` });
    const stopped = await gateReviewPolicyEffect({ ...base, effectAttemptId: `review-effect:${"4".repeat(64)}` });

    expect(first.guard_action).toBe("allow_next_effect");
    expect(stopped.guard_action).toBe("diagnostic_stop");
    if (first.mode !== "ordinary" || stopped.mode !== "ordinary") {
      throw new Error("Expected ordinary recovery decisions before authorization");
    }
    expect(stopped.diagnostic_path).toBe(stopped.recovery_decision.next_state.diagnostic_path);
    const diagnostic = diagnosticRecoveryArtifactV1Schema.parse(JSON.parse(
      await readFile(join(runDir, stopped.diagnostic_path!), "utf8"),
    ));
    expect(diagnostic.previous_observation).toEqual(first.recovery_decision.observation);
    expect(diagnostic.current_observation).toEqual(stopped.recovery_decision.observation);
    expect(diagnostic.policy_decision).toEqual(policyDecision);
    expect(diagnostic.review_accounting).toEqual((await readManifestV2(runDir)).review_accounting);
    expect(diagnostic.quality_recovery_usage).toEqual({
      work_item_id: "item-1",
      active_hands_profile: "primary",
      attempts_used: 0,
    });
    expect(diagnostic.owned_evidence_refs).toEqual({
      implementation_path: paths.implementationPath,
      verification_path: paths.verificationPath,
      review_path: paths.reviewPath,
    });
  });

  it("writes an exhausted-stop diagnostic at the canonical decision sequence", async () => {
    const { runDir, manifest } = await setup();
    const { paths, progress } = await progressInput(runDir, manifest);
    const stopDecision: ReviewPolicyDecision = {
      ...policyDecision,
      action: "stop",
      reason_code: "fix_limit_reached",
    };
    const result = await gateReviewPolicyEffect({
      runDir,
      scopeId: "work-item:item-1",
      operation: "work-item-fix",
      effectAttemptId: `review-effect:${"5".repeat(64)}`,
      decision: stopDecision,
      progress,
      ownedEvidenceRefs: ownedEvidenceRefs(paths),
    });

    expect(result.guard_action).toBe("exhausted_stop");
    expect(result.diagnostic_path).toBe(
      `recovery/scopes/${recoveryScopePathComponent("work-item:item-1")}/diagnostics/000001.json`,
    );
    const diagnostic = diagnosticRecoveryArtifactV1Schema.parse(JSON.parse(
      await readFile(join(runDir, result.diagnostic_path!), "utf8"),
    ));
    expect(diagnostic.previous_observation).toBeNull();
    expect(diagnostic.policy_decision).toEqual(stopDecision);
  });

  it("replays a diagnostic create-once after a crash between decision and diagnostic writes", async () => {
    const { runDir, manifest } = await setup();
    const { paths, progress } = await progressInput(runDir, manifest);
    const base = {
      runDir,
      scopeId: "work-item:item-1",
      operation: "work-item-fix",
      decision: policyDecision,
      progress,
      ownedEvidenceRefs: ownedEvidenceRefs(paths),
    };
    await gateReviewPolicyEffect({ ...base, effectAttemptId: `review-effect:${"6".repeat(64)}` });
    let crash = true;
    const interrupted = { ...base, effectAttemptId: `review-effect:${"7".repeat(64)}`, hooks: {
      afterRecoveryDecision: async () => {
        if (crash) {
          crash = false;
          throw new Error("simulated crash after recovery decision");
        }
      },
    } };
    await expect(gateReviewPolicyEffect(interrupted)).rejects.toThrow("simulated crash");

    const replay = await gateReviewPolicyEffect(interrupted);
    const bytes = await readFile(join(runDir, replay.diagnostic_path!));
    const stable = await gateReviewPolicyEffect(interrupted);
    expect(stable.recovery_decision).toEqual(replay.recovery_decision);
    expect(await readFile(join(runDir, stable.diagnostic_path!))).toEqual(bytes);
  });

  it("replays the same review effect against its original observation stage after a stage transition", async () => {
    const { runDir, manifest } = await setup();
    const { paths, progress } = await progressInput(runDir, manifest);
    const effectAttemptId = `review-effect:${"8".repeat(64)}`;
    const base = {
      runDir,
      scopeId: "work-item:item-1",
      operation: "work-item-fix",
      decision: policyDecision,
      effectAttemptId,
      progress,
      ownedEvidenceRefs: ownedEvidenceRefs(paths),
    };
    await updateManifestV2(runDir, { stage: "verifier_review" });
    const first = await gateReviewPolicyEffect(base);
    await updateManifestV2(runDir, { stage: "fixing" });

    await expect(gateReviewPolicyEffect(base)).rejects.toThrow("Same effect attempt replay conflicts");
    const replay = await gateReviewPolicyEffect({ ...base, observationStage: "verifier_review" });

    expect(replay.recovery_decision).toEqual(first.recovery_decision);
    expect(replay.effect_attempt_id).toBe(effectAttemptId);
  });

  it("repairs the exact diagnostic before reconciling a terminal decision interrupted after decision persistence", async () => {
    const { runDir, manifest } = await setup();
    const { paths, progress } = await progressInput(runDir, manifest);
    const base = {
      runDir,
      scopeId: "work-item:item-1",
      operation: "work-item-fix",
      decision: policyDecision,
      progress,
      ownedEvidenceRefs: ownedEvidenceRefs(paths),
    };
    await gateReviewPolicyEffect({ ...base, effectAttemptId: `review-effect:${"1".repeat(64)}` });
    await expect(gateReviewPolicyEffect({
      ...base,
      effectAttemptId: `review-effect:${"2".repeat(64)}`,
      hooks: { afterRecoveryDecision: async () => { throw new Error("crash after decision"); } },
    })).rejects.toThrow("crash after decision");

    await expect(reconcileRecoveryJournal(runDir)).resolves.toBeDefined();
    const diagnosticPath = join(
      runDir,
      "recovery/scopes",
      recoveryScopePathComponent("work-item:item-1"),
      "diagnostics/000002.json",
    );
    expect(JSON.parse(await readFile(diagnosticPath, "utf8"))).toMatchObject({
      guard_action: "diagnostic_stop",
      journal_sequence: 2,
    });
  });

  it("recreates and revalidates a missing review-policy diagnostics directory before projection or authorization", async () => {
    const { runDir, manifest } = await setup();
    const { paths, progress } = await progressInput(runDir, manifest);
    const base = {
      runDir,
      scopeId: "work-item:item-1",
      operation: "work-item-fix",
      decision: policyDecision,
      progress,
      ownedEvidenceRefs: ownedEvidenceRefs(paths),
    };
    await gateReviewPolicyEffect({ ...base, effectAttemptId: `review-effect:${"1".repeat(64)}` });
    const diagnostics = join(
      runDir,
      "recovery/scopes",
      recoveryScopePathComponent("work-item:item-1"),
      "diagnostics",
    );
    await expect(gateReviewPolicyEffect({
      ...base,
      effectAttemptId: `review-effect:${"2".repeat(64)}`,
      hooks: {
        afterRecoveryDecision: async () => {
          await rm(diagnostics, { recursive: true, force: true });
          throw new Error("crash after decision with no diagnostics directory");
        },
      },
    })).rejects.toThrow("crash after decision with no diagnostics directory");

    const beforeEvents = await readFile(join(runDir, "events.jsonl"), "utf8");
    await expect(reconcileRecoveryJournal(runDir)).resolves.toBeDefined();
    const diagnosticPath = join(diagnostics, "000002.json");
    const repaired = await readFile(diagnosticPath);
    expect(await readFile(join(runDir, "events.jsonl"), "utf8")).not.toBe(beforeEvents);

    await rm(diagnostics, { recursive: true });
    await expect(reconcileRecoveryJournal(runDir)).resolves.toBeDefined();
    expect(await readFile(diagnosticPath)).toEqual(repaired);
    await expect(authorizeDiagnosticResume({
      runDir,
      actor: "operator",
      note: "Retry only after exact diagnostic repair",
    })).resolves.toBeDefined();
  });

  it("repairs a removed operational diagnostics directory with null policy accounting snapshots", async () => {
    const { runDir, manifest } = await setup();
    const { paths, progress } = await progressInput(runDir, manifest);
    const stopped = await recordOperationalStop({ runDir, progress, paths });
    expect(stopped.guard_action).toBe("diagnostic_stop");
    const diagnostics = join(
      runDir,
      "recovery/scopes",
      recoveryScopePathComponent("work-item:item-1"),
      "diagnostics",
    );
    const diagnosticPath = join(runDir, stopped.diagnostic_path!);
    const expected = await readFile(diagnosticPath);
    const parsed = JSON.parse(expected.toString("utf8"));
    expect(parsed.policy_decision).toBeNull();
    expect(parsed.review_accounting).toBeNull();
    expect(parsed.quality_recovery_usage).toBeNull();

    await rm(diagnostics, { recursive: true });
    await expect(reconcileRecoveryJournal(runDir)).resolves.toBeDefined();
    expect(await readFile(diagnosticPath)).toEqual(expected);
    await expect(authorizeDiagnosticResume({
      runDir,
      actor: "operator",
      note: "Retry operational blocker after repair",
    })).resolves.toBeDefined();
  });

  it("fails closed when a symlink occupies a missing diagnostics directory", async () => {
    const { root, runDir, manifest } = await setup();
    const { paths, progress } = await progressInput(runDir, manifest);
    const stopped = await recordOperationalStop({ runDir, progress, paths });
    const diagnostics = join(runDir, stopped.diagnostic_path!, "..");
    await rm(diagnostics, { recursive: true });
    const foreign = join(root, "foreign-diagnostics");
    await mkdir(foreign);
    await symlink(foreign, diagnostics);

    await expect(reconcileRecoveryJournal(runDir)).rejects.toThrow(/symlink|diagnostic|scope/i);
    await expect(authorizeDiagnosticResume({
      runDir,
      actor: "operator",
      note: "Must not authorize through a symlink",
    })).rejects.toThrow(/symlink|diagnostic|scope/i);
    expect(await readdir(foreign)).toEqual([]);
  });

  it("prevalidates embedded intent evidence before recreating a missing diagnostics directory", async () => {
    const { runDir, manifest } = await setup();
    const { paths, progress } = await progressInput(runDir, manifest);
    const stopped = await recordOperationalStop({ runDir, progress, paths });
    const diagnostics = join(runDir, stopped.diagnostic_path!, "..");
    await rm(diagnostics, { recursive: true });
    await rm(join(runDir, paths.implementationPath));

    await expect(reconcileRecoveryJournal(runDir)).rejects.toThrow(/implementation|evidence|invalid/i);
    await expect(readdir(diagnostics)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects coordinated non-null operational policy accounting in the decision intent and diagnostic", async () => {
    const { runDir, manifest } = await setup();
    const { paths, progress } = await progressInput(runDir, manifest);
    const stopped = await recordOperationalStop({ runDir, progress, paths });
    const diagnosticPath = join(runDir, stopped.diagnostic_path!);
    const decisionPath = join(runDir, stopped.recovery_decision.next_state.head_decision_path!);
    const diagnostic = JSON.parse(await readFile(diagnosticPath, "utf8"));
    diagnostic.review_accounting = (await readManifestV2(runDir)).review_accounting;
    diagnostic.quality_recovery_usage = {
      work_item_id: "item-1",
      active_hands_profile: "primary",
      attempts_used: 0,
    };
    const decision = JSON.parse(await readFile(decisionPath, "utf8"));
    decision.diagnostic_intent = diagnostic;
    await writeFile(diagnosticPath, `${JSON.stringify(diagnostic)}\n`);
    await writeFile(decisionPath, `${JSON.stringify(decision)}\n`);

    await expect(reconcileRecoveryJournal(runDir)).rejects.toThrow(/diagnostic|accounting|operational|schema/i);
  });

  it("validates referenced owned evidence before mutating a terminal decision", async () => {
    const { runDir, manifest } = await setup();
    const { paths, progress } = await progressInput(runDir, manifest);
    const base = {
      runDir,
      scopeId: "work-item:item-1",
      operation: "work-item-fix",
      decision: policyDecision,
      progress,
      ownedEvidenceRefs: ownedEvidenceRefs(paths),
    };
    await gateReviewPolicyEffect({ ...base, effectAttemptId: `review-effect:${"3".repeat(64)}` });
    const before = await recoveryBytes(runDir);

    await expect(gateReviewPolicyEffect({
      ...base,
      effectAttemptId: `review-effect:${"4".repeat(64)}`,
      ownedEvidenceRefs: {
        ...ownedEvidenceRefs(paths),
        implementation_path: "implementation/item-1/missing.json",
      },
    })).rejects.toThrow(/implementation.*evidence|owned evidence|invalid/i);
    expect(await recoveryBytes(runDir)).toEqual(before);
  });

  it("reconciles event and manifest projections after a crash immediately after diagnostic persistence", async () => {
    const { runDir, manifest } = await setup();
    const { paths, progress } = await progressInput(runDir, manifest);
    const base = {
      runDir,
      scopeId: "work-item:item-1",
      operation: "work-item-fix",
      decision: policyDecision,
      progress,
      ownedEvidenceRefs: ownedEvidenceRefs(paths),
    };
    await gateReviewPolicyEffect({ ...base, effectAttemptId: `review-effect:${"5".repeat(64)}` });
    await expect(gateReviewPolicyEffect({
      ...base,
      effectAttemptId: `review-effect:${"6".repeat(64)}`,
      hooks: { afterDiagnosticArtifact: async () => { throw new Error("crash after diagnostic"); } },
    })).rejects.toThrow("crash after diagnostic");

    const reconciled = await reconcileRecoveryJournal(runDir);
    expect(reconciled.recovery.scopes["work-item:item-1"]?.disposition).toBe("diagnostic_stop");
    await expect(authorizeDiagnosticResume({
      runDir,
      actor: "operator",
      note: "Retry after repaired diagnostic projection",
    })).resolves.toBeDefined();
  });

  it("rejects orphan diagnostics even when their filename is canonical", async () => {
    const { runDir, manifest } = await setup();
    const { paths, progress } = await progressInput(runDir, manifest);
    const base = {
      runDir,
      scopeId: "work-item:item-1",
      operation: "work-item-fix",
      decision: policyDecision,
      progress,
      ownedEvidenceRefs: ownedEvidenceRefs(paths),
    };
    await gateReviewPolicyEffect({ ...base, effectAttemptId: `review-effect:${"7".repeat(64)}` });
    const stopped = await gateReviewPolicyEffect({ ...base, effectAttemptId: `review-effect:${"8".repeat(64)}` });
    const diagnostics = join(runDir, "recovery/scopes", recoveryScopePathComponent("work-item:item-1"), "diagnostics");
    await writeFile(join(diagnostics, "000001.json"), await readFile(join(runDir, stopped.diagnostic_path!)));

    await expect(reconcileRecoveryJournal(runDir)).rejects.toThrow(/diagnostic|orphan|binding|sequence/i);
  });

  it.each(["diagnostic", "evidence"] as const)(
    "rejects a same-name %s replacement at the diagnostic scan boundary",
    async (target) => {
      const { runDir, manifest } = await setup();
      const { paths, progress } = await progressInput(runDir, manifest);
      const base = {
        runDir,
        scopeId: "work-item:item-1",
        operation: "work-item-fix",
        decision: policyDecision,
        progress,
        ownedEvidenceRefs: ownedEvidenceRefs(paths),
      };
      await gateReviewPolicyEffect({ ...base, effectAttemptId: `review-effect:${"9".repeat(64)}` });
      const stopped = await gateReviewPolicyEffect({ ...base, effectAttemptId: `review-effect:${"a".repeat(64)}` });
      const path = join(runDir, target === "diagnostic" ? stopped.diagnostic_path! : paths.implementationPath);
      let replaced = false;
      await expect(reconcileRecoveryJournal(runDir, {
        afterDiagnosticEntriesRead: async () => {
          if (replaced) return;
          replaced = true;
          const replacement = `${path}.replacement`;
          await writeFile(replacement, await readFile(path));
          await rename(replacement, path);
        },
      })).rejects.toThrow(/identity|changed|bytes|diagnostic|evidence/i);
    },
  );

  it.each(["policy", "accounting", "quality"] as const)(
    "rejects coordinated valid-field %s drift in the decision intent and diagnostic",
    async (field) => {
      const { runDir, manifest } = await setup();
      const { paths, progress } = await progressInput(runDir, manifest);
      const base = {
        runDir,
        scopeId: "work-item:item-1",
        operation: "work-item-fix",
        decision: policyDecision,
        progress,
        ownedEvidenceRefs: ownedEvidenceRefs(paths),
      };
      await gateReviewPolicyEffect({ ...base, effectAttemptId: `review-effect:${"b".repeat(64)}` });
      const stopped = await gateReviewPolicyEffect({ ...base, effectAttemptId: `review-effect:${"c".repeat(64)}` });
      const diagnosticPath = join(runDir, stopped.diagnostic_path!);
      const decisionPath = join(runDir, stopped.recovery_decision!.next_state.head_decision_path!);
      const diagnostic = JSON.parse(await readFile(diagnosticPath, "utf8"));
      if (field === "policy") diagnostic.policy_decision.policy_revision += 1;
      if (field === "accounting") diagnostic.review_accounting.fix_cycles_used += 1;
      if (field === "quality") diagnostic.quality_recovery_usage.attempts_used = 1;
      const decision = JSON.parse(await readFile(decisionPath, "utf8"));
      decision.diagnostic_intent = diagnostic;
      await writeFile(diagnosticPath, `${JSON.stringify(diagnostic)}\n`);
      await writeFile(decisionPath, `${JSON.stringify(decision)}\n`);

      await expect(reconcileRecoveryJournal(runDir)).rejects.toThrow(/policy|accounting|quality|cycle|manifest/i);
    },
  );

  it("rejects coordinated false approved-plan and candidate provenance", async () => {
    const { runDir, manifest } = await setup();
    const { paths, progress } = await progressInput(runDir, manifest);
    const base = {
      runDir,
      scopeId: "work-item:item-1",
      operation: "work-item-fix",
      decision: policyDecision,
      progress,
      ownedEvidenceRefs: ownedEvidenceRefs(paths),
    };
    await gateReviewPolicyEffect({ ...base, effectAttemptId: `review-effect:${"d".repeat(64)}` });
    const stopped = await gateReviewPolicyEffect({ ...base, effectAttemptId: `review-effect:${"e".repeat(64)}` });
    const diagnosticPath = join(runDir, stopped.diagnostic_path!);
    const decisionPath = join(runDir, stopped.recovery_decision!.next_state.head_decision_path!);
    const diagnostic = JSON.parse(await readFile(diagnosticPath, "utf8"));
    diagnostic.progress.subject.approved_plan_sha256 = "f".repeat(64);
    diagnostic.progress.subject.candidate_commit = "e".repeat(40);
    diagnostic.progress.sha256 = progressSubjectSha256(diagnostic.progress.subject);
    diagnostic.current_observation.progress_subject_sha256 = diagnostic.progress.sha256;
    const decision = JSON.parse(await readFile(decisionPath, "utf8"));
    const previousDecisionPath = join(runDir, decision.previous_state.head_decision_path);
    const previousDecision = JSON.parse(await readFile(previousDecisionPath, "utf8"));
    previousDecision.observation.progress_subject_sha256 = diagnostic.progress.sha256;
    previousDecision.next_state.progress_subject_sha256 = diagnostic.progress.sha256;
    decision.previous_state.progress_subject_sha256 = diagnostic.progress.sha256;
    diagnostic.previous_observation.progress_subject_sha256 = diagnostic.progress.sha256;
    decision.observation.progress_subject_sha256 = diagnostic.progress.sha256;
    decision.next_state.progress_subject_sha256 = diagnostic.progress.sha256;
    decision.diagnostic_intent = diagnostic;
    const currentManifest = JSON.parse(await readFile(join(runDir, "manifest.json"), "utf8"));
    currentManifest.recovery.scopes["work-item:item-1"].progress_subject_sha256 = diagnostic.progress.sha256;
    await writeFile(diagnosticPath, `${JSON.stringify(diagnostic)}\n`);
    await writeFile(previousDecisionPath, `${JSON.stringify(previousDecision)}\n`);
    await writeFile(decisionPath, `${JSON.stringify(decision)}\n`);
    await writeFile(join(runDir, "manifest.json"), `${JSON.stringify(currentManifest)}\n`);

    await expect(reconcileRecoveryJournal(runDir)).rejects.toThrow(/approved plan|candidate commit|manifest|provenance/i);
  });

  it("concurrently replays the same diagnostic attempt into one artifact", async () => {
    const { runDir, manifest } = await setup();
    const { paths, progress } = await progressInput(runDir, manifest);
    const base = {
      runDir,
      scopeId: "work-item:item-1",
      operation: "work-item-fix",
      decision: policyDecision,
      progress,
      ownedEvidenceRefs: ownedEvidenceRefs(paths),
    };
    await gateReviewPolicyEffect({ ...base, effectAttemptId: `review-effect:${"8".repeat(64)}` });
    const results = await Promise.all(Array.from({ length: 8 }, () => gateReviewPolicyEffect({
      ...base,
      effectAttemptId: `review-effect:${"9".repeat(64)}`,
    })));

    expect(new Set(results.map((result) => result.diagnostic_path))).toHaveLength(1);
    const diagnosticsDir = join(
      runDir,
      "recovery/scopes",
      recoveryScopePathComponent("work-item:item-1"),
      "diagnostics",
    );
    expect(await readdir(diagnosticsDir)).toEqual(["000002.json"]);
  });

  it("claims an active Task 6 authorization without pre-recording the claimed attempt", async () => {
    const { runDir, manifest } = await setup();
    const { paths, progress } = await progressInput(runDir, manifest);
    const base = {
      runDir,
      scopeId: "work-item:item-1",
      operation: "work-item-fix",
      decision: policyDecision,
      progress,
      ownedEvidenceRefs: ownedEvidenceRefs(paths),
    };
    await gateReviewPolicyEffect({ ...base, effectAttemptId: `review-effect:${"a".repeat(64)}` });
    const stopped = await gateReviewPolicyEffect({ ...base, effectAttemptId: `review-effect:${"b".repeat(64)}` });
    if (stopped.mode !== "ordinary") throw new Error("Expected an ordinary diagnostic-stop decision");
    const authorization = await authorizeDiagnosticResume({
      runDir,
      actor: "operator",
      note: "Retry the exact observed operation once",
    });

    const claimed = await gateReviewPolicyEffect({
      ...base,
      effectAttemptId: `review-effect:${"c".repeat(64)}`,
    });
    expect(claimed.mode).toBe("authorized_attempt");
    expect(claimed.guard_action).toBe("allow_next_effect");
    expect(claimed.effect_attempt_id).toMatch(/^recovery-attempt:[a-f0-9]{64}$/);
    expect(claimed.authorization_id).toBe(authorization.authorization_id);
    expect((await readManifestV2(runDir)).recovery.scopes["work-item:item-1"]?.head_sequence)
      .toBe(stopped.recovery_decision.sequence);
  });

  it("records a claimed authorized success only after changed owned evidence exists", async () => {
    const { runDir, manifest } = await setup();
    const { paths, progress } = await progressInput(runDir, manifest);
    const base = {
      runDir,
      scopeId: "work-item:item-1",
      operation: "work-item-fix",
      decision: policyDecision,
      progress,
      ownedEvidenceRefs: ownedEvidenceRefs(paths),
    };
    await gateReviewPolicyEffect({ ...base, effectAttemptId: `review-effect:${"1".repeat(64)}` });
    await gateReviewPolicyEffect({ ...base, effectAttemptId: `review-effect:${"2".repeat(64)}` });
    const authorization = await authorizeDiagnosticResume({
      runDir,
      actor: "operator",
      note: "Retry the exact policy effect once",
    });
    const claimed = await gateReviewPolicyEffect({
      ...base,
      effectAttemptId: `review-effect:${"3".repeat(64)}`,
    });
    if (claimed.mode !== "authorized_attempt") throw new Error("Expected an authorized attempt");
    const changedPath = "implementation/item-1/authorized-success.json";
    await writeTextArtifact(runDir, changedPath, `${JSON.stringify(implementation("authorized-success"))}\n`);
    const resultingProgress = await buildRecoveryProgressSubject({
      runDir,
      manifest: await readManifestV2(runDir),
      workItemId: "item-1",
      findingIds: [findingId],
      implementationPath: changedPath,
      verificationPath: paths.verificationPath,
      reviewPath: paths.reviewPath,
      reviewRevision: 1,
    });

    const recorded = await recordAuthorizedRecoveryOutcome({
      runDir,
      scopeId: "work-item:item-1",
      operation: "work-item-fix",
      authorizationId: authorization.authorization_id,
      effectAttemptId: claimed.effect_attempt_id,
      outcome: { kind: "success", decision: policyDecision },
      progress: resultingProgress,
      ownedEvidenceRefs: {
        implementation_path: changedPath,
        verification_path: paths.verificationPath,
        review_path: paths.reviewPath,
      },
    });

    expect(recorded.guard_action).toBe("allow_next_effect");
    expect(recorded.recovery_decision.observation.effect_attempt_id).toBe(claimed.effect_attempt_id);
    expect(recorded.recovery_decision.observation.progress_subject_sha256).toBe(resultingProgress.sha256);
    expect(recorded.recovery_decision.next_state.consecutive_without_progress).toBe(1);
    expect(recorded.recovery_decision.next_state.authorization_path).toBeNull();
  });

  it("records and idempotently replays one explicitly classified authorized failure", async () => {
    const { runDir, manifest } = await setup();
    const { paths, progress } = await progressInput(runDir, manifest);
    const base = {
      runDir,
      scopeId: "work-item:item-1",
      operation: "work-item-fix",
      decision: policyDecision,
      progress,
      ownedEvidenceRefs: ownedEvidenceRefs(paths),
    };
    await gateReviewPolicyEffect({ ...base, effectAttemptId: `review-effect:${"4".repeat(64)}` });
    await gateReviewPolicyEffect({ ...base, effectAttemptId: `review-effect:${"5".repeat(64)}` });
    const authorization = await authorizeDiagnosticResume({
      runDir,
      actor: "operator",
      note: "Retry the exact invocation once",
    });
    const claimed = await gateReviewPolicyEffect({
      ...base,
      effectAttemptId: `review-effect:${"6".repeat(64)}`,
    });
    if (claimed.mode !== "authorized_attempt") throw new Error("Expected an authorized attempt");
    const input = {
      runDir,
      scopeId: "work-item:item-1",
      operation: "work-item-fix",
      authorizationId: authorization.authorization_id,
      effectAttemptId: claimed.effect_attempt_id,
      outcome: {
        kind: "failure" as const,
        decision: policyDecision,
        classification: {
          failure_class: "implementation_failure" as const,
          blocker_code: "fix_budget_available",
        },
        error: new Error("arbitrary prose"),
      },
      progress,
      ownedEvidenceRefs: ownedEvidenceRefs(paths),
    };

    const first = await recordAuthorizedRecoveryOutcome(input);
    const replay = await recordAuthorizedRecoveryOutcome(input);

    expect(first.guard_action).toBe("diagnostic_stop");
    expect(first.recovery_decision.observation.blocker_code).toBe("fix_budget_available");
    expect(replay.recovery_decision).toEqual(first.recovery_decision);
    expect((await recoveryBytes(runDir)).decisions).toHaveLength(3);
  });

  it("claims only the exact operational subject and rejects outcome substitution before mutation", async () => {
    const { runDir, manifest } = await setup();
    const { paths, progress } = await progressInput(runDir, manifest);
    const stopped = await recordOperationalStop({ runDir, progress, paths });
    const authorization = await authorizeDiagnosticResume({
      runDir,
      actor: "operator",
      note: "Retry this exact network operation once",
    });
    const exact = {
      runDir,
      scopeId: "work-item:item-1",
      operation: "work-item-fix",
      requestedEffect: "fix" as const,
      requestedEffectReason: "fix_budget_available",
      findingIds: [findingId],
      classification: {
        failure_class: "operational_blocker" as const,
        blocker_code: "network_failure",
      },
      progress,
    };

    await expect(gateOperationalRecoveryAttempt({
      ...exact,
      operation: "different-operation",
    })).rejects.toThrow(/exact|subject|operation|authorized/i);
    expect((await recoveryBytes(runDir)).decisions).toHaveLength(2);

    const claimed = await gateOperationalRecoveryAttempt(exact);
    expect(claimed).toMatchObject({
      mode: "authorized_attempt",
      authorization_id: authorization.authorization_id,
    });
    if (claimed.mode !== "authorized_attempt") throw new Error("Expected an authorized attempt");
    const before = await recoveryBytes(runDir);

    for (const mutate of [
      { operation: "different-operation" },
      { classification: { failure_class: "model_failure" as const, blocker_code: "network_failure" } },
      { requestedEffect: "retry_operation" as const },
      { requestedEffectReason: "different_reason" },
      { findingIds: [secondFindingId] },
    ]) {
      await expect(recordAuthorizedRecoveryOutcome({
        ...exact,
        ...mutate,
        authorizationId: authorization.authorization_id,
        effectAttemptId: claimed.effect_attempt_id,
        outcome: {
          kind: "failure",
          requestedEffect: mutate.requestedEffect ?? exact.requestedEffect,
          requestedEffectReason: mutate.requestedEffectReason ?? exact.requestedEffectReason,
          findingIds: mutate.findingIds ?? exact.findingIds,
          classification: mutate.classification ?? exact.classification,
        },
      })).rejects.toThrow(/exact|subject|authorized|binding|finding identifiers/i);
      expect(await recoveryBytes(runDir)).toEqual(before);
    }

    const recorded = await recordAuthorizedRecoveryOutcome({
      ...exact,
      authorizationId: authorization.authorization_id,
      effectAttemptId: claimed.effect_attempt_id,
      outcome: {
        kind: "failure",
        requestedEffect: exact.requestedEffect,
        requestedEffectReason: exact.requestedEffectReason,
        findingIds: exact.findingIds,
        classification: exact.classification,
      },
      ownedEvidenceRefs: ownedEvidenceRefs(paths),
    });
    expect(recorded.recovery_decision.sequence).toBe(stopped.recovery_decision.sequence + 1);
  });

  it("closes a consumed authorization with its original subject before gating the next operation", async () => {
    const { runDir, manifest } = await setup();
    const { paths, progress } = await progressInput(runDir, manifest);
    await recordOperationalStop({ runDir, progress, paths });
    await authorizeDiagnosticResume({
      runDir,
      actor: "operator",
      note: "Retry this exact operation once",
    });
    const exact = {
      runDir,
      scopeId: "work-item:item-1",
      operation: "work-item-fix",
      requestedEffect: "fix" as const,
      requestedEffectReason: "fix_budget_available",
      findingIds: [findingId],
      classification: {
        failure_class: "operational_blocker" as const,
        blocker_code: "network_failure",
      },
      progress,
    };
    expect((await gateOperationalRecoveryAttempt(exact)).mode).toBe("authorized_attempt");
    await transitionRun(runDir, "verifying");
    await transitionRun(runDir, "verifier_review");
    const changedSubject = recoveryProgressSubjectV1Schema.parse({
      ...progress.subject,
      candidate_commit: "d".repeat(40),
    });
    const next = await gateOperationalRecoveryAttempt({
      ...exact,
      operation: "verifier-invocation",
      progress: {
        subject: changedSubject,
        sha256: progressSubjectSha256(changedSubject),
      },
    });

    expect(next.mode).toBe("ordinary");
    const reconciled = await readManifestV2(runDir);
    const headPath = reconciled.recovery.scopes[exact.scopeId]!.head_decision_path!;
    const head = recoveryDecisionArtifactV1Schema.parse(JSON.parse(await readFile(join(runDir, headPath), "utf8")));
    expect(head.observation).toMatchObject({
      stage: "fixing",
      operation: "work-item-fix",
      failure_class: "operational_blocker",
      blocker_code: "network_failure",
      finding_ids: [findingId],
    });
    expect(head.requested_effect).toBe("fix");
    expect(head.requested_effect_reason).toBe("fix_budget_available");
  });

  it.each(["authorization", "consumption"] as const)(
    "rejects a same-name %s replacement during locked authorized outcome recording",
    async (target) => {
      const { runDir, manifest } = await setup();
      const { paths, progress } = await progressInput(runDir, manifest);
      await recordOperationalStop({ runDir, progress, paths });
      const authorization = await authorizeDiagnosticResume({
        runDir,
        actor: "operator",
        note: "Retry this exact operation once",
      });
      const exact = {
        runDir,
        scopeId: "work-item:item-1",
        operation: "work-item-fix",
        requestedEffect: "fix" as const,
        requestedEffectReason: "fix_budget_available",
        findingIds: [findingId],
        classification: {
          failure_class: "operational_blocker" as const,
          blocker_code: "network_failure",
        },
        progress,
      };
      const claimed = await gateOperationalRecoveryAttempt(exact);
      if (claimed.mode !== "authorized_attempt") throw new Error("Expected an authorized attempt");
      const relativePath = target === "authorization"
        ? diagnosticRecoveryAuthorizationPath(exact.scopeId, authorization.authorization_id)
        : diagnosticRecoveryConsumptionPath(exact.scopeId, authorization.authorization_id);
      const path = join(runDir, relativePath);
      const before = await recoveryBytes(runDir);
      let replaced = false;

      await expect(recordAuthorizedRecoveryOutcome({
        ...exact,
        authorizationId: authorization.authorization_id,
        effectAttemptId: claimed.effect_attempt_id,
        outcome: {
          kind: "failure",
          requestedEffect: exact.requestedEffect,
          requestedEffectReason: exact.requestedEffectReason,
          findingIds: exact.findingIds,
          classification: exact.classification,
        },
        ownedEvidenceRefs: ownedEvidenceRefs(paths),
        hooks: {
          afterAuthorizationEntriesRead: async () => {
            if (replaced) return;
            replaced = true;
            const replacement = `${path}.replacement`;
            await writeFile(replacement, await readFile(path));
            await rename(replacement, path);
          },
        },
      })).rejects.toThrow(/authorization|consumption|identity|changed|replacement|entry/i);
      expect((await recoveryBytes(runDir)).decisions).toEqual(before.decisions);
    },
  );

  it("rejects wrong-attempt and cross-scope authorized outcome recording without a new decision", async () => {
    const { runDir, manifest } = await setup();
    const { paths, progress } = await progressInput(runDir, manifest);
    const base = {
      runDir,
      scopeId: "work-item:item-1",
      operation: "work-item-fix",
      decision: policyDecision,
      progress,
      ownedEvidenceRefs: ownedEvidenceRefs(paths),
    };
    await gateReviewPolicyEffect({ ...base, effectAttemptId: `review-effect:${"7".repeat(64)}` });
    await gateReviewPolicyEffect({ ...base, effectAttemptId: `review-effect:${"8".repeat(64)}` });
    const authorization = await authorizeDiagnosticResume({ runDir, actor: "operator", note: "One exact retry" });
    const claimed = await gateReviewPolicyEffect({ ...base, effectAttemptId: `review-effect:${"9".repeat(64)}` });
    if (claimed.mode !== "authorized_attempt") throw new Error("Expected an authorized attempt");
    const outcome = { kind: "success" as const, decision: policyDecision };
    const before = await recoveryBytes(runDir);

    await expect(recordAuthorizedRecoveryOutcome({
      runDir,
      scopeId: "work-item:item-1",
      operation: "work-item-fix",
      authorizationId: authorization.authorization_id,
      effectAttemptId: `recovery-attempt:${"f".repeat(64)}`,
      outcome,
      progress,
    })).rejects.toThrow(/claimed|consumption|attempt/i);
    await expect(recordAuthorizedRecoveryOutcome({
      runDir,
      scopeId: "work-item:other",
      operation: "work-item-fix",
      authorizationId: authorization.authorization_id,
      effectAttemptId: claimed.effect_attempt_id,
      outcome,
      progress,
    })).rejects.toThrow(/authorization|scope/i);
    expect(await recoveryBytes(runDir)).toEqual(before);
  });

  it("replays the exact authorized outcome after interruption without a second decision", async () => {
    const { runDir, manifest } = await setup();
    const { paths, progress } = await progressInput(runDir, manifest);
    const base = {
      runDir,
      scopeId: "work-item:item-1",
      operation: "work-item-fix",
      decision: policyDecision,
      progress,
      ownedEvidenceRefs: ownedEvidenceRefs(paths),
    };
    await gateReviewPolicyEffect({ ...base, effectAttemptId: `review-effect:${"a".repeat(64)}` });
    await gateReviewPolicyEffect({ ...base, effectAttemptId: `review-effect:${"b".repeat(64)}` });
    const authorization = await authorizeDiagnosticResume({ runDir, actor: "operator", note: "One crash-safe retry" });
    const claimed = await gateReviewPolicyEffect({ ...base, effectAttemptId: `review-effect:${"c".repeat(64)}` });
    if (claimed.mode !== "authorized_attempt") throw new Error("Expected an authorized attempt");
    let interrupt = true;
    const input = {
      runDir,
      scopeId: "work-item:item-1",
      operation: "work-item-fix",
      authorizationId: authorization.authorization_id,
      effectAttemptId: claimed.effect_attempt_id,
      outcome: {
        kind: "failure" as const,
        decision: policyDecision,
        classification: { failure_class: "implementation_failure" as const, blocker_code: policyDecision.reason_code },
        error: new Error("model failed"),
      },
      progress,
      ownedEvidenceRefs: ownedEvidenceRefs(paths),
      hooks: {
        afterRecoveryDecision: async () => {
          if (interrupt) {
            interrupt = false;
            throw new Error("crash after authorized outcome decision");
          }
        },
      },
    };

    await expect(recordAuthorizedRecoveryOutcome(input)).rejects.toThrow("crash after authorized outcome decision");
    const replay = await recordAuthorizedRecoveryOutcome(input);
    const stable = await recordAuthorizedRecoveryOutcome(input);

    expect(stable.recovery_decision).toEqual(replay.recovery_decision);
    expect((await recoveryBytes(runDir)).decisions).toHaveLength(3);
  });

  it.each([
    ["run", (diagnostic: Record<string, unknown>) => ({ ...diagnostic, run_id: "foreign-run" })],
    ["scope", (diagnostic: Record<string, unknown>) => ({ ...diagnostic, scope_id: "work-item:other" })],
    ["decision", (diagnostic: Record<string, unknown>) => ({ ...diagnostic, decision_path: "recovery/foreign.json" })],
    ["head", (diagnostic: Record<string, unknown>) => ({ ...diagnostic, journal_sequence: 99 })],
    ["owned evidence", (diagnostic: Record<string, unknown>) => ({
      ...diagnostic,
      owned_evidence_refs: {
        ...(diagnostic.owned_evidence_refs as Record<string, unknown>),
        implementation_path: "implementation/item-1/missing.json",
      },
    })],
    ["schema", (diagnostic: Record<string, unknown>) => ({ ...diagnostic, extra: true })],
  ])("rejects a diagnostic with a tampered %s binding", async (_label, mutate) => {
    const { runDir, manifest } = await setup();
    const { paths, progress } = await progressInput(runDir, manifest);
    const base = {
      runDir,
      scopeId: "work-item:item-1",
      operation: "work-item-fix",
      decision: policyDecision,
      progress,
      ownedEvidenceRefs: ownedEvidenceRefs(paths),
    };
    await gateReviewPolicyEffect({ ...base, effectAttemptId: `review-effect:${"d".repeat(64)}` });
    const stopped = await gateReviewPolicyEffect({ ...base, effectAttemptId: `review-effect:${"e".repeat(64)}` });
    const path = join(runDir, stopped.diagnostic_path!);
    const diagnostic = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    await writeFile(path, `${JSON.stringify(mutate(diagnostic))}\n`);

    await expect(reconcileRecoveryJournal(runDir)).rejects.toThrow(/diagnostic|binding|schema|unrecognized/i);
  });

  it("rejects diagnostic aliases, symlinks, non-files, and unbound foreign entries", async () => {
    for (const kind of ["alias", "symlink", "directory", "foreign"] as const) {
      const { root, runDir } = await setup();
      const component = recoveryScopePathComponent("work-item:item-1");
      const diagnostics = join(runDir, "recovery/scopes", component, "diagnostics");
      await mkdir(diagnostics, { recursive: true });
      if (kind === "alias") await writeFile(join(diagnostics, "1.json"), "{}\n");
      if (kind === "symlink") {
        const target = join(root, "diagnostic.json");
        await writeFile(target, "{}\n");
        await symlink(target, join(diagnostics, "000001.json"));
      }
      if (kind === "directory") await mkdir(join(diagnostics, "000001.json"));
      if (kind === "foreign") await writeFile(join(diagnostics, "000001.json"), "{}\n");
      await expect(reconcileRecoveryJournal(runDir)).rejects.toThrow(/diagnostic|canonical|symlink|unsupported|schema/i);
    }
  });
});
