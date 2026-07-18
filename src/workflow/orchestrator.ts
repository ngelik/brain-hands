import { access, readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import type { CodexAdapter } from "../adapters/codex.js";
import { readManifest, readManifestV2, updateManifest, writeTextArtifact } from "../core/ledger.js";
import { loadVerifiedPlanBundle } from "./verified-plan.js";
import { issueSpecSchema, legacyVerificationEvidenceSchema, verificationEvidenceSchema } from "../core/schema.js";
import { parsePersistedPlan } from "../core/execution-spec.js";
import { verificationEvidencePath } from "../core/types.js";
import type { BrainPlan, BrainHandsConfig, IssueSpec, RunManifestV2, VerificationEvidence, VerificationIdentity } from "../core/types.js";
import { loadPromptTemplate } from "../prompts/loader.js";
import { renderTemplate } from "../prompts/renderer.js";

export interface FinalAuditInput {
  runDir: string;
  repoRoot: string;
  config: BrainHandsConfig;
  codex: CodexAdapter;
  dryRun: boolean;
}

interface VerificationEvidenceSummary {
  verification_scope: "github" | "local" | "integrated";
  work_item_id: string;
  issue_number?: number;
  evidence_path: string;
  commands: VerificationEvidence["commands"];
  artifacts: Array<{ path: string; exists: boolean }>;
  browser_evidence: VerificationEvidence["browser_evidence"];
  created_at: string;
}

interface VerifiedIssueSummary {
  issue_number: number;
  goal: string;
  acceptance_criteria: string[];
  verification_commands: string[];
  browser_checks: IssueSpec["browser_checks"];
  evidence_created_at: string;
}

function isUsableAuditReport(text: string): boolean {
  if (text.trim() === "") {
    return false;
  }

  const headings = [
    "Completed requirements",
    "Missing requirements",
    "Verification evidence reviewed",
    "Residual risks",
    "Merge recommendation",
  ];

  return headings.filter((heading) => text.includes(heading)).length >= 3;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function loadOriginalRequest(runDir: string, manifestRequest: string): Promise<string> {
  const path = join(runDir, "original-request.md");
  try {
    const originalRequest = await readFile(path, "utf8");
    return originalRequest.trim() || manifestRequest;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return manifestRequest;
    }
    throw error;
  }
}

async function loadIssues(runDir: string): Promise<IssueSpec[]> {
  const rawIssues = await readFile(join(runDir, "issues.json"), "utf8");
  return issueSpecSchema.array().parse(JSON.parse(rawIssues));
}

async function loadVerificationEvidence(runDir: string): Promise<VerificationEvidenceSummary[]> {
  const verificationRoot = join(runDir, "verification");
  let entries: string[];

  try {
    entries = await readdir(verificationRoot);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const evidence: VerificationEvidenceSummary[] = [];

  for (const entry of entries.sort()) {
    if (!entry.startsWith("issue-")) {
      continue;
    }

    const evidencePath = join(verificationRoot, entry, "evidence.json");
    if (!(await fileExists(evidencePath))) {
      continue;
    }

    const rawEvidence = await readFile(evidencePath, "utf8");
    const parsed = legacyVerificationEvidenceSchema.parse(JSON.parse(rawEvidence));
    const artifacts = parsed.artifact_checks.length > 0
      ? parsed.artifact_checks.map((artifact) => ({
          path: artifact.path,
          exists: artifact.exists,
        }))
      : await Promise.all(
          parsed.artifacts.map(async (artifactPath) => ({
            path: artifactPath,
            exists: await fileExists(join(runDir, artifactPath)),
          })),
        );

    evidence.push({
      verification_scope: "github",
      work_item_id: `legacy-issue-${parsed.issue_number}`,
      issue_number: parsed.issue_number,
      evidence_path: relative(runDir, evidencePath),
      commands: parsed.commands,
      artifacts,
      browser_evidence: parsed.browser_evidence,
      created_at: parsed.created_at,
    });
  }

  return evidence;
}

function mapVerifiedIssues(
  issues: IssueSpec[],
  recordedIssueNumbers: number[],
  verificationEvidence: VerificationEvidenceSummary[],
): VerifiedIssueSummary[] {
  if (verificationEvidence.length === 0) {
    throw new Error("Final audit requires non-empty verification evidence.");
  }

  const evidenceByIssue = new Map(
    verificationEvidence.map((entry) => [entry.issue_number, entry] as const),
  );

  if (recordedIssueNumbers.length > 0) {
    const missingEvidence = recordedIssueNumbers.filter((issueNumber) => !evidenceByIssue.has(issueNumber));
    if (missingEvidence.length > 0) {
      throw new Error(
        `Final audit requires verification evidence for every recorded issue. Missing evidence for: ${missingEvidence
          .map((issueNumber) => `#${issueNumber}`)
          .join(", ")}`,
      );
    }

    return recordedIssueNumbers.map((issueNumber, index) => {
      const issue = issues[index];
      const evidence = evidenceByIssue.get(issueNumber);

      if (!issue) {
        throw new Error(`Final audit could not map recorded issue #${issueNumber} to issues.json.`);
      }

      if (!evidence) {
        throw new Error(`Final audit could not load verification evidence for issue #${issueNumber}.`);
      }

      return {
        issue_number: issueNumber,
        goal: issue.goal,
        acceptance_criteria: issue.acceptance_criteria,
        verification_commands: issue.verification.required_commands,
        browser_checks: issue.browser_checks ?? [],
        evidence_created_at: evidence.created_at,
      };
    });
  }

  return verificationEvidence.map((evidence) => ({
    issue_number: evidence.issue_number!,
    goal: "Verified issue with no manifest.issue_numbers mapping.",
    acceptance_criteria: [],
    verification_commands: evidence.commands.map((command) => command.command),
    browser_checks: [],
    evidence_created_at: evidence.created_at,
  }));
}

