import { access, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { CodexAdapter, CodexInvokeResult } from "../adapters/codex.js";
import { handsSelfReviewReportOutputSchema } from "../core/output-schemas.js";
import { handsSelfReviewReportSchema } from "../core/schema.js";
import type {
  HandsSelfReviewReport,
  ImplementationResult,
  ResolvedRunIntake,
  ReviewerAction,
  RoleProfile,
  VerificationEvidence,
  WorkItem,
} from "../core/types.js";
import { writeTextArtifact } from "../core/ledger.js";
import { loadPromptTemplate } from "../prompts/loader.js";
import { renderTemplate } from "../prompts/renderer.js";
import type { ResourceBudgetPort } from "../core/resource-budget.js";
import { invocationArtifactName } from "./invocation-artifacts.js";

export interface HandsSelfReviewInput {
  runDir: string;
  worktreePath: string;
  workItem: WorkItem;
  intake: ResolvedRunIntake;
  codex: CodexAdapter;
  parentAttempt: number;
  mutationKind: HandsSelfReviewReport["mutation_kind"];
  pass: number;
  implementation: ImplementationResult;
  currentDiff: string;
  verification: VerificationEvidence;
  activeAction: ReviewerAction | null;
  completedActions: ReviewerAction[];
  priorPassReports: HandsSelfReviewReport[];
  profile?: Pick<RoleProfile, "model" | "reasoning_effort">;
  resumeBlockedClaim?: boolean;
  contextPlanRevision?: number;
  budget?: ResourceBudgetPort;
}

export interface HandsSelfReviewResult {
  report: HandsSelfReviewReport;
  reportPath: string;
  invocation: CodexInvokeResult;
}

function artifactId(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function parseReport(result: CodexInvokeResult): HandsSelfReviewReport {
  if (result.parsed === undefined) {
    throw new Error("Hands did not return a parsed self-review report");
  }
  return handsSelfReviewReportSchema.parse(result.parsed);
}

function assertProvenance(report: HandsSelfReviewReport, input: HandsSelfReviewInput): void {
  const activeActionId = input.activeAction?.action_id ?? null;
  if (
    report.work_item_id !== input.workItem.id
    || report.parent_attempt !== input.parentAttempt
    || report.mutation_kind !== input.mutationKind
    || report.pass !== input.pass
    || report.active_action_id !== activeActionId
  ) {
    throw new Error(
      `Hands self-review provenance does not match ${input.workItem.id} attempt ${input.parentAttempt} pass ${input.pass}`,
    );
  }
}

async function writeImmutableReport(runDir: string, reportPath: string, report: HandsSelfReviewReport): Promise<void> {
  const absolutePath = resolve(runDir, reportPath);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
}

function alreadyExistsError(path: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`Hands self-review pass already exists or is claimed: ${path}`), {
    code: "EEXIST",
  });
}

