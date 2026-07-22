import { constants, realpathSync } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { hostname } from "node:os";
import { AsyncLocalStorage } from "node:async_hooks";
import type {
  HandsSelfReviewReport,
  ResolvedRunIntake,
  RoleName,
  RoleProfile,
  RunEvent,
  RunIntake,
  RunManifest,
  RunManifestV2,
  RunMode,
  RunStageV2,
  VerificationEvidence,
  ReviewerActionQueue,
  AcceptanceCriterion,
  ReviewAccounting,
  TerminalDisposition,
  TaskLineageV1,
  GithubCleanupBatch,
  LegacyGithubRestoreAuthority,
  PendingPlanApprovalV1,
  PlanApprovalRequestV1,
  PlanRevision,
  ControllerProvenance,
  BrainPlan,
  DiscoveredBrainPlan,
  ExecutionLeaseClaim,
  ExecutionLeaseV1,
} from "./types.js";
import { browserEvidenceReportPathForIdentity } from "./verification-provenance.js";
import type { TaskLineageRecordV1, TaskLineageState } from "./task-lineage.js";
import {
  CANONICAL_REVIEW_POLICY,
  DEFAULT_RELEASE_GUARDS,
  resolveReviewPolicy,
} from "./config.js";
import { assertTransition, usesDurableDiscoveryProtocol } from "./run-state.js";
import { initialDiscoveryState } from "./discovery.js";
import {
  artifactPathSchema,
  handsSelfReviewReportSchema,
  runManifestSchema,
  runManifestV2Schema,
  runEventSchema,
  reviewerActionQueueSchema,
  verificationEvidenceSchema,
  persistedVerifierReviewSchema,
  reviewAccountingSchema,
  reviewCycleStateSchema,
  convergenceReportSchema,
  planApprovalRequestSchema,
  warningContinuationAuthorizationSchema,
  warningContinuationAuthoritySchema,
  terminalDispositionSchema,
} from "./schema.js";
import { verificationIdentityDirectory, type VerificationIdentity } from "./types.js";
import { z, type ZodType } from "zod";
import { appendOwnedRunFile, readOwnedEvidenceFile, readOwnedRunFile, writeOwnedEvidenceFile } from "./owned-evidence.js";
import { finalizeSession, initializeSessionArtifacts } from "../progress/session-store.js";
import { createTaskLineage, withTaskLineageTransaction } from "./task-lineage.js";
import {
  artifactRefFromBytes,
  artifactRefV1Schema,
  canonicalJsonBytes,
  sha256Bytes,
  type ArtifactRefV1,
} from "./context-contracts.js";
import {
  DEFAULT_RESOURCE_BUDGET_V1,
  resourceBudgetPolicyV1Schema,
  type ResourceBudgetPolicyV1,
} from "./resource-budget.js";
import {
  approvalSha256,
  buildPlanApprovalRequest,
  canonicalApprovalJson,
  planApprovalRequestPath,
  planDecisionContractSha256,
  readVerifiedPlanApprovalRequest,
  requestSha256,
  serializePlanApprovalRequest,
  writePlanApprovalRequest,
} from "./plan-approval.js";
import { parsePersistedPlan, serializePersistedPlan, validateDiscoveryCoverage } from "./execution-spec.js";
import {
  RUN_CONFIGURATION_PATH,
  reconstructHistoricalRunConfiguration,
  resolvedRunConfigurationSchema,
  runConfigurationSha256,
  serializeRunConfiguration,
  type ResolvedRunConfiguration,
} from "./run-configuration.js";
import { assertApprovalControllerMatches } from "./controller-provenance.js";
import { buildPlanDelta } from "./plan-delta.js";
import { currentExecutionAuthority } from "./execution-context.js";

export interface CreateRunLedgerInput {
  repoRoot: string;
  originalRequest: string;
  slug: string;
  now?: Date;
}

export interface RunLedger {
  runId: string;
  runDir: string;
  manifest: RunManifest;
}

/** Backwards-compatible aliases for the v2 ledger API names. */
export type PlanRevisionRecord = RunManifestV2["plan_revisions"][string];
export type { WorkItemProgress } from "./types.js";
export type RunManifestV2Ledger = RunManifestV2;

const claimedInitialPlanCandidateSchema = z.object({
  invocation_id: z.string().uuid(),
  artifact_name: z.string().min(1),
  approved_discovery_brief_revision: z.number().int().positive().nullable(),
  approved_discovery_brief_sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  plan_text: z.string().min(1),
  artifacts: z.object({
    "research.md": z.string(),
    "research-sources.json": z.string(),
    "architecture-plan.md": z.string(),
    "work-items.json": z.string(),
  }).strict(),
}).strict();

export type ClaimedInitialPlanCandidate = z.infer<typeof claimedInitialPlanCandidateSchema>;
export type MutableRunManifestV2Patch = Partial<Omit<
  RunManifestV2Ledger,
  "review_policy_snapshot" | "warning_continuation_authority" | "release_guards" | "review_accounting" | "controller_provenance" | "task_lineage" | "terminal" | "legacy_github_restore" | "pending_plan_approval" | "approval_protocol_version" | "approval_protocol_start_revision" | "run_configuration_sha256" | "execution_epoch" | "execution_lease"
>>;

export interface RunLedgerTransaction {
  runDir: string;
  readManifestV2(): Promise<RunManifestV2Ledger>;
  updateManifestV2(patch: MutableRunManifestV2Patch): Promise<RunManifestV2Ledger>;
  updateReviewAccounting(
    expected: ReviewAccounting,
    next: ReviewAccounting,
    progressReference?: {
      work_item_id: string;
      review_revision: number;
      review_cycle_path: string;
      review_effect_id: string;
      attempts: number;
      review_path: string;
      verification_path: string;
    },
    qualityRecoveryWorkItemIds?: readonly string[],
  ): Promise<ReviewAccounting>;
  approvePlanRevision(
    expectedAccounting: ReviewAccounting,
    revision: number,
    planRevisions: RunManifestV2Ledger["plan_revisions"],
    warningAuthority?: RunManifestV2Ledger["warning_continuation_authority"],
  ): Promise<RunManifestV2Ledger>;
  approveReplanRevision(input: {
    base_revision: number;
    revision: number;
    work_item_id: string;
    expected_progress: RunManifestV2Ledger["work_item_progress"][string];
    next_progress: RunManifestV2Ledger["work_item_progress"][string];
    source_work_item_id?: string;
    expected_source_progress?: RunManifestV2Ledger["work_item_progress"][string];
    next_source_progress?: RunManifestV2Ledger["work_item_progress"][string];
    plan_revisions: RunManifestV2Ledger["plan_revisions"];
  }): Promise<RunManifestV2Ledger>;
  commitInitialPlanApprovalBoundary(input: {
    revision: PlanRevision;
    pending: PendingPlanApprovalV1;
    expected_manifest: RunManifestV2Ledger;
  }): Promise<RunManifestV2Ledger>;
  commitPreparedPlanApprovalBoundary(input: {
    base_revision: number;
    proposed_revision: number;
    revision: PlanRevision;
    pending: PendingPlanApprovalV1;
    expected_manifest: RunManifestV2Ledger;
    run_configuration_sha256: string;
    canonical_blocker: string;
  }): Promise<RunManifestV2Ledger>;
  rejectPreparedPlanApprovalBoundary(input: {
    revision: number;
    rejection_path: string;
    rejection_sha256: string;
    blocker: string;
  }): Promise<RunManifestV2Ledger>;
  recordTerminalDisposition(disposition: TerminalDisposition): Promise<RunManifestV2Ledger>;
  acquireExecutionLease(input: { invocation_id: string; mode: ExecutionLeaseV1["mode"] }): Promise<ExecutionLeaseClaim>;
  assertExecutionLease(claim: ExecutionLeaseClaim): Promise<void>;
  releaseExecutionLease(claim: ExecutionLeaseClaim): Promise<RunManifestV2Ledger>;
  beginExecutionEffect(claim: ExecutionLeaseClaim, kind: string, invocationId: string): Promise<void>;
  recordExecutionEffectChild(claim: ExecutionLeaseClaim, invocationId: string, pid: number | null): Promise<void>;
  endExecutionEffect(claim: ExecutionLeaseClaim, invocationId: string): Promise<void>;
  setRunCheckoutIdentity(
    claim: ExecutionLeaseClaim,
    checkout: { worktreePath: string; branchName: string },
  ): Promise<RunManifestV2Ledger>;
  markRunCheckoutReady(claim: ExecutionLeaseClaim): Promise<RunManifestV2Ledger>;
}

export interface RunLedgerTransactionHooks {
  afterLockDirectoryCreated?: (lockPath: string) => Promise<void>;
  beforeManifestPhase?: (phase: "write" | "sync" | "close" | "rename") => Promise<void>;
  afterPlanApprovalManifestPersisted?: () => Promise<void>;
  afterQuarantineRename?: () => Promise<void>;
  afterQuarantineValidation?: () => Promise<void>;
  beforeQuarantineRemoval?: () => Promise<void>;
}

export type ApprovalControllerCapture = (
  repoRoot: string,
) => Promise<{ provenance: ControllerProvenance; selfHosting: boolean }>;

export interface RunLedgerV2 {
  runId: string;
  runDir: string;
  manifest: RunManifestV2Ledger;
}

export interface CreateRunLedgerV2Input {
  repoRoot?: string;
  repo_root?: string;
  originalRequest?: string;
  original_request?: string;
  task?: string;
  slug?: string;
  now?: Date;
  mode?: RunMode;
  runMode?: RunMode;
  roleProfiles?: Partial<Record<RoleName, RoleProfile>>;
  roles?: Partial<Record<RoleName, RoleProfile>>;
  selectedRoleProfiles?: Partial<Record<RoleName, RoleProfile>>;
  selected_role_profiles?: Partial<Record<RoleName, RoleProfile>>;
  intake?: RunIntake | ResolvedRunIntake;
  sourceCommit?: string | null;
  sourceCommitSha?: string | null;
  source_commit?: string | null;
  controllerProvenance?: RunManifestV2["controller_provenance"];
  runConfiguration?: ResolvedRunConfiguration;
  worktreePath?: string | null;
  worktree_path?: string | null;
  branchName?: string | null;
  branch_name?: string | null;
  githubIds?: {
    issueNumbers?: number[];
    pullRequestNumbers?: number[];
  };
  github_ids?: {
    issue_numbers?: number[];
    pull_request_numbers?: number[];
  };
  finalArtifactPaths?: string[];
  final_artifact_paths?: string[];
  runId?: string;
  taskLineage?: TaskLineageV1;
  /** Tests only. Production callers must let the controller generate this UUID. */
  taskLineageId?: string;
  resourceBudgetPolicy?: ResourceBudgetPolicyV1;
  resource_budget_policy?: ResourceBudgetPolicyV1;
}

export interface RunEventInput {
  eventId?: string;
  actor: string;
  stage?: RunStageV2;
  type?: string;
  timestamp?: string;
  payload?: Record<string, unknown>;
}

export type RunEventRecord = RunEvent;

export interface TransitionRunOptions {
  actor?: string;
  payload?: Record<string, unknown>;
}

function v2InputValues(input: CreateRunLedgerV2Input): {
  repoRoot: string;
  originalRequest: string;
  mode: RunMode;
  roleProfiles: Partial<Record<RoleName, RoleProfile>>;
  intake: RunIntake | ResolvedRunIntake;
} {
  const intake = input.intake;
  const repoRoot = input.repoRoot ?? input.repo_root ?? intake?.repo_root;
  const originalRequest = input.originalRequest ?? input.original_request ?? input.task ?? intake?.task;
  if (!repoRoot || !originalRequest) {
    throw new Error("repoRoot and originalRequest are required to create a v2 run ledger");
  }

  const mode = input.mode ?? input.runMode ?? intake?.mode ?? "local";
  const roleProfiles =
    input.roleProfiles ?? input.roles ?? input.selectedRoleProfiles ?? input.selected_role_profiles ??
    ("roles" in (intake ?? {}) ? (intake as ResolvedRunIntake).roles : {});
  return { repoRoot, originalRequest, mode, roleProfiles, intake: intake ?? { task: originalRequest, repo_root: repoRoot } };
}

function resolveAndValidateArtifactPath(runDir: string, relativePath: string): string {
  if (isAbsolute(relativePath)) {
    throw new Error("Artifact path must be a relative path");
  }

  if (relativePath.trim() === "") {
    throw new Error("Artifact path must be a non-empty relative path");
  }

  const normalizedRunDir = resolve(runDir);
  const candidate = resolve(normalizedRunDir, relativePath);
  const relation = relative(normalizedRunDir, candidate);

  if (relation === "" || !relation.startsWith("..")) {
    return candidate;
  }

  throw new Error("Artifact path must resolve inside the run directory");
}

/**
 * Fail closed before a verification attempt can overwrite a namespace that
 * already contains artifacts. New attempts must use a fresh directory; a
 * resumed attempt loads its persisted evidence instead of writing again.
 */
