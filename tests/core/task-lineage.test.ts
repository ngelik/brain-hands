import { access, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRunLedgerV2, updateManifestV2 } from "../../src/core/ledger.js";
import {
  attachMissingNewRunLineage,
  createTaskLineage,
  deriveLegacyTaskLineageId,
  ensureProducingTaskLineage,
  readTaskLineage,
  taskLineagePath,
  taskLineageRecordV1Schema,
  transitionTaskLineage,
  withTaskLineageTransaction,
} from "../../src/core/task-lineage.js";
import { createLegacyRunLedgerV2 } from "../fixtures/legacy-run.js";

let repoRoot: string | null = null;
const lineageId = "946c7414-d500-4e65-a596-dcf99f0015c2";
const now = new Date("2026-07-16T12:00:00.000Z");

afterEach(async () => {
  if (repoRoot) await rm(repoRoot, { recursive: true, force: true });
  repoRoot = null;
});

async function makeRepo(): Promise<string> {
  repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-lineage-"));
  return repoRoot;
}

function lease(pid: number, host = hostname()): string {
  return `${JSON.stringify({
    token: "946c7414-d500-4e65-a596-dcf99f0015c3",
    host,
    pid,
    created_at: "2000-01-01T00:00:00.000Z",
  })}\n`;
}

