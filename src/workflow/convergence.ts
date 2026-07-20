import { createHash } from "node:crypto";
import { basename, join, posix } from "node:path";
import type {
  ConvergenceRecommendedAction,
  ConvergenceReport,
  EngineFinding,
  FindingSummary,
  ReleaseGuard,
  ReviewAccounting,
  ReviewCycleState,
  ReviewPolicy,
  WarningContinuationAuthorization,
} from "../core/types.js";
import {
  convergenceReportSchema,
  findingIndexSchema,
  releaseGuardSchema,
  reviewAccountingSchema,
  reviewCycleStateSchema,
  reviewPolicySchema,
  verificationEvidenceSchema,
  persistedVerifierReviewSchema,
  warningContinuationAuthorizationSchema,
} from "../core/schema.js";
import {
  readOptionalValidatedArtifact,
  withRunLedgerCompoundTransaction,
  writeCreateOnceValidated,
} from "../core/ledger.js";
import { loadFindingRevisionRecords } from "./findings.js";
import { loadSuccessfulFixProvenanceLocked, type SuccessfulFixProvenance } from "./review-cycle.js";
import { readOwnedEvidenceFile } from "./owned-evidence.js";
import { validatePersistedWarningAuthorization } from "./authorization.js";
import { isReviewEffectAction } from "./review-policy.js";
import { verifierEvidenceBindsVerification } from "./verifier-evidence-binding.js";

export interface WriteConvergenceReportInput {
  run_dir: string;
  cycle: ReviewCycleState;
  policy: ReviewPolicy;
  accounting: ReviewAccounting;
  finding_index: Record<string, FindingSummary>;
  findings: EngineFinding[];
  release_guards: ReleaseGuard[];
  authorization: WarningContinuationAuthorization | null;
}

const blockingDispositions = new Set<EngineFinding["disposition"]>([
  "blocking",
  "fix_in_scope",
  "requires_replan",
]);

