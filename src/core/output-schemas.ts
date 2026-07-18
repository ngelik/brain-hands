const stringArray = { type: "array", items: { type: "string", minLength: 1 } } as const;
const nonEmptyStringArray = {
  type: "array",
  minItems: 1,
  items: { type: "string", minLength: 1 },
} as const;
const providerEvidenceRefArray = {
  type: "array",
  minItems: 1,
  items: { type: "string", minLength: 1 },
} as const;

const reflectionClassificationsSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    implementation_defects: stringArray,
    planning_defects: stringArray,
    verification_gaps: stringArray,
    environment_failures: stringArray,
    external_blockers: stringArray,
    unnecessary_cost_or_rework: stringArray,
  },
  required: [
    "implementation_defects",
    "planning_defects",
    "verification_gaps",
    "environment_failures",
    "external_blockers",
    "unnecessary_cost_or_rework",
  ],
} as const;
const commandArray = {
  type: "array",
  items: {
    type: "array",
    minItems: 1,
    items: { type: "string", minLength: 1 },
  },
} as const;
const nonEmptyCommandArray = { ...commandArray, minItems: 1 } as const;

const artifactPathSchema = {
  type: "string",
  minLength: 1,
  pattern: "^(?:[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9_-])?|\\.[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9_-])?)(?:/(?:[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9_-])?|\\.[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9_-])?))*$",
} as const;

const controllerBootstrapOutputSchema = {
  type: ["object", "null"],
  additionalProperties: false,
  properties: {
    version: { type: "integer", enum: [1] },
    baseline_commit: { type: "string", pattern: "^[a-f0-9]{40,64}$" },
    preserved_head: { type: "string", pattern: "^[a-f0-9]{40,64}$" },
    source_worktree: {
      type: "string",
      pattern: "^\\.brain-hands/worktrees/[A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]+)*$",
    },
    commit_message: { type: "string", minLength: 1 },
    files: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: artifactPathSchema,
          source_status: { type: "string", enum: ["tracked", "untracked"] },
          sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
        },
        required: ["path", "source_status", "sha256"],
      },
    },
  },
  required: ["version", "baseline_commit", "preserved_head", "source_worktree", "commit_message", "files"],
} as const;

const browserCheckSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    name: { type: "string", minLength: 1 },
    url: { type: "string" },
    local_server_command: { type: "string", minLength: 1 },
    required_selectors: { type: "array", items: { type: "string" } },
    console_error_policy: { type: "string", enum: ["allow_errors", "no_errors"] },
    expected_network: { type: "array", items: { type: "string" } },
    screenshot_artifact: artifactPathSchema,
    viewport: {
      type: "object",
      additionalProperties: false,
      properties: {
        width: { type: "integer", minimum: 1 },
        height: { type: "integer", minimum: 1 },
        mobile: { type: "boolean" },
      },
      required: ["width", "height", "mobile"],
    },
    wait_ms: { type: "integer", minimum: 1 },
    require_no_horizontal_overflow: { type: "boolean" },
    forbidden_overlaps: {
      type: "array",
      items: { type: "array", minItems: 2, maxItems: 2, items: { type: "string", minLength: 1 } },
    },
  },
  required: [
    "name",
    "url",
    "local_server_command",
    "required_selectors",
    "console_error_policy",
    "expected_network",
    "screenshot_artifact",
    "viewport",
    "wait_ms",
    "require_no_horizontal_overflow",
    "forbidden_overlaps",
  ],
} as const;

const executionFileContractSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    path: { type: "string", minLength: 1 },
    permission: { type: "string", enum: ["create", "modify", "delete", "read_only"] },
    targets: nonEmptyStringArray,
  },
  required: ["path", "permission", "targets"],
} as const;