function v2ArtifactPath(runDir: string, relativePath: string): string {
  const root = resolve(runDir);
  const candidate = relativePath.startsWith("/") ? resolve(relativePath) : resolve(root, relativePath);
  if (candidate !== root && !candidate.startsWith(`${root}/`)) {
    throw new Error(`v2 artifact path escapes the run directory: ${relativePath}`);
  }
  return candidate;
}

async function loadV2Plan(runDir: string, manifest: RunManifestV2): Promise<BrainPlan> {
  return (await loadVerifiedPlanBundle(runDir, manifest)).plan;
}

async function loadV2VerificationEvidence(
  runDir: string,
  manifest: RunManifestV2,
  plan: BrainPlan,
): Promise<VerificationEvidenceSummary[]> {
  const root = join(runDir, "verification");
  let entries: string[] = [];
  try {
    entries = await readdir(root);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
  }

  const summaries: VerificationEvidenceSummary[] = [];
  const issueMap = { ...manifest.work_item_issue_map, ...(manifest.github_ids.work_item_issue_map ?? {}) };
  for (const issueEntry of entries.filter((entry) => entry.startsWith("issue-")).sort()) {
    const issueNumber = Number(issueEntry.slice("issue-".length));
    if (!Number.isSafeInteger(issueNumber) || issueNumber < 1) continue;
    const issueRoot = join(root, issueEntry);
    let candidates: string[] = [];
    try {
      candidates = await readdir(issueRoot);
    } catch {
      continue;
    }
    const attemptEntries = candidates
      .map((entry) => ({ entry, match: entry.match(/^attempt-(\d+)$/) }))
      .filter((candidate): candidate is { entry: string; match: RegExpMatchArray } => candidate.match !== null)
      .sort((left, right) => Number(right.match[1]) - Number(left.match[1]));
    const evidencePaths = [
      ...attemptEntries.map(({ entry }) => join(issueRoot, entry, "evidence.json")),
      join(issueRoot, "evidence.json"),
    ];
    let parsed: VerificationEvidence | null = null;
    let parsedPath: string | null = null;
    for (const evidencePath of evidencePaths) {
      try {
        parsed = verificationEvidenceSchema.parse(JSON.parse(await readFile(evidencePath, "utf8"))) as VerificationEvidence;
        parsedPath = evidencePath;
        break;
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
        const legacy = legacyVerificationEvidenceSchema.safeParse(JSON.parse(await readFile(evidencePath, "utf8")));
        if (!legacy.success) throw error;
        const mappedItem = plan.work_items.find((item) => issueMap[item.id] === legacy.data.issue_number);
        const uniqueLegacyItem = mappedItem ?? (manifest.mode === "local" && plan.work_items.length === 1 && issueNumber === 1 ? plan.work_items[0] : undefined);
        if (!uniqueLegacyItem) {
          throw new Error(`Ambiguous legacy verification provenance at ${relative(runDir, evidencePath)}`);
        }
        parsed = {
          // A uniquely provable legacy issue artifact is normalized only for
          // read-only audit output; it is never a destination for new writes.
          verification_scope: "github",
          work_item_id: uniqueLegacyItem.id,
          issue_number: legacy.data.issue_number,
          attempt: legacy.data.attempt ?? 1,
          evidence_path: relative(runDir, evidencePath),
          commands: legacy.data.commands,
          artifacts: legacy.data.artifacts,
          artifact_checks: legacy.data.artifact_checks,
          browser_evidence: legacy.data.browser_evidence,
          created_at: legacy.data.created_at,
        } as VerificationEvidence;
        parsedPath = evidencePath;
        break;
      }
    }
    if (!parsed || !parsedPath) continue;
    if (parsed.verification_scope !== "github" || parsed.issue_number !== issueNumber) {
      throw new Error(`Numbered verification directory ${issueEntry} does not contain mapped GitHub evidence`);
    }
    if (parsed.evidence_path !== relative(runDir, parsedPath)) {
      throw new Error(`Verification evidence path does not match its numbered directory: ${relative(runDir, parsedPath)}`);
    }
    const artifacts = parsed.artifact_checks.length > 0
      ? parsed.artifact_checks.map((artifact) => ({ path: artifact.path, exists: artifact.exists }))
      : parsed.artifacts.map((artifactPath) => ({ path: artifactPath, exists: true }));
    summaries.push({
      verification_scope: parsed.verification_scope,
      work_item_id: parsed.work_item_id,
      issue_number: parsed.issue_number,
      evidence_path: parsed.evidence_path,
      commands: parsed.commands,
      artifacts,
      browser_evidence: parsed.browser_evidence,
      created_at: parsed.created_at,
    });
  }
  const integratedRoot = join(root, "integrated");
  let integratedAttempts: string[] = [];
  try {
    integratedAttempts = await readdir(integratedRoot);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
  }
  for (const attemptEntry of integratedAttempts.filter((entry) => /^attempt-\d+$/.test(entry)).sort()) {
    const evidencePath = join(integratedRoot, attemptEntry, "evidence.json");
    try {
      const parsed = verificationEvidenceSchema.parse(JSON.parse(await readFile(evidencePath, "utf8"))) as VerificationEvidence;
      const expectedIdentity: VerificationIdentity = { scope: "integrated", work_item_id: "integrated" };
      const expectedPath = verificationEvidencePath(expectedIdentity, Number(attemptEntry.slice("attempt-".length)));
      if (parsed.verification_scope !== "integrated" || parsed.work_item_id !== "integrated" || parsed.evidence_path !== expectedPath) {
        throw new Error(`Integrated verification provenance does not match ${expectedPath}`);
      }
      const expectedPrefix = `verification/integrated/${attemptEntry}/`;
      for (const browser of parsed.browser_evidence) {
        if (!browser.screenshot_artifact.startsWith(expectedPrefix) || (browser.evidence_report_path && !browser.evidence_report_path.startsWith(expectedPrefix))) {
          throw new Error(`Integrated browser verification provenance does not match ${expectedPrefix}`);
        }
      }
      summaries.push({
        verification_scope: parsed.verification_scope,
        work_item_id: parsed.work_item_id,
        evidence_path: parsed.evidence_path,
        commands: parsed.commands,
        artifacts: parsed.artifact_checks.length > 0
          ? parsed.artifact_checks.map((artifact) => ({ path: artifact.path, exists: artifact.exists }))
          : parsed.artifacts.map((artifactPath) => ({ path: artifactPath, exists: true })),
        browser_evidence: parsed.browser_evidence,
        created_at: parsed.created_at,
      });
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
      throw error;
    }
  }
  return summaries;
}

