import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CodexAdapter, CodexInvokeResult } from "../adapters/codex.js";
import {
  formatIssueBody,
  formatReviewComment,
  type GitHubAdapter,
} from "../adapters/github.js";
import { collectDiff } from "../adapters/git.js";
import { readManifest, updateManifest, writeTextArtifact } from "../core/ledger.js";
import {
  issueSpecSchema,
  legacyVerificationEvidenceSchema,
  prReviewSchema,
} from "../core/schema.js";
import type {
  BrainHandsConfig,
  IssueSpec,
  PrReview,
  RunManifest,
  VerificationEvidence,
} from "../core/types.js";
import { loadPromptTemplate } from "../prompts/loader.js";
import { renderTemplate } from "../prompts/renderer.js";

export interface ReviewPullRequestInput {
  repoRoot: string;
  runDir: string;
  issueNumber: number;
  prNumber: number;
  config: BrainHandsConfig;
  codex: CodexAdapter;
  github: GitHubAdapter;
  dryRun: boolean;
}

export interface ReviewPullRequestResult {
  issueNumber: number;
  prNumber: number;
  review: PrReview;
  commentCount: number;
  retryCount: number;
}

export interface ApplyFixesInput {
  repoRoot: string;
  runDir: string;
  issueNumber: number;
  prNumber: number;
  config: BrainHandsConfig;
  codex: CodexAdapter;
  dryRun: boolean;
}

export interface ApplyFixesResult {
  issueNumber: number;
  prNumber: number;
  fixesPath: string;
  retryCount: number;
}

export class BrainReviewFailedError extends Error {
  constructor(
    message: string,
    readonly result: CodexInvokeResult,
  ) {
    super(message);
    this.name = "BrainReviewFailedError";
  }
}

export class MalformedReviewOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MalformedReviewOutputError";
  }
}

export class HandsFixFailedError extends Error {
  constructor(
    message: string,
    readonly result: CodexInvokeResult,
  ) {
    super(message);
    this.name = "HandsFixFailedError";
  }
}

export class RetryLimitExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetryLimitExceededError";
  }
}

export class EmptyReviewFindingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmptyReviewFindingsError";
  }
}

const DRY_RUN_DIFF = [
  "diff --git a/src/workflow/reviewer.ts b/src/workflow/reviewer.ts",
  "new file mode 100644",
  "index 0000000..1111111",
  "--- /dev/null",
  "+++ b/src/workflow/reviewer.ts",
  "@@ -0,0 +1,4 @@",
  "+export async function reviewPullRequest(): Promise<void> {",
  '+  throw new Error("dry-run diff placeholder");',
  "+}",
].join("\n");

function resolveIssueIndex(issueNumber: number, issueNumbers: number[], issueCount: number): number {
  if (issueNumbers.length > 0) {
    const index = issueNumbers.indexOf(issueNumber);
    if (index === -1) {
      throw new Error(`Issue ${issueNumber} is not present in manifest.issue_numbers`);
    }
    return index;
  }

  const index = issueNumber - 1;
  if (index < 0 || index >= issueCount) {
    throw new Error(`Issue ${issueNumber} is out of range for issues.json`);
  }
  return index;
}

function findBalancedJsonSegment(text: string): string | null {
  const fencedMatches = text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi);
  for (const match of fencedMatches) {
    const candidate = match[1]?.trim();
    if (!candidate) {
      continue;
    }
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      // Keep scanning for another candidate.
    }
  }

  const startCandidates = [text.indexOf("{"), text.indexOf("[")]
    .filter((index) => index >= 0)
    .sort((left, right) => left - right);

  for (const start of startCandidates) {
    const opening = text[start];
    const closing = opening === "{" ? "}" : "]";
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let index = start; index < text.length; index += 1) {
      const char = text[index];

      if (inString) {
        if (escaped) {
          escaped = false;
          continue;
        }
        if (char === "\\") {
          escaped = true;
          continue;
        }
        if (char === "\"") {
          inString = false;
        }
        continue;
      }

      if (char === "\"") {
        inString = true;
        continue;
      }

      if (char === opening) {
        depth += 1;
      } else if (char === closing) {
        depth -= 1;
        if (depth === 0) {
          return text.slice(start, index + 1);
        }
      }
    }
  }

  return null;
}

function fallbackDryRunReview(): PrReview {
  return {
    decision: "approve",
    requirement_coverage: {
      passed: ["Dry-run fallback approval used after malformed reviewer output."],
      failed: [],
    },
    verification: {
      commands_reviewed: [],
      commands_missing: [],
      artifacts_reviewed: [],
    },
    findings: [],
    residual_risks: ["Reviewer output could not be parsed in dry-run mode."],
  };
}

