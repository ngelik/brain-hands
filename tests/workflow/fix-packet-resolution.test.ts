import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CodexAdapter, CodexInvokeInput } from "../../src/adapters/codex.js";
import { createRunLedgerV2 } from "../../src/core/ledger.js";
import { fixPacketResolutionV1Schema, hashReviewFixPacket, type ReviewFixPacketV1 } from "../../src/core/review-fix-packet.js";
import type { ResolvedRunIntake } from "../../src/core/types.js";
import { verifyReviewFixPacket } from "../../src/workflow/action-verifier.js";
import { reviewFixPacketRoot } from "../../src/workflow/fix-packets.js";
const codexMetrics = { usage: null, durationMs: 0, processStarted: false, turnStarted: false, structuredTerminalError: false } as const;

const packet = {
  schema_version: 1, provenance: { packet_id: "R1-A1", finding_id: "finding:abc", action_id: "R1-A1", review_revision: 1, work_item_id: "item-1", criterion_ref: "item-1-AC-01", approved_plan_sha256: "a".repeat(64) },
  diagnosis: { problem_class: "correctness", severity: "medium", observed_behavior: "Wrong", expected_behavior: "Right", failure_mechanism: "Missing", reproduction: ["Run test"], evidence_refs: ["verification/evidence.json"] },
  targets: [{ kind: "code", path: "src/item-1.ts", symbol: "implementation", line_hint: null }],
  remediation: { strategy: "Fix", change_units: [{ id: "FIX-1", path: "src/item-1.ts", target: "implementation", operation: "modify", requirements: ["Make right."], satisfies: ["SC-1"] }], allowed_files: ["src/item-1.ts"], forbidden_changes: [] },
  verification: { commands: [{ id: "CMD-1", argv: ["npm", "test"] }], success_conditions: [{ id: "SC-1", statement: "Right", satisfied_by: ["CMD-1", "EVID-1"] }], required_evidence: [{ id: "EVID-1", kind: "test_result", source_id: "CMD-1", output_path: "verification/result.json" }] },
  completion_contract: { required_change_unit_ids: ["FIX-1"], expected_changed_files: ["src/item-1.ts"], allow_additional_files: false },
} as ReviewFixPacketV1;
const resolution = { packet_id: "R1-A1", packet_sha256: hashReviewFixPacket(packet), action_attempt: 1, decision: "resolved", condition_results: [{ success_condition_id: "SC-1", status: "satisfied", evidence_refs: ["verification/result.json"], remaining_problem: null }], required_next_fix: null, blocker: null } as const;
const verificationEvidence = {
  verification_scope: "local" as const, work_item_id: "item-1", attempt: 1,
  evidence_path: "verification/evidence.json",
  commands: [{ command: "npm test", argv: ["npm", "test"], exit_code: 0, timed_out: false, error_code: null, error_message: null, signal: null, stdout_path: "verification/stdout.txt", stderr_path: "verification/stderr.txt", result_path: "verification/result.json" }],
  artifacts: [], artifact_checks: [], browser_evidence: [], created_at: new Date().toISOString(),
};
const intake = { roles: { verifier: { model: "verifier", reasoning_effort: "high", sandbox: "read-only" } } } as ResolvedRunIntake;
class RecordingVerifier implements CodexAdapter {
  calls: CodexInvokeInput[] = [];
  async invoke(input: CodexInvokeInput) { this.calls.push(input); return { text: JSON.stringify(resolution), parsed: resolution, exitCode: 0, promptPath: "prompt", stdoutPath: "stdout", stderrPath: "stderr", ...codexMetrics }; }
}
let root: string | undefined;
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = undefined; });

describe("verifyReviewFixPacket", () => {
  it("requires exactly one result for every packet success condition", () => {
    expect(fixPacketResolutionV1Schema.safeParse(resolution).success).toBe(true);
    expect(fixPacketResolutionV1Schema.safeParse({ ...resolution, condition_results: [] }).success).toBe(false);
    expect(fixPacketResolutionV1Schema.safeParse({ ...resolution, condition_results: [{ ...resolution.condition_results[0], evidence_refs: [] }] }).success).toBe(false);
    expect(fixPacketResolutionV1Schema.safeParse({ ...resolution, decision: "still_open", required_next_fix: "Fix it", condition_results: [{ ...resolution.condition_results[0], status: "unsatisfied", remaining_problem: null }] }).success).toBe(false);
  });

  it("persists a packet-scoped focused resolution", async () => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-packet-resolution-"));
    const ledger = await createRunLedgerV2({ repoRoot: root, originalRequest: "fix" });
    const codex = new RecordingVerifier();
    const output = await verifyReviewFixPacket({ runDir: ledger.runDir, worktreePath: root, packet, actionAttempt: 1, intake, codex, beforeDiff: "before", afterDiff: "after", verificationEvidence, selfReviewReports: [] });
    expect(output.review).toEqual(resolution);
    expect(output.reviewPath).toBe(`${reviewFixPacketRoot("R1-A1")}/attempts/1/focused-resolution.json`);
    expect(await readFile(join(ledger.runDir, output.reviewPath), "utf8")).toContain('"decision": "resolved"');
    expect(codex.calls[0]).toMatchObject({ role: "verifier", sandbox: "read-only" });
    const replay = await verifyReviewFixPacket({ runDir: ledger.runDir, worktreePath: root, packet, actionAttempt: 1, intake, codex: { invoke: async () => { throw new Error("must not reinvoke"); } }, beforeDiff: "before", afterDiff: "after", verificationEvidence, selfReviewReports: [] });
    expect(replay.review).toEqual(resolution);
  });

  it("rejects condition evidence that is not declared by the packet", async () => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-packet-resolution-"));
    const ledger = await createRunLedgerV2({ repoRoot: root, originalRequest: "fix" });
    const invalid = { ...resolution, condition_results: [{ ...resolution.condition_results[0], evidence_refs: ["verification/unknown.json"] }] };
    await expect(verifyReviewFixPacket({ runDir: ledger.runDir, worktreePath: root, packet, actionAttempt: 1, intake, codex: { invoke: async () => ({ text: JSON.stringify(invalid), parsed: invalid, exitCode: 0, promptPath: "p", stdoutPath: "o", stderrPath: "e", ...codexMetrics }) }, beforeDiff: "before", afterDiff: "after", verificationEvidence, selfReviewReports: [] })).rejects.toThrow(/observed evidence/i);
  });

  it("rejects a satisfied condition when its linked command failed", async () => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-packet-resolution-"));
    const ledger = await createRunLedgerV2({ repoRoot: root, originalRequest: "fix" });
    const failedEvidence = { ...verificationEvidence, commands: verificationEvidence.commands.map((command) => ({ ...command, exit_code: 1 })) };
    await expect(verifyReviewFixPacket({ runDir: ledger.runDir, worktreePath: root, packet, actionAttempt: 1, intake, codex: new RecordingVerifier(), beforeDiff: "before", afterDiff: "after", verificationEvidence: failedEvidence, selfReviewReports: [] })).rejects.toThrow(/passing observed evidence/i);
  });
});