export const executionSpecV2OutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    schema_version: { type: "string", enum: ["2.0"] },
    id: { type: "string", minLength: 1, maxLength: 16, pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" },
    title: { type: "string", minLength: 1 },
    objective: { type: "string", minLength: 1 },
    dependencies: stringArray,
    file_contract: { type: "array", minItems: 1, items: executionFileContractSchema },
    forbidden_changes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string", minLength: 1 },
          except: stringArray,
          reason: { type: "string", minLength: 1 },
        },
        required: ["path", "except", "reason"],
      },
    },
    change_units: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string", minLength: 1 },
          path: { type: "string", minLength: 1 },
          target: { type: "string", minLength: 1 },
          operation: { type: "string", enum: ["create", "modify", "delete"] },
          requirements: nonEmptyStringArray,
        },
        required: ["id", "path", "target", "operation", "requirements"],
      },
    },
    acceptance: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string", minLength: 1 },
          statement: { type: "string", minLength: 1 },
          satisfied_by: nonEmptyStringArray,
        },
        required: ["id", "statement", "satisfied_by"],
      },
    },
    tests: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string", minLength: 1 },
          path: { type: "string", minLength: 1 },
          assertion: { type: "string", minLength: 1 },
          verification_command_ids: stringArray,
        },
        required: ["id", "path", "assertion", "verification_command_ids"],
      },
    },
    verification_commands: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string", minLength: 1 },
          argv: nonEmptyCommandArray.items,
          expected_exit_code: { type: "integer", enum: [0] },
          tier: { type: "string", enum: ["focused", "cross_cutting"] },
        },
        required: ["id", "argv", "expected_exit_code", "tier"],
      },
    },
    cross_cutting_impacts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          change_unit_id: { type: "string", minLength: 1 },
          category: {
            type: "string",
            enum: ["shared_helper", "runtime", "cli_lifecycle", "ledger", "artifact_paths"],
          },
          callers: stringArray,
          representative_fixtures: stringArray,
          verification_command_ids: nonEmptyStringArray,
        },
        required: [
          "change_unit_id",
          "category",
          "callers",
          "representative_fixtures",
          "verification_command_ids",
        ],
      },
    },
    expected_artifacts: { type: "array", items: artifactPathSchema },
    browser_checks: { type: "array", items: browserCheckSchema },
    risks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          description: { type: "string", minLength: 1 },
          mitigation: { type: "string", minLength: 1 },
        },
        required: ["description", "mitigation"],
      },
    },
    completion_contract: {
      type: "object",
      additionalProperties: false,
      properties: {
        expected_changed_files: nonEmptyStringArray,
        allow_additional_files: { type: "boolean" },
        required_acceptance_ids: nonEmptyStringArray,
      },
      required: ["expected_changed_files", "allow_additional_files", "required_acceptance_ids"],
    },
    ambiguity_policy: {
      type: "object",
      additionalProperties: false,
      properties: {
        default: { type: "string", enum: ["stop_and_report"] },
        stop_when: nonEmptyStringArray,
      },
      required: ["default", "stop_when"],
    },
  },
  required: [
    "schema_version",
    "id",
    "title",
    "objective",
    "dependencies",
    "file_contract",
    "forbidden_changes",
    "change_units",
    "acceptance",
    "tests",
    "verification_commands",
    "cross_cutting_impacts",
    "expected_artifacts",
    "browser_checks",
    "risks",
    "completion_contract",
    "ambiguity_policy",
  ],
} as const;

export const brainPlanOutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    feature_slug: { type: "string", minLength: 1, maxLength: 16, pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" },
    parent_issue: {
      type: ["object", "null"],
      additionalProperties: false,
      properties: { title: { type: "string", minLength: 1 } },
      required: ["title"],
    },
    summary: { type: "string", minLength: 1 },
    assumptions: stringArray,
    research: stringArray,
    research_sources: stringArray,
    architecture: { type: "string", minLength: 1 },
    risks: stringArray,
    controller_bootstrap: controllerBootstrapOutputSchema,
    work_items: { type: "array", minItems: 1, items: executionSpecV2OutputSchema },
    integration_verification: nonEmptyCommandArray,
  },
  required: [
    "feature_slug",
    "parent_issue",
    "summary",
    "assumptions",
    "research",
    "research_sources",
    "architecture",
    "risks",
    "controller_bootstrap",
    "work_items",
    "integration_verification",
  ],
} as const;

const discoveryChoiceOutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string", minLength: 1 },
    label: { type: "string", minLength: 1 },
    description: { type: "string", minLength: 1 },
  },
  required: ["id", "label", "description"],
} as const;

const discoveryQuestionOutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string", pattern: "^(?:q-\\d{3}|cycle-\\d{3}-q-\\d{3})$" },
    sequence: { type: "integer", minimum: 1 },
    category: { type: "string", enum: ["required", "high_value_tradeoff"] },
    text: { type: "string", minLength: 1, pattern: "^[^?]*\\?$" },
    choices: { type: "array", items: discoveryChoiceOutputSchema },
    recommended_choice_id: { type: ["string", "null"], minLength: 1 },
    recommendation_rationale: { type: ["string", "null"], minLength: 1, pattern: "\\S" },
    rationale: { type: "string", minLength: 1 },
    material_effects: {
      type: "array",
      items: { type: "string", enum: ["scope", "architecture", "acceptance_criteria", "verification"] },
    },
    repository_evidence: stringArray,
    essential_after_soft_limit: { type: ["string", "null"], minLength: 1 },
  },
  required: [
    "id",
    "sequence",
    "category",
    "text",
    "choices",
    "recommended_choice_id",
    "recommendation_rationale",
    "rationale",
    "material_effects",
    "repository_evidence",
    "essential_after_soft_limit",
  ],
} as const;

const discoveryApproachOutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string", pattern: "^approach-[a-z0-9]+(?:-[a-z0-9]+)*$" },
    title: { type: "string", minLength: 1 },
    summary: { type: "string", minLength: 1 },
    tradeoffs: stringArray,
    recommended: { type: "boolean" },
    recommendation_rationale: { type: ["string", "null"], minLength: 1, pattern: "\\S" },
  },
  required: ["id", "title", "summary", "tradeoffs", "recommended", "recommendation_rationale"],
} as const;

const discoveryDecisionOutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string", pattern: "^d-\\d{3}$" },
    statement: { type: "string", minLength: 1 },
    source_question_ids: { type: "array", items: { type: "string", pattern: "^(?:q-\\d{3}|cycle-\\d{3}-q-\\d{3})$" } },
  },
  required: ["id", "statement", "source_question_ids"],
} as const;

const discoveryAssumptionOutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string", pattern: "^a-\\d{3}$" },
    statement: { type: "string", minLength: 1 },
    source: { type: "string", enum: ["brain_inference", "user_instruction", "proceed_with_assumptions"] },
    source_question_ids: { type: "array", items: { type: "string", pattern: "^(?:q-\\d{3}|cycle-\\d{3}-q-\\d{3})$" } },
  },
  required: ["id", "statement", "source", "source_question_ids"],
} as const;

const discoveryBriefOutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    revision: { type: "integer", minimum: 1 },
    goal: { type: "string", minLength: 1 },
    problem: { type: "string", minLength: 1 },
    success_criteria: stringArray,
    constraints: stringArray,
    decisions: { type: "array", items: discoveryDecisionOutputSchema },
    assumptions: { type: "array", items: discoveryAssumptionOutputSchema },
    selected_approach_id: {
      type: ["string", "null"],
      pattern: "^approach-[a-z0-9]+(?:-[a-z0-9]+)*$",
    },
    selected_approach_rationale: { type: ["string", "null"], minLength: 1 },
    out_of_scope: stringArray,
    accepted_risks: stringArray,
    repository_evidence: stringArray,
  },
  required: [
    "revision",
    "goal",
    "problem",
    "success_criteria",
    "constraints",
    "decisions",
    "assumptions",
    "selected_approach_id",
    "selected_approach_rationale",
    "out_of_scope",
    "accepted_risks",
    "repository_evidence",
  ],
} as const;

