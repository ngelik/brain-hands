import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

interface FileIdentity {
  dev: number;
  ino: number;
}

export interface OwnedEvidenceIdentity extends FileIdentity {
  parents: Array<FileIdentity & { path: string; realPath: string }>;
}

export interface OwnedFileIoHooks {
  beforeDescriptorOpen?: () => Promise<void>;
  afterDescriptorIo?: () => Promise<void>;
}

function inside(root: string, target: string): boolean {
  const relation = relative(root, target);
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertCanonicalRelativePath(path: string): string[] {
  if (path.includes("\\")) throw new Error(`Owned evidence path must use canonical forward-slash separators: ${path}`);
  if (path.length === 0 || isAbsolute(path) || /^[A-Za-z]:\//.test(path)) {
    throw new Error(`Owned evidence path must be relative: ${path}`);
  }
  const segments = path.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new Error(`Owned evidence path must be canonical and traversal-free: ${path}`);
  }
  return segments;
}

function missing(path: string): Error {
  return Object.assign(new Error(`Owned evidence artifact is missing: ${path}`), { code: "ENOENT" });
}

function ownedCoordinates(runDir: string, path: string, ownedRoot: string) {
  const segments = assertCanonicalRelativePath(path);
  const rootSegments = assertCanonicalRelativePath(ownedRoot.replace(/\/$/, ""));
  const canonicalOwnedRoot = `${rootSegments.join("/")}/`;
  if (!path.startsWith(canonicalOwnedRoot) || path === canonicalOwnedRoot) {
    throw new Error(`Owned evidence path is not confined to ${canonicalOwnedRoot}: ${path}`);
  }
  return { segments, rootSegments, canonicalOwnedRoot, runRoot: resolve(runDir) };
}

async function walkParents(
  canonicalRunRoot: string,
  segments: string[],
  path: string,
  create: boolean,
): Promise<OwnedEvidenceIdentity["parents"]> {
  const parents: OwnedEvidenceIdentity["parents"] = [];
  let current = canonicalRunRoot;
  for (const segment of segments.slice(0, -1)) {
    current = resolve(current, segment);
    let status = await lstat(current).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && create) return null;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw missing(path);
      throw error;
    });
    if (status === null) {
      await mkdir(current, { mode: 0o700 }).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      });
      status = await lstat(current);
    }
    if (status.isSymbolicLink()) throw new Error(`Owned evidence path must not contain a symlink: ${path}`);
    if (!status.isDirectory()) throw new Error(`Owned evidence parent must be a directory: ${path}`);
    const realCurrent = await realpath(current);
    if (!inside(canonicalRunRoot, realCurrent)) throw new Error(`Owned evidence parent escaped the run ledger: ${path}`);
    parents.push({ path: current, realPath: realCurrent, dev: status.dev, ino: status.ino });
  }
  return parents;
}

function assertSameParents(
  before: OwnedEvidenceIdentity["parents"],
  after: OwnedEvidenceIdentity["parents"],
  path: string,
): void {
  if (before.length !== after.length || before.some((entry, index) => {
    const next = after[index];
    return next === undefined || entry.path !== next.path || entry.realPath !== next.realPath || !sameIdentity(entry, next);
  })) throw new Error(`Owned evidence parent identity changed during access: ${path}`);
}

function assertExpectedIdentity(actual: OwnedEvidenceIdentity, expected: OwnedEvidenceIdentity | undefined, path: string): void {
  if (expected === undefined) return;
  if (!sameIdentity(actual, expected)) throw new Error(`Owned evidence target identity changed: ${path}`);
  assertSameParents(expected.parents, actual.parents, path);
}

