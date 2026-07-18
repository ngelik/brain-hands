import { readVerifiedDiscoveryBrief } from "../core/discovery-ledger.js";
import { parseExecutionPlan, validateDiscoveryCoverage } from "../core/execution-spec.js";
import { readManifestV2, readVerifiedPlanRevision } from "../core/ledger.js";
import type { BrainPlan, DiscoveredBrainPlan, DiscoveryBrief, RunManifestV2 } from "../core/types.js";

export interface VerifiedPlanBundle {
  manifest: RunManifestV2;
  plan: BrainPlan;
  brief: DiscoveryBrief | null;
  revision: number;
}

/** Load one exact plan revision and its durable discovery binding from fresh owned evidence. */
export async function loadVerifiedPlanBundle(
  runDir: string,
  expected?: Pick<RunManifestV2, "run_id" | "workflow_protocol">,
  requestedRevision?: number,
): Promise<VerifiedPlanBundle> {
  const manifest = await readManifestV2(runDir);
  if (expected && (manifest.run_id !== expected.run_id || manifest.workflow_protocol !== expected.workflow_protocol)) {
    throw new Error("Plan manifest identity or workflow protocol changed during verification");
  }
  const revision = requestedRevision ?? manifest.current_revision ?? manifest.current_plan_revision;
  if (revision === null || revision === undefined) throw new Error("The run has no plan revision");
  const raw = await readVerifiedPlanRevision(runDir, manifest, revision);
  const plan = parseExecutionPlan(JSON.parse(raw), {
    mode: manifest.mode,
    repoRoot: manifest.repo_root,
  }, manifest.workflow_protocol);
  if (manifest.workflow_protocol === "legacy-v2") return { manifest, plan, brief: null, revision };
  if (manifest.discovery === null) throw new Error("Durable discovered plan requires discovery manifest state");
  const brief = await readVerifiedDiscoveryBrief(runDir);
  const discovered = plan as DiscoveredBrainPlan;
  if (discovered.discovery_brief_revision !== brief.revision) {
    throw new Error(`Plan discovery brief revision does not match approved revision ${brief.revision}`);
  }
  if (discovered.discovery_brief_sha256 !== manifest.discovery.approved_brief_sha256) {
    throw new Error("Plan discovery brief SHA-256 does not match the approved brief");
  }
  validateDiscoveryCoverage(discovered, brief);
  return { manifest, plan, brief, revision };
}

export async function verifyPersistedDiscoveryPlanBinding(
  runDir: string,
  expected: RunManifestV2,
  plan: BrainPlan,
): Promise<void> {
  if (expected.workflow_protocol === "legacy-v2") return;
  const verified = await loadVerifiedPlanBundle(runDir, expected);
  if (JSON.stringify(verified.plan) !== JSON.stringify(plan)) {
    throw new Error("Persisted discovered plan differs from the verified plan revision");
  }
}

/** Verify a newly generated candidate before it becomes a persisted plan revision. */
export async function verifyDiscoveryPlanCandidate(
  runDir: string,
  expected: RunManifestV2,
  plan: BrainPlan,
): Promise<void> {
  if (expected.workflow_protocol === "legacy-v2") return;
  const manifest = await readManifestV2(runDir);
  if (manifest.run_id !== expected.run_id || manifest.workflow_protocol !== expected.workflow_protocol) {
    throw new Error("Plan manifest identity or workflow protocol changed during verification");
  }
  if (manifest.discovery === null) throw new Error("Durable discovered plan requires discovery manifest state");
  const brief = await readVerifiedDiscoveryBrief(runDir);
  const discovered = plan as DiscoveredBrainPlan;
  if (discovered.discovery_brief_revision !== brief.revision) {
    throw new Error(`Plan discovery brief revision does not match approved revision ${brief.revision}`);
  }
  if (discovered.discovery_brief_sha256 !== manifest.discovery.approved_brief_sha256) {
    throw new Error("Plan discovery brief SHA-256 does not match the approved brief");
  }
  validateDiscoveryCoverage(discovered, brief);
}
