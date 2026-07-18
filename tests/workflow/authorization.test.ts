import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { createRunLedgerV2, transitionRun, updateManifestV2, writeTextArtifact } from "../../src/core/ledger.js";
import { defaultConfig } from "../../src/core/config.js";
import { resolvedRunConfigurationSchema, serializeRunConfiguration } from "../../src/core/run-configuration.js";
import { recordAndApprovePinnedInitialPlan } from "../fixtures/pinned-plan.js";
import { executionSpec } from "../fixtures/execution-spec.js";
import type { EngineFinding, ResolvedRunIntake, ReviewPolicy } from "../../src/core/types.js";
import {
  loadOrCreateWarningAuthorization,
  warningAuthorizationPath,
} from "../../src/workflow/authorization.js";

const policy: ReviewPolicy = {
  policy_revision: 2,
  max_fix_cycles: 0,
  on_limit: "continue_with_warning",
  auto_advance_on_approval: true,
  severity_defaults: { critical: "blocking", high: "blocking", medium: "fix_in_scope", low: "advisory" },
  pause_on: ["plan_approval", "unresolved_release_blocker"],
};
const intake: ResolvedRunIntake = {
  task: "authorize", repo_root: "/tmp/repo", mode: "local", research: false, reflection: false,
  models: { brain: "brain", hands: "hands", verifier: "verifier" },
  resolved_models: { brain: "brain", hands: "hands", verifier: "verifier" },
  roles: {
    brain: { model: "brain", reasoning_effort: "high", sandbox: "read-only" },
    hands: { model: "hands", reasoning_effort: "medium", sandbox: "workspace-write" },
    verifier: { model: "verifier", reasoning_effort: "high", sandbox: "read-only" },
  },
  review_policy: policy,
  warning_continuation_authority: { actor: "release-manager", source: "run_override" },
};
function finding(severity: EngineFinding["severity"] = "medium", source: EngineFinding["source"] = "verifier"): EngineFinding {
  return {
    finding_id: `finding:${"a".repeat(64)}`, work_item_id: "BH-001",
    criterion_ref: source === "release_guard" ? "release:no-secrets" : "BH-001:AC-1",
    source, normalized_location: "src/a.ts:1", problem_class: "correctness",
    severity, disposition: "fix_in_scope", first_seen_revision: 1, last_seen_revision: 1,
    occurrences: 1, problem: "problem", required_fix: "fix", evidence_refs: ["verification/evidence.json"],
  };
}

let root: string | undefined;
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = undefined; });

