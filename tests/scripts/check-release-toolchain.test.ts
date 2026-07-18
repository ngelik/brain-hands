import { describe, expect, it } from "vitest";

describe("release toolchain validation", () => {
  it("accepts the exact minimum versions", async () => {
    const { validateReleaseToolchain } = await import("../../scripts/check-release-toolchain.mjs");
    expect(validateReleaseToolchain({
      nodeVersion: "22.14.0",
      npmVersion: "11.5.1",
    })).toEqual({ nodeVersion: "22.14.0", npmVersion: "11.5.1" });
  });

  it("rejects Node.js below the trusted publishing floor", async () => {
    const { validateReleaseToolchain } = await import("../../scripts/check-release-toolchain.mjs");
    expect(() => validateReleaseToolchain({
      nodeVersion: "22.13.9",
      npmVersion: "11.5.1",
    })).toThrow("Node.js 22.14.0 or newer");
  });

  it("rejects npm below the trusted publishing floor", async () => {
    const { validateReleaseToolchain } = await import("../../scripts/check-release-toolchain.mjs");
    expect(() => validateReleaseToolchain({
      nodeVersion: "24.0.0",
      npmVersion: "11.5.0",
    })).toThrow("npm 11.5.1 or newer");
  });

  it("rejects malformed tool versions", async () => {
    const { validateReleaseToolchain } = await import("../../scripts/check-release-toolchain.mjs");
    expect(() => validateReleaseToolchain({
      nodeVersion: "v24",
      npmVersion: "latest",
    })).toThrow("canonical stable semantic version");
  });
});
