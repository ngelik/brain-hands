import { createHash } from "node:crypto";
import { posix } from "node:path";
import { z } from "zod";

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/;
const SAFE_ARTIFACT_PATH = /^(?![a-zA-Z]:[\\/])(?![\\/])(?!.*(?:^|[\\/])\.\.(?:[\\/]|$))(?!.*\\)[^\u0000-\u001f\u007f]+$/;
const VAGUE_REQUIREMENT = /\b(as needed|where appropriate|if necessary|properly|related changes?|and so on|etc\.)\b/i;
const PATH_GLOB = /[*?\[\]]/;

const idSchema = z.string().trim().min(1).regex(SAFE_ID);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const repositoryPathSchema = z.string().trim().min(1);
const commandSchema = z.object({ id: idSchema, argv: z.array(z.string().min(1)).min(1) }).strict();

export const fixTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("code"), path: repositoryPathSchema, symbol: z.string().trim().min(1), line_hint: z.number().int().positive().nullable() }).strict(),
  z.object({ kind: z.literal("test"), path: repositoryPathSchema, test_name: z.string().trim().min(1), line_hint: z.number().int().positive().nullable() }).strict(),
  z.object({ kind: z.literal("command"), command_id: idSchema }).strict(),
  z.object({ kind: z.literal("artifact"), artifact_id: idSchema, path: repositoryPathSchema }).strict(),
  z.object({ kind: z.literal("browser"), check_id: idSchema, selector: z.string().trim().min(1).nullable() }).strict(),
  z.object({ kind: z.literal("release_guard"), guard_id: idSchema }).strict(),
]);

export const fixPacketDiagnosisSchema = z.object({
  problem_class: z.enum(["correctness", "security", "regression", "verification", "artifact", "browser", "release_guard", "maintainability"]),
  severity: z.enum(["critical", "high", "medium", "low"]),
  observed_behavior: z.string().trim().min(1),
  expected_behavior: z.string().trim().min(1),
  failure_mechanism: z.string().trim().min(1),
  reproduction: z.array(z.string().trim().min(1)).min(1),
  evidence_refs: z.array(z.string().trim().min(1)).min(1),
}).strict();

export const fixPacketRemediationSchema = z.object({
  strategy: z.string().trim().min(1),
  change_units: z.array(z.object({
    id: idSchema,
    path: repositoryPathSchema,
    target: z.string().trim().min(1),
    operation: z.enum(["modify", "create", "delete"]),
    requirements: z.array(z.string().trim().min(1)).min(1),
    satisfies: z.array(idSchema).min(1),
  }).strict()).min(1),
  allowed_files: z.array(repositoryPathSchema).min(1),
  forbidden_changes: z.array(z.object({ path: repositoryPathSchema, reason: z.string().trim().min(1) }).strict()),
}).strict();

export const fixPacketVerificationSchema = z.object({
  commands: z.array(commandSchema).min(1),
  success_conditions: z.array(z.object({
    id: idSchema,
    statement: z.string().trim().min(1),
    satisfied_by: z.array(idSchema).min(1),
  }).strict()).min(1),
  required_evidence: z.array(z.object({
    id: idSchema,
    kind: z.enum(["command_result", "test_result", "artifact", "browser"]),
    source_id: idSchema,
    output_path: repositoryPathSchema,
  }).strict()).min(1),
}).strict();

export const reviewFixPacketV1Schema = z.object({
  schema_version: z.literal(1),
  provenance: z.object({
    packet_id: idSchema,
    finding_id: idSchema,
    action_id: idSchema,
    review_revision: z.number().int().positive(),
    work_item_id: idSchema,
    criterion_ref: idSchema,
    approved_plan_sha256: sha256Schema,
  }).strict(),
  diagnosis: fixPacketDiagnosisSchema,
  targets: z.array(fixTargetSchema).min(1),
  remediation: fixPacketRemediationSchema,
  verification: fixPacketVerificationSchema,
  completion_contract: z.object({
    required_change_unit_ids: z.array(idSchema).min(1),
    expected_changed_files: z.array(repositoryPathSchema).min(1),
    allowed_generated_evidence_files: z.array(repositoryPathSchema).optional(),
    allow_additional_files: z.literal(false),
  }).strict(),
}).strict();

