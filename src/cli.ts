#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { access, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { Command } from "commander";
import type { CodexAdapter } from "./adapters/codex.js";
import { DryRunCodexAdapter, SubprocessCodexAdapter } from "./adapters/codex.js";
import {
  DryRunGitHubAdapter,
  GhCliGitHubAdapter,
  ISSUE_LABELS,
  PARENT_ISSUE_LABELS,
  formatIssueBody,
  formatParentIssueBody,
  type GitHubIssueObservation,
  type GitHubPullRequestReference,
  type ParentIssueSpec,
} from "./adapters/github.js";
import { assertCleanSourceCheckout, createRunWorktree, verifyRunWorktreeIdentity } from "./adapters/git.js";
import { defaultConfig, loadConfig } from "./core/config.js";
import { resolveRunIntake } from "./core/intake.js";
import {
  appendRunEvent,
  approvePlanRevision,
  readManifestV2,
  reconcileClaimedInitialPlanBoundary,
  recordTerminalDispositionWithCleanup,
  createRunLedgerV2,
  ensureCompletedPlanApprovalEvent,
  requiresPinnedRuntimeAuthority,
  setRunCheckoutIdentity,
  markRunCheckoutReady,
  transitionRun,
  updateManifestV2,
  withRunLedgerCompoundTransaction,
  withRunLedgerTransaction,
  writeTextArtifact,
} from "./core/ledger.js";
import { readTaskLineage, withTaskLineageTransaction } from "./core/task-lineage.js";
import { abandonmentArtifactSchema, diagnosticRecoveryAuthorizationV1Schema, issueSpecSchema, strictVerifierReviewSchema } from "./core/schema.js";
import { runWithCheckoutAllocationAuthority } from "./core/execution-context.js";
import { parseExecutionPlan } from "./core/execution-spec.js";
import type {
  BrainPlan,
  ConfigV2,
  DiscoveredBrainPlan,
  HandsSelfReviewReport,
  ImplementationResult,
  PlanApprovalRequestV1,
  RunMode,
  RunManifestV2,
  VerificationIdentity,
} from "./core/types.js";
import { readVerifiedPlanApprovalRequest } from "./core/plan-approval.js";
import { verificationIdentityDirectory } from "./core/types.js";
import { verifyBrowserIssue } from "./browser/verifier.js";
import { runReflection, planFromReflection } from "./workflow/reflection.js";
import { createReviewPackage } from "./workflow/review-package.js";
import { importIssues } from "./workflow/issue-import.js";
import { runPreflight } from "./workflow/preflight.js";
import { initializeRepository } from "./workflow/repository-init.js";
import { planRunV2 } from "./workflow/planner.js";
import { checkPlanCandidate } from "./workflow/plan-check.js";
import { loadVerifiedPlanBundle } from "./workflow/verified-plan.js";
import { acquireRunExecutionScope, loadApprovedRuntimeSnapshot, publishGithubWorkflowStatus, runWorkflow, withRunExecutionLease, type LocalWorkflowResult, type RunExecutionScope, type RunGithubWorkflowInput } from "./workflow/runtime.js";
import { formatRunStatusComment, readOperatorStatus, readRunLog, renderRunStatus, summarizeRun } from "./workflow/status.js";
import { finalAudit } from "./workflow/orchestrator.js";
import { packageVersion } from "./core/package-version.js";
import { readOperatorText } from "./core/operator-input.js";
import { assertNoSecretMaterial } from "./core/secret-detector.js";
import {
  approveDiscoveryBrief,
  readDiscoveryPendingAction,
  readVerifiedDiscoveryBrief,
  recordDiscoveryAnswer,
  recordDiscoveryProceedIntent,
  rejectDiscoveryBrief,
  selectDiscoveryApproach,
} from "./core/discovery-ledger.js";
import { runDiscoveryTurn } from "./workflow/discovery.js";
import { openResourceBudget } from "./workflow/resource-budget.js";
import type { ResourceBudgetPort } from "./core/resource-budget.js";
import { assertCurrentControllerMatches, captureControllerProvenance, captureVisibleController } from "./core/controller-provenance.js";
import { currentExecutionAuthority } from "./core/execution-context.js";
import { resolveModelOverride } from "./core/openai-model-registry.js";
import {
  followProgressEvents,
  openProgressReporter,
  readProgressEvents,
  summarizeProgressActivity,
  type ProgressReporter,
} from "./progress/log.js";
import type { SafeProgressEvent } from "./progress/events.js";
import { createProgressViewReducer } from "./progress/view.js";
import {
  approvePreparedReplanRevision,
  continueApprovedReplanRevision,
  InvalidReplanCandidateError,
  NoMaterialReplanError,
  reconcilePendingReplanApprovalBoundary,
  resolvePendingReplanTarget,
  type PreparedReplanApprovalBoundary,
} from "./workflow/replan.js";
import { abandonRun, acceptFinalDeliveryRisk, assessFinalDelivery, assertNotAbandoned, persistFinalDeliveryAssessment, persistFinalDeliveryAssessmentAtBoundary } from "./workflow/assurance.js";
import { reconcileAmbiguousLineageIssueOperations, reconcileGitHubIssues, type IssueLifecycleReport } from "./github/issue-reconciliation.js";
import { expectedClosingIssueNumbers, reconcileClosingLinksBlock } from "./github/issue-lifecycle.js";
import { formatParentIssueTitle, formatWorkItemIssueTitle, resolveFeatureSlug } from "./core/issue-naming.js";
import {
  RUN_CONFIGURATION_PATH,
  renderRunConfiguration,
  renderRunConfigurationPreview,
  resolvedRunConfigurationSchema,
  resolveRunConfigurationPreview,
} from "./core/run-configuration.js";
import { canonicalSessionEventSchema, materializeCanonicalSessionEvent, sessionStateSchema } from "./progress/session-events.js";
import { readOwnedRunFile } from "./core/owned-evidence.js";
import { runProducingCommand, type ProducingCommand } from "./progress/session-lifecycle.js";
import {
  configuredReleaseRehearsalScenario,
  releaseRehearsalDependencies,
  type ReleaseRehearsalScenario,
} from "./testing/release-rehearsal.js";
import {
  authorizeDiagnosticResume,
  claimAuthorizedRecoveryAttempt,
  reconcileRecoveryJournal,
} from "./workflow/recovery-ledger.js";
import { recordControllerRecovery } from "./workflow/controller-recovery.js";
import { advancePreparedRunToDiscovery, prepareFreshRun } from "./workflow/run-start.js";
import * as replacementWorkflow from "./workflow/replacement.js";
import { usesDurableDiscoveryProtocol } from "./core/run-state.js";

function slugifyTask(task: string): string {
  const slug = task
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug || "workflow-run";
}

function assertFollowOptions(options: Record<string, unknown>): void {
  if (options.json === true && options.follow === true) throw new Error("--json and --follow cannot be used together");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

type CliProgressReporter = ProgressReporter & { flushView?: () => Promise<void> };

async function flushProgressView(progress: ProgressReporter | null | undefined): Promise<void> {
  try {
    await (progress as CliProgressReporter | undefined)?.flushView?.();
  } catch {
    // Human progress rendering is observational and must not change command outcome.
  }
}

async function progressReporterForCommand(runDir: string, follow: boolean): Promise<CliProgressReporter> {
  let warned = false;
  const view = follow ? createProgressViewReducer({ emit: (row) => { console.error(row); } }) : null;
  const reporter = await openProgressReporter({
    runDir,
    onEvent: follow && view ? (event) => view.push(event) : undefined,
    onWarning: () => {
      if (!warned) console.error("Live progress is unavailable; workflow execution is continuing.");
      warned = true;
    },
  });
  return view ? Object.assign(reporter, { flushView: () => view.flush() }) : reporter;
}

function runCliProducingCommand<TResult>(input: {
  command: ProducingCommand;
  action: () => Promise<TResult>;
  runDir?: string | null | (() => string | null | undefined | Promise<string | null | undefined>);
  progress?: ProgressReporter | null | (() => ProgressReporter | null | undefined | Promise<ProgressReporter | null | undefined>);
  reconcile?: (manifest: RunManifestV2) => Promise<void>;
  reflect?: (manifest: RunManifestV2) => Promise<void>;
  assure?: (manifest: RunManifestV2) => Promise<void>;
  finalizeRequiresAuthority?: () => boolean | Promise<boolean>;
  beforeFinalize?: (result: TResult, outcome: "successful" | "blocked" | "failed") => Promise<void>;
}): Promise<TResult> {
  const commandInvocationId = randomUUID();
  const action = async () => {
    try {
      return await cliCommandInvocation.run(commandInvocationId, input.action);
    } catch (error) {
      const value = typeof input.runDir === "function" ? await input.runDir() : input.runDir;
      if (value) await releaseHeldExecutionScope(value, commandInvocationId);
      throw error;
    }
  };
  return runProducingCommand({
    ...input,
    action,
    finalizeWithAuthority: async (operation) => {
      if (input.finalizeRequiresAuthority && !await input.finalizeRequiresAuthority()) {
        const value = typeof input.runDir === "function" ? await input.runDir() : input.runDir;
        try {
          return await operation();
        } finally {
          if (value) await releaseHeldExecutionScope(value, commandInvocationId);
        }
      }
      const value = typeof input.runDir === "function" ? await input.runDir() : input.runDir;
      if (!value) return operation();
      const held = heldExecutionScopes.get(resolve(value));
      if (held?.commandInvocationId === commandInvocationId) {
        try {
          return await held.scope.run(operation);
        } catch (error) {
          if (!isLostExecutionLeaseError(error)) throw error;
        } finally {
          await releaseHeldExecutionScope(value, commandInvocationId);
        }
        return;
      }
      const manifest = await readManifestV2(value);
      const approved = manifest.terminal === null
        && manifest.current_revision !== null
        && manifest.current_revision === manifest.current_plan_revision
        && manifest.current_revision === manifest.approved_revision
        && manifest.current_revision === manifest.approved_plan_revision
        && manifest.pending_plan_approval === null;
      return approved ? withRunExecutionLease(value, operation) : operation();
    },
    onWarning: async (message) => { console.error(message); },
  }).finally(async () => {
    const progress = typeof input.progress === "function" ? await input.progress() : input.progress;
    await flushProgressView(progress);
  });
}

async function prepareDiagnosticResume(input: {
  runDir: string;
  actor?: string;
  recoveryNoteFile?: string;
}): Promise<RunManifestV2> {
  const manifest = await reconcileRecoveryJournal(input.runDir);
  const hasActor = input.actor !== undefined;
  const hasRecoveryNote = input.recoveryNoteFile !== undefined;
  const scopeId = manifest.recovery.active_scope;
  const scope = scopeId !== null
    && Object.prototype.hasOwnProperty.call(manifest.recovery.scopes, scopeId)
    ? manifest.recovery.scopes[scopeId]
    : undefined;
  const isDiagnosticStop = manifest.terminal === null
    && scope?.disposition === "diagnostic_stop";
  const isDiagnosticReplay = manifest.terminal === null
    && scope?.disposition === "active"
    && scope.authorization_path !== null;

  if (!hasActor && !hasRecoveryNote) {
    if (isDiagnosticStop) {
      throw new Error("Diagnostic resume requires both --actor and --recovery-note-file");
    }
    return manifest;
  }
  if (!isDiagnosticStop && !isDiagnosticReplay) {
    throw new Error("Diagnostic recovery options are accepted only at diagnostic stop or for its exact current authorization replay");
  }
  if (!hasActor || !hasRecoveryNote) {
    throw new Error("Diagnostic resume requires both --actor and --recovery-note-file");
  }

  const note = await readOperatorText(input.recoveryNoteFile);
  assertNoSecretMaterial("Recovery note", note);
  const authorization = isDiagnosticStop
    ? await authorizeDiagnosticResume({
        runDir: input.runDir,
        actor: input.actor!,
        note,
      })
    : diagnosticRecoveryAuthorizationV1Schema.parse(JSON.parse(
        (await readOwnedRunFile(input.runDir, scope!.authorization_path!)).toString("utf8"),
      ));
  if (isDiagnosticReplay && (
    authorization.run_id !== manifest.run_id
    || authorization.scope_id !== scopeId
    || authorization.journal_sequence !== scope!.head_sequence
    || authorization.decision_path !== scope!.head_decision_path
    || authorization.blocker_fingerprint !== scope!.blocker_fingerprint
    || authorization.progress_subject_sha256 !== scope!.progress_subject_sha256
    || authorization.actor !== input.actor
    || authorization.note !== note
  )) {
    throw new Error("Diagnostic recovery replay does not match the exact current authorization");
  }
  await claimAuthorizedRecoveryAttempt({
    runDir: input.runDir,
    authorization,
  });
  return readManifestV2(input.runDir);
}

const cliCommandInvocation = new AsyncLocalStorage<string>();
const heldExecutionScopes = new Map<string, { commandInvocationId: string; scope: RunExecutionScope }>();

async function releaseHeldExecutionScope(runDir: string, commandInvocationId: string): Promise<void> {
  const key = resolve(runDir);
  const held = heldExecutionScopes.get(key);
  if (!held || held.commandInvocationId !== commandInvocationId) return;
  heldExecutionScopes.delete(key);
  try {
    await held.scope.release();
  } catch (error) {
    if (!isLostExecutionLeaseError(error)) {
      throw error;
    }
  }
}

function isLostExecutionLeaseError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Execution lease token does not match the active run owner|Execution lease epoch or invocation does not match|No active execution lease/.test(message);
}

