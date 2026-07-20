import { isAbsolute } from "node:path";
import { findingRevisionInputSchema, releaseGuardFailureSchema } from "../core/schema.js";
import type {
  EngineFinding,
  FindingRevisionInput,
  FindingSeverity,
  NormalizeReviewInput,
  NormalizedReviewInput,
  OperationalBlocker,
  ReviewDisposition,
  VerifierFinding,
  WorkItem,
} from "../core/types.js";
import { fingerprintFinding } from "./findings.js";

const permissionCodes = new Set(["EACCES", "EPERM", "EROFS"]);
const networkCodes = new Set([
  "EAI_AGAIN", "ECONNABORTED", "ECONNREFUSED", "ECONNRESET", "ENETDOWN",
  "ENETUNREACH", "ENOTFOUND", "ETIMEDOUT",
]);
const catalogCodes = new Set(["CATALOG_FAILURE", "MODEL_CATALOG_UNAVAILABLE", "MODEL_NOT_FOUND"]);
const transportCodes = new Set(["CODEX_UNAVAILABLE", "TRANSPORT_FAILURE", "TRANSPORT_ERROR"]);
const corruptStateCodes = new Set(["CORRUPT_STATE", "INVALID_STATE", "MALFORMED_STATE"]);
const verifierOperationalBlockerCodes = new Set([
  "transport_failure", "permission_failure", "network_failure", "catalog_failure", "corrupt_state",
]);
const severityStrength: Record<FindingSeverity, number> = { low: 0, medium: 1, high: 2, critical: 3 };
const dispositionStrength: Record<ReviewDisposition, number> = {
  advisory: 0,
  follow_up: 1,
  fix_in_scope: 2,
  requires_replan: 3,
  blocking: 4,
};

function validEvidenceRef(value: string): boolean {
  const normalized = value.trim().replaceAll("\\", "/");
  return normalized.length > 0
    && !isAbsolute(normalized)
    && !/^[A-Za-z]:\//.test(normalized)
    && !normalized.split("/").includes("..");
}

function invalidContract(input: NormalizeReviewInput, message: string, evidenceRefs: string[] = []): NormalizedReviewInput {
  return {
    findings: [],
    operational_blocker: {
      code: "invalid_verifier_contract",
      message,
      phase: input.phase,
      evidence_refs: evidenceRefs.filter(validEvidenceRef),
    },
  };
}

function operationalFailure(
  input: NormalizeReviewInput,
  code: OperationalBlocker["code"],
  message: string,
  evidenceRefs: string[],
): NormalizedReviewInput {
  return {
    findings: [],
    operational_blocker: {
      code,
      message,
      phase: input.phase,
      evidence_refs: evidenceRefs.filter(validEvidenceRef),
    },
  };
}

function classifyOperationalCode(code: string | null): OperationalBlocker["code"] | null {
  if (code === null) return null;
  const normalized = code.toUpperCase();
  if (permissionCodes.has(normalized)) return "permission_failure";
  if (networkCodes.has(normalized)) return "network_failure";
  if (catalogCodes.has(normalized)) return "catalog_failure";
  if (transportCodes.has(normalized)) return "transport_failure";
  if (corruptStateCodes.has(normalized)) return "corrupt_state";
  return null;
}

function dispositionFor(
  severity: FindingSeverity,
  defaults: NormalizeReviewInput["severity_defaults"],
  releaseGuard: boolean,
): ReviewDisposition {
  if (releaseGuard && (severity === "critical" || severity === "high")) return "blocking";
  return defaults[severity];
}

function asEngineFinding(input: FindingRevisionInput): EngineFinding {
  const parsed = findingRevisionInputSchema.parse(input);
  const findingId = fingerprintFinding(parsed);
  return {
    finding_id: findingId,
    work_item_id: parsed.work_item_id,
    source: parsed.source,
    severity: parsed.severity,
    disposition: parsed.disposition,
    criterion_ref: parsed.criterion_ref,
    normalized_location: parsed.normalized_location,
    problem_class: parsed.problem_class,
    problem: parsed.problem,
    required_fix: parsed.required_fix,
    evidence_refs: [...new Set(parsed.evidence_refs)].sort(),
    first_seen_revision: parsed.review_revision,
    last_seen_revision: parsed.review_revision,
    occurrences: 1,
  };
}

