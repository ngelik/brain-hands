import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  appendRunEventOnceLocked,
  readManifestV2,
  withRunLedgerCompoundTransaction,
  type RunLedgerTransaction,
} from "../core/ledger.js";
import {
  controllerRecoveryArtifactV1Schema,
  runEventSchema,
} from "../core/schema.js";
import type {
  ControllerProvenance,
  ControllerRecoveryArtifactV1,
  ControllerRuntimeSnapshotV1,
  RunEvent,
  RunManifestV2,
} from "../core/types.js";
import {
  captureControllerProvenance,
  controllerRuntimeSnapshot,
  controllerRuntimeSubjectSha256,
} from "../core/controller-provenance.js";
import {
  readOwnedEvidenceFile,
  readOwnedRunFile,
  writeOwnedEvidenceFile,
} from "../core/owned-evidence.js";

const SHA256 = /^[a-f0-9]{64}$/;
const TRANSITION_FILE = /^(\d{6})-([a-f0-9]{64})\.json$/;

export interface ControllerRecoveryHooks {
  afterTransitionArtifact?: () => Promise<void>;
  afterTransitionEvent?: () => Promise<void>;
  afterManifestHead?: () => Promise<void>;
}

interface BoundTransition {
  path: string;
  artifact: ControllerRecoveryArtifactV1;
}

function exactEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function eventId(runId: string, sequence: number, stage: RunManifestV2["stage"], previous: string, next: string): string {
  return `controller-recovery:${createHash("sha256").update(JSON.stringify({
    domain: "brain-hands/controller-recovery-event",
    version: 1,
    run_id: runId,
    sequence,
    stage,
    previous_subject_sha256: previous,
    next_subject_sha256: next,
  })).digest("hex")}`;
}

function transitionPath(sequence: number, nextSubject: string): string {
  return `controller-recovery/transitions/${String(sequence).padStart(6, "0")}-${nextSubject}.json`;
}

function activeBlockerFingerprint(manifest: RunManifestV2): string | null {
  if (manifest.recovery.active_scope === null) return null;
  return manifest.recovery.scopes[manifest.recovery.active_scope]?.blocker_fingerprint ?? null;
}

async function readTransitions(runDir: string, manifest: RunManifestV2): Promise<BoundTransition[]> {
  const directory = join(runDir, "controller-recovery", "transitions");
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const transitions: BoundTransition[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new Error(`Controller recovery journal contains a non-file entry: ${entry.name}`);
    }
    const match = TRANSITION_FILE.exec(entry.name);
    if (!match) throw new Error(`Controller recovery journal contains an unexpected artifact: ${entry.name}`);
    const path = `controller-recovery/transitions/${entry.name}`;
    const artifact = controllerRecoveryArtifactV1Schema.parse(JSON.parse((await readOwnedEvidenceFile(
      runDir,
      path,
      "controller-recovery",
    )).toString("utf8"))) as ControllerRecoveryArtifactV1;
    if (artifact.run_id !== manifest.run_id) throw new Error("Controller recovery transition belongs to a foreign run");
    if (artifact.sequence !== Number(match[1])) throw new Error("Controller recovery transition sequence conflicts with its path");
    if (artifact.next_subject_sha256 !== match[2] || path !== transitionPath(artifact.sequence, artifact.next_subject_sha256)) {
      throw new Error("Controller recovery transition subject conflicts with its path");
    }
    transitions.push({ path, artifact });
  }
  return transitions;
}

function validateChain(
  manifest: RunManifestV2,
  transitions: BoundTransition[],
): ControllerRuntimeSnapshotV1 {
  if (!manifest.controller_provenance) {
    if (transitions.length > 0) throw new Error("Legacy run cannot contain controller recovery transitions");
    throw new Error("Run predates controller provenance and cannot recover its controller");
  }
  let accepted = controllerRuntimeSnapshot(manifest.controller_provenance);
  let acceptedSubject = controllerRuntimeSubjectSha256(accepted);
  for (const [index, bound] of transitions.entries()) {
    const { artifact } = bound;
    if (artifact.sequence !== index + 1) throw new Error("Controller recovery transition sequence is not contiguous");
    if (artifact.previous_subject_sha256 !== acceptedSubject
      || !exactEqual(artifact.previous_runtime, accepted)) {
      throw new Error("Controller recovery previous subject does not chain to the accepted controller");
    }
    if (controllerRuntimeSubjectSha256(artifact.previous_runtime) !== artifact.previous_subject_sha256
      || controllerRuntimeSubjectSha256(artifact.next_runtime) !== artifact.next_subject_sha256) {
      throw new Error("Controller recovery transition subject hash is invalid");
    }
    if (artifact.previous_subject_sha256 === artifact.next_subject_sha256) {
      throw new Error("Controller recovery transition redundantly records the accepted controller");
    }
    if (artifact.event_id !== eventId(
      artifact.run_id,
      artifact.sequence,
      artifact.stage,
      artifact.previous_subject_sha256,
      artifact.next_subject_sha256,
    )) throw new Error("Controller recovery transition event identity is invalid");
    accepted = artifact.next_runtime;
    acceptedSubject = artifact.next_subject_sha256;
  }
  return accepted;
}

