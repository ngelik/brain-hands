import { parsePersistedPlan } from "../core/execution-spec.js";
import type {
  AcceptanceCriterion,
  BrainPlan,
  ReplanPatch,
  WorkflowProtocol,
} from "../core/types.js";

export interface MaterializeReplanCandidateInput {
  basePlan: BrainPlan;
  targetWorkItemId: string;
  patch: ReplanPatch;
  durableCriteria: AcceptanceCriterion[];
  workflowProtocol: WorkflowProtocol;
}

/** Apply an already-validated immutable patch without reading or writing workflow state. */
export function materializeReplanCandidate({
  basePlan,
  targetWorkItemId,
  patch,
  durableCriteria,
  workflowProtocol,
}: MaterializeReplanCandidateInput): BrainPlan {
  const targetIndex = basePlan.work_items.findIndex((item) => item.id === targetWorkItemId);
  if (targetIndex < 0) throw new Error("Replan approval target is absent from the approved base plan");
  const criterionChanges = new Map(patch.added_or_changed_criteria.map(({ ref, text }) => [ref, text]));
  const target = basePlan.work_items[targetIndex]!;
  const criterionTextByIndex = durableCriteria.map((criterion) => criterionChanges.get(criterion.ref) ?? criterion.text);
  const addedPaths = [...new Set(patch.added_change_units.map((unit) => unit.path))];
  const addedReadOnlyPaths = patch.added_read_only_file_contracts.map((contract) => contract.path);
  const authorizedPaths = [...new Set([...addedPaths, ...addedReadOnlyPaths])];
  const fileContract = target.file_contract.map((contract) => {
    const addedTargets = patch.added_change_units
      .filter((unit) => unit.path === contract.path)
      .map((unit) => unit.target);
    return addedTargets.length > 0 ? { ...contract, targets: [...contract.targets, ...addedTargets] } : contract;
  });
  for (const path of addedPaths) {
    if (fileContract.some((contract) => contract.path === path)) continue;
    const units = patch.added_change_units.filter((unit) => unit.path === path);
    fileContract.push({
      path,
      permission: units[0]!.operation,
      targets: units.map((unit) => unit.target),
    });
  }
  fileContract.push(...patch.added_read_only_file_contracts.map((contract) => ({
    ...contract,
    permission: "read_only" as const,
  })));
  const nextTarget = {
    ...target,
    objective: patch.revised_objective ?? target.objective,
    file_contract: fileContract,
    forbidden_changes: target.forbidden_changes.map((forbidden) => forbidden.path === "*"
      ? { ...forbidden, except: [...forbidden.except, ...authorizedPaths.filter((path) => !forbidden.except.includes(path))] }
      : forbidden),
    acceptance: target.acceptance.map((criterion, index) => {
      const addedEvidence = [
        ...patch.added_change_units
          .filter((unit) => unit.satisfies.includes(criterion.id))
          .map((unit) => unit.id),
        ...patch.added_verification_commands
          .filter((command) => command.satisfies.includes(criterion.id))
          .map((command) => command.id),
      ];
      return {
        ...criterion,
        statement: criterionTextByIndex[index] ?? criterion.statement,
        satisfied_by: [...criterion.satisfied_by, ...addedEvidence],
      };
    }),
    change_units: [...(patch.changed_instructions.length > 0
      ? target.change_units.map((unit, index) => index === 0
        ? { ...unit, requirements: patch.changed_instructions }
        : unit)
      : target.change_units), ...patch.added_change_units.map(({ satisfies: _satisfies, ...unit }) => unit)],
    cross_cutting_impacts: [
      ...(target.cross_cutting_impacts ?? []),
      ...patch.added_cross_cutting_impacts,
    ],
    verification_commands: [
      ...target.verification_commands,
      ...patch.added_verification_commands.map(({ satisfies: _satisfies, ...command }) => command),
    ],
    completion_contract: {
      ...target.completion_contract,
      expected_changed_files: [
        ...target.completion_contract.expected_changed_files,
        ...addedPaths.filter((path) => !target.completion_contract.expected_changed_files.includes(path)),
      ],
    },
  };
  return parsePersistedPlan({
    ...basePlan,
    work_items: basePlan.work_items.map((item, index) =>
      index === targetIndex ? nextTarget : item),
  }, workflowProtocol);
}
