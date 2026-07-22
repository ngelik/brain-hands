import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  canonicalJsonBytes,
  evidenceIndexV1Schema,
  handsContextV1Schema,
  reflectionContextV1Schema,
  verifierContextV1Schema,
  workItemSummaryV1Schema,
  type ArtifactRefV1,
} from "../../src/core/context-contracts.js";
import {
  approvePlanRevision,
  createRunLedgerV2,
  readReferencedJson,
  readManifestV2,
  recordPlan,
  recordTerminalDisposition,
  updateManifestV2,
  writeImmutableValidatedJson,
} from "../../src/core/ledger.js";
import {
  assuranceAssessmentSchema,
  executionSpecV2Schema,
  implementationResultSchema,
  persistedVerifierReviewSchema,
  verificationBrowserEvidenceSchema,
  verificationEvidenceSchema,
  verificationExecutionResultSchema,
} from "../../src/core/schema.js";
import {
  verificationEvidencePath,
  type BrainPlan,
  type VerificationIdentity,
  type WorkItem,
} from "../../src/core/types.js";
import {
  buildReflectionEvidenceIndex,
  buildVerifierEvidenceIndex,
} from "../../src/workflow/evidence-index.js";
import { verificationContextCandidates } from "../../src/workflow/verification-context-fragments.js";
import { persistWorkItemSummary } from "../../src/workflow/work-item-summaries.js";
import { recordFindingRevision } from "../../src/workflow/findings.js";
import {
  boundedGeneratedLockfileDiff,
  boundedHandsDiff,
  boundedVerifierDiff,
  CONTEXT_LIMITS_V1,
  buildHandsContext,
  buildReflectionContext,
  buildVerifierContext,
  compactHandsWorkItem,
  handsContextPath,
  loadRoleContext,
  validateHandsInvocationContext,
} from "../../src/workflow/role-context.js";
import { integratedWorkItem } from "../../src/workflow/integrated-work-item.js";

let roots: string[] = [];
const candidateCommit = "b".repeat(40);
const createdAt = "2026-07-16T12:00:00.000Z";

afterEach(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  roots = [];
});

async function runDir(workItems: WorkItem[] = [item()]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "brain-hands-role-context-"));
  roots.push(root);
  const run = (await createRunLedgerV2({
    repoRoot: root,
    originalRequest: "Build a bounded role package",
    sourceCommit: "a".repeat(40),
    intake: { task: "Build a bounded role package", repo_root: root },
  })).runDir;
  const plan = await recordPlan(run, JSON.stringify({ work_items: workItems }));
  await approvePlanRevision(run, plan.revision);
  await updateManifestV2(run, { workflow_protocol: "bounded-context-v1" });
  return run;
}

async function authorityFixture(
  reflection = false,
  seed?: {
    runDir: string;
    planRevision: number;
    planSha256: string;
    summaryRefs: ArtifactRefV1[];
  },
): Promise<{
  runDir: string;
  indexRef: ArtifactRefV1;
}> {
  const run = seed?.runDir ?? await runDir();
  const plan = seed
    ? { revision: seed.planRevision, sha256: seed.planSha256 }
    : await recordPlan(run, JSON.stringify({ work_items: [] }));
  if (!seed) await approvePlanRevision(run, plan.revision);
  const summaryRefs = seed?.summaryRefs ?? [];
  const verificationPath = "verification/integrated/attempt-1/evidence.json";
  const verificationRef = await writeImmutableValidatedJson(run, verificationPath, verificationEvidenceSchema, {
    verification_scope: "integrated",
    work_item_id: "integrated",
    attempt: 1,
    evidence_path: verificationPath,
    commands: [],
    artifacts: [],
    artifact_checks: [],
    browser_evidence: [],
    created_at: createdAt,
  });
  let manifest = await readManifestV2(run);
  await updateManifestV2(run, {
    workflow_protocol: "bounded-context-v1",
    work_item_progress: {
      ...manifest.work_item_progress,
      integrated: {
        ...manifest.work_item_progress.integrated,
        status: "in_progress",
        attempts: 1,
        verification_path: verificationPath,
        review_revision: 1,
        commit_sha: candidateCommit,
      },
    },
  });
  if (!reflection) {
    return {
      runDir: run,
      indexRef: await buildVerifierEvidenceIndex({
        runDir: run,
        phase: "final_integrated",
        attempt: 1,
        candidateCommit,
        workItemSummaryRefs: summaryRefs,
        integratedVerificationRef: verificationRef,
        createdAt,
      }),
    };
  }
  const reviewPath = "reviews/integrated/final-attempt-1.json";
  const reviewRef = await writeImmutableValidatedJson(run, reviewPath, persistedVerifierReviewSchema, {
    work_item_id: "integrated",
    attempt: 1,
    final: true,
    decision: "approve",
    failure_class: "none",
    blocker: null,
    blocker_code: null,
    acceptance_coverage: [],
    evidence_reviewed: [verificationPath],
    findings: [],
    residual_risks: [],
  });
  const assessmentPath = "assurance/final.json";
  await writeImmutableValidatedJson(run, assessmentPath, assuranceAssessmentSchema, {
    outcome: "verified_ready",
    assessed_at: createdAt,
    approved_plan_revision: plan.revision,
    approved_plan_sha256: plan.sha256,
    candidate_commit: candidateCommit,
    blocker_code: null,
    blocker: null,
    missing_evidence: [],
    invalid_evidence: [],
    zero_attempt_work_items: [],
    acceptance_path: null,
  });
  manifest = await readManifestV2(run);
  await updateManifestV2(run, {
    delivery_state: "ready",
    assurance_outcome: "verified_ready",
    assurance_assessment_path: assessmentPath,
    final_artifact_paths: [verificationPath, reviewPath],
    work_item_progress: {
      ...manifest.work_item_progress,
      integrated: {
        ...manifest.work_item_progress.integrated,
        status: "complete",
        review_path: reviewPath,
      },
    },
  });
  await recordTerminalDisposition(run, {
    outcome: "delivered",
    actor: "runtime",
    reason: "All gates passed.",
    residual_risks: [],
    recorded_at: createdAt,
  });
  return {
    runDir: run,
    indexRef: await buildReflectionEvidenceIndex({
      runDir: run,
      attempt: 1,
      candidateCommit,
      workItemSummaryRefs: summaryRefs,
      integratedVerificationRef: verificationRef,
      finalReviewRef: reviewRef,
      createdAt,
    }),
  };
}

async function completeDependency(
  run: string,
  dependency: WorkItem,
  plan: { revision: number; sha256: string },
): Promise<ArtifactRefV1> {
  const implementationRef = await writeImmutableValidatedJson(
    run,
    `implementation/${dependency.id}/attempt-1.json`,
    implementationResultSchema,
    {
      work_item_id: dependency.id,
      changed_files: [`src/${dependency.id}.ts`],
      tests_added_or_changed: [],
      commands_attempted: [],
      completed_steps: [`${dependency.id}:CH-1`],
      remaining_risks: [],
    },
  );
  const resultPath = `verification/local/${dependency.id}/attempt-1/result.json`;
  await writeImmutableValidatedJson(run, resultPath, verificationExecutionResultSchema, {
    argv: dependency.verification_commands[0]!.argv,
    stdout: "passed\n",
    stderr: "",
    exit_code: 0,
    duration_ms: 10,
    timed_out: false,
    error_code: null,
    error_message: null,
    signal: null,
  });
  const verificationPath = `verification/local/${dependency.id}/attempt-1/evidence.json`;
  const verificationRef = await writeImmutableValidatedJson(run, verificationPath, verificationEvidenceSchema, {
    verification_scope: "local",
    work_item_id: dependency.id,
    attempt: 1,
    evidence_path: verificationPath,
    commands: [{
      command: dependency.verification_commands[0]!.argv.join(" "),
      argv: dependency.verification_commands[0]!.argv,
      exit_code: 0,
      timed_out: false,
      error_code: null,
      error_message: null,
      signal: null,
      stdout_path: `verification/local/${dependency.id}/attempt-1/command.stdout.txt`,
      stderr_path: `verification/local/${dependency.id}/attempt-1/command.stderr.txt`,
      result_path: resultPath,
    }],
    artifacts: [],
    artifact_checks: [],
    browser_evidence: [],
    created_at: createdAt,
  });
  const reviewPath = `reviews/${dependency.id}/attempt-1.json`;
  const reviewRef = await writeImmutableValidatedJson(run, reviewPath, persistedVerifierReviewSchema, {
    work_item_id: dependency.id,
    attempt: 1,
    final: false,
    decision: "approve",
    failure_class: "none",
    blocker: null,
    blocker_code: null,
    acceptance_coverage: dependency.completion_contract.required_acceptance_ids,
    evidence_reviewed: [verificationPath],
    findings: [],
    residual_risks: [],
  });
  let manifest = await readManifestV2(run);
  await updateManifestV2(run, {
    work_item_progress: {
      ...manifest.work_item_progress,
      [dependency.id]: {
        status: "in_progress",
        attempts: 1,
        context_base_commit: "a".repeat(40),
        context_plan_revision: plan.revision,
        implementation_path: implementationRef.path,
        verification_path: verificationRef.path,
        review_path: reviewRef.path,
        review_revision: 1,
        commit_sha: candidateCommit,
      },
    },
  });
  const dependencyRef = await persistWorkItemSummary({
    runDir: run,
    workItem: dependency,
    planRevision: plan.revision,
    planSha256: plan.sha256,
    attempt: 1,
    baseCommit: "a".repeat(40),
    commitSha: candidateCommit,
    completionBasis: "verifier_approve",
    implementationRef,
    verificationRef,
    reviewRef,
    policyDecisionRef: null,
    findingRevision: { reviewRevision: 1, findingIds: [] },
    createdAt,
  });
  manifest = await readManifestV2(run);
  await updateManifestV2(run, {
    workflow_protocol: "bounded-context-v1",
    work_item_progress: {
      ...manifest.work_item_progress,
      [dependency.id]: {
        ...manifest.work_item_progress[dependency.id],
        status: "complete",
        summary_path: dependencyRef.path,
        summary_sha256: dependencyRef.sha256,
      },
    },
  });
  return dependencyRef;
}