async function claimPass(runDir: string, reportPath: string, claimPath: string, resumeBlockedClaim = false): Promise<string> {
  const absoluteReportPath = resolve(runDir, reportPath);
  try {
    await access(absoluteReportPath);
    throw alreadyExistsError(reportPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const absoluteClaimPath = resolve(runDir, claimPath);
  await mkdir(dirname(absoluteClaimPath), { recursive: true });
  if (resumeBlockedClaim) {
    try {
      const claim = JSON.parse(await readFile(absoluteClaimPath, "utf8")) as { state?: unknown };
      if (claim.state !== "blocked") throw alreadyExistsError(claimPath);
      await rename(absoluteClaimPath, `${absoluteClaimPath}.primary-blocked`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  await writeFile(absoluteClaimPath, `${JSON.stringify({ report_path: reportPath, state: "claimed" })}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  return absoluteClaimPath;
}

async function markClaimBlocked(absoluteClaimPath: string, reportPath: string): Promise<void> {
  const temporaryPath = `${absoluteClaimPath}.blocked.tmp`;
  try {
    await writeFile(
      temporaryPath,
      `${JSON.stringify({ report_path: reportPath, state: "blocked" })}\n`,
      { encoding: "utf8", flag: "wx" },
    );
    await rename(temporaryPath, absoluteClaimPath);
  } catch {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

/** Invoke the active Hands profile for one independently persisted self-review/fix pass. */
export async function runHandsSelfReview(input: HandsSelfReviewInput): Promise<HandsSelfReviewResult> {
  if (input.worktreePath.trim() === "") {
    throw new Error("Hands self-review worktree path is required");
  }

  const id = artifactId(input.workItem.id);
  const baseArtifactName = `hands-self-review-${id}-attempt-${input.parentAttempt}-pass-${input.pass}`;
  const artifactName = input.resumeBlockedClaim
    ? await invocationArtifactName(input.runDir, baseArtifactName)
    : baseArtifactName;
  const reportPath = `self-review/${id}/attempt-${input.parentAttempt}/pass-${input.pass}.json`;
  const claimPath = `self-review/${id}/attempt-${input.parentAttempt}/pass-${input.pass}.claim.json`;
  const activeActionId = input.activeAction?.action_id ?? null;
  const absoluteClaimPath = await claimPass(input.runDir, reportPath, claimPath, input.resumeBlockedClaim);
  let invocationStarted = false;
  try {
    const template = await loadPromptTemplate("hands-self-review-v2");
    const scopeInstruction = input.activeAction === null
      ? "Because no active Reviewer action is present, you may fix other defects only when they are inside the approved work-item scope. Defer findings outside that scope."
      : "Because an active Reviewer action is present, fixes are limited exclusively to that action, regressions caused by the current mutation, and preservation of completed actions. Defer every other finding.";
    const prompt = renderTemplate(template, {
      work_item_json: JSON.stringify(input.workItem, null, 2),
      implementation_json: JSON.stringify(input.implementation, null, 2),
      current_diff: input.currentDiff,
      verification_json: JSON.stringify(input.verification, null, 2),
      active_action_json: JSON.stringify(input.activeAction, null, 2),
      completed_actions_json: JSON.stringify(input.completedActions, null, 2),
      prior_pass_reports_json: JSON.stringify(input.priorPassReports, null, 2),
      self_review_work_item_id: input.workItem.id,
      self_review_parent_attempt: String(input.parentAttempt),
      self_review_mutation_kind: input.mutationKind,
      self_review_pass: String(input.pass),
      self_review_active_action_id: activeActionId ?? "null",
      self_review_scope_instruction: scopeInstruction,
    });

    await writeTextArtifact(input.runDir, `prompts/${artifactName}.md`, prompt);
    await writeTextArtifact(
      input.runDir,
      `schemas/${artifactName}.json`,
      `${JSON.stringify(handsSelfReviewReportOutputSchema, null, 2)}\n`,
    );

    const profile = input.profile ?? input.intake.roles.hands;
    invocationStarted = true;
    const invocation = await input.codex.invoke({
      role: "hands",
      model: profile.model,
      reasoningEffort: profile.reasoning_effort,
      sandbox: "workspace-write",
      cwd: input.worktreePath,
      prompt,
      runDir: input.runDir,
      artifactName,
      budget: input.budget,
      attemptKey: input.contextPlanRevision === undefined
        ? undefined
        : `hands-self-review:${input.contextPlanRevision}:${input.workItem.id}:${input.parentAttempt}:${input.pass}`,
      outputSchema: handsSelfReviewReportOutputSchema,
      outputParser: handsSelfReviewReportSchema,
    });
    if (invocation.exitCode !== 0) {
      throw new Error(
        `Hands self-review failed for ${input.workItem.id}: exitCode=${invocation.exitCode ?? "null"}`,
      );
    }

    const parsedReport = parseReport(invocation);
    const report = handsSelfReviewReportSchema.parse({
      ...parsedReport,
      work_item_id: input.workItem.id,
      parent_attempt: input.parentAttempt,
      mutation_kind: input.mutationKind,
      pass: input.pass,
      active_action_id: activeActionId,
    });
    assertProvenance(report, input);
    await writeTextArtifact(
      input.runDir,
      `responses/${artifactName}.json`,
      `${JSON.stringify(report, null, 2)}\n`,
    );
    await writeImmutableReport(input.runDir, reportPath, report);

    return { report, reportPath, invocation };
  } catch (error) {
    if (invocationStarted) {
      await markClaimBlocked(absoluteClaimPath, reportPath);
    } else {
      await unlink(absoluteClaimPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
    throw error;
  }
}
