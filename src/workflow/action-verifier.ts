import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import type { CodexAdapter, CodexInvokeResult } from "../adapters/codex.js";
import { actionResolutionReviewOutputSchema, fixPacketResolutionV1OutputSchema } from "../core/output-schemas.js";
import { assertFixPacketResolutionMatchesPacket, fixPacketResolutionV1Schema, hashReviewFixPacket, type FixPacketResolutionV1, type ReviewFixPacketV1 } from "../core/review-fix-packet.js";
import { actionResolutionReviewSchema, verificationEvidenceSchema } from "../core/schema.js";
import type {
  ActionResolutionReview,
  HandsSelfReviewReport,
  ResolvedRunIntake,
  ReviewerAction,
  VerificationEvidence,
  WorkItem,
} from "../core/types.js";
import { loadPromptTemplate } from "../prompts/loader.js";
import { renderTemplate } from "../prompts/renderer.js";
import { reviewFixPacketRoot } from "./fix-packets.js";
import type { ResourceBudgetPort } from "../core/resource-budget.js";

export interface VerifyReviewerActionInput {
  runDir: string;
  worktreePath: string;
  workItem: WorkItem;
  intake: ResolvedRunIntake;
  codex: CodexAdapter;
  reviewRevision: number;
  action: ReviewerAction;
  actionAttempt: number;
  beforeDiff: string;
  afterDiff: string;
  activeVerification: VerificationEvidence;
  completedVerification: VerificationEvidence[];
  selfReviewReports: HandsSelfReviewReport[];
  planRevision?: number;
  budget?: ResourceBudgetPort;
}

export interface ActionResolutionResult {
  review: ActionResolutionReview;
  reviewPath: string;
  invocation: CodexInvokeResult;
}

export interface VerifyReviewFixPacketInput {
  runDir: string;
  worktreePath: string;
  packet: ReviewFixPacketV1;
  actionAttempt: number;
  intake: ResolvedRunIntake;
  codex: CodexAdapter;
  beforeDiff: string;
  afterDiff: string;
  verificationEvidence: VerificationEvidence;
  selfReviewReports: HandsSelfReviewReport[];
  planRevision?: number;
  reviewRevision?: number;
  actionId?: string;
  budget?: ResourceBudgetPort;
}

export interface FixPacketResolutionResult {
  review: FixPacketResolutionV1;
  reviewPath: string;
  invocation: CodexInvokeResult;
}

function assertObservedFixPacketEvidence(
  packet: ReviewFixPacketV1,
  review: FixPacketResolutionV1,
  evidence: VerificationEvidence,
): void {
  const packetCommands = new Map(packet.verification.commands.map((command) => [command.id, command.argv]));
  const requiredEvidence = new Map(packet.verification.required_evidence.map((entry) => [entry.id, entry]));
  const sameArgv = (left: readonly string[] | undefined, right: readonly string[]) => JSON.stringify(left ?? []) === JSON.stringify(right);

  for (const result of review.condition_results) {
    const condition = packet.verification.success_conditions.find((entry) => entry.id === result.success_condition_id)!;
    const allowedRefs = new Set<string>();
    let hasPassingEvidence = false;
    const commandIds = new Set<string>();
    const linkedEvidence = condition.satisfied_by
      .map((id) => requiredEvidence.get(id))
      .filter((entry) => entry !== undefined);
    for (const id of condition.satisfied_by) if (packetCommands.has(id)) commandIds.add(id);
    for (const entry of linkedEvidence) if (packetCommands.has(entry.source_id)) commandIds.add(entry.source_id);

    for (const commandId of commandIds) {
      const argv = packetCommands.get(commandId)!;
      for (const observed of evidence.commands.filter((entry) => sameArgv(entry.argv, argv))) {
        allowedRefs.add(observed.stdout_path);
        allowedRefs.add(observed.stderr_path);
        if (observed.result_path) allowedRefs.add(observed.result_path);
        if (observed.exit_code === 0 && !observed.timed_out && observed.error_code === null) hasPassingEvidence = true;
      }
    }
    for (const entry of linkedEvidence) {
      if (entry.kind === "artifact") {
        const exists = evidence.artifacts.includes(entry.output_path)
          || evidence.artifact_checks.some((check) => check.path === entry.output_path && check.exists);
        if (exists) {
          allowedRefs.add(entry.output_path);
          hasPassingEvidence = true;
        }
      } else if (entry.kind === "browser") {
        for (const observed of evidence.browser_evidence.filter((browser) =>
          browser.evidence_report_path === entry.output_path || browser.screenshot_artifact === entry.output_path)) {
          if (observed.evidence_report_path) allowedRefs.add(observed.evidence_report_path);
          allowedRefs.add(observed.screenshot_artifact);
          if (observed.status === "passed" && observed.screenshot_exists) hasPassingEvidence = true;
        }
      }
    }
    if (result.evidence_refs.some((reference) => !allowedRefs.has(reference))) {
      throw new Error(`${result.success_condition_id} references evidence outside the observed evidence for this condition`);
    }
    if (result.status === "satisfied" && !hasPassingEvidence) {
      throw new Error(`${result.success_condition_id} has no passing observed evidence`);
    }
  }
}

