import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { z } from "zod";
import type { CodexAdapter, CodexInvokeInput, CodexInvokeResult } from "../adapters/codex.js";
import {
  appendRunEvent,
  readManifestV2,
  readVerifiedPlanRevision,
  updateManifestV2,
  writeTextArtifact,
} from "../core/ledger.js";
import {
  artifactRefFromBytes,
  canonicalJsonBytes,
  evidenceIndexV1Schema,
  type ArtifactRefV1,
} from "../core/context-contracts.js";
import { readOwnedRunFile } from "../core/owned-evidence.js";
import { improvementPlanOutputSchema, reflectionOutputSchema } from "../core/output-schemas.js";
import { executionSpecV2Schema, improvementPlanSchema, reflectionSchema, roleProfileSchema, runIntakeSchema } from "../core/schema.js";
import type {
  ImprovementPlan,
  ReasoningEffort,
  Reflection,
  ReflectionProtocol,
  ResolvedRunIntake,
  RoleProfile,
} from "../core/types.js";
import { runCommand } from "../core/executor.js";
import { loadPromptTemplate } from "../prompts/loader.js";
import { renderTemplate } from "../prompts/renderer.js";
import type { ProgressReporter } from "../progress/log.js";
import type { ResourceBudgetPort } from "../core/resource-budget.js";
import { DEFAULT_PHASE_REASONING } from "../core/config.js";
import {
  buildReflectionEvidenceIndex,
  loadEvidenceIndex,
  reflectionEvidenceIndexPath,
} from "./evidence-index.js";
import {
  buildReflectionContext,
  loadRoleContext,
  reflectionContextPath,
} from "./role-context.js";

const processAccountSchema = z.object({
  summary: z.string().min(1),
  strengths: z.array(z.string().min(1)),
  weaknesses: z.array(z.string().min(1)),
  classifications: z.array(z.string().min(1)),
  evidence_paths: z.array(z.string().min(1)),
}).strict();

const processAccountOutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string", minLength: 1 },
    strengths: { type: "array", items: { type: "string", minLength: 1 } },
    weaknesses: { type: "array", items: { type: "string", minLength: 1 } },
    classifications: { type: "array", items: { type: "string", minLength: 1 } },
    evidence_paths: { type: "array", items: { type: "string", minLength: 1 } },
  },
  required: ["summary", "strengths", "weaknesses", "classifications", "evidence_paths"],
} as const;

export interface ReflectionRunInput {
  runDir: string;
  sourceRepo?: string;
  worktreePath?: string;
  intake?: ResolvedRunIntake;
  codex: CodexAdapter;
  progress?: ProgressReporter;
  budget?: ResourceBudgetPort;
}

export interface ReflectionRunResult {
  reflection: Reflection;
  reflectionJsonPath: string;
  reflectionMarkdownPath: string;
  reflectionPath: string;
  responsePaths: string[];
}

export interface ImprovementPlanInput {
  reflectionPath: string;
  sourceRepo: string;
  codex: CodexAdapter;
  intake?: Pick<ResolvedRunIntake, "roles">;
  brainModel?: string;
  reasoningEffort?: ReasoningEffort;
}

export interface ImprovementPlanResult {
  plan: ImprovementPlan;
  jsonPath: string;
  markdownPath: string;
  improvementPlanJsonPath: string;
  improvementPlanMarkdownPath: string;
  message: string;
}

interface RunIntakeWithRoles extends ResolvedRunIntake {
  roles: ResolvedRunIntake["roles"];
}

const MAX_FILE_BYTES = 24_000;
const MAX_CONTEXT_BYTES = 100_000;

function parseResult<T>(result: CodexInvokeResult, schema: z.ZodType<T>, label: string): T {
  if (result.exitCode !== 0) {
    throw new Error(`${label} failed with exit code ${result.exitCode ?? "null"}`);
  }
  const value = result.parsed ?? (() => {
    try {
      return JSON.parse(result.text) as unknown;
    } catch (error) {
      throw new Error(`${label} did not return JSON`, { cause: error });
    }
  })();
  return schema.parse(value);
}

function asResolvedIntake(value: unknown): ResolvedRunIntake {
  let intakeValue = value;
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const reviewPolicy = (value as Record<string, unknown>).review_policy;
    if (reviewPolicy !== null && typeof reviewPolicy === "object" && !Array.isArray(reviewPolicy)) {
      const persistedPolicy = { ...reviewPolicy } as Record<string, unknown>;
      delete persistedPolicy.policy_revision;
      intakeValue = { ...value, review_policy: persistedPolicy };
    }
  }
  const parsed = runIntakeSchema.parse(intakeValue);
  if (parsed.mode === undefined || parsed.research === undefined || parsed.reflection === undefined) {
    throw new Error("mode, research, and reflection must be resolved before reflection");
  }
  const raw = value as Partial<RunIntakeWithRoles> & {
    resolved_models?: Partial<Record<"brain" | "hands" | "verifier", unknown>>;
  };
  const roles = z.object({
    brain: roleProfileSchema,
    hands: roleProfileSchema,
    verifier: roleProfileSchema,
  }).strict().parse(raw.roles);
  const resolvedModels = z.object({
    brain: z.string().min(1),
    hands: z.string().min(1),
    verifier: z.string().min(1),
  }).strict().parse(raw.resolved_models);
  return {
    ...parsed,
    ...raw,
    roles,
    resolved_models: resolvedModels,
    phase_reasoning: raw.phase_reasoning ?? DEFAULT_PHASE_REASONING,
  } as ResolvedRunIntake;
}