async function reflectTerminalRun(
  runDir: string,
  manifest: RunManifestV2,
  options: { repo?: string; dryRun?: boolean; progress?: ProgressReporter | null },
): Promise<void> {
  const intakeRaw = JSON.parse(await readFile(join(runDir, manifest.intake_path), "utf8")) as Parameters<typeof resolveRunIntake>[0];
  if (intakeRaw.reflection !== true) return;
  const repoRoot = resolve(options.repo ?? manifest.repo_root);
  let config = await loadConfigOrDefault(repoRoot, options.dryRun === true);
  const approved = manifest.terminal === null
    ? await loadApprovedRuntimeSnapshot(runDir, config)
    : null;
  const intake = approved?.intake ?? resolveRunIntake({ ...intakeRaw, repo_root: repoRoot }, config);
  if (approved) config = approved.config;
  const worktreePath = approved?.manifest.worktree_path ?? manifest.worktree_path ?? undefined;
  const rehearsalScenario = configuredReleaseRehearsalScenario({
    dryRun: options.dryRun === true,
    mode: intake.mode,
  });
  const codex = options.dryRun === true
    ? createDryRunLifecycleCodex(intake.mode, rehearsalScenario)
    : new SubprocessCodexAdapter(config as never, worktreePath ?? repoRoot);
  let current = await readManifestV2(runDir);
  const budget = await openCliResourceBudget(runDir, current);
  await runReflection({
    runDir,
    sourceRepo: repoRoot,
    worktreePath: worktreePath ?? current.worktree_path ?? undefined,
    intake,
    codex,
    budget,
    // Reflection runs after the first immutable terminal timestamp. Its
    // progress remains an observational log and must not advance the
    // canonical aggregate past that frozen provenance.
    progress: undefined,
  });
  current = await readManifestV2(runDir);
  if (current.terminal?.outcome === "delivered" && current.stage === "delivery") {
    try {
      current = await transitionRun(runDir, "reflecting", { actor: "cli", payload: { reflection_pending: true } });
      await transitionRun(runDir, "complete", { actor: "cli", payload: { reflection_pending: true } });
    } catch (error) {
      throw new Error(`Terminal reflection completion failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  } else if (current.terminal?.outcome === "delivered" && current.stage === "reflecting") {
    await transitionRun(runDir, "complete", { actor: "cli", payload: { reflection_pending: true } });
  }
}

async function openCliResourceBudget(
  runDir: string,
  manifest: RunManifestV2,
): Promise<ResourceBudgetPort | undefined> {
  return manifest.workflow_protocol === "bounded-context-v1" && manifest.resource_budget_policy !== undefined
    ? openResourceBudget(runDir)
    : undefined;
}

async function assureTerminalRun(runDir: string, manifest: RunManifestV2): Promise<void> {
  if (manifest.assurance_outcome !== null) return;
  if (manifest.terminal === null) return;
  if (manifest.terminal.outcome === "delivered") {
    const assessment = await persistFinalDeliveryAssessment(runDir);
    if (assessment.outcome !== "verified_ready" && assessment.outcome !== "human_accepted") {
      throw new Error(assessment.blocker ?? "Final-delivery assurance was not reached");
    }
    return;
  }
  const assurance = manifest.terminal.outcome === "human_accepted"
    ? "human_accepted"
    : manifest.terminal.outcome === "abandoned" ? "abandoned" : "blocked";
  await updateManifestV2(runDir, { assurance_outcome: assurance });
}

async function reserveReflectionArtifactsBeforeTerminal(runDir: string, manifest: RunManifestV2): Promise<void> {
  if (manifest.terminal !== null) return;
  const intake = JSON.parse(await readFile(join(runDir, manifest.intake_path), "utf8")) as { reflection?: unknown };
  if (intake.reflection !== true) return;
  const reflectionArtifacts = [
    "reflection.json",
    "reflection.md",
    "responses/reflection-brain-account.json",
    "responses/reflection-hands-account.json",
    "responses/reflection-synthesis.json",
  ];
  const finalArtifactPaths = [...new Set([...manifest.final_artifact_paths, ...reflectionArtifacts])];
  if (finalArtifactPaths.length !== manifest.final_artifact_paths.length) {
    await updateManifestV2(runDir, { final_artifact_paths: finalArtifactPaths });
  }
}

async function recordTerminalWithoutFinalization(
  runDir: string,
  input: {
    outcome: "delivered" | "human_accepted" | "abandoned" | "closed_blocked";
    actor: "runtime" | "human";
    reason: string;
    residualRisks: string[];
    assurance: "verified_ready" | "human_accepted" | "blocked" | "abandoned";
  },
): Promise<RunManifestV2> {
  let initial = await readManifestV2(runDir);
  if (initial.mode === "github") {
    if (initial.task_lineage_id === null) throw new Error("GitHub terminal disposition is missing its task lineage");
    if (initial.terminal !== null && initial.terminal.outcome !== input.outcome) {
      throw new Error(`Run already has terminal outcome ${initial.terminal.outcome}`);
    }
    const lineage = await readTaskLineage(initial.repo_root, initial.task_lineage_id);
    return recordTerminalDispositionWithCleanup({
      runDir,
      disposition: {
        outcome: input.outcome,
        actor: input.actor,
        reason: input.reason,
        residual_risks: input.residualRisks,
        recorded_at: initial.terminal?.recorded_at,
      },
      lineage,
    });
  }
  return withRunLedgerCompoundTransaction(runDir, async (transaction) => {
    let manifest = await transaction.readManifestV2();
    if (manifest.terminal !== null && manifest.terminal.outcome !== input.outcome) {
      throw new Error(`Run already has terminal outcome ${manifest.terminal.outcome}`);
    }
    const disposition = manifest.terminal ?? {
      outcome: input.outcome,
      actor: input.actor,
      reason: input.reason,
      residual_risks: input.residualRisks,
      recorded_at: new Date().toISOString(),
      source_stage: manifest.stage,
    };
    if (manifest.terminal === null) {
      if (manifest.assurance_outcome === null) {
        await transaction.updateManifestV2({ assurance_outcome: input.assurance });
      }
      manifest = await transaction.recordTerminalDisposition(disposition);
    }
    const events = (await readFile(join(runDir, "events.jsonl"), "utf8"))
      .split("\n").filter(Boolean).flatMap((line) => {
        try { return [JSON.parse(line) as { type?: unknown; actor?: unknown; payload?: Record<string, unknown> }]; } catch { return []; }
      });
    const alreadyRecorded = events.some((event) => event.type === "run_terminalized"
      && event.actor === disposition.actor
      && event.payload?.outcome === disposition.outcome
      && event.payload?.reason === disposition.reason
      && JSON.stringify(event.payload?.residual_risks) === JSON.stringify(disposition.residual_risks)
      && event.payload?.recorded_at === disposition.recorded_at
      && event.payload?.source_stage === disposition.source_stage);
    if (!alreadyRecorded) {
      await appendRunEvent(runDir, {
        actor: disposition.actor,
        stage: disposition.source_stage,
        type: "run_terminalized",
        timestamp: disposition.recorded_at,
        payload: {
          outcome: disposition.outcome,
          reason: disposition.reason,
          residual_risks: disposition.residual_risks,
          recorded_at: disposition.recorded_at,
          source_stage: disposition.source_stage,
        },
      });
    }
    return manifest;
  });
}

async function ensureAbandonedTerminal(runDir: string, actor: string, reason: string): Promise<RunManifestV2> {
  let manifest = await readManifestV2(runDir);
  if (manifest.terminal !== null && manifest.terminal.outcome !== "abandoned") {
    throw new Error(`Run already has terminal outcome ${manifest.terminal.outcome}`);
  }
  if (manifest.abandonment_path === null) {
    await abandonRun(runDir, actor, reason);
    manifest = await readManifestV2(runDir);
  }
  if (manifest.terminal === null) {
    if (manifest.abandonment_path === null) throw new Error("Abandonment artifact was not persisted");
    const artifact = abandonmentArtifactSchema.parse(JSON.parse(await readFile(join(runDir, manifest.abandonment_path), "utf8")));
    if (artifact.run_id !== manifest.run_id) throw new Error("Abandonment artifact belongs to a different run");
    return recordTerminalWithoutFinalization(runDir, {
      outcome: "abandoned",
      actor: "human",
      reason: artifact.reason,
      residualRisks: manifest.last_blocker ? [manifest.last_blocker] : [],
      assurance: "abandoned",
    });
  }
  return manifest;
}

async function readCanonicalSessionEvent(runDir: string): Promise<unknown | null> {
  try {
    const manifest = await readManifestV2(runDir);
    const [stateBytes, eventBytes] = await Promise.all([
      readOwnedRunFile(runDir, "session-state.json"),
      readOwnedRunFile(runDir, "session-events.jsonl"),
    ]);
    const state = sessionStateSchema.parse(JSON.parse(stateBytes.toString("utf8")));
    if (!state || !manifest.terminal || manifest.assurance_outcome === null
      || state.run_id !== manifest.run_id
      || state.terminal_outcome !== manifest.terminal.outcome
      || state.assurance_outcome !== manifest.assurance_outcome
      || state.terminal_provenance === null
      || state.terminal_provenance.actor !== manifest.terminal.actor
      || state.terminal_provenance.recorded_at !== manifest.terminal.recorded_at
      || state.terminal_provenance.source_stage !== manifest.terminal.source_stage) return null;
    const raw = eventBytes.toString("utf8");
    if (raw.length === 0 || !raw.endsWith("\n")) return null;
    const lines = raw.slice(0, -1).split("\n");
    if (lines.length !== 1 || lines[0]!.trim().length === 0) return null;
    const event = canonicalSessionEventSchema.parse(JSON.parse(lines[0]!));
    const expected = materializeCanonicalSessionEvent(state);
    return JSON.stringify(event) === JSON.stringify(expected) ? event : null;
  } catch {
    return null;
  }
}

async function reconcileAfterExplicitTerminalAction(runDir: string): Promise<void> {
  const manifest = await readManifestV2(runDir);
  if (manifest.mode !== "github") return;
  const dryRunDelivery = Object.values(manifest.github_ids.pull_request_urls)
    .some((url) => url.startsWith("https://github.com/dry-run/"));
  if (dryRunDelivery) return;
  try {
    const budget = await openCliResourceBudget(runDir, manifest);
    await reconcileGitHubIssues({
      runDir,
      manifest,
      github: new GhCliGitHubAdapter(resolve(manifest.repo_root)),
      apply: true,
      budget,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `The terminal outcome was recorded, but GitHub reconciliation did not complete. Retry with brain-hands reconcile-github --run ${runDir} --apply: ${message}`,
    );
  }
}

export async function readWorkflowDesign(repoRoot: string, fallbackRoot = process.cwd()): Promise<string> {
  const candidates = [join(resolve(repoRoot), "agentic-codex-workflow.md")];
  if (resolve(fallbackRoot) !== resolve(repoRoot)) candidates.push(join(resolve(fallbackRoot), "agentic-codex-workflow.md"));
  for (const candidate of candidates) {
    try {
      return await readFile(candidate, "utf8");
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    }
  }
  return "";
}

function parsePositiveInteger(value: string, flagName: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`${flagName} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${flagName} must be a positive integer`);
  return parsed;
}

function parseMode(value: string | undefined): "local" | "github" {
  if (value === "local" || value === "github") return value;
  throw new Error(`--mode must be either local or github`);
}

function parseBooleanChoice(value: unknown, name: string): boolean {
  if (typeof value === "boolean") return value;
  if (value === "true" || value === "false") return value === "true";
  throw new Error(`--${name} must be explicitly selected as true or false`);
}

function renderIssueLifecycleReport(report: IssueLifecycleReport): string {
  const lines = [
    `Run: ${report.run_id}`,
    `Mode: ${report.mode}`,
    `Default branch: ${report.default_branch}`,
  ];
  if (report.cleanup) {
    lines.push(
      `GitHub cleanup: ${report.cleanup.state}`,
      `GitHub cleanup targets: ${report.cleanup.target_numbers.map((number) => `#${number}=${report.cleanup!.target_states[String(number)]}`).join(", ")}`,
    );
  }
  if (report.pull_request) {
    lines.push(
      `Pull request: #${report.pull_request.number} (${report.pull_request.state}, base ${report.pull_request.base_branch})`,
      `Default-branch compatible: ${report.pull_request.default_branch_compatible ? "yes" : "no"}`,
      `Pull-request identity verified: ${report.pull_request.identity_verified ? "yes" : "no"}`,
      `Managed closing links verified: ${report.pull_request.managed_links_verified ? "yes" : "no"}`,
      `Closing links: ${report.pull_request.action}${report.pull_request.applied ? " (applied)" : ""}${report.pull_request.edit_skip_reason ? ` (${report.pull_request.edit_skip_reason.replaceAll("_", " ")})` : ""}`,
    );
    if (report.pull_request.missing_closing_issue_numbers.length > 0) {
      lines.push(`Missing closing references: ${report.pull_request.missing_closing_issue_numbers.map((number) => `#${number}`).join(", ")}`);
    }
    if (report.pull_request.proposed_body !== null) {
      lines.push("Proposed pull-request body:", report.pull_request.proposed_body);
    }
  } else {
    lines.push("Pull request: none");
  }
  lines.push("Issues:");
  for (const issue of report.issues) {
    const identity = issue.kind === "parent" ? "parent" : issue.kind === "unmapped" ? "unmapped" : issue.work_item_id ?? "work item";
    const reason = issue.reason ? ` (${issue.reason.replace("_", " ")})` : issue.skip_reason ? ` (${issue.skip_reason.replaceAll("_", " ")})` : "";
    lines.push(`- #${issue.number} ${identity}: ${issue.action}${reason}${issue.applied ? " [applied]" : ""}`);
  }
  return lines.join("\n");
}

function configV2(config: Awaited<ReturnType<typeof loadConfig>> | ConfigV2): ConfigV2 {
  return config as ConfigV2;
}

function runArtifactPath(runDir: string, requested: string, label: string): string {
  const root = resolve(runDir);
  const candidate = resolve(root, requested);
  if (candidate !== root && !candidate.startsWith(`${root}/`)) {
    throw new Error(`${label} must resolve inside the v2 run directory`);
  }
  return candidate;
}

async function loadConfigOrDefault(repoRoot: string, dryRun = false): Promise<ConfigV2> {
  try {
    return configV2(await loadConfig(repoRoot));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      if (dryRun) return configV2(defaultConfig());
      throw new Error(`Brain Hands is not initialized in ${repoRoot}.\nRun: brain-hands init --repo ${repoRoot}`);
    }
    throw error;
  }
}

async function requireV2Manifest(runDir: string, action: string): Promise<RunManifestV2> {
  try {
    return await readManifestV2(runDir);
  } catch (error) {
    let legacy = false;
    try {
      const raw = JSON.parse(await readFile(join(runDir, "manifest.json"), "utf8")) as Record<string, unknown>;
      legacy = raw.version !== 2 && raw.schema_version !== 2;
    } catch {
      // Preserve the original parse/read error below.
    }
    if (legacy) throw new Error(`${action} only supports v2 run ledgers; legacy ledger detected. Re-run with 'run' to migrate.`);
    throw error;
  }
}

function resolveMappedBrowserIdentity(manifest: RunManifestV2, issueNumber: number): VerificationIdentity {
  const issueMap = { ...manifest.work_item_issue_map, ...(manifest.github_ids.work_item_issue_map ?? {}) };
  const workItem = Object.entries(issueMap).find(([, mappedIssueNumber]) => mappedIssueNumber === issueNumber)?.[0];
  if (!workItem) {
    throw new Error(`No durable work-item mapping exists for GitHub issue #${issueNumber}`);
  }
  return { scope: "github", work_item_id: workItem, issue_number: issueNumber };
}

async function resolveLocalBrowserIdentity(manifest: RunManifestV2, runDir: string, workItemId: string): Promise<VerificationIdentity> {
  const plan = await loadPlan(runDir, manifest);
  if (!plan.work_items.some((item) => item.id === workItemId)) {
    throw new Error(`Work item ${workItemId} is not present in the approved v2 plan`);
  }
  return { scope: "local", work_item_id: workItemId };
}

function assertBrowserProgressIdentity(manifest: RunManifestV2, identity: VerificationIdentity): void {
  const progress = manifest.work_item_progress[identity.work_item_id];
  if (!progress) return;

  if (progress.verification_scope !== undefined && progress.verification_scope !== identity.scope) {
    throw new Error("Browser verification identity does not match persisted verification scope");
  }
  if (progress.verification_work_item_id !== undefined && progress.verification_work_item_id !== identity.work_item_id) {
    throw new Error("Browser verification identity does not match persisted work item");
  }
  if (identity.scope === "github" && progress.verification_issue_number !== undefined && progress.verification_issue_number !== identity.issue_number) {
    throw new Error("Browser verification issue number does not match the durable mapping");
  }
  if (identity.scope !== "github" && progress.verification_issue_number !== undefined) {
    throw new Error("Local and integrated browser verification cannot use a GitHub issue number");
  }
  if (progress.verification_path !== undefined) {
    const prefix = `${verificationIdentityDirectory(identity)}/attempt-`;
    if (typeof progress.verification_path !== "string"
      || !progress.verification_path.startsWith(prefix)
      || !/^\d+\/evidence\.json$/.test(progress.verification_path.slice(prefix.length))) {
      throw new Error("Browser verification path does not match the persisted verification identity");
    }
  }
}

async function resolveRunDirectory(raw: string, repoRoot?: string): Promise<string> {
  const direct = isAbsolute(raw) ? raw : resolve(raw);
  try {
    await access(join(direct, "manifest.json"));
    return direct;
  } catch {
    // Resolve a bare run id against the target repository's ledger directory.
  }
  const candidate = join(resolve(repoRoot ?? process.cwd()), ".brain-hands", "runs", raw);
  try {
    await access(join(candidate, "manifest.json"));
    return candidate;
  } catch {
    return direct;
  }
}

function assertApprovedRevision(manifest: RunManifestV2, revision?: number): number {
  const current = manifest.current_revision ?? manifest.current_plan_revision;
  const approved = manifest.approved_revision ?? manifest.approved_plan_revision;
  if (current === null || current === undefined) throw new Error("Run requires explicit approval but has no recorded plan revision.");
  if (revision !== undefined && revision !== current) throw new Error(`Plan revision ${revision} is not the current revision ${current}`);
  if (approved !== current) throw new Error(`Run requires explicit approval for plan revision ${current}; use approve-plan --revision ${current}`);
  return current;
}

function recordedApprovalPointer(manifest: RunManifestV2, revision: number) {
  const record = manifest.plan_revisions[String(revision)];
  if (!record) throw new Error(`Plan revision ${revision} is not recorded`);
  const metadata = [
    record.origin,
    record.base_revision,
    record.approval_request_path,
    record.approval_request_sha256,
    record.approval_subject_sha256,
    record.decision_contract_sha256,
  ];
  if (metadata.every((value) => value === undefined)) {
    if (manifest.approval_protocol_version === 1) {
      throw new Error("Pinned run plan approval metadata is missing");
    }
    return null;
  }
  if (record.origin === undefined
    || record.base_revision === undefined
    || record.approval_request_path === undefined
    || record.approval_request_sha256 === undefined
    || record.approval_subject_sha256 === undefined
    || record.decision_contract_sha256 === undefined) {
    throw new Error("Plan approval revision metadata is incomplete");
  }
  return {
    schema_version: 1 as const,
    proposed_revision: revision,
    base_revision: record.base_revision,
    request_path: record.approval_request_path,
    request_sha256: record.approval_request_sha256,
    approval_subject_sha256: record.approval_subject_sha256,
  };
}

function assertDurablePlanApprovalMarker(manifest: RunManifestV2): void {
  if (
    usesDurableDiscoveryProtocol(manifest.workflow_protocol)
    && manifest.pending_plan_approval === null
    && manifest.approval_protocol_version === null
    && Object.keys(manifest.plan_revisions).length > 0
  ) {
    throw new Error("Plan approval request is missing its irreversible protocol marker");
  }
}

async function loadPlan(
  runDir: string,
  manifest: RunManifestV2,
  repoRoot = manifest.repo_root,
  revision?: number,
): Promise<BrainPlan> {
  const verified = await loadVerifiedPlanBundle(runDir, manifest, revision);
  if (repoRoot !== manifest.repo_root) {
    return parseExecutionPlan(verified.plan, { mode: manifest.mode, repoRoot }, manifest.workflow_protocol);
  }
  return verified.plan;
}

/** Reconcile approval crash gaps before resume can advance or invoke a controller. */
async function reconcileCompletedPlanApprovalEventsForResume(
  runDir: string,
): Promise<void> {
  const manifest = await readManifestV2(runDir);
  await requiresPinnedRuntimeAuthority(runDir, manifest, {
    allowHistoricalPatchOnlyConfigurationOrphan: true,
  });
  assertDurablePlanApprovalMarker(manifest);
  if (manifest.pending_plan_approval !== null) return;
  const revision = manifest.approved_revision;
  if (revision === null
    || manifest.approved_plan_revision !== revision
    || manifest.current_revision !== revision
    || manifest.current_plan_revision !== revision) return;
  const pointer = recordedApprovalPointer(manifest, revision);
  if (pointer === null) return;
  const request = await readVerifiedPlanApprovalRequest(runDir, {
    ...manifest,
    pending_plan_approval: pointer,
  });
  if (request.subject.reason_code === "material_replan") {
    await continueApprovedReplanRevision(runDir, revision, { verifyCurrentController: false });
    return;
  }
  await ensureCompletedPlanApprovalEvent(runDir, revision, { verifyCurrentController: false });
}

async function dryRunPlan(runDir: string, mode: RunMode = "local"): Promise<DiscoveredBrainPlan> {
  const brief = await readVerifiedDiscoveryBrief(runDir);
  const manifest = await readManifestV2(runDir);
  const approvedBriefSha256 = manifest.discovery?.approved_brief_sha256;
  if (approvedBriefSha256 === null || approvedBriefSha256 === undefined) {
    throw new Error("Dry-run planning requires an approved discovery brief SHA-256");
  }
  const deliveryStatus = mode === "github" ? "github_ready" : "local_ready";
  const lifecycle = mode === "github" ? "GitHub" : "local";
  const item = {
    schema_version: "2.0" as const,
    id: "dry-run-item",
    title: "Dry-run workflow item",
    objective: `Exercise the approval-gated ${lifecycle} lifecycle without changing source.`,
    dependencies: [],
    file_contract: [{ path: "dry-run-artifact", permission: "create" as const, targets: ["dry-run lifecycle marker"] }],
    forbidden_changes: [],
    change_units: [{ id: "CH-01", path: "dry-run-artifact", target: "dry-run lifecycle marker", operation: "create" as const, requirements: ["Exercise the deterministic dry-run without source edits."] }],
    acceptance: [{ id: "AC-01", statement: `The dry-run lifecycle reaches ${deliveryStatus}.`, satisfied_by: ["VERIFY-01"] }],
    tests: [],
    verification_commands: [{ id: "VERIFY-01", argv: ["true"], expected_exit_code: 0 as const }],
    expected_artifacts: [],
    browser_checks: [],
    risks: [],
    completion_contract: { expected_changed_files: ["dry-run-artifact"], allow_additional_files: false, required_acceptance_ids: ["AC-01"] },
    ambiguity_policy: { default: "stop_and_report" as const, stop_when: ["The deterministic dry-run fixture cannot execute."] },
  };
  return {
    feature_slug: "dry-run",
    parent_issue: null,
    summary: "Approval-gated dry-run workflow",
    assumptions: brief.assumptions.map((assumption) => assumption.statement),
    research: ["No external research was requested."],
    research_sources: ["dry-run fixture"],
    architecture: "No source changes are made by the dry-run.",
    risks: [],
    work_items: [item],
    integration_verification: [["true"]],
    discovery_brief_revision: brief.revision,
    discovery_brief_sha256: approvedBriefSha256,
    discovery_decision_coverage: brief.decisions.map((decision) => ({
      decision_id: decision.id,
      work_item_ids: [item.id],
      acceptance_ids: [item.acceptance[0]!.id],
      verification_command_ids: [item.verification_commands[0]!.id],
      no_implementation_effect: null,
    })),
    accepted_risks: [...brief.accepted_risks],
    out_of_scope: [...brief.out_of_scope],
  };
}

function dryRunImplementation(workItemId: string): ImplementationResult {
  return {
    work_item_id: workItemId,
    changed_files: [],
    tests_added_or_changed: [],
    commands_attempted: [],
    completed_steps: ["Dry-run implementation completed without source changes."],
    remaining_risks: [],
  };
}

function dryRunReview(
  workItemId: string,
  attempt: number,
  final: boolean,
  evidencePath: string,
  rehearsalScenario: ReleaseRehearsalScenario | null,
): ReturnType<typeof strictVerifierReviewSchema.parse> {
  if (rehearsalScenario === "verifier-fix" && workItemId === "dry-run-item" && attempt === 1 && !final) {
    return {
      work_item_id: workItemId,
      attempt,
      final,
      decision: "request_changes",
      failure_class: "implementation_failure",
      blocker: null,
      blocker_code: null,
      acceptance_coverage: ["AC-01"],
      evidence_reviewed: [evidencePath],
      findings: [{
        severity: "medium",
        file: "dry-run-artifact",
        line: null,
        acceptance_criterion: "AC-01",
        problem_class: "correctness",
        problem: "The first rehearsal attempt intentionally requires one deterministic correction.",
        required_fix: "Complete the dry-run lifecycle marker correction in the same run.",
        evidence_refs: [evidencePath],
        action_id: "R1-A1",
        order: 1,
        depends_on: [],
        remediation: {
          schema_version: 1,
          diagnosis: {
            observed_behavior: "The first deterministic review requests one correction.",
            expected_behavior: "The second attempt satisfies the local-ready criterion.",
            failure_mechanism: "The rehearsal fixture withholds approval on attempt one.",
            reproduction: ["Run the verifier-fix release rehearsal scenario."],
            evidence_refs: [evidencePath],
          },
          targets: [{ kind: "artifact", artifact_id: "dry-run-artifact", path: "dry-run-artifact" }],
          remediation: {
            strategy: "Record the deterministic dry-run correction and re-verify.",
            change_units: [{
              id: "FIX-1",
              path: "dry-run-artifact",
              target: "dry-run lifecycle marker",
              operation: "create",
              requirements: ["Satisfy the local-ready dry-run lifecycle criterion."],
              satisfies: ["SC-1"],
            }],
            allowed_files: ["dry-run-artifact"],
            forbidden_changes: [],
          },
          verification: {
            commands: [{ id: "VERIFY-01", argv: ["true"] }],
            success_conditions: [{
              id: "SC-1",
              statement: "The dry-run lifecycle reaches local_ready.",
              satisfied_by: ["VERIFY-01", "EVID-1"],
            }],
            required_evidence: [{
              id: "EVID-1",
              kind: "command_result",
              source_id: "VERIFY-01",
              output_path: evidencePath,
            }],
          },
          completion_contract: {
            required_change_unit_ids: ["FIX-1"],
            expected_changed_files: ["dry-run-artifact"],
            allow_additional_files: false,
          },
        },
      }],
      residual_risks: [],
    };
  }
  const acceptanceCoverage = workItemId === "integrated"
    ? ["dry-run-item:AC-01"]
    : ["AC-01"];
  return {
    work_item_id: workItemId,
    attempt,
    final,
    decision: "approve",
    failure_class: "none",
    blocker: null,
    blocker_code: null,
    acceptance_coverage: acceptanceCoverage,
    evidence_reviewed: [evidencePath],
    findings: [],
    residual_risks: [],
  };
}

function dryRunSelfReview(
  workItemId: string,
  parentAttempt: number,
  pass: number,
  rehearsalScenario: ReleaseRehearsalScenario | null,
): HandsSelfReviewReport {
  const reviewerCorrection = rehearsalScenario === "verifier-fix" && workItemId === "dry-run-item" && parentAttempt > 1;
  return {
    work_item_id: workItemId,
    parent_attempt: parentAttempt,
    mutation_kind: reviewerCorrection ? "reviewer_action" : parentAttempt === 1 ? "initial" : "normal_fix",
    pass,
    active_action_id: reviewerCorrection ? "R1-A1" : null,
    findings: [],
    fixes_applied: [],
    changed_files: [],
    commands_attempted: [],
    remaining_findings: [],
    ready_for_resolution_check: true,
  };
}

const dryRunDiscoveryQuestion = {
  id: "q-001",
  sequence: 1,
  category: "required" as const,
  text: "Which durable discovery boundary should this workflow use?",
  choices: [
    { id: "explicit", label: "Explicit", description: "Require an explicit command at every user boundary." },
    { id: "minimal", label: "Minimal", description: "Use only the required approval boundaries." },
  ],
  recommended_choice_id: "explicit",
  recommendation_rationale: "Explicit boundaries preserve durable operator intent.",
  rationale: "The answer changes the operator-facing workflow boundary.",
  material_effects: ["scope" as const],
  repository_evidence: ["src/cli.ts"],
  essential_after_soft_limit: null,
};

const dryRunDiscoveryApproaches = [
  {
    id: "approach-explicit",
    title: "Explicit boundaries",
    summary: "Stop at each durable user boundary.",
    tradeoffs: ["Requires a separate operator command for each decision."],
    recommended: true,
    recommendation_rationale: "It preserves exact durable intent.",
  },
  {
    id: "approach-minimal",
    title: "Minimal boundaries",
    summary: "Stop only for approvals.",
    tradeoffs: ["Intermediate decisions are less visible."],
    recommended: false,
    recommendation_rationale: null,
  },
];

function dryRunDiscoveryBrief(revision: number, proceedGuidance: string | null) {
  const proceedWithAssumptions = proceedGuidance !== null;
  return {
    revision,
    goal: revision === 1 ? "Expose durable discovery boundaries" : "Expose clarified durable discovery boundaries",
    problem: "The CLI must not cross discovery decisions automatically.",
    success_criteria: ["Every discovery decision is persisted before the next boundary."],
    constraints: ["Keep planning behind explicit discovery approval."],
    decisions: proceedWithAssumptions ? [] : [{
      id: "d-001",
      statement: "Use explicit durable discovery boundaries.",
      source_question_ids: ["q-001"],
    }],
    assumptions: proceedWithAssumptions ? [{
      id: "a-001",
      statement: `Operator guidance: ${proceedGuidance}`,
      source: "proceed_with_assumptions" as const,
      source_question_ids: ["q-001"],
    }] : [],
    selected_approach_id: proceedWithAssumptions ? null : "approach-explicit",
    selected_approach_rationale: proceedWithAssumptions ? null : "It preserves exact durable intent.",
    out_of_scope: ["Automatic approval"],
    accepted_risks: [],
    repository_evidence: ["src/cli.ts"],
  };
}

/** Structured deterministic fixtures used only when the operator requests --dry-run. */
function createDryRunLifecycleCodex(
  mode: RunMode = "local",
  rehearsalScenario: ReleaseRehearsalScenario | null = null,
): CodexAdapter {
  return {
    async invoke(input) {
      const artifact = input.artifactName;
      let fixture: unknown;
      if (artifact === "reflection-brain-account" || artifact === "reflection-hands-account") {
        fixture = {
          summary: "Dry-run process account.",
          strengths: ["The approval gate was explicit."],
          weaknesses: [],
          classifications: ["environment failures"],
          evidence_paths: [],
        };
      } else if (artifact === "reflection-synthesis") {
        fixture = {
          outcome_summary: "The dry-run completed successfully.",
          what_worked: ["The v2 lifecycle completed."],
          what_was_correct: ["The approval gate was preserved."],
          what_failed: [],
          root_causes: [],
          avoidable_rework: [],
          process_improvements: [],
          improvements: [],
          classifications: {
            implementation_defects: [],
            planning_defects: [],
            verification_gaps: [],
            environment_failures: [],
            external_blockers: [],
            unnecessary_cost_or_rework: [],
          },
          candidate_regression_tests: [],
          evidence_paths: [],
        };
      } else if (input.role === "brain" && artifact.startsWith("brain-discovery-cycle-")) {
        const proceeded = input.prompt.includes("Proceed with documented assumptions:");
        const selected = input.prompt.includes('"approach_id": "approach-explicit"');
        const rejected = input.prompt.includes('"reason":');
        if (proceeded) {
          const encodedGuidance = input.prompt.match(/"guidance":\s*("(?:\\.|[^"\\])*")/)?.[1];
          if (encodedGuidance === undefined) throw new Error("Dry-run proceed discovery prompt is missing guidance");
          fixture = {
            outcome: "ready_for_brief",
            rationale: "The operator authorized documented assumptions.",
            repository_evidence: ["src/cli.ts"],
            approaches: [],
            alternatives_omitted_reason: "The operator chose to proceed with documented assumptions.",
            brief: dryRunDiscoveryBrief(1, JSON.parse(encodedGuidance) as string),
          };
        } else if (selected) {
          fixture = {
            outcome: "ready_for_brief",
            rationale: "The operator selected the explicit boundary approach.",
            repository_evidence: ["src/cli.ts"],
            approaches: dryRunDiscoveryApproaches,
            alternatives_omitted_reason: null,
            brief: dryRunDiscoveryBrief(rejected ? 2 : 1, null),
          };
        } else if (input.prompt.includes('"answer":')) {
          fixture = {
            outcome: "ready_for_brief",
            rationale: "The answer establishes the material boundary.",
            repository_evidence: ["src/cli.ts"],
            approaches: dryRunDiscoveryApproaches,
            alternatives_omitted_reason: null,
            brief: dryRunDiscoveryBrief(1, null),
          };
        } else {
          fixture = { outcome: "ask_question", question: dryRunDiscoveryQuestion };
        }
      } else if (input.role === "brain" && artifact.startsWith("brain-plan-v2")) {
        const plan = await dryRunPlan(input.runDir, mode);
        const outputSchema = input.outputSchema as { properties?: { result?: unknown } } | undefined;
        fixture = outputSchema?.properties?.result === undefined ? plan : { result: plan };
      }
      else if (input.role === "hands") {
        const selfReviewMatch = artifact.match(/^hands-self-review-(.+)-attempt-(\d+)-pass-(\d+)$/);
        if (selfReviewMatch) {
          fixture = dryRunSelfReview(
            selfReviewMatch[1]!,
            Number(selfReviewMatch[2]),
            Number(selfReviewMatch[3]),
            rehearsalScenario,
          );
        } else if (rehearsalScenario === "verifier-fix" && /^hands-fix-packet-.+-attempt-\d+$/.test(artifact)) {
          const packetId = input.prompt.match(/"packet_id"\s*:\s*"([^"]+)"/)?.[1];
          const actionAttempt = Number(artifact.match(/-attempt-(\d+)$/)?.[1]);
          if (!packetId || !Number.isSafeInteger(actionAttempt)) throw new Error("Dry-run fix packet is missing its provenance");
          if (!input.cwd) throw new Error("Dry-run fix packet is missing its worktree path");
          const worktreePath = input.cwd;
          const packetSha256 = (await readFile(
            join(input.runDir, "reviews", "fix-packets", Buffer.from(packetId).toString("base64url"), "packet.sha256"),
            "utf8",
          )).trim();
          await writeFile(join(worktreePath, "dry-run-artifact"), "same-run verifier correction complete\n", "utf8");
          fixture = {
            schema_version: 1,
            packet_id: packetId,
            packet_sha256: packetSha256,
            action_attempt: actionAttempt,
            status: "implemented",
            change_units: [{
              change_unit_id: "FIX-1",
              status: "completed",
              changed_files: ["dry-run-artifact"],
              summary: "Recorded the deterministic dry-run lifecycle marker correction.",
            }],
            changed_files: ["dry-run-artifact"],
            commands_attempted: [],
            unresolved_requirements: [],
            blocker: null,
          };
        } else {
          const match = artifact.match(/^hands-work-item-(.+)-attempt-\d+$/);
          fixture = dryRunImplementation(match?.[1] ?? "integrated");
        }
      } else if (input.role === "verifier" && rehearsalScenario === "verifier-fix"
        && /^verifier-fix-packet-.+-attempt-\d+$/.test(artifact)) {
        const packetId = input.prompt.match(/"packet_id"\s*:\s*"([^"]+)"/)?.[1];
        const actionAttempt = Number(artifact.match(/-attempt-(\d+)$/)?.[1]);
        if (!packetId || !Number.isSafeInteger(actionAttempt)) throw new Error("Dry-run fix packet review is missing its provenance");
        const packetSha256 = (await readFile(
          join(input.runDir, "reviews", "fix-packets", Buffer.from(packetId).toString("base64url"), "packet.sha256"),
          "utf8",
        )).trim();
        const evidenceRef = input.prompt.match(/"result_path"\s*:\s*"([^"]+)"/)?.[1];
        if (!evidenceRef) throw new Error("Dry-run fix packet review is missing command evidence");
        fixture = {
          packet_id: packetId,
          packet_sha256: packetSha256,
          action_attempt: actionAttempt,
          decision: "resolved",
          condition_results: [{
            success_condition_id: "SC-1",
            status: "satisfied",
            evidence_refs: [evidenceRef],
            remaining_problem: null,
          }],
          required_next_fix: null,
          blocker: null,
        };
      } else if (input.role === "verifier") {
        const match = artifact.match(/^verifier-review-(.+?)-(?:attempt|final-attempt)-(\d+)$/);
        const workItemId = match?.[1] ?? "integrated";
        const evidencePath = input.prompt.match(/"evidence_path"\s*:\s*"([^"]+)"/)?.[1]
          ?? input.prompt.match(/"verification_ref"\s*:\s*\{[^}]*"path"\s*:\s*"([^"]+)"/s)?.[1];
        if (!evidencePath) throw new Error("Dry-run Verifier prompt is missing its verification evidence path");
        fixture = dryRunReview(
          workItemId,
          Number(match?.[2] ?? 1),
          artifact.includes("-final-attempt-"),
          evidencePath,
          rehearsalScenario,
        );
      } else {
        fixture = {
          reflection_source: "dry-run",
          observed_problem: ["No problem; this is a dry run."],
          evidence: ["dry-run fixture"],
          recommended_changes: ["None."],
          expected_benefits: ["Deterministic command behavior."],
          implementation_sequence: ["No implementation."],
          tests_and_acceptance_criteria: ["Command exits successfully."],
          risks: [],
          out_of_scope: ["Source changes."],
        };
      }
      return new DryRunCodexAdapter(fixture).invoke({ ...input, fixture });
    },
  };
}

