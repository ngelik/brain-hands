import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  approvePlanRevision,
  createRunLedger,
  readManifestV2,
  recordPlan,
  transitionRun,
  updateManifestV2,
  withRunLedgerTransaction,
  withRunLedgerCompoundTransaction,
  writeTextArtifact,
} from "../../src/core/ledger.js";
import { engineFindingSchema, findingRevisionInputSchema } from "../../src/core/schema.js";
import type { FindingIdentityInput, FindingRevisionInput } from "../../src/core/types.js";
import {
  findingHistoryPath,
  fingerprintFinding,
  loadFindingRevisionRecords,
  readFindingIndex,
  recordFindingRevision,
} from "../../src/workflow/findings.js";
import { createLegacyRunLedgerV2 } from "../fixtures/legacy-run.js";

let repoRoot: string | null = null;

afterEach(async () => {
  if (repoRoot) await rm(repoRoot, { recursive: true, force: true });
  repoRoot = null;
});

function identityInput(overrides: Partial<FindingIdentityInput> = {}): FindingIdentityInput {
  return {
    work_item_id: "item/alpha",
    criterion_ref: "BH-001:AC-1",
    source: "verifier",
    normalized_location: "src/workflow/example.ts:20",
    problem_class: "failing-test",
    ...overrides,
  };
}

function revisionInput(overrides: Partial<FindingRevisionInput> = {}): FindingRevisionInput {
  return {
    work_item_id: "item/alpha",
    source: "verifier",
    severity: "high",
    disposition: "blocking",
    criterion_ref: "BH-001:AC-1",
    normalized_location: "src/workflow/example.ts:20",
    problem_class: "failing-test",
    problem: "The test is red",
    required_fix: "Make the test pass",
    evidence_refs: ["verification/item-alpha/attempt-1/evidence.json"],
    review_revision: 1,
    ...overrides,
  };
}

async function createApprovedRun(): Promise<string> {
  repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-findings-"));
  const ledger = await createLegacyRunLedgerV2({
    repoRoot,
    originalRequest: "Track findings",
  });
  const plan = JSON.stringify({
    work_items: [{ id: "item/alpha", acceptance_criteria: ["The test passes"] }],
  });
  const recorded = await recordPlan(ledger.runDir, plan);
  await approvePlanRevision(ledger.runDir, recorded.revision);
  return ledger.runDir;
}

async function historyLines(runDir: string, workItemId = "item/alpha"): Promise<string[]> {
  return (await readFile(findingHistoryPath(runDir, workItemId), "utf8"))
    .trim()
    .split("\n");
}

describe("finding identity", () => {
  it("keeps identity stable across wording and model changes", () => {
    const first = fingerprintFinding({
      ...identityInput(),
      problem: "test is red",
      model_id: "model-a",
    } as FindingIdentityInput);
    const reworded = fingerprintFinding({
      ...identityInput(),
      problem: "the test failed",
      model_id: "model-b",
    } as FindingIdentityInput);

    expect(first).toBe(reworded);
    expect(first).toMatch(/^finding:[a-f0-9]{64}$/);
  });

  it("normalizes location and problem class before fingerprinting", () => {
    expect(fingerprintFinding(identityInput())).toBe(fingerprintFinding(identityInput({
      normalized_location: "  src\\workflow\\example.ts:20  ",
      problem_class: " FAILING-TEST ",
    })));
  });

  it("keeps C, C++, C#, and punctuation-only problem classes distinct", () => {
    const ids = ["C", "C++", "C#", "!!!", "???"].map((problem_class) =>
      fingerprintFinding(identityInput({ problem_class })));

    expect(new Set(ids)).toHaveLength(ids.length);
  });

  it("preserves case differences in repository locations", () => {
    expect(fingerprintFinding(identityInput({ normalized_location: "src/Foo.ts:1" })))
      .not.toBe(fingerprintFinding(identityInput({ normalized_location: "src/foo.ts:1" })));
  });

  it("normalizes repository dot segments without folding case", () => {
    expect(fingerprintFinding(identityInput({ normalized_location: "src/lib/../Foo.ts:1" })))
      .toBe(fingerprintFinding(identityInput({ normalized_location: "src/Foo.ts:1" })));
  });

  it.each(["../src/a.ts", "a/../../b.ts", "/src/a.ts", "C:\\src\\a.ts", "C:/src/a.ts", "\\\\server\\share\\a.ts"])(
    "rejects non-repository-relative location %s",
    (normalized_location) => {
      expect(() => fingerprintFinding(identityInput({ normalized_location })))
        .toThrow(/repository.relative|absolute|underflow/i);
    },
  );

  it("rejects canonically empty identity fields", () => {
    expect(() => fingerprintFinding(identityInput({ problem_class: "  \u00a0 " })))
      .toThrow(/problem class/i);
    expect(() => fingerprintFinding(identityInput({ normalized_location: "  \u00a0 " })))
      .toThrow(/location/i);
  });

  it("uses collision-free work-item history paths", async () => {
    const runDir = await createApprovedRun();
    const slash = findingHistoryPath(runDir, "a/b");
    const punctuation = findingHistoryPath(runDir, "a?b");

    expect(slash).not.toBe(punctuation);
    expect(slash.startsWith(join(runDir, "findings"))).toBe(true);
    expect(punctuation.startsWith(join(runDir, "findings"))).toBe(true);
  });
});

