import { describe, expect, it, vi } from "vitest";
import {
  configuredReleaseRehearsalScenario,
  releaseRehearsalDependencies,
} from "../../src/testing/release-rehearsal.js";

const enabled = {
  NODE_ENV: "test",
  BRAIN_HANDS_RELEASE_REHEARSAL: "1",
  BRAIN_HANDS_RELEASE_REHEARSAL_SCENARIO: "happy",
};

describe("release rehearsal controls", () => {
  it("stays disabled when the private master switch is absent", () => {
    expect(configuredReleaseRehearsalScenario({
      dryRun: true,
      mode: "local",
      env: { NODE_ENV: "test", BRAIN_HANDS_RELEASE_REHEARSAL_SCENARIO: "happy" },
    })).toBeNull();
  });

  it.each([
    ["non-test environment", { ...enabled, NODE_ENV: "production" }, true, "local"],
    ["non-dry-run command", enabled, false, "local"],
    ["GitHub mode", enabled, true, "github"],
  ] as const)("rejects %s", (_name, env, dryRun, mode) => {
    expect(() => configuredReleaseRehearsalScenario({ dryRun, mode, env }))
      .toThrow(/release rehearsal/i);
  });

  it.each(["happy", "verifier-fix", "interrupted-resume"] as const)(
    "accepts the %s scenario under every gate",
    (scenario) => {
      expect(configuredReleaseRehearsalScenario({
        dryRun: true,
        mode: "local",
        env: { ...enabled, BRAIN_HANDS_RELEASE_REHEARSAL_SCENARIO: scenario },
      })).toBe(scenario);
    },
  );

  it("rejects a missing or unknown scenario", () => {
    expect(() => configuredReleaseRehearsalScenario({
      dryRun: true,
      mode: "local",
      env: { NODE_ENV: "test", BRAIN_HANDS_RELEASE_REHEARSAL: "1" },
    })).toThrow(/unknown release rehearsal scenario: missing/i);

    expect(() => configuredReleaseRehearsalScenario({
      dryRun: true,
      mode: "local",
      env: { ...enabled, BRAIN_HANDS_RELEASE_REHEARSAL_SCENARIO: "unknown" },
    })).toThrow(/unknown release rehearsal scenario/i);
  });

  it("parks only the interruption scenario at the durable work-item checkpoint", async () => {
    vi.useFakeTimers();
    try {
      const dependencies = releaseRehearsalDependencies("interrupted-resume");
      if (!dependencies?.afterCheckpoint) throw new Error("expected interruption dependency");
      await expect(dependencies.afterCheckpoint("after_status_verifying_publication"))
        .resolves.toBeUndefined();

      let settled = false;
      const parked = dependencies.afterCheckpoint("after_work_item_advance_effect")
        .finally(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(settled).toBe(false);
      await vi.runAllTimersAsync();
      await expect(parked).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
