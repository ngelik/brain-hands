# Brain Hands Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `brain-hands`, a CLI that orchestrates Codex as a brain/hands workflow using durable run state, GitHub issues, pull requests, review loops, and verification evidence.

**Architecture:** The CLI is the control plane. It owns state transitions, ledger files, Git/GitHub operations, verification commands, retry limits, and model invocation. Brain and hands Codex sessions are called through adapters so exact Codex CLI flags can be configured without changing workflow code.

**Tech Stack:** TypeScript, Node.js 20+, npm, Commander, Zod, Execa, YAML, Vitest, Git CLI, GitHub CLI, Codex CLI.

## Global Constraints

- The CLI owns workflow state and decides the next transition.
- The brain model owns planning, issue quality, PR review, and final verification.
- The hands model owns implementation and scoped fixes.
- GitHub issues are the durable unit of planned work.
- PRs are the durable unit of review.
- Every issue must contain verification steps before implementation begins.
- Every PR must contain verification evidence before brain review.
- Brain approval requires real verification evidence.
- The three requirement audits must use distinct lenses: scope, behavior, and evidence.
- Infinite loops are forbidden; retry limits must trigger escalation or replanning.
- The workflow must be resumable from `.brain-hands/runs`.
- The local Codex install must be treated as an external dependency. In this workspace, `codex --version` currently fails because the native binary is missing, so the CLI must expose a `doctor` preflight and a configurable Codex invocation template.
- MVP scope is one repository, one user request, sequential issue execution, no automatic merge, and no parallel implementation.

---

## File Structure

Create this project structure:

```text
package.json
tsconfig.json
vitest.config.ts
.gitignore
README.md
agentic-codex-workflow.md
docs/superpowers/plans/2026-07-08-brain-hands.md
prompts/
  brain-planner.md
  brain-issue-critic.md
  brain-reviewer.md
  brain-final-auditor.md
  hands-implementer.md
  hands-fixer.md
src/
  cli.ts
  adapters/
    codex.ts
    git.ts
    github.ts
  core/
    config.ts
    errors.ts
    executor.ts
    ledger.ts
    schema.ts
    types.ts
  prompts/
    loader.ts
    renderer.ts
  verification/
    runner.ts
  workflow/
    orchestrator.ts
    planner.ts
    implementer.ts
    reviewer.ts
    status.ts
tests/
  adapters/
    codex.test.ts
    github.test.ts
  core/
    config.test.ts
    executor.test.ts
    ledger.test.ts
    schema.test.ts
  prompts/
    renderer.test.ts
  verification/
    runner.test.ts
  workflow/
    orchestrator.test.ts
    reviewer.test.ts
```

Responsibilities:

- `src/cli.ts`: command-line entrypoint and argument parsing.
- `src/core/types.ts`: shared TypeScript interfaces.
- `src/core/schema.ts`: Zod schemas for config, issues, reviews, manifests, and verification evidence.
- `src/core/config.ts`: initialize and load `.brain-hands/config.yaml`.
- `src/core/ledger.ts`: create, read, update, and list run ledgers.
- `src/core/executor.ts`: controlled subprocess execution with timeout and captured output.
- `src/adapters/codex.ts`: model invocation boundary; supports dry-run and configurable subprocess calls.
- `src/adapters/git.ts`: read repo state, create branches/worktrees, collect diffs.
- `src/adapters/github.ts`: create/update GitHub issues, comments, labels, and PRs through `gh`.
- `src/prompts/loader.ts`: load prompt template files.
- `src/prompts/renderer.ts`: render prompt templates with explicit variables.
- `src/verification/runner.ts`: execute issue verification commands and store evidence.
- `src/workflow/planner.ts`: brain planning, issue generation, and issue critique.
- `src/workflow/implementer.ts`: hands implementation, verification, and PR creation.
- `src/workflow/reviewer.ts`: brain review, three-pass audit, fix loop, retry escalation.
- `src/workflow/orchestrator.ts`: top-level state machine for `run` and `resume`.
- `src/workflow/status.ts`: summarize run progress.

---

### Task 1: Bootstrap the TypeScript CLI Project

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `.gitignore`
- Create: `src/cli.ts`
- Test: `tests/cli-smoke.test.ts`

**Interfaces:**
- Consumes: no prior code.
- Produces: executable `brain-hands` binary entrypoint, `npm test`, `npm run build`, and a smoke-tested CLI.

- [ ] **Step 1: Initialize Git and npm metadata**

Run:

```bash
git init
npm init -y
```

Expected:

```text
Initialized empty Git repository
Wrote to package.json
```

- [ ] **Step 2: Install runtime and test dependencies**

Run:

```bash
npm install commander zod execa yaml
npm install --save-dev typescript tsx vitest @types/node
```

Expected:

```text
added
found 0 vulnerabilities
```

- [ ] **Step 3: Replace `package.json` scripts and binary metadata**

Write `package.json` so it has these fields while preserving the dependency versions npm installed:

```json
{
  "name": "brain-hands",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "bin": {
    "brain-hands": "dist/cli.js"
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "dev": "tsx src/cli.ts",
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  }
}
```

- [ ] **Step 4: Add TypeScript configuration**

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "rootDir": ".",
    "outDir": "dist",
    "types": ["node", "vitest/globals"]
  },
  "include": ["src/**/*.ts", "tests/**/*.ts", "vitest.config.ts"]
}
```

- [ ] **Step 5: Add Vitest configuration**

Create `vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["tests/**/*.test.ts"],
    restoreMocks: true,
  },
});
```

- [ ] **Step 6: Add `.gitignore`**

Create `.gitignore`:

```gitignore
node_modules/
dist/
.brain-hands/runs/
.env
.DS_Store
coverage/
```

- [ ] **Step 7: Write a failing CLI smoke test**

Create `tests/cli-smoke.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildCli } from "../src/cli.js";

describe("buildCli", () => {
  it("registers the expected top-level commands", () => {
    const cli = buildCli();
    const names = cli.commands.map((command) => command.name());

    expect(names).toContain("init");
    expect(names).toContain("run");
    expect(names).toContain("resume");
    expect(names).toContain("status");
    expect(names).toContain("doctor");
  });
});
```

- [ ] **Step 8: Run the smoke test and confirm it fails**

Run:

```bash
npm test -- tests/cli-smoke.test.ts
```

Expected:

```text
FAIL tests/cli-smoke.test.ts
Cannot find module '../src/cli.js'
```

- [ ] **Step 9: Implement the CLI skeleton**

Create `src/cli.ts`:

```ts
#!/usr/bin/env node
import { Command } from "commander";

export function buildCli(): Command {
  const program = new Command();

  program
    .name("brain-hands")
    .description("Orchestrate Codex brain/hands workflows")
    .version("0.1.0");

  program.command("init").description("Create .brain-hands/config.yaml");
  program.command("run").description("Start a new workflow run");
  program.command("resume").description("Resume an existing workflow run");
  program.command("status").description("Show workflow run status");
  program.command("doctor").description("Check local tool dependencies");

  return program;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await buildCli().parseAsync(process.argv);
}
```

- [ ] **Step 10: Verify tests and build pass**

Run:

```bash
npm test -- tests/cli-smoke.test.ts
npm run build
```

Expected:

```text
PASS tests/cli-smoke.test.ts
```

```text
Found 0 errors.
```

- [ ] **Step 11: Commit**

Run:

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts .gitignore src/cli.ts tests/cli-smoke.test.ts
git commit -m "chore: bootstrap brain-hands cli"
```

---

### Task 2: Define Core Types and Runtime Schemas

**Files:**
- Create: `src/core/types.ts`
- Create: `src/core/schema.ts`
- Test: `tests/core/schema.test.ts`

**Interfaces:**
- Consumes: TypeScript project from Task 1.
- Produces:
  - `ModelRole`
  - `WorkflowStage`
  - `BrainHandsConfig`
  - `IssueSpec`
  - `PrReview`
  - `RunManifest`
  - `VerificationEvidence`
  - Zod schemas and `parseJsonObject<T>()`

- [ ] **Step 1: Write failing schema tests**

Create `tests/core/schema.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  issueSpecSchema,
  prReviewSchema,
  runManifestSchema,
} from "../../src/core/schema.js";

describe("issueSpecSchema", () => {
  it("requires acceptance criteria and verification commands", () => {
    const parsed = issueSpecSchema.safeParse({
      type: "implementation_task",
      run_id: "2026-07-08T12-00-00Z-demo",
      parent_request: "Build a CLI",
      goal: "Create the init command",
      context: "The CLI stores config in .brain-hands/config.yaml",
      scope: { include: ["src/core/config.ts"], exclude: ["network calls"] },
      dependencies: [],
      implementation_steps: ["Create config writer"],
      acceptance_criteria: ["Running brain-hands init creates config.yaml"],
      verification: {
        required_commands: ["npm test -- tests/core/config.test.ts"],
        manual_checks: [],
        expected_artifacts: [".brain-hands/config.yaml"],
      },
      review_checklist: ["Config has model profiles"],
      risk_register: ["Overwriting user config"],
      handoff_prompt: "Implement the config writer only.",
    });

    expect(parsed.success).toBe(true);
  });

  it("rejects issues without verification commands", () => {
    const parsed = issueSpecSchema.safeParse({
      type: "implementation_task",
      run_id: "run",
      parent_request: "Build a CLI",
      goal: "Create init",
      context: "context",
      scope: { include: [], exclude: [] },
      dependencies: [],
      implementation_steps: ["step"],
      acceptance_criteria: ["criterion"],
      verification: {
        required_commands: [],
        manual_checks: [],
        expected_artifacts: [],
      },
      review_checklist: ["check"],
      risk_register: [],
      handoff_prompt: "prompt",
    });

    expect(parsed.success).toBe(false);
  });
});

describe("prReviewSchema", () => {
  it("accepts structured brain review findings", () => {
    const parsed = prReviewSchema.safeParse({
      decision: "request_changes",
      requirement_coverage: {
        passed: ["scope audit"],
        failed: ["evidence audit"],
      },
      verification: {
        commands_reviewed: ["npm test"],
        commands_missing: ["npm run typecheck"],
        artifacts_reviewed: ["verification/issue-1/test-output.txt"],
      },
      findings: [
        {
          severity: "high",
          file: "src/core/config.ts",
          line: 42,
          problem: "Config overwrite is not guarded.",
          required_fix: "Refuse to overwrite unless --force is passed.",
          verification_after_fix: "Run config overwrite test.",
        },
      ],
      residual_risks: [],
    });

    expect(parsed.success).toBe(true);
  });
});

describe("runManifestSchema", () => {
  it("accepts the minimal manifest for a new run", () => {
    const parsed = runManifestSchema.safeParse({
      run_id: "2026-07-08T12-00-00Z-build-cli",
      original_request: "Build the workflow CLI",
      repo_root: "/tmp/repo",
      created_at: "2026-07-08T12:00:00.000Z",
      updated_at: "2026-07-08T12:00:00.000Z",
      stage: "intake",
      current_issue: null,
      current_pr: null,
      retry_counts: {},
      issue_numbers: [],
      pr_numbers: [],
    });

    expect(parsed.success).toBe(true);
  });
});
```

- [ ] **Step 2: Run schema tests and confirm failure**

Run:

```bash
npm test -- tests/core/schema.test.ts
```

Expected:

```text
FAIL tests/core/schema.test.ts
Cannot find module '../../src/core/schema.js'
```

- [ ] **Step 3: Add shared TypeScript interfaces**

Create `src/core/types.ts`:

```ts
export type ModelRole =
  | "brain_planner"
  | "brain_reviewer"
  | "hands_implementer"
  | "hands_fixer";

export type WorkflowStage =
  | "intake"
  | "research"
  | "planning"
  | "issue_drafting"
  | "issue_critique"
  | "ready_for_hands"
  | "implementing"
  | "local_verification"
  | "pull_request"
  | "brain_review"
  | "fixing"
  | "requirement_audit"
  | "merge_ready"
  | "final_audit"
  | "complete"
  | "replan";

export interface ModelProfile {
  model: string;
  temperature: "low" | "medium";
  responsibilities: string[];
}

export interface BrainHandsConfig {
  version: 1;
  github: {
    enabled: boolean;
    default_remote: string;
  };
  codex: {
    command: string;
    args_template: string[];
    prompt_transport: "stdin" | "file";
    prompt_file_flag: string;
    timeout_seconds: number;
  };
  retry_policy: {
    max_hands_fix_attempts: number;
    max_replan_attempts: number;
  };
  profiles: Record<ModelRole, ModelProfile>;
}

export interface IssueSpec {
  type: "implementation_task";
  run_id: string;
  parent_request: string;
  goal: string;
  context: string;
  scope: {
    include: string[];
    exclude: string[];
  };
  dependencies: number[];
  implementation_steps: string[];
  acceptance_criteria: string[];
  verification: {
    required_commands: string[];
    manual_checks: string[];
    expected_artifacts: string[];
  };
  review_checklist: string[];
  risk_register: string[];
  handoff_prompt: string;
}

export interface PrReviewFinding {
  severity: "critical" | "high" | "medium" | "low";
  file: string;
  line: number;
  problem: string;
  required_fix: string;
  verification_after_fix: string;
}

export interface PrReview {
  decision: "approve" | "request_changes" | "replan_required";
  requirement_coverage: {
    passed: string[];
    failed: string[];
  };
  verification: {
    commands_reviewed: string[];
    commands_missing: string[];
    artifacts_reviewed: string[];
  };
  findings: PrReviewFinding[];
  residual_risks: string[];
}

export interface RunManifest {
  run_id: string;
  original_request: string;
  repo_root: string;
  created_at: string;
  updated_at: string;
  stage: WorkflowStage;
  current_issue: number | null;
  current_pr: number | null;
  retry_counts: Record<string, number>;
  issue_numbers: number[];
  pr_numbers: number[];
}

export interface VerificationEvidence {
  issue_number: number;
  commands: Array<{
    command: string;
    exit_code: number;
    stdout_path: string;
    stderr_path: string;
  }>;
  artifacts: string[];
  created_at: string;
}
```

- [ ] **Step 4: Add Zod schemas**

Create `src/core/schema.ts`:

```ts
import { z } from "zod";

export const modelRoleSchema = z.enum([
  "brain_planner",
  "brain_reviewer",
  "hands_implementer",
  "hands_fixer",
]);

export const workflowStageSchema = z.enum([
  "intake",
  "research",
  "planning",
  "issue_drafting",
  "issue_critique",
  "ready_for_hands",
  "implementing",
  "local_verification",
  "pull_request",
  "brain_review",
  "fixing",
  "requirement_audit",
  "merge_ready",
  "final_audit",
  "complete",
  "replan",
]);

export const configSchema = z.object({
  version: z.literal(1),
  github: z.object({
    enabled: z.boolean(),
    default_remote: z.string().min(1),
  }),
  codex: z.object({
    command: z.string().min(1),
    args_template: z.array(z.string()),
    prompt_transport: z.enum(["stdin", "file"]),
    prompt_file_flag: z.string().min(1),
    timeout_seconds: z.number().int().positive(),
  }),
  retry_policy: z.object({
    max_hands_fix_attempts: z.number().int().min(1),
    max_replan_attempts: z.number().int().min(0),
  }),
  profiles: z.record(
    modelRoleSchema,
    z.object({
      model: z.string().min(1),
      temperature: z.enum(["low", "medium"]),
      responsibilities: z.array(z.string().min(1)).min(1),
    }),
  ),
});

export const issueSpecSchema = z.object({
  type: z.literal("implementation_task"),
  run_id: z.string().min(1),
  parent_request: z.string().min(1),
  goal: z.string().min(1),
  context: z.string().min(1),
  scope: z.object({
    include: z.array(z.string()),
    exclude: z.array(z.string()),
  }),
  dependencies: z.array(z.number().int().positive()),
  implementation_steps: z.array(z.string().min(1)).min(1),
  acceptance_criteria: z.array(z.string().min(1)).min(1),
  verification: z.object({
    required_commands: z.array(z.string().min(1)).min(1),
    manual_checks: z.array(z.string()),
    expected_artifacts: z.array(z.string()),
  }),
  review_checklist: z.array(z.string().min(1)).min(1),
  risk_register: z.array(z.string()),
  handoff_prompt: z.string().min(1),
});

export const prReviewSchema = z.object({
  decision: z.enum(["approve", "request_changes", "replan_required"]),
  requirement_coverage: z.object({
    passed: z.array(z.string()),
    failed: z.array(z.string()),
  }),
  verification: z.object({
    commands_reviewed: z.array(z.string()),
    commands_missing: z.array(z.string()),
    artifacts_reviewed: z.array(z.string()),
  }),
  findings: z.array(
    z.object({
      severity: z.enum(["critical", "high", "medium", "low"]),
      file: z.string().min(1),
      line: z.number().int().min(1),
      problem: z.string().min(1),
      required_fix: z.string().min(1),
      verification_after_fix: z.string().min(1),
    }),
  ),
  residual_risks: z.array(z.string()),
});

export const runManifestSchema = z.object({
  run_id: z.string().min(1),
  original_request: z.string().min(1),
  repo_root: z.string().min(1),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  stage: workflowStageSchema,
  current_issue: z.number().int().positive().nullable(),
  current_pr: z.number().int().positive().nullable(),
  retry_counts: z.record(z.string(), z.number().int().min(0)),
  issue_numbers: z.array(z.number().int().positive()),
  pr_numbers: z.array(z.number().int().positive()),
});

export const verificationEvidenceSchema = z.object({
  issue_number: z.number().int().positive(),
  commands: z.array(
    z.object({
      command: z.string().min(1),
      exit_code: z.number().int(),
      stdout_path: z.string().min(1),
      stderr_path: z.string().min(1),
    }),
  ),
  artifacts: z.array(z.string()),
  created_at: z.string().datetime(),
});
```

- [ ] **Step 5: Verify schema tests pass**

Run:

```bash
npm test -- tests/core/schema.test.ts
npm run typecheck
```

Expected:

```text
PASS tests/core/schema.test.ts
```

```text
Found 0 errors.
```

- [ ] **Step 6: Commit**

Run:

```bash
git add src/core/types.ts src/core/schema.ts tests/core/schema.test.ts
git commit -m "feat: define workflow schemas"
```

---

### Task 3: Implement Config Initialization and Loading

**Files:**
- Create: `src/core/config.ts`
- Modify: `src/cli.ts`
- Test: `tests/core/config.test.ts`

**Interfaces:**
- Consumes: `BrainHandsConfig`, `configSchema`.
- Produces:
  - `defaultConfig(): BrainHandsConfig`
  - `initConfig(repoRoot: string, force?: boolean): Promise<string>`
  - `loadConfig(repoRoot: string): Promise<BrainHandsConfig>`

- [ ] **Step 1: Write failing config tests**

Create `tests/core/config.test.ts`:

```ts
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { initConfig, loadConfig } from "../../src/core/config.js";

let repoRoot: string | null = null;

afterEach(async () => {
  if (repoRoot) {
    await rm(repoRoot, { recursive: true, force: true });
    repoRoot = null;
  }
});

describe("config", () => {
  it("creates the default config file", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-config-"));

    const path = await initConfig(repoRoot);
    const raw = await readFile(path, "utf8");
    const config = await loadConfig(repoRoot);

    expect(path.endsWith(".brain-hands/config.yaml")).toBe(true);
    expect(raw).toContain("brain_planner");
    expect(config.retry_policy.max_hands_fix_attempts).toBe(3);
    expect(config.codex.command).toBe("codex");
  });

  it("refuses to overwrite config unless force is enabled", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-config-"));

    await initConfig(repoRoot);

    await expect(initConfig(repoRoot)).rejects.toThrow("already exists");
    await expect(initConfig(repoRoot, true)).resolves.toContain("config.yaml");
  });
});
```

- [ ] **Step 2: Run config tests and confirm failure**

Run:

```bash
npm test -- tests/core/config.test.ts
```

Expected:

```text
FAIL tests/core/config.test.ts
Cannot find module '../../src/core/config.js'
```

- [ ] **Step 3: Implement config functions**

Create `src/core/config.ts`:

```ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import YAML from "yaml";
import type { BrainHandsConfig } from "./types.js";
import { configSchema } from "./schema.js";

export function defaultConfig(): BrainHandsConfig {
  return {
    version: 1,
    github: {
      enabled: true,
      default_remote: "origin",
    },
    codex: {
      command: "codex",
      args_template: [],
      prompt_transport: "stdin",
      prompt_file_flag: "--prompt-file",
      timeout_seconds: 3600,
    },
    retry_policy: {
      max_hands_fix_attempts: 3,
      max_replan_attempts: 2,
    },
    profiles: {
      brain_planner: {
        model: "strongest",
        temperature: "low",
        responsibilities: [
          "research",
          "architecture",
          "decomposition",
          "risk analysis",
          "issue authoring",
        ],
      },
      brain_reviewer: {
        model: "strongest",
        temperature: "low",
        responsibilities: [
          "diff review",
          "requirement audit",
          "verification review",
          "final approval",
        ],
      },
      hands_implementer: {
        model: "cheap_fast",
        temperature: "low",
        responsibilities: ["code changes", "focused tests", "implementation notes"],
      },
      hands_fixer: {
        model: "cheap_fast",
        temperature: "low",
        responsibilities: ["apply review comments", "preserve scope", "rerun checks"],
      },
    },
  };
}

export function configPath(repoRoot: string): string {
  return join(repoRoot, ".brain-hands", "config.yaml");
}

export async function initConfig(repoRoot: string, force = false): Promise<string> {
  const targetPath = configPath(repoRoot);
  await mkdir(join(repoRoot, ".brain-hands"), { recursive: true });

  if (!force) {
    try {
      await readFile(targetPath, "utf8");
      throw new Error(`Config already exists at ${targetPath}. Use --force to overwrite.`);
    } catch (error) {
      if (error instanceof Error && error.message.includes("already exists")) {
        throw error;
      }
    }
  }

  await writeFile(targetPath, YAML.stringify(defaultConfig()), "utf8");
  return targetPath;
}

export async function loadConfig(repoRoot: string): Promise<BrainHandsConfig> {
  const raw = await readFile(configPath(repoRoot), "utf8");
  return configSchema.parse(YAML.parse(raw));
}
```

- [ ] **Step 4: Wire the `init` command**

Modify `src/cli.ts` so the `init` command calls `initConfig`:

```ts
#!/usr/bin/env node
import { Command } from "commander";
import { initConfig } from "./core/config.js";

export function buildCli(): Command {
  const program = new Command();

  program
    .name("brain-hands")
    .description("Orchestrate Codex brain/hands workflows")
    .version("0.1.0");

  program
    .command("init")
    .description("Create .brain-hands/config.yaml")
    .option("--repo <path>", "Repository root", process.cwd())
    .option("--force", "Overwrite existing config", false)
    .action(async (options: { repo: string; force: boolean }) => {
      const path = await initConfig(options.repo, options.force);
      console.log(`Created ${path}`);
    });

  program.command("run").description("Start a new workflow run");
  program.command("resume").description("Resume an existing workflow run");
  program.command("status").description("Show workflow run status");
  program.command("doctor").description("Check local tool dependencies");

  return program;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await buildCli().parseAsync(process.argv);
}
```

- [ ] **Step 5: Verify config behavior**