function parseReviewOutput(text: string): PrReview {
  const direct = tryParseReview(text);
  if (direct) {
    return direct;
  }

  const extracted = findBalancedJsonSegment(text);
  if (extracted) {
    const parsed = tryParseReview(extracted);
    if (parsed) {
      return parsed;
    }
  }

  throw new MalformedReviewOutputError("Failed to parse reviewer output into PrReview JSON");
}

function tryParseReview(text: string): PrReview | null {
  try {
    return prReviewSchema.parse(JSON.parse(text));
  } catch {
    return null;
  }
}

function assertSuccessfulReviewInvocation(
  prNumber: number,
  result: CodexInvokeResult,
): void {
  if (result.exitCode === 0) {
    return;
  }

  const details = [
    `exitCode=${result.exitCode === null ? "null" : result.exitCode}`,
    `promptPath=${result.promptPath}`,
    `stdoutPath=${result.stdoutPath}`,
    `stderrPath=${result.stderrPath}`,
  ];

  throw new BrainReviewFailedError(
    `Brain review failed for PR ${prNumber}: ${details.join(", ")}`,
    result,
  );
}

function assertSuccessfulFixInvocation(
  prNumber: number,
  result: CodexInvokeResult,
): void {
  if (result.exitCode === 0) {
    return;
  }

  const details = [
    `exitCode=${result.exitCode === null ? "null" : result.exitCode}`,
    `promptPath=${result.promptPath}`,
    `stdoutPath=${result.stdoutPath}`,
    `stderrPath=${result.stderrPath}`,
  ];

  throw new HandsFixFailedError(
    `Hands fixer failed for PR ${prNumber}: ${details.join(", ")}`,
    result,
  );
}

function fixAttemptKey(prNumber: number): string {
  return `pr:${prNumber}`;
}

async function loadIssue(runDir: string, issueNumber: number, manifest: RunManifest): Promise<IssueSpec> {
  const rawIssues = await readFile(join(runDir, "issues.json"), "utf8");
  const issues = issueSpecSchema.array().parse(JSON.parse(rawIssues));
  return issues[resolveIssueIndex(issueNumber, manifest.issue_numbers, issues.length)];
}

async function loadOriginalRequest(runDir: string, manifest: RunManifest): Promise<string> {
  const originalRequest = await readFile(join(runDir, "original-request.md"), "utf8");
  return originalRequest.trim() || manifest.original_request;
}

async function loadVerificationEvidence(runDir: string, issueNumber: number): Promise<VerificationEvidence> {
  const evidencePath = `verification/issue-${issueNumber}/evidence.json`;
  const rawEvidence = await readFile(join(runDir, evidencePath), "utf8");
  const legacy = legacyVerificationEvidenceSchema.parse(JSON.parse(rawEvidence));
  return {
    verification_scope: "github",
    work_item_id: `legacy-issue-${issueNumber}`,
    issue_number: issueNumber,
    attempt: legacy.attempt ?? 1,
    evidence_path: legacy.evidence_path ?? evidencePath,
    commands: legacy.commands,
    artifacts: legacy.artifacts,
    artifact_checks: legacy.artifact_checks,
    browser_evidence: legacy.browser_evidence,
    created_at: legacy.created_at,
  };
}

async function loadStoredReview(runDir: string, prNumber: number): Promise<PrReview> {
  const rawReview = await readFile(join(runDir, "reviews", `pr-${prNumber}-review.json`), "utf8");
  return prReviewSchema.parse(JSON.parse(rawReview));
}

async function collectReviewDiff(repoRoot: string, dryRun: boolean): Promise<string> {
  return dryRun ? DRY_RUN_DIFF : collectDiff(repoRoot);
}

