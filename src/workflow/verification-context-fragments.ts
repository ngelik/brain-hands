import { z } from "zod";
import { createHash } from "node:crypto";
import {
  artifactRefFromBytes,
  artifactSegment,
  canonicalJsonBytes,
  verificationContextFragmentV1Schema,
  type ArtifactRefV1,
  type VerificationContextFragmentV1,
} from "../core/context-contracts.js";
import { readReferencedJson, writeImmutableValidatedJson } from "../core/ledger.js";
import { readOwnedRunFile } from "../core/owned-evidence.js";
import { verificationEvidenceSchema } from "../core/schema.js";
import type {
  RunManifestV2,
  VerificationEvidence,
  VerificationIdentity,
} from "../core/types.js";
import { validatePersistedVerificationEvidence } from "../verification/evidence.js";

type JsonValue = z.infer<typeof z.json>;

export interface VerificationContextCandidate {
  type: VerificationContextFragmentV1["kind"];
  ref: ArtifactRefV1;
  value: JsonValue;
  target: "command_evidence" | "artifact_checks" | "browser_evidence";
}

export interface VerificationSourceAuthority {
  ref: ArtifactRefV1;
  identity: VerificationIdentity;
}

function equalJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function loadVerificationAuthority(
  runDir: string,
  ref: ArtifactRefV1,
  expectedIdentity: VerificationIdentity,
): Promise<VerificationEvidence> {
  const raw = await readReferencedJson(runDir, ref, verificationEvidenceSchema);
  const canonicalRef = artifactRefFromBytes(ref.path, canonicalJsonBytes(verificationEvidenceSchema, raw));
  if (!equalJson(canonicalRef, ref)) throw new Error("Current verification authority reference is not canonical");
  const evidence = await validatePersistedVerificationEvidence({
    runDir,
    identity: expectedIdentity,
    attempt: raw.attempt,
    evidencePath: ref.path,
  });
  return evidence;
}

export async function validateVerificationContextSource(
  runDir: string,
  ref: ArtifactRefV1,
  expectedIdentity: VerificationIdentity,
): Promise<VerificationEvidence> {
  return loadVerificationAuthority(runDir, ref, expectedIdentity);
}

function workItemIdentity(manifest: RunManifestV2, workItemId: string): VerificationIdentity {
  if (manifest.mode !== manifest.run_mode) {
    throw new Error("Run mode authority is inconsistent for role-context verification");
  }
  if (workItemId === "integrated") return { scope: "integrated", work_item_id: "integrated" };
  if (manifest.run_mode === "local") return { scope: "local", work_item_id: workItemId };
  const issueNumber = manifest.work_item_issue_map[workItemId]
    ?? manifest.github_ids.work_item_issue_map?.[workItemId];
  if (typeof issueNumber !== "number" || !Number.isInteger(issueNumber) || issueNumber < 1) {
    throw new Error(`No durable GitHub issue mapping exists for work item ${workItemId}`);
  }
  return { scope: "github", work_item_id: workItemId, issue_number: issueNumber };
}

function currentProgressVerificationIdentity(manifest: RunManifestV2, workItemId: string): VerificationIdentity {
  const base = workItemIdentity(manifest, workItemId);
  const progress = manifest.work_item_progress[workItemId];
  const scope = progress?.verification_scope;
  const progressWorkItemId = progress?.verification_work_item_id;
  if (scope === undefined && progressWorkItemId === undefined) return base;
  if (scope !== "local" || typeof progressWorkItemId !== "string") {
    if (scope === base.scope && progressWorkItemId === base.work_item_id) return base;
    throw new Error(`Current verification progress identity is invalid for ${workItemId}`);
  }
  if (base.scope === "local" && progressWorkItemId === workItemId) return base;
  const escaped = workItemId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const qualityGate = new RegExp(`^${escaped}:quality-gate:[1-9][0-9]*:(?:baseline|[1-9][0-9]*)(?::authority-[a-f0-9]{16})?$`);
  if (!qualityGate.test(progressWorkItemId)) {
    throw new Error(`Current verification progress identity is not an owned quality gate for ${workItemId}`);
  }
  return { scope: "local", work_item_id: progressWorkItemId };
}

function matchesCurrentReviewerActionVerification(
  progress: RunManifestV2["work_item_progress"][string],
  evidenceAttempt: number,
): boolean {
  if (
    progress?.mutation_kind !== "reviewer_action"
    || progress.queue_state !== "in_progress"
    || typeof progress.review_revision !== "number"
    || typeof progress.active_action_id !== "string"
    || typeof progress.active_action_attempt !== "number"
  ) return false;
  const action = /^R([1-9][0-9]*)-A([1-9][0-9]*)$/.exec(progress.active_action_id);
  if (action === null || Number(action[1]) !== progress.review_revision) return false;
  const actionOrder = Number(action[2]);
  const baseAttempt = progress.review_revision * 1_000_000 + actionOrder * 100;
  const actionAttempt = evidenceAttempt - baseAttempt;
  return Number.isSafeInteger(baseAttempt)
    && Number.isInteger(actionAttempt)
    && actionAttempt >= 1
    && actionAttempt <= progress.active_action_attempt;
}

