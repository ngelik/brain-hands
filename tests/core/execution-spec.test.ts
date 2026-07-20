import { describe, expect, it } from "vitest";
import {
  assertPlanReady,
  PlanReadinessError,
  planReadinessDiagnostics,
  assertSparkReady,
  parseExecutionPlan,
  serializePersistedPlan,
  validateDiscoveryCoverage,
} from "../../src/core/execution-spec.js";
import { discoveredBrainPlanSchema, executionSpecV2Schema } from "../../src/core/schema.js";
import { discoveredBrainPlanOutputSchema, executionSpecV2OutputSchema } from "../../src/core/output-schemas.js";
import type { BrainPlan, DiscoveryBrief, DiscoveredBrainPlan, ExecutionSpecV2 } from "../../src/core/types.js";

function validExecutionSpec(): ExecutionSpecV2 {
  return {
    schema_version: "2.0" as const,
    id: "BH-001",
    title: "Update output schema compatibility",
    objective: "Keep Codex output schemas compatible without weakening runtime parsing.",
    dependencies: [],
    file_contract: [
      {
        path: "src/core/output-schemas.ts",
        permission: "modify" as const,
        targets: ["browserCheckSchema"],
      },
      {
        path: "tests/core/schema.test.ts",
        permission: "modify" as const,
        targets: ["output schema compatibility tests"],
      },
    ],
    forbidden_changes: [
      {
        path: "src/core/schema.ts",
        except: [],
        reason: "Runtime validation must remain unchanged.",
      },
    ],
    change_units: [
      {
        id: "CH-01",
        path: "src/core/output-schemas.ts",
        target: "browserCheckSchema",
        operation: "modify" as const,
        requirements: ["Remove the URI format annotation from the URL property."],
      },
      {
        id: "CH-02",
        path: "tests/core/schema.test.ts",
        target: "output schema compatibility tests",
        operation: "modify" as const,
        requirements: ["Add the TEST-01 regression assertion."],
      },
    ],
    acceptance: [
      {
        id: "AC-01",
        statement: "The Codex browser-check output schema has no URI format annotation.",
        satisfied_by: ["CH-01", "TEST-01"],
      },
    ],
    tests: [
      {
        id: "TEST-01",
        path: "tests/core/schema.test.ts",
        assertion: "The generated URL property does not define format.",
        verification_command_ids: ["VERIFY-01"],
      },
    ],
    verification_commands: [
      {
        id: "VERIFY-01",
        argv: ["node", "node_modules/vitest/vitest.mjs", "run", "tests/core/schema.test.ts"],
        expected_exit_code: 0,
        tier: "focused",
      },
      {
        id: "VERIFY-02",
        argv: ["npm", "run", "typecheck"],
        expected_exit_code: 0,
        tier: "cross_cutting",
      },
    ],
    cross_cutting_impacts: [
      {
        change_unit_id: "CH-01",
        category: "shared_helper",
        callers: ["tests/core/schema.test.ts"],
        representative_fixtures: ["tests/core/schema.test.ts"],
        verification_command_ids: ["VERIFY-02"],
      },
    ],
    expected_artifacts: [],
    browser_checks: [],
    risks: [
      {
        description: "Output and runtime schemas could be changed together.",
        mitigation: "Keep src/core/schema.ts forbidden and verify runtime tests separately.",
      },
    ],
    completion_contract: {
      expected_changed_files: [
        "src/core/output-schemas.ts",
        "tests/core/schema.test.ts",
      ],
      allow_additional_files: false,
      required_acceptance_ids: ["AC-01"],
    },
    ambiguity_policy: {
      default: "stop_and_report" as const,
      stop_when: ["A required change needs a file outside file_contract."],
    },
  };
}

describe("executionSpecV2Schema", () => {
  it("accepts a complete execution contract", () => {
    expect(executionSpecV2Schema.parse(validExecutionSpec())).toEqual(validExecutionSpec());
  });

  it("keeps legacy v2 plans parseable without funnel metadata", () => {
    const legacy = validExecutionSpec();
    delete legacy.cross_cutting_impacts;
    for (const command of legacy.verification_commands) delete command.tier;

    expect(executionSpecV2Schema.parse(legacy)).toEqual(legacy);
  });

  it("requires funnel metadata in new structured output", () => {
    expect(executionSpecV2OutputSchema.required).toContain("cross_cutting_impacts");
    const command = executionSpecV2OutputSchema.properties.verification_commands.items;
    expect(command.required).toContain("tier");
  });

  it("requires direct argv arrays for verification", () => {
    const spec = validExecutionSpec();
    const parsed = executionSpecV2Schema.safeParse({
      ...spec,
      verification_commands: [{ id: "VERIFY-01", argv: "npm test", expected_exit_code: 0 }],
    });

    expect(parsed.success).toBe(false);
  });

  it("only permits the runtime-supported zero exit code", () => {
    const spec = validExecutionSpec();
    const parsed = executionSpecV2Schema.safeParse({
      ...spec,
      verification_commands: [{ ...spec.verification_commands[0], expected_exit_code: 1 }],
    });

    expect(parsed.success).toBe(false);
  });
});

