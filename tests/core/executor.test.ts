import { describe, expect, it } from "vitest";
import { assertCommandProcessTreeSupport, checkCommand, runCommand } from "../../src/core/executor.js";
import { runWithExecutionAuthority } from "../../src/core/execution-context.js";

describe("runCommand", () => {
  it("fails approved Windows command execution before spawning", async () => {
    await runWithExecutionAuthority({
      claim: { runDir: "/run", token: "token", epoch: 1, invocationId: "test" },
      assert: async () => {}, beginEffect: async () => "effect",
      recordEffectChild: async () => {}, endEffect: async () => {},
    }, async () => {
      expect(() => assertCommandProcessTreeSupport("win32"))
        .toThrow(/unsupported on Windows.*Job Object/i);
    });
  });
  it("captures stdout, stderr, and exit code", async () => {
    const result = await runCommand({
      command: process.execPath,
      args: ["-e", "console.log('hello')"],
      cwd: process.cwd(),
      timeoutMs: 10_000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hello");
    expect(result.stderr).toBe("");
  });

  it("returns non-zero exit code without throwing", async () => {
    const result = await runCommand({
      command: process.execPath,
      args: ["-e", "process.exit(7)"],
      cwd: process.cwd(),
      timeoutMs: 10_000,
    });

    expect(result.exitCode).toBe(7);
  });

  it("returns structured metadata when the command is missing", async () => {
    const result = await runCommand({
      command: "definitely-not-a-real-command",
      args: [],
      cwd: process.cwd(),
      timeoutMs: 10_000,
    });

    expect(result.failed).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(result.timedOut).toBe(false);
    expect(result.errorCode).toBe("ENOENT");
    expect(result.errorMessage).toContain("ENOENT");
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  it("preserves output and timeout status when process times out", async () => {
    const result = await runCommand({
      command: process.execPath,
      args: [
        "-e",
        "process.stdout.write('partial'); setTimeout(() => {}, 1000);",
      ],
      cwd: process.cwd(),
      timeoutMs: 100,
    });

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(result.stdout).toContain("partial");
  });

  it.skipIf(process.platform === "win32")("terminates a timed-out command's entire owned process group", async () => {
    let leaderPid: number | null = null;
    const result = await runCommand({
      command: process.execPath,
      args: ["-e", [
        "const { spawn } = require('node:child_process')",
        "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })",
        "child.unref()",
        "setInterval(() => {}, 1000)",
      ].join("; ")],
      cwd: process.cwd(),
      timeoutMs: 100,
      onStarted: ({ pid }) => { leaderPid = pid; },
    });

    expect(result.timedOut).toBe(true);
    expect(leaderPid).not.toBeNull();
    expect(() => process.kill(-leaderPid!, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
  });

  it("reports child start, stdout chunks, and heartbeats before completion", async () => {
    const lifecycle: string[] = [];
    const result = await runCommand({
      command: process.execPath,
      args: ["-e", "process.stdout.write('started\\n'); setTimeout(() => process.exit(0), 500)"],
      cwd: process.cwd(),
      timeoutMs: 10_000,
      heartbeatMs: 20,
      onStarted: ({ pid }) => { lifecycle.push(`started:${pid}`); },
      onStdoutChunk: (chunk) => { lifecycle.push(`stdout:${chunk.trim()}`); },
      onHeartbeat: ({ pid }) => { lifecycle.push(`heartbeat:${pid}`); },
    });

    expect(lifecycle.some((entry) => entry.startsWith("started:"))).toBe(true);
    expect(lifecycle).toContain("stdout:started");
    expect(lifecycle.some((entry) => entry.startsWith("heartbeat:"))).toBe(true);
    expect(result).toMatchObject({ exitCode: 0 });
  });
});

describe("checkCommand", () => {
  it("marks existing commands available", async () => {
    const check = await checkCommand(process.execPath, ["--version"], process.cwd());

    expect(check.available).toBe(true);
    expect(check.exitCode).toBe(0);
  });
});