function mapV2VerifiedIssues(
  plan: BrainPlan,
  evidence: VerificationEvidenceSummary[],
  issueMap: Record<string, number>,
): VerifiedIssueSummary[] {
  return evidence.filter((entry) => entry.verification_scope === "github").map((entry) => {
    if (entry.issue_number === undefined) throw new Error(`Mapped verification evidence is missing its GitHub issue number: ${entry.evidence_path}`);
    const item = plan.work_items.find((candidate) => candidate.id === entry.work_item_id);
    if (!item || issueMap[item.id] !== entry.issue_number) {
      throw new Error(`Final audit could not map verification evidence ${entry.evidence_path} to its durable work-item issue mapping`);
    }
    return {
      issue_number: entry.issue_number,
      goal: item.objective,
      acceptance_criteria: item.acceptance.map((criterion) => criterion.statement),
      verification_commands: item.verification_commands.map((command) => command.argv.join(" ")),
      browser_checks: item.browser_checks,
      evidence_created_at: entry.created_at,
    };
  });
}

async function finalAuditV2(input: FinalAuditInput, manifest: RunManifestV2): Promise<string> {
  const current = manifest.current_revision ?? manifest.current_plan_revision;
  const approved = manifest.approved_revision ?? manifest.approved_plan_revision;
  if (current === null || current === undefined || approved !== current) {
    throw new Error("Final audit requires an explicitly approved current v2 plan revision.");
  }
  if (manifest.stage !== "delivery" && manifest.stage !== "complete") {
    throw new Error(`Final audit requires a delivered v2 run, received ${manifest.stage}.`);
  }

  const plan = await loadV2Plan(input.runDir, manifest);
  const verificationEvidence = await loadV2VerificationEvidence(input.runDir, manifest, plan);
  if (verificationEvidence.length === 0) throw new Error("Final audit requires non-empty v2 verification evidence.");
  const completedIssues = mapV2VerifiedIssues(plan, verificationEvidence, {
    ...manifest.work_item_issue_map,
    ...(manifest.github_ids.work_item_issue_map ?? {}),
  });
  const pullRequestNumbers = manifest.pull_request_numbers.length > 0
    ? manifest.pull_request_numbers
    : manifest.github_ids.pull_request_numbers;
  const prompt = renderTemplate(await loadPromptTemplate("brain-final-auditor"), {
    original_request: manifest.original_request,
    completed_issues: JSON.stringify(completedIssues, null, 2),
    pull_requests: JSON.stringify(pullRequestNumbers, null, 2),
    verification_evidence: JSON.stringify(verificationEvidence, null, 2),
    browser_checks: JSON.stringify(completedIssues.flatMap((issue) => issue.browser_checks ?? []), null, 2),
  });

  let report: string;
  if (input.dryRun) {
    report = fallbackAuditReport(manifest.original_request, completedIssues, pullRequestNumbers, verificationEvidence);
  } else {
    const profile = (input.config as unknown as { profiles: { brain: { model: string; reasoning_effort: string } } }).profiles.brain;
    const result = await input.codex.invoke({
      role: "brain",
      model: profile.model,
      reasoningEffort: profile.reasoning_effort as never,
      prompt,
      runDir: input.runDir,
      artifactName: "brain-final-auditor",
    });
    if (result.exitCode !== 0) {
      throw new Error(`Final audit failed closed: exitCode=${result.exitCode ?? "null"}, promptPath=${result.promptPath}, stdoutPath=${result.stdoutPath}, stderrPath=${result.stderrPath}`);
    }
    if (!isUsableAuditReport(result.text)) throw new Error("Final audit failed closed: auditor returned unusable Markdown output.");
    report = result.text.endsWith("\n") ? result.text : `${result.text}\n`;
  }

  // This retained command only emits an artifact; it does not advance or
  // rewrite the approved v2 ledger and never touches the source worktree.
  await writeTextArtifact(input.runDir, "final-audit.md", report);
  return report;
}

