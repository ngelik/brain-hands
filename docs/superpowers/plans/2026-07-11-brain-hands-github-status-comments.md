# Brain Hands GitHub Status Comments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one idempotent mutable status comment and one exclusive Brain Hands state label per GitHub work-item issue, plus immutable material-event comments and a verified PR-delivery comment.

**Architecture:** Persisted Brain Hands workflow state remains authoritative. A pure projector renders safe desired GitHub state, a checkpointed reconciler applies only missing mutations through narrow adapter methods, and the runtime calls that reconciler after durable boundaries without allowing synchronization failures to affect workflow truth.

**Tech Stack:** TypeScript 6, Node.js 20+, Zod 4, GitHub CLI/API, Vitest 4.

## Global Constraints

- Work on `main`; do not create a feature branch unless the user changes the instruction.
- Preserve unrelated worktree changes and touch only files listed by the active task.
- GitHub status is a best-effort projection; it must never become an approval, verification, review, or delivery gate.
- Each work-item issue owns one mutable status comment; the integrated PR receives no mutable status comment.
- The integrated PR receives one immutable delivery comment only after post-PR verification and persisted final Verifier approval.
- Update mutable status only at durable state transitions, never per command, token update, model message, or progress event.
- Preserve existing labels and reconcile exactly one label from the explicit seven-label `brain-hands:*` state allowlist.
- Never publish raw stdout/stderr, prompts, reasoning, arbitrary errors, absolute paths, environment values, secrets, or unknown model/tool fields.
- No-op resumes perform zero GitHub mutations.
- Local mode performs no GitHub status work and creates no GitHub status checkpoint.
- Do not depend on `progress.jsonl`; the ledger, evidence, and reviews remain authoritative.
- Do not add runtime dependencies.
- Keep all new GitHub capabilities optional on `GitHubAdapter` so existing test adapters remain source-compatible until they opt in.
- Run the full release-readiness suite before completion.

## Pre-Implementation Audit Amendments

The following requirements supersede conflicting examples later in this plan.
They were added after an independent review found crash, ownership, concurrency,
and public-data gaps.

- Persist a versioned `github-status-intents.jsonl` intent before the first
  remote mutation for every status boundary. Its fields are safe target
  coordinates, state, attempt, exact transition timestamp, validated local
  evidence/review paths, and deterministic event keys; it contains no rendered
  body, model text, command output, or secret.
- On every GitHub workflow entry and terminal fast-resume path, reconcile all
  durable intents plus any deterministic intent reconstructed from the ledger.
  Do not limit replay to checkpoint entries with `retry != null`.
- Persist every work-item Verifier `review_path` and attempt before acting on
  approve, request-changes, or replan. Persist
  `github_status_transition_at` in the same work-item progress write for every
  completed or blocked status. Use event timestamps for stage transitions;
  never render an earlier status from global `manifest.updated_at`.
- Add an atomic per-run status lock. A contending synchronizer returns a generic
  retry-pending result and makes no remote call. Use unique temporary checkpoint
  names and quarantine/rebuild a corrupt checkpoint without changing workflow
  truth.
- Render only fixed copy, safe generated IDs, fixed safe check labels, counts,
  and severity counts. Do not render branch names, raw model finding text,
  required fixes, residual-risk text, or arbitrary dynamic strings. Marker
  components must pass a strict safe grammar before use.
- A managed comment must have its exact marker as the first line and be authored
  by the authenticated GitHub actor. Foreign, malformed, or duplicate markers
  are a `comment_conflict` retry; never edit or suppress them.
- Resolve GitHub hostname, repository, and authenticated actor. Pass the
  resolved hostname to `gh api` and the full host/repository to `gh` commands;
  add GitHub Enterprise argv coverage. The dry-run adapter keeps in-memory
  comment and label state.
- Persist and validate `work_item_id -> issue_number` mapping. Do not use an
  ordered issue array as the status ownership source after planning changes.
- The integrated PR receives only a verified delivery event. It receives no
  blocker, replan, or requested-changes comments.
- Add tests for abrupt pre-sync crashes, terminal replay, corrupt checkpoints,
  lock contention, duplicate/foreign markers, malicious dynamic strings,
  GitHub Enterprise argv, work-item reorder, and integrated-event suppression.

---

## File Structure

**Create**

- `src/github/status-projection.ts` — safe status types, state-label catalog, deterministic markers and keys, bounded renderers, projection hash.
- `src/github/status-checkpoint.ts` — versioned checkpoint schema plus atomic read/write/update helpers.
- `src/github/status-sync.ts` — marker-aware, checkpointed issue/PR reconciliation and generic retry recording.
- `src/workflow/github-status.ts` — converts persisted runtime coordinates into projector inputs and contains the single best-effort runtime wrapper.
- `tests/github/status-projection.test.ts` — state mapping, content, hash, caps, and leakage tests.
- `tests/github/status-checkpoint.test.ts` — default, atomic update, schema, and recovery tests.
- `tests/github/status-sync.test.ts` — idempotency, crash windows, failure, label, and multi-item tests.
- `tests/workflow/github-status.test.ts` — runtime snapshot conversion and best-effort wrapper tests.

**Modify**

- `src/adapters/github.ts` — optional marker-addressed comment and state-label primitives in dry-run and `gh` adapters.
- `tests/adapters/github.test.ts` — comment API, pagination, stable IDs, label creation, and exact-allowlist reconciliation.
- `src/core/ledger.ts` — export validated run-event reading for material-event replay.
- `tests/core/ledger.test.ts` — validated event replay coverage.
- `src/workflow/runtime.ts` — invoke status synchronization after durable GitHub-mode boundaries.
- `tests/workflow/runtime-github.test.ts` — complete lifecycle, fix/replan/blocker, delivery, failure, and resume assertions.
- `README.md` — user-facing GitHub status behavior.
- `agentic-codex-workflow.md` — authority, retry, marker, and no-auto-merge contract.
- `.agents/skills/brain-hands/SKILL.md` — operator-facing status reporting behavior.

---

### Task 1: Define the Pure Status Projection Contract

**Files:**
- Create: `src/github/status-projection.ts`
- Create: `tests/github/status-projection.test.ts`

**Interfaces:**
- Produces: `BRAIN_HANDS_STATE_LABELS`, `BrainHandsIssueState`, `StatusCheck`, `StatusFinding`, `WorkItemStatusSnapshot`, `MaterialEventSnapshot`, `DesiredStatusProjection`, `statusMarker()`, `eventMarker()`, `projectWorkItemStatus()`, and `projectDeliveryEvent()`.
- Consumes: Node `createHash`; no filesystem, adapter, ledger, or runtime code.

- [ ] **Step 1: Write failing state, marker, and safety tests**

Create `tests/github/status-projection.test.ts` with focused examples:

