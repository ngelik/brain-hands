import { createHash } from "node:crypto";
import { chmod, cp, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { parseStableVersion } from "../../.agents/skills/brain-hands/scripts/version-compatibility.mjs";

type FixtureOverrides = {
  packageName?: string;
  repository?: unknown;
  packageVersion?: string;
  packageLockRootVersion?: string;
  packageLockPackageVersion?: string;
  pluginVersion?: string;
  skillRange?: string;
  cliVersion?: string;
};

const root = process.cwd();
const validator = join(root, "scripts", "validate-release.mjs");
const versionSynchronizer = join(root, "scripts", "release-version.mjs");
const canonicalInvalidVersions = [
  "01.2.3",
  "0.2",
  "0.2.0.1",
  " 0.2.0",
  "0.2.0 ",
  "0.2.0-beta.1",
  "0.2.0+1",
  "v0.2.0",
];

async function createFixture(overrides: FixtureOverrides = {}) {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "brain-hands-release-validation-"));
  await mkdir(join(fixtureRoot, ".codex-plugin"), { recursive: true });
  await mkdir(join(fixtureRoot, ".agents", "skills", "brain-hands"), { recursive: true });
  await mkdir(join(fixtureRoot, "dist"), { recursive: true });

  const packageVersion = overrides.packageVersion ?? "0.2.0";
  await writeFile(join(fixtureRoot, "package.json"), JSON.stringify({
    name: overrides.packageName ?? "@ngelik/brain-hands",
    version: packageVersion,
    repository: overrides.repository ?? "git+https://github.com/ngelik/brain-hands.git",
  }), "utf8");
  await writeFile(join(fixtureRoot, "package-lock.json"), JSON.stringify({
    name: "@ngelik/brain-hands",
    version: overrides.packageLockRootVersion ?? packageVersion,
    lockfileVersion: 3,
    packages: {
      "": {
        version: overrides.packageLockPackageVersion ?? packageVersion,
      },
    },
  }), "utf8");
  await writeFile(
    join(fixtureRoot, ".codex-plugin", "plugin.json"),
    JSON.stringify({ version: overrides.pluginVersion ?? packageVersion }),
    "utf8",
  );
  await writeFile(
    join(fixtureRoot, ".agents", "skills", "brain-hands", "SKILL.md"),
    `---\nrequires:\n  codex_flow: "${overrides.skillRange ?? `^${packageVersion}`}"\n---\n`,
    "utf8",
  );
  const cli = join(fixtureRoot, "dist", "cli.js");
  await writeFile(cli, `process.stdout.write("${overrides.cliVersion ?? packageVersion}\\n");\n`, "utf8");
  await chmod(cli, 0o755);
  return fixtureRoot;
}

function runValidator(
  fixtureRoot: string,
  args: string[] = [],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [validator, "--root", fixtureRoot, ...args], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function runVersionSynchronizer(
  fixtureRoot: string,
  version: string,
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [versionSynchronizer, "sync", version, "--root", fixtureRoot], {
      cwd: root,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stderr }));
  });
}

function inspectPackageFiles(): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const child = spawn("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
      cwd: root,
      env: { ...process.env, npm_config_cache: join(tmpdir(), `brain-hands-release-validation-npm-${process.pid}`) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`npm pack --dry-run failed (${code}): ${stderr}`));
      const result = JSON.parse(stdout) as Array<{ files: Array<{ path: string }> }>;
      resolve(result[0]?.files.map((file) => file.path) ?? []);
    });
  });
}

function runProcess(command: string, args: string[], cwd: string, env = process.env): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

type Cacache = {
  get(cache: string, key: string): Promise<{ data: Buffer; metadata?: unknown }>;
  put(cache: string, key: string, data: Buffer, options: { metadata?: unknown }): Promise<unknown>;
};