function fallbackAuditReport(
  originalRequest: string,
  completedIssues: VerifiedIssueSummary[],
  prNumbers: number[],
  verificationEvidence: VerificationEvidenceSummary[],
): string {
  const completedRequirements =
    completedIssues.length === 0
      ? ["- No verified completed issues were available."]
      : completedIssues.map(
          (issue) => `- Issue #${issue.issue_number}: ${issue.goal} (evidence: ${issue.evidence_created_at})`,
        );
  const missingRequirements = ["- None identified from the persisted run artifacts."];
  const evidenceLines =
    verificationEvidence.length === 0
      ? ["- No verification evidence artifacts were found."]
      : verificationEvidence.flatMap((entry) => [
          entry.verification_scope === "integrated"
            ? `- Integrated verification reviewed at ${entry.created_at} (${entry.evidence_path})`
            : `- Work item ${entry.work_item_id} / Issue #${entry.issue_number} reviewed at ${entry.created_at}`,
          ...entry.commands.map(
            (command) =>
              `  - ${command.command} (exit=${command.exit_code === null ? "null" : command.exit_code}, timed_out=${command.timed_out})`,
          ),
          ...entry.artifacts.map(
            (artifact) => `  - artifact: ${artifact.path} (${artifact.exists ? "present" : "missing"})`,
          ),
          ...entry.browser_evidence.map(
            (browserEvidence) =>
              `  - browser: ${browserEvidence.name} (${browserEvidence.status}, screenshot=${browserEvidence.screenshot_exists ? "present" : "missing"}, missing_network=${browserEvidence.missing_network.length})`,
          ),
        ]);
  const residualRisks = [
    `- This report was generated from persisted artifacts${prNumbers.length === 0 ? " without any recorded PRs" : ""}.`,
    "- Auto-merge remains disabled; a human still needs to decide whether to merge.",
  ];
  const mergeRecommendation =
    prNumbers.length === 0
      ? "- Not ready: no PRs were recorded."
      : "- Manual merge decision required after reviewing the final audit.";

  return [
    "# Final Audit",
    "",
    "## Original request",
    originalRequest,
    "",
    "## Completed requirements",
    ...completedRequirements,
    "",
    "## Missing requirements",
    ...missingRequirements,
    "",
    "## Verification evidence reviewed",
    ...evidenceLines,
    "",
    "## Residual risks",
    ...residualRisks,
    "",
    "## Merge recommendation",
    mergeRecommendation,
    "",
  ].join("\n");
}

