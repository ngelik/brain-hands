import type { RunManifestV2 } from "../core/types.js";

export type SemanticBoundary =
  | "discovery_answer"
  | "discovery_approach"
  | "discovery_brief_approval"
  | "plan_approval"
  | "manual_delivery_authority"
  | "operational_blocker"
  | "terminal";

export function classifySemanticBoundary(manifest: RunManifestV2): SemanticBoundary | null {
  if (manifest.terminal !== null || manifest.stage === "complete" || manifest.delivery_state === "complete") {
    return "terminal";
  }
  if (manifest.stage === "awaiting_discovery_answer") return "discovery_answer";
  if (manifest.stage === "awaiting_discovery_approach") return "discovery_approach";
  if (manifest.stage === "awaiting_discovery_brief_approval") return "discovery_brief_approval";
  if (manifest.delivery_state === "blocked") return "operational_blocker";
  if (manifest.stage === "awaiting_plan_approval") return "plan_approval";
  if (manifest.mode === "github" && manifest.stage === "delivery" && manifest.delivery_state === "ready") {
    return "manual_delivery_authority";
  }
  if (manifest.mode === "local" && manifest.stage === "delivery" && manifest.delivery_state === "ready") {
    return "terminal";
  }
  return null;
}
