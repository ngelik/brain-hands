import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ZodType } from "zod";
import type {
  BrainHandsConfig,
  ModelRole,
  ReasoningEffort,
  RoleName,
  SandboxMode,
} from "../core/types.js";
import {
  brainPlanOutputSchema,
  implementationResultOutputSchema,
  verifierReviewOutputSchema,
} from "../core/output-schemas.js";
import {
  brainPlanSchema,
  implementationResultSchema,
  strictVerifierReviewSchema,
} from "../core/schema.js";
import {
  CodexModelCatalogAdapter,
  type ValidateModelSelectionInput,
} from "./codex-models.js";
import { runCommand, type CommandResult } from "../core/executor.js";
import { createCodexProgressConsumer, type CodexProgressContext, type TokenUsage } from "../progress/codex.js";
import type { ProgressIntent } from "../progress/events.js";
import type { ProgressReporter } from "../progress/log.js";
import { readOwnedEvidenceFile, writeOwnedEvidenceFile } from "../core/owned-evidence.js";
import type { ResourceBudgetClaimV1, ResourceBudgetPort } from "../core/resource-budget.js";

export interface RenderCodexArgsInput {
  model: string;
  reasoningEffort: ReasoningEffort;
  sandbox: SandboxMode;
  cwd: string;
  outputSchemaPath: string;
  outputPath: string;
  isolateUserConfig: boolean;
  enableWebSearch: boolean;
  jsonEvents?: boolean;
  skipGitRepoCheck?: boolean;
}

export interface CodexInvokeInput {
  /** Legacy role names remain accepted while the workflow callers migrate. */
  role: ModelRole | RoleName;
  model: string;
  reasoningEffort: ReasoningEffort;
  prompt: string;
  runDir: string;
  artifactName: string;
  sandbox?: SandboxMode;
  cwd?: string;
  isolateUserConfig?: boolean;
  enableWebSearch?: boolean;
  research?: boolean;
  /** JSON Schema written to the run artifact and passed to Codex. */
  outputSchema?: unknown;
  /** Zod parser used for the output-last-message JSON. */
  outputParser?: ZodType<unknown>;
  /** Short aliases accepted by callers integrating the adapter directly. */
  schema?: unknown;
  parser?: ZodType<unknown>;
  /** Dry-run JSON fixture. It must be supplied for structured dry-runs. */
  fixture?: unknown;
  fixturePath?: string;
  progress?: { reporter: ProgressReporter; context: CodexProgressContext };
  skipGitRepoCheck?: boolean;
  budget?: ResourceBudgetPort;
  attemptKey?: string;
}

export interface CodexInvokeResult {
  text: string;
  exitCode: number | null;
  promptPath: string;
  stdoutPath: string;
  stderrPath: string;
  outputPath?: string;
  schemaPath?: string;
  parsed?: unknown;
  progressPath?: string;
  usage: TokenUsage | null;
  durationMs: number;
  processStarted: boolean;
  turnStarted: boolean;
  structuredTerminalError: boolean;
}

export interface CodexAdapter {
  invoke(input: CodexInvokeInput): Promise<CodexInvokeResult>;
}

export type CodexInvocationFailureKind = "invocation" | "missing_output" | "output_validation";

export class CodexInvocationError extends Error {
  readonly kind: CodexInvocationFailureKind;
  override readonly cause?: unknown;

  constructor(
    message: string,
    readonly result?: CommandResult,
    readonly paths?: {
      promptPath: string;
      schemaPath?: string;
      outputPath?: string;
      stdoutPath?: string;
      stderrPath?: string;
      progressPath?: string;
    },
    options?: {
      kind?: CodexInvocationFailureKind;
      cause?: unknown;
      usage?: TokenUsage | null;
      durationMs?: number;
      processStarted?: boolean;
      turnStarted?: boolean;
      structuredTerminalError?: boolean;
    },
  ) {
    super(message);
    this.name = "CodexInvocationError";
    this.kind = options?.kind ?? "invocation";
    this.cause = options?.cause;
    this.usage = options?.usage ?? null;
    this.durationMs = options?.durationMs ?? 0;
    this.processStarted = options?.processStarted ?? false;
    this.turnStarted = options?.turnStarted ?? false;
    this.structuredTerminalError = options?.structuredTerminalError ?? false;
  }

