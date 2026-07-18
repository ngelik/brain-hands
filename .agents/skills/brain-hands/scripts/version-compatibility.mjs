const stableVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const caretRangePattern = /^\^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function parseStableVersion(value, label = "version") {
  const match = stableVersionPattern.exec(String(value));
  if (!match) throw new Error(`${label} must be a canonical stable semantic version (x.y.z)`);
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

export function parseCaretRange(value, label = "codex_flow requirement") {
  const match = caretRangePattern.exec(String(value));
  if (!match) throw new Error(`${label} must be a caret range such as ^0.2.0`);
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

export function satisfiesCaretRange(version, range) {
  const candidate = typeof version === "string" ? parseStableVersion(version) : version;
  const minimum = typeof range === "string" ? parseCaretRange(range) : range;

  if (minimum.major > 0) {
    return candidate.major === minimum.major && (
      candidate.minor > minimum.minor ||
      (candidate.minor === minimum.minor && candidate.patch >= minimum.patch)
    );
  }

  if (minimum.minor > 0) {
    return candidate.major === 0 && candidate.minor === minimum.minor && candidate.patch >= minimum.patch;
  }

  return candidate.major === 0 && candidate.minor === 0 && candidate.patch === minimum.patch;
}

export function parseCliVersionOutput(stdout, label = "CLI version") {
  const value = String(stdout).trim();
  if (!value || value.includes("\n")) throw new Error(`${label} must contain exactly one version line`);
  parseStableVersion(value, label);
  return value;
}

export function requiredCodexFlowRange(skillText) {
  const frontmatter = /^---\s*\n([\s\S]*?)\n---(?:\s|$)/.exec(skillText)?.[1];
  if (!frontmatter) throw new Error("SKILL.md is missing YAML frontmatter");
  const match = /^\s+codex_flow:\s*["']?([^"'\s]+)["']?\s*$/m.exec(frontmatter);
  if (!match) throw new Error("SKILL.md is missing requires.codex_flow compatibility metadata");
  parseCaretRange(match[1], "SKILL.md requires.codex_flow");
  return match[1];
}
