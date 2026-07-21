import { describe, expect, it } from "vitest";
import { matchesExpectedNetwork, missingExpectedNetwork } from "../../src/browser/network-pattern.js";

describe("browser network patterns", () => {
  it("matches approved recursive URL patterns to concrete observed requests", () => {
    const observed = [
      "http://127.0.0.1:4173/",
      "http://127.0.0.1:4173/assets/index.js",
      "http://127.0.0.1:4173/textures/planets/earth.webp",
    ];

    expect(missingExpectedNetwork([
      "http://127.0.0.1:4173/",
      "http://127.0.0.1:4173/assets/**",
      "http://127.0.0.1:4173/textures/**",
    ], observed)).toEqual([]);
  });

  it("keeps a single wildcard inside one path segment", () => {
    expect(matchesExpectedNetwork("https://example.test/assets/*.js", "https://example.test/assets/app.js")).toBe(true);
    expect(matchesExpectedNetwork("https://example.test/assets/*.js", "https://example.test/assets/chunks/app.js")).toBe(false);
  });
});
