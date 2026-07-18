import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

export const IMMUTABLE_DIST_ENV = "BRAIN_HANDS_DIST_IMMUTABLE";

export function assertDistMutable(env = process.env) {
  if (env[IMMUTABLE_DIST_ENV] === "1") {
    throw new Error(`${IMMUTABLE_DIST_ENV}=1 protects the built dist artifact`);
  }
}

function updateFramed(hash, value) {
  const bytes = Buffer.from(value, "utf8");
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(bytes.length));
  hash.update(length);
  hash.update(bytes);
}

async function collectEntries(root, parentComponents, entries) {
  const directory = join(root, ...parentComponents);
  for (const name of await readdir(directory)) {
    const components = [...parentComponents, name];
    const normalizedPath = components.join("/");
    const path = join(root, ...components);
    const stats = await lstat(path);

    if (stats.isSymbolicLink()) {
      throw new Error(`Symlinks are not supported in dist artifacts: ${normalizedPath}`);
    }
    if (stats.isDirectory()) {
      entries.push({ relativePath: normalizedPath, kind: "directory", bytes: Buffer.alloc(0) });
      await collectEntries(root, components, entries);
      continue;
    }
    if (stats.isFile()) {
      entries.push({ relativePath: normalizedPath, kind: "file", bytes: await readFile(path) });
      continue;
    }
    throw new Error(`Unsupported entry kind in dist artifact: ${normalizedPath}`);
  }
}

export async function hashDirectory(root) {
  const rootStats = await lstat(root);
  if (rootStats.isSymbolicLink()) {
    throw new Error(`Symlinks are not supported as dist artifact roots: ${root}`);
  }
  if (!rootStats.isDirectory()) {
    throw new Error(`Dist artifact root is not a directory: ${root}`);
  }

  const entries = [];
  await collectEntries(root, [], entries);
  entries.sort((left, right) => Buffer.compare(
    Buffer.from(left.relativePath, "utf8"),
    Buffer.from(right.relativePath, "utf8"),
  ));

  const hash = createHash("sha256");
  hash.update("brain-hands-dist-v1\0");
  for (const entry of entries) {
    updateFramed(hash, entry.relativePath);
    updateFramed(hash, entry.kind);
    updateFramed(hash, String(entry.bytes.length));
    hash.update(entry.bytes);
  }
  return hash.digest("hex");
}
