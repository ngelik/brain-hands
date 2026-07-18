import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DryRunGitHubAdapter } from "../../src/adapters/github.js";
import type { GitHubCommentReference, GitHubCommentTarget } from "../../src/adapters/github.js";
import { createRunLedgerV2, readManifestV2, updateManifestV2, writeTextArtifact } from "../../src/core/ledger.js";
import { recordDiscoveryQuestion } from "../../src/core/discovery-ledger.js";
import { transitionRun } from "../../src/core/ledger.js";
import type { BrainPlan, DiscoveryQuestion, VerificationEvidence, VerifierReview, WorkItem } from "../../src/core/types.js";
import { appendGitHubStatusIntent, readGitHubStatusCheckpoint, readGitHubStatusIntents } from "../../src/github/status-checkpoint.js";
import { eventMarker, statusMarker } from "../../src/github/status-projection.js";
import { replayGitHubStatusIntents } from "../../src/workflow/github-status.js";
import { executionSpec } from "../fixtures/execution-spec.js";

let root: string | undefined;
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = undefined; });

class IntentAwareGitHub extends DryRunGitHubAdapter {
  firstRemoteIntentCount: number | undefined;

  constructor(private readonly runDir: string) { super(); }

  override async findStatusCommentByMarker(target: GitHubCommentTarget, marker: string): Promise<GitHubCommentReference | null> {
    this.firstRemoteIntentCount ??= (await readGitHubStatusIntents(this.runDir)).length;
    return super.findStatusCommentByMarker(target, marker);
  }
}

class RecordingGitHub extends DryRunGitHubAdapter {
  readonly calls: unknown[] = [];

  override async findStatusCommentByMarker(target: GitHubCommentTarget, marker: string): Promise<GitHubCommentReference | null> {
    this.calls.push(["findStatusCommentByMarker", target, marker]);
    return super.findStatusCommentByMarker(target, marker);
  }

  override async createStatusComment(target: GitHubCommentTarget, body: string): Promise<GitHubCommentReference> {
    this.calls.push(["createStatusComment", target, body]);
    return super.createStatusComment(target, body);
  }
}

const item: WorkItem = {
  ...executionSpec("feature"),
  expected_artifacts: ["reports/feature.json"],
  browser_checks: [],
};
const plan: BrainPlan = {
  summary: "Deliver the feature",
  assumptions: [],
  research: [],
  research_sources: ["repository"],
  architecture: "focused",
  risks: [],
  work_items: [item],
  integration_verification: [["npm", "test"]],
};

function dryRunGithubWithIssues(issueNumbers: number[]): DryRunGitHubAdapter {
  return new DryRunGitHubAdapter({
    issues: issueNumbers.map((number) => ({
      number,
      title: `Issue ${number}`,
      body: `Issue ${number}`,
      state: "OPEN" as const,
      state_reason: null,
      labels: ["brain-hands:ready"],
    })),
  });
}

function evidence(issueNumber: number | undefined, path: string, workItemId = "feature"): VerificationEvidence {
  return {
    verification_scope: issueNumber === undefined ? "integrated" : "github",
    work_item_id: issueNumber === undefined ? "integrated" : workItemId,
    ...(issueNumber === undefined ? {} : { issue_number: issueNumber }),
    attempt: 1,
    evidence_path: path,
    commands: [{ command: "npm test", argv: ["npm", "test"], exit_code: 0, timed_out: false, error_code: null, error_message: null, signal: null, stdout_path: "out.txt", stderr_path: "err.txt" }],
    artifacts: [],
    artifact_checks: [{ path: "reports/feature.json", exists: true, required: true }],
    browser_evidence: [{
      name: "Feature page",
      url: "http://localhost:3000/feature",
      status: "passed",
      screenshot_artifact: "screenshots/feature.png",
      screenshot_exists: true,
      expected_network: [],
      observed_network: [],
      missing_network: [],
      console_errors: [],
      missing_selectors: [],
      failure_reasons: [],
      evidence_report_path: null,
      skipped_reason: null,
    }],
    created_at: "2026-07-11T16:25:00.000Z",
  } as VerificationEvidence;
}

