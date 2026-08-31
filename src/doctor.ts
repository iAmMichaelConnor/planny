import { buildGraph } from './graph.js';
import { repairDependencyOrder } from './priority.js';
import type { Store } from './store.js';
import { isActive, type Task } from './types.js';

/**
 * Integrity checks for a store that may have been edited by hand. Diagnosis
 * is read-only; fixStore applies only repairs with one right answer.
 *
 * fixStore writes task files directly (not through ops.ts): ops assumes the
 * very invariants the doctor exists to restore, and its codepaths refuse
 * stores that violate them. Doctor stays the only other writer.
 */

export type FindingCode =
  | 'unreadable-file'
  | 'id-mismatch'
  | 'dangling-parent'
  | 'dangling-blocker'
  | 'dangling-replacement'
  | 'duplicate-rank'
  | 'parent-cycle'
  | 'dependency-cycle'
  | 'order-violation'
  | 'cancelled-blocker'
  | 'cancelled-parent'
  | 'unresolved-decision';

export interface Finding {
  code: FindingCode;
  severity: 'error' | 'warning';
  /** True when fixStore can repair it safely. */
  fixable: boolean;
  file: string;
  id?: string;
  message: string;
}

export function diagnose(store: Store): Finding[] {
  const { tasks, failures } = store.scan();
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const findings: Finding[] = [];
  const add = (
    code: FindingCode,
    severity: 'error' | 'warning',
    fixable: boolean,
    fileOrId: string,
    message: string,
    id?: string,
  ): void => {
    findings.push({ code, severity, fixable, file: fileOrId, message, id });
  };

  for (const failure of failures) {
    add(
      failure.code === 'parse' ? 'unreadable-file' : 'id-mismatch',
      'error',
      false,
      failure.file,
      failure.error,
    );
  }

  for (const task of tasks) {
    const file = store.path(task.id);
    if (task.parent !== undefined && !byId.has(task.parent)) {
      add('dangling-parent', 'error', true, file, `parent ${task.parent} does not exist`, task.id);
    }
    for (const blockerId of task.blockedBy) {
      if (!byId.has(blockerId)) {
        add('dangling-blocker', 'error', true, file, `blocker ${blockerId} does not exist`, task.id);
      }
    }
    for (const replacementId of task.replacedBy) {
      if (!byId.has(replacementId) || replacementId === task.id) {
        add(
          'dangling-replacement',
          'error',
          true,
          file,
          `replacement ${replacementId} ${replacementId === task.id ? 'is the task itself' : 'does not exist'}`,
          task.id,
        );
      }
    }
  }

  const byRank = new Map<number, Task[]>();
  for (const task of tasks) {
    byRank.set(task.priority, [...(byRank.get(task.priority) ?? []), task]);
  }
  for (const [rank, group] of byRank) {
    if (group.length < 2) continue;
    const ids = group.map((t) => t.id);
    add(
      'duplicate-rank',
      'warning',
      true,
      store.path(ids[0]!),
      `${ids.join(', ')} all have rank ${rank}; their order is ambiguous`,
      ids[0],
    );
  }

  for (const loop of findLoops(tasks, (t) => (t.parent !== undefined ? [t.parent] : []), byId)) {
    add(
      'parent-cycle',
      'error',
      false,
      store.path(loop[0]!),
      `parent cycle: ${[...loop, loop[0]].join(' → ')}`,
      loop[0],
    );
  }
  const dependencyLoops = findLoops(tasks, (t) => t.blockedBy, byId);
  for (const loop of dependencyLoops) {
    add(
      'dependency-cycle',
      'error',
      false,
      store.path(loop[0]!),
      `dependency cycle: ${[...loop, loop[0]].join(' → ')}`,
      loop[0],
    );
  }

  // Ordering across a dependency loop has no fix until the loop is cut, so
  // tasks on one are exempt from the order check.
  const onDependencyLoop = new Set(dependencyLoops.flat());
  for (const task of tasks) {
    if (!isActive(task)) continue;
    for (const blockerId of task.blockedBy) {
      const blocker = byId.get(blockerId);
      if (blocker === undefined || !isActive(blocker)) continue;
      if (onDependencyLoop.has(task.id) || onDependencyLoop.has(blockerId)) continue;
      if (task.priority <= blocker.priority) {
        add(
          'order-violation',
          'warning',
          true,
          store.path(task.id),
          `${task.id} (rank ${task.priority}) outranks its blocker ${blockerId} (rank ${blocker.priority})`,
          task.id,
        );
      }
    }
  }

  for (const task of tasks) {
    const file = store.path(task.id);
    for (const blockerId of task.blockedBy) {
      const blocker = byId.get(blockerId);
      if (blocker?.status === 'cancelled') {
        add(
          'cancelled-blocker',
          'warning',
          true,
          file,
          `${task.id} still waits on cancelled ${blockerId}` +
            (blocker.replacedBy.length > 0 ? ` (replaced by ${blocker.replacedBy.join(', ')})` : ''),
          task.id,
        );
      }
    }
    const parent = task.parent !== undefined ? byId.get(task.parent) : undefined;
    if (parent?.status === 'cancelled' && isActive(task)) {
      add(
        'cancelled-parent',
        'warning',
        false,
        file,
        `${task.id} is active under cancelled parent ${parent.id}`,
        task.id,
      );
    }
    if (
      task.type === 'decision' &&
      task.status === 'done' &&
      task.resolvedAt === undefined &&
      !/^## Outcome$/m.test(task.body)
    ) {
      add(
        'unresolved-decision',
        'warning',
        false,
        file,
        `decision ${task.id} is done but has no recorded outcome — use planny resolve`,
        task.id,
      );
    }
  }

  const severityOrder = { error: 0, warning: 1 };
  return findings.sort(
    (a, b) =>
      severityOrder[a.severity] - severityOrder[b.severity] ||
      a.code.localeCompare(b.code) ||
      a.file.localeCompare(b.file),
  );
}

