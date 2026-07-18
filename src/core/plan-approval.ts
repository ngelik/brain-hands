import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { planApprovalRequestSchema } from "./schema.js";
import {
  runConfigurationSha256,
  type ResolvedRunConfiguration,
} from "./run-configuration.js";
import type {
  BrainPlan,
  DiscoveredBrainPlan,
  PlanApprovalDeltaV1,
  PlanApprovalReasonCode,
  PlanApprovalRequestV1,
  PlanApprovalSubjectV1,
  RunManifestV2,
} from "./types.js";

export function canonicalApprovalJson(value: unknown): string {
  const normalize = (candidate: unknown): unknown => {
    if (Array.isArray(candidate)) return candidate.map(normalize);
    if (candidate && typeof candidate === "object") {
      return Object.fromEntries(Object.entries(candidate as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, normalize(nested)]));
    }
    return candidate;
  };
  return JSON.stringify(normalize(value)) as string;
}

export function approvalSha256(value: unknown): string {
  return createHash("sha256").update(canonicalApprovalJson(value), "utf8").digest("hex");
}

function isDiscoveredPlan(plan: BrainPlan): plan is DiscoveredBrainPlan {
  return "discovery_brief_revision" in plan;
}

export function planDecisionContract(plan: BrainPlan): unknown {
  return {
    feature_slug: plan.feature_slug ?? null,
    parent_issue: plan.parent_issue ?? null,
    assumptions: plan.assumptions,
    architecture: plan.architecture,
    risks: plan.risks,
    controller_bootstrap: plan.controller_bootstrap ?? null,
    work_items: plan.work_items,
    integration_verification: plan.integration_verification,
    discovery: isDiscoveredPlan(plan) ? {
      discovery_brief_revision: plan.discovery_brief_revision,
      discovery_brief_sha256: plan.discovery_brief_sha256,
      discovery_decision_coverage: plan.discovery_decision_coverage,
      accepted_risks: plan.accepted_risks,
      out_of_scope: plan.out_of_scope,
    } : null,
  };
}

export function planDecisionContractSha256(plan: BrainPlan): string {
  return approvalSha256(planDecisionContract(plan));
}

export function buildPlanApprovalRequest(input: {
  manifest: RunManifestV2;
  runConfiguration: ResolvedRunConfiguration;
  reasonCode: PlanApprovalReasonCode;
  revision: number;
  baseRevision: number | null;
  planPath: string;
  planSha256: string;
  decisionContractSha256: string;
  delta: PlanApprovalDeltaV1;
  reconstructInitialAuthority?: boolean;
}): PlanApprovalRequestV1 {
  const {
    manifest,
    runConfiguration,
    reasonCode,
    revision,
    baseRevision,
    planPath,
    planSha256,
    decisionContractSha256,
    delta,
  } = input;
  const configurationSha256 = runConfigurationSha256(runConfiguration);
  if (manifest.run_configuration_sha256 !== null
    && manifest.run_configuration_sha256 !== configurationSha256) {
    throw new Error("Run configuration does not match the immutable manifest digest");
  }
  const reviewPolicy = manifest.review_policy_snapshot ?? runConfiguration.limits.review_policy;
  const warningContinuation = input.reconstructInitialAuthority
    && reasonCode === "initial_plan"
    && manifest.warning_continuation_authority?.source === "approved_plan"
    ? { source: "approved_plan", actor_scope: "approving_actor" }
    : manifest.warning_continuation_authority ?? (
      reviewPolicy.on_limit === "continue_with_warning"
        ? { source: "approved_plan", actor_scope: "approving_actor" }
        : { source: "none" }
    );
  const subject: PlanApprovalSubjectV1 = {
    schema_version: 1,
    gate: "plan",
    reason_code: reasonCode,
    run_id: manifest.run_id,
    plan_revision: revision,
    base_plan_revision: baseRevision,
    plan_sha256: planSha256,
    prerequisite_subject_sha256: approvalSha256({
      workflow_protocol: manifest.workflow_protocol,
      approved_discovery_brief_revision: manifest.discovery?.approved_brief_revision ?? null,
      approved_discovery_brief_sha256: manifest.discovery?.approved_brief_sha256 ?? null,
    }),
    execution_context_sha256: approvalSha256({
      repo_root: manifest.repo_root,
      source_commit: manifest.source_commit,
      workflow_protocol: manifest.workflow_protocol,
      run_configuration_sha256: configurationSha256,
      controller_provenance: manifest.controller_provenance ?? null,
    }),
    authority_contract_sha256: approvalSha256({
      mode: runConfiguration.mode,
      github: runConfiguration.github,
      review_policy: reviewPolicy,
      release_guards: manifest.release_guards ?? [],
      warning_continuation: warningContinuation,
      merge_authority: "manual_only",
    }),
    decision_contract_sha256: decisionContractSha256,
  };
  const request = {
    schema_version: 1 as const,
    gate: reasonCode === "initial_plan" ? "initial_plan" as const : "replan" as const,
    requested_revision: revision,
    base_revision: baseRevision,
    artifact_path: planPath,
    artifact_sha256: planSha256,
    subject,
    approval_subject_sha256: approvalSha256(subject),
    fresh_approval_required: true,
    reuse_reason: null,
    reason_code: reasonCode,
    reason: reasonCode === "initial_plan"
      ? "The exact initial plan must be approved before implementation begins."
      : "Verifier findings require changes outside the currently approved decision contract.",
    plan_path: planPath,
    delta,
    additional_approvals_expected: "only_if_material_replan" as const,
  };
  return planApprovalRequestSchema.parse(request);
}

