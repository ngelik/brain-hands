import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { verificationExecutionResultSchema, verificationEvidenceSchema } from "../core/schema.js";
import { verificationEvidencePath, type VerificationEvidence, type VerificationIdentity } from "../core/types.js";

export interface ValidatePersistedVerificationEvidenceInput {
  runDir: string;
  identity: VerificationIdentity;
  attempt: number;
  evidencePath: string;
}

function resolveInside(root: string, path: string, label: string): string {
  if (isAbsolute(path)) throw new Error(`${label} must be relative: ${path}`);
  const absoluteRoot = resolve(root);
  const absolutePath = resolve(absoluteRoot, path);
  const relation = relative(absoluteRoot, absolutePath);
  if (relation === "" || relation.startsWith("..") || isAbsolute(relation)) {
    throw new Error(`${label} escapes its expected root: ${path}`);
  }
  return absolutePath;
}

function assertRepoArtifactPath(path: string, label: string): void {
  resolveInside("/repo-root", path, label);
}

/** Validate a completed verification namespace without executing commands. */
export async function validatePersistedVerificationEvidence(
  input: ValidatePersistedVerificationEvidenceInput,
): Promise<VerificationEvidence> {
  const evidence = verificationEvidenceSchema.parse(JSON.parse(await readFile(
    resolveInside(input.runDir, input.evidencePath, "Verification evidence path"),
    "utf8",
  )));
  if (
    evidence.verification_scope !== input.identity.scope
    || evidence.work_item_id !== input.identity.work_item_id
    || (input.identity.scope === "github"
      ? !("issue_number" in evidence) || evidence.issue_number !== input.identity.issue_number
      : "issue_number" in evidence)
    || evidence.attempt !== input.attempt
    || evidence.evidence_path !== input.evidencePath
    || input.evidencePath !== verificationEvidencePath(input.identity, input.attempt)
  ) {
    throw new Error(`Persisted verification provenance does not match ${input.identity.work_item_id} attempt ${input.attempt}`);
  }

  const namespace = dirname(input.evidencePath);
  for (const command of evidence.commands) {
    if (!command.result_path) throw new Error("Persisted verification command result is missing");
    for (const [label, path] of [
      ["stdout", command.stdout_path],
      ["stderr", command.stderr_path],
      ["result", command.result_path],
    ] as const) {
      if (dirname(path) !== namespace) throw new Error(`Persisted verification ${label} path escapes its namespace: ${path}`);
    }
    const [stdout, stderr, resultRaw] = await Promise.all([
      readFile(resolveInside(input.runDir, command.stdout_path, "Verification stdout path"), "utf8"),
      readFile(resolveInside(input.runDir, command.stderr_path, "Verification stderr path"), "utf8"),
      readFile(resolveInside(input.runDir, command.result_path, "Verification result path"), "utf8"),
    ]);
    const result = verificationExecutionResultSchema.parse(JSON.parse(resultRaw));
    if (
      JSON.stringify(result.argv) !== JSON.stringify(command.argv ?? [])
      || result.exit_code !== command.exit_code
      || result.timed_out !== command.timed_out
      || result.error_code !== command.error_code
      || result.error_message !== command.error_message
      || result.signal !== command.signal
      || result.stdout !== stdout
      || result.stderr !== stderr
      || (command.duration_ms !== undefined && result.duration_ms !== command.duration_ms)
    ) {
      throw new Error(`Persisted verification command result does not match evidence: ${command.result_path}`);
    }
  }

  for (const path of evidence.artifacts) assertRepoArtifactPath(path, "Verified artifact path");
  for (const artifact of evidence.artifact_checks) assertRepoArtifactPath(artifact.path, "Artifact check path");
  for (const browser of evidence.browser_evidence) {
    assertRepoArtifactPath(browser.screenshot_artifact, "Browser screenshot path");
    if (browser.evidence_report_path) assertRepoArtifactPath(browser.evidence_report_path, "Browser evidence report path");
  }
  return evidence;
}
