import { describe, expect, it } from "vitest";
import type { HandsBackupPolicy, VerifierReview, WorkItemProgress } from "../../src/core/types.js";
import { buildHandsRecoveryPacket, decideNextHandsAction, legacyQualityRecoveryAttempts } from "../../src/workflow/hands-recovery.js";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { approvePlanRevision, createRunLedgerV2, recordPlan, updateManifestV2 } from "../../src/core/ledger.js";
import { runHandsWorkItem } from "../../src/workflow/worker.js";
import { buildHandsContext, loadRoleContext } from "../../src/workflow/role-context.js";
import { executionSpec } from "../fixtures/execution-spec.js";
const codexMetrics = { usage: null, durationMs: 0, processStarted: false, turnStarted: false, structuredTerminalError: false } as const;

const backup: HandsBackupPolicy = { fallback_on_primary_usage_limit: true, max_quality_recovery_attempts: 1, profile: { model: "backup", reasoning_effort: "medium" } };
const review: VerifierReview = {
  work_item_id: "item-1", attempt: 1, final: false, decision: "request_changes", failure_class: "implementation_failure", blocker: null,
  acceptance_coverage: [], evidence_reviewed: [], findings: [{ severity: "medium", file: "src/item.ts", line: 1, acceptance_criterion: "works", problem: "fails", required_fix: "fix", re_verification: [["npm", "test"]] }], residual_risks: [],
};

