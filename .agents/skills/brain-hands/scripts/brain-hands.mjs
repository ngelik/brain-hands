#!/usr/bin/env node
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { parseCliVersionOutput, requiredCodexFlowRange, satisfiesCaretRange } from "./version-compatibility.mjs";

const scriptPath = resolve(fileURLToPath(import.meta.url));
let repoRoot = dirname(scriptPath);
for (let parent = 0; parent < 4; parent += 1) repoRoot = dirname(repoRoot);
const distCli = join(repoRoot, "dist", "cli.js");

function findInstalledBrainHands() {
  const pathEntries = (process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":").filter(Boolean);
  const candidates = process.platform === "win32" ? ["brain-hands.cmd", "brain-hands.exe", "brain-hands"] : ["brain-hands"];
  for (const entry of pathEntries) {
    for (const name of candidates) {
      const candidate = join(entry, name);
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Continue searching PATH.
      }
    }
  }
  return null;
}

function run(command, args, stdio, env = process.env) {
  return spawnSync(command, args, { cwd: repoRoot, encoding: "utf8", stdio, env });
}

function statusOf(result) {
  return typeof result.status === "number" ? result.status : 1;
}

function describeError(result) {
  return String(result.error?.message ?? result.stderr ?? result.stdout ?? "no diagnostic output").trim();
}

function requiredRange() {
  const skillPath = join(repoRoot, ".agents", "skills", "brain-hands", "SKILL.md");
  return requiredCodexFlowRange(readFileSync(skillPath, "utf8"));
}

function compatibleVersion(chosen, range) {
  const result = run(chosen.command, [...chosen.prefix, "--version"], "pipe");
  if (statusOf(result) !== 0) return { ok: false, reason: `could not report a version (${describeError(result)})` };
  try {
    const version = parseCliVersionOutput(result.stdout);
    if (!satisfiesCaretRange(version, range)) return { ok: false, reason: `reported incompatible version ${version}` };
    return { ok: true, version };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

function supportsCommand(chosen, command) {
  if (command !== "preview") return { ok: true };
  const result = run(chosen.command, [...chosen.prefix, "preview", "--help"], "pipe");
  if (statusOf(result) !== 0) {
    return { ok: false, reason: `does not support preview (${describeError(result)})` };
  }
  return /^Usage:\s+brain-hands\s+preview(?:\s|$)/m.test(String(result.stdout))
    ? { ok: true }
    : { ok: false, reason: "does not support preview (preview help returned global command usage)" };
}

function chooseCommand(range, developmentController, command) {
  const installed = findInstalledBrainHands();
  const candidates = developmentController
    ? (existsSync(distCli) ? [{ command: process.execPath, prefix: [distCli], installed: false }] : [])
    : (installed ? [{ command: installed, prefix: [], installed: true }] : []);
  const failures = [];
  for (const candidate of candidates) {
    const version = compatibleVersion(candidate, range);
    if (!version.ok) {
      failures.push(`${candidate.installed ? "installed" : "bundled"}: ${version.reason}`);
      continue;
    }
    const capability = supportsCommand(candidate, command);
    if (capability.ok) return candidate;
    failures.push(`${candidate.installed ? "installed" : "bundled"}: ${capability.reason}`);
  }
  if (failures.length > 0) {
    throw new Error(
      `No compatible brain-hands CLI found for skill requirement ${range}. ${failures.join("; ")} ` +
      `Install a compatible @ngelik/brain-hands package${developmentController ? " or rebuild the checkout CLI" : "; use --development-controller only for explicit checkout development"}.`,
    );
  }
  throw new Error(
    `No installed brain-hands executable was found. Install @ngelik/brain-hands or use --development-controller ` +
    `after building the checkout CLI at ${distCli}.`,
  );
}

function handshake(chosen) {
  const doctor = run(chosen.command, [...chosen.prefix, "doctor", "--repo", repoRoot, "--mode", "local", "--no-github"], "pipe");
  if (statusOf(doctor) !== 0) {
    throw new Error(
      `brain-hands capability handshake failed: doctor could not validate the current Codex CLI contract (${describeError(doctor)}). ` +
      "The installed Codex CLI may be outdated or missing structured-output flags. Update Codex and retry; use npm run build for a checkout CLI.",
    );
  }
}

try {
  const forwardedArgs = process.argv.slice(2);
  const developmentIndex = forwardedArgs.indexOf("--development-controller");
  const developmentController = developmentIndex >= 0;
  if (developmentController) forwardedArgs.splice(developmentIndex, 1);
  const chosen = chooseCommand(requiredRange(), developmentController, forwardedArgs[0]);
  if (forwardedArgs[0] !== "preview") handshake(chosen);
  const result = run(chosen.command, [...chosen.prefix, ...forwardedArgs], "inherit", {
    ...process.env,
    BRAIN_HANDS_EXECUTABLE_PATH: chosen.installed ? chosen.command : distCli,
    BRAIN_HANDS_CONTROLLER_MODE: chosen.installed ? "installed" : "development_checkout",
  });
  process.exitCode = statusOf(result);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
