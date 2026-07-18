import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  artifactRefFromBytes,
  artifactRefV1Schema,
  artifactSegment,
  canonicalJsonBytes,
  evidenceIndexV1Schema,
  handsContextV1Schema,
  reflectionContextV1Schema,
  sha256Bytes,
  verifierContextV1Schema,
  workItemSummaryV1Schema,
} from "../../src/core/context-contracts.js";

const ref = (path: string, sha256 = "a".repeat(64)) => ({ path, sha256 });

const indexBase = {
  schema_version: 1 as const,
  run_id: "run-1",
  attempt: 1,
  approved_plan_ref: ref("plans/revision-1/approved.json"),
  candidate_commit: "b".repeat(40),
  work_item_summary_refs: [ref("summaries/item-1/revision-1/attempt-1.json")],
  integrated_verification_ref: ref("verification/integrated/attempt-1/evidence.json"),
  unresolved_finding_refs: [ref("findings/item-1/finding-1/revision-1.json")],
  created_at: "2026-07-16T12:00:00.000Z",
};

describe("bounded context contracts", () => {
  it("rejects unknown fields at strict contract boundaries", () => {
    expect(artifactRefV1Schema.safeParse({ ...ref("evidence.json"), extra: true }).success).toBe(false);

    const summary = workItemSummaryV1Schema.parse({
      schema_version: 1,
      run_id: "run-1",
      work_item_id: "item-1",
      plan_revision: 1,
      plan_sha256: "a".repeat(64),
      attempt: 1,
      base_commit: "b".repeat(40),
      commit_sha: "c".repeat(40),
      completion_basis: "verifier_approve",
      implementation_ref: ref("implementation/item-1/attempt-1/result.json"),
      verification_ref: ref("verification/local/item-1/attempt-1/evidence.json"),
      review_ref: ref("reviews/item-1/attempt-1.json"),
      policy_decision_ref: null,
      changed_files: ["src/a.ts"],
      acceptance_ids: ["AC-1"],
      command_evidence: [{
        command_id: "test",
        argv: ["npm", "test"],
        exit_code: 0,
        timed_out: false,
        result_ref: ref("verification/local/item-1/attempt-1/commands/test.json"),
      }],
      resolved_finding_ids: [],
      unresolved_finding_ids: [],
      residual_risks: [],
      created_at: "2026-07-16T12:00:00.000Z",
    });

    expect(workItemSummaryV1Schema.safeParse({ ...summary, extra: true }).success).toBe(false);
    expect(workItemSummaryV1Schema.safeParse({
      ...summary,
      command_evidence: [{ ...summary.command_evidence[0], extra: true }],
    }).success).toBe(false);
  });

  it("measures canonical JSON as UTF-8 bytes", () => {
    const schema = z.object({ label: z.string() }).strict();
    const value = { label: "café" };
    const bytes = canonicalJsonBytes(schema, value);
    const text = `${JSON.stringify(value, null, 2)}\n`;

    expect(bytes.byteLength).toBe(Buffer.byteLength(text, "utf8"));
    expect(bytes.byteLength).toBeGreaterThan(text.length);
  });

  it("hashes exact canonical bytes", () => {
    const bytes = canonicalJsonBytes(artifactRefV1Schema, {
      path: "verification/local/a/attempt-1/evidence.json",
      sha256: "a".repeat(64),
    });
    expect(bytes.at(-1)).toBe(10);
    expect(sha256Bytes(bytes)).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(artifactRefFromBytes("evidence.json", bytes)).toEqual({
      path: "evidence.json",
      sha256: sha256Bytes(bytes),
    });
  });

  it("keeps unsafe identities distinct", () => {
    expect(artifactSegment("a/b")).not.toBe(artifactSegment("a_b"));
    expect(artifactSegment("a/b")).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("rejects malformed Unicode identities instead of collapsing lone surrogates", () => {
    expect(() => artifactSegment("\uD800")).toThrow("Artifact identity must be well-formed Unicode");
    expect(() => artifactSegment("\uDC00")).toThrow("Artifact identity must be well-formed Unicode");
    expect(artifactSegment("\uFFFD")).toBe(Buffer.from("\uFFFD", "utf8").toString("base64url"));
    expect(artifactSegment("😀")).toBe(Buffer.from("😀", "utf8").toString("base64url"));
  });

  it.each(["final_integrated", "post_pr"] as const)(
    "accepts the %s evidence-index phase without terminal evidence",
    (phase) => {
      const parsed = evidenceIndexV1Schema.parse({
        ...indexBase,
        phase,
        final_review_ref: null,
        terminal: null,
      });

      expect(parsed.phase).toBe(phase);
      expect(evidenceIndexV1Schema.safeParse({
        ...parsed,
        final_review_ref: ref("reviews/integrated/final-attempt-1.json"),
      }).success).toBe(false);
    },
  );

  it("requires terminal review and assurance only for reflection indexes", () => {
    const parsed = evidenceIndexV1Schema.parse({
      ...indexBase,
      phase: "reflection",
      final_review_ref: ref("reviews/integrated/final-attempt-1.json"),
      terminal: {
        outcome: "delivered",
        actor: "runtime",
        reason: "All gates passed.",
        recorded_at: "2026-07-16T12:00:00.000Z",
        source_stage: "delivery",
        residual_risks: [],
      },
      assurance: {
        outcome: "verified_ready",
        assessment_ref: ref("assurance/assessment.json"),
      },
    });

    expect(parsed.phase).toBe("reflection");
    expect(evidenceIndexV1Schema.safeParse({ ...parsed, terminal: null }).success).toBe(false);
    expect(evidenceIndexV1Schema.safeParse({ ...parsed, final_review_ref: null }).success).toBe(false);
  });

  it("keeps role payloads structurally separate", () => {
    const hands = {
      schema_version: 1,
      role: "hands",
      work_item: { id: "item-1" },
      diff: "diff --git a/src/a.ts b/src/a.ts",
      active_findings: [],
      dependency_summaries: [],
      bounded_evidence: [],
      omitted_evidence: [],
    };
    expect(handsContextV1Schema.safeParse({ ...hands, run_history: [] }).success).toBe(false);

    const verifier = {
      schema_version: 1,
      role: "verifier",
      phase: "work_item",
      work_item_id: "item-1",
      acceptance_contract: [],
      changed_files: ["src/a.ts"],
      diff: "diff --git a/src/a.ts b/src/a.ts",
      verification_ref: ref("verification/local/item-1/attempt-1/evidence.json"),
      command_evidence: [],
      artifact_checks: [],
      browser_evidence: [],
      active_findings: [],
      evidence_index_ref: null,
      omitted_evidence: [],
    };
    expect(verifierContextV1Schema.safeParse({ ...verifier, artifacts_context: {} }).success).toBe(false);

    const reflection = {
      schema_version: 1,
      role: "reflection",
      evidence_index: { ...indexBase, phase: "reflection" },
      work_item_summaries: [],
      active_findings: [],
      process_metrics: {},
      omitted_evidence: [],
    };
    expect(reflectionContextV1Schema.safeParse({ ...reflection, run_history: [] }).success).toBe(false);
  });

  it("requires strict role-byte-limit omission records", () => {
    const hands = {
      schema_version: 1,
      role: "hands",
      work_item: { id: "item-1" },
      diff: "",
      active_findings: [],
      dependency_summaries: [],
      bounded_evidence: [],
      omitted_evidence: [{ ref: ref("verification/source.json"), reason: "role_byte_limit" }],
    };
    expect(handsContextV1Schema.safeParse(hands).success).toBe(true);
    expect(handsContextV1Schema.safeParse({
      ...hands,
      omitted_evidence: [{ ref: ref("verification/source.json"), reason: "other" }],
    }).success).toBe(false);
    expect(handsContextV1Schema.safeParse({
      ...hands,
      omitted_evidence: [{ ref: ref("verification/source.json"), reason: "role_byte_limit", extra: true }],
    }).success).toBe(false);
    expect(handsContextV1Schema.safeParse({
      ...hands,
      bounded_evidence: [{ value: { result: "passed" } }],
    }).success).toBe(false);
    expect(handsContextV1Schema.safeParse({
      ...hands,
      bounded_evidence: [{ ref: ref("verification/source.json"), value: {}, extra: true }],
    }).success).toBe(false);
  });
});
