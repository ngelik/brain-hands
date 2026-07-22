import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CodexAdapter, CodexInvokeInput } from "../../src/adapters/codex.js";
import { approvePlanRevision, createRunLedgerV2, readManifestV2, recordPlan, updateManifestV2, writeCreateOnceValidated } from "../../src/core/ledger.js";
import { artifactRefFromBytes, canonicalJsonBytes, handsContextV1Schema } from "../../src/core/context-contracts.js";
import { hashReviewFixPacket, type FixPacketResultV1, type ReviewFixPacketV1, type VerifierRemediationClaimV1 } from "../../src/core/review-fix-packet.js";
import { fixPacketResultV1Schema } from "../../src/core/review-fix-packet.js";
import type { ResolvedRunIntake } from "../../src/core/types.js";
import { runHandsFixPacket } from "../../src/workflow/worker.js";
import { correctVerifierRemediationClaim, persistFixAttemptSupplement, persistReviewFixPacket, reviewFixPacketIdentity, reviewFixPacketRoot } from "../../src/workflow/fix-packets.js";
import { buildHandsContext, loadRoleContext } from "../../src/workflow/role-context.js";
import { reviewerActionQueueSchema } from "../../src/core/schema.js";
import { fingerprintFinding } from "../../src/workflow/findings.js";
import { beginReviewCycle, claimReviewEffect } from "../../src/workflow/review-cycle.js";
import { executionSpec } from "../fixtures/execution-spec.js";
const codexMetrics = { usage: null, durationMs: 0, processStarted: false, turnStarted: false, structuredTerminalError: false } as const;

const item = executionSpec("item-1");
const packet: ReviewFixPacketV1 = {
  schema_version: 1,
  provenance: { packet_id: "R1-A1", finding_id: "finding:abc", action_id: "R1-A1", review_revision: 1, work_item_id: "item-1", criterion_ref: "item-1-AC-01", approved_plan_sha256: "a".repeat(64) },
  diagnosis: { problem_class: "correctness", severity: "medium", observed_behavior: "Wrong", expected_behavior: "Right", failure_mechanism: "Missing behavior", reproduction: ["Run test"], evidence_refs: ["verification/evidence.json"] },
  targets: [{ kind: "code", path: "src/item-1.ts", symbol: "item-1 implementation", line_hint: null }],
  remediation: { strategy: "Fix behavior", change_units: [{ id: "FIX-1", path: "src/item-1.ts", target: "item-1 implementation", operation: "modify", requirements: ["Make behavior right."], satisfies: ["SC-1"] }], allowed_files: ["src/item-1.ts"], forbidden_changes: [] },
  verification: { commands: [{ id: "CMD-1", argv: [...item.verification_commands[0]!.argv] }], success_conditions: [{ id: "SC-1", statement: "Behavior is right", satisfied_by: ["CMD-1", "EVID-1"] }], required_evidence: [{ id: "EVID-1", kind: "test_result", source_id: "CMD-1", output_path: "verification/result.json" }] },
  completion_contract: {
    required_change_unit_ids: ["FIX-1"],
    expected_changed_files: ["src/item-1.ts"],
    allowed_generated_evidence_files: [],
    allow_additional_files: false,
  },
};
const result: FixPacketResultV1 = {
  schema_version: 1, packet_id: "R1-A1", packet_sha256: hashReviewFixPacket(packet), action_attempt: 1, status: "implemented",
  change_units: [{ change_unit_id: "FIX-1", status: "completed", changed_files: ["src/item-1.ts"], summary: "Implemented behavior." }],
  changed_files: ["src/item-1.ts"], commands_attempted: [], unresolved_requirements: [], blocker: null,
};
const intake: ResolvedRunIntake = {
  task: "fix", repo_root: "/tmp/repo", mode: "local", research: false, reflection: false,
  models: { brain: "brain", hands: "hands", verifier: "verifier" }, resolved_models: { brain: "brain", hands: "hands", verifier: "verifier" },
  roles: { brain: { model: "brain", reasoning_effort: "high", sandbox: "read-only" }, hands: { model: "hands", reasoning_effort: "medium", sandbox: "workspace-write" }, verifier: { model: "verifier", reasoning_effort: "high", sandbox: "read-only" } },
};

class RecordingHands implements CodexAdapter {
  calls: CodexInvokeInput[] = [];
  constructor(private readonly output: FixPacketResultV1 = result) {}
  async invoke(input: CodexInvokeInput) {
    this.calls.push(input);
    return { text: JSON.stringify(this.output), parsed: this.output, exitCode: 0, promptPath: "prompt", stdoutPath: "stdout", stderrPath: "stderr" , ...codexMetrics };
  }
}

let root: string | undefined;
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = undefined; });

async function boundedLedger(repoRoot: string) {
  const ledger = await createRunLedgerV2({ repoRoot, originalRequest: "fix" });
  await updateManifestV2(ledger.runDir, { workflow_protocol: "bounded-context-v1" });
  const legacyManifest = JSON.parse(await readFile(join(ledger.runDir, "manifest.json"), "utf8"));
  delete legacyManifest.review_policy_snapshot;
  delete legacyManifest.review_accounting;
  await writeFile(join(ledger.runDir, "manifest.json"), `${JSON.stringify(legacyManifest, null, 2)}\n`, "utf8");
  const recorded = await recordPlan(ledger.runDir, JSON.stringify({
    summary: "Bounded packet plan",
    assumptions: [], research: [], research_sources: ["repo"], architecture: "local", risks: [],
    work_items: [item], integration_verification: [],
  }));
  await approvePlanRevision(ledger.runDir, recorded.revision);
  return { ledger, recorded };
}