async function dependencyFixture(
  targetDependencies?: string[],
  dependencyId = "BH-000",
  includeTarget = true,
): Promise<{
  runDir: string;
  target: WorkItem;
  dependencyRef: ArtifactRefV1;
  planRevision: number;
  planSha256: string;
}> {
  const run = await runDir();
  const dependency = item(dependencyId);
  const target = item("BH-001", targetDependencies ?? [dependency.id]);
  const plan = await recordPlan(run, JSON.stringify({
    work_items: includeTarget ? [dependency, target] : [dependency],
  }));
  await approvePlanRevision(run, plan.revision);
  const dependencyRef = await completeDependency(run, dependency, plan);
  return {
    runDir: run,
    target,
    dependencyRef,
    planRevision: plan.revision,
    planSha256: plan.sha256,
  };
}

function item(
  id = "BH-001",
  dependencies: string[] = [],
  objective = "Implement bounded contexts",
): WorkItem {
  const acceptanceId = `${id}:AC-1`;
  return {
    schema_version: "2.0",
    id,
    title: `Implement ${id}`,
    objective,
    dependencies,
    file_contract: [{ path: `src/${id}.ts`, permission: "modify", targets: [id] }],
    forbidden_changes: [],
    change_units: [{
      id: `${id}:CH-1`,
      path: `src/${id}.ts`,
      target: id,
      operation: "modify",
      requirements: [`Complete ${id}.`],
    }],
    acceptance: [{ id: acceptanceId, statement: `${id} is complete.`, satisfied_by: [`${id}:CH-1`, `${id}:TEST-1`] }],
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

async function source(run: string, path: string, value: z.infer<typeof z.json>): Promise<ArtifactRefV1> {
  return writeImmutableValidatedJson(run, path, z.json(), value);
}

function handsInput(run: string, overrides: Record<string, unknown> = {}) {
  return {
    runDir: run,
    workItemId: "BH-001",
    planRevision: 1,
    attempt: 1,
    attemptKind: "initial" as const,
    workItem: item(),
    diff: "diff --git a/src/a.ts b/src/a.ts\n",
    ...overrides,
  };
}

async function setVerificationAuthority(
  run: string,
  workItemId: string,
  attempt: number,
  options: {
    identity?: VerificationIdentity;
    commands?: Array<{ command: string; stdout?: string }>;
    artifactChecks?: Array<{ path: string; exists: boolean; required: boolean }>;
    browserEvidence?: Array<z.input<typeof verificationBrowserEvidenceSchema>>;
  } = {},
): Promise<ArtifactRefV1> {
  const identity: VerificationIdentity = options.identity ?? (workItemId === "integrated"
    ? { scope: "integrated", work_item_id: "integrated" }
    : { scope: "local", work_item_id: workItemId });
  const evidencePath = verificationEvidencePath(identity, attempt);
  const namespace = dirname(evidencePath);
  await mkdir(join(run, namespace), { recursive: true });
  const commands = [];
  for (const [index, command] of (options.commands ?? []).entries()) {
    const stdoutPath = `${namespace}/command-${index}.stdout.txt`;
    const stderrPath = `${namespace}/command-${index}.stderr.txt`;
    const resultPath = `${namespace}/command-${index}.result.json`;
    const argv = ["sh", "-c", command.command];
    const stdout = command.stdout ?? "passed\n";
    await writeFile(join(run, stdoutPath), stdout);
    await writeFile(join(run, stderrPath), "");
    await writeImmutableValidatedJson(run, resultPath, verificationExecutionResultSchema, {
      argv,
      stdout,
      stderr: "",
      exit_code: 0,
      duration_ms: 1,
      timed_out: false,
      error_code: null,
      error_message: null,
      signal: null,
    });
    commands.push({
      command: command.command,
      argv,
      exit_code: 0,
      timed_out: false,
      error_code: null,
      error_message: null,
      signal: null,
      stdout_path: stdoutPath,
      stderr_path: stderrPath,
      result_path: resultPath,
      duration_ms: 1,
    });
  }
  const ref = await writeImmutableValidatedJson(run, evidencePath, verificationEvidenceSchema, {
    verification_scope: identity.scope,
    work_item_id: identity.work_item_id,
    ...(identity.scope === "github" ? { issue_number: identity.issue_number } : {}),
    attempt,
    evidence_path: evidencePath,
    commands,
    artifacts: [],
    artifact_checks: options.artifactChecks ?? [],
    browser_evidence: options.browserEvidence ?? [],
    created_at: createdAt,
  });
  const manifest = await readManifestV2(run);
  await updateManifestV2(run, {
    work_item_progress: {
      ...manifest.work_item_progress,
      [workItemId]: {
        ...manifest.work_item_progress[workItemId],
        status: "in_progress",
        attempts: attempt,
        verification_path: evidencePath,
        verification_scope: identity.scope,
        verification_work_item_id: identity.work_item_id,
        ...(identity.scope === "github" ? { verification_issue_number: identity.issue_number } : {}),
      },
    },
  });
  return ref;
}

async function setGithubMode(run: string, workItemId: string, issueNumber: number): Promise<void> {
  const manifest = await readManifestV2(run);
  await updateManifestV2(run, {
    mode: "github",
    run_mode: "github",
    work_item_issue_map: { ...manifest.work_item_issue_map, [workItemId]: issueNumber },
    github_ids: {
      ...manifest.github_ids,
      work_item_issue_map: { ...manifest.github_ids.work_item_issue_map, [workItemId]: issueNumber },
    },
  });
}

describe("bounded role contexts", () => {
  it("accepts only the deterministic integrated aggregate with all completed item summaries", async () => {
    const first = item("BH-001");
    const second = item("BH-002", ["BH-001"]);
    const plan: BrainPlan = {
      summary: "Integrated bounded delivery",
      assumptions: [],
      research: [],
      research_sources: ["repo"],
      architecture: "local",
      risks: [],
      work_items: [first, second],
      integration_verification: [["npm", "test"]],
    };
    const run = await runDir();
    const recorded = await recordPlan(run, JSON.stringify(plan));
    await approvePlanRevision(run, recorded.revision);
    await completeDependency(run, first, recorded);
    await completeDependency(run, second, recorded);
    await setVerificationAuthority(run, "integrated", 1, { commands: [{ command: "npm test" }] });
    const aggregate = integratedWorkItem(plan, { includeCompletedDependencies: true });

    const ref = await buildHandsContext(handsInput(run, {
      workItemId: "integrated",
      planRevision: recorded.revision,
      attempt: 2,
      attemptKind: "primary_fix",
      workItem: aggregate,
    }));
    const context = await loadRoleContext(run, ref, "hands");
    expect(context.work_item).toEqual(aggregate);
    expect(context.dependency_summaries.map((summary) => summary.work_item_id)).toEqual(["BH-001", "BH-002"]);

    await expect(buildHandsContext(handsInput(run, {
      workItemId: "integrated",
      planRevision: recorded.revision,
      attempt: 3,
      attemptKind: "primary_fix",
      workItem: { ...aggregate, objective: "forged aggregate" },
    }))).rejects.toThrow(/does not match the current approved plan/i);
  });

  it("selects optional records deterministically by explicit type priority then path", async () => {
    const run = await runDir();
    await setVerificationAuthority(run, "BH-001", 1, {
      commands: [{ command: "first" }, { command: "second" }],
      artifactChecks: [{ path: "dist/cli.js", exists: true, required: true }],
    });
    const firstRef = await buildHandsContext(handsInput(run));
    const first = await loadRoleContext(run, firstRef, "hands");
    expect(first.role).toBe("hands");
    if (first.role !== "hands") throw new Error("Expected Hands context");
    expect(first.bounded_evidence.map((record) => {
      const value = record.value as { command?: string; path?: string };
      return value.command ?? value.path;
    }))
      .toEqual(["first", "second", "dist/cli.js"]);

    const secondRef = await buildHandsContext(handsInput(run, { attempt: 2 }));
    const second = await loadRoleContext(run, secondRef, "hands");
    expect(second.role === "hands" ? second.bounded_evidence.map((record) => record.value) : null)
      .toEqual(first.bounded_evidence.map((record) => record.value));
  });

  it("accepts an exact owned quality-gate evidence pointer between reviewer actions", async () => {
    const run = await runDir();
    const qualityIdentity: VerificationIdentity = {
      scope: "local",
      work_item_id: "BH-001:quality-gate:2000101:1:authority-0123456789abcdef",
    };
    await setVerificationAuthority(run, "BH-001", 2000101, {
      identity: qualityIdentity,
      commands: [{ command: "quality gate passed" }],
    });
    const manifest = await readManifestV2(run);
    await updateManifestV2(run, {
      work_item_progress: {
        ...manifest.work_item_progress,
        "BH-001": { ...manifest.work_item_progress["BH-001"]!, attempts: 1 },
      },
    });

    const ref = await buildHandsContext(handsInput(run, { attempt: 2 }));
    const context = await loadRoleContext(run, ref, "hands");
    expect(context.role === "hands" ? context.bounded_evidence : [])
      .toEqual(expect.arrayContaining([expect.objectContaining({ value: expect.objectContaining({ command: "quality gate passed" }) })]));
  });

  it("uses a fixed-length fragment namespace for long verification identities", async () => {
    const run = await runDir();
    const identity: VerificationIdentity = { scope: "local", work_item_id: "quality-gate-".repeat(8) };
    const ref = await setVerificationAuthority(run, "BH-001", 1, {
      identity,
      commands: [{ command: "long identity passed" }],
    });
    const candidates = await verificationContextCandidates(run, ref, identity, true);
    expect(candidates[0]!.ref.path).toMatch(/^contexts\/fragments\/verification\/sha256-[a-f0-9]{64}\//);
    expect(candidates[0]!.ref.path.split("/")[3]!.length).toBeLessThanOrEqual(200);
  });

  it("enforces exact UTF-8 diff and total-byte boundaries", async () => {
    const run = await runDir();
    const exactMultibyteDiff = "é".repeat(CONTEXT_LIMITS_V1.hands_diff_bytes / 2);
    await expect(buildHandsContext(handsInput(run, {
      diff: exactMultibyteDiff,
    }))).resolves.toMatchObject({ path: expect.stringContaining("contexts/hands/") });
    const overflowRef = await buildHandsContext(handsInput(run, {
      attempt: 2,
      diff: `${exactMultibyteDiff}a`,
    }));
    const overflow = await loadRoleContext(run, overflowRef, "hands");
    expect(overflow.diff).toContain("Source diff summarized to preserve bounded role context.");
    expect(Buffer.byteLength(overflow.diff, "utf8")).toBeLessThanOrEqual(CONTEXT_LIMITS_V1.hands_diff_bytes);

    const empty = handsContextV1Schema.parse({
      schema_version: 1,
      role: "hands",
      work_item: item("BH-001", [], "x"),
      diff: "",
      active_findings: [],
      dependency_summaries: [],
      bounded_evidence: [],
      omitted_evidence: [],
    });
    const padding = CONTEXT_LIMITS_V1.hands_total_bytes - canonicalJsonBytes(handsContextV1Schema, empty).byteLength;
    const exactItem = item("BH-001", [], "x".repeat(padding + 1));
    const exactRun = await runDir([exactItem]);
    await expect(buildHandsContext(handsInput(exactRun, {
      attempt: 3,
      workItem: exactItem,
      diff: "",
    }))).resolves.toBeDefined();
    const overItem = item("BH-001", [], "x".repeat(padding + 2));
    const overRun = await runDir([overItem]);
    const overRef = await buildHandsContext(handsInput(overRun, {
      attempt: 4,
      workItem: overItem,
      diff: "",
    }));
    const overContext = await loadRoleContext(overRun, overRef, "hands");
    expect(executionSpecV2Schema.parse(overContext.work_item).objective)
      .toContain("Earlier approved objective history summarized");
    expect(canonicalJsonBytes(handsContextV1Schema, overContext).byteLength)
      .toBeLessThanOrEqual(CONTEXT_LIMITS_V1.hands_total_bytes);
  });

  it("projects oversized Hands objectives as byte-safe head and suffix context", () => {
    const objective = [
      "ORIGINAL-INTENT: preserve the initial migration constraint.",
      "中😀".repeat(3_000),
      "LATEST-INTENT: preserve the final rollout constraint.",
    ].join("\n");
    const compacted = compactHandsWorkItem(item("BH-001", [], objective)).objective;
    const marker = `[Earlier approved objective history summarized: ${Buffer.byteLength(objective, "utf8")} UTF-8 bytes, sha256 ${createHash("sha256").update(objective).digest("hex")}]`;
    const markerIndex = compacted.indexOf(marker);
    expect(markerIndex).toBeGreaterThan(0);
    const prefix = compacted.slice(0, markerIndex).replace(/\n$/, "");
    const suffix = compacted.slice(markerIndex + marker.length).replace(/^\n/, "");

    expect(compacted).toContain("ORIGINAL-INTENT: preserve the initial migration constraint.");
    expect(compacted).toContain("LATEST-INTENT: preserve the final rollout constraint.");
    expect(compacted).toContain(marker);
    expect(Buffer.byteLength(suffix, "utf8")).toBeGreaterThan(Buffer.byteLength(prefix, "utf8"));
    expect(compacted).not.toContain("\uFFFD");
    expect(Buffer.byteLength(compacted, "utf8")).toBeLessThanOrEqual(2 * 1024);
  });

  it("preserves executable acceptance authority when change units collapse", () => {
    const source = item("BH-001");
    const changeUnits = Array.from({ length: 180 }, (_, index) => ({
      ...source.change_units[0]!,
      id: `BH-001:CH-${String(index + 1).padStart(3, "0")}`,
      target: `approved target ${index + 1}`,
    }));
    const testId = source.tests[0]!.id;
    const commandId = source.verification_commands[0]!.id;
    const compacted = compactHandsWorkItem({
      ...source,
      change_units: changeUnits,
      acceptance: [
        { id: "BH-001:AC-test", statement: "Test-only authority remains executable.", satisfied_by: [testId] },
        { id: "BH-001:AC-command", statement: "Command-only authority remains executable.", satisfied_by: [commandId] },
        {
          id: "BH-001:AC-mixed",
          statement: "Mixed authority preserves order without duplicate compact references.",
          satisfied_by: [testId, changeUnits[1]!.id, commandId, changeUnits[0]!.id],
        },
      ],
      completion_contract: {
        ...source.completion_contract,
        required_acceptance_ids: ["BH-001:AC-test", "BH-001:AC-command", "BH-001:AC-mixed"],
      },
    });

    expect(compacted.change_units).toHaveLength(1);
    expect(compacted.change_units[0]!.id).toBe("compact-approved-change-units");
    expect(compacted.acceptance.map((criterion) => criterion.satisfied_by)).toEqual([
      [testId],
      [commandId],
      [testId, "compact-approved-change-units", commandId],
    ]);
  });

  it("loads the exact v0.5.1 tail-only Hands projection and rejects mutations", async () => {
    const objective = [
      "Original approved intent that legacy compaction omitted.",
      "x".repeat(CONTEXT_LIMITS_V1.hands_total_bytes),
      "LEGACY-TAIL: preserve same-run recovery.",
    ].join("\n");
    const approved = item("BH-001", [], objective);
    const currentProjection = compactHandsWorkItem(approved);
    let legacyTail = objective.slice(-(2 * 1024));
    while (Buffer.byteLength(legacyTail, "utf8") > 2 * 1024) legacyTail = legacyTail.slice(1);
    const legacyProjection = executionSpecV2Schema.parse({
      ...currentProjection,
      objective: [
        `[Earlier approved objective history summarized: ${Buffer.byteLength(objective, "utf8")} UTF-8 bytes, sha256 ${createHash("sha256").update(objective).digest("hex")}]`,
        legacyTail,
      ].join("\n"),
      acceptance: approved.acceptance.map((criterion, index) => ({
        ...criterion,
        statement: currentProjection.acceptance[index]!.statement,
        satisfied_by: criterion.satisfied_by.filter((id) =>
          currentProjection.change_units.some((unit) => unit.id === id)),
      })),
    });
    const run = await runDir([approved]);
    const persist = (attempt: number, workItem: WorkItem) => writeImmutableValidatedJson(
      run,
      handsContextPath(approved.id, 1, attempt, "initial"),
      handsContextV1Schema,
      {
        schema_version: 1,
        role: "hands",
        work_item: workItem,
        diff: "",
        active_findings: [],
        dependency_summaries: [],
        bounded_evidence: [],
        omitted_evidence: [],
      },
    );
    const ref = await persist(70, legacyProjection);
    const context = await loadRoleContext(run, ref, "hands");

    await expect(validateHandsInvocationContext({
      runDir: run,
      contextRef: ref,
      context,
      workItem: approved,
      workItemId: approved.id,
      planRevision: 1,
      attempt: 70,
      attemptKind: "initial",
    })).resolves.toMatchObject({ plan_revision: 1 });

    const mutatedRef = await persist(71, {
      ...legacyProjection,
      objective: `${legacyProjection.objective.slice(0, -1)}!`,
    });
    await expect(loadRoleContext(run, mutatedRef, "hands"))
      .rejects.toThrow(/work item does not match the current approved plan/i);
  });

  it("summarizes an oversized generated lockfile section while preserving adjacent source patches", () => {
    const source = [
      "diff --git a/package.json b/package.json",
      "--- a/package.json",
      "+++ b/package.json",
      "@@ -1 +1 @@",
      "-{}",
      "+{\"name\":\"example\"}",
      "",
    ].join("\n");
    const lockSection = [
      "diff --git a/package-lock.json b/package-lock.json",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/package-lock.json",
      "@@ -0,0 +1 @@",
      `+${"x".repeat(CONTEXT_LIMITS_V1.verifier_diff_bytes + 1)}`,
      "",
    ].join("\n");
    const bounded = boundedGeneratedLockfileDiff(`${source}${lockSection}`);
    expect(bounded).toContain("+{\"name\":\"example\"}");
    expect(bounded).toContain("Generated lockfile diff summarized");
    expect(bounded).toContain("Git patch section sha256 (not file content sha256):");
    expect(bounded).toContain("Do not compare this patch-section metadata with the worktree file size or digest.");
    expect(bounded).not.toContain("x".repeat(100));
    expect(Buffer.byteLength(bounded, "utf8")).toBeLessThanOrEqual(CONTEXT_LIMITS_V1.verifier_diff_bytes);
  });

  it("summarizes the largest source patch sections until the Verifier diff is bounded", () => {
    const smallSource = [
      "diff --git a/src/App.tsx b/src/App.tsx",
      "--- a/src/App.tsx",
      "+++ b/src/App.tsx",
      "@@ -1 +1 @@",
      "-export const App = null;",
      "+export const App = () => <main />;",
      "",
    ].join("\n");
    const largeStyles = [
      "diff --git a/src/styles.css b/src/styles.css",
      "--- a/src/styles.css",
      "+++ b/src/styles.css",
      "@@ -0,0 +1 @@",
      `+${"x".repeat(CONTEXT_LIMITS_V1.verifier_diff_bytes + 1)}`,
      "",
    ].join("\n");
    const bounded = boundedVerifierDiff(`${smallSource}${largeStyles}`);
    expect(bounded).toContain("+export const App = () => <main />;");
    expect(bounded).toContain("Source patch section summarized for bounded Verifier context.");
    expect(bounded).toContain("Path: src/styles.css");
    expect(bounded).toContain("Git patch section sha256 (not file content sha256):");
    expect(bounded).not.toContain("x".repeat(100));
    expect(Buffer.byteLength(bounded, "utf8")).toBeLessThanOrEqual(CONTEXT_LIMITS_V1.verifier_diff_bytes);
  });

  it("summarizes structured source patches for a bounded Hands context", () => {
    const patch = [
      "diff --git a/src/styles.css b/src/styles.css",
      "--- a/src/styles.css",
      "+++ b/src/styles.css",
      "@@ -0,0 +1 @@",
      `+${"x".repeat(CONTEXT_LIMITS_V1.hands_diff_bytes + 1)}`,
      "",
    ].join("\n");
    const bounded = boundedHandsDiff(patch);
    expect(bounded).toContain("Source patch section summarized for bounded Hands context.");
    expect(bounded).toContain("Path: src/styles.css");
    expect(bounded).not.toContain("x".repeat(100));
    expect(Buffer.byteLength(bounded, "utf8")).toBeLessThanOrEqual(CONTEXT_LIMITS_V1.hands_diff_bytes);
  });

  it("digest-compacts an oversized unstructured Hands diff", () => {
    const patch = "中😀".repeat(CONTEXT_LIMITS_V1.hands_diff_bytes);
    const bounded = boundedHandsDiff(patch);

    expect(bounded).toContain("Source diff summarized to preserve bounded role context.");
    expect(bounded).toContain(`Git patch bytes: ${Buffer.byteLength(patch, "utf8")}`);
    expect(bounded).toContain(`Git patch sha256: ${createHash("sha256").update(patch).digest("hex")}`);
    expect(bounded).not.toContain("中😀".repeat(100));
    expect(Buffer.byteLength(bounded, "utf8")).toBeLessThanOrEqual(CONTEXT_LIMITS_V1.hands_diff_bytes);
  });

  it("omits semantic verification evidence when it exceeds the Hands evidence cap", async () => {
    const run = await runDir();
    await setVerificationAuthority(run, "BH-001", 1, {
      commands: [{ command: "é".repeat(CONTEXT_LIMITS_V1.hands_evidence_bytes) }],
    });
    const ref = await buildHandsContext(handsInput(run));
    const context = await loadRoleContext(run, ref, "hands");
    expect(context.bounded_evidence).toEqual([]);
    expect(context.omitted_evidence).toHaveLength(1);
    expect(context.omitted_evidence[0]!.ref.path).toMatch(/^contexts\/fragments\/verification\//);
  });

  it("omits oversized optional records whole and records their authoritative refs", async () => {
    const run = await runDir();
    await setVerificationAuthority(run, "BH-001", 1, {
      commands: [{ command: "small" }, { command: "é".repeat(9_000) }],
    });
    const ref = await buildHandsContext(handsInput(run));
    const context = await loadRoleContext(run, ref, "hands");
    if (context.role !== "hands") throw new Error("Expected Hands context");
    expect(context.bounded_evidence).toHaveLength(1);
    expect(context.bounded_evidence[0]!.value).toMatchObject({ command: "small" });
    expect(context.omitted_evidence).toHaveLength(1);
    expect(JSON.stringify(context)).not.toContain("é".repeat(100));
  });

  it("compacts the diff when required omission references consume the remaining role budget", async () => {
    const diff = "diff --git a/src/app.ts b/src/app.ts\n" + "y".repeat(7_000);
    const seedItem = item("BH-001");
    const seedRun = await runDir([seedItem]);
    await setVerificationAuthority(seedRun, "BH-001", 1, {
      commands: [{ command: "é".repeat(9_000) }],
    });
    const seedRef = await buildHandsContext(handsInput(seedRun, { workItem: seedItem, diff }));
    const seedContext = await loadRoleContext(seedRun, seedRef, "hands");
    const padding = CONTEXT_LIMITS_V1.hands_total_bytes
      - canonicalJsonBytes(handsContextV1Schema, seedContext).byteLength
      + 1;
    const largeItem = item("BH-001", [], `${seedItem.objective}${"x".repeat(padding)}`);
    const run = await runDir([largeItem]);
    await setVerificationAuthority(run, "BH-001", 1, {
      commands: [{ command: "é".repeat(9_000) }],
    });
    const ref = await buildHandsContext(handsInput(run, {
      workItem: largeItem,
      diff,
    }));
    const context = await loadRoleContext(run, ref, "hands");
    expect(context.diff).toContain("Source diff summarized to preserve bounded role context");
    expect(context.bounded_evidence).toEqual([]);
    expect(context.omitted_evidence).toHaveLength(1);
    expect(canonicalJsonBytes(handsContextV1Schema, context).byteLength)
      .toBeLessThanOrEqual(CONTEXT_LIMITS_V1.hands_total_bytes);
  });

  it("compacts oversized required work-item prose before sacrificing the Hands diff", async () => {
    const largeItem = {
      ...item("BH-001"),
      risks: [{
        description: `Risk authority ${"r".repeat(45_000)}`,
        mitigation: "Keep the bounded context authoritative.",
      }],
    };
    const run = await runDir([largeItem]);
    const diff = [
      "diff --git a/src/app.ts b/src/app.ts",
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -0,0 +1 @@",
      `+${"d".repeat(CONTEXT_LIMITS_V1.hands_diff_bytes - 256)}`,
      "",
    ].join("\n");

    const ref = await buildHandsContext(handsInput(run, { workItem: largeItem, diff }));
    const context = await loadRoleContext(run, ref, "hands");

    expect(executionSpecV2Schema.parse(context.work_item).risks[0]!.description)
      .toContain("sha256=");
    expect(context.diff).toContain("diff --git a/src/app.ts b/src/app.ts");
    expect(canonicalJsonBytes(handsContextV1Schema, context).byteLength)
      .toBeLessThanOrEqual(CONTEXT_LIMITS_V1.hands_total_bytes);
  });

  it("compacts oversized integrated work-item prose before rejecting required Hands context", async () => {
    const prose = "scope detail ".repeat(1_000);
    const largeItem = {
      ...item("BH-001"),
      file_contract: [{ path: "src/app.ts", permission: "modify" as const, targets: [prose] }],
      forbidden_changes: [{ path: "package.json", except: [], reason: prose }],
      change_units: [{
        id: "CU1", path: "src/app.ts", target: prose, operation: "modify" as const,
        requirements: [prose],
      }],
      acceptance: [{ id: "AC1", statement: prose, satisfied_by: ["CU1"] }],
      tests: [{ id: "T1", path: "src/app.test.ts", assertion: prose, verification_command_ids: ["V1"] }],
      risks: [{ description: prose, mitigation: prose }],
      ambiguity_policy: { default: "stop_and_report" as const, stop_when: [prose] },
      completion_contract: {
        expected_changed_files: ["src/app.ts"], allow_additional_files: false, required_acceptance_ids: ["AC1"],
      },
    };
    const run = await runDir([largeItem]);
    const ref = await buildHandsContext(handsInput(run, { workItem: largeItem }));
    const context = await loadRoleContext(run, ref, "hands");

    expect(executionSpecV2Schema.parse(context.work_item).acceptance[0]!.statement)
      .toContain("sha256=");
    expect(canonicalJsonBytes(handsContextV1Schema, context).byteLength)
      .toBeLessThanOrEqual(CONTEXT_LIMITS_V1.hands_total_bytes);
  });

  it("rejects stale current verification authority and compacts oversized approved objectives", async () => {
    const run = await runDir();
    await setVerificationAuthority(run, "BH-001", 1, { commands: [{ command: "current" }] });
    const ref = await buildHandsContext(handsInput(run));
    await setVerificationAuthority(run, "BH-001", 2, { commands: [{ command: "new" }] });
    await expect(loadRoleContext(run, ref, "hands")).rejects.toThrow(/semantic evidence universe|verification/i);

    const advancedAttempt = await runDir();
    await setVerificationAuthority(advancedAttempt, "BH-001", 1, { commands: [{ command: "old" }] });
    const oldRef = await buildHandsContext(handsInput(advancedAttempt));
    const advancedManifest = await readManifestV2(advancedAttempt);
    await updateManifestV2(advancedAttempt, {
      work_item_progress: {
        ...advancedManifest.work_item_progress,
        "BH-001": { ...advancedManifest.work_item_progress["BH-001"], attempts: 2 },
      },
    });
    await expect(loadRoleContext(advancedAttempt, oldRef, "hands"))
      .rejects.toThrow(/current verification authority.*attempt 2/i);

    const hugeItem = item("BH-001", [], "x".repeat(CONTEXT_LIMITS_V1.hands_total_bytes));
    const hugeRun = await runDir([hugeItem]);
    const hugeRef = await buildHandsContext(handsInput(hugeRun, {
      attempt: 3,
      workItem: hugeItem,
    }));
    const hugeContext = await loadRoleContext(hugeRun, hugeRef, "hands");
    expect(executionSpecV2Schema.parse(hugeContext.work_item).objective)
      .toContain("Earlier approved objective history summarized");
  });

  it("accepts only verification from the exact current reviewer action", async () => {
    const run = await runDir();
    await setVerificationAuthority(run, "BH-001", 100_000_101, {
      commands: [{ command: "review attempt one" }],
    });
    let manifest = await readManifestV2(run);
    await updateManifestV2(run, {
      work_item_progress: {
        ...manifest.work_item_progress,
        "BH-001": {
          ...manifest.work_item_progress["BH-001"],
          attempts: 35,
          mutation_kind: "reviewer_action",
          queue_state: "in_progress",
          review_revision: 100,
          active_action_id: "R100-A1",
          active_action_attempt: 2,
        },
      },
    });
    const accepted = await buildHandsContext(handsInput(run, {
      attempt: 100_000_102,
      attemptKind: "fix_packet",
    }));
    expect((await loadRoleContext(run, accepted, "hands")).bounded_evidence).toHaveLength(1);

    await setVerificationAuthority(run, "BH-001", 100_000_103, {
      commands: [{ command: "future action attempt" }],
    });
    manifest = await readManifestV2(run);
    await updateManifestV2(run, {
      work_item_progress: {
        ...manifest.work_item_progress,
        "BH-001": {
          ...manifest.work_item_progress["BH-001"],
          attempts: 35,
          mutation_kind: "reviewer_action",
          queue_state: "in_progress",
          review_revision: 100,
          active_action_id: "R100-A1",
          active_action_attempt: 2,
        },
      },
    });
    await expect(loadRoleContext(run, accepted, "hands"))
      .rejects.toThrow(/current verification authority.*attempt 35/i);

    const unrelated = await runDir();
    await setVerificationAuthority(unrelated, "BH-001", 99_000_101, {
      commands: [{ command: "unrelated review" }],
    });
    manifest = await readManifestV2(unrelated);
    await updateManifestV2(unrelated, {
      work_item_progress: {
        ...manifest.work_item_progress,
        "BH-001": {
          ...manifest.work_item_progress["BH-001"],
          attempts: 35,
          mutation_kind: "reviewer_action",
          queue_state: "in_progress",
          review_revision: 100,
          active_action_id: "R100-A1",
          active_action_attempt: 2,
        },
      },
    });
    await expect(buildHandsContext(handsInput(unrelated, {
      attempt: 100_000_102,
      attemptKind: "fix_packet",
    }))).rejects.toThrow(/current verification authority.*attempt 35/i);
  });

  it("requires the exact authoritative summary set for declared Hands dependencies", async () => {
    const fixture = await dependencyFixture();
    const input = handsInput(fixture.runDir, {
      planRevision: fixture.planRevision,
      workItem: fixture.target,
    });
    const ref = await buildHandsContext(input);
    const context = await loadRoleContext(fixture.runDir, ref, "hands");
    expect(context.dependency_summaries.map((summary) => summary.work_item_id)).toEqual(["BH-000"]);

    const extraFixture = await dependencyFixture([]);
    await expect(buildHandsContext(handsInput(extraFixture.runDir, {
      planRevision: extraFixture.planRevision,
      workItem: extraFixture.target,
    }))).resolves.toBeDefined();

    const replanned = await recordPlan(fixture.runDir, JSON.stringify({
      work_items: [item("BH-000", [], "Changed dependency contract"), fixture.target],
    }));
    await approvePlanRevision(fixture.runDir, replanned.revision);
    await expect(buildHandsContext(handsInput(fixture.runDir, {
      attempt: 5,
      planRevision: replanned.revision,
      workItem: fixture.target,
    }))).rejects.toThrow(/dependency summary contract is stale.*BH-000/i);
  });

  it("rejects dependency summaries that are not the exact current completed progress authority", async () => {
    const inProgress = await dependencyFixture();
    let manifest = await readManifestV2(inProgress.runDir);
    await updateManifestV2(inProgress.runDir, {
      work_item_progress: {
        ...manifest.work_item_progress,
        "BH-000": { ...manifest.work_item_progress["BH-000"], status: "in_progress" },
      },
    });
    await expect(buildHandsContext(handsInput(inProgress.runDir, {
      planRevision: inProgress.planRevision,
      workItem: inProgress.target,
    }))).rejects.toThrow(/current completed dependency summary authority/i);

    const mismatched = await dependencyFixture();
    manifest = await readManifestV2(mismatched.runDir);
    await updateManifestV2(mismatched.runDir, {
      work_item_progress: {
        ...manifest.work_item_progress,
        "BH-000": {
          ...manifest.work_item_progress["BH-000"],
          summary_sha256: "f".repeat(64),
        },
      },
    });
    await expect(buildHandsContext(handsInput(mismatched.runDir, {
      planRevision: mismatched.planRevision,
      workItem: mismatched.target,
    }))).rejects.toThrow(/current completed dependency summary authority/i);
  });

  it("rejects reversed Hands and Reflection summary order", async () => {
    const handsRun = await runDir();
    const first = item("BH-010");
    const second = item("BH-020");
    const target = item("BH-030", [first.id, second.id]);
    const handsPlan = await recordPlan(handsRun, JSON.stringify({ work_items: [first, second, target] }));
    await approvePlanRevision(handsRun, handsPlan.revision);
    const handsFirstRef = await completeDependency(handsRun, first, handsPlan);
    const handsSecondRef = await completeDependency(handsRun, second, handsPlan);
    await setVerificationAuthority(handsRun, target.id, 1, { commands: [{ command: "target evidence" }] });
    const handsRef = await buildHandsContext(handsInput(handsRun, {
      workItemId: target.id,
      workItem: target,
      planRevision: handsPlan.revision,
    }));
    const hands = await readReferencedJson(handsRun, handsRef, handsContextV1Schema);
    expect(hands.dependency_summaries).toHaveLength(2);
    const reversedHands = await writeImmutableValidatedJson(
      handsRun,
      `contexts/hands/${Buffer.from(target.id).toString("base64url")}/plan-${handsPlan.revision}/attempt-90/initial.json`,
      handsContextV1Schema,
      { ...hands, dependency_summaries: [...hands.dependency_summaries].reverse() },
    );
    await expect(loadRoleContext(handsRun, reversedHands, "hands"))
      .rejects.toThrow(/authoritative order/i);
    const reversedCrossTypeOmissions = await writeImmutableValidatedJson(
      handsRun,
      `contexts/hands/${Buffer.from(target.id).toString("base64url")}/plan-${handsPlan.revision}/attempt-91/initial.json`,
      handsContextV1Schema,
      {
        ...hands,
        dependency_summaries: [],
        bounded_evidence: [],
        omitted_evidence: [
          ...hands.bounded_evidence.map(({ ref }) => ({ ref, reason: "role_byte_limit" as const })),
          ...hands.dependency_summaries.map((summary) => ({
            ref: summary.work_item_id === first.id ? handsFirstRef : handsSecondRef,
            reason: "role_byte_limit" as const,
          })),
        ],
      },
    );
    await expect(loadRoleContext(handsRun, reversedCrossTypeOmissions, "hands"))
      .rejects.toThrow(/Hands omitted evidence.*order/i);

    const reflectionRun = await runDir();
    const reflectionFirst = item("BH-110");
    const reflectionSecond = item("BH-120");
    const reflectionPlan = await recordPlan(reflectionRun, JSON.stringify({
      work_items: [reflectionFirst, reflectionSecond],
    }));
    await approvePlanRevision(reflectionRun, reflectionPlan.revision);
    const firstRef = await completeDependency(reflectionRun, reflectionFirst, reflectionPlan);
    const secondRef = await completeDependency(reflectionRun, reflectionSecond, reflectionPlan);
    const reflectionAuthority = await authorityFixture(true, {
      runDir: reflectionRun,
      planRevision: reflectionPlan.revision,
      planSha256: reflectionPlan.sha256,
      summaryRefs: [firstRef, secondRef],
    });
    const index = await readReferencedJson(reflectionRun, reflectionAuthority.indexRef, evidenceIndexV1Schema);
    const summaries = await Promise.all([firstRef, secondRef].map((ref) =>
      readReferencedJson(reflectionRun, ref, workItemSummaryV1Schema)));
    const reversedReflection = await writeImmutableValidatedJson(
      reflectionRun,
      "contexts/reflection/final.json",
      reflectionContextV1Schema,
      {
        schema_version: 1,
        role: "reflection",
        evidence_index: index,
        work_item_summaries: summaries.reverse(),
        active_findings: [],
        process_metrics: {},
        omitted_evidence: [],
      },
    );
    await expect(loadRoleContext(reflectionRun, reversedReflection, "reflection"))
      .rejects.toThrow(/authoritative order/i);

    const orderedRun = await runDir();
    const orderedFirst = item("BH-210");
    const orderedSecond = item("BH-220");
    const orderedPlan = await recordPlan(orderedRun, JSON.stringify({
      work_items: [orderedSecond, orderedFirst],
    }));
    await approvePlanRevision(orderedRun, orderedPlan.revision);
    const orderedSecondRef = await completeDependency(orderedRun, orderedSecond, orderedPlan);
    const orderedFirstRef = await completeDependency(orderedRun, orderedFirst, orderedPlan);
    const orderedAuthority = await authorityFixture(true, {
      runDir: orderedRun,
      planRevision: orderedPlan.revision,
      planSha256: orderedPlan.sha256,
      summaryRefs: [orderedSecondRef, orderedFirstRef],
    });
    const acceptedRef = await buildReflectionContext({
      runDir: orderedRun,
      evidenceIndexRef: orderedAuthority.indexRef,
      processMetrics: {},
    });
    const accepted = await loadRoleContext(orderedRun, acceptedRef, "reflection");
    expect(accepted.work_item_summaries.map((summary) => summary.work_item_id))
      .toEqual([orderedSecond.id, orderedFirst.id]);
  });

  it("rejects unrelated evidence relabeled as a semantic Hands record", async () => {
    const run = await runDir();
    const unrelated = await source(run, "reviews/unrelated.json", { command: "not current verification" });
    const forged = await writeImmutableValidatedJson(
      run,
      "contexts/hands/QkgtMDAx/plan-1/attempt-80/initial.json",
      handsContextV1Schema,
      {
        schema_version: 1,
        role: "hands",
        work_item: item(),
        diff: "",
        active_findings: [],
        dependency_summaries: [],
        bounded_evidence: [{ ref: unrelated, value: { command: "not current verification" } }],
        omitted_evidence: [],
      },
    );
    await expect(loadRoleContext(run, forged, "hands"))
      .rejects.toThrow(/semantic evidence universe/i);
  });

  it("binds work-item verification identity to the durable run mode and issue mapping", async () => {
    const localRun = await runDir();
    await setVerificationAuthority(localRun, "BH-001", 1, {
      identity: { scope: "github", work_item_id: "BH-001", issue_number: 8 },
      commands: [{ command: "local must not trust github evidence" }],
    });
    await expect(buildHandsContext(handsInput(localRun)))
      .rejects.toThrow(/verification.*provenance|identity/i);

    const githubLocalEvidence = await runDir();
    await setGithubMode(githubLocalEvidence, "BH-001", 8);
    await setVerificationAuthority(githubLocalEvidence, "BH-001", 1, {
      commands: [{ command: "github must not trust local evidence" }],
    });
    await expect(buildHandsContext(handsInput(githubLocalEvidence)))
      .rejects.toThrow(/verification.*provenance|identity/i);

    const wrongIssue = await runDir();
    await setGithubMode(wrongIssue, "BH-001", 8);
    await setVerificationAuthority(wrongIssue, "BH-001", 1, {
      identity: { scope: "github", work_item_id: "BH-001", issue_number: 9 },
      commands: [{ command: "wrong issue" }],
    });
    await expect(buildHandsContext(handsInput(wrongIssue)))
      .rejects.toThrow(/verification.*provenance|identity/i);

    const missingMapping = await runDir();
    let manifest = await readManifestV2(missingMapping);
    await updateManifestV2(missingMapping, { mode: "github", run_mode: "github" });
    await setVerificationAuthority(missingMapping, "BH-001", 1, {
      identity: { scope: "github", work_item_id: "BH-001", issue_number: 8 },
      commands: [{ command: "missing mapping" }],
    });
    manifest = await readManifestV2(missingMapping);
    expect(manifest.work_item_issue_map).toEqual({});
    await expect(buildHandsContext(handsInput(missingMapping)))
      .rejects.toThrow(/no durable GitHub issue mapping/i);

    const exact = await runDir();
    await setGithubMode(exact, "BH-001", 8);
    await setVerificationAuthority(exact, "BH-001", 1, {
      identity: { scope: "github", work_item_id: "BH-001", issue_number: 8 },
      commands: [{ command: "exact issue" }],
    });
    await expect(buildHandsContext(handsInput(exact))).resolves.toBeDefined();
  });

  it("rejects reversed selected and omitted semantic evidence order on reload", async () => {
    const run = await runDir();
    await setVerificationAuthority(run, "BH-001", 1, {
      commands: [{ command: "first" }, { command: "second" }, { command: "third" }],
    });
    const builtRef = await buildHandsContext(handsInput(run));
    const built = await readReferencedJson(run, builtRef, handsContextV1Schema);
    expect(built.bounded_evidence).toHaveLength(3);
    const reversedSelected = await writeImmutableValidatedJson(
      run,
      "contexts/hands/QkgtMDAx/plan-1/attempt-81/initial.json",
      handsContextV1Schema,
      { ...built, bounded_evidence: [...built.bounded_evidence].reverse() },
    );
    await expect(loadRoleContext(run, reversedSelected, "hands"))
      .rejects.toThrow(/ordered|order/i);

    const reversedOmitted = await writeImmutableValidatedJson(
      run,
      "contexts/hands/QkgtMDAx/plan-1/attempt-82/initial.json",
      handsContextV1Schema,
      {
        ...built,
        bounded_evidence: [],
        omitted_evidence: [...built.bounded_evidence].reverse()
          .map(({ ref }) => ({ ref, reason: "role_byte_limit" as const })),
      },
    );
    await expect(loadRoleContext(run, reversedOmitted, "hands"))
      .rejects.toThrow(/ordered|order/i);

    const mixed = await writeImmutableValidatedJson(
      run,
      "contexts/hands/QkgtMDAx/plan-1/attempt-83/initial.json",
      handsContextV1Schema,
      {
        ...built,
        bounded_evidence: [built.bounded_evidence[0]!],
        omitted_evidence: built.bounded_evidence.slice(1).reverse()
          .map(({ ref }) => ({ ref, reason: "role_byte_limit" as const })),
      },
    );
    await expect(loadRoleContext(run, mixed, "hands"))
      .rejects.toThrow(/ordered|order/i);

    const verifierRun = await runDir();
    const verifierVerificationRef = await setVerificationAuthority(verifierRun, "BH-001", 1, {
      commands: [{ command: "first" }, { command: "second" }],
    });
    const fragmentContextRef = await buildHandsContext(handsInput(verifierRun));
    const fragmentContext = await readReferencedJson(verifierRun, fragmentContextRef, handsContextV1Schema);
    const verifierRef = await writeImmutableValidatedJson(
      verifierRun,
      "contexts/verifier/QkgtMDAx/work_item/attempt-1.json",
      verifierContextV1Schema,
      {
        schema_version: 1,
        role: "verifier",
        phase: "work_item",
        work_item_id: "BH-001",
        acceptance_contract: [],
        changed_files: [],
        diff: "",
        verification_ref: verifierVerificationRef,
        command_evidence: [...fragmentContext.bounded_evidence].reverse(),
        artifact_checks: [],
        browser_evidence: [],
        active_findings: [],
        evidence_index_ref: null,
        omitted_evidence: [],
      },
    );
    await expect(loadRoleContext(verifierRun, verifierRef, "verifier"))
      .rejects.toThrow(/ordered|order/i);
  });

  it("derives typed Verifier evidence exactly and rejects a record placed in the wrong semantic field", async () => {
    const run = await runDir();
    await setVerificationAuthority(run, "BH-001", 1, {
      commands: [{ command: "npm test" }],
      artifactChecks: [{ path: "dist/cli.js", exists: true, required: true }],
      browserEvidence: [{
        name: "operator view",
        url: "https://example.test/status",
        status: "passed",
        screenshot_artifact: "artifacts/status.png",
        screenshot_exists: true,
        expected_network: [],
        observed_network: [],
        missing_network: [],
        console_errors: [],
        missing_selectors: [],
        failure_reasons: [],
        evidence_report_path: null,
        skipped_reason: null,
      }],
    });
    const ref = await buildVerifierContext({
      runDir: run,
      workItemId: "BH-001",
      phase: "work_item",
      attempt: 1,
      acceptanceContract: [{ id: "BH-001:AC-1" }],
      changedFiles: ["src/BH-001.ts"],
      diff: "",
      evidenceIndexRef: null,
    });
    const context = await loadRoleContext(run, ref, "verifier");
    expect(context.command_evidence).toHaveLength(1);
    expect(context.artifact_checks).toHaveLength(1);
    expect(context.browser_evidence).toHaveLength(1);
    const resumedRef = await buildVerifierContext({
      runDir: run,
      workItemId: "BH-001",
      phase: "work_item",
      attempt: 1,
      resume: 2,
      acceptanceContract: [{ id: "BH-001:AC-1" }],
      changedFiles: ["src/BH-001.ts"],
      diff: "",
      evidenceIndexRef: null,
    });
    expect(resumedRef.path).toBe("contexts/verifier/QkgtMDAx/work_item/attempt-1-resume-2.json");
    await expect(loadRoleContext(run, resumedRef, "verifier")).resolves.toMatchObject({ role: "verifier" });

    const wrongTypeRun = await runDir();
    const wrongTypeVerificationRef = await setVerificationAuthority(wrongTypeRun, "BH-001", 1, {
      commands: [{ command: "npm test" }],
    });
    const handsRef = await buildHandsContext(handsInput(wrongTypeRun));
    const hands = await readReferencedJson(wrongTypeRun, handsRef, handsContextV1Schema);
    const command = hands.bounded_evidence[0]!;
    const forged = await writeImmutableValidatedJson(
      wrongTypeRun,
      "contexts/verifier/QkgtMDAx/work_item/attempt-1.json",
      verifierContextV1Schema,
      {
        schema_version: 1,
        role: "verifier",
        phase: "work_item",
        work_item_id: "BH-001",
        acceptance_contract: [],
        changed_files: [],
        diff: "",
        verification_ref: wrongTypeVerificationRef,
        command_evidence: [],
        artifact_checks: [command],
        browser_evidence: [],
        active_findings: [],
        evidence_index_ref: null,
        omitted_evidence: [],
      },
    );
    await expect(loadRoleContext(wrongTypeRun, forged, "verifier"))
      .rejects.toThrow(/wrong type or value/i);
  });

  it("rejects a role package after its finding authority advances", async () => {
    const run = await runDir();
    const findingInput = {
      work_item_id: "BH-001",
      source: "verifier" as const,
      severity: "high" as const,
      disposition: "blocking" as const,
      criterion_ref: "BH-001:AC-1",
      normalized_location: "src/BH-001.ts:1",
      problem_class: "stale-context",
      problem: "The context is stale",
      required_fix: "Rebuild it",
      evidence_refs: ["verification/local/QkgtMDAx/attempt-1/evidence.json"],
      review_revision: 1,
    };
    await recordFindingRevision(run, findingInput);
    let manifest = await readManifestV2(run);
    await updateManifestV2(run, {
      work_item_progress: {
        ...manifest.work_item_progress,
        "BH-001": {
          ...manifest.work_item_progress["BH-001"],
          status: "in_progress",
          attempts: 1,
          review_revision: 1,
        },
      },
    });
    const ref = await buildHandsContext(handsInput(run));
    const context = await loadRoleContext(run, ref, "hands");
    expect(context.active_findings).toHaveLength(1);

    await recordFindingRevision(run, { ...findingInput, review_revision: 2 });
    manifest = await readManifestV2(run);
    expect(manifest.finding_index).toBeDefined();
    await expect(loadRoleContext(run, ref, "hands"))
      .rejects.toThrow(/older than the current durable finding history/i);
  });

  it("rejects forbidden broad-history keys recursively in required content", async () => {
    const run = await runDir();
    await expect(buildHandsContext(handsInput(run, {
      workItem: { ...item(), nested: { run_history: [] } },
    }))).rejects.toThrow("forbidden key run_history");
  });

  it("persists create-once packages and revalidates semantic caps when loading", async () => {
    const run = await runDir();
    const input = handsInput(run);
    const first = await buildHandsContext(input);
    await expect(buildHandsContext(input)).resolves.toEqual(first);
    await expect(buildHandsContext({ ...input, diff: "different\n" }))
      .rejects.toThrow("already exists with different bytes");

    const oversized = handsContextV1Schema.parse({
      schema_version: 1,
      role: "hands",
      work_item: item(),
      diff: "é".repeat((CONTEXT_LIMITS_V1.hands_diff_bytes / 2) + 1),
      active_findings: [],
      dependency_summaries: [],
      bounded_evidence: [],
      omitted_evidence: [],
    });
    const oversizedRef = await writeImmutableValidatedJson(
      run,
      "contexts/hands/QkgtMDAx/plan-1/attempt-99/initial.json",
      handsContextV1Schema,
      oversized,
    );
    await expect(loadRoleContext(run, oversizedRef, "hands"))
      .rejects.toThrow("Hands diff exceeds 32768 UTF-8 bytes");
  });

  it("rejects overlapping, duplicate, stale, missing, and out-of-universe omissions on reload", async () => {
    const run = await runDir();
    await setVerificationAuthority(run, "BH-001", 1, { commands: [{ command: "partition" }] });
    const builtRef = await buildHandsContext(handsInput(run));
    const built = await readReferencedJson(run, builtRef, handsContextV1Schema);
    const evidence = built.bounded_evidence[0]!.ref;
    const broad = await source(run, "prompts/unrelated.json", { value: 2 });
    const base = {
      ...built,
    };
    const persist = (attempt: number, value: unknown) => writeImmutableValidatedJson(
      run,
      `contexts/hands/QkgtMDAx/plan-1/attempt-${attempt}/initial.json`,
      handsContextV1Schema,
      value,
    );
    const overlap = await persist(90, {
      ...base,
      omitted_evidence: [{ ref: evidence, reason: "role_byte_limit" }],
    });
    await expect(loadRoleContext(run, overlap, "hands")).rejects.toThrow(/duplicate.*source path/i);

    const duplicate = await persist(91, {
      ...base,
      bounded_evidence: [],
      omitted_evidence: [
        { ref: evidence, reason: "role_byte_limit" },
        { ref: evidence, reason: "role_byte_limit" },
      ],
    });
    await expect(loadRoleContext(run, duplicate, "hands")).rejects.toThrow(/duplicate.*source path/i);

    const stale = await persist(92, {
      ...base,
      bounded_evidence: [],
      omitted_evidence: [{ ref: { ...evidence, sha256: "f".repeat(64) }, reason: "role_byte_limit" }],
    });
    await expect(loadRoleContext(run, stale, "hands")).rejects.toThrow(/semantic evidence universe/i);

    const missing = await persist(93, {
      ...base,
      bounded_evidence: [],
      omitted_evidence: [{
        ref: { path: "verification/sources/missing.json", sha256: "f".repeat(64) },
        reason: "role_byte_limit",
      }],
    });
    await expect(loadRoleContext(run, missing, "hands")).rejects.toThrow(/semantic evidence universe/i);

    const outside = await persist(94, {
      ...base,
      bounded_evidence: [],
      omitted_evidence: [{ ref: broad, reason: "role_byte_limit" }],
    });
    await expect(loadRoleContext(run, outside, "hands")).rejects.toThrow(/semantic evidence universe/i);
  });

  it("builds strict Verifier packages and requires a phase-matching terminal index", async () => {
    const fixture = await authorityFixture();
    const run = fixture.runDir;
    const finalIndex = fixture.indexRef;
    const ref = await buildVerifierContext({
      runDir: run,
      workItemId: "integrated",
      phase: "final_integrated",
      attempt: 1,
      acceptanceContract: [{ id: "AC-1" }],
      changedFiles: ["src/a.ts"],
      diff: "diff --git a/src/a.ts b/src/a.ts\n",
      evidenceIndexRef: finalIndex,
    });
    expect(ref.path).toBe("contexts/verifier/aW50ZWdyYXRlZA/final_integrated/attempt-1.json");
    const context = await loadRoleContext(run, ref, "verifier");
    expect(context.role === "verifier" ? context.command_evidence : null).toEqual([]);

    await expect(buildVerifierContext({
      runDir: run,
      workItemId: "integrated",
      phase: "post_pr",
      attempt: 2,
      acceptanceContract: [],
      changedFiles: [],
      diff: "",
      evidenceIndexRef: finalIndex,
    })).rejects.toThrow(/evidence index path does not match.*phase.*attempt/i);

    const manifest = await readManifestV2(run);
    await updateManifestV2(run, {
      work_item_progress: {
        ...manifest.work_item_progress,
        integrated: {
          ...manifest.work_item_progress.integrated,
          attempts: 2,
          verification_path: "verification/integrated/attempt-2/evidence.json",
        },
      },
    });
    await expect(loadRoleContext(run, ref, "verifier"))
      .rejects.toThrow(/integrated verification.*current durable authority/i);
  });

  it("builds Reflection packages and rejects expected-role or path mismatches on reload", async () => {
    const fixture = await authorityFixture(true);
    const run = fixture.runDir;
    const reflectionIndex = fixture.indexRef;
    const ref = await buildReflectionContext({
      runDir: run,
      evidenceIndexRef: reflectionIndex,
      processMetrics: { retries: 1 },
    });
    expect(ref.path).toBe("contexts/reflection/final.json");
    const context = await loadRoleContext(run, ref, "reflection");
    expect(context.role === "reflection" ? context.process_metrics : null).toEqual({ retries: 1 });
    await expect(loadRoleContext(run, ref, "hands")).rejects.toThrow("Role-context path does not match hands");
    await expect(loadRoleContext(run, { ...ref, path: "contexts/reflection/other.json" }, "reflection"))
      .rejects.toThrow("Role-context path does not match reflection");
  });

  it("rejects a forged embedded Reflection index even when its identity fields match", async () => {
    const fixture = await authorityFixture(true);
    const index = await readReferencedJson(fixture.runDir, fixture.indexRef, evidenceIndexV1Schema);
    const forged = reflectionContextV1Schema.parse({
      schema_version: 1,
      role: "reflection",
      evidence_index: { ...index, created_at: "2026-07-16T12:00:01.000Z" },
      work_item_summaries: [],
      active_findings: [],
      process_metrics: {},
      omitted_evidence: [],
    });
    const ref = await writeImmutableValidatedJson(
      fixture.runDir,
      "contexts/reflection/final.json",
      reflectionContextV1Schema,
      forged,
    );
    await expect(loadRoleContext(fixture.runDir, ref, "reflection"))
      .rejects.toThrow(/embedded reflection evidence index is not current authority/i);
  });

  it("requires included and omitted Reflection summaries to exactly partition the index universe", async () => {
    const completed = await dependencyFixture(undefined, "BH-000", false);
    const fixture = await authorityFixture(true, {
      runDir: completed.runDir,
      planRevision: completed.planRevision,
      planSha256: completed.planSha256,
      summaryRefs: [completed.dependencyRef],
    });
    const ref = await buildReflectionContext({
      runDir: fixture.runDir,
      evidenceIndexRef: fixture.indexRef,
      processMetrics: {},
    });
    const context = await loadRoleContext(fixture.runDir, ref, "reflection");
    expect(context.work_item_summaries.map((summary) => summary.work_item_id)).toEqual(["BH-000"]);
    expect(context.omitted_evidence).toEqual([]);
  });
});
