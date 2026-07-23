import { z } from "zod";
import { createHash } from "node:crypto";
import {
  artifactRefV1Schema,
  artifactRefFromBytes,
  artifactSegment,
  canonicalJsonBytes,
  evidenceIndexV1Schema,
  handsContextV1Schema,
  reflectionContextV1Schema,
  verifierContextV1Schema,
  workItemSummaryV1Schema,
  type ArtifactRefV1,
  type HandsContextV1,
  type ReflectionContextV1,
  type VerifierContextV1,
  type WorkItemSummaryV1,
} from "../core/context-contracts.js";
import {
  readManifestV2,
  readReferencedJson,
  readVerifiedPlanRevision,
  withRunLedgerTransaction,
  writeImmutableValidatedJson,
} from "../core/ledger.js";
import { executionSpecV2Schema } from "../core/schema.js";
import { parsePersistedPlan } from "../core/execution-spec.js";
import type { RunManifestV2, WorkItem } from "../core/types.js";
import { readOwnedRunFile } from "../core/owned-evidence.js";
import {
  loadEvidenceIndex,
  reflectionEvidenceIndexPath,
} from "./evidence-index.js";
import { loadWorkItemSummary, workItemSummaryPath } from "./work-item-summaries.js";
import { loadCurrentFindingResolution } from "./findings.js";
import {
  verificationContextCandidates,
  currentWorkItemVerificationAuthority,
  type VerificationContextCandidate,
} from "./verification-context-fragments.js";
import { integratedWorkItem } from "./integrated-work-item.js";

export const CONTEXT_LIMITS_V1 = {
  hands_total_bytes: 64 * 1024,
  hands_diff_bytes: 32 * 1024,
  hands_evidence_bytes: 16 * 1024,
  verifier_total_bytes: 64 * 1024,
  verifier_diff_bytes: 32 * 1024,
  reflection_total_bytes: 96 * 1024,
} as const;

const generatedLockfilePath = /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/;

export function boundedGeneratedLockfileDiff(patch: string): string {
  if (Buffer.byteLength(patch, "utf8") <= CONTEXT_LIMITS_V1.verifier_diff_bytes) return patch;
  const boundaries = [...patch.matchAll(/^diff --git /gm)].map((match) => match.index);
  if (boundaries.length === 0) return patch;
  const prefix = patch.slice(0, boundaries[0]);
  const sections = boundaries.map((start, index) => patch.slice(start, boundaries[index + 1] ?? patch.length));
  let summarized = false;
  const bounded = sections.map((section) => {
    const header = section.split("\n", 1)[0] ?? "";
    const match = /^diff --git a\/(.+) b\/(.+)$/.exec(header);
    const path = match?.[2];
    if (!path || !generatedLockfilePath.test(path)) return section;
    summarized = true;
    return [
      header,
      "# Generated lockfile diff summarized for bounded role context.",
      `Path: ${path}`,
      `Git patch section bytes (not file content bytes): ${Buffer.byteLength(section, "utf8")}`,
      `Git patch section sha256 (not file content sha256): ${createHash("sha256").update(section).digest("hex")}`,
      "Do not compare this patch-section metadata with the worktree file size or digest.",
      "The full generated lockfile remains available in the worktree and is verified as an owned artifact.",
      "",
    ].join("\n");
  }).join("");
  const result = `${prefix}${bounded}`;
  return summarized && Buffer.byteLength(result, "utf8") <= CONTEXT_LIMITS_V1.verifier_diff_bytes
    ? result
    : patch;
}

function boundedSourceDiff(patch: string, role: "Hands" | "Verifier"): string {
  let bounded = boundedGeneratedLockfileDiff(patch);
  if (Buffer.byteLength(bounded, "utf8") <= CONTEXT_LIMITS_V1.verifier_diff_bytes) return bounded;
  const boundaries = [...bounded.matchAll(/^diff --git /gm)].map((match) => match.index);
  if (boundaries.length === 0) return bounded;
  const prefix = bounded.slice(0, boundaries[0]);
  const sections = boundaries.map((start, index) => bounded.slice(start, boundaries[index + 1] ?? bounded.length));
  const summaries = sections.map((section) => {
    const header = section.split("\n", 1)[0] ?? "";
    const match = /^diff --git a\/(.+) b\/(.+)$/.exec(header);
    if (!match?.[2]) return section;
    return [
      header,
      `# Source patch section summarized for bounded ${role} context.`,
      `Path: ${match[2]}`,
      `Git patch section bytes (not file content bytes): ${Buffer.byteLength(section, "utf8")}`,
      `Git patch section sha256 (not file content sha256): ${createHash("sha256").update(section).digest("hex")}`,
      "The full changed file remains available in the authoritative worktree for direct inspection.",
      "",
    ].join("\n");
  });
  const selected = new Set<number>();
  const bySavings = sections
    .map((section, index) => ({ index, savings: Buffer.byteLength(section, "utf8") - Buffer.byteLength(summaries[index]!, "utf8") }))
    .filter(({ savings }) => savings > 0)
    .sort((left, right) => right.savings - left.savings || left.index - right.index);
  for (const candidate of bySavings) {
    selected.add(candidate.index);
    bounded = `${prefix}${sections.map((section, index) => selected.has(index) ? summaries[index] : section).join("")}`;
    if (Buffer.byteLength(bounded, "utf8") <= CONTEXT_LIMITS_V1.verifier_diff_bytes) return bounded;
  }
  return patch;
}

export function boundedHandsDiff(patch: string): string {
  const bounded = boundedSourceDiff(patch, "Hands");
  return Buffer.byteLength(bounded, "utf8") <= CONTEXT_LIMITS_V1.hands_diff_bytes
    ? bounded
    : compactRoleDiff(patch);
}

export function boundedVerifierDiff(patch: string): string {
  return boundedSourceDiff(patch, "Verifier");
}

export type HandsAttemptKind = "initial" | "primary_fix" | "fix_packet" | "quality_recovery";

export interface BuildHandsContextInput {
  runDir: string;
  workItemId: string;
  planRevision: number;
  attempt: number;
  attemptKind: HandsAttemptKind;
  workItem: WorkItem;
  diff: string;
}

export interface BuildVerifierContextInput {
  runDir: string;
  workItemId: string;
  phase: VerifierContextV1["phase"];
  attempt: number;
  acceptanceContract: unknown[];
  changedFiles: string[];
  diff: string;
  evidenceIndexRef: ArtifactRefV1 | null;
  resume?: number;
}

export interface BuildReflectionContextInput {
  runDir: string;
  evidenceIndexRef: ArtifactRefV1;
  processMetrics: unknown;
}

export interface HandsInvocationContextCoordinates {
  workItemId: string;
  planRevision?: number;
  attempt: number;
  attemptKind: HandsAttemptKind;
}

export interface ValidateHandsInvocationContextInput extends HandsInvocationContextCoordinates {
  runDir: string;
  contextRef: ArtifactRefV1;
  context: HandsContextV1;
  workItem: WorkItem;
}

