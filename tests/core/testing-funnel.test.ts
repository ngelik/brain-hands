import { describe, expect, it } from "vitest";
import {
  assertTestingFunnelReady,
  criticalVerificationSurfaces,
  effectiveVerificationTier,
  testingFunnelErrors,
} from "../../src/core/testing-funnel.js";
import type {
  CrossCuttingCategory,
  ExecutionCrossCuttingImpact,
  ExecutionSpecV2,
} from "../../src/core/types.js";
import { executionSpec } from "../fixtures/execution-spec.js";

const criticalRows: readonly (readonly [CrossCuttingCategory, string])[] = [
  ["shared_helper", "src/adapters/git.ts"],
  ["shared_helper", "src/adapters/github.ts"],
  ["shared_helper", "src/core/command.ts"],
  ["shared_helper", "src/core/config.ts"],
  ["shared_helper", "src/core/execution-spec.ts"],
  ["shared_helper", "src/core/executor.ts"],
  ["shared_helper", "src/core/output-schemas.ts"],
  ["shared_helper", "src/core/schema.ts"],
  ["shared_helper", "src/core/secret-detector.ts"],
  ["shared_helper", "src/workflow/authorization.ts"],
  ["runtime", "src/workflow/runtime.ts"],
  ["runtime", "src/workflow/orchestrator.ts"],
  ["runtime", "src/workflow/worker.ts"],
  ["runtime", "src/workflow/implementer.ts"],
  ["cli_lifecycle", "src/cli.ts"],
  ["cli_lifecycle", "src/workflow/preflight.ts"],
  ["cli_lifecycle", "src/workflow/status.ts"],
  ["cli_lifecycle", "src/core/run-state.ts"],
  ["cli_lifecycle", "src/core/run-configuration.ts"],
  ["cli_lifecycle", "src/core/controller-provenance.ts"],
  ["ledger", "src/core/ledger.ts"],
  ["ledger", "src/core/discovery-ledger.ts"],
  ["artifact_paths", "src/verification/runner.ts"],
  ["artifact_paths", "src/verification/evidence.ts"],
  ["artifact_paths", "src/workflow/owned-evidence.ts"],
  ["artifact_paths", "src/core/owned-evidence.ts"],
];

function addCrossCuttingCommand(spec: ExecutionSpecV2, id = "VERIFY-02"): void {
  spec.verification_commands.push({
    id,
    argv: ["npx", "vitest", "run", "tests/cross-cutting.test.ts"],
    expected_exit_code: 0,
    tier: "cross_cutting",
  });
}

function impact(
  spec: ExecutionSpecV2,
  overrides: Partial<ExecutionCrossCuttingImpact> = {},
): ExecutionCrossCuttingImpact {
  return {
    change_unit_id: spec.change_units[0]!.id,
    category: "shared_helper",
    callers: [spec.file_contract[1]!.path],
    representative_fixtures: [spec.file_contract[1]!.path],
    verification_command_ids: ["VERIFY-02"],
    ...overrides,
  };
}

describe("effectiveVerificationTier", () => {
  it("treats a legacy command without a tier as focused", () => {
    const command = executionSpec("BH-001").verification_commands[0]!;
    delete command.tier;

    expect(effectiveVerificationTier(command)).toBe("focused");
  });
});

