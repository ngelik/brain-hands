import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { assertApprovedCommand, assertLocalVerificationCommand } from "../../src/core/command.js";

let worktree: string | null = null;

afterEach(async () => {
  if (worktree) {
    await rm(worktree, { recursive: true, force: true });
    worktree = null;
  }
});

describe("assertApprovedCommand", () => {
  it("accepts a direct argv vector", async () => {
    worktree = await mkdtemp(join(tmpdir(), "brain-hands-policy-"));
    expect(() => assertApprovedCommand(["npm", "test", "--", "tests/unit.test.ts"], worktree!)).not.toThrow();
  });

  it("accepts JavaScript syntax in a direct Node eval argument without a shell", async () => {
    worktree = await mkdtemp(join(tmpdir(), "brain-hands-policy-"));
    expect(() => assertApprovedCommand([
      "node",
      "-e",
      "const value = `safe`; if (value !== 'safe') process.exit(1);",
    ], worktree!)).not.toThrow();
  });

  it.each([
    ["shell composition", ["npm", "test;", "echo", "bad"]],
    ["redirection", ["npm", "test", ">", "/tmp/out"]],
    ["command substitution", ["npm", "test", "$(echo", "bad)"]],
    ["shell executable", ["sh", "-c", "npm test"]],
    ["sudo", ["sudo", "npm", "test"]],
    ["rm", ["rm", "-rf", "build"]],
    ["rmdir", ["rmdir", "build"]],
    ["mkfs", ["mkfs", "/dev/disk"]],
    ["dd", ["dd", "if=input", "of=output"]],
    ["absolute target", ["npm", "test", "/tmp/out"]],
    ["path traversal", ["npm", "test", "../outside.test.ts"]],
    ["prefix option traversal", ["npm", "test", "--prefix=../outside"]],
    ["git dir option traversal", ["git", "--git-dir=../outside", "status"]],
    ["C option traversal", ["git", "-C", "../outside", "status"]],
    ["attached C option traversal", ["git", "-C../outside", "status"]],
    ["equals C option traversal", ["git", "-C=../outside", "status"]],
  ] as Array<[string, string[]]>)
  ("rejects %s", (_label, argv) => {
    expect(() => assertApprovedCommand(argv, worktree ?? process.cwd())).toThrow();
  });

  it("rejects an empty vector", () => {
    expect(() => assertApprovedCommand([])).toThrow(/empty/i);
  });

  it.each([
    ["git push", ["git", "push", "origin", "main"]],
    ["git push with -C", ["git", "-C", "worktree", "push", "origin", "main"]],
    ["git ls-remote", ["git", "ls-remote", "origin"]],
    ["git archive", ["git", "archive", "--remote=origin", "HEAD"]],
    ["git remote", ["git", "remote", "-v"]],
    ["gh issue create", ["gh", "issue", "create", "--title", "x"]],
    ["curl", ["curl", "https://example.com"]],
    ["npm publish", ["npm", "publish"]],
    ["npm install", ["npm", "install", "left-pad"]],
    ["pnpm dlx", ["pnpm", "dlx", "tool"]],
    ["yarn fetch", ["yarn", "fetch"]],
    ["npx", ["npx", "tool"]],
    ["npm i", ["npm", "i", "left-pad"]],
    ["npm pack", ["npm", "pack"]],
    ["npm audit", ["npm", "audit"]],
    ["pnpm in", ["pnpm", "in", "left-pad"]],
    ["npm x", ["npm", "x", "tool"]],
    ["npm run-script", ["npm", "run-script", "test"]],
    ["npm up", ["npm", "up"]],
    ["npm info", ["npm", "info", "left-pad"]],
    ["npm list", ["npm", "list"]],
    ["npm uninstall", ["npm", "uninstall", "left-pad"]],
    ["npm fund", ["npm", "fund"]],
    ["bun install", ["bun", "install"]],
    ["corepack", ["corepack", "prepare", "pnpm@latest"]],
    ["pip install", ["pip", "install", "requests"]],
    ["cargo fetch", ["cargo", "fetch"]],
    ["git upload-pack", ["git", "upload-pack", "repo"]],
  ] as Array<[string, string[]]>)
  ("rejects local remote command %s", (_label, argv) => {
    expect(() => assertLocalVerificationCommand(argv, worktree ?? process.cwd())).toThrow();
  });

  it("still accepts a local git status check", () => {
    expect(() => assertLocalVerificationCommand(["git", "status", "--short"], worktree ?? process.cwd())).not.toThrow();
  });

  it("still accepts direct safe test commands", () => {
    expect(() => assertLocalVerificationCommand(["npm", "test", "--", "tests/unit.test.ts"], worktree ?? process.cwd())).not.toThrow();
    expect(() => assertLocalVerificationCommand(["cargo", "test"], worktree ?? process.cwd())).not.toThrow();
    expect(() => assertLocalVerificationCommand(["bun", "test"], worktree ?? process.cwd())).not.toThrow();
  });
});
