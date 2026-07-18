#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  parseStableVersion,
  requiredCodexFlowRange,
  satisfiesCaretRange,
} from "../.agents/skills/brain-hands/scripts/version-compatibility.mjs";

const scriptRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function toVersionText(version) {
  return `${version.major}.${version.minor}.${version.patch}`;
}

export const expectedPackageName = "@ngelik/brain-hands";
export const expectedRepository = "github.com/ngelik/brain-hands";
export const expectedGithubRepository = "ngelik/brain-hands";

export function normalizeRepository(value) {
  if (typeof value !== "string") return "";

  let text = value.trim().replace(/^git\+/, "");
  if (/(?:^|[\\/])\.\.?(?:[\\/]|$)/u.test(text)) return "";
  let host;
  let repositoryPath;
  if (/^git@[^:]+:.+/u.test(text)) {
    const separator = text.indexOf(":");
    host = text.slice(4, separator);
    repositoryPath = text.slice(separator + 1);
  } else if (/^github:[^/]+\/.+/u.test(text)) {
    host = "github.com";
    repositoryPath = text.slice("github:".length);
  } else if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(text)) {
    let url;
    try {
      url = new URL(text);
    } catch {
      return "";
    }
    if (!["http:", "https:", "ssh:", "git:"].includes(url.protocol)) return "";
    if (url.search || url.hash || url.port || (url.username && url.username !== "git") || url.password) return "";
    host = url.hostname;
    repositoryPath = url.pathname.slice(1);
  } else {
    const shorthand = text.match(/^((?:github\.com\/)?[^/]+\/[^/]+)$/iu);
    if (!shorthand) return "";
    host = "github.com";
    repositoryPath = shorthand[1].replace(/^github\.com\//iu, "");
  }

  repositoryPath = repositoryPath.replace(/\/+$/u, "");
  if (repositoryPath.endsWith(".git")) repositoryPath = repositoryPath.slice(0, -4);
  if (repositoryPath.includes("..") || repositoryPath.includes("\\") || repositoryPath.includes("%")) return "";
  const normalized = `${String(host).toLowerCase()}/${repositoryPath.toLowerCase()}`;
  return normalized === expectedRepository ? expectedRepository : "";
}

export function validatePackageIdentity(packageJson) {
  if (!packageJson || typeof packageJson !== "object" || Array.isArray(packageJson)) {
    throw new Error("package.json must contain an object");
  }
  if (packageJson.name !== expectedPackageName) {
    throw new Error(`package.json name must be exactly ${expectedPackageName}`);
  }
  const repositoryMetadata = packageJson.repository;
  const repositoryValue = typeof repositoryMetadata === "string"
    ? repositoryMetadata
    : repositoryMetadata && typeof repositoryMetadata === "object" && !Array.isArray(repositoryMetadata)
      ? repositoryMetadata.url
      : "";
  if (normalizeRepository(repositoryValue) !== expectedRepository) {
    throw new Error(`package.json repository must normalize exactly to ${expectedRepository}`);
  }
}

function parseCliVersionOutput(stdout, label = "CLI version") {
  let value = String(stdout);
  value = value.replace(/\r?\n$/, "");
  if (value.includes("\n") || value.includes("\r")) {
    throw new Error(`${label} must contain exactly one version line`);
  }
  parseStableVersion(value, label);
  return value;
}

function runCli(root, packageVersion) {
  const distCli = join(root, "dist", "cli.js");
  if (!existsSync(distCli)) throw new Error(`Built CLI is missing at ${distCli}; run npm run build before release validation`);
  const result = spawnSync(process.execPath, [distCli, "--version"], { cwd: root, encoding: "utf8" });
  if (result.error || result.status !== 0) {
    const diagnostic = result.error?.message ?? (result.stderr.trim() || `exit ${result.status}`);
    throw new Error(`CLI --version failed: ${diagnostic}`);
  }
  const version = parseCliVersionOutput(result.stdout);
  if (version !== packageVersion) throw new Error(`CLI version ${version} does not match package.json version ${packageVersion}`);
  return version;
}

