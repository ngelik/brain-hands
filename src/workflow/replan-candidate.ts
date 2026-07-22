import { parsePersistedPlan } from "../core/execution-spec.js";
import type {
  AcceptanceCriterion,
  BrainPlan,
  ReplanPatch,
  WorkItem,
  WorkflowProtocol,
} from "../core/types.js";

export interface MaterializeReplanCandidateInput {
  basePlan: BrainPlan;
  targetWorkItemId: string;
  patch: ReplanPatch;
  durableCriteria: AcceptanceCriterion[];
  workflowProtocol: WorkflowProtocol;
  materializationVersion?: 1 | 2;
}

/** Apply an already-validated immutable patch without reading or writing workflow state. */
export function materializeReplanCandidate({
  basePlan,
  targetWorkItemId,
  patch,
  durableCriteria,
  workflowProtocol,
  materializationVersion = 1,
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
    const matchingUnits = patch.added_change_units.filter((unit) => unit.path === contract.path);
    const addedTargets = matchingUnits
      .map((unit) => unit.target);
    const promotesReadOnly = materializationVersion === 2
      && contract.permission === "read_only"
      && matchingUnits.length > 0
      && matchingUnits.every((unit) => unit.operation === "modify");
    return addedTargets.length > 0 ? {
      ...contract,
      permission: promotesReadOnly ? "modify" as const : contract.permission,
      targets: promotesReadOnly ? addedTargets : [...contract.targets, ...addedTargets],
    } : contract;
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
    objective: materializationVersion === 2
      ? [patch.revised_objective ?? target.objective, ...patch.changed_instructions].join("\n")
      : patch.revised_objective ?? target.objective,
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
    change_units: [
      ...(materializationVersion === 2 || patch.changed_instructions.length === 0
        ? target.change_units
        : target.change_units.map((unit, index) => index === 0
          ? { ...unit, requirements: patch.changed_instructions }
          : unit)),
      ...patch.added_change_units.map(({ satisfies: _satisfies, ...unit }) => unit),
    ],
    cross_cutting_impacts: materializationVersion === 2
      ? mergeCrossCuttingImpacts(target.cross_cutting_impacts ?? [], patch.added_cross_cutting_impacts)
      : [
          ...(target.cross_cutting_impacts ?? []),
          ...patch.added_cross_cutting_impacts,
        ],
    verification_commands: [
      ...target.verification_commands,
      ...patch.added_verification_commands.map(({ satisfies: _satisfies, ...command }) => command),
    ],
    expected_artifacts: [
      ...target.expected_artifacts,
      ...patch.added_expected_artifacts.filter((path) => !target.expected_artifacts.includes(path)),
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

function mergeCrossCuttingImpacts(
  existing: WorkItem["cross_cutting_impacts"],
  added: ReplanPatch["added_cross_cutting_impacts"],
): NonNullable<WorkItem["cross_cutting_impacts"]> {
  const replacements = new Map(added.map((impact) => [
    `${impact.change_unit_id}\0${impact.category}`,
    impact,
  ]));
  const merged = (existing ?? []).map((impact) => {
    const key = `${impact.change_unit_id}\0${impact.category}`;
    const replacement = replacements.get(key);
    if (replacement) replacements.delete(key);
    return replacement ?? impact;
  });
  return [...merged, ...replacements.values()];
}
