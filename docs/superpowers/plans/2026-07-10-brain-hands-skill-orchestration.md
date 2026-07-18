# Brain Hands Skill Orchestration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Deliver Brain Hands as a Codex skill that gathers missing task choices conversationally and drives a deterministic, approval-gated Codex workflow with Brain, Hands, and Verifier roles in either local or GitHub delivery mode.

**Architecture:** The skill is the conversational front door. The CLI remains the durable workflow engine: it validates a resolved intake, persists an append-only v2 run ledger, invokes Codex through current structured-output flags, and coordinates isolated worktree execution. Brain plans read-only, Hands changes one approved work item at a time, and Verifier independently validates every implementation result. GitHub mode adds issue and pull-request delivery; local mode never calls GitHub or a remote. Reflection is an optional terminal artifact; reflection-to-improvement planning is analysis-only and always stops after writing a standalone plan.

**Tech Stack:** Node.js 20+, TypeScript, Commander, Zod, YAML, Vitest, execa, Git, GitHub CLI, Codex CLI, Codex skills and plugin metadata.

## Global Constraints

- Preserve existing non-Brain-Hands behavior only where explicitly covered by compatibility tests; do not carry forward the obsolete four-profile workflow.
- The three supported roles are Brain, Hands, and Verifier. Configured model defaults are used silently unless a user explicitly overrides a role model.
- A run cannot allocate a branch, worktree, GitHub issue, or pull request until a human approves the current Brain plan revision.
- Every role invocation uses Codex non-interactive structured output. Brain and Verifier run read-only; Hands alone runs workspace-write inside the run worktree.
- Use the current Codex CLI contract: exec, ephemeral, model, -c model_reasoning_effort, sandbox, -C, output-schema, output-last-message, and optional search. Never emit the removed reasoning-effort flag.
- Use direct argv subprocess calls. Do not execute verification instructions through a shell and reject unsafe command strings before invocation.
- Local mode creates a local Git branch and worktree, but performs no gh, remote, push, issue, or pull-request command.
- GitHub mode creates one issue per work item and a single integrated task pull request. It must never merge the pull request.
- Keep legacy v1 config readable through one explicit v1-to-v2 migration with a backup. Keep old ledgers inspectable; do not rewrite them.
- Each task below follows test-first development. Run the listed focused test command before and after the implementation, then create the named commit only after it passes.

## File Structure

