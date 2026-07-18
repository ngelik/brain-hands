import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  artifactRefFromBytes,
  type ArtifactRefV1,
} from "../core/context-contracts.js";
import type {
  EngineFinding,
  FindingIdentityInput,
  FindingRevisionInput,
  FindingSummary,
  RunManifestV2,
} from "../core/types.js";
import {
  engineFindingSchema,
  findingIndexSchema,
  findingIdentityInputSchema,
  findingRevisionInputSchema,
  findingSummarySchema,
} from "../core/schema.js";
import type { RunLedgerTransaction } from "../core/ledger.js";
import {
  readManifestV2,
  withRunLedgerCompoundTransaction,
  withRunLedgerTransaction,
} from "../core/ledger.js";
import { readOwnedRunFile } from "../core/owned-evidence.js";

const noFollow = constants.O_NOFOLLOW ?? 0;

export interface FindingPersistenceHooks {
  afterFindingsDirectoryValidated?: () => Promise<void>;
  afterTailQuarantineSynced?: () => Promise<void>;
  afterHistoryDescriptorRead?: () => Promise<void>;
}

interface FindingsDirectoryIdentity {
  path: string;
  realPath: string;
  dev: number;
  ino: number;
}

function normalizeLocation(value: string): string {
  const normalized = value.normalize("NFKC").trim().replaceAll("\\", "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) {
    throw new Error("Finding location must be repository-relative, not absolute");
  }
  const parts: string[] = [];
  for (const part of normalized.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) throw new Error("Finding location dot segments underflow repository root");
      parts.pop();
    }
    else parts.push(part);
  }
  return parts.join("/");
}

function normalizeProblemClass(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("en-US");
}

export function fingerprintFinding(input: FindingIdentityInput): string {
  if (typeof input.normalized_location === "string" && normalizeLocation(input.normalized_location) === "") {
    throw new Error("Finding normalized location must not be canonically empty");
  }
  if (typeof input.problem_class === "string" && normalizeProblemClass(input.problem_class) === "") {
    throw new Error("Finding problem class must not be canonically empty");
  }
  // Select only engine identity fields. Model IDs, prose, and other caller
  // metadata cannot affect the fingerprint even if present at runtime.
  const identity = findingIdentityInputSchema.parse({
    work_item_id: input.work_item_id,
    criterion_ref: input.criterion_ref,
    source: input.source,
    normalized_location: input.normalized_location,
    problem_class: input.problem_class,
  });
  const canonical = JSON.stringify([
    identity.work_item_id.trim(),
    identity.criterion_ref.trim(),
    identity.source,
    normalizeLocation(identity.normalized_location),
    normalizeProblemClass(identity.problem_class),
  ]);
  return `finding:${createHash("sha256").update(canonical).digest("hex")}`;
}

function encodedWorkItemId(workItemId: string): string {
  return `work-item-${Buffer.from(workItemId, "utf8").toString("base64url")}`;
}

export function findingHistoryPath(runDir: string, workItemId: string): string {
  if (workItemId.trim() === "") throw new Error("Finding work_item_id must be non-empty");
  return join(runDir, "findings", `${encodedWorkItemId(workItemId)}.jsonl`);
}

function errorCode(error: unknown): unknown {
  return error && typeof error === "object" && "code" in error ? error.code : undefined;
}

async function fsyncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | noFollow);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function captureFindingsDirectory(path: string): Promise<FindingsDirectoryIdentity> {
  const status = await lstat(path);
  if (status.isSymbolicLink()) throw new Error("Findings directory must not be a symlink");
  if (!status.isDirectory()) throw new Error("Findings path must be a directory");
  return { path, realPath: await realpath(path), dev: status.dev, ino: status.ino };
}

async function assertFindingsDirectory(identity: FindingsDirectoryIdentity): Promise<void> {
  const current = await captureFindingsDirectory(identity.path);
  if (
    current.dev !== identity.dev
    || current.ino !== identity.ino
    || current.realPath !== identity.realPath
  ) throw new Error("Findings directory identity changed during history access");
}