  readonly usage: TokenUsage | null;
  readonly durationMs: number;
  readonly processStarted: boolean;
  readonly turnStarted: boolean;
  readonly structuredTerminalError: boolean;
}

export type CodexFailureKind = "primary_usage_limit" | "other";

const ZERO_TOKEN_USAGE: TokenUsage = {
  input_tokens: 0,
  cached_input_tokens: 0,
  output_tokens: 0,
  reasoning_output_tokens: 0,
};

const USAGE_LIMIT_CODES = new Set([
  "usage_limit_reached",
  "credits_exhausted",
  "insufficient_quota",
]);

export const DISABLED_CODEX_AGENT_FEATURES = Object.freeze([
  "multi_agent",
  "multi_agent_v2",
  "enable_fanout",
] as const);

export function disabledCodexAgentFeatureArgs(): string[] {
  return DISABLED_CODEX_AGENT_FEATURES.flatMap((feature) => ["--disable", feature]);
}

export function classifyCodexFailure(result: CommandResult): CodexFailureKind {
  const combined = `${result.stdout}\n${result.stderr}`.trim();
  if (/rate limit/i.test(combined)) return "other";
  try {
    const parsed = JSON.parse(combined) as { error?: { code?: unknown } };
    if (typeof parsed.error?.code === "string" && USAGE_LIMIT_CODES.has(parsed.error.code)) {
      return "primary_usage_limit";
    }
  } catch {
    if (/you(?:'ve| have) hit your usage limit(?:\.|\s|$)/i.test(combined)) {
      return "primary_usage_limit";
    }
  }
  return "other";
}

/** Render the current structured Codex CLI argv. */
export function renderCodexArgs(input: RenderCodexArgsInput): string[];
export function renderCodexArgs(input: RenderCodexArgsInput): string[] {
  const args = [
    "exec",
    "--ephemeral",
    ...disabledCodexAgentFeatureArgs(),
    ...(input.jsonEvents ? ["--json"] : []),
    ...(input.isolateUserConfig ? ["--ignore-user-config"] : []),
    "--model",
    input.model,
    "-c",
    `model_reasoning_effort="${input.reasoningEffort}"`,
    "--sandbox",
    input.sandbox,
    "-C",
    input.cwd,
    ...(input.skipGitRepoCheck ? ["--skip-git-repo-check"] : []),
    "--output-schema",
    input.outputSchemaPath,
    "--output-last-message",
    input.outputPath,
  ];

  if (input.enableWebSearch) {
    args.push("--search");
  }

  return args;
}

async function writePromptArtifact(
  runDir: string,
  artifactName: string,
  prompt: string,
): Promise<string> {
  const promptsDir = join(runDir, "prompts");
  await mkdir(promptsDir, { recursive: true });
  const promptPath = join(promptsDir, `${artifactName}.md`);
  await writeEvidenceOnce(runDir, `prompts/${artifactName}.md`, prompt);
  return promptPath;
}

async function writeSchemaArtifact(
  runDir: string,
  artifactName: string,
  schema: unknown,
): Promise<string> {
  const schemasDir = join(runDir, "schemas");
  await mkdir(schemasDir, { recursive: true });
  const schemaPath = join(schemasDir, `${artifactName}.json`);
  await writeEvidenceOnce(runDir, `schemas/${artifactName}.json`, `${JSON.stringify(schema, null, 2)}\n`);
  return schemaPath;
}

async function writeResponseArtifacts(
  runDir: string,
  artifactName: string,
  stdout: string,
  stderr: string,
): Promise<{ stdoutPath: string; stderrPath: string }> {
  const responsesDir = join(runDir, "responses");
  await mkdir(responsesDir, { recursive: true });
  const stdoutPath = join(responsesDir, `${artifactName}.stdout.txt`);
  const stderrPath = join(responsesDir, `${artifactName}.stderr.txt`);
  await writeEvidenceOnce(runDir, `responses/${artifactName}.stdout.txt`, stdout);
  await writeEvidenceOnce(runDir, `responses/${artifactName}.stderr.txt`, stderr);
  return { stdoutPath, stderrPath };
}

async function writeProgressResponseArtifacts(
  runDir: string,
  artifactName: string,
  progressPath: string,
  stderr: string,
): Promise<{ stdoutPath: string; stderrPath: string; progressPath: string }> {
  const responsesDir = join(runDir, "responses");
  await mkdir(responsesDir, { recursive: true });
  const stderrPath = join(responsesDir, `${artifactName}.stderr.txt`);
  await writeEvidenceOnce(runDir, `responses/${artifactName}.stderr.txt`, stderr.trim() ? "Codex emitted stderr; details are omitted from live progress.\n" : "");
  return { stdoutPath: progressPath, stderrPath, progressPath };
}

async function writeEvidenceOnce(runDir: string, relativePath: string, content: string): Promise<void> {
  const ownedRoot = `${relativePath.split("/", 1)[0]}/`;
  try {
    await writeOwnedEvidenceFile(runDir, relativePath, ownedRoot, content);
  } catch (error: unknown) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    const existing = (await readOwnedEvidenceFile(runDir, relativePath, ownedRoot)).toString("utf8");
    if (existing !== content) throw new Error(`Immutable Codex evidence already exists with different bytes: ${relativePath}`);
  }
}