export function actionAttemptDecision(input: {
  readonly deterministicFailures: readonly string[];
  readonly focusedDecision: "resolved" | "still_open" | "replan_required" | null;
}): "resolved" | "still_open" {
  if (input.deterministicFailures.length > 0) return "still_open";
  return input.focusedDecision === "resolved" ? "resolved" : "still_open";
}

const commandResultSchema = z.object({
  argv: z.array(z.string()),
  stdout: z.string(),
  stderr: z.string(),
  exit_code: z.number().int().nullable(),
  duration_ms: z.number().nonnegative(),
  timed_out: z.boolean(),
  error_code: z.string().nullable(),
  error_message: z.string().nullable(),
  signal: z.string().nullable(),
});

interface MaterializedEvidence {
  kind:
    | "evidence"
    | "command_result"
    | "command_stdout"
    | "command_stderr"
    | "required_artifact"
    | "browser_screenshot"
    | "browser_report";
  relative_path: string;
  canonical_path: string;
  sha256: string;
  size_bytes: number;
  preview: string | null;
  truncated: boolean;
  truncation_marker: string | null;
  content_omitted: boolean;
  metadata?: unknown;
}

const MAX_EVIDENCE_FILE_PREVIEW_BYTES = 4_096;
const MAX_STREAM_PREVIEW_BYTES = 8_192;
const MAX_REPORT_PREVIEW_BYTES = 4_096;
const MAX_METADATA_PREVIEW_BYTES = 512;
const MAX_TOTAL_PREVIEW_BYTES = 24_000;
const MAX_SERIALIZED_EVIDENCE_CONTEXT_BYTES = 48_000;
export const MAX_FOCUSED_VERIFIER_PROMPT_BYTES = 96_000;

interface PreviewBudget {
  remaining: number;
}

export class ActionVerificationEvidenceError extends Error {
  readonly failureClass = "operational_blocker" as const;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ActionVerificationEvidenceError";
  }
}

function encodedId(id: string): string {
  return `id-${Buffer.from(id, "utf8").toString("base64url")}`;
}

export function actionResolutionReviewPath(
  workItemId: string,
  reviewRevision: number,
  actionId: string,
  actionAttempt: number,
): string {
  return `action-reviews/${encodedId(workItemId)}/revision-${reviewRevision}/${encodedId(actionId)}/attempt-${actionAttempt}.json`;
}

function isInside(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return relation === "" || (!relation.startsWith(`..${sep}`) && relation !== ".." && !isAbsolute(relation));
}

async function assertNoSymlinkComponents(root: string, candidate: string): Promise<void> {
  const relation = relative(root, candidate);
  if (!isInside(root, candidate)) {
    throw new Error(`Path must stay within its permitted root: ${candidate}`);
  }
  let current = root;
  for (const component of relation.split(sep).filter(Boolean)) {
    current = resolve(current, component);
    if ((await lstat(current)).isSymbolicLink()) {
      throw new Error(`Path contains a symlink component: ${current}`);
    }
  }
}

