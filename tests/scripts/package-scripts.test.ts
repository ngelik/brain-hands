import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

type PackageJson = {
  scripts: Record<string, string | undefined>;
};

const requiredScripts = {
  test: "npm run verify:funnel",
  "test:static-contract": "vitest run tests/core/schema.test.ts tests/core/execution-spec.test.ts tests/core/testing-funnel.test.ts tests/prompts/renderer.test.ts tests/workflow/replan.test.ts",
  "test:cross-cutting": "vitest run tests/workflow/runtime-local.test.ts tests/workflow/runtime-github.test.ts tests/workflow/preflight.test.ts tests/workflow/status.test.ts tests/core/ledger.test.ts tests/core/discovery-ledger.test.ts tests/core/run-configuration.test.ts tests/core/controller-provenance.test.ts tests/verification/runner.test.ts",
  "test:built-cli": "vitest run tests/workflow/e2e-dry-run.test.ts tests/workflow/canonical-session-built-cli.test.ts",
  "test:all:no-build": "vitest run",
  "verify:funnel": "node scripts/verify-repository.mjs",
  "verify:focused": "node scripts/verify-repository.mjs --focused",
} as const;

async function loadPackageJson(): Promise<PackageJson> {
  return JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8")) as PackageJson;
}

describe("package verification scripts", () => {
  it("delegates test only to the verification funnel", async () => {
    const { scripts } = await loadPackageJson();

    expect(scripts.test).toBe(requiredScripts.test);
    expect(scripts["verify:funnel"]).toBe(requiredScripts["verify:funnel"]);
    expect(scripts["verify:focused"]).toBe(requiredScripts["verify:focused"]);
  });

  it("defines the exact non-overlapping verification layers", async () => {
    const { scripts } = await loadPackageJson();

    expect(scripts["test:static-contract"]).toBe(requiredScripts["test:static-contract"]);
    expect(scripts["test:cross-cutting"]).toBe(requiredScripts["test:cross-cutting"]);
    expect(scripts["test:built-cli"]).toBe(requiredScripts["test:built-cli"]);
    expect(scripts["test:all:no-build"]).toBe(requiredScripts["test:all:no-build"]);
  });

  it("keeps every test layer and coordinator free of lifecycle hooks", async () => {
    const { scripts } = await loadPackageJson();

    const funnelScripts = [
      "test",
      "verify:funnel",
      "verify:focused",
      "test:static-contract",
      "test:cross-cutting",
      "test:built-cli",
      "test:all:no-build",
    ];

    expect(scripts.clean).toBe("node scripts/clean.mjs");
    for (const script of funnelScripts) {
      expect(scripts[`pre${script}`]).toBeUndefined();
      expect(scripts[`post${script}`]).toBeUndefined();
    }
    expect(scripts["pretest:built-cli"]).toBeUndefined();
    expect(scripts["posttest:all:no-build"]).toBeUndefined();
    expect(scripts["test:all:no-build"]).toBe(requiredScripts["test:all:no-build"]);
    expect(scripts["test:all:no-build"]).not.toMatch(/\b(?:build|clean|pretest|posttest)\b/);
  });
});
