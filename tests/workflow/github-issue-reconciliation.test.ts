import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyIssueEffectPreview,
  completeIssueReconciliation,
  readIssueSyncCheckpoint,
  reconcileIssueMutation,
} from "../../src/workflow/github-issue-reconciliation.js";
import { issueObservationMatchesDesired } from "../../src/github/issue-reconciliation.js";
import { createTaskLineage, readTaskLineage, withTaskLineageTransaction } from "../../src/core/task-lineage.js";
import type { GithubEffectPreviewV1 } from "../../src/github/effect-plan.js";
import { planIssueSyncPreview, writeGithubEffectPreview, type DesiredIssueMaterial, type ObservedIssueMaterial } from "../../src/github/effect-plan.js";
import type {
  ResourceBudgetClaimInput,
  ResourceBudgetClaimV1,
  ResourceBudgetCompletionInput,
  ResourceBudgetPort,
  ResourceBudgetUsage,
} from "../../src/core/resource-budget.js";

let root: string | undefined;
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = undefined; });

function recordingBudget(): ResourceBudgetPort & {
  claims: ResourceBudgetClaimV1[];
  completions: ResourceBudgetCompletionInput[];
} {
  const claims: ResourceBudgetClaimV1[] = [];
  const completions: ResourceBudgetCompletionInput[] = [];
  const usage: ResourceBudgetUsage = {
    model_invocations: 0,
    workflow_attempts: 0,
    total_tokens: 0,
    cached_input_tokens: 0,
    reasoning_output_tokens: 0,
    active_elapsed_ms: 0,
    external_effects: 0,
    token_accounting: "known",
    uncertain_model_claim_ids: [],
    token_overshoot: 0,
  };
  return {
    claims,
    completions,
    usage: async () => usage,
    remainingActiveElapsedMs: async () => 1_000,
    claim: async (input: ResourceBudgetClaimInput) => {
      const claim: ResourceBudgetClaimV1 = {
        schema_version: 1,
        claim_id: `budget-claim:${String(claims.length + 1).repeat(64).slice(0, 64)}`,
        run_id: "run-1",
        kind: input.kind,
        key: input.key,
        reserved_at: "2026-07-17T00:00:00.000Z",
        elapsed_reservation_ms: input.elapsed_reservation_ms,
      };
      claims.push(claim);
      return claim;
    },
    complete: async (input: ResourceBudgetCompletionInput) => {
      completions.push(input);
      return { schema_version: 1, completed_at: "2026-07-17T00:00:01.000Z", ...input };
    },
    runWorkflowAttempt: async (_key, action) => action(),
  };
}

