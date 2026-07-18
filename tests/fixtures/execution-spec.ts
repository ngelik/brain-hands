import type { ExecutionSpecV2 } from "../../src/core/types.js";

export function executionSpec(id = "item-1", dependencies: string[] = []): ExecutionSpecV2 {
  const sourcePath = `src/${id}.ts`;
  const testPath = `tests/${id}.test.ts`;
  return {
    schema_version: "2.0",
    id,
    title: `Implement ${id}`,
    objective: `Deliver ${id} without widening scope.`,
    dependencies,
    file_contract: [
      { path: sourcePath, permission: "modify", targets: [`${id} implementation`] },
      { path: testPath, permission: "modify", targets: [`${id} regression tests`] },
    ],
    forbidden_changes: [],
    change_units: [
      {
        id: `${id}-CH-01`,
        path: sourcePath,
        target: `${id} implementation`,
        operation: "modify",
        requirements: [`Implement the specified ${id} behavior.`],
      },
      {
        id: `${id}-CH-02`,
        path: testPath,
        target: `${id} regression tests`,
        operation: "modify",
        requirements: [`Add the ${id}-TEST-01 assertion.`],
      },
    ],
    acceptance: [
      {
        id: `${id}-AC-01`,
        statement: `${id} works`,
        satisfied_by: [`${id}-CH-01`, `${id}-TEST-01`],
      },
    ],
    tests: [
      {
        id: `${id}-TEST-01`,
        path: testPath,
        assertion: `${id} behavior matches the approved objective.`,
        verification_command_ids: [`${id}-VERIFY-01`],
      },
    ],
    verification_commands: [
      {
        id: `${id}-VERIFY-01`,
        argv: ["node", "node_modules/vitest/vitest.mjs", "run", testPath],
        expected_exit_code: 0,
        tier: "focused",
      },
    ],
    cross_cutting_impacts: [],
    expected_artifacts: [],
    browser_checks: [],
    risks: [],
    completion_contract: {
      expected_changed_files: [sourcePath, testPath],
      allow_additional_files: false,
      required_acceptance_ids: [`${id}-AC-01`],
    },
    ambiguity_policy: {
      default: "stop_and_report",
      stop_when: ["A required change needs a path outside file_contract."],
    },
  };
}
