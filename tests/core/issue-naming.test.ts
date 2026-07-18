import { describe, expect, it } from "vitest";
import {
  deriveLegacyFeatureSlug,
  formatParentIssueTitle,
  formatWorkItemIssueTitle,
  resolveFeatureSlug,
} from "../../src/core/issue-naming.js";

describe("GitHub issue naming", () => {
  it("formats a deterministic work-item title", () => {
    expect(formatWorkItemIssueTitle({
      featureSlug: "release-ci",
      sequence: 1,
      itemSlug: "schema-compat",
      title: "Complete Codex output-schema compatibility",
    })).toBe("[release-ci:1:schema-compat] Complete Codex output-schema compatibility");
  });

  it("formats a multi-digit work-item sequence", () => {
    expect(formatWorkItemIssueTitle({
      featureSlug: "release-ci",
      sequence: 12,
      itemSlug: "schema-compat",
      title: "Complete Codex output-schema compatibility",
    })).toBe("[release-ci:12:schema-compat] Complete Codex output-schema compatibility");
  });

  it("formats a parent title without an item slug", () => {
    expect(formatParentIssueTitle({
      featureSlug: "release-ci",
      title: "Manual release and exact model validation",
    })).toBe("[release-ci] Manual release and exact model validation");
  });

  it.each(["Release-CI", "release_ci", "release ci", "release:ci", "-release"])(
    "rejects invalid slug %s",
    (featureSlug) => {
      expect(() => formatWorkItemIssueTitle({ featureSlug, sequence: 1, itemSlug: "schema", title: "Complete schema" }))
        .toThrow("feature slug");
    },
  );

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid sequence %s",
    (sequence) => {
      expect(() => formatWorkItemIssueTitle({
        featureSlug: "release-ci",
        sequence,
        itemSlug: "schema",
        title: "Complete schema",
      })).toThrow("positive safe integer");
    },
  );

  it("accepts a maximum safe-integer sequence at the 52-character prefix boundary", () => {
    expect(formatWorkItemIssueTitle({
      featureSlug: "abcdefghijklmnop",
      sequence: Number.MAX_SAFE_INTEGER,
      itemSlug: "qrstuvwxyzabcdef",
      title: "Complete schema",
    })).toBe("[abcdefghijklmnop:9007199254740991:qrstuvwxyzabcdef] Complete schema");
  });

  it("rejects a title that already contains a generated prefix", () => {
    expect(() => formatWorkItemIssueTitle({
      featureSlug: "release-ci",
      sequence: 1,
      itemSlug: "schema",
      title: "[release-ci:1:schema] Complete schema",
    })).toThrow("must not include a prefix");
  });

  it("accepts a complete title at exactly 120 characters", () => {
    const title = formatWorkItemIssueTitle({
      featureSlug: "release-ci",
      sequence: 1,
      itemSlug: "schema",
      title: "x".repeat(98),
    });
    expect(title).toHaveLength(120);
  });

  it("rejects a complete title at 121 characters", () => {
    expect(() => formatWorkItemIssueTitle({
      featureSlug: "release-ci",
      sequence: 1,
      itemSlug: "schema",
      title: "x".repeat(99),
    })).toThrow("120 characters");
  });

  it("derives a bounded compatibility slug for an old plan", () => {
    expect(deriveLegacyFeatureSlug("  Manual Release & Exact Model Validation  ")).toBe("manual-release");
    expect(deriveLegacyFeatureSlug("!!!")).toBe("workflow");
  });

  it("prefers an explicit feature slug and falls back for an old plan", () => {
    expect(resolveFeatureSlug({ feature_slug: "release-ci", summary: "Ignored" })).toBe("release-ci");
    expect(resolveFeatureSlug({ summary: "Manual release" })).toBe("manual-release");
  });
});