describe("GitHub issue reconciliation", () => {
  it("authenticates immutable preview bytes before any target callback", async () => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-lineage-issue-apply-"));
    const lineageId = "11111111-1111-4111-8111-111111111111";
    await createTaskLineage({ repoRoot: root, runId: "run-1", lineageId, repositoryKey: "github.com/acme/repo" });
    const preview = issuePreview(lineageId);
    await attachPreview(root, lineageId, preview);
    const forged = { ...preview, desired_sha256: "f".repeat(64) };
    let callbacks = 0;

    await expect(applyIssueEffectPreview({
      repoRoot: root, runDir: root, lineageId, runId: "run-1", repositoryKey: "github.com/acme/repo", preview: forged,
      targets: { "work_item:feature": { effect: preview.effects[0]! as never, desired: desiredIssue("Desired"),
        lookup: async () => { callbacks += 1; return []; }, create: async () => { callbacks += 1; return 17; }, update: async () => { callbacks += 1; } } },
    })).rejects.toThrow(/immutable|artifact|preview/i);
    expect(callbacks).toBe(0);
  });

  it("re-authenticates preview bytes under the lineage lock before any target callback", async () => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-lineage-issue-apply-"));
    const lineageId = "11111111-1111-4111-8111-111111111111";
    await createTaskLineage({ repoRoot: root, runId: "run-1", lineageId, repositoryKey: "github.com/acme/repo" });
    const preview = issuePreview(lineageId);
    const reference = await attachPreview(root, lineageId, preview);
    let callbacks = 0;

    await expect(applyIssueEffectPreview({
      repoRoot: root, runDir: root, lineageId, runId: "run-1", repositoryKey: "github.com/acme/repo", preview,
      hooks: { beforeLockedArtifactVerification: async () => {
        await writeFile(join(root!, reference.path), `${JSON.stringify({ ...preview, created_at: "2026-07-18T00:00:00.000Z" }, null, 2)}\n`, "utf8");
      } },
      targets: { "work_item:feature": { effect: preview.effects[0]! as never, desired: desiredIssue("Desired"),
        lookup: async () => { callbacks += 1; return []; }, create: async () => { callbacks += 1; return 17; }, update: async () => { callbacks += 1; } } },
    })).rejects.toThrow(/digest|immutable|preview/i);
    expect(callbacks).toBe(0);
  });

  it("rechecks a fresh create after intent and adopts an exact issue that appeared after batch preflight", async () => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-lineage-issue-apply-"));
    const lineageId = "11111111-1111-4111-8111-111111111111";
    await createTaskLineage({ repoRoot: root, runId: "run-1", lineageId, repositoryKey: "github.com/acme/repo" });
    const desired = desiredIssue("Desired"); const preview = issuePreview(lineageId); await attachPreview(root, lineageId, preview);
    let lookups = 0; let creates = 0;
    const result = await applyIssueEffectPreview({ repoRoot: root, lineageId, runId: "run-1", repositoryKey: "github.com/acme/repo", preview,
      targets: { "work_item:feature": { effect: preview.effects[0]! as never, desired,
        lookup: async () => ++lookups === 1 ? [] : [observedIssue(17, desired)], create: async () => { creates += 1; return 18; }, update: async () => undefined } },
    });
    expect(result).toMatchObject({ outcome: "applied", work_item_issue_map: { feature: 17 } });
    expect({ lookups, creates }).toEqual({ lookups: 2, creates: 0 });
  });

  it.each([0, 2] as const)("handles %i post-intent create matches without duplicate creation", async (matchCount) => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-lineage-issue-apply-")); const lineageId = "11111111-1111-4111-8111-111111111111";
    await createTaskLineage({ repoRoot: root, runId: "run-1", lineageId, repositoryKey: "github.com/acme/repo" }); const desired = desiredIssue("Desired"); const preview = issuePreview(lineageId); await attachPreview(root, lineageId, preview);
    let lookups = 0; let creates = 0; const matches = Array.from({ length: matchCount }, (_, index) => observedIssue(17 + index, desired));
    const result = await applyIssueEffectPreview({ repoRoot: root, lineageId, runId: "run-1", repositoryKey: "github.com/acme/repo", preview,
      targets: { "work_item:feature": { effect: preview.effects[0]! as never, desired, lookup: async () => ++lookups === 1 ? [] : matches, create: async () => { creates += 1; return 19; }, update: async () => undefined } } });
    expect(result.outcome).toBe(matchCount === 0 ? "applied" : "ambiguous");
    expect(creates).toBe(matchCount === 0 ? 1 : 0);
  });

  it("does not persist ready when the proposed mapping collides with a historical operation", async () => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-lineage-issue-apply-")); const lineageId = "11111111-1111-4111-8111-111111111111";
    await createTaskLineage({ repoRoot: root, runId: "run-1", lineageId, repositoryKey: "github.com/acme/repo" }); const desired = desiredIssue("Desired"); const preview = issuePreview(lineageId); await attachPreview(root, lineageId, preview);
    await withTaskLineageTransaction({ repoRoot: root, lineageId, operation: (transaction) => transaction.update({ ...transaction.read(), issue_set: { ...transaction.read().issue_set,
      operations: { historical: { operation_id: "historical", target_key: "work_item:old", desired_sha256: "a".repeat(64), state: "complete", issue_number: 17, created_by_run_id: "run-1" } } } }) });
    await expect(applyIssueEffectPreview({ repoRoot: root, lineageId, runId: "run-1", repositoryKey: "github.com/acme/repo", preview,
      targets: { "work_item:feature": { effect: preview.effects[0]! as never, desired, lookup: async () => [], create: async () => 17, update: async () => undefined } } }))
      .rejects.toThrow("Historical issue operation collides");
    expect((await readTaskLineage(root, lineageId)).issue_set).toMatchObject({ state: "applying", preview: { state: "previewed" } });
  });
  it("requires exact created material and permits only preserved user text for an updated issue", () => {
    const desired = desiredIssue("Desired");
    const exact = observedIssue(7, desired);
    expect(issueObservationMatchesDesired(exact, desired, false)).toBe(true);
    expect(issueObservationMatchesDesired({ ...exact, title: "stale" }, desired, false)).toBe(false);
    expect(issueObservationMatchesDesired({ ...exact, body: "stale" }, desired, false)).toBe(false);
    expect(issueObservationMatchesDesired({ ...exact, labels: [] }, desired, false)).toBe(false);
    expect(issueObservationMatchesDesired({ ...exact, state: "CLOSED", state_reason: "COMPLETED" }, desired, false)).toBe(false);
    const withUserText = { ...exact, body: `${exact.body}User-authored notes\n` };
    expect(issueObservationMatchesDesired(withUserText, desired, false)).toBe(false);
    expect(issueObservationMatchesDesired(withUserText, desired, true)).toBe(true);
  });
  it("preflights every pending target before the first remote mutation", async () => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-lineage-issue-apply-"));
    const lineageId = "11111111-1111-4111-8111-111111111111";
    await createTaskLineage({ repoRoot: root, runId: "run-1", lineageId, repositoryKey: "github.com/acme/repo" });
    const desired = desiredIssue("Desired");
    const preview = multiCreatePreview(lineageId, ["first", "second"], desired);
    await attachPreview(root, lineageId, preview);
    let mutations = 0;
    const duplicate = observedIssue(21, desired);

    const result = await applyIssueEffectPreview({
      repoRoot: root, lineageId, runId: "run-1", repositoryKey: "github.com/acme/repo", preview,
      targets: Object.fromEntries(preview.effects.map((effect, index) => {
        const key = `work_item:${(effect.target as { work_item_id: string }).work_item_id}`;
        return [key, {
          effect: effect as Extract<typeof effect, { target: { kind: "work_item" } }>,
          desired,
          lookup: async () => index === 0 ? [] : [duplicate, { ...duplicate, number: 22 }],
          create: async () => { mutations += 1; return 30 + index; },
          update: async () => { mutations += 1; },
        }];
      })),
    });

    expect(result).toEqual({ outcome: "ambiguous", target_key: "work_item:second" });
    expect(mutations).toBe(0);
    expect(Object.keys((await readTaskLineage(root, lineageId)).issue_set.operations)).toEqual([preview.effects[1]!.effect_id]);
  });

  it.each([
    ["title", (issue: ObservedIssueMaterial) => ({ ...issue, title: "drifted" })],
    ["body", (issue: ObservedIssueMaterial) => ({ ...issue, body: `${issue.body}drift` })],
    ["labels", (issue: ObservedIssueMaterial) => ({ ...issue, labels: [...issue.labels, "drift"] })],
    ["state", (issue: ObservedIssueMaterial) => ({ ...issue, state: "CLOSED" as const, state_reason: "COMPLETED" as const })],
  ])("blocks all mutations when a later target has %s drift", async (_field, drift) => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-lineage-issue-apply-"));
    const lineageId = "11111111-1111-4111-8111-111111111111";
    await createTaskLineage({ repoRoot: root, runId: "run-1", lineageId, repositoryKey: "github.com/acme/repo" });
    const desired = desiredIssue("Desired");
    const old = desiredIssue("Old");
    const preview = mixedPreview(lineageId, desired, observedIssue(21, old));
    await attachPreview(root, lineageId, preview);
    let mutations = 0;

    await expect(applyIssueEffectPreview({
      repoRoot: root, lineageId, runId: "run-1", repositoryKey: "github.com/acme/repo", preview,
      targets: {
        "work_item:first": { effect: preview.effects[0]! as never, desired, lookup: async () => [], create: async () => { mutations += 1; return 20; }, update: async () => { mutations += 1; } },
        "work_item:second": { effect: preview.effects[1]! as never, desired, lookup: async () => [drift(observedIssue(21, old))], create: async () => { mutations += 1; return 22; }, update: async () => { mutations += 1; } },
      },
    })).rejects.toThrow("preflight drift");
    expect(mutations).toBe(0);
  });

  it("resumes after the first completed target without observing or mutating it again", async () => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-lineage-issue-apply-"));
    const lineageId = "11111111-1111-4111-8111-111111111111";
    await createTaskLineage({ repoRoot: root, runId: "run-1", lineageId, repositoryKey: "github.com/acme/repo" });
    const desired = desiredIssue("Desired");
    const preview = multiCreatePreview(lineageId, ["first", "second"], desired);
    await attachPreview(root, lineageId, preview);
    const creates: string[] = [];
    let firstLookups = 0;
    let crash = true;
    const targets = Object.fromEntries(preview.effects.map((effect) => {
      const id = (effect.target as { work_item_id: string }).work_item_id;
      return [`work_item:${id}`, {
        effect: effect as Extract<typeof effect, { target: { kind: "work_item" } }>, desired,
        lookup: async () => { if (id === "first") firstLookups += 1; return []; },
        create: async () => { creates.push(id); return id === "first" ? 31 : 32; },
        update: async () => { throw new Error("unexpected update"); },
      }];
    }));

    await expect(applyIssueEffectPreview({
      repoRoot: root, lineageId, runId: "run-1", repositoryKey: "github.com/acme/repo", preview, targets,
      hooks: { afterTargetComplete: async (targetKey: string) => { if (crash && targetKey === "work_item:first") { crash = false; throw new Error("crash after first complete"); } } },
    } as never)).rejects.toThrow("crash after first complete");
    expect((await readTaskLineage(root, lineageId)).issue_set.operations[preview.effects[0]!.effect_id]).toMatchObject({ state: "complete", issue_number: 31 });

    const result = await applyIssueEffectPreview({ repoRoot: root, lineageId, runId: "run-1", repositoryKey: "github.com/acme/repo", preview, targets });
    expect(result).toMatchObject({ outcome: "applied", work_item_issue_map: { first: 31, second: 32 } });
    expect(creates).toEqual(["first", "second"]);
    expect(firstLookups).toBe(2);
  });

  it("makes an unknown update result ambiguous and never retries it on resume", async () => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-lineage-issue-apply-"));
    const lineageId = "11111111-1111-4111-8111-111111111111";
    await createTaskLineage({ repoRoot: root, runId: "run-1", lineageId, repositoryKey: "github.com/acme/repo" });
    const desired = desiredIssue("Desired");
    const old = desiredIssue("Old");
    const preview = updatePreview(lineageId, desired, observedIssue(21, old));
    await attachPreview(root, lineageId, preview);
    let updates = 0;
    const target = {
      effect: preview.effects[0]! as Extract<(typeof preview.effects)[number], { target: { kind: "work_item" } }>, desired,
      lookup: async () => [observedIssue(21, old)], create: async () => { throw new Error("unexpected create"); },
      update: async () => { updates += 1; throw new Error("unknown update result"); },
    };

    expect(await applyIssueEffectPreview({ repoRoot: root, lineageId, runId: "run-1", repositoryKey: "github.com/acme/repo", preview, targets: { "work_item:second": target } }))
      .toEqual({ outcome: "ambiguous", target_key: "work_item:second" });
    expect(await applyIssueEffectPreview({ repoRoot: root, lineageId, runId: "run-1", repositoryKey: "github.com/acme/repo", preview, targets: { "work_item:second": target } }))
      .toEqual({ outcome: "ambiguous", target_key: "work_item:second" });
    expect(updates).toBe(1);
  });

  it.each(["terminal lineage", "active run mismatch", "repository mismatch"] as const)("rejects %s before mutation", async (kind) => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-lineage-issue-apply-"));
    const lineageId = "11111111-1111-4111-8111-111111111111";
    await createTaskLineage({ repoRoot: root, runId: "run-1", lineageId, repositoryKey: "github.com/acme/repo" });
    const desired = desiredIssue("Desired");
    const preview = issuePreview(lineageId);
    await attachPreview(root, lineageId, preview);
    if (kind !== "repository mismatch") {
      await withTaskLineageTransaction({ repoRoot: root, lineageId, operation: (transaction) => transaction.update({
        ...transaction.read(), ...(kind === "terminal lineage" ? { state: "abandoned" as const } : { active_run_id: "run-2", run_ids: [...transaction.read().run_ids, "run-2"] }),
      }) });
    }
    let mutations = 0;
    await expect(applyIssueEffectPreview({
      repoRoot: root, lineageId, runId: "run-1", repositoryKey: kind === "repository mismatch" ? "github.com/other/repo" : "github.com/acme/repo", preview,
      targets: { "work_item:feature": { effect: preview.effects[0]! as never, desired, lookup: async () => [], create: async () => { mutations += 1; return 17; }, update: async () => { mutations += 1; } } },
    })).rejects.toThrow(/exact lineage|Terminal task lineage/);
    expect(mutations).toBe(0);
  });

  it("rejects duplicate operation ownership for one immutable target", async () => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-lineage-issue-apply-"));
    const lineageId = "11111111-1111-4111-8111-111111111111";
    await createTaskLineage({ repoRoot: root, runId: "run-1", lineageId, repositoryKey: "github.com/acme/repo" });
    const desired = desiredIssue("Desired");
    const preview = issuePreview(lineageId);
    await attachPreview(root, lineageId, preview);
    await withTaskLineageTransaction({ repoRoot: root, lineageId, operation: (transaction) => transaction.update({
      ...transaction.read(), issue_set: { ...transaction.read().issue_set, operations: { duplicate: { operation_id: "duplicate", target_key: "work_item:feature", desired_sha256: preview.effects[0]!.desired_sha256, state: "intent", issue_number: null, created_by_run_id: "run-1" } } },
    }) });
    let mutations = 0;
    await expect(applyIssueEffectPreview({ repoRoot: root, lineageId, runId: "run-1", repositoryKey: "github.com/acme/repo", preview,
      targets: { "work_item:feature": { effect: preview.effects[0]! as never, desired, lookup: async () => [], create: async () => { mutations += 1; return 17; }, update: async () => { mutations += 1; } } },
    })).rejects.toThrow("Multiple issue operations");
    expect(mutations).toBe(0);
  });

  it("persists lineage create intent before one mutation and completes the authoritative mapping", async () => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-lineage-issue-apply-"));
    const lineageId = "11111111-1111-4111-8111-111111111111";
    await createTaskLineage({ repoRoot: root, runId: "run-1", lineageId, repositoryKey: "github.com/acme/repo" });
    const preview = issuePreview(lineageId);
    await attachPreview(root, lineageId, preview);
    let observedIntent = false;
    const desired = desiredIssue("Desired");
    let remote: ObservedIssueMaterial[] = [];

    const result = await applyIssueEffectPreview({
      repoRoot: root,
      lineageId,
      runId: "run-1",
      repositoryKey: "github.com/acme/repo",
      preview,
      targets: {
        "work_item:feature": {
          effect: preview.effects[0]! as Extract<(typeof preview.effects)[number], { target: { kind: "work_item" } }>,
          desired,
          lookup: async () => remote,
          create: async () => {
            observedIntent = Object.values((await readTaskLineage(root!, lineageId)).issue_set.operations)
              .some((operation) => operation.state === "intent");
            remote = [observedIssue(17, desired)];
            return 17;
          },
          update: async () => { throw new Error("unexpected update"); },
        },
      },
    });

    expect(observedIntent).toBe(true);
    expect(result).toEqual({ outcome: "applied", parent_issue_number: null, work_item_issue_map: { feature: 17 } });
    expect(await readTaskLineage(root, lineageId)).toMatchObject({
      issue_set: {
        state: "ready",
        work_item_issue_map: { feature: 17 },
        operations: { [preview.effects[0]!.effect_id]: { state: "complete", issue_number: 17 } },
      },
    });
  });

  it.each([
    ["applied state missing", (record: any, effectId: string) => ({ ...record, issue_set: { ...record.issue_set, preview: { ...record.issue_set.preview, state: "previewed" } } })],
    ["missing operation", (record: any) => ({ ...record, issue_set: { ...record.issue_set, operations: {} } })],
    ["operation mapping mismatch", (record: any) => ({ ...record, issue_set: { ...record.issue_set, work_item_issue_map: { feature: 99 } } })],
    ["duplicate mapping", (record: any) => ({ ...record, issue_set: { ...record.issue_set, work_item_issue_map: { feature: 17, extra: 17 } } })],
    ["missing mapping", (record: any) => ({ ...record, issue_set: { ...record.issue_set, work_item_issue_map: {} } })],
    ["extra mapping", (record: any) => ({ ...record, issue_set: { ...record.issue_set, work_item_issue_map: { feature: 17, extra: 18 } } })],
    ["wrong run", (record: any, effectId: string) => ({ ...record, run_ids: [...record.run_ids, "run-2"], issue_set: { ...record.issue_set, operations: { [effectId]: { ...record.issue_set.operations[effectId], created_by_run_id: "run-2" } } } })],
    ["wrong desired hash", (record: any, effectId: string) => ({ ...record, issue_set: { ...record.issue_set, operations: { [effectId]: { ...record.issue_set.operations[effectId], desired_sha256: "f".repeat(64) } } } })],
  ])("rejects a schema-valid inconsistent ready lineage: %s", async (_case, mutate) => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-lineage-issue-apply-"));
    const lineageId = "11111111-1111-4111-8111-111111111111";
    await createTaskLineage({ repoRoot: root, runId: "run-1", lineageId, repositoryKey: "github.com/acme/repo" });
    const preview = issuePreview(lineageId);
    const desired = desiredIssue("Desired");
    await attachPreview(root, lineageId, preview);
    const targets = { "work_item:feature": { effect: preview.effects[0]! as never, desired, lookup: async () => [], create: async () => 17, update: async () => undefined } };
    await applyIssueEffectPreview({ repoRoot: root, lineageId, runId: "run-1", repositoryKey: "github.com/acme/repo", preview, targets });
    await withTaskLineageTransaction({ repoRoot: root, lineageId, operation: (transaction) => transaction.update(mutate(transaction.read(), preview.effects[0]!.effect_id)) });
    await expect(applyIssueEffectPreview({ repoRoot: root, lineageId, runId: "run-1", repositoryKey: "github.com/acme/repo", preview, targets }))
      .rejects.toThrow("ready issue set");
  });

  it("never creates when a prior create intent has zero matches and records ambiguity", async () => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-lineage-issue-apply-"));
    const lineageId = "11111111-1111-4111-8111-111111111111";
    await createTaskLineage({ repoRoot: root, runId: "run-1", lineageId, repositoryKey: "github.com/acme/repo" });
    const preview = issuePreview(lineageId);
    await attachPreview(root, lineageId, preview);
    let crash = true;
    await expect(applyIssueEffectPreview({
      repoRoot: root, lineageId, runId: "run-1", repositoryKey: "github.com/acme/repo", preview,
      hooks: { afterRemoteMutation: async () => { if (crash) { crash = false; throw new Error("simulated crash"); } } },
      targets: { "work_item:feature": { effect: preview.effects[0]! as Extract<(typeof preview.effects)[number], { target: { kind: "work_item" } }>, desired: desiredIssue("Desired"), lookup: async () => [], create: async () => 17, update: async () => undefined } },
    })).rejects.toThrow("simulated crash");
    let creates = 0;
    const result = await applyIssueEffectPreview({
      repoRoot: root, lineageId, runId: "run-1", repositoryKey: "github.com/acme/repo", preview,
      targets: { "work_item:feature": { effect: preview.effects[0]! as Extract<(typeof preview.effects)[number], { target: { kind: "work_item" } }>, desired: desiredIssue("Desired"), lookup: async () => [], create: async () => { creates += 1; return 18; }, update: async () => undefined } },
    });
    expect(result).toEqual({ outcome: "ambiguous", target_key: "work_item:feature" });
    expect(creates).toBe(0);
  });
  it("returns created across an interrupted event boundary, then records later no-ops only in the checkpoint", async () => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-issue-reconcile-"));
    let issue: { number: number; title: string; body: string } | null = null;
    let creates = 0;
    const budget = recordingBudget();

    const first = await reconcileIssueMutation({
      runDir: root,
      targetKey: "work-item:BH-001",
      desiredHash: "a".repeat(64),
      found: null,
      matchesDesired: false,
      create: async () => { creates += 1; issue = { number: 42, title: "Desired", body: "Desired" }; return 42; },
      update: async () => { throw new Error("unexpected update"); },
      budget,
    });
    expect(first).toMatchObject({ outcome: "created", issue_number: 42 });
    expect(budget.claims.map(({ kind, key }) => ({ kind, key }))).toEqual([
      { kind: "external_effect", key: `github-issue:work-item:BH-001:${"a".repeat(64)}:created` },
    ]);
    expect(budget.completions).toHaveLength(1);

    const recovered = await reconcileIssueMutation({
      runDir: root,
      targetKey: "work-item:BH-001",
      desiredHash: "a".repeat(64),
      found: issue,
      matchesDesired: true,
      create: async () => { throw new Error("unexpected duplicate create"); },
      update: async () => { throw new Error("unexpected update"); },
      budget,
    });
    expect(recovered).toEqual(first);
    expect(creates).toBe(1);

    await completeIssueReconciliation(root, recovered);
    const noop = await reconcileIssueMutation({
      runDir: root,
      targetKey: "work-item:BH-001",
      desiredHash: "a".repeat(64),
      found: issue,
      matchesDesired: true,
      create: async () => { throw new Error("unexpected duplicate create"); },
      update: async () => { throw new Error("unexpected update"); },
      budget,
    });
    expect(noop).toMatchObject({ outcome: "noop", issue_number: 42 });
    expect((await readIssueSyncCheckpoint(root)).targets["work-item:BH-001"]).toMatchObject({
      last_outcome: "noop",
      issue_number: 42,
      operation_state: "complete",
    });
    expect(budget.claims).toHaveLength(1);
  });

  it("returns updated and preserves the first resolved timestamp across subsequent no-op checks", async () => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-issue-reconcile-"));
    const found = { number: 9, title: "Old", body: "Old" };
    let updates = 0;
    const updated = await reconcileIssueMutation({
      runDir: root,
      targetKey: "parent:feature",
      desiredHash: "b".repeat(64),
      found,
      matchesDesired: false,
      create: async () => { throw new Error("unexpected create"); },
      update: async () => { updates += 1; found.title = "New"; found.body = "New"; },
      now: () => "2026-07-12T10:00:00.000Z",
    });
    expect(updated.outcome).toBe("updated");
    await completeIssueReconciliation(root, updated, () => "2026-07-12T10:00:01.000Z");
    const firstResolvedAt = (await readIssueSyncCheckpoint(root)).targets["parent:feature"]?.first_resolved_at;

    const noop = await reconcileIssueMutation({
      runDir: root,
      targetKey: "parent:feature",
      desiredHash: "b".repeat(64),
      found,
      matchesDesired: true,
      create: async () => { throw new Error("unexpected create"); },
      update: async () => { throw new Error("unexpected update"); },
      now: () => "2026-07-12T10:01:00.000Z",
    });
    expect(noop.outcome).toBe("noop");
    expect(updates).toBe(1);
    expect((await readIssueSyncCheckpoint(root)).targets["parent:feature"]?.first_resolved_at).toBe(firstResolvedAt);
  });

  it("recovers a create that succeeded externally before its issue number was checkpointed", async () => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-issue-reconcile-"));
    const externallyCreated = { number: 77, title: "Desired", body: "Desired" };
    await expect(reconcileIssueMutation({
      runDir: root,
      targetKey: "work-item:BH-077",
      desiredHash: "c".repeat(64),
      found: null,
      matchesDesired: false,
      create: async () => { throw new Error("interrupted after external success"); },
      update: async () => { throw new Error("unexpected update"); },
    })).rejects.toThrow("interrupted after external success");

    const recovered = await reconcileIssueMutation({
      runDir: root,
      targetKey: "work-item:BH-077",
      desiredHash: "c".repeat(64),
      found: externallyCreated,
      matchesDesired: true,
      create: async () => { throw new Error("unexpected duplicate create"); },
      update: async () => { throw new Error("unexpected update"); },
    });

    expect(recovered).toMatchObject({ outcome: "created", issue_number: 77 });
    expect((await readIssueSyncCheckpoint(root)).targets["work-item:BH-077"]).toMatchObject({
      operation_state: "pending",
      issue_number: 77,
      last_outcome: "created",
    });
  });

  it("quarantines a corrupt observational checkpoint and continues from empty state", async () => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-issue-reconcile-"));
    await writeFile(join(root, "github-issue-sync.json"), "not json\n", "utf8");
    expect(await readIssueSyncCheckpoint(root)).toEqual({ version: 1, targets: {} });
    const files = (await import("node:fs/promises")).readdir(root);
    expect((await files).some((name) => name.startsWith("github-issue-sync.json.corrupt-"))).toBe(true);
    await expect(readFile(join(root, "github-issue-sync.json"), "utf8")).rejects.toThrow("ENOENT");
  });
});