export function serializePlanApprovalRequest(request: PlanApprovalRequestV1): string {
  return `${canonicalApprovalJson(planApprovalRequestSchema.parse(request))}\n`;
}

export function requestSha256(request: PlanApprovalRequestV1): string {
  return createHash("sha256").update(serializePlanApprovalRequest(request), "utf8").digest("hex");
}

export function planApprovalRequestPath(revision: number): string {
  if (!Number.isInteger(revision) || revision < 1) throw new Error("Plan revision must be positive");
  return `approvals/plan/revision-${revision}.json`;
}

export function renderPlanApprovalRequest(request: PlanApprovalRequestV1): string {
  const parsed = planApprovalRequestSchema.parse(request);
  const heading = parsed.subject.reason_code === "initial_plan"
    ? "Initial plan approval required"
    : "Material replan approval required";
  const explanation = parsed.reason ?? (
    parsed.subject.reason_code === "initial_plan"
      ? "The exact initial plan must be approved before implementation begins."
      : "Verifier findings require changes outside the currently approved decision contract."
  );
  return [
    heading,
    `Why: ${explanation}`,
    `Run: ${parsed.subject.run_id}`,
    `Plan revision: ${parsed.subject.plan_revision}`,
    `Base revision: ${parsed.subject.base_plan_revision ?? "none"}`,
    `Plan: ${parsed.plan_path}`,
    `Plan SHA-256: ${parsed.subject.plan_sha256}`,
    `Approval subject SHA-256: ${parsed.approval_subject_sha256}`,
    `Decision changes: ${parsed.delta.entries.length}`,
    "Additional approval is expected only after a material replan.",
  ].join("\n");
}

interface ApprovalDirectoryIdentity {
  path: string;
  realPath: string;
  dev: number;
  ino: number;
}

interface ApprovalFileIdentity {
  dev: number;
  ino: number;
}

export interface PlanApprovalIoHooks {
  beforeRequestOpen?: () => Promise<void>;
  afterRequestOpen?: () => Promise<void>;
  beforeRequestWrite?: () => Promise<void>;
}

const noFollow = constants.O_NOFOLLOW ?? 0;

async function captureApprovalDirectory(path: string): Promise<ApprovalDirectoryIdentity> {
  const status = await lstat(path);
  if (status.isSymbolicLink()) throw new Error("Plan approval directory must not be a symlink");
  if (!status.isDirectory()) throw new Error("Plan approval directory must be a directory");
  const realPath = await realpath(path);
  if (realPath !== path) throw new Error("Plan approval directory escaped the run directory");
  return { path, realPath, dev: status.dev, ino: status.ino };
}

