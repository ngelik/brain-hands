import { access, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  verificationEvidencePath,
  verificationIdentityDirectory,
  type BrowserCheckSpec,
  type BrowserEvidenceReport,
  type RunMode,
  type VerificationEvidence,
  type VerificationIdentity,
} from "../core/types.js";
import { assertApprovedCommand, assertLocalVerificationCommand, splitCommand } from "../core/command.js";
import { runCommand } from "../core/executor.js";
import { beginVerificationAttempt, recordVerificationAttemptArtifacts, writeTextArtifact } from "../core/ledger.js";
import type { ProgressReporter } from "../progress/log.js";
import { safeToolLabel, type WorkItemCoordinate } from "../progress/events.js";
import {
  artifactPathSchema,
  browserEvidenceBundleSchema,
  browserEvidenceReportSchema,
  verificationExecutionResultSchema,
  verificationEvidenceSchema,
} from "../core/schema.js";
import { validatePersistedVerificationEvidence } from "./evidence.js";
import type { ResourceBudgetClaimV1, ResourceBudgetPort } from "../core/resource-budget.js";
import { missingExpectedNetwork } from "../browser/network-pattern.js";

export interface RunVerificationInput {
  repoRoot: string;
  runDir: string;
  /** The durable identity is the sole source of run-scoped destinations. */
  identity?: VerificationIdentity;
  /** Deprecated compatibility field; it is never used to derive a destination. */
  issueNumber?: number;
  mode?: RunMode;
  /** Optional retry number. When supplied, evidence is kept under an attempt directory. */
  attempt?: number;
  /** Immutable substage namespace within an attempt, such as mutation or self-review-pass-1. */
  artifactNamespace?: string;
  /** Validate and return already completed evidence without rerunning commands. */
  resumeExistingNamespace?: boolean;
  /** Frozen direct-argv commands. Strings remain accepted for legacy callers. */
  commands: readonly (string | readonly string[])[];
  /** Stop after persisting the first failed, unstartable, or timed-out command. */
  stopOnFailure?: boolean;
  commandIds?: readonly string[];
  budget?: ResourceBudgetPort;
  expectedArtifacts?: string[];
  browserChecks?: BrowserCheckSpec[];
  /** Exposes the controller lifecycle phase to approved verification commands. */
  phase?: "work_item" | "pre_pr" | "post_pr";
  progress?: ProgressReporter;
  progressContext?: { workItem: WorkItemCoordinate };
}

type BrowserEvidenceEntry = VerificationEvidence["browser_evidence"][number];
const DEFAULT_COMMAND_RESERVATION_MS = 15 * 60 * 1000;
const MAX_FAILURE_EXCERPT_CHARS = 4_000;

function persistedCommandErrorMessage(result: { exitCode: number | null; timedOut: boolean; errorMessage?: string; stdout: string; stderr: string }): string | null {
  if (result.exitCode === 0 && !result.timedOut) return result.errorMessage ?? null;
  const output = `${result.stdout}\n${result.stderr}`
    .replace(/data:image\/[^;\s]+;base64,[A-Za-z0-9+/=]+/g, "[data URL omitted]")
    .trim();
  const excerpt = output.length > MAX_FAILURE_EXCERPT_CHARS
    ? output.slice(-MAX_FAILURE_EXCERPT_CHARS)
    : output;
  return [result.errorMessage, excerpt ? `Failure output excerpt:\n${excerpt}` : null]
    .filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    .join("\n") || null;
}

