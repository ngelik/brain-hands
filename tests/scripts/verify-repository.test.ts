import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

type CommandCall = {
  label: string;
  argv: string[];
  cwd: string;
  env: Record<string, string | undefined>;
};

type DigestCall = {
  label: string;
  cwd: string;
};

type VerificationStage = Readonly<{
  kind: "command" | "digest";
  label: string;
  script?: string;
}>;

type CoordinatorModule = {
  RepositoryVerificationError: typeof Error;
  VERIFICATION_STAGES: readonly VerificationStage[];
  verifyRepository(options: {
    cwd: string;
    env: Record<string, string | undefined>;
    runCommand(call: CommandCall): Promise<number | undefined>;
    hashDist(call: DigestCall): Promise<string>;
  }): Promise<void>;
  verifyFocusedRepository(options: {
    cwd: string;
    env: Record<string, string | undefined>;
    testFiles: string[];
    runCommand(call: CommandCall): Promise<number | undefined>;
    hashDist(call: DigestCall): Promise<string>;
  }): Promise<void>;
};

const coordinatorModulePath = "../../scripts/verify-repository.mjs";
const {
  RepositoryVerificationError,
  VERIFICATION_STAGES,
  verifyFocusedRepository,
  verifyRepository,
} = await import(coordinatorModulePath) as CoordinatorModule;

type Operation =
  | { kind: "command"; label: string }
  | { kind: "digest"; label: string };

const cwd = "/repository";
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

const expectedOperations: Operation[] = [
  { kind: "command", label: "static contract tests" },
  { kind: "command", label: "cross-cutting tests" },
  { kind: "command", label: "typecheck" },
  { kind: "command", label: "build" },
  { kind: "command", label: "release metadata validation" },
  { kind: "digest", label: "freeze dist digest" },
  { kind: "command", label: "built-CLI tests" },
  { kind: "digest", label: "compare dist digest after built-CLI tests" },
  { kind: "command", label: "release rehearsal tests" },
  { kind: "digest", label: "compare dist digest after release rehearsal tests" },
  { kind: "command", label: "integrated full suite" },
  { kind: "digest", label: "compare dist digest after integrated full suite" },
];

const expectedArgv = [
  [npmCommand, "run", "test:static-contract"],
  [npmCommand, "run", "test:cross-cutting"],
  [npmCommand, "run", "typecheck"],
  [npmCommand, "run", "build"],
  [npmCommand, "run", "validate-release"],
  [npmCommand, "run", "test:built-cli"],
  [npmCommand, "run", "test:release:no-build"],
  [npmCommand, "run", "test:all:no-build"],
];

function createHarness(options: {
  digests?: string[];
  failingCommand?: string;
  rejectingCommand?: { label: string; error: Error };
  digestError?: { label: string; error: Error };
} = {}) {
  const operations: Operation[] = [];
  const commandCalls: CommandCall[] = [];
  const digestCalls: DigestCall[] = [];
  const digests = [...(options.digests ?? ["frozen", "frozen", "frozen", "frozen"])];

  const runCommand = async (call: CommandCall) => {
    commandCalls.push(call);
    operations.push({ kind: "command", label: call.label });
    if (call.label === options.rejectingCommand?.label) {
      throw options.rejectingCommand.error;
    }
    return call.label === options.failingCommand ? 23 : 0;
  };
  const hashDist = async (call: DigestCall) => {
    digestCalls.push(call);
    operations.push({ kind: "digest", label: call.label });
    if (call.label === options.digestError?.label) {
      throw options.digestError.error;
    }
    const digest = digests.shift();
    if (digest === undefined) {
      throw new Error("test digest sequence exhausted");
    }
    return digest;
  };

  return { commandCalls, digestCalls, hashDist, operations, runCommand };
}

function runScript(argv: string[], options: {
  cwd: string;
  env: NodeJS.ProcessEnv;
}): Promise<{ exitCode: number | null; stderr: string; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, argv, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (exitCode) => resolve({ exitCode, stderr, stdout }));
  });
}

