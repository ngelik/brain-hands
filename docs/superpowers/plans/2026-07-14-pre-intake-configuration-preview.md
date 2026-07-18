# Pre-Intake Configuration Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Repository instructions permit subagents only when the user explicitly asks for them.

**Goal:** Make every Brain Hands conversation show one complete, engine-owned, read-only configuration preview before asking for unresolved execution choices, then provide versioned CLI and skill installation paths that can be verified independently.

**Architecture:** Keep the existing resolved run configuration strict and execution-only. Add a sibling preview projection whose three intake choices are nullable, whose `missing_choices` list is deterministic, and whose remaining values come from the same validated repository config and policy resolvers as `run`. A new `preview` CLI command renders that projection without creating a run, invoking preflight or a model, or touching GitHub; the conversational skill displays the engine-rendered preview verbatim before intake questions. The npm CLI and Codex skill remain separate distribution surfaces: npm stays runtime-only, while a repository marketplace manifest provides a versioned plugin installation path.

**Tech Stack:** TypeScript 6, Node.js 20+, Commander 15, Zod 4, YAML 2, Vitest 4, Codex plugins.

## Global Constraints

- Work on `main`; do not create a feature branch unless the user changes the instruction.
- Preserve the current unrelated modifications in `src/adapters/codex.ts`, `src/core/output-schemas.ts`, `tests/adapters/codex.test.ts`, `tests/core/schema.test.ts`, and `tests/workflow/replan.test.ts`.
- Do not run `brain-hands run`; this feature concerns pre-run intake and must not create a workflow run while being implemented or tested.
- `resolvedRunConfigurationSchema` and `run-configuration.json` remain fully resolved; pending values must never enter an executable intake or durable run artifact.
- Preview is always read-only: no run directory, ledger, preflight, Codex/model invocation, config migration, GitHub lookup, GitHub mutation, or target-repository write.
- Read config with `loadConfig(repoRoot, { migrate: false })`; previewing a v1 config must not create `.v1.bak` or rewrite `config.yaml`.
- Missing choices are ordered exactly as `mode`, `research`, `reflection` and are never defaulted silently.
- Model overrides change only the model and source label; reasoning effort and sandbox continue to come from the role's validated repository profile.
- Human and JSON output expose only the approved allowlist. Never expose controller executable/package paths, runtime hashes, candidate commits, Codex commands, prompts, credentials, environment values, or raw YAML.
- The preview must show repository, config source, controller name/version/mode, all three choices, all three roles, Hands backup, retry/replan/review/quality policies, GitHub remote, and conditional GitHub effects.
- `github.effects` is `depends_on_execution_mode` while mode is pending, `none` in local mode, and `issues_and_pull_request` in GitHub mode.
- Do not add runtime dependencies.
- Keep the npm `files` allowlist exactly `dist/`, `prompts/`, `agentic-codex-workflow.md`, and `README.md`; distribute the skill through the Codex plugin surface instead of putting `.agents/` back into npm.
- A stable release and any global CLI/plugin installation are separate, explicitly authorized operator actions after implementation is committed, pushed, and the checkout is clean.

## Success Criteria

1. `brain-hands preview --repo <repo> --json` returns one strict safe object containing all known effective settings, `missing_choices`, and `rendered_preview`.
2. With no choices, the first line is `Brain Hands configuration preview (3 choices pending)` and mode/research/reflection are visibly pending.
3. Supplying any subset of choices reduces `missing_choices` and changes only the corresponding display lines and conditional GitHub effects.
4. A fully specified preview matches `resolveRunConfiguration()` field-for-field after removing preview-only metadata.
5. Preview of valid v1 and v2 configs is byte-for-byte non-mutating; missing/invalid config fails with actionable initialization/validation output.
6. Preview never calls ledger creation, preflight, Codex, GitHub, or repository initialization code and never creates `.brain-hands/runs`.
7. The skill invokes preview immediately after initialization validation, displays `rendered_preview` verbatim before questions, and asks only the returned `missing_choices`.
8. The default skill prompt explicitly requires the complete preview before intake questions.
9. The npm tarball stays runtime-only, while an isolated Codex plugin install discovers the updated skill from the repository marketplace manifest.
10. Full repository gates, isolated tarball install, installed CLI preview smoke, isolated plugin install, and a fresh-task conversational smoke all pass.
11. Stable self-hosting provenance hashes exactly the published npm runtime surfaces; it does not require separately distributed skill/plugin files inside the npm install.

## File Structure

**Create**

- `.agents/plugins/marketplace.json` — versioned Codex marketplace entry for the existing `brain-hands` plugin.
- `docs/superpowers/plans/2026-07-14-pre-intake-configuration-preview.md` — this implementation plan.

**Modify**

- `src/core/run-configuration.ts` — preview schema, preview resolver, consistency validation, and shared safe renderer helpers.
- `tests/core/run-configuration.test.ts` — partial-choice, full-parity, policy-default, rendering, and leakage tests.
- `src/cli.ts` — register the read-only `preview` command and reuse the existing parsing/config/provenance paths safely.
- `tests/cli-smoke.test.ts` — CLI registration, JSON/text output, invalid input, non-mutation, and forbidden-call tests.
- `.agents/skills/brain-hands/scripts/brain-hands.mjs` — allow `preview` after version selection without the heavier `doctor` capability handshake.
- `tests/scripts/brain-hands-wrapper.test.ts` — prove preview selects the compatible controller and skips `doctor` while normal commands still require it.
- `.agents/skills/brain-hands/SKILL.md` — mandatory preview-before-questions conversational protocol.
- `.agents/skills/brain-hands/agents/openai.yaml` — startup visibility in the default prompt.
- `tests/skill-layout.test.ts` — enforce preview command, approved fields, ordering, verbatim rendering, prompt wording, and marketplace metadata.
- `.agents/skills/brain-hands/references/cli-contract.md` — machine and human preview contract.
- `README.md` — operator-facing preview examples, side-effect boundary, and skill installation path.
- `docs/RELEASING.md` — separate npm CLI publication from Codex plugin refresh and fresh-task verification.
- `src/core/controller-provenance.ts` — align the hashed controller runtime tree with the narrowed npm package.
- `tests/core/controller-provenance.test.ts` — prove installed runtime hashing neither requires nor includes separately distributed skill files.

