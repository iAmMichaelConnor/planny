import { isActive, type Task } from './types.js';

/**
 * Priority is a rank: lower number = higher priority. Ranks are unique
 * integers, kept sparse so most moves rewrite one file. Positions shown to
 * users are 1-based indexes into the active (todo / in-progress) tasks
 * sorted by rank.
 *
 * Invariant: an active task never ranks above an active task that blocks it.
 */

export type BumpTarget = 'top' | 'bottom' | number;

const STEP = 10;

export function sortByPriority<T extends { priority: number }>(tasks: readonly T[]): T[] {
  return [...tasks].sort((a, b) => a.priority - b.priority);
}

/**
 * Move a task to the requested position among active tasks, clamped to the
 * nearest position that keeps the dependency-order invariant. Mutates ranks
 * in place; returns the ids whose rank changed.
 */
export function bumpPriority(tasks: Task[], id: string, target: BumpTarget): Set<string> {
  const task = tasks.find((t) => t.id === id);
  if (task === undefined) throw new Error(`no task ${id}`);
  const changed = new Set<string>();

  const others = sortByPriority(tasks.filter((t) => t.id !== id && isActive(t)));
  const desired = target === 'top' ? 0 : target === 'bottom' ? others.length : target - 1;

  // The insertion index must fall after every active blocker and before
  // every active dependant of the moving task (only meaningful while the
  // task itself is active).
  let lo = 0;
  let hi = others.length;
  if (isActive(task)) {
    const blockerIds = new Set(task.blockedBy);
    others.forEach((other, index) => {
      if (blockerIds.has(other.id)) lo = Math.max(lo, index + 1);
      if (other.blockedBy.includes(id) ) hi = Math.min(hi, index);
    });
  }
  const index = Math.min(Math.max(desired, lo), hi);

  const before = others[index - 1];
  const after = others[index];
  const used = new Set(tasks.filter((t) => t.id !== id).map((t) => t.priority));
  let rank = pickRank(used, before?.priority, after?.priority);
  if (rank === undefined) {
    renormalize(tasks, id, changed);
    rank = pickRank(
      new Set(tasks.filter((t) => t.id !== id).map((t) => t.priority)),
      before?.priority,
      after?.priority,
    );
    if (rank === undefined) throw new Error('no rank available after renormalize');
  }
  if (task.priority !== rank) {
    task.priority = rank;
    changed.add(id);
  }
  return changed;
}

/**
 * Restore the invariant after edges or statuses changed: any active task
 * ranked at or above an active blocker moves to just after that blocker.
 * Mutates ranks in place; returns the ids whose rank changed.
 */
export function repairDependencyOrder(tasks: Task[]): Set<string> {
  const changed = new Set<string>();
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const limit = tasks.length * tasks.length + 10;

  for (let i = 0; i < limit; i++) {
    const violation = findViolation(tasks, byId);
    if (violation === undefined) return changed;
    const { blocker, blocked } = violation;

    const nextRank = tasks
      .filter((t) => t.id !== blocked.id && t.priority > blocker.priority)
      .reduce<number | undefined>((min, t) => (min === undefined || t.priority < min ? t.priority : min), undefined);
    const used = new Set(tasks.filter((t) => t.id !== blocked.id).map((t) => t.priority));
    let rank = pickRank(used, blocker.priority, nextRank);
    if (rank === undefined) {
      renormalize(tasks, blocked.id, changed);
      continue; // re-find the violation against fresh ranks
    }
    blocked.priority = rank;
    changed.add(blocked.id);
  }
  throw new Error('dependency order repair did not settle — is there a blocked_by cycle?');
}

function findViolation(
  tasks: Task[],
  byId: Map<string, Task>,
): { blocker: Task; blocked: Task } | undefined {
  let best: { blocker: Task; blocked: Task } | undefined;
  for (const blocked of tasks) {
    if (!isActive(blocked)) continue;
    for (const blockerId of blocked.blockedBy) {
      const blocker = byId.get(blockerId);
      if (blocker === undefined || !isActive(blocker)) continue;
      if (blocked.priority > blocker.priority) continue;
      if (best === undefined || blocker.priority < best.blocker.priority) {
        best = { blocker, blocked };
      }
    }
  }
  return best;
}

/**
 * Pick an unused integer rank strictly inside (before, after). Either bound
 * may be undefined (open end). Returns undefined when the interval has no
 * free integer.
 */
function pickRank(
  used: Set<number>,
  before: number | undefined,
  after: number | undefined,
): number | undefined {
  if (before === undefined && after === undefined) {
    let rank = 0;
    while (used.has(rank)) rank += STEP;
    return rank;
  }
  if (before === undefined) {
    let rank = after! - STEP;
    while (used.has(rank)) rank -= 1;
    return rank < after! ? rank : undefined;
  }
  if (after === undefined) {
    let rank = before + STEP;
    while (used.has(rank)) rank += 1;
    return rank;
  }
  for (let rank = midpoint(before, after); rank > before && rank < after; ) {
    if (!used.has(rank)) return rank;
    rank += 1;
  }
  for (let rank = midpoint(before, after) - 1; rank > before; rank -= 1) {
    if (!used.has(rank)) return rank;
  }
  return undefined;
}

function midpoint(a: number, b: number): number {
  return Math.floor((a + b) / 2);
}

/** Re-rank every task except `skipId` to sparse steps, preserving order. */
function renormalize(tasks: Task[], skipId: string, changed: Set<string>): void {
  let rank = STEP;
  for (const task of sortByPriority(tasks.filter((t) => t.id !== skipId))) {
    if (task.priority !== rank) {
      task.priority = rank;
      changed.add(task.id);
    }
    rank += STEP;
  }
}