async function rebindCanonicalTarget(input: {
  canonicalRunRoot: string;
  semanticRoot: string;
  target: string;
  segments: string[];
  path: string;
  opened: FileIdentity;
  parentsBefore: OwnedEvidenceIdentity["parents"];
  errorPrefix: "Owned evidence" | "Owned run";
}): Promise<OwnedEvidenceIdentity> {
  const parentsAfter = await walkParents(input.canonicalRunRoot, input.segments, input.path, false);
  assertSameParents(input.parentsBefore, parentsAfter, input.path);
  const pathname = await lstat(input.target);
  if (!pathname.isFile() || !sameIdentity(input.opened, pathname)) {
    throw new Error(`${input.errorPrefix} target identity changed during access: ${input.path}`);
  }
  const finalRealPath = await realpath(input.target);
  const semanticRealRoot = await realpath(input.semanticRoot);
  if (!inside(input.canonicalRunRoot, finalRealPath) || !inside(semanticRealRoot, finalRealPath)) {
    throw new Error(`${input.errorPrefix} target escaped its canonical root: ${input.path}`);
  }
  const confirmedParents = await walkParents(input.canonicalRunRoot, input.segments, input.path, false);
  assertSameParents(parentsAfter, confirmedParents, input.path);
  const confirmed = await lstat(input.target);
  if (!confirmed.isFile() || !sameIdentity(input.opened, confirmed)) {
    throw new Error(`${input.errorPrefix} target identity changed during access: ${input.path}`);
  }
  return { dev: input.opened.dev, ino: input.opened.ino, parents: confirmedParents };
}

/**
 * Create one engine-owned file without following symlinks and retain its inode identity.
 * This closes pathname swaps during our operation. It does not defend against a malicious
 * same-UID process coordinating rename and hard-link replacement outside this API.
 */
export async function writeOwnedEvidenceFile(
  runDir: string,
  path: string,
  ownedRoot: string,
  content: string | Buffer,
  hooks: OwnedFileIoHooks = {},
): Promise<OwnedEvidenceIdentity> {
  const coordinates = ownedCoordinates(runDir, path, ownedRoot);
  const canonicalRunRoot = await realpath(coordinates.runRoot);
  const semanticRoot = resolve(canonicalRunRoot, ...coordinates.rootSegments);
  const target = resolve(canonicalRunRoot, ...coordinates.segments);
  if (!inside(canonicalRunRoot, target) || !inside(semanticRoot, target)) {
    throw new Error(`Owned evidence path resolves outside ${coordinates.canonicalOwnedRoot}: ${path}`);
  }
  const parentsBefore = await walkParents(canonicalRunRoot, coordinates.segments, path, true);
  const semanticRealRoot = await realpath(semanticRoot);
  if (!inside(canonicalRunRoot, semanticRealRoot)) {
    throw new Error(`Owned evidence root escaped the run ledger: ${path}`);
  }
  const existing = await lstat(target).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (existing?.isSymbolicLink()) throw new Error(`Owned evidence target must not be a symlink: ${path}`);
  if (existing !== null) {
    const error = new Error(`Owned evidence artifact already exists: ${path}`) as NodeJS.ErrnoException;
    error.code = "EEXIST";
    throw error;
  }
  await hooks.beforeDescriptorOpen?.();
  const handle = await open(
    target,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    const descriptor = await handle.stat();
    if (!descriptor.isFile()) throw new Error(`Owned evidence target is not a regular file: ${path}`);
    const parentsAfter = await walkParents(canonicalRunRoot, coordinates.segments, path, false);
    assertSameParents(parentsBefore, parentsAfter, path);
    const pathname = await lstat(target);
    if (!pathname.isFile() || !sameIdentity(descriptor, pathname)) {
      throw new Error(`Owned evidence target identity changed during creation: ${path}`);
    }
    await handle.writeFile(content);
    await handle.sync();
    await hooks.afterDescriptorIo?.();
    return await rebindCanonicalTarget({
      canonicalRunRoot,
      semanticRoot,
      target,
      segments: coordinates.segments,
      path,
      opened: descriptor,
      parentsBefore: parentsAfter,
      errorPrefix: "Owned evidence",
    });
  } finally {
    await handle.close();
  }
}