async function assertApprovalDirectoryIdentity(identity: ApprovalDirectoryIdentity): Promise<void> {
  const current = await captureApprovalDirectory(identity.path);
  if (current.dev !== identity.dev
    || current.ino !== identity.ino
    || current.realPath !== identity.realPath) {
    throw new Error("Plan approval directory identity changed during file access");
  }
}

async function fsyncApprovalDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | noFollow);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function approvalDirectory(runDir: string, create: boolean): Promise<ApprovalDirectoryIdentity> {
  const root = await realpath(resolve(runDir));
  let current = root;
  for (const segment of ["approvals", "plan"]) {
    const next = join(current, segment);
    const status = await lstat(next).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    if (status === null) {
      if (!create) throw new Error("Plan approval directory is missing");
      await mkdir(next, { mode: 0o700 });
    } else if (status.isSymbolicLink() || !status.isDirectory()) {
      throw new Error("Plan approval directory must be a real directory");
    }
    if (await realpath(next) !== next) throw new Error("Plan approval directory escaped the run directory");
    current = next;
  }
  return captureApprovalDirectory(current);
}

function assertRequestInParent(openedRealPath: string, parent: ApprovalDirectoryIdentity): void {
  if (dirname(openedRealPath) !== parent.realPath) {
    throw new Error("Plan approval request escaped its parent directory");
  }
}

function matchesOpenedFile(
  status: Awaited<ReturnType<typeof lstat>>,
  opened: ApprovalFileIdentity,
): boolean {
  return !status.isSymbolicLink()
    && status.isFile()
    && status.dev === opened.dev
    && status.ino === opened.ino;
}

async function cleanupFailedRequest(
  target: string,
  parent: ApprovalDirectoryIdentity,
  opened: ApprovalFileIdentity | null,
): Promise<void> {
  if (opened === null) return;
  try {
    await assertApprovalDirectoryIdentity(parent);
    const status = await lstat(target);
    if (!matchesOpenedFile(status, opened)) return;
    assertRequestInParent(await realpath(target), parent);
    await assertApprovalDirectoryIdentity(parent);
    const confirmed = await lstat(target);
    if (!matchesOpenedFile(confirmed, opened)) return;
    await assertApprovalDirectoryIdentity(parent);
    await unlink(target);
    await assertApprovalDirectoryIdentity(parent);
    await fsyncApprovalDirectory(parent.realPath);
  } catch {
    // Preserve the original write error. Identity loss deliberately skips
    // pathname cleanup so a replacement outside the run cannot be touched.
  }
}

async function assertCanonicalRequestIdentity(
  target: string,
  parent: ApprovalDirectoryIdentity,
  opened: ApprovalFileIdentity,
): Promise<void> {
  await assertApprovalDirectoryIdentity(parent);
  const pathname = await lstat(target);
  if (!matchesOpenedFile(pathname, opened)) {
    throw new Error("Plan approval request identity changed during file access");
  }
  assertRequestInParent(await realpath(target), parent);
  await assertApprovalDirectoryIdentity(parent);
  const confirmed = await lstat(target);
  if (!matchesOpenedFile(confirmed, opened)) {
    throw new Error("Plan approval request identity changed during file access");
  }
  await assertApprovalDirectoryIdentity(parent);
}

