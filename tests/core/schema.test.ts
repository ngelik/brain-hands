import type { z } from "zod";
import { describe, expect, expectTypeOf, it } from "vitest";
import { executionSpec } from "../fixtures/execution-spec.js";
import {
  parseJsonObject,
  browserEvidenceBundleSchema,
  browserEvidenceReportSchema,
  issueSpecSchema,
  brainPlanSchema,
  discoveryOutcomeSchema,
  discoveryQuestionSchema,
  generatedDiscoveryQuestionSchema,
  persistedDiscoveryQuestionSchema,
  reasoningEffortSchema,
  reasoningEffortV2Schema,
  prReviewSchema,
  runManifestSchema,
  runManifestV2Schema,
  recoveryScopeStateV1Schema,
  runRecoveryStateV1Schema,
  taskLineageV1Schema,
  controllerRecoveryStateV1Schema,
  acceptanceCriterionSchema,
  releaseGuardSchema,
  reviewAccountingSchema,
  reviewPolicySchema,
  runEventSchema,
  workItemSchema,
  artifactPathPattern,
  configV2Schema,
  actionResolutionReviewSchema,
  implementationResultSchema,
  planningDiscoveryGapSchema,
  planApprovalRequestSchema,
  reviewerActionSchema,
  strictVerifierReviewSchema,
  verifierFindingSchema,
  verifierReviewSchema,
  verificationEvidenceSchema,
  legacyVerificationEvidenceSchema,
  remoteSynchronizationEvidenceSchema,
  executionSpecV2Schema,
} from "../../src/core/schema.js";
import {
  brainPlanOutputSchema,
  discoveryOutcomeOutputSchema,
  actionResolutionReviewOutputSchema,
  handsSelfReviewReportOutputSchema,
  implementationResultOutputSchema,
  planningDiscoveryGapOutputSchema,
  verifierReviewOutputSchema,
  fixPacketResultV1OutputSchema,
  fixPacketResolutionV1OutputSchema,
} from "../../src/core/output-schemas.js";
import type { BrowserEvidenceReport, IssueSpec, RemoteSynchronizationEvidence } from "../../src/core/types.js";

const strictRemediation = {
  schema_version: 1 as const,
  diagnosis: {
    observed_behavior: "The example fails.", expected_behavior: "The example works.",
    failure_mechanism: "The implementation omits the required behavior.",
    reproduction: ["Run the focused test."], evidence_refs: ["verification/example.json"],
  },
  targets: [{ kind: "code" as const, path: "src/example.ts", symbol: "example", line_hint: null }],
  remediation: {
    strategy: "Implement the missing behavior.",
    change_units: [{ id: "FIX-1", path: "src/example.ts", target: "example", operation: "modify" as const, requirements: ["Make the example satisfy its criterion."], satisfies: ["SC-1"] }],
    allowed_files: ["src/example.ts"], forbidden_changes: [],
  },
  verification: {
    commands: [{ id: "CMD-1", argv: ["npm", "test"] }],
    success_conditions: [{ id: "SC-1", statement: "The example works.", satisfied_by: ["CMD-1", "EVID-1"] }],
    required_evidence: [{ id: "EVID-1", kind: "test_result" as const, source_id: "CMD-1", output_path: "verification/example-result.json" }],
  },
  completion_contract: { required_change_unit_ids: ["FIX-1"], expected_changed_files: ["src/example.ts"], allow_additional_files: false as const },
};

const validIssuePayload = {
  type: "implementation_task",
  run_id: "2026-07-08T12-00-00Z-demo",
  parent_request: "Build a CLI",
  goal: "Create the init command",
  context: "The CLI stores config in .brain-hands/config.yaml",
  scope: { include: ["src/core/config.ts"], exclude: ["network calls"] },
  dependencies: [],
  implementation_steps: ["Create config writer"],
  acceptance_criteria: ["Running brain-hands init creates config.yaml"],
  verification: {
    required_commands: ["npm test -- tests/core/config.test.ts"],
    manual_checks: [],
    expected_artifacts: [".brain-hands/config.yaml"],
  },
  review_checklist: ["Config has model profiles"],
  risk_register: ["Overwriting user config"],
  handoff_prompt: "Implement the config writer only.",
  browser_checks: [
    {
      name: "desktop 3d smoke",
      url: "http://127.0.0.1:5177/solar-system-browser/index.html",
      local_server_command: "python3 -m http.server 5177 --bind 127.0.0.1",
      required_selectors: ["#spaceCanvas"],
      console_error_policy: "no_errors",
      expected_network: ["/solar-system-browser/solar-system.js"],
      screenshot_artifact: "reports/solar-3d-desktop.png",
      viewport: {
        width: 1512,
        height: 738,
        mobile: false,
      },
      wait_ms: 1200,
      require_no_horizontal_overflow: true,
      forbidden_overlaps: [[".toolbar", ".details"]],
    },
  ],
};

describe("issueSpecSchema", () => {
  it("requires acceptance criteria and verification commands", () => {
    const parsed = issueSpecSchema.safeParse(validIssuePayload);

    expect(parsed.success).toBe(true);
  });

  it("rejects issues without verification commands", () => {
    const parsed = issueSpecSchema.safeParse({
      type: "implementation_task",
      run_id: "run",
      parent_request: "Build a CLI",
      goal: "Create init",
      context: "context",
      scope: { include: [], exclude: [] },
      dependencies: [],
      implementation_steps: ["step"],
      acceptance_criteria: ["criterion"],
      verification: {
        required_commands: [],
        manual_checks: [],
        expected_artifacts: [],
      },
      review_checklist: ["check"],
      risk_register: [],
      handoff_prompt: "prompt",
    });

    expect(parsed.success).toBe(false);
  });
});

describe("browserEvidenceReportSchema", () => {
  it("accepts explicit null skipped_reason", () => {
    const parsed = browserEvidenceReportSchema.parse({
      check_name: "desktop smoke",
      url: "https://example.com/",
      status: "skipped",
      observed_selectors: [],
      missing_selectors: [],
      console_errors: [],
      expected_network: ["/api/state"],
      observed_network: [],
      screenshot_artifact: "reports/desktop.png",
      console_error_policy: "allow_errors",
      skipped_reason: null,
    }) as BrowserEvidenceReport;

    expect(parsed.skipped_reason).toBeNull();
  });
});

describe("browserEvidenceBundleSchema", () => {
  it("accepts normalized multi-check browser evidence", () => {
    const parsed = browserEvidenceBundleSchema.parse({
      generated_at: "2026-07-08T12:00:00.000Z",
      status: "passed",
      reports: [
        {
          check_name: "desktop smoke",
          url: "https://example.com/",
          status: "passed",
          observed_selectors: ["#app"],
          missing_selectors: [],
          console_errors: [],
          expected_network: ["/app.js"],
          observed_network: ["/app.js"],
          screenshot_artifact: "reports/desktop.png",
          console_error_policy: "no_errors",
          failure_reasons: [],
          skipped_reason: null,
        },
      ],
    });

    expect(parsed.reports[0].failure_reasons).toEqual([]);
  });
});

describe("parseJsonObject", () => {
  it("parses valid object payloads through an object schema", () => {
    const parsed: IssueSpec = parseJsonObject(
      JSON.stringify(validIssuePayload),
      issueSpecSchema,
    );

    expect(parsed).toEqual(validIssuePayload);
  });

  it("supports explicit output generic parsing", () => {
    const parsed = parseJsonObject<IssueSpec>(
      JSON.stringify(validIssuePayload),
      issueSpecSchema,
    );

    expect(parsed).toEqual(validIssuePayload);
  });

  it("rejects non-object top-level JSON payloads", () => {
    const invalidPayloads = ["42", '"just a scalar"', "null", "true", "[]"];

    for (const payload of invalidPayloads) {
      expect(() => parseJsonObject(payload, issueSpecSchema)).toThrow(
        "Top-level JSON must be an object",
      );
    }
  });
});