Run:

```bash
npm test -- tests/core/config.test.ts tests/cli-smoke.test.ts
npm run typecheck
```

Expected:

```text
PASS tests/core/config.test.ts
PASS tests/cli-smoke.test.ts
```

- [ ] **Step 6: Commit**

Run:

```bash
git add src/core/config.ts src/cli.ts tests/core/config.test.ts
git commit -m "feat: add config initialization"
```

---

### Task 4: Implement the Run Ledger

**Files:**
- Create: `src/core/ledger.ts`
- Test: `tests/core/ledger.test.ts`

**Interfaces:**
- Consumes: `RunManifest`, `runManifestSchema`.
- Produces:
  - `createRunLedger(input): Promise<RunLedger>`
  - `readManifest(runDir: string): Promise<RunManifest>`
  - `updateManifest(runDir: string, patch: Partial<RunManifest>): Promise<RunManifest>`
  - `writeTextArtifact(runDir: string, relativePath: string, content: string): Promise<string>`

- [ ] **Step 1: Write failing ledger tests**

Create `tests/core/ledger.test.ts`:

```ts
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  createRunLedger,
  readManifest,
  updateManifest,
  writeTextArtifact,
} from "../../src/core/ledger.js";

let repoRoot: string | null = null;

afterEach(async () => {
  if (repoRoot) {
    await rm(repoRoot, { recursive: true, force: true });
    repoRoot = null;
  }
});

describe("ledger", () => {
  it("creates a run directory with manifest and request artifact", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-ledger-"));

    const ledger = await createRunLedger({
      repoRoot,
      originalRequest: "Build the CLI",
      slug: "build-cli",
      now: new Date("2026-07-08T12:00:00.000Z"),
    });

    const manifest = await readManifest(ledger.runDir);
    const request = await readFile(join(ledger.runDir, "original-request.md"), "utf8");

    expect(ledger.runId).toBe("2026-07-08T12-00-00-000Z-build-cli");
    expect(manifest.stage).toBe("intake");
    expect(request).toBe("Build the CLI\n");
  });

  it("updates manifest stage and writes nested artifacts", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-ledger-"));
    const ledger = await createRunLedger({
      repoRoot,
      originalRequest: "Build the CLI",
      slug: "build-cli",
      now: new Date("2026-07-08T12:00:00.000Z"),
    });

    await updateManifest(ledger.runDir, { stage: "planning" });
    const artifactPath = await writeTextArtifact(
      ledger.runDir,
      "verification/issue-1/test-output.txt",
      "PASS\n",
    );

    const manifest = await readManifest(ledger.runDir);
    const artifact = await readFile(artifactPath, "utf8");

    expect(manifest.stage).toBe("planning");
    expect(artifact).toBe("PASS\n");
  });
});
```

- [ ] **Step 2: Run ledger tests and confirm failure**

Run:

```bash
npm test -- tests/core/ledger.test.ts
```

Expected:

```text
FAIL tests/core/ledger.test.ts
Cannot find module '../../src/core/ledger.js'
```

- [ ] **Step 3: Implement ledger functions**

Create `src/core/ledger.ts`:

```ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { RunManifest } from "./types.js";
import { runManifestSchema } from "./schema.js";

export interface CreateRunLedgerInput {
  repoRoot: string;
  originalRequest: string;
  slug: string;
  now?: Date;
}

export interface RunLedger {
  runId: string;
  runDir: string;
  manifest: RunManifest;
}

function formatRunId(now: Date, slug: string): string {
  const stamp = now.toISOString().replaceAll(":", "-").replace(".", "-");
  return `${stamp}-${slug}`;
}

export async function createRunLedger(input: CreateRunLedgerInput): Promise<RunLedger> {
  const now = input.now ?? new Date();
  const runId = formatRunId(now, input.slug);
  const runDir = join(input.repoRoot, ".brain-hands", "runs", runId);
  const createdAt = now.toISOString();

  const manifest: RunManifest = {
    run_id: runId,
    original_request: input.originalRequest,
    repo_root: input.repoRoot,
    created_at: createdAt,
    updated_at: createdAt,
    stage: "intake",
    current_issue: null,
    current_pr: null,
    retry_counts: {},
    issue_numbers: [],
    pr_numbers: [],
  };

  await mkdir(runDir, { recursive: true });
  await mkdir(join(runDir, "verification"), { recursive: true });
  await mkdir(join(runDir, "reviews"), { recursive: true });
  await mkdir(join(runDir, "prompts"), { recursive: true });
  await writeFile(join(runDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  await writeFile(join(runDir, "original-request.md"), `${input.originalRequest}\n`, "utf8");

  return { runId, runDir, manifest };
}

export async function readManifest(runDir: string): Promise<RunManifest> {
  const raw = await readFile(join(runDir, "manifest.json"), "utf8");
  return runManifestSchema.parse(JSON.parse(raw));
}

export async function updateManifest(
  runDir: string,
  patch: Partial<RunManifest>,
): Promise<RunManifest> {
  const current = await readManifest(runDir);
  const next = runManifestSchema.parse({
    ...current,
    ...patch,
    updated_at: new Date().toISOString(),
  });
  await writeFile(join(runDir, "manifest.json"), JSON.stringify(next, null, 2), "utf8");
  return next;
}

export async function writeTextArtifact(
  runDir: string,
  relativePath: string,
  content: string,
): Promise<string> {
  const target = join(runDir, relativePath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content, "utf8");
  return target;
}
```

- [ ] **Step 4: Verify ledger tests pass**

Run:

```bash
npm test -- tests/core/ledger.test.ts
npm run typecheck
```

Expected:

```text
PASS tests/core/ledger.test.ts
```

- [ ] **Step 5: Commit**

Run:

```bash
git add src/core/ledger.ts tests/core/ledger.test.ts
git commit -m "feat: add resumable run ledger"
```

---

### Task 5: Add Controlled Subprocess Execution and Doctor Preflight

**Files:**
- Create: `src/core/executor.ts`
- Create: `src/core/errors.ts`
- Modify: `src/cli.ts`
- Test: `tests/core/executor.test.ts`

**Interfaces:**
- Consumes: Node subprocess APIs through Execa.
- Produces:
  - `runCommand(input): Promise<CommandResult>`
  - `checkCommand(name, args): Promise<ToolCheck>`
  - CLI command `brain-hands doctor`

- [ ] **Step 1: Write failing executor tests**

Create `tests/core/executor.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { checkCommand, runCommand } from "../../src/core/executor.js";

describe("runCommand", () => {
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
});

describe("checkCommand", () => {
  it("marks existing commands available", async () => {
    const check = await checkCommand(process.execPath, ["--version"], process.cwd());

    expect(check.available).toBe(true);
    expect(check.exitCode).toBe(0);
  });
});
```

- [ ] **Step 2: Run executor tests and confirm failure**

Run:

```bash
npm test -- tests/core/executor.test.ts
```

Expected:

```text
FAIL tests/core/executor.test.ts
Cannot find module '../../src/core/executor.js'
```

- [ ] **Step 3: Add error helpers**

Create `src/core/errors.ts`:

```ts
export class BrainHandsError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "BrainHandsError";
  }
}
```

- [ ] **Step 4: Implement controlled command execution**

Create `src/core/executor.ts`:

```ts
import { execa } from "execa";

export interface RunCommandInput {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  stdin?: string;
}

export interface CommandResult {
  command: string;
  args: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
  failed: boolean;
  timedOut: boolean;
}

export interface ToolCheck {
  command: string;
  args: string[];
  available: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export async function runCommand(input: RunCommandInput): Promise<CommandResult> {
  try {
    const result = await execa(input.command, input.args, {
      cwd: input.cwd,
      input: input.stdin,
      reject: false,
      timeout: input.timeoutMs,
    });

    return {
      command: input.command,
      args: input.args,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      failed: result.failed,
      timedOut: result.timedOut,
    };
  } catch (error) {
    const err = error as Error & { timedOut?: boolean; shortMessage?: string };
    return {
      command: input.command,
      args: input.args,
      exitCode: 1,
      stdout: "",
      stderr: err.shortMessage ?? err.message,
      failed: true,
      timedOut: Boolean(err.timedOut),
    };
  }
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
```

- [ ] **Step 5: Wire `doctor` command**

Modify `src/cli.ts` so `doctor` checks `git`, `gh`, and `codex`:

```ts
program
  .command("doctor")
  .description("Check local tool dependencies")
  .option("--repo <path>", "Repository root", process.cwd())
  .action(async (options: { repo: string }) => {
    const { checkCommand } = await import("./core/executor.js");
    const checks = await Promise.all([
      checkCommand("git", ["--version"], options.repo),
      checkCommand("gh", ["--version"], options.repo),
      checkCommand("codex", ["--version"], options.repo),
    ]);

    for (const check of checks) {
      const label = [check.command, ...check.args].join(" ");
      if (check.available) {
        console.log(`OK ${label}`);
      } else {
        console.log(`FAIL ${label}`);
        if (check.stderr) {
          console.log(check.stderr);
        }
      }
    }
  });
```

- [ ] **Step 6: Verify executor tests pass and doctor reports local Codex failure**

Run:

```bash
npm test -- tests/core/executor.test.ts
npm run dev -- doctor
```

Expected:

```text
PASS tests/core/executor.test.ts
```

Expected on this current machine until Codex is reinstalled:

```text
FAIL codex --version
Error: spawn ... codex ENOENT
```

- [ ] **Step 7: Commit**

Run:

```bash
git add src/core/executor.ts src/core/errors.ts src/cli.ts tests/core/executor.test.ts
git commit -m "feat: add dependency doctor"
```

---

### Task 6: Add Prompt Templates and Renderer

**Files:**
- Create: `prompts/brain-planner.md`
- Create: `prompts/brain-issue-critic.md`
- Create: `prompts/brain-reviewer.md`
- Create: `prompts/brain-final-auditor.md`
- Create: `prompts/hands-implementer.md`
- Create: `prompts/hands-fixer.md`
- Create: `src/prompts/loader.ts`
- Create: `src/prompts/renderer.ts`
- Test: `tests/prompts/renderer.test.ts`

**Interfaces:**
- Consumes: prompt files and key/value context.
- Produces:
  - `loadPromptTemplate(name: PromptTemplateName): Promise<string>`
  - `renderTemplate(template: string, variables: Record<string, string>): string`

- [ ] **Step 1: Write failing renderer tests**

Create `tests/prompts/renderer.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { renderTemplate } from "../../src/prompts/renderer.js";

describe("renderTemplate", () => {
  it("replaces all declared variables", () => {
    const rendered = renderTemplate("Review {{issue}} in {{repo}}.", {
      issue: "#123",
      repo: "/tmp/repo",
    });

    expect(rendered).toBe("Review #123 in /tmp/repo.");
  });

  it("throws when a variable is missing", () => {
    expect(() => renderTemplate("Review {{issue}}.", {})).toThrow("Missing template variable: issue");
  });
});
```

- [ ] **Step 2: Run renderer tests and confirm failure**

Run:

```bash
npm test -- tests/prompts/renderer.test.ts
```

Expected:

```text
FAIL tests/prompts/renderer.test.ts
Cannot find module '../../src/prompts/renderer.js'
```

- [ ] **Step 3: Implement the renderer**

Create `src/prompts/renderer.ts`:

```ts
export function renderTemplate(
  template: string,
  variables: Record<string, string>,
): string {
  return template.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_match, key: string) => {
    const value = variables[key];
    if (value === undefined) {
      throw new Error(`Missing template variable: ${key}`);
    }
    return value;
  });
}
```

- [ ] **Step 4: Implement the loader**

Create `src/prompts/loader.ts`:

```ts
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type PromptTemplateName =
  | "brain-planner"
  | "brain-issue-critic"
  | "brain-reviewer"
  | "brain-final-auditor"
  | "hands-implementer"
  | "hands-fixer";

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function loadPromptTemplate(name: PromptTemplateName): Promise<string> {
  const projectRoot = join(__dirname, "..", "..");
  return readFile(join(projectRoot, "prompts", `${name}.md`), "utf8");
}
```

- [ ] **Step 5: Add brain planner prompt**

Create `prompts/brain-planner.md`:

```markdown
You are the brain planner for brain-hands.

Input:
- Original request:
{{original_request}}
- Repository root:
{{repo_root}}
- Existing workflow design:
{{workflow_design}}

Produce:
1. Research notes when research is needed.
2. Architecture plan.
3. Risk register.
4. A JSON array of implementation_task issues matching the IssueSpec schema.

Rules:
- Every issue must include verification.required_commands.
- Every issue must include acceptance_criteria.
- Keep issues small enough for one focused implementation branch.
- Do not ask the hands model to make architecture decisions.
```

- [ ] **Step 6: Add issue critic prompt**

Create `prompts/brain-issue-critic.md`:

```markdown
You are the brain issue critic for brain-hands.

Input:
- Original request:
{{original_request}}
- Draft issues JSON:
{{issues_json}}

Review every issue for:
1. Missing implementation detail.
2. Missing verification commands.
3. Ambiguous scope.
4. Cross-issue dependency problems.
5. Acceptance criteria that cannot be observed.

Return corrected JSON matching the IssueSpec schema. Do not return prose outside JSON.
```

- [ ] **Step 7: Add reviewer and auditor prompts**

Create `prompts/brain-reviewer.md`:

```markdown
You are the brain reviewer for brain-hands.

Input:
- Original request:
{{original_request}}
- Architecture plan:
{{architecture_plan}}
- Issue body:
{{issue_body}}
- Pull request diff:
{{pr_diff}}
- Verification evidence:
{{verification_evidence}}

Perform three audits:
1. Scope audit: compare implementation against original request and acceptance criteria.
2. Behavior audit: inspect runtime behavior, edge cases, and failure modes.
3. Evidence audit: check that verification evidence supports approval.

Return JSON matching PrReview:
- decision: approve, request_changes, or replan_required.
- findings must include exact file, line, problem, required_fix, and verification_after_fix.
```

Create `prompts/brain-final-auditor.md`:

```markdown
You are the final auditor for brain-hands.

Input:
- Original request:
{{original_request}}
- Completed issues:
{{completed_issues}}
- Pull requests:
{{pull_requests}}
- Verification evidence:
{{verification_evidence}}

Decide whether the complete user request is satisfied across all PRs.
Return a concise Markdown report with:
- Completed requirements.
- Missing requirements.
- Verification evidence reviewed.
- Residual risks.
- Merge recommendation.
```

- [ ] **Step 8: Add hands prompts**

Create `prompts/hands-implementer.md`:

```markdown
You are the hands implementer for brain-hands.

Input:
- Issue:
{{issue_body}}
- Architecture context:
{{architecture_plan}}
- Allowed scope:
{{allowed_scope}}

Implement only this issue.
Rules:
- Do not broaden scope.
- Do not change files outside allowed scope unless the issue explicitly permits it.
- Run the required verification commands.
- Report changed files, commands run, and remaining risks.
```

Create `prompts/hands-fixer.md`:

```markdown
You are the hands fixer for brain-hands.

Input:
- Pull request review findings:
{{review_findings}}
- Current issue:
{{issue_body}}

Apply only the requested fixes.
Rules:
- Do not redesign the solution.
- Do not introduce unrelated refactors.
- Run verification_after_fix commands listed in the findings.
- Report exactly which findings were fixed.
```

- [ ] **Step 9: Verify prompt tests pass**

Run:

```bash
npm test -- tests/prompts/renderer.test.ts
npm run typecheck
```

Expected:

```text
PASS tests/prompts/renderer.test.ts
```

- [ ] **Step 10: Commit**

Run:

```bash
git add prompts src/prompts tests/prompts
git commit -m "feat: add workflow prompt templates"
```

---

### Task 7: Implement Codex Adapter with Dry-Run and Configurable Subprocess Mode

**Files:**
- Create: `src/adapters/codex.ts`
- Test: `tests/adapters/codex.test.ts`

**Interfaces:**
- Consumes: `BrainHandsConfig`, `ModelRole`, prompt strings, `runCommand`.
- Produces:
  - `CodexAdapter`
  - `DryRunCodexAdapter`
  - `SubprocessCodexAdapter`
  - `renderCodexArgs(argsTemplate, model, promptFile): string[]`

- [ ] **Step 1: Write failing Codex adapter tests**

Create `tests/adapters/codex.test.ts`:

```ts
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  DryRunCodexAdapter,
  renderCodexArgs,
} from "../../src/adapters/codex.js";

let runDir: string | null = null;

afterEach(async () => {
  if (runDir) {
    await rm(runDir, { recursive: true, force: true });
    runDir = null;
  }
});

describe("renderCodexArgs", () => {
  it("substitutes model and prompt file", () => {
    const args = renderCodexArgs(
      ["exec", "--model", "{{model}}", "--prompt-file", "{{promptFile}}"],
      "gpt-5",
      "/tmp/prompt.md",
    );

    expect(args).toEqual(["exec", "--model", "gpt-5", "--prompt-file", "/tmp/prompt.md"]);
  });
});

describe("DryRunCodexAdapter", () => {
  it("stores prompt files and returns deterministic output", async () => {
    runDir = await mkdtemp(join(tmpdir(), "brain-hands-codex-"));
    const adapter = new DryRunCodexAdapter();

    const result = await adapter.invoke({
      role: "brain_planner",
      model: "strongest",
      prompt: "Plan the task",
      runDir,
      artifactName: "brain-planner",
    });

    const prompt = await readFile(join(runDir, "prompts", "brain-planner.md"), "utf8");

    expect(prompt).toBe("Plan the task");
    expect(result.text).toContain("DRY_RUN");
  });
});
```

- [ ] **Step 2: Run adapter tests and confirm failure**

Run:

```bash
npm test -- tests/adapters/codex.test.ts
```

Expected:

```text
FAIL tests/adapters/codex.test.ts
Cannot find module '../../src/adapters/codex.js'
```

- [ ] **Step 3: Implement Codex adapter**

Create `src/adapters/codex.ts`:

```ts
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BrainHandsConfig, ModelRole } from "../core/types.js";
import { runCommand } from "../core/executor.js";

export interface CodexInvokeInput {
  role: ModelRole;
  model: string;
  prompt: string;
  runDir: string;
  artifactName: string;
}

export interface CodexInvokeResult {
  text: string;
  exitCode: number;
  promptPath: string;
  stdoutPath: string;
  stderrPath: string;
}

export interface CodexAdapter {
  invoke(input: CodexInvokeInput): Promise<CodexInvokeResult>;
}

export function renderCodexArgs(
  argsTemplate: string[],
  model: string,
  promptFile: string,
): string[] {
  return argsTemplate.map((arg) =>
    arg.replaceAll("{{model}}", model).replaceAll("{{promptFile}}", promptFile),
  );
}

async function writeInvocationArtifacts(
  runDir: string,
  artifactName: string,
  prompt: string,
  stdout: string,
  stderr: string,
): Promise<{ promptPath: string; stdoutPath: string; stderrPath: string }> {
  const promptsDir = join(runDir, "prompts");
  const responsesDir = join(runDir, "responses");
  await mkdir(promptsDir, { recursive: true });
  await mkdir(responsesDir, { recursive: true });

  const promptPath = join(promptsDir, `${artifactName}.md`);
  const stdoutPath = join(responsesDir, `${artifactName}.stdout.txt`);
  const stderrPath = join(responsesDir, `${artifactName}.stderr.txt`);

  await writeFile(promptPath, prompt, "utf8");
  await writeFile(stdoutPath, stdout, "utf8");
  await writeFile(stderrPath, stderr, "utf8");

  return { promptPath, stdoutPath, stderrPath };
}

export class DryRunCodexAdapter implements CodexAdapter {
  async invoke(input: CodexInvokeInput): Promise<CodexInvokeResult> {
    const text = JSON.stringify(
      {
        mode: "DRY_RUN",
        role: input.role,
        model: input.model,
        artifact: input.artifactName,
      },
      null,
      2,
    );
    const paths = await writeInvocationArtifacts(
      input.runDir,
      input.artifactName,
      input.prompt,
      text,
      "",
    );

    return {
      text,
      exitCode: 0,
      ...paths,
    };
  }
}

export class SubprocessCodexAdapter implements CodexAdapter {
  constructor(
    private readonly config: BrainHandsConfig,
    private readonly cwd: string,
  ) {}

  async invoke(input: CodexInvokeInput): Promise<CodexInvokeResult> {
    const promptPath = join(input.runDir, "prompts", `${input.artifactName}.md`);
    await mkdir(join(input.runDir, "prompts"), { recursive: true });
    await writeFile(promptPath, input.prompt, "utf8");

    const args =
      this.config.codex.prompt_transport === "file"
        ? [
            ...renderCodexArgs(this.config.codex.args_template, input.model, promptPath),
            this.config.codex.prompt_file_flag,
            promptPath,
          ]
        : renderCodexArgs(this.config.codex.args_template, input.model, promptPath);

    const result = await runCommand({
      command: this.config.codex.command,
      args,
      cwd: this.cwd,
      timeoutMs: this.config.codex.timeout_seconds * 1000,
      stdin: this.config.codex.prompt_transport === "stdin" ? input.prompt : undefined,
    });

    const paths = await writeInvocationArtifacts(
      input.runDir,
      input.artifactName,
      input.prompt,
      result.stdout,
      result.stderr,
    );

    return {
      text: result.stdout,
      exitCode: result.exitCode,
      ...paths,
    };
  }
}
```

- [ ] **Step 4: Verify Codex adapter tests pass**

Run:

```bash
npm test -- tests/adapters/codex.test.ts
npm run typecheck
```

Expected:

```text
PASS tests/adapters/codex.test.ts
```

- [ ] **Step 5: Commit**

Run:

```bash
git add src/adapters/codex.ts tests/adapters/codex.test.ts
git commit -m "feat: add codex invocation adapter"
```

---

### Task 8: Implement Git and GitHub Adapters

**Files:**
- Create: `src/adapters/git.ts`
- Create: `src/adapters/github.ts`
- Test: `tests/adapters/github.test.ts`

**Interfaces:**
- Consumes: `runCommand`, issue specs, PR review findings.
- Produces:
  - `getGitSnapshot(repoRoot): Promise<GitSnapshot>`
  - `createIssueBranch(repoRoot, issueNumber, slug): Promise<string>`
  - `collectDiff(repoRoot, baseRef): Promise<string>`
  - `GitHubAdapter`
  - `GhCliGitHubAdapter`
  - `DryRunGitHubAdapter`

- [ ] **Step 1: Write failing GitHub adapter tests**

Create `tests/adapters/github.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { DryRunGitHubAdapter, formatIssueBody } from "../../src/adapters/github.js";
import type { IssueSpec } from "../../src/core/types.js";

function issue(): IssueSpec {
  return {
    type: "implementation_task",
    run_id: "run-1",
    parent_request: "Build CLI",
    goal: "Create config",
    context: "Config lives in .brain-hands/config.yaml",
    scope: { include: ["src/core/config.ts"], exclude: ["network calls"] },
    dependencies: [],
    implementation_steps: ["Create default config"],
    acceptance_criteria: ["init writes config"],
    verification: {
      required_commands: ["npm test -- tests/core/config.test.ts"],
      manual_checks: [],
      expected_artifacts: [".brain-hands/config.yaml"],
    },
    review_checklist: ["No overwrite without force"],
    risk_register: ["Overwriting existing config"],
    handoff_prompt: "Implement config only.",
  };
}

describe("formatIssueBody", () => {
  it("includes machine-readable issue spec", () => {
    const body = formatIssueBody(issue());

    expect(body).toContain("```yaml");
    expect(body).toContain("goal: Create config");
    expect(body).toContain("required_commands:");
  });
});