function mergeAndFingerprint(inputs: FindingRevisionInput[]): EngineFinding[] {
  const merged = new Map<string, EngineFinding>();
  for (const input of inputs) {
    const finding = asEngineFinding(input);
    const existing = merged.get(finding.finding_id);
    if (!existing) {
      merged.set(finding.finding_id, finding);
      continue;
    }
    if (severityStrength[finding.severity] > severityStrength[existing.severity]) {
      existing.severity = finding.severity;
    }
    if (dispositionStrength[finding.disposition] > dispositionStrength[existing.disposition]) {
      existing.disposition = finding.disposition;
    }
    existing.problem = [...new Set([existing.problem, finding.problem])].sort().join("\n\n");
    const fixes = [existing.required_fix, finding.required_fix]
      .filter((fix): fix is string => fix !== null);
    existing.required_fix = fixes.length === 0 ? null : [...new Set(fixes)].sort().join("\n\n");
    existing.evidence_refs = [...new Set([...existing.evidence_refs, ...finding.evidence_refs])].sort();
  }
  return [...merged.values()];
}

function criterionRef(input: NormalizeReviewInput, claim: VerifierFinding): string | null {
  const criterion = input.criteria.find(
    (candidate) => candidate.ref === claim.acceptance_criterion || candidate.text === claim.acceptance_criterion,
  );
  if (criterion) return criterion.ref;
  const aliasedRef = input.criterion_aliases?.[claim.acceptance_criterion];
  if (aliasedRef && input.criteria.some((candidate) => candidate.ref === aliasedRef)) return aliasedRef;
  const rawIdMatches = input.criteria.filter(
    (candidate) => candidate.ref.slice(candidate.ref.lastIndexOf(":") + 1) === claim.acceptance_criterion,
  );
  if (rawIdMatches.length === 1) return rawIdMatches[0]!.ref;
  if (rawIdMatches.length > 1) return null;
  const guard = input.release_guards.find(
    (candidate) => candidate.id === claim.acceptance_criterion || candidate.description === claim.acceptance_criterion,
  );
  return guard?.id ?? null;
}

export function criterionAliasesForAcceptance(
  acceptance: WorkItem["acceptance"],
  criteria: NormalizeReviewInput["criteria"],
): Record<string, string> {
  const aliases: Record<string, string> = {};
  for (const accepted of acceptance) {
    const matches = criteria.filter((criterion) => criterion.text === accepted.statement);
    if (matches.length === 1) aliases[accepted.id] = matches[0]!.ref;
  }
  return aliases;
}

function verifierFindingInput(
  input: NormalizeReviewInput,
  claim: VerifierFinding,
  ref: string,
): FindingRevisionInput {
  const releaseGuard = input.release_guards.some((guard) => guard.id === ref);
  return {
    work_item_id: input.work_item_id,
    source: releaseGuard ? "release_guard" : "verifier",
    severity: claim.severity,
    disposition: releaseGuard && (claim.severity === "critical" || claim.severity === "high")
      ? "blocking"
      : input.review.decision === "replan_required"
        ? "requires_replan"
        : dispositionFor(claim.severity, input.severity_defaults, releaseGuard),
    criterion_ref: ref,
    normalized_location: claim.line === null ? claim.file : `${claim.file}:${claim.line}`,
    problem_class: claim.problem_class!,
    problem: claim.problem,
    required_fix: claim.required_fix,
    evidence_refs: claim.evidence_refs!,
    review_revision: input.review_revision,
  };
}

function verificationRefs(input: NormalizeReviewInput, refs: Array<string | null | undefined>): string[] {
  return [...new Set([input.verification.evidence_path, ...refs].filter((ref): ref is string => Boolean(ref)))];
}