export async function currentWorkItemVerificationAuthority(
  runDir: string,
  manifest: RunManifestV2,
  workItemId: string,
  expectedAttempt?: number,
): Promise<VerificationSourceAuthority | null> {
  const progress = manifest.work_item_progress[workItemId];
  if (typeof progress?.verification_path !== "string") return null;
  const identity = currentProgressVerificationIdentity(manifest, workItemId);
  const bytes = await readOwnedRunFile(runDir, progress.verification_path);
  const ref = artifactRefFromBytes(progress.verification_path, bytes);
  const evidence = await validateVerificationContextSource(runDir, ref, identity);
  const qualityGateIdentity = identity.scope === "local" && identity.work_item_id.startsWith(`${workItemId}:quality-gate:`);
  const authoritativeAttempt = expectedAttempt ?? progress.attempts;
  if (
    !qualityGateIdentity
    && evidence.attempt !== authoritativeAttempt
    && !matchesCurrentReviewerActionVerification(progress, evidence.attempt)
  ) {
    throw new Error(`Current verification authority does not match ${workItemId} attempt ${expectedAttempt ?? progress.attempts}`);
  }
  return { ref, identity };
}

function fragmentPath(
  sourceRef: ArtifactRefV1,
  kind: VerificationContextFragmentV1["kind"],
  ordinal: number,
): string {
  const sourceIdentity = `${sourceRef.path}\0${sourceRef.sha256}`;
  const legacySegment = artifactSegment(sourceIdentity);
  const segment = legacySegment.length <= 200
    ? legacySegment
    : `sha256-${createHash("sha256").update(sourceIdentity).digest("hex")}`;
  return `contexts/fragments/verification/${segment}/${kind}-${ordinal}.json`;
}

/** Reconstruct the typed record universe from one authoritative verification bundle. */
export async function verificationContextCandidates(
  runDir: string,
  sourceRef: ArtifactRefV1 | null,
  expectedIdentity: VerificationIdentity | null,
  persist: boolean,
): Promise<VerificationContextCandidate[]> {
  if (sourceRef === null) return [];
  if (expectedIdentity === null) throw new Error("Verification context source identity is required");
  const evidence = await loadVerificationAuthority(runDir, sourceRef, expectedIdentity);
  const values: Array<{
    kind: VerificationContextFragmentV1["kind"];
    target: VerificationContextCandidate["target"];
    value: JsonValue;
  }> = [
    ...evidence.commands.map((value) => ({ kind: "command_evidence" as const, target: "command_evidence" as const, value })),
    ...evidence.artifact_checks.map((value) => ({ kind: "artifact_check" as const, target: "artifact_checks" as const, value })),
    ...evidence.browser_evidence.map((value) => ({ kind: "browser_evidence" as const, target: "browser_evidence" as const, value })),
  ];
  const ordinals = new Map<VerificationContextFragmentV1["kind"], number>();
  const candidates: VerificationContextCandidate[] = [];
  for (const entry of values) {
    const ordinal = ordinals.get(entry.kind) ?? 0;
    ordinals.set(entry.kind, ordinal + 1);
    const fragment = verificationContextFragmentV1Schema.parse({
      schema_version: 1,
      source_verification_ref: sourceRef,
      kind: entry.kind,
      ordinal,
      value: entry.value,
    });
    const path = fragmentPath(sourceRef, entry.kind, ordinal);
    const ref = persist
      ? await writeImmutableValidatedJson(runDir, path, verificationContextFragmentV1Schema, fragment)
      : artifactRefFromBytes(path, canonicalJsonBytes(verificationContextFragmentV1Schema, fragment));
    if (!persist) {
      const stored = await readReferencedJson(runDir, ref, verificationContextFragmentV1Schema);
      if (!equalJson(stored, fragment)) throw new Error(`Verification context fragment is not exact: ${ref.path}`);
    }
    candidates.push({ type: entry.kind, ref, value: { ref, value: entry.value }, target: entry.target });
  }
  const priority: Record<VerificationContextFragmentV1["kind"], number> = {
    command_evidence: 0,
    artifact_check: 1,
    browser_evidence: 2,
  };
  return candidates.sort((left, right) => {
    const byType = priority[left.type] - priority[right.type];
    if (byType !== 0) return byType;
    return left.ref.path < right.ref.path ? -1 : left.ref.path > right.ref.path ? 1 : 0;
  });
}
