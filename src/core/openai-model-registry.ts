export type KnownModelSurface = "codex_and_api" | "api_only";

export interface KnownOpenAIModel {
  readonly id: string;
  readonly family: "gpt-5.6" | "gpt-5.5";
  readonly tier: "alias" | "sol" | "terra" | "luna" | "flagship" | "pro" | "snapshot";
  readonly description: string;
  readonly reasoning_efforts: readonly string[];
  readonly surface: KnownModelSurface;
  readonly resolves_to?: string;
  readonly aliases: readonly string[];
}

export const KNOWN_OPENAI_MODELS: readonly KnownOpenAIModel[] = [
  {
    id: "gpt-5.6",
    family: "gpt-5.6",
    tier: "alias",
    description: "GPT-5.6 family alias; routes to Sol",
    reasoning_efforts: ["none", "low", "medium", "high", "xhigh", "max"],
    surface: "codex_and_api",
    resolves_to: "gpt-5.6-sol",
    aliases: ["5.6", "gpt 5.6"],
  },
  {
    id: "gpt-5.6-sol",
    family: "gpt-5.6",
    tier: "sol",
    description: "Flagship model for complex, open-ended work",
    reasoning_efforts: ["none", "low", "medium", "high", "xhigh", "max"],
    surface: "codex_and_api",
    aliases: ["sol", "5.6 sol", "gpt 5.6 sol", "flagship", "frontier", "best", "smartest"],
  },
  {
    id: "gpt-5.6-terra",
    family: "gpt-5.6",
    tier: "terra",
    description: "Balanced everyday model for capability and cost",
    reasoning_efforts: ["none", "low", "medium", "high", "xhigh", "max"],
    surface: "codex_and_api",
    aliases: ["terra", "5.6 terra", "gpt 5.6 terra", "balanced", "everyday", "workhorse"],
  },
  {
    id: "gpt-5.6-luna",
    family: "gpt-5.6",
    tier: "luna",
    description: "Fast, efficient model for clear, high-volume work",
    reasoning_efforts: ["none", "low", "medium", "high", "xhigh", "max"],
    surface: "codex_and_api",
    aliases: ["luna", "5.6 luna", "gpt 5.6 luna", "fast", "fastest", "cheap", "cheapest", "efficient", "high volume"],
  },
  {
    id: "gpt-5.5",
    family: "gpt-5.5",
    tier: "flagship",
    description: "Previous-generation frontier model",
    reasoning_efforts: ["none", "low", "medium", "high", "xhigh"],
    surface: "codex_and_api",
    aliases: ["5.5", "gpt 5.5", "5.5 flagship", "gpt 5.5 flagship"],
  },
  {
    id: "gpt-5.5-pro",
    family: "gpt-5.5",
    tier: "pro",
    description: "API model that uses more compute for difficult work",
    reasoning_efforts: ["medium", "high", "xhigh"],
    surface: "api_only",
    aliases: ["5.5 pro", "gpt 5.5 pro"],
  },
  {
    id: "gpt-5.5-2026-04-23",
    family: "gpt-5.5",
    tier: "snapshot",
    description: "Pinned GPT-5.5 API snapshot",
    reasoning_efforts: ["none", "low", "medium", "high", "xhigh"],
    surface: "api_only",
    aliases: [],
  },
  {
    id: "gpt-5.5-pro-2026-04-23",
    family: "gpt-5.5",
    tier: "snapshot",
    description: "Pinned GPT-5.5 Pro API snapshot",
    reasoning_efforts: ["medium", "high", "xhigh"],
    surface: "api_only",
    aliases: [],
  },
] as const;

function normalizeModelRequest(value: string): string {
  return value.trim().toLowerCase().replace(/[._-]+/g, " ").replace(/\s+/g, " ");
}

function resolvedSlug(model: KnownOpenAIModel): string {
  return model.resolves_to ?? model.id;
}

export function findKnownOpenAIModel(value: string): KnownOpenAIModel | null {
  const exact = KNOWN_OPENAI_MODELS.find((model) => model.id.toLowerCase() === value.trim().toLowerCase());
  if (exact) return exact;
  const normalized = normalizeModelRequest(value);
  return KNOWN_OPENAI_MODELS.find((model) =>
    model.aliases.some((alias) => normalizeModelRequest(alias) === normalized)
  ) ?? null;
}

export function formatKnownModelChoices(): string {
  return KNOWN_OPENAI_MODELS
    .filter((model) => model.tier !== "snapshot" && model.tier !== "alias")
    .map((model) => `${model.id} (${model.description})`)
    .join(", ");
}

export function resolveModelOverride(value: string): string {
  const known = findKnownOpenAIModel(value);
  if (known) return resolvedSlug(known);
  const trimmed = value.trim();
  if (/^[a-z0-9][a-z0-9._:-]*$/i.test(trimmed)) return trimmed;
  throw new Error(
    `Unrecognized model description "${value}". Use an exact model slug or one of: ${formatKnownModelChoices()}.`,
  );
}

export function knownModelAvailabilityNote(value: string): string | null {
  const model = KNOWN_OPENAI_MODELS.find((candidate) => resolvedSlug(candidate) === value || candidate.id === value);
  if (!model) return null;
  if (model.surface === "api_only") {
    return `The built-in OpenAI model registry recognizes "${value}" as an API model, but Brain Hands requires a matching local Codex catalog entry.`;
  }
  return `The built-in OpenAI model registry recognizes "${value}", but the current local Codex catalog does not expose it.`;
}
