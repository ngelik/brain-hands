import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CodexAdapter } from "../../src/adapters/codex.js";
import type { VerifierRemediationClaimV1 } from "../../src/core/review-fix-packet.js";
import { executionSpec } from "../fixtures/execution-spec.js";
import { assertFixPacketChangedFiles, assertFixPacketCorrectionAvailable, classifyFixPacketCompilationFailure, compileReviewFixPacket, correctVerifierRemediationClaim, FixPacketRequiresReplanError, loadReviewFixPacket, persistFixAttemptSupplement, persistReviewFixPacket, reviewFixPacketCorrectionAuthority, reviewFixPacketRoot } from "../../src/workflow/fix-packets.js";
const codexMetrics = { usage: null, durationMs: 0, processStarted: false, turnStarted: false, structuredTerminalError: false } as const;

let root: string | undefined;
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = undefined; });

function validClaimFor(workItem: ReturnType<typeof executionSpec>): VerifierRemediationClaimV1 {
  return {
    schema_version: 1,
    diagnosis: { observed_behavior: "Wrong", expected_behavior: "Right", failure_mechanism: "Missing change", reproduction: ["Run test"], evidence_refs: ["verification/evidence.json"] },
    targets: [{ kind: "code", path: workItem.file_contract[0]!.path, symbol: workItem.file_contract[0]!.targets[0]!, line_hint: null }],
    remediation: { strategy: "Fix it", change_units: [{ id: "FIX-1", path: workItem.file_contract[0]!.path, target: workItem.file_contract[0]!.targets[0]!, operation: "modify", requirements: ["Make behavior right."], satisfies: ["SC-1"] }], allowed_files: [workItem.file_contract[0]!.path], forbidden_changes: [] },
    verification: { commands: [{ id: "CMD-1", argv: [...workItem.verification_commands[0]!.argv] }], success_conditions: [{ id: "SC-1", statement: "Behavior is right", satisfied_by: ["CMD-1", "EVID-1"] }], required_evidence: [{ id: "EVID-1", kind: "test_result", source_id: "CMD-1", output_path: "verification/result.json" }] },
    completion_contract: { required_change_unit_ids: ["FIX-1"], expected_changed_files: [workItem.file_contract[0]!.path], allow_additional_files: false },
  };
}