export interface ValidateVerifierInvocationContextInput {
  runDir: string;
  contextRef: ArtifactRefV1;
  context: VerifierContextV1;
  workItem: WorkItem;
  phase: VerifierContextV1["phase"];
  attempt: number;
}

interface LoadedCandidate {
  type: "dependency_summary" | "work_item_summary" | VerificationContextCandidate["type"];
  ref: ArtifactRefV1;
  value: JsonValue;
  target: string;
}

type JsonValue = z.infer<typeof z.json>;

const sourcePriority: Record<LoadedCandidate["type"], number> = {
  dependency_summary: 0,
  work_item_summary: 1,
  command_evidence: 2,
  artifact_check: 3,
  browser_evidence: 4,
};

const forbiddenKeys = new Set([
  "run_history",
  "events",
  "run_dir",
  "evidence_root",
  "artifacts_context",
]);

const handsAttemptKindSchema = z.enum(["initial", "primary_fix", "fix_packet", "quality_recovery"]);

function positiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
  return value;
}

function requiredJson(value: unknown, label: string): z.infer<typeof z.json> {
  const parsed = z.json().parse(value);
  assertNoForbiddenKeys(parsed, label);
  return parsed;
}

function equalJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function loadAuthoritativeSummary(runDir: string, ref: ArtifactRefV1): Promise<WorkItemSummaryV1> {
  const summary = await readReferencedJson(runDir, artifactRefV1Schema.parse(ref), workItemSummaryV1Schema);
  return loadWorkItemSummary(runDir, ref, {
    runId: summary.run_id,
    workItemId: summary.work_item_id,
    planRevision: summary.plan_revision,
    planSha256: summary.plan_sha256,
    attempt: summary.attempt,
    baseCommit: summary.base_commit,
    commitSha: summary.commit_sha,
  });
}

function summaryRef(summary: WorkItemSummaryV1): ArtifactRefV1 {
  const path = workItemSummaryPath(summary.work_item_id, summary.plan_revision, summary.attempt);
  return artifactRefFromBytes(path, canonicalJsonBytes(workItemSummaryV1Schema, summary));
}

function assertUniquePaths(refs: ArtifactRefV1[]): void {
  const seen = new Set<string>();
  for (const ref of refs) {
    if (seen.has(ref.path)) throw new Error(`Duplicate role-context source path: ${ref.path}`);
    seen.add(ref.path);
  }
}

function assertExactRefs(expected: ArtifactRefV1[], actual: ArtifactRefV1[], label: string): void {
  assertUniquePaths(actual);
  const expectedKeys = new Set(expected.map((ref) => `${ref.path}\0${ref.sha256}`));
  const actualKeys = new Set(actual.map((ref) => `${ref.path}\0${ref.sha256}`));
  if (expectedKeys.size !== actualKeys.size || [...expectedKeys].some((key) => !actualKeys.has(key))) {
    throw new Error(`${label} does not exactly partition its authoritative source references`);
  }
}

function refKey(ref: ArtifactRefV1): string {
  return `${ref.path}\0${ref.sha256}`;
}

function assertOrderedRefs(expected: ArtifactRefV1[], actual: ArtifactRefV1[], label: string): void {
  if (JSON.stringify(expected.map(refKey)) !== JSON.stringify(actual.map(refKey))) {
    throw new Error(`${label} is not in authoritative order`);
  }
}

function assertOrderedPartition(
  expected: ArtifactRefV1[],
  selected: ArtifactRefV1[],
  omitted: ArtifactRefV1[],
  label: string,
): void {
  assertExactRefs(expected, [...selected, ...omitted], label);
  const selectedKeys = new Set(selected.map(refKey));
  assertOrderedRefs(expected.filter((ref) => selectedKeys.has(refKey(ref))), selected, `${label} selected records`);
  assertOrderedRefs(expected.filter((ref) => !selectedKeys.has(refKey(ref))), omitted, `${label} omitted records`);
}

interface CurrentPlanAuthority {
  manifest: RunManifestV2;
  workItem: WorkItem;
  workItems: WorkItem[];
}

function structuredPlanItems(planText: string): WorkItem[] {
  const plan = JSON.parse(planText) as { work_items?: unknown };
  return Array.isArray(plan.work_items)
    ? plan.work_items.map((candidate) => executionSpecV2Schema.parse(candidate))
    : [];
}

async function assertDependencySummaries(
  runDir: string,
  authority: CurrentPlanAuthority,
  records: Array<{ ref: ArtifactRefV1; summary: WorkItemSummaryV1 }>,
): Promise<void> {
  const { manifest, workItem, workItems } = authority;
  const summaries = records.map(({ summary }) => summary);
  const ids = summaries.map((summary) => summary.work_item_id);
  const expected = new Set(workItem.dependencies);
  if (new Set(ids).size !== ids.length) throw new Error("Duplicate Hands dependency summary");
  const missing = workItem.dependencies.find((id) => !ids.includes(id));
  if (missing) throw new Error(`Hands dependency summary is missing for ${missing}`);
  const extra = ids.find((id) => !expected.has(id));
  if (extra) throw new Error(`Hands dependency summary is not declared for ${extra}`);
  for (const { ref, summary } of records) {
    const progress = manifest.work_item_progress[summary.work_item_id];
    if (
      progress?.status !== "complete"
      || progress.summary_path !== ref.path
      || progress.summary_sha256 !== ref.sha256
    ) {
      throw new Error(`Hands dependency summary is not the exact current completed dependency summary authority for ${summary.work_item_id}`);
    }
    const current = workItems.find((candidate) => candidate.id === summary.work_item_id);
    const historical = structuredPlanItems(
      await readVerifiedPlanRevision(runDir, manifest, summary.plan_revision),
    ).find((candidate) => candidate.id === summary.work_item_id);
    if (!current || !historical || !equalJson(current, historical)) {
      throw new Error(`Hands dependency summary contract is stale for ${summary.work_item_id}`);
    }
  }
}

async function canonicalWorkItem(
  runDir: string,
  supplied: WorkItem,
  planRevision: number,
): Promise<CurrentPlanAuthority> {
  const workItem = executionSpecV2Schema.parse(supplied);
  const authority = await canonicalWorkItemById(runDir, workItem.id, planRevision);
  if (!equalJson(authority.workItem, workItem)) {
    throw new Error("Hands work item does not match the current approved plan");
  }
  return authority;
}

async function canonicalWorkItemById(
  runDir: string,
  workItemId: string,
  planRevision: number,
): Promise<CurrentPlanAuthority> {
  const manifest = await readManifestV2(runDir);
  if (
    manifest.workflow_protocol !== "bounded-context-v1"
    || manifest.approved_revision !== planRevision
    || manifest.approved_plan_revision !== planRevision
  ) {
    throw new Error("Hands context plan revision is not current bounded authority");
  }
  const planText = await readVerifiedPlanRevision(runDir, manifest, planRevision);
  const workItems = structuredPlanItems(planText);
  const matches = workItemId === "integrated"
    ? [executionSpecV2Schema.parse(integratedWorkItem(
        parsePersistedPlan(JSON.parse(planText)),
        { includeCompletedDependencies: true },
      ))]
    : workItems.filter((candidate) => candidate.id === workItemId);
  if (matches.length !== 1) throw new Error("Hands work item is missing from the current approved plan");
  return { manifest, workItem: matches[0]!, workItems };
}

