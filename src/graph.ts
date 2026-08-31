import { isActive, type Task } from './types.js';
import { sortByPriority } from './priority.js';

/**
 * Read-only derived view over a set of tasks. `parent` and `blocked_by` are
 * the stored sides; everything else here is derived from them.
 */
export interface Graph {
  get(id: string): Task | undefined;
  /** Direct children, sorted by priority. */
  children(id: string): Task[];
  /** Tasks that list `id` in blocked_by, sorted by priority. */
  blocking(id: string): Task[];
  /** Parent chain, nearest first. */
  ancestors(id: string): Task[];
  /** All transitive children, depth-first in priority order. */
  descendants(id: string): Task[];
  /** Tasks without a parent, sorted by priority. */
  roots(): Task[];
  /** Blockers of `id` that are still todo or in-progress. */
  activeBlockers(id: string): Task[];
  isBlocked(id: string): boolean;
  /** True if setting parentId as the parent of childId would create a loop. */
  wouldCycleParent(childId: string, parentId: string): boolean;
  /** True if adding blockerId to taskId's blocked_by would create a loop. */
  wouldCycleDependency(taskId: string, blockerId: string): boolean;
}

export function buildGraph(tasks: Task[]): Graph {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const childrenOf = new Map<string, Task[]>();
  const blockingOf = new Map<string, Task[]>();

  for (const task of sortByPriority(tasks)) {
    if (task.parent !== undefined && byId.has(task.parent)) {
      push(childrenOf, task.parent, task);
    }
    for (const blockerId of task.blockedBy) {
      if (byId.has(blockerId)) push(blockingOf, blockerId, task);
    }
  }

  const children = (id: string): Task[] => childrenOf.get(id) ?? [];

  const descend = (id: string, out: Task[]): Task[] => {
    for (const child of children(id)) {
      out.push(child);
      descend(child.id, out);
    }
    return out;
  };

  const ancestors = (id: string): Task[] => {
    const out: Task[] = [];
    const seen = new Set<string>([id]);
    let current = byId.get(id);
    while (current?.parent !== undefined && !seen.has(current.parent)) {
      const parent = byId.get(current.parent);
      if (parent === undefined) break;
      out.push(parent);
      seen.add(parent.id);
      current = parent;
    }
    return out;
  };

  /** All ids reachable from `id` through the given edge function. */
  const reaches = (id: string, target: string, edges: (id: string) => string[]): boolean => {
    const seen = new Set<string>();
    const queue = [id];
    while (queue.length > 0) {
      const current = queue.pop()!;
      if (current === target) return true;
      if (seen.has(current)) continue;
      seen.add(current);
      queue.push(...edges(current));
    }
    return false;
  };

  const activeBlockers = (id: string): Task[] =>
    (byId.get(id)?.blockedBy ?? [])
      .map((blockerId) => byId.get(blockerId))
      .filter((t): t is Task => t !== undefined && isActive(t));

  return {
    get: (id) => byId.get(id),
    children,
    blocking: (id) => blockingOf.get(id) ?? [],
    ancestors,
    descendants: (id) => descend(id, []),
    roots: () => sortByPriority(tasks.filter((t) => t.parent === undefined || !byId.has(t.parent))),
    activeBlockers,
    isBlocked: (id) => activeBlockers(id).length > 0,
    // parentId's ancestor chain reaching childId (or being it) means a loop.
    wouldCycleParent: (childId, parentId) =>
      childId === parentId ||
      reaches(parentId, childId, (id) => {
        const parent = byId.get(id)?.parent;
        return parent !== undefined ? [parent] : [];
      }),
    // blockerId transitively blocked by taskId means a loop.
    wouldCycleDependency: (taskId, blockerId) =>
      taskId === blockerId || reaches(blockerId, taskId, (id) => byId.get(id)?.blockedBy ?? []),
  };
}

function push(map: Map<string, Task[]>, key: string, task: Task): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [task]);
  else list.push(task);
}