```ts
import { describe, expect, it } from "vitest";
import {
  BRAIN_HANDS_STATE_LABELS,
  eventMarker,
  projectDeliveryEvent,
  projectWorkItemStatus,
  statusMarker,
  type WorkItemStatusSnapshot,
} from "../../src/github/status-projection.js";

const base: WorkItemStatusSnapshot = {
  runId: "2026-07-11T16-20-00Z-release-ci",
  workItemId: "model-catalog",
  workItemIndex: 2,
  workItemTotal: 3,
  branchName: "codex/release-ci",
  state: "reviewing",
  attempt: 1,
  maxAttempts: 3,
  transitionAt: "2026-07-11T16:25:00.000Z",
  planApproved: true,
  implementationRecorded: true,
  verification: {
    status: "passed",
    checks: [
      { index: 1, rawCommand: "npm run typecheck", status: "passed" },
      { index: 2, rawCommand: "npm test", status: "passed" },
    ],
    browser: "not_required",
  },
  verifier: { status: "running", findings: [] },
  materialEvents: [],
};

describe("GitHub status projection", () => {
  it("renders one marker, one state label, and deterministic content", () => {
    const first = projectWorkItemStatus(base);
    const second = projectWorkItemStatus(base);

    expect(first.label).toBe("brain-hands:reviewing");
    expect(first.marker).toBe(statusMarker(base.runId, base.workItemId));
    expect(first.body).toContain("**State:** Verifier review");
    expect(first.body).toContain("`npm run typecheck`: passed");
    expect(first.body).toContain("**Updated:** 2026-07-11 16:25 UTC");
    expect(second).toEqual(first);
    expect(BRAIN_HANDS_STATE_LABELS).toHaveLength(7);
  });

  it("falls back instead of publishing unsafe command and path content", () => {
    const projection = projectWorkItemStatus({
      ...base,
      verification: {
        status: "failed",
        checks: [{
          index: 1,
          rawCommand: "TOKEN=ghp_secret /Users/alice/repo/private.sh --key abc",
          status: "failed",
        }],
        browser: "failed",
      },
      verifier: { status: "pending", findings: [] },
    });

    expect(projection.body).toContain("Verification check 1: failed");
    expect(projection.body).not.toContain("ghp_secret");
    expect(projection.body).not.toContain("/Users/alice");
    expect(projection.body).not.toContain("private.sh");
  });

  it("caps findings and builds a deterministic immutable event key", () => {
    const projection = projectWorkItemStatus({
      ...base,
      state: "fixing",
      verifier: {
        status: "request_changes",
        findings: Array.from({ length: 12 }, (_, index) => ({
          severity: index === 0 ? "high" : "medium",
          publicLocation: `src/file-${index}.ts:${index + 1}`,
          summary: `Finding ${index}`,
        })),
      },
      materialEvents: [{ kind: "reviewer_findings", attempt: 1 }],
    });

    expect(projection.events).toHaveLength(1);
    expect(projection.events[0]!.key).toBe("reviewer-findings:model-catalog:attempt-1");
    expect(projection.events[0]!.body.length).toBeLessThanOrEqual(4_000);
    expect(projection.events[0]!.body).toContain("additional findings omitted");
  });

  it("renders delivery separately without a mutable PR status", () => {
    const event = projectDeliveryEvent({
      runId: base.runId,
      workItemId: "integrated",
      pullRequestNumber: 42,
      commitSha: "abc1234",
      transitionAt: base.transitionAt,
      checks: [{ index: 1, rawCommand: "npm test", status: "passed" }],
      residualRisks: [],
    });

    expect(event.marker).toBe(eventMarker(base.runId, "integrated", event.key));
    expect(event.key).toBe("delivered-for-review:pr-42:commit-abc1234");
    expect(event.body).toContain("Brain Hands will not merge automatically");
  });
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `npx vitest run tests/github/status-projection.test.ts`

Expected: FAIL because `src/github/status-projection.ts` does not exist.

- [ ] **Step 3: Implement strict types, catalogs, markers, rendering, and hashing**

Implement `src/github/status-projection.ts` around these exact public shapes:

```ts
import { createHash } from "node:crypto";

export const BRAIN_HANDS_STATE_LABELS = [
  "brain-hands:ready",
  "brain-hands:implementing",
  "brain-hands:verifying",
  "brain-hands:reviewing",
  "brain-hands:fixing",
  "brain-hands:blocked",
  "brain-hands:complete",
] as const;

export type BrainHandsIssueState =
  | "ready" | "implementing" | "verifying" | "reviewing"
  | "fixing" | "blocked" | "complete";

export interface StatusCheck {
  index: number;
  rawCommand: string;
  status: "pending" | "passed" | "failed" | "timed_out";
}

export interface StatusFinding {
  severity: "low" | "medium" | "high" | "critical";
  publicLocation?: string;
  summary: string;
}

export interface MaterialEventSnapshot {
  kind: "verification_blocked" | "replan_required" | "reviewer_findings" | "operational_blocker";
  attempt: number;
  blockerClass?: "hands_invalid" | "verification_invalid" | "verifier_invalid" | "attempts_exhausted";
}

export interface WorkItemStatusSnapshot {
  runId: string;
  workItemId: string;
  workItemIndex: number;
  workItemTotal: number;
  branchName: string;
  state: BrainHandsIssueState;
  attempt: number;
  maxAttempts: number;
  transitionAt: string;
  planApproved: boolean;
  implementationRecorded: boolean;
  verification: {
    status: "pending" | "running" | "passed" | "failed";
    checks: StatusCheck[];
    browser: "not_required" | "pending" | "passed" | "failed";
  };
  verifier: {
    status: "pending" | "running" | "approved" | "request_changes" | "replan_required";
    findings: StatusFinding[];
  };
  materialEvents: MaterialEventSnapshot[];
}

export interface DesiredMaterialEvent {
  key: string;
  marker: string;
  body: string;
}

export interface DesiredStatusProjection {
  marker: string;
  body: string;
  label: typeof BRAIN_HANDS_STATE_LABELS[number];
  hash: string;
  events: DesiredMaterialEvent[];
}

export function statusMarker(runId: string, workItemId: string): string;
export function eventMarker(runId: string, workItemId: string, key: string): string;
export function projectWorkItemStatus(snapshot: WorkItemStatusSnapshot): DesiredStatusProjection;
export function projectDeliveryEvent(input: {
  runId: string;
  workItemId: "integrated";
  pullRequestNumber: number;
  commitSha: string;
  transitionAt: string;
  checks: StatusCheck[];
  residualRisks: string[];
}): DesiredMaterialEvent;
```

Implementation rules:

```ts
const MAX_STATUS_BODY = 6_000;
const MAX_EVENT_BODY = 4_000;
const MAX_EVIDENCE = 8;
const MAX_FINDINGS = 5;

const STATE_COPY: Record<BrainHandsIssueState, { title: string; next: string }> = {
  ready: { title: "Ready", next: "Begin the approved Hands implementation." },
  implementing: { title: "Implementing", next: "Record the Hands result, then run deterministic verification." },
  verifying: { title: "Verifying", next: "Persist complete evidence, then start Verifier review." },
  reviewing: { title: "Verifier review", next: "Await the persisted Verifier decision." },
  fixing: { title: "Fixing", next: "Apply approved fixes, then rerun affected verification." },
  blocked: { title: "Blocked", next: "Resolve the recorded blocker, then resume this run." },
  complete: { title: "Complete", next: "Await integrated delivery review." },
};

function publicCheckLabel(check: StatusCheck): string {
  const command = check.rawCommand.trim().replace(/\s+/g, " ");
  if (/^npm (test|run [a-zA-Z0-9:_-]+)$/.test(command)) return command;
  if (/^(pnpm|yarn) (test|[a-zA-Z0-9:_-]+)$/.test(command)) return command;
  return `Verification check ${check.index}`;
}

