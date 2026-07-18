import { basename, isAbsolute, relative, resolve } from "node:path";

/**
 * Parse the legacy command-string representation. New workflow plans should
 * use executable-plus-arguments vectors and pass them through
 * assertApprovedCommand directly.
 */
export function splitCommand(command: string): { executable: string; args: string[] } {
  const parts: string[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;
  let tokenStarted = false;

  for (let i = 0; i < command.length; i += 1) {
    const char = command[i];

    if (quote !== null) {
      if (char === "\\" && command[i + 1] === quote) {
        throw new Error("Unsupported escaped quote in quoted argument");
      }

      if (char === quote) {
        quote = null;
        tokenStarted = true;
        continue;
      }

      current += char;
      continue;
    }

    if (char === "\"" || char === "'") {
      quote = char;
      tokenStarted = true;
      continue;
    }

    if (/\s/.test(char)) {
      if (tokenStarted) {
        parts.push(current);
        current = "";
        tokenStarted = false;
      }

      continue;
    }

    if (char === "\\" && command[i + 1] && /["'\\\s]/.test(command[i + 1])) {
      throw new Error("Unsupported escape syntax in verification command");
    }

    current += char;
    tokenStarted = true;
  }

  if (quote !== null) {
    throw new Error("Unterminated quoted argument in verification command");
  }

  if (tokenStarted) {
    parts.push(current);
  }

  const executable = parts[0];
  const args = parts.slice(1);

  if (!executable) {
    throw new Error("Verification command is empty");
  }

  return { executable, args };
}

const SHELL_EXECUTABLES = new Set([
  "sh",
  "bash",
  "zsh",
  "fish",
  "dash",
  "ksh",
  "csh",
  "tcsh",
  "cmd",
  "cmd.exe",
  "powershell",
  "powershell.exe",
  "pwsh",
  "pwsh.exe",
]);

const FORBIDDEN_EXECUTABLES = new Set([
  "sudo",
  "rm",
  "rmdir",
  "mkfs",
  "dd",
]);

const LOCAL_NETWORK_EXECUTABLES = new Set([
  "gh",
  "npx",
  "curl",
  "wget",
  "ssh",
  "scp",
  "sftp",
  "ftp",
  "nc",
  "netcat",
  "telnet",
]);

const LOCAL_REMOTE_GIT_SUBCOMMANDS = new Set([
  "push",
  "remote",
  "fetch",
  "clone",
  "pull",
  "submodule",
  "ls-remote",
  "archive",
  "send-pack",
  "receive-pack",
  "upload-pack",
  "http-fetch",
]);

const LOCAL_REMOTE_PACKAGE_SUBCOMMANDS = new Set([
  "i",
  "in",
  "x",
  "run-script",
  "up",
  "upgrade",
  "info",
  "show",
  "list",
  "install",
  "ci",
  "add",
  "uninstall",
  "remove",
  "fund",
  "update",
  "fetch",
  "exec",
  "dlx",
  "publish",
  "login",
  "logout",
  "access",
  "owner",
  "dist-tag",
  "pack",
  "view",
  "audit",
  "search",
  "ping",
  "outdated",
]);

const LOCAL_REMOTE_BUN_SUBCOMMANDS = new Set([
  "i", "in", "install", "add", "update", "remove", "link", "unlink", "x", "publish",
]);
const LOCAL_REMOTE_PIP_SUBCOMMANDS = new Set(["install", "download", "wheel", "index", "search"]);
const LOCAL_REMOTE_CARGO_SUBCOMMANDS = new Set([
  "add", "install", "update", "fetch", "search", "publish", "yank", "login", "owner",
]);

function normalizedExecutable(value: string): string {
  const name = basename(value).toLowerCase();
  return name.endsWith(".exe") ? name.slice(0, -4) : name;
}

function hasShellComposition(value: string): boolean {
  // These operators have shell meaning even when they occur in an argument.
  // Parentheses by themselves remain valid direct-argv data (for example a
  // Node -e expression); command substitution is explicitly forbidden.
  return /[;|&<>`$\r\n\u0000]/.test(value);
}

const PATH_OPTION_NAMES = new Set([
  "-c",
  "-C",
  "--directory",
  "--prefix",
  "--git-dir",
  "--work-tree",
  "--worktree",
  "--pathspec-from-file",
]);

function optionPathValues(argv: readonly string[]): string[] {
  const values: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith("-C") && token.length > 2 && token[2] !== "=") {
      values.push(token.slice(2));
    }
    const equalsIndex = token.indexOf("=");
    if (equalsIndex > 0 && PATH_OPTION_NAMES.has(token.slice(0, equalsIndex))) {
      values.push(token.slice(equalsIndex + 1));
    }
    if (PATH_OPTION_NAMES.has(token) && argv[index + 1] !== undefined) {
      values.push(argv[index + 1]);
      index += 1;
    }
  }
  return values;
}

/**
 * Validate a frozen executable-plus-arguments vector before it reaches the
 * process runner. This function intentionally accepts argv only: no shell
 * syntax is interpreted or reconstructed here.
 */
export function assertApprovedCommand(
  argv: readonly string[],
  worktreePath = process.cwd(),
): void {
  if (!Array.isArray(argv) || argv.length === 0) {
    throw new Error("Verification command argv must not be empty");
  }

  const worktree = resolve(worktreePath);
  const executable = argv[0];
  if (typeof executable !== "string" || executable.trim() === "") {
    throw new Error("Verification command executable must be non-empty");
  }

  for (const token of argv) {
    if (typeof token !== "string") {
      throw new Error("Verification command arguments must be strings");
    }
    if (hasShellComposition(token)) {
      throw new Error(`Verification command contains forbidden shell syntax: ${token}`);
    }
  }

  const executableName = normalizedExecutable(executable);
  if (SHELL_EXECUTABLES.has(executableName)) {
    throw new Error(`Shell executable is not allowed in verification commands: ${executable}`);
  }
  if (FORBIDDEN_EXECUTABLES.has(executableName)) {
    throw new Error(`Destructive executable is not allowed in verification commands: ${executable}`);
  }

  const pathTokens = [...argv, ...optionPathValues(argv)];
  for (const [index, token] of pathTokens.entries()) {
    if (index > 0 && !token.startsWith("-") && !token.includes("/") && !token.includes("\\")) {
      const tokenName = normalizedExecutable(token);
      if (SHELL_EXECUTABLES.has(tokenName)) {
        throw new Error(`Shell executable is not allowed in verification commands: ${token}`);
      }
      if (FORBIDDEN_EXECUTABLES.has(tokenName)) {
        throw new Error(`Destructive executable is not allowed in verification commands: ${token}`);
      }
    }

    // Windows drive-qualified strings are data when this runner is operating
    // on POSIX (the legacy runner historically preserved them literally).
    // Native absolute paths are still rejected below.
    const absolute = isAbsolute(token);
    if (absolute) {
      throw new Error(`Absolute filesystem targets are not allowed: ${token}`);
    }

    const candidate = resolve(worktree, token);
    const relation = relative(worktree, candidate);
    if (relation === ".." || relation.startsWith(`..${"/"}`) || isAbsolute(relation)) {
      throw new Error(`Verification command path escapes the worktree: ${token}`);
    }
  }
}

/** Apply the stricter no-remote/no-GitHub policy used by local workflow runs. */
export function assertLocalVerificationCommand(
  argv: readonly string[],
  worktreePath = process.cwd(),
): void {
  assertApprovedCommand(argv, worktreePath);
  const executable = normalizedExecutable(argv[0]);
  if (LOCAL_NETWORK_EXECUTABLES.has(executable)) {
    throw new Error(`Network or GitHub executable is not allowed in local verification: ${argv[0]}`);
  }

  if (executable === "git") {
    const subcommand = argv.slice(1).find((token) => LOCAL_REMOTE_GIT_SUBCOMMANDS.has(normalizedExecutable(token)));
    if (subcommand) {
      throw new Error(`Remote Git subcommand is not allowed in local verification: git ${subcommand}`);
    }
  }

  if ((executable === "npm" || executable === "pnpm" || executable === "yarn") &&
      argv.slice(1).some((token) => LOCAL_REMOTE_PACKAGE_SUBCOMMANDS.has(normalizedExecutable(token)))) {
    throw new Error(`Remote package subcommand is not allowed in local verification: ${argv.join(" ")}`);
  }

  if (executable === "corepack") {
    throw new Error(`Package-manager bootstrap is not allowed in local verification: ${argv.join(" ")}`);
  }
  if (executable === "bun" && argv.slice(1).some((token) => LOCAL_REMOTE_BUN_SUBCOMMANDS.has(normalizedExecutable(token)))) {
    throw new Error(`Remote Bun subcommand is not allowed in local verification: ${argv.join(" ")}`);
  }
  if ((executable === "pip" || executable === "pip3") && argv.slice(1).some((token) => LOCAL_REMOTE_PIP_SUBCOMMANDS.has(normalizedExecutable(token)))) {
    throw new Error(`Remote pip subcommand is not allowed in local verification: ${argv.join(" ")}`);
  }
  if (executable === "cargo" && argv.slice(1).some((token) => LOCAL_REMOTE_CARGO_SUBCOMMANDS.has(normalizedExecutable(token)))) {
    throw new Error(`Remote Cargo subcommand is not allowed in local verification: ${argv.join(" ")}`);
  }
}