describe("assertSparkReady", () => {
  it("accepts a fully traceable contract", () => {
    expect(() => assertSparkReady(executionSpecV2Schema.parse(validExecutionSpec()))).not.toThrow();
  });

  it("aggregates testing-funnel readiness errors", () => {
    const raw = validExecutionSpec();
    for (const command of raw.verification_commands) command.tier = "cross_cutting";

    expect(() => assertSparkReady(executionSpecV2Schema.parse(raw))).toThrow(
      /BH-001 has no focused verification command/,
    );
  });

  it("reports duplicate IDs and unresolved evidence references together", () => {
    const spec = executionSpecV2Schema.parse({
      ...validExecutionSpec(),
      change_units: [
        validExecutionSpec().change_units[0],
        { ...validExecutionSpec().change_units[1], id: "CH-01" },
      ],
      acceptance: [
        {
          id: "AC-01",
          statement: "The output schema is compatible.",
          satisfied_by: ["CH-404", "TEST-404"],
        },
      ],
    });

    expect(() => assertSparkReady(spec)).toThrowError(/duplicate id CH-01[\s\S]*unknown evidence CH-404[\s\S]*unknown evidence TEST-404/);
  });

  it("rejects change paths outside the file contract", () => {
    const spec = executionSpecV2Schema.parse({
      ...validExecutionSpec(),
      change_units: [
        ...validExecutionSpec().change_units,
        {
          id: "CH-03",
          path: "README.md",
          target: "usage section",
          operation: "modify",
          requirements: ["Add the new usage example."],
        },
      ],
    });

    expect(() => assertSparkReady(spec)).toThrowError(/CH-03 path README\.md is not in file_contract/);
  });

  it("rejects an aligned glob in file, change-unit, and completion contracts", () => {
    const spec = validExecutionSpec();
    spec.file_contract[0]!.path = "src/*.ts";
    spec.change_units[0]!.path = "src/*.ts";
    spec.completion_contract.expected_changed_files[0] = "src/*.ts";

    expect(() => assertSparkReady(spec)).toThrowError(
      /file_contract path src\/\*\.ts must be repository-relative and normalized[\s\S]*CH-01 path src\/\*\.ts must be repository-relative and normalized[\s\S]*completion_contract path src\/\*\.ts must be repository-relative and normalized/,
    );
  });

  it("requires the completion file set to match the modifiable file contract", () => {
    const spec = executionSpecV2Schema.parse({
      ...validExecutionSpec(),
      completion_contract: {
        ...validExecutionSpec().completion_contract,
        expected_changed_files: ["src/core/output-schemas.ts"],
      },
    });

    expect(() => assertSparkReady(spec)).toThrowError(/completion_contract is missing tests\/core\/schema\.test\.ts/);
  });

  it("rejects vague instructions that require Hands to decide scope", () => {
    const spec = executionSpecV2Schema.parse({
      ...validExecutionSpec(),
      change_units: [
        {
          ...validExecutionSpec().change_units[0],
          requirements: ["Update related schemas as needed."],
        },
        validExecutionSpec().change_units[1],
      ],
    });

    expect(() => assertSparkReady(spec)).toThrowError(/CH-01 contains vague requirement.*as needed/);
  });

  it("requires every test to be connected to a verification command", () => {
    const spec = executionSpecV2Schema.parse({
      ...validExecutionSpec(),
      tests: [{ ...validExecutionSpec().tests[0], verification_command_ids: [] }],
    });

    expect(() => assertSparkReady(spec)).toThrowError(/TEST-01 has no verification command/);
  });

  it.each(["item/a", "integrated"])('rejects unsafe or reserved work-item id "%s"', (id) => {
    const spec = executionSpecV2Schema.parse({ ...validExecutionSpec(), id });

    expect(() => assertSparkReady(spec)).toThrowError(/work item id .*must use safe artifact characters|work item id integrated is reserved/);
  });

  it("requires every declared file target to map to exactly one matching change unit", () => {
    const spec = executionSpecV2Schema.parse({
      ...validExecutionSpec(),
      file_contract: [
        { ...validExecutionSpec().file_contract[0], targets: ["browserCheckSchema", "missing target"] },
        validExecutionSpec().file_contract[1],
      ],
      change_units: [
        { ...validExecutionSpec().change_units[0], target: "undeclared target" },
        validExecutionSpec().change_units[1],
      ],
    });

    expect(() => assertSparkReady(spec)).toThrowError(
      /CH-01 target undeclared target is not declared for src\/core\/output-schemas\.ts[\s\S]*browserCheckSchema has no change unit[\s\S]*missing target has no change unit/,
    );
  });

  it("rejects multiple change units for the same declared file target", () => {
    const spec = executionSpecV2Schema.parse({
      ...validExecutionSpec(),
      change_units: [
        ...validExecutionSpec().change_units,
        { ...validExecutionSpec().change_units[0], id: "CH-03" },
      ],
    });

    expect(() => assertSparkReady(spec)).toThrowError(
      /src\/core\/output-schemas\.ts target browserCheckSchema maps to multiple change units CH-01, CH-03/,
    );
  });

  it("requires executable evidence for every acceptance criterion", () => {
    const spec = executionSpecV2Schema.parse({
      ...validExecutionSpec(),
      acceptance: [{ id: "AC-01", statement: "The code changed.", satisfied_by: ["CH-01"] }],
    });

    expect(() => assertSparkReady(spec)).toThrowError(/AC-01 has no test or verification evidence/);
  });

  it("requires a change unit for every changeable file", () => {
    const spec = executionSpecV2Schema.parse({
      ...validExecutionSpec(),
      change_units: [validExecutionSpec().change_units[0]],
    });

    expect(() => assertSparkReady(spec)).toThrowError(/tests\/core\/schema\.test\.ts has no change unit/);
  });

  it("preserves narrative-file authorization through explicit change units", () => {
    const raw = validExecutionSpec();
    raw.file_contract.push({
      path: "README.md",
      permission: "modify",
      targets: ["usage narrative"],
    });

    expect(() => assertSparkReady(executionSpecV2Schema.parse(raw))).toThrow(/README\.md has no change unit/);

    raw.change_units.push({
      id: "CH-03",
      path: "README.md",
      target: "usage narrative",
      operation: "modify",
      requirements: ["Document the approved usage behavior."],
    });
    raw.completion_contract.expected_changed_files.push("README.md");

    expect(() => assertSparkReady(executionSpecV2Schema.parse(raw))).not.toThrow();
  });

  it("requires wildcard forbidden-change rules to except every allowed file", () => {
    const spec = executionSpecV2Schema.parse({
      ...validExecutionSpec(),
      forbidden_changes: [{
        path: "*",
        except: ["src/core/output-schemas.ts"],
        reason: "No other files may change.",
      }],
    });

    expect(() => assertSparkReady(spec)).toThrowError(/forbidden wildcard does not except tests\/core\/schema\.test\.ts/);
  });

  it("rejects open-ended completion scope", () => {
    const spec = executionSpecV2Schema.parse({
      ...validExecutionSpec(),
      completion_contract: {
        ...validExecutionSpec().completion_contract,
        allow_additional_files: true,
      },
    });

    expect(() => assertSparkReady(spec)).toThrowError(/completion_contract must not allow additional files/);
  });

  it.each([
    ["dependencies", (spec: ReturnType<typeof validExecutionSpec>) => { spec.dependencies = ["BH-000", "BH-000"]; }, /duplicate dependency BH-000/],
    ["acceptance evidence", (spec: ReturnType<typeof validExecutionSpec>) => { spec.acceptance[0].satisfied_by = ["TEST-01", "TEST-01"]; }, /AC-01 contains duplicate evidence reference TEST-01/],
    ["test command references", (spec: ReturnType<typeof validExecutionSpec>) => { spec.tests[0].verification_command_ids = ["VERIFY-01", "VERIFY-01"]; }, /TEST-01 contains duplicate verification command VERIFY-01/],
    ["expected artifacts", (spec: ReturnType<typeof validExecutionSpec>) => { spec.expected_artifacts = ["artifacts/result.json", "artifacts/result.json"]; }, /duplicate expected artifact artifacts\/result\.json/],
    ["completion files", (spec: ReturnType<typeof validExecutionSpec>) => { spec.completion_contract.expected_changed_files.push("tests/core/schema.test.ts"); }, /completion_contract contains duplicate file tests\/core\/schema\.test\.ts/],
    ["required acceptance", (spec: ReturnType<typeof validExecutionSpec>) => { spec.completion_contract.required_acceptance_ids.push("AC-01"); }, /completion_contract contains duplicate acceptance criterion AC-01/],
  ] as const)("rejects duplicate %s", (_label, mutate, expected) => {
    const raw = validExecutionSpec();
    mutate(raw);
    const spec = executionSpecV2Schema.parse(raw);

    expect(() => assertSparkReady(spec)).toThrowError(expected);
  });

  it("rejects case-insensitive file-contract collisions", () => {
    const raw = validExecutionSpec();
    raw.file_contract[1].path = "SRC/CORE/OUTPUT-SCHEMAS.TS";
    raw.change_units[1].path = "SRC/CORE/OUTPUT-SCHEMAS.TS";
    raw.completion_contract.expected_changed_files[1] = "SRC/CORE/OUTPUT-SCHEMAS.TS";
    raw.tests = [];
    raw.acceptance[0].satisfied_by = ["VERIFY-01"];
    const spec = executionSpecV2Schema.parse(raw);

    expect(() => assertSparkReady(spec)).toThrowError(
      /file_contract paths collide case-insensitively: src\/core\/output-schemas\.ts, SRC\/CORE\/OUTPUT-SCHEMAS\.TS/,
    );
  });

  it("rejects Git metadata paths that worktree scope checks cannot observe", () => {
    const raw = validExecutionSpec();
    raw.file_contract[0].path = ".git/config";
    raw.change_units[0].path = ".git/config";
    raw.completion_contract.expected_changed_files[0] = ".git/config";
    const spec = executionSpecV2Schema.parse(raw);

    expect(() => assertSparkReady(spec)).toThrowError(/file_contract path \.git\/config targets reserved Git metadata/);
  });

  it("rejects C1 control characters in repository execution-contract paths", () => {
    const raw = validExecutionSpec();
    const unsafePath = "src/control\u0085.ts";
    raw.file_contract[0].path = unsafePath;
    raw.change_units[0].path = unsafePath;
    raw.completion_contract.expected_changed_files[0] = unsafePath;
    const spec = executionSpecV2Schema.parse(raw);

    expect(() => assertSparkReady(spec)).toThrowError(/file_contract path .* must be repository-relative and normalized/);
  });

  it.each([
    ["name", { name: "desktop", screenshot_artifact: "artifacts/mobile.png" }, /duplicate browser check name desktop/],
    ["screenshot", { name: "mobile", screenshot_artifact: "artifacts/desktop.png" }, /duplicate browser screenshot artifact artifacts\/desktop\.png/],
  ])("rejects duplicate browser-check %s keys", (_label, second, expected) => {
    const browserCheck = {
      name: "desktop",
      url: "http://127.0.0.1:5177/",
      local_server_command: "npm run dev",
      required_selectors: [],
      console_error_policy: "no_errors" as const,
      expected_network: [],
      screenshot_artifact: "artifacts/desktop.png",
    };
    const spec = executionSpecV2Schema.parse({
      ...validExecutionSpec(),
      browser_checks: [browserCheck, { ...browserCheck, ...second }],
    });

    expect(() => assertSparkReady(spec)).toThrowError(expected as RegExp);
  });

  it("detects forbidden paths that collide with allowed files by case", () => {
    const spec = executionSpecV2Schema.parse({
      ...validExecutionSpec(),
      forbidden_changes: [{
        path: "SRC/CORE/OUTPUT-SCHEMAS.TS",
        except: [],
        reason: "Do not modify the schema.",
      }],
    });

    expect(() => assertSparkReady(spec)).toThrowError(
      /forbidden path SRC\/CORE\/OUTPUT-SCHEMAS\.TS conflicts case-insensitively with file_contract path src\/core\/output-schemas\.ts/,
    );
  });

  it.each([
    ["file contract", { file_contract: [{ ...validExecutionSpec().file_contract[0], path: "../outside.ts" }, validExecutionSpec().file_contract[1]] }, /file_contract path \.\.\/outside\.ts must be repository-relative and normalized/],
    ["expected artifact", { expected_artifacts: ["../outside.json"] }, /expected_artifact path \.\.\/outside\.json must be repository-relative and normalized/],
    ["browser screenshot", { browser_checks: [{
      name: "desktop",
      url: "https://example.com/",
      local_server_command: "npm run dev",
      required_selectors: [],
      console_error_policy: "no_errors",
      expected_network: [],
      screenshot_artifact: "/tmp/outside.png",
    }] }, /browser screenshot path \/tmp\/outside\.png must be repository-relative and normalized/],
  ])("rejects a non-canonical %s path", (_label, override, _expected) => {
    expect(() => {
      const spec = executionSpecV2Schema.parse({ ...validExecutionSpec(), ...override });
      assertSparkReady(spec);
    }).toThrow();
  });
});

