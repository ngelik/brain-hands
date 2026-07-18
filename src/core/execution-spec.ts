import { posix } from "node:path";
import { z } from "zod";
import { assertApprovedCommand, assertLocalVerificationCommand, splitCommand } from "./command.js";
import { brainPlanSchema, discoveredBrainPlanSchema } from "./schema.js";
import { testingFunnelErrors } from "./testing-funnel.js";
import type {
  BrainPlan,
  DiscoveryBrief,
  DiscoveredBrainPlan,
  ExecutionSpecV2,
  RunMode,
  WorkflowProtocol,
} from "./types.js";
import { usesDurableDiscoveryProtocol } from "./run-state.js";

const VAGUE_REQUIREMENT = /\b(as needed|where appropriate|if necessary|properly|related changes?|and so on|etc\.)\b/i;
const PATH_GLOB = /[*?\[\]]/;
const WINDOWS_ABSOLUTE_PATH = /^[a-zA-Z]:[\\/]/;
const CONTROL_CHARACTER = /\p{Cc}/u;
const SAFE_ARTIFACT_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const RESERVED_WORK_ITEM_IDS = new Set(["integrated"]);

export interface PlanReadinessContext {
  mode: RunMode;
  repoRoot: string;
}

function duplicates(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicateValues = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicateValues.add(value);
    seen.add(value);
  }
  return [...duplicateValues];
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry) => right.includes(entry));
}

function repositoryPathError(label: string, path: string): string | null {
  if (path === ".git" || path.startsWith(".git/")) {
    return `${label} path ${path} targets reserved Git metadata`;
  }
  const invalid =
    path === "." ||
    path.includes("\\") ||
    PATH_GLOB.test(path) ||
    CONTROL_CHARACTER.test(path) ||
    WINDOWS_ABSOLUTE_PATH.test(path) ||
    posix.isAbsolute(path) ||
    path === ".." ||
    path.startsWith("../") ||
    posix.normalize(path) !== path;
  return invalid ? `${label} path ${path} must be repository-relative and normalized` : null;
}