function progressIntent(
  input: CodexInvokeInput,
  code: ProgressIntent["code"],
  childPid?: number | null,
  heartbeatOrdinal?: number,
): ProgressIntent {
  const progress = input.progress!;
  return {
    code,
    source: progress.context.source,
    workItem: progress.context.workItem,
    model: progress.context.model,
    reasoningEffort: progress.context.reasoningEffort,
    workerSessionId: progress.context.workerSessionId ?? progress.reporter.sessionId,
    workerPid: progress.context.workerPid ?? progress.reporter.workerPid,
    modelInvocationId: progress.context.modelInvocationId,
    ...(childPid ? { childPid } : {}),
    ...(heartbeatOrdinal ? { heartbeatOrdinal } : {}),
  };
}

function startCode(context: CodexProgressContext): ProgressIntent["code"] {
  if (context.source === "brain") return "brain_started";
  if (context.source === "hands") return "hands_started";
  if (context.source === "verifier") return context.mode === "final_review" ? "final_verifier_started" : "verifier_started";
  return context.mode === "reflection_synthesis" ? "reflection_synthesizing" : "reflection_analyzing";
}

function validationCodes(context: CodexProgressContext): [ProgressIntent["code"], ProgressIntent["code"]] | null {
  if (context.source === "brain") return ["validating_plan", "plan_validated"];
  if (context.source === "hands") return ["validating_hands", "hands_validated"];
  if (context.source === "verifier") return ["validating_verifier", "verifier_validated"];
  return null;
}

function isRoleName(role: CodexInvokeInput["role"]): role is RoleName {
  return role === "brain" || role === "hands" || role === "verifier";
}

function defaultSandbox(role: CodexInvokeInput["role"]): SandboxMode {
  return role === "hands" || role === "hands_implementer" || role === "hands_fixer"
    ? "workspace-write"
    : "read-only";
}

function defaultOutputSchema(role: CodexInvokeInput["role"]): unknown {
  if (role === "brain") {
    return brainPlanOutputSchema;
  }
  if (role === "hands") {
    return implementationResultOutputSchema;
  }
  if (role === "verifier") {
    return verifierReviewOutputSchema;
  }
  // Retained V1 callers do not use the V2 output contracts. Keep their
  // response permissive while still invoking the current structured CLI.
  return { type: "object", additionalProperties: true };
}

function defaultOutputParser(role: CodexInvokeInput["role"]): ZodType<unknown> | undefined {
  if (role === "brain") {
    return brainPlanSchema as ZodType<unknown>;
  }
  if (role === "hands") {
    return implementationResultSchema as ZodType<unknown>;
  }
  if (role === "verifier") {
    return strictVerifierReviewSchema as ZodType<unknown>;
  }
  return undefined;
}

function isStructuredInput(input: CodexInvokeInput): boolean {
  return (
    isRoleName(input.role) ||
    input.sandbox !== undefined ||
    input.outputSchema !== undefined ||
    input.schema !== undefined ||
    input.outputParser !== undefined ||
    input.parser !== undefined ||
    input.fixture !== undefined ||
    input.fixturePath !== undefined
  );
}

