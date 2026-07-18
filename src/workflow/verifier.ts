import { readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import type { CodexAdapter, CodexInvokeResult } from "../adapters/codex.js";
import { verifierReviewOutputSchema } from "../core/output-schemas.js";
import { strictVerifierReviewSchema } from "../core/schema.js";
import type {
  ImplementationResult,
  ResolvedRunIntake,
  VerificationEvidence,
  VerifierReview,
  WorkItem,
} from "../core/types.js";
import { writeTextArtifact } from "../core/ledger.js";
import { loadPromptTemplate } from "../prompts/loader.js";
import { renderTemplate } from "../prompts/renderer.js";
import type { ProgressReporter } from "../progress/log.js";
import type { ArtifactRefV1, VerifierContextV1 } from "../core/context-contracts.js";
import type { ResourceBudgetPort } from "../core/resource-budget.js";
import { validateVerifierInvocationContext } from "./role-context.js";
import { collectScopedWorktreeDiff, type ScopedDiff } from "../adapters/git.js";
import { readManifestV2 } from "../core/ledger.js";
import { loadEvidenceIndex, verifierEvidenceIndexPath } from "./evidence-index.js";

interface VerifyWorkItemInputCommon {
  runDir: string;
  worktreePath: string;
  workItem: WorkItem;
  intake: ResolvedRunIntake;
  codex: CodexAdapter;
  attempt?: number;
  progress?: ProgressReporter;
  workItemIndex?: number;
  workItemTotal?: number;
  budget?: ResourceBudgetPort;
}

export type VerifyWorkItemInput = VerifyWorkItemInputCommon & (
  | {
      contextRef: ArtifactRefV1;
      context: VerifierContextV1;
      phase: VerifierContextV1["phase"];
      final: boolean;
      implementation?: never;
      verification?: never;
      priorVerification?: never;
    }
  | {
      contextRef?: never;
      context?: never;
      phase?: never;
      implementation: ImplementationResult;
      verification: VerificationEvidence;
      priorVerification?: VerificationEvidence[];
      final?: boolean;
    }
);

export interface VerifyWorkItemResult {
  review: VerifierReview;
  reviewPath: string;
  invocation: CodexInvokeResult;
}

export class VerifierReviewFailedError extends Error {
  constructor(message: string, readonly result: CodexInvokeResult) {
    super(message);
    this.name = "VerifierReviewFailedError";
  }
}

const MAX_CONTEXT_BYTES = 32_000;

async function readContextFile(path: string): Promise<string> {
  try {
    const content = await readFile(path, "utf8");
    return content.length > MAX_CONTEXT_BYTES
      ? `${content.slice(0, MAX_CONTEXT_BYTES)}\n[content truncated]`
      : content;
  } catch (error) {
    return `[unavailable: ${error instanceof Error ? error.message : String(error)}]`;
  }
}

async function buildArtifactsContext(
  runDir: string,
  worktreePath: string,
  verification: VerificationEvidence,
  priorVerification: VerificationEvidence[] = [],
): Promise<string> {
  const entries = new Map<string, { relativePath: string; absolutePath: string }>();
  const addRunArtifact = (relativePath: string): void => {
    entries.set(`run:${relativePath}`, {
      relativePath,
      absolutePath: resolve(runDir, relativePath),
    });
  };
  const addWorktreeArtifact = (relativePath: string): void => {
    entries.set(`worktree:${relativePath}`, {
      relativePath,
      absolutePath: resolve(worktreePath, relativePath),
    });
  };

  for (const savedVerification of [...priorVerification, verification]) {
    if (savedVerification.evidence_path) addRunArtifact(savedVerification.evidence_path);
    for (const command of savedVerification.commands) {
      addRunArtifact(command.stdout_path);
      addRunArtifact(command.stderr_path);
      if (command.result_path) addRunArtifact(command.result_path);
    }
    for (const artifact of savedVerification.artifacts) addWorktreeArtifact(artifact);
    for (const artifact of savedVerification.artifact_checks) addWorktreeArtifact(artifact.path);
  }

  const context = [];
  for (const entry of entries.values()) {
    context.push({
      relative_path: entry.relativePath,
      absolute_path: entry.absolutePath,
      content: await readContextFile(entry.absolutePath),
    });
  }
  return JSON.stringify(context, null, 2);
}

function artifactId(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function parseReview(result: CodexInvokeResult): VerifierReview {
  if (result.parsed === undefined) {
    throw new Error("Verifier did not return a parsed review");
  }
  return strictVerifierReviewSchema.parse(result.parsed);
}

function assertReviewProvenance(review: VerifierReview, input: VerifyWorkItemInput, attempt: number): void {
  const final = input.contextRef === undefined ? input.final === true : input.phase !== "work_item";
  if (review.work_item_id !== input.workItem.id || review.attempt !== attempt || review.final !== final) {
    throw new Error(`Verifier review provenance does not match ${input.workItem.id} attempt ${attempt}`);
  }
}

function assertBoundedAcceptanceCoverage(review: VerifierReview, workItem: WorkItem): void {
  const coverage = review.acceptance_coverage;
  if (new Set(coverage).size !== coverage.length) {
    throw new Error("Bounded Verifier acceptance coverage contains duplicate IDs");
  }
  const known = new Set(workItem.acceptance.map(({ id }) => id));
  const unknown = coverage.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    throw new Error(`Bounded Verifier acceptance coverage contains unknown IDs: ${unknown.join(", ")}`);
  }
  if (review.decision !== "approve") return;
  const required = workItem.completion_contract.required_acceptance_ids;
  const covered = new Set(coverage);
  if (coverage.length !== required.length || required.some((id) => !covered.has(id))) {
    throw new Error("Bounded Verifier approval acceptance coverage is not the exact required set");
  }
}

export interface VerifierScopeAuthority {
  baseCommit: string;
  headCommit: string;
}

export async function loadVerifierScopeAuthority(input: {
  runDir: string;
  workItemId: string;
  phase: VerifierContextV1["phase"];
  attempt: number;
  evidenceIndexRef: ArtifactRefV1 | null;
}): Promise<VerifierScopeAuthority> {
  const manifest = await readManifestV2(input.runDir);
  const progress = manifest.work_item_progress[input.workItemId];
  const baseCommit = progress?.context_base_commit;
  if (typeof baseCommit !== "string") throw new Error("Bounded Verifier context base commit is unavailable");
  if (input.phase === "work_item") {
    if (input.evidenceIndexRef !== null) throw new Error("Work-item Verifier scope cannot use a terminal evidence index");
    return { baseCommit, headCommit: baseCommit };
  }
  const indexPath = verifierEvidenceIndexPath(input.phase, input.attempt);
  if (
    manifest.final_verifier_index_path !== indexPath
    || typeof manifest.final_verifier_index_sha256 !== "string"
  ) throw new Error(`${input.phase} Verifier scope requires its current evidence index authority`);
  const authoritativeRef = { path: indexPath, sha256: manifest.final_verifier_index_sha256 };
  if (
    input.evidenceIndexRef?.path !== authoritativeRef.path
    || input.evidenceIndexRef.sha256 !== authoritativeRef.sha256
  ) throw new Error(`${input.phase} Verifier context evidence index is not current authority`);
  const candidateCommit = manifest.work_item_progress.integrated?.commit_sha;
  if (typeof candidateCommit !== "string") {
    throw new Error(`${input.phase} Verifier scope requires current integrated candidate authority`);
  }
  const index = await loadEvidenceIndex(input.runDir, authoritativeRef, {
    phase: input.phase,
    attempt: input.attempt,
    candidateCommit,
  });
  return { baseCommit, headCommit: index.candidate_commit };
}

export function assertVerifierScopeSnapshot(
  context: VerifierContextV1,
  snapshot: ScopedDiff,
  authority: VerifierScopeAuthority,
): void {
  if (snapshot.base_commit !== authority.baseCommit) {
    throw new Error("Bounded Verifier Git snapshot base does not match durable authority");
  }
  if (snapshot.head_commit !== authority.headCommit) {
    throw new Error("Bounded Verifier Git snapshot HEAD does not match current authority");
  }
  if (context.diff !== snapshot.patch) {
    throw new Error("Bounded Verifier context diff does not match the current controller Git snapshot");
  }
  if (JSON.stringify(context.changed_files) !== JSON.stringify(snapshot.changed_files)) {
    throw new Error("Bounded Verifier context changed files do not match the current controller Git snapshot");
  }
}

function hasOwn(input: object, key: PropertyKey): boolean {
  return Object.hasOwn(input, key);
}

/** Independently review one implementation and its saved evidence read-only. */
export async function verifyWorkItem(input: VerifyWorkItemInput): Promise<VerifyWorkItemResult> {
  if (input.worktreePath.trim() === "") {
    throw new Error("Verifier worktree path is required");
  }

  const manifest = await readManifestV2(input.runDir);
  const attempt = input.attempt ?? 1;
  const boundedProtocol = manifest.workflow_protocol === "bounded-context-v1";
  const boundedKeys = ["contextRef", "context", "phase", "final"] as const;
  const legacyKeys = ["implementation", "verification", "priorVerification"] as const;
  if (boundedProtocol) {
    if (boundedKeys.some((key) => !hasOwn(input, key) || input[key] === undefined)) {
      throw new Error("bounded-context-v1 Verifier requires a complete bounded context package");
    }
    if (legacyKeys.some((key) => hasOwn(input, key))) {
      throw new Error("bounded-context-v1 Verifier cannot include legacy broad-context fields");
    }
  } else if (["contextRef", "context", "phase"].some((key) => hasOwn(input, key))) {
    throw new Error("Legacy Verifier protocol cannot include bounded context package fields");
  }
  const boundedContext = !boundedProtocol
    ? null
    : await validateVerifierInvocationContext({
        runDir: input.runDir,
        contextRef: input.contextRef!,
        context: input.context!,
        workItem: input.workItem,
        phase: input.phase!,
        attempt,
      });
  if (boundedContext !== null) {
    if (manifest.worktree_path === null || resolve(manifest.worktree_path) !== resolve(input.worktreePath)) {
      throw new Error("Bounded Verifier worktree does not match manifest authority");
    }
    const baseCommit = manifest.work_item_progress[input.workItem.id]?.context_base_commit;
    if (typeof baseCommit !== "string") throw new Error("Bounded Verifier context base commit is unavailable");
    const snapshot = await collectScopedWorktreeDiff({
      repoRoot: input.worktreePath,
      baseCommit,
      workItem: input.workItem,
    });
    const scopeAuthority = await loadVerifierScopeAuthority({
      runDir: input.runDir,
      workItemId: input.workItem.id,
      phase: input.phase!,
      attempt,
      evidenceIndexRef: boundedContext.context.evidence_index_ref,
    });
    assertVerifierScopeSnapshot(boundedContext.context, snapshot, scopeAuthority);
  }
  const final = boundedContext === null ? input.final === true : input.phase !== "work_item";
  if (boundedContext !== null && input.final !== final) {
    throw new Error("Bounded Verifier final coordinate does not match its phase");
  }
  const workItemCoordinate = {
    index: input.workItemIndex ?? 1,
    total: input.workItemTotal ?? 1,
    attempt,
    final,
  };
  let prompt: string;
  if (boundedContext === null) {
    const legacyInput = input as VerifyWorkItemInputCommon & {
      implementation: ImplementationResult;
      verification: VerificationEvidence;
      priorVerification?: VerificationEvidence[];
      final?: boolean;
    };
    prompt = renderTemplate(await loadPromptTemplate("verifier-review-legacy-v2"), {
      work_item_json: JSON.stringify(input.workItem, null, 2),
      implementation_json: JSON.stringify(legacyInput.implementation, null, 2),
      verification_json: JSON.stringify(legacyInput.verification, null, 2),
      prior_verification_json: JSON.stringify(legacyInput.priorVerification ?? [], null, 2),
      review_work_item_id: input.workItem.id,
      review_attempt: String(attempt),
      review_final: String(legacyInput.final === true),
      review_revision: String(attempt),
      run_dir: resolve(input.runDir),
      evidence_root: resolve(input.runDir, "verification"),
      artifacts_context: await buildArtifactsContext(
        input.runDir,
        input.worktreePath,
        legacyInput.verification,
        legacyInput.priorVerification,
      ),
    });
  } else {
    prompt = renderTemplate(await loadPromptTemplate("verifier-review-v2"), {
      context_package_json: JSON.stringify({
        context_ref: boundedContext.context_ref,
        context: boundedContext.context,
      }, null, 2),
    });
  }
  const id = artifactId(input.workItem.id);
  const suffix = final ? `final-attempt-${attempt}` : `attempt-${attempt}`;
  const artifactName = `verifier-review-${id}-${suffix}`;
  await writeTextArtifact(input.runDir, `prompts/${artifactName}.md`, prompt);
  await writeTextArtifact(
    input.runDir,
    `schemas/${artifactName}.json`,
    `${JSON.stringify(verifierReviewOutputSchema, null, 2)}\n`,
  );

  const profile = input.intake.roles.verifier;
  const invocation = await input.codex.invoke({
    role: "verifier",
    model: profile.model,
    reasoningEffort: profile.reasoning_effort,
    sandbox: "read-only",
    cwd: input.worktreePath,
    prompt,
    runDir: input.runDir,
    artifactName,
    budget: input.budget,
    attemptKey: boundedContext === null
      ? undefined
      : `verifier:${manifest.approved_revision}:${input.workItem.id}:${input.phase}:${attempt}`,
    outputSchema: verifierReviewOutputSchema,
    outputParser: strictVerifierReviewSchema,
    progress: input.progress ? { reporter: input.progress, context: { source: "verifier", mode: final ? "final_review" : "review", model: profile.model, reasoningEffort: profile.reasoning_effort, workItem: workItemCoordinate } } : undefined,
  });
  if (invocation.exitCode !== 0) {
    throw new VerifierReviewFailedError(
      `Verifier review failed for ${input.workItem.id}: exitCode=${invocation.exitCode ?? "null"}`,
      invocation,
    );
  }
  const review = parseReview(invocation);
  assertReviewProvenance(review, input, attempt);
  if (boundedContext !== null) assertBoundedAcceptanceCoverage(review, input.workItem);
  await writeTextArtifact(
    input.runDir,
    `responses/${artifactName}.json`,
    `${JSON.stringify(review, null, 2)}\n`,
  );
  const reviewAbsolutePath = await writeTextArtifact(
    input.runDir,
    `reviews/${id}/${suffix}.json`,
    `${JSON.stringify(review, null, 2)}\n`,
  );
  const reviewPath = relative(resolve(input.runDir), resolve(reviewAbsolutePath));
  const decisionCode = review.decision === "approve" ? (final ? "final_verifier_approved" : "verifier_approved")
    : review.decision === "request_changes" ? "verifier_changes" : "verifier_replan";
  await input.progress?.emit({ code: decisionCode, source: "verifier", workItem: workItemCoordinate });
  return { review, reviewPath, invocation };
}

export const reviewWorkItem = verifyWorkItem;
export const runVerifierReview = verifyWorkItem;
export const runVerifier = verifyWorkItem;
