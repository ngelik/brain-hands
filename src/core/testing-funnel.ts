import type {
  CrossCuttingCategory,
  ExecutionSpecV2,
  ExecutionVerificationCommand,
  VerificationTier,
} from "./types.js";

export function effectiveVerificationTier(
  command: ExecutionVerificationCommand,
): VerificationTier {
  return command.tier ?? "focused";
}

export const criticalVerificationSurfaces: Readonly<Record<
  CrossCuttingCategory,
  ReadonlySet<string>
>> = {
  shared_helper: new Set([
    "src/adapters/git.ts",
    "src/adapters/github.ts",
    "src/core/command.ts",
    "src/core/config.ts",
    "src/core/execution-spec.ts",
    "src/core/executor.ts",
    "src/core/output-schemas.ts",
    "src/core/schema.ts",
    "src/core/secret-detector.ts",
    "src/workflow/authorization.ts",
  ]),
  runtime: new Set([
    "src/workflow/runtime.ts",
    "src/workflow/orchestrator.ts",
    "src/workflow/worker.ts",
    "src/workflow/implementer.ts",
  ]),
  cli_lifecycle: new Set([
    "src/cli.ts",
    "src/workflow/preflight.ts",
    "src/workflow/status.ts",
    "src/core/run-state.ts",
    "src/core/run-configuration.ts",
    "src/core/controller-provenance.ts",
  ]),
  ledger: new Set([
    "src/core/ledger.ts",
    "src/core/discovery-ledger.ts",
  ]),
  artifact_paths: new Set([
    "src/verification/runner.ts",
    "src/verification/evidence.ts",
    "src/workflow/owned-evidence.ts",
    "src/core/owned-evidence.ts",
  ]),
};

function duplicates(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicateValues = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicateValues.add(value);
    seen.add(value);
  }
  return [...duplicateValues];
}

export function testingFunnelErrors(spec: ExecutionSpecV2): string[] {
  const errors: string[] = [];
  const impacts = spec.cross_cutting_impacts ?? [];
  const commands = new Map(spec.verification_commands.map((command) => [command.id, command]));
  const tests = new Map(spec.tests.map((test) => [test.id, test]));
  const changeUnits = new Set(spec.change_units.map((unit) => unit.id));
  const fileContracts = new Set(spec.file_contract.map((entry) => entry.path));
  const impactOwnedCommands = new Set<string>();
  const commandConsumers = new Set<string>();

  let sawCrossCutting = false;
  let focusedCount = 0;
  for (const command of spec.verification_commands) {
    const tier = effectiveVerificationTier(command);
    if (tier === "cross_cutting") sawCrossCutting = true;
    if (tier === "focused") {
      focusedCount += 1;
      if (sawCrossCutting) {
        errors.push(`${command.id} focused command appears after cross-cutting verification`);
      }
    }
  }
  if (focusedCount === 0) errors.push(`${spec.id} has no focused verification command`);

  const impactKeys = new Set<string>();
  const duplicateImpactKeys = new Set<string>();
  for (const impact of impacts) {
    const impactKey = `${impact.change_unit_id}\u0000${impact.category}`;
    if (impactKeys.has(impactKey) && !duplicateImpactKeys.has(impactKey)) {
      errors.push(`${impact.change_unit_id} has duplicate ${impact.category} impact records`);
      duplicateImpactKeys.add(impactKey);
    }
    impactKeys.add(impactKey);

    for (const caller of duplicates(impact.callers)) {
      errors.push(`${impact.change_unit_id} ${impact.category} impact has duplicate caller ${caller}`);
    }
    for (const fixture of duplicates(impact.representative_fixtures)) {
      errors.push(
        `${impact.change_unit_id} ${impact.category} impact has duplicate representative fixture ${fixture}`,
      );
    }
    for (const commandId of duplicates(impact.verification_command_ids)) {
      errors.push(
        `${impact.change_unit_id} ${impact.category} impact has duplicate verification command ${commandId}`,
      );
    }

    if (!changeUnits.has(impact.change_unit_id)) {
      errors.push(`${impact.change_unit_id} impact references an unknown change unit`);
    }
    if (impact.category === "shared_helper" && impact.callers.length === 0) {
      errors.push(`${impact.change_unit_id} shared_helper impact requires at least one caller`);
    }
    if (impact.representative_fixtures.length === 0) {
      errors.push(
        `${impact.change_unit_id} cross-cutting impact requires at least one representative fixture`,
      );
    }
    for (const path of [...impact.callers, ...impact.representative_fixtures]) {
      if (!fileContracts.has(path)) {
        errors.push(`${impact.change_unit_id} impact path ${path} is not in file_contract`);
      }
    }
    for (const commandId of impact.verification_command_ids) {
      impactOwnedCommands.add(commandId);
      commandConsumers.add(commandId);
      const command = commands.get(commandId);
      if (!command) {
        errors.push(`${impact.change_unit_id} impact references unknown command ${commandId}`);
      } else if (effectiveVerificationTier(command) !== "cross_cutting") {
        errors.push(`${impact.change_unit_id} impact command ${commandId} is not cross_cutting`);
      }
    }
  }

  for (const command of spec.verification_commands) {
    if (
      effectiveVerificationTier(command) === "cross_cutting"
      && !impactOwnedCommands.has(command.id)
    ) {
      errors.push(`${command.id} cross-cutting command is not owned by an impact record`);
    }
  }

  for (const criterion of spec.acceptance) {
    const reachable = new Set<string>();
    for (const reference of criterion.satisfied_by) {
      if (commands.has(reference)) {
        reachable.add(reference);
        commandConsumers.add(reference);
      }
      const test = tests.get(reference);
      if (test) {
        for (const commandId of test.verification_command_ids) {
          if (commands.has(commandId)) {
            reachable.add(commandId);
            commandConsumers.add(commandId);
          }
        }
      }
    }
    if (reachable.size === 0) {
      errors.push(`${criterion.id} has no reachable verification command`);
    }
  }

  for (const test of spec.tests) {
    for (const commandId of test.verification_command_ids) commandConsumers.add(commandId);
  }
  for (const command of spec.verification_commands) {
    if (!commandConsumers.has(command.id)) {
      errors.push(`${command.id} verification command is orphaned`);
    }
  }

  for (const unit of spec.change_units) {
    for (const [category, paths] of Object.entries(criticalVerificationSurfaces) as [
      CrossCuttingCategory,
      ReadonlySet<string>,
    ][]) {
      if (!paths.has(unit.path)) continue;
      const matchingImpacts = impacts.filter(
        (impact) => impact.change_unit_id === unit.id && impact.category === category,
      );
      if (matchingImpacts.length !== 1) {
        errors.push(
          `${unit.id} critical path ${unit.path} requires exactly one ${category} impact`,
        );
      }
    }
  }

  return errors;
}

export function assertTestingFunnelReady(spec: ExecutionSpecV2): void {
  const errors = testingFunnelErrors(spec);
  if (errors.length > 0) {
    throw new Error(
      `Execution spec ${spec.id} has an invalid testing funnel:\n- ${errors.join("\n- ")}`,
    );
  }
}