export async function assertVerificationNamespaceAvailable(
  runDir: string,
  identity: VerificationIdentity,
  attempt: number,
  options: { allowExistingAttempt?: boolean; allowInProgressAttempt?: boolean } = {},
): Promise<void> {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new Error("Verification attempt must be a positive integer");
  }

  const identityDirectory = verificationIdentityDirectory(identity);
  const relativePath = `${identityDirectory}/attempt-${attempt}`;
  const root = resolve(runDir);
  const identityRoot = join(root, identityDirectory);

  const markerName = "identity.json";
  const attemptPrefix = `${identityDirectory}/attempt-${attempt}/`;

  const collectFiles = async (directory: string, prefix = ""): Promise<string[]> => {
    const entries = await readdir(directory, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      const relativeEntry = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absoluteEntry = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Verification namespace cannot contain a symbolic link: ${identityDirectory}/${relativeEntry}`);
      }
      if (entry.isDirectory()) {
        files.push(...await collectFiles(absoluteEntry, relativeEntry));
      } else if (entry.isFile()) {
        files.push(relativeEntry);
      } else {
        throw new Error(`Verification namespace contains an unsupported entry: ${identityDirectory}/${relativeEntry}`);
      }
    }
    return files;
  };

  const parseIdentityMarker = async (attemptRoot: string, markerAttempt: number): Promise<{ artifact_paths: string[] }> => {
    const markerPrefix = `${identityDirectory}/attempt-${markerAttempt}/`;
    let marker: unknown;
    try {
      marker = JSON.parse(await readFile(join(attemptRoot, markerName), "utf8")) as unknown;
    } catch (error) {
      throw new Error(`Verification namespace identity marker is unreadable: ${identityDirectory}/${markerName}`, { cause: error });
    }
    if (!marker || typeof marker !== "object") {
      throw new Error(`Verification namespace identity marker is invalid: ${identityDirectory}/${markerName}`);
    }
    const value = marker as {
      verification_scope?: unknown;
      work_item_id?: unknown;
      issue_number?: unknown;
      attempt?: unknown;
      artifact_paths?: unknown;
    };
    const issueMatches = identity.scope === "github"
      ? value.issue_number === identity.issue_number
      : value.issue_number === undefined;
    if (value.verification_scope !== identity.scope || value.work_item_id !== identity.work_item_id || !issueMatches || value.attempt !== markerAttempt) {
      throw new Error(`Verification namespace identity marker belongs to a different identity: ${identityDirectory}/attempt-${markerAttempt}/${markerName}`);
    }
    if (!Array.isArray(value.artifact_paths) || !value.artifact_paths.every((path): path is string => typeof path === "string")) {
      throw new Error(`Verification namespace identity marker has invalid artifacts: ${identityDirectory}/attempt-${markerAttempt}/${markerName}`);
    }
    for (const path of value.artifact_paths) {
      artifactPathSchema.parse(path);
      if (!path.startsWith(markerPrefix) || path === `${markerPrefix}evidence.json` || path === `${markerPrefix}${markerName}`) {
        throw new Error(`Verification namespace identity marker contains a foreign artifact: ${path}`);
      }
    }
    return { artifact_paths: value.artifact_paths };
  };

  const declaredEvidenceFiles = (evidence: VerificationEvidence, expectedPrefix: string): string[] => {
    const files = ["evidence.json", markerName];
    const addPath = (path: string | null | undefined, label: string): void => {
      if (path === null || path === undefined) return;
      if (!path.startsWith(expectedPrefix)) {
        throw new Error(`Verification namespace ${label} does not match: ${path}`);
      }
      const relativePath = path.slice(expectedPrefix.length);
      artifactPathSchema.parse(path);
      if (relativePath.length === 0 || relativePath.split("/").some((segment) => segment === "." || segment === "..")) {
        throw new Error(`Verification namespace ${label} is not identity-owned: ${path}`);
      }
      files.push(relativePath);
    };
    for (const command of evidence.commands) {
      addPath(command.stdout_path, "command provenance");
      addPath(command.stderr_path, "command provenance");
      addPath(command.result_path, "command provenance");
    }
    for (const browser of evidence.browser_evidence) {
      addPath(browser.screenshot_artifact, "browser screenshot provenance");
      addPath(browserEvidenceReportPathForIdentity(evidence, browser, expectedPrefix), "browser report provenance");
    }
    return files;
  };

  let current = root;
  for (const segment of identityDirectory.split("/")) {
    current = join(current, segment);
    try {
      const entry = await lstat(current);
      if (entry.isSymbolicLink()) {
        throw new Error(`Verification namespace cannot contain a symbolic link: ${identityDirectory}`);
      }
      if (!entry.isDirectory()) {
        throw new Error(`Verification namespace path is not a directory: ${identityDirectory}`);
      }
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
      throw error;
    }
  }

  const entries = await readdir(identityRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!/^attempt-\d+$/.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error(`Verification namespace has ambiguous provenance: ${identityDirectory}`);
    }

    const existingAttempt = Number(entry.name.slice("attempt-".length));
    const attemptRoot = join(identityRoot, entry.name);
    const attemptFiles = await collectFiles(attemptRoot);
    if (attemptFiles.length === 0) {
      throw new Error(`Verification namespace has ambiguous provenance: ${identityDirectory}/${entry.name}`);
    }
    const hasEvidence = attemptFiles.includes("evidence.json");
    const hasMarker = attemptFiles.includes(markerName);
    if (existingAttempt === attempt && !options.allowExistingAttempt && !options.allowInProgressAttempt) {
      throw new Error(`Verification namespace already contains artifacts: ${relativePath}`);
    }
    if (existingAttempt === attempt && options.allowInProgressAttempt && hasEvidence) {
      throw new Error(`Verification namespace already contains artifacts: ${relativePath}`);
    }

    if (!hasEvidence) {
      if (existingAttempt !== attempt || !options.allowInProgressAttempt || !hasMarker) {
        throw new Error(existingAttempt === attempt
          ? `Verification namespace already contains artifacts: ${relativePath}`
          : `Verification namespace has ambiguous provenance: ${identityDirectory}/${entry.name}`);
      }
      const marker = await parseIdentityMarker(attemptRoot, attempt);
      const allowedFiles = new Set([markerName, ...marker.artifact_paths.map((path) => path.slice(attemptPrefix.length))]);
      if (attemptFiles.some((file) => !allowedFiles.has(file))) {
        throw new Error(`Verification namespace contains undeclared in-progress artifacts: ${identityDirectory}/${entry.name}`);
      }
      continue;
    }

    const evidenceEntry = attemptFiles.includes("evidence.json");
    if (!evidenceEntry) {
      throw new Error(`Verification namespace has ambiguous provenance: ${identityDirectory}/${entry.name}`);
    }

    let evidence: unknown;
    try {
      evidence = JSON.parse(await readFile(join(attemptRoot, "evidence.json"), "utf8")) as unknown;
    } catch (error) {
      throw new Error(`Verification namespace evidence is unreadable: ${identityDirectory}/${entry.name}/evidence.json`, { cause: error });
    }
    const parsed = verificationEvidenceSchema.safeParse(evidence);
    if (!parsed.success) {
      throw new Error(`Verification namespace evidence has ambiguous provenance: ${identityDirectory}/${entry.name}/evidence.json`);
    }
    const parsedEvidence = parsed.data;
    const expectedEvidencePath = `${identityDirectory}/${entry.name}/evidence.json`;
    const issueMatches = identity.scope === "github"
      ? "issue_number" in parsedEvidence && parsedEvidence.issue_number === identity.issue_number
      : !("issue_number" in parsedEvidence);
    const identityMatches = parsedEvidence.verification_scope === identity.scope
      && parsedEvidence.work_item_id === identity.work_item_id
      && parsedEvidence.evidence_path === expectedEvidencePath
      && parsedEvidence.attempt === existingAttempt
      && issueMatches;
    if (!identityMatches) {
      throw new Error(`Verification namespace evidence belongs to a different identity: ${identityDirectory}/${entry.name}/evidence.json`);
    }

    const expectedPrefix = `${identityDirectory}/${entry.name}/`;
    const declaredFiles = declaredEvidenceFiles(parsedEvidence, expectedPrefix);
    if (hasMarker) {
      const marker = await parseIdentityMarker(attemptRoot, existingAttempt);
      declaredFiles.push(...marker.artifact_paths);
    }
    const allDeclaredEntries = new Set(declaredFiles.map((path) => path.startsWith(expectedPrefix) ? path.slice(expectedPrefix.length) : path));
    if (attemptFiles.some((candidate) => !allDeclaredEntries.has(candidate))) {
      throw new Error(`Verification namespace contains undeclared artifacts: ${identityDirectory}/${entry.name}`);
    }
  }

  const target = join(identityRoot, `attempt-${attempt}`);
  try {
    const targetEntry = await lstat(target);
    if (targetEntry.isSymbolicLink() || !targetEntry.isDirectory()) {
      throw new Error(`Verification namespace path is not a directory: ${relativePath}`);
    }
    if (options.allowExistingAttempt || options.allowInProgressAttempt) return;
    throw new Error(`Verification namespace already contains artifacts: ${relativePath}`);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
}

interface RunLedgerLockOwner {
  token: string;
  pid: number;
  hostname: string;
  process_started_at: string;
  created_at: string;
}

function newLockOwner(): RunLedgerLockOwner {
  return {
    token: randomUUID(),
    pid: process.pid,
    hostname: hostname(),
    process_started_at: processStartedAt,
    created_at: new Date().toISOString(),
  };
}

interface DirectoryIdentity {
  path: string;
  realPath: string;
  dev: number;
  ino: number;
}

const noFollow = constants.O_NOFOLLOW ?? 0;
const processStartedAt = new Date(Date.now() - process.uptime() * 1_000).toISOString();
const activeTransaction = new AsyncLocalStorage<{
  transaction: RunLedgerTransaction;
  active: boolean;
  enqueueCompound: <T>(operation: () => Promise<T>) => Promise<T>;
}>();
type CoordinatedTerminalWriter = (
  disposition: TerminalDisposition,
  githubCleanup: GithubCleanupBatch | null,
) => Promise<RunManifestV2Ledger>;
const coordinatedTerminalWriters = new WeakMap<RunLedgerTransaction, CoordinatedTerminalWriter>();
type LegacyRestoreWriter = (operation:
  | { kind: "migrate"; lineageId: string }
  | { kind: "consume"; lineageId: string; planRevision: number; planSha256: string }
) => Promise<RunManifestV2Ledger>;
const legacyRestoreWriters = new WeakMap<RunLedgerTransaction, LegacyRestoreWriter>();

function recordCoordinatedTerminalDisposition(
  transaction: RunLedgerTransaction,
  disposition: TerminalDisposition,
  githubCleanup: GithubCleanupBatch | null,
): Promise<RunManifestV2Ledger> {
  const writer = coordinatedTerminalWriters.get(transaction);
  if (!writer) throw new Error("Coordinated terminal writer requires an active module-owned transaction capability");
  return writer(disposition, githubCleanup);
}
const activeCompound = new AsyncLocalStorage<{
  runDir: string;
  active: boolean;
}>();
const ownerlessStaleMs = 30_000;
const ownerlessGraceMs = 100;
const topLevelRunQueues = new Map<string, ReturnType<typeof serialQueue>>();

function executionAuthoritySha256(manifest: RunManifestV2Ledger): string {
  // Bind the entire runtime manifest, including every model/policy/role field
  // and the complete lease-control proof. Only the digest itself is normalized
  // to avoid recursion. Any out-of-transaction byte-level authority mutation
  // therefore fails before the next effect or reclaim decision.
  const normalized = {
    ...manifest,
    execution_lease: manifest.execution_lease === null || manifest.execution_lease === undefined
      ? null
      : { ...manifest.execution_lease, authority_sha256: "0".repeat(64) },
  };
  return createHash("sha256").update(canonicalApprovalJson(normalized)).digest("hex");
}

function assertLeaseClaimMatches(manifest: RunManifestV2Ledger, claim: ExecutionLeaseClaim): ExecutionLeaseV1 {
  const lease = manifest.execution_lease ?? null;
  if (lease === null || lease.token !== claim.token) throw new Error("Execution lease token does not match the active run owner");
  if (lease.epoch !== claim.epoch || lease.owner.invocation_id !== claim.invocationId) {
    throw new Error("Execution lease epoch or invocation does not match the active run owner");
  }
  if (lease.authority_sha256 !== executionAuthoritySha256(manifest)) {
    throw new Error("Execution lease authority changed outside its manifest compare-and-set");
  }
  return lease;
}

function preparedBoundarySnapshotMatches(
  current: RunManifestV2Ledger,
  expected: RunManifestV2Ledger,
): boolean {
  if (JSON.stringify(current) === JSON.stringify(expected)) return true;
  const claim = currentExecutionAuthority()?.claim;
  if (!claim) return false;
  let currentLease: ExecutionLeaseV1;
  try {
    currentLease = assertLeaseClaimMatches(current, claim);
  } catch {
    return false;
  }
  const expectedLease = expected.execution_lease ?? null;
  if (expectedLease === null
    || expectedLease.token !== currentLease.token
    || expectedLease.epoch !== currentLease.epoch
    || expectedLease.mode !== currentLease.mode
    || expectedLease.owner.invocation_id !== currentLease.owner.invocation_id
    || JSON.stringify(expectedLease.owner) !== JSON.stringify(currentLease.owner)
    || expectedLease.active_effect !== null
    || currentLease.active_effect !== null
    || expectedLease.authority_sha256 !== executionAuthoritySha256(expected)) {
    return false;
  }
  const normalizeOwnedLeaseInternals = (manifest: RunManifestV2Ledger): RunManifestV2Ledger => ({
    ...manifest,
    updated_at: "",
    execution_epoch: 0,
    execution_lease: manifest.execution_lease === null || manifest.execution_lease === undefined
      ? null
      : {
          ...manifest.execution_lease,
          heartbeat_at: "",
          authority_sha256: "0".repeat(64),
        },
  });
  return JSON.stringify(normalizeOwnedLeaseInternals(current))
    === JSON.stringify(normalizeOwnedLeaseInternals(expected));
}

function pidIsProvablyDead(pid: number, ownerHost: string): boolean {
  if (ownerHost !== hostname()) return false;
  if (pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error: unknown) {
    return errorCode(error) === "ESRCH";
  }
}

function childInvocationIsProvablyDead(pid: number, ownerHost: string): boolean {
  if (!pidIsProvablyDead(pid, ownerHost)) return false;
  // Node does not expose Windows Job Objects, so a dead wrapper PID cannot
  // prove its descendant tree is gone. Automatic completion/reclaim is
  // intentionally fail-closed on Windows until the runtime owns a job handle.
  if (process.platform === "win32") return false;
  try {
    // Runtime-spawned effects are isolated as process-group leaders. A dead
    // wrapper PID is insufficient while any descendant in its group survives.
    process.kill(-pid, 0);
    return false;
  } catch (error: unknown) {
    return errorCode(error) === "ESRCH";
  }
}

function executionLeaseCanBeReclaimed(lease: ExecutionLeaseV1): boolean {
  if (!pidIsProvablyDead(lease.owner.pid, lease.owner.hostname)) return false;
  const effect = lease.active_effect;
  if (effect === null) return true;
  return effect.child_pids.length > 0 && effect.child_pids.every((pid) => childInvocationIsProvablyDead(pid, effect.hostname));
}

function errorCode(error: unknown): unknown {
  return error && typeof error === "object" && "code" in error ? error.code : undefined;
}

function serialQueue(): <T>(operation: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(operation, operation);
    tail = result.then(() => undefined, () => undefined);
    return result;
  };
}

async function fsyncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | noFollow);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function assertRegularFile(path: string, label: string): Promise<void> {
  const status = await lstat(path);
  if (status.isSymbolicLink()) throw new Error(`${label} must not be a symlink`);
  if (!status.isFile()) throw new Error(`${label} must be a regular file`);
}

async function captureDirectoryIdentity(path: string, label: string): Promise<DirectoryIdentity> {
  const status = await lstat(path);
  if (status.isSymbolicLink()) throw new Error(`${label} must not be a symlink`);
  if (!status.isDirectory()) throw new Error(`${label} must be a directory`);
  return { path, realPath: await realpath(path), dev: status.dev, ino: status.ino };
}

async function assertDirectoryIdentity(identity: DirectoryIdentity, label: string): Promise<void> {
  const current = await captureDirectoryIdentity(identity.path, label);
  if (
    current.dev !== identity.dev
    || current.ino !== identity.ino
    || current.realPath !== identity.realPath
  ) throw new Error(`${label} identity changed during file access`);
}

async function readJsonNoFollow(
  path: string,
  label: string,
  parent?: DirectoryIdentity,
): Promise<unknown> {
  if (parent) await assertDirectoryIdentity(parent, `${label} parent directory`);
  await assertRegularFile(path, label);
  const handle = await open(path, constants.O_RDONLY | noFollow);
  try {
    const status = await handle.stat();
    if (!status.isFile()) throw new Error(`${label} must be a regular open file`);
    if (parent) {
      const openedRealPath = await realpath(path);
      if (dirname(openedRealPath) !== parent.realPath) {
        throw new Error(`${label} escaped its parent directory`);
      }
      await assertDirectoryIdentity(parent, `${label} parent directory`);
    }
    return JSON.parse(await handle.readFile("utf8")) as unknown;
  } finally {
    await handle.close();
  }
}

async function readBytesNoFollow(
  path: string,
  label: string,
  parent: DirectoryIdentity,
): Promise<Buffer> {
  await assertDirectoryIdentity(parent, `${label} parent directory`);
  await assertRegularFile(path, label);
  const handle = await open(path, constants.O_RDONLY | noFollow);
  try {
    const status = await handle.stat();
    if (!status.isFile()) throw new Error(`${label} must be a regular open file`);
    const openedRealPath = await realpath(path);
    if (dirname(openedRealPath) !== parent.realPath) {
      throw new Error(`${label} escaped its parent directory`);
    }
    await assertDirectoryIdentity(parent, `${label} parent directory`);
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

function processIsLive(owner: RunLedgerLockOwner): boolean {
  if (owner.hostname !== hostname()) return true;
  if (owner.pid === process.pid) return owner.process_started_at === processStartedAt;
  try {
    process.kill(owner.pid, 0);
    // A portable process-start identity is not available through Node. A live
    // foreign PID is therefore fail-closed rather than assumed to be its old owner.
    return true;
  } catch (error: unknown) {
    return errorCode(error) !== "ESRCH";
  }
}

async function readLockOwner(
  lockPath: string,
  identity?: DirectoryIdentity,
): Promise<RunLedgerLockOwner> {
  const parent = identity ?? await captureDirectoryIdentity(lockPath, "Run ledger lock");
  const value = await readJsonNoFollow(
    join(lockPath, "owner.json"),
    "Run ledger lock owner",
    parent,
  );
  return parseLockOwner(value);
}

function parseLockOwner(value: unknown): RunLedgerLockOwner {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
  ) throw new Error("Run ledger lock owner is invalid");
  const owner = value as Partial<RunLedgerLockOwner>;
  if (
    typeof owner.token !== "string"
    || typeof owner.pid !== "number"
    || !Number.isInteger(owner.pid)
    || owner.pid <= 0
    || typeof owner.hostname !== "string"
    || typeof owner.process_started_at !== "string"
    || typeof owner.created_at !== "string"
  ) throw new Error("Run ledger lock owner is invalid");
  return owner as RunLedgerLockOwner;
}

async function readRecoveryOwner(recoveryPath: string): Promise<RunLedgerLockOwner> {
  const parent = await captureDirectoryIdentity(recoveryPath, "Run ledger recovery");
  return parseLockOwner(await readJsonNoFollow(
    join(recoveryPath, "reclaimer.json"),
    "Run ledger recovery owner",
    parent,
  ));
}

async function createRecoveryOwner(recoveryPath: string, owner: RunLedgerLockOwner): Promise<void> {
  const identity = await captureDirectoryIdentity(recoveryPath, "Run ledger recovery");
  await assertDirectoryIdentity(identity, "Run ledger recovery");
  const target = join(recoveryPath, "reclaimer.json");
  const handle = await open(
    target,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
    0o600,
  );
  try {
    await assertDirectoryIdentity(identity, "Run ledger recovery");
    await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsyncDirectory(recoveryPath);
}

async function createLockOwner(
  lockPath: string,
  owner: RunLedgerLockOwner,
  identity: DirectoryIdentity,
): Promise<void> {
  await assertDirectoryIdentity(identity, "Run ledger lock directory");
  const ownerPath = join(lockPath, "owner.json");
  const handle = await open(
    ownerPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
    0o600,
  );
  try {
    const status = await handle.stat();
    if (!status.isFile()) throw new Error("Run ledger lock owner must be a regular file");
    const openedRealPath = await realpath(ownerPath);
    if (dirname(openedRealPath) !== identity.realPath) {
      throw new Error("Run ledger lock owner escaped its parent directory");
    }
    await assertDirectoryIdentity(identity, "Run ledger lock directory");
    await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsyncDirectory(lockPath);
}

async function readRawFileNoFollow(path: string): Promise<Buffer> {
  await assertRegularFile(path, "Run ledger owner diagnostic source");
  const handle = await open(path, constants.O_RDONLY | noFollow);
  try {
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function preserveLockDiagnostic(runDir: string, lockLikePath: string): Promise<void> {
  let bytes: Buffer;
  try {
    bytes = await readRawFileNoFollow(join(lockLikePath, "owner.json"));
  } catch (error: unknown) {
    if (errorCode(error) !== "ENOENT") throw error;
    bytes = Buffer.from(JSON.stringify({
      kind: "ownerless_lock",
      path: basename(lockLikePath),
      preserved_at: new Date().toISOString(),
    }));
  }
  const diagnosticPath = join(runDir, `.ledger.lock.owner-diagnostic-${randomUUID()}`);
  const handle = await open(
    diagnosticPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
    0o600,
  );
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsyncDirectory(runDir);
}

const recoveryPrefix = ".ledger.lock.recovery-";

async function recoveryPaths(runDir: string): Promise<string[]> {
  return (await readdir(runDir, { withFileTypes: true }))
    .filter((entry) => entry.name.startsWith(recoveryPrefix))
    .map((entry) => join(runDir, entry.name))
    .sort();
}

async function finishRecovery(
  runDir: string,
  recoveryPath: string,
  staleStateAlreadyProven = false,
): Promise<void> {
  const lockPath = join(runDir, ".ledger.lock");
  let originalOwner: RunLedgerLockOwner | null = null;
  let malformed = false;
  try {
    originalOwner = await readLockOwner(recoveryPath);
  } catch (error: unknown) {
    malformed = errorCode(error) !== "ENOENT";
  }
  const status = await lstat(recoveryPath);
  const ownerTime = originalOwner === null ? Number.NaN : Date.parse(originalOwner.created_at);
  const ageMs = Date.now() - (Number.isFinite(ownerTime) ? ownerTime : Number(status.mtimeMs));
  if (originalOwner !== null && (processIsLive(originalOwner) || ageMs < ownerlessStaleMs)) {
    await rm(join(recoveryPath, "reclaimer.json"), { force: true });
    await rename(recoveryPath, lockPath);
    await fsyncDirectory(runDir);
    return;
  }
  if (!staleStateAlreadyProven && ageMs < ownerlessStaleMs) {
    throw new Error(`Fresh ${malformed ? "malformed" : "ownerless"} recovery remains blocked`);
  }
  await preserveLockDiagnostic(runDir, recoveryPath);
  await rm(recoveryPath, { recursive: true });
  await fsyncDirectory(runDir);
}

async function recoverTokenizedDirectory(runDir: string, recoveryPath: string): Promise<"wait" | "recovered"> {
  const status = await lstat(recoveryPath).catch((error: unknown) => {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  });
  if (status === null) return "recovered";
  if (status.isSymbolicLink() || !status.isDirectory()) {
    throw new Error("Run ledger recovery barrier must be a real directory");
  }
  let reclaimer: RunLedgerLockOwner | null = null;
  let malformed = false;
  try {
    reclaimer = await readRecoveryOwner(recoveryPath);
  } catch (error: unknown) {
    malformed = errorCode(error) !== "ENOENT";
  }
  const reclaimerTime = reclaimer === null ? Number.NaN : Date.parse(reclaimer.created_at);
  const ageMs = Date.now() - (Number.isFinite(reclaimerTime) ? reclaimerTime : Number(status.mtimeMs));
  if (reclaimer !== null && processIsLive(reclaimer)) {
    if (reclaimer.hostname !== hostname() || reclaimer.pid !== process.pid) {
      throw new Error("Live run ledger recovery owner cannot be stolen");
    }
    return "wait";
  }
  if (ageMs < ownerlessStaleMs) {
    if (ageMs < ownerlessGraceMs && reclaimer === null && !malformed) return "wait";
    throw new Error(`Fresh ${malformed ? "malformed" : "ambiguous"} recovery cannot be stolen`);
  }

  const takeoverPath = join(runDir, `${recoveryPrefix}${randomUUID()}`);
  try {
    await rename(recoveryPath, takeoverPath);
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") return "recovered";
    throw error;
  }
  await fsyncDirectory(runDir);
  await rm(join(takeoverPath, "reclaimer.json"), { force: true });
  await createRecoveryOwner(takeoverPath, newLockOwner());
  await finishRecovery(runDir, takeoverPath, true);
  return "recovered";
}

async function acquireRunLedgerLock(
  runDir: string,
  hooks: RunLedgerTransactionHooks,
): Promise<() => Promise<void>> {
  const lockPath = join(runDir, ".ledger.lock");
  const owner = newLockOwner();
  const deadline = Date.now() + 5_000;

  while (true) {
    const barriers = await recoveryPaths(runDir);
    if (barriers.length > 0) {
      const result = await recoverTokenizedDirectory(runDir, barriers[0]!);
      if (result === "wait") await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
      continue;
    }
    try {
      await mkdir(lockPath, { mode: 0o700 });
      const createdIdentity = await captureDirectoryIdentity(lockPath, "Run ledger lock");
      await hooks.afterLockDirectoryCreated?.(lockPath);
      try {
        await createLockOwner(lockPath, owner, createdIdentity);
        await fsyncDirectory(runDir);
      } catch (error) {
        await rm(lockPath, { recursive: true, force: true });
        throw error;
      }
      const barriersAfterMkdir = await recoveryPaths(runDir);
      if (barriersAfterMkdir.length > 0) {
        const recorded = await readLockOwner(lockPath, createdIdentity);
        if (recorded.token !== owner.token) {
          throw new Error("New run ledger lock ownership changed behind recovery barrier");
        }
        await rm(lockPath, { recursive: true });
        await fsyncDirectory(runDir);
        continue;
      }
      break;
    } catch (error: unknown) {
      if (errorCode(error) !== "EEXIST") throw error;
      const status = await lstat(lockPath).catch((statError: unknown) => {
        if (errorCode(statError) === "ENOENT") return null;
        throw statError;
      });
      if (status === null) continue;
      if (status.isSymbolicLink()) throw new Error("Run ledger lock must not be a symlink");
      if (!status.isDirectory()) throw new Error("Run ledger lock must be a directory");

      let existingOwner: RunLedgerLockOwner | null = null;
      try {
        existingOwner = await readLockOwner(
          lockPath,
          await captureDirectoryIdentity(lockPath, "Run ledger lock"),
        );
      } catch (ownerError: unknown) {
        const ageMs = Date.now() - status.mtimeMs;
        if (ageMs < ownerlessGraceMs) {
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
          continue;
        }
        if (ageMs < ownerlessStaleMs) {
          if (errorCode(ownerError) === "ENOENT") {
            throw new Error("Fresh ownerless run ledger lock cannot be recovered safely");
          }
          throw ownerError;
        }
      }
      if (existingOwner !== null && processIsLive(existingOwner)) {
        if (Date.now() >= deadline) throw new Error("Timed out waiting for live run ledger lock owner");
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
        continue;
      }
      if (existingOwner !== null) {
        const createdAt = Date.parse(existingOwner.created_at);
        if (!Number.isFinite(createdAt)) {
          throw new Error("Run ledger lock owner created_at is invalid");
        }
        if (Date.now() - createdAt < ownerlessStaleMs) {
          throw new Error("Fresh dead run ledger lock cannot be recovered until it is stale");
        }
      }

      const recoveryPath = join(runDir, `${recoveryPrefix}${owner.token}`);
      await utimes(lockPath, new Date(), new Date());
      try {
        await rename(lockPath, recoveryPath);
      } catch (recoveryRenameError: unknown) {
        if (["ENOENT", "EEXIST", "ENOTEMPTY"].includes(String(errorCode(recoveryRenameError)))) {
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
          continue;
        }
        throw recoveryRenameError;
      }
      await fsyncDirectory(runDir);
      try {
        await hooks.afterQuarantineRename?.();
      } catch (hookError) {
        await createRecoveryOwner(recoveryPath, {
          ...owner,
          pid: 2_147_483_647,
          process_started_at: "2000-01-01T00:00:00.000Z",
          created_at: "2000-01-01T00:00:00.000Z",
        });
        throw hookError;
      }
      await createRecoveryOwner(recoveryPath, owner);
      let restoreLiveOwner = false;
      try {
        const recoveryStatus = await lstat(recoveryPath);
        if (recoveryStatus.dev !== status.dev || recoveryStatus.ino !== status.ino) {
          throw new Error("Run ledger recovery identity changed during stale recovery");
        }
        if (existingOwner !== null) {
          const recoveredOwner = await readLockOwner(
            recoveryPath,
            await captureDirectoryIdentity(recoveryPath, "Run ledger recovery"),
          );
          if (recoveredOwner.token !== existingOwner.token) {
            throw new Error("Run ledger owner token changed during stale recovery");
          }
          if (processIsLive(recoveredOwner)) {
            restoreLiveOwner = true;
          }
        }
      } catch (recoveryError) {
        const lockExists = await lstat(lockPath).then(() => true).catch(() => false);
        if (!lockExists) {
          await rm(join(recoveryPath, "reclaimer.json"), { force: true }).catch(() => undefined);
          await rename(recoveryPath, lockPath).catch(() => undefined);
          await fsyncDirectory(runDir);
        }
        throw recoveryError;
      }
      if (restoreLiveOwner) {
        await rm(join(recoveryPath, "reclaimer.json"), { force: true });
        await rename(recoveryPath, lockPath);
        await fsyncDirectory(runDir);
        continue;
      }
      try {
        await hooks.afterQuarantineValidation?.();
        await hooks.beforeQuarantineRemoval?.();
      } catch (hookError) {
        await rm(join(recoveryPath, "reclaimer.json"), { force: true });
        await createRecoveryOwner(recoveryPath, {
          ...owner,
          pid: 2_147_483_647,
          process_started_at: "2000-01-01T00:00:00.000Z",
          created_at: "2000-01-01T00:00:00.000Z",
        });
        throw hookError;
      }
      await preserveLockDiagnostic(runDir, recoveryPath);
      await rm(recoveryPath, { recursive: true });
      await fsyncDirectory(runDir);
    }
  }

  return async () => {
    let existing: RunLedgerLockOwner;
    try {
      existing = await readLockOwner(
        lockPath,
        await captureDirectoryIdentity(lockPath, "Run ledger lock"),
      );
    } catch (error: unknown) {
      if (errorCode(error) === "ENOENT") return;
      throw error;
    }
    if (existing.token !== owner.token) {
      throw new Error("Run ledger lock ownership changed before release");
    }
    await rm(lockPath, { recursive: true });
    await fsyncDirectory(runDir);
  };
}

function assertMutableManifestPatch(patch: MutableRunManifestV2Patch): void {
  if (Object.prototype.hasOwnProperty.call(patch, "remote_synchronization_path")
    && patch.remote_synchronization_path === undefined) {
    throw new Error("remote_synchronization_path cannot be explicitly undefined");
  }
  for (const field of [
    "review_policy_snapshot",
    "warning_continuation_authority",
    "release_guards",
    "review_accounting",
    "controller_provenance",
    "task_lineage",
    "terminal",
    "legacy_github_restore",
    "pending_plan_approval",
    "approval_protocol_version",
    "approval_protocol_start_revision",
    "run_configuration_sha256",
    "execution_epoch",
    "execution_lease",
  ] as const) {
    if (Object.prototype.hasOwnProperty.call(patch, field)) {
      throw new Error(`${field} is an immutable run snapshot`);
    }
  }
  for (const [canonicalField, aliasField] of [
    ["current_revision", "current_plan_revision"],
    ["approved_revision", "approved_plan_revision"],
  ] as const) {
    const hasCanonical = Object.prototype.hasOwnProperty.call(patch, canonicalField);
    const hasAlias = Object.prototype.hasOwnProperty.call(patch, aliasField);
    if (hasCanonical !== hasAlias || (hasCanonical && patch[canonicalField] !== patch[aliasField])) {
      throw new Error(`${canonicalField} and ${aliasField} revision aliases must be updated together with equal values`);
    }
  }
}

function strictlyLaterBoundary(updatedAt: string, previousBoundary: string | null): string {
  const previous = previousBoundary === null ? Number.NaN : Date.parse(previousBoundary);
  const next = Number.isFinite(previous) ? Math.max(Date.parse(updatedAt), previous + 1) : Date.parse(updatedAt);
  return new Date(next).toISOString();
}

function preserveIntegratedCommitBoundary(
  current: RunManifestV2Ledger,
  patch: MutableRunManifestV2Patch,
  updatedAt: string,
): MutableRunManifestV2Patch {
  const progressPatch = patch.work_item_progress;
  if (!progressPatch) return patch;
  const previous = current.work_item_progress.integrated;
  const previousCommit = typeof previous?.commit_sha === "string" ? previous.commit_sha.toLowerCase() : null;
  const incoming = progressPatch.integrated;
  if (!incoming) {
    if (previousCommit === null || !previous) return patch;
    return {
      ...patch,
      work_item_progress: { ...progressPatch, integrated: previous },
    };
  }
  const incomingCommit = typeof incoming.commit_sha === "string" ? incoming.commit_sha.toLowerCase() : null;
  const previousBoundary = typeof previous?.github_status_transition_at === "string"
    ? previous.github_status_transition_at
    : null;
  if (previousCommit !== null && incomingCommit === null && previous) {
    return {
      ...patch,
      work_item_progress: {
        ...patch.work_item_progress,
        integrated: {
          ...incoming,
          commit_sha: previous.commit_sha,
          ...(previousBoundary === null ? {} : { github_status_transition_at: previousBoundary }),
        },
      },
    };
  }
  if (incomingCommit === null) return patch;
  const incomingBoundary = typeof incoming.github_status_transition_at === "string"
    ? incoming.github_status_transition_at
    : null;
  const boundary = previousCommit === incomingCommit
    ? previousBoundary ?? incomingBoundary ?? updatedAt
    : previousCommit === null
      ? incomingBoundary ?? updatedAt
      : strictlyLaterBoundary(updatedAt, previousBoundary);
  return {
    ...patch,
    work_item_progress: {
      ...patch.work_item_progress,
      integrated: { ...incoming, github_status_transition_at: boundary },
    },
  };
}

function assertTerminalDispositionAllowed(current: RunManifestV2Ledger, disposition: TerminalDisposition): void {
  if (disposition.source_stage !== current.stage) {
    throw new Error(`Terminal source stage ${disposition.source_stage} does not match current stage ${current.stage}`);
  }
  if (disposition.outcome === "delivered") {
    if (disposition.actor !== "runtime") throw new Error("Delivered terminal outcomes must be recorded by the runtime");
    if (current.delivery_state !== "ready" && current.delivery_state !== "complete" && current.stage !== "complete") {
      throw new Error("Delivered terminal outcomes require durable delivery readiness");
    }
    return;
  }
  if (disposition.actor !== "human") throw new Error(`${disposition.outcome} terminal outcomes must be recorded by a human`);
  if (disposition.outcome === "human_accepted") {
    if (current.delivery_state !== "ready" && current.delivery_state !== "complete") {
      throw new Error("human_accepted requires durable delivery readiness");
    }
    return;
  }
  if (current.delivery_state === "ready" || current.delivery_state === "complete") {
    throw new Error(`Cannot record ${disposition.outcome} after successful delivery`);
  }
  if (disposition.outcome === "closed_blocked" && current.delivery_state !== "blocked") {
    throw new Error("closed_blocked requires a blocked delivery state");
  }
}

function assertTerminalManifestMutationAllowed(
  current: RunManifestV2Ledger,
  patch: MutableRunManifestV2Patch,
): void {
  if (current.terminal === null) return;
  const keys = Object.keys(patch);
  const reflectionIndexPath = "evidence-indexes/reflection/final.json";
  if (
    keys.length === 2
    && keys.includes("reflection_index_path")
    && keys.includes("final_artifact_paths")
    && (current.reflection_index_path === null || current.reflection_index_path === reflectionIndexPath)
    && patch.reflection_index_path === reflectionIndexPath
    && patch.final_artifact_paths?.includes(reflectionIndexPath)
  ) {
    if (!current.final_artifact_paths.every((path) => patch.final_artifact_paths!.includes(path))) {
      throw new Error("Terminal final artifacts are append-only");
    }
    const expectedArtifacts = [...new Set([...current.final_artifact_paths, reflectionIndexPath])];
    if (JSON.stringify(patch.final_artifact_paths) === JSON.stringify(expectedArtifacts)) return;
    throw new Error("Terminal reflection-index publication may append only the immutable index path");
  }
  if (keys.length === 1 && keys[0] === "final_artifact_paths" && patch.final_artifact_paths) {
    if (current.final_artifact_paths.every((path) => patch.final_artifact_paths!.includes(path))) return;
    const removedPaths = current.final_artifact_paths.filter((path) => !patch.final_artifact_paths!.includes(path));
    const singlePassReflectionArtifacts = [
      "reflection.json",
      "reflection.md",
      "responses/reflection-synthesis.json",
    ];
    if (
      current.workflow_protocol === "bounded-context-v1"
      && current.reflection_protocol === "single-pass-v1"
      && removedPaths.length > 0
      && removedPaths.every((path) =>
        path === reflectionIndexPath || path === "contexts/reflection/final.json")
      && singlePassReflectionArtifacts.every((path) => patch.final_artifact_paths!.includes(path))
    ) return;
    throw new Error("Terminal final artifacts are append-only");
  }
  if (current.terminal.outcome === "delivered" && keys.length === 1 && keys[0] === "stage") {
    if ((current.stage === "delivery" && patch.stage === "reflecting")
      || (current.stage === "reflecting" && patch.stage === "complete")) return;
  }
  if (keys.length === 1 && keys[0] === "github_cleanup" && patch.github_cleanup !== undefined) return;
  const authoritativeGithubProjectionFields = new Set([
    "issue_numbers", "work_item_issue_map", "github_ids", "pull_request_numbers", "branch_name", "github_effects",
  ]);
  if ((current.terminal.outcome === "delivered" || current.terminal.outcome === "human_accepted")
    && keys.length > 0 && keys.every((key) => authoritativeGithubProjectionFields.has(key))) return;
  throw new Error(`Cannot mutate run with terminal outcome ${current.terminal.outcome}`);
}

function assertGenericCheckoutMutationAllowed(
  current: RunManifestV2Ledger,
  patch: MutableRunManifestV2Patch,
): void {
  if (current.worktree_path !== null
    && patch.worktree_path !== undefined
    && patch.worktree_path !== null
    && resolve(patch.worktree_path) !== resolve(current.worktree_path)) {
    throw new Error("Immutable checkout identity cannot be changed by a generic manifest mutation");
  }
  if (current.branch_name !== null
    && patch.branch_name !== undefined
    && patch.branch_name !== null
    && patch.branch_name !== current.branch_name) {
    throw new Error("Immutable checkout identity cannot be changed by a generic manifest mutation");
  }
  if (current.source_commit !== null
    && patch.source_commit !== undefined
    && patch.source_commit !== current.source_commit) {
    throw new Error("Immutable checkout source commit cannot be changed by a generic manifest mutation");
  }
  if ((current.worktree_path !== null || current.branch_name !== null)
    && patch.checkout_allocation_state !== undefined) {
    throw new Error("Immutable checkout allocation state requires its dedicated transaction");
  }
}

function cleanupHash(targetNumbers: number[]): string {
  return createHash("sha256").update(JSON.stringify(targetNumbers)).digest("hex");
}

function assertGithubCleanupEvolution(
  previous: RunManifestV2Ledger,
  next: RunManifestV2Ledger,
): void {
  const before = previous.github_cleanup;
  const after = next.github_cleanup;
  if (before !== null && after === null) throw new Error("GitHub cleanup batch cannot be removed");
  const coordinatedGithub = next.mode === "github" && next.github_effects_protocol === "task-lineage-v1";
  const notPlannedTerminal = next.terminal?.outcome === "abandoned" || next.terminal?.outcome === "closed_blocked";
  if (after === null) {
    if (coordinatedGithub && notPlannedTerminal) {
      throw new Error("GitHub not-planned terminal disposition requires an atomic cleanup batch");
    }
    return;
  }
  if (!coordinatedGithub || next.task_lineage_id === null) {
    throw new Error("GitHub cleanup is valid only for a task-lineage GitHub run");
  }
  if (after.lineage_id !== next.task_lineage_id) {
    throw new Error("GitHub cleanup lineage ID must match the run manifest lineage ID");
  }
  if (!notPlannedTerminal || after.reason !== "not_planned") {
    throw new Error("A not-planned GitHub cleanup requires an abandoned or closed-blocked terminal disposition");
  }
  if (after.target_sha256 !== cleanupHash(after.target_numbers)) {
    throw new Error("GitHub cleanup target digest does not match its immutable target set");
  }
  const states = after.target_numbers.map((number) => after.target_states[String(number)]!);
  const expectedState = states.every((state) => state === "complete")
    ? "complete"
    : states.some((state) => state === "blocked") ? "blocked" : "pending";
  if (after.state !== expectedState || (after.completed_at !== null) !== (after.state === "complete")) {
    throw new Error("GitHub cleanup aggregate state does not match its target states");
  }
  if (before === null) {
    if (previous.terminal !== null
      || next.terminal?.outcome !== "abandoned" && next.terminal?.outcome !== "closed_blocked"
      || states.some((state) => state !== "pending")) {
      throw new Error("GitHub cleanup must begin atomically with a terminal not-planned disposition and every target pending");
    }
    return;
  }
  if (before.version !== after.version
    || before.lineage_id !== after.lineage_id
    || before.reason !== after.reason
    || before.target_sha256 !== after.target_sha256
    || before.started_at !== after.started_at
    || JSON.stringify(before.target_numbers) !== JSON.stringify(after.target_numbers)) {
    throw new Error("GitHub cleanup batch identity and target set are immutable");
  }
  for (const number of before.target_numbers) {
    const prior = before.target_states[String(number)]!;
    const current = after.target_states[String(number)]!;
    if (prior === "complete" && current !== "complete") {
      throw new Error(`Completed GitHub cleanup target #${number} cannot regress`);
    }
    if (prior === "blocked" && current === "pending") {
      throw new Error(`Blocked GitHub cleanup target #${number} cannot lose its blocker without completion`);
    }
  }
  if (before.completed_at !== null && after.completed_at !== before.completed_at) {
    throw new Error("GitHub cleanup completion timestamp is immutable");
  }
}

async function readManifestV2NoFollow(runDir: string): Promise<RunManifestV2Ledger> {
  const manifest = runManifestV2Schema.parse(
    await readJsonNoFollow(join(runDir, "manifest.json"), "Run manifest"),
  ) as RunManifestV2Ledger;
  assertTaskLineageIdentity(manifest.task_lineage);
  return manifest;
}

