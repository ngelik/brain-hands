import { describe, expect, it } from "vitest";
import type { ProgressIntent, SafeProgressEvent } from "../../src/progress/events.js";
import { createCodexProgressConsumer } from "../../src/progress/codex.js";
import type { ProgressReporter } from "../../src/progress/log.js";

function recordingReporter(intents: ProgressIntent[]): ProgressReporter {
  return {
    path: "/safe/progress.jsonl",
    sessionId: "4ed9e32e-5787-4aac-9cb0-a531037d4b64",
    workerPid: 36551,
    async emit(intent): Promise<SafeProgressEvent | null> { intents.push(intent); return null; },
  };
}

const workItem = { index: 1, total: 2, attempt: 2, final: false };

describe("Codex progress consumer", () => {
  it("frames split and combined JSONL records and emits fixed Hands phases", async () => {
    const intents: ProgressIntent[] = [];
    const consumer = createCodexProgressConsumer({
      reporter: recordingReporter(intents),
      context: { source: "hands", mode: "fix", model: "luna", reasoningEffort: "xhigh", workItem },
    });

    await consumer.write('{"type":"turn.started"}\n{"type":"item.completed","item":{"type":"reason');
    await consumer.write('ing","text":"private chain"}}\n{"type":"item.completed","item":{"type":"file_change","path":"/secret"}}\n');
    await consumer.write('{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":2,"output_tokens":3,"reasoning_output_tokens":1}}');
    await consumer.end();

    expect(intents.map((intent) => intent.code)).toEqual([
      "hands_working", "hands_applying_fixes", "hands_turn_completed",
    ]);
    expect(intents.every((intent) => intent.model === "luna" && intent.reasoningEffort === "xhigh")).toBe(true);
    expect(intents[2]?.usage).toEqual({ input_tokens: 10, cached_input_tokens: 2, output_tokens: 3, reasoning_output_tokens: 1 });
    expect(JSON.stringify(intents)).not.toContain("private chain");
    expect(JSON.stringify(intents)).not.toContain("/secret");
  });

  it("ignores unknown payloads and replaces malformed or oversized records with generic warnings", async () => {
    const intents: ProgressIntent[] = [];
    const consumer = createCodexProgressConsumer({
      reporter: recordingReporter(intents),
      context: { source: "brain", mode: "planning", model: "brain", reasoningEffort: "high" },
      maxRecordBytes: 80,
    });
    await consumer.write('{"type":"future.event","secret":"sk-secret"}\nnot-json\n');
    await consumer.write(`${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "x".repeat(200) } })}\n`);
    await consumer.end();

    expect(intents.map((intent) => intent.code)).toEqual(["progress_warning", "progress_warning"]);
    expect(JSON.stringify(intents)).not.toContain("sk-secret");
    expect(JSON.stringify(intents)).not.toContain("agent_message");
  });

  it("emits at most one progress warning per invocation and warning kind", async () => {
    const intents: ProgressIntent[] = [];
    const consumer = createCodexProgressConsumer({
      reporter: recordingReporter(intents),
      context: {
        source: "hands",
        mode: "implementation",
        model: "hands",
        reasoningEffort: "high",
        modelInvocationId: "7f05a9d1-7635-4895-88bb-94a56510ca54",
      },
      maxRecordBytes: 80,
    });

    await consumer.write("not-json\nstill-not-json\n");
    await consumer.write(`${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "x".repeat(200) } })}\n`);
    await consumer.write(`${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "y".repeat(200) } })}\n`);
    await consumer.end();

    expect(intents.map((intent) => [intent.code, intent.warningKind])).toEqual([
      ["progress_warning", "malformed_record"],
      ["progress_warning", "oversized_record"],
    ]);
    expect(consumer.warningCount()).toBe(2);
  });

  it("maps top-level failure and item-level error without copying error text", async () => {
    const intents: ProgressIntent[] = [];
    const consumer = createCodexProgressConsumer({
      reporter: recordingReporter(intents),
      context: { source: "verifier", mode: "review", model: "verifier", reasoningEffort: "high", workItem },
    });
    await consumer.write('{"type":"item.completed","item":{"type":"error","message":"token=secret"}}\n');
    await consumer.write('{"type":"turn.failed","error":{"message":"private failure"}}\n');
    await consumer.end();

    expect(intents.map((intent) => intent.code)).toEqual(["progress_warning", "role_failed"]);
    expect(JSON.stringify(intents)).not.toMatch(/secret|private failure/);
  });

  it("retains strict terminal usage and turn/error state independently of progress emission", async () => {
    const consumer = createCodexProgressConsumer({
      context: { source: "hands", mode: "implementation", model: "gpt", reasoningEffort: "high" },
    });

    await consumer.write('{"type":"turn.started"}\n');
    await consumer.write('{"type":"turn.completed","usage":{"input_tokens":11,"cached_input_tokens":3,"output_tokens":5,"reasoning_output_tokens":2}}\n');
    await consumer.end();

    expect(consumer.turnStarted()).toBe(true);
    expect(consumer.structuredTerminalError()).toBe(false);
    expect(consumer.terminalUsage()).toEqual({
      input_tokens: 11,
      cached_input_tokens: 3,
      output_tokens: 5,
      reasoning_output_tokens: 2,
    });
  });

  it("treats malformed terminal usage as uncertain instead of zero", async () => {
    const intents: ProgressIntent[] = [];
    const consumer = createCodexProgressConsumer({
      reporter: recordingReporter(intents),
      context: { source: "brain", mode: "planning", model: "brain", reasoningEffort: "high" },
    });

    await consumer.write('{"type":"turn.started"}\n');
    await consumer.write('{"type":"turn.completed","usage":{"input_tokens":"11","cached_input_tokens":0,"output_tokens":1,"reasoning_output_tokens":0}}\n');
    await consumer.end();

    expect(consumer.turnStarted()).toBe(true);
    expect(consumer.terminalUsage()).toBeNull();
    expect(intents.at(-1)?.usage).toBeUndefined();
  });

  it("distinguishes structured terminal errors before a turn starts", async () => {
    const consumer = createCodexProgressConsumer({
      context: { source: "verifier", mode: "review", model: "verifier", reasoningEffort: "high" },
    });

    await consumer.write('{"type":"error","error":{"message":"private"}}\n');
    await consumer.end();

    expect(consumer.turnStarted()).toBe(false);
    expect(consumer.structuredTerminalError()).toBe(true);
    expect(consumer.terminalUsage()).toBeNull();
  });
});