function publicLocation(value: string | undefined): string | undefined {
  if (!value || value.startsWith("/") || value.includes("..") || value.includes("\\")) return undefined;
  return /^[a-zA-Z0-9._/-]+(?::\d+)?$/.test(value) ? value : undefined;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
```

Reject or fall back for identifiers that cannot safely fit the marker grammar
`[A-Za-z0-9._:-]`. Use the fixed state copy, safe check labels, capped finding
summaries, UTC minute formatting, and `sha256(body + "\n" + label)`.

- [ ] **Step 4: Run projection tests and verify they pass**

Run: `npx vitest run tests/github/status-projection.test.ts`

Expected: PASS with four projection tests.

- [ ] **Step 5: Run type checking**

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 6: Commit the projection contract**

```bash
git add src/github/status-projection.ts tests/github/status-projection.test.ts
git commit -m "feat: define safe GitHub status projections"
```

---

### Task 2: Add the Versioned Synchronization Checkpoint

**Files:**
- Create: `src/github/status-checkpoint.ts`
- Create: `tests/github/status-checkpoint.test.ts`

**Interfaces:**
- Consumes: `DesiredStatusProjection` event keys from Task 1.
- Produces: `githubStatusCheckpointSchema`, `GitHubStatusCheckpoint`, `readGitHubStatusCheckpoint()`, and `updateGitHubStatusCheckpoint()`.

- [ ] **Step 1: Write failing default, update, and corruption tests**

```ts
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readGitHubStatusCheckpoint,
  updateGitHubStatusCheckpoint,
} from "../../src/github/status-checkpoint.js";

let root: string | undefined;
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