async function writeManifestV2Atomic(
  runDir: string,
  manifest: RunManifestV2Ledger,
  hooks: RunLedgerTransactionHooks,
): Promise<void> {
  const manifestPath = join(runDir, "manifest.json");
  await assertRegularFile(manifestPath, "Run manifest");
  const previous = runManifestV2Schema.parse(await readJsonNoFollow(manifestPath, "Run manifest")) as RunManifestV2Ledger;
  assertTaskLineageIdentity(previous.task_lineage);
  assertTaskLineageIdentity(manifest.task_lineage);
  if (JSON.stringify(manifest.task_lineage) !== JSON.stringify(previous.task_lineage)) {
    throw new Error("task_lineage is immutable and must remain byte-exact");
  }
  for (const scopeId of Object.keys(previous.recovery.scopes)) {
    if (!Object.prototype.hasOwnProperty.call(manifest.recovery.scopes, scopeId)) {
      throw new Error(`Recovery scope ${scopeId} cannot be removed`);
    }
  }
  for (const [scopeId, nextScope] of Object.entries(manifest.recovery.scopes)) {
    const priorScope = Object.prototype.hasOwnProperty.call(previous.recovery.scopes, scopeId)
      ? previous.recovery.scopes[scopeId]
      : undefined;
    if (priorScope === undefined) {
      if (nextScope.head_sequence !== 1 || nextScope.head_decision_path === null) {
        throw new Error(`First recovery head for scope ${scopeId} must start at sequence 1`);
      }
      continue;
    }
    const sequenceAdvance = nextScope.head_sequence - priorScope.head_sequence;
    if (sequenceAdvance < 0) {
      throw new Error(`Recovery head sequence for scope ${scopeId} cannot decrease`);
    }
    if (sequenceAdvance > 1) {
      throw new Error(`Recovery head sequence for scope ${scopeId} must advance by exactly one`);
    }
    if (sequenceAdvance === 0 && nextScope.head_decision_path !== priorScope.head_decision_path) {
      throw new Error(`Unchanged recovery head for scope ${scopeId} must keep the same decision path`);
    }
    if (sequenceAdvance === 1 && (
      nextScope.head_decision_path === null
      || nextScope.head_decision_path === priorScope.head_decision_path
    )) {
      throw new Error(`Advanced recovery head for scope ${scopeId} requires a new decision path`);
    }
  }
  const controllerAdvance = manifest.controller_recovery.transition_count
    - previous.controller_recovery.transition_count;
  if (controllerAdvance < 0) {
    throw new Error("Controller recovery transition count cannot decrease");
  }
  if (controllerAdvance > 1) {
    throw new Error("Controller recovery transition count must advance by exactly one");
  }
  if (controllerAdvance === 0
    && manifest.controller_recovery.head_path !== previous.controller_recovery.head_path) {
    throw new Error("Unchanged controller head must keep the same path");
  }
  if (controllerAdvance === 1 && (
    manifest.controller_recovery.head_path === null
    || manifest.controller_recovery.head_path === previous.controller_recovery.head_path
  )) {
    throw new Error("Advanced controller head requires a new path");
  }
  assertGithubCleanupEvolution(previous, manifest);
  if (manifest.abandonment_path !== null && (
    manifest.assurance_outcome !== "abandoned" || manifest.delivery_state !== "blocked"
  )) throw new Error("Abandonment requires an abandoned outcome and blocked delivery state");
  if (previous.abandonment_path !== null && (
    manifest.abandonment_path !== previous.abandonment_path
    || manifest.assurance_outcome !== "abandoned"
  )) throw new Error("Abandonment is immutable and cannot be cleared or replaced");
  if (previous.abandonment_path !== null && (
    manifest.stage !== previous.stage
    || manifest.delivery_state !== "blocked"
    || manifest.current_revision !== previous.current_revision
    || manifest.approved_revision !== previous.approved_revision
    || manifest.current_plan_revision !== previous.current_plan_revision
    || manifest.approved_plan_revision !== previous.approved_plan_revision
    || JSON.stringify(manifest.plan_revisions) !== JSON.stringify(previous.plan_revisions)
    || JSON.stringify(manifest.work_item_progress) !== JSON.stringify(previous.work_item_progress)
  )) throw new Error("Abandoned workflow state cannot advance or be replanned");
  if (manifest.risk_acceptance_history.length < previous.risk_acceptance_history.length
    || previous.risk_acceptance_history.some((path, index) => manifest.risk_acceptance_history[index] !== path)) {
    throw new Error("Risk-acceptance history is append-only");
  }
  if (manifest.risk_acceptance_path !== null
    && manifest.risk_acceptance_history.at(-1) !== manifest.risk_acceptance_path) {
    throw new Error("Active risk acceptance must be the latest history entry");
  }
  for (const [workItemId, progress] of Object.entries(manifest.work_item_progress)) {
    if (progress.status === "complete" && progress.attempts < 1) {
      const prior = previous.work_item_progress[workItemId];
      if (prior?.status !== "complete" || prior.attempts !== progress.attempts) {
        throw new Error(`Work item ${workItemId} cannot become complete without a real attempt`);
      }
    }
    if (
      manifest.workflow_protocol === "bounded-context-v1"
      && workItemId !== "integrated"
      && progress.status === "complete"
      && (!progress.summary_path || !progress.summary_sha256)
    ) {
      throw new Error(`Completed work item ${workItemId} requires an immutable summary`);
    }
  }
  const temporaryPath = join(runDir, `.manifest-${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  let renamed = false;
  try {
    handle = await open(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
      0o600,
    );
    await hooks.beforeManifestPhase?.("write");
    await handle.writeFile(JSON.stringify(manifest, null, 2), "utf8");
    await hooks.beforeManifestPhase?.("sync");
    await handle.sync();
    await hooks.beforeManifestPhase?.("close");
    await handle.close();
    handle = null;
    await hooks.beforeManifestPhase?.("rename");
    await rename(temporaryPath, manifestPath);
    renamed = true;
    await fsyncDirectory(runDir);
  } finally {
    if (handle) await handle.close().catch(() => undefined);
    if (!renamed) await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

export async function beginVerificationAttempt(
  runDir: string,
  identity: VerificationIdentity,
  attempt: number,
): Promise<void> {
  await assertVerificationNamespaceAvailable(runDir, identity, attempt, { allowInProgressAttempt: true });
  const identityDirectory = verificationIdentityDirectory(identity);
  const attemptDirectory = `${identityDirectory}/attempt-${attempt}`;
  const markerPath = join(resolve(runDir), attemptDirectory, "identity.json");
  try {
    await lstat(markerPath);
    return;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  await writeTextArtifact(runDir, `${attemptDirectory}/identity.json`, `${JSON.stringify({
    verification_scope: identity.scope,
    work_item_id: identity.work_item_id,
    ...(identity.scope === "github" ? { issue_number: identity.issue_number } : {}),
    attempt,
    artifact_paths: [],
  }, null, 2)}\n`);
}

export async function recordVerificationAttemptArtifacts(
  runDir: string,
  identity: VerificationIdentity,
  attempt: number,
  artifactPaths: string[],
): Promise<void> {
  const identityDirectory = verificationIdentityDirectory(identity);
  const attemptDirectory = `${identityDirectory}/attempt-${attempt}`;
  const prefix = `${attemptDirectory}/`;
  const root = resolve(runDir);
  const attemptRoot = join(root, attemptDirectory);
  const markerPath = join(attemptRoot, "identity.json");
  let marker: { artifact_paths: string[] };
  try {
    const parsed = JSON.parse(await readFile(markerPath, "utf8")) as { verification_scope?: unknown; work_item_id?: unknown; issue_number?: unknown; attempt?: unknown; artifact_paths?: unknown };
    const issueMatches = identity.scope === "github" ? parsed.issue_number === identity.issue_number : parsed.issue_number === undefined;
    if (parsed.verification_scope !== identity.scope || parsed.work_item_id !== identity.work_item_id || !issueMatches || parsed.attempt !== attempt || !Array.isArray(parsed.artifact_paths) || !parsed.artifact_paths.every((path): path is string => typeof path === "string")) {
      throw new Error(`Verification namespace identity marker belongs to a different identity: ${prefix}identity.json`);
    }
    marker = { artifact_paths: parsed.artifact_paths };
  } catch (error) {
    if (error instanceof Error && error.message.includes("belongs to a different identity")) throw error;
    throw new Error(`Verification namespace identity marker is unreadable: ${prefix}identity.json`, { cause: error });
  }

  for (const path of artifactPaths) {
    artifactPathSchema.parse(path);
    if (!path.startsWith(prefix) || path === `${prefix}identity.json` || path === `${prefix}evidence.json`) {
      throw new Error(`Verification artifact is outside its identity-owned attempt: ${path}`);
    }
  }
  const allowed = new Set(["identity.json", ...marker.artifact_paths.map((path) => path.slice(prefix.length)), ...artifactPaths.map((path) => path.slice(prefix.length))]);
  const files: string[] = [];
  const collect = async (directory: string, relativeDirectory = ""): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) throw new Error(`Verification namespace cannot contain a symbolic link: ${prefix}${relativeDirectory}${entry.name}`);
      const relativeEntry = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const absoluteEntry = join(directory, entry.name);
      if (entry.isDirectory()) await collect(absoluteEntry, `${relativeEntry}`);
      else if (entry.isFile()) files.push(relativeEntry);
      else throw new Error(`Verification namespace contains an unsupported entry: ${prefix}${relativeEntry}`);
    }
  };
  await collect(attemptRoot);
  if (files.includes("evidence.json") || files.some((file) => !allowed.has(file))) {
    throw new Error(`Verification namespace contains foreign artifacts: ${attemptDirectory}`);
  }
  const nextArtifacts = [...new Set([...marker.artifact_paths, ...artifactPaths])];
  await writeTextArtifact(runDir, `${attemptDirectory}/identity.json`, `${JSON.stringify({
    verification_scope: identity.scope,
    work_item_id: identity.work_item_id,
    ...(identity.scope === "github" ? { issue_number: identity.issue_number } : {}),
    attempt,
    artifact_paths: nextArtifacts,
  }, null, 2)}\n`);
}

export async function withRunLedgerTransaction<T>(
  runDir: string,
  operation: (transaction: RunLedgerTransaction) => Promise<T>,
  hooks: RunLedgerTransactionHooks = {},
): Promise<T> {
  const canonicalRequestedRunDir = realpathSync.native(resolve(runDir));
  const existing = activeTransaction.getStore();
  if (existing) {
    if (!existing.active) throw new Error("Nested run ledger transaction context is no longer active");
    if (existing.transaction.runDir !== canonicalRequestedRunDir) {
      throw new Error("Cross-run nested ledger transactions are not allowed");
    }
    return operation(existing.transaction);
  }
  let enqueueTopLevel = topLevelRunQueues.get(canonicalRequestedRunDir);
  if (!enqueueTopLevel) {
    enqueueTopLevel = serialQueue();
    topLevelRunQueues.set(canonicalRequestedRunDir, enqueueTopLevel);
  }
  return enqueueTopLevel(async () => {
    const canonicalRunDir = canonicalRequestedRunDir;
    const release = await acquireRunLedgerLock(canonicalRunDir, hooks);
    const enqueueUpdate = serialQueue();
    const enqueueCompound = serialQueue();
    let persistManifest!: (
      current: RunManifestV2Ledger,
      candidate: RunManifestV2Ledger,
      leasePolicy?: "preserve" | "release" | "pending_publication",
      explicitClaim?: ExecutionLeaseClaim,
    ) => Promise<RunManifestV2Ledger>;
    const persistTerminalDisposition = (
      disposition: TerminalDisposition,
      githubCleanup: GithubCleanupBatch | null | undefined,
      coordinated: boolean,
    ): Promise<RunManifestV2Ledger> => enqueueUpdate(async () => {
      const parsed = terminalDispositionSchema.parse(disposition) as TerminalDisposition;
      const current = await readManifestV2NoFollow(canonicalRunDir);
      const taskLineageGithub = current.mode === "github" && current.github_effects_protocol === "task-lineage-v1";
      if (taskLineageGithub !== coordinated) {
        throw new Error(taskLineageGithub
          ? "Task-lineage GitHub terminal disposition requires the coordinated cleanup API"
          : "Coordinated terminal persistence is valid only for a task-lineage GitHub run");
      }
      if (current.terminal !== null) {
        if (JSON.stringify(current.terminal) === JSON.stringify(parsed)
          && (githubCleanup === undefined || JSON.stringify(current.github_cleanup) === JSON.stringify(githubCleanup))) return current;
        throw new Error(`Run already has terminal outcome ${current.terminal.outcome}`);
      }
      assertTerminalDispositionAllowed(current, parsed);
      const next = runManifestV2Schema.parse({
        ...current,
        terminal: parsed,
        ...(githubCleanup === undefined ? {} : { github_cleanup: githubCleanup }),
        updated_at: new Date().toISOString(),
      }) as RunManifestV2Ledger;
      return persistManifest(current, next);
    });
    const persistLegacyRestore: LegacyRestoreWriter = (operation) => enqueueUpdate(async () => {
      const current = await readManifestV2NoFollow(canonicalRunDir);
      if (operation.kind === "migrate") {
        if (current.github_effects_protocol === "task-lineage-v1") {
          if (current.task_lineage_id !== operation.lineageId) throw new Error("Legacy migration lineage binding changed");
          return current;
        }
        if (current.github_effects_protocol !== "legacy-run-v1" || current.task_lineage_id !== null) {
          throw new Error("Legacy GitHub migration requires an unmigrated legacy manifest");
        }
        const restorableStages = new Set<RunStageV2>([
          "github_issue_sync", "implementing", "verifying", "verifier_review", "fixing", "replanning",
          "final_verification", "awaiting_github_delivery_effects", "delivery", "reflecting",
        ]);
        if (current.stage === "complete") throw new Error("Completed legacy runs cannot acquire producing restore authority");
        const planRevision = current.approved_revision ?? current.approved_plan_revision;
        const plan = planRevision === null ? undefined : current.plan_revisions[String(planRevision)];
        if (restorableStages.has(current.stage) && (!plan || plan.revision !== planRevision)) {
          throw new Error("Post-issue legacy GitHub migration requires an exact approved plan binding");
        }
        const authority = restorableStages.has(current.stage) ? {
          version: 1 as const,
          lineage_id: operation.lineageId,
          migration_run_id: current.run_id,
          plan_revision: planRevision!,
          plan_sha256: plan!.sha256,
          original_manifest_sha256: createHash("sha256").update(JSON.stringify(current)).digest("hex"),
          original_stage: current.stage as NonNullable<RunManifestV2["legacy_github_restore"]>["original_stage"],
        } : null;
        const next = runManifestV2Schema.parse({
          ...current,
          task_lineage_id: operation.lineageId,
          github_effects_protocol: "task-lineage-v1",
          legacy_github_restore: authority,
          ...(authority === null ? {} : { stage: "worktree_setup", delivery_state: "pending", last_blocker: null }),
          updated_at: new Date().toISOString(),
        }) as RunManifestV2Ledger;
        return persistManifest(current, next);
      }
      const authority = current.legacy_github_restore ?? null;
      if (authority === null) return current;
      if (current.github_effects_protocol !== "task-lineage-v1"
        || current.task_lineage_id !== operation.lineageId
        || authority.lineage_id !== operation.lineageId
        || authority.migration_run_id !== current.run_id
        || authority.plan_revision !== operation.planRevision
        || authority.plan_sha256 !== operation.planSha256
        || (current.approved_revision ?? current.approved_plan_revision) !== authority.plan_revision
        || current.plan_revisions[String(authority.plan_revision)]?.sha256 !== authority.plan_sha256) {
        throw new Error("Legacy restore authority does not match the current run, lineage, and plan");
      }
      if (current.stage !== "implementing") {
        throw new Error(`Legacy restore authority can only be consumed from implementing, got ${current.stage}`);
      }
      const deliverySourceStages = new Set<LegacyGithubRestoreAuthority["original_stage"]>([
        "awaiting_github_delivery_effects", "delivery", "reflecting",
      ]);
      const target = authority.original_stage === "github_issue_sync"
        ? "implementing"
        : deliverySourceStages.has(authority.original_stage) ? "final_verification" : authority.original_stage;
      const next = runManifestV2Schema.parse({
        ...current,
        stage: target,
        delivery_state: "pending",
        last_blocker: null,
        legacy_github_restore: null,
        updated_at: new Date().toISOString(),
      }) as RunManifestV2Ledger;
      return persistManifest(current, next);
    });
    persistManifest = async (
      current: RunManifestV2Ledger,
      candidate: RunManifestV2Ledger,
      leasePolicy: "preserve" | "release" | "pending_publication" = "preserve",
      explicitClaim?: ExecutionLeaseClaim,
    ): Promise<RunManifestV2Ledger> => {
      let next = { ...candidate, execution_epoch: (current.execution_epoch ?? 0) + 1 } as RunManifestV2Ledger;
      if ((current.execution_lease ?? null) !== null) {
        const contextualClaim = explicitClaim ?? currentExecutionAuthority()?.claim;
        if (!contextualClaim || contextualClaim.runDir !== canonicalRunDir) {
          throw new Error("An active execution lease blocks mutation by another invocation");
        }
        const lease = assertLeaseClaimMatches(current, contextualClaim);
        if (lease.active_effect !== null) {
          throw new Error("Manifest mutation is blocked while an external execution effect is active");
        }
        if (leasePolicy === "release") {
          next = { ...next, execution_lease: null };
        } else {
          const refreshed = {
            ...lease,
            mode: leasePolicy === "pending_publication" ? "pending_publication" as const : lease.mode,
            heartbeat_at: new Date().toISOString(),
            authority_sha256: "0".repeat(64),
          };
          next = { ...next, execution_lease: refreshed };
          next = {
            ...next,
            execution_lease: { ...refreshed, authority_sha256: executionAuthoritySha256(next) },
          };
        }
      } else if ((candidate.execution_lease ?? null) !== null) {
        throw new Error("Execution lease acquisition requires its dedicated transaction");
      }
      next = runManifestV2Schema.parse(next) as RunManifestV2Ledger;
      await writeManifestV2Atomic(canonicalRunDir, next, hooks);
      return next;
    };
    const transaction: RunLedgerTransaction = {
      runDir: canonicalRunDir,
      readManifestV2: () => readManifestV2NoFollow(canonicalRunDir),
	    updateManifestV2: (patch) => enqueueUpdate(async () => {
	        assertMutableManifestPatch(patch);
	        const current = await readManifestV2NoFollow(canonicalRunDir);
	        if (Object.prototype.hasOwnProperty.call(patch, "workflow_protocol")
	          && patch.workflow_protocol !== current.workflow_protocol) {
	          throw new Error("workflow_protocol is an immutable run snapshot");
	        }
	        assertTerminalManifestMutationAllowed(current, patch);
        assertGenericCheckoutMutationAllowed(current, patch);
        const updatedAt = new Date().toISOString();
        const normalizedPatch = preserveIntegratedCommitBoundary(current, patch, updatedAt);
        const next = runManifestV2Schema.parse({
          ...current,
          ...normalizedPatch,
          updated_at: updatedAt,
        }) as RunManifestV2Ledger;
        return persistManifest(current, next);
      }),
      updateReviewAccounting: (expected, nextAccounting, progressReference, qualityRecoveryWorkItemIds) => enqueueUpdate(async () => {
        const parsedExpected = reviewAccountingSchema.parse(expected);
        const parsedNext = reviewAccountingSchema.parse(nextAccounting);
        const current = await readManifestV2NoFollow(canonicalRunDir);
        if (current.terminal !== null) throw new Error(`Cannot mutate run with terminal outcome ${current.terminal.outcome}`);
        const accountingAlreadyApplied = JSON.stringify(current.review_accounting) === JSON.stringify(parsedNext);
        const qualityRecoveryTargets = [...new Set(qualityRecoveryWorkItemIds ?? [])];
        for (const workItemId of qualityRecoveryTargets) {
          const progress = current.work_item_progress[workItemId];
          if (!progress) throw new Error(`Quality recovery progress is missing for ${workItemId}`);
          const attempts = progress.quality_recovery_attempts ?? 0;
          if (attempts !== 0 && attempts !== 1) {
            throw new Error(`Quality recovery attempts must be zero or one for ${workItemId}`);
          }
        }
        const currentProgress = progressReference
          ? current.work_item_progress[progressReference.work_item_id]
          : undefined;
        if (progressReference && !currentProgress) {
          throw new Error(`Review cycle progress is missing for ${progressReference.work_item_id}`);
        }
        if (progressReference && currentProgress && (
          (currentProgress.review_revision !== undefined && currentProgress.review_revision !== progressReference.review_revision)
          || (currentProgress.review_cycle_path !== undefined && currentProgress.review_cycle_path !== progressReference.review_cycle_path)
          || (currentProgress.review_effect_id !== undefined && currentProgress.review_effect_id !== progressReference.review_effect_id)
          || currentProgress.attempts !== progressReference.attempts
          || (currentProgress.review_path !== undefined && currentProgress.review_path !== progressReference.review_path)
          || (currentProgress.verification_path !== undefined && currentProgress.verification_path !== progressReference.verification_path)
        )) throw new Error(`Review cycle progress reference conflicts for ${progressReference.work_item_id}`);
        const referencesAlreadyApplied = !progressReference || (
          currentProgress?.review_revision === progressReference.review_revision
          && currentProgress.review_cycle_path === progressReference.review_cycle_path
          && currentProgress.review_effect_id === progressReference.review_effect_id
          && currentProgress.attempts === progressReference.attempts
          && currentProgress.review_path === progressReference.review_path
          && currentProgress.verification_path === progressReference.verification_path
        );
        const qualityRecoveryAlreadyApplied = qualityRecoveryTargets.every((workItemId) =>
          current.work_item_progress[workItemId]?.quality_recovery_attempts === 1);
        if (accountingAlreadyApplied && referencesAlreadyApplied && qualityRecoveryAlreadyApplied) {
          return parsedNext;
        }
        if (!accountingAlreadyApplied && JSON.stringify(current.review_accounting) !== JSON.stringify(parsedExpected)) {
          throw new Error("Review accounting conflict: persisted state does not match expected state");
        }
        const workItemProgress = { ...current.work_item_progress };
        if (progressReference) {
          workItemProgress[progressReference.work_item_id] = {
            ...currentProgress!,
            review_revision: progressReference.review_revision,
            review_cycle_path: progressReference.review_cycle_path,
            review_effect_id: progressReference.review_effect_id,
            attempts: progressReference.attempts,
            review_path: progressReference.review_path,
            verification_path: progressReference.verification_path,
          };
        }
        for (const workItemId of qualityRecoveryTargets) {
          workItemProgress[workItemId] = {
            ...workItemProgress[workItemId]!,
            quality_recovery_attempts: 1,
          };
        }
        const updated = runManifestV2Schema.parse({
          ...current,
          review_accounting: parsedNext,
          ...(progressReference ? { current_work_item_id: progressReference.work_item_id } : {}),
          ...((progressReference || qualityRecoveryTargets.length > 0) ? { work_item_progress: workItemProgress } : {}),
          updated_at: new Date().toISOString(),
        }) as RunManifestV2Ledger;
        await persistManifest(current, updated);
        return parsedNext;
      }),
      approvePlanRevision: (expectedAccounting, revision, planRevisions, warningAuthority) => enqueueUpdate(async () => {
        const parsedExpected = reviewAccountingSchema.parse(expectedAccounting);
        const current = await readManifestV2NoFollow(canonicalRunDir);
        if ((current.execution_lease?.active_effect ?? null) !== null) throw new Error("Active execution effect blocks plan approval promotion");
        if (current.terminal !== null) throw new Error(`Cannot mutate run with terminal outcome ${current.terminal.outcome}`);
        if (JSON.stringify(current.review_accounting) !== JSON.stringify(parsedExpected)) {
          throw new Error("Plan approval accounting conflict: persisted state does not match expected state");
        }
        const next = runManifestV2Schema.parse({
          ...current,
          current_revision: revision,
          current_plan_revision: revision,
          approved_revision: revision,
          approved_plan_revision: revision,
          pending_plan_approval: null,
          plan_revisions: planRevisions,
          ...(warningAuthority ? { warning_continuation_authority: warningAuthority } : {}),
          review_accounting: { ...parsedExpected, plan_revision: revision },
          execution_lease: null,
          updated_at: new Date().toISOString(),
        }) as RunManifestV2Ledger;
        return persistManifest(current, next, "release");
      }),
      approveReplanRevision: (input) => enqueueUpdate(async () => {
        const current = await readManifestV2NoFollow(canonicalRunDir);
        if ((current.execution_lease?.active_effect ?? null) !== null) throw new Error("Active execution effect blocks replan approval promotion");
        if (current.terminal !== null) throw new Error(`Cannot mutate run with terminal outcome ${current.terminal.outcome}`);
        const hasSourceUpdate = input.source_work_item_id !== undefined
          || input.expected_source_progress !== undefined
          || input.next_source_progress !== undefined;
        if (hasSourceUpdate && (
          input.source_work_item_id === undefined
          || input.expected_source_progress === undefined
          || input.next_source_progress === undefined
          || input.source_work_item_id === input.work_item_id
        )) throw new Error("Replan approval source progress update is incomplete or aliases its target");
        const alreadyApplied = (
          (current.current_revision ?? current.current_plan_revision) === input.revision
          && (current.approved_revision ?? current.approved_plan_revision) === input.revision
          && current.stage === "worktree_setup"
          && JSON.stringify(current.work_item_progress[input.work_item_id]) === JSON.stringify(input.next_progress)
          && current.review_accounting?.plan_revision === input.revision
          && current.review_accounting.fix_cycles_used === 0
          && (!hasSourceUpdate
            || JSON.stringify(current.work_item_progress[input.source_work_item_id!]) === JSON.stringify(input.next_source_progress))
        );
        if (alreadyApplied) return current;
        if (current.stage !== "awaiting_plan_approval") {
          throw new Error(`Replan approval requires awaiting_plan_approval stage, got ${current.stage}`);
        }
        if (
          (current.current_revision ?? current.current_plan_revision) !== input.base_revision
          || (current.approved_revision ?? current.approved_plan_revision) !== input.base_revision
        ) throw new Error("Replan approval base plan revision changed");
        if (JSON.stringify(current.work_item_progress[input.work_item_id]) !== JSON.stringify(input.expected_progress)) {
          throw new Error("Replan approval target progress changed");
        }
        if (hasSourceUpdate
          && JSON.stringify(current.work_item_progress[input.source_work_item_id!]) !== JSON.stringify(input.expected_source_progress)) {
          throw new Error("Replan approval source progress changed");
        }
        if (!current.review_accounting || current.review_accounting.plan_revision !== input.base_revision) {
          throw new Error("Replan approval accounting base revision changed");
        }
        const next = runManifestV2Schema.parse({
          ...current,
          stage: "worktree_setup",
          current_revision: input.revision,
          current_plan_revision: input.revision,
          approved_revision: input.revision,
          approved_plan_revision: input.revision,
          pending_plan_approval: null,
          plan_revisions: input.plan_revisions,
          delivery_state: "pending",
          review_accounting: {
            ...current.review_accounting,
            fix_cycles_used: 0,
            plan_revision: input.revision,
          },
          work_item_progress: {
            ...current.work_item_progress,
            [input.work_item_id]: input.next_progress,
            ...(hasSourceUpdate ? { [input.source_work_item_id!]: input.next_source_progress! } : {}),
          },
          recovery: {
            ...current.recovery,
            active_scope: null,
          },
          last_blocker: null,
          execution_lease: null,
          updated_at: new Date().toISOString(),
        }) as RunManifestV2Ledger;
        return persistManifest(current, next, "release");
      }),
      commitInitialPlanApprovalBoundary: (input) => enqueueUpdate(async () => {
        const current = await readManifestV2NoFollow(canonicalRunDir);
        if (current.terminal !== null) throw new Error(`Cannot mutate run with terminal outcome ${current.terminal.outcome}`);
        if (JSON.stringify(current) !== JSON.stringify(input.expected_manifest)) {
          throw new Error("Initial plan approval manifest changed from the claimed candidate snapshot");
        }
        if (current.stage !== "brain_planning"
          || (current.current_revision ?? current.current_plan_revision) !== null
          || current.pending_plan_approval !== null
          || current.run_configuration_sha256 === null
          || input.revision.revision !== 1
          || input.revision.origin !== "initial"
          || input.revision.base_revision !== null
          || input.revision.path !== "plans/revision-1.md"
          || input.pending.proposed_revision !== 1
          || input.pending.base_revision !== null
          || input.pending.request_path !== "approvals/plan/revision-1.json"
          || input.revision.approval_request_path !== input.pending.request_path
          || input.revision.approval_request_sha256 !== input.pending.request_sha256
          || input.revision.approval_subject_sha256 !== input.pending.approval_subject_sha256) {
          throw new Error("Initial plan approval boundary coordinates are inconsistent");
        }
        const planBytes = await readOwnedEvidenceFile(canonicalRunDir, input.revision.path, "plans/");
        const planText = planBytes.toString("utf8");
        if (createHash("sha256").update(planBytes).digest("hex") !== input.revision.sha256) {
          throw new Error("Initial plan approval boundary plan digest does not match canonical bytes");
        }
        let canonicalPlan: BrainPlan;
        try {
          canonicalPlan = parsePersistedPlan(JSON.parse(planText), current.workflow_protocol);
        } catch (error) {
          throw new Error("Initial plan approval boundary plan is not valid canonical JSON", { cause: error });
        }
        if (serializePersistedPlan(canonicalPlan, current.workflow_protocol) !== planText) {
          throw new Error("Initial plan approval boundary plan bytes are not canonical");
        }
        if (input.revision.decision_contract_sha256 !== planDecisionContractSha256(canonicalPlan)) {
          throw new Error("Initial plan approval boundary plan decision contract is invalid");
        }
        const projectedManifest = runManifestV2Schema.parse({
          ...current,
          stage: "awaiting_plan_approval",
          current_revision: 1,
          current_plan_revision: 1,
          plan_revisions: { ...current.plan_revisions, "1": input.revision },
          pending_plan_approval: input.pending,
          approval_protocol_version: 1,
          approval_protocol_start_revision: current.approval_protocol_start_revision ?? 1,
        }) as RunManifestV2Ledger;
        await readVerifiedPlanApprovalRequest(canonicalRunDir, projectedManifest);
        const next = runManifestV2Schema.parse({
          ...current,
          stage: "awaiting_plan_approval",
          current_revision: 1,
          current_plan_revision: 1,
          plan_revisions: { ...current.plan_revisions, "1": input.revision },
          pending_plan_approval: input.pending,
          approval_protocol_version: 1,
          approval_protocol_start_revision: current.approval_protocol_start_revision ?? 1,
          brain_controller_claim: null,
          updated_at: new Date().toISOString(),
        }) as RunManifestV2Ledger;
        return persistManifest(current, next);
      }),
      commitPreparedPlanApprovalBoundary: (input) => enqueueUpdate(async () => {
        const current = await readManifestV2NoFollow(canonicalRunDir);
        if (current.terminal !== null) throw new Error(`Cannot mutate run with terminal outcome ${current.terminal.outcome}`);
        if (input.proposed_revision <= input.base_revision
          || input.revision.revision !== input.proposed_revision
          || input.revision.origin !== "replan"
          || input.revision.base_revision !== input.base_revision
          || input.pending.proposed_revision !== input.proposed_revision
          || input.pending.base_revision !== input.base_revision
          || input.revision.approval_request_path !== input.pending.request_path
          || input.revision.approval_request_sha256 !== input.pending.request_sha256
          || input.revision.approval_subject_sha256 !== input.pending.approval_subject_sha256
          || input.canonical_blocker.trim() === "") {
          throw new Error("Prepared plan approval boundary coordinates are inconsistent");
        }
        const expectedPlanPath = `plans/revision-${input.proposed_revision}.md`;
        const expectedRequestPath = `approvals/plan/revision-${input.proposed_revision}.json`;
        if (input.revision.path !== expectedPlanPath || input.pending.request_path !== expectedRequestPath) {
          throw new Error("Prepared plan approval artifact paths are not canonical");
        }
        const planBytes = await readOwnedEvidenceFile(canonicalRunDir, expectedPlanPath, "plans/");
        if (createHash("sha256").update(planBytes).digest("hex") !== input.revision.sha256) {
          throw new Error("Prepared plan approval plan artifact does not match its revision digest");
        }
        const requestBytes = await readOwnedRunFile(canonicalRunDir, expectedRequestPath);
        const requestText = requestBytes.toString("utf8");
        const requestDigest = createHash("sha256").update(requestBytes).digest("hex");
        if (requestDigest !== input.pending.request_sha256) {
          throw new Error("Prepared plan approval request artifact does not match its pending digest");
        }
        let request;
        try {
          request = planApprovalRequestSchema.parse(JSON.parse(requestText));
        } catch (error) {
          throw new Error("Prepared plan approval request artifact is invalid", { cause: error });
        }
        if (serializePlanApprovalRequest(request) !== requestText
          || requestSha256(request) !== requestDigest) {
          throw new Error("Prepared plan approval request artifact is not canonical");
        }
        if (approvalSha256(request.subject) !== request.approval_subject_sha256
          || request.approval_subject_sha256 !== input.pending.approval_subject_sha256
          || request.approval_subject_sha256 !== input.revision.approval_subject_sha256) {
          throw new Error("Prepared plan approval request subject binding is invalid");
        }
        if (request.subject.reason_code !== "material_replan"
          || request.subject.run_id !== current.run_id
          || request.subject.plan_revision !== input.proposed_revision
          || request.subject.base_plan_revision !== input.base_revision
          || request.subject.plan_sha256 !== input.revision.sha256
          || request.subject.decision_contract_sha256 !== input.revision.decision_contract_sha256
          || request.plan_path !== input.revision.path
          || request.delta.base_revision !== input.base_revision
          || request.delta.proposed_revision !== input.proposed_revision) {
          throw new Error("Prepared plan approval request semantic binding is invalid");
        }
        const existingRevision = current.plan_revisions[String(input.proposed_revision)];
        const alreadyCommitted = current.stage === "awaiting_plan_approval"
          && JSON.stringify(existingRevision) === JSON.stringify(input.revision)
          && JSON.stringify(current.pending_plan_approval) === JSON.stringify(input.pending)
          && current.run_configuration_sha256 === input.run_configuration_sha256
          && current.current_revision === input.base_revision
          && current.current_plan_revision === input.base_revision
          && current.approved_revision === input.base_revision
          && current.approved_plan_revision === input.base_revision;
        if (alreadyCommitted) {
          if (current.delivery_state === "blocked" && current.last_blocker === input.canonical_blocker) return current;
          const normalized = runManifestV2Schema.parse({
            ...current,
            delivery_state: "blocked",
            last_blocker: input.canonical_blocker,
            updated_at: new Date().toISOString(),
          }) as RunManifestV2Ledger;
          return persistManifest(current, normalized);
        }
        const expectedManifest = runManifestV2Schema.parse(input.expected_manifest) as RunManifestV2Ledger;
        if (!preparedBoundarySnapshotMatches(current, expectedManifest)) {
          throw new Error("Prepared plan approval manifest changed from the expected preparation snapshot");
        }
        if (current.run_configuration_sha256 !== null
          && current.run_configuration_sha256 !== input.run_configuration_sha256) {
          throw new Error("Prepared plan approval run configuration digest does not match the pinned manifest");
        }
        if (current.pending_plan_approval !== null) {
          throw new Error("A different plan approval boundary is already pending");
        }
        if (existingRevision !== undefined) {
          throw new Error(`Prepared plan revision ${input.proposed_revision} conflicts with the manifest`);
        }
        if (current.stage !== "replanning" && current.stage !== "awaiting_plan_approval") {
          throw new Error(`Prepared replan requires replanning or legacy awaiting_plan_approval stage, got ${current.stage}`);
        }
        if (current.current_revision !== input.base_revision
          || current.current_plan_revision !== input.base_revision
          || current.approved_revision !== input.base_revision
          || current.approved_plan_revision !== input.base_revision) {
          throw new Error("Prepared replan base plan revision changed");
        }
        const next = runManifestV2Schema.parse({
          ...current,
          stage: "awaiting_plan_approval",
          current_revision: input.base_revision,
          current_plan_revision: input.base_revision,
          approved_revision: input.base_revision,
          approved_plan_revision: input.base_revision,
          plan_revisions: {
            ...current.plan_revisions,
            [String(input.proposed_revision)]: input.revision,
          },
          pending_plan_approval: input.pending,
          approval_protocol_version: 1,
          approval_protocol_start_revision: current.approval_protocol_start_revision ?? input.proposed_revision,
          run_configuration_sha256: input.run_configuration_sha256,
          delivery_state: "blocked",
          last_blocker: input.canonical_blocker,
          ...(current.execution_lease === null || current.execution_lease === undefined ? {} : {
            execution_lease: { ...current.execution_lease, mode: "pending_publication" },
          }),
          updated_at: new Date().toISOString(),
        }) as RunManifestV2Ledger;
        return persistManifest(current, next, current.execution_lease === null ? "preserve" : "pending_publication");
      }),
      rejectPreparedPlanApprovalBoundary: (input) => enqueueUpdate(async () => {
        const current = await readManifestV2NoFollow(canonicalRunDir);
        const pending = current.pending_plan_approval;
        const revision = current.plan_revisions[String(input.revision)];
        if (current.stage !== "awaiting_plan_approval"
          || !pending
          || pending.base_revision === null
          || pending.proposed_revision !== input.revision
          || revision?.origin !== "replan"
          || revision.base_revision !== pending.base_revision
          || input.rejection_path !== `approvals/plan/revision-${input.revision}-rejection.json`
          || input.blocker.trim() === "") {
          throw new Error("Prepared plan rejection boundary coordinates are inconsistent");
        }
        const rejectionBytes = await readOwnedEvidenceFile(canonicalRunDir, input.rejection_path, "approvals/");
        if (createHash("sha256").update(rejectionBytes).digest("hex") !== input.rejection_sha256) {
          throw new Error("Prepared plan rejection artifact digest does not match canonical bytes");
        }
        const rejection = JSON.parse(rejectionBytes.toString("utf8")) as Record<string, unknown>;
        if (rejection.rejected_revision !== input.revision
          || rejection.base_revision !== pending.base_revision
          || rejection.request_path !== pending.request_path
          || rejection.request_sha256 !== pending.request_sha256
          || rejection.approval_subject_sha256 !== pending.approval_subject_sha256) {
          throw new Error("Prepared plan rejection artifact does not bind the exact pending request");
        }
        const next = runManifestV2Schema.parse({
          ...current,
          stage: "replanning",
          pending_plan_approval: null,
          delivery_state: "blocked",
          last_blocker: input.blocker,
          updated_at: new Date().toISOString(),
        }) as RunManifestV2Ledger;
        return persistManifest(current, next);
      }),
      recordTerminalDisposition: (...args: [TerminalDisposition]) => args.length === 1
        ? persistTerminalDisposition(args[0], undefined, false)
        : Promise.reject(new Error("Public terminal transaction does not accept a cleanup capability")),
      acquireExecutionLease: (input) => enqueueUpdate(async () => {
        if (input.invocation_id.trim() === "") throw new Error("Execution invocation ID is required");
        const current = await readManifestV2NoFollow(canonicalRunDir);
        const existing = current.execution_lease ?? null;
        if (existing !== null) {
          if (existing.authority_sha256 !== executionAuthoritySha256(current)) {
            throw new Error("Existing execution lease authority is corrupt and cannot be reclaimed");
          }
          if (!executionLeaseCanBeReclaimed(existing)) {
            throw new Error(`Active execution lease ${existing.owner.invocation_id} blocks this invocation`);
          }
        }
        const aliasesApproved = current.current_revision !== null
          && current.current_revision === current.current_plan_revision
          && current.current_revision === current.approved_revision
          && current.current_revision === current.approved_plan_revision;
        if (input.mode === "execution" && (!aliasesApproved || current.pending_plan_approval !== null)) {
          throw new Error("Execution lease requires one explicitly approved current revision and no pending boundary");
        }
        if (input.mode === "replan_preparation" && (
          !aliasesApproved
          || current.pending_plan_approval !== null
          || (current.stage !== "replanning" && current.stage !== "awaiting_plan_approval")
        )) {
          throw new Error("Replan-preparation lease requires one explicitly approved current revision, a replan preparation stage, and no pending boundary");
        }
        if (input.mode === "pending_publication" && (
          !aliasesApproved
          || current.pending_plan_approval === null
          || current.pending_plan_approval.base_revision !== current.approved_revision
        )) {
          throw new Error("Pending-publication lease requires an exact pending boundary over the approved base");
        }
        if (input.mode === "initial_pending_publication" && (
          current.pending_plan_approval === null
          || current.pending_plan_approval.base_revision !== null
          || current.approved_revision !== null
          || current.approved_plan_revision !== null
          || current.current_revision !== current.pending_plan_approval.proposed_revision
          || current.current_plan_revision !== current.pending_plan_approval.proposed_revision
        )) {
          throw new Error("Initial-pending publication lease requires the exact unapproved initial boundary");
        }
        const epoch = (current.execution_epoch ?? 0) + 1;
        const now = new Date().toISOString();
        let next = {
          ...current,
          execution_epoch: epoch,
          execution_lease: {
            version: 1 as const,
            token: randomUUID(),
            epoch,
            mode: input.mode,
            authority_sha256: "0".repeat(64),
            owner: {
              invocation_id: input.invocation_id,
              hostname: hostname(),
              pid: process.pid,
              process_started_at: processStartedAt,
            },
            active_effect: null,
            acquired_at: now,
            heartbeat_at: now,
          },
          updated_at: now,
        } as RunManifestV2Ledger;
        next = {
          ...next,
          execution_lease: {
            ...next.execution_lease!,
            authority_sha256: executionAuthoritySha256(next),
          },
        };
        next = runManifestV2Schema.parse(next) as RunManifestV2Ledger;
        await writeManifestV2Atomic(canonicalRunDir, next, hooks);
        return {
          runDir: canonicalRunDir,
          token: next.execution_lease!.token,
          epoch: next.execution_lease!.epoch,
          invocationId: input.invocation_id,
        };
      }),
      assertExecutionLease: (claim) => enqueueUpdate(async () => {
        const current = await readManifestV2NoFollow(canonicalRunDir);
        assertLeaseClaimMatches(current, claim);
      }),
      releaseExecutionLease: (claim) => enqueueUpdate(async () => {
        const current = await readManifestV2NoFollow(canonicalRunDir);
        const lease = assertLeaseClaimMatches(current, claim);
        if (lease.active_effect !== null) throw new Error("Cannot release an execution lease with an active effect");
        const next = runManifestV2Schema.parse({
          ...current,
          execution_epoch: (current.execution_epoch ?? 0) + 1,
          execution_lease: null,
          updated_at: new Date().toISOString(),
        }) as RunManifestV2Ledger;
        await writeManifestV2Atomic(canonicalRunDir, next, hooks);
        return next;
      }),
      beginExecutionEffect: (claim, kind, invocationId) => enqueueUpdate(async () => {
        const current = await readManifestV2NoFollow(canonicalRunDir);
        const lease = assertLeaseClaimMatches(current, claim);
        if (lease.active_effect !== null) throw new Error("Another external execution effect is already active");
        if (kind.trim() === "" || invocationId.trim() === "") throw new Error("Execution effect identity is required");
        if (lease.mode !== "execution" && kind !== "adapter:upsertRunStatus") {
          throw new Error(`${lease.mode} is a publication-only lease and permits only run-status publication, not ${kind}`);
        }
        const epoch = (current.execution_epoch ?? 0) + 1;
        let next = {
          ...current,
          execution_epoch: epoch,
          execution_lease: {
            ...lease,
            active_effect: {
              invocation_id: invocationId,
              kind,
              hostname: hostname(),
              child_pids: [],
              started_at: new Date().toISOString(),
            },
            heartbeat_at: new Date().toISOString(),
            authority_sha256: "0".repeat(64),
          },
          updated_at: new Date().toISOString(),
        } as RunManifestV2Ledger;
        next = { ...next, execution_lease: { ...next.execution_lease!, authority_sha256: executionAuthoritySha256(next) } };
        await writeManifestV2Atomic(canonicalRunDir, runManifestV2Schema.parse(next) as RunManifestV2Ledger, hooks);
      }),
      recordExecutionEffectChild: (claim, invocationId, pid) => enqueueUpdate(async () => {
        const current = await readManifestV2NoFollow(canonicalRunDir);
        const lease = assertLeaseClaimMatches(current, claim);
        if (lease.active_effect?.invocation_id !== invocationId) throw new Error("Execution effect invocation changed before child binding");
        if (pid !== null && (!Number.isInteger(pid) || pid <= 0)) throw new Error("Execution child PID must be positive or null");
        const epoch = (current.execution_epoch ?? 0) + 1;
        let next = {
          ...current,
          execution_epoch: epoch,
          execution_lease: {
            ...lease,
            active_effect: {
              ...lease.active_effect,
              child_pids: pid === null
                ? lease.active_effect.child_pids
                : [...new Set([...lease.active_effect.child_pids, pid])],
            },
            heartbeat_at: new Date().toISOString(),
            authority_sha256: "0".repeat(64),
          },
          updated_at: new Date().toISOString(),
        } as RunManifestV2Ledger;
        next = { ...next, execution_lease: { ...next.execution_lease!, authority_sha256: executionAuthoritySha256(next) } };
        await writeManifestV2Atomic(canonicalRunDir, runManifestV2Schema.parse(next) as RunManifestV2Ledger, hooks);
      }),
      endExecutionEffect: (claim, invocationId) => enqueueUpdate(async () => {
        const current = await readManifestV2NoFollow(canonicalRunDir);
        const lease = assertLeaseClaimMatches(current, claim);
        if (lease.active_effect?.invocation_id !== invocationId) throw new Error("Execution effect invocation changed before completion");
        const liveOrUncertainChildren = lease.active_effect.child_pids.filter((pid) =>
          !childInvocationIsProvablyDead(pid, lease.active_effect!.hostname));
        if (liveOrUncertainChildren.length > 0) {
          throw new Error(`Execution effect children remain live or uncertain: ${liveOrUncertainChildren.join(", ")}`);
        }
        const epoch = (current.execution_epoch ?? 0) + 1;
        let next = {
          ...current,
          execution_epoch: epoch,
          execution_lease: { ...lease, active_effect: null, heartbeat_at: new Date().toISOString(), authority_sha256: "0".repeat(64) },
          updated_at: new Date().toISOString(),
        } as RunManifestV2Ledger;
        next = { ...next, execution_lease: { ...next.execution_lease!, authority_sha256: executionAuthoritySha256(next) } };
        await writeManifestV2Atomic(canonicalRunDir, runManifestV2Schema.parse(next) as RunManifestV2Ledger, hooks);
      }),
      setRunCheckoutIdentity: (claim, checkout) => enqueueUpdate(async () => {
        const current = await readManifestV2NoFollow(canonicalRunDir);
        assertLeaseClaimMatches(current, claim);
        const expectedPath = resolve(current.repo_root, ".brain-hands", "worktrees", current.run_id);
        const expectedBranch = `codex/brain-hands/${current.run_id}`;
        if (resolve(checkout.worktreePath) !== expectedPath || checkout.branchName !== expectedBranch) {
          throw new Error("Run checkout identity must use the deterministic repository/run coordinates");
        }
        if ((current.worktree_path !== null && resolve(current.worktree_path) !== expectedPath)
          || (current.branch_name !== null && current.branch_name !== expectedBranch)) {
          throw new Error("Immutable checkout identity conflicts with the deterministic run checkout");
        }
        if (current.worktree_path === expectedPath && current.branch_name === expectedBranch) return current;
        const next = runManifestV2Schema.parse({
          ...current,
          worktree_path: expectedPath,
          branch_name: expectedBranch,
          checkout_allocation_state: "pending",
        }) as RunManifestV2Ledger;
        return persistManifest(current, next, "preserve", claim);
      }),
      markRunCheckoutReady: (claim) => enqueueUpdate(async () => {
        const current = await readManifestV2NoFollow(canonicalRunDir);
        assertLeaseClaimMatches(current, claim);
        if (current.worktree_path === null || current.branch_name === null || current.source_commit === null) {
          throw new Error("Checkout readiness requires complete pinned checkout authority");
        }
        if (current.checkout_allocation_state === "ready") return current;
        const next = runManifestV2Schema.parse({ ...current, checkout_allocation_state: "ready" }) as RunManifestV2Ledger;
        return persistManifest(current, next, "preserve", claim);
      }),
    };
    coordinatedTerminalWriters.set(transaction, (disposition, cleanup) =>
      persistTerminalDisposition(disposition, cleanup, true));
    legacyRestoreWriters.set(transaction, persistLegacyRestore);
    const context = { transaction, active: true, enqueueCompound };
    try {
      return await activeTransaction.run(context, () => operation(transaction));
    } finally {
      context.active = false;
      coordinatedTerminalWriters.delete(transaction);
      legacyRestoreWriters.delete(transaction);
      await release();
    }
  });
}

export async function withRunLedgerCompoundTransaction<T>(
  runDir: string,
  operation: (transaction: RunLedgerTransaction) => Promise<T>,
  hooks: RunLedgerTransactionHooks = {},
): Promise<T> {
  return withRunLedgerTransaction(runDir, async (transaction) => {
    const currentCompound = activeCompound.getStore();
    if (currentCompound?.runDir === transaction.runDir) {
      throw new Error("Same-run compound transaction reentrancy is not allowed");
    }
    const context = activeTransaction.getStore();
    if (!context || !context.active || context.transaction !== transaction) {
      throw new Error("Compound run ledger operation requires its active transaction context");
    }
    return context.enqueueCompound(async () => {
      const compoundContext = { runDir: transaction.runDir, active: true };
      try {
        return await activeCompound.run(compoundContext, () => operation(transaction));
      } finally {
        compoundContext.active = false;
      }
    });
  }, hooks);
}

/** Atomically switch one legacy manifest to task-lineage effects and, when needed,
 * record its one-shot post-issue restore authority. Callers cannot supply any
 * restore payload or stage. */
export async function migrateLegacyGithubManifest(runDir: string, lineageId: string): Promise<RunManifestV2Ledger> {
  return withRunLedgerTransaction(runDir, (transaction) => {
    const writer = legacyRestoreWriters.get(transaction);
    if (!writer) throw new Error("Legacy migration requires an active module-owned transaction capability");
    return writer({ kind: "migrate", lineageId });
  });
}

/** Consume post-issue legacy restore authority only after the immutable applied
 * issue preview and complete lineage mappings have been revalidated under the
 * lineage lock. */
export async function consumeReadyLegacyGithubRestore(runDir: string): Promise<RunManifestV2Ledger> {
  const observed = await readManifestV2(runDir);
  const authority = observed.legacy_github_restore ?? null;
  if (authority === null) return observed;
  if (observed.task_lineage_id !== authority.lineage_id) throw new Error("Legacy restore lineage binding changed");
  return withTaskLineageTransaction({
    repoRoot: observed.repo_root,
    lineageId: authority.lineage_id,
    operation: async (lineageTransaction) => {
      const lineage = lineageTransaction.read();
      if (lineage.active_run_id !== observed.run_id || lineage.issue_set.state !== "ready"
        || lineage.issue_set.preview?.state !== "applied") {
        throw new Error("Legacy restore requires ready applied issue authority");
      }
      const { readVerifiedGithubEffectPreview } = await import("../github/effect-plan.js");
      const { assertReadyAppliedIssueSet } = await import("../workflow/github-issue-reconciliation.js");
      const preview = await readVerifiedGithubEffectPreview({
        run_dir: runDir,
        reference: lineage.issue_set.preview,
        expected: {
          phase: "issue_sync",
          lineage_id: lineage.lineage_id,
          run_id: observed.run_id,
          plan_revision: authority.plan_revision,
          plan_sha256: authority.plan_sha256,
        },
      });
      if (lineage.repository_key === null) throw new Error("Legacy restore lineage has no repository binding");
      assertReadyAppliedIssueSet({
        repoRoot: observed.repo_root,
        lineageId: lineage.lineage_id,
        runId: observed.run_id,
        repositoryKey: lineage.repository_key,
        preview,
      }, lineage);
      return withRunLedgerTransaction(runDir, async (transaction) => {
        const current = await transaction.readManifestV2();
        if (current.run_id !== observed.run_id || current.task_lineage_id !== lineage.lineage_id
          || JSON.stringify(current.legacy_github_restore ?? null) !== JSON.stringify(authority)) {
          throw new Error("Legacy restore authority changed before consumption");
        }
        const writer = legacyRestoreWriters.get(transaction);
        if (!writer) throw new Error("Legacy restore requires an active module-owned transaction capability");
        return writer({
          kind: "consume",
          lineageId: lineage.lineage_id,
          planRevision: authority.plan_revision,
          planSha256: authority.plan_sha256,
        });
      });
    },
  });
}

function formatRunId(now: Date, slug: string): string {
  const stamp = now.toISOString().replaceAll(":", "-").replace(".", "-");
  return `${stamp}-${slug}`;
}

const RESERVED_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,191}$/;

export function taskLineageId(rootRunId: string): `task-lineage:${string}` {
  return `task-lineage:${createHash("sha256")
    .update(`brain-hands-task-lineage-v1\0${rootRunId}`)
    .digest("hex")}`;
}

function assertTaskLineageIdentity(lineage: TaskLineageV1 | null): void {
  if (lineage !== null && lineage.lineage_id !== taskLineageId(lineage.root_run_id)) {
    throw new Error("task_lineage lineage_id must match the deterministic identity for root_run_id");
  }
}

export async function createRunLedger(input: CreateRunLedgerInput): Promise<RunLedger> {
  const now = input.now ?? new Date();
  const runId = formatRunId(now, input.slug);
  const runDir = join(input.repoRoot, ".brain-hands", "runs", runId);
  const createdAt = now.toISOString();

  const manifest: RunManifest = {
    run_id: runId,
    original_request: input.originalRequest,
    repo_root: input.repoRoot,
    created_at: createdAt,
    updated_at: createdAt,
    stage: "intake",
    current_issue: null,
    current_pr: null,
    retry_counts: {},
    issue_numbers: [],
    pr_numbers: [],
  };

  await mkdir(runDir, { recursive: true });
  await mkdir(join(runDir, "verification"), { recursive: true });
  await mkdir(join(runDir, "reviews"), { recursive: true });
  await mkdir(join(runDir, "prompts"), { recursive: true });
  await mkdir(join(runDir, "responses"), { recursive: true });

  await writeFile(join(runDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  await writeFile(join(runDir, "original-request.md"), `${input.originalRequest}\n`, "utf8");

  return { runId, runDir, manifest };
}

/** Create the durable v2 run state without changing the legacy ledger shape. */
export async function createRunLedgerV2(input: CreateRunLedgerV2Input): Promise<RunLedgerV2> {
  const values = v2InputValues(input);
  const suppliedRoleProfiles = [
    input.roleProfiles,
    input.roles,
    input.selectedRoleProfiles,
    input.selected_role_profiles,
  ].filter((profiles): profiles is Partial<Record<RoleName, RoleProfile>> => profiles !== undefined);
  if (suppliedRoleProfiles.some((profiles) =>
    canonicalApprovalJson(profiles) !== canonicalApprovalJson(values.roleProfiles))) {
    throw new Error("Primary and selected role profile authority must match");
  }
  const runConfiguration = input.runConfiguration === undefined
    ? null
    : resolvedRunConfigurationSchema.parse(input.runConfiguration);
  if (runConfiguration !== null && (
    runConfiguration.repository !== values.repoRoot
    || runConfiguration.mode !== values.mode
    || input.controllerProvenance === undefined
    || runConfiguration.controller.package_name !== input.controllerProvenance.package_name
    || runConfiguration.controller.package_version !== input.controllerProvenance.package_version
    || runConfiguration.controller.mode !== input.controllerProvenance.mode
  )) throw new Error("Run configuration does not match the run creation inputs");
  const now = input.now ?? new Date();
  if (input.runId !== undefined && (
    input.runId === "."
    || input.runId === ".."
    || !RESERVED_RUN_ID.test(input.runId)
  )) {
    throw new Error("Reserved run ID is invalid");
  }
  const runId = input.runId ?? formatRunId(now, input.slug ?? "workflow-run");
  const runDir = join(values.repoRoot, ".brain-hands", "runs", runId);
  const createdAt = now.toISOString();
  const githubTaskLineageId = input.taskLineageId ?? randomUUID();
  const intake = {
    ...values.intake,
    task: values.intake.task || values.originalRequest,
    repo_root: values.repoRoot,
    mode: values.mode,
  };
  const reviewPolicySnapshot = resolveReviewPolicy(
    CANONICAL_REVIEW_POLICY.max_fix_cycles,
    undefined,
    "review_policy" in intake ? intake.review_policy : undefined,
  );
  if (runConfiguration !== null) {
    const configurationRoles = Object.fromEntries(Object.entries(runConfiguration.roles)
      .map(([name, profile]) => [name, {
        model: profile.model,
        reasoning_effort: profile.reasoning_effort,
        sandbox: profile.sandbox,
      }]));
    const intakeRoles = "roles" in intake ? intake.roles : undefined;
    const mismatches = [
      runConfiguration.research !== intake.research ? "research" : null,
      runConfiguration.reflection !== intake.reflection ? "reflection" : null,
      canonicalApprovalJson(configurationRoles) !== canonicalApprovalJson(values.roleProfiles)
        || (intakeRoles !== undefined && canonicalApprovalJson(configurationRoles) !== canonicalApprovalJson(intakeRoles))
        ? "roles" : null,
      canonicalApprovalJson(runConfiguration.hands_backup) !== canonicalApprovalJson("hands_backup" in intake ? intake.hands_backup ?? null : null)
        ? "Hands backup" : null,
      canonicalApprovalJson(runConfiguration.limits.quality_gate) !== canonicalApprovalJson("quality_gate" in intake ? intake.quality_gate ?? null : null)
        ? "quality gate" : null,
      "phase_reasoning" in runConfiguration
        && canonicalApprovalJson(runConfiguration.phase_reasoning) !== canonicalApprovalJson("phase_reasoning" in intake ? intake.phase_reasoning : undefined)
        ? "phase reasoning" : null,
      canonicalApprovalJson(runConfiguration.limits.review_policy) !== canonicalApprovalJson(reviewPolicySnapshot)
        ? "review policy" : null,
    ].filter((entry): entry is string => entry !== null);
    if (mismatches.length > 0) {
      throw new Error(`Run configuration authority does not match intake or run inputs: ${mismatches.join(", ")}`);
    }
  }
  const persistedReviewPolicy = intake.review_policy === undefined
    ? undefined
    : { ...intake.review_policy } as Record<string, unknown>;
  delete persistedReviewPolicy?.policy_revision;
  const persistedIntake = persistedReviewPolicy === undefined
    ? intake
    : { ...intake, review_policy: persistedReviewPolicy };
  const suppliedWarningAuthority = "warning_continuation_authority" in intake
    && intake.warning_continuation_authority !== undefined
      ? warningContinuationAuthoritySchema.parse(intake.warning_continuation_authority)
      : undefined;
  if (suppliedWarningAuthority?.source === "approved_plan") {
    throw new Error("approved_plan warning authority can only be derived by the plan approval transition");
  }
  const explicitRunWarningOverride = reviewPolicySnapshot.on_limit === "continue_with_warning" && (
    suppliedWarningAuthority?.source === "run_override"
    || (!("resolved_models" in intake) && "review_policy" in intake && intake.review_policy?.on_limit === "continue_with_warning")
  );
  const resourceBudgetPolicy = resourceBudgetPolicyV1Schema.parse(
    input.resourceBudgetPolicy ?? input.resource_budget_policy ?? DEFAULT_RESOURCE_BUDGET_V1,
  );
  const manifest = runManifestV2Schema.parse({
    version: 2,
    schema_version: 2,
    run_id: runId,
    original_request: values.originalRequest,
    repo_root: values.repoRoot,
    created_at: createdAt,
    updated_at: createdAt,
    stage: "intake",
    workflow_protocol: "bounded-context-v1",
    reflection_protocol: "single-pass-v1",
    task_lineage_id: githubTaskLineageId,
    github_effects_protocol: "task-lineage-v1",
    github_effects: { issue_sync: null, pull_request_delivery: null },
    github_cleanup: null,
    discovery: initialDiscoveryState(),
    resource_budget_policy: { ...resourceBudgetPolicy },
    current_work_item_id: null,
    retry_counts: {},
    issue_numbers: [],
    pull_request_numbers: [],
    events: ["events.jsonl"],
    current_revision: null,
    approved_revision: null,
    current_plan_revision: null,
    approved_plan_revision: null,
    plan_revisions: {},
    pending_plan_approval: null,
    approval_protocol_version: runConfiguration === null ? null : 1,
    approval_protocol_start_revision: runConfiguration === null ? null : 1,
    run_configuration_sha256: runConfiguration === null ? null : runConfigurationSha256(runConfiguration),
    role_profiles: values.roleProfiles,
    selected_role_profiles: values.roleProfiles,
    mode: values.mode,
    run_mode: values.mode,
    active_hands_profile: "primary",
    backup_activation_reason: null,
    quality_gate_policy: "quality_gate" in intake ? intake.quality_gate ?? null : null,
    hands_backup_policy: "hands_backup" in intake ? intake.hands_backup ?? null : null,
    hands_backup_catalog: null,
    review_policy_snapshot: reviewPolicySnapshot,
    ...(explicitRunWarningOverride
      ? { warning_continuation_authority: { actor: "run-intake", source: "run_override" as const } }
      : {}),
    release_guards: DEFAULT_RELEASE_GUARDS.map((guard) => ({ ...guard })),
    review_accounting: {
      review_revision: 0,
      fix_cycles_used: 0,
      self_review_mutations_used: 0,
      plan_revision: 0,
    },
    source_commit: input.sourceCommit ?? input.sourceCommitSha ?? input.source_commit ?? null,
    ...(input.controllerProvenance ? { controller_provenance: input.controllerProvenance } : {}),
    brain_controller_claim: null,
    planning_recovery: null,
    recovery: {
      version: 1,
      active_scope: null,
      scopes: {},
    },
    task_lineage: input.taskLineage ?? {
      version: 1,
      lineage_id: taskLineageId(runId),
      root_run_id: runId,
      predecessor_run_id: null,
      predecessor_abandonment_sha256: null,
    },
    controller_recovery: {
      version: 1,
      transition_count: 0,
      head_path: null,
    },
    worktree_path: input.worktreePath ?? input.worktree_path ?? null,
    branch_name: input.branchName ?? input.branch_name ?? null,
    work_item_progress: {},
    work_item_issue_map: {},
    github_ids: {
      issue_numbers:
        input.githubIds?.issueNumbers ?? input.github_ids?.issue_numbers ?? [],
      work_item_issue_map: {},
      parent_issue_number: null,
      pull_request_numbers:
        input.githubIds?.pullRequestNumbers ?? input.github_ids?.pull_request_numbers ?? [],
      pull_request_urls: {},
    },
    delivery_state: "pending",
    assurance_outcome: null,
    assurance_assessment_path: null,
    remote_synchronization_path: null,
    risk_acceptance_path: null,
    risk_acceptance_history: [],
    abandonment_path: null,
    terminal: null,
    final_artifact_paths: input.finalArtifactPaths ?? input.final_artifact_paths ?? [],
    final_verifier_index_path: null,
    final_verifier_index_sha256: null,
    reflection_index_path: null,
    last_blocker: null,
    intake_path: "intake.json",
  }) as RunManifestV2Ledger;
  assertTaskLineageIdentity(manifest.task_lineage);

  await mkdir(dirname(runDir), { recursive: true });
  try {
    // The run directory is the lock: mkdir without recursive is atomic, so
    // concurrent callers cannot both pass a check and overwrite one ledger.
    await mkdir(runDir);
  } catch (error: unknown) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code === "EEXIST") throw new Error(`Run ledger ${runId} already exists`);
    throw error;
  }
  for (const directory of [
    "plans",
    "prompts",
    "responses",
    "schemas",
    "implementation",
    "verification",
    "reviews",
    "findings",
    "assurance",
    "summaries",
    "evidence-indexes",
    "contexts",
    "budgets/claims",
    "budgets/completions",
    "discovery/questions",
    "discovery/answers",
    "discovery/approaches",
    "discovery/briefs",
    "recovery/scopes",
    "controller-recovery/transitions",
    "lineage",
    "replacement",
    "approvals/plan",
  ]) {
    await mkdir(join(runDir, directory), { recursive: true });
  }
  if (runConfiguration !== null) {
    await writeFile(join(runDir, RUN_CONFIGURATION_PATH), serializeRunConfiguration(runConfiguration), {
      encoding: "utf8",
      flag: "wx",
    });
  }
  await writeFile(join(runDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  await writeFile(join(runDir, "budgets", "policy.json"), `${JSON.stringify(resourceBudgetPolicy, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  await writeFile(join(runDir, "intake.json"), JSON.stringify(persistedIntake, null, 2), "utf8");
  await writeFile(join(runDir, "original-request.md"), `${values.originalRequest}\n`, "utf8");
  await writeFile(join(runDir, "events.jsonl"), "", { encoding: "utf8", flag: "wx" }).catch((error: unknown) => {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code !== "EEXIST") throw error;
  });
  await writeFile(join(runDir, "progress.jsonl"), "", { encoding: "utf8", flag: "wx" }).catch((error: unknown) => {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code !== "EEXIST") throw error;
  });
  try {
    await initializeSessionArtifacts({ runDir, runId, createdAt });
  } catch {
    // Session telemetry is observational. The authoritative manifest and event streams above remain usable.
  }

  // The run directory and lineage record are separate durable writes. If the
  // process stops here, attachMissingNewRunLineage performs the exact repair.
  await createTaskLineage({ repoRoot: values.repoRoot, runId, lineageId: githubTaskLineageId, now });

  return { runId, runDir, manifest };
}

export async function readManifestV2(runDir: string): Promise<RunManifestV2Ledger> {
  const raw = await readFile(join(runDir, "manifest.json"), "utf8");
  const manifest = runManifestV2Schema.parse(JSON.parse(raw)) as RunManifestV2Ledger;
  assertTaskLineageIdentity(manifest.task_lineage);
  return manifest;
}

export async function appendRunEvent(
  runDir: string,
  input: RunEventInput,
): Promise<RunEventRecord> {
  const manifest = await readManifestV2(runDir);
  const actor = input.actor.trim();
  if (!actor) throw new Error("Run event actor must be non-empty");
  const stage = input.stage ?? manifest.stage;
  const event: RunEventRecord = {
    event_id: randomUUID(),
    run_id: manifest.run_id,
    stage,
    type: input.type ?? "transition",
    timestamp: input.timestamp ?? new Date().toISOString(),
    actor,
    payload: input.payload ?? {},
  };
  await appendOwnedRunFile(runDir, "events.jsonl", `${JSON.stringify(event)}\n`);
  return event;
}

export async function appendRunEventOnce(
  runDir: string,
  input: RunEventInput & { eventId: string },
): Promise<RunEventRecord> {
  return withRunLedgerTransaction(runDir, (transaction) => appendRunEventOnceLocked(transaction, input));
}

export async function appendRunEventOnceLocked(
  transaction: RunLedgerTransaction,
  input: RunEventInput & { eventId: string },
): Promise<RunEventRecord> {
    const manifest = await transaction.readManifestV2();
    const actor = input.actor.trim();
    if (!actor) throw new Error("Run event actor must be non-empty");
    const eventBytes = await readOwnedRunFile(transaction.runDir, "events.jsonl");
    if (eventBytes.length > 0 && eventBytes[eventBytes.length - 1] !== 0x0a) {
      throw new Error("Deterministic run event stream has unterminated framing; nonempty events.jsonl must end with a newline");
    }
    const events = eventBytes.toString("utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => runEventSchema.parse(JSON.parse(line)) as RunEventRecord);
    if (events.some((event) => event.run_id !== manifest.run_id)) {
      throw new Error("Run event stream contains an event for a foreign run");
    }
    const matching = events.filter((event) => event.event_id === input.eventId);
    if (matching.length > 1) {
      throw new Error(`Duplicate deterministic run event: ${input.eventId}`);
    }
    const event = runEventSchema.parse({
      event_id: input.eventId,
      run_id: manifest.run_id,
      stage: input.stage ?? matching[0]?.stage ?? manifest.stage,
      type: input.type ?? "transition",
      timestamp: input.timestamp ?? matching[0]?.timestamp ?? new Date().toISOString(),
      actor,
      payload: input.payload ?? {},
    }) as RunEventRecord;
    if (matching.length === 1) {
      if (JSON.stringify(matching[0]) !== JSON.stringify(event)) {
        throw new Error(`Deterministic run event conflicts with existing event: ${input.eventId}`);
      }
      return matching[0];
    }
    await appendOwnedRunFile(transaction.runDir, "events.jsonl", `${JSON.stringify(event)}\n`);
    return event;
}

export interface RecordTerminalDispositionInput {
  outcome: TerminalDisposition["outcome"];
  actor: TerminalDisposition["actor"];
  reason: string;
  residual_risks: string[];
  recorded_at?: string;
}

function lineageStateForTerminalOutcome(outcome: TerminalDisposition["outcome"]): TaskLineageState {
  switch (outcome) {
    case "delivered": return "delivery_ready";
    case "human_accepted": return "human_accepted";
    case "abandoned": return "abandoned";
    case "closed_blocked": return "closed_blocked";
  }
}

/** Persist a GitHub lineage transition before atomically recording terminal outcome and cleanup intent. */
export async function recordTerminalDispositionWithCleanup(input: {
  runDir: string;
  disposition: RecordTerminalDispositionInput;
  lineage: TaskLineageRecordV1;
}): Promise<RunManifestV2Ledger> {
  const { withTaskLineageTransaction, taskLineageRecordV1Schema } = await import("./task-lineage.js");
  const expected = taskLineageRecordV1Schema.parse(input.lineage);
  const initialManifest = await readManifestV2(input.runDir);
  const repoRoot = resolve(initialManifest.repo_root);
  return withTaskLineageTransaction({
    repoRoot,
    lineageId: expected.lineage_id,
    operation: async (lineageTransaction) => withRunLedgerCompoundTransaction(input.runDir, async (runTransaction) => {
      let manifest = await runTransaction.readManifestV2();
      let lineage = lineageTransaction.read();
      if (manifest.mode !== "github" || manifest.github_effects_protocol !== "task-lineage-v1"
        || manifest.task_lineage_id !== expected.lineage_id || manifest.run_id !== lineage.active_run_id
        || resolve(manifest.repo_root) !== repoRoot
        || lineage.lineage_id !== expected.lineage_id || lineage.repository_key === null
        || JSON.stringify(lineage.issue_set) !== JSON.stringify(expected.issue_set)
        || JSON.stringify(lineage.delivery) !== JSON.stringify(expected.delivery)
        || lineage.root_run_id !== expected.root_run_id || lineage.active_run_id !== expected.active_run_id
        || JSON.stringify(lineage.run_ids) !== JSON.stringify(expected.run_ids)
        || lineage.repository_key !== expected.repository_key) {
        throw new Error("Terminal cleanup requires the exact authoritative lineage snapshot and run binding");
      }
      const reference = manifest.github_effects.issue_sync;
      if (reference === null || lineage.issue_set.preview === null
        || JSON.stringify(reference) !== JSON.stringify(lineage.issue_set.preview)) {
        throw new Error("Terminal cleanup requires the authoritative issue preview reference");
      }
      const { readVerifiedGithubEffectPreview } = await import("../github/effect-plan.js");
      const preview = await readVerifiedGithubEffectPreview({
        run_dir: input.runDir,
        reference,
        expected: {
          phase: "issue_sync",
          lineage_id: lineage.lineage_id,
          run_id: manifest.run_id,
          plan_revision: reference.plan_revision,
          plan_sha256: reference.plan_sha256,
        },
      });
      const previewRepositoryKey = `${preview.repository.host}/${preview.repository.name_with_owner}`.toLowerCase();
      const exactInitialZeroEffects = manifest.stage === "awaiting_github_issue_effects"
        && reference.state === "previewed"
        && reference.plan_revision === (manifest.approved_revision ?? manifest.approved_plan_revision)
        && reference.plan_sha256 === manifest.plan_revisions[String(reference.plan_revision)]?.sha256
        && previewRepositoryKey === lineage.repository_key.toLowerCase()
        && preview.effects.length > 0
        && preview.effects.every((effect) => (effect.target.kind === "parent" || effect.target.kind === "work_item")
          && effect.action === "create" && effect.existing_number === null && effect.observed_sha256 === null)
        && lineage.issue_set.state === "uninitialized"
        && lineage.state === "active"
        && lineage.issue_set.parent_issue_number === null
        && Object.keys(lineage.issue_set.work_item_issue_map).length === 0
        && Object.keys(lineage.issue_set.operations).length === 0
        && manifest.issue_numbers.length === 0
        && Object.keys(manifest.work_item_issue_map).length === 0
        && manifest.github_ids.issue_numbers.length === 0
        && Object.keys(manifest.github_ids.work_item_issue_map ?? {}).length === 0
        && manifest.github_ids.parent_issue_number === null;
      const pristineDelivery = lineage.delivery.state === "uninitialized"
        && lineage.delivery.preview === null
        && lineage.delivery.branch_name === null
        && lineage.delivery.head_sha === null
        && lineage.delivery.pull_request_number === null
        && lineage.delivery.pull_request_url === null
        && lineage.delivery.preview_prior_head_sha === undefined
        && lineage.delivery.head_transition === undefined
        && manifest.github_effects.pull_request_delivery === null
        && manifest.pull_request_numbers.length === 0
        && manifest.github_ids.pull_request_numbers.length === 0
        && Object.keys(manifest.github_ids.pull_request_urls).length === 0
        && (manifest.delivery_state === "pending" || manifest.delivery_state === "blocked")
        && manifest.work_item_progress.integrated?.commit_sha === undefined
        && manifest.work_item_progress.integrated?.push_pending !== true
        && manifest.work_item_progress.integrated?.push_commit_pending !== true;
      let targetNumbers: number[];
      if (reference.state === "applied") {
        const repositoryKey = `${preview.repository.host}/${preview.repository.name_with_owner}`.toLowerCase();
        const { authoritativeReadyIssueNumbers } = await import("../workflow/github-issue-reconciliation.js");
        targetNumbers = authoritativeReadyIssueNumbers({
          repoRoot: manifest.repo_root,
          lineageId: lineage.lineage_id,
          runId: manifest.run_id,
          repositoryKey,
          preview,
        }, lineage);
      } else if (exactInitialZeroEffects && pristineDelivery) {
        targetNumbers = [];
      } else {
        throw new Error("Terminal cleanup requires an applied issue preview or a verified exhaustive zero-side-effect create-only preview at the exact issue boundary");
      }
      const recordedAt = manifest.terminal?.recorded_at ?? input.disposition.recorded_at ?? new Date().toISOString();
      if (manifest.terminal !== null && manifest.terminal.outcome !== input.disposition.outcome) {
        throw new Error(`Run already has terminal outcome ${manifest.terminal.outcome}`);
      }
      const disposition = manifest.terminal ?? terminalDispositionSchema.parse({
        outcome: input.disposition.outcome,
        actor: input.disposition.actor,
        reason: input.disposition.reason,
        residual_risks: input.disposition.residual_risks,
        recorded_at: recordedAt,
        source_stage: manifest.stage,
      }) as TerminalDisposition;
      if (manifest.terminal === null) assertTerminalDispositionAllowed(manifest, disposition);
      const terminalLineageState = lineageStateForTerminalOutcome(disposition.outcome);
      const cleanup = disposition.outcome === "abandoned" || disposition.outcome === "closed_blocked"
        ? manifest.github_cleanup ?? {
            version: 1 as const,
            lineage_id: lineage.lineage_id,
            reason: "not_planned" as const,
            target_numbers: targetNumbers,
            target_sha256: cleanupHash(targetNumbers),
            target_states: Object.fromEntries(targetNumbers.map((number) => [String(number), "pending" as const])),
            state: targetNumbers.length === 0 ? "complete" as const : "pending" as const,
            started_at: recordedAt,
            completed_at: targetNumbers.length === 0 ? recordedAt : null,
          }
        : null;
      if (cleanup !== null && (cleanup.lineage_id !== lineage.lineage_id
        || cleanup.target_sha256 !== cleanupHash(targetNumbers)
        || JSON.stringify(cleanup.target_numbers) !== JSON.stringify(targetNumbers))) {
        throw new Error("Persisted GitHub cleanup batch does not match the authoritative lineage issue set");
      }
      if (lineage.state !== terminalLineageState) {
        lineage = await lineageTransaction.update({
          ...lineage,
          state: terminalLineageState,
          cleanup_state: cleanup === null ? lineage.cleanup_state : cleanup.state,
        });
      } else if (cleanup !== null && lineage.cleanup_state !== cleanup.state) {
        lineage = await lineageTransaction.update({ ...lineage, cleanup_state: cleanup.state });
      }
      if (manifest.assurance_outcome === null) {
        const assurance = disposition.outcome === "human_accepted" ? "human_accepted"
          : disposition.outcome === "abandoned" ? "abandoned"
            : disposition.outcome === "closed_blocked" ? "blocked" : null;
        if (assurance !== null) manifest = await runTransaction.updateManifestV2({ assurance_outcome: assurance });
      }
      const persisted = await recordCoordinatedTerminalDisposition(runTransaction, disposition, cleanup);
      const events = (await readFile(join(runTransaction.runDir, "events.jsonl"), "utf8"))
        .split("\n").filter(Boolean).flatMap((line) => {
          try { return [JSON.parse(line) as RunEventRecord]; } catch { return []; }
        });
      if (!events.some((event) => event.type === "run_terminalized"
        && event.payload.outcome === disposition.outcome
        && event.payload.recorded_at === disposition.recorded_at)) {
        await appendRunEvent(runTransaction.runDir, {
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
      return persisted;
    }),
  });
}

/** Close a run without rewriting its operational stage or delivery proof. */
export async function recordTerminalDisposition(
  runDir: string,
  input: RecordTerminalDispositionInput,
): Promise<RunManifestV2Ledger> {
  const result = await withRunLedgerCompoundTransaction(runDir, async (transaction) => {
    const current = await transaction.readManifestV2();
    const disposition = terminalDispositionSchema.parse({
      outcome: input.outcome,
      actor: input.actor,
      reason: input.reason,
      residual_risks: input.residual_risks,
      recorded_at: input.recorded_at ?? current.terminal?.recorded_at ?? new Date().toISOString(),
      source_stage: current.terminal?.source_stage ?? current.stage,
    }) as TerminalDisposition;
    const persisted = await transaction.recordTerminalDisposition(disposition);
    const events = (await readFile(join(transaction.runDir, "events.jsonl"), "utf8"))
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try { return [JSON.parse(line) as RunEventRecord]; } catch { return []; }
      });
    const alreadyRecorded = events.some((event) =>
      event.type === "run_terminalized"
      && event.payload.outcome === disposition.outcome
      && event.payload.recorded_at === disposition.recorded_at);
    if (!alreadyRecorded) {
      await appendRunEvent(transaction.runDir, {
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
    return persisted;
  });
  try {
    await finalizeSession(runDir);
  } catch {
    // Canonical session telemetry is fail-open after the authoritative disposition is durable.
  }
  return result;
}

export async function transitionRun(
  runDir: string,
  to: RunStageV2,
  options: TransitionRunOptions | string = {},
  payload?: Record<string, unknown>,
): Promise<RunManifestV2Ledger> {
  return withRunLedgerCompoundTransaction(runDir, (transaction) =>
    transitionRunInTransaction(transaction, to, options, payload));
}

export async function retryVerifierReviewAfterInvalidReplanContract(
  runDir: string,
  input: { workItemId: string; blocker: string },
): Promise<RunManifestV2Ledger> {
  return withRunLedgerCompoundTransaction(runDir, async (transaction) => {
    const manifest = await transaction.readManifestV2();
    const progress = manifest.work_item_progress[input.workItemId];
    if (manifest.stage === "verifier_review" && progress?.replan_contract_retry_used === true) {
      if (
        manifest.current_work_item_id !== input.workItemId
        || progress.blocker !== input.blocker
        || manifest.last_blocker !== input.blocker
      ) {
        throw new Error("Conflicting Verifier-contract retry replay");
      }
      return manifest;
    }
    if (manifest.stage !== "replanning") {
      throw new Error(`Invalid Verifier-contract retry stage: ${manifest.stage}`);
    }
    if (manifest.current_work_item_id !== input.workItemId || !progress) {
      throw new Error("Invalid Verifier-contract retry work-item identity");
    }
    if (progress.replan_contract_retry_used === true) {
      throw new Error(`Verifier-contract retry already used for work item ${input.workItemId}`);
    }
    if (
      typeof progress.review_path !== "string"
      || typeof progress.verification_path !== "string"
      || typeof progress.review_revision !== "number"
      || typeof progress.review_cycle_path !== "string"
      || typeof progress.review_effect_id !== "string"
    ) {
      throw new Error("Invalid Verifier-contract retry requires immutable review, verification, and replan-cycle evidence");
    }
    if (!input.blocker.startsWith("invalid_verifier_contract:")) {
      throw new Error("Invalid Verifier-contract retry blocker");
    }

    const nextProgress = { ...progress };
    nextProgress.status = "blocked";
    nextProgress.blocker = input.blocker;
    nextProgress.blocker_code = "operational_blocker";
    nextProgress.replan_contract_retry_used = true;
    delete nextProgress.review_revision;
    delete nextProgress.review_cycle_path;
    delete nextProgress.review_effect_id;
    delete nextProgress.replan_patch_path;
    delete nextProgress.replan_target_work_item_id;
    delete nextProgress.replan_source_work_item_id;
    delete nextProgress.queue_state;
    delete nextProgress.queue_path;
    delete nextProgress.active_action_id;
    delete nextProgress.active_action_attempt;
    delete nextProgress.completed_action_ids;
    delete nextProgress.focused_review_path;

    const eventId = `invalid-replan-contract-retry:${createHash("sha256")
      .update(`${manifest.run_id}\0${input.workItemId}\0${progress.review_path}\0${progress.verification_path}`)
      .digest("hex")}`;
    await appendRunEventOnceLocked(transaction, {
      eventId,
      actor: "runtime",
      stage: "verifier_review",
      type: "invalid_replan_contract_retry",
      payload: {
        work_item_id: input.workItemId,
        review_path: progress.review_path,
        verification_path: progress.verification_path,
      },
    });
    return transaction.updateManifestV2({
      stage: "verifier_review",
      delivery_state: "blocked",
      last_blocker: input.blocker,
      work_item_progress: {
        ...manifest.work_item_progress,
        [input.workItemId]: nextProgress,
      },
    });
  });
}

async function transitionRunInTransaction(
  transaction: RunLedgerTransaction,
  to: RunStageV2,
  options: TransitionRunOptions | string,
  payload?: Record<string, unknown>,
): Promise<RunManifestV2Ledger> {
  const runDir = transaction.runDir;
  const manifest = await transaction.readManifestV2();
  if (manifest.abandonment_path || manifest.assurance_outcome === "abandoned") {
    throw new Error("Abandoned runs cannot transition to another workflow stage");
  }
  const normalized = typeof options === "string" ? { actor: options, payload } : options;
  assertTerminalManifestMutationAllowed(manifest, { stage: to });
  assertTransition(manifest.stage, to, manifest.workflow_protocol, manifest.github_effects_protocol);
  if (to === "delivery") {
    if (manifest.stage !== "verifier_review") {
      throw new Error("Delivery requires the verifier_review stage");
    }
    if (normalized.payload?.verifier_approved !== true) {
      throw new Error("Delivery requires verifier_approved=true");
    }
    if (normalized.payload?.final !== true) {
      throw new Error("Delivery requires final=true");
    }
    if (normalized.payload?.work_item_id !== "integrated") {
      throw new Error("Delivery requires work_item_id=integrated");
    }
    if ("final_issue_number" in (normalized.payload ?? {})) {
      throw new Error("Integrated delivery cannot carry final_issue_number");
    }
    const reviewPath = normalized.payload.final_review_path;
    if (typeof reviewPath !== "string" || reviewPath.trim() === "") {
      throw new Error("Delivery requires final_review_path");
    }
    const reviewMatch = reviewPath.match(/^reviews\/integrated\/final-attempt-(\d+)\.json$/i);
    if (!reviewMatch) throw new Error("Delivery final_review_path must be reviews/integrated/final-attempt-N.json");
    const verificationPath = normalized.payload.final_verification_path;
    if (typeof verificationPath !== "string" || verificationPath.trim() === "") {
      throw new Error("Delivery requires final_verification_path");
    }
    const verificationMatch = verificationPath.match(/^verification\/integrated\/attempt-(\d+)\/evidence\.json$/i);
    if (!verificationMatch || verificationMatch[1] !== reviewMatch[1]) {
      throw new Error("Delivery final verification path must match verification/integrated/attempt-N and review attempt");
    }
    const eventsRaw = await readFile(join(runDir, "events.jsonl"), "utf8");
    if (!manifest.final_artifact_paths.includes(reviewPath) || !manifest.final_artifact_paths.includes(verificationPath)) {
      throw new Error("Delivery final artifact paths are not current in the manifest");
    }
    const expectedPass = Number(reviewMatch[1]);
    const reviewAbsolutePath = resolveAndValidateArtifactPath(runDir, reviewPath);
    const verificationAbsolutePath = resolveAndValidateArtifactPath(runDir, verificationPath);
    let review: unknown;
    try {
      review = JSON.parse(await readFile(reviewAbsolutePath, "utf8")) as unknown;
    } catch (error) {
      throw new Error(`Final Verifier review artifact is not readable: ${reviewPath}`, { cause: error });
    }
    const parsedReview = persistedVerifierReviewSchema.parse(review);
    if (parsedReview.work_item_id !== "integrated" || parsedReview.final !== true || parsedReview.attempt !== expectedPass) {
      throw new Error("Final Verifier review provenance does not match the delivery attempt");
    }
    if (parsedReview.decision !== "approve") {
      const progress = manifest.work_item_progress.integrated;
      if (!manifest.review_policy_snapshot || !progress?.review_cycle_path || !progress.review_effect_id) {
        throw new Error("Delivery requires an approving final Verifier review or immutable policy proof");
      }
      const cycle = reviewCycleStateSchema.parse(JSON.parse(await readFile(resolveAndValidateArtifactPath(runDir, progress.review_cycle_path), "utf8")));
      if (
        cycle.decision_path !== progress.review_cycle_path
        || cycle.effect_id !== progress.review_effect_id
        || cycle.work_item_id !== "integrated"
        || cycle.review_revision !== progress.review_revision
        || (cycle.decision.action !== "advance" && cycle.decision.action !== "continue_with_warning")
        || (cycle.phase !== "final_integrated" && cycle.phase !== "post_pr")
      ) throw new Error("Delivery immutable policy cycle proof is invalid");
      const summary = manifest.convergence_reports?.integrated;
      if (!summary || summary.review_revision !== cycle.review_revision || summary.recommended_action !== "advance") {
        throw new Error("Delivery immutable policy convergence proof is invalid");
      }
      const convergence = convergenceReportSchema.parse(JSON.parse(await readFile(resolveAndValidateArtifactPath(runDir, summary.path), "utf8")));
      if (
        convergence.work_item_id !== "integrated"
        || convergence.review_revision !== cycle.review_revision
        || !convergence.evidence_refs.includes(reviewPath)
        || !convergence.evidence_refs.includes(verificationPath)
      ) throw new Error("Delivery immutable policy convergence evidence is invalid");
      if (cycle.decision.action === "continue_with_warning") {
        if (!convergence.authorization || !manifest.warning_continuation_authority) {
          throw new Error("Delivery warning continuation requires durable authorization proof");
        }
        const authorizationPath = `authorizations/${Buffer.from(cycle.work_item_id, "utf8").toString("base64url")}/revision-${cycle.review_revision}.json`;
        const authorization = warningContinuationAuthorizationSchema.parse(JSON.parse(
          await readFile(resolveAndValidateArtifactPath(runDir, authorizationPath), "utf8"),
        ));
        if (
          JSON.stringify(authorization) !== JSON.stringify(convergence.authorization)
          || authorization.actor !== manifest.warning_continuation_authority.actor
          || authorization.source !== manifest.warning_continuation_authority.source
          || authorization.policy_revision !== cycle.decision.policy_revision
          || JSON.stringify(authorization.finding_ids) !== JSON.stringify(convergence.unresolved_finding_ids)
          || !authorization.evidence_snapshot.includes(reviewPath)
          || !authorization.evidence_snapshot.includes(verificationPath)
          || authorization.evidence_snapshot.some((path) => !convergence.evidence_refs.includes(path))
        ) throw new Error("Delivery warning continuation authorization provenance is invalid");
      } else if (convergence.unresolved_finding_ids.length > 0 || convergence.authorization !== null) {
        throw new Error("Delivery advance proof cannot contain unresolved unauthorized findings");
      }
      const completionPath = `reviews/effects/${Buffer.from(cycle.effect_id, "utf8").toString("base64url")}/completion.json`;
      const completion = reviewCycleStateSchema.parse(JSON.parse(await readFile(resolveAndValidateArtifactPath(runDir, completionPath), "utf8")));
      if (
        completion.effect_state !== "complete"
        || completion.cycle_id !== cycle.cycle_id
        || completion.effect_id !== cycle.effect_id
        || completion.decision_path !== cycle.decision_path
        || completion.effect_owner !== `runtime:${cycle.phase}:integrated`
      ) throw new Error("Delivery immutable completed advance effect proof is invalid");
    }
    let verification: unknown;
    try {
      verification = JSON.parse(await readFile(verificationAbsolutePath, "utf8")) as unknown;
    } catch (error) {
      throw new Error(`Final verification artifact is not readable: ${verificationPath}`, { cause: error });
    }
    const parsedVerification = verificationEvidenceSchema.parse(verification);
    if (parsedVerification.evidence_path !== verificationPath || parsedVerification.verification_scope !== "integrated" || parsedVerification.work_item_id !== "integrated" || "issue_number" in parsedVerification || parsedVerification.attempt !== expectedPass) {
      throw new Error("Final verification evidence does not match the delivery payload");
    }
    if (parsedVerification.commands.length === 0) {
      throw new Error("Final verification evidence must contain command artifacts");
    }
    const expectedEvidencePrefix = `verification/integrated/attempt-${expectedPass}/`;
    for (const command of parsedVerification.commands) {
      if (!command.stdout_path.startsWith(expectedEvidencePrefix) || !command.stderr_path.startsWith(expectedEvidencePrefix) || (command.result_path && !command.result_path.startsWith(expectedEvidencePrefix))) {
        throw new Error("Final verification command artifacts do not match the delivery attempt");
      }
    }
    for (const browser of parsedVerification.browser_evidence) {
      if (!browser.screenshot_artifact.startsWith(expectedEvidencePrefix) || (browser.evidence_report_path && !browser.evidence_report_path.startsWith(expectedEvidencePrefix))) {
        throw new Error("Final verification browser artifacts do not match the delivery attempt");
      }
    }

    const events = eventsRaw
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as {
            run_id?: string;
            stage?: string;
            type?: string;
            actor?: string;
            payload?: Record<string, unknown>;
          }];
        } catch {
          return [];
        }
      });
    const finalVerificationEventIndex = events.reduce((lastIndex, event, index) =>
      event.run_id === manifest.run_id &&
      event.stage === "final_verification" &&
      event.type === "transition" &&
      event.actor === "runtime" &&
      event.payload?.work_item_id === "integrated" &&
      event.payload?.final === true &&
      event.payload?.pass === expectedPass
        ? index
        : lastIndex,
      -1,
    );
    const finalReviewEventIndex = events.findIndex((event, index) =>
      index > finalVerificationEventIndex &&
      event.run_id === manifest.run_id &&
      event.stage === "verifier_review" &&
      event.type === "transition" &&
      event.actor === "runtime" &&
      event.payload?.work_item_id === "integrated" &&
      event.payload?.final === true &&
      event.payload?.pass === expectedPass,
    );
    if (finalVerificationEventIndex < 0 || finalReviewEventIndex < 0) {
      throw new Error("Delivery requires a matching final_verification and final Verifier review event");
    }
  }
  const event = await appendRunEvent(runDir, {
    actor: normalized.actor ?? "system",
    stage: to,
    type: "transition",
    payload: normalized.payload,
  });
  return transaction.updateManifestV2({ stage: to });
}

/** Update durable v2 fields without changing the current stage. */
export async function updateManifestV2(
  runDir: string,
  patch: MutableRunManifestV2Patch,
): Promise<RunManifestV2Ledger> {
  assertMutableManifestPatch(patch);
  const result = await withRunLedgerTransaction(runDir, (transaction) => transaction.updateManifestV2(patch));
  if (patch.assurance_outcome !== undefined) {
    try {
      await finalizeSession(runDir);
    } catch {
      // Canonical session telemetry is fail-open after the authoritative assurance is durable.
    }
  }
  return result;
}

export async function acquireExecutionLease(
  runDir: string,
  input: { invocationId?: string; mode?: ExecutionLeaseV1["mode"] } = {},
): Promise<ExecutionLeaseClaim> {
  return withRunLedgerTransaction(runDir, (transaction) => transaction.acquireExecutionLease({
    invocation_id: input.invocationId ?? randomUUID(),
    mode: input.mode ?? "execution",
  }));
}

export async function assertExecutionLease(runDir: string, claim: ExecutionLeaseClaim): Promise<void> {
  await withRunLedgerTransaction(runDir, (transaction) => transaction.assertExecutionLease(claim));
}

export async function releaseExecutionLease(runDir: string, claim: ExecutionLeaseClaim): Promise<RunManifestV2Ledger> {
  return withRunLedgerTransaction(runDir, (transaction) => transaction.releaseExecutionLease(claim));
}

export async function beginExecutionEffect(
  runDir: string,
  claim: ExecutionLeaseClaim,
  kind: string,
  invocationId = randomUUID(),
): Promise<string> {
  await withRunLedgerTransaction(runDir, (transaction) =>
    transaction.beginExecutionEffect(claim, kind, invocationId));
  return invocationId;
}

export async function recordExecutionEffectChild(
  runDir: string,
  claim: ExecutionLeaseClaim,
  invocationId: string,
  pid: number | null,
): Promise<void> {
  await withRunLedgerTransaction(runDir, (transaction) =>
    transaction.recordExecutionEffectChild(claim, invocationId, pid));
}

export async function endExecutionEffect(
  runDir: string,
  claim: ExecutionLeaseClaim,
  invocationId: string,
): Promise<void> {
  await withRunLedgerTransaction(runDir, (transaction) =>
    transaction.endExecutionEffect(claim, invocationId));
}

export async function setRunCheckoutIdentity(
  runDir: string,
  claim: ExecutionLeaseClaim,
  checkout: { worktreePath: string; branchName: string },
): Promise<RunManifestV2Ledger> {
  return withRunLedgerTransaction(runDir, (transaction) =>
    transaction.setRunCheckoutIdentity(claim, checkout));
}

export async function markRunCheckoutReady(
  runDir: string,
  claim: ExecutionLeaseClaim,
): Promise<RunManifestV2Ledger> {
  return withRunLedgerTransaction(runDir, (transaction) => transaction.markRunCheckoutReady(claim));
}

/** Compare-and-set the engine-owned accounting summary under the run ledger lock. */
export async function updateReviewAccounting(
  runDir: string,
  expected: ReviewAccounting,
  next: ReviewAccounting,
): Promise<ReviewAccounting> {
  return withRunLedgerTransaction(runDir, (transaction) =>
    transaction.updateReviewAccounting(expected, next));
}

export async function recordPlan(
  runDir: string,
  planText: string,
): Promise<PlanRevisionRecord> {
  return withRunLedgerCompoundTransaction(runDir, async (transaction) => {
    const manifest = await transaction.readManifestV2();
    if (manifest.terminal !== null) throw new Error(`Cannot mutate run with terminal outcome ${manifest.terminal.outcome}`);
    const currentRevision = manifest.current_revision ?? manifest.current_plan_revision ?? 0;
    const revision = currentRevision + 1;
    const sha256 = createHash("sha256").update(planText, "utf8").digest("hex");
    const relativePath = `plans/revision-${revision}.md`;
    await writeTextArtifact(transaction.runDir, relativePath, planText);
    const path = resolve(transaction.runDir, relativePath);
    const record = { revision, path, sha256 };
    await transaction.updateManifestV2({
      current_revision: revision,
      current_plan_revision: revision,
      plan_revisions: { ...manifest.plan_revisions, [String(revision)]: record },
    });
    return record;
  });
}

/** Commit an already-persisted replan revision and request as one pending approval boundary. */
export async function commitPreparedPlanApprovalBoundary(input: {
  runDir: string;
  baseRevision: number;
  proposedRevision: number;
  revision: PlanRevision;
  pending: PendingPlanApprovalV1;
  expectedManifest: RunManifestV2Ledger;
  runConfigurationSha256: string;
  canonicalBlocker: string;
}): Promise<RunManifestV2Ledger> {
  return withRunLedgerTransaction(input.runDir, (transaction) =>
    transaction.commitPreparedPlanApprovalBoundary({
      base_revision: input.baseRevision,
      proposed_revision: input.proposedRevision,
      revision: input.revision,
      pending: input.pending,
      expected_manifest: input.expectedManifest,
      run_configuration_sha256: input.runConfigurationSha256,
      canonical_blocker: input.canonicalBlocker,
    }));
}

export async function rejectPreparedPlanApprovalBoundary(input: {
  runDir: string;
  revision: number;
  rejectionPath: string;
  rejectionSha256: string;
  blocker: string;
}): Promise<RunManifestV2Ledger> {
  return withRunLedgerTransaction(input.runDir, (transaction) =>
    transaction.rejectPreparedPlanApprovalBoundary({
      revision: input.revision,
      rejection_path: input.rejectionPath,
      rejection_sha256: input.rejectionSha256,
      blocker: input.blocker,
    }));
}

/** Normalize one exact pending replan boundary, or return a concurrent promotion unchanged. */
export async function reconcilePreparedPlanApprovalBoundary(input: {
  runDir: string;
  baseRevision: number;
  proposedRevision: number;
  pending: PendingPlanApprovalV1;
  canonicalBlocker: string;
}): Promise<{ state: "pending" | "approved"; manifest: RunManifestV2Ledger }> {
  if (input.proposedRevision <= input.baseRevision || input.canonicalBlocker.trim() === "") {
    throw new Error("Prepared plan approval reconciliation coordinates are invalid");
  }
  return withRunLedgerCompoundTransaction(input.runDir, async (transaction) => {
    const current = await transaction.readManifestV2();
    const revision = current.plan_revisions[String(input.proposedRevision)];
    const revisionMatches = revision?.revision === input.proposedRevision
      && revision.origin === "replan"
      && revision.base_revision === input.baseRevision
      && revision.approval_request_path === input.pending.request_path
      && revision.approval_request_sha256 === input.pending.request_sha256
      && revision.approval_subject_sha256 === input.pending.approval_subject_sha256;
    if (!revisionMatches) throw new Error("Prepared plan approval reconciliation revision binding is invalid");
    const approved = current.pending_plan_approval === null
      && current.current_revision === input.proposedRevision
      && current.current_plan_revision === input.proposedRevision
      && current.approved_revision === input.proposedRevision
      && current.approved_plan_revision === input.proposedRevision;
    if (approved) return { state: "approved", manifest: current };
    const pending = current.stage === "awaiting_plan_approval"
      && current.current_revision === input.baseRevision
      && current.current_plan_revision === input.baseRevision
      && current.approved_revision === input.baseRevision
      && current.approved_plan_revision === input.baseRevision
      && JSON.stringify(current.pending_plan_approval) === JSON.stringify(input.pending);
    if (!pending) throw new Error("Prepared plan approval reconciliation lost its exact pending coordinates");
    const manifest = current.delivery_state === "blocked" && current.last_blocker === input.canonicalBlocker
      ? current
      : await transaction.updateManifestV2({
          delivery_state: "blocked",
          last_blocker: input.canonicalBlocker,
        });
    return { state: "pending", manifest };
  });
}

function claimedInitialPlanCandidatePath(invocationId: string): string {
  if (!z.string().uuid().safeParse(invocationId).success) throw new Error("Claimed plan invocation ID must be a UUID");
  return `plans/candidates/${invocationId}.json`;
}

export async function persistClaimedInitialPlanCandidate(input: ClaimedInitialPlanCandidate & {
  runDir: string;
}): Promise<ClaimedInitialPlanCandidate> {
  const { runDir: _runDir, ...candidateInput } = input;
  const candidate = claimedInitialPlanCandidateSchema.parse(candidateInput);
  const path = claimedInitialPlanCandidatePath(candidate.invocation_id);
  const text = `${JSON.stringify(candidate, null, 2)}\n`;
  return withRunLedgerCompoundTransaction(input.runDir, async (transaction) => {
    const manifest = await transaction.readManifestV2();
    const claim = manifest.brain_controller_claim;
    if (manifest.stage !== "brain_planning" || claim?.invocation_id !== candidate.invocation_id
      || claim.artifact_name !== candidate.artifact_name) {
      throw new Error("Claimed plan candidate does not match the active Brain planning claim");
    }
    const approvedRevision = usesDurableDiscoveryProtocol(manifest.workflow_protocol)
      ? manifest.discovery?.approved_brief_revision ?? null : null;
    const approvedSha = usesDurableDiscoveryProtocol(manifest.workflow_protocol)
      ? manifest.discovery?.approved_brief_sha256 ?? null : null;
    if (candidate.approved_discovery_brief_revision !== approvedRevision
      || candidate.approved_discovery_brief_sha256 !== approvedSha) {
      throw new Error("Claimed plan candidate does not match the approved discovery brief");
    }
    try {
      await writeOwnedEvidenceFile(transaction.runDir, path, "plans/", text);
    } catch (error: unknown) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      if ((await readOwnedEvidenceFile(transaction.runDir, path, "plans/")).toString("utf8") !== text) {
        throw new Error("Claimed plan candidate conflicts with immutable candidate evidence");
      }
    }
    return candidate;
  });
}

export async function readClaimedInitialPlanCandidate(
  runDir: string,
  invocationId: string,
): Promise<ClaimedInitialPlanCandidate | null> {
  const path = claimedInitialPlanCandidatePath(invocationId);
  let text: string;
  try {
    text = (await readOwnedEvidenceFile(runDir, path, "plans/")).toString("utf8");
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
  const candidate = claimedInitialPlanCandidateSchema.parse(JSON.parse(text));
  if (text !== `${JSON.stringify(candidate, null, 2)}\n` || candidate.invocation_id !== invocationId) {
    throw new Error("Claimed plan candidate bytes or invocation binding are invalid");
  }
  return candidate;
}

async function ensureClaimedInitialPlanBoundaryEvent(
  runDir: string,
  manifest: RunManifestV2Ledger,
  revision: PlanRevisionRecord,
): Promise<void> {
  const events = (await readOwnedRunFile(runDir, "events.jsonl")).toString("utf8")
    .split("\n").filter(Boolean).map((line) => runEventSchema.parse(JSON.parse(line)) as RunEventRecord);
  const semantic = events.filter((event) => event.type === "transition"
    && event.stage === "awaiting_plan_approval"
    && (event.event_id.startsWith("claimed-plan-ready:")
      || event.payload.revision !== undefined
      || event.payload.plan_path !== undefined
      || event.payload.candidate_path !== undefined
      || event.payload.candidate_invocation_id !== undefined));
  if (semantic.some((event) => event.run_id !== manifest.run_id)) {
    throw new Error("Claimed Brain plan approval-boundary event has wrong run_id");
  }
  if (semantic.length > 1) throw new Error("Claimed Brain plan has duplicate approval-boundary events");
  if (semantic.length === 1) {
    const [event] = semantic;
    if (event.actor !== "brain" || event.payload.revision !== revision.revision || event.payload.plan_path !== revision.path
      || event.payload.candidate_path !== revision.candidate_path
      || event.payload.candidate_invocation_id !== revision.candidate_invocation_id) {
      throw new Error("Claimed Brain plan has a conflicting approval-boundary event");
    }
    return;
  }
  const event: RunEventRecord = {
    event_id: `claimed-plan-ready:${createHash("sha256").update(`${manifest.run_id}:${revision.revision}:${revision.sha256}:${revision.candidate_invocation_id ?? "legacy"}`).digest("hex")}`,
    run_id: manifest.run_id,
    stage: "awaiting_plan_approval",
    type: "transition",
    timestamp: manifest.updated_at,
    actor: "brain",
    payload: {
      revision: revision.revision,
      plan_path: revision.path,
      candidate_path: revision.candidate_path,
      candidate_invocation_id: revision.candidate_invocation_id,
    },
  };
  await appendOwnedRunFile(runDir, "events.jsonl", `${JSON.stringify(event)}\n`);
}

/** Reconcile only the deterministic initial-plan approval boundary after a committed crash. */
export async function reconcileClaimedInitialPlanBoundary(runDir: string): Promise<RunManifestV2Ledger> {
  return withRunLedgerCompoundTransaction(runDir, async (transaction) => {
    const manifest = await transaction.readManifestV2();
    if (manifest.stage !== "awaiting_plan_approval"
      || (manifest.current_revision ?? manifest.current_plan_revision) !== 1
      || manifest.plan_revisions["1"] === undefined) return manifest;
    const revision = manifest.plan_revisions["1"];
    if (revision.candidate_path === undefined || revision.candidate_invocation_id === undefined) return manifest;
    const expectedCandidatePath = claimedInitialPlanCandidatePath(revision.candidate_invocation_id);
    if (revision.candidate_path !== expectedCandidatePath) {
      throw new Error("Claimed Brain plan revision candidate path is not canonical");
    }
    const candidate = await readClaimedInitialPlanCandidate(transaction.runDir, revision.candidate_invocation_id);
    if (candidate === null || createHash("sha256").update(candidate.plan_text, "utf8").digest("hex") !== revision.sha256) {
      throw new Error("Claimed Brain plan discovery brief SHA-256 or bytes do not match its exact immutable candidate");
    }
    const approvedRevision = usesDurableDiscoveryProtocol(manifest.workflow_protocol)
      ? manifest.discovery?.approved_brief_revision ?? null : null;
    const approvedSha = usesDurableDiscoveryProtocol(manifest.workflow_protocol)
      ? manifest.discovery?.approved_brief_sha256 ?? null : null;
    if (candidate.approved_discovery_brief_revision !== approvedRevision
      || candidate.approved_discovery_brief_sha256 !== approvedSha) {
      throw new Error("Claimed Brain plan candidate does not match the current approved discovery brief binding");
    }
    const persisted = (await readOwnedEvidenceFile(transaction.runDir, "plans/revision-1.md", "plans/")).toString("utf8");
    if (createHash("sha256").update(persisted, "utf8").digest("hex") !== revision.sha256
      || (revision.path !== "plans/revision-1.md"
        && revision.path !== resolve(transaction.runDir, "plans/revision-1.md"))) {
      throw new Error("Claimed Brain plan revision does not match its canonical committed evidence");
    }
    if (revision.approval_request_path !== undefined && manifest.pending_plan_approval !== null) {
      await readVerifiedPlanApprovalRequest(transaction.runDir, manifest);
    }
    await ensureClaimedInitialPlanBoundaryEvent(transaction.runDir, manifest, revision);
    return manifest;
  });
}

/** Commit the claim-owned initial plan candidate and its approval boundary as one ledger mutation. */
export async function commitClaimedInitialPlan(input: {
  runDir: string;
  controllerClaimToken: string;
  approvalRequest?: PlanApprovalRequestV1;
}): Promise<{ revision: PlanRevisionRecord; manifest: RunManifestV2Ledger }> {
  return withRunLedgerCompoundTransaction(input.runDir, async (transaction) => {
    const manifest = await transaction.readManifestV2();
    const candidate = await readClaimedInitialPlanCandidate(transaction.runDir, input.controllerClaimToken);
    if (candidate === null) throw new Error("Claimed Brain plan candidate is missing");
    const sha256 = createHash("sha256").update(candidate.plan_text, "utf8").digest("hex");
    const relativePath = "plans/revision-1.md";
    const approvalRequest = input.approvalRequest === undefined
      ? null
      : planApprovalRequestSchema.parse(input.approvalRequest);
    if (manifest.run_configuration_sha256 !== null && approvalRequest === null) {
      throw new Error("Pinned runs require an immutable initial plan approval request");
    }
    if (approvalRequest !== null && (
      approvalRequest.subject.reason_code !== "initial_plan"
      || approvalRequest.subject.run_id !== manifest.run_id
      || approvalRequest.subject.plan_revision !== 1
      || approvalRequest.subject.base_plan_revision !== null
      || approvalRequest.subject.plan_sha256 !== sha256
      || approvalRequest.plan_path !== relativePath
      || approvalRequest.delta.base_revision !== null
      || approvalRequest.delta.proposed_revision !== 1
      || approvalSha256(approvalRequest.subject) !== approvalRequest.approval_subject_sha256
    )) throw new Error("Initial plan approval request does not match the claimed candidate");
    if (approvalRequest !== null) {
      let plan: BrainPlan;
      try {
        plan = parsePersistedPlan(JSON.parse(candidate.plan_text), manifest.workflow_protocol);
      } catch (error) {
        throw new Error("Initial plan approval request candidate is not a valid persisted plan", { cause: error });
      }
      await verifyDiscoveryPrerequisite(transaction.runDir, manifest, plan);
      const runConfiguration = await readCanonicalRunConfiguration(transaction.runDir, manifest);
      const delta = buildPlanDelta(null, plan, { baseRevision: null, proposedRevision: 1 });
      const expectedRequest = buildPlanApprovalRequest({
        manifest,
        runConfiguration,
        reasonCode: "initial_plan",
        revision: 1,
        baseRevision: null,
        planPath: relativePath,
        planSha256: sha256,
        decisionContractSha256: planDecisionContractSha256(plan),
        delta,
        reconstructInitialAuthority: true,
      });
      if (serializePlanApprovalRequest(expectedRequest) !== serializePlanApprovalRequest(approvalRequest)) {
        throw new Error("Initial plan approval request does not match the exact candidate-bound request");
      }
    }
    const existingRevision = manifest.plan_revisions["1"];
    if (manifest.stage === "awaiting_plan_approval"
      && (manifest.current_revision ?? manifest.current_plan_revision) === 1
      && existingRevision?.sha256 === sha256
      && existingRevision.candidate_path === claimedInitialPlanCandidatePath(input.controllerClaimToken)
      && existingRevision.candidate_invocation_id === input.controllerClaimToken) {
      const persisted = (await readOwnedEvidenceFile(transaction.runDir, relativePath, "plans/")).toString("utf8");
      if (persisted !== candidate.plan_text) throw new Error("Claimed Brain plan bytes do not match the committed revision");
      if (approvalRequest !== null) {
        const pointer = await approvalPointerForRevision(transaction.runDir, manifest, 1);
        if (pointer === null) {
          throw new Error("Claimed Brain plan approval request metadata is missing");
        }
        const existingRequest = await readVerifiedPlanApprovalRequest(
          transaction.runDir,
          manifest.pending_plan_approval === null
            ? { ...manifest, pending_plan_approval: pointer }
            : manifest,
        );
        if (serializePlanApprovalRequest(existingRequest) !== serializePlanApprovalRequest(approvalRequest)) {
          throw new Error("Claimed Brain plan approval request conflicts with the immutable candidate-bound request");
        }
      }
      await ensureClaimedInitialPlanBoundaryEvent(transaction.runDir, manifest, existingRevision);
      return { revision: existingRevision, manifest };
    }
    if (manifest.terminal !== null) throw new Error(`Cannot mutate run with terminal outcome ${manifest.terminal.outcome}`);
    if (manifest.stage !== "brain_planning") throw new Error("Claimed Brain plan can only be committed during brain_planning");
    if ((manifest.current_revision ?? manifest.current_plan_revision) !== null) {
      throw new Error("Claimed Brain plan requires no current plan revision");
    }
    if (manifest.brain_controller_claim?.invocation_id !== input.controllerClaimToken) {
      throw new Error("Brain plan controller claim does not match the committing invocation");
    }
    if (manifest.brain_controller_claim.artifact_name !== candidate.artifact_name) {
      throw new Error("Brain plan candidate does not match the committing claim artifact");
    }
    const approvedRevision = usesDurableDiscoveryProtocol(manifest.workflow_protocol)
      ? manifest.discovery?.approved_brief_revision ?? null : null;
    const approvedSha = usesDurableDiscoveryProtocol(manifest.workflow_protocol)
      ? manifest.discovery?.approved_brief_sha256 ?? null : null;
    if (candidate.approved_discovery_brief_revision !== approvedRevision
      || candidate.approved_discovery_brief_sha256 !== approvedSha) {
      throw new Error("Brain plan candidate approved discovery binding changed before commit");
    }
    for (const [path, content] of Object.entries(candidate.artifacts)) {
      await writeTextArtifact(transaction.runDir, path, content);
    }
    try {
      await writeOwnedEvidenceFile(transaction.runDir, relativePath, "plans/", candidate.plan_text);
    } catch (error: unknown) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      const existing = (await readOwnedEvidenceFile(transaction.runDir, relativePath, "plans/")).toString("utf8");
      if (existing !== candidate.plan_text) throw new Error("Claimed Brain plan conflicts with orphaned revision bytes");
    }
    let approvalRecord: { path: string; sha256: string } | null = null;
    if (approvalRequest !== null) {
      try {
        approvalRecord = await writePlanApprovalRequest(transaction.runDir, approvalRequest);
      } catch (error: unknown) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
        const existing = (await readOwnedRunFile(
          transaction.runDir,
          planApprovalRequestPath(1),
        )).toString("utf8");
        if (existing !== serializePlanApprovalRequest(approvalRequest)) {
          throw new Error("Claimed Brain plan conflicts with orphaned approval request bytes");
        }
        approvalRecord = { path: planApprovalRequestPath(1), sha256: requestSha256(approvalRequest) };
      }
    }
    const revision = {
      revision: 1,
      path: relativePath,
      sha256,
      candidate_path: claimedInitialPlanCandidatePath(input.controllerClaimToken),
      candidate_invocation_id: input.controllerClaimToken,
      ...(approvalRequest !== null && approvalRecord !== null ? {
        origin: "initial" as const,
        base_revision: null,
        approval_request_path: approvalRecord.path,
        approval_request_sha256: approvalRecord.sha256,
        approval_subject_sha256: approvalRequest.approval_subject_sha256,
        decision_contract_sha256: approvalRequest.subject.decision_contract_sha256,
      } : {}),
    };
    const pending = approvalRequest === null || approvalRecord === null ? null : {
      schema_version: 1 as const,
      proposed_revision: 1,
      base_revision: null,
      request_path: approvalRecord.path,
      request_sha256: approvalRecord.sha256,
      approval_subject_sha256: approvalRequest.approval_subject_sha256,
    };
    const committed = pending === null
      ? await transaction.updateManifestV2({
        stage: "awaiting_plan_approval",
        current_revision: 1,
        current_plan_revision: 1,
        plan_revisions: { ...manifest.plan_revisions, "1": revision },
        brain_controller_claim: null,
      })
      : await transaction.commitInitialPlanApprovalBoundary({
        revision,
        pending,
        expected_manifest: manifest,
      });
    await ensureClaimedInitialPlanBoundaryEvent(transaction.runDir, committed, revision);
    return { revision, manifest: committed };
  });
}