describe("fix packets", () => {
  it("derives trusted provenance and persists immutable canonical bytes", async () => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-packet-"));
    const workItem = executionSpec("item-1");
    const claim = {
      schema_version: 1 as const,
      diagnosis: { observed_behavior: "Wrong", expected_behavior: "Right", failure_mechanism: "Missing change", reproduction: ["Run test"], evidence_refs: ["verification/evidence.json"] },
      targets: [{ kind: "code" as const, path: workItem.file_contract[0]!.path, symbol: workItem.file_contract[0]!.targets[0]!, line_hint: null }],
      remediation: { strategy: "Fix it", change_units: [{ id: "FIX-1", path: workItem.file_contract[0]!.path, target: workItem.file_contract[0]!.targets[0]!, operation: workItem.file_contract[0]!.permission as "modify", requirements: ["Make behavior right."], satisfies: ["SC-1"] }], allowed_files: [workItem.file_contract[0]!.path], forbidden_changes: [] },
      verification: { commands: [{ id: "CMD-1", argv: [...workItem.verification_commands[0]!.argv] }], success_conditions: [{ id: "SC-1", statement: "Behavior is right", satisfied_by: ["CMD-1", "EVID-1"] }], required_evidence: [{ id: "EVID-1", kind: "test_result" as const, source_id: "CMD-1", output_path: "verification/result.json" }] },
      completion_contract: { required_change_unit_ids: ["FIX-1"], expected_changed_files: [workItem.file_contract[0]!.path], allow_additional_files: false as const },
    };
    const packet = compileReviewFixPacket({ claim, work_item: workItem, finding_id: "finding:abc", action_id: "R1-A1", review_revision: 1, criterion_ref: workItem.acceptance[0]!.id, severity: "medium", problem_class: "correctness", approved_plan_sha256: "a".repeat(64) });
    expect(packet.provenance).toMatchObject({ finding_id: "finding:abc", action_id: "R1-A1", work_item_id: "item-1" });
    const saved = await persistReviewFixPacket(root, packet);
    expect(await readFile(join(root, saved.path.replace(/packet\.json$/, "packet.sha256")), "utf8")).toBe(`${saved.sha256}\n`);
    expect(await loadReviewFixPacket(root, saved.path, saved.sha256)).toEqual(packet);
    const shaPath = join(root, saved.path.replace(/packet\.json$/, "packet.sha256"));
    await writeFile(shaPath, `${"b".repeat(64)}\n`, "utf8");
    await expect(loadReviewFixPacket(root, saved.path, saved.sha256)).rejects.toThrow(/sidecar/i);
    await expect(persistReviewFixPacket(root, packet)).rejects.toThrow(/sidecar/i);
    await expect(persistReviewFixPacket(root, { ...packet, diagnosis: { ...packet.diagnosis, observed_behavior: "Different" } })).rejects.toThrow(/conflict|exist/i);
  });

  it("maps a verifier-confused acceptance reference to the claim's success-condition IDs", () => {
    const workItem = executionSpec("item-1");
    const criterionRef = workItem.acceptance[0]!.id;
    const claim = validClaimFor(workItem);
    claim.remediation.change_units[0]!.satisfies = [criterionRef];
    const packet = compileReviewFixPacket({
      claim,
      work_item: workItem,
      finding_id: "finding:criterion-namespace",
      action_id: "R1-A1",
      review_revision: 1,
      criterion_ref: criterionRef,
      severity: "medium",
      problem_class: "correctness",
      approved_plan_sha256: "a".repeat(64),
    });
    expect(packet.remediation.change_units[0]!.satisfies).toEqual(["SC-1"]);
  });

  it("normalizes absolute command evidence destinations into the controller verification namespace", () => {
    const workItem = executionSpec("item-1");
    const claim = validClaimFor(workItem);
    claim.verification.required_evidence[0]!.output_path = "/private/tmp/invented-result.txt";

    const packet = compileReviewFixPacket({
      claim,
      work_item: workItem,
      finding_id: "finding:absolute-evidence",
      action_id: "R1-A1",
      review_revision: 1,
      criterion_ref: workItem.acceptance[0]!.id,
      severity: "medium",
      problem_class: "verification",
      approved_plan_sha256: "a".repeat(64),
    });

    expect(packet.verification.required_evidence[0]!.output_path)
      .toBe("verification/review-fix/EVID-1.json");
  });

  it("derives the completion boundary from change units instead of broader allowed outputs", () => {
    const workItem = executionSpec("item-1");
    workItem.file_contract.push({ path: "artifacts/result.png", permission: "create", targets: ["generated evidence"] });
    const claim = validClaimFor(workItem);
    claim.remediation.allowed_files.push("artifacts/result.png");
    claim.completion_contract.expected_changed_files.push("artifacts/result.png");
    const packet = compileReviewFixPacket({
      claim,
      work_item: workItem,
      finding_id: "finding:completion-boundary",
      action_id: "R1-A1",
      review_revision: 1,
      criterion_ref: workItem.acceptance[0]!.id,
      severity: "high",
      problem_class: "artifact",
      approved_plan_sha256: "a".repeat(64),
    });
    expect(packet.remediation.allowed_files).toEqual(["src/item-1.ts", "artifacts/result.png"]);
    expect(packet.completion_contract.expected_changed_files).toEqual(["src/item-1.ts"]);
    expect(packet.completion_contract.required_change_unit_ids).toEqual(["FIX-1"]);
  });

  it("persists immutable retry supplements and permits only one contract correction", async () => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-packet-"));
    const supplement = {
      packet_id: "R1-A1", base_packet_sha256: "a".repeat(64), next_attempt: 2,
      unsatisfied_condition_ids: ["SC-1"], remaining_problem: "The condition remains open.",
      required_next_fix: "Correct the persistence order.", additional_evidence_refs: ["verification/open.json"],
    };
    const path = await persistFixAttemptSupplement(root, supplement);
    expect(path).toBe(`${reviewFixPacketRoot("R1-A1")}/attempts/2/attempt-supplement.json`);
    await expect(persistFixAttemptSupplement(root, { ...supplement, remaining_problem: "Different" })).rejects.toThrow(/conflict/i);
    expect(() => assertFixPacketCorrectionAvailable(0)).not.toThrow();
    expect(() => assertFixPacketCorrectionAvailable(1)).toThrow(/invalid_verifier_contract/);
  });

  it("scopes bounded packet identity across work items while preserving legacy action IDs", async () => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-packet-identity-"));
    const compileFor = (id: string, packetIdentity?: "scoped") => {
      const workItem = executionSpec(id);
      return compileReviewFixPacket({
        claim: validClaimFor(workItem), work_item: workItem,
        finding_id: `finding:${id}`, action_id: "R1-A1", review_revision: 1,
        criterion_ref: workItem.acceptance[0]!.id, severity: "medium",
        problem_class: "correctness", approved_plan_sha256: "a".repeat(64),
        ...(packetIdentity ? { packet_identity: packetIdentity } : {}),
      } as Parameters<typeof compileReviewFixPacket>[0]);
    };
    expect(compileFor("legacy").provenance.packet_id).toBe("R1-A1");
    const first = compileFor("item-1", "scoped");
    const second = compileFor("item-2", "scoped");
    expect(first.provenance.packet_id).toMatch(/^review-fix-packet:[a-f0-9]{64}$/);
    expect(second.provenance.packet_id).toMatch(/^review-fix-packet:[a-f0-9]{64}$/);
    expect(second.provenance.packet_id).not.toBe(first.provenance.packet_id);
    const firstSaved = await persistReviewFixPacket(root, first);
    const secondSaved = await persistReviewFixPacket(root, second);
    expect(secondSaved.path).not.toBe(firstSaved.path);
    expect(reviewFixPacketRoot(second.provenance.packet_id)).not.toBe(reviewFixPacketRoot(first.provenance.packet_id));
  });

  it("uses the real diff file list as the completion boundary", () => {
    const expected = { completion_contract: { expected_changed_files: ["src/a.ts"], allow_additional_files: false } } as never;
    expect(() => assertFixPacketChangedFiles(expected, ["src/a.ts"])).not.toThrow();
    expect(() => assertFixPacketChangedFiles(expected, ["src/a.ts", "src/extra.ts"])).toThrow(/unexpected changed file src\/extra.ts/);
  });

  it("invokes the same Verifier at most once to correct an invalid claim and reuses its artifact", async () => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-packet-"));
    const workItem = executionSpec("item-1");
    const corrected = {
      schema_version: 1 as const,
      diagnosis: { observed_behavior: "Wrong", expected_behavior: "Right", failure_mechanism: "Missing", reproduction: ["Run test"], evidence_refs: ["verification/evidence.json"] },
      targets: [{ kind: "code" as const, path: "src/item-1.ts", symbol: "item-1 implementation", line_hint: null }],
      remediation: { strategy: "Fix", change_units: [{ id: "FIX-1", path: "src/item-1.ts", target: "item-1 implementation", operation: "modify" as const, requirements: ["Make right."], satisfies: ["SC-1"] }], allowed_files: ["src/item-1.ts"], forbidden_changes: [] },
      verification: { commands: [{ id: "CMD-1", argv: ["npm", "test", "--", "tests/item-1.test.ts"] }], success_conditions: [{ id: "SC-1", statement: "Right", satisfied_by: ["CMD-1", "EVID-1"] }], required_evidence: [{ id: "EVID-1", kind: "test_result" as const, source_id: "CMD-1", output_path: "verification/result.json" }] },
      completion_contract: { required_change_unit_ids: ["FIX-1"], expected_changed_files: ["src/item-1.ts"], allow_additional_files: false as const },
    };
    let calls = 0;
    let correctionPrompt = "";
    const codex: CodexAdapter = { invoke: async (invocation) => { calls += 1; correctionPrompt = invocation.prompt; return { text: JSON.stringify(corrected), parsed: corrected, exitCode: 0, promptPath: "prompt", stdoutPath: "stdout", stderrPath: "stderr", ...codexMetrics }; }  };
    const input = { runDir: root, worktreePath: root, actionId: "R1-A1", reviewRevision: 1, approvedPlanSha256: "a".repeat(64), claim: corrected, validationErrors: ["vague requirement"], workItem, verifierProfile: { model: "verifier", reasoning_effort: "high" as const }, codex };
    expect(await correctVerifierRemediationClaim(input)).toEqual(corrected);
    expect(await correctVerifierRemediationClaim({ ...input, codex: { invoke: async () => { throw new Error("must not reinvoke"); } } })).toEqual(corrected);
    expect(calls).toBe(1);
    expect(correctionPrompt).toContain("must exactly equal one `verification_commands[].argv` vector");
    expect(correctionPrompt).toContain("exact writable paths, operations, and target labels");
    expect(correctionPrompt).toContain("`remediation.change_units[].satisfies`");
    expect(correctionPrompt).toContain("reference the required-evidence `id`");
  });

  it("does not reuse R1-A1 correction authority across work items", async () => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-packet-collision-"));
    const itemOne = executionSpec("item-1");
    const itemTwo = executionSpec("item-2");
    const correctedFor = (id: string): VerifierRemediationClaimV1 => ({
      schema_version: 1,
      diagnosis: { observed_behavior: `${id} wrong`, expected_behavior: `${id} right`, failure_mechanism: "Missing", reproduction: ["Run"], evidence_refs: ["verification/evidence.json"] },
      targets: [{ kind: "code", path: `src/${id}.ts`, symbol: `${id} implementation`, line_hint: null }],
      remediation: { strategy: `Fix ${id}`, change_units: [{ id: "FIX-1", path: `src/${id}.ts`, target: `${id} implementation`, operation: "modify", requirements: ["Make right."], satisfies: ["SC-1"] }], allowed_files: [`src/${id}.ts`], forbidden_changes: [] },
      verification: { commands: [{ id: "CMD-1", argv: ["npm", "test", "--", `tests/${id}.test.ts`] }], success_conditions: [{ id: "SC-1", statement: "Right", satisfied_by: ["CMD-1", "EVID-1"] }], required_evidence: [{ id: "EVID-1", kind: "test_result", source_id: "CMD-1", output_path: "verification/result.json" }] },
      completion_contract: { required_change_unit_ids: ["FIX-1"], expected_changed_files: [`src/${id}.ts`], allow_additional_files: false },
    });
    let calls = 0;
    const invoke = (output: VerifierRemediationClaimV1): CodexAdapter => ({ invoke: async () => {
      calls += 1;
      return { text: JSON.stringify(output), parsed: output, exitCode: 0, promptPath: "prompt", stdoutPath: "stdout", stderrPath: "stderr" , ...codexMetrics };
    } });
    const common = { runDir: root, worktreePath: root, actionId: "R1-A1", reviewRevision: 1, approvedPlanSha256: "a".repeat(64), validationErrors: ["invalid"], verifierProfile: { model: "verifier", reasoning_effort: "high" as const } };
    const first = correctedFor("item-1");
    const second = correctedFor("item-2");
    expect(await correctVerifierRemediationClaim({ ...common, claim: first, workItem: itemOne, codex: invoke(first) })).toEqual(first);
    expect(await correctVerifierRemediationClaim({ ...common, claim: second, workItem: itemTwo, codex: invoke(second) })).toEqual(second);
    expect(calls).toBe(2);
  });

  it("does not reuse a correction when claim, plan, or validation errors change", async () => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-packet-bound-request-"));
    const workItem = executionSpec("item-1");
    const claim: VerifierRemediationClaimV1 = { schema_version: 1, diagnosis: { observed_behavior: "Wrong", expected_behavior: "Right", failure_mechanism: "Missing", reproduction: ["Run"], evidence_refs: ["verification/evidence.json"] }, targets: [{ kind: "code", path: "src/item-1.ts", symbol: "item-1 implementation", line_hint: null }], remediation: { strategy: "Fix", change_units: [{ id: "FIX-1", path: "src/item-1.ts", target: "item-1 implementation", operation: "modify", requirements: ["Make right."], satisfies: ["SC-1"] }], allowed_files: ["src/item-1.ts"], forbidden_changes: [] }, verification: { commands: [{ id: "CMD-1", argv: ["npm", "test", "--", "tests/item-1.test.ts"] }], success_conditions: [{ id: "SC-1", statement: "Right", satisfied_by: ["CMD-1", "EVID-1"] }], required_evidence: [{ id: "EVID-1", kind: "test_result", source_id: "CMD-1", output_path: "verification/result.json" }] }, completion_contract: { required_change_unit_ids: ["FIX-1"], expected_changed_files: ["src/item-1.ts"], allow_additional_files: false } };
    let calls = 0;
    const codex: CodexAdapter = { invoke: async () => { calls += 1; return { text: JSON.stringify(claim), parsed: claim, exitCode: 0, promptPath: "prompt", stdoutPath: "stdout", stderrPath: "stderr", ...codexMetrics }; }  };
    const base = { runDir: root, worktreePath: root, actionId: "R1-A1", reviewRevision: 1, approvedPlanSha256: "a".repeat(64), claim, validationErrors: ["invalid"], workItem, verifierProfile: { model: "verifier", reasoning_effort: "high" as const }, codex };
    await correctVerifierRemediationClaim(base);
    await correctVerifierRemediationClaim({ ...base, claim: { ...claim, diagnosis: { ...claim.diagnosis, observed_behavior: "Different" } } });
    await correctVerifierRemediationClaim({ ...base, approvedPlanSha256: "b".repeat(64) });
    await correctVerifierRemediationClaim({ ...base, validationErrors: ["different invalidity"] });
    expect(calls).toBe(4);
  });

  it.each(["response hash mismatch", "response without completion"])("rejects %s without another model call", async (scenario) => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-packet-corrupt-correction-"));
    const workItem = executionSpec("item-1");
    const claim: VerifierRemediationClaimV1 = { schema_version: 1, diagnosis: { observed_behavior: "Wrong", expected_behavior: "Right", failure_mechanism: "Missing", reproduction: ["Run"], evidence_refs: ["verification/evidence.json"] }, targets: [{ kind: "code", path: "src/item-1.ts", symbol: "item-1 implementation", line_hint: null }], remediation: { strategy: "Fix", change_units: [{ id: "FIX-1", path: "src/item-1.ts", target: "item-1 implementation", operation: "modify", requirements: ["Make right."], satisfies: ["SC-1"] }], allowed_files: ["src/item-1.ts"], forbidden_changes: [] }, verification: { commands: [{ id: "CMD-1", argv: ["npm", "test", "--", "tests/item-1.test.ts"] }], success_conditions: [{ id: "SC-1", statement: "Right", satisfied_by: ["CMD-1", "EVID-1"] }], required_evidence: [{ id: "EVID-1", kind: "test_result", source_id: "CMD-1", output_path: "verification/result.json" }] }, completion_contract: { required_change_unit_ids: ["FIX-1"], expected_changed_files: ["src/item-1.ts"], allow_additional_files: false } };
    let calls = 0;
    const codex: CodexAdapter = { invoke: async () => { calls += 1; return { text: JSON.stringify(claim), parsed: claim, exitCode: 0, promptPath: "prompt", stdoutPath: "stdout", stderrPath: "stderr", ...codexMetrics }; }  };
    const input = { runDir: root, worktreePath: root, actionId: "R1-A1", reviewRevision: 1, approvedPlanSha256: "a".repeat(64), claim, validationErrors: ["invalid"], workItem, verifierProfile: { model: "verifier", reasoning_effort: "high" as const }, codex };
    await correctVerifierRemediationClaim(input);
    const authority = reviewFixPacketCorrectionAuthority(input);
    if (scenario === "response hash mismatch") {
      await writeFile(join(root, authority.responsePath), `${JSON.stringify({ ...claim, diagnosis: { ...claim.diagnosis, observed_behavior: "Tampered" } }, null, 2)}\n`, "utf8");
    } else {
      await rm(join(root, authority.completionPath));
    }
    await expect(correctVerifierRemediationClaim({ ...input, codex: { invoke: async () => { calls += 1; throw new Error("must not invoke"); } } }))
      .rejects.toThrow(/hash|completion/i);
    expect(calls).toBe(1);
  });

  it("keeps approved-scope gaps on the replan path and malformed contracts operational", () => {
    expect(classifyFixPacketCompilationFailure(new FixPacketRequiresReplanError("scope"))).toBe("replan");
    expect(classifyFixPacketCompilationFailure(new Error("invalid_verifier_contract"))).toBe("invalid_contract");
  });

  it("treats an invented remediation command as correctable Verifier contract output", () => {
    const workItem = executionSpec("item-1");
    const claim = validClaimFor(workItem);
    claim.verification.commands[0]!.argv = ["npm", "run", "invented-check"];

    try {
      compileReviewFixPacket({
        claim,
        work_item: workItem,
        finding_id: "finding:command",
        action_id: "R1-A1",
        review_revision: 1,
        criterion_ref: workItem.acceptance[0]!.id,
        severity: "high",
        problem_class: "verification",
        approved_plan_sha256: "a".repeat(64),
      });
      throw new Error("Expected packet compilation to fail");
    } catch (error) {
      expect(classifyFixPacketCompilationFailure(error)).toBe("invalid_contract");
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("outside approved verification commands");
    }
  });

  it("normalizes an in-scope remediation unit to its sole approved file contract", () => {
    const workItem = executionSpec("item-1");
    const claim = validClaimFor(workItem);
    claim.remediation.change_units[0]!.target = "descriptive but unapproved target label";
    claim.remediation.change_units[0]!.operation = "create";

    const packet = compileReviewFixPacket({
      claim,
      work_item: workItem,
      finding_id: "finding:target",
      action_id: "R1-A1",
      review_revision: 1,
      criterion_ref: workItem.acceptance[0]!.id,
      severity: "high",
      problem_class: "correctness",
      approved_plan_sha256: "a".repeat(64),
    });

    expect(packet.remediation.change_units[0]).toMatchObject({
      target: workItem.file_contract[0]!.targets[0],
      operation: workItem.file_contract[0]!.permission,
    });
  });

  it("keeps an ambiguous remediation target mismatch on the invalid-contract path", () => {
    const workItem = executionSpec("item-1");
    workItem.file_contract[0]!.targets.push("second approved target");
    const claim = validClaimFor(workItem);
    claim.remediation.change_units[0]!.target = "descriptive but unapproved target label";

    expect(() => compileReviewFixPacket({
      claim,
      work_item: workItem,
      finding_id: "finding:ambiguous-target",
      action_id: "R1-A1",
      review_revision: 1,
      criterion_ref: workItem.acceptance[0]!.id,
      severity: "high",
      problem_class: "correctness",
      approved_plan_sha256: "a".repeat(64),
    })).toThrow(/approved file target or operation/);
  });

  it("does not reinvoke a contract correction after ambiguous dispatch", async () => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-packet-"));
    const workItem = executionSpec("item-1");
    const claim: VerifierRemediationClaimV1 = { schema_version: 1, diagnosis: { observed_behavior: "Wrong", expected_behavior: "Right", failure_mechanism: "Missing", reproduction: ["Run"], evidence_refs: ["verification/evidence.json"] }, targets: [{ kind: "code", path: "src/item-1.ts", symbol: "item-1 implementation", line_hint: null }], remediation: { strategy: "Fix", change_units: [{ id: "FIX-1", path: "src/item-1.ts", target: "item-1 implementation", operation: "modify", requirements: ["Make right."], satisfies: ["SC-1"] }], allowed_files: ["src/item-1.ts"], forbidden_changes: [] }, verification: { commands: [{ id: "CMD-1", argv: ["npm", "test", "--", "tests/item-1.test.ts"] }], success_conditions: [{ id: "SC-1", statement: "Right", satisfied_by: ["CMD-1", "EVID-1"] }], required_evidence: [{ id: "EVID-1", kind: "test_result", source_id: "CMD-1", output_path: "verification/result.json" }] }, completion_contract: { required_change_unit_ids: ["FIX-1"], expected_changed_files: ["src/item-1.ts"], allow_additional_files: false } };
    const base = { runDir: root, worktreePath: root, actionId: "R1-A1", reviewRevision: 1, approvedPlanSha256: "a".repeat(64), claim, validationErrors: ["invalid"], workItem, verifierProfile: { model: "verifier", reasoning_effort: "high" as const } };
    await expect(correctVerifierRemediationClaim({ ...base, codex: { invoke: async () => { throw new Error("transport ended after dispatch"); } } })).rejects.toThrow(/transport ended/);
    let calls = 0;
    await expect(correctVerifierRemediationClaim({ ...base, codex: { invoke: async () => { calls += 1; throw new Error("must not call"); } } })).rejects.toThrow(/ambiguous/i);
    expect(calls).toBe(0);
  });
});
