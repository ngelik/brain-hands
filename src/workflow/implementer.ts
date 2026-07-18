import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CodexAdapter, CodexInvokeResult } from "../adapters/codex.js";
import { formatIssueBody, type GitHubAdapter } from "../adapters/github.js";
import { createIssueBranch, getGitSnapshot } from "../adapters/git.js";
import { verifyBrowserIssue } from "../browser/verifier.js";
import type { BrainHandsConfig, IssueSpec, VerificationEvidence, VerificationIdentity } from "../core/types.js";
import { readManifest, updateManifest, writeTextArtifact } from "../core/ledger.js";
import { issueSpecSchema } from "../core/schema.js";
import { loadPromptTemplate } from "../prompts/loader.js";
import { renderTemplate } from "../prompts/renderer.js";
import { runVerification } from "../verification/runner.js";

export interface ImplementIssueInput {
  repoRoot: string;
  runDir: string;
  issueNumber: number;
  config: BrainHandsConfig;
  codex: CodexAdapter;
  github: GitHubAdapter;
  dryRun: boolean;
  browserVerifier?: typeof verifyBrowserIssue;
}

export interface ImplementIssueResult {
  issueNumber: number;
  branchName: string;
  baseBranch: string;
  pullRequestNumber: number;
  verification: VerificationEvidence;
}

export class VerificationFailedError extends Error {
  constructor(
    message: string,
    readonly evidence: VerificationEvidence,
  ) {
    super(message);
    this.name = "VerificationFailedError";
  }
}

export class HandsImplementationFailedError extends Error {
  constructor(
    message: string,
    readonly result: CodexInvokeResult,
  ) {
    super(message);
    this.name = "HandsImplementationFailedError";
  }
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);

  return slug || "issue";
}

function formatAllowedScope(issue: IssueSpec): string {
  return [
    "Include:",
    ...issue.scope.include.map((entry) => `- ${entry}`),
    "",
    "Exclude:",
    ...issue.scope.exclude.map((entry) => `- ${entry}`),
  ].join("\n");
}

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

function getDryRunBranchName(issueNumber: number, issue: IssueSpec): string {
  return `dry-run/issue-${issueNumber}-${slugify(issue.goal)}`;
}

function browserReportPath(issueNumber: number, issue: IssueSpec): string {
  const declaredReport = issue.verification.expected_artifacts.find(
    (artifact) => artifact.endsWith(".json") && artifact.includes("browser"),
  );

  return declaredReport ?? `reports/browser-evidence-issue-${issueNumber}.json`;
}

function verificationFailures(evidence: VerificationEvidence): string[] {
  const commandFailures = evidence.commands.flatMap((command, index) => {
    const failures: string[] = [];

    if (command.exit_code !== 0) {
      failures.push(`exit_code=${command.exit_code === null ? "null" : command.exit_code}`);
    }
    if (command.timed_out) {
      failures.push("timed_out=true");
    }
    if (command.error_code !== null) {
      failures.push(`error_code=${command.error_code}`);
    }
    if (command.error_message !== null) {
      failures.push(`error_message=${command.error_message}`);
    }
    if (command.signal !== null) {
      failures.push(`signal=${command.signal}`);
    }

    if (failures.length === 0) {
      return [];
    }

    return [`command ${index + 1} (${command.command}) failed: ${failures.join(", ")}`];
  });

  const artifactFailures = evidence.artifact_checks
    .filter((artifact) => artifact.required && !artifact.exists)
    .map((artifact) => `required artifact missing: ${artifact.path}`);

  const browserFailures = evidence.browser_evidence
    .filter((entry) => entry.status !== "passed")
    .map((entry) => {
      const details = [
        `status=${entry.status}`,
        entry.screenshot_exists ? null : `missing_screenshot=${entry.screenshot_artifact}`,
        entry.missing_network.length > 0 ? `missing_network=${entry.missing_network.join(",")}` : null,
        entry.missing_selectors.length > 0 ? `missing_selectors=${entry.missing_selectors.join(",")}` : null,
        entry.console_errors.length > 0 ? `console_errors=${entry.console_errors.length}` : null,
        entry.failure_reasons.length > 0 ? `failure_reasons=${entry.failure_reasons.join(",")}` : null,
        entry.skipped_reason ? `reason=${entry.skipped_reason}` : null,
      ].filter((detail): detail is string => detail !== null);
      return `browser check "${entry.name}" failed: ${details.join(", ")}`;
    });

  return [...commandFailures, ...artifactFailures, ...browserFailures];
}

function buildPullRequestBody(
  issueNumber: number,
  issue: IssueSpec,
  implementationNotes: string,
  verification: VerificationEvidence,
): string {
  return [
    `Implements issue #${issueNumber}: ${issue.goal}`,
    "",
    "## Summary",
    implementationNotes.trim() || "Implementation completed.",
    "",
    "## Verification Evidence",
    "```json",
    JSON.stringify(verification, null, 2),
    "```",
  ].join("\n");
}

