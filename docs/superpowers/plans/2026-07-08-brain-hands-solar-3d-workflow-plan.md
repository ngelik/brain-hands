# Brain Hands Solar 3D Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve `brain-hands` with strict/no-GitHub workflow evidence support, then use it to upgrade the local solar-system app into a verified 3D spacecraft experience.

**Architecture:** Keep `brain-hands` as the control plane. Add small schema/config/preflight extensions instead of a parallel orchestrator, then run the solar app upgrade through the new no-GitHub/import path.

**Tech Stack:** TypeScript, Node.js, Commander, Zod, Vitest, Codex CLI, GitHub CLI best-effort, Chrome verification, static browser app, Three.js from npm or local bundled module.

## Global Constraints

- Brain model: `gpt-5.5` with high reasoning.
- Hands model: `gpt-5.3-codex-spark`.
- Use no-GitHub mode if `gh` auth cannot be completed.
- Do not deploy the solar app.
- Do not use remote runtime assets for the solar app.
- Keep work auditable through committed docs, run artifacts, verification reports, and tests.
- Preserve existing dry-run behavior unless a task explicitly changes it.

---

## File Structure

- Modify `src/core/types.ts`: add browser evidence and preflight-related types.
- Modify `src/core/schema.ts`: validate browser checks, browser reports, and model IDs.
- Modify `src/core/config.ts`: default concrete model IDs and model-aware Codex args.
- Modify `src/cli.ts`: add strict/no-GitHub doctor options and issue import command.
- Create `src/workflow/issue-import.ts`: schema-validated issue import helper.
- Create `src/workflow/preflight.ts`: strict dependency checks.
- Modify `src/verification/runner.ts`: persist browser evidence supplied by issue specs or imported reports.
- Modify tests under `tests/core`, `tests/workflow`, `tests/verification`, and `tests/cli-smoke.test.ts`.
- Modify `solar-system-browser/index.html`, `styles.css`, `solar-system.js`, `README.md`, and `scripts/verify.mjs`.
- Add report artifacts under `reports/`.

---

### Task 1: Strict Preflight, Concrete Models, And No-GitHub Mode

**Files:**
- Modify: `src/core/config.ts`
- Modify: `src/core/schema.ts`
- Modify: `src/core/types.ts`
- Create: `src/workflow/preflight.ts`
- Modify: `src/cli.ts`
- Modify: `docs/example-config.yaml`
- Modify: `.brain-hands/config.yaml`
- Test: `tests/core/config.test.ts`
- Test: `tests/cli-smoke.test.ts`

**Interfaces:**
- Produces: `runPreflight({ repoRoot, config, strict, githubMode })`.
- Produces CLI: `doctor --strict --no-github`.

- [ ] **Step 1: Write failing config tests**

Add assertions that defaults use:

```ts
expect(config.codex.args_template).toEqual(["exec", "--model", "{{model}}"]);
expect(config.profiles.brain_planner.model).toBe("gpt-5.5");
expect(config.profiles.brain_reviewer.model).toBe("gpt-5.5");
expect(config.profiles.hands_implementer.model).toBe("gpt-5.3-codex-spark");
expect(config.profiles.hands_fixer.model).toBe("gpt-5.3-codex-spark");
```

Run: `npm test -- tests/core/config.test.ts`

- [ ] **Step 2: Add preflight helper**

Create `src/workflow/preflight.ts` with a `runPreflight` function that checks `git --version`, `codex --version`, `gh --version`, and `gh auth status` only when GitHub mode is enabled. The function returns structured checks instead of throwing unless `strict` is true.

- [ ] **Step 3: Wire CLI doctor options**

Update `doctor` so:

```text
node dist/cli.js doctor --repo . --strict --no-github
```

prints `OK`, `FAIL`, or `SKIP` lines and exits nonzero in strict mode only when required checks fail.

- [ ] **Step 4: Update model config docs**

Update default config and example config to use concrete model IDs and model-aware args.

- [ ] **Step 5: Verify**

Run:

```bash
npm test -- tests/core/config.test.ts tests/cli-smoke.test.ts
npm run typecheck
npm run build
node dist/cli.js doctor --repo . --strict --no-github
```

- [ ] **Step 6: Commit**

Commit message: `feat: add strict preflight and concrete model routing`

---

### Task 2: Browser Evidence Schema And Issue Import

**Files:**
- Modify: `src/core/types.ts`
- Modify: `src/core/schema.ts`
- Create: `src/workflow/issue-import.ts`
- Modify: `src/cli.ts`
- Modify: `prompts/brain-reviewer.md`
- Modify: `prompts/brain-final-auditor.md`
- Test: `tests/core/schema.test.ts`
- Create: `tests/workflow/issue-import.test.ts`
- Modify: `tests/cli-smoke.test.ts`

**Interfaces:**
- Produces type `BrowserCheckSpec`.
- Produces type `BrowserEvidenceReport`.
- Produces helper `importIssues({ runDir, filePath })`.
- Produces CLI: `brain-hands issue import --run <runDir> --file <issue.json>`.

- [ ] **Step 1: Write failing schema tests**

Extend a valid issue fixture with:

```ts
browser_checks: [
  {
    name: "desktop 3d smoke",
    url: "http://127.0.0.1:5177/solar-system-browser/index.html",
    local_server_command: "python3 -m http.server 5177 --bind 127.0.0.1",
    required_selectors: ["#spaceCanvas"],
    console_error_policy: "no_errors",
    expected_network: ["/solar-system-browser/solar-system.js"],
    screenshot_artifact: "reports/solar-3d-desktop.png"
  }
]
```

Run: `npm test -- tests/core/schema.test.ts`

- [ ] **Step 2: Add issue import helper**

Implement `importIssues` so it validates an issue object or issue array and writes formatted `issues.json`.

- [ ] **Step 3: Add nested CLI command**

Register `issue import` in `src/cli.ts` and add it to the smoke test command list.

- [ ] **Step 4: Prompt browser evidence into reviews**

Update brain reviewer/final auditor prompts so they explicitly inspect browser checks, screenshot artifacts, and skipped external requirements.

- [ ] **Step 5: Verify**

Run:

```bash
npm test -- tests/core/schema.test.ts tests/workflow/issue-import.test.ts tests/cli-smoke.test.ts
npm run typecheck
npm run build
```

- [ ] **Step 6: Commit**

Commit message: `feat: add browser evidence and issue import`

---

### Task 3: Use Improved Workflow To Seed The 3D Solar Issue

**Files:**
- Create: `solar-system-browser/issues/3d-spacecraft-upgrade.json`
- Modify: `reports/solar-workflow-test-report.md`

**Interfaces:**
- Consumes: `node dist/cli.js issue import`.
- Produces: a run ledger with a validated 3D solar issue.

- [ ] **Step 1: Build**

Run:

```bash
npm run build
```

- [ ] **Step 2: Create no-GitHub run**

Run:

```bash
node dist/cli.js run "Upgrade the local solar-system browser app into a fully 3D spacecraft experience." --repo . --dry-run
```

- [ ] **Step 3: Import real 3D issue**

Run:

```bash
node dist/cli.js issue import --run <runDir> --file solar-system-browser/issues/3d-spacecraft-upgrade.json --repo .
```

- [ ] **Step 4: Verify import**

Run:

```bash
node dist/cli.js status --run <runDir>
```

- [ ] **Step 5: Commit**

Commit message: `docs: seed 3d solar workflow issue`

---

### Task 4: Upgrade Solar App To 3D Spacecraft Experience

**Files:**
- Modify: `solar-system-browser/index.html`
- Modify: `solar-system-browser/styles.css`
- Replace or refactor: `solar-system-browser/solar-system.js`
- Modify: `solar-system-browser/scripts/verify.mjs`
- Modify: `solar-system-browser/README.md`

**Interfaces:**
- Produces a local browser app that renders a nonblank 3D scene and controls spacecraft focus.

- [ ] **Step 1: Add Three.js dependency or local module path**

Prefer npm `three` if install succeeds. If dependency install fails, implement lightweight canvas 3D projection with no remote assets and record the fallback in the report.

- [ ] **Step 2: Implement 3D scene**

Render Sun, planets, orbital paths, starfield, labels, and focusable spacecraft/stations.

- [ ] **Step 3: Implement controls**

Controls must include focus target, spacecraft visibility, labels, trails, time speed, and camera reset.

- [ ] **Step 4: Strengthen verifier**

Verifier must check required bodies, spacecraft names, reduced-motion support, nonblank rendering hooks, and browser-check metadata.

- [ ] **Step 5: Verify**

Run:

```bash
node --check solar-system-browser/solar-system.js
node --check solar-system-browser/scripts/verify.mjs
node solar-system-browser/scripts/verify.mjs
```

- [ ] **Step 6: Commit**

Commit message: `feat: upgrade solar app to 3d spacecraft experience`

---

### Task 5: Browser Verify, Review, Fix Findings, And Update Workflow Report

**Files:**
- Create/update: `reports/solar-3d-desktop.png`
- Create/update: `reports/solar-3d-browser-report.json`
- Modify: `reports/solar-workflow-test-report.md`

**Interfaces:**
- Produces final browser evidence and report updates.

- [ ] **Step 1: Run local server**

Run:

```bash
python3 -m http.server 5177 --bind 127.0.0.1
```

- [ ] **Step 2: Verify in Chrome**

Open:

```text
http://127.0.0.1:5177/solar-system-browser/index.html
```

Check nonblank canvas pixels, control interactions, no console errors from app code, and expected network behavior.

- [ ] **Step 3: Run full verification**

Run:

```bash
npm test
npm run typecheck
npm run build
git diff --check
node dist/cli.js doctor --repo . --strict --no-github
node solar-system-browser/scripts/verify.mjs
```

- [ ] **Step 4: Request final code review**

Use `gpt-5.5` high reasoning for final review. Fix Critical/Important findings with `gpt-5.3-codex-spark`.

- [ ] **Step 5: Commit**

Commit message: `docs: record 3d solar workflow verification`

## Self-Review

- Covers the full requested sequence: improve workflow, use it, upgrade solar app, fix findings, update report.
- Includes no-GitHub fallback because Chrome/GitHub auth can fail.
- Uses concrete requested model IDs.
- Includes command and browser verification.
- No placeholder tasks remain.