async function readEvents(runDir: string, runId: string): Promise<RunEvent[]> {
  const bytes = await readOwnedRunFile(runDir, "events.jsonl");
  if (bytes.length > 0 && bytes.at(-1) !== 0x0a) {
    throw new Error("Deterministic run event stream has unterminated framing");
  }
  const events = bytes.toString("utf8").split("\n").filter(Boolean)
    .map((line) => runEventSchema.parse(JSON.parse(line)) as RunEvent);
  if (events.some((event) => event.run_id !== runId)) throw new Error("Run event stream contains an event for a foreign run");
  return events;
}

function eventPayload(bound: BoundTransition): Record<string, unknown> {
  return {
    sequence: bound.artifact.sequence,
    transition_path: bound.path,
    previous_subject_sha256: bound.artifact.previous_subject_sha256,
    next_subject_sha256: bound.artifact.next_subject_sha256,
  };
}

function validateTransitionEvents(events: RunEvent[], transitions: BoundTransition[]): BoundTransition[] {
  const byId = new Map(transitions.map((bound) => [bound.artifact.event_id, bound]));
  let seen = 0;
  for (const event of events) {
    const bound = byId.get(event.event_id);
    const namesTransition = event.type === "controller_recovery_recorded"
      || event.event_id.startsWith("controller-recovery:");
    if (!bound) {
      if (namesTransition) throw new Error(`Controller recovery event has no transition artifact: ${event.event_id}`);
      continue;
    }
    if (transitions[seen] !== bound) throw new Error("Controller recovery events are not contiguous and ordered");
    if (event.type !== "controller_recovery_recorded"
      || event.stage !== bound.artifact.stage
      || event.actor !== bound.artifact.actor
      || event.timestamp !== bound.artifact.recorded_at
      || !exactEqual(event.payload, eventPayload(bound))) {
      throw new Error(`Controller recovery event conflicts with its transition: ${event.event_id}`);
    }
    seen += 1;
  }
  return transitions.slice(seen);
}

async function reconcileControllerRecoveryLocked(
  transaction: RunLedgerTransaction,
): Promise<RunManifestV2> {
  let manifest = await transaction.readManifestV2();
  const transitions = await readTransitions(transaction.runDir, manifest);
  validateChain(manifest, transitions);
  const latest = transitions.at(-1);
  const projectedCount = manifest.controller_recovery.transition_count;
  if (projectedCount > transitions.length) throw new Error("Controller recovery manifest head is ahead of the journal");
  if (projectedCount === transitions.length) {
    const expectedPath = latest?.path ?? null;
    if (manifest.controller_recovery.head_path !== expectedPath) {
      throw new Error("Controller recovery manifest head conflicts with the journal");
    }
  } else if (transitions.length - projectedCount !== 1) {
    throw new Error("Controller recovery manifest head is not the immediate journal predecessor");
  } else {
    const projectedPath = transitions[projectedCount - 1]?.path ?? null;
    if (manifest.controller_recovery.head_path !== projectedPath) {
      throw new Error("Controller recovery stale manifest head conflicts with the journal");
    }
  }

  const missingEvents = validateTransitionEvents(
    await readEvents(transaction.runDir, manifest.run_id),
    transitions,
  );
  if (missingEvents.length > 1) throw new Error("Controller recovery event projection is more than one transition behind");
  if (missingEvents.length === 1) {
    const missing = missingEvents[0]!;
    if (missing !== latest || projectedCount === transitions.length) {
      throw new Error("Controller recovery event projection conflicts with the manifest head");
    }
    await appendRunEventOnceLocked(transaction, {
      eventId: missing.artifact.event_id,
      actor: missing.artifact.actor,
      stage: missing.artifact.stage,
      type: "controller_recovery_recorded",
      timestamp: missing.artifact.recorded_at,
      payload: eventPayload(missing),
    });
  }

  if (projectedCount === transitions.length) return manifest;
  manifest = await transaction.updateManifestV2({
    controller_recovery: {
      version: 1,
      transition_count: transitions.length,
      head_path: latest!.path,
    },
  });
  return manifest;
}