function verificationFindingInputs(input: NormalizeReviewInput): FindingRevisionInput[] {
  const findings: FindingRevisionInput[] = [];
  const releaseGuard = input.verification_criterion_ref === "release:required-verification";
  const source = releaseGuard ? "release_guard" : "verification";
  const disposition: ReviewDisposition = releaseGuard ? "blocking" : "fix_in_scope";
  for (const command of input.verification.commands) {
    if (command.exit_code === 0 && !command.timed_out && command.signal === null) continue;
    const commandName = command.argv?.join(" ") || command.command;
    findings.push({
      work_item_id: input.work_item_id,
      source,
      severity: "high",
      disposition,
      criterion_ref: input.verification_criterion_ref,
      normalized_location: `verification:command:${commandName}`,
      problem_class: "verification",
      problem: `Required command failed: ${commandName}`,
      required_fix: "Correct the product failure and rerun the required command.",
      evidence_refs: verificationRefs(input, [command.result_path, command.stdout_path, command.stderr_path]),
      review_revision: input.review_revision,
    });
  }
  for (const artifact of input.verification.artifact_checks) {
    if (!artifact.required || artifact.exists) continue;
    findings.push({
      work_item_id: input.work_item_id,
      source,
      severity: "high",
      disposition,
      criterion_ref: input.verification_criterion_ref,
      normalized_location: artifact.path,
      problem_class: "artifact",
      problem: `Required artifact is missing: ${artifact.path}`,
      required_fix: "Produce the required artifact and rerun verification.",
      evidence_refs: verificationRefs(input, []),
      review_revision: input.review_revision,
    });
  }
  for (const browser of input.verification.browser_evidence) {
    if (browser.status === "passed") continue;
    findings.push({
      work_item_id: input.work_item_id,
      source,
      severity: "high",
      disposition,
      criterion_ref: input.verification_criterion_ref,
      normalized_location: browser.screenshot_artifact,
      problem_class: "browser",
      problem: `Required browser check failed: ${browser.name}`,
      required_fix: "Correct the browser-visible product failure and rerun the browser check.",
      evidence_refs: verificationRefs(input, [
        browser.evidence_report_path,
        browser.screenshot_exists ? browser.screenshot_artifact : undefined,
      ]),
      review_revision: input.review_revision,
    });
  }
  return findings;
}

