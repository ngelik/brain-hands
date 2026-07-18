import type {
  EngineFinding,
  ReviewPolicy,
  WarningContinuationAuthorization,
} from "../core/types.js";
import { warningContinuationAuthorizationSchema } from "../core/schema.js";
import {
  readManifestV2,
  readOptionalValidatedArtifact,
  writeCreateOnceValidated,
} from "../core/ledger.js";

const blockingDispositions = new Set<EngineFinding["disposition"]>([
  "blocking",
  "fix_in_scope",
  "requires_replan",
]);

export interface WarningAuthorizationInput {
  run_dir: string;
  work_item_id: string;
  review_revision: number;
  policy: ReviewPolicy;
  findings: EngineFinding[];
  evidence_snapshot: string[];
}

function encoded(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

export function warningAuthorizationPath(workItemId: string, reviewRevision: number): string {
  if (!workItemId.trim()) throw new Error("Warning authorization work_item_id must be non-empty");
  if (!Number.isInteger(reviewRevision) || reviewRevision < 1) {
    throw new Error("Warning authorization review_revision must be positive");
  }
  return `authorizations/${encoded(workItemId)}/revision-${reviewRevision}.json`;
}

function expectedBinding(input: WarningAuthorizationInput) {
  const blocking = input.findings.filter((finding) => blockingDispositions.has(finding.disposition));
  if (blocking.some((finding) =>
    finding.source === "release_guard"
    && (finding.severity === "critical" || finding.severity === "high"))) {
    throw new Error("Warning authorization cannot cover a critical/high release blocker");
  }
  return {
    finding_ids: sortedUnique(blocking.map((finding) => finding.finding_id)),
    evidence_snapshot: sortedUnique(input.evidence_snapshot),
  };
}

function assertBinding(
  authorization: WarningContinuationAuthorization,
  input: WarningAuthorizationInput,
  actor: string,
  source: WarningContinuationAuthorization["source"],
): void {
  const expected = expectedBinding(input);
  if (
    authorization.actor !== actor
    || authorization.source !== source
    || authorization.policy_revision !== input.policy.policy_revision
    || JSON.stringify(authorization.finding_ids) !== JSON.stringify(expected.finding_ids)
    || JSON.stringify(authorization.evidence_snapshot) !== JSON.stringify(expected.evidence_snapshot)
  ) throw new Error("Warning authorization artifact provenance binding does not match the active review");
}

export async function loadOrCreateWarningAuthorization(
  input: WarningAuthorizationInput,
): Promise<WarningContinuationAuthorization | null> {
  if (input.policy.on_limit !== "continue_with_warning") return null;
  const binding = expectedBinding(input);
  if (binding.finding_ids.length === 0) return null;
  const manifest = await readManifestV2(input.run_dir);
  const authority = manifest.warning_continuation_authority;
  if (!authority) return null;
  if (JSON.stringify(manifest.review_policy_snapshot) !== JSON.stringify(input.policy)) {
    throw new Error("Warning authorization policy provenance does not match the run snapshot");
  }
  const path = warningAuthorizationPath(input.work_item_id, input.review_revision);
  const existing = await readOptionalValidatedArtifact(
    input.run_dir,
    path,
    warningContinuationAuthorizationSchema,
  );
  if (existing) {
    assertBinding(existing, input, authority.actor, authority.source);
    return existing;
  }
  const authorization = warningContinuationAuthorizationSchema.parse({
    actor: authority.actor,
    source: authority.source,
    finding_ids: binding.finding_ids,
    reason: "Bounded warning continuation was explicitly authorized for this run",
    residual_risk: `Unresolved findings remain: ${binding.finding_ids.join(", ")}`,
    evidence_snapshot: binding.evidence_snapshot,
    timestamp: new Date().toISOString(),
    policy_revision: input.policy.policy_revision,
  });
  await writeCreateOnceValidated(
    input.run_dir,
    path,
    authorization,
    warningContinuationAuthorizationSchema,
  );
  return authorization;
}

export async function validatePersistedWarningAuthorization(
  input: WarningAuthorizationInput & { authorization: WarningContinuationAuthorization },
): Promise<WarningContinuationAuthorization> {
  const manifest = await readManifestV2(input.run_dir);
  const authority = manifest.warning_continuation_authority;
  if (!authority) throw new Error("Warning authorization has no durable run authority");
  const persisted = await readOptionalValidatedArtifact(
    input.run_dir,
    warningAuthorizationPath(input.work_item_id, input.review_revision),
    warningContinuationAuthorizationSchema,
  );
  if (!persisted || JSON.stringify(persisted) !== JSON.stringify(input.authorization)) {
    throw new Error("Warning authorization artifact does not match the supplied authorization");
  }
  assertBinding(persisted, input, authority.actor, authority.source);
  return persisted;
}