async function boundedFixture(
  repoRoot: string,
  diff = "bounded diff",
  provenanceOverride: Partial<ReviewFixPacketV1["provenance"]> = {},
  options: {
    packetTransform?: (packet: ReviewFixPacketV1) => ReviewFixPacketV1;
    queueClaim?: VerifierRemediationClaimV1;
    policyFinding?: boolean;
  } = {},
) {
  const { ledger, recorded } = await boundedLedger(repoRoot);
  const manifest = await readManifestV2(ledger.runDir);
  const findingCriterionRef = options.policyFinding
    ? manifest.plan_revisions[String(recorded.revision)]!.acceptance_criteria![item.id]![0]!.ref
    : packet.provenance.criterion_ref;
  const findingId = fingerprintFinding({
    work_item_id: item.id,
    criterion_ref: findingCriterionRef,
    source: "verifier",
    normalized_location: "src/item-1.ts",
    problem_class: packet.diagnosis.problem_class,
  });
  const authoritativePacket: ReviewFixPacketV1 = {
    ...packet,
    provenance: {
      ...packet.provenance,
      packet_id: reviewFixPacketIdentity({
        work_item_id: item.id,
        review_revision: packet.provenance.review_revision,
        action_id: packet.provenance.action_id,
        finding_id: findingId,
        approved_plan_sha256: recorded.sha256,
      }),
      finding_id: findingId,
      approved_plan_sha256: recorded.sha256,
      ...provenanceOverride,
    },
  };
  const boundedPacket = options.packetTransform?.(authoritativePacket) ?? authoritativePacket;
  const queueClaim = options.queueClaim ?? {
    schema_version: 1 as const,
    diagnosis: {
      observed_behavior: authoritativePacket.diagnosis.observed_behavior,
      expected_behavior: authoritativePacket.diagnosis.expected_behavior,
      failure_mechanism: authoritativePacket.diagnosis.failure_mechanism,
      reproduction: authoritativePacket.diagnosis.reproduction,
      evidence_refs: authoritativePacket.diagnosis.evidence_refs,
    },
    targets: authoritativePacket.targets,
    remediation: authoritativePacket.remediation,
    verification: authoritativePacket.verification,
    completion_contract: authoritativePacket.completion_contract,
  };
  const contextRef = await buildHandsContext({
    runDir: ledger.runDir, workItemId: item.id, planRevision: recorded.revision,
    attempt: 2, attemptKind: "fix_packet", workItem: item, diff,
  });
  const context = await loadRoleContext(ledger.runDir, contextRef, "hands");
  const bytes = canonicalJsonBytes(handsContextV1Schema, context);
  const boundedResult = {
    ...result,
    packet_id: boundedPacket.provenance.packet_id,
    packet_sha256: hashReviewFixPacket(boundedPacket),
  };
  const persistedPacket = await persistReviewFixPacket(ledger.runDir, boundedPacket);
  const queuePath = "action-queues/item-1/revision-1.json";
  await writeCreateOnceValidated(ledger.runDir, queuePath, {
    contract_version: "review_fix_packet_v1",
    review_revision: 1,
    work_item_id: item.id,
    actions: [{
      action_id: boundedPacket.provenance.action_id,
      order: 1,
      depends_on: [],
      severity: authoritativePacket.diagnosis.severity,
      file: "src/item-1.ts",
      line: null,
      acceptance_criterion: boundedPacket.provenance.criterion_ref,
      problem_class: authoritativePacket.diagnosis.problem_class,
      problem: authoritativePacket.diagnosis.observed_behavior,
      required_fix: authoritativePacket.remediation.strategy,
      evidence_refs: authoritativePacket.diagnosis.evidence_refs,
      remediation: queueClaim,
    }],
  }, reviewerActionQueueSchema);
  await updateManifestV2(ledger.runDir, {
    work_item_progress: {
      [item.id]: {
        status: "in_progress", attempts: 1, review_revision: 1,
        queue_state: "in_progress", queue_path: queuePath,
        active_action_id: boundedPacket.provenance.action_id, active_action_attempt: 1,
        completed_action_ids: [], focused_review_path: null,
        fix_packet_path: persistedPacket.path, fix_packet_sha256: persistedPacket.sha256,
        fix_packet_attempt: 1, fix_packet_supplement_path: null,
      },
    },
  });
  return { ledger, recorded, boundedPacket, boundedResult, context, bytes, contextRef };
}

async function authorizePolicy(
  fixture: Awaited<ReturnType<typeof boundedFixture>>,
  phase: "work_item" | "final_integrated" = "work_item",
) {
  const policy = {
    policy_revision: 1,
    max_fix_cycles: 3,
    on_limit: "stop" as const,
    auto_advance_on_approval: true,
    severity_defaults: { critical: "blocking" as const, high: "blocking" as const, medium: "fix_in_scope" as const, low: "advisory" as const },
    pause_on: [],
  };
  const accounting = { review_revision: 0, fix_cycles_used: 0, self_review_mutations_used: 0, plan_revision: fixture.recorded.revision };
  const policyManifest = JSON.parse(await readFile(join(fixture.ledger.runDir, "manifest.json"), "utf8"));
  policyManifest.review_policy_snapshot = policy;
  policyManifest.review_accounting = accounting;
  await writeFile(join(fixture.ledger.runDir, "manifest.json"), `${JSON.stringify(policyManifest, null, 2)}\n`, "utf8");
  const cycle = await beginReviewCycle({
    run_dir: fixture.ledger.runDir,
    work_item_id: item.id,
    phase,
    review_revision: 1,
    policy_hash: createHash("sha256").update(JSON.stringify(policy)).digest("hex"),
    finding_ids: [fixture.boundedPacket.provenance.finding_id],
    accounting_before: accounting,
    evaluate: () => ({
      action: "fix", reason_code: "fix_budget_available",
      finding_ids: [fixture.boundedPacket.provenance.finding_id],
      policy_revision: policy.policy_revision, authorization_required: false,
    }),
  });
  const claim = await claimReviewEffect({
    run_dir: fixture.ledger.runDir,
    cycle,
    owner: `runtime:work-item:${item.id}`,
  });
  if (claim.status !== "acquired") throw new Error("expected policy effect claim");
  await patchBoundedProgress(fixture, { review_cycle_path: cycle.decision_path, review_effect_id: cycle.effect_id });
  return { policy, cycle };
}

async function patchBoundedProgress(
  fixture: Awaited<ReturnType<typeof boundedFixture>>,
  patch: Record<string, unknown>,
) {
  const manifest = await readManifestV2(fixture.ledger.runDir);
  await updateManifestV2(fixture.ledger.runDir, {
    work_item_progress: {
      ...manifest.work_item_progress,
      [item.id]: { ...manifest.work_item_progress[item.id]!, ...patch },
    },
  });
}

async function authorizeRetry(
  fixture: Awaited<ReturnType<typeof boundedFixture>>,
  attempt: number,
) {
  const supplement = {
    packet_id: fixture.boundedPacket.provenance.packet_id,
    base_packet_sha256: hashReviewFixPacket(fixture.boundedPacket),
    next_attempt: attempt,
    unsatisfied_condition_ids: ["SC-1"],
    remaining_problem: "Still wrong",
    required_next_fix: "Apply the remaining fix",
    additional_evidence_refs: [],
  };
  const supplementPath = await persistFixAttemptSupplement(fixture.ledger.runDir, supplement);
  await patchBoundedProgress(fixture, {
    active_action_attempt: attempt,
    fix_packet_attempt: attempt,
    fix_packet_supplement_path: supplementPath,
  });
  return supplement;
}

