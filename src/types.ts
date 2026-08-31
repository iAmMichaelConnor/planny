export const STATUSES = ['todo', 'in-progress', 'done', 'cancelled'] as const;
export type Status = (typeof STATUSES)[number];

export const TASK_TYPES = ['task', 'decision'] as const;
export type TaskType = (typeof TASK_TYPES)[number];

/** Statuses that count as still needing work. */
export const ACTIVE_STATUSES: readonly Status[] = ['todo', 'in-progress'];

/** One status change: when, to what, and by whom (a session id or label). */
export interface HistoryEntry {
  at: string;
  status: Status;
  by?: string;
}

export interface Task {
  id: string;
  name: string;
  status: Status;
  type: TaskType;
  /** Who owns the task: 'ai' | 'operator' by convention, open to new kinds. */
  kind: string;
  /** Preferred model for an ai task; advisory only. */
  model?: string;
  /** Rank: lower number = higher priority. Sparse integers. */
  priority: number;
  parent?: string;
  /** Ids of tasks that must finish before this one. Canonical side; "blocking" is derived. */
  blockedBy: string[];
  /** For cancelled tasks: ids of tasks that replace this one. */
  replacedBy: string[];
  created: string;
  updated: string;
  /** Session id or label of whoever created the task. */
  createdBy?: string;
  /** Status changes, oldest first. Written only by ops. */
  history: HistoryEntry[];
  /** For decisions: when the operator resolved it. */
  resolvedAt?: string;
  /** Markdown description. For decisions, uses the structured section layout. */
  body: string;
}

export function isStatus(value: unknown): value is Status {
  return typeof value === 'string' && (STATUSES as readonly string[]).includes(value);
}

export function isTaskType(value: unknown): value is TaskType {
  return typeof value === 'string' && (TASK_TYPES as readonly string[]).includes(value);
}

export function isActive(task: Task): boolean {
  return ACTIVE_STATUSES.includes(task.status);
}

/** The session holding an in-progress task: the latest starter on record. */
export function holderOf(task: Task): { by?: string; at: string } | undefined {
  if (task.status !== 'in-progress') return undefined;
  for (let i = task.history.length - 1; i >= 0; i--) {
    const entry = task.history[i]!;
    if (entry.status === 'in-progress') return { by: entry.by, at: entry.at };
  }
  return undefined;
}

/**
 * Actor ids are hierarchical: an orchestrator suffixes per subagent
 * (sess-abc/builder). Two actors sharing the root before the first '/'
 * are one team.
 */
export function sameTeam(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  return a.split('/')[0] === b.split('/')[0];
}
