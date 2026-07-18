import { canonicalApprovalJson } from "./plan-approval.js";
import type {
  BrainPlan,
  DiscoveredBrainPlan,
  PlanApprovalDeltaV1,
  PlanDeltaCategory,
  PlanDeltaEntryV1,
  WorkItem,
} from "./types.js";
export {
  planDecisionContract,
  planDecisionContractSha256,
} from "./plan-approval.js";

function isDiscoveredPlan(plan: BrainPlan): plan is DiscoveredBrainPlan {
  return "discovery_brief_revision" in plan;
}

function pointerSegment(value: string): string {
  return value;
}

function equal(left: unknown, right: unknown): boolean {
  return canonicalApprovalJson(left) === canonicalApprovalJson(right);
}

function operation(before: unknown, after: unknown): PlanDeltaEntryV1["operation"] {
  if (before === undefined) return "add";
  if (after === undefined) return "remove";
  return "replace";
}

function addEntry(
  entries: PlanDeltaEntryV1[],
  category: PlanDeltaCategory,
  pointer: string,
  before: unknown,
  after: unknown,
): void {
  if (before !== undefined && after !== undefined && equal(before, after)) return;
  if (before === undefined && after === undefined) return;
  entries.push({
    category,
    pointer,
    operation: operation(before, after),
    before: before ?? null,
    after: after ?? null,
  });
}

function keyed<T>(values: readonly T[] | undefined, key: (value: T) => string): Map<string, T> {
  return new Map((values ?? []).map((value) => [key(value), value]));
}

function compareKeyed<T>(input: {
  entries: PlanDeltaEntryV1[];
  before: readonly T[] | undefined;
  after: readonly T[] | undefined;
  key: (value: T) => string;
  pointer: string;
  category: PlanDeltaCategory | ((before: T | undefined, after: T | undefined) => PlanDeltaCategory);
}): void {
  const before = keyed(input.before, input.key);
  const after = keyed(input.after, input.key);
  const keys = [...new Set([...before.keys(), ...after.keys()])].sort();
  for (const key of keys) {
    const oldValue = before.get(key);
    const newValue = after.get(key);
    const category = typeof input.category === "function"
      ? input.category(oldValue, newValue)
      : input.category;
    addEntry(
      input.entries,
      category,
      `${input.pointer}/${pointerSegment(key)}`,
      oldValue,
      newValue,
    );
  }
}

function isDestructive(value: unknown): boolean {
  return Boolean(value && typeof value === "object"
    && (("permission" in value && value.permission === "delete")
      || ("operation" in value && value.operation === "delete")));
}

function compareWorkItem(
  entries: PlanDeltaEntryV1[],
  before: WorkItem | undefined,
  after: WorkItem | undefined,
): void {
  const item = after ?? before;
  if (!item) return;
  const root = `/work_items/${pointerSegment(item.id)}`;
  addEntry(entries, "objective", `${root}/title`, before?.title, after?.title);
  addEntry(entries, "objective", `${root}/objective`, before?.objective, after?.objective);
  addEntry(entries, "scope", `${root}/schema_version`, before?.schema_version, after?.schema_version);
  addEntry(entries, "scope", `${root}/dependencies`, before?.dependencies, after?.dependencies);
  compareKeyed({
    entries,
    before: before?.file_contract,
    after: after?.file_contract,
    key: (value) => value.path,
    pointer: `${root}/file_contract`,
    category: (oldValue, newValue) => isDestructive(oldValue) || isDestructive(newValue)
      ? "destructive_actions"
      : "files",
  });
  compareKeyed({
    entries,
    before: before?.forbidden_changes,
    after: after?.forbidden_changes,
    key: (value) => value.path,
    pointer: `${root}/forbidden_changes`,
    category: "scope",
  });
  compareKeyed({
    entries,
    before: before?.change_units,
    after: after?.change_units,
    key: (value) => value.id,
    pointer: `${root}/change_units`,
    category: (oldValue, newValue) => isDestructive(oldValue) || isDestructive(newValue)
      ? "destructive_actions"
      : "files",
  });
  compareKeyed({
    entries,
    before: before?.acceptance,
    after: after?.acceptance,
    key: (value) => value.id,
    pointer: `${root}/acceptance`,
    category: "acceptance",
  });
  compareKeyed({
    entries,
    before: before?.tests,
    after: after?.tests,
    key: (value) => value.id,
    pointer: `${root}/tests`,
    category: "verification",
  });
  compareKeyed({
    entries,
    before: before?.verification_commands,
    after: after?.verification_commands,
    key: (value) => value.id,
    pointer: `${root}/verification_commands`,
    category: "verification",
  });
  compareKeyed({
    entries,
    before: before?.browser_checks,
    after: after?.browser_checks,
    key: (value) => value.name,
    pointer: `${root}/browser_checks`,
    category: "verification",
  });
  addEntry(entries, "verification", `${root}/expected_artifacts`, before?.expected_artifacts, after?.expected_artifacts);
  addEntry(entries, "risks", `${root}/risks`, before?.risks, after?.risks);
  addEntry(
    entries,
    "files",
    `${root}/completion_contract/expected_changed_files`,
    before?.completion_contract.expected_changed_files,
    after?.completion_contract.expected_changed_files,
  );
  addEntry(
    entries,
    "scope",
    `${root}/completion_contract/allow_additional_files`,
    before?.completion_contract.allow_additional_files,
    after?.completion_contract.allow_additional_files,
  );
  addEntry(
    entries,
    "acceptance",
    `${root}/completion_contract/required_acceptance_ids`,
    before?.completion_contract.required_acceptance_ids,
    after?.completion_contract.required_acceptance_ids,
  );
  addEntry(entries, "scope", `${root}/ambiguity_policy`, before?.ambiguity_policy, after?.ambiguity_policy);
}