export async function reconcileControllerRecovery(runDir: string): Promise<RunManifestV2> {
  return withRunLedgerCompoundTransaction(runDir, reconcileControllerRecoveryLocked);
}

export async function recordControllerRecovery(input: {
  runDir: string;
  actor: string;
  reason: string;
  expectedPackageSha256: string;
  hooks?: ControllerRecoveryHooks;
}): Promise<{
  artifact_path: string;
  artifact: ControllerRecoveryArtifactV1;
  manifest: RunManifestV2;
}> {
  const actor = input.actor.trim();
  const reason = input.reason.trim();
  if (!actor) throw new Error("Controller recovery actor must be non-empty");
  if (!reason) throw new Error("Controller recovery reason must be non-empty");
  if (!SHA256.test(input.expectedPackageSha256)) throw new Error("Expected package SHA-256 must be 64 lowercase hexadecimal characters");

  const initialManifest = await readManifestV2(input.runDir);
  if (!initialManifest.controller_provenance) throw new Error("Run predates controller provenance and cannot recover its controller");
  const captured: ControllerProvenance = (await captureControllerProvenance(initialManifest.repo_root)).provenance;
  if (captured.package_hash !== input.expectedPackageSha256) {
    throw new Error("Expected package SHA-256 does not match the captured current controller package hash");
  }

  return withRunLedgerCompoundTransaction(input.runDir, async (transaction) => {
    let manifest = await transaction.readManifestV2();
    if (manifest.terminal !== null) throw new Error(`Cannot recover controller for terminal outcome ${manifest.terminal.outcome}`);
    if (manifest.abandonment_path !== null || manifest.assurance_outcome === "abandoned") {
      throw new Error("Cannot recover controller for an abandoned run");
    }
    manifest = await reconcileControllerRecoveryLocked(transaction);
    const transitions = await readTransitions(transaction.runDir, manifest);
    const previousRuntime = validateChain(manifest, transitions);
    const nextRuntime = controllerRuntimeSnapshot(captured);
    const previousSubject = controllerRuntimeSubjectSha256(previousRuntime);
    const nextSubject = controllerRuntimeSubjectSha256(nextRuntime);
    if (previousSubject === nextSubject) throw new Error("Controller recovery is redundant; the current controller is already accepted");
    const sequence = transitions.length + 1;
    const path = transitionPath(sequence, nextSubject);
    const recordedAt = new Date().toISOString();
    const artifact = controllerRecoveryArtifactV1Schema.parse({
      version: 1,
      run_id: manifest.run_id,
      sequence,
      stage: manifest.stage,
      actor,
      reason,
      recorded_at: recordedAt,
      previous_subject_sha256: previousSubject,
      next_subject_sha256: nextSubject,
      previous_runtime: previousRuntime,
      next_runtime: nextRuntime,
      candidate_head_at_recovery: captured.candidate_commit,
      blocker_fingerprint: activeBlockerFingerprint(manifest),
      event_id: eventId(manifest.run_id, sequence, manifest.stage, previousSubject, nextSubject),
    }) as ControllerRecoveryArtifactV1;
    await writeOwnedEvidenceFile(
      transaction.runDir,
      path,
      "controller-recovery",
      `${JSON.stringify(artifact, null, 2)}\n`,
    );
    await input.hooks?.afterTransitionArtifact?.();
    await appendRunEventOnceLocked(transaction, {
      eventId: artifact.event_id,
      actor: artifact.actor,
      stage: artifact.stage,
      type: "controller_recovery_recorded",
      timestamp: artifact.recorded_at,
      payload: eventPayload({ path, artifact }),
    });
    await input.hooks?.afterTransitionEvent?.();
    manifest = await transaction.updateManifestV2({
      controller_recovery: { version: 1, transition_count: sequence, head_path: path },
    });
    await input.hooks?.afterManifestHead?.();
    return { artifact_path: path, artifact, manifest };
  });
}