function requiredJsonArray(value: unknown[], label: string): Array<z.infer<typeof z.json>> {
  return value.map((entry, index) => requiredJson(entry, `${label}[${index}]`));
}

function assertNoForbiddenKeys(value: z.infer<typeof z.json>, label: string): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoForbiddenKeys(entry, `${label}[${index}]`));
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    if (forbiddenKeys.has(key)) throw new Error(`Role context ${label} contains forbidden key ${key}`);
    assertNoForbiddenKeys(entry, `${label}.${key}`);
  }
}

function compareCandidates(left: LoadedCandidate, right: LoadedCandidate): number {
  const priority = sourcePriority[left.type] - sourcePriority[right.type];
  if (priority !== 0) return priority;
  return left.ref.path < right.ref.path ? -1 : left.ref.path > right.ref.path ? 1 : 0;
}

async function currentDependencyCandidates(
  runDir: string,
  authority: CurrentPlanAuthority,
): Promise<LoadedCandidate[]> {
  const records = await Promise.all(authority.workItem.dependencies.map(async (dependencyId) => {
    const progress = authority.manifest.work_item_progress[dependencyId];
    if (
      progress?.status !== "complete"
      || typeof progress.summary_path !== "string"
      || typeof progress.summary_sha256 !== "string"
    ) {
      throw new Error(`Hands dependency summary is not the exact current completed dependency summary authority for ${dependencyId}`);
    }
    const ref = artifactRefV1Schema.parse({ path: progress.summary_path, sha256: progress.summary_sha256 });
    const currentRef = artifactRefFromBytes(ref.path, await readOwnedRunFile(runDir, ref.path));
    if (!equalJson(ref, currentRef)) {
      throw new Error(`Hands dependency summary is not the exact current completed dependency summary authority for ${dependencyId}`);
    }
    return { ref, summary: await loadAuthoritativeSummary(runDir, ref) };
  }));
  await assertDependencySummaries(runDir, authority, records);
  return records.map(({ ref, summary }) => ({
    type: "dependency_summary" as const,
    ref,
    value: summary,
    target: "dependency_summaries",
  })).sort(compareCandidates);
}

async function activeFindingsFor(
  runDir: string,
  manifest: RunManifestV2,
  workItemIds: string[],
): Promise<JsonValue[]> {
  const active: JsonValue[] = [];
  for (const workItemId of [...new Set(workItemIds)].sort()) {
    const indexed = Object.values(manifest.finding_index ?? {})
      .filter((finding) => finding.work_item_id === workItemId);
    if (indexed.length === 0) continue;
    const progress = manifest.work_item_progress[workItemId];
    const reviewRevision = progress?.review_revision;
    if (typeof reviewRevision !== "number" || !Number.isInteger(reviewRevision) || reviewRevision < 1) {
      if (Array.isArray(progress?.approved_replan_history) && progress.approved_replan_history.length > 0) continue;
      throw new Error(`Current active finding authority is missing for ${workItemId}`);
    }
    const resolution = await loadCurrentFindingResolution(runDir, workItemId, reviewRevision);
    const unresolved = new Set(resolution.unresolved_finding_ids);
    active.push(...resolution.findings.filter((finding) => unresolved.has(finding.finding_id)));
  }
  return active;
}

function assertEvidencePartition(
  expected: LoadedCandidate[],
  selectedByTarget: Record<string, Array<{ ref: ArtifactRefV1; value: JsonValue }>>,
  omitted: ArtifactRefV1[],
): void {
  const selected = Object.entries(selectedByTarget).flatMap(([target, records]) =>
    records.map((record) => ({ target, record })));
  assertExactRefs(expected.map(({ ref }) => ref), [
    ...selected.map(({ record }) => record.ref),
    ...omitted,
  ], "Semantic evidence universe");
  const expectedByRef = new Map(expected.map((candidate) => [`${candidate.ref.path}\0${candidate.ref.sha256}`, candidate]));
  for (const { target, record } of selected) {
    const candidate = expectedByRef.get(`${record.ref.path}\0${record.ref.sha256}`);
    if (!candidate || candidate.target !== target || !equalJson(candidate.value, record)) {
      throw new Error(`Selected semantic evidence has the wrong type or value: ${record.ref.path}`);
    }
  }
  const selectedKeys = new Set(selected.map(({ record }) => refKey(record.ref)));
  for (const [target, records] of Object.entries(selectedByTarget)) {
    assertOrderedRefs(
      expected.filter((candidate) => candidate.target === target && selectedKeys.has(refKey(candidate.ref)))
        .map(({ ref }) => ref),
      records.map(({ ref }) => ref),
      `${target} selected evidence`,
    );
  }
  assertOrderedRefs(
    expected.filter((candidate) => !selectedKeys.has(refKey(candidate.ref))).map(({ ref }) => ref),
    omitted,
    "Omitted semantic evidence",
  );
}

function serializedArrayBytes(values: Array<z.infer<typeof z.json>>): number {
  return Buffer.byteLength(`${JSON.stringify(values, null, 2)}\n`, "utf8");
}

function assertRequiredContextFits<T>(value: T, schema: z.ZodType<T>, totalLimit: number, label: string): void {
  if (canonicalJsonBytes(schema, value).byteLength <= totalLimit) return;
  throw new Error(`${label} required context exceeds ${totalLimit} UTF-8 bytes`);
}

function utf8Prefix(value: string, maxBytes: number): string {
  let bytes = 0;
  let result = "";
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maxBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}

function utf8Suffix(value: string, maxBytes: number): string {
  let bytes = 0;
  const characters: string[] = [];
  for (const character of Array.from(value).reverse()) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maxBytes) break;
    characters.push(character);
    bytes += characterBytes;
  }
  return characters.reverse().join("");
}

function compactTextTail(value: string, maxBytes: number, label: string): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const marker = `[Earlier ${label} summarized: ${Buffer.byteLength(value, "utf8")} UTF-8 bytes, sha256 ${createHash("sha256").update(value).digest("hex")}]`;
  const retainedBytes = maxBytes - Buffer.byteLength(marker, "utf8") - Buffer.byteLength("\n\n", "utf8");
  const prefix = utf8Prefix(value, Math.floor(retainedBytes / 3));
  const suffix = utf8Suffix(value, retainedBytes - Buffer.byteLength(prefix, "utf8"));
  return [prefix, marker, suffix].join("\n");
}

function compactTextTailV051(value: string, maxBytes: number, label: string): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let tail = value.slice(-maxBytes);
  while (Buffer.byteLength(tail, "utf8") > maxBytes) tail = tail.slice(1);
  return [
    `[Earlier ${label} summarized: ${Buffer.byteLength(value, "utf8")} UTF-8 bytes, sha256 ${createHash("sha256").update(value).digest("hex")}]`,
    tail,
  ].join("\n");
}