async function loadReflectionIntake(runDir: string, input?: ResolvedRunIntake): Promise<ResolvedRunIntake> {
  if (input) return asResolvedIntake(input);
  const raw = JSON.parse(await readFile(join(runDir, "intake.json"), "utf8")) as unknown;
  return asResolvedIntake(raw);
}

async function readCapped(path: string): Promise<string> {
  try {
    const content = await readFile(path, "utf8");
    return content.length > MAX_FILE_BYTES
      ? `${content.slice(0, MAX_FILE_BYTES)}\n[content truncated]`
      : content;
  } catch (error) {
    return `[unavailable: ${error instanceof Error ? error.message : String(error)}]`;
  }
}

async function listFiles(root: string, prefix = "", excludedDirectories = new Set<string>()): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(join(root, prefix), { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const child = prefix ? join(prefix, entry.name) : entry.name;
    if (entry.isDirectory()) {
      if (excludedDirectories.has(entry.name)) continue;
      files.push(...await listFiles(root, child, excludedDirectories));
    }
    else files.push(child);
  }
  return files;
}

async function runLedgerContext(runDir: string, sourceRepo: string, manifest: Awaited<ReturnType<typeof readManifestV2>>): Promise<string> {
  const files = (await listFiles(runDir))
    .filter((path) => path !== "manifest.json" && path !== "events.jsonl")
    .sort();
  const artifacts: Array<{ path: string; content: string }> = [];
  let size = 0;
  for (const path of files) {
    if (size >= MAX_CONTEXT_BYTES) break;
    const content = await readCapped(join(runDir, path));
    artifacts.push({ path, content });
    size += content.length + path.length;
  }
  const git = await runCommand({
    command: "git",
    args: ["log", "-20", "--oneline", "--decorate=no"],
    cwd: sourceRepo,
    timeoutMs: 15_000,
  });
  const events = await readCapped(join(runDir, "events.jsonl"));
  return JSON.stringify({
    original_request: manifest.original_request,
    approved_plan_revisions: manifest.approved_plan_revision === null
      ? []
      : [manifest.plan_revisions[String(manifest.approved_plan_revision)]],
    hands_reports: artifacts.filter((entry) => entry.path.startsWith("implementation/")),
    verification_evidence: artifacts.filter((entry) => entry.path.startsWith("verification/")),
    verifier_findings: artifacts.filter((entry) => entry.path.startsWith("reviews/")),
    retry_history: manifest.retry_counts,
    git_history: { exit_code: git.exitCode, stdout: git.stdout, stderr: git.stderr },
    delivery_result: {
      stage: manifest.stage,
      delivery_state: manifest.delivery_state,
      terminal: manifest.terminal ?? (manifest.stage === "complete" ? {
        outcome: "delivered",
        actor: "runtime",
        reason: "Legacy completed run",
        recorded_at: manifest.updated_at,
        source_stage: "complete",
        residual_risks: [],
      } : null),
      last_blocker: manifest.last_blocker,
      issue_numbers: manifest.issue_numbers,
      pull_request_numbers: manifest.pull_request_numbers,
      final_artifact_paths: manifest.final_artifact_paths,
    },
    events,
    artifacts,
  }, null, 2);
}

function accountPrompt(
  role: "brain" | "hands",
  context: string,
  template: string,
  contextAuthority?: { context_ref: ArtifactRefV1; evidence_index_ref: ArtifactRefV1 },
): string {
  const roleFocus = role === "brain"
    ? "Focus on Brain's planning/research quality: requirement interpretation, assumptions, research coverage, plan clarity, and decision quality."
    : "Focus on Hands' implementation/verification quality: following the approved scope, code changes, test execution, evidence quality, and response to verifier findings.";
  return renderTemplate(template, {
    account_role: role,
    role_focus: roleFocus,
    process_context: context,
    ...(contextAuthority ? { process_context_ref: JSON.stringify(contextAuthority, null, 2) } : {}),
  });
}

