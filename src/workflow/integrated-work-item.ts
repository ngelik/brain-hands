import type { BrainPlan, WorkItem } from "../core/types.js";

/** Derive the only canonical synthetic work item from an approved plan. */
export function integratedWorkItem(
  plan: BrainPlan,
  options: { includeCompletedDependencies?: boolean } = {},
): WorkItem {
  const fileContract = [...new Map(
    plan.work_items.flatMap((item) => item.file_contract).map((entry) => [entry.path, entry]),
  ).values()];
  const verificationCommands = plan.work_items.flatMap((item) => item.verification_commands.map((command) => ({
    ...command,
    id: `${item.id}:${command.id}`,
  })));
  const forbiddenChanges = [...plan.work_items
    .flatMap((item) => item.forbidden_changes)
    .reduce((byPath, change) => {
      const current = byPath.get(change.path);
      if (current === undefined) {
        byPath.set(change.path, { ...change, except: [...change.except] });
        return byPath;
      }
      current.except = [...new Set([...current.except, ...change.except])];
      if (current.reason !== change.reason) current.reason = `${current.reason} ${change.reason}`;
      return byPath;
    }, new Map<string, WorkItem["forbidden_changes"][number]>())
    .values()];
  verificationCommands.push(...plan.integration_verification.map((argv, index) => ({
    id: `integrated:VERIFY-${index + 1}`,
    argv,
    expected_exit_code: 0 as const,
  })));
  return {
    schema_version: "2.0",
    id: "integrated",
    title: "Integrated local delivery audit",
    objective: plan.summary,
    dependencies: options.includeCompletedDependencies
      ? plan.work_items.map((item) => item.id)
      : [],
    file_contract: fileContract,
    forbidden_changes: forbiddenChanges,
    change_units: plan.work_items.flatMap((item) => item.change_units.map((unit) => ({
      ...unit,
      id: `${item.id}:${unit.id}`,
    }))),
    acceptance: plan.work_items.flatMap((item) => item.acceptance.map((criterion) => ({
      ...criterion,
      id: `${item.id}:${criterion.id}`,
      satisfied_by: criterion.satisfied_by.map((reference) => `${item.id}:${reference}`),
    }))),
    tests: plan.work_items.flatMap((item) => item.tests.map((test) => ({
      ...test,
      id: `${item.id}:${test.id}`,
      verification_command_ids: test.verification_command_ids.map((id) => `${item.id}:${id}`),
    }))),
    verification_commands: verificationCommands,
    browser_checks: plan.work_items.flatMap((item) => item.browser_checks),
    expected_artifacts: [...new Set(plan.work_items.flatMap((item) => item.expected_artifacts))],
    risks: plan.work_items.flatMap((item) => item.risks),
    completion_contract: {
      expected_changed_files: fileContract
        .filter((entry) => entry.permission !== "read_only")
        .map((entry) => entry.path),
      allow_additional_files: plan.work_items.some((item) => item.completion_contract.allow_additional_files),
      required_acceptance_ids: plan.work_items.flatMap((item) => item.acceptance.map((criterion) => `${item.id}:${criterion.id}`)),
    },
    ambiguity_policy: {
      default: "stop_and_report",
      stop_when: [...new Set(plan.work_items.flatMap((item) => item.ambiguity_policy.stop_when))],
    },
  };
}
