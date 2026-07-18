interface SemanticVersion {
  major: number;
  minor: number;
  patch: number;
}

export function parseStableVersion(value: unknown, label?: string): SemanticVersion;

export function parseCaretRange(value: unknown, label?: string): SemanticVersion;

export function satisfiesCaretRange(
  version: SemanticVersion | string,
  range: SemanticVersion | string,
): boolean;

export function parseCliVersionOutput(stdout: unknown, label?: string): string;

export function requiredCodexFlowRange(skillText: string): string;
