import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendOwnedRunFile,
  readOwnedEvidenceFile,
  readOwnedRunFile,
  writeOwnedEvidenceFile,
} from "../../src/core/owned-evidence.js";

let root: string | null = null;

afterEach(async () => {
  if (root !== null) await rm(root, { recursive: true, force: true });
  root = null;
});

async function runDir(): Promise<string> {
  root = await mkdtemp(join(tmpdir(), "brain-hands-owned-io-"));
  await mkdir(join(root, "run"));
  return join(root, "run");
}

describe("owned descriptor I/O canonical pathname binding", () => {
  it("rejects a plan evidence replacement after descriptor write", async () => {
    const run = await runDir();
    const target = join(run, "plans/revision-1.md");
    const replacement = Buffer.from("replacement-plan\n", "utf8");
    await expect(writeOwnedEvidenceFile(run, "plans/revision-1.md", "plans/", "approved-plan\n", {
      afterDescriptorIo: async () => {
        await rename(target, `${target}.saved`);
        await writeFile(target, replacement);
      },
    })).rejects.toThrow(/identity|changed/i);
    expect(await readFile(target)).toEqual(replacement);
  });

  it("rejects a plan evidence replacement after descriptor read", async () => {
    const run = await runDir();
    const target = join(run, "plans/revision-1.md");
    const replacement = Buffer.from("replacement-plan\n", "utf8");
    await writeOwnedEvidenceFile(run, "plans/revision-1.md", "plans/", "approved-plan\n");
    await expect(readOwnedEvidenceFile(run, "plans/revision-1.md", "plans/", undefined, {
      afterDescriptorIo: async () => {
        await rename(target, `${target}.saved`);
        await writeFile(target, replacement);
      },
    })).rejects.toThrow(/identity|changed/i);
    expect(await readFile(target)).toEqual(replacement);
  });

  it("rejects an event log replacement after descriptor read", async () => {
    const run = await runDir();
    const target = join(run, "events.jsonl");
    const replacement = Buffer.from("replacement-events\n", "utf8");
    await writeFile(target, "original-events\n");
    await expect(readOwnedRunFile(run, "events.jsonl", {
      afterDescriptorIo: async () => {
        await rename(target, `${target}.saved`);
        await writeFile(target, replacement);
      },
    })).rejects.toThrow(/identity|changed/i);
    expect(await readFile(target)).toEqual(replacement);
  });

  it("rejects an event log replacement after descriptor append", async () => {
    const run = await runDir();
    const target = join(run, "events.jsonl");
    const replacement = Buffer.from("replacement-events\n", "utf8");
    await writeFile(target, "original-events\n");
    await expect(appendOwnedRunFile(run, "events.jsonl", "appended-event\n", {
      afterDescriptorIo: async () => {
        await rename(target, `${target}.saved`);
        await writeFile(target, replacement);
      },
    })).rejects.toThrow(/identity|changed/i);
    expect(await readFile(target)).toEqual(replacement);
  });
});
