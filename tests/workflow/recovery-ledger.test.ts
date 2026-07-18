import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  createRunLedgerV2,
  recordTerminalDisposition,
  updateManifestV2,
} from "../../src/core/ledger.js";
import {
  diagnosticRecoveryAuthorizationV1Schema,
  diagnosticRecoveryConsumptionV1Schema,
  recoveryObservationV1Schema,
  recoveryProgressSubjectV1Schema,
} from "../../src/core/schema.js";
import {
  type RecoveryObservationV1,
  blockerFingerprint,
  progressSubjectSha256,
  recoveryScopePathComponent,
} from "../../src/workflow/recovery-policy.js";
import type { RecoveryProgressSubjectV1 } from "../../src/workflow/recovery-policy.js";
import {
  authorizeDiagnosticResume,
  claimAuthorizedRecoveryAttempt,
  diagnosticRecoveryAuthorizationPath,
  diagnosticRecoveryConsumptionPath,
  type DiagnosticRecoveryAuthorizationV1,
  type DiagnosticRecoveryConsumptionV1,
  type RecoveryDecisionArtifactV1,
  reconcileRecoveryJournal,
  recordRecoveryObservation,
  recoveryDecisionArtifactV1Schema,
  recoveryDecisionPath,
  recoveryReviewScopeSubject,
} from "../../src/workflow/recovery-ledger.js";
import { createLegacyRunLedgerV2 } from "../fixtures/legacy-run.js";

let repoRoot: string | null = null;
const execFileAsync = promisify(execFile);
const progressSubjects = new Map<string, RecoveryProgressSubjectV1>();

afterEach(async () => {
  if (repoRoot) {
    await rm(repoRoot, { recursive: true, force: true });
    repoRoot = null;
  }
});

describe("review recovery scope binding", () => {
  it("maps only ordinary, final-integrated, and post-PR scopes to their exact review subject", () => {
    expect(recoveryReviewScopeSubject("work-item:item-1", "work_item")).toBe("item-1");
    expect(recoveryReviewScopeSubject("integrated:final", "final_integrated")).toBe("integrated");
    expect(recoveryReviewScopeSubject("integrated:post-pr", "post_pr")).toBe("integrated");
  });

  it.each([
    ["integrated:final", "post_pr"],
    ["integrated:post-pr", "final_integrated"],
    ["integrated", "final_integrated"],
    ["integrated:post_pr", "post_pr"],
    ["work-item:item-1", "final_integrated"],
    ["work-item:", "work_item"],
  ] as const)("rejects scope %s for review phase %s", (scopeId, phase) => {
    expect(() => recoveryReviewScopeSubject(scopeId, phase)).toThrow(/scope|phase|binding/i);
  });
});

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function decisionEventId(
  value: RecoveryObservationV1,
  previousDecisionEventId: string | null,
): string {
  return `recovery-decision:${createHash("sha256").update(JSON.stringify({
    domain: "brain-hands/recovery-decision-event",
    version: 1,
    run_id: value.run_id,
    scope_id: value.scope_id,
    effect_attempt_id: value.effect_attempt_id,
    previous_decision_event_id: previousDecisionEventId,
  })).digest("hex")}`;
}

function observationId(value: RecoveryObservationV1): string {
  return createHash("sha256").update(JSON.stringify({
    domain: "brain-hands/recovery-observation-id",
    version: 1,
    run_id: value.run_id,
    scope_id: value.scope_id,
    effect_attempt_id: value.effect_attempt_id,
  })).digest("hex");
}

function observation(input: {
  runId: string;
  attemptId?: string;
  scopeId?: string;
  blockerCode?: string;
  progress?: string;
}): RecoveryObservationV1 {
  const subject = {
    version: 1 as const,
    scope_id: input.scopeId ?? "work-item:item-1",
    stage: "fixing" as const,
    operation: "work-item-fix",
    failure_class: "implementation_failure" as const,
    blocker_code: input.blockerCode ?? "tests_failed",
    finding_ids: ["finding:alpha"],
  };
  const progressToken = input.progress ?? sha("progress-a");
  const progressSubject: RecoveryProgressSubjectV1 = {
    version: 1,
    approved_plan_sha256: null,
    candidate_commit: null,
    implementation_artifact_sha256: null,
    verification_artifact_sha256: null,
    review_artifact_sha256: null,
    review_revision: Number.parseInt(progressToken.slice(0, 8), 16),
    finding_ids: [...subject.finding_ids],
  };
  const progressSha256 = progressSubjectSha256(progressSubject);
  progressSubjects.set(progressSha256, progressSubject);
  return {
    ...subject,
    run_id: input.runId,
    effect_attempt_id: input.attemptId ?? "attempt-a",
    blocker_fingerprint: blockerFingerprint(subject),
    progress_subject_sha256: progressSha256,
  };
}

async function createRun(originalRequest = "Recover the same run") {
  repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-recovery-ledger-"));
  return createRunLedgerV2({ repoRoot, originalRequest });
}

function recordInput(runDir: string, value: RecoveryObservationV1) {
  const progress = progressSubjects.get(value.progress_subject_sha256);
  if (progress === undefined) throw new Error("Test recovery progress subject is missing");
  return {
    runDir,
    observation: value,
    requestedEffect: "fix" as const,
    requestedEffectReason: "blocking_findings_present",
    diagnosticContext: {
      classification: {
        kind: "operational" as const,
        failure_class: value.failure_class,
        blocker_code: value.blocker_code,
      },
      policy_decision: null,
      owned_evidence_refs: {
        implementation_path: null,
        verification_path: null,
        review_path: null,
      },
      progress: { subject: progress, sha256: value.progress_subject_sha256 },
    },
  };
}

