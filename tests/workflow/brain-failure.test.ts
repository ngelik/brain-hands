import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { createRunLedgerV2, writeTextArtifact } from "../../src/core/ledger.js";
import { brainInvocationArtifactName, recordBrainFailure } from "../../src/workflow/brain-failure.js";
import { writeOwnedEvidenceFile } from "../../src/core/owned-evidence.js";

let root: string | null = null;
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = null; });

describe("Brain failure evidence", () => {
  it("rejects a final failure symlink without changing its outside target", async () => {
    root = await mkdtemp(join(tmpdir(), "brain-failure-final-link-"));
    const ledger = await createRunLedgerV2({ repoRoot: root, originalRequest: "Keep final failure owned" });
    await mkdir(join(ledger.runDir, "failures"));
    const outside = join(root, "outside-failure.json");
    await writeFile(outside, "unchanged");
    await symlink(outside, join(ledger.runDir, "failures/owned.json"));
    await expect(writeOwnedEvidenceFile(ledger.runDir, "failures/owned.json", "failures/", "changed"))
      .rejects.toThrow(/symlink|owned/i);
    expect(await readFile(outside, "utf8")).toBe("unchanged");
  });
  it("rejects a symlinked failure root without writing outside the run", async () => {
    root = await mkdtemp(join(tmpdir(), "brain-failure-owned-"));
    const ledger = await createRunLedgerV2({ repoRoot: root, originalRequest: "Keep failures owned" });
    const outside = join(root, "outside-failures");
    await mkdir(outside);
    await symlink(outside, join(ledger.runDir, "failures"));
    await expect(recordBrainFailure({
      runDir: ledger.runDir, phase: "planning", cycle: null, turn: null, attempt: 1,
      error: new Error("failure"), evidence_refs: [],
    })).rejects.toThrow(/symlink|parent/i);
    expect(await readdir(outside)).toEqual([]);
  });
  it("does not reuse crash-left artifacts and stores only bounded sanitized detail", async () => {
    root = await mkdtemp(join(tmpdir(), "brain-failure-evidence-"));
    const ledger = await createRunLedgerV2({ repoRoot: root, originalRequest: "Recover safely" });
    await writeTextArtifact(ledger.runDir, "prompts/brain-plan-v2.md", "crash-left prompt");
    expect(await brainInvocationArtifactName(ledger.runDir, "planning", "brain-plan-v2"))
      .toBe("brain-plan-v2-resume-2");
    await recordBrainFailure({
      runDir: ledger.runDir, phase: "planning", cycle: null, turn: null, attempt: 1,
      error: new Error(`validation failed api_key=sk-proj-${"x".repeat(80)} ${"detail ".repeat(50)}`),
      evidence_refs: ["prompts/brain-plan-v2.md"],
    });
    const [name] = await readdir(join(ledger.runDir, "failures"));
    const failure = JSON.parse(await readFile(join(ledger.runDir, "failures", name), "utf8"));
    expect(failure.detail.code).toBe("brain_invocation");
    expect(failure.detail.message.length).toBeLessThanOrEqual(160);
    expect(JSON.stringify(failure)).not.toContain("sk-proj-");
  });
});