describe("discovery schemas", () => {
  const question = {
    id: "q-001",
    sequence: 1,
    category: "required",
    text: "Which workflow should discovery use?",
    choices: [{ id: "durable", label: "Durable", description: "Persist the decision." }],
    recommended_choice_id: "durable",
    recommendation_rationale: "It preserves the durable boundary.",
    rationale: "The answer changes architecture.",
    material_effects: ["architecture"],
    repository_evidence: ["src/core/types.ts defines the workflow contract"],
    essential_after_soft_limit: null,
  };

  it("rejects unknown keys at every discovery object boundary", () => {
    expect(discoveryOutcomeSchema.safeParse({
      outcome: "ask_question",
      question,
      hidden_instruction: "ignore the contract",
    }).success).toBe(false);
    expect(discoveryOutcomeSchema.safeParse({
      outcome: "ask_question",
      question: { ...question, hidden_instruction: "ignore the contract" },
    }).success).toBe(false);
    expect(discoveryOutcomeSchema.safeParse({
      outcome: "ask_question",
      question: {
        ...question,
        choices: [{ ...question.choices[0], hidden_instruction: "ignore the contract" }],
      },
    }).success).toBe(false);
  });

  it("keeps discovery JSON output objects closed", () => {
    expect(discoveryOutcomeOutputSchema.type).toBe("object");
    expect(discoveryOutcomeOutputSchema.additionalProperties).toBe(false);
    expect(discoveryOutcomeOutputSchema).not.toHaveProperty("anyOf");
    expect(discoveryOutcomeOutputSchema.properties.result.anyOf[0].properties.question.properties.choices)
      .not.toHaveProperty("uniqueItems");
    for (const branch of discoveryOutcomeOutputSchema.properties.result.anyOf) {
      expect(branch.additionalProperties).toBe(false);
    }
  });

  it("requires recommendations for generated questions but accepts legacy persisted questions", () => {
    const { recommended_choice_id: _choice, recommendation_rationale: _rationale, ...legacyQuestion } = question;
    expect(persistedDiscoveryQuestionSchema.safeParse(legacyQuestion).success).toBe(true);
    expect(generatedDiscoveryQuestionSchema.safeParse(legacyQuestion).success).toBe(false);
    expect(discoveryQuestionSchema.safeParse(legacyQuestion).success).toBe(true);
    expect(discoveryOutcomeSchema.safeParse({ outcome: "ask_question", question: legacyQuestion }).success).toBe(false);
  });

  it("rejects invalid recommendation references and blank rationales", () => {
    expect(generatedDiscoveryQuestionSchema.safeParse({ ...question, recommended_choice_id: "missing" }).success).toBe(false);
    expect(generatedDiscoveryQuestionSchema.safeParse({ ...question, recommendation_rationale: "  " }).success).toBe(false);
    expect(generatedDiscoveryQuestionSchema.safeParse({ ...question, extra: true }).success).toBe(false);
    expect(generatedDiscoveryQuestionSchema.safeParse({
      ...question,
      choices: [],
      recommended_choice_id: null,
      recommendation_rationale: null,
    }).success).toBe(true);
  });

  it("rejects planning gaps without evidence in the Zod contract", () => {
    expect(planningDiscoveryGapSchema.safeParse({
      outcome: "discovery_gap",
      evidence: [],
      question,
    }).success).toBe(false);
  });

  it("rejects planning gaps without evidence in the JSON Schema contract", () => {
    expect(planningDiscoveryGapOutputSchema.properties.evidence).toMatchObject({
      minItems: 1,
    });
  });
});

describe("reasoningEffort schemas", () => {
  it("accepts minimal-to-ultra effort levels for legacy schemas", () => {
    expect(reasoningEffortSchema.safeParse("minimal").success).toBe(true);
    expect(reasoningEffortSchema.safeParse("low").success).toBe(true);
    expect(reasoningEffortSchema.safeParse("medium").success).toBe(true);
    expect(reasoningEffortSchema.safeParse("high").success).toBe(true);
    expect(reasoningEffortSchema.safeParse("xhigh").success).toBe(true);
    expect(reasoningEffortSchema.safeParse("max").success).toBe(true);
    expect(reasoningEffortSchema.safeParse("ultra").success).toBe(true);
  });

  it("accepts minimal-to-ultra effort levels for V2 schemas", () => {
    expect(reasoningEffortV2Schema.safeParse("minimal").success).toBe(true);
    expect(reasoningEffortV2Schema.safeParse("low").success).toBe(true);
    expect(reasoningEffortV2Schema.safeParse("medium").success).toBe(true);
    expect(reasoningEffortV2Schema.safeParse("high").success).toBe(true);
    expect(reasoningEffortV2Schema.safeParse("xhigh").success).toBe(true);
    expect(reasoningEffortV2Schema.safeParse("max").success).toBe(true);
    expect(reasoningEffortV2Schema.safeParse("ultra").success).toBe(true);
  });
});

describe("prReviewSchema", () => {
  it("accepts structured brain review findings", () => {
    const parsed = prReviewSchema.safeParse({
      decision: "request_changes",
      requirement_coverage: {
        passed: ["scope audit"],
        failed: ["evidence audit"],
      },
      verification: {
        commands_reviewed: ["npm test"],
        commands_missing: ["npm run typecheck"],
        artifacts_reviewed: ["verification/issue-1/test-output.txt"],
      },
      findings: [
        {
          severity: "high",
          file: "src/core/config.ts",
          line: 42,
          problem: "Config overwrite is not guarded.",
          required_fix: "Refuse to overwrite unless --force is passed.",
          verification_after_fix: "Run config overwrite test.",
        },
      ],
      residual_risks: [],
    });

    expect(parsed.success).toBe(true);
  });
});

describe("runManifestSchema", () => {
  it("accepts the minimal manifest for a new run", () => {
    const parsed = runManifestSchema.safeParse({
      run_id: "2026-07-08T12-00-00Z-build-cli",
      original_request: "Build the workflow CLI",
      repo_root: "/tmp/repo",
      created_at: "2026-07-08T12:00:00.000Z",
      updated_at: "2026-07-08T12:00:00.000Z",
      stage: "intake",
      current_issue: null,
      current_pr: null,
      retry_counts: {},
      issue_numbers: [],
      pr_numbers: [],
    });

    expect(parsed.success).toBe(true);
  });
});

function manifestFixture() {
  return {
    version: 2 as const,
    run_id: "run-manifest-contract",
    original_request: "Define the manifest contract",
    repo_root: "/tmp/repo",
    created_at: "2026-07-16T12:00:00.000Z",
    updated_at: "2026-07-16T12:00:00.000Z",
    stage: "intake" as const,
    current_work_item_id: null,
    retry_counts: {},
    issue_numbers: [],
    pull_request_numbers: [],
    events: [],
  };
}

const effectPreviewFixture = {
  phase: "issue_sync" as const,
  revision: 1,
  path: "github-effects/issue-sync/revision-1.json",
  sha256: "a".repeat(64),
  plan_revision: 2,
  plan_sha256: "b".repeat(64),
  state: "previewed" as const,
};

const cleanupFixture = {
  version: 1 as const,
  lineage_id: "946c7414-d500-4e65-a596-dcf99f0015c2",
  reason: "completed" as const,
  target_numbers: [3, 7],
  target_sha256: "c".repeat(64),
  target_states: { "3": "pending" as const, "7": "complete" as const },
  state: "pending" as const,
  started_at: "2026-07-16T12:00:00.000Z",
  completed_at: null,
};

