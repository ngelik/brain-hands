# Brain Hands Solar 3D Workflow Design

## Context

The first solar-system test proved that `brain-hands` can persist a workflow run, call Codex roles, run local verification, and support a brain/hands review loop. It also exposed three gaps that matter before using the workflow for larger frontend work:

- Live GitHub automation can be unavailable even when `gh --version` passes.
- Frontend/browser evidence needs structured storage, not only manual notes.
- The workflow needs an auditable no-GitHub path so work can continue when auth fails.

The next iteration improves `brain-hands` first, then uses it to upgrade the solar-system app into a richer local 3D experience.

## Approved Approach

Use the Superpowers option 1 execution style: subagent-driven development. The controller plans and reviews as the brain, implementation tasks are delegated to hands agents, and each task receives review plus verification before the next task.

Model routing is explicit:

- Brain planning and review: `gpt-5.5` with high reasoning.
- Hands implementation and fixes: `gpt-5.3-codex-spark`.

GitHub mode is best-effort:

- Try `gh auth login` through Chrome.
- If it fails, continue in no-GitHub mode.
- Persist the selected mode in docs and run artifacts so this is visible rather than hidden.

## Workflow Changes

1. Add strict preflight.
   - `doctor --strict` checks command availability, Codex model invocation, GitHub auth when GitHub mode is enabled, and config model IDs.
   - `doctor --no-github --strict` skips GitHub auth and reports no-GitHub mode explicitly.

2. Add no-GitHub execution mode.
   - CLI commands that normally use GitHub can run with local/dry GitHub adapters while still using real Codex.
   - This keeps planning, issue import, implementation, verification, review, and final audit usable when GitHub auth is unavailable.

3. Add structured browser evidence.
   - Issue specs can declare browser checks with URL, local server command, console policy, screenshot artifact, and network expectations.
   - Verification evidence can store browser reports alongside command evidence.

4. Add issue import.
   - `brain-hands issue import --run <runDir> --file <issue.json> --repo <path>` replaces or seeds `issues.json` through schema validation.
   - This makes brain/human issue refinement auditable without direct ledger edits.

5. Strengthen final audit.
   - Final audit receives acceptance criteria, command evidence, browser evidence, skipped requirements, and external blockers.
   - Dry-run fallback reports must distinguish synthetic approvals from real brain approvals.

## Solar App Changes

After the workflow improvements land, use the improved no-GitHub path to create/import a new issue for the solar app. The app should become a local 3D space simulator:

- Full-bleed Three.js scene with Sun, planets, orbital paths, starfield, and camera controls.
- Spacecraft and stations: ISS, Tiangong, Hubble, Voyager 1, Voyager 2, New Horizons, Parker Solar Probe, Juno, Cassini, Rosetta, and Mars Reconnaissance Orbiter.
- Controls for focus target, orbit labels, spacecraft visibility, time speed, trails, and camera reset.
- Responsive desktop/mobile layout with no overlapping controls.
- Reduced-motion behavior that still renders a nonblank static scene.
- Browser verification that checks canvas pixels, DOM state, controls, console errors, and expected asset/network behavior.

## Verification Strategy

Workflow verification:

- `npm test`
- `npm run typecheck`
- `npm run build`
- `git diff --check`
- `node dist/cli.js doctor --repo . --strict --no-github`
- one no-GitHub `brain-hands` dry or live-compatible run using imported issue specs

Solar app verification:

- `node --check solar-system-browser/solar-system.js`
- `node --check solar-system-browser/scripts/verify.mjs`
- `node solar-system-browser/scripts/verify.mjs`
- local HTTP server plus Chrome verification of the 3D scene
- screenshot and browser report artifacts under `reports/`

## Non-Goals

- No deployment.
- No automatic merge.
- No dependency on live GitHub if `gh auth` remains invalid.
- No remote image/model assets for the solar app.

## Self-Review

- No placeholders remain.
- The design preserves the original full goal: improve workflow first, then use it to improve the solar app.
- GitHub auth failure is an explicit supported mode, not a silent downgrade.
- Browser verification is treated as evidence, not chat-only notes.