export type ReviewFixPacketV1 = z.infer<typeof reviewFixPacketV1Schema>;
export const verifierRemediationClaimV1Schema = z.object({
  schema_version: z.literal(1),
  diagnosis: fixPacketDiagnosisSchema.omit({ problem_class: true, severity: true }),
  targets: z.array(fixTargetSchema).min(1),
  remediation: fixPacketRemediationSchema,
  verification: fixPacketVerificationSchema,
  completion_contract: reviewFixPacketV1Schema.shape.completion_contract,
}).strict();
export type VerifierRemediationClaimV1 = z.infer<typeof verifierRemediationClaimV1Schema>;

export const fixAttemptSupplementV1Schema = z.object({
  packet_id: idSchema,
  base_packet_sha256: sha256Schema,
  next_attempt: z.number().int().positive(),
  unsatisfied_condition_ids: z.array(idSchema).min(1),
  remaining_problem: z.string().trim().min(1),
  required_next_fix: z.string().trim().min(1),
  additional_evidence_refs: z.array(z.string().trim().min(1)),
}).strict();
export type FixAttemptSupplementV1 = z.infer<typeof fixAttemptSupplementV1Schema>;

export const fixPacketResultV1Schema = z.object({
  schema_version: z.literal(1),
  packet_id: idSchema,
  packet_sha256: sha256Schema,
  action_attempt: z.number().int().positive(),
  status: z.enum(["implemented", "packet_contradiction", "operationally_blocked"]),
  change_units: z.array(z.object({
    change_unit_id: idSchema,
    status: z.enum(["completed", "not_completed"]),
    changed_files: z.array(repositoryPathSchema),
    summary: z.string().trim().min(1),
  }).strict()),
  changed_files: z.array(repositoryPathSchema),
  commands_attempted: z.array(z.object({
    command_id: idSchema,
    argv: z.array(z.string().min(1)).min(1),
    exit_code: z.number().int().nullable(),
    evidence_ref: z.string().trim().min(1),
  }).strict()),
  unresolved_requirements: z.array(z.object({
    change_unit_id: idSchema,
    requirement: z.string().trim().min(1),
    reason: z.string().trim().min(1),
  }).strict()),
  blocker: z.object({
    code: z.string().trim().min(1),
    message: z.string().trim().min(1),
    evidence_refs: z.array(z.string().trim().min(1)),
  }).strict().nullable(),
}).strict().superRefine((result, context) => {
  if (result.status === "implemented") {
    if (result.unresolved_requirements.length > 0 || result.change_units.some((unit) => unit.status !== "completed") || result.blocker !== null) {
      context.addIssue({ code: "custom", message: "implemented requires completed change units, no unresolved requirements, and no blocker" });
    }
  } else if (result.status === "packet_contradiction") {
    if (result.unresolved_requirements.length === 0 || result.blocker !== null) {
      context.addIssue({ code: "custom", message: "packet_contradiction requires unresolved requirements and no operational blocker" });
    }
  } else if (result.blocker === null) {
    context.addIssue({ code: "custom", path: ["blocker"], message: "operationally_blocked requires blocker details" });
  }
  const actualFiles = [...new Set(result.change_units.flatMap((unit) => unit.changed_files))].sort();
  const reportedFiles = [...new Set(result.changed_files)].sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify(reportedFiles)) {
    context.addIssue({ code: "custom", path: ["changed_files"], message: "changed_files must equal the union of change-unit files" });
  }
});
export type FixPacketResultV1 = z.infer<typeof fixPacketResultV1Schema>;

