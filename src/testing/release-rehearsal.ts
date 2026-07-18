import type { RunMode } from "../core/types.js";
import { preflightResultSchema } from "../core/schema.js";
import type { LocalRuntimeDependencies } from "../workflow/runtime.js";
import type { RunPreflightReport } from "../workflow/preflight.js";

export type ReleaseRehearsalScenario =
  | "happy"
  | "verifier-fix"
  | "interrupted-resume";

const scenarios = new Set<ReleaseRehearsalScenario>([
  "happy",
  "verifier-fix",
  "interrupted-resume",
]);

const PARK_MS = 300_000;

export function configuredReleaseRehearsalScenario(input: {
  dryRun: boolean;
  mode: RunMode;
  env?: NodeJS.ProcessEnv;
}): ReleaseRehearsalScenario | null {
  const env = input.env ?? process.env;
  if (env.BRAIN_HANDS_RELEASE_REHEARSAL !== "1") return null;
  if (env.NODE_ENV !== "test") {
    throw new Error("Release rehearsal requires NODE_ENV=test");
  }
  if (!input.dryRun) throw new Error("Release rehearsal requires --dry-run");
  if (input.mode !== "local") throw new Error("Release rehearsal supports local mode only");

  const scenario = env.BRAIN_HANDS_RELEASE_REHEARSAL_SCENARIO;
  if (!scenarios.has(scenario as ReleaseRehearsalScenario)) {
    throw new Error(`Unknown release rehearsal scenario: ${scenario ?? "missing"}`);
  }
  return scenario as ReleaseRehearsalScenario;
}

export function releaseRehearsalDependencies(
  scenario: ReleaseRehearsalScenario | null,
): LocalRuntimeDependencies | undefined {
  if (scenario !== "interrupted-resume") return undefined;
  let parked = false;
  return {
    afterCheckpoint: async (checkpoint) => {
      if (parked || checkpoint !== "after_work_item_advance_effect") return;
      parked = true;
      await new Promise<void>((resolve) => setTimeout(resolve, PARK_MS));
    },
  };
}

export function releaseRehearsalPreflight(
  scenario: ReleaseRehearsalScenario,
): RunPreflightReport {
  const report = {
    checks: [{
      command: "brain-hands-release-rehearsal",
      args: [scenario],
      required: true,
      status: "OK" as const,
      available: true,
      exit_code: 0,
      stdout: "Deterministic release rehearsal preflight passed.",
      stderr: "",
    }],
    required_checks_failed: false,
    github_auth: { status: "skipped" as const, reason: null, stderr: "" },
    github_auth_status: "skipped" as const,
    supports_search: false,
    github_repository: null,
    missing_github_labels: [],
    drifted_github_labels: [],
  } satisfies RunPreflightReport;
  preflightResultSchema.parse(report);
  return report;
}