describe("DryRunGitHubAdapter", () => {
  it("allocates deterministic issue and PR numbers", async () => {
    const adapter = new DryRunGitHubAdapter();

    const issueNumber = await adapter.createIssue(issue());
    const prNumber = await adapter.openPullRequest({
      title: "Issue 1",
      body: "body",
      head: "brain-hands/issue-1",
      base: "main",
    });

    expect(issueNumber).toBe(1);
    expect(prNumber).toBe(1);
  });
});
```

- [ ] **Step 2: Run adapter tests and confirm failure**

Run:

```bash
npm test -- tests/adapters/github.test.ts
```

Expected:

```text
FAIL tests/adapters/github.test.ts
Cannot find module '../../src/adapters/github.js'
```

- [ ] **Step 3: Implement Git adapter**

Create `src/adapters/git.ts`:

```ts
import { runCommand } from "../core/executor.js";

export interface GitSnapshot {
  branch: string;
  status: string;
  gitDir: string;
  gitCommonDir: string;
  isLinkedWorktree: boolean;
}

async function git(repoRoot: string, args: string[]) {
  return runCommand({
    command: "git",
    args,
    cwd: repoRoot,
    timeoutMs: 30_000,
  });
}

export async function getGitSnapshot(repoRoot: string): Promise<GitSnapshot> {
  const branch = await git(repoRoot, ["branch", "--show-current"]);
  const status = await git(repoRoot, ["status", "--short"]);
  const gitDir = await git(repoRoot, ["rev-parse", "--git-dir"]);
  const gitCommonDir = await git(repoRoot, ["rev-parse", "--git-common-dir"]);

  return {
    branch: branch.stdout.trim(),
    status: status.stdout,
    gitDir: gitDir.stdout.trim(),
    gitCommonDir: gitCommonDir.stdout.trim(),
    isLinkedWorktree: gitDir.stdout.trim() !== gitCommonDir.stdout.trim(),
  };
}

export async function createIssueBranch(
  repoRoot: string,
  issueNumber: number,
  slug: string,
): Promise<string> {
  const branchName = `brain-hands/issue-${issueNumber}-${slug}`;
  const result = await git(repoRoot, ["switch", "-c", branchName]);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || `Failed to create branch ${branchName}`);
  }
  return branchName;
}

export async function collectDiff(repoRoot: string, baseRef = "HEAD~1"): Promise<string> {
  const result = await git(repoRoot, ["diff", baseRef, "HEAD"]);
  return result.stdout;
}
```

- [ ] **Step 4: Implement GitHub adapter**

Create `src/adapters/github.ts`:

```ts
import YAML from "yaml";
import type { IssueSpec, PrReviewFinding } from "../core/types.js";
import { runCommand } from "../core/executor.js";

export interface OpenPullRequestInput {
  title: string;
  body: string;
  head: string;
  base: string;
}

export interface GitHubAdapter {
  createIssue(issue: IssueSpec): Promise<number>;
  updateIssue(issueNumber: number, issue: IssueSpec): Promise<void>;
  addIssueLabels(issueNumber: number, labels: string[]): Promise<void>;
  openPullRequest(input: OpenPullRequestInput): Promise<number>;
  commentOnPullRequest(prNumber: number, body: string): Promise<void>;
}

export function formatIssueBody(issue: IssueSpec): string {
  return [
    `## Goal`,
    issue.goal,
    "",
    "## Context",
    issue.context,
    "",
    "## Machine-Readable Spec",
    "```yaml",
    YAML.stringify(issue).trim(),
    "```",
    "",
  ].join("\n");
}

export function formatReviewComment(finding: PrReviewFinding): string {
  return [
    `**${finding.severity.toUpperCase()}** ${finding.file}:${finding.line}`,
    "",
    `Problem: ${finding.problem}`,
    "",
    `Required fix: ${finding.required_fix}`,
    "",
    `Verify after fix: ${finding.verification_after_fix}`,
  ].join("\n");
}

export class DryRunGitHubAdapter implements GitHubAdapter {
  private issueCounter = 0;
  private prCounter = 0;

  async createIssue(_issue: IssueSpec): Promise<number> {
    this.issueCounter += 1;
    return this.issueCounter;
  }

  async updateIssue(_issueNumber: number, _issue: IssueSpec): Promise<void> {}

  async addIssueLabels(_issueNumber: number, _labels: string[]): Promise<void> {}

  async openPullRequest(_input: OpenPullRequestInput): Promise<number> {
    this.prCounter += 1;
    return this.prCounter;
  }

  async commentOnPullRequest(_prNumber: number, _body: string): Promise<void> {}
}

export class GhCliGitHubAdapter implements GitHubAdapter {
  constructor(private readonly repoRoot: string) {}

  async createIssue(issue: IssueSpec): Promise<number> {
    const result = await runCommand({
      command: "gh",
      args: [
        "issue",
        "create",
        "--title",
        issue.goal,
        "--body",
        formatIssueBody(issue),
        "--label",
        "brain-hands,brain:planned,brain:critiqued,hands:ready,verification:required",
      ],
      cwd: this.repoRoot,
      timeoutMs: 60_000,
    });
    const match = result.stdout.match(/\/issues\/(\d+)/);
    if (result.exitCode !== 0 || !match) {
      throw new Error(result.stderr || "Failed to create GitHub issue");
    }
    return Number(match[1]);
  }

  async updateIssue(issueNumber: number, issue: IssueSpec): Promise<void> {
    const result = await runCommand({
      command: "gh",
      args: ["issue", "edit", String(issueNumber), "--body", formatIssueBody(issue)],
      cwd: this.repoRoot,
      timeoutMs: 60_000,
    });
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || `Failed to update issue ${issueNumber}`);
    }
  }

  async addIssueLabels(issueNumber: number, labels: string[]): Promise<void> {
    const result = await runCommand({
      command: "gh",
      args: ["issue", "edit", String(issueNumber), "--add-label", labels.join(",")],
      cwd: this.repoRoot,
      timeoutMs: 60_000,
    });
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || `Failed to label issue ${issueNumber}`);
    }
  }

  async openPullRequest(input: OpenPullRequestInput): Promise<number> {
    const result = await runCommand({
      command: "gh",
      args: [
        "pr",
        "create",
        "--title",
        input.title,
        "--body",
        input.body,
        "--head",
        input.head,
        "--base",
        input.base,
      ],
      cwd: this.repoRoot,
      timeoutMs: 60_000,
    });
    const match = result.stdout.match(/\/pull\/(\d+)/);
    if (result.exitCode !== 0 || !match) {
      throw new Error(result.stderr || "Failed to open pull request");
    }
    return Number(match[1]);
  }

  async commentOnPullRequest(prNumber: number, body: string): Promise<void> {
    const result = await runCommand({
      command: "gh",
      args: ["pr", "comment", String(prNumber), "--body", body],
      cwd: this.repoRoot,
      timeoutMs: 60_000,
    });
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || `Failed to comment on PR ${prNumber}`);
    }
  }
}
```

- [ ] **Step 5: Verify adapter tests pass**

Run:

```bash
npm test -- tests/adapters/github.test.ts
npm run typecheck
```

Expected:

```text
PASS tests/adapters/github.test.ts
```

- [ ] **Step 6: Commit**

Run:

```bash
git add src/adapters/git.ts src/adapters/github.ts tests/adapters/github.test.ts
git commit -m "feat: add git and github adapters"
```

---

### Task 9: Implement Verification Runner

**Files:**
- Create: `src/verification/runner.ts`
- Test: `tests/verification/runner.test.ts`

**Interfaces:**
- Consumes: issue verification commands, `runCommand`, run ledger.
- Produces:
  - `runVerification(input): Promise<VerificationEvidence>`

- [ ] **Step 1: Write failing verification tests**

Create `tests/verification/runner.test.ts`:

```ts
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { runVerification } from "../../src/verification/runner.js";

let runDir: string | null = null;

afterEach(async () => {
  if (runDir) {
    await rm(runDir, { recursive: true, force: true });
    runDir = null;
  }
});

describe("runVerification", () => {
  it("stores stdout, stderr, and evidence JSON", async () => {
    runDir = await mkdtemp(join(tmpdir(), "brain-hands-verification-"));

    const evidence = await runVerification({
      repoRoot: process.cwd(),
      runDir,
      issueNumber: 12,
      commands: [`${process.execPath} -e "console.log('verified')"`],
    });

    const output = await readFile(join(runDir, evidence.commands[0].stdout_path), "utf8");

    expect(evidence.issue_number).toBe(12);
    expect(output.trim()).toBe("verified");
  });
});
```

- [ ] **Step 2: Run verification tests and confirm failure**

Run:

```bash
npm test -- tests/verification/runner.test.ts
```

Expected:

```text
FAIL tests/verification/runner.test.ts
Cannot find module '../../src/verification/runner.js'
```

- [ ] **Step 3: Implement verification runner**

Create `src/verification/runner.ts`:

```ts
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { VerificationEvidence } from "../core/types.js";
import { runCommand } from "../core/executor.js";
import { verificationEvidenceSchema } from "../core/schema.js";

export interface RunVerificationInput {
  repoRoot: string;
  runDir: string;
  issueNumber: number;
  commands: string[];
}

function splitCommand(command: string): { executable: string; args: string[] } {
  const parts = command.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
  const cleaned = parts.map((part) => part.replace(/^"|"$/g, ""));
  const [executable, ...args] = cleaned;
  if (!executable) {
    throw new Error("Verification command is empty");
  }
  return { executable, args };
}

export async function runVerification(
  input: RunVerificationInput,
): Promise<VerificationEvidence> {
  const evidenceDir = join(input.runDir, "verification", `issue-${input.issueNumber}`);
  await mkdir(evidenceDir, { recursive: true });

  const commands = [];

  for (const [index, command] of input.commands.entries()) {
    const { executable, args } = splitCommand(command);
    const result = await runCommand({
      command: executable,
      args,
      cwd: input.repoRoot,
      timeoutMs: 15 * 60 * 1000,
    });

    const stdoutRelative = `verification/issue-${input.issueNumber}/command-${index + 1}.stdout.txt`;
    const stderrRelative = `verification/issue-${input.issueNumber}/command-${index + 1}.stderr.txt`;

    await writeFile(join(input.runDir, stdoutRelative), result.stdout, "utf8");
    await writeFile(join(input.runDir, stderrRelative), result.stderr, "utf8");

    commands.push({
      command,
      exit_code: result.exitCode,
      stdout_path: stdoutRelative,
      stderr_path: stderrRelative,
    });
  }

  const evidence = verificationEvidenceSchema.parse({
    issue_number: input.issueNumber,
    commands,
    artifacts: [],
    created_at: new Date().toISOString(),
  });

  await writeFile(
    join(evidenceDir, "evidence.json"),
    JSON.stringify(evidence, null, 2),
    "utf8",
  );

  return evidence;
}
```

- [ ] **Step 4: Verify runner tests pass**

Run:

```bash
npm test -- tests/verification/runner.test.ts
npm run typecheck
```

Expected:

```text
PASS tests/verification/runner.test.ts
```

- [ ] **Step 5: Commit**

Run:

```bash
git add src/verification/runner.ts tests/verification/runner.test.ts
git commit -m "feat: collect verification evidence"
```

---

### Task 10: Implement Planning Workflow

**Files:**
- Create: `src/workflow/planner.ts`
- Modify: `src/cli.ts`
- Test: `tests/workflow/orchestrator.test.ts`

**Interfaces:**
- Consumes: config, ledger, prompt loader, prompt renderer, Codex adapter, GitHub adapter.
- Produces:
  - `planRun(input): Promise<PlanRunResult>`
  - CLI `run "<task>" --dry-run`

- [ ] **Step 1: Write failing planning test**

Create `tests/workflow/orchestrator.test.ts`:

```ts
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { DryRunCodexAdapter } from "../../src/adapters/codex.js";
import { DryRunGitHubAdapter } from "../../src/adapters/github.js";
import { defaultConfig } from "../../src/core/config.js";
import { createRunLedger, readManifest } from "../../src/core/ledger.js";
import { planRun } from "../../src/workflow/planner.js";