export async function finalAudit(input: FinalAuditInput): Promise<string> {
  const rawManifest = JSON.parse(await readFile(join(input.runDir, "manifest.json"), "utf8")) as Record<string, unknown>;
  if (rawManifest.version === 2 || rawManifest.schema_version === 2) {
    return finalAuditV2(input, await readManifestV2(input.runDir));
  }
  const manifest = await readManifest(input.runDir);

  if (manifest.stage !== "merge_ready" && manifest.stage !== "final_audit") {
    throw new Error(
      `Final audit requires manifest.stage to be merge_ready or final_audit, received ${manifest.stage}.`,
    );
  }

  if (manifest.pr_numbers.length === 0) {
    throw new Error("Final audit requires at least one recorded pull request number.");
  }

  const originalRequest = await loadOriginalRequest(input.runDir, manifest.original_request);
  const issues = await loadIssues(input.runDir);
  const verificationEvidence = await loadVerificationEvidence(input.runDir);
  const completedIssues = mapVerifiedIssues(issues, manifest.issue_numbers, verificationEvidence);

  await updateManifest(input.runDir, { stage: "final_audit" });

  const template = await loadPromptTemplate("brain-final-auditor");
  const prompt = renderTemplate(template, {
    original_request: originalRequest,
    completed_issues: JSON.stringify(completedIssues, null, 2),
    pull_requests: JSON.stringify(manifest.pr_numbers, null, 2),
    verification_evidence: JSON.stringify(verificationEvidence, null, 2),
    browser_checks: JSON.stringify(
      completedIssues.flatMap((issue) => issue.browser_checks ?? []),
      null, 2,
    ),
  });
  const result = await input.codex.invoke({
    role: "brain_reviewer",
    model: input.config.profiles.brain_reviewer.model,
    reasoningEffort: input.config.profiles.brain_reviewer.reasoning_effort,
    prompt,
    runDir: input.runDir,
    artifactName: "brain-final-auditor",
  });

  if (result.exitCode !== 0) {
    const exitCode = result.exitCode === null ? "null" : String(result.exitCode);
    throw new Error(
      `Final audit failed closed: exitCode=${exitCode}, promptPath=${result.promptPath}, stdoutPath=${result.stdoutPath}, stderrPath=${result.stderrPath}`,
    );
  }

  if (!input.dryRun && !isUsableAuditReport(result.text)) {
    throw new Error("Final audit failed closed: auditor returned unusable Markdown output.");
  }

  const report = input.dryRun
    ? fallbackAuditReport(originalRequest, completedIssues, manifest.pr_numbers, verificationEvidence)
    : result.text.endsWith("\n")
      ? result.text
      : `${result.text}\n`;

  await writeTextArtifact(input.runDir, "final-audit.md", report);
  await updateManifest(input.runDir, { stage: "complete" });

  return report;
}