describe("task lineage authority", () => {
  it("creates the exact initial repository-local record", async () => {
    const root = await makeRepo();
    const record = await createTaskLineage({ repoRoot: root, runId: "run-a", lineageId, now });

    expect(record).toMatchObject({
      version: 1,
      lineage_id: lineageId,
      repository_key: null,
      root_run_id: "run-a",
      active_run_id: "run-a",
      run_ids: ["run-a"],
      state: "active",
      issue_set: { state: "uninitialized", work_item_issue_map: {}, operations: {}, preview: null },
      delivery: { state: "uninitialized", pull_request_number: null, preview: null },
      cleanup_state: "not_required",
    });
    expect(await readTaskLineage(root, lineageId)).toEqual(record);
    expect(JSON.parse(await readFile(taskLineagePath(root, lineageId), "utf8"))).toEqual(record);
    expect(() => taskLineagePath(root, "../../outside")).toThrow(/uuid/i);
    expect(() => taskLineageRecordV1Schema.parse({ ...record, extra: true })).toThrow();
  });

  it("admits one concurrent creator without overwriting its state", async () => {
    const root = await makeRepo();
    const results = await Promise.allSettled([
      createTaskLineage({ repoRoot: root, runId: "run-a", lineageId, now }),
      createTaskLineage({ repoRoot: root, runId: "run-b", lineageId, now }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(String(rejected && "reason" in rejected ? rejected.reason : "")).toContain("already exists");
    const winner = await readTaskLineage(root, lineageId);
    expect(["run-a", "run-b"]).toContain(winner.root_run_id);
    expect(winner.run_ids).toEqual([winner.root_run_id]);
  });

  it("recovers a dead same-host lease", async () => {
    const root = await makeRepo();
    const directory = join(root, ".brain-hands", "task-lineages", lineageId);
    await mkdir(join(directory, ".lock"), { recursive: true });
    await writeFile(join(directory, ".lock", "lease.json"), lease(2_147_483_647));

    await expect(createTaskLineage({ repoRoot: root, runId: "run-a", lineageId, now }))
      .resolves.toMatchObject({ root_run_id: "run-a" });
  });

  it.each([
    ["live same-host", process.pid, hostname()],
    ["unknown-host", 2_147_483_647, "remote-host.example"],
  ])("does not steal a stale-looking %s lease", async (_label, pid, host) => {
    const root = await makeRepo();
    const directory = join(root, ".brain-hands", "task-lineages", lineageId);
    await mkdir(join(directory, ".lock"), { recursive: true });
    await writeFile(join(directory, ".lock", "lease.json"), lease(pid, host));

    await expect(createTaskLineage({ repoRoot: root, runId: "run-a", lineageId, now }))
      .rejects.toThrow(/lock|lease/i);
    expect(JSON.parse(await readFile(join(directory, ".lock", "lease.json"), "utf8"))).toMatchObject({ pid, host });
    await expect(access(join(directory, "state.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps the previous valid state when atomic replacement is interrupted", async () => {
    const root = await makeRepo();
    const original = await createTaskLineage({ repoRoot: root, runId: "run-a", lineageId, now });

    await expect(withTaskLineageTransaction({
      repoRoot: root,
      lineageId,
      now: new Date("2026-07-16T12:01:00.000Z"),
      hooks: { beforeStateRename: async () => { throw new Error("injected rename interruption"); } },
      operation: async (transaction) => transaction.update({
        ...transaction.read(),
        issue_set: { ...transaction.read().issue_set, state: "applying" },
      }),
    })).rejects.toThrow("injected rename interruption");

    expect(await readTaskLineage(root, lineageId)).toEqual(original);
    expect((await readdir(join(root, ".brain-hands", "task-lineages", lineageId)))
      .filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("does not expose identity fields through a mutable transaction snapshot", async () => {
    const root = await makeRepo();
    const original = await createTaskLineage({ repoRoot: root, runId: "run-a", lineageId, now });

    await expect(withTaskLineageTransaction({
      repoRoot: root,
      lineageId,
      operation: async (transaction) => {
        const snapshot = transaction.read();
        snapshot.lineage_id = "84b02a40-38dd-40bd-b5f8-e7e7131eecef";
        return transaction.update(snapshot);
      },
    })).rejects.toThrow(/identity/i);
    expect(await readTaskLineage(root, lineageId)).toEqual(original);
  });

  it("does not let a mutable read snapshot bypass append-only run IDs", async () => {
    const root = await makeRepo();
    const original = await createTaskLineage({ repoRoot: root, runId: "run-a", lineageId, now });

    await expect(withTaskLineageTransaction({
      repoRoot: root,
      lineageId,
      operation: async (transaction) => {
        const snapshot = transaction.read();
        snapshot.run_ids.unshift("run-b");
        snapshot.active_run_id = "run-b";
        return transaction.update(snapshot);
      },
    })).rejects.toThrow(/append-only/i);
    expect(await readTaskLineage(root, lineageId)).toEqual(original);
  });

  it("quarantines corrupt state and keeps later mutation fail-closed", async () => {
    const root = await makeRepo();
    await createTaskLineage({ repoRoot: root, runId: "run-a", lineageId, now });
    const statePath = taskLineagePath(root, lineageId);
    await writeFile(statePath, "{not valid json\n");

    await expect(transitionTaskLineage({ repoRoot: root, lineageId, to: "delivery_ready" }))
      .rejects.toThrow(/corrupt/i);
    const entries = await readdir(join(root, ".brain-hands", "task-lineages", lineageId));
    expect(entries.some((name) => /^state\.json\.corrupt-\d+-[0-9a-f-]{36}$/.test(name))).toBe(true);
    await expect(access(statePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(createTaskLineage({ repoRoot: root, runId: "run-a", lineageId, now }))
      .rejects.toThrow(/corrupt|quarantined/i);
  });

  it("enforces lifecycle transitions and freezes issue and delivery operations after terminal state", async () => {
    const root = await makeRepo();
    await createTaskLineage({ repoRoot: root, runId: "run-a", lineageId, now });
    await expect(transitionTaskLineage({ repoRoot: root, lineageId, to: "completed" }))
      .rejects.toThrow(/transition/i);
    await expect(transitionTaskLineage({ repoRoot: root, lineageId, to: "delivery_ready" }))
      .resolves.toMatchObject({ state: "delivery_ready" });
    const completed = await transitionTaskLineage({ repoRoot: root, lineageId, to: "completed" });
    expect(completed.state).toBe("completed");

    await expect(withTaskLineageTransaction({
      repoRoot: root,
      lineageId,
      operation: async (transaction) => transaction.update({
        ...transaction.read(),
        issue_set: { ...transaction.read().issue_set, state: "applying" },
      }),
    })).rejects.toThrow(/terminal.*issue|issue.*terminal/i);
    await expect(withTaskLineageTransaction({
      repoRoot: root,
      lineageId,
      operation: async (transaction) => transaction.update({
        ...transaction.read(),
        delivery: { ...transaction.read().delivery, state: "applying" },
      }),
    })).rejects.toThrow(/terminal.*delivery|delivery.*terminal/i);
    expect(await readTaskLineage(root, lineageId)).toEqual(completed);
  });

  it("allows an explicitly human-accepted delivery lineage to complete only after verified merge reconciliation", async () => {
    const root = await makeRepo();
    await createTaskLineage({ repoRoot: root, runId: "run-a", lineageId, now });
    await transitionTaskLineage({ repoRoot: root, lineageId, to: "delivery_ready" });
    await transitionTaskLineage({ repoRoot: root, lineageId, to: "human_accepted" });

    await expect(transitionTaskLineage({ repoRoot: root, lineageId, to: "completed" }))
      .resolves.toMatchObject({ state: "completed" });
  });

  it.each([
    ["issue operations", (snapshot: Awaited<ReturnType<typeof readTaskLineage>>) => {
      snapshot.issue_set.state = "applying";
    }, /terminal.*issue|issue.*terminal/i],
    ["delivery operations", (snapshot: Awaited<ReturnType<typeof readTaskLineage>>) => {
      snapshot.delivery.state = "applying";
    }, /terminal.*delivery|delivery.*terminal/i],
    ["terminal lifecycle", (snapshot: Awaited<ReturnType<typeof readTaskLineage>>) => {
      snapshot.state = "active";
    }, /transition/i],
  ] as const)("does not let a mutable read snapshot bypass frozen %s", async (_label, mutate, expected) => {
    const root = await makeRepo();
    await createTaskLineage({ repoRoot: root, runId: "run-a", lineageId, now });
    await transitionTaskLineage({ repoRoot: root, lineageId, to: "delivery_ready" });
    const completed = await transitionTaskLineage({ repoRoot: root, lineageId, to: "completed" });

    await expect(withTaskLineageTransaction({
      repoRoot: root,
      lineageId,
      operation: async (transaction) => {
        const snapshot = transaction.read();
        mutate(snapshot);
        return transaction.update(snapshot);
      },
    })).rejects.toThrow(expected);
    expect(await readTaskLineage(root, lineageId)).toEqual(completed);
  });

  it("releases the lineage lock when the transaction operation throws", async () => {
    const root = await makeRepo();
    await createTaskLineage({ repoRoot: root, runId: "run-a", lineageId, now });

    await expect(withTaskLineageTransaction({
      repoRoot: root,
      lineageId,
      operation: () => { throw new Error("injected operation failure"); },
    })).rejects.toThrow("injected operation failure");
    await expect(transitionTaskLineage({ repoRoot: root, lineageId, to: "delivery_ready" }))
      .resolves.toMatchObject({ state: "delivery_ready" });
  });

  it("fails closed without recursively deleting an unexpectedly non-empty lock", async () => {
    const root = await makeRepo();
    await createTaskLineage({ repoRoot: root, runId: "run-a", lineageId, now });
    const unexpected = join(root, ".brain-hands", "task-lineages", lineageId, ".lock", "unexpected.txt");

    await expect(withTaskLineageTransaction({
      repoRoot: root,
      lineageId,
      operation: async () => {
        await writeFile(unexpected, "preserve me\n");
      },
    })).rejects.toThrow(/not empty|ENOTEMPTY/i);
    expect(await readFile(unexpected, "utf8")).toBe("preserve me\n");
  });

  it("rejects issue operations created by runs outside the lineage", async () => {
    const root = await makeRepo();
    const record = await createTaskLineage({ repoRoot: root, runId: "run-a", lineageId, now });

    expect(() => taskLineageRecordV1Schema.parse({
      ...record,
      issue_set: {
        ...record.issue_set,
        operations: {
          "create:parent": {
            operation_id: "create:parent",
            target_key: "parent",
            desired_sha256: "a".repeat(64),
            state: "intent",
            issue_number: null,
            created_by_run_id: "run-outside-lineage",
          },
        },
      },
    })).toThrow(/created_by_run_id|run_ids/i);
  });

  it.each([
    ["revision", 2, "a".repeat(64)],
    ["digest", 1, "b".repeat(64)],
  ])("binds an issue preview to its issue-set plan %s", async (_label, previewRevision, previewSha) => {
    const root = await makeRepo();
    const record = await createTaskLineage({ repoRoot: root, runId: "run-a", lineageId, now });

    expect(() => taskLineageRecordV1Schema.parse({
      ...record,
      issue_set: {
        ...record.issue_set,
        plan_revision: 1,
        plan_sha256: "a".repeat(64),
        preview: {
          phase: "issue_sync",
          revision: 1,
          path: "github-effects/issue-sync/revision-1.json",
          sha256: "c".repeat(64),
          plan_revision: previewRevision,
          plan_sha256: previewSha,
          state: "previewed",
        },
      },
    })).toThrow(/preview.*plan|plan.*preview/i);
  });

  it("derives deterministic RFC 4122 lineage UUIDs from canonical repository and run identity", () => {
    const first = deriveLegacyTaskLineageId("github.com/Owner/Repo", "run-a");
    expect(first).toBe(deriveLegacyTaskLineageId("github.com/owner/repo", "run-a"));
    expect(first).not.toBe(deriveLegacyTaskLineageId("github.com/owner/other", "run-a"));
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("migrates a moved legacy run from canonical repository identity instead of filesystem or request text", async () => {
    const originalRoot = await makeRepo();
    const ledger = await createLegacyRunLedgerV2({
      repoRoot: originalRoot,
      originalRequest: "Private request text that must not affect lineage",
      slug: "moved-legacy-run",
      now,
      mode: "github",
    });
    const movedRoot = `${originalRoot}-moved`;
    await rename(originalRoot, movedRoot);
    repoRoot = movedRoot;
    const movedRunDir = join(movedRoot, ".brain-hands", "runs", ledger.runId);

    const migrated = await ensureProducingTaskLineage({
      runDir: movedRunDir,
      repository: { host: "GitHub.COM", name_with_owner: "Owner/Repo", actor: "operator" },
    });

    expect(migrated.lineage.lineage_id).toBe(deriveLegacyTaskLineageId("github.com/owner/repo", ledger.runId));
    expect(migrated.lineage).toMatchObject({
      repository_key: "github.com/owner/repo",
      root_run_id: ledger.runId,
      active_run_id: ledger.runId,
    });
    expect(migrated.manifest).toMatchObject({
      task_lineage_id: migrated.lineage.lineage_id,
      github_effects_protocol: "task-lineage-v1",
      repo_root: originalRoot,
    });
    await expect(ensureProducingTaskLineage({
      runDir: movedRunDir,
      repository: { host: "github.com", name_with_owner: "owner/repo", actor: "another-actor" },
    })).resolves.toEqual(migrated);
  });

  it("rejects completed legacy runs instead of minting replay authority", async () => {
    const root = await makeRepo();
    const ledger = await createLegacyRunLedgerV2({ repoRoot: root, originalRequest: "Already complete", slug: "complete", now, mode: "github" });
    await updateManifestV2(ledger.runDir, { stage: "complete" });

    await expect(ensureProducingTaskLineage({
      runDir: ledger.runDir,
      repository: { host: "github.com", name_with_owner: "owner/repo", actor: "operator" },
    })).rejects.toThrow(/completed legacy runs/i);
  });

  it("derives distinct producing lineages for distinct canonical repositories", async () => {
    const firstRoot = await makeRepo();
    const first = await createLegacyRunLedgerV2({ repoRoot: firstRoot, originalRequest: "Same run", slug: "same", now, mode: "github" });
    const firstBinding = await ensureProducingTaskLineage({
      runDir: first.runDir,
      repository: { host: "github.com", name_with_owner: "owner/first", actor: "operator" },
    });
    await rm(firstRoot, { recursive: true, force: true });
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-lineage-"));
    const second = await createLegacyRunLedgerV2({ repoRoot, originalRequest: "Different prose", slug: "same", now, mode: "github" });
    const secondBinding = await ensureProducingTaskLineage({
      runDir: second.runDir,
      repository: { host: "github.com", name_with_owner: "owner/second", actor: "operator" },
    });

    expect(second.runId).toBe(first.runId);
    expect(secondBinding.lineage.lineage_id).not.toBe(firstBinding.lineage.lineage_id);
  });

  it("repairs only an exactly bound missing new-run lineage", async () => {
    const root = await makeRepo();
    const ledger = await createRunLedgerV2({
      repoRoot: root,
      originalRequest: "Repair interrupted lineage creation",
      slug: "repair-lineage",
      now,
      taskLineageId: lineageId,
    });
    await rm(join(root, ".brain-hands", "task-lineages", lineageId), { recursive: true });

    await expect(attachMissingNewRunLineage({ repoRoot: root, runId: `${ledger.runId}-wrong`, lineageId }))
      .rejects.toThrow(/manifest|run/i);
    await expect(attachMissingNewRunLineage({ repoRoot: root, runId: ledger.runId, lineageId }))
      .resolves.toMatchObject({ lineage_id: lineageId, root_run_id: ledger.runId });
    await expect(attachMissingNewRunLineage({ repoRoot: root, runId: ledger.runId, lineageId }))
      .resolves.toMatchObject({ lineage_id: lineageId, state: "active" });
  });

  it("rejects a valid record whose identity does not match its lineage path", async () => {
    const root = await makeRepo();
    const ledger = await createRunLedgerV2({
      repoRoot: root,
      originalRequest: "Reject copied lineage identity",
      slug: "copied-lineage-read",
      now,
      taskLineageId: lineageId,
    });
    const record = await readTaskLineage(root, lineageId);
    await writeFile(taskLineagePath(root, lineageId), `${JSON.stringify({
      ...record,
      lineage_id: "44444444-4444-4444-8444-444444444444",
    }, null, 2)}\n`);

    expect(ledger.manifest.task_lineage_id).toBe(lineageId);
    await expect(readTaskLineage(root, lineageId)).rejects.toThrow(/identity|lineage.*path/i);
  });

  it("does not accept a copied lineage identity during interrupted-new-run repair", async () => {
    const root = await makeRepo();
    const ledger = await createRunLedgerV2({
      repoRoot: root,
      originalRequest: "Reject copied lineage repair",
      slug: "copied-lineage-repair",
      now,
      taskLineageId: lineageId,
    });
    const record = await readTaskLineage(root, lineageId);
    await writeFile(taskLineagePath(root, lineageId), `${JSON.stringify({
      ...record,
      lineage_id: "55555555-5555-4555-8555-555555555555",
    }, null, 2)}\n`);

    await expect(attachMissingNewRunLineage({ repoRoot: root, runId: ledger.runId, lineageId }))
      .rejects.toThrow(/identity|lineage.*path/i);
  });

  it.each([
    ["terminal", "11111111-1111-4111-8111-111111111111", async (root: string, id: string) => {
      await transitionTaskLineage({ repoRoot: root, lineageId: id, to: "delivery_ready" });
      await transitionTaskLineage({ repoRoot: root, lineageId: id, to: "completed" });
    }],
    ["populated effects", "22222222-2222-4222-8222-222222222222", async (root: string, id: string) => {
      await withTaskLineageTransaction({
        repoRoot: root,
        lineageId: id,
        operation: (transaction) => {
          const current = transaction.read();
          return transaction.update({
            ...current,
            issue_set: {
              ...current.issue_set,
              state: "applying",
              operations: {
                "create:parent": {
                  operation_id: "create:parent",
                  target_key: "parent",
                  desired_sha256: "a".repeat(64),
                  state: "intent",
                  issue_number: null,
                  created_by_run_id: current.root_run_id,
                },
              },
            },
          });
        },
      });
    }],
    ["repository-bound", "33333333-3333-4333-8333-333333333333", async (root: string, id: string) => {
      await withTaskLineageTransaction({
        repoRoot: root,
        lineageId: id,
        operation: (transaction) => transaction.update({
          ...transaction.read(),
          repository_key: "github.com/owner/repo",
        }),
      });
    }],
  ] as const)("rejects an existing %s lineage as interrupted-new-run repair", async (_label, id, mutate) => {
    const root = await makeRepo();
    const ledger = await createRunLedgerV2({
      repoRoot: root,
      originalRequest: "Reject conflicting interrupted lineage",
      slug: `conflict-${_label}`,
      now,
      taskLineageId: id,
    });
    await mutate(root, id);

    await expect(attachMissingNewRunLineage({ repoRoot: root, runId: ledger.runId, lineageId: id }))
      .rejects.toThrow(/exact initial|conflict|binding/i);
  });
});
