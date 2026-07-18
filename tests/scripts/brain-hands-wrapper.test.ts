import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const wrapper = join(root, ".agents", "skills", "brain-hands", "scripts", "brain-hands.mjs");

function runWrapper(args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [wrapper, ...args], {
      cwd: root,
      env: { ...process.env, ...env },
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

describe("brain-hands skill wrapper", () => {
  it("selects a compatible controller for preview without running doctor", async () => {
    const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { version: string };
    const binDir = await mkdtemp(join(tmpdir(), "brain-hands-wrapper-preview-bin-"));
    const doctorMarker = join(binDir, "doctor-called.txt");
    const executable = join(binDir, "brain-hands");
    await writeFile(executable, `#!/bin/sh
if [ "$1" = "--version" ]; then printf '${packageJson.version}\n'; exit 0; fi
if [ "$1" = "doctor" ]; then printf 'called\n' > "$DOCTOR_MARKER"; exit 91; fi
if [ "$1" = "preview" ] && [ "$2" = "--help" ]; then printf 'Usage: brain-hands preview [options]\n'; exit 0; fi
if [ "$1" = "preview" ]; then printf '{"missing_choices":["mode"]}\n'; exit 0; fi
exit 2
`, "utf8");
    await chmod(executable, 0o755);

    const result = await runWrapper(["preview", "--repo", root, "--json"], {
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      DOCTOR_MARKER: doctorMarker,
    });

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ missing_choices: ["mode"] });
    await expect(readFile(doctorMarker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an installed CLI without preview and uses an explicitly allowed checkout controller", async () => {
    const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { version: string };
    const binDir = await mkdtemp(join(tmpdir(), "brain-hands-wrapper-preview-legacy-bin-"));
    const fixtureRoot = await mkdtemp(join(tmpdir(), "brain-hands-wrapper-preview-fallback-"));
    const fixtureScripts = join(fixtureRoot, ".agents", "skills", "brain-hands", "scripts");
    await mkdir(fixtureScripts, { recursive: true });
    await mkdir(join(fixtureRoot, "dist"), { recursive: true });
    await writeFile(join(fixtureScripts, "brain-hands.mjs"), await readFile(wrapper, "utf8"), "utf8");
    await copyFile(join(root, ".agents", "skills", "brain-hands", "SKILL.md"), join(fixtureRoot, ".agents", "skills", "brain-hands", "SKILL.md"));
    await copyFile(join(root, ".agents", "skills", "brain-hands", "scripts", "version-compatibility.mjs"), join(fixtureScripts, "version-compatibility.mjs"));
    await writeFile(join(fixtureRoot, "dist", "cli.js"), `
const args = process.argv.slice(2);
if (args[0] === "--version") process.stdout.write("${packageJson.version}\\n");
if (args[0] === "preview" && args[1] === "--help") { process.stdout.write("Usage: brain-hands preview [options]\\n"); process.exit(0); }
if (args[0] === "preview") process.stdout.write(JSON.stringify({ mode: process.env.BRAIN_HANDS_CONTROLLER_MODE }) + "\\n");
`, "utf8");
    const executable = join(binDir, "brain-hands");
    await writeFile(executable, `#!/bin/sh
if [ "$1" = "--version" ]; then printf '${packageJson.version}\\n'; exit 0; fi
if [ "$1" = "preview" ] && [ "$2" = "--help" ]; then printf 'Usage: brain-hands [options] [command]\\n'; exit 0; fi
if [ "$1" = "preview" ]; then printf "error: unknown command 'preview'\\n" >&2; exit 2; fi
exit 0
`, "utf8");
    await chmod(executable, 0o755);

    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveResult, reject) => {
      const child = spawn(process.execPath, [join(fixtureScripts, "brain-hands.mjs"), "--development-controller", "preview", "--repo", fixtureRoot, "--json"], {
        cwd: fixtureRoot,
        env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
      child.on("error", reject);
      child.on("close", (code) => resolveResult({ code, stdout, stderr }));
    });

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ mode: "development_checkout" });
    expect(result.stderr).toBe("");
  });

  it("forces checkout dist when development controller is explicit even if installed is compatible", async () => {
    const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { version: string };
    const fixtureRoot = await mkdtemp(join(tmpdir(), "brain-hands-wrapper-development-controller-"));
    expect(spawnSync("git", ["init", "-q", fixtureRoot]).status).toBe(0);
    const initialized = await runWrapper(["--development-controller", "init", "--repo", fixtureRoot, "--json"]);
    expect(initialized.code).toBe(0);
    const binDir = await mkdtemp(join(tmpdir(), "brain-hands-wrapper-installed-compatible-"));
    const executable = join(binDir, "brain-hands");
    await writeFile(executable, `#!/bin/sh\nif [ "$1" = "--version" ]; then printf '${packageJson.version}\\n'; exit 0; fi\nprintf '{"mode":"installed"}\\n'\n`, "utf8");
    await chmod(executable, 0o755);

    const result = await runWrapper(["--development-controller", "preview", "--repo", fixtureRoot, "--json"], {
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    });

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).not.toEqual({ mode: "installed" });
  });

  it("reports a missing preview capability when checkout fallback is not authorized", async () => {
    const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { version: string };
    const binDir = await mkdtemp(join(tmpdir(), "brain-hands-wrapper-preview-unsupported-bin-"));
    const executable = join(binDir, "brain-hands");
    await writeFile(executable, `#!/bin/sh
if [ "$1" = "--version" ]; then printf '${packageJson.version}\\n'; exit 0; fi
if [ "$1" = "preview" ] && [ "$2" = "--help" ]; then printf 'Usage: brain-hands [options] [command]\\n'; exit 0; fi
if [ "$1" = "preview" ]; then printf "error: unknown command 'preview'\\n" >&2; exit 2; fi
exit 0
`, "utf8");
    await chmod(executable, 0o755);

    const result = await runWrapper(["preview", "--repo", root, "--json"], {
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("does not support preview");
    expect(result.stderr).toContain("Install a compatible @ngelik/brain-hands package");
  });

  it("accepts a successful discovery boundary from the installed CLI", async () => {
    const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { version: string };
    const binDir = await mkdtemp(join(tmpdir(), "brain-hands-wrapper-discovery-bin-"));
    const executable = join(binDir, "brain-hands");
    await writeFile(executable, `#!/bin/sh
if [ "$1" = "--version" ]; then printf '${packageJson.version}\\n'; exit 0; fi
if [ "$1" = "doctor" ]; then exit 0; fi
printf '{"state":"awaiting_discovery_answer","question_id":"q-001"}\\n'
exit 0
`, "utf8");
    await chmod(executable, 0o755);

    const result = await runWrapper(["run", "Discover first", "--json"], {
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    });

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      state: "awaiting_discovery_answer",
      question_id: "q-001",
    });
    expect(result.stderr).toBe("");
  });

  it("prefers an installed brain-hands and forwards stdio and exit status", async () => {
    const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { version: string };
    const binDir = await mkdtemp(join(tmpdir(), "brain-hands-wrapper-bin-"));
    const marker = join(binDir, "invocation.txt");
    const executable = join(binDir, "brain-hands");
    await writeFile(executable, `#!/bin/sh
if [ "$1" = "--version" ]; then printf '${packageJson.version}\\n'; exit 0; fi
if [ "$1" = "doctor" ]; then exit 0; fi
printf '%s\\n' "$*" > "$WRAPPER_MARKER"
printf 'installed-output\\n'
exit 7
`, "utf8");
    await chmod(executable, 0o755);

    const result = await runWrapper(["status", "--run", "example"], {
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      WRAPPER_MARKER: marker,
    });

    expect(result.code).toBe(7);
    expect(result.stdout).toContain("installed-output");
    expect(await readFile(marker, "utf8")).toContain("status --run example");
  });

  it("requires the explicit development option before using checkout dist", async () => {
    const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { version: string };
    const fixtureRoot = await mkdtemp(join(tmpdir(), "brain-hands-wrapper-checkout-"));
    const fixtureScripts = join(fixtureRoot, ".agents", "skills", "brain-hands", "scripts");
    await mkdir(fixtureScripts, { recursive: true });
    await mkdir(join(fixtureRoot, "dist"), { recursive: true });
    await writeFile(join(fixtureScripts, "brain-hands.mjs"), await readFile(wrapper, "utf8"), "utf8");
    await copyFile(join(root, ".agents", "skills", "brain-hands", "SKILL.md"), join(fixtureRoot, ".agents", "skills", "brain-hands", "SKILL.md"));
    await copyFile(join(root, ".agents", "skills", "brain-hands", "scripts", "version-compatibility.mjs"), join(fixtureScripts, "version-compatibility.mjs"));
    await writeFile(join(fixtureRoot, "dist", "cli.js"), `
const args = process.argv.slice(2);
if (args[0] === "--version") process.stdout.write("${packageJson.version}\\n");
process.exit(args[0] === "doctor" ? 0 : 0);
`, "utf8");

    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveResult, reject) => {
      const child = spawn(process.execPath, [join(fixtureScripts, "brain-hands.mjs"), "--development-controller", "--version"], {
        cwd: fixtureRoot,
        env: { ...process.env, PATH: "/nonexistent" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
      child.on("error", reject);
      child.on("close", (code) => resolveResult({ code, stdout, stderr }));
    });

    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe(packageJson.version);
  });

  it("uses checkout dist explicitly when the installed version is incompatible", async () => {
    const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { version: string };
    const binDir = await mkdtemp(join(tmpdir(), "brain-hands-wrapper-incompatible-bin-"));
    const fixtureRoot = await mkdtemp(join(tmpdir(), "brain-hands-wrapper-fallback-"));
    const fixtureScripts = join(fixtureRoot, ".agents", "skills", "brain-hands", "scripts");
    await mkdir(fixtureScripts, { recursive: true });
    await mkdir(join(fixtureRoot, "dist"), { recursive: true });
    await writeFile(join(fixtureScripts, "brain-hands.mjs"), await readFile(wrapper, "utf8"), "utf8");
    await copyFile(join(root, ".agents", "skills", "brain-hands", "SKILL.md"), join(fixtureRoot, ".agents", "skills", "brain-hands", "SKILL.md"));
    await copyFile(join(root, ".agents", "skills", "brain-hands", "scripts", "version-compatibility.mjs"), join(fixtureScripts, "version-compatibility.mjs"));
    await writeFile(join(fixtureRoot, "dist", "cli.js"), `
const args = process.argv.slice(2);
if (args[0] === "--version") process.stdout.write("${packageJson.version}\\n");
if (args[0] === "doctor") process.stdout.write("bundled-doctor\\n");
if (args[0] !== "--version" && args[0] !== "doctor") process.stdout.write(JSON.stringify({ args, mode: process.env.BRAIN_HANDS_CONTROLLER_MODE, executable: process.env.BRAIN_HANDS_EXECUTABLE_PATH }) + "\\n");
`, "utf8");
    const executable = join(binDir, "brain-hands");
    await writeFile(executable, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then printf '9.9.9\\n'; exit 0; fi\n", "utf8");
    await chmod(executable, 0o755);

    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveResult, reject) => {
      const child = spawn(process.execPath, [join(fixtureScripts, "brain-hands.mjs"), "--development-controller", "status"], {
        cwd: fixtureRoot,
        env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
      child.on("error", reject);
      child.on("close", (code) => resolveResult({ code, stdout, stderr }));
    });

    expect(result.code).toBe(0);
    const output = JSON.parse(result.stdout.trim()) as { args: string[]; mode: string; executable: string };
    expect(output.args).toEqual(["status"]);
    expect(output.mode).toBe("development_checkout");
    expect(output.executable).toBe(await realpath(join(fixtureRoot, "dist", "cli.js")));
  });

  it("does not silently use checkout dist when no installed command exists", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "brain-hands-wrapper-installed-only-"));
    const fixtureScripts = join(fixtureRoot, ".agents", "skills", "brain-hands", "scripts");
    await mkdir(fixtureScripts, { recursive: true });
    await mkdir(join(fixtureRoot, "dist"), { recursive: true });
    await writeFile(join(fixtureScripts, "brain-hands.mjs"), await readFile(wrapper, "utf8"), "utf8");
    await copyFile(join(root, ".agents", "skills", "brain-hands", "SKILL.md"), join(fixtureRoot, ".agents", "skills", "brain-hands", "SKILL.md"));
    await copyFile(join(root, ".agents", "skills", "brain-hands", "scripts", "version-compatibility.mjs"), join(fixtureScripts, "version-compatibility.mjs"));
    await writeFile(join(fixtureRoot, "dist", "cli.js"), "process.stdout.write('must-not-run\\n')\n", "utf8");

    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveResult, reject) => {
      const child = spawn(process.execPath, [join(fixtureScripts, "brain-hands.mjs"), "status"], {
        cwd: fixtureRoot,
        env: { ...process.env, PATH: "/nonexistent" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
      child.on("error", reject);
      child.on("close", (code) => resolveResult({ code, stdout, stderr }));
    });

    expect(result.code).toBe(1);
    expect(result.stdout).not.toContain("must-not-run");
    expect(result.stderr).toContain("No installed brain-hands executable");
    expect(result.stderr).toContain("--development-controller");
  });

  it("reports an incompatibility when no compatible fallback exists", async () => {
    const binDir = await mkdtemp(join(tmpdir(), "brain-hands-wrapper-incompatible-only-bin-"));
    const fixtureRoot = await mkdtemp(join(tmpdir(), "brain-hands-wrapper-incompatible-only-"));
    const fixtureScripts = join(fixtureRoot, ".agents", "skills", "brain-hands", "scripts");
    await mkdir(fixtureScripts, { recursive: true });
    await writeFile(join(fixtureScripts, "brain-hands.mjs"), await readFile(wrapper, "utf8"), "utf8");
    await copyFile(join(root, ".agents", "skills", "brain-hands", "SKILL.md"), join(fixtureRoot, ".agents", "skills", "brain-hands", "SKILL.md"));
    await copyFile(join(root, ".agents", "skills", "brain-hands", "scripts", "version-compatibility.mjs"), join(fixtureScripts, "version-compatibility.mjs"));
    const executable = join(binDir, "brain-hands");
    await writeFile(executable, "#!/bin/sh\nprintf '9.9.9\\n'\n", "utf8");
    await chmod(executable, 0o755);

    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveResult, reject) => {
      const child = spawn(process.execPath, [join(fixtureScripts, "brain-hands.mjs"), "status"], {
        cwd: fixtureRoot,
        env: { ...process.env, PATH: `${binDir}:/nonexistent` },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
      child.on("error", reject);
      child.on("close", (code) => resolveResult({ code, stdout, stderr }));
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("No compatible brain-hands CLI found");
    expect(result.stderr).toContain("reported incompatible version 9.9.9");
  });
});