async function seedOfflineRuntimeCache(cacheRoot: string): Promise<void> {
  const npmRootResult = await runProcess("npm", ["root", "--global"], root);
  if (npmRootResult.code !== 0) throw new Error("Unable to locate npm's installation root");
  const npmRoot = npmRootResult.stdout.trim();
  const destinationCache = join(cacheRoot, "_cacache");
  const tarballRoot = join(cacheRoot, "tarballs");
  await mkdir(tarballRoot, { recursive: true });
  const requireFromNpm = createRequire(join(npmRoot, "npm", "package.json"));
  const cacache = requireFromNpm("cacache") as Cacache;
  const lock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8")) as {
    packages: Record<string, { dev?: boolean; integrity?: string; resolved?: string; version?: string }>;
  };
  const packuments = new Map<string, Record<string, Record<string, unknown>>>();
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (!path.startsWith("node_modules/") || entry.dev === true || !entry.resolved?.startsWith("https://registry.npmjs.org/") || !entry.version) continue;
    const installedRoot = join(root, path);
    const metadata = JSON.parse(await readFile(join(installedRoot, "package.json"), "utf8")) as Record<string, unknown> & { name?: string; version?: string };
    if (!metadata.name || metadata.version !== entry.version) throw new Error(`Installed package metadata does not match locked runtime package ${path}`);
    const artifactName = `${Buffer.from(path).toString("base64url")}.tgz`;
    const stagingRoot = join(cacheRoot, "staging", Buffer.from(path).toString("base64url"));
    await mkdir(stagingRoot, { recursive: true });
    await cp(installedRoot, join(stagingRoot, "package"), { recursive: true });
    const packed = await runProcess("tar", ["-czf", join(tarballRoot, artifactName), "-C", stagingRoot, "package"], root);
    if (packed.code !== 0) throw new Error(`Unable to archive locked runtime package ${metadata.name}: ${packed.stderr}`);
    const artifactBytes = await readFile(join(tarballRoot, artifactName));
    const integrity = `sha512-${createHash("sha512").update(artifactBytes).digest("base64")}`;
    await cacache.put(destinationCache, `make-fetch-happen:request-cache:${entry.resolved}`, artifactBytes, {
      metadata: { time: Date.now(), url: entry.resolved, reqHeaders: {}, resHeaders: { "content-type": "application/octet-stream" }, options: { compress: true } },
    });
    const versions = packuments.get(metadata.name) ?? {};
    versions[entry.version] = { ...metadata, dist: { tarball: entry.resolved, integrity } };
    packuments.set(metadata.name, versions);
  }
  for (const [name, versions] of packuments) {
    const latest = Object.keys(versions).sort((left, right) => left.localeCompare(right, undefined, { numeric: true })).at(-1)!;
    const url = `https://registry.npmjs.org/${name.startsWith("@") ? name.replace("/", "%2f") : name}`;
    await cacache.put(destinationCache, `make-fetch-happen:request-cache:${url}`, Buffer.from(JSON.stringify({ name, "dist-tags": { latest }, versions })), {
      metadata: { time: Date.now(), url, reqHeaders: { accept: "application/json" }, resHeaders: { "content-type": "application/json" }, options: { compress: true } },
    });
  }
}

async function installPackedArtifactOffline(prefix: string): Promise<string> {
  const artifactRoot = join(prefix, "artifacts");
  await mkdir(artifactRoot, { recursive: true });
  const packed = await runProcess("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", artifactRoot], root, {
    ...process.env,
    npm_config_cache: join(prefix, "pack-cache"),
  });
  if (packed.code !== 0) throw new Error(`npm pack failed (${packed.code}): ${packed.stderr}`);
  const filename = (JSON.parse(packed.stdout) as Array<{ filename?: string }>)[0]?.filename;
  if (!filename) throw new Error("npm pack did not report an artifact filename");
  const installCache = join(prefix, "install-cache");
  await seedOfflineRuntimeCache(installCache);
  const installed = await runProcess("npm", [
    "install", "--global", "--offline", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund",
    "--prefix", prefix, "--cache", installCache, join(artifactRoot, filename),
  ], root);
  if (installed.code !== 0) throw new Error(`offline npm install failed (${installed.code}): ${installed.stderr}`);
  return join(prefix, "bin", "brain-hands");
}

