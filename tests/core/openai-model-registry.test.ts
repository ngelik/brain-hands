import { describe, expect, it } from "vitest";
import {
  KNOWN_OPENAI_MODELS,
  knownModelAvailabilityNote,
  resolveModelOverride,
} from "../../src/core/openai-model-registry.js";

describe("OpenAI model registry", () => {
  it("contains all documented GPT-5.6 and GPT-5.5 IDs and snapshots", () => {
    expect(KNOWN_OPENAI_MODELS.map((model) => model.id)).toEqual([
      "gpt-5.6",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
      "gpt-5.5-pro",
      "gpt-5.5-2026-04-23",
      "gpt-5.5-pro-2026-04-23",
    ]);
  });

  it.each([
    ["GPT 5.6", "gpt-5.6-sol"],
    ["Sol", "gpt-5.6-sol"],
    ["balanced", "gpt-5.6-terra"],
    ["everyday", "gpt-5.6-terra"],
    ["fastest", "gpt-5.6-luna"],
    ["5.5", "gpt-5.5"],
    ["5.5 Pro", "gpt-5.5-pro"],
  ])("resolves human model request %j to %s", (request, expected) => {
    expect(resolveModelOverride(request)).toBe(expected);
  });

  it("preserves future or provider-specific exact slugs for live catalog validation", () => {
    expect(resolveModelOverride("provider:model-next")).toBe("provider:model-next");
  });

  it("rejects unclear prose instead of guessing", () => {
    expect(() => resolveModelOverride("some newer model maybe"))
      .toThrow(/Unrecognized model description.*gpt-5\.6-sol.*gpt-5\.5-pro/);
  });

  it("distinguishes known Codex models from API-only models in stale-catalog diagnostics", () => {
    expect(knownModelAvailabilityNote("gpt-5.6-terra")).toMatch(/recognizes.*local Codex catalog does not expose/i);
    expect(knownModelAvailabilityNote("gpt-5.5-pro")).toMatch(/recognizes.*API model.*matching local Codex catalog/i);
  });
});
