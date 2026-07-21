import { mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendRunEvent, approvePlanRevision, consumeReadyLegacyGithubRestore, createRunLedgerV2, readManifestV2, recordPlan, recordTerminalDisposition, transitionRun, updateManifestV2, writeTextArtifact } from "../../src/core/ledger.js";
import { defaultConfig } from "../../src/core/config.js";
import { initialDiscoveryState } from "../../src/core/discovery.js";
import { approveDiscoveryBrief, recordDiscoveryBrief, recordDiscoveryReadiness } from "../../src/core/discovery-ledger.js";
import { runCommand } from "../../src/core/executor.js";
import { convergenceReportSchema, reviewCycleStateSchema } from "../../src/core/schema.js";
import type { AssuranceAssessment, BrainPlan, HandsBackupPolicy, HandsSelfReviewReport, ImplementationResult, ResolvedRunIntake, ReviewLimitAction, RunManifestV2, VerificationEvidence, VerificationIdentity, VerifierReview, WorkItem } from "../../src/core/types.js";
import { formatIssueBody, formatParentIssueBody, ISSUE_LABELS, PARENT_ISSUE_LABELS, reconcileManagedIssueBody, type GitHubAdapter, type OpenPullRequestInput, type OpenIntegratedPullRequestInput, type GitHubPullRequestReference, type GitHubIssueMarker, type GitHubIssueMarkerInput, type GitHubIssueObservation, type GitHubIssueReference, type GitHubIssueStateReference, type GitHubParentIssueMarker, type GitHubParentIssueMarkerInput } from "../../src/adapters/github.js";
import type { GithubRuntimeDependencies } from "../../src/workflow/runtime.js";
import { publishGithubWorkflowStatus, resolveRunStatusIssueNumber, runGithubWorkflow as runGithubWorkflowRuntime } from "../../src/workflow/runtime.js";
import { formatWorkItemIssueTitle } from "../../src/core/issue-naming.js";
import { executionSpec } from "../fixtures/execution-spec.js";
import { openProgressReporter, readProgressEvents } from "../../src/progress/log.js";
import * as evidenceIndexWorkflow from "../../src/workflow/evidence-index.js";
import { approvePreparedReplanRevision } from "../../src/workflow/replan.js";
import { createLegacyRunLedgerV2 } from "../fixtures/legacy-run.js";
import { resolvedRunConfigurationSchema, serializeRunConfiguration } from "../../src/core/run-configuration.js";
import { serializePersistedPlan } from "../../src/core/execution-spec.js";
import { expectedClosingIssueNumbers, reconcileClosingLinksBlock } from "../../src/github/issue-lifecycle.js";
import { readIssueLifecycleCheckpoint } from "../../src/github/issue-reconciliation.js";
import type { RunVerificationInput } from "../../src/verification/runner.js";
import { recordRemoteSynchronization } from "../../src/workflow/remote-synchronization.js";
import { persistFinalDeliveryAssessmentAtBoundary } from "../../src/workflow/assurance.js";
import * as ledgerModule from "../../src/core/ledger.js";
import { createTaskLineage, deriveLegacyTaskLineageId, readTaskLineage, withTaskLineageTransaction } from "../../src/core/task-lineage.js";
import { planIssueSyncPreview, writeGithubEffectPreview } from "../../src/github/effect-plan.js";
import { readOperatorStatus } from "../../src/workflow/status.js";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const executionViabilityMock = vi.hoisted(() => vi.fn());
vi.mock("../../src/workflow/execution-viability.js", () => ({
  assertGithubExecutionViable: executionViabilityMock,
}));

beforeEach(() => {
  executionViabilityMock.mockReset().mockImplementation(async (input: { plan: BrainPlan }) => ({
    repository: { host: "github.com", name_with_owner: "acme/repo", actor: "operator" },
    report: {},
    plan: input.plan,
  }));
});
import type { VerifyWorkItemInput } from "../../src/workflow/verifier.js";
const codexMetrics = { usage: null, durationMs: 0, processStarted: false, turnStarted: false, structuredTerminalError: false } as const;

async function enableBoundedProtocol(runDir: string): Promise<void> {
  const manifest = await readManifestV2(runDir);
  if (manifest.workflow_protocol === "bounded-context-v1") return;
  const policy = defaultConfig().resource_budget;
  await mkdir(join(runDir, "budgets", "claims"), { recursive: true });
  await mkdir(join(runDir, "budgets", "completions"), { recursive: true });
  await writeFile(join(runDir, "budgets", "policy.json"), `${JSON.stringify(policy, null, 2)}\n`);
  await updateManifestV2(runDir, {
    workflow_protocol: "bounded-context-v1",
    discovery: initialDiscoveryState(),
    resource_budget_policy: policy,
  });
}
import { recordAndApprovePinnedInitialPlan, recordApprovedDiscoveryForPlan } from "../fixtures/pinned-plan.js";

const intake: ResolvedRunIntake = {
  task: "Ship feature", repo_root: "/tmp/repo", mode: "github", research: false, reflection: false,
  models: { brain: "brain", hands: "hands", verifier: "verifier" }, resolved_models: { brain: "brain", hands: "hands", verifier: "verifier" },
  roles: { brain: { model: "brain", reasoning_effort: "high", sandbox: "read-only" }, hands: { model: "hands", reasoning_effort: "medium", sandbox: "workspace-write" }, verifier: { model: "verifier", reasoning_effort: "high", sandbox: "read-only" } },
};
const qualityBackup: HandsBackupPolicy = {
  fallback_on_primary_usage_limit: true,
  max_quality_recovery_attempts: 1,
  profile: { model: "backup-hands", reasoning_effort: "medium" },
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

function item(id: string, dependencies: string[] = []): WorkItem {
  return executionSpec(id, dependencies);
}

async function snapshotTree(rootPath: string): Promise<Array<[string, string]>> {
  const entries: Array<[string, string]> = [];
  const visit = async (directory: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        entries.push([relativePath, "directory"]);
        await visit(absolutePath, relativePath);
      } else {
        entries.push([relativePath, `file:${(await readFile(absolutePath)).toString("base64")}`]);
      }
    }
  };
  await visit(rootPath, "");
  return entries.sort(([left], [right]) => left.localeCompare(right));
}

const plan: BrainPlan = { summary: "Ship feature", assumptions: [], research: [], research_sources: ["repo"], architecture: "simple", risks: [], work_items: [item("feature")], integration_verification: [["npm", "test", "--", "integration.test.ts"]] };

async function approveBoundedPlan(runDir: string, workflowPlan: BrainPlan = plan) {
  const manifest = await readManifestV2(runDir);
  if (manifest.workflow_protocol === "bounded-context-v1" && manifest.approved_revision !== null) {
    const approved = manifest.plan_revisions[String(manifest.approved_revision)];
    if (!approved) throw new Error("Bounded fixture approved revision is missing");
    return approved;
  }
  await updateManifestV2(runDir, { stage: "brain_discovery" });
  const brief = {
    revision: 1,
    goal: intake.task,
    problem: "GitHub runtime fixture requires bounded workflow governance.",
    constraints: [],
    decisions: [],
    assumptions: [],
    repository_evidence: ["tests/workflow/runtime-github.test.ts"],
    success_criteria: ["Run the bounded GitHub workflow"],
    accepted_risks: [],
    out_of_scope: [],
    selected_approach_id: null,
    selected_approach_rationale: null,
  };
  await recordDiscoveryReadiness(runDir, {
    outcome: "no_discovery_needed",
    rationale: "Runtime fixture provides the approved plan directly.",
    repository_evidence: ["tests/workflow/runtime-github.test.ts"],
    approaches: [],
    alternatives_omitted_reason: "Fixture has one deterministic GitHub path.",
    brief,
  });
  await recordDiscoveryBrief(runDir, brief);
  await approveDiscoveryBrief(runDir, 1);
  const discoveryDigest = (await readManifestV2(runDir)).discovery!.approved_brief_sha256!;
  const persistedPlan = {
    ...workflowPlan,
    discovery_brief_revision: 1,
    discovery_brief_sha256: discoveryDigest,
    discovery_decision_coverage: [],
    accepted_risks: [],
    out_of_scope: [],
  };
  const recorded = await recordPlan(runDir, `${JSON.stringify(persistedPlan)}\n`);
  await approvePlanRevision(runDir, recorded.revision, { actor: "test" });
  await updateManifestV2(runDir, { stage: "worktree_setup" });
  return recorded;
}

function evidence(issue: number | undefined, attempt = 1, workItemId = issue === undefined ? "integrated" : "feature"): VerificationEvidence {
  const integrated = issue === undefined;
  const prefix = integrated ? `verification/integrated/attempt-${attempt}` : `verification/issue-${issue}/attempt-${attempt}`;
  return {
    verification_scope: integrated ? "integrated" : "github",
    work_item_id: integrated ? "integrated" : workItemId,
    ...(integrated ? {} : { issue_number: issue }),
    attempt,
    evidence_path: `${prefix}/evidence.json`,
    commands: [{ command: "npm test", argv: ["npm", "test"], exit_code: 0, timed_out: false, error_code: null, error_message: null, signal: null, stdout_path: `${prefix}/out.txt`, stderr_path: `${prefix}/err.txt`, result_path: `${prefix}/result.json` }],
    artifacts: [], artifact_checks: [], browser_evidence: [], created_at: new Date().toISOString(),
  } as VerificationEvidence;
}

async function evidenceForInput(input: { runDir: string; identity?: VerificationIdentity; attempt?: number; commands?: readonly (readonly string[] | string)[] }): Promise<VerificationEvidence> {
  if (!input.identity) throw new Error("test verification input is missing its identity");
  const attempt = input.attempt ?? 1;
  const prefix = `${input.identity.scope === "github" ? `verification/issue-${input.identity.issue_number}` : input.identity.scope === "integrated" ? "verification/integrated" : `verification/local/${Buffer.from(input.identity.work_item_id).toString("base64url")}`}/attempt-${attempt}`;
  const commandInputs = input.commands?.length ? input.commands : [["npm", "test"]];
  const value = {
    verification_scope: input.identity.scope,
    work_item_id: input.identity.work_item_id,
    ...(input.identity.scope === "github" ? { issue_number: input.identity.issue_number } : {}),
    attempt,
    evidence_path: `${prefix}/evidence.json`,
    commands: commandInputs.map((commandInput, index) => {
      const argv = Array.isArray(commandInput) ? [...commandInput] : [commandInput];
      const suffix = commandInputs.length === 1 ? "" : `-${index + 1}`;
      return { command: argv.join(" "), argv, exit_code: 0, timed_out: false, error_code: null, error_message: null, signal: null, stdout_path: `${prefix}/out${suffix}.txt`, stderr_path: `${prefix}/err${suffix}.txt`, result_path: `${prefix}/result${suffix}.json` };
    }),
    artifacts: [], artifact_checks: [], browser_evidence: [], created_at: new Date().toISOString(),
  } as VerificationEvidence;
  for (const command of value.commands) {
    await writeTextArtifact(input.runDir, command.stdout_path, "stdout\n");
    await writeTextArtifact(input.runDir, command.stderr_path, "stderr\n");
    if (command.result_path) await writeTextArtifact(input.runDir, command.result_path, `${JSON.stringify({
      argv: command.argv ?? [], stdout: "stdout\n", stderr: "stderr\n", exit_code: command.exit_code,
      duration_ms: command.duration_ms ?? 0, timed_out: command.timed_out, error_code: command.error_code,
      error_message: command.error_message, signal: command.signal,
    })}\n`);
  }
  await writeTextArtifact(input.runDir, value.evidence_path, `${JSON.stringify(value)}\n`);
  return value;
}