describe("warning continuation authorization artifacts", () => {
  it("rejects forged approved-plan authority during programmatic run creation", async () => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-authorization-"));
    await expect(createRunLedgerV2({
      repoRoot: root,
      originalRequest: intake.task,
      intake: {
        ...intake,
        repo_root: root,
        warning_continuation_authority: { actor: "attacker", source: "approved_plan" },
      },
    })).rejects.toThrow(/only be derived by the plan approval transition/i);
  });

  it("writes one immutable, exactly bound record and reuses it on replay", async () => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-authorization-"));
    const ledger = await createRunLedgerV2({ repoRoot: root, originalRequest: intake.task, intake: { ...intake, repo_root: root } });
    const first = await loadOrCreateWarningAuthorization({
      run_dir: ledger.runDir, work_item_id: "BH-001", review_revision: 1,
      policy, findings: [finding()], evidence_snapshot: ["reviews/BH-001/attempt-1.json", "verification/evidence.json"],
    });
    const replay = await loadOrCreateWarningAuthorization({
      run_dir: ledger.runDir, work_item_id: "BH-001", review_revision: 1,
      policy, findings: [finding()], evidence_snapshot: ["verification/evidence.json", "reviews/BH-001/attempt-1.json"],
    });

    expect(replay).toEqual(first);
    expect(first).toMatchObject({
      actor: "run-intake", source: "run_override", policy_revision: 2,
      finding_ids: [finding().finding_id],
    });
    expect(JSON.parse(await readFile(join(ledger.runDir, warningAuthorizationPath("BH-001", 1)), "utf8"))).toEqual(first);
    await expect(updateManifestV2(ledger.runDir, {
      warning_continuation_authority: { actor: "attacker", source: "approved_plan" },
    } as never)).rejects.toThrow(/immutable run snapshot/i);
    await expect(writeTextArtifact(
      ledger.runDir,
      warningAuthorizationPath("BH-001", 1),
      "{}\n",
    )).rejects.toThrow(/immutable/i);
    await expect(loadOrCreateWarningAuthorization({
      run_dir: ledger.runDir, work_item_id: "BH-001", review_revision: 1,
      policy, findings: [{ ...finding(), finding_id: `finding:${"b".repeat(64)}` }], evidence_snapshot: ["verification/evidence.json"],
    })).rejects.toThrow(/provenance|binding|different/i);
  });

  it("does not derive authority from a repository default before plan approval", async () => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-authorization-"));
    const controllerProvenance = {
      self_hosting: false,
      mode: "development_checkout" as const,
      executable_path: "/test/brain-hands",
      package_root: "/test/package",
      package_name: "@ngelik/brain-hands",
      package_version: "0.4.0",
      package_hash_algorithm: "sha256" as const,
      package_hash: "a".repeat(64),
      candidate_commit: "b".repeat(40),
    };
    const runIntake = { ...intake, repo_root: root, warning_continuation_authority: undefined };
    const ledger = await createRunLedgerV2({
      repoRoot: root,
      originalRequest: "default",
      intake: runIntake,
      controllerProvenance,
      sourceCommit: controllerProvenance.candidate_commit,
    });
    const defaults = defaultConfig();
    const runConfiguration = resolvedRunConfigurationSchema.parse({
      version: 1,
      repository: root,
      mode: "local",
      research: false,
      reflection: false,
      controller: { package_name: "@ngelik/brain-hands", package_version: "0.4.0", mode: "development_checkout" },
      roles: Object.fromEntries(Object.entries(intake.roles).map(([name, profile]) => [name, { ...profile, source: "repository_config" }])),
      hands_backup: null,
      limits: {
        max_hands_fix_attempts: defaults.retry_policy.max_hands_fix_attempts,
        max_replan_attempts: defaults.retry_policy.max_replan_attempts,
        review_policy: policy,
        quality_gate: null,
      },
      github: { effects: "none", default_remote: "origin" },
    });
    await writeFile(join(ledger.runDir, "run-configuration.json"), serializeRunConfiguration(runConfiguration));
    await expect(loadOrCreateWarningAuthorization({
      run_dir: ledger.runDir, work_item_id: "BH-001", review_revision: 1,
      policy, findings: [finding()], evidence_snapshot: ["verification/evidence.json"],
    })).resolves.toBeNull();

    await transitionRun(ledger.runDir, "preflight");
    await transitionRun(ledger.runDir, "brain_discovery");
    await recordAndApprovePinnedInitialPlan(ledger.runDir, {
      summary: "Authorize warning continuation",
      assumptions: [],
      research: [],
      research_sources: ["repo"],
      architecture: "local",
      risks: [],
      work_items: [executionSpec("BH-001")],
      integration_verification: [["npm", "test"]],
    }, async () => ({ provenance: controllerProvenance, selfHosting: false }));
    await expect(loadOrCreateWarningAuthorization({
      run_dir: ledger.runDir, work_item_id: "BH-001", review_revision: 1,
      policy, findings: [finding()], evidence_snapshot: ["verification/evidence.json"],
    })).resolves.toMatchObject({ actor: "human", source: "approved_plan" });
  });

  it("rejects critical/high release blockers and symlinked authorization parents", async () => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-authorization-"));
    const ledger = await createRunLedgerV2({ repoRoot: root, originalRequest: intake.task, intake: { ...intake, repo_root: root } });
    await expect(loadOrCreateWarningAuthorization({
      run_dir: ledger.runDir, work_item_id: "BH-001", review_revision: 1,
      policy, findings: [finding("high", "release_guard")], evidence_snapshot: ["verification/evidence.json"],
    })).rejects.toThrow(/release blocker/i);
    const outside = await mkdtemp(join(tmpdir(), "brain-hands-authorization-outside-"));
    await symlink(outside, join(ledger.runDir, "authorizations"));
    await expect(loadOrCreateWarningAuthorization({
      run_dir: ledger.runDir, work_item_id: "BH-001", review_revision: 2,
      policy, findings: [finding()], evidence_snapshot: ["verification/evidence.json"],
    })).rejects.toThrow(/symlink/i);
    await rm(outside, { recursive: true, force: true });
  });
});
