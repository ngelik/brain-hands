import { z } from "zod";
import { discoveredBrainPlanSchema, brainPlanSchema } from "../core/schema.js";
import { planReadinessDiagnostics, type PlanReadinessDiagnostic } from "../core/execution-spec.js";
import { readManifestV2 } from "../core/ledger.js";
import { readOwnedEvidenceFile } from "../core/owned-evidence.js";
import type { BrainPlan, DiscoveredBrainPlan } from "../core/types.js";
import { planIssueNamingDiagnostics } from "../core/issue-naming.js";
import { formatParentIssueTitle, formatWorkItemIssueTitle } from "../core/issue-naming.js";
import { usesDurableDiscoveryProtocol } from "../core/run-state.js";
import { verifyDiscoveryPlanCandidate } from "./verified-plan.js";

export interface PlanCheckResult {
  ready: boolean;
  diagnostics: PlanReadinessDiagnostic[];
}

function schemaDiagnostics(error: z.ZodError): PlanReadinessDiagnostic[] {
  return error.issues.slice(0, 128).map((issue) => ({
    code: "plan.schema",
    path: `/${issue.path.map(String).join("/")}`,
    message: issue.message.slice(0, 240),
  }));
}

export async function checkPlanCandidate(runDir: string, candidatePath: string): Promise<PlanCheckResult> {
  if (!candidatePath.startsWith("plans/")) throw new Error("Plan candidate must be a run-relative path below plans/");
  const manifest = await readManifestV2(runDir);
  let plan: BrainPlan;
  try {
    const raw = JSON.parse((await readOwnedEvidenceFile(runDir, candidatePath, "plans/")).toString("utf8")) as unknown;
    plan = usesDurableDiscoveryProtocol(manifest.workflow_protocol)
      ? discoveredBrainPlanSchema.parse(raw) as DiscoveredBrainPlan
      : brainPlanSchema.parse(raw) as BrainPlan;
  } catch (error) {
    if (error instanceof z.ZodError) return { ready: false, diagnostics: schemaDiagnostics(error) };
    throw error;
  }
  const diagnostics = [
    ...planReadinessDiagnostics(plan, { mode: manifest.mode, repoRoot: manifest.repo_root }),
    ...planIssueNamingDiagnostics(plan),
  ];
  if (diagnostics.length === 0 && usesDurableDiscoveryProtocol(manifest.workflow_protocol)) {
    try {
      await verifyDiscoveryPlanCandidate(runDir, manifest, plan as DiscoveredBrainPlan);
    } catch (error) {
      diagnostics.push({
        code: "plan.discovery_binding",
        path: "/discovery_decision_coverage",
        message: (error instanceof Error ? error.message : String(error)).slice(0, 240),
      });
    }
  }
  return { ready: diagnostics.length === 0, diagnostics };
}
