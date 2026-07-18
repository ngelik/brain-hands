import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { hashDirectory, IMMUTABLE_DIST_ENV } from "./dist-artifact.mjs";

const commandStage = (label, script) => Object.freeze({ kind: "command", label, script });
const digestStage = (label) => Object.freeze({ kind: "digest", label });

const staticContractTests = commandStage("static contract tests", "test:static-contract");
const crossCuttingTests = commandStage("cross-cutting tests", "test:cross-cutting");
const typecheck = commandStage("typecheck", "typecheck");
const build = commandStage("build", "build");
const releaseMetadataValidation = commandStage(
  "release metadata validation",
  "validate-release",
);
const freezeDistDigest = digestStage("freeze dist digest");
const builtCliTests = commandStage("built-CLI tests", "test:built-cli");
const compareAfterBuiltCli = digestStage("compare dist digest after built-CLI tests");
const releaseRehearsalTests = commandStage("release rehearsal tests", "test:release:no-build");
const compareAfterReleaseRehearsal = digestStage(
  "compare dist digest after release rehearsal tests",
);
const integratedFullSuite = commandStage("integrated full suite", "test:all:no-build");
const compareAfterIntegratedSuite = digestStage(
  "compare dist digest after integrated full suite",
);

export const VERIFICATION_STAGES = Object.freeze([
  staticContractTests,
  crossCuttingTests,
  typecheck,
  build,
  releaseMetadataValidation,
  freezeDistDigest,
  builtCliTests,
  compareAfterBuiltCli,
  releaseRehearsalTests,
  compareAfterReleaseRehearsal,
  integratedFullSuite,
  compareAfterIntegratedSuite,
]);

export class RepositoryVerificationError extends Error {
  constructor(message, details) {
    super(message);
    this.name = "RepositoryVerificationError";
    Object.assign(this, details);
  }
}

function spawnCommand({ argv, cwd, env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      env,
      shell: false,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("close", resolve);
  });
}

async function runCommandStage(stage, { cwd, env, npmCommand, runCommand }) {
  const argv = [npmCommand, "run", stage.script];
  let exitCode;
  try {
    exitCode = await runCommand({ label: stage.label, argv, cwd, env });
  } catch (cause) {
    const causeMessage = cause instanceof Error ? cause.message : String(cause);
    throw new RepositoryVerificationError(
      `${stage.label} command failed: ${causeMessage}`,
      { stage: stage.label, argv, cause },
    );
  }
  if (exitCode !== undefined && exitCode !== 0) {
    throw new RepositoryVerificationError(
      `${stage.label} failed with exit code ${exitCode}`,
      { stage: stage.label, argv, exitCode },
    );
  }
}

async function hashDistStage(stage, { cwd, hashDist }) {
  try {
    return await hashDist({ label: stage.label, cwd });
  } catch (cause) {
    const causeMessage = cause instanceof Error ? cause.message : String(cause);
    throw new RepositoryVerificationError(
      `${stage.label} failed: ${causeMessage}`,
      { stage: stage.label, cause },
    );
  }
}

function assertMatchingDigest(stage, originalDigest, observedDigest) {
  if (observedDigest === originalDigest) {
    return;
  }
  throw new RepositoryVerificationError(
    `${stage}: original digest ${originalDigest}; observed digest ${observedDigest}`,
    { stage, originalDigest, observedDigest },
  );
}

export async function verifyRepository(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const sourceEnvironment = options.env ?? process.env;
  if (sourceEnvironment[IMMUTABLE_DIST_ENV] === "1") {
    throw new RepositoryVerificationError(
      `${IMMUTABLE_DIST_ENV}=1 is reserved for post-build verification stages`,
      { stage: "immutable dist preflight" },
    );
  }
  const runCommand = options.runCommand ?? spawnCommand;
  const hashDist = options.hashDist ?? (async () => hashDirectory(join(cwd, "dist")));
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const mutableEnvironment = { ...sourceEnvironment };
  delete mutableEnvironment[IMMUTABLE_DIST_ENV];
  const mutableCommandOptions = {
    cwd,
    env: mutableEnvironment,
    npmCommand,
    runCommand,
  };

  await runCommandStage(staticContractTests, mutableCommandOptions);
  await runCommandStage(crossCuttingTests, mutableCommandOptions);
  await runCommandStage(typecheck, mutableCommandOptions);
  await runCommandStage(build, mutableCommandOptions);
  await runCommandStage(releaseMetadataValidation, mutableCommandOptions);

  const originalDigest = await hashDistStage(freezeDistDigest, { cwd, hashDist });
  const immutableEnvironment = Object.freeze({
    ...mutableEnvironment,
    [IMMUTABLE_DIST_ENV]: "1",
  });
  const immutableCommandOptions = {
    cwd,
    env: immutableEnvironment,
    npmCommand,
    runCommand,
  };

  await runCommandStage(builtCliTests, immutableCommandOptions);
  assertMatchingDigest(
    compareAfterBuiltCli.label,
    originalDigest,
    await hashDistStage(compareAfterBuiltCli, { cwd, hashDist }),
  );

  await runCommandStage(releaseRehearsalTests, immutableCommandOptions);
  assertMatchingDigest(
    compareAfterReleaseRehearsal.label,
    originalDigest,
    await hashDistStage(compareAfterReleaseRehearsal, { cwd, hashDist }),
  );

  await runCommandStage(integratedFullSuite, immutableCommandOptions);
  assertMatchingDigest(
    compareAfterIntegratedSuite.label,
    originalDigest,
    await hashDistStage(compareAfterIntegratedSuite, { cwd, hashDist }),
  );
}

function isDirectExecution() {
  if (process.argv[1] === undefined) {
    return false;
  }
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  try {
    await verifyRepository();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
