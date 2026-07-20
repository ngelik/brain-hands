import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { defaultConfig, loadConfig } from "../core/config.js";
import { captureControllerProvenance } from "../core/controller-provenance.js";
import { resolveRunIntake } from "../core/intake.js";
import { preflightCheckSchema, preflightResultSchema } from "../core/schema.js";
import {
  appendRunEvent,
  createRunLedgerV2,
  readManifestV2,
  transitionRun,
  writeTextArtifact,
  type RunLedgerV2,
} from "../core/ledger.js";
import {
  resolveRunConfiguration,
  type ResolvedRunConfiguration,
} from "../core/run-configuration.js";
import type {
  ConfigV2,
  ResolvedRunIntake,
  RoleName,
  RunManifestV2,
  RunMode,
  TaskLineageV1,
} from "../core/types.js";
import { runPreflight, type RunPreflightReport } from "./preflight.js";
import { releaseRehearsalPreflight, type ReleaseRehearsalScenario } from "../testing/release-rehearsal.js";

export interface FreshRunChoices {
  mode: RunMode;
  research: boolean;
  reflection: boolean;
  model_overrides: Partial<Record<RoleName, string>>;
}

export interface PrepareFreshRunInput {
  task: string;
  repoRoot: string;
  choices: FreshRunChoices;
  dryRun: boolean;
  reservedRunId?: string;
  taskLineage?: TaskLineageV1;
  onLedgerCreated?: (ledger: RunLedgerV2) => void | Promise<void>;
}

export interface PreparedFreshRun {
  ledger: RunLedgerV2;
  intake: ResolvedRunIntake;
  config: ConfigV2;
  run_configuration: ResolvedRunConfiguration;
}

function slugifyTask(task: string): string {
  const slug = task
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug || "workflow-run";
}

async function loadFreshRunConfig(repoRoot: string, dryRun: boolean): Promise<ConfigV2> {
  try {
    return await loadConfig(repoRoot) as unknown as ConfigV2;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      if (dryRun) return defaultConfig() as unknown as ConfigV2;
      throw new Error(`Brain Hands is not initialized in ${repoRoot}.\nRun: brain-hands init --repo ${repoRoot}`);
    }
    throw error;
  }
}

export async function prepareFreshRun(input: PrepareFreshRunInput): Promise<PreparedFreshRun> {
  const config = await loadFreshRunConfig(input.repoRoot, input.dryRun);
  const controller = await captureControllerProvenance(input.repoRoot, { dryRun: input.dryRun });
  const intake = resolveRunIntake({
    task: input.task,
    repo_root: input.repoRoot,
    mode: input.choices.mode,
    research: input.choices.research,
    reflection: input.choices.reflection,
    brain_model: input.choices.model_overrides.brain,
    hands_model: input.choices.model_overrides.hands,
    verifier_model: input.choices.model_overrides.verifier,
    quality_gate: config.retry_policy.quality_gate
      ? { ...config.retry_policy.quality_gate }
      : undefined,
    hands_backup: config.retry_policy.backup
      ? { ...config.retry_policy.backup, profile: { ...config.retry_policy.backup.profile } }
      : undefined,
  }, config);
  const runConfiguration = resolveRunConfiguration({
    intake,
    config,
    controller: controller.provenance,
    overrides: input.choices.model_overrides,
  });
  const ledger = await createRunLedgerV2({
    repoRoot: input.repoRoot,
    originalRequest: input.task,
    slug: slugifyTask(input.task),
    intake,
    roles: intake.roles,
    mode: input.choices.mode,
    sourceCommit: controller.provenance.candidate_commit,
    controllerProvenance: controller.provenance,
    runConfiguration,
    resourceBudgetPolicy: runConfiguration.resource_budget,
    ...(input.reservedRunId === undefined ? {} : { runId: input.reservedRunId }),
    ...(input.taskLineage === undefined ? {} : { taskLineage: input.taskLineage }),
  });
  await input.onLedgerCreated?.(ledger);
  await appendRunEvent(ledger.runDir, {
    actor: "cli",
    stage: "intake",
    type: "controller_attested",
    payload: {
      self_hosting: controller.provenance.self_hosting,
      mode: controller.provenance.mode,
      executable_path: controller.provenance.executable_path,
      package_name: controller.provenance.package_name,
      package_version: controller.provenance.package_version,
      package_hash_algorithm: controller.provenance.package_hash_algorithm,
      package_hash: controller.provenance.package_hash,
      candidate_commit: controller.provenance.candidate_commit,
    },
  });
  return { ledger, intake, config, run_configuration: runConfiguration };
}

const githubAuthStatusSchema = z.enum([
    "authenticated",
    "unauthenticated",
    "keyring_unavailable",
    "sandbox_blocked",
    "unavailable",
    "skipped",
    "unknown",
]);