function parseFixture(fixture: unknown): unknown {
  if (typeof fixture !== "string") {
    return fixture;
  }
  return JSON.parse(fixture) as unknown;
}

async function readFixture(input: CodexInvokeInput, fallback?: unknown): Promise<unknown> {
  if (input.fixturePath) {
    return parseFixture(await readFile(input.fixturePath, "utf8"));
  }
  if (input.fixture !== undefined) {
    return parseFixture(input.fixture);
  }
  if (fallback !== undefined) {
    return parseFixture(fallback);
  }
  throw new CodexInvocationError(
    "Structured dry-run requires a caller-provided JSON fixture",
  );
}

async function writeLegacyInvocationArtifacts(
  runDir: string,
  artifactName: string,
  prompt: string,
  stdout: string,
  stderr: string,
): Promise<{ promptPath: string; stdoutPath: string; stderrPath: string }> {
  const promptPath = await writePromptArtifact(runDir, artifactName, prompt);
  const responsePaths = await writeResponseArtifacts(runDir, artifactName, stdout, stderr);
  return { promptPath, ...responsePaths };
}

async function withResourceBudget<T extends CodexInvokeResult>(
  input: CodexInvokeInput,
  reserveElapsedMs: () => Promise<number>,
  action: () => Promise<T>,
): Promise<T> {
  if (input.budget === undefined) return action();
  if (input.attemptKey !== undefined) {
    await input.budget.claim({ kind: "workflow_attempt", key: input.attemptKey, elapsed_reservation_ms: 0 });
  }
  const claim = await input.budget.claim({
    kind: "model_invocation",
    key: input.artifactName,
    elapsed_reservation_ms: await reserveElapsedMs(),
  });
  try {
    const result = await action();
    await completeBudgetedInvocation(input.budget, claim, "succeeded", result);
    return result;
  } catch (error) {
    if (error instanceof CodexInvocationError) {
      await completeBudgetedInvocation(input.budget, claim, "failed", error);
    }
    throw error;
  }
}

async function completeBudgetedInvocation(
  budget: ResourceBudgetPort,
  claim: ResourceBudgetClaimV1,
  outcome: "succeeded" | "failed",
  metrics: Pick<CodexInvokeResult | CodexInvocationError, "usage" | "durationMs" | "processStarted" | "turnStarted" | "structuredTerminalError">,
): Promise<void> {
  await budget.complete({
    claim_id: claim.claim_id,
    outcome,
    duration_ms: metrics.durationMs,
    process_started: metrics.processStarted,
    turn_started: metrics.turnStarted,
    structured_terminal_error: metrics.structuredTerminalError,
    token_usage: metrics.usage,
  });
}

export class DryRunCodexAdapter implements CodexAdapter {
  constructor(private readonly fixture?: unknown) {}

  async invoke(input: CodexInvokeInput): Promise<CodexInvokeResult> {
    return withResourceBudget(input, async () => input.budget ? await input.budget.remainingActiveElapsedMs() : 1, () => this.invokeUnbudgeted(input));
  }