describe("repository verification coordinator", () => {
  it("runs a bounded focused sequence with one immutable build", async () => {
    const harness = createHarness({ digests: ["frozen", "frozen"] });
    await verifyFocusedRepository({
      cwd,
      env: { BASELINE: "present" },
      testFiles: ["tests/core/example.test.ts", "tests/cli-smoke.test.ts"],
      runCommand: harness.runCommand,
      hashDist: harness.hashDist,
    });

    expect(harness.commandCalls.map((call) => call.argv)).toEqual([
      [npmCommand, "run", "typecheck"],
      [npmCommand, "run", "build"],
      [process.platform === "win32" ? "npx.cmd" : "npx", "vitest", "run", "tests/core/example.test.ts", "tests/cli-smoke.test.ts"],
    ]);
    expect(harness.commandCalls[2]?.env.BRAIN_HANDS_DIST_IMMUTABLE).toBe("1");
    expect(harness.digestCalls).toHaveLength(2);
  });

  it.each([
    { testFiles: [] },
    { testFiles: ["src/core/example.ts"] },
    { testFiles: ["../tests/example.test.ts"] },
  ])(
    "rejects invalid focused test paths $testFiles before running commands",
    async ({ testFiles }) => {
      const harness = createHarness();
      await expect(verifyFocusedRepository({
        cwd,
        env: {},
        testFiles,
        runCommand: harness.runCommand,
        hashDist: harness.hashDist,
      })).rejects.toThrow(/Focused verification/);
      expect(harness.commandCalls).toEqual([]);
    },
  );

  it("exposes the exact immutable stage order", () => {
    expect(VERIFICATION_STAGES.map(({ kind, label }) => ({ kind, label }))).toEqual(
      expectedOperations,
    );
    expect(Object.isFrozen(VERIFICATION_STAGES)).toBe(true);
    expect(VERIFICATION_STAGES.every(Object.isFrozen)).toBe(true);
  });

  it("runs the successful argv-only sequence with one frozen build", async () => {
    const harness = createHarness();

    await verifyRepository({
      cwd,
      env: { BASELINE: "present" },
      runCommand: harness.runCommand,
      hashDist: harness.hashDist,
    });

    expect(harness.operations).toEqual(expectedOperations);
    expect(harness.commandCalls.map(({ argv }) => argv)).toEqual(expectedArgv);
    expect(harness.commandCalls.every((call) => call.cwd === cwd)).toBe(true);
    expect(harness.digestCalls.every((call) => call.cwd === cwd)).toBe(true);
  });

  it("rejects an inherited immutable-dist guard before any repository operation", async () => {
    const harness = createHarness();

    const error = await verifyRepository({
      cwd,
      env: { BRAIN_HANDS_DIST_IMMUTABLE: "1" },
      runCommand: harness.runCommand,
      hashDist: harness.hashDist,
    }).catch((caught: unknown) => caught);

    expect(harness.operations).toEqual([]);
    expect(harness.commandCalls).toEqual([]);
    expect(harness.digestCalls).toEqual([]);
    expect(error).toBeInstanceOf(RepositoryVerificationError);
    expect((error as Error).message).toContain("BRAIN_HANDS_DIST_IMMUTABLE=1");
  });

  it("ignores a non-guard immutable-dist value during mutable stages", async () => {
    const harness = createHarness();

    await verifyRepository({
      cwd,
      env: { BRAIN_HANDS_DIST_IMMUTABLE: "caller-value" },
      runCommand: harness.runCommand,
      hashDist: harness.hashDist,
    });

    expect(harness.operations).toEqual(expectedOperations);
    expect(harness.commandCalls.slice(0, 5).every((call) =>
      !("BRAIN_HANDS_DIST_IMMUTABLE" in call.env))).toBe(true);
  });

  it.each(expectedOperations.filter((operation) => operation.kind === "command"))(
    "stops after a non-zero exit from $label",
    async ({ label }) => {
      const harness = createHarness({ failingCommand: label });

      const error = await verifyRepository({
        cwd,
        env: {},
        runCommand: harness.runCommand,
        hashDist: harness.hashDist,
      }).catch((caught: unknown) => caught);

      const failingIndex = expectedOperations.findIndex(
        (operation) => operation.kind === "command" && operation.label === label,
      );
      expect(harness.operations).toEqual(expectedOperations.slice(0, failingIndex + 1));
      expect(error).toBeInstanceOf(RepositoryVerificationError);
      expect(error).toMatchObject({
        stage: label,
        argv: expectedArgv[expectedOperations
          .slice(0, failingIndex + 1)
          .filter((operation) => operation.kind === "command").length - 1],
        exitCode: 23,
      });
    },
  );

  it.each(expectedOperations.filter((operation) => operation.kind === "command"))(
    "wraps a runner rejection and stops at $label",
    async ({ label }) => {
      const cause = new Error(`${label} runner rejection`);
      const harness = createHarness({ rejectingCommand: { label, error: cause } });

      const error = await verifyRepository({
        cwd,
        env: {},
        runCommand: harness.runCommand,
        hashDist: harness.hashDist,
      }).catch((caught: unknown) => caught);

      const failingIndex = expectedOperations.findIndex(
        (operation) => operation.kind === "command" && operation.label === label,
      );
      expect(harness.operations).toEqual(expectedOperations.slice(0, failingIndex + 1));
      expect(error).toBeInstanceOf(RepositoryVerificationError);
      expect(error).toMatchObject({
        stage: label,
        argv: expectedArgv[expectedOperations
          .slice(0, failingIndex + 1)
          .filter((operation) => operation.kind === "command").length - 1],
        cause,
      });
    },
  );

  it.each([
    { label: "freeze dist digest", operationIndex: 5, missingDist: true },
    {
      label: "compare dist digest after built-CLI tests",
      operationIndex: 7,
      missingDist: false,
    },
    {
      label: "compare dist digest after release rehearsal tests",
      operationIndex: 9,
      missingDist: false,
    },
    {
      label: "compare dist digest after integrated full suite",
      operationIndex: 11,
      missingDist: false,
    },
  ])("wraps a hash rejection and stops at $label", async ({
    label,
    operationIndex,
    missingDist,
  }) => {
    const cause = missingDist
      ? Object.assign(new Error("dist is missing"), { code: "ENOENT" })
      : new Error(`${label} hash rejection`);
    const harness = createHarness({ digestError: { label, error: cause } });

    const error = await verifyRepository({
      cwd,
      env: {},
      runCommand: harness.runCommand,
      hashDist: harness.hashDist,
    }).catch((caught: unknown) => caught);

    expect(harness.operations).toEqual(expectedOperations.slice(0, operationIndex + 1));
    expect(error).toBeInstanceOf(RepositoryVerificationError);
    expect(error).toMatchObject({ stage: label, cause });
    expect((error as Error).message).toContain(label);
    if (missingDist) {
      expect((error as Error).message).toContain("dist is missing");
      expect((error as { cause: { code: string } }).cause.code).toBe("ENOENT");
    }
  });

  it("reports and stops on a digest mismatch after built-CLI tests", async () => {
    const harness = createHarness({ digests: ["original-digest", "changed-digest"] });

    const error = await verifyRepository({
      cwd,
      env: {},
      runCommand: harness.runCommand,
      hashDist: harness.hashDist,
    }).catch((caught: unknown) => caught);

    expect(harness.operations).toEqual(expectedOperations.slice(0, 8));
    expect(error).toBeInstanceOf(RepositoryVerificationError);
    expect(error).toMatchObject({
      stage: "compare dist digest after built-CLI tests",
      originalDigest: "original-digest",
      observedDigest: "changed-digest",
    });
    expect((error as Error).message).toContain("built-CLI tests");
    expect((error as Error).message).toContain("original-digest");
    expect((error as Error).message).toContain("changed-digest");
  });

  it("reports and stops on a digest mismatch after the integrated suite", async () => {
    const harness = createHarness({
      digests: ["original-digest", "original-digest", "original-digest", "changed-digest"],
    });

    const error = await verifyRepository({
      cwd,
      env: {},
      runCommand: harness.runCommand,
      hashDist: harness.hashDist,
    }).catch((caught: unknown) => caught);

    expect(harness.operations).toEqual(expectedOperations);
    expect(error).toBeInstanceOf(RepositoryVerificationError);
    expect(error).toMatchObject({
      stage: "compare dist digest after integrated full suite",
      originalDigest: "original-digest",
      observedDigest: "changed-digest",
    });
    expect((error as Error).message).toContain("integrated full suite");
    expect((error as Error).message).toContain("original-digest");
    expect((error as Error).message).toContain("changed-digest");
  });

  it("copies the environment and enables immutable dist only after the freeze", async () => {
    const inputEnv = {
      BASELINE: "present",
      BRAIN_HANDS_DIST_IMMUTABLE: "caller-value",
    };
    const harness = createHarness();

    await verifyRepository({
      cwd,
      env: inputEnv,
      runCommand: harness.runCommand,
      hashDist: harness.hashDist,
    });

    const preFreezeCalls = harness.commandCalls.slice(0, 5);
    const postFreezeCalls = harness.commandCalls.slice(5);
    expect(preFreezeCalls.every((call) =>
      !("BRAIN_HANDS_DIST_IMMUTABLE" in call.env) && !Object.isFrozen(call.env))).toBe(true);
    expect(postFreezeCalls.every((call) =>
      call.env.BRAIN_HANDS_DIST_IMMUTABLE === "1" && Object.isFrozen(call.env))).toBe(true);
    expect(postFreezeCalls[0]?.env).toBe(postFreezeCalls[1]?.env);
    expect(preFreezeCalls[0]?.env).not.toBe(inputEnv);
    expect(inputEnv).toEqual({
      BASELINE: "present",
      BRAIN_HANDS_DIST_IMMUTABLE: "caller-value",
    });
  });

  it("runs the first configured stage when executed directly and propagates failure", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "brain-hands-verifier-main-"));
    const capturePath = join(temporaryDirectory, "argv.txt");
    const fakeNpm = join(
      temporaryDirectory,
      process.platform === "win32" ? "npm.cmd" : "npm",
    );
    const fakeNpmContents = process.platform === "win32"
      ? "@echo %* > \"%CAPTURE_PATH%\"\r\n@exit /b 37\r\n"
      : "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$CAPTURE_PATH\"\nexit 37\n";
    await writeFile(fakeNpm, fakeNpmContents, { mode: 0o755 });

    try {
      const mutableEnvironment = { ...process.env };
      delete mutableEnvironment.BRAIN_HANDS_DIST_IMMUTABLE;
      const scriptPath = fileURLToPath(
        new URL("../../scripts/verify-repository.mjs", import.meta.url),
      );
      const result = await runScript([scriptPath], {
        cwd: temporaryDirectory,
        env: {
          ...mutableEnvironment,
          PATH: temporaryDirectory,
          CAPTURE_PATH: capturePath,
        },
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("static contract tests");
      expect(result.stderr).toContain("37");
      const capturedArgv = (await readFile(capturePath, "utf8")).trim().split(/\s+/);
      expect(capturedArgv).toEqual(["run", "test:static-contract"]);
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("prints focused usage without running verification", async () => {
    const scriptPath = fileURLToPath(
      new URL("../../scripts/verify-repository.mjs", import.meta.url),
    );
    const result = await runScript([scriptPath, "--focused", "--help"], {
      cwd: process.cwd(),
      env: process.env,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("npm run verify:focused -- tests/path/to/surface.test.ts");
    expect(result.stdout).toContain("not release evidence");
  });
});