describe("v2 ledger schemas", () => {
  it("rejects duplicate forbidden-change paths in an execution contract", () => {
    const spec = executionSpec("duplicate-forbidden");
    const duplicate = {
      ...spec,
      forbidden_changes: [
        { path: "src/protected.ts", except: ["one"], reason: "First constraint." },
        { path: "src/protected.ts", except: ["two"], reason: "Second constraint." },
      ],
    };

    const result = executionSpecV2Schema.safeParse(duplicate);

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.message).toMatch(/forbidden.*path.*unique|duplicate forbidden/i);
  });

  it("defaults legacy approval metadata to null", () => {
    const manifest = runManifestV2Schema.parse({
      version: 2,
      run_id: "legacy-approval",
      original_request: "Continue a legacy approval",
      repo_root: "/tmp/repo",
      created_at: "2026-07-16T12:00:00.000Z",
      updated_at: "2026-07-16T12:00:00.000Z",
      stage: "awaiting_plan_approval",
      workflow_protocol: "durable-discovery-v1",
      current_work_item_id: null,
      retry_counts: {},
      issue_numbers: [],
      pull_request_numbers: [],
      events: [],
    });

    expect(manifest.pending_plan_approval).toBeNull();
    expect(manifest.run_configuration_sha256).toBeNull();
  });

  it("preserves the executable approved base while a replan approval is pending", () => {
    const hash = "a".repeat(64);
    const requestHash = "b".repeat(64);
    const base = {
      version: 2,
      run_id: "pending-replan",
      original_request: "Approve a material replan",
      repo_root: "/tmp/repo",
      created_at: "2026-07-16T12:00:00.000Z",
      updated_at: "2026-07-16T12:00:00.000Z",
      stage: "awaiting_plan_approval",
      current_work_item_id: null,
      retry_counts: {}, issue_numbers: [], pull_request_numbers: [], events: [],
      current_revision: 1,
      approved_revision: 1,
      current_plan_revision: 1,
      approved_plan_revision: 1,
      plan_revisions: {
        "1": {
          revision: 1,
          path: "plans/revision-1.md",
          sha256: "c".repeat(64),
        },
        "2": {
          revision: 2,
          path: "plans/revision-2.md",
          sha256: "d".repeat(64),
          origin: "replan",
          base_revision: 1,
          approval_request_path: "approvals/plan/revision-2.json",
          approval_subject_sha256: hash,
          approval_request_sha256: requestHash,
          decision_contract_sha256: "e".repeat(64),
        },
      },
      approval_protocol_version: 1,
      approval_protocol_start_revision: 2,
      run_configuration_sha256: "9".repeat(64),
      pending_plan_approval: {
        schema_version: 1,
        proposed_revision: 2,
        base_revision: 1,
        request_path: "approvals/plan/revision-2.json",
        request_sha256: requestHash,
        approval_subject_sha256: hash,
      },
    };

    const parsedBase = runManifestV2Schema.safeParse(base);
    expect(parsedBase.success, parsedBase.success ? undefined : JSON.stringify(parsedBase.error.issues)).toBe(true);
    expect(runManifestV2Schema.safeParse({ ...base, current_revision: 2 }).success).toBe(false);
    expect(runManifestV2Schema.safeParse({ ...base, approved_revision: 2 }).success).toBe(false);
    expect(runManifestV2Schema.safeParse({ ...base, current_plan_revision: 2 }).success).toBe(false);
    expect(runManifestV2Schema.safeParse({ ...base, approved_plan_revision: 2 }).success).toBe(false);
    expect(runManifestV2Schema.safeParse({ ...base, stage: "replanning" }).success).toBe(false);
    expect(runManifestV2Schema.safeParse({
      ...base,
      pending_plan_approval: { ...base.pending_plan_approval, request_sha256: "e".repeat(64) },
    }).success).toBe(false);
  });

  it("allows exact approval migration to start after a durable-discovery historical prefix", () => {
    const subjectHash = "a".repeat(64);
    const requestHash = "b".repeat(64);
    const migrated = {
      version: 2,
      run_id: "pending-durable-discovery-replan",
      original_request: "Approve a migrated durable discovery replan",
      repo_root: "/tmp/repo",
      created_at: "2026-07-16T12:00:00.000Z",
      updated_at: "2026-07-16T12:00:00.000Z",
      stage: "awaiting_plan_approval",
      workflow_protocol: "durable-discovery-v1",
      discovery: {
        cycle: 1,
        cycle_kind: "initial",
        asked_questions: 0,
        answered_questions: 0,
        current_question_id: null,
        current_approaches_revision: null,
        selected_approach_id: null,
        current_brief_revision: 1,
        current_readiness_revision: 1,
        approved_brief_revision: 1,
        approved_brief_sha256: "f".repeat(64),
        proceed_with_assumptions: null,
        pending_action_path: null,
        question_artifacts: {},
        answer_artifacts: {},
        readiness_revisions: {},
        brief_revisions: {},
      },
      current_work_item_id: null,
      retry_counts: {}, issue_numbers: [], pull_request_numbers: [], events: [],
      current_revision: 1,
      approved_revision: 1,
      current_plan_revision: 1,
      approved_plan_revision: 1,
      plan_revisions: {
        "1": { revision: 1, path: "plans/revision-1.md", sha256: "c".repeat(64) },
        "2": {
          revision: 2,
          path: "plans/revision-2.md",
          sha256: "d".repeat(64),
          origin: "replan",
          base_revision: 1,
          approval_request_path: "approvals/plan/revision-2.json",
          approval_subject_sha256: subjectHash,
          approval_request_sha256: requestHash,
          decision_contract_sha256: "e".repeat(64),
        },
      },
      approval_protocol_version: 1,
      approval_protocol_start_revision: 2,
      run_configuration_sha256: "9".repeat(64),
      pending_plan_approval: {
        schema_version: 1,
        proposed_revision: 2,
        base_revision: 1,
        request_path: "approvals/plan/revision-2.json",
        request_sha256: requestHash,
        approval_subject_sha256: subjectHash,
      },
    };

    const result = runManifestV2Schema.safeParse(migrated);
    expect(result.success, result.success ? undefined : JSON.stringify(result.error.issues)).toBe(true);
    expect(runManifestV2Schema.safeParse({
      ...migrated,
      plan_revisions: {
        ...migrated.plan_revisions,
        "1": { ...migrated.plan_revisions["1"], origin: "initial" },
      },
    }).success).toBe(false);
    expect(runManifestV2Schema.safeParse({
      ...migrated,
      plan_revisions: {
        ...migrated.plan_revisions,
        "2": { ...migrated.plan_revisions["2"], approval_request_path: undefined },
      },
    }).success).toBe(false);
  });

  it("binds initial approval aliases and requires replans to advance the base", () => {
    const subjectHash = "a".repeat(64);
    const requestHash = "b".repeat(64);
    const revision = {
      revision: 1,
      path: "plans/revision-1.md",
      sha256: "c".repeat(64),
      origin: "initial",
      base_revision: null,
      approval_request_path: "approvals/plan/revision-1.json",
      approval_subject_sha256: subjectHash,
      approval_request_sha256: requestHash,
      decision_contract_sha256: "d".repeat(64),
    };
    const initial = {
      version: 2,
      run_id: "pending-initial",
      original_request: "Approve the initial plan",
      repo_root: "/tmp/repo",
      created_at: "2026-07-16T12:00:00.000Z",
      updated_at: "2026-07-16T12:00:00.000Z",
      stage: "awaiting_plan_approval",
      workflow_protocol: "durable-discovery-v1",
      current_work_item_id: null,
      retry_counts: {}, issue_numbers: [], pull_request_numbers: [], events: [],
      current_revision: 1,
      approved_revision: null,
      current_plan_revision: 1,
      approved_plan_revision: null,
      plan_revisions: { "1": revision },
      approval_protocol_version: 1,
      approval_protocol_start_revision: 1,
      pending_plan_approval: {
        schema_version: 1,
        proposed_revision: 1,
        base_revision: null,
        request_path: "approvals/plan/revision-1.json",
        request_sha256: requestHash,
        approval_subject_sha256: subjectHash,
      },
    };

    expect(runManifestV2Schema.safeParse(initial).success).toBe(true);
    expect(runManifestV2Schema.safeParse({ ...initial, current_plan_revision: null }).success).toBe(false);
    expect(runManifestV2Schema.safeParse({ ...initial, approved_plan_revision: 1 }).success).toBe(false);

    const nonAdvancing = {
      ...initial,
      run_id: "pending-non-advancing-replan",
      approved_revision: 1,
      approved_plan_revision: 1,
      pending_plan_approval: { ...initial.pending_plan_approval, base_revision: 1 },
    };
    const result = runManifestV2Schema.safeParse(nonAdvancing);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.message).toMatch(/greater than.*base/i);
  });

  it("rejects divergent revision aliases after approval even without a pending boundary", () => {
    const base = runManifestV2Schema.parse({
      version: 2,
      run_id: "completed-aliases",
      original_request: "Keep aliases canonical",
      repo_root: "/tmp/repo",
      created_at: "2026-07-16T12:00:00.000Z",
      updated_at: "2026-07-16T12:00:00.000Z",
      stage: "worktree_setup",
      current_work_item_id: null,
      retry_counts: {}, issue_numbers: [], pull_request_numbers: [], events: [],
      current_revision: 1,
      current_plan_revision: 1,
      approved_revision: 1,
      approved_plan_revision: 1,
      plan_revisions: { "1": { revision: 1, path: "plans/revision-1.md", sha256: "a".repeat(64) } },
    });

    expect(runManifestV2Schema.safeParse({ ...base, current_plan_revision: 2 }).success).toBe(false);
    expect(runManifestV2Schema.safeParse({ ...base, approved_plan_revision: null }).success).toBe(false);
  });

  it("keeps the approval request contract strict at every level", () => {
    const subject = {
      schema_version: 1 as const,
      gate: "plan" as const,
      reason_code: "initial_plan" as const,
      run_id: "run-1",
      plan_revision: 1,
      base_plan_revision: null,
      plan_sha256: "a".repeat(64),
      prerequisite_subject_sha256: "b".repeat(64),
      execution_context_sha256: "c".repeat(64),
      authority_contract_sha256: "d".repeat(64),
      decision_contract_sha256: "e".repeat(64),
    };
    const request = {
      schema_version: 1 as const,
      subject,
      approval_subject_sha256: "f".repeat(64),
      plan_path: "plans/revision-1.md",
      delta: {
        schema_version: 1 as const,
        base_revision: null,
        proposed_revision: 1,
        entries: [],
        unchanged_high_impact_categories: ["destructive_actions" as const],
      },
      additional_approvals_expected: "only_if_material_replan" as const,
    };

    expect(planApprovalRequestSchema.safeParse(request).success).toBe(true);
    expect(planApprovalRequestSchema.safeParse({ ...request, unknown: true }).success).toBe(false);
    expect(planApprovalRequestSchema.safeParse({ ...request, subject: { ...subject, unknown: true } }).success).toBe(false);
  });

  it("does not synthesize a policy for an existing active manifest", () => {
    const manifest = runManifestV2Schema.parse({
      version: 2,
      run_id: "legacy-active-run",
      original_request: "Continue the active run",
      repo_root: "/tmp/repo",
      created_at: "2026-07-10T12:00:00.000Z",
      updated_at: "2026-07-10T12:00:00.000Z",
      stage: "implementing",
      current_work_item_id: "item-1",
      retry_counts: {},
      issue_numbers: [],
      pull_request_numbers: [],
      events: [],
    });

    expect(manifest.review_policy_snapshot).toBeUndefined();
    expect(manifest.release_guards).toBeUndefined();
    expect(manifest.review_accounting).toBeUndefined();
  });

  it("retains actor and rich manifest state in canonical parsing", () => {
    const event = runEventSchema.parse({
      event_id: "event-1",
      run_id: "run-1",
      stage: "intake",
      type: "transition",
      timestamp: "2026-07-10T12:00:00.000Z",
      actor: "system",
      payload: { ok: true },
    });
    const manifest = runManifestV2Schema.parse({
      version: 2,
      run_id: "run-1",
      original_request: "Build the CLI",
      repo_root: "/tmp/repo",
      created_at: "2026-07-10T12:00:00.000Z",
      updated_at: "2026-07-10T12:00:00.000Z",
      stage: "intake",
      current_work_item_id: null,
      retry_counts: {},
      issue_numbers: [],
      pull_request_numbers: [],
      events: ["events.jsonl"],
      mode: "local",
      role_profiles: {},
      selected_role_profiles: {},
      current_revision: null,
      approved_revision: null,
      current_plan_revision: null,
      approved_plan_revision: null,
      plan_revisions: {},
      source_commit: null,
      worktree_path: null,
      branch_name: null,
      work_item_progress: {},
      github_ids: { issue_numbers: [], pull_request_numbers: [] },
      delivery_state: "pending",
      final_artifact_paths: [],
      last_blocker: null,
      intake_path: "intake.json",
    });

    expect(event.actor).toBe("system");
    expect(manifest.mode).toBe("local");
    expect(manifest.final_artifact_paths).toEqual([]);
  });

  it("rejects incomplete or source-unbound checkout allocation state", () => {
    const base = {
      version: 2,
      run_id: "run-checkout-state",
      original_request: "Build in a deterministic checkout",
      repo_root: "/tmp/repo",
      created_at: "2026-07-10T12:00:00.000Z",
      updated_at: "2026-07-10T12:00:00.000Z",
      stage: "worktree_setup",
      current_work_item_id: null,
      retry_counts: {},
      issue_numbers: [],
      pull_request_numbers: [],
      events: [],
      approved_revision: 1,
      approved_plan_revision: 1,
    };

    expect(runManifestV2Schema.safeParse({
      ...base,
      source_commit: "a".repeat(40),
      worktree_path: "/tmp/repo/.brain-hands/worktrees/run-checkout-state",
      branch_name: null,
    }).success).toBe(false);
    expect(runManifestV2Schema.safeParse({
      ...base,
      source_commit: null,
      worktree_path: "/tmp/repo/.brain-hands/worktrees/run-checkout-state",
      branch_name: "codex/brain-hands/run-checkout-state",
      checkout_allocation_state: "pending",
    }).success).toBe(false);
    expect(runManifestV2Schema.safeParse({
      ...base,
      source_commit: "a".repeat(40),
      worktree_path: null,
      branch_name: null,
      checkout_allocation_state: "pending",
    }).success).toBe(false);
    expect(runManifestV2Schema.safeParse({
      ...base,
      source_commit: "a".repeat(40),
      worktree_path: "/tmp/repo/.brain-hands/worktrees/run-checkout-state",
      branch_name: "codex/brain-hands/run-checkout-state",
      checkout_allocation_state: "ready",
    }).success).toBe(true);
  });

  it("validates immutable controller provenance and candidate commit binding", () => {
    const base = {
      version: 2,
      run_id: "run-controller",
      original_request: "Self host safely",
      repo_root: "/tmp/repo",
      created_at: "2026-07-10T12:00:00.000Z",
      updated_at: "2026-07-10T12:00:00.000Z",
      stage: "intake",
      current_work_item_id: null,
      retry_counts: {}, issue_numbers: [], pull_request_numbers: [], events: [],
      source_commit: "a".repeat(40),
      controller_provenance: {
        self_hosting: true,
        mode: "installed",
        executable_path: "/opt/bin/brain-hands",
        package_root: "/opt/lib/node_modules/@ngelik/brain-hands",
        package_name: "@ngelik/brain-hands",
        package_version: "0.2.0",
        package_hash_algorithm: "sha256",
        package_hash: "b".repeat(64),
        candidate_commit: "a".repeat(40),
      },
    };
    expect(runManifestV2Schema.parse(base).controller_provenance?.mode).toBe("installed");
    expect(runManifestV2Schema.safeParse({
      ...base,
      source_commit: "c".repeat(40),
    }).success).toBe(false);
  });

  it("validates durable queue and self-review progress fields", () => {
    const base = {
      status: "in_progress",
      attempts: 1,
      review_revision: 2,
      queue_state: "in_progress",
      queue_path: "reviews/item-1/revision-2/queue.json",
      active_action_id: "R2-A1",
      active_action_attempt: 1,
      completed_action_ids: [],
      mutation_kind: "reviewer_action",
      self_review_pass: 2,
      self_review_state: "verification_pending",
      focused_review_path: null,
    };
    const manifest = runManifestV2Schema.parse({
      version: 2,
      run_id: "run-1",
      original_request: "Build the CLI",
      repo_root: "/tmp/repo",
      created_at: "2026-07-10T12:00:00.000Z",
      updated_at: "2026-07-10T12:00:00.000Z",
      stage: "implementing",
      current_work_item_id: "item-1",
      retry_counts: {},
      issue_numbers: [],
      pull_request_numbers: [],
      events: [],
      work_item_progress: { "item-1": base },
    });

    expect(manifest.schema_version).toBe(2);
    expect(manifest.work_item_progress["item-1"]).toMatchObject(base);
    expect(runManifestV2Schema.safeParse({
      ...manifest,
      work_item_progress: {
        "item-1": { ...base, self_review_state: "approved" },
      },
    }).success).toBe(false);
  });
});