  private async invokeUnbudgeted(input: CodexInvokeInput): Promise<CodexInvokeResult> {
    if (!isStructuredInput(input)) {
      const text = JSON.stringify(
        {
          mode: "DRY_RUN",
          role: input.role,
          model: input.model,
          artifact: input.artifactName,
        },
        null,
        2,
      );
      const paths = await writeLegacyInvocationArtifacts(
        input.runDir,
        input.artifactName,
        input.prompt,
        text,
        "",
      );
      return {
        text,
        exitCode: 0,
        ...paths,
        usage: null,
        durationMs: 0,
        processStarted: false,
        turnStarted: false,
        structuredTerminalError: false,
      };
    }

    const parser = input.outputParser ?? input.parser ?? defaultOutputParser(input.role);
    const schema = input.outputSchema ?? input.schema ?? defaultOutputSchema(input.role);
    const promptPath = await writePromptArtifact(input.runDir, input.artifactName, input.prompt);
    const schemaPath = await writeSchemaArtifact(input.runDir, input.artifactName, schema);
    const fixture = await readFixture(input, this.fixture);
    if (input.progress) await input.progress.reporter.emit(progressIntent(input, startCode(input.progress.context)));
    const validation = input.progress ? validationCodes(input.progress.context) : null;
    if (validation) await input.progress!.reporter.emit(progressIntent(input, validation[0]));
    let parsed: unknown;
    try {
      parsed = parser ? parser.parse(fixture) : fixture;
    } catch (error) {
      if (input.progress) await input.progress.reporter.emit(progressIntent(input, "role_failed"));
      throw error;
    }
    if (validation) await input.progress!.reporter.emit(progressIntent(input, validation[1]));
    const text = JSON.stringify(parsed, null, 2);
    const outputText = `${text}\n`;
    const outputPath = join(input.runDir, "responses", `${input.artifactName}.json`);
    await mkdir(join(input.runDir, "responses"), { recursive: true });
    await writeEvidenceOnce(input.runDir, `responses/${input.artifactName}.json`, outputText);
    const paths = input.progress
      ? await writeProgressResponseArtifacts(input.runDir, input.artifactName, input.progress.reporter.path, "")
      : await writeResponseArtifacts(input.runDir, input.artifactName, text, "");
    return {
      text: outputText,
      exitCode: 0,
      promptPath,
      schemaPath,
      outputPath,
      parsed,
      ...paths,
      usage: ZERO_TOKEN_USAGE,
      durationMs: 0,
      processStarted: false,
      turnStarted: false,
      structuredTerminalError: false,
    };
  }
}

type CodexSettings = Partial<BrainHandsConfig["codex"]> & {
  isolate_user_config?: boolean;
};

type CodexAdapterConfig =
  | BrainHandsConfig
  | { codex: CodexSettings }
  | CodexSettings;

type CatalogValidator = (input: ValidateModelSelectionInput) => Promise<void>;

function codexSettings(config: CodexAdapterConfig): {
  command: string;
  timeout_seconds: number;
  isolate_user_config: boolean;
  args_template?: string[];
  prompt_transport?: "stdin" | "file";
  prompt_file_flag?: string;
} {
  const settings = ("codex" in config ? config.codex : config) as CodexSettings;
  return {
    command: settings.command ?? "codex",
    timeout_seconds: settings.timeout_seconds ?? 3600,
    isolate_user_config: settings.isolate_user_config ?? true,
    args_template: settings.args_template,
    prompt_transport: settings.prompt_transport,
    prompt_file_flag: settings.prompt_file_flag,
  };
}

export class SubprocessCodexAdapter implements CodexAdapter {
  private readonly settings: ReturnType<typeof codexSettings>;
  private readonly validateModelSelection: CatalogValidator;

  constructor(
    config: CodexAdapterConfig,
    private readonly cwd: string,
    validateModelSelection?: CatalogValidator,
  ) {
    this.settings = codexSettings(config);
    this.validateModelSelection = validateModelSelection ?? ((input) => {
      const adapter = new CodexModelCatalogAdapter({
        command: this.settings.command,
        cwd: this.cwd,
        timeoutMs: this.settings.timeout_seconds * 1000,
      });
      return adapter.assertExactModelSelection(input);
    });
  }

  async invoke(input: CodexInvokeInput): Promise<CodexInvokeResult> {
    return withResourceBudget(input, async () => input.budget ? await input.budget.remainingActiveElapsedMs() : 1, () => this.invokeUnbudgeted(input));
  }