function compareWorkItems(
  entries: PlanDeltaEntryV1[],
  before: readonly WorkItem[] | undefined,
  after: readonly WorkItem[],
): void {
  const oldItems = keyed(before, (item) => item.id);
  const newItems = keyed(after, (item) => item.id);
  const ids = [...new Set([...oldItems.keys(), ...newItems.keys()])].sort();
  for (const id of ids) {
    const oldItem = oldItems.get(id);
    const newItem = newItems.get(id);
    compareWorkItem(entries, oldItem, newItem);
  }
}

export function buildPlanDelta(
  base: BrainPlan | null,
  proposed: BrainPlan,
  revisions: { baseRevision: number | null; proposedRevision: number } = {
    baseRevision: base === null ? null : 1,
    proposedRevision: base === null ? 1 : 2,
  },
): PlanApprovalDeltaV1 {
  const entries: PlanDeltaEntryV1[] = [];
  addEntry(entries, "scope", "/feature_slug", base?.feature_slug ?? (base ? null : undefined), proposed.feature_slug ?? null);
  addEntry(entries, "external_effects", "/parent_issue", base?.parent_issue ?? (base ? null : undefined), proposed.parent_issue ?? null);
  addEntry(entries, "scope", "/assumptions", base?.assumptions, proposed.assumptions);
  addEntry(entries, "scope", "/architecture", base?.architecture, proposed.architecture);
  addEntry(entries, "risks", "/risks", base?.risks, proposed.risks);
  addEntry(
    entries,
    "external_effects",
    "/controller_bootstrap",
    base ? base.controller_bootstrap ?? null : undefined,
    proposed.controller_bootstrap ?? null,
  );
  compareWorkItems(entries, base?.work_items, proposed.work_items);
  addEntry(entries, "verification", "/integration_verification", base?.integration_verification, proposed.integration_verification);

  const baseDiscovery = base && isDiscoveredPlan(base) ? base : null;
  const proposedDiscovery = isDiscoveredPlan(proposed) ? proposed : null;
  addEntry(entries, "scope", "/discovery/discovery_brief_revision", baseDiscovery?.discovery_brief_revision, proposedDiscovery?.discovery_brief_revision);
  addEntry(entries, "scope", "/discovery/discovery_brief_sha256", baseDiscovery?.discovery_brief_sha256, proposedDiscovery?.discovery_brief_sha256);
  addEntry(entries, "acceptance", "/discovery/discovery_decision_coverage", baseDiscovery?.discovery_decision_coverage, proposedDiscovery?.discovery_decision_coverage);
  addEntry(entries, "risks", "/discovery/accepted_risks", baseDiscovery?.accepted_risks, proposedDiscovery?.accepted_risks);
  addEntry(entries, "scope", "/discovery/out_of_scope", baseDiscovery?.out_of_scope, proposedDiscovery?.out_of_scope);

  entries.sort((left, right) => left.category.localeCompare(right.category)
    || left.pointer.localeCompare(right.pointer)
    || left.operation.localeCompare(right.operation));
  const changed = new Set(entries.map((entry) => entry.category));
  const highImpact: PlanDeltaCategory[] = ["risks", "external_effects", "destructive_actions"];
  return {
    schema_version: 1,
    base_revision: revisions.baseRevision,
    proposed_revision: revisions.proposedRevision,
    entries,
    unchanged_high_impact_categories: highImpact.filter((category) => !changed.has(category)),
  };
}