function assertSuccessfulHandsInvocation(
  issueNumber: number,
  implementation: CodexInvokeResult,
): void {
  if (implementation.exitCode === 0) {
    return;
  }

  const details = [
    `exitCode=${implementation.exitCode === null ? "null" : implementation.exitCode}`,
    `promptPath=${implementation.promptPath}`,
    `stdoutPath=${implementation.stdoutPath}`,
    `stderrPath=${implementation.stderrPath}`,
  ];

  throw new HandsImplementationFailedError(
    `Hands implementation failed for issue ${issueNumber}: ${details.join(", ")}`,
    implementation,
  );
}

export async function implementIssue(
  input: ImplementIssueInput,
): Promise<ImplementIssueResult> {
  const manifest = await readManifest(input.runDir);
  const rawIssues = await readFile(join(input.runDir, "issues.json"), "utf8");
  const issues = issueSpecSchema.array().parse(JSON.parse(rawIssues));
  const issueIndex = resolveIssueIndex(input.issueNumber, manifest.issue_numbers, issues.length);
  const issue = issues[issueIndex];
  const architecturePlan = await readFile(join(input.runDir, "architecture-plan.md"), "utf8");

  const baseBranch = input.dryRun
    ? "main"
    : (await getGitSnapshot(input.repoRoot)).branch || "main";
  const branchName = input.dryRun
    ? getDryRunBranchName(input.issueNumber, issue)
    : await createIssueBranch(input.repoRoot, input.issueNumber, slugify(issue.goal));

  await updateManifest(input.runDir, {
    stage: "implementing",
    current_issue: input.issueNumber,
    current_pr: null,
  });

  const template = await loadPromptTemplate("hands-implementer");
  const prompt = renderTemplate(template, {
    issue_body: formatIssueBody(issue),
    architecture_plan: architecturePlan.trim(),
    allowed_scope: formatAllowedScope(issue),
  });
  const implementation = await input.codex.invoke({
    role: "hands_implementer",
    model: input.config.profiles.hands_implementer.model,
    reasoningEffort: input.config.profiles.hands_implementer.reasoning_effort,
    prompt,
    runDir: input.runDir,
    artifactName: `hands-implementer-issue-${input.issueNumber}`,
  });
  assertSuccessfulHandsInvocation(input.issueNumber, implementation);

  await writeTextArtifact(
    input.runDir,
    `implementation-issue-${input.issueNumber}.md`,
    implementation.text.endsWith("\n") ? implementation.text : `${implementation.text}\n`,
  );

  await updateManifest(input.runDir, {
    stage: "local_verification",
    current_issue: input.issueNumber,
    current_pr: null,
  });

  const browserChecks = issue.browser_checks ?? [];
  const expectedArtifacts = [...issue.verification.expected_artifacts];
  const verificationIdentity: VerificationIdentity = {
    scope: "github",
    work_item_id: `legacy-issue-${input.issueNumber}`,
    issue_number: input.issueNumber,
  };
  let browserVerificationStatus: "passed" | "failed" | "skipped" | null = null;

  if (browserChecks.length > 0) {
    const reportPath = browserReportPath(input.issueNumber, issue);
    if (!expectedArtifacts.includes(reportPath)) {
      expectedArtifacts.push(reportPath);
    }

    const browserVerifier = input.browserVerifier ?? verifyBrowserIssue;
    const browserVerification = await browserVerifier({
      repoRoot: input.repoRoot,
      issue,
      reportPath,
      artifactRoot: input.repoRoot,
      runDir: input.runDir,
      identity: verificationIdentity,
    });
    browserVerificationStatus = browserVerification.status;
  }

  const verification = await runVerification({
    repoRoot: input.repoRoot,
    runDir: input.runDir,
    identity: verificationIdentity,
    commands: issue.verification.required_commands,
    expectedArtifacts,
    browserChecks,
  });

  const failures = verificationFailures(verification);
  if (browserVerificationStatus !== null && browserVerificationStatus !== "passed") {
    throw new VerificationFailedError(
      `Local verification failed for issue ${input.issueNumber}: automatic browser verification failed for issue ${input.issueNumber} with status=${browserVerificationStatus}${failures.length > 0 ? `; ${failures.join("; ")}` : ""}`,
      verification,
    );
  }

  if (failures.length > 0) {
    throw new VerificationFailedError(
      `Local verification failed for issue ${input.issueNumber}: ${failures.join("; ")}`,
      verification,
    );
  }

  const prNumber = await input.github.openPullRequest({
    title: `Implement issue #${input.issueNumber}: ${issue.goal}`,
    body: buildPullRequestBody(input.issueNumber, issue, implementation.text, verification),
    head: branchName,
    base: baseBranch,
  });

  const prNumbers = manifest.pr_numbers.includes(prNumber)
    ? manifest.pr_numbers
    : [...manifest.pr_numbers, prNumber];

  await updateManifest(input.runDir, {
    stage: "pull_request",
    current_issue: input.issueNumber,
    current_pr: prNumber,
    pr_numbers: prNumbers,
  });

  return {
    issueNumber: input.issueNumber,
    branchName,
    baseBranch,
    pullRequestNumber: prNumber,
    verification,
  };
}