interface VerifiedPlanSnapshot {
  text: string;
  plan: BrainPlan | null;
  acceptanceCriteria: Record<string, AcceptanceCriterion[]> | undefined;
}

/** Project stable review-policy criterion references from one parsed canonical plan. */
export function derivePlanAcceptanceCriteria(
  plan: BrainPlan,
): Record<string, AcceptanceCriterion[]> {
  const criteria: Record<string, AcceptanceCriterion[]> = {};
  for (const [itemIndex, item] of plan.work_items.entries()) {
    if (Object.prototype.hasOwnProperty.call(criteria, item.id)) {
      throw new Error(`Duplicate work item id "${item.id}" in structured plan`);
    }
    criteria[item.id] = item.acceptance.map((criterion, criterionIndex) => ({
      ref: `BH-${String(itemIndex + 1).padStart(3, "0")}:AC-${criterionIndex + 1}`,
      text: criterion.statement,
    }));
  }
  return criteria;
}

/** Read one recorded plan through an owned no-follow descriptor and derive all projections from those bytes. */
async function readVerifiedPlanSnapshot(
  runDir: string,
  manifest: RunManifestV2,
  revision: number,
  requireParsedPlan: boolean,
): Promise<VerifiedPlanSnapshot> {
  const recorded = manifest.plan_revisions[String(revision)];
  if (!recorded) throw new Error(`Plan revision ${revision} is not recorded`);
  const relativePath = `plans/revision-${revision}.md`;
  const expectedPath = resolve(await realpath(runDir), relativePath);
  if (recorded.path !== relativePath
    && (!isAbsolute(recorded.path) || resolve(recorded.path) !== expectedPath)) {
    throw new Error(`Plan revision ${revision} path does not match its canonical ledger path`);
  }
  const planText = (await readOwnedEvidenceFile(runDir, relativePath, "plans/")).toString("utf8");
  const currentSha256 = createHash("sha256").update(planText, "utf8").digest("hex");
  if (currentSha256 !== recorded.sha256) {
    throw new Error(`Plan revision ${revision} does not match its recorded SHA-256`);
  }
  let plan: BrainPlan | null = null;
  if (requireParsedPlan) {
    try {
      plan = parsePersistedPlan(JSON.parse(planText), manifest.workflow_protocol);
    } catch (error) {
      throw new Error("Plan approval revision is not a valid persisted plan", { cause: error });
    }
  }
  const acceptanceCriteria = plan === null
    ? readAcceptanceCriteriaFromText(planText)
    : derivePlanAcceptanceCriteria(plan);
  const approvedRevision = manifest.approved_revision ?? manifest.approved_plan_revision;
  const criteriaMustBeRecorded = recorded.origin === "replan"
    || (approvedRevision !== null && approvedRevision !== undefined && revision <= approvedRevision)
    || recorded.acceptance_criteria !== undefined;
  if (criteriaMustBeRecorded
    && canonicalApprovalJson(recorded.acceptance_criteria) !== canonicalApprovalJson(acceptanceCriteria)) {
    throw new Error(`Plan revision ${revision} acceptance-criterion metadata does not match the canonical plan`);
  }
  return {
    text: planText,
    plan,
    acceptanceCriteria,
  };
}