const discoveryOutcomePayloadOutputSchema = {
  anyOf: [
    {
      type: "object",
      additionalProperties: false,
      properties: {
        outcome: { type: "string", enum: ["ask_question"] },
        question: discoveryQuestionOutputSchema,
      },
      required: ["outcome", "question"],
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        outcome: { type: "string", enum: ["ready_for_brief", "no_discovery_needed"] },
        rationale: { type: "string", minLength: 1, pattern: "\\S" },
        repository_evidence: { ...stringArray, minItems: 1 },
        approaches: { type: "array", items: discoveryApproachOutputSchema },
        alternatives_omitted_reason: { type: ["string", "null"], minLength: 1, pattern: "\\S" },
        brief: discoveryBriefOutputSchema,
      },
      required: ["outcome", "rationale", "repository_evidence", "approaches", "alternatives_omitted_reason", "brief"],
    },
  ],
} as const;

export const discoveryOutcomeOutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    result: discoveryOutcomePayloadOutputSchema,
  },
  required: ["result"],
} as const;

const discoveryDecisionCoverageOutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    decision_id: { type: "string", pattern: "^d-\\d{3}$" },
    work_item_ids: stringArray,
    acceptance_ids: stringArray,
    verification_command_ids: stringArray,
    no_implementation_effect: { type: ["string", "null"], minLength: 1, pattern: "\\S" },
  },
  required: [
    "decision_id",
    "work_item_ids",
    "acceptance_ids",
    "verification_command_ids",
    "no_implementation_effect",
  ],
} as const;

export const discoveredBrainPlanOutputSchema = {
  ...brainPlanOutputSchema,
  properties: {
    ...brainPlanOutputSchema.properties,
    discovery_brief_revision: { type: "integer", minimum: 1 },
    discovery_brief_sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
    discovery_decision_coverage: { type: "array", items: discoveryDecisionCoverageOutputSchema },
    accepted_risks: stringArray,
    out_of_scope: stringArray,
  },
  required: [
    ...brainPlanOutputSchema.required,
    "discovery_brief_revision",
    "discovery_brief_sha256",
    "discovery_decision_coverage",
    "accepted_risks",
    "out_of_scope",
  ],
} as const;

export const planningDiscoveryGapOutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    outcome: { type: "string", enum: ["discovery_gap"] },
    evidence: { ...stringArray, minItems: 1 },
    question: discoveryQuestionOutputSchema,
  },
  required: ["outcome", "evidence", "question"],
} as const;

export const implementationResultOutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    work_item_id: { type: "string", minLength: 1 },
    changed_files: stringArray,
    tests_added_or_changed: stringArray,
    commands_attempted: commandArray,
    completed_steps: stringArray,
    remaining_risks: stringArray,
  },
  required: [
    "work_item_id",
    "changed_files",
    "tests_added_or_changed",
    "commands_attempted",
    "completed_steps",
    "remaining_risks",
  ],
} as const;

export const handsSelfReviewReportOutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    work_item_id: { type: "string", minLength: 1 },
    parent_attempt: { type: "integer", minimum: 1 },
    mutation_kind: { type: "string", enum: ["initial", "normal_fix", "reviewer_action", "quality_recovery"] },
    pass: { type: "integer", minimum: 1 },
    active_action_id: { type: ["string", "null"], minLength: 1 },
    findings: stringArray,
    fixes_applied: stringArray,
    changed_files: stringArray,
    commands_attempted: commandArray,
    remaining_findings: stringArray,
    ready_for_resolution_check: { type: "boolean" },
  },
  required: [
    "work_item_id",
    "parent_attempt",
    "mutation_kind",
    "pass",
    "active_action_id",
    "findings",
    "fixes_applied",
    "changed_files",
    "commands_attempted",
    "remaining_findings",
    "ready_for_resolution_check",
  ],
  allOf: [
    {
      if: {
        properties: { ready_for_resolution_check: { const: true } },
        required: ["ready_for_resolution_check"],
      },
      then: {
        properties: { remaining_findings: { maxItems: 0 } },
      },
    },
  ],
} as const;

