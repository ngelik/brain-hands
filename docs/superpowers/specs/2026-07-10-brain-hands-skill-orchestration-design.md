# Brain Hands Skill Orchestration Design

**Date:** 2026-07-10
**Status:** Approved design
**Scope:** Convert the existing brain-hands prototype into a Codex skill with a deterministic CLI engine, three model roles, GitHub and local execution modes, optional Codex web research, optional reflection, and reflection-to-plan analysis.

## Objective

Brain Hands lets a user ask Codex to create a feature, build a project, fix a bug, or perform another repository task "using Brain Hands." The user experience is conversational, while execution is reproducible and resumable.

The accepted boundary is:

- The $brain-hands skill owns intake, missing-setting questions, resolved-setting presentation, and the mandatory plan-approval conversation.
- The brain-hands CLI owns state transitions, model invocation, worktree isolation, GitHub or local delivery, verification, retries, evidence, reflection, and recovery.
- Brain, Hands, and Verifier are independent roles with explicit model and sandbox policies.

## Audit Snapshot

### Current strengths

The current @ngelik/brain-hands@0.1.0 implementation already provides:

- A TypeScript CLI built with Commander, Zod, YAML, Execa, and Vitest.
- Durable run directories under .brain-hands/runs/<run-id>/.
- Structured issue, review, manifest, browser-check, and verification-evidence schemas.
- Prompt packs for planning, critique, implementation, fixes, review, and final audit.
- Git and GitHub adapters.
- Local command verification with persisted stdout and stderr.
- Browser verification and screenshot evidence.
- Local review packages containing tracked and untracked diffs.
- Status and recovery guidance.
- A stable npm package shape containing runtime prompts and workflow documentation.

The checkout was clean on main at the start of this design pass. Verification results:

- npm test: 18 files and 104 tests passed.
- npm run typecheck: passed.
- npm run build: passed.
- npm pack --dry-run: passed with the known temporary npm-cache workaround and produced the expected 31-file package.
- Installed brain-hands --version: 0.1.0.
- Installed brain-hands doctor --repo . --no-github: passed its existing checks.

### Confirmed runtime blockers

The passing tests do not establish live readiness.

1. src/core/config.ts and src/adapters/codex.ts pass --reasoning-effort to codex exec. Codex CLI 0.143.0 rejects that flag. Current Codex uses a config override such as -c model_reasoning_effort="high".
2. src/workflow/planner.ts does not fail immediately when the planner subprocess exits non-zero. It continues with empty stdout and reports a misleading JSON parse failure.
3. doctor checks codex --version but not the actual argument contract, authentication, configured models, structured-output support, or sandbox behavior.
4. A disposable-repository smoke of installed brain-hands run failed before planning because of the invalid argument.
5. Corrected direct invocations of gpt-5.5 and gpt-5.3-codex-spark succeeded on the ChatGPT-authenticated account. The immediate blocker is the Brain Hands invocation contract, not those two model names.

### Product and workflow gaps

- There is no Codex SKILL.md, plugin manifest, skill metadata, or cross-repository installation path.
- Live run, implement, and review always construct the GitHub adapter. github.enabled false affects doctor only.
- implement always opens a PR, and final audit requires a PR. The local review package is not an end-to-end local mode.
- The current four profiles are task variants of two roles. There is no independent Verifier.
- resume prints advice but does not resume execution.
- run plans only; later transitions require manual low-level commands.
- No mandatory plan-approval stage exists.
- Documentation promises worktrees, but implementation creates a branch in the active checkout.
- Commit, push, PR, multi-item progression, and dependency handling are incomplete.
- The fix command invokes Hands but does not itself complete re-verification and review.
- max_replan_attempts, default_remote, temperature, responsibilities, GitHub update methods, and some stages are declared but not enforced.
- Planner and reviewer output is extracted from mixed prose and JSON rather than Codex structured output.
- There is no explicit research setting, source manifest, reflection, or reflection-to-plan path.
- Model-authored verification commands execute without a frozen-plan approval contract.
- Child Codex sessions inherit unrelated local plugins, hooks, and MCP startup behavior, increasing cost and failure risk.

### Environment snapshot

- Codex authentication through ChatGPT succeeds.
- GitHub CLI authentication for ngelik was confirmed outside the sandbox with repo scope.
- A sandboxed gh auth status check produced a false negative, so preflight must distinguish an environment/keyring denial from an invalid credential.
- The remote is https://github.com/ngelik/brain-hands.git and the branch is main.

## Current OpenAI Surface