/** Read exactly the recorded plan bytes and reject path or digest drift. */
export async function readVerifiedPlanRevision(
  runDir: string,
  manifest: RunManifestV2,
  revision: number,
): Promise<string> {
  return (await readVerifiedPlanSnapshot(runDir, manifest, revision, false)).text;
}

async function readCanonicalRunConfiguration(
  runDir: string,
  manifest: RunManifestV2Ledger,
): Promise<ResolvedRunConfiguration> {
  const configurationBytes = (await readOwnedRunFile(runDir, RUN_CONFIGURATION_PATH)).toString("utf8");
  let runConfiguration;
  try {
    runConfiguration = resolvedRunConfigurationSchema.parse(JSON.parse(configurationBytes));
  } catch (error) {
    throw new Error("Run configuration is invalid", { cause: error });
  }
  if (serializeRunConfiguration(runConfiguration) !== configurationBytes) {
    throw new Error("Run configuration bytes are not canonical");
  }
  if (manifest.run_configuration_sha256 !== runConfigurationSha256(runConfiguration)) {
    throw new Error("Run configuration digest does not match the immutable manifest");
  }
  let intake: RunIntake | ResolvedRunIntake;
  try {
    intake = JSON.parse((await readOwnedRunFile(runDir, manifest.intake_path)).toString("utf8")) as RunIntake;
  } catch (error) {
    throw new Error("Run intake snapshot is invalid", { cause: error });
  }
  const configurationRoles = Object.fromEntries(Object.entries(runConfiguration.roles)
    .map(([name, profile]) => [name, {
      model: profile.model,
      reasoning_effort: profile.reasoning_effort,
      sandbox: profile.sandbox,
    }]));
  const expectedReviewPolicy = resolveReviewPolicy(
    runConfiguration.limits.max_hands_fix_attempts,
    undefined,
    intake.review_policy,
  );
  const authorityMismatches = [
    runConfiguration.repository !== manifest.repo_root || runConfiguration.repository !== intake.repo_root ? "repository" : null,
    runConfiguration.mode !== manifest.mode || runConfiguration.mode !== intake.mode ? "mode" : null,
    runConfiguration.research !== intake.research ? "research" : null,
    runConfiguration.reflection !== intake.reflection ? "reflection" : null,
    canonicalApprovalJson(configurationRoles) !== canonicalApprovalJson(manifest.role_profiles)
      || canonicalApprovalJson(configurationRoles) !== canonicalApprovalJson(manifest.selected_role_profiles)
      || ("roles" in intake && canonicalApprovalJson(configurationRoles) !== canonicalApprovalJson(intake.roles))
      ? "roles" : null,
    canonicalApprovalJson(runConfiguration.hands_backup) !== canonicalApprovalJson(manifest.hands_backup_policy ?? null)
      || canonicalApprovalJson(runConfiguration.hands_backup) !== canonicalApprovalJson(intake.hands_backup ?? null)
      ? "Hands backup" : null,
    canonicalApprovalJson(runConfiguration.limits.quality_gate) !== canonicalApprovalJson(manifest.quality_gate_policy ?? null)
      || canonicalApprovalJson(runConfiguration.limits.quality_gate) !== canonicalApprovalJson(intake.quality_gate ?? null)
      ? "quality gate" : null,
    "phase_reasoning" in runConfiguration
      && canonicalApprovalJson(runConfiguration.phase_reasoning) !== canonicalApprovalJson(intake.phase_reasoning)
      ? "phase reasoning" : null,
    canonicalApprovalJson(runConfiguration.limits.review_policy) !== canonicalApprovalJson(manifest.review_policy_snapshot)
      || (manifest.workflow_protocol !== "legacy-v2" && intake.review_policy !== undefined
        && canonicalApprovalJson(runConfiguration.limits.review_policy) !== canonicalApprovalJson(expectedReviewPolicy))
      ? "review policy" : null,
    manifest.controller_provenance === undefined
      || runConfiguration.controller.package_name !== manifest.controller_provenance.package_name
      || runConfiguration.controller.package_version !== manifest.controller_provenance.package_version
      || runConfiguration.controller.mode !== manifest.controller_provenance.mode
      ? "controller" : null,
  ].filter((entry): entry is string => entry !== null);
  if (authorityMismatches.length > 0) {
    throw new Error(`Run configuration authority does not match immutable run snapshots: ${authorityMismatches.join(", ")}`);
  }
  return runConfiguration;
}

