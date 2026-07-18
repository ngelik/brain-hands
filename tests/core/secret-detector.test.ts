import { describe, expect, it } from "vitest";
import { assertNoSecretMaterial, detectSecretMaterial } from "../../src/core/secret-detector.js";

describe("detectSecretMaterial", () => {
  it("uses the caller's phase-neutral label", () => {
    expect(() => assertNoSecretMaterial("Discovery answer", "password=correct-horse-battery-staple"))
      .toThrow("Discovery answer contains secret material");
  });

  it.each([
    "password=correct-horse-battery-staple",
    "token: abcdefghijklmnopqrstuvwxyz",
    "Authorization: Bearer abcdefghijklmnop",
    "Authorization: Basic dXNlcjpwYXNzd29yZA==",
    "sk-proj-abcdefghijklmnopqrstuvwxyz012345",
    "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    "github_pat_abcdefghijklmnopqrstuvwxyz0123456789",
    "AKIAIOSFODNN7EXAMPLE",
    "-----BEGIN PRIVATE KEY-----",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnopqrstuvwxyz0123456789",
    ".env.production",
    "config/credentials.json",
    JSON.stringify({ path: ".env.production" }),
  ])("detects secret material: %s", (value) => {
    expect(detectSecretMaterial(value)).not.toBeNull();
  });

  it.each([
    "Password authentication is disabled.",
    "The token budget is 100.",
    "Use process.env.API_TOKEN without copying its value.",
    "The sketch-project module is unchanged.",
    "https://github.com/example/repo",
    "AKIAX is not an access key.",
    "docs/environment-variables.md",
  ])("does not flag benign text: %s", (value) => {
    expect(detectSecretMaterial(value)).toBeNull();
  });
});
