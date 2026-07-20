import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CANONICAL_REVIEW_POLICY, DEFAULT_RELEASE_GUARDS, resolveReviewPolicy } from "../../src/core/config.js";
import type { CreateRunLedgerV2Input, RunLedgerV2 } from "../../src/core/ledger.js";
import { runManifestV2Schema } from "../../src/core/schema.js";
import type { ResolvedRunIntake, RoleName, RoleProfile, RunIntake, RunManifestV2, RunMode } from "../../src/core/types.js";

/** Test-only constructor for historical manifests that predate dedicated checkout transactions. */
export async function rewriteLegacyCheckoutSnapshot(
  runDir: string,
  patch: Pick<RunManifestV2, "source_commit" | "worktree_path" | "branch_name"> & {
    checkout_allocation_state?: RunManifestV2["checkout_allocation_state"];
  },
): Promise<RunManifestV2> {
  const manifestPath = join(runDir, "manifest.json");
  const current = runManifestV2Schema.parse(JSON.parse(await readFile(manifestPath, "utf8")));
  const nextControllerProvenance = patch.source_commit === null
    ? undefined
    : current.controller_provenance != null
      && patch.source_commit !== undefined
      ? { ...current.controller_provenance, candidate_commit: patch.source_commit }
      : current.controller_provenance;
  const rawNext: Record<string, unknown> = {
    ...current,
    ...patch,
    updated_at: new Date().toISOString(),
  };
  if (nextControllerProvenance == null) delete rawNext.controller_provenance;
  else rawNext.controller_provenance = nextControllerProvenance;
  const next = runManifestV2Schema.parse(rawNext);
  await writeFile(manifestPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

/** Test-only downgrade for fixtures that need historical protocol semantics with current lineage state. */
export async function rewriteLegacyWorkflowProtocol(runDir: string): Promise<RunManifestV2> {
  const manifestPath = join(runDir, "manifest.json");
  const current = runManifestV2Schema.parse(JSON.parse(await readFile(manifestPath, "utf8")));
  const next = runManifestV2Schema.parse({ ...current, workflow_protocol: "legacy-v2" });
  await writeFile(manifestPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

function inputValues(input: CreateRunLedgerV2Input): {
  repoRoot: string;
  originalRequest: string;
  mode: RunMode;
  roleProfiles: Partial<Record<RoleName, RoleProfile>>;
  intake: RunIntake | ResolvedRunIntake;
} {
  const intake = input.intake;
  const repoRoot = input.repoRoot ?? input.repo_root ?? intake?.repo_root;
  const originalRequest = input.originalRequest ?? input.original_request ?? input.task ?? intake?.task;
  if (!repoRoot || !originalRequest) throw new Error("repoRoot and originalRequest are required");
  const mode = input.mode ?? input.runMode ?? intake?.mode ?? "local";
  const roleProfiles = input.roleProfiles ?? input.roles ?? input.selectedRoleProfiles
    ?? input.selected_role_profiles ?? ("roles" in (intake ?? {}) ? (intake as ResolvedRunIntake).roles : {});
  return { repoRoot, originalRequest, mode, roleProfiles, intake: intake ?? { task: originalRequest, repo_root: repoRoot } };
}

/** Persist a historical pre-discovery v2 run without first creating a durable-discovery run. */
export async function createLegacyRunLedgerV2(input: CreateRunLedgerV2Input): Promise<RunLedgerV2> {
  const values = inputValues(input);
  const now = input.now ?? new Date();
  const runId = `${now.toISOString().replaceAll(":", "-").replace(".", "-")}-${input.slug ?? "workflow-run"}`;
  const runDir = join(values.repoRoot, ".brain-hands", "runs", runId);
  const createdAt = now.toISOString();
  const intake = { ...values.intake, task: values.intake.task || values.originalRequest, repo_root: values.repoRoot, mode: values.mode };
  const reviewPolicySnapshot = resolveReviewPolicy(
    CANONICAL_REVIEW_POLICY.max_fix_cycles,
    undefined,
    "review_policy" in intake ? intake.review_policy : undefined,
  );
  const persistedReviewPolicy = intake.review_policy === undefined ? undefined : { ...intake.review_policy } as Record<string, unknown>;
  delete persistedReviewPolicy?.policy_revision;
  const persistedIntake = persistedReviewPolicy === undefined ? intake : { ...intake, review_policy: persistedReviewPolicy };
  const manifest = runManifestV2Schema.parse({
    version: 2,
    schema_version: 2,
    run_id: runId,
    original_request: values.originalRequest,
    repo_root: values.repoRoot,
    created_at: createdAt,
    updated_at: createdAt,
    stage: "intake",
    workflow_protocol: "legacy-v2",
    discovery: null,
    current_work_item_id: null,
    retry_counts: {},
    issue_numbers: [],
    pull_request_numbers: [],
    events: ["events.jsonl"],
    current_revision: null,
    approved_revision: null,
    current_plan_revision: null,
    approved_plan_revision: null,
    plan_revisions: {},
    role_profiles: values.roleProfiles,
    selected_role_profiles: values.roleProfiles,
    mode: values.mode,
    run_mode: values.mode,
    active_hands_profile: "primary",
    backup_activation_reason: null,
    quality_gate_policy: "quality_gate" in intake ? intake.quality_gate ?? null : null,
    hands_backup_policy: "hands_backup" in intake ? intake.hands_backup ?? null : null,
    hands_backup_catalog: null,
    review_policy_snapshot: reviewPolicySnapshot,
    ...("warning_continuation_authority" in intake && intake.warning_continuation_authority?.source === "run_override"
      ? { warning_continuation_authority: { actor: "run-intake", source: "run_override" as const } }
      : {}),
    release_guards: DEFAULT_RELEASE_GUARDS.map((guard) => ({ ...guard })),
    review_accounting: { review_revision: 0, fix_cycles_used: 0, self_review_mutations_used: 0, plan_revision: 0 },
    source_commit: input.sourceCommit ?? input.sourceCommitSha ?? input.source_commit ?? null,
    ...(input.controllerProvenance ? { controller_provenance: input.controllerProvenance } : {}),
    worktree_path: input.worktreePath ?? input.worktree_path ?? null,
    branch_name: input.branchName ?? input.branch_name ?? null,
    work_item_progress: {},
    work_item_issue_map: {},
    github_ids: {
      issue_numbers: input.githubIds?.issueNumbers ?? input.github_ids?.issue_numbers ?? [],
      work_item_issue_map: {},
      parent_issue_number: null,
      pull_request_numbers: input.githubIds?.pullRequestNumbers ?? input.github_ids?.pull_request_numbers ?? [],
      pull_request_urls: {},
    },
    delivery_state: "pending",
    assurance_outcome: null,
    assurance_assessment_path: null,
    risk_acceptance_path: null,
    risk_acceptance_history: [],
    abandonment_path: null,
    terminal: null,
    final_artifact_paths: input.finalArtifactPaths ?? input.final_artifact_paths ?? [],
    last_blocker: null,
    intake_path: "intake.json",
  });

  await mkdir(join(values.repoRoot, ".brain-hands", "runs"), { recursive: true });
  await mkdir(runDir, { recursive: false });
  for (const directory of ["plans", "prompts", "responses", "schemas", "implementation", "verification", "reviews", "findings", "assurance"]) {
    await mkdir(join(runDir, directory), { recursive: true });
  }
  await writeFile(join(runDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  await writeFile(join(runDir, "intake.json"), JSON.stringify(persistedIntake, null, 2), "utf8");
  await writeFile(join(runDir, "original-request.md"), `${values.originalRequest}\n`, "utf8");
  await writeFile(join(runDir, "events.jsonl"), "", "utf8");
  await writeFile(join(runDir, "progress.jsonl"), "", "utf8");
  return { runId, runDir, manifest };
}
