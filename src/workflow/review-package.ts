import { access, copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { runCommand } from "../core/executor.js";
import { readManifest, readManifestV2 } from "../core/ledger.js";
import { loadVerifiedPlanBundle } from "./verified-plan.js";
import { issueSpecSchema, verificationEvidenceSchema } from "../core/schema.js";
import { parsePersistedPlan } from "../core/execution-spec.js";
import {
  verificationEvidencePath,
  verificationIdentityDirectory,
  type BrainPlan,
  type ExecutionSpecV2,
  type IssueSpec,
  type RunManifestV2,
  type VerificationEvidence,
  type VerificationIdentity,
  type WorkItem,
} from "../core/types.js";

type ReviewIssue = IssueSpec | ExecutionSpecV2;

function isExecutionSpecV2(issue: ReviewIssue): issue is ExecutionSpecV2 {
  return "schema_version" in issue && issue.schema_version === "2.0";
}

function reviewIssueView(issue: ReviewIssue) {
  if (isExecutionSpecV2(issue)) {
    return {
      goal: issue.title,
      context: issue.objective,
      include: issue.completion_contract.expected_changed_files,
      exclude: issue.forbidden_changes.map((change) => change.path),
      acceptance: issue.acceptance.map((criterion) => `${criterion.id}: ${criterion.statement}`),
      checklist: issue.completion_contract.required_acceptance_ids,
      risks: issue.risks.map((risk) => `${risk.description} Mitigation: ${risk.mitigation}`),
      expectedArtifacts: issue.expected_artifacts,
      browserChecks: issue.browser_checks,
    };
  }
  return {
    goal: issue.goal,
    context: issue.context,
    include: issue.scope.include,
    exclude: issue.scope.exclude,
    acceptance: issue.acceptance_criteria,
    checklist: issue.review_checklist,
    risks: issue.risk_register,
    expectedArtifacts: issue.verification.expected_artifacts,
    browserChecks: issue.browser_checks ?? [],
  };
}

export interface CreateReviewPackageInput {
  repoRoot: string;
  runDir: string;
  issueNumber?: number;
  workItemId?: string;
  outDir: string;
}

export interface ReviewPackageResult {
  packageDir: string;
  reviewPath: string;
  promptPath: string;
  copiedFiles: string[];
}

interface PackageWriteContext {
  packageDir: string;
  copiedFiles: string[];
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readOptionalText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
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

function resolvePackageDir(repoRoot: string, outDir: string): string {
  if (outDir.trim() === "") {
    throw new Error("--out must be a non-empty path");
  }

  return isAbsolute(outDir) ? resolve(outDir) : resolve(repoRoot, outDir);
}

function assertPackageInsideRun(runDir: string, packageDir: string): void {
  const root = resolve(runDir);
  if (packageDir !== root && !packageDir.startsWith(`${root}/`)) {
    throw new Error("v2 review package output must stay inside the run directory");
  }
}

async function writePackageFile(
  context: PackageWriteContext,
  relativePath: string,
  content: string,
): Promise<string> {
  const target = join(context.packageDir, relativePath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content, "utf8");
  context.copiedFiles.push(target);
  return target;
}

async function copyPackageFile(
  context: PackageWriteContext,
  source: string,
  relativePath: string,
): Promise<string | null> {
  if (!(await fileExists(source))) {
    return null;
  }

  const target = join(context.packageDir, relativePath);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(source, target);
  context.copiedFiles.push(target);
  return target;
}

function formatList(entries: string[], emptyText = "_None recorded._"): string {
  if (entries.length === 0) {
    return emptyText;
  }

  return entries.map((entry) => `- ${entry}`).join("\n");
}

function statusLineToPath(line: string): string | null {
  if (line.trim() === "") {
    return null;
  }

  return line.length > 3 ? line.slice(3).trim() : line.trim();
}

async function collectChangedFiles(repoRoot: string): Promise<string[]> {
  const result = await runCommand({
    command: "git",
    args: ["status", "--short"],
    cwd: repoRoot,
    timeoutMs: 30_000,
  });

  if (result.exitCode !== 0) {
    return [`Unable to collect changed files: ${result.stderr || result.errorMessage || "git status failed"}`];
  }

  return result.stdout
    .split("\n")
    .map(statusLineToPath)
    .filter((entry): entry is string => entry !== null);
}

async function collectDiff(repoRoot: string): Promise<string> {
  const tracked = await runCommand({
    command: "git",
    args: ["diff", "--no-ext-diff", "--binary"],
    cwd: repoRoot,
    timeoutMs: 30_000,
  });
  const untracked = await runCommand({
    command: "git",
    args: ["ls-files", "--others", "--exclude-standard"],
    cwd: repoRoot,
    timeoutMs: 30_000,
  });

  if (tracked.exitCode !== 0) {
    return [
      "# Failed to collect git diff",
      "",
      tracked.stderr || tracked.errorMessage || "git diff failed",
      "",
    ].join("\n");
  }

  const diffParts = [tracked.stdout].filter((part) => part.trim().length > 0);
  const untrackedFiles = untracked.exitCode === 0
    ? untracked.stdout.split("\n").filter((entry) => entry.trim().length > 0)
    : [];

  for (const file of untrackedFiles) {
    const diff = await runCommand({
      command: "git",
      args: ["diff", "--no-ext-diff", "--binary", "--no-index", "--", "/dev/null", file],
      cwd: repoRoot,
      timeoutMs: 30_000,
    });

    if (diff.stdout.trim().length > 0) {
      diffParts.push(diff.stdout);
    } else if (diff.exitCode !== 0 && diff.exitCode !== 1) {
      diffParts.push(`# Failed to collect untracked diff for ${file}\n${diff.stderr || diff.errorMessage || ""}`);
    }
  }

  return diffParts.length === 0 ? "# No local diff was detected.\n" : `${diffParts.join("\n")}\n`;
}

async function loadVerificationEvidence(
  runDir: string,
  issueNumber: number,
): Promise<VerificationEvidence | null> {
  const evidencePath = join(runDir, "verification", `issue-${issueNumber}`, "evidence.json");
  const raw = await readOptionalText(evidencePath);
  return raw === null ? null : verificationEvidenceSchema.parse(JSON.parse(raw));
}

function browserEvidenceCandidates(
  repoRoot: string,
  runDir: string,
  issueNumber: number,
  issue: ReviewIssue,
  evidence: VerificationEvidence | null,
  verificationDirectory?: string,
): string[] {
  const fromEvidence = evidence?.browser_evidence
    .map((entry) => entry.evidence_report_path)
    .filter((entry): entry is string => entry !== null) ?? [];
  const fromArtifacts = reviewIssueView(issue).expectedArtifacts.filter(
    (artifact) => artifact.endsWith(".json") && artifact.includes("browser"),
  );

  return [
    ...fromEvidence.flatMap((path) => [join(repoRoot, path), join(runDir, path)]),
    join(runDir, verificationDirectory ?? join("verification", `issue-${issueNumber}`), "browser-evidence.json"),
    ...fromArtifacts.map((path) => join(repoRoot, path)),
  ];
}

async function copyFirstBrowserEvidence(
  context: PackageWriteContext,
  candidates: string[],
): Promise<string | null> {
  const uniqueCandidates = [...new Set(candidates)];
  for (const candidate of uniqueCandidates) {
    const copied = await copyPackageFile(context, candidate, "browser-evidence.json");
    if (copied !== null) {
      return copied;
    }
  }
  return null;
}

async function writeScreenshotsFile(
  context: PackageWriteContext,
  repoRoot: string,
  issue: ReviewIssue,
  evidence: VerificationEvidence | null,
): Promise<string> {
  const browserChecks = reviewIssueView(issue).browserChecks;
  const screenshotPaths = [
    ...browserChecks.map((check) => check.screenshot_artifact),
    ...(evidence?.browser_evidence.map((entry) => entry.screenshot_artifact) ?? []),
  ];
  const uniqueScreenshotPaths = [...new Set(screenshotPaths)].filter((path) => path.length > 0);

  if (uniqueScreenshotPaths.length === 0) {
    return writePackageFile(context, "screenshots.txt", "No screenshot artifacts declared.\n");
  }

  const lines = await Promise.all(
    uniqueScreenshotPaths.map(async (path) => {
      const status = (await fileExists(join(repoRoot, path))) ? "exists" : "missing";
      return `- ${path}: ${status}`;
    }),
  );

  return writePackageFile(context, "screenshots.txt", `${lines.join("\n")}\n`);
}

function formatCommandResults(evidence: VerificationEvidence | null): string {
  if (evidence === null || evidence.commands.length === 0) {
    return "_No command verification evidence found._";
  }

  return evidence.commands
    .map((command) => {
      const exitCode = command.exit_code === null ? "null" : String(command.exit_code);
      const flags = [
        command.timed_out ? "timed out" : null,
        command.error_code ? `error ${command.error_code}` : null,
        command.signal ? `signal ${command.signal}` : null,
      ].filter((entry): entry is string => entry !== null);
      return `- \`${command.command}\` -> exit ${exitCode}${flags.length > 0 ? ` (${flags.join(", ")})` : ""}`;
    })
    .join("\n");
}

function formatArtifactChecks(evidence: VerificationEvidence | null): string {
  if (evidence === null || evidence.artifact_checks.length === 0) {
    return "_No artifact checks found._";
  }

  return evidence.artifact_checks
    .map((artifact) => `- ${artifact.path}: ${artifact.exists ? "exists" : "missing"}${artifact.required ? " (required)" : ""}`)
    .join("\n");
}

function formatBrowserEvidence(evidence: VerificationEvidence | null): string {
  if (evidence === null || evidence.browser_evidence.length === 0) {
    return "_No browser evidence found._";
  }

  return evidence.browser_evidence
    .map((entry) => {
      const details = [
        `screenshot=${entry.screenshot_artifact}${entry.screenshot_exists ? "" : " missing"}`,
        entry.missing_network.length > 0 ? `missing_network=${entry.missing_network.join(", ")}` : null,
        entry.missing_selectors.length > 0 ? `missing_selectors=${entry.missing_selectors.join(", ")}` : null,
        entry.console_errors.length > 0 ? `console_errors=${entry.console_errors.length}` : null,
        entry.failure_reasons.length > 0 ? `failure_reasons=${entry.failure_reasons.join(", ")}` : null,
        entry.skipped_reason ? `reason=${entry.skipped_reason}` : null,
      ].filter((detail): detail is string => detail !== null);
      return `- ${entry.name}: ${entry.status}${details.length > 0 ? ` (${details.join("; ")})` : ""}`;
    })
    .join("\n");
}

function buildReviewMarkdown(input: {
  issueNumber?: number;
  workItemId?: string;
  originalRequest: string | null;
  issue: ReviewIssue;
  implementation: string | null;
  changedFiles: string[];
  evidence: VerificationEvidence | null;
  generatedAt: string;
  browserEvidenceCopied: boolean;
}): string {
  const issue = reviewIssueView(input.issue);
  const implementation = input.implementation?.trim() || "_No implementation artifact found._";
  const reviewChecklist = [
    "Confirm every acceptance criterion is implemented and backed by evidence.",
    "Inspect diff.patch for unintended scope changes or risky omissions.",
    "Validate command evidence, browser evidence, and screenshot references.",
    "Return specific file and verification instructions for every requested change.",
    ...issue.checklist,
  ];
  const openRisks = [
    ...issue.risks,
    input.browserEvidenceCopied ? null : "No standalone browser-evidence.json was copied into the package.",
  ].filter((entry): entry is string => entry !== null);

  return [
    input.issueNumber === undefined
      ? `# Local Review Package: Work item ${input.workItemId ?? "unknown"}`
      : `# Local Review Package: Issue #${input.issueNumber}`,
    "",
    `Generated at: ${input.generatedAt}`,
    "",
    "## Original Request",
    "",
    input.originalRequest?.trim() || "_No original request artifact found._",
    "",
    "## Issue Goal",
    "",
    issue.goal,
    "",
    "## Issue Context",
    "",
    issue.context,
    "",
    "## Scope",
    "",
    "Include:",
    formatList(issue.include),
    "",
    "Exclude:",
    formatList(issue.exclude),
    "",
    "## Acceptance Criteria",
    "",
    formatList(issue.acceptance),
    "",
    "## Implementation Summary",
    "",
    implementation,
    "",
    "## Changed Files",
    "",
    formatList(input.changedFiles, "_No local changed files detected._"),
    "",
    "## Test Commands And Results",
    "",
    formatCommandResults(input.evidence),
    "",
    "## Verification Artifacts",
    "",
    formatArtifactChecks(input.evidence),
    "",
    "## Browser Evidence Summary",
    "",
    formatBrowserEvidence(input.evidence),
    "",
    "## Open Risks",
    "",
    formatList(openRisks),
    "",
    "## Review Checklist",
    "",
    formatList(reviewChecklist),
    "",
    "## Package Contents",
    "",
    "- `review.md`: this reviewer entry point",
    "- `prompt.md`: model review prompt",
    "- `issue.json`: selected issue spec",
    "- `implementation.md`: hands implementation notes",
    "- `verification/evidence.json`: local command and artifact evidence",
    "- `browser-evidence.json`: normalized browser evidence when available",
    "- `diff.patch`: current local git diff, including untracked files when Git can render them",
    "- `screenshots.txt`: screenshot artifact paths and existence status",
    "",
  ].join("\n");
}

function buildPromptMarkdown(issueNumber?: number, workItemId?: string): string {
  return [
    issueNumber === undefined
      ? `# Brain Review Prompt For Work Item ${workItemId ?? "unknown"}`
      : `# Brain Review Prompt For Issue #${issueNumber}`,
    "",
    "Review this local package as if it were a pull request review, without relying on GitHub.",
    "",
    "Read `review.md` first, then inspect `issue.json`, `implementation.md`, `verification/evidence.json`, `browser-evidence.json`, `diff.patch`, and `screenshots.txt`.",
    "",
    "Return a structured review with one decision:",
    "",
    "- `approve`: the feature fully satisfies the issue and original request.",
    "- `request_changes`: implementation is close, but specific fixes are required.",
    "- `replan_required`: the plan or issue is materially wrong or incomplete.",
    "",
    "For every requested change, include the file, problem, required fix, and exact verification command or evidence needed after the fix.",
    "",
  ].join("\n");
}

function artifactPathInsideRun(runDir: string, relativePath: string): string {
  const root = resolve(runDir);
  const candidate = isAbsolute(relativePath) ? resolve(relativePath) : resolve(root, relativePath);
  if (candidate !== root && !candidate.startsWith(`${root}/`)) {
    throw new Error(`v2 artifact path escapes the run directory: ${relativePath}`);
  }
  return candidate;
}

async function loadV2Plan(runDir: string, manifest: RunManifestV2): Promise<BrainPlan> {
  return (await loadVerifiedPlanBundle(runDir, manifest)).plan;
}

function assertV2Approved(manifest: RunManifestV2): void {
  const current = manifest.current_revision ?? manifest.current_plan_revision;
  const approved = manifest.approved_revision ?? manifest.approved_plan_revision;
  if (current === null || current === undefined || approved !== current) {
    throw new Error("v2 review packages require an explicitly approved current plan revision");
  }
}

async function loadV2Implementation(
  runDir: string,
  item: WorkItem,
  progress: RunManifestV2["work_item_progress"][string] | undefined,
): Promise<string | null> {
  const path = typeof progress?.implementation_path === "string"
    ? progress.implementation_path
    : `implementation/${item.id.replace(/[^a-zA-Z0-9._-]/g, "_")}/attempt-${Math.max(1, progress?.attempts ?? 1)}.json`;
  return readOptionalText(artifactPathInsideRun(runDir, path));
}

async function loadV2Evidence(
  runDir: string,
  identity: VerificationIdentity,
  progress: RunManifestV2["work_item_progress"][string] | undefined,
): Promise<VerificationEvidence | null> {
  const directPath = typeof progress?.verification_path === "string"
    ? progress.verification_path
    : progress?.attempts
      ? verificationEvidencePath(identity, Math.max(1, progress.attempts))
      : null;
  if (directPath === null) return null;
  const direct = await readOptionalText(artifactPathInsideRun(runDir, directPath));
  if (direct === null) return null;
  const evidence = verificationEvidenceSchema.parse(JSON.parse(direct)) as VerificationEvidence;
  const expectedAttempt = progress?.attempts ?? evidence.attempt;
  if (evidence.verification_scope !== identity.scope || evidence.work_item_id !== identity.work_item_id || evidence.attempt !== expectedAttempt || evidence.evidence_path !== verificationEvidencePath(identity, expectedAttempt)) {
    throw new Error("Review package verification evidence provenance does not match its work-item identity");
  }
  if (identity.scope === "github" && evidence.issue_number !== identity.issue_number) {
    throw new Error("Review package verification issue number does not match its durable mapping");
  }
  if (identity.scope !== "github" && evidence.issue_number !== undefined) {
    throw new Error("Review package local/integrated evidence cannot contain a GitHub issue number");
  }
  const expectedPrefix = `${verificationIdentityDirectory(identity)}/attempt-${expectedAttempt}/`;
  for (const browser of evidence.browser_evidence) {
    if (!browser.screenshot_artifact.startsWith(expectedPrefix) || (browser.evidence_report_path && !browser.evidence_report_path.startsWith(expectedPrefix))) {
      throw new Error("Review package browser evidence provenance does not match its work-item identity");
    }
  }
  return evidence;
}

interface ReviewPackageBuildInput {
  repoRoot: string;
  runDir: string;
  packageDir: string;
  issueNumber?: number;
  workItemId?: string;
  verificationDirectory?: string;
  issue: ReviewIssue;
  originalRequest: string | null;
  implementation: string | null;
  evidence: VerificationEvidence | null;
}

async function buildReviewPackage(input: ReviewPackageBuildInput): Promise<ReviewPackageResult> {
  const context: PackageWriteContext = { packageDir: input.packageDir, copiedFiles: [] };
  await mkdir(input.packageDir, { recursive: true });
  const changedFiles = await collectChangedFiles(input.repoRoot);
  const diff = await collectDiff(input.repoRoot);

  await writePackageFile(context, "issue.json", `${JSON.stringify(input.issue, null, 2)}\n`);
  await writePackageFile(
    context,
    "implementation.md",
    input.implementation ?? `No implementation artifact found for ${input.issueNumber === undefined ? `work item ${input.workItemId}` : `issue-${input.issueNumber}`}.\n`,
  );
  await writePackageFile(context, "verification/evidence.json", input.evidence === null ? "{}\n" : `${JSON.stringify(input.evidence, null, 2)}\n`);
  const browserEvidenceCopied = (await copyFirstBrowserEvidence(
    context,
    browserEvidenceCandidates(input.repoRoot, input.runDir, input.issueNumber ?? 0, input.issue, input.evidence, input.verificationDirectory),
  )) !== null;
  await writePackageFile(context, "diff.patch", diff);
  await writeScreenshotsFile(context, input.repoRoot, input.issue, input.evidence);

  const promptPath = await writePackageFile(context, "prompt.md", buildPromptMarkdown(input.issueNumber, input.workItemId));
  const reviewPath = await writePackageFile(
    context,
    "review.md",
    buildReviewMarkdown({
      issueNumber: input.issueNumber,
      workItemId: input.workItemId,
      originalRequest: input.originalRequest,
      issue: input.issue,
      implementation: input.implementation,
      changedFiles,
      evidence: input.evidence,
      generatedAt: new Date().toISOString(),
      browserEvidenceCopied,
    }),
  );

  return { packageDir: input.packageDir, reviewPath, promptPath, copiedFiles: [...context.copiedFiles] };
}

async function createReviewPackageV2(
  input: CreateReviewPackageInput,
  manifest: RunManifestV2,
): Promise<ReviewPackageResult> {
  assertV2Approved(manifest);
  const plan = await loadV2Plan(input.runDir, manifest);
  const issueMap = {
    ...manifest.work_item_issue_map,
    ...(manifest.github_ids.work_item_issue_map ?? {}),
  };
  let item: WorkItem | undefined;
  let identity: VerificationIdentity;
  if (manifest.mode === "local") {
    if (!input.workItemId) throw new Error("Local review packages require workItemId; issue numbers are GitHub-only");
    item = plan.work_items.find((candidate) => candidate.id === input.workItemId);
    if (!item) throw new Error(`Work item ${input.workItemId} is not present in the approved v2 plan`);
    identity = { scope: "local", work_item_id: item.id };
  } else {
    if (input.issueNumber === undefined) throw new Error("GitHub review packages require issueNumber");
    const mappedItem = plan.work_items.find((candidate) => issueMap[candidate.id] === input.issueNumber);
    if (!mappedItem) throw new Error(`Issue ${input.issueNumber} is not present in the durable work-item mapping`);
    item = mappedItem;
    identity = { scope: "github", work_item_id: item.id, issue_number: input.issueNumber };
  }
  const progress = manifest.work_item_progress[item.id];
  const packageDir = resolvePackageDir(input.repoRoot, input.outDir);
  assertPackageInsideRun(input.runDir, packageDir);
  return buildReviewPackage({
    repoRoot: resolve(input.repoRoot),
    runDir: resolve(input.runDir),
    packageDir,
    issueNumber: identity.scope === "github" ? identity.issue_number : undefined,
    workItemId: item.id,
    verificationDirectory: verificationIdentityDirectory(identity),
    issue: item,
    originalRequest: manifest.original_request,
    implementation: await loadV2Implementation(input.runDir, item, progress),
    evidence: await loadV2Evidence(input.runDir, identity, progress),
  });
}

export async function createReviewPackage(
  input: CreateReviewPackageInput,
): Promise<ReviewPackageResult> {
  const repoRoot = resolve(input.repoRoot);
  const runDir = resolve(input.runDir);
  const rawManifest = JSON.parse(await readFile(join(runDir, "manifest.json"), "utf8")) as Record<string, unknown>;
  if (rawManifest.version === 2 || rawManifest.schema_version === 2) {
    return createReviewPackageV2(input, await readManifestV2(runDir));
  }

  const packageDir = resolvePackageDir(repoRoot, input.outDir);
  const manifest = await readManifest(runDir);
  if (input.issueNumber === undefined) throw new Error("Legacy review packages require issueNumber");
  const rawIssues = await readFile(join(runDir, "issues.json"), "utf8");
  const issues = issueSpecSchema.array().parse(JSON.parse(rawIssues));
  const issueIndex = resolveIssueIndex(input.issueNumber, manifest.issue_numbers, issues.length);
  const issue = issues[issueIndex];
  const originalRequest = await readOptionalText(join(runDir, "original-request.md"));
  const implementation = await readOptionalText(join(runDir, `implementation-issue-${input.issueNumber}.md`));
  const evidence = await loadVerificationEvidence(runDir, input.issueNumber);
  return buildReviewPackage({
    repoRoot,
    runDir,
    packageDir,
    issueNumber: input.issueNumber,
    issue,
    originalRequest,
    implementation,
    evidence,
  });
}
