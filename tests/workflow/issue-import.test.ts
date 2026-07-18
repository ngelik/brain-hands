import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { importIssues } from "../../src/workflow/issue-import.js";

let tempRoot: string | null = null;

afterEach(async () => {
  if (tempRoot) {
    await rm(tempRoot, { recursive: true, force: true });
    tempRoot = null;
  }
});

async function createRunDir(root: string): Promise<string> {
  const runDir = join(root, "run");
  await mkdir(runDir, { recursive: true });
  return runDir;
}

function issuePayload(overrides: Record<string, unknown> = {}) {
  return {
    type: "implementation_task",
    run_id: "2026-07-08T12-00-00Z-import",
    parent_request: "Add solar issue import",
    goal: "Import one issue",
    context: "Need a reusable issue import helper",
    scope: { include: ["src/workflow/issue-import.ts"], exclude: [] },
    dependencies: [],
    implementation_steps: ["Parse and validate incoming issue JSON."],
    acceptance_criteria: ["Issue file is written to issues.json."],
    verification: {
      required_commands: ["npm run typecheck"],
      manual_checks: [],
      expected_artifacts: ["issues.json"],
    },
    review_checklist: ["Issue import validates input"],
    risk_register: [],
    handoff_prompt: "Import and validate the issue fixture.",
    ...(overrides && overrides),
  };
}

describe("importIssues", () => {
  it("writes one issue object to issues.json with stable formatting", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "brain-hands-issue-import-"));
    const runDir = await createRunDir(tempRoot);
    const filePath = join(tempRoot, "issue.json");
    await writeFile(
      filePath,
      JSON.stringify(issuePayload(), null, 2),
      "utf8",
    );

    await importIssues({ runDir, filePath });
    const raw = await readFile(join(runDir, "issues.json"), "utf8");
    const loaded = JSON.parse(raw) as unknown[];

    expect(Array.isArray(loaded)).toBe(true);
    expect(loaded).toEqual([{ ...issuePayload(), browser_checks: [] }]);
    expect(raw).toContain(`"goal": "Import one issue"`);
  });

  it("writes an issue array to issues.json", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "brain-hands-issue-import-"));
    const runDir = await createRunDir(tempRoot);
    const filePath = join(tempRoot, "issues.json");
    const issues = [issuePayload(), issuePayload({ goal: "Second imported issue" })];

    await writeFile(filePath, JSON.stringify(issues), "utf8");

    const result = await importIssues({ runDir, filePath });
    const raw = await readFile(join(runDir, "issues.json"), "utf8");
    const written = JSON.parse(raw) as unknown[];

    expect(result).toHaveLength(2);
    const expected = issues.map((issue) => ({ ...issue, browser_checks: [] }));
    expect(written).toEqual(expected);
  });

  it("rejects non-object issue payloads", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "brain-hands-issue-import-"));
    const runDir = await createRunDir(tempRoot);
    const filePath = join(tempRoot, "issue.json");
    await writeFile(filePath, '"just a scalar"', "utf8");

    await expect(importIssues({ runDir, filePath })).rejects.toThrow(
      "Issue import file must contain a JSON object or array.",
    );
  });
});