/** Verify the exact canonical run configuration against its immutable manifest and intake authority. */
export async function readVerifiedRunConfiguration(
  runDir: string,
  expectedManifest?: RunManifestV2Ledger,
): Promise<ResolvedRunConfiguration> {
  const manifest = expectedManifest ?? await readManifestV2(runDir);
  return readCanonicalRunConfiguration(runDir, manifest);
}

function isMissingOwnedAuthorityArtifact(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function ownedAuthorityArtifactExists(runDir: string, path: string): Promise<boolean> {
  try {
    await readOwnedRunFile(runDir, path);
    return true;
  } catch (error) {
    if (isMissingOwnedAuthorityArtifact(error)) return false;
    throw error;
  }
}

/** Modern approval provenance is irreversible even if mutable manifest markers are stripped. */
export async function requiresPinnedRuntimeAuthority(
  runDir: string,
  manifest: RunManifestV2Ledger,
  options: { allowHistoricalPatchOnlyConfigurationOrphan?: boolean } = {},
): Promise<boolean> {
  const manifestPinned = manifest.approval_protocol_version === 1
    || manifest.run_configuration_sha256 !== null
    || manifest.pending_plan_approval !== null
    || Object.values(manifest.plan_revisions).some((revision) => revision.origin !== undefined
      || revision.approval_request_path !== undefined
      || revision.approval_request_sha256 !== undefined
      || revision.approval_subject_sha256 !== undefined
      || revision.decision_contract_sha256 !== undefined);
  const eventText = (await readOwnedRunFile(runDir, "events.jsonl")).toString("utf8");
  const modernApprovalEvents = new Map<number, {
    event_id?: unknown;
    run_id?: unknown;
    stage?: unknown;
    actor?: unknown;
    payload: Record<string, unknown>;
  }>();
  const legacyApprovalEvents = new Map<number, Array<{
    event_id?: unknown;
    run_id?: unknown;
    stage?: unknown;
    actor?: unknown;
    payload: Record<string, unknown>;
  }>>();
  const approvedResetEvents = new Map<number, Array<{
    event_id?: unknown;
    run_id?: unknown;
    stage?: unknown;
    actor?: unknown;
    payload: Record<string, unknown>;
  }>>();
  for (const line of eventText.split("\n").filter(Boolean)) {
    const event = JSON.parse(line) as {
      event_id?: unknown;
      run_id?: unknown;
      stage?: unknown;
      type?: unknown;
      actor?: unknown;
      payload?: Record<string, unknown>;
    };
    const payload = event.payload ?? {};
    if (event.type === "approved_replan_attempt_reset") {
      const revision = payload.plan_revision;
      if (!Number.isInteger(revision) || (revision as number) < 2) {
        throw new Error("Approved replan reset event provenance is malformed or conflicting");
      }
      approvedResetEvents.set(revision as number, [
        ...(approvedResetEvents.get(revision as number) ?? []),
        { ...event, payload },
      ]);
      continue;
    }
    if (event.type !== "plan_approved") continue;
    const hasModernField = payload.approval_semantics_version !== undefined
      || payload.plan_sha256 !== undefined
      || payload.request_sha256 !== undefined
      || payload.approval_subject_sha256 !== undefined;
    const revision = payload.revision;
    if (!Number.isInteger(revision) || (revision as number) < 1) {
      if (manifestPinned) throw new Error("Plan approval event provenance is malformed or conflicting");
      continue;
    }
    if (!hasModernField) {
      legacyApprovalEvents.set(revision as number, [
        ...(legacyApprovalEvents.get(revision as number) ?? []),
        { ...event, payload },
      ]);
      continue;
    }
    const digest = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
    if (event.run_id !== manifest.run_id
      || payload.approval_semantics_version !== 1
      || !digest(payload.plan_sha256)
      || !digest(payload.request_sha256)
      || !digest(payload.approval_subject_sha256)) {
      throw new Error("Modern plan approval event provenance is malformed or conflicting");
    }
    if (modernApprovalEvents.has(revision as number)) {
      throw new Error(`Duplicate modern plan approval event for revision ${revision as number}`);
    }
    modernApprovalEvents.set(revision as number, { ...event, payload });
  }
  if (!manifestPinned && modernApprovalEvents.size > 0) {
    throw new Error("Modern plan approval event provenance is missing its irreversible protocol marker");
  }
  if (manifestPinned) {
    if (manifest.approval_protocol_version !== 1
      || manifest.approval_protocol_start_revision === null
      || manifest.approval_protocol_start_revision === undefined) {
      throw new Error("Exact plan approval provenance is missing its irreversible protocol marker or start revision");
    }
    const startRevision = manifest.approval_protocol_start_revision;
    const approvedRevision = manifest.approved_revision;
    for (const [key, record] of Object.entries(manifest.plan_revisions)) {
      const revision = Number(key);
      if (revision < startRevision) {
        if (modernApprovalEvents.has(revision)) {
          throw new Error(`Modern plan approval event precedes exact approval start revision ${startRevision}`);
        }
        legacyApprovalEvents.delete(revision);
        approvedResetEvents.delete(revision);
        continue;
      }
      if (legacyApprovalEvents.has(revision)) {
        throw new Error(`Legacy plan approval event conflicts with exact revision ${revision}`);
      }
      const verifiedApproval = await verifyPersistedPlanApprovalSubject(runDir, manifest, revision);
      if (verifiedApproval === null) {
        throw new Error(`Exact approval artifacts are missing for revision ${revision}`);
      }
      const event = modernApprovalEvents.get(revision);
      const isDurablyApproved = approvedRevision !== null && revision <= approvedRevision;
      if (!isDurablyApproved) {
        if (event !== undefined || approvedResetEvents.has(revision)) {
          throw new Error(`Modern plan approval event conflicts with unapproved revision ${revision}`);
        }
        continue;
      }
      if (event === undefined) {
        const immediateRepairStage = record.origin === "initial"
          ? "awaiting_plan_approval"
          : "worktree_setup";
        const repairableCurrentGap = revision === approvedRevision
          && manifest.current_revision === revision
          && manifest.current_plan_revision === revision
          && manifest.approved_plan_revision === revision
          && manifest.pending_plan_approval === null
          && manifest.stage === immediateRepairStage;
        if (!repairableCurrentGap) {
          throw new Error(`Modern plan approval event is missing for completed exact revision ${revision}`);
        }
      } else {
        const expectedActor = record.origin === "initial"
          && manifest.warning_continuation_authority?.source === "approved_plan"
          ? manifest.warning_continuation_authority.actor
          : "human";
        const expectedPayload = {
          revision,
          plan_sha256: record.sha256,
          request_sha256: verifiedApproval.pointer.request_sha256,
          approval_subject_sha256: verifiedApproval.request.approval_subject_sha256,
          approval_semantics_version: 1,
        };
        const expectedEventId = `plan-approved:${approvalSha256({
          run_id: manifest.run_id,
          approval_subject_sha256: verifiedApproval.request.approval_subject_sha256,
        })}`;
        if (event.event_id !== expectedEventId
          || event.run_id !== manifest.run_id
          || event.stage !== (record.origin === "initial" ? "awaiting_plan_approval" : "worktree_setup")
          || event.actor !== expectedActor
          || canonicalApprovalJson(event.payload) !== canonicalApprovalJson(expectedPayload)) {
          throw new Error(`Modern plan approval event conflicts with exact revision ${revision}`);
        }
        modernApprovalEvents.delete(revision);
      }
      if (record.origin === "replan") {
        const resets = approvedResetEvents.get(revision) ?? [];
        if (resets.length === 0) {
          const repairableCurrentGap = revision === approvedRevision
            && manifest.current_revision === revision
            && manifest.current_plan_revision === revision
            && manifest.approved_plan_revision === revision
            && manifest.pending_plan_approval === null
            && manifest.stage === "worktree_setup";
          if (!repairableCurrentGap) {
            throw new Error(`Approved replan reset event is missing for completed exact revision ${revision}`);
          }
          continue;
        }
        if (resets.length > 1) {
          throw new Error(`Duplicate approved replan reset event for revision ${revision}`);
        }
        const reset = resets[0]!;
        const resetPayload = reset.payload;
        const workItemId = resetPayload.work_item_id;
        const patchPath = resetPayload.replan_patch_path;
        const expectedResetPayload = {
          work_item_id: workItemId,
          base_plan_revision: record.base_revision,
          plan_revision: revision,
          replan_patch_path: patchPath,
        };
        const expectedResetId = typeof workItemId === "string" && typeof patchPath === "string"
          ? `approved-replan-reset:${createHash("sha256")
              .update(`${manifest.run_id}:${workItemId}:${record.base_revision}:${revision}:${patchPath}`, "utf8").digest("hex")}`
          : null;
        if (typeof workItemId !== "string" || workItemId.trim() === ""
          || typeof patchPath !== "string" || patchPath.trim() === ""
          || reset.event_id !== expectedResetId
          || reset.run_id !== manifest.run_id
          || reset.stage !== "worktree_setup"
          || reset.actor !== "human"
          || canonicalApprovalJson(resetPayload) !== canonicalApprovalJson(expectedResetPayload)) {
          throw new Error(`Approved replan reset event conflicts with exact revision ${revision}`);
        }
        approvedResetEvents.delete(revision);
      } else if (approvedResetEvents.has(revision)) {
        throw new Error(`Approved replan reset event conflicts with initial exact revision ${revision}`);
      }
    }
    for (const [revision] of legacyApprovalEvents) {
      if (revision >= startRevision) {
        throw new Error("Legacy plan approval event does not correspond to the historical approval prefix");
      }
    }
    if (modernApprovalEvents.size > 0 || approvedResetEvents.size > 0) {
      throw new Error("Modern plan approval event does not correspond to the immutable exact revision suffix");
    }
    return true;
  }

  if (await ownedAuthorityArtifactExists(runDir, RUN_CONFIGURATION_PATH)) {
    const sourceWorkItemId = manifest.current_work_item_id;
    const sourceProgress = sourceWorkItemId === null
      ? undefined
      : manifest.work_item_progress[sourceWorkItemId];
    const baseRevision = manifest.approved_revision;
    const historicalPatchOnlyShape = options.allowHistoricalPatchOnlyConfigurationOrphan === true
      && manifest.terminal === null
      && manifest.workflow_protocol === "legacy-v2"
      && manifest.approval_protocol_version === null
      && manifest.run_configuration_sha256 === null
      && manifest.pending_plan_approval === null
      && (manifest.stage === "replanning" || manifest.stage === "awaiting_plan_approval")
      && baseRevision !== null
      && manifest.current_revision === baseRevision
      && manifest.current_plan_revision === baseRevision
      && manifest.approved_plan_revision === baseRevision
      && sourceProgress !== undefined
      && typeof sourceProgress.replan_patch_path === "string";
    if (historicalPatchOnlyShape) {
      const intake = JSON.parse(
        (await readOwnedRunFile(runDir, manifest.intake_path)).toString("utf8"),
      ) as RunIntake | ResolvedRunIntake;
      const reconstructed = reconstructHistoricalRunConfiguration(manifest, intake);
      const persisted = (await readOwnedRunFile(runDir, RUN_CONFIGURATION_PATH)).toString("utf8");
      if (persisted === serializeRunConfiguration(reconstructed)) return false;
    }
    throw new Error("Pinned run configuration is missing its irreversible protocol marker");
  }
  const revisions = new Set<number>([
    ...Object.keys(manifest.plan_revisions).map(Number).filter((revision) => Number.isInteger(revision) && revision > 0),
    ...(manifest.current_revision === null ? [] : [manifest.current_revision]),
    ...(manifest.approved_revision === null ? [] : [manifest.approved_revision]),
    ...(manifest.current_revision === null ? [] : [manifest.current_revision + 1]),
  ]);
  for (const revision of revisions) {
    if (await ownedAuthorityArtifactExists(runDir, `approvals/plan/revision-${revision}.json`)) {
      throw new Error("Plan approval request is missing its irreversible protocol marker");
    }
  }
  return false;
}

async function verifyDiscoveryPrerequisite(
  runDir: string,
  manifest: RunManifestV2Ledger,
  plan: BrainPlan,
): Promise<void> {
  if (manifest.workflow_protocol === "legacy-v2") return;
  if (manifest.discovery === null) {
    throw new Error("Durable discovered plan requires discovery manifest state");
  }
  const { readVerifiedDiscoveryBriefForState } = await import("./discovery-ledger.js");
  const brief = await readVerifiedDiscoveryBriefForState(runDir, manifest.discovery);
  const discovered = plan as DiscoveredBrainPlan;
  if (discovered.discovery_brief_revision !== brief.revision) {
    throw new Error(`Plan discovery brief revision does not match approved revision ${brief.revision}`);
  }
  if (discovered.discovery_brief_sha256 !== manifest.discovery.approved_brief_sha256) {
    throw new Error("Plan discovery brief SHA-256 does not match the approved brief");
  }
  validateDiscoveryCoverage(discovered, brief);
}

async function hasExactPlanRejection(
  runDir: string,
  manifest: RunManifestV2Ledger,
  revision: number,
  pointer: PendingPlanApprovalV1,
): Promise<boolean> {
  const path = `approvals/plan/revision-${revision}-rejection.json`;
  let bytes: Buffer;
  try {
    bytes = await readOwnedEvidenceFile(runDir, path, "approvals/");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
  const rejection = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
  return rejection.schema_version === 1
    && rejection.run_id === manifest.run_id
    && rejection.rejected_revision === revision
    && rejection.base_revision === pointer.base_revision
    && rejection.request_path === pointer.request_path
    && rejection.request_sha256 === pointer.request_sha256
    && rejection.approval_subject_sha256 === pointer.approval_subject_sha256
    && typeof rejection.actor === "string"
    && rejection.actor.trim() !== ""
    && typeof rejection.reason === "string"
    && rejection.reason.trim() !== "";
}

async function approvalPointerForRevision(
  runDir: string,
  manifest: RunManifestV2Ledger,
  revision: number,
): Promise<PendingPlanApprovalV1 | null> {
  const recorded = manifest.plan_revisions[String(revision)];
  if (!recorded) throw new Error(`Plan revision ${revision} is not recorded`);
  const metadata = [
    recorded.origin,
    recorded.base_revision,
    recorded.approval_request_path,
    recorded.approval_request_sha256,
    recorded.approval_subject_sha256,
    recorded.decision_contract_sha256,
  ];
  const hasAny = metadata.some((value) => value !== undefined);
  const hasAll = recorded.origin !== undefined
    && recorded.base_revision !== undefined
    && recorded.approval_request_path !== undefined
    && recorded.approval_request_sha256 !== undefined
    && recorded.approval_subject_sha256 !== undefined
    && recorded.decision_contract_sha256 !== undefined;
  if (hasAny && !hasAll) throw new Error("Plan approval revision metadata is incomplete");
  if (!hasAll) {
    if (isHistoricalApprovalPrefixRevision(manifest, revision)) return null;
    if (manifest.approval_protocol_version === 1 || manifest.run_configuration_sha256 !== null) {
      throw new Error("Pinned run plan approval metadata is missing");
    }
    return null;
  }
  const pointer: PendingPlanApprovalV1 = {
    schema_version: 1,
    proposed_revision: revision,
    base_revision: recorded.base_revision!,
    request_path: recorded.approval_request_path!,
    request_sha256: recorded.approval_request_sha256!,
    approval_subject_sha256: recorded.approval_subject_sha256!,
  };
  const alreadyApproved = manifest.approved_revision !== null
    && manifest.approved_plan_revision !== null
    && revision <= manifest.approved_revision
    && revision <= manifest.approved_plan_revision;
  if (manifest.pending_plan_approval !== null
    && manifest.pending_plan_approval.proposed_revision === revision
    && JSON.stringify(manifest.pending_plan_approval) !== JSON.stringify(pointer)) {
    throw new Error("Pending plan approval does not match the requested revision metadata");
  }
  if ((manifest.pending_plan_approval === null
    || manifest.pending_plan_approval.proposed_revision !== revision)
    && !alreadyApproved
    && !(await hasExactPlanRejection(runDir, manifest, revision, pointer))) {
    throw new Error("Pinned plan approval pending pointer is missing before promotion");
  }
  return pointer;
}

export interface VerifiedPlanApproval {
  request: PlanApprovalRequestV1;
  pointer: PendingPlanApprovalV1;
  snapshot: VerifiedPlanSnapshot;
  runConfiguration: ResolvedRunConfiguration;
}

export interface VerifiedHistoricalPlanBase {
  snapshot: VerifiedPlanSnapshot;
  runConfiguration: ResolvedRunConfiguration;
}

function isHistoricalApprovalPrefixRevision(manifest: RunManifestV2Ledger, revision: number): boolean {
  return manifest.approval_protocol_version === 1
    && typeof manifest.approval_protocol_start_revision === "number"
    && revision < manifest.approval_protocol_start_revision;
}

export async function verifyPlanApprovalSubject(
  runDir: string,
  manifest: RunManifestV2Ledger,
  revision: number,
  approvalControllerCapture?: ApprovalControllerCapture,
): Promise<VerifiedPlanApproval | null> {
  const verified = await verifyPersistedPlanApprovalSubject(runDir, manifest, revision);
  if (verified === null) return null;
  await assertApprovalControllerMatches(runDir, manifest, approvalControllerCapture);
  return verified;
}

/**
 * Verifies the complete persisted approval subject without observing the current
 * process controller. This is safe for read-only projections such as status/log.
 */
export async function verifyPersistedPlanApprovalSubject(
  runDir: string,
  manifest: RunManifestV2Ledger,
  revision: number,
  options: {
    hooks?: {
      afterRunConfigurationRead?: (configuration: ResolvedRunConfiguration) => Promise<void>;
    };
  } = {},
): Promise<VerifiedPlanApproval | null> {
  const pointer = await approvalPointerForRevision(runDir, manifest, revision);
  if (pointer === null) {
    if (isHistoricalApprovalPrefixRevision(manifest, revision)) {
      throw new Error("Pinned run plan approval metadata is missing");
    }
    if (await requiresPinnedRuntimeAuthority(runDir, manifest)) {
      throw new Error("Pinned run plan approval metadata is missing");
    }
    return null;
  }
  const recorded = manifest.plan_revisions[String(revision)]!;
  const requestManifest = manifest.pending_plan_approval === null
    || manifest.pending_plan_approval.proposed_revision !== revision
    ? { ...manifest, pending_plan_approval: pointer }
    : manifest;
  const request = await readVerifiedPlanApprovalRequest(runDir, requestManifest);
  const snapshot = await readVerifiedPlanSnapshot(runDir, manifest, revision, true);
  const plan = snapshot.plan!;
  await verifyDiscoveryPrerequisite(runDir, manifest, plan);
  const decisionContractSha256 = planDecisionContractSha256(plan);
  if (decisionContractSha256 !== recorded.decision_contract_sha256) {
    throw new Error("Plan approval decision contract digest mismatch");
  }
  const runConfiguration = await readCanonicalRunConfiguration(runDir, manifest);
  await options.hooks?.afterRunConfigurationRead?.(runConfiguration);
  let basePlan: BrainPlan | null = null;
  if (recorded.base_revision !== null) {
    basePlan = (await readVerifiedPlanSnapshot(
      runDir,
      manifest,
      recorded.base_revision!,
      true,
    )).plan!;
  }
  const delta = buildPlanDelta(basePlan, plan, {
    baseRevision: recorded.base_revision!,
    proposedRevision: revision,
  });
  if (canonicalApprovalJson(delta) !== canonicalApprovalJson(request.delta)) {
    throw new Error("Plan approval request deterministic delta mismatch");
  }
  const expected = buildPlanApprovalRequest({
    manifest,
    runConfiguration,
    reasonCode: recorded.origin === "initial" ? "initial_plan" : "material_replan",
    revision,
    baseRevision: recorded.base_revision!,
    planPath: recorded.path,
    planSha256: recorded.sha256,
    decisionContractSha256,
    delta,
    reconstructInitialAuthority: recorded.origin === "initial",
  });
  if (serializePlanApprovalRequest(expected) !== serializePlanApprovalRequest(request)) {
    throw new Error("Plan approval request subject does not match current immutable artifacts");
  }
  return { request, pointer, snapshot, runConfiguration };
}

export async function verifyHistoricalApprovedRuntimeSubject(
  runDir: string,
  manifest: RunManifestV2Ledger,
  revision: number,
): Promise<VerifiedHistoricalPlanBase | null> {
  if (!isHistoricalApprovalPrefixRevision(manifest, revision)) return null;
  if (manifest.approved_revision === null || revision > manifest.approved_revision) {
    throw new Error("Historical approval prefix revision is not an approved runtime base");
  }
  if (await approvalPointerForRevision(runDir, manifest, revision) !== null) {
    throw new Error("Historical approval prefix revision unexpectedly contains exact approval metadata");
  }
  const snapshot = await readVerifiedPlanSnapshot(runDir, manifest, revision, true);
  if (snapshot.plan === null) throw new Error("Historical approval prefix plan is not parseable");
  await verifyDiscoveryPrerequisite(runDir, manifest, snapshot.plan);
  const runConfiguration = await readCanonicalRunConfiguration(runDir, manifest);
  return { snapshot, runConfiguration };
}

export async function approvePlanRevision(
  runDir: string,
  revision: number,
  options: {
    actor?: string;
    transactionHooks?: RunLedgerTransactionHooks;
    approvalControllerCapture?: ApprovalControllerCapture;
  } | string = {},
): Promise<RunManifestV2Ledger> {
  return withRunLedgerCompoundTransaction(runDir, async (transaction) => {
    const manifest = await transaction.readManifestV2();
    if ((manifest.execution_lease ?? null) !== null) {
      throw new Error("Active execution lease blocks plan approval promotion or repair");
    }
    if (manifest.terminal !== null) {
      throw new Error(`Cannot mutate run with terminal outcome ${manifest.terminal.outcome}`);
    }
    const currentRevision = manifest.current_revision ?? manifest.current_plan_revision;
    if (currentRevision === null || currentRevision === undefined) {
      throw new Error("No plan revision has been recorded");
    }
    if (revision !== currentRevision) {
      throw new Error(`Plan revision ${revision} is not the current revision ${currentRevision}`);
    }
    if (!manifest.plan_revisions[String(revision)]) {
      throw new Error(`Plan revision ${revision} is not recorded`);
    }
    const recorded = manifest.plan_revisions[String(revision)];
    const verifiedApproval = await verifyPlanApprovalSubject(
      transaction.runDir,
      manifest,
      revision,
      typeof options === "string" ? undefined : options.approvalControllerCapture,
    );
    const snapshot = verifiedApproval?.snapshot
      ?? await readVerifiedPlanSnapshot(transaction.runDir, manifest, revision, false);
    const acceptanceCriteria = snapshot.acceptanceCriteria;
    const requestedActor = typeof options === "string" ? options : options.actor ?? "system";
    const actor = verifiedApproval === null
      ? requestedActor
      : manifest.warning_continuation_authority?.source === "approved_plan"
        && verifiedApproval.request.subject.reason_code === "initial_plan"
        ? manifest.warning_continuation_authority.actor
        : "human";
    if (verifiedApproval !== null && requestedActor !== actor) {
      throw new Error(`New-style plan approval actor must be ${actor}`);
    }
    await assertPlanApprovalEventPrecondition(
      transaction.runDir,
      revision,
      verifiedApproval,
      manifest.approved_revision === revision && manifest.approved_plan_revision === revision,
    );
    const planRevisions = {
      ...manifest.plan_revisions,
      [String(revision)]: acceptanceCriteria === undefined
        ? recorded
        : { ...recorded, acceptance_criteria: acceptanceCriteria },
    };
    const approvedPlanWarningAuthority = manifest.review_policy_snapshot?.on_limit === "continue_with_warning"
      && manifest.warning_continuation_authority === undefined
        ? { actor, source: "approved_plan" as const }
        : manifest.warning_continuation_authority;
    const alreadyApproved = (
      manifest.approved_revision === revision
      && manifest.approved_plan_revision === revision
      && (manifest.review_accounting === undefined || manifest.review_accounting.plan_revision === revision)
      && JSON.stringify(manifest.plan_revisions[String(revision)]) === JSON.stringify(planRevisions[String(revision)])
      && JSON.stringify(manifest.warning_continuation_authority) === JSON.stringify(approvedPlanWarningAuthority)
    );
    let approved: RunManifestV2Ledger;
    if (alreadyApproved) {
      approved = manifest;
    } else if (!manifest.review_accounting) {
      if (approvedPlanWarningAuthority) {
        throw new Error("Warning-continuation plan authority requires review accounting provenance");
      }
      approved = await transaction.updateManifestV2({ current_revision: revision, current_plan_revision: revision, approved_revision: revision, approved_plan_revision: revision, plan_revisions: planRevisions });
    } else {
      approved = await transaction.approvePlanRevision(
        manifest.review_accounting,
        revision,
        planRevisions,
        approvedPlanWarningAuthority,
      );
    }
    if (!alreadyApproved && typeof options !== "string") {
      await options.transactionHooks?.afterPlanApprovalManifestPersisted?.();
    }
    await appendPlanApprovalEvent(
      transaction.runDir,
      approved,
      actor,
      revision,
      recorded.sha256,
      verifiedApproval,
    );
    return approved;
  }, typeof options === "string" ? {} : options.transactionHooks);
}

export function buildPlanApprovalEventRecord(
  manifest: RunManifestV2Ledger,
  actor: string,
  revision: number,
  sha256: string,
  verifiedApproval: VerifiedPlanApproval | null = null,
): RunEventRecord {
  const eventId = verifiedApproval === null
    ? `plan-approved:${createHash("sha256").update(`${manifest.run_id}:${revision}:${sha256}`, "utf8").digest("hex")}`
    : `plan-approved:${approvalSha256({
      run_id: manifest.run_id,
      approval_subject_sha256: verifiedApproval.request.approval_subject_sha256,
    })}`;
  return {
    event_id: eventId,
    run_id: manifest.run_id,
    stage: verifiedApproval === null
      ? manifest.stage
      : verifiedApproval.request.subject.reason_code === "material_replan"
        ? "worktree_setup"
        : "awaiting_plan_approval",
    type: "plan_approved",
    timestamp: manifest.updated_at,
    actor,
    payload: verifiedApproval === null
      ? { revision, sha256 }
      : {
        revision,
        plan_sha256: sha256,
        request_sha256: verifiedApproval.pointer.request_sha256,
        approval_subject_sha256: verifiedApproval.request.approval_subject_sha256,
        approval_semantics_version: 1,
      },
  };
}

export async function appendPlanApprovalEvent(
  runDir: string,
  manifest: RunManifestV2Ledger,
  actor: string,
  revision: number,
  sha256: string,
  verifiedApproval: VerifiedPlanApproval | null = null,
): Promise<void> {
  const event = buildPlanApprovalEventRecord(manifest, actor, revision, sha256, verifiedApproval);
  const eventId = event.event_id;
  const events = (await readOwnedRunFile(runDir, "events.jsonl")).toString("utf8")
    .split("\n").filter(Boolean).map((raw) => ({ raw, event: JSON.parse(raw) as RunEventRecord }));
  const matching = verifiedApproval === null
    ? events.filter(({ event: candidate }) => candidate.event_id === eventId)
    : events.filter(({ event: candidate }) => candidate.type === "plan_approved"
      && (candidate.payload as { revision?: unknown }).revision === revision);
  if (matching.length > 1) throw new Error(`Duplicate plan approval event: ${eventId}`);
  if (matching.length === 1) {
    if (matching[0]!.raw !== JSON.stringify(event)) {
      throw new Error(`Plan approval event conflicts with durable approval: ${eventId}`);
    }
    return;
  }
  await appendOwnedRunFile(runDir, "events.jsonl", `${JSON.stringify(event)}\n`);
}

export async function hasExactPlanApprovalEvent(
  runDir: string,
  manifest: RunManifestV2Ledger,
  actor: string,
  revision: number,
  sha256: string,
  verifiedApproval: VerifiedPlanApproval,
): Promise<boolean> {
  const eventId = `plan-approved:${approvalSha256({
    run_id: manifest.run_id,
    approval_subject_sha256: verifiedApproval.request.approval_subject_sha256,
  })}`;
  const events = (await readOwnedRunFile(runDir, "events.jsonl")).toString("utf8")
    .split("\n").filter(Boolean).map((line) => runEventSchema.parse(JSON.parse(line)));
  const matching = events.filter((candidate) => candidate.type === "plan_approved"
    && (candidate.payload as { revision?: unknown }).revision === revision);
  if (matching.length > 1) throw new Error(`Duplicate plan approval event for revision ${revision}`);
  if (matching.length === 0) return false;
  const event = matching[0]!;
  const expected = buildPlanApprovalEventRecord(manifest, actor, revision, sha256, verifiedApproval);
  if (event.event_id !== expected.event_id
    || event.run_id !== expected.run_id
    || event.stage !== expected.stage
    || event.actor !== expected.actor
    || JSON.stringify(event.payload) !== JSON.stringify(expected.payload)) {
    throw new Error(`Plan approval event conflicts with durable approval: ${eventId}`);
  }
  return true;
}

/**
 * Confirms a completed new-style approval without replaying its promotion. A
 * missing event is repaired only in the immediate post-promotion stage, where
 * the original durable transition is still unambiguous.
 */
export async function ensureCompletedPlanApprovalEvent(
  runDir: string,
  revision: number,
  options: {
    approvalControllerCapture?: ApprovalControllerCapture;
    verifyCurrentController?: boolean;
  } = {},
): Promise<"present" | "repaired"> {
  return withRunLedgerCompoundTransaction(runDir, async (transaction) => {
    const manifest = await transaction.readManifestV2();
    const recorded = manifest.plan_revisions[String(revision)];
    if (!recorded
      || manifest.pending_plan_approval !== null
      || manifest.current_revision !== revision
      || manifest.current_plan_revision !== revision
      || manifest.approved_revision !== revision
      || manifest.approved_plan_revision !== revision
      || (manifest.review_accounting !== undefined && manifest.review_accounting.plan_revision !== revision)) {
      throw new Error("Exact plan approval is not durably complete");
    }
    const verified = options.verifyCurrentController === false
      ? await verifyPersistedPlanApprovalSubject(transaction.runDir, manifest, revision)
      : await verifyPlanApprovalSubject(
          transaction.runDir,
          manifest,
          revision,
          options.approvalControllerCapture,
        );
    if (verified === null) throw new Error("Completed plan approval subject metadata is missing");
    const actor = manifest.warning_continuation_authority?.source === "approved_plan"
      && verified.request.subject.reason_code === "initial_plan"
      ? manifest.warning_continuation_authority.actor
      : "human";
    if (await hasExactPlanApprovalEvent(
      transaction.runDir,
      manifest,
      actor,
      revision,
      recorded.sha256,
      verified,
    )) return "present";
    const repairStage = verified.request.subject.reason_code === "initial_plan"
      ? "awaiting_plan_approval"
      : "worktree_setup";
    if (manifest.stage !== repairStage) {
      throw new Error("Cannot repair a missing plan approval event after workflow advancement");
    }
    await appendPlanApprovalEvent(
      transaction.runDir,
      manifest,
      actor,
      revision,
      recorded.sha256,
      verified,
    );
    return "repaired";
  });
}

export async function assertPlanApprovalEventPrecondition(
  runDir: string,
  revision: number,
  verifiedApproval: VerifiedPlanApproval | null,
  durablyApproved: boolean,
): Promise<void> {
  if (verifiedApproval === null) return;
  const events = (await readOwnedRunFile(runDir, "events.jsonl")).toString("utf8")
    .split("\n").filter(Boolean).map((line) => JSON.parse(line) as RunEventRecord)
    .filter((candidate) => candidate.type === "plan_approved"
      && (candidate.payload as { revision?: unknown }).revision === revision);
  if (events.length > 1) throw new Error(`Duplicate plan approval event for revision ${revision}`);
  if (!durablyApproved && events.length === 1) {
    throw new Error(`Plan approval event conflicts with unapproved revision ${revision}`);
  }
}

function readAcceptanceCriteriaFromText(
  planText: string,
): Record<string, AcceptanceCriterion[]> | undefined {
  let plan: unknown;
  try {
    plan = JSON.parse(planText);
  } catch {
    return undefined;
  }
  if (plan === null || typeof plan !== "object" || Array.isArray(plan)) return undefined;
  const workItems = (plan as { work_items?: unknown }).work_items;
  if (!Array.isArray(workItems)) return undefined;

  const result: Record<string, AcceptanceCriterion[]> = {};
  const seenIds = new Set<string>();
  for (const [itemIndex, item] of workItems.entries()) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return undefined;
    const { id, acceptance_criteria: legacyCriteria, acceptance: canonicalCriteria } = item as {
      id?: unknown;
      acceptance_criteria?: unknown;
      acceptance?: unknown;
    };
    if (typeof id !== "string" || id.length === 0) return undefined;
    const criteria = Array.isArray(canonicalCriteria)
      ? canonicalCriteria.map((criterion) => criterion && typeof criterion === "object" ? (criterion as { statement?: unknown }).statement : undefined)
      : legacyCriteria;
    if (seenIds.has(id)) {
      throw new Error(`Duplicate work item id "${id}" in structured plan`);
    }
    seenIds.add(id);
    if (!Array.isArray(criteria) || criteria.some((criterion) => typeof criterion !== "string" || criterion.length === 0)) {
      return undefined;
    }
    result[id] = criteria.map((text, criterionIndex) => ({
      ref: `BH-${String(itemIndex + 1).padStart(3, "0")}:AC-${criterionIndex + 1}`,
      text: text as string,
    }));
  }
  return result;
}

export async function readManifest(runDir: string): Promise<RunManifest> {
  const raw = await readFile(join(runDir, "manifest.json"), "utf8");
  return runManifestSchema.parse(JSON.parse(raw));
}

export async function updateManifest(
  runDir: string,
  patch: Partial<RunManifest>,
): Promise<RunManifest> {
  const current = await readManifest(runDir);
  const next = runManifestSchema.parse({
    ...current,
    ...patch,
    updated_at: new Date().toISOString(),
  });

  await writeFile(join(runDir, "manifest.json"), JSON.stringify(next, null, 2), "utf8");
  return next;
}

function protectedV2ArtifactKind(runDir: string, target: string): "findings" | "engine" | "approval" | null {
  if (target === resolve(runDir, RUN_CONFIGURATION_PATH)) return "approval";
  const roots: Array<["findings" | "engine" | "approval", string]> = [
    ["findings", resolve(runDir, "findings")],
    ["engine", resolve(runDir, "reviews", "decisions")],
    ["engine", resolve(runDir, "reviews", "effects")],
    ["engine", resolve(runDir, "reviews", "accounting")],
    ["engine", resolve(runDir, "reviews", "convergence")],
    ["engine", resolve(runDir, "authorizations")],
    ["engine", resolve(runDir, "summaries")],
    ["engine", resolve(runDir, "evidence-indexes")],
    ["engine", resolve(runDir, "contexts")],
    ["engine", resolve(runDir, "budgets")],
    ["approval", resolve(runDir, "approvals")],
  ];
  for (const [kind, root] of roots) {
    const relation = relative(root, target);
    if (relation === "" || !relation.startsWith("..")) return kind;
  }
  return null;
}

async function rejectProtectedV2Artifact(runDir: string, target: string): Promise<void> {
  const kind = protectedV2ArtifactKind(runDir, target);
  if (kind === null) return;
  const manifestVersion = JSON.parse(await readFile(join(runDir, "manifest.json"), "utf8")) as {
    version?: unknown;
  };
  if (manifestVersion.version === 2) {
    if (kind === "findings") {
      throw new Error("Finding history is append-only and cannot be written as a text artifact");
    }
    if (kind === "approval") {
      throw new Error("Approval evidence and run configuration are immutable and cannot be written as text artifacts");
    }
    throw new Error("Engine history is immutable and cannot be written as a text artifact");
  }
}

function mutableArtifactTargetTypeError(target: string): NodeJS.ErrnoException {
  const error = new Error(`Mutable artifact target must be a regular file: ${target}`) as NodeJS.ErrnoException;
  error.code = "EISDIR";
  return error;
}

export async function writeTextArtifact(
  runDir: string,
  relativePath: string,
  content: string | Buffer,
): Promise<string> {
  const lexicalTarget = resolveAndValidateArtifactPath(runDir, relativePath);
  const protectedLog = ["events.jsonl", "progress.jsonl", "session-events.jsonl"].find((name) => lexicalTarget === resolve(runDir, name));
  if (protectedLog) {
    throw new Error(`${protectedLog} is append-only and cannot be written as a text artifact`);
  }
  await rejectProtectedV2Artifact(runDir, lexicalTarget);
  const target = resolve(await realpath(resolve(runDir)), relativePath);
  const parent = await ensureValidatedArtifactParent(runDir, target);
  const existing = await lstat(target).catch((error: unknown) => {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  });
  if (existing?.isSymbolicLink()) {
    throw new Error(`Mutable artifact target must not be a symlink: ${target}`);
  }
  if (existing !== null && !existing.isFile()) {
    throw mutableArtifactTargetTypeError(target);
  }

  const temporary = join(parent.realPath, `.${basename(target)}.${randomUUID()}.tmp`);
  const handle = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
    0o600,
  );
  let renamed = false;
  try {
    if (!(await handle.stat()).isFile()) throw new Error("Mutable artifact temporary target must be a regular file");
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    await assertDirectoryIdentity(parent, "Mutable artifact parent");
    const current = await lstat(target).catch((error: unknown) => {
      if (errorCode(error) === "ENOENT") return null;
      throw error;
    });
    if (current?.isSymbolicLink()) {
      throw new Error(`Mutable artifact target must not be a symlink: ${target}`);
    }
    if (current !== null && !current.isFile()) {
      throw mutableArtifactTargetTypeError(target);
    }
    await rename(temporary, target);
    renamed = true;
    await assertDirectoryIdentity(parent, "Mutable artifact parent");
    await fsyncDirectory(parent.realPath);
  } finally {
    await handle.close().catch(() => undefined);
    if (!renamed) await rm(temporary, { force: true }).catch(() => undefined);
  }
  return lexicalTarget;
}