export const fixPacketResolutionV1Schema = z.object({
  packet_id: idSchema,
  packet_sha256: sha256Schema,
  action_attempt: z.number().int().positive(),
  decision: z.enum(["resolved", "still_open", "packet_contradiction", "operationally_blocked"]),
  condition_results: z.array(z.object({
    success_condition_id: idSchema,
    status: z.enum(["satisfied", "unsatisfied"]),
    evidence_refs: z.array(z.string().trim().min(1)).min(1),
    remaining_problem: z.string().trim().min(1).nullable(),
  }).strict()).min(1),
  required_next_fix: z.string().trim().min(1).nullable(),
  blocker: z.object({ code: z.string().trim().min(1), message: z.string().trim().min(1), evidence_refs: z.array(z.string().trim().min(1)) }).strict().nullable(),
}).strict().superRefine((review, context) => {
  for (const [index, result] of review.condition_results.entries()) {
    if (result.status === "satisfied" && result.remaining_problem !== null) {
      context.addIssue({ code: "custom", path: ["condition_results", index, "remaining_problem"], message: "satisfied conditions require no remaining problem" });
    }
    if (result.status === "unsatisfied" && result.remaining_problem === null) {
      context.addIssue({ code: "custom", path: ["condition_results", index, "remaining_problem"], message: "unsatisfied conditions require a remaining problem" });
    }
  }
  const unsatisfied = review.condition_results.filter((entry) => entry.status === "unsatisfied");
  if (review.decision === "resolved" && (unsatisfied.length > 0 || review.required_next_fix !== null || review.blocker !== null)) {
    context.addIssue({ code: "custom", message: "resolved requires all conditions satisfied and no next fix or blocker" });
  }
  if (review.decision === "still_open" && (unsatisfied.length === 0 || review.required_next_fix === null || review.blocker !== null)) {
    context.addIssue({ code: "custom", message: "still_open requires an unsatisfied condition and a bounded next fix" });
  }
  if (review.decision === "packet_contradiction" && (unsatisfied.length === 0 || review.blocker !== null)) {
    context.addIssue({ code: "custom", message: "packet_contradiction requires an unsatisfied condition and no operational blocker" });
  }
  if (review.decision === "operationally_blocked" && review.blocker === null) {
    context.addIssue({ code: "custom", path: ["blocker"], message: "operationally_blocked requires blocker details" });
  }
});
export type FixPacketResolutionV1 = z.infer<typeof fixPacketResolutionV1Schema>;

export interface ReviewFixPacketReadinessContext {
  approved_plan_sha256: string;
}

function duplicates(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const found = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) found.add(value);
    seen.add(value);
  }
  return [...found];
}

function pathError(path: string): string | null {
  if (path === ".git" || path.startsWith(".git/")) return `path ${path} targets reserved Git metadata`;
  if (!SAFE_ARTIFACT_PATH.test(path) || PATH_GLOB.test(path) || path === "." || posix.isAbsolute(path) || posix.normalize(path) !== path) {
    return `path ${path} must be safe, normalized, and repository-relative`;
  }
  return null;
}

export function reviewFixPacketReadinessErrors(
  packet: ReviewFixPacketV1,
  context: ReviewFixPacketReadinessContext,
): string[] {
  const errors: string[] = [];
  if (packet.provenance.approved_plan_sha256 !== context.approved_plan_sha256) errors.push("approved plan hash does not match the active revision");

  const units = packet.remediation.change_units;
  const conditions = packet.verification.success_conditions;
  const commands = packet.verification.commands;
  const evidence = packet.verification.required_evidence;
  const allIds = [...units, ...conditions, ...commands, ...evidence].map((entry) => entry.id);
  for (const id of duplicates(allIds)) errors.push(`duplicate id ${id}`);

  const conditionIds = new Set(conditions.map((entry) => entry.id));
  const executableIds = new Set([...commands.map((entry) => entry.id), ...evidence.map((entry) => entry.id)]);
  for (const unit of units) {
    for (const requirement of unit.requirements) {
      if (VAGUE_REQUIREMENT.test(requirement)) errors.push(`${unit.id} contains vague requirement ${JSON.stringify(requirement)}`);
    }
    for (const id of unit.satisfies) if (!conditionIds.has(id)) errors.push(`${unit.id} references unknown success condition ${id}`);
  }
  for (const condition of conditions) {
    if (!condition.satisfied_by.some((id) => executableIds.has(id))) errors.push(`${condition.id} has no executable evidence`);
    for (const id of condition.satisfied_by) if (!allIds.includes(id)) errors.push(`${condition.id} references unknown evidence ${id}`);
  }
  const commandIds = new Set(commands.map((entry) => entry.id));
  for (const entry of evidence) if (!commandIds.has(entry.source_id)) errors.push(`${entry.id} references unknown command ${entry.source_id}`);

  const paths = [
    ...packet.remediation.allowed_files,
    ...packet.remediation.forbidden_changes.map((entry) => entry.path),
    ...units.map((entry) => entry.path),
    ...packet.completion_contract.expected_changed_files,
    ...(packet.completion_contract.allowed_generated_evidence_files ?? []),
    ...packet.targets.flatMap((target) => "path" in target ? [target.path] : []),
    ...packet.diagnosis.evidence_refs,
    ...evidence.map((entry) => entry.output_path),
  ];
  for (const path of paths) {
    const error = pathError(path);
    if (error) errors.push(error);
  }
  const byCase = new Map<string, string>();
  for (const path of packet.remediation.allowed_files) {
    const key = path.toLowerCase();
    const existing = byCase.get(key);
    if (existing && existing !== path) errors.push(`allowed files collide case-insensitively: ${existing}, ${path}`);
    byCase.set(key, path);
  }

  const allowed = new Set(packet.remediation.allowed_files);
  for (const unit of units) if (!allowed.has(unit.path)) errors.push(`${unit.id} path ${unit.path} is not allowed`);
  const unitFiles = [...new Set(units.map((entry) => entry.path))];
  for (const path of packet.completion_contract.expected_changed_files) if (!unitFiles.includes(path)) errors.push(`completion contract contains unexpected changed file ${path}`);
  for (const path of unitFiles) if (!packet.completion_contract.expected_changed_files.includes(path)) errors.push(`completion contract is missing changed file ${path}`);
  const linkedGenerated = [...new Set(evidence
    .filter((entry) => (entry.kind === "artifact" || entry.kind === "browser") && commandIds.has(entry.source_id))
    .map((entry) => entry.output_path))]
    .sort();
  const allowedGenerated = [...(packet.completion_contract.allowed_generated_evidence_files ?? [])].sort();
  if (JSON.stringify(linkedGenerated) !== JSON.stringify(allowedGenerated)) {
    errors.push("completion contract generated evidence files do not match linked artifact/browser evidence");
  }
  const requiredUnits = packet.completion_contract.required_change_unit_ids;
  for (const id of units.map((entry) => entry.id)) if (!requiredUnits.includes(id)) errors.push(`completion contract does not require ${id}`);
  for (const id of requiredUnits) if (!units.some((entry) => entry.id === id)) errors.push(`completion contract references unknown change unit ${id}`);
  return errors;
}