**Release-only version synchronization after implementation approval**

- `package.json`
- `package-lock.json`
- `.codex-plugin/plugin.json`
- `.agents/skills/brain-hands/SKILL.md`

---

### Task 1: Define the strict partial preview projection

**Files:**

- Modify: `src/core/run-configuration.ts`
- Modify: `tests/core/run-configuration.test.ts`

**Interfaces:**

- Produces: `missingRunChoiceSchema` and `MissingRunChoice = "mode" | "research" | "reflection"`.
- Produces: `runConfigurationPreviewSchema` and `RunConfigurationPreview`.
- Produces: `resolveRunConfigurationPreview(input)` where choices are optional and no execution intake is created.
- Produces: `renderRunConfigurationPreview(preview)` and preserves `renderRunConfiguration(configuration)`.
- Preserves: existing `ResolvedRunConfiguration`, `resolveRunConfiguration()`, and durable `run-configuration.json` semantics.

- [ ] **Step 1: Add failing tests for an all-pending preview**

Add one fixture builder in `tests/core/run-configuration.test.ts` using `defaultConfig()` and the safe subset of a controller provenance object. Assert the exact projection:

```ts
const preview = resolveRunConfigurationPreview({
  repository: "/tmp/example",
  config: defaultConfig(),
  controller: {
    package_name: "@ngelik/brain-hands",
    package_version: "0.3.5",
    mode: "installed",
  },
  choices: {},
  overrides: {},
});

expect(preview).toMatchObject({
  version: 1,
  repository: "/tmp/example",
  configuration: {
    path: ".brain-hands/config.yaml",
    source: "repository_config",
  },
  mode: null,
  research: null,
  reflection: null,
  missing_choices: ["mode", "research", "reflection"],
  controller: {
    package_name: "@ngelik/brain-hands",
    package_version: "0.3.5",
    mode: "installed",
  },
  roles: {
    brain: { model: "gpt-5.6-sol", reasoning_effort: "high", sandbox: "read-only", source: "repository_config" },
    hands: { model: "gpt-5.6-luna", reasoning_effort: "xhigh", sandbox: "workspace-write", source: "repository_config" },
    verifier: { model: "gpt-5.6-sol", reasoning_effort: "high", sandbox: "read-only", source: "repository_config" },
  },
  hands_backup: null,
  limits: {
    max_hands_fix_attempts: 3,
    max_replan_attempts: 2,
    review_policy: { max_fix_cycles: 2, on_limit: "auto_replan" },
    quality_gate: {
      hands_self_review_passes: 2,
      max_attempts_per_reviewer_action: 2,
      require_focused_verifier_confirmation: true,
    },
  },
  github: {
    effects: "depends_on_execution_mode",
    default_remote: "origin",
  },
});
```

Also assert `renderRunConfigurationPreview(preview)` contains the exact header, three `needs your choice` lines, all policy lines, `GitHub remote: origin`, and `GitHub effects: depends on execution-mode choice`.

- [ ] **Step 2: Run the focused test and confirm it fails**

Run: `npx vitest run tests/core/run-configuration.test.ts`

Expected: FAIL because the preview schema, resolver, and renderer do not exist.

- [ ] **Step 3: Add a separate preview schema without weakening the resolved schema**

In `src/core/run-configuration.ts`, retain the current resolved schema and factor only the duplicated allowlisted field definitions into constants:

```ts
export const missingRunChoiceSchema = z.enum(["mode", "research", "reflection"]);
export type MissingRunChoice = z.infer<typeof missingRunChoiceSchema>;

const controllerDisplaySchema = z.object({
  package_name: z.string().min(1),
  package_version: z.string().regex(/^\d+\.\d+\.\d+$/),
  mode: z.enum(["installed", "development_checkout"]),
}).strict();

const configurationSourceSchema = z.object({
  path: z.literal(".brain-hands/config.yaml"),
  source: z.literal("repository_config"),
}).strict();

export const runConfigurationPreviewSchema = z.object({
  version: z.literal(1),
  repository: z.string().min(1),
  configuration: configurationSourceSchema,
  mode: z.enum(["local", "github"]).nullable(),
  research: z.boolean().nullable(),
  reflection: z.boolean().nullable(),
  missing_choices: z.array(missingRunChoiceSchema).max(3),
  controller: controllerDisplaySchema,
  roles: z.object({
    brain: visibleRoleProfileSchema,
    hands: visibleRoleProfileSchema,
    verifier: visibleRoleProfileSchema,
  }).strict(),
  hands_backup: handsBackupPolicySchema.nullable(),
  limits: z.object({
    max_hands_fix_attempts: z.number().int().positive(),
    max_replan_attempts: z.number().int().nonnegative(),
    review_policy: reviewPolicySchema,
    quality_gate: qualityGatePolicySchema.nullable(),
  }).strict(),
  github: z.object({
    effects: z.enum(["depends_on_execution_mode", "none", "issues_and_pull_request"]),
    default_remote: z.string().min(1),
  }).strict(),
}).strict().superRefine((preview, context) => {
  const expected: MissingRunChoice[] = [];
  if (preview.mode === null) expected.push("mode");
  if (preview.research === null) expected.push("research");
  if (preview.reflection === null) expected.push("reflection");
  if (JSON.stringify(preview.missing_choices) !== JSON.stringify(expected)) {
    context.addIssue({ code: "custom", path: ["missing_choices"], message: "missing_choices must match unresolved choices in canonical order" });
  }
  const effects = preview.mode === null
    ? "depends_on_execution_mode"
    : preview.mode === "github"
      ? "issues_and_pull_request"
      : "none";
  if (preview.github.effects !== effects) {
    context.addIssue({ code: "custom", path: ["github", "effects"], message: "GitHub effects must match the execution mode" });
  }
});

export type RunConfigurationPreview = z.infer<typeof runConfigurationPreviewSchema>;
```

