# Planner recovery testing

Planner validation is tested in three layers:

1. Focused unit tests cover structured readiness diagnostics, safe JSON patch application, progress invocation identity, and deterministic controller selection.
2. The replay suite exercises the failure sequence seen in real workflows: unknown evidence, missing test evidence, forbidden command policy, non-improving repair, interruption, resume, and final valid promotion. Run it with `npm run test:planner-replay`.
3. The live canary is opt-in and is never run by CI. After `npm run build`, run `BRAIN_HANDS_LIVE_CANARY=1 npm run canary:planner -- --json`. It creates a temporary local Git repository, invokes the real Codex-backed discovery boundary, and leaves the source checkout unchanged.

Use `brain-hands plan-check --run <run-dir> --candidate <plans/path.json> --json` to inspect a persisted candidate without changing the run. A non-ready candidate exits nonzero and returns stable code/path/message diagnostics.

CI and release gates remain deterministic: `npm test`, `npm run typecheck`, `npm run build`, `npm run validate-release`, and `npm pack --dry-run`.