function encoded(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

export function convergenceReportPath(
  workItemId: string,
  planRevision: number,
  reviewRevision: number,
): string {
  if (!workItemId.trim()) throw new Error("Convergence work_item_id must be non-empty");
  if (!Number.isInteger(planRevision) || planRevision < 1) {
    throw new Error("Convergence plan_revision must be positive");
  }
  if (!Number.isInteger(reviewRevision) || reviewRevision < 1) {
    throw new Error("Convergence review_revision must be positive");
  }
  return `reviews/convergence/work-item-${encoded(workItemId)}-plan-${planRevision}-review-${reviewRevision}.json`;
}

function policyHash(policy: ReviewPolicy): string {
  return createHash("sha256").update(JSON.stringify(policy)).digest("hex");
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function recommendedAction(action: ReviewCycleState["decision"]["action"]): ConvergenceRecommendedAction {
  if (action === "advance" || action === "continue_with_warning") return "advance";
  if (action === "create_replan") return "create_replan";
  if (action === "await_plan_approval") {
    throw new Error("await_plan_approval must reuse the pending replan convergence report");
  }
  if (action === "stop") return "stop";
  if (isReviewEffectAction(action)) {
    throw new Error("Fix decisions do not produce convergence reports");
  }
  throw new Error(`Unsupported convergence action: ${action satisfies never}`);
}

function canonicalBytes(value: unknown): string {
  return JSON.stringify(value);
}

function assertEqual(label: string, actual: unknown, expected: unknown): void {
  if (canonicalBytes(actual) !== canonicalBytes(expected)) {
    throw new Error(`Convergence ${label} provenance does not match the run ledger`);
  }
}

function buildReport(
  input: WriteConvergenceReportInput,
  fixProvenance: SuccessfulFixProvenance,
  currentEvidenceRefs: string[],
): ConvergenceReport {
  const activeIds = new Set(input.findings.map((finding) => finding.finding_id));
  const unresolved = input.findings
    .filter((finding) => blockingDispositions.has(finding.disposition));
  const unresolvedIds = sortedUnique(unresolved.map((finding) => finding.finding_id));
  const resolvedIds = sortedUnique(Object.values(input.finding_index)
    .filter((summary) => summary.work_item_id === input.cycle.work_item_id && !activeIds.has(summary.finding_id))
    .map((summary) => summary.finding_id));
  const repeatedIds = sortedUnique(input.findings
    .filter((finding) => finding.occurrences > 1)
    .map((finding) => finding.finding_id));
  const advisoryIds = sortedUnique(input.findings
    .filter((finding) => finding.disposition === "advisory")
    .map((finding) => finding.finding_id));
  const followUpIds = sortedUnique(input.findings
    .filter((finding) => finding.disposition === "follow_up")
    .map((finding) => finding.finding_id));
  const guardIds = new Set(input.release_guards.map((guard) => guard.id));
  const remainingGuards = sortedUnique(unresolved
    .filter((finding) => finding.source === "release_guard")
    .map((finding) => finding.criterion_ref));
  if (remainingGuards.some((guard) => !guardIds.has(guard))) {
    throw new Error("Convergence release-guard finding is not present in the snapshotted guards");
  }
  return convergenceReportSchema.parse({
    work_item_id: input.cycle.work_item_id,
    policy_revision: input.policy.policy_revision,
    max_fix_cycles: input.policy.max_fix_cycles,
    plan_revision: input.accounting.plan_revision,
    review_revision: input.accounting.review_revision,
    fix_cycles_used: fixProvenance.successful_hands_fixes,
    self_review_mutations_used: input.accounting.self_review_mutations_used,
    unresolved_finding_ids: unresolvedIds,
    resolved_finding_ids: resolvedIds,
    repeated_finding_ids: repeatedIds,
    advisory_finding_ids: advisoryIds,
    follow_up_finding_ids: followUpIds,
    evidence_refs: sortedUnique([
      ...input.findings.flatMap((finding) => finding.evidence_refs),
      ...fixProvenance.evidence_refs,
      ...currentEvidenceRefs,
    ]),
    remaining_release_guards: remainingGuards,
    authorization: input.authorization,
    decision_reason_code: input.cycle.decision.reason_code,
    recommended_action: recommendedAction(input.cycle.decision.action),
  });
}

export async function loadCurrentCycleEvidence(
  runDir: string,
  cycle: ReviewCycleState,
): Promise<string[]> {
  const reference = cycle.work_item_progress_reference;
  if (!reference) throw new Error("Convergence requires cycle-owned work-item progress evidence");
  const safeWorkItem = cycle.work_item_id.replace(/[^a-zA-Z0-9._-]/g, "_");
  const expectedReviewStem = cycle.phase === "work_item"
    ? `reviews/${safeWorkItem}/attempt-${reference.attempts}`
    : `reviews/integrated/final-attempt-${reference.attempts}`;
  const resumeMatch = reference.review_path.match(/-resume-(\d+)\.json$/);
  const validReviewPath = reference.review_path === `${expectedReviewStem}.json`
    || (reference.review_path.startsWith(`${expectedReviewStem}-resume-`)
      && resumeMatch !== null
      && Number(resumeMatch[1]) >= 2);
  if (!validReviewPath) {
    throw new Error("Cycle-owned review path does not match its work item and revision");
  }
  const review = persistedVerifierReviewSchema.parse(JSON.parse((await readOwnedEvidenceFile(
    runDir, reference.review_path, `reviews/${safeWorkItem}/`,
  )).toString("utf8")));
  if (
    !review
    || review.work_item_id !== cycle.work_item_id
    || review.attempt !== reference.attempts
    || review.final !== (cycle.phase !== "work_item")
  ) throw new Error("Cycle-owned review artifact provenance does not match its work item and revision");
  const currentRunPrefix = `runs/${basename(runDir)}/`;
  let foreignRunEvidence = false;
  const reviewedPaths = review.evidence_reviewed.map((path) => {
    if (!path.startsWith("runs/")) return path;
    if (!path.startsWith(currentRunPrefix)) {
      foreignRunEvidence = true;
      return path;
    }
    return path.slice(currentRunPrefix.length);
  });
  const bindsVerification = verifierEvidenceBindsVerification(reviewedPaths, reference.verification_path);
  if (
    foreignRunEvidence
    || !bindsVerification
    || review.evidence_reviewed.some((path) => path.includes("\\"))
    || reviewedPaths.some((path) =>
      path.startsWith("verification/")
      && (posix.isAbsolute(path) || posix.normalize(path) !== path))
  ) throw new Error("Cycle-owned review evidence_reviewed does not bind the canonical cycle verification path, its owned attempt evidence, or separators");
  const verification = verificationEvidenceSchema.parse(JSON.parse((await readOwnedEvidenceFile(
    runDir, reference.verification_path, "verification/",
  )).toString("utf8")));
  if (
    !verification
    || verification.attempt !== reference.attempts
    || verification.evidence_path !== reference.verification_path
  ) throw new Error("Cycle-owned verification artifact provenance does not match its revision and path");
  return [reference.review_path, reference.verification_path];
}

export async function writeConvergenceReport(
  rawInput: WriteConvergenceReportInput,
): Promise<string> {
  if (Object.prototype.hasOwnProperty.call(rawInput, "evidence_refs")) {
    throw new Error("Caller-supplied evidence_refs cannot override cycle-owned convergence evidence");
  }
  const input: WriteConvergenceReportInput = {
    ...rawInput,
    cycle: reviewCycleStateSchema.parse(rawInput.cycle),
    policy: reviewPolicySchema.parse(rawInput.policy),
    accounting: reviewAccountingSchema.parse(rawInput.accounting),
    finding_index: findingIndexSchema.parse(rawInput.finding_index),
    release_guards: rawInput.release_guards.map((guard) => releaseGuardSchema.parse(guard)),
    authorization: rawInput.authorization === null
      ? null
      : warningContinuationAuthorizationSchema.parse(rawInput.authorization),
  };
  if (input.cycle.effect_state !== "pending") {
    throw new Error("Convergence report must be written before the decision effect starts");
  }
  recommendedAction(input.cycle.decision.action);

  return withRunLedgerCompoundTransaction(input.run_dir, async (transaction) => {
    const manifest = await transaction.readManifestV2();
    assertEqual("policy", input.policy, manifest.review_policy_snapshot);
    assertEqual("accounting", input.accounting, manifest.review_accounting);
    assertEqual("finding index", input.finding_index, manifest.finding_index ?? {});
    assertEqual("release guards", input.release_guards, manifest.release_guards ?? []);
    if (input.cycle.policy_hash !== policyHash(input.policy)) {
      throw new Error("Convergence cycle policy provenance does not match the snapshotted policy");
    }
    if (input.cycle.review_revision !== input.accounting.review_revision) {
      throw new Error("Convergence cycle review revision does not match accounting");
    }
    const approvedRevision = manifest.approved_revision ?? manifest.approved_plan_revision;
    if (approvedRevision !== input.accounting.plan_revision) {
      throw new Error("Convergence plan revision does not match the approved plan");
    }
    const persistedCycle = await readOptionalValidatedArtifact(
      transaction.runDir,
      input.cycle.decision_path,
      reviewCycleStateSchema,
    );
    assertEqual("review cycle", input.cycle, persistedCycle);
    const canonicalFindings = await loadFindingRevisionRecords(
      transaction.runDir,
      input.cycle.work_item_id,
      input.cycle.review_revision,
      input.cycle.finding_ids,
    );
    assertEqual("finding records", input.findings, canonicalFindings);
    const fixProvenance = await loadSuccessfulFixProvenanceLocked(transaction, input.accounting);
    const currentEvidenceRefs = await loadCurrentCycleEvidence(transaction.runDir, input.cycle);
    if (input.cycle.decision.action === "continue_with_warning") {
      if (input.authorization === null) {
        throw new Error("Warning advancement requires an authoritative authorization artifact");
      }
      await validatePersistedWarningAuthorization({
        run_dir: transaction.runDir,
        work_item_id: input.cycle.work_item_id,
        review_revision: input.cycle.review_revision,
        policy: input.policy,
        findings: canonicalFindings,
        evidence_snapshot: sortedUnique([
          ...canonicalFindings.flatMap((finding) => finding.evidence_refs),
          ...currentEvidenceRefs,
        ]),
        authorization: input.authorization,
      });
    } else if (input.authorization !== null) {
      throw new Error("Authoritative authorization can only be recorded for warning continuation");
    }
    const report = buildReport(input, fixProvenance, currentEvidenceRefs);
    const relativePath = convergenceReportPath(
      report.work_item_id,
      report.plan_revision,
      report.review_revision,
    );
    const existing = await readOptionalValidatedArtifact(
      transaction.runDir,
      relativePath,
      convergenceReportSchema,
    );
    if (existing) {
      if (canonicalBytes(existing) !== canonicalBytes(report)) {
        throw new Error(`Convergence report already exists with different content: ${relativePath}`);
      }
    } else {
      await writeCreateOnceValidated(transaction.runDir, relativePath, report, convergenceReportSchema);
    }
    const summary = {
      path: relativePath,
      plan_revision: report.plan_revision,
      review_revision: report.review_revision,
      recommended_action: report.recommended_action,
    };
    const currentSummary = manifest.convergence_reports?.[report.work_item_id];
    if (currentSummary && currentSummary.review_revision > report.review_revision) {
      throw new Error("Convergence manifest pointer cannot move backwards");
    }
    if (currentSummary && currentSummary.review_revision === report.review_revision) {
      assertEqual("manifest summary", summary, currentSummary);
    } else {
      await transaction.updateManifestV2({
        convergence_reports: {
          ...(manifest.convergence_reports ?? {}),
          [report.work_item_id]: summary,
        },
      });
    }
    return join(input.run_dir, relativePath);
  });
}