export function normalizeReviewInputs(input: NormalizeReviewInput): NormalizedReviewInput {
  if (input.operational_failure) {
    if (input.operational_failure.evidence_refs.some((ref) => !validEvidenceRef(ref))) {
      return invalidContract(input, "Operational failure evidence references must be relative paths");
    }
    return operationalFailure(
      input,
      input.operational_failure.code,
      input.operational_failure.message,
      input.operational_failure.evidence_refs,
    );
  }
  if (!Number.isInteger(input.review_revision) || input.review_revision < 1) {
    return invalidContract(input, "Review revision must be a positive integer");
  }
  if (input.review.work_item_id !== input.work_item_id) {
    return invalidContract(input, "Verifier work item provenance does not match normalization input");
  }
  const allEvidenceRefs = [
    ...input.review.evidence_reviewed,
    ...input.review.findings.flatMap((finding) => finding.evidence_refs ?? []),
    ...(input.verification.evidence_path ? [input.verification.evidence_path] : []),
    ...input.verification.commands.flatMap((command) => [command.stdout_path, command.stderr_path, command.result_path].filter((ref): ref is string => Boolean(ref))),
    ...input.verification.browser_evidence.flatMap((browser) => [
      browser.evidence_report_path,
      browser.screenshot_exists ? browser.screenshot_artifact : undefined,
    ].filter((ref): ref is string => Boolean(ref))),
  ];
  if (allEvidenceRefs.some((ref) => !validEvidenceRef(ref))) {
    return invalidContract(input, "Evidence references must be non-empty relative paths inside their approved roots");
  }
  if (input.severity_defaults.critical !== "blocking" || input.severity_defaults.high !== "blocking") {
    return invalidContract(input, "Critical and high Verifier claims cannot be downgraded", input.review.evidence_reviewed);
  }
  const verificationCriterion = input.criteria.some(
    (criterion) => criterion.ref === input.verification_criterion_ref,
  );
  const requiredVerificationGuard = input.verification_criterion_ref === "release:required-verification"
    && input.release_guards.some((guard) => guard.id === input.verification_criterion_ref);
  if (!verificationCriterion && !requiredVerificationGuard) {
    return invalidContract(input, "Verification failures must reference an approved criterion or required-verification guard");
  }

  const normalized: FindingRevisionInput[] = [];
  for (const claim of input.review.findings) {
    const ref = criterionRef(input, claim);
    if (ref === null) {
      return invalidContract(input, `Verifier finding references unknown criterion: ${claim.acceptance_criterion}`, input.review.evidence_reviewed);
    }
    if (!claim.problem_class || !claim.evidence_refs || claim.evidence_refs.length === 0) {
      return invalidContract(input, "Verifier findings require an engine problem class and claim-level evidence");
    }
    const finding = verifierFindingInput(input, claim, ref);
    normalized.push(finding);
  }

  const failureClass = input.review.failure_class ?? "none";
  if (input.review.decision === "approve") {
    if (
      failureClass !== "none"
      || input.review.blocker !== null
      || input.review.blocker_code !== null
      || normalized.some((finding) => !["advisory", "follow_up"].includes(finding.disposition))
    ) return invalidContract(input, "Verifier approval contradicts its failure, blocker, or finding claims");
  } else if (input.review.decision === "request_changes") {
    if (
      failureClass !== "implementation_failure"
      || input.review.blocker !== null
      || input.review.blocker_code !== null
      || normalized.length === 0
    ) {
      return invalidContract(input, "Verifier change request requires implementation failure and at least one finding");
    }
  } else if (input.review.decision === "blocked") {
    const blockerCode = input.review.blocker_code;
    const compatibleCode = failureClass === "operational_blocker"
      ? typeof blockerCode === "string" && verifierOperationalBlockerCodes.has(blockerCode)
      : failureClass === "test_infrastructure_blocker" && blockerCode === "test_infrastructure_failure";
    if (
      !["operational_blocker", "test_infrastructure_blocker"].includes(failureClass)
      || typeof input.review.blocker !== "string"
      || input.review.blocker.trim() === ""
      || typeof blockerCode !== "string"
      || !compatibleCode
    ) return invalidContract(input, "Verifier blocked claim requires a matching failure class and blocker");
    return operationalFailure(
      input,
      blockerCode,
      input.review.blocker,
      input.review.evidence_reviewed,
    );
  } else if (
    failureClass !== "replan_required"
    || input.review.blocker !== null
    || input.review.blocker_code !== null
    || normalized.length === 0
  ) {
    return invalidContract(input, "Verifier replan claim requires replan classification and a backed finding");
  }

  for (const command of input.verification.commands) {
    const blockerCode = classifyOperationalCode(command.error_code);
    const refs = verificationRefs(input, [command.result_path, command.stdout_path, command.stderr_path]);
    if (blockerCode) {
      return operationalFailure(input, blockerCode, command.error_message ?? `Verification failed with ${command.error_code}`, refs);
    }
    if (command.exit_code === null && !command.timed_out && command.signal === null) {
      return operationalFailure(input, "corrupt_state", "Verification command has no deterministic result", refs);
    }
  }

  for (const rawFailure of input.release_guard_failures ?? []) {
    const parsed = releaseGuardFailureSchema.safeParse(rawFailure);
    if (!parsed.success || !input.release_guards.some((guard) => guard.id === rawFailure.guard_ref)) {
      return invalidContract(input, `Release-guard failure references an unknown or malformed guard: ${rawFailure.guard_ref}`);
    }
    normalized.push({
      work_item_id: input.work_item_id,
      source: "release_guard",
      severity: parsed.data.severity,
      disposition: dispositionFor(parsed.data.severity, input.severity_defaults, true),
      criterion_ref: parsed.data.guard_ref,
      normalized_location: parsed.data.normalized_location,
      problem_class: parsed.data.problem_class,
      problem: parsed.data.problem,
      required_fix: parsed.data.required_fix,
      evidence_refs: parsed.data.evidence_refs,
      review_revision: input.review_revision,
    });
  }

  const verificationFindings = verificationFindingInputs(input);
  if (input.phase === "work_item" && input.review.decision === "approve" && verificationFindings.length > 0) {
    return invalidContract(
      input,
      "Verifier approval contradicts failed required verification evidence",
      verificationFindings.flatMap((finding) => finding.evidence_refs),
    );
  }

  try {
    return {
      findings: mergeAndFingerprint([
        ...normalized,
        ...(input.phase === "work_item" ? [] : verificationFindings),
      ]),
      operational_blocker: null,
    };
  } catch (error) {
    return invalidContract(input, `Malformed normalized finding: ${error instanceof Error ? error.message : String(error)}`);
  }
}
