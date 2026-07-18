import { createHash, randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import type { ZodType } from "zod";
import { DEFAULT_RELEASE_GUARDS, defaultConfig, loadConfig } from "../core/config.js";
import { captureControllerProvenance } from "../core/controller-provenance.js";
import { initialDiscoveryState } from "../core/discovery.js";
import { resolveRunIntake } from "../core/intake.js";
import {
  appendRunEventOnce,
  readManifestV2,
  readOptionalValidatedArtifact,
  writeCreateOnceValidated,
  withRunLedgerCompoundTransaction,
  type RunLedgerTransaction,
  type RunLedgerV2,
} from "../core/ledger.js";
import { readOwnedRunFile } from "../core/owned-evidence.js";
import {
  abandonmentArtifactSchema,
  replacementCompletionV1Schema,
  replacementPredecessorLinkV1Schema,
  replacementReservationV1Schema,
  runEventSchema,
  runIntakeSchema,
} from "../core/schema.js";
import {
  RUN_CONFIGURATION_PATH,
  resolveRunConfiguration,
  resolvedRunConfigurationSchema,
} from "../core/run-configuration.js";
import type {
  ConfigV2,
  ReplacementCompletionV1,
  ReplacementPredecessorLinkV1,
  ReplacementReservationV1,
  RoleName,
  RunManifestV2,
} from "../core/types.js";
import {
  advancePreparedRunToDiscovery,
  prepareFreshRun,
  type FreshRunChoices,
  type PreparedFreshRun,
} from "./run-start.js";

const RESERVATION_PATH = "replacement/reservation.json";
const PREDECESSOR_LINK_PATH = "lineage/predecessor.json";
const COMPLETION_PATH = "replacement/completion.json";

export interface ReplacementHooks {
  afterReservation?: () => Promise<void>;
  afterSuccessorDirectoryCreated?: () => Promise<void>;
  afterSuccessorBacklink?: () => Promise<void>;
  afterSuccessorPreflight?: () => Promise<void>;
  afterCompletionArtifact?: () => Promise<void>;
  afterFinalArtifactAppend?: () => Promise<void>;
}

export interface ReplaceAbandonedRunInput {
  runDir: string;
  actor: string;
  reason: string;
  dryRun?: boolean;
  hooks?: ReplacementHooks;
}

export interface ReplacementResult {
  successorRunId: string;
  successorRunDir: string;
  reservation: ReplacementReservationV1;
  predecessorLink: ReplacementPredecessorLinkV1;
  completion: ReplacementCompletionV1;
}

function sha256(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function normalize(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} must be non-empty`);
  return normalized;
}

function exact(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function pristineSuccessor(manifest: RunManifestV2): boolean {
  return ["intake", "preflight", "brain_discovery"].includes(manifest.stage)
    && manifest.discovery !== null
    && exact(manifest.discovery, initialDiscoveryState())
    && manifest.current_revision === null
    && manifest.approved_revision === null
    && manifest.current_plan_revision === null
    && manifest.approved_plan_revision === null
    && Object.keys(manifest.plan_revisions).length === 0
    && Object.keys(manifest.retry_counts).length === 0
    && manifest.events.length === 1
    && manifest.events[0] === "events.jsonl"
    && manifest.active_hands_profile === "primary"
    && manifest.backup_activation_reason === null
    && manifest.hands_backup_catalog == null
    && exact(manifest.review_accounting, {
      review_revision: 0,
      fix_cycles_used: 0,
      self_review_mutations_used: 0,
      plan_revision: 0,
    })
    && Object.keys(manifest.finding_index ?? {}).length === 0
    && Object.keys(manifest.convergence_reports ?? {}).length === 0
    && manifest.current_work_item_id === null
    && Object.keys(manifest.work_item_progress).length === 0
    && manifest.worktree_path === null
    && manifest.branch_name === null
    && manifest.issue_numbers.length === 0
    && manifest.pull_request_numbers.length === 0
    && Object.keys(manifest.work_item_issue_map).length === 0
    && manifest.github_ids.issue_numbers.length === 0
    && Object.keys(manifest.github_ids.work_item_issue_map ?? {}).length === 0
    && manifest.github_ids.parent_issue_number === null
    && manifest.github_ids.pull_request_numbers.length === 0
    && Object.keys(manifest.github_ids.pull_request_urls).length === 0
    && manifest.delivery_state === "pending"
    && manifest.assurance_outcome === null
    && manifest.assurance_assessment_path === null
    && manifest.risk_acceptance_path === null
    && manifest.risk_acceptance_history.length === 0
    && manifest.abandonment_path === null
    && manifest.terminal === null
    && manifest.final_artifact_paths.length === 0
    && manifest.last_blocker === null
    && manifest.brain_controller_claim === null
    && manifest.planning_recovery === null
    && manifest.recovery.active_scope === null
    && Object.keys(manifest.recovery.scopes).length === 0
    && manifest.controller_recovery.transition_count === 0
    && manifest.controller_recovery.head_path === null
    && manifest.warning_continuation_authority === undefined;
}

async function readAbandonment(
  runDir: string,
  manifest: RunManifestV2,
): Promise<{ path: string; sha256: string }> {
  if (manifest.terminal?.outcome !== "abandoned") {
    throw new Error("Replacement requires a terminal abandoned predecessor");
  }
  if (manifest.abandonment_path === null || manifest.assurance_outcome !== "abandoned") {
    throw new Error("Replacement requires a valid matching abandonment artifact");
  }
  let bytes: Buffer;
  try {
    bytes = await readOwnedRunFile(runDir, manifest.abandonment_path);
  } catch (error) {
    throw new Error("Replacement requires a valid matching abandonment artifact", { cause: error });
  }
  let artifact;
  try {
    artifact = abandonmentArtifactSchema.parse(JSON.parse(bytes.toString("utf8")));
  } catch (error) {
    throw new Error("Replacement requires a valid matching abandonment artifact", { cause: error });
  }
  if (
    bytes.toString("utf8") !== `${JSON.stringify(artifact, null, 2)}\n`
    || artifact.run_id !== manifest.run_id
    || artifact.reason !== manifest.terminal.reason
  ) {
    throw new Error("Replacement abandonment artifact does not match the terminal predecessor");
  }
  return { path: manifest.abandonment_path, sha256: sha256(bytes) };
}

async function readChoices(runDir: string, manifest: RunManifestV2): Promise<FreshRunChoices> {
  const intake = runIntakeSchema.parse(JSON.parse((await readOwnedRunFile(runDir, manifest.intake_path)).toString("utf8")));
  const configuration = resolvedRunConfigurationSchema.parse(JSON.parse(
    (await readOwnedRunFile(runDir, RUN_CONFIGURATION_PATH)).toString("utf8"),
  ));
  if (
    intake.task !== manifest.original_request
    || intake.repo_root !== manifest.repo_root
    || configuration.repository !== manifest.repo_root
    || intake.mode !== configuration.mode
    || intake.research !== configuration.research
    || intake.reflection !== configuration.reflection
    || manifest.mode !== configuration.mode
  ) throw new Error("Persisted intake and run configuration do not match the predecessor manifest");
  const modelOverrides: Partial<Record<RoleName, string>> = {};
  for (const role of ["brain", "hands", "verifier"] as const) {
    if (configuration.roles[role].source === "cli_override") {
      modelOverrides[role] = configuration.roles[role].model;
    }
  }
  return {
    mode: configuration.mode,
    research: configuration.research,
    reflection: configuration.reflection,
    model_overrides: modelOverrides,
  };
}

async function createOrReplay<T>(
  runDir: string,
  path: string,
  value: T,
  schema: ZodType<T>,
): Promise<T> {
  const existing = await readCanonicalOptional(runDir, path, schema);
  if (existing !== null) {
    if (!exact(existing, value)) throw new Error(`Existing ${path} conflicts with the reserved replacement`);
    return existing;
  }
  try {
    return await writeCreateOnceValidated(runDir, path, value, schema);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const raced = await readCanonicalOptional(runDir, path, schema);
    if (raced === null || !exact(raced, value)) throw new Error(`Existing ${path} conflicts with the reserved replacement`);
    return raced;
  }
}

async function readCanonicalOptional<T>(
  runDir: string,
  path: string,
  schema: ZodType<T>,
): Promise<T | null> {
  const artifact = await readOptionalValidatedArtifact(runDir, path, schema);
  if (artifact === null) return null;
  const bytes = await readOwnedRunFile(runDir, path);
  if (bytes.toString("utf8") !== `${JSON.stringify(artifact, null, 2)}\n`) {
    throw new Error(`Existing ${path} is not a canonical replacement artifact`);
  }
  return artifact;
}

async function reserveReplacement(
  runDir: string,
  actor: string,
  reason: string,
): Promise<ReplacementReservationV1> {
  return withRunLedgerCompoundTransaction(runDir, async (transaction) => {
    const manifest = await transaction.readManifestV2();
    const abandonment = await readAbandonment(runDir, manifest);
    if (manifest.task_lineage === null) throw new Error("Replacement requires a durable predecessor task lineage");
    const existing = await readCanonicalOptional(runDir, RESERVATION_PATH, replacementReservationV1Schema);
    if (existing !== null) {
      if (
        existing.predecessor_run_id !== manifest.run_id
        || existing.predecessor_abandonment_path !== abandonment.path
        || existing.predecessor_abandonment_sha256 !== abandonment.sha256
        || existing.actor !== actor
        || existing.reason !== reason
        || existing.task_lineage.predecessor_run_id !== manifest.run_id
        || existing.task_lineage.predecessor_abandonment_sha256 !== abandonment.sha256
        || existing.task_lineage.lineage_id !== manifest.task_lineage.lineage_id
        || existing.task_lineage.root_run_id !== manifest.task_lineage.root_run_id
      ) throw new Error("Existing replacement reservation conflicts with the abandoned predecessor");
      return existing;
    }
    const reservation = replacementReservationV1Schema.parse({
      version: 1,
      predecessor_run_id: manifest.run_id,
      predecessor_abandonment_path: abandonment.path,
      predecessor_abandonment_sha256: abandonment.sha256,
      successor_run_id: `replacement-${randomUUID()}`,
      task_lineage: {
        version: 1,
        lineage_id: manifest.task_lineage.lineage_id,
        root_run_id: manifest.task_lineage.root_run_id,
        predecessor_run_id: manifest.run_id,
        predecessor_abandonment_sha256: abandonment.sha256,
      },
      actor,
      reason,
      created_at: new Date().toISOString(),
    });
    return writeCreateOnceValidated(runDir, RESERVATION_PATH, reservation, replacementReservationV1Schema);
  });
}

async function loadCurrentConfig(repoRoot: string, dryRun: boolean): Promise<ConfigV2> {
  try {
    return await loadConfig(repoRoot) as unknown as ConfigV2;
  } catch (error) {
    if (dryRun && (error as NodeJS.ErrnoException).code === "ENOENT") return defaultConfig() as unknown as ConfigV2;
    throw error;
  }
}

async function ensureControllerEvent(prepared: PreparedFreshRun): Promise<void> {
  const eventLines = (await readOwnedRunFile(prepared.ledger.runDir, "events.jsonl")).toString("utf8")
    .split("\n").filter(Boolean);
  const events = eventLines.map((line) => runEventSchema.parse(JSON.parse(line)));
  if (events.some((event, index) => eventLines[index] !== JSON.stringify(event))) {
    throw new Error("Reserved successor event stream is not canonical");
  }
  if (events.some((event) => event.run_id !== prepared.ledger.runId)) {
    throw new Error("Reserved successor event stream contains foreign run provenance");
  }
  const expectedPayload = {
    self_hosting: prepared.ledger.manifest.controller_provenance!.self_hosting,
    mode: prepared.ledger.manifest.controller_provenance!.mode,
    executable_path: prepared.ledger.manifest.controller_provenance!.executable_path,
    package_name: prepared.ledger.manifest.controller_provenance!.package_name,
    package_version: prepared.ledger.manifest.controller_provenance!.package_version,
    package_hash_algorithm: prepared.ledger.manifest.controller_provenance!.package_hash_algorithm,
    package_hash: prepared.ledger.manifest.controller_provenance!.package_hash,
    candidate_commit: prepared.ledger.manifest.controller_provenance!.candidate_commit,
  };
  const matching = events.filter((event) => event.type === "controller_attested");
  if (matching.length > 1 || (matching.length === 1 && (
    matching[0]!.stage !== "intake" || !exact(matching[0]!.payload, expectedPayload)
  ))) throw new Error("Reserved successor controller attestation conflicts with current controller provenance");
  if (matching.length === 0) {
    await appendRunEventOnce(prepared.ledger.runDir, {
      eventId: `replacement-controller-attested:${prepared.ledger.runId}`,
      actor: "cli",
      stage: "intake",
      type: "controller_attested",
      payload: expectedPayload,
    });
  }
}

async function replayPreparedSuccessor(input: {
  runDir: string;
  reservation: ReplacementReservationV1;
  choices: FreshRunChoices;
  dryRun: boolean;
}): Promise<PreparedFreshRun> {
  const manifest = await readManifestV2(input.runDir);
  if (!pristineSuccessor(manifest)) throw new Error("Reserved successor conflicts with the pristine fresh-run boundary");
  if (manifest.run_id !== input.reservation.successor_run_id) {
    throw new Error("Reserved successor run ID does not match the replacement reservation");
  }
  const config = await loadCurrentConfig(manifest.repo_root, input.dryRun);
  const controller = await captureControllerProvenance(manifest.repo_root, { dryRun: input.dryRun });
  const intake = resolveRunIntake({
    task: manifest.original_request,
    repo_root: manifest.repo_root,
    mode: input.choices.mode,
    research: input.choices.research,
    reflection: input.choices.reflection,
    brain_model: input.choices.model_overrides.brain,
    hands_model: input.choices.model_overrides.hands,
    verifier_model: input.choices.model_overrides.verifier,
    quality_gate: config.retry_policy.quality_gate ? { ...config.retry_policy.quality_gate } : undefined,
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
  if (
    !exact(manifest.task_lineage, input.reservation.task_lineage)
    || !exact(manifest.controller_provenance, controller.provenance)
    || manifest.source_commit !== controller.provenance.candidate_commit
    || !exact(manifest.role_profiles, intake.roles)
    || !exact(manifest.selected_role_profiles, intake.roles)
    || !exact(manifest.review_policy_snapshot, intake.review_policy)
    || !exact(manifest.quality_gate_policy ?? null, intake.quality_gate ?? null)
    || !exact(manifest.hands_backup_policy ?? null, intake.hands_backup ?? null)
    || !exact(manifest.release_guards, DEFAULT_RELEASE_GUARDS)
  ) throw new Error("Reserved successor identity or current controller configuration does not match");
  if ((await readOwnedRunFile(input.runDir, "original-request.md")).toString("utf8") !== `${manifest.original_request}\n`) {
    throw new Error("Reserved successor original request artifact does not match its manifest");
  }
  const persistedIntake = JSON.parse((await readOwnedRunFile(input.runDir, manifest.intake_path)).toString("utf8")) as Record<string, unknown>;
  const intakeMatches = {
    task: persistedIntake.task === intake.task,
    repo: persistedIntake.repo_root === intake.repo_root,
    mode: persistedIntake.mode === intake.mode,
    research: persistedIntake.research === intake.research,
    reflection: persistedIntake.reflection === intake.reflection,
    roles: exact(persistedIntake.roles, intake.roles),
    models: exact(persistedIntake.resolved_models, intake.resolved_models),
  };
  if (Object.values(intakeMatches).some((matches) => !matches)) {
    throw new Error("Reserved successor persisted intake conflicts with the reconstructed choices");
  }
  const persistedConfiguration = await readOwnedRunFile(input.runDir, RUN_CONFIGURATION_PATH)
    .then((raw) => resolvedRunConfigurationSchema.parse(JSON.parse(raw.toString("utf8"))))
    .catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
  if (persistedConfiguration === null) {
    await writeCreateOnceValidated(input.runDir, RUN_CONFIGURATION_PATH, runConfiguration, resolvedRunConfigurationSchema);
  } else if (!exact(persistedConfiguration, runConfiguration)) {
    throw new Error("Reserved successor run configuration conflicts with the current reconstructed configuration");
  }
  const ledger: RunLedgerV2 = { runId: manifest.run_id, runDir: input.runDir, manifest };
  const prepared = { ledger, intake, config, run_configuration: runConfiguration } satisfies PreparedFreshRun;
  await ensureControllerEvent(prepared);
  return prepared;
}

async function prepareSuccessor(input: {
  predecessor: RunManifestV2;
  reservation: ReplacementReservationV1;
  choices: FreshRunChoices;
  dryRun: boolean;
  hooks: ReplacementHooks;
}): Promise<PreparedFreshRun> {
  for (const directory of [
    join(input.predecessor.repo_root, ".brain-hands"),
    join(input.predecessor.repo_root, ".brain-hands", "runs"),
  ]) {
    const boundary = await lstat(directory);
    if (boundary.isSymbolicLink() || !boundary.isDirectory()) {
      throw new Error("Replacement run root must be a real directory, not a symlink");
    }
  }
  const runDir = join(input.predecessor.repo_root, ".brain-hands", "runs", input.reservation.successor_run_id);
  const status = await lstat(runDir).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  let prepared: PreparedFreshRun;
  if (status === null) {
    prepared = await prepareFreshRun({
      task: input.predecessor.original_request,
      repoRoot: input.predecessor.repo_root,
      choices: input.choices,
      dryRun: input.dryRun,
      reservedRunId: input.reservation.successor_run_id,
      taskLineage: input.reservation.task_lineage,
      onLedgerCreated: input.hooks.afterSuccessorDirectoryCreated,
    });
  } else {
    if (status.isSymbolicLink() || !status.isDirectory()) throw new Error("Reserved successor path conflicts with a run directory");
    prepared = await replayPreparedSuccessor({ runDir, reservation: input.reservation, choices: input.choices, dryRun: input.dryRun });
  }
  const manifest = await readManifestV2(runDir);
  if (
    manifest.run_id !== input.reservation.successor_run_id
    || manifest.repo_root !== input.predecessor.repo_root
    || manifest.original_request !== input.predecessor.original_request
    || !exact(manifest.task_lineage, input.reservation.task_lineage)
    || !pristineSuccessor(manifest)
  ) throw new Error("Reserved successor manifest conflicts with the replacement reservation");
  return prepared;
}

async function ensureBacklink(
  runDir: string,
  reservation: ReplacementReservationV1,
  reservationSha256: string,
): Promise<ReplacementPredecessorLinkV1> {
  const manifest = await readManifestV2(runDir);
  if (!pristineSuccessor(manifest)) throw new Error("A missing predecessor backlink may only be created on a pristine successor");
  const link = replacementPredecessorLinkV1Schema.parse({
    version: 1,
    predecessor_run_id: reservation.predecessor_run_id,
    predecessor_reservation_sha256: reservationSha256,
    successor_run_id: reservation.successor_run_id,
    task_lineage: reservation.task_lineage,
  });
  return createOrReplay(runDir, PREDECESSOR_LINK_PATH, link, replacementPredecessorLinkV1Schema);
}

async function completeReplacement(input: {
  runDir: string;
  reservation: ReplacementReservationV1;
  reservationSha256: string;
  predecessorLink: ReplacementPredecessorLinkV1;
  predecessorLinkSha256: string;
  hooks: ReplacementHooks;
}): Promise<ReplacementCompletionV1> {
  return withRunLedgerCompoundTransaction(input.runDir, async (transaction: RunLedgerTransaction) => {
    const predecessor = await transaction.readManifestV2();
    const abandonment = await readAbandonment(input.runDir, predecessor);
    if (abandonment.sha256 !== input.reservation.predecessor_abandonment_sha256) {
      throw new Error("Predecessor abandonment changed after replacement reservation");
    }
    const successorRunDir = join(predecessor.repo_root, ".brain-hands", "runs", input.reservation.successor_run_id);
    const successor = await readManifestV2(successorRunDir);
    if (
      successor.stage !== "brain_discovery"
      || successor.repo_root !== predecessor.repo_root
      || successor.original_request !== predecessor.original_request
      || !exact(successor.task_lineage, input.reservation.task_lineage)
      || !pristineSuccessor(successor)
    ) throw new Error("Reserved successor is not at the validated fresh discovery boundary");
    const link = await readCanonicalOptional(successorRunDir, PREDECESSOR_LINK_PATH, replacementPredecessorLinkV1Schema);
    if (link === null || !exact(link, input.predecessorLink)) throw new Error("Reserved successor predecessor backlink conflicts");
    const existing = await readCanonicalOptional(input.runDir, COMPLETION_PATH, replacementCompletionV1Schema);
    let completion: ReplacementCompletionV1;
    if (existing !== null) {
      if (
        existing.predecessor_run_id !== predecessor.run_id
        || existing.successor_run_id !== successor.run_id
        || existing.reservation_sha256 !== input.reservationSha256
        || existing.predecessor_link_sha256 !== input.predecessorLinkSha256
      ) throw new Error("Existing replacement completion conflicts with the validated successor");
      completion = existing;
    } else {
      completion = await writeCreateOnceValidated(input.runDir, COMPLETION_PATH, {
        version: 1,
        predecessor_run_id: predecessor.run_id,
        successor_run_id: successor.run_id,
        reservation_sha256: input.reservationSha256,
        predecessor_link_sha256: input.predecessorLinkSha256,
        completed_at: new Date().toISOString(),
      }, replacementCompletionV1Schema);
    }
    await input.hooks.afterCompletionArtifact?.();
    const current = await transaction.readManifestV2();
    if (!current.final_artifact_paths.includes(COMPLETION_PATH)) {
      await transaction.updateManifestV2({
        final_artifact_paths: [...current.final_artifact_paths, COMPLETION_PATH],
      });
    }
    await input.hooks.afterFinalArtifactAppend?.();
    return completion;
  });
}

export async function replaceAbandonedRun(input: ReplaceAbandonedRunInput): Promise<ReplacementResult> {
  const actor = normalize(input.actor, "Replacement actor");
  const reason = normalize(input.reason, "Replacement reason");
  const hooks = input.hooks ?? {};
  const reservation = await reserveReplacement(input.runDir, actor, reason);
  await hooks.afterReservation?.();
  const predecessor = await readManifestV2(input.runDir);
  const choices = await readChoices(input.runDir, predecessor);
  const reservationBytes = await readOwnedRunFile(input.runDir, RESERVATION_PATH);
  const reservationSha256 = sha256(reservationBytes);
  const prepared = await prepareSuccessor({
    predecessor,
    reservation,
    choices,
    dryRun: input.dryRun === true,
    hooks,
  });
  const predecessorLink = await ensureBacklink(prepared.ledger.runDir, reservation, reservationSha256);
  await hooks.afterSuccessorBacklink?.();
  await advancePreparedRunToDiscovery(prepared, { dryRun: input.dryRun === true });
  await hooks.afterSuccessorPreflight?.();
  const predecessorLinkSha256 = sha256(await readOwnedRunFile(prepared.ledger.runDir, PREDECESSOR_LINK_PATH));
  const completion = await completeReplacement({
    runDir: input.runDir,
    reservation,
    reservationSha256,
    predecessorLink,
    predecessorLinkSha256,
    hooks,
  });
  return {
    successorRunId: reservation.successor_run_id,
    successorRunDir: prepared.ledger.runDir,
    reservation,
    predecessorLink,
    completion,
  };
}