describe("testingFunnelErrors", () => {
  it("uses the exact reviewed critical-surface registry", () => {
    const actualRows = Object.entries(criticalVerificationSurfaces).flatMap(
      ([category, paths]) => [...paths].map((path) => [category, path]),
    );

    expect(actualRows).toEqual(criticalRows);
  });

  it("requires a focused verification command", () => {
    const spec = executionSpec("BH-001");
    spec.verification_commands[0]!.tier = "cross_cutting";

    expect(testingFunnelErrors(spec)).toContain("BH-001 has no focused verification command");
  });

  it("requires focused commands to precede cross-cutting verification", () => {
    const spec = executionSpec("BH-001");
    addCrossCuttingCommand(spec, "VERIFY-02");
    spec.verification_commands.reverse();

    expect(testingFunnelErrors(spec)).toContain(
      "BH-001-VERIFY-01 focused command appears after cross-cutting verification",
    );
  });

  it("requires shared-helper callers", () => {
    const spec = executionSpec("BH-001");
    addCrossCuttingCommand(spec);
    spec.cross_cutting_impacts = [impact(spec, { callers: [] })];

    expect(testingFunnelErrors(spec)).toContain(
      "BH-001-CH-01 shared_helper impact requires at least one caller",
    );
  });

  it("requires representative fixtures", () => {
    const spec = executionSpec("BH-001");
    addCrossCuttingCommand(spec);
    spec.cross_cutting_impacts = [impact(spec, { representative_fixtures: [] })];

    expect(testingFunnelErrors(spec)).toContain(
      "BH-001-CH-01 cross-cutting impact requires at least one representative fixture",
    );
  });

  it("allows empty callers for non-shared impacts but still requires a fixture", () => {
    const spec = executionSpec("BH-001");
    spec.file_contract[0]!.path = "src/workflow/runtime.ts";
    spec.change_units[0]!.path = "src/workflow/runtime.ts";
    spec.completion_contract.expected_changed_files[0] = "src/workflow/runtime.ts";
    addCrossCuttingCommand(spec);
    spec.cross_cutting_impacts = [impact(spec, {
      category: "runtime",
      callers: [],
      representative_fixtures: [],
    })];

    expect(testingFunnelErrors(spec)).toEqual([
      "BH-001-CH-01 cross-cutting impact requires at least one representative fixture",
    ]);
  });

  it("accepts read-only caller and fixture contracts as cross-cutting evidence", () => {
    const spec = executionSpec("BH-001");
    spec.file_contract[0]!.path = "src/workflow/runtime.ts";
    spec.change_units[0]!.path = "src/workflow/runtime.ts";
    spec.completion_contract.expected_changed_files[0] = "src/workflow/runtime.ts";
    spec.file_contract.push(
      { path: "src/runtime-caller.ts", permission: "read_only", targets: ["runtime caller"] },
      { path: "tests/fixtures/runtime.ts", permission: "read_only", targets: ["runtime fixture"] },
    );
    addCrossCuttingCommand(spec);
    spec.cross_cutting_impacts = [impact(spec, {
      category: "runtime",
      callers: ["src/runtime-caller.ts"],
      representative_fixtures: ["tests/fixtures/runtime.ts"],
    })];

    expect(testingFunnelErrors(spec)).toEqual([]);
  });

  it("requires cross-cutting commands to be owned by an impact", () => {
    const spec = executionSpec("BH-001");
    addCrossCuttingCommand(spec, "VERIFY-02");

    expect(testingFunnelErrors(spec)).toContain(
      "VERIFY-02 cross-cutting command is not owned by an impact record",
    );
  });

  it("rejects an impact with an unknown change unit", () => {
    const spec = executionSpec("BH-001");
    addCrossCuttingCommand(spec);
    spec.cross_cutting_impacts = [impact(spec, { change_unit_id: "CH-404" })];

    expect(testingFunnelErrors(spec)).toContain(
      "CH-404 impact references an unknown change unit",
    );
  });

  it("rejects an impact with an unknown command", () => {
    const spec = executionSpec("BH-001");
    spec.cross_cutting_impacts = [impact(spec, { verification_command_ids: ["VERIFY-404"] })];

    expect(testingFunnelErrors(spec)).toContain(
      "BH-001-CH-01 impact references unknown command VERIFY-404",
    );
  });

  it("requires impact commands to be cross-cutting", () => {
    const spec = executionSpec("BH-001");
    spec.cross_cutting_impacts = [impact(spec, {
      verification_command_ids: [spec.verification_commands[0]!.id],
    })];

    expect(testingFunnelErrors(spec)).toContain(
      `BH-001-CH-01 impact command ${spec.verification_commands[0]!.id} is not cross_cutting`,
    );
  });

  it("requires impact caller and fixture paths in file_contract", () => {
    const spec = executionSpec("BH-001");
    addCrossCuttingCommand(spec);
    spec.cross_cutting_impacts = [impact(spec, {
      callers: ["src/caller.ts"],
      representative_fixtures: ["tests/fixture.ts"],
    })];

    const errors = testingFunnelErrors(spec);
    expect(errors).toContain("BH-001-CH-01 impact path src/caller.ts is not in file_contract");
    expect(errors).toContain("BH-001-CH-01 impact path tests/fixture.ts is not in file_contract");
  });

  it("requires acceptance criteria to reach a verification command", () => {
    const spec = executionSpec("BH-001");
    spec.acceptance[0]!.satisfied_by = [spec.change_units[0]!.id];

    expect(testingFunnelErrors(spec)).toContain(
      `${spec.acceptance[0]!.id} has no reachable verification command`,
    );
  });

  it("accepts acceptance to test to command reachability", () => {
    const spec = executionSpec("BH-001");
    spec.acceptance[0]!.satisfied_by = [spec.tests[0]!.id];

    expect(testingFunnelErrors(spec)).toEqual([]);
  });

  it("does not treat an unknown test command as acceptance reachability", () => {
    const spec = executionSpec("BH-001");
    const realCommandId = spec.verification_commands[0]!.id;
    spec.acceptance[0]!.satisfied_by = [spec.tests[0]!.id];
    spec.tests[0]!.verification_command_ids = ["VERIFY-404"];
    spec.tests.push({
      id: "TEST-02",
      path: spec.file_contract[1]!.path,
      assertion: "The real command remains consumed independently.",
      verification_command_ids: [realCommandId],
    });

    const errors = testingFunnelErrors(spec);
    expect(errors).toContain(
      `${spec.acceptance[0]!.id} has no reachable verification command`,
    );
    expect(errors).not.toContain(`${realCommandId} verification command is orphaned`);
  });

  it("accepts acceptance to command reachability", () => {
    const spec = executionSpec("BH-001");
    spec.acceptance[0]!.satisfied_by = [spec.verification_commands[0]!.id];

    expect(testingFunnelErrors(spec)).toEqual([]);
  });

  it("rejects orphaned verification commands", () => {
    const spec = executionSpec("BH-001");
    spec.verification_commands.push({
      id: "VERIFY-02",
      argv: ["npm", "run", "typecheck"],
      expected_exit_code: 0,
      tier: "focused",
    });

    expect(testingFunnelErrors(spec)).toContain("VERIFY-02 verification command is orphaned");
    expect(() => assertTestingFunnelReady(spec)).toThrow(
      /Execution spec BH-001 has an invalid testing funnel:[\s\S]*VERIFY-02 verification command is orphaned/,
    );
  });

  it.each([
    ["impact records", (spec: ExecutionSpecV2) => {
      addCrossCuttingCommand(spec);
      const record = impact(spec);
      spec.cross_cutting_impacts = [record, { ...record }];
    }, "BH-001-CH-01 has duplicate shared_helper impact records"],
    ["callers", (spec: ExecutionSpecV2) => {
      addCrossCuttingCommand(spec);
      const record = impact(spec);
      record.callers.push(record.callers[0]!);
      spec.cross_cutting_impacts = [record];
    }, "BH-001-CH-01 shared_helper impact has duplicate caller tests/BH-001.test.ts"],
    ["fixtures", (spec: ExecutionSpecV2) => {
      addCrossCuttingCommand(spec);
      const record = impact(spec);
      record.representative_fixtures.push(record.representative_fixtures[0]!);
      spec.cross_cutting_impacts = [record];
    }, "BH-001-CH-01 shared_helper impact has duplicate representative fixture tests/BH-001.test.ts"],
    ["command IDs", (spec: ExecutionSpecV2) => {
      addCrossCuttingCommand(spec);
      const record = impact(spec);
      record.verification_command_ids.push(record.verification_command_ids[0]!);
      spec.cross_cutting_impacts = [record];
    }, "BH-001-CH-01 shared_helper impact has duplicate verification command VERIFY-02"],
  ] as const)("rejects duplicate impact %s", (_label, mutate, message) => {
    const spec = executionSpec("BH-001");
    mutate(spec);

    expect(testingFunnelErrors(spec)).toContain(message);
  });

  it.each(criticalRows)(
    "requires a %s impact for critical path %s",
    (category, path) => {
      const spec = executionSpec("BH-001");
      spec.file_contract[0]!.path = path;
      spec.change_units[0]!.path = path;
      spec.completion_contract.expected_changed_files[0] = path;

      expect(testingFunnelErrors(spec)).toContain(
        `${spec.change_units[0]!.id} critical path ${path} requires exactly one ${category} impact`,
      );
    },
  );

  it("does not let a runtime impact satisfy the ledger critical-path category", () => {
    const spec = executionSpec("BH-001");
    spec.file_contract[0]!.path = "src/core/ledger.ts";
    spec.change_units[0]!.path = "src/core/ledger.ts";
    spec.completion_contract.expected_changed_files[0] = "src/core/ledger.ts";
    addCrossCuttingCommand(spec);
    spec.cross_cutting_impacts = [impact(spec, { category: "runtime" })];

    expect(testingFunnelErrors(spec)).toContain(
      "BH-001-CH-01 critical path src/core/ledger.ts requires exactly one ledger impact",
    );
  });

  it("returns every funnel defect in deterministic order and formats the complete message", () => {
    const spec = executionSpec("BH-001");
    spec.verification_commands[0]!.tier = "cross_cutting";
    spec.acceptance[0]!.satisfied_by = [spec.change_units[0]!.id];
    spec.cross_cutting_impacts = [impact(spec, {
      change_unit_id: "CH-404",
      callers: [],
      representative_fixtures: [],
      verification_command_ids: ["VERIFY-404"],
    })];
    const expected = [
      "BH-001 has no focused verification command",
      "CH-404 impact references an unknown change unit",
      "CH-404 shared_helper impact requires at least one caller",
      "CH-404 cross-cutting impact requires at least one representative fixture",
      "CH-404 impact references unknown command VERIFY-404",
      "BH-001-VERIFY-01 cross-cutting command is not owned by an impact record",
      "BH-001-AC-01 has no reachable verification command",
    ];

    expect(testingFunnelErrors(spec)).toEqual(expected);
    expect(() => assertTestingFunnelReady(spec)).toThrow(
      `Execution spec BH-001 has an invalid testing funnel:\n- ${expected.join("\n- ")}`,
    );
  });

  it.each(criticalRows)(
    "accepts the exact %s impact for critical path %s",
    (category, path) => {
      const spec = executionSpec("BH-001");
      spec.file_contract[0]!.path = path;
      spec.change_units[0]!.path = path;
      spec.completion_contract.expected_changed_files[0] = path;
      addCrossCuttingCommand(spec);
      spec.cross_cutting_impacts = [impact(spec, { category })];

      expect(testingFunnelErrors(spec)).toEqual([]);
      expect(() => assertTestingFunnelReady(spec)).not.toThrow();
    },
  );
});
