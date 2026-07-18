import { describe, expect, it } from "vitest";
import { loadPromptTemplate } from "../../src/prompts/loader.js";
import { renderTemplate } from "../../src/prompts/renderer.js";

describe("renderTemplate", () => {
  it("replaces all declared variables", () => {
    const rendered = renderTemplate("Review {{issue}} in {{repo}}.", {
      issue: "#123",
      repo: "/tmp/repo",
    });

    expect(rendered).toBe("Review #123 in /tmp/repo.");
  });

  it("throws when a variable is missing", () => {
    expect(() =>
      renderTemplate("Review {{issue}}.", {})
    ).toThrow("Missing template variable: issue");
  });

  it("loads and renders the Hands self-review template", async () => {
    const template = await loadPromptTemplate("hands-self-review-v2");
    const variables = Object.fromEntries(
      [...template.matchAll(/\{\{([a-zA-Z0-9_]+)\}\}/g)].map((match) => [match[1], "fixture"]),
    );

    expect(renderTemplate(template, variables)).toContain("independent self-review");
  });

  it("loads and renders the bounded Brain replan patch template", async () => {
    const template = await loadPromptTemplate("brain-replan-patch-v2");
    const variables = Object.fromEntries(
      [...template.matchAll(/\{\{([a-zA-Z0-9_]+)\}\}/g)].map((match) => [match[1], "fixture"]),
    );

    expect(renderTemplate(template, variables)).toContain("narrow replan patch");
  });

  it("loads and renders the adaptive Brain discovery template", async () => {
    const template = await loadPromptTemplate("brain-discovery-v1");
    const variables = Object.fromEntries(
      [...template.matchAll(/\{\{([a-zA-Z0-9_]+)\}\}/g)].map((match) => [match[1], "fixture"]),
    );

    const rendered = renderTemplate(template, variables);
    expect(rendered).toContain("exactly one strict discovery outcome");
    expect(rendered).toContain("Never request credentials");
  });
});
