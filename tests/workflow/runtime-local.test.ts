import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexInvocationError, type CodexAdapter } from "../../src/adapters/codex.js";
import { defaultConfig } from "../../src/core/config.js";
import { initialDiscoveryState } from "../../src/core/discovery.js";
import { approvePlanRevision, createRunLedgerV2, readManifestV2, recordPlan, recordTerminalDisposition, transitionRun, updateManifestV2, writeTextArtifact } from "../../src/core/ledger.js";
import { reviewCycleStateSchema, verificationEvidenceSchema } from "../../src/core/schema.js";
import { canonicalJsonBytes } from "../../src/core/context-contracts.js";
import { verificationEvidencePath, verificationIdentityDirectory } from "../../src/core/types.js";
import type { ActionResolutionReview, BrainPlan, HandsSelfReviewReport, ImplementationResult, ResolvedRunIntake, ReviewerAction, RunManifestV2, VerificationEvidence, VerifierReview, WorkItem } from "../../src/core/types.js";
import type { VerifyWorkItemInput } from "../../src/workflow/verifier.js";
import type { RunVerificationInput } from "../../src/verification/runner.js";
import type { LocalRuntimeDependencies, RunLocalWorkflowInput } from "../../src/workflow/runtime.js";
import { assertImplementationScope, runLocalWorkflow } from "../../src/workflow/runtime.js";
import { actionResolutionReviewPath } from "../../src/workflow/action-verifier.js";
import { runHandsFixPacket } from "../../src/workflow/worker.js";
import { approvePreparedReplanRevision } from "../../src/workflow/replan.js";
import { executionSpec } from "../fixtures/execution-spec.js";
import { openProgressReporter, readProgressEvents, type ProgressReporter } from "../../src/progress/log.js";
import { createLegacyRunLedgerV2 } from "../fixtures/legacy-run.js";
import * as ledgerModule from "../../src/core/ledger.js";
import { authorizeDiagnosticResume, recoveryDecisionArtifactV1Schema } from "../../src/workflow/recovery-ledger.js";
import { recoveryScopePathComponent } from "../../src/workflow/recovery-policy.js";
import { workItemSummaryPath } from "../../src/workflow/work-item-summaries.js";
import { assessFinalDelivery } from "../../src/workflow/assurance.js";
import * as evidenceIndexWorkflow from "../../src/workflow/evidence-index.js";
import { hashReviewFixPacket } from "../../src/core/review-fix-packet.js";
import { fingerprintFinding, loadFindingRevisionRecords } from "../../src/workflow/findings.js";
import { approveDiscoveryBrief, recordDiscoveryBrief, recordDiscoveryReadiness } from "../../src/core/discovery-ledger.js";
const codexMetrics = { usage: null, durationMs: 0, processStarted: false, turnStarted: false, structuredTerminalError: false } as const;

async function enableBoundedProtocol(runDir: string): Promise<void> {
  const policy = defaultConfig().resource_budget;
  await mkdir(join(runDir, "budgets", "claims"), { recursive: true });
  await mkdir(join(runDir, "budgets", "completions"), { recursive: true });
  await writeFile(join(runDir, "budgets", "policy.json"), `${JSON.stringify(policy, null, 2)}\n`);
  const manifest = await readManifestV2(runDir);
  await writeFile(join(runDir, "manifest.json"), `${JSON.stringify({
    ...manifest,
    workflow_protocol: "bounded-context-v1",
    discovery: manifest.discovery ?? initialDiscoveryState(),
    resource_budget_policy: policy,
    updated_at: new Date().toISOString(),
  }, null, 2)}\n`);
}
import { resolvedRunConfigurationSchema, serializeRunConfiguration } from "../../src/core/run-configuration.js";
import { serializePersistedPlan } from "../../src/core/execution-spec.js";
import { readOperatorStatus } from "../../src/workflow/status.js";
import { recordAndApprovePinnedInitialPlan, recordApprovedDiscoveryForPlan } from "../fixtures/pinned-plan.js";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const intake: ResolvedRunIntake = {
  task: "Run local workflow", repo_root: "/tmp/repo", mode: "local", research: false, reflection: false,
  models: { brain: "brain", hands: "hands", verifier: "verifier" }, resolved_models: { brain: "brain", hands: "hands", verifier: "verifier" },
  roles: { brain: { model: "brain", reasoning_effort: "high", sandbox: "read-only" }, hands: { model: "hands", reasoning_effort: "medium", sandbox: "workspace-write" }, verifier: { model: "verifier", reasoning_effort: "high", sandbox: "read-only" } },
};
const controllerProvenance = {
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
const approvalControllerCapture = async () => ({ provenance: controllerProvenance, selfHosting: false });
async function writePinnedRunConfigurationFixture(runDir: string, repoRoot: string): Promise<void> {
  const manifestBefore = await readManifestV2(runDir);
  const sourceCommit = gitHead(repoRoot);
  const manifest = {
    ...manifestBefore,
    repo_root: repoRoot,
    source_commit: sourceCommit,
    controller_provenance: {
      ...controllerProvenance,
      candidate_commit: sourceCommit,
    },
    updated_at: new Date().toISOString(),
  };
  await writeFile(join(runDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const intakePath = manifestBefore.intake_path ?? "intake.json";
  const persistedIntake = JSON.parse(await readFile(join(runDir, intakePath), "utf8"));
  await writeFile(join(runDir, intakePath), `${JSON.stringify({
    ...persistedIntake,
    repo_root: repoRoot,
  }, null, 2)}\n`, "utf8");
  const config = defaultConfig();
  const configuration = resolvedRunConfigurationSchema.parse({
    version: 2,
    repository: manifest.repo_root,
    mode: manifest.mode,
    research: intake.research,
    reflection: intake.reflection,
    controller: {
      package_name: controllerProvenance.package_name,
      package_version: controllerProvenance.package_version,
      mode: controllerProvenance.mode,
    },
    roles: {
      brain: { ...manifest.role_profiles.brain, source: "repository_config" },
      hands: { ...manifest.role_profiles.hands, source: "repository_config" },
      verifier: { ...manifest.role_profiles.verifier, source: "repository_config" },
    },
    hands_backup: manifest.hands_backup_policy ?? null,
    limits: {
      max_hands_fix_attempts: config.retry_policy.max_hands_fix_attempts,
      max_replan_attempts: config.retry_policy.max_replan_attempts,
      review_policy: manifest.review_policy_snapshot ?? config.review_policy,
      quality_gate: manifest.quality_gate_policy ?? null,
    },
    github: {
      effects: manifest.mode === "github" ? "issues_and_pull_request" : "none",
      default_remote: config.github.default_remote,
    },
    workflow_protocol: "bounded-context-v1",
    resource_budget: manifest.resource_budget_policy ?? config.resource_budget,
  });
  await writeFile(join(runDir, "run-configuration.json"), serializeRunConfiguration(configuration), "utf8");
}
async function materializePinnedWorktreeFixture(runDir: string, sourceWorktree: string): Promise<string> {
  const manifest = await readManifestV2(runDir);
  if (!manifest.worktree_path) throw new Error("Pinned fixture requires a manifest worktree path");
  if (!manifest.branch_name) throw new Error("Pinned fixture requires a manifest branch name");
  await mkdir(join(manifest.repo_root, ".brain-hands", "worktrees"), { recursive: true });
  execFileSync("git", ["worktree", "add", "-b", manifest.branch_name, manifest.worktree_path, "HEAD"], { cwd: sourceWorktree });
  return manifest.worktree_path;
}
function item(id: string, dependencies: string[] = []): WorkItem {
  return executionSpec(id, dependencies);
}
const plan: BrainPlan = { summary: "Run local", assumptions: [], research: [], research_sources: ["repo"], architecture: "local", risks: [], work_items: [item("second", ["first"]), item("first")], integration_verification: [["npm", "test", "--", "integration.test.ts"]] };
const qualityBackup = {
  fallback_on_primary_usage_limit: true,
  max_quality_recovery_attempts: 1 as const,
  profile: { model: "backup-hands", reasoning_effort: "medium" as const },
};
const cleanSnapshot = async () => ({ branch: "codex/test", status: "", gitDir: ".git", gitCommonDir: ".git", isLinkedWorktree: false });
function identity(workItemId: string) { return workItemId === "integrated" ? { scope: "integrated" as const, work_item_id: "integrated" as const } : { scope: "local" as const, work_item_id: workItemId }; }
function evidence(workItemId: string): VerificationEvidence { const current = identity(workItemId); const prefix = `${verificationIdentityDirectory(current)}/attempt-1`; return { verification_scope: current.scope, work_item_id: current.work_item_id, attempt: 1, evidence_path: verificationEvidencePath(current, 1), commands: [{ command: "npm test", argv: ["npm", "test"], exit_code: 0, timed_out: false, error_code: null, error_message: null, signal: null, stdout_path: `${prefix}/command-1.stdout.txt`, stderr_path: `${prefix}/command-1.stderr.txt`, result_path: `${prefix}/command-1.json` }], artifacts: [], artifact_checks: [], browser_evidence: [], created_at: new Date().toISOString() } as VerificationEvidence; }
function failedEvidence(workItemId: string): VerificationEvidence { const current = identity(workItemId); const prefix = `${verificationIdentityDirectory(current)}/attempt-1`; return { verification_scope: current.scope, work_item_id: current.work_item_id, attempt: 1, evidence_path: verificationEvidencePath(current, 1), commands: [{ command: "npm test", argv: ["npm", "test"], exit_code: 1, timed_out: false, error_code: null, error_message: null, signal: null, stdout_path: `${prefix}/failure.stdout.txt`, stderr_path: `${prefix}/failure.stderr.txt` }], artifacts: [], artifact_checks: [{ path: "required.json", exists: false, required: true }], browser_evidence: [], created_at: new Date().toISOString() } as VerificationEvidence; }
function workItemId(input: RunVerificationInput): string { return input.identity?.work_item_id ?? "first"; }
function evidenceForInput(input: RunVerificationInput): VerificationEvidence {
  const current = input.identity ?? identity(workItemId(input));
  const attempt = input.attempt ?? 1;
  const prefix = `${verificationIdentityDirectory(current)}/attempt-${attempt}`;
  const commands = input.commands.length > 0
    ? input.commands.map((command) => Array.isArray(command) ? [...command] : [command])
    : evidence(workItemId(input)).commands.map((command) => command.argv ?? [command.command]);
  return {
    ...evidence(workItemId(input)),
    verification_scope: current.scope,
    work_item_id: current.work_item_id,
    attempt,
    evidence_path: verificationEvidencePath(current, attempt),
    commands: commands.map((argv, index) => ({
      command: argv.join(" "),
      argv,
      exit_code: 0,
      timed_out: false,
      error_code: null,
      error_message: null,
      signal: null,
      stdout_path: `${prefix}/command-${index + 1}.stdout.txt`,
      stderr_path: `${prefix}/command-${index + 1}.stderr.txt`,
      result_path: `${prefix}/command-${index + 1}.json`,
    })),
  } as VerificationEvidence;
}
function verifierEvidenceRef(input: VerifyWorkItemInput): string {
  return input.verification?.evidence_path
    ?? input.context?.verification_ref.path
    ?? input.context?.command_evidence[0]?.ref.path
    ?? input.context?.artifact_checks[0]?.ref.path
    ?? input.context?.browser_evidence[0]?.ref.path
    ?? input.context?.evidence_index_ref?.path
    ?? input.contextRef?.path
    ?? "missing-verifier-evidence";
}
function namespacedEvidence(issue: number, parentAttempt: number, artifactNamespace: string): VerificationEvidence {
  const pass = artifactNamespace.match(/^self-review-pass-(\d+)$/)?.[1];
  const baseWorkItem = issue === 1 ? "first" : `wrong-${issue}`;
  const syntheticId = `${baseWorkItem}:quality-gate:${parentAttempt}:${pass ?? "baseline"}`;
  return evidence(syntheticId);
}
async function persistCompletedQualityGate(input: {
  runDir: string;
  workItemId: string;
  issueNumber: number;
  attempt: number;
  corrupt?: "report" | "report_mutation" | "result" | "evidence";
}) {
  const mutation = evidence(`${input.workItemId}:quality-gate:${input.attempt}:baseline`);
  const passOne = evidence(`${input.workItemId}:quality-gate:${input.attempt}:1`);
  const finalIdentity = identity(input.workItemId);
  const expectedPassTwoPath = verificationEvidencePath(finalIdentity, input.attempt);
  const passTwoStored = input.corrupt === "evidence"
    ? evidenceForInput({ runDir: input.runDir, repoRoot: process.cwd(), identity: identity(`wrong-${input.workItemId}`), attempt: input.attempt, commands: [] })
    : evidenceForInput({ runDir: input.runDir, repoRoot: process.cwd(), identity: finalIdentity, attempt: input.attempt, commands: [] });
  await persistEvidenceBundle(input.runDir, mutation);
  await persistEvidenceBundle(input.runDir, passOne, input.corrupt === "result");
  await persistEvidenceBundle(input.runDir, passTwoStored);
  const reportPaths: Record<string, string> = {};
  for (const pass of [1, 2]) {
    const path = `self-review/${input.workItemId}/attempt-${input.attempt}/pass-${pass}.json`;
    const report = selfReviewReport(
      input.workItemId,
      input.corrupt === "report" && pass === 1 ? 99 : input.attempt,
      pass,
      true,
      input.corrupt === "report_mutation" && pass === 1 ? "quality_recovery" : input.attempt === 1 ? "initial" : "normal_fix",
    );
    await writeTextArtifact(input.runDir, path, `${JSON.stringify(report)}\n`);
    reportPaths[String(pass)] = path;
  }
  return {
    mutationPath: mutation.evidence_path,
    finalPath: expectedPassTwoPath,
    reportPaths,
    selfReviewEvidencePaths: { "1": passOne.evidence_path, "2": expectedPassTwoPath },
  };
}
async function persistEvidenceBundle(runDir: string, value: VerificationEvidence, corruptResult = false): Promise<void> {
  await writeTextArtifact(runDir, value.evidence_path, `${JSON.stringify(value)}\n`);
  for (const command of value.commands) {
    await writeTextArtifact(runDir, command.stdout_path, "stdout");
    await writeTextArtifact(runDir, command.stderr_path, "stderr");
    if (command.result_path) {
      await writeTextArtifact(runDir, command.result_path, `${JSON.stringify({
        argv: command.argv ?? [], stdout: "stdout", stderr: "stderr",
        exit_code: corruptResult ? 1 : command.exit_code,
        duration_ms: command.duration_ms ?? 0, timed_out: command.timed_out,
        error_code: command.error_code, error_message: command.error_message, signal: command.signal,
      })}\n`);
    }
  }
}
function implementation(id: string): ImplementationResult { return { work_item_id: id, changed_files: [`src/${id}.ts`], tests_added_or_changed: [], commands_attempted: [], completed_steps: [id], remaining_risks: [] }; }
function selfReviewReport(workItemId: string, parentAttempt: number, pass: number, changed = true, mutationKind: HandsSelfReviewReport["mutation_kind"] = parentAttempt === 1 ? "initial" : "normal_fix"): HandsSelfReviewReport {
  return {
    work_item_id: workItemId,
    parent_attempt: parentAttempt,
    mutation_kind: mutationKind,
    pass,
    active_action_id: null,
    findings: [],
    fixes_applied: changed ? [`fixed pass ${pass}`] : [],
    changed_files: changed ? [`src/${workItemId}.ts`] : [],
    commands_attempted: [],
    remaining_findings: [],
    ready_for_resolution_check: true,
  };
}
function qualityConfig(passes: number) {
  const config = defaultConfig();
  config.retry_policy.quality_gate = {
    hands_self_review_passes: passes,
    max_attempts_per_reviewer_action: 2,
    require_focused_verifier_confirmation: true,
  };
  return config;
}
function review(decision: VerifierReview["decision"], workItemId = "first", attempt = 1, final = false): VerifierReview { return { work_item_id: workItemId, attempt, final, decision, acceptance_coverage: [], evidence_reviewed: [], findings: decision === "approve" ? [] : [{ severity: "medium", file: `src/${decision}.ts`, line: null, acceptance_criterion: "The item works", problem: "problem", required_fix: "fix it", re_verification: [] }], residual_risks: [] }; }
function packetReview(workItemId = "first", attempt = 1): VerifierReview {
  const verificationPath = verificationEvidencePath(identity(workItemId), attempt);
  return {
    ...review("request_changes", workItemId, attempt, false),
    failure_class: "implementation_failure",
    blocker: null,
    blocker_code: null,
    acceptance_coverage: [`${workItemId} works`],
    evidence_reviewed: [verificationPath],
    findings: [{
      severity: "medium",
      file: `src/${workItemId}.ts`,
      line: null,
      acceptance_criterion: `${workItemId} works`,
      problem_class: "correctness",
      problem: "The implementation is incomplete.",
      required_fix: "Complete the approved implementation.",
      evidence_refs: [verificationPath],
      action_id: "R1-A1",
      order: 1,
      depends_on: [],
      remediation: {
        schema_version: 1,
        diagnosis: {
          observed_behavior: "The implementation is incomplete.",
          expected_behavior: `${workItemId} works`,
          failure_mechanism: "The approved behavior is missing.",
          reproduction: ["Run the approved verification command."],
          evidence_refs: [verificationPath],
        },
        targets: [{ kind: "code", path: `src/${workItemId}.ts`, symbol: `${workItemId} implementation`, line_hint: null }],
        remediation: {
          strategy: "Complete the approved behavior.",
          change_units: [{
            id: "FIX-1", path: `src/${workItemId}.ts`, target: `${workItemId} implementation`, operation: "modify",
            requirements: [`Implement the specified ${workItemId} behavior.`], satisfies: ["SC-1"],
          }],
          allowed_files: [`src/${workItemId}.ts`],
          forbidden_changes: [],
        },
        verification: {
          commands: [{ id: "CMD-1", argv: ["node", "node_modules/vitest/vitest.mjs", "run", `tests/${workItemId}.test.ts`] }],
          success_conditions: [{ id: "SC-1", statement: `${workItemId} works`, satisfied_by: ["CMD-1", "EVID-1"] }],
          required_evidence: [{ id: "EVID-1", kind: "test_result", source_id: "CMD-1", output_path: verificationPath }],
        },
        completion_contract: { required_change_unit_ids: ["FIX-1"], expected_changed_files: [`src/${workItemId}.ts`], allow_additional_files: false },
      },
    } as never],
  };
}

function packetFinding(workItem: WorkItem, evidencePath: string) {
  const criterion = workItem.acceptance[0]!;
  const command = workItem.verification_commands[0]!;
  return {
    severity: "medium" as const,
    file: workItem.file_contract[0]!.path,
    line: null,
    acceptance_criterion: criterion.id,
    problem_class: "correctness" as const,
    problem: "Packet behavior is still wrong",
    required_fix: "Apply the packet-scoped correction",
    evidence_refs: [evidencePath],
    action_id: "R1-A1",
    order: 1,
    depends_on: [],
    remediation: {
      schema_version: 1 as const,
      diagnosis: {
        observed_behavior: "Packet behavior is still wrong",
        expected_behavior: "Packet behavior is correct",
        failure_mechanism: "The implementation is incomplete",
        reproduction: [command.argv.join(" ")],
        evidence_refs: [evidencePath],
      },
      targets: [{ kind: "code" as const, path: workItem.file_contract[0]!.path, symbol: workItem.file_contract[0]!.targets[0]!, line_hint: null }],
      remediation: {
        strategy: "Apply the bounded correction",
        change_units: [{
          id: "FIX-1", path: workItem.file_contract[0]!.path, target: workItem.file_contract[0]!.targets[0]!,
          operation: "modify" as const, requirements: ["Implement the exact packet behavior."], satisfies: ["SC-1"],
        }],
        allowed_files: [workItem.file_contract[0]!.path],
        forbidden_changes: [],
      },
      verification: {
        commands: [{ id: "CMD-1", argv: [...command.argv] }],
        success_conditions: [{ id: "SC-1", statement: "The packet behavior is correct", satisfied_by: ["CMD-1", "EVID-1"] }],
        required_evidence: [{ id: "EVID-1", kind: "test_result" as const, source_id: "CMD-1", output_path: "verification/packet-result.json" }],
      },
      completion_contract: {
        required_change_unit_ids: ["FIX-1"],
        expected_changed_files: [workItem.file_contract[0]!.path],
        allow_additional_files: false as const,
      },
    },
  };
}
function advisoryPacketFinding(workItem: WorkItem, evidencePath: string) {
  const criterion = workItem.acceptance[0]!;
  const command = workItem.verification_commands[0]!;
  const contract = workItem.file_contract[1]!;
  return {
    severity: "low" as const,
    file: contract.path,
    line: null,
    acceptance_criterion: criterion.id,
    problem_class: "maintainability" as const,
    problem: "Advisory cleanup remains",
    required_fix: "Perform advisory cleanup",
    evidence_refs: [evidencePath],
    action_id: "R1-A2",
    order: 2,
    depends_on: [],
    remediation: {
      schema_version: 1 as const,
      diagnosis: {
        observed_behavior: "Advisory cleanup remains", expected_behavior: "Advisory cleanup is complete",
        failure_mechanism: "Cleanup was omitted", reproduction: [command.argv.join(" ")], evidence_refs: [evidencePath],
      },
      targets: [{ kind: "test" as const, path: contract.path, test_name: contract.targets[0]!, line_hint: null }],
      remediation: {
        strategy: "Perform advisory cleanup",
        change_units: [{ id: "LOW-FIX-1", path: contract.path, target: contract.targets[0]!, operation: "modify" as const, requirements: ["Complete the advisory cleanup."], satisfies: ["LOW-SC-1"] }],
        allowed_files: [contract.path], forbidden_changes: [],
      },
      verification: {
        commands: [{ id: "LOW-CMD-1", argv: [...command.argv] }],
        success_conditions: [{ id: "LOW-SC-1", statement: "Advisory cleanup is complete", satisfied_by: ["LOW-CMD-1", "LOW-EVID-1"] }],
        required_evidence: [{ id: "LOW-EVID-1", kind: "test_result" as const, source_id: "LOW-CMD-1", output_path: "verification/advisory-result.json" }],
      },
      completion_contract: { required_change_unit_ids: ["LOW-FIX-1"], expected_changed_files: [contract.path], allow_additional_files: false as const },
    },
  };
}
async function persistReview(runDir: string, path: string, value: VerifierReview): Promise<string> { await writeTextArtifact(runDir, path, `${JSON.stringify(value, null, 2)}\n`); return path; }
async function setup(
  qualityGate?: ReturnType<typeof qualityConfig>["retry_policy"]["quality_gate"],
  backup?: ReturnType<typeof qualityConfig>["retry_policy"]["backup"],
  policyEnabled = false,
) {
  const root = await mkdtemp(join(tmpdir(), "brain-hands-runtime-"));
  const worktree = join(root, "worktree");
  await mkdir(worktree, { recursive: true });
  execFileSync("git", ["init"], { cwd: worktree });
  execFileSync("git", ["config", "user.name", "Codex Test"], { cwd: worktree });
  execFileSync("git", ["config", "user.email", "codex@example.com"], { cwd: worktree });
  execFileSync("git", ["commit", "--allow-empty", "-m", "initial"], { cwd: worktree });
  const ledger = await createLegacyRunLedgerV2({
    repoRoot: root,
    originalRequest: intake.task,
    intake: qualityGate || backup
      ? { ...intake, repo_root: root, quality_gate: qualityGate, hands_backup: backup }
      : { ...intake, repo_root: root },
  });
  if (!policyEnabled) {
    const manifestPath = join(ledger.runDir, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    delete manifest.review_policy_snapshot;
    delete manifest.review_accounting;
    delete manifest.release_guards;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  }
  await transitionRun(ledger.runDir, "preflight"); await transitionRun(ledger.runDir, "brain_planning"); await transitionRun(ledger.runDir, "awaiting_plan_approval"); await transitionRun(ledger.runDir, "worktree_setup");
  return { root, runDir: ledger.runDir, worktree };
}

async function setupBounded(
  workflowPlan: BrainPlan,
  policyEnabled = false,
  qualityGate?: ReturnType<typeof qualityConfig>["retry_policy"]["quality_gate"],
) {
  const setupResult = await setup(qualityGate, undefined, policyEnabled);
  await enableBoundedProtocol(setupResult.runDir);
  await updateManifestV2(setupResult.runDir, { stage: "brain_discovery" });
  const brief = {
    revision: 1,
    goal: intake.task,
    problem: "Runtime fixture requires bounded workflow governance.",
    constraints: [],
    decisions: [],
    assumptions: [],
    repository_evidence: ["tests/workflow/runtime-local.test.ts"],
    success_criteria: ["Run the bounded local workflow"],
    accepted_risks: [],
    out_of_scope: [],
    selected_approach_id: null,
    selected_approach_rationale: null,
  };
  await recordDiscoveryReadiness(setupResult.runDir, {
    outcome: "no_discovery_needed",
    rationale: "Runtime fixture provides the approved plan directly.",
    repository_evidence: ["tests/workflow/runtime-local.test.ts"],
    approaches: [],
    alternatives_omitted_reason: "Fixture has one deterministic local path.",
    brief,
  });
  await recordDiscoveryBrief(setupResult.runDir, brief);
  await approveDiscoveryBrief(setupResult.runDir, 1);
  const discoveryDigest = (await readManifestV2(setupResult.runDir)).discovery!.approved_brief_sha256!;
  const persistedPlan = {
    ...workflowPlan,
    discovery_brief_revision: 1,
    discovery_brief_sha256: discoveryDigest,
    discovery_decision_coverage: [],
    accepted_risks: [],
    out_of_scope: [],
  };
  const recorded = await recordPlan(setupResult.runDir, `${JSON.stringify(persistedPlan)}\n`);
  await approvePlanRevision(setupResult.runDir, recorded.revision, { actor: "test" });
  await updateManifestV2(setupResult.runDir, { stage: "worktree_setup" });
  return { ...setupResult, recorded };
}

function boundedEvidence(input: RunVerificationInput): VerificationEvidence {
  const workItem = input.identity?.work_item_id ?? "first";
  const attempt = input.attempt ?? 1;
  const currentIdentity = input.identity ?? identity(workItem);
  const path = verificationEvidencePath(currentIdentity, attempt);
  const directory = verificationIdentityDirectory(currentIdentity);
  const command = input.commands[0];
  const argv = Array.isArray(command) ? [...command] : [command ?? "npm test"];
  return {
    verification_scope: currentIdentity.scope,
    work_item_id: currentIdentity.work_item_id,
    attempt,
    evidence_path: path,
    commands: [{
      command: argv.join(" "),
      argv,
      exit_code: 0,
      timed_out: false,
      error_code: null,
      error_message: null,
      signal: null,
      stdout_path: `${directory}/attempt-${attempt}/command-1.stdout.txt`,
      stderr_path: `${directory}/attempt-${attempt}/command-1.stderr.txt`,
      result_path: `${directory}/attempt-${attempt}/command-1.json`,
    }],
    artifacts: [],
    artifact_checks: [],
    browser_evidence: [],
    created_at: new Date().toISOString(),
  } as VerificationEvidence;
}

function boundedDependencies(
  crashAt?: "after_work_item_completion_commit" | "after_work_item_summary_persisted" | "after_work_item_summary_pointer",
  mutateWorktree = false,
) {
  let crash = crashAt !== undefined;
  let handsCalls = 0;
  let itemVerifierCalls = 0;
  const dependencies: LocalRuntimeDependencies = {
    hands: async (input) => {
      handsCalls += 1;
      if (input.workItem.id !== "integrated") {
        const progress = (await readManifestV2(input.runDir)).work_item_progress[input.workItem.id];
        expect(progress?.context_base_commit).toMatch(/^[a-f0-9]{40,64}$/);
        expect(progress?.context_plan_revision).toBe((await readManifestV2(input.runDir)).approved_revision);
        if (mutateWorktree) {
          await mkdir(join(input.worktreePath, "src"), { recursive: true });
          await writeFile(join(input.worktreePath, `src/${input.workItem.id}.ts`), `export const completed = "${input.workItem.id}";\n`, "utf8");
        }
      }
      const value = implementation(input.workItem.id);
      const reportPath = `implementation/${input.workItem.id}/attempt-${input.attempt}.json`;
      await writeTextArtifact(input.runDir, reportPath, `${JSON.stringify(value)}\n`);
      return { implementation: value, reportPath, invocation: {} as never };
    },
    verification: async (input) => {
      const value = boundedEvidence(input);
      await persistEvidenceBundle(input.runDir, value);
      return value;
    },
    verifier: async (input) => {
      if (!input.final) itemVerifierCalls += 1;
      expect(input.contextRef).toBeDefined();
      expect(input.context).toMatchObject({ role: "verifier", phase: input.final ? "final_integrated" : "work_item" });
      expect(input.phase).toBe(input.context?.phase);
      expect(input.context?.verification_ref.path).toBe(verifierEvidenceRef(input));
      expect(Object.hasOwn(input, "implementation")).toBe(false);
      expect(Object.hasOwn(input, "verification")).toBe(false);
      expect(Object.hasOwn(input, "priorVerification")).toBe(false);
      if (input.final) {
        expect(input.context?.evidence_index_ref?.path).toBe(
          evidenceIndexWorkflow.verifierEvidenceIndexPath("final_integrated", input.attempt ?? 1),
        );
        expect((await readManifestV2(input.runDir)).final_verifier_index_path).toBe(
          evidenceIndexWorkflow.verifierEvidenceIndexPath("final_integrated", input.attempt ?? 1),
        );
      } else {
        expect(input.context?.evidence_index_ref).toBeNull();
      }
      const evidencePath = verifierEvidenceRef(input);
      const value: VerifierReview = {
        ...review("approve", input.workItem.id, input.attempt, input.final),
        failure_class: "none",
        blocker: null,
        blocker_code: null,
        acceptance_coverage: input.workItem.completion_contract.required_acceptance_ids,
        evidence_reviewed: [evidencePath],
      };
      const path = input.final
        ? `reviews/integrated/final-attempt-${input.attempt}.json`
        : `reviews/${input.workItem.id}/attempt-${input.attempt}.json`;
      return { review: value, reviewPath: await persistReview(input.runDir, path, value), invocation: {} as never };
    },
    ...(mutateWorktree ? {} : {
      hasWorktreeChanges: async () => false,
      gitSnapshot: cleanSnapshot,
    }),
    afterCheckpoint: async (checkpoint) => {
      if (crash && checkpoint === crashAt) {
        crash = false;
        throw new Error(`crash at ${checkpoint}`);
      }
    },
  };
  return { dependencies, handsCalls: () => handsCalls, itemVerifierCalls: () => itemVerifierCalls };
}
function boundedQueueDependencies(
  workItem: WorkItem,
  crashAt?: "after_work_item_completion_commit" | "after_work_item_summary_persisted",
  mutateWorktree = true,
) {
  const harness = boundedDependencies(crashAt, mutateWorktree);
  const baseVerifier = harness.dependencies.verifier!;
  let itemReviews = 0;
  let verifierCalls = 0;
  let packetCalls = 0;
  const dependencies: LocalRuntimeDependencies = {
    ...harness.dependencies,
    verifier: async (input) => {
      if (!input.final) verifierCalls += 1;
      if (input.final || itemReviews++ > 0) return baseVerifier(input);
      const evidencePath = verifierEvidenceRef(input);
      const value: VerifierReview = {
        ...review("request_changes", input.workItem.id, input.attempt, false),
        failure_class: "implementation_failure", blocker: null, blocker_code: null,
        acceptance_coverage: [], evidence_reviewed: [evidencePath],
        findings: [{
          ...packetFinding(input.workItem, evidencePath),
          action_id: "R1-A1", order: 1, depends_on: [],
        } as ReviewerAction],
      };
      return {
        review: value,
        reviewPath: await persistReview(input.runDir, `reviews/${input.workItem.id}/attempt-${input.attempt}.json`, value),
        invocation: {} as never,
      };
    },
    handsFixPacket: async (input) => {
      packetCalls += 1;
      if (mutateWorktree) {
        await mkdir(join(input.worktreePath, "src"), { recursive: true });
        await writeFile(join(input.worktreePath, input.packet.completion_contract.expected_changed_files[0]!), "export const queueFixed = true;\n", "utf8");
      }
      const result = {
        schema_version: 1 as const,
        packet_id: input.packet.provenance.packet_id,
        packet_sha256: hashReviewFixPacket(input.packet),
        action_attempt: input.actionAttempt,
        status: "implemented" as const,
        change_units: input.packet.remediation.change_units.map((unit) => ({
          change_unit_id: unit.id, status: "completed" as const,
          changed_files: [unit.path], summary: "Applied queue fix",
        })),
        changed_files: input.packet.completion_contract.expected_changed_files,
        commands_attempted: [], unresolved_requirements: [], blocker: null,
      };
      const rootPath = `reviews/fix-packets/${Buffer.from(input.packet.provenance.packet_id).toString("base64url")}`;
      const reportPath = `${rootPath}/attempts/${input.actionAttempt}/hands-result.json`;
      await writeTextArtifact(input.runDir, reportPath, `${JSON.stringify(result)}\n`);
      const profile = input.profile ?? input.intake.roles.hands;
      return { result, reportPath, invocation: {} as never, profile: { kind: input.profileKind ?? "primary", model: profile.model, reasoning_effort: profile.reasoning_effort } };
    },
    packetVerifier: async (input) => {
      const reviewValue = {
        packet_id: input.packet.provenance.packet_id,
        packet_sha256: hashReviewFixPacket(input.packet),
        action_attempt: input.actionAttempt,
        decision: "resolved" as const,
        condition_results: input.packet.verification.success_conditions.map((condition) => ({
          success_condition_id: condition.id, status: "satisfied" as const,
          evidence_refs: [input.verificationEvidence.evidence_path!], remaining_problem: null,
        })),
        required_next_fix: null, blocker: null,
      };
      const rootPath = `reviews/fix-packets/${Buffer.from(input.packet.provenance.packet_id).toString("base64url")}`;
      const reviewPath = `${rootPath}/attempts/${input.actionAttempt}/focused-resolution.json`;
      await writeTextArtifact(input.runDir, reviewPath, `${JSON.stringify(reviewValue)}\n`);
      return { review: reviewValue, reviewPath, invocation: {} as never };
    },
  };
  return { dependencies, handsCalls: harness.handsCalls, packetCalls: () => packetCalls, verifierCalls: () => verifierCalls, workItem };
}
function gitHead(worktreePath: string): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: worktreePath, encoding: "utf8" }).trim();
}
function gitCommitCount(worktreePath: string): number {
  return Number(execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: worktreePath, encoding: "utf8" }).trim());
}
let root: string | undefined;
afterEach(async () => { vi.restoreAllMocks(); if (root) await rm(root, { recursive: true, force: true }); root = undefined; });