The July 9, 2026 release integrated Codex into the ChatGPT desktop app. It did not remove the Codex CLI or non-interactive execution.

- Skills work in the ChatGPT desktop app, Codex CLI, and IDE extension.
- Codex can select a skill implicitly or through $brain-hands.
- codex exec remains the supported non-interactive interface.
- --output-schema provides structured final output.
- Current local Codex releases support subagents and custom agent configurations.
- Native subagents are useful, but are not the primary Brain Hands engine because the CLI ledger provides stronger reproducibility and recovery.
- "Deep research" means a Brain phase using Codex built-in live web search. It does not use the separate Deep Research API.

Official references:

- [Codex changelog](https://learn.chatgpt.com/docs/changelog)
- [Build skills](https://learn.chatgpt.com/docs/build-skills)
- [Skills and plugins](https://learn.chatgpt.com/docs/skills-and-plugins)
- [Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents)
- [Non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode)
- [Configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)

## Accepted Decisions

1. Use a hybrid architecture: skill for conversation, brain-hands for deterministic execution.
2. Use Brain, Hands, and Verifier as the three roles.
3. Use Codex built-in web search for optional research.
4. Ask for execution mode, research, and reflection when missing.
5. Do not ask for omitted models. Use config defaults and show them.
6. Require approval of the Brain plan before edits or external side effects.
7. Use an isolated local Git worktree and branch in both modes.
8. GitHub mode may create issues, push, and open a PR, but never merges.
9. Local mode never pushes and creates no GitHub objects.
10. Reflection is optional and runs after Verifier approval.
11. --update-from-reflection generates an improvement plan and stops. Implementation belongs in a separate Codex task.

## Architecture

~~~mermaid
flowchart TD
    U["User invokes $brain-hands"] --> S["Brain Hands skill"]
    S --> I["Resolve intake settings"]
    I --> C["brain-hands engine"]
    C --> L["Durable run ledger"]
    C --> B["Brain: research and plan"]
    B --> A{"User approves plan?"}
    A -->|Revise| B
    A -->|Approve| W["Create isolated worktree"]
    W --> H["Hands: implement"]
    H --> D["Deterministic verification"]
    D --> V["Verifier: independent review"]
    V -->|Fixes| H
    V -->|Replan| B
    V -->|Approved| F["Final integrated verification"]
    F --> R{"Reflection enabled?"}
    R -->|Yes| X["Write reflection"]
    R -->|No| Z["Complete"]
    X --> Z
~~~

### Skill ownership

The skill may:

- Recognize explicit or implicit Brain Hands requests.
- Ask one concise question for each missing setting.
- Show mode, research, reflection, and resolved models.
- Invoke CLI commands and consume JSON responses.
- Present the Brain plan and record approval or revision requests.
- Report progress, blockers, artifacts, and final results.

The skill may not:

- Reimplement the state machine in prose.
- Infer approval from silence.
- Mutate before plan approval.
- Bypass failed preflight or verification.
- Continue from reflection into implementation.

The CLI owns every durable or side-effecting transition. State must be recoverable from artifacts rather than hidden chat context.

## Role Contracts

### Brain

Responsibilities:

- Inspect repository content and applicable AGENTS.md files.
- Identify assumptions and unresolved requirements.
- Perform built-in web research when enabled.
- Record source URLs, titles, retrieval time, and supported conclusions.
- Produce architecture, risks, work items, acceptance criteria, and exact verification commands.
- Revise rejected plans.
- Produce optional reflection.
- Produce a separate improvement plan from a prior reflection.

Restrictions:

- Read-only sandbox.
- No edits, Git mutations, GitHub mutations, or implementation.
- Does not approve implementation.

### Hands

Responsibilities:

- Implement one approved work item at a time.
- Make the smallest changes satisfying the frozen plan.
- Add or update focused tests.
- Apply exact Verifier findings.
- Report changed files, attempted commands, and risks.

Restrictions:

- Workspace-write limited to the run worktree.
- No architecture or scope expansion without replan.
- No GitHub mutation, push, approval, or merge; the CLI owns delivery.

### Verifier

Responsibilities:

- Independently inspect diff and runtime behavior.
- Check every acceptance criterion.
- Review command, artifact, and browser evidence.
- Return approve, request_changes, or replan_required with exact findings.
- Perform the final integrated audit.

Restrictions:

- Read-only sandbox.
- No fixes or edits.
- Cannot approve missing, failed, stale, or unjustifiably skipped evidence.

## Intake and Approval

Normalized intake contains:

- task text
- absolute repository root
- mode: github or local
- research boolean
- reflection boolean
- optional per-role model overrides
- resolved models and reasoning settings
- Brain Hands version
- Codex version and detected capabilities

The skill asks only for missing mode, research, or reflection. Missing models come from config and are displayed.

The Brain plan shown for approval includes:

- research conclusions and sources when enabled
- architecture and assumptions
- ordered work items and dependencies
- included and excluded scope
- acceptance criteria
- exact verification commands
- expected artifacts and browser checks
- GitHub effects in GitHub mode
- risks and blockers

Approval freezes a plan revision. New scope, work items, or verification commands require a new Brain revision and explicit approval.

Before approval, there can be no target-repository write or GitHub mutation.

## Command Surface

Primary flow:

~~~text
brain-hands run "<task>" \
  --repo <path> \
  --mode <github|local> \
  [--research|--no-research] \
  [--reflection|--no-reflection] \
  [--brain-model <model>] \
  [--hands-model <model>] \
  [--verifier-model <model>] \
  [--json]

brain-hands approve-plan --run <run-dir> [--json]
brain-hands resume --run <run-dir> [--json]
brain-hands status --run <run-dir> [--json]

brain-hands reflection \
  --update-from-reflection <reflection-path> \
  --repo <brain-hands-source-repo> \
  [--brain-model <model>] \
  [--json]
~~~

run performs validation, capability preflight, ledger creation, optional research, and planning. It ends at awaiting_plan_approval.

approve-plan records explicit approval, creates the worktree, synchronizes GitHub issues when applicable, and begins or resumes execution.

resume executes the first incomplete durable transition. It does not merely print instructions.

reflection --update-from-reflection writes an improvement plan and exits without editing or invoking Hands.

The existing implement, review, fix, review-package, issue import, and browser verify commands remain diagnostic and recovery tools. They cannot bypass plan approval.

## Configuration Version 2

~~~yaml
version: 2

github:
  default_remote: origin

codex:
  command: codex
  timeout_seconds: 3600
  isolate_user_config: true

retry_policy:
  max_hands_fix_attempts: 3
  max_replan_attempts: 2

profiles:
  brain:
    model: gpt-5.6
    reasoning_effort: high
    sandbox: read-only

  hands:
    model: gpt-5.6-terra
    reasoning_effort: medium
    sandbox: workspace-write

  verifier:
    model: gpt-5.6
    reasoning_effort: high
    sandbox: read-only
~~~

Model names are defaults, not permanent aliases. Runs may override them. Capability preflight rejects unavailable models before target-repository mutation.

Mode, research, and reflection are run inputs rather than silent defaults because the skill asks when omitted.

Migration maps:

- brain_planner to brain
- hands_implementer and hands_fixer to hands
- brain_reviewer to verifier

Migration creates a backup before replacing config. Existing run directories are never rewritten.

## Structured Model Outputs

Every role uses codex exec --output-schema with a role-specific schema.

### BrainPlan

Required fields:

- summary
- assumptions
- research and research_sources
- architecture
- risks
- work_items
- integration_verification

Each work item has a stable local ID, goal, dependencies, included and excluded scope, implementation steps, acceptance criteria, verification commands, expected artifacts, browser checks, risks, and Hands handoff.

### ImplementationResult

Required fields:

- work_item_id
- changed_files
- tests_added_or_changed
- commands_attempted
- completed_steps
- remaining_risks

This report is not proof. Git diff and deterministic verification remain authoritative.

### VerifierReview

Required fields:

- decision
- acceptance_coverage
- evidence_reviewed
- findings
- residual_risks

Each finding includes severity, file, line when applicable, problem, required fix, and exact re-verification.

### Reflection

Required fields:

- outcome_summary
- what_worked
- what_failed
- root_causes
- avoidable_rework
- process_improvements
- candidate_regression_tests
- evidence_paths

Reflection evaluates the process and cannot change completion status.

### ImprovementPlan

Required fields:

- reflection_source
- observed_problem
- evidence
- recommended_changes
- expected_benefits
- implementation_sequence
- tests_and_acceptance_criteria
- risks
- out_of_scope

This object is terminal for --update-from-reflection.

## Run Ledger Version 2

~~~text
.brain-hands/runs/<run-id>/
  manifest.json
  intake.json
  preflight.json
  original-request.md
  research.md
  research-sources.json
  architecture-plan.md
  work-items.json
  plan-approval.json
  git-context.json
  github-map.json
  events.jsonl
  prompts/
  responses/
  implementation/
  verification/
  reviews/
  final-audit.md
  reflection.json
  reflection.md
~~~

The manifest records schema and run versions, absolute repo root, times, detected capabilities, settings, resolved role profiles, plan revision and approval, current stage and work item, worktree and branch, retries, GitHub mappings, delivery state, and last blocker.

events.jsonl is append-only and records transition start, success, failure, and external identifiers. The manifest remains the current snapshot.

Operational stages:

~~~text
intake
preflight
brain_planning
awaiting_plan_approval
worktree_setup
github_issue_sync
implementing
verifying
verifier_review
fixing
replanning
final_verification
delivery
reflecting
complete
~~~

Failure preserves the active stage and records a blocker. In GitHub mode, complete means workflow-complete and merge-ready, not merged or deployed.

## Git and Delivery

Both modes create one isolated worktree and one feature branch for the approved run. Work items are implemented sequentially with focused commits.

If the source checkout is dirty, Brain Hands stops before worktree creation. It never stashes, resets, deletes, or silently copies uncommitted changes.

### GitHub mode

After approval:

1. Confirm gh authentication, repository identity, remote, scopes, and push access.
2. Create or locate one issue per work item.
3. Persist local-ID-to-issue mappings immediately.
4. Create the run worktree and branch.
5. Implement and verify work items sequentially with focused commits.
6. Push the run branch.
7. Create one integrated task-level PR referencing every issue.
8. Persist the PR immediately.
9. Run Verifier and fix loops against the integrated diff and per-item evidence.
10. Stop with a merge-ready PR.

One integrated PR avoids stacked-branch and unmerged-dependency problems while retaining issue-level tracking.

The CLI never merges, deploys, publishes, or enables auto-merge.

### Local mode

Local mode uses the same Brain, Hands, verification, Verifier, fix, final-audit, and optional-reflection sequence.

It never calls gh, accesses a remote, pushes, creates issues, comments, or opens a PR. Completion reports the local worktree, branch, commits, diff, evidence, and review artifacts.

## Codex Invocation Policy

The adapter builds current arguments from typed inputs rather than user-authored templates.

Common invocation properties:

- codex exec
- --ephemeral
- --ignore-user-config when isolation is enabled
- explicit --model
- explicit -c model_reasoning_effort="..."
- explicit --sandbox
- explicit -C <repo-or-worktree>
- explicit --output-schema <schema-path>
- --search only for research-enabled Brain planning

Authentication is reused when user config is ignored. Project AGENTS.md remains repository context.

The CLI stores rendered argv with secrets redacted. It checks exit status before stdout. Non-zero exit, timeout, missing output, or schema failure is a typed failure and cannot advance state.

## Verification and Safety

Verification commands are part of the approved plan. Approval freezes their executable and argument arrays.

The runner:

- never invokes a shell
- rejects empty commands and shell operators
- rejects known destructive commands and unsafe paths
- runs inside the active worktree
- enforces timeouts
- captures stdout, stderr, exit status, signal, and timeout
- checks declared artifacts
- normalizes browser evidence
- fails closed on missing or unjustifiably skipped evidence

A new command or changed acceptance criterion requires a replan and approval.

Brain and Verifier are read-only. Hands cannot write outside the worktree. GitHub credentials belong only to the deterministic adapter and never enter model prompts.

## Error Handling and Recovery

### Preflight failure

Stop before a paid model run or target side effect. Report the exact capability, auth, model, Git, dirty-checkout, or GitHub problem.

### Model failure

Persist prompt, redacted argv, stdout, stderr, and typed failure. Do not parse empty or partial output.

### Verification failure

Persist evidence and remain at verifying. Do not commit, push, open a PR, or request approval for failed work.

### Verifier findings

Pass only structured findings and the frozen work item to Hands. Rerun affected checks, then the full required set, then Verifier.

### Replan

Architecture or requirement gaps return to Brain. The new revision requires user approval before further edits.

### Retry exhaustion

Stop with attempts, repeated findings, evidence, branch/worktree path, and a recommended manual next action.

### Resume and idempotency

GitHub mutations use stored mappings and stable markers. Resume queries existing state before creating anything. Completed local transitions rerun only when their input hash changed.

## Reflection and Improvement Planning

Reflection is optional and begins after final Verifier approval.

Brain receives the request, approved plans, implementation reports, verification evidence, findings, retry history, Git history, and delivery result. JSON and Markdown are saved and shown.

Reflection distinguishes implementation defects, planning defects, verification gaps, environment failures, external blockers, and unnecessary cost or rework. It never triggers changes.

The separate reflection --update-from-reflection flow validates the reflection, inspects the Brain Hands source read-only, generates an improvement plan with regression tests, saves it, prints its path, and exits. It never invokes Hands, edits, runs implementation, creates GitHub objects, or continues automatically.

## Skill and Distribution Layout

~~~text
.agents/skills/brain-hands/
  SKILL.md
  agents/openai.yaml
  scripts/brain-hands.mjs
  references/
.codex-plugin/plugin.json
~~~

The plugin manifest points to ./.agents/skills/. The npm files allowlist adds .agents/ and .codex-plugin/ to current runtime files.

The wrapper resolves the bundled CLI when installed as a plugin and otherwise prefers stable brain-hands on PATH. It performs a version and capability handshake. Development continues through npm run dev or node dist/cli.js; npm link remains discouraged for the stable command.

## Testing Strategy

### Unit

- Config v2 and v1 migration.
- Model override and default resolution.
- Current Codex argv rendering.
- Capability detection.
- Immediate subprocess failure propagation.
- All role schemas.
- Approval freezing and state legality.
- Retry and replan limits.
- Verification command policy.
- Reflection and ImprovementPlan schemas.
- GitHub idempotency mappings.

### Integration

- Real temporary Git repos for worktree, branch, commits, resume, and diff.
- Dirty-checkout rejection without mutation.
- Local mode proving no GitHub or network adapter call.
- GitHub mode with fake gh for auth, issues, resume, push, PR, comments, and completion.
- Verifier rejection, fix, re-verification, approval, exhaustion, and replan.
- Research enabled and disabled with source persistence.
- Browser pass, failure, skip, and missing artifacts.
- Reflection only after approval.
- --update-from-reflection producing a plan with no source change.

### Skill

- Explicit $brain-hands and implicit "using Brain Hands" triggers.
- Missing-setting questions.
- Model defaults shown without prompting.
- Resolved summary and mandatory approval.
- Plan revision.
- CLI JSON and blocker presentation.
- Invocation from another repository.

### Live smoke

- Authenticated Brain structured-output call.
- Hands call in a disposable worktree.
- Verifier call against a known diff.
- Installed CLI outside the source checkout.
- User-scoped skill from a separate temp repo.
- Opt-in GitHub mode in a dedicated test repo.

Live tests are separate because they consume model usage and require network or GitHub.

Release gates:

~~~text
npm test
npm run typecheck
npm run build
npm pack --dry-run
git diff --check
installed CLI smoke
skill validation smoke
~~~

A real authenticated planner smoke is required. Unit tests alone are insufficient because v0.1.0 passed them while the live invocation was broken.

## Delivery Sequence

1. Compatibility repair: current arguments, structured output, exit propagation, and capability doctor.
2. Core v2 contracts: three roles, migration, intake, ledger, events, and approval.
3. Local execution: worktree, real resume, commits, Hands/Verifier loop, final audit, local completion.
4. GitHub execution: issue sync, push, integrated PR, comments, mappings, idempotent resume.
5. Research and reflection: web sources, reflection, analysis-only improvement planning.
6. Skill and distribution: instructions, wrapper, metadata, plugin, package, cross-repo smoke.
7. Documentation and release: README, example config, migration guide, AGENTS.md, stable install, full verification.

The detailed implementation plan must use file-level TDD and preserve this ordering. Compatibility repair cannot be deferred.

## Non-Goals

- Automatic merge, deployment, or npm publication.
- Automatically implementing an improvement plan.
- Continuing reflection work in the same task.
- OpenAI Deep Research API integration.
- Parallel Hands writers.
- Multiple target repositories per run.
- Replacing the CLI engine with native subagents in v1.
- Silent handling of dirty checkouts.
- Hidden changes to approved scope or verification.

## Success Criteria

1. A user can invoke $brain-hands or ask to use Brain Hands from any repo.
2. Missing mode, research, and reflection are requested.
3. Missing models come from config and are displayed.
4. Brain produces structured research and planning artifacts.
5. No write or GitHub effect occurs before approval.
6. Local mode completes in an isolated worktree without remote operations.
7. GitHub mode creates work-item issues, pushes one run branch, and opens one integrated PR without merging.
8. Hands cannot approve its work; Verifier checks real evidence.
9. Failures stop with exact persisted evidence.
10. resume continues without duplicate local or GitHub work.
11. Optional reflection records process strengths and weaknesses.
12. --update-from-reflection creates only an improvement plan and stops.
13. Tests, typecheck, build, package, installed CLI smoke, skill smoke, and authenticated planner smoke pass.
