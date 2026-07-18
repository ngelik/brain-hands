#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  expectedPackageName,
  validatePublishContext,
} from "./validate-release.mjs";

const scriptRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const defaultDelaysMs = [0, 2_000, 5_000, 10_000, 20_000, 30_000];

function defaultRunCommand(command, args, { cwd }) {
  return new Promise((resolveCommand) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      resolveCommand({ status: 1, stdout, stderr: error.message });
    });
    child.on("close", (status) => {
      resolveCommand({ status: status ?? 1, stdout, stderr });
    });
  });
}

function defaultSleep(delay) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, delay));
}

function parseJson(stdout, label) {
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
}

function commandFailure(label, result) {
  const diagnostic = result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`;
  return new Error(`${label} failed: ${diagnostic}`);
}

function parsePackResult(result, version) {
  if (result.status !== 0) throw commandFailure("npm pack", result);
  const entries = parseJson(result.stdout, "npm pack");
  if (!Array.isArray(entries) || entries.length !== 1) {
    throw new Error("npm pack must produce exactly one artifact");
  }
  const artifact = entries[0];
  if (artifact?.name !== expectedPackageName || artifact?.version !== version) {
    throw new Error(`npm pack artifact must be exactly ${expectedPackageName}@${version}`);
  }
  if (typeof artifact.filename !== "string" || basename(artifact.filename) !== artifact.filename) {
    throw new Error("npm pack returned an unsafe artifact filename");
  }
  if (typeof artifact.integrity !== "string" || !artifact.integrity.startsWith("sha512-")) {
    throw new Error("npm pack did not return a sha512 integrity value");
  }
  return artifact;
}

function registryState(result, version) {
  if (result.status !== 0) {
    const diagnostic = `${result.stderr}\n${result.stdout}`;
    if (/\bE404\b|\b404\s+Not\s+Found\b/iu.test(diagnostic)) return { state: "absent" };
    throw commandFailure("npm registry query", result);
  }
  const metadata = parseJson(result.stdout, "npm registry query");
  if (metadata?.version !== version || typeof metadata?.["dist.integrity"] !== "string") {
    throw new Error(`npm registry query returned invalid metadata for ${expectedPackageName}@${version}`);
  }
  return { state: "present", integrity: metadata["dist.integrity"] };
}

async function queryRegistry(runCommand, root, version) {
  const result = await runCommand(
    "npm",
    ["view", `${expectedPackageName}@${version}`, "version", "dist.integrity", "--json"],
    { cwd: root },
  );
  return registryState(result, version);
}

function requireMatchingIntegrity(state, integrity) {
  if (state.state === "present" && state.integrity !== integrity) {
    throw new Error("registry integrity does not match packed artifact");
  }
}

export async function publishRelease({
  root = scriptRoot,
  tag,
  repository,
  commit,
  runCommand = defaultRunCommand,
  sleep = defaultSleep,
  delaysMs = defaultDelaysMs,
}) {
  if (!/^[0-9a-f]{40}$/u.test(String(commit))) {
    throw new Error("commit must be a full lowercase 40-character Git SHA");
  }
  const context = validatePublishContext({ tag, repository }, root);
  const packDirectory = await mkdtemp(join(tmpdir(), "brain-hands-publish-"));

  try {
    const packResult = await runCommand(
      "npm",
      ["pack", "--json", "--ignore-scripts", "--pack-destination", packDirectory],
      { cwd: root },
    );
    const artifact = parsePackResult(packResult, context.packageVersion);
    await stat(join(packDirectory, artifact.filename));

    const initialState = await queryRegistry(runCommand, root, context.packageVersion);
    requireMatchingIntegrity(initialState, artifact.integrity);
    let published = false;

    if (initialState.state === "absent") {
      const publishResult = await runCommand(
        "npm",
        ["publish", `./${artifact.filename}`, "--access", "public"],
        { cwd: packDirectory },
      );
      if (publishResult.status !== 0) throw commandFailure("npm publish", publishResult);
      published = true;

      let registryVerified = false;
      for (const delay of delaysMs) {
        if (!Number.isSafeInteger(delay) || delay < 0) throw new Error("registry retry delays must be non-negative integers");
        if (delay > 0) await sleep(delay);
        const state = await queryRegistry(runCommand, root, context.packageVersion);
        requireMatchingIntegrity(state, artifact.integrity);
        if (state.state === "present") {
          registryVerified = true;
          break;
        }
      }
      if (!registryVerified) throw new Error("published package did not become visible in the npm registry");
    }

    return {
      package: expectedPackageName,
      version: context.packageVersion,
      tag,
      commit,
      tarball: artifact.filename,
      integrity: artifact.integrity,
      published,
      registryVerified: true,
    };
  } finally {
    await rm(packDirectory, { recursive: true, force: true });
  }
}

function readOption(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    const tag = readOption("--tag");
    const commit = readOption("--commit");
    const repository = readOption("--repository") ?? process.env.GITHUB_REPOSITORY;
    if (!tag) throw new Error("--tag is required");
    if (!commit) throw new Error("--commit is required");
    if (!repository) throw new Error("--repository is required outside GitHub Actions");
    const result = await publishRelease({ tag, commit, repository });
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