Do not change `mode`, `research`, or `reflection` in `resolvedRunConfigurationSchema` to nullable.

- [ ] **Step 4: Implement the preview resolver from validated config and existing policy resolution**

Import `resolveReviewPolicy` from `src/core/config.ts`. Build roles directly from `config.profiles` because `resolveRunIntake()` correctly refuses unresolved choices:

```ts
export function resolveRunConfigurationPreview(input: {
  repository: string;
  config: ConfigV2;
  controller: ResolvedRunConfiguration["controller"];
  choices: { mode?: RunMode; research?: boolean; reflection?: boolean };
  overrides: Partial<Record<RoleName, string>>;
}): RunConfigurationPreview {
  const role = (name: RoleName): RunConfigurationPreview["roles"][RoleName] => ({
    ...input.config.profiles[name],
    model: input.overrides[name] ?? input.config.profiles[name].model,
    source: input.overrides[name] === undefined ? "repository_config" : "cli_override",
  });
  const mode = input.choices.mode ?? null;
  const research = input.choices.research ?? null;
  const reflection = input.choices.reflection ?? null;
  const missingChoices: MissingRunChoice[] = [];
  if (mode === null) missingChoices.push("mode");
  if (research === null) missingChoices.push("research");
  if (reflection === null) missingChoices.push("reflection");

  return runConfigurationPreviewSchema.parse({
    version: 1,
    repository: input.repository,
    configuration: { path: ".brain-hands/config.yaml", source: "repository_config" },
    mode,
    research,
    reflection,
    missing_choices: missingChoices,
    controller: input.controller,
    roles: { brain: role("brain"), hands: role("hands"), verifier: role("verifier") },
    hands_backup: input.config.retry_policy.backup ?? null,
    limits: {
      max_hands_fix_attempts: input.config.retry_policy.max_hands_fix_attempts,
      max_replan_attempts: input.config.retry_policy.max_replan_attempts,
      review_policy: resolveReviewPolicy(
        input.config.retry_policy.max_hands_fix_attempts,
        input.config.review_policy,
      ),
      quality_gate: input.config.retry_policy.quality_gate ?? null,
    },
    github: {
      effects: mode === null ? "depends_on_execution_mode" : mode === "github" ? "issues_and_pull_request" : "none",
      default_remote: input.config.github.default_remote,
    },
  });
}
```

- [ ] **Step 5: Implement shared formatting helpers and the exact preview renderer**

Extract private role, backup, review, and quality formatting helpers from the current renderer. Keep `renderRunConfiguration()` output compatible except for adding the explicit `GitHub remote` line. Add:

```ts
const pending = (value: string | null): string => value ?? "needs your choice";

export function renderRunConfigurationPreview(preview: RunConfigurationPreview): string {
  const count = preview.missing_choices.length;
  return [
    `Brain Hands configuration preview (${count} ${count === 1 ? "choice" : "choices"} pending)`,
    "",
    `Repository: ${preview.repository}`,
    `Initialized: ${preview.configuration.path}`,
    `Controller: ${formatController(preview.controller)}`,
    "",
    `Mode: ${pending(preview.mode)}`,
    `Research: ${preview.research === null ? "needs your choice" : preview.research ? "enabled" : "disabled"}`,
    `Reflection: ${preview.reflection === null ? "needs your choice" : preview.reflection ? "enabled" : "disabled"}`,
    "",
    "Roles:",
    formatRole("Brain", preview.roles.brain),
    formatRole("Hands", preview.roles.hands),
    formatRole("Verifier", preview.roles.verifier),
    "",
    formatHandsBackup(preview.hands_backup),
    `Hands fix attempts: ${preview.limits.max_hands_fix_attempts}`,
    `Replan attempts: ${preview.limits.max_replan_attempts}`,
    formatReviewPolicy(preview.limits.review_policy),
    formatQualityGate(preview.limits.quality_gate),
    `GitHub remote: ${preview.github.default_remote}`,
    `GitHub effects: ${preview.github.effects === "depends_on_execution_mode"
      ? "depends on execution-mode choice"
      : preview.github.effects === "none"
        ? "none"
        : "issues and one pull request"}`,
  ].join("\n");
}
```

- [ ] **Step 6: Add partial-choice, override, policy-default, parity, and leakage tests**

Add tests that prove:

- `{ mode: "local" }` yields `missing_choices: ["research", "reflection"]` and GitHub effects `none`.
- `{ mode: "github", research: false, reflection: true }` yields no missing choices and effects `issues_and_pull_request`.
- a Hands override changes only `roles.hands.model` and `roles.hands.source`; reasoning remains `xhigh` and sandbox remains `workspace-write`.
- a config with no `review_policy` resolves its review limit through `resolveReviewPolicy(max_hands_fix_attempts, undefined)`; for the current repository shape this is three fix cycles, not the canonical-new-config value of two.
- enabling backup and disabling quality gate render exact complete lines.
- `runConfigurationPreviewSchema` rejects inconsistent `missing_choices` and GitHub effects.
- JSON and text do not contain `executable_path`, `package_root`, `package_hash`, `candidate_commit`, `codex.command`, `prompt`, `token`, or `credential`.
- a fully specified preview equals the resolved run configuration for controller, roles, backup, limits, GitHub remote/effects, and the three choices.

- [ ] **Step 7: Run focused tests and commit the contract**

Run: `npx vitest run tests/core/run-configuration.test.ts`

Expected: PASS.

Commit:

```bash
git add src/core/run-configuration.ts tests/core/run-configuration.test.ts
git commit -m "feat: add partial run configuration preview"
```

---

### Task 2: Add a side-effect-free `preview` CLI command

**Files:**

- Modify: `src/cli.ts`
- Modify: `tests/cli-smoke.test.ts`

**Interfaces:**

- Produces CLI: `brain-hands preview [--repo <path>] [--mode <local|github>] [--research|--no-research] [--reflection|--no-reflection] [--brain-model <model>] [--hands-model <model>] [--verifier-model <model>] [--json]`.
- JSON output: `{ ...RunConfigurationPreview, rendered_preview: string }` as one value on stdout.
- Human output: exactly `renderRunConfigurationPreview(preview)`.
- Consumes: `loadConfig(repoRoot, { migrate: false })`, `captureControllerProvenance(repoRoot, { dryRun: true })`, `resolveRunConfigurationPreview()`, and `renderRunConfigurationPreview()`.

- [ ] **Step 1: Add a failing CLI smoke test for all-pending JSON output**

Create a temporary repository, call `initConfig(tempRoot)`, snapshot the config bytes and `.brain-hands` directory entries, and run:

```ts
await buildCli().parseAsync([
  "preview",
  "--repo", tempRoot,
  "--json",
], { from: "user" });
```

Assert one `console.log` call, parse it as JSON, assert all approved fields, assert `missing_choices` order, and assert:

```ts
expect(output.rendered_preview).toContain("Brain Hands configuration preview (3 choices pending)");
expect(output.rendered_preview).toContain("Mode: needs your choice");
expect(output.rendered_preview).toContain("GitHub effects: depends on execution-mode choice");
```

Assert config bytes and directory entries are unchanged and `.brain-hands/runs` does not exist.

- [ ] **Step 2: Run the smoke test and confirm it fails**

Run: `npx vitest run tests/cli-smoke.test.ts -t "configuration preview"`

Expected: FAIL because `preview` is not a registered command.

- [ ] **Step 3: Register the command before `run` and parse only supplied choices**

Add the imports for the preview resolver/renderer. Register the command immediately after `init` so help presents `init -> preview -> run`:

```ts
program.command("preview").description("Show the effective configuration before creating a run")
  .option("--repo <path>", "Repository root", process.cwd())
  .option("--mode <mode>", "Execution mode: local or github")
  .option("--research [value]", "Enable web research (optionally true/false)")
  .option("--no-research", "Disable web research")
  .option("--reflection [value]", "Enable end-of-run reflection (optionally true/false)")
  .option("--no-reflection", "Disable end-of-run reflection")
  .option("--brain-model <model>", "Brain model override")
  .option("--hands-model <model>", "Hands model override")
  .option("--verifier-model <model>", "Verifier model override")
  .option("--json", "Print machine-readable output", false)
  .action(async (options: Record<string, unknown>) => {
    const repoRoot = resolve(String(options.repo ?? process.cwd()));
    let config: ConfigV2;
    try {
      config = configV2(await loadConfig(repoRoot, { migrate: false }));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        throw new Error(`Brain Hands is not initialized in ${repoRoot}.\nRun: brain-hands init --repo ${repoRoot}`);
      }
      throw error;
    }
    const controller = await captureControllerProvenance(repoRoot, { dryRun: true });
    const preview = resolveRunConfigurationPreview({
      repository: repoRoot,
      config,
      controller: {
        package_name: controller.provenance.package_name,
        package_version: controller.provenance.package_version,
        mode: controller.provenance.mode,
      },
      choices: {
        ...(options.mode === undefined ? {} : { mode: parseMode(String(options.mode)) }),
        ...(options.research === undefined ? {} : { research: parseBooleanChoice(options.research, "research") }),
        ...(options.reflection === undefined ? {} : { reflection: parseBooleanChoice(options.reflection, "reflection") }),
      },
      overrides: {
        ...(options.brainModel === undefined ? {} : { brain: String(options.brainModel) }),
        ...(options.handsModel === undefined ? {} : { hands: String(options.handsModel) }),
        ...(options.verifierModel === undefined ? {} : { verifier: String(options.verifierModel) }),
      },
    });
    const renderedPreview = renderRunConfigurationPreview(preview);
    console.log(options.json === true
      ? JSON.stringify({ ...preview, rendered_preview: renderedPreview }, null, 2)
      : renderedPreview);
  });
```

Do not add `--dry-run`; preview itself is the read-only operation. Reusing `captureControllerProvenance(..., { dryRun: true })` permits a non-Git temporary repository and still projects only the safe controller subset.

- [ ] **Step 4: Add explicit no-effects and failure-path tests**

In `tests/cli-smoke.test.ts`, add tests for:

- human output with one supplied choice and two pending choices;
- fully resolved JSON with all three choices and each model override;
- invalid `--mode`, `--research`, and `--reflection` values;
- missing config produces the exact `brain-hands init --repo <absolute-path>` recovery command and creates nothing;
- invalid config reports schema validation and does not overwrite it;
- v1 config returns a valid preview but leaves `config.yaml` unchanged and does not create `.v1.bak`;
- preview output excludes every forbidden provenance/config field;
- spies for `runPreflight`, `runDiscoveryTurn`, `initializeRepository`, and `createRunLedgerV2` are not called;
- command help lists `preview` before `run` and includes all partial-choice/model flags.

Use the real temp filesystem for the no-run-artifact assertion; do not rely only on spies.

- [ ] **Step 5: Re-run CLI and core tests and commit**

Run:

```bash
npx vitest run tests/core/run-configuration.test.ts tests/cli-smoke.test.ts
npm run typecheck
```

Expected: PASS.

Commit:

```bash
git add src/cli.ts tests/cli-smoke.test.ts
git commit -m "feat: add read-only configuration preview command"
```

---

### Task 3: Make preview the mandatory first conversational surface

**Files:**

- Modify: `.agents/skills/brain-hands/scripts/brain-hands.mjs`
- Modify: `tests/scripts/brain-hands-wrapper.test.ts`
- Modify: `.agents/skills/brain-hands/SKILL.md`
- Modify: `.agents/skills/brain-hands/agents/openai.yaml`
- Modify: `tests/skill-layout.test.ts`

**Interfaces:**

- Wrapper behavior: compatible-controller version selection remains mandatory; `doctor` is skipped only for `preview`.
- Skill behavior: run JSON preview after config validation, emit `rendered_preview` verbatim, then ask only `missing_choices` in canonical order.
- Default prompt: explicitly requires a complete preview before intake questions.

- [ ] **Step 1: Add a failing wrapper test proving preview does not run `doctor`**

Extend the existing fake installed CLI fixture so it records every argv call. Invoke the wrapper with:

```ts
spawnSync(process.execPath, [wrapper, "preview", "--repo", fixtureRoot, "--json"], {
  cwd: fixtureRoot,
  env: { ...process.env, PATH: fixtureBin },
  encoding: "utf8",
});
```

Assert calls are exactly `--version` and `preview ...`; `doctor` must be absent. Preserve an existing normal-command test that still observes `--version`, `doctor`, then command dispatch.

- [ ] **Step 2: Run wrapper tests and confirm they fail**

Run: `npx vitest run tests/scripts/brain-hands-wrapper.test.ts -t "preview"`

Expected: FAIL because the wrapper currently runs `doctor` before every command.

- [ ] **Step 3: Skip the capability handshake only for preview**

Change the wrapper dispatch block to:

```js
const chosen = chooseCommand(requiredRange(), developmentController);
if (forwardedArgs[0] !== "preview") handshake(chosen);
const result = run(chosen.command, [...chosen.prefix, ...forwardedArgs], "inherit", {
  ...process.env,
  BRAIN_HANDS_EXECUTABLE_PATH: chosen.installed ? chosen.command : distCli,
  BRAIN_HANDS_CONTROLLER_MODE: chosen.installed ? "installed" : "development_checkout",
});
```

The version compatibility check remains in `chooseCommand()`. This prevents missing Codex/GitHub capabilities from blocking a configuration-only preview.

- [ ] **Step 4: Replace the skill's current intake opening with an exact preview protocol**

In `.agents/skills/brain-hands/SKILL.md`, insert a `## Configuration preview gate` between initialization and interactive intake. Require these steps in order:

1. Build preview flags only from choices/model overrides already supplied by the user.
2. Invoke the wrapper as `brain-hands preview --repo <repo> --json` plus those supplied flags.
3. Parse the strict JSON result.
4. Display `rendered_preview` verbatim and in full as the first Brain Hands configuration content.
5. Never replace it with a shortened summary and never move any field to a later response.
6. After the preview, ask only the questions named by `missing_choices`, using the existing exact question wording and canonical order.
7. If `missing_choices` is empty, do not ask intake questions; confirm the resolved intake and proceed to `run`.
8. Re-run preview if a later answer or model override changes a displayed value, then show the updated full preview before starting `run`.

The section must enumerate every required displayed field, not merely say “show the configuration.”

- [ ] **Step 5: Strengthen the default prompt**

Set the YAML string to:

```yaml
default_prompt: "Use $brain-hands to show the complete engine-owned configuration preview before any intake questions, then plan, implement, verify, and deliver this project change."
```

- [ ] **Step 6: Replace keyword-only skill tests with contract tests**

In `tests/skill-layout.test.ts`, assert:

```ts
expect(skill).toContain("## Configuration preview gate");
expect(skill).toContain("brain-hands preview --repo <repo> --json");
expect(skill).toMatch(/display `rendered_preview` verbatim/i);
expect(skill).toMatch(/before any intake question/i);
expect(skill).toMatch(/never replace.*shortened summary/is);
expect(skill.indexOf("## Repository initialization gate"))
  .toBeLessThan(skill.indexOf("## Configuration preview gate"));
expect(skill.indexOf("## Configuration preview gate"))
  .toBeLessThan(skill.indexOf("## Interactive intake"));
for (const field of [
  "Repository", "Initialized", "Controller", "Mode", "Research", "Reflection",
  "Brain", "Hands", "Verifier", "Hands backup", "Hands fix attempts",
  "Replan attempts", "Review limit", "Quality gate", "GitHub remote", "GitHub effects",
]) expect(skill).toContain(field);
expect(String(interfaceMetadata.default_prompt)).toMatch(/complete.*configuration preview.*before.*questions/i);
```