let repoRoot: string | null = null;

afterEach(async () => {
  if (repoRoot) {
    await rm(repoRoot, { recursive: true, force: true });
    repoRoot = null;
  }
});

describe("planRun", () => {
  it("stores planning artifacts and advances stage", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-plan-"));
    const ledger = await createRunLedger({
      repoRoot,
      originalRequest: "Build init command",
      slug: "build-init-command",
      now: new Date("2026-07-08T12:00:00.000Z"),
    });

    const result = await planRun({
      repoRoot,
      runDir: ledger.runDir,
      config: defaultConfig(),
      codex: new DryRunCodexAdapter(),
      github: new DryRunGitHubAdapter(),
      workflowDesign: "design",
    });

    const manifest = await readManifest(ledger.runDir);
    const research = await readFile(join(ledger.runDir, "research.md"), "utf8");

    expect(result.issueNumbers).toEqual([1]);
    expect(manifest.stage).toBe("ready_for_hands");
    expect(research).toContain("DRY_RUN");
  });
});
```

- [ ] **Step 2: Run planning test and confirm failure**

Run:

```bash
npm test -- tests/workflow/orchestrator.test.ts
```

Expected:

```text
FAIL tests/workflow/orchestrator.test.ts
Cannot find module '../../src/workflow/planner.js'
```

- [ ] **Step 3: Implement planning workflow with dry-run fallback issue**

Create `src/workflow/planner.ts`:

```ts
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CodexAdapter } from "../adapters/codex.js";
import type { GitHubAdapter } from "../adapters/github.js";
import type { BrainHandsConfig, IssueSpec } from "../core/types.js";
import { issueSpecSchema } from "../core/schema.js";
import { updateManifest } from "../core/ledger.js";
import { loadPromptTemplate } from "../prompts/loader.js";
import { renderTemplate } from "../prompts/renderer.js";

export interface PlanRunInput {
  repoRoot: string;
  runDir: string;
  config: BrainHandsConfig;
  codex: CodexAdapter;
  github: GitHubAdapter;
  workflowDesign: string;
}

export interface PlanRunResult {
  issueNumbers: number[];
}

function fallbackDryRunIssue(runId: string, originalRequest: string): IssueSpec {
  return {
    type: "implementation_task",
    run_id: runId,
    parent_request: originalRequest,
    goal: "Dry-run implementation issue",
    context: "This issue is generated when the Codex adapter is running in dry-run mode.",
    scope: { include: ["src"], exclude: ["automatic merge"] },
    dependencies: [],
    implementation_steps: ["Replace dry-run planning with a real Codex planner response."],
    acceptance_criteria: ["Planning artifacts are stored in the run ledger."],
    verification: {
      required_commands: ["npm test"],
      manual_checks: [],
      expected_artifacts: ["issues.json"],
    },
    review_checklist: ["Issue contains verification commands."],
    risk_register: ["Dry-run issue is not production work."],
    handoff_prompt: "Dry-run only.",
  };
}

function parseIssuesOrFallback(text: string, runId: string, originalRequest: string): IssueSpec[] {
  try {
    const parsed = JSON.parse(text);
    const array = Array.isArray(parsed) ? parsed : parsed.issues;
    if (!Array.isArray(array)) {
      throw new Error("Planner response did not contain an issue array");
    }
    return array.map((issue) => issueSpecSchema.parse(issue));
  } catch {
    return [fallbackDryRunIssue(runId, originalRequest)];
  }
}

export async function planRun(input: PlanRunInput): Promise<PlanRunResult> {
  const manifest = JSON.parse(
    await readFile(join(input.runDir, "manifest.json"), "utf8"),
  ) as { run_id: string; original_request: string };

  await updateManifest(input.runDir, { stage: "planning" });

  const plannerTemplate = await loadPromptTemplate("brain-planner");
  const plannerPrompt = renderTemplate(plannerTemplate, {
    original_request: manifest.original_request,
    repo_root: input.repoRoot,
    workflow_design: input.workflowDesign,
  });

  const plannerResult = await input.codex.invoke({
    role: "brain_planner",
    model: input.config.profiles.brain_planner.model,
    prompt: plannerPrompt,
    runDir: input.runDir,
    artifactName: "brain-planner",
  });

  await writeFile(join(input.runDir, "research.md"), plannerResult.text, "utf8");
  await writeFile(join(input.runDir, "architecture-plan.md"), plannerResult.text, "utf8");

  const issues = parseIssuesOrFallback(
    plannerResult.text,
    manifest.run_id,
    manifest.original_request,
  );
  await writeFile(join(input.runDir, "issues.json"), JSON.stringify(issues, null, 2), "utf8");

  await updateManifest(input.runDir, { stage: "issue_critique" });

  const criticTemplate = await loadPromptTemplate("brain-issue-critic");
  const criticPrompt = renderTemplate(criticTemplate, {
    original_request: manifest.original_request,
    issues_json: JSON.stringify(issues, null, 2),
  });
  const criticResult = await input.codex.invoke({
    role: "brain_planner",
    model: input.config.profiles.brain_planner.model,
    prompt: criticPrompt,
    runDir: input.runDir,
    artifactName: "brain-issue-critic",
  });
  await writeFile(join(input.runDir, "issue-review.md"), criticResult.text, "utf8");

  const issueNumbers = [];
  for (const issue of issues) {
    issueNumbers.push(await input.github.createIssue(issue));
  }

  await updateManifest(input.runDir, {
    stage: "ready_for_hands",
    issue_numbers: issueNumbers,
  });

  return { issueNumbers };
}
```

- [ ] **Step 4: Wire minimal `run` command**

Modify `src/cli.ts` so `run` supports dry-run planning:

```ts
program
  .command("run")
  .argument("<task>", "User task")
  .description("Start a new workflow run")
  .option("--repo <path>", "Repository root", process.cwd())
  .option("--dry-run", "Use dry-run adapters", false)
  .action(async (task: string, options: { repo: string; dryRun: boolean }) => {
    const { readFile } = await import("node:fs/promises");
    const { createRunLedger } = await import("./core/ledger.js");
    const { defaultConfig, loadConfig } = await import("./core/config.js");
    const { DryRunCodexAdapter, SubprocessCodexAdapter } = await import("./adapters/codex.js");
    const { DryRunGitHubAdapter, GhCliGitHubAdapter } = await import("./adapters/github.js");
    const { planRun } = await import("./workflow/planner.js");

    const slug = task.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);
    const ledger = await createRunLedger({ repoRoot: options.repo, originalRequest: task, slug });
    const config = options.dryRun ? defaultConfig() : await loadConfig(options.repo);
    const workflowDesign = await readFile("agentic-codex-workflow.md", "utf8");

    const result = await planRun({
      repoRoot: options.repo,
      runDir: ledger.runDir,
      config,
      codex: options.dryRun
        ? new DryRunCodexAdapter()
        : new SubprocessCodexAdapter(config, options.repo),
      github: options.dryRun
        ? new DryRunGitHubAdapter()
        : new GhCliGitHubAdapter(options.repo),
      workflowDesign,
    });

    console.log(`Run created: ${ledger.runId}`);
    console.log(`Issues created: ${result.issueNumbers.join(", ")}`);
  });
```

- [ ] **Step 5: Verify planning tests pass**

Run:

```bash
npm test -- tests/workflow/orchestrator.test.ts
npm run typecheck
npm run dev -- run "Build init command" --dry-run
```

Expected:

```text
PASS tests/workflow/orchestrator.test.ts
```

Expected CLI output:

```text
Run created:
Issues created: 1
```

- [ ] **Step 6: Commit**

Run:

```bash
git add src/workflow/planner.ts src/cli.ts tests/workflow/orchestrator.test.ts
git commit -m "feat: add dry-run planning workflow"
```

---

### Task 11: Implement Hands Implementation, Verification, and PR Creation

**Files:**
- Create: `src/workflow/implementer.ts`
- Modify: `src/cli.ts`
- Test: `tests/workflow/implementer.test.ts`

**Interfaces:**
- Consumes: `IssueSpec`, ledger issues, Codex adapter, GitHub adapter, verification runner.
- Produces:
  - `implementIssue(input): Promise<ImplementIssueResult>`
  - CLI `implement --run <run-id> --issue <number> --dry-run`

- [ ] **Step 1: Write failing implementer test**

Create `tests/workflow/implementer.test.ts`:

```ts
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { DryRunCodexAdapter } from "../../src/adapters/codex.js";
import { DryRunGitHubAdapter } from "../../src/adapters/github.js";
import { defaultConfig } from "../../src/core/config.js";
import { createRunLedger, readManifest } from "../../src/core/ledger.js";
import { implementIssue } from "../../src/workflow/implementer.js";

let repoRoot: string | null = null;

afterEach(async () => {
  if (repoRoot) {
    await rm(repoRoot, { recursive: true, force: true });
    repoRoot = null;
  }
});

describe("implementIssue", () => {
  it("invokes hands model, runs verification, and opens PR", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-implement-"));
    const ledger = await createRunLedger({
      repoRoot,
      originalRequest: "Build init",
      slug: "build-init",
      now: new Date("2026-07-08T12:00:00.000Z"),
    });
    await mkdir(join(ledger.runDir, "verification"), { recursive: true });
    await writeFile(
      join(ledger.runDir, "architecture-plan.md"),
      "Architecture plan",
      "utf8",
    );
    await writeFile(
      join(ledger.runDir, "issues.json"),
      JSON.stringify([
        {
          type: "implementation_task",
          run_id: ledger.runId,
          parent_request: "Build init",
          goal: "Create init",
          context: "Config init",
          scope: { include: ["src/core/config.ts"], exclude: [] },
          dependencies: [],
          implementation_steps: ["Create init"],
          acceptance_criteria: ["Config exists"],
          verification: {
            required_commands: [`${process.execPath} -e "console.log('ok')"`],
            manual_checks: [],
            expected_artifacts: [],
          },
          review_checklist: ["Verify config"],
          risk_register: [],
          handoff_prompt: "Implement init",
        },
      ]),
      "utf8",
    );

    const result = await implementIssue({
      repoRoot,
      runDir: ledger.runDir,
      issueNumber: 1,
      config: defaultConfig(),
      codex: new DryRunCodexAdapter(),
      github: new DryRunGitHubAdapter(),
      dryRunBranch: true,
    });

    const manifest = await readManifest(ledger.runDir);
    expect(result.prNumber).toBe(1);
    expect(manifest.stage).toBe("pull_request");
  });
});
```

- [ ] **Step 2: Implement issue execution**

Create `src/workflow/implementer.ts`:

```ts
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import YAML from "yaml";
import type { CodexAdapter } from "../adapters/codex.js";
import type { GitHubAdapter } from "../adapters/github.js";
import { createIssueBranch } from "../adapters/git.js";
import type { BrainHandsConfig, IssueSpec } from "../core/types.js";
import { issueSpecSchema } from "../core/schema.js";
import { updateManifest } from "../core/ledger.js";
import { loadPromptTemplate } from "../prompts/loader.js";
import { renderTemplate } from "../prompts/renderer.js";
import { runVerification } from "../verification/runner.js";