const persistedPreflightReportSchema = preflightResultSchema.extend({
  checks: z.array(preflightCheckSchema.strict()),
  github_auth: z.object({
    status: githubAuthStatusSchema,
    reason: z.string().nullable(),
    stderr: z.string(),
  }).strict(),
  github_auth_status: githubAuthStatusSchema,
  supports_search: z.boolean(),
  github_repository: z.string().nullable(),
  missing_github_labels: z.array(z.string()),
  drifted_github_labels: z.array(z.string()),
}).strict().superRefine((report, context) => {
  if (report.github_auth_status !== report.github_auth.status) {
    context.addIssue({
      code: "custom",
      path: ["github_auth_status"],
      message: "github_auth_status must match github_auth.status",
    });
  }
  const requiredChecksFailed = report.checks.some((check) => check.required && check.status === "FAIL");
  if (report.required_checks_failed !== requiredChecksFailed) {
    context.addIssue({
      code: "custom",
      path: ["required_checks_failed"],
      message: "required_checks_failed must match required failed checks",
    });
  }
});

function parsePersistedPreflight(value: unknown): RunPreflightReport {
  return persistedPreflightReportSchema.parse(value);
}

async function readPersistedPreflight(runDir: string): Promise<RunPreflightReport> {
  let raw: string;
  try {
    raw = await readFile(join(runDir, "preflight.json"), "utf8");
  } catch (error) {
    throw new Error("Preflight stage requires a valid persisted preflight.json report", { cause: error });
  }
  try {
    return parsePersistedPreflight(JSON.parse(raw) as unknown);
  } catch (error) {
    throw new Error("Preflight stage requires a valid persisted preflight.json report", { cause: error });
  }
}

async function hasPreflightEvent(runDir: string): Promise<boolean> {
  const raw = await readFile(join(runDir, "events.jsonl"), "utf8");
  return raw.trim().split("\n").filter(Boolean).some((line) => {
    const event = JSON.parse(line) as { type?: unknown };
    return event.type === "preflight_completed";
  });
}

async function persistPreflight(runDir: string, report: RunPreflightReport): Promise<void> {
  await writeTextArtifact(runDir, "preflight.json", `${JSON.stringify(report, null, 2)}\n`);
  await appendRunEvent(runDir, {
    actor: "cli",
    stage: "preflight",
    type: "preflight_completed",
    payload: report as unknown as Record<string, unknown>,
  });
}

function enforceRequiredPreflight(report: RunPreflightReport, dryRun: boolean): void {
  if (dryRun || !report.required_checks_failed) return;
  if (report.missing_github_labels.length > 0) {
    throw new Error(`Missing GitHub workflow labels${report.github_repository ? ` in ${report.github_repository}` : ""}: ${report.missing_github_labels.join(", ")}.\nRun: brain-hands init --repo . --github`);
  }
  throw new Error("Preflight failed; inspect preflight.json before retrying.");
}

export async function advancePreparedRunToDiscovery(
  prepared: PreparedFreshRun,
  options: { dryRun: boolean; rehearsalScenario?: ReleaseRehearsalScenario | null },
): Promise<RunManifestV2> {
  let manifest = await readManifestV2(prepared.ledger.runDir);
  if (manifest.stage === "brain_discovery") return manifest;
  let report: RunPreflightReport;
  if (manifest.stage === "intake") {
    await transitionRun(prepared.ledger.runDir, "preflight", {
      actor: "cli",
      payload: {
        mode: prepared.intake.mode,
        research: prepared.intake.research,
        reflection: prepared.intake.reflection,
      },
    });
    report = options.rehearsalScenario
      ? releaseRehearsalPreflight(options.rehearsalScenario)
      : await runPreflight({
          repoRoot: prepared.intake.repo_root,
          config: { ...prepared.config, profiles: prepared.intake.roles } as never,
          strict: false,
          githubMode: prepared.intake.mode === "github",
          research: prepared.intake.research,
        });
    await persistPreflight(prepared.ledger.runDir, report);
  } else if (manifest.stage === "preflight") {
    report = await readPersistedPreflight(prepared.ledger.runDir);
    if (!await hasPreflightEvent(prepared.ledger.runDir)) {
      await appendRunEvent(prepared.ledger.runDir, {
        actor: "cli",
        stage: "preflight",
        type: "preflight_completed",
        payload: report as unknown as Record<string, unknown>,
      });
    }
  } else {
    throw new Error(`Prepared fresh run must be at intake, preflight, or brain_discovery; got ${manifest.stage}`);
  }
  enforceRequiredPreflight(report, options.dryRun);
  return transitionRun(prepared.ledger.runDir, "brain_discovery", { actor: "cli" });
}

export async function retryRunPreflightToDiscovery(
  runDir: string,
  options: { dryRun: boolean },
): Promise<RunManifestV2> {
  const manifest = await readManifestV2(runDir);
  if (manifest.stage !== "preflight") {
    throw new Error(`Preflight retry requires stage preflight; got ${manifest.stage}`);
  }
  const repoRoot = manifest.repo_root;
  const config = await loadFreshRunConfig(repoRoot, options.dryRun);
  const intakeRaw = JSON.parse(
    await readFile(join(runDir, manifest.intake_path), "utf8"),
  ) as Parameters<typeof resolveRunIntake>[0];
  const intake = resolveRunIntake({ ...intakeRaw, repo_root: repoRoot }, config);
  const report = await runPreflight({
    repoRoot,
    config: { ...config, profiles: intake.roles } as never,
    strict: false,
    githubMode: intake.mode === "github",
    research: intake.research,
  });
  await persistPreflight(runDir, report);
  enforceRequiredPreflight(report, options.dryRun);
  return transitionRun(runDir, "brain_discovery", { actor: "cli" });
}