function issuePreview(lineageId: string): GithubEffectPreviewV1 {
  return multiCreatePreview(lineageId, ["feature"], desiredIssue("Desired"));
}

function desiredIssue(title: string): DesiredIssueMaterial {
  return { title, body: `<!-- brain-hands-managed:start -->\n${title}\n<!-- brain-hands-managed:end -->\n`, labels: ["brain-hands"], state: "OPEN", state_reason: null, reason_code: "approved-plan-work-item" };
}

function observedIssue(number: number, desired: DesiredIssueMaterial): ObservedIssueMaterial {
  return { number, title: desired.title, body: desired.body, labels: desired.labels, state: desired.state, state_reason: desired.state_reason };
}

function multiCreatePreview(lineageId: string, ids: string[], desired: DesiredIssueMaterial): GithubEffectPreviewV1 {
  return planIssueSyncPreview({
    revision: 1, lineage_id: lineageId, run_id: "run-1", repository: { host: "github.com", name_with_owner: "acme/repo" },
    plan_revision: 1, plan_sha256: "a".repeat(64), created_at: "2026-07-16T19:00:00.000Z", lineage_state: "active",
    issue_set: { state: "uninitialized", plan_revision: null, plan_sha256: null, parent_issue_number: null, work_item_issue_map: {}, has_prior_owned_state: false },
    approved_replan: false, parent: null, work_items: ids.map((work_item_id) => ({ work_item_id, desired, observations: [] })),
  });
}

