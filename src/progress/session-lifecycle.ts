import type { RunManifestV2 } from "../core/types.js";
import { readManifestV2 } from "../core/ledger.js";
import type { ProgressReporter } from "./log.js";
import { finalizeSession } from "./session-store.js";

export const PRODUCING_COMMANDS = [
  "run",
  "answer-discovery",
  "select-discovery-approach",
  "proceed-discovery",
  "approve-discovery",
  "revise-discovery",
  "revise-plan",
  "approve-plan",
  "resume",
  "close-run",
  "abandon",
] as const;
export const PRODUCING_COMMAND_CATALOG = PRODUCING_COMMANDS;

export type ProducingCommand = (typeof PRODUCING_COMMANDS)[number];
export type LifecycleOutcome = "successful" | "blocked" | "failed";

export interface SessionLifecycleInput<TResult> {
  command: ProducingCommand;
  action: () => Promise<TResult>;
  runDir?: string | null | (() => string | null | undefined | Promise<string | null | undefined>);
  progress?: ProgressReporter | null | (() => ProgressReporter | null | undefined | Promise<ProgressReporter | null | undefined>);
  classify?: (result: TResult) => LifecycleOutcome;
  reconcile?: (manifest: RunManifestV2) => Promise<void>;
  reflect?: (manifest: RunManifestV2) => Promise<void>;
  assure?: (manifest: RunManifestV2) => Promise<void>;
  beforeFinalize?: (result: TResult, outcome: LifecycleOutcome) => Promise<void>;
  finalizeWithAuthority?: (operation: () => Promise<void>) => Promise<void>;
  onWarning?: (message: string, error?: unknown) => void | Promise<void>;
}

export interface SessionLifecycleResult<TResult> {
  result: TResult;
  outcome: LifecycleOutcome;
}

const WARNING_ATTEMPT_BUDGET = 1;

type MaybeAsync<T> = T | null | undefined | Promise<T | null | undefined>;

async function resolveValue<T>(value: MaybeAsync<T> | (() => MaybeAsync<T>)): Promise<T | null | undefined> {
  if (typeof value === "function") return (value as () => MaybeAsync<T>)();
  return value;
}

/**
 * Run one CLI-producing command and record its bounded command lifecycle.
 *
 * The command callback owns workflow authority. Session telemetry and canonical
 * finalization are observational and therefore never replace a workflow result
 * or the original exception object.
 */
export async function runProducingCommand<TResult>(
  input: SessionLifecycleInput<TResult>,
): Promise<TResult> {
  let warningAttempts = 0;
  const warn = async (message: string, error?: unknown): Promise<void> => {
    if (warningAttempts >= WARNING_ATTEMPT_BUDGET) return;
    warningAttempts += 1;
    try {
      await input.onWarning?.(message, error);
    } catch {
      // Warning delivery is observational and shares the lifecycle budget.
    }
  };

  const resolveRunDir = async (): Promise<string | null> => {
    const value = await resolveValue(input.runDir);
    return typeof value === "string" && value.length > 0 ? value : null;
  };

  const resolveProgress = async (): Promise<ProgressReporter | null> => {
    const value = await resolveValue(input.progress);
    return value ?? null;
  };

  let started = false;
  const record = async (code: "worker_started" | "worker_completed" | "worker_blocked" | "role_failed"): Promise<void> => {
    if (code !== "worker_started" && !started) await record("worker_started");
    try {
      const progress = await resolveProgress();
      if (!progress) return;
      await progress.emit({
        code,
        source: "runtime",
        operation: { index: 1, total: 1, kind: "command", safe_tool: input.command },
      });
      if (code === "worker_started") started = true;
    } catch (error) {
      await warn(`Session telemetry was unavailable for ${input.command}.`, error);
    }
  };

  const finishTerminalWork = async (): Promise<void> => {
    const runDir = await resolveRunDir();
    if (!runDir) return;
    let manifest = await readManifestV2(runDir);
    if (manifest.terminal === null) return;
    if (input.reconcile) await input.reconcile(manifest);
    manifest = await readManifestV2(runDir);
    if (input.assure) await input.assure(manifest);
    manifest = await readManifestV2(runDir);
    if (input.reflect) await input.reflect(manifest);
    manifest = await readManifestV2(runDir);
    if (manifest.terminal !== null && manifest.assurance_outcome !== null) {
      const event = await finalizeSession(runDir);
      if (event === null) await warn(`Canonical session finalization was unavailable for ${input.command}.`);
    }
  };

  await record("worker_started");
  let result: TResult;
  try {
    result = await input.action();
  } catch (error) {
    await record("role_failed");
    await warn(`Producing command ${input.command} failed.`, error);
    throw error;
  }

  let outcome: LifecycleOutcome;
  try {
    outcome = input.classify?.(result)
      ?? (result !== null && typeof result === "object" && (result as { status?: unknown }).status === "human_action_required"
        ? "blocked"
        : "successful");
  } catch (error) {
    await record("role_failed");
    await warn(`Producing command ${input.command} failed.`, error);
    throw error;
  }
  await record(outcome === "blocked" ? "worker_blocked" : outcome === "failed" ? "role_failed" : "worker_completed");

  try {
    // Terminal dispositions are deliberately allowed to be created here,
    // after the producing invocation has settled. This keeps its start and
    // settled outcome in the active aggregate before terminal finalization.
    const finalize = async () => {
      await input.beforeFinalize?.(result, outcome);
      await finishTerminalWork();
    };
    if (input.finalizeWithAuthority) await input.finalizeWithAuthority(finalize);
    else await finalize();
  } catch (error) {
    // A terminal disposition freezes the session aggregate's provenance. Do
    // not append a post-terminal failure event: the progress reporter may
    // otherwise finalize that aggregate before reconciliation or reflection
    // has completed.
    let shouldRecordFailure = true;
    try {
      const runDir = await resolveRunDir();
      if (runDir !== null && (await readManifestV2(runDir)).terminal !== null) {
        shouldRecordFailure = false;
      }
    } catch (telemetryError) {
      // Without a readable manifest it is unsafe to contribute telemetry that
      // could be post-terminal. Warning delivery remains observational.
      shouldRecordFailure = false;
      await warn(`Session telemetry was unavailable for ${input.command}.`, telemetryError);
    }
    if (shouldRecordFailure) {
      try {
        await record("role_failed");
      } catch (telemetryError) {
        await warn(`Session telemetry was unavailable for ${input.command}.`, telemetryError);
      }
    }
    await warn(`Producing command ${input.command} failed.`, error);
    throw error;
  }

  return result;
}

export const withSessionLifecycle = runProducingCommand;
export const withProducingCommandLifecycle = runProducingCommand;
export const withProducingCommand = runProducingCommand;
export const runSessionLifecycle = runProducingCommand;

export function producingCommandCatalog(): readonly ProducingCommand[] {
  return PRODUCING_COMMANDS;
}