Keep the existing init-first, discovery, approval, progress, and package-allowlist assertions.

- [ ] **Step 7: Run the skill/wrapper tests and commit**

Run: `npm run test:skill`

Expected: PASS.

Commit:

```bash
git add .agents/skills/brain-hands/SKILL.md \
  .agents/skills/brain-hands/agents/openai.yaml \
  .agents/skills/brain-hands/scripts/brain-hands.mjs \
  tests/skill-layout.test.ts \
  tests/scripts/brain-hands-wrapper.test.ts
git commit -m "fix: show configuration preview before intake"
```

---

### Task 4: Document the command and its safety contract

**Files:**

- Modify: `README.md`
- Modify: `.agents/skills/brain-hands/references/cli-contract.md`

**Interfaces:**

- Documents exact CLI syntax, JSON shape, pending semantics, side-effect exclusions, and the preview-to-run transition.
- Keeps `preview` distinct from `run_configuration`, which remains a durable resolved run artifact.

- [ ] **Step 1: Add the preview command to the CLI contract**

Place this before `brain-hands run`:

```text
brain-hands preview --repo <path>
  [--mode <local|github>]
  [--research | --no-research]
  [--reflection | --no-reflection]
  [--brain-model <model>] [--hands-model <model>] [--verifier-model <model>]
  [--json]
```

Document `missing_choices`, `rendered_preview`, the canonical order, conditional GitHub effects, and that preview does not create or migrate anything.

- [ ] **Step 2: Add one all-pending and one partially resolved README example**

The all-pending example must use the current repository values and show every approved line. The partial example should supply `--mode local --no-research` and show only reflection pending. State that raw YAML omissions are resolved through the same schema/policy logic as a future run.

- [ ] **Step 3: Clarify durable artifact boundaries**

State explicitly:

- preview JSON is ephemeral and never written to `.brain-hands/`;
- `run-configuration.json` is created only after all choices are supplied and `run` creates a ledger;
- a fully specified preview and a new run must resolve the same visible values;
- preview is not preflight and does not prove Codex, GitHub, or verification readiness.

- [ ] **Step 4: Run documentation/skill tests and commit**

Run:

```bash
npm run test:skill
npx vitest run tests/core/run-configuration.test.ts tests/cli-smoke.test.ts
```

Expected: PASS.

Commit:

```bash
git add README.md .agents/skills/brain-hands/references/cli-contract.md
git commit -m "docs: define pre-intake preview contract"
```

---

### Task 5: Give the skill a versioned Codex plugin installation path

**Files:**

- Create: `.agents/plugins/marketplace.json`
- Modify: `src/core/controller-provenance.ts`
- Modify: `tests/core/controller-provenance.test.ts`
- Modify: `tests/skill-layout.test.ts`
- Modify: `README.md`
- Modify: `docs/RELEASING.md`

**Interfaces:**

- Produces marketplace name `brain-hands` and plugin selector `brain-hands@brain-hands`.
- Consumes the existing `.codex-plugin/plugin.json` and `.agents/skills/brain-hands/` tree directly from a tagged repository snapshot.
- Preserves the npm package allowlist without `.agents/` or `.codex-plugin/`.
- Makes `hashRuntimeTree()` require and hash the same published paths as `package.json.files`, plus `package.json` metadata.

- [ ] **Step 1: Add failing provenance tests for the split distribution**

Update the controller fixture so `.agents/` and `.codex-plugin/` are optional. Add:

```ts
it("hashes exactly the published controller runtime", async () => {
  const root = await fixture({ includePlugin: false });
  const first = await hashRuntimeTree(root);
  await mkdir(join(root, ".agents", "skills", "brain-hands"), { recursive: true });
  await writeFile(join(root, ".agents", "skills", "brain-hands", "SKILL.md"), "changed skill\n");
  await mkdir(join(root, ".codex-plugin"), { recursive: true });
  await writeFile(join(root, ".codex-plugin", "plugin.json"), "{}\n");
  expect(await hashRuntimeTree(root)).toBe(first);
});

it("accepts an installed runtime without plugin sources", async () => {
  const root = await fixture({ includePlugin: false });
  await expect(hashRuntimeTree(root)).resolves.toMatch(/^[a-f0-9]{64}$/);
});
```

Retain the tests that missing `dist`, `prompts`, workflow documentation, README, or package metadata fail closed and that symlinks inside hashed runtime paths are rejected.

- [ ] **Step 2: Run provenance tests and confirm the first new test fails**

Run: `npx vitest run tests/core/controller-provenance.test.ts`

Expected: FAIL because `RUNTIME_PATHS` still requires `.agents` and `.codex-plugin`.

- [ ] **Step 3: Align provenance with the published npm runtime**

Change only the runtime-path constant:

```ts
const RUNTIME_PATHS = [
  "package.json",
  "dist",
  "prompts",
  "agentic-codex-workflow.md",
  "README.md",
] as const;
```

Do not weaken installed-package location, canonical package identity/version, candidate commit, self-hosting isolation, symlink, or current-controller matching checks. Skill/CLI compatibility remains enforced separately by the wrapper's version range.

- [ ] **Step 4: Add a failing marketplace-layout test**

Parse `.agents/plugins/marketplace.json` and assert:

```ts
expect(marketplace).toEqual({
  name: "brain-hands",
  interface: { displayName: "Brain Hands" },
  plugins: [{
    name: "brain-hands",
    source: { source: "local", path: "." },
    policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
    category: "Coding",
  }],
});
```

Codex resolves the local source from the marketplace root, so `.` is the repository/plugin root containing `.codex-plugin/plugin.json`. This exact layout was verified with the installed Codex CLI in an isolated `CODEX_HOME`.

