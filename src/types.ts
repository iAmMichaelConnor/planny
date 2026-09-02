export const STATUSES = ['todo', 'in-progress', 'parked', 'done', 'cancelled'] as const;
export type Status = (typeof STATUSES)[number];

export const TASK_TYPES = ['task', 'decision'] as const;
export type TaskType = (typeof TASK_TYPES)[number];

/**
 * Statuses that count as still needing work. Parked belongs here: parked work
 * keeps its priority rank, still blocks whatever waits on it, and still counts
 * as not done. Only the queues — `next` and `decisions` — pass it over.
 */
export const ACTIVE_STATUSES: readonly Status[] = ['todo', 'in-progress', 'parked'];

/**
 * One recorded change: when, what, and by whom (a session id or label).
 * Status entries keep the original {at, status, by} shape; other changes
 * carry an `event` discriminator. Mechanical rank renumbering never logs.
 */
export type HistoryEntry =
  | { at: string; by?: string; status: Status }
  | { at: string; by?: string; event: 'priority'; target: string; position: number }
  | { at: string; by?: string; event: 'parent'; from?: string; to?: string }
  | { at: string; by?: string; event: 'blocked-by'; added?: string[]; removed?: string[] }
  | { at: string; by?: string; event: 'rename'; from: string; to: string };

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
  /** For parked tasks: free text saying what should bring the task back. */
  parkedUntil?: string;
  /** Markdown description. For decisions, uses the structured section layout. */
  body: string;
  /**
   * Frontmatter keys this version does not recognize, preserved verbatim
   * so hand-added fields and newer versions' fields survive a rewrite.
   */
  extras?: Record<string, unknown>;
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
    if ('status' in entry && entry.status === 'in-progress') return { by: entry.by, at: entry.at };
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