/** Reject execution contracts that require Hands to infer scope, evidence, or intent. */
function readinessErrors(spec: ExecutionSpecV2, includeTestingFunnel: boolean): string[] {
  const errors: string[] = [];
  if (!SAFE_ARTIFACT_ID.test(spec.id)) {
    errors.push(`work item id ${spec.id} must use safe artifact characters [a-zA-Z0-9._-]`);
  }
  if (RESERVED_WORK_ITEM_IDS.has(spec.id.toLowerCase())) {
    errors.push(`work item id ${spec.id} is reserved`);
  }
  for (const dependency of duplicates(spec.dependencies)) {
    errors.push(`duplicate dependency ${dependency}`);
  }
  const ids = [
    ...spec.change_units.map((unit) => unit.id),
    ...spec.acceptance.map((criterion) => criterion.id),
    ...spec.tests.map((test) => test.id),
    ...spec.verification_commands.map((command) => command.id),
  ];
  for (const id of duplicates(ids)) errors.push(`duplicate id ${id}`);

  const knownEvidence = new Set([
    ...spec.change_units.map((unit) => unit.id),
    ...spec.tests.map((test) => test.id),
    ...spec.verification_commands.map((command) => command.id),
  ]);
  const executableEvidence = new Set([
    ...spec.tests.map((test) => test.id),
    ...spec.verification_commands.map((command) => command.id),
  ]);
  for (const criterion of spec.acceptance) {
    for (const reference of duplicates(criterion.satisfied_by)) {
      errors.push(`${criterion.id} contains duplicate evidence reference ${reference}`);
    }
    for (const reference of criterion.satisfied_by) {
      if (!knownEvidence.has(reference)) {
        errors.push(`${criterion.id} references unknown evidence ${reference}`);
      }
    }
    if (!criterion.satisfied_by.some((reference) => executableEvidence.has(reference))) {
      errors.push(`${criterion.id} has no test or verification evidence`);
    }
  }

  const fileContracts = new Map(spec.file_contract.map((entry) => [entry.path, entry]));
  for (const duplicatePath of duplicates(spec.file_contract.map((entry) => entry.path))) {
    errors.push(`duplicate file_contract path ${duplicatePath}`);
  }
  const pathsByCase = new Map<string, string>();
  for (const entry of spec.file_contract) {
    const key = entry.path.toLowerCase();
    const existing = pathsByCase.get(key);
    if (existing && existing !== entry.path) {
      errors.push(`file_contract paths collide case-insensitively: ${existing}, ${entry.path}`);
    }
    pathsByCase.set(key, entry.path);
  }
  for (const entry of spec.file_contract) {
    const error = repositoryPathError("file_contract", entry.path);
    if (error) errors.push(error);
    for (const target of duplicates(entry.targets)) {
      errors.push(`${entry.path} declares duplicate target ${target}`);
    }
  }
  for (const unit of spec.change_units) {
    const pathError = repositoryPathError(`${unit.id}`, unit.path);
    if (pathError) errors.push(pathError);
    const contract = fileContracts.get(unit.path);
    if (!contract) {
      errors.push(`${unit.id} path ${unit.path} is not in file_contract`);
    } else if (contract.permission !== unit.operation) {
      errors.push(`${unit.id} operation ${unit.operation} conflicts with ${unit.path} permission ${contract.permission}`);
    }
    if (contract && !contract.targets.includes(unit.target)) {
      errors.push(`${unit.id} target ${unit.target} is not declared for ${unit.path}`);
    }
    for (const requirement of unit.requirements) {
      const vague = requirement.match(VAGUE_REQUIREMENT)?.[0];
      if (vague) errors.push(`${unit.id} contains vague requirement "${requirement}" (${vague})`);
    }
  }
  for (const entry of spec.file_contract) {
    if (entry.permission !== "read_only" && !spec.change_units.some((unit) => unit.path === entry.path)) {
      errors.push(`${entry.path} has no change unit`);
    }
    if (entry.permission !== "read_only") {
      for (const target of entry.targets) {
        const units = spec.change_units.filter((unit) => unit.path === entry.path && unit.target === target);
        if (units.length === 0) errors.push(`${entry.path} target ${target} has no change unit`);
        if (units.length > 1) {
          errors.push(`${entry.path} target ${target} maps to multiple change units ${units.map((unit) => unit.id).join(", ")}`);
        }
      }
    }
  }

  for (const test of spec.tests) {
    const pathError = repositoryPathError(`${test.id} test`, test.path);
    if (pathError) errors.push(pathError);
    if (!fileContracts.has(test.path)) errors.push(`${test.id} path ${test.path} is not in file_contract`);
    if (test.verification_command_ids.length === 0) errors.push(`${test.id} has no verification command`);
    for (const commandId of duplicates(test.verification_command_ids)) {
      errors.push(`${test.id} contains duplicate verification command ${commandId}`);
    }
    const commandIds = new Set(spec.verification_commands.map((command) => command.id));
    for (const commandId of test.verification_command_ids) {
      if (!commandIds.has(commandId)) errors.push(`${test.id} references unknown verification command ${commandId}`);
    }
  }

  const changeableFiles = spec.file_contract
    .filter((entry) => entry.permission !== "read_only")
    .map((entry) => entry.path);
  for (const path of spec.completion_contract.expected_changed_files) {
    const error = repositoryPathError("completion_contract", path);
    if (error) errors.push(error);
  }
  for (const path of duplicates(spec.completion_contract.expected_changed_files)) {
    errors.push(`completion_contract contains duplicate file ${path}`);
  }
  if (spec.completion_contract.allow_additional_files) {
    errors.push("completion_contract must not allow additional files");
  }
  if (!sameSet(changeableFiles, spec.completion_contract.expected_changed_files)) {
    for (const path of changeableFiles) {
      if (!spec.completion_contract.expected_changed_files.includes(path)) {
        errors.push(`completion_contract is missing ${path}`);
      }
    }
    for (const path of spec.completion_contract.expected_changed_files) {
      if (!changeableFiles.includes(path)) errors.push(`completion_contract includes unmodifiable file ${path}`);
    }
  }

  const acceptanceIds = spec.acceptance.map((criterion) => criterion.id);
  for (const id of duplicates(spec.completion_contract.required_acceptance_ids)) {
    errors.push(`completion_contract contains duplicate acceptance criterion ${id}`);
  }
  for (const id of spec.completion_contract.required_acceptance_ids) {
    if (!acceptanceIds.includes(id)) errors.push(`completion_contract references unknown acceptance criterion ${id}`);
  }
  for (const id of acceptanceIds) {
    if (!spec.completion_contract.required_acceptance_ids.includes(id)) {
      errors.push(`completion_contract does not require ${id}`);
    }
  }

  for (const forbidden of spec.forbidden_changes) {
    if (forbidden.path !== "*") {
      const error = repositoryPathError("forbidden_changes", forbidden.path);
      if (error) errors.push(error);
    }
    for (const path of forbidden.except) {
      const error = repositoryPathError("forbidden_changes exception", path);
      if (error) errors.push(error);
    }
    for (const path of duplicates(forbidden.except)) {
      errors.push(`forbidden_changes ${forbidden.path} contains duplicate exception ${path}`);
    }
    if (forbidden.path === "*") {
      for (const path of fileContracts.keys()) {
        if (!forbidden.except.includes(path)) errors.push(`forbidden wildcard does not except ${path}`);
      }
    }
    if (fileContracts.has(forbidden.path) && !forbidden.except.includes(forbidden.path)) {
      errors.push(`forbidden path ${forbidden.path} conflicts with file_contract`);
    }
    const allowedPath = pathsByCase.get(forbidden.path.toLowerCase());
    if (allowedPath && allowedPath !== forbidden.path) {
      errors.push(`forbidden path ${forbidden.path} conflicts case-insensitively with file_contract path ${allowedPath}`);
    }
  }

  for (const path of spec.expected_artifacts) {
    const error = repositoryPathError("expected_artifact", path);
    if (error) errors.push(error);
  }
  for (const path of duplicates(spec.expected_artifacts)) {
    errors.push(`duplicate expected artifact ${path}`);
  }
  for (const check of spec.browser_checks) {
    const error = repositoryPathError("browser screenshot", check.screenshot_artifact);
    if (error) errors.push(error);
  }
  for (const name of duplicates(spec.browser_checks.map((check) => check.name))) {
    errors.push(`duplicate browser check name ${name}`);
  }
  for (const path of duplicates(spec.browser_checks.map((check) => check.screenshot_artifact))) {
    errors.push(`duplicate browser screenshot artifact ${path}`);
  }

  if (includeTestingFunnel) errors.push(...testingFunnelErrors(spec));
  return errors;
}

