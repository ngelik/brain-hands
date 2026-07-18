import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type PromptTemplateName =
  | "brain-planner"
  | "brain-discovery-v1"
  | "brain-plan-v2"
  | "brain-plan-repair-v1"
  | "brain-replan-patch-v2"
  | "brain-issue-critic"
  | "brain-reviewer"
  | "brain-final-auditor"
  | "hands-work-item-v2"
  | "hands-fix-packet-v1"
  | "hands-recovery-v2"
  | "hands-self-review-v2"
  | "verifier-review-v2"
  | "verifier-review-legacy-v2"
  | "verifier-action-resolution-v2"
  | "verifier-fix-packet-resolution-v1"
  | "verifier-fix-packet-correction-v1"
  | "hands-implementer"
  | "hands-fixer"
  | "reflection-v2"
  | "reflection-legacy-v2"
  | "reflection-single-pass-v1"
  | "reflection-synthesis-v2"
  | "reflection-synthesis-legacy-v2"
  | "improvement-plan-v2";

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function loadPromptTemplate(name: PromptTemplateName): Promise<string> {
  const projectRoot = join(__dirname, "..", "..");
  return readFile(join(projectRoot, "prompts", `${name}.md`), "utf8");
}
