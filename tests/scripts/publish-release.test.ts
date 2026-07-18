import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

type CommandResult = { status: number; stdout: string; stderr: string };
type CommandCall = { command: string; args: string[]; cwd: string };

const root = process.cwd();
const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { version: string };
const version = packageJson.version;
const tag = `v${version}`;
const repository = "ngelik/brain-hands";
const commit = "973fe6408bce08c5279af340e530963990ffc626";
const integrity = "sha512-test-integrity";

async function loadPublisher() {
  return import("../../scripts/publish-release.mjs");
}

function createRunner(registryResults: CommandResult[]) {
  const calls: CommandCall[] = [];
  let registryIndex = 0;
  const runCommand = async (command: string, args: string[], options: { cwd: string }): Promise<CommandResult> => {
    calls.push({ command, args, cwd: options.cwd });
    if (args[0] === "pack") {
      const destination = args[args.indexOf("--pack-destination") + 1];
      await writeFile(join(destination, `ngelik-brain-hands-${version}.tgz`), "artifact");
      return {
        status: 0,
        stderr: "",
        stdout: JSON.stringify([{
          id: `@ngelik/brain-hands@${version}`,
          name: "@ngelik/brain-hands",
          version,
          filename: `ngelik-brain-hands-${version}.tgz`,
          integrity,
        }]),
      };
    }
    if (args[0] === "view") {
      const result = registryResults[Math.min(registryIndex, registryResults.length - 1)];
      registryIndex += 1;
      return result;
    }
    if (args[0] === "publish") return { status: 0, stdout: `+ @ngelik/brain-hands@${version}`, stderr: "" };
    throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
  };
  return { calls, runCommand };
}

const absent: CommandResult = { status: 1, stdout: "", stderr: "npm ERR! code E404" };
const matching: CommandResult = {
  status: 0,
  stderr: "",
  stdout: JSON.stringify({ version, "dist.integrity": integrity }),
};

describe("publish-release", () => {
  it("packs once and publishes that exact tarball when the version is absent", async () => {
    const { publishRelease } = await loadPublisher();
    const runner = createRunner([absent, matching]);
    const result = await publishRelease({
      root,
      tag,
      repository,
      commit,
      runCommand: runner.runCommand,
      sleep: async () => {},
      delaysMs: [0],
    });

    expect(result).toMatchObject({
      version,
      tag,
      commit,
      integrity,
      published: true,
      registryVerified: true,
    });
    const packs = runner.calls.filter((call) => call.args[0] === "pack");
    expect(packs).toHaveLength(1);
    expect(packs[0]?.args).toEqual([
      "pack", "--json", "--ignore-scripts", "--pack-destination", expect.any(String),
    ]);
    const publish = runner.calls.find((call) => call.args[0] === "publish");
    expect(publish?.args).toEqual(["publish", `./ngelik-brain-hands-${version}.tgz`, "--access", "public"]);
  });

  it("skips republishing when registry integrity already matches", async () => {
    const { publishRelease } = await loadPublisher();
    const runner = createRunner([matching]);
    const result = await publishRelease({
      root, tag, repository, commit,
      runCommand: runner.runCommand,
      sleep: async () => {},
      delaysMs: [0],
    });
    expect(result.published).toBe(false);
    expect(runner.calls.some((call) => call.args[0] === "publish")).toBe(false);
  });

  it("fails closed when an existing version has different integrity", async () => {
    const { publishRelease } = await loadPublisher();
    const runner = createRunner([{
      status: 0,
      stderr: "",
      stdout: JSON.stringify({ version, "dist.integrity": "sha512-conflict" }),
    }]);
    await expect(publishRelease({
      root, tag, repository, commit,
      runCommand: runner.runCommand,
      sleep: async () => {},
      delaysMs: [0],
    })).rejects.toThrow("registry integrity does not match");
  });

  it("fails closed on registry errors other than an explicit 404", async () => {
    const { publishRelease } = await loadPublisher();
    const runner = createRunner([{ status: 1, stdout: "", stderr: "npm ERR! code E503" }]);
    await expect(publishRelease({
      root, tag, repository, commit,
      runCommand: runner.runCommand,
      sleep: async () => {},
      delaysMs: [0],
    })).rejects.toThrow("npm registry query failed");
    expect(runner.calls.some((call) => call.args[0] === "publish")).toBe(false);
  });

  it("retries delayed registry propagation after publication", async () => {
    const { publishRelease } = await loadPublisher();
    const runner = createRunner([absent, absent, matching]);
    const sleeps: number[] = [];
    const result = await publishRelease({
      root, tag, repository, commit,
      runCommand: runner.runCommand,
      sleep: async (delay: number) => { sleeps.push(delay); },
      delaysMs: [0, 20],
    });
    expect(result.registryVerified).toBe(true);
    expect(sleeps).toEqual([20]);
  });

  it("does not reference npm tokens, OTPs, or skills.sh credentials", async () => {
    const source = await import("node:fs/promises").then(({ readFile }) =>
      readFile(join(root, "scripts", "publish-release.mjs"), "utf8"));
    expect(source).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN|--otp|VERCEL_OIDC_TOKEN|skills\.sh/i);
  });
});
