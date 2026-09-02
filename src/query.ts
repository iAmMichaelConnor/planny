import { buildGraph } from './graph.js';
import { sortByPriority } from './priority.js';
import type { Store } from './store.js';
import { isActive, type Status, type Task, type TaskType } from './types.js';

/** Read-side queries. Nothing here writes task files. */

export interface ListFilter {
  status?: Status[];
  kind?: string;
  type?: TaskType;
  model?: string;
  /** Restrict to children of this task; with recursive, all descendants. */
  parent?: string;
  recursive?: boolean;
  /** true: only blocked tasks; false: only unblocked tasks. */
  blocked?: boolean;
  /** Keep only tasks updated at or after this ISO time. */
  changedSince?: string;
}

export function listTasks(store: Store, filter: ListFilter): Task[] {
  const tasks = store.loadAll();
  const graph = buildGraph(tasks);
  let scope: Set<string> | undefined;
  if (filter.parent !== undefined) {
    const members = filter.recursive
      ? graph.descendants(filter.parent)
      : graph.children(filter.parent);
    scope = new Set(members.map((t) => t.id));
  }
  return sortByPriority(
    tasks.filter((task) => {
      if (scope !== undefined && !scope.has(task.id)) return false;
      if (filter.status !== undefined && !filter.status.includes(task.status)) return false;
      if (filter.kind !== undefined && task.kind !== filter.kind) return false;
      if (filter.type !== undefined && task.type !== filter.type) return false;
      if (filter.model !== undefined && task.model !== filter.model) return false;
      if (filter.blocked !== undefined && graph.isBlocked(task.id) !== filter.blocked) return false;
      if (
        filter.changedSince !== undefined &&
        Date.parse(task.updated) < Date.parse(filter.changedSince)
      ) {
        return false;
      }
      return true;
    }),
  );
}

export interface NextItem {
  task: Task;
  /** Ancestor chain, nearest first. */
  path: Task[];
  /** Active tasks that wait on this one. */
  unlocks: Task[];
}

export interface NextOptions {
  kind?: string;
  /** Restrict to the subtree under this task. */
  under?: string;
  /** Offer parked tasks too. They are skipped by default. */
  includeParked?: boolean;
}

/**
 * The tasks to work on now: active, unblocked, with no active children
 * (a parent acts through its children), in priority order.
 */
export function nextTasks(store: Store, limit: number, options: NextOptions = {}): NextItem[] {
  const tasks = store.loadAll();
  const graph = buildGraph(tasks);
  let scope: Set<string> | undefined;
  if (options.under !== undefined) {
    scope = new Set(graph.descendants(options.under).map((t) => t.id));
    scope.add(options.under);
  }
  return sortByPriority(tasks)
    .filter(
      (task) =>
        isActive(task) &&
        (options.includeParked === true || task.status !== 'parked') &&
        (scope === undefined || scope.has(task.id)) &&
        (options.kind === undefined || task.kind === options.kind) &&
        !graph.isBlocked(task.id) &&
        graph.children(task.id).filter(isActive).length === 0,
    )
    .slice(0, limit)
    .map((task) => ({
      task,
      path: graph.ancestors(task.id),
      unlocks: graph.blocking(task.id).filter(isActive),
    }));
}

export interface Progress {
  done: number;
  total: number;
  /** done / total as a whole percentage; 100 when there is nothing to do. */
  percent: number;
  byStatus: Record<Status, number>;
}

/** Completion over non-cancelled tasks, optionally scoped to a subtree. */
export function progress(store: Store, parentId?: string): Progress {
  return computeProgress(store.loadAll(), parentId);
}

/** Same as progress, over an already-loaded task list. */
export function computeProgress(tasks: Task[], parentId?: string): Progress {
  const graph = buildGraph(tasks);
  let scoped = tasks;
  if (parentId !== undefined) {
    graph.get(parentId) ?? raise(`no task ${parentId}`);
    scoped = [graph.get(parentId)!, ...graph.descendants(parentId)];
  }
  const byStatus: Record<Status, number> = {
    todo: 0,
    'in-progress': 0,
    parked: 0,
    done: 0,
    cancelled: 0,
  };
  for (const task of scoped) byStatus[task.status] += 1;
  const total = scoped.length - byStatus.cancelled;
  const done = byStatus.done;
  return {
    done,
    total,
    percent: total === 0 ? 100 : Math.round((done / total) * 100),
    byStatus,
  };
}

export interface DecisionItem {
  task: Task;
  /** True while another active task still blocks this decision. */
  blocked: boolean;
}

export interface DecisionOptions {
  /** List parked decisions too. They are skipped by default. */
  includeParked?: boolean;
}

/** Active decisions in the order to work through them: unblocked first, then by priority. */
export function nextDecisions(store: Store, options: DecisionOptions = {}): DecisionItem[] {
  const tasks = store.loadAll();
  const graph = buildGraph(tasks);
  const decisions = sortByPriority(
    tasks.filter(
      (t) =>
        t.type === 'decision' &&
        isActive(t) &&
        (options.includeParked === true || t.status !== 'parked'),
    ),
  );
  const ready = decisions.filter((t) => !graph.isBlocked(t.id));
  const waiting = decisions.filter((t) => graph.isBlocked(t.id));
  return [
    ...ready.map((task) => ({ task, blocked: false })),
    ...waiting.map((task) => ({ task, blocked: true })),
  ];
}

export interface ResolvedDecision {
  task: Task;
  /**
   * Tasks the decision was gating. After a resolution they wait on the
   * decision's outcome task; only its completion frees them.
   */
  dependants: Task[];
  /**
   * The outcome task carrying the answer, read from the citation ops
   * appends to the decision body. Null for rejects and for decisions
   * resolved before outcome tasks existed.
   */
  outcomeTask: string | null;
}

function outcomeTaskOf(task: Task): string | null {
  const citations = [...task.body.matchAll(/^Outcome task: (t\d+)$/gm)];
  return citations.length > 0 ? citations[citations.length - 1]![1]! : null;
}

/** Answered decisions, newest first — for an AI catching up after `planny decide`. */
export function resolvedDecisions(store: Store, since?: string): ResolvedDecision[] {
  const tasks = store.loadAll();
  const graph = buildGraph(tasks);
  return tasks
    .filter(
      (t) =>
        t.type === 'decision' &&
        t.status === 'done' &&
        (since === undefined ||
          (t.resolvedAt !== undefined && Date.parse(t.resolvedAt) >= Date.parse(since))),
    )
    .sort((a, b) => Date.parse(b.resolvedAt ?? b.updated) - Date.parse(a.resolvedAt ?? a.updated))
    .map((task) => ({ task, dependants: graph.blocking(task.id), outcomeTask: outcomeTaskOf(task) }));
}

function raise(message: string): never {
  throw new Error(message);
}