export async function reviewPullRequest(
  input: ReviewPullRequestInput,
): Promise<ReviewPullRequestResult> {
  const manifest = await readManifest(input.runDir);
  const issue = await loadIssue(input.runDir, input.issueNumber, manifest);
  const originalRequest = await loadOriginalRequest(input.runDir, manifest);
  const architecturePlan = await readFile(join(input.runDir, "architecture-plan.md"), "utf8");
  const verificationEvidence = await loadVerificationEvidence(input.runDir, input.issueNumber);
  const prDiff = await collectReviewDiff(input.repoRoot, input.dryRun);

  await updateManifest(input.runDir, {
    stage: "brain_review",
    current_issue: input.issueNumber,
    current_pr: input.prNumber,
  });

  const template = await loadPromptTemplate("brain-reviewer");
  const prompt = renderTemplate(template, {
    original_request: originalRequest,
    architecture_plan: architecturePlan.trim(),
    issue_body: formatIssueBody(issue),
    pr_diff: prDiff,
    verification_evidence: JSON.stringify(verificationEvidence, null, 2),
  });
  const result = await input.codex.invoke({
    role: "brain_reviewer",
    model: input.config.profiles.brain_reviewer.model,
    reasoningEffort: input.config.profiles.brain_reviewer.reasoning_effort,
    prompt,
    runDir: input.runDir,
    artifactName: `brain-reviewer-pr-${input.prNumber}`,
  });
  assertSuccessfulReviewInvocation(input.prNumber, result);

  let review: PrReview;
  try {
    review = parseReviewOutput(result.text);
  } catch (error) {
    if (!input.dryRun) {
      throw error;
    }
    review = fallbackDryRunReview();
  }

  await writeTextArtifact(
    input.runDir,
    `reviews/pr-${input.prNumber}-review.json`,
    `${JSON.stringify(review, null, 2)}\n`,
  );

  if (review.decision === "approve") {
    await updateManifest(input.runDir, {
      stage: "merge_ready",
      current_issue: input.issueNumber,
      current_pr: input.prNumber,
    });
    return {
      issueNumber: input.issueNumber,
      prNumber: input.prNumber,
      review,
      commentCount: 0,
      retryCount: manifest.retry_counts[fixAttemptKey(input.prNumber)] ?? 0,
    };
  }

  if (review.decision === "replan_required") {
    await updateManifest(input.runDir, {
      stage: "replan",
      current_issue: input.issueNumber,
      current_pr: input.prNumber,
    });
    return {
      issueNumber: input.issueNumber,
      prNumber: input.prNumber,
      review,
      commentCount: 0,
      retryCount: manifest.retry_counts[fixAttemptKey(input.prNumber)] ?? 0,
    };
  }

  if (review.findings.length === 0) {
    throw new EmptyReviewFindingsError(
      `Reviewer returned request_changes for PR ${input.prNumber} without any findings`,
    );
  }

  for (const finding of review.findings) {
    await input.github.commentOnPullRequest(input.prNumber, formatReviewComment(finding));
  }

  await updateManifest(input.runDir, {
    stage: "fixing",
    current_issue: input.issueNumber,
    current_pr: input.prNumber,
  });

  return {
    issueNumber: input.issueNumber,
    prNumber: input.prNumber,
    review,
    commentCount: review.findings.length,
    retryCount: manifest.retry_counts[fixAttemptKey(input.prNumber)] ?? 0,
  };
}

export async function applyFixes(
  input: ApplyFixesInput,
): Promise<ApplyFixesResult> {
  const manifest = await readManifest(input.runDir);
  const issue = await loadIssue(input.runDir, input.issueNumber, manifest);
  const review = await loadStoredReview(input.runDir, input.prNumber);
  const key = fixAttemptKey(input.prNumber);
  const currentAttemptCount = manifest.retry_counts[key] ?? 0;

  if (review.decision !== "request_changes" || review.findings.length === 0) {
    throw new Error(
      `Stored review for PR ${input.prNumber} must be request_changes with at least one finding`,
    );
  }

  if (currentAttemptCount >= input.config.retry_policy.max_hands_fix_attempts) {
    throw new RetryLimitExceededError(
      `PR ${input.prNumber} exceeded max_hands_fix_attempts (${input.config.retry_policy.max_hands_fix_attempts})`,
    );
  }

  const nextAttemptCount = currentAttemptCount + 1;

  await updateManifest(input.runDir, {
    stage: "fixing",
    current_issue: input.issueNumber,
    current_pr: input.prNumber,
    retry_counts: {
      ...manifest.retry_counts,
      [key]: nextAttemptCount,
    },
  });

  const template = await loadPromptTemplate("hands-fixer");
  const prompt = renderTemplate(template, {
    review_findings: JSON.stringify(review.findings, null, 2),
    issue_body: formatIssueBody(issue),
  });
  const result = await input.codex.invoke({
    role: "hands_fixer",
    model: input.config.profiles.hands_fixer.model,
    reasoningEffort: input.config.profiles.hands_fixer.reasoning_effort,
    prompt,
    runDir: input.runDir,
    artifactName: `hands-fixer-pr-${input.prNumber}`,
  });
  assertSuccessfulFixInvocation(input.prNumber, result);

  const fixesPath = await writeTextArtifact(
    input.runDir,
    `fixes-pr-${input.prNumber}.md`,
    result.text.endsWith("\n") ? result.text : `${result.text}\n`,
  );

  await updateManifest(input.runDir, {
    stage: "local_verification",
    current_issue: input.issueNumber,
    current_pr: input.prNumber,
  });

  return {
    issueNumber: input.issueNumber,
    prNumber: input.prNumber,
    fixesPath,
    retryCount: nextAttemptCount,
  };
}