describe("read-only finding revision loading", () => {
  it("loads one exact ordered revision without mutating history or manifest", async () => {
    const runDir = await createApprovedRun();
    const first = await recordFindingRevision(runDir, revisionInput());
    const second = await recordFindingRevision(runDir, revisionInput({
      normalized_location: "src/workflow/other.ts:30",
      problem_class: "other-failure",
      problem: "The other test is red",
    }));
    const ids = [second.finding_id, first.finding_id];
    const manifestBefore = await readFile(join(runDir, "manifest.json"), "utf8");
    const historyBefore = await readFile(findingHistoryPath(runDir, "item/alpha"), "utf8");

    const loaded = await loadFindingRevisionRecords(runDir, "item/alpha", 1, ids);

    expect(loaded.map((finding) => finding.finding_id)).toEqual(ids);
    expect(await readFile(join(runDir, "manifest.json"), "utf8")).toBe(manifestBefore);
    expect(await readFile(findingHistoryPath(runDir, "item/alpha"), "utf8")).toBe(historyBefore);
    await expect(loadFindingRevisionRecords(runDir, "item/alpha", 1, [first.finding_id]))
      .rejects.toThrow("extra");
    await expect(loadFindingRevisionRecords(runDir, "item/alpha", 1, [first.finding_id, first.finding_id]))
      .rejects.toThrow("duplicate");
  });

  it("rejects canonical history rename-replacement after descriptor read", async () => {
    const runDir = await createApprovedRun();
    const finding = await recordFindingRevision(runDir, revisionInput());
    const path = findingHistoryPath(runDir, "item/alpha");
    const saved = `${path}.saved`;
    const replacement = `${JSON.stringify(finding)}\n`;

    await expect((loadFindingRevisionRecords as unknown as (
      ...args: unknown[]
    ) => Promise<unknown>)(runDir, "item/alpha", 1, [finding.finding_id], {
      afterHistoryDescriptorRead: async () => {
        await rename(path, saved);
        await writeFile(path, replacement);
      },
    })).rejects.toThrow(/identity changed|canonical.*changed/i);

    expect(await readFile(path, "utf8")).toBe(replacement);
    expect(await readFile(saved, "utf8")).toBe(replacement);
  });
});

