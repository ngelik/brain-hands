import { runCommand } from "../core/executor.js";
import type { CommandResult } from "../core/executor.js";
import type { ModelRole, RoleName } from "../core/types.js";
import { knownModelAvailabilityNote } from "../core/openai-model-registry.js";

type CodexModelRole = ModelRole | RoleName;
type CanonicalRole = "brain" | "hands" | "verifier";

export interface ModelCatalog {
  models: readonly ModelCatalogEntry[];
}

export interface ModelCatalogEntry {
  readonly slug: string;
  readonly reasoningEfforts: readonly string[];
}

export interface ValidateModelSelectionInput {
  role: CodexModelRole;
  model: string;
  reasoningEffort: string;
}

interface CatalogCommandOptions {
  command: string;
  cwd: string;
  timeoutMs: number;
}

interface RoleRecommendation {
  modelField: string;
  reasoningEffortField: string;
}

function configuredPairMessage(input: ValidateModelSelectionInput): string {
  return `Configured model/reasoning pair for role "${input.role}": model "${input.model}", reasoning_effort "${input.reasoningEffort}".`;
}

const ROLE_RECOMMENDATIONS: Record<CanonicalRole, RoleRecommendation> = {
  brain: { modelField: "profiles.brain.model", reasoningEffortField: "profiles.brain.reasoning_effort" },
  hands: { modelField: "profiles.hands.model", reasoningEffortField: "profiles.hands.reasoning_effort" },
  verifier: { modelField: "profiles.verifier.model", reasoningEffortField: "profiles.verifier.reasoning_effort" },
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mapRole(role: CodexModelRole): CanonicalRole {
  if (role === "brain_planner" || role === "brain") return "brain";
  if (role === "brain_reviewer") return "verifier";
  if (role === "hands_implementer" || role === "hands_fixer" || role === "hands") return "hands";
  return "verifier";
}

function formatCatalogChoices(catalog: ModelCatalog): string {
  return catalog.models
    .map((entry) => `${entry.slug} (${entry.reasoningEfforts.join(", ")})`)
    .sort()
    .join(", ");
}

function recommendations(role: CanonicalRole, input: ValidateModelSelectionInput, reason: string): string {
  const fields = ROLE_RECOMMENDATIONS[role];
  return [
    configuredPairMessage(input),
    reason,
    "Recommended actions:",
    `1. Run "codex update" to refresh the local model catalog.`,
    `2. Run "codex debug models" to inspect available model IDs and reasoning efforts.`,
    `3. Update ${fields.modelField} and ${fields.reasoningEffortField} with exact values.`,
  ].join("\n");
}

function parseCatalogModel(entry: unknown, index: number): ModelCatalogEntry {
  if (!isObject(entry)) {
    throw new Error(`Model catalog entry ${index} must be an object with a model slug and exact reasoning-effort list.`);
  }

  const model = entry.slug;
  const efforts = entry.supported_reasoning_levels;

  if (typeof model !== "string" || model.trim() === "") {
    throw new Error(`Model catalog entry ${index} is missing a non-empty string slug.`);
  }
  if (!Array.isArray(efforts) || efforts.length === 0) {
    throw new Error(`Model catalog entry "${model}" must include an array of supported_reasoning_levels.`);
  }

  const parsedEfforts = efforts.map((effort, effortIndex) => {
    if (!isObject(effort) || typeof effort.effort !== "string" || effort.effort.trim() === "") {
      throw new Error(
        `Model catalog entry "${model}" contains an invalid reasoning effort value at index ${effortIndex}.`,
      );
    }
    return effort.effort;
  });

  return { slug: model, reasoningEfforts: parsedEfforts };
}

function parseCodexCatalogJson(raw: string): ModelCatalog {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error: unknown) {
    throw new Error(
      `Malformed Codex model catalog JSON from debug models: ${
        error instanceof Error ? error.message : "not valid JSON"
      }`,
    );
  }

  if (!isObject(parsed)) {
    throw new Error("Malformed Codex model catalog: expected a top-level object with a models list.");
  }

  if (!Array.isArray(parsed.models)) {
    throw new Error("Malformed Codex model catalog: expected `models` array.");
  }

  const seen = new Set<string>();
  const entries = parsed.models.map((entry, index) => {
    const parsedEntry = parseCatalogModel(entry, index);
    if (seen.has(parsedEntry.slug)) {
      throw new Error(`Malformed Codex model catalog: duplicate model slug "${parsedEntry.slug}".`);
    }
    seen.add(parsedEntry.slug);
    return parsedEntry;
  });

  return { models: entries };
}

async function fetchCodexModelCatalog(options: CatalogCommandOptions): Promise<CommandResult> {
  const args = ["debug", "models"];
  return runCommand({
    command: options.command,
    args,
    cwd: options.cwd,
    timeoutMs: options.timeoutMs,
  });
}

export class CodexModelCatalogAdapter {
  private cache?: ModelCatalog;
  private loading?: Promise<ModelCatalog>;

  constructor(private readonly options: CatalogCommandOptions) {}

  async assertExactModelSelection(input: ValidateModelSelectionInput): Promise<void> {
    const role = mapRole(input.role);
    let catalog: ModelCatalog;
    try {
      catalog = await this.loadCatalog();
    } catch (error) {
      throw new Error(
        recommendations(
          role,
          input,
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
    const match = catalog.models.find((entry) => entry.slug === input.model);
    if (!match) {
      const availabilityNote = knownModelAvailabilityNote(input.model);
      throw new Error(
        recommendations(
          role,
          input,
          `Configured model/reasoning pair for role "${input.role}" is invalid: model "${input.model}" and reasoning "${input.reasoningEffort}" ` +
            `are not an exact catalog match.\n` +
            `Supported model slugs: ${formatCatalogChoices(catalog)}` +
            (availabilityNote === null ? "" : `\n${availabilityNote}`),
        ),
      );
    }

    if (!match.reasoningEfforts.includes(input.reasoningEffort)) {
      throw new Error(
        recommendations(
          role,
          input,
          `Configured model/reasoning pair for role "${input.role}" is invalid: reasoning "${input.reasoningEffort}" ` +
            `is not supported for model "${input.model}".\n` +
            `Supported efforts for "${input.model}": ${match.reasoningEfforts.join(", ")}`,
        ),
      );
    }
  }

  private async loadCatalog(): Promise<ModelCatalog> {
    if (this.cache) return this.cache;
    if (this.loading) return this.loading;

    this.loading = this.fetchCatalog();
    try {
      const catalog = await this.loading;
      this.cache = catalog;
      return catalog;
    } finally {
      if (!this.cache) this.loading = undefined;
    }
  }

  private async fetchCatalog(): Promise<ModelCatalog> {
    const result = await fetchCodexModelCatalog(this.options);
    if (result.exitCode !== 0 || result.failed) {
      throw new Error(
        `Codex model catalog request failed.\n` +
          `Command: ${this.options.command} debug models\n` +
          `stdout: ${result.stdout}\n` +
          `stderr: ${result.stderr || result.errorMessage || "no stderr"}`,
      );
    }

    try {
      return parseCodexCatalogJson(result.stdout);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Malformed Codex model catalog from "${this.options.command} debug models": ${message}`,
      );
    }
  }
}