export function canonicalReviewFixPacket(packet: ReviewFixPacketV1): string {
  return `${JSON.stringify(reviewFixPacketV1Schema.parse(packet), null, 2)}\n`;
}

export function hashReviewFixPacket(packet: ReviewFixPacketV1): string {
  return createHash("sha256").update(canonicalReviewFixPacket(packet)).digest("hex");
}

export function assertFixPacketResultMatchesPacket(packet: ReviewFixPacketV1, result: FixPacketResultV1): void {
  const expectedUnitIds = [...packet.completion_contract.required_change_unit_ids].sort();
  const actualUnitIds = result.change_units.map((unit) => unit.change_unit_id).sort();
  if (new Set(actualUnitIds).size !== actualUnitIds.length || JSON.stringify(expectedUnitIds) !== JSON.stringify(actualUnitIds)) {
    throw new Error("Hands result must report every required change unit exactly once");
  }
  const expectedFiles = new Set(packet.completion_contract.expected_changed_files);
  for (const path of result.changed_files) if (!expectedFiles.has(path)) throw new Error(`Hands result contains unexpected changed file ${path}`);
  if (result.status === "implemented") {
    if (result.changed_files.some((path, index) => result.changed_files.indexOf(path) !== index)) {
      throw new Error("Hands result contains duplicate changed files");
    }
    if (JSON.stringify([...result.changed_files].sort()) !== JSON.stringify([...expectedFiles].sort())) {
      throw new Error("Implemented Hands result must report all expected changed files");
    }
  }
  const commands = new Map(packet.verification.commands.map((command) => [command.id, command.argv]));
  for (const attempt of result.commands_attempted) {
    const expected = commands.get(attempt.command_id);
    if (!expected) throw new Error(`Hands result references unknown command ${attempt.command_id}`);
    if (JSON.stringify(expected) !== JSON.stringify(attempt.argv)) throw new Error(`Hands result command ${attempt.command_id} argv does not match the packet`);
  }
  const units = new Map(packet.remediation.change_units.map((unit) => [unit.id, unit]));
  for (const unresolved of result.unresolved_requirements) {
    const unit = units.get(unresolved.change_unit_id);
    if (!unit) throw new Error(`Hands result references unknown change unit ${unresolved.change_unit_id}`);
    if (!unit.requirements.includes(unresolved.requirement)) throw new Error(`Hands result invents a requirement for ${unresolved.change_unit_id}`);
  }
}

export function assertFixPacketResolutionMatchesPacket(packet: ReviewFixPacketV1, review: FixPacketResolutionV1): void {
  const conditions = new Map(packet.verification.success_conditions.map((condition) => [condition.id, condition]));
  const actualIds = review.condition_results.map((result) => result.success_condition_id);
  const expectedIds = [...conditions.keys()].sort();
  if (new Set(actualIds).size !== actualIds.length || JSON.stringify([...actualIds].sort()) !== JSON.stringify(expectedIds)) {
    throw new Error("Verifier packet resolution must report every success condition exactly once");
  }
}