async function ensureSafeFindingsDirectory(runDir: string): Promise<FindingsDirectoryIdentity> {
  const findingsDir = join(runDir, "findings");
  let status = await lstat(findingsDir).catch((error: unknown) => {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  });
  if (status === null) {
    await mkdir(findingsDir, { mode: 0o700 });
    await fsyncDirectory(runDir);
    status = await lstat(findingsDir);
  }
  return captureFindingsDirectory(findingsDir);
}

async function validateOpenHistory(
  path: string,
  handle: Awaited<ReturnType<typeof open>>,
  parent: FindingsDirectoryIdentity,
): Promise<void> {
  const status = await handle.stat();
  if (!status.isFile()) throw new Error("Finding history target must be a regular open file");
  const canonicalStatus = await lstat(path);
  if (canonicalStatus.isSymbolicLink() || !canonicalStatus.isFile()) {
    throw new Error("Finding history canonical target must remain a regular file");
  }
  if (status.dev !== canonicalStatus.dev || status.ino !== canonicalStatus.ino) {
    throw new Error("Finding history canonical target identity changed during access");
  }
  const openedRealPath = await realpath(path);
  if (dirname(openedRealPath) !== parent.realPath) {
    throw new Error("Finding history target escaped its findings directory");
  }
  await assertFindingsDirectory(parent);
}