- [ ] **Step 5: Run the layout test and confirm it fails**

Run: `npx vitest run tests/skill-layout.test.ts -t "marketplace"`

Expected: FAIL because the marketplace manifest does not exist.

- [ ] **Step 6: Create the marketplace manifest**

Create `.agents/plugins/marketplace.json` with exactly the object above. Do not add `.agents/` or `.codex-plugin/` back to `package.json.files`.

- [ ] **Step 7: Verify an isolated local marketplace and plugin install**

Use a temporary Codex home so the test does not alter the operator's installed plugins:

```bash
mkdir -p /private/tmp/brain-hands-codex-home
CODEX_HOME=/private/tmp/brain-hands-codex-home codex plugin marketplace add . --json
CODEX_HOME=/private/tmp/brain-hands-codex-home codex plugin add brain-hands@brain-hands --json
CODEX_HOME=/private/tmp/brain-hands-codex-home codex plugin list --json
```

Expected: marketplace add succeeds; plugin add succeeds; list reports enabled plugin `brain-hands`, its current `.codex-plugin/plugin.json` version, and a cached source outside the repository.

- [ ] **Step 8: Document tagged install and update commands**

Add the stable flow:

```bash
codex plugin marketplace add ngelik/brain-hands --ref v0.3.6 --json
codex plugin add brain-hands@brain-hands --json
codex plugin list --json
```

For an existing tag-pinned installation, replace only this plugin and marketplace explicitly:

```bash
codex plugin remove brain-hands@brain-hands --json
codex plugin marketplace remove brain-hands --json
codex plugin marketplace add ngelik/brain-hands --ref v0.3.6 --json
codex plugin add brain-hands@brain-hands --json
codex plugin list --json
```

Do not use `marketplace upgrade` for a tag-pinned source; the ref is intentionally immutable. Explain that a fresh Codex task is required to load changed skill instructions; the current task retains the already-loaded skill snapshot.

- [ ] **Step 9: Run tests and commit**

Run:

```bash
npx vitest run tests/skill-layout.test.ts
npx vitest run tests/core/controller-provenance.test.ts
npm run validate-release -- --json
```

Expected: PASS, including the unchanged npm allowlist.

Commit:

```bash
git add .agents/plugins/marketplace.json \
  src/core/controller-provenance.ts \
  tests/core/controller-provenance.test.ts \
  tests/skill-layout.test.ts \
  README.md \
  docs/RELEASING.md
git commit -m "feat: add Brain Hands plugin marketplace"
```

---

### Task 6: Close the regression with full, installed, and fresh-task verification

**Files:**

- Modify only if a failing test exposes an in-scope defect in files from Tasks 1-5.

**Interfaces:**

- Produces release-readiness evidence for source, tarball, installed CLI, installed plugin, and conversational ordering.

- [ ] **Step 1: Run focused regression suites**

Run:

```bash
npx vitest run tests/core/run-configuration.test.ts tests/cli-smoke.test.ts
npm run test:skill
```

Expected: PASS.

- [ ] **Step 2: Run complete repository gates**

Run:

```bash
npm test
npm run typecheck
npm run build
npm run validate-release -- --json
git diff --check
npm_config_cache=/private/tmp/brain-hands-npm-cache npm pack --dry-run --json
```

Expected: PASS. Inspect pack JSON and confirm it contains `dist/core/run-configuration.js`, the built CLI, prompts, workflow doc, README, and metadata, but not `.agents/`, `.codex-plugin/`, `src/`, `tests/`, `docs/`, `.brain-hands/`, or credentials.

- [ ] **Step 3: Pack once and install the exact tarball into an isolated prefix**

Run:

```bash
npm_config_cache=/private/tmp/brain-hands-npm-cache npm pack --json
npm install --prefix /private/tmp/brain-hands-preview-install --ignore-scripts ./ngelik-brain-hands-0.3.5.tgz
PATH=/private/tmp/brain-hands-preview-install/node_modules/.bin:$PATH brain-hands --version
PATH=/private/tmp/brain-hands-preview-install/node_modules/.bin:$PATH brain-hands preview --repo /path/to/brain-hands --json
```

Expected: version `0.3.5` before release synchronization; preview reports the isolated installed controller, all repository-config values, three pending choices, and no forbidden fields. Remove the generated tarball only after its filename is captured from pack JSON and only if it was generated by this task.

- [ ] **Step 4: Prove preview does not mutate the real repository**

Before and after the installed preview, compare:

```bash
git status --short
find .brain-hands -maxdepth 2 -type f -print | sort
```

Expected: no new run, backup, preflight, prompt, response, or GitHub artifact; the pre-existing unrelated worktree changes are identical.

- [ ] **Step 5: Verify the plugin from an isolated Codex home**

Repeat the Task 5 isolated marketplace install after the full build. Confirm the cached plugin contains the updated `SKILL.md`, `openai.yaml`, and wrapper, while its manifest version matches the source version.

- [ ] **Step 6: Perform a fresh-task conversational smoke**

Start a new Codex task in an initialized fixture repository with the installed plugin enabled. Ask for a Brain Hands task without mode/research/reflection. Capture the first response and assert:

- the complete preview appears before the first question;
- all 16 approved display lines are present;
- the title reports three pending choices;
- only the three unresolved questions follow;
- no run directory or external effect exists yet.

Repeat with mode already supplied and assert the preview reports two pending choices and only two questions. This must be a fresh task because the current task's skill instructions are already loaded.

- [ ] **Step 7: Commit any test-driven closure fix, then rerun all gates**