describe("runLocalWorkflow", () => {
  it("does not invoke the final Verifier when the final-integrated index cannot be reloaded", async () => {
    const boundedPlan = { ...plan, work_items: [item("first")] };
    const setupResult = await setupBounded(boundedPlan); root = setupResult.root;
    const harness = boundedDependencies();
    const verifier = vi.fn(harness.dependencies.verifier!);
    vi.spyOn(evidenceIndexWorkflow, "loadEvidenceIndex").mockRejectedValueOnce(
      new Error("simulated missing final-integrated evidence index"),
    );

    const result = await runLocalWorkflow({
      runDir: setupResult.runDir,
      worktreePath: join(setupResult.root, "worktree"),
      intake: { ...intake, repo_root: setupResult.root },
      plan: boundedPlan,
      codex: {} as never,
      dependencies: { ...harness.dependencies, verifier },
      deferTerminalDisposition: true,
    });

    expect(result.status).toBe("human_action_required");
    expect(result.blocker).toMatch(/evidence index|final-integrated/i);
    expect(verifier.mock.calls.filter(([input]) => input.final === true)).toHaveLength(0);
  });

  it("does not invoke the final Verifier when the scoped snapshot HEAD differs from the indexed candidate", async () => {
    const boundedPlan = { ...plan, work_items: [item("first")] };
    const setupResult = await setupBounded(boundedPlan); root = setupResult.root;
    const harness = boundedDependencies();
    const verifier = vi.fn(harness.dependencies.verifier!);
    const result = await runLocalWorkflow({
      runDir: setupResult.runDir,
      worktreePath: join(setupResult.root, "worktree"),
      intake: { ...intake, repo_root: setupResult.root },
      plan: boundedPlan,
      codex: {} as never,
      dependencies: {
        ...harness.dependencies,
        verifier,
        collectScopedWorktreeDiff: async (input) => ({
          base_commit: input.baseCommit,
          head_commit: (input.workItem as WorkItem).id !== "integrated"
            ? input.baseCommit
            : "f".repeat(40),
          changed_files: [],
          patch: "",
          patch_bytes: 0,
        }),
      },
      deferTerminalDisposition: true,
    });

    expect(result.status).toBe("human_action_required");
    expect(result.blocker).toMatch(/HEAD.*authority/i);
    expect(verifier.mock.calls.filter(([input]) => input.final === true)).toHaveLength(0);
  });

  it("keeps actual final Hands fixes available across rejected candidate rechecks", async () => {
    const boundedPlan = { ...plan, work_items: [item("first")] };
    const config = qualityConfig(1);
    config.retry_policy.max_hands_fix_attempts = 2;
    const setupResult = await setupBounded(boundedPlan, false, config.retry_policy.quality_gate); root = setupResult.root;
    await updateManifestV2(setupResult.runDir, {
      worktree_path: join(setupResult.root, "worktree"),
      branch_name: "codex/test",
    });
    const harness = boundedDependencies();
    const baseHands = harness.dependencies.hands!;
    const baseVerifier = harness.dependencies.verifier!;
    const baseVerification = harness.dependencies.verification!;
    let handsCalls = 0;
    let commitCrash = true;
    let finalReviews = 0;
    const integratedVerificationAttempts: number[] = [];
    const integratedHandsKinds: string[] = [];
    const integratedMutationKinds: string[] = [];
    const integratedContextRefs: string[] = [];
    const integratedContextBases: string[] = [];
    const integratedContextDiffs: string[] = [];
    const dependencies: LocalRuntimeDependencies = {
      ...harness.dependencies,
      hands: async (input) => {
        handsCalls += 1;
        if (input.workItem.id !== "integrated") return baseHands(input);
        integratedHandsKinds.push(`${input.attempt}:${input.attemptKind}`);
        expect(input.contextRef).toBeDefined();
        expect(input.context).toBeDefined();
        expect(input).not.toHaveProperty("findings");
        expect(input).not.toHaveProperty("diagnosticContext");
        integratedContextRefs.push(`${input.contextRef!.path}:${input.contextRef!.sha256}`);
        integratedContextBases.push((await readManifestV2(input.runDir)).work_item_progress.integrated!.context_base_commit!);
        integratedContextDiffs.push(input.context!.diff);
        expect(input.context!.work_item).toEqual(input.workItem);
        expect(input.context!.dependency_summaries.map((summary) => summary.work_item_id)).toEqual(["first"]);
        await mkdir(join(input.worktreePath, "src"), { recursive: true });
        await writeFile(join(input.worktreePath, "src/first.ts"), `export const fixed = ${input.attempt};\n`, "utf8");
        const value = { ...implementation("integrated"), changed_files: ["src/first.ts"] };
        const reportPath = `implementation/integrated/attempt-${input.attempt}.json`;
        await writeTextArtifact(input.runDir, reportPath, `${JSON.stringify(value)}\n`);
        return { implementation: value, reportPath, invocation: {} as never };
      },
      verification: async (input) => {
        if (input.identity?.work_item_id === "integrated") integratedVerificationAttempts.push(input.attempt ?? 1);
        return baseVerification(input);
      },
      gitSnapshot: async (worktreePath) => ({
        branch: "main",
        status: execFileSync("git", ["status", "--short"], { cwd: worktreePath, encoding: "utf8" }),
        gitDir: ".git",
        gitCommonDir: ".git",
        isLinkedWorktree: false,
      }),
      verifier: async (input) => {
        if (!input.final) return baseVerifier(input);
        finalReviews += 1;
        const attempt = input.attempt ?? 1;
        const requested = finalReviews === 1 || finalReviews === 3;
        const value: VerifierReview = {
          ...review(requested ? "request_changes" : "approve", "integrated", attempt, true),
          failure_class: requested ? "implementation_failure" : "none",
          blocker: null,
          blocker_code: null,
          acceptance_coverage: input.workItem.completion_contract.required_acceptance_ids,
          evidence_reviewed: [verifierEvidenceRef(input)],
          findings: requested ? [{
            severity: "medium",
            file: "src/first.ts",
            line: null,
            acceptance_criterion: "first works",
            problem: "The integrated candidate needs a final fix.",
            required_fix: "Apply the final fix.",
            re_verification: [],
          }] : [],
        };
        const path = `reviews/integrated/final-attempt-${attempt}.json`;
        return { review: value, reviewPath: await persistReview(input.runDir, path, value), invocation: {} as never };
      },
      selfReview: async (input) => {
        if (input.workItem.id === "integrated") integratedMutationKinds.push(`${input.parentAttempt}:${input.mutationKind}`);
        const report = selfReviewReport(input.workItem.id, input.parentAttempt, input.pass, false, input.mutationKind);
        const path = `self-review/${input.workItem.id}/attempt-${input.parentAttempt}/pass-${input.pass}.json`;
        await writeTextArtifact(input.runDir, path, `${JSON.stringify(report)}\n`);
        return { report, reportPath: path, invocation: {} as never };
      },
      diff: async () => "bounded terminal diff",
      afterCheckpoint: async (checkpoint) => {
        if (commitCrash && checkpoint === "after_candidate_recheck_commit") {
          commitCrash = false;
          throw new Error("crash after committed candidate");
        }
      },
    };
    const workflowInput: RunLocalWorkflowInput = {
      runDir: setupResult.runDir,
      worktreePath: join(setupResult.root, "worktree"),
      intake: { ...intake, repo_root: setupResult.root },
      plan: boundedPlan,
      codex: {} as never,
      config,
      dependencies,
      deferTerminalDisposition: true,
    };

    const interrupted = await runLocalWorkflow(workflowInput);
    expect(interrupted.status).toBe("human_action_required");
    expect(interrupted.blocker).toContain("crash after committed candidate");
    const handsAfterCrash = handsCalls;
    const commitsAfterCrash = gitCommitCount(join(setupResult.root, "worktree"));

    const result = await runLocalWorkflow(workflowInput);

    expect(result.status, result.blocker).toBe("local_ready");
    expect(handsCalls).toBe(handsAfterCrash + 1);
    expect(gitCommitCount(join(setupResult.root, "worktree"))).toBe(commitsAfterCrash + 1);
    expect(integratedVerificationAttempts).toEqual([1, 2, 3, 4, 5]);
    expect(integratedHandsKinds).toEqual(["2:primary_fix", "4:primary_fix"]);
    expect(integratedMutationKinds).toEqual(["2:normal_fix", "4:normal_fix"]);
    expect(integratedContextRefs).toHaveLength(2);
    expect(new Set(integratedContextBases)).toEqual(new Set([integratedContextBases[0]!]));
    expect(integratedContextDiffs[1]!.length).toBeGreaterThanOrEqual(integratedContextDiffs[0]!.length);
    const manifest = await readManifestV2(setupResult.runDir);
    const head = gitHead(join(setupResult.root, "worktree"));
    expect(manifest.work_item_progress.integrated).toMatchObject({
      status: "complete",
      attempts: 5,
      commit_sha: head,
      verification_path: "verification/integrated/attempt-5/evidence.json",
      review_path: "reviews/integrated/final-attempt-5.json",
      terminal_hands_fix_attempts: 2,
      mutation_kind: "normal_fix",
    });
    expect(manifest.final_verifier_index_path).toBe(
      evidenceIndexWorkflow.verifierEvidenceIndexPath("final_integrated", 5),
    );
    expect(manifest.final_verifier_index_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.work_item_progress.integrated?.candidate_recheck).toBeUndefined();
    const assessment = await assessFinalDelivery(setupResult.runDir);
    expect(assessment.outcome, JSON.stringify(assessment)).toBe("verified_ready");
  }, 30_000);

  it("reports the configured terminal Hands-fix limit", async () => {
    const boundedPlan = { ...plan, work_items: [item("first")] };
    const setupResult = await setupBounded(boundedPlan); root = setupResult.root;
    const harness = boundedDependencies();
    const baseVerifier = harness.dependencies.verifier!;
    const config = defaultConfig();
    config.retry_policy.max_hands_fix_attempts = 1;
    delete config.retry_policy.quality_gate;
    const result = await runLocalWorkflow({
      runDir: setupResult.runDir,
      worktreePath: join(setupResult.root, "worktree"),
      intake: { ...intake, repo_root: setupResult.root },
      plan: boundedPlan,
      codex: {} as never,
      config,
      dependencies: {
        ...harness.dependencies,
        hands: async (input) => {
          if (input.workItem.id !== "integrated") return harness.dependencies.hands!(input);
          const value = { ...implementation("integrated"), changed_files: ["src/first.ts"] };
          const reportPath = `implementation/integrated/attempt-${input.attempt}.json`;
          await writeTextArtifact(input.runDir, reportPath, `${JSON.stringify(value)}\n`);
          return { implementation: value, reportPath, invocation: {} as never };
        },
        verifier: async (input) => {
          if (!input.final) return baseVerifier(input);
          const value = {
            ...review("request_changes", "integrated", input.attempt, true),
            failure_class: "implementation_failure" as const,
            blocker: null,
            blocker_code: null,
            acceptance_coverage: input.workItem.completion_contract.required_acceptance_ids,
            evidence_reviewed: [verifierEvidenceRef(input)],
          };
          const path = `reviews/integrated/final-attempt-${input.attempt}.json`;
          return { review: value, reviewPath: await persistReview(input.runDir, path, value), invocation: {} as never };
        },
      },
      deferTerminalDisposition: true,
    });

    expect(result.status).toBe("human_action_required");
    expect(result.blocker).toBe("Final integrated Verifier reached the configured limit of 1 actual Hands fix (1 used)");
  });

  it.each([
    "after_work_item_completion_commit",
    "after_work_item_summary_persisted",
    "after_work_item_summary_pointer",
  ] as const)("recovers bounded completion after %s without rerunning Hands", async (checkpoint) => {
    const boundedPlan = { ...plan, work_items: [item("first")] };
    const setupResult = await setupBounded(boundedPlan); root = setupResult.root;
    const harness = boundedDependencies(checkpoint);
    const workflowInput: RunLocalWorkflowInput = {
      runDir: setupResult.runDir,
      worktreePath: join(setupResult.root, "worktree"),
      intake: { ...intake, repo_root: setupResult.root },
      plan: boundedPlan,
      codex: {} as never,
      dependencies: harness.dependencies,
      deferTerminalDisposition: true,
    };

    expect((await runLocalWorkflow(workflowInput)).status).toBe("human_action_required");
    expect(harness.itemVerifierCalls()).toBe(1);
    const interrupted = await readManifestV2(setupResult.runDir);
    const summaryPath = workItemSummaryPath("first", setupResult.recorded.revision, 1);
    if (checkpoint === "after_work_item_completion_commit") {
      expect(interrupted.work_item_progress.first).toMatchObject({ status: "in_progress", commit_sha: "no-op" });
      await expect(readFile(join(setupResult.runDir, summaryPath), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } else if (checkpoint === "after_work_item_summary_persisted") {
      expect(interrupted.work_item_progress.first?.status).toBe("in_progress");
      expect(interrupted.work_item_progress.first).not.toHaveProperty("summary_path");
      expect(await readFile(join(setupResult.runDir, summaryPath), "utf8")).toContain('"work_item_id": "first"');
    } else {
      expect(interrupted.work_item_progress.first).toMatchObject({ status: "complete", summary_path: summaryPath });
    }

    const result = await runLocalWorkflow(workflowInput);
    expect(result.status, result.blocker).toBe("local_ready");
    const completed = await readManifestV2(setupResult.runDir);
    expect(completed.work_item_progress.first).toMatchObject({
      status: "complete",
      context_plan_revision: setupResult.recorded.revision,
      summary_path: summaryPath,
    });
    expect(completed.work_item_progress.first?.context_base_commit).toMatch(/^[a-f0-9]{40,64}$/);
    expect(completed.work_item_progress.first?.summary_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(harness.handsCalls()).toBe(1);
    expect(harness.itemVerifierCalls()).toBe(1);
  });

  it("loads one immutable Hands context per bounded attempt and keeps the original diff base across fixes", async () => {
    const boundedPlan = { ...plan, work_items: [item("first")] };
    const setupResult = await setupBounded(boundedPlan); root = setupResult.root;
    const worktreePath = join(setupResult.root, "worktree");
    const handsContexts: Array<{
      ref: NonNullable<Parameters<NonNullable<LocalRuntimeDependencies["hands"]>>[0]["contextRef"]>;
      context: NonNullable<Parameters<NonNullable<LocalRuntimeDependencies["hands"]>>[0]["context"]>;
      kind: string | undefined;
      base: string;
    }> = [];
    const diffBases: string[] = [];
    let itemReviews = 0;

    const result = await runLocalWorkflow({
      runDir: setupResult.runDir,
      worktreePath,
      intake: { ...intake, repo_root: setupResult.root },
      plan: boundedPlan,
      codex: {} as never,
      deferTerminalDisposition: true,
      dependencies: {
        hands: async (input) => {
          if (input.workItem.id === "first") {
            const progress = (await readManifestV2(input.runDir)).work_item_progress.first!;
            expect(input.contextRef).toBeDefined();
            expect(input.context).toBeDefined();
            expect(input).not.toHaveProperty("findings");
            expect(input).not.toHaveProperty("diagnosticContext");
            handsContexts.push({
              ref: input.contextRef!,
              context: input.context!,
              kind: input.attemptKind,
              base: progress.context_base_commit!,
            });
            await mkdir(join(input.worktreePath, "src"), { recursive: true });
            await writeFile(join(input.worktreePath, "src/first.ts"), `export const attempt = ${input.attempt};\n`, "utf8");
          }
          const value = implementation(input.workItem.id);
          const reportPath = `implementation/${input.workItem.id}/attempt-${input.attempt}.json`;
          await writeTextArtifact(input.runDir, reportPath, `${JSON.stringify(value)}\n`);
          return { implementation: value, reportPath, invocation: {} as never };
        },
        collectScopedWorktreeDiff: async (input) => {
          diffBases.push(input.baseCommit);
          const changed = await readFile(join(input.repoRoot, "src/first.ts"), "utf8").catch(() => "");
          const patch = changed.length > 0 ? `COMPLETE_DIFF_FROM_${input.baseCommit}\n${changed}` : "";
          return {
            base_commit: input.baseCommit,
            head_commit: input.baseCommit,
            changed_files: changed.length > 0 ? ["src/first.ts"] : [],
            patch,
            patch_bytes: Buffer.byteLength(patch, "utf8"),
          };
        },
        verification: async (input) => {
          const value = boundedEvidence(input);
          await persistEvidenceBundle(input.runDir, value);
          await writeTextArtifact(
            input.runDir,
            value.evidence_path,
            canonicalJsonBytes(verificationEvidenceSchema, value).toString("utf8"),
          );
          return value;
        },
        verifier: async (input) => {
          const decision = input.final || itemReviews++ > 0 ? "approve" : "request_changes";
          const value: VerifierReview = {
            ...review(decision, input.workItem.id, input.attempt, input.final),
            failure_class: decision === "approve" ? "none" : "implementation_failure",
            blocker: null,
            blocker_code: null,
            acceptance_coverage: input.workItem.completion_contract.required_acceptance_ids,
            evidence_reviewed: [verifierEvidenceRef(input)],
          };
          const path = input.final
            ? `reviews/integrated/final-attempt-${input.attempt}.json`
            : `reviews/${input.workItem.id}/attempt-${input.attempt}.json`;
          return { review: value, reviewPath: await persistReview(input.runDir, path, value), invocation: {} as never };
        },
      },
    });

    expect(result.status, result.blocker).toBe("local_ready");
    expect(handsContexts.map(({ kind }) => kind)).toEqual(["initial", "primary_fix"]);
    expect(handsContexts.map(({ ref }) => ref.path)).toEqual([
      expect.stringMatching(/\/attempt-1\/initial\.json$/),
      expect.stringMatching(/\/attempt-2\/primary_fix\.json$/),
    ]);
    expect(handsContexts[0]!.context.diff).toBe("# No local diff was detected.\n");
    expect(handsContexts[1]!.context.diff).toContain("COMPLETE_DIFF_FROM_");
    expect(new Set(handsContexts.map(({ base }) => base))).toEqual(new Set([handsContexts[0]!.base]));
    expect(diffBases).toContain(handsContexts[0]!.base);
    expect(handsContexts[1]!.ref.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("routes bounded quality recovery through its immutable context without building legacy diagnostics", async () => {
    const boundedPlan = { ...plan, work_items: [item("first")] };
    const config = defaultConfig();
    config.retry_policy.max_hands_fix_attempts = 1;
    delete config.retry_policy.quality_gate;
    config.retry_policy.backup = {
      fallback_on_primary_usage_limit: true,
      max_quality_recovery_attempts: 1,
      profile: { model: "backup-hands", reasoning_effort: "medium" },
    };
    const setupResult = await setup(config.retry_policy.quality_gate, config.retry_policy.backup); root = setupResult.root;
    await enableBoundedProtocol(setupResult.runDir);
    const recorded = await recordPlan(setupResult.runDir, `${JSON.stringify(boundedPlan)}\n`);
    await approvePlanRevision(setupResult.runDir, recorded.revision, { actor: "test" });
    const kinds: string[] = [];
    let itemReviews = 0;

    const result = await runLocalWorkflow({
      runDir: setupResult.runDir,
      worktreePath: join(setupResult.root, "worktree"),
      intake: { ...intake, repo_root: setupResult.root, hands_backup: config.retry_policy.backup },
      plan: boundedPlan,
      codex: {} as never,
      config,
      deferTerminalDisposition: true,
      dependencies: {
        hands: async (input) => {
          if (input.workItem.id === "first") {
            expect(input.contextRef).toBeDefined();
            expect(input.context).toBeDefined();
            expect(input).not.toHaveProperty("findings");
            expect(input).not.toHaveProperty("diagnosticContext");
            kinds.push(input.attemptKind!);
          }
          const value = implementation(input.workItem.id);
          const reportPath = `implementation/${input.workItem.id}/attempt-${input.attempt}.json`;
          await writeTextArtifact(input.runDir, reportPath, `${JSON.stringify({
            ...value,
            model: input.profile?.model ?? intake.roles.hands.model,
            reasoning_effort: input.profile?.reasoning_effort ?? intake.roles.hands.reasoning_effort,
            profile_kind: input.profileKind ?? "primary",
          })}\n`);
          return { implementation: value, reportPath, invocation: {} as never };
        },
        diff: async () => { throw new Error("legacy diagnostic diff must not be built"); },
        verification: async (input) => {
          const value = boundedEvidence(input);
          await persistEvidenceBundle(input.runDir, value);
          return value;
        },
        verifier: async (input) => {
          const requested = !input.final && itemReviews++ < 2;
          const value: VerifierReview = {
            ...review(requested ? "request_changes" : "approve", input.workItem.id, input.attempt, input.final),
            failure_class: requested ? "implementation_failure" : "none",
            blocker: null,
            blocker_code: null,
            acceptance_coverage: input.workItem.completion_contract.required_acceptance_ids,
            evidence_reviewed: [verifierEvidenceRef(input)],
          };
          const path = input.final
            ? `reviews/integrated/final-attempt-${input.attempt}.json`
            : `reviews/${input.workItem.id}/attempt-${input.attempt}.json`;
          return { review: value, reviewPath: await persistReview(input.runDir, path, value), invocation: {} as never };
        },
        modelCatalog: async () => ({ models: [{ slug: "backup-hands", supported_reasoning_levels: [{ effort: "medium" }] }] }),
        hasWorktreeChanges: async () => false,
        gitSnapshot: cleanSnapshot,
      },
    });

    expect(result.status, result.blocker).toBe("local_ready");
    expect(kinds).toEqual(["initial", "primary_fix", "quality_recovery"]);
  });

  it("reuses the immutable bounded context after a Hands transport crash", async () => {
    const boundedPlan = { ...plan, work_items: [item("first")] };
    const setupResult = await setupBounded(boundedPlan); root = setupResult.root;
    const harness = boundedDependencies();
    const baseHands = harness.dependencies.hands!;
    const refs: string[] = [];
    let crash = true;
    const workflowInput: RunLocalWorkflowInput = {
      runDir: setupResult.runDir,
      worktreePath: join(setupResult.root, "worktree"),
      intake: { ...intake, repo_root: setupResult.root },
      plan: boundedPlan,
      codex: {} as never,
      dependencies: {
        ...harness.dependencies,
        hands: async (input) => {
          if (input.workItem.id === "first") {
            refs.push(`${input.contextRef?.path}:${input.contextRef?.sha256}`);
            if (crash) {
              crash = false;
              throw new Error("simulated transport crash after context load");
            }
          }
          return baseHands(input);
        },
      },
      deferTerminalDisposition: true,
    };

    const interrupted = await runLocalWorkflow(workflowInput);
    expect(interrupted.status).toBe("human_action_required");
    expect(interrupted.blocker).toContain("simulated transport crash");
    expect(refs).toHaveLength(1);

    const resumed = await runLocalWorkflow(workflowInput);
    expect(resumed.status, resumed.blocker).toBe("local_ready");
    expect(refs).toHaveLength(2);
    expect(refs[1]).toBe(refs[0]);
  });

  it("adopts a torn packet focused review and supplement without repeating attempt one", async () => {
    const workItem = item("first");
    const boundedPlan = { ...plan, work_items: [workItem] };
    const config = qualityConfig(0);
    const setupResult = await setupBounded(boundedPlan, false, config.retry_policy.quality_gate); root = setupResult.root;
    const harness = boundedDependencies();
    const baseVerifier = harness.dependencies.verifier!;
    let itemReviews = 0;
    const packetAttempts: number[] = [];
    const packetVerifierAttempts: number[] = [];
    const supplementPointers: Array<string | null | undefined> = [];
    let crashAfterSupplementWrite = true;
    const dependencies: LocalRuntimeDependencies = {
      ...harness.dependencies,
      verifier: async (input) => {
        if (input.final || itemReviews++ > 0) return baseVerifier(input);
        const evidencePath = verifierEvidenceRef(input);
        const value: VerifierReview = {
          ...review("request_changes", input.workItem.id, input.attempt, false),
          failure_class: "implementation_failure",
          blocker: null,
          blocker_code: null,
          acceptance_coverage: [],
          evidence_reviewed: [evidencePath],
          findings: [packetFinding(workItem, evidencePath)],
        };
        return {
          review: value,
          reviewPath: await persistReview(input.runDir, `reviews/first/attempt-${input.attempt}.json`, value),
          invocation: {} as never,
        };
      },
      handsFixPacket: async (input) => {
        packetAttempts.push(input.actionAttempt);
        const progress = (await readManifestV2(input.runDir)).work_item_progress.first!;
        supplementPointers.push(progress.fix_packet_supplement_path);
        if (input.actionAttempt === 1) expect(input.supplement).toBeNull();
        if (input.actionAttempt === 2) {
          expect(input.supplement?.next_attempt).toBe(2);
          expect(progress.fix_packet_supplement_path).toMatch(/attempts\/2\/attempt-supplement\.json$/);
        }
        await mkdir(join(input.worktreePath, "src"), { recursive: true });
        await writeFile(join(input.worktreePath, "src/first.ts"), `export const packetAttempt = ${input.actionAttempt};\n`, "utf8");
        const packetSha256 = hashReviewFixPacket(input.packet);
        const result = {
          schema_version: 1 as const,
          packet_id: input.packet.provenance.packet_id,
          packet_sha256: packetSha256,
          action_attempt: input.actionAttempt,
          status: "implemented" as const,
          change_units: input.packet.remediation.change_units.map((unit) => ({
            change_unit_id: unit.id,
            status: "completed" as const,
            changed_files: [unit.path],
            summary: "Applied packet change",
          })),
          changed_files: input.packet.completion_contract.expected_changed_files,
          commands_attempted: [],
          unresolved_requirements: [],
          blocker: null,
        };
        const reportPath = `reviews/fix-packets/${Buffer.from(input.packet.provenance.packet_id).toString("base64url")}/attempts/${input.actionAttempt}/hands-result.json`;
        await writeTextArtifact(input.runDir, reportPath, `${JSON.stringify(result)}\n`);
        const profile = input.profile ?? input.intake.roles.hands;
        return { result, reportPath, invocation: {} as never, profile: { kind: input.profileKind ?? "primary", model: profile.model, reasoning_effort: profile.reasoning_effort } };
      },
      packetVerifier: async (input) => {
        packetVerifierAttempts.push(input.actionAttempt);
        const stillOpen = input.actionAttempt === 1;
        const reviewValue = {
          packet_id: input.packet.provenance.packet_id,
          packet_sha256: hashReviewFixPacket(input.packet),
          action_attempt: input.actionAttempt,
          decision: stillOpen ? "still_open" as const : "resolved" as const,
          condition_results: input.packet.verification.success_conditions.map((condition) => ({
            success_condition_id: condition.id,
            status: stillOpen ? "unsatisfied" as const : "satisfied" as const,
            evidence_refs: [input.verificationEvidence.evidence_path!],
            remaining_problem: stillOpen ? "One bounded correction remains" : null,
          })),
          required_next_fix: stillOpen ? "Apply the second bounded correction" : null,
          blocker: null,
        };
        const reviewPath = `reviews/fix-packets/${Buffer.from(input.packet.provenance.packet_id).toString("base64url")}/attempts/${input.actionAttempt}/focused-resolution.json`;
        await writeTextArtifact(input.runDir, reviewPath, `${JSON.stringify(reviewValue)}\n`);
        return { review: reviewValue, reviewPath, invocation: {} as never };
      },
      afterCheckpoint: async (checkpoint) => {
        if (checkpoint === "after_packet_supplement_write" && crashAfterSupplementWrite) {
          crashAfterSupplementWrite = false;
          throw new Error("crash after immutable packet supplement write");
        }
        if (checkpoint === "after_action_mutation" && packetAttempts.length === 2) {
          throw new Error("stop after authoritative packet retry");
        }
      },
    };

    const workflowInput: RunLocalWorkflowInput = {
      runDir: setupResult.runDir,
      worktreePath: join(setupResult.root, "worktree"),
      intake: { ...intake, repo_root: setupResult.root },
      plan: boundedPlan,
      codex: {} as never,
      config,
      dependencies,
      deferTerminalDisposition: true,
    };

    const interrupted = await runLocalWorkflow(workflowInput);
    expect(interrupted.status).toBe("human_action_required");
    expect(interrupted.blocker).toContain("crash after immutable packet supplement write");
    const tornProgress = (await readManifestV2(setupResult.runDir)).work_item_progress.first!;
    expect(tornProgress.focused_review_path).toBeNull();
    expect(tornProgress.fix_packet_supplement_path).toBeNull();
    expect(packetAttempts).toEqual([1]);
    expect(packetVerifierAttempts).toEqual([1]);

    const result = await runLocalWorkflow(workflowInput);
    expect(result.status).toBe("human_action_required");
    expect(result.blocker).toContain("stop after authoritative packet retry");
    expect(packetAttempts).toEqual([1, 2]);
    expect(packetVerifierAttempts).toEqual([1]);
    expect(supplementPointers[0]).toBeNull();
    expect(supplementPointers[1]).toMatch(/attempts\/2\/attempt-supplement\.json$/);
  });

  it("executes only policy-authorized blocking packet findings and preserves excluded advisory findings", async () => {
    const workItem = item("first");
    const boundedPlan = { ...plan, work_items: [workItem] };
    const config = qualityConfig(0);
    const setupResult = await setupBounded(boundedPlan, true, config.retry_policy.quality_gate); root = setupResult.root;
    const harness = boundedDependencies();
    const baseVerifier = harness.dependencies.verifier!;
    let itemReviews = 0;
    const handsAttempts: number[] = [];
    const packetVerifierAttempts: number[] = [];
    const dependencies: LocalRuntimeDependencies = {
      ...harness.dependencies,
      verifier: async (input) => {
        if (input.final || itemReviews++ > 0) return baseVerifier(input);
        const evidencePath = verifierEvidenceRef(input);
        const value: VerifierReview = {
          ...review("request_changes", input.workItem.id, input.attempt, false),
          failure_class: "implementation_failure", blocker: null, blocker_code: null,
          acceptance_coverage: [], evidence_reviewed: [evidencePath],
          findings: [packetFinding(workItem, evidencePath), advisoryPacketFinding(workItem, evidencePath)],
        };
        return { review: value, reviewPath: await persistReview(input.runDir, `reviews/first/attempt-${input.attempt}.json`, value), invocation: {} as never };
      },
      handsFixPacket: async (input) => {
        handsAttempts.push(input.actionAttempt);
        await mkdir(join(input.worktreePath, "src"), { recursive: true });
        await writeFile(join(input.worktreePath, "src/first.ts"), "export const policyFixed = true;\n", "utf8");
        const result = {
          schema_version: 1 as const, packet_id: input.packet.provenance.packet_id,
          packet_sha256: hashReviewFixPacket(input.packet), action_attempt: input.actionAttempt,
          status: "implemented" as const,
          change_units: input.packet.remediation.change_units.map((unit) => ({ change_unit_id: unit.id, status: "completed" as const, changed_files: [unit.path], summary: "Applied authorized fix" })),
          changed_files: input.packet.completion_contract.expected_changed_files,
          commands_attempted: [], unresolved_requirements: [], blocker: null,
        };
        const reportPath = `reviews/fix-packets/${Buffer.from(input.packet.provenance.packet_id).toString("base64url")}/attempts/${input.actionAttempt}/hands-result.json`;
        await writeTextArtifact(input.runDir, reportPath, `${JSON.stringify(result)}\n`);
        const profile = input.profile ?? input.intake.roles.hands;
        return { result, reportPath, invocation: {} as never, profile: { kind: input.profileKind ?? "primary", model: profile.model, reasoning_effort: profile.reasoning_effort } };
      },
      packetVerifier: async (input) => {
        packetVerifierAttempts.push(input.actionAttempt);
        const reviewValue = {
          packet_id: input.packet.provenance.packet_id, packet_sha256: hashReviewFixPacket(input.packet),
          action_attempt: input.actionAttempt, decision: "resolved" as const,
          condition_results: input.packet.verification.success_conditions.map((condition) => ({
            success_condition_id: condition.id, status: "satisfied" as const,
            evidence_refs: [input.verificationEvidence.evidence_path!], remaining_problem: null,
          })),
          required_next_fix: null, blocker: null,
        };
        const reviewPath = `reviews/fix-packets/${Buffer.from(input.packet.provenance.packet_id).toString("base64url")}/attempts/${input.actionAttempt}/focused-resolution.json`;
        await writeTextArtifact(input.runDir, reviewPath, `${JSON.stringify(reviewValue)}\n`);
        return { review: reviewValue, reviewPath, invocation: {} as never };
      },
    };

    const result = await runLocalWorkflow({
      runDir: setupResult.runDir, worktreePath: join(setupResult.root, "worktree"),
      intake: { ...intake, repo_root: setupResult.root }, plan: boundedPlan,
      codex: {} as never, config, dependencies, deferTerminalDisposition: true,
    });

    expect(result.status, result.blocker).toBe("local_ready");
    expect(handsAttempts).toEqual([1]);
    expect(packetVerifierAttempts).toEqual([1]);
    const queue = JSON.parse(await readFile(join(setupResult.runDir, "action-queues/first/revision-1.json"), "utf8"));
    expect(queue.actions).toHaveLength(1);
    expect(queue.actions[0].severity).toBe("medium");
    const low = advisoryPacketFinding(workItem, result.verification.first!.evidence_path!);
    const completedManifest = await readManifestV2(setupResult.runDir);
    const approvedRevision = completedManifest.approved_revision ?? completedManifest.approved_plan_revision;
    const criterionRef = completedManifest.plan_revisions[String(approvedRevision)]!
      .acceptance_criteria![workItem.id]![0]!.ref;
    const lowId = fingerprintFinding({ work_item_id: workItem.id, criterion_ref: criterionRef, source: "verifier", normalized_location: low.file, problem_class: low.problem_class });
    const medium = packetFinding(workItem, result.verification.first!.evidence_path!);
    const mediumId = fingerprintFinding({ work_item_id: workItem.id, criterion_ref: criterionRef, source: "verifier", normalized_location: medium.file, problem_class: medium.problem_class });
    const records = await loadFindingRevisionRecords(setupResult.runDir, workItem.id, 1, [mediumId, lowId]);
    expect(records.find((record) => record.finding_id === lowId)).toMatchObject({
      finding_id: lowId, severity: "low", disposition: "advisory",
    });
  });

  it("keeps two bounded R1-A1 packet workflows in distinct scoped artifact roots", async () => {
    const workItems = [item("first"), item("second")];
    const boundedPlan = { ...plan, work_items: workItems };
    const config = qualityConfig(0);
    const setupResult = await setupBounded(boundedPlan, false, config.retry_policy.quality_gate); root = setupResult.root;
    const harness = boundedDependencies(undefined, true);
    const baseVerifier = harness.dependencies.verifier!;
    const reviews = new Map<string, number>();
    const packetIds: string[] = [];
    const codex: CodexAdapter = {
      invoke: async (input) => {
        if (!input.cwd) throw new Error("packet test invocation is missing its worktree");
        const packageStart = input.prompt.indexOf("{");
        const contextPackage = JSON.parse(input.prompt.slice(packageStart));
        const packet = contextPackage.fix_packet;
        packetIds.push(packet.provenance.packet_id);
        await mkdir(join(input.cwd, "src"), { recursive: true });
        await writeFile(join(input.cwd, packet.completion_contract.expected_changed_files[0]), `export const packetFixed = "${packet.provenance.work_item_id}";\n`, "utf8");
        const output = {
          schema_version: 1 as const,
          packet_id: packet.provenance.packet_id,
          packet_sha256: hashReviewFixPacket(packet),
          action_attempt: 1,
          status: "implemented" as const,
          change_units: packet.remediation.change_units.map((unit: { id: string; path: string }) => ({
            change_unit_id: unit.id, status: "completed" as const,
            changed_files: [unit.path], summary: "Applied isolated packet fix",
          })),
          changed_files: packet.completion_contract.expected_changed_files,
          commands_attempted: [], unresolved_requirements: [], blocker: null,
        };
        return { text: JSON.stringify(output), parsed: output, exitCode: 0, promptPath: "prompt", stdoutPath: "stdout", stderrPath: "stderr" , ...codexMetrics };
      },
    };
    const dependencies: LocalRuntimeDependencies = {
      ...harness.dependencies,
      verifier: async (input) => {
        if (input.final) return baseVerifier(input);
        const count = reviews.get(input.workItem.id) ?? 0;
        reviews.set(input.workItem.id, count + 1);
        if (count > 0) return baseVerifier(input);
        const evidencePath = verifierEvidenceRef(input);
        const value: VerifierReview = {
          ...review("request_changes", input.workItem.id, input.attempt, false),
          failure_class: "implementation_failure", blocker: null, blocker_code: null,
          acceptance_coverage: [], evidence_reviewed: [evidencePath],
          findings: [{
            ...packetFinding(input.workItem, evidencePath),
            action_id: "R1-A1", order: 1, depends_on: [],
          } as ReviewerAction],
        };
        return {
          review: value,
          reviewPath: await persistReview(input.runDir, `reviews/${input.workItem.id}/attempt-${input.attempt}.json`, value),
          invocation: {} as never,
        };
      },
      packetVerifier: async (input) => {
        const reviewValue = {
          packet_id: input.packet.provenance.packet_id,
          packet_sha256: hashReviewFixPacket(input.packet),
          action_attempt: input.actionAttempt,
          decision: "resolved" as const,
          condition_results: input.packet.verification.success_conditions.map((condition) => ({
            success_condition_id: condition.id, status: "satisfied" as const,
            evidence_refs: [input.verificationEvidence.evidence_path!], remaining_problem: null,
          })),
          required_next_fix: null, blocker: null,
        };
        const rootPath = `reviews/fix-packets/${Buffer.from(input.packet.provenance.packet_id).toString("base64url")}`;
        const reviewPath = `${rootPath}/attempts/${input.actionAttempt}/focused-resolution.json`;
        await writeTextArtifact(input.runDir, reviewPath, `${JSON.stringify(reviewValue)}\n`);
        return { review: reviewValue, reviewPath, invocation: {} as never };
      },
    };

    const result = await runLocalWorkflow({
      runDir: setupResult.runDir, worktreePath: join(setupResult.root, "worktree"),
      intake: { ...intake, repo_root: setupResult.root }, plan: boundedPlan,
      codex, config, dependencies, deferTerminalDisposition: true,
    });

    expect(result.status, result.blocker).toBe("local_ready");
    expect(packetIds).toHaveLength(2);
    expect(new Set(packetIds).size).toBe(2);
    const completedManifest = await readManifestV2(setupResult.runDir);
    for (const [index, packetId] of packetIds.entries()) {
      expect(packetId).toMatch(/^review-fix-packet:[a-f0-9]{64}$/);
      const rootPath = `reviews/fix-packets/${Buffer.from(packetId).toString("base64url")}`;
      for (const path of [
        `${rootPath}/packet.json`,
        `${rootPath}/attempts/1/hands-invocation-claim.json`,
        `${rootPath}/attempts/1/hands-result.json`,
        `${rootPath}/attempts/1/focused-resolution.json`,
      ]) await expect(readFile(join(setupResult.runDir, path), "utf8")).resolves.toBeTruthy();
      const progress = completedManifest.work_item_progress[workItems[index]!.id]!;
      expect(progress.fix_packet_path).toBe(`${rootPath}/packet.json`);
      expect(progress.fix_packet_result_path).toBe(`${rootPath}/attempts/1/hands-result.json`);
      const queue = JSON.parse(await readFile(join(setupResult.runDir, `action-queues/${workItems[index]!.id}/revision-1.json`), "utf8"));
      expect(queue.actions[0].action_id).toBe("R1-A1");
    }
  }, 30_000);

  it.each([
    "after_work_item_completion_commit",
    "after_work_item_summary_persisted",
  ] as const)("recovers bounded no-policy queue completion after %s without committing twice", async (checkpoint) => {
    const workItem = item("first");
    const boundedPlan = { ...plan, work_items: [workItem] };
    const setupResult = await setupBounded(boundedPlan, false, qualityConfig(0).retry_policy.quality_gate); root = setupResult.root;
    const worktreePath = join(setupResult.root, "worktree");
    const harness = boundedQueueDependencies(workItem, checkpoint);
    const workflowInput: RunLocalWorkflowInput = {
      runDir: setupResult.runDir, worktreePath,
      intake: { ...intake, repo_root: setupResult.root }, plan: boundedPlan,
      codex: {} as never, config: qualityConfig(0), dependencies: harness.dependencies,
      deferTerminalDisposition: true,
    };

    expect(gitCommitCount(worktreePath)).toBe(1);
    expect((await runLocalWorkflow(workflowInput)).status).toBe("human_action_required");
    const committedHead = gitHead(worktreePath);
    const interrupted = await readManifestV2(setupResult.runDir);
    expect(gitCommitCount(worktreePath)).toBe(2);
    expect(interrupted.work_item_progress.first).toMatchObject({
      status: "in_progress", commit_sha: committedHead, review_revision: 2,
    });
    expect(interrupted.work_item_progress.first?.implementation_path).toBe("implementation/first/attempt-1000101.json");
    expect(interrupted.work_item_progress.first?.verification_path).toBe(verificationEvidencePath(identity("first"), 2));
    expect(interrupted.work_item_progress.first?.review_path).toBe("reviews/first/attempt-2.json");

    const result = await runLocalWorkflow(workflowInput);
    expect(result.status, result.blocker).toBe("local_ready");
    expect(gitCommitCount(worktreePath)).toBe(2);
    expect(gitHead(worktreePath)).toBe(committedHead);
    expect(harness.handsCalls()).toBe(1);
    expect(harness.packetCalls()).toBe(1);
    const summary = JSON.parse(await readFile(join(setupResult.runDir, workItemSummaryPath("first", 1, 2)), "utf8"));
    expect(summary.commit_sha).toBe(committedHead);
  });

  it("recovers a work-item fix claimed before its ordered queue was persisted", async () => {
    const workItem = item("first");
    const boundedPlan = { ...plan, work_items: [workItem] };
    const config = qualityConfig(0);
    const setupResult = await setupBounded(boundedPlan, true, config.retry_policy.quality_gate); root = setupResult.root;
    const worktreePath = join(setupResult.root, "worktree");
    const harness = boundedQueueDependencies(workItem);
    let interruptAfterClaim = true;
    const workflowInput: RunLocalWorkflowInput = {
      runDir: setupResult.runDir, worktreePath,
      intake: { ...intake, repo_root: setupResult.root }, plan: boundedPlan,
      codex: {} as never, config,
      dependencies: {
        ...harness.dependencies,
        afterCheckpoint: async (checkpoint) => {
          if (checkpoint === "after_work_item_fix_effect_claim" && interruptAfterClaim) {
            interruptAfterClaim = false;
            throw new Error("crash after work-item fix effect claim");
          }
        },
      },
      deferTerminalDisposition: true,
    };

    const interrupted = await runLocalWorkflow(workflowInput);
    expect(interrupted.status).toBe("human_action_required");
    expect(interrupted.blocker).toContain("crash after work-item fix effect claim");
    const claimedProgress = (await readManifestV2(setupResult.runDir)).work_item_progress.first!;
    expect(claimedProgress.review_effect_id).toMatch(/^review-effect:/);
    expect(claimedProgress.queue_path).toBeUndefined();
    expect(harness.packetCalls()).toBe(0);

    const resumed = await runLocalWorkflow(workflowInput);
    expect(resumed.status, resumed.blocker).toBe("local_ready");
    expect(harness.handsCalls()).toBe(1);
    expect(harness.packetCalls()).toBe(1);
    expect((await readManifestV2(setupResult.runDir)).work_item_progress.first).not.toHaveProperty("blocker");
    expect((await readManifestV2(setupResult.runDir)).work_item_progress.first).not.toHaveProperty("blocker_code");
  });

  it("rejects a bounded no-policy queue commit whose returned SHA is not current HEAD", async () => {
    const workItem = item("first");
    const boundedPlan = { ...plan, work_items: [workItem] };
    const setupResult = await setupBounded(boundedPlan, false, qualityConfig(0).retry_policy.quality_gate); root = setupResult.root;
    const worktreePath = join(setupResult.root, "worktree");
    const harness = boundedQueueDependencies(workItem);
    const completionCheckpoints: string[] = [];
    const result = await runLocalWorkflow({
      runDir: setupResult.runDir, worktreePath,
      intake: { ...intake, repo_root: setupResult.root }, plan: boundedPlan,
      codex: {} as never, config: qualityConfig(0),
      dependencies: {
        ...harness.dependencies,
        commit: async () => "f".repeat(40),
        afterCheckpoint: async (checkpoint) => {
          if (checkpoint.startsWith("after_work_item_summary") || checkpoint === "after_work_item_completion_commit") {
            completionCheckpoints.push(checkpoint);
          }
        },
      },
      deferTerminalDisposition: true,
    });

    expect(result.status).toBe("human_action_required");
    expect(result.blocker).toMatch(/HEAD|commit provenance/i);
    expect(completionCheckpoints).toEqual([]);
    const progress = (await readManifestV2(setupResult.runDir)).work_item_progress.first;
    expect(progress?.status).toBe("in_progress");
    expect(progress).not.toHaveProperty("commit_sha");
    expect(progress).not.toHaveProperty("summary_path");
    await expect(readFile(join(setupResult.runDir, workItemSummaryPath("first", 1, 2)), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a bounded no-policy queue no-op when HEAD advanced after context capture", async () => {
    const workItem = item("first");
    const boundedPlan = { ...plan, work_items: [workItem] };
    const setupResult = await setupBounded(boundedPlan, false, qualityConfig(0).retry_policy.quality_gate); root = setupResult.root;
    const worktreePath = join(setupResult.root, "worktree");
    const harness = boundedQueueDependencies(workItem);
    const completionCheckpoints: string[] = [];
    let advanced = false;
    const result = await runLocalWorkflow({
      runDir: setupResult.runDir, worktreePath,
      intake: { ...intake, repo_root: setupResult.root }, plan: boundedPlan,
      codex: {} as never, config: qualityConfig(0),
      dependencies: {
        ...harness.dependencies,
        hasWorktreeChanges: async () => {
          if (!advanced) {
            execFileSync("git", ["add", "-A"], { cwd: worktreePath });
            execFileSync("git", ["commit", "-m", "unexpected queue branch advance"], { cwd: worktreePath });
            advanced = true;
          }
          return false;
        },
        afterCheckpoint: async (checkpoint) => {
          if (checkpoint.startsWith("after_work_item_summary") || checkpoint === "after_work_item_completion_commit") {
            completionCheckpoints.push(checkpoint);
          }
        },
      },
      deferTerminalDisposition: true,
    });

    expect(result.status).toBe("human_action_required");
    expect(result.blocker).toMatch(/HEAD|base commit|no-op/i);
    expect(completionCheckpoints).toEqual([]);
    const progress = (await readManifestV2(setupResult.runDir)).work_item_progress.first;
    expect(progress?.status).toBe("in_progress");
    expect(progress).not.toHaveProperty("commit_sha");
    expect(progress).not.toHaveProperty("summary_path");
    await expect(readFile(join(setupResult.runDir, workItemSummaryPath("first", 1, 2)), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    "after_work_item_completion_commit",
    "after_work_item_summary_persisted",
  ] as const)("reuses a durable direct commit after %s without committing twice", async (checkpoint) => {
    const boundedPlan = { ...plan, work_items: [item("first")] };
    const setupResult = await setupBounded(boundedPlan); root = setupResult.root;
    const worktreePath = join(setupResult.root, "worktree");
    const harness = boundedDependencies(checkpoint, true);
    const workflowInput: RunLocalWorkflowInput = {
      runDir: setupResult.runDir,
      worktreePath,
      intake: { ...intake, repo_root: setupResult.root },
      plan: boundedPlan,
      codex: {} as never,
      dependencies: harness.dependencies,
      deferTerminalDisposition: true,
    };

    expect(gitCommitCount(worktreePath)).toBe(1);
    expect((await runLocalWorkflow(workflowInput)).status).toBe("human_action_required");
    const committedHead = gitHead(worktreePath);
    expect(gitCommitCount(worktreePath)).toBe(2);
    expect((await readManifestV2(setupResult.runDir)).work_item_progress.first?.commit_sha).toBe(committedHead);
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: worktreePath, encoding: "utf8" })).toBe("");

    const result = await runLocalWorkflow(workflowInput);
    expect(result.status, result.blocker).toBe("local_ready");
    expect(gitCommitCount(worktreePath)).toBe(2);
    expect(gitHead(worktreePath)).toBe(committedHead);
    expect(harness.handsCalls()).toBe(1);
    const summary = JSON.parse(await readFile(join(setupResult.runDir, workItemSummaryPath("first", 1, 1)), "utf8"));
    expect(summary.commit_sha).toBe(committedHead);
  });

  it.each([
    { label: "real commit with tracked mutation", mutateWorktree: true, dirtyPath: "src/first.ts", staged: false },
    { label: "real commit with staged mutation", mutateWorktree: true, dirtyPath: "src/first.ts", staged: true },
    { label: "no-op marker with untracked approved file", mutateWorktree: false, dirtyPath: "tests/first.test.ts", staged: false },
  ])("rejects dirty direct completion recovery for $label", async ({ mutateWorktree, dirtyPath, staged }) => {
    const boundedPlan = { ...plan, work_items: [item("first")] };
    const setupResult = await setupBounded(boundedPlan); root = setupResult.root;
    const worktreePath = join(setupResult.root, "worktree");
    const harness = boundedDependencies("after_work_item_completion_commit", mutateWorktree);
    const workflowInput: RunLocalWorkflowInput = {
      runDir: setupResult.runDir, worktreePath,
      intake: { ...intake, repo_root: setupResult.root }, plan: boundedPlan,
      codex: {} as never, dependencies: harness.dependencies, deferTerminalDisposition: true,
    };

    expect((await runLocalWorkflow(workflowInput)).status).toBe("human_action_required");
    const interrupted = (await readManifestV2(setupResult.runDir)).work_item_progress.first;
    expect(interrupted, JSON.stringify(interrupted)).toMatchObject({
      commit_sha: mutateWorktree ? expect.stringMatching(/^[a-f0-9]{40,64}$/) : "no-op",
    });
    const commitsAfterCrash = gitCommitCount(worktreePath);
    const verifierCallsAfterCrash = harness.itemVerifierCalls();
    await mkdir(join(worktreePath, dirtyPath.split("/")[0]!), { recursive: true });
    await writeFile(join(worktreePath, dirtyPath), "dirty after approval\n", "utf8");
    if (staged) execFileSync("git", ["add", "--", dirtyPath], { cwd: worktreePath });

    const resumed = await runLocalWorkflow({
      ...workflowInput,
      dependencies: {
        ...harness.dependencies,
        hasWorktreeChanges: async () => false,
        gitSnapshot: cleanSnapshot,
      },
    });
    expect(resumed.status).toBe("human_action_required");
    expect(resumed.blocker).toMatch(/dirty|worktree changes/i);
    expect(gitCommitCount(worktreePath)).toBe(commitsAfterCrash);
    expect(harness.itemVerifierCalls()).toBe(verifierCallsAfterCrash);
    expect((await readManifestV2(setupResult.runDir)).work_item_progress.first?.status).not.toBe("complete");
    await expect(readFile(join(setupResult.runDir, workItemSummaryPath("first", 1, 1)), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    { label: "real commit with tracked mutation", mutateWorktree: true, dirtyPath: "src/first.ts" },
    { label: "real commit with untracked approved file", mutateWorktree: true, dirtyPath: "tests/first.test.ts" },
  ])("rejects dirty ordered-queue completion recovery for $label", async ({ mutateWorktree, dirtyPath }) => {
    const workItem = item("first");
    const boundedPlan = { ...plan, work_items: [workItem] };
    const config = qualityConfig(0);
    const setupResult = await setupBounded(boundedPlan, false, config.retry_policy.quality_gate); root = setupResult.root;
    const worktreePath = join(setupResult.root, "worktree");
    const harness = boundedQueueDependencies(workItem, "after_work_item_completion_commit", mutateWorktree);
    const workflowInput: RunLocalWorkflowInput = {
      runDir: setupResult.runDir, worktreePath,
      intake: { ...intake, repo_root: setupResult.root }, plan: boundedPlan,
      codex: {} as never, config, dependencies: harness.dependencies, deferTerminalDisposition: true,
    };

    expect((await runLocalWorkflow(workflowInput)).status).toBe("human_action_required");
    const interrupted = (await readManifestV2(setupResult.runDir)).work_item_progress.first;
    expect(interrupted, JSON.stringify(interrupted)).toMatchObject({
      commit_sha: expect.stringMatching(/^[a-f0-9]{40,64}$/),
    });
    const commitsAfterCrash = gitCommitCount(worktreePath);
    const verifierCallsAfterCrash = harness.verifierCalls();
    await mkdir(join(worktreePath, dirtyPath.split("/")[0]!), { recursive: true });
    await writeFile(join(worktreePath, dirtyPath), "dirty after queue approval\n", "utf8");

    const resumed = await runLocalWorkflow({
      ...workflowInput,
      dependencies: {
        ...harness.dependencies,
        hasWorktreeChanges: async () => false,
        gitSnapshot: cleanSnapshot,
      },
    });
    expect(resumed.status).toBe("human_action_required");
    expect(resumed.blocker).toMatch(/dirty|worktree changes/i);
    expect(gitCommitCount(worktreePath)).toBe(commitsAfterCrash);
    expect(harness.verifierCalls()).toBe(verifierCallsAfterCrash);
    expect((await readManifestV2(setupResult.runDir)).work_item_progress.first?.status).not.toBe("complete");
    await expect(readFile(join(setupResult.runDir, workItemSummaryPath("first", 1, 2)), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a fresh bounded direct commit whose returned SHA is not current HEAD", async () => {
    const boundedPlan = { ...plan, work_items: [item("first")] };
    const setupResult = await setupBounded(boundedPlan); root = setupResult.root;
    const worktreePath = join(setupResult.root, "worktree");
    const harness = boundedDependencies(undefined, true);
    const completionCheckpoints: string[] = [];
    const result = await runLocalWorkflow({
      runDir: setupResult.runDir,
      worktreePath,
      intake: { ...intake, repo_root: setupResult.root },
      plan: boundedPlan,
      codex: {} as never,
      dependencies: {
        ...harness.dependencies,
        commit: async () => "f".repeat(40),
        afterCheckpoint: async (checkpoint) => {
          if (checkpoint.startsWith("after_work_item_summary") || checkpoint === "after_work_item_completion_commit") {
            completionCheckpoints.push(checkpoint);
          }
        },
      },
      deferTerminalDisposition: true,
    });

    expect(result.status).toBe("human_action_required");
    expect(result.blocker).toMatch(/HEAD|commit provenance/i);
    expect(completionCheckpoints).toEqual([]);
    const progress = (await readManifestV2(setupResult.runDir)).work_item_progress.first;
    expect(progress?.status).toBe("in_progress");
    expect(progress).not.toHaveProperty("summary_path");
    await expect(readFile(join(setupResult.runDir, workItemSummaryPath("first", 1, 1)), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a fresh bounded direct no-op when HEAD advanced after context capture", async () => {
    const boundedPlan = { ...plan, work_items: [item("first")] };
    const setupResult = await setupBounded(boundedPlan); root = setupResult.root;
    const worktreePath = join(setupResult.root, "worktree");
    const harness = boundedDependencies();
    const completionCheckpoints: string[] = [];
    let advanced = false;
    const result = await runLocalWorkflow({
      runDir: setupResult.runDir,
      worktreePath,
      intake: { ...intake, repo_root: setupResult.root },
      plan: boundedPlan,
      codex: {} as never,
      dependencies: {
        ...harness.dependencies,
        hasWorktreeChanges: async () => {
          if (!advanced) {
            execFileSync("git", ["commit", "--allow-empty", "-m", "unexpected branch advance"], { cwd: worktreePath });
            advanced = true;
          }
          return false;
        },
        afterCheckpoint: async (checkpoint) => {
          if (checkpoint.startsWith("after_work_item_summary") || checkpoint === "after_work_item_completion_commit") {
            completionCheckpoints.push(checkpoint);
          }
        },
      },
      deferTerminalDisposition: true,
    });

    expect(result.status).toBe("human_action_required");
    expect(result.blocker).toMatch(/HEAD|base commit|no-op/i);
    expect(completionCheckpoints).toEqual([]);
    const progress = (await readManifestV2(setupResult.runDir)).work_item_progress.first;
    expect(progress?.status).toBe("in_progress");
    expect(progress).not.toHaveProperty("summary_path");
    await expect(readFile(join(setupResult.runDir, workItemSummaryPath("first", 1, 1)), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    "after_work_item_completion_commit",
    "after_work_item_summary_persisted",
  ] as const)("reuses a durable policy-authorized commit after %s without committing twice", async (checkpoint) => {
    const boundedPlan = { ...plan, work_items: [item("first")] };
    const setupResult = await setupBounded(boundedPlan, true); root = setupResult.root;
    const worktreePath = join(setupResult.root, "worktree");
    const harness = boundedDependencies(checkpoint, true);
    const workflowInput: RunLocalWorkflowInput = {
      runDir: setupResult.runDir,
      worktreePath,
      intake: { ...intake, repo_root: setupResult.root },
      plan: boundedPlan,
      codex: {} as never,
      dependencies: harness.dependencies,
      deferTerminalDisposition: true,
    };

    expect((await runLocalWorkflow(workflowInput)).status).toBe("human_action_required");
    const committedHead = gitHead(worktreePath);
    const interrupted = await readManifestV2(setupResult.runDir);
    expect(gitCommitCount(worktreePath)).toBe(2);
    expect(interrupted.work_item_progress.first).toMatchObject({
      status: "in_progress",
      commit_sha: committedHead,
      policy_commit_pending: true,
    });

    const result = await runLocalWorkflow(workflowInput);
    expect(result.status, result.blocker).toBe("local_ready");
    expect(gitCommitCount(worktreePath)).toBe(2);
    expect(gitHead(worktreePath)).toBe(committedHead);
    expect(harness.handsCalls()).toBe(1);
    expect((await readManifestV2(setupResult.runDir)).work_item_progress.first?.policy_commit_pending).toBe(false);
    const summary = JSON.parse(await readFile(join(setupResult.runDir, workItemSummaryPath("first", 1, 1)), "utf8"));
    expect(summary.commit_sha).toBe(committedHead);
  });

  it("keeps the old bounded summary immutable when an approved revision reruns the item", async () => {
    const firstPlan = { ...plan, work_items: [item("first")] };
    const setupResult = await setupBounded(firstPlan); root = setupResult.root;
    const firstHarness = boundedDependencies("after_work_item_summary_pointer");
    const baseInput = {
      runDir: setupResult.runDir,
      worktreePath: join(setupResult.root, "worktree"),
      intake: { ...intake, repo_root: setupResult.root },
      plan: firstPlan,
      codex: {} as never,
      dependencies: firstHarness.dependencies,
      deferTerminalDisposition: true,
    } as RunLocalWorkflowInput;
    expect((await runLocalWorkflow(baseInput)).status).toBe("human_action_required");
    const oldPath = workItemSummaryPath("first", 1, 1);
    const oldBytes = await readFile(join(setupResult.runDir, oldPath), "utf8");

    const revisedItem = { ...item("first"), objective: "Deliver the approved revision without widening scope." };
    const revisedPlan = { ...firstPlan, work_items: [revisedItem] };
    const recorded = await recordPlan(setupResult.runDir, `${JSON.stringify(revisedPlan)}\n`);
    await approvePlanRevision(setupResult.runDir, recorded.revision, { actor: "test" });
    const current = await readManifestV2(setupResult.runDir);
    const resetProgress = { ...current.work_item_progress.first! };
    for (const key of ["implementation_path", "verification_path", "review_path", "review_revision"] as const) {
      delete resetProgress[key];
    }
    await updateManifestV2(setupResult.runDir, {
      stage: "worktree_setup",
      delivery_state: "pending",
      current_work_item_id: null,
      work_item_progress: {
        ...current.work_item_progress,
        first: { ...resetProgress, status: "pending", attempts: 2 },
      },
    });
    const secondHarness = boundedDependencies("after_work_item_summary_pointer");
    const secondResult = await runLocalWorkflow({ ...baseInput, plan: revisedPlan, dependencies: secondHarness.dependencies });
    expect(secondResult.status, secondResult.blocker).toBe("human_action_required");
    expect(secondResult.blocker).toContain("after_work_item_summary_pointer");
    const second = await readManifestV2(setupResult.runDir);
    const newPath = workItemSummaryPath("first", 2, 2);
    expect(second.work_item_progress.first).toMatchObject({
      status: "complete",
      context_plan_revision: 2,
      summary_path: newPath,
    });
    expect(await readFile(join(setupResult.runDir, oldPath), "utf8")).toBe(oldBytes);
    expect(await readFile(join(setupResult.runDir, newPath), "utf8")).toContain('"plan_revision": 2');
  });

  it("keeps an untouched completed sibling resumable on its historical plan revision", async () => {
    const firstPlan = { ...plan, work_items: [item("first"), item("second", ["first"])] };
    const setupResult = await setupBounded(firstPlan); root = setupResult.root;
    const firstHarness = boundedDependencies("after_work_item_summary_pointer");
    const baseInput: RunLocalWorkflowInput = {
      runDir: setupResult.runDir,
      worktreePath: join(setupResult.root, "worktree"),
      intake: { ...intake, repo_root: setupResult.root },
      plan: firstPlan,
      codex: {} as never,
      dependencies: firstHarness.dependencies,
      deferTerminalDisposition: true,
    };
    expect((await runLocalWorkflow(baseInput)).status).toBe("human_action_required");
    const oldPath = workItemSummaryPath("first", 1, 1);
    const oldBytes = await readFile(join(setupResult.runDir, oldPath), "utf8");

    const revisedSecond = { ...item("second", ["first"]), objective: "Deliver the second approved revision." };
    const revisedPlan = { ...firstPlan, work_items: [item("first"), revisedSecond] };
    const recorded = await recordPlan(setupResult.runDir, `${JSON.stringify(revisedPlan)}\n`);
    await approvePlanRevision(setupResult.runDir, recorded.revision, { actor: "test" });
    const current = await readManifestV2(setupResult.runDir);
    await updateManifestV2(setupResult.runDir, {
      stage: "worktree_setup",
      delivery_state: "pending",
      current_work_item_id: null,
      last_blocker: null,
      work_item_progress: current.work_item_progress,
    });

    const secondHarness = boundedDependencies("after_work_item_summary_pointer");
    const result = await runLocalWorkflow({ ...baseInput, plan: revisedPlan, dependencies: secondHarness.dependencies });
    expect(result.status, result.blocker).toBe("human_action_required");
    expect(result.blocker).toContain("after_work_item_summary_pointer");
    const resumed = await readManifestV2(setupResult.runDir);
    expect(resumed.work_item_progress.first).toMatchObject({
      status: "complete",
      context_plan_revision: 1,
      summary_path: oldPath,
    });
    expect(resumed.work_item_progress.second).toMatchObject({
      status: "complete",
      context_plan_revision: 2,
      summary_path: workItemSummaryPath("second", 2, 1),
    });
    expect(await readFile(join(setupResult.runDir, oldPath), "utf8")).toBe(oldBytes);
    expect(firstHarness.handsCalls()).toBe(1);
    expect(secondHarness.handsCalls()).toBe(1);
  });

  it("recovers a bounded policy advance by adopting its validated summary", async () => {
    const boundedPlan = { ...plan, work_items: [item("first")] };
    const setupResult = await setupBounded(boundedPlan, true); root = setupResult.root;
    const harness = boundedDependencies("after_work_item_summary_persisted");
    const workflowInput: RunLocalWorkflowInput = {
      runDir: setupResult.runDir,
      worktreePath: join(setupResult.root, "worktree"),
      intake: { ...intake, repo_root: setupResult.root },
      plan: boundedPlan,
      codex: {} as never,
      dependencies: harness.dependencies,
      deferTerminalDisposition: true,
    };

    expect((await runLocalWorkflow(workflowInput)).status).toBe("human_action_required");
    const summaryPath = workItemSummaryPath("first", 1, 1);
    const interrupted = await readManifestV2(setupResult.runDir);
    expect(interrupted.work_item_progress.first).toMatchObject({
      status: "in_progress",
      review_cycle_path: expect.any(String),
      review_effect_id: expect.any(String),
    });
    expect(interrupted.work_item_progress.first).not.toHaveProperty("summary_path");
    expect(await readFile(join(setupResult.runDir, summaryPath), "utf8")).toContain('"completion_basis": "policy_advance"');

    const result = await runLocalWorkflow(workflowInput);
    expect(result.status, result.blocker).toBe("local_ready");
    expect((await readManifestV2(setupResult.runDir)).work_item_progress.first).toMatchObject({
      status: "complete",
      summary_path: summaryPath,
    });
    expect(harness.handsCalls()).toBe(1);
  });

  it("reinvokes Verifier after a persisted bounded review violates the finding contract", async () => {
    const workItem = item("first");
    const boundedPlan = { ...plan, work_items: [workItem] };
    const setupResult = await setupBounded(boundedPlan, true); root = setupResult.root;
    const harness = boundedDependencies();
    const baseVerifier = harness.dependencies.verifier!;
    let verifierCalls = 0;
    const dependencies: LocalRuntimeDependencies = {
      ...harness.dependencies,
      verifier: async (input) => {
        verifierCalls += 1;
        if (verifierCalls > 1) {
          const result = await baseVerifier(input);
          if (input.final) return result;
          const resumedPath = `reviews/${input.workItem.id}/attempt-${input.attempt}-resume-2.json`;
          return { ...result, reviewPath: await persistReview(input.runDir, resumedPath, result.review) };
        }
        const evidencePath = verifierEvidenceRef(input);
        const invalid = {
          ...packetReview(input.workItem.id, input.attempt),
          evidence_reviewed: [evidencePath],
          findings: [{
            ...packetFinding(input.workItem, evidencePath),
            acceptance_criterion: `${input.workItem.acceptance[0]!.id}; unknown-id`,
          }],
        };
        return {
          review: invalid,
          reviewPath: await persistReview(input.runDir, `reviews/${input.workItem.id}/attempt-${input.attempt}.json`, invalid),
          invocation: {} as never,
        };
      },
    };
    const workflowInput: RunLocalWorkflowInput = {
      runDir: setupResult.runDir,
      worktreePath: setupResult.worktree,
      intake: { ...intake, repo_root: setupResult.root },
      plan: boundedPlan,
      codex: {} as never,
      dependencies,
      deferTerminalDisposition: true,
    };

    const blocked = await runLocalWorkflow(workflowInput);
    expect(blocked.status).toBe("human_action_required");
    expect(blocked.blocker).toContain("invalid_verifier_contract");

    const resumed = await runLocalWorkflow(workflowInput);
    expect(resumed.status, resumed.blocker).toBe("local_ready");
    expect(verifierCalls).toBeGreaterThanOrEqual(2);
    expect((await readManifestV2(setupResult.runDir)).work_item_progress.first?.review_path)
      .toContain("resume-2.json");
  });

  it("reinvokes Verifier at a new attempt after an operational review blocker is restored", async () => {
    const workItem = item("first");
    const boundedPlan = { ...plan, work_items: [workItem] };
    const setupResult = await setupBounded(boundedPlan, true); root = setupResult.root;
    const harness = boundedDependencies();
    const baseVerifier = harness.dependencies.verifier!;
    let verifierCalls = 0;
    const dependencies: LocalRuntimeDependencies = {
      ...harness.dependencies,
      verifier: async (input) => {
        verifierCalls += 1;
        if (verifierCalls > 1) return baseVerifier(input);
        const evidencePath = verifierEvidenceRef(input);
        const blockedReview: VerifierReview = {
          ...review("blocked", input.workItem.id, input.attempt, false),
          failure_class: "operational_blocker",
          blocker: "Temporary package integrity inspection failure",
          blocker_code: "corrupt_state",
          findings: [],
          acceptance_coverage: [],
          evidence_reviewed: [evidencePath],
        };
        return {
          review: blockedReview,
          reviewPath: await persistReview(input.runDir, `reviews/${input.workItem.id}/attempt-${input.attempt}.json`, blockedReview),
          invocation: {} as never,
        };
      },
    };
    const workflowInput: RunLocalWorkflowInput = {
      runDir: setupResult.runDir,
      worktreePath: setupResult.worktree,
      intake: { ...intake, repo_root: setupResult.root },
      plan: boundedPlan,
      codex: {} as never,
      dependencies,
      deferTerminalDisposition: true,
    };

    const blocked = await runLocalWorkflow(workflowInput);
    expect(blocked.status).toBe("human_action_required");
    expect(blocked.blocker).toContain("Temporary package integrity inspection failure");

    const resumed = await runLocalWorkflow(workflowInput);
    expect(resumed.status, resumed.blocker).toBe("local_ready");
    expect(verifierCalls).toBeGreaterThanOrEqual(2);
    expect((await readManifestV2(setupResult.runDir)).work_item_progress.first?.review_path)
      .toContain("attempt-2.json");
  });

  it("fails closed before skipping a bounded-complete item whose summary no longer validates", async () => {
    const boundedPlan = { ...plan, work_items: [item("first")] };
    const setupResult = await setupBounded(boundedPlan); root = setupResult.root;
    const harness = boundedDependencies("after_work_item_summary_pointer");
    const workflowInput: RunLocalWorkflowInput = {
      runDir: setupResult.runDir,
      worktreePath: join(setupResult.root, "worktree"),
      intake: { ...intake, repo_root: setupResult.root },
      plan: boundedPlan,
      codex: {} as never,
      dependencies: harness.dependencies,
      deferTerminalDisposition: true,
    };
    expect((await runLocalWorkflow(workflowInput)).status).toBe("human_action_required");
    const summaryPath = workItemSummaryPath("first", 1, 1);
    await writeFile(join(setupResult.runDir, summaryPath), "{}\n", "utf8");

    const result = await runLocalWorkflow(workflowInput);
    expect(result.status).toBe("human_action_required");
    expect(result.blocker).toMatch(/summary|SHA-256|invalid/i);
    expect(harness.handsCalls()).toBe(1);
  });

  it("rejects direct execution of a non-delivered terminal run before any role call", async () => {
    const setupResult = await setup(); root = setupResult.root;
    await recordTerminalDisposition(setupResult.runDir, {
      outcome: "abandoned",
      actor: "human",
      reason: "The request was withdrawn",
      residual_risks: [],
    });
    let externalCalls = 0;

    await expect(runLocalWorkflow({
      runDir: setupResult.runDir,
      worktreePath: setupResult.worktree,
      intake: { ...intake, repo_root: setupResult.root },
      plan: { ...plan, work_items: [item("first")] },
      codex: {} as never,
      dependencies: {
        hands: async () => { externalCalls += 1; throw new Error("must not run"); },
        verifier: async () => { externalCalls += 1; throw new Error("must not run"); },
        verification: async () => { externalCalls += 1; throw new Error("must not run"); },
        gitSnapshot: cleanSnapshot,
      },
    })).rejects.toThrow("terminal outcome abandoned");
    expect(externalCalls).toBe(0);
  });

  it("fails closed before local role calls when the current plan is not explicitly approved", async () => {
    const setupResult = await setup(undefined, undefined, true); root = setupResult.root;
    await rm(join(setupResult.runDir, "run-configuration.json"), { force: true });
    const unapprovedPlan = { ...plan, work_items: [item("first")] };
    await recordPlan(setupResult.runDir, `${JSON.stringify(unapprovedPlan)}\n`);
    let externalCalls = 0;

    const result = await runLocalWorkflow({
      runDir: setupResult.runDir,
      worktreePath: setupResult.worktree,
      intake: { ...intake, repo_root: setupResult.root },
      plan: unapprovedPlan,
      codex: {} as never,
      dependencies: {
        hands: async () => { externalCalls += 1; throw new Error("must not run"); },
        verifier: async () => { externalCalls += 1; throw new Error("must not run"); },
        verification: async () => { externalCalls += 1; throw new Error("must not run"); },
        gitSnapshot: cleanSnapshot,
      },
    });

    expect(result.status).toBe("human_action_required");
    expect(result.blocker).toMatch(/explicit approval|protocol marker/i);
    expect(externalCalls).toBe(0);
  });

  it("rejects a Hands report that names a file outside the approved completion contract", () => {
    const workItem = item("first");

    expect(() => assertImplementationScope(
      workItem,
      { ...implementation("first"), changed_files: ["src/unapproved.ts"] },
      ["src/first.ts"],
    )).toThrowError(/Hands reported out-of-scope files: src\/unapproved\.ts/);
  });

  it("rejects an actual worktree change outside the approved completion contract", () => {
    const workItem = item("first");

    expect(() => assertImplementationScope(
      workItem,
      implementation("first"),
      ["src/first.ts", "src/unapproved.ts"],
    )).toThrowError(/Worktree contains out-of-scope files: src\/unapproved\.ts/);
  });

  it("accepts a canonical run-relative Hands report path in the current run ledger", async () => {
    const setupResult = await setup(); root = setupResult.root;
    const create = vi.spyOn(ledgerModule, "createRunLedgerV2");
    const reportPath = "implementation/first/attempt-1.json";
    const result = await runLocalWorkflow({
      runDir: setupResult.runDir,
      worktreePath: setupResult.worktree,
      intake: { ...intake, repo_root: setupResult.root },
      plan: { ...plan, work_items: [item("first")] },
      codex: {} as never,
      dependencies: {
        hands: async (input) => ({ implementation: implementation(input.workItem.id), reportPath, invocation: {} as never }),
        verification: async (input) => {
          const value = evidenceForInput(input);
          await persistEvidenceBundle(input.runDir, value);
          return value;
        },
        verifier: async (input) => {
          const value = review("approve", input.workItem.id, input.attempt, input.final);
          const path = input.final ? "reviews/integrated/final-attempt-1.json" : "reviews/first/attempt-1.json";
          return { review: value, reviewPath: await persistReview(input.runDir, path, value), invocation: {} as never };
        },
        commit: async () => "sha",
        gitSnapshot: cleanSnapshot,
      },
    });

    expect(result.status).toBe("local_ready");
    expect((await readManifestV2(setupResult.runDir)).work_item_progress.first?.implementation_path)
      .toBe(reportPath);
    expect(create).not.toHaveBeenCalled();
  });

  it.each([
    ["empty", "empty"],
    ["current-run absolute", "inside"],
    ["outside absolute", "outside"],
    ["partial run-root prefix", "partial"],
    ["traversal", "traversal"],
    ["backslashes", "backslashes"],
    ["duplicate separators", "duplicate"],
    ["dot segments", "dot"],
    ["run root", "root"],
  ] as const)("rejects unsafe Hands report path: %s", async (_label, kind) => {
    const setupResult = await setup(); root = setupResult.root;
    const unsafePath = kind === "empty"
      ? ""
      : kind === "inside"
        ? join(setupResult.runDir, "implementation/first/attempt-1.json")
        : kind === "outside"
        ? join(setupResult.root, "outside.json")
        : kind === "partial"
          ? `${setupResult.runDir}-sibling/report.json`
          : kind === "traversal"
            ? "../outside/report.json"
            : kind === "backslashes"
              ? "implementation\\first.json"
              : kind === "duplicate"
                ? "implementation//first.json"
                : kind === "dot"
                  ? "implementation/./first.json"
                  : ".";
    const result = await runLocalWorkflow({
      runDir: setupResult.runDir,
      worktreePath: setupResult.worktree,
      intake: { ...intake, repo_root: setupResult.root },
      plan: { ...plan, work_items: [item("first")] },
      codex: {} as never,
      dependencies: {
        hands: async () => ({ implementation: implementation("first"), reportPath: unsafePath, invocation: {} as never }),
        gitSnapshot: cleanSnapshot,
      },
    });
    expect(result.status).toBe("human_action_required");
    expect(result.blocker).toMatch(/path|artifact|Hands/i);
    const progress = (await readManifestV2(setupResult.runDir)).work_item_progress.first;
    expect(progress?.implementation_path).toBeUndefined();
  });

  it("blocks before verification when the worktree contains an unapproved file", async () => {
    const setupResult = await setup(); root = setupResult.root;
    let verifierCalls = 0;
    const deps = {
      hands: async (input: { workItem: WorkItem }) => ({
        implementation: implementation(input.workItem.id),
        reportPath: "implementation/first.json",
        invocation: {} as never,
      }),
      verification: async (input: RunVerificationInput) => evidenceForInput(input),
      verifier: async () => {
        verifierCalls += 1;
        throw new Error("Verifier must not run for an out-of-scope worktree");
      },
      changedFiles: async () => ["src/unapproved.ts"],
      gitSnapshot: cleanSnapshot,
    } as unknown as LocalRuntimeDependencies;

    const result = await runLocalWorkflow({
      runDir: setupResult.runDir,
      worktreePath: setupResult.worktree,
      intake: { ...intake, repo_root: setupResult.root },
      plan: { ...plan, work_items: [item("first")] },
      codex: {} as never,
      dependencies: deps,
    });

    expect(result.status).toBe("human_action_required");
    expect(result.blocker).toContain("Worktree contains out-of-scope files: src/unapproved.ts");
    expect(verifierCalls).toBe(0);
  });

  it("passes only argv arrays from canonical verification command objects", async () => {
    const setupResult = await setup(); root = setupResult.root;
    const spec = executionSpec("first") as unknown as WorkItem;
    let receivedCommands: readonly (readonly string[])[] | undefined;
    const deps: LocalRuntimeDependencies = {
      hands: async (input) => ({ implementation: implementation(input.workItem.id), reportPath: "implementation/first.json", invocation: {} as never }),
      verification: async (input) => {
        if (input.identity?.work_item_id === "first") {
          expect(input.commands.every((command) => Array.isArray(command))).toBe(true);
          receivedCommands = input.commands as readonly (readonly string[])[];
        }
        return evidenceForInput(input);
      },
      verifier: async (input) => {
        const value = review("approve", input.workItem.id, input.attempt, input.final);
        const path = input.final ? `reviews/integrated/final-attempt-${input.attempt}.json` : `reviews/first/attempt-${input.attempt}.json`;
        return { review: value, reviewPath: await persistReview(input.runDir, path, value), invocation: {} as never };
      },
      commit: async () => "sha",
      gitSnapshot: cleanSnapshot,
    };

    const result = await runLocalWorkflow({
      runDir: setupResult.runDir,
      worktreePath: setupResult.worktree,
      intake: { ...intake, repo_root: setupResult.root },
      plan: { ...plan, work_items: [spec] },
      codex: {} as never,
      dependencies: deps,
    });

    expect(result.status).toBe("local_ready");
    expect(receivedCommands).toEqual([["node", "node_modules/vitest/vitest.mjs", "run", "tests/first.test.ts"]]);
  });

  it.each(["implementing", "verifying", "verifier_review", "final_verification"] as const)("resumes an approved run persisted at %s", async (resumeStage) => {
    const setupResult = await setup(); root = setupResult.root;
    const workItem = item("first");
    const reportPath = "implementation/first/attempt-1.json";
    const evidencePath = verificationEvidencePath(identity("first"), 1);
    const report = { work_item_id: "first", changed_files: [], tests_added_or_changed: [], commands_attempted: [], completed_steps: ["resumed"], remaining_risks: [] };
    await writeTextArtifact(setupResult.runDir, reportPath, `${JSON.stringify(report)}\n`);
    await persistEvidenceBundle(setupResult.runDir, evidence("first"));
    if (resumeStage !== "implementing") await transitionRun(setupResult.runDir, "implementing", { actor: "test", payload: { work_item_id: "first" } });
    if (resumeStage === "verifying" || resumeStage === "verifier_review" || resumeStage === "final_verification") {
      await updateManifestV2(setupResult.runDir, {
        current_work_item_id: resumeStage === "final_verification" ? "integrated" : "first",
        work_item_progress: { first: { status: resumeStage === "final_verification" ? "complete" : "in_progress", attempts: 1, implementation_path: reportPath, verification_path: evidencePath } },
      });
      await transitionRun(setupResult.runDir, "verifying", { actor: "test", payload: { work_item_id: "first", pass: 1 } });
    }
    if (resumeStage === "verifier_review" || resumeStage === "final_verification") {
      await transitionRun(setupResult.runDir, "verifier_review", { actor: "test", payload: { work_item_id: "first", pass: 1 } });
    }
    if (resumeStage === "final_verification") {
      await transitionRun(setupResult.runDir, "final_verification", { actor: "runtime", payload: { work_item_id: "integrated", final: true, pass: 1 } });
    }
    let handsCalls = 0;
    let itemVerificationCalls = 0;
    const progress = await openProgressReporter({ runDir: setupResult.runDir });
    let progressWasPropagated = false;
    const deps: LocalRuntimeDependencies = {
  hands: async (input) => { handsCalls += 1; progressWasPropagated ||= input.progress === progress; return { implementation: implementation(input.workItem.id), reportPath, invocation: {} as never }; },
  verification: async (input) => { progressWasPropagated ||= input.progress === progress; if (input.identity?.work_item_id === "first") itemVerificationCalls += 1; return evidenceForInput(input); },
      verifier: async (input) => {
        progressWasPropagated ||= input.progress === progress;
        const value = review("approve", input.workItem.id, input.attempt, input.final);
        const path = input.final ? `reviews/integrated/final-attempt-${input.attempt}.json` : `reviews/first/attempt-${input.attempt}.json`;
        return { review: value, reviewPath: await persistReview(input.runDir, path, value), invocation: {} as never };
      },
      commit: async () => "no-op",
      gitSnapshot: cleanSnapshot,
    };
    const result = await runLocalWorkflow({ runDir: setupResult.runDir, worktreePath: setupResult.worktree, intake: { ...intake, repo_root: setupResult.root }, plan: { ...plan, work_items: [workItem] }, codex: {} as never, dependencies: deps, progress });
    expect(result.status).toBe("local_ready");
    expect((await readManifestV2(setupResult.runDir)).stage).toBe("delivery");
    if (resumeStage === "implementing") expect(handsCalls).toBe(1);
    else expect(handsCalls).toBe(0);
    if (resumeStage === "verifier_review") expect(itemVerificationCalls).toBe(0);
    const events = []; for await (const event of readProgressEvents(setupResult.runDir)) events.push(event);
    expect(events.map((event) => event.safe_label)).toContain("Run ready for local delivery");
    expect(events.at(-1)?.safe_label).toBe("Worker session completed");
  });

  it("resumes a fixing stage from the persisted fix report and prior review attempt", async () => {
    const setupResult = await setup(); root = setupResult.root;
    const workItem = item("first");
    const initialReportPath = "implementation/first/attempt-1.json";
    const fixReportPath = "implementation/first/attempt-2.json";
    const initialEvidencePath = verificationEvidencePath(identity("first"), 1);
    await writeTextArtifact(setupResult.runDir, initialReportPath, `${JSON.stringify({
      work_item_id: "first", changed_files: [], tests_added_or_changed: [], commands_attempted: [], completed_steps: ["initial"], remaining_risks: [],
    })}\n`);
    await writeTextArtifact(setupResult.runDir, fixReportPath, `${JSON.stringify({
      work_item_id: "first", changed_files: ["src/first.ts"], tests_added_or_changed: [], commands_attempted: [], completed_steps: ["fixed"], remaining_risks: [],
    })}\n`);
    await persistEvidenceBundle(setupResult.runDir, evidence("first"));
    const previousReview = review("request_changes", "first", 1, false);
    await persistReview(setupResult.runDir, "reviews/first/attempt-1.json", previousReview);
    await transitionRun(setupResult.runDir, "implementing", { actor: "test", payload: { work_item_id: "first" } });
    await transitionRun(setupResult.runDir, "verifying", { actor: "test", payload: { work_item_id: "first", pass: 1 } });
    await transitionRun(setupResult.runDir, "verifier_review", { actor: "test", payload: { work_item_id: "first", pass: 1 } });
    await transitionRun(setupResult.runDir, "fixing", { actor: "test", payload: { work_item_id: "first", pass: 1, findings: previousReview.findings } });
    await updateManifestV2(setupResult.runDir, {
      current_work_item_id: "first",
      work_item_progress: {
        first: {
          status: "in_progress",
          attempts: 2,
          implementation_path: fixReportPath,
          verification_path: initialEvidencePath,
        },
      },
    });

    let handsCalls = 0;
    let itemVerifierAttempt = 0;
    const deps: LocalRuntimeDependencies = {
      hands: async () => { handsCalls += 1; throw new Error("persisted fix should be reused"); },
      verification: async (input) => evidenceForInput(input),
      verifier: async (input) => {
        if (!input.final) itemVerifierAttempt = input.attempt ?? 1;
        const value = review("approve", input.workItem.id, input.attempt, input.final);
        const path = input.final ? `reviews/integrated/final-attempt-${input.attempt}.json` : `reviews/first/attempt-${input.attempt}.json`;
        return { review: value, reviewPath: await persistReview(input.runDir, path, value), invocation: {} as never };
      },
      commit: async () => "no-op",
      gitSnapshot: cleanSnapshot,
    };

    const result = await runLocalWorkflow({
      runDir: setupResult.runDir,
      worktreePath: setupResult.worktree,
      intake: { ...intake, repo_root: setupResult.root },
      plan: { ...plan, work_items: [workItem] },
      codex: {} as never,
      dependencies: deps,
    });

    expect(result.status).toBe("local_ready");
    expect(handsCalls).toBe(0);
    expect(itemVerifierAttempt).toBe(2);
  });

  it("persists a normal request-changes fix report so an interrupted fixing stage resumes without duplicate Hands", async () => {
    const setupResult = await setup(); root = setupResult.root;
    const workItem = item("first");
    const initialReportPath = "implementation/first/attempt-1.json";
    const fixReportPath = "implementation/first/attempt-2.json";
    const writeImplementation = async (path: string, changedFiles: string[]) => {
      await writeTextArtifact(setupResult.runDir, path, `${JSON.stringify({
        work_item_id: "first",
        changed_files: changedFiles,
        tests_added_or_changed: [],
        commands_attempted: [],
        completed_steps: [path],
        remaining_risks: [],
      })}\n`);
    };
    let handsCalls = 0;
    let interruptAfterFix = true;
    let itemVerifierAttempts: number[] = [];
    let resumedImplementationFiles: string[] = [];
    const firstRunDependencies: LocalRuntimeDependencies = {
      hands: async (input) => {
        handsCalls += 1;
        if (input.attempt === 1) {
          await writeImplementation(initialReportPath, ["src/initial.ts"]);
          return { implementation: implementation("first"), reportPath: initialReportPath, invocation: {} as never };
        }
        await writeImplementation(fixReportPath, ["src/first.ts"]);
        return { implementation: implementation("first"), reportPath: fixReportPath, invocation: {} as never };
      },
      verification: async (input) => {
        if (interruptAfterFix && input.identity?.work_item_id === "first" && input.attempt === 2) {
          throw new Error("simulated interruption after Hands fix persisted");
        }
        return evidenceForInput(input);
      },
      verifier: async (input) => {
        if (input.final) throw new Error("final review should wait for resume");
        itemVerifierAttempts.push(input.attempt ?? 0);
        const value = review("request_changes", "first", input.attempt, false);
        return { review: value, reviewPath: await persistReview(setupResult.runDir, "reviews/first/attempt-1.json", value), invocation: {} as never };
      },
      commit: async () => "no-op",
      gitSnapshot: cleanSnapshot,
    };

    const interrupted = await runLocalWorkflow({
      runDir: setupResult.runDir,
      worktreePath: setupResult.worktree,
      intake: { ...intake, repo_root: setupResult.root },
      plan: { ...plan, work_items: [workItem] },
      codex: {} as never,
      dependencies: firstRunDependencies,
    });
    expect(interrupted.status).toBe("human_action_required");
    const interruptedManifest = await readManifestV2(setupResult.runDir);
    expect(interruptedManifest.work_item_progress.first).toMatchObject({
      status: "in_progress",
      attempts: 2,
      implementation_path: fixReportPath,
    });

    // Model a process interruption after the successful fix persistence and
    // before the next verification transition is flushed.
    await updateManifestV2(setupResult.runDir, { stage: "fixing" });
    interruptAfterFix = false;
    const resumedDependencies: LocalRuntimeDependencies = {
      hands: async () => { throw new Error("persisted fix should be reused on resume"); },
      verification: async (input) => evidenceForInput(input),
      verifier: async (input) => {
        if (input.final) {
          const value = review("approve", "integrated", input.attempt, true);
          return { review: value, reviewPath: await persistReview(setupResult.runDir, "reviews/integrated/final-attempt-1.json", value), invocation: {} as never };
        }
        itemVerifierAttempts.push(input.attempt ?? 0);
        resumedImplementationFiles = [...(input.implementation?.changed_files ?? input.context?.changed_files ?? [])];
        const value = review("approve", "first", input.attempt, false);
        return { review: value, reviewPath: await persistReview(setupResult.runDir, "reviews/first/attempt-2.json", value), invocation: {} as never };
      },
      commit: async () => "no-op",
      gitSnapshot: cleanSnapshot,
    };
    const resumed = await runLocalWorkflow({
      runDir: setupResult.runDir,
      worktreePath: setupResult.worktree,
      intake: { ...intake, repo_root: setupResult.root },
      plan: { ...plan, work_items: [workItem] },
      codex: {} as never,
      dependencies: resumedDependencies,
    });

    expect(resumed.status, resumed.blocker).toBe("local_ready");
    expect(handsCalls).toBe(2);
    expect(itemVerifierAttempts).toEqual([1, 2]);
    expect(resumedImplementationFiles).toEqual(["src/first.ts"]);
    expect((await readManifestV2(setupResult.runDir)).work_item_progress.first).toMatchObject({
      status: "complete",
      attempts: 2,
      implementation_path: fixReportPath,
    });
  });

  it("uses the default verifier and records its relative review artifact path", async () => {
    const setupResult = await setup(); root = setupResult.root;
    const codex: CodexAdapter = {
      invoke: async (input) => {
        const final = input.artifactName.includes("integrated-final");
        const value: VerifierReview = {
          work_item_id: final ? "integrated" : "first",
          attempt: 1,
          final,
          decision: "approve",
          failure_class: "none",
          blocker: null,
          blocker_code: null,
          acceptance_coverage: [],
          evidence_reviewed: [],
          findings: [],
          residual_risks: [],
        };
        return {
          text: JSON.stringify(value),
          parsed: value,
          exitCode: 0,
          promptPath: join(input.runDir, "prompts", `${input.artifactName}.md`),
          stdoutPath: join(input.runDir, "responses", `${input.artifactName}.stdout.txt`),
          stderrPath: join(input.runDir, "responses", `${input.artifactName}.stderr.txt`),
          ...codexMetrics,
        };
      },
    };
    const deps: LocalRuntimeDependencies = {
      hands: async (input) => ({ implementation: implementation(input.workItem.id), reportPath: `implementation/${input.workItem.id}.json`, invocation: {} as never }),
      verification: async (input) => evidenceForInput(input),
      commit: async () => { throw new Error("clean worktree must not commit"); },
      gitSnapshot: cleanSnapshot,
    };

    const result = await runLocalWorkflow({
      runDir: setupResult.runDir,
      worktreePath: setupResult.worktree,
      intake: { ...intake, repo_root: setupResult.root },
      plan: { ...plan, work_items: [item("first")] },
      codex,
      dependencies: deps,
    });

    expect(result.status).toBe("local_ready");
    expect((await readManifestV2(setupResult.runDir)).delivery_state).toBe("ready");
    expect((await readManifestV2(setupResult.runDir)).final_artifact_paths).toContain("reviews/integrated/final-attempt-1.json");
  });

  it("topologically sequences items, freezes verification argv, and commits only after approval", async () => {
    const setupResult = await setup(); root = setupResult.root; const order: string[] = []; const commands: string[][][] = []; const commits: string[] = []; let final = false;
    const deps: LocalRuntimeDependencies = {
      hands: async (input) => { order.push(`hands:${input.workItem.id}`); return { implementation: implementation(input.workItem.id), reportPath: `implementation/${input.workItem.id}.json`, invocation: {} as never }; },
      verification: async (input) => { commands.push(input.commands.map((command) => [...command])); return evidenceForInput(input); },
      verifier: async (input) => { if (input.final) { final = true; const value = review("approve", input.workItem.id, input.attempt, true); return { review: value, reviewPath: await persistReview(input.runDir, "reviews/integrated/final-attempt-1.json", value), invocation: {} as never }; } order.push(`verifier:${input.workItem.id}`); const value = review("approve", input.workItem.id, input.attempt, false); return { review: value, reviewPath: await persistReview(input.runDir, "reviews/ok.json", value), invocation: {} as never }; },
      commit: async (input) => { const id = typeof input === "string" ? input : input.workItemId ?? ""; commits.push(id); order.push(`commit:${id}`); return `sha-${id}`; },
      gitSnapshot: cleanSnapshot,
    };
    const result = await runLocalWorkflow({ runDir: setupResult.runDir, worktreePath: setupResult.worktree, intake: { ...intake, repo_root: setupResult.root }, plan, codex: {} as never, dependencies: deps });
    expect(result.status).toBe("local_ready"); expect(order).toEqual(["hands:first", "verifier:first", "hands:second", "verifier:second"]); expect(commits).toEqual([]); expect(final).toBe(true); expect(commands[0]).toEqual(plan.work_items[1].verification_commands.map((command) => command.argv)); expect((await readManifestV2(setupResult.runDir)).delivery_state).toBe("ready");
  });

  it("stops after the third change request and transitions to replanning", async () => {
    const setupResult = await setup(); root = setupResult.root; let handsCalls = 0; let verifierCalls = 0;
    const deps: LocalRuntimeDependencies = {
      hands: async (input) => { handsCalls += 1; return { implementation: implementation(input.workItem.id), reportPath: "implementation/item.json", invocation: {} as never }; },
      verification: async (input) => evidenceForInput(input),
      verifier: async (input) => { verifierCalls += 1; const value = review("request_changes", input.workItem.id, input.attempt, input.final); return { review: value, reviewPath: await persistReview(input.runDir, "reviews/request.json", value), invocation: {} as never }; },
      commit: async () => { throw new Error("must not commit"); },
      gitSnapshot: cleanSnapshot,
    };
    const result = await runLocalWorkflow({ runDir: setupResult.runDir, worktreePath: setupResult.worktree, intake: { ...intake, repo_root: setupResult.root }, plan: { ...plan, work_items: [item("first")] }, codex: {} as never, dependencies: deps });
    expect(result.status).toBe("human_action_required"); expect(handsCalls).toBe(4); expect(verifierCalls).toBe(4); expect((await readManifestV2(setupResult.runDir)).stage).toBe("replanning");
  });

  it("passes stopOnFailure to the full verification after focused reviewer actions resolve", async () => {
    const setupResult = await setup(qualityConfig(0).retry_policy.quality_gate); root = setupResult.root;
    const verificationInputs: RunVerificationInput[] = [];
    let verifierCalls = 0;
    const deps: LocalRuntimeDependencies = {
      hands: async (input) => ({ implementation: implementation(input.workItem.id), reportPath: `implementation/${input.workItem.id}/attempt-${input.attempt}.json`, invocation: {} as never }),
      verification: async (input) => {
        verificationInputs.push(input);
        return evidenceForInput(input);
      },
      verifier: async (input) => {
        const decision = input.final || verifierCalls++ > 0 ? "approve" : "request_changes";
        const value = review(decision, input.workItem.id, input.attempt, input.final);
        return { review: value, reviewPath: await persistReview(input.runDir, input.final ? "reviews/integrated/final-attempt-1.json" : `reviews/${input.workItem.id}/attempt-${input.attempt}.json`, value), invocation: {} as never };
      },
      actionVerifier: async (input) => {
        const value: ActionResolutionReview = {
          review_revision: input.reviewRevision,
          action_id: input.action.action_id,
          action_attempt: input.actionAttempt,
          decision: "resolved",
          evidence_reviewed: [input.activeVerification.evidence_path!],
          remaining_problem: null,
          required_next_fix: null,
        };
        const reviewPath = actionResolutionReviewPath(input.workItem.id, input.reviewRevision, input.action.action_id, input.actionAttempt);
        await writeTextArtifact(input.runDir, reviewPath, `${JSON.stringify(value)}\n`);
        return { review: value, reviewPath, invocation: {} as never };
      },
      commit: async () => "no-op",
      gitSnapshot: cleanSnapshot,
    };

    const result = await runLocalWorkflow({
      runDir: setupResult.runDir,
      worktreePath: join(setupResult.root, "worktree"),
      intake: { ...intake, repo_root: setupResult.root },
      plan: { ...plan, work_items: [item("first")] },
      codex: {} as never,
      config: qualityConfig(0),
      dependencies: deps,
    });

    expect(result.status).toBe("local_ready");
    const postActionFullVerification = verificationInputs.find((input) =>
      input.identity?.scope === "local"
      && input.identity.work_item_id === "first"
      && input.attempt === 2
      && input.resumeExistingNamespace === true);
    expect(postActionFullVerification).toMatchObject({
      stopOnFailure: true,
      commands: plan.work_items[1].verification_commands.map((command) => command.argv),
    });
  });

  it("fails closed on verification failure before invoking Verifier or committing", async () => {
    const setupResult = await setup(); root = setupResult.root; let verifierCalls = 0; let commitCalls = 0;
    const verificationInputs: RunVerificationInput[] = [];
    const deps: LocalRuntimeDependencies = {
      hands: async (input) => ({ implementation: implementation(input.workItem.id), reportPath: "implementation/item.json", invocation: {} as never }),
      verification: async (input) => { verificationInputs.push(input); return failedEvidence(workItemId(input)); },
      verifier: async (input) => { verifierCalls += 1; const value = review("approve", input.workItem.id, input.attempt, input.final); return { review: value, reviewPath: await persistReview(input.runDir, "reviews/never.json", value), invocation: {} as never }; },
      commit: async () => { commitCalls += 1; return "never"; },
      gitSnapshot: cleanSnapshot,
    };
    const result = await runLocalWorkflow({ runDir: setupResult.runDir, worktreePath: setupResult.worktree, intake: { ...intake, repo_root: setupResult.root }, plan: { ...plan, work_items: [item("first")] }, codex: {} as never, dependencies: deps });
    expect(result.status).toBe("human_action_required"); expect(verifierCalls).toBe(0); expect(commitCalls).toBe(0); expect((await readManifestV2(setupResult.runDir)).stage).toBe("verifying");
    expect(verificationInputs.map((input) => input.identity?.work_item_id)).toEqual(["first"]);
    expect(verificationInputs.every((input) => input.stopOnFailure === true)).toBe(true);
  });

  it("runs a bounded final integrated fix loop and commits only after final approval", async () => {
    const setupResult = await setup(); root = setupResult.root; let finalReviews = 0; const handsIds: string[] = []; const commits: string[] = [];
    const deps: LocalRuntimeDependencies = {
  hands: async (input) => {
        handsIds.push(input.workItem.id);
        const result = input.workItem.id === "integrated"
          ? { ...implementation("integrated"), changed_files: ["src/first.ts"] }
          : implementation(input.workItem.id);
    return { implementation: result, reportPath: `implementation/${input.workItem.id}.json`, invocation: {} as never };
  },
  verification: async (input) => evidenceForInput(input),
      verifier: async (input) => {
        if (input.final) { finalReviews += 1; const value = review(finalReviews === 1 ? "request_changes" : "approve", input.workItem.id, input.attempt, true); return { review: value, reviewPath: await persistReview(input.runDir, `reviews/integrated/final-attempt-${finalReviews}.json`, value), invocation: {} as never }; }
        const value = review("approve", input.workItem.id, input.attempt, false); return { review: value, reviewPath: await persistReview(input.runDir, "reviews/item.json", value), invocation: {} as never };
      },
      commit: async (input) => { const id = typeof input === "string" ? input : input.workItemId ?? ""; commits.push(id); return `sha-${id}`; },
      gitSnapshot: cleanSnapshot,
    };
    const result = await runLocalWorkflow({ runDir: setupResult.runDir, worktreePath: join(setupResult.root, "worktree"), intake: { ...intake, repo_root: setupResult.root }, plan: { ...plan, work_items: [item("first")] }, codex: {} as never, dependencies: deps });
    expect(result.status).toBe("local_ready"); expect(finalReviews).toBe(2); expect(handsIds).toEqual(["first", "integrated"]); expect(commits).toEqual([]);
  });

  it("gates the first policy-enabled local work-item fix before invoking Hands", async () => {
    const setupResult = await setup(undefined, undefined, true); root = setupResult.root;
    const policyPlan = { ...plan, work_items: [item("first")] };
    const recorded = await recordPlan(setupResult.runDir, `${JSON.stringify(policyPlan)}\n`);
    await approvePlanRevision(setupResult.runDir, recorded.revision, { actor: "test" });
    let workItemReviews = 0;
    let handsCalls = 0;

    const result = await runLocalWorkflow({
      runDir: setupResult.runDir,
      worktreePath: join(setupResult.root, "worktree"),
      intake: { ...intake, repo_root: setupResult.root },
      plan: policyPlan,
      codex: {} as never,
      config: qualityConfig(0),
      dependencies: {
        hands: async (input) => {
          handsCalls += 1;
          const value = implementation(input.workItem.id);
          const reportPath = `implementation/${input.workItem.id}/attempt-${input.attempt}.json`;
          await writeTextArtifact(input.runDir, reportPath, `${JSON.stringify(value)}\n`);
          return { implementation: value, reportPath, invocation: {} as never };
        },
        verification: async (input) => {
          const value = evidenceForInput(input);
          await persistEvidenceBundle(input.runDir, value);
          return value;
        },
        verifier: async (input) => {
          const requested = !input.final && workItemReviews++ === 0;
          const value = {
            ...review(requested ? "request_changes" : "approve", input.workItem.id, input.attempt, input.final),
            failure_class: requested ? "implementation_failure" as const : "none" as const,
            blocker: null,
            blocker_code: null,
            evidence_reviewed: [verifierEvidenceRef(input)],
            findings: requested ? review("request_changes", input.workItem.id, input.attempt, input.final).findings.map((finding) => ({
              ...finding,
              acceptance_criterion: "first works",
              problem_class: "correctness" as const,
              evidence_refs: [verifierEvidenceRef(input)],
              re_verification: [["node", "node_modules/vitest/vitest.mjs", "run", "tests/first.test.ts"]],
            })) : [],
          };
          const path = input.final
            ? `reviews/integrated/final-attempt-${input.attempt}.json`
            : `reviews/${input.workItem.id}/attempt-${input.attempt}.json`;
          return { review: value, reviewPath: await persistReview(input.runDir, path, value), invocation: {} as never };
        },
        hasWorktreeChanges: async () => false,
        gitSnapshot: cleanSnapshot,
        afterCheckpoint: async (checkpoint) => {
          if (checkpoint === "after_work_item_effect") throw new Error("interrupt after guarded work-item effect");
        },
      },
    } as RunLocalWorkflowInput);

    expect(result.status).toBe("human_action_required");
    expect(result.blocker).toContain("interrupt after guarded work-item effect");
    expect(handsCalls).toBe(2);
    const manifest = await readManifestV2(setupResult.runDir);
    const scope = manifest.recovery.scopes["work-item:first"];
    expect(scope).toMatchObject({ disposition: "active", head_sequence: 1, consecutive_without_progress: 1 });
    const decisionRoot = join(
      setupResult.runDir,
      "recovery/scopes",
      recoveryScopePathComponent("work-item:first"),
      "decisions",
    );
    const files = await readdir(decisionRoot);
    expect(files).toHaveLength(1);
    const decision = recoveryDecisionArtifactV1Schema.parse(JSON.parse(
      await readFile(join(decisionRoot, files[0]!), "utf8"),
    ));
    const reviewCycleFiles = await readdir(join(setupResult.runDir, "reviews/decisions"));
    const cycle = (await Promise.all(reviewCycleFiles.map(async (name) =>
      reviewCycleStateSchema.parse(JSON.parse(await readFile(join(setupResult.runDir, "reviews/decisions", name), "utf8"))))))
      .find((candidate) => candidate.phase === "work_item")!;
    expect(decision.guard_action).toBe("allow_next_effect");
    expect(decision.requested_effect).toBe(cycle.decision.action);
    expect(decision.observation.effect_attempt_id).toBe(cycle.effect_id);
    expect(manifest.review_accounting?.fix_cycles_used).toBe(0);
  });

  it("executes one policy-selected work-item quality recovery with the backup profile", async () => {
    const setupResult = await setup(undefined, qualityBackup, true); root = setupResult.root;
    const policyPlan = { ...plan, work_items: [item("first")] };
    const recorded = await recordPlan(setupResult.runDir, `${JSON.stringify(policyPlan)}\n`);
    await approvePlanRevision(setupResult.runDir, recorded.revision, { actor: "test" });
    const manifestPath = join(setupResult.runDir, "manifest.json");
    const rawManifest = JSON.parse(await readFile(manifestPath, "utf8"));
    rawManifest.review_policy_snapshot.max_fix_cycles = 0;
    await writeFile(manifestPath, `${JSON.stringify(rawManifest, null, 2)}\n`, "utf8");
    let workItemReviews = 0;
    let handsCalls = 0;
    const handsProfiles: Array<string | undefined> = [];
    const workflowInput = {
      runDir: setupResult.runDir,
      worktreePath: join(setupResult.root, "worktree"),
      intake: { ...intake, repo_root: setupResult.root },
      plan: policyPlan,
      codex: {} as never,
      config: qualityConfig(0),
      dependencies: {
        hands: async (input) => {
          handsCalls += 1;
          handsProfiles.push(input.profile?.model);
          const value = input.workItem.id === "integrated"
            ? { ...implementation("integrated"), changed_files: ["src/first.ts"] }
            : implementation(input.workItem.id);
          const reportPath = `implementation/${input.workItem.id}/attempt-${input.attempt}.json`;
          await writeTextArtifact(input.runDir, reportPath, `${JSON.stringify({
            ...value,
            model: input.profile?.model ?? intake.roles.hands.model,
            reasoning_effort: input.profile?.reasoning_effort ?? intake.roles.hands.reasoning_effort,
            profile_kind: input.profileKind ?? "primary",
          })}\n`);
          return { implementation: value, reportPath, invocation: {} as never };
        },
        verification: async (input) => {
          const value = evidenceForInput(input);
          await persistEvidenceBundle(input.runDir, value);
          return value;
        },
        verifier: async (input) => {
          const requested = !input.final && workItemReviews++ === 0;
          const value = {
            ...review(requested ? "request_changes" : "approve", input.workItem.id, input.attempt, input.final),
            failure_class: requested ? "implementation_failure" as const : "none" as const,
            blocker: null,
            blocker_code: null,
            evidence_reviewed: [verifierEvidenceRef(input)],
            findings: requested ? review("request_changes", input.workItem.id, input.attempt, input.final).findings.map((finding) => ({
              ...finding,
              acceptance_criterion: "first works",
              problem_class: "correctness" as const,
              evidence_refs: [verifierEvidenceRef(input)],
              re_verification: [["node", "node_modules/vitest/vitest.mjs", "run", "tests/first.test.ts"]],
            })) : [],
          };
          const path = input.final
            ? `reviews/integrated/final-attempt-${input.attempt}.json`
            : `reviews/${input.workItem.id}/attempt-${input.attempt}.json`;
          return { review: value, reviewPath: await persistReview(input.runDir, path, value), invocation: {} as never };
        },
        hasWorktreeChanges: async () => false,
        gitSnapshot: cleanSnapshot,
        afterCheckpoint: async (checkpoint) => {
          if (checkpoint === "after_work_item_effect") throw new Error("interrupt after quality work-item effect");
        },
      },
    } as RunLocalWorkflowInput;

    const result = await runLocalWorkflow(workflowInput);
    const manifest = await readManifestV2(setupResult.runDir);
    const decisionFiles = await readdir(join(setupResult.runDir, "reviews/decisions"));
    const cycles = await Promise.all(decisionFiles.map(async (name) =>
      reviewCycleStateSchema.parse(JSON.parse(await readFile(join(setupResult.runDir, "reviews/decisions", name), "utf8")))));
    const cycle = cycles.find((candidate) => candidate.phase === "work_item");

    expect(result.status).toBe("human_action_required");
    expect(result.blocker).toContain("interrupt after quality work-item effect");
    expect(result.blocker).not.toContain("review policy stopped");
    expect(cycle?.decision.action).toBe("quality_recovery");
    expect(manifest.convergence_reports?.first).toBeUndefined();
    expect(manifest.active_hands_profile).toBe("primary");
    expect(handsCalls).toBe(2);
    expect(handsProfiles).toEqual([undefined, qualityBackup.profile.model]);
    expect(manifest.recovery.scopes["work-item:first"]).toMatchObject({
      disposition: "active",
      head_sequence: 1,
      consecutive_without_progress: 1,
    });
    const resumed = await runLocalWorkflow(workflowInput);
    expect(resumed.status, resumed.blocker).toBe("local_ready");
    expect(handsCalls).toBe(2);
    expect(handsProfiles).toEqual([undefined, qualityBackup.profile.model]);
  });

  it("executes one policy-selected final-integrated quality recovery with the backup profile", async () => {
    const setupResult = await setup(undefined, qualityBackup, true); root = setupResult.root;
    const policyPlan = { ...plan, work_items: [item("first")] };
    const recorded = await recordPlan(setupResult.runDir, `${JSON.stringify(policyPlan)}\n`);
    await approvePlanRevision(setupResult.runDir, recorded.revision, { actor: "test" });
    const manifestPath = join(setupResult.runDir, "manifest.json");
    const rawManifest = JSON.parse(await readFile(manifestPath, "utf8"));
    rawManifest.review_policy_snapshot.max_fix_cycles = 0;
    await writeFile(manifestPath, `${JSON.stringify(rawManifest, null, 2)}\n`, "utf8");
    let finalReviews = 0;
    let handsCalls = 0;
    const handsProfiles: Array<string | undefined> = [];
    const result = await runLocalWorkflow({
      runDir: setupResult.runDir,
      worktreePath: join(setupResult.root, "worktree"),
      intake: { ...intake, repo_root: setupResult.root },
      plan: policyPlan,
      codex: {} as never,
      config: qualityConfig(0),
      dependencies: {
        hands: async (input) => {
          handsCalls += 1;
          handsProfiles.push(input.profile?.model);
          const value = input.workItem.id === "integrated"
            ? { ...implementation("integrated"), changed_files: ["src/first.ts"] }
            : implementation(input.workItem.id);
          const reportPath = `implementation/${input.workItem.id}/attempt-${input.attempt}.json`;
          await writeTextArtifact(input.runDir, reportPath, `${JSON.stringify(value)}\n`);
          return { implementation: value, reportPath, invocation: {} as never };
        },
        verification: async (input) => {
          const value = evidenceForInput(input);
          await persistEvidenceBundle(input.runDir, value);
          return value;
        },
        verifier: async (input) => {
          const requested = Boolean(input.final) && finalReviews++ === 0;
          const value = {
            ...review(requested ? "request_changes" : "approve", input.workItem.id, input.attempt, input.final),
            failure_class: requested ? "implementation_failure" as const : "none" as const,
            blocker: null,
            blocker_code: null,
            evidence_reviewed: [verifierEvidenceRef(input)],
            findings: requested ? review("request_changes", input.workItem.id, input.attempt, input.final).findings.map((finding) => ({
              ...finding,
              acceptance_criterion: "first works",
              problem_class: "correctness" as const,
              evidence_refs: [verifierEvidenceRef(input)],
            })) : [],
          };
          const path = input.final
            ? `reviews/integrated/final-attempt-${input.attempt}.json`
            : `reviews/${input.workItem.id}/attempt-${input.attempt}.json`;
          return { review: value, reviewPath: await persistReview(input.runDir, path, value), invocation: {} as never };
        },
        hasWorktreeChanges: async () => false,
        gitSnapshot: cleanSnapshot,
        afterCheckpoint: async (checkpoint) => {
          if (checkpoint === "after_final_integrated_effect_complete") {
            throw new Error("interrupt after quality final-integrated effect");
          }
        },
      },
    } as RunLocalWorkflowInput);
    const manifest = await readManifestV2(setupResult.runDir);
    const decisionFiles = await readdir(join(setupResult.runDir, "reviews/decisions"));
    const cycles = await Promise.all(decisionFiles.map(async (name) =>
      reviewCycleStateSchema.parse(JSON.parse(await readFile(join(setupResult.runDir, "reviews/decisions", name), "utf8")))));
    const cycle = cycles.find((candidate) => candidate.phase === "final_integrated");

    expect(result.status).toBe("human_action_required");
    expect(result.blocker).toContain("interrupt after quality final-integrated effect");
    expect(result.blocker).not.toContain("Final integrated review policy stopped");
    expect(cycle?.decision.action).toBe("quality_recovery");
    expect(manifest.convergence_reports?.integrated?.review_revision).not.toBe(cycle?.review_revision);
    expect(manifest.active_hands_profile).toBe("primary");
    expect(handsCalls).toBe(2);
    expect(handsProfiles).toEqual([undefined, qualityBackup.profile.model]);
    expect(manifest.recovery.scopes["integrated:final"]).toMatchObject({
      disposition: "active",
      head_sequence: 1,
      consecutive_without_progress: 1,
    });
  });

  it("routes final-integrated fixes through the snapshotted review policy", async () => {
    const setupResult = await setup(undefined, undefined, true); root = setupResult.root;
    await enableBoundedProtocol(setupResult.runDir);
    await updateManifestV2(setupResult.runDir, { stage: "brain_discovery" });
    await writePinnedRunConfigurationFixture(setupResult.runDir, setupResult.worktree);
    const policyPlan = { ...plan, work_items: [item("first")] };
    const sourceCommit = gitHead(setupResult.worktree);
    const recorded = await recordAndApprovePinnedInitialPlan(setupResult.runDir, policyPlan, async () => ({
      provenance: { ...controllerProvenance, candidate_commit: sourceCommit },
      selfHosting: false,
    }));
    const pinnedWorktree = await materializePinnedWorktreeFixture(setupResult.runDir, setupResult.worktree);
    let finalReviews = 0;
    let handsCalls = 0;
    let interruptAfterEffect = true;
    const dependencies: LocalRuntimeDependencies = {
      hands: async (input) => {
        handsCalls += 1;
        const value = implementation(input.workItem.id);
        const reportPath = `implementation/${input.workItem.id}/attempt-${input.attempt}.json`;
        await writeTextArtifact(input.runDir, reportPath, `${JSON.stringify(value)}\n`);
        return { implementation: value, reportPath, invocation: {} as never };
      },
      verification: async (input) => {
        const value = evidenceForInput(input);
        await persistEvidenceBundle(input.runDir, value);
        return value;
      },
      verifier: async (input) => {
        const requested = input.final && finalReviews++ === 0;
        const value = {
          ...review(requested ? "request_changes" : "approve", input.workItem.id, input.attempt, input.final),
          failure_class: requested ? "implementation_failure" as const : "none" as const,
          blocker: null,
          blocker_code: null,
          evidence_reviewed: [verifierEvidenceRef(input)],
          findings: requested ? review("request_changes", input.workItem.id, input.attempt, input.final).findings.map((finding) => ({
            ...finding,
            acceptance_criterion: "first works",
            problem_class: "correctness" as const,
            evidence_refs: [verifierEvidenceRef(input)],
          })) : [],
        };
        const path = input.final
          ? `reviews/integrated/final-attempt-${input.attempt}.json`
          : `reviews/${input.workItem.id}/attempt-${input.attempt}.json`;
        return { review: value, reviewPath: await persistReview(input.runDir, path, value), invocation: {} as never };
      },
      hasWorktreeChanges: async () => false,
      gitSnapshot: cleanSnapshot,
      afterCheckpoint: async (checkpoint) => {
        if (interruptAfterEffect && checkpoint === "after_final_integrated_effect_complete") {
          interruptAfterEffect = false;
          throw new Error("interrupt after final phase effect completion");
        }
      },
    };
    const workflowInput = {
      runDir: setupResult.runDir,
      worktreePath: pinnedWorktree,
      intake: { ...intake, repo_root: setupResult.root },
      plan: policyPlan,
      codex: {} as never,
      config: qualityConfig(0),
      dependencies,
    } as RunLocalWorkflowInput;
    expect((await runLocalWorkflow(workflowInput)).status).toBe("human_action_required");
    const result = await runLocalWorkflow(workflowInput);
    expect(result.status).toBe("human_action_required");
    expect(result.blocker).toContain("ambiguous persisted in-progress claim");
    expect(handsCalls).toBe(2);
  });

  it("projects a multi-item final-integrated replan onto its highest-priority Verifier target", async () => {
    const setupResult = await setup(undefined, undefined, true); root = setupResult.root;
    await enableBoundedProtocol(setupResult.runDir);
    await updateManifestV2(setupResult.runDir, { stage: "brain_discovery" });
    await writePinnedRunConfigurationFixture(setupResult.runDir, setupResult.worktree);
    const policyPlan = { ...plan, work_items: [item("first"), item("second")] };
    const sourceCommit = gitHead(setupResult.worktree);
    const recorded = await recordAndApprovePinnedInitialPlan(setupResult.runDir, policyPlan, async () => ({
      provenance: { ...controllerProvenance, candidate_commit: sourceCommit },
      selfHosting: false,
    }));
    const pinnedWorktree = await materializePinnedWorktreeFixture(setupResult.runDir, setupResult.worktree);
    let brainCalls = 0;
    const interruptedReplanCheckpoints = [
      "after_replan_patch_write",
      "after_replan_effect_complete",
      "after_replan_pointer_write",
      "after_replan_plan_write",
      "after_replan_request_write",
      "after_replan_boundary_commit",
    ];
    let interruptAfterImplementing = false;
    let implementingSnapshot: RunManifestV2 | null = null;
    let phaseReplanPending = true;
    const handsAttempts: number[] = [];
    const workflowInput = {
      runDir: setupResult.runDir, worktreePath: pinnedWorktree,
      intake: { ...intake, repo_root: setupResult.root }, plan: policyPlan,
      codex: { invoke: async (invocation: Parameters<CodexAdapter["invoke"]>[0]) => {
        brainCalls += 1;
        const findingIds = [...new Set(invocation.prompt.match(/finding:[a-f0-9]{64}/g) ?? [])];
        const patch = { target_work_item_id: "first", base_plan_revision: recorded.revision, unresolved_finding_ids: findingIds, revised_objective: "first revised", added_or_changed_criteria: [{ ref: "BH-001:AC-1", text: "first works revised" }], changed_instructions: ["Fix the integrated findings."], added_change_units: [], added_verification_commands: [{ id: "replan-first-VERIFY-01", argv: ["node", "node_modules/vitest/vitest.mjs", "run", "tests/first-replan.test.ts"], expected_exit_code: 0, tier: "focused", satisfies: ["first-AC-01"] }], added_cross_cutting_impacts: [], added_read_only_file_contracts: [], explicitly_rejected_hardening: [] };
        return { text: JSON.stringify(patch), parsed: patch, exitCode: 0, promptPath: "prompt", stdoutPath: "stdout", stderrPath: "stderr", ...codexMetrics };
      } } as never,
      config: qualityConfig(0),
      dependencies: {
        hands: async (input) => { const attempt = input.attempt ?? 1; handsAttempts.push(attempt); const value = implementation(input.workItem.id); const reportPath = `implementation/${input.workItem.id}/attempt-${attempt}.json`; await writeTextArtifact(input.runDir, reportPath, `${JSON.stringify(value)}\n`); return { implementation: value, reportPath, invocation: {} as never }; },
        verification: async (input) => { const value = evidenceForInput(input); await persistEvidenceBundle(input.runDir, value); return value; },
        verifier: async (input) => {
          const replan = Boolean(input.final) && phaseReplanPending;
          const value = { ...review(replan ? "replan_required" : "approve", input.workItem.id, input.attempt, Boolean(input.final)), failure_class: replan ? "replan_required" as const : "none" as const, blocker: null, blocker_code: null, evidence_reviewed: [verifierEvidenceRef(input)], findings: replan ? [
            { severity: "high" as const, file: "src/first.ts", line: null, acceptance_criterion: "first works", problem_class: "correctness" as const, problem: "primary plan gap", required_fix: "revise first", evidence_refs: [verifierEvidenceRef(input)], re_verification: [] },
            { severity: "medium" as const, file: "src/second.ts", line: null, acceptance_criterion: "second works", problem_class: "correctness" as const, problem: "secondary plan gap", required_fix: "revise second through the selected replan", evidence_refs: [verifierEvidenceRef(input)], re_verification: [] },
          ] : [] };
          const path = input.final ? `reviews/integrated/final-attempt-${input.attempt}.json` : `reviews/${input.workItem.id}/attempt-${input.attempt}.json`;
          return { review: value, reviewPath: await persistReview(input.runDir, path, value), invocation: {} as never };
        },
        hasWorktreeChanges: async () => false, gitSnapshot: cleanSnapshot,
        afterCheckpoint: async (checkpoint) => {
          if (checkpoint === interruptedReplanCheckpoints[0]) {
            interruptedReplanCheckpoints.shift();
            throw new Error(`crash after ${checkpoint}`);
          }
          if (interruptAfterImplementing && checkpoint === "after_status_implementing_publication") {
            interruptAfterImplementing = false;
            implementingSnapshot = await readManifestV2(setupResult.runDir);
            throw new Error("hard stop after implementing checkpoint");
          }
        },
      },
    } as RunLocalWorkflowInput;
    for (let index = 0; index < 3; index += 1) {
      const checkpoint = interruptedReplanCheckpoints[0]!;
      const interrupted = await runLocalWorkflow(workflowInput);
      expect(interrupted.status).toBe("human_action_required");
      expect(interrupted.blocker).toBe(`Local runtime failed: crash after ${checkpoint}`);
    }
    const patchOnly = await readManifestV2(setupResult.runDir);
    expect(patchOnly.stage).toBe("verifier_review");
    expect(patchOnly.pending_plan_approval).toBeNull();
    expect(patchOnly.work_item_progress.integrated?.replan_patch_path).toContain("replans/");
    await transitionRun(setupResult.runDir, "replanning", {
      actor: "test",
      payload: { legacy_patch_only: true },
    });
    await transitionRun(setupResult.runDir, "awaiting_plan_approval", {
      actor: "test",
      payload: { legacy_patch_only: true },
    });
    for (let index = 0; index < 3; index += 1) {
      const checkpoint = interruptedReplanCheckpoints[0]!;
      const interrupted = await runLocalWorkflow(workflowInput);
      expect(interrupted.status).toBe("human_action_required");
      expect(interrupted.blocker).toBe(checkpoint === "after_replan_boundary_commit"
        ? "Review policy requires replanning first from final_integrated"
        : `Local runtime failed: crash after ${checkpoint}`);
    }
    const interruptedPrepared = await readManifestV2(setupResult.runDir);
    const interruptedPending = interruptedPrepared.pending_plan_approval!;
    const interruptedRequest = await readFile(join(setupResult.runDir, interruptedPending.request_path), "utf8");
    let bootstrapCalls = 0;
    const progressCodes: string[] = [];
    const forgedResult = await runLocalWorkflow({
      ...workflowInput,
      plan: {
        ...workflowInput.plan,
        controller_bootstrap: {
          version: 1,
          baseline_commit: (await readManifestV2(setupResult.runDir)).source_commit!,
          preserved_head: "c".repeat(40),
          source_worktree: ".brain-hands/worktrees/preserved-run",
          commit_message: "controller-bootstrap: preserve lifecycle",
          files: [{ path: "src/cli.ts", source_status: "tracked", sha256: "d".repeat(64) }],
        },
      },
      progress: {
        path: join(setupResult.runDir, "progress.jsonl"), sessionId: "prepared-approval-stop", workerPid: process.pid,
        emit: async (event) => { progressCodes.push(event.code); return null; },
      },
      dependencies: {
        ...workflowInput.dependencies,
        controllerBootstrap: async () => { bootstrapCalls += 1; return {} as never; },
      },
    });
    expect(forgedResult.status).toBe("human_action_required");
    expect(forgedResult.blocker).toMatch(/caller plan|approved recorded plan/i);
    expect(progressCodes).toEqual([]);
    const result = {
      status: "human_action_required" as const,
      manifest: interruptedPrepared,
      blocker: interruptedPrepared.last_blocker!,
    };
    expect(result.status).toBe("human_action_required");
    expect(result.manifest.stage, result.blocker).toBe("awaiting_plan_approval");
    expect(result.manifest.current_revision).toBe(1);
    expect(result.manifest.approved_revision).toBe(1);
    expect(result.manifest.pending_plan_approval?.proposed_revision).toBe(2);
    expect(result.manifest.pending_plan_approval).toEqual(interruptedPending);
    expect(await readFile(join(setupResult.runDir, interruptedPending.request_path), "utf8")).toBe(interruptedRequest);
    expect(await readFile(join(setupResult.runDir, "plans/revision-2.md"), "utf8"))
      .toContain('"schema_version": "2.0"');
    expect(result.manifest.work_item_progress.integrated?.replan_patch_path).toContain("replans/");
    expect(result.manifest.work_item_progress.integrated?.replan_target_work_item_id).toBe("first");
    expect(result.manifest.work_item_progress.first).toMatchObject({
      replan_source_work_item_id: "integrated",
      replan_patch_path: result.manifest.work_item_progress.integrated?.replan_patch_path,
    });
    expect(brainCalls).toBe(1);
    expect(bootstrapCalls).toBe(0);
    expect(progressCodes).toEqual([]);
    expect(result.blocker).toBe("Review policy requires replanning first from final_integrated");
    expect(result.manifest.last_blocker).toBe(result.blocker);
    expect(result.blocker).not.toContain("Local runtime failed");
    expect(await readOperatorStatus(setupResult.runDir)).toMatchObject({
      operator_state: "awaiting_plan_approval",
      blocker: result.blocker,
    });
    expect(interruptedReplanCheckpoints).toEqual([]);

    const beforeApproval = await readManifestV2(setupResult.runDir);
    const approved = await approvePreparedReplanRevision(setupResult.runDir, "first", 2, { approvalControllerCapture });
    const replayed = await approvePreparedReplanRevision(setupResult.runDir, "first", 2, { approvalControllerCapture });
    expect(replayed).toEqual(approved);
    expect(approved.stage).toBe("worktree_setup");
    expect(approved.delivery_state).toBe("pending");
    expect(approved.worktree_path).toBe(beforeApproval.worktree_path);
    expect(approved.branch_name).toBe(beforeApproval.branch_name);
    expect(approved.work_item_progress.first).toMatchObject({ plan_revision: 2, fix_cycles_used: 0 });
    expect(approved.work_item_progress.integrated?.approved_replan_history).toContainEqual(expect.objectContaining({
      review_cycle_path: beforeApproval.work_item_progress.integrated?.review_cycle_path,
      review_effect_id: beforeApproval.work_item_progress.integrated?.review_effect_id,
      target_work_item_id: "first",
    }));
    expect(approved.work_item_progress.integrated).not.toHaveProperty("review_cycle_path");
    expect(approved.work_item_progress.integrated).not.toHaveProperty("replan_patch_path");
    phaseReplanPending = false;
    interruptAfterImplementing = true;
    const revisedPlan = JSON.parse(await readFile(join(setupResult.runDir, approved.plan_revisions["2"]!.path), "utf8")) as BrainPlan;
    const interruptedResume = await runLocalWorkflow({ ...workflowInput, plan: revisedPlan });
    expect(interruptedResume.status).toBe("human_action_required");
    expect(implementingSnapshot).toMatchObject({
      stage: "implementing",
      delivery_state: "pending",
      work_item_progress: { first: { attempts: 2 } },
    });
    const resumed = await runLocalWorkflow({ ...workflowInput, plan: revisedPlan });
    expect(resumed.status).toBe("local_ready");
    expect(handsAttempts.filter((attempt) => attempt === 2)).toHaveLength(1);
    expect(resumed.manifest.worktree_path).toBe(beforeApproval.worktree_path);
    expect(resumed.manifest.branch_name).toBe(beforeApproval.branch_name);
  }, 120_000);

  it("resumes an interrupted integrated final fix from its persisted Hands report", async () => {
    const setupResult = await setup(); root = setupResult.root;
    const workItem = item("first");
    const initialReportPath = "implementation/first/attempt-1.json";
    const finalFixReportPath = "implementation/integrated/attempt-2.json";
    await writeTextArtifact(setupResult.runDir, initialReportPath, `${JSON.stringify(implementation("first"))}\n`);
    let finalReviews = 0;
    let verificationInterrupted = true;
    const handsIds: string[] = [];
    const firstRunDependencies: LocalRuntimeDependencies = {
      hands: async (input) => {
        handsIds.push(input.workItem.id);
        if (input.workItem.id === "integrated") {
          const result = { ...implementation("integrated"), changed_files: ["src/first.ts"] };
          await writeTextArtifact(setupResult.runDir, finalFixReportPath, `${JSON.stringify(result)}\n`);
          return { implementation: result, reportPath: finalFixReportPath, invocation: {} as never };
        }
        return { implementation: implementation(input.workItem.id), reportPath: initialReportPath, invocation: {} as never };
      },
      verification: async (input) => {
        if (verificationInterrupted && input.identity?.scope === "integrated" && input.attempt === 2) throw new Error("simulated interruption after integrated fix");
        return evidenceForInput(input);
      },
      verifier: async (input) => {
        if (input.final) {
          finalReviews += 1;
          const value = review(finalReviews === 1 ? "request_changes" : "approve", "integrated", input.attempt, true);
          return { review: value, reviewPath: await persistReview(setupResult.runDir, `reviews/integrated/final-attempt-${finalReviews}.json`, value), invocation: {} as never };
        }
        const value = review("approve", "first", input.attempt, false);
        return { review: value, reviewPath: await persistReview(setupResult.runDir, "reviews/first/attempt-1.json", value), invocation: {} as never };
      },
      commit: async () => "no-op",
      gitSnapshot: cleanSnapshot,
    };
    const interrupted = await runLocalWorkflow({
      runDir: setupResult.runDir,
      worktreePath: setupResult.worktree,
      intake: { ...intake, repo_root: setupResult.root },
      plan: { ...plan, work_items: [workItem] },
      codex: {} as never,
      dependencies: firstRunDependencies,
    });
    expect(interrupted.status).toBe("human_action_required");
    expect((await readManifestV2(setupResult.runDir)).work_item_progress.integrated).toMatchObject({
      status: "in_progress",
      attempts: 2,
      implementation_path: finalFixReportPath,
    });

    verificationInterrupted = false;
    const resumed = await runLocalWorkflow({
      runDir: setupResult.runDir,
      worktreePath: setupResult.worktree,
      intake: { ...intake, repo_root: setupResult.root },
      plan: { ...plan, work_items: [workItem] },
      codex: {} as never,
      dependencies: {
        hands: async () => { throw new Error("persisted integrated fix should be reused"); },
        verification: async (input) => evidenceForInput(input),
        verifier: async (input) => {
          const value = review("approve", input.workItem.id, input.attempt, input.final);
          const path = input.final ? "reviews/integrated/final-attempt-2.json" : "reviews/first/attempt-1.json";
          return { review: value, reviewPath: await persistReview(setupResult.runDir, path, value), invocation: {} as never };
        },
        commit: async () => "no-op",
        gitSnapshot: cleanSnapshot,
      },
    });
    expect(resumed.status).toBe("human_action_required");
    expect(handsIds).toEqual(["first", "integrated"]);
    expect(finalReviews).toBe(1);
    expect((await readManifestV2(setupResult.runDir)).work_item_progress.integrated).toMatchObject({ status: "in_progress", attempts: 2, implementation_path: finalFixReportPath });
  });

  it.each(["final_verification", "verifier_review"] as const)("reuses persisted integrated artifacts when resuming at %s", async (resumeStage) => {
    const setupResult = await setup(); root = setupResult.root;
    const workItem = item("first");
    const itemReportPath = "implementation/first/attempt-1.json";
    const finalEvidencePath = verificationEvidencePath(identity("integrated"), 1);
    const finalReviewPath = "reviews/integrated/final-attempt-1.json";
    const finalEvidence = evidence("integrated");
    const finalReview = review("approve", "integrated", 1, true);
    await writeTextArtifact(setupResult.runDir, itemReportPath, `${JSON.stringify(implementation("first"))}\n`);
    await persistEvidenceBundle(setupResult.runDir, { ...finalEvidence, evidence_path: finalEvidencePath });
    if (resumeStage === "verifier_review") await writeTextArtifact(setupResult.runDir, finalReviewPath, `${JSON.stringify(finalReview)}\n`);
    await transitionRun(setupResult.runDir, "implementing", { actor: "test", payload: { work_item_id: "first" } });
    await transitionRun(setupResult.runDir, "verifying", { actor: "test", payload: { work_item_id: "first", pass: 1 } });
    await transitionRun(setupResult.runDir, "verifier_review", { actor: "test", payload: { work_item_id: "first", pass: 1 } });
    await transitionRun(setupResult.runDir, "final_verification", { actor: "runtime", payload: { work_item_id: "integrated", final: true, pass: 1 } });
    if (resumeStage === "verifier_review") await transitionRun(setupResult.runDir, "verifier_review", { actor: "runtime", payload: { work_item_id: "integrated", final: true, pass: 1 } });
    await updateManifestV2(setupResult.runDir, {
      current_work_item_id: "integrated",
      work_item_progress: {
        first: { status: "complete", attempts: 1, implementation_path: itemReportPath },
        integrated: { status: "in_progress", attempts: 1, verification_path: finalEvidencePath, ...(resumeStage === "verifier_review" ? { review_path: finalReviewPath } : {}) },
      },
    });
    let verificationCalls = 0;
    let verifierCalls = 0;
    const result = await runLocalWorkflow({
      runDir: setupResult.runDir,
      worktreePath: setupResult.worktree,
      intake: { ...intake, repo_root: setupResult.root },
      plan: { ...plan, work_items: [workItem] },
      codex: {} as never,
      dependencies: {
        hands: async () => { throw new Error("persisted implementation should be reused"); },
        verification: async (input) => { verificationCalls += 1; return evidenceForInput(input); },
        verifier: async (input) => { verifierCalls += 1; return { review: finalReview, reviewPath: await persistReview(setupResult.runDir, finalReviewPath, finalReview), invocation: {} as never }; },
        commit: async () => "no-op",
        gitSnapshot: cleanSnapshot,
      },
    });
    expect(result.status).toBe("local_ready");
    expect(verificationCalls).toBe(0);
    expect(verifierCalls).toBe(resumeStage === "final_verification" ? 1 : 0);
  });

  it("fails closed when persisted integrated progress attempt 2 points to attempt-1 evidence", async () => {
    const setupResult = await setup(); root = setupResult.root;
    const workItem = item("first");
    const implementationPath = "implementation/first/attempt-1.json";
    const persistedEvidencePath = verificationEvidencePath(identity("integrated"), 1);
    await writeTextArtifact(setupResult.runDir, implementationPath, `${JSON.stringify(implementation("first"))}\n`);
    await persistEvidenceBundle(setupResult.runDir, evidence("integrated"));
    await updateManifestV2(setupResult.runDir, {
      current_work_item_id: "integrated",
      work_item_progress: {
        first: { status: "complete", attempts: 1, implementation_path: implementationPath },
        integrated: {
          status: "in_progress",
          attempts: 2,
          verification_path: persistedEvidencePath,
          verification_scope: "integrated",
          verification_work_item_id: "integrated",
        },
      },
    });
    await transitionRun(setupResult.runDir, "implementing", { actor: "test", payload: { work_item_id: "first" } });
    await transitionRun(setupResult.runDir, "verifying", { actor: "test", payload: { work_item_id: "first", pass: 1 } });
    await transitionRun(setupResult.runDir, "verifier_review", { actor: "test", payload: { work_item_id: "first", pass: 1 } });
    await transitionRun(setupResult.runDir, "final_verification", { actor: "runtime", payload: { work_item_id: "integrated", final: true, pass: 2 } });

    const calls: string[] = [];
    const result = await runLocalWorkflow({
      runDir: setupResult.runDir,
      worktreePath: setupResult.worktree,
      intake: { ...intake, repo_root: setupResult.root },
      plan: { ...plan, work_items: [workItem] },
      codex: {} as never,
      dependencies: {
        hands: async () => { calls.push("hands"); throw new Error("Hands must not run"); },
        verification: async () => { calls.push("verification"); throw new Error("verification must not run"); },
        verifier: async () => { calls.push("verifier"); throw new Error("Verifier must not run"); },
        commit: async () => { calls.push("commit"); throw new Error("delivery must not run"); },
        gitSnapshot: cleanSnapshot,
      },
    });

    expect(result.status).toBe("human_action_required");
    expect(result.blocker).toMatch(/persisted integrated verification could not be resumed/i);
    expect(calls).toEqual([]);
    const manifest = await readManifestV2(setupResult.runDir);
    expect(manifest.stage).toBe("final_verification");
    expect(manifest.delivery_state).toBe("blocked");
    const events = (await readFile(join(setupResult.runDir, "events.jsonl"), "utf8"))
      .split("\n").filter(Boolean).map((line) => JSON.parse(line) as { stage?: string });
    expect(events.some((event) => event.stage === "delivery")).toBe(false);
  });

  it("commits actual uncommitted worktree changes even when Hands reports no changed files", async () => {
    const setupResult = await setup(); root = setupResult.root; const commits: string[] = [];
    const progress = await openProgressReporter({ runDir: setupResult.runDir });
    let snapshotCalls = 0;
    const deps: LocalRuntimeDependencies = {
      hands: async (input) => ({
        implementation: { ...implementation(input.workItem.id), changed_files: [] },
        reportPath: `implementation/${input.workItem.id}.json`,
        invocation: {} as never,
      }),
      verification: async (input) => evidenceForInput(input),
      verifier: async (input) => { const value = review("approve", input.workItem.id, input.attempt, input.final); return { review: value, reviewPath: await persistReview(input.runDir, "reviews/integrated/final-attempt-1.json", value), invocation: {} as never }; },
      commit: async (input) => { const id = typeof input === "string" ? input : input.workItemId ?? ""; commits.push(id); return `sha-${id}`; },
      gitSnapshot: async () => ({ branch: "codex/test", status: snapshotCalls++ === 0 ? "" : snapshotCalls === 2 ? " M src/actual.ts\n" : "", gitDir: ".git", gitCommonDir: ".git", isLinkedWorktree: false }),
    };
    const result = await runLocalWorkflow({ runDir: setupResult.runDir, worktreePath: setupResult.worktree, intake: { ...intake, repo_root: setupResult.root }, plan: { ...plan, work_items: [item("first")] }, codex: {} as never, dependencies: deps, progress });
    expect(result.status).toBe("local_ready");
    expect(commits).toEqual(["integrated"]);
    const events = []; for await (const event of readProgressEvents(setupResult.runDir)) events.push(event);
    expect(events.map((event) => event.safe_label)).toContain("Approved changes committed");
  });

  it("propagates browser checks and fails closed on skipped browser evidence", async () => {
    const setupResult = await setup(); root = setupResult.root; let verifierCalls = 0;
    const browserCheck = {
      name: "desktop", url: "https://example.com/", local_server_command: "npm run dev",
      required_selectors: ["#app"], console_error_policy: "no_errors" as const,
      expected_network: [], screenshot_artifact: "reports/desktop.png",
    };
    const skippedEvidence: VerificationEvidence = {
      ...evidence("first"),
      browser_evidence: [{ name: "desktop", url: browserCheck.url, status: "skipped", screenshot_artifact: "verification/local/Zmlyc3Q/attempt-1/reports/desktop.png", screenshot_exists: false, expected_network: [], observed_network: [], missing_network: [], console_errors: [], missing_selectors: ["#app"], failure_reasons: [], evidence_report_path: null, skipped_reason: "No capture" }],
    };
    const deps: LocalRuntimeDependencies = {
      hands: async (input) => ({ implementation: implementation(input.workItem.id), reportPath: "implementation/item.json", invocation: {} as never }),
      verification: async (input) => { expect(input.browserChecks).toEqual([browserCheck]); return skippedEvidence; },
      verifier: async () => { verifierCalls += 1; throw new Error("verifier unavailable"); },
      commit: async () => "never",
      gitSnapshot: cleanSnapshot,
    };
    const result = await runLocalWorkflow({ runDir: setupResult.runDir, worktreePath: setupResult.worktree, intake: { ...intake, repo_root: setupResult.root }, plan: { ...plan, work_items: [{ ...item("first"), browser_checks: [browserCheck] }] }, codex: {} as never, dependencies: deps });
    expect(result.status).toBe("human_action_required"); expect(verifierCalls).toBe(0); expect((await readManifestV2(setupResult.runDir)).stage).toBe("verifying");
  });

  it("resumes a blocked verification in the next immutable attempt namespace", async () => {
    const setupResult = await setup(); root = setupResult.root;
    const verificationAttempts: number[] = [];
    let handsCalls = 0;
    const dependencies: LocalRuntimeDependencies = {
      hands: async (input) => {
        handsCalls += 1;
        const value = implementation(input.workItem.id);
        const reportPath = `implementation/${input.workItem.id}/attempt-1.json`;
        await writeTextArtifact(input.runDir, reportPath, `${JSON.stringify(value)}\n`);
        return { implementation: value, reportPath, invocation: {} as never };
      },
      verification: async (input) => {
        if (input.identity?.work_item_id === "first") verificationAttempts.push(input.attempt ?? 1);
        const value = evidenceForInput(input);
        if (input.identity?.work_item_id === "first" && input.attempt === 1) {
          return {
            ...value,
            commands: value.commands.map((command) => ({ ...command, exit_code: 1 })),
          };
        }
        return value;
      },
      verifier: async (input) => {
        const value = review("approve", input.workItem.id, input.attempt, input.final);
        const path = input.final
          ? `reviews/integrated/final-attempt-${input.attempt}.json`
          : `reviews/${input.workItem.id}/attempt-${input.attempt}.json`;
        return { review: value, reviewPath: await persistReview(input.runDir, path, value), invocation: {} as never };
      },
      commit: async () => "no-op",
      gitSnapshot: cleanSnapshot,
    };

    const first = await runLocalWorkflow({
      runDir: setupResult.runDir,
      worktreePath: setupResult.worktree,
      intake: { ...intake, repo_root: setupResult.root },
      plan: { ...plan, work_items: [item("first")] },
      codex: {} as never,
      dependencies,
    });
    expect(first.status).toBe("human_action_required");
    expect((await readManifestV2(setupResult.runDir)).work_item_progress.first).toMatchObject({
      status: "blocked",
      attempts: 1,
      verification_path: "verification/local/Zmlyc3Q/attempt-1/evidence.json",
    });

    const resumed = await runLocalWorkflow({
      runDir: setupResult.runDir,
      worktreePath: setupResult.worktree,
      intake: { ...intake, repo_root: setupResult.root },
      plan: { ...plan, work_items: [item("first")] },
      codex: {} as never,
      dependencies,
    });
    expect(resumed.status).toBe("local_ready");
    expect(handsCalls).toBe(1);
    expect(verificationAttempts).toEqual([1, 2]);
    expect((await readManifestV2(setupResult.runDir)).work_item_progress.first).toMatchObject({
      status: "complete",
      attempts: 2,
      verification_path: "verification/local/Zmlyc3Q/attempt-2/evidence.json",
    });
  });

  it("passes all plan browser checks and prior per-item evidence into final verification", async () => {
    const setupResult = await setup(); root = setupResult.root;
    const browserCheck = {
      name: "desktop", url: "https://example.com/", local_server_command: "npm run dev",
      required_selectors: ["#app"], console_error_policy: "no_errors" as const,
      expected_network: [], screenshot_artifact: "reports/desktop.png",
    };
    let finalInput: VerifyWorkItemInput | undefined;
    const verificationInputs: RunVerificationInput[] = [];
    const deps: LocalRuntimeDependencies = {
      hands: async (input) => ({ implementation: implementation(input.workItem.id), reportPath: "implementation/item.json", invocation: {} as never }),
      verification: async (input) => {
        verificationInputs.push(input);
        const currentIdentity = input.identity ?? identity("first");
        const prefix = `${verificationIdentityDirectory(currentIdentity)}/attempt-${input.attempt}`;
        return {
          ...evidenceForInput(input),
          browser_evidence: [{ name: "desktop", url: browserCheck.url, status: "passed" as const, screenshot_artifact: `${prefix}/reports/desktop.png`, screenshot_exists: true, expected_network: [], observed_network: [], missing_network: [], console_errors: [], missing_selectors: [], failure_reasons: [], evidence_report_path: `${prefix}/browser.json`, skipped_reason: null }],
        };
      },
      verifier: async (input) => { if (input.final) finalInput = input; const value = review("approve", input.workItem.id, input.attempt, input.final); return { review: value, reviewPath: await persistReview(input.runDir, input.final ? "reviews/integrated/final-attempt-1.json" : "reviews/item.json", value), invocation: {} as never }; },
      commit: async () => { throw new Error("clean worktree must not commit"); },
      gitSnapshot: cleanSnapshot,
    };
    const browserPlan: BrainPlan = { ...plan, work_items: [{ ...item("first"), browser_checks: [browserCheck], expected_artifacts: ["reports/browser.json"] }] };
    const result = await runLocalWorkflow({ runDir: setupResult.runDir, worktreePath: setupResult.worktree, intake: { ...intake, repo_root: setupResult.root }, plan: browserPlan, codex: {} as never, dependencies: deps });
    expect(result.status).toBe("local_ready");
    expect(verificationInputs.at(-1)?.browserChecks).toEqual([browserCheck]);
    expect(verificationInputs.at(-1)?.expectedArtifacts).toContain("reports/browser.json");
    expect(verificationInputs.map((input) => input.identity?.work_item_id)).toContain("integrated");
    expect(verificationInputs.map((input) => input.identity?.work_item_id)).toContainEqual(
      expect.stringMatching(/^first:quality-gate:1:baseline:authority-[a-f0-9]{16}$/),
    );
    expect(verificationInputs.every((input) => input.stopOnFailure === true)).toBe(true);
    expect(finalInput?.priorVerification).toHaveLength(1);
    expect(finalInput?.priorVerification?.[0]?.evidence_path).toContain("verification/local/");
  });

  it("records Hands and Verifier invocation failures as durable blockers", async () => {
    const handsSetup = await setup();
    const handsPlan = { ...plan, work_items: [item("first")] };
    const handsPlanRevision = await recordPlan(handsSetup.runDir, `${JSON.stringify(handsPlan)}\n`);
    await approvePlanRevision(handsSetup.runDir, handsPlanRevision.revision, { actor: "test" });
    let handsCalls = 0;
    const handsInput = {
      runDir: handsSetup.runDir,
      worktreePath: handsSetup.worktree,
      intake: { ...intake, repo_root: handsSetup.root },
      plan: handsPlan,
      codex: {} as never,
      dependencies: {
        hands: async () => { handsCalls += 1; throw new Error("hands unavailable"); },
        gitSnapshot: cleanSnapshot,
      },
    } as RunLocalWorkflowInput;
    const handsResult = await runLocalWorkflow(handsInput);
    expect(handsResult.status).toBe("human_action_required");
    expect(handsResult.blocker).toContain("Hands invocation failed");
    expect((await readManifestV2(handsSetup.runDir)).recovery.scopes["work-item:first"]).toMatchObject({
      head_sequence: 1,
      consecutive_without_progress: 1,
    });
    const repeatedHands = await runLocalWorkflow(handsInput);
    expect(repeatedHands.blocker).toContain("Recovery diagnostic stop");
    expect((await readManifestV2(handsSetup.runDir)).recovery.scopes["work-item:first"]).toMatchObject({
      disposition: "diagnostic_stop",
      head_sequence: 2,
      consecutive_without_progress: 2,
    });
    await authorizeDiagnosticResume({
      runDir: handsSetup.runDir,
      actor: "operator",
      note: "Retry the exact Hands invocation once",
    });
    const authorizedFailure = await runLocalWorkflow(handsInput);
    expect(authorizedFailure.blocker).toContain("Recovery diagnostic stop");
    expect(handsCalls).toBe(3);
    expect((await readManifestV2(handsSetup.runDir)).recovery.scopes["work-item:first"]).toMatchObject({
      disposition: "diagnostic_stop",
      head_sequence: 3,
      consecutive_without_progress: 3,
      authorization_path: null,
    });
    const stoppedReplay = await runLocalWorkflow(handsInput);
    expect(stoppedReplay.blocker).toContain("Recovery diagnostic stop");
    expect(handsCalls).toBe(3);
    await rm(handsSetup.root, { recursive: true, force: true });

    const verifierSetup = await setup();
    const verifierPlan = { ...plan, work_items: [item("first")] };
    const verifierPlanRevision = await recordPlan(verifierSetup.runDir, `${JSON.stringify(verifierPlan)}\n`);
    await approvePlanRevision(verifierSetup.runDir, verifierPlanRevision.revision, { actor: "test" });
    const verifierResult = await runLocalWorkflow({
      runDir: verifierSetup.runDir,
      worktreePath: verifierSetup.worktree,
      intake: { ...intake, repo_root: verifierSetup.root },
      plan: verifierPlan,
      codex: {} as never,
      dependencies: {
        hands: async (input) => {
          const value = implementation(input.workItem.id);
          const reportPath = "implementation/item.json";
          await writeTextArtifact(input.runDir, reportPath, `${JSON.stringify(value)}\n`);
          return { implementation: value, reportPath, invocation: {} as never };
        },
        verification: async (input) => {
          const value = evidenceForInput(input);
          await persistEvidenceBundle(input.runDir, value);
          return value;
        },
        verifier: async () => { throw new Error("verifier unavailable"); },
        gitSnapshot: cleanSnapshot,
      },
    });
    expect(verifierResult.status).toBe("human_action_required");
    expect(verifierResult.blocker).toContain("Verifier invocation failed");
    expect((await readManifestV2(verifierSetup.runDir)).recovery.scopes["work-item:first"]).toMatchObject({
      head_sequence: 1,
      consecutive_without_progress: 1,
    });
    await writeTextArtifact(
      verifierSetup.runDir,
      "implementation/item.json",
      `${JSON.stringify({ ...implementation("first"), completed_steps: ["changed"] })}\n`,
    );
    const changedVerifierResult = await runLocalWorkflow({
      runDir: verifierSetup.runDir,
      worktreePath: join(verifierSetup.root, "worktree"),
      intake: { ...intake, repo_root: verifierSetup.root },
      plan: verifierPlan,
      codex: {} as never,
      dependencies: {
        hands: async () => { throw new Error("persisted implementation must be reused"); },
        verification: async () => { throw new Error("persisted verification must be reused"); },
        verifier: async () => { throw new Error("verifier unavailable"); },
        gitSnapshot: cleanSnapshot,
      },
    });
    expect(changedVerifierResult.blocker).toContain("Verifier invocation failed");
    expect((await readManifestV2(verifierSetup.runDir)).recovery.scopes["work-item:first"]).toMatchObject({
      disposition: "awaiting_external_fix",
      head_sequence: 2,
      consecutive_without_progress: 1,
    });
    await rm(verifierSetup.root, { recursive: true, force: true });
    root = undefined;
  });

  it("durably blocks when verification or commit fails", async () => {
    const verificationSetup = await setup();
    const verificationResult = await runLocalWorkflow({
      runDir: verificationSetup.runDir,
      worktreePath: verificationSetup.worktree,
      intake: { ...intake, repo_root: verificationSetup.root },
      plan: { ...plan, work_items: [item("first")] },
      codex: {} as never,
      dependencies: {
        hands: async (input) => ({ implementation: implementation(input.workItem.id), reportPath: "implementation/item.json", invocation: {} as never }),
        verification: async () => { throw new Error("runner unavailable"); },
        gitSnapshot: cleanSnapshot,
      },
    });
    expect(verificationResult.status).toBe("human_action_required");
    expect(verificationResult.blocker).toContain("Local runtime failed");
    expect((await readManifestV2(verificationSetup.runDir)).delivery_state).toBe("blocked");
    await rm(verificationSetup.root, { recursive: true, force: true });

    const commitSetup = await setup();
    const commitResult = await runLocalWorkflow({
      runDir: commitSetup.runDir,
      worktreePath: commitSetup.worktree,
      intake: { ...intake, repo_root: commitSetup.root },
      plan: { ...plan, work_items: [item("first")] },
      codex: {} as never,
      dependencies: {
        hands: async (input) => ({ implementation: implementation(input.workItem.id), reportPath: "implementation/item.json", invocation: {} as never }),
        verification: async (input) => evidenceForInput(input),
        verifier: async (input) => { const value = review("approve", input.workItem.id, input.attempt, false); return { review: value, reviewPath: await persistReview(input.runDir, "reviews/item.json", value), invocation: {} as never }; },
        hasWorktreeChanges: async () => true,
        commit: async () => { throw new Error("commit unavailable"); },
        gitSnapshot: cleanSnapshot,
      },
    });
    expect(commitResult.status).toBe("human_action_required");
    expect(commitResult.blocker).toContain("Local runtime failed");
    expect((await readManifestV2(commitSetup.runDir)).delivery_state).toBe("blocked");
    await rm(commitSetup.root, { recursive: true, force: true });
    root = undefined;
  });

  it("records integrated verification infrastructure failures in the final recovery scope", async () => {
    const setupResult = await setup(); root = setupResult.root;
    const runtimePlan = { ...plan, work_items: [item("first")] };
    const recorded = await recordPlan(setupResult.runDir, `${JSON.stringify(runtimePlan)}\n`);
    await approvePlanRevision(setupResult.runDir, recorded.revision, { actor: "test" });
    const result = await runLocalWorkflow({
      runDir: setupResult.runDir,
      worktreePath: join(setupResult.root, "worktree"),
      intake: { ...intake, repo_root: setupResult.root },
      plan: runtimePlan,
      codex: {} as never,
      dependencies: {
        hands: async (input) => {
          const value = implementation(input.workItem.id);
          const reportPath = `implementation/${input.workItem.id}/attempt-${input.attempt}.json`;
          await writeTextArtifact(input.runDir, reportPath, `${JSON.stringify({
            ...value,
            profile_kind: input.profileKind ?? "primary",
            model: input.profile?.model ?? input.intake.roles.hands.model,
            reasoning_effort: input.profile?.reasoning_effort ?? input.intake.roles.hands.reasoning_effort,
          })}\n`);
          return { implementation: value, reportPath, invocation: {} as never };
        },
        verification: async (input) => {
          if (input.identity?.work_item_id === "integrated") throw new Error("integrated runner unavailable");
          const value = evidenceForInput(input);
          await persistEvidenceBundle(input.runDir, value);
          return value;
        },
        verifier: async (input) => {
          const value = review("approve", input.workItem.id, input.attempt, input.final);
          const path = `reviews/${input.workItem.id}/attempt-${input.attempt}.json`;
          return { review: value, reviewPath: await persistReview(input.runDir, path, value), invocation: {} as never };
        },
        hasWorktreeChanges: async () => false,
        gitSnapshot: cleanSnapshot,
      },
    });

    expect(result.status).toBe("human_action_required");
    expect(result.blocker).toContain("Integrated verification infrastructure failed");
    expect((await readManifestV2(setupResult.runDir)).recovery.scopes["integrated:final"]).toMatchObject({
      disposition: "awaiting_external_fix",
      head_sequence: 1,
      consecutive_without_progress: 1,
    });
  });

  it("records an ordered Reviewer-action operational failure without authorizing corruption", async () => {
    const config = qualityConfig(0);
    const setupResult = await setup(config.retry_policy.quality_gate, undefined, true); root = setupResult.root;
    const runtimePlan = { ...plan, work_items: [item("first")] };
    const recorded = await recordPlan(setupResult.runDir, `${JSON.stringify(runtimePlan)}\n`);
    await approvePlanRevision(setupResult.runDir, recorded.revision, { actor: "test" });
    let workItemReviews = 0;
    let actionVerifierCalls = 0;
    let actionVerifierFails = true;
    let interruptAfterOutcome = false;
    let interruptAfterEffectProgress = false;
    const workflowInput = {
      runDir: setupResult.runDir,
      worktreePath: join(setupResult.root, "worktree"),
      intake: { ...intake, repo_root: setupResult.root },
      plan: runtimePlan,
      codex: {} as never,
      config,
      dependencies: {
        hands: async (input) => {
          const value = implementation(input.workItem.id);
          const reportPath = `implementation/${input.workItem.id}/attempt-${input.attempt}.json`;
          await writeTextArtifact(input.runDir, reportPath, `${JSON.stringify({
            ...value,
            profile_kind: input.profileKind ?? "primary",
            model: input.profile?.model ?? input.intake.roles.hands.model,
            reasoning_effort: input.profile?.reasoning_effort ?? input.intake.roles.hands.reasoning_effort,
          })}\n`);
          return { implementation: value, reportPath, invocation: {} as never };
        },
        verification: async (input) => {
          const value = { ...evidenceForInput(input), created_at: "2026-07-16T00:00:00.000Z" };
          await persistEvidenceBundle(input.runDir, value);
          return value;
        },
        verifier: async (input) => {
          const requested = !input.final && workItemReviews++ === 0;
          const value = {
            ...review(requested ? "request_changes" : "approve", input.workItem.id, input.attempt, input.final),
            failure_class: requested ? "implementation_failure" as const : "none" as const,
            blocker: null,
            blocker_code: null,
            evidence_reviewed: [verifierEvidenceRef(input)],
            findings: requested ? [packetFinding(input.workItem, verifierEvidenceRef(input))] : [],
          };
          const path = `reviews/${input.workItem.id}/attempt-${input.attempt}.json`;
          return { review: value, reviewPath: await persistReview(input.runDir, path, value), invocation: {} as never };
        },
        handsFixPacket: async (input) => {
          await mkdir(join(input.worktreePath, "src"), { recursive: true });
          await writeFile(join(input.worktreePath, "src/first.ts"), "export const recoveredPacket = true;\n", "utf8");
          const value = {
            schema_version: 1 as const,
            packet_id: input.packet.provenance.packet_id,
            packet_sha256: hashReviewFixPacket(input.packet),
            action_attempt: input.actionAttempt,
            status: "implemented" as const,
            change_units: input.packet.remediation.change_units.map((unit) => ({
              change_unit_id: unit.id,
              status: "completed" as const,
              changed_files: [unit.path],
              summary: "Applied ordered recovery fix",
            })),
            changed_files: input.packet.completion_contract.expected_changed_files,
            commands_attempted: [],
            unresolved_requirements: [],
            blocker: null,
          };
          const reportPath = `reviews/fix-packets/${Buffer.from(input.packet.provenance.packet_id).toString("base64url")}/attempts/${input.actionAttempt}/hands-result.json`;
          await writeTextArtifact(input.runDir, reportPath, `${JSON.stringify(value)}\n`);
          const profile = input.profile ?? input.intake.roles.hands;
          return { result: value, reportPath, invocation: {} as never, profile: { kind: input.profileKind ?? "primary", model: profile.model, reasoning_effort: profile.reasoning_effort } };
        },
        packetVerifier: async (input) => {
          actionVerifierCalls += 1;
          if (actionVerifierFails) throw new Error("focused Reviewer unavailable");
          const value = {
            packet_id: input.packet.provenance.packet_id,
            packet_sha256: hashReviewFixPacket(input.packet),
            action_attempt: input.actionAttempt,
            decision: "resolved" as const,
            condition_results: input.packet.verification.success_conditions.map((condition) => ({
              success_condition_id: condition.id,
              status: "satisfied" as const,
              evidence_refs: [input.verificationEvidence.evidence_path],
              remaining_problem: null,
            })),
            required_next_fix: null,
            blocker: null,
          };
          const reviewPath = `reviews/fix-packets/${Buffer.from(input.packet.provenance.packet_id).toString("base64url")}/attempts/${input.actionAttempt}/focused-resolution.json`;
          await writeTextArtifact(input.runDir, reviewPath, `${JSON.stringify(value)}\n`);
          return { review: value, reviewPath, invocation: {} as never };
        },
        afterCheckpoint: async (name) => {
          if (name === "after_ordered_recovery_outcome" && interruptAfterOutcome) {
            interruptAfterOutcome = false;
            throw new Error("crash after ordered recovery outcome");
          }
          if (name === "after_ordered_fix_effect_progress" && interruptAfterEffectProgress) {
            interruptAfterEffectProgress = false;
            throw new Error("crash after ordered fix effect progress");
          }
        },
        diff: async () => "diff",
        changedFiles: async () => ["src/first.ts"],
        hasWorktreeChanges: async () => false,
        gitSnapshot: cleanSnapshot,
      },
    } as RunLocalWorkflowInput;
    const result = await runLocalWorkflow(workflowInput);

    expect(result.status).toBe("human_action_required");
    expect(result.blocker).toContain("Reviewer action");
    const failedManifest = await readManifestV2(setupResult.runDir);
    expect(failedManifest.recovery.scopes["work-item:first"]).toMatchObject({
      disposition: "awaiting_external_fix",
      head_sequence: 2,
      consecutive_without_progress: 1,
    });
    expect(failedManifest.work_item_progress.first).toMatchObject({
      queue_state: "in_progress",
      review_cycle_path: expect.any(String),
      review_effect_id: expect.any(String),
    });
    const repeated = await runLocalWorkflow(workflowInput);
    expect(repeated.blocker, JSON.stringify(failedManifest.work_item_progress.first)).toContain("Recovery diagnostic stop");
    expect(actionVerifierCalls, `${result.blocker} / ${repeated.blocker}`).toBe(2);
    await authorizeDiagnosticResume({
      runDir: setupResult.runDir,
      actor: "operator",
      note: "Retry the exact ordered Reviewer action once",
    });
    actionVerifierFails = false;
    interruptAfterOutcome = true;
    const interrupted = await runLocalWorkflow(workflowInput);
    expect(interrupted.blocker).toContain("crash after ordered recovery outcome");
    expect(actionVerifierCalls).toBe(3);
    expect((await readManifestV2(setupResult.runDir)).work_item_progress.first).toMatchObject({
      verification_scope: "local",
      verification_work_item_id: "first",
    });
    interruptAfterEffectProgress = true;
    const effectCompleted = await runLocalWorkflow(workflowInput);
    expect(effectCompleted.blocker).toContain("crash after ordered fix effect progress");
    const staleManifest = await readManifestV2(setupResult.runDir);
    await updateManifestV2(setupResult.runDir, {
      work_item_progress: {
        ...staleManifest.work_item_progress,
        first: {
          ...staleManifest.work_item_progress.first!,
          verification_scope: "local",
          verification_work_item_id: "first:quality-gate:2000101:baseline:authority-deadbeefdeadbeef",
        },
      },
    });
    const resumed = await runLocalWorkflow(workflowInput);
    expect(resumed.blocker).not.toContain("focused Reviewer unavailable");
    expect(actionVerifierCalls).toBe(3);
    expect((await readManifestV2(setupResult.runDir)).work_item_progress.first).toMatchObject({
      queue_state: "complete",
      verification_scope: "local",
      verification_work_item_id: "first",
    });
  });

  it("runs deterministic verification after the mutation and each changed self-review before Verifier", async () => {
    const config = qualityConfig(2);
    const setupResult = await setup(config.retry_policy.quality_gate); root = setupResult.root;
    const calls: string[] = [];
    const verificationInputs: RunVerificationInput[] = [];
    const result = await runLocalWorkflow({
      runDir: setupResult.runDir,
      worktreePath: setupResult.worktree,
      intake: { ...intake, repo_root: setupResult.root },
      plan: { ...plan, work_items: [item("first")] },
      codex: {} as never,
      config,
      dependencies: {
        hands: async () => { calls.push("hands:mutation"); return { implementation: implementation("first"), reportPath: "implementation/first/attempt-1.json", invocation: {} as never }; },
        verification: async (input) => { verificationInputs.push(input); calls.push(calls.filter((call) => call.startsWith("hands:self-review")).length === 0 ? "verify:mutation" : `verify:self-review:${calls.filter((call) => call.startsWith("hands:self-review")).length}`); return evidenceForInput(input); },
        selfReview: async (input) => {
          calls.push(`hands:self-review:${input.pass}`);
          const report = selfReviewReport(input.workItem.id, input.parentAttempt, input.pass);
          const reportPath = `self-review/first/attempt-1/pass-${input.pass}.json`;
          await writeTextArtifact(input.runDir, reportPath, `${JSON.stringify(report)}\n`);
          return { report, reportPath, invocation: {} as never };
        },
        diff: async () => "diff",
        verifier: async (input) => {
          calls.push("verifier:full");
          const value = review("replan_required", input.workItem.id, input.attempt, false);
          return { review: value, reviewPath: await persistReview(input.runDir, "reviews/first/attempt-1.json", value), invocation: {} as never };
        },
        gitSnapshot: cleanSnapshot,
      },
    });
    expect(result.status).toBe("human_action_required");
    expect(calls).toEqual([
      "hands:mutation",
      "verify:mutation",
      "hands:self-review:1",
      "verify:self-review:1",
      "hands:self-review:2",
      "verify:self-review:2",
      "verifier:full",
    ]);
    expect(verificationInputs).toHaveLength(3);
    expect(verificationInputs.every((input) => input.stopOnFailure === true)).toBe(true);
    const progress = (await readManifestV2(setupResult.runDir)).work_item_progress.first;
    expect(progress?.mutation_verification_path).toMatch(/^verification\/local\//);
    expect(Object.values(progress?.self_review_verification_paths ?? {})).toHaveLength(2);
    expect(Object.values(progress?.self_review_verification_paths ?? {}).every((path) => path.startsWith("verification/local/"))).toBe(true);
  });

  it("escalates a partially fixed but exhausted scope-blocked self-review to Verifier", async () => {
    const config = qualityConfig(1);
    const setupResult = await setup(config.retry_policy.quality_gate); root = setupResult.root;
    let verifierCalls = 0;
    const result = await runLocalWorkflow({
      runDir: setupResult.runDir,
      worktreePath: setupResult.worktree,
      intake: { ...intake, repo_root: setupResult.root },
      plan: { ...plan, work_items: [item("first")] },
      codex: {} as never,
      config,
      dependencies: {
        hands: async () => ({ implementation: implementation("first"), reportPath: "implementation/first/attempt-1.json", invocation: {} as never }),
        verification: async (input) => {
          const value = evidenceForInput(input);
          return { ...value, commands: value.commands.map((command) => ({ ...command, exit_code: 1 })) };
        },
        selfReview: async (input) => {
          const report = {
            ...selfReviewReport("first", input.parentAttempt, input.pass, true),
            findings: ["The required fix is outside the approved file contract."],
            remaining_findings: ["Expand the file contract before fixing verification."],
            ready_for_resolution_check: false,
          };
          const reportPath = `self-review/first/attempt-1/pass-${input.pass}.json`;
          await writeTextArtifact(input.runDir, reportPath, `${JSON.stringify(report)}\n`);
          return { report, reportPath, invocation: {} as never };
        },
        diff: async () => "diff",
        verifier: async (input) => {
          verifierCalls += 1;
          expect(input.verification?.commands[0]?.exit_code).toBe(1);
          const value = review("replan_required", input.workItem.id, input.attempt, false);
          return { review: value, reviewPath: await persistReview(input.runDir, "reviews/first/attempt-1.json", value), invocation: {} as never };
        },
        gitSnapshot: cleanSnapshot,
      },
    });

    expect(result.status).toBe("human_action_required");
    expect(verifierCalls).toBe(1);
  });

  it("injects the scoped diff collector with the work-item contracts rather than Hands-reported files", async () => {
    const config = qualityConfig(1);
    const setupResult = await setup(config.retry_policy.quality_gate); root = setupResult.root;
    const workItem = item("first");
    const collectorInputs: Array<{ workItem: Pick<WorkItem, "file_contract" | "completion_contract"> }> = [];
    const dependencies: LocalRuntimeDependencies = {
      hands: async () => ({
        implementation: { ...implementation("first"), changed_files: ["src/first.ts"] },
        reportPath: "implementation/first/attempt-1.json",
        invocation: {} as never,
      }),
      verification: async (input) => evidenceForInput(input),
      collectScopedWorktreeDiff: async (input) => {
        collectorInputs.push(input);
        return {
          base_commit: input.baseCommit,
          head_commit: input.baseCommit,
          changed_files: ["src/first.ts", "tests/first.test.ts"],
          patch: "contract-scoped diff",
          patch_bytes: Buffer.byteLength("contract-scoped diff", "utf8"),
        };
      },
      selfReview: async (input) => {
        expect(input.currentDiff).toBe("contract-scoped diff");
        const report = selfReviewReport("first", 1, input.pass, false);
        const reportPath = `self-review/first/attempt-1/pass-${input.pass}.json`;
        await writeTextArtifact(input.runDir, reportPath, `${JSON.stringify(report)}\n`);
        return { report, reportPath, invocation: {} as never };
      },
      verifier: async (input) => {
        const value = review("replan_required", input.workItem.id, input.attempt, false);
        return { review: value, reviewPath: await persistReview(input.runDir, "reviews/first/attempt-1.json", value), invocation: {} as never };
      },
      gitSnapshot: cleanSnapshot,
    };

    const result = await runLocalWorkflow({
      runDir: setupResult.runDir,
      worktreePath: join(setupResult.root, "worktree"),
      intake: { ...intake, repo_root: setupResult.root },
      plan: { ...plan, work_items: [workItem] },
      codex: {} as never,
      config,
      dependencies,
    });

    expect(result.status).toBe("human_action_required");
    expect(collectorInputs).toHaveLength(1);
    expect(collectorInputs[0]?.workItem.file_contract.map((entry) => entry.path)).toEqual([
      "src/first.ts",
      "tests/first.test.ts",
    ]);
    expect(collectorInputs[0]?.workItem.completion_contract.expected_changed_files).toEqual([
      "src/first.ts",
      "tests/first.test.ts",
    ]);
    expect(collectorInputs[0]).not.toHaveProperty("implementation");
    expect(collectorInputs[0]).not.toHaveProperty("changed_files");
  });

  it("builds bounded Verifier input from one controller snapshot instead of the Hands report", async () => {
    const boundedPlan = { ...plan, work_items: [item("first")] };
    const config = qualityConfig(0);
    const setupResult = await setupBounded(boundedPlan, false, config.retry_policy.quality_gate); root = setupResult.root;
    const collectorInputs: Array<{ baseCommit: string }> = [];
    const patch = "controller-owned scoped patch";
    const changedFiles = ["src/first.ts", "tests/first.test.ts"];
    let verifierCalls = 0;
    const result = await runLocalWorkflow({
      runDir: setupResult.runDir,
      worktreePath: join(setupResult.root, "worktree"),
      intake: { ...intake, repo_root: setupResult.root },
      plan: boundedPlan,
      codex: {} as never,
      config,
      dependencies: {
        hands: async (input) => {
          const value = { ...implementation(input.workItem.id), changed_files: [] };
          const reportPath = `implementation/${input.workItem.id}/attempt-${input.attempt}.json`;
          await writeTextArtifact(input.runDir, reportPath, `${JSON.stringify(value)}\n`);
          return { implementation: value, reportPath, invocation: {} as never };
        },
        verification: async (input) => {
          const value = boundedEvidence(input);
          await persistEvidenceBundle(input.runDir, value);
          return value;
        },
        collectScopedWorktreeDiff: async (input) => {
          collectorInputs.push(input);
          return {
            base_commit: input.baseCommit,
            head_commit: input.baseCommit,
            changed_files: changedFiles,
            patch,
            patch_bytes: Buffer.byteLength(patch, "utf8"),
          };
        },
        verifier: async (input) => {
          verifierCalls += 1;
          expect(input.context?.diff).toBe(patch);
          expect(input.context?.changed_files).toEqual(changedFiles);
          expect(input).not.toHaveProperty("implementation");
          const value: VerifierReview = {
            ...review("replan_required", input.workItem.id, input.attempt, false),
            failure_class: "replan_required",
            blocker: null,
            blocker_code: null,
            acceptance_coverage: [],
            evidence_reviewed: [verifierEvidenceRef(input)],
            findings: [],
          };
          return {
            review: value,
            reviewPath: await persistReview(input.runDir, `reviews/${input.workItem.id}/attempt-${input.attempt}.json`, value),
            invocation: {} as never,
          };
        },
        hasWorktreeChanges: async () => false,
        gitSnapshot: cleanSnapshot,
      },
    });

    expect(result.status).toBe("human_action_required");
    expect(verifierCalls).toBe(1);
    expect(collectorInputs).toHaveLength(2);
    expect(new Set(collectorInputs.map(({ baseCommit }) => baseCommit))).toEqual(new Set([collectorInputs[0]!.baseCommit]));
  });

  it("rejects bounded Verifier context replay when the controller Git snapshot HEAD drifts", async () => {
    const boundedPlan = { ...plan, work_items: [item("first")] };
    const config = qualityConfig(0);
    const setupResult = await setupBounded(boundedPlan, false, config.retry_policy.quality_gate); root = setupResult.root;
    const patch = "original controller patch";
    let headCommit: string | null = null;
    let verifierCalls = 0;
    let handsCalls = 0;
    const dependencies: LocalRuntimeDependencies = {
      hands: async (input) => {
        handsCalls += 1;
        const value = implementation(input.workItem.id);
        const reportPath = `implementation/${input.workItem.id}/attempt-${input.attempt}.json`;
        await writeTextArtifact(input.runDir, reportPath, `${JSON.stringify(value)}\n`);
        return { implementation: value, reportPath, invocation: {} as never };
      },
      verification: async (input) => {
        const value = boundedEvidence(input);
        await persistEvidenceBundle(input.runDir, value);
        return value;
      },
      collectScopedWorktreeDiff: async (input) => ({
        base_commit: input.baseCommit,
        head_commit: headCommit ?? input.baseCommit,
        changed_files: ["src/first.ts"],
        patch,
        patch_bytes: Buffer.byteLength(patch, "utf8"),
      }),
      verifier: async () => {
        verifierCalls += 1;
        throw new Error("simulated Verifier transport failure");
      },
      hasWorktreeChanges: async () => false,
      gitSnapshot: cleanSnapshot,
    };
    const workflowInput: RunLocalWorkflowInput = {
      runDir: setupResult.runDir,
      worktreePath: join(setupResult.root, "worktree"),
      intake: { ...intake, repo_root: setupResult.root },
      plan: boundedPlan,
      codex: {} as never,
      config,
      dependencies,
    };

    const first = await runLocalWorkflow(workflowInput);
    expect(first.status).toBe("human_action_required");
    expect(first.blocker).toContain("simulated Verifier transport failure");
    expect(verifierCalls).toBe(1);
    headCommit = "e".repeat(40);
    const resumed = await runLocalWorkflow(workflowInput);
    expect(resumed.status).toBe("human_action_required");
    expect(resumed.blocker).toMatch(/Git snapshot/i);
    expect(verifierCalls).toBe(1);
    expect(handsCalls).toBe(1);
  });

  it("supports zero and unchanged self-review passes without extra verification", async () => {
    for (const passes of [0, 2]) {
      const config = qualityConfig(passes);
      const setupResult = await setup(config.retry_policy.quality_gate); root = setupResult.root;
      const calls: string[] = [];
      const result = await runLocalWorkflow({
        runDir: setupResult.runDir,
        worktreePath: setupResult.worktree,
        intake: { ...intake, repo_root: setupResult.root },
        plan: { ...plan, work_items: [item("first")] },
        codex: {} as never,
        config,
        dependencies: {
          hands: async () => { calls.push("hands"); return { implementation: implementation("first"), reportPath: "implementation/first/attempt-1.json", invocation: {} as never }; },
          verification: async (input) => { calls.push("verify"); return evidenceForInput(input); },
          selfReview: async (input) => {
            calls.push(`self-review:${input.pass}`);
            const report = selfReviewReport("first", 1, input.pass, false);
            const reportPath = `self-review/first/attempt-1/pass-${input.pass}.json`;
            await writeTextArtifact(input.runDir, reportPath, `${JSON.stringify(report)}\n`);
            return { report, reportPath, invocation: {} as never };
          },
          diff: async () => "diff",
          verifier: async (input) => {
            calls.push("verifier");
            const value = review("replan_required", input.workItem.id, input.attempt, false);
            return { review: value, reviewPath: await persistReview(input.runDir, "reviews/first/attempt-1.json", value), invocation: {} as never };
          },
          gitSnapshot: cleanSnapshot,
        },
      });
      expect(result.status).toBe("human_action_required");
      expect(calls).toEqual(passes === 0
        ? ["hands", "verify", "verifier"]
        : ["hands", "verify", "self-review:1", "self-review:2", "verify", "verifier"]);
      await rm(setupResult.root, { recursive: true, force: true }); root = undefined;
    }
  });

  it("keeps a malformed self-review on the same durable pass and blocks before Verifier", async () => {
    const config = qualityConfig(1);
    const setupResult = await setup(config.retry_policy.quality_gate); root = setupResult.root;
    let verifierCalls = 0;
    const result = await runLocalWorkflow({
      runDir: setupResult.runDir,
      worktreePath: setupResult.worktree,
      intake: { ...intake, repo_root: setupResult.root },
      plan: { ...plan, work_items: [item("first")] },
      codex: {} as never,
      config,
      dependencies: {
        hands: async () => ({ implementation: implementation("first"), reportPath: "implementation/first/attempt-1.json", invocation: {} as never }),
        verification: async (input) => evidenceForInput(input),
        selfReview: async () => ({ report: { pass: "bad" } as never, reportPath: "self-review/bad.json", invocation: {} as never }),
        diff: async () => "diff",
        verifier: async () => { verifierCalls += 1; throw new Error("must not run"); },
        gitSnapshot: cleanSnapshot,
      },
    });
    expect(result.status).toBe("human_action_required");
    expect(result.blocker).toContain("self-review");
    expect(verifierCalls).toBe(0);
    expect((await readManifestV2(setupResult.runDir)).work_item_progress.first).toMatchObject({
      self_review_pass: 1,
      self_review_state: "invoking",
    });
  });

  it("reuses a completed self-review report when resuming an interrupted pass", async () => {
    const config = qualityConfig(1);
    const setupResult = await setup(config.retry_policy.quality_gate); root = setupResult.root;
    const reportPath = "implementation/first/attempt-1.json";
    const verificationPath = verificationEvidencePath(identity("first"), 1);
    const selfReviewPath = "self-review/first/attempt-1/pass-1.json";
    await writeTextArtifact(setupResult.runDir, reportPath, `${JSON.stringify(implementation("first"))}\n`);
    await writeTextArtifact(setupResult.runDir, verificationPath, `${JSON.stringify(evidence("first"))}\n`);
    await writeTextArtifact(setupResult.runDir, selfReviewPath, `${JSON.stringify(selfReviewReport("first", 1, 1))}\n`);
    await transitionRun(setupResult.runDir, "implementing", { actor: "test", payload: { work_item_id: "first" } });
    await transitionRun(setupResult.runDir, "verifying", { actor: "test", payload: { work_item_id: "first", pass: 1 } });
    await updateManifestV2(setupResult.runDir, {
      current_work_item_id: "first",
      work_item_progress: { first: { status: "in_progress", attempts: 1, implementation_path: reportPath, verification_path: verificationPath, mutation_kind: "initial", self_review_pass: 1, self_review_state: "invoking" } },
    });
    let selfReviewCalls = 0;
    let verificationCalls = 0;
    const result = await runLocalWorkflow({
      runDir: setupResult.runDir,
      worktreePath: setupResult.worktree,
      intake: { ...intake, repo_root: setupResult.root },
      plan: { ...plan, work_items: [item("first")] },
      codex: {} as never,
      config,
      dependencies: {
        hands: async () => { throw new Error("mutation must not repeat"); },
        verification: async (input) => { verificationCalls += 1; return evidenceForInput(input); },
        selfReview: async () => { selfReviewCalls += 1; throw new Error("completed report must not repeat"); },
        diff: async () => "diff",
        verifier: async (input) => {
          const value = review("replan_required", input.workItem.id, input.attempt, false);
          return { review: value, reviewPath: await persistReview(input.runDir, "reviews/first/attempt-1.json", value), invocation: {} as never };
        },
        gitSnapshot: cleanSnapshot,
      },
    });
    expect(result.status).toBe("human_action_required");
    expect(selfReviewCalls).toBe(0);
    expect(verificationCalls).toBe(0);
    expect((await readManifestV2(setupResult.runDir)).work_item_progress.first).toMatchObject({ self_review_pass: 1, self_review_state: "invoking" });
  });

  it("resumes the primary blocked self-review claim for an interrupted invoking pass", async () => {
    const config = qualityConfig(1);
    const setupResult = await setup(config.retry_policy.quality_gate); root = setupResult.root;
    const reportPath = "implementation/first/attempt-1.json";
    const verificationValue = evidence("first:quality-gate:1:baseline");
    const verificationPath = verificationValue.evidence_path;
    await writeTextArtifact(setupResult.runDir, reportPath, `${JSON.stringify(implementation("first"))}\n`);
    await persistEvidenceBundle(setupResult.runDir, verificationValue);
    await transitionRun(setupResult.runDir, "implementing", { actor: "test", payload: { work_item_id: "first" } });
    await transitionRun(setupResult.runDir, "verifying", { actor: "test", payload: { work_item_id: "first", pass: 1 } });
    await updateManifestV2(setupResult.runDir, {
      current_work_item_id: "first",
      work_item_progress: { first: { status: "in_progress", attempts: 1, implementation_path: reportPath, verification_path: verificationPath, mutation_kind: "initial", self_review_pass: 1, self_review_state: "invoking" } },
    });
    let resumeBlockedClaim: boolean | undefined;
    const result = await runLocalWorkflow({
      runDir: setupResult.runDir,
      worktreePath: setupResult.worktree,
      intake: { ...intake, repo_root: setupResult.root },
      plan: { ...plan, work_items: [item("first")] },
      codex: {} as never,
      config,
      dependencies: {
        hands: async () => { throw new Error("mutation must not repeat"); },
        verification: async (input) => evidenceForInput(input),
        selfReview: async (input) => {
          resumeBlockedClaim = input.resumeBlockedClaim;
          const report = selfReviewReport("first", 1, 1);
          return { report, reportPath: "self-review/first/attempt-1/pass-1.json", invocation: {} as never };
        },
        diff: async () => "diff",
        verifier: async (input) => {
          const value = review("replan_required", input.workItem.id, input.attempt, false);
          return { review: value, reviewPath: await persistReview(input.runDir, "reviews/first/attempt-1.json", value), invocation: {} as never };
        },
        gitSnapshot: cleanSnapshot,
      },
    });

    expect(result.status).toBe("human_action_required");
    expect(resumeBlockedClaim).toBe(true);
  });

  it("uses the snapshotted pass count when repo config changes before resume", async () => {
    const snapshottedConfig = qualityConfig(2);
    const setupResult = await setup(snapshottedConfig.retry_policy.quality_gate); root = setupResult.root;
    const reportPath = "implementation/first/attempt-1.json";
    const verificationPath = "verification/issue-1/attempt-1/mutation/evidence.json";
    const passOnePath = "self-review/first/attempt-1/pass-1.json";
    await writeTextArtifact(setupResult.runDir, reportPath, `${JSON.stringify(implementation("first"))}\n`);
    await persistEvidenceBundle(setupResult.runDir, namespacedEvidence(1, 1, "mutation"));
    await writeTextArtifact(setupResult.runDir, passOnePath, `${JSON.stringify(selfReviewReport("first", 1, 1, false))}\n`);
    await transitionRun(setupResult.runDir, "implementing", { actor: "test", payload: { work_item_id: "first" } });
    await transitionRun(setupResult.runDir, "verifying", { actor: "test", payload: { work_item_id: "first", pass: 1 } });
    await updateManifestV2(setupResult.runDir, {
      current_work_item_id: "first",
      work_item_progress: { first: { status: "in_progress", attempts: 1, implementation_path: reportPath, verification_path: verificationPath, mutation_kind: "initial", self_review_pass: 1, self_review_state: "complete", self_review_paths: { "1": passOnePath } } },
    });
    const changedConfig = qualityConfig(0);
    changedConfig.retry_policy.quality_gate!.max_attempts_per_reviewer_action = 3;
    const selfReviewPasses: number[] = [];
    const result = await runLocalWorkflow({
      runDir: setupResult.runDir,
      worktreePath: setupResult.worktree,
      intake: { ...intake, repo_root: setupResult.root },
      plan: { ...plan, work_items: [item("first")] },
      codex: {} as never,
      config: changedConfig,
      dependencies: {
        hands: async () => { throw new Error("persisted mutation must not repeat"); },
        verification: async () => { throw new Error("unchanged completed evidence must be reused"); },
        selfReview: async (input) => {
          selfReviewPasses.push(input.pass);
          const report = selfReviewReport("first", 1, input.pass, false);
          const path = `self-review/first/attempt-1/pass-${input.pass}.json`;
          await writeTextArtifact(input.runDir, path, `${JSON.stringify(report)}\n`);
          return { report, reportPath: path, invocation: {} as never };
        },
        diff: async () => "diff",
        verifier: async (input) => {
          const value = review("replan_required", input.workItem.id, input.attempt, false);
          return { review: value, reviewPath: await persistReview(input.runDir, "reviews/first/attempt-1.json", value), invocation: {} as never };
        },
        gitSnapshot: cleanSnapshot,
      },
    });
    expect(result.status).toBe("human_action_required");
    expect(selfReviewPasses).toEqual([]);
    expect((await readManifestV2(setupResult.runDir)).quality_gate_policy?.hands_self_review_passes).toBe(2);
    expect((await readManifestV2(setupResult.runDir)).quality_gate_policy?.max_attempts_per_reviewer_action).toBe(2);
  });

  it.each([
    ["self-review provenance", { reportParentAttempt: 9, evidenceIssue: 1 }],
    ["verification provenance", { reportParentAttempt: 1, evidenceIssue: 99 }],
    ["active-action provenance", { reportParentAttempt: 1, evidenceIssue: 1, activeActionId: "R1-A1" }],
    ["mutation identity", { reportParentAttempt: 1, evidenceIssue: 1, mutationKind: "normal_fix" }],
    ["verification result", { reportParentAttempt: 1, evidenceIssue: 1, corruptResult: true }],
  ] as Array<[string, { reportParentAttempt: number; evidenceIssue: number; activeActionId?: string; mutationKind?: "normal_fix"; corruptResult?: boolean }]>)
  ("blocks corrupt persisted %s before advancement or invocation", async (_label, corruption) => {
    const config = qualityConfig(1);
    const setupResult = await setup(config.retry_policy.quality_gate); root = setupResult.root;
    const reportPath = "implementation/first/attempt-1.json";
    const verificationPath = "verification/issue-1/attempt-1/mutation/evidence.json";
    const selfReviewPath = "self-review/first/attempt-1/pass-1.json";
    await writeTextArtifact(setupResult.runDir, reportPath, `${JSON.stringify(implementation("first"))}\n`);
    await persistEvidenceBundle(setupResult.runDir, namespacedEvidence(corruption.evidenceIssue, 1, "mutation"), corruption.corruptResult);
    await writeTextArtifact(setupResult.runDir, selfReviewPath, `${JSON.stringify({ ...selfReviewReport("first", corruption.reportParentAttempt, 1, false), active_action_id: corruption.activeActionId ?? null })}\n`);
    await transitionRun(setupResult.runDir, "implementing", { actor: "test", payload: { work_item_id: "first" } });
    await transitionRun(setupResult.runDir, "verifying", { actor: "test", payload: { work_item_id: "first", pass: 1 } });
    await updateManifestV2(setupResult.runDir, {
      current_work_item_id: "first",
      work_item_progress: { first: { status: "in_progress", attempts: 1, implementation_path: reportPath, verification_path: verificationPath, mutation_kind: corruption.mutationKind ?? "initial", self_review_pass: 1, self_review_state: "invoking" } },
    });
    let externalCalls = 0;
    const result = await runLocalWorkflow({
      runDir: setupResult.runDir,
      worktreePath: setupResult.worktree,
      intake: { ...intake, repo_root: setupResult.root },
      plan: { ...plan, work_items: [item("first")] },
      codex: {} as never,
      config,
      dependencies: {
        hands: async () => { externalCalls += 1; throw new Error("must not run"); },
        verification: async () => { externalCalls += 1; throw new Error("must not run"); },
        selfReview: async () => { externalCalls += 1; throw new Error("must not run"); },
        verifier: async () => { externalCalls += 1; throw new Error("must not run"); },
        diff: async () => "diff",
        gitSnapshot: cleanSnapshot,
      },
    });
    expect(result.status).toBe("human_action_required");
    expect(result.blocker).toMatch(/persisted|provenance|quality gate/i);
    expect(externalCalls).toBe(0);
    expect((await readManifestV2(setupResult.runDir)).work_item_progress.first).toMatchObject({ self_review_pass: 1, self_review_state: "invoking" });
  });

  it.each(["report", "report_mutation", "result", "evidence", "mutation"] as const)(
    "validates the complete quality chain before resuming work-item verifier_review with corrupt %s",
    async (corrupt) => {
      const config = qualityConfig(2);
      const setupResult = await setup(config.retry_policy.quality_gate); root = setupResult.root;
      const implementationPath = "implementation/first/attempt-1.json";
      await writeTextArtifact(setupResult.runDir, implementationPath, `${JSON.stringify(implementation("first"))}\n`);
      const quality = await persistCompletedQualityGate({ runDir: setupResult.runDir, workItemId: "first", issueNumber: 1, attempt: 1, corrupt: corrupt === "mutation" ? undefined : corrupt });
      await updateManifestV2(setupResult.runDir, {
        stage: "verifier_review", current_work_item_id: "first",
        work_item_progress: { first: {
          status: "in_progress", attempts: 1, implementation_path: implementationPath,
          verification_path: quality.finalPath, mutation_kind: corrupt === "mutation" ? "normal_fix" : "initial", self_review_pass: 2, self_review_state: "complete",
          mutation_verification_path: quality.mutationPath, self_review_paths: quality.reportPaths,
          self_review_verification_paths: quality.selfReviewEvidencePaths,
        } },
      });
      let externalCalls = 0;
      const result = await runLocalWorkflow({
        runDir: setupResult.runDir, worktreePath: setupResult.worktree, intake: { ...intake, repo_root: setupResult.root },
        plan: { ...plan, work_items: [item("first")] }, codex: {} as never, config,
        dependencies: {
          hands: async () => { externalCalls += 1; throw new Error("must not run"); },
          verification: async () => { externalCalls += 1; throw new Error("must not run"); },
          selfReview: async () => { externalCalls += 1; throw new Error("must not run"); },
          verifier: async () => { externalCalls += 1; throw new Error("must not run"); },
          gitSnapshot: cleanSnapshot,
        },
      });
      expect(result.status).toBe("human_action_required");
      expect(result.blocker).toMatch(/persisted|quality|provenance|invalid/i);
      expect(externalCalls).toBe(0);
    },
  );

  it.each(["result", "mutation"] as const)("validates the integrated-fix quality chain before resuming final verifier_review with corrupt %s", async (corrupt) => {
    const config = qualityConfig(2);
    const setupResult = await setup(config.retry_policy.quality_gate); root = setupResult.root;
    const featurePath = "implementation/first/attempt-1.json";
    const integratedPath = "implementation/integrated/attempt-2.json";
    await writeTextArtifact(setupResult.runDir, featurePath, `${JSON.stringify(implementation("first"))}\n`);
    await writeTextArtifact(setupResult.runDir, integratedPath, `${JSON.stringify(implementation("integrated"))}\n`);
    const quality = await persistCompletedQualityGate({ runDir: setupResult.runDir, workItemId: "integrated", issueNumber: 2, attempt: 2, corrupt: corrupt === "result" ? "result" : undefined });
    await updateManifestV2(setupResult.runDir, {
      stage: "verifier_review", current_work_item_id: "integrated",
      work_item_progress: {
        first: { status: "complete", attempts: 1, implementation_path: featurePath },
        integrated: {
          status: "in_progress", attempts: 2, implementation_path: integratedPath,
          verification_path: quality.finalPath, mutation_kind: corrupt === "mutation" ? "initial" : "normal_fix", self_review_pass: 2, self_review_state: "complete",
          mutation_verification_path: quality.mutationPath, self_review_paths: quality.reportPaths,
          self_review_verification_paths: quality.selfReviewEvidencePaths,
        },
      },
    });
    let externalCalls = 0;
    const result = await runLocalWorkflow({
      runDir: setupResult.runDir, worktreePath: setupResult.worktree, intake: { ...intake, repo_root: setupResult.root },
      plan: { ...plan, work_items: [item("first")] }, codex: {} as never, config,
      dependencies: {
        hands: async () => { externalCalls += 1; throw new Error("must not run"); },
        verification: async () => { externalCalls += 1; throw new Error("must not run"); },
        selfReview: async () => { externalCalls += 1; throw new Error("must not run"); },
        verifier: async () => { externalCalls += 1; throw new Error("must not run"); },
        gitSnapshot: cleanSnapshot,
      },
    });
    expect(result.status).toBe("human_action_required");
    expect(result.blocker).toMatch(/persisted|quality|provenance|invalid/i);
    expect(externalCalls).toBe(0);
  });

  it("resumes the same self-review pass with the validated backup profile after primary usage exhaustion", async () => {
    const config = qualityConfig(1);
    config.retry_policy.backup = {
      fallback_on_primary_usage_limit: true,
      max_quality_recovery_attempts: 1,
      profile: { model: "backup-hands", reasoning_effort: "medium" },
    };
    const setupResult = await setup(config.retry_policy.quality_gate, config.retry_policy.backup); root = setupResult.root;
    const profiles: string[] = [];
    const result = await runLocalWorkflow({
      runDir: setupResult.runDir,
      worktreePath: setupResult.worktree,
      intake: { ...intake, repo_root: setupResult.root },
      plan: { ...plan, work_items: [item("first")] },
      codex: {} as never,
      config,
      dependencies: {
        hands: async () => ({ implementation: implementation("first"), reportPath: "implementation/first/attempt-1.json", invocation: {} as never }),
        verification: async (input) => evidenceForInput(input),
        selfReview: async (input) => {
          profiles.push(input.profile?.model ?? "primary");
          if (input.profile?.model !== "backup-hands") {
            throw new CodexInvocationError("usage exhausted", { command: "codex", args: [], exitCode: 1, stdout: JSON.stringify({ error: { code: "usage_limit_reached" } }), stderr: "", failed: true, timedOut: false });
          }
          const report = selfReviewReport("first", 1, 1, false);
          await writeTextArtifact(input.runDir, "self-review/first/attempt-1/pass-1.json", `${JSON.stringify(report)}\n`);
          return { report, reportPath: "self-review/first/attempt-1/pass-1.json", invocation: {} as never };
        },
        diff: async () => "diff",
        modelCatalog: async () => ({ models: [{ slug: "backup-hands", supported_reasoning_levels: [{ effort: "medium" }] }] }),
        verifier: async (input) => {
          const value = review("replan_required", input.workItem.id, input.attempt, false);
          return { review: value, reviewPath: await persistReview(input.runDir, "reviews/first/attempt-1.json", value), invocation: {} as never };
        },
        gitSnapshot: cleanSnapshot,
      },
    });
    expect(result.status).toBe("human_action_required");
    expect(profiles).toEqual(["hands", "backup-hands"]);
    const manifest = await readManifestV2(setupResult.runDir);
    expect(manifest.active_hands_profile).toBe("backup");
    expect(manifest.work_item_progress.first?.self_review_paths?.["1"]).toBe("self-review/first/attempt-1/pass-1.json");
  });

  it("resumes a persisted backup claim transfer after activation-event interruption using the snapshotted route", async () => {
    const config = qualityConfig(1);
    config.retry_policy.backup = {
      fallback_on_primary_usage_limit: true,
      max_quality_recovery_attempts: 1,
      profile: { model: "backup-hands", reasoning_effort: "medium" },
    };
    const setupResult = await setup(config.retry_policy.quality_gate, config.retry_policy.backup); root = setupResult.root;
    const implementationPath = "implementation/first/attempt-1.json";
    const implementationValue = implementation("first");
    let codexCalls = 0;
    const codex: CodexAdapter = {
      invoke: async () => {
        codexCalls += 1;
        if (codexCalls === 1) {
          await rm(join(setupResult.runDir, "events.jsonl"), { force: true });
          await mkdir(join(setupResult.runDir, "events.jsonl"));
          throw new CodexInvocationError("usage exhausted", { command: "codex", args: [], exitCode: 1, stdout: JSON.stringify({ error: { code: "usage_limit_reached" } }), stderr: "", failed: true, timedOut: false });
        }
        const report = selfReviewReport("first", 1, 1, false);
        return { text: JSON.stringify(report), parsed: report, exitCode: 0, promptPath: "prompt", stdoutPath: "stdout", stderrPath: "stderr" , ...codexMetrics };
      },
    };
    const verification = async (input: RunVerificationInput) => {
      const value = evidenceForInput(input);
      await persistEvidenceBundle(input.runDir, value);
      return value;
    };
    const first = await runLocalWorkflow({
      runDir: setupResult.runDir, worktreePath: setupResult.worktree, intake: { ...intake, repo_root: setupResult.root },
      plan: { ...plan, work_items: [item("first")] }, codex, config,
      dependencies: {
        hands: async () => { await writeTextArtifact(setupResult.runDir, implementationPath, `${JSON.stringify(implementationValue)}\n`); return { implementation: implementationValue, reportPath: implementationPath, invocation: {} as never }; },
        verification,
        diff: async () => "diff",
        modelCatalog: async () => ({ models: [{ slug: "backup-hands", supported_reasoning_levels: [{ effort: "medium" }] }] }),
        gitSnapshot: cleanSnapshot,
      },
    });
    expect(first.status).toBe("human_action_required");
    expect((await readManifestV2(setupResult.runDir)).active_hands_profile).toBe("backup");
    expect((await readManifestV2(setupResult.runDir)).work_item_progress.first).toMatchObject({
      self_review_pass: 1,
      self_review_state: "invoking",
      backup_claim_transfer_pending: true,
    });

    await rm(join(setupResult.runDir, "events.jsonl"), { recursive: true, force: true });
    await writeFile(join(setupResult.runDir, "events.jsonl"), "", "utf8");
    const changedConfig = qualityConfig(1);
    const resumed = await runLocalWorkflow({
      runDir: setupResult.runDir, worktreePath: setupResult.worktree, intake: { ...intake, repo_root: setupResult.root },
      plan: { ...plan, work_items: [item("first")] }, codex, config: changedConfig,
      dependencies: {
        hands: async () => { throw new Error("persisted mutation must not repeat"); },
        verification: async () => { throw new Error("persisted evidence must be reused"); },
        diff: async () => "diff",
        modelCatalog: async () => { throw new Error("snapshotted catalog route must be reused"); },
        verifier: async (input) => { const value = review("replan_required", input.workItem.id, input.attempt, false); return { review: value, reviewPath: await persistReview(input.runDir, "reviews/first/attempt-1.json", value), invocation: {} as never }; },
        gitSnapshot: cleanSnapshot,
      },
    });
    expect(resumed.status).toBe("human_action_required");
    expect(codexCalls).toBe(2);
    const manifest = await readManifestV2(setupResult.runDir);
    expect(manifest.hands_backup_policy?.profile).toEqual({ model: "backup-hands", reasoning_effort: "medium" });
    expect(manifest.hands_backup_catalog?.slug).toBe("backup-hands");
    expect(manifest.work_item_progress.first).toMatchObject({ self_review_pass: 1, backup_claim_transfer_pending: false, self_review_claim_owner: "backup" });
    await expect(readFile(join(setupResult.runDir, "self-review/first/attempt-1/pass-1.claim.json.primary-blocked"), "utf8")).resolves.toContain('"state":"blocked"');
  });

  it("wraps normal-fix and quality-recovery mutations exactly once", async () => {
    const config = qualityConfig(1);
    config.retry_policy.max_hands_fix_attempts = 2;
    const setupResult = await setup(config.retry_policy.quality_gate); root = setupResult.root;
    const handsKinds: string[] = [];
    const selfReviews: string[] = [];
    const verificationNamespaces: Array<string | undefined> = [];
    const result = await runLocalWorkflow({
      runDir: setupResult.runDir,
      worktreePath: setupResult.worktree,
      intake: { ...intake, repo_root: setupResult.root },
      plan: { ...plan, work_items: [item("first")] },
      codex: {} as never,
      config,
      dependencies: {
        hands: async (input) => {
          handsKinds.push(`${input.attempt}:${input.attemptKind}`);
          const reportPath = `implementation/first/attempt-${input.attempt}.json`;
          return { implementation: implementation("first"), reportPath, invocation: {} as never };
        },
        verification: async (input) => {
          verificationNamespaces.push(input.identity?.work_item_id);
          return evidenceForInput(input);
        },
        selfReview: async (input) => {
          selfReviews.push(`${input.workItem.id}:${input.parentAttempt}:${input.pass}`);
          const report = selfReviewReport(input.workItem.id, input.parentAttempt, input.pass, false, input.mutationKind);
          const path = `self-review/${input.workItem.id}/attempt-${input.parentAttempt}/pass-${input.pass}.json`;
          await writeTextArtifact(input.runDir, path, `${JSON.stringify(report)}\n`);
          return { report, reportPath: path, invocation: {} as never };
        },
        diff: async () => "diff",
        verifier: async (input) => {
          const decision = input.final ? "replan_required" : input.attempt! < 3 ? "request_changes" : "replan_required";
          const value = review(decision, input.workItem.id, input.attempt, input.final);
          const path = input.final ? `reviews/integrated/final-attempt-${input.attempt}.json` : `reviews/first/attempt-${input.attempt}.json`;
          return { review: value, reviewPath: await persistReview(input.runDir, path, value), invocation: {} as never };
        },
        gitSnapshot: cleanSnapshot,
      },
    });
    expect(result.status).toBe("human_action_required");
    expect(handsKinds).toEqual(["1:initial", "1000101:primary_fix"]);
    expect(selfReviews).toEqual(["first:1:1", "first:1000101:1"]);
    expect(verificationNamespaces.filter(Boolean)).toEqual([
      "first:quality-gate:1:baseline",
      "first",
      expect.stringMatching(/^first:quality-gate:1000101:baseline:authority-[a-f0-9]{16}$/),
    ]);
    const manifest = await readManifestV2(setupResult.runDir);
    expect(manifest.work_item_progress.first?.implementation_path).toBe("implementation/first/attempt-1000101.json");
    expect(Object.values(manifest.work_item_progress.first?.self_review_paths ?? {}).every((path) => !path.startsWith("/"))).toBe(true);
    expect(manifest.final_artifact_paths.every((path) => !path.startsWith("/"))).toBe(true);
  });

  it("wraps an integrated-final fix exactly once before its next full review", async () => {
    const config = qualityConfig(1);
    const setupResult = await setup(config.retry_policy.quality_gate); root = setupResult.root;
    let finalReviews = 0;
    const selfReviews: string[] = [];
    const order: string[] = [];
    const result = await runLocalWorkflow({
      runDir: setupResult.runDir,
      worktreePath: setupResult.worktree,
      intake: { ...intake, repo_root: setupResult.root },
      plan: { ...plan, work_items: [item("first")] },
      codex: {} as never,
      config,
      dependencies: {
        hands: async (input) => { order.push(`hands:${input.workItem.id}:${input.attempt}`); return { implementation: implementation(input.workItem.id), reportPath: `implementation/${input.workItem.id}/attempt-${input.attempt}.json`, invocation: {} as never }; },
        verification: async (input) => { order.push(`verify:${input.identity?.work_item_id}:${input.attempt}`); return evidenceForInput(input); },
        selfReview: async (input) => {
          const marker = `${input.workItem.id}:${input.parentAttempt}:${input.pass}`;
          selfReviews.push(marker); order.push(`self-review:${marker}`);
          const report = selfReviewReport(input.workItem.id, input.parentAttempt, input.pass, false, input.mutationKind);
          const path = `self-review/${input.workItem.id}/attempt-${input.parentAttempt}/pass-${input.pass}.json`;
          await writeTextArtifact(input.runDir, path, `${JSON.stringify(report)}\n`);
          return { report, reportPath: path, invocation: {} as never };
        },
        diff: async () => "diff",
        verifier: async (input) => {
          if (input.final) finalReviews += 1;
          order.push(`verifier:${input.workItem.id}:${input.attempt}`);
          const value = review(input.final && finalReviews === 1 ? "request_changes" : "approve", input.workItem.id, input.attempt, input.final);
          const path = input.final ? `reviews/integrated/final-attempt-${input.attempt}.json` : `reviews/first/attempt-${input.attempt}.json`;
          return { review: value, reviewPath: await persistReview(input.runDir, path, value), invocation: {} as never };
        },
        commit: async () => "no-op",
        gitSnapshot: cleanSnapshot,
      },
    });
    expect(result.status).toBe("human_action_required");
    expect(selfReviews).toEqual(["first:1:1"]);
    expect(order).not.toContain("verifier:integrated:2");
  });

  it.each([
    { label: "primary before charge", profileKind: "primary", checkpoint: "after_action_progress", charged: false },
    { label: "backup before charge", profileKind: "backup", checkpoint: "after_action_progress", charged: false },
    { label: "primary after charge", profileKind: "primary", checkpoint: "after_action_reservation_charge", charged: true },
  ] as const)(
    "recovers a packet mutation with truthful provenance: $label",
    async ({ profileKind, checkpoint: crashCheckpoint, charged }) => {
      const config = qualityConfig(0);
      config.retry_policy.backup = {
        profile: { model: "backup-hands", reasoning_effort: "medium" },
        fallback_on_primary_usage_limit: true,
        max_quality_recovery_attempts: 1,
      };
      const setupResult = await setup(config.retry_policy.quality_gate, config.retry_policy.backup, true);
      root = setupResult.root;
      const firstItem = item("first");
      const policyPlan = {
        ...plan,
        work_items: [{
          ...firstItem,
          file_contract: [
            ...firstItem.file_contract,
            { path: "README.md", permission: "modify" as const, targets: ["pre-existing project context"] },
          ],
          change_units: [
            ...firstItem.change_units,
            {
              id: "first-CH-03",
              path: "README.md",
              target: "pre-existing project context",
              operation: "modify" as const,
              requirements: ["Preserve the already completed project context."],
            },
          ],
          completion_contract: {
            ...firstItem.completion_contract,
            expected_changed_files: [...firstItem.completion_contract.expected_changed_files, "README.md"],
          },
        }],
      };
      const recorded = await recordPlan(setupResult.runDir, `${JSON.stringify(policyPlan)}\n`);
      await approvePlanRevision(setupResult.runDir, recorded.revision, { actor: "test" });
      if (profileKind === "backup") {
        await updateManifestV2(setupResult.runDir, {
          active_hands_profile: "backup",
          backup_activation_reason: "primary_usage_limit",
          hands_backup_catalog: { slug: "backup-hands", reasoning_effort: "medium", supported_reasoning_efforts: ["medium"] },
        });
      }

      let fullReviews = 0;
      let packetHandsCalls = 0;
      let invokedPacketModel: string | undefined;
      let interruptMutation = true;
      const verificationNamespaces: string[] = [];
      const mutationVerificationResumeFlags: Array<boolean | undefined> = [];
      const dependencies: LocalRuntimeDependencies = {
        hands: async (input) => {
          const value = implementation(input.workItem.id);
          const reportPath = `implementation/${input.workItem.id}/attempt-${input.attempt}.json`;
          await writeTextArtifact(input.runDir, reportPath, `${JSON.stringify(value)}\n`);
          return { implementation: value, reportPath, invocation: {} as never };
        },
        handsFixPacket: async (input) => {
          packetHandsCalls += 1;
          return runHandsFixPacket({
            ...input,
            codex: {
              invoke: async (invocationInput) => {
                invokedPacketModel = invocationInput.model;
                const value = {
                  schema_version: 1 as const,
                  packet_id: input.packet.provenance.packet_id,
                  packet_sha256: hashReviewFixPacket(input.packet),
                  action_attempt: input.actionAttempt,
                  status: "implemented" as const,
                  change_units: [{ change_unit_id: "FIX-1", status: "completed" as const, changed_files: ["src/first.ts"], summary: "Completed first." }],
                  changed_files: ["src/first.ts"], commands_attempted: [], unresolved_requirements: [], blocker: null,
                };
                return { text: JSON.stringify(value), parsed: value, exitCode: 0, promptPath: "prompt", stdoutPath: "stdout", stderrPath: "stderr", ...codexMetrics };
              },
            },
          });
        },
        verification: async (input) => {
          verificationNamespaces.push(input.identity?.work_item_id ?? "unknown");
          if ((input.attempt ?? 0) >= 1_000_000) {
            mutationVerificationResumeFlags.push(input.resumeExistingNamespace);
          }
          const value = evidenceForInput(input);
          await persistEvidenceBundle(input.runDir, value);
          return value;
        },
        verifier: async (input) => {
          const requested = !input.final && fullReviews++ === 0;
          const requestedReview = packetReview(input.workItem.id, input.attempt);
          requestedReview.findings[0]!.re_verification = [["npm", "ci"]];
          const value = requested
            ? requestedReview
            : {
                ...review("approve", input.workItem.id, input.attempt, Boolean(input.final)),
                failure_class: "none" as const, blocker: null, blocker_code: null,
                evidence_reviewed: [verifierEvidenceRef(input)],
              };
          const path = input.final
            ? `reviews/integrated/final-attempt-${input.attempt}.json`
            : `reviews/${input.workItem.id}/attempt-${input.attempt}.json`;
          return { review: value, reviewPath: await persistReview(input.runDir, path, value), invocation: {} as never };
        },
        packetVerifier: async (input) => {
          const reviewPath = `reviews/fix-packets/${Buffer.from(input.packet.provenance.packet_id).toString("base64url")}/attempts/${input.actionAttempt}/focused-resolution.json`;
          const value = {
            packet_id: input.packet.provenance.packet_id,
            packet_sha256: hashReviewFixPacket(input.packet),
            action_attempt: input.actionAttempt,
            decision: "resolved" as const,
            condition_results: [{ success_condition_id: "SC-1", status: "satisfied" as const, evidence_refs: [input.verificationEvidence.evidence_path], remaining_problem: null }],
            required_next_fix: null,
            blocker: null,
          };
          await writeTextArtifact(input.runDir, reviewPath, `${JSON.stringify(value)}\n`);
          return { review: value, reviewPath, invocation: {} as never };
        },
        changedFiles: async () => fullReviews === 0
          ? ["src/first.ts"]
          : ["README.md", "src/first.ts"],
        diff: async () => "diff",
        hasWorktreeChanges: async () => false,
        gitSnapshot: cleanSnapshot,
        afterCheckpoint: async (checkpoint) => {
          if (interruptMutation && checkpoint === (crashCheckpoint as typeof checkpoint)) {
            interruptMutation = false;
            throw new Error(`crash at ${crashCheckpoint}`);
          }
        },
      };
      const workflowInput = {
        runDir: setupResult.runDir,
        worktreePath: join(setupResult.root, "worktree"),
        intake: { ...intake, repo_root: setupResult.root },
        plan: policyPlan,
        codex: {} as never,
        config,
        dependencies,
      } as RunLocalWorkflowInput;

      const interrupted = await runLocalWorkflow(workflowInput);
      expect(interrupted.status).toBe("human_action_required");
      const interruptedManifest = await readManifestV2(setupResult.runDir);
      expect(interruptedManifest.work_item_progress.first, interrupted.blocker).toMatchObject({
        mutation_kind: "reviewer_action",
        self_review_pass: 0,
        self_review_state: "pending",
      });
      expect(interruptedManifest.work_item_progress.first?.fix_reservation_id)
        .toBe(charged ? undefined : "R1-A1:attempt-1");
      expect(interruptedManifest.work_item_progress.first).not.toHaveProperty("verification_path");
      expect(interruptedManifest.review_accounting?.fix_cycles_used).toBe(charged ? 1 : 0);
      const verificationCallsBeforeResume = verificationNamespaces.length;

      const resumed = await runLocalWorkflow(workflowInput);
      expect(resumed.status, resumed.blocker).toBe("local_ready");
      const finalManifest = await readManifestV2(setupResult.runDir);
      expect(finalManifest.review_accounting?.fix_cycles_used).toBe(1);
      expect(finalManifest.work_item_progress.first?.fix_reservation_id).toBeUndefined();
      expect(packetHandsCalls).toBe(1);
      expect(invokedPacketModel).toBe(profileKind === "backup" ? "backup-hands" : "hands");
      expect(verificationNamespaces.length).toBeGreaterThan(verificationCallsBeforeResume);
      expect(mutationVerificationResumeFlags).toContain(true);

      const invocationRoots = await readdir(join(setupResult.runDir, "reviews/action-invocations"));
      expect(invocationRoots).toHaveLength(1);
      const completion = JSON.parse(await readFile(join(setupResult.runDir, "reviews/action-invocations", invocationRoots[0]!, "completion.json"), "utf8"));
      expect(completion.started_profile).toEqual({
        kind: profileKind,
        model: profileKind === "backup" ? "backup-hands" : "hands",
        reasoning_effort: "medium",
      });
      expect(completion.completed_profile).toEqual(completion.started_profile);
    },
  );
});