export function sparkReadinessErrors(spec: ExecutionSpecV2): string[] {
  return readinessErrors(spec, true);
}

export function assertSparkReady(spec: ExecutionSpecV2): void {
  const errors = sparkReadinessErrors(spec);
  if (errors.length > 0) {
    throw new Error(`Execution spec ${spec.id} is not Spark-ready:\n- ${errors.join("\n- ")}`);
  }
}

function planReadinessErrorsWithFunnelPolicy(
  plan: BrainPlan,
  context?: PlanReadinessContext,
  includeTestingFunnelByItem?: readonly boolean[],
): string[] {
  const errors = plan.work_items.flatMap((item, index) =>
    readinessErrors(item, includeTestingFunnelByItem?.[index] ?? true)
      .map((error) => `${item.id}: ${error}`));
  const byId = new Map<string, ExecutionSpecV2>();
  const artifactKeys = new Map<string, string>();
  for (const item of plan.work_items) {
    if (byId.has(item.id)) errors.push(`duplicate work item id ${item.id}`);
    byId.set(item.id, item);
    const artifactKey = item.id.toLowerCase();
    const existing = artifactKeys.get(artifactKey);
    if (existing && existing !== item.id) errors.push(`work item ids collide as artifact key ${artifactKey}: ${existing}, ${item.id}`);
    artifactKeys.set(artifactKey, item.id);
  }
  for (const item of plan.work_items) {
    for (const dependency of item.dependencies) {
      if (!byId.has(dependency)) errors.push(`${item.id} depends on missing work item ${dependency}`);
    }
  }

  const state = new Map<string, "visiting" | "visited">();
  const visit = (id: string): void => {
    if (state.get(id) === "visited") return;
    if (state.get(id) === "visiting") {
      errors.push(`cyclic dependency involving ${id}`);
      return;
    }
    const item = byId.get(id);
    if (!item) return;
    state.set(id, "visiting");
    for (const dependency of item.dependencies) visit(dependency);
    state.set(id, "visited");
  };
  for (const item of plan.work_items) visit(item.id);

  if (context) {
    const assertCommand = context.mode === "local"
      ? assertLocalVerificationCommand
      : assertApprovedCommand;
    const commands = [
      ...plan.work_items.flatMap((item) => item.verification_commands.map((command) => ({
        label: `${item.id} verification command ${command.id}`,
        argv: command.argv,
      }))),
      ...plan.integration_verification.map((argv, index) => ({
        label: `integration verification command ${index + 1}`,
        argv,
      })),
      ...plan.work_items.flatMap((item) => item.browser_checks.map((check) => {
        try {
          const parsed = splitCommand(check.local_server_command);
          return {
            label: `${item.id} browser check ${check.name} server command`,
            argv: [parsed.executable, ...parsed.args],
          };
        } catch (error) {
          errors.push(`${item.id} browser check ${check.name} server command: ${error instanceof Error ? error.message : String(error)}`);
          return null;
        }
      }).filter((command): command is { label: string; argv: string[] } => command !== null)),
    ];
    for (const command of commands) {
      try {
        assertCommand(command.argv, context.repoRoot);
      } catch (error) {
        errors.push(`${command.label}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  return errors;
}

export function planReadinessErrors(
  plan: BrainPlan,
  context?: PlanReadinessContext,
): string[] {
  return planReadinessErrorsWithFunnelPolicy(plan, context);
}

export const planReadinessDiagnosticCodeSchema = z.enum([
  "plan.schema",
  "plan.graph",
  "plan.evidence",
  "plan.command_policy",
  "plan.file_contract",
  "plan.completion_contract",
  "plan.discovery_binding",
  "plan.issue_naming",
]);

export interface PlanReadinessDiagnostic {
  code: z.infer<typeof planReadinessDiagnosticCodeSchema>;
  path: string;
  message: string;
}

function diagnosticCode(message: string): PlanReadinessDiagnostic["code"] {
  if (/depends on missing|cyclic dependency|duplicate work item|collide as artifact key/i.test(message)) return "plan.graph";
  if (/command|executable|shell|argv|node -e|--eval/i.test(message)) return "plan.command_policy";
  if (/evidence|acceptance criterion|criterion/i.test(message)) return "plan.evidence";
  if (/file_contract|forbidden path|repository path|expected artifact|browser screenshot/i.test(message)) return "plan.file_contract";
  if (/completion|done condition|handoff/i.test(message)) return "plan.completion_contract";
  return "plan.schema";
}

function diagnosticPath(plan: BrainPlan, message: string): string {
  const itemIndex = plan.work_items.findIndex((item) => message.startsWith(`${item.id}:`) || message.startsWith(`${item.id} `));
  if (itemIndex >= 0) {
    if (/command|executable|shell|argv|node -e|--eval/i.test(message)) return `/work_items/${itemIndex}/verification_commands`;
    if (/evidence|acceptance criterion|criterion/i.test(message)) return `/work_items/${itemIndex}/acceptance`;
    if (/file_contract|forbidden path|repository path/i.test(message)) return `/work_items/${itemIndex}/file_contract`;
    if (/depends on missing/i.test(message)) return `/work_items/${itemIndex}/dependencies`;
    return `/work_items/${itemIndex}`;
  }
  if (/integration verification command/i.test(message)) return "/integration_verification";
  if (/duplicate work item|cyclic dependency|artifact key/i.test(message)) return "/work_items";
  return "/";
}

export function planReadinessDiagnostics(
  plan: BrainPlan,
  context?: PlanReadinessContext,
): PlanReadinessDiagnostic[] {
  return planReadinessErrors(plan, context).map((message) => ({
    code: diagnosticCode(message),
    path: diagnosticPath(plan, message),
    message: message.slice(0, 240),
  }));
}

export class PlanReadinessError extends Error {
  readonly diagnostics: PlanReadinessDiagnostic[];

  constructor(diagnostics: PlanReadinessDiagnostic[]) {
    super(`Brain plan is not execution-ready:\n- ${diagnostics.map((diagnostic) => diagnostic.message).join("\n- ")}`);
    this.name = "PlanReadinessError";
    this.diagnostics = diagnostics;
  }
}

export function assertPlanReady(plan: BrainPlan, context?: PlanReadinessContext): void {
  const diagnostics = planReadinessDiagnostics(plan, context);
  if (diagnostics.length > 0) throw new PlanReadinessError(diagnostics);
}

function isExactPreFunnelPersistedItem(value: unknown): boolean {
  if (typeof value !== "object" || value === null
    || Object.prototype.hasOwnProperty.call(value, "cross_cutting_impacts")) return false;
  const commands = (value as { verification_commands?: unknown }).verification_commands;
  return Array.isArray(commands) && commands.length > 0 && commands.every((command) =>
    typeof command === "object" && command !== null
    && !Object.prototype.hasOwnProperty.call(command, "tier"));
}

function persistedTestingFunnelPolicy(value: unknown): boolean[] | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const workItems = (value as { work_items?: unknown }).work_items;
  if (!Array.isArray(workItems)) return undefined;
  return workItems.map((item) => !isExactPreFunnelPersistedItem(item));
}

/** Ensure every approved discovery decision has one unambiguous execution disposition. */
export function validateDiscoveryCoverage(plan: DiscoveredBrainPlan, brief: DiscoveryBrief): void {
  const errors: string[] = [];
  const expectedDecisionIds = brief.decisions.map((decision) => decision.id);
  const coveredDecisionIds = plan.discovery_decision_coverage.map((coverage) => coverage.decision_id);
  const duplicateDecisionIds = duplicates(coveredDecisionIds);
  if (duplicateDecisionIds.length > 0) {
    errors.push(`duplicate decision coverage rows: ${duplicateDecisionIds.join(", ")}`);
  }
  if (!sameSet(expectedDecisionIds, coveredDecisionIds)) {
    errors.push(
      `decision coverage must exactly match approved decisions; expected ${expectedDecisionIds.join(", ") || "none"}, got ${coveredDecisionIds.join(", ") || "none"}`,
    );
  }

  const workItemIds = new Set(plan.work_items.map((item) => item.id));
  const acceptanceOwners = new Map<string, string>();
  const verificationCommandOwners = new Map<string, string>();
  for (const item of plan.work_items) {
    for (const criterion of item.acceptance) {
      const existingOwner = acceptanceOwners.get(criterion.id);
      if (existingOwner !== undefined) {
        errors.push(`duplicate acceptance criterion ID ${criterion.id} in ${existingOwner} and ${item.id}`);
      } else {
        acceptanceOwners.set(criterion.id, item.id);
      }
    }
    for (const command of item.verification_commands) {
      const existingOwner = verificationCommandOwners.get(command.id);
      if (existingOwner !== undefined) {
        errors.push(`duplicate verification command ID ${command.id} in ${existingOwner} and ${item.id}`);
      } else {
        verificationCommandOwners.set(command.id, item.id);
      }
    }
  }
  for (const coverage of plan.discovery_decision_coverage) {
    for (const duplicate of duplicates(coverage.work_item_ids)) {
      errors.push(`${coverage.decision_id} contains duplicate work item ${duplicate}`);
    }
    for (const duplicate of duplicates(coverage.acceptance_ids)) {
      errors.push(`${coverage.decision_id} contains duplicate acceptance criterion ${duplicate}`);
    }
    for (const duplicate of duplicates(coverage.verification_command_ids)) {
      errors.push(`${coverage.decision_id} contains duplicate verification command ${duplicate}`);
    }
    for (const id of coverage.work_item_ids) {
      if (!workItemIds.has(id)) errors.push(`${coverage.decision_id} references unknown work item ${id}`);
    }
    for (const id of coverage.acceptance_ids) {
      const owner = acceptanceOwners.get(id);
      if (owner === undefined) {
        errors.push(`${coverage.decision_id} references unknown acceptance criterion ${id}`);
      } else if (!coverage.work_item_ids.includes(owner)) {
        errors.push(`${coverage.decision_id} references acceptance criterion ${id} owned by ${owner} without including that work item`);
      }
    }
    for (const id of coverage.verification_command_ids) {
      const owner = verificationCommandOwners.get(id);
      if (owner === undefined) {
        errors.push(`${coverage.decision_id} references unknown verification command ${id}`);
      } else if (!coverage.work_item_ids.includes(owner)) {
        errors.push(`${coverage.decision_id} references verification command ${id} owned by ${owner} without including that work item`);
      }
    }
    const hasConcreteMappings = coverage.work_item_ids.length > 0
      || coverage.acceptance_ids.length > 0
      || coverage.verification_command_ids.length > 0;
    const hasNoImplementationEffect = coverage.no_implementation_effect !== null;
    if (hasConcreteMappings === hasNoImplementationEffect) {
      errors.push(
        `${coverage.decision_id} must use exactly one of concrete mappings or no_implementation_effect`,
      );
    }
  }

  const approvedAssumptions = brief.assumptions.map((assumption) => assumption.statement);
  if (
    plan.assumptions.length !== approvedAssumptions.length
    || plan.assumptions.some((assumption, index) => assumption !== approvedAssumptions[index])
  ) {
    errors.push("Plan assumptions must exactly match approved discovery assumptions");
  }
  if (
    plan.accepted_risks.length !== brief.accepted_risks.length
    || plan.accepted_risks.some((risk, index) => risk !== brief.accepted_risks[index])
  ) errors.push("Plan accepted risks must exactly match approved discovery accepted risks");
  if (
    plan.out_of_scope.length !== brief.out_of_scope.length
    || plan.out_of_scope.some((item, index) => item !== brief.out_of_scope[index])
  ) errors.push("Plan out of scope must exactly match approved discovery out of scope");

  if (errors.length > 0) {
    throw new Error(`Discovered Brain plan is not bound to the approved brief:\n- ${errors.join("\n- ")}`);
  }
}

/** Parse persisted plan bytes according to the immutable manifest protocol. */
export function parsePersistedPlan(value: unknown, protocol?: WorkflowProtocol): BrainPlan {
  const discovered = (protocol !== undefined && usesDurableDiscoveryProtocol(protocol)) || (protocol === undefined
    && typeof value === "object"
    && value !== null
    && "discovery_brief_revision" in value);
  return discovered
    ? discoveredBrainPlanSchema.parse(value)
    : brainPlanSchema.parse(value);
}

/** Serialize one parsed plan revision using the repository's persisted artifact format. */
export function serializePersistedPlan(value: unknown, protocol?: WorkflowProtocol): string {
  return `${JSON.stringify(parsePersistedPlan(value, protocol), null, 2)}\n`;
}

export function parseExecutionPlan(
  value: unknown,
  context?: PlanReadinessContext,
  protocol?: WorkflowProtocol,
): BrainPlan {
  const includeTestingFunnelByItem = persistedTestingFunnelPolicy(value);
  const plan = parsePersistedPlan(value, protocol);
  const diagnostics = planReadinessErrorsWithFunnelPolicy(plan, context, includeTestingFunnelByItem).map((message) => ({
    code: diagnosticCode(message),
    path: diagnosticPath(plan, message),
    message: message.slice(0, 240),
  }));
  if (diagnostics.length > 0) throw new PlanReadinessError(diagnostics);
  return plan;
}
