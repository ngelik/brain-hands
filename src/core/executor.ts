import { execa } from "execa";
import {
  currentExecutionAuthority,
  recordActiveExecutionChild,
  withCurrentExecutionEffect,
} from "./execution-context.js";

export interface RunCommandInput {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  stdin?: string;
  onStarted?: (process: { pid: number | null }) => void | Promise<void>;
  onStdoutChunk?: (chunk: string) => void | Promise<void>;
  onHeartbeat?: (process: { pid: number | null }) => void | Promise<void>;
  heartbeatMs?: number;
}

export interface CommandResult {
  command: string;
  args: string[];
  exitCode: number | null;
  stdout: string;
  stderr: string;
  failed: boolean;
  timedOut: boolean;
  errorCode?: string;
  errorMessage?: string;
  signal?: string | null;
}

export interface ToolCheck {
  command: string;
  args: string[];
  available: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export function assertCommandProcessTreeSupport(platform = process.platform): void {
  if (platform === "win32" && currentExecutionAuthority()) {
    throw new Error("Approved command execution is unsupported on Windows until Job Object process-tree proof is available");
  }
}

function processGroupIsLive(pid: number): boolean {
  if (process.platform === "win32") return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function terminateOwnedProcessGroup(pid: number | null): Promise<void> {
  if (pid === null || process.platform === "win32" || !processGroupIsLive(pid)) return;
  try { process.kill(-pid, "SIGTERM"); } catch { /* probe below is authoritative */ }
  const deadline = Date.now() + 500;
  while (Date.now() < deadline && processGroupIsLive(pid)) {
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 20));
  }
  if (processGroupIsLive(pid)) {
    try { process.kill(-pid, "SIGKILL"); } catch { /* probe below is authoritative */ }
  }
  const killDeadline = Date.now() + 2_000;
  while (Date.now() < killDeadline && processGroupIsLive(pid)) {
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 20));
  }
  if (processGroupIsLive(pid)) throw new Error(`Command process group ${pid} remains live after termination`);
}

async function runCommandUnsafe(input: RunCommandInput): Promise<CommandResult> {
  let callbackQueue = Promise.resolve();
  let heartbeat: NodeJS.Timeout | undefined;
  let spawnedPid: number | null = null;
  const enqueue = (callback: (() => void | Promise<void>) | undefined): void => {
    if (!callback) return;
    callbackQueue = callbackQueue.then(callback).catch(() => undefined);
  };
  try {
    const subprocess = execa(input.command, input.args, {
      cwd: input.cwd,
      env: input.env,
      input: input.stdin,
      reject: false,
      timeout: input.timeoutMs,
      detached: process.platform !== "win32",
    });
    const pid = subprocess.pid ?? null;
    spawnedPid = pid;
    try {
      await recordActiveExecutionChild(pid);
    } catch (error) {
      if (process.platform !== "win32" && pid !== null) {
        try { process.kill(-pid, "SIGKILL"); } catch { subprocess.kill("SIGKILL"); }
      } else {
        subprocess.kill("SIGKILL");
      }
      await subprocess.catch(() => undefined);
      await terminateOwnedProcessGroup(pid);
      throw error;
    }
    enqueue(input.onStarted ? () => input.onStarted!({ pid }) : undefined);
    if (input.onStdoutChunk && subprocess.stdout) {
      subprocess.stdout.on("data", (chunk: Buffer | string) => {
        const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
        enqueue(() => input.onStdoutChunk!(text));
      });
    }
    if (input.onHeartbeat && input.heartbeatMs !== undefined && input.heartbeatMs > 0) {
      heartbeat = setInterval(() => enqueue(() => input.onHeartbeat!({ pid })), input.heartbeatMs);
      heartbeat.unref();
    }
    const result = await subprocess;
    // Commands may fork and let their wrapper exit. Runtime-owned POSIX groups
    // are never allowed to outlive the invocation, including timeout/error.
    await terminateOwnedProcessGroup(pid);
    if (heartbeat) clearInterval(heartbeat);
    await callbackQueue;

    return {
      command: input.command,
      args: input.args,
      exitCode: result.exitCode ?? null,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      failed: result.failed,
      timedOut: result.timedOut,
      errorCode: result.code,
      errorMessage: result.shortMessage,
      signal: result.signal ?? null,
    };
  } catch (error: unknown) {
    if (heartbeat) clearInterval(heartbeat);
    await terminateOwnedProcessGroup(spawnedPid).catch(() => undefined);
    await callbackQueue;
    const err = error as {
      code?: string;
      exitCode?: number;
      shortMessage?: string;
      message?: string;
      timedOut?: boolean;
      signal?: string | null;
      stdout?: string;
      stderr?: string;
    };

    return {
      command: input.command,
      args: input.args,
      exitCode: err.exitCode ?? null,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? err.shortMessage ?? err.message ?? "",
      failed: true,
      timedOut: Boolean(err.timedOut),
      errorCode: err.code,
      errorMessage: err.shortMessage ?? err.message,
      signal: err.signal ?? null,
    };
  }
}

export async function runCommand(input: RunCommandInput): Promise<CommandResult> {
  assertCommandProcessTreeSupport();
  return withCurrentExecutionEffect(`command:${input.command}`, () => runCommandUnsafe(input));
}

export async function checkCommand(
  command: string,
  args: string[],
  cwd: string,
): Promise<ToolCheck> {
  const result = await runCommand({
    command,
    args,
    cwd,
    timeoutMs: 15_000,
  });

  return {
    command,
    args,
    available: result.exitCode === 0,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}
