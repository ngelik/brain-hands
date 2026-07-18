import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendGitHubStatusIntent,
  readGitHubStatusIntents,
  readGitHubStatusCheckpoint,
  updateGitHubStatusCheckpoint,
} from "../../src/github/status-checkpoint.js";

let root: string | undefined;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe("GitHub status persistence", () => {
  it("creates a versioned checkpoint without persisting rendered bodies", async () => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-status-"));
    expect(await readGitHubStatusCheckpoint(root)).toEqual({ version: 1, targets: {} });

    await updateGitHubStatusCheckpoint(root, "issue:12:item-a", (current) => ({
      ...current,
      commentId: 901,
      projectionHash: "a".repeat(64),
      label: "brain-hands:ready",
      emittedEventKeys: ["reviewer-findings:item-a:attempt-1"],
      syncedAt: "2026-07-11T16:25:00.000Z",
      retry: null,
    }));

    const persisted = await readFile(join(root, "github-status.json"), "utf8");
    expect(JSON.parse(persisted).targets["issue:12:item-a"].commentId).toBe(901);
    expect(persisted).not.toContain("Brain Hands status");
  });

  it("quarantines corrupt checkpoints and continues from an empty rebuildable state", async () => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-status-"));
    await writeFile(join(root, "github-status.json"), '{"version":1,"targets":{"bad":true}}\n');

    expect(await readGitHubStatusCheckpoint(root)).toEqual({ version: 1, targets: {} });
    expect((await readdir(root)).some((name) => name.startsWith("github-status.json.corrupt-"))).toBe(true);
  });

  it("deduplicates identical intents but appends a superseding payload for the same identity", async () => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-status-"));
    const intent = {
      version: 1 as const,
      id: "issue:12:item-a:complete:attempt-1",
      target: { kind: "issue" as const, number: 12 },
      runId: "run-1",
      workItemId: "item-a",
      state: "complete" as const,
      attempt: 1,
      transitionAt: "2026-07-11T16:25:00.000Z",
      evidencePath: "verification/issue-1/attempt-1/evidence.json",
      reviewPath: "reviews/item-a/attempt-1.json",
      materialEvents: [],
    };

    await appendGitHubStatusIntent(root, intent);
    await appendGitHubStatusIntent(root, intent);
    await appendGitHubStatusIntent(root, { ...intent, transitionAt: "2026-07-11T16:26:00.000Z" });

    expect(await readGitHubStatusIntents(root)).toEqual([
      intent,
      { ...intent, transitionAt: "2026-07-11T16:26:00.000Z" },
    ]);
  });

  it("replays valid intents after a torn intent line", async () => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-status-"));
    const valid = {
      version: 1 as const,
      id: "issue:12:item-a:complete:attempt-1",
      target: { kind: "issue" as const, number: 12 },
      runId: "run-1",
      workItemId: "item-a",
      state: "complete" as const,
      attempt: 1,
      transitionAt: "2026-07-11T16:25:00.000Z",
      materialEvents: [],
    };
    await writeFile(join(root, "github-status-intents.jsonl"), `{"version":\n${JSON.stringify(valid)}\n`);

    expect(await readGitHubStatusIntents(root)).toEqual([valid]);
  });
});