export const actionResolutionReviewOutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    review_revision: { type: "integer", minimum: 1 },
    action_id: { type: "string", minLength: 1 },
    action_attempt: { type: "integer", minimum: 1 },
    decision: {
      type: "string",
      enum: ["resolved", "still_open", "blocked", "replan_required"],
    },
    evidence_reviewed: stringArray,
    remaining_problem: { type: ["string", "null"], minLength: 1 },
    required_next_fix: { type: ["string", "null"], minLength: 1 },
  },
  required: [
    "review_revision",
    "action_id",
    "action_attempt",
    "decision",
    "evidence_reviewed",
    "remaining_problem",
    "required_next_fix",
  ],
  allOf: [
    {
      if: {
        properties: { decision: { const: "resolved" } },
        required: ["decision"],
      },
      then: {
        properties: {
          remaining_problem: { type: "null" },
          required_next_fix: { type: "null" },
        },
      },
    },
    {
      if: {
        properties: { decision: { const: "still_open" } },
        required: ["decision"],
      },
      then: {
        properties: {
          remaining_problem: { type: "string", minLength: 1 },
          required_next_fix: { type: "string", minLength: 1 },
        },
      },
    },
  ],
} as const;

export const fixPacketResultV1OutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    schema_version: { const: 1 }, packet_id: { type: "string", minLength: 1 },
    packet_sha256: { type: "string", pattern: "^[a-f0-9]{64}$" }, action_attempt: { type: "integer", minimum: 1 },
    status: { type: "string", enum: ["implemented", "packet_contradiction", "operationally_blocked"] },
    change_units: { type: "array", items: { type: "object", additionalProperties: false, properties: { change_unit_id: { type: "string", minLength: 1 }, status: { type: "string", enum: ["completed", "not_completed"] }, changed_files: stringArray, summary: { type: "string", minLength: 1 } }, required: ["change_unit_id", "status", "changed_files", "summary"] } },
    changed_files: stringArray,
    commands_attempted: { type: "array", items: { type: "object", additionalProperties: false, properties: { command_id: { type: "string", minLength: 1 }, argv: nonEmptyStringArray, exit_code: { type: ["integer", "null"] }, evidence_ref: { type: "string", minLength: 1 } }, required: ["command_id", "argv", "exit_code", "evidence_ref"] } },
    unresolved_requirements: { type: "array", items: { type: "object", additionalProperties: false, properties: { change_unit_id: { type: "string", minLength: 1 }, requirement: { type: "string", minLength: 1 }, reason: { type: "string", minLength: 1 } }, required: ["change_unit_id", "requirement", "reason"] } },
    blocker: { type: ["object", "null"] },
  },
  required: ["schema_version", "packet_id", "packet_sha256", "action_attempt", "status", "change_units", "changed_files", "commands_attempted", "unresolved_requirements", "blocker"],
} as const;

export const fixPacketResolutionV1OutputSchema = {
  type: "object", additionalProperties: false,
  properties: {
    packet_id: { type: "string", minLength: 1 }, packet_sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
    action_attempt: { type: "integer", minimum: 1 }, decision: { type: "string", enum: ["resolved", "still_open", "packet_contradiction", "operationally_blocked"] },
    condition_results: { type: "array", minItems: 1, items: { type: "object", additionalProperties: false, properties: { success_condition_id: { type: "string", minLength: 1 }, status: { type: "string", enum: ["satisfied", "unsatisfied"] }, evidence_refs: nonEmptyStringArray, remaining_problem: { type: ["string", "null"] } }, required: ["success_condition_id", "status", "evidence_refs", "remaining_problem"] } },
    required_next_fix: { type: ["string", "null"] }, blocker: { type: ["object", "null"] },
  },
  required: ["packet_id", "packet_sha256", "action_attempt", "decision", "condition_results", "required_next_fix", "blocker"],
} as const;

