#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseStableVersion } from "../.agents/skills/brain-hands/scripts/version-compatibility.mjs";

function atLeast(actual, minimum) {
  if (actual.major !== minimum.major) return actual.major > minimum.major;
  if (actual.minor !== minimum.minor) return actual.minor > minimum.minor;
  return actual.patch >= minimum.patch;
}

export function validateReleaseToolchain({ nodeVersion, npmVersion }) {
  const node = parseStableVersion(nodeVersion, "Node.js version");
  const npm = parseStableVersion(npmVersion, "npm version");
  if (!atLeast(node, { major: 22, minor: 14, patch: 0 })) {
    throw new Error(`Trusted publishing requires Node.js 22.14.0 or newer; found ${nodeVersion}`);
  }
  if (!atLeast(npm, { major: 11, minor: 5, patch: 1 })) {
    throw new Error(`Trusted publishing requires npm 11.5.1 or newer; found ${npmVersion}`);
  }
  return { nodeVersion, npmVersion };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    const result = spawnSync("npm", ["--version"], { encoding: "utf8" });
    if (result.error || result.status !== 0) {
      throw new Error(`Unable to determine npm version: ${result.error?.message ?? result.stderr.trim()}`);
    }
    const npmVersion = result.stdout.trim();
    const accepted = validateReleaseToolchain({ nodeVersion: process.versions.node, npmVersion });
    console.log(`Release toolchain valid: Node.js ${accepted.nodeVersion}, npm ${accepted.npmVersion}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
