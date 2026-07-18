import { describe, expect, it } from "vitest";
import type {
  AcceptanceCriterion,
  NormalizeReviewInput,
  ReleaseGuardFailure,
  ReviewDisposition,
  VerificationEvidence,
  VerifierReview,
} from "../../src/core/types.js";
import { criterionAliasesForAcceptance, normalizeReviewInputs } from "../../src/workflow/review-normalizer.js";
import { verifierReviewSchema } from "../../src/core/schema.js";

const criteria: AcceptanceCriterion[] = [
  { ref: "BH-005:AC-1", text: "The implementation is correct" },
  { ref: "BH-005:AC-3", text: "Required verification passes" },
];
const severityDefaults: Record<"critical" | "high" | "medium" | "low", ReviewDisposition> = {
  critical: "blocking",
  high: "blocking",
  medium: "fix_in_scope",
  low: "advisory",
};
const passedEvidence: VerificationEvidence = {
  verification_scope: "github",
  work_item_id: "item-5",
  issue_number: 5,
  attempt: 1,
  evidence_path: "verification/issue-5/attempt-1/evidence.json",
  commands: [{
    command: "npm test",
    argv: ["npm", "test"],
    exit_code: 0,
    timed_out: false,
    error_code: null,
    error_message: null,
    signal: null,
    stdout_path: "verification/issue-5/attempt-1/command-1.stdout.txt",
    stderr_path: "verification/issue-5/attempt-1/command-1.stderr.txt",
    result_path: "verification/issue-5/attempt-1/command-1.json",
  }],
  artifacts: [],
  artifact_checks: [],
  browser_evidence: [],
  created_at: "2026-07-11T00:00:00.000Z",
};
const approvedReview: VerifierReview = {
  work_item_id: "item-5",
  attempt: 1,
  final: false,
  decision: "approve",
  failure_class: "none",
  blocker: null,
  blocker_code: null,
  acceptance_coverage: ["The implementation is correct"],
  evidence_reviewed: ["verification/issue-5/attempt-1/evidence.json"],
  findings: [],
  residual_risks: [],
};

function input(overrides: Partial<NormalizeReviewInput> = {}): NormalizeReviewInput {
  return {
    work_item_id: "item-5",
    phase: "work_item",
    review_revision: 1,
    review: approvedReview,
    verification: passedEvidence,
    criteria,
    release_guards: [
      { id: "release:no-secrets", description: "No secrets are committed" },
      { id: "release:no-auto-merge", description: "Pull requests are never auto-merged" },
      { id: "release:required-verification", description: "Required verification passes" },
    ],
    severity_defaults: severityDefaults,
    verification_criterion_ref: "BH-005:AC-3",
    ...overrides,
  };
}

function findingReview(overrides: Partial<VerifierReview> = {}): VerifierReview {
  return {
    ...approvedReview,
    decision: "request_changes",
    failure_class: "implementation_failure",
    findings: [{
      severity: "medium",
      file: "src/example.ts",
      line: 12,
      acceptance_criterion: "BH-005:AC-1",
      problem_class: "correctness",
      problem: "The implementation returns the wrong value",
      required_fix: "Return the approved value",
      evidence_refs: ["verification/claims/correctness.json"],
      re_verification: [["npm", "test"]],
    }],
    ...overrides,
  };
}