function compactTextEdges(value: string, maxBytes: number, label: string): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  void label;
  return `[sha256=${createHash("sha256").update(value).digest("hex")}]`;
}

function compactJsonSummary(value: unknown, label: string): string {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  void label;
  return `[sha256=${createHash("sha256").update(bytes).digest("hex")}]`;
}

function compactStringArray(values: string[], label: string): string[] {
  const summary = [compactJsonSummary(values, label)];
  return Buffer.byteLength(JSON.stringify(values), "utf8") <= Buffer.byteLength(JSON.stringify(summary), "utf8")
    ? values
    : summary;
}

function compactChangeUnits(workItem: WorkItem): WorkItem["change_units"] {
  const compacted = workItem.change_units.map((unit) => ({
    ...unit,
    target: compactTextEdges(unit.target, 128, "change-unit target"),
    requirements: compactStringArray(unit.requirements, "change-unit requirements"),
  }));
  if (Buffer.byteLength(JSON.stringify(compacted), "utf8") <= 12 * 1024) return compacted;
  const representative = workItem.change_units[0]!;
  return [{
    id: "compact-approved-change-units",
    path: representative.path,
    target: "Approved change units summarized for bounded execution context.",
    operation: representative.operation,
    requirements: [compactJsonSummary(workItem.change_units, "approved change units")],
  }];
}

function compactHandsWorkItemWithObjective(workItem: WorkItem, objective: string): WorkItem {
  const changeUnits = compactChangeUnits(workItem);
  const changeUnitIds = new Set(changeUnits.map((unit) => unit.id));
  const compactedChangeUnitId = changeUnits.length === 1 && changeUnits[0]!.id === "compact-approved-change-units"
    ? changeUnits[0]!.id
    : null;
  return executionSpecV2Schema.parse({
    ...workItem,
    objective,
    file_contract: workItem.file_contract.map((entry) => ({
      ...entry,
      targets: compactStringArray(entry.targets, "file-contract targets"),
    })),
    forbidden_changes: workItem.forbidden_changes.map((entry) => ({
      ...entry,
      reason: compactTextEdges(entry.reason, 128, "forbidden-change reason"),
    })),
    change_units: changeUnits,
    acceptance: workItem.acceptance.map((criterion) => ({
      ...criterion,
      statement: compactTextEdges(criterion.statement, 96, "acceptance statement"),
      satisfied_by: compactedChangeUnitId === null
        ? criterion.satisfied_by.filter((id) => changeUnitIds.has(id))
        : [compactedChangeUnitId],
    })),
    tests: workItem.tests.map((test) => ({
      ...test,
      assertion: compactTextEdges(test.assertion, 160, "test assertion"),
    })),
    ...(workItem.cross_cutting_impacts === undefined ? {} : {
      cross_cutting_impacts: workItem.cross_cutting_impacts.map((impact) => ({
        ...impact,
        callers: compactStringArray(impact.callers, "cross-cutting callers"),
        representative_fixtures: compactStringArray(impact.representative_fixtures, "cross-cutting fixtures"),
      })),
    }),
    risks: [{
      description: compactJsonSummary(workItem.risks, "approved risks"),
      mitigation: "Inspect the authoritative approved plan and current fix packet before mutation.",
    }],
    ambiguity_policy: {
      ...workItem.ambiguity_policy,
      stop_when: compactStringArray(workItem.ambiguity_policy.stop_when, "ambiguity stop conditions"),
    },
  });
}

export function compactHandsWorkItem(workItem: WorkItem): WorkItem {
  return compactHandsWorkItemWithObjective(
    workItem,
    compactTextTail(workItem.objective, 2 * 1024, "approved objective history"),
  );
}

function compactHandsWorkItemV051(workItem: WorkItem): WorkItem {
  return compactHandsWorkItemWithObjective(
    workItem,
    compactTextTailV051(workItem.objective, 2 * 1024, "approved objective history"),
  );
}

