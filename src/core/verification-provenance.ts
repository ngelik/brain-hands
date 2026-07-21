import type { VerificationEvidence } from "./types.js";

type BrowserEvidenceIdentity = Pick<VerificationEvidence, "artifacts" | "artifact_checks" | "browser_evidence">;
type BrowserEvidenceEntry = VerificationEvidence["browser_evidence"][number];

function scopedBrowserReportPath(
  evidence: BrowserEvidenceIdentity,
  prefix: string,
): string | null {
  const path = `${prefix}browser-evidence.json`;
  return evidence.artifacts.includes(path)
    && evidence.artifact_checks.some((artifact) => artifact.path === path && artifact.exists)
    ? path
    : null;
}

export function browserEvidenceReportPathForIdentity(
  evidence: BrowserEvidenceIdentity,
  browser: BrowserEvidenceEntry,
  prefix: string,
): string | null {
  if (browser.evidence_report_path === null || browser.evidence_report_path.startsWith(prefix)) {
    return browser.evidence_report_path;
  }
  return scopedBrowserReportPath(evidence, prefix) ?? browser.evidence_report_path;
}

export function browserEvidenceArtifactsMatchIdentity(
  evidence: BrowserEvidenceIdentity,
  prefix: string,
): boolean {
  return evidence.browser_evidence.every((browser) =>
    browser.screenshot_artifact.startsWith(prefix)
    && (
      browser.evidence_report_path === null
      || browserEvidenceReportPathForIdentity(evidence, browser, prefix)?.startsWith(prefix) === true
    ));
}