| Path | Responsibility |
| --- | --- |
| src/core/types.ts | V2 role, intake, plan, result, reflection, and ledger contracts |
| src/core/schema.ts | Zod validation for config, intake, artifacts, and ledger records |
| src/core/output-schemas.ts | JSON Schema files supplied to Codex structured-output invocations |
| src/core/config.ts | V2 defaults and v1 config migration |
| src/core/intake.ts | Resolve CLI or skill input into a complete, executable run intake |
| src/core/ledger.ts | Durable run directories, append-only events, and approval state |
| src/core/run-state.ts | Allowed stage transition enforcement |
| src/core/command.ts | Verification command parser and safety policy |
| src/adapters/codex.ts | Current Codex exec argument construction and structured invocation |
| src/adapters/git.ts | Source cleanliness, worktrees, commits, and optional push |
| src/adapters/github.ts | GitHub issue and integrated pull-request operations |
| src/workflow/preflight.ts | Codex, Git, and optional GitHub capability checks |
| src/workflow/planner.ts | Brain planning and plan artifact persistence |
| src/workflow/worker.ts | Hands execution of one approved work item |
| src/workflow/verifier.ts | Independent verification and review |
| src/verification/runner.ts | Frozen test-command execution |
| src/workflow/runtime.ts | Local and GitHub run orchestration, repair loop, and resume |
| src/workflow/reflection.ts | Terminal reflection and reflection-to-improvement-plan generation |
| src/cli.ts | V2 commands and clear operator output |
| prompts/*.md | Role-specific prompts with no Markdown-plus-JSON parsing |
| .agents/skills/brain-hands/ | Conversational Codex skill, wrapper, and reference contract |
| .codex-plugin/plugin.json | Discoverable plugin metadata |
| tests/ | Unit, adapter, workflow, CLI, and skill-layout coverage |

---

## Task 1: Establish the V2 contracts, config, and resolved intake

**Files:**
- Modify: src/core/types.ts
- Modify: src/core/schema.ts
- Modify: src/core/config.ts
- Create: src/core/output-schemas.ts
- Create: src/core/intake.ts
- Modify: tests/core/config.test.ts
- Modify: tests/core/schema.test.ts
- Create: tests/core/intake.test.ts

- [ ] **Step 1: Write failing intake and migration tests.**

  Cover all of the following:

  - a complete RunIntake resolves into a ResolvedRunIntake using the three config role defaults;
  - absent mode, research, or reflection produces exactly: mode, research, and reflection must be resolved before execution;
  - a supplied role model overrides only that role;
  - v1 config is copied to config.yaml.v1.bak before migration and produces version 2 role profiles;
  - invalid reasoning effort, invalid role sandbox, and an unknown role are rejected.

  Run: npm test -- tests/core/intake.test.ts tests/core/config.test.ts tests/core/schema.test.ts
  Expected: failure because the V2 modules and contracts do not exist.

- [ ] **Step 2: Define the exact public types and schemas.**

  In src/core/types.ts add:

  ~~~ts
  export type RoleName = 'brain' | 'hands' | 'verifier';
  export type RunMode = 'github' | 'local';
  export type SandboxMode = 'read-only' | 'workspace-write';
  export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  export type RunStageV2 =
    | 'intake' | 'preflight' | 'brain_planning' | 'awaiting_plan_approval'
    | 'worktree_setup' | 'github_issue_sync' | 'implementing' | 'verifying'
    | 'verifier_review' | 'fixing' | 'replanning' | 'final_verification'
    | 'delivery' | 'reflecting' | 'complete';

  export interface RoleProfile {
    model: string;
    reasoning_effort: ReasoningEffort;
    sandbox: SandboxMode;
  }
  ~~~

  Add explicitly named interfaces for RunIntake, ResolvedRunIntake, WorkItem, BrainPlan, ImplementationResult, VerifierFinding, VerifierReview, Reflection, ImprovementPlan, RunEvent, and RunManifestV2. Require every work item to contain id, title, objective, acceptance_criteria, dependencies, implementation_instructions, verification_commands, and files_expected_to_change. Type verification_commands as readonly string[][] so each entry is one frozen executable-plus-arguments vector, never a shell string.

  In src/core/schema.ts create matching Zod schemas, including a non-empty array of non-empty argument arrays for verification_commands. In src/core/output-schemas.ts export literal JSON Schema objects for BrainPlan, ImplementationResult, VerifierReview, Reflection, and ImprovementPlan. The Codex schemas must set additionalProperties to false at every object level and use required arrays for all required fields.

- [ ] **Step 3: Implement config v2 and v1 migration.**

  Set default profiles in src/core/config.ts:

  | Role | Model | Reasoning | Sandbox |
  | --- | --- | --- | --- |
  | brain | gpt-5.6 | high | read-only |
  | hands | gpt-5.6-terra | medium | workspace-write |
  | verifier | gpt-5.6 | high | read-only |

  Implement loadConfig so version 2 validates directly. For version 1, write a sibling config.yaml.v1.bak with exclusive creation, map brain_planner to brain, hands_implementer to hands, and brain_reviewer to verifier, then persist validated version 2 config. Use the old fixer model only as the Hands fallback if hands_implementer is absent. Do not delete v1 fields from the backup. Keep exported legacy type aliases and thin load helpers until Task 9 retypes and gates the retained recovery modules, so every intermediate commit still typechecks.

  Implement resolveRunIntake in src/core/intake.ts. It accepts a possibly incomplete RunIntake and ConfigV2, applies only role-model defaults, and rejects missing mode, research, or reflection rather than inventing a task choice.

- [ ] **Step 4: Prove the focused tests pass.**

  Run: npm test -- tests/core/intake.test.ts tests/core/config.test.ts tests/core/schema.test.ts
  Expected: all pass.

- [ ] **Step 5: Commit the contract foundation.**

  Run: git add src/core tests/core && git commit -m "feat: add brain hands v2 run contracts"

## Task 2: Replace obsolete Codex invocation flags and add capability preflight

**Files:**
- Modify: src/adapters/codex.ts
- Modify: src/workflow/preflight.ts
- Modify: tests/adapters/codex.test.ts
- Modify: tests/workflow/preflight.test.ts

- [ ] **Step 1: Write failing adapter and preflight tests.**

  Assert that renderCodexArgs receives:

  ~~~ts
  interface RenderCodexArgsInput {
    model: string;
    reasoningEffort: ReasoningEffort;
    sandbox: SandboxMode;
    cwd: string;
    outputSchemaPath: string;
    outputPath: string;
    isolateUserConfig: boolean;
    enableWebSearch: boolean;
  }
  ~~~

  and produces this argument order:

  ~~~ts
  [
    'exec', '--ephemeral', '--ignore-user-config',
    '--model', input.model,
    '-c', 'model_reasoning_effort="' + input.reasoningEffort + '"',
    '--sandbox', input.sandbox,
    '-C', input.cwd,
    '--output-schema', input.outputSchemaPath,
    '--output-last-message', input.outputPath,
    '--search'
  ]
  ~~~

  Test omitted optional flags, non-zero invocation errors containing stderr, required output-file presence, dry-run validation against the output schema, and Brain-only web search. Test preflight detects all required flags from mocked codex exec --help output and requires gh only in GitHub mode.

  Run: npm test -- tests/adapters/codex.test.ts tests/workflow/preflight.test.ts
  Expected: failure against the old reasoning-effort implementation.

- [ ] **Step 2: Implement the structured Codex adapter.**

  Replace all legacy reasoning-effort argument rendering in src/adapters/codex.ts. Every real invocation writes a prompt file, JSON Schema file, and output-last-message path within the run artifact directory; pass the prompt through stdin. Use execa with reject false only to collect structured error information, then throw CodexInvocationError on a non-zero exit or a missing output file. Parse output with the supplied Zod schema before returning it.

  Dry-run mode must consume a caller-provided JSON fixture through the same Zod parser. It must never manufacture a successful free-form response.

- [ ] **Step 3: Implement preflight v2.**

  Make preflight execute git --version, git rev-parse --show-toplevel, codex --version, and codex exec --help. Assert the help text contains --ephemeral, --model, -c, --sandbox, -C, --output-schema, and --output-last-message. In GitHub mode additionally run gh --version and gh auth status.

  Return a structured report that distinguishes an unauthenticated GitHub account from an unavailable platform keyring or sandboxed gh process. Add an opt-in live model check that executes the selected role model with a read-only ephemeral exact-OK prompt; it is off by default.

- [ ] **Step 4: Prove the focused tests pass.**

  Run: npm test -- tests/adapters/codex.test.ts tests/workflow/preflight.test.ts
  Expected: all pass.

- [ ] **Step 5: Commit the CLI compatibility repair.**

  Run: git add src/adapters/codex.ts src/workflow/preflight.ts tests && git commit -m "fix: invoke current codex cli safely"

## Task 3: Persist v2 ledger state and plan approval

**Files:**
- Modify: src/core/ledger.ts
- Create: src/core/run-state.ts
- Modify: tests/core/ledger.test.ts

- [ ] **Step 1: Write failing ledger tests.**

  Test run creation writes manifest.json, intake.json, original-request.md, and events.jsonl, creates plans, prompts, responses, schemas, implementation, verification, and reviews directories, and starts at intake. Test an allowed intake to preflight transition and rejection of an illegal intake to implementing transition. Test a plan revision records its SHA-256 and that approval only succeeds for the recorded revision.

  Run: npm test -- tests/core/ledger.test.ts
  Expected: failure because v2 files and transitions are absent.

- [ ] **Step 2: Implement the append-only state model.**

  In src/core/run-state.ts export ALLOWED_TRANSITIONS and assertTransition. In src/core/ledger.ts implement createRunLedgerV2, appendRunEvent, transitionRun, recordPlan, and approvePlanRevision.

  Persist the exact plan text and SHA-256 under plans/revision-N.md. Store the current revision, approved revision, selected role profiles, run mode, repo root, source commit, worktree path, branch name, work-item progress, GitHub IDs when applicable, and final artifact paths in the manifest. Never overwrite events.jsonl; append one JSON object per transition with timestamp, actor, stage, and payload.

- [ ] **Step 3: Prove the focused tests pass.**

  Run: npm test -- tests/core/ledger.test.ts
  Expected: all pass.

- [ ] **Step 4: Commit durable approval state.**

  Run: git add src/core/ledger.ts src/core/run-state.ts tests/core/ledger.test.ts && git commit -m "feat: persist brain hands run approval state"

## Task 4: Build structured Brain planning

**Files:**
- Modify: src/workflow/planner.ts
- Modify: src/prompts/loader.ts
- Create: prompts/brain-plan-v2.md
- Modify: tests/workflow/planner.test.ts

- [ ] **Step 1: Write failing Brain planner tests.**

  Verify planRunV2 invokes only the Brain profile in read-only mode, enables search only when intake.research is true, validates against brainPlanSchema, writes a revision artifact, moves the ledger to awaiting_plan_approval, and does not call Git, GitHub, or Hands.

  Run: npm test -- tests/workflow/planner.test.ts
  Expected: failure because the planner has no V2 entry point.

- [ ] **Step 2: Add the Brain prompt and planner.**

  The prompt must demand a JSON object matching BrainPlan, concise assumptions, explicit work-item dependencies, frozen direct-argv verification commands, and a research_sources field. Render a literal instruction of either Research is disabled or Use live web search and cite primary sources in research_sources; do not substitute an empty token.

  Implement planRunV2 to save prompt, JSON schema, structured response, and plan revision in the ledger, then transition directly to awaiting_plan_approval. Do not parse JSON embedded in Markdown.

- [ ] **Step 3: Prove the focused tests pass.**

  Run: npm test -- tests/workflow/planner.test.ts
  Expected: all pass.

- [ ] **Step 4: Commit structured planning.**

  Run: git add src/workflow/planner.ts src/prompts/loader.ts prompts tests && git commit -m "feat: add structured brain planning"

## Task 5: Add isolated worktrees and frozen verification command policy

**Files:**
- Modify: src/adapters/git.ts
- Modify: src/core/command.ts
- Modify: src/verification/runner.ts
- Create: tests/adapters/git-worktree.test.ts
- Create: tests/core/command-policy.test.ts
- Modify: tests/verification/runner.test.ts

- [ ] **Step 1: Write failing isolation and policy tests.**

  Test a dirty source checkout rejects before worktree allocation; a successful run invokes git worktree add -b and records its resolved path; an existing destination rejects; and each commit has a non-empty work-item identifier in its message.

  Test command policy accepts an argv array such as npm test -- tests/unit.test.ts and rejects any command containing shell composition, redirection, command substitution, a shell executable, sudo, rm, rmdir, mkfs, dd, an absolute filesystem target, or traversal outside the worktree.

  Run: npm test -- tests/adapters/git-worktree.test.ts tests/core/command-policy.test.ts tests/verification/runner.test.ts
  Expected: failure because neither policy nor worktree contract exists.

- [ ] **Step 2: Implement Git isolation.**

  Add assertCleanSourceCheckout, createRunWorktree, commitWorkItem, and pushBranch to src/adapters/git.ts. Put each worktree at SOURCE_REPO/.brain-hands/worktrees/RUN_ID. Call git worktree add -b with branch name codex/brain-hands/RUN_ID. Resolve the target path and store it only after Git succeeds. commitWorkItem must commit only after Verifier approval, using the prefix work-item: followed by the work item ID and title.

- [ ] **Step 3: Implement the command safety boundary.**

  Make assertApprovedCommand accept readonly string[] only. Reject an empty array, a command token containing shell metacharacters, and every forbidden executable listed in Step 1. Resolve relative file arguments against the worktree and reject any resolved path outside it. Make verification-runner invoke the approved argv with execa in the worktree and save stdout, stderr, exit code, and duration as a JSON artifact.

- [ ] **Step 4: Prove the focused tests pass.**

  Run: npm test -- tests/adapters/git-worktree.test.ts tests/core/command-policy.test.ts tests/verification/runner.test.ts
  Expected: all pass.

- [ ] **Step 5: Commit safe isolated execution.**

  Run: git add src/adapters/git.ts src/core/command.ts src/verification/runner.ts tests && git commit -m "feat: isolate runs and freeze verification commands"

## Task 6: Execute the local Brain, Hands, Verifier loop

**Files:**
- Create: src/workflow/worker.ts
- Create: src/workflow/verifier.ts
- Create: src/workflow/runtime.ts
- Create: prompts/hands-work-item-v2.md
- Create: prompts/verifier-review-v2.md
- Create: tests/workflow/worker.test.ts
- Create: tests/workflow/verifier.test.ts
- Create: tests/workflow/runtime-local.test.ts

- [ ] **Step 1: Write failing local workflow tests.**

  Build a fake adapter sequence with two dependent work items. Assert Hands receives only the approved work item and worktree, verification uses the frozen plan commands, Verifier is read-only and sees the implementation and verification artifacts, no GitHub adapter is constructed, and the second item begins only after the first Verifier approval and commit.

  Add a test where Verifier requests changes: Hands fixes, verification reruns, and Verifier reruns. A third change request transitions to replanning and stops without unbounded retries.

  Run: npm test -- tests/workflow/worker.test.ts tests/workflow/verifier.test.ts tests/workflow/runtime-local.test.ts
  Expected: failure because runtime does not exist.

- [ ] **Step 2: Implement Hands and Verifier role functions.**

  worker.ts invokes the Hands profile with workspace-write, the worktree as -C, the approved work-item JSON, and implementationResultJsonSchema. It records changed files, commands actually run, summary, and known limitations.

  verifier.ts invokes the Verifier profile with read-only sandbox, the same worktree, the approved acceptance criteria, implementation result, and saved verification artifacts. It returns approved or changes_requested plus findings that identify an acceptance criterion and a concrete remediation.

- [ ] **Step 3: Implement bounded local runtime.**

  runtime.ts topologically sorts work items and rejects a missing dependency. For each item: transition implementing, invoke Hands, transition verifying, run frozen verification, transition verifier_review, invoke Verifier, and commit only when approved. For changes_requested, transition fixing and repeat the same item; enforce exactly three Verifier passes before transition replanning and stop with a human-action status.

  After all items are approved, run the integrated final verification command list from the Brain plan, run a final Verifier review, and transition delivery with local_ready. Never create a remote, push, issue, or pull request in this path.

- [ ] **Step 4: Prove the focused tests pass.**

  Run: npm test -- tests/workflow/worker.test.ts tests/workflow/verifier.test.ts tests/workflow/runtime-local.test.ts
  Expected: all pass.

- [ ] **Step 5: Commit local workflow execution.**

  Run: git add src/workflow prompts tests && git commit -m "feat: execute local brain hands workflows"

## Task 7: Add GitHub issue and integrated pull-request delivery

**Files:**
- Modify: src/adapters/github.ts
- Modify: src/workflow/runtime.ts
- Modify: tests/adapters/github.test.ts
- Create: tests/workflow/runtime-github.test.ts

- [ ] **Step 1: Write failing GitHub-mode tests.**

  Test GitHub mode creates one issue per work item before Hands work, adds stable run and work-item HTML comment markers, persists each issue number immediately, pushes only after final Verifier approval, opens exactly one task-level pull request, and never calls a merge operation.

  Test resume reuses marker-matched persisted issues and an existing pull request instead of duplicating either. Test local mode does not instantiate the GitHub adapter.

  Run: npm test -- tests/adapters/github.test.ts tests/workflow/runtime-github.test.ts
  Expected: failure because current adapter workflow is not task-level and idempotent.

- [ ] **Step 2: Implement GitHub v2 operations.**

  Add createIssue, findIssueByMarker, openIntegratedPullRequest, findPullRequestByHead, and commentRunStatus to src/adapters/github.ts. Include:

  ~~~text
  <!-- brain-hands-run:RUN_ID -->
  <!-- brain-hands-work-item:WORK_ITEM_ID -->
  ~~~

  in every work-item issue body. The integrated PR body must list every work item with the exact closing relation: work-item-id: Closes #ISSUE_NUMBER. Use the run branch as the PR head. Do not expose a merge method.

- [ ] **Step 3: Integrate delivery into runtime.**

  In GitHub mode, transition through github_issue_sync immediately after plan approval and before worktree setup. Persist issue IDs after every successful creation. After local implementation and final verification are approved, push the branch, open or recover one integrated PR, record its URL, then run a final read-only Verifier pass against the integrated diff and saved per-item evidence. If it requests changes, run the bounded fix, verification, Verifier, commit, and push loop from Task 6 so the existing PR updates. Transition delivery with pull_request_open only after this pass approves. Leave the PR unmerged.

- [ ] **Step 4: Prove the focused tests pass.**

  Run: npm test -- tests/adapters/github.test.ts tests/workflow/runtime-github.test.ts
  Expected: all pass.

- [ ] **Step 5: Commit GitHub delivery.**

  Run: git add src/adapters/github.ts src/workflow/runtime.ts tests && git commit -m "feat: deliver approved runs through github"

## Task 8: Add terminal reflection and analysis-only improvement planning

**Files:**
- Create: src/workflow/reflection.ts
- Create: prompts/reflection-v2.md
- Create: prompts/improvement-plan-v2.md
- Create: tests/workflow/reflection.test.ts

- [ ] **Step 1: Write failing reflection tests.**

  Test reflection runs only from a complete ledger when intake.reflection is true, calls the selected Brain and Hands models in read-only mode for their process accounts, and stores reflection.json and reflection.md under the run ledger. Test --update-from-reflection reads a reflection artifact, runs read-only planning, writes a standalone timestamped improvement plan, and makes no source-tree, branch, worktree, remote, GitHub, or implementation mutation.

  Run: npm test -- tests/workflow/reflection.test.ts
  Expected: failure because no reflection module exists.

- [ ] **Step 2: Implement reflection.**

  Implement runReflection to provide the original request, approved plan revisions, Hands reports, verification evidence, Verifier findings, retry history, Git history, and delivery result to two structured process accounts: Brain reports planning and research quality; Hands reports implementation and verification quality. Invoke both with a read-only sandbox even though Hands normally has workspace-write access. A final Brain synthesis returns Reflection with what_worked, what_was_correct, improvements, evidence_paths, and classifications for implementation defects, planning defects, verification gaps, environment failures, external blockers, and unnecessary cost or rework. It must not make product changes.

  Implement planFromReflection to validate a supplied reflection JSON or Markdown artifact, inspect the source repository read-only, and write JSON plus Markdown to sourceRepo/.brain-hands/improvement-plans/TIMESTAMP. Invoke Brain only; never invoke Hands. Return the artifact paths and a message that a separate task is required to implement it. Stop there.

- [ ] **Step 3: Prove the focused tests pass.**

  Run: npm test -- tests/workflow/reflection.test.ts
  Expected: all pass.

- [ ] **Step 4: Commit reflection planning.**

  Run: git add src/workflow/reflection.ts prompts tests/workflow/reflection.test.ts && git commit -m "feat: add brain hands reflection planning"

## Task 9: Replace the CLI with the approval-gated lifecycle

**Files:**
- Modify: src/cli.ts
- Modify: src/workflow/status.ts
- Modify: src/workflow/implementer.ts
- Modify: src/workflow/reviewer.ts
- Modify: src/workflow/orchestrator.ts
- Modify: src/workflow/review-package.ts
- Modify: src/workflow/issue-import.ts
- Modify: tests/workflow/implementer.test.ts
- Modify: tests/workflow/reviewer.test.ts
- Modify: tests/workflow/orchestrator.test.ts
- Modify: tests/workflow/review-package.test.ts
- Modify: tests/workflow/issue-import.test.ts
- Modify: tests/cli-smoke.test.ts
- Modify: tests/workflow/e2e-dry-run.test.ts

- [ ] **Step 1: Write failing command-level tests.**

  Cover:

  - run requires resolved --mode, --research or --no-research, and --reflection or --no-reflection when invoked non-interactively;
  - a run with all choices creates a ledger and ends awaiting_plan_approval;
  - approve-plan requires the exact current revision and only then starts worktree execution;
  - status reads v2 manifest, plan approval, work-item state, delivery state, and artifact paths;
  - resume continues the next allowed stage rather than printing advice;
  - reflection --update-from-reflection invokes only the analysis-only reflection planner;
  - a local dry run reaches local_ready without gh commands.
  - each retained diagnostic or recovery command rejects an unapproved or legacy run without an explicit v2 plan approval.

  Run: npm test -- tests/cli-smoke.test.ts tests/workflow/e2e-dry-run.test.ts
  Expected: failure because old commands bypass approval and the V2 lifecycle does not yet exist.

- [ ] **Step 2: Implement V2 CLI commands.**

  Expose:

  ~~~text
  brain-hands run
  brain-hands approve-plan RUN_ID --revision N
  brain-hands resume RUN_ID
  brain-hands status RUN_ID
  brain-hands doctor --repo PATH --mode local|github [--live-model-check]
  brain-hands reflection --update-from-reflection REFLECTION_PATH --repo PATH
  ~~~

  run accepts --mode, --research, --no-research, --reflection, --no-reflection, --brain-model, --hands-model, --verifier-model, --dry-run, and --json. Configure Commander to reject mutually exclusive boolean pairs and produce one clear error for every missing task choice.

  Load configuration once, resolve the intake, preflight, create ledger, and call planRunV2. Print resolved role models before planning. approve-plan records approval then invokes runtime. resume loads persisted v2 state and executes exactly its next allowed phase.

  Retain implement, review, fix, review-package, issue import, and browser verify as diagnostics or recovery entry points. They must first load a V2 ledger and require its approved revision. implement, review, and fix delegate to the V2 runtime stage rather than running their old direct GitHub workflow. review-package, issue import, and browser verify may collect evidence only; they append an event and cannot allocate a worktree, create an issue or pull request, push, merge, or modify source files. Reject use against legacy ledgers with a migration message rather than silently bypassing approval.

- [ ] **Step 3: Prove the focused tests pass.**

  Run: npm test -- tests/cli-smoke.test.ts tests/workflow/e2e-dry-run.test.ts
  Expected: all pass.

- [ ] **Step 4: Commit operator lifecycle.**

  Run: git add -A src tests && git commit -m "feat: add approved brain hands cli lifecycle"

## Task 10: Package the Codex skill, document it, and validate release surfaces

**Files:**
- Create: .agents/skills/brain-hands/SKILL.md
- Create: .agents/skills/brain-hands/agents/openai.yaml
- Create: .agents/skills/brain-hands/scripts/brain-hands.mjs
- Create: .agents/skills/brain-hands/references/cli-contract.md
- Create: .codex-plugin/plugin.json
- Modify: package.json
- Modify: README.md
- Modify: agentic-codex-workflow.md
- Create: tests/skill-layout.test.ts
- Create: tests/scripts/brain-hands-wrapper.test.ts

- [ ] **Step 1: Write failing packaging and skill tests.**

  Assert the skill has valid YAML metadata, a non-empty SKILL.md with an interactive intake table, a wrapper that prefers installed brain-hands and otherwise runs the checkout dist CLI, and plugin JSON with name, version, description, and skills directory. Assert package.json files includes dist, prompts, agentic-codex-workflow.md, README.md, .agents, and .codex-plugin and excludes src, tests, and local run ledgers.

  Run: npm test -- tests/skill-layout.test.ts tests/scripts/brain-hands-wrapper.test.ts
  Expected: failure because the skill distribution does not exist.

- [ ] **Step 2: Create the conversational skill.**

  SKILL.md must direct Codex to:

  1. detect an explicit Brain Hands request;
  2. collect only omitted mode, research, and reflection choices;
  3. state resolved role models without asking when defaults apply;
  4. use Codex built-in web research when research is enabled;
  5. invoke run and present the Brain plan;
  6. wait for explicit approval before approve-plan;
  7. report local_ready or pull_request_open with verifier evidence;
  8. treat reflection output as terminal;
  9. explain that update-from-reflection only writes a separate improvement plan.

  The openai.yaml agent metadata must describe the skill and point at SKILL.md. The wrapper must resolve its own path with fileURLToPath, walk four parent directories to the repository root, check for an installed brain-hands executable first, and otherwise execute node DIST_CLI with inherited stdin, stdout, stderr, and exit code. Before dispatch, run the chosen CLI version and doctor capability handshake; render a recovery message that distinguishes missing installed binary from an outdated Codex CLI contract.

- [ ] **Step 3: Document clear operator contracts.**

  Update README.md with install, local, GitHub, research, reflection, status, resume, and update-from-reflection examples. Update agentic-codex-workflow.md with the approval boundary, the three role responsibilities, no-merge policy, ledger paths, worktree cleanup guidance, and the exact current Codex CLI flags. In cli-contract.md list every supported command and required option.

- [ ] **Step 4: Update package metadata.**

  Set version to 0.2.0. Add a test:skill script running the two skill tests. Keep the package files allowlist limited to dist, prompts, agentic-codex-workflow.md, README.md, package metadata, .agents, and .codex-plugin.

- [ ] **Step 5: Prove the focused tests pass.**

  Run: npm test -- tests/skill-layout.test.ts tests/scripts/brain-hands-wrapper.test.ts
  Expected: all pass.

- [ ] **Step 6: Commit skill distribution.**

  Run: git add .agents .codex-plugin package.json README.md agentic-codex-workflow.md tests && git commit -m "feat: distribute brain hands as a codex skill"

## Task 11: Run full verification and release-readiness checks

**Files:**
- Modify only if verification reveals a defect in a file owned by this plan.

- [ ] **Step 1: Run the complete automated suite.**

  Run: npm test
  Expected: all legacy-compatible and V2 tests pass.

- [ ] **Step 2: Run static and package validation.**

  Run: npm run typecheck
  Run: npm run build
  Run: npm pack --dry-run
  Run: git diff --check
  Expected: all pass; packed contents match the allowlist.

- [ ] **Step 3: Exercise installed and development CLI surfaces.**

  Run: brain-hands --version
  Run: npm run dev -- doctor --repo . --mode local
  Run: node dist/cli.js run --help
  Expected: stable installed command remains callable; development command reports capability status; run help exposes V2 choices.

- [ ] **Step 4: Run authenticated planner smoke only after user approval for real model usage.**

  Use a disposable temporary Git repository and:

  ~~~text
  node dist/cli.js run "Return a one-item no-change plan." \
    --repo TEMP_REPO --mode local --no-research --no-reflection \
    --brain-model gpt-5.6 --dry-run false
  ~~~

  Verify the run ends awaiting_plan_approval, has a schema-valid plan, has no worktree, and made no GitHub call. Do not approve it.

- [ ] **Step 5: Perform final source review.**

  Inspect git status, git log origin/main..HEAD, package dry-run contents, and the V2 local dry-run ledger. Confirm no credentials, run artifacts, worktrees, npm cache files, or generated test outputs are staged.

- [ ] **Step 6: Commit only a defect correction found in Steps 1 through 5.**

  Use a focused commit message naming the repaired contract. If no defect is found, make no extra commit.

## Final Acceptance Criteria

- The Brain Hands skill asks only for omitted mode, research, and reflection choices, then exposes resolved role models.
- The current Codex CLI flag contract is used for every live role invocation and is preflight-checked.
- No task can change code or create GitHub resources before explicit plan approval.
- Local and GitHub runs use an isolated branch plus worktree; local mode never accesses GitHub or remotes.
- Hands changes code, Verifier independently decides approval, and every verification command is direct argv and policy-checked.
- GitHub mode produces per-item issues and one unmerged integrated PR.
- Reflection is terminal; update-from-reflection only writes a standalone improvement plan.
- The full test, typecheck, build, packaging, diff, CLI, and approved live-planner checks pass.
