import { describe, expect, it } from "vitest";
import { browserEvidenceArtifactsMatchIdentity } from "../../src/core/verification-provenance.js";

describe("browser evidence identity", () => {
  const prefix = "verification/local/current/attempt-1/";
  const browser = {
    name: "desktop",
    url: "http://127.0.0.1:4173/",
    status: "passed" as const,
    screenshot_artifact: `${prefix}artifacts/desktop.png`,
    screenshot_exists: true,
    expected_network: [],
    observed_network: [],
    missing_network: [],
    console_errors: [],
    missing_selectors: [],
    failure_reasons: [],
    evidence_report_path: "verification/issue-2/attempt-29/browser-evidence.json",
    skipped_reason: null,
  };

  it("accepts a legacy selected report when the current scoped report was also captured", () => {
    expect(browserEvidenceArtifactsMatchIdentity({
      artifacts: [`${prefix}browser-evidence.json`],
      artifact_checks: [{ path: `${prefix}browser-evidence.json`, exists: true, required: true }],
      browser_evidence: [browser],
    }, prefix)).toBe(true);
  });

  it("rejects a foreign report when no current scoped report exists", () => {
    expect(browserEvidenceArtifactsMatchIdentity({
      artifacts: [],
      artifact_checks: [],
      browser_evidence: [browser],
    }, prefix)).toBe(false);
  });
});