export async function writePlanApprovalRequest(
  runDir: string,
  request: PlanApprovalRequestV1,
  hooks: PlanApprovalIoHooks = {},
): Promise<{ path: string; sha256: string }> {
  const parsed = planApprovalRequestSchema.parse(request);
  const path = planApprovalRequestPath(parsed.subject.plan_revision);
  const parent = await approvalDirectory(runDir, true);
  const target = join(parent.path, `revision-${parsed.subject.plan_revision}.json`);
  await hooks.beforeRequestOpen?.();
  await assertApprovalDirectoryIdentity(parent);
  const handle = await open(
    target,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
    0o600,
  );
  let openedRealPath: string | null = null;
  let openedIdentity: ApprovalFileIdentity | null = null;
  let failed = false;
  let failure: unknown;
  try {
    const openedStatus = await handle.stat();
    if (!openedStatus.isFile()) throw new Error("Plan approval request must be a regular file");
    openedIdentity = { dev: openedStatus.dev, ino: openedStatus.ino };
    openedRealPath = await realpath(target);
    await hooks.afterRequestOpen?.();
    assertRequestInParent(openedRealPath, parent);
    await assertApprovalDirectoryIdentity(parent);
    await hooks.beforeRequestWrite?.();
    await assertApprovalDirectoryIdentity(parent);
    await handle.writeFile(serializePlanApprovalRequest(parsed), "utf8");
    await assertApprovalDirectoryIdentity(parent);
    await handle.sync();
    await assertCanonicalRequestIdentity(target, parent, openedIdentity);
  } catch (error) {
    failed = true;
    failure = error;
  } finally {
    try {
      await handle.close();
    } catch (error) {
      if (!failed) {
        failed = true;
        failure = error;
      }
    }
  }
  if (failed) {
    await cleanupFailedRequest(target, parent, openedIdentity);
    throw failure;
  }
  await assertApprovalDirectoryIdentity(parent);
  await fsyncApprovalDirectory(parent.realPath);
  await assertCanonicalRequestIdentity(target, parent, openedIdentity!);
  return { path, sha256: requestSha256(parsed) };
}

export async function readVerifiedPlanApprovalRequest(
  runDir: string,
  manifest: RunManifestV2,
  hooks: Pick<PlanApprovalIoHooks, "beforeRequestOpen" | "afterRequestOpen"> = {},
): Promise<PlanApprovalRequestV1> {
  const pending = manifest.pending_plan_approval;
  if (pending === null) throw new Error("Run has no pending plan approval");
  const expectedPath = planApprovalRequestPath(pending.proposed_revision);
  if (pending.request_path !== expectedPath) throw new Error("Pending plan approval path is not canonical");
  const revision = manifest.plan_revisions[String(pending.proposed_revision)];
  if (!revision) throw new Error("Pending plan approval revision is missing");
  if (revision.approval_request_path !== pending.request_path
    || revision.approval_request_sha256 !== pending.request_sha256
    || revision.approval_subject_sha256 !== pending.approval_subject_sha256) {
    throw new Error("Pending plan approval does not match its revision record");
  }

  const parent = await approvalDirectory(runDir, false);
  const target = join(parent.path, `revision-${pending.proposed_revision}.json`);
  await hooks.beforeRequestOpen?.();
  await assertApprovalDirectoryIdentity(parent);
  const status = await lstat(target);
  if (status.isSymbolicLink() || !status.isFile()) {
    throw new Error("Plan approval request must be a regular non-symlink file");
  }
  const handle = await open(target, constants.O_RDONLY | noFollow);
  let bytes: string;
  try {
    const descriptor = await handle.stat();
    if (!descriptor.isFile()) throw new Error("Plan approval request must be a regular file");
    const openedIdentity = { dev: descriptor.dev, ino: descriptor.ino };
    const openedRealPath = await realpath(target);
    await hooks.afterRequestOpen?.();
    assertRequestInParent(openedRealPath, parent);
    await assertApprovalDirectoryIdentity(parent);
    bytes = await handle.readFile("utf8");
    await assertCanonicalRequestIdentity(target, parent, openedIdentity);
  } finally {
    await handle.close();
  }
  const parsed = planApprovalRequestSchema.parse(JSON.parse(bytes));
  if (serializePlanApprovalRequest(parsed) !== bytes) {
    throw new Error("Plan approval request bytes are not canonical");
  }
  if (requestSha256(parsed) !== pending.request_sha256) {
    throw new Error("Plan approval request digest does not match the pending pointer");
  }
  if (approvalSha256(parsed.subject) !== parsed.approval_subject_sha256
    || parsed.approval_subject_sha256 !== pending.approval_subject_sha256) {
    throw new Error("Plan approval subject digest does not match the pending pointer");
  }
  if (parsed.subject.run_id !== manifest.run_id
    || parsed.subject.plan_revision !== pending.proposed_revision
    || parsed.subject.base_plan_revision !== pending.base_revision
    || parsed.subject.plan_sha256 !== revision.sha256
    || parsed.subject.decision_contract_sha256 !== revision.decision_contract_sha256
    || parsed.plan_path !== revision.path) {
    throw new Error("Plan approval request does not match the manifest revision");
  }
  return parsed;
}