describe("Hands recovery policy", () => {
  it("uses primary fixes before one quality recovery", () => {
    expect(decideNextHandsAction({ review, primaryFixAttempts: 0, qualityRecoveryAttempts: 0, activeProfile: "primary", backup })).toEqual({ kind: "primary_fix", profile: "primary" });
    expect(decideNextHandsAction({ review, primaryFixAttempts: 3, qualityRecoveryAttempts: 0, activeProfile: "primary", backup })).toEqual({ kind: "quality_recovery", profile: "backup" });
    expect(decideNextHandsAction({ review, primaryFixAttempts: 3, qualityRecoveryAttempts: 0, activeProfile: "backup", backup })).toEqual({ kind: "block", blockerCode: "escalation_exhausted" });
  });

  it("keeps the full legacy recovery sequence bounded to three primary fixes and one backup recovery", () => {
    const actions = [0, 1, 2, 3].map((primaryFixAttempts) => decideNextHandsAction({
      review,
      primaryFixAttempts,
      qualityRecoveryAttempts: 0,
      activeProfile: "primary",
      backup,
    }));
    actions.push(decideNextHandsAction({
      review,
      primaryFixAttempts: 3,
      qualityRecoveryAttempts: 1,
      activeProfile: "primary",
      backup,
    }));

    expect(actions).toEqual([
      { kind: "primary_fix", profile: "primary" },
      { kind: "primary_fix", profile: "primary" },
      { kind: "primary_fix", profile: "primary" },
      { kind: "quality_recovery", profile: "backup" },
      { kind: "block", blockerCode: "escalation_exhausted" },
    ]);
  });

  it.each([
    ["past the exact primary limit", 4, 0, "primary", backup],
    ["already used", 3, 1, "primary", backup],
    ["not configured", 3, 0, "primary", undefined],
  ] as const)("keeps legacy quality recovery ineligible when it is %s", (_name, primaryFixAttempts, qualityRecoveryAttempts, activeProfile, configuredBackup) => {
    expect(decideNextHandsAction({
      review,
      primaryFixAttempts,
      qualityRecoveryAttempts,
      activeProfile,
      backup: configuredBackup,
    })).toEqual({ kind: "block", blockerCode: "escalation_exhausted" });
  });

  it("derives bounded legacy quality usage only from durable work-item progress", () => {
    expect(legacyQualityRecoveryAttempts(undefined)).toBe(0);
    expect(legacyQualityRecoveryAttempts({ status: "in_progress", attempts: 4 } as WorkItemProgress)).toBe(0);
    expect(legacyQualityRecoveryAttempts({
      status: "in_progress",
      attempts: 5,
      quality_recovery_attempts: 1,
    } as WorkItemProgress)).toBe(1);
  });

  it("builds bounded context without raw transcripts", () => {
    const packet = buildHandsRecoveryPacket({ workItem: { id: "item/1", acceptance: [{ id: "AC-1", statement: "works", satisfied_by: ["CH-1"] }], forbidden_changes: [{ path: "other", except: [], reason: "out of scope" }] }, currentDiff: "diff", latestFindings: review.findings, attempts: [{ ordinal: 1, outcome: "request_changes" }], verificationPaths: ["verification/evidence.json"], changedFiles: ["src/item.ts", "src/item.ts", "src/other.ts"], commandsAttempted: [["npm", "test"], ["npm", "test"], ["npm", "test", "--", "unit"]], rawTranscript: "secret transcript" });
    expect(packet).toContain("works");
    expect(packet).toContain("verification/evidence.json");
    expect(packet).toContain("src/item.ts");
    expect(packet).toContain('["npm","test"]');
    const changedFiles = JSON.parse(packet.split("\n## Changed files\n")[1]!.split("\n## Commands attempted\n")[0]!) as string[];
    const commands = JSON.parse(packet.split("\n## Commands attempted\n")[1]!.split("\nForm an independent diagnosis")[0]!) as string[][];
    expect(changedFiles).toEqual(["src/item.ts", "src/other.ts"]);
    expect(commands).toEqual([["npm", "test"], ["npm", "test", "--", "unit"]]);
    expect(packet).not.toContain("secret transcript");
  });

  it("renders bounded quality recovery from only its immutable Hands context", async () => {
    const root = await mkdtemp(join(tmpdir(), "brain-hands-recovery-context-"));
    try {
      const ledger = await createRunLedgerV2({ repoRoot: root, originalRequest: "recover" });
      const workItem = executionSpec("item-1");
      await updateManifestV2(ledger.runDir, { workflow_protocol: "bounded-context-v1" });
      const recorded = await recordPlan(ledger.runDir, JSON.stringify({
        summary: "Bounded recovery plan",
        assumptions: [], research: [], research_sources: ["repo"], architecture: "local", risks: [],
        work_items: [workItem], integration_verification: [],
      }));
      await approvePlanRevision(ledger.runDir, recorded.revision);
      const contextRef = await buildHandsContext({
        runDir: ledger.runDir, workItemId: workItem.id, planRevision: recorded.revision,
        attempt: 3, attemptKind: "quality_recovery", workItem, diff: "COMPLETE_RECOVERY_DIFF_SENTINEL",
      });
      const context = await loadRoleContext(ledger.runDir, contextRef, "hands");
      let prompt = "";
      await runHandsWorkItem({
        runDir: ledger.runDir,
        worktreePath: root,
        workItem,
        intake: {
          task: "recover", repo_root: root, mode: "local", research: false, reflection: false,
          models: { brain: "brain", hands: "hands", verifier: "verifier" },
          resolved_models: { brain: "brain", hands: "hands", verifier: "verifier" },
          roles: {
            brain: { model: "brain", reasoning_effort: "high", sandbox: "read-only" },
            hands: { model: "hands", reasoning_effort: "medium", sandbox: "workspace-write" },
            verifier: { model: "verifier", reasoning_effort: "high", sandbox: "read-only" },
          },
        },
        codex: { invoke: async (input) => {
          prompt = input.prompt;
          const parsed = { work_item_id: "item-1", changed_files: [], tests_added_or_changed: [], commands_attempted: [], completed_steps: ["recovered"], remaining_risks: [] };
          return { text: JSON.stringify(parsed), parsed, exitCode: 0, promptPath: "prompt", stdoutPath: "stdout", stderrPath: "stderr" , ...codexMetrics };
        } },
        attempt: 3,
        attemptKind: "quality_recovery",
        contextPlanRevision: recorded.revision,
        findings: review.findings,
        diagnosticContext: "LEGACY_RECOVERY_DIAGNOSTIC_SENTINEL",
        contextRef,
        context,
      });
      expect(prompt).toContain("# Hands recovery attempt");
      expect(prompt).toContain(contextRef.path);
      expect(prompt).toContain("COMPLETE_RECOVERY_DIFF_SENTINEL");
      expect(prompt).not.toContain("LEGACY_RECOVERY_DIAGNOSTIC_SENTINEL");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