describe("normalizeReviewInputs", () => {
  it.each([
    ["approve with blocker", { review: { ...approvedReview, blocker: "Cannot inspect output" } }],
    ["unknown criterion", { review: findingReview({ findings: [{ ...findingReview().findings[0], acceptance_criterion: "BH-999:AC-1" }] }) }],
    ["high advisory", { review: findingReview({ findings: [{ ...findingReview().findings[0], severity: "high" }] }), severity_defaults: { ...severityDefaults, high: "advisory" as const } }],
    ["malformed evidence", { review: findingReview({ evidence_reviewed: ["../outside.json"] }) }],
  ])("rejects %s as an invalid Verifier contract", (_label, overrides) => {
    expect(normalizeReviewInputs(input(overrides))).toMatchObject({
      findings: [],
      operational_blocker: { code: "invalid_verifier_contract", phase: "work_item" },
    });
  });

  it.each([
    ["approve failure class", { ...approvedReview, failure_class: "implementation_failure" as const }],
    ["approve blocker", { ...approvedReview, blocker: "blocked" }],
    ["approve blocking finding", { ...findingReview(), decision: "approve" as const, failure_class: "none" as const }],
    ["request changes failure class", { ...findingReview(), failure_class: "none" as const }],
    ["request changes empty", { ...findingReview(), findings: [] }],
    ["blocked failure class", { ...approvedReview, decision: "blocked" as const, failure_class: "none" as const, blocker: "offline" }],
    ["blocked empty blocker", { ...approvedReview, decision: "blocked" as const, failure_class: "operational_blocker" as const, blocker: null }],
    ["blocked missing code", { ...approvedReview, decision: "blocked" as const, failure_class: "operational_blocker" as const, blocker: "offline", blocker_code: null }],
    ["operational with infrastructure code", { ...approvedReview, decision: "blocked" as const, failure_class: "operational_blocker" as const, blocker: "offline", blocker_code: "test_infrastructure_failure" as const }],
    ["infrastructure with operational code", { ...approvedReview, decision: "blocked" as const, failure_class: "test_infrastructure_blocker" as const, blocker: "offline", blocker_code: "network_failure" as const }],
    ["approve with code", { ...approvedReview, blocker_code: "network_failure" as const }],
    ["replan failure class", { ...findingReview(), decision: "replan_required" as const, failure_class: "implementation_failure" as const }],
    ["replan empty", { ...approvedReview, decision: "replan_required" as const, failure_class: "replan_required" as const }],
  ])("rejects invalid decision matrix row: %s", (_label, review) => {
    expect(normalizeReviewInputs(input({ review }))).toMatchObject({
      findings: [],
      operational_blocker: { code: "invalid_verifier_contract" },
    });
  });

  it("normalizes advisory-only change requests without making an evaluator decision", () => {
    const result = normalizeReviewInputs(input({ review: findingReview({
      findings: [{ ...findingReview().findings[0], severity: "low" }],
    }) }));
    expect(result.operational_blocker).toBeNull();
    expect(result.findings).toEqual([expect.objectContaining({
      severity: "low",
      disposition: "advisory",
    })]);
  });

  it.each([
    ["operational_blocker", "network_failure"],
    ["test_infrastructure_blocker", "test_infrastructure_failure"],
  ] as const)("normalizes blocked %s as %s", (failureClass, code) => {
    const result = normalizeReviewInputs(input({ review: {
      ...approvedReview,
      decision: "blocked",
      failure_class: failureClass,
      blocker: "The verification service is unavailable",
      blocker_code: code,
    } }));
    expect(result).toMatchObject({
      findings: [],
      operational_blocker: {
        code,
        message: "The verification service is unavailable",
        evidence_refs: approvedReview.evidence_reviewed,
      },
    });
  });

  it("fails closed when a parsed legacy blocked review has no structured blocker code", () => {
    const legacyBlocked = verifierReviewSchema.parse({
      ...approvedReview,
      decision: "blocked",
      failure_class: "operational_blocker",
      blocker: "Legacy transport failure",
      blocker_code: undefined,
    });
    expect(normalizeReviewInputs(input({ review: legacyBlocked }))).toMatchObject({
      findings: [],
      operational_blocker: { code: "invalid_verifier_contract" },
    });
  });

  it("normalizes criterion-backed replan claims with requires_replan disposition", () => {
    const result = normalizeReviewInputs(input({ review: findingReview({
      decision: "replan_required",
      failure_class: "replan_required",
    }) }));
    expect(result.operational_blocker).toBeNull();
    expect(result.findings).toEqual([expect.objectContaining({ disposition: "requires_replan" })]);
  });

  it.each([
    ["critical", "release:no-secrets"],
    ["high", "release:no-auto-merge"],
  ] as const)("keeps %s %s replan claims blocking", (severity, acceptanceCriterion) => {
    const claim = findingReview().findings[0];
    const result = normalizeReviewInputs(input({ review: findingReview({
      decision: "replan_required",
      failure_class: "replan_required",
      findings: [{
        ...claim,
        severity,
        acceptance_criterion: acceptanceCriterion,
        problem_class: "release_guard",
      }],
    }) }));
    expect(result.operational_blocker).toBeNull();
    expect(result.findings).toEqual([expect.objectContaining({
      source: "release_guard",
      severity,
      disposition: "blocking",
    })]);
  });

  it("normalizes a Verifier claim with engine-owned identity and approved provenance", () => {
    const result = normalizeReviewInputs(input({ review: findingReview() }));

    expect(result.operational_blocker).toBeNull();
    expect(result.findings).toEqual([expect.objectContaining({
      finding_id: expect.stringMatching(/^finding:[a-f0-9]{64}$/),
      work_item_id: "item-5",
      source: "verifier",
      severity: "medium",
      disposition: "fix_in_scope",
      criterion_ref: "BH-005:AC-1",
      normalized_location: "src/example.ts:12",
      problem_class: "correctness",
      first_seen_revision: 1,
      last_seen_revision: 1,
      occurrences: 1,
    })]);
  });

  it("maps an unambiguous raw acceptance ID to its canonical criterion ref", () => {
    const review = findingReview({
      findings: [{ ...findingReview().findings[0], acceptance_criterion: "AC-1" }],
    });

    expect(normalizeReviewInputs(input({ review }))).toMatchObject({
      operational_blocker: null,
      findings: [{ criterion_ref: "BH-005:AC-1" }],
    });
  });

  it.each([
    ["work-item", "se-ac-strict"],
    ["integrated", "session-events:se-ac-strict"],
  ])("maps a %s plan acceptance alias to its canonical criterion ref", (_label, alias) => {
    const review = findingReview({
      findings: [{ ...findingReview().findings[0], acceptance_criterion: alias }],
    });
    const criterionAliases = criterionAliasesForAcceptance([
      {
        id: alias,
        statement: "The implementation is correct",
        satisfied_by: ["change-unit"],
      },
    ], criteria);

    expect(normalizeReviewInputs(input({ review, criterion_aliases: criterionAliases }))).toMatchObject({
      operational_blocker: null,
      findings: [{ criterion_ref: "BH-005:AC-1" }],
    });
  });

  it("does not create a plan acceptance alias when canonical criterion text is ambiguous", () => {
    expect(criterionAliasesForAcceptance([
      {
        id: "se-ac-strict",
        statement: "The implementation is correct",
        satisfied_by: ["change-unit"],
      },
    ], [...criteria, { ref: "BH-006:AC-1", text: "The implementation is correct" }])).toEqual({});
  });

  it("rejects a raw acceptance ID that is ambiguous across canonical refs", () => {
    const review = findingReview({
      findings: [{ ...findingReview().findings[0], acceptance_criterion: "AC-1" }],
    });

    expect(normalizeReviewInputs(input({
      review,
      criteria: [...criteria, { ref: "BH-006:AC-1", text: "Another criterion" }],
    }))).toMatchObject({
      findings: [],
      operational_blocker: { code: "invalid_verifier_contract" },
    });
  });

  it("turns a failed required command into an engine finding", () => {
    const verification = {
      ...passedEvidence,
      commands: [{ ...passedEvidence.commands[0], exit_code: 1 }],
    };
    const result = normalizeReviewInputs(input({ verification }));

    expect(result.operational_blocker).toBeNull();
    expect(result.findings[0]).toMatchObject({
      source: "verification",
      severity: "high",
      disposition: "fix_in_scope",
      criterion_ref: "BH-005:AC-3",
      problem_class: "verification",
    });
  });

  it("normalizes missing required artifacts and failed browser checks as product findings", () => {
    const verification: VerificationEvidence = {
      ...passedEvidence,
      artifact_checks: [{ path: "reports/required.json", exists: false, required: true }],
      browser_evidence: [{
        name: "dashboard",
        url: "http://127.0.0.1:3000",
        status: "failed",
        screenshot_artifact: "reports/dashboard.png",
        screenshot_exists: false,
        expected_network: ["/api/status"],
        observed_network: [],
        missing_network: ["/api/status"],
        console_errors: ["render failed"],
        missing_selectors: ["#status"],
        failure_reasons: ["status did not render"],
        evidence_report_path: "reports/dashboard.json",
        skipped_reason: null,
      }],
    };

    const result = normalizeReviewInputs(input({ verification }));
    expect(result.operational_blocker).toBeNull();
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "verification", problem_class: "artifact" }),
      expect.objectContaining({ source: "verification", problem_class: "browser" }),
    ]));
    const artifactFinding = result.findings.find((finding) => finding.problem_class === "artifact")!;
    const browserFinding = result.findings.find((finding) => finding.problem_class === "browser")!;
    expect(artifactFinding.evidence_refs).toEqual([passedEvidence.evidence_path]);
    expect(browserFinding.evidence_refs).toEqual([
      "reports/dashboard.json",
      passedEvidence.evidence_path,
    ].sort());
    expect(browserFinding.evidence_refs).not.toContain("reports/dashboard.png");
  });

  it.each([
    ["EACCES", "permission_failure"],
    ["ENETUNREACH", "network_failure"],
    ["MODEL_CATALOG_UNAVAILABLE", "catalog_failure"],
    ["TRANSPORT_FAILURE", "transport_failure"],
    ["CORRUPT_STATE", "corrupt_state"],
  ] as const)("keeps %s as the %s operational blocker", (errorCode, blockerCode) => {
    const verification = {
      ...passedEvidence,
      commands: [{
        ...passedEvidence.commands[0],
        exit_code: null,
        error_code: errorCode,
        error_message: "verification could not run",
      }],
    };

    expect(normalizeReviewInputs(input({ verification }))).toMatchObject({
      findings: [],
      operational_blocker: { code: blockerCode },
    });
  });

  it("rejects malformed evidence attached to an explicit operational failure", () => {
    expect(normalizeReviewInputs(input({
      operational_failure: {
        code: "permission_failure",
        message: "Cannot read the evidence",
        evidence_refs: ["../../outside.json"],
      },
    }))).toMatchObject({
      findings: [],
      operational_blocker: { code: "invalid_verifier_contract" },
    });
  });

  it("normalizes a failed approved release guard as a blocking release-guard finding", () => {
    const releaseGuardFailures: ReleaseGuardFailure[] = [{
      guard_ref: "release:no-secrets",
      severity: "critical",
      normalized_location: "src/config.ts:1",
      problem_class: "secret-detected",
      problem: "A credential is present in the diff",
      required_fix: "Remove and rotate the credential",
      evidence_refs: ["verification/secrets-scan.json"],
    }];

    const result = normalizeReviewInputs(input({ release_guard_failures: releaseGuardFailures }));
    expect(result.operational_blocker).toBeNull();
    expect(result.findings).toEqual(expect.arrayContaining([expect.objectContaining({
      source: "release_guard",
      criterion_ref: "release:no-secrets",
      severity: "critical",
      disposition: "blocking",
    })]));
  });

  it.each(["final_integrated", "post_pr"] as const)(
    "uses the required-verification release guard during %s normalization",
    (phase) => {
      const verification = {
        ...passedEvidence,
        commands: [{ ...passedEvidence.commands[0], exit_code: 1 }],
      };
      const result = normalizeReviewInputs(input({
        phase,
        verification,
        verification_criterion_ref: "release:required-verification",
      }));
      expect(result.operational_blocker).toBeNull();
      expect(result.findings[0]).toMatchObject({
        source: "release_guard",
        criterion_ref: "release:required-verification",
      });
    },
  );

  it("keeps claim-level evidence separated between findings", () => {
    const first = findingReview().findings[0];
    const result = normalizeReviewInputs(input({ review: findingReview({ findings: [
      { ...first, file: "src/first.ts", evidence_refs: ["verification/claims/first.json"] },
      { ...first, file: "src/second.ts", problem_class: "regression", evidence_refs: ["verification/claims/second.json"] },
    ] }) }));
    expect(result.operational_blocker).toBeNull();
    expect(result.findings.map((finding) => finding.evidence_refs)).toEqual([
      ["verification/claims/first.json"],
      ["verification/claims/second.json"],
    ]);
  });

  it("rejects unsafe claim-level evidence", () => {
    const claim = findingReview().findings[0];
    expect(normalizeReviewInputs(input({ review: findingReview({
      findings: [{ ...claim, evidence_refs: ["../outside.json"] }],
    }) }))).toMatchObject({ operational_blocker: { code: "invalid_verifier_contract" } });
  });

  it.each([
    ["low-first", ["low", "critical"]],
    ["critical-first", ["critical", "low"]],
  ] as const)("merges true duplicate identities conservatively in %s order", (_label, severities) => {
    const base = findingReview().findings[0];
    const findings = severities.map((severity, index) => ({
      ...base,
      severity,
      problem: index === 0 ? "First substantive statement" : "Second substantive statement",
      required_fix: index === 0 ? "First fix" : "Second fix",
      evidence_refs: [`verification/claims/${index + 1}.json`],
    }));
    const result = normalizeReviewInputs(input({ review: findingReview({ findings }) }));
    expect(result.operational_blocker).toBeNull();
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({ severity: "critical", disposition: "blocking" });
    expect(result.findings[0].problem).toContain("First substantive statement");
    expect(result.findings[0].problem).toContain("Second substantive statement");
    expect(result.findings[0].required_fix).toContain("First fix");
    expect(result.findings[0].required_fix).toContain("Second fix");
  });

  it("keeps distinct engine problem classes as distinct finding identities", () => {
    const base = findingReview().findings[0];
    const result = normalizeReviewInputs(input({ review: findingReview({ findings: [
      base,
      { ...base, problem_class: "security", problem: "Authorization is bypassed" },
    ] }) }));
    expect(result.operational_blocker).toBeNull();
    expect(result.findings).toHaveLength(2);
    expect(new Set(result.findings.map((finding) => finding.finding_id)).size).toBe(2);
  });

  it("merges duplicate finding identities and preserves all evidence references", () => {
    const verification = {
      ...passedEvidence,
      commands: [
        { ...passedEvidence.commands[0], exit_code: 1 },
        { ...passedEvidence.commands[0], exit_code: 1, stdout_path: "verification/second.stdout.txt", stderr_path: "verification/second.stderr.txt", result_path: "verification/second.json" },
      ],
    };
    const result = normalizeReviewInputs(input({ verification }));

    expect(result.operational_blocker).toBeNull();
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].evidence_refs).toEqual(expect.arrayContaining([
      "verification/issue-5/attempt-1/command-1.json",
      "verification/second.json",
    ]));
  });
});
