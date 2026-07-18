import { describe, expect, it } from "vitest";
import { validateCatalogProfile } from "../../src/adapters/model-catalog.js";

const catalog = {
  models: [{
    slug: "backup-model",
    display_name: "Backup Model",
    supported_reasoning_levels: [
      { effort: "low", description: "Fast" },
      { effort: "medium", description: "Balanced" },
    ],
    visibility: "list",
  }],
};

describe("validateCatalogProfile", () => {
  it("accepts an exact slug and reasoning effort", () => {
    expect(validateCatalogProfile(catalog, {
      model: "backup-model",
      reasoning_effort: "medium",
    }, "Hands backup")).toMatchObject({
      slug: "backup-model",
      reasoning_effort: "medium",
    });
  });

  it("rejects a missing slug without substitution", () => {
    expect(() => validateCatalogProfile(catalog, {
      model: "nearby-model",
      reasoning_effort: "medium",
    }, "Hands backup")).toThrow("Hands backup model nearby-model is absent");
  });

  it("rejects an unsupported reasoning effort without downgrade", () => {
    expect(() => validateCatalogProfile(catalog, {
      model: "backup-model",
      reasoning_effort: "high",
    }, "Hands backup")).toThrow("does not support reasoning effort high");
  });
});
