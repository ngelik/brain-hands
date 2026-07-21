import { describe, expect, it } from "vitest";
import { compactModelDiff } from "../../src/workflow/model-diff.js";

describe("compactModelDiff", () => {
  it("omits Git binary patch payloads and preserves changed paths within the requested bound", () => {
    const binaryPayload = "A".repeat(1_200_000);
    const textPayload = `+${"x".repeat(100_000)}`;
    const result = compactModelDiff([
      "diff --git a/public/planet.webp b/public/planet.webp",
      "new file mode 100644",
      "GIT binary patch",
      "literal 1200000",
      binaryPayload,
      "diff --git a/src/example.ts b/src/example.ts",
      "--- a/src/example.ts",
      "+++ b/src/example.ts",
      "@@ -0,0 +1 @@",
      textPayload,
    ].join("\n"), 24_000);

    expect(result.length).toBeLessThanOrEqual(24_000);
    expect(result).toContain("Binary patch payload omitted from the model prompt (1200000 bytes)");
    expect(result).toContain("Diff content compacted to stay within the model input limit");
    expect(result).toContain("public/planet.webp");
    expect(result).toContain("src/example.ts");
    expect(result).not.toContain(binaryPayload);
  });
});