describe("finding persistence", () => {
  it("leaves legacy V1 findings artifacts unchanged", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-findings-v1-"));
    const ledger = await createRunLedger({
      repoRoot,
      originalRequest: "Legacy run",
      slug: "legacy",
    });

    const path = await writeTextArtifact(ledger.runDir, "findings/legacy.txt", "legacy\n");
    expect(await readFile(path, "utf8")).toBe("legacy\n");
  });

  it("records repetition without rewriting prior revisions", async () => {
    const runDir = await createApprovedRun();
    const first = await recordFindingRevision(runDir, revisionInput());
    const firstBytes = await readFile(findingHistoryPath(runDir, "item/alpha"), "utf8");
    const second = await recordFindingRevision(runDir, revisionInput({
      review_revision: 2,
      problem: "The same test failed with different wording",
      evidence_refs: ["verification/item-alpha/attempt-2/evidence.json"],
    }));
    const lines = await historyLines(runDir);

    expect(lines).toHaveLength(2);
    expect(`${lines[0]}\n`).toBe(firstBytes);
    expect(engineFindingSchema.parse(JSON.parse(lines[0]!))).toEqual(first);
    expect(engineFindingSchema.parse(JSON.parse(lines[1]!))).toEqual(second);
    expect(second).toMatchObject({
      finding_id: first.finding_id,
      first_seen_revision: 1,
      last_seen_revision: 2,
      occurrences: 2,
      repeated_from: first.finding_id,
    });
  });

  it("reuses an identical persisted revision and rejects conflicting replay", async () => {
    const runDir = await createApprovedRun();
    const first = await recordFindingRevision(runDir, revisionInput());
    const replayed = await recordFindingRevision(runDir, revisionInput());

    expect(replayed).toEqual(first);
    expect(await historyLines(runDir)).toHaveLength(1);
    await expect(recordFindingRevision(runDir, revisionInput({ problem: "conflicting replay" })))
      .rejects.toThrow(/already exists with different content/i);
    expect(await historyLines(runDir)).toHaveLength(1);
  });

  it("replays canonical path separators and Unicode-equivalent identity idempotently", async () => {
    const runDir = await createApprovedRun();
    const first = await recordFindingRevision(runDir, revisionInput({
      normalized_location: " src\\workflow\\ｅxample.ts:20 ",
      problem_class: " C++ ",
    }));
    const replayed = await recordFindingRevision(runDir, revisionInput({
      normalized_location: "src/workflow/example.ts:20",
      problem_class: "c++",
    }));

    expect(replayed).toEqual(first);
    expect(first.normalized_location).toBe("src/workflow/example.ts:20");
    expect(first.problem_class).toBe("c++");
    expect(await historyLines(runDir)).toHaveLength(1);
  });

  it("blocks generic artifact APIs from overwriting finding history", async () => {
    const runDir = await createApprovedRun();
    await recordFindingRevision(runDir, revisionInput());
    const historyPath = findingHistoryPath(runDir, "item/alpha");
    const before = await readFile(historyPath, "utf8");

    await expect(writeTextArtifact(runDir, relative(runDir, historyPath), "replacement\n"))
      .rejects.toThrow(/append-only/i);
    expect(await readFile(historyPath, "utf8")).toBe(before);
  });

  it("rejects a schema-valid history record with mismatched engine identity", async () => {
    const runDir = await createApprovedRun();
    const finding = await recordFindingRevision(runDir, revisionInput());
    const historyPath = findingHistoryPath(runDir, "item/alpha");
    const corrupted = { ...finding, finding_id: `finding:${"0".repeat(64)}` };
    await import("node:fs/promises").then(({ writeFile }) =>
      writeFile(historyPath, `${JSON.stringify(corrupted)}\n`, "utf8"));

    await expect(recordFindingRevision(runDir, revisionInput({ review_revision: 2 })))
      .rejects.toThrow(/identity|fingerprint/i);
  });

  it("rejects a schema-valid but discontinuous occurrence chain", async () => {
    const runDir = await createApprovedRun();
    const finding = await recordFindingRevision(runDir, revisionInput());
    const historyPath = findingHistoryPath(runDir, "item/alpha");
    const corrupted = { ...finding, occurrences: 2 };
    await import("node:fs/promises").then(({ writeFile }) =>
      writeFile(historyPath, `${JSON.stringify(corrupted)}\n`, "utf8"));

    await expect(recordFindingRevision(runDir, revisionInput({ review_revision: 2 })))
      .rejects.toThrow(/history|occurrence/i);
  });

  it("keeps only compact summaries in the manifest index", async () => {
    const runDir = await createApprovedRun();
    const finding = await recordFindingRevision(runDir, revisionInput());
    const index = await readFindingIndex(runDir);
    const manifest = await readManifestV2(runDir);

    expect(index[finding.finding_id]).toEqual({
      finding_id: finding.finding_id,
      work_item_id: "item/alpha",
      severity: "high",
      disposition: "blocking",
      first_seen_revision: 1,
      last_seen_revision: 1,
      occurrences: 1,
    });
    expect(manifest.finding_index).toEqual(index);
    expect(JSON.stringify(manifest.finding_index)).not.toContain("Make the test pass");
    expect(manifest.review_policy_snapshot?.max_fix_cycles).toBe(2);
    expect(manifest.release_guards).toHaveLength(4);
    expect(manifest.review_accounting?.review_revision).toBe(0);
  });

  it("rejects manifest index keys that disagree with their summaries", async () => {
    const runDir = await createApprovedRun();
    const finding = await recordFindingRevision(runDir, revisionInput());
    const manifestPath = join(runDir, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.finding_index = { [`finding:${"f".repeat(64)}`]: manifest.finding_index[finding.finding_id] };
    await import("node:fs/promises").then(({ writeFile }) =>
      writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8"));

    await expect(readFindingIndex(runDir)).rejects.toThrow();
  });

  it("serializes concurrent writers without losing revisions", async () => {
    const runDir = await createApprovedRun();
    const classes = Array.from({ length: 12 }, (_, index) => `concurrent-class-${index + 1}`);

    const recorded = await Promise.all(classes.map((problem_class) =>
      recordFindingRevision(runDir, revisionInput({ problem_class }))));
    const lines = await historyLines(runDir);
    const index = await readFindingIndex(runDir);

    expect(new Set(recorded.map((finding) => finding.finding_id))).toHaveLength(12);
    expect(recorded.every((finding) => finding.occurrences === 1)).toBe(true);
    expect(lines).toHaveLength(12);
    expect(Object.keys(index)).toHaveLength(12);
  });

  it("preserves a competing generic manifest update and finding index update", async () => {
    const runDir = await createApprovedRun();
    const largeEvidence = Array.from({ length: 2_000 }, (_, index) =>
      `verification/item-alpha/attempt-1/evidence-${index}.json`);
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const owner = withRunLedgerTransaction(runDir, async () => {
      entered();
      await held;
    });
    await started;
    let findingFinished = false;
    let updateFinished = false;
    const finding = recordFindingRevision(runDir, revisionInput({ evidence_refs: largeEvidence }))
      .then(() => { findingFinished = true; });
    const update = updateManifestV2(runDir, { retry_counts: { external_update: 7 } })
      .then(() => { updateFinished = true; });
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(findingFinished).toBe(false);
    expect(updateFinished).toBe(false);
    release();
    await Promise.all([owner, finding, update]);

    const manifest = await readManifestV2(runDir);
    expect(manifest.retry_counts.external_update).toBe(7);
    expect(Object.keys(manifest.finding_index ?? {})).toHaveLength(1);
    expect((await readdir(runDir)).some((name) => name.startsWith(".manifest-"))).toBe(false);
  });

  it("waits for a live ledger-lock owner without stealing it", async () => {
    const runDir = await createApprovedRun();
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const owner = withRunLedgerTransaction(runDir, async () => {
      entered();
      await held;
    });
    await started;
    let contenderFinished = false;
    const contender = updateManifestV2(runDir, { retry_counts: { contender: 1 } })
      .then(() => { contenderFinished = true; });
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(contenderFinished).toBe(false);
    release();
    await Promise.all([owner, contender]);
    expect((await readManifestV2(runDir)).retry_counts.contender).toBe(1);
  });

  it("reuses an explicitly nested transaction instead of timing out", async () => {
    const runDir = await createApprovedRun();

    await withRunLedgerTransaction(runDir, async () => {
      await updateManifestV2(runDir, { retry_counts: { nested: 1 } });
      await recordFindingRevision(runDir, revisionInput());
    });

    const manifest = await readManifestV2(runDir);
    expect(manifest.retry_counts.nested).toBe(1);
    expect(Object.keys(manifest.finding_index ?? {})).toHaveLength(1);
  });

  it("serializes parallel nested manifest patches without losing either", async () => {
    const runDir = await createApprovedRun();
    await withRunLedgerTransaction(runDir, async () => {
      await Promise.all([
        updateManifestV2(runDir, { current_work_item_id: "parallel-item" }),
        updateManifestV2(runDir, { delivery_state: "ready" }),
      ]);
    });

    const manifest = await readManifestV2(runDir);
    expect(manifest.current_work_item_id).toBe("parallel-item");
    expect(manifest.delivery_state).toBe("ready");
  });

  it("serializes parallel nested finding writes", async () => {
    const runDir = await createApprovedRun();
    await withRunLedgerTransaction(runDir, async () => {
      await Promise.all([
        recordFindingRevision(runDir, revisionInput({ problem_class: "parallel-a" })),
        recordFindingRevision(runDir, revisionInput({ problem_class: "parallel-b" })),
      ]);
    });

    expect(Object.keys(await readFindingIndex(runDir))).toHaveLength(2);
    expect(await historyLines(runDir)).toHaveLength(2);
  });

  it("rejects cross-run nesting immediately while allowing concurrent top-level runs", async () => {
    const runA = await createApprovedRun();
    const ledgerB = await createLegacyRunLedgerV2({ repoRoot: repoRoot!, originalRequest: "Run B", slug: "run-b" });
    const planB = await recordPlan(ledgerB.runDir, JSON.stringify({
      work_items: [{ id: "item/alpha", acceptance_criteria: ["B passes"] }],
    }));
    await approvePlanRevision(ledgerB.runDir, planB.revision);

    await withRunLedgerTransaction(runA, async () => {
      await expect(withRunLedgerTransaction(ledgerB.runDir, async () => undefined))
        .rejects.toThrow(/cross-run|different run/i);
      await expect(withRunLedgerTransaction(ledgerB.runDir, async () =>
        withRunLedgerTransaction(runA, async () => undefined)))
        .rejects.toThrow(/cross-run|different run/i);
    });

    await Promise.all([
      updateManifestV2(runA, { retry_counts: { a: 1 } }),
      updateManifestV2(ledgerB.runDir, { retry_counts: { b: 1 } }),
    ]);
    expect((await readManifestV2(runA)).retry_counts.a).toBe(1);
    expect((await readManifestV2(ledgerB.runDir)).retry_counts.b).toBe(1);
  });

  it("rejects inherited transaction use after its owner released the lock", async () => {
    const runDir = await createApprovedRun();
    let releaseChild!: () => void;
    const childGate = new Promise<void>((resolve) => { releaseChild = resolve; });
    let child!: Promise<unknown>;

    await withRunLedgerTransaction(runDir, async () => {
      child = childGate.then(() => updateManifestV2(runDir, { retry_counts: { late: 1 } }));
    });
    releaseChild();

    await expect(child).rejects.toThrow(/no longer active/i);
    expect((await readManifestV2(runDir)).retry_counts.late).toBeUndefined();
  });

  it.each(["transition", "record_plan", "approve_plan"] as const)(
    "serializes finding persistence against %s manifest mutation",
    async (mutation) => {
      const runDir = await createApprovedRun();
      if (mutation === "approve_plan") {
        await recordPlan(runDir, JSON.stringify({
          work_items: [{ id: "item/alpha", acceptance_criteria: ["The test still passes"] }],
        }));
      }
      let release!: () => void;
      let entered!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      const started = new Promise<void>((resolve) => { entered = resolve; });
      const owner = withRunLedgerTransaction(runDir, async () => {
        entered();
        await held;
      });
      await started;
      let mutationFinished = false;
      const mutate = (mutation === "transition"
        ? transitionRun(runDir, "preflight")
        : mutation === "record_plan"
          ? recordPlan(runDir, "# concurrent plan")
          : approvePlanRevision(runDir, 2))
        .then(() => { mutationFinished = true; });
      const finding = recordFindingRevision(runDir, revisionInput());
      await new Promise((resolve) => setTimeout(resolve, 40));

      const mutationWasBlocked = !mutationFinished;
      release();
      await Promise.all([owner, mutate, finding]);
      expect(mutationWasBlocked).toBe(true);
      const manifest = await readManifestV2(runDir);
      expect(Object.keys(manifest.finding_index ?? {})).toHaveLength(1);
      if (mutation === "transition") expect(manifest.stage).toBe("preflight");
      if (mutation === "record_plan") expect(manifest.current_revision).toBe(2);
      if (mutation === "approve_plan") expect(manifest.approved_revision).toBe(2);
    },
  );

  it("atomically recovers a demonstrably dead stale ledger owner", async () => {
    const runDir = await createApprovedRun();
    const lockPath = join(runDir, ".ledger.lock");
    await mkdir(lockPath);
    await writeFile(join(lockPath, "owner.json"), JSON.stringify({
      token: "dead-owner",
      pid: 2_147_483_647,
      hostname: hostname(),
      process_started_at: "2000-01-01T00:00:00.000Z",
      created_at: "2000-01-01T00:00:00.000Z",
    }));

    await updateManifestV2(runDir, { retry_counts: { recovered: 1 } });

    expect((await readManifestV2(runDir)).retry_counts.recovered).toBe(1);
    expect(await readdir(runDir)).not.toContain(".ledger.lock");
  });

  it("recovers a stale ownerless lock directory conservatively", async () => {
    const runDir = await createApprovedRun();
    const lockPath = join(runDir, ".ledger.lock");
    await mkdir(lockPath);
    const old = new Date("2000-01-01T00:00:00.000Z");
    await utimes(lockPath, old, old);

    await updateManifestV2(runDir, { retry_counts: { ownerless_recovered: 1 } });
    expect((await readManifestV2(runDir)).retry_counts.ownerless_recovered).toBe(1);
  });

  it("fails closed for a fresh ownerless lock directory", async () => {
    const runDir = await createApprovedRun();
    await mkdir(join(runDir, ".ledger.lock"));

    await expect(updateManifestV2(runDir, { retry_counts: { unsafe: 1 } }))
      .rejects.toThrow(/ownerless|owner/i);
    expect((await readManifestV2(runDir)).retry_counts.unsafe).toBeUndefined();
  });

  it("does not treat reused PID metadata as the original live owner", async () => {
    const runDir = await createApprovedRun();
    const lockPath = join(runDir, ".ledger.lock");
    await mkdir(lockPath);
    await writeFile(join(lockPath, "owner.json"), JSON.stringify({
      token: "reused-pid-owner",
      pid: process.pid,
      hostname: hostname(),
      process_started_at: "2000-01-01T00:00:00.000Z",
      created_at: "2000-01-01T00:00:00.000Z",
    }));

    await updateManifestV2(runDir, { retry_counts: { pid_reuse_recovered: 1 } });
    expect((await readManifestV2(runDir)).retry_counts.pid_reuse_recovered).toBe(1);
  });

  it("serializes two stale reclaimers and a waiting live acquirer", async () => {
    const runDir = await createApprovedRun();
    const lockPath = join(runDir, ".ledger.lock");
    await mkdir(lockPath);
    await writeFile(join(lockPath, "owner.json"), JSON.stringify({
      token: "dead-owner-for-race",
      pid: 2_147_483_647,
      hostname: hostname(),
      process_started_at: "2000-01-01T00:00:00.000Z",
      created_at: "2000-01-01T00:00:00.000Z",
    }));

    await Promise.all([
      updateManifestV2(runDir, { current_work_item_id: "reclaimer-a" }),
      updateManifestV2(runDir, { delivery_state: "ready" }),
      updateManifestV2(runDir, { retry_counts: { waiting_live: 1 } }),
    ]);

    const manifest = await readManifestV2(runDir);
    expect(manifest.current_work_item_id).toBe("reclaimer-a");
    expect(manifest.delivery_state).toBe("ready");
    expect(manifest.retry_counts.waiting_live).toBe(1);
    expect((await readdir(runDir)).some((name) => name.startsWith(".ledger.lock.recovery-")))
      .toBe(false);
  });

  it.each([
    ["truncated", "{\"token\":"],
    ["incomplete", "{}"],
  ])("fails closed for fresh malformed %s owner metadata", async (_label, ownerBytes) => {
    const runDir = await createApprovedRun();
    const lockPath = join(runDir, ".ledger.lock");
    await mkdir(lockPath);
    await writeFile(join(lockPath, "owner.json"), ownerBytes);

    await expect(updateManifestV2(runDir, { retry_counts: { malformed: 1 } }))
      .rejects.toThrow();
    expect(await readFile(join(lockPath, "owner.json"), "utf8")).toBe(ownerBytes);
    expect((await readManifestV2(runDir)).retry_counts.malformed).toBeUndefined();
  });

  it.each([
    ["truncated", "{\"token\":"],
    ["incomplete", "{}"],
  ])("recovers stale malformed %s owner metadata with diagnostics", async (_label, ownerBytes) => {
    const runDir = await createApprovedRun();
    const lockPath = join(runDir, ".ledger.lock");
    await mkdir(lockPath);
    await writeFile(join(lockPath, "owner.json"), ownerBytes);
    const old = new Date("2000-01-01T00:00:00.000Z");
    await utimes(lockPath, old, old);

    await updateManifestV2(runDir, { retry_counts: { malformed_recovered: 1 } });

    const diagnostic = (await readdir(runDir)).find((name) => name.startsWith(".ledger.lock.owner-diagnostic-"));
    expect(diagnostic).toBeDefined();
    expect(await readFile(join(runDir, diagnostic!), "utf8")).toBe(ownerBytes);
    expect((await readManifestV2(runDir)).retry_counts.malformed_recovered).toBe(1);
  });

  it.each(["afterQuarantineRename", "afterQuarantineValidation", "beforeQuarantineRemoval"] as const)(
    "recovers a crash-left quarantine at %s",
    async (phase) => {
      const runDir = await createApprovedRun();
      const lockPath = join(runDir, ".ledger.lock");
      await mkdir(lockPath);
      await writeFile(join(lockPath, "owner.json"), JSON.stringify({
        token: `dead-${phase}`,
        pid: 2_147_483_647,
        hostname: hostname(),
        process_started_at: "2000-01-01T00:00:00.000Z",
        created_at: "2000-01-01T00:00:00.000Z",
      }));

      await expect(withRunLedgerTransaction(runDir, async () => undefined, {
        [phase]: async () => { throw new Error(`injected crash ${phase}`); },
      })).rejects.toThrow(`injected crash ${phase}`);
      expect((await readdir(runDir)).some((name) => name.startsWith(".ledger.lock.recovery-")))
        .toBe(true);

      await updateManifestV2(runDir, { retry_counts: { quarantine_recovered: 1 } });
      expect((await readdir(runDir)).some((name) => name.startsWith(".ledger.lock.recovery-")))
        .toBe(false);
      expect((await readManifestV2(runDir)).retry_counts.quarantine_recovered).toBe(1);
    },
  );

  it("serializes parallel recordPlan bodies without revision or artifact collisions", async () => {
    const runDir = await createApprovedRun();
    const [first, second] = await Promise.all([
      recordPlan(runDir, "# parallel plan A"),
      recordPlan(runDir, "# parallel plan B"),
    ]);

    expect([first.revision, second.revision].sort()).toEqual([2, 3]);
    expect(await readFile(first.path, "utf8")).toBe("# parallel plan A");
    expect(await readFile(second.path, "utf8")).toBe("# parallel plan B");
    expect((await readManifestV2(runDir)).current_revision).toBe(3);
  });

  it("serializes parallel transition bodies in legal FIFO order", async () => {
    const runDir = await createApprovedRun();
    await Promise.all([
      transitionRun(runDir, "preflight"),
      transitionRun(runDir, "brain_planning"),
    ]);
    expect((await readManifestV2(runDir)).stage).toBe("brain_planning");
  });

  it("preserves FIFO transitions across canonical and symlinked run aliases", async () => {
    const runDir = await createApprovedRun();
    const canonicalRunDir = await realpath(runDir);
    const alias = join(repoRoot!, "run-ledger-alias");
    await symlink(runDir, alias);

    await Promise.all([
      transitionRun(runDir, "preflight"),
      transitionRun(canonicalRunDir, "brain_planning"),
      transitionRun(alias, "awaiting_plan_approval"),
    ]);

    expect((await readManifestV2(runDir)).stage).toBe("awaiting_plan_approval");
  });

  it.each(["helper", "record_plan", "transition", "finding"] as const)(
    "rejects same-run compound reentrancy through %s immediately and without mutation",
    async (operation) => {
      const runDir = await createApprovedRun();
      const manifestPath = join(runDir, "manifest.json");
      const beforeManifest = await readFile(manifestPath, "utf8");
      const beforePlans = await readdir(join(runDir, "plans"));
      const beforeFindings = await readdir(join(runDir, "findings"));
      const beforeEvents = await readFile(join(runDir, "events.jsonl"), "utf8");
      const startedAt = Date.now();
      let observed: unknown;

      await withRunLedgerCompoundTransaction(runDir, async () => {
        const nested = operation === "helper"
          ? withRunLedgerCompoundTransaction(runDir, async () => undefined)
          : operation === "record_plan"
            ? recordPlan(runDir, "# forbidden nested plan")
            : operation === "transition"
              ? transitionRun(runDir, "preflight")
              : recordFindingRevision(runDir, revisionInput());
        observed = await Promise.race([
          nested.then(() => "resolved", (error: unknown) => error),
          new Promise((resolve) => setTimeout(() => resolve(new Error("nested timeout")), 250)),
        ]);
      });
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(Date.now() - startedAt).toBeLessThan(1_000);
      expect(observed).toBeInstanceOf(Error);
      expect((observed as Error).message).toMatch(/compound.*reentr|reentrant.*compound/i);
      expect(await readFile(manifestPath, "utf8")).toBe(beforeManifest);
      expect(await readdir(join(runDir, "plans"))).toEqual(beforePlans);
      expect(await readdir(join(runDir, "findings"))).toEqual(beforeFindings);
      expect(await readFile(join(runDir, "events.jsonl"), "utf8")).toBe(beforeEvents);
    },
  );

  it("serializes parallel approvals without criterion or SHA drift", async () => {
    const runDir = await createApprovedRun();
    const revision = await recordPlan(runDir, JSON.stringify({
      work_items: [{ id: "item/alpha", acceptance_criteria: ["Parallel approval"] }],
    }));
    const [first, second] = await Promise.all([
      approvePlanRevision(runDir, revision.revision),
      approvePlanRevision(runDir, revision.revision),
    ]);

    expect(first.approved_revision).toBe(revision.revision);
    expect(second.approved_revision).toBe(revision.revision);
    expect(second.plan_revisions[String(revision.revision)]?.acceptance_criteria?.["item/alpha"])
      .toHaveLength(1);
  });

  it("recovers a stale tokenized recovery directory by takeover", async () => {
    const runDir = await createApprovedRun();
    const recovery = join(runDir, ".ledger.lock.recovery-stale");
    await mkdir(recovery);
    await writeFile(join(recovery, "reclaimer.json"), JSON.stringify({
      token: "dead-reclaimer",
      pid: 2_147_483_647,
      hostname: hostname(),
      process_started_at: "2000-01-01T00:00:00.000Z",
      created_at: "2000-01-01T00:00:00.000Z",
    }));
    const old = new Date("2000-01-01T00:00:00.000Z");
    await utimes(recovery, old, old);

    await updateManifestV2(runDir, { retry_counts: { recovery_takeover: 1 } });
    expect((await readManifestV2(runDir)).retry_counts.recovery_takeover).toBe(1);
    expect((await readdir(runDir)).some((name) => name.startsWith(".ledger.lock.recovery-")))
      .toBe(false);
  });

  it("never steals a live tokenized recovery directory", async () => {
    const runDir = await createApprovedRun();
    const recovery = join(runDir, ".ledger.lock.recovery-live");
    await mkdir(recovery);
    await writeFile(join(recovery, "reclaimer.json"), JSON.stringify({
      token: "remote-live-reclaimer",
      pid: 1,
      hostname: "remote-host",
      process_started_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    }));

    await expect(updateManifestV2(runDir, { retry_counts: { stolen: 1 } }))
      .rejects.toThrow(/live|fresh|recovery/i);
    expect(await readdir(recovery)).toContain("reclaimer.json");
  });

  it("honors a recovery barrier that appears immediately after lock mkdir", async () => {
    const runDir = await createApprovedRun();
    let injected = false;
    await withRunLedgerTransaction(runDir, async (transaction) => {
      await transaction.updateManifestV2({ retry_counts: { post_mkdir_barrier: 1 } });
    }, {
      afterLockDirectoryCreated: async () => {
        if (injected) return;
        injected = true;
        const recovery = join(runDir, ".ledger.lock.recovery-post-mkdir");
        await mkdir(recovery);
        const old = new Date("2000-01-01T00:00:00.000Z");
        await utimes(recovery, old, old);
      },
    });

    expect((await readManifestV2(runDir)).retry_counts.post_mkdir_barrier).toBe(1);
    expect((await readdir(runDir)).some((name) => name.startsWith(".ledger.lock.recovery-")))
      .toBe(false);
  });

  it("rejects unknown criterion provenance before creating history", async () => {
    const runDir = await createApprovedRun();

    await expect(recordFindingRevision(runDir, revisionInput({
      criterion_ref: "BH-999:AC-1",
    }))).rejects.toThrow(/approved criterion/i);
    await expect(readFile(findingHistoryPath(runDir, "item/alpha"), "utf8"))
      .rejects.toThrow("ENOENT");
  });

  it("rejects mismatched work-item criterion provenance", async () => {
    const runDir = await createApprovedRun();

    await expect(recordFindingRevision(runDir, revisionInput({
      work_item_id: "different-item",
    }))).rejects.toThrow(/provenance/i);
  });

  it("accepts snapshotted release guards and rejects unsafe evidence paths", async () => {
    const runDir = await createApprovedRun();
    const releaseFinding = await recordFindingRevision(runDir, revisionInput({
      source: "release_guard",
      criterion_ref: "release:no-secrets",
      normalized_location: "repository",
      problem_class: "secret-detected",
    }));

    expect(releaseFinding.criterion_ref).toBe("release:no-secrets");
    expect(findingRevisionInputSchema.safeParse(revisionInput({
      evidence_refs: ["../outside.json"],
    })).success).toBe(false);
    await expect(recordFindingRevision(runDir, revisionInput({
      evidence_refs: ["/tmp/outside.json"],
    }))).rejects.toThrow();
  });

  it.each(["verifier", "verification"] as const)(
    "rejects release-guard provenance from %s findings",
    async (source) => {
      const runDir = await createApprovedRun();
      await expect(recordFindingRevision(runDir, revisionInput({
        source,
        criterion_ref: "release:no-secrets",
      }))).rejects.toThrow(/approved criterion|source provenance/i);
    },
  );

  it("rejects approved-criterion provenance from release_guard findings", async () => {
    const runDir = await createApprovedRun();
    await expect(recordFindingRevision(runDir, revisionInput({ source: "release_guard" })))
      .rejects.toThrow(/release.guard.*provenance/i);
  });

  it("rejects a symlinked findings directory without writing outside the run", async () => {
    const runDir = await createApprovedRun();
    const outside = await mkdtemp(join(tmpdir(), "brain-hands-findings-outside-"));
    await rm(join(runDir, "findings"), { recursive: true });
    await symlink(outside, join(runDir, "findings"));

    await expect(recordFindingRevision(runDir, revisionInput())).rejects.toThrow(/symlink/i);
    expect(await readdir(outside)).toEqual([]);
    await rm(outside, { recursive: true, force: true });
  });

  it("rejects a symlinked work-item history target", async () => {
    const runDir = await createApprovedRun();
    const outside = join(repoRoot!, "outside-history.jsonl");
    await writeFile(outside, "outside\n");
    await symlink(outside, findingHistoryPath(runDir, "item/alpha"));

    await expect(recordFindingRevision(runDir, revisionInput())).rejects.toThrow(/symlink/i);
    expect(await readFile(outside, "utf8")).toBe("outside\n");
  });

  it("rejects a symlinked ledger lock", async () => {
    const runDir = await createApprovedRun();
    const outside = await mkdtemp(join(tmpdir(), "brain-hands-lock-outside-"));
    await symlink(outside, join(runDir, ".ledger.lock"));

    await expect(updateManifestV2(runDir, { retry_counts: { escaped: 1 } }))
      .rejects.toThrow(/symlink/i);
    expect(await readdir(outside)).toEqual([]);
    await rm(outside, { recursive: true, force: true });
  });

  it("rejects a findings parent component swap before opening history", async () => {
    const runDir = await createApprovedRun();
    const outside = await mkdtemp(join(tmpdir(), "brain-hands-parent-swap-"));

    await expect(recordFindingRevision(runDir, revisionInput(), {
      afterFindingsDirectoryValidated: async () => {
        await rename(join(runDir, "findings"), join(runDir, "findings-original"));
        await symlink(outside, join(runDir, "findings"));
      },
    })).rejects.toThrow(/symlink|directory.*changed|identity/i);
    expect(await readdir(outside)).toEqual([]);
    await rm(outside, { recursive: true, force: true });
  });

  it("rejects a lock parent swap before writing owner content", async () => {
    const runDir = await createApprovedRun();
    const outside = await mkdtemp(join(tmpdir(), "brain-hands-lock-swap-"));

    await expect(withRunLedgerTransaction(runDir, async () => undefined, {
      afterLockDirectoryCreated: async (lockPath: string) => {
        await rename(lockPath, `${lockPath}.original`);
        await symlink(outside, lockPath);
      },
    })).rejects.toThrow(/symlink|directory.*changed|identity/i);
    expect(await readdir(outside)).toEqual([]);
    await rm(outside, { recursive: true, force: true });
  });

  it.each(["write", "sync", "close", "rename"] as const)(
    "cleans atomic manifest temp files after injected %s failure",
    async (phase) => {
      const runDir = await createApprovedRun();
      await expect(withRunLedgerTransaction(runDir, async (transaction) => {
        await transaction.updateManifestV2({ retry_counts: { injected: 1 } });
      }, {
        beforeManifestPhase: async (current: string) => {
          if (current === phase) throw new Error(`injected ${phase} failure`);
        },
      })).rejects.toThrow(`injected ${phase} failure`);

      expect((await readdir(runDir)).some((name) => name.startsWith(".manifest-"))).toBe(false);
      expect((await readManifestV2(runDir)).retry_counts.injected).toBeUndefined();
    },
  );

  it("quarantines and truncates a final partial JSONL tail before appending", async () => {
    const runDir = await createApprovedRun();
    await recordFindingRevision(runDir, revisionInput());
    const historyPath = findingHistoryPath(runDir, "item/alpha");
    await import("node:fs/promises").then(({ appendFile }) => appendFile(historyPath, "{\"partial\":"));

    const second = await recordFindingRevision(runDir, revisionInput({ review_revision: 2 }));
    const lines = await historyLines(runDir);
    const artifacts = await readdir(join(runDir, "findings"));

    expect(second.occurrences).toBe(2);
    expect(lines).toHaveLength(2);
    expect(artifacts.some((name) => name.includes("corrupt-tail"))).toBe(true);
  });

  it("durably creates the tail quarantine before an injected truncation failure", async () => {
    const runDir = await createApprovedRun();
    await recordFindingRevision(runDir, revisionInput());
    const historyPath = findingHistoryPath(runDir, "item/alpha");
    await import("node:fs/promises").then(({ appendFile }) => appendFile(historyPath, "partial-tail"));

    await expect(recordFindingRevision(runDir, revisionInput({ review_revision: 2 }), {
      afterTailQuarantineSynced: async () => { throw new Error("injected truncate failure"); },
    })).rejects.toThrow("injected truncate failure");

    expect((await readdir(join(runDir, "findings")))
      .some((name) => name.includes("corrupt-tail"))).toBe(true);
    expect((await readFile(historyPath, "utf8")).endsWith("partial-tail")).toBe(true);
  });

  it("fails closed on a corrupt complete JSONL line", async () => {
    const runDir = await createApprovedRun();
    await recordFindingRevision(runDir, revisionInput());
    const historyPath = findingHistoryPath(runDir, "item/alpha");
    await import("node:fs/promises").then(({ appendFile }) => appendFile(historyPath, "not-json\n"));

    await expect(recordFindingRevision(runDir, revisionInput({ review_revision: 2 })))
      .rejects.toThrow();
    expect((await readFile(historyPath, "utf8")).endsWith("not-json\n")).toBe(true);
  });

  it("does not opt snapshot-less active runs into finding persistence", async () => {
    const runDir = await createApprovedRun();
    const manifestPath = join(runDir, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    delete manifest.review_policy_snapshot;
    delete manifest.release_guards;
    delete manifest.review_accounting;
    await import("node:fs/promises").then(({ writeFile }) =>
      writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8"));

    await expect(recordFindingRevision(runDir, revisionInput()))
      .rejects.toThrow(/legacy|policy snapshot/i);
    expect((await readManifestV2(runDir)).finding_index).toBeUndefined();
  });
});
