import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "brain-hands-clean-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function loadCleanModule() {
  const modulePath = "../../scripts/clean.mjs";
  return import(modulePath);
}

async function loadArtifactModule() {
  const modulePath = "../../scripts/dist-artifact.mjs";
  return import(modulePath);
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe("guarded dist cleaning", () => {
  it("removes dist when it is mutable", async () => {
    const cwd = await temporaryDirectory();
    const dist = join(cwd, "dist");
    await mkdir(dist);
    await writeFile(join(dist, "cli.js"), "artifact");

    const { cleanDist } = await loadCleanModule();
    const { IMMUTABLE_DIST_ENV } = await loadArtifactModule();
    await cleanDist({ cwd, env: { [IMMUTABLE_DIST_ENV]: "true" } });

    await expect(access(dist)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("is idempotent when dist is absent", async () => {
    const cwd = await temporaryDirectory();
    const { cleanDist } = await loadCleanModule();

    await expect(cleanDist({ cwd, env: {} })).resolves.toBeUndefined();
    await expect(cleanDist({ cwd, env: {} })).resolves.toBeUndefined();
  });

  it("refuses to remove dist when the immutable flag is 1", async () => {
    const cwd = await temporaryDirectory();
    const dist = join(cwd, "dist");
    const artifact = join(dist, "cli.js");
    await mkdir(dist);
    await writeFile(artifact, "artifact");

    const { cleanDist } = await loadCleanModule();
    const { IMMUTABLE_DIST_ENV } = await loadArtifactModule();
    const error = await cleanDist({ cwd, env: { [IMMUTABLE_DIST_ENV]: "1" } }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("BRAIN_HANDS_DIST_IMMUTABLE=1");
    expect((error as Error).message).toContain(dist);
    await expect(readFile(artifact, "utf8")).resolves.toBe("artifact");
  });
});
