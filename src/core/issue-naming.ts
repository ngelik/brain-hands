import type { PlanReadinessDiagnostic } from "./execution-spec.js";
import type { BrainPlan } from "./types.js";

export const ISSUE_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const MAX_ISSUE_SLUG_LENGTH = 16;
export const MAX_ISSUE_PREFIX_LENGTH = 52;
export const MAX_GITHUB_ISSUE_TITLE_LENGTH = 120;

function assertSlug(value: string, field: "feature" | "item"): void {
  if (!ISSUE_SLUG_PATTERN.test(value) || value.length > MAX_ISSUE_SLUG_LENGTH) {
    throw new Error(`${field} slug must be 1-${MAX_ISSUE_SLUG_LENGTH} lowercase kebab-case characters`);
  }
}

function normalizedReadableTitle(title: string): string {
  const normalized = title.trim();
  if (!normalized) throw new Error("issue title must not be empty");
  if (normalized.startsWith("[")) throw new Error("issue title must not include a prefix");
  return normalized;
}

function assertTitleLength(title: string): void {
  if (title.length > MAX_GITHUB_ISSUE_TITLE_LENGTH) {
    throw new Error(`generated issue title must not exceed ${MAX_GITHUB_ISSUE_TITLE_LENGTH} characters`);
  }
}

export function formatWorkItemIssueTitle(input: {
  featureSlug: string;
  sequence: number;
  itemSlug: string;
  title: string;
}): string {
  if (!Number.isSafeInteger(input.sequence) || input.sequence < 1) {
    throw new Error("issue sequence must be a positive safe integer");
  }
  assertSlug(input.featureSlug, "feature");
  assertSlug(input.itemSlug, "item");
  const prefix = `[${input.featureSlug}:${input.sequence}:${input.itemSlug}]`;
  if (prefix.length > MAX_ISSUE_PREFIX_LENGTH) {
    throw new Error(`generated issue prefix must not exceed ${MAX_ISSUE_PREFIX_LENGTH} characters`);
  }
  const title = `${prefix} ${normalizedReadableTitle(input.title)}`;
  assertTitleLength(title);
  return title;
}

export function formatParentIssueTitle(input: { featureSlug: string; title: string }): string {
  assertSlug(input.featureSlug, "feature");
  const title = `[${input.featureSlug}] ${normalizedReadableTitle(input.title)}`;
  assertTitleLength(title);
  return title;
}

export function deriveLegacyFeatureSlug(summary: string): string {
  const candidate = summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const slug = candidate.split("-").reduce((result, part) => {
    const next = result ? `${result}-${part}` : part;
    return next.length <= MAX_ISSUE_SLUG_LENGTH ? next : result;
  }, "");
  return slug || "workflow";
}

export function resolveFeatureSlug(plan: { feature_slug?: string; summary: string }): string {
  const featureSlug = plan.feature_slug ?? deriveLegacyFeatureSlug(plan.summary);
  assertSlug(featureSlug, "feature");
  return featureSlug;
}

function namingDiagnostic(path: string, error: unknown): PlanReadinessDiagnostic {
  return {
    code: "plan.issue_naming",
    path,
    message: (error instanceof Error ? error.message : String(error)).slice(0, 240),
  };
}

export function planIssueNamingDiagnostics(plan: BrainPlan): PlanReadinessDiagnostic[] {
  const diagnostics: PlanReadinessDiagnostic[] = [];
  let featureSlug = plan.feature_slug;
  if (featureSlug === undefined) {
    diagnostics.push(namingDiagnostic("/feature_slug", new Error("Brain plan feature_slug is required")));
    featureSlug = "feature";
  } else {
    try {
      formatParentIssueTitle({ featureSlug, title: "Valid title" });
    } catch (error) {
      diagnostics.push(namingDiagnostic("/feature_slug", error));
      featureSlug = "feature";
    }
  }

  if (plan.parent_issue === undefined) {
    diagnostics.push(namingDiagnostic("/parent_issue", new Error("Brain plan parent_issue must be an object or null")));
  } else if (plan.parent_issue !== null) {
    try {
      formatParentIssueTitle({ featureSlug, title: plan.parent_issue.title });
    } catch (error) {
      diagnostics.push(namingDiagnostic("/parent_issue/title", error));
    }
  }

  const sequence = Math.max(1, plan.work_items.length);
  for (const [index, item] of plan.work_items.entries()) {
    let itemSlug = item.id;
    try {
      formatWorkItemIssueTitle({ featureSlug, sequence, itemSlug, title: "Valid title" });
    } catch (error) {
      diagnostics.push(namingDiagnostic(`/work_items/${index}/id`, error));
      itemSlug = "work-item";
    }
    try {
      formatWorkItemIssueTitle({ featureSlug, sequence, itemSlug, title: item.title });
    } catch (error) {
      diagnostics.push(namingDiagnostic(`/work_items/${index}/title`, error));
    }
  }
  return diagnostics;
}
