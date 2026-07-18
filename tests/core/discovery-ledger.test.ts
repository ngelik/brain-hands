import { appendFile, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  approveDiscoveryBrief,
  discoverySha256,
  readDiscoveryPendingAction,
  readLatestApprovedDiscoveryBrief,
  readVerifiedDiscoveryBrief,
  rejectDiscoveryBrief,
  recordDiscoveryAnswer,
  recordDiscoveryApproaches,
  recordDiscoveryBrief,
  recordDiscoveryQuestion,
  recordDiscoveryReadiness,
  selectDiscoveryApproach,
} from "../../src/core/discovery-ledger.js";
import { createRunLedgerV2, readManifestV2, transitionRun, updateManifestV2 } from "../../src/core/ledger.js";
import type { DiscoveryApproach, DiscoveryBrief, DiscoveryQuestion } from "../../src/core/types.js";

let repoRoot: string | null = null;

afterEach(async () => {
  if (repoRoot) await rm(repoRoot, { recursive: true, force: true });
  repoRoot = null;
});

const question: DiscoveryQuestion = {
  id: "q-001",
  sequence: 1,
  category: "required",
  text: "Should discovery run for every new workflow?",
  choices: [{ id: "every", label: "Every run", description: "Always discover first" }],
  recommended_choice_id: "every",
  recommendation_rationale: "It keeps the durable boundary explicit.",
  rationale: "This changes the workflow boundary.",
  material_effects: ["scope"],
  repository_evidence: ["src/core/run-state.ts"],
  essential_after_soft_limit: null,
};

const questionWithoutRecommendation: DiscoveryQuestion = {
  ...question,
  choices: [],
  recommended_choice_id: null,
  recommendation_rationale: null,
};

const approaches: DiscoveryApproach[] = [
  {
    id: "approach-always",
    title: "Always discover",
    summary: "Run discovery before every plan.",
    tradeoffs: ["Adds one boundary"],
    recommended: true,
    recommendation_rationale: "Produces durable intent.",
  },
  {
    id: "approach-ambiguous",
    title: "Discover when ambiguous",
    summary: "Skip discovery for simple work.",
    tradeoffs: ["Requires a classifier"],
    recommended: false,
    recommendation_rationale: null,
  },
];

const brief: DiscoveryBrief = {
  revision: 1,
  goal: "Persist discovery",
  problem: "Planning currently starts without durable discovery.",
  success_criteria: ["Approval pins exact bytes"],
  constraints: ["Remain backward compatible"],
  decisions: [{ id: "d-001", statement: "Discover every run", source_question_ids: ["q-001"] }],
  assumptions: [],
  selected_approach_id: "approach-always",
  selected_approach_rationale: "It is deterministic.",
  out_of_scope: ["Brain invocation"],
  accepted_risks: [],
  repository_evidence: ["src/core/ledger.ts"],
};

async function createDiscoveryRun() {
  repoRoot = await mkdtemp(join(tmpdir(), "brain-hands-discovery-ledger-"));
  const ledger = await createRunLedgerV2({ repoRoot, originalRequest: "Discover before planning" });
  await transitionRun(ledger.runDir, "preflight", { actor: "test" });
  await transitionRun(ledger.runDir, "brain_discovery", { actor: "test" });
  return ledger;
}

async function createQuestionProvenanceFixture(runDir: string) {
  const path = "discovery/questions/001.json";
  const text = await readFile(join(runDir, path), "utf8");
  return {
    "cycle-001-question-001": {
      cycle: 1,
      sequence: 1,
      question_id: "q-001",
      path,
      sha256: discoverySha256(text),
    },
  };
}

async function recordReadyBrief(runDir: string, value: DiscoveryBrief): Promise<void> {
  await recordDiscoveryReadiness(runDir, {
    outcome: "no_discovery_needed", rationale: "Fixture is fully specified.",
    repository_evidence: ["tests/core/discovery-ledger.test.ts"], approaches: [],
    alternatives_omitted_reason: "No material alternative in this fixture.", brief: value,
  });
  await recordDiscoveryBrief(runDir, value);
}

