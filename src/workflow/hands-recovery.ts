import type {
  HandsBackupPolicy,
  HandsBlockerCode,
  HandsProfileKind,
  VerifierFinding,
  VerifierReview,
  WorkItem,
  WorkItemProgress,
} from "../core/types.js";

export type HandsRecoveryAction =
  | { kind: "approve" }
  | { kind: "primary_fix"; profile: HandsProfileKind }
  | { kind: "quality_recovery"; profile: "backup" }
  | { kind: "block"; blockerCode: HandsBlockerCode }
  | { kind: "replan" };

export function legacyQualityRecoveryAttempts(progress: WorkItemProgress | undefined): number {
  return progress?.quality_recovery_attempts ?? 0;
}

/**
 * Legacy adapter only. Policy-enabled v2 paths must call evaluateReviewPolicy
 * and may not use this function for finding-driven decisions.
 */
export function decideNextHandsAction(input: {
  review: VerifierReview;
  primaryFixAttempts: number;
  qualityRecoveryAttempts: number;
  activeProfile: HandsProfileKind;
  backup: HandsBackupPolicy | undefined;
}): HandsRecoveryAction {
  const failureClass = input.review.failure_class ?? (input.review.decision === "request_changes" ? "implementation_failure" : "none");
  if (input.review.decision === "approve") return { kind: "approve" };
  if (input.review.decision === "replan_required") return { kind: "replan" };
  if (input.review.decision === "blocked" || failureClass === "operational_blocker" || failureClass === "test_infrastructure_blocker") {
    return { kind: "block", blockerCode: failureClass === "test_infrastructure_blocker" ? "test_infrastructure_blocker" : "operational_blocker" };
  }
  if (input.review.decision !== "request_changes" || failureClass !== "implementation_failure") {
    return { kind: "block", blockerCode: "operational_blocker" };
  }
  if (input.primaryFixAttempts < 3) return { kind: "primary_fix", profile: input.activeProfile };
  if (
    input.primaryFixAttempts === 3
    && input.activeProfile === "primary"
    && input.backup
    && input.qualityRecoveryAttempts === 0
  ) return { kind: "quality_recovery", profile: "backup" };
  return { kind: "block", blockerCode: "escalation_exhausted" };
}

export function buildHandsRecoveryPacket(input: {
  workItem: Pick<WorkItem, "id" | "acceptance" | "forbidden_changes">;
  currentDiff: string;
  latestFindings: readonly VerifierFinding[];
  attempts: readonly Record<string, unknown>[];
  verificationPaths: readonly string[];
  changedFiles?: readonly string[];
  commandsAttempted?: readonly (readonly string[])[];
  rawTranscript?: string;
}): string {
  const changedFiles = [...new Set(input.changedFiles ?? [])];
  const seenCommands = new Set<string>();
  const commandsAttempted = (input.commandsAttempted ?? []).filter((command) => {
    const key = JSON.stringify(command);
    if (seenCommands.has(key)) return false;
    seenCommands.add(key);
    return true;
  });
  const packet = [
    "# Independent recovery diagnosis",
    "\n## Approved criteria\n", JSON.stringify(input.workItem.acceptance),
    "\n## Excluded scope\n", JSON.stringify(input.workItem.forbidden_changes),
    "\n## Current diff\n", input.currentDiff.slice(0, 24_000),
    "\n## Unresolved findings\n", JSON.stringify(input.latestFindings),
    "\n## Prior attempts\n", JSON.stringify(input.attempts),
    "\n## Verification artifacts\n", JSON.stringify(input.verificationPaths),
    "\n## Changed files\n", JSON.stringify(changedFiles),
    "\n## Commands attempted\n", JSON.stringify(commandsAttempted),
    "\nForm an independent diagnosis from the approved criteria, current diff, unresolved findings, and saved evidence. Do not repeat a prior edit without explaining why the evidence supports it. Do not widen scope.",
  ].join("");
  return packet.length > 32_000 ? `${packet.slice(0, 31_980)}\n[context truncated]` : packet;
}
