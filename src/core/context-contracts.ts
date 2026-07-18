import { createHash } from "node:crypto";
import { z } from "zod";
import {
  artifactPathSchema,
  assuranceOutcomeSchema,
  terminalDispositionSchema,
  verificationArtifactCheckSchema,
  verificationBrowserEvidenceSchema,
  verificationCommandResultSchema,
} from "./schema.js";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const gitObjectIdSchema = z.string().regex(/^[a-f0-9]{40,64}$/);
const jsonValueSchema = z.json();

export const artifactRefV1Schema = z.object({
  path: artifactPathSchema,
  sha256: sha256Schema,
}).strict();

export const omittedEvidenceV1Schema = z.object({
  ref: artifactRefV1Schema,
  reason: z.literal("role_byte_limit"),
}).strict();

export const selectedEvidenceV1Schema = z.object({
  ref: artifactRefV1Schema,
  value: jsonValueSchema,
}).strict();

const verificationContextFragmentBase = {
  schema_version: z.literal(1),
  source_verification_ref: artifactRefV1Schema,
  ordinal: z.number().int().nonnegative(),
};

export const verificationContextFragmentV1Schema = z.discriminatedUnion("kind", [
  z.object({
    ...verificationContextFragmentBase,
    kind: z.literal("command_evidence"),
    value: verificationCommandResultSchema,
  }).strict(),
  z.object({
    ...verificationContextFragmentBase,
    kind: z.literal("artifact_check"),
    value: verificationArtifactCheckSchema,
  }).strict(),
  z.object({
    ...verificationContextFragmentBase,
    kind: z.literal("browser_evidence"),
    value: verificationBrowserEvidenceSchema,
  }).strict(),
]);

export const workItemSummaryV1Schema = z.object({
  schema_version: z.literal(1),
  run_id: z.string().min(1),
  work_item_id: z.string().min(1),
  plan_revision: z.number().int().positive(),
  plan_sha256: sha256Schema,
  attempt: z.number().int().positive(),
  base_commit: gitObjectIdSchema,
  commit_sha: z.union([gitObjectIdSchema, z.literal("no-op")]),
  completion_basis: z.enum(["verifier_approve", "policy_advance", "policy_warning_continuation"]),
  implementation_ref: artifactRefV1Schema,
  verification_ref: artifactRefV1Schema,
  review_ref: artifactRefV1Schema,
  policy_decision_ref: artifactRefV1Schema.nullable(),
  changed_files: z.array(artifactPathSchema),
  acceptance_ids: z.array(z.string().min(1)),
  command_evidence: z.array(z.object({
    command_id: z.string().min(1),
    argv: z.array(z.string()).min(1),
    exit_code: z.number().int().nullable(),
    timed_out: z.boolean(),
    result_ref: artifactRefV1Schema,
  }).strict()),
  resolved_finding_ids: z.array(z.string().min(1)),
  unresolved_finding_ids: z.array(z.string().min(1)),
  residual_risks: z.array(z.string().min(1)),
  created_at: z.string().datetime(),
}).strict();

const evidenceIndexCommonShape = {
  schema_version: z.literal(1),
  run_id: z.string().min(1),
  attempt: z.number().int().positive(),
  approved_plan_ref: artifactRefV1Schema,
  candidate_commit: gitObjectIdSchema,
  work_item_summary_refs: z.array(artifactRefV1Schema),
  integrated_verification_ref: artifactRefV1Schema,
  unresolved_finding_refs: z.array(artifactRefV1Schema),
  created_at: z.string().datetime(),
};

const verifierEvidenceIndexV1Schema = z.object({
  ...evidenceIndexCommonShape,
  phase: z.enum(["final_integrated", "post_pr"]),
  final_review_ref: z.null(),
  terminal: z.null(),
}).strict();

const reflectionEvidenceIndexV1Schema = z.object({
  ...evidenceIndexCommonShape,
  phase: z.literal("reflection"),
  final_review_ref: artifactRefV1Schema,
  terminal: terminalDispositionSchema,
  assurance: z.object({
    outcome: assuranceOutcomeSchema,
    assessment_ref: artifactRefV1Schema.nullable(),
  }).strict(),
}).strict();

export const evidenceIndexV1Schema = z.discriminatedUnion("phase", [
  verifierEvidenceIndexV1Schema,
  reflectionEvidenceIndexV1Schema,
]);

export const handsContextV1Schema = z.object({
  schema_version: z.literal(1),
  role: z.literal("hands"),
  work_item: jsonValueSchema,
  diff: z.string(),
  active_findings: z.array(jsonValueSchema),
  dependency_summaries: z.array(workItemSummaryV1Schema),
  bounded_evidence: z.array(selectedEvidenceV1Schema),
  omitted_evidence: z.array(omittedEvidenceV1Schema),
}).strict();

export const verifierContextV1Schema = z.object({
  schema_version: z.literal(1),
  role: z.literal("verifier"),
  phase: z.enum(["work_item", "final_integrated", "post_pr"]),
  work_item_id: z.string().min(1),
  acceptance_contract: z.array(jsonValueSchema),
  changed_files: z.array(artifactPathSchema),
  diff: z.string(),
  verification_ref: artifactRefV1Schema,
  command_evidence: z.array(selectedEvidenceV1Schema),
  artifact_checks: z.array(selectedEvidenceV1Schema),
  browser_evidence: z.array(selectedEvidenceV1Schema),
  active_findings: z.array(jsonValueSchema),
  evidence_index_ref: artifactRefV1Schema.nullable(),
  omitted_evidence: z.array(omittedEvidenceV1Schema),
}).strict();

export const reflectionContextV1Schema = z.object({
  schema_version: z.literal(1),
  role: z.literal("reflection"),
  evidence_index: jsonValueSchema,
  work_item_summaries: z.array(workItemSummaryV1Schema),
  active_findings: z.array(jsonValueSchema),
  process_metrics: jsonValueSchema,
  omitted_evidence: z.array(omittedEvidenceV1Schema),
}).strict();

export type ArtifactRefV1 = z.infer<typeof artifactRefV1Schema>;
export type OmittedEvidenceV1 = z.infer<typeof omittedEvidenceV1Schema>;
export type SelectedEvidenceV1 = z.infer<typeof selectedEvidenceV1Schema>;
export type VerificationContextFragmentV1 = z.infer<typeof verificationContextFragmentV1Schema>;
export type WorkItemSummaryV1 = z.infer<typeof workItemSummaryV1Schema>;
export type EvidenceIndexV1 = z.infer<typeof evidenceIndexV1Schema>;
export type HandsContextV1 = z.infer<typeof handsContextV1Schema>;
export type VerifierContextV1 = z.infer<typeof verifierContextV1Schema>;
export type ReflectionContextV1 = z.infer<typeof reflectionContextV1Schema>;

export function canonicalJsonBytes<T>(schema: z.ZodType<T>, value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(schema.parse(value), null, 2)}\n`, "utf8");
}

export function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function artifactRefFromBytes(path: string, bytes: Uint8Array): ArtifactRefV1 {
  return artifactRefV1Schema.parse({ path, sha256: sha256Bytes(bytes) });
}

export function artifactSegment(identity: string): string {
  for (let index = 0; index < identity.length; index += 1) {
    const codeUnit = identity.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = identity.charCodeAt(index + 1);
      if (index + 1 >= identity.length || nextCodeUnit < 0xdc00 || nextCodeUnit > 0xdfff) {
        throw new Error("Artifact identity must be well-formed Unicode");
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new Error("Artifact identity must be well-formed Unicode");
    }
  }
  return Buffer.from(identity, "utf8").toString("base64url");
}