interface LoadedBrowserEvidence {
  path: string;
  reports: BrowserEvidenceReport[];
  diagnostic?: string;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function normalizeStatus(value: unknown): "passed" | "failed" | "skipped" {
  if (value === "pass" || value === "passed" || value === true) {
    return "passed";
  }
  if (value === "skip" || value === "skipped") {
    return "skipped";
  }
  return "failed";
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function validateArtifactPaths(value: string[]): void {
  for (const path of value) {
    artifactPathSchema.parse(path);
  }
}

function validateVerificationArtifacts(
  expectedArtifacts: string[],
  browserChecks: BrowserCheckSpec[],
): void {
  const screenshotArtifacts = browserChecks.map((browserCheck) => browserCheck.screenshot_artifact);
  validateArtifactPaths([...expectedArtifacts, ...screenshotArtifacts]);
}

function aggregateReportsFromJson(value: unknown): BrowserEvidenceReport[] {
  if (!value || typeof value !== "object" || !Array.isArray((value as { captures?: unknown }).captures)) {
    return [];
  }

  return (value as { captures: unknown[] }).captures
    .filter((capture): capture is Record<string, unknown> => Boolean(capture) && typeof capture === "object")
    .map((capture) => {
      const layout = capture.layout && typeof capture.layout === "object"
        ? capture.layout as Record<string, unknown>
        : {};
      const status = normalizeStatus(capture.passed);
      const blockingConsole = asStringArray(capture.blockingConsole);
      const consoleEntries = Array.isArray(capture.console)
        ? capture.console
            .map((entry) => {
              if (typeof entry === "string") {
                return entry;
              }
              if (entry && typeof entry === "object" && typeof (entry as { text?: unknown }).text === "string") {
                return (entry as { text: string }).text;
              }
              return null;
            })
            .filter((entry): entry is string => entry !== null)
        : [];

      return {
        check_name: typeof capture.name === "string" ? capture.name : "browser capture",
        url: typeof (value as { appUrl?: unknown }).appUrl === "string"
          ? (value as { appUrl: string }).appUrl
          : "http://127.0.0.1/",
        status,
        observed_selectors: [],
        missing_selectors: [],
        console_errors: [...blockingConsole, ...consoleEntries],
        expected_network: [],
        observed_network: asStringArray(layout.resources),
        screenshot_artifact: typeof capture.screenshotPath === "string" ? capture.screenshotPath : "",
        console_error_policy: "no_errors",
        skipped_reason: status === "skipped" ? "Capture was skipped." : null,
      } satisfies BrowserEvidenceReport;
    })
    .filter((report) => report.screenshot_artifact.length > 0);
}

function scenarioReportFromJson(value: unknown): BrowserEvidenceReport[] {
  if (!value || typeof value !== "object") return [];
  const report = value as Record<string, unknown>;
  if (typeof report.checkName !== "string" || typeof report.screenshotArtifact !== "string") return [];
  const status = normalizeStatus(report.status);
  const observedRequestOrigins = asStringArray(report.observedRequestOrigins);
  const observedRequests = Array.isArray(report.observedRequests)
    ? report.observedRequests.flatMap((entry) => {
        if (!entry || typeof entry !== "object") return [];
        const request = entry as Record<string, unknown>;
        return typeof request.url === "string"
          ? [typeof request.method === "string" ? `${request.method} ${request.url}` : request.url]
          : [];
      })
    : [];
  const failureReasons = [
    ...asStringArray(report.pageErrors).map((entry) => `page error: ${entry}`),
    ...asStringArray(report.failedRequests).map((entry) => `failed request: ${entry}`),
    ...asStringArray(report.nonLocalRequests).map((entry) => `non-local request: ${entry}`),
  ];
  return [{
    check_name: report.checkName,
    url: observedRequestOrigins[0] ?? "http://127.0.0.1/",
    status,
    observed_selectors: [],
    missing_selectors: [],
    console_errors: asStringArray(report.consoleErrors),
    expected_network: observedRequestOrigins,
    observed_network: [...new Set([...observedRequestOrigins, ...observedRequests])],
    screenshot_artifact: report.screenshotArtifact,
    console_error_policy: "no_errors",
    failure_reasons: failureReasons,
    skipped_reason: status === "skipped" ? "Scenario evidence was skipped." : null,
  }];
}

async function loadBrowserEvidenceReports(
  repoRoot: string,
  artifactPaths: string[],
  browserChecks: BrowserCheckSpec[] = [],
  runDir?: string,
): Promise<LoadedBrowserEvidence[]> {
  const candidates = [...new Set([
    ...artifactPaths,
    ...browserChecks.map((check) => check.screenshot_artifact),
  ])].filter((path) => path.endsWith(".json"));
  const loaded: LoadedBrowserEvidence[] = [];

  for (const artifactPath of candidates) {
    const absolutePath = runDir && artifactPath.startsWith("verification/")
      ? join(runDir, artifactPath)
      : join(repoRoot, artifactPath);
    if (!(await fileExists(absolutePath))) {
      continue;
    }

    const raw = await readFile(absolutePath, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      loaded.push({
        path: artifactPath,
        reports: [],
        diagnostic: `Invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }
    const singleReport = browserEvidenceReportSchema.safeParse(parsed);
    const bundle = browserEvidenceBundleSchema.safeParse(parsed);
    const reports = singleReport.success
      ? [singleReport.data]
      : bundle.success
        ? bundle.data.reports
        : [...aggregateReportsFromJson(parsed), ...scenarioReportFromJson(parsed)];

    if (reports.length > 0) {
      loaded.push({ path: artifactPath, reports });
      continue;
    }

    const issues = bundle.error?.issues ?? singleReport.error?.issues ?? [];
    const diagnostic = issues.slice(0, 8).map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "root";
      return `${path}: ${issue.message}`;
    }).join("; ");
    loaded.push({
      path: artifactPath,
      reports: [],
      diagnostic: diagnostic || "Report did not match a supported browser evidence schema.",
    });
  }

  return loaded;
}

function findBrowserReport(
  browserCheck: BrowserCheckSpec,
  loadedEvidence: LoadedBrowserEvidence[],
): { path: string; report: BrowserEvidenceReport } | null {
  for (const evidence of loadedEvidence) {
    const report = evidence.reports.find(
      (candidate) =>
        candidate.screenshot_artifact === browserCheck.screenshot_artifact ||
        browserCheck.screenshot_artifact.endsWith(`/${candidate.screenshot_artifact}`) ||
        candidate.check_name === browserCheck.name,
    );
    if (report) {
      return { path: evidence.path, report };
    }
  }
  return null;
}

async function stageBrowserArtifacts(
  repoRoot: string,
  runDir: string,
  evidenceDirectory: string,
  expectedArtifacts: string[],
  browserChecks: BrowserCheckSpec[],
): Promise<Set<string>> {
  const browserArtifactPaths = [...new Set([
    ...browserChecks.map((check) => check.screenshot_artifact),
    ...expectedArtifacts.filter((path) => path.endsWith(".json")),
  ])];
  const staged = new Set<string>();

  for (const artifactPath of browserArtifactPaths) {
    const source = join(repoRoot, artifactPath);
    if (!(await fileExists(source))) continue;
    await writeTextArtifact(runDir, `${evidenceDirectory}/${artifactPath}`, await readFile(source));
    staged.add(artifactPath);
  }

  return staged;
}

async function buildArtifactChecks(
  repoRoot: string,
  expectedArtifacts: string[],
  browserChecks: BrowserCheckSpec[],
  runDir?: string,
): Promise<VerificationEvidence["artifact_checks"]> {
  const artifactPaths = [
    ...expectedArtifacts,
    ...browserChecks.map((check) => check.screenshot_artifact),
  ];
  const uniquePaths = [...new Set(artifactPaths)].filter((path) => path.length > 0);

  return Promise.all(
    uniquePaths.map(async (path) => ({
      path,
      exists: await fileExists(runDir && path.startsWith("verification/") ? join(runDir, path) : join(repoRoot, path)),
      required: true,
    })),
  );
}

async function buildBrowserEvidence(
  repoRoot: string,
  expectedArtifacts: string[],
  browserChecks: BrowserCheckSpec[],
  runDir?: string,
): Promise<VerificationEvidence["browser_evidence"]> {
  const loadedEvidence = await loadBrowserEvidenceReports(repoRoot, expectedArtifacts, browserChecks, runDir);

  return Promise.all(
    browserChecks.map(async (check): Promise<BrowserEvidenceEntry> => {
      const match = findBrowserReport(check, loadedEvidence);
      const invalidEvidence = loadedEvidence.find((evidence) => evidence.diagnostic);
      const screenshotExists = await fileExists(runDir && check.screenshot_artifact.startsWith("verification/")
        ? join(runDir, check.screenshot_artifact)
        : join(repoRoot, check.screenshot_artifact));
      const observedNetwork = match?.report.observed_network ?? [];
      const expectedNetwork = check.expected_network;
      const missingNetwork = missingExpectedNetwork(expectedNetwork, observedNetwork);
      const missingSelectors = match?.report.missing_selectors ?? check.required_selectors;
      const consoleErrors = match?.report.console_errors ?? [];
      const failureReasons = match?.report.failure_reasons ?? (invalidEvidence
        ? [`Invalid browser evidence report at ${invalidEvidence.path}: ${invalidEvidence.diagnostic}`]
        : []);
      const skippedReason = match?.report.skipped_reason ?? (match
        ? null
        : invalidEvidence
          ? "No valid browser evidence report matched this check."
          : "No browser evidence report matched this check.");
      const status: BrowserEvidenceEntry["status"] =
        match &&
        match.report.status === "passed" &&
        screenshotExists &&
        missingNetwork.length === 0 &&
        missingSelectors.length === 0 &&
        (check.console_error_policy !== "no_errors" || consoleErrors.length === 0)
          ? "passed"
          : match?.report.status === "skipped"
            ? "skipped"
            : "failed";

      return {
        name: check.name,
        url: check.url,
        status,
        screenshot_artifact: check.screenshot_artifact,
        screenshot_exists: screenshotExists,
        expected_network: expectedNetwork,
        observed_network: observedNetwork,
        missing_network: missingNetwork,
        console_errors: consoleErrors,
        missing_selectors: missingSelectors,
        failure_reasons: failureReasons,
        evidence_report_path: match?.path ?? invalidEvidence?.path ?? null,
        skipped_reason: skippedReason,
      };
    }),
  );
}

function verificationBudgetKey(
  identity: VerificationIdentity,
  attempt: number,
  commandId: string,
): string {
  return `verification:${identity.scope}:${identity.work_item_id}:${attempt}:${commandId}`;
}

async function loadPersistedCommandResult(input: {
  runDir: string;
  command: string;
  argv: string[];
  stdoutPath: string;
  stderrPath: string;
  resultPath: string;
}): Promise<VerificationEvidence["commands"][number] | null> {
  const absolutePaths = [input.stdoutPath, input.stderrPath, input.resultPath]
    .map((path) => join(input.runDir, path));
  const present = await Promise.all(absolutePaths.map(fileExists));
  if (present.every((value) => !value)) return null;
  if (!present.every(Boolean)) {
    throw new Error(`Interrupted verification command artifacts are incomplete: ${input.resultPath}`);
  }
  const [stdout, stderr, resultRaw] = await Promise.all(absolutePaths.map((path) => readFile(path, "utf8")));
  const result = verificationExecutionResultSchema.parse(JSON.parse(resultRaw!));
  if (
    JSON.stringify(result.argv) !== JSON.stringify(input.argv)
    || result.stdout !== stdout
    || result.stderr !== stderr
  ) {
    throw new Error(`Interrupted verification command artifacts do not match: ${input.resultPath}`);
  }
  return {
    command: input.command,
    argv: input.argv,
    exit_code: result.exit_code,
    timed_out: result.timed_out,
    error_code: result.error_code,
    error_message: result.error_message,
    signal: result.signal,
    stdout_path: input.stdoutPath,
    stderr_path: input.stderrPath,
    result_path: input.resultPath,
    duration_ms: result.duration_ms,
  };
}

async function claimVerificationCommandBudget(
  input: RunVerificationInput,
  identity: VerificationIdentity,
  attempt: number,
  commandId: string,
): Promise<{ claim: ResourceBudgetClaimV1; timeoutMs: number } | null> {
  if (input.budget === undefined) return null;
  const remaining = await input.budget.remainingActiveElapsedMs();
  const timeoutMs = Math.min(DEFAULT_COMMAND_RESERVATION_MS, remaining);
  const claim = await input.budget.claim({
    kind: "verification_command",
    key: verificationBudgetKey(identity, attempt, commandId),
    elapsed_reservation_ms: timeoutMs,
  });
  return { claim, timeoutMs };
}

export async function runVerification(
  input: RunVerificationInput,
): Promise<VerificationEvidence> {
  if (input.attempt !== undefined && (!Number.isInteger(input.attempt) || input.attempt < 1)) {
    throw new Error("Verification attempt must be a positive integer");
  }
  const browserChecks = input.browserChecks ?? [];
  validateVerificationArtifacts(input.expectedArtifacts ?? [], browserChecks);
  const commands: VerificationEvidence["commands"] = [];
  const expectedArtifacts = input.expectedArtifacts ?? [];
  const workItem = input.progressContext?.workItem;
  await input.progress?.emit({
    code: workItem?.final ? "final_verification_started" : "verification_started",
    source: "verification",
    workItem,
  });
  if (!input.identity) {
    throw new Error("Verification requires a durable identity");
  }
  if (input.commandIds !== undefined && input.commandIds.length !== input.commands.length) {
    throw new Error("Verification commandIds length must match commands length");
  }
  const identity = input.identity;
  if (input.issueNumber !== undefined && (identity.scope !== "github" || identity.issue_number !== input.issueNumber)) {
    throw new Error("Verification issue number does not match its mapped identity");
  }
  const attempt = input.attempt ?? 1;
  const evidenceDirectory = `${verificationIdentityDirectory(identity)}/attempt-${attempt}`;
  const scopedBrowserReportPath = `${evidenceDirectory}/browser-evidence.json`;
  const commandEnvironment: NodeJS.ProcessEnv = {
    ...process.env,
    BRAIN_HANDS_VERIFICATION_PHASE: input.phase ?? "work_item",
    ...(browserChecks.length > 0
      ? { BRAIN_HANDS_BROWSER_EVIDENCE_REPORT: join(input.runDir, scopedBrowserReportPath) }
      : {}),
  };
  const browserReportExists = browserChecks.length > 0
    && await fileExists(join(input.runDir, scopedBrowserReportPath));
  if (input.resumeExistingNamespace) {
    try {
      return await validatePersistedVerificationEvidence({
        runDir: input.runDir,
        identity,
        attempt,
        evidencePath: verificationEvidencePath(identity, attempt),
      });
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    if (browserReportExists) {
      await recordVerificationAttemptArtifacts(input.runDir, identity, attempt, [scopedBrowserReportPath]);
    }
  }
  await beginVerificationAttempt(input.runDir, identity, attempt);
  if (browserChecks.length > 0) {
    // Approved verification commands may write this report at any point. Declare
    // the exact controller-owned path before a child process can create it.
    await recordVerificationAttemptArtifacts(input.runDir, identity, attempt, [scopedBrowserReportPath]);
  }
  const writeArtifact = writeTextArtifact;

  for (const [index, command] of input.commands.entries()) {
    const commandId = input.commandIds?.[index] ?? String(index + 1);
    const argv = typeof command === "string"
      ? (() => {
          const parsed = splitCommand(command);
          return [parsed.executable, ...parsed.args];
        })()
      : [...command];
    // Legacy callers commonly use process.execPath as an absolute executable.
    // Validate its stable basename while still invoking the exact executable
    // path through execa; all user-supplied absolute targets remain rejected.
    const policyArgv = argv[0] === process.execPath
      ? [basename(process.execPath), ...argv.slice(1)]
      : argv;
    if (input.mode === "local") {
      assertLocalVerificationCommand(policyArgv, input.repoRoot);
    } else {
      assertApprovedCommand(policyArgv, input.repoRoot);
    }

    const executable = argv[0];
    const args = argv.slice(1);
    const commandLabel = typeof command === "string" ? command : argv.join(" ");
    const stdoutRelative = `${evidenceDirectory}/command-${index + 1}.stdout.txt`;
    const stderrRelative = `${evidenceDirectory}/command-${index + 1}.stderr.txt`;
    const resultRelative = `${evidenceDirectory}/command-${index + 1}.json`;
    const persisted = input.resumeExistingNamespace
      ? await loadPersistedCommandResult({
          runDir: input.runDir,
          command: commandLabel,
          argv,
          stdoutPath: stdoutRelative,
          stderrPath: stderrRelative,
          resultPath: resultRelative,
        })
      : null;
    if (persisted !== null) {
      commands.push(persisted);
      await input.progress?.emit({
        code: persisted.exit_code === 0 && !persisted.timed_out
          ? "verification_command_passed"
          : "verification_command_failed",
        source: "verification",
        workItem,
        operation: { index: index + 1, total: input.commands.length, kind: "command", safe_tool: safeToolLabel(executable), duration_ms: persisted.duration_ms },
      });
      if (input.stopOnFailure === true && (persisted.exit_code !== 0 || persisted.timed_out)) break;
      continue;
    }
    await input.progress?.emit({
      code: "verification_command_started",
      source: "verification",
      workItem,
      operation: { index: index + 1, total: input.commands.length, kind: "command", safe_tool: safeToolLabel(executable) },
    });
    const budgetClaim = await claimVerificationCommandBudget(input, identity, attempt, commandId);
    const startedAt = Date.now();
    const result = await runCommand({
      command: executable,
      args,
      cwd: input.repoRoot,
      timeoutMs: budgetClaim?.timeoutMs ?? DEFAULT_COMMAND_RESERVATION_MS,
      env: commandEnvironment,
    });
    const durationMs = Math.max(0, Date.now() - startedAt);
    const persistedErrorMessage = persistedCommandErrorMessage(result);
    await input.progress?.emit({
      code: result.exitCode === 0 && !result.timedOut ? "verification_command_passed" : "verification_command_failed",
      source: "verification",
      workItem,
      operation: { index: index + 1, total: input.commands.length, kind: "command", safe_tool: safeToolLabel(executable), duration_ms: durationMs },
    });

    await recordVerificationAttemptArtifacts(input.runDir, identity, attempt, [
      stdoutRelative,
      stderrRelative,
      resultRelative,
    ]);

    await writeArtifact(input.runDir, stdoutRelative, result.stdout);
    await writeArtifact(input.runDir, stderrRelative, result.stderr);
    await writeArtifact(
      input.runDir,
      resultRelative,
      `${JSON.stringify({
        argv,
        stdout: result.stdout,
        stderr: result.stderr,
        exit_code: result.exitCode,
        duration_ms: durationMs,
        timed_out: result.timedOut,
        error_code: result.errorCode ?? null,
        error_message: persistedErrorMessage,
        signal: result.signal ?? null,
      }, null, 2)}\n`,
    );
    if (budgetClaim !== null) {
      await input.budget!.complete({
        claim_id: budgetClaim.claim.claim_id,
        outcome: result.exitCode === 0 && !result.timedOut ? "succeeded" : "failed",
        duration_ms: Math.min(durationMs, budgetClaim.timeoutMs),
        process_started: true,
        turn_started: false,
        structured_terminal_error: false,
        token_usage: null,
      });
    }

    commands.push({
      command: commandLabel,
      argv,
      exit_code: result.exitCode,
      timed_out: result.timedOut,
      error_code: result.errorCode ?? null,
      error_message: persistedErrorMessage,
      signal: result.signal ?? null,
      stdout_path: stdoutRelative,
      stderr_path: stderrRelative,
      result_path: resultRelative,
      duration_ms: durationMs,
    });

    const failed = result.exitCode !== 0 || result.timedOut;
    if (input.stopOnFailure === true && failed) break;
  }

  await input.progress?.emit({ code: "artifact_checks_started", source: "verification", workItem });
  const stagedBrowserArtifacts = await stageBrowserArtifacts(
    input.repoRoot,
    input.runDir,
    evidenceDirectory,
    expectedArtifacts,
    browserChecks,
  );
  const effectiveBrowserChecks = browserChecks.map((check) => ({
    ...check,
    screenshot_artifact: `${evidenceDirectory}/${check.screenshot_artifact}`,
  }));
  const effectiveExpectedArtifacts = expectedArtifacts.map((path) =>
    stagedBrowserArtifacts.has(path) ? `${evidenceDirectory}/${path}` : path
  );
  if (await fileExists(join(input.runDir, scopedBrowserReportPath))) {
    effectiveExpectedArtifacts.unshift(scopedBrowserReportPath);
  }
  const artifactChecks = await buildArtifactChecks(input.repoRoot, effectiveExpectedArtifacts, effectiveBrowserChecks, input.runDir);
  if (artifactChecks.length > 0) {
    await input.progress?.emit({ code: "artifact_checks_completed", source: "verification", workItem, presentCount: artifactChecks.filter((entry) => entry.exists).length, operation: { index: 1, total: artifactChecks.length, kind: "artifact_check" } });
  }
  await input.progress?.emit({ code: "browser_checks_started", source: "verification", workItem });
  const browserEvidence = await buildBrowserEvidence(input.repoRoot, effectiveExpectedArtifacts, effectiveBrowserChecks, input.runDir);
  if (browserEvidence.length > 0) {
    await input.progress?.emit({ code: "browser_checks_completed", source: "verification", workItem, presentCount: browserEvidence.filter((entry) => entry.status === "passed").length, operation: { index: 1, total: browserEvidence.length, kind: "browser_check" } });
  }

  await recordVerificationAttemptArtifacts(input.runDir, identity, attempt, [
    ...commands.flatMap((command) => [command.stdout_path, command.stderr_path, ...(command.result_path ? [command.result_path] : [])]),
    ...[...stagedBrowserArtifacts].map((path) => `${evidenceDirectory}/${path}`),
    ...browserEvidence.flatMap((browser) => [browser.screenshot_artifact, ...(browser.evidence_report_path ? [browser.evidence_report_path] : [])])
      .filter((path) => path.startsWith(`${evidenceDirectory}/`)),
  ]);

  const evidence = verificationEvidenceSchema.parse({
    verification_scope: identity.scope,
    work_item_id: identity.work_item_id,
    ...(identity.scope === "github" ? { issue_number: identity.issue_number } : {}),
    attempt,
    evidence_path: verificationEvidencePath(identity, attempt),
    commands,
    artifacts: artifactChecks.filter((artifact) => artifact.exists).map((artifact) => artifact.path),
    artifact_checks: artifactChecks,
    browser_evidence: browserEvidence,
    created_at: new Date().toISOString(),
  });

  await writeArtifact(
    input.runDir,
    `${evidenceDirectory}/evidence.json`,
    JSON.stringify(evidence, null, 2),
  );
  await input.progress?.emit({ code: "verification_recorded", source: "verification", workItem });

  return evidence;
}