function review(workItemId: string, final: boolean): VerifierReview {
  return {
    work_item_id: workItemId,
    attempt: 1,
    final,
    decision: "approve",
    acceptance_coverage: ["Feature works"],
    evidence_reviewed: ["npm test"],
    findings: [],
    residual_risks: [],
  };
}

function requestedChangesReview(): VerifierReview {
  return {
    ...review(item.id, false),
    decision: "request_changes",
    failure_class: "implementation_failure",
    blocker: null,
    blocker_code: null,
    findings: [{
      severity: "medium",
      file: "src/feature.ts",
      line: null,
      acceptance_criterion: "Feature works",
      problem_class: "correctness",
      problem: "Feature remains incomplete",
      required_fix: "Complete the feature",
      evidence_refs: ["reviews/source.json"],
      re_verification: [["npm", "test"]],
    }],
  };
}

describe("GitHub status workflow projection", () => {
  it("does not project private discovery content or work-item status at a local discovery boundary", async () => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-workflow-status-discovery-"));
    const ledger = await createRunLedgerV2({ repoRoot: root, originalRequest: "Private discovery", mode: "github" });
    await transitionRun(ledger.runDir, "preflight", { actor: "test" });
    await transitionRun(ledger.runDir, "brain_discovery", { actor: "test" });
    const question: DiscoveryQuestion = {
      id: "q-001", sequence: 1, category: "required",
      text: "Must PRIVATE-DISCOVERY-MARKER stay local?",
      choices: [{ id: "yes", label: "Yes", description: "Keep it local." }],
      rationale: "This sets the privacy boundary.", material_effects: ["architecture"],
      repository_evidence: ["src/workflow/github-status.ts"], essential_after_soft_limit: null,
    };
    await recordDiscoveryQuestion(ledger.runDir, question);
    let manifest = await readManifestV2(ledger.runDir);
    manifest = await updateManifestV2(ledger.runDir, {
      github_ids: { ...manifest.github_ids, issue_numbers: [7], work_item_issue_map: { feature: 7 } },
    });
    const github = new RecordingGitHub();

    await replayGitHubStatusIntents({ runDir: ledger.runDir, github, manifest, plan });

    expect(github.calls).toEqual([]);
    expect(JSON.stringify(github.calls)).not.toContain("PRIVATE-DISCOVERY-MARKER");
  });

  it("reconstructs missing issue and delivery intents from durable ledger progress", async () => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-workflow-status-"));
    const ledger = await createRunLedgerV2({ repoRoot: root, originalRequest: "Deliver feature", mode: "github" });
    const github = new IntentAwareGitHub(ledger.runDir);
    const issueNumber = await github.createIssue(item);
    const issueEvidencePath = "verification/issue-1/attempt-1/evidence.json";
    const issueReviewPath = "reviews/feature/attempt-1.json";
    const deliveryEvidencePath = "verification/integrated/attempt-1/evidence.json";
    const deliveryReviewPath = "reviews/integrated/final-attempt-1.json";
    await writeTextArtifact(ledger.runDir, issueEvidencePath, `${JSON.stringify(evidence(issueNumber, issueEvidencePath))}\n`);
    await writeTextArtifact(ledger.runDir, issueReviewPath, `${JSON.stringify(review(item.id, false))}\n`);
    await writeTextArtifact(ledger.runDir, deliveryEvidencePath, `${JSON.stringify(evidence(undefined, deliveryEvidencePath, "integrated"))}\n`);
    await writeTextArtifact(ledger.runDir, deliveryReviewPath, `${JSON.stringify(review("integrated", true))}\n`);
    const transitionAt = "2026-07-11T16:25:00.000Z";
    let manifest = await readManifestV2(ledger.runDir);
    manifest = await updateManifestV2(ledger.runDir, {
      workflow_protocol: "legacy-v2",
      discovery: null,
      github_ids: {
        ...manifest.github_ids,
        issue_numbers: [issueNumber],
        work_item_issue_map: { feature: issueNumber },
        pull_request_numbers: [42],
        pull_request_urls: { "42": "https://github.example/acme/repo/pull/42" },
      },
      stage: "delivery",
      work_item_progress: {
        feature: { status: "complete", attempts: 1, verification_path: issueEvidencePath, review_path: issueReviewPath, github_status_transition_at: transitionAt },
        integrated: { status: "complete", attempts: 1, verification_path: deliveryEvidencePath, review_path: deliveryReviewPath, github_status_transition_at: transitionAt },
      },
    });

    await replayGitHubStatusIntents({ runDir: ledger.runDir, github, manifest, plan });

    await expect(github.findStatusCommentByMarker!({ kind: "issue", number: issueNumber }, statusMarker(manifest.run_id, item.id)))
      .resolves.toMatchObject({ body: expect.stringContaining("**State:** Complete") });
    await expect(github.findStatusCommentByMarker!({ kind: "issue", number: issueNumber }, statusMarker(manifest.run_id, item.id)))
      .resolves.toMatchObject({ body: expect.stringContaining("Browser checks: not required") });
    await expect(github.findStatusCommentByMarker!({ kind: "issue", number: issueNumber }, statusMarker(manifest.run_id, item.id)))
      .resolves.toMatchObject({ body: expect.stringContaining("Required artifacts: 1 of 1 present") });
    await expect(github.findStatusCommentByMarker!({ kind: "pull_request", number: 42 }, eventMarker(manifest.run_id, "integrated", "delivered-for-review:pr-42:commit-no-op")))
      .resolves.toBeNull();
    await replayGitHubStatusIntents({ runDir: ledger.runDir, github, manifest, plan, publishIntegratedDelivery: true });
    await expect(github.findStatusCommentByMarker!({ kind: "pull_request", number: 42 }, eventMarker(manifest.run_id, "integrated", "delivered-for-review:pr-42:commit-no-op")))
      .resolves.toMatchObject({ body: expect.stringContaining("Delivered for review") });
    expect(github.firstRemoteIntentCount).toBe(2);
    expect(await readGitHubStatusIntents(ledger.runDir)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: `issue:${issueNumber}:feature:complete:attempt-1`, transitionAt }),
      expect.objectContaining({ id: "pull-request:42:delivery:no-op", transitionAt }),
    ]));
    await expect(github.getIssue(issueNumber)).resolves.toMatchObject({
      state: "OPEN",
      state_reason: null,
      labels: expect.arrayContaining(["brain-hands:ready"]),
    });
    expect((await github.getIssue(issueNumber)).labels).not.toContain("brain-hands:complete");
  });

  it("replays work-item positions in canonical dependency order", async () => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-workflow-status-order-"));
    const ledger = await createRunLedgerV2({ repoRoot: root, originalRequest: "Deliver dependent work", mode: "github" });
    const dependent: WorkItem = executionSpec("dependent", ["dependency"]);
    const dependency: WorkItem = executionSpec("dependency");
    const reversedPlan: BrainPlan = { ...plan, work_items: [dependent, dependency] };
    let manifest = await readManifestV2(ledger.runDir);
    manifest = await updateManifestV2(ledger.runDir, {
      github_ids: {
        ...manifest.github_ids,
        issue_numbers: [8, 7],
        work_item_issue_map: { dependent: 8, dependency: 7 },
      },
    });
    const github = dryRunGithubWithIssues([7, 8]);

    await replayGitHubStatusIntents({ runDir: ledger.runDir, github, manifest, plan: reversedPlan });

    await expect(github.findStatusCommentByMarker!(
      { kind: "issue", number: 7 },
      statusMarker(manifest.run_id, dependency.id),
    )).resolves.toMatchObject({ body: expect.stringContaining("(1 of 2)") });
    await expect(github.findStatusCommentByMarker!(
      { kind: "issue", number: 8 },
      statusMarker(manifest.run_id, dependent.id),
    )).resolves.toMatchObject({ body: expect.stringContaining("(2 of 2)") });
  });

  it("resolves top-level, nested, and mapless legacy work-item targets without positional modern-map fallback", async () => {
    const dependent: WorkItem = executionSpec("dependent", ["dependency"]);
    const independent: WorkItem = executionSpec("independent");
    const dependency: WorkItem = executionSpec("dependency");
    const mixedPlan: BrainPlan = { ...plan, work_items: [dependent, independent, dependency] };
    const roots: string[] = [];
    const replay = async (input: {
      issueNumbers: number[];
      topLevelMap: Record<string, number>;
      nestedMap: Record<string, number>;
    }) => {
      const repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-workflow-status-targets-"));
      roots.push(repoRoot);
      const ledger = await createRunLedgerV2({ repoRoot, originalRequest: "Deliver dependent work", mode: "github" });
      const base = await readManifestV2(ledger.runDir);
      const manifest: typeof base = {
        ...base,
        issue_numbers: input.issueNumbers,
        work_item_issue_map: input.topLevelMap,
        github_ids: { ...base.github_ids, issue_numbers: input.issueNumbers, work_item_issue_map: input.nestedMap },
      };
      const github = dryRunGithubWithIssues([101, 102, 103]);
      await replayGitHubStatusIntents({ runDir: ledger.runDir, github, manifest, plan: mixedPlan });
      return { github, manifest };
    };

    const topLevel = await replay({
      issueNumbers: [],
      topLevelMap: { dependency: 101, dependent: 102, independent: 103 },
      nestedMap: {},
    });
    await expect(topLevel.github.findStatusCommentByMarker!(
      { kind: "issue", number: 103 },
      statusMarker(topLevel.manifest.run_id, independent.id),
    )).resolves.not.toBeNull();

    const nested = await replay({
      issueNumbers: [],
      topLevelMap: {},
      nestedMap: { dependency: 101, dependent: 102, independent: 103 },
    });
    await expect(nested.github.findStatusCommentByMarker!(
      { kind: "issue", number: 102 },
      statusMarker(nested.manifest.run_id, dependent.id),
    )).resolves.not.toBeNull();

    const partial = await replay({ issueNumbers: [101, 102, 103], topLevelMap: { independent: 103 }, nestedMap: {} });
    await expect(partial.github.findStatusCommentByMarker!(
      { kind: "issue", number: 101 },
      statusMarker(partial.manifest.run_id, dependent.id),
    )).resolves.toBeNull();

    const legacy = await replay({ issueNumbers: [101, 102, 103], topLevelMap: {}, nestedMap: {} });
    await expect(legacy.github.findStatusCommentByMarker!(
      { kind: "issue", number: 102 },
      statusMarker(legacy.manifest.run_id, dependent.id),
    )).resolves.not.toBeNull();

    await Promise.all(roots.map((repoRoot) => rm(repoRoot, { recursive: true, force: true })));
  });

  it("builds deep mapless legacy compatibility resolution once per replay", async () => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-workflow-status-legacy-context-"));
    const ledger = await createRunLedgerV2({ repoRoot: root, originalRequest: "Replay deep legacy status", mode: "github" });
    let dependencyReads = 0;
    const ordered = Array.from({ length: 25 }, (_, index) => {
      const dependencies = index === 0 ? [] : [`node-${index - 1}`];
      const spec = executionSpec(`node-${index}`, dependencies);
      Object.defineProperty(spec, "dependencies", {
        configurable: true,
        enumerable: true,
        get: () => {
          dependencyReads += 1;
          return dependencies;
        },
      });
      return spec;
    });
    const legacyPlan: BrainPlan = { ...plan, work_items: [...ordered].reverse() };
    const base = await readManifestV2(ledger.runDir);
    const manifest: typeof base = {
      ...base,
      issue_numbers: Array.from({ length: ordered.length }, (_, index) => index + 1),
      work_item_issue_map: {},
      github_ids: {
        ...base.github_ids,
        issue_numbers: Array.from({ length: ordered.length }, (_, index) => index + 1),
        work_item_issue_map: {},
      },
    };
    const github = dryRunGithubWithIssues(Array.from({ length: ordered.length }, (_, index) => index + 1));

    await replayGitHubStatusIntents({ runDir: ledger.runDir, github, manifest, plan: legacyPlan });

    expect(dependencyReads).toBeLessThanOrEqual(ordered.length * 4);
    await expect(github.findStatusCommentByMarker!(
      { kind: "issue", number: 25 },
      statusMarker(manifest.run_id, "node-24"),
    )).resolves.toMatchObject({ body: expect.stringContaining("(25 of 25)") });
  });

  it("uses the persisted Verifier attempt for a reconstructed requested-changes event", async () => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-workflow-status-"));
    const ledger = await createRunLedgerV2({ repoRoot: root, originalRequest: "Deliver feature", mode: "github" });
    const github = new DryRunGitHubAdapter();
    const issueNumber = await github.createIssue(item);
    const reviewPath = "reviews/feature/attempt-1.json";
    await writeTextArtifact(ledger.runDir, reviewPath, `${JSON.stringify(requestedChangesReview())}\n`);
    let manifest = await readManifestV2(ledger.runDir);
    manifest = await updateManifestV2(ledger.runDir, {
      stage: "fixing",
      current_work_item_id: item.id,
      github_ids: { ...manifest.github_ids, issue_numbers: [issueNumber], work_item_issue_map: { feature: issueNumber } },
      work_item_progress: {
        feature: { status: "in_progress", attempts: 2, review_path: reviewPath },
      },
    });

    await replayGitHubStatusIntents({ runDir: ledger.runDir, github, manifest, plan });

    await expect(github.findStatusCommentByMarker!(
      { kind: "issue", number: issueNumber },
      eventMarker(manifest.run_id, item.id, "reviewer-findings:feature:attempt-1"),
    )).resolves.not.toBeNull();
    await expect(github.findStatusCommentByMarker!(
      { kind: "issue", number: issueNumber },
      eventMarker(manifest.run_id, item.id, "reviewer-findings:feature:attempt-2"),
    )).resolves.toBeNull();
  });

  it("replays immutable events with their originating evidence and review", async () => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-workflow-status-"));
    const ledger = await createRunLedgerV2({ repoRoot: root, originalRequest: "Deliver feature", mode: "github" });
    const github = new DryRunGitHubAdapter();
    const issueNumber = await github.createIssue(item);
    const failedEvidencePath = "verification/issue-7/attempt-1/evidence.json";
    const passedEvidencePath = "verification/issue-7/attempt-2/evidence.json";
    const changesReviewPath = "reviews/feature/attempt-1.json";
    const approvedReviewPath = "reviews/feature/attempt-2.json";
    const failedEvidence = {
      ...evidence(issueNumber, failedEvidencePath),
      commands: [{ ...evidence(issueNumber, failedEvidencePath).commands[0]!, exit_code: 1 }],
    };
    const passedEvidence = { ...evidence(issueNumber, passedEvidencePath), attempt: 2 };
    const approvedReview = { ...review(item.id, false), attempt: 2 };
    await writeTextArtifact(ledger.runDir, failedEvidencePath, `${JSON.stringify(failedEvidence)}\n`);
    await writeTextArtifact(ledger.runDir, passedEvidencePath, `${JSON.stringify(passedEvidence)}\n`);
    await writeTextArtifact(ledger.runDir, changesReviewPath, `${JSON.stringify(requestedChangesReview())}\n`);
    await writeTextArtifact(ledger.runDir, approvedReviewPath, `${JSON.stringify(approvedReview)}\n`);
    const transitionAt = "2026-07-11T16:25:00.000Z";
    let manifest = await readManifestV2(ledger.runDir);
    manifest = await updateManifestV2(ledger.runDir, {
      workflow_protocol: "legacy-v2",
      discovery: null,
      stage: "delivery",
      github_ids: { ...manifest.github_ids, issue_numbers: [issueNumber], work_item_issue_map: { feature: issueNumber } },
      work_item_progress: {
        feature: { status: "complete", attempts: 2, verification_path: passedEvidencePath, review_path: approvedReviewPath, github_status_transition_at: transitionAt },
      },
    });
    await appendGitHubStatusIntent(ledger.runDir, {
      version: 1, id: `issue:${issueNumber}:feature:blocked:attempt-1`, target: { kind: "issue", number: issueNumber },
      runId: manifest.run_id, workItemId: item.id, state: "blocked", attempt: 1, transitionAt,
      evidencePath: failedEvidencePath, materialEvents: [{ kind: "verification_blocked", attempt: 1 }],
    });
    await appendGitHubStatusIntent(ledger.runDir, {
      version: 1, id: `issue:${issueNumber}:feature:fixing:attempt-2`, target: { kind: "issue", number: issueNumber },
      runId: manifest.run_id, workItemId: item.id, state: "fixing", attempt: 2, transitionAt,
      reviewPath: changesReviewPath, materialEvents: [{ kind: "reviewer_findings", attempt: 1 }],
    });
    await appendGitHubStatusIntent(ledger.runDir, {
      version: 1, id: `issue:${issueNumber}:feature:complete:attempt-2`, target: { kind: "issue", number: issueNumber },
      runId: manifest.run_id, workItemId: item.id, state: "complete", attempt: 2, transitionAt,
      evidencePath: passedEvidencePath, reviewPath: approvedReviewPath, materialEvents: [],
    });
    await appendGitHubStatusIntent(ledger.runDir, {
      version: 1, id: `issue:${issueNumber}:feature:implementing:attempt-2`, target: { kind: "issue", number: issueNumber },
      runId: manifest.run_id, workItemId: item.id, state: "implementing", attempt: 2, transitionAt,
      materialEvents: [],
    });

    await replayGitHubStatusIntents({ runDir: ledger.runDir, github, manifest, plan });

    await expect(github.findStatusCommentByMarker!(
      { kind: "issue", number: issueNumber },
      eventMarker(manifest.run_id, item.id, "verification-blocked:feature:attempt-1"),
    )).resolves.toMatchObject({ body: expect.stringContaining("`npm test`: failed") });
    await expect(github.findStatusCommentByMarker!(
      { kind: "issue", number: issueNumber },
      eventMarker(manifest.run_id, item.id, "reviewer-findings:feature:attempt-1"),
    )).resolves.toMatchObject({ body: expect.stringContaining("Findings recorded: 1") });
    await expect(github.findStatusCommentByMarker!(
      { kind: "issue", number: issueNumber },
      statusMarker(manifest.run_id, item.id),
    )).resolves.toMatchObject({ body: expect.stringContaining("**State:** Complete") });
  });

  it("records an honest retry when a fresh dry-run replay adapter has no mapped issue observation", async () => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-workflow-status-"));
    const ledger = await createRunLedgerV2({ repoRoot: root, originalRequest: "Replay feature", mode: "github" });
    const manifest = await updateManifestV2(ledger.runDir, {
      github_ids: { ...(await readManifestV2(ledger.runDir)).github_ids, issue_numbers: [7], work_item_issue_map: { feature: 7 } },
    });

    await replayGitHubStatusIntents({ runDir: ledger.runDir, github: new DryRunGitHubAdapter(), manifest, plan });

    expect((await readGitHubStatusCheckpoint(ledger.runDir)).targets["issue:7:feature"]).toMatchObject({
      retry: { class: "issue_observation" },
    });
  });
});