export const verifierRemediationClaimV1OutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    schema_version: { type: "integer", const: 1 },
    diagnosis: {
      type: "object", additionalProperties: false,
      properties: {
        observed_behavior: { type: "string", minLength: 1 }, expected_behavior: { type: "string", minLength: 1 },
        failure_mechanism: { type: "string", minLength: 1 }, reproduction: nonEmptyStringArray, evidence_refs: providerEvidenceRefArray,
      },
      required: ["observed_behavior", "expected_behavior", "failure_mechanism", "reproduction", "evidence_refs"],
    },
    targets: { type: "array", minItems: 1, items: { anyOf: [
      { type: "object", additionalProperties: false, properties: { kind: { type: "string", const: "code" }, path: { type: "string", minLength: 1 }, symbol: { type: "string", minLength: 1 }, line_hint: { type: ["integer", "null"], minimum: 1 } }, required: ["kind", "path", "symbol", "line_hint"] },
      { type: "object", additionalProperties: false, properties: { kind: { type: "string", const: "test" }, path: { type: "string", minLength: 1 }, test_name: { type: "string", minLength: 1 }, line_hint: { type: ["integer", "null"], minimum: 1 } }, required: ["kind", "path", "test_name", "line_hint"] },
      { type: "object", additionalProperties: false, properties: { kind: { type: "string", const: "command" }, command_id: { type: "string", minLength: 1 } }, required: ["kind", "command_id"] },
      { type: "object", additionalProperties: false, properties: { kind: { type: "string", const: "artifact" }, artifact_id: { type: "string", minLength: 1 }, path: { type: "string", minLength: 1 } }, required: ["kind", "artifact_id", "path"] },
      { type: "object", additionalProperties: false, properties: { kind: { type: "string", const: "browser" }, check_id: { type: "string", minLength: 1 }, selector: { type: ["string", "null"] } }, required: ["kind", "check_id", "selector"] },
      { type: "object", additionalProperties: false, properties: { kind: { type: "string", const: "release_guard" }, guard_id: { type: "string", minLength: 1 } }, required: ["kind", "guard_id"] },
    ] } },
    remediation: {
      type: "object", additionalProperties: false,
      properties: {
        strategy: { type: "string", minLength: 1 },
        change_units: { type: "array", minItems: 1, items: { type: "object", additionalProperties: false, properties: { id: { type: "string", minLength: 1 }, path: { type: "string", minLength: 1 }, target: { type: "string", minLength: 1 }, operation: { type: "string", enum: ["modify", "create", "delete"] }, requirements: nonEmptyStringArray, satisfies: nonEmptyStringArray }, required: ["id", "path", "target", "operation", "requirements", "satisfies"] } },
        allowed_files: nonEmptyStringArray,
        forbidden_changes: { type: "array", items: { type: "object", additionalProperties: false, properties: { path: { type: "string", minLength: 1 }, reason: { type: "string", minLength: 1 } }, required: ["path", "reason"] } },
      },
      required: ["strategy", "change_units", "allowed_files", "forbidden_changes"],
    },
    verification: {
      type: "object", additionalProperties: false,
      properties: {
        commands: { type: "array", minItems: 1, items: { type: "object", additionalProperties: false, properties: { id: { type: "string", minLength: 1 }, argv: nonEmptyStringArray }, required: ["id", "argv"] } },
        success_conditions: { type: "array", minItems: 1, items: { type: "object", additionalProperties: false, properties: { id: { type: "string", minLength: 1 }, statement: { type: "string", minLength: 1 }, satisfied_by: nonEmptyStringArray }, required: ["id", "statement", "satisfied_by"] } },
        required_evidence: { type: "array", minItems: 1, items: { type: "object", additionalProperties: false, properties: { id: { type: "string", minLength: 1 }, kind: { type: "string", enum: ["command_result", "test_result", "artifact", "browser"] }, source_id: { type: "string", minLength: 1 }, output_path: { type: "string", minLength: 1 } }, required: ["id", "kind", "source_id", "output_path"] } },
      },
      required: ["commands", "success_conditions", "required_evidence"],
    },
    completion_contract: {
      type: "object", additionalProperties: false,
      properties: {
        required_change_unit_ids: nonEmptyStringArray,
        expected_changed_files: nonEmptyStringArray,
        allow_additional_files: { type: "boolean", const: false },
      },
      required: ["required_change_unit_ids", "expected_changed_files", "allow_additional_files"],
    },
  },
  required: ["schema_version", "diagnosis", "targets", "remediation", "verification", "completion_contract"],
} as const;

