export const MAX_MODEL_DIFF_CHARS = 500_000;

/** Preserve useful textual context while keeping raw Git binary patches out of model prompts. */
export function compactModelDiff(diff: string, maxChars = MAX_MODEL_DIFF_CHARS): string {
  if (!Number.isInteger(maxChars) || maxChars < 1) {
    throw new Error("Model diff limit must be a positive integer");
  }
  const withoutBinaryPayloads = diff
    .split(/(?=^diff --git )/m)
    .map((section) => {
      const marker = "\nGIT binary patch\n";
      const markerIndex = section.indexOf(marker);
      if (markerIndex < 0) return section;
      const literalBytes = /^literal (\d+)$/m.exec(section.slice(markerIndex + marker.length))?.[1] ?? "unknown";
      return `${section.slice(0, markerIndex)}${marker}# Binary patch payload omitted from the model prompt (${literalBytes} bytes); inspect the approved file directly when needed.\n`;
    })
    .join("");
  if (withoutBinaryPayloads.length <= maxChars) return withoutBinaryPayloads;

  const changedPaths = [...withoutBinaryPayloads.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)].map((match) => match[2]);
  const summary = [
    "# Diff content compacted to stay within the model input limit.",
    `# Original compacted diff characters: ${withoutBinaryPayloads.length}.`,
    `# Changed paths: ${[...new Set(changedPaths)].join(", ") || "unknown"}.`,
  ].join("\n");
  if (summary.length + 2 >= maxChars) return `${summary.slice(0, maxChars - 1)}\n`;
  const retainedChars = maxChars - summary.length - 2;
  const headChars = Math.floor(retainedChars / 2);
  const tailChars = retainedChars - headChars;
  return `${withoutBinaryPayloads.slice(0, headChars)}\n${summary}\n${withoutBinaryPayloads.slice(-tailChars)}`;
}
