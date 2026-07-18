import { runCommand, type CommandResult } from "../core/executor.js";
import type { ReasoningEffort } from "../core/types.js";

export interface ModelCatalogSnapshot {
  models: Array<{
    slug: string;
    display_name?: string;
    supported_reasoning_levels: Array<{ effort: string; description?: string }>;
    visibility?: string;
  }>;
}

export interface ModelCatalogSelection {
  slug: string;
  reasoning_effort: ReasoningEffort;
  supported_reasoning_efforts: string[];
}

export async function readModelCatalog(input: {
  command: string;
  cwd: string;
  timeoutMs: number;
}): Promise<{ snapshot: ModelCatalogSnapshot; commandResult: CommandResult }> {
  const commandResult = await runCommand({
    command: input.command,
    args: ["debug", "models"],
    cwd: input.cwd,
    timeoutMs: input.timeoutMs,
  });
  if (commandResult.exitCode !== 0) {
    throw new Error(`Codex model catalog failed: ${commandResult.stderr || commandResult.errorMessage || "no stderr"}`);
  }
  const parsed = JSON.parse(commandResult.stdout) as unknown;
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { models?: unknown }).models)) {
    throw new Error("Codex model catalog is malformed");
  }
  const snapshot = parsed as ModelCatalogSnapshot;
  for (const model of snapshot.models) {
    if (!model || typeof model.slug !== "string" || !Array.isArray(model.supported_reasoning_levels)) {
      throw new Error("Codex model catalog contains a malformed model entry");
    }
  }
  return { snapshot, commandResult };
}

export function validateCatalogProfile(
  snapshot: ModelCatalogSnapshot,
  profile: { model: string; reasoning_effort: ReasoningEffort },
  label: string,
): ModelCatalogSelection {
  const model = snapshot.models.find((candidate) => candidate.slug === profile.model);
  if (!model) throw new Error(`${label} model ${profile.model} is absent from the Codex catalog`);
  const supported_reasoning_efforts = model.supported_reasoning_levels.map((level) => level.effort);
  if (!supported_reasoning_efforts.includes(profile.reasoning_effort)) {
    throw new Error(`${label} model ${profile.model} does not support reasoning effort ${profile.reasoning_effort}`);
  }
  return { slug: model.slug, reasoning_effort: profile.reasoning_effort, supported_reasoning_efforts };
}