function validPlan(): BrainPlan {
  return {
    summary: "Implement one item.",
    assumptions: [],
    research: [],
    research_sources: ["repository"],
    architecture: "Keep the change focused.",
    risks: [],
    work_items: [executionSpecV2Schema.parse(validExecutionSpec())],
    integration_verification: [["npm", "test"]],
  };
}

describe("plan readiness", () => {
  it("accepts discovery decision coverage in a discovered plan", () => {
    const plan = {
      ...validPlan(),
      discovery_brief_revision: 1,
      discovery_brief_sha256: "a".repeat(64),
      discovery_decision_coverage: [{
        decision_id: "d-001",
        work_item_ids: ["BH-001"],
        acceptance_ids: ["AC-01"],
        verification_command_ids: ["VERIFY-01"],
        no_implementation_effect: null,
      }],
      accepted_risks: [],
      out_of_scope: [],
    };

    expect(discoveredBrainPlanSchema.parse(plan)).toEqual(plan);
  });

  it("rejects incomplete or open-ended discovery decision coverage", () => {
    const plan = {
      ...validPlan(),
      discovery_brief_revision: 1,
      discovery_brief_sha256: "a".repeat(64),
      discovery_decision_coverage: [{
        decision_id: "decision-1",
        work_item_ids: [],
        acceptance_ids: [],
        verification_command_ids: [],
        no_implementation_effect: "No code change.",
        hidden_instruction: "widen scope",
      }],
    };

    expect(discoveredBrainPlanSchema.safeParse(plan).success).toBe(false);
  });

  const discoveryBrief: DiscoveryBrief = {
    revision: 2,
    goal: "Bind planning to discovery",
    problem: "Planning can drift from approved decisions.",
    success_criteria: ["Every decision is traceable."],
    constraints: ["Keep legacy plans compatible."],
    decisions: [
      { id: "d-001", statement: "Use the existing planner.", source_question_ids: [] },
      { id: "d-002", statement: "Do not change documentation.", source_question_ids: [] },
    ],
    assumptions: [{
      id: "a-001",
      statement: "The existing test command remains available.",
      source: "brain_inference",
      source_question_ids: [],
    }],
    selected_approach_id: null,
    selected_approach_rationale: null,
    out_of_scope: ["Documentation"],
    accepted_risks: [],
    repository_evidence: ["src/workflow/planner.ts"],
  };

  function coveredPlan(overrides: Partial<DiscoveredBrainPlan> = {}): DiscoveredBrainPlan {
    return {
      ...validPlan(),
      assumptions: discoveryBrief.assumptions.map((assumption) => assumption.statement),
      out_of_scope: [...discoveryBrief.out_of_scope],
      accepted_risks: [...discoveryBrief.accepted_risks],
      discovery_brief_revision: discoveryBrief.revision,
      discovery_brief_sha256: "a".repeat(64),
      discovery_decision_coverage: [
        {
          decision_id: "d-001",
          work_item_ids: ["BH-001"],
          acceptance_ids: ["AC-01"],
          verification_command_ids: ["VERIFY-01"],
          no_implementation_effect: null,
        },
        {
          decision_id: "d-002",
          work_item_ids: [],
          acceptance_ids: [],
          verification_command_ids: [],
          no_implementation_effect: "The decision explicitly excludes documentation changes.",
        },
      ],
      ...overrides,
    } as DiscoveredBrainPlan;
  }

  it("accepts complete unique decision coverage with valid plan references", () => {
    expect(() => validateDiscoveryCoverage(coveredPlan(), discoveryBrief)).not.toThrow();
  });

  it.each([
    ["accepted risks", { accepted_risks: ["Different risk"] }],
    ["out of scope", { out_of_scope: ["Different exclusion"] }],
  ])("rejects plan %s that differ from the approved brief", (_label, override) => {
    expect(() => validateDiscoveryCoverage(coveredPlan(override), discoveryBrief))
      .toThrow(/accepted risks|out of scope/i);
  });

  it.each(["acceptance", "verification"])(
    "rejects plan-global duplicate %s IDs",
    (kind) => {
      const duplicate = { ...validExecutionSpec(), id: "BH-002" };
      duplicate.file_contract = [];
      duplicate.change_units = [];
      duplicate.tests = [];
      duplicate.completion_contract.expected_changed_files = [];
      duplicate.acceptance = kind === "acceptance" ? duplicate.acceptance : [];
      duplicate.verification_commands = kind === "verification" ? duplicate.verification_commands : [];
      const plan = coveredPlan({ work_items: [validExecutionSpec(), duplicate] });

      expect(() => validateDiscoveryCoverage(plan, discoveryBrief)).toThrow(
        new RegExp(`duplicate ${kind} (criterion |command )?ID`, "i"),
      );
    },
  );

  it.each([
    ["acceptance", { acceptance_ids: ["AC-02"], verification_command_ids: [] }, /acceptance criterion AC-02 owned by BH-002/],
    ["verification", { acceptance_ids: [], verification_command_ids: ["VERIFY-03"] }, /verification command VERIFY-03 owned by BH-002/],
  ])("rejects a cross-owner %s coverage reference", (_kind, rowOverride, expected) => {
    const second = { ...validExecutionSpec(), id: "BH-002" };
    second.acceptance = [{ ...second.acceptance[0], id: "AC-02" }];
    second.verification_commands = [{ ...second.verification_commands[0], id: "VERIFY-03" }];
    const [firstCoverage, noEffectCoverage] = coveredPlan().discovery_decision_coverage;
    const plan = coveredPlan({
      work_items: [validExecutionSpec(), second],
      discovery_decision_coverage: [{
        ...firstCoverage,
        work_item_ids: ["BH-001"],
        ...rowOverride,
      }, noEffectCoverage],
    });

    expect(() => validateDiscoveryCoverage(plan, discoveryBrief)).toThrow(expected);
  });

  it.each([
    ["missing", [{ ...coveredPlan().discovery_decision_coverage[0] }]],
    ["duplicate", [...coveredPlan().discovery_decision_coverage, { ...coveredPlan().discovery_decision_coverage[0] }]],
  ])("rejects %s discovery decision coverage", (_label, discovery_decision_coverage) => {
    expect(() => validateDiscoveryCoverage(coveredPlan({ discovery_decision_coverage }), discoveryBrief))
      .toThrow(/decision coverage/i);
  });

  it.each([
    ["work item", { work_item_ids: ["BH-404"] }, /unknown work item BH-404/],
    ["acceptance", { acceptance_ids: ["AC-404"] }, /unknown acceptance criterion AC-404/],
    ["verification", { verification_command_ids: ["VERIFY-404"] }, /unknown verification command VERIFY-404/],
  ])("rejects an unknown %s coverage reference", (_label, rowOverride, expected) => {
    const [first, second] = coveredPlan().discovery_decision_coverage;
    expect(() => validateDiscoveryCoverage(coveredPlan({
      discovery_decision_coverage: [{ ...first, ...rowOverride }, second],
    }), discoveryBrief)).toThrow(expected);
  });

  it("rejects coverage that mixes concrete mappings with no_implementation_effect", () => {
    const [first, second] = coveredPlan().discovery_decision_coverage;
    expect(() => validateDiscoveryCoverage(coveredPlan({
      discovery_decision_coverage: [{ ...first, no_implementation_effect: "No implementation effect." }, second],
    }), discoveryBrief)).toThrow(/exactly one of concrete mappings or no_implementation_effect/);
  });

  it("rejects coverage with neither concrete mappings nor no_implementation_effect", () => {
    const [first, second] = coveredPlan().discovery_decision_coverage;
    expect(() => validateDiscoveryCoverage(coveredPlan({
      discovery_decision_coverage: [{
        ...first,
        work_item_ids: [],
        acceptance_ids: [],
        verification_command_ids: [],
      }, second],
    }), discoveryBrief)).toThrow(/exactly one of concrete mappings or no_implementation_effect/);
  });

  it("requires approved discovery assumptions to be carried unchanged", () => {
    expect(() => validateDiscoveryCoverage(coveredPlan({ assumptions: ["A changed assumption."] }), discoveryBrief))
      .toThrow(/assumptions must exactly match/i);
  });

  it("rejects a dependency on a missing work item", () => {
    const plan = validPlan();
    plan.work_items[0].dependencies = ["BH-404"];

    expect(() => assertPlanReady(plan)).toThrowError(/BH-001 depends on missing work item BH-404/);
  });

  it("returns stable structured diagnostics for replay and repair", () => {
    const plan = validPlan();
    plan.work_items[0].dependencies = ["BH-404"];

    expect(planReadinessDiagnostics(plan)).toEqual([{
      code: "plan.graph",
      path: "/work_items/0/dependencies",
      message: "BH-001 depends on missing work item BH-404",
    }]);
    try {
      assertPlanReady(plan);
      throw new Error("expected readiness failure");
    } catch (error) {
      expect(error).toBeInstanceOf(PlanReadinessError);
      expect((error as PlanReadinessError).diagnostics).toEqual(planReadinessDiagnostics(plan));
    }
  });

  it("rejects cyclic work-item dependencies before approval", () => {
    const first = executionSpecV2Schema.parse(validExecutionSpec());
    const second = { ...first, id: "BH-002", dependencies: ["BH-001"] };
    first.dependencies = ["BH-002"];
    const plan = { ...validPlan(), work_items: [first, second] };

    expect(() => assertPlanReady(plan)).toThrowError(/cyclic dependency involving BH-001/);
  });

  it("revalidates persisted plan JSON instead of trusting a type cast", () => {
    const plan = validPlan();
    plan.work_items[0].completion_contract.allow_additional_files = true;

    expect(() => parseExecutionPlan(plan)).toThrowError(/not execution-ready[\s\S]*must not allow additional files/);
  });

  it("does not waive non-funnel readiness defects for an exact pre-funnel item", () => {
    const plan = validPlan();
    const item = plan.work_items[0]!;
    delete item.cross_cutting_impacts;
    for (const command of item.verification_commands) delete command.tier;
    item.completion_contract.allow_additional_files = true;

    expect(() => parseExecutionPlan(plan, undefined, "legacy-v2")).toThrowError(
      /completion_contract must not allow additional files/,
    );
  });

  it("selects the persisted plan schema from the manifest protocol", () => {
    expect(() => parseExecutionPlan(validPlan(), undefined, "durable-discovery-v1")).toThrowError(
      /discovery_brief_revision/,
    );
    expect(() => parseExecutionPlan(validPlan(), undefined, "legacy-v2")).not.toThrow();
  });

  it("recovers an exact pre-funnel legacy plan that changes the ledger critical path", () => {
    const plan = validPlan();
    for (const workItem of plan.work_items) {
      delete workItem.cross_cutting_impacts;
      for (const command of workItem.verification_commands) delete command.tier;
    }
    const item = plan.work_items[0] as unknown as Record<string, unknown>;
    Object.assign(item, {
      file_contract: [{ path: "src/core/ledger.ts", permission: "modify", targets: ["legacy resume"] }],
      change_units: [{ id: "CH-01", path: "src/core/ledger.ts", target: "legacy resume", operation: "modify", requirements: ["Preserve legacy run recovery."] }],
      tests: [{ id: "TEST-01", path: "src/core/ledger.ts", assertion: "Legacy ledger resumes.", verification_command_ids: ["VERIFY-01"] }],
      completion_contract: { expected_changed_files: ["src/core/ledger.ts"], allow_additional_files: false, required_acceptance_ids: ["AC-01"] },
    });

    expect(parseExecutionPlan(plan, undefined, "legacy-v2")).toEqual(plan);
  });

  it("recovers an exact pre-funnel durable-discovery plan that changes the ledger critical path", () => {
    const plan = coveredPlan();
    const item = plan.work_items[0] as unknown as Record<string, unknown>;
    delete item.cross_cutting_impacts;
    for (const command of item.verification_commands as Array<Record<string, unknown>>) delete command.tier;
    Object.assign(item, {
      file_contract: [{ path: "src/core/ledger.ts", permission: "modify", targets: ["durable legacy resume"] }],
      change_units: [{ id: "CH-01", path: "src/core/ledger.ts", target: "durable legacy resume", operation: "modify", requirements: ["Preserve durable legacy run recovery."] }],
      tests: [{ id: "TEST-01", path: "src/core/ledger.ts", assertion: "Durable legacy ledger resumes.", verification_command_ids: ["VERIFY-01"] }],
      completion_contract: { expected_changed_files: ["src/core/ledger.ts"], allow_additional_files: false, required_acceptance_ids: ["AC-01"] },
    });

    expect(() => parseExecutionPlan(plan, undefined, "durable-discovery-v1")).not.toThrow();
  });

  it("loads a mixed replan revision with one modern item and one untouched exact pre-funnel item", () => {
    const plan = validPlan();
    const modernizedTarget = structuredClone(plan.work_items[0]!);
    const untouchedLegacy = structuredClone(plan.work_items[0]!) as unknown as Record<string, unknown>;
    modernizedTarget.id = "BH-002";
    delete untouchedLegacy.cross_cutting_impacts;
    for (const command of untouchedLegacy.verification_commands as Array<Record<string, unknown>>) delete command.tier;
    Object.assign(untouchedLegacy, {
      file_contract: [{ path: "src/core/ledger.ts", permission: "modify", targets: ["untouched legacy resume"] }],
      change_units: [{ id: "CH-01", path: "src/core/ledger.ts", target: "untouched legacy resume", operation: "modify", requirements: ["Preserve the untouched legacy item."] }],
      tests: [{ id: "TEST-01", path: "src/core/ledger.ts", assertion: "The untouched legacy item remains loadable.", verification_command_ids: ["VERIFY-01"] }],
      completion_contract: { expected_changed_files: ["src/core/ledger.ts"], allow_additional_files: false, required_acceptance_ids: ["AC-01"] },
    });
    plan.work_items = [modernizedTarget, untouchedLegacy as unknown as ExecutionSpecV2];

    expect(() => parseExecutionPlan(plan, undefined, "legacy-v2")).not.toThrow();
  });

  it("rejects a funnel-invalid modern sibling beside an exact pre-funnel item", () => {
    const plan = validPlan();
    const modern = structuredClone(plan.work_items[0]!);
    const legacy = structuredClone(plan.work_items[0]!);
    modern.id = "BH-002";
    modern.cross_cutting_impacts = [];
    delete legacy.cross_cutting_impacts;
    for (const command of legacy.verification_commands) delete command.tier;
    plan.work_items = [legacy, modern];

    expect(() => parseExecutionPlan(plan, undefined, "legacy-v2")).toThrowError(
      /BH-002: VERIFY-02 cross-cutting command is not owned by an impact record/,
    );
  });

  it.each([
    ["an explicit impact array", (item: Record<string, unknown>) => { item.cross_cutting_impacts = []; }],
    ["one command tier", (item: Record<string, unknown>) => {
      (item.verification_commands as Array<Record<string, unknown>>)[0]!.tier = "focused";
    }],
  ])("does not treat a partially modern legacy plan with %s as pre-funnel", (_label, modernize) => {
    const plan = validPlan();
    const item = plan.work_items[0] as unknown as Record<string, unknown>;
    delete item.cross_cutting_impacts;
    for (const command of item.verification_commands as Array<Record<string, unknown>>) delete command.tier;
    Object.assign(item, {
      file_contract: [{ path: "src/core/ledger.ts", permission: "modify", targets: ["legacy resume"] }],
      change_units: [{ id: "CH-01", path: "src/core/ledger.ts", target: "legacy resume", operation: "modify", requirements: ["Preserve legacy run recovery."] }],
      tests: [{ id: "TEST-01", path: "src/core/ledger.ts", assertion: "Legacy ledger resumes.", verification_command_ids: ["VERIFY-01"] }],
      completion_contract: { expected_changed_files: ["src/core/ledger.ts"], allow_additional_files: false, required_acceptance_ids: ["AC-01"] },
    });
    modernize(item);

    expect(() => parseExecutionPlan(plan, undefined, "legacy-v2")).toThrow(/critical path|verification command/i);
  });

  it("serializes validated persisted plans in the exact revision artifact format", () => {
    const plan = validPlan();
    expect(serializePersistedPlan(plan, "legacy-v2")).toBe(`${JSON.stringify(plan, null, 2)}\n`);
  });

  it("rejects whitespace-only no_implementation_effect reasons", () => {
    const plan = coveredPlan();
    plan.discovery_decision_coverage[1].no_implementation_effect = "   \n";

    expect(discoveredBrainPlanSchema.safeParse(plan).success).toBe(false);
    expect(
      discoveredBrainPlanOutputSchema.properties.discovery_decision_coverage.items.properties
        .no_implementation_effect.pattern,
    ).toBe("\\S");
  });

  it("rejects unknown top-level plan fields instead of silently stripping them", () => {
    expect(() => parseExecutionPlan({ ...validPlan(), hidden_instruction: "widen scope" })).toThrowError(
      /Unrecognized key.*hidden_instruction/,
    );
  });

  it("rejects case-insensitive work-item artifact collisions", () => {
    const first = executionSpecV2Schema.parse(validExecutionSpec());
    const second = { ...executionSpecV2Schema.parse(validExecutionSpec()), id: "bh-001" };

    expect(() => assertPlanReady({ ...validPlan(), work_items: [first, second] })).toThrowError(
      /work item ids collide as artifact key bh-001/,
    );
  });

  it("rejects a change unit whose requirements explicitly forbid its byte change", () => {
    const plan = validPlan();
    plan.work_items[0].change_units[0].requirements = [
      "Perform no content change; use this modify operation only as an execution marker.",
    ];

    expect(() => assertPlanReady(plan)).toThrowError(
      /change requirement contradicts operation modify.*perform no content change/i,
    );
  });

  it("rejects browser screenshot collisions across work items", () => {
    const browserCheck = {
      name: "desktop",
      url: "http://127.0.0.1:5177/",
      local_server_command: "npm run dev",
      required_selectors: [],
      console_error_policy: "no_errors" as const,
      expected_network: [],
      screenshot_artifact: "artifacts/desktop.png",
    };
    const first = executionSpecV2Schema.parse({ ...validExecutionSpec(), browser_checks: [browserCheck] });
    const second = executionSpecV2Schema.parse({
      ...validExecutionSpec(),
      id: "BH-002",
      browser_checks: [{ ...browserCheck, name: "final-desktop" }],
    });

    expect(() => assertPlanReady({ ...validPlan(), work_items: [first, second] })).toThrowError(
      /duplicate browser screenshot artifact artifacts\/desktop\.png across work items BH-001 and BH-002/,
    );
  });

  it("checks frozen browser server commands before local approval", () => {
    const plan = validPlan();
    plan.work_items[0].verification_commands[0].argv = ["npm", "test"];
    plan.work_items[0].browser_checks = [{
      name: "desktop",
      url: "http://127.0.0.1:5177/",
      local_server_command: "npx vite --host 127.0.0.1",
      required_selectors: [],
      console_error_policy: "no_errors",
      expected_network: [],
      screenshot_artifact: "artifacts/desktop.png",
    }];

    expect(() => assertPlanReady(plan, { mode: "local", repoRoot: "/tmp/repo" })).toThrowError(
      /browser check desktop server command: Network or GitHub executable is not allowed in local verification: npx/,
    );
  });
});
