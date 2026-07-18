#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const json = process.argv.includes("--json");
if (process.env.BRAIN_HANDS_LIVE_CANARY !== "1") {
  const result = {
    ok: false,
    skipped: true,
    reason: "Set BRAIN_HANDS_LIVE_CANARY=1 to authorize a live Codex canary.",
  };
  process.stdout.write(json ? `${JSON.stringify(result, null, 2)}\n` : `${result.reason}\n`);
  process.exit(0);
}

const root = process.cwd();
const repo = mkdtempSync(join(tmpdir(), "brain-hands-planner-canary-"));
const run = (command, args, cwd = repo) => execFileSync(command, args, {
  cwd,
  encoding: "utf8",
  timeout: 10 * 60 * 1000,
  env: process.env,
  stdio: ["ignore", "pipe", "pipe"],
});

try {
  writeFileSync(join(repo, "README.md"), "# Planner canary\n\nA minimal temporary repository.\n");
  run("git", ["init", "-q"]);
  run("git", ["add", "README.md"]);
  run("git", ["-c", "user.name=Brain Hands Canary", "-c", "user.email=canary@example.invalid", "commit", "-qm", "init"]);
  run(process.execPath, [join(root, "dist", "cli.js"), "init", "--repo", repo]);
  const output = run(process.execPath, [
    join(root, "dist", "cli.js"),
    "run",
    "Add one focused README acceptance note with a direct verification command.",
    "--repo", repo,
    "--mode", "local",
    "--no-research",
    "--no-reflection",
    "--brain-model", "gpt-5.5",
    "--hands-model", "gpt-5.5",
    "--verifier-model", "gpt-5.5",
    "--json",
  ]);
  JSON.parse(output);
  const runIds = readdirSync(join(repo, ".brain-hands", "runs"));
  if (runIds.length !== 1) throw new Error("Live canary did not create exactly one durable run");
  const runDir = join(repo, ".brain-hands", "runs", runIds[0]);
  const manifest = JSON.parse(readFileSync(join(runDir, "manifest.json"), "utf8"));
  if (!String(manifest.stage).startsWith("awaiting_discovery_")) throw new Error("Live canary did not reach a durable discovery boundary");
  const report = { ok: true, skipped: false, state: manifest.stage, stage: manifest.stage, run_dir: runDir, temporary_repo: repo };
  process.stdout.write(json ? `${JSON.stringify(report, null, 2)}\n` : `Live canary reached ${report.state} (${report.stage}).\n`);
} catch (error) {
  const report = { ok: false, skipped: false, error: error instanceof Error ? error.message : String(error), temporary_repo: repo };
  process.stdout.write(json ? `${JSON.stringify(report, null, 2)}\n` : `Live canary failed: ${report.error}\n`);
  process.exitCode = 1;
}