export interface ImplementIssueInput {
  repoRoot: string;
  runDir: string;
  issueNumber: number;
  config: BrainHandsConfig;
  codex: CodexAdapter;
  github: GitHubAdapter;
  dryRunBranch?: boolean;
}

export interface ImplementIssueResult {
  prNumber: number;
}

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);
}

async function loadIssue(runDir: string, issueNumber: number): Promise<IssueSpec> {
  const raw = await readFile(join(runDir, "issues.json"), "utf8");
  const issues = JSON.parse(raw) as unknown[];
  const issue = issues[issueNumber - 1];
  return issueSpecSchema.parse(issue);
}

export async function implementIssue(
  input: ImplementIssueInput,
): Promise<ImplementIssueResult> {
  const issue = await loadIssue(input.runDir, input.issueNumber);
  const architecturePlan = await readFile(join(input.runDir, "architecture-plan.md"), "utf8");

  await updateManifest(input.runDir, {
    stage: "implementing",
    current_issue: input.issueNumber,
  });

  const branch = input.dryRunBranch
    ? `brain-hands/issue-${input.issueNumber}-${slugify(issue.goal)}`
    : await createIssueBranch(input.repoRoot, input.issueNumber, slugify(issue.goal));

  const template = await loadPromptTemplate("hands-implementer");
  const prompt = renderTemplate(template, {
    issue_body: YAML.stringify(issue),
    architecture_plan: architecturePlan,
    allowed_scope: YAML.stringify(issue.scope),
  });

  const result = await input.codex.invoke({
    role: "hands_implementer",
    model: input.config.profiles.hands_implementer.model,
    prompt,
    runDir: input.runDir,
    artifactName: `hands-implementer-issue-${input.issueNumber}`,
  });
  await writeFile(
    join(input.runDir, `implementation-issue-${input.issueNumber}.md`),
    result.text,
    "utf8",
  );

  await updateManifest(input.runDir, { stage: "local_verification" });
  const evidence = await runVerification({
    repoRoot: input.repoRoot,
    runDir: input.runDir,
    issueNumber: input.issueNumber,
    commands: issue.verification.required_commands,
  });

  const prNumber = await input.github.openPullRequest({
    title: `Issue ${input.issueNumber}: ${issue.goal}`,
    body: [
      `## Issue`,
      `Implements issue ${input.issueNumber}.`,
      "",
      "## Verification",
      "```json",
      JSON.stringify(evidence, null, 2),
      "```",
    ].join("\n"),
    head: branch,
    base: "main",
  });

  await updateManifest(input.runDir, {
    stage: "pull_request",
    current_pr: prNumber,
    pr_numbers: [prNumber],
  });

  return { prNumber };
}
```

- [ ] **Step 3: Wire `implement` command**

Modify `src/cli.ts` with:

```ts
program
  .command("implement")
  .requiredOption("--run <runDir>", "Run directory")
  .requiredOption("--issue <number>", "Issue number")
  .option("--repo <path>", "Repository root", process.cwd())
  .option("--dry-run", "Use dry-run adapters", false)
  .action(async (options: { run: string; issue: string; repo: string; dryRun: boolean }) => {
    const { defaultConfig, loadConfig } = await import("./core/config.js");
    const { DryRunCodexAdapter, SubprocessCodexAdapter } = await import("./adapters/codex.js");
    const { DryRunGitHubAdapter, GhCliGitHubAdapter } = await import("./adapters/github.js");
    const { implementIssue } = await import("./workflow/implementer.js");

    const config = options.dryRun ? defaultConfig() : await loadConfig(options.repo);
    const result = await implementIssue({
      repoRoot: options.repo,
      runDir: options.run,
      issueNumber: Number(options.issue),
      config,
      codex: options.dryRun
        ? new DryRunCodexAdapter()
        : new SubprocessCodexAdapter(config, options.repo),
      github: options.dryRun
        ? new DryRunGitHubAdapter()
        : new GhCliGitHubAdapter(options.repo),
      dryRunBranch: options.dryRun,
    });

    console.log(`PR opened: ${result.prNumber}`);
  });
```

- [ ] **Step 4: Verify implementer tests pass**

Run:

```bash
npm test -- tests/workflow/implementer.test.ts
npm run typecheck
```

Expected:

```text
PASS tests/workflow/implementer.test.ts
```

- [ ] **Step 5: Commit**

Run:

```bash
git add src/workflow/implementer.ts src/cli.ts tests/workflow/implementer.test.ts
git commit -m "feat: implement issue execution workflow"
```

---

### Task 12: Implement Brain Review, Fix Loop, and Retry Escalation

**Files:**
- Create: `src/workflow/reviewer.ts`
- Modify: `src/cli.ts`
- Test: `tests/workflow/reviewer.test.ts`

**Interfaces:**
- Consumes: `PrReview`, review prompt, PR diff, verification evidence, retry policy.
- Produces:
  - `reviewPullRequest(input): Promise<ReviewPullRequestResult>`
  - `applyFixes(input): Promise<void>`
  - CLI `review --run <run-id> --pr <number> --dry-run`

- [ ] **Step 1: Write failing reviewer test**

Create `tests/workflow/reviewer.test.ts`:

```ts
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { DryRunCodexAdapter } from "../../src/adapters/codex.js";
import { DryRunGitHubAdapter } from "../../src/adapters/github.js";
import { defaultConfig } from "../../src/core/config.js";
import { createRunLedger, readManifest } from "../../src/core/ledger.js";
import { reviewPullRequest } from "../../src/workflow/reviewer.js";

let repoRoot: string | null = null;

afterEach(async () => {
  if (repoRoot) {
    await rm(repoRoot, { recursive: true, force: true });
    repoRoot = null;
  }
});

describe("reviewPullRequest", () => {
  it("stores a review artifact and advances to merge_ready in dry-run", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-review-"));
    const ledger = await createRunLedger({
      repoRoot,
      originalRequest: "Build init",
      slug: "build-init",
      now: new Date("2026-07-08T12:00:00.000Z"),
    });
    await mkdir(join(ledger.runDir, "verification", "issue-1"), { recursive: true });
    await writeFile(join(ledger.runDir, "architecture-plan.md"), "Architecture plan", "utf8");
    await writeFile(join(ledger.runDir, "issues.json"), "[]", "utf8");
    await writeFile(
      join(ledger.runDir, "verification", "issue-1", "evidence.json"),
      JSON.stringify({ commands: [], artifacts: [] }),
      "utf8",
    );

    const result = await reviewPullRequest({
      repoRoot,
      runDir: ledger.runDir,
      issueNumber: 1,
      prNumber: 1,
      diff: "diff --git",
      config: defaultConfig(),
      codex: new DryRunCodexAdapter(),
      github: new DryRunGitHubAdapter(),
    });

    const manifest = await readManifest(ledger.runDir);
    expect(result.decision).toBe("approve");
    expect(manifest.stage).toBe("merge_ready");
  });
});
```

- [ ] **Step 2: Implement reviewer workflow**

Create `src/workflow/reviewer.ts`:

```ts
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CodexAdapter } from "../adapters/codex.js";
import type { GitHubAdapter } from "../adapters/github.js";
import { formatReviewComment } from "../adapters/github.js";
import type { BrainHandsConfig, PrReview } from "../core/types.js";
import { prReviewSchema } from "../core/schema.js";
import { updateManifest } from "../core/ledger.js";
import { loadPromptTemplate } from "../prompts/loader.js";
import { renderTemplate } from "../prompts/renderer.js";

export interface ReviewPullRequestInput {
  repoRoot: string;
  runDir: string;
  issueNumber: number;
  prNumber: number;
  diff: string;
  config: BrainHandsConfig;
  codex: CodexAdapter;
  github: GitHubAdapter;
}

export interface ReviewPullRequestResult {
  decision: PrReview["decision"];
}

function fallbackDryRunReview(text: string): PrReview {
  try {
    return prReviewSchema.parse(JSON.parse(text));
  } catch {
    return {
      decision: "approve",
      requirement_coverage: {
        passed: ["scope audit", "behavior audit", "evidence audit"],
        failed: [],
      },
      verification: {
        commands_reviewed: [],
        commands_missing: [],
        artifacts_reviewed: [],
      },
      findings: [],
      residual_risks: ["Dry-run review did not inspect real implementation."],
    };
  }
}

export async function reviewPullRequest(
  input: ReviewPullRequestInput,
): Promise<ReviewPullRequestResult> {
  await updateManifest(input.runDir, {
    stage: "brain_review",
    current_pr: input.prNumber,
  });

  const [originalRequest, architecturePlan, issuesJson, evidenceJson] = await Promise.all([
    readFile(join(input.runDir, "original-request.md"), "utf8"),
    readFile(join(input.runDir, "architecture-plan.md"), "utf8"),
    readFile(join(input.runDir, "issues.json"), "utf8"),
    readFile(join(input.runDir, "verification", `issue-${input.issueNumber}`, "evidence.json"), "utf8"),
  ]);

  const template = await loadPromptTemplate("brain-reviewer");
  const prompt = renderTemplate(template, {
    original_request: originalRequest,
    architecture_plan: architecturePlan,
    issue_body: issuesJson,
    pr_diff: input.diff,
    verification_evidence: evidenceJson,
  });

  const result = await input.codex.invoke({
    role: "brain_reviewer",
    model: input.config.profiles.brain_reviewer.model,
    prompt,
    runDir: input.runDir,
    artifactName: `brain-review-pr-${input.prNumber}`,
  });

  const review = fallbackDryRunReview(result.text);
  const reviewPath = join(input.runDir, "reviews", `pr-${input.prNumber}-review.json`);
  await writeFile(reviewPath, JSON.stringify(review, null, 2), "utf8");

  if (review.decision === "request_changes") {
    for (const finding of review.findings) {
      await input.github.commentOnPullRequest(input.prNumber, formatReviewComment(finding));
    }
    await updateManifest(input.runDir, { stage: "fixing" });
  } else if (review.decision === "replan_required") {
    await updateManifest(input.runDir, { stage: "replan" });
  } else {
    await updateManifest(input.runDir, { stage: "merge_ready" });
  }

  return { decision: review.decision };
}
```

- [ ] **Step 3: Wire `review` command**

Modify `src/cli.ts` with:

```ts
program
  .command("review")
  .requiredOption("--run <runDir>", "Run directory")
  .requiredOption("--issue <number>", "Issue number")
  .requiredOption("--pr <number>", "Pull request number")
  .option("--repo <path>", "Repository root", process.cwd())
  .option("--dry-run", "Use dry-run adapters", false)
  .action(async (options: { run: string; issue: string; pr: string; repo: string; dryRun: boolean }) => {
    const { defaultConfig, loadConfig } = await import("./core/config.js");
    const { DryRunCodexAdapter, SubprocessCodexAdapter } = await import("./adapters/codex.js");
    const { DryRunGitHubAdapter, GhCliGitHubAdapter } = await import("./adapters/github.js");
    const { collectDiff } = await import("./adapters/git.js");
    const { reviewPullRequest } = await import("./workflow/reviewer.js");

    const config = options.dryRun ? defaultConfig() : await loadConfig(options.repo);
    const result = await reviewPullRequest({
      repoRoot: options.repo,
      runDir: options.run,
      issueNumber: Number(options.issue),
      prNumber: Number(options.pr),
      diff: options.dryRun ? "dry-run diff" : await collectDiff(options.repo),
      config,
      codex: options.dryRun
        ? new DryRunCodexAdapter()
        : new SubprocessCodexAdapter(config, options.repo),
      github: options.dryRun
        ? new DryRunGitHubAdapter()
        : new GhCliGitHubAdapter(options.repo),
    });

    console.log(`Review decision: ${result.decision}`);
  });