async function readHistoryBytes(
  path: string,
  parent: FindingsDirectoryIdentity,
  hooks: FindingPersistenceHooks,
  readOnly = false,
): Promise<Buffer | null> {
  await assertFindingsDirectory(parent);
  const status = await lstat(path).catch((error: unknown) => {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  });
  if (status === null) return null;
  if (status.isSymbolicLink()) throw new Error("Finding history target must not be a symlink");
  if (!status.isFile()) throw new Error("Finding history target must be a regular file");

  const handle = await open(path, (readOnly ? constants.O_RDONLY : constants.O_RDWR) | noFollow);
  try {
    await validateOpenHistory(path, handle, parent);
    let bytes = await handle.readFile();
    await hooks.afterHistoryDescriptorRead?.();
    await validateOpenHistory(path, handle, parent);
    if (bytes.length > 0 && bytes[bytes.length - 1] !== 0x0a) {
      if (readOnly) throw new Error("Finding history has an incomplete final record");
      const lastNewline = bytes.lastIndexOf(0x0a);
      const completeLength = lastNewline + 1;
      const tail = bytes.subarray(completeLength);
      const quarantinePath = join(
        dirname(path),
        `${basename(path)}.corrupt-tail-${randomUUID()}`,
      );
      const quarantine = await open(
        quarantinePath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
        0o600,
      );
      try {
        await quarantine.writeFile(tail);
        await quarantine.sync();
      } finally {
        await quarantine.close();
      }
      await fsyncDirectory(dirname(path));
      await hooks.afterTailQuarantineSynced?.();
      await handle.truncate(completeLength);
      await handle.sync();
      await fsyncDirectory(dirname(path));
      bytes = bytes.subarray(0, completeLength);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function readHistory(
  path: string,
  workItemId: string,
  parent: FindingsDirectoryIdentity,
  hooks: FindingPersistenceHooks,
  readOnly = false,
): Promise<EngineFinding[]> {
  const bytes = await readHistoryBytes(path, parent, hooks, readOnly);
  if (bytes === null) return [];
  const raw = bytes.toString("utf8");
  const previousById = new Map<string, EngineFinding>();
  return raw.split("\n").filter((line) => line.trim() !== "").map((line) => {
    const finding = engineFindingSchema.parse(JSON.parse(line));
    if (finding.work_item_id !== workItemId) {
      throw new Error("Finding history work-item provenance does not match its path");
    }
    if (finding.finding_id !== fingerprintFinding(finding)) {
      throw new Error(`Finding ${finding.finding_id} identity does not match its engine fingerprint`);
    }
    const previous = previousById.get(finding.finding_id);
    if (!previous) {
      if (
        finding.occurrences !== 1
        || finding.first_seen_revision !== finding.last_seen_revision
        || finding.repeated_from !== undefined
      ) {
        throw new Error(`Finding ${finding.finding_id} history must begin with occurrence 1`);
      }
    } else if (
      finding.occurrences !== previous.occurrences + 1
      || finding.first_seen_revision !== previous.first_seen_revision
      || finding.last_seen_revision <= previous.last_seen_revision
      || finding.repeated_from !== finding.finding_id
    ) {
      throw new Error(`Finding ${finding.finding_id} history occurrence chain is invalid`);
    }
    previousById.set(finding.finding_id, finding);
    return finding;
  });
}

export async function loadFindingRevisionRecords(
  runDir: string,
  workItemId: string,
  reviewRevision: number,
  findingIds: string[],
  hooks: FindingPersistenceHooks = {},
): Promise<EngineFinding[]> {
  if (findingIds.some((findingId) => !/^finding:[a-f0-9]{64}$/.test(findingId))) {
    throw new Error("Requested finding IDs are malformed");
  }
  if (new Set(findingIds).size !== findingIds.length) {
    throw new Error("Requested finding IDs contain duplicates");
  }
  const complete = await loadCompleteFindingRevisionRecords(runDir, workItemId, reviewRevision, hooks);
  const requested = new Set(findingIds);
  const extra = complete.find((finding) => !requested.has(finding.finding_id));
  if (extra) throw new Error(`Finding revision ${reviewRevision} contains extra record ${extra.finding_id}`);
  const completeById = new Map(complete.map((finding) => [finding.finding_id, finding]));
  const missing = findingIds.find((findingId) => !completeById.has(findingId));
  if (missing) throw new Error(`Finding revision ${reviewRevision} is missing record ${missing}`);
  return findingIds.map((findingId) => completeById.get(findingId)!);
}

export async function loadCompleteFindingRevisionRecords(
  runDir: string,
  workItemId: string,
  reviewRevision: number,
  hooks: FindingPersistenceHooks = {},
): Promise<EngineFinding[]> {
  const normalizedWorkItemId = workItemId.trim();
  if (!normalizedWorkItemId) throw new Error("Finding work_item_id must be non-empty");
  if (!Number.isInteger(reviewRevision) || reviewRevision < 1) {
    throw new Error("Finding review revision must be positive");
  }

  let findingsDirectory: FindingsDirectoryIdentity;
  try {
    findingsDirectory = await captureFindingsDirectory(join(runDir, "findings"));
  } catch (error) {
    if (errorCode(error) === "ENOENT") return [];
    throw error;
  }
  const historyPath = findingHistoryPath(runDir, normalizedWorkItemId);
  const history = await readHistory(
    historyPath,
    normalizedWorkItemId,
    findingsDirectory,
    hooks,
    true,
  );
  const revisionRecords = history.filter((finding) => finding.last_seen_revision === reviewRevision);
  const revisionById = new Map<string, EngineFinding>();
  for (const finding of revisionRecords) {
    if (revisionById.has(finding.finding_id)) {
      throw new Error(`Finding revision ${reviewRevision} contains duplicate records`);
    }
    revisionById.set(finding.finding_id, finding);
  }

  const manifest = await readManifestV2(runDir);
  const ordered = [...revisionById.values()].sort((left, right) =>
    left.finding_id.localeCompare(right.finding_id));
  for (const finding of ordered) {
    validateProvenance(manifest, {
      work_item_id: finding.work_item_id,
      source: finding.source,
      severity: finding.severity,
      disposition: finding.disposition,
      criterion_ref: finding.criterion_ref,
      normalized_location: finding.normalized_location,
      problem_class: finding.problem_class,
      problem: finding.problem,
      required_fix: finding.required_fix,
      evidence_refs: finding.evidence_refs,
      review_revision: reviewRevision,
    });
  }
  return ordered;
}

const unresolvedDispositions = new Set<EngineFinding["disposition"]>([
  "blocking",
  "fix_in_scope",
  "requires_replan",
]);

export interface CurrentFindingResolution {
  findings: EngineFinding[];
  resolved_finding_ids: string[];
  unresolved_finding_ids: string[];
}

export async function loadCurrentFindingResolution(
  runDir: string,
  workItemId: string,
  reviewRevision: number,
  findingIds?: string[],
): Promise<CurrentFindingResolution> {
  const findings = await loadCompleteFindingRevisionRecords(runDir, workItemId, reviewRevision);
  const completeIds = findings.map((finding) => finding.finding_id);
  if (findingIds !== undefined) {
    if (new Set(findingIds).size !== findingIds.length
      || JSON.stringify([...findingIds].sort()) !== JSON.stringify(completeIds)) {
      throw new Error(`Finding revision ${reviewRevision} does not match the complete finding set`);
    }
  }
  const activeIds = new Set(findings.map((finding) => finding.finding_id));
  const manifest = await readManifestV2(runDir);
  if (Object.values(manifest.finding_index ?? {}).some((finding) =>
    finding.work_item_id === workItemId && finding.last_seen_revision > reviewRevision)) {
    throw new Error(`Finding revision ${reviewRevision} is older than the current durable finding history`);
  }
  return {
    findings,
    resolved_finding_ids: [...new Set(Object.values(manifest.finding_index ?? {})
      .filter((finding) => finding.work_item_id === workItemId && !activeIds.has(finding.finding_id))
      .map((finding) => finding.finding_id))].sort(),
    unresolved_finding_ids: [...new Set(findings
      .filter((finding) => unresolvedDispositions.has(finding.disposition))
      .map((finding) => finding.finding_id))].sort(),
  };
}

export async function loadCurrentUnresolvedFindingReference(
  runDir: string,
  workItemId: string,
  reviewRevision: number,
): Promise<ArtifactRefV1 | null> {
  return withRunLedgerTransaction(runDir, async (transaction) => {
    const before = await loadCurrentFindingResolution(transaction.runDir, workItemId, reviewRevision);
    if (before.unresolved_finding_ids.length === 0) return null;
    const relativePath = `findings/${basename(findingHistoryPath(transaction.runDir, workItemId))}`;
    const bytes = await readOwnedRunFile(transaction.runDir, relativePath);
    const after = await loadCurrentFindingResolution(transaction.runDir, workItemId, reviewRevision);
    if (JSON.stringify(before.unresolved_finding_ids) !== JSON.stringify(after.unresolved_finding_ids)) {
      throw new Error("Current unresolved finding authority changed while its artifact reference was built");
    }
    return artifactRefFromBytes(relativePath, bytes);
  });
}

function validateProvenance(manifest: RunManifestV2, input: FindingRevisionInput): void {
  if (!manifest.review_policy_snapshot) {
    throw new Error("Finding history is unavailable for a legacy run without a review policy snapshot");
  }
  const releaseGuard = manifest.release_guards?.some((guard) => guard.id === input.criterion_ref) ?? false;
  const approvedRevision = manifest.approved_revision ?? manifest.approved_plan_revision;
  const approvedPlan = approvedRevision === null ? undefined : manifest.plan_revisions[String(approvedRevision)];
  const criterion = input.work_item_id === "integrated"
    ? Object.values(approvedPlan?.acceptance_criteria ?? {})
        .flat()
        .some((candidate) => candidate.ref === input.criterion_ref)
    : approvedPlan?.acceptance_criteria?.[input.work_item_id]
        ?.some((candidate) => candidate.ref === input.criterion_ref) ?? false;
  if (input.source === "release_guard" && !releaseGuard) {
    throw new Error("Release-guard finding provenance must reference a snapshotted release guard");
  }
  if (input.source !== "release_guard" && !criterion) {
    throw new Error(
      `Finding source provenance must reference an approved criterion for ${input.work_item_id}`,
    );
  }
}

function summaryOf(finding: EngineFinding): FindingSummary {
  return findingSummarySchema.parse({
    finding_id: finding.finding_id,
    work_item_id: finding.work_item_id,
    severity: finding.severity,
    disposition: finding.disposition,
    first_seen_revision: finding.first_seen_revision,
    last_seen_revision: finding.last_seen_revision,
    occurrences: finding.occurrences,
  });
}

async function updateIndex(
  transaction: RunLedgerTransaction,
  finding: EngineFinding,
): Promise<void> {
  const manifest = await transaction.readManifestV2();
  await transaction.updateManifestV2({
    finding_index: {
      ...(manifest.finding_index ?? {}),
      [finding.finding_id]: summaryOf(finding),
    },
  });
}

function sameRevisionInput(existing: EngineFinding, input: FindingRevisionInput): boolean {
  return existing.work_item_id === input.work_item_id
    && existing.source === input.source
    && existing.severity === input.severity
    && existing.disposition === input.disposition
    && existing.criterion_ref === input.criterion_ref
    && existing.normalized_location === input.normalized_location
    && existing.problem_class === input.problem_class
    && existing.problem === input.problem
    && existing.required_fix === input.required_fix
    && JSON.stringify(existing.evidence_refs) === JSON.stringify(input.evidence_refs);
}

async function appendAndSync(
  path: string,
  finding: EngineFinding,
  parent: FindingsDirectoryIdentity,
): Promise<void> {
  await assertFindingsDirectory(parent);
  const existed = await lstat(path).then((status) => {
    if (status.isSymbolicLink()) throw new Error("Finding history target must not be a symlink");
    if (!status.isFile()) throw new Error("Finding history target must be a regular file");
    return true;
  }).catch((error: unknown) => {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  });
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | noFollow,
    0o600,
  );
  try {
    await validateOpenHistory(path, handle, parent);
    await handle.writeFile(`${JSON.stringify(finding)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (!existed) await fsyncDirectory(dirname(path));
}

export async function recordFindingRevision(
  runDir: string,
  rawInput: FindingRevisionInput,
  hooks: FindingPersistenceHooks = {},
): Promise<EngineFinding> {
  const parsedInput = findingRevisionInputSchema.parse(rawInput);
  const input = findingRevisionInputSchema.parse({
    ...parsedInput,
    normalized_location: normalizeLocation(parsedInput.normalized_location),
    problem_class: normalizeProblemClass(parsedInput.problem_class),
  });
  return withRunLedgerCompoundTransaction(runDir, async (transaction) => {
    const findingsDirectory = await ensureSafeFindingsDirectory(transaction.runDir);
    await hooks.afterFindingsDirectoryValidated?.();
    const manifest = await transaction.readManifestV2();
    validateProvenance(manifest, input);
    const findingId = fingerprintFinding(input);
    const historyPath = findingHistoryPath(transaction.runDir, input.work_item_id);
    const history = await readHistory(historyPath, input.work_item_id, findingsDirectory, hooks);
    const previous = [...history].reverse().find((finding) => finding.finding_id === findingId);

    if (previous && input.review_revision === previous.last_seen_revision) {
      if (!sameRevisionInput(previous, input)) {
        throw new Error(`Finding ${findingId} revision ${input.review_revision} already exists with different content`);
      }
      await updateIndex(transaction, previous);
      return previous;
    }
    if (previous && input.review_revision < previous.last_seen_revision) {
      throw new Error(`Finding ${findingId} review revision must increase monotonically`);
    }

    const finding = engineFindingSchema.parse({
      finding_id: findingId,
      work_item_id: input.work_item_id,
      source: input.source,
      severity: input.severity,
      disposition: input.disposition,
      criterion_ref: input.criterion_ref,
      normalized_location: input.normalized_location,
      problem_class: input.problem_class,
      problem: input.problem,
      required_fix: input.required_fix,
      evidence_refs: input.evidence_refs,
      first_seen_revision: previous?.first_seen_revision ?? input.review_revision,
      last_seen_revision: input.review_revision,
      occurrences: (previous?.occurrences ?? 0) + 1,
      ...(previous ? { repeated_from: previous.finding_id } : {}),
    });

    await appendAndSync(historyPath, finding, findingsDirectory);
    await updateIndex(transaction, finding);
    return finding;
  });
}

export async function readFindingIndex(runDir: string): Promise<Record<string, FindingSummary>> {
  const manifest = await readManifestV2(runDir);
  return findingIndexSchema.parse(Object.fromEntries(Object.entries(manifest.finding_index ?? {}).map(([id, summary]) => [
    id,
    findingSummarySchema.parse(summary),
  ])));
}