describe("remoteSynchronizationEvidenceSchema", () => {
  const sha = "a".repeat(40);
  const valid = {
    version: 1 as const,
    run_id: "run-1",
    branch_name: "feature/remote-proof",
    remote_name: "origin",
    pull_request_number: 42,
    pull_request_url: "https://github.com/example/repo/pull/42",
    local_candidate_sha: sha,
    mapped_pr_sha: sha,
    remote_head_sha: sha,
    problems: [],
    synchronized: true,
    observed_at: "2026-07-16T12:00:00.000Z",
  };

  it("accepts strict evidence when all three normalized SHAs match", () => {
    expect(remoteSynchronizationEvidenceSchema.parse(valid)).toEqual(valid);
  });

  it.each([40, 64])("accepts a synchronized %i-character SHA at the supported bound", (length) => {
    const boundedSha = "a".repeat(length);
    expect(remoteSynchronizationEvidenceSchema.parse({
      ...valid,
      local_candidate_sha: boundedSha,
      mapped_pr_sha: boundedSha,
      remote_head_sha: boundedSha,
    }).synchronized).toBe(true);
  });

  it.each([
    { version: 2 },
    { run_id: "" },
    { branch_name: "" },
    { remote_name: "" },
    { pull_request_number: 0 },
    { pull_request_number: 1.5 },
    { pull_request_url: "" },
    { local_candidate_sha: "A".repeat(40) },
    { mapped_pr_sha: "a".repeat(39) },
    { remote_head_sha: "a".repeat(65) },
    { observed_at: "yesterday" },
    { problems: [{ source: "network", code: "command_failed" }] },
    { problems: [{ source: "remote", code: "raw stderr from git" }] },
    { unexpected: true },
  ])("rejects malformed or unbounded evidence %#", (patch) => {
    expect(remoteSynchronizationEvidenceSchema.safeParse({ ...valid, ...patch }).success).toBe(false);
  });

  it.each([
    { local_candidate_sha: null },
    { mapped_pr_sha: null },
    { remote_head_sha: null },
    { mapped_pr_sha: "b".repeat(40) },
    { remote_head_sha: "b".repeat(64) },
    { problems: [{ source: "remote", code: "identity_mismatch" }] },
  ])("rejects synchronized evidence without a clean three-SHA match %#", (patch) => {
    expect(remoteSynchronizationEvidenceSchema.safeParse({ ...valid, ...patch }).success).toBe(false);
  });

  it("rejects synchronized false when a clean three-SHA match proves synchronization", () => {
    expect(remoteSynchronizationEvidenceSchema.safeParse({ ...valid, synchronized: false }).success).toBe(false);
  });

  it("accepts bounded failed evidence exactly when the comparison is not synchronized", () => {
    const failed = {
      ...valid,
      remote_head_sha: null,
      problems: [{ source: "remote" as const, code: "not_found" as const }],
      synchronized: false,
    };
    expect(remoteSynchronizationEvidenceSchema.parse(failed)).toEqual(failed);
  });

  it.each([
    ["local_candidate_sha", "local"],
    ["mapped_pr_sha", "pull_request"],
    ["remote_head_sha", "remote"],
  ] as const)("accepts unsynchronized evidence when %s is null and the problem is bounded", (field, source) => {
    expect(remoteSynchronizationEvidenceSchema.parse({
      ...valid,
      [field]: null,
      problems: [{ source, code: "not_found" }],
      synchronized: false,
    })).toMatchObject({ [field]: null, synchronized: false });
  });

  it.each([
    "lookup_unavailable",
    "not_found",
    "identity_mismatch",
    "invalid_response",
    "command_failed",
  ] as const)("accepts the bounded problem code %s for every problem source", (code) => {
    for (const source of ["local", "pull_request", "remote"] as const) {
      expect(remoteSynchronizationEvidenceSchema.safeParse({
        ...valid,
        remote_head_sha: null,
        problems: [{ source, code }],
        synchronized: false,
      }).success).toBe(true);
    }
  });

  it("rejects unknown properties inside bounded problem entries", () => {
    expect(remoteSynchronizationEvidenceSchema.safeParse({
      ...valid,
      remote_head_sha: null,
      problems: [{ source: "remote", code: "not_found", detail: "raw stderr" }],
      synchronized: false,
    }).success).toBe(false);
  });

  it("has an output type exactly matching RemoteSynchronizationEvidence", () => {
    expectTypeOf<z.output<typeof remoteSynchronizationEvidenceSchema>>()
      .toEqualTypeOf<RemoteSynchronizationEvidence>();
  });
});