If the smoke uncovers an in-scope regression, add the narrowest deterministic test, fix only the relevant file, commit it, and repeat Steps 1-6. Do not edit unrelated dirty files.

---

### Task 7: Release `0.3.6` and verify both distribution surfaces

**Files:**

- Modify through `scripts/release-version.mjs`: `package.json`, `package-lock.json`, `.codex-plugin/plugin.json`, `.agents/skills/brain-hands/SKILL.md`.

**Interfaces:**

- Publishes CLI package `@ngelik/brain-hands@0.3.6` through the existing tag-triggered trusted-publishing workflow.
- Publishes skill/plugin source at Git tag `v0.3.6` for marketplace installation.

**Preconditions:**

- The user separately authorizes release/push and global installation.
- All feature commits are on `main`, pushed, and the checkout is clean.
- The current unrelated worktree changes have been resolved by their owner; `scripts/release.sh` correctly refuses a dirty checkout.
- `origin` is the canonical `github.com/ngelik/brain-hands` repository and npm trusted publishing remains configured.

- [ ] **Step 1: Dispatch the patch release**

Run:

```bash
scripts/release.sh 0.3.6
```

Expected: the script synchronizes the four release surfaces, reruns all gates, creates commit `chore(release): v0.3.6`, creates annotated tag `v0.3.6`, and atomically pushes `main` plus the tag. GitHub Actions, not the local shell, publishes npm.

- [ ] **Step 2: Verify the immutable release**

Verify the GitHub publish workflow succeeded, then run:

```bash
npm view @ngelik/brain-hands@0.3.6 version dist.integrity
npm install -g @ngelik/brain-hands@0.3.6
brain-hands --version
brain-hands preview --repo /path/to/brain-hands --json
```

Expected: registry version and installed version are `0.3.6`; preview exposes the full safe contract and reports controller mode `installed`.

- [ ] **Step 3: Install or refresh the tagged skill/plugin**

For first install:

```bash
codex plugin marketplace add ngelik/brain-hands --ref v0.3.6 --json
codex plugin add brain-hands@brain-hands --json
codex plugin list --json
```

For an existing tag-pinned installation:

```bash
codex plugin remove brain-hands@brain-hands --json
codex plugin marketplace remove brain-hands --json
codex plugin marketplace add ngelik/brain-hands --ref v0.3.6 --json
codex plugin add brain-hands@brain-hands --json
codex plugin list --json
```

Expected: enabled plugin version `0.3.6`; cached skill frontmatter requires `^0.3.6`; default prompt contains the preview-before-questions contract.

- [ ] **Step 4: Repeat the fresh-task conversational smoke against released artifacts**

Open a new Codex task outside this checkout, target an initialized fixture repository, and repeat Task 6 Step 6. Confirm the preview identifies installed CLI `0.3.6`, precedes all questions, and leaves no workflow artifacts or external effects.

- [ ] **Step 5: Record release evidence**

Record the release commit, annotated tag, npm integrity, installed binary path/version, plugin cache/version, preview JSON, first-response transcript, and before/after artifact listing. Do not record executable hashes, credentials, or raw user configuration in public release notes.

---

## Self-Review

### Spec coverage

- Complete approved field set: Tasks 1-4.
- Preview before questions: Task 3 plus fresh-task verification in Tasks 6-7.
- Partial pending choices: Tasks 1-2.
- Defaults omitted from raw YAML: Task 1 policy-default test and Task 2 v1/v2 CLI tests.
- No paths/hashes/prompts/credentials: Tasks 1-2 leakage tests.
- No workflow artifacts or external effects: Task 2 filesystem/spies and Task 6 installed smoke.
- Engine-owned behavior rather than skill prose alone: Tasks 1-3.
- Default prompt and README: Tasks 3-4.
- Stable CLI and separately refreshed skill: Tasks 5-7.
- Release version synchronization and installed proof: Task 7.

### Deliberate exclusions

- Preview does not run `doctor`, preflight, live model catalog checks, GitHub auth, or GitHub label inspection; those remain execution-readiness concerns.
- Preview does not persist an artifact or create a resumable intake session.
- Preview does not infer or default user choices.
- The patch does not add `.agents/` or `.codex-plugin/` to the npm tarball.
- The patch does not change run approvals, discovery, planning, execution, verification, delivery, or GitHub mutation behavior.

### Risks and mitigations

- **Schema drift between preview and run:** a fully resolved parity test compares every shared visible field.
- **Read-only command mutates v1 config:** mandatory `migrate: false` plus byte-for-byte tests.
- **Skill still summarizes JSON:** JSON includes engine-rendered text and the skill must display it verbatim.
- **Wrapper blocks preview on missing runtime capabilities:** preview skips `doctor` but retains CLI version compatibility selection.
- **Pending values leak into execution:** preview has a separate schema; resolved schema stays non-nullable.
- **Skill release becomes stale after npm packaging changes:** plugin marketplace is independent of the narrow npm tarball.
- **Narrow npm package breaks self-hosting provenance:** runtime hashing is aligned to the published package and covered by an installed-tarball self-hosting smoke.
- **Same-session validation uses stale instructions:** released behavior is accepted only from a fresh Codex task.
- **Release tramples current dirty work:** release is blocked until unrelated changes are resolved and the checkout is clean.

## Execution Handoff

Plan implementation may proceed in either mode after explicit approval:

1. **Subagent-driven:** the user must explicitly authorize subagents; use one fresh agent per task and review between tasks.
2. **Inline execution:** use `superpowers:executing-plans` in this session, preserving the current unrelated worktree changes and stopping before release/global installation for separate authorization.