describe("discovery ledger", () => {
  it("persists explicit null recommendations without controller defaults", async () => {
    const ledger = await createDiscoveryRun();

    await recordDiscoveryQuestion(ledger.runDir, questionWithoutRecommendation);

    expect(JSON.parse(await readFile(join(ledger.runDir, "discovery/questions/001.json"), "utf8")))
      .toEqual(questionWithoutRecommendation);
    expect(await readDiscoveryPendingAction(ledger.runDir)).toMatchObject({
      state: "awaiting_discovery_answer",
      question: questionWithoutRecommendation,
    });
  });

  it("round-trips authored recommendations and reads verified legacy questions without backfill", async () => {
    const ledger = await createDiscoveryRun();
    const legacyRepoRoot = repoRoot;
    const { recommended_choice_id: _choice, recommendation_rationale: _rationale, ...legacyQuestion } = question;

    await recordDiscoveryQuestion(ledger.runDir, legacyQuestion);
    expect(await readFile(join(ledger.runDir, "discovery/questions/001.json"), "utf8"))
      .toBe(`${JSON.stringify(legacyQuestion, null, 2)}\n`);
    const legacyPending = await readDiscoveryPendingAction(ledger.runDir);
    expect(legacyPending).toEqual({
      state: "awaiting_discovery_answer",
      question: legacyQuestion,
      permitted_next_actions: ["answer-discovery", "proceed-discovery"],
    });
    if (legacyPending?.state !== "awaiting_discovery_answer") throw new Error("Expected a pending discovery question");
    expect(legacyPending.question).not.toHaveProperty("recommended_choice_id");
    expect(legacyPending.question).not.toHaveProperty("recommendation_rationale");
    expect(await readFile(join(ledger.runDir, "discovery/pending-action.json"), "utf8"))
      .toBe(`${JSON.stringify(legacyPending, null, 2)}\n`);

    if (legacyRepoRoot) await rm(legacyRepoRoot, { recursive: true, force: true });
    repoRoot = null;
    const authoredLedger = await createDiscoveryRun();
    await recordDiscoveryQuestion(authoredLedger.runDir, question);
    expect(await readFile(join(authoredLedger.runDir, "discovery/questions/001.json"), "utf8"))
      .toBe(`${JSON.stringify(question, null, 2)}\n`);
    const authoredPending = await readDiscoveryPendingAction(authoredLedger.runDir);
    expect(authoredPending).toEqual({
      state: "awaiting_discovery_answer",
      question,
      permitted_next_actions: ["answer-discovery", "proceed-discovery"],
    });
    expect(await readFile(join(authoredLedger.runDir, "discovery/pending-action.json"), "utf8"))
      .toBe(`${JSON.stringify(authoredPending, null, 2)}\n`);
  });

  it("records canonical questions and idempotent matching answers while rejecting stale and conflicting answers", async () => {
    const ledger = await createDiscoveryRun();

    await recordDiscoveryQuestion(ledger.runDir, question);
    expect(await readDiscoveryPendingAction(ledger.runDir)).toEqual({
      state: "awaiting_discovery_answer",
      question,
      permitted_next_actions: ["answer-discovery", "proceed-discovery"],
    });
    const answerPath = join(ledger.runDir, "discovery/answers/001.json");
    await writeFile(answerPath, `${JSON.stringify({ question_id: "q-001", answer: "Every run" }, null, 2)}\n`);
    await recordDiscoveryAnswer(ledger.runDir, "q-001", "  Every run  ");
    await expect(recordDiscoveryAnswer(ledger.runDir, "q-001", "Every run"))
      .rejects.toThrow("Discovery question q-001 is stale");
    await expect(recordDiscoveryAnswer(ledger.runDir, "q-001", "Ambiguous only"))
      .rejects.toThrow("Discovery question q-001 is stale");
    await expect(recordDiscoveryAnswer(ledger.runDir, "q-999", "Every run"))
      .rejects.toThrow("Discovery question q-999 is stale");

    expect(await readFile(join(ledger.runDir, "discovery/questions/001.json"), "utf8"))
      .toBe(`${JSON.stringify(question, null, 2)}\n`);
    expect(JSON.parse(await readFile(join(ledger.runDir, "discovery/answers/001.json"), "utf8")))
      .toEqual({ question_id: "q-001", answer: "Every run" });
    expect((await readManifestV2(ledger.runDir)).discovery).toMatchObject({
      asked_questions: 1,
      answered_questions: 1,
      current_question_id: null,
      question_artifacts: {
        "cycle-001-question-001": {
          cycle: 1,
          sequence: 1,
          question_id: "q-001",
          path: "discovery/questions/001.json",
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      },
      answer_artifacts: {
        "cycle-001-answer-001": {
          cycle: 1,
          sequence: 1,
          question_id: "q-001",
          path: "discovery/answers/001.json",
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      },
    });
  });

  it("fails closed when durable question provenance is missing or its canonical bytes change", async () => {
    const ledger = await createDiscoveryRun();
    await recordDiscoveryQuestion(ledger.runDir, question);
    const manifestPath = join(ledger.runDir, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.discovery.question_artifacts = {};
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

    await expect(readDiscoveryPendingAction(ledger.runDir)).rejects.toThrow(/provenance|recorded/i);

    manifest.discovery.question_artifacts = (await createQuestionProvenanceFixture(ledger.runDir));
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
    await writeFile(
      join(ledger.runDir, "discovery/questions/001.json"),
      `${JSON.stringify({ ...question, text: "Changed after recording?" }, null, 2)}\n`,
    );
    await expect(readDiscoveryPendingAction(ledger.runDir)).rejects.toThrow(/digest|canonical|provenance/i);
  });

  it("rejects duplicate and wrong-run discovery events instead of overwriting them", async () => {
    const ledger = await createDiscoveryRun();
    await recordDiscoveryQuestion(ledger.runDir, question);
    const eventsPath = join(ledger.runDir, "events.jsonl");
    const original = await readFile(eventsPath, "utf8");
    const questionEvent = original.split("\n").filter(Boolean).find((line) => line.includes('"type":"discovery_question_recorded"'))!;
    await writeFile(eventsPath, `${original}${questionEvent}\n`);
    await expect(readDiscoveryPendingAction(ledger.runDir)).rejects.toThrow(/duplicate|exactly one|immutable event/i);
    const wrongRun = JSON.stringify({ ...JSON.parse(questionEvent), event_id: "wrong-run-event", run_id: "wrong-run" });
    await writeFile(eventsPath, `${original}${wrongRun}\n`);
    await expect(readDiscoveryPendingAction(ledger.runDir)).rejects.toThrow(/run_id|wrong run|immutable event/i);
  });

  it("rejects a schema-only brief that has no exact immutable readiness outcome", async () => {
    const ledger = await createDiscoveryRun();
    await expect(recordDiscoveryBrief(ledger.runDir, { ...brief, decisions: [] }))
      .rejects.toThrow(/readiness/i);
  });

  it.each(["discovery", "discovery/briefs"])(
    "rejects approved-brief reads through a symlinked %s path component",
    async (component) => {
      const ledger = await createDiscoveryRun();
      await recordReadyBrief(ledger.runDir, { ...brief, decisions: [] });
      await approveDiscoveryBrief(ledger.runDir, 1);
      const outside = join(repoRoot!, `outside-${component.replace("/", "-")}`);
      await mkdir(outside, { recursive: true });
      const source = join(ledger.runDir, component);
      const saved = `${source}-saved`;
      await rename(source, saved);
      await symlink(outside, source);

      await expect(readVerifiedDiscoveryBrief(ledger.runDir)).rejects.toThrow(/symlink|owned/i);
    },
  );

  it("rejects stale selections and stale brief approvals", async () => {
    const ledger = await createDiscoveryRun();
    await recordDiscoveryApproaches(ledger.runDir, 1, approaches);

    expect(await readDiscoveryPendingAction(ledger.runDir)).toMatchObject({
      permitted_next_actions: ["select-discovery-approach"],
    });

    await expect(selectDiscoveryApproach(ledger.runDir, 2, "approach-always"))
      .rejects.toThrow("Discovery approaches revision 2 is stale");
    await expect(readFile(
      join(ledger.runDir, "discovery/approaches/revision-002-selection.json"),
      "utf8",
    )).rejects.toMatchObject({ code: "ENOENT" });
    await selectDiscoveryApproach(ledger.runDir, 1, "approach-always");
    await expect(recordDiscoveryBrief(ledger.runDir, {
      ...brief,
      selected_approach_id: null,
      selected_approach_rationale: null,
    })).rejects.toThrow("does not use the selected approach");
    await recordReadyBrief(ledger.runDir, { ...brief, decisions: [] });
    expect(await readDiscoveryPendingAction(ledger.runDir)).toMatchObject({
      permitted_next_actions: ["approve-discovery", "revise-discovery"],
    });
    await expect(approveDiscoveryBrief(ledger.runDir, 2))
      .rejects.toThrow("Discovery brief revision 2 is stale");
    await expect(readFile(join(ledger.runDir, "discovery/approved-brief.json"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves immutable approach revisions and records each selection", async () => {
    const ledger = await createDiscoveryRun();
    await recordDiscoveryApproaches(ledger.runDir, 1, approaches);
    const firstApproachArtifact = JSON.parse(await readFile(
      join(ledger.runDir, "discovery/approaches/revision-001.json"),
      "utf8",
    )) as { revision: number; approaches: DiscoveryApproach[] };
    expect(firstApproachArtifact).toEqual({ revision: 1, approaches });
    expect(await readFile(join(ledger.runDir, "discovery/approaches/revision-001.json"), "utf8"))
      .toBe(`${JSON.stringify({ revision: 1, approaches }, null, 2)}\n`);
    const recommended = firstApproachArtifact.approaches.filter((approach) => approach.recommended);
    expect(recommended).toHaveLength(1);
    expect(recommended[0]).toMatchObject({
      id: "approach-always",
      recommendation_rationale: "Produces durable intent.",
    });
    expect(await readDiscoveryPendingAction(ledger.runDir)).toEqual({
      state: "awaiting_discovery_approach",
      revision: 1,
      approaches,
      permitted_next_actions: ["select-discovery-approach"],
    });
    await selectDiscoveryApproach(ledger.runDir, 1, "approach-always");
    await recordDiscoveryApproaches(ledger.runDir, 2, approaches);
    await selectDiscoveryApproach(ledger.runDir, 2, "approach-ambiguous");

    expect(JSON.parse(await readFile(
      join(ledger.runDir, "discovery/approaches/revision-001.json"),
      "utf8",
    ))).toEqual({ revision: 1, approaches });
    expect(JSON.parse(await readFile(
      join(ledger.runDir, "discovery/approaches/revision-002.json"),
      "utf8",
    ))).toEqual({ revision: 2, approaches });
    expect(JSON.parse(await readFile(
      join(ledger.runDir, "discovery/approaches/revision-001-selection.json"),
      "utf8",
    ))).toEqual({ revision: 1, approach_id: "approach-always" });
    expect(JSON.parse(await readFile(
      join(ledger.runDir, "discovery/approaches/revision-002-selection.json"),
      "utf8",
    ))).toEqual({ revision: 2, approach_id: "approach-ambiguous" });
  });

  it("pins approved canonical brief bytes and detects later byte changes", async () => {
    const ledger = await createDiscoveryRun();
    const canonicalBrief = { ...brief, decisions: [] };
    await recordDiscoveryApproaches(ledger.runDir, 1, approaches);
    await selectDiscoveryApproach(ledger.runDir, 1, "approach-always");
    await recordReadyBrief(ledger.runDir, canonicalBrief);
    const briefPath = join(ledger.runDir, "discovery/briefs/revision-001.json");
    await writeFile(briefPath, `${JSON.stringify({ ...canonicalBrief, goal: "Changed" }, null, 2)}\n`);
    await expect(approveDiscoveryBrief(ledger.runDir, 1)).rejects.toThrow("digest does not match");
    await writeFile(briefPath, `${JSON.stringify(canonicalBrief, null, 2)}\n`);
    await approveDiscoveryBrief(ledger.runDir, 1);
    expect((await readManifestV2(ledger.runDir)).stage).toBe("brain_planning");

    expect(await readVerifiedDiscoveryBrief(ledger.runDir)).toEqual(canonicalBrief);
    expect(await readFile(join(ledger.runDir, "discovery/approved-brief.json"), "utf8"))
      .toBe(`${JSON.stringify(canonicalBrief, null, 2)}\n`);
    const manifest = await readManifestV2(ledger.runDir);
    expect(JSON.parse(await readFile(
      join(ledger.runDir, "discovery/briefs/revision-001-approval.json"),
      "utf8",
    ))).toEqual({
      revision: 1,
      sha256: manifest.discovery?.approved_brief_sha256,
      readiness_revision: manifest.discovery?.current_readiness_revision,
      readiness_sha256: manifest.discovery?.readiness_revisions["1"]?.sha256,
    });
    await approveDiscoveryBrief(ledger.runDir, 1);
    const approvedBriefPath = join(ledger.runDir, "discovery/approved-brief.json");
    await writeFile(approvedBriefPath, `${JSON.stringify({ ...canonicalBrief, goal: "Changed approval" }, null, 2)}\n`);
    await expect(readVerifiedDiscoveryBrief(ledger.runDir)).rejects.toThrow("digest does not match");
    await writeFile(approvedBriefPath, `${JSON.stringify(canonicalBrief, null, 2)}\n`);
    await writeFile(briefPath, `${JSON.stringify({ ...canonicalBrief, goal: "Changed" }, null, 2)}\n`);
    await expect(readVerifiedDiscoveryBrief(ledger.runDir)).rejects.toThrow("digest does not match");
  });

  it("idempotently reapproves a question-backed brief without rewriting approval state", async () => {
    const ledger = await createDiscoveryRun();
    await recordDiscoveryQuestion(ledger.runDir, question);
    await recordDiscoveryAnswer(ledger.runDir, "q-001", "Every run");
    await recordReadyBrief(ledger.runDir, brief);
    await approveDiscoveryBrief(ledger.runDir, 1);
    const manifestBefore = await readFile(join(ledger.runDir, "manifest.json"), "utf8");
    const approvalPath = join(ledger.runDir, "discovery/briefs/revision-001-approval.json");
    const approvalBefore = await readFile(approvalPath, "utf8");

    await expect(approveDiscoveryBrief(ledger.runDir, 1)).resolves.toBeDefined();

    expect(await readFile(join(ledger.runDir, "manifest.json"), "utf8")).toBe(manifestBefore);
    expect(await readFile(approvalPath, "utf8")).toBe(approvalBefore);
  });

  it("requires the approved brief to retain its exact readiness approval artifact", async () => {
    const ledger = await createDiscoveryRun();
    const canonicalBrief = { ...brief, decisions: [] };
    await recordReadyBrief(ledger.runDir, canonicalBrief);
    await approveDiscoveryBrief(ledger.runDir, 1);
    const approvalPath = join(ledger.runDir, "discovery/briefs/revision-001-approval.json");
    const approvalText = await readFile(approvalPath, "utf8");
    const approval = JSON.parse(approvalText);
    await writeFile(approvalPath, `${JSON.stringify({ ...approval, readiness_sha256: "0".repeat(64) }, null, 2)}\n`);
    await expect(readVerifiedDiscoveryBrief(ledger.runDir)).rejects.toThrow(/approval|readiness/i);
    await writeFile(approvalPath, approvalText);
    const manifest = await readManifestV2(ledger.runDir);
    await updateManifestV2(ledger.runDir, { discovery: { ...manifest.discovery!, current_readiness_revision: null } });
    await expect(readVerifiedDiscoveryBrief(ledger.runDir)).rejects.toThrow(/approval|readiness/i);
    await updateManifestV2(ledger.runDir, { discovery: manifest.discovery });
    await rm(approvalPath);
    await expect(readVerifiedDiscoveryBrief(ledger.runDir)).rejects.toThrow(/approval|missing/i);
  });

  it.each(["duplicate", "conflicting", "wrong-run"])(
    "rejects a %s current approval event for the same revision",
    async (mutation) => {
      const ledger = await createDiscoveryRun();
      const canonicalBrief = { ...brief, decisions: [] };
      await recordReadyBrief(ledger.runDir, canonicalBrief);
      await approveDiscoveryBrief(ledger.runDir, 1);
      const eventsPath = join(ledger.runDir, "events.jsonl");
      const approvalEvent = (await readFile(eventsPath, "utf8")).split("\n").filter(Boolean)
        .map((line) => JSON.parse(line)).find((event) => event.type === "discovery_brief_approved");
      const extra = mutation === "duplicate" ? approvalEvent
        : mutation === "wrong-run" ? { ...approvalEvent, event_id: "wrong-run-approval", run_id: "wrong-run" }
          : { ...approvalEvent, event_id: "conflicting-approval", payload: { ...approvalEvent.payload, readiness_sha256: "0".repeat(64) } };
      await appendFile(eventsPath, `${JSON.stringify(extra)}\n`);

      await expect(readVerifiedDiscoveryBrief(ledger.runDir)).rejects.toThrow(/approval|run_id|immutable event/i);
    },
  );

  it.each(["current", "prior"])("rejects a string revision in a %s approval event", async (scope) => {
    const ledger = await createDiscoveryRun();
    const canonicalBrief = { ...brief, decisions: [] };
    await recordReadyBrief(ledger.runDir, canonicalBrief);
    await approveDiscoveryBrief(ledger.runDir, 1);
    const eventsPath = join(ledger.runDir, "events.jsonl");
    const events = (await readFile(eventsPath, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const approval = events.find((event) => event.type === "discovery_brief_approved");
    approval.payload.revision = "1";
    await writeFile(eventsPath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
    if (scope === "current") {
      await expect(readVerifiedDiscoveryBrief(ledger.runDir)).rejects.toThrow(/approval|revision|event/i);
    } else {
      const manifest = await readManifestV2(ledger.runDir);
      await expect(readLatestApprovedDiscoveryBrief(ledger.runDir, manifest.discovery!, 2))
        .rejects.toThrow(/approval|revision|event/i);
    }
  });

  it.each(["current", "prior"])(
    "rejects an extra malformed approval revision beside a valid %s approval event",
    async (scope) => {
      const ledger = await createDiscoveryRun();
      const canonicalBrief = { ...brief, decisions: [] };
      await recordReadyBrief(ledger.runDir, canonicalBrief);
      await approveDiscoveryBrief(ledger.runDir, 1);
      const eventsPath = join(ledger.runDir, "events.jsonl");
      const approval = (await readFile(eventsPath, "utf8")).split("\n").filter(Boolean)
        .map((line) => JSON.parse(line)).find((event) => event.type === "discovery_brief_approved");
      await appendFile(eventsPath, `${JSON.stringify({
        ...approval,
        event_id: `malformed-${scope}-approval`,
        payload: { ...approval.payload, revision: "1" },
      })}\n`);
      if (scope === "current") {
        await expect(readVerifiedDiscoveryBrief(ledger.runDir)).rejects.toThrow(/approval|revision|event/i);
      } else {
        const manifest = await readManifestV2(ledger.runDir);
        await expect(readLatestApprovedDiscoveryBrief(ledger.runDir, manifest.discovery!, 2))
          .rejects.toThrow(/approval|revision|event/i);
      }
    },
  );

  it.each(["duplicate", "conflicting", "wrong-run", "readiness-tamper"])(
    "rejects %s provenance while loading a prior approved brief",
    async (mutation) => {
      const ledger = await createDiscoveryRun();
      const canonicalBrief = { ...brief, decisions: [] };
      await recordReadyBrief(ledger.runDir, canonicalBrief);
      await approveDiscoveryBrief(ledger.runDir, 1);
      const eventsPath = join(ledger.runDir, "events.jsonl");
      const approvalEvent = (await readFile(eventsPath, "utf8")).split("\n").filter(Boolean)
        .map((line) => JSON.parse(line)).find((event) => event.type === "discovery_brief_approved");
      if (mutation === "readiness-tamper") {
        const approvalPath = join(ledger.runDir, "discovery/briefs/revision-001-approval.json");
        const approval = JSON.parse(await readFile(approvalPath, "utf8"));
        await writeFile(approvalPath, `${JSON.stringify({ ...approval, readiness_sha256: "0".repeat(64) }, null, 2)}\n`);
      } else {
        const extra = mutation === "duplicate" ? approvalEvent
          : mutation === "wrong-run" ? { ...approvalEvent, event_id: "wrong-run-prior-approval", run_id: "wrong-run" }
            : { ...approvalEvent, event_id: "conflicting-prior-approval", payload: { ...approvalEvent.payload, sha256: "0".repeat(64) } };
        await appendFile(eventsPath, `${JSON.stringify(extra)}\n`);
      }
      const manifest = await readManifestV2(ledger.runDir);

      await expect(readLatestApprovedDiscoveryBrief(ledger.runDir, manifest.discovery!, 2))
        .rejects.toThrow(/approval|readiness|run_id|immutable event/i);
    },
  );

  it("records brief rejection without deleting the immutable revision", async () => {
    const ledger = await createDiscoveryRun();
    const noAlternativesBrief = { ...brief, decisions: [], selected_approach_id: null, selected_approach_rationale: null };
    await recordReadyBrief(ledger.runDir, noAlternativesBrief);
    await rejectDiscoveryBrief(ledger.runDir, 1, "Clarify the success criteria");

    expect((await readManifestV2(ledger.runDir))).toMatchObject({
      stage: "brain_discovery",
      discovery: { current_brief_revision: null, approved_brief_revision: null },
    });
    expect(JSON.parse(await readFile(join(ledger.runDir, "discovery/briefs/revision-001.json"), "utf8")))
      .toEqual(noAlternativesBrief);
    expect(JSON.parse(await readFile(
      join(ledger.runDir, "discovery/briefs/revision-001-rejection.json"),
      "utf8",
    ))).toEqual({ revision: 1, reason: "Clarify the success criteria" });
  });
});