function compactActiveFinding(finding: JsonValue): JsonValue {
  if (finding === null || Array.isArray(finding) || typeof finding !== "object") return finding;
  const record = finding as Record<string, JsonValue>;
  const remediation = record.remediation;
  if (remediation === undefined) return finding;
  const bytes = Buffer.from(`${JSON.stringify(remediation)}\n`, "utf8");
  const compactedRecord = {
    ...record,
    ...(typeof record.problem === "string" ? { problem: compactTextEdges(record.problem, 192, "finding problem") } : {}),
    ...(typeof record.required_fix === "string" ? { required_fix: compactTextEdges(record.required_fix, 192, "finding required fix") } : {}),
  };
  if (bytes.byteLength <= 1024) return compactedRecord;
  return {
    ...compactedRecord,
    remediation: {
      summary: "Structured remediation omitted from bounded active-finding context; the current fix packet remains authoritative.",
      bytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
  };
}

function compactActiveFindings(findings: JsonValue[]): JsonValue[] {
  return findings.map(compactActiveFinding);
}

function matchesFullOrCompactedWorkItem(candidate: unknown, authority: WorkItem): boolean {
  return equalJson(candidate, authority)
    || equalJson(candidate, compactHandsWorkItem(authority))
    || equalJson(candidate, compactHandsWorkItemV051(authority));
}

function matchesFullOrCompactedFindings(candidate: unknown, authority: JsonValue[]): boolean {
  return equalJson(candidate, authority) || equalJson(candidate, compactActiveFindings(authority));
}

function compactRoleDiff(diff: string): string {
  return [
    "# Source diff summarized to preserve bounded role context.",
    `Git patch bytes: ${Buffer.byteLength(diff, "utf8")}`,
    `Git patch sha256: ${createHash("sha256").update(diff).digest("hex")}`,
    "Inspect the authoritative worktree for the complete changed files.",
    "",
  ].join("\n");
}

function packOptional<T>(
  required: T,
  schema: z.ZodType<T>,
  candidates: LoadedCandidate[],
  totalLimit: number,
  evidenceLimit?: { target: string; bytes: number },
  diffFallback?: string,
): T {
  let boundedRequired = required;
  let diffCompacted = false;
  const selected = new Set(candidates.map((_, index) => index));
  const render = (): T => {
    const value = { ...(boundedRequired as Record<string, unknown>) };
    const targets = new Set(candidates.map((candidate) => candidate.target));
    for (const target of targets) {
      value[target] = candidates
        .map((candidate, index) => ({ candidate, index }))
        .filter(({ candidate, index }) => candidate.target === target && selected.has(index))
        .map(({ candidate }) => candidate.value);
    }
    value.omitted_evidence = candidates
      .map((candidate, index) => ({ candidate, index }))
      .filter(({ index }) => !selected.has(index))
      .map(({ candidate }) => ({ ref: candidate.ref, reason: "role_byte_limit" }));
    return schema.parse(value);
  };

  if (evidenceLimit) {
    while (true) {
      const evidence = candidates
        .map((candidate, index) => ({ candidate, index }))
        .filter(({ candidate, index }) => candidate.target === evidenceLimit.target && selected.has(index));
      if (serializedArrayBytes(evidence.map(({ candidate }) => candidate.value)) <= evidenceLimit.bytes) break;
      const lowestPriority = evidence.at(-1);
      if (!lowestPriority) break;
      selected.delete(lowestPriority.index);
    }
  }

  let packed = render();
  while (canonicalJsonBytes(schema, packed).byteLength > totalLimit) {
    const before = canonicalJsonBytes(schema, packed).byteLength;
    let removed = false;
    for (let index = candidates.length - 1; index >= 0; index -= 1) {
      if (!selected.has(index)) continue;
      selected.delete(index);
      const next = render();
      if (canonicalJsonBytes(schema, next).byteLength < before) {
        packed = next;
        removed = true;
        break;
      }
      selected.add(index);
    }
    if (!removed) {
      const currentDiff = (boundedRequired as Record<string, unknown>).diff;
      if (!diffCompacted && typeof currentDiff === "string" && currentDiff.length > 0) {
        boundedRequired = {
          ...(boundedRequired as Record<string, unknown>),
          diff: diffFallback ?? compactRoleDiff(currentDiff),
        } as T;
        diffCompacted = true;
        packed = render();
        continue;
      }
      throw new Error(`Role context and required omission references exceed ${totalLimit} UTF-8 bytes`);
    }
  }
  return packed;
}

export function handsContextPath(
  workItemId: string,
  planRevision: number,
  attempt: number,
  attemptKind: HandsAttemptKind,
): string {
  positiveInteger(planRevision, "Hands plan revision");
  positiveInteger(attempt, "Hands attempt");
  const kind = handsAttemptKindSchema.parse(attemptKind);
  if (workItemId.length === 0) throw new Error("Hands work-item ID must not be empty");
  return `contexts/hands/${artifactSegment(workItemId)}/plan-${planRevision}/attempt-${attempt}/${kind}.json`;
}

export function verifierContextPath(
  workItemId: string,
  phase: VerifierContextV1["phase"],
  attempt: number,
  resume = 1,
): string {
  positiveInteger(attempt, "Verifier attempt");
  positiveInteger(resume, "Verifier context resume");
  const parsedPhase = verifierContextV1Schema.shape.phase.parse(phase);
  if (workItemId.length === 0) throw new Error("Verifier work-item ID must not be empty");
  const suffix = resume === 1 ? "" : `-resume-${resume}`;
  return `contexts/verifier/${artifactSegment(workItemId)}/${parsedPhase}/attempt-${attempt}${suffix}.json`;
}

export const reflectionContextPath = "contexts/reflection/final.json";

async function buildHandsContextLocked(input: BuildHandsContextInput): Promise<ArtifactRefV1> {
  const boundedDiff = boundedHandsDiff(input.diff);
  const rawDiffDigest = compactRoleDiff(input.diff);
  if (Buffer.byteLength(boundedDiff, "utf8") > CONTEXT_LIMITS_V1.hands_diff_bytes) {
    throw new Error(`Hands diff exceeds ${CONTEXT_LIMITS_V1.hands_diff_bytes} UTF-8 bytes`);
  }
  requiredJson(input.workItem, "work_item");
  const authority = await canonicalWorkItem(input.runDir, input.workItem, input.planRevision);
  const { workItem } = authority;
  if (workItem.id !== input.workItemId) {
    throw new Error("Hands work-item ID does not match its context identity");
  }
  const activeFindings = await activeFindingsFor(input.runDir, authority.manifest, [workItem.id]);
  let required = handsContextV1Schema.parse({
    schema_version: 1,
    role: "hands",
    work_item: workItem,
    diff: boundedDiff,
    active_findings: activeFindings,
    dependency_summaries: [],
    bounded_evidence: [],
    omitted_evidence: [],
  });
  if (canonicalJsonBytes(handsContextV1Schema, required).byteLength > CONTEXT_LIMITS_V1.hands_total_bytes) {
    required = handsContextV1Schema.parse({
      ...required,
      work_item: compactHandsWorkItem(workItem),
      active_findings: compactActiveFindings(activeFindings),
    });
  }
  if (canonicalJsonBytes(handsContextV1Schema, required).byteLength > CONTEXT_LIMITS_V1.hands_total_bytes) {
    required = handsContextV1Schema.parse({
      ...required,
      diff: rawDiffDigest,
    });
  }
  assertRequiredContextFits(required, handsContextV1Schema, CONTEXT_LIMITS_V1.hands_total_bytes, "Hands");
  const dependencyCandidates = await currentDependencyCandidates(input.runDir, authority);
  const verification = await currentWorkItemVerificationAuthority(
    input.runDir,
    authority.manifest,
    workItem.id,
    workItem.id === "integrated" && input.attempt > 1 ? input.attempt - 1 : undefined,
  );
  const evidenceCandidates = (await verificationContextCandidates(
    input.runDir,
    verification?.ref ?? null,
    verification?.identity ?? null,
    true,
  ))
    .map((candidate) => ({ ...candidate, target: "bounded_evidence" }));
  const candidates = [...dependencyCandidates, ...evidenceCandidates].sort(compareCandidates);
  const context = packOptional(
    required,
    handsContextV1Schema,
    candidates,
    CONTEXT_LIMITS_V1.hands_total_bytes,
    { target: "bounded_evidence", bytes: CONTEXT_LIMITS_V1.hands_evidence_bytes },
    rawDiffDigest,
  );
  return writeImmutableValidatedJson(
    input.runDir,
    handsContextPath(input.workItemId, input.planRevision, input.attempt, input.attemptKind),
    handsContextV1Schema,
    context,
  );
}

export function buildHandsContext(input: BuildHandsContextInput): Promise<ArtifactRefV1> {
  return withRunLedgerTransaction(input.runDir, () => buildHandsContextLocked(input));
}

async function validateVerifierEvidenceIndex(
  runDir: string,
  phase: VerifierContextV1["phase"],
  attempt: number,
  ref: ArtifactRefV1 | null,
): Promise<{ ref: ArtifactRefV1 | null; index: z.infer<typeof evidenceIndexV1Schema> | null }> {
  if (phase === "work_item") {
    if (ref !== null) throw new Error("Work-item Verifier context cannot include a terminal evidence index");
    return { ref: null, index: null };
  }
  if (ref === null) throw new Error(`${phase} Verifier context requires an evidence index`);
  const parsedRef = artifactRefV1Schema.parse(ref);
  const index = await readReferencedJson(runDir, parsedRef, evidenceIndexV1Schema);
  const authoritative = await loadEvidenceIndex(runDir, parsedRef, {
    phase,
    attempt,
    candidateCommit: index.candidate_commit,
  });
  return { ref: parsedRef, index: authoritative };
}

async function buildVerifierContextLocked(input: BuildVerifierContextInput): Promise<ArtifactRefV1> {
  const boundedDiff = boundedVerifierDiff(input.diff);
  if (Buffer.byteLength(boundedDiff, "utf8") > CONTEXT_LIMITS_V1.verifier_diff_bytes) {
    throw new Error(`Verifier diff exceeds ${CONTEXT_LIMITS_V1.verifier_diff_bytes} UTF-8 bytes`);
  }
  const evidenceIndexAuthority = await validateVerifierEvidenceIndex(
    input.runDir,
    input.phase,
    input.attempt,
    input.evidenceIndexRef,
  );
  const manifest = await readManifestV2(input.runDir);
  const sourceVerification = input.phase === "work_item"
    ? await currentWorkItemVerificationAuthority(input.runDir, manifest, input.workItemId, input.attempt)
    : {
        ref: evidenceIndexAuthority.index!.integrated_verification_ref,
        identity: { scope: "integrated", work_item_id: "integrated" } as const,
      };
  if (sourceVerification === null) {
    throw new Error(`Work-item Verifier context requires current verification authority for ${input.workItemId}`);
  }
  const activeFindingIds = input.phase === "work_item"
    ? [input.workItemId]
    : [...new Set(Object.values(manifest.finding_index ?? {}).map((finding) => finding.work_item_id))];
  const activeFindings = await activeFindingsFor(input.runDir, manifest, activeFindingIds);
  const required = verifierContextV1Schema.parse({
    schema_version: 1,
    role: "verifier",
    phase: input.phase,
    work_item_id: input.workItemId,
    acceptance_contract: requiredJsonArray(input.acceptanceContract, "acceptance_contract"),
    changed_files: input.changedFiles,
    diff: boundedDiff,
    verification_ref: sourceVerification.ref,
    command_evidence: [],
    artifact_checks: [],
    browser_evidence: [],
    active_findings: activeFindings,
    evidence_index_ref: evidenceIndexAuthority.ref,
    omitted_evidence: [],
  });
  assertRequiredContextFits(required, verifierContextV1Schema, CONTEXT_LIMITS_V1.verifier_total_bytes, "Verifier");
  const candidates = await verificationContextCandidates(
    input.runDir,
    sourceVerification.ref,
    sourceVerification.identity,
    true,
  );
  const context = packOptional(
    required,
    verifierContextV1Schema,
    candidates,
    CONTEXT_LIMITS_V1.verifier_total_bytes,
  );
  return writeImmutableValidatedJson(
    input.runDir,
    verifierContextPath(input.workItemId, input.phase, input.attempt, input.resume),
    verifierContextV1Schema,
    context,
  );
}

export function buildVerifierContext(input: BuildVerifierContextInput): Promise<ArtifactRefV1> {
  return withRunLedgerTransaction(input.runDir, () => buildVerifierContextLocked(input));
}

async function buildReflectionContextLocked(input: BuildReflectionContextInput): Promise<ArtifactRefV1> {
  const indexRef = artifactRefV1Schema.parse(input.evidenceIndexRef);
  const rawIndex = await readReferencedJson(input.runDir, indexRef, evidenceIndexV1Schema);
  const evidenceIndex = await loadEvidenceIndex(input.runDir, indexRef, {
    phase: "reflection",
    attempt: rawIndex.attempt,
    candidateCommit: rawIndex.candidate_commit,
  });
  const manifest = await readManifestV2(input.runDir);
  const required = reflectionContextV1Schema.parse({
    schema_version: 1,
    role: "reflection",
    evidence_index: evidenceIndex,
    work_item_summaries: [],
    active_findings: await activeFindingsFor(
      input.runDir,
      manifest,
      [...new Set(Object.values(manifest.finding_index ?? {}).map((finding) => finding.work_item_id))],
    ),
    process_metrics: requiredJson(input.processMetrics, "process_metrics"),
    omitted_evidence: [],
  });
  assertRequiredContextFits(required, reflectionContextV1Schema, CONTEXT_LIMITS_V1.reflection_total_bytes, "Reflection");
  const candidates = (await Promise.all(evidenceIndex.work_item_summary_refs.map(async (ref) => ({
    type: "work_item_summary" as const,
    ref,
    value: await loadAuthoritativeSummary(input.runDir, ref),
    target: "work_item_summaries",
  }))));
  const context = packOptional(
    required,
    reflectionContextV1Schema,
    candidates,
    CONTEXT_LIMITS_V1.reflection_total_bytes,
  );
  return writeImmutableValidatedJson(
    input.runDir,
    reflectionContextPath,
    reflectionContextV1Schema,
    context,
  );
}

export function buildReflectionContext(input: BuildReflectionContextInput): Promise<ArtifactRefV1> {
  return withRunLedgerTransaction(input.runDir, () => buildReflectionContextLocked(input));
}

const handsPathPattern = /^contexts\/hands\/[A-Za-z0-9_-]+\/plan-[1-9]\d*\/attempt-[1-9]\d*\/(?:initial|primary_fix|fix_packet|quality_recovery)\.json$/;
const verifierPathPattern = /^contexts\/verifier\/[A-Za-z0-9_-]+\/(?:work_item|final_integrated|post_pr)\/attempt-[1-9]\d*(?:-resume-[2-9]\d*)?\.json$/;

function pathWorkItemId(path: string): string {
  const segment = path.split("/")[2]!;
  const decoded = Buffer.from(segment, "base64url").toString("utf8");
  if (artifactSegment(decoded) !== segment) throw new Error("Role-context path has a non-canonical work-item identity");
  return decoded;
}

export function handsContextReferenceCoordinates(
  ref: ArtifactRefV1,
  expected?: HandsInvocationContextCoordinates,
): Required<HandsInvocationContextCoordinates> {
  const reference = artifactRefV1Schema.parse(ref);
  if (!handsPathPattern.test(reference.path)) {
    throw new Error("Role-context path does not match hands");
  }
  const segments = reference.path.split("/");
  const coordinates = {
    workItemId: pathWorkItemId(reference.path),
    planRevision: positiveInteger(Number(segments[3]!.slice("plan-".length)), "Hands plan revision"),
    attempt: positiveInteger(Number(segments[4]!.slice("attempt-".length)), "Hands attempt"),
    attemptKind: handsAttemptKindSchema.parse(segments[5]!.slice(0, -".json".length)),
  };
  if (reference.path !== handsContextPath(
    coordinates.workItemId,
    coordinates.planRevision,
    coordinates.attempt,
    coordinates.attemptKind,
  )) {
    throw new Error("Hands role-context path is not canonical");
  }
  if (expected) {
    if (coordinates.workItemId !== expected.workItemId) throw new Error("Hands role-context path does not match its work item");
    if (expected.planRevision !== undefined && coordinates.planRevision !== expected.planRevision) {
      throw new Error("Hands role-context path does not match its plan revision");
    }
    if (coordinates.attempt !== expected.attempt) throw new Error("Hands role-context path does not match its attempt");
    if (coordinates.attemptKind !== expected.attemptKind) throw new Error("Hands role-context path does not match its attempt kind");
  }
  return coordinates;
}

export async function validateHandsInvocationContext(
  input: ValidateHandsInvocationContextInput,
): Promise<{
  context_ref: ArtifactRefV1;
  context: HandsContextV1;
  plan_revision: number;
  plan_sha256: string;
}> {
  const reference = artifactRefV1Schema.parse(input.contextRef);
  const suppliedContext = handsContextV1Schema.parse(input.context);
  const coordinates = handsContextReferenceCoordinates(reference, input);
  const workItem = executionSpecV2Schema.parse(input.workItem);
  if (!matchesFullOrCompactedWorkItem(suppliedContext.work_item, workItem)) {
    throw new Error("Bounded Hands context work item does not match the invocation");
  }
  const loadedContext = await loadRoleContext(input.runDir, reference, "hands");
  if (!equalJson(loadedContext, suppliedContext)) {
    throw new Error("Supplied Hands context does not match its immutable authoritative artifact");
  }
  const authority = await canonicalWorkItem(input.runDir, workItem, coordinates.planRevision);
  const planSha256 = authority.manifest.plan_revisions[String(coordinates.planRevision)]?.sha256;
  if (!planSha256) throw new Error("Hands context approved plan hash is unavailable");
  return {
    context_ref: reference,
    context: loadedContext,
    plan_revision: coordinates.planRevision,
    plan_sha256: planSha256,
  };
}

function verifierPathCoordinates(path: string): { phase: VerifierContextV1["phase"]; attempt: number; resume: number } {
  const segments = path.split("/");
  const match = segments[4]!.match(/^attempt-(\d+)(?:-resume-(\d+))?\.json$/);
  if (!match) throw new Error("Verifier role-context path coordinates are invalid");
  return {
    phase: verifierContextV1Schema.shape.phase.parse(segments[3]),
    attempt: Number(match[1]),
    resume: match[2] ? Number(match[2]) : 1,
  };
}

export function verifierContextReferenceCoordinates(
  ref: ArtifactRefV1,
  expected?: { workItemId: string; phase: VerifierContextV1["phase"]; attempt: number },
): { workItemId: string; phase: VerifierContextV1["phase"]; attempt: number } {
  const reference = artifactRefV1Schema.parse(ref);
  if (!verifierPathPattern.test(reference.path)) throw new Error("Role-context path does not match verifier");
  const coordinates = { workItemId: pathWorkItemId(reference.path), ...verifierPathCoordinates(reference.path) };
  positiveInteger(coordinates.attempt, "Verifier attempt");
  if (reference.path !== verifierContextPath(coordinates.workItemId, coordinates.phase, coordinates.attempt, coordinates.resume)) {
    throw new Error("Verifier role-context path is not canonical");
  }
  if (expected) {
    if (coordinates.workItemId !== expected.workItemId) throw new Error("Verifier role-context path does not match its work item");
    if (coordinates.phase !== expected.phase) throw new Error("Verifier role-context path does not match its phase");
    if (coordinates.attempt !== expected.attempt) throw new Error("Verifier role-context path does not match its attempt");
  }
  return coordinates;
}

export async function validateVerifierInvocationContext(
  input: ValidateVerifierInvocationContextInput,
): Promise<{ context_ref: ArtifactRefV1; context: VerifierContextV1 }> {
  const reference = artifactRefV1Schema.parse(input.contextRef);
  const suppliedContext = verifierContextV1Schema.parse(input.context);
  verifierContextReferenceCoordinates(reference, {
    workItemId: input.workItem.id,
    phase: input.phase,
    attempt: input.attempt,
  });
  const loadedContext = await loadRoleContext(input.runDir, reference, "verifier");
  if (!equalJson(loadedContext, suppliedContext)) {
    throw new Error("Supplied Verifier context does not match its immutable authoritative artifact");
  }
  const manifest = await readManifestV2(input.runDir);
  const planRevision = manifest.approved_revision;
  if (planRevision === null || manifest.current_plan_revision !== planRevision) {
    throw new Error("Verifier context requires the current approved plan revision");
  }
  const authority = await canonicalWorkItem(input.runDir, executionSpecV2Schema.parse(input.workItem), planRevision);
  if (!equalJson(loadedContext.acceptance_contract, authority.workItem.acceptance)) {
    throw new Error("Verifier acceptance contract does not match current approved-plan authority");
  }
  if (loadedContext.phase !== input.phase) throw new Error("Verifier context phase does not match the invocation");
  return { context_ref: reference, context: loadedContext };
}

async function validateHandsAuthority(
  runDir: string,
  context: HandsContextV1,
  authority: CurrentPlanAuthority,
  attempt: number,
): Promise<void> {
  const summaryOmissions = context.omitted_evidence
    .filter(({ ref }) => ref.path.startsWith("summaries/work-items/"))
    .map(({ ref }) => ref);
  const evidenceOmissions = context.omitted_evidence
    .filter(({ ref }) => !ref.path.startsWith("summaries/work-items/"))
    .map(({ ref }) => ref);
  const includedSummaryRefs = context.dependency_summaries.map(summaryRef);
  const expectedSummaries = await currentDependencyCandidates(runDir, authority);
  assertOrderedPartition(
    expectedSummaries.map(({ ref }) => ref),
    includedSummaryRefs,
    summaryOmissions,
    "Hands dependency summaries",
  );
  const verification = await currentWorkItemVerificationAuthority(
    runDir,
    authority.manifest,
    authority.workItem.id,
    authority.workItem.id === "integrated" && attempt > 1 ? attempt - 1 : undefined,
  );
  const expectedEvidence = (await verificationContextCandidates(
    runDir,
    verification?.ref ?? null,
    verification?.identity ?? null,
    false,
  ))
    .map((candidate) => ({ ...candidate, target: "bounded_evidence" }));
  assertEvidencePartition(
    expectedEvidence,
    { bounded_evidence: context.bounded_evidence },
    evidenceOmissions,
  );
  const selectedKeys = new Set([
    ...includedSummaryRefs,
    ...context.bounded_evidence.map(({ ref }) => ref),
  ].map(refKey));
  assertOrderedRefs(
    [...expectedSummaries, ...expectedEvidence].sort(compareCandidates)
      .filter(({ ref }) => !selectedKeys.has(refKey(ref)))
      .map(({ ref }) => ref),
    context.omitted_evidence.map(({ ref }) => ref),
    "Hands omitted evidence",
  );
  const activeFindings = await activeFindingsFor(runDir, authority.manifest, [authority.workItem.id]);
  if (!matchesFullOrCompactedFindings(context.active_findings, activeFindings)) {
    throw new Error("Hands active findings are not current finding authority");
  }
}

async function validateReflectionAuthority(runDir: string, context: ReflectionContextV1): Promise<void> {
  const embedded = evidenceIndexV1Schema.parse(context.evidence_index);
  if (embedded.phase !== "reflection") throw new Error("Reflection context requires a reflection evidence index");
  const indexRef = artifactRefFromBytes(
    reflectionEvidenceIndexPath,
    await readOwnedRunFile(runDir, reflectionEvidenceIndexPath),
  );
  const authoritative = await loadEvidenceIndex(runDir, indexRef, {
    phase: "reflection",
    attempt: embedded.attempt,
    candidateCommit: embedded.candidate_commit,
  });
  if (!equalJson(embedded, authoritative)) {
    throw new Error("Embedded reflection evidence index is not current authority");
  }
  const selectedRefs = context.work_item_summaries.map(summaryRef);
  const omittedRefs = context.omitted_evidence.map(({ ref }) => ref);
  assertOrderedPartition(authoritative.work_item_summary_refs, selectedRefs, omittedRefs, "Reflection summaries");
  await Promise.all([...selectedRefs, ...omittedRefs].map((ref) => loadAuthoritativeSummary(runDir, ref)));
  const manifest = await readManifestV2(runDir);
  const workItemIds = [...new Set(Object.values(manifest.finding_index ?? {}).map((finding) => finding.work_item_id))];
  const activeFindings = await activeFindingsFor(runDir, manifest, workItemIds);
  if (!equalJson(context.active_findings, activeFindings)) {
    throw new Error("Reflection active findings are not current finding authority");
  }
}

async function validateVerifierAuthority(
  runDir: string,
  context: VerifierContextV1,
  attempt: number,
): Promise<void> {
  const indexAuthority = await validateVerifierEvidenceIndex(runDir, context.phase, attempt, context.evidence_index_ref);
  const manifest = await readManifestV2(runDir);
  const source = context.phase === "work_item"
    ? await currentWorkItemVerificationAuthority(runDir, manifest, context.work_item_id, attempt)
    : {
        ref: indexAuthority.index!.integrated_verification_ref,
        identity: { scope: "integrated", work_item_id: "integrated" } as const,
      };
  if (source === null) {
    throw new Error(`Work-item Verifier context requires current verification authority for ${context.work_item_id}`);
  }
  if (!equalJson(context.verification_ref, source.ref)) {
    throw new Error("Verifier context verification reference is not current authority");
  }
  const expected = await verificationContextCandidates(runDir, source.ref, source.identity, false);
  assertEvidencePartition(
    expected,
    {
      command_evidence: context.command_evidence,
      artifact_checks: context.artifact_checks,
      browser_evidence: context.browser_evidence,
    },
    context.omitted_evidence.map(({ ref }) => ref),
  );
  const activeFindings = await activeFindingsFor(
    runDir,
    manifest,
    context.phase === "work_item"
      ? [context.work_item_id]
      : [...new Set(Object.values(manifest.finding_index ?? {}).map((finding) => finding.work_item_id))],
  );
  if (!equalJson(context.active_findings, activeFindings)) {
    throw new Error("Verifier active findings are not current finding authority");
  }
}

export async function loadRoleContext(runDir: string, ref: ArtifactRefV1, expectedRole: "hands"): Promise<HandsContextV1>;
export async function loadRoleContext(
  runDir: string,
  ref: ArtifactRefV1,
  expectedRole: "verifier",
): Promise<VerifierContextV1>;
export async function loadRoleContext(
  runDir: string,
  ref: ArtifactRefV1,
  expectedRole: "reflection",
): Promise<ReflectionContextV1>;
export async function loadRoleContext(
  runDir: string,
  ref: ArtifactRefV1,
  expectedRole: "hands" | "verifier" | "reflection",
): Promise<HandsContextV1 | VerifierContextV1 | ReflectionContextV1> {
  return withRunLedgerTransaction(runDir, () => loadRoleContextLocked(runDir, ref, expectedRole));
}

async function loadRoleContextLocked(
  runDir: string,
  ref: ArtifactRefV1,
  expectedRole: "hands" | "verifier" | "reflection",
): Promise<HandsContextV1 | VerifierContextV1 | ReflectionContextV1> {
  const reference = artifactRefV1Schema.parse(ref);
  const validPath = expectedRole === "hands"
    ? handsPathPattern.test(reference.path)
    : expectedRole === "verifier"
      ? verifierPathPattern.test(reference.path)
      : reference.path === reflectionContextPath;
  if (!validPath) throw new Error(`Role-context path does not match ${expectedRole}`);
  if (expectedRole === "hands") {
    const coordinates = handsContextReferenceCoordinates(reference);
    const context = await readReferencedJson(runDir, reference, handsContextV1Schema);
    assertNoForbiddenKeys(context, "hands");
    const contextWorkItem = executionSpecV2Schema.parse(context.work_item);
    const authority = await canonicalWorkItemById(runDir, contextWorkItem.id, coordinates.planRevision);
    const { workItem } = authority;
    if (!matchesFullOrCompactedWorkItem(contextWorkItem, workItem)) {
      throw new Error("Hands work item does not match the current approved plan");
    }
    if (workItem.id !== coordinates.workItemId) {
      throw new Error("Hands role-context path does not match its work item");
    }
    if (Buffer.byteLength(context.diff, "utf8") > CONTEXT_LIMITS_V1.hands_diff_bytes) {
      throw new Error(`Hands diff exceeds ${CONTEXT_LIMITS_V1.hands_diff_bytes} UTF-8 bytes`);
    }
    if (serializedArrayBytes(context.bounded_evidence) > CONTEXT_LIMITS_V1.hands_evidence_bytes) {
      throw new Error(`Hands evidence exceeds ${CONTEXT_LIMITS_V1.hands_evidence_bytes} UTF-8 bytes`);
    }
    if (canonicalJsonBytes(handsContextV1Schema, context).byteLength > CONTEXT_LIMITS_V1.hands_total_bytes) {
      throw new Error(`Hands context exceeds ${CONTEXT_LIMITS_V1.hands_total_bytes} UTF-8 bytes`);
    }
    await validateHandsAuthority(runDir, context, authority, coordinates.attempt);
    return context;
  }
  if (expectedRole === "verifier") {
    const context = await readReferencedJson(runDir, reference, verifierContextV1Schema);
    assertNoForbiddenKeys(context, "verifier");
    if (context.work_item_id !== pathWorkItemId(reference.path)) {
      throw new Error("Verifier role-context path does not match its work item");
    }
    const coordinates = verifierPathCoordinates(reference.path);
    if (context.phase !== coordinates.phase) {
      throw new Error("Verifier role-context path does not match its phase");
    }
    if (Buffer.byteLength(context.diff, "utf8") > CONTEXT_LIMITS_V1.verifier_diff_bytes) {
      throw new Error(`Verifier diff exceeds ${CONTEXT_LIMITS_V1.verifier_diff_bytes} UTF-8 bytes`);
    }
    if (canonicalJsonBytes(verifierContextV1Schema, context).byteLength > CONTEXT_LIMITS_V1.verifier_total_bytes) {
      throw new Error(`Verifier context exceeds ${CONTEXT_LIMITS_V1.verifier_total_bytes} UTF-8 bytes`);
    }
    await validateVerifierAuthority(runDir, context, coordinates.attempt);
    return context;
  }
  const context = await readReferencedJson(runDir, reference, reflectionContextV1Schema);
  assertNoForbiddenKeys(context, "reflection");
  if (canonicalJsonBytes(reflectionContextV1Schema, context).byteLength > CONTEXT_LIMITS_V1.reflection_total_bytes) {
    throw new Error(`Reflection context exceeds ${CONTEXT_LIMITS_V1.reflection_total_bytes} UTF-8 bytes`);
  }
  await validateReflectionAuthority(runDir, context);
  return context;
}