function mixedPreview(lineageId: string, desired: DesiredIssueMaterial, observed: ObservedIssueMaterial): GithubEffectPreviewV1 {
  return planIssueSyncPreview({
    revision: 1, lineage_id: lineageId, run_id: "run-1", repository: { host: "github.com", name_with_owner: "acme/repo" },
    plan_revision: 1, plan_sha256: "a".repeat(64), created_at: "2026-07-16T19:00:00.000Z", lineage_state: "active",
    issue_set: { state: "uninitialized", plan_revision: null, plan_sha256: null, parent_issue_number: null, work_item_issue_map: {}, has_prior_owned_state: false },
    approved_replan: false, parent: null,
    work_items: [
      { work_item_id: "first", desired, observations: [] },
      { work_item_id: "second", desired, observations: [observed] },
    ],
  });
}

function updatePreview(lineageId: string, desired: DesiredIssueMaterial, observed: ObservedIssueMaterial): GithubEffectPreviewV1 {
  const preview = mixedPreview(lineageId, desired, observed);
  return planIssueSyncPreview({
    revision: 1, lineage_id: lineageId, run_id: "run-1", repository: { host: "github.com", name_with_owner: "acme/repo" },
    plan_revision: 1, plan_sha256: "a".repeat(64), created_at: preview.created_at, lineage_state: "active",
    issue_set: { state: "uninitialized", plan_revision: null, plan_sha256: null, parent_issue_number: null, work_item_issue_map: {}, has_prior_owned_state: false },
    approved_replan: false, parent: null, work_items: [{ work_item_id: "second", desired, observations: [observed] }],
  });
}

async function attachPreview(repoRoot: string, lineageId: string, preview: GithubEffectPreviewV1) {
  const reference = await writeGithubEffectPreview({ run_dir: repoRoot, preview });
  await withTaskLineageTransaction({ repoRoot, lineageId, operation: (transaction) => transaction.update({
    ...transaction.read(),
    issue_set: {
      ...transaction.read().issue_set,
      plan_revision: preview.plan_revision,
      plan_sha256: preview.plan_sha256,
      preview: reference,
    },
  }) });
  return reference;
}