describe("GitHub status checkpoint", () => {
  it("is absent by default and writes a versioned atomic checkpoint", async () => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-status-"));
    expect(await readGitHubStatusCheckpoint(root)).toEqual({ version: 1, targets: {} });

    await updateGitHubStatusCheckpoint(root, "issue:12:item-a", (current) => ({
      ...current,
      commentId: 901,
      projectionHash: "a".repeat(64),
      label: "brain-hands:ready",
      emittedEventKeys: [],
      syncedAt: "2026-07-11T16:25:00.000Z",
      retry: null,
    }));

    const parsed = JSON.parse(await readFile(join(root, "github-status.json"), "utf8"));
    expect(parsed.version).toBe(1);
    expect(parsed.targets["issue:12:item-a"].commentId).toBe(901);
  });

  it("fails closed on malformed persisted checkpoint", async () => {
    root = await mkdtemp(join(tmpdir(), "brain-hands-status-"));
    await writeFile(join(root, "github-status.json"), '{"version":1,"targets":{"x":{"commentId":"bad"}}}\n');
    await expect(readGitHubStatusCheckpoint(root)).rejects.toThrow("Invalid GitHub status checkpoint");
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run tests/github/status-checkpoint.test.ts`

Expected: FAIL because `src/github/status-checkpoint.ts` does not exist.

- [ ] **Step 3: Implement the strict checkpoint schema and atomic writer**

Use this schema and API:

```ts
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { BRAIN_HANDS_STATE_LABELS } from "./status-projection.js";

const retrySchema = z.object({
  class: z.enum(["comment_lookup", "comment_create", "comment_edit", "label_sync", "event_create", "checkpoint_write", "unsupported"]),
  at: z.string().datetime(),
}).strict();

const targetSchema = z.object({
  commentId: z.number().int().positive().nullable(),
  projectionHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  label: z.enum(BRAIN_HANDS_STATE_LABELS).nullable(),
  emittedEventKeys: z.array(z.string().min(1)).default([]),
  syncedAt: z.string().datetime().nullable(),
  retry: retrySchema.nullable(),
}).strict();

export const githubStatusCheckpointSchema = z.object({
  version: z.literal(1),
  targets: z.record(z.string(), targetSchema),
}).strict();

export type GitHubStatusCheckpoint = z.infer<typeof githubStatusCheckpointSchema>;
export type GitHubStatusTargetCheckpoint = z.infer<typeof targetSchema>;

const EMPTY_TARGET: GitHubStatusTargetCheckpoint = {
  commentId: null,
  projectionHash: null,
  label: null,
  emittedEventKeys: [],
  syncedAt: null,
  retry: null,
};

export async function readGitHubStatusCheckpoint(runDir: string): Promise<GitHubStatusCheckpoint>;
export async function updateGitHubStatusCheckpoint(
  runDir: string,
  targetKey: string,
  update: (current: GitHubStatusTargetCheckpoint) => GitHubStatusTargetCheckpoint,
): Promise<GitHubStatusCheckpoint>;
```

`readGitHubStatusCheckpoint()` returns `{ version: 1, targets: {} }` only for
`ENOENT`. Parse and validate every existing file; wrap parse/schema failures in
`Invalid GitHub status checkpoint`.

`updateGitHubStatusCheckpoint()` must read current state, apply the callback to
a cloned target or `EMPTY_TARGET`, validate the complete result, write
`github-status.json.tmp`, and rename it to `github-status.json`. Do not store
rendered Markdown or remote error messages.

- [ ] **Step 4: Run checkpoint tests and type checking**

Run: `npx vitest run tests/github/status-checkpoint.test.ts && npm run typecheck`

Expected: both commands PASS.

- [ ] **Step 5: Commit the checkpoint**

```bash
git add src/github/status-checkpoint.ts tests/github/status-checkpoint.test.ts
git commit -m "feat: persist GitHub status checkpoints"
```

---

### Task 3: Extend the GitHub Adapter with Marker and Label Primitives

**Files:**
- Modify: `src/adapters/github.ts:1-314`
- Modify: `tests/adapters/github.test.ts`

**Interfaces:**
- Consumes: `BRAIN_HANDS_STATE_LABELS` from Task 1.
- Produces: optional `findCommentByMarker`, `createStatusComment`, `updateStatusComment`, and `reconcileIssueStateLabel` methods on `GitHubAdapter`.

- [ ] **Step 1: Add failing adapter tests for comments and labels**

Extend `tests/adapters/github.test.ts` with scripted command results that assert:

```ts
it("finds an exact marker across paginated issue comments", async () => {
  mockedRunCommand
    .mockResolvedValueOnce(ghSuccessResult("acme/repo\n"))
    .mockResolvedValueOnce(ghSuccessResult(JSON.stringify([[
      { id: 10, body: "<!-- brain-hands:status run=other work-item=item schema=1 -->" },
    ], [
      { id: 11, body: "<!-- brain-hands:status run=run-1 work-item=item schema=1 -->\nbody" },
    ]])));
  const adapter = new GhCliGitHubAdapter(root);

  await expect(adapter.findCommentByMarker!(
    { kind: "issue", number: 7 },
    "<!-- brain-hands:status run=run-1 work-item=item schema=1 -->",
  )).resolves.toEqual({ id: 11, body: expect.stringContaining("run=run-1") });
});

it("creates and edits comments by stable database ID", async () => {
  mockedRunCommand
    .mockResolvedValueOnce(ghSuccessResult("acme/repo\n"))
    .mockResolvedValueOnce(ghSuccessResult('{"id":91,"body":"created"}\n'))
    .mockResolvedValueOnce(ghSuccessResult("{}\n"));
  const adapter = new GhCliGitHubAdapter(root);
  const created = await adapter.createStatusComment!({ kind: "issue", number: 7 }, "created");
  await adapter.updateStatusComment!(created.id, "updated");
  expect(created.id).toBe(91);
  expect(mockedRunCommand.mock.calls.at(-1)?.[0].args).toContain("repos/acme/repo/issues/comments/91");
});

it("creates only a missing desired label and removes only stale allowlisted labels", async () => {
  mockedRunCommand
    .mockResolvedValueOnce(ghSuccessResult("brain-hands:ready\ncustom\n"))
    .mockResolvedValueOnce(ghSuccessResult(JSON.stringify([{ name: "brain-hands:ready" }])))
    .mockResolvedValueOnce(ghSuccessResult(""))
    .mockResolvedValueOnce(ghSuccessResult(""));
  const adapter = new GhCliGitHubAdapter(root);
  await adapter.reconcileIssueStateLabel!(7, "brain-hands:implementing");
  const calls = mockedRunCommand.mock.calls.map(([input]) => input.args);
  expect(calls.some((args) => args.includes("brain-hands:implementing"))).toBe(true);
  expect(calls.some((args) => args.includes("--remove-label") && args.includes("brain-hands:ready"))).toBe(true);
  expect(calls.every((args) => !(args.includes("--remove-label") && args.includes("custom")))).toBe(true);
});
```

Use the file's existing `vi.mock("../../src/core/executor.js")`,
`mockedRunCommand`, and `ghSuccessResult()` helpers. Define `root` as
`"/repo/root"` inside each new test; do not introduce a second executor mock.

- [ ] **Step 2: Run adapter tests and verify the new cases fail**

Run: `npx vitest run tests/adapters/github.test.ts`

Expected: FAIL because the optional status methods are undefined.

- [ ] **Step 3: Add the optional transport types and methods**

Add these interfaces to `src/adapters/github.ts`:

```ts
export interface GitHubCommentTarget {
  kind: "issue" | "pull_request";
  number: number;
}

export interface GitHubCommentReference {
  id: number;
  body: string;
}

export interface GitHubAdapter {
  // Existing methods remain unchanged.
  findCommentByMarker?(target: GitHubCommentTarget, marker: string): Promise<GitHubCommentReference | null>;
  createStatusComment?(target: GitHubCommentTarget, body: string): Promise<GitHubCommentReference>;
  updateStatusComment?(commentId: number, body: string): Promise<void>;
  reconcileIssueStateLabel?(
    issueNumber: number,
    desired: typeof BRAIN_HANDS_STATE_LABELS[number],
  ): Promise<void>;
}
```

Add fixed label definitions without changing existing label constants:

```ts
const STATE_LABEL_DEFINITIONS = {
  "brain-hands:ready": { color: "0E8A16", description: "Approved work item is ready for Hands" },
  "brain-hands:implementing": { color: "1D76DB", description: "Hands implementation is running" },
  "brain-hands:verifying": { color: "FBCA04", description: "Deterministic verification is running" },
  "brain-hands:reviewing": { color: "5319E7", description: "Verifier review is running" },
  "brain-hands:fixing": { color: "D93F0B", description: "Approved findings are being fixed" },
  "brain-hands:blocked": { color: "B60205", description: "Work item requires intervention or replanning" },
  "brain-hands:complete": { color: "0E8A16", description: "Work item passed Verifier review" },
} as const;
```

The real adapter must:

1. Resolve and cache `nameWithOwner` using `gh repo view --json nameWithOwner --jq .nameWithOwner`.
2. Find comments with `gh api --paginate --slurp repos/<owner>/<repo>/issues/<number>/comments` and flatten validated pages.
3. Create with `gh api --method POST repos/<owner>/<repo>/issues/<number>/comments -f body=<body>`.
4. Edit with `gh api --method PATCH repos/<owner>/<repo>/issues/comments/<id> -f body=<body>`.
5. Read current issue labels with `gh issue view <number> --json labels --jq .labels[].name`.
6. Read repository labels with `gh label list --limit 1000 --json name`.
7. Create the desired label only when missing using `gh label create` without `--force`.
8. Run one `gh issue edit` containing `--remove-label` for each stale allowlisted label and `--add-label <desired>` only when needed.

Validate positive comment IDs and body strings. Reuse `commandFailureError()` for
all nonzero exits and parse failures. Do not include comment bodies in thrown
parse errors.

The dry-run adapter returns deterministic incrementing comment IDs, stores no
remote state, and treats label reconciliation as a no-op.

- [ ] **Step 4: Run adapter and type tests**

Run: `npx vitest run tests/adapters/github.test.ts tests/workflow/runtime-github.test.ts && npm run typecheck`

Expected: PASS; existing recording adapters compile because the new methods are optional.

- [ ] **Step 5: Commit adapter support**

```bash
git add src/adapters/github.ts tests/adapters/github.test.ts
git commit -m "feat: add GitHub status transport primitives"
```

---

### Task 4: Implement Checkpointed Status Reconciliation

**Files:**
- Create: `src/github/status-sync.ts`
- Create: `tests/github/status-sync.test.ts`
- Modify: `src/core/ledger.ts:264-283`
- Modify: `tests/core/ledger.test.ts`

**Interfaces:**
- Consumes: projections from Task 1, checkpoint functions from Task 2, and optional adapter capabilities from Task 3.
- Produces: `readRunEvents()`, `ensureGitHubMaterialEvent()`, `syncGitHubIssueStatus()`, `syncGitHubDeliveryEvent()`, and `GitHubStatusSyncResult`.

- [ ] **Step 1: Add a failing validated event-reader test**

Extend `tests/core/ledger.test.ts`:

```ts
it("reads and validates durable run events in append order", async () => {
  const ledger = await createRunLedgerV2({ repoRoot, originalRequest: "status events" });
  const first = await appendRunEvent(ledger.runDir, {
    actor: "github_status",
    type: "github_material_event",
    payload: { key: "verification-blocked:item:attempt-1", work_item_id: "item" },
  });
  expect(await readRunEvents(ledger.runDir)).toEqual([first]);
});
```

- [ ] **Step 2: Export strict append-order event reading**

Add to `src/core/ledger.ts`:

```ts
export async function readRunEvents(runDir: string): Promise<RunEventRecord[]> {
  const raw = await readFile(join(runDir, "events.jsonl"), "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line, index) => {
      try {
        return runEventSchema.parse(JSON.parse(line));
      } catch (error) {
        throw new Error(`Invalid run event at line ${index + 1}`, { cause: error });
      }
    });
}
```

Import `runEventSchema` from `src/core/schema.ts`. This artifact is already the
bounded approval ledger; do not reuse the streaming `progress.jsonl` design here.

- [ ] **Step 3: Write failing reconciler tests**

Create an in-memory adapter in `tests/github/status-sync.test.ts` and cover:

```ts
it("creates once, edits on transition, and performs no mutation on no-op", async () => {
  const ready = projectWorkItemStatus({ ...snapshot, state: "ready" });
  const reviewing = projectWorkItemStatus({ ...snapshot, state: "reviewing" });

  expect((await syncGitHubIssueStatus({ runDir, github, issueNumber: 7, workItemId: "item", projection: ready })).status).toBe("synced");
  expect(github.created).toHaveLength(1);
  expect(github.labels).toEqual(["brain-hands:ready"]);

  expect((await syncGitHubIssueStatus({ runDir, github, issueNumber: 7, workItemId: "item", projection: reviewing })).status).toBe("synced");
  expect(github.updated).toHaveLength(1);
  expect(github.labels).toEqual(["brain-hands:reviewing"]);

  const mutations = github.mutationCount;
  expect((await syncGitHubIssueStatus({ runDir, github, issueNumber: 7, workItemId: "item", projection: reviewing })).status).toBe("skipped");
  expect(github.mutationCount).toBe(mutations);
});

it("finds an existing marker after remote create and checkpoint failure", async () => {
  github.seedComment(projection.marker, projection.body, 77);
  const result = await syncGitHubIssueStatus({ runDir, github, issueNumber: 7, workItemId: "item", projection });
  expect(result.status).toBe("synced");
  expect(github.created).toHaveLength(0);
  expect((await readGitHubStatusCheckpoint(runDir)).targets["issue:7:item"]?.commentId).toBe(77);
});

it("records retry state and returns without throwing on remote failure", async () => {
  github.failNext("comment_create");
  const result = await syncGitHubIssueStatus({ runDir, github, issueNumber: 7, workItemId: "item", projection });
  expect(result).toEqual({ status: "retry_pending", failureClass: "comment_create" });
  expect((await readGitHubStatusCheckpoint(runDir)).targets["issue:7:item"]?.retry?.class).toBe("comment_create");
});

it("posts each immutable event once by marker", async () => {
  await syncGitHubIssueStatus({ runDir, github, issueNumber: 7, workItemId: "item", projection: blocked });
  await syncGitHubIssueStatus({ runDir, github, issueNumber: 7, workItemId: "item", projection: blocked });
  expect(github.created.filter((entry) => entry.body.includes("brain-hands:event"))).toHaveLength(1);
});
```

Also test two work items on one run, stale comment-ID recovery on a changed
projection, an adapter without optional capabilities, and PR delivery event
deduplication.

- [ ] **Step 4: Run the new tests and verify they fail**

Run: `npx vitest run tests/core/ledger.test.ts tests/github/status-sync.test.ts`

Expected: FAIL because the event reader and reconciler do not exist.

- [ ] **Step 5: Implement the reconciler APIs and safe result contract**

Use these exact signatures:

```ts
export type GitHubStatusFailureClass =
  | "comment_lookup" | "comment_create" | "comment_edit"
  | "label_sync" | "event_create" | "checkpoint_write" | "unsupported";

export type GitHubStatusSyncResult =
  | { status: "synced" }
  | { status: "skipped" }
  | { status: "retry_pending"; failureClass: GitHubStatusFailureClass };

export async function ensureGitHubMaterialEvent(
  runDir: string,
  input: {
    key: string;
    workItemId: string;
    kind: MaterialEventSnapshot["kind"] | "delivered_for_review";
    attempt: number;
  },
): Promise<void>;

export async function syncGitHubIssueStatus(input: {
  runDir: string;
  github: GitHubAdapter;
  issueNumber: number;
  workItemId: string;
  projection: DesiredStatusProjection;
  now?: () => string;
}): Promise<GitHubStatusSyncResult>;

export async function syncGitHubDeliveryEvent(input: {
  runDir: string;
  github: GitHubAdapter;
  pullRequestNumber: number;
  event: DesiredMaterialEvent;
  now?: () => string;
}): Promise<GitHubStatusSyncResult>;
```

`ensureGitHubMaterialEvent()` reads validated events, returns when a
`github_material_event` already has the same key and work-item ID, and otherwise
appends one event whose payload contains only `key`, `work_item_id`, `kind`, and
`attempt`.

`syncGitHubIssueStatus()` must:

1. Use checkpoint key `issue:<number>:<work-item-id>`.
2. Skip before any adapter call when hash, label, event keys, and retry state match.
3. Return `retry_pending/unsupported` when required optional methods are absent.
4. On every changed projection, find the mutable comment by exact marker. Edit
   the returned stable ID, or create the comment only when the marker is absent.
   The checkpoint ID is sufficient for no-op skips but is never trusted across
   a real transition without marker lookup.
5. Reconcile the state label after the mutable comment succeeds.
6. Search every missing immutable event marker before creation.
7. Save successful IDs, hash, label, sorted unique event keys, sync time, and
   `retry: null` only after all required remote mutations succeed.
8. Catch remote errors, map only the current operation to a generic failure
   class, persist that class, and return `retry_pending` without exposing the
   thrown message.

`syncGitHubDeliveryEvent()` uses checkpoint key `pull_request:<number>:delivery`,
performs marker lookup and event creation only, and never edits a mutable comment
or labels.

If checkpoint persistence itself fails, return `retry_pending/checkpoint_write`.
Do not recursively attempt to checkpoint that failure.

- [ ] **Step 6: Run focused reconciler tests**

Run: `npx vitest run tests/core/ledger.test.ts tests/github/status-checkpoint.test.ts tests/github/status-sync.test.ts`

Expected: PASS.

- [ ] **Step 7: Run type checking and commit**

Run: `npm run typecheck`

Expected: PASS.

```bash
git add src/core/ledger.ts tests/core/ledger.test.ts src/github/status-sync.ts tests/github/status-sync.test.ts
git commit -m "feat: reconcile GitHub status idempotently"
```

---

### Task 5: Add the Runtime Status Boundary Helper

**Files:**
- Create: `src/workflow/github-status.ts`
- Create: `tests/workflow/github-status.test.ts`

**Interfaces:**
- Consumes: `BrainPlan`, `WorkItem`, `VerificationEvidence`, `VerifierReview`, projector and reconciler APIs.
- Produces: `RuntimeStatusBoundary`, `syncRuntimeWorkItemStatus()`, and `syncRuntimeDeliveryStatus()`.

- [ ] **Step 1: Write failing snapshot-conversion and best-effort tests**

Create tests that use actual project `BrainPlan`, `WorkItem`, evidence, and
review fixtures:

```ts
it("converts persisted verification and review into a reviewing projection", async () => {
  const result = await syncRuntimeWorkItemStatus({
    runDir,
    github,
    manifest,
    workItem,
    workItemIndex: 1,
    workItemTotal: 2,
    issueNumber: 17,
    branchName: "codex/run-1",
    boundary: "reviewing",
    attempt: 1,
    maxAttempts: 3,
    transitionAt: "2026-07-11T16:25:00.000Z",
    evidence,
    review: undefined,
  });
  expect(result.status).toBe("synced");
  expect(github.created[0]?.body).toContain("**State:** Verifier review");
  expect(github.created[0]?.body).toContain("`npm test`: passed");
});

it("swallows synchronization exceptions after recording a generic warning", async () => {
  github.createStatusComment = async () => { throw new Error("token=secret /Users/alice"); };
  await expect(syncRuntimeWorkItemStatus(input)).resolves.toEqual({ status: "retry_pending", failureClass: "comment_create" });
  const events = await readRunEvents(runDir);
  const warning = events.find((event) => event.type === "github_status_sync_warning");
  expect(warning?.payload).toEqual({ work_item_id: "item", failure_class: "comment_create" });
  expect(JSON.stringify(warning)).not.toContain("token=secret");
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run tests/workflow/github-status.test.ts`

Expected: FAIL because `src/workflow/github-status.ts` does not exist.

- [ ] **Step 3: Implement the boundary-to-snapshot adapter**

Use this boundary union:

```ts
export type RuntimeStatusBoundary =
  | "ready" | "implementing" | "verifying" | "reviewing"
  | "fixing" | "blocked" | "complete";

export async function syncRuntimeWorkItemStatus(input: {
  runDir: string;
  github: GitHubAdapter;
  manifest: RunManifestV2;
  workItem: WorkItem;
  workItemIndex: number;
  workItemTotal: number;
  issueNumber: number;
  branchName: string;
  boundary: RuntimeStatusBoundary;
  attempt: number;
  maxAttempts: number;
  transitionAt: string;
  evidence?: VerificationEvidence;
  review?: VerifierReview;
  materialEvents?: MaterialEventSnapshot[];
}): Promise<GitHubStatusSyncResult>;

export async function syncRuntimeDeliveryStatus(input: {
  runDir: string;
  github: GitHubAdapter;
  manifest: RunManifestV2;
  pullRequest: GitHubPullRequestReference;
  commitSha: string;
  transitionAt: string;
  evidence: VerificationEvidence;
  review: VerifierReview;
}): Promise<GitHubStatusSyncResult>;
```

Convert `VerificationEvidence.commands` into numbered checks without passing
stdout/stderr paths. Convert findings to capped `StatusFinding` values only when
the location is repository-relative. Map review decisions exactly:

```ts
const verifierStatus = review?.decision === "approve"
  ? "approved"
  : review?.decision === "request_changes"
    ? "request_changes"
    : review?.decision === "replan_required"
      ? "replan_required"
      : boundary === "reviewing" ? "running" : "pending";
```

For every material event, call `ensureGitHubMaterialEvent()` before
synchronization and pass the complete persisted event list into the projector.
After `retry_pending`, append one `github_status_sync_warning` run event unless
an event with the same work item, failure class, boundary, and attempt already
exists. Store only those safe coordinates.

Wrap the entire helper in a final catch that returns
`retry_pending/checkpoint_write` and attempts one safe warning event. Never
rethrow into the workflow runtime.

For delivery, require `review.final === true`, `review.decision === "approve"`,
and the evidence/review attempt to match before calling `projectDeliveryEvent()`.
Throwing on invalid caller provenance is correct because that is a programming
error before the best-effort GitHub boundary; runtime must only call delivery
after its existing delivery validation succeeds.

- [ ] **Step 4: Run helper tests and type checking**

Run: `npx vitest run tests/workflow/github-status.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit the runtime helper**

```bash
git add src/workflow/github-status.ts tests/workflow/github-status.test.ts
git commit -m "feat: map runtime state to GitHub status"
```

---

### Task 6: Wire Durable GitHub Runtime Transitions

**Files:**
- Modify: `src/workflow/runtime.ts:360-430,560-825,850-1160,1190-1450`
- Modify: `tests/workflow/runtime-github.test.ts`

**Interfaces:**
- Consumes: `syncRuntimeWorkItemStatus()` and `syncRuntimeDeliveryStatus()` from Task 5.
- Produces: complete GitHub-mode lifecycle synchronization without changing `LocalWorkflowResult` or delivery gates.

- [ ] **Step 1: Extend the recording GitHub adapter and write a failing happy-path lifecycle test**

Add in-memory implementations for the four optional adapter methods to the
existing `RecordingGithub` test class. Add these fields and methods without
changing its current issue and PR methods:

```ts
private nextCommentId = 1;
readonly comments = new Map<number, { target: GitHubCommentTarget; body: string }>();
readonly statusMutationLog: Array<{ operation: "create" | "update" | "label"; body?: string }> = [];
readonly currentStateLabels = new Map<number, string[]>();
failStatusOperations = false;

get statusBodies(): string[] {
  return [...this.comments.values()].map((comment) => comment.body)
    .filter((body) => body.includes("brain-hands:status"));
}

get eventBodies(): string[] {
  return [...this.comments.values()].map((comment) => comment.body)
    .filter((body) => body.includes("brain-hands:event"));
}

clearMutationLog(): void {
  this.statusMutationLog.length = 0;
}

async findCommentByMarker(target: GitHubCommentTarget, marker: string): Promise<GitHubCommentReference | null> {
  if (this.failStatusOperations) throw new Error("status lookup failed");
  for (const [id, comment] of this.comments) {
    if (comment.target.kind === target.kind && comment.target.number === target.number && comment.body.includes(marker)) {
      return { id, body: comment.body };
    }
  }
  return null;
}

async createStatusComment(target: GitHubCommentTarget, body: string): Promise<GitHubCommentReference> {
  if (this.failStatusOperations) throw new Error("status create failed");
  const id = this.nextCommentId++;
  this.comments.set(id, { target, body });
  this.statusMutationLog.push({ operation: "create", body });
  return { id, body };
}

async updateStatusComment(commentId: number, body: string): Promise<void> {
  if (this.failStatusOperations) throw new Error("status update failed");
  const current = this.comments.get(commentId);
  if (!current) throw new Error("status comment not found");
  this.comments.set(commentId, { ...current, body });
  this.statusMutationLog.push({ operation: "update", body });
}

async reconcileIssueStateLabel(issueNumber: number, desired: typeof BRAIN_HANDS_STATE_LABELS[number]): Promise<void> {
  if (this.failStatusOperations) throw new Error("status label failed");
  this.currentStateLabels.set(issueNumber, [desired]);
  this.statusMutationLog.push({ operation: "label" });
}
```

Import the Task 1 label catalog and Task 3 comment types. Add this reusable
happy-path input builder below `setup()`:

```ts
function approvedGithubInput(
  setupResult: { root: string; runDir: string },
  github: RecordingGithub,
  overrides: Partial<GithubRuntimeDependencies> = {},
): RunGithubWorkflowInput {
  const dependencies: GithubRuntimeDependencies = {
    github,
    hands: async (input) => ({
      implementation: implementation(input.workItem.id),
      reportPath: `implementation/${input.workItem.id}.json`,
      invocation: {} as never,
    }),
    verification: async (input) => evidence(input.issueNumber, input.attempt ?? 1),
    verifier: async (input) => {
      const attempt = input.attempt ?? 1;
      const review = approvedReview(attempt);
      const reviewPath = await writeTextArtifact(
        setupResult.runDir,
        `reviews/integrated/final-attempt-${attempt}.json`,
        `${JSON.stringify(review)}\n`,
      );
      return { review, reviewPath, invocation: {} as never };
    },
    gitSnapshot: async () => ({
      branch: "codex/brain-hands/run-1",
      status: "",
      gitDir: ".git",
      gitCommonDir: ".git",
      isLinkedWorktree: true,
    }),
    commit: async () => "abc1234",
    push: async () => "pushed",
    ...overrides,
  };
  return {
    runDir: setupResult.runDir,
    repoRoot: setupResult.root,
    worktreePath: join(setupResult.root, "worktree"),
    branchName: "codex/brain-hands/run-1",
    baseBranch: "main",
    remote: "origin",
    intake: { ...intake, repo_root: setupResult.root },
    plan,
    codex: {} as never,
    dependencies,
  };
}
```

Import `RunGithubWorkflowInput` with `GithubRuntimeDependencies`. Then add:

```ts
it("projects each durable work-item transition onto one issue comment and exclusive label", async () => {
  const setupResult = await setup();
  root = setupResult.root;
  const github = new RecordingGithub();
  const result = await runGithubWorkflow(approvedGithubInput(setupResult, github));
  expect(result.status).toBe("github_ready");

  const issueCreates = github.statusMutationLog.filter((entry) =>
    entry.operation === "create" && entry.body?.includes("brain-hands:status"));
  expect(issueCreates).toHaveLength(1);
  expect(github.statusBodies.at(-1)).toContain("**State:** Complete");
  expect(github.currentStateLabels.get(17)).toEqual(["brain-hands:complete"]);
  expect(github.statusBodies.some((body) => body.includes("npm test") && body.includes("pending"))).toBe(false);
});
```

- [ ] **Step 2: Add failing fix, blocker, delivery, no-op, and failure tests**

Add separate tests proving:

```ts
it("records one reviewer-findings event for a fix attempt and still completes", async () => {
  const setupResult = await setup();
  root = setupResult.root;
  const github = new RecordingGithub();
  let workItemReviews = 0;
  const input = approvedGithubInput(setupResult, github, {
    verifier: async (reviewInput) => {
      const attempt = reviewInput.attempt ?? 1;
      if (reviewInput.final) {
        const review = approvedReview(attempt);
        return {
          review,
          reviewPath: await writeTextArtifact(setupResult.runDir, `reviews/integrated/final-attempt-${attempt}.json`, `${JSON.stringify(review)}\n`),
          invocation: {} as never,
        };
      }
      workItemReviews += 1;
      const review: VerifierReview = {
        ...approvedReview(attempt),
        work_item_id: reviewInput.workItem.id,
        final: false,
        decision: workItemReviews === 1 ? "request_changes" : "approve",
        findings: workItemReviews === 1 ? [{
          severity: "high",
          file: "src/feature.ts",
          line: 81,
          acceptance_criterion: "feature works",
          problem: "Catalog fallback does not fail closed",
          required_fix: "Reject an unavailable model",
          re_verification: ["npm test"],
        }] : [],
      };
      return {
        review,
        reviewPath: await writeTextArtifact(setupResult.runDir, `reviews/feature/attempt-${attempt}.json`, `${JSON.stringify(review)}\n`),
        invocation: {} as never,
      };
    },
  });
  const result = await runGithubWorkflow(input);
  expect(result.status).toBe("github_ready");
  expect(github.eventBodies.filter((body) => body.includes("Verifier requested changes"))).toHaveLength(1);
  expect(github.statusBodies.some((body) => body.includes("**State:** Fixing"))).toBe(true);
});

it("posts one verification blocker and preserves human_action_required", async () => {
  const setupResult = await setup();
  root = setupResult.root;
  const github = new RecordingGithub();
  const result = await runGithubWorkflow(approvedGithubInput(setupResult, github, {
    verification: async (verificationInput) => ({
      ...evidence(verificationInput.issueNumber, verificationInput.attempt ?? 1),
      commands: [{
        ...evidence(verificationInput.issueNumber, verificationInput.attempt ?? 1).commands[0]!,
        exit_code: 1,
      }],
    }),
  }));
  expect(result.status).toBe("human_action_required");
  expect(github.eventBodies.filter((body) => body.includes("Verification blocked"))).toHaveLength(1);
  expect(github.currentStateLabels.get(17)).toEqual(["brain-hands:blocked"]);
});

it("posts delivery only after post-PR final approval and never merges", async () => {
  const setupResult = await setup();
  root = setupResult.root;
  const github = new RecordingGithub();
  const result = await runGithubWorkflow(approvedGithubInput(setupResult, github));
  expect(result.status).toBe("github_ready");
  expect(github.eventBodies.filter((body) => body.includes("Delivered for review"))).toHaveLength(1);
  expect(github.calls).not.toContain("merge");
});

it("performs zero status mutations on an already-synchronized fast resume", async () => {
  const setupResult = await setup();
  root = setupResult.root;
  const github = new RecordingGithub();
  const input = approvedGithubInput(setupResult, github);
  await runGithubWorkflow(input);
  github.clearMutationLog();
  const resumed = await runGithubWorkflow(input);
  expect(resumed.status).toBe("github_ready");
  expect(github.statusMutationLog).toEqual([]);
});

it("continues to github_ready when every status operation fails", async () => {
  const setupResult = await setup();
  root = setupResult.root;
  const github = new RecordingGithub();
  github.failStatusOperations = true;
  const result = await runGithubWorkflow(approvedGithubInput(setupResult, github));
  expect(result.status).toBe("github_ready");
  expect(result.pullRequest?.number).toBe(42);
});
```

Reuse the file's `setup()`, `evidence()`, `implementation()`, and
`approvedReview()` functions exactly as shown; do not introduce global outcome
state shared between tests.

- [ ] **Step 3: Run the runtime tests and confirm the new cases fail**

Run: `npx vitest run tests/workflow/runtime-github.test.ts`

Expected: FAIL because the runtime does not call the new status helper.

- [ ] **Step 4: Add a single local helper for status calls inside `runtime.ts`**

Import Task 5 helpers and add a small call wrapper near existing GitHub helper
functions:

```ts
async function projectIssueBoundary(input: Parameters<typeof syncRuntimeWorkItemStatus>[0]): Promise<void> {
  await syncRuntimeWorkItemStatus(input);
}
```

Do not add try/catch at every call site; Task 5 already owns best-effort behavior.

- [ ] **Step 5: Wire issue synchronization and normal work-item boundaries**

After `github_issue_synced` is persisted, project `ready`. For each ordered work
item, project only after these existing durable calls:

```ts
manifest = await transitionRun(input.runDir, "implementing", {
  actor: "runtime",
  payload: { work_item_id: item.id, order: index + 1 },
});
await projectIssueBoundary({
  runDir: input.runDir,
  github: githubDelivery.dependencies.github,
  manifest,
  workItem: item,
  workItemIndex: index + 1,
  workItemTotal: orderedWorkItems.length,
  issueNumber: issueNumbers[index]!,
  branchName: githubDelivery.branchName,
  boundary: attempt > 1 ? "fixing" : "implementing",
  attempt,
  maxAttempts: maxVerifierPasses,
  transitionAt: manifest.updated_at,
});

manifest = await transitionRun(input.runDir, "verifying", {
  actor: "runtime",
  payload: { work_item_id: item.id, pass: attempt },
});
await projectIssueBoundary({
  runDir: input.runDir,
  github: githubDelivery.dependencies.github,
  manifest,
  workItem: item,
  workItemIndex: index + 1,
  workItemTotal: orderedWorkItems.length,
  issueNumber: issueNumbers[index]!,
  branchName: githubDelivery.branchName,
  boundary: "verifying",
  attempt,
  maxAttempts: maxVerifierPasses,
  transitionAt: manifest.updated_at,
});

manifest = await setProgress(input.runDir, item.id, {
  status: "in_progress",
  attempts: attempt,
  verification_path: persistedEvidencePath,
});
manifest = await transitionRun(input.runDir, "verifier_review", {
  actor: "runtime",
  payload: { work_item_id: item.id, pass: attempt },
});
await projectIssueBoundary({
  runDir: input.runDir,
  github: githubDelivery.dependencies.github,
  manifest,
  workItem: item,
  workItemIndex: index + 1,
  workItemTotal: orderedWorkItems.length,
  issueNumber: issueNumbers[index]!,
  branchName: githubDelivery.branchName,
  boundary: "reviewing",
  attempt,
  maxAttempts: maxVerifierPasses,
  transitionAt: manifest.updated_at,
  evidence,
});

manifest = await setProgress(input.runDir, item.id, {
  status: "complete",
  attempts: attempt,
  review_path: persistedReviewPath,
});
await projectIssueBoundary({
  runDir: input.runDir,
  github: githubDelivery.dependencies.github,
  manifest,
  workItem: item,
  workItemIndex: index + 1,
  workItemTotal: orderedWorkItems.length,
  issueNumber: issueNumbers[index]!,
  branchName: githubDelivery.branchName,
  boundary: "complete",
  attempt,
  maxAttempts: maxVerifierPasses,
  transitionAt: manifest.updated_at,
  evidence,
  review,
});
```

Use the issue number at the same ordered index as the work item. Use the
persisted manifest `updated_at` returned immediately after each transition.
Never call `new Date()` merely to rerender an unchanged state.

- [ ] **Step 6: Wire material blocker, replan, and requested-changes boundaries**

At each existing branch that persists a failed verification, replan decision,
request-changes review, or operational blocker, pass exactly one material event:

```ts
materialEvents: [{ kind: "verification_blocked", attempt: reviewPass }]
materialEvents: [{ kind: "replan_required", attempt: reviewPass }]
materialEvents: [{ kind: "reviewer_findings", attempt: reviewPass }]
materialEvents: [{ kind: "operational_blocker", attempt, blockerClass: "hands_invalid" }]
```

Map only the four approved operational classes. Do not pass `blocker`, exception
messages, findings arrays outside validated reviews, or command outputs.

Project `fixing` only when Hands is actually beginning the approved next
attempt, not immediately when Verifier requests changes.

- [ ] **Step 7: Wire verified integrated PR delivery**

Call `syncRuntimeDeliveryStatus()` only after the existing delivery transition
has persisted:

- a real HTTPS PR identity;
- post-PR final verification evidence;
- a matching final Verifier review with `approve`;
- the approved commit SHA; and
- `delivery_state: "ready"`.

Do not call it at `pull_request_pending`, immediately after PR creation, or for
any failing post-PR attempt.

- [ ] **Step 8: Retry only pending projections on resume**

Add a private `retryPendingGithubStatus()` in `runtime.ts`. Call it after issue
numbers and any persisted PR identity have been recovered, before a terminal
fast-resume return. Its first operation is:

```ts
const checkpoint = await readGitHubStatusCheckpoint(input.runDir);
const hasRetry = Object.values(checkpoint.targets).some((target) => target.retry !== null);
if (!hasRetry) return;
```

When `hasRetry` is false, this helper must not call the GitHub adapter.

When it is true, iterate `orderedWorkItems` with `issueNumbers` and calculate
the same key used by the reconciler:

```ts
const targetKey = `issue:${issueNumbers[index]!}:${item.id}`;
if (checkpoint.targets[targetKey]?.retry === null || !checkpoint.targets[targetKey]) continue;
```

Rebuild the boundary only from persisted state:

```ts
function resumedBoundary(
  manifest: RunManifestV2,
  itemId: string,
): RuntimeStatusBoundary {
  const progress = manifest.work_item_progress[itemId];
  if (progress?.status === "complete") return "complete";
  if (progress?.status === "blocked") return "blocked";
  if (manifest.current_work_item_id !== itemId) return "ready";
  if (manifest.stage === "fixing") return "fixing";
  if (manifest.stage === "verifier_review") return "reviewing";
  if (manifest.stage === "verifying" || manifest.stage === "final_verification") return "verifying";
  return "implementing";
}
```

Load evidence and review only from the current progress object's persisted
`verification_path` and `review_path` using the existing
`loadPersistedEvidence()` and `loadPersistedReview()` helpers. Rebuild
`materialEvents` from validated `github_material_event` records whose
`work_item_id` matches the item, validating `kind` and positive `attempt`
against the Task 1 union before passing them to `syncRuntimeWorkItemStatus()`.

For `pull_request:<number>:delivery` retry state, require the manifest delivery
state to be `ready`, recover the persisted HTTPS URL, integrated commit SHA,
final evidence path, and final review path, validate them through the existing
loaders, and call `syncRuntimeDeliveryStatus()`. If any persisted prerequisite
is absent, leave the generic retry state intact and let the existing workflow
validation report the authoritative blocker.

Add a runtime test where the first run reaches `github_ready` while status
creation fails, then the second resume enables status operations. Assert that
the second run retries the missing status and delivery events. Keep the separate
fully synchronized resume assertion at zero mutations.

- [ ] **Step 9: Run all GitHub runtime and helper tests**

Run: `npx vitest run tests/workflow/github-status.test.ts tests/github/status-sync.test.ts tests/workflow/runtime-github.test.ts`

Expected: PASS.

- [ ] **Step 10: Run local runtime regression tests**

Run: `npx vitest run tests/workflow/runtime-local.test.ts tests/workflow/e2e-dry-run.test.ts`

Expected: PASS and no `github-status.json` in local run fixtures.

- [ ] **Step 11: Commit runtime integration**

```bash
git add src/workflow/runtime.ts tests/workflow/runtime-github.test.ts
git commit -m "feat: publish durable GitHub workflow status"
```

---

### Task 7: Document and Verify the Complete Operator Contract

**Files:**
- Modify: `README.md:1-210`
- Modify: `agentic-codex-workflow.md`
- Modify: `.agents/skills/brain-hands/SKILL.md:30-50`

**Interfaces:**
- Consumes: completed behavior from Tasks 1-6.
- Produces: public operator guidance and full release-readiness proof.

- [ ] **Step 1: Add README documentation**

Add a concise `GitHub status comments` section after the GitHub-mode command:

```md
### GitHub status comments

In GitHub mode, each Brain Hands work-item issue has one mutable status comment
and exactly one `brain-hands:*` state label. Brain Hands updates them only after
durable workflow transitions. Blockers, replans, requested changes, and verified
PR delivery are separate immutable comments.

The local run ledger remains authoritative. Comment or label synchronization is
best-effort and retried on resume; it never bypasses approval, changes a
verification result, or blocks an otherwise valid delivery. A no-op resume does
not mutate GitHub. Brain Hands never merges automatically.
```

- [ ] **Step 2: Update workflow and skill contracts**

Add the following rules to `agentic-codex-workflow.md` and the reporting portion
of `.agents/skills/brain-hands/SKILL.md`, matching each file's tone:

```md
- Treat issue status comments and `brain-hands:*` state labels as projections
  of the run ledger, never as workflow authority.
- Update the owned status comment only at persisted state transitions.
- Emit immutable comments only for verification blockers, replans, requested
  changes, and verified PR delivery.
- Record status-sync failures generically and retry them on resume without
  blocking Hands, Verifier, or delivery.
- Do not emit raw logs, local paths, prompts, secrets, or arbitrary errors.
- Do nothing to GitHub status on a fully synchronized no-op resume.
```

- [ ] **Step 3: Run focused status and GitHub suites**

Run:

```bash
npx vitest run \
  tests/github/status-projection.test.ts \
  tests/github/status-checkpoint.test.ts \
  tests/github/status-sync.test.ts \
  tests/adapters/github.test.ts \
  tests/core/ledger.test.ts \
  tests/workflow/github-status.test.ts \
  tests/workflow/runtime-github.test.ts \
  tests/workflow/runtime-local.test.ts
```

Expected: all focused tests PASS.

- [ ] **Step 4: Run the complete test suite**

Run: `npm test`

Expected: PASS with no failed test files.

- [ ] **Step 5: Run static and build verification**

Run: `npm run typecheck`

Expected: PASS with exit code 0.

Run: `npm run build`

Expected: PASS and `dist/` builds successfully.

- [ ] **Step 6: Verify package contents**

Run: `npm_config_cache=/private/tmp/brain-hands-npm-cache npm pack --dry-run`

Expected: PASS; package contents remain limited to `dist/`, `prompts/`,
`agentic-codex-workflow.md`, `README.md`, and package metadata.

- [ ] **Step 7: Run whitespace and scope checks**

Run: `git diff --check`

Expected: no output and exit code 0.

Run: `git status --short`

Expected: only files from this implementation plan are modified.

- [ ] **Step 8: Commit documentation and final verification updates**

```bash
git add README.md agentic-codex-workflow.md .agents/skills/brain-hands/SKILL.md
git commit -m "docs: explain GitHub status projections"
```

## Completion Proof

Before reporting completion, capture:

- focused test command and result;
- full `npm test` result;
- `npm run typecheck` result;
- `npm run build` result;
- `npm pack --dry-run` result and package file list;
- `git diff --check` result;
- final commit list; and
- a concise residual-risk statement covering real GitHub API behavior that was
  not exercised against an authorized live repository.

Do not claim live GitHub verification unless an authorized real GitHub-mode run
was performed. Unit and recording-adapter results prove deterministic behavior,
not remote permissions, label policy, rate limits, or repository settings.