async function eventRecords(runDir: string): Promise<Array<Record<string, unknown>>> {
  return (await readFile(join(runDir, "events.jsonl"), "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function decisionPaths(runDir: string, scopeId = "work-item:item-1"): Promise<string[]> {
  const root = join(
    runDir,
    "recovery/scopes",
    recoveryScopePathComponent(scopeId),
    "decisions",
  );
  return (await readdir(root)).sort().map((name) => join(root, name));
}

async function readDecision(path: string): Promise<RecoveryDecisionArtifactV1> {
  return recoveryDecisionArtifactV1Schema.parse(JSON.parse(await readFile(path, "utf8")));
}

async function createDiagnosticStop(scopeId = "work-item:item-1") {
  const ledger = await createRun();
  await recordRecoveryObservation(recordInput(
    ledger.runDir,
    observation({ runId: ledger.runId, attemptId: "attempt-a", scopeId }),
  ));
  const stopped = await recordRecoveryObservation(recordInput(
    ledger.runDir,
    observation({ runId: ledger.runId, attemptId: "attempt-b", scopeId }),
  ));
  expect(stopped.decision.guard_action).toBe("diagnostic_stop");
  return { ledger, stopped };
}

async function authorizationEntries(runDir: string, scopeId = "work-item:item-1"): Promise<string[]> {
  const root = join(
    runDir,
    "recovery/scopes",
    recoveryScopePathComponent(scopeId),
    "authorizations",
  );
  return (await readdir(root).catch((error: unknown) => {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
    throw error;
  })).sort();
}

async function projectionBytes(runDir: string): Promise<{ events: Buffer; manifest: Buffer }> {
  return {
    events: await readFile(join(runDir, "events.jsonl")),
    manifest: await readFile(join(runDir, "manifest.json")),
  };
}

async function recoveryMutationSnapshot(runDir: string, scopeId = "work-item:item-1") {
  return {
    projection: await projectionBytes(runDir),
    decisions: await Promise.all((await decisionPaths(runDir, scopeId)).map((path) => readFile(path))),
    authorizations: await Promise.all((await authorizationEntries(runDir, scopeId)).map(async (name) => ({
      name,
      bytes: await readFile(join(
        runDir,
        "recovery/scopes",
        recoveryScopePathComponent(scopeId),
        "authorizations",
        name,
      )),
    }))),
  };
}

async function writeProjectionBytes(
  runDir: string,
  bytes: { events: Buffer; manifest: Buffer },
): Promise<void> {
  await writeFile(join(runDir, "events.jsonl"), bytes.events);
  await writeFile(join(runDir, "manifest.json"), bytes.manifest);
}

async function reorderRecoveryEvents(runDir: string, indexes: number[]): Promise<void> {
  const eventsPath = join(runDir, "events.jsonl");
  const lines = (await readFile(eventsPath, "utf8")).trim().split("\n");
  const recoveryIndexes = lines
    .map((line, index) => ({ event: JSON.parse(line) as Record<string, unknown>, index }))
    .filter(({ event }) => event.type === "recovery_decision_recorded")
    .map(({ index }) => index);
  const recoveryLines = recoveryIndexes.map((index) => lines[index]);
  for (let index = 0; index < recoveryIndexes.length; index += 1) {
    lines[recoveryIndexes[index]] = recoveryLines[indexes[index]];
  }
  await writeFile(eventsPath, `${lines.join("\n")}\n`);
}

describe("recovery artifact schemas and paths", () => {
  it("strictly validates progress subjects and observations", () => {
    const progress = {
      version: 1 as const,
      approved_plan_sha256: sha("plan"),
      candidate_commit: "abc123",
      implementation_artifact_sha256: null,
      verification_artifact_sha256: sha("verification"),
      review_artifact_sha256: sha("review"),
      review_revision: 1,
      finding_ids: ["finding:alpha"],
    };
    const validObservation = observation({ runId: "run-1" });

    expect(recoveryProgressSubjectV1Schema.parse(progress)).toEqual(progress);
    expect(recoveryObservationV1Schema.parse(validObservation)).toEqual(validObservation);
    expect(() => recoveryProgressSubjectV1Schema.parse({ ...progress, extra: true })).toThrow();
    expect(() => recoveryProgressSubjectV1Schema.parse({ ...progress, finding_ids: ["same", "same"] })).toThrow();
    expect(() => recoveryObservationV1Schema.parse({ ...validObservation, extra: true })).toThrow();
    expect(() => recoveryObservationV1Schema.parse({ ...validObservation, effect_attempt_id: " " })).toThrow();
  });

  it("uses the bounded shared scope component and exact canonical decision path", () => {
    const scopeId = `scope/../:\ud800:${"x".repeat(10_000)}`;
    const observationId = "b".repeat(64);
    const path = recoveryDecisionPath(scopeId, 12, observationId);

    expect(path).toBe(
      `recovery/scopes/${recoveryScopePathComponent(scopeId)}/decisions/000012-${observationId}.json`,
    );
    expect(basename(dirname(dirname(path)))).toBe(recoveryScopePathComponent(scopeId));
    expect(() => recoveryDecisionPath(scopeId, 0, observationId)).toThrow(/sequence|positive/i);
    expect(() => recoveryDecisionPath(scopeId, Number.MAX_SAFE_INTEGER + 1, observationId))
      .toThrow(/sequence|safe/i);
    expect(() => recoveryDecisionPath(scopeId, 1, "not-a-sha")).toThrow(/observation/i);
  });

  it("rejects decision schemas with extra keys, invalid identity, or mismatched heads", async () => {
    const ledger = await createRun();
    const recorded = await recordRecoveryObservation(
      recordInput(ledger.runDir, observation({ runId: ledger.runId })),
    );
    const decision = recorded.decision;

    expect(recoveryDecisionArtifactV1Schema.parse(decision)).toEqual(decision);
    expect(() => recoveryDecisionArtifactV1Schema.parse({ ...decision, extra: true })).toThrow();
    expect(() => recoveryDecisionArtifactV1Schema.parse({ ...decision, sequence: 0 })).toThrow();
    expect(() => recoveryDecisionArtifactV1Schema.parse({
      ...decision,
      decision_event_id: "recovery-decision:not-a-sha",
    })).toThrow();
    expect(() => recoveryDecisionArtifactV1Schema.parse({
      ...decision,
      decision_event_id: `recovery-decision:${"c".repeat(64)}`,
    })).toThrow(/event|identity/i);
    expect(() => recoveryDecisionArtifactV1Schema.parse({
      ...decision,
      next_state: { ...decision.next_state, head_sequence: 2 },
    })).toThrow(/sequence|head/i);
    expect(() => recoveryDecisionArtifactV1Schema.parse({
      ...decision,
      next_state: { ...decision.next_state, head_decision_path: "recovery/wrong.json" },
    })).toThrow(/path|head/i);
    expect(() => recoveryDecisionArtifactV1Schema.parse({
      ...decision,
      next_state: { ...decision.next_state, blocker_fingerprint: "d".repeat(64) },
    })).toThrow(/guard|semantic|observation|state/i);
    expect(decision.previous_decision_event_id).toBeNull();
    expect(() => recoveryDecisionArtifactV1Schema.parse({
      ...decision,
      previous_decision_event_id: `recovery-decision:${"c".repeat(64)}`,
    })).toThrow(/event|identity|previous|predecessor/i);
    expect(() => recoveryDecisionArtifactV1Schema.parse({
      ...decision,
      decision_event_id: `recovery-decision:${"d".repeat(64)}`,
    })).toThrow(/event|identity/i);
  });

  it("strictly validates canonical diagnostic authorization and consumption identities", async () => {
    const { ledger, stopped } = await createDiagnosticStop();
    const authorization = await authorizeDiagnosticResume({
      runDir: ledger.runDir,
      actor: "operator@example.test",
      note: "Restored the isolated test service",
    });
    const consumption = await claimAuthorizedRecoveryAttempt({
      runDir: ledger.runDir,
      authorization,
    });

    expect(diagnosticRecoveryAuthorizationV1Schema.parse(authorization)).toEqual(authorization);
    expect(diagnosticRecoveryConsumptionV1Schema.parse(consumption)).toEqual(consumption);
    expect(diagnosticRecoveryAuthorizationPath(authorization.scope_id, authorization.authorization_id))
      .toBe(`recovery/scopes/${recoveryScopePathComponent(authorization.scope_id)}/authorizations/${authorization.authorization_id}.json`);
    expect(diagnosticRecoveryConsumptionPath(authorization.scope_id, authorization.authorization_id))
      .toBe(`recovery/scopes/${recoveryScopePathComponent(authorization.scope_id)}/authorizations/${authorization.authorization_id}-consumed.json`);
    expect(authorization.decision_path).toBe(stopped.artifact_path);
    expect(() => diagnosticRecoveryAuthorizationV1Schema.parse({ ...authorization, extra: true })).toThrow();
    expect(() => diagnosticRecoveryAuthorizationV1Schema.parse({
      ...authorization,
      note_sha256: sha("different note"),
    })).toThrow(/note|sha|identity/i);
    expect(() => diagnosticRecoveryAuthorizationV1Schema.parse({
      ...authorization,
      authorization_id: `diagnostic-authorization:${"f".repeat(64)}`,
    })).toThrow(/authorization|identity/i);
    expect(() => diagnosticRecoveryConsumptionV1Schema.parse({
      ...consumption,
      effect_attempt_id: `recovery-attempt:${"f".repeat(64)}`,
    })).toThrow(/attempt|identity/i);
    expect(() => diagnosticRecoveryAuthorizationPath(authorization.scope_id, "bad"))
      .toThrow(/authorization|identity/i);
  });
});

describe("diagnostic recovery authorization", () => {
  it("authorizes the validated global-chain diagnostic stop without resetting progress", async () => {
    const { ledger, stopped } = await createDiagnosticStop();
    const before = stopped.manifest;
    const eventsBefore = await readFile(join(ledger.runDir, "events.jsonl"));
    const accountingBefore = structuredClone(before.review_accounting);
    const workItemProgressBefore = structuredClone(before.work_item_progress);

    const authorization = await authorizeDiagnosticResume({
      runDir: ledger.runDir,
      actor: "operator@example.test",
      note: "Restored the isolated test service",
    });
    const manifest = await reconcileRecoveryJournal(ledger.runDir);
    const previous = before.recovery.scopes["work-item:item-1"]!;

    expect(authorization).toMatchObject({
      version: 1,
      run_id: ledger.runId,
      scope_id: "work-item:item-1",
      journal_sequence: previous.head_sequence,
      decision_path: previous.head_decision_path,
      blocker_fingerprint: previous.blocker_fingerprint,
      progress_subject_sha256: previous.progress_subject_sha256,
      actor: "operator@example.test",
      note: "Restored the isolated test service",
      note_sha256: sha("Restored the isolated test service"),
    });
    expect(authorization.authorization_id).toMatch(/^diagnostic-authorization:[a-f0-9]{64}$/);
    expect(authorization.recorded_at).toMatch(/Z$/);
    expect(manifest.recovery.active_scope).toBe("work-item:item-1");
    expect(manifest.recovery.scopes["work-item:item-1"]).toEqual({
      ...previous,
      disposition: "active",
      diagnostic_path: null,
      authorization_path: diagnosticRecoveryAuthorizationPath(
        authorization.scope_id,
        authorization.authorization_id,
      ),
    });
    expect(manifest.review_accounting).toEqual(accountingBefore);
    expect(manifest.work_item_progress).toEqual(workItemProgressBefore);
    expect(await readFile(join(ledger.runDir, "events.jsonl"))).toEqual(eventsBefore);
    expect(await authorizationEntries(ledger.runDir)).toEqual([
      `${authorization.authorization_id}.json`,
    ]);
  });

  it("replays the first unconsumed authorization with a stable timestamp", async () => {
    const { ledger } = await createDiagnosticStop();
    const input = {
      runDir: ledger.runDir,
      actor: "operator@example.test",
      note: "Restored the isolated test service",
    };

    const first = await authorizeDiagnosticResume(input);
    const manifestBytes = await readFile(join(ledger.runDir, "manifest.json"));
    const replay = await authorizeDiagnosticResume(input);

    expect(replay).toEqual(first);
    expect(replay.recorded_at).toBe(first.recorded_at);
    expect(await readFile(join(ledger.runDir, "manifest.json"))).toEqual(manifestBytes);
    expect(await authorizationEntries(ledger.runDir)).toHaveLength(1);
  });

  it.each(["unterminated", "blank-line", "crlf"] as const)(
    "rejects %s event framing before first or repeated authorization writes",
    async (framing) => {
      const { ledger } = await createDiagnosticStop();
      const eventsPath = join(ledger.runDir, "events.jsonl");
      const canonical = await readFile(eventsPath, "utf8");
      const malformed = framing === "unterminated"
        ? canonical.slice(0, -1)
        : framing === "blank-line"
          ? canonical.replace("\n", "\n\n")
          : canonical.replaceAll("\n", "\r\n");
      await writeFile(eventsPath, malformed);
      const before = await recoveryMutationSnapshot(ledger.runDir);

      for (let attempt = 0; attempt < 2; attempt += 1) {
        await expect(authorizeDiagnosticResume({
          runDir: ledger.runDir,
          actor: "operator@example.test",
          note: "Restored service",
        })).rejects.toThrow(/event|framing|newline|blank|crlf|canonical/i);
        expect(await recoveryMutationSnapshot(ledger.runDir)).toEqual(before);
      }
    },
  );

  it("accepts empty and canonical event framing at their semantic boundaries", async () => {
    const empty = await createRun();
    const emptyBefore = await projectionBytes(empty.runDir);
    await expect(authorizeDiagnosticResume({
      runDir: empty.runDir,
      actor: "operator@example.test",
      note: "Restored service",
    })).rejects.toThrow(/diagnostic|active|scope|state/i);
    expect(await projectionBytes(empty.runDir)).toEqual(emptyBefore);
    await rm(repoRoot!, { recursive: true, force: true });
    repoRoot = null;

    const { ledger } = await createDiagnosticStop();
    await expect(authorizeDiagnosticResume({
      runDir: ledger.runDir,
      actor: "operator@example.test",
      note: "Restored service",
    })).resolves.toMatchObject({ run_id: ledger.runId });
  });

  it("rejects ill-formed Unicode notes and preserves exact well-formed note identity", async () => {
    for (const note of ["\ud800", "\udfff", " \ud800 "]) {
      const { ledger } = await createDiagnosticStop();
      const before = await recoveryMutationSnapshot(ledger.runDir);
      await expect(authorizeDiagnosticResume({
        runDir: ledger.runDir,
        actor: "operator@example.test",
        note,
      })).rejects.toThrow(/note|unicode|well-formed/i);
      expect(await recoveryMutationSnapshot(ledger.runDir)).toEqual(before);
      await rm(repoRoot!, { recursive: true, force: true });
      repoRoot = null;
    }

    const { ledger } = await createDiagnosticStop();
    const first = await authorizeDiagnosticResume({
      runDir: ledger.runDir,
      actor: "operator@example.test",
      note: "Restored \ufffd service \ud83d\ude80\nverified",
    });
    expect((await authorizeDiagnosticResume({
      runDir: ledger.runDir,
      actor: "operator@example.test",
      note: "Restored \ufffd service \ud83d\ude80\nverified",
    }))).toEqual(first);
    await expect(authorizeDiagnosticResume({
      runDir: ledger.runDir,
      actor: "operator@example.test",
      note: "Restored e\u0301 service",
    })).rejects.toThrow(/different|authorization|note|subject/i);
    expect(() => diagnosticRecoveryAuthorizationV1Schema.parse({
      ...first,
      note: "\ud800",
      note_sha256: sha("\ud800"),
    })).toThrow(/note|unicode|well-formed/i);

    await rm(repoRoot!, { recursive: true, force: true });
    repoRoot = null;
    const normalized = await createDiagnosticStop();
    await authorizeDiagnosticResume({
      runDir: normalized.ledger.runDir,
      actor: "operator@example.test",
      note: "Restored \u00e9 service",
    });
    await expect(authorizeDiagnosticResume({
      runDir: normalized.ledger.runDir,
      actor: "operator@example.test",
      note: "Restored e\u0301 service",
    })).rejects.toThrow(/different|authorization|note|subject/i);
  });

  it.each([
    ["blank actor", { actor: " ", note: "Restored service" }],
    ["blank note", { actor: "operator@example.test", note: "\t" }],
    ["non-string actor", { actor: 42, note: "Restored service" }],
    ["non-string note", { actor: "operator@example.test", note: { text: "restored" } }],
  ])("rejects %s before writing authorization state", async (_label, values) => {
    const { ledger } = await createDiagnosticStop();
    const before = await projectionBytes(ledger.runDir);
    const entriesBefore = await authorizationEntries(ledger.runDir);

    await expect(authorizeDiagnosticResume({
      runDir: ledger.runDir,
      actor: values.actor as string,
      note: values.note as string,
    })).rejects.toThrow(/actor|note|string|blank/i);

    expect(await projectionBytes(ledger.runDir)).toEqual(before);
    expect(await authorizationEntries(ledger.runDir)).toEqual(entriesBefore);
  });

  it("rejects runs that are not at a diagnostic stop", async () => {
    const ledger = await createRun();
    const before = await projectionBytes(ledger.runDir);

    await expect(authorizeDiagnosticResume({
      runDir: ledger.runDir,
      actor: "operator@example.test",
      note: "Restored service",
    })).rejects.toThrow(/diagnostic|active scope|state/i);

    expect(await projectionBytes(ledger.runDir)).toEqual(before);
    expect(await readdir(join(ledger.runDir, "recovery/scopes"))).toEqual([]);
  });

  it.each([
    ["terminal", { terminal: true }],
    ["abandonment path", {
      abandonment_path: "assurance/abandonment.json",
      assurance_outcome: "abandoned",
    }],
    ["abandoned outcome", { assurance_outcome: "abandoned" }],
  ] as Array<[string, {
    terminal?: boolean;
    abandonment_path?: string;
    assurance_outcome?: string;
  }]>)("rejects a %s run before authorization writes", async (_label, condition) => {
    const { ledger } = await createDiagnosticStop();
    if (condition.terminal) {
      await updateManifestV2(ledger.runDir, { delivery_state: "blocked" });
      await recordTerminalDisposition(ledger.runDir, {
        outcome: "closed_blocked",
        actor: "human",
        reason: "Stop this run",
        residual_risks: [],
      });
    } else {
      await updateManifestV2(ledger.runDir, {
        ...(condition.abandonment_path ? {
          abandonment_path: condition.abandonment_path,
          assurance_outcome: condition.assurance_outcome as "abandoned",
          delivery_state: "blocked",
        } : {}),
        ...(condition.assurance_outcome ? {
          assurance_outcome: condition.assurance_outcome as "abandoned",
          delivery_state: "blocked",
        } : {}),
      });
    }
    const before = await projectionBytes(ledger.runDir);

    await expect(authorizeDiagnosticResume({
      runDir: ledger.runDir,
      actor: "operator@example.test",
      note: "Restored service",
    })).rejects.toThrow(/terminal|abandon/i);

    expect(await projectionBytes(ledger.runDir)).toEqual(before);
    expect(await authorizationEntries(ledger.runDir)).toEqual([]);
  });

  it("recovers an artifact-only authorization crash and keeps the first bytes", async () => {
    const { ledger, stopped } = await createDiagnosticStop();
    const sentinel = new Error("sentinel:afterAuthorizationArtifact");
    const input = {
      runDir: ledger.runDir,
      actor: "operator@example.test",
      note: "Restored the isolated test service",
    };

    await expect(authorizeDiagnosticResume({
      ...input,
      hooks: { afterAuthorizationArtifact: async () => { throw sentinel; } },
    })).rejects.toBe(sentinel);
    const [entry] = await authorizationEntries(ledger.runDir);
    const artifactBytes = await readFile(join(
      ledger.runDir,
      "recovery/scopes",
      recoveryScopePathComponent("work-item:item-1"),
      "authorizations",
      entry,
    ));
    const manifestAfterCrash = JSON.parse(await readFile(join(ledger.runDir, "manifest.json"), "utf8"));
    expect(manifestAfterCrash.recovery.scopes["work-item:item-1"])
      .toEqual(stopped.decision.next_state);

    const replay = await authorizeDiagnosticResume(input);

    expect(await authorizationEntries(ledger.runDir)).toEqual([entry]);
    expect(await readFile(join(
      ledger.runDir,
      "recovery/scopes",
      recoveryScopePathComponent("work-item:item-1"),
      "authorizations",
      entry,
    ))).toEqual(artifactBytes);
    expect(replay).toEqual(diagnosticRecoveryAuthorizationV1Schema.parse(
      JSON.parse(artifactBytes.toString("utf8")),
    ));
  });

  it("rejects advancing the global chain past an artifact-only authorization", async () => {
    const { ledger } = await createDiagnosticStop("scope:A");
    const sentinel = new Error("sentinel:afterAuthorizationArtifact");
    const input = {
      runDir: ledger.runDir,
      actor: "operator@example.test",
      note: "Restored service A",
    };
    await expect(authorizeDiagnosticResume({
      ...input,
      hooks: { afterAuthorizationArtifact: async () => { throw sentinel; } },
    })).rejects.toBe(sentinel);
    const before = await projectionBytes(ledger.runDir);

    await expect(recordRecoveryObservation(recordInput(
      ledger.runDir,
      observation({ runId: ledger.runId, attemptId: "attempt-c", scopeId: "scope:B" }),
    ))).rejects.toThrow(/authorization|consum|claim|attempt/i);
    expect(await projectionBytes(ledger.runDir)).toEqual(before);
    await expect(authorizeDiagnosticResume(input)).resolves.toMatchObject({ scope_id: "scope:A" });
  });

  it.each(["constructor", "toString", "hasOwnProperty"])(
    "authorizes and claims an own prototype-named %s scope",
    async (scopeId) => {
      const { ledger } = await createDiagnosticStop(scopeId);
      const authorization = await authorizeDiagnosticResume({
        runDir: ledger.runDir,
        actor: "operator@example.test",
        note: `Restored ${scopeId}`,
      });
      const consumption = await claimAuthorizedRecoveryAttempt({
        runDir: ledger.runDir,
        authorization,
      });

      expect(authorization.scope_id).toBe(scopeId);
      expect(consumption.scope_id).toBe(scopeId);
      expect(Object.prototype.hasOwnProperty.call(
        (await reconcileRecoveryJournal(ledger.runDir)).recovery.scopes,
        scopeId,
      )).toBe(true);
    },
  );

  it("serializes concurrent authorization and claim calls into one authorization and one consumption", async () => {
    const { ledger } = await createDiagnosticStop();
    const input = {
      runDir: ledger.runDir,
      actor: "operator@example.test",
      note: "Restored service",
    };

    const authorizations = await Promise.all([
      authorizeDiagnosticResume(input),
      authorizeDiagnosticResume(input),
      authorizeDiagnosticResume(input),
    ]);
    expect(authorizations[1]).toEqual(authorizations[0]);
    expect(authorizations[2]).toEqual(authorizations[0]);

    const consumptions = await Promise.all([
      claimAuthorizedRecoveryAttempt({ runDir: ledger.runDir, authorization: authorizations[0] }),
      claimAuthorizedRecoveryAttempt({ runDir: ledger.runDir, authorization: authorizations[0] }),
      claimAuthorizedRecoveryAttempt({ runDir: ledger.runDir, authorization: authorizations[0] }),
    ]);
    expect(consumptions[1]).toEqual(consumptions[0]);
    expect(consumptions[2]).toEqual(consumptions[0]);
    expect(await authorizationEntries(ledger.runDir)).toEqual([
      `${authorizations[0].authorization_id}-consumed.json`,
      `${authorizations[0].authorization_id}.json`,
    ]);
  });
});

describe("diagnostic recovery attempt consumption", () => {
  it("leaves an unclaimed authorization reusable and claims one deterministic attempt", async () => {
    const { ledger } = await createDiagnosticStop();
    const authorization = await authorizeDiagnosticResume({
      runDir: ledger.runDir,
      actor: "operator@example.test",
      note: "Restored service",
    });
    expect(await authorizationEntries(ledger.runDir)).toEqual([
      `${authorization.authorization_id}.json`,
    ]);
    const eventsBeforeClaim = await readFile(join(ledger.runDir, "events.jsonl"));

    const consumption = await claimAuthorizedRecoveryAttempt({
      runDir: ledger.runDir,
      authorization,
    });

    expect(consumption).toMatchObject({
      version: 1,
      authorization_id: authorization.authorization_id,
      run_id: ledger.runId,
      scope_id: authorization.scope_id,
    });
    expect(consumption.effect_attempt_id).toBe(`recovery-attempt:${createHash("sha256")
      .update(`brain-hands-recovery-attempt-v1\0${authorization.authorization_id}`)
      .digest("hex")}`);
    expect(consumption.consumed_at).toMatch(/Z$/);
    expect(await readFile(join(ledger.runDir, "events.jsonl"))).toEqual(eventsBeforeClaim);
  });

  it.each(["unterminated", "blank-line", "crlf"] as const)(
    "rejects %s event framing before a claim artifact write",
    async (framing) => {
      const { ledger } = await createDiagnosticStop();
      const authorization = await authorizeDiagnosticResume({
        runDir: ledger.runDir,
        actor: "operator@example.test",
        note: "Restored service",
      });
      const eventsPath = join(ledger.runDir, "events.jsonl");
      const canonical = await readFile(eventsPath, "utf8");
      await writeFile(eventsPath, framing === "unterminated"
        ? canonical.slice(0, -1)
        : framing === "blank-line"
          ? canonical.replace("\n", "\n\n")
          : canonical.replaceAll("\n", "\r\n"));
      const before = await recoveryMutationSnapshot(ledger.runDir);

      await expect(claimAuthorizedRecoveryAttempt({ runDir: ledger.runDir, authorization }))
        .rejects.toThrow(/event|framing|newline|blank|crlf|canonical/i);
      expect(await recoveryMutationSnapshot(ledger.runDir)).toEqual(before);
    },
  );

  it("preserves the authorization transition in a later consumed-attempt decision chain", async () => {
    const { ledger } = await createDiagnosticStop();
    const authorization = await authorizeDiagnosticResume({
      runDir: ledger.runDir,
      actor: "operator@example.test",
      note: "Restored service",
    });
    const authorizedManifest = await reconcileRecoveryJournal(ledger.runDir);
    const authorizedState = authorizedManifest.recovery.scopes[authorization.scope_id]!;
    const consumption = await claimAuthorizedRecoveryAttempt({
      runDir: ledger.runDir,
      authorization,
    });

    const recorded = await recordRecoveryObservation(recordInput(
      ledger.runDir,
      observation({
        runId: ledger.runId,
        attemptId: consumption.effect_attempt_id,
        scopeId: authorization.scope_id,
      }),
    ));
    const reconciled = await reconcileRecoveryJournal(ledger.runDir);

    expect(recorded.decision.previous_state).toEqual(authorizedState);
    expect(recorded.decision.next_state).toMatchObject({
      head_sequence: authorization.journal_sequence + 1,
      consecutive_without_progress: authorizedState.consecutive_without_progress + 1,
      disposition: "diagnostic_stop",
      authorization_path: null,
    });
    expect(reconciled.recovery.scopes[authorization.scope_id])
      .toEqual(recorded.decision.next_state);
    expect((await authorizationEntries(ledger.runDir)).filter((entry) =>
      entry.endsWith("-consumed.json"))).toHaveLength(1);
  });

  it("requires the consumed attempt immediately and clears its authorization before later decisions", async () => {
    const { ledger } = await createDiagnosticStop();
    const authorization = await authorizeDiagnosticResume({
      runDir: ledger.runDir,
      actor: "operator@example.test",
      note: "Restored service",
    });

    const unclaimedBefore = await recoveryMutationSnapshot(ledger.runDir);
    await expect(recordRecoveryObservation(recordInput(
      ledger.runDir,
      observation({ runId: ledger.runId, attemptId: "ordinary-unclaimed" }),
    ))).rejects.toThrow(/authorization|consum|claim|attempt/i);
    expect(await recoveryMutationSnapshot(ledger.runDir)).toEqual(unclaimedBefore);

    const consumption = await claimAuthorizedRecoveryAttempt({ runDir: ledger.runDir, authorization });
    for (const value of [
      observation({ runId: ledger.runId, attemptId: "wrong-attempt" }),
      observation({ runId: ledger.runId, attemptId: "delayed-other-scope", scopeId: "scope:other" }),
    ]) {
      const before = await recoveryMutationSnapshot(ledger.runDir);
      await expect(recordRecoveryObservation(recordInput(ledger.runDir, value)))
        .rejects.toThrow(/authorization|consum|claim|attempt|immediate|scope/i);
      expect(await recoveryMutationSnapshot(ledger.runDir)).toEqual(before);
    }

    const authorizedInput = recordInput(
      ledger.runDir,
      observation({
        runId: ledger.runId,
        attemptId: consumption.effect_attempt_id,
        progress: sha("progress-after-recovery"),
      }),
    );
    const accepted = await recordRecoveryObservation(authorizedInput);
    expect(accepted.decision.previous_state?.authorization_path).not.toBeNull();
    expect(accepted.decision.next_state.authorization_path).toBeNull();
    expect((await recordRecoveryObservation(authorizedInput)).decision).toEqual(accepted.decision);

    const detachedBefore = await recoveryMutationSnapshot(ledger.runDir);
    await expect(recordRecoveryObservation(recordInput(
      ledger.runDir,
      observation({
        runId: ledger.runId,
        attemptId: consumption.effect_attempt_id,
        scopeId: "scope:other",
      }),
    ))).rejects.toThrow(/authorization|consum|attempt|scope|detached|reuse/i);
    expect(await recoveryMutationSnapshot(ledger.runDir)).toEqual(detachedBefore);

    const ordinary = await recordRecoveryObservation(recordInput(
      ledger.runDir,
      observation({ runId: ledger.runId, attemptId: "ordinary-after-authorized" }),
    ));
    expect(ordinary.decision.previous_state?.authorization_path).toBeNull();
  });

  it("rejects a persisted decision whose immediate authorized attempt binding was rewritten", async () => {
    const { ledger } = await createDiagnosticStop();
    const authorization = await authorizeDiagnosticResume({
      runDir: ledger.runDir,
      actor: "operator@example.test",
      note: "Restored service",
    });
    const consumption = await claimAuthorizedRecoveryAttempt({ runDir: ledger.runDir, authorization });
    const accepted = await recordRecoveryObservation(recordInput(
      ledger.runDir,
      observation({ runId: ledger.runId, attemptId: consumption.effect_attempt_id }),
    ));
    const wrongObservation = observation({ runId: ledger.runId, attemptId: "wrong-persisted-attempt" });
    const wrongPath = recoveryDecisionPath(
      wrongObservation.scope_id,
      accepted.decision.sequence,
      observationId(wrongObservation),
    );
    const wrongDecision = {
      ...accepted.decision,
      observation: wrongObservation,
      next_state: { ...accepted.decision.next_state, head_decision_path: wrongPath },
      decision_event_id: decisionEventId(
        wrongObservation,
        accepted.decision.previous_decision_event_id,
      ),
    } as RecoveryDecisionArtifactV1;
    await rm(join(ledger.runDir, accepted.artifact_path));
    await writeFile(join(ledger.runDir, wrongPath), `${JSON.stringify(wrongDecision, null, 2)}\n`);

    const eventsPath = join(ledger.runDir, "events.jsonl");
    const events = await eventRecords(ledger.runDir);
    const event = events.find((candidate) => candidate.event_id === accepted.decision.decision_event_id)!;
    event.event_id = wrongDecision.decision_event_id;
    event.payload = {
      ...(event.payload as Record<string, unknown>),
      artifact_path: wrongPath,
      effect_attempt_id: wrongObservation.effect_attempt_id,
    };
    await writeFile(eventsPath, `${events.map((candidate) => JSON.stringify(candidate)).join("\n")}\n`);
    const manifestPath = join(ledger.runDir, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.recovery.scopes[wrongObservation.scope_id].head_decision_path = wrongPath;
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
    const before = await projectionBytes(ledger.runDir);

    await expect(reconcileRecoveryJournal(ledger.runDir))
      .rejects.toThrow(/authorization|immediate|attempt|binding|diagnostic intent/i);
    expect(await projectionBytes(ledger.runDir)).toEqual(before);
  });

  it.each([
    "foreign",
    "second-authorization",
    "consumption",
    "remove",
    "replace-entry",
    "replace-directory",
  ] as const)(
    "rejects a %s mutation to the authorization entry snapshot",
    async (mutation) => {
      const { ledger } = await createDiagnosticStop();
      const authorization = await authorizeDiagnosticResume({
        runDir: ledger.runDir,
        actor: "operator@example.test",
        note: "Restored service",
      });
      const before = await projectionBytes(ledger.runDir);
      let mutated = false;

      await expect(reconcileRecoveryJournal(ledger.runDir, {
        afterAuthorizationEntriesRead: async (root) => {
          if (mutated) return;
          mutated = true;
          const authorizationFile = join(root, `${authorization.authorization_id}.json`);
          if (mutation === "foreign") await writeFile(join(root, "foreign.bin"), "foreign\n");
          if (mutation === "second-authorization") {
            await copyFile(authorizationFile, join(root, `diagnostic-authorization:${"f".repeat(64)}.json`));
          }
          if (mutation === "consumption") {
            await copyFile(authorizationFile, join(root, `${authorization.authorization_id}-consumed.json`));
          }
          if (mutation === "remove") await rm(authorizationFile);
          if (mutation === "replace-entry") {
            await rm(authorizationFile);
            await mkdir(authorizationFile);
          }
          if (mutation === "replace-directory") {
            const old = `${root}.old`;
            await rename(root, old);
            await mkdir(root);
          }
        },
      })).rejects.toThrow(/authorization|entry|snapshot|identity|changed|disappear/i);
      expect(await projectionBytes(ledger.runDir)).toEqual(before);
    },
  );

  it("replays the same consumption after a crash and never creates a second attempt", async () => {
    const { ledger } = await createDiagnosticStop();
    const authorization = await authorizeDiagnosticResume({
      runDir: ledger.runDir,
      actor: "operator@example.test",
      note: "Restored service",
    });
    const sentinel = new Error("sentinel:afterConsumptionArtifact");

    await expect(claimAuthorizedRecoveryAttempt({
      runDir: ledger.runDir,
      authorization,
      hooks: { afterConsumptionArtifact: async () => { throw sentinel; } },
    })).rejects.toBe(sentinel);
    const consumptionEntry = `${authorization.authorization_id}-consumed.json`;
    const consumptionPath = join(
      ledger.runDir,
      "recovery/scopes",
      recoveryScopePathComponent(authorization.scope_id),
      "authorizations",
      consumptionEntry,
    );
    const firstBytes = await readFile(consumptionPath);

    const replay = await claimAuthorizedRecoveryAttempt({ runDir: ledger.runDir, authorization });
    const repeated = await claimAuthorizedRecoveryAttempt({ runDir: ledger.runDir, authorization });

    expect(repeated).toEqual(replay);
    expect(replay).toEqual(diagnosticRecoveryConsumptionV1Schema.parse(
      JSON.parse(firstBytes.toString("utf8")),
    ));
    expect(await readFile(consumptionPath)).toEqual(firstBytes);
    expect((await authorizationEntries(ledger.runDir)).filter((entry) => entry.endsWith("-consumed.json")))
      .toEqual([consumptionEntry]);
  });

  it("refuses to authorize again after consumption", async () => {
    const { ledger } = await createDiagnosticStop();
    const input = {
      runDir: ledger.runDir,
      actor: "operator@example.test",
      note: "Restored service",
    };
    const authorization = await authorizeDiagnosticResume(input);
    await claimAuthorizedRecoveryAttempt({ runDir: ledger.runDir, authorization });
    const before = await projectionBytes(ledger.runDir);

    await expect(authorizeDiagnosticResume(input)).rejects.toThrow(/consum|already.*attempt|authorization/i);
    expect(await projectionBytes(ledger.runDir)).toEqual(before);
    expect(await authorizationEntries(ledger.runDir)).toHaveLength(2);
  });

  it("rejects a stale authorization when the active global-chain scope changes", async () => {
    const { ledger } = await createDiagnosticStop("scope:A");
    const authorization = await authorizeDiagnosticResume({
      runDir: ledger.runDir,
      actor: "operator@example.test",
      note: "Restored service A",
    });
    const claimed = await claimAuthorizedRecoveryAttempt({
      runDir: ledger.runDir,
      authorization,
    });
    await recordRecoveryObservation(recordInput(
      ledger.runDir,
      observation({
        runId: ledger.runId,
        attemptId: claimed.effect_attempt_id,
        scopeId: "scope:A",
        progress: sha("scope-a-recovered"),
      }),
    ));
    await recordRecoveryObservation(recordInput(
      ledger.runDir,
      observation({ runId: ledger.runId, attemptId: "attempt-c", scopeId: "scope:B" }),
    ));
    const before = await projectionBytes(ledger.runDir);

    await expect(claimAuthorizedRecoveryAttempt({ runDir: ledger.runDir, authorization }))
      .rejects.toThrow(/active|head|tail|scope|stale/i);
    expect(await projectionBytes(ledger.runDir)).toEqual(before);
    expect(await authorizationEntries(ledger.runDir, "scope:A")).toHaveLength(2);
  });

  it("rejects authorization and consumption artifacts with tampered bindings", async () => {
    const { ledger } = await createDiagnosticStop();
    const authorization = await authorizeDiagnosticResume({
      runDir: ledger.runDir,
      actor: "operator@example.test",
      note: "Restored service",
    });
    const authorizationPath = join(ledger.runDir, diagnosticRecoveryAuthorizationPath(
      authorization.scope_id,
      authorization.authorization_id,
    ));
    const originalAuthorization = await readFile(authorizationPath);
    const tamperedAuthorization: DiagnosticRecoveryAuthorizationV1 = {
      ...authorization,
      decision_path: authorization.decision_path.replace("000002", "000001"),
    };
    await writeFile(authorizationPath, `${JSON.stringify(tamperedAuthorization, null, 2)}\n`);
    const beforeAuthorizationReconcile = await projectionBytes(ledger.runDir);
    await expect(reconcileRecoveryJournal(ledger.runDir)).rejects.toThrow(/authorization|decision|head|binding|identity/i);
    expect(await projectionBytes(ledger.runDir)).toEqual(beforeAuthorizationReconcile);

    await writeFile(authorizationPath, originalAuthorization);
    const consumption = await claimAuthorizedRecoveryAttempt({ runDir: ledger.runDir, authorization });
    const consumptionPath = join(ledger.runDir, diagnosticRecoveryConsumptionPath(
      authorization.scope_id,
      authorization.authorization_id,
    ));
    const tamperedConsumption: DiagnosticRecoveryConsumptionV1 = {
      ...consumption,
      scope_id: "scope:foreign",
    };
    await writeFile(consumptionPath, `${JSON.stringify(tamperedConsumption, null, 2)}\n`);
    const beforeConsumptionReconcile = await projectionBytes(ledger.runDir);
    await expect(reconcileRecoveryJournal(ledger.runDir)).rejects.toThrow(/consumption|scope|binding|authorization/i);
    expect(await projectionBytes(ledger.runDir)).toEqual(beforeConsumptionReconcile);
  });

  it("rejects foreign files, filename aliases, symlinks, and non-files in authorizations", async () => {
    const cases = ["foreign", "alias", "symlink", "directory"] as const;
    for (const testCase of cases) {
      const { ledger } = await createDiagnosticStop();
      const authorization = await authorizeDiagnosticResume({
        runDir: ledger.runDir,
        actor: "operator@example.test",
        note: "Restored service",
      });
      const root = join(
        ledger.runDir,
        "recovery/scopes",
        recoveryScopePathComponent(authorization.scope_id),
        "authorizations",
      );
      if (testCase === "foreign") await writeFile(join(root, "foreign.json"), "{}\n");
      if (testCase === "alias") {
        await writeFile(
          join(root, `diagnostic-authorization:${"f".repeat(64)}.json`),
          await readFile(join(root, `${authorization.authorization_id}.json`)),
        );
      }
      if (testCase === "symlink") {
        await symlink(join(root, `${authorization.authorization_id}.json`), join(root, "linked.json"));
      }
      if (testCase === "directory") await mkdir(join(root, "nested"));
      const before = await projectionBytes(ledger.runDir);

      await expect(reconcileRecoveryJournal(ledger.runDir))
        .rejects.toThrow(/authorization|unsupported|canonical|symlink|regular|entry|identity/i);
      expect(await projectionBytes(ledger.runDir)).toEqual(before);

      await rm(repoRoot!, { recursive: true, force: true });
      repoRoot = null;
    }
  });
});

describe("immutable recovery journal", () => {
  it("treats a missing recovery root on a legacy empty manifest as an empty read-only journal", async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-recovery-legacy-empty-"));
    const ledger = await createLegacyRunLedgerV2({
      repoRoot,
      originalRequest: "Resume a historical run",
    });
    const entriesBefore = await readdir(ledger.runDir);

    const manifest = await reconcileRecoveryJournal(ledger.runDir);

    expect(manifest.recovery).toEqual({ version: 1, active_scope: null, scopes: {} });
    expect(await readdir(ledger.runDir)).toEqual(entriesBefore);
    await expect(access(join(ledger.runDir, "recovery"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects repeated __proto__ observations before any durable write", async () => {
    const ledger = await createRun();
    const value = observation({ runId: ledger.runId, scopeId: "__proto__" });
    const before = await projectionBytes(ledger.runDir);
    const scopesRoot = join(ledger.runDir, "recovery/scopes");
    const scopeEntriesBefore = await readdir(scopesRoot);
    const rejectedScopePath = join(scopesRoot, recoveryScopePathComponent("__proto__"));

    expect(() => recoveryObservationV1Schema.parse(value)).toThrow(/__proto__|scope/i);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(recordRecoveryObservation(recordInput(ledger.runDir, value)))
        .rejects.toThrow(/__proto__|scope/i);
      expect(await projectionBytes(ledger.runDir)).toEqual(before);
      expect(await readdir(scopesRoot)).toEqual(scopeEntriesBefore);
      await expect(access(rejectedScopePath)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("rejects a rehashed __proto__ decision artifact without projecting it", async () => {
    const ledger = await createRun();
    const ordinary = await recordRecoveryObservation(recordInput(
      ledger.runDir,
      observation({ runId: ledger.runId }),
    ));
    const reboundObservation = {
      ...ordinary.decision.observation,
      scope_id: "__proto__",
    };
    reboundObservation.blocker_fingerprint = blockerFingerprint(reboundObservation);
    const artifactPath = recoveryDecisionPath(
      reboundObservation.scope_id,
      1,
      observationId(reboundObservation),
    );
    const reservedDecision: RecoveryDecisionArtifactV1 = {
      ...ordinary.decision,
      scope_id: reboundObservation.scope_id,
      observation: reboundObservation,
      next_state: {
        ...ordinary.decision.next_state,
        head_decision_path: artifactPath,
        blocker_fingerprint: reboundObservation.blocker_fingerprint,
      },
      previous_decision_event_id: ordinary.decision.decision_event_id,
      decision_event_id: decisionEventId(
        reboundObservation,
        ordinary.decision.decision_event_id,
      ),
    };

    expect(() => recoveryDecisionArtifactV1Schema.parse(reservedDecision))
      .toThrow(/__proto__|scope/i);

    const projectionsBefore = await projectionBytes(ledger.runDir);
    const absoluteArtifactPath = join(ledger.runDir, artifactPath);
    await mkdir(dirname(absoluteArtifactPath), { recursive: true });
    await writeFile(absoluteArtifactPath, `${JSON.stringify(reservedDecision, null, 2)}\n`);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(reconcileRecoveryJournal(ledger.runDir)).rejects.toThrow(/__proto__|scope/i);
      expect(await projectionBytes(ledger.runDir)).toEqual(projectionsBefore);
    }
  });

  it.each([
    "constructor",
    "toString",
    "hasOwnProperty",
  ])("records and equally replays a prototype-named %s scope", async (scopeId) => {
    const ledger = await createRun();
    const input = recordInput(
      ledger.runDir,
      observation({ runId: ledger.runId, scopeId }),
    );

    const first = await recordRecoveryObservation(input);
    const replay = await recordRecoveryObservation(input);

    expect(replay).toEqual(first);
    expect(Object.prototype.hasOwnProperty.call(first.manifest.recovery.scopes, scopeId)).toBe(true);
    expect(first.manifest.recovery.scopes[scopeId]).toEqual(first.decision.next_state);
    expect(await decisionPaths(ledger.runDir, scopeId)).toHaveLength(1);
  });

  it.each([
    "constructor",
    "toString",
    "hasOwnProperty",
  ])("reconciles an artifact-only crash for prototype-named %s scope", async (scopeId) => {
    const ledger = await createRun();
    const value = observation({ runId: ledger.runId, scopeId });
    const sentinel = new Error(`sentinel:${scopeId}`);

    await expect(recordRecoveryObservation({
      ...recordInput(ledger.runDir, value),
      hooks: { afterDecisionArtifact: async () => { throw sentinel; } },
    })).rejects.toBe(sentinel);

    const reconciled = await reconcileRecoveryJournal(ledger.runDir);
    const [path] = await decisionPaths(ledger.runDir, scopeId);
    const decision = await readDecision(path);
    expect(Object.prototype.hasOwnProperty.call(reconciled.recovery.scopes, scopeId)).toBe(true);
    expect(reconciled.recovery.scopes[scopeId]).toEqual(decision.next_state);
    expect(reconciled.recovery.active_scope).toBe(scopeId);
  });

  it("chains constructor, toString, and hasOwnProperty as distinct recovery scopes", async () => {
    const ledger = await createRun();
    const recorded = [];
    for (const [index, scopeId] of ["constructor", "toString", "hasOwnProperty"].entries()) {
      recorded.push(await recordRecoveryObservation(recordInput(
        ledger.runDir,
        observation({
          runId: ledger.runId,
          attemptId: `attempt-${index + 1}`,
          scopeId,
        }),
      )));
    }

    expect(recorded.map(({ decision }) => decision.previous_decision_event_id)).toEqual([
      null,
      recorded[0].decision.decision_event_id,
      recorded[1].decision.decision_event_id,
    ]);
    expect(recorded[2].manifest.recovery.active_scope).toBe("hasOwnProperty");
    for (const { decision } of recorded) {
      expect(Object.prototype.hasOwnProperty.call(
        recorded[2].manifest.recovery.scopes,
        decision.scope_id,
      )).toBe(true);
      expect(recorded[2].manifest.recovery.scopes[decision.scope_id]).toEqual(decision.next_state);
    }
  });

  it("replays one effect attempt without allocating or changing its timestamp", async () => {
    const ledger = await createRun();
    const input = recordInput(ledger.runDir, observation({ runId: ledger.runId }));

    const first = await recordRecoveryObservation(input);
    const replay = await recordRecoveryObservation(input);

    expect(replay.artifact_path).toBe(first.artifact_path);
    expect(replay.decision).toEqual(first.decision);
    expect(replay.decision.recorded_at).toBe(first.decision.recorded_at);
    expect(replay.decision.previous_decision_event_id)
      .toBe(first.decision.previous_decision_event_id);
    expect(replay.manifest.recovery.scopes["work-item:item-1"]?.head_sequence).toBe(1);
    expect(await decisionPaths(ledger.runDir)).toHaveLength(1);
    expect((await eventRecords(ledger.runDir)).filter((event) =>
      event.event_id === first.decision.decision_event_id)).toHaveLength(1);
  });

  it("rejects conflicting same-attempt replay bytes", async () => {
    const ledger = await createRun();
    const firstObservation = observation({ runId: ledger.runId });
    await recordRecoveryObservation(recordInput(ledger.runDir, firstObservation));
    const conflict = observation({
      runId: ledger.runId,
      attemptId: firstObservation.effect_attempt_id,
      blockerCode: "different_failure",
    });

    await expect(recordRecoveryObservation(recordInput(ledger.runDir, conflict)))
      .rejects.toThrow(/same.*attempt|replay|conflict/i);
    expect(await decisionPaths(ledger.runDir)).toHaveLength(1);
  });

  it("rejects on-disk decision bytes that conflict with same-attempt replay", async () => {
    const ledger = await createRun();
    const value = observation({ runId: ledger.runId });
    const first = await recordRecoveryObservation(recordInput(ledger.runDir, value));
    const path = join(ledger.runDir, first.artifact_path);
    const tampered = JSON.parse(await readFile(path, "utf8"));
    tampered.requested_effect_reason = "tampered_reason";
    await writeFile(path, `${JSON.stringify(tampered, null, 2)}\n`);

    await expect(recordRecoveryObservation(recordInput(ledger.runDir, value)))
      .rejects.toThrow(/same.*attempt|replay|conflict/i);
    expect(await decisionPaths(ledger.runDir)).toHaveLength(1);
  });

  it("rejects changed global predecessor and event identity bytes during reconciliation", async () => {
    const ledger = await createRun();
    await recordRecoveryObservation(recordInput(
      ledger.runDir,
      observation({ runId: ledger.runId, attemptId: "attempt-a", scopeId: "scope:A" }),
    ));
    const second = await recordRecoveryObservation(recordInput(
      ledger.runDir,
      observation({ runId: ledger.runId, attemptId: "attempt-b", scopeId: "scope:B" }),
    ));
    const decisionPath = join(ledger.runDir, second.artifact_path);
    const original = await readFile(decisionPath);
    const projectionBefore = await projectionBytes(ledger.runDir);

    const changedPredecessor = JSON.parse(original.toString("utf8"));
    changedPredecessor.previous_decision_event_id = `recovery-decision:${"c".repeat(64)}`;
    await writeFile(decisionPath, `${JSON.stringify(changedPredecessor, null, 2)}\n`);
    await expect(reconcileRecoveryJournal(ledger.runDir)).rejects.toThrow(/event|identity|previous|predecessor/i);
    expect(await projectionBytes(ledger.runDir)).toEqual(projectionBefore);

    await writeFile(decisionPath, original);
    const changedEventId = JSON.parse(original.toString("utf8"));
    changedEventId.decision_event_id = `recovery-decision:${"d".repeat(64)}`;
    await writeFile(decisionPath, `${JSON.stringify(changedEventId, null, 2)}\n`);
    await expect(reconcileRecoveryJournal(ledger.runDir)).rejects.toThrow(/event|identity/i);
    expect(await projectionBytes(ledger.runDir)).toEqual(projectionBefore);
  });

  it("serializes two distinct attempts into contiguous sequences one and two", async () => {
    const ledger = await createRun();
    const [left, right] = await Promise.all([
      recordRecoveryObservation(recordInput(
        ledger.runDir,
        observation({ runId: ledger.runId, attemptId: "attempt-a", blockerCode: "left" }),
      )),
      recordRecoveryObservation(recordInput(
        ledger.runDir,
        observation({ runId: ledger.runId, attemptId: "attempt-b", blockerCode: "right" }),
      )),
    ]);

    expect(new Set([
      left.decision.next_state.head_sequence,
      right.decision.next_state.head_sequence,
    ])).toEqual(new Set([1, 2]));
    expect((await decisionPaths(ledger.runDir)).map((path) => basename(path).slice(0, 6)))
      .toEqual(["000001", "000002"]);
  });

  it("keeps a diagnostic stop schema-valid and bound to Task 4's deterministic path", async () => {
    const ledger = await createRun();
    const first = observation({ runId: ledger.runId, attemptId: "attempt-a" });
    const second = observation({ runId: ledger.runId, attemptId: "attempt-b" });
    await recordRecoveryObservation(recordInput(ledger.runDir, first));
    const result = await recordRecoveryObservation(recordInput(ledger.runDir, second));
    const expectedDiagnostic = `recovery/scopes/${recoveryScopePathComponent(first.scope_id)}/diagnostics/000002.json`;

    expect(result.decision.guard_action).toBe("diagnostic_stop");
    expect(result.decision.next_state).toMatchObject({
      head_sequence: 2,
      diagnostic_path: expectedDiagnostic,
      disposition: "diagnostic_stop",
    });
    expect(() => recoveryDecisionArtifactV1Schema.parse(result.decision)).not.toThrow();
  });

  it("rejects a sequence gap without inventing the missing decision", async () => {
    const ledger = await createRun();
    await recordRecoveryObservation(recordInput(
      ledger.runDir,
      observation({ runId: ledger.runId, attemptId: "attempt-a", blockerCode: "left" }),
    ));
    await recordRecoveryObservation(recordInput(
      ledger.runDir,
      observation({ runId: ledger.runId, attemptId: "attempt-b", blockerCode: "right" }),
    ));
    const [first] = await decisionPaths(ledger.runDir);
    await rm(first);

    await expect(reconcileRecoveryJournal(ledger.runDir)).rejects.toThrow(/contiguous|sequence|gap/i);
    await expect(access(first)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a foreign-run decision artifact", async () => {
    const first = await createRun("First run");
    const firstResult = await recordRecoveryObservation(recordInput(
      first.runDir,
      observation({ runId: first.runId }),
    ));
    const firstBytes = await readFile(join(first.runDir, firstResult.artifact_path), "utf8");
    const secondRoot = await mkdtemp(join(tmpdir(), "brain-hands-recovery-ledger-foreign-"));
    const second = await createRunLedgerV2({ repoRoot: secondRoot, originalRequest: "Second run" });
    const target = join(second.runDir, firstResult.artifact_path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, firstBytes);

    await expect(reconcileRecoveryJournal(second.runDir)).rejects.toThrow(/foreign|run_id|wrong run/i);
    await rm(secondRoot, { recursive: true, force: true });
  });

  it("rejects a manifest head that names the wrong decision", async () => {
    const ledger = await createRun();
    await recordRecoveryObservation(recordInput(
      ledger.runDir,
      observation({ runId: ledger.runId }),
    ));
    const manifestPath = join(ledger.runDir, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.recovery.scopes["work-item:item-1"].head_decision_path =
      `recovery/scopes/${recoveryScopePathComponent("work-item:item-1")}/decisions/000001-${"f".repeat(64)}.json`;
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

    await expect(reconcileRecoveryJournal(ledger.runDir)).rejects.toThrow(/manifest|pointer|head|decision path/i);
  });

  it("rejects symlinks and unsupported entries in scope-owned journal directories", async () => {
    const ledger = await createRun();
    const component = recoveryScopePathComponent("work-item:item-1");
    const scopeRoot = join(ledger.runDir, "recovery/scopes", component);
    const outside = join(repoRoot!, "outside-decisions");
    await mkdir(scopeRoot, { recursive: true });
    await mkdir(outside);
    await symlink(outside, join(scopeRoot, "decisions"));

    await expect(reconcileRecoveryJournal(ledger.runDir)).rejects.toThrow(/symlink|symbolic/i);

    await rm(join(scopeRoot, "decisions"));
    await writeFile(join(scopeRoot, "unsupported.txt"), "not a journal directory\n");
    await expect(reconcileRecoveryJournal(ledger.runDir)).rejects.toThrow(/unsupported|directory|entry/i);
  });

  it("accepts only genuinely empty reserved namespaces as crash remnants", async () => {
    const ledger = await createRun();
    const scopeRoot = join(
      ledger.runDir,
      "recovery/scopes",
      recoveryScopePathComponent("work-item:crash-remnant"),
    );
    await mkdir(join(scopeRoot, "diagnostics"), { recursive: true });
    await mkdir(join(scopeRoot, "authorizations"));

    const reconciled = await reconcileRecoveryJournal(ledger.runDir);

    expect(reconciled.recovery).toEqual({ version: 1, active_scope: null, scopes: {} });
  });

  it("rejects foreign authorization entries and every diagnostic entry", async () => {
    const ledger = await createRun();
    const scopeRoot = join(
      ledger.runDir,
      "recovery/scopes",
      recoveryScopePathComponent("work-item:item-1"),
    );
    const diagnostics = join(scopeRoot, "diagnostics");
    const authorizations = join(scopeRoot, "authorizations");
    await mkdir(diagnostics, { recursive: true });
    await mkdir(authorizations);

    await symlink(join(repoRoot!, "outside"), join(diagnostics, "nested-link"));
    await expect(reconcileRecoveryJournal(ledger.runDir)).rejects.toThrow(/diagnostics|reserved|empty|unsupported/i);
    await rm(join(diagnostics, "nested-link"));

    await writeFile(join(authorizations, "garbage.bin"), "foreign bytes\n");
    await expect(reconcileRecoveryJournal(ledger.runDir)).rejects.toThrow(/authorizations|reserved|empty|unsupported/i);
    await rm(join(authorizations, "garbage.bin"));

    await mkdir(join(diagnostics, "nested"));
    await writeFile(join(diagnostics, "nested", "garbage.json"), "{}\n");
    await expect(reconcileRecoveryJournal(ledger.runDir)).rejects.toThrow(/diagnostics|reserved|empty|unsupported/i);
  });

  it.skipIf(process.platform === "win32")("rejects unsupported filesystem entries in reserved namespaces", async () => {
    const ledger = await createRun();
    const authorizations = join(
      ledger.runDir,
      "recovery/scopes",
      recoveryScopePathComponent("work-item:item-1"),
      "authorizations",
    );
    await mkdir(authorizations, { recursive: true });
    await execFileAsync("mkfifo", [join(authorizations, "foreign.fifo")]);

    await expect(reconcileRecoveryJournal(ledger.runDir)).rejects.toThrow(/authorizations|reserved|empty|unsupported/i);
  });

  it.each([
    "afterDecisionArtifact",
    "afterDecisionEvent",
    "afterManifestProjection",
  ] as const)("reconciles idempotently after the %s crash hook", async (hook) => {
    const ledger = await createRun();
    const sentinel = new Error(`sentinel:${hook}`);
    const value = observation({ runId: ledger.runId });

    await expect(recordRecoveryObservation({
      ...recordInput(ledger.runDir, value),
      hooks: { [hook]: async () => { throw sentinel; } },
    })).rejects.toBe(sentinel);

    const reconciled = await reconcileRecoveryJournal(ledger.runDir);
    const [path] = await decisionPaths(ledger.runDir);
    const decision = await readDecision(path);
    expect(reconciled.recovery.scopes[value.scope_id]).toEqual(decision.next_state);
    expect(reconciled.recovery.active_scope).toBe(value.scope_id);
    expect((await eventRecords(ledger.runDir)).filter((event) =>
      event.event_id === decision.decision_event_id)).toHaveLength(1);

    const replay = await recordRecoveryObservation(recordInput(ledger.runDir, value));
    expect(replay.decision).toEqual(decision);
    expect(await decisionPaths(ledger.runDir)).toHaveLength(1);
  });

  it.each([
    "afterDecisionArtifact",
    "afterDecisionEvent",
    "afterManifestProjection",
  ] as const)("restores the latest cross-scope projection after the %s crash hook", async (hook) => {
    const ledger = await createRun();
    const first = observation({
      runId: ledger.runId,
      attemptId: "attempt-a",
      scopeId: "work-item:item-a",
    });
    const second = observation({
      runId: ledger.runId,
      attemptId: "attempt-b",
      scopeId: "work-item:item-b",
    });
    await recordRecoveryObservation(recordInput(ledger.runDir, first));
    const sentinel = new Error(`sentinel:${hook}`);
    await expect(recordRecoveryObservation({
      ...recordInput(ledger.runDir, second),
      hooks: { [hook]: async () => { throw sentinel; } },
    })).rejects.toBe(sentinel);

    const reconciled = await reconcileRecoveryJournal(ledger.runDir);
    expect(reconciled.recovery.active_scope).toBe(second.scope_id);
    const manifestAfterFirstReconcile = await readFile(join(ledger.runDir, "manifest.json"));
    const repeated = await reconcileRecoveryJournal(ledger.runDir);
    expect(repeated.recovery.active_scope).toBe(second.scope_id);
    expect(await readFile(join(ledger.runDir, "manifest.json"))).toEqual(manifestAfterFirstReconcile);
  });

  it("repairs active_scope from durable cross-scope decision event order", async () => {
    const ledger = await createRun();
    const firstScope = "work-item:item-a";
    const secondScope = "work-item:item-b";
    await recordRecoveryObservation(recordInput(
      ledger.runDir,
      observation({ runId: ledger.runId, attemptId: "attempt-a", scopeId: firstScope }),
    ));
    await recordRecoveryObservation(recordInput(
      ledger.runDir,
      observation({ runId: ledger.runId, attemptId: "attempt-b", scopeId: secondScope }),
    ));
    const manifestPath = join(ledger.runDir, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.recovery.active_scope = firstScope;
    manifest.last_blocker = "preserve this unrelated field";
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
    const eventBytes = await readFile(join(ledger.runDir, "events.jsonl"));

    const reconciled = await reconcileRecoveryJournal(ledger.runDir);

    expect(reconciled.recovery.active_scope).toBe(secondScope);
    expect(reconciled.last_blocker).toBe("preserve this unrelated field");
    expect(await readFile(join(ledger.runDir, "events.jsonl"))).toEqual(eventBytes);
    const repairedBytes = await readFile(manifestPath);
    expect((await reconcileRecoveryJournal(ledger.runDir)).recovery.active_scope).toBe(secondScope);
    expect(await readFile(manifestPath)).toEqual(repairedBytes);
  });

  it("rejects inconsistent per-scope decision event order", async () => {
    const ledger = await createRun();
    await recordRecoveryObservation(recordInput(
      ledger.runDir,
      observation({ runId: ledger.runId, attemptId: "attempt-a" }),
    ));
    await recordRecoveryObservation(recordInput(
      ledger.runDir,
      observation({ runId: ledger.runId, attemptId: "attempt-b", blockerCode: "second" }),
    ));
    const eventsPath = join(ledger.runDir, "events.jsonl");
    const lines = (await readFile(eventsPath, "utf8")).trim().split("\n");
    await writeFile(eventsPath, `${lines.reverse().join("\n")}\n`);

    await expect(reconcileRecoveryJournal(ledger.runDir)).rejects.toThrow(/event.*order|order.*event|sequence/i);
  });

  it("rejects a fully rehashed global chain that reverses one scope journal", async () => {
    const ledger = await createRun();
    const recorded = [];
    for (const [attemptId, blockerCode, scopeId] of [
      ["attempt-a1", "blocker-a1", "scope:A"],
      ["attempt-a2", "blocker-a2", "scope:A"],
      ["attempt-b1", "blocker-b1", "scope:B"],
    ] as const) {
      recorded.push(await recordRecoveryObservation(recordInput(
        ledger.runDir,
        observation({ runId: ledger.runId, attemptId, blockerCode, scopeId }),
      )));
    }

    const [a1, a2, b1] = recorded;
    const rewrittenA2 = {
      ...a2.decision,
      previous_decision_event_id: null,
      decision_event_id: decisionEventId(a2.decision.observation, null),
    };
    const rewrittenA1 = {
      ...a1.decision,
      previous_decision_event_id: rewrittenA2.decision_event_id,
      decision_event_id: decisionEventId(a1.decision.observation, rewrittenA2.decision_event_id),
    };
    const rewrittenB1 = {
      ...b1.decision,
      previous_decision_event_id: rewrittenA1.decision_event_id,
      decision_event_id: decisionEventId(b1.decision.observation, rewrittenA1.decision_event_id),
    };
    for (const [result, decision] of [
      [a1, rewrittenA1],
      [a2, rewrittenA2],
      [b1, rewrittenB1],
    ] as const) {
      expect(() => recoveryDecisionArtifactV1Schema.parse(decision)).not.toThrow();
      await writeFile(join(ledger.runDir, result.artifact_path), `${JSON.stringify(decision, null, 2)}\n`);
    }

    const existingEvents = await eventRecords(ledger.runDir);
    const byScopeSequence = new Map(existingEvents.map((event) => [
      `${String((event.payload as Record<string, unknown>).scope_id)}:${String((event.payload as Record<string, unknown>).sequence)}`,
      event,
    ]));
    const rewrittenEvents = [rewrittenA2, rewrittenA1, rewrittenB1].map((decision) => ({
      ...byScopeSequence.get(`${decision.scope_id}:${decision.sequence}`)!,
      event_id: decision.decision_event_id,
    }));
    await writeFile(
      join(ledger.runDir, "events.jsonl"),
      `${rewrittenEvents.map((event) => JSON.stringify(event)).join("\n")}\n`,
    );
    const before = await projectionBytes(ledger.runDir);

    await expect(reconcileRecoveryJournal(ledger.runDir)).rejects.toThrow(/scope.*order|sequence|subsequence/i);
    expect(await projectionBytes(ledger.runDir)).toEqual(before);
    await expect(reconcileRecoveryJournal(ledger.runDir)).rejects.toThrow(/scope.*order|sequence|subsequence/i);
    expect(await projectionBytes(ledger.runDir)).toEqual(before);
  });

  it.each([
    { label: "A1/B1", scopes: ["scope:A", "scope:B"], order: [1, 0] },
    { label: "A/B/A", scopes: ["scope:A", "scope:B", "scope:A"], order: [1, 0, 2] },
  ])("rejects exact cross-scope event reordering for $label without manifest mutation", async ({ scopes, order }) => {
    const ledger = await createRun();
    for (let index = 0; index < scopes.length; index += 1) {
      await recordRecoveryObservation(recordInput(
        ledger.runDir,
        observation({
          runId: ledger.runId,
          attemptId: `attempt-${index}`,
          blockerCode: `blocker-${index}`,
          scopeId: scopes[index],
        }),
      ));
    }
    const valid = await projectionBytes(ledger.runDir);
    await reconcileRecoveryJournal(ledger.runDir);
    expect(await projectionBytes(ledger.runDir)).toEqual(valid);
    await reorderRecoveryEvents(ledger.runDir, order);
    const before = await projectionBytes(ledger.runDir);

    await expect(reconcileRecoveryJournal(ledger.runDir)).rejects.toThrow(/event.*order|chain|predecessor/i);

    expect(await projectionBytes(ledger.runDir)).toEqual(before);
  });

  it("globally chains concurrent cross-scope records and rejects their exact event reordering", async () => {
    const ledger = await createRun();
    const [left, right] = await Promise.all([
      recordRecoveryObservation(recordInput(
        ledger.runDir,
        observation({ runId: ledger.runId, attemptId: "attempt-a", scopeId: "scope:A" }),
      )),
      recordRecoveryObservation(recordInput(
        ledger.runDir,
        observation({ runId: ledger.runId, attemptId: "attempt-b", scopeId: "scope:B" }),
      )),
    ]);
    const decisions = [left.decision, right.decision];
    const root = decisions.find((decision) => decision.previous_decision_event_id === null);
    const tail = decisions.find((decision) => decision.previous_decision_event_id !== null);
    expect(root).toBeDefined();
    expect(tail?.previous_decision_event_id).toBe(root?.decision_event_id);
    const valid = await projectionBytes(ledger.runDir);
    await reconcileRecoveryJournal(ledger.runDir);
    expect(await projectionBytes(ledger.runDir)).toEqual(valid);

    await reorderRecoveryEvents(ledger.runDir, [1, 0]);
    const before = await projectionBytes(ledger.runDir);
    await expect(reconcileRecoveryJournal(ledger.runDir)).rejects.toThrow(/event.*order|chain|predecessor/i);
    expect(await projectionBytes(ledger.runDir)).toEqual(before);
  });

  it.each([1, 2, 3])(
    "handles same-scope journal/event staleness distance %i without partial projection writes",
    async (distance) => {
      const ledger = await createRun();
      const snapshots: Array<{ events: Buffer; manifest: Buffer }> = [];
      for (let index = 0; index < 4; index += 1) {
        await recordRecoveryObservation(recordInput(
          ledger.runDir,
          observation({
            runId: ledger.runId,
            attemptId: `attempt-${index}`,
            blockerCode: `blocker-${index}`,
          }),
        ));
        snapshots.push(await projectionBytes(ledger.runDir));
      }
      await writeProjectionBytes(ledger.runDir, snapshots[3 - distance]);
      const before = await projectionBytes(ledger.runDir);

      if (distance === 1) {
        const reconciled = await reconcileRecoveryJournal(ledger.runDir);
        expect(reconciled.recovery.scopes["work-item:item-1"]?.head_sequence).toBe(4);
        const repaired = await projectionBytes(ledger.runDir);
        expect(repaired).not.toEqual(before);
        await reconcileRecoveryJournal(ledger.runDir);
        expect(await projectionBytes(ledger.runDir)).toEqual(repaired);
      } else {
        await expect(reconcileRecoveryJournal(ledger.runDir)).rejects.toThrow(/immediate|one|stale|sequence/i);
        expect(await projectionBytes(ledger.runDir)).toEqual(before);
        await expect(reconcileRecoveryJournal(ledger.runDir)).rejects.toThrow(/immediate|one|stale|sequence/i);
        expect(await projectionBytes(ledger.runDir)).toEqual(before);
      }
    },
  );

  it("rejects recovery repair on an unterminated event record without changing projections", async () => {
    const ledger = await createRun();
    await recordRecoveryObservation(recordInput(
      ledger.runDir,
      observation({ runId: ledger.runId, attemptId: "attempt-a", scopeId: "scope:A" }),
    ));
    const sentinel = new Error("sentinel:afterDecisionArtifact");
    await expect(recordRecoveryObservation({
      ...recordInput(
        ledger.runDir,
        observation({ runId: ledger.runId, attemptId: "attempt-b", scopeId: "scope:B" }),
      ),
      hooks: { afterDecisionArtifact: async () => { throw sentinel; } },
    })).rejects.toBe(sentinel);
    const eventsPath = join(ledger.runDir, "events.jsonl");
    const canonicalEvents = await readFile(eventsPath, "utf8");
    expect(canonicalEvents.endsWith("\n")).toBe(true);
    await writeFile(eventsPath, canonicalEvents.slice(0, -1));
    const before = await projectionBytes(ledger.runDir);

    await expect(reconcileRecoveryJournal(ledger.runDir)).rejects.toThrow(/event.*newline|unterminated|framing/i);
    expect(await projectionBytes(ledger.runDir)).toEqual(before);
    await expect(reconcileRecoveryJournal(ledger.runDir)).rejects.toThrow(/event.*newline|unterminated|framing/i);
    expect(await projectionBytes(ledger.runDir)).toEqual(before);
  });

  it.each(["unterminated", "blank-line", "crlf"] as const)(
    "rejects a new recovery record on %s event framing before artifact writes",
    async (framing) => {
      const ledger = await createRun();
      await recordRecoveryObservation(recordInput(
        ledger.runDir,
        observation({ runId: ledger.runId, attemptId: "attempt-a" }),
      ));
      const eventsPath = join(ledger.runDir, "events.jsonl");
      const canonical = await readFile(eventsPath, "utf8");
      await writeFile(eventsPath, framing === "unterminated"
        ? canonical.slice(0, -1)
        : framing === "blank-line"
          ? canonical.replace("\n", "\n\n")
          : canonical.replaceAll("\n", "\r\n"));
      const before = await recoveryMutationSnapshot(ledger.runDir);

      await expect(recordRecoveryObservation(recordInput(
        ledger.runDir,
        observation({ runId: ledger.runId, attemptId: "attempt-b" }),
      ))).rejects.toThrow(/event|framing|newline|blank|crlf|canonical/i);
      expect(await recoveryMutationSnapshot(ledger.runDir)).toEqual(before);
    },
  );

  it.each([
    { label: "inactive", activeScope: null },
    { label: "active", activeScope: "scope:phantom" },
  ])("rejects an $label zero-head manifest scope without a journal", async ({ activeScope }) => {
    const ledger = await createRun();
    const manifestPath = join(ledger.runDir, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.recovery = {
      version: 1,
      active_scope: activeScope,
      scopes: {
        "scope:phantom": {
          version: 1,
          head_sequence: 0,
          head_decision_path: null,
          blocker_fingerprint: null,
          progress_subject_sha256: null,
          consecutive_without_progress: 0,
          disposition: "active",
          diagnostic_path: null,
          authorization_path: null,
        },
      },
    };
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
    const before = await projectionBytes(ledger.runDir);

    await expect(reconcileRecoveryJournal(ledger.runDir)).rejects.toThrow(/manifest.*scope|missing journal|unjournaled/i);
    expect(await projectionBytes(ledger.runDir)).toEqual(before);
    await expect(reconcileRecoveryJournal(ledger.runDir)).rejects.toThrow(/manifest.*scope|missing journal|unjournaled/i);
    expect(await projectionBytes(ledger.runDir)).toEqual(before);
  });

  it("rejects multiple unprojected scope heads without choosing filesystem order", async () => {
    const ledger = await createRun();
    await recordRecoveryObservation(recordInput(
      ledger.runDir,
      observation({ runId: ledger.runId, attemptId: "attempt-a", scopeId: "work-item:item-a" }),
    ));
    await recordRecoveryObservation(recordInput(
      ledger.runDir,
      observation({ runId: ledger.runId, attemptId: "attempt-b", scopeId: "work-item:item-b" }),
    ));
    const manifestPath = join(ledger.runDir, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.recovery = { version: 1, active_scope: null, scopes: {} };
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
    const before = await readFile(manifestPath);

    await expect(reconcileRecoveryJournal(ledger.runDir)).rejects.toThrow(/multiple.*unprojected|ambiguous/i);
    expect(await readFile(manifestPath)).toEqual(before);
  });

  it("refuses new observations for terminal and abandonment-marked runs", async () => {
    const terminal = await createRun("Terminal run");
    await updateManifestV2(terminal.runDir, { delivery_state: "blocked" });
    await recordTerminalDisposition(terminal.runDir, {
      outcome: "closed_blocked",
      actor: "human",
      reason: "Stop this run",
      residual_risks: [],
    });
    await expect(recordRecoveryObservation(recordInput(
      terminal.runDir,
      observation({ runId: terminal.runId }),
    ))).rejects.toThrow(/terminal|closed_blocked/i);

    const abandonedRoot = await mkdtemp(join(tmpdir(), "brain-hands-recovery-ledger-abandoned-"));
    const abandoned = await createRunLedgerV2({ repoRoot: abandonedRoot, originalRequest: "Abandoned run" });
    await updateManifestV2(abandoned.runDir, {
      abandonment_path: "assurance/abandonment.json",
      assurance_outcome: "abandoned",
      delivery_state: "blocked",
    });
    await expect(recordRecoveryObservation(recordInput(
      abandoned.runDir,
      observation({ runId: abandoned.runId }),
    ))).rejects.toThrow(/abandon/i);
    await rm(abandonedRoot, { recursive: true, force: true });
  });

  it.each([
    {
      label: "abandonment path",
      patch: {
        abandonment_path: "assurance/abandonment.json",
        assurance_outcome: "abandoned" as const,
        delivery_state: "blocked" as const,
      },
    },
    {
      label: "abandoned assurance outcome",
      patch: {
        assurance_outcome: "abandoned" as const,
        delivery_state: "blocked" as const,
      },
    },
  ])("refuses the independent $label signal without recovery side effects", async ({ patch }) => {
    const ledger = await createRun();
    await updateManifestV2(ledger.runDir, patch);
    const manifestBefore = await readFile(join(ledger.runDir, "manifest.json"));
    const eventsBefore = await readFile(join(ledger.runDir, "events.jsonl"));
    const scopesBefore = await readdir(join(ledger.runDir, "recovery/scopes"));

    await expect(recordRecoveryObservation(recordInput(
      ledger.runDir,
      observation({ runId: ledger.runId }),
    ))).rejects.toThrow(/abandon/i);

    expect(await readFile(join(ledger.runDir, "manifest.json"))).toEqual(manifestBefore);
    expect(await readFile(join(ledger.runDir, "events.jsonl"))).toEqual(eventsBefore);
    expect(await readdir(join(ledger.runDir, "recovery/scopes"))).toEqual(scopesBefore);
  });

  it("rejects a manifest projection ahead of its journal and preserves unrelated fields", async () => {
    const ledger = await createRun();
    const result = await recordRecoveryObservation(recordInput(
      ledger.runDir,
      observation({ runId: ledger.runId }),
    ));
    await updateManifestV2(ledger.runDir, { last_blocker: "unrelated field" });
    const reconciled = await reconcileRecoveryJournal(ledger.runDir);
    expect(reconciled.last_blocker).toBe("unrelated field");

    const manifestPath = join(ledger.runDir, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.recovery.scopes["work-item:item-1"] = {
      ...result.decision.next_state,
      head_sequence: 2,
      head_decision_path: `recovery/scopes/${recoveryScopePathComponent("work-item:item-1")}/decisions/000002-${"e".repeat(64)}.json`,
    };
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

    await expect(reconcileRecoveryJournal(ledger.runDir)).rejects.toThrow(/ahead|journal|manifest/i);
  });
});