function readLockfileVersions(lockfilePath) {
  const lockfile = readJson(lockfilePath);
  const rootVersion = toVersionText(parseStableVersion(lockfile.version, "package-lock.json root version"));
  const packagesRoot = lockfile.packages?.[""];
  if (!packagesRoot || typeof packagesRoot.version !== "string") {
    throw new Error("package-lock.json is missing packages[\"\"].version");
  }
  const packageEntryVersion = toVersionText(
    parseStableVersion(packagesRoot.version, "package-lock.json packages[\"\"].version"),
  );
  return {
    rootVersion,
    packageEntryVersion,
  };
}

export function validateRelease(root = scriptRoot) {
  const packageJson = readJson(join(root, "package.json"));
  validatePackageIdentity(packageJson);
  const packageVersion = toVersionText(
    parseStableVersion(packageJson.version, "package.json version"),
  );

  const lockfileVersions = readLockfileVersions(join(root, "package-lock.json"));
  if (lockfileVersions.rootVersion !== packageVersion) {
    throw new Error(`package-lock.json root version ${lockfileVersions.rootVersion} does not match package.json version ${packageVersion}`);
  }
  if (lockfileVersions.packageEntryVersion !== packageVersion) {
    throw new Error(`package-lock.json packages[\"\"].version ${lockfileVersions.packageEntryVersion} does not match package.json version ${packageVersion}`);
  }

  const pluginVersion = toVersionText(
    parseStableVersion(
      readJson(join(root, ".codex-plugin", "plugin.json")).version,
      ".codex-plugin/plugin.json version",
    ),
  );
  if (pluginVersion !== packageVersion) {
    throw new Error(`plugin.json version ${pluginVersion} does not match package.json version ${packageVersion}`);
  }

  const requiredRange = requiredCodexFlowRange(readFileSync(join(root, ".agents", "skills", "brain-hands", "SKILL.md"), "utf8"));
  if (requiredRange !== `^${packageVersion}` || !satisfiesCaretRange(packageVersion, requiredRange)) {
    throw new Error(`SKILL.md requires.codex_flow must be ^${packageVersion}; found ${requiredRange}`);
  }

  const cliVersion = runCli(root, packageVersion);
  return { packageVersion, pluginVersion, cliVersion, requiredRange };
}

export function validatePublishContext({ tag, repository }, root = scriptRoot) {
  const result = validateRelease(root);
  if (repository !== expectedGithubRepository) {
    throw new Error(`GitHub repository must be exactly ${expectedGithubRepository}`);
  }
  const expectedTag = `v${result.packageVersion}`;
  if (tag !== expectedTag) {
    if (!/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(String(tag))) {
      throw new Error(`tag must be exactly ${expectedTag}`);
    }
    throw new Error(`tag ${tag} does not match package version ${result.packageVersion}`);
  }
  return { ...result, tag, repository };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const showJson = process.argv.includes("--json");
  try {
    const rootIndex = process.argv.indexOf("--root");
    const tagIndex = process.argv.indexOf("--tag");
    const repositoryIndex = process.argv.indexOf("--repository");
    const root = rootIndex >= 0 ? process.argv[rootIndex + 1] : undefined;
    const tag = tagIndex >= 0 ? process.argv[tagIndex + 1] : undefined;
    const repository = repositoryIndex >= 0 ? process.argv[repositoryIndex + 1] : undefined;
    if (rootIndex >= 0 && !root) throw new Error("--root requires a repository path");
    if ((tag === undefined) !== (repository === undefined)) {
      throw new Error("--tag and --repository must be provided together");
    }
    const validationRoot = root ? resolve(root) : undefined;
    const result = tag === undefined
      ? validateRelease(validationRoot)
      : validatePublishContext({ tag, repository }, validationRoot);
    if (showJson) {
      console.log(JSON.stringify(result));
    } else {
      console.log(`Release contract valid: ${result.packageVersion}`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