  private async invokeUnbudgeted(input: CodexInvokeInput): Promise<CodexInvokeResult> {
    const outputPath = join(input.runDir, "responses", `${input.artifactName}.json`);
    await assertOutputArtifactAvailable(input.runDir, `responses/${input.artifactName}.json`);
    const promptPath = await writePromptArtifact(input.runDir, input.artifactName, input.prompt);
    const schema = input.outputSchema ?? input.schema ?? defaultOutputSchema(input.role);
    const schemaPath = await writeSchemaArtifact(input.runDir, input.artifactName, schema);
    await mkdir(join(input.runDir, "responses"), { recursive: true });
    const stagingDir = await mkdtemp(join(input.runDir, "responses/.codex-staging-"));
    const stagingOutputPath = join(stagingDir, "output.json");
    const stagingRelativePath = `responses/${basename(stagingDir)}/output.json`;
    let durationMs = 0;
    let processStarted = false;

    try {
    const sandbox = input.sandbox ?? defaultSandbox(input.role);
    try {
      await this.validateModelSelection({
        role: input.role,
        model: input.model,
        reasoningEffort: input.reasoningEffort,
      });
    } catch (error) {
      throw new CodexInvocationError(
        error instanceof Error ? error.message : String(error),
        undefined,
        { promptPath, schemaPath, outputPath, stdoutPath: "", stderrPath: "" },
        { cause: error },
      );
    }
    const args = renderCodexArgs({
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      sandbox,
      cwd: input.cwd ?? this.cwd,
      outputSchemaPath: schemaPath,
      outputPath: stagingOutputPath,
      isolateUserConfig: input.isolateUserConfig ?? this.settings.isolate_user_config,
      enableWebSearch: input.enableWebSearch === true && input.role === "brain",
      jsonEvents: true,
      skipGitRepoCheck: input.skipGitRepoCheck,
    });
    const consumer = createCodexProgressConsumer({
      reporter: input.progress?.reporter,
      context: input.progress?.context ?? {
        source: isRoleName(input.role) ? input.role : "brain",
        mode: input.role === "hands" ? "implementation" : input.role === "verifier" ? "review" : "planning",
        model: input.model,
        reasoningEffort: input.reasoningEffort,
      },
    });
    let heartbeatOrdinal = 0;
    const startedAt = Date.now();
    const result = await runCommand({
      command: this.settings.command,
      args,
      cwd: input.cwd ?? this.cwd,
      timeoutMs: this.settings.timeout_seconds * 1000,
      stdin: input.prompt,
      onStarted: async ({ pid }: { pid: number | null }) => {
        processStarted = true;
        if (input.progress) {
          await input.progress.reporter.emit(progressIntent(input, startCode(input.progress.context), pid));
        }
      },
      onStdoutChunk: (chunk: string) => consumer.write(chunk),
      ...(input.progress ? {
        onHeartbeat: async ({ pid }: { pid: number | null }) => {
          heartbeatOrdinal += 1;
          await input.progress!.reporter.emit(progressIntent(input, "heartbeat", pid, heartbeatOrdinal));
        },
        heartbeatMs: 45_000,
      } : {}),
    });
    durationMs = Math.max(0, Date.now() - startedAt);
    await consumer.end();
    const responsePaths = input.progress
      ? await writeProgressResponseArtifacts(input.runDir, input.artifactName, input.progress.reporter.path, result.stderr)
      : await writeResponseArtifacts(input.runDir, input.artifactName, result.stdout, result.stderr);

    const paths = { promptPath, schemaPath, outputPath, progressPath: input.progress?.reporter.path, ...responsePaths };
    const metrics = {
      usage: consumer.terminalUsage(),
      durationMs,
      processStarted,
      turnStarted: consumer.turnStarted(),
      structuredTerminalError: consumer.structuredTerminalError(),
    };
    if (result.exitCode !== 0) {
      if (input.progress) await input.progress.reporter.emit(progressIntent(input, "role_failed"));
      throw new CodexInvocationError(
        `Codex invocation failed with exit code ${result.exitCode ?? "null"}: ${input.progress ? sanitizeStderr(result.stderr || result.errorMessage || "no stderr") : result.stderr || result.errorMessage || "no stderr"}`,
        result,
        paths,
        metrics,
      );
    }

    let outputText: string;
    const validation = input.progress ? validationCodes(input.progress.context) : null;
    if (validation) await input.progress!.reporter.emit(progressIntent(input, validation[0]));
    try {
      outputText = (await readOwnedEvidenceFile(input.runDir, stagingRelativePath, "responses/")).toString("utf8");
      if (outputText.length === 0) throw Object.assign(new Error("empty output"), { code: "ENOENT" });
    } catch {
      await input.progress?.reporter.emit({ code: "role_failed", source: input.progress.context.source, workItem: input.progress.context.workItem });
      throw new CodexInvocationError(
        `Codex invocation did not produce the required output-last-message file: ${outputPath}`,
        result,
        paths,
        { kind: "missing_output", ...metrics },
      );
    }
    try {
      await writeOwnedEvidenceFile(input.runDir, `responses/${input.artifactName}.json`, "responses/", outputText);
    } catch (error: unknown) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") {
        throw new CodexInvocationError(
          `Immutable Codex output evidence already exists: responses/${input.artifactName}.json`,
          result,
          paths,
          metrics,
        );
      }
      throw error;
    }

