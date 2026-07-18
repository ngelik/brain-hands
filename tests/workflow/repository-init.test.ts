import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { initializeRepository } from "../../src/workflow/repository-init.js";
import { configPath } from "../../src/core/config.js";

const execFileAsync = promisify(execFile);
let repoRoot: string | null = null;

afterEach(async () => {
  if (repoRoot) await rm(repoRoot, { recursive: true, force: true });
  repoRoot = null;
});

async function gitRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "brain-hands-init-"));
  await execFileAsync("git", ["init", "-q", root]);
  return root;
}

describe("initializeRepository", () => {
  it("creates then validates local config without GitHub", async () => {
    repoRoot = await gitRepo();
    expect((await initializeRepository({ repoRoot, github: false, dryRun: false, force: false })).config.action).toBe("created");
    expect((await initializeRepository({ repoRoot, github: false, dryRun: false, force: false })).config.action).toBe("validated");
  });

  it("does not create config during dry-run", async () => {
    repoRoot = await gitRepo();
    const result = await initializeRepository({ repoRoot, github: false, dryRun: true, force: false });
    expect(result.config.action).toBe("would_create");
    await expect(access(join(repoRoot, ".brain-hands", "config.yaml"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not migrate an existing v1 config while inspecting or validating initialization", async () => {
    repoRoot = await gitRepo();
    const legacy = await readFile(join(process.cwd(), "docs", "example-config.yaml"), "utf8");
    const path = configPath(repoRoot);
    await mkdir(join(repoRoot, ".brain-hands"), { recursive: true });
    await writeFile(path, legacy, "utf8");

    expect((await initializeRepository({ repoRoot, github: false, dryRun: true, force: false })).config.action).toBe("validated");
    expect((await initializeRepository({ repoRoot, github: false, dryRun: false, force: false })).config.action).toBe("validated");
    expect(await readFile(path, "utf8")).toBe(legacy);
    await expect(access(`${path}.v1.bak`)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
