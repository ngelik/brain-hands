#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseStableVersion } from "../.agents/skills/brain-hands/scripts/version-compatibility.mjs";

const scriptRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const skillPath = ".agents/skills/brain-hands/SKILL.md";

function formatVersion(version) {
  return `${version.major}.${version.minor}.${version.patch}`;
}

export function parseCanonicalVersion(value) {
  const version = formatVersion(parseStableVersion(value, "release version"));
  return { version, tag: `v${version}` };
}

function parseJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function readReleaseVersions(root = scriptRoot) {
  const packageJson = parseJson(resolve(root, "package.json"));
  const packageLock = parseJson(resolve(root, "package-lock.json"));
  const plugin = parseJson(resolve(root, ".codex-plugin/plugin.json"));
  const skill = readFileSync(resolve(root, skillPath), "utf8");
  const matches = [...skill.matchAll(/^\s+codex_flow:\s*["']?([^"'\s]+)["']?\s*$/gmu)];
  if (matches.length !== 1) {
    throw new Error("SKILL.md must contain exactly one requires.codex_flow entry");
  }
  if (!packageLock.packages?.[""]) {
    throw new Error('package-lock.json is missing packages[""]');
  }
  return {
    packageVersion: packageJson.version,
    lockfileVersion: packageLock.version,
    lockfilePackageVersion: packageLock.packages[""].version,
    pluginVersion: plugin.version,
    requiredRange: matches[0][1],
  };
}

export function synchronizeReleaseVersion(root, value) {
  const { version } = parseCanonicalVersion(value);
  const paths = {
    packageJson: resolve(root, "package.json"),
    packageLock: resolve(root, "package-lock.json"),
    plugin: resolve(root, ".codex-plugin/plugin.json"),
    skill: resolve(root, skillPath),
  };
  const packageJson = parseJson(paths.packageJson);
  const packageLock = parseJson(paths.packageLock);
  const plugin = parseJson(paths.plugin);
  const skill = readFileSync(paths.skill, "utf8");
  if (!packageLock.packages?.[""]) {
    throw new Error('package-lock.json is missing packages[""]');
  }
  const matches = [...skill.matchAll(/^\s+codex_flow:\s*["']?([^"'\s]+)["']?\s*$/gmu)];
  if (matches.length !== 1) {
    throw new Error("SKILL.md must contain exactly one requires.codex_flow entry");
  }

  packageJson.version = version;
  packageLock.version = version;
  packageLock.packages[""].version = version;
  plugin.version = version;
  const nextSkill = skill.replace(
    /^(\s+codex_flow:\s*)["']?([^"'\s]+)["']?(\s*)$/mu,
    `$1"^${version}"$3`,
  );

  writeFileSync(paths.packageJson, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
  writeFileSync(paths.packageLock, `${JSON.stringify(packageLock, null, 2)}\n`, "utf8");
  writeFileSync(paths.plugin, `${JSON.stringify(plugin, null, 2)}\n`, "utf8");
  writeFileSync(paths.skill, nextSkill, "utf8");
  return readReleaseVersions(root);
}

function usage() {
  return "Usage: node scripts/release-version.mjs sync MAJOR.MINOR.PATCH [--root PATH]";
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    const args = process.argv.slice(2);
    const rootIndex = args.indexOf("--root");
    const root = rootIndex >= 0 ? args[rootIndex + 1] : scriptRoot;
    const positional = args.filter((_, index) => index !== rootIndex && index !== rootIndex + 1);
    if (!root || positional.length !== 2 || positional[0] !== "sync") throw new Error(usage());
    synchronizeReleaseVersion(resolve(root), positional[1]);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