describe("runHandsFixPacket", () => {
  it("rejects a schema-valid oversized packet before prompt, schema, claim, result, Codex, or budget interaction", async () => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-fix-oversized-prompt-"));
    const ledger = await createRunLedgerV2({ repoRoot: root, originalRequest: "fix" });
    const codex = new RecordingHands();
    const budgetInteractions: string[] = [];
    const budget = {
      usage: async () => { budgetInteractions.push("usage"); return { model_invocations: 0, workflow_attempts: 0, total_tokens: 0, cached_input_tokens: 0, reasoning_output_tokens: 0, active_elapsed_ms: 0, external_effects: 0, token_accounting: "known" as const, uncertain_model_claim_ids: [], token_overshoot: 0 }; },
      claim: async () => { budgetInteractions.push("claim"); throw new Error("must not claim"); },
      complete: async () => { budgetInteractions.push("complete"); throw new Error("must not complete"); },
      runWorkflowAttempt: async <T>(_key: string, action: () => Promise<T>) => { budgetInteractions.push("runWorkflowAttempt"); return action(); },
      remainingActiveElapsedMs: async () => { budgetInteractions.push("remainingActiveElapsedMs"); return 0; },
    };
    const oversizedPacket = {
      ...packet,
      remediation: {
        ...packet.remediation,
        change_units: [{
          ...packet.remediation.change_units[0]!,
          requirements: ["x".repeat(128 * 1024)],
        }],
      },
    };
    const artifactName = "hands-fix-packet-R1-A1-attempt-1";

    await expect(runHandsFixPacket({
      runDir: ledger.runDir, worktreePath: root, workItem: item, packet: oversizedPacket,
      actionAttempt: 1, intake: { ...intake, repo_root: root }, codex, budget,
      relevantSourceContext: [], evidenceContext: [], completedDependencies: [], currentDiff: "", supplement: null,
    })).rejects.toThrow(/Hands fix packet prompt exceeds 131072 bytes/);

    expect(codex.calls).toHaveLength(0);
    expect(budgetInteractions).toEqual([]);
    for (const relativePath of [
      `prompts/${artifactName}.md`,
      `schemas/${artifactName}.json`,
      `${reviewFixPacketRoot("R1-A1")}/attempts/1/hands-invocation-claim.json`,
      `${reviewFixPacketRoot("R1-A1")}/attempts/1/hands-result.json`,
    ]) {
      await expect(readFile(join(ledger.runDir, relativePath), "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("rejects inconsistent implemented and contradiction results", () => {
    expect(fixPacketResultV1Schema.safeParse({ ...result, unresolved_requirements: [{ change_unit_id: "FIX-1", requirement: "missing", reason: "not done" }] }).success).toBe(false);
    expect(fixPacketResultV1Schema.safeParse({ ...result, status: "packet_contradiction", unresolved_requirements: [] }).success).toBe(false);
  });

  it("invokes Hands with one immutable packet and records a strict packet result", async () => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-fix-worker-"));
    const ledger = await createRunLedgerV2({ repoRoot: root, originalRequest: "fix" });
    const codex = new RecordingHands();
    const output = await runHandsFixPacket({ runDir: ledger.runDir, worktreePath: root, workItem: item, packet, actionAttempt: 1, intake: { ...intake, repo_root: root }, codex, relevantSourceContext: [{ path: "src/item-1.ts", content: "source" }], evidenceContext: [], completedDependencies: [], currentDiff: "diff", supplement: null });
    expect(output.result).toEqual(result);
    expect(output.profile).toEqual({ kind: "primary", model: "hands", reasoning_effort: "medium" });
    expect(output.reportPath).toBe(`${reviewFixPacketRoot("R1-A1")}/attempts/1/hands-result.json`);
    expect(codex.calls[0]).toMatchObject({ role: "hands", sandbox: "workspace-write", outputSchema: expect.anything() });
    const outputSchema = codex.calls[0]!.outputSchema as {
      properties: Record<string, unknown> & {
        commands_attempted: { items: { anyOf: Array<{ properties: Record<string, unknown> }> } };
      };
    };
    expect(outputSchema.properties).toMatchObject({
      packet_id: { enum: ["R1-A1"] },
      packet_sha256: { enum: [hashReviewFixPacket(packet)] },
      action_attempt: { enum: [1] },
    });
    expect(outputSchema.properties.commands_attempted.items.anyOf).toEqual([
      expect.objectContaining({
        properties: expect.objectContaining({
          command_id: { type: "string", enum: ["CMD-1"] },
          argv: { type: "array", const: item.verification_commands[0]!.argv },
        }),
      }),
    ]);
    const prompt = await readFile(join(ledger.runDir, "prompts/hands-fix-packet-R1-A1-attempt-1.md"), "utf8");
    expect(prompt).toContain('"packet_id": "R1-A1"');
    expect(prompt).toContain("`action_attempt`: 1");
    expect(prompt).toContain('"path": "src/item-1.ts"');
    expect(prompt).not.toContain("R1-A2");
    expect(JSON.parse(await readFile(join(ledger.runDir, `${reviewFixPacketRoot("R1-A1")}/attempts/1/hands-invocation-claim.json`), "utf8")))
      .toMatchObject({ profile_kind: "primary", model: "hands", reasoning_effort: "medium" });
  });

  it("renders a bounded fix as one context package without broad source or evidence fields", async () => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-fix-worker-bounded-"));
    const fixture = await boundedFixture(root, "COMPLETE_FIX_DIFF_SENTINEL");
    const codex = new RecordingHands(fixture.boundedResult);

    await runHandsFixPacket({
      runDir: fixture.ledger.runDir,
      worktreePath: root,
      workItem: item,
      packet: fixture.boundedPacket,
      actionAttempt: 1,
      contextAttempt: 2,
      contextPlanRevision: fixture.recorded.revision,
      intake: { ...intake, repo_root: root },
      codex,
      relevantSourceContext: [{ content: "BROAD_SOURCE_SENTINEL" }],
      evidenceContext: [{ content: "BROAD_EVIDENCE_SENTINEL" }],
      completedDependencies: [{ content: "BROAD_DEPENDENCY_SENTINEL" }],
      currentDiff: "BROAD_DIFF_SENTINEL",
      supplement: null,
      contextRef: fixture.contextRef,
      context: fixture.context,
    } as Parameters<typeof runHandsFixPacket>[0]);

    const prompt = codex.calls[0]!.prompt;
    expect(prompt).toContain(fixture.contextRef.path);
    expect(prompt).toContain(fixture.contextRef.sha256);
    expect(prompt).toContain("COMPLETE_FIX_DIFF_SENTINEL");
    expect(prompt).toContain(`"packet_id": "${fixture.boundedPacket.provenance.packet_id}"`);
    expect(prompt).toContain('"action_attempt": 1');
    expect(prompt).toContain("must quote one requirement string exactly");
    expect(prompt).toContain("when every change unit is complete, return");
    expect(prompt).toContain("`unresolved_requirements: []` and `blocker: null`");
    expect(prompt).toContain("The controller independently verifies the change");
    for (const leaked of ["BROAD_SOURCE_SENTINEL", "BROAD_EVIDENCE_SENTINEL", "BROAD_DEPENDENCY_SENTINEL", "BROAD_DIFF_SENTINEL"] ) {
      expect(prompt).not.toContain(leaked);
    }
  });

  it.each([0, 1.5, Number.NaN])("rejects invalid action attempt %s before side effects", async (actionAttempt) => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-fix-invalid-attempt-"));
    const ledger = await createRunLedgerV2({ repoRoot: root, originalRequest: "fix" });
    const codex = new RecordingHands();
    await expect(runHandsFixPacket({
      runDir: ledger.runDir, worktreePath: root, workItem: item, packet, actionAttempt,
      intake: { ...intake, repo_root: root }, codex,
      relevantSourceContext: [], evidenceContext: [], completedDependencies: [], currentDiff: "", supplement: null,
    })).rejects.toThrow(/positive safe integer/i);
    expect(codex.calls).toHaveLength(0);
    await expect(readFile(join(ledger.runDir, `prompts/hands-fix-packet-R1-A1-attempt-${String(actionAttempt)}.md`), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    ["missing packet pointer", { fix_packet_path: undefined }],
    ["stale review revision", { review_revision: 2 }],
    ["wrong active action", { active_action_id: "R1-A2" }],
    ["mismatched packet hash", { fix_packet_sha256: "7".repeat(64) }],
    ["mismatched packet path", { fix_packet_path: "reviews/fix-packets/b3RoZXI/packet.json" }],
    ["mismatched packet attempt", { fix_packet_attempt: 2 }],
  ])("rejects bounded durable packet authority with %s", async (_label, progressPatch) => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-fix-durable-"));
    const fixture = await boundedFixture(root);
    await patchBoundedProgress(fixture, progressPatch);
    const codex = new RecordingHands(fixture.boundedResult);
    await expect(runHandsFixPacket({
      runDir: fixture.ledger.runDir, worktreePath: root, workItem: item,
      packet: fixture.boundedPacket, actionAttempt: 1, contextAttempt: 2,
      contextPlanRevision: fixture.recorded.revision,
      intake: { ...intake, repo_root: root }, codex,
      relevantSourceContext: [], evidenceContext: [], completedDependencies: [], currentDiff: "", supplement: null,
      contextRef: fixture.contextRef, context: fixture.context,
    })).rejects.toThrow(/authority|pointer|review action|path|hash/i);
    expect(codex.calls).toHaveLength(0);
    await expect(readFile(join(fixture.ledger.runDir, "prompts/hands-fix-packet-R1-A1-attempt-1.md"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a missing immutable bounded packet artifact", async () => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-fix-missing-packet-"));
    const fixture = await boundedFixture(root);
    const progress = (await readManifestV2(fixture.ledger.runDir)).work_item_progress[item.id]!;
    await rm(join(fixture.ledger.runDir, progress.fix_packet_path!), { force: true });
    const codex = new RecordingHands(fixture.boundedResult);
    await expect(runHandsFixPacket({
      runDir: fixture.ledger.runDir, worktreePath: root, workItem: item,
      packet: fixture.boundedPacket, actionAttempt: 1, contextAttempt: 2,
      contextPlanRevision: fixture.recorded.revision,
      intake: { ...intake, repo_root: root }, codex,
      relevantSourceContext: [], evidenceContext: [], completedDependencies: [], currentDiff: "", supplement: null,
      contextRef: fixture.contextRef, context: fixture.context,
    })).rejects.toThrow(/packet is missing/i);
    expect(codex.calls).toHaveLength(0);
  });

  it("rejects a noncanonical Reviewer queue pointer even when the queue payload is valid", async () => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-fix-noncanonical-queue-"));
    const fixture = await boundedFixture(root);
    const progress = (await readManifestV2(fixture.ledger.runDir)).work_item_progress[item.id]!;
    const queue = reviewerActionQueueSchema.parse(JSON.parse(await readFile(join(fixture.ledger.runDir, progress.queue_path!), "utf8")));
    const alternatePath = "action-queues/item-1/alternate-revision-1.json";
    await writeCreateOnceValidated(fixture.ledger.runDir, alternatePath, queue, reviewerActionQueueSchema);
    await patchBoundedProgress(fixture, { queue_path: alternatePath });
    const codex = new RecordingHands(fixture.boundedResult);
    await expect(runHandsFixPacket({
      runDir: fixture.ledger.runDir, worktreePath: root, workItem: item,
      packet: fixture.boundedPacket, actionAttempt: 1, contextAttempt: 2,
      contextPlanRevision: fixture.recorded.revision,
      intake: { ...intake, repo_root: root }, codex,
      relevantSourceContext: [], evidenceContext: [], completedDependencies: [], currentDiff: "", supplement: null,
      contextRef: fixture.contextRef, context: fixture.context,
    })).rejects.toThrow(/queue.*canonical/i);
    expect(codex.calls).toHaveLength(0);
  });

  it("rejects a persisted bounded packet with a forged scoped packet ID", async () => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-fix-forged-packet-id-"));
    const fixture = await boundedFixture(root, "bounded diff", {}, {
      packetTransform: (value) => ({
        ...value,
        provenance: { ...value.provenance, packet_id: `review-fix-packet:${"0".repeat(64)}` },
      }),
    });
    const codex = new RecordingHands(fixture.boundedResult);
    await expect(runHandsFixPacket({
      runDir: fixture.ledger.runDir, worktreePath: root, workItem: item,
      packet: fixture.boundedPacket, actionAttempt: 1, contextAttempt: 2,
      contextPlanRevision: fixture.recorded.revision,
      intake: { ...intake, repo_root: root }, codex,
      relevantSourceContext: [], evidenceContext: [], completedDependencies: [], currentDiff: "", supplement: null,
      contextRef: fixture.contextRef, context: fixture.context,
    })).rejects.toThrow(/canonical scoped identity/i);
    expect(codex.calls).toHaveLength(0);
  });

  it.each([
    ["wrong finding", { finding_id: `finding:${"f".repeat(64)}` }, /finding provenance/i],
    ["wrong criterion", { criterion_ref: "item-1-AC-X" }, /criterion provenance/i],
  ])("rejects bounded packet provenance with %s", async (_label, provenance, expected) => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-fix-provenance-"));
    const fixture = await boundedFixture(root, "bounded diff", provenance);
    const codex = new RecordingHands(fixture.boundedResult);
    await expect(runHandsFixPacket({
      runDir: fixture.ledger.runDir, worktreePath: root, workItem: item,
      packet: fixture.boundedPacket, actionAttempt: 1, contextAttempt: 2,
      contextPlanRevision: fixture.recorded.revision,
      intake: { ...intake, repo_root: root }, codex,
      relevantSourceContext: [], evidenceContext: [], completedDependencies: [], currentDiff: "", supplement: null,
      contextRef: fixture.contextRef, context: fixture.context,
    })).rejects.toThrow(expected);
    expect(codex.calls).toHaveLength(0);
  });

  it.each([
    ["diagnosis", (value: ReviewFixPacketV1) => ({ ...value, diagnosis: { ...value.diagnosis, observed_behavior: "Altered diagnosis" } })],
    ["targets", (value: ReviewFixPacketV1) => ({ ...value, targets: [{ ...value.targets[0]!, line_hint: 7 }] })],
    ["remediation", (value: ReviewFixPacketV1) => ({ ...value, remediation: { ...value.remediation, strategy: "Altered remediation" } })],
    ["verification", (value: ReviewFixPacketV1) => ({ ...value, verification: { ...value.verification, success_conditions: [{ ...value.verification.success_conditions[0]!, statement: "Altered success condition" }] } })],
    ["completion", (value: ReviewFixPacketV1) => ({ ...value, completion_contract: { ...value.completion_contract, expected_changed_files: [...value.completion_contract.expected_changed_files, value.completion_contract.expected_changed_files[0]!] } })],
  ] as const)("rejects a readiness-valid packet with altered %s payload before side effects", async (_label, transform) => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-fix-altered-payload-"));
    const fixture = await boundedFixture(root, "bounded diff", {}, { packetTransform: transform });
    const codex = new RecordingHands(fixture.boundedResult);
    await expect(runHandsFixPacket({
      runDir: fixture.ledger.runDir, worktreePath: root, workItem: item,
      packet: fixture.boundedPacket, actionAttempt: 1, contextAttempt: 2,
      contextPlanRevision: fixture.recorded.revision,
      intake: { ...intake, repo_root: root }, codex,
      relevantSourceContext: [], evidenceContext: [], completedDependencies: [], currentDiff: "", supplement: null,
      contextRef: fixture.contextRef, context: fixture.context,
    })).rejects.toThrow(/authoritative|authority|queue|packet/i);
    expect(codex.calls).toHaveLength(0);
    await expect(readFile(join(fixture.ledger.runDir, "prompts/hands-fix-packet-R1-A1-attempt-1.md"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    ["missing cycle pointer", async (fixture: Awaited<ReturnType<typeof boundedFixture>>) => patchBoundedProgress(fixture, { review_cycle_path: undefined })],
    ["mismatched effect id", async (fixture: Awaited<ReturnType<typeof boundedFixture>>) => patchBoundedProgress(fixture, { review_effect_id: `review-effect:${"0".repeat(64)}` })],
    ["mismatched phase", async () => undefined],
    ["mismatched policy hash", async (fixture: Awaited<ReturnType<typeof boundedFixture>>) => {
      const manifest = await readManifestV2(fixture.ledger.runDir);
      const raw = JSON.parse(await readFile(join(fixture.ledger.runDir, "manifest.json"), "utf8"));
      raw.review_policy_snapshot = { ...manifest.review_policy_snapshot!, max_fix_cycles: manifest.review_policy_snapshot!.max_fix_cycles + 1 };
      await writeFile(join(fixture.ledger.runDir, "manifest.json"), `${JSON.stringify(raw, null, 2)}\n`, "utf8");
    }],
    ["mismatched policy revision", async (fixture: Awaited<ReturnType<typeof boundedFixture>>) => {
      const manifest = await readManifestV2(fixture.ledger.runDir);
      const raw = JSON.parse(await readFile(join(fixture.ledger.runDir, "manifest.json"), "utf8"));
      raw.review_policy_snapshot = { ...manifest.review_policy_snapshot!, policy_revision: manifest.review_policy_snapshot!.policy_revision + 1 };
      await writeFile(join(fixture.ledger.runDir, "manifest.json"), `${JSON.stringify(raw, null, 2)}\n`, "utf8");
    }],
  ] as const)("rejects policy-enabled packet authority with %s", async (scenario, mutate) => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-fix-policy-authority-"));
    const fixture = await boundedFixture(root, "bounded diff", {}, { policyFinding: true });
    await authorizePolicy(fixture, scenario === "mismatched phase" ? "final_integrated" : "work_item");
    await mutate(fixture);
    const codex = new RecordingHands(fixture.boundedResult);
    await expect(runHandsFixPacket({
      runDir: fixture.ledger.runDir, worktreePath: root, workItem: item,
      packet: fixture.boundedPacket, actionAttempt: 1, contextAttempt: 2,
      contextPlanRevision: fixture.recorded.revision,
      intake: { ...intake, repo_root: root }, codex,
      relevantSourceContext: [], evidenceContext: [], completedDependencies: [], currentDiff: "", supplement: null,
      contextRef: fixture.contextRef, context: fixture.context,
    })).rejects.toThrow(/policy|cycle|effect|phase/i);
    expect(codex.calls).toHaveLength(0);
  });

  it("rejects a policy queue with an action outside the exact decision finding set", async () => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-fix-policy-queue-authority-"));
    const fixture = await boundedFixture(root, "bounded diff", {}, { policyFinding: true });
    await authorizePolicy(fixture);
    const progress = (await readManifestV2(fixture.ledger.runDir)).work_item_progress[item.id]!;
    const queueFile = join(fixture.ledger.runDir, progress.queue_path!);
    const queue = JSON.parse(await readFile(queueFile, "utf8"));
    queue.actions.push({ ...queue.actions[0], action_id: "R1-A2", order: 2 });
    await writeFile(queueFile, `${JSON.stringify(queue, null, 2)}\n`, "utf8");
    const codex = new RecordingHands(fixture.boundedResult);
    await expect(runHandsFixPacket({
      runDir: fixture.ledger.runDir, worktreePath: root, workItem: item,
      packet: fixture.boundedPacket, actionAttempt: 1, contextAttempt: 2,
      contextPlanRevision: fixture.recorded.revision,
      intake: { ...intake, repo_root: root }, codex,
      relevantSourceContext: [], evidenceContext: [], completedDependencies: [], currentDiff: "", supplement: null,
      contextRef: fixture.contextRef, context: fixture.context,
    })).rejects.toThrow(/policy reviewer queue|decision finding|more than one action/i);
    expect(codex.calls).toHaveLength(0);
  });

  it("accepts only the exact controller-owned correction artifact for an invalid queue claim", async () => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-fix-corrected-authority-"));
    const correctedClaim: VerifierRemediationClaimV1 = {
      schema_version: 1,
      diagnosis: {
        observed_behavior: packet.diagnosis.observed_behavior,
        expected_behavior: packet.diagnosis.expected_behavior,
        failure_mechanism: packet.diagnosis.failure_mechanism,
        reproduction: packet.diagnosis.reproduction,
        evidence_refs: packet.diagnosis.evidence_refs,
      },
      targets: packet.targets,
      remediation: packet.remediation,
      verification: packet.verification,
      completion_contract: packet.completion_contract,
    };
    const invalidClaim: VerifierRemediationClaimV1 = {
      ...correctedClaim,
      remediation: {
        ...correctedClaim.remediation,
        change_units: correctedClaim.remediation.change_units.map((unit) => ({
          ...unit,
          requirements: ["Fix behavior as needed"],
        })),
      },
    };
    const fixture = await boundedFixture(root, "bounded diff", {}, { queueClaim: invalidClaim });
    await correctVerifierRemediationClaim({
      runDir: fixture.ledger.runDir,
      worktreePath: root,
      actionId: fixture.boundedPacket.provenance.action_id,
      reviewRevision: fixture.boundedPacket.provenance.review_revision,
      approvedPlanSha256: fixture.boundedPacket.provenance.approved_plan_sha256,
      claim: invalidClaim,
      validationErrors: ["Invalid review fix packet: FIX-1 contains vague requirement \"Fix behavior as needed\""],
      workItem: item,
      verifierProfile: intake.roles.verifier,
      codex: new RecordingHands(correctedClaim as never),
    });
    const codex = new RecordingHands(fixture.boundedResult);
    await expect(runHandsFixPacket({
      runDir: fixture.ledger.runDir, worktreePath: root, workItem: item,
      packet: fixture.boundedPacket, actionAttempt: 1, contextAttempt: 2,
      contextPlanRevision: fixture.recorded.revision,
      intake: { ...intake, repo_root: root }, codex,
      relevantSourceContext: [], evidenceContext: [], completedDependencies: [], currentDiff: "", supplement: null,
      contextRef: fixture.contextRef, context: fixture.context,
    })).resolves.toBeDefined();
    expect(codex.calls).toHaveLength(1);
  });

  it.each(["claim", "plan", "validation errors"] as const)(
    "does not reuse a completed correction with changed %s authority",
    async (changed) => {
      root = await mkdtemp(join(tmpdir(), "brain-hands-fix-correction-mismatch-"));
      const correctedClaim: VerifierRemediationClaimV1 = {
        schema_version: 1,
        diagnosis: {
          observed_behavior: packet.diagnosis.observed_behavior,
          expected_behavior: packet.diagnosis.expected_behavior,
          failure_mechanism: packet.diagnosis.failure_mechanism,
          reproduction: packet.diagnosis.reproduction,
          evidence_refs: packet.diagnosis.evidence_refs,
        },
        targets: packet.targets,
        remediation: packet.remediation,
        verification: packet.verification,
        completion_contract: packet.completion_contract,
      };
      const invalidClaim: VerifierRemediationClaimV1 = {
        ...correctedClaim,
        remediation: {
          ...correctedClaim.remediation,
          change_units: correctedClaim.remediation.change_units.map((unit) => ({
            ...unit,
            requirements: ["Fix behavior as needed"],
          })),
        },
      };
      const fixture = await boundedFixture(root, "bounded diff", {}, { queueClaim: invalidClaim });
      const correctionClaim = changed === "claim"
        ? {
            ...invalidClaim,
            diagnosis: { ...invalidClaim.diagnosis, failure_mechanism: "Different correction request" },
          }
        : invalidClaim;
      const exactError = "Invalid review fix packet: FIX-1 contains vague requirement \"Fix behavior as needed\"";
      await correctVerifierRemediationClaim({
        runDir: fixture.ledger.runDir,
        worktreePath: root,
        actionId: fixture.boundedPacket.provenance.action_id,
        reviewRevision: fixture.boundedPacket.provenance.review_revision,
        approvedPlanSha256: changed === "plan" ? "b".repeat(64) : fixture.boundedPacket.provenance.approved_plan_sha256,
        claim: correctionClaim,
        validationErrors: changed === "validation errors" ? ["Different validation failure"] : [exactError],
        workItem: item,
        verifierProfile: intake.roles.verifier,
        codex: new RecordingHands(correctedClaim as never),
      });
      const handsCodex = new RecordingHands(fixture.boundedResult);
      await expect(runHandsFixPacket({
        runDir: fixture.ledger.runDir, worktreePath: root, workItem: item,
        packet: fixture.boundedPacket, actionAttempt: 1, contextAttempt: 2,
        contextPlanRevision: fixture.recorded.revision,
        intake: { ...intake, repo_root: root }, codex: handsCodex,
        relevantSourceContext: [], evidenceContext: [], completedDependencies: [], currentDiff: "", supplement: null,
        contextRef: fixture.contextRef, context: fixture.context,
      })).rejects.toThrow(/no exact controller-owned correction authority/i);
      expect(handsCodex.calls).toHaveLength(0);
    },
  );

  it.each(["missing pointer", "stale pointer", "missing artifact"])(
    "rejects bounded retry supplement authority with %s",
    async (scenario) => {
      root = await mkdtemp(join(tmpdir(), "brain-hands-fix-durable-supplement-"));
      const fixture = await boundedFixture(root);
      const supplement = await authorizeRetry(fixture, 2);
      const progress = (await readManifestV2(fixture.ledger.runDir)).work_item_progress[item.id]!;
      if (scenario === "missing pointer") await patchBoundedProgress(fixture, { fix_packet_supplement_path: null });
      if (scenario === "stale pointer") await patchBoundedProgress(fixture, {
        fix_packet_supplement_path: `${reviewFixPacketRoot(fixture.boundedPacket.provenance.packet_id)}/attempts/3/attempt-supplement.json`,
      });
      if (scenario === "missing artifact") {
        await rm(join(fixture.ledger.runDir, progress.fix_packet_supplement_path!), { force: true });
      }
      const codex = new RecordingHands({ ...fixture.boundedResult, action_attempt: 2 });
      await expect(runHandsFixPacket({
        runDir: fixture.ledger.runDir, worktreePath: root, workItem: item,
        packet: fixture.boundedPacket, actionAttempt: 2, contextAttempt: 2,
        contextPlanRevision: fixture.recorded.revision,
        intake: { ...intake, repo_root: root }, codex,
        relevantSourceContext: [], evidenceContext: [], completedDependencies: [], currentDiff: "", supplement,
        contextRef: fixture.contextRef, context: fixture.context,
      })).rejects.toThrow(/supplement.*(?:pointer|missing|stale)/i);
      expect(codex.calls).toHaveLength(0);
      await expect(readFile(join(fixture.ledger.runDir, "prompts/hands-fix-packet-R1-A1-attempt-2.md"), "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it.each([
    ["wrong work-item path", "contexts/hands/aXRlbS0y/plan-1/attempt-2/fix_packet.json"],
    ["wrong attempt", "contexts/hands/aXRlbS0x/plan-1/attempt-3/fix_packet.json"],
    ["wrong attempt kind", "contexts/hands/aXRlbS0x/plan-1/attempt-2/primary_fix.json"],
    ["noncanonical base64 identity", "contexts/hands/aXRl.bS0x/plan-1/attempt-2/fix_packet.json"],
    ["arbitrary context path", "contexts/hands/aXRlbS0x/plan-1/attempt-2/arbitrary.json"],
  ])("rejects bounded fix-packet coordinates with a %s", async (_label, path) => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-fix-coordinates-"));
    const fixture = await boundedFixture(root);
    const contextRef = artifactRefFromBytes(
      path.replace("plan-1", `plan-${fixture.recorded.revision}`),
      fixture.bytes,
    );
    const codex = new RecordingHands(fixture.boundedResult);
    await expect(runHandsFixPacket({
      runDir: fixture.ledger.runDir, worktreePath: root, workItem: item,
      packet: fixture.boundedPacket, actionAttempt: 1, contextAttempt: 2,
      contextPlanRevision: fixture.recorded.revision,
      intake: { ...intake, repo_root: root }, codex,
      relevantSourceContext: [], evidenceContext: [], completedDependencies: [], currentDiff: "", supplement: null,
      contextRef, context: fixture.context,
    })).rejects.toThrow(/context|path|attempt|work.item|identity/i);
    expect(codex.calls).toHaveLength(0);
  });

  it.each([
    ["cross-item packet", (value: ReviewFixPacketV1) => ({ ...value, provenance: { ...value.provenance, work_item_id: "item-2" } }), /work.item provenance/i],
    ["wrong approved-plan hash", (value: ReviewFixPacketV1) => ({ ...value, provenance: { ...value.provenance, approved_plan_sha256: "9".repeat(64) } }), /plan hash/i],
  ])("rejects bounded packet authority with a %s", async (_label, mutate, expected) => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-fix-authority-"));
    const fixture = await boundedFixture(root);
    const codex = new RecordingHands(fixture.boundedResult);
    await expect(runHandsFixPacket({
      runDir: fixture.ledger.runDir, worktreePath: root, workItem: item,
      packet: mutate(fixture.boundedPacket), actionAttempt: 1, contextAttempt: 2,
      contextPlanRevision: fixture.recorded.revision,
      intake: { ...intake, repo_root: root }, codex,
      relevantSourceContext: [], evidenceContext: [], completedDependencies: [], currentDiff: "", supplement: null,
      contextRef: fixture.contextRef, context: fixture.context,
    })).rejects.toThrow(expected);
    expect(codex.calls).toHaveLength(0);
  });

  it("rejects a bounded fix packet from a stale plan revision", async () => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-fix-revision-"));
    const fixture = await boundedFixture(root);
    const staleRevision = fixture.recorded.revision + 1;
    const staleRef = artifactRefFromBytes(
      `contexts/hands/aXRlbS0x/plan-${staleRevision}/attempt-2/fix_packet.json`,
      fixture.bytes,
    );
    await expect(runHandsFixPacket({
      runDir: fixture.ledger.runDir, worktreePath: root, workItem: item,
      packet: fixture.boundedPacket, actionAttempt: 1, contextAttempt: 2, contextPlanRevision: staleRevision,
      intake: { ...intake, repo_root: root }, codex: new RecordingHands(fixture.boundedResult),
      relevantSourceContext: [], evidenceContext: [], completedDependencies: [], currentDiff: "", supplement: null,
      contextRef: staleRef, context: fixture.context,
    })).rejects.toThrow(/plan revision|current bounded authority|ENOENT|missing/i);
  });

  it.each([
    ["wrong packet ID", { packet_id: "R1-A2" }],
    ["wrong base packet hash", { base_packet_sha256: "8".repeat(64) }],
    ["wrong next attempt", { next_attempt: 3 }],
    ["empty unsatisfied condition IDs", { unsatisfied_condition_ids: [] }],
    ["unknown unsatisfied condition ID", { unsatisfied_condition_ids: ["SC-X"] }],
    ["duplicate unsatisfied condition IDs", { unsatisfied_condition_ids: ["SC-1", "SC-1"] }],
  ])("rejects a bounded fix supplement with %s", async (_label, override) => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-fix-supplement-"));
    const fixture = await boundedFixture(root);
    const authoritativeSupplement = await authorizeRetry(fixture, 2);
    const supplement = {
      ...authoritativeSupplement,
      ...override,
    };
    const codex = new RecordingHands({ ...fixture.boundedResult, action_attempt: 2 });
    await expect(runHandsFixPacket({
      runDir: fixture.ledger.runDir, worktreePath: root, workItem: item,
      packet: fixture.boundedPacket, actionAttempt: 2, contextAttempt: 2,
      contextPlanRevision: fixture.recorded.revision,
      intake: { ...intake, repo_root: root }, codex,
      relevantSourceContext: [], evidenceContext: [], completedDependencies: [], currentDiff: "", supplement,
      contextRef: fixture.contextRef, context: fixture.context,
    } as Parameters<typeof runHandsFixPacket>[0])).rejects.toThrow(/packet|hash|attempt|too_small|array/i);
    expect(codex.calls).toHaveLength(0);
  });

  it("rejects a Hands claim that omits packet change units or invents commands", async () => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-fix-worker-"));
    const ledger = await createRunLedgerV2({ repoRoot: root, originalRequest: "fix" });
    const invalid = { ...result, change_units: [], changed_files: [], commands_attempted: [{ command_id: "CMD-X", argv: ["npm", "test"], exit_code: 0, evidence_ref: "verification/x.json" }] };
    const codex: CodexAdapter = { invoke: async () => ({ text: JSON.stringify(invalid), parsed: invalid, exitCode: 0, promptPath: "prompt", stdoutPath: "stdout", stderrPath: "stderr", ...codexMetrics }) };
    await expect(runHandsFixPacket({ runDir: ledger.runDir, worktreePath: root, workItem: item, packet, actionAttempt: 1, intake: { ...intake, repo_root: root }, codex, relevantSourceContext: [], evidenceContext: [], completedDependencies: [], currentDiff: "", supplement: null })).rejects.toThrow(/required change unit|unknown command/i);
  });

  it("rejects an implemented claim that omits an expected changed file", async () => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-fix-worker-"));
    const ledger = await createRunLedgerV2({ repoRoot: root, originalRequest: "fix" });
    const invalid = { ...result, change_units: [{ ...result.change_units[0], changed_files: [] }], changed_files: [] };
    const codex: CodexAdapter = { invoke: async () => ({ text: JSON.stringify(invalid), parsed: invalid, exitCode: 0, promptPath: "prompt", stdoutPath: "stdout", stderrPath: "stderr", ...codexMetrics }) };
    await expect(runHandsFixPacket({ runDir: ledger.runDir, worktreePath: root, workItem: item, packet, actionAttempt: 1, intake: { ...intake, repo_root: root }, codex, relevantSourceContext: [], evidenceContext: [], completedDependencies: [], currentDiff: "", supplement: null })).rejects.toThrow(/expected changed files/i);
  });

  it("does not reinvoke Hands after an ambiguous packet invocation", async () => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-fix-worker-"));
    const ledger = await createRunLedgerV2({ repoRoot: root, originalRequest: "fix" });
    const base = { runDir: ledger.runDir, worktreePath: root, workItem: item, packet, actionAttempt: 1, intake: { ...intake, repo_root: root }, relevantSourceContext: [], evidenceContext: [], completedDependencies: [], currentDiff: "", supplement: null };
    await expect(runHandsFixPacket({ ...base, codex: { invoke: async () => { throw new Error("transport ended after dispatch"); } } })).rejects.toThrow(/transport ended/);
    let reinvocations = 0;
    await expect(runHandsFixPacket({ ...base, codex: { invoke: async () => { reinvocations += 1; return { text: JSON.stringify(result), parsed: result, exitCode: 0, promptPath: "p", stdoutPath: "o", stderrPath: "e", ...codexMetrics }; } }  })).rejects.toThrow(/ambiguous/i);
    expect(reinvocations).toBe(0);
  });

  it("reinvokes an exact started packet claim only with explicit diagnostic recovery authority", async () => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-fix-worker-"));
    const ledger = await createRunLedgerV2({ repoRoot: root, originalRequest: "fix" });
    const base = { runDir: ledger.runDir, worktreePath: root, workItem: item, packet, actionAttempt: 1, intake: { ...intake, repo_root: root }, relevantSourceContext: [], evidenceContext: [], completedDependencies: [], currentDiff: "", supplement: null };
    await expect(runHandsFixPacket({ ...base, codex: { invoke: async () => { throw new Error("transport ended after dispatch"); } } })).rejects.toThrow(/transport ended/);
    let reinvocations = 0;
    let recoveryArtifactName: string | undefined;
    let recoveryPrompt: string | undefined;

    const recovered = await runHandsFixPacket({
      ...base,
      recoverStartedInvocation: true,
      codex: { invoke: async (input) => {
        reinvocations += 1;
        recoveryArtifactName = input.artifactName;
        recoveryPrompt = input.prompt;
        return { text: JSON.stringify(result), parsed: result, exitCode: 0, promptPath: "p", stdoutPath: "o", stderrPath: "e", ...codexMetrics };
      } },
    });

    expect(recovered.result).toEqual(result);
    expect(reinvocations).toBe(1);
    expect(recoveryArtifactName).toMatch(/-resume-2$/);
    expect(recoveryPrompt).toContain(hashReviewFixPacket(packet));
    expect(recoveryPrompt).toContain("Do not invent packet command IDs");
  });

  it("reinvokes an exact operationally blocked packet into a separate immutable recovery result", async () => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-fix-worker-"));
    const ledger = await createRunLedgerV2({ repoRoot: root, originalRequest: "fix" });
    const blocked = {
      ...result,
      status: "operationally_blocked" as const,
      change_units: result.change_units.map((unit) => ({ ...unit, status: "not_completed" as const, changed_files: [] })),
      changed_files: [],
      blocker: { code: "DEPENDENCY_REGISTRY_UNAVAILABLE", message: "Registry unavailable", evidence_refs: [] },
    };
    const base = { runDir: ledger.runDir, worktreePath: root, workItem: item, packet, actionAttempt: 1, intake: { ...intake, repo_root: root }, relevantSourceContext: [], evidenceContext: [], completedDependencies: [], currentDiff: "", supplement: null };
    await runHandsFixPacket({ ...base, codex: new RecordingHands(blocked) });
    let reinvocations = 0;

    const recovered = await runHandsFixPacket({
      ...base,
      recoverStartedInvocation: true,
      codex: { invoke: async () => {
        reinvocations += 1;
        return { text: JSON.stringify(result), parsed: result, exitCode: 0, promptPath: "p", stdoutPath: "o", stderrPath: "e", ...codexMetrics };
      } },
    });

    expect(recovered.result.status).toBe("implemented");
    expect(recovered.reportPath).toMatch(/hands-result-recovery\.json$/);
    expect(reinvocations).toBe(1);
    const replayed = await runHandsFixPacket({ ...base, recoverStartedInvocation: true, codex: { invoke: async () => { throw new Error("must not reinvoke"); } } });
    expect(replayed.result.status).toBe("implemented");
  });

  it("resumes a legacy persisted primary claim and result without reinvoking Hands", async () => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-fix-worker-legacy-"));
    const ledger = await createRunLedgerV2({
      repoRoot: root,
      originalRequest: "fix",
      roleProfiles: intake.roles,
    });
    const base = {
      runDir: ledger.runDir, worktreePath: root, workItem: item, packet, actionAttempt: 1,
      intake: { ...intake, repo_root: root }, relevantSourceContext: [], evidenceContext: [],
      completedDependencies: [], currentDiff: "", supplement: null,
    };
    await runHandsFixPacket({ ...base, codex: new RecordingHands() });
    const claimPath = join(ledger.runDir, `${reviewFixPacketRoot("R1-A1")}/attempts/1/hands-invocation-claim.json`);
    const legacyClaim = JSON.parse(await readFile(claimPath, "utf8"));
    delete legacyClaim.profile_kind;
    await writeFile(claimPath, `${JSON.stringify(legacyClaim, null, 2)}\n`, "utf8");
    let reinvocations = 0;

    const resumed = await runHandsFixPacket({
      ...base,
      codex: { invoke: async () => { reinvocations += 1; throw new Error("must not reinvoke"); } },
    });

    expect(resumed.profile).toEqual({ kind: "primary", model: "hands", reasoning_effort: "medium" });
    expect(reinvocations).toBe(0);
  });

  it("rejects a legacy persisted claim that mismatches the snapshotted primary profile", async () => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-fix-worker-legacy-"));
    const ledger = await createRunLedgerV2({
      repoRoot: root,
      originalRequest: "fix",
      roleProfiles: intake.roles,
    });
    const base = {
      runDir: ledger.runDir, worktreePath: root, workItem: item, packet, actionAttempt: 1,
      intake: { ...intake, repo_root: root }, relevantSourceContext: [], evidenceContext: [],
      completedDependencies: [], currentDiff: "", supplement: null,
    };
    await runHandsFixPacket({ ...base, codex: new RecordingHands() });
    const claimPath = join(ledger.runDir, `${reviewFixPacketRoot("R1-A1")}/attempts/1/hands-invocation-claim.json`);
    const legacyClaim = JSON.parse(await readFile(claimPath, "utf8"));
    delete legacyClaim.profile_kind;
    legacyClaim.model = "different-hands";
    await writeFile(claimPath, `${JSON.stringify(legacyClaim, null, 2)}\n`, "utf8");

    await expect(runHandsFixPacket({ ...base, codex: new RecordingHands() }))
      .rejects.toThrow(/legacy.*snapshotted primary/i);
  });
});