const verifierFindingProperties = {
  severity: { type: "string", enum: ["critical", "high", "medium", "low"] },
  file: { type: "string", minLength: 1 },
  line: { type: ["integer", "null"], minimum: 1 },
  acceptance_criterion: { type: "string", minLength: 1 },
  problem_class: {
    type: "string",
    enum: ["correctness", "security", "regression", "verification", "artifact", "browser", "release_guard", "maintainability"],
  },
  problem: { type: "string", minLength: 1 },
  required_fix: { type: "string", minLength: 1 },
  evidence_refs: providerEvidenceRefArray,
  action_id: { type: "string", minLength: 1 },
  order: { type: "integer", minimum: 1 },
  depends_on: stringArray,
} as const;

const verifierFindingRequired = [
  "severity",
  "file",
  "line",
  "acceptance_criterion",
  "problem_class",
  "problem",
  "required_fix",
  "evidence_refs",
  "action_id",
  "order",
  "depends_on",
] as const;

const verifierFindingWithRemediationSchema = {
  type: "object",
  additionalProperties: false,
  properties: { ...verifierFindingProperties, remediation: verifierRemediationClaimV1OutputSchema },
  required: [...verifierFindingRequired, "remediation"],
} as const;

const verifierFindingWithoutRemediationSchema = {
  type: "object",
  additionalProperties: false,
  properties: verifierFindingProperties,
  required: verifierFindingRequired,
} as const;

const verifierFindingOutputSchema = {
  anyOf: [verifierFindingWithRemediationSchema, verifierFindingWithoutRemediationSchema],
} as const;

const verifierReviewProperties = {
  work_item_id: { type: "string", minLength: 1 },
  attempt: { type: "integer", minimum: 1 },
  final: { type: "boolean" },
  decision: { type: "string", enum: ["approve", "request_changes", "blocked", "replan_required"] },
  failure_class: { type: "string", enum: ["none", "implementation_failure", "operational_blocker", "test_infrastructure_blocker", "replan_required"] },
  blocker: { type: ["string", "null"] },
  blocker_code: {
    type: ["string", "null"],
    enum: ["transport_failure", "permission_failure", "network_failure", "catalog_failure", "test_infrastructure_failure", "corrupt_state", null],
  },
  acceptance_coverage: stringArray,
  evidence_reviewed: stringArray,
  findings: { type: "array", items: verifierFindingOutputSchema },
  residual_risks: stringArray,
} as const;

const verifierReviewRequired = [
  "work_item_id",
  "attempt",
  "final",
  "decision",
  "failure_class",
  "blocker",
  "blocker_code",
  "acceptance_coverage",
  "evidence_reviewed",
  "findings",
  "residual_risks",
] as const;

export const verifierReviewOutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: verifierReviewProperties,
  required: verifierReviewRequired,
} as const;

export const reflectionOutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    outcome_summary: { type: "string", minLength: 1 },
    what_worked: stringArray,
    what_was_correct: stringArray,
    what_failed: stringArray,
    root_causes: stringArray,
    avoidable_rework: stringArray,
    process_improvements: stringArray,
    improvements: stringArray,
    classifications: reflectionClassificationsSchema,
    candidate_regression_tests: stringArray,
    evidence_paths: stringArray,
  },
  required: [
    "outcome_summary",
    "what_worked",
    "what_was_correct",
    "what_failed",
    "root_causes",
    "avoidable_rework",
    "process_improvements",
    "improvements",
    "classifications",
    "candidate_regression_tests",
    "evidence_paths",
  ],
} as const;