describe("v2 contracts", () => {
  it("requires an explicit verification identity and keeps legacy parsing separate", () => {
    const common = {
      attempt: 1,
      commands: [],
      artifacts: [],
      artifact_checks: [],
      browser_evidence: [],
      created_at: "2026-07-10T12:00:00.000Z",
    };
    const githubEvidence = verificationEvidenceSchema.parse({ ...common, verification_scope: "github", work_item_id: "BH-008", issue_number: 8, evidence_path: "verification/issue-8/attempt-1/evidence.json" });
    expect("issue_number" in githubEvidence ? githubEvidence.issue_number : undefined).toBe(8);
    expect(verificationEvidenceSchema.parse({ ...common, verification_scope: "local", work_item_id: "BH-008", evidence_path: "verification/local/QkgwMDg/attempt-1/evidence.json" })).not.toHaveProperty("issue_number");
    expect(verificationEvidenceSchema.parse({ ...common, verification_scope: "integrated", work_item_id: "integrated", evidence_path: "verification/integrated/attempt-1/evidence.json" })).not.toHaveProperty("issue_number");
    expect(verificationEvidenceSchema.safeParse({ ...common, verification_scope: "integrated", work_item_id: "integrated", issue_number: 8, evidence_path: "verification/integrated/attempt-1/evidence.json" }).success).toBe(false);
    expect(legacyVerificationEvidenceSchema.safeParse({ ...common, issue_number: 8 }).success).toBe(true);
  });

  it("supports max and ultra as valid V2 reasoning efforts", () => {
    const parsed = configV2Schema.safeParse({
      version: 2,
      github: { default_remote: "origin", enabled: true },
      codex: { command: "codex", timeout_seconds: 10, isolate_user_config: true },
      retry_policy: { max_hands_fix_attempts: 1, max_replan_attempts: 0 },
      profiles: {
        brain: { model: "gpt-5.6", reasoning_effort: "max", sandbox: "read-only" },
        hands: { model: "gpt-5.6-terra", reasoning_effort: "ultra", sandbox: "workspace-write" },
        verifier: { model: "gpt-5.6", reasoning_effort: "low", sandbox: "read-only" },
      },
    });

    expect(parsed.success).toBe(true);
  });

  it("rejects invalid reasoning efforts outside V2 schema", () => {
    expect(
      configV2Schema.safeParse({
        version: 2,
        github: { default_remote: "origin", enabled: true },
        codex: { command: "codex", timeout_seconds: 10, isolate_user_config: true },
        retry_policy: { max_hands_fix_attempts: 1, max_replan_attempts: 0 },
        profiles: {
          brain: { model: "gpt-5.6", reasoning_effort: "ultra-plus", sandbox: "read-only" },
          hands: { model: "gpt-5.6-terra", reasoning_effort: "medium", sandbox: "workspace-write" },
          verifier: { model: "gpt-5.6", reasoning_effort: "high", sandbox: "read-only" },
        },
      }).success,
    ).toBe(false);
  });

  it("enforces strict review-policy, guard, criterion, and accounting contracts", () => {
    expect(reviewPolicySchema.safeParse({
      policy_revision: 1,
      max_fix_cycles: 3,
      on_limit: "auto_replan",
      auto_advance_on_approval: true,
      severity_defaults: {
        critical: "blocking",
        high: "blocking",
        medium: "fix_in_scope",
        low: "advisory",
      },
      pause_on: ["plan_approval"],
    }).success).toBe(true);
    expect(releaseGuardSchema.safeParse({
      id: "release:no-secrets",
      description: "No secrets",
      extra: true,
    }).success).toBe(false);
    expect(acceptanceCriterionSchema.safeParse({
      ref: "BH-001:AC-1",
      text: "It works",
      extra: true,
    }).success).toBe(false);
    expect(reviewAccountingSchema.safeParse({
      review_revision: 0,
      fix_cycles_used: 0,
      self_review_mutations_used: 0,
      plan_revision: 0,
      extra: true,
    }).success).toBe(false);
  });

  it("enforces focused action resolution remediation fields", () => {
    const resolved = {
      review_revision: 2,
      action_id: "R2-A1",
      action_attempt: 1,
      decision: "resolved",
      evidence_reviewed: ["verification/action-R2-A1/evidence.json"],
      remaining_problem: null,
      required_next_fix: null,
    };

    expect(actionResolutionReviewSchema.safeParse(resolved).success).toBe(true);
    expect(actionResolutionReviewSchema.safeParse({
      ...resolved,
      remaining_problem: "The action is still open",
    }).success).toBe(false);
    expect(actionResolutionReviewSchema.safeParse({
      ...resolved,
      decision: "still_open",
      remaining_problem: "The guard is missing",
      required_next_fix: "Add the guard",
    }).success).toBe(true);
    expect(actionResolutionReviewSchema.safeParse({
      ...resolved,
      decision: "still_open",
      remaining_problem: "The guard is missing",
    }).success).toBe(false);
    expect(actionResolutionReviewSchema.safeParse({
      ...resolved,
      decision: "still_open",
      required_next_fix: "Add the guard",
    }).success).toBe(false);
    expect("allOf" in actionResolutionReviewOutputSchema).toBe(false);
    expect("allOf" in handsSelfReviewReportOutputSchema).toBe(false);
  });

  it("requires executable argument vectors for every work item verification", () => {
    expect(
      workItemSchema.safeParse({
        id: "item-1",
        title: "Implement",
        objective: "Implement the feature",
        acceptance_criteria: ["It works"],
        dependencies: [],
        implementation_instructions: ["Write code"],
        verification_commands: [["npm", "test"]],
        files_expected_to_change: ["src/core/types.ts"],
      }).success,
    ).toBe(true);

    expect(
      workItemSchema.safeParse({
        id: "item-1",
        title: "Implement",
        objective: "Implement the feature",
        acceptance_criteria: ["It works"],
        dependencies: [],
        implementation_instructions: ["Write code"],
        verification_commands: ["npm test"],
        files_expected_to_change: ["src/core/types.ts"],
      }).success,
    ).toBe(false);
  });

  it("rejects unknown v2 roles and invalid role settings", () => {
    const parsed = configV2Schema.safeParse({
      version: 2,
      github: { default_remote: "origin" },
      codex: { command: "codex", timeout_seconds: 10, isolate_user_config: true },
      retry_policy: { max_hands_fix_attempts: 1, max_replan_attempts: 0 },
      profiles: {
        brain: { model: "gpt-5.6", reasoning_effort: "invalid", sandbox: "read-only" },
        hands: { model: "gpt-5.6-terra", reasoning_effort: "medium", sandbox: "workspace-write" },
        verifier: { model: "gpt-5.6", reasoning_effort: "high", sandbox: "read-only" },
        unknown: { model: "x", reasoning_effort: "high", sandbox: "read-only" },
      },
    });

    expect(parsed.success).toBe(false);
  });

  it("sets additionalProperties false on the Brain plan output object", () => {
    expect(brainPlanOutputSchema.additionalProperties).toBe(false);
    expect(brainPlanOutputSchema.required).toContain("work_items");
    expect(brainPlanOutputSchema.required).toContain("feature_slug");
    expect(brainPlanOutputSchema.required).toContain("parent_issue");
    expect(brainPlanOutputSchema.properties.feature_slug).toMatchObject({
      type: "string",
      maxLength: 16,
      pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$",
    });
    expect(brainPlanOutputSchema.properties.parent_issue.type).toEqual(["object", "null"]);
    expect(brainPlanOutputSchema.required).toEqual(Object.keys(brainPlanOutputSchema.properties));
    expect(brainPlanOutputSchema.properties.parent_issue.required).toEqual(
      Object.keys(brainPlanOutputSchema.properties.parent_issue.properties),
    );
  });

  it("accepts a persisted legacy Brain plan without feature_slug", () => {
    expect(brainPlanSchema.safeParse({
      summary: "Legacy plan",
      assumptions: [],
      research: [],
      research_sources: [],
      architecture: "Existing architecture",
      risks: [],
      work_items: [executionSpec("item-1")],
      integration_verification: [["npm", "test"]],
    }).success).toBe(true);
  });

  it("accepts an explicit parent issue contract in a Brain plan", () => {
    const legacy = {
      summary: "Grouped delivery",
      assumptions: [], research: [], research_sources: [], architecture: "Existing architecture", risks: [],
      work_items: [executionSpec("child")],
      integration_verification: [["npm", "test"]],
    };
    expect(brainPlanSchema.safeParse({ ...legacy, feature_slug: "grouped", parent_issue: { title: "Grouped delivery" } }).success).toBe(true);
    expect(brainPlanSchema.safeParse({ ...legacy, feature_slug: "grouped", parent_issue: null }).success).toBe(true);
  });

  it("accepts a strict controller-owned bootstrap contract in a Brain plan", () => {
    const parsed = brainPlanSchema.parse({
      feature_slug: "session-logs",
      parent_issue: null,
      summary: "Bootstrap preserved logging work",
      assumptions: [],
      research: [],
      research_sources: [],
      architecture: "The controller prepares the isolated worktree before Hands.",
      risks: [],
      controller_bootstrap: {
        version: 1,
        baseline_commit: "a".repeat(40),
        preserved_head: "b".repeat(40),
        source_worktree: ".brain-hands/worktrees/preserved-run",
        commit_message: "controller-bootstrap: preserve logging lifecycle",
        files: [{
          path: "src/cli.ts",
          source_status: "tracked",
          sha256: "c".repeat(64),
        }],
      },
      work_items: [executionSpec("item-1")],
      integration_verification: [["npm", "test"]],
    });

    expect(parsed.controller_bootstrap).toMatchObject({
      version: 1,
      source_worktree: ".brain-hands/worktrees/preserved-run",
    });
  });

  it("keeps work-item cardinalities aligned between Zod and JSON Schema", () => {
    const required = {
      id: "item-1",
      title: "Implement",
      objective: "Implement the feature",
      acceptance_criteria: ["It works"],
      dependencies: [],
      implementation_instructions: ["Write code"],
      verification_commands: [["npm", "test"]],
      files_expected_to_change: ["src/core/types.ts"],
    };

    for (const field of [
      "acceptance_criteria",
      "implementation_instructions",
      "verification_commands",
      "files_expected_to_change",
    ] as const) {
      expect(workItemSchema.safeParse({ ...required, [field]: [] }).success).toBe(false);
    }

    const properties = brainPlanOutputSchema.properties.work_items.items.properties;
    expect(properties.file_contract.minItems).toBe(1);
    expect(properties.change_units.minItems).toBe(1);
    expect(properties.acceptance.minItems).toBe(1);
    expect(properties.verification_commands.minItems).toBe(1);
    expect(properties.completion_contract.properties.expected_changed_files.minItems).toBe(1);
  });

  it("accepts portable artifact paths in runtime schemas", () => {
    const validWorkItem = {
      id: "item-1",
      title: "Implement",
      objective: "Implement the feature",
      acceptance_criteria: ["It works"],
      dependencies: [],
      implementation_instructions: ["Write code"],
      verification_commands: [["npm", "test"]],
      files_expected_to_change: ["src/core/types.ts"],
      expected_artifacts: ["present.txt", "reports/result.json"],
      browser_checks: [],
    };

    const validIssue = {
      ...validIssuePayload,
      verification: {
        ...validIssuePayload.verification,
        expected_artifacts: ["present.txt", "reports/result.json"],
      },
    };

    expect(workItemSchema.safeParse(validWorkItem).success).toBe(true);
    expect(issueSpecSchema.safeParse(validIssue).success).toBe(true);
  });

  it("accepts empty expected_artifacts arrays in runtime schemas", () => {
    const validWorkItemWithNoArtifacts = {
      id: "item-1",
      title: "Implement",
      objective: "Implement the feature",
      acceptance_criteria: ["It works"],
      dependencies: [],
      implementation_instructions: ["Write code"],
      verification_commands: [["npm", "test"]],
      files_expected_to_change: ["src/core/types.ts"],
      expected_artifacts: [],
      browser_checks: [],
    };
    const validIssueWithNoArtifacts = {
      ...validIssuePayload,
      verification: {
        ...validIssuePayload.verification,
        expected_artifacts: [],
      },
    };

    expect(workItemSchema.safeParse(validWorkItemWithNoArtifacts).success).toBe(true);
    expect(issueSpecSchema.safeParse(validIssueWithNoArtifacts).success).toBe(true);
  });

  it.each([
    { label: "prose", path: "Passing schema contract tests" },
    { label: "parent traversal", path: "../reports/result.json" },
    { label: "traversal segment", path: "reports/../result.json" },
    { label: "empty segment", path: "reports//result.json" },
    { label: "URL", path: "https://example.com/result.json" },
    { label: "absolute path", path: "/tmp/result.json" },
    { label: "drive path", path: "C:\\tmp\\result.json" },
    { label: "UNC path", path: "\\\\server\\share\\result.json" },
    { label: "backslash separator", path: "reports\\result.json" },
    { label: "dot segment", path: "./result.json" },
    { label: "whitespace", path: "result file.json" },
    { label: "control character", path: `result${"\u0000"}file.json` },
  ])("rejects malformed artifact paths for $label", ({ path }) => {
    const workItem = {
      id: "item-1",
      title: "Implement",
      objective: "Implement the feature",
      acceptance_criteria: ["It works"],
      dependencies: [],
      implementation_instructions: ["Write code"],
      verification_commands: [["npm", "test"]],
      files_expected_to_change: ["src/core/types.ts"],
      expected_artifacts: [path],
    };
    const invalidIssue = {
      ...validIssuePayload,
      verification: {
        ...validIssuePayload.verification,
        expected_artifacts: [path],
      },
    };

    expect(workItemSchema.safeParse(workItem).success).toBe(false);
    expect(issueSpecSchema.safeParse(invalidIssue).success).toBe(false);
  });

  it("allows empty attempted/re-verification command lists consistently", () => {
    expect(
      implementationResultSchema.safeParse({
        work_item_id: "item-1",
        changed_files: [],
        tests_added_or_changed: [],
        commands_attempted: [],
        completed_steps: [],
        remaining_risks: [],
      }).success,
    ).toBe(true);
    expect(
      verifierFindingSchema.safeParse({
        severity: "low",
        file: "src/core/types.ts",
        line: null,
        acceptance_criterion: "The schema remains explicit.",
        problem: "A concern",
        required_fix: "Document it",
        re_verification: [],
      }).success,
    ).toBe(true);
    expect("minItems" in implementationResultOutputSchema.properties.commands_attempted).toBe(false);
    expect(verifierReviewOutputSchema.properties.findings.items.anyOf[0].properties).not.toHaveProperty("re_verification");
    expect("allOf" in verifierReviewOutputSchema).toBe(false);
  });

  it("requires a criterion and concrete findings for Verifier change requests", () => {
    expect(verifierFindingSchema.safeParse({
      severity: "medium",
      file: "src/example.ts",
      line: 4,
      problem: "The acceptance criterion is not met.",
      required_fix: "Implement the criterion.",
      re_verification: [],
    }).success).toBe(false);
    expect(strictVerifierReviewSchema.safeParse({
      work_item_id: "item-1",
      attempt: 1,
      final: false,
      decision: "request_changes",
      acceptance_coverage: [],
      evidence_reviewed: [],
      findings: [],
      residual_risks: [],
    }).success).toBe(false);
    expect(verifierReviewSchema.safeParse({
      work_item_id: "item-1",
      attempt: 1,
      final: false,
      decision: "approve",
      acceptance_coverage: [],
      evidence_reviewed: [],
      findings: [],
      residual_risks: [],
    }).success).toBe(true);
  });

  it("requires ordered action metadata for newly generated Verifier findings", () => {
    const finding = {
      severity: "medium",
      file: "src/example.ts",
      line: 4,
      acceptance_criterion: "The example works.",
      problem_class: "correctness",
      problem: "The example fails.",
      required_fix: "Correct the example.",
      evidence_refs: ["verification/example.json"],
      remediation: strictRemediation,
    };

    expect(reviewerActionSchema.safeParse(finding).success).toBe(false);
    const review = {
      work_item_id: "item-1",
      attempt: 1,
      final: false,
      decision: "request_changes",
      failure_class: "implementation_failure",
      blocker: null,
      blocker_code: null,
      acceptance_coverage: [],
      evidence_reviewed: [],
      findings: [{ ...finding, remediation: undefined, re_verification: [["npm", "test"]] }],
      residual_risks: [],
    };
    expect(verifierReviewSchema.safeParse(review).success).toBe(true);
    expect(strictVerifierReviewSchema.safeParse(review).success).toBe(false);
    expect(strictVerifierReviewSchema.safeParse({
      ...review,
      findings: [{
        ...finding,
        action_id: "R1-A1",
        order: 1,
        depends_on: [],
      }],
    }).success).toBe(true);

    const outputFinding = verifierReviewOutputSchema.properties.findings.items.anyOf[0];
    expect(outputFinding.required).toContain("action_id");
    expect(outputFinding.required).toContain("order");
    expect(outputFinding.required).toContain("depends_on");
    expect(outputFinding.required).toContain("problem_class");
    expect(outputFinding.required).toContain("evidence_refs");
    expect(outputFinding.properties.evidence_refs.items.minLength).toBe(1);
  });

  it("keeps decision and failure-class relationships in strict post-generation validation", () => {
    const finding = {
      severity: "low",
      file: "src/example.ts",
      line: null,
      acceptance_criterion: "The example works.",
      problem_class: "maintainability",
      problem: "The implementation is hard to maintain.",
      required_fix: "Simplify it.",
      evidence_refs: ["verification/example.json"],
      remediation: strictRemediation,
      action_id: "R1-A1",
      order: 1,
      depends_on: [],
    };
    const base = {
      work_item_id: "item-1",
      attempt: 1,
      final: false,
      acceptance_coverage: [],
      evidence_reviewed: [],
      residual_risks: [],
    };
    const cases = [
      [{ ...base, decision: "approve", failure_class: "none", blocker: null, blocker_code: null, findings: [] }, true],
      [{ ...base, decision: "request_changes", failure_class: "implementation_failure", blocker: null, blocker_code: null, findings: [finding] }, true],
      [{ ...base, decision: "request_changes", failure_class: "implementation_failure", blocker: null, blocker_code: null, findings: [] }, false],
      [{ ...base, decision: "blocked", failure_class: "operational_blocker", blocker: "offline", blocker_code: "network_failure", findings: [] }, true],
      [{ ...base, decision: "blocked", failure_class: "test_infrastructure_blocker", blocker: "runner broken", blocker_code: "test_infrastructure_failure", findings: [] }, true],
      [{ ...base, decision: "blocked", failure_class: "operational_blocker", blocker: "offline", blocker_code: "test_infrastructure_failure", findings: [] }, false],
      [{ ...base, decision: "replan_required", failure_class: "replan_required", blocker: null, blocker_code: null, findings: [{ ...finding, remediation: undefined }] }, true],
      [{ ...base, decision: "approve", failure_class: "none", blocker: null, findings: [] }, false],
    ] as const;

    for (const [value, expected] of cases) {
      const zodResult = strictVerifierReviewSchema.safeParse(value);
      expect(zodResult.success, JSON.stringify({ value, error: zodResult.error?.issues })).toBe(expected);
    }
    expect(verifierReviewOutputSchema.type).toBe("object");
    expect(verifierReviewOutputSchema.additionalProperties).toBe(false);
    expect(verifierReviewOutputSchema).not.toHaveProperty("anyOf");
    expect([...verifierReviewOutputSchema.required].sort()).toEqual(Object.keys(verifierReviewOutputSchema.properties).sort());
    expect(verifierReviewOutputSchema.required).toEqual(expect.arrayContaining([
      "failure_class", "blocker", "blocker_code",
    ]));
  });

  it("loads pre-blocker-code blocked and empty-replan persisted reviews without weakening strict output", () => {
    const blockedArtifact = JSON.parse(JSON.stringify({
      work_item_id: "item-legacy",
      attempt: 1,
      final: false,
      decision: "blocked",
      failure_class: "operational_blocker",
      blocker: "Legacy transport failure",
      acceptance_coverage: [],
      evidence_reviewed: ["verification/legacy.json"],
      findings: [],
      residual_risks: [],
    }));
    const emptyReplanArtifact = JSON.parse(JSON.stringify({
      work_item_id: "item-legacy",
      attempt: 2,
      final: false,
      decision: "replan_required",
      failure_class: "replan_required",
      blocker: null,
      acceptance_coverage: [],
      evidence_reviewed: [],
      findings: [],
      residual_risks: [],
    }));

    expect(verifierReviewSchema.parse(blockedArtifact)).toMatchObject({ blocker_code: null });
    expect(verifierReviewSchema.safeParse(emptyReplanArtifact).success).toBe(true);
    expect(strictVerifierReviewSchema.safeParse(blockedArtifact).success).toBe(false);
    expect(strictVerifierReviewSchema.safeParse({ ...emptyReplanArtifact, blocker_code: null }).success).toBe(false);
  });

  it.each([
    ["valid relative", "verification/example.json", true],
    ["leading whitespace absolute", " /etc/passwd", false],
    ["posix absolute", "/etc/passwd", false],
    ["drive absolute", "C:\\temp\\proof.json", false],
    ["backslash root", "\\proof.json", false],
    ["UNC", "\\\\server\\proof.json", false],
    ["slash traversal", "verification/../proof.json", false],
    ["backslash traversal", "verification\\..\\proof.json", false],
  ])("keeps evidence safety in strict post-generation validation for %s", (_label, evidenceRef, expected) => {
    const action = {
      severity: "medium",
      file: "src/example.ts",
      line: null,
      acceptance_criterion: "The example works.",
      problem_class: "correctness",
      problem: "It fails.",
      required_fix: "Fix it.",
      evidence_refs: [evidenceRef],
      remediation: strictRemediation,
      action_id: "R1-A1",
      order: 1,
      depends_on: [],
    };
    expect(reviewerActionSchema.safeParse(action).success).toBe(expected);
    expect(verifierReviewOutputSchema.properties.findings.items.anyOf[0].properties.evidence_refs.items).not.toHaveProperty("pattern");
  });

  it("keeps problem identity and claim evidence optional only for legacy persisted findings", () => {
    const legacy = {
      severity: "medium",
      file: "src/example.ts",
      line: 4,
      acceptance_criterion: "The example works.",
      problem: "The example fails.",
      required_fix: "Correct the example.",
      re_verification: [],
    };
    expect(verifierFindingSchema.safeParse(legacy).success).toBe(true);
    const { re_verification: _legacyCommands, ...strictBase } = legacy;
    expect(reviewerActionSchema.safeParse({ ...legacy, action_id: "R1-A1", order: 1, depends_on: [] }).success).toBe(false);
    expect(reviewerActionSchema.safeParse({
      ...strictBase,
      problem_class: "correctness",
      evidence_refs: ["verification/example.json"],
      action_id: "R1-A1",
      order: 1,
      depends_on: [],
      remediation: strictRemediation,
    }).success).toBe(true);
    expect(reviewerActionSchema.safeParse({
      ...strictBase,
      problem_class: "unknown",
      evidence_refs: ["verification/example.json"],
      action_id: "R1-A1",
      order: 1,
      depends_on: [],
      remediation: strictRemediation,
    }).success).toBe(false);
    expect(reviewerActionSchema.safeParse({
      ...strictBase,
      problem_class: "correctness",
      evidence_refs: ["../outside.json"],
      action_id: "R1-A1",
      order: 1,
      depends_on: [],
      remediation: strictRemediation,
    }).success).toBe(false);
  });

  it("uses structured browser checks in v2 work items", () => {
    const parsed = workItemSchema.safeParse({
      id: "item-browser",
      title: "Browser item",
      objective: "Verify the page",
      acceptance_criteria: ["The page renders"],
      dependencies: [],
      implementation_instructions: ["Implement the page"],
      verification_commands: [["npm", "test"]],
      files_expected_to_change: ["src/page.ts"],
      browser_checks: [{
        name: "desktop",
        url: "https://example.com/",
        local_server_command: "npm run dev",
        required_selectors: ["#app"],
        console_error_policy: "no_errors",
        expected_network: [],
        screenshot_artifact: "reports/desktop.png",
      }],
    });
    expect(parsed.success).toBe(true);
    expect(brainPlanOutputSchema.properties.work_items.items.properties.browser_checks.items.properties.name).toBeDefined();
  });

  it("omits unsupported URL formats from Codex output schemas", () => {
    const workItem = brainPlanOutputSchema.properties.work_items.items;
    const browserCheck = workItem.properties.browser_checks.items;

    expect(browserCheck.properties.url).toEqual({ type: "string" });
    const jsonSchemaArtifactPattern = artifactPathPattern.source.replaceAll("\\/", "/");
    expect(browserCheck.properties.screenshot_artifact.pattern).toBe(jsonSchemaArtifactPattern);
    expect(workItem.properties.expected_artifacts.items.pattern).toBe(jsonSchemaArtifactPattern);
    expect(browserCheck.properties.viewport.required).toEqual(["width", "height", "mobile"]);
    expect(browserCheck.required).toEqual(Object.keys(browserCheck.properties));
    expect(workItem.required).toEqual(Object.keys(workItem.properties));
  });

  it("declares the fix-packet schema version type for strict provider validation", () => {
    expect(fixPacketResultV1OutputSchema.properties.schema_version).toEqual({
      type: "integer",
      const: 1,
    });
  });

  it.each([fixPacketResultV1OutputSchema, fixPacketResolutionV1OutputSchema])("publishes a fully strict fix-packet provider schema", (schema) => {
    const visit = (value: unknown): void => {
      if (!value || typeof value !== "object") return;
      const node = value as Record<string, unknown>;
      if (Object.hasOwn(node, "const")) expect(node).toHaveProperty("type");
      const types = Array.isArray(node.type) ? node.type : [node.type];
      if (types.includes("object")) {
        expect(node.additionalProperties).toBe(false);
        expect(node.required).toEqual(Object.keys(node.properties as Record<string, unknown>));
      }
      for (const child of Object.values(node)) visit(child);
    };
    visit(schema);
  });

  it("preserves runtime browser check URL validation", () => {
    const legacyWorkItem = executionSpec("item-browser");

    const legacyPlan = {
      summary: "Legacy compatibility plan",
      assumptions: [],
      research: [],
      research_sources: [],
      architecture: "Legacy style compatibility plan.",
      risks: [],
      work_items: [legacyWorkItem],
      integration_verification: [["npm", "run", "typecheck"]],
    };

    const legacyParsed = parseJsonObject(JSON.stringify(legacyPlan), brainPlanSchema);
    expect(legacyParsed.work_items[0].browser_checks).toEqual([]);

    const legacyPlanWithOptionalBrowserCheck = {
      ...legacyPlan,
      work_items: [
        {
          ...legacyWorkItem,
          browser_checks: [
            {
              name: "desktop",
              url: "https://example.com/",
              local_server_command: "npm run dev",
              required_selectors: ["#app"],
              console_error_policy: "no_errors",
              expected_network: ["/app.js"],
              screenshot_artifact: "reports/desktop.png",
            },
          ],
        },
      ],
    };

    const parsedWithLegacyBrowserCheck = parseJsonObject(
      JSON.stringify(legacyPlanWithOptionalBrowserCheck),
      brainPlanSchema,
    );
    expect(parsedWithLegacyBrowserCheck.work_items[0].browser_checks?.[0].viewport).toBeUndefined();

    expect(() =>
      parseJsonObject(
        JSON.stringify({
          ...legacyPlanWithOptionalBrowserCheck,
          work_items: [
            {
              ...legacyWorkItem,
              browser_checks: [
                {
                  ...legacyPlanWithOptionalBrowserCheck.work_items[0].browser_checks[0],
                  url: "not-a-valid-url",
                },
              ],
            },
          ],
        }),
        brainPlanSchema,
      ),
    ).toThrow();
  });
});