async function loadDiscoveryCommandContext(runDir: string, dryRun: boolean) {
  const manifest = await requireV2Manifest(runDir, "discovery command");
  assertNotAbandoned(manifest);
  await assertCurrentControllerMatches(runDir, manifest);
  const repoRoot = resolve(manifest.repo_root);
  const config = await loadConfigOrDefault(repoRoot, dryRun);
  const intakeRaw = JSON.parse(await readFile(join(runDir, manifest.intake_path), "utf8")) as Parameters<typeof resolveRunIntake>[0];
  const intake = resolveRunIntake({ ...intakeRaw, repo_root: repoRoot }, config);
  const rehearsalScenario = configuredReleaseRehearsalScenario({ dryRun, mode: intake.mode });
  const budget = await openCliResourceBudget(runDir, manifest);
  return {
    intake,
    codex: dryRun ? createDryRunLifecycleCodex(intake.mode, rehearsalScenario) : new SubprocessCodexAdapter(config as never, repoRoot),
    budget,
    maxSemanticRetries: config.retry_policy.max_replan_attempts,
  };
}

async function printDiscoveryBoundary(runDir: string, json: boolean, heading?: string): Promise<void> {
  const status = await readOperatorStatus(runDir);
  const pendingAction = await readDiscoveryPendingAction(runDir);
  if (json) {
    console.log(JSON.stringify({ ...status, pending_action: pendingAction }, null, 2));
    return;
  }
  console.log([
    ...(heading ? [heading] : []),
    renderRunStatus(status),
    "Pending discovery action:",
    JSON.stringify(pendingAction, null, 2),
  ].join("\n"));
}