    const parser = input.outputParser ?? input.parser ?? defaultOutputParser(input.role);
    let parsed: unknown;
    let outputValidationFailure: unknown = null;
    try {
      const parsedJson = JSON.parse(outputText) as unknown;
      parsed = parser ? parser.parse(parsedJson) : parsedJson;
    } catch (error) {
      outputValidationFailure = error;
    }
    if (outputValidationFailure !== null) {
      await input.progress?.reporter.emit({ code: "role_failed", source: input.progress.context.source, workItem: input.progress.context.workItem });
      throw new CodexInvocationError(
        `Codex output failed schema validation: ${outputValidationFailure instanceof Error ? outputValidationFailure.message : String(outputValidationFailure)}`,
        result,
        paths,
        { kind: "output_validation", cause: outputValidationFailure, ...metrics },
      );
    }
    if (validation) await input.progress!.reporter.emit(progressIntent(input, validation[1]));
    return {
      text: outputText,
      exitCode: result.exitCode,
      parsed,
      ...paths,
      ...metrics,
    };
    } finally {
      await rm(stagingDir, { recursive: true, force: true });
    }
  }
}

async function assertOutputArtifactAvailable(runDir: string, relativePath: string): Promise<void> {
  try {
    await readOwnedEvidenceFile(runDir, relativePath, "responses/");
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  throw new CodexInvocationError(`Immutable Codex output evidence already exists: ${relativePath}`);
}

async function writeSafeStderr(runDir: string, artifactName: string, stderr: string): Promise<string> {
  const path = join(runDir, "responses", `${artifactName}.stderr.txt`);
  await writeFile(path, sanitizeStderr(stderr), "utf8");
  return path;
}

function sanitizeStderr(stderr: string): string {
  const redacted = stderr
    .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
    .replace(/\b(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,})\b/gi, "[REDACTED]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/\b([A-Z][A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD))\s*=\s*\S+/gi, "$1=[REDACTED]");
  const limit = 32_000;
  const marker = "\n[stderr truncated]\n";
  const encoded = Buffer.from(redacted, "utf8");
  if (encoded.length <= limit) return redacted;
  let end = limit - Buffer.byteLength(marker, "utf8");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  while (end > 0) {
    try {
      return `${decoder.decode(encoded.subarray(0, end))}${marker}`;
    } catch {
      end -= 1;
    }
  }
  return marker;
}

async function emitInvocationStart(reporter: ProgressReporter, context: CodexProgressContext): Promise<void> {
  const code = context.source === "brain" ? "brain_started"
    : context.source === "hands" ? "hands_started"
    : context.source === "verifier" ? (context.mode === "final_review" ? "final_verifier_started" : "verifier_started")
    : "reflection_started";
  await reporter.emit({ code, source: context.source, model: context.model, reasoningEffort: context.reasoningEffort, workItem: context.workItem });
}

async function emitValidation(reporter: ProgressReporter, context: CodexProgressContext, complete: boolean): Promise<void> {
  const code = context.source === "brain" ? (complete ? "plan_validated" : "validating_plan")
    : context.source === "hands" ? (complete ? "hands_validated" : "validating_hands")
    : context.source === "verifier" ? (complete ? "verifier_validated" : "validating_verifier")
    : context.mode === "reflection_synthesis" ? "reflection_synthesizing" : "reflection_analyzing";
  await reporter.emit({ code, source: context.source, workItem: context.workItem });
}

async function emitTurnCompleted(reporter: ProgressReporter, context: CodexProgressContext): Promise<void> {
  const code = context.source === "brain" ? "brain_turn_completed"
    : context.source === "hands" ? "hands_turn_completed"
    : context.source === "verifier" ? "verifier_turn_completed" : null;
  if (code) await reporter.emit({ code, source: context.source, workItem: context.workItem });
}