async function resolveExistingPath(
  rootPath: string,
  artifactPath: string,
  allowedSubdirectory?: string,
): Promise<string> {
  if (isAbsolute(artifactPath) || artifactPath.trim() === "") {
    throw new Error(`Verification artifact path must be relative: ${artifactPath}`);
  }
  const root = await realpath(rootPath);
  const allowedRoot = resolve(root, allowedSubdirectory ?? ".");
  const candidate = resolve(root, artifactPath);
  if (!isInside(allowedRoot, candidate) || candidate === allowedRoot) {
    throw new Error(`Verification artifact must stay within the verification root: ${artifactPath}`);
  }
  await assertNoSymlinkComponents(root, candidate);
  const canonicalAllowedRoot = await realpath(allowedRoot);
  const canonicalCandidate = await realpath(candidate);
  if (!isInside(canonicalAllowedRoot, canonicalCandidate) || canonicalCandidate === canonicalAllowedRoot) {
    throw new Error(`Verification artifact must stay within the verification root: ${artifactPath}`);
  }
  return canonicalCandidate;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function boundedMetadata(value: string): {
  sha256: string;
  size_bytes: number;
  preview: string;
  truncated: boolean;
} {
  const content = Buffer.from(value, "utf8");
  const previewBytes = Math.min(content.byteLength, MAX_METADATA_PREVIEW_BYTES);
  return {
    sha256: sha256(content),
    size_bytes: content.byteLength,
    preview: content.subarray(0, previewBytes).toString("utf8"),
    truncated: previewBytes < content.byteLength,
  };
}

function materializedText(
  kind: MaterializedEvidence["kind"],
  relativePath: string,
  canonicalPath: string,
  content: Buffer,
  perFileLimit: number,
  budget: PreviewBudget,
  metadata?: unknown,
): MaterializedEvidence {
  const previewBytes = Math.min(content.byteLength, perFileLimit, budget.remaining);
  budget.remaining -= previewBytes;
  const truncated = previewBytes < content.byteLength;
  return {
    kind,
    relative_path: relativePath,
    canonical_path: canonicalPath,
    sha256: sha256(content),
    size_bytes: content.byteLength,
    preview: content.subarray(0, previewBytes).toString("utf8"),
    truncated,
    truncation_marker: truncated
      ? `[truncated: showing ${previewBytes} of ${content.byteLength} bytes]`
      : null,
    content_omitted: previewBytes === 0 && content.byteLength > 0,
    ...(metadata === undefined ? {} : { metadata }),
  };
}

function serializeEvidenceContext(evidence: MaterializedEvidence[]): string {
  let serialized = JSON.stringify(evidence, null, 2);
  for (let index = evidence.length - 1;
    Buffer.byteLength(serialized, "utf8") > MAX_SERIALIZED_EVIDENCE_CONTEXT_BYTES && index >= 0;
    index -= 1) {
    if (!evidence[index].preview) continue;
    evidence[index] = {
      ...evidence[index],
      preview: null,
      truncated: true,
      truncation_marker: `[truncated: preview omitted to keep total evidence context within ${MAX_SERIALIZED_EVIDENCE_CONTEXT_BYTES} bytes]`,
      content_omitted: true,
    };
    serialized = JSON.stringify(evidence, null, 2);
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_SERIALIZED_EVIDENCE_CONTEXT_BYTES) {
    throw new ActionVerificationEvidenceError(
      `Focused verification evidence metadata exceeds ${MAX_SERIALIZED_EVIDENCE_CONTEXT_BYTES} bytes`,
    );
  }
  return serialized;
}

function materializedBinary(
  kind: MaterializedEvidence["kind"],
  relativePath: string,
  canonicalPath: string,
  content: Buffer,
): MaterializedEvidence {
  return {
    kind,
    relative_path: relativePath,
    canonical_path: canonicalPath,
    sha256: sha256(content),
    size_bytes: content.byteLength,
    preview: null,
    truncated: content.byteLength > 0,
    truncation_marker: `[binary content omitted: validated ${content.byteLength} bytes]`,
    content_omitted: true,
  };
}

async function materializeEvidence(
  runDir: string,
  worktreePath: string,
  evidence: VerificationEvidence,
  previewBudget: PreviewBudget,
): Promise<MaterializedEvidence[]> {
  try {
    const supplied = verificationEvidenceSchema.parse(evidence);
    if (!supplied.evidence_path) {
      throw new Error("Verification evidence_path is required for focused review");
    }
    const evidencePath = await resolveExistingPath(runDir, supplied.evidence_path, "verification");
    const evidenceContent = await readFile(evidencePath);
    const persisted = verificationEvidenceSchema.parse(JSON.parse(evidenceContent.toString("utf8")));
    if (!sameJson(persisted, supplied)) {
      throw new Error(`Persisted evidence does not match supplied evidence: ${supplied.evidence_path}`);
    }

    const materialized: MaterializedEvidence[] = [materializedText(
      "evidence",
      supplied.evidence_path,
      evidencePath,
      evidenceContent,
      MAX_EVIDENCE_FILE_PREVIEW_BYTES,
      previewBudget,
    )];
    for (const command of supplied.commands) {
      if (!command.result_path) {
        throw new Error(`Command result_path is required for focused review: ${command.command}`);
      }
      const resultPath = await resolveExistingPath(runDir, command.result_path, "verification");
      const resultContent = await readFile(resultPath);
      const result = commandResultSchema.parse(JSON.parse(resultContent.toString("utf8")));
      const expected = {
        argv: command.argv,
        exit_code: command.exit_code,
        duration_ms: command.duration_ms,
        timed_out: command.timed_out,
        error_code: command.error_code,
        error_message: command.error_message,
        signal: command.signal,
      };
      for (const [field, value] of Object.entries(expected)) {
        if (value !== undefined && !sameJson(result[field as keyof typeof result], value)) {
          throw new Error(`Command result ${field} does not match evidence: ${command.result_path}`);
        }
      }
      const resultMetadata = {
        argv: boundedMetadata(JSON.stringify(result.argv)),
        exit_code: result.exit_code,
        duration_ms: result.duration_ms,
        timed_out: result.timed_out,
        error_code: result.error_code === null ? null : boundedMetadata(result.error_code),
        error_message: result.error_message === null ? null : boundedMetadata(result.error_message),
        signal: result.signal === null ? null : boundedMetadata(result.signal),
      };
      materialized.push(materializedText(
        "command_result",
        command.result_path,
        resultPath,
        resultContent,
        0,
        previewBudget,
        resultMetadata,
      ));
      for (const [kind, path] of [
        ["command_stdout", command.stdout_path],
        ["command_stderr", command.stderr_path],
      ] as const) {
        const absolutePath = await resolveExistingPath(runDir, path, "verification");
        const content = await readFile(absolutePath);
        const text = content.toString("utf8");
        const resultField = kind === "command_stdout" ? "stdout" : "stderr";
        if (text !== result[resultField]) {
          throw new Error(`${resultField} does not match command result: ${path}`);
        }
        materialized.push(materializedText(
          kind,
          path,
          absolutePath,
          content,
          MAX_STREAM_PREVIEW_BYTES,
          previewBudget,
        ));
      }
    }
    for (const artifact of supplied.artifact_checks.filter((check) => check.required)) {
      if (!artifact.exists) {
        throw new Error(`Required verification artifact is missing: ${artifact.path}`);
      }
      const artifactPath = await resolveExistingPath(worktreePath, artifact.path);
      const content = await readFile(artifactPath);
      materialized.push(materializedBinary(
        "required_artifact",
        artifact.path,
        artifactPath,
        content,
      ));
    }
    for (const browser of supplied.browser_evidence) {
      if (browser.status === "passed" && !browser.screenshot_exists) {
        throw new Error(`Passed browser evidence is missing its screenshot: ${browser.screenshot_artifact}`);
      }
      if (browser.screenshot_exists) {
        const screenshotPath = await resolveExistingPath(worktreePath, browser.screenshot_artifact);
        const content = await readFile(screenshotPath);
        materialized.push(materializedBinary(
          "browser_screenshot",
          browser.screenshot_artifact,
          screenshotPath,
          content,
        ));
      }
      if (browser.evidence_report_path) {
        const reportPath = await resolveExistingPath(worktreePath, browser.evidence_report_path);
        materialized.push(materializedText(
          "browser_report",
          browser.evidence_report_path,
          reportPath,
          await readFile(reportPath),
          MAX_REPORT_PREVIEW_BYTES,
          previewBudget,
        ));
      }
    }
    return materialized;
  } catch (error) {
    if (error instanceof Error && error.message.includes("must stay within the verification root")) {
      throw new ActionVerificationEvidenceError(error.message, { cause: error });
    }
    throw new ActionVerificationEvidenceError(
      `Unable to materialize required verification evidence: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

async function prepareSafeWrite(runDir: string, relativePath: string): Promise<string> {
  if (isAbsolute(relativePath) || relativePath.trim() === "") {
    throw new Error(`Artifact path must be relative: ${relativePath}`);
  }
  const root = await realpath(runDir);
  const target = resolve(root, relativePath);
  if (!isInside(root, target) || target === root) {
    throw new Error(`Artifact path must resolve inside the run directory: ${relativePath}`);
  }
  const parentRelation = relative(root, dirname(target));
  let current = root;
  for (const component of parentRelation.split(sep).filter(Boolean)) {
    current = resolve(current, component);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) {
        throw new Error(`Artifact path contains a symlink component: ${current}`);
      }
      if (!info.isDirectory()) {
        throw new Error(`Artifact parent is not a directory: ${current}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(current);
    }
    const canonicalCurrent = await realpath(current);
    if (!isInside(root, canonicalCurrent)) {
      throw new Error(`Artifact parent escapes the run directory: ${current}`);
    }
  }
  try {
    if ((await lstat(target)).isSymbolicLink()) {
      throw new Error(`Artifact target is a symlink: ${target}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return target;
}

async function writeCreateOnce(
  runDir: string,
  relativePath: string,
  content: string,
): Promise<string> {
  const target = await prepareSafeWrite(runDir, relativePath);
  try {
    await writeFile(target, content, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if ((await lstat(target)).isSymbolicLink()) {
      throw new Error(`Artifact target is a symlink: ${target}`);
    }
    if (await readFile(target, "utf8") !== content) {
      throw new Error(`Artifact already exists with different content: ${relativePath}`);
    }
  }
  return target;
}

function parseReview(result: CodexInvokeResult): ActionResolutionReview {
  if (result.parsed === undefined) {
    throw new Error("Verifier did not return a parsed action resolution review");
  }
  return actionResolutionReviewSchema.parse(result.parsed);
}

function assertProvenance(
  review: ActionResolutionReview,
  input: VerifyReviewerActionInput,
): void {
  if (
    review.review_revision !== input.reviewRevision
    || review.action_id !== input.action.action_id
    || review.action_attempt !== input.actionAttempt
  ) {
    throw new Error(
      `Verifier action resolution provenance does not match revision ${input.reviewRevision} action ${input.action.action_id} attempt ${input.actionAttempt}`,
    );
  }
}

/** Independently verify resolution of exactly one immutable Reviewer action. */
export async function verifyReviewerAction(
  input: VerifyReviewerActionInput,
): Promise<ActionResolutionResult> {
  if (input.worktreePath.trim() === "") {
    throw new Error("Verifier worktree path is required");
  }
  if (!Number.isInteger(input.reviewRevision) || input.reviewRevision < 1) {
    throw new Error("Review revision must be a positive integer");
  }
  if (!Number.isInteger(input.actionAttempt) || input.actionAttempt < 1) {
    throw new Error("Action attempt must be a positive integer");
  }
  const previewBudget: PreviewBudget = { remaining: MAX_TOTAL_PREVIEW_BYTES };
  const evidenceContext: MaterializedEvidence[] = [];
  for (const evidence of [input.activeVerification, ...input.completedVerification]) {
    evidenceContext.push(...await materializeEvidence(
      input.runDir,
      input.worktreePath,
      evidence,
      previewBudget,
    ));
  }
  const requiredCommands = input.action.re_verification
    ?? input.action.remediation?.verification.commands.map((command) => command.argv)
    ?? [];
  for (const requiredCommand of requiredCommands) {
    const current = input.activeVerification.commands.find(
      (command) => command.argv && sameJson(command.argv, requiredCommand),
    );
    if (!current?.result_path) {
      throw new ActionVerificationEvidenceError(
        `Action-required verification command has no current result: ${requiredCommand.join(" ")}`,
      );
    }
  }
  const evidenceContextJson = serializeEvidenceContext(evidenceContext);

  const template = await loadPromptTemplate("verifier-action-resolution-v2");
  const prompt = renderTemplate(template, {
    work_item_json: JSON.stringify(input.workItem, null, 2),
    action_json: JSON.stringify(input.action, null, 2),
    before_diff: input.beforeDiff,
    after_diff: input.afterDiff,
    evidence_context_json: evidenceContextJson,
    self_review_reports_json: JSON.stringify(input.selfReviewReports, null, 2),
    review_revision: String(input.reviewRevision),
    action_id: input.action.action_id,
    action_attempt: String(input.actionAttempt),
  });
  if (Buffer.byteLength(prompt, "utf8") > MAX_FOCUSED_VERIFIER_PROMPT_BYTES) {
    throw new ActionVerificationEvidenceError(
      `Focused Verifier prompt exceeds ${MAX_FOCUSED_VERIFIER_PROMPT_BYTES} bytes`,
    );
  }
  const workItemId = encodedId(input.workItem.id);
  const actionId = encodedId(input.action.action_id);
  const artifactName = `verifier-action-${workItemId}-revision-${input.reviewRevision}-${actionId}-attempt-${input.actionAttempt}`;
  const responsePath = `responses/${artifactName}.json`;
  const reviewRelativePath = actionResolutionReviewPath(
    input.workItem.id,
    input.reviewRevision,
    input.action.action_id,
    input.actionAttempt,
  );
  await prepareSafeWrite(input.runDir, responsePath);
  await prepareSafeWrite(input.runDir, reviewRelativePath);
  await writeCreateOnce(input.runDir, `prompts/${artifactName}.md`, prompt);
  await writeCreateOnce(
    input.runDir,
    `schemas/${artifactName}.json`,
    `${JSON.stringify(actionResolutionReviewOutputSchema, null, 2)}\n`,
  );

  const profile = input.intake.roles.verifier;
  const invocationArtifactName = `${artifactName}-invocation-${randomUUID()}`;
  const stagingOutputPath = await prepareSafeWrite(
    input.runDir,
    `responses/${invocationArtifactName}.json`,
  );
  try {
    const invocation = await input.codex.invoke({
      role: "verifier",
      model: profile.model,
      reasoningEffort: profile.reasoning_effort,
      sandbox: "read-only",
      cwd: input.worktreePath,
      prompt,
      runDir: input.runDir,
      artifactName: invocationArtifactName,
      budget: input.budget,
      attemptKey: input.planRevision === undefined
        ? undefined
        : `focused-verifier:${input.planRevision}:${input.workItem.id}:${input.reviewRevision}:${input.action.action_id}:${input.actionAttempt}`,
      outputSchema: actionResolutionReviewOutputSchema,
      outputParser: actionResolutionReviewSchema,
    });
    if (invocation.exitCode !== 0) {
      throw new Error(
        `Verifier action review failed for ${input.action.action_id}: exitCode=${invocation.exitCode ?? "null"}`,
      );
    }

    const review = parseReview(invocation);
    assertProvenance(review, input);
    await writeCreateOnce(
      input.runDir,
      responsePath,
      `${JSON.stringify(review, null, 2)}\n`,
    );
    const reviewAbsolutePath = await writeCreateOnce(
      input.runDir,
      reviewRelativePath,
      `${JSON.stringify(review, null, 2)}\n`,
    );
    const reviewPath = relative(await realpath(input.runDir), reviewAbsolutePath);
    return { review, reviewPath, invocation };
  } finally {
    await unlink(stagingOutputPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

export async function verifyReviewFixPacket(input: VerifyReviewFixPacketInput): Promise<FixPacketResolutionResult> {
  if (input.worktreePath.trim() === "") throw new Error("Verifier worktree path is required");
  const verificationEvidence = verificationEvidenceSchema.parse(input.verificationEvidence);
  const packetId = encodedId(input.packet.provenance.packet_id);
  const reviewPath = `${reviewFixPacketRoot(input.packet.provenance.packet_id)}/attempts/${input.actionAttempt}/focused-resolution.json`;
  const existing = await readFile(resolve(input.runDir, reviewPath), "utf8").then((content) => fixPacketResolutionV1Schema.parse(JSON.parse(content))).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (existing) {
    if (existing.packet_id !== input.packet.provenance.packet_id || existing.packet_sha256 !== hashReviewFixPacket(input.packet) || existing.action_attempt !== input.actionAttempt) {
      throw new Error("Persisted packet resolution provenance does not match the active packet");
    }
    assertFixPacketResolutionMatchesPacket(input.packet, existing);
    assertObservedFixPacketEvidence(input.packet, existing, verificationEvidence);
    return { review: existing, reviewPath, invocation: {} as never };
  }
  const template = await loadPromptTemplate("verifier-fix-packet-resolution-v1");
  const prompt = renderTemplate(template, {
    fix_packet_json: JSON.stringify(input.packet, null, 2), before_diff: input.beforeDiff, after_diff: input.afterDiff,
    verification_json: JSON.stringify(verificationEvidence, null, 2), self_review_reports_json: JSON.stringify(input.selfReviewReports, null, 2),
  });
  const artifactName = `verifier-fix-packet-${packetId}-attempt-${input.actionAttempt}`;
  await writeCreateOnce(input.runDir, `prompts/${artifactName}.md`, prompt);
  await writeCreateOnce(input.runDir, `schemas/${artifactName}.json`, `${JSON.stringify(fixPacketResolutionV1OutputSchema, null, 2)}\n`);
  const profile = input.intake.roles.verifier;
  const invocation = await input.codex.invoke({
    role: "verifier", model: profile.model, reasoningEffort: profile.reasoning_effort, sandbox: "read-only", cwd: input.worktreePath,
    prompt, runDir: input.runDir, artifactName, outputSchema: fixPacketResolutionV1OutputSchema, outputParser: fixPacketResolutionV1Schema,
    budget: input.budget,
    attemptKey: input.planRevision === undefined
      ? undefined
      : `focused-verifier:${input.planRevision}:${input.packet.provenance.work_item_id}:${input.reviewRevision ?? input.actionAttempt}:${input.actionId ?? input.packet.provenance.packet_id}:${input.actionAttempt}`,
  });
  if (invocation.exitCode !== 0 || invocation.parsed === undefined) throw new Error(`Verifier packet resolution failed for ${input.packet.provenance.packet_id}`);
  const review = fixPacketResolutionV1Schema.parse(invocation.parsed);
  if (review.packet_id !== input.packet.provenance.packet_id || review.packet_sha256 !== hashReviewFixPacket(input.packet) || review.action_attempt !== input.actionAttempt) {
    throw new Error("Verifier packet resolution provenance does not match the active packet");
  }
  assertFixPacketResolutionMatchesPacket(input.packet, review);
  assertObservedFixPacketEvidence(input.packet, review, verificationEvidence);
  await writeCreateOnce(input.runDir, reviewPath, `${JSON.stringify(review, null, 2)}\n`);
  return { review, reviewPath, invocation };
}