async function invokeIsolatedReflectionRole(
  codex: CodexAdapter,
  input: CodexInvokeInput,
): Promise<CodexInvokeResult> {
  const cwd = await mkdtemp(join(tmpdir(), "brain-hands-reflection-codex-"));
  try {
    return await codex.invoke({ ...input, cwd, skipGitRepoCheck: true });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

async function loadPersistedReflectionResponse<T>(
  runDir: string,
  artifactName: string,
  schema: z.ZodType<T>,
): Promise<T | null> {
  try {
    return schema.parse(JSON.parse(await readFile(join(runDir, "responses", `${artifactName}.json`), "utf8")));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw new Error(`Persisted reflection response is invalid: responses/${artifactName}.json`, { cause: error });
  }
}

function reflectionMarkdown(reflection: Reflection, accounts: Array<{ role: string; account: z.infer<typeof processAccountSchema> }>): string {
  const processAccountSection = accounts.length === 0
    ? []
    : [
        "## Process accounts",
        ...accounts.map(({ role, account }) => [
          `### ${role}`,
          "",
          account.summary,
          "",
          `Strengths: ${account.strengths.join("; ")}`,
          `Weaknesses: ${account.weaknesses.join("; ")}`,
          `Classifications: ${account.classifications.join("; ")}`,
        ].join("\n")),
      ];
  const sections = [
    "# Process reflection",
    "",
    `## Outcome\n\n${reflection.outcome_summary}`,
    `## What worked\n\n${reflection.what_worked.map((entry) => `- ${entry}`).join("\n")}`,
    `## What was correct\n\n${reflection.what_was_correct.map((entry) => `- ${entry}`).join("\n")}`,
    `## What failed\n\n${reflection.what_failed.map((entry) => `- ${entry}`).join("\n")}`,
    `## Root causes\n\n${reflection.root_causes.map((entry) => `- ${entry}`).join("\n")}`,
    `## Avoidable rework\n\n${reflection.avoidable_rework.map((entry) => `- ${entry}`).join("\n")}`,
    `## Process improvements\n\n${reflection.process_improvements.map((entry) => `- ${entry}`).join("\n")}`,
    `## Improvements\n\n${reflection.improvements.map((entry) => `- ${entry}`).join("\n")}`,
    "## Classifications",
    ...Object.entries(reflection.classifications).map(([category, entries]) => `### ${category}\n\n${(entries as string[]).map((entry) => `- ${entry}`).join("\n")}`),
    `## Candidate regression tests\n\n${reflection.candidate_regression_tests.map((entry) => `- ${entry}`).join("\n")}`,
    `## Evidence paths\n\n${reflection.evidence_paths.map((entry) => `- ${entry}`).join("\n")}`,
    ...processAccountSection,
    "",
    "## Structured reflection",
    "",
    "```json",
    JSON.stringify(reflection, null, 2),
    "```",
    "",
  ];
  return sections.join("\n");
}

function reflectionProtocol(manifest: Awaited<ReturnType<typeof readManifestV2>>): ReflectionProtocol {
  return manifest.reflection_protocol ?? "role-accounts-v1";
}

function isBoundedReflectionAuthorityPath(path: string): boolean {
  return path === reflectionEvidenceIndexPath || path === reflectionContextPath;
}

function reflectionFinalArtifactPaths(
  manifest: Awaited<ReturnType<typeof readManifestV2>>,
  protocol: ReflectionProtocol,
  responsePaths: string[],
): string[] {
  const basePaths = protocol === "single-pass-v1"
    ? manifest.final_artifact_paths.filter((path) => !isBoundedReflectionAuthorityPath(path))
    : manifest.final_artifact_paths;
  return [...new Set([...basePaths, "reflection.json", "reflection.md", ...responsePaths])];
}

async function existingReflectionResponsePaths(
  runDir: string,
  manifest: Awaited<ReturnType<typeof readManifestV2>>,
  protocol: ReflectionProtocol,
): Promise<string[]> {
  if (protocol !== "single-pass-v1") {
    return manifest.final_artifact_paths.filter((path) =>
      path.startsWith("responses/reflection-") && path.endsWith(".json"));
  }
  const path = "responses/reflection-synthesis.json";
  return await ownedArtifactExists(runDir, path) ? [path] : [];
}

async function ownedArtifactExists(runDir: string, path: string): Promise<boolean> {
  try {
    await readOwnedRunFile(runDir, path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function assertReflectionProtocolBoundary(
  runDir: string,
  manifest: Awaited<ReturnType<typeof readManifestV2>>,
): Promise<void> {
  if (manifest.workflow_protocol === "bounded-context-v1") return;
  if (
    manifest.reflection_index_path !== null
    || manifest.final_artifact_paths.includes(reflectionEvidenceIndexPath)
    || manifest.final_artifact_paths.includes(reflectionContextPath)
    || await ownedArtifactExists(runDir, reflectionEvidenceIndexPath)
    || await ownedArtifactExists(runDir, reflectionContextPath)
  ) {
    throw new Error("Legacy Reflection cannot consume mixed bounded Reflection authority");
  }
}

async function publishBoundedReflectionIndex(runDir: string): Promise<void> {
  const manifest = await readManifestV2(runDir);
  if (manifest.workflow_protocol !== "bounded-context-v1") {
    throw new Error("Bounded Reflection index publication requires bounded-context-v1");
  }
  if (manifest.reflection_index_path !== null && manifest.reflection_index_path !== reflectionEvidenceIndexPath) {
    throw new Error("Bounded Reflection index pointer is not canonical authority");
  }
  const revision = manifest.approved_revision ?? manifest.approved_plan_revision;
  if (
    revision === null
    || manifest.approved_revision !== revision
    || manifest.approved_plan_revision !== revision
  ) throw new Error("Reflection evidence index requires matching approved-plan pointers");
  const plan = JSON.parse(await readVerifiedPlanRevision(runDir, manifest, revision)) as { work_items?: unknown };
  if (!Array.isArray(plan.work_items)) throw new Error("Reflection evidence index requires structured approved work items");
  const workItems = plan.work_items.map((entry) => executionSpecV2Schema.parse(entry)).filter((entry) => entry.id !== "integrated");
  const workItemSummaryRefs: ArtifactRefV1[] = workItems.map((workItem) => {
    const progress = manifest.work_item_progress[workItem.id];
    if (
      progress?.status !== "complete"
      || typeof progress.summary_path !== "string"
      || typeof progress.summary_sha256 !== "string"
    ) throw new Error(`Reflection evidence index requires the current summary for ${workItem.id}`);
    return { path: progress.summary_path, sha256: progress.summary_sha256 };
  });
  const integrated = manifest.work_item_progress.integrated;
  if (
    !integrated
    || !Number.isInteger(integrated.attempts)
    || integrated.attempts < 1
    || typeof integrated.commit_sha !== "string"
    || typeof integrated.verification_path !== "string"
    || typeof integrated.review_path !== "string"
  ) throw new Error("Reflection evidence index requires exact integrated verification and review pointers");
  const reference = async (path: string): Promise<ArtifactRefV1> =>
    artifactRefFromBytes(path, await readOwnedRunFile(runDir, path));
  const integratedVerificationRef = await reference(integrated.verification_path);
  const finalReviewRef = await reference(integrated.review_path);
  await buildReflectionEvidenceIndex({
    runDir,
    attempt: integrated.attempts,
    candidateCommit: integrated.commit_sha,
    workItemSummaryRefs,
    integratedVerificationRef,
    finalReviewRef,
  });
  await updateManifestV2(runDir, {
    reflection_index_path: reflectionEvidenceIndexPath,
    final_artifact_paths: [...new Set([...manifest.final_artifact_paths, reflectionEvidenceIndexPath])],
  });
}

function boundedReflectionProcessMetrics(manifest: Awaited<ReturnType<typeof readManifestV2>>): unknown {
  return {
    retry_counts: manifest.retry_counts,
    review_accounting: manifest.review_accounting ?? null,
    budget_usage: null,
    terminal_disposition: manifest.terminal,
    delivery_identifiers: {
      delivery_state: manifest.delivery_state,
      assurance_outcome: manifest.assurance_outcome,
      issue_numbers: manifest.github_ids.issue_numbers,
      pull_request_numbers: manifest.github_ids.pull_request_numbers,
      pull_request_urls: manifest.github_ids.pull_request_urls,
    },
  };
}

interface BoundedReflectionAuthority {
  indexRef: ArtifactRefV1;
  contextRef: ArtifactRefV1;
  contextJson: string;
}

async function loadPublishedReflectionIndex(
  runDir: string,
): Promise<{ manifest: Awaited<ReturnType<typeof readManifestV2>>; ref: ArtifactRefV1 }> {
  const manifest = await readManifestV2(runDir);
  if (manifest.workflow_protocol !== "bounded-context-v1") {
    throw new Error("Published Reflection index authority requires bounded-context-v1");
  }
  if (manifest.reflection_index_path !== reflectionEvidenceIndexPath) {
    throw new Error("Manifest Reflection index pointer is not canonical authority");
  }
  if (!manifest.final_artifact_paths.includes(reflectionEvidenceIndexPath)) {
    throw new Error("Manifest is missing the published Reflection index artifact");
  }
  const bytes = await readOwnedRunFile(runDir, reflectionEvidenceIndexPath);
  const ref = artifactRefFromBytes(reflectionEvidenceIndexPath, bytes);
  const index = evidenceIndexV1Schema.parse(JSON.parse(bytes.toString("utf8")) as unknown);
  if (index.phase !== "reflection") throw new Error("Published Reflection index has the wrong phase");
  await loadEvidenceIndex(runDir, ref, {
    phase: "reflection",
    attempt: index.attempt,
    candidateCommit: index.candidate_commit,
  });
  return { manifest, ref };
}

async function loadPublishedReflectionContext(runDir: string): Promise<BoundedReflectionAuthority> {
  const before = await loadPublishedReflectionIndex(runDir);
  if (!before.manifest.final_artifact_paths.includes(reflectionContextPath)) {
    throw new Error("Manifest is missing the published Reflection context artifact");
  }
  const contextBytes = await readOwnedRunFile(runDir, reflectionContextPath);
  const contextRef = artifactRefFromBytes(reflectionContextPath, contextBytes);
  const context = await loadRoleContext(runDir, contextRef, "reflection");
  const embeddedIndexRef = artifactRefFromBytes(
    reflectionEvidenceIndexPath,
    canonicalJsonBytes(evidenceIndexV1Schema, context.evidence_index),
  );
  if (
    embeddedIndexRef.path !== before.ref.path
    || embeddedIndexRef.sha256 !== before.ref.sha256
  ) throw new Error("Published Reflection context embeds stale index authority");
  if (JSON.stringify(context.process_metrics) !== JSON.stringify(boundedReflectionProcessMetrics(before.manifest))) {
    throw new Error("Published Reflection context has stale process metrics");
  }
  const after = await loadPublishedReflectionIndex(runDir);
  if (after.ref.sha256 !== before.ref.sha256) {
    throw new Error("Reflection index authority changed while loading its context");
  }
  return {
    indexRef: after.ref,
    contextRef,
    contextJson: JSON.stringify(context, null, 2),
  };
}

function sameBoundedReflectionAuthority(
  expected: BoundedReflectionAuthority,
  actual: BoundedReflectionAuthority,
): boolean {
  return expected.indexRef.path === actual.indexRef.path
    && expected.indexRef.sha256 === actual.indexRef.sha256
    && expected.contextRef.path === actual.contextRef.path
    && expected.contextRef.sha256 === actual.contextRef.sha256
    && expected.contextJson === actual.contextJson;
}

async function assertBoundedReflectionAuthorityUnchanged(
  runDir: string,
  expected: BoundedReflectionAuthority,
): Promise<BoundedReflectionAuthority> {
  const actual = await loadPublishedReflectionContext(runDir);
  if (!sameBoundedReflectionAuthority(expected, actual)) {
    throw new Error("Bounded Reflection authority changed before model invocation");
  }
  return actual;
}

async function buildPublishedReflectionContext(
  runDir: string,
  evidenceIndexRef: ArtifactRefV1,
  manifest: Awaited<ReturnType<typeof readManifestV2>>,
): Promise<BoundedReflectionAuthority> {
  await buildReflectionContext({
    runDir,
    evidenceIndexRef,
    processMetrics: boundedReflectionProcessMetrics(manifest),
  });
  const current = await readManifestV2(runDir);
  if (
    current.workflow_protocol !== "bounded-context-v1"
    || current.reflection_index_path !== reflectionEvidenceIndexPath
  ) throw new Error("Reflection index authority changed before context publication");
  if (!current.final_artifact_paths.includes(reflectionContextPath)) {
    await updateManifestV2(runDir, {
      final_artifact_paths: [...new Set([...current.final_artifact_paths, reflectionContextPath])],
    });
  }
  return loadPublishedReflectionContext(runDir);
}

/** Analyze a completed run without changing product source or run completion state. */
export async function runReflection(input: ReflectionRunInput): Promise<ReflectionRunResult> {
  let manifest = await readManifestV2(input.runDir);
  if (manifest.terminal === null && manifest.stage !== "complete") {
    throw new Error("Reflection requires a terminal ledger");
  }
  const intake = await loadReflectionIntake(input.runDir, input.intake);
  if (intake.reflection !== true) throw new Error("Reflection is not enabled for this run");
  let protocol = reflectionProtocol(manifest);
  if (protocol === "single-pass-v1" && manifest.workflow_protocol !== "bounded-context-v1") {
    throw new Error("Single-pass Reflection requires bounded-context-v1 authority");
  }
  await assertReflectionProtocolBoundary(input.runDir, manifest);
  let existingReflection: Reflection | null = null;
  try {
    existingReflection = reflectionSchema.parse(JSON.parse(await readFile(join(input.runDir, "reflection.json"), "utf8")));
    await readFile(join(input.runDir, "reflection.md"), "utf8");
  } catch {
    existingReflection = null;
  }
  let boundedAuthority: BoundedReflectionAuthority | null = null;
  if (manifest.workflow_protocol === "bounded-context-v1") {
    if (existingReflection === null) {
      await publishBoundedReflectionIndex(input.runDir);
      const published = await loadPublishedReflectionIndex(input.runDir);
      if (published.manifest.final_artifact_paths.includes(reflectionContextPath)) {
        boundedAuthority = await loadPublishedReflectionContext(input.runDir);
      } else {
        if (await ownedArtifactExists(input.runDir, reflectionContextPath)) {
          throw new Error("Reflection context exists without published manifest authority");
        }
        boundedAuthority = await buildPublishedReflectionContext(input.runDir, published.ref, published.manifest);
      }
    } else if (protocol !== "single-pass-v1") {
      boundedAuthority = await loadPublishedReflectionContext(input.runDir);
    }
    manifest = await readManifestV2(input.runDir);
  }
  if (existingReflection !== null) {
    const responsePaths = await existingReflectionResponsePaths(input.runDir, manifest, protocol);
    const finalArtifactPaths = reflectionFinalArtifactPaths(manifest, protocol, responsePaths);
    if (JSON.stringify(finalArtifactPaths) !== JSON.stringify(manifest.final_artifact_paths)) {
      await updateManifestV2(input.runDir, { final_artifact_paths: finalArtifactPaths });
    }
    const events = (await readFile(join(input.runDir, "events.jsonl"), "utf8"))
      .split("\n").filter(Boolean).flatMap((line) => {
        try { return [JSON.parse(line) as { type?: unknown }]; } catch { return []; }
      });
    if (!events.some((event) => event.type === "reflection_completed")) {
      await appendRunEvent(input.runDir, {
        actor: "brain",
        stage: manifest.stage,
        type: "reflection_completed",
        payload: { reflection_path: "reflection.json", recovered: true },
      });
    }
    await input.progress?.emit({ code: "reflection_recorded", source: "reflection" });
    return {
      reflection: existingReflection,
      reflectionJsonPath: join(input.runDir, "reflection.json"),
      reflectionMarkdownPath: join(input.runDir, "reflection.md"),
      reflectionPath: join(input.runDir, "reflection.json"),
      responsePaths,
    };
  }
  await input.progress?.emit({ code: "reflection_started", source: "reflection" });
  const bounded = manifest.workflow_protocol === "bounded-context-v1";
  if (bounded !== (boundedAuthority !== null)) {
    throw new Error("Reflection protocol and terminal evidence-index authority do not match");
  }
  if (boundedAuthority) {
    boundedAuthority = await assertBoundedReflectionAuthorityUnchanged(input.runDir, boundedAuthority);
  }
  protocol = reflectionProtocol(manifest);
  const context = boundedAuthority?.contextJson ?? await runLedgerContext(
    input.runDir,
    resolve(input.sourceRepo ?? manifest.repo_root),
    manifest,
  );
  if (protocol === "single-pass-v1") {
    if (!boundedAuthority) throw new Error("Single-pass Reflection requires immutable bounded authority");
    const profile = {
      ...intake.roles.brain,
      reasoning_effort: (intake.phase_reasoning ?? DEFAULT_PHASE_REASONING).reflection,
    };
    const synthesisName = "reflection-synthesis";
    const template = await loadPromptTemplate("reflection-single-pass-v1");
    const prompt = renderTemplate(template, {
      process_context: context,
      process_context_ref: JSON.stringify({
        context_ref: boundedAuthority.contextRef,
        evidence_index_ref: boundedAuthority.indexRef,
      }, null, 2),
    });
    await writeTextArtifact(input.runDir, `prompts/${synthesisName}.md`, prompt);
    await writeTextArtifact(input.runDir, `schemas/${synthesisName}.json`, `${JSON.stringify(reflectionOutputSchema, null, 2)}\n`);
    let result = await loadPersistedReflectionResponse(input.runDir, synthesisName, reflectionSchema);
    if (result === null) {
      boundedAuthority = await assertBoundedReflectionAuthorityUnchanged(input.runDir, boundedAuthority);
      const synthesis = await invokeIsolatedReflectionRole(input.codex, {
        role: "brain",
        model: profile.model,
        reasoningEffort: profile.reasoning_effort,
        sandbox: "read-only",
        prompt,
        runDir: input.runDir,
        artifactName: synthesisName,
        budget: input.budget,
        outputSchema: reflectionOutputSchema,
        outputParser: reflectionSchema,
        progress: input.progress ? { reporter: input.progress, context: { source: "reflection", mode: "reflection_synthesis", model: profile.model, reasoningEffort: profile.reasoning_effort } } : undefined,
      });
      result = parseResult(synthesis, reflectionSchema, "Reflection synthesis");
      await writeTextArtifact(input.runDir, `responses/${synthesisName}.json`, `${JSON.stringify(result, null, 2)}\n`);
    }
    const responsePaths = [`responses/${synthesisName}.json`];
    const reflectionJsonPath = await writeTextArtifact(input.runDir, "reflection.json", `${JSON.stringify(result, null, 2)}\n`);
    const reflectionMarkdownPath = await writeTextArtifact(input.runDir, "reflection.md", reflectionMarkdown(result, []));
    await updateManifestV2(input.runDir, {
      final_artifact_paths: reflectionFinalArtifactPaths(manifest, protocol, responsePaths),
    });
    await appendRunEvent(input.runDir, {
      actor: "brain",
      stage: manifest.stage,
      type: "reflection_completed",
      payload: { reflection_path: relative(resolve(input.runDir), resolve(reflectionJsonPath)) },
    });
    await input.progress?.emit({ code: "reflection_recorded", source: "reflection" });
    return {
      reflection: result,
      reflectionJsonPath,
      reflectionMarkdownPath,
      reflectionPath: reflectionJsonPath,
      responsePaths,
    };
  }
  const template = await loadPromptTemplate(bounded ? "reflection-v2" : "reflection-legacy-v2");
  const responsePaths: string[] = [];
  const accounts: Array<{ role: "brain" | "hands"; account: z.infer<typeof processAccountSchema> }> = [];
  await input.progress?.emit({ code: "reflection_started", source: "reflection" });

  for (const role of ["brain", "hands"] as const) {
    if (boundedAuthority) {
      boundedAuthority = await assertBoundedReflectionAuthorityUnchanged(input.runDir, boundedAuthority);
    }
    const profile = intake.roles[role];
    const artifactName = `reflection-${role}-account`;
    const prompt = accountPrompt(role, context, template, boundedAuthority ? {
      context_ref: boundedAuthority.contextRef,
      evidence_index_ref: boundedAuthority.indexRef,
    } : undefined);
    await writeTextArtifact(input.runDir, `prompts/${artifactName}.md`, prompt);
    await writeTextArtifact(input.runDir, `schemas/${artifactName}.json`, `${JSON.stringify(processAccountOutputSchema, null, 2)}\n`);
    let account = await loadPersistedReflectionResponse(input.runDir, artifactName, processAccountSchema);
    if (account === null) {
      const result = await invokeIsolatedReflectionRole(input.codex, {
        role,
        model: profile.model,
        reasoningEffort: profile.reasoning_effort,
        sandbox: "read-only",
        prompt,
        runDir: input.runDir,
        artifactName,
        budget: input.budget,
        outputSchema: processAccountOutputSchema,
        outputParser: processAccountSchema,
        progress: input.progress ? { reporter: input.progress, context: { source: "reflection", mode: "reflection_account", model: profile.model, reasoningEffort: profile.reasoning_effort } } : undefined,
      });
      account = parseResult(result, processAccountSchema, `${role} reflection account`);
      await writeTextArtifact(input.runDir, `responses/${artifactName}.json`, `${JSON.stringify(account, null, 2)}\n`);
    }
    responsePaths.push(`responses/${artifactName}.json`);
    accounts.push({ role, account });
  }

  const synthesisProfile = intake.roles.brain;
  if (boundedAuthority) {
    boundedAuthority = await assertBoundedReflectionAuthorityUnchanged(input.runDir, boundedAuthority);
  }
  const synthesisTemplate = await loadPromptTemplate(
    bounded ? "reflection-synthesis-v2" : "reflection-synthesis-legacy-v2",
  );
  const synthesisPrompt = renderTemplate(synthesisTemplate, {
    process_context: context,
    process_accounts: JSON.stringify(accounts, null, 2),
    ...(boundedAuthority ? {
      process_context_ref: JSON.stringify({
        context_ref: boundedAuthority.contextRef,
        evidence_index_ref: boundedAuthority.indexRef,
      }, null, 2),
    } : {}),
  });
  const synthesisName = "reflection-synthesis";
  await writeTextArtifact(input.runDir, `prompts/${synthesisName}.md`, synthesisPrompt);
  await writeTextArtifact(input.runDir, `schemas/${synthesisName}.json`, `${JSON.stringify(reflectionOutputSchema, null, 2)}\n`);
  let result = await loadPersistedReflectionResponse(input.runDir, synthesisName, reflectionSchema);
  if (result === null) {
    const synthesis = await invokeIsolatedReflectionRole(input.codex, {
      role: "brain",
      model: synthesisProfile.model,
      reasoningEffort: synthesisProfile.reasoning_effort,
      sandbox: "read-only",
      prompt: synthesisPrompt,
      runDir: input.runDir,
      artifactName: synthesisName,
      budget: input.budget,
      outputSchema: reflectionOutputSchema,
      outputParser: reflectionSchema,
      progress: input.progress ? { reporter: input.progress, context: { source: "reflection", mode: "reflection_synthesis", model: synthesisProfile.model, reasoningEffort: synthesisProfile.reasoning_effort } } : undefined,
    });
    result = parseResult(synthesis, reflectionSchema, "Reflection synthesis");
    await writeTextArtifact(input.runDir, `responses/${synthesisName}.json`, `${JSON.stringify(result, null, 2)}\n`);
  }
  responsePaths.push(`responses/${synthesisName}.json`);

  const reflectionJsonPath = await writeTextArtifact(input.runDir, "reflection.json", `${JSON.stringify(result, null, 2)}\n`);
  const reflectionMarkdownPath = await writeTextArtifact(input.runDir, "reflection.md", reflectionMarkdown(result, accounts));
  await updateManifestV2(input.runDir, {
    final_artifact_paths: reflectionFinalArtifactPaths(manifest, protocol, responsePaths),
  });
  await appendRunEvent(input.runDir, {
    actor: "brain",
    stage: manifest.stage,
    type: "reflection_completed",
    payload: { reflection_path: relative(resolve(input.runDir), resolve(reflectionJsonPath)) },
  });
  await input.progress?.emit({ code: "reflection_recorded", source: "reflection" });
  return {
    reflection: result,
    reflectionJsonPath,
    reflectionMarkdownPath,
    reflectionPath: reflectionJsonPath,
    responsePaths,
  };
}

function extractJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
    if (fenced) return JSON.parse(fenced) as unknown;
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1)) as unknown;
    throw new Error("Reflection artifact does not contain JSON");
  }
}

async function sourceContext(sourceRepo: string): Promise<string> {
  const git = await runCommand({ command: "git", args: ["status", "--short"], cwd: sourceRepo, timeoutMs: 15_000 });
  const log = await runCommand({ command: "git", args: ["log", "-20", "--oneline", "--decorate=no"], cwd: sourceRepo, timeoutMs: 15_000 });
  const files = (await listFiles(sourceRepo, "", new Set([".git", ".brain-hands"]))).sort().slice(0, 200);
  const sourceFiles: Array<{ path: string; content: string }> = [];
  let sourceBytes = 0;
  for (const path of files) {
    if (sourceBytes >= MAX_CONTEXT_BYTES / 2) break;
    if (!/\.(?:ts|tsx|js|mjs|json|md|yml|yaml|toml)$/i.test(path)) continue;
    const content = await readCapped(join(sourceRepo, path));
    sourceFiles.push({ path, content });
    sourceBytes += path.length + content.length;
  }
  return JSON.stringify({ files, source_files: sourceFiles, git_status: git.stdout, git_status_error: git.stderr, git_history: log.stdout }, null, 2);
}

function improvementMarkdown(plan: ImprovementPlan): string {
  const list = (values: string[]) => values.map((value) => `- ${value}`).join("\n");
  return [
    "# Improvement plan",
    "",
    `Reflection source: ${plan.reflection_source}`,
    "",
    "## Observed problems\n\n" + list(plan.observed_problem),
    "## Evidence\n\n" + list(plan.evidence),
    "## Recommended changes\n\n" + list(plan.recommended_changes),
    "## Expected benefits\n\n" + list(plan.expected_benefits),
    "## Implementation sequence\n\n" + list(plan.implementation_sequence),
    "## Tests and acceptance criteria\n\n" + list(plan.tests_and_acceptance_criteria),
    "## Risks\n\n" + list(plan.risks),
    "## Out of scope\n\n" + list(plan.out_of_scope),
    "",
    "This artifact is analysis-only. A separate task is required to implement it.",
    "",
    "```json",
    JSON.stringify(plan, null, 2),
    "```",
    "",
  ].join("\n");
}

async function createPlanDirectory(sourceRepo: string): Promise<string> {
  const base = join(sourceRepo, ".brain-hands", "improvement-plans");
  await mkdir(base, { recursive: true });
  const stamp = new Date().toISOString().replace(/[.:]/g, "-");
  for (let suffix = 0; suffix < 100; suffix += 1) {
    const path = join(base, suffix === 0 ? stamp : `${stamp}-${suffix + 1}`);
    try {
      await mkdir(path);
      return path;
    } catch (error: unknown) {
      if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") continue;
      throw error;
    }
  }
  throw new Error("Could not allocate a unique improvement-plan directory");
}

/** Generate a standalone improvement plan and stop; no Hands or implementation is invoked. */
export async function planFromReflection(input: ImprovementPlanInput): Promise<ImprovementPlanResult> {
  const reflectionText = await readFile(input.reflectionPath, "utf8");
  let reflection: Reflection;
  try {
    reflection = reflectionSchema.parse(extractJson(reflectionText));
  } catch (error) {
    throw new Error(`Reflection artifact is not a valid Reflection: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  const sourceRepo = resolve(input.sourceRepo);
  const context = await sourceContext(sourceRepo);
  const profile: RoleProfile = input.intake?.roles.brain ?? {
    model: input.brainModel ?? "brain",
    reasoning_effort: input.reasoningEffort ?? "high",
    sandbox: "read-only",
  };
  const template = await loadPromptTemplate("improvement-plan-v2");
  const prompt = renderTemplate(template, {
    reflection_json: JSON.stringify(reflection, null, 2),
    source_context: context,
  });
  const artifactName = "improvement-plan-analysis";
  const outputSchema = improvementPlanOutputSchema;
  const outputParser = improvementPlanSchema;
  const analysisDir = await createPlanDirectory(sourceRepo);
  const analysisRunDir = join(analysisDir, "codex-artifacts");
  await mkdir(analysisRunDir, { recursive: true });
  const invocation = await input.codex.invoke({
    role: "brain",
    model: profile.model,
    reasoningEffort: profile.reasoning_effort,
    sandbox: "read-only",
    cwd: sourceRepo,
    prompt,
    runDir: analysisRunDir,
    artifactName,
    outputSchema,
    outputParser,
  });
  const plan = parseResult(invocation, improvementPlanSchema, "Improvement-plan analysis");
  const jsonPath = join(analysisDir, "improvement-plan.json");
  const markdownPath = join(analysisDir, "improvement-plan.md");
  await writeFile(jsonPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, improvementMarkdown(plan), "utf8");
  return {
    plan,
    jsonPath,
    markdownPath,
    improvementPlanJsonPath: jsonPath,
    improvementPlanMarkdownPath: markdownPath,
    message: `Improvement plan written to ${markdownPath}. A separate task is required to implement it; this command stops without invoking Hands or changing source files.`,
  };
}

export const generateReflection = runReflection;
export const generateImprovementPlan = planFromReflection;