/** Create an immutable run artifact and fail rather than overwrite prior evidence. */
export async function writeImmutableTextArtifact(
  runDir: string,
  relativePath: string,
  content: string,
): Promise<string> {
  const target = resolveAndValidateArtifactPath(runDir, relativePath);
  const protectedLog = ["events.jsonl", "progress.jsonl", "session-events.jsonl"].find((name) => target === resolve(runDir, name));
  if (protectedLog) {
    throw new Error(`${protectedLog} is append-only and cannot be written as a text artifact`);
  }
  await rejectProtectedV2Artifact(runDir, target);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content, { encoding: "utf8", flag: "wx" });
  return target;
}

async function ensureValidatedArtifactParent(
  runDir: string,
  target: string,
): Promise<DirectoryIdentity> {
  const canonicalRunDir = await realpath(resolve(runDir));
  const relativeParent = relative(canonicalRunDir, dirname(target));
  let current = canonicalRunDir;
  for (const segment of relativeParent.split(/[\\/]/).filter(Boolean)) {
    const next = join(current, segment);
    const status = await lstat(next).catch((error: unknown) => {
      if (errorCode(error) === "ENOENT") return null;
      throw error;
    });
    if (status === null) {
      let created = false;
      await mkdir(next, { mode: 0o700 }).then(() => {
        created = true;
      }).catch((error: unknown) => {
        if (errorCode(error) !== "EEXIST") throw error;
      });
      const createdStatus = await lstat(next);
      if (createdStatus.isSymbolicLink()) throw new Error("Validated artifact parent must not be a symlink");
      if (!createdStatus.isDirectory()) throw new Error("Validated artifact parent must be a directory");
      if (created) await fsyncDirectory(current);
    } else {
      if (status.isSymbolicLink()) throw new Error("Validated artifact parent must not be a symlink");
      if (!status.isDirectory()) throw new Error("Validated artifact parent must be a directory");
    }
    current = next;
  }
  return captureDirectoryIdentity(current, "Validated artifact parent");
}