/** Create one top-level or nested run-owned file without following symlinks. */
export async function writeOwnedRunFile(
  runDir: string,
  path: string,
  content: string | Buffer,
  hooks: OwnedFileIoHooks = {},
): Promise<OwnedEvidenceIdentity> {
  const segments = assertCanonicalRelativePath(path);
  const canonicalRunRoot = await realpath(resolve(runDir));
  const target = resolve(canonicalRunRoot, ...segments);
  if (!inside(canonicalRunRoot, target) || target === canonicalRunRoot) {
    throw new Error(`Owned run path resolves outside the run ledger: ${path}`);
  }
  const parentsBefore = await walkParents(canonicalRunRoot, segments, path, false);
  const existing = await lstat(target).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (existing?.isSymbolicLink()) throw new Error(`Owned run target must not be a symlink: ${path}`);
  if (existing !== null) {
    const error = new Error(`Owned run artifact already exists: ${path}`) as NodeJS.ErrnoException;
    error.code = "EEXIST";
    throw error;
  }
  await hooks.beforeDescriptorOpen?.();
  const handle = await open(
    target,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    const descriptor = await handle.stat();
    if (!descriptor.isFile()) throw new Error(`Owned run target is not a regular file: ${path}`);
    const parentsAfter = await walkParents(canonicalRunRoot, segments, path, false);
    assertSameParents(parentsBefore, parentsAfter, path);
    const pathname = await lstat(target);
    if (!pathname.isFile() || !sameIdentity(descriptor, pathname)) {
      throw new Error(`Owned run target identity changed during creation: ${path}`);
    }
    await handle.writeFile(content);
    await handle.sync();
    await hooks.afterDescriptorIo?.();
    const identity = await rebindCanonicalTarget({
      canonicalRunRoot,
      semanticRoot: canonicalRunRoot,
      target,
      segments,
      path,
      opened: descriptor,
      parentsBefore: parentsAfter,
      errorPrefix: "Owned run",
    });
    const parent = await open(dirname(target), constants.O_RDONLY);
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
    return identity;
  } finally {
    await handle.close();
  }
}

/** Read an exact engine-owned file and bind the descriptor to the revalidated path identity. */
export async function readOwnedEvidenceFile(
  runDir: string,
  path: string,
  ownedRoot: string,
  expectedIdentity?: OwnedEvidenceIdentity,
  hooks: OwnedFileIoHooks = {},
): Promise<Buffer> {
  const { segments, rootSegments, canonicalOwnedRoot } = ownedCoordinates(runDir, path, ownedRoot);
  const canonicalRunRoot = await realpath(resolve(runDir));
  const target = resolve(canonicalRunRoot, ...segments);
  const semanticRoot = resolve(canonicalRunRoot, ...rootSegments);
  if (!inside(canonicalRunRoot, target) || !inside(semanticRoot, target)) {
    throw new Error(`Owned evidence path resolves outside ${canonicalOwnedRoot}: ${path}`);
  }
  const parentsBefore = await walkParents(canonicalRunRoot, segments, path, false);
  const pathnameBefore = await lstat(target).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw missing(path);
    throw error;
  });
  if (pathnameBefore.isSymbolicLink()) throw new Error(`Owned evidence path must not contain a symlink: ${path}`);
  if (!pathnameBefore.isFile()) {
    throw new Error(`Owned evidence path must end in a regular file: ${path}`);
  }
  await hooks.beforeDescriptorOpen?.();
  const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const descriptor = await handle.stat();
    if (!descriptor.isFile()) throw new Error(`Owned evidence target is not a regular file: ${path}`);
    const parentsAfter = await walkParents(canonicalRunRoot, segments, path, false);
    assertSameParents(parentsBefore, parentsAfter, path);
    const pathnameAfter = await lstat(target);
    if (!pathnameAfter.isFile() || !sameIdentity(pathnameBefore, pathnameAfter) || !sameIdentity(descriptor, pathnameAfter)) {
      throw new Error(`Owned evidence target identity changed during read: ${path}`);
    }
    const finalRealPath = await realpath(target);
    const semanticRealRoot = await realpath(semanticRoot);
    if (!inside(canonicalRunRoot, finalRealPath) || !inside(semanticRealRoot, finalRealPath)) {
      throw new Error(`Owned evidence target resolves outside ${canonicalOwnedRoot}: ${path}`);
    }
    const bytes = await handle.readFile();
    await hooks.afterDescriptorIo?.();
    const actual = await rebindCanonicalTarget({
      canonicalRunRoot,
      semanticRoot,
      target,
      segments,
      path,
      opened: descriptor,
      parentsBefore: parentsAfter,
      errorPrefix: "Owned evidence",
    });
    assertExpectedIdentity(actual, expectedIdentity, path);
    return bytes;
  } finally {
    await handle.close();
  }
}