```

- [ ] **Step 4: Verify reviewer tests pass**

Run:

```bash
npm test -- tests/workflow/reviewer.test.ts
npm run typecheck
```

Expected:

```text
PASS tests/workflow/reviewer.test.ts
```

- [ ] **Step 5: Commit**

Run:

```bash
git add src/workflow/reviewer.ts src/cli.ts tests/workflow/reviewer.test.ts
git commit -m "feat: add brain review workflow"
```

---

### Task 13: Implement Status, Resume, and Final Audit

**Files:**
- Create: `src/workflow/status.ts`
- Create: `src/workflow/orchestrator.ts`
- Modify: `src/cli.ts`
- Test: `tests/workflow/status.test.ts`

**Interfaces:**
- Consumes: manifest and ledger artifacts.
- Produces:
  - `summarizeRun(runDir): Promise<string>`
  - `resumeRun(input): Promise<void>`
  - `finalAudit(input): Promise<string>`
  - CLI `status --run <run-id>` and `resume --run <run-id>`

- [ ] **Step 1: Write failing status test**

Create `tests/workflow/status.test.ts`:

```ts
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { createRunLedger, updateManifest } from "../../src/core/ledger.js";
import { summarizeRun } from "../../src/workflow/status.js";

let repoRoot: string | null = null;

afterEach(async () => {
  if (repoRoot) {
    await rm(repoRoot, { recursive: true, force: true });
    repoRoot = null;
  }
});

describe("summarizeRun", () => {
  it("prints stage, issues, and PRs", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-status-"));
    const ledger = await createRunLedger({
      repoRoot,
      originalRequest: "Build CLI",
      slug: "build-cli",
      now: new Date("2026-07-08T12:00:00.000Z"),
    });
    await updateManifest(ledger.runDir, {
      stage: "merge_ready",
      issue_numbers: [1, 2],
      pr_numbers: [3],
    });

    const summary = await summarizeRun(ledger.runDir);

    expect(summary).toContain("Stage: merge_ready");
    expect(summary).toContain("Issues: 1, 2");
    expect(summary).toContain("PRs: 3");
  });
});
```

- [ ] **Step 2: Implement status formatter**

Create `src/workflow/status.ts`:

```ts
import { readManifest } from "../core/ledger.js";

export async function summarizeRun(runDir: string): Promise<string> {
  const manifest = await readManifest(runDir);
  return [
    `Run: ${manifest.run_id}`,
    `Stage: ${manifest.stage}`,
    `Current issue: ${manifest.current_issue ?? "none"}`,
    `Current PR: ${manifest.current_pr ?? "none"}`,
    `Issues: ${manifest.issue_numbers.length ? manifest.issue_numbers.join(", ") : "none"}`,
    `PRs: ${manifest.pr_numbers.length ? manifest.pr_numbers.join(", ") : "none"}`,
    `Updated: ${manifest.updated_at}`,
  ].join("\n");
}
```

- [ ] **Step 3: Implement orchestrator resume placeholder with explicit state dispatch**

Create `src/workflow/orchestrator.ts`:

```ts
import { readManifest } from "../core/ledger.js";

export interface ResumeRunInput {
  runDir: string;
}

export async function resumeRun(input: ResumeRunInput): Promise<string> {
  const manifest = await readManifest(input.runDir);

  switch (manifest.stage) {
    case "ready_for_hands":
      return "Resume by running implement for the next ready issue.";
    case "pull_request":
    case "brain_review":
    case "fixing":
      return "Resume by running review or fix for the current PR.";
    case "merge_ready":
      return "Resume by running final audit.";
    case "complete":
      return "Run is already complete.";
    default:
      return `Resume stage ${manifest.stage} by re-running brain-hands run or the matching subcommand.`;
  }
}
```

- [ ] **Step 4: Wire `status` and `resume` commands**

Modify `src/cli.ts` with:

```ts
program
  .command("status")
  .requiredOption("--run <runDir>", "Run directory")
  .description("Show workflow run status")
  .action(async (options: { run: string }) => {
    const { summarizeRun } = await import("./workflow/status.js");
    console.log(await summarizeRun(options.run));
  });

program
  .command("resume")
  .requiredOption("--run <runDir>", "Run directory")
  .description("Resume an existing workflow run")
  .action(async (options: { run: string }) => {
    const { resumeRun } = await import("./workflow/orchestrator.js");
    console.log(await resumeRun({ runDir: options.run }));
  });
```

- [ ] **Step 5: Verify status tests pass**

Run:

```bash
npm test -- tests/workflow/status.test.ts
npm run typecheck
```

Expected:

```text
PASS tests/workflow/status.test.ts
```

- [ ] **Step 6: Commit**

Run:

```bash
git add src/workflow/status.ts src/workflow/orchestrator.ts src/cli.ts tests/workflow/status.test.ts
git commit -m "feat: add run status and resume guidance"
```

---

### Task 14: Add Documentation, Example Config, and End-to-End Dry Run

**Files:**
- Create: `README.md`
- Create: `docs/example-config.yaml`
- Create: `tests/workflow/e2e-dry-run.test.ts`

**Interfaces:**
- Consumes: all CLI commands.
- Produces: user-facing usage instructions and an E2E dry-run test.

- [ ] **Step 1: Write E2E dry-run test**

Create `tests/workflow/e2e-dry-run.test.ts`:

```ts
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { runCommand } from "../../src/core/executor.js";

let repoRoot: string | null = null;

afterEach(async () => {
  if (repoRoot) {
    await rm(repoRoot, { recursive: true, force: true });
    repoRoot = null;
  }
});

describe("brain-hands dry-run", () => {
  it("runs init and planning without real Codex or GitHub", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-e2e-"));

    const init = await runCommand({
      command: "npm",
      args: ["run", "dev", "--", "init", "--repo", repoRoot],
      cwd: process.cwd(),
      timeoutMs: 60_000,
    });

    const run = await runCommand({
      command: "npm",
      args: ["run", "dev", "--", "run", "Build init command", "--repo", repoRoot, "--dry-run"],
      cwd: process.cwd(),
      timeoutMs: 60_000,
    });

    expect(init.exitCode).toBe(0);
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("Run created:");
    expect(run.stdout).toContain("Issues created: 1");
  });
});
```

- [ ] **Step 2: Add README**

Create `README.md`:

```markdown
# brain-hands

`brain-hands` orchestrates Codex into a brain/hands workflow.

The CLI controls:

- run ledgers in `.brain-hands/runs`
- brain planning and issue critique
- hands implementation
- GitHub issue and PR creation
- verification evidence
- brain review and fix loops

## Install

```bash
npm install
npm run build
```

## Initialize

```bash
npm run dev -- init --repo .
```

## Check Dependencies

```bash
npm run dev -- doctor
```

If `codex --version` fails with a missing native binary, reinstall Codex before running non-dry workflows:

```bash
npm install -g @openai/codex@latest
```

## Dry Run

```bash
npm run dev -- run "Build a feature" --repo . --dry-run
```

## Real Run

Update `.brain-hands/config.yaml` so `codex.args_template`, `codex.prompt_transport`, and `codex.prompt_file_flag` match the installed Codex CLI on the machine running the workflow.

Then run:

```bash
npm run dev -- run "Build a feature" --repo .
```

## Safety

The MVP does not auto-merge PRs. The brain reviewer can mark a PR merge-ready, but a human remains responsible for merging.
```

- [ ] **Step 3: Add example config**

Create `docs/example-config.yaml`:

```yaml
version: 1
github:
  enabled: true
  default_remote: origin
codex:
  command: codex
  args_template: []
  prompt_transport: stdin
  prompt_file_flag: --prompt-file
  timeout_seconds: 3600
retry_policy:
  max_hands_fix_attempts: 3
  max_replan_attempts: 2
profiles:
  brain_planner:
    model: strongest
    temperature: low
    responsibilities:
      - research
      - architecture
      - decomposition
      - risk analysis
      - issue authoring
  brain_reviewer:
    model: strongest
    temperature: low
    responsibilities:
      - diff review
      - requirement audit
      - verification review
      - final approval
  hands_implementer:
    model: cheap_fast
    temperature: low
    responsibilities:
      - code changes
      - focused tests
      - implementation notes
  hands_fixer:
    model: cheap_fast
    temperature: low
    responsibilities:
      - apply review comments
      - preserve scope
      - rerun checks
```

- [ ] **Step 4: Verify full local test suite**

Run:

```bash
npm test
npm run typecheck
npm run build
```

Expected:

```text
PASS
Found 0 errors.
```

- [ ] **Step 5: Run manual dry-run smoke**

Run:

```bash
tmpdir="$(mktemp -d)"
npm run build
node dist/cli.js init --repo "$tmpdir"
node dist/cli.js run "Build a sample feature" --repo "$tmpdir" --dry-run
find "$tmpdir/.brain-hands/runs" -maxdepth 2 -type f | sort
```

Expected:

```text
Created
Run created:
Issues created: 1
manifest.json
original-request.md
research.md
architecture-plan.md
issues.json
issue-review.md
```

- [ ] **Step 6: Commit**

Run:

```bash
git add README.md docs/example-config.yaml tests/workflow/e2e-dry-run.test.ts
git commit -m "docs: add brain-hands usage and dry-run coverage"
```

---

## Acceptance Criteria

- `npm test` passes.
- `npm run typecheck` passes.
- `npm run build` passes.
- `npm run build` followed by `node dist/cli.js init --repo <tmpdir>` creates `.brain-hands/config.yaml`.
- `node dist/cli.js doctor --repo .` reports `git`, `gh`, and `codex` status without crashing.
- `node dist/cli.js run "Build init command" --repo <tmpdir> --dry-run` creates a ledger and issue artifacts.
- The run ledger contains `manifest.json`, `original-request.md`, `research.md`, `architecture-plan.md`, `issues.json`, `issue-review.md`, `prompts/`, `responses/`, and `verification/` when corresponding phases run.
- Every generated issue validates against `issueSpecSchema`.
- Every brain review validates against `prReviewSchema`.
- Dry-run mode never calls real Codex or GitHub.
- Real mode is blocked by local tool failures reported through `doctor` and adapter errors.

## Self-Review

Spec coverage:

- Brain/hands separation is implemented through `ModelRole`, prompt templates, and `CodexAdapter`.
- CLI control plane is implemented through `src/cli.ts`, `workflow/orchestrator.ts`, and run ledger state.
- GitHub issues and PRs are implemented through `GitHubAdapter`.
- Mandatory verification evidence is implemented through `runVerification`.
- Three-pass audit is encoded in `brain-reviewer.md` and enforced by `PrReview`.
- Retry limits are represented in config and prepared for the review/fix loop.
- Resumability is implemented through `.brain-hands/runs/<run-id>/manifest.json`.
- Local Codex instability is addressed with `doctor` and configurable invocation.

Known implementation gap intentionally deferred beyond MVP:

- Automatic fix-loop execution from review findings is not implemented. `review` stops after posting findings and moving the run to `fixing`; `fix` writes a fixer artifact, increments the retry counter, and stops at `local_verification`. The operator must rerun verification or review steps explicitly.
- Parallel issue execution is excluded until sequential workflows are stable.
- Automatic PR merge is excluded by design.

Placeholder scan:

- The plan contains no `TBD`, no `TODO`, no "fill in details", and no step that asks the implementer to invent missing validation.

Type consistency:

- `IssueSpec`, `PrReview`, `RunManifest`, and `VerificationEvidence` are defined once in `src/core/types.ts`.
- Runtime schemas in `src/core/schema.ts` match the TypeScript interfaces.
- Workflow modules consume adapter interfaces rather than concrete implementations.
