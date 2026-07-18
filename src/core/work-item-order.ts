import type { WorkItem } from "./types.js";

export function topologicallySortWorkItems(items: readonly WorkItem[]): WorkItem[] {
  const byId = new Map<string, WorkItem>();
  const indexById = new Map<string, number>();
  for (const [index, item] of items.entries()) {
    if (byId.has(item.id)) throw new Error(`Duplicate work item id: ${item.id}`);
    byId.set(item.id, item);
    indexById.set(item.id, index);
  }

  const indegrees = new Array<number>(items.length).fill(0);
  const dependents = Array.from({ length: items.length }, () => [] as number[]);
  for (const [index, item] of items.entries()) {
    for (const dependency of item.dependencies) {
      if (!byId.has(dependency)) {
        throw new Error(`Work item ${item.id} depends on missing work item ${dependency}`);
      }
      indegrees[index]! += 1;
      dependents[indexById.get(dependency)!]!.push(index);
    }
  }

  const ready: number[] = [];
  const pushReady = (index: number): void => {
    let position = ready.length;
    ready.push(index);
    while (position > 0) {
      const parent = Math.floor((position - 1) / 2);
      if (ready[parent]! <= ready[position]!) break;
      [ready[parent], ready[position]] = [ready[position]!, ready[parent]!];
      position = parent;
    }
  };
  const popReady = (): number => {
    const first = ready[0]!;
    const last = ready.pop()!;
    if (ready.length > 0) {
      ready[0] = last;
      let position = 0;
      while (true) {
        const left = position * 2 + 1;
        const right = left + 1;
        let smallest = position;
        if (left < ready.length && ready[left]! < ready[smallest]!) smallest = left;
        if (right < ready.length && ready[right]! < ready[smallest]!) smallest = right;
        if (smallest === position) break;
        [ready[position], ready[smallest]] = [ready[smallest]!, ready[position]!];
        position = smallest;
      }
    }
    return first;
  };
  for (const [index, indegree] of indegrees.entries()) {
    if (indegree === 0) pushReady(index);
  }

  const ordered: WorkItem[] = [];
  while (ready.length > 0) {
    const index = popReady();
    ordered.push(items[index]!);
    for (const dependent of dependents[index]!) {
      indegrees[dependent]! -= 1;
      if (indegrees[dependent] === 0) pushReady(dependent);
    }
  }
  if (ordered.length === items.length) return ordered;

  const state = new Map<string, "visiting" | "visited">();
  for (const item of items) {
    if (state.has(item.id)) continue;
    state.set(item.id, "visiting");
    const stack = [{ item, dependencyIndex: 0 }];
    while (stack.length > 0) {
      const frame = stack.at(-1)!;
      if (frame.dependencyIndex >= frame.item.dependencies.length) {
        state.set(frame.item.id, "visited");
        stack.pop();
        continue;
      }
      const dependency = frame.item.dependencies[frame.dependencyIndex++]!;
      const dependencyState = state.get(dependency);
      if (dependencyState === "visiting") {
        throw new Error(`Cyclic work item dependency involving ${dependency}`);
      }
      if (dependencyState === "visited") continue;
      const dependencyItem = byId.get(dependency)!;
      state.set(dependency, "visiting");
      stack.push({ item: dependencyItem, dependencyIndex: 0 });
    }
  }
  throw new Error(`Cyclic work item dependency involving ${items[0]!.id}`);
}
