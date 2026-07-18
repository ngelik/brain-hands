import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];
const skippableFilesystemErrorCodes = new Set(["EACCES", "EPERM", "ENOTSUP", "EOPNOTSUPP"]);

function isSkippableFilesystemError(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error
    && skippableFilesystemErrorCodes.has(String(error.code));
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "brain-hands-dist-artifact-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function loadArtifactModule() {
  const modulePath = "../../scripts/dist-artifact.mjs";
  return import(modulePath);
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe("dist artifact hashing", () => {
  it("returns the same digest regardless of creation order", async () => {
    const first = await temporaryDirectory();
    const second = await temporaryDirectory();

    await mkdir(join(first, "nested"));
    await writeFile(join(first, "nested", "b.txt"), "bravo");
    await writeFile(join(first, "a.txt"), "alpha");

    await writeFile(join(second, "a.txt"), "alpha");
    await mkdir(join(second, "nested"));
    await writeFile(join(second, "nested", "b.txt"), "bravo");

    const { hashDirectory } = await loadArtifactModule();
    await expect(hashDirectory(first)).resolves.toBe(await hashDirectory(second));
  });

  it("changes when file bytes change", async () => {
    const root = await temporaryDirectory();
    const file = join(root, "cli.js");
    await writeFile(file, "first");

    const { hashDirectory } = await loadArtifactModule();
    const before = await hashDirectory(root);
    await writeFile(file, "second");

    await expect(hashDirectory(root)).resolves.not.toBe(before);
  });

  it("changes when a path is renamed", async () => {
    const first = await temporaryDirectory();
    const second = await temporaryDirectory();
    await writeFile(join(first, "before.js"), "same bytes");
    await writeFile(join(second, "after.js"), "same bytes");

    const { hashDirectory } = await loadArtifactModule();
    await expect(hashDirectory(first)).resolves.not.toBe(await hashDirectory(second));
  });

  it("distinguishes literal backslashes from path separators on POSIX", async (context) => {
    if (process.platform === "win32") {
      context.skip();
      return;
    }

    const literalBackslash = await temporaryDirectory();
    const nestedPath = await temporaryDirectory();
    await mkdir(join(literalBackslash, "x"));
    try {
      await writeFile(join(literalBackslash, "x\\y"), "same bytes");
    } catch (error) {
      if (isSkippableFilesystemError(error)) {
        context.skip();
        return;
      }
      throw error;
    }
    await mkdir(join(nestedPath, "x"));
    await writeFile(join(nestedPath, "x", "y"), "same bytes");

    const { hashDirectory } = await loadArtifactModule();
    await expect(hashDirectory(literalBackslash)).resolves.not.toBe(
      await hashDirectory(nestedPath),
    );
  });

  it("includes empty directories", async () => {
    const withoutEmptyDirectory = await temporaryDirectory();
    const withEmptyDirectory = await temporaryDirectory();
    await mkdir(join(withEmptyDirectory, "empty"));

    const { hashDirectory } = await loadArtifactModule();
    await expect(hashDirectory(withEmptyDirectory)).resolves.not.toBe(
      await hashDirectory(withoutEmptyDirectory),
    );
  });

  it("rejects symlinks", async (context) => {
    const root = await temporaryDirectory();
    await writeFile(join(root, "target.txt"), "target");
    try {
      await symlink("target.txt", join(root, "link.txt"));
    } catch (error) {
      if (isSkippableFilesystemError(error)) {
        context.skip();
        return;
      }
      throw error;
    }

    const { hashDirectory } = await loadArtifactModule();
    await expect(hashDirectory(root)).rejects.toThrow(/symlink/i);
  });

  it("rejects a missing artifact root", async () => {
    const parent = await temporaryDirectory();
    const { hashDirectory } = await loadArtifactModule();

    await expect(hashDirectory(join(parent, "missing"))).rejects.toThrow();
  });
});