function implementation(id: string): ImplementationResult {
  const changedFile = id === "integrated" || id === "BH_002" ? "src/feature.ts" : `src/${id}.ts`;
  return { work_item_id: id, changed_files: [changedFile], tests_added_or_changed: [], commands_attempted: [], completed_steps: [id], remaining_risks: [] };
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
function qualityConfig() { return defaultConfig(); }
function selfReviewReport(workItemId: string, parentAttempt: number, pass: number, mutationKind: HandsSelfReviewReport["mutation_kind"]): HandsSelfReviewReport { return { work_item_id: workItemId, parent_attempt: parentAttempt, mutation_kind: mutationKind, pass, active_action_id: null, findings: [], fixes_applied: [], changed_files: [], commands_attempted: [], remaining_findings: [], ready_for_resolution_check: true }; }
function approvedReview(attempt: number): VerifierReview { return { work_item_id: "integrated", attempt, final: true, decision: "approve", acceptance_coverage: [], evidence_reviewed: [], findings: [], residual_risks: [] }; }
function headSha(worktree: string): string { return execFileSync("git", ["rev-parse", "HEAD"], { cwd: worktree, encoding: "utf8" }).trim(); }
function review(workItemId: string, attempt: number, final = false): VerifierReview {
  return { work_item_id: workItemId, attempt, final, decision: "approve", acceptance_coverage: [], evidence_reviewed: [], findings: [], residual_risks: [] };
}

class RecordingGithub implements GitHubAdapter {
  readonly created: Array<{ marker?: GitHubIssueMarker; title?: string }> = [];
  readonly prs: OpenIntegratedPullRequestInput[] = [];
  readonly issueBodies: any[] = [];
  readonly updatedIssues: Array<{ issueNumber: number; issue: any; marker?: GitHubIssueMarker; title?: string }> = [];
  readonly calls: string[] = [];
  readonly parentIssues: any[] = [];
  readonly parentUpdates: any[] = [];
  readonly statusUpserts: Array<{ target: { kind: "issue" | "pull_request"; number: number }; marker: string; body: string }> = [];
  readonly statusComments: Array<{ id: number; target: { kind: "issue" | "pull_request"; number: number }; body: string }> = [];
  readonly issues = new Map<number, GitHubIssueStateReference>();
  defaultBranch = "main";
  pullRequest: GitHubPullRequestReference | null = null;
  async getRepositoryIdentity() { return { host: "github.com", name_with_owner: "acme/repo", actor: "operator" }; }
  async findIssuesByMarker(_marker: GitHubIssueMarkerInput): Promise<GitHubIssueObservation[]> { this.calls.push("findIssuesByMarker"); return []; }
  async findParentIssuesByMarker(_marker: GitHubParentIssueMarkerInput): Promise<GitHubIssueObservation[]> { this.calls.push("findParentIssuesByMarker"); return []; }
  async createIssue(issue: any, marker?: GitHubIssueMarker, title?: string): Promise<number> {
    this.calls.push("createIssue"); this.created.push({ marker, title }); this.issueBodies.push(issue);
    this.issues.set(17, { number: 17, title: title ?? issue.title, body: formatIssueBody(issue, marker), state: "OPEN", state_reason: null });
    return 17;
  }
  async updateIssue(issueNumber: number, issue: any, marker?: GitHubIssueMarker, currentBody?: string, title?: string): Promise<void> {
    this.calls.push("updateIssue"); this.updatedIssues.push({ issueNumber, issue, marker, title });
    const current = this.issues.get(issueNumber);
    const desiredBody = formatIssueBody(issue, marker);
    if (current) this.issues.set(issueNumber, {
      ...current,
      title: title ?? issue.title,
      body: currentBody === undefined ? desiredBody : reconcileManagedIssueBody(currentBody, desiredBody),
    });
  }
  async addIssueLabels(): Promise<void> {}
  async openPullRequest(_input: OpenPullRequestInput): Promise<number> { return 99; }
  async commentOnPullRequest(): Promise<void> {}
  async findIssueByMarker(_marker: GitHubIssueMarkerInput): Promise<number | GitHubIssueReference | null> { this.calls.push("findIssueByMarker"); return null; }
  async findParentIssueByMarker(_marker: GitHubParentIssueMarker): Promise<number | GitHubIssueReference | null> { this.calls.push("findParentIssueByMarker"); return null; }
  async createParentIssue(input: any, marker: GitHubParentIssueMarker): Promise<number> {
    this.calls.push("createParentIssue"); this.parentIssues.push(input);
    this.issues.set(9, { number: 9, title: input.title, body: formatParentIssueBody(input, marker), state: "OPEN", state_reason: null });
    return 9;
  }
  async updateParentIssue(issueNumber: number, input: any, marker: GitHubParentIssueMarker, currentBody?: string): Promise<void> {
    this.calls.push("updateParentIssue"); this.parentUpdates.push({ issueNumber, input });
    const current = this.issues.get(issueNumber);
    const desiredBody = formatParentIssueBody(input, marker);
    if (current) this.issues.set(issueNumber, {
      ...current,
      title: input.title,
      body: currentBody === undefined ? desiredBody : reconcileManagedIssueBody(currentBody, desiredBody),
    });
  }
  async openIntegratedPullRequest(input: OpenIntegratedPullRequestInput): Promise<GitHubPullRequestReference> {
    this.calls.push("openIntegratedPullRequest");
    this.prs.push(input);
    const closing = expectedClosingIssueNumbers(input);
    this.pullRequest = {
      number: 42,
      url: "https://github.com/acme/repo/pull/42",
      title: input.title,
      head_ref: input.head,
      head_sha: input.headSha,
      base_ref: input.base,
      body: reconcileClosingLinksBlock(input.summary, input.lineageId, input.runId, closing),
      closing_issue_numbers: closing,
      state: "OPEN",
    };
    return this.pullRequest;
  }
  async findPullRequestByHead(): Promise<GitHubPullRequestReference | null> { this.calls.push("findPullRequestByHead"); return null; }
  async findPullRequestsByLineage(): Promise<GitHubPullRequestReference[]> { this.calls.push("findPullRequestsByLineage"); return this.pullRequest ? [this.pullRequest] : []; }
  async getDefaultBranch(): Promise<string> { this.calls.push("getDefaultBranch"); return this.defaultBranch; }
  async getPullRequest(pullRequestNumber: number): Promise<GitHubPullRequestReference> {
    this.calls.push("getPullRequest");
    return this.pullRequest ?? {
      number: pullRequestNumber,
      url: `https://github.com/acme/repo/pull/${pullRequestNumber}`,
      title: "Task: Ship feature",
      head_ref: "codex/brain-hands/run-1",
      ...(root ? { head_sha: headSha(join(root, "worktree")) } : {}),
      base_ref: this.defaultBranch,
      body: "Recovered pull request",
      closing_issue_numbers: [17],
      state: "OPEN",
    };
  }
  async updatePullRequestBody(_pullRequestNumber: number, body: string): Promise<void> {
    this.calls.push("updatePullRequestBody");
    const current = await this.getPullRequest(_pullRequestNumber);
    this.pullRequest = {
      ...current,
      body,
      closing_issue_numbers: [...body.matchAll(/^Closes #(\d+)$/gm)].map((match) => Number(match[1])),
    };
  }
  async getIssue(issueNumber: number): Promise<GitHubIssueStateReference> {
    const issue = this.issues.get(issueNumber);
    if (!issue) throw new Error(`Issue ${issueNumber} missing`);
    return { ...issue };
  }
  async closeIssue(issueNumber: number, reason: "completed" | "not_planned"): Promise<void> {
    const issue = await this.getIssue(issueNumber);
    this.issues.set(issueNumber, { ...issue, state: "CLOSED", state_reason: reason === "completed" ? "COMPLETED" : "NOT_PLANNED" });
  }
  async upsertRunStatus(target: { kind: "issue" | "pull_request"; number: number }, marker: string, body: string): Promise<void> { this.statusUpserts.push({ target, marker, body }); }
  async findStatusCommentByMarker(target: { kind: "issue" | "pull_request"; number: number }, marker: string) {
    const found = this.statusComments.find((comment) => comment.target.kind === target.kind
      && comment.target.number === target.number && comment.body.startsWith(`${marker}\n`));
    return found ? { id: found.id, body: found.body, authorLogin: "brain-hands-test" } : null;
  }
  async createStatusComment(target: { kind: "issue" | "pull_request"; number: number }, body: string) {
    const comment = { id: this.statusComments.length + 1, target, body };
    this.statusComments.push(comment);
    return { ...comment, authorLogin: "brain-hands-test" };
  }
  async updateStatusComment(commentId: number, body: string): Promise<void> {
    const comment = this.statusComments.find((entry) => entry.id === commentId);
    if (!comment) throw new Error(`Status comment ${commentId} missing`);
    comment.body = body;
  }
  async reconcileIssueStateLabel(): Promise<void> {}
}

async function setup(
  approved = true,
  qualityGate = false,
  policyEnabled = false,
  warningAuthorized = false,
  maxFixCycles?: number,
  remoteName = "origin",
  backup?: HandsBackupPolicy,
  reviewPolicyOnLimit?: ReviewLimitAction,
) {
  const root = await mkdtemp(join(tmpdir(), "brain-hands-runtime-github-"));
  execFileSync("git", ["init"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Codex Test"], { cwd: root });
  execFileSync("git", ["config", "user.email", "codex@example.com"], { cwd: root });
  execFileSync("git", ["commit", "--allow-empty", "-m", "initial"], { cwd: root });
  const sourceCommit = headSha(root);
  controllerProvenance.candidate_commit = sourceCommit;
  const policy = qualityGate ? defaultConfig().retry_policy.quality_gate : undefined;
  const reviewPolicy = warningAuthorized
    ? { policy_revision: 1, max_fix_cycles: 0, on_limit: "continue_with_warning" as const, auto_advance_on_approval: true, severity_defaults: { critical: "blocking" as const, high: "blocking" as const, medium: "fix_in_scope" as const, low: "advisory" as const }, pause_on: ["plan_approval" as const, "unresolved_release_blocker" as const] }
    : maxFixCycles === undefined
    ? undefined
    : { ...defaultConfig().review_policy, max_fix_cycles: maxFixCycles };
  if (reviewPolicy && reviewPolicyOnLimit) reviewPolicy.on_limit = reviewPolicyOnLimit;
  const createLedger = policyEnabled ? createRunLedgerV2 : createLegacyRunLedgerV2;
  const ledger = await createLedger({ repoRoot: root, originalRequest: intake.task, mode: "github", runId: "run-1", sourceCommit, ...(policyEnabled ? { controllerProvenance } : {}), intake: {
    ...intake,
    repo_root: root,
    ...(policy ? { quality_gate: policy } : {}),
    ...(reviewPolicy ? { review_policy: reviewPolicy } : {}),
    ...(backup ? { hands_backup: backup } : {}),
    ...(warningAuthorized ? {
      warning_continuation_authority: { actor: "release-manager", source: "run_override" as const },
    } : {}),
  } });
  const worktree = join(root, ".brain-hands", "worktrees", ledger.runId);
  const branchName = "codex/brain-hands/run-1";
  execFileSync("git", ["worktree", "add", "-b", branchName, worktree, sourceCommit], { cwd: root });
  await symlink(worktree, join(root, "worktree"), "dir");
  await updateManifestV2(ledger.runDir, {
    source_commit: sourceCommit,
    worktree_path: worktree,
    branch_name: branchName,
  });
  const pinnedManifest = await readManifestV2(ledger.runDir);
  const runConfiguration = resolvedRunConfigurationSchema.parse({
    version: 1,
    repository: root,
    mode: "github",
    research: false,
    reflection: false,
    controller: { package_name: "@ngelik/brain-hands", package_version: "0.4.0", mode: "development_checkout" },
    roles: Object.fromEntries(Object.entries(intake.roles).map(([name, profile]) => [name, { ...profile, source: "repository_config" }])),
    hands_backup: pinnedManifest.hands_backup_policy,
    limits: {
      max_hands_fix_attempts: defaultConfig().retry_policy.max_hands_fix_attempts,
      max_replan_attempts: defaultConfig().retry_policy.max_replan_attempts,
      review_policy: pinnedManifest.review_policy_snapshot,
      quality_gate: pinnedManifest.quality_gate_policy,
    },
    github: { effects: "issues_and_pull_request", default_remote: remoteName },
  });
  if (policyEnabled) {
    await writeFile(join(ledger.runDir, "run-configuration.json"), serializeRunConfiguration(runConfiguration));
  }
  const manifestPath = join(ledger.runDir, "manifest.json");
  await transitionRun(ledger.runDir, "preflight");
  if (policyEnabled) {
    await transitionRun(ledger.runDir, "brain_discovery");
    await recordApprovedDiscoveryForPlan(ledger.runDir, plan);
  } else {
    await transitionRun(ledger.runDir, "brain_planning");
  }
  if (policyEnabled && approved) {
    await recordAndApprovePinnedInitialPlan(ledger.runDir, plan, approvalControllerCapture);
  } else {
    await recordPlan(ledger.runDir, `${JSON.stringify(plan)}\n`);
    await transitionRun(ledger.runDir, "awaiting_plan_approval");
    if (approved) await approvePlanRevision(ledger.runDir, 1, { actor: "test" });
  }
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (!policyEnabled) {
    delete manifest.review_policy_snapshot;
    delete manifest.review_accounting;
    delete manifest.release_guards;
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { root, runDir: ledger.runDir };
}

async function persistVerifiedRuntimeAssessment(runDir: string): Promise<AssuranceAssessment> {
  const manifest = await readManifestV2(runDir);
  if (manifest.terminal !== null && manifest.assurance_assessment_path) {
    return JSON.parse(await readFile(join(runDir, manifest.assurance_assessment_path), "utf8")) as AssuranceAssessment;
  }
  const revision = manifest.approved_revision ?? manifest.approved_plan_revision;
  const assessment: AssuranceAssessment = {
    outcome: "verified_ready",
    assessed_at: new Date().toISOString(),
    approved_plan_revision: revision ?? null,
    approved_plan_sha256: revision ? manifest.plan_revisions[String(revision)]?.sha256 ?? null : null,
    candidate_commit: typeof manifest.work_item_progress.integrated?.commit_sha === "string"
      ? manifest.work_item_progress.integrated.commit_sha
      : null,
    blocker_code: null,
    blocker: null,
    missing_evidence: [],
    invalid_evidence: [],
    zero_attempt_work_items: [],
    acceptance_path: null,
  };
  const path = "assurance/runtime-test-assessment.json";
  await writeTextArtifact(runDir, path, `${JSON.stringify(assessment)}\n`);
  await updateManifestV2(runDir, { assurance_outcome: assessment.outcome, assurance_assessment_path: path });
  return assessment;
}

async function runGithubWorkflow(
  input: Parameters<typeof runGithubWorkflowRuntime>[0],
): ReturnType<typeof runGithubWorkflowRuntime> {
  return runGithubWorkflowRuntime({
    ...input,
    dependencies: {
      persistFinalDeliveryAssessmentAtBoundary: persistVerifiedRuntimeAssessment,
      ...input.dependencies,
    },
  });
}

async function approvalPolicyPostPrHarness(
  setupResult: { root: string; runDir: string },
  github: RecordingGithub,
  interruptAt: "effect" | "intent" | "commit" | "push" | "replan_boundary" | null,
  warningContinuation = false,
  replan = false,
  postPrChangeReviews = 1,
  candidateKind: "material" | "noop" | "invalid" = "material",
) {
  const approvedManifest = await readManifestV2(setupResult.runDir);
  if (approvedManifest.approved_revision === null) throw new Error("Policy harness requires an approved plan revision");
  const approvedRevision = approvedManifest.approved_revision;
  const initialSha = approvedManifest.source_commit ?? headSha(approvedManifest.worktree_path!);
  const postPrSha = "2".repeat(40);
  const intendedTreeSha = "4".repeat(40);
  const commitMessage = "work-item: integrated Integrated local delivery audit";
  const state = {
    finalReviews: 0,
    pushCalls: 0,
    pushedCommitShas: [] as string[],
    leaseBeforeShas: [] as Array<string | null>,
    raceRemoteOnPush: false,
    commitCalls: 0,
    commitIntentCalls: 0,
    commitProvenanceCalls: 0,
    lastCommitInput: null as Record<string, unknown> | null,
    remoteSha: null as string | null,
    postInitialRemoteSha: initialSha as string | null,
    localSha: initialSha,
    localCommit: {
      sha: initialSha,
      parent_shas: [] as string[],
      tree_sha: "0".repeat(40),
      message: "initial",
    },
    interruptAt,
    replanPending: replan,
    mutationKinds: [] as string[],
    integratedVerificationAttempts: [] as number[],
    brainCalls: 0,
    handsCalls: 0,
  };
  const readPullRequest = github.getPullRequest.bind(github);
  github.getPullRequest = async (number) => ({ ...(await readPullRequest(number)), head_sha: state.localSha });
  const runtimeConfig = defaultConfig();
  runtimeConfig.retry_policy.max_hands_fix_attempts = 1;
  const workflowInput = {
    runDir: setupResult.runDir,
    repoRoot: setupResult.root,
    worktreePath: approvedManifest.worktree_path!,
    branchName: approvedManifest.branch_name!,
    baseBranch: "main",
    intake: { ...intake, repo_root: setupResult.root },
    plan,
    config: runtimeConfig,
    codex: replan ? {
      invoke: async (invocation: { prompt: string }) => {
        state.brainCalls += 1;
        const findingIds = [...new Set(invocation.prompt.match(/finding:[a-f0-9]{64}/g) ?? [])];
        if (findingIds.length === 0) throw new Error("Replan prompt is missing its unresolved finding IDs");
        const patch = {
          target_work_item_id: "feature",
          base_plan_revision: approvedRevision,
          unresolved_finding_ids: findingIds,
          revised_objective: candidateKind === "noop" ? null : "feature revised",
          added_or_changed_criteria: candidateKind === "noop" ? [] : [{ ref: "BH-001:AC-1", text: "feature works revised" }],
          changed_instructions: candidateKind === "noop" ? [] : ["Fix feature under the approved revision."],
          added_change_units: [],
          added_cross_cutting_impacts: [],
          added_read_only_file_contracts: [],
          added_verification_commands: candidateKind === "invalid" ? [{
            id: "BH-001-VERIFY-02",
            argv: ["bash", "-lc", "curl https://example.com"],
            expected_exit_code: 0,
          }] : [],
          explicitly_rejected_hardening: [],
        };
        return { text: JSON.stringify(patch), parsed: patch, exitCode: 0, promptPath: "prompt", stdoutPath: "stdout", stderrPath: "stderr" };
      },
    } as never : {} as never,
    dependencies: {
      github,
      hands: async (input) => {
        state.handsCalls += 1;
        const value = input.workItem.id === "integrated"
          ? { ...implementation("integrated"), changed_files: ["src/feature.ts"] }
          : implementation(input.workItem.id);
        const reportPath = `implementation/${input.workItem.id}/attempt-${input.attempt}.json`;
        await writeTextArtifact(input.runDir, reportPath, `${JSON.stringify(value)}\n`);
        return { implementation: value, reportPath, invocation: {} as never };
      },
      verification: async (input) => {
        if (input.identity?.work_item_id === "integrated") state.integratedVerificationAttempts.push(input.attempt ?? 1);
        const value = await evidenceForInput(input);
        const resolved = !warningContinuation && input.identity?.work_item_id === "integrated" && input.attempt === 2
          ? { ...value, commands: value.commands.map((command) => ({ ...command, exit_code: 1 })) }
          : value;
        for (const command of resolved.commands) {
          await writeTextArtifact(input.runDir, command.stdout_path, "stdout\n");
          await writeTextArtifact(input.runDir, command.stderr_path, "stderr\n");
          await writeTextArtifact(input.runDir, command.result_path!, `${JSON.stringify({
            argv: command.argv ?? [], stdout: "stdout\n", stderr: "stderr\n",
            exit_code: command.exit_code, duration_ms: command.duration_ms ?? 0,
            timed_out: command.timed_out, error_code: command.error_code,
            error_message: command.error_message, signal: command.signal,
          })}\n`);
        }
        await writeTextArtifact(input.runDir, resolved.evidence_path!, `${JSON.stringify(resolved)}\n`);
        return resolved;
      },
      selfReview: async (input) => {
        state.mutationKinds.push(`${input.workItem.id}:${input.mutationKind}:${input.parentAttempt}:${input.pass}`);
        const report = selfReviewReport(input.workItem.id, input.parentAttempt, input.pass, input.mutationKind);
        const path = `self-review/${input.workItem.id}/attempt-${input.parentAttempt}/pass-${input.pass}.json`;
        await writeTextArtifact(input.runDir, path, `${JSON.stringify(report)}\n`);
        return { report, reportPath: path, invocation: {} as never };
      },
      diff: async () => "post-PR policy diff",
      collectScopedWorktreeDiff: async (input) => ({
        base_commit: input.baseCommit,
        head_commit: state.localSha,
        changed_files: ["src/feature.ts"],
        patch: `post-PR policy diff from ${input.baseCommit}`,
        patch_bytes: Buffer.byteLength(`post-PR policy diff from ${input.baseCommit}`, "utf8"),
      }),
      verifier: async (input) => {
        if (input.final) state.finalReviews += 1;
        const requested = input.final
          && state.finalReviews >= 2
          && state.finalReviews <= postPrChangeReviews + 1
          && (!replan || state.replanPending);
        const workItemId = input.final ? "integrated" : input.workItem.id;
        const attempt = input.attempt ?? 1;
        const finding = requested ? [{
          severity: "medium" as const, file: "src/feature.ts", line: null,
          acceptance_criterion: "feature works", problem_class: "correctness" as const,
          problem: "missing", required_fix: "fix", evidence_refs: [verifierEvidenceRef(input)], re_verification: [],
        }] : [];
        const review: VerifierReview = {
          work_item_id: workItemId, attempt, final: Boolean(input.final),
          decision: requested ? (replan ? "replan_required" : "request_changes") : "approve",
          failure_class: requested ? (replan ? "replan_required" : "implementation_failure") : "none", blocker: null, blocker_code: null,
          acceptance_coverage: [], evidence_reviewed: [verifierEvidenceRef(input)], findings: finding, residual_risks: [],
        };
        const reviewPath = input.final
          ? `reviews/integrated/final-attempt-${attempt}.json`
          : `reviews/${workItemId}/attempt-${attempt}.json`;
        return { review, reviewPath: await writeTextArtifact(setupResult.runDir, reviewPath, `${JSON.stringify(review)}\n`), invocation: {} as never };
      },
      gitSnapshot: (() => {
        let calls = 0;
        return async () => ({ branch: "codex/brain-hands/run-1", status: calls++ === 1 ? " M src/feature.ts\n" : "", gitDir: ".git", gitCommonDir: ".git", isLinkedWorktree: true });
      })(),
      hasWorktreeChanges: async () => false,
      prepareCommitIntent: async () => {
        state.commitIntentCalls += 1;
        return { parent_sha: initialSha, tree_sha: intendedTreeSha, message: commitMessage };
      },
      commit: async (commitInput) => {
        state.lastCommitInput = commitInput as unknown as Record<string, unknown>;
        state.commitCalls += 1;
        state.localSha = postPrSha;
        state.localCommit = { sha: postPrSha, parent_shas: [initialSha], tree_sha: intendedTreeSha, message: commitMessage };
        return state.localSha;
      },
      push: async () => {
        state.pushCalls += 1;
        state.remoteSha = state.pushCalls === 1 ? state.postInitialRemoteSha : postPrSha;
        return "pushed";
      },
      pushCommit: async (_repoRoot: string, sha: string, _branch: string, before: string | null) => {
        state.pushCalls += 1;
        state.pushedCommitShas.push(sha);
        state.leaseBeforeShas.push(before);
        if (state.raceRemoteOnPush) {
          state.remoteSha = "0".repeat(40);
          throw new Error("atomic push lease rejected");
        }
        state.remoteSha = sha;
        return "pushed";
      },
      remoteBranchSha: async () => state.remoteSha,
      remoteBranchAtLocalHead: async () => {
        if (state.remoteSha === null) throw new Error("Remote PR branch does not exist");
        if (state.remoteSha !== state.localSha) throw new Error("Remote PR branch does not equal local HEAD");
        return state.localSha;
      },
      localHeadSha: async () => state.localSha,
      localCommitProvenance: async () => {
        state.commitProvenanceCalls += 1;
        return state.localCommit;
      },
      afterCheckpoint: async (checkpoint: string) => {
        if (state.interruptAt === "replan_boundary" && checkpoint === "after_replan_boundary_commit") {
          state.interruptAt = null;
          throw new Error("crash after prepared replan boundary commit");
        }
        if (state.interruptAt === "effect" && checkpoint === "after_post_pr_effect_complete") {
          state.interruptAt = null;
          throw new Error("crash after completed post-PR fix effect");
        }
        if (state.interruptAt === "intent" && checkpoint === "after_post_pr_commit_intent") {
          state.interruptAt = null;
          throw new Error("crash after durable post-PR commit intent");
        }
        if (state.interruptAt === "commit" && checkpoint === "after_post_pr_commit") {
          state.interruptAt = "push";
          throw new Error("crash after successful post-PR commit");
        }
        if (state.interruptAt === "push" && checkpoint === "after_post_pr_push") {
          state.interruptAt = null;
          throw new Error("crash after successful post-PR push");
        }
      },
    },
  } as Parameters<typeof runGithubWorkflow>[0];
  return { state, workflowInput, initialSha, postPrSha, intendedTreeSha, commitMessage };
}

describe("GitHub issue effect preview boundary", () => {
  it.each(["artifact-only", "lineage-only", "manifest-ref"] as const)(
    "recovers the %s persistence prefix without any GitHub mutation",
    async (prefix) => {
      const setupResult = await setup(); root = setupResult.root;
      const firstGithub = new RecordingGithub();
      const input = {
        runDir: setupResult.runDir,
        repoRoot: setupResult.root,
        worktreePath: join(setupResult.root, "worktree"),
        branchName: "codex/brain-hands/run-1",
        intake: { ...intake, repo_root: setupResult.root },
        plan,
        codex: {} as never,
      };
      const first = await runGithubWorkflow({
        ...input,
        dependencies: { github: firstGithub },
      });
      const complete = await readManifestV2(setupResult.runDir);
      const reference = complete.github_effects.issue_sync!;
      const lineageId = complete.task_lineage_id!;
      expect(first).toMatchObject({ status: "awaiting_github_effects", manifest: { stage: "awaiting_github_issue_effects", terminal: null } });
      expect(firstGithub.created).toEqual([]);
      expect(firstGithub.updatedIssues).toEqual([]);
      expect(firstGithub.parentIssues).toEqual([]);
      expect(firstGithub.parentUpdates).toEqual([]);
      expect(firstGithub.prs).toEqual([]);
      expect(firstGithub.statusUpserts).toEqual([]);

      if (prefix === "artifact-only") {
        await withTaskLineageTransaction({
          repoRoot: setupResult.root,
          lineageId,
          operation: (transaction) => transaction.update({
            ...transaction.read(),
            issue_set: {
              ...transaction.read().issue_set,
              plan_revision: null,
              plan_sha256: null,
              preview: null,
            },
          }),
        });
        await updateManifestV2(setupResult.runDir, {
          stage: "worktree_setup",
          github_effects: { issue_sync: null, pull_request_delivery: null },
        });
      } else if (prefix === "lineage-only") {
        await updateManifestV2(setupResult.runDir, {
          stage: "worktree_setup",
          github_effects: { issue_sync: null, pull_request_delivery: null },
        });
      } else {
        await updateManifestV2(setupResult.runDir, { stage: "worktree_setup" });
      }

      expect(await readOperatorStatus(setupResult.runDir)).toMatchObject({
        operator_state: "operationally_blocked",
        effect_boundary: null,
        blocker: expect.stringMatching(/preview persistence is incomplete/i),
      });

      const recoveryGithub = new RecordingGithub();
      const recovered = await runGithubWorkflow({
        ...input,
        dependencies: { github: recoveryGithub },
      });

      expect(recovered).toMatchObject({ status: "awaiting_github_effects", manifest: { stage: "awaiting_github_issue_effects", terminal: null } });
      expect((await readManifestV2(setupResult.runDir)).github_effects.issue_sync).toEqual(reference);
      expect((await readTaskLineage(setupResult.root, lineageId)).issue_set).toMatchObject({
        state: "uninitialized",
        operations: {},
        preview: reference,
      });
      expect(recoveryGithub.created).toEqual([]);
      expect(recoveryGithub.updatedIssues).toEqual([]);
      expect(recoveryGithub.parentIssues).toEqual([]);
      expect(recoveryGithub.parentUpdates).toEqual([]);
      expect(recoveryGithub.prs).toEqual([]);
      expect(recoveryGithub.statusUpserts).toEqual([]);
    },
  );

  it("recovers an artifact-only prefix locally without observing changed remote issue state", async () => {
    const setupResult = await setup(); root = setupResult.root;
    const input = {
      runDir: setupResult.runDir,
      repoRoot: setupResult.root,
      worktreePath: join(setupResult.root, "worktree"),
      branchName: "codex/brain-hands/run-1",
      intake: { ...intake, repo_root: setupResult.root },
      plan,
      codex: {} as never,
    };
    await runGithubWorkflow({ ...input, dependencies: { github: new RecordingGithub() } });
    const complete = await readManifestV2(setupResult.runDir);
    const reference = complete.github_effects.issue_sync!;
    const lineageId = complete.task_lineage_id!;
    await withTaskLineageTransaction({
      repoRoot: setupResult.root,
      lineageId,
      operation: (transaction) => transaction.update({
        ...transaction.read(),
        issue_set: { ...transaction.read().issue_set, plan_revision: null, plan_sha256: null, preview: null },
      }),
    });
    await updateManifestV2(setupResult.runDir, {
      stage: "worktree_setup",
      github_effects: { issue_sync: null, pull_request_delivery: null },
    });
    const changedRemote = {
      number: 91,
      title: "Changed remotely",
      body: formatIssueBody(plan.work_items[0]!, { runId: complete.run_id, workItemId: "feature" }),
      labels: ["changed"],
      state: "CLOSED" as const,
      state_reason: "NOT_PLANNED" as const,
    };
    const github = new RecordingGithub();
    github.findIssuesByMarker = vi.fn(async () => [changedRemote]);
    github.findParentIssuesByMarker = vi.fn(async () => { throw new Error("remote parent observation must not run"); });

    const recovered = await runGithubWorkflow({ ...input, dependencies: { github } });

    expect(recovered).toMatchObject({ status: "awaiting_github_effects", manifest: { stage: "awaiting_github_issue_effects" } });
    expect((await readManifestV2(setupResult.runDir)).github_effects.issue_sync).toEqual(reference);
    expect((await readTaskLineage(setupResult.root, lineageId)).issue_set.preview).toEqual(reference);
    expect(github.findIssuesByMarker).not.toHaveBeenCalled();
    expect(github.findParentIssuesByMarker).not.toHaveBeenCalled();
    expect(github.created).toEqual([]);
    expect(github.updatedIssues).toEqual([]);
  });

  it("fails closed on a malformed artifact-only prefix without observing or overwriting", async () => {
    const setupResult = await setup(); root = setupResult.root;
    const input = {
      runDir: setupResult.runDir,
      repoRoot: setupResult.root,
      worktreePath: join(setupResult.root, "worktree"),
      branchName: "codex/brain-hands/run-1",
      intake: { ...intake, repo_root: setupResult.root },
      plan,
      codex: {} as never,
    };
    await runGithubWorkflow({ ...input, dependencies: { github: new RecordingGithub() } });
    const complete = await readManifestV2(setupResult.runDir);
    const lineageId = complete.task_lineage_id!;
    await withTaskLineageTransaction({
      repoRoot: setupResult.root,
      lineageId,
      operation: (transaction) => transaction.update({
        ...transaction.read(),
        issue_set: { ...transaction.read().issue_set, plan_revision: null, plan_sha256: null, preview: null },
      }),
    });
    await updateManifestV2(setupResult.runDir, {
      stage: "worktree_setup",
      github_effects: { issue_sync: null, pull_request_delivery: null },
    });
    const artifactPath = join(setupResult.runDir, "github-effects/issue-sync/revision-1.json");
    const malformed = "{\"not\":\"a canonical preview\"}\n";
    await writeFile(artifactPath, malformed, "utf8");
    const github = new RecordingGithub();
    github.findIssuesByMarker = vi.fn(async () => { throw new Error("remote observation must not run"); });
    github.findParentIssuesByMarker = vi.fn(async () => { throw new Error("remote parent observation must not run"); });

    const result = await runGithubWorkflow({ ...input, dependencies: { github } });

    expect(result.status).toBe("human_action_required");
    expect(result.blocker).toMatch(/preview|canonical|shape|invalid/i);
    expect(await readFile(artifactPath, "utf8")).toBe(malformed);
    expect((await readManifestV2(setupResult.runDir)).github_effects.issue_sync).toBeNull();
    expect((await readTaskLineage(setupResult.root, lineageId)).issue_set.preview).toBeNull();
    expect(github.findIssuesByMarker).not.toHaveBeenCalled();
    expect(github.findParentIssuesByMarker).not.toHaveBeenCalled();
  });

  it("rejects a lineage state and mapping change made during remote observation", async () => {
    const setupResult = await setup(); root = setupResult.root;
    const github = new RecordingGithub();
    let mutation: Promise<void> | null = null;
    github.findIssuesByMarker = async () => {
      mutation ??= (async () => {
        const manifest = await readManifestV2(setupResult.runDir);
        await withTaskLineageTransaction({
          repoRoot: setupResult.root,
          lineageId: manifest.task_lineage_id!,
          operation: (transaction) => transaction.update({
            ...transaction.read(),
            issue_set: {
              ...transaction.read().issue_set,
              state: "ambiguous",
              work_item_issue_map: { feature: 77 },
            },
          }),
        });
      })();
      await mutation;
      return [];
    };

    const result = await runGithubWorkflow({
      runDir: setupResult.runDir,
      repoRoot: setupResult.root,
      worktreePath: join(setupResult.root, "worktree"),
      branchName: "codex/brain-hands/run-1",
      intake: { ...intake, repo_root: setupResult.root },
      plan,
      codex: {} as never,
      dependencies: { github },
    });

    const manifest = await readManifestV2(setupResult.runDir);
    const lineage = await readTaskLineage(setupResult.root, manifest.task_lineage_id!);
    expect(result.status).toBe("human_action_required");
    expect(result.blocker).toMatch(/lineage.*changed|snapshot/i);
    expect(manifest.stage).toBe("worktree_setup");
    expect(manifest.github_effects.issue_sync).toBeNull();
    expect(lineage.issue_set).toMatchObject({ state: "ambiguous", work_item_issue_map: { feature: 77 }, preview: null });
    expect(github.created).toEqual([]);
    expect(github.updatedIssues).toEqual([]);
  });

  it.each(["plan", "stage", "reference"] as const)(
    "rejects a concurrent manifest %s change before attaching the planned preview",
    async (change) => {
      const setupResult = await setup(); root = setupResult.root;
      const github = new RecordingGithub();
      let mutation: Promise<void> | null = null;
      let mutationError: unknown = null;
      github.findIssuesByMarker = async () => {
        mutation ??= (async () => {
          try {
            if (change === "plan") {
              const revision = await recordPlan(setupResult.runDir, `${JSON.stringify({ ...plan, summary: "Concurrent plan" })}\n`);
              await approvePlanRevision(setupResult.runDir, revision.revision, { actor: "concurrent-test" });
            } else if (change === "stage") {
              await updateManifestV2(setupResult.runDir, { stage: "implementing" });
            } else {
              const manifest = await readManifestV2(setupResult.runDir);
              const revision = manifest.approved_revision!;
              await updateManifestV2(setupResult.runDir, {
                github_effects: {
                  issue_sync: {
                    phase: "issue_sync",
                    revision: 1,
                    path: "github-effects/issue-sync/revision-1.json",
                    sha256: "f".repeat(64),
                    plan_revision: revision,
                    plan_sha256: manifest.plan_revisions[String(revision)]!.sha256,
                    state: "previewed",
                  },
                  pull_request_delivery: null,
                },
              });
            }
          } catch (error) {
            mutationError = error;
          }
        })();
        await mutation;
        return [];
      };

      const result = await runGithubWorkflow({
        runDir: setupResult.runDir,
        repoRoot: setupResult.root,
        worktreePath: join(setupResult.root, "worktree"),
        branchName: "codex/brain-hands/run-1",
        intake: { ...intake, repo_root: setupResult.root },
        plan,
        codex: {} as never,
        dependencies: { github },
      });

      const manifest = await readManifestV2(setupResult.runDir);
      const lineage = await readTaskLineage(setupResult.root, manifest.task_lineage_id!);
      expect(mutationError).toBeInstanceOf(Error);
      expect((mutationError as Error).message).toMatch(/mutation is blocked while an external execution effect is active/i);
      expect(result.status).toBe("awaiting_github_effects");
      expect(manifest.stage).toBe("awaiting_github_issue_effects");
      expect(lineage.issue_set).toMatchObject({ state: "uninitialized", operations: {} });
      expect(lineage.issue_set.preview).not.toBeNull();
      expect(manifest.github_effects.issue_sync).toEqual(lineage.issue_set.preview);
      expect(await readOperatorStatus(setupResult.runDir)).toMatchObject({
        operator_state: "awaiting_github_effect_application",
        effect_boundary: { phase: "issue_sync" },
      });
      expect(github.created).toEqual([]);
      expect(github.updatedIssues).toEqual([]);
    },
  );

  it("holds the lineage lock through manifest attachment and the validated ready-stage transition", async () => {
    const setupResult = await setup(); root = setupResult.root;
    const github = new RecordingGithub();
    let competingWriter: Promise<void> | null = null;
    let intermediateStatus: Awaited<ReturnType<typeof readOperatorStatus>> | null = null;
    const dependencies = {
      github,
      afterIssuePreviewLineagePersisted: async () => {
        const manifest = await readManifestV2(setupResult.runDir);
        competingWriter = withTaskLineageTransaction({
          repoRoot: setupResult.root,
          lineageId: manifest.task_lineage_id!,
          operation: async (transaction) => {
            const currentManifest = await readManifestV2(setupResult.runDir);
            expect(currentManifest.stage).toBe("awaiting_github_issue_effects");
            expect(currentManifest.github_effects.issue_sync).toEqual(transaction.read().issue_set.preview);
            await transaction.update({ ...transaction.read(), cleanup_state: "pending" });
          },
        });
        await Promise.resolve();
        intermediateStatus = await readOperatorStatus(setupResult.runDir);
      },
    } as GithubRuntimeDependencies;

    const result = await runGithubWorkflow({
      runDir: setupResult.runDir,
      repoRoot: setupResult.root,
      worktreePath: join(setupResult.root, "worktree"),
      branchName: "codex/brain-hands/run-1",
      intake: { ...intake, repo_root: setupResult.root },
      plan,
      codex: {} as never,
      dependencies,
    });

    expect(competingWriter).not.toBeNull();
    await competingWriter;
    expect(intermediateStatus).toMatchObject({ operator_state: "operationally_blocked", effect_boundary: null });
    expect(result).toMatchObject({ status: "awaiting_github_effects", manifest: { stage: "awaiting_github_issue_effects" } });
    const finalStatus = await readOperatorStatus(setupResult.runDir);
    expect(finalStatus).toMatchObject({ operator_state: "awaiting_github_effect_application", effect_boundary: { phase: "issue_sync" } });
    const manifest = await readManifestV2(setupResult.runDir);
    const lineage = await readTaskLineage(setupResult.root, manifest.task_lineage_id!);
    expect(lineage.cleanup_state).toBe("pending");
    expect(manifest.github_effects.issue_sync).toEqual(lineage.issue_set.preview);
  });

  it("retains and recovers a lineage-only prefix when manifest preview attachment fails", async () => {
    const setupResult = await setup(); root = setupResult.root;
    const input = {
      runDir: setupResult.runDir,
      repoRoot: setupResult.root,
      worktreePath: join(setupResult.root, "worktree"),
      branchName: "codex/brain-hands/run-1",
      intake: { ...intake, repo_root: setupResult.root },
      plan,
      codex: {} as never,
    };
    let manifestWrites = 0;
    const failingDependencies = {
      github: new RecordingGithub(),
      issuePreviewLedgerHooks: {
        beforeManifestPhase: async (phase: string) => {
          if (phase === "write" && ++manifestWrites === 1) throw new Error("injected preview manifest write failure");
        },
      },
    } as GithubRuntimeDependencies;

    const failed = await runGithubWorkflow({ ...input, dependencies: failingDependencies });

    expect(failed.status).toBe("human_action_required");
    expect(failed.blocker).toMatch(/injected preview manifest write failure/i);
    const partialManifest = await readManifestV2(setupResult.runDir);
    const partialLineage = await readTaskLineage(setupResult.root, partialManifest.task_lineage_id!);
    expect(partialManifest.stage).toBe("worktree_setup");
    expect(partialManifest.github_effects.issue_sync).toBeNull();
    expect(partialLineage.issue_set.preview).not.toBeNull();
    const recoveryGithub = new RecordingGithub();
    recoveryGithub.findIssuesByMarker = vi.fn(async () => { throw new Error("recovery must not observe issues"); });

    const recovered = await runGithubWorkflow({ ...input, dependencies: { github: recoveryGithub } });

    expect(recovered).toMatchObject({ status: "awaiting_github_effects", manifest: { stage: "awaiting_github_issue_effects" } });
    const readyManifest = await readManifestV2(setupResult.runDir);
    const readyLineage = await readTaskLineage(setupResult.root, readyManifest.task_lineage_id!);
    expect(readyManifest.github_effects.issue_sync).toEqual(readyLineage.issue_set.preview);
    expect(readyManifest).toMatchObject({ delivery_state: "pending", last_blocker: null });
    expect(await readOperatorStatus(setupResult.runDir)).toMatchObject({
      operator_state: "awaiting_github_effect_application",
      blocker: null,
      effect_boundary: { phase: "issue_sync" },
    });
    expect(recoveryGithub.findIssuesByMarker).not.toHaveBeenCalled();
  });

  it("rejects a conflicting manifest preview reference without overwriting it or publishing status", async () => {
    const setupResult = await setup(); root = setupResult.root;
    const input = {
      runDir: setupResult.runDir,
      repoRoot: setupResult.root,
      worktreePath: join(setupResult.root, "worktree"),
      branchName: "codex/brain-hands/run-1",
      intake: { ...intake, repo_root: setupResult.root },
      plan,
      codex: {} as never,
    };
    await runGithubWorkflow({ ...input, dependencies: { github: new RecordingGithub() } });
    const complete = await readManifestV2(setupResult.runDir);
    const conflicting = { ...complete.github_effects.issue_sync!, sha256: "f".repeat(64) };
    await updateManifestV2(setupResult.runDir, {
      stage: "worktree_setup",
      github_effects: { issue_sync: conflicting, pull_request_delivery: null },
    });
    const github = new RecordingGithub();

    const result = await runGithubWorkflow({ ...input, dependencies: { github } });

    expect(result.status).toBe("human_action_required");
    expect(result.blocker).toMatch(/preview references.*conflicting/i);
    expect((await readManifestV2(setupResult.runDir)).github_effects.issue_sync).toEqual(conflicting);
    expect(github.created).toEqual([]);
    expect(github.updatedIssues).toEqual([]);
    expect(github.parentIssues).toEqual([]);
    expect(github.parentUpdates).toEqual([]);
    expect(github.prs).toEqual([]);
    expect(github.statusUpserts).toEqual([]);
  });

  it("applies an unchanged issue preview once, persists lineage before manifest mappings, and replays without another create", async () => {
    const setupResult = await setup(); root = setupResult.root;
    const github = new RecordingGithub();
    const input = {
      runDir: setupResult.runDir,
      repoRoot: setupResult.root,
      worktreePath: join(setupResult.root, "worktree"),
      branchName: "codex/brain-hands/run-1",
      intake: { ...intake, repo_root: setupResult.root },
      plan,
      codex: {} as never,
      dependencies: { github, hands: async () => { throw new Error("stop after issue apply"); } },
    };
    await runGithubWorkflow(input);

    const applied = await runGithubWorkflow(input);

    expect(applied.status).toBe("human_action_required");
    expect(github.created).toHaveLength(1);
    const manifest = await readManifestV2(setupResult.runDir);
    const lineage = await readTaskLineage(setupResult.root, manifest.task_lineage_id!);
    expect(lineage.issue_set).toMatchObject({ state: "ready", work_item_issue_map: { feature: 17 } });
    expect(manifest.work_item_issue_map).toEqual({ feature: 17 });
    expect(manifest.github_ids.work_item_issue_map).toEqual({ feature: 17 });
    expect(manifest.github_ids.issue_numbers).toEqual([17]);

    await updateManifestV2(setupResult.runDir, {
      stage: "awaiting_github_issue_effects",
      issue_numbers: [],
      work_item_issue_map: {},
      github_ids: { ...manifest.github_ids, issue_numbers: [], work_item_issue_map: {} },
      github_effects: {
        ...manifest.github_effects,
        issue_sync: { ...manifest.github_effects.issue_sync!, state: "previewed" },
      },
    });
    github.findIssuesByMarker = vi.fn(async () => { throw new Error("manifest repair must not observe remote issues"); });
    await runGithubWorkflow(input);
    expect(github.created).toHaveLength(1);
    expect(github.findIssuesByMarker).not.toHaveBeenCalled();
    expect((await readManifestV2(setupResult.runDir)).work_item_issue_map).toEqual({ feature: 17 });
  });

  it("writes a replacement revision and performs zero mutations when owned issue material drifts", async () => {
    const setupResult = await setup(); root = setupResult.root;
    const github = new RecordingGithub();
    const input = {
      runDir: setupResult.runDir, repoRoot: setupResult.root, worktreePath: join(setupResult.root, "worktree"),
      branchName: "codex/brain-hands/run-1", intake: { ...intake, repo_root: setupResult.root }, plan, codex: {} as never,
      dependencies: { github },
    };
    await runGithubWorkflow(input);
    const manifest = await readManifestV2(setupResult.runDir);
    const drifted: GitHubIssueObservation = {
      number: 77,
      title: "Changed remotely",
      body: formatIssueBody(plan.work_items[0]!, { lineageId: manifest.task_lineage_id!, runId: manifest.run_id, workItemId: "feature" }),
      labels: ["brain-hands", "brain-hands:ready"],
      state: "OPEN",
      state_reason: null,
    };
    github.findIssuesByMarker = vi.fn(async () => [drifted]);

    const replacement = await runGithubWorkflow(input);

    expect(replacement).toMatchObject({ status: "awaiting_github_effects", manifest: { stage: "awaiting_github_issue_effects" } });
    expect(replacement.manifest.github_effects.issue_sync).toMatchObject({ revision: 2, state: "previewed" });
    expect(github.created).toEqual([]);
    expect(github.updatedIssues).toEqual([]);
    expect(await readFile(join(setupResult.runDir, "github-effects/issue-sync/revision-1.json"), "utf8")).not.toEqual(
      await readFile(join(setupResult.runDir, "github-effects/issue-sync/revision-2.json"), "utf8"),
    );
  });

  it.each(["artifact", "lineage"] as const)("recovers the exact replacement preview after a crash at the %s persistence boundary", async (boundary) => {
    const setupResult = await setup(); root = setupResult.root;
    const github = new RecordingGithub();
    const base = {
      runDir: setupResult.runDir, repoRoot: setupResult.root, worktreePath: join(setupResult.root, "worktree"),
      branchName: "codex/brain-hands/run-1", intake: { ...intake, repo_root: setupResult.root }, plan, codex: {} as never,
    };
    await runGithubWorkflow({ ...base, dependencies: { github } });
    const manifest = await readManifestV2(setupResult.runDir);
    const drifted: GitHubIssueObservation = {
      number: 77, title: "Changed remotely",
      body: formatIssueBody(plan.work_items[0]!, { lineageId: manifest.task_lineage_id!, runId: manifest.run_id, workItemId: "feature" }),
      labels: ["brain-hands", "brain-hands:ready"], state: "OPEN", state_reason: null,
    };
    github.findIssuesByMarker = vi.fn(async () => [drifted]);
    const crash = async () => { throw new Error(`crash after replacement ${boundary}`); };
    const failed = await runGithubWorkflow({
      ...base,
      dependencies: {
        github,
        ...(boundary === "artifact" ? { afterIssueReplacementArtifactPersisted: crash } : { afterIssuePreviewLineagePersisted: crash }),
      } as GithubRuntimeDependencies,
    });
    expect(failed).toMatchObject({ status: "human_action_required", blocker: expect.stringContaining(`crash after replacement ${boundary}`) });
    const replacementPath = join(setupResult.runDir, "github-effects/issue-sync/revision-2.json");
    const bytes = await readFile(replacementPath, "utf8");

    const recovered = await runGithubWorkflow({ ...base, dependencies: { github } });

    expect(recovered.status, recovered.blocker).toBe("awaiting_github_effects");
    expect(recovered.manifest.github_effects.issue_sync).toMatchObject({ revision: 2 });
    expect(await readFile(replacementPath, "utf8")).toBe(bytes);
    await expect(readFile(join(setupResult.runDir, "github-effects/issue-sync/revision-3.json"), "utf8")).rejects.toThrow("ENOENT");
    expect(github.created).toEqual([]);
    expect(github.updatedIssues).toEqual([]);
  });

  it("turns lock-held second-preflight drift into an immutable replacement boundary", async () => {
    const setupResult = await setup(); root = setupResult.root;
    const github = new RecordingGithub();
    let lookups = 0;
    const base = { runDir: setupResult.runDir, repoRoot: setupResult.root, worktreePath: join(setupResult.root, "worktree"), branchName: "codex/brain-hands/run-1", intake: { ...intake, repo_root: setupResult.root }, plan, codex: {} as never };
    github.findIssuesByMarker = vi.fn(async () => {
      lookups += 1;
      if (lookups <= 4) return [];
      const manifest = await readManifestV2(setupResult.runDir);
      return [{ number: 77, title: "Appeared under lock", body: formatIssueBody(plan.work_items[0]!, { lineageId: manifest.task_lineage_id!, runId: manifest.run_id, workItemId: "feature" }), labels: ["brain-hands", "brain-hands:ready"], state: "OPEN" as const, state_reason: null }];
    });
    await runGithubWorkflow({ ...base, dependencies: { github } });

    const result = await runGithubWorkflow({ ...base, dependencies: { github } });

    expect(result.status, result.blocker).toBe("awaiting_github_effects");
    expect(result.manifest.github_effects.issue_sync).toMatchObject({ revision: 2, state: "previewed" });
    expect(github.created).toEqual([]);
    expect(github.updatedIssues).toEqual([]);
    const events = await readFile(join(setupResult.runDir, "events.jsonl"), "utf8");
    expect(events).toContain('"type":"github_effect_preview_invalidated"');
    expect(events).toContain('"old_revision":1');
  });

  it("durably invalidates N before writing N+1 and recovers the invalidated-only prefix", async () => {
    const setupResult = await setup(); root = setupResult.root;
    const github = new RecordingGithub();
    const base = { runDir: setupResult.runDir, repoRoot: setupResult.root, worktreePath: join(setupResult.root, "worktree"), branchName: "codex/brain-hands/run-1", intake: { ...intake, repo_root: setupResult.root }, plan, codex: {} as never };
    await runGithubWorkflow({ ...base, dependencies: { github } });
    const manifest = await readManifestV2(setupResult.runDir);
    github.findIssuesByMarker = vi.fn(async () => [{ number: 77, title: "Drift", body: formatIssueBody(plan.work_items[0]!, { lineageId: manifest.task_lineage_id!, runId: manifest.run_id, workItemId: "feature" }), labels: ["brain-hands"], state: "OPEN" as const, state_reason: null }]);
    const failed = await runGithubWorkflow({ ...base, dependencies: { github, afterIssuePreviewInvalidated: async () => {
      expect((await readManifestV2(setupResult.runDir)).github_effects.issue_sync?.state).toBe("invalidated");
      expect((await readTaskLineage(setupResult.root, manifest.task_lineage_id!)).issue_set.preview?.state).toBe("invalidated");
      expect((await readOperatorStatus(setupResult.runDir)).effect_boundary).toBeNull();
      throw new Error("crash after invalidation");
    } } as GithubRuntimeDependencies });
    expect(failed).toMatchObject({ status: "human_action_required", blocker: expect.stringContaining("crash after invalidation") });
    await expect(readFile(join(setupResult.runDir, "github-effects/issue-sync/revision-2.json"), "utf8")).rejects.toThrow("ENOENT");
    const recovered = await runGithubWorkflow({ ...base, dependencies: { github } });
    expect(recovered).toMatchObject({ status: "awaiting_github_effects", manifest: { github_effects: { issue_sync: { revision: 2, state: "previewed" } } } });
    expect(await readFile(join(setupResult.runDir, "events.jsonl"), "utf8")).toContain('"type":"github_effect_preview_invalidated"');
  });

  it("recovers a lineage-only invalidation prefix without ever applying N", async () => {
    const setupResult = await setup(); root = setupResult.root; const github = new RecordingGithub();
    const base = { runDir: setupResult.runDir, repoRoot: setupResult.root, worktreePath: join(setupResult.root, "worktree"), branchName: "codex/brain-hands/run-1", intake: { ...intake, repo_root: setupResult.root }, plan, codex: {} as never };
    await runGithubWorkflow({ ...base, dependencies: { github } }); const manifest = await readManifestV2(setupResult.runDir);
    let drift = true;
    github.findIssuesByMarker = vi.fn(async () => drift ? [{ number: 77, title: "Drift", body: formatIssueBody(plan.work_items[0]!, { lineageId: manifest.task_lineage_id!, runId: manifest.run_id, workItemId: "feature" }), labels: ["brain-hands"], state: "OPEN" as const, state_reason: null }] : []);
    const failed = await runGithubWorkflow({ ...base, dependencies: { github, afterIssuePreviewLineageInvalidated: async () => {
      expect((await readTaskLineage(setupResult.root, manifest.task_lineage_id!)).issue_set.preview?.state).toBe("invalidated");
      expect((await readManifestV2(setupResult.runDir)).github_effects.issue_sync?.state).toBe("previewed");
      throw new Error("crash after lineage invalidation");
    } } as GithubRuntimeDependencies });
    expect(failed.status).toBe("human_action_required"); drift = false;
    const recovered = await runGithubWorkflow({ ...base, dependencies: { github } });
    expect(recovered.status, recovered.blocker).toBe("awaiting_github_effects");
    expect(recovered.manifest.github_effects.issue_sync).toMatchObject({ revision: 2 });
    expect(github.created).toEqual([]); expect(github.updatedIssues).toEqual([]);
    await expect(readFile(join(setupResult.runDir, "github-effects/issue-sync/revision-3.json"), "utf8")).rejects.toThrow("ENOENT");
  });
});

async function seedOwnedIssue(github: RecordingGithub, runDir: string, workItemId = "feature", issueNumber = 17): Promise<void> {
  const manifest = await readManifestV2(runDir);
  github.issues.set(issueNumber, {
    number: issueNumber,
    title: workItemId,
    body: `<!-- brain-hands-run:${manifest.run_id} -->\n<!-- brain-hands-work-item:${workItemId} -->`,
    state: "OPEN",
    state_reason: null,
  });
}

async function seedReconciledIssue(
  github: RecordingGithub,
  runDir: string,
  workItem: WorkItem,
  issueNumber = 17,
  sequence = 1,
): Promise<GitHubIssueStateReference> {
  const manifest = await readManifestV2(runDir);
  let title: string;
  try {
    title = formatWorkItemIssueTitle({ featureSlug: "ship-feature", sequence, itemSlug: workItem.id, title: workItem.title });
  } catch {
    title = workItem.title;
  }
  const reference: GitHubIssueStateReference = {
    number: issueNumber,
    title,
    body: formatIssueBody(workItem, { runId: manifest.run_id, workItemId: workItem.id }),
    state: "OPEN",
    state_reason: null,
  };
  github.issues.set(issueNumber, reference);
  return reference;
}

async function runWithPostPrManifestMutation(
  setupResult: { root: string; runDir: string },
  mutate: (manifest: RunManifestV2, runDir: string) => Promise<void>,
): Promise<{ result: Awaited<ReturnType<typeof runGithubWorkflow>>; synchronizationCalls: number }> {
  const github = new RecordingGithub();
  let synchronizationCalls = 0;
  let allowSynchronization = true;
  let remoteHead: string | null = null;
  const deliverySha = "d".repeat(40);
  const workflowInput = {
    runDir: setupResult.runDir,
    repoRoot: setupResult.root,
    worktreePath: join(setupResult.root, "worktree"),
    branchName: "codex/brain-hands/run-1",
    baseBranch: "main",
    remote: "origin",
    intake: { ...intake, repo_root: setupResult.root },
    plan,
    codex: {} as never,
    deferTerminalDisposition: true,
    dependencies: {
      github,
      hands: async (input) => {
        const result = implementation(input.workItem.id);
        const reportPath = `implementation/${input.workItem.id}.json`;
        await writeTextArtifact(input.runDir, reportPath, `${JSON.stringify(result)}\n`);
        return { implementation: result, reportPath, invocation: {} as never };
      },
      verification: async (input) => evidenceForInput(input),
      verifier: async (input) => {
        const attempt = input.attempt ?? 1;
        const value = approvedReview(attempt);
        const reviewPath = await writeTextArtifact(setupResult.runDir, `reviews/integrated/final-attempt-${attempt}.json`, `${JSON.stringify(value)}\n`);
        return { review: value, reviewPath, invocation: {} as never };
      },
      gitSnapshot: async () => ({ branch: "codex/brain-hands/run-1", status: "", gitDir: ".git", gitCommonDir: ".git", isLinkedWorktree: true }),
      push: async () => "pushed",
      commit: async () => deliverySha,
      localHeadSha: async () => deliverySha,
      remoteBranchSha: async () => remoteHead,
      pushCommit: async (_repoRoot, sha) => {
        remoteHead = sha;
        return "pushed";
      },
      recordRemoteSynchronization: async () => {
        synchronizationCalls += 1;
        if (allowSynchronization) {
          const manifest = await readManifestV2(setupResult.runDir);
          const commitSha = manifest.work_item_progress.integrated?.commit_sha;
          const sha = typeof commitSha === "string" ? commitSha : "sha";
          const artifactPath = "assurance/remote-synchronization-baseline.json";
          const evidence = {
            version: 1 as const,
            run_id: manifest.run_id,
            branch_name: "codex/brain-hands/run-1",
            remote_name: "origin",
            pull_request_number: 42,
            pull_request_url: "https://github.com/acme/repo/pull/42",
            local_candidate_sha: sha,
            mapped_pr_sha: sha,
            remote_head_sha: sha,
            problems: [],
            synchronized: true,
            observed_at: new Date().toISOString(),
          };
          await writeTextArtifact(setupResult.runDir, artifactPath, `${JSON.stringify(evidence)}\n`);
          await updateManifestV2(setupResult.runDir, { remote_synchronization_path: artifactPath });
          return { artifactPath, evidence };
        }
        throw new Error("remote observation must not run for invalid synchronization inputs");
      },
    },
  } satisfies Parameters<typeof runGithubWorkflow>[0];
  let result: Awaited<ReturnType<typeof runGithubWorkflow>>;
  try {
    result = await runGithubWorkflow(workflowInput);
  } catch (error) {
    throw new Error(`initial runtime call threw: ${(error as Error).message}`);
  }
  for (let boundary = 0; result.status === "awaiting_github_effects" && boundary < 4; boundary += 1) {
    result = await runGithubWorkflow(workflowInput);
  }
  expect(result.status, result.blocker).toBe("github_ready");
  synchronizationCalls = 0;
  allowSynchronization = false;
  await updateManifestV2(setupResult.runDir, { remote_synchronization_path: null, delivery_state: "pending", last_blocker: null });
  await mutate(await readManifestV2(setupResult.runDir), setupResult.runDir);
  result = await runGithubWorkflow(workflowInput);
  return { result, synchronizationCalls };
}

async function policyPostPrHarness(
  setupResult: { root: string; runDir: string },
  github: RecordingGithub,
  interruptAt: "effect" | "intent" | "commit" | "head" | "push" | "consume" | "recheck_hands" | null,
  warningContinuation = false,
  replan = false,
  postPrChangeReviews = 1,
  rejectCandidateRecheck = false,
  maxHandsFixAttempts = 1,
  postPrVerificationFailure = true,
) {
  if ((await readManifestV2(setupResult.runDir)).workflow_protocol !== "bounded-context-v1") {
    await enableBoundedProtocol(setupResult.runDir);
  }
  const recorded = await approveBoundedPlan(setupResult.runDir);
  const initialSha = "1".repeat(40);
  const postPrSha = "2".repeat(40);
  const secondPostPrSha = "3".repeat(40);
  const intendedTreeSha = "4".repeat(40);
  const commitMessage = "work-item: integrated Integrated local delivery audit";
  const state = {
    finalReviews: 0,
    pushCalls: 0,
    pushedCommitShas: [] as string[],
    leaseBeforeShas: [] as Array<string | null>,
    raceRemoteOnPush: false,
    ambiguousPostPrPush: false,
    postPushPrDrift: null as null | "title" | "body" | "closing" | "base" | "head_ref" | "extra",
    commitCalls: 0,
    commitIntentCalls: 0,
    commitProvenanceCalls: 0,
    lastCommitInput: null as Record<string, unknown> | null,
    remoteSha: null as string | null,
    postInitialRemoteSha: initialSha as string | null,
    localSha: initialSha,
    localCommit: {
      sha: initialSha,
      parent_shas: [] as string[],
      tree_sha: "0".repeat(40),
      message: "initial",
    },
    interruptAt,
    replanPending: replan,
    mutationKinds: [] as string[],
    handsProfiles: [] as Array<string | undefined>,
    integratedVerificationAttempts: [] as number[],
    integratedHandsAttempts: [] as number[],
    integratedHandsKinds: [] as string[],
    integratedContextRefs: [] as string[],
    integratedContextBases: [] as string[],
    integratedContextDiffs: [] as string[],
    integratedBroadInputs: [] as boolean[],
    dirty: false,
    snapshotCalls: 0,
  };
  const readPullRequest = github.getPullRequest.bind(github);
  github.getPullRequest = async (number) => {
    const observed = { ...(await readPullRequest(number)), head_sha: state.remoteSha ?? state.localSha };
    if (state.remoteSha !== postPrSha) return observed;
    if (state.postPushPrDrift === "title") return { ...observed, title: "Concurrent title drift" };
    if (state.postPushPrDrift === "body") return { ...observed, body: observed.body?.replace(/Closes #\d+/, "Closes #999") };
    if (state.postPushPrDrift === "closing") return { ...observed, closing_issue_numbers: [999] };
    if (state.postPushPrDrift === "base") return { ...observed, base_ref: "other" };
    if (state.postPushPrDrift === "head_ref") return { ...observed, head_ref: "other/head" };
    return observed;
  };
  const findPullRequestsByLineage = github.findPullRequestsByLineage.bind(github);
  github.findPullRequestsByLineage = async () => {
    const found = await findPullRequestsByLineage();
    return state.remoteSha === postPrSha && state.postPushPrDrift === "extra"
      ? [...found, { ...found[0]!, number: 99, url: "https://github.com/acme/repo/pull/99" }]
      : found;
  };
  const runtimeConfig = defaultConfig();
  runtimeConfig.retry_policy.max_hands_fix_attempts = maxHandsFixAttempts;
  const workflowInput = {
    runDir: setupResult.runDir,
    repoRoot: setupResult.root,
    worktreePath: join(setupResult.root, "worktree"),
    branchName: "codex/brain-hands/run-1",
    baseBranch: "main",
    intake: { ...intake, repo_root: setupResult.root },
    plan,
    config: runtimeConfig,
    codex: replan ? {
      invoke: async (invocation: { prompt: string }) => {
        const findingIds = [...new Set(invocation.prompt.match(/finding:[a-f0-9]{64}/g) ?? [])];
        if (findingIds.length === 0) throw new Error("Replan prompt is missing its unresolved finding IDs");
        const patch = {
          target_work_item_id: "feature",
          base_plan_revision: recorded.revision,
          unresolved_finding_ids: findingIds,
          revised_objective: "feature revised",
          added_or_changed_criteria: [{ ref: "BH-001:AC-1", text: "feature works revised" }],
          changed_instructions: ["Fix feature under the approved revision."],
          added_change_units: [],
          added_verification_commands: [{
            id: "replan-feature-VERIFY-01",
            argv: ["node", "node_modules/vitest/vitest.mjs", "run", "tests/feature-replan.test.ts"],
            expected_exit_code: 0,
            tier: "focused",
            satisfies: ["feature-AC-01"],
          }],
          added_cross_cutting_impacts: [],
          added_read_only_file_contracts: [],
          explicitly_rejected_hardening: [],
        };
        return { text: JSON.stringify(patch), parsed: patch, exitCode: 0, promptPath: "prompt", stdoutPath: "stdout", stderrPath: "stderr" , ...codexMetrics };
      },
    } as never : {} as never,
    dependencies: {
      github,
      hands: async (input) => {
        state.handsProfiles.push(input.profile?.model);
        if (input.workItem.id === "integrated") {
          state.integratedHandsAttempts.push(input.attempt ?? 1);
          state.integratedHandsKinds.push(`${input.attempt}:${input.attemptKind}`);
          state.integratedContextRefs.push(input.contextRef ? `${input.contextRef.path}:${input.contextRef.sha256}` : "missing");
          state.integratedContextBases.push((await readManifestV2(input.runDir)).work_item_progress.integrated?.context_base_commit ?? "missing");
          state.integratedContextDiffs.push(input.context?.diff ?? "missing");
          state.integratedBroadInputs.push(Object.hasOwn(input, "findings") || Object.hasOwn(input, "diagnosticContext"));
          state.dirty = true;
        }
        const value = input.workItem.id === "integrated"
          ? { ...implementation("integrated"), changed_files: ["src/feature.ts"] }
          : implementation(input.workItem.id);
        const reportPath = `implementation/${input.workItem.id}/attempt-${input.attempt}.json`;
        await writeTextArtifact(input.runDir, reportPath, `${JSON.stringify(value)}\n`);
        return { implementation: value, reportPath, invocation: {} as never };
      },
      verification: async (input) => {
        if (input.identity?.work_item_id === "integrated") state.integratedVerificationAttempts.push(input.attempt ?? 1);
        const value = await evidenceForInput(input);
        const resolved = postPrVerificationFailure && !warningContinuation && input.identity?.work_item_id === "integrated" && input.attempt === 2
          ? { ...value, commands: value.commands.map((command) => ({ ...command, exit_code: 1 })) }
          : value;
        for (const command of resolved.commands) {
          await writeTextArtifact(input.runDir, command.stdout_path, "stdout\n");
          await writeTextArtifact(input.runDir, command.stderr_path, "stderr\n");
          await writeTextArtifact(input.runDir, command.result_path!, `${JSON.stringify({
            argv: command.argv ?? [], stdout: "stdout\n", stderr: "stderr\n",
            exit_code: command.exit_code, duration_ms: command.duration_ms ?? 0,
            timed_out: command.timed_out, error_code: command.error_code,
            error_message: command.error_message, signal: command.signal,
          })}\n`);
        }
        await writeTextArtifact(input.runDir, resolved.evidence_path!, `${JSON.stringify(resolved)}\n`);
        return resolved;
      },
      selfReview: async (input) => {
        state.mutationKinds.push(`${input.workItem.id}:${input.mutationKind}:${input.parentAttempt}:${input.pass}`);
        const report = selfReviewReport(input.workItem.id, input.parentAttempt, input.pass, input.mutationKind);
        const path = `self-review/${input.workItem.id}/attempt-${input.parentAttempt}/pass-${input.pass}.json`;
        await writeTextArtifact(input.runDir, path, `${JSON.stringify(report)}\n`);
        return { report, reportPath: path, invocation: {} as never };
      },
      diff: async () => "post-PR policy diff",
      collectScopedWorktreeDiff: async (input) => ({
        base_commit: input.baseCommit,
        head_commit: state.localSha,
        changed_files: state.dirty ? ["src/feature.ts"] : [],
        patch: state.dirty ? `post-PR policy diff from ${input.baseCommit}` : "",
        patch_bytes: state.dirty ? Buffer.byteLength(`post-PR policy diff from ${input.baseCommit}`, "utf8") : 0,
      }),
      verifier: async (input) => {
        const bounded = (await readManifestV2(input.runDir)).workflow_protocol === "bounded-context-v1";
        if (bounded) {
          expect(input.contextRef).toBeDefined();
          expect(input.context).toMatchObject({ role: "verifier", phase: input.phase });
          expect(input.context?.verification_ref.path).toBe(verifierEvidenceRef(input));
          expect(Object.hasOwn(input, "implementation")).toBe(false);
          expect(Object.hasOwn(input, "verification")).toBe(false);
          expect(Object.hasOwn(input, "priorVerification")).toBe(false);
          if (input.final) {
            expect(["final_integrated", "post_pr"]).toContain(input.phase);
            if (input.phase !== "final_integrated" && input.phase !== "post_pr") {
              throw new Error("Bounded terminal Verifier test input has a non-terminal phase");
            }
            expect(input.context?.evidence_index_ref?.path).toBe(
              evidenceIndexWorkflow.verifierEvidenceIndexPath(input.phase, input.attempt ?? 1),
            );
          } else {
            expect(input.phase).toBe("work_item");
            expect(input.context?.evidence_index_ref).toBeNull();
          }
        } else {
          expect(input.contextRef).toBeUndefined();
          expect(input.context).toBeUndefined();
        }
        if (input.final) state.finalReviews += 1;
        const requested = input.final
          && (rejectCandidateRecheck
            ? state.finalReviews === 2 || state.finalReviews === 4
            : state.finalReviews >= 2 && state.finalReviews <= postPrChangeReviews + 1)
          && (!replan || state.replanPending);
        const workItemId = input.final ? "integrated" : input.workItem.id;
        const attempt = input.attempt ?? 1;
        const finding = requested ? [{
          severity: "medium" as const, file: "src/feature.ts", line: null,
          acceptance_criterion: "feature works", problem_class: "correctness" as const,
          problem: "missing", required_fix: "fix", evidence_refs: [verifierEvidenceRef(input)], re_verification: [],
        }] : [];
        const review: VerifierReview = {
          work_item_id: workItemId, attempt, final: Boolean(input.final),
          decision: requested ? (replan ? "replan_required" : "request_changes") : "approve",
          failure_class: requested ? (replan ? "replan_required" : "implementation_failure") : "none", blocker: null, blocker_code: null,
          acceptance_coverage: input.workItem.completion_contract.required_acceptance_ids,
          evidence_reviewed: [verifierEvidenceRef(input)], findings: finding, residual_risks: [],
        };
        const reviewPath = input.final
          ? `reviews/integrated/final-attempt-${attempt}.json`
          : `reviews/${workItemId}/attempt-${attempt}.json`;
        return { review, reviewPath: await writeTextArtifact(setupResult.runDir, reviewPath, `${JSON.stringify(review)}\n`), invocation: {} as never };
      },
      gitSnapshot: async () => {
        const status = state.dirty || (warningContinuation && state.snapshotCalls === 1) ? " M src/feature.ts\n" : "";
        state.snapshotCalls += 1;
        return { branch: "codex/brain-hands/run-1", status, gitDir: ".git", gitCommonDir: ".git", isLinkedWorktree: true };
      },
      hasWorktreeChanges: async () => false,
      prepareCommitIntent: async () => {
        state.commitIntentCalls += 1;
        return { parent_sha: state.localSha, tree_sha: state.commitCalls === 0 ? intendedTreeSha : "5".repeat(40), message: commitMessage };
      },
      commit: async (commitInput) => {
        state.lastCommitInput = commitInput as unknown as Record<string, unknown>;
        const parentSha = state.localSha;
        const treeSha = state.commitCalls === 0 ? intendedTreeSha : "5".repeat(40);
        state.commitCalls += 1;
        state.localSha = state.commitCalls === 1 ? postPrSha : secondPostPrSha;
        state.localCommit = { sha: state.localSha, parent_shas: [parentSha], tree_sha: treeSha, message: commitMessage };
        state.dirty = false;
        return state.localSha;
      },
      push: async () => {
        state.pushCalls += 1;
        state.remoteSha = state.pushCalls === 1 ? state.postInitialRemoteSha : postPrSha;
        return "pushed";
      },
      pushCommit: async (_repoRoot: string, sha: string, _branch: string, before: string | null) => {
        state.pushCalls += 1;
        state.pushedCommitShas.push(sha);
        state.leaseBeforeShas.push(before);
        if (state.raceRemoteOnPush && sha === postPrSha) {
          state.remoteSha = "0".repeat(40);
          throw new Error("atomic push lease rejected");
        }
        state.remoteSha = sha;
        if (state.ambiguousPostPrPush && sha === postPrSha) throw new Error("push response lost after remote accepted commit");
        return "pushed";
      },
      remoteBranchSha: async () => state.remoteSha,
      remoteBranchAtLocalHead: async () => {
        if (state.postInitialRemoteSha !== initialSha) state.remoteSha = state.postInitialRemoteSha;
        if (state.remoteSha === null) throw new Error("Remote PR branch does not exist");
        if (state.remoteSha !== state.localSha) throw new Error("Remote PR branch does not equal local HEAD");
        return state.localSha;
      },
      localHeadSha: async () => state.localSha,
      localCommitProvenance: async () => {
        state.commitProvenanceCalls += 1;
        return state.localCommit;
      },
      afterCheckpoint: async (checkpoint: string) => {
        if (state.interruptAt === "effect" && checkpoint === "after_post_pr_effect_complete") {
          state.interruptAt = null;
          throw new Error("crash after completed post-PR fix effect");
        }
        if (state.interruptAt === "intent" && checkpoint === "after_post_pr_commit_intent") {
          state.interruptAt = null;
          throw new Error("crash after durable post-PR commit intent");
        }
        if (state.interruptAt === "commit" && checkpoint === "after_post_pr_commit") {
          state.interruptAt = "push";
          throw new Error("crash after successful post-PR commit");
        }
        if (state.interruptAt === "head" && checkpoint === "after_post_pr_head_authority") {
          state.interruptAt = "push";
          throw new Error("crash after post-PR head authority advance");
        }
        if (state.interruptAt === "push" && checkpoint === "after_post_pr_push") {
          state.interruptAt = null;
          throw new Error("crash after successful post-PR push");
        }
        if (state.interruptAt === "consume" && checkpoint === "after_post_pr_head_consumption") {
          state.interruptAt = null;
          throw new Error("crash after post-PR head authority consumption");
        }
        if (state.interruptAt === "recheck_hands" && checkpoint === "after_candidate_recheck_hands_report") {
          state.interruptAt = null;
          throw new Error("crash after candidate-recheck Hands report");
        }
      },
    },
  } as Parameters<typeof runGithubWorkflow>[0];
  return { state, workflowInput, initialSha, postPrSha, intendedTreeSha, commitMessage };
}

async function exactFastResumeHarness(withParent = false) {
  const setupResult = await setup();
  root = setupResult.root;
  const github = new RecordingGithub();
  const initialManifest = await readManifestV2(setupResult.runDir);
  const marker = { lineageId: initialManifest.task_lineage_id!, runId: initialManifest.run_id, workItemId: "feature" };
  const existingIssue = {
    number: 17, title: "[ship-feature:feature] Implement feature", body: formatIssueBody(plan.work_items[0]!, marker),
    labels: ISSUE_LABELS.split(","), state: "OPEN" as const, state_reason: null,
  };
  github.issues.set(17, existingIssue);
  github.findIssuesByMarker = async () => [existingIssue];
  const currentHead = headSha(join(setupResult.root, "worktree"));
  const runPlan = withParent ? { ...plan, parent_issue: { title: "Ship feature" } } : plan;
  github.pullRequest = {
    number: 42, url: "https://github.com/acme/repo/pull/42", title: `Task: ${runPlan.summary}`,
    head_ref: "codex/brain-hands/run-1", head_sha: currentHead, base_ref: "main",
    body: plan.summary, closing_issue_numbers: [], state: "OPEN",
  };
  const workflowInput: Parameters<typeof runGithubWorkflow>[0] = {
    runDir: setupResult.runDir, repoRoot: setupResult.root, worktreePath: join(setupResult.root, "worktree"),
    branchName: "codex/brain-hands/run-1", baseBranch: "main", intake: { ...intake, repo_root: setupResult.root }, plan: runPlan, codex: {} as never,
    dependencies: {
      github,
      hands: async (input) => {
        const value = implementation(input.workItem.id); const reportPath = "implementation/item.json";
        await writeTextArtifact(setupResult.runDir, reportPath, `${JSON.stringify(value)}\n`);
        return { implementation: value, reportPath, invocation: {} as never };
      },
      verification: async (input) => evidenceForInput(input),
      verifier: async (input) => {
        const attempt = input.attempt ?? 1; const value = approvedReview(attempt);
        return { review: value, reviewPath: await writeTextArtifact(setupResult.runDir, `reviews/integrated/final-attempt-${attempt}.json`, `${JSON.stringify(value)}\n`), invocation: {} as never };
      },
      gitSnapshot: async () => ({ branch: "codex/brain-hands/run-1", status: "", gitDir: ".git", gitCommonDir: ".git", isLinkedWorktree: true }),
      localHeadSha: async () => currentHead, remoteBranchSha: async () => currentHead,
      pushCommit: async () => { throw new Error("exact existing delivery must not push"); },
      push: async () => "pushed", commit: async () => "sha",
    },
  };
  expect((await runGithubWorkflow(workflowInput)).status).toBe("awaiting_github_effects");
  expect((await runGithubWorkflow(workflowInput)).status).toBe("awaiting_github_effects");
  const ready = await runGithubWorkflow(workflowInput);
  expect(ready.status, ready.blocker).toBe("github_ready");
  return { setupResult, github, workflowInput };
}

async function runPastGithubEffectBoundaries(
  input: Parameters<typeof runGithubWorkflow>[0],
): Promise<Awaited<ReturnType<typeof runGithubWorkflow>>> {
  const manifest = await readManifestV2(input.runDir);
  const lineage = manifest.task_lineage_id === null ? null : await readTaskLineage(input.repoRoot, manifest.task_lineage_id);
  let remoteHead = lineage?.delivery.state === "applying" || lineage?.delivery.state === "ready"
    ? lineage.delivery.head_sha
    : lineage?.delivery.preview_prior_head_sha ?? null;
  const workflowInput = input.dependencies.remoteBranchSha || input.dependencies.pushCommit
    ? input
    : {
        ...input,
        dependencies: {
          ...input.dependencies,
          remoteBranchSha: async () => remoteHead,
          pushCommit: async (_root: string, commitSha: string, _branch: string, expected: string | null) => {
            if (expected !== remoteHead) throw new Error("test remote lease mismatch");
            remoteHead = commitSha;
            return "pushed";
          },
        },
      };
  const hands = workflowInput.dependencies.hands;
  const hydratedInput = hands === undefined
    ? workflowInput
    : {
        ...workflowInput,
        dependencies: {
          ...workflowInput.dependencies,
          hands: async (...args: Parameters<NonNullable<typeof hands>>) => {
            const result = await hands(...args);
            try {
              await readFile(join(input.runDir, result.reportPath));
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
              await writeTextArtifact(input.runDir, result.reportPath, `${JSON.stringify(result.implementation)}\n`);
            }
            return result;
          },
        },
      };
  let result = await runGithubWorkflow(hydratedInput);
  for (let boundary = 0; result.status === "awaiting_github_effects" && boundary < 3; boundary += 1) {
    result = await runGithubWorkflow(hydratedInput);
  }
  return result;
}

let root: string | undefined;
afterEach(async () => { vi.restoreAllMocks(); if (root) await rm(root, { recursive: true, force: true }); root = undefined; });

describe("runGithubWorkflow", () => {
  it("runs bootstrap and every viability check before the first GitHub observation", async () => {
    const setupResult = await setup();
    const baseline = headSha(join(setupResult.root, "worktree"));
    await updateManifestV2(setupResult.runDir, { source_commit: baseline });
    const calls: string[] = [];
    const mutations: string[] = [];
    const github = new RecordingGithub();
    github.findIssuesByMarker = async () => {
      calls.push("github-observation");
      throw new Error("stop after observation");
    };
    github.createIssue = async () => { mutations.push("createIssue"); return 17; };
    github.updateIssue = async () => { mutations.push("updateIssue"); };
    (github as GitHubAdapter).reconcileIssueStateLabel = async () => { mutations.push("reconcileIssueStateLabel"); };
    github.openIntegratedPullRequest = async () => { mutations.push("openIntegratedPullRequest"); return { number: 42, url: "https://github.com/acme/repo/pull/42" }; };
    github.updatePullRequestBody = async () => { mutations.push("updatePullRequestBody"); };
    executionViabilityMock.mockImplementationOnce(async (input: { plan: BrainPlan }) => {
      calls.push("plan-readiness", "worktree-identity", "model-catalog", "github-capabilities", "github-setup");
      return {
        repository: { host: "github.com", name_with_owner: "acme/repo", actor: "operator" },
        report: {},
        plan: input.plan,
      };
    });
    const bootstrapPlan: BrainPlan = {
      ...plan,
      controller_bootstrap: {
        version: 1,
        baseline_commit: baseline,
        preserved_head: "b".repeat(40),
        source_worktree: ".brain-hands/worktrees/preserved-run",
        commit_message: "controller-bootstrap: preserve lifecycle",
        files: [{ path: "src/cli.ts", source_status: "tracked", sha256: "c".repeat(64) }],
      },
    };
    const bootstrapRevision = await recordPlan(setupResult.runDir, `${JSON.stringify(bootstrapPlan)}\n`);
    await approvePlanRevision(setupResult.runDir, bootstrapRevision.revision, { actor: "test" });

    const result = await runGithubWorkflow({
      runDir: setupResult.runDir,
      repoRoot: setupResult.root,
      worktreePath: join(setupResult.root, "worktree"),
      branchName: "codex/brain-hands/run-1",
      intake: { ...intake, repo_root: setupResult.root },
      plan: bootstrapPlan,
      codex: {} as never,
      dependencies: {
        github,
        controllerBootstrap: async () => { calls.push("controller-bootstrap"); return {} as never; },
        push: async () => { mutations.push("push"); return "pushed"; },
        hands: async () => { throw new Error("Hands must not run"); },
      },
    });

    expect(result.status).toBe("human_action_required");
    expect(calls).toEqual([
      "controller-bootstrap",
      "plan-readiness",
      "worktree-identity",
      "model-catalog",
      "github-capabilities",
      "github-setup",
      "github-observation",
      "github-observation",
    ]);
    expect(mutations).toEqual([]);
  });

  it("runs bootstrap then rejects a valid caller plan substituted for the approved bytes", async () => {
    const setupResult = await setup();
    const baseline = headSha(join(setupResult.root, "worktree"));
    await updateManifestV2(setupResult.runDir, { source_commit: baseline });
    const bootstrap = {
      version: 1 as const,
      baseline_commit: baseline,
      preserved_head: "b".repeat(40),
      source_worktree: ".brain-hands/worktrees/preserved-run",
      commit_message: "controller-bootstrap: preserve lifecycle",
      files: [{ path: "src/cli.ts", source_status: "tracked" as const, sha256: "c".repeat(64) }],
    };
    const approvedPlan: BrainPlan = { ...plan, controller_bootstrap: bootstrap };
    const recorded = await recordPlan(setupResult.runDir, `${JSON.stringify(approvedPlan)}\n`);
    await approvePlanRevision(setupResult.runDir, recorded.revision, { actor: "test" });
    const callerBootstrap = {
      ...bootstrap,
      preserved_head: "d".repeat(40),
      commit_message: "caller-substituted bootstrap",
    };
    const callerPlan: BrainPlan = { ...approvedPlan, controller_bootstrap: callerBootstrap };
    const calls: string[] = [];
    const mutations: string[] = [];
    const bootstrapInputs: unknown[] = [];
    const github = new RecordingGithub();
    github.findIssueByMarker = async () => { calls.push("github-observation"); return null; };
    github.createIssue = async () => { mutations.push("createIssue"); return 17; };
    github.updateIssue = async () => { mutations.push("updateIssue"); };
    (github as GitHubAdapter).reconcileIssueStateLabel = async () => { mutations.push("reconcileIssueStateLabel"); };
    github.openIntegratedPullRequest = async () => { mutations.push("openIntegratedPullRequest"); return { number: 42, url: "https://github.com/acme/repo/pull/42" }; };
    github.updatePullRequestBody = async () => { mutations.push("updatePullRequestBody"); };
    const actual = await vi.importActual<typeof import("../../src/workflow/execution-viability.js")>("../../src/workflow/execution-viability.js");
    executionViabilityMock.mockImplementationOnce(actual.assertGithubExecutionViable);

    const result = await runGithubWorkflow({
      runDir: setupResult.runDir,
      repoRoot: setupResult.root,
      worktreePath: join(setupResult.root, "worktree"),
      branchName: "codex/brain-hands/run-1",
      intake: { ...intake, repo_root: setupResult.root },
      plan: callerPlan,
      codex: {} as never,
      dependencies: {
        github,
        controllerBootstrap: async (bootstrapInput) => {
          calls.push("controller-bootstrap");
          bootstrapInputs.push(bootstrapInput.spec);
          return {} as never;
        },
        push: async () => { mutations.push("push"); return "pushed"; },
        hands: async () => { throw new Error("Hands must not run"); },
      },
    });

    expect(result.status).toBe("human_action_required");
    expect(calls).toEqual(["controller-bootstrap"]);
    expect(bootstrapInputs).toEqual([bootstrap]);
    expect(mutations).toEqual([]);
    expect(JSON.parse(await readFile(join(setupResult.runDir, "execution-viability.json"), "utf8"))).toMatchObject({
      repository_key: "unresolved",
      plan_revision: recorded.revision,
      plan_sha256: recorded.sha256,
      checks: [{ name: "plan-readiness", status: "failed" }],
    });
  });

  it("does not bootstrap when approved bytes omit a caller-supplied bootstrap", async () => {
    const setupResult = await setup();
    const baseline = headSha(join(setupResult.root, "worktree"));
    await updateManifestV2(setupResult.runDir, { source_commit: baseline });
    const approvedPlan: BrainPlan = { ...plan };
    const recorded = await recordPlan(setupResult.runDir, `${JSON.stringify(approvedPlan)}\n`);
    await approvePlanRevision(setupResult.runDir, recorded.revision, { actor: "test" });
    const callerPlan: BrainPlan = {
      ...approvedPlan,
      controller_bootstrap: {
        version: 1,
        baseline_commit: baseline,
        preserved_head: "b".repeat(40),
        source_worktree: ".brain-hands/worktrees/preserved-run",
        commit_message: "caller-only bootstrap",
        files: [{ path: "src/cli.ts", source_status: "tracked", sha256: "c".repeat(64) }],
      },
    };
    const calls: string[] = [];
    const mutations: string[] = [];
    const github = new RecordingGithub();
    github.findIssueByMarker = async () => { calls.push("github-observation"); return null; };
    github.createIssue = async () => { mutations.push("createIssue"); return 17; };
    github.updateIssue = async () => { mutations.push("updateIssue"); };
    const actual = await vi.importActual<typeof import("../../src/workflow/execution-viability.js")>("../../src/workflow/execution-viability.js");
    executionViabilityMock.mockImplementationOnce(actual.assertGithubExecutionViable);

    const result = await runGithubWorkflow({
      runDir: setupResult.runDir,
      repoRoot: setupResult.root,
      worktreePath: join(setupResult.root, "worktree"),
      branchName: "codex/brain-hands/run-1",
      intake: { ...intake, repo_root: setupResult.root },
      plan: callerPlan,
      codex: {} as never,
      dependencies: {
        github,
        controllerBootstrap: async () => { calls.push("controller-bootstrap"); return {} as never; },
        push: async () => { mutations.push("push"); return "pushed"; },
        hands: async () => { throw new Error("Hands must not run"); },
      },
    });

    expect(result.status).toBe("human_action_required");
    expect(calls).toEqual([]);
    expect(mutations).toEqual([]);
    expect(JSON.parse(await readFile(join(setupResult.runDir, "execution-viability.json"), "utf8"))).toMatchObject({
      plan_revision: recorded.revision,
      plan_sha256: recorded.sha256,
      repository_key: "unresolved",
      checks: [{ name: "plan-readiness", status: "failed" }],
    });
  });

  it("runs the approved bootstrap when the caller omits it, then rejects substitution", async () => {
    const setupResult = await setup();
    const baseline = headSha(join(setupResult.root, "worktree"));
    await updateManifestV2(setupResult.runDir, { source_commit: baseline });
    const bootstrap = {
      version: 1 as const,
      baseline_commit: baseline,
      preserved_head: "b".repeat(40),
      source_worktree: ".brain-hands/worktrees/preserved-run",
      commit_message: "approved-only bootstrap",
      files: [{ path: "src/cli.ts", source_status: "tracked" as const, sha256: "c".repeat(64) }],
    };
    const approvedPlan: BrainPlan = { ...plan, controller_bootstrap: bootstrap };
    const recorded = await recordPlan(setupResult.runDir, `${JSON.stringify(approvedPlan)}\n`);
    await approvePlanRevision(setupResult.runDir, recorded.revision, { actor: "test" });
    const callerPlan: BrainPlan = { ...plan };
    const calls: string[] = [];
    const mutations: string[] = [];
    const bootstrapInputs: unknown[] = [];
    const github = new RecordingGithub();
    github.findIssueByMarker = async () => { calls.push("github-observation"); return null; };
    github.createIssue = async () => { mutations.push("createIssue"); return 17; };
    github.updateIssue = async () => { mutations.push("updateIssue"); };
    const actual = await vi.importActual<typeof import("../../src/workflow/execution-viability.js")>("../../src/workflow/execution-viability.js");
    executionViabilityMock.mockImplementationOnce(actual.assertGithubExecutionViable);

    const result = await runGithubWorkflow({
      runDir: setupResult.runDir,
      repoRoot: setupResult.root,
      worktreePath: join(setupResult.root, "worktree"),
      branchName: "codex/brain-hands/run-1",
      intake: { ...intake, repo_root: setupResult.root },
      plan: callerPlan,
      codex: {} as never,
      dependencies: {
        github,
        controllerBootstrap: async (bootstrapInput) => {
          calls.push("controller-bootstrap");
          bootstrapInputs.push(bootstrapInput.spec);
          return {} as never;
        },
        push: async () => { mutations.push("push"); return "pushed"; },
        hands: async () => { throw new Error("Hands must not run"); },
      },
    });

    expect(result.status).toBe("human_action_required");
    expect(calls).toEqual(["controller-bootstrap"]);
    expect(bootstrapInputs).toEqual([bootstrap]);
    expect(mutations).toEqual([]);
    expect(JSON.parse(await readFile(join(setupResult.runDir, "execution-viability.json"), "utf8"))).toMatchObject({
      plan_revision: recorded.revision,
      plan_sha256: recorded.sha256,
      repository_key: "unresolved",
      checks: [{ name: "plan-readiness", status: "failed" }],
    });
  });

  it("rejects tampered approved bootstrap bytes with a stable path-free blocker before effects", async () => {
    const setupResult = await setup();
    const baseline = headSha(join(setupResult.root, "worktree"));
    await updateManifestV2(setupResult.runDir, { source_commit: baseline });
    const bootstrapPlan: BrainPlan = {
      ...plan,
      controller_bootstrap: {
        version: 1,
        baseline_commit: baseline,
        preserved_head: "b".repeat(40),
        source_worktree: ".brain-hands/worktrees/preserved-run",
        commit_message: "approved bootstrap",
        files: [{ path: "src/cli.ts", source_status: "tracked", sha256: "c".repeat(64) }],
      },
    };
    const recorded = await recordPlan(setupResult.runDir, `${JSON.stringify(bootstrapPlan)}\n`);
    await approvePlanRevision(setupResult.runDir, recorded.revision, { actor: "test" });
    await writeFile(recorded.path, `${JSON.stringify({ ...bootstrapPlan, summary: "tampered" })}\n`, "utf8");
    const calls: string[] = [];
    const mutations: string[] = [];
    const github = new RecordingGithub();
    github.findIssueByMarker = async () => { calls.push("github-observation"); return null; };
    github.createIssue = async () => { mutations.push("createIssue"); return 17; };
    github.updateIssue = async () => { mutations.push("updateIssue"); };

    const result = await runGithubWorkflow({
      runDir: setupResult.runDir,
      repoRoot: setupResult.root,
      worktreePath: join(setupResult.root, "worktree"),
      branchName: "codex/brain-hands/run-1",
      intake: { ...intake, repo_root: setupResult.root },
      plan: bootstrapPlan,
      codex: {} as never,
      dependencies: {
        github,
        controllerBootstrap: async () => { calls.push("controller-bootstrap"); return {} as never; },
        push: async () => { mutations.push("push"); return "pushed"; },
        hands: async () => { throw new Error("Hands must not run"); },
      },
    });

    expect(result.status).toBe("human_action_required");
    expect(result.blocker).toBe("GitHub runtime failed: Approved controller bootstrap plan binding is invalid");
    expect(result.blocker).not.toMatch(/private|tmp|plans\/revision|tampered/i);
    expect(calls).toEqual([]);
    expect(mutations).toEqual([]);
    expect(executionViabilityMock).not.toHaveBeenCalled();
  });

  for (const malformed of [
    { name: "duplicate", workItems: [item("feature"), item("feature")] },
    { name: "missing", workItems: [item("feature"), item("dependent")] },
    { name: "cycle", workItems: [item("first", ["second"]), item("second", ["first"])] },
  ]) {
    it(`runs bootstrap before rejecting a ${malformed.name} work-item graph`, async () => {
      const setupResult = await setup();
      const baseline = headSha(join(setupResult.root, "worktree"));
      await updateManifestV2(setupResult.runDir, { source_commit: baseline });
      const bootstrap = {
        version: 1 as const,
        baseline_commit: baseline,
        preserved_head: "b".repeat(40),
        source_worktree: ".brain-hands/worktrees/preserved-run",
        commit_message: "controller-bootstrap: preserve lifecycle",
        files: [{ path: "src/cli.ts", source_status: "tracked" as const, sha256: "c".repeat(64) }],
      };
      const approvedPlan: BrainPlan = { ...plan, controller_bootstrap: bootstrap };
      const recorded = await recordPlan(setupResult.runDir, `${JSON.stringify(approvedPlan)}\n`);
      await approvePlanRevision(setupResult.runDir, recorded.revision, { actor: "test" });
      const callerPlan = { ...approvedPlan, work_items: malformed.name === "missing"
        ? [item("dependent", ["missing"])]
        : malformed.workItems } as BrainPlan;
      const calls: string[] = [];
      const mutations: string[] = [];
      const github = new RecordingGithub();
      github.findIssueByMarker = async () => { calls.push("github-observation"); return null; };
      github.createIssue = async () => { mutations.push("createIssue"); return 17; };
      github.updateIssue = async () => { mutations.push("updateIssue"); };
      const actual = await vi.importActual<typeof import("../../src/workflow/execution-viability.js")>("../../src/workflow/execution-viability.js");
      executionViabilityMock.mockImplementationOnce(actual.assertGithubExecutionViable);

      const result = await runGithubWorkflow({
        runDir: setupResult.runDir,
        repoRoot: setupResult.root,
        worktreePath: join(setupResult.root, "worktree"),
        branchName: "codex/brain-hands/run-1",
        intake: { ...intake, repo_root: setupResult.root },
        plan: callerPlan,
        codex: {} as never,
        dependencies: {
          github,
          controllerBootstrap: async () => { calls.push("controller-bootstrap"); return {} as never; },
          push: async () => { mutations.push("push"); return "pushed"; },
          hands: async () => { throw new Error("Hands must not run"); },
        },
      });

      expect(result.status).toBe("human_action_required");
      expect(calls).toEqual(["controller-bootstrap"]);
      expect(mutations).toEqual([]);
      expect(JSON.parse(await readFile(join(setupResult.runDir, "execution-viability.json"), "utf8"))).toMatchObject({
        repository_key: "unresolved",
        checks: [{ name: "plan-readiness", status: "failed" }],
      });
    });
  }

  it("keeps a safe-report persistence failure path out of the runtime blocker", async () => {
    const setupResult = await setup();
    executionViabilityMock.mockRejectedValueOnce(new Error("GitHub execution viability failed: plan-readiness; safe report persistence failed"));

    const result = await runGithubWorkflow({
      runDir: setupResult.runDir,
      repoRoot: setupResult.root,
      worktreePath: join(setupResult.root, "worktree"),
      branchName: "codex/brain-hands/run-1",
      intake: { ...intake, repo_root: setupResult.root },
      plan,
      codex: {} as never,
      dependencies: { github: new RecordingGithub(), hands: async () => { throw new Error("Hands must not run"); } },
    });

    expect(result.status).toBe("human_action_required");
    expect(result.blocker).toContain("safe report persistence failed");
    expect(result.blocker).not.toMatch(/private|secret|manifest\.json|write failed/i);
  });

  it("does not invoke the post-PR Verifier when the post-PR index cannot be reloaded", async () => {
    const setupResult = await setup(true, false, true); root = setupResult.root;
    await enableBoundedProtocol(setupResult.runDir);
    const github = new RecordingGithub();
    const { workflowInput } = await policyPostPrHarness(setupResult, github, null);
    const verification = workflowInput.dependencies.verification!;
    workflowInput.dependencies.verification = async (input) => {
      const value = await verification(input);
      const command = input.commands[0];
      const argv = Array.isArray(command) ? [...command] : [command ?? "npm test"];
      value.commands[0]!.argv = argv;
      value.commands[0]!.command = argv.join(" ");
      await writeTextArtifact(input.runDir, value.commands[0]!.result_path!, `${JSON.stringify({
        argv,
        stdout: "stdout\n",
        stderr: "stderr\n",
        exit_code: value.commands[0]!.exit_code,
        duration_ms: value.commands[0]!.duration_ms ?? 0,
        timed_out: value.commands[0]!.timed_out,
        error_code: value.commands[0]!.error_code,
        error_message: value.commands[0]!.error_message,
        signal: value.commands[0]!.signal,
      })}\n`);
      await writeTextArtifact(input.runDir, value.evidence_path!, `${JSON.stringify(value)}\n`);
      return value;
    };
    const verifier = vi.fn(workflowInput.dependencies.verifier!);
    workflowInput.dependencies.verifier = verifier;
    const loadEvidenceIndex = evidenceIndexWorkflow.loadEvidenceIndex;
    vi.spyOn(evidenceIndexWorkflow, "loadEvidenceIndex").mockImplementation(async (runDir, reference, expected) => {
      if (expected.phase === "post_pr") throw new Error("simulated stale post-PR evidence index");
      return loadEvidenceIndex(runDir, reference, expected);
    });

    const result = await runPastGithubEffectBoundaries(workflowInput);

    expect(result.status).toBe("human_action_required");
    expect(result.blocker).toMatch(/evidence index|post-PR/i);
    expect(verifier.mock.calls.filter(([input]) => input.final === true)).toHaveLength(1);
  }, 120_000);

  it("publishes bounded completion only after the summary pointer is durable", async () => {
    const setupResult = await setup(true, false, true); root = setupResult.root;
    await enableBoundedProtocol(setupResult.runDir);
    await approveBoundedPlan(setupResult.runDir);
    const github = new RecordingGithub();
    let completionPublicationObserved = false;
    const upsert = github.upsertRunStatus.bind(github);
    github.upsertRunStatus = async (target, marker, body) => {
      const progress = (await readManifestV2(setupResult.runDir)).work_item_progress.feature;
      if (progress?.status === "complete") {
        expect(progress.summary_path).toBeTruthy();
        expect(progress.summary_sha256).toMatch(/^[a-f0-9]{64}$/);
        completionPublicationObserved = true;
      }
      await upsert(target, marker, body);
    };
    let crash = true;
    const dependencies: GithubRuntimeDependencies = {
      github,
      hands: async (input) => {
        const value = implementation(input.workItem.id);
        const reportPath = `implementation/${input.workItem.id}/attempt-${input.attempt}.json`;
        await writeTextArtifact(input.runDir, reportPath, `${JSON.stringify(value)}\n`);
        return { implementation: value, reportPath, invocation: {} as never };
      },
      verification: async (input) => {
        if (!input.identity) throw new Error("missing verification identity");
        const value = await evidenceForInput(input);
        const command = input.commands[0];
        const argv = Array.isArray(command) ? [...command] : [command ?? "npm test"];
        value.commands[0]!.argv = argv;
        value.commands[0]!.command = argv.join(" ");
        await writeTextArtifact(input.runDir, value.commands[0]!.result_path!, `${JSON.stringify({
          argv: value.commands[0]!.argv,
          stdout: "stdout\n",
          stderr: "stderr\n",
          exit_code: 0,
          duration_ms: 0,
          timed_out: false,
          error_code: null,
          error_message: null,
          signal: null,
        })}\n`);
        await writeTextArtifact(input.runDir, value.evidence_path!, `${JSON.stringify(value)}\n`);
        return value;
      },
      verifier: async (input) => {
        if (input.final) {
          const current = await readManifestV2(input.runDir);
          const phase = current.work_item_progress.integrated?.delivery_phase === "post_pr" ? "post_pr" : "final_integrated";
          expect(current.final_verifier_index_path).toBe(
            evidenceIndexWorkflow.verifierEvidenceIndexPath(phase, input.attempt ?? 1),
          );
        }
        const value: VerifierReview = {
          ...review(input.workItem.id, input.attempt ?? 1, Boolean(input.final)),
          failure_class: "none",
          blocker: null,
          blocker_code: null,
          acceptance_coverage: input.workItem.completion_contract.required_acceptance_ids,
          evidence_reviewed: [verifierEvidenceRef(input)],
        };
        const path = input.final
          ? `reviews/integrated/final-attempt-${input.attempt}.json`
          : `reviews/${input.workItem.id}/attempt-${input.attempt}.json`;
        return { review: value, reviewPath: await writeTextArtifact(input.runDir, path, `${JSON.stringify(value)}\n`), invocation: {} as never };
      },
      hasWorktreeChanges: async () => false,
      gitSnapshot: async () => ({ branch: "codex/brain-hands/run-1", status: "", gitDir: ".git", gitCommonDir: ".git", isLinkedWorktree: true }),
      push: async () => "pushed",
      afterCheckpoint: async (checkpoint) => {
        if (crash && checkpoint === "after_work_item_summary_persisted") {
          crash = false;
          throw new Error("crash before summary pointer");
        }
      },
    };
    const workflowInput = {
      runDir: setupResult.runDir,
      repoRoot: setupResult.root,
      worktreePath: join(setupResult.root, "worktree"),
      branchName: "codex/brain-hands/run-1",
      baseBranch: "main",
      intake: { ...intake, repo_root: setupResult.root },
      plan,
      codex: {} as never,
      dependencies,
    };

    expect((await runPastGithubEffectBoundaries(workflowInput)).status).toBe("human_action_required");
    expect(completionPublicationObserved).toBe(false);
    expect((await readManifestV2(setupResult.runDir)).work_item_progress.feature?.status).toBe("in_progress");

    const result = await runPastGithubEffectBoundaries(workflowInput);
    expect(result.status).toBe("github_ready");
    expect(completionPublicationObserved).toBe(true);
  }, 120_000);

  it("binds a moved repository before bootstrap and migrates with the current root", async () => {
    const setupResult = await setup();
    const baseline = headSha(join(setupResult.root, "worktree"));
    await updateManifestV2(setupResult.runDir, { source_commit: baseline });
    const movedRoot = `${setupResult.root}-moved`;
    await rename(setupResult.root, movedRoot);
    root = movedRoot;
    const movedRunDir = join(movedRoot, ".brain-hands", "runs", setupResult.runDir.split("/").at(-1)!);
    const movedWorktree = join(movedRoot, "worktree");
    const github = new RecordingGithub();
    const bootstrapInputs: Array<{ repoRoot: string; worktreePath: string }> = [];
    const bootstrapPlan: BrainPlan = {
      ...plan,
      controller_bootstrap: {
        version: 1,
        baseline_commit: baseline,
        preserved_head: "b".repeat(40),
        source_worktree: ".brain-hands/worktrees/preserved-run",
        commit_message: "controller-bootstrap: preserve lifecycle",
        files: [{ path: "src/cli.ts", source_status: "tracked", sha256: "c".repeat(64) }],
      },
    };
    const bootstrapRevision = await recordPlan(movedRunDir, `${JSON.stringify(bootstrapPlan)}\n`);
    await approvePlanRevision(movedRunDir, bootstrapRevision.revision, { actor: "test" });

    const result = await runPastGithubEffectBoundaries({
      runDir: movedRunDir,
      repoRoot: movedRoot,
      worktreePath: movedWorktree,
      branchName: "codex/brain-hands/run-1",
      intake: { ...intake, repo_root: setupResult.root },
      plan: bootstrapPlan,
      codex: {} as never,
      dependencies: {
        github,
        controllerBootstrap: async (input) => { bootstrapInputs.push({ repoRoot: input.repoRoot, worktreePath: input.worktreePath }); return {} as never; },
        hands: async () => { throw new Error("stop after moved migration"); },
      },
    });

    expect(result.status).toBe("human_action_required");
    expect(bootstrapInputs.length).toBeGreaterThan(0);
    expect(bootstrapInputs.every((entry) => entry.repoRoot === movedRoot && entry.worktreePath === movedWorktree)).toBe(true);
    expect(await readManifestV2(movedRunDir)).toMatchObject({
      repo_root: setupResult.root,
      worktree_path: join(setupResult.root, ".brain-hands", "worktrees", movedRunDir.split("/").at(-1)!),
      github_effects_protocol: "task-lineage-v1",
    });
  });

  it("rejects another run's worktree and branch in the same repository before side effects", async () => {
    const first = await setup(); root = first.root;
    const secondWorktree = join(first.root, "worktree-run-b");
    await mkdir(secondWorktree);
    const second = await createLegacyRunLedgerV2({
      repoRoot: first.root,
      originalRequest: "Second run",
      slug: "run-b",
      now: new Date(Date.now() + 1000),
      mode: "github",
      worktreePath: secondWorktree,
      branchName: "codex/brain-hands/run-b",
    });
    const baseline = headSha(join(first.root, "worktree"));
    await updateManifestV2(first.runDir, { source_commit: baseline });
    const bootstrapPlan: BrainPlan = {
      ...plan,
      controller_bootstrap: {
        version: 1,
        baseline_commit: baseline,
        preserved_head: "b".repeat(40),
        source_worktree: ".brain-hands/worktrees/preserved-run",
        commit_message: "controller-bootstrap: preserve lifecycle",
        files: [{ path: "src/cli.ts", source_status: "tracked", sha256: "c".repeat(64) }],
      },
    };
    const github = new RecordingGithub();
    let progressCalls = 0;
    let bootstrapCalls = 0;
    let identityCalls = 0;
    github.getRepositoryIdentity = async () => { identityCalls += 1; return { host: "github.com", name_with_owner: "acme/repo", actor: "operator" }; };

    const result = await runGithubWorkflow({
      runDir: first.runDir,
      repoRoot: first.root,
      worktreePath: secondWorktree,
      branchName: second.manifest.branch_name!,
      intake: { ...intake, repo_root: first.root },
      plan: bootstrapPlan,
      codex: {} as never,
      progress: { emit: async () => { progressCalls += 1; } } as never,
      dependencies: {
        github,
        controllerBootstrap: async () => { bootstrapCalls += 1; return {} as never; },
        hands: async () => { throw new Error("Hands must not run"); },
      },
    });
    expect(result).toMatchObject({
      status: "human_action_required",
      blocker: expect.stringMatching(/worktree|branch|identity|binding/i),
    });
    expect(progressCalls).toBe(0);
    expect(bootstrapCalls).toBe(0);
    expect(identityCalls).toBe(0);
    expect(github.calls).toEqual([]);
    expect(github.created).toEqual([]);
    expect(github.updatedIssues).toEqual([]);
  });

  it("requires persisted worktree and branch identity before side effects", async () => {
    const setupResult = await setup(); root = setupResult.root;
    await updateManifestV2(setupResult.runDir, { worktree_path: null, branch_name: null });
    const github = new RecordingGithub();
    let progressCalls = 0;
    let identityCalls = 0;
    github.getRepositoryIdentity = async () => { identityCalls += 1; return { host: "github.com", name_with_owner: "acme/repo", actor: "operator" }; };

    await expect(runGithubWorkflow({
      runDir: setupResult.runDir,
      repoRoot: setupResult.root,
      worktreePath: join(setupResult.root, "worktree"),
      branchName: "codex/brain-hands/run-1",
      intake: { ...intake, repo_root: setupResult.root },
      plan,
      codex: {} as never,
      progress: { emit: async () => { progressCalls += 1; } } as never,
      dependencies: { github, hands: async () => { throw new Error("Hands must not run"); } },
    })).rejects.toThrow(/persisted.*worktree|branch.*identity/i);
    expect(progressCalls).toBe(0);
    expect(identityCalls).toBe(0);
    expect(github.calls).toEqual([]);
    expect(github.created).toEqual([]);
    expect(github.updatedIssues).toEqual([]);
  });

  it("rejects a runDir from another repository before bootstrap or adapter calls", async () => {
    const first = await setup(); root = first.root;
    const second = await setup();
    const baseline = headSha(join(first.root, "worktree"));
    await updateManifestV2(first.runDir, { source_commit: baseline });
    const bootstrapPlan: BrainPlan = {
      ...plan,
      controller_bootstrap: {
        version: 1,
        baseline_commit: baseline,
        preserved_head: "b".repeat(40),
        source_worktree: ".brain-hands/worktrees/preserved-run",
        commit_message: "controller-bootstrap: preserve lifecycle",
        files: [{ path: "src/cli.ts", source_status: "tracked", sha256: "c".repeat(64) }],
      },
    };
    const github = new RecordingGithub();
    let bootstrapCalls = 0;
    let identityCalls = 0;
    github.getRepositoryIdentity = async () => { identityCalls += 1; return { host: "github.com", name_with_owner: "acme/repo", actor: "operator" }; };
    try {
      await expect(runGithubWorkflow({
        runDir: first.runDir,
        repoRoot: second.root,
        worktreePath: join(second.root, "worktree"),
        branchName: "codex/brain-hands/run-1",
        intake: { ...intake, repo_root: second.root },
        plan: bootstrapPlan,
        codex: {} as never,
        dependencies: {
          github,
          controllerBootstrap: async () => { bootstrapCalls += 1; return {} as never; },
          hands: async () => { throw new Error("Hands must not run"); },
        },
      })).rejects.toThrow(/repository|run directory|binding/i);
      expect(bootstrapCalls).toBe(0);
      expect(identityCalls).toBe(0);
      expect(github.calls).toEqual([]);
      expect(github.created).toEqual([]);
      expect(github.updatedIssues).toEqual([]);
    } finally {
      await rm(second.root, { recursive: true, force: true });
    }
  });

  it("fails a conflicting legacy attachment before any GitHub mutation or observation", async () => {
    const setupResult = await setup(); root = setupResult.root;
    const github = new RecordingGithub();
    const manifest = await readManifestV2(setupResult.runDir);
    const conflictingId = deriveLegacyTaskLineageId("github.com/acme/repo", manifest.run_id);
    await createTaskLineage({
      repoRoot: setupResult.root,
      runId: "another-root-run",
      lineageId: conflictingId,
      repositoryKey: "github.com/acme/repo",
    });

    const result = await runGithubWorkflow({
      runDir: setupResult.runDir,
      repoRoot: setupResult.root,
      worktreePath: join(setupResult.root, "worktree"),
      branchName: "codex/brain-hands/run-1",
      intake: { ...intake, repo_root: setupResult.root },
      plan,
      codex: {} as never,
      dependencies: { github, hands: async () => { throw new Error("Hands must not run"); } },
    });

    expect(result.status).toBe("human_action_required");
    expect(result.blocker).toMatch(/lineage|binding|root run/i);
    expect(github.calls).toEqual([]);
    expect(github.created).toEqual([]);
    expect(github.updatedIssues).toEqual([]);
  });

  it("turns a unique legacy run-marker issue into a lineage-marker update on first planning", async () => {
    const setupResult = await setup(); root = setupResult.root;
    const github = new RecordingGithub();
    const manifest = await readManifestV2(setupResult.runDir);
    const legacyMarker = { runId: manifest.run_id, workItemId: "feature" };
    const legacyIssue = {
      number: 17,
      title: "[ship-feature:feature] Implement feature",
      body: formatIssueBody(plan.work_items[0]!, legacyMarker),
      labels: ["brain-hands", "brain-hands:ready"],
      state: "OPEN" as const,
      state_reason: null,
    };
    github.issues.set(17, legacyIssue);
    github.findIssuesByMarker = async (marker) => "lineageId" in marker && marker.lineageId
      ? []
      : [legacyIssue];

    const result = await runGithubWorkflow({
      runDir: setupResult.runDir,
      repoRoot: setupResult.root,
      worktreePath: join(setupResult.root, "worktree"),
      branchName: "codex/brain-hands/run-1",
      intake: { ...intake, repo_root: setupResult.root },
      plan,
      codex: {} as never,
      dependencies: { github, hands: async () => { throw new Error("stop after issue sync"); } },
    });
    const migrated = await readManifestV2(setupResult.runDir);
    const lineageId = migrated.task_lineage_id!;
    const desiredBody = formatIssueBody(plan.work_items[0]!, { lineageId, ...legacyMarker });
    const preview = planIssueSyncPreview({
      revision: 1,
      lineage_id: lineageId,
      run_id: manifest.run_id,
      repository: { host: "github.com", name_with_owner: "acme/repo" },
      plan_revision: 1,
      plan_sha256: migrated.plan_revisions["1"]!.sha256,
      created_at: migrated.updated_at,
      lineage_state: "active",
      issue_set: { state: "uninitialized", plan_revision: null, plan_sha256: null, parent_issue_number: null, work_item_issue_map: {}, has_prior_owned_state: false },
      approved_replan: false,
      parent: { feature_slug: "feature", desired: { title: "Parent", body: "Parent", labels: [], state: "OPEN", state_reason: null, reason_code: "not-used" }, observations: [] },
      work_items: [{
        work_item_id: "feature",
        desired: { title: legacyIssue.title, body: desiredBody, labels: legacyIssue.labels, state: "OPEN", state_reason: null, reason_code: "approved-plan-work-item" },
        observations: [legacyIssue],
      }],
    });

    expect(result.status).toBe("awaiting_github_effects");
    expect(preview.effects.find((effect) => effect.target.kind === "work_item")).toMatchObject({ action: "update", existing_number: 17 });
    expect(JSON.parse(await readFile(join(setupResult.runDir, "github-effects/issue-sync/revision-1.json"), "utf8"))).toMatchObject({
      effects: expect.arrayContaining([expect.objectContaining({ action: "update", existing_number: 17 })]),
    });
    expect(github.updatedIssues).toEqual([]);
    expect(github.created).toEqual([]);
  });

  it("normalizes an interrupted legacy github_issue_sync to a zero-mutation preview boundary", async () => {
    const setupResult = await setup(); root = setupResult.root;
    await updateManifestV2(setupResult.runDir, { stage: "github_issue_sync" });
    const github = new RecordingGithub();

    const result = await runGithubWorkflow({
      runDir: setupResult.runDir, repoRoot: setupResult.root, worktreePath: join(setupResult.root, "worktree"),
      branchName: "codex/brain-hands/run-1", intake: { ...intake, repo_root: setupResult.root }, plan, codex: {} as never,
      dependencies: { github, hands: async () => { throw new Error("Hands must not run before issue preview application"); } },
    });

    expect(result).toMatchObject({ status: "awaiting_github_effects", manifest: { stage: "awaiting_github_issue_effects" } });
    expect(github.created).toEqual([]);
    expect(github.updatedIssues).toEqual([]);
    expect(github.prs).toEqual([]);
  });

  async function seedAppliedLegacyIssueCrashState(setupResult: Awaited<ReturnType<typeof setup>>, lineageId: string, issue: GitHubIssueObservation): Promise<void> {
    const current = await readManifestV2(setupResult.runDir);
    const reference = current.github_effects.issue_sync;
    if (reference === null) throw new Error("fixture requires an issue preview reference");
    const preview = JSON.parse(await readFile(join(setupResult.runDir, reference.path), "utf8")) as ReturnType<typeof planIssueSyncPreview>;
    const appliedReference = { ...reference, state: "applied" as const };
    await withTaskLineageTransaction({ repoRoot: setupResult.root, lineageId, operation: (transaction) => {
      const lineage = transaction.read();
      return transaction.update({
        ...lineage,
        issue_set: {
          ...lineage.issue_set,
          state: "ready",
          plan_revision: reference.plan_revision,
          plan_sha256: reference.plan_sha256,
          parent_issue_number: null,
          work_item_issue_map: { feature: issue.number },
          preview: appliedReference,
          operations: Object.fromEntries(preview.effects.map((effect) => {
            if (effect.target.kind !== "work_item") throw new Error("fixture expected only work-item effects");
            return [effect.effect_id, {
              operation_id: effect.effect_id,
              target_key: `work_item:${effect.target.work_item_id}`,
              desired_sha256: effect.desired_sha256,
              state: "complete" as const,
              issue_number: issue.number,
              created_by_run_id: current.run_id,
            }];
          })),
        },
      });
    } });
    await updateManifestV2(setupResult.runDir, {
      stage: "implementing",
      issue_numbers: [issue.number],
      work_item_issue_map: { feature: issue.number },
      github_ids: { ...current.github_ids, issue_numbers: [issue.number], work_item_issue_map: { feature: issue.number } },
      github_effects: { ...current.github_effects, issue_sync: appliedReference },
    });
  }

  it("adopts an exact post-issue legacy mapping, normalizes its title, and restores its stage", async () => {
    const setupResult = await setup(); root = setupResult.root;
    const manifest = await readManifestV2(setupResult.runDir);
    const lineageId = deriveLegacyTaskLineageId("github.com/acme/repo", manifest.run_id);
    const marker = { lineageId, runId: manifest.run_id, workItemId: "feature" };
    const owned = {
      number: 17, title: "[ship-feature:feature] Implement feature",
      body: formatIssueBody(plan.work_items[0]!, marker), labels: ISSUE_LABELS.split(","),
      state: "OPEN" as const, state_reason: null,
    };
    await updateManifestV2(setupResult.runDir, {
      stage: "implementing", issue_numbers: [17], work_item_issue_map: { feature: 17 },
      github_ids: { ...manifest.github_ids, issue_numbers: [17], work_item_issue_map: { feature: 17 } },
    });
    const github = new RecordingGithub();
    github.issues.set(17, owned);
    github.findIssuesByMarker = async () => [owned];
    const input = {
      runDir: setupResult.runDir, repoRoot: setupResult.root, worktreePath: join(setupResult.root, "worktree"),
      branchName: "codex/brain-hands/run-1", intake: { ...intake, repo_root: setupResult.root }, plan, codex: {} as never,
      dependencies: { github, hands: async () => { throw new Error("stop after restored boundary"); } },
    };

    const boundary = await runGithubWorkflow(input);
    expect(boundary).toMatchObject({ status: "awaiting_github_effects", manifest: { stage: "awaiting_github_issue_effects" } });
    await appendRunEvent(setupResult.runDir, {
      actor: "attacker",
      type: "legacy_github_issue_boundary_normalized",
      payload: { resume_stage: "complete" },
    });
    const resumed = await runGithubWorkflow(input);

    expect(resumed.status).toBe("human_action_required");
    expect(github.created).toEqual([]);
    expect(github.updatedIssues).toHaveLength(1);
    expect(github.updatedIssues[0]?.title).toBe("[ship-feature:1:feature] Implement feature");
    expect(await readTaskLineage(setupResult.root, lineageId)).toMatchObject({ issue_set: { state: "ready", work_item_issue_map: { feature: 17 } } });
    expect((await readManifestV2(setupResult.runDir)).stage).toBe("implementing");
    expect((await readManifestV2(setupResult.runDir)).legacy_github_restore).toBeNull();
  });

  it("consumes legacy restore authority on resume after issue application reached implementing", async () => {
    const setupResult = await setup(); root = setupResult.root;
    const manifest = await readManifestV2(setupResult.runDir);
    const lineageId = deriveLegacyTaskLineageId("github.com/acme/repo", manifest.run_id);
    const marker = { lineageId, runId: manifest.run_id, workItemId: "feature" };
    const owned = {
      number: 17, title: "[ship-feature:feature] Implement feature",
      body: formatIssueBody(plan.work_items[0]!, marker), labels: ISSUE_LABELS.split(","),
      state: "OPEN" as const, state_reason: null,
    };
    await updateManifestV2(setupResult.runDir, {
      stage: "implementing", issue_numbers: [17], work_item_issue_map: { feature: 17 },
      github_ids: { ...manifest.github_ids, issue_numbers: [17], work_item_issue_map: { feature: 17 } },
    });
    const github = new RecordingGithub();
    github.issues.set(17, owned);
    github.findIssuesByMarker = async () => [owned];
    const input = {
      runDir: setupResult.runDir, repoRoot: setupResult.root, worktreePath: join(setupResult.root, "worktree"),
      branchName: "codex/brain-hands/run-1", intake: { ...intake, repo_root: setupResult.root }, plan, codex: {} as never,
      dependencies: { github, hands: async () => { throw new Error("stop after crash-state restore"); } },
    };

    await runGithubWorkflow(input);
    await seedAppliedLegacyIssueCrashState(setupResult, lineageId, owned);
    const resumed = await runGithubWorkflow(input);

    expect(resumed.status).toBe("human_action_required");
    expect(resumed.blocker).toContain("stop after crash-state restore");
    expect((await readManifestV2(setupResult.runDir)).legacy_github_restore).toBeNull();
    expect(github.created).toEqual([]);
    expect(github.updatedIssues).toEqual([]);
  });

  it("normalizes legacy delivery-stage restore authority back to final verification", async () => {
    const setupResult = await setup(); root = setupResult.root;
    const manifest = await readManifestV2(setupResult.runDir);
    const lineageId = deriveLegacyTaskLineageId("github.com/acme/repo", manifest.run_id);
    const marker = { lineageId, runId: manifest.run_id, workItemId: "feature" };
    const owned = {
      number: 17, title: "[ship-feature:feature] Implement feature",
      body: formatIssueBody(plan.work_items[0]!, marker), labels: ISSUE_LABELS.split(","),
      state: "OPEN" as const, state_reason: null,
    };
    await updateManifestV2(setupResult.runDir, {
      stage: "delivery", issue_numbers: [17], work_item_issue_map: { feature: 17 },
      github_ids: { ...manifest.github_ids, issue_numbers: [17], work_item_issue_map: { feature: 17 } },
    });
    const github = new RecordingGithub();
    github.issues.set(17, owned);
    github.findIssuesByMarker = async () => [owned];
    const input = {
      runDir: setupResult.runDir, repoRoot: setupResult.root, worktreePath: join(setupResult.root, "worktree"),
      branchName: "codex/brain-hands/run-1", intake: { ...intake, repo_root: setupResult.root }, plan, codex: {} as never,
      dependencies: { github, hands: async () => { throw new Error("must not run during boundary setup"); } },
    };

    await runGithubWorkflow(input);
    await seedAppliedLegacyIssueCrashState(setupResult, lineageId, owned);
    const restored = await consumeReadyLegacyGithubRestore(setupResult.runDir);

    expect(restored.stage).toBe("final_verification");
    expect(restored.legacy_github_restore).toBeNull();
  });

  it("deduplicates one current-lineage issue returned by both current and run-target lookups", async () => {
    const setupResult = await setup(); root = setupResult.root;
    const github = new RecordingGithub();
    const manifest = await readManifestV2(setupResult.runDir);
    const lineageId = deriveLegacyTaskLineageId("github.com/acme/repo", manifest.run_id);
    const ownedIssue = {
      number: 17,
      title: "[ship-feature:feature] Implement feature",
      body: formatIssueBody(plan.work_items[0]!, { lineageId, runId: manifest.run_id, workItemId: "feature" }),
      labels: ["brain-hands"],
      state: "OPEN" as const,
      state_reason: null,
    };
    github.findIssuesByMarker = async () => [ownedIssue];

    const result = await runGithubWorkflow({
      runDir: setupResult.runDir,
      repoRoot: setupResult.root,
      worktreePath: join(setupResult.root, "worktree"),
      branchName: "codex/brain-hands/run-1",
      intake: { ...intake, repo_root: setupResult.root },
      plan,
      codex: {} as never,
      dependencies: { github },
    });

    expect(result.status).toBe("awaiting_github_effects");
    expect(JSON.parse(await readFile(join(setupResult.runDir, "github-effects/issue-sync/revision-1.json"), "utf8"))).toMatchObject({
      effects: expect.arrayContaining([expect.objectContaining({ target: { kind: "work_item", work_item_id: "feature" }, action: "update", existing_number: 17 })]),
    });
    expect(github.created).toEqual([]);
    expect(github.updatedIssues).toEqual([]);
  });

  it("fails closed when a different lineage owns the same run and work-item provenance", async () => {
    const setupResult = await setup(); root = setupResult.root;
    const github = new RecordingGithub();
    const manifest = await readManifestV2(setupResult.runDir);
    const otherLineageIssue = {
      number: 17,
      title: "Other lineage",
      body: formatIssueBody(plan.work_items[0]!, {
        lineageId: "946c7414-d500-4e65-a596-dcf99f0015c3",
        runId: manifest.run_id,
        workItemId: "feature",
      }),
      labels: ["brain-hands"],
      state: "OPEN" as const,
      state_reason: null,
    };
    github.findIssuesByMarker = async (marker) => marker.lineageId === undefined ? [otherLineageIssue] : [];

    const result = await runGithubWorkflow({
      runDir: setupResult.runDir,
      repoRoot: setupResult.root,
      worktreePath: join(setupResult.root, "worktree"),
      branchName: "codex/brain-hands/run-1",
      intake: { ...intake, repo_root: setupResult.root },
      plan,
      codex: {} as never,
      dependencies: { github },
    });

    expect(result.status).toBe("human_action_required");
    expect(result.blocker).toMatch(/ownership|different lineage|lineage mismatch/i);
    expect((await readManifestV2(setupResult.runDir)).github_effects.issue_sync).toBeNull();
    expect(github.created).toEqual([]);
    expect(github.updatedIssues).toEqual([]);
});

  it("fails closed when a different lineage owns the same run and parent provenance", async () => {
    const setupResult = await setup(); root = setupResult.root;
    const github = new RecordingGithub();
    const manifest = await readManifestV2(setupResult.runDir);
    const parentPlan = { ...plan, parent_issue: { title: "Ship feature" } };
    const parentSpec = {
      title: "[ship-feature] Ship feature",
      summary: "Ship feature",
      runId: manifest.run_id,
      featureSlug: "ship-feature",
      planRevision: 1,
      workItems: [],
    };
    const otherLineageParent = {
      number: 9,
      title: parentSpec.title,
      body: formatParentIssueBody(parentSpec, {
        lineageId: "946c7414-d500-4e65-a596-dcf99f0015c3",
        runId: manifest.run_id,
        featureSlug: "ship-feature",
      }),
      labels: ["brain-hands"],
      state: "OPEN" as const,
      state_reason: null,
    };
    github.findParentIssuesByMarker = async (marker) => marker.lineageId === undefined ? [otherLineageParent] : [];

    const result = await runGithubWorkflow({
      runDir: setupResult.runDir,
      repoRoot: setupResult.root,
      worktreePath: join(setupResult.root, "worktree"),
      branchName: "codex/brain-hands/run-1",
      intake: { ...intake, repo_root: setupResult.root },
      plan: parentPlan,
      codex: {} as never,
      dependencies: { github },
    });

    expect(result.status).toBe("human_action_required");
    expect(result.blocker).toMatch(/ownership|different lineage|lineage mismatch/i);
    expect((await readManifestV2(setupResult.runDir)).github_effects.issue_sync).toBeNull();
    expect(github.parentIssues).toEqual([]);
    expect(github.parentUpdates).toEqual([]);
  });

  it("fails closed when duplicate legacy run-marker issues are ambiguous", async () => {
    const setupResult = await setup(); root = setupResult.root;
    const github = new RecordingGithub();
    const legacyMarker = { runId: (await readManifestV2(setupResult.runDir)).run_id, workItemId: "feature" };
    const legacyIssue = {
      number: 17, title: "Legacy", body: formatIssueBody(plan.work_items[0]!, legacyMarker),
      labels: ["brain-hands"], state: "OPEN" as const, state_reason: null,
    };
    github.findIssuesByMarker = async (marker) => "lineageId" in marker && marker.lineageId
      ? []
      : [legacyIssue, { ...legacyIssue, number: 18 }];

    const result = await runGithubWorkflow({
      runDir: setupResult.runDir,
      repoRoot: setupResult.root,
      worktreePath: join(setupResult.root, "worktree"),
      branchName: "codex/brain-hands/run-1",
      intake: { ...intake, repo_root: setupResult.root },
      plan,
      codex: {} as never,
      dependencies: { github, hands: async () => { throw new Error("Hands must not run"); } },
    });

    expect(result.status).toBe("human_action_required");
    expect(result.blocker).toMatch(/multiple|ambiguous/i);
    expect(github.created).toEqual([]);
    expect(github.updatedIssues).toEqual([]);
  });

  it.each([
    ["truncated", (body: string) => `<!-- brain-hands-lineage:truncated\n${body}`],
    ["malformed UUID", (body: string) => `<!-- brain-hands-lineage:not-a-uuid -->\n${body}`],
    ["unsupported spelling", (body: string) => `<!-- brain-hands-lineage-v2:unsupported -->\n${body}`],
    ["non-leading", (body: string, lineageId: string) => body.replace("\n", `\n<!-- brain-hands-lineage:${lineageId} -->\n`)],
    ["duplicate mixed", (body: string, lineageId: string) => `<!-- brain-hands-lineage:${lineageId} -->\n<!-- brain-hands-lineage:00000000-0000-4000-8000-000000000000 -->\n${body}`],
  ])("rejects %s lineage signatures before adopting a legacy marker", async (_label, mutateBody) => {
    const setupResult = await setup(); root = setupResult.root;
    const github = new RecordingGithub();
    const manifest = await readManifestV2(setupResult.runDir);
    const lineageId = deriveLegacyTaskLineageId("github.com/acme/repo", manifest.run_id);
    const legacyBody = formatIssueBody(plan.work_items[0]!, { runId: manifest.run_id, workItemId: "feature" });
    const body = mutateBody(legacyBody, lineageId);
    github.findIssuesByMarker = async (marker) => "lineageId" in marker && marker.lineageId
      ? []
      : [{ number: 17, title: "[ship-feature:feature] Implement feature", body, labels: [], state: "OPEN", state_reason: null }];

    const result = await runGithubWorkflow({
      runDir: setupResult.runDir,
      repoRoot: setupResult.root,
      worktreePath: join(setupResult.root, "worktree"),
      branchName: "codex/brain-hands/run-1",
      intake: { ...intake, repo_root: setupResult.root },
      plan,
      codex: {} as never,
      dependencies: { github, hands: async () => { throw new Error("Hands must not run"); } },
    });

    expect(result.status).toBe("human_action_required");
    expect(result.blocker).toMatch(/lineage|marker|ownership/i);
    expect(github.created).toEqual([]);
    expect(github.updatedIssues).toEqual([]);
  });
  it("runs an approved controller bootstrap before GitHub issue creation or Hands", async () => {
    const setupResult = await setup(); root = setupResult.root;
    const github = new RecordingGithub();
    const calls: string[] = [];
    const baseline = headSha(join(setupResult.root, "worktree"));
    await updateManifestV2(setupResult.runDir, { source_commit: baseline });
    github.createIssue = async (issue, marker, title) => {
      calls.push("github");
      github.issues.set(17, {
        number: 17,
        title: title ?? "Feature",
        body: formatIssueBody(issue, marker),
        state: "OPEN",
        state_reason: null,
      });
      return 17;
    };
    const bootstrapPlan: BrainPlan = {
      ...plan,
      controller_bootstrap: {
        version: 1,
        baseline_commit: baseline,
        preserved_head: "b".repeat(40),
        source_worktree: ".brain-hands/worktrees/preserved-run",
        commit_message: "controller-bootstrap: preserve lifecycle",
        files: [{ path: "src/cli.ts", source_status: "tracked", sha256: "c".repeat(64) }],
      },
    };
    const bootstrapRevision = await recordPlan(setupResult.runDir, `${JSON.stringify(bootstrapPlan)}\n`);
    await approvePlanRevision(setupResult.runDir, bootstrapRevision.revision, { actor: "test" });

    const workflowInput = {
      runDir: setupResult.runDir,
      repoRoot: setupResult.root,
      worktreePath: join(setupResult.root, "worktree"),
      branchName: "codex/brain-hands/run-1",
      baseBranch: "main",
      intake: { ...intake, repo_root: setupResult.root },
      plan: bootstrapPlan,
      codex: {} as never,
      dependencies: {
        github,
        controllerBootstrap: async () => {
          calls.push("bootstrap");
          return {} as never;
        },
        hands: async () => {
          calls.push("hands");
          throw new Error("stop after ordering proof");
        },
      },
    };
    await runGithubWorkflow(workflowInput);
    calls.length = 0;
    await runGithubWorkflow(workflowInput);

    expect(calls.slice(0, 3)).toEqual(["bootstrap", "github", "hands"]);
  });

  it("blocks before every GitHub and Hands effect when controller bootstrap fails", async () => {
    const setupResult = await setup(); root = setupResult.root;
    const github = new RecordingGithub();
    const baseline = headSha(join(setupResult.root, "worktree"));
    const bootstrapPlan: BrainPlan = {
      ...plan,
      controller_bootstrap: {
        version: 1,
        baseline_commit: baseline,
        preserved_head: "b".repeat(40),
        source_worktree: ".brain-hands/worktrees/preserved-run",
        commit_message: "controller-bootstrap: preserve lifecycle",
        files: [{ path: "src/cli.ts", source_status: "tracked", sha256: "c".repeat(64) }],
      },
    };
    const bootstrapRevision = await recordPlan(setupResult.runDir, `${JSON.stringify(bootstrapPlan)}\n`);
    await approvePlanRevision(setupResult.runDir, bootstrapRevision.revision, { actor: "test" });

    const result = await runGithubWorkflow({
      runDir: setupResult.runDir,
      repoRoot: setupResult.root,
      worktreePath: join(setupResult.root, "worktree"),
      branchName: "codex/brain-hands/run-1",
      intake: { ...intake, repo_root: setupResult.root },
      plan: bootstrapPlan,
      codex: {} as never,
      dependencies: {
        github,
        controllerBootstrap: async () => { throw new Error("source hash mismatch"); },
        hands: async () => { throw new Error("Hands must not run"); },
      },
    });

    expect(result.status).toBe("human_action_required");
    expect(result.blocker).toContain("source hash mismatch");
    expect(github.calls).toEqual([]);
    expect(github.created).toEqual([]);
  });

  it("stops an initial approval boundary before GitHub controller bootstrap", async () => {
    const setupResult = await setup(false); root = setupResult.root;
    const github = new RecordingGithub();
    const baseline = headSha(join(setupResult.root, "worktree"));
    let bootstrapCalls = 0;
    const progressCodes: string[] = [];
    const result = await runGithubWorkflow({
      runDir: setupResult.runDir,
      repoRoot: setupResult.root,
      worktreePath: join(setupResult.root, "worktree"),
      branchName: "codex/brain-hands/run-1",
      baseBranch: "main",
      intake: { ...intake, repo_root: setupResult.root },
      plan: {
        ...plan,
        controller_bootstrap: {
          version: 1,
          baseline_commit: baseline,
          preserved_head: "c".repeat(40),
          source_worktree: ".brain-hands/worktrees/preserved-run",
          commit_message: "controller-bootstrap: preserve lifecycle",
          files: [{ path: "src/cli.ts", source_status: "tracked", sha256: "d".repeat(64) }],
        },
      },
      codex: {} as never,
      progress: {
        path: join(setupResult.runDir, "progress.jsonl"), sessionId: "approval-stop", workerPid: process.pid,
        emit: async (event) => { progressCodes.push(event.code); return null; },
      },
      dependencies: {
        github,
        controllerBootstrap: async () => { bootstrapCalls += 1; return {} as never; },
      },
    });

    expect(result.status).toBe("human_action_required");
    expect(result.blocker).not.toMatch(/^GitHub runtime failed:/);
    expect(bootstrapCalls).toBe(0);
    expect(progressCodes).toEqual(["worker_started", "worker_blocked"]);
    expect(github.calls).toEqual([]);
  });

  it("rejects direct execution of a non-delivered terminal run before any GitHub call", async () => {
    const setupResult = await setup(); root = setupResult.root;
    await recordTerminalDisposition(setupResult.runDir, {
      outcome: "abandoned",
      actor: "human",
      reason: "The request was withdrawn",
      residual_risks: [],
    });
    const github = new RecordingGithub();

    await expect(runGithubWorkflow({
      runDir: setupResult.runDir,
      repoRoot: setupResult.root,
      worktreePath: join(setupResult.root, "worktree"),
      branchName: "codex/brain-hands/run-1",
      baseBranch: "main",
      intake: { ...intake, repo_root: setupResult.root },
      plan,
      codex: {} as never,
      dependencies: { github, hands: async () => { throw new Error("must not run"); } },
    })).rejects.toThrow("terminal outcome abandoned");
    expect(github.calls).toEqual([]);
  });

  it("resolves the current multi-item issue and keeps integrated phases on the durable run anchor issue", () => {
    const manifest = {
      stage: "implementing",
      current_work_item_id: "second",
      github_ids: { issue_numbers: [41, 42] },
      work_item_progress: {},
    } as Pick<RunManifestV2, "current_work_item_id" | "github_ids" | "stage" | "work_item_progress">;
    expect(resolveRunStatusIssueNumber(manifest, [item("first"), item("second")])).toBe(42);
    expect(resolveRunStatusIssueNumber({ ...manifest, current_work_item_id: "integrated" }, [item("first"), item("second")])).toBe(41);
    expect(resolveRunStatusIssueNumber({
      ...manifest,
      stage: "verifier_review",
      work_item_progress: { integrated: { status: "blocked", attempts: 1, review_cycle_path: "reviews/decisions/integrated.json" } },
    }, [item("first"), item("second")])).toBe(41);
    expect(resolveRunStatusIssueNumber({
      ...manifest,
      stage: "awaiting_plan_approval",
      work_item_progress: { second: { status: "blocked", attempts: 1, replan_patch_path: "replans/second.json" }, integrated: { status: "blocked", attempts: 1, review_cycle_path: "reviews/decisions/integrated.json" } },
    }, [item("first"), item("second")])).toBe(42);
    expect(resolveRunStatusIssueNumber({
      ...manifest,
      stage: "awaiting_plan_approval",
      current_work_item_id: "integrated",
      work_item_progress: { integrated: { status: "blocked", attempts: 1, replan_patch_path: "replans/second.json", replan_target_work_item_id: "second" } },
    }, [item("first"), item("second")])).toBe(42);
    expect(resolveRunStatusIssueNumber({
      ...manifest,
      stage: "awaiting_plan_approval",
      current_work_item_id: "integrated",
      work_item_progress: { integrated: { status: "blocked", attempts: 1, replan_target_work_item_id: "second" } },
    }, [item("first"), item("second")])).toBe(42);
  });

  it("resolves mixed-graph run-status targets through durable maps and legacy DFS order", () => {
    const rawWorkItems = [
      { ...item("dependent"), dependencies: ["dependency"] },
      item("independent"),
      item("dependency"),
    ];
    const orderedWorkItems = [rawWorkItems[1]!, rawWorkItems[2]!, rawWorkItems[0]!];
    const manifest = {
      stage: "implementing",
      current_work_item_id: "independent",
      work_item_issue_map: { dependency: 101, dependent: 102 },
      github_ids: {
        issue_numbers: [101, 102, 103],
        work_item_issue_map: { independent: 103 },
        pull_request_numbers: [],
        pull_request_urls: {},
      },
      work_item_progress: {},
    } as Pick<RunManifestV2, "current_work_item_id" | "github_ids" | "stage" | "work_item_issue_map" | "work_item_progress">;
    const resolve = (candidate: typeof manifest): number | null => resolveRunStatusIssueNumber(
      candidate,
      orderedWorkItems,
      rawWorkItems,
    );

    expect(resolve({
      ...manifest,
      work_item_issue_map: { dependency: 101, dependent: 102, independent: 103 },
      github_ids: { ...manifest.github_ids, issue_numbers: [], work_item_issue_map: {} },
    })).toBe(103);
    expect(resolve({
      ...manifest,
      work_item_issue_map: {},
      github_ids: { ...manifest.github_ids, issue_numbers: [], work_item_issue_map: { independent: 103 } },
    })).toBe(103);
    expect(resolve({
      ...manifest,
      current_work_item_id: "dependent",
      work_item_issue_map: { independent: 103 },
      github_ids: { ...manifest.github_ids, work_item_issue_map: {} },
    })).toBeNull();
    expect(resolve({
      ...manifest,
      current_work_item_id: "integrated",
      work_item_progress: {
        integrated: {
          status: "blocked",
          attempts: 1,
          replan_target_work_item_id: "independent",
        },
      },
    })).toBe(103);
    expect(resolve({
      ...manifest,
      work_item_issue_map: {},
      github_ids: { issue_numbers: [101, 102, 103], pull_request_numbers: [], pull_request_urls: {} },
    })).toBe(103);
  });

  it("resolves a deep mapless legacy status target without recursion overflow", () => {
    const orderedWorkItems = Array.from({ length: 15_000 }, (_, index) => ({
      id: `node-${index}`,
      dependencies: index === 0 ? [] : [`node-${index - 1}`],
    } as WorkItem));
    const rawWorkItems = [...orderedWorkItems].reverse();
    const manifest = {
      stage: "implementing",
      current_work_item_id: "node-14999",
      github_ids: { issue_numbers: Array.from({ length: 15_000 }, (_, index) => index + 1) },
      work_item_progress: {},
    } as Pick<RunManifestV2, "current_work_item_id" | "github_ids" | "stage" | "work_item_progress">;

    expect(resolveRunStatusIssueNumber(manifest, orderedWorkItems, rawWorkItems)).toBe(15_000);
  });

  it("resolves an own nested constructor mapping past an empty top-level map", () => {
    const constructorItem = item("constructor");
    const manifest = {
      stage: "implementing",
      current_work_item_id: "constructor",
      work_item_issue_map: {},
      github_ids: {
        issue_numbers: [],
        pull_request_numbers: [],
        pull_request_urls: {},
        work_item_issue_map: { constructor: 7 },
      },
      work_item_progress: {},
    } as Pick<RunManifestV2, "current_work_item_id" | "github_ids" | "stage" | "work_item_issue_map" | "work_item_progress">;

    expect(resolveRunStatusIssueNumber(manifest, [constructorItem], [constructorItem])).toBe(7);
  });

  it("uses an own nested constructor mapping when the top-level map is partial", () => {
    const constructorItem = item("constructor");
    const manifest = {
      stage: "implementing",
      current_work_item_id: "constructor",
      work_item_issue_map: { other: 8 },
      github_ids: {
        issue_numbers: [8, 7],
        pull_request_numbers: [],
        pull_request_urls: {},
        work_item_issue_map: { constructor: 7 },
      },
      work_item_progress: {},
    } as Pick<RunManifestV2, "current_work_item_id" | "github_ids" | "stage" | "work_item_issue_map" | "work_item_progress">;

    expect(resolveRunStatusIssueNumber(manifest, [constructorItem], [constructorItem])).toBe(7);
  });

  it("does not publish mixed-graph run status before issue ownership is authoritative", async () => {
    const setupResult = await setup(); root = setupResult.root;
    const github = new RecordingGithub();
    const rawWorkItems = [
      { ...item("dependent"), dependencies: ["dependency"] },
      item("independent"),
      item("dependency"),
    ];
    const mixedPlan = { ...plan, work_items: rawWorkItems };
    await updateManifestV2(setupResult.runDir, {
      stage: "awaiting_plan_approval",
      current_work_item_id: "independent",
      issue_numbers: [],
      work_item_issue_map: { dependency: 101, dependent: 102, independent: 103 },
      github_ids: {
        issue_numbers: [],
        work_item_issue_map: {},
        pull_request_numbers: [],
        pull_request_urls: {},
      },
      work_item_progress: {
        independent: {
          status: "blocked",
          attempts: 1,
          replan_patch_path: "replans/independent.json",
        },
      },
    });

    const result = await runGithubWorkflow({
      runDir: setupResult.runDir,
      repoRoot: setupResult.root,
      worktreePath: join(setupResult.root, "worktree"),
      branchName: "codex/brain-hands/run-1",
      intake: { ...intake, repo_root: setupResult.root },
      plan: mixedPlan,
      codex: {} as never,
      dependencies: { github, hands: async () => { throw new Error("must not run"); } },
    });

    expect(result.status).toBe("human_action_required");
    expect(github.statusUpserts).toEqual([]);
  });

  it("publishes automatic progress at a deterministic checkpoint before terminal delivery", async () => {
    const setupResult = await setup(); root = setupResult.root;
    const github = new RecordingGithub();
    const deliverySha = headSha(join(setupResult.root, "worktree"));
    let remoteSha: string | null = null;
    let deliveryPushes = 0;
    let crashAfterLineageReady = true;
    let release!: () => void;
    let observed!: () => void;
    const pause = new Promise<void>((resolvePause) => { release = resolvePause; });
    const checkpoint = new Promise<void>((resolveCheckpoint) => { observed = resolveCheckpoint; });
    const workflowInput: Parameters<typeof runGithubWorkflow>[0] = {
      runDir: setupResult.runDir, repoRoot: setupResult.root, worktreePath: join(setupResult.root, "worktree"),
      branchName: "codex/brain-hands/run-1", baseBranch: "main", intake: { ...intake, repo_root: setupResult.root }, plan, codex: {} as never,
      dependencies: {
        github,
        hands: async (input) => {
          const value = implementation(input.workItem.id);
          const reportPath = `implementation/${input.workItem.id}.json`;
          await writeTextArtifact(setupResult.runDir, reportPath, `${JSON.stringify(value)}\n`);
          return { implementation: value, reportPath, invocation: {} as never };
        },
        verification: async (input) => evidenceForInput(input),
        verifier: async (input) => { const attempt = input.attempt ?? 1; const review = approvedReview(attempt); return { review, reviewPath: await writeTextArtifact(setupResult.runDir, `reviews/integrated/final-attempt-${attempt}.json`, `${JSON.stringify(review)}\n`), invocation: {} as never }; },
        gitSnapshot: async () => ({ branch: "codex/brain-hands/run-1", status: "", gitDir: ".git", gitCommonDir: ".git", isLinkedWorktree: true }),
        commit: async () => deliverySha,
        localHeadSha: async () => deliverySha,
        remoteBranchSha: async () => remoteSha,
        pushCommit: async (_repoRoot, sha, _branch, expectedRemoteSha) => {
          expect(expectedRemoteSha).toBe(remoteSha);
          remoteSha = sha;
          deliveryPushes += 1;
          return "pushed";
        },
        afterDeliveryLineageReady: async () => {
          if (crashAfterLineageReady) {
            crashAfterLineageReady = false;
            throw new Error("crash after delivery lineage ready");
          }
        },
        afterCheckpoint: async (name) => {
          if (name === "after_status_implementing_publication") {
            observed();
            await pause;
          }
        },
      },
    };
    let run!: ReturnType<typeof runGithubWorkflow>;
    let checkpointReached = false;
    for (let previewResume = 0; !checkpointReached && previewResume < 6; previewResume += 1) {
      run = runGithubWorkflow(workflowInput);
      const outcome = await Promise.race([
        run.then((result) => ({ kind: "result" as const, result })),
        checkpoint.then(() => ({ kind: "checkpoint" as const })),
      ]);
      if (outcome.kind === "checkpoint") checkpointReached = true;
      else expect(outcome.result.status).toBe("awaiting_github_effects");
    }
    expect(checkpointReached).toBe(true);
    expect(github.statusUpserts.at(-1)?.target).toEqual({ kind: "issue", number: 17 });
    expect(github.statusUpserts.at(-1)?.body).toContain("Progressing automatically");
    release();
    let result = await run;
    for (let previewResume = 0; result.status === "awaiting_github_effects" && previewResume < 3; previewResume += 1) {
      result = await runGithubWorkflow(workflowInput);
    }
    if (result.status === "human_action_required" && result.blocker?.includes("crash after delivery lineage ready")) {
      result = await runGithubWorkflow(workflowInput);
    }
    expect(result.status, result.blocker).toBe("github_ready");
    expect(deliveryPushes).toBe(1);
    expect(github.prs).toHaveLength(1);
    expect(github.statusUpserts.at(-1)?.body).toContain("Awaiting irreversible-action authority");
    const deliveredComments = github.statusComments.filter((comment) => comment.target.kind === "pull_request"
      && comment.body.includes("Delivered for review"));
    expect(deliveredComments, JSON.stringify(deliveredComments, null, 2)).toHaveLength(1);
  });
  it("anchors a real multi-item final-integrated fix and later PR delivery on the first issue", async () => {
    const setupResult = await setup(); root = setupResult.root;
    const github = new RecordingGithub(); let nextIssue = 100; let finalReviews = 0;
    github.createIssue = async (issue: any, marker?: GitHubIssueMarker) => {
      github.created.push({ marker }); github.issueBodies.push(issue); const number = ++nextIssue;
      github.issues.set(number, { number, title: issue.title, body: formatIssueBody(issue, marker), state: "OPEN", state_reason: null });
      return number;
    };
    const first = item("first"); const second = { ...item("second"), dependencies: ["first"] };
    const multiPlan = { ...plan, work_items: [second, first] };
    const result = await runPastGithubEffectBoundaries({
      runDir: setupResult.runDir, repoRoot: setupResult.root, worktreePath: join(setupResult.root, "worktree"),
      branchName: "codex/brain-hands/run-1", baseBranch: "main", intake: { ...intake, repo_root: setupResult.root }, plan: multiPlan, codex: {} as never,
      dependencies: {
        github,
        hands: async (input) => ({ implementation: input.workItem.id === "integrated" ? { ...implementation("integrated"), changed_files: ["src/first.ts"] } : implementation(input.workItem.id), reportPath: `implementation/${input.workItem.id}-${input.attempt}.json`, invocation: {} as never }),
        verification: async (input) => evidenceForInput(input),
        verifier: async (input) => {
          const attempt = input.attempt ?? 1;
          if (input.final) finalReviews += 1;
          const requestFix = input.final && finalReviews === 1;
          const review: VerifierReview = {
            work_item_id: input.final ? "integrated" : input.workItem.id,
            attempt,
            final: Boolean(input.final),
            decision: requestFix ? "request_changes" : "approve",
            acceptance_coverage: [], evidence_reviewed: [], residual_risks: [],
            findings: requestFix ? [{ severity: "medium", file: "src/first.ts", line: null, acceptance_criterion: "first works", problem: "missing", required_fix: "fix", re_verification: [] }] : [],
          };
          const path = input.final ? `reviews/integrated/final-attempt-${attempt}.json` : `reviews/${input.workItem.id}/attempt-${attempt}.json`;
          return { review, reviewPath: await writeTextArtifact(setupResult.runDir, path, `${JSON.stringify(review)}\n`), invocation: {} as never };
        },
        gitSnapshot: async () => ({ branch: "codex/brain-hands/run-1", status: "", gitDir: ".git", gitCommonDir: ".git", isLinkedWorktree: true }),
        push: async () => "pushed", commit: async () => "sha",
      },
    });
    expect(result.status, result.blocker).toBe("github_ready");
    const finalFixStatus = github.statusUpserts.find((entry) => entry.body.includes("- Stage: `fixing`") && entry.body.includes("Work item: `integrated`"));
    expect(finalFixStatus?.target).toEqual({ kind: "issue", number: 101 });
    expect(github.statusUpserts.at(-1)?.target).toEqual({ kind: "issue", number: 101 });
    expect(github.statusUpserts.at(-1)?.body).toContain("Awaiting irreversible-action authority");
  }, 120_000);
  it("fails closed before any GitHub call when the current plan is not explicitly approved", async () => {
    const setupResult = await setup(false); root = setupResult.root; const github = new RecordingGithub();
    const result = await runPastGithubEffectBoundaries({ runDir: setupResult.runDir, repoRoot: setupResult.root, worktreePath: join(setupResult.root, "worktree"), branchName: "codex/brain-hands/run-1", baseBranch: "main", intake: { ...intake, repo_root: setupResult.root }, plan, codex: {} as never, dependencies: { github, hands: async () => { throw new Error("must not run"); } } });
    expect(result.status).toBe("human_action_required");
    expect(result.blocker).toContain("explicit approval");
    expect(github.calls).toEqual([]);
    const manifest = await readManifestV2(setupResult.runDir);
    expect(manifest.stage).toBe("awaiting_plan_approval");
    expect(manifest.github_ids.issue_numbers).toEqual([]);
    expect(manifest.github_ids.parent_issue_number).toBeNull();
    expect(manifest.worktree_path).toBe(join(setupResult.root, ".brain-hands", "worktrees", basename(setupResult.runDir)));
  });

  it("does not publish corrupt pending-replan provenance to an untrusted manifest-only issue target", async () => {
    const setupResult = await setup(true, false, true); root = setupResult.root;
    const github = new RecordingGithub();
    await updateManifestV2(setupResult.runDir, {
      stage: "awaiting_plan_approval",
      current_work_item_id: "feature",
      issue_numbers: [17],
      github_ids: { issue_numbers: [17], pull_request_numbers: [], pull_request_urls: {} },
      work_item_progress: {
        feature: {
          status: "blocked", attempts: 1, review_revision: 1,
          review_cycle_path: "reviews/decisions/work-item-ZmVhdHVyZQ-revision-1.json",
          review_effect_id: `review-effect:${"a".repeat(64)}`,
          replan_patch_path: "replans/feature.json",
        },
      },
    });
    const result = await runPastGithubEffectBoundaries({
      runDir: setupResult.runDir, repoRoot: setupResult.root, worktreePath: join(setupResult.root, "worktree"),
      branchName: "codex/brain-hands/run-1", intake: { ...intake, repo_root: setupResult.root }, plan, codex: {} as never,
      dependencies: { github, hands: async () => { throw new Error("must not run"); } },
    });
    expect(result.status).toBe("human_action_required");
    expect(github.statusUpserts).toEqual([]);
    expect(await readOperatorStatus(setupResult.runDir)).toMatchObject({ operator_state: "operationally_blocked" });
  });

  it("syncs marked issues through the policy-enabled runtime, pushes after approval, opens one integrated PR, and never merges", async () => {
    const setupResult = await setup(true, false, true, false, undefined, "upstream"); root = setupResult.root;
    const github = new RecordingGithub(); const calls: string[] = [];
    const getPullRequest = github.getPullRequest.bind(github);
    github.getPullRequest = async (number) => {
      calls.push("reconcile-pull-request");
      return getPullRequest(number);
    };
    github.upsertRunStatus = async (target, marker, body) => {
      calls.push(body.includes("Awaiting irreversible-action authority")
        ? "publish-verified-ready-status"
        : "publish-status");
      github.statusUpserts.push({ target, marker, body });
    };
    const verificationInputs: RunVerificationInput[] = [];
    let remoteHead: string | null = null;
    const candidateHead = headSha(join(setupResult.root, "worktree"));
    const progress = await openProgressReporter({ runDir: setupResult.runDir });
    const dependencies: GithubRuntimeDependencies = {
      github,
      hands: async (input) => {
        calls.push(`hands:${input.workItem.id}`);
        const value = implementation(input.workItem.id);
        const reportPath = `implementation/${input.workItem.id}.json`;
        await writeTextArtifact(setupResult.runDir, reportPath, `${JSON.stringify(value)}\n`);
        return { implementation: value, reportPath, invocation: {} as never };
      },
      verification: async (input) => { verificationInputs.push(input); return evidenceForInput(input); },
      verifier: async (input) => {
        const attempt = input.attempt ?? 1;
        calls.push(`verifier:${input.final ? "final" : input.workItem.id}`);
        const review = { ...approvedReview(attempt), work_item_id: input.final ? "integrated" : input.workItem.id, final: Boolean(input.final),
          evidence_reviewed: [verifierEvidenceRef(input)], failure_class: "none" as const, blocker: null, blocker_code: null };
        const reviewPath = input.final ? `reviews/integrated/final-attempt-${attempt}.json` : `reviews/${input.workItem.id}/attempt-${attempt}.json`;
        await writeTextArtifact(setupResult.runDir, reviewPath, `${JSON.stringify(review)}\n`);
        return { review, reviewPath: join(input.runDir, reviewPath), invocation: {} as never };
      },
      gitSnapshot: async () => ({ branch: "codex/brain-hands/run-1", status: "", gitDir: ".git", gitCommonDir: ".git", isLinkedWorktree: true }),
      localHeadSha: async () => candidateHead,
      remoteBranchSha: async () => remoteHead,
      pushCommit: async (_root, sha, branch, expected) => {
        expect([sha, branch, expected]).toEqual([candidateHead, "codex/brain-hands/run-1", null]);
        calls.push("push"); remoteHead = sha; return "pushed";
      },
      push: async () => { throw new Error("legacy push must not run before pull-request delivery"); },
      commit: async () => "sha",
      recordRemoteSynchronization: async (input) => {
        calls.push("record-remote-synchronization");
        const manifest = await readManifestV2(setupResult.runDir);
        expect(input.repoRoot).toBe(manifest.repo_root);
        expect(input.branchName).toBe("codex/brain-hands/run-1");
        expect(input.remoteName).toBe("upstream");
        expect(input.pullRequestNumber).toBe(42);
        expect(input.expectedPullRequestUrl).toBe("https://github.com/acme/repo/pull/42");
        const sha = manifest.work_item_progress.integrated?.commit_sha as string;
        await updateManifestV2(setupResult.runDir, { remote_synchronization_path: "assurance/remote-synchronization-order.json" });
        return {
          artifactPath: "assurance/remote-synchronization-order.json",
          evidence: {
            version: 1, run_id: manifest.run_id, branch_name: input.branchName, remote_name: input.remoteName,
            pull_request_number: input.pullRequestNumber, pull_request_url: input.expectedPullRequestUrl,
            local_candidate_sha: sha, mapped_pr_sha: sha, remote_head_sha: sha,
            problems: [], synchronized: true, observed_at: new Date().toISOString(),
          },
        };
      },
      persistFinalDeliveryAssessmentAtBoundary: async (runDir) => {
        calls.push("persist-final-assurance");
        return persistVerifiedRuntimeAssessment(runDir);
      },
    };
    const workflowInput = { runDir: setupResult.runDir, repoRoot: setupResult.root, worktreePath: join(setupResult.root, "worktree"), branchName: "codex/brain-hands/run-1", baseBranch: "main", remote: "upstream", intake: { ...intake, repo_root: setupResult.root }, plan, codex: {} as never, dependencies, progress };
    let result = await runGithubWorkflow(workflowInput);
    expect(result).toMatchObject({ status: "awaiting_github_effects", manifest: { stage: "awaiting_github_issue_effects" } });
    expect(calls).not.toContain("push");
    result = await runGithubWorkflow(workflowInput);
    expect(result.status, result.blocker).toBe("awaiting_github_effects");
    expect(result).toMatchObject({ status: "awaiting_github_effects", manifest: { stage: "awaiting_github_delivery_effects" } });
    expect(calls).not.toContain("push");
    expect(github.prs).toEqual([]);
    result = await runGithubWorkflow(workflowInput);
    expect(result.status, result.blocker).toBe("github_ready");
    const createdManifest = await readManifestV2(setupResult.runDir);
    expect(github.created[0]?.marker).toEqual({ lineageId: createdManifest.task_lineage_id, runId: createdManifest.run_id, workItemId: "feature" });
    expect(github.issueBodies[0]).toEqual(plan.work_items[0]);
    expect(github.created[0]?.title).toBe("[ship-feature:1:feature] Implement feature");
    expect(github.prs).toHaveLength(1);
    expect(github.prs[0]?.runId).toBe((await readManifestV2(setupResult.runDir)).run_id);
    expect(github.calls).toContain("getDefaultBranch");
    expect(github.calls).toContain("getPullRequest");
    expect(github.pullRequest?.closing_issue_numbers).toEqual([17]);
    expect(github.pullRequest?.state).toBe("OPEN");
    expect("merge" in github).toBe(false);
    const manifest = await readManifestV2(setupResult.runDir);
    expect(manifest.work_item_progress.feature?.implementation_path).toBe("implementation/feature.json");
    expect(manifest.work_item_progress.feature?.review_path).toBe("reviews/feature/attempt-1.json");
    expect(manifest.final_artifact_paths.every((path) => !path.startsWith("/"))).toBe(true);
    expect(calls.indexOf("push")).toBeGreaterThan(calls.indexOf("verifier:final"));
    expect(calls.indexOf("reconcile-pull-request")).toBeGreaterThan(calls.indexOf("push"));
    expect(calls.indexOf("record-remote-synchronization")).toBeGreaterThan(calls.indexOf("reconcile-pull-request"));
    expect(calls.indexOf("persist-final-assurance")).toBeGreaterThan(calls.indexOf("record-remote-synchronization"));
    expect(calls.indexOf("publish-verified-ready-status")).toBeGreaterThan(calls.indexOf("persist-final-assurance"));
    expect(verificationInputs.map((input) => input.identity?.work_item_id)).toContain("integrated");
    expect(verificationInputs.every((input) => input.stopOnFailure === true)).toBe(true);
    const postPrVerification = verificationInputs.find((input) => input.phase === "post_pr");
    expect(postPrVerification?.commands).toEqual([
      ...plan.work_items.flatMap((item) => item.verification_commands.map((command) => command.argv)),
      ...plan.integration_verification,
    ]);
    expect((await readManifestV2(setupResult.runDir)).pull_request_numbers).toEqual([42]);
    const events = []; for await (const event of readProgressEvents(setupResult.runDir)) events.push(event);
    expect(events.map((event) => event.safe_label)).toEqual(expect.arrayContaining([
      "Branch pushed", "Pull request ready", "Run ready for GitHub delivery", "Worker session completed",
    ]));
    expect(JSON.stringify(events)).not.toMatch(/codex\/brain-hands\/run-1|github\.com|pull\/42|abc1234/);
  }, 180_000);

  it("blocks delivery when GitHub does not parse every expected closing reference", async () => {
    const setupResult = await setup(); root = setupResult.root;
    const github = new RecordingGithub();
    github.getPullRequest = async (pullRequestNumber) => ({
      number: pullRequestNumber,
      url: `https://github.com/acme/repo/pull/${pullRequestNumber}`,
      title: github.pullRequest?.title ?? "Task: Ship feature",
      state: "OPEN",
      head_ref: "codex/brain-hands/run-1",
      head_sha: headSha(join(setupResult.root, "worktree")),
      base_ref: "main",
      body: github.pullRequest?.body ?? "Summary",
      closing_issue_numbers: [],
    });
    const result = await runPastGithubEffectBoundaries({
      runDir: setupResult.runDir, repoRoot: setupResult.root, worktreePath: join(setupResult.root, "worktree"),
      branchName: "codex/brain-hands/run-1", baseBranch: "main", intake: { ...intake, repo_root: setupResult.root }, plan, codex: {} as never,
      dependencies: {
        github,
        hands: async (input) => ({ implementation: implementation(input.workItem.id), reportPath: "implementation/item.json", invocation: {} as never }),
        verification: async (input) => evidenceForInput(input),
        verifier: async (input) => ({ review: approvedReview(input.attempt ?? 1), reviewPath: await writeTextArtifact(setupResult.runDir, `reviews/integrated/final-attempt-${input.attempt ?? 1}.json`, `${JSON.stringify(approvedReview(input.attempt ?? 1))}\n`), invocation: {} as never }),
        gitSnapshot: async () => ({ branch: "codex/brain-hands/run-1", status: "", gitDir: ".git", gitCommonDir: ".git", isLinkedWorktree: true }),
        push: async () => "pushed", commit: async () => "sha",
      },
    });
    expect(result.status).toBe("human_action_required");
    expect(result.blocker).toMatch(/exact lineage delivery identity|missing parsed closing references for #17/i);
  });

  it("does not publish or terminalize github_ready when final assurance is absent", async () => {
    const setupResult = await setup(); root = setupResult.root;
    const github = new RecordingGithub();
    const result = await runPastGithubEffectBoundaries({
      runDir: setupResult.runDir, repoRoot: setupResult.root, worktreePath: join(setupResult.root, "worktree"),
      branchName: "codex/brain-hands/run-1", baseBranch: "main", remote: "origin",
      intake: { ...intake, repo_root: setupResult.root }, plan, codex: {} as never,
      dependencies: {
        github,
        hands: async (input) => ({ implementation: implementation(input.workItem.id), reportPath: `implementation/${input.workItem.id}.json`, invocation: {} as never }),
        verification: async (input) => evidenceForInput(input),
        verifier: async (input) => {
          const attempt = input.attempt ?? 1;
          const value = approvedReview(attempt);
          return { review: value, reviewPath: await writeTextArtifact(setupResult.runDir, `reviews/integrated/final-attempt-${attempt}.json`, `${JSON.stringify(value)}\n`), invocation: {} as never };
        },
        gitSnapshot: async () => ({ branch: "codex/brain-hands/run-1", status: "", gitDir: ".git", gitCommonDir: ".git", isLinkedWorktree: true }),
        push: async () => "pushed",
        persistFinalDeliveryAssessmentAtBoundary: async () => null,
      },
    });

    expect(result.status).toBe("human_action_required");
    expect(result.blocker).toContain("assurance");
    expect((await readManifestV2(setupResult.runDir)).terminal).toBeNull();
    expect(github.statusUpserts.some((entry) => entry.body.includes("Awaiting irreversible-action authority"))).toBe(false);
    expect(github.statusComments.some((comment) => comment.target.kind === "pull_request"
      && comment.body.includes("Delivered for review"))).toBe(false);
  });

  it("publishes operationally blocked when supplied assurance no longer matches durable status state", async () => {
    const setupResult = await setup(); root = setupResult.root;
    const github = new RecordingGithub();
    const assessment = await persistVerifiedRuntimeAssessment(setupResult.runDir);
    await updateManifestV2(setupResult.runDir, {
      stage: "delivery",
      delivery_state: "ready",
      current_work_item_id: "integrated",
      issue_numbers: [17],
      work_item_issue_map: { feature: 17 },
      github_ids: {
        issue_numbers: [17],
        work_item_issue_map: { feature: 17 },
        pull_request_numbers: [],
        pull_request_urls: {},
      },
    });
    await writeFile(join(setupResult.runDir, "assurance/runtime-test-assessment.json"), "{}\n", "utf8");
    const manifest = await readManifestV2(setupResult.runDir);

    const result = await publishGithubWorkflowStatus({
      runDir: setupResult.runDir,
      plan,
      dependencies: { github },
      assuranceAssessment: assessment,
    }, {
      status: "github_ready",
      manifest,
      orderedWorkItems: plan.work_items,
      implementationResults: {},
      verification: {},
      reviews: {},
    });

    expect(result.status).toBe("human_action_required");
    expect(result.blocker).toMatch(/status provenance invalid/i);
    expect(github.statusUpserts.at(-1)?.body, github.statusUpserts.at(-1)?.body).toContain("Operationally blocked");
    expect(github.statusUpserts.at(-1)?.body).not.toContain("Awaiting irreversible-action authority");
  });

  it("returns human action when the fresh status snapshot is already delivery-blocked", async () => {
    const setupResult = await setup(); root = setupResult.root;
    const github = new RecordingGithub();
    const assessment = await persistVerifiedRuntimeAssessment(setupResult.runDir);
    await updateManifestV2(setupResult.runDir, {
      stage: "delivery",
      delivery_state: "blocked",
      last_blocker: "Durable delivery blocker",
      current_work_item_id: "integrated",
      issue_numbers: [17],
      work_item_issue_map: { feature: 17 },
      github_ids: {
        issue_numbers: [17],
        work_item_issue_map: { feature: 17 },
        pull_request_numbers: [],
        pull_request_urls: {},
      },
    });
    const manifest = await readManifestV2(setupResult.runDir);

    const result = await publishGithubWorkflowStatus({
      runDir: setupResult.runDir,
      plan,
      dependencies: { github },
      assuranceAssessment: assessment,
    }, {
      status: "github_ready",
      manifest,
      orderedWorkItems: plan.work_items,
      implementationResults: {},
      verification: {},
      reviews: {},
    });

    expect(result.status).toBe("human_action_required");
    expect(result.blocker).toBe("Durable delivery blocker");
    expect(github.statusUpserts.at(-1)?.body).toContain("Operationally blocked");
  });

  it.each([
    ["zero mapped pull requests", async (manifest: RunManifestV2, runDir: string) => {
      await updateManifestV2(runDir, { pull_request_numbers: [], github_ids: { ...manifest.github_ids, pull_request_numbers: [] } });
    }, /pull request mapping requires exactly one number in each manifest array/i],
    ["multiple mapped pull requests", async (manifest: RunManifestV2, runDir: string) => {
      await updateManifestV2(runDir, { pull_request_numbers: [42, 43], github_ids: { ...manifest.github_ids, pull_request_numbers: [42, 43], pull_request_urls: { ...manifest.github_ids.pull_request_urls, "43": "https://github.com/acme/repo/pull/43" } } });
    }, /pull request mapping requires exactly one number in each manifest array/i],
    ["a missing mapped pull request URL", async (manifest: RunManifestV2, runDir: string) => {
      await updateManifestV2(runDir, { github_ids: { ...manifest.github_ids, pull_request_urls: {} } });
    }, /pull request URL is missing/i],
    ["a URL-number conflict", async (manifest: RunManifestV2, runDir: string) => {
      await updateManifestV2(runDir, { github_ids: { ...manifest.github_ids, pull_request_urls: { "42": "https://github.com/acme/repo/pull/43" } } });
    }, /pull request URL does not identify pull request number 42/i],
  ])("blocks before remote observation for %s", async (_label, mutate, blockerPattern) => {
    const setupResult = await setup(); root = setupResult.root;
    const { result, synchronizationCalls } = await runWithPostPrManifestMutation(setupResult, mutate);
    expect(result.status).toBe("human_action_required");
    expect(result.blocker).toMatch(blockerPattern);
    expect(synchronizationCalls).toBe(0);
    expect((await readManifestV2(setupResult.runDir)).remote_synchronization_path ?? null).toBeNull();
  });

  it.each([
    ["missing", (progress: NonNullable<RunManifestV2["work_item_progress"]["integrated"]>) => {
      const { commit_sha: _commitSha, ...withoutCommit } = progress;
      return withoutCommit;
    }, /work_item_progress\.integrated\.commit_sha/i],
    ["different from local HEAD", (progress: NonNullable<RunManifestV2["work_item_progress"]["integrated"]>) => ({ ...progress, commit_sha: "f".repeat(40) }), /Local HEAD .* differs from work_item_progress\.integrated\.commit_sha/i],
  ])("blocks a delivery resume before observation when the integrated commit is %s", async (label, mutateProgress, blockerPattern) => {
    const setupResult = await setup(); root = setupResult.root;
    const github = new RecordingGithub();
    const workflow = {
      runDir: setupResult.runDir, repoRoot: setupResult.root, worktreePath: join(setupResult.root, "worktree"),
      branchName: "codex/brain-hands/run-1", baseBranch: "main", remote: "origin",
      intake: { ...intake, repo_root: setupResult.root }, plan, codex: {} as never,
    };
    const first = await runPastGithubEffectBoundaries({
      ...workflow,
      deferTerminalDisposition: true,
      dependencies: {
        github,
        hands: async (input) => ({ implementation: implementation(input.workItem.id), reportPath: `implementation/${input.workItem.id}.json`, invocation: {} as never }),
        verification: async (input) => evidenceForInput(input),
        verifier: async (input) => {
          const attempt = input.attempt ?? 1;
          const value = approvedReview(attempt);
          return { review: value, reviewPath: await writeTextArtifact(setupResult.runDir, `reviews/integrated/final-attempt-${attempt}.json`, `${JSON.stringify(value)}\n`), invocation: {} as never };
        },
        gitSnapshot: async () => ({ branch: workflow.branchName, status: "", gitDir: ".git", gitCommonDir: ".git", isLinkedWorktree: true }),
        push: async () => "pushed",
        commit: async () => "sha",
      },
    });
    expect(first.status, first.blocker).toBe("github_ready");
    const delivered = await readManifestV2(setupResult.runDir);
    const integrated = mutateProgress(delivered.work_item_progress.integrated!);
    if (label === "missing") {
      const manifestPath = join(setupResult.runDir, "manifest.json");
      const raw = JSON.parse(await readFile(manifestPath, "utf8"));
      raw.remote_synchronization_path = null;
      raw.work_item_progress.integrated = integrated;
      await writeFile(manifestPath, `${JSON.stringify(raw, null, 2)}\n`);
    } else {
      await updateManifestV2(setupResult.runDir, {
        remote_synchronization_path: null,
        work_item_progress: { ...delivered.work_item_progress, integrated },
      });
    }
    let synchronizationCalls = 0;
    const resumed = await runGithubWorkflow({
      ...workflow,
      deferTerminalDisposition: true,
      dependencies: {
        github,
        recordRemoteSynchronization: async () => {
          synchronizationCalls += 1;
          throw new Error("remote observation must not run for invalid synchronization inputs");
        },
      },
    });
    expect(resumed.status).toBe("human_action_required");
    expect(resumed.blocker).toMatch(blockerPattern);
    expect(synchronizationCalls).toBe(0);
    expect((await readManifestV2(setupResult.runDir)).remote_synchronization_path).toBeNull();
  });

  it.each(["pull_request", "remote"] as const)("persists a %s SHA mismatch and succeeds only after a fresh corrected observation", async (mismatchSource) => {
    const setupResult = await setup(); root = setupResult.root;
    const github = new RecordingGithub();
    let synchronizationAttempts = 0;
    let remoteHead: string | null = null;
    const deliverySha = "d".repeat(40);
    const workflow = {
      runDir: setupResult.runDir, repoRoot: setupResult.root, worktreePath: join(setupResult.root, "worktree"),
      branchName: "codex/brain-hands/run-1", baseBranch: "main", remote: "origin",
      intake: { ...intake, repo_root: setupResult.root }, plan, codex: {} as never,
      dependencies: {
        github,
        hands: async (input) => {
          const value = implementation(input.workItem.id);
          const reportPath = `implementation/${input.workItem.id}.json`;
          await writeTextArtifact(input.runDir, reportPath, `${JSON.stringify(value)}\n`);
          return { implementation: value, reportPath, invocation: {} as never };
        },
        verification: async (input) => evidenceForInput(input),
        verifier: async (input) => {
          const attempt = input.attempt ?? 1;
          const value = approvedReview(attempt);
          return { review: value, reviewPath: await writeTextArtifact(setupResult.runDir, `reviews/integrated/final-attempt-${attempt}.json`, `${JSON.stringify(value)}\n`), invocation: {} as never };
        },
        gitSnapshot: async () => ({ branch: "codex/brain-hands/run-1", status: "", gitDir: ".git", gitCommonDir: ".git", isLinkedWorktree: true }),
        push: async () => "pushed",
        commit: async () => deliverySha,
        localHeadSha: async () => deliverySha,
        remoteBranchSha: async () => remoteHead,
        pushCommit: async (_repoRoot, sha) => {
          remoteHead = sha;
          return "pushed";
        },
        recordRemoteSynchronization: async (input: Parameters<typeof recordRemoteSynchronization>[0]) => {
          synchronizationAttempts += 1;
          if (synchronizationAttempts > 1) return recordRemoteSynchronization(input);
          if (mismatchSource === "pull_request") {
            return recordRemoteSynchronization({
              ...input,
              github: { getPullRequest: async (number) => ({ ...(await input.github.getPullRequest!(number))!, head_sha: "e".repeat(40) }) },
            });
          }
          return recordRemoteSynchronization({ ...input, resolveRemoteSha: async () => "e".repeat(40) });
        },
      } satisfies GithubRuntimeDependencies,
    };

    const failed = await runPastGithubEffectBoundaries(workflow);
    expect(failed.status).toBe("human_action_required");
    expect(failed.blocker).toMatch(/local_candidate_sha=.*mapped_pr_sha=.*remote_head_sha=.*evidence_path=/i);
    const failedManifest = await readManifestV2(setupResult.runDir);
    const failedPath = failedManifest.remote_synchronization_path;
    expect(failedPath).toMatch(/^assurance\/remote-synchronization-/);
    const failedEvidence = JSON.parse(await readFile(join(setupResult.runDir, failedPath!), "utf8"));
    expect(failedEvidence.synchronized).toBe(false);
    expect(failedEvidence.problems).toContainEqual({ source: mismatchSource, code: "identity_mismatch" });
    expect(github.statusComments.some((comment) => comment.target.kind === "pull_request"
      && comment.body.includes("Delivered for review"))).toBe(false);
    expect(github.statusUpserts.at(-1)?.body).toContain("Operationally blocked");
    expect(github.statusUpserts.at(-1)?.body).not.toContain("Awaiting irreversible-action authority");
    expect((await persistFinalDeliveryAssessmentAtBoundary(setupResult.runDir))?.outcome).not.toBe("verified_ready");
    expect([...github.issues.values()].every((issue) => issue.state === "OPEN")).toBe(true);

    const retried = await runGithubWorkflow(workflow);
    expect(retried.status, retried.blocker).toBe("github_ready");
    const retriedManifest = await readManifestV2(setupResult.runDir);
    expect(retriedManifest.remote_synchronization_path).not.toBe(failedPath);
    const retriedEvidence = JSON.parse(await readFile(join(setupResult.runDir, retriedManifest.remote_synchronization_path!), "utf8"));
    expect(retriedEvidence.synchronized).toBe(true);
    expect(retriedEvidence.problems).toEqual([]);
    expect(synchronizationAttempts).toBe(2);
    expect(github.statusComments.filter((comment) => comment.target.kind === "pull_request"
      && comment.body.includes("Delivered for review"))).toHaveLength(1);
  });

  it("blocks delivery when the configured base is not GitHub's default branch", async () => {
    const setupResult = await setup(); root = setupResult.root;
    const github = new RecordingGithub(); github.defaultBranch = "trunk";
    const result = await runPastGithubEffectBoundaries({
      runDir: setupResult.runDir, repoRoot: setupResult.root, worktreePath: join(setupResult.root, "worktree"),
      branchName: "codex/brain-hands/run-1", baseBranch: "main", intake: { ...intake, repo_root: setupResult.root }, plan, codex: {} as never,
      dependencies: {
        github,
        hands: async (input) => ({ implementation: implementation(input.workItem.id), reportPath: "implementation/item.json", invocation: {} as never }),
        verification: async (input) => evidenceForInput(input),
        verifier: async (input) => ({ review: approvedReview(input.attempt ?? 1), reviewPath: await writeTextArtifact(setupResult.runDir, `reviews/integrated/final-attempt-${input.attempt ?? 1}.json`, `${JSON.stringify(approvedReview(input.attempt ?? 1))}\n`), invocation: {} as never }),
        gitSnapshot: async () => ({ branch: "codex/brain-hands/run-1", status: "", gitDir: ".git", gitCommonDir: ".git", isLinkedWorktree: true }),
        push: async () => "pushed", commit: async () => "sha",
      },
    });
    expect(result.status).toBe("human_action_required");
    expect(result.blocker).toContain("base main is not the repository default branch trunk");
    expect(github.prs).toEqual([]);
  });

  it("uses GitHub's default branch when no base branch is configured", async () => {
    const setupResult = await setup(); root = setupResult.root;
    const github = new RecordingGithub(); github.defaultBranch = "trunk";
    const result = await runPastGithubEffectBoundaries({
      runDir: setupResult.runDir, repoRoot: setupResult.root, worktreePath: join(setupResult.root, "worktree"),
      branchName: "codex/brain-hands/run-1", intake: { ...intake, repo_root: setupResult.root }, plan, codex: {} as never,
      dependencies: {
        github,
        hands: async (input) => ({ implementation: implementation(input.workItem.id), reportPath: "implementation/item.json", invocation: {} as never }),
        verification: async (input) => evidenceForInput(input),
        verifier: async (input) => ({ review: approvedReview(input.attempt ?? 1), reviewPath: await writeTextArtifact(setupResult.runDir, `reviews/integrated/final-attempt-${input.attempt ?? 1}.json`, `${JSON.stringify(approvedReview(input.attempt ?? 1))}\n`), invocation: {} as never }),
        gitSnapshot: async () => ({ branch: "codex/brain-hands/run-1", status: "", gitDir: ".git", gitCommonDir: ".git", isLinkedWorktree: true }),
        push: async () => "pushed", commit: async () => "sha",
      },
    });

    expect(result.status, result.blocker).toBe("github_ready");
    expect(github.prs[0]?.base).toBe("trunk");
  });

  it("keeps a legacy nonconforming work-item id resumable without inventing a display slug", async () => {
    const setupResult = await setup(); root = setupResult.root;
    const github = new RecordingGithub();
    const legacyPlan = { ...plan, work_items: [{ ...item("feature"), id: "BH_002", title: "Complete legacy task" }] };
    const result = await runPastGithubEffectBoundaries({
      runDir: setupResult.runDir, repoRoot: setupResult.root, worktreePath: join(setupResult.root, "worktree"),
      branchName: "codex/brain-hands/run-1", baseBranch: "main", intake: { ...intake, repo_root: setupResult.root },
      plan: legacyPlan, codex: {} as never,
      dependencies: {
        github,
        hands: async (input) => ({ implementation: implementation(input.workItem.id), reportPath: "implementation/legacy.json", invocation: {} as never }),
        verification: async (input) => evidenceForInput(input),
        verifier: async (input) => { const attempt = input.attempt ?? 1; const review = approvedReview(attempt); return { review, reviewPath: await writeTextArtifact(setupResult.runDir, `reviews/integrated/final-attempt-${attempt}.json`, `${JSON.stringify(review)}\n`), invocation: {} as never }; },
        gitSnapshot: async () => ({ branch: "codex/brain-hands/run-1", status: "", gitDir: ".git", gitCommonDir: ".git", isLinkedWorktree: true }),
        push: async () => "pushed", commit: async () => "sha",
      },
    });
    expect(result.status, result.blocker).toBe("github_ready");
    expect(github.issueBodies[0]?.title).toBe("Complete legacy task");
    expect(github.created[0]?.title).toBe("Complete legacy task");
    expect(github.created[0]?.marker?.workItemId).toBe("BH_002");
  });

  it("stores an optional parent separately without shifting child issue mapping", async () => {
    const setupResult = await setup(); root = setupResult.root;
    const github = new RecordingGithub();
    const parentPlan = { ...plan, parent_issue: { title: "Ship feature" } };
    const dependencies: GithubRuntimeDependencies = {
      github,
      hands: async (input) => ({ implementation: implementation(input.workItem.id), reportPath: `implementation/${input.workItem.id}.json`, invocation: {} as never }),
      verification: async (input) => evidenceForInput(input),
      verifier: async (input) => { const attempt = input.attempt ?? 1; const review = approvedReview(attempt); return { review, reviewPath: await writeTextArtifact(setupResult.runDir, `reviews/integrated/final-attempt-${attempt}.json`, `${JSON.stringify(review)}\n`), invocation: {} as never }; },
      gitSnapshot: async () => ({ branch: "codex/brain-hands/run-1", status: "", gitDir: ".git", gitCommonDir: ".git", isLinkedWorktree: true }),
      push: async () => "pushed",
      commit: async () => "sha",
    };

    const result = await runPastGithubEffectBoundaries({ runDir: setupResult.runDir, repoRoot: setupResult.root, worktreePath: join(setupResult.root, "worktree"), branchName: "codex/brain-hands/run-1", baseBranch: "main", intake: { ...intake, repo_root: setupResult.root }, plan: parentPlan, codex: {} as never, dependencies });

    expect(result.status, result.blocker).toBe("github_ready");
    expect(github.parentIssues[0]?.title).toBe("[ship-feature] Ship feature");
    expect(github.issueBodies[0]).not.toHaveProperty("parent_issue_number");
    expect(github.parentIssues[0]?.workItems).toEqual([]);
    expect(github.parentUpdates).toHaveLength(0);
    const manifest = await readManifestV2(setupResult.runDir);
    expect(manifest.github_ids.parent_issue_number).toBe(9);
    expect(manifest.github_ids.issue_numbers).toEqual([17]);
    expect((github.prs[0] as any)?.parentIssueNumber).toBe(9);
    expect(JSON.parse(await readFile(join(setupResult.runDir, "github-map.json"), "utf8")).parent_issue_number).toBe(9);
    const lineage = await readTaskLineage(setupResult.root, manifest.task_lineage_id!);
    expect(Object.values(lineage.issue_set.operations)).toEqual(expect.arrayContaining([
      expect.objectContaining({ target_key: "parent", state: "complete", issue_number: 9 }),
    ]));
  }, 120_000);

  it("does not treat a stale manifest parent projection as authoritative", async () => {
    const setupResult = await setup(); root = setupResult.root;
    await updateManifestV2(setupResult.runDir, {
      github_ids: { issue_numbers: [], parent_issue_number: 9, pull_request_numbers: [], pull_request_urls: {} },
    });
    const github = new RecordingGithub();
    const result = await runPastGithubEffectBoundaries({
      runDir: setupResult.runDir, repoRoot: setupResult.root, worktreePath: join(setupResult.root, "worktree"),
      branchName: "codex/brain-hands/run-1", baseBranch: "main", intake: { ...intake, repo_root: setupResult.root },
      plan: { ...plan, parent_issue: { title: "Ship feature" } }, codex: {} as never,
      dependencies: { github, hands: async () => { throw new Error("must not run"); } },
    });
    expect(result.status).toBe("human_action_required");
    expect(result.blocker).toContain("must not run");
    expect(github.parentIssues).toHaveLength(1);
    expect((await readTaskLineage(setupResult.root, (await readManifestV2(setupResult.runDir)).task_lineage_id!)).issue_set.parent_issue_number).toBe(9);
  });

  it("does not rewrite an unchanged marker-matched parent", async () => {
    const setupResult = await setup(); root = setupResult.root;
    const github = new RecordingGithub();
    const manifest = await readManifestV2(setupResult.runDir);
    const lineageId = manifest.task_lineage_id ?? deriveLegacyTaskLineageId("github.com/acme/repo", manifest.run_id);
    const parentPlan = { ...plan, parent_issue: { title: "Ship feature" } };
    const parentObservation: GitHubIssueObservation = {
      number: 9,
      title: "[ship-feature] Ship feature",
      body: formatParentIssueBody({
        title: "[ship-feature] Ship feature", summary: "Ship feature", runId: manifest.run_id,
        featureSlug: "ship-feature", planRevision: 1, workItems: [],
      }, { lineageId, runId: manifest.run_id, featureSlug: "ship-feature" }),
      labels: PARENT_ISSUE_LABELS.split(","), state: "OPEN", state_reason: null,
    };
    const childObservation: GitHubIssueObservation = {
      number: 17,
      title: "[ship-feature:feature] Implement feature",
      body: formatIssueBody(plan.work_items[0]!, { lineageId, runId: manifest.run_id, workItemId: "feature" }),
      labels: ISSUE_LABELS.split(","), state: "OPEN", state_reason: null,
    };
    github.findParentIssuesByMarker = async () => [parentObservation];
    github.findIssuesByMarker = async () => [childObservation];
    github.issues.set(9, parentObservation);
    github.issues.set(17, childObservation);
    const result = await runPastGithubEffectBoundaries({
      runDir: setupResult.runDir, repoRoot: setupResult.root, worktreePath: join(setupResult.root, "worktree"),
      branchName: "codex/brain-hands/run-1", baseBranch: "main", intake: { ...intake, repo_root: setupResult.root },
      plan: parentPlan, codex: {} as never,
      dependencies: {
        github,
        hands: async (input) => ({ implementation: implementation(input.workItem.id), reportPath: "implementation/item.json", invocation: {} as never }),
        verification: async (input) => evidenceForInput(input),
        verifier: async (input) => { const attempt = input.attempt ?? 1; const review = approvedReview(attempt); return { review, reviewPath: await writeTextArtifact(setupResult.runDir, `reviews/integrated/final-attempt-${attempt}.json`, `${JSON.stringify(review)}\n`), invocation: {} as never }; },
        gitSnapshot: async () => ({ branch: "codex/brain-hands/run-1", status: "", gitDir: ".git", gitCommonDir: ".git", isLinkedWorktree: true }),
        push: async () => "pushed", commit: async () => "sha",
      },
    });
    expect(result.status, result.blocker).toBe("github_ready");
    expect(github.parentUpdates).toHaveLength(0);
    const events = (await readFile(join(setupResult.runDir, "events.jsonl"), "utf8"))
      .split("\n").filter(Boolean).map((line) => JSON.parse(line) as { type: string });
    expect(events.filter((event) => event.type.startsWith("github_issue_") || event.type.startsWith("github_parent_issue_"))).toHaveLength(0);
    const lineage = await readTaskLineage(setupResult.root, (await readManifestV2(setupResult.runDir)).task_lineage_id!);
    expect(lineage.issue_set).toMatchObject({ state: "ready", parent_issue_number: 9, work_item_issue_map: { feature: 17 } });
  }, 120_000);

  it("does not trust the legacy single-parent lookup at the preview boundary", async () => {
    const setupResult = await setup(); root = setupResult.root;
    const github = new RecordingGithub();
    github.findParentIssueByMarker = async () => 9;

    const result = await runGithubWorkflow({
      runDir: setupResult.runDir, repoRoot: setupResult.root, worktreePath: join(setupResult.root, "worktree"),
      branchName: "codex/brain-hands/run-1", baseBranch: "main", intake: { ...intake, repo_root: setupResult.root },
      plan: { ...plan, parent_issue: { title: "Ship feature" } }, codex: {} as never,
      dependencies: { github, hands: async () => { throw new Error("must not run"); } },
    });

    expect(result.status).toBe("awaiting_github_effects");
    expect(github.created).toHaveLength(0);
    expect(github.parentUpdates).toHaveLength(0);
  });

  it("reconciles a title-only parent change while preserving external notes", async () => {
    const setupResult = await setup(); root = setupResult.root;
    const github = new RecordingGithub();
    const manifest = await readManifestV2(setupResult.runDir);
    const lineageId = deriveLegacyTaskLineageId("github.com/acme/repo", manifest.run_id);
    const marker = { lineageId, runId: manifest.run_id, featureSlug: "ship-feature" };
    const parentInput = {
      title: "[ship-feature] Ship feature", summary: "Ship feature", runId: manifest.run_id,
      featureSlug: "ship-feature", planRevision: 1, workItems: [{ id: "feature", issueNumber: 17 }],
    };
    const parentObservation: GitHubIssueObservation = {
      number: 9,
      title: "Stale parent title",
      body: `${formatParentIssueBody(parentInput, marker)}External parent note.\n`,
      labels: PARENT_ISSUE_LABELS.split(","), state: "OPEN", state_reason: null,
    };
    const childObservation: GitHubIssueObservation = {
      number: 17,
      title: "[ship-feature:1:feature] Implement feature",
      body: formatIssueBody(plan.work_items[0]!, { lineageId, runId: manifest.run_id, workItemId: "feature" }),
      labels: ISSUE_LABELS.split(","), state: "OPEN", state_reason: null,
    };
    github.issues.set(9, parentObservation);
    github.issues.set(17, childObservation);
    github.findParentIssuesByMarker = async () => [parentObservation];
    github.findIssuesByMarker = async () => [childObservation];

    const result = await runPastGithubEffectBoundaries({
      runDir: setupResult.runDir, repoRoot: setupResult.root, worktreePath: join(setupResult.root, "worktree"),
      branchName: "codex/brain-hands/run-1", baseBranch: "main", intake: { ...intake, repo_root: setupResult.root },
      plan: { ...plan, parent_issue: { title: "Ship feature" } }, codex: {} as never,
      dependencies: { github, hands: async () => { throw new Error("stop after sync"); } },
    });

    expect(result.status).toBe("human_action_required");
    expect(github.parentUpdates).toHaveLength(1);
    expect(github.issues.get(9)?.title).toBe("[ship-feature] Ship feature");
    expect(github.issues.get(9)?.body).toContain("External parent note.");
  });

  it("reconciles a body-only parent change while preserving external notes", async () => {
    const setupResult = await setup(); root = setupResult.root;
    const github = new RecordingGithub();
    const manifestBeforeRun = await readManifestV2(setupResult.runDir);
    const lineageId = manifestBeforeRun.task_lineage_id ?? deriveLegacyTaskLineageId("github.com/acme/repo", manifestBeforeRun.run_id);
    const staleObservation: GitHubIssueObservation = {
      number: 17,
      title: "Stale issue title",
      body: formatIssueBody({ ...plan.work_items[0]!, objective: "Stale objective" }, {
        lineageId, runId: manifestBeforeRun.run_id, workItemId: "feature",
      }),
      labels: ISSUE_LABELS.split(","), state: "OPEN", state_reason: null,
    };
    github.findIssuesByMarker = async () => [staleObservation];
    github.issues.set(17, staleObservation);
    const result = await runPastGithubEffectBoundaries({
      runDir: setupResult.runDir,
      repoRoot: setupResult.root,
      worktreePath: join(setupResult.root, "worktree"),
      branchName: "codex/brain-hands/run-1",
      baseBranch: "main",
      intake: { ...intake, repo_root: setupResult.root },
      plan,
      codex: {} as never,
      dependencies: {
        github,
        hands: async (input) => ({ implementation: implementation(input.workItem.id), reportPath: "implementation/item.json", invocation: {} as never }),
        verification: async (input) => evidenceForInput(input),
        verifier: async (input) => { const attempt = input.attempt ?? 1; const review = approvedReview(attempt); return { review, reviewPath: await writeTextArtifact(setupResult.runDir, `reviews/integrated/final-attempt-${attempt}.json`, `${JSON.stringify(review)}\n`), invocation: {} as never }; },
        gitSnapshot: async () => ({ branch: "codex/brain-hands/run-1", status: "", gitDir: ".git", gitCommonDir: ".git", isLinkedWorktree: true }),
        push: async () => "pushed",
        commit: async () => "sha",
      },
    });

    expect(result.status, result.blocker).toBe("github_ready");
    expect(github.updatedIssues).toHaveLength(1);
    const lineage = await readTaskLineage(setupResult.root, (await readManifestV2(setupResult.runDir)).task_lineage_id!);
    expect(lineage.issue_set).toMatchObject({ state: "ready", work_item_issue_map: { feature: 17 } });
    expect(Object.values(lineage.issue_set.operations)).toEqual([
      expect.objectContaining({ target_key: "work_item:feature", state: "complete", issue_number: 17 }),
    ]);
  }, 120_000);

  it("reconciles a body-only child issue change and preserves external body notes", async () => {
    const setupResult = await setup(); root = setupResult.root;
    const github = new RecordingGithub();
    const manifest = await readManifestV2(setupResult.runDir);
    const lineageId = deriveLegacyTaskLineageId("github.com/acme/repo", manifest.run_id);
    const marker = { lineageId, runId: manifest.run_id, workItemId: "feature" };
    const observation: GitHubIssueObservation = {
      number: 17,
      title: "[ship-feature:1:feature] Implement feature",
      body: `${formatIssueBody({ ...plan.work_items[0]!, objective: "Stale objective" }, marker)}Operator note: preserve me.\n`,
      labels: ISSUE_LABELS.split(","), state: "OPEN", state_reason: null,
    };
    github.issues.set(17, observation);
    github.findIssuesByMarker = async () => [observation];

    const result = await runPastGithubEffectBoundaries({
      runDir: setupResult.runDir, repoRoot: setupResult.root, worktreePath: join(setupResult.root, "worktree"),
      branchName: "codex/brain-hands/run-1", baseBranch: "main", intake: { ...intake, repo_root: setupResult.root },
      plan, codex: {} as never,
      dependencies: { github, hands: async () => { throw new Error("stop after sync"); } },
    });

    expect(result.status).toBe("human_action_required");
    expect(github.updatedIssues).toHaveLength(1);
    expect(github.updatedIssues[0]?.title).toBe("[ship-feature:1:feature] Implement feature");
    expect(github.issues.get(17)?.body).toContain(plan.work_items[0]!.objective);
    expect(github.issues.get(17)?.body).not.toContain("Stale objective");
    expect(github.issues.get(17)?.body).toContain("Operator note: preserve me.");
  });

  it("does not trust the legacy single-issue lookup at the preview boundary", async () => {
    const setupResult = await setup(); root = setupResult.root;
    const github = new RecordingGithub();
    github.findIssueByMarker = async () => 17;

    const result = await runGithubWorkflow({
      runDir: setupResult.runDir, repoRoot: setupResult.root, worktreePath: join(setupResult.root, "worktree"),
      branchName: "codex/brain-hands/run-1", intake: { ...intake, repo_root: setupResult.root }, plan, codex: {} as never,
      dependencies: { github, hands: async () => { throw new Error("must not run"); } },
    });

    expect(result.status).toBe("awaiting_github_effects");
    expect(github.updatedIssues).toHaveLength(0);
  });

  it("fails closed when a marker-matched parent lost its managed body boundaries", async () => {
    const setupResult = await setup(); root = setupResult.root;
    const github = new RecordingGithub();
    github.findParentIssuesByMarker = async () => {
      throw new Error("parent issue #9 is missing Brain Hands managed body markers");
    };
    const result = await runPastGithubEffectBoundaries({
      runDir: setupResult.runDir, repoRoot: setupResult.root, worktreePath: join(setupResult.root, "worktree"),
      branchName: "codex/brain-hands/run-1", baseBranch: "main", intake: { ...intake, repo_root: setupResult.root },
      plan: { ...plan, parent_issue: { title: "Ship feature" } }, codex: {} as never,
      dependencies: { github, hands: async () => { throw new Error("must not run"); } },
    });
    expect(result.status).toBe("human_action_required");
    expect(result.blocker).toContain("parent issue #9 is missing Brain Hands managed body markers");
    expect(github.issueBodies).toHaveLength(0);
  });

  it("resumes parent checklist synchronization without duplicating parent or child issues", async () => {
    const setupResult = await setup(); root = setupResult.root;
    const github = new RecordingGithub();
    const parentPlan = { ...plan, parent_issue: { title: "Ship feature" } };
    let parentExists = false;
    let childExists = false;
    let parentCreates = 0;
    let childCreates = 0;
    let createdParentInput: any = null;
    let createdParentMarker: GitHubParentIssueMarker | null = null;
    github.createParentIssue = async (parentInput, marker) => {
      parentExists = true;
      parentCreates += 1;
      createdParentInput = parentInput;
      createdParentMarker = marker;
      github.parentIssues.push(parentInput);
      throw new Error("parent create interrupted after external success");
    };
    github.findParentIssuesByMarker = async () => parentExists ? [{
      number: 9,
      title: createdParentInput.title,
      body: formatParentIssueBody(createdParentInput, createdParentMarker!),
      labels: PARENT_ISSUE_LABELS.split(","), state: "OPEN", state_reason: null,
    }] : [];
    github.createIssue = async (issue, marker) => {
      childExists = true; childCreates += 1; github.issueBodies.push(issue); github.created.push({ marker });
      github.issues.set(17, { number: 17, title: issue.title, body: formatIssueBody(issue, marker), state: "OPEN", state_reason: null });
      return 17;
    };
    github.findIssuesByMarker = async () => childExists ? [{ ...github.issues.get(17)!, labels: ISSUE_LABELS.split(",") }] : [];
    const input = {
      runDir: setupResult.runDir, repoRoot: setupResult.root, worktreePath: join(setupResult.root, "worktree"),
      branchName: "codex/brain-hands/run-1", baseBranch: "main", intake: { ...intake, repo_root: setupResult.root },
      plan: parentPlan, codex: {} as never,
    };
    const first = await runPastGithubEffectBoundaries({ ...input, dependencies: { github, hands: async () => { throw new Error("must not run before parent sync"); } } });
    expect(first.status).toBe("human_action_required");
    expect(first.blocker).toContain("create result is ambiguous for parent");

    const second = await runPastGithubEffectBoundaries({ ...input, dependencies: {
      github,
      hands: async (handsInput) => ({ implementation: implementation(handsInput.workItem.id), reportPath: "implementation/item.json", invocation: {} as never }),
      verification: async (verificationInput) => evidenceForInput(verificationInput),
      verifier: async (verifierInput) => { const attempt = verifierInput.attempt ?? 1; const review = approvedReview(attempt); return { review, reviewPath: await writeTextArtifact(setupResult.runDir, `reviews/integrated/final-attempt-${attempt}.json`, `${JSON.stringify(review)}\n`), invocation: {} as never }; },
      gitSnapshot: async () => ({ branch: "codex/brain-hands/run-1", status: "", gitDir: ".git", gitCommonDir: ".git", isLinkedWorktree: true }),
      push: async () => "pushed", commit: async () => "sha",
    } });
    expect(second.status).toBe("human_action_required");
    expect(second.blocker).toContain("ambiguous");
    expect(parentCreates).toBe(1);
    expect(childCreates).toBe(0);
    expect(github.parentUpdates).toHaveLength(0);
    const lineage = await readTaskLineage(setupResult.root, (await readManifestV2(setupResult.runDir)).task_lineage_id!);
    expect(lineage.issue_set).toMatchObject({ state: "ambiguous", parent_issue_number: null, work_item_issue_map: {} });
  }, 120_000);

  it("fails closed when an approved replan tries to detach a persisted parent", async () => {
    const setupResult = await setup(); root = setupResult.root;
    await updateManifestV2(setupResult.runDir, {
      github_ids: { issue_numbers: [], parent_issue_number: 9, pull_request_numbers: [], pull_request_urls: {} },
    });
    const github = new RecordingGithub();

    const workflowInput = {
      runDir: setupResult.runDir,
      repoRoot: setupResult.root,
      worktreePath: join(setupResult.root, "worktree"),
      branchName: "codex/brain-hands/run-1",
      baseBranch: "main",
      intake: { ...intake, repo_root: setupResult.root },
      plan: { ...plan, parent_issue: null },
      codex: {} as never,
      dependencies: { github, hands: async () => { throw new Error("must not run"); } },
    };
    let result = await runPastGithubEffectBoundaries(workflowInput);
    for (let previewResume = 0; result.status === "awaiting_github_effects" && previewResume < 3; previewResume += 1) {
      result = await runPastGithubEffectBoundaries(workflowInput);
    }

    expect(result.status).toBe("human_action_required");
    expect(result.blocker).toContain("cannot detach persisted parent issue #9");
    expect(github.calls).toEqual([]);
  });

  it("uses durable noncontiguous mappings and never writes historical issue-6 or issue-7 namespaces", async () => {
    const setupResult = await setup(); root = setupResult.root;
    const sentinel6 = "historical issue 6 evidence\n";
    const sentinel7 = "historical issue 7 evidence\n";
    await mkdir(join(setupResult.runDir, "verification/issue-6"), { recursive: true });
    await mkdir(join(setupResult.runDir, "verification/issue-7"), { recursive: true });
    await writeFile(join(setupResult.runDir, "verification/issue-6/sentinel.txt"), sentinel6, "utf8");
    await writeFile(join(setupResult.runDir, "verification/issue-7/sentinel.txt"), sentinel7, "utf8");
    const beforeIssue6 = await snapshotTree(join(setupResult.runDir, "verification/issue-6"));
    const beforeIssue7 = await snapshotTree(join(setupResult.runDir, "verification/issue-7"));
    const issueMap = { "BH-001": 1, "BH-002": 2, "BH-003": 3, "BH-004": 4, "BH-005": 5, "BH-008": 8 };
    const mappedPlan: BrainPlan = { ...plan, work_items: Object.keys(issueMap).map((workItemId) => item(workItemId)) };
    const revision = await recordPlan(setupResult.runDir, `${JSON.stringify(mappedPlan)}\n`);
    await approvePlanRevision(setupResult.runDir, revision.revision, { actor: "test" });
    const github = new RecordingGithub();
    const manifestBeforeRun = await readManifestV2(setupResult.runDir);
    for (const workItem of mappedPlan.work_items) {
      const number = issueMap[workItem.id as keyof typeof issueMap];
      github.issues.set(number, {
        number,
        title: `[ship-feature:${workItem.id}] ${workItem.title}`,
        body: formatIssueBody(workItem, { lineageId: manifestBeforeRun.task_lineage_id!, runId: manifestBeforeRun.run_id, workItemId: workItem.id }),
        labels: ISSUE_LABELS.split(","), state: "OPEN", state_reason: null,
      });
    }
    github.findIssuesByMarker = async (marker) => {
      const number = issueMap[marker.workItemId as keyof typeof issueMap];
      return number === undefined ? [] : [{ ...github.issues.get(number)!, labels: ISSUE_LABELS.split(",") }];
    };
    let finalVerifierCalls = 0;
    const dependencies: GithubRuntimeDependencies = {
      github,
      hands: async (input) => {
        const reportPath = `implementation/${input.workItem.id}/attempt-${input.attempt}.json`;
        const result = implementation(input.workItem.id);
        await writeTextArtifact(setupResult.runDir, reportPath, `${JSON.stringify(result)}\n`);
        return { implementation: result, reportPath, invocation: {} as never };
      },
      verification: async (input) => evidenceForInput(input),
      verifier: async (input) => {
        const attempt = input.attempt ?? 1;
        if (input.final && finalVerifierCalls++ === 0) throw new Error("pause before persisted final review");
        const value = review(input.workItem.id, attempt, Boolean(input.final));
        const path = input.final ? `reviews/integrated/final-attempt-${attempt}.json` : `reviews/${input.workItem.id}/attempt-${attempt}.json`;
        return { review: value, reviewPath: await writeTextArtifact(setupResult.runDir, path, `${JSON.stringify(value)}\n`), invocation: {} as never };
      },
      gitSnapshot: async () => ({ branch: "codex/brain-hands/run-1", status: "", gitDir: ".git", gitCommonDir: ".git", isLinkedWorktree: true }),
      push: async () => "pushed",
      commit: async () => "sha",
    };
    const input = { runDir: setupResult.runDir, repoRoot: setupResult.root, worktreePath: join(setupResult.root, "worktree"), branchName: "codex/brain-hands/run-1", baseBranch: "main", intake: { ...intake, repo_root: setupResult.root }, plan: mappedPlan, codex: {} as never, dependencies };
    const fresh = await runPastGithubEffectBoundaries(input);
    expect(fresh.status).toBe("human_action_required");
    expect(fresh.pullRequest).toBeUndefined();
    expect(github.prs).toHaveLength(0);
    expect(await snapshotTree(join(setupResult.runDir, "verification/issue-6"))).toEqual(beforeIssue6);
    expect(await snapshotTree(join(setupResult.runDir, "verification/issue-7"))).toEqual(beforeIssue7);

    const resumed = await runPastGithubEffectBoundaries(input);
    const manifest = await readManifestV2(setupResult.runDir);
    expect(resumed.status, resumed.blocker).toBe("github_ready");
    expect(github.prs).toHaveLength(1);
    expect(manifest.work_item_issue_map).toEqual(issueMap);
    expect(manifest.github_ids.work_item_issue_map).toEqual(issueMap);
    expect(manifest.work_item_progress["BH-008"]).toMatchObject({ verification_scope: "github", verification_work_item_id: "BH-008", verification_issue_number: 8 });
    expect(manifest.work_item_progress["BH-008"]?.verification_path).toBe("verification/issue-8/attempt-1/evidence.json");
    expect(manifest.work_item_progress.integrated).toMatchObject({ verification_scope: "integrated", verification_work_item_id: "integrated" });
    expect(manifest.work_item_progress.integrated?.verification_path).toBe("verification/integrated/attempt-2/evidence.json");
    const bh008Evidence = JSON.parse(await readFile(join(setupResult.runDir, "verification/issue-8/attempt-1/evidence.json"), "utf8")) as VerificationEvidence;
    expect(bh008Evidence.issue_number).toBe(8);
    expect(bh008Evidence.commands.every((command) => command.stdout_path.startsWith("verification/issue-8/attempt-1/") && command.stderr_path.startsWith("verification/issue-8/attempt-1/") && command.result_path?.startsWith("verification/issue-8/attempt-1/"))).toBe(true);
    const verificationPaths = (await snapshotTree(join(setupResult.runDir, "verification"))).map(([path]) => path);
    expect(verificationPaths).toContain("integrated/attempt-1/evidence.json");
    expect(verificationPaths.filter((path) => path.startsWith("issue-6/") || path.startsWith("issue-7/"))).toEqual(["issue-6/sentinel.txt", "issue-7/sentinel.txt"]);
    expect(await snapshotTree(join(setupResult.runDir, "verification/issue-6"))).toEqual(beforeIssue6);
    expect(await snapshotTree(join(setupResult.runDir, "verification/issue-7"))).toEqual(beforeIssue7);
    expect(await readFile(join(setupResult.runDir, "verification/issue-6/sentinel.txt"), "utf8")).toBe(sentinel6);
    expect(await readFile(join(setupResult.runDir, "verification/issue-7/sentinel.txt"), "utf8")).toBe(sentinel7);
  }, 120_000);

  it("reuses the marker-matched issue identity and exact lineage PR on resume", async () => {
    const setupResult = await setup(); root = setupResult.root; const github = new RecordingGithub();
    const manifest = await readManifestV2(setupResult.runDir);
    const marker = { lineageId: manifest.task_lineage_id!, runId: manifest.run_id, workItemId: "feature" };
    const existingIssue = {
      number: 17, title: "[ship-feature:feature] Implement feature", body: formatIssueBody(plan.work_items[0]!, marker),
      labels: ISSUE_LABELS.split(","), state: "OPEN" as const, state_reason: null,
    };
    github.issues.set(17, existingIssue);
    github.findIssuesByMarker = async () => [existingIssue];
    const currentHead = headSha(join(setupResult.root, "worktree"));
    github.pullRequest = {
      number: 42, url: "https://github.com/acme/repo/pull/42", title: `Task: ${plan.summary}`,
      head_ref: "codex/brain-hands/run-1", head_sha: currentHead, base_ref: "main",
      body: plan.summary, closing_issue_numbers: [], state: "OPEN",
    };
    const workflowInput: Parameters<typeof runGithubWorkflow>[0] = { runDir: setupResult.runDir, repoRoot: setupResult.root, worktreePath: join(setupResult.root, "worktree"), branchName: "codex/brain-hands/run-1", baseBranch: "main", intake: { ...intake, repo_root: setupResult.root }, plan, codex: {} as never, dependencies: { github, hands: async (input) => { const value = implementation(input.workItem.id); const reportPath = "implementation/item.json"; await writeTextArtifact(setupResult.runDir, reportPath, `${JSON.stringify(value)}\n`); return { implementation: value, reportPath, invocation: {} as never }; }, verification: async (input) => evidenceForInput(input), verifier: async (input) => { const attempt = input.attempt ?? 1; const review = approvedReview(attempt); return { review, reviewPath: await writeTextArtifact(setupResult.runDir, `reviews/integrated/final-attempt-${attempt}.json`, `${JSON.stringify(review)}\n`), invocation: {} as never }; }, gitSnapshot: async () => ({ branch: "codex/brain-hands/run-1", status: "", gitDir: ".git", gitCommonDir: ".git", isLinkedWorktree: true }), localHeadSha: async () => currentHead, remoteBranchSha: async () => currentHead, pushCommit: async () => { throw new Error("exact existing delivery must not push"); }, push: async () => "pushed", commit: async () => "sha" } };
    const issueBoundary = await runGithubWorkflow(workflowInput);
    expect(issueBoundary.status, issueBoundary.blocker).toBe("awaiting_github_effects");
    const deliveryBoundary = await runGithubWorkflow(workflowInput);
    expect(deliveryBoundary.status, deliveryBoundary.blocker).toBe("awaiting_github_effects");
    const result = await runPastGithubEffectBoundaries(workflowInput);
    expect(result.status, result.blocker).toBe("github_ready"); expect(github.created).toHaveLength(0); expect(github.prs).toHaveLength(0);
    expect(github.updatedIssues).toHaveLength(1);
    expect((await readManifestV2(setupResult.runDir)).work_item_issue_map).toEqual({ feature: 17 });
    expect(github.calls).toContain("findPullRequestsByLineage");
    expect(github.calls).toContain("getPullRequest");
    expect(github.calls).toContain("updatePullRequestBody");
    const finalManifest = await readManifestV2(setupResult.runDir);
    expect((await readTaskLineage(setupResult.root, finalManifest.task_lineage_id!)).delivery).toMatchObject({
      state: "ready", pull_request_number: 42, pull_request_url: "https://github.com/acme/repo/pull/42",
      preview: { state: "applied" },
    });
  });

  it.each(["title", "managed body", "repository URL", "extra closing issue", "manifest mapping"] as const)(
    "fails closed on terminal exact-identity resume after %s tampering before GitHub mutation",
    async (kind) => {
      const { setupResult, github, workflowInput } = await exactFastResumeHarness();
      const beforeBodyUpdates = github.calls.filter((call) => call === "updatePullRequestBody").length;
      const beforeStatus = github.statusUpserts.length;
      if (kind === "manifest mapping") {
        const manifestPath = join(setupResult.runDir, "manifest.json");
        const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as RunManifestV2;
        manifest.work_item_issue_map = { feature: 18 };
        manifest.github_ids = { ...manifest.github_ids, issue_numbers: [18], work_item_issue_map: { feature: 18 } };
        await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      } else {
        const current = github.pullRequest!;
        if (kind === "title") github.pullRequest = { ...current, title: "tampered title" };
        if (kind === "managed body") github.pullRequest = { ...current, body: current.body!.replace("lineage=", "lineage=foreign-") };
        if (kind === "repository URL") github.pullRequest = { ...current, url: "https://github.com/acme/other/pull/42" };
        if (kind === "extra closing issue") github.pullRequest = { ...current, closing_issue_numbers: [17, 99] };
      }
      await expect(runGithubWorkflow(workflowInput)).rejects.toThrow(/authoritative|identity|mapping|marker|repository|managed|foreign/i);
      expect(github.calls.filter((call) => call === "updatePullRequestBody")).toHaveLength(beforeBodyUpdates);
      expect(github.statusUpserts).toHaveLength(beforeStatus);
      expect(github.prs).toHaveLength(0);
    },
    20_000,
  );

  it("accepts a valid terminal exact-identity resume without PR mutation", async () => {
    const { github, workflowInput } = await exactFastResumeHarness();
    const beforeBodyUpdates = github.calls.filter((call) => call === "updatePullRequestBody").length;
    const result = await runPastGithubEffectBoundaries(workflowInput);
    expect(result.status, result.blocker).toBe("github_ready");
    expect(github.calls.filter((call) => call === "updatePullRequestBody")).toHaveLength(beforeBodyUpdates);
    expect(github.prs).toHaveLength(0);
  }, 120_000);

  it("rejects a run-only work-item issue fallback when exact issue hydration fails", async () => {
    const { github, workflowInput } = await exactFastResumeHarness();
    github.getIssue = async () => { throw new Error("issue hydration unavailable"); };
    github.findIssueByMarker = async () => 17;
    const beforeStatus = github.statusUpserts.length;
    await expect(runGithubWorkflow(workflowInput)).rejects.toThrow(/hydration unavailable|exact durable ownership/i);
    expect(github.statusUpserts).toHaveLength(beforeStatus);
  }, 120_000);

  it("rejects a run-only parent issue fallback when exact parent hydration fails", async () => {
    const { github, workflowInput } = await exactFastResumeHarness(true);
    const readIssue = github.getIssue.bind(github);
    github.getIssue = async (number) => number === 9 ? Promise.reject(new Error("parent hydration unavailable")) : readIssue(number);
    github.findParentIssueByMarker = async () => ({ number: 9, title: "legacy parent", body: "run-only marker" });
    const beforeStatus = github.statusUpserts.length;
    await expect(runGithubWorkflow(workflowInput)).rejects.toThrow(/hydration unavailable|exact durable ownership/i);
    expect(github.statusUpserts).toHaveLength(beforeStatus);
  }, 120_000);

  it("runs the bounded post-PR Hands fix, verification, review, commit, and push loop", async () => {
    const config = qualityConfig();
    const setupResult = await setup(true, true); root = setupResult.root; const github = new RecordingGithub();
    const initialSha = headSha(join(setupResult.root, "worktree")); const postSha = "c".repeat(40); const treeSha = "d".repeat(40);
    const commitMessage = "work-item: integrated Integrated local delivery audit";
    let finalReviews = 0; let commitCalls = 0; let localSha = initialSha; let remoteSha: string | null = null;
    let localCommit = { sha: initialSha, parent_shas: [] as string[], tree_sha: "0".repeat(40), message: "initial" };
    const calls: string[] = []; const selfReviews: string[] = [];
    const getPullRequest = github.getPullRequest.bind(github);
    github.getPullRequest = async (number) => {
      const observed = await getPullRequest(number);
      calls.push(`reconcile-pr:${observed.head_sha ?? "missing"}`);
      return observed;
    };
    const workflowInput: Parameters<typeof runGithubWorkflow>[0] = { runDir: setupResult.runDir, repoRoot: setupResult.root, worktreePath: join(setupResult.root, "worktree"), branchName: "codex/brain-hands/run-1", baseBranch: "main", intake: { ...intake, repo_root: setupResult.root }, plan, codex: {} as never, config, dependencies: {
      github,
      hands: async (input) => {
        calls.push(`hands:${input.workItem.id}`);
        const result = input.workItem.id === "integrated"
          ? { ...implementation("integrated"), changed_files: ["src/feature.ts"] }
          : implementation(input.workItem.id);
        const reportPath = `implementation/${input.workItem.id}/attempt-${input.attempt}.json`;
        await writeTextArtifact(input.runDir, reportPath, `${JSON.stringify(result)}\n`);
        return { implementation: result, reportPath, invocation: {} as never };
      },
      verification: async (input) => { calls.push(`verify:${input.attempt}`); return evidenceForInput(input); },
      selfReview: async (input) => { const marker = `${input.workItem.id}:${input.parentAttempt}:${input.pass}`; selfReviews.push(marker); calls.push(`self-review:${marker}`); const report = selfReviewReport(input.workItem.id, input.parentAttempt, input.pass, input.mutationKind); const path = `self-review/${input.workItem.id}/attempt-${input.parentAttempt}/pass-${input.pass}.json`; await writeTextArtifact(input.runDir, path, `${JSON.stringify(report)}\n`); return { report, reportPath: path, invocation: {} as never }; },
      diff: async () => "diff",
      verifier: async (input) => { if (input.final) finalReviews += 1; const attempt = input.attempt ?? 1; const review = finalReviews === 2 ? { ...approvedReview(attempt), decision: "request_changes" as const, findings: [{ severity: "medium" as const, file: "src/feature.ts", line: null, acceptance_criterion: "feature works", problem: "missing", required_fix: "fix", re_verification: [] }] } : approvedReview(attempt); return { review, reviewPath: await writeTextArtifact(setupResult.runDir, `reviews/integrated/final-attempt-${attempt}.json`, `${JSON.stringify(review)}\n`), invocation: {} as never }; },
      gitSnapshot: (() => { let count = 0; return async () => ({ branch: "codex/brain-hands/run-1", status: count++ % 2 === 0 ? " M src/feature.ts\n" : "", gitDir: ".git", gitCommonDir: ".git", isLinkedWorktree: true }); })(),
      prepareCommitIntent: async () => ({ parent_sha: initialSha, tree_sha: treeSha, message: commitMessage }),
      remoteBranchAtLocalHead: async () => { if (remoteSha !== localSha) throw new Error("remote mismatch"); return localSha; },
      localHeadSha: async () => localSha,
      localCommitProvenance: async () => localCommit,
      commit: async () => { calls.push("commit"); commitCalls += 1; if (commitCalls > 1) { localSha = postSha; localCommit = { sha: postSha, parent_shas: [initialSha], tree_sha: treeSha, message: commitMessage }; } return localSha; },
      push: async () => { calls.push("push"); return "pushed"; },
      pushCommit: async (_repoRoot, sha) => {
        calls.push("push");
        remoteSha = sha;
        if (github.pullRequest) github.pullRequest = { ...github.pullRequest, head_sha: sha };
        return "pushed";
      },
      remoteBranchSha: async () => remoteSha,
      recordRemoteSynchronization: async (input) => {
        calls.push("record-remote-synchronization");
        return recordRemoteSynchronization({
          ...input,
          resolveLocalSha: async () => localSha,
          resolveRemoteSha: async () => remoteSha,
        });
      },
    } };
    const first = await runGithubWorkflow(workflowInput);
    expect(first.status, first.blocker).toBe("awaiting_github_effects");
    const second = await runGithubWorkflow(workflowInput);
    expect(second.status, second.blocker).toBe("awaiting_github_effects");
    const result = await runPastGithubEffectBoundaries(workflowInput);
    expect(result.status, result.blocker).toBe("github_ready"); expect(calls).toContain("hands:integrated"); expect(calls.filter((call) => call === "push")).toHaveLength(2);
    expect(selfReviews.filter((entry) => entry.startsWith("integrated:"))).toEqual(["integrated:3:1"]);
    expect(calls.indexOf("self-review:integrated:3:1")).toBeGreaterThan(calls.indexOf("hands:integrated"));
    const finalPushIndex = calls.lastIndexOf("push");
    const synchronizationIndex = calls.indexOf("record-remote-synchronization");
    expect(calls.slice(finalPushIndex + 1, synchronizationIndex)).toContain("reconcile-pr:" + localSha);
    const events = (await readFile(join(setupResult.runDir, "events.jsonl"), "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as { type?: string });
    expect(events.findIndex((event) => event.type === "pull_request_open")).toBeGreaterThan(events.findIndex((event) => event.type === "github_issue_created"));
    expect(events.some((event) => event.type === "github_issue_synced")).toBe(false);
  }, 120_000);

  it("routes an approved post-PR fix through policy, pushes it, and never merges", async () => {
    const setupResult = await setup(true, false, true); root = setupResult.root;
    const github = new RecordingGithub();
    const { state, workflowInput, initialSha, postPrSha } = await policyPostPrHarness(setupResult, github, "head");
    expect((await runGithubWorkflow(workflowInput)).status).toBe("awaiting_github_effects");
    expect((await runGithubWorkflow(workflowInput)).status).toBe("awaiting_github_effects");
    const first = await runGithubWorkflow(workflowInput);
    expect(first.status, first.blocker).toBe("human_action_required");
    expect(state.commitCalls, first.blocker).toBe(1);
    expect(state.interruptAt).toBe("push");
    const lineageId = (await readManifestV2(setupResult.runDir)).task_lineage_id!;
    expect((await readTaskLineage(setupResult.root, lineageId)).delivery).toMatchObject({
      head_sha: postPrSha,
      head_transition: {
        run_id: (await readManifestV2(setupResult.runDir)).run_id,
        work_item_id: "integrated",
        previous_head_sha: initialSha,
        authorized_head_sha: postPrSha,
      },
    });
    expect((await readManifestV2(setupResult.runDir)).work_item_progress.integrated).toMatchObject({
      push_expected_sha: postPrSha,
      push_remote_before_sha: initialSha,
      push_pending: false,
    });
    const second = await runGithubWorkflow(workflowInput);
    expect(second.status, second.blocker).toBe("human_action_required");
    expect(state.remoteSha, second.blocker).toBe(postPrSha);
    expect((await readTaskLineage(setupResult.root, lineageId)).delivery.head_sha).toBe(postPrSha);
    expect((await readManifestV2(setupResult.runDir)).work_item_progress.integrated).toMatchObject({
      push_expected_sha: postPrSha, push_pending: true,
    });
    const result = await runPastGithubEffectBoundaries(workflowInput);
    const decisionFiles = await readdir(join(setupResult.runDir, "reviews/decisions"));
    const phases = await Promise.all(decisionFiles.map(async (name) =>
      JSON.parse(await readFile(join(setupResult.runDir, "reviews/decisions", name), "utf8")).phase as string));
    expect(result.status, result.blocker).toBe("github_ready");
    expect(phases.filter((phase) => phase === "post_pr")).toEqual(["post_pr", "post_pr", "post_pr"]);
    expect((await readManifestV2(setupResult.runDir)).review_accounting?.fix_cycles_used).toBe(1);
    expect(state.commitIntentCalls).toBe(1);
    expect(state.commitProvenanceCalls).toBe(3);
    expect(state.commitCalls).toBe(1);
    expect(state.pushCalls).toBe(2);
    expect(state.pushedCommitShas).toEqual([initialSha, postPrSha]);
    expect(state.leaseBeforeShas).toEqual([null, initialSha]);
    expect((await readTaskLineage(setupResult.root, lineageId)).delivery.head_sha).toBe(postPrSha);
    expect("merge" in github).toBe(false);
  }, 180_000);

  it("resumes a non-policy post-PR push from an authorized new lineage head and old remote exactly once", async () => {
    const setupResult = await setup(true, false, true); root = setupResult.root;
    const github = new RecordingGithub();
    const { state, workflowInput, initialSha, postPrSha } = await policyPostPrHarness(setupResult, github, "head", true);
    workflowInput.config!.retry_policy.max_hands_fix_attempts = 2;
    expect((await runGithubWorkflow(workflowInput)).status).toBe("awaiting_github_effects");
    expect((await runGithubWorkflow(workflowInput)).status).toBe("awaiting_github_effects");
    const headCrash = await runGithubWorkflow(workflowInput);
    expect(headCrash.status, headCrash.blocker).toBe("human_action_required");
    expect(headCrash.blocker).toContain("head authority advance");
    const lineageId = (await readManifestV2(setupResult.runDir)).task_lineage_id!;
    expect((await readTaskLineage(setupResult.root, lineageId)).delivery.head_sha).toBe(postPrSha);
    expect(state.remoteSha).toBe(initialSha);
    const pushCrash = await runGithubWorkflow(workflowInput);
    expect(pushCrash.status, pushCrash.blocker).toBe("human_action_required");
    expect(state.remoteSha).toBe(postPrSha);
    await withTaskLineageTransaction({
      repoRoot: setupResult.root,
      lineageId,
      operation: async (transaction) => {
        const current = transaction.read();
        const { head_transition: _clearedPrefix, ...delivery } = current.delivery;
        await transaction.update({ ...current, delivery });
      },
    });
    const resumed = await runGithubWorkflow(workflowInput);
    expect(resumed.status, resumed.blocker).toBe("github_ready");
    expect(resumed.pullRequest?.head_sha).toBe(postPrSha);
    expect(state.pushedCommitShas).toEqual([initialSha, postPrSha]);
    expect(state.leaseBeforeShas).toEqual([null, initialSha]);
    expect((await readTaskLineage(setupResult.root, lineageId)).delivery.head_transition).toBeUndefined();
    const completedProgress = (await readManifestV2(setupResult.runDir)).work_item_progress.integrated!;
    expect(completedProgress).toMatchObject({ push_pending: false });
    expect(completedProgress.push_expected_sha).toBeUndefined();
    expect(completedProgress.push_remote_before_sha).toBeUndefined();

  }, 180_000);

  it("cannot replay a consumed post-PR transition after stale pending provenance and a remote reset", async () => {
    const setupResult = await setup(true, false, true); root = setupResult.root;
    const github = new RecordingGithub();
    const { state, workflowInput, initialSha, postPrSha, intendedTreeSha, commitMessage } = await policyPostPrHarness(setupResult, github, "consume", true);
    workflowInput.config!.retry_policy.max_hands_fix_attempts = 2;
    expect((await runGithubWorkflow(workflowInput)).status).toBe("awaiting_github_effects");
    expect((await runGithubWorkflow(workflowInput)).status).toBe("awaiting_github_effects");
    const consumedCrash = await runGithubWorkflow(workflowInput);
    expect(consumedCrash.status, consumedCrash.blocker).toBe("human_action_required");
    const manifest = await readManifestV2(setupResult.runDir);
    const lineageId = manifest.task_lineage_id!;
    expect((await readTaskLineage(setupResult.root, lineageId)).delivery.head_transition).toBeUndefined();
    expect(manifest.work_item_progress.integrated?.push_expected_sha).toBeUndefined();
    await updateManifestV2(setupResult.runDir, {
      work_item_progress: {
        ...manifest.work_item_progress,
        integrated: {
          ...manifest.work_item_progress.integrated!, push_pending: true,
          push_expected_sha: postPrSha, push_remote_before_sha: initialSha,
          push_local_before_sha: initialSha, push_commit_parent_sha: initialSha,
          push_commit_tree_sha: intendedTreeSha, push_commit_message: commitMessage,
        },
      },
    });
    state.remoteSha = initialSha;
    const pushesBeforeReplay = state.pushCalls;
    const replay = await runGithubWorkflow(workflowInput);
    expect(replay.status).toBe("human_action_required");
    expect(replay.blocker).toMatch(/authoritative lineage delivery identity|consumed|transition/i);
    expect(state.pushCalls).toBe(pushesBeforeReplay);
  }, 120_000);

  it.each(["title", "body", "closing", "base", "head_ref", "extra"] as const)(
    "fails closed on post-push %s PR drift before consuming transition authority",
    async (drift) => {
      const setupResult = await setup(true, false, true); root = setupResult.root;
      const github = new RecordingGithub();
      const { state, workflowInput, initialSha } = await policyPostPrHarness(setupResult, github, null, true);
      workflowInput.config!.retry_policy.max_hands_fix_attempts = 2;
      state.postPushPrDrift = drift;
      expect((await runGithubWorkflow(workflowInput)).status).toBe("awaiting_github_effects");
      expect((await runGithubWorkflow(workflowInput)).status).toBe("awaiting_github_effects");
      const result = await runPastGithubEffectBoundaries(workflowInput);
      expect(result.status).toBe("human_action_required");
      expect(result.blocker).toMatch(/pull request|lineage|authoritative|exactly one/i);
      const lineageId = (await readManifestV2(setupResult.runDir)).task_lineage_id!;
      expect((await readTaskLineage(setupResult.root, lineageId)).delivery.head_transition).toBeDefined();
      expect(state.leaseBeforeShas).toEqual([null, initialSha]);
    },
    120_000,
  );

  it("confirms an ambiguous non-policy post-PR push and does not repeat it after a persistence crash", async () => {
    const setupResult = await setup(true, false, true); root = setupResult.root;
    const github = new RecordingGithub();
    const { state, workflowInput, initialSha, postPrSha } = await policyPostPrHarness(setupResult, github, "push", true);
    workflowInput.config!.retry_policy.max_hands_fix_attempts = 2;
    state.ambiguousPostPrPush = true;
    expect((await runGithubWorkflow(workflowInput)).status).toBe("awaiting_github_effects");
    expect((await runGithubWorkflow(workflowInput)).status).toBe("awaiting_github_effects");
    const crashed = await runGithubWorkflow(workflowInput);
    expect(crashed.status, crashed.blocker).toBe("human_action_required");
    expect(crashed.blocker).toContain("successful post-PR push");
    expect(state.remoteSha).toBe(postPrSha);
    const resumed = await runGithubWorkflow(workflowInput);
    expect(resumed.status, resumed.blocker).toBe("github_ready");
    expect(state.pushedCommitShas).toEqual([initialSha, postPrSha]);
  }, 120_000);

  it("rejects non-policy local tip drift before resuming a pending exact-lease push", async () => {
    const setupResult = await setup(true, false, true); root = setupResult.root;
    const github = new RecordingGithub();
    const { state, workflowInput, initialSha } = await policyPostPrHarness(setupResult, github, "head", true);
    workflowInput.config!.retry_policy.max_hands_fix_attempts = 2;
    expect((await runGithubWorkflow(workflowInput)).status).toBe("awaiting_github_effects");
    expect((await runGithubWorkflow(workflowInput)).status).toBe("awaiting_github_effects");
    expect((await runGithubWorkflow(workflowInput)).status).toBe("human_action_required");
    state.localSha = "3".repeat(40);
    state.localCommit = { sha: state.localSha, parent_shas: [initialSha], tree_sha: "5".repeat(40), message: "unrelated" };
    const blocked = await runGithubWorkflow(workflowInput);
    expect(blocked.status).toBe("human_action_required");
    expect(blocked.blocker).toMatch(/provenance|local delivery branch and head|Local HEAD .* differs from work_item_progress\.integrated\.commit_sha/i);
    expect(state.pushedCommitShas).toEqual([initialSha]);
  }, 120_000);

  it("rejects an arbitrary remote head while a non-policy exact-lease push is pending", async () => {
    const setupResult = await setup(true, false, true); root = setupResult.root;
    const github = new RecordingGithub();
    const { state, workflowInput, initialSha } = await policyPostPrHarness(setupResult, github, "head", true);
    workflowInput.config!.retry_policy.max_hands_fix_attempts = 2;
    expect((await runGithubWorkflow(workflowInput)).status).toBe("awaiting_github_effects");
    expect((await runGithubWorkflow(workflowInput)).status).toBe("awaiting_github_effects");
    expect((await runGithubWorkflow(workflowInput)).status).toBe("human_action_required");
    state.remoteSha = "9".repeat(40);
    const blocked = await runGithubWorkflow(workflowInput);
    expect(blocked.status).toBe("human_action_required");
    expect(blocked.blocker).toMatch(/authoritative lineage delivery identity|remote branch changed/i);
    expect(state.pushedCommitShas).toEqual([initialSha]);
  }, 120_000);

  it("rejects a manually advanced lineage head without its durable transition prefix", async () => {
    const setupResult = await setup(true, false, true); root = setupResult.root;
    const github = new RecordingGithub();
    const { state, workflowInput, initialSha } = await policyPostPrHarness(setupResult, github, "head", true);
    workflowInput.config!.retry_policy.max_hands_fix_attempts = 2;
    expect((await runGithubWorkflow(workflowInput)).status).toBe("awaiting_github_effects");
    expect((await runGithubWorkflow(workflowInput)).status).toBe("awaiting_github_effects");
    expect((await runGithubWorkflow(workflowInput)).status).toBe("human_action_required");
    const lineageId = (await readManifestV2(setupResult.runDir)).task_lineage_id!;
    await withTaskLineageTransaction({
      repoRoot: setupResult.root,
      lineageId,
      operation: async (transaction) => {
        const current = transaction.read();
        const { head_transition: _removed, ...delivery } = current.delivery;
        await transaction.update({ ...current, delivery });
      },
    });
    const blocked = await runGithubWorkflow(workflowInput);
    expect(blocked.status).toBe("human_action_required");
    expect(blocked.blocker).toContain("authoritative lineage delivery identity");
    expect(state.pushedCommitShas).toEqual([initialSha]);
  }, 120_000);

  it("executes one policy-selected post-PR quality recovery with the backup profile", async () => {
    const setupResult = await setup(true, false, true, false, 0, "origin", qualityBackup); root = setupResult.root;
    const github = new RecordingGithub();
    const { state, workflowInput } = await policyPostPrHarness(setupResult, github, "effect");

    const first = await runGithubWorkflow(workflowInput);
    expect(first.status, first.blocker).toBe("awaiting_github_effects");
    const second = await runGithubWorkflow(workflowInput);
    expect(second.status, second.blocker).toBe("awaiting_github_effects");
    const interrupted = await runPastGithubEffectBoundaries(workflowInput);
    expect(interrupted.status).toBe("human_action_required");
    expect(interrupted.blocker).toContain("crash after completed post-PR fix effect");
    expect(interrupted.blocker).not.toContain("Post-PR review policy stopped");
    const decisionFiles = await readdir(join(setupResult.runDir, "reviews/decisions"));
    const cycles = await Promise.all(decisionFiles.map(async (name) =>
      reviewCycleStateSchema.parse(JSON.parse(await readFile(join(setupResult.runDir, "reviews/decisions", name), "utf8")))));
    const cycle = cycles.find((candidate) => candidate.phase === "post_pr");
    const interruptedManifest = await readManifestV2(setupResult.runDir);
    expect(cycle?.decision.action).toBe("quality_recovery");
    expect(interruptedManifest.convergence_reports?.integrated?.review_revision).not.toBe(cycle?.review_revision);
    expect(interruptedManifest.active_hands_profile).toBe("primary");
    const completion = reviewCycleStateSchema.parse(JSON.parse(await readFile(join(
      setupResult.runDir,
      "reviews/effects",
      Buffer.from(cycle!.effect_id).toString("base64url"),
      "completion.json",
    ), "utf8")));
    expect(completion.effect_state).toBe("complete");
    expect(state.handsProfiles).toContain("backup-hands");
    expect(interruptedManifest.recovery.scopes["integrated:post-pr"]).toMatchObject({
      disposition: "active",
      head_sequence: 1,
      consecutive_without_progress: 1,
    });
    expect(state.finalReviews).toBeGreaterThanOrEqual(2);
    expect("merge" in github).toBe(false);
  }, 180_000);

  it("records post-PR verification infrastructure failures in their own recovery scope", async () => {
    const setupResult = await setup(true, false, true); root = setupResult.root;
    const github = new RecordingGithub();
    const { workflowInput } = await policyPostPrHarness(setupResult, github, null);
    const verification = workflowInput.dependencies.verification;
    if (!verification) throw new Error("Post-PR harness requires verification");
    workflowInput.dependencies.verification = async (input) => {
      if (input.identity?.work_item_id === "integrated" && input.attempt === 2) {
        throw new Error("post-PR runner unavailable");
      }
      return verification(input);
    };

    expect((await runGithubWorkflow(workflowInput)).status).toBe("awaiting_github_effects");
    expect((await runGithubWorkflow(workflowInput)).status).toBe("awaiting_github_effects");
    const result = await runPastGithubEffectBoundaries(workflowInput);
    expect(result.status).toBe("human_action_required");
    expect(result.blocker).toContain("Post-PR verification infrastructure failed");
    expect((await readManifestV2(setupResult.runDir)).recovery.scopes["integrated:post-pr"]).toMatchObject({
      disposition: "awaiting_external_fix",
      head_sequence: 1,
      consecutive_without_progress: 1,
    });
    expect("merge" in github).toBe(false);
  }, 180_000);

  it("rechecks a committed bounded post-PR candidate without repeating Hands or commit", async () => {
    const setupResult = await setup(true, false, true); root = setupResult.root;
    await enableBoundedProtocol(setupResult.runDir);
    const github = new RecordingGithub();
    const { state, workflowInput } = await policyPostPrHarness(setupResult, github, "commit");
    const verification = workflowInput.dependencies.verification!;
    workflowInput.dependencies.verification = async (input) => {
      const value = await verification(input);
      const command = input.commands[0];
      const argv = Array.isArray(command) ? [...command] : [command ?? "npm test"];
      value.commands[0]!.argv = argv;
      value.commands[0]!.command = argv.join(" ");
      await writeTextArtifact(input.runDir, value.commands[0]!.result_path!, `${JSON.stringify({
        argv,
        stdout: "stdout\n",
        stderr: "stderr\n",
        exit_code: value.commands[0]!.exit_code,
        duration_ms: value.commands[0]!.duration_ms ?? 0,
        timed_out: value.commands[0]!.timed_out,
        error_code: value.commands[0]!.error_code,
        error_message: value.commands[0]!.error_message,
        signal: value.commands[0]!.signal,
      })}\n`);
      await writeTextArtifact(input.runDir, value.evidence_path!, `${JSON.stringify(value)}\n`);
      return value;
    };

    const first = await runPastGithubEffectBoundaries(workflowInput);
    expect(first.status).toBe("human_action_required");
    expect(first.blocker).toContain("crash after successful post-PR commit");
    const mutationKindsAfterCommit = [...state.mutationKinds];

    const second = await runGithubWorkflow(workflowInput);
    expect(second.status).toBe("human_action_required");
    expect(second.blocker).toContain("crash after successful post-PR push");
    const result = await runPastGithubEffectBoundaries(workflowInput);

    expect(result.status, result.blocker).toBe("github_ready");
    expect(state.commitCalls).toBe(1);
    expect(state.mutationKinds).toEqual(mutationKindsAfterCommit);
    expect(state.integratedVerificationAttempts).toEqual([1, 2, 3, 4]);
    const manifest = await readManifestV2(setupResult.runDir);
    expect(manifest.work_item_progress.integrated).toMatchObject({
      status: "complete",
      attempts: 4,
      commit_sha: state.localSha,
      verification_path: "verification/integrated/attempt-4/evidence.json",
      review_path: "reviews/integrated/final-attempt-4.json",
      delivery_phase: "post_pr",
    });
    expect(manifest.final_verifier_index_path).toBe(
      evidenceIndexWorkflow.verifierEvidenceIndexPath("post_pr", 4),
    );
    expect(manifest.work_item_progress.integrated?.candidate_recheck).toBeUndefined();
  }, 180_000);

  it("resumes a rejected post-PR candidate recheck from its durable Hands report", async () => {
    const setupResult = await setup(true, false, true); root = setupResult.root;
    await enableBoundedProtocol(setupResult.runDir);
    const github = new RecordingGithub();
    const { state, workflowInput } = await policyPostPrHarness(
      setupResult,
      github,
      "recheck_hands",
      false,
      false,
      1,
      true,
    );
    const verification = workflowInput.dependencies.verification!;
    workflowInput.dependencies.verification = async (input) => {
      const value = await verification(input);
      const command = input.commands[0];
      const argv = Array.isArray(command) ? [...command] : [command ?? "npm test"];
      value.commands[0]!.argv = argv;
      value.commands[0]!.command = argv.join(" ");
      await writeTextArtifact(input.runDir, value.commands[0]!.result_path!, `${JSON.stringify({
        argv,
        stdout: "stdout\n",
        stderr: "stderr\n",
        exit_code: value.commands[0]!.exit_code,
        duration_ms: value.commands[0]!.duration_ms ?? 0,
        timed_out: value.commands[0]!.timed_out,
        error_code: value.commands[0]!.error_code,
        error_message: value.commands[0]!.error_message,
        signal: value.commands[0]!.signal,
      })}\n`);
      await writeTextArtifact(input.runDir, value.evidence_path!, `${JSON.stringify(value)}\n`);
      return value;
    };

    const interrupted = await runPastGithubEffectBoundaries(workflowInput);
    expect(interrupted.status).toBe("human_action_required");
    expect(interrupted.blocker).toContain("crash after candidate-recheck Hands report");
    expect(state.integratedHandsAttempts).toEqual([3, 5]);
    expect(state.commitCalls).toBe(1);
    expect((await readManifestV2(setupResult.runDir)).work_item_progress.integrated?.candidate_recheck).toBeUndefined();
    const pushCallsAtCrash = state.pushCalls;

    const result = await runPastGithubEffectBoundaries(workflowInput);

    expect(result.status, result.blocker).toBe("github_ready");
    expect(state.integratedHandsAttempts).toEqual([3, 5]);
    expect(state.integratedContextRefs.every((ref) => ref !== "missing")).toBe(true);
    expect(new Set(state.integratedContextBases)).toEqual(new Set([state.integratedContextBases[0]!]));
    expect(state.integratedContextDiffs.every((diff) => diff !== "missing")).toBe(true);
    expect(state.integratedBroadInputs).toEqual([false, false]);
    expect(state.commitCalls).toBe(2);
    expect(state.pushCalls).toBe(pushCallsAtCrash + 1);
    expect(state.integratedVerificationAttempts).toEqual([1, 2, 3, 4, 5, 6]);
    const manifest = await readManifestV2(setupResult.runDir);
    expect(manifest.review_accounting?.fix_cycles_used).toBe(2);
    expect(manifest.work_item_progress.integrated).toMatchObject({
      status: "complete",
      attempts: 6,
      commit_sha: state.localSha,
      verification_path: "verification/integrated/attempt-6/evidence.json",
      review_path: "reviews/integrated/final-attempt-6.json",
      delivery_phase: "post_pr",
      terminal_hands_fix_attempts: 2,
    });
    expect(manifest.final_verifier_index_path).toBe(
      evidenceIndexWorkflow.verifierEvidenceIndexPath("post_pr", 6),
    );
    expect(manifest.final_verifier_index_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.work_item_progress.integrated?.candidate_recheck).toBeUndefined();
  }, 180_000);

  it("keeps post-PR terminal fixes normal across rejected candidate rechecks", async () => {
    const setupResult = await setup(true, true, true); root = setupResult.root;
    await enableBoundedProtocol(setupResult.runDir);
    const github = new RecordingGithub();
    const { state, workflowInput } = await policyPostPrHarness(
      setupResult,
      github,
      null,
      false,
      false,
      1,
      true,
      2,
      false,
    );
    const verification = workflowInput.dependencies.verification!;
    workflowInput.dependencies.verification = async (input) => {
      const value = await verification(input);
      const command = input.commands[0];
      const argv = Array.isArray(command) ? [...command] : [command ?? "npm test"];
      value.commands[0]!.argv = argv;
      value.commands[0]!.command = argv.join(" ");
      await writeTextArtifact(input.runDir, value.commands[0]!.result_path!, `${JSON.stringify({
        argv,
        stdout: "stdout\n",
        stderr: "stderr\n",
        exit_code: value.commands[0]!.exit_code,
        duration_ms: value.commands[0]!.duration_ms ?? 0,
        timed_out: value.commands[0]!.timed_out,
        error_code: value.commands[0]!.error_code,
        error_message: value.commands[0]!.error_message,
        signal: value.commands[0]!.signal,
      })}\n`);
      await writeTextArtifact(input.runDir, value.evidence_path!, `${JSON.stringify(value)}\n`);
      return value;
    };

    const result = await runPastGithubEffectBoundaries(workflowInput);

    expect(result.status, result.blocker).toBe("github_ready");
    expect(state.integratedHandsKinds).toEqual(["3:primary_fix", "5:primary_fix"]);
    expect(state.mutationKinds.filter((entry) => entry.startsWith("integrated:"))).toEqual([
      "integrated:normal_fix:3:1",
      "integrated:normal_fix:5:1",
    ]);
    const manifest = await readManifestV2(setupResult.runDir);
    expect(manifest.work_item_progress.integrated).toMatchObject({
      status: "complete",
      terminal_hands_fix_attempts: 2,
      mutation_kind: "normal_fix",
    });
  }, 180_000);

  it("reports the configured post-PR review-policy fix limit", async () => {
    const setupResult = await setup(true, false, true, false, 1, "origin", undefined, "stop"); root = setupResult.root;
    await enableBoundedProtocol(setupResult.runDir);
    const github = new RecordingGithub();
    const { workflowInput } = await policyPostPrHarness(
      setupResult,
      github,
      null,
      false,
      false,
      2,
      false,
      1,
      false,
    );
    const verification = workflowInput.dependencies.verification!;
    workflowInput.dependencies.verification = async (input) => {
      const value = await verification(input);
      const command = input.commands[0];
      const argv = Array.isArray(command) ? [...command] : [command ?? "npm test"];
      value.commands[0]!.argv = argv;
      value.commands[0]!.command = argv.join(" ");
      await writeTextArtifact(input.runDir, value.commands[0]!.result_path!, `${JSON.stringify({
        argv,
        stdout: "stdout\n",
        stderr: "stderr\n",
        exit_code: value.commands[0]!.exit_code,
        duration_ms: value.commands[0]!.duration_ms ?? 0,
        timed_out: value.commands[0]!.timed_out,
        error_code: value.commands[0]!.error_code,
        error_message: value.commands[0]!.error_message,
        signal: value.commands[0]!.signal,
      })}\n`);
      await writeTextArtifact(input.runDir, value.evidence_path!, `${JSON.stringify(value)}\n`);
      return value;
    };

    const result = await runPastGithubEffectBoundaries(workflowInput);

    expect(result.status).toBe("human_action_required");
    expect(result.blocker).toBe("Post-PR review policy stopped: fix_limit_reached");
  }, 180_000);

  it("resumes post-PR fixes through snapshotted max_fix_cycles 5 without legacy bounds or labels", async () => {
    const setupResult = await setup(true, true, true, false, 5); root = setupResult.root;
    const github = new RecordingGithub();
    const { state, workflowInput } = await approvalPolicyPostPrHarness(setupResult, github, "effect", false, false, 4);

    expect((await runGithubWorkflow(workflowInput)).status).toBe("awaiting_github_effects");
    expect((await runGithubWorkflow(workflowInput)).status).toBe("awaiting_github_effects");
    const interrupted = await runPastGithubEffectBoundaries(workflowInput);
    expect(interrupted.status).toBe("human_action_required");
    expect(interrupted.blocker).toContain("crash after completed post-PR fix effect");
    const result = await runPastGithubEffectBoundaries(workflowInput);
    const manifest = await readManifestV2(setupResult.runDir);

    expect(result.status, result.blocker).toBe("github_ready");
    expect(manifest.review_accounting?.fix_cycles_used).toBe(4);
    const integratedKinds = state.mutationKinds
      .filter((entry) => entry.startsWith("integrated:"))
      .map((entry) => entry.split(":")[1]);
    expect(integratedKinds).toHaveLength(4);
    expect(new Set(integratedKinds)).toEqual(new Set(["normal_fix"]));
    expect(state.finalReviews).toBe(7);
    expect("merge" in github).toBe(false);
  }, 180_000);

  it("approves a post-PR replan for its concrete target and resumes on the same worktree", async () => {
    const setupResult = await setup(true, false, true); root = setupResult.root;
    const github = new RecordingGithub();
    const { state, workflowInput } = await approvalPolicyPostPrHarness(setupResult, github, null, false, true);

    const interrupted = await runPastGithubEffectBoundaries(workflowInput);
    expect(interrupted.status).toBe("human_action_required");
    expect(interrupted.blocker).toBe("Review policy requires replanning feature from post_pr");
    expect(interrupted.manifest.pending_plan_approval).not.toBeNull();
    const interruptedPending = interrupted.manifest.pending_plan_approval!;
    const interruptedRequest = await readFile(join(setupResult.runDir, interruptedPending.request_path), "utf8");
    let bootstrapCalls = 0;
    const progressCodes: string[] = [];
    const statusCountBeforeForgedPlan = github.statusUpserts.length;
    const forgedPending = await runGithubWorkflow({
      ...workflowInput,
      plan: {
        ...workflowInput.plan,
        controller_bootstrap: {
          version: 1,
          baseline_commit: interrupted.manifest.source_commit!,
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
    expect(forgedPending.status).toBe("human_action_required");
    expect(forgedPending.blocker).toMatch(/caller plan|approved recorded plan/i);
    expect(progressCodes).toEqual([]);
    expect(github.statusUpserts).toHaveLength(statusCountBeforeForgedPlan);
    const pending = interrupted;
    expect(pending.status, pending.blocker).toBe("human_action_required");
    expect(pending.manifest.stage, pending.blocker).toBe("awaiting_plan_approval");
    const baseRevision = pending.manifest.approved_revision!;
    expect(pending.manifest.current_revision).toBe(baseRevision);
    expect(pending.manifest.approved_revision).toBe(baseRevision);
    expect(pending.manifest.pending_plan_approval?.proposed_revision).toBe(baseRevision + 1);
    expect(pending.manifest.pending_plan_approval).toEqual(interruptedPending);
    expect(await readFile(join(setupResult.runDir, interruptedPending.request_path), "utf8")).toBe(interruptedRequest);
    expect(await readFile(join(setupResult.runDir, `plans/revision-${baseRevision + 1}.md`), "utf8"))
      .toContain('"schema_version": "2.0"');
    expect(state.brainCalls).toBe(1);
    expect(bootstrapCalls).toBe(0);
    expect(progressCodes).toEqual([]);
    expect(pending.blocker).not.toContain("GitHub runtime failed");
    expect(pending.blocker).toBe("Review policy requires replanning feature from post_pr");
    expect(pending.manifest.last_blocker).toBe(pending.blocker);
    expect(await readOperatorStatus(setupResult.runDir)).toMatchObject({
      operator_state: "awaiting_plan_approval",
      blocker: pending.blocker,
    });
    expect(github.statusUpserts.at(-1)?.body).toBe(
      `<!-- brain-hands-run-status:${pending.manifest.run_id} -->\nLocal plan approval required for revision ${baseRevision + 1}.`,
    );
    expect(github.statusUpserts.at(-1)?.body).not.toContain(interruptedPending.request_path);
    expect(github.statusUpserts.at(-1)?.body).not.toContain(`plans/revision-${baseRevision + 1}.md`);
    expect(github.statusUpserts.at(-1)?.body).not.toContain("approve-plan");
    expect(github.statusUpserts.at(-1)?.body).not.toContain("src/");
    expect(github.statusUpserts.at(-1)?.body).not.toContain("findings");
    expect(github.statusUpserts.at(-1)?.body).not.toContain("model");
    expect(pending.manifest.work_item_progress.integrated).toMatchObject({
      replan_target_work_item_id: "feature",
      delivery_phase: "post_pr",
    });
    expect(pending.manifest.work_item_progress.feature).toMatchObject({
      replan_source_work_item_id: "integrated",
      replan_patch_path: pending.manifest.work_item_progress.integrated?.replan_patch_path,
    });
    await updateManifestV2(setupResult.runDir, {
      issue_numbers: [17, 99],
      github_ids: { ...pending.manifest.github_ids, issue_numbers: [17, 99] },
    });
    const statusCountBeforeForgedOrder = github.statusUpserts.length;
    const forgedOrder = await runGithubWorkflow({
      ...workflowInput,
      plan: { ...workflowInput.plan, work_items: [item("forged"), ...workflowInput.plan.work_items] },
    });
    expect(forgedOrder.status).toBe("human_action_required");
    expect(forgedOrder.blocker).toMatch(/caller plan|approved recorded plan/i);
    expect(github.statusUpserts).toHaveLength(statusCountBeforeForgedOrder);
    await updateManifestV2(setupResult.runDir, {
      issue_numbers: [17],
      github_ids: { ...pending.manifest.github_ids, issue_numbers: [17] },
    });
    const approved = await approvePreparedReplanRevision(setupResult.runDir, "feature", baseRevision + 1, { approvalControllerCapture });
    const replayed = await approvePreparedReplanRevision(setupResult.runDir, "feature", baseRevision + 1, { approvalControllerCapture });
    expect(replayed).toEqual(approved);
    expect(approved.stage).toBe("worktree_setup");
    expect(approved.delivery_state).toBe("pending");
    expect(approved.worktree_path).toBe(pending.manifest.worktree_path);
    expect(approved.branch_name).toBe(pending.manifest.branch_name);
    expect(approved.work_item_progress.feature).toMatchObject({
      plan_revision: baseRevision + 1,
      fix_cycles_used: 0,
    });
    expect(approved.work_item_progress.integrated?.approved_replan_history).toContainEqual(expect.objectContaining({
      review_cycle_path: pending.manifest.work_item_progress.integrated?.review_cycle_path,
      review_effect_id: pending.manifest.work_item_progress.integrated?.review_effect_id,
      target_work_item_id: "feature",
      delivery_phase: "post_pr",
    }));
    expect(approved.work_item_progress.integrated?.attempts).toBe(
      pending.manifest.work_item_progress.integrated!.attempts + 1,
    );
    expect(approved.work_item_progress.integrated).not.toHaveProperty("review_cycle_path");
    expect(approved.work_item_progress.integrated).not.toHaveProperty("replan_patch_path");

    state.replanPending = false;
    github.findIssueByMarker = async () => 17;
    github.findIssuesByMarker = async () => [{ ...(await github.getIssue(17)), labels: [] }];
    github.findPullRequestByHead = async () => ({ number: 42, url: "https://github.com/acme/repo/pull/42", head_ref: workflowInput.branchName, head_sha: state.localSha, state: "OPEN" });
    const revisedPlan = JSON.parse(await readFile(
      join(setupResult.runDir, approved.plan_revisions[String(baseRevision + 1)]!.path),
      "utf8",
    )) as BrainPlan;
    const statusCountBeforeResume = github.statusUpserts.length;
    const verificationCountBeforeResume = state.integratedVerificationAttempts.length;
    let resumed = await runGithubWorkflow({ ...workflowInput, plan: revisedPlan });
    for (let boundary = 0; resumed.status === "awaiting_github_effects" && boundary < 4; boundary += 1) {
      resumed = await runGithubWorkflow({ ...workflowInput, plan: revisedPlan });
    }
    expect(resumed.status, resumed.blocker).toBe("github_ready");
    expect(state.integratedVerificationAttempts[verificationCountBeforeResume]).toBe(
      approved.work_item_progress.integrated!.attempts,
    );
    expect(resumed.manifest.worktree_path).toBe(pending.manifest.worktree_path);
    expect(resumed.manifest.branch_name).toBe(pending.manifest.branch_name);
    expect(github.statusUpserts.slice(statusCountBeforeResume).some((entry) =>
      entry.body.includes("Progressing automatically") && entry.body.includes("- Stage: `implementing`"))).toBe(true);
    expect("merge" in github).toBe(false);
  }, 240_000);

  it("fails closed without status publication when approval already won and caller plan is stale", async () => {
    const setupResult = await setup(true, false, true); root = setupResult.root;
    const github = new RecordingGithub();
    const { state, workflowInput } = await approvalPolicyPostPrHarness(setupResult, github, "replan_boundary", false, true);
    const prepared = await runPastGithubEffectBoundaries(workflowInput);
    const proposedRevision = prepared.manifest.pending_plan_approval?.proposed_revision;
    expect(proposedRevision).toBeGreaterThan(1);
    const statusCount = github.statusUpserts.length;
    const promoted = await approvePreparedReplanRevision(setupResult.runDir, "feature", proposedRevision!, { approvalControllerCapture });
    let bootstrapCalls = 0;
    let handsCalls = 0;

    const result = await runGithubWorkflow({
      ...workflowInput,
      dependencies: {
        ...workflowInput.dependencies,
        controllerBootstrap: async () => { bootstrapCalls += 1; return {} as never; },
        hands: async () => { handsCalls += 1; throw new Error("Hands must not run after concurrent promotion"); },
      },
    });

    expect(result.status).toBe("human_action_required");
    expect(result.blocker).toMatch(/caller plan differs/i);
    expect((await readManifestV2(setupResult.runDir)).approved_revision).toBe(promoted.approved_revision);
    expect(bootstrapCalls).toBe(0);
    expect(handsCalls).toBe(0);
    expect(state.brainCalls).toBe(1);
    expect(github.statusUpserts).toHaveLength(statusCount);
  }, 120_000);

  it.each([
    { label: "successful", throws: false },
    { label: "throwing", throws: true },
  ])("hands off without publication when approval wins after a $label pre-bootstrap reconciliation", async ({ throws }) => {
    const setupResult = await setup(true, false, true); root = setupResult.root;
    const github = new RecordingGithub();
    const { state, workflowInput } = await approvalPolicyPostPrHarness(setupResult, github, "replan_boundary", false, true);
    const pending = await runPastGithubEffectBoundaries(workflowInput);
    const proposedRevision = pending.manifest.pending_plan_approval?.proposed_revision;
    expect(proposedRevision).toBeGreaterThan(1);
    const statusCount = github.statusUpserts.length;
    let promoted: RunManifestV2 | null = null;
    let bootstrapCalls = 0;
    let handsCalls = 0;

    const result = await runGithubWorkflow({
      ...workflowInput,
      dependencies: {
        ...workflowInput.dependencies,
        afterCheckpoint: async (checkpoint) => {
          if (checkpoint !== "after_replan_pending_reconciliation") return;
          promoted = await approvePreparedReplanRevision(setupResult.runDir, "feature", proposedRevision!, { approvalControllerCapture });
          if (throws) throw new Error("crash after pre-bootstrap pending reconciliation");
        },
        controllerBootstrap: async () => { bootstrapCalls += 1; return {} as never; },
        hands: async () => { handsCalls += 1; throw new Error("Hands must not run after concurrent promotion"); },
      },
    });

    expect(promoted).not.toBeNull();
    expect(result.status).toBe("human_action_required");
    expect(result.blocker).toMatch(/approved concurrently.*retry/i);
    expect(result.manifest).toEqual(promoted);
    expect(await readManifestV2(setupResult.runDir)).toEqual(promoted);
    expect(bootstrapCalls).toBe(0);
    expect(handsCalls).toBe(0);
    expect(state.brainCalls).toBe(1);
    expect(github.statusUpserts).toHaveLength(statusCount);
  }, 120_000);

  it("preserves a promotion that clears pending before the post-commit delivery catch", async () => {
    const setupResult = await setup(true, false, true); root = setupResult.root;
    const github = new RecordingGithub();
    const { state, workflowInput } = await approvalPolicyPostPrHarness(setupResult, github, null, false, true);
    let promoted: RunManifestV2 | null = null;
    let statusCountAtPromotion = -1;
    workflowInput.dependencies.afterCheckpoint = async (checkpoint) => {
      if (checkpoint !== "after_replan_boundary_commit") return;
      const proposedRevision = (await readManifestV2(setupResult.runDir)).pending_plan_approval?.proposed_revision;
      if (proposedRevision === undefined) throw new Error("prepared replan pointer is missing");
      promoted = await approvePreparedReplanRevision(setupResult.runDir, "feature", proposedRevision, { approvalControllerCapture });
      statusCountAtPromotion = github.statusUpserts.length;
      throw new Error("crash after concurrently promoted replan boundary");
    };

    const result = await runPastGithubEffectBoundaries(workflowInput);

    expect(promoted).not.toBeNull();
    expect(result.status).toBe("human_action_required");
    expect(result.blocker).toMatch(/approved concurrently.*retry/i);
    expect(result.manifest).toEqual(promoted);
    expect(await readManifestV2(setupResult.runDir)).toEqual(promoted);
    expect(state.brainCalls).toBe(1);
    expect(state.handsCalls).toBe(1);
    expect(github.statusUpserts).toHaveLength(statusCountAtPromotion);
  }, 120_000);

  it("fails closed when promotion already won before resume and caller plan is stale", async () => {
    const setupResult = await setup(true, false, true); root = setupResult.root;
    const github = new RecordingGithub();
    const { state, workflowInput } = await approvalPolicyPostPrHarness(setupResult, github, null, false, true);
    const prepared = await runPastGithubEffectBoundaries(workflowInput);
    const proposedRevision = prepared.manifest.pending_plan_approval?.proposed_revision;
    expect(proposedRevision).toBeGreaterThan(1);
    const statusCountAtPromotion = github.statusUpserts.length;
    const promoted = await approvePreparedReplanRevision(setupResult.runDir, "feature", proposedRevision!, { approvalControllerCapture });

    const result = await runPastGithubEffectBoundaries(workflowInput);

    expect(result.status).toBe("human_action_required");
    expect(result.blocker).toMatch(/caller plan differs/i);
    expect((await readManifestV2(setupResult.runDir)).approved_revision).toBe(promoted.approved_revision);
    expect(state.brainCalls).toBe(1);
    expect(github.statusUpserts).toHaveLength(statusCountAtPromotion);
  }, 120_000);

  it.each([
    { label: "successful", throws: false },
    { label: "throwing", throws: true },
  ])("hands off without publication after a $label awaiting-transition promotion", async ({ throws }) => {
    const setupResult = await setup(true, false, true); root = setupResult.root;
    const github = new RecordingGithub();
    const { state, workflowInput } = await approvalPolicyPostPrHarness(setupResult, github, null, false, true);
    let promoted: RunManifestV2 | null = null;
    let statusCountAtPromotion = -1;
    workflowInput.dependencies.afterCheckpoint = async (checkpoint) => {
      if (checkpoint !== "after_replan_awaiting_transition") return;
      const proposedRevision = (await readManifestV2(setupResult.runDir)).pending_plan_approval?.proposed_revision;
      if (proposedRevision === undefined) throw new Error("prepared replan pointer is missing");
      promoted = await approvePreparedReplanRevision(setupResult.runDir, "feature", proposedRevision, { approvalControllerCapture });
      statusCountAtPromotion = github.statusUpserts.length;
      if (throws) throw new Error("crash after awaiting-transition promotion");
    };

    const result = await runPastGithubEffectBoundaries(workflowInput);

    expect(promoted).not.toBeNull();
    expect(result.status).toBe("human_action_required");
    expect(result.blocker).toMatch(/approved concurrently.*retry/i);
    expect(result.manifest).toEqual(promoted);
    expect(await readManifestV2(setupResult.runDir)).toEqual(promoted);
    expect(state.brainCalls).toBe(1);
    expect(state.handsCalls).toBe(1);
    expect(github.statusUpserts).toHaveLength(statusCountAtPromotion);
  }, 120_000);

  it("guards an exact pending-replan candidate immediately before status publication", async () => {
    const setupResult = await setup(true, false, true); root = setupResult.root;
    const github = new RecordingGithub();
    const { workflowInput } = await approvalPolicyPostPrHarness(setupResult, github, null, false, true);
    const pending = await runPastGithubEffectBoundaries(workflowInput);
    expect(pending.pendingReplanBoundary).toBeDefined();
    const statusCount = github.statusUpserts.length;
    const promoted = await approvePreparedReplanRevision(
      setupResult.runDir,
      "feature",
      pending.pendingReplanBoundary!.proposedRevision,
      { approvalControllerCapture },
    );

    const guarded = await publishGithubWorkflowStatus(workflowInput, {
      ...pending,
      pendingReplanBoundary: undefined,
    });

    expect(guarded.status).toBe("human_action_required");
    expect(guarded.blocker).toMatch(/approved concurrently.*retry/i);
    expect(guarded.manifest).toEqual(promoted);
    expect(await readManifestV2(setupResult.runDir)).toEqual(promoted);
    expect(github.statusUpserts).toHaveLength(statusCount);
  }, 120_000);

  it("atomically narrows the owning execution lease for runtime-created replan status publication", async () => {
    const setupResult = await setup(true, false, true); root = setupResult.root;
    const github = new RecordingGithub();
    const { workflowInput } = await approvalPolicyPostPrHarness(setupResult, github, null, false, true);
    const markerPath = join(setupResult.root, "forbidden-pending-command.txt");
    let executionToken: string | null = null;
    let boundaryToken: string | null = null;
    let boundaryMode: string | null = null;
    let publicationToken: string | null = null;
    let publicationMode: string | null = null;
    let commandStarted = false;
    const priorCheckpoint = workflowInput.dependencies.afterCheckpoint;
    workflowInput.dependencies.afterCheckpoint = async (checkpoint) => {
      await priorCheckpoint?.(checkpoint);
      if (checkpoint === "after_initial_runtime_authority_bind") {
        const lease = (await readManifestV2(setupResult.runDir)).execution_lease;
        executionToken = lease?.token ?? null;
        expect(lease?.mode).toBe("execution");
      }
      if (checkpoint === "after_replan_boundary_commit") {
        const lease = (await readManifestV2(setupResult.runDir)).execution_lease;
        boundaryToken = lease?.token ?? null;
        boundaryMode = lease?.mode ?? null;
        await expect(runCommand({
          command: process.execPath,
          args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'spawned')`],
          cwd: setupResult.root,
          timeoutMs: 10_000,
          onStarted: () => { commandStarted = true; },
        })).rejects.toThrow(/publication.*status|status.*publication/i);
      }
    };
    const recordStatus = github.upsertRunStatus.bind(github);
    github.upsertRunStatus = async (target, marker, body) => {
      const lease = (await readManifestV2(setupResult.runDir)).execution_lease;
      if (lease?.mode === "pending_publication") {
        publicationToken = lease.token;
        publicationMode = lease.mode;
      }
      await recordStatus(target, marker, body);
    };

    const result = await runPastGithubEffectBoundaries(workflowInput);

    expect(result.status, result.blocker).toBe("human_action_required");
    expect(result.manifest.pending_plan_approval?.proposed_revision, result.blocker).toBe(2);
    expect(boundaryMode).toBe("pending_publication");
    expect(publicationMode).toBe("pending_publication");
    expect(executionToken).not.toBeNull();
    expect(boundaryToken).toBe(executionToken);
    expect(publicationToken).toBe(executionToken);
    expect(commandStarted).toBe(false);
    expect(await readFile(markerPath, "utf8").catch(() => null)).toBeNull();
    expect((await readManifestV2(setupResult.runDir)).execution_lease).toBeNull();
  }, 120_000);

  it.each(["noop", "invalid"] as const)("blocks a %s post-PR replan without exposing approval", async (candidateKind) => {
    const setupResult = await setup(true, false, true); root = setupResult.root;
    const github = new RecordingGithub();
    const { state, workflowInput } = await approvalPolicyPostPrHarness(
      setupResult,
      github,
      null,
      false,
      true,
      1,
      candidateKind,
    );

    const result = await runPastGithubEffectBoundaries(workflowInput);

    expect(result.status).toBe("human_action_required");
    expect(result.manifest.stage).toBe("replanning");
    expect(result.manifest.delivery_state).toBe("blocked");
    expect(result.manifest.pending_plan_approval).toBeNull();
    expect(result.blocker).toBe(result.manifest.last_blocker);
    expect(result.blocker).toMatch(/^Replan preparation blocked: /);
    expect(state.brainCalls).toBe(1);
    expect(await readFile(join(setupResult.runDir, "approvals/plan/revision-3.json"), "utf8").catch(() => null)).toBeNull();
    expect(await readOperatorStatus(setupResult.runDir)).toMatchObject({
      operator_state: "operationally_blocked",
      approval_boundary: "Restore the failed runtime, permission, network, catalog, or test-infrastructure dependency, then resume.",
      blocker: result.blocker,
    });
    expect(github.statusUpserts.at(-1)?.body).toBe(
      `<!-- brain-hands-run-status:${result.manifest.run_id} -->\nLocal replan status requires attention.`,
    );
    expect(github.statusUpserts.at(-1)?.body).not.toContain(result.blocker!);
    if (candidateKind === "invalid") {
      const resumed = await runGithubWorkflow(workflowInput);
      expect(resumed.status).toBe("human_action_required");
      expect(resumed.manifest.stage).toBe("replanning");
      expect(resumed.blocker).toMatch(/Ambiguous create_replan effect has no persisted immutable patch/);
      expect(resumed.blocker).not.toMatch(/GitHub runtime requires .* stage/);
      expect(resumed.blocker).not.toMatch(/replanning -> final_verification/);
    }
  }, 120_000);

  it("blocks a deleted post-PR replan source pointer without overwriting GitHub status", async () => {
    const setupResult = await setup(true, false, true); root = setupResult.root;
    const github = new RecordingGithub();
    const { workflowInput } = await approvalPolicyPostPrHarness(setupResult, github, null, false, true);
    expect((await runGithubWorkflow(workflowInput)).status).toBe("awaiting_github_effects");
    expect((await runGithubWorkflow(workflowInput)).status).toBe("awaiting_github_effects");
    const pending = await runPastGithubEffectBoundaries(workflowInput);
    expect(pending.manifest.stage).toBe("awaiting_plan_approval");
    const progress = { ...pending.manifest.work_item_progress.integrated };
    delete progress.replan_patch_path;
    await updateManifestV2(setupResult.runDir, {
      work_item_progress: { ...pending.manifest.work_item_progress, integrated: progress },
    });

    const statusCountBeforeBlockedResume = github.statusUpserts.length;
    const blocked = await runGithubWorkflow(workflowInput);
    expect(blocked.status).toBe("human_action_required");
    expect(blocked.blocker).toMatch(/source patch pointer.*missing|provenance/i);
    expect(github.statusUpserts).toHaveLength(statusCountBeforeBlockedResume);
  }, 120_000);

  it("policy-advances a post-PR finding with policy-only commit proof", async () => {
    const setupResult = await setup(true, false, true, true); root = setupResult.root;
    const github = new RecordingGithub();
    const { state, workflowInput } = await policyPostPrHarness(setupResult, github, null, true);

    expect((await runGithubWorkflow(workflowInput)).status).toBe("awaiting_github_effects");
    expect((await runGithubWorkflow(workflowInput)).status).toBe("awaiting_github_effects");
    const result = await runPastGithubEffectBoundaries(workflowInput);
    expect(result.status, result.blocker).toBe("github_ready");
    expect(state.lastCommitInput).toMatchObject({ verifierApproved: false });
    expect(state.lastCommitInput?.["policyProof"]).toBeTruthy();
    const manifest = await readManifestV2(setupResult.runDir);
    const cycle = reviewCycleStateSchema.parse(JSON.parse(await readFile(
      join(setupResult.runDir, manifest.work_item_progress.integrated!.review_cycle_path!), "utf8",
    )));
    expect(cycle.phase).toBe("post_pr");
    expect(cycle.decision.action).toBe("advance");
    const report = convergenceReportSchema.parse(JSON.parse(await readFile(
      join(setupResult.runDir, manifest.convergence_reports!.integrated!.path), "utf8",
    )));
    expect(report.authorization).toBeNull();
    expect(report.unresolved_finding_ids).toEqual(cycle.finding_ids);
    expect(github.statusUpserts.at(-1)?.target).toEqual({ kind: "issue", number: 17 });
    expect(github.statusUpserts.at(-1)?.body).toContain("Awaiting irreversible-action authority");
    expect("merge" in github).toBe(false);
  }, 120_000);

  it("fails closed when the remote resets behind the durable lease between read and push", async () => {
    const setupResult = await setup(true, false, true); root = setupResult.root;
    const github = new RecordingGithub();
    const { state, workflowInput, initialSha, postPrSha } = await policyPostPrHarness(setupResult, github, null);
    state.raceRemoteOnPush = true;

    expect((await runGithubWorkflow(workflowInput)).status).toBe("awaiting_github_effects");
    expect((await runGithubWorkflow(workflowInput)).status).toBe("awaiting_github_effects");
    const result = await runPastGithubEffectBoundaries(workflowInput);
    const progress = (await readManifestV2(setupResult.runDir)).work_item_progress.integrated;
    expect(result.status).toBe("human_action_required");
    expect(result.blocker).toMatch(/lease|remote branch changed/i);
    expect(state.remoteSha).toBe("0".repeat(40));
    expect(state.remoteSha).not.toBe(postPrSha);
    expect(state.leaseBeforeShas).toEqual([null, initialSha]);
    expect(progress?.push_pending).toBe(true);
    expect(progress?.push_expected_sha).toBe(postPrSha);
    const lineageId = (await readManifestV2(setupResult.runDir)).task_lineage_id!;
    expect((await readTaskLineage(setupResult.root, lineageId)).delivery.head_sha).toBe(postPrSha);
    expect("merge" in github).toBe(false);
  }, 180_000);

  it.each([
    ["divergent", "9".repeat(40)],
    ["deleted", null],
  ] as const)("fails closed before post-PR commit when the remote branch is %s", async (_label, remoteTip) => {
    const setupResult = await setup(true, false, true); root = setupResult.root;
    const github = new RecordingGithub();
    const { state, workflowInput } = await policyPostPrHarness(setupResult, github, null);
    state.postInitialRemoteSha = remoteTip;

    expect((await runGithubWorkflow(workflowInput)).status).toBe("awaiting_github_effects");
    expect((await runGithubWorkflow(workflowInput)).status).toBe("awaiting_github_effects");
    const result = await runPastGithubEffectBoundaries(workflowInput);
    const progress = (await readManifestV2(setupResult.runDir)).work_item_progress.integrated;
    expect(result.status).toBe("human_action_required");
    expect(result.blocker).toMatch(/remote pr branch/i);
    expect(state.commitIntentCalls).toBe(0);
    expect(state.commitCalls).toBe(0);
    expect(state.pushCalls).toBe(1);
    expect(state.remoteSha).toBe(remoteTip);
    expect(progress?.push_commit_pending).not.toBe(true);
    expect(progress?.push_expected_sha).toBeUndefined();
    expect(progress?.push_pending).not.toBe(true);
  }, 120_000);

  it("fails closed when a clean unrelated commit replaces a pending post-PR commit intent", async () => {
    const setupResult = await setup(true, false, true); root = setupResult.root;
    const github = new RecordingGithub();
    const { state, workflowInput, initialSha } = await policyPostPrHarness(setupResult, github, "intent");
    expect((await runGithubWorkflow(workflowInput)).status).toBe("awaiting_github_effects");
    expect((await runGithubWorkflow(workflowInput)).status).toBe("awaiting_github_effects");
    expect((await runGithubWorkflow(workflowInput)).status).toBe("human_action_required");
    expect(state.commitCalls).toBe(0);
    expect(state.pushCalls).toBe(1);
    const intentProgress = (await readManifestV2(setupResult.runDir)).work_item_progress.integrated;
    expect(intentProgress?.push_commit_review_cycle_path).toBe(intentProgress?.review_cycle_path);
    expect(intentProgress?.push_commit_review_effect_id).toBe(intentProgress?.review_effect_id);

    state.localSha = "3".repeat(40);
    state.localCommit = {
      sha: state.localSha,
      parent_shas: [initialSha],
      tree_sha: "5".repeat(40),
      message: "unrelated clean commit",
    };
    const result = await runPastGithubEffectBoundaries(workflowInput);
    const progress = (await readManifestV2(setupResult.runDir)).work_item_progress.integrated;
    expect(result.status).toBe("human_action_required");
    expect(result.blocker).toMatch(/commit provenance/i);
    expect(progress?.push_expected_sha).toBeUndefined();
    expect(progress?.push_pending).not.toBe(true);
    expect(state.commitCalls).toBe(0);
    expect(state.pushCalls).toBe(1);
  }, 120_000);

  it("persists the integrated commit SHA before the initial push boundary", async () => {
    const setupResult = await setup(); root = setupResult.root; const github = new RecordingGithub();
    let snapshots = 0;
    const committedSha = "a".repeat(40);
    let localHead = headSha(join(setupResult.root, "worktree"));
    const workflowInput: Parameters<typeof runGithubWorkflow>[0] = {
      runDir: setupResult.runDir,
      repoRoot: setupResult.root,
      worktreePath: join(setupResult.root, "worktree"),
      branchName: "codex/brain-hands/run-1",
      baseBranch: "main",
      intake: { ...intake, repo_root: setupResult.root },
      plan,
      codex: {} as never,
      dependencies: {
        github,
        hands: async (input) => ({ implementation: implementation(input.workItem.id), reportPath: "implementation/item.json", invocation: {} as never }),
        hasWorktreeChanges: async () => false,
        verification: async (input) => evidenceForInput(input),
        verifier: async (input) => ({ review: approvedReview(input.attempt ?? 1), reviewPath: await writeTextArtifact(setupResult.runDir, `reviews/integrated/final-attempt-${input.attempt ?? 1}.json`, `${JSON.stringify(approvedReview(input.attempt ?? 1))}\n`), invocation: {} as never }),
        gitSnapshot: async () => ({ branch: "codex/brain-hands/run-1", status: snapshots++ === 0 ? " M src/feature.ts\n" : "", gitDir: ".git", gitCommonDir: ".git", isLinkedWorktree: true }),
        commit: async () => { localHead = committedSha; return committedSha; },
        localHeadSha: async () => localHead,
        remoteBranchSha: async () => null,
        pushCommit: async () => { throw new Error("initial push failed"); },
      },
    };
    expect((await runGithubWorkflow(workflowInput)).status).toBe("awaiting_github_effects");
    expect((await runGithubWorkflow(workflowInput)).status).toBe("awaiting_github_effects");
    const result = await runPastGithubEffectBoundaries(workflowInput);
    expect(result.status).toBe("human_action_required");
    const manifest = await readManifestV2(setupResult.runDir);
    expect(manifest.work_item_progress.integrated?.commit_sha).toBe(committedSha);
    expect(manifest.pull_request_numbers).toEqual([]);
  });

  it("persists a post-PR fix commit before push and resumes a pending push", async () => {
    const setupResult = await setup(true, false, true); root = setupResult.root;
    const github = new RecordingGithub();
    const { state, workflowInput, postPrSha } = await policyPostPrHarness(setupResult, github, "push", true);
    workflowInput.config!.retry_policy.max_hands_fix_attempts = 2;
    expect((await runGithubWorkflow(workflowInput)).status).toBe("awaiting_github_effects");
    expect((await runGithubWorkflow(workflowInput)).status).toBe("awaiting_github_effects");
    const first = await runGithubWorkflow(workflowInput);
    expect(first.status).toBe("human_action_required");
    let manifest = await readManifestV2(setupResult.runDir);
    expect(manifest.work_item_progress.integrated?.commit_sha).toBe(postPrSha);
    expect(manifest.work_item_progress.integrated?.push_pending).toBe(true);

    const second = await runGithubWorkflow(workflowInput);
    expect(second.status, second.blocker).toBe("github_ready");
    manifest = await readManifestV2(setupResult.runDir);
    expect(manifest.work_item_progress.integrated?.commit_sha).toBe(postPrSha);
    expect(manifest.work_item_progress.integrated?.push_pending).toBe(false);
    expect(manifest.last_blocker).toBeNull();
    expect(state.pushedCommitShas).toHaveLength(2);
  }, 180_000);

  it("persists and recovers the real pull request URL", async () => {
    const setupResult = await setup(); root = setupResult.root; const github = new RecordingGithub();
    const url = "https://github.com/acme/repo/pull/42";
    github.openIntegratedPullRequest = async (input) => {
      github.prs.push(input);
      const closing = expectedClosingIssueNumbers(input);
      github.pullRequest = {
        number: 42,
        url,
        title: input.title,
        head_ref: input.head,
        head_sha: input.headSha,
        base_ref: input.base,
        body: reconcileClosingLinksBlock(input.summary, input.lineageId, input.runId, closing),
        closing_issue_numbers: closing,
        state: "OPEN",
      };
      return github.pullRequest;
    };
    const run = { runDir: setupResult.runDir, repoRoot: setupResult.root, worktreePath: join(setupResult.root, "worktree"), branchName: "codex/brain-hands/run-1", baseBranch: "main", intake: { ...intake, repo_root: setupResult.root }, plan, codex: {} as never };
    const deps = { github, hands: async (input: any) => ({ implementation: implementation(input.workItem.id), reportPath: "implementation/item.json", invocation: {} as never }), verification: async (input: any) => evidenceForInput(input), verifier: async (input: any) => { const attempt = input.attempt ?? 1; const review = approvedReview(attempt); return { review, reviewPath: await writeTextArtifact(setupResult.runDir, `reviews/integrated/final-attempt-${attempt}.json`, `${JSON.stringify(review)}\n`), invocation: {} as never }; }, gitSnapshot: async () => ({ branch: "codex/brain-hands/run-1", status: "", gitDir: ".git", gitCommonDir: ".git", isLinkedWorktree: true }), push: async () => "pushed", commit: async () => "sha" };
    const first = await runPastGithubEffectBoundaries({ ...run, dependencies: deps });
    expect(first.pullRequest?.url).toBe(url);
    const manifest = await readManifestV2(setupResult.runDir); expect(manifest.github_ids.pull_request_urls["42"]).toBe(url);
    github.findPullRequestByHead = async () => ({ number: 42, url, head_ref: run.branchName, head_sha: headSha(run.worktreePath), state: "OPEN" });
    expect((await runPastGithubEffectBoundaries({ ...run, dependencies: deps })).pullRequest?.url).toBe(url);
  });

  it.each([
    { label: "invalid number", reference: { number: 0, url: "https://github.com/acme/repo/pull/42" }, message: "invalid pull request number" },
    { label: "non-HTTPS URL", reference: { number: 42, url: "http://github.com/acme/repo/pull/42" }, message: "not a real HTTPS URL" },
    { label: "number-only response", reference: 42, message: "without a verified URL" },
  ])("fails closed when the adapter returns a $label", async ({ reference, message }) => {
    const setupResult = await setup(); root = setupResult.root; const github = new RecordingGithub();
    github.openIntegratedPullRequest = async () => reference as GitHubPullRequestReference;
    const result = await runPastGithubEffectBoundaries({
      runDir: setupResult.runDir,
      repoRoot: setupResult.root,
      worktreePath: join(setupResult.root, "worktree"),
      branchName: "codex/brain-hands/run-1",
      baseBranch: "main",
      intake: { ...intake, repo_root: setupResult.root },
      plan,
      codex: {} as never,
      dependencies: {
        github,
        hands: async (input) => ({ implementation: implementation(input.workItem.id), reportPath: "implementation/item.json", invocation: {} as never }),
        verification: async (input) => evidenceForInput(input),
        verifier: async (input) => ({ review: approvedReview(input.attempt ?? 1), reviewPath: await writeTextArtifact(setupResult.runDir, `reviews/integrated/final-attempt-${input.attempt ?? 1}.json`, `${JSON.stringify(approvedReview(input.attempt ?? 1))}\n`), invocation: {} as never }),
        gitSnapshot: async () => ({ branch: "codex/brain-hands/run-1", status: "", gitDir: ".git", gitCommonDir: ".git", isLinkedWorktree: true }),
        push: async () => "pushed",
      },
    });
    expect(result.status).toBe("human_action_required");
    expect(result.blocker).toContain(message);
  });

  it.each([
    { label: "a mismatched number", reference: { number: 43, url: "https://github.com/acme/repo/pull/43" }, message: "does not match persisted pull request #42" },
    { label: "an invalid URL", reference: { number: 42, url: "http://github.com/acme/repo/pull/42" }, message: "not a real HTTPS URL" },
    { label: "a different URL", reference: { number: 42, url: "https://github.com/acme/other/pull/42" }, message: "URL does not match persisted pull request #42" },
  ])("fails closed on legacy fast resume with $label before trusting unbound PR metadata", async ({ reference }) => {
    const setupResult = await setup(); root = setupResult.root; const github = new RecordingGithub();
    await seedOwnedIssue(github, setupResult.runDir);
    github.findPullRequestByHead = async () => reference;
    await updateManifestV2(setupResult.runDir, {
      stage: "delivery",
      pull_request_numbers: [42],
      work_item_issue_map: { feature: 17 },
      github_ids: { issue_numbers: [17], work_item_issue_map: { feature: 17 }, pull_request_numbers: [42], pull_request_urls: { "42": "https://github.com/acme/repo/pull/42" } },
    });
    const result = await runGithubWorkflow({
      runDir: setupResult.runDir,
      repoRoot: setupResult.root,
      worktreePath: join(setupResult.root, "worktree"),
      branchName: "codex/brain-hands/run-1",
      intake: { ...intake, repo_root: setupResult.root },
      plan,
      codex: {} as never,
      dependencies: { github, hands: async () => { throw new Error("must not run"); } },
    });
    expect(result.status).toBe("human_action_required");
    expect(result.blocker).toMatch(/authoritative ready issue set and applied lineage delivery|ownership observation/i);
  });

  it("rejects a legacy pending delivery state without applied lineage authority", async () => {
    const setupResult = await setup(); root = setupResult.root; const github = new RecordingGithub();
    const url = "https://github.com/acme/repo/pull/42";
    await seedOwnedIssue(github, setupResult.runDir);
    const currentHead = headSha(join(setupResult.root, "worktree"));
    github.pullRequest = {
      number: 42,
      url,
      head_ref: "codex/brain-hands/run-1",
      head_sha: currentHead,
      base_ref: "main",
      body: "Legacy summary",
      closing_issue_numbers: [],
      state: "OPEN",
    };
    github.findPullRequestByHead = async () => github.pullRequest;
    await updateManifestV2(setupResult.runDir, {
      stage: "delivery",
      delivery_state: "pending",
      pull_request_numbers: [42],
      work_item_issue_map: { feature: 17 },
      github_ids: { issue_numbers: [17], work_item_issue_map: { feature: 17 }, pull_request_numbers: [42], pull_request_urls: { "42": url } },
      work_item_progress: { integrated: { status: "complete", attempts: 1, commit_sha: currentHead } },
    });

    const result = await runGithubWorkflow({
      runDir: setupResult.runDir,
      repoRoot: setupResult.root,
      worktreePath: join(setupResult.root, "worktree"),
      branchName: "codex/brain-hands/run-1",
      intake: { ...intake, repo_root: setupResult.root },
      plan,
      codex: {} as never,
      dependencies: { github, hands: async () => { throw new Error("must not run"); } },
    });

    expect(result.status).toBe("human_action_required");
    expect(result.blocker).toMatch(/authoritative ready issue set and applied lineage delivery|ownership observation/i);
    expect((await readManifestV2(setupResult.runDir)).delivery_state).toBe("blocked");
    expect(github.pullRequest?.body).toBe("Legacy summary");
    expect(github.pullRequest?.closing_issue_numbers).toEqual([]);
  });

  it.each([
    { resumeStage: "final_verification" as const, persistedFix: false, pendingBoundary: false },
    { resumeStage: "verifier_review" as const, persistedFix: false, pendingBoundary: false },
    { resumeStage: "fixing" as const, persistedFix: true, pendingBoundary: false },
    { resumeStage: "fixing" as const, persistedFix: false, pendingBoundary: false },
    { resumeStage: "verifier_review" as const, persistedFix: false, pendingBoundary: true },
  ])(
    "rejects legacy post-PR delivery from $resumeStage ($persistedFix persisted fix) without applied lineage authority",
    async ({ resumeStage, persistedFix, pendingBoundary = false }) => {
      const setupResult = await setup(); root = setupResult.root;
      const github = new RecordingGithub();
      await seedOwnedIssue(github, setupResult.runDir);
      const seededManifest = await readManifestV2(setupResult.runDir);
      github.pullRequest = {
        number: 42,
        url: "https://github.com/acme/repo/pull/42",
        head_ref: "codex/brain-hands/run-1",
        head_sha: headSha(join(setupResult.root, "worktree")),
        base_ref: "main",
        body: reconcileClosingLinksBlock("Summary", seededManifest.run_id, [17]),
        closing_issue_numbers: [17],
        state: "OPEN",
      };
      const calls: string[] = [];
      const postEvidencePath = pendingBoundary
        ? "verification/integrated/attempt-1/evidence.json"
        : "verification/integrated/attempt-2/evidence.json";
      const postReviewPath = "reviews/integrated/final-attempt-2.json";
      const fixPath = "implementation/integrated/attempt-3.json";
      const preReview = approvedReview(1);
      const postReview = resumeStage === "fixing"
        ? { ...approvedReview(2), decision: "request_changes" as const, findings: [{ severity: "medium" as const, file: "src/feature.ts", line: null, acceptance_criterion: "feature works", problem: "missing", required_fix: "fix", re_verification: [] }] }
        : approvedReview(2);
      await writeTextArtifact(setupResult.runDir, "implementation/feature/attempt-1.json", JSON.stringify(implementation("feature")) + "\n");
      await writeTextArtifact(setupResult.runDir, "reviews/integrated/final-attempt-1.json", JSON.stringify(preReview) + "\n");
      await evidenceForInput({
        runDir: setupResult.runDir,
        identity: { scope: "integrated", work_item_id: "integrated" },
        attempt: pendingBoundary ? 1 : 2,
      });
      if (resumeStage !== "final_verification" && !pendingBoundary) {
        await writeTextArtifact(setupResult.runDir, postReviewPath, JSON.stringify(postReview) + "\n");
      }
      if (resumeStage === "fixing" && persistedFix) {
        await writeTextArtifact(
          setupResult.runDir,
          fixPath,
          JSON.stringify({ ...implementation("integrated"), changed_files: ["src/feature.ts"] }) + "\n",
        );
      }

      await transitionRun(setupResult.runDir, "worktree_setup", { actor: "test" });
      await updateManifestV2(setupResult.runDir, {
        current_work_item_id: "integrated",
        issue_numbers: [17],
        pull_request_numbers: [42],
        work_item_issue_map: { feature: 17 },
        github_ids: { issue_numbers: [17], work_item_issue_map: { feature: 17 }, pull_request_numbers: [42], pull_request_urls: { "42": "https://github.com/acme/repo/pull/42" } },
        work_item_progress: {
          feature: { status: "complete", attempts: 1, implementation_path: "implementation/feature/attempt-1.json" },
          integrated: {
            status: "in_progress",
            attempts: pendingBoundary ? 2 : (resumeStage === "fixing" && persistedFix ? 3 : 2),
            implementation_path: resumeStage === "fixing" && persistedFix ? fixPath : "implementation/integrated/attempt-1.json",
            verification_path: pendingBoundary || (resumeStage === "fixing" && persistedFix) ? undefined : postEvidencePath,
            review_path: resumeStage === "final_verification" || pendingBoundary ? "reviews/integrated/final-attempt-1.json" : postReviewPath,
            delivery_phase: "post_pr",
            integrated_pr: 42,
          },
        },
        final_artifact_paths: [postEvidencePath, ...(resumeStage === "verifier_review" && !pendingBoundary ? [postReviewPath] : []), ...(pendingBoundary ? ["reviews/integrated/final-attempt-1.json"] : [])],
      });
      await transitionRun(setupResult.runDir, "implementing", { actor: "test", payload: { work_item_id: "feature" } });
      await transitionRun(setupResult.runDir, "verifying", { actor: "test", payload: { work_item_id: "feature", pass: 1 } });
      await transitionRun(setupResult.runDir, "verifier_review", { actor: "test", payload: { work_item_id: "feature", pass: 1 } });
      if (!pendingBoundary) await transitionRun(setupResult.runDir, "final_verification", { actor: "runtime", payload: { work_item_id: "integrated", final: true, pass: 2, integrated_pr: 42 } });
      if (resumeStage !== "final_verification" && !pendingBoundary) {
        await transitionRun(setupResult.runDir, "verifier_review", { actor: "runtime", payload: { work_item_id: "integrated", final: true, pass: 2, integrated_pr: 42 } });
      }
      if (resumeStage === "fixing") {
        await transitionRun(setupResult.runDir, "fixing", { actor: "runtime", payload: { work_item_id: "integrated", final: true, pass: 2, integrated_pr: 42, findings: [] } });
      }
      if (pendingBoundary) {
        await appendRunEvent(setupResult.runDir, { actor: "runtime", stage: "verifier_review", type: "pull_request_pending", payload: { pull_request_number: 42, pull_request_url: "https://github.com/acme/repo/pull/42", head: "codex/brain-hands/run-1" } });
      }
      const result = await runGithubWorkflow({
        runDir: setupResult.runDir,
        repoRoot: setupResult.root,
        worktreePath: join(setupResult.root, "worktree"),
        branchName: "codex/brain-hands/run-1",
        baseBranch: "main",
        intake: { ...intake, repo_root: setupResult.root },
        plan,
        codex: {} as never,
        dependencies: {
          github,
          hands: async (input) => {
            calls.push("hands");
            if (persistedFix) throw new Error("persisted post-PR fix should be reused");
            const result = input.workItem.id === "integrated"
              ? { ...implementation("integrated"), changed_files: ["src/feature.ts"] }
              : implementation(input.workItem.id);
            return { implementation: result, reportPath: fixPath, invocation: {} as never };
          },
          verification: async (input) => { calls.push(`verify:${input.attempt}`); return evidenceForInput(input); },
          verifier: async (input) => {
            calls.push(`verifier:${input.attempt}`);
            const review = input.attempt && input.attempt >= 3 ? approvedReview(input.attempt) : { ...postReview, attempt: input.attempt ?? 2 };
            return { review, reviewPath: await writeTextArtifact(setupResult.runDir, `reviews/integrated/final-attempt-${input.attempt ?? 2}.json`, JSON.stringify(review) + "\n"), invocation: {} as never };
          },
          gitSnapshot: async () => ({ branch: "codex/brain-hands/run-1", status: "", gitDir: ".git", gitCommonDir: ".git", isLinkedWorktree: true }),
          push: async () => { calls.push("push"); return "pushed"; },
          commit: async () => { calls.push("commit"); return "sha"; },
        },
      });
      expect(result.status).toBe("human_action_required");
      expect(result.blocker).toMatch(/authoritative ready issue set and applied lineage delivery|ownership observation/i);
      expect(calls).toEqual([]);
      expect((await readManifestV2(setupResult.runDir)).delivery_state).toBe("blocked");
    },
  );

  it("fails closed when marker lookup is unavailable", async () => {
    const setupResult = await setup(); root = setupResult.root; const github = new RecordingGithub();
    (github as unknown as { findIssuesByMarker?: GitHubAdapter["findIssuesByMarker"] }).findIssuesByMarker = undefined;
    const result = await runPastGithubEffectBoundaries({ runDir: setupResult.runDir, repoRoot: setupResult.root, worktreePath: join(setupResult.root, "worktree"), branchName: "codex/brain-hands/run-1", intake: { ...intake, repo_root: setupResult.root }, plan, codex: {} as never, dependencies: { github, hands: async () => { throw new Error("must not run"); } } });
    expect(result.status).toBe("human_action_required"); expect(result.blocker).toContain("all-match issue observation");
  });

  it("rejects a legacy persisted PR before attempting URL recovery without applied lineage authority", async () => {
    const setupResult = await setup(); root = setupResult.root; const github = new RecordingGithub();
    await seedOwnedIssue(github, setupResult.runDir);
    await updateManifestV2(setupResult.runDir, {
      stage: "delivery",
      pull_request_numbers: [42],
      work_item_issue_map: { feature: 17 },
      github_ids: { issue_numbers: [17], work_item_issue_map: { feature: 17 }, pull_request_numbers: [42], pull_request_urls: {} },
    });
    const result = await runPastGithubEffectBoundaries({
      runDir: setupResult.runDir,
      repoRoot: setupResult.root,
      worktreePath: join(setupResult.root, "worktree"),
      branchName: "codex/brain-hands/run-1",
      intake: { ...intake, repo_root: setupResult.root },
      plan,
      codex: {} as never,
      dependencies: { github, hands: async () => { throw new Error("must not run"); } },
    });
    expect(result.status).toBe("human_action_required");
    expect(result.blocker).toMatch(/persisted legacy mapping|authoritative ready issue set/i);
  });

  it("preserves canonical work-item dependency ids in topological issue order", async () => {
    const setupResult = await setup(); root = setupResult.root; const github = new RecordingGithub(); let nextIssue = 100;
    github.createIssue = async (issue: any, marker?: GitHubIssueMarker, title?: string) => {
      github.created.push({ marker, title }); github.issueBodies.push(issue); const number = ++nextIssue;
      github.issues.set(number, { number, title: title ?? issue.title, body: formatIssueBody(issue, marker), state: "OPEN", state_reason: null });
      return number;
    };
    const first = item("first"); const second = { ...item("second"), dependencies: ["first"] };
    const orderedPlan = { ...plan, work_items: [second, first] };
    const result = await runPastGithubEffectBoundaries({ runDir: setupResult.runDir, repoRoot: setupResult.root, worktreePath: join(setupResult.root, "worktree"), branchName: "codex/brain-hands/run-1", intake: { ...intake, repo_root: setupResult.root }, plan: orderedPlan, codex: {} as never, dependencies: { github, hands: async () => { throw new Error("stop after sync"); } } });
    expect(result.status).toBe("human_action_required"); expect(github.issueBodies[1]?.dependencies).toEqual(["first"]);
  });

  it("fails closed instead of creating from an ambiguous positional legacy mapping", async () => {
    const setupResult = await setup(); root = setupResult.root;
    await updateManifestV2(setupResult.runDir, {
      stage: "github_issue_sync",
      issue_numbers: [17],
      github_ids: { issue_numbers: [17], parent_issue_number: null, pull_request_numbers: [], pull_request_urls: {} },
    });
    const github = new RecordingGithub();
    const runId = (await readManifestV2(setupResult.runDir)).run_id;
    github.issues.set(17, {
      number: 17,
      title: "[ship-feature:1:feature] Implement feature",
      body: formatIssueBody(plan.work_items[0]!, { runId, workItemId: "feature" }),
      state: "OPEN",
      state_reason: null,
    });
    github.findIssueByMarker = async (marker) => marker.workItemId === "feature" ? github.issues.get(17)! : null;
    github.createIssue = async (issue, marker, title) => {
      github.issueBodies.push(issue); github.created.push({ marker, title });
      github.issues.set(18, { number: 18, title: title ?? issue.title, body: formatIssueBody(issue, marker), state: "OPEN", state_reason: null });
      return 18;
    };
    const expandedPlan = { ...plan, work_items: [item("new-item"), item("feature")] };
    const result = await runGithubWorkflow({
      runDir: setupResult.runDir, repoRoot: setupResult.root, worktreePath: join(setupResult.root, "worktree"),
      branchName: "codex/brain-hands/run-1", intake: { ...intake, repo_root: setupResult.root }, plan: expandedPlan, codex: {} as never,
      dependencies: { github, hands: async () => { throw new Error("stop after sync"); } },
    });
    expect(result.status).toBe("human_action_required");
    expect(github.created).toEqual([]);
    expect(result.blocker).toMatch(/persisted legacy mapping|ownership observation/i);
    expect((await readManifestV2(setupResult.runDir)).github_ids.issue_numbers).toEqual([17]);
  });

  it("fails closed when a revised plan would detach a persisted work-item issue", async () => {
    const setupResult = await setup(); root = setupResult.root;
    await updateManifestV2(setupResult.runDir, {
      stage: "github_issue_sync",
      issue_numbers: [17, 18],
      github_ids: { issue_numbers: [17, 18], parent_issue_number: null, pull_request_numbers: [], pull_request_urls: {} },
    });
    const github = new RecordingGithub();
    await seedReconciledIssue(github, setupResult.runDir, plan.work_items[0]!);
    github.findIssueByMarker = async (marker) => marker.workItemId === "feature" ? github.issues.get(17)! : null;
    const result = await runGithubWorkflow({
      runDir: setupResult.runDir, repoRoot: setupResult.root, worktreePath: join(setupResult.root, "worktree"),
      branchName: "codex/brain-hands/run-1", intake: { ...intake, repo_root: setupResult.root }, plan, codex: {} as never,
      dependencies: { github, hands: async () => { throw new Error("must not run"); } },
    });
    expect(result.status).toBe("human_action_required");
    expect(result.blocker).toMatch(/targets absent from the approved plan|cannot detach persisted issue #18/i);
    expect((await readManifestV2(setupResult.runDir)).github_ids.issue_numbers).toEqual([17, 18]);
  });
});
