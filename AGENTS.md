# Operating Principles

## 1. Think Before Coding

Don't assume. Don't hide confusion. Surface tradeoffs.

Before implementing:

- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them; don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

Minimum code that solves the problem. Nothing speculative.

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.
- Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

Touch only what you must. Clean up only your own mess.

When editing existing code:

- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it; don't delete it.

When your changes create orphans:

- Remove imports, variables, and functions that your changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

Define success criteria. Loop until verified.

Transform tasks into verifiable goals:

- "Add validation" -> "Write tests for invalid inputs, then make them pass."
- "Fix the bug" -> "Write a test that reproduces it, then make it pass."
- "Refactor X" -> "Ensure tests pass before and after."

For multi-step tasks, state a brief plan:

1. [Step] -> verify: [check]
2. [Step] -> verify: [check]
3. [Step] -> verify: [check]

Strong success criteria let you loop independently. Weak criteria like "make it work" require constant clarification.


## Git Workflow

- Work on `main` unless the user explicitly asks for a feature branch.
- Ignore git changes that were not made in the current working session. Do not revert, reformat, stage, or clean up unrelated changes unless the user explicitly asks.

## Subagents

Only spawn subagents when I ask you to.

## Local Development vs Stable CLI

- Treat `brain-hands` installed from npm as the stable command for real workflows.
- Use the local checkout for development iteration with `npm run dev -- ...` or `npm run build && node dist/cli.js ...`.
- Do not use `npm link` for the primary `brain-hands` command; it makes the stable command point at the mutable working tree.
- Prove a release candidate with `npm run verify:funnel`, then inspect those tested bytes with `npm pack --dry-run --json --ignore-scripts`.
- The release-candidate funnel builds once, sets `BRAIN_HANDS_DIST_IMMUTABLE=1` for post-build tests, and keeps `dist/` digest-checked for byte changes. Test workers must not invoke clean, build, or `npm test`.
- Keep `prepack` as the defensive lifecycle for a later standalone real pack or publish; that publication boundary is distinct from inspection of the already-tested candidate.
- The npm package is `@ngelik/brain-hands`; keep runtime package contents limited to `dist/`, `prompts/`, `agentic-codex-workflow.md`, `README.md`, and package metadata.
