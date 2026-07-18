import type { WorkItem } from "../core/types.js";

interface WorkItemIssueManifest {
  work_item_issue_map?: Readonly<Record<string, number>>;
  github_ids: {
    issue_numbers: readonly number[];
    work_item_issue_map?: Readonly<Record<string, number>>;
  };
}

export interface WorkItemIssueResolutionContext {
  resolve(workItemId: string): number | null;
}

function formerDepthFirstWorkItems(items: readonly WorkItem[]): WorkItem[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const visited = new Set<string>();
  const ordered: WorkItem[] = [];

  for (const item of items) {
    if (visited.has(item.id)) continue;
    visited.add(item.id);
    const stack = [{ item, dependencyIndex: 0 }];
    while (stack.length > 0) {
      const frame = stack.at(-1)!;
      if (frame.dependencyIndex >= frame.item.dependencies.length) {
        ordered.push(frame.item);
        stack.pop();
        continue;
      }
      const dependency = frame.item.dependencies[frame.dependencyIndex++]!;
      if (visited.has(dependency)) continue;
      const dependencyItem = byId.get(dependency);
      if (!dependencyItem) continue;
      visited.add(dependency);
      stack.push({ item: dependencyItem, dependencyIndex: 0 });
    }
  }
  return ordered;
}

export function createWorkItemIssueResolutionContext(
  manifest: WorkItemIssueManifest,
  rawPlanWorkItems: readonly WorkItem[],
): WorkItemIssueResolutionContext {
  const topLevelMap = new Map(Object.entries(manifest.work_item_issue_map ?? {}));
  const nestedMap = new Map(Object.entries(manifest.github_ids.work_item_issue_map ?? {}));
  if (topLevelMap.size > 0 || nestedMap.size > 0) {
    return {
      resolve: (workItemId) => {
        if (topLevelMap.has(workItemId)) return topLevelMap.get(workItemId) ?? null;
        if (nestedMap.has(workItemId)) return nestedMap.get(workItemId) ?? null;
        return null;
      },
    };
  }

  const legacyIssueMap = new Map<string, number>();
  for (const [index, item] of formerDepthFirstWorkItems(rawPlanWorkItems).entries()) {
    const issueNumber = manifest.github_ids.issue_numbers[index];
    if (Number.isInteger(issueNumber) && issueNumber! > 0) legacyIssueMap.set(item.id, issueNumber!);
  }
  return { resolve: (workItemId) => legacyIssueMap.get(workItemId) ?? null };
}

export function resolveWorkItemIssueNumber(
  manifest: WorkItemIssueManifest,
  workItemId: string,
  rawPlanWorkItems: readonly WorkItem[],
): number | null {
  return createWorkItemIssueResolutionContext(manifest, rawPlanWorkItems).resolve(workItemId);
}
