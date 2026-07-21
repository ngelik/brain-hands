import { Buffer } from "node:buffer";
import { z } from "zod";
import type { ReasoningEffort } from "../core/types.js";
import type { ProgressIntent } from "./events.js";
import type { ProgressReporter } from "./log.js";

export const tokenUsageSchema = z.object({
  input_tokens: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  cached_input_tokens: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  output_tokens: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  reasoning_output_tokens: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
}).strip();

export type TokenUsage = z.infer<typeof tokenUsageSchema>;

export interface CodexProgressContext {
  source: "brain" | "hands" | "verifier" | "reflection";
  mode: "planning" | "implementation" | "fix" | "review" | "final_review" | "reflection_account" | "reflection_synthesis";
  model: string;
  reasoningEffort: ReasoningEffort;
  workItem?: { index: number; total: number; attempt: number; final: boolean };
  workerSessionId?: string;
  workerPid?: number;
  childPid?: number;
  modelInvocationId?: string;
}

export interface CodexProgressConsumer {
  write(chunk: string): Promise<void>;
  end(): Promise<void>;
  terminalUsage(): TokenUsage | null;
  turnStarted(): boolean;
  structuredTerminalError(): boolean;
  warningCount(): number;
}

function usage(value: unknown): TokenUsage | null {
  const parsed = tokenUsageSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function createCodexProgressConsumer(input: {
  reporter?: ProgressReporter;
  context: CodexProgressContext;
  maxRecordBytes?: number;
}): CodexProgressConsumer {
  const maximum = input.maxRecordBytes ?? 1024 * 1024;
  const emittedPhases = new Set<string>();
  const emittedWarnings = new Set<string>();
  let carry = "";
  let discardingOversized = false;
  let warnings = 0;
  let terminalUsage: TokenUsage | null = null;
  let sawTurnStarted = false;
  let sawStructuredTerminalError = false;

  const emit = async (intent: ProgressIntent, dedupe = true): Promise<void> => {
    if (!input.reporter) return;
    if (dedupe && emittedPhases.has(intent.code)) return;
    if (dedupe) emittedPhases.add(intent.code);
    await input.reporter.emit({
      ...intent,
      workItem: intent.workItem ?? input.context.workItem,
      model: intent.model ?? input.context.model,
      reasoningEffort: intent.reasoningEffort ?? input.context.reasoningEffort,
      workerSessionId: input.context.workerSessionId,
      workerPid: input.context.workerPid,
      childPid: input.context.childPid,
      modelInvocationId: input.context.modelInvocationId,
    });
  };

  const warning = (kind: string): Promise<void> => {
    const key = `${input.context.modelInvocationId ?? "unknown"}:${kind}`;
    if (emittedWarnings.has(key)) return Promise.resolve();
    emittedWarnings.add(key);
    warnings += 1;
    return emit({ code: "progress_warning", source: input.context.source, warningKind: kind }, false);
  };

  const processRecord = async (line: string): Promise<void> => {
    if (Buffer.byteLength(line, "utf8") > maximum) {
      await warning("oversized_record");
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      await warning("malformed_record");
      return;
    }
    if (!parsed || typeof parsed !== "object") return;
    const record = parsed as Record<string, unknown>;
    const type = record.type;
    if (type === "turn.failed" || type === "error") {
      sawStructuredTerminalError = true;
      await emit({ code: "role_failed", source: input.context.source });
      return;
    }
    if (type === "turn.started") sawTurnStarted = true;
    if (type === "turn.started" && input.context.source === "brain") {
      await emit({ code: "planning_started", source: "brain" });
      return;
    }
    if (type === "turn.completed") {
      const code = input.context.source === "brain"
        ? "brain_turn_completed"
        : input.context.source === "hands"
          ? "hands_turn_completed"
          : input.context.source === "verifier"
            ? "verifier_turn_completed"
            : undefined;
      const parsedUsage = usage(record.usage);
      if (parsedUsage !== null) terminalUsage = parsedUsage;
      if (code) await emit({ code, source: input.context.source, usage: parsedUsage ?? undefined });
      return;
    }
    if (type !== "item.started" && type !== "item.updated" && type !== "item.completed") return;
    const item = record.item;
    if (!item || typeof item !== "object") return;
    const itemType = (item as Record<string, unknown>).type;
    if (itemType === "error") {
      await warning("item_error");
      return;
    }
    let code: ProgressIntent["code"] | undefined;
    if (input.context.source === "brain") {
      if (itemType === "command_execution") code = "repository_inspection";
      else if (itemType === "web_search") code = "researching_sources";
      else if (itemType === "reasoning" || itemType === "todo_list") code = "drafting_work_items";
    } else if (input.context.source === "hands") {
      if (itemType === "command_execution") code = "hands_checking";
      else if (itemType === "reasoning" || itemType === "todo_list") code = "hands_working";
      else if (itemType === "file_change") code = input.context.mode === "fix" ? "hands_applying_fixes" : "hands_applying";
    } else if (input.context.source === "verifier") {
      if (itemType === "command_execution") code = "verifier_inspecting";
      else if (itemType === "reasoning" || itemType === "todo_list") code = "verifier_reviewing";
    } else if (input.context.source === "reflection" && (itemType === "reasoning" || itemType === "todo_list")) {
      code = input.context.mode === "reflection_synthesis" ? "reflection_synthesizing" : "reflection_analyzing";
    }
    if (code) await emit({ code, source: input.context.source });
  };

  const consume = async (final: boolean): Promise<void> => {
    let newline = carry.indexOf("\n");
    while (newline >= 0) {
      const line = carry.slice(0, newline).trimEnd();
      carry = carry.slice(newline + 1);
      if (discardingOversized) discardingOversized = false;
      else if (line.trim()) await processRecord(line);
      newline = carry.indexOf("\n");
    }
    if (final && carry.trim() && !discardingOversized) await processRecord(carry.trimEnd());
    if (final) carry = "";
  };

  return {
    async write(chunk: string): Promise<void> {
      if (discardingOversized) {
        const newline = chunk.indexOf("\n");
        if (newline < 0) return;
        discardingOversized = false;
        carry = chunk.slice(newline + 1);
      } else {
        carry += chunk;
      }
      if (!carry.includes("\n") && Buffer.byteLength(carry, "utf8") > maximum) {
        carry = "";
        discardingOversized = true;
        await warning("oversized_record");
        return;
      }
      await consume(false);
    },
    async end(): Promise<void> { await consume(true); },
    terminalUsage(): TokenUsage | null { return terminalUsage; },
    turnStarted(): boolean { return sawTurnStarted; },
    structuredTerminalError(): boolean { return sawStructuredTerminalError; },
    warningCount(): number { return warnings; },
  };
}