/** Read one exact run-ledger file with the same descriptor/path identity protections. */
export async function readOwnedRunFile(
  runDir: string,
  path: string,
  hooks: OwnedFileIoHooks = {},
): Promise<Buffer> {
  const segments = assertCanonicalRelativePath(path);
  const canonicalRunRoot = await realpath(resolve(runDir));
  const target = resolve(canonicalRunRoot, ...segments);
  if (!inside(canonicalRunRoot, target) || target === canonicalRunRoot) {
    throw new Error(`Owned run path resolves outside the run ledger: ${path}`);
  }
  const parentsBefore = await walkParents(canonicalRunRoot, segments, path, false);
  const pathnameBefore = await lstat(target).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw missing(path);
    throw error;
  });
  if (pathnameBefore.isSymbolicLink()) throw new Error(`Owned run path must not contain a symlink: ${path}`);
  if (!pathnameBefore.isFile()) {
    throw new Error(`Owned run path must end in a regular file: ${path}`);
  }
  await hooks.beforeDescriptorOpen?.();
  const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const descriptor = await handle.stat();
    const parentsAfter = await walkParents(canonicalRunRoot, segments, path, false);
    assertSameParents(parentsBefore, parentsAfter, path);
    const pathnameAfter = await lstat(target);
    if (!descriptor.isFile() || !pathnameAfter.isFile()
      || !sameIdentity(pathnameBefore, pathnameAfter) || !sameIdentity(descriptor, pathnameAfter)) {
      throw new Error(`Owned run target identity changed during read: ${path}`);
    }
    const bytes = await handle.readFile();
    await hooks.afterDescriptorIo?.();
    await rebindCanonicalTarget({
      canonicalRunRoot,
      semanticRoot: canonicalRunRoot,
      target,
      segments,
      path,
      opened: descriptor,
      parentsBefore: parentsAfter,
      errorPrefix: "Owned run",
    });
    return bytes;
  } finally {
    await handle.close();
  }
}

/** Append to one existing run-ledger file through a revalidated no-follow descriptor. */
export async function appendOwnedRunFile(
  runDir: string,
  path: string,
  content: string | Buffer,
  hooks: OwnedFileIoHooks = {},
): Promise<void> {
  const segments = assertCanonicalRelativePath(path);
  const canonicalRunRoot = await realpath(resolve(runDir));
  const target = resolve(canonicalRunRoot, ...segments);
  if (!inside(canonicalRunRoot, target) || target === canonicalRunRoot) {
    throw new Error(`Owned run path resolves outside the run ledger: ${path}`);
  }
  const parentsBefore = await walkParents(canonicalRunRoot, segments, path, false);
  const pathnameBefore = await lstat(target).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw missing(path);
    throw error;
  });
  if (pathnameBefore.isSymbolicLink()) throw new Error(`Owned run path must not contain a symlink: ${path}`);
  if (!pathnameBefore.isFile()) throw new Error(`Owned run path must end in a regular file: ${path}`);
  await hooks.beforeDescriptorOpen?.();
  const handle = await open(target, constants.O_WRONLY | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0));
  try {
    const descriptor = await handle.stat();
    const parentsAfter = await walkParents(canonicalRunRoot, segments, path, false);
    assertSameParents(parentsBefore, parentsAfter, path);
    const pathnameAfter = await lstat(target);
    if (!descriptor.isFile() || !pathnameAfter.isFile()
      || !sameIdentity(pathnameBefore, pathnameAfter) || !sameIdentity(descriptor, pathnameAfter)) {
      throw new Error(`Owned run target identity changed during append: ${path}`);
    }
    await handle.writeFile(content);
    await handle.sync();
    await hooks.afterDescriptorIo?.();
    await rebindCanonicalTarget({
      canonicalRunRoot,
      semanticRoot: canonicalRunRoot,
      target,
      segments,
      path,
      opened: descriptor,
      parentsBefore: parentsAfter,
      errorPrefix: "Owned run",
    });
  } finally {
    await handle.close();
  }
}
