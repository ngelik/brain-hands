import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const projectRoot = process.cwd();
const releaseScript = join(projectRoot, "scripts", "release.sh");
const publicRepository = "https://github.com/ngelik/brain-hands.git";
const cleanupPaths: string[] = [];

type StubOptions = {
  verifyFunnelStatus?: number;
  allowPublish?: boolean;
};

type StubBundle = {
  PATH: string;
  npmLog: string;
  npmCwdLog: string;
  env: Record<string, string>;
};

async function git(repo: string, ...args: string[]) {
  const result = await execFileAsync("git", ["-C", repo, ...args], { encoding: "utf8" });
  return result.stdout.trim();
}

async function copyFile(source: string, target: string) {
  await mkdir(join(target, ".."), { recursive: true });
  await writeFile(target, await readFile(source));
}

async function createFixture(version = "0.2.0") {
  const remote = await mkdtemp(join(tmpdir(), "bh-release-remote-"));
  const root = await mkdtemp(join(tmpdir(), "bh-release-root-"));
  const pushLog = join(remote, "push-attempts.log");
  cleanupPaths.push(remote, root);

  await execFileAsync("git", ["-C", root, "init", "-q", "-b", "main"]);
  await execFileAsync("git", ["-C", root, "config", "user.email", "release-bot@example.com"]);
  await execFileAsync("git", ["-C", root, "config", "user.name", "Release Bot"]);
  await execFileAsync("git", ["-C", root, "init", "--bare", "-q", remote]);

  await writeFile(join(root, "package.json"), `${JSON.stringify({
    name: "@ngelik/brain-hands",
    version,
    repository: { type: "git", url: publicRepository },
    scripts: {
      test: "echo test",
      typecheck: "echo typecheck",
      "release:e2e": "echo release:e2e",
      build: "echo build",
      "validate-release": "node scripts/validate-release.mjs",
    },
  }, null, 2)}\n`);
  await writeFile(join(root, "package-lock.json"), `${JSON.stringify({
    name: "@ngelik/brain-hands",
    version,
    lockfileVersion: 3,
    packages: { "": { version } },
  }, null, 2)}\n`);
  await mkdir(join(root, ".codex-plugin"), { recursive: true });
  await writeFile(join(root, ".codex-plugin", "plugin.json"), `${JSON.stringify({ version }, null, 2)}\n`);

  const skillSource = join(projectRoot, ".agents", "skills", "brain-hands", "SKILL.md");
  const skill = (await readFile(skillSource, "utf8")).replace(
    /(^\s+codex_flow:\s*")[^"]+("\s*$)/mu,
    `$1^${version}$2`,
  );
  await mkdir(join(root, ".agents", "skills", "brain-hands", "scripts"), { recursive: true });
  await writeFile(join(root, ".agents", "skills", "brain-hands", "SKILL.md"), skill);
  await copyFile(
    join(projectRoot, ".agents", "skills", "brain-hands", "scripts", "version-compatibility.mjs"),
    join(root, ".agents", "skills", "brain-hands", "scripts", "version-compatibility.mjs"),
  );
  await mkdir(join(root, "scripts"), { recursive: true });
  for (const file of ["release.sh", "release-version.mjs", "validate-release.mjs"]) {
    await copyFile(join(projectRoot, "scripts", file), join(root, "scripts", file));
  }
  await chmod(join(root, "scripts", "release.sh"), 0o755);
  await mkdir(join(root, "dist"), { recursive: true });
  await writeFile(join(root, "dist", "cli.js"), `process.stdout.write("${version}\\n");\n`);

  await git(root, "add", "-A");
  await git(root, "commit", "-m", "chore: initial fixture");
  await git(root, "remote", "add", "origin", publicRepository);
  await git(root, "config", `url.${remote}.insteadOf`, publicRepository);
  await git(root, "push", "-u", "origin", "main");
  return { root, remote, pushLog };
}

async function createStubs(options: StubOptions = {}): Promise<StubBundle> {
  const dir = await mkdtemp(join(tmpdir(), "bh-release-stubs-"));
  cleanupPaths.push(dir);
  const npmLog = join(dir, "npm.log");
  const npmCwdLog = join(dir, "npm-cwd.log");
  const published = join(dir, "published");
  await writeFile(join(dir, "npm"), `#!/bin/sh
echo "$@" >> "${npmLog}"
printf '%s\n' "$PWD" >> "${npmCwdLog}"
case "$1" in
  run)
    if [ "$2" = "verify:funnel" ]; then exit "\${VERIFY_FUNNEL_STATUS:-0}"; fi
    exit 0
    ;;
  pack) exit 0 ;;
  whoami) printf "release-bot" ;;
  view)
    if [ -f "${published}" ]; then printf "%s" "\${2##*@}"; exit 0; fi
    echo "npm ERR! code E404" >&2
    exit 1
    ;;
  publish)
    if [ "\${ALLOW_PUBLISH:-0}" -ne 1 ]; then
      echo "unexpected npm publish" >&2
      exit 97
    fi
    : > "${published}"
    ;;
esac
`);
  await writeFile(join(dir, "curl"), `#!/bin/sh
printf '%s' '{"id":"ngelik/brain-hands/brain-hands","source":"ngelik/brain-hands","slug":"brain-hands","files":[{"path":"SKILL.md","contents":"ok"}]}'
`);
  for (const command of ["npm", "curl"]) await chmod(join(dir, command), 0o755);

  return {
    PATH: `${dir}:${process.env.PATH ?? ""}`,
    npmLog,
    npmCwdLog,
    env: {
      VERIFY_FUNNEL_STATUS: String(options.verifyFunnelStatus ?? 0),
      ALLOW_PUBLISH: options.allowPublish ? "1" : "0",
    },
  };
}

function runRelease(
  root: string,
  version: string,
  stubs: StubBundle,
  options: { cwd?: string; script?: string } = {},
) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(options.script ?? join(root, "scripts", "release.sh"), [version], {
      cwd: options.cwd ?? root,
      env: { ...process.env, ...stubs.env, PATH: stubs.PATH },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function allowRemotePush(remote: string, pushLog: string, allowed: boolean) {
  const hook = join(remote, "hooks", "pre-receive");
  await writeFile(hook, `#!/bin/sh
printf 'attempt\\n' >> "${pushLog}"
exit ${allowed ? 0 : 1}
`);
  await chmod(hook, 0o755);
}

afterEach(async () => {
  await Promise.all(cleanupPaths.map((path) => rm(path, { recursive: true, force: true })));
  cleanupPaths.length = 0;
});

describe("scripts/release.sh", () => {
  it("rejects missing, extra, and non-canonical versions", async () => {
    const fixture = await createFixture();
    const stubs = await createStubs();
    for (const args of [[], ["0.2.1", "extra"], ["v0.2.1"], ["01.2.1"], ["0.2.1-beta.1"]]) {
      const result = await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
        const child = spawn(releaseScript, args, {
          cwd: fixture.root,
          env: { ...process.env, ...stubs.env, PATH: stubs.PATH },
          stdio: ["ignore", "ignore", "pipe"],
        });
        let stderr = "";
        child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
        child.on("error", reject);
        child.on("close", (code) => resolve({ code, stderr }));
      });
      expect(result.code).not.toBe(0);
    }
  });

  it("synchronizes, validates, tags, and atomically dispatches without npm publication", async () => {
    const fixture = await createFixture();
    const stubs = await createStubs();
    const result = await runRelease(fixture.root, "0.2.1", stubs);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("Release v0.2.1 dispatched");
    expect(await git(fixture.root, "cat-file", "-t", "refs/tags/v0.2.1")).toBe("tag");
    expect(await git(fixture.root, "rev-parse", "refs/tags/v0.2.1^{commit}")).toBe(await git(fixture.root, "rev-parse", "HEAD"));
    expect(await git(fixture.root, "rev-parse", "origin/main")).toBe(await git(fixture.root, "rev-parse", "HEAD"));
    expect(await readFile(releaseScript, "utf8")).toContain(
      'git -C "$REPO_ROOT" push --atomic "$ORIGIN_NAME"',
    );
    const npmCommands = (await readFile(stubs.npmLog, "utf8")).trim().split("\n");
    expect(npmCommands).toEqual([
      "run verify:funnel",
      "pack --dry-run --json --ignore-scripts",
    ]);
    expect(npmCommands).not.toContain("run build");
    expect(npmCommands).not.toContain("run typecheck");
    expect(npmCommands.join("\n")).not.toMatch(/whoami|view|publish|otp/i);

    const releaseSource = await readFile(releaseScript, "utf8");
    expect(releaseSource.match(/^run_release_gates\s*$/gmu)).toHaveLength(1);
  });

  it("runs release gates from the release repository when invoked by absolute path elsewhere", async () => {
    const fixture = await createFixture();
    const decoy = await createFixture();
    const stubs = await createStubs();
    const decoyHead = await git(decoy.root, "rev-parse", "HEAD");
    const decoyRemoteHead = await git(decoy.root, "rev-parse", "origin/main");
    const decoyFiles = await Promise.all(
      [
        "package.json",
        "package-lock.json",
        ".codex-plugin/plugin.json",
        ".agents/skills/brain-hands/SKILL.md",
      ].map((file) => readFile(join(decoy.root, file), "utf8")),
    );

    const result = await runRelease(fixture.root, "0.2.1", stubs, {
      cwd: decoy.root,
      script: join(fixture.root, "scripts", "release.sh"),
    });

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("Release v0.2.1 dispatched");
    const fixtureRoot = await git(fixture.root, "rev-parse", "--show-toplevel");
    expect((await readFile(stubs.npmCwdLog, "utf8")).trim().split("\n"))
      .toEqual(Array(2).fill(fixtureRoot));
    expect(await git(fixture.root, "cat-file", "-t", "refs/tags/v0.2.1")).toBe("tag");
    expect(await git(fixture.root, "rev-parse", "origin/main"))
      .toBe(await git(fixture.root, "rev-parse", "HEAD"));
    expect(await git(fixture.root, "ls-remote", "--tags", "origin", "refs/tags/v0.2.1"))
      .toContain("refs/tags/v0.2.1");
    expect(await git(decoy.root, "rev-parse", "HEAD")).toBe(decoyHead);
    expect(await git(decoy.root, "rev-parse", "origin/main")).toBe(decoyRemoteHead);
    expect(await git(decoy.root, "tag", "--list")).toBe("");
    expect(await git(decoy.root, "ls-remote", "--tags", "origin")).toBe("");
    expect(await git(decoy.root, "status", "--short")).toBe("");
    await expect(Promise.all(
      [
        "package.json",
        "package-lock.json",
        ".codex-plugin/plugin.json",
        ".agents/skills/brain-hands/SKILL.md",
      ].map((file) => readFile(join(decoy.root, file), "utf8")),
    )).resolves.toEqual(decoyFiles);
  });

  it("runs the canonical funnel before creating the release commit", async () => {
    const fixture = await createFixture();
    const stubs = await createStubs({ verifyFunnelStatus: 9 });
    const before = await git(fixture.root, "rev-parse", "HEAD");
    const result = await runRelease(fixture.root, "0.2.1", stubs);
    expect(result.code).not.toBe(0);
    expect(await git(fixture.root, "rev-parse", "HEAD")).toBe(before);
    expect(await git(fixture.root, "tag", "--list", "v0.2.1")).toBe("");
    expect(await readFile(stubs.npmLog, "utf8")).toContain("run verify:funnel");
  });

  it("uses one funnel and lifecycle-suppressed package inspection without duplicate gates", async () => {
    const source = await readFile(releaseScript, "utf8");
    const releaseGates = /^run_release_gates\(\) \{\n(?<body>[\s\S]*?)^\}/mu.exec(source)?.groups?.body;
    expect(releaseGates).toBeDefined();

    const commands = releaseGates
      ?.split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    expect(commands).toEqual([
      "npm run verify:funnel",
      "npm pack --dry-run --json --ignore-scripts",
    ]);
  });

  it("resumes an exact local release commit and tag after an atomic push failure", async () => {
    const fixture = await createFixture();
    const stubs = await createStubs();
    await allowRemotePush(fixture.remote, fixture.pushLog, false);
    const failed = await runRelease(fixture.root, "0.2.1", stubs);
    expect(failed.code).not.toBe(0);
    const commandsAfterFailure = (await readFile(stubs.npmLog, "utf8")).trim().split("\n");
    expect(commandsAfterFailure).toEqual([
      "run verify:funnel",
      "pack --dry-run --json --ignore-scripts",
    ]);
    expect(await git(fixture.root, "cat-file", "-t", "refs/tags/v0.2.1")).toBe("tag");
    expect(await git(fixture.root, "rev-list", "--count", "origin/main..HEAD")).toBe("1");
    expect((await readFile(fixture.pushLog, "utf8")).trim()).toBe("attempt");

    const beforeRemote = await git(fixture.root, "rev-parse", "origin/main");
    await allowRemotePush(fixture.remote, fixture.pushLog, true);
    stubs.env.VERIFY_FUNNEL_STATUS = "9";
    await writeFile(stubs.npmLog, "");
    await writeFile(fixture.pushLog, "");
    const gateFailed = await runRelease(fixture.root, "0.2.1", stubs);
    expect(gateFailed.code).not.toBe(0);
    expect(await readFile(fixture.pushLog, "utf8")).toBe("");
    expect(await git(fixture.root, "rev-parse", "origin/main")).toBe(beforeRemote);
    expect(await git(fixture.root, "ls-remote", "--tags", "origin", "refs/tags/v0.2.1")).toBe("");
    expect((await readFile(stubs.npmLog, "utf8")).trim().split("\n")).toEqual([
      "run verify:funnel",
    ]);

    stubs.env.VERIFY_FUNNEL_STATUS = "0";
    await writeFile(stubs.npmLog, "");
    const resumed = await runRelease(fixture.root, "0.2.1", stubs);
    expect(resumed.code, resumed.stderr).toBe(0);
    expect((await readFile(stubs.npmLog, "utf8")).trim().split("\n")).toEqual([
      "run verify:funnel",
      "pack --dry-run --json --ignore-scripts",
    ]);
    expect((await readFile(fixture.pushLog, "utf8")).trim()).toBe("attempt");
    expect(await git(fixture.root, "rev-parse", "origin/main")).toBe(await git(fixture.root, "rev-parse", "HEAD"));
    expect(await git(fixture.root, "ls-remote", "--tags", "origin", "refs/tags/v0.2.1")).toContain(
      "refs/tags/v0.2.1",
    );
  });

  it("reports an already-dispatched matching release without mutation", async () => {
    const fixture = await createFixture();
    const stubs = await createStubs();
    const first = await runRelease(fixture.root, "0.2.1", stubs);
    expect(first.code, first.stderr).toBe(0);
    const head = await git(fixture.root, "rev-parse", "HEAD");
    const repeated = await runRelease(fixture.root, "0.2.1", stubs);
    expect(repeated.code).toBe(0);
    expect(repeated.stdout).toContain("already dispatched");
    expect(await git(fixture.root, "rev-parse", "HEAD")).toBe(head);
  });

  it("rejects dirty, wrong-branch, and conflicting-tag states", async () => {
    const dirty = await createFixture();
    const dirtyStubs = await createStubs();
    await writeFile(join(dirty.root, "untracked.txt"), "dirty\n");
    expect((await runRelease(dirty.root, "0.2.1", dirtyStubs)).code).not.toBe(0);

    const branch = await createFixture();
    const branchStubs = await createStubs();
    await git(branch.root, "switch", "-c", "feature");
    expect((await runRelease(branch.root, "0.2.1", branchStubs)).code).not.toBe(0);

    const tagged = await createFixture();
    const taggedStubs = await createStubs();
    await git(tagged.root, "tag", "v0.2.1");
    expect((await runRelease(tagged.root, "0.2.1", taggedStubs)).code).not.toBe(0);
  });
});