describe("release validation", () => {
  it("synchronizes the four release version surfaces", async () => {
    const fixtureRoot = await createFixture();
    try {
      const result = await runVersionSynchronizer(fixtureRoot, "0.3.3");
      expect(result).toEqual({ code: 0, stderr: "" });
      const packageJson = JSON.parse(await readFile(join(fixtureRoot, "package.json"), "utf8"));
      const packageLock = JSON.parse(await readFile(join(fixtureRoot, "package-lock.json"), "utf8"));
      const plugin = JSON.parse(await readFile(join(fixtureRoot, ".codex-plugin", "plugin.json"), "utf8"));
      const skill = await readFile(join(fixtureRoot, ".agents", "skills", "brain-hands", "SKILL.md"), "utf8");
      expect({
        packageVersion: packageJson.version,
        lockfileVersion: packageLock.version,
        lockfilePackageVersion: packageLock.packages[""].version,
        pluginVersion: plugin.version,
        requiredRange: /codex_flow:\s*["']?([^"'\s]+)/u.exec(skill)?.[1],
      }).toEqual({
        packageVersion: "0.3.3",
        lockfileVersion: "0.3.3",
        lockfilePackageVersion: "0.3.3",
        pluginVersion: "0.3.3",
        requiredRange: "^0.3.3",
      });
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("packages the discovery runtime allowlist without source, test, docs, or run data", async () => {
    const files = await inspectPackageFiles();
    expect(files).toEqual(expect.arrayContaining([
      "package.json",
      "dist/cli.js",
      "prompts/brain-discovery-v1.md",
      "README.md",
      "agentic-codex-workflow.md",
    ]));
    for (const excluded of ["src/", "tests/", "docs/", ".brain-hands/", ".agents/", ".codex-plugin/"]) {
      expect(files.some((path) => path.startsWith(excluded)), excluded).toBe(false);
    }
  }, 20_000);

  it("runs the version and effect-boundary help from an offline-installed packed artifact", async () => {
    const prefix = await mkdtemp(join(tmpdir(), "brain-hands-packed-cli-"));
    try {
      const binary = await installPackedArtifactOffline(prefix);
      const resolvedBinary = await realpath(binary);
      expect(resolvedBinary.startsWith(await realpath(prefix))).toBe(true);
      expect(resolvedBinary).not.toBe(join(root, "dist", "cli.js"));
      const packageRoot = dirname(dirname(resolvedBinary));
      expect(JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"))).toMatchObject({
        name: "@ngelik/brain-hands",
        bin: { "brain-hands": "dist/cli.js" },
      });
      const packageVersion = (JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { version: string }).version;
      const [version, approve, resume, reconcile] = await Promise.all([
        runProcess(binary, ["--version"], prefix),
        runProcess(binary, ["approve-plan", "--help"], prefix),
        runProcess(binary, ["resume", "--help"], prefix),
        runProcess(binary, ["reconcile-github", "--help"], prefix),
      ]);
      expect(version).toMatchObject({ code: 0, stdout: `${packageVersion}\n`, stderr: "" });
      expect(approve).toMatchObject({ code: 0, stderr: "" });
      expect(approve.stdout).toContain("stop at the next effect boundary");
      expect(resume).toMatchObject({ code: 0, stderr: "" });
      expect(resume.stdout).toContain("Apply the current approved effect preview");
      expect(reconcile).toMatchObject({ code: 0, stderr: "" });
      expect(reconcile.stdout).toContain("Dry-run GitHub issue lifecycle audit; repair only with --apply");
      expect(reconcile.stdout).toContain("--apply");
    } finally {
      await rm(prefix, { recursive: true, force: true });
    }
  }, 120_000);

  it.each(canonicalInvalidVersions)("rejects non-canonical stable versions in the shared parser (%s)", (version) => {
    expect(() => parseStableVersion(version)).toThrow("stable semantic version");
  });

  it("accepts matching package, plugin, skill, lockfile, and CLI versions", async () => {
    const fixtureRoot = await createFixture();
    try {
      const result = await runValidator(fixtureRoot);
      expect(result.code).toBe(0);
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("accepts an exact publish tag and GitHub repository", async () => {
    const fixtureRoot = await createFixture();
    try {
      const result = await runValidator(fixtureRoot, [
        "--json",
        "--tag", "v0.2.0",
        "--repository", "ngelik/brain-hands",
      ]);
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        packageVersion: "0.2.0",
        tag: "v0.2.0",
        repository: "ngelik/brain-hands",
      });
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it.each([
    [["--tag", "release-0.2.0", "--repository", "ngelik/brain-hands"], "tag must be exactly v0.2.0"],
    [["--tag", "v0.2.1", "--repository", "ngelik/brain-hands"], "tag v0.2.1 does not match package version 0.2.0"],
    [["--tag", "v0.2.0", "--repository", "attacker/brain-hands"], "GitHub repository must be exactly ngelik/brain-hands"],
    [["--tag", "v0.2.0"], "--tag and --repository must be provided together"],
  ])("rejects invalid publish context %#", async (args, message) => {
    const fixtureRoot = await createFixture();
    try {
      const result = await runValidator(fixtureRoot, args);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(message);
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("accepts zero-inclusive canonical versions", async () => {
    const packageVersion = "0.0.0";
    const fixtureRoot = await createFixture({
      packageVersion,
      cliVersion: packageVersion,
      skillRange: `^${packageVersion}`,
      packageLockRootVersion: packageVersion,
      packageLockPackageVersion: packageVersion,
    });
    try {
      const result = await runValidator(fixtureRoot);
      expect(result.code).toBe(0);
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it.each(canonicalInvalidVersions)("rejects canonical-invalid package versions (%s)", async (packageVersion) => {
    const fixtureRoot = await createFixture({ packageVersion });
    try {
      const result = await runValidator(fixtureRoot);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("canonical stable semantic version");
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it.each([
    [{ pluginVersion: "0.1.0" }, "plugin.json version"],
    [{ skillRange: "^0.1.0" }, "SKILL.md requires.codex_flow"],
    [{ cliVersion: "0.1.0" }, "CLI version"],
    [{ packageLockRootVersion: "0.1.0" }, "package-lock.json root version"],
    [{ packageLockPackageVersion: "0.1.0" }, "package-lock.json packages[\"\"].version"],
  ])("rejects %s drift", async (overrides, message) => {
    const fixtureRoot = await createFixture(overrides);
    try {
      const result = await runValidator(fixtureRoot);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(message);
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it.each([
    [{ packageName: "@example/brain-hands" }, "package.json name"],
    [{ repository: "https://github.com/example/brain-hands.git" }, "package.json repository"],
  ])("rejects canonical package identity drift (%s)", async (overrides, message) => {
    const fixtureRoot = await createFixture(overrides);
    try {
      const result = await runValidator(fixtureRoot);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(message);
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it.each(["0.2.0 ", "0.2", "0.2.0.1"])("rejects canonical-invalid CLI versions (%s)", async (cliVersion) => {
    const fixtureRoot = await createFixture({
      packageVersion: "0.2.0",
      cliVersion,
    });
    try {
      const result = await runValidator(fixtureRoot);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("canonical stable semantic version");
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });
});