export const improvementPlanOutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    reflection_source: { type: "string", minLength: 1 },
    observed_problem: stringArray,
    evidence: stringArray,
    recommended_changes: stringArray,
    expected_benefits: stringArray,
    implementation_sequence: stringArray,
    tests_and_acceptance_criteria: stringArray,
    risks: stringArray,
    out_of_scope: stringArray,
  },
  required: [
    "reflection_source",
    "observed_problem",
    "evidence",
    "recommended_changes",
    "expected_benefits",
    "implementation_sequence",
    "tests_and_acceptance_criteria",
    "risks",
    "out_of_scope",
  ],
} as const;

export const replanPatchOutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    target_work_item_id: { type: "string", minLength: 1 },
    base_plan_revision: { type: "integer", minimum: 1 },
    unresolved_finding_ids: {
      type: "array",
      minItems: 1,
      items: { type: "string", pattern: "^finding:[a-f0-9]{64}$" },
    },
    revised_objective: {
      anyOf: [
        { type: "string", minLength: 1 },
        { type: "null" },
      ],
    },
    added_or_changed_criteria: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          ref: { type: "string", minLength: 1, pattern: "^BH-\\d{3}:AC-\\d+$" },
          text: { type: "string", minLength: 1 },
        },
        required: ["ref", "text"],
      },
    },
    changed_instructions: stringArray,
    added_change_units: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string", minLength: 1 },
          path: artifactPathSchema,
          target: { type: "string", minLength: 1 },
          operation: { type: "string", enum: ["create", "modify", "delete"] },
          requirements: nonEmptyStringArray,
          satisfies: nonEmptyStringArray,
        },
        required: ["id", "path", "target", "operation", "requirements", "satisfies"],
      },
    },
    added_verification_commands: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string", minLength: 1 },
          argv: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
          expected_exit_code: { type: "integer", enum: [0] },
          tier: { type: "string", enum: ["focused", "cross_cutting"] },
          satisfies: nonEmptyStringArray,
        },
        required: ["id", "argv", "expected_exit_code", "tier", "satisfies"],
      },
    },
    added_cross_cutting_impacts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          change_unit_id: { type: "string", minLength: 1 },
          category: {
            type: "string",
            enum: ["shared_helper", "runtime", "cli_lifecycle", "ledger", "artifact_paths"],
          },
          callers: stringArray,
          representative_fixtures: stringArray,
          verification_command_ids: nonEmptyStringArray,
        },
        required: [
          "change_unit_id",
          "category",
          "callers",
          "representative_fixtures",
          "verification_command_ids",
        ],
      },
    },
    added_read_only_file_contracts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: artifactPathSchema,
          targets: nonEmptyStringArray,
        },
        required: ["path", "targets"],
      },
    },
    explicitly_rejected_hardening: stringArray,
  },
  required: [
    "target_work_item_id",
    "base_plan_revision",
    "unresolved_finding_ids",
    "revised_objective",
    "added_or_changed_criteria",
    "changed_instructions",
    "added_change_units",
    "added_verification_commands",
    "added_cross_cutting_impacts",
    "added_read_only_file_contracts",
    "explicitly_rejected_hardening",
  ],
} as const;

// Short aliases are convenient for adapters while the role-specific names remain explicit.
export const BrainPlanOutputSchema = brainPlanOutputSchema;
export const ImplementationResultOutputSchema = implementationResultOutputSchema;
export const ReplanPatchOutputSchema = replanPatchOutputSchema;
export const VerifierReviewOutputSchema = verifierReviewOutputSchema;
export const ReflectionOutputSchema = reflectionOutputSchema;
export const ImprovementPlanOutputSchema = improvementPlanOutputSchema;
export const brainPlanSchema = brainPlanOutputSchema;
export const implementationResultSchema = implementationResultOutputSchema;
export const verifierReviewSchema = verifierReviewOutputSchema;
export const reflectionSchema = reflectionOutputSchema;
export const improvementPlanSchema = improvementPlanOutputSchema;
