import { existsSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildGraph } from './graph.js';
import { withLock } from './lock.js';
import { viableReplacements } from './ops.js';
import { repairDependencyOrder, resequenceRanks } from './priority.js';
import { TASK_FILE_RE, type Store } from './store.js';
import { holderOf, isActive, type Task } from './types.js';

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
  | 'unresolved-decision'
  | 'history-order'
  | 'status-history-mismatch'
  | 'unclaimed-in-progress'
  | 'stray-replaced-by'
  | 'foreign-file'
  | 'cursors-unreadable'
  | 'cursor-in-future'
  | 'stale-lock';

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

  // Files the CLI never writes are invisible to every command — a task
  // dropped in by hand would sit there unseen. Surface them; importing
  // or deleting has no single right answer, so there is no auto-fix.
  for (const name of readdirSync(store.tasksDir)) {
    if (!TASK_FILE_RE.test(name)) {
      add(
        'foreign-file',
        'warning',
        false,
        join(store.tasksDir, name),
        `"${name}" is not a file the CLI writes — planny ignores it; if it holds a task, recreate it with planny add and delete the file`,
      );
    }
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

  for (const task of tasks) {
    const file = store.path(task.id);
    if (historyOutOfOrder(task)) {
      add('history-order', 'warning', true, file, `${task.id} history entries are out of time order`, task.id);
    }
    const lastStatus = [...task.history].reverse().find((e) => 'status' in e);
    if (lastStatus !== undefined && 'status' in lastStatus && lastStatus.status !== task.status) {
      add(
        'status-history-mismatch',
        'warning',
        false,
        file,
        `${task.id} is ${task.status} but its history ends at ${lastStatus.status} — one of the two was hand-edited`,
        task.id,
      );
    }
    if (task.status === 'in-progress' && holderOf(task) === undefined) {
      add(
        'unclaimed-in-progress',
        'warning',
        false,
        file,
        `${task.id} is in progress with no record of who started it`,
        task.id,
      );
    }
    if (task.status !== 'cancelled' && task.replacedBy.length > 0) {
      add(
        'stray-replaced-by',
        'warning',
        false,
        file,
        `${task.id} is ${task.status} but lists replacements (${task.replacedBy.join(', ')}) — only cancelled tasks carry replaced_by`,
        task.id,
      );
    }
  }

  const cursorsFile = join(store.root, '.planny', 'cursors.json');
  if (existsSync(cursorsFile)) {
    try {
      const cursors = JSON.parse(readFileSync(cursorsFile, 'utf8')) as Record<string, unknown>;
      for (const [consumer, at] of Object.entries(cursors)) {
        if (typeof at !== 'string' || Number.isNaN(Date.parse(at))) {
          add('cursors-unreadable', 'error', true, cursorsFile, `cursor for "${consumer}" is not a time`);
        } else if (Date.parse(at) > Date.now() + FUTURE_SLACK_MS) {
          add(
            'cursor-in-future',
            'warning',
            true,
            cursorsFile,
            `cursor for "${consumer}" is in the future (${at}) and would suppress deliveries`,
          );
        }
      }
    } catch {
      add(
        'cursors-unreadable',
        'error',
        true,
        cursorsFile,
        'cursors.json is not valid JSON — resetting it is safe (consumers just re-receive)',
      );
    }
  }

  const lockFile = join(store.root, '.planny', 'lock');
  if (existsSync(lockFile)) {
    try {
      const age = Date.now() - statSync(lockFile).mtimeMs;
      const staleAfter = Number(process.env.PLANNY_LOCK_STALE_MS ?? 10_000);
      if (age > staleAfter) {
        add(
          'stale-lock',
          'warning',
          true,
          lockFile,
          `lock file is ${Math.round(age / 1000)}s old — its holder is likely gone; the next write breaks it`,
        );
      }
    } catch {
      // the lock was released between the existence check and stat
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

const FUTURE_SLACK_MS = 60_000;

function historyOutOfOrder(task: Task): boolean {
  for (let i = 1; i < task.history.length; i++) {
    if (Date.parse(task.history[i]!.at) < Date.parse(task.history[i - 1]!.at)) return true;
  }
  return false;
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
  return withLock(store.root, () => doFixStore(store));
}

function doFixStore(store: Store): FixResult {
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
        const { attach } = viableReplacements(graph, task.id, blocker);
        for (const replacementId of attach) {
          if (byId.has(replacementId) && !keptBlockers.includes(replacementId)) {
            keptBlockers.push(replacementId);
          }
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
    for (const id of resequenceRanks(tasks)) changedRank.add(id);
  }

  // Cutting a dependency loop is a judgement call, and the order repair
  // cannot settle while one exists.
  if (!before.some((f) => f.code === 'dependency-cycle')) {
    for (const id of repairDependencyOrder(tasks)) changedRank.add(id);
  }

  // Sorting a shuffled history has one right answer (stable by time).
  for (const task of tasks) {
    if (historyOutOfOrder(task)) {
      task.history = [...task.history].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
      changedRank.add(task.id); // saved without a timestamp bump, like rank repairs
    }
  }

  // Cursor repairs are safe by contract: dropping a cursor only causes
  // re-delivery, and delivery is at-least-once.
  const cursorsFile = join(store.root, '.planny', 'cursors.json');
  if (existsSync(cursorsFile)) {
    try {
      const cursors = JSON.parse(readFileSync(cursorsFile, 'utf8')) as Record<string, unknown>;
      let dirty = false;
      for (const [consumer, at] of Object.entries(cursors)) {
        if (
          typeof at !== 'string' ||
          Number.isNaN(Date.parse(at)) ||
          Date.parse(at) > Date.now() + FUTURE_SLACK_MS
        ) {
          delete cursors[consumer];
          dirty = true;
        }
      }
      if (dirty) writeFileSync(cursorsFile, `${JSON.stringify(cursors, null, 2)}\n`);
    } catch {
      unlinkSync(cursorsFile);
    }
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