/** Each loop reported once, as the ids along it. */
function findLoops(
  tasks: Task[],
  edges: (task: Task) => string[],
  byId: Map<string, Task>,
): string[][] {
  const color = new Map<string, 'on-stack' | 'done'>();
  const stack: string[] = [];
  const loops: string[][] = [];
  const seenLoops = new Set<string>();

  const visit = (id: string): void => {
    color.set(id, 'on-stack');
    stack.push(id);
    for (const next of edges(byId.get(id)!)) {
      if (!byId.has(next)) continue;
      const state = color.get(next);
      if (state === 'on-stack') {
        const loop = stack.slice(stack.indexOf(next));
        const key = [...loop].sort().join(',');
        if (!seenLoops.has(key)) {
          seenLoops.add(key);
          loops.push(loop);
        }
      } else if (state === undefined) {
        visit(next);
      }
    }
    stack.pop();
    color.set(id, 'done');
  };

  for (const task of tasks) {
    if (!color.has(task.id)) visit(task.id);
  }
  return loops;
}

export interface FixResult {
  /** Findings from the first diagnosis that the run repaired. */
  applied: Finding[];
  /** What a fresh diagnosis still reports. */
  remaining: Finding[];
}

export function fixStore(store: Store): FixResult {
  const before = diagnose(store);
  const { tasks } = store.scan();
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const graph = buildGraph(tasks);
  const changedMeaning = new Set<string>();
  const changedRank = new Set<string>();

  for (const task of tasks) {
    if (task.parent !== undefined && !byId.has(task.parent)) {
      task.parent = undefined;
      changedMeaning.add(task.id);
    }
    const keptBlockers: string[] = [];
    for (const blockerId of task.blockedBy) {
      const blocker = byId.get(blockerId);
      if (blocker === undefined) {
        changedMeaning.add(task.id); // dangling: drop
        continue;
      }
      if (blocker.status === 'cancelled') {
        changedMeaning.add(task.id); // rewire onto the replacements, as cancel does
        for (const replacementId of blocker.replacedBy) {
          if (!byId.has(replacementId) || replacementId === task.id) continue;
          if (keptBlockers.includes(replacementId)) continue;
          if (graph.wouldCycleDependency(task.id, replacementId)) continue;
          keptBlockers.push(replacementId);
        }
        continue;
      }
      if (!keptBlockers.includes(blockerId)) keptBlockers.push(blockerId);
    }
    task.blockedBy = keptBlockers;
    const keptReplacements = task.replacedBy.filter((id) => byId.has(id) && id !== task.id);
    if (keptReplacements.length !== task.replacedBy.length) {
      task.replacedBy = keptReplacements;
      changedMeaning.add(task.id);
    }
  }

  const ranks = new Set(tasks.map((t) => t.priority));
  if (ranks.size !== tasks.length) {
    let rank = 10;
    const ordered = [...tasks].sort(
      (a, b) => a.priority - b.priority || Number(a.id.slice(1)) - Number(b.id.slice(1)),
    );
    for (const task of ordered) {
      if (task.priority !== rank) {
        task.priority = rank;
        changedRank.add(task.id);
      }
      rank += 10;
    }
  }

  // Cutting a dependency loop is a judgement call, and the order repair
  // cannot settle while one exists.
  if (!before.some((f) => f.code === 'dependency-cycle')) {
    for (const id of repairDependencyOrder(tasks)) changedRank.add(id);
  }

  const now = new Date().toISOString();
  for (const task of tasks) {
    if (changedMeaning.has(task.id)) task.updated = now;
    if (changedMeaning.has(task.id) || changedRank.has(task.id)) store.save(task);
  }

  const remaining = diagnose(store);
  const stillThere = new Set(remaining.map((f) => `${f.code}|${f.file}|${f.message}`));
  const applied = before.filter(
    (f) => f.fixable && !stillThere.has(`${f.code}|${f.file}|${f.message}`),
  );
  return { applied, remaining };
}
