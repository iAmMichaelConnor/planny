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
