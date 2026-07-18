import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { issueSpecSchema } from "../core/schema.js";
import type { IssueSpec } from "../core/types.js";

export interface ImportIssuesInput {
  runDir: string;
  filePath: string;
}

function parseIssueInput(raw: unknown): IssueSpec[] {
  if (Array.isArray(raw)) {
    return raw.map((entry, index) => {
      try {
        return issueSpecSchema.parse(entry);
      } catch (error) {
        throw new Error(
          `Invalid issue at index ${index}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });
  }

  if (raw === null || typeof raw !== "object") {
    throw new Error("Issue import file must contain a JSON object or array.");
  }

  return [issueSpecSchema.parse(raw)];
}

export async function importIssues(input: ImportIssuesInput): Promise<IssueSpec[]> {
  const raw = await readFile(input.filePath, "utf8");
  const parsed = JSON.parse(raw);
  const issues = parseIssueInput(parsed);
  const outputPath = join(input.runDir, "issues.json");
  const serialized = `${JSON.stringify(issues, null, 2)}\n`;

  await writeFile(outputPath, serialized, "utf8");
  return issues;
}