async function advanceDiscoveryToBoundary(runDir: string, dryRun: boolean, progress: ProgressReporter): Promise<void> {
  const context = await loadDiscoveryCommandContext(runDir, dryRun);
  await runDiscoveryTurn({ runDir, ...context, progress });
}

async function persistPreflight(runDir: string, report: unknown): Promise<void> {
  await writeTextArtifact(runDir, "preflight.json", `${JSON.stringify(report, null, 2)}\n`);
  await appendRunEvent(runDir, { actor: "cli", stage: "preflight", type: "preflight_completed", payload: report as Record<string, unknown> });
}

async function executeApprovedRunOwned(
  runDir: string,
  options: { repo?: string; dryRun?: boolean; json?: boolean; progress?: ProgressReporter },
): Promise<LocalWorkflowResult> {
  let manifest = await requireV2Manifest(runDir, "resume");
  assertNotAbandoned(manifest);
  assertDurablePlanApprovalMarker(manifest);
  if (manifest.terminal !== null && manifest.terminal.outcome !== "delivered") {
    throw new Error(`Cannot resume run with terminal outcome ${manifest.terminal.outcome}`);
  }
  const repoRoot = resolve(options.repo ?? manifest.repo_root);
  const publishApprovedBaseStatus = async (
    result: LocalWorkflowResult,
    sourceManifest: RunManifestV2,
  ): Promise<LocalWorkflowResult> => {
    const approvedRevision = sourceManifest.approved_revision ?? sourceManifest.approved_plan_revision;
    if (sourceManifest.mode !== "github" || approvedRevision === null) return result;
    const github = options.dryRun ? new DryRunGitHubAdapter() : new GhCliGitHubAdapter(repoRoot);
    const plan = await loadPlan(runDir, sourceManifest, repoRoot, approvedRevision);
    return publishGithubWorkflowStatus({
      runDir,
      plan,
      dependencies: { github } as RunGithubWorkflowInput["dependencies"],
    }, result.orderedWorkItems.length === 0
      ? { ...result, orderedWorkItems: plan.work_items }
      : result);
  };
  let preparationBlocker: string | null = null;
  let reconciliationError: unknown = null;
  let reconciledBoundary: PreparedReplanApprovalBoundary | null = null;
  try {
    const reconciled = await reconcilePendingReplanApprovalBoundary({ runDir });
    if (reconciled !== null) {
      reconciledBoundary = reconciled;
      manifest = reconciled.manifest;
    }
  } catch (error) {
    const diagnostics = error instanceof NoMaterialReplanError
      ? error.diagnostics
      : error instanceof InvalidReplanCandidateError
        ? error.diagnostics
        : null;
    if (diagnostics === null) {
      reconciliationError = error;
    } else {
      const blocker = `Replan preparation blocked: ${diagnostics.join(" | ")}`;
      if (manifest.stage === "awaiting_plan_approval") {
        manifest = await transitionRun(runDir, "replanning", {
          actor: "runtime",
          payload: { blocker, reason: "replan_candidate_not_approval_ready" },
        });
      }
      manifest = await updateManifestV2(runDir, { delivery_state: "blocked", last_blocker: blocker });
      preparationBlocker = blocker;
    }
  }
  if (preparationBlocker !== null) {
    const result: LocalWorkflowResult = {
      status: "human_action_required",
      manifest,
      orderedWorkItems: [],
      implementationResults: {},
      verification: {},
      reviews: {},
      blocker: preparationBlocker,
    };
    return publishApprovedBaseStatus(result, manifest);
  }
  if (reconciliationError !== null) {
    const blocker = `Pending replan provenance is invalid: ${reconciliationError instanceof Error ? reconciliationError.message : String(reconciliationError)}`;
    manifest = await updateManifestV2(runDir, { delivery_state: "blocked", last_blocker: blocker });
    const result: LocalWorkflowResult = {
      status: "human_action_required",
      manifest,
      orderedWorkItems: [],
      implementationResults: {},
      verification: {},
      reviews: {},
      blocker,
    };
    return publishApprovedBaseStatus(result, manifest);
  }
  if (reconciledBoundary?.state === "approved") {
    const result: LocalWorkflowResult = {
      status: "human_action_required",
      manifest,
      orderedWorkItems: [],
      implementationResults: {},
      verification: {},
      reviews: {},
      blocker: `Plan revision ${reconciledBoundary.coordinates.proposedRevision} was approved concurrently; retry resume to continue with the promoted revision`,
    };
    return result;
  }
  let pendingReplanTarget: string | null;
  try {
    pendingReplanTarget = resolvePendingReplanTarget(manifest);
  } catch (error) {
    const blocker = `Pending replan provenance is invalid: ${error instanceof Error ? error.message : String(error)}`;
    manifest = await updateManifestV2(runDir, { delivery_state: "blocked", last_blocker: blocker });
    const result: LocalWorkflowResult = {
      status: "human_action_required",
      manifest,
      orderedWorkItems: [],
      implementationResults: {},
      verification: {},
      reviews: {},
      blocker,
    };
    return publishApprovedBaseStatus(result, manifest);
  }
  if (manifest.pending_plan_approval?.base_revision === null) {
    return {
      status: "human_action_required",
      manifest,
      orderedWorkItems: [],
      implementationResults: {},
      verification: {},
      reviews: {},
      blocker: manifest.last_blocker ?? `Plan revision ${manifest.pending_plan_approval.proposed_revision} requires explicit approval`,
    };
  }
  const approvedRevision = assertApprovedRevision(manifest);
  if (pendingReplanTarget !== null) {
    const result: LocalWorkflowResult = {
      status: "human_action_required",
      manifest,
      orderedWorkItems: [],
      implementationResults: {},
      verification: {},
      reviews: {},
      blocker: manifest.last_blocker ?? `Replan patch for ${manifest.current_work_item_id} requires explicit approval`,
      ...(reconciledBoundary?.state === "pending"
        ? { pendingReplanBoundary: reconciledBoundary.coordinates }
        : {}),
    };
    return publishApprovedBaseStatus(result, manifest);
  }
  let config = await loadConfigOrDefault(repoRoot, options.dryRun === true);
  const runtimeSnapshot = await loadApprovedRuntimeSnapshot(runDir, config);
  const intakeRaw = runtimeSnapshot === null
    ? JSON.parse(await readFile(join(runDir, manifest.intake_path), "utf8")) as Parameters<typeof resolveRunIntake>[0]
    : null;
  const intake = runtimeSnapshot?.intake
    ?? resolveRunIntake({ ...intakeRaw!, repo_root: repoRoot }, config);
  if (runtimeSnapshot !== null) config = runtimeSnapshot.config;
  const rehearsalScenario: ReleaseRehearsalScenario | null = configuredReleaseRehearsalScenario({
    dryRun: options.dryRun === true,
    mode: intake.mode,
  });
  if (intake.mode !== manifest.mode) throw new Error(`Run intake mode ${intake.mode} does not match manifest mode ${manifest.mode}`);
  const plan = runtimeSnapshot?.plan
    ?? await loadPlan(runDir, manifest, repoRoot, approvedRevision);

  if (manifest.stage === "awaiting_plan_approval") {
    if (intake.mode === "local") manifest = await transitionRun(runDir, "worktree_setup", { actor: "cli", payload: { revision: approvedRevision } });
  } else if (!["worktree_setup", "awaiting_github_issue_effects", "github_issue_sync", "implementing", "verifying", "verifier_review", "fixing", "replanning", "final_verification", "awaiting_github_delivery_effects"].includes(manifest.stage)) {
    if (manifest.stage === "delivery" || manifest.stage === "complete") {
      if (manifest.mode === "local") {
        return { status: "local_ready", manifest, orderedWorkItems: [], implementationResults: {}, verification: {}, reviews: {} };
      }
      // GitHub delivery resumes must pass through runGithubWorkflow so the
      // persisted PR reference is verified and pending delivery state repaired.
    } else {
      throw new Error(`Cannot resume v2 run from stage ${manifest.stage}`);
    }
  }

  let worktreePath = manifest.worktree_path;
  let branchName = manifest.branch_name;
  const authority = currentExecutionAuthority();
  if (!authority) throw new Error("Worktree allocation and verification require an active execution lease");
  const requiresPinnedCheckout = manifest.approval_protocol_version === 1
    || manifest.run_configuration_sha256 !== null
    || manifest.workflow_protocol !== "legacy-v2";
  if (requiresPinnedCheckout && (!worktreePath || !branchName)) {
    const expectedWorktreePath = join(repoRoot, ".brain-hands", "worktrees", manifest.run_id);
    const expectedBranchName = `codex/brain-hands/${manifest.run_id}`;
    manifest = await setRunCheckoutIdentity(runDir, authority.claim, {
      worktreePath: expectedWorktreePath,
      branchName: expectedBranchName,
    });
    worktreePath = manifest.worktree_path;
    branchName = manifest.branch_name;
  }
  if (worktreePath === null || branchName === null) {
    if (!requiresPinnedCheckout) {
      worktreePath = repoRoot;
      branchName = "legacy-v2";
    } else {
    throw new Error("Pinned worktree allocation did not persist complete checkout identity");
    }
  }
  if (requiresPinnedCheckout) {
    let checkoutExists = true;
    try {
      await access(worktreePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      checkoutExists = false;
    }
    if (!checkoutExists) {
      if (manifest.checkout_allocation_state !== "pending") {
        throw new Error("Pinned checkout is missing outside an authorized allocation recovery");
      }
      if (manifest.source_commit === null) throw new Error("Worktree allocation requires a pinned source commit");
      await runWithCheckoutAllocationAuthority(async () => {
        await options.progress?.emit({ code: "worktree_preparing", source: "runtime" });
        if (options.dryRun !== true) await assertCleanSourceCheckout(repoRoot);
        const worktree = await createRunWorktree(repoRoot, manifest.run_id, manifest.source_commit!);
        if (worktree.worktreePath !== worktreePath || worktree.branchName !== branchName) {
          throw new Error("Allocated checkout differs from the pinned deterministic identity");
        }
      });
    }
  }
  if (manifest.source_commit === null) {
    if (requiresPinnedCheckout) throw new Error("Approved execution requires a pinned source commit");
  } else if (requiresPinnedCheckout) {
    await verifyRunWorktreeIdentity({
      repoRoot,
      runId: manifest.run_id,
      worktreePath,
      branchName,
      sourceCommit: manifest.source_commit,
    });
  }
  if (requiresPinnedCheckout) {
    manifest = await markRunCheckoutReady(runDir, authority.claim);
  }

  const codex = options.dryRun
    ? createDryRunLifecycleCodex(intake.mode, rehearsalScenario)
    : new SubprocessCodexAdapter(config as never, repoRoot);
  const dryRunGitHub = intake.mode === "github" && options.dryRun === true
    ? await createDryRunGitHubSession(repoRoot, manifest, plan)
    : null;
  const github = intake.mode === "github"
    ? (dryRunGitHub?.github ?? new GhCliGitHubAdapter(repoRoot))
    : undefined;
  let frozenRunConfiguration = null;
  if (intake.mode === "github") {
    try {
      frozenRunConfiguration = resolvedRunConfigurationSchema.parse(JSON.parse(
        (await readOwnedRunFile(runDir, RUN_CONFIGURATION_PATH)).toString("utf8"),
      ));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  let result = intake.mode === "github"
    ? await runWorkflow({
        runDir,
        repoRoot,
        worktreePath,
        branchName,
        intake,
        plan,
        codex,
        dependencies: {
          github: github!,
          ...(options.dryRun === true ? {
            remoteBranchSha: dryRunGitHub!.remoteBranchSha,
            pushCommit: dryRunGitHub!.pushCommit,
            executionViability: {
              readModelCatalog: async () => ({
                snapshot: {
                  models: Object.values(intake.roles).map((profile) => ({
                    slug: profile.model,
                    supported_reasoning_levels: [{ effort: profile.reasoning_effort }],
                  })),
                },
                commandResult: {} as never,
              }),
              inspectGitHubSetup: async () => ({
                repository: {
                  remote: config.github.default_remote,
                  remoteUrl: "https://github.com/dry-run/repo.git",
                  host: "github.com",
                  owner: "dry-run",
                  name: "repo",
                  nameWithOwner: "dry-run/repo",
                },
                labels: [],
              }),
            },
          } : {}),
        },
        remote: frozenRunConfiguration?.github.default_remote ?? config.github.default_remote,
        progress: options.progress,
        config,
        deferTerminalDisposition: true,
      } satisfies RunGithubWorkflowInput)
    : await runWorkflow({
        runDir,
        worktreePath,
        intake,
        plan,
        codex,
        config,
        progress: options.progress,
      deferTerminalDisposition: true,
      dependencies: releaseRehearsalDependencies(rehearsalScenario),
    });
  if (result.status === "awaiting_github_effects") return result;
  if (intake.mode === "local") {
    const existingTerminal = (await readManifestV2(runDir)).terminal;
    const boundaryAssurance = existingTerminal === null
      ? await persistFinalDeliveryAssessmentAtBoundary(runDir)
      : null;
    const assurance = boundaryAssurance ?? await assessFinalDelivery(runDir);
    if (result.status !== "human_action_required" && assurance?.outcome !== "verified_ready" && assurance?.outcome !== "human_accepted") {
      const blocker = assurance?.blocker ?? "Final-delivery assurance was not reached";
      result.status = "human_action_required";
      result.blocker = blocker;
      result.manifest = await updateManifestV2(runDir, { delivery_state: "blocked", last_blocker: blocker });
    }
  }
  return result;
}

async function executeApprovedRun(
  runDir: string,
  options: { repo?: string; dryRun?: boolean; json?: boolean; progress?: ProgressReporter },
): Promise<LocalWorkflowResult> {
  const manifest = await requireV2Manifest(runDir, "resume");
  if (manifest.approved_revision === null && manifest.pending_plan_approval?.base_revision === null) {
    return executeApprovedRunOwned(runDir, options);
  }
  const key = resolve(runDir);
  const existing = heldExecutionScopes.get(key);
  const commandInvocationId = cliCommandInvocation.getStore();
  if (!commandInvocationId) throw new Error("CLI execution scope requires a producing-command invocation identity");
  if (existing) {
    if (existing.commandInvocationId !== commandInvocationId) {
      throw new Error("Another producing command owns the active execution lease for this run");
    }
    return existing.scope.run(() => executeApprovedRunOwned(runDir, options));
  }
  const scope = await acquireRunExecutionScope(runDir);
  heldExecutionScopes.set(key, { commandInvocationId, scope });
  try {
    return await scope.run(() => executeApprovedRunOwned(runDir, options));
  } catch (error) {
    await releaseHeldExecutionScope(runDir, commandInvocationId);
    throw error;
  }
}

function deliveredResumeResult(manifest: RunManifestV2): LocalWorkflowResult {
  const pullRequestNumber = manifest.pull_request_numbers[0] ?? manifest.github_ids.pull_request_numbers[0];
  const pullRequestUrl = pullRequestNumber === undefined
    ? undefined
    : manifest.github_ids.pull_request_urls[String(pullRequestNumber)];
  return {
    status: manifest.mode === "github" ? "github_ready" : "local_ready",
    manifest,
    orderedWorkItems: [],
    implementationResults: {},
    verification: {},
    reviews: {},
    ...(pullRequestNumber !== undefined && pullRequestUrl !== undefined
      ? { pullRequest: { number: pullRequestNumber, url: pullRequestUrl } }
      : {}),
  };
}

async function createDryRunGitHubSession(
  repoRoot: string,
  manifest: RunManifestV2,
  plan: BrainPlan,
): Promise<{
  github: DryRunGitHubAdapter;
  remoteBranchSha: NonNullable<RunGithubWorkflowInput["dependencies"]["remoteBranchSha"]>;
  pushCommit: NonNullable<RunGithubWorkflowInput["dependencies"]["pushCommit"]>;
}> {
  if (manifest.task_lineage_id === null) {
    return {
      github: new DryRunGitHubAdapter(),
      remoteBranchSha: async () => null,
      pushCommit: async () => "dry-run push",
    };
  }
  const lineage = await readTaskLineage(repoRoot, manifest.task_lineage_id);
  const featureSlug = resolveFeatureSlug(plan);
  const issues: GitHubIssueObservation[] = [];
  for (const [index, item] of plan.work_items.entries()) {
    const number = lineage.issue_set.work_item_issue_map[item.id];
    if (number === undefined) continue;
    let title: string;
    try {
      title = formatWorkItemIssueTitle({ featureSlug, sequence: index + 1, itemSlug: item.id, title: item.title });
    } catch (error) {
      if (plan.feature_slug !== undefined) throw error;
      title = item.title;
    }
    issues.push({
      number,
      title,
      body: formatIssueBody(item, { lineageId: lineage.lineage_id, runId: manifest.run_id, workItemId: item.id }),
      labels: ISSUE_LABELS.split(","),
      state: "OPEN",
      state_reason: null,
    });
  }
  if (plan.parent_issue && lineage.issue_set.parent_issue_number !== null) {
    const planRevision = manifest.approved_plan_revision;
    if (planRevision === null) throw new Error("Dry-run parent hydration requires an approved plan revision");
    const parent: ParentIssueSpec = {
      title: formatParentIssueTitle({ featureSlug, title: plan.parent_issue.title }),
      summary: plan.summary,
      runId: manifest.run_id,
      featureSlug,
      planRevision,
      workItems: [],
    };
    issues.push({
      number: lineage.issue_set.parent_issue_number,
      title: parent.title,
      body: formatParentIssueBody(parent, { lineageId: lineage.lineage_id, runId: manifest.run_id, featureSlug }),
      labels: PARENT_ISSUE_LABELS.split(","),
      state: "OPEN",
      state_reason: null,
    });
  }
  const pullRequests: GitHubPullRequestReference[] = [];
  if (lineage.delivery.pull_request_number !== null && lineage.delivery.pull_request_url !== null
    && lineage.delivery.branch_name !== null && lineage.delivery.head_sha !== null) {
    const workItems = plan.work_items.map((item) => {
      const issueNumber = lineage.issue_set.work_item_issue_map[item.id];
      if (issueNumber === undefined) throw new Error(`Dry-run pull-request hydration is missing issue mapping for ${item.id}`);
      return { id: item.id, issueNumber };
    });
    const closingIssueNumbers = expectedClosingIssueNumbers({
      workItems,
      ...(lineage.issue_set.parent_issue_number === null ? {} : { parentIssueNumber: lineage.issue_set.parent_issue_number }),
    });
    pullRequests.push({
      number: lineage.delivery.pull_request_number,
      url: lineage.delivery.pull_request_url,
      title: `Task: ${plan.summary}`,
      body: reconcileClosingLinksBlock(plan.summary, lineage.lineage_id, manifest.run_id, closingIssueNumbers),
      head_ref: lineage.delivery.branch_name,
      head_sha: lineage.delivery.head_sha,
      base_ref: "main",
      closing_issue_numbers: closingIssueNumbers,
      state: "OPEN",
    });
  }
  let remoteHead = lineage.delivery.state === "applying" || lineage.delivery.state === "ready"
    ? lineage.delivery.head_sha
    : lineage.delivery.preview_prior_head_sha ?? null;
  return {
    github: new DryRunGitHubAdapter({ issues, pullRequests }),
    remoteBranchSha: async () => remoteHead,
    pushCommit: async (_worktreePath, commitSha, branchName, expectedRemoteSha) => {
      if (branchName !== manifest.branch_name || expectedRemoteSha !== remoteHead) {
        throw new Error("Dry-run push rejected an unexpected branch or remote lease");
      }
      remoteHead = commitSha;
      return "dry-run push";
    },
  };
}

function isReplanStatusPublication(result: LocalWorkflowResult): boolean {
  if (result.status !== "human_action_required" || result.manifest.mode !== "github") return false;
  if (typeof result.manifest.pending_plan_approval?.base_revision === "number") return true;
  return Object.values(result.manifest.work_item_progress).some((progress) =>
    progress.replan_patch_path !== undefined || progress.replan_target_work_item_id !== undefined,
  );
}

async function appendDiagnosticEvent(runDir: string, command: string): Promise<RunManifestV2> {
  const manifest = await requireV2Manifest(runDir, command);
  assertApprovedRevision(manifest);
  await appendRunEvent(runDir, {
    actor: "cli",
    stage: manifest.stage,
    type: "diagnostic_requested",
    payload: { command, approved_revision: manifest.approved_revision },
  });
  return manifest;
}

function addDiagnosticGuard(command: Command, description: string): Command {
  return command.description(description);
}

export function buildCli(): Command {
  const program = new Command();
  program.name("brain-hands").description("Orchestrate Codex brain/hands workflows").version(packageVersion());

  program.command("init").description("Initialize a repository for Brain Hands workflows")
    .option("--repo <path>", "Repository root", process.cwd())
    .option("--github", "Provision required GitHub repository labels", false)
    .option("--dry-run", "Show intended changes without writing them", false)
    .option("--force", "Overwrite the local config with current defaults", false)
    .option("--json", "Print machine-readable output", false)
    .action(async (options: { repo: string; github: boolean; dryRun: boolean; force: boolean; json: boolean }) => {
      const result = await initializeRepository({ repoRoot: options.repo, github: options.github, dryRun: options.dryRun, force: options.force });
      if (options.json) return console.log(JSON.stringify(result, null, 2));
      const lines = ["Brain Hands repository initialized", "", `Repository: ${result.repoRoot}`, `Config:     ${result.config.path} (${result.config.action.replaceAll("_", "-")})`];
      if (result.github) {
        lines.push(`Git remote: ${result.github.repository.remote}`, `GitHub:     ${result.github.repository.nameWithOwner}`, "", "Labels:");
        for (const label of result.github.labels) {
          const status = result.github.created.includes(label.name) ? "created" : result.github.wouldCreate.includes(label.name) ? "would-create" : label.status.replaceAll("_", "-");
          lines.push(`  ${status.padEnd(17)} ${label.name}`);
        }
      }
      console.log(lines.join("\n"));
    });

  program.command("preview").description("Show the effective configuration before creating a run")
    .option("--repo <path>", "Repository root", process.cwd())
    .option("--mode <mode>", "Execution mode: local or github")
    .option("--research [value]", "Enable web research (optionally true/false)")
    .option("--no-research", "Disable web research")
    .option("--reflection [value]", "Enable end-of-run reflection (optionally true/false)")
    .option("--no-reflection", "Disable end-of-run reflection")
    .option("--brain-model <model>", "Brain model override")
    .option("--hands-model <model>", "Hands model override")
    .option("--verifier-model <model>", "Verifier model override")
    .option("--json", "Print machine-readable output", false)
    .action(async (options: Record<string, unknown>) => {
      const repoRoot = resolve(String(options.repo ?? process.cwd()));
      let config: ConfigV2;
      try {
        config = configV2(await loadConfig(repoRoot, { migrate: false }));
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
          throw new Error(`Brain Hands is not initialized in ${repoRoot}.\nRun: brain-hands init --repo ${repoRoot}`);
        }
        throw error;
      }
      const controller = await captureVisibleController();
      const preview = resolveRunConfigurationPreview({
        repository: repoRoot,
        config,
        controller,
        choices: {
          ...(options.mode === undefined ? {} : { mode: parseMode(String(options.mode)) }),
          ...(options.research === undefined
            ? {}
            : { research: parseBooleanChoice(options.research, "research") }),
          ...(options.reflection === undefined
            ? {}
            : { reflection: parseBooleanChoice(options.reflection, "reflection") }),
        },
        overrides: {
          ...(options.brainModel === undefined ? {} : { brain: resolveModelOverride(String(options.brainModel)) }),
          ...(options.handsModel === undefined ? {} : { hands: resolveModelOverride(String(options.handsModel)) }),
          ...(options.verifierModel === undefined ? {} : { verifier: resolveModelOverride(String(options.verifierModel)) }),
        },
      });
      const renderedPreview = renderRunConfigurationPreview(preview);
      console.log(options.json === true
        ? JSON.stringify({ ...preview, rendered_preview: renderedPreview }, null, 2)
        : renderedPreview);
    });

  program.command("plan-check").description("Validate a persisted plan candidate without changing the run")
    .requiredOption("--run <runDir>", "Run directory")
    .requiredOption("--candidate <path>", "Run-relative candidate path below plans/")
    .option("--json", "Print machine-readable output", false)
    .action(async (options: { run: string; candidate: string; json: boolean }) => {
      const runDir = await resolveRunDirectory(options.run);
      const result = await checkPlanCandidate(runDir, options.candidate);
      if (options.json) console.log(JSON.stringify(result, null, 2));
      else if (result.ready) console.log("Plan candidate is execution-ready.");
      else console.log(result.diagnostics.map((diagnostic) => `${diagnostic.code} ${diagnostic.path}: ${diagnostic.message}`).join("\n"));
      if (!result.ready) process.exitCode = 1;
    });

  program.command("run").argument("<task>", "User task").description("Start a v2 workflow and stop at the first user boundary")
    .option("--repo <path>", "Repository root", process.cwd())
    .option("--mode <mode>", "Execution mode: local or github")
    .option("--research [value]", "Enable web research (optionally true/false)")
    .option("--no-research", "Disable web research")
    .option("--reflection [value]", "Enable end-of-run reflection (optionally true/false)")
    .option("--no-reflection", "Disable end-of-run reflection")
    .option("--brain-model <model>", "Brain model override")
    .option("--hands-model <model>", "Hands model override")
    .option("--verifier-model <model>", "Verifier model override")
    .option("--dry-run", "Use deterministic local fixtures", false)
    .option("--json", "Print machine-readable output", false)
    .option("--follow", "Render durable progress to stderr", false)
    .action(async (task: string, options: Record<string, unknown>) => {
      let runDir: string | undefined;
      let progress: ProgressReporter | null = null;
      return runCliProducingCommand({
        command: "run",
        runDir: () => runDir,
        progress: () => progress,
        action: async () => {
      assertFollowOptions(options);
      const missing: string[] = [];
      if (options.mode === undefined) missing.push("mode (--mode local|github)");
      if (options.research === undefined) missing.push("research (--research or --no-research)");
      if (options.reflection === undefined) missing.push("reflection (--reflection or --no-reflection)");
      if (missing.length > 0) throw new Error(`Missing required intake choice(s): ${missing.join(", ")}`);
      const mode = parseMode(options.mode as string | undefined);
      const repoRoot = String(options.repo ?? process.cwd());
      const dryRun = options.dryRun === true;
      const rehearsalScenario = configuredReleaseRehearsalScenario({ dryRun, mode });
      const prepared = await prepareFreshRun({
        task,
        repoRoot,
        choices: {
          mode,
          research: parseBooleanChoice(options.research, "research"),
          reflection: parseBooleanChoice(options.reflection, "reflection"),
          model_overrides: {
          ...(options.brainModel === undefined ? {} : { brain: resolveModelOverride(String(options.brainModel)) }),
          ...(options.handsModel === undefined ? {} : { hands: resolveModelOverride(String(options.handsModel)) }),
          ...(options.verifierModel === undefined ? {} : { verifier: resolveModelOverride(String(options.verifierModel)) }),
          },
        },
        dryRun,
        onLedgerCreated: async (ledger) => {
          runDir = ledger.runDir;
          progress = await progressReporterForCommand(ledger.runDir, options.follow === true);
        },
      });
      const { ledger, intake: resolved, config, run_configuration: runConfiguration } = prepared;
      if (options.json !== true) console.log([
        `Run ${ledger.runId} started.`,
        `Run directory: ${ledger.runDir}`,
        "",
        renderRunConfiguration(runConfiguration),
      ].join("\n"));
      await advancePreparedRunToDiscovery(prepared, { dryRun, rehearsalScenario });
      if (options.json !== true) console.log("Preflight passed; starting Brain discovery.");
      const discoveryBudget = await openCliResourceBudget(ledger.runDir, await readManifestV2(ledger.runDir));
      await runDiscoveryTurn({
        runDir: ledger.runDir,
        intake: resolved,
        codex: dryRun ? createDryRunLifecycleCodex(mode, rehearsalScenario) : new SubprocessCodexAdapter(config as never, repoRoot),
        budget: discoveryBudget,
        progress: progress!,
      });
      await printDiscoveryBoundary(
        ledger.runDir,
        options.json === true,
        `Run ${ledger.runId} reached its first user boundary.\nRun directory: ${ledger.runDir}`,
      );
        },
      });
    });

  program.command("answer-discovery").description("Answer the current discovery question and stop at the next user boundary")
    .requiredOption("--run <runDir>", "Run directory")
    .requiredOption("--question <id>", "Exact discovery question ID")
    .option("--input-file <path>", "Read the answer from a local file")
    .option("--dry-run", "Use deterministic local fixtures", false)
    .option("--json", "Print machine-readable output", false)
    .option("--follow", "Render durable progress to stderr", false)
    .action(async (options: { run: string; question: string; inputFile?: string; dryRun: boolean; json: boolean; follow: boolean }) => {
      let runDir: string | undefined;
      let progress: ProgressReporter | null = null;
      return runCliProducingCommand({
        command: "answer-discovery",
        runDir: () => runDir,
        progress: () => progress,
        action: async () => {
      assertFollowOptions(options);
      runDir = await resolveRunDirectory(options.run);
      progress = await progressReporterForCommand(runDir, options.follow);
      const answer = await readOperatorText(options.inputFile);
      await loadDiscoveryCommandContext(runDir, options.dryRun);
      await recordDiscoveryAnswer(runDir, options.question, answer);
      await advanceDiscoveryToBoundary(runDir, options.dryRun, progress);
      await printDiscoveryBoundary(runDir, options.json);
        },
      });
    });

  program.command("select-discovery-approach").description("Select an exact discovery approach and stop at the next user boundary")
    .requiredOption("--run <runDir>", "Run directory")
    .requiredOption("--revision <number>", "Exact approaches revision")
    .requiredOption("--approach <id>", "Exact approach ID")
    .option("--dry-run", "Use deterministic local fixtures", false)
    .option("--json", "Print machine-readable output", false)
    .option("--follow", "Render durable progress to stderr", false)
    .action(async (options: { run: string; revision: string; approach: string; dryRun: boolean; json: boolean; follow: boolean }) => {
      let runDir: string | undefined;
      let progress: ProgressReporter | null = null;
      return runCliProducingCommand({
        command: "select-discovery-approach",
        runDir: () => runDir,
        progress: () => progress,
        action: async () => {
      assertFollowOptions(options);
      runDir = await resolveRunDirectory(options.run);
      progress = await progressReporterForCommand(runDir, options.follow);
      await loadDiscoveryCommandContext(runDir, options.dryRun);
      await selectDiscoveryApproach(runDir, parsePositiveInteger(options.revision, "--revision"), options.approach);
      await advanceDiscoveryToBoundary(runDir, options.dryRun, progress);
      await printDiscoveryBoundary(runDir, options.json);
        },
      });
    });

  program.command("proceed-discovery").description("Proceed from the current question with documented assumptions")
    .requiredOption("--run <runDir>", "Run directory")
    .requiredOption("--question <id>", "Exact discovery question ID")
    .option("--input-file <path>", "Read assumption guidance from a local file")
    .option("--dry-run", "Use deterministic local fixtures", false)
    .option("--json", "Print machine-readable output", false)
    .option("--follow", "Render durable progress to stderr", false)
    .action(async (options: { run: string; question: string; inputFile?: string; dryRun: boolean; json: boolean; follow: boolean }) => {
      let runDir: string | undefined;
      let progress: ProgressReporter | null = null;
      return runCliProducingCommand({
        command: "proceed-discovery",
        runDir: () => runDir,
        progress: () => progress,
        action: async () => {
      assertFollowOptions(options);
      runDir = await resolveRunDirectory(options.run);
      progress = await progressReporterForCommand(runDir, options.follow);
      const guidance = await readOperatorText(options.inputFile);
      await loadDiscoveryCommandContext(runDir, options.dryRun);
      await recordDiscoveryProceedIntent(runDir, options.question, guidance);
      await advanceDiscoveryToBoundary(runDir, options.dryRun, progress);
      await printDiscoveryBoundary(runDir, options.json);
        },
      });
    });

  program.command("approve-discovery").description("Approve an exact discovery brief revision and enter planning")
    .requiredOption("--run <runDir>", "Run directory")
    .requiredOption("--revision <number>", "Exact discovery brief revision")
    .option("--dry-run", "Use deterministic local fixtures", false)
    .option("--json", "Print machine-readable output", false)
    .option("--follow", "Render durable progress to stderr", false)
    .action(async (options: { run: string; revision: string; dryRun: boolean; json: boolean; follow: boolean }) => {
      let runDir: string | undefined;
      let progress: ProgressReporter | null = null;
      return runCliProducingCommand({
        command: "approve-discovery",
        runDir: () => runDir,
        progress: () => progress,
        action: async () => {
      assertFollowOptions(options);
      runDir = await resolveRunDirectory(options.run);
      progress = await progressReporterForCommand(runDir, options.follow);
      const context = await loadDiscoveryCommandContext(runDir, options.dryRun);
      const revision = parsePositiveInteger(options.revision, "--revision");
      await approveDiscoveryBrief(runDir, revision);
      await progress.emit({ code: "discovery_brief_approved", source: "brain", revision });
      const result = await planRunV2({ runDir, ...context, progress });
      if (result.kind === "discovery_gap") {
        await printDiscoveryBoundary(runDir, options.json);
        return;
      }
      const status = await readOperatorStatus(runDir);
      if (options.json) console.log(JSON.stringify({ ...status, plan_revision: result.revision.revision }, null, 2));
      else console.log(`Run ${result.manifest.run_id} is awaiting approval for plan revision ${result.revision.revision}.\n${renderRunStatus(status)}`);
        },
      });
    });

  program.command("revise-discovery").description("Reject an exact discovery brief revision and stop at the next user boundary")
    .requiredOption("--run <runDir>", "Run directory")
    .requiredOption("--revision <number>", "Exact discovery brief revision")
    .option("--input-file <path>", "Read revision guidance from a local file")
    .option("--dry-run", "Use deterministic local fixtures", false)
    .option("--json", "Print machine-readable output", false)
    .option("--follow", "Render durable progress to stderr", false)
    .action(async (options: { run: string; revision: string; inputFile?: string; dryRun: boolean; json: boolean; follow: boolean }) => {
      let runDir: string | undefined;
      let progress: ProgressReporter | null = null;
      return runCliProducingCommand({
        command: "revise-discovery",
        runDir: () => runDir,
        progress: () => progress,
        action: async () => {
      assertFollowOptions(options);
      runDir = await resolveRunDirectory(options.run);
      progress = await progressReporterForCommand(runDir, options.follow);
      const guidance = await readOperatorText(options.inputFile);
      await loadDiscoveryCommandContext(runDir, options.dryRun);
      await rejectDiscoveryBrief(runDir, parsePositiveInteger(options.revision, "--revision"), guidance);
      await advanceDiscoveryToBoundary(runDir, options.dryRun, progress);
      await printDiscoveryBoundary(runDir, options.json);
        },
      });
    });

  program.command("approve-plan").description("Approve an exact v2 plan revision and stop at the next effect boundary")
    .argument("[runId]", "Run ID or run directory").requiredOption("--revision <number>", "Exact plan revision")
    .option("--run <runDir>", "Run directory (compatibility alias)").option("--repo <path>", "Repository root")
    .option("--dry-run", "Use deterministic local fixtures", false).option("--json", "Print machine-readable output", false).option("--follow", "Render durable progress to stderr", false)
    .action(async (runId: string | undefined, options: Record<string, unknown>) => {
      let runDir: string | undefined;
      let progress: ProgressReporter | null = null;
      let executionResult: LocalWorkflowResult | null = null;
      await runCliProducingCommand({
        command: "approve-plan",
        runDir: () => runDir,
        progress: () => progress,
        action: async () => {
      assertFollowOptions(options);
      const rawRun = String(options.run ?? runId ?? "");
      if (!rawRun) throw new Error("approve-plan requires a run ID or --run <runDir>");
      runDir = await resolveRunDirectory(rawRun, options.repo as string | undefined);
      const preflightManifest = await readManifestV2(runDir);
      const revision = parsePositiveInteger(String(options.revision), "--revision");
      let manifest = await requireV2Manifest(runDir, "approve-plan");
      assertNotAbandoned(manifest);
      await assertCurrentControllerMatches(runDir, manifest);
      if (preflightManifest.terminal !== null) {
        throw new Error(`Cannot mutate run with terminal outcome ${preflightManifest.terminal.outcome}`);
      }
      await requiresPinnedRuntimeAuthority(runDir, preflightManifest);
      assertDurablePlanApprovalMarker(preflightManifest);
      if (preflightManifest.terminal === null || preflightManifest.assurance_outcome === null) {
        progress = await progressReporterForCommand(runDir, options.follow === true);
      }
      await reconcileClaimedInitialPlanBoundary(runDir);
      manifest = await requireV2Manifest(runDir, "approve-plan");
      assertNotAbandoned(manifest);
      const approvalControllerCapture = (repoRoot: string) => captureControllerProvenance(
        repoRoot,
        { dryRun: options.dryRun === true },
      );
      let request: PlanApprovalRequestV1 | null = null;
      let exactApprovalAlreadyRecorded = false;
      if (manifest.pending_plan_approval !== null) {
        if (revision !== manifest.pending_plan_approval.proposed_revision) {
          throw new Error(
            `Requested revision ${revision} does not match pending plan approval revision ${manifest.pending_plan_approval.proposed_revision}`,
          );
        }
        request = await readVerifiedPlanApprovalRequest(runDir, manifest);
      } else {
        const current = manifest.current_revision ?? manifest.current_plan_revision;
        if (current !== revision) {
          throw new Error(`Plan revision ${revision} is not the current revision ${current ?? "none"}`);
        }
        const pointer = recordedApprovalPointer(manifest, revision);
        if (pointer !== null) {
          request = await readVerifiedPlanApprovalRequest(runDir, {
            ...manifest,
            pending_plan_approval: pointer,
          });
          exactApprovalAlreadyRecorded = manifest.approved_revision === revision
            && manifest.approved_plan_revision === revision;
          if (!exactApprovalAlreadyRecorded) {
            throw new Error("Exact plan approval request is no longer pending and is not durably approved");
          }
        }
      }
      await assertCurrentControllerMatches(runDir, manifest);
      if (exactApprovalAlreadyRecorded) {
        if (request?.subject.reason_code === "material_replan") {
          await continueApprovedReplanRevision(runDir, revision, { approvalControllerCapture });
        } else {
          await ensureCompletedPlanApprovalEvent(runDir, revision, { approvalControllerCapture });
        }
      } else if (request?.subject.reason_code === "material_replan") {
        if (request.subject.base_plan_revision === null) {
          throw new Error("Material replan approval request is missing its base revision");
        }
        const target = resolvePendingReplanTarget(manifest);
        if (target === null) throw new Error("Prepared replan approval target is missing");
        await approvePreparedReplanRevision(runDir, target, revision, { approvalControllerCapture });
      } else if (request?.subject.reason_code === "initial_plan") {
        if (request.subject.base_plan_revision !== null) {
          throw new Error("Initial plan approval request cannot have a base revision");
        }
        await approvePlanRevision(runDir, revision, { actor: "human", approvalControllerCapture });
      } else {
        if ((manifest.current_revision ?? manifest.current_plan_revision) !== revision) throw new Error(`Plan revision ${revision} is not the current revision ${manifest.current_revision ?? manifest.current_plan_revision ?? "none"}`);
        await loadPlan(runDir, manifest, resolve((options.repo as string | undefined) ?? manifest.repo_root));
        await approvePlanRevision(runDir, revision, { actor: "human", approvalControllerCapture });
      }
      if (exactApprovalAlreadyRecorded && options.json !== true) {
        console.log("Exact approval already recorded for this subject; continuing the approved run.");
      }
      let result: LocalWorkflowResult;
      try {
        result = await executeApprovedRun(runDir, { repo: options.repo as string | undefined, dryRun: options.dryRun === true, json: options.json === true, progress: progress ?? undefined });
      } catch (error) {
        if (!isLostExecutionLeaseError(error)) throw error;
        const current = await readManifestV2(runDir);
        if (current.pending_plan_approval !== null
          || current.approved_revision === null
          || current.approved_revision !== current.current_revision
          || current.approved_plan_revision !== current.current_plan_revision) {
          throw error;
        }
        result = {
          status: "human_action_required",
          manifest: current,
          orderedWorkItems: [],
          implementationResults: {},
          verification: {},
          reviews: {},
          blocker: "Plan approval completed concurrently; resume again to continue.",
        };
      }
      executionResult = result;
      const status = await readOperatorStatus(runDir);
      if (options.json === true) console.log(JSON.stringify({ ...status, workflow_result: result.status }, null, 2));
      else console.log([`Run ${result.manifest.run_id}: ${result.status} (${result.manifest.stage})`, renderRunStatus(status)].join("\n"));
      return result;
        },
        beforeFinalize: async () => {
          if (!executionResult || executionResult.status === "human_action_required" || executionResult.status === "awaiting_github_effects") return;
          const current = await readManifestV2(runDir!);
          if (current.terminal === null) {
            await recordTerminalWithoutFinalization(runDir!, {
                outcome: "delivered",
                actor: "runtime",
                reason: current.mode === "github"
                  ? "Pull request delivery is ready for human review"
                  : "Local delivery is ready",
                residualRisks: [],
                assurance: current.assurance_outcome ?? "verified_ready",
            });
          }
        },
        reconcile: async () => reconcileAfterExplicitTerminalAction(runDir!),
        reflect: async (manifest) => reflectTerminalRun(runDir!, manifest, { repo: options.repo as string | undefined, dryRun: options.dryRun === true, progress }),
        assure: async (manifest) => assureTerminalRun(runDir!, manifest),
      });
    });

  program.command("resume").description("Apply the current approved effect preview or continue the next approved v2 workflow stage")
    .argument("[runId]", "Run ID or run directory").option("--run <runDir>", "Run directory (compatibility alias)")
    .option("--actor <actor>", "Operator authorizing one diagnostic recovery attempt")
    .option("--recovery-note-file <path>", "Read the diagnostic recovery note from a local file")
    .option("--repo <path>", "Repository root").option("--dry-run", "Use deterministic local fixtures", false).option("--json", "Print machine-readable output", false).option("--follow", "Render durable progress to stderr", false)
    .action(async (runId: string | undefined, options: Record<string, unknown>) => {
      let runDir: string | undefined;
      let progress: ProgressReporter | null = null;
      let executionResult: LocalWorkflowResult | null = null;
      await runCliProducingCommand({
        command: "resume",
        runDir: () => runDir,
        progress: () => progress,
        action: async () => {
      assertFollowOptions(options);
	      const rawRun = String(options.run ?? runId ?? "");
	      if (!rawRun) throw new Error("resume requires a run ID or --run <runDir>");
	      runDir = await resolveRunDirectory(rawRun, options.repo as string | undefined);
	      let recoveryManifest = await requireV2Manifest(runDir, "resume");
	      await reconcileCompletedPlanApprovalEventsForResume(runDir);
	      recoveryManifest = await requireV2Manifest(runDir, "resume");
	      await assertCurrentControllerMatches(runDir, recoveryManifest);
	      recoveryManifest = await prepareDiagnosticResume({
	        runDir,
	        actor: options.actor as string | undefined,
	        recoveryNoteFile: options.recoveryNoteFile as string | undefined,
	      });
	      const terminalManifest = await readManifestV2(runDir);
      if (terminalManifest.terminal?.outcome !== undefined && terminalManifest.terminal.outcome !== "delivered") {
        throw new Error(`Cannot resume run with terminal outcome ${terminalManifest.terminal.outcome}`);
      }
      if (terminalManifest.terminal?.outcome === "delivered") {
        const result = deliveredResumeResult(terminalManifest);
        executionResult = result;
        const status = await readOperatorStatus(runDir);
        if (options.json === true) console.log(JSON.stringify({ ...status, workflow_result: result.status }, null, 2));
        else console.log([`Run ${result.manifest.run_id}: ${result.status} (${result.manifest.stage})`, renderRunStatus(status)].join("\n"));
        return result;
      }
      const preflightManifest = await readManifestV2(runDir);
      if (preflightManifest.terminal?.outcome !== "delivered"
        && (preflightManifest.terminal === null || preflightManifest.assurance_outcome === null)) {
        progress = await progressReporterForCommand(runDir, options.follow === true);
      }
      let manifest = await requireV2Manifest(runDir, "resume");
      await assertCurrentControllerMatches(runDir, manifest);
      await reconcileClaimedInitialPlanBoundary(runDir);
      manifest = await requireV2Manifest(runDir, "resume");
      if (manifest.stage === "brain_discovery") {
        const context = await loadDiscoveryCommandContext(runDir, options.dryRun === true);
        await runDiscoveryTurn({ runDir, ...context, progress: progress! });
        await printDiscoveryBoundary(runDir, options.json === true);
        return;
      }
      if (manifest.stage === "brain_planning") {
        const context = await loadDiscoveryCommandContext(runDir, options.dryRun === true);
        const result = await planRunV2({ runDir, ...context, progress: progress! });
        if (result.kind === "discovery_gap") await printDiscoveryBoundary(runDir, options.json === true);
        else {
          const status = await readOperatorStatus(runDir);
          if (options.json === true) console.log(JSON.stringify({ ...status, plan_revision: result.revision.revision }, null, 2));
          else console.log(renderRunStatus(status));
        }
        return;
      }
      if ([
        "awaiting_discovery_answer",
        "awaiting_discovery_approach",
        "awaiting_discovery_brief_approval",
      ].includes(manifest.stage)) {
        await printDiscoveryBoundary(runDir, options.json === true);
        return;
      }
      let result: LocalWorkflowResult;
      try {
        result = await executeApprovedRun(runDir, { repo: options.repo as string | undefined, dryRun: options.dryRun === true, json: options.json === true, progress: progress ?? undefined });
      } catch (error) {
        if (!isLostExecutionLeaseError(error)) throw error;
        const current = await readManifestV2(runDir);
        if (current.pending_plan_approval !== null
          || current.approved_revision === null
          || current.approved_revision !== current.current_revision
          || current.approved_plan_revision !== current.current_plan_revision) {
          throw error;
        }
        result = {
          status: "human_action_required",
          manifest: current,
          orderedWorkItems: [],
          implementationResults: {},
          verification: {},
          reviews: {},
          blocker: "Plan approval completed concurrently; resume again to continue.",
        };
      }
      executionResult = result;
      const status = await readOperatorStatus(
        runDir,
        isReplanStatusPublication(result) ? { assessAssurance: false } : {},
      );
      if (options.json === true) console.log(JSON.stringify({ ...status, workflow_result: result.status }, null, 2));
      else console.log([`Run ${result.manifest.run_id}: ${result.status} (${result.manifest.stage})`, renderRunStatus(status)].join("\n"));
      return result;
        },
        finalizeRequiresAuthority: () => executionResult?.status !== "human_action_required",
        beforeFinalize: async () => {
          if (!executionResult || executionResult.status === "human_action_required" || executionResult.status === "awaiting_github_effects") return;
          const current = await readManifestV2(runDir!);
          if (current.terminal === null) {
            await recordTerminalWithoutFinalization(runDir!, {
                outcome: "delivered",
                actor: "runtime",
                reason: current.mode === "github"
                  ? "Pull request delivery is ready for human review"
                  : "Local delivery is ready",
                residualRisks: [],
                assurance: current.assurance_outcome ?? "verified_ready",
            });
          }
        },
        reconcile: async () => reconcileAfterExplicitTerminalAction(runDir!),
        reflect: async (manifest) => reflectTerminalRun(runDir!, manifest, { repo: options.repo as string | undefined, dryRun: options.dryRun === true, progress }),
        assure: async (manifest) => assureTerminalRun(runDir!, manifest),
      });
    });

  program.command("close-run").description("Explicitly close a resumable v2 run")
    .requiredOption("--run <runDir>", "Run directory")
    .requiredOption("--outcome <outcome>", "human-accepted, abandoned, or blocked")
    .requiredOption("--reason <reason>", "Human reason for closing the run")
    .option("--repo <path>", "Repository root")
    .option("--dry-run", "Use deterministic reflection fixtures", false)
    .action(async (options: { run: string; outcome: string; reason: string; repo?: string; dryRun: boolean }) => {
      let runDir: string | undefined;
      let progress: ProgressReporter | null = null;
      let requestedOutcome: "human_accepted" | "abandoned" | "closed_blocked" | null = null;
      return runCliProducingCommand({
        command: "close-run",
        runDir: () => runDir,
        progress: () => progress,
        action: async () => {
      runDir = await resolveRunDirectory(options.run, options.repo);
      const manifest = await requireV2Manifest(runDir, "close-run");
      if (manifest.terminal === null || manifest.assurance_outcome === null) {
        progress = await progressReporterForCommand(runDir, false);
      }
      const outcome = options.outcome === "blocked" ? "closed_blocked" : options.outcome.replaceAll("-", "_");
      if (!(["human_accepted", "abandoned", "closed_blocked"] as const).includes(outcome as never)) {
        throw new Error("--outcome must be human-accepted, abandoned, or blocked");
      }
      if (!options.reason.trim()) throw new Error("--reason must be non-empty");
      if (manifest.terminal !== null && manifest.terminal.outcome !== outcome) {
        throw new Error(`Run already has terminal outcome ${manifest.terminal.outcome}`);
      }
      if (manifest.terminal === null) await reserveReflectionArtifactsBeforeTerminal(runDir, manifest);
      requestedOutcome = outcome as "human_accepted" | "abandoned" | "closed_blocked";
        },
        beforeFinalize: async () => {
          const manifest = await readManifestV2(runDir!);
          const terminal = manifest.terminal === null
            ? await recordTerminalWithoutFinalization(runDir!, {
                outcome: requestedOutcome!,
                actor: "human",
                reason: options.reason,
                residualRisks: manifest.last_blocker ? [manifest.last_blocker] : [],
                assurance: requestedOutcome === "human_accepted"
                  ? "human_accepted"
                  : requestedOutcome === "abandoned" ? "abandoned" : "blocked",
              })
            : manifest;
          console.log(`Run ${terminal.run_id} closed with outcome ${requestedOutcome}.`);
        },
        reconcile: async () => reconcileAfterExplicitTerminalAction(runDir!),
        reflect: async (current) => reflectTerminalRun(runDir!, current, { repo: options.repo, dryRun: options.dryRun, progress }),
        assure: async (current) => assureTerminalRun(runDir!, current),
      });
    });

  program.command("reconcile-github").description("Dry-run GitHub issue lifecycle audit; repair only with --apply")
    .requiredOption("--run <runDir>", "Run directory")
    .option("--apply", "Apply marker-authorized pull-request and issue mutations", false)
    .option("--json", "Print machine-readable output", false)
    .action(async (options: { run: string; apply: boolean; json: boolean }) => {
      const runDir = await resolveRunDirectory(options.run);
      const manifest = await requireV2Manifest(runDir, "reconcile-github");
      if (manifest.mode !== "github") throw new Error("reconcile-github requires a GitHub-mode run");
      const github = new GhCliGitHubAdapter(resolve(manifest.repo_root));
      const budget = await openCliResourceBudget(runDir, manifest);
      const report = manifest.github_cleanup === null
        ? await reconcileAmbiguousLineageIssueOperations({
            runDir,
            manifest,
            github,
            apply: options.apply === true,
          }) ?? await reconcileGitHubIssues({ runDir, manifest, github, apply: options.apply === true, budget })
        : await reconcileGitHubIssues({ runDir, manifest, github, apply: options.apply === true, budget });
      console.log(options.json ? JSON.stringify(report, null, 2) : ("targets" in report ? JSON.stringify(report, null, 2) : renderIssueLifecycleReport(report)));
    });

  program.command("status").description("Show v2 workflow run status")
    .argument("[runId]", "Run ID or run directory").option("--run <runDir>", "Run directory (compatibility alias)").option("--repo <path>", "Repository root", process.cwd()).option("--json", "Print machine-readable output", false).option("--include-progress", "Include observational activity in JSON output", false)
    .action(async (runId: string | undefined, options: Record<string, unknown>) => {
      const rawRun = String(options.run ?? runId ?? "");
      if (!rawRun) throw new Error("status requires a run ID or --run <runDir>");
      const runDir = await resolveRunDirectory(rawRun, options.repo as string | undefined);
      const manifest = await readManifestV2(runDir);
      const status = await readOperatorStatus(runDir);
      if (options.json === true) {
        const output = options.includeProgress === true
          ? { ...status, activity: await summarizeProgressActivity(runDir, manifest) }
          : status;
        console.log(JSON.stringify(output, null, 2));
      }
      else console.log(await summarizeRun(runDir));
    });

  program.command("recover-controller").description("Attest reviewed controller package bytes for a resumable run")
    .requiredOption("--run <runDir>", "Run directory")
    .requiredOption("--actor <actor>", "Operator recording the controller transition")
    .requiredOption("--reason <reason>", "Reason for accepting the controller transition")
    .requiredOption("--expected-package-sha256 <sha256>", "Expected SHA-256 of the visible controller package")
    .option("--json", "Print machine-readable output", false)
    .action(async (options: {
      run: string;
      actor: string;
      reason: string;
      expectedPackageSha256: string;
      json: boolean;
    }) => {
      const runDir = await resolveRunDirectory(options.run);
      const transition = await recordControllerRecovery({
        runDir,
        actor: options.actor,
        reason: options.reason,
        expectedPackageSha256: options.expectedPackageSha256,
      });
      const status = await readOperatorStatus(runDir);
      console.log(options.json
        ? JSON.stringify({ transition: transition.artifact, transition_path: transition.artifact_path, status }, null, 2)
        : renderRunStatus(status));
    });

  program.command("accept-risk").description("Accept an exact final-delivery evidence risk")
    .requiredOption("--run <runDir>", "Run directory")
    .requiredOption("--gate <gate>", "Gate name (final-delivery)")
    .requiredOption("--actor <actor>", "Accepting actor")
    .requiredOption("--reason <reason>", "Acceptance reason")
    .option("--json", "Print machine-readable output", false)
    .action(async (options: { run: string; gate: string; actor: string; reason: string; json: boolean }) => {
      const runDir = await resolveRunDirectory(options.run);
      if (options.gate !== "final-delivery") throw new Error("--gate must be final-delivery");
      const artifact = await acceptFinalDeliveryRisk(runDir, options.actor, options.reason);
      const status = await readOperatorStatus(runDir);
      console.log(options.json ? JSON.stringify({ acceptance: artifact, status }, null, 2) : renderRunStatus(status));
    });

  program.command("abandon").description("Irreversibly abandon a workflow run")
    .requiredOption("--run <runDir>", "Run directory")
    .requiredOption("--actor <actor>", "Abandoning actor")
    .requiredOption("--reason <reason>", "Abandonment reason")
    .option("--json", "Print machine-readable output", false)
    .action(async (options: { run: string; actor: string; reason: string; json: boolean }) => {
      let runDir: string | undefined;
      let progress: ProgressReporter | null = null;
      return runCliProducingCommand({
        command: "abandon",
        runDir: () => runDir,
        progress: () => progress,
        action: async () => {
      runDir = await resolveRunDirectory(options.run);
      const before = await readManifestV2(runDir);
      if (before.terminal === null || before.assurance_outcome === null) {
        progress = await progressReporterForCommand(runDir, false);
      }
      if (!options.reason.trim()) throw new Error("--reason must be non-empty");
      if (before.terminal !== null && before.terminal.outcome !== "abandoned") {
        throw new Error(`Run already has terminal outcome ${before.terminal.outcome}`);
      }
      if (before.terminal === null) await reserveReflectionArtifactsBeforeTerminal(runDir, before);
        },
        beforeFinalize: async () => {
          const manifest = await ensureAbandonedTerminal(runDir!, options.actor, options.reason);
          const status = await readOperatorStatus(runDir!);
          const artifact = manifest.abandonment_path
            ? JSON.parse(await readFile(join(runDir!, manifest.abandonment_path), "utf8"))
            : { actor: options.actor, reason: options.reason };
          console.log(options.json ? JSON.stringify({ abandonment: artifact, status }, null, 2) : renderRunStatus(status));
        },
        reconcile: async () => reconcileAfterExplicitTerminalAction(runDir!),
        reflect: async (current) => reflectTerminalRun(runDir!, current, { progress }),
        assure: async (current) => assureTerminalRun(runDir!, current),
      });
    });

  program.command("replace").description("Create one fresh run linked to an explicitly abandoned predecessor")
    .requiredOption("--run <runDir>", "Abandoned predecessor run directory")
    .requiredOption("--actor <actor>", "Replacing actor")
    .requiredOption("--reason <reason>", "Replacement reason")
    .option("--json", "Print machine-readable output", false)
    .action(async (options: { run: string; actor: string; reason: string; json: boolean }) => {
      const runDir = await resolveRunDirectory(options.run);
      const replacement = await replacementWorkflow.replaceAbandonedRun({
        runDir,
        actor: options.actor,
        reason: options.reason,
      });
      const nextCommand = `brain-hands resume --run ${shellQuote(replacement.successorRunDir)}`;
      console.log(options.json
        ? JSON.stringify({
            predecessor_run_dir: runDir,
            successor_run_id: replacement.successorRunId,
            successor_run_dir: replacement.successorRunDir,
            next_command: nextCommand,
          }, null, 2)
        : [
            `Replacement run directory: ${replacement.successorRunDir}`,
            `Next command: ${nextCommand}`,
          ].join("\n"));
    });

  program.command("logs").description("Replay safe progress or inspect immutable workflow events")
    .argument("[runId]", "Run ID or run directory").option("--run <runDir>", "Run directory (compatibility alias)")
    .option("--repo <path>", "Repository root", process.cwd()).option("--follow", "Wait for new progress until a quiescent boundary", false)
    .option("--json", "Print validated progress events as JSON lines", false)
    .action(async (runId: string | undefined, options: Record<string, unknown>) => {
      const rawRun = String(options.run ?? runId ?? "");
      if (!rawRun) throw new Error("logs requires a run ID or --run <runDir>");
      const runDir = await resolveRunDirectory(rawRun, options.repo as string | undefined);
      await requireV2Manifest(runDir, "logs");
      const { status, events } = await readRunLog(runDir);
      if (options.json === true && options.follow !== true) {
        const progressEvents: SafeProgressEvent[] = [];
        for await (const event of readProgressEvents(runDir)) progressEvents.push(event);
        console.log(JSON.stringify({
          status,
          events,
          progress_events: progressEvents,
          session_event: await readCanonicalSessionEvent(runDir),
        }, null, 2));
        return;
      }
      let count = 0;
      const view = options.json === true ? null : createProgressViewReducer({ emit: (row) => { console.log(row); } });
      const render = async (event: SafeProgressEvent): Promise<void> => {
        count += 1;
        if (options.json === true) console.log(JSON.stringify(event));
        else await view!.push(event);
      };
      if (options.follow === true) {
        try {
          await followProgressEvents({ runDir, onEvent: render });
        } finally {
          await view?.flush();
        }
      } else {
        for await (const event of readProgressEvents(runDir)) await render(event);
        await view?.flush();
      }
      if (count === 0) console.log("No progress events recorded.");
    });

  program.command("doctor").description("Check local tool dependencies")
    .requiredOption("--mode <mode>", "Execution mode: local or github").option("--repo <path>", "Repository root", process.cwd())
    .option("--live-model-check", "Run a read-only live model probe", false).option("--strict", "Fail when required checks do not pass", false)
    .option("--no-github", "Compatibility alias for --mode local")
    .action(async (options: { repo: string; mode?: string; liveModelCheck: boolean; strict: boolean; github: boolean }) => {
      const config = await loadConfigOrDefault(options.repo, true);
      const mode = parseMode(options.mode);
      const preflightOptions = { repoRoot: options.repo, config: config as never, strict: options.strict, githubMode: mode === "github" } as Parameters<typeof runPreflight>[0];
      if (options.liveModelCheck) preflightOptions.liveModelCheck = true;
      const result = await runPreflight(preflightOptions);
      console.log(JSON.stringify({ mode, ...result }, null, 2));
      if (options.strict && result.required_checks_failed) process.exitCode = 1;
    });

  program.command("reflection").description("Generate reflection or an analysis-only improvement plan")
    .requiredOption("--update-from-reflection <path>", "Reflection artifact path").requiredOption("--repo <path>", "Repository root")
    .option("--dry-run", "Use deterministic fixture output", false).option("--brain-model <model>", "Brain model override")
    .action(async (options: { updateFromReflection: string; repo: string; dryRun: boolean; brainModel?: string }) => {
      const config = await loadConfigOrDefault(options.repo, options.dryRun);
      const codex = options.dryRun ? createDryRunLifecycleCodex() : new SubprocessCodexAdapter(config as never, options.repo);
      const result = await planFromReflection({ reflectionPath: options.updateFromReflection, sourceRepo: options.repo, codex, brainModel: options.brainModel === undefined ? undefined : resolveModelOverride(options.brainModel), intake: { roles: config.profiles } });
      console.log(`${result.message}\nJSON: ${result.jsonPath}`);
    });

  const implement = addDiagnosticGuard(program.command("implement"), "Read-only v2 implementation diagnostic (does not modify source)");
  implement.requiredOption("--run <runDir>", "Run directory").requiredOption("--issue <number>", "Issue number").option("--repo <path>", "Repository root", process.cwd())
    .action(async (options: { run: string; issue: string; repo: string }) => { parsePositiveInteger(options.issue, "--issue"); const runDir = await resolveRunDirectory(options.run, options.repo); await appendDiagnosticEvent(runDir, "implement"); console.log("Implementation diagnostics are read-only in v2; use approve-plan or resume to execute."); });
  const review = addDiagnosticGuard(program.command("review"), "Read-only v2 review diagnostic");
  review.requiredOption("--run <runDir>", "Run directory").requiredOption("--issue <number>", "Issue number").requiredOption("--pr <number>", "PR number").option("--repo <path>", "Repository root", process.cwd())
    .action(async (options: { run: string; repo: string; issue: string; pr: string }) => { parsePositiveInteger(options.issue, "--issue"); parsePositiveInteger(options.pr, "--pr"); const runDir = await resolveRunDirectory(options.run, options.repo); await appendDiagnosticEvent(runDir, "review"); console.log("Review diagnostics are read-only in v2; use resume to continue."); });
  const fix = addDiagnosticGuard(program.command("fix"), "Read-only v2 fix diagnostic");
  fix.requiredOption("--run <runDir>", "Run directory").requiredOption("--issue <number>", "Issue number").requiredOption("--pr <number>", "PR number").option("--repo <path>", "Repository root", process.cwd())
    .action(async (options: { run: string; repo: string; issue: string; pr: string }) => { parsePositiveInteger(options.issue, "--issue"); parsePositiveInteger(options.pr, "--pr"); const runDir = await resolveRunDirectory(options.run, options.repo); await appendDiagnosticEvent(runDir, "fix"); console.log("Fix diagnostics are read-only in v2; use resume to continue."); });

  const packageCommand = addDiagnosticGuard(program.command("review-package"), "Generate a read-only v2 review package");
  packageCommand.requiredOption("--run <runDir>", "Run directory").option("--issue <number>", "Mapped GitHub issue number").option("--work-item <workItemId>", "Local work-item ID").requiredOption("--out <path>", "Output package directory").option("--repo <path>", "Repository root", process.cwd())
    .action(async (options: { run: string; issue?: string; workItem?: string; out: string; repo: string }) => {
      if (options.issue !== undefined && options.workItem !== undefined) {
        throw new Error("--issue and --work-item are mutually exclusive");
      }
      const runDir = await resolveRunDirectory(options.run, options.repo);
      const manifest = await appendDiagnosticEvent(runDir, "review-package");
      if (manifest.mode === "local") {
        if (options.issue !== undefined) throw new Error("Local review packages require --work-item");
        if (options.workItem === undefined) throw new Error("Local review packages require --work-item");
      } else {
        if (options.workItem !== undefined) throw new Error("GitHub review packages require --issue");
        if (options.issue === undefined) throw new Error("GitHub review packages require --issue");
      }
      const result = await createReviewPackage({
        repoRoot: options.repo,
        runDir,
        issueNumber: options.issue === undefined ? undefined : parsePositiveInteger(options.issue, "--issue"),
        workItemId: options.workItem,
        outDir: runArtifactPath(runDir, options.out, "--out"),
      });
      console.log(`Review package: ${result.packageDir}`);
    });

  const issue = program.command("issue").description("Read-only v2 issue diagnostics");
  issue.command("import").requiredOption("--run <runDir>", "Run directory").requiredOption("--file <filePath>", "Issue JSON file path")
    .option("--repo <path>", "Repository root", process.cwd())
    .action(async (options: { run: string; file: string; repo: string }) => { const runDir = await resolveRunDirectory(options.run, options.repo); await appendDiagnosticEvent(runDir, "issue import"); const imported = await importIssues({ runDir, filePath: options.file }); console.log(`Imported ${imported.length} issue(s)`); });

  const browser = program.command("browser").description("Read-only v2 browser diagnostics");
  browser.command("verify").requiredOption("--issue-file <filePath>", "Issue JSON file path").requiredOption("--report <path>", "Browser evidence report path").requiredOption("--run <runDir>", "v2 run directory").option("--issue <number>", "Mapped GitHub issue number").option("--work-item <workItemId>", "Local work-item ID").option("--integrated", "Use the dedicated integrated verification identity", false).option("--attempt <number>", "Verification attempt", "1").option("--repo <path>", "Repository root", process.cwd()).option("--chrome <path>", "Chrome executable path")
    .action(async (options: { issueFile: string; report: string; run: string; issue?: string; workItem?: string; integrated: boolean; attempt: string; repo: string; chrome?: string }) => {
      const identityOptions = [options.issue !== undefined, options.workItem !== undefined, options.integrated].filter(Boolean).length;
      if (identityOptions !== 1) throw new Error("Exactly one of --issue, --work-item, or --integrated is required");
      const runDir = await resolveRunDirectory(options.run, options.repo);
      const manifest = await requireV2Manifest(runDir, "browser verification");
      assertApprovedRevision(manifest);
      const attempt = parsePositiveInteger(options.attempt, "--attempt");
      const issueValue = issueSpecSchema.parse(JSON.parse(await readFile(options.issueFile, "utf8")));
      let identity: VerificationIdentity;
      if (options.integrated) {
        identity = { scope: "integrated", work_item_id: "integrated" };
      } else if (options.workItem !== undefined) {
        if (manifest.mode !== "local") throw new Error("--work-item browser verification requires a local run");
        identity = await resolveLocalBrowserIdentity(manifest, runDir, options.workItem);
      } else {
        if (options.issue === undefined) throw new Error("--issue is required for mapped GitHub browser verification");
        const issueNumber = parsePositiveInteger(options.issue, "--issue");
        if (manifest.mode !== "github") throw new Error("--issue browser verification requires a GitHub run");
        identity = resolveMappedBrowserIdentity(manifest, issueNumber);
      }
      assertBrowserProgressIdentity(manifest, identity);
      await appendDiagnosticEvent(runDir, "browser verify");
      const result = await verifyBrowserIssue({ repoRoot: options.repo, issue: issueValue, reportPath: runArtifactPath(runDir, options.report, "--report"), artifactRoot: runDir, runDir, identity, attempt, chromePath: options.chrome });
      console.log(`${result.status}: wrote ${result.reportPath}`);
      if (result.status === "failed") process.exitCode = 1;
    });

  program.command("final-audit").description("Render a final v2 audit report")
    .requiredOption("--run <runDir>", "Run directory").option("--repo <path>", "Repository root", process.cwd()).option("--dry-run", "Use deterministic fixtures", false)
    .action(async (options: { run: string; repo: string; dryRun: boolean }) => {
      await appendDiagnosticEvent(options.run, "final-audit");
      const before = await persistFinalDeliveryAssessment(options.run);
      if (before.outcome !== "verified_ready" && before.outcome !== "human_accepted") {
        throw new Error(`Final audit requires a ready or human-accepted candidate: ${before.blocker ?? before.outcome}`);
      }
      const config = await loadConfigOrDefault(options.repo, options.dryRun);
      const report = await finalAudit({
        runDir: options.run, repoRoot: options.repo, config: config as never,
        codex: options.dryRun ? createDryRunLifecycleCodex() : new SubprocessCodexAdapter(config as never, options.repo),
        dryRun: options.dryRun,
      });
      const assurance = await persistFinalDeliveryAssessment(options.run);
      console.log(`${report}\n\nAssurance outcome: ${assurance.outcome}${assurance.blocker ? `\nAssurance blocker: ${assurance.blocker}` : ""}`);
    });

  return program;
}

function isMainModule(moduleUrl: string, argvPath: string | undefined): boolean {
  if (!argvPath) return false;
  return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(argvPath);
}

if (isMainModule(import.meta.url, process.argv[1])) await buildCli().parseAsync(process.argv);