async function validateExistingArtifactParent(
  runDir: string,
  target: string,
): Promise<DirectoryIdentity> {
  const canonicalRunDir = await realpath(resolve(runDir));
  const relativeParent = relative(canonicalRunDir, dirname(target));
  let current = canonicalRunDir;
  for (const segment of relativeParent.split(/[\\/]/).filter(Boolean)) {
    const next = join(current, segment);
    const status = await lstat(next);
    if (status.isSymbolicLink()) throw new Error("Referenced artifact parent must not be a symlink");
    if (!status.isDirectory()) throw new Error("Referenced artifact parent must be a directory");
    current = next;
  }
  return captureDirectoryIdentity(current, "Referenced artifact parent");
}

/** Read an optional JSON artifact without following a final-component symlink. */
export async function readOptionalValidatedArtifact<T>(
  runDir: string,
  relativePath: string,
  schema: ZodType<T>,
): Promise<T | null> {
  resolveAndValidateArtifactPath(runDir, relativePath);
  const target = resolve(await realpath(resolve(runDir)), relativePath);
  const status = await lstat(target).catch((error: unknown) => {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  });
  if (status === null) return null;
  const parent = await ensureValidatedArtifactParent(runDir, target);
  return schema.parse(await readJsonNoFollow(target, "Validated artifact", parent));
}

/** Create, validate, sync, and never replace one engine-owned JSON artifact. */
export async function writeCreateOnceValidated<T>(
  runDir: string,
  relativePath: string,
  value: T,
  schema: ZodType<T>,
): Promise<T> {
  const parsed = schema.parse(value);
  resolveAndValidateArtifactPath(runDir, relativePath);
  const target = resolve(await realpath(resolve(runDir)), relativePath);
  const parent = await ensureValidatedArtifactParent(runDir, target);
  await assertDirectoryIdentity(parent, "Validated artifact parent");
  const handle = await open(
    target,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
    0o600,
  );
  let complete = false;
  try {
    const status = await handle.stat();
    if (!status.isFile()) throw new Error("Validated artifact target must be a regular open file");
    const openedRealPath = await realpath(target);
    if (dirname(openedRealPath) !== parent.realPath) {
      throw new Error("Validated artifact target escaped its parent directory");
    }
    await assertDirectoryIdentity(parent, "Validated artifact parent");
    await handle.writeFile(`${JSON.stringify(parsed, null, 2)}\n`, "utf8");
    await handle.sync();
    complete = true;
  } finally {
    await handle.close().catch(() => undefined);
    if (!complete) await rm(target, { force: true }).catch(() => undefined);
  }
  await fsyncDirectory(dirname(target));
  return parsed;
}

/** Persist canonical JSON once, allowing only byte-identical replays. */
export async function writeImmutableValidatedJson<T>(
  runDir: string,
  relativePath: string,
  schema: ZodType<T>,
  value: unknown,
): Promise<ArtifactRefV1> {
  resolveAndValidateArtifactPath(runDir, relativePath);
  const parsed = schema.parse(value);
  const bytes = canonicalJsonBytes(schema, parsed);
  const reference = artifactRefFromBytes(relativePath, bytes);

  return withRunLedgerTransaction(runDir, async (transaction) => {
    try {
      await writeCreateOnceValidated(transaction.runDir, relativePath, parsed, schema);
    } catch (error: unknown) {
      if (errorCode(error) !== "EEXIST") throw error;
      const target = resolve(await realpath(resolve(transaction.runDir)), relativePath);
      const parent = await ensureValidatedArtifactParent(transaction.runDir, target);
      const existing = await readBytesNoFollow(target, "Immutable artifact", parent);
      if (!existing.equals(bytes)) {
        throw new Error(`Immutable artifact ${relativePath} already exists with different bytes`);
      }
    }
    return reference;
  });
}

/** Read one immutable JSON reference after verifying its content hash. */
export async function readReferencedJson<T>(
  runDir: string,
  ref: ArtifactRefV1,
  schema: ZodType<T>,
): Promise<T> {
  const reference = artifactRefV1Schema.parse(ref);
  resolveAndValidateArtifactPath(runDir, reference.path);
  const target = resolve(await realpath(resolve(runDir)), reference.path);
  const parent = await validateExistingArtifactParent(runDir, target);
  const bytes = await readBytesNoFollow(target, "Referenced artifact", parent);
  if (sha256Bytes(bytes) !== reference.sha256) {
    throw new Error(`Referenced artifact ${reference.path} does not match its SHA-256`);
  }
  return schema.parse(JSON.parse(bytes.toString("utf8")) as unknown);
}

/** Persist one validated Reviewer queue revision without allowing replacement. */
export async function writeReviewerActionQueueArtifact(
  runDir: string,
  relativePath: string,
  queue: ReviewerActionQueue,
): Promise<string> {
  const validated = reviewerActionQueueSchema.parse(queue);
  return writeImmutableTextArtifact(
    runDir,
    relativePath,
    `${JSON.stringify(validated, null, 2)}\n`,
  );
}

/** Read and validate a durable Hands self-review report inside the run ledger. */
export async function readHandsSelfReviewReportArtifact(
  runDir: string,
  relativePath: string,
): Promise<HandsSelfReviewReport> {
  const target = resolveAndValidateArtifactPath(runDir, relativePath);
  return handsSelfReviewReportSchema.parse(JSON.parse(await readFile(target, "utf8")));
}
