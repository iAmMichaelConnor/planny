import { buildGraph, type Graph } from './graph.js';
import { sortByPriority } from './priority.js';
import { computeProgress, type Progress } from './query.js';
import { isActive, type Status, type Task, type TaskType } from './types.js';

/** Text output: markdown export, terminal lists and trees. Read-only. */

const STATUS_MARK: Record<Status, string> = {
  todo: '[ ]',
  'in-progress': '[~]',
  done: '[x]',
  cancelled: '[-]',
};

export interface ListRenderOptions {
  status?: Status[];
  kind?: string;
  type?: TaskType;
}

export function taskLabel(task: Task, graph: Graph, showBlockers = true): string {
  const parts = [`${STATUS_MARK[task.status]} ${task.id} ${task.name}`];
  if (task.type === 'decision') parts.push('(decision)');
  if (task.kind !== 'ai') parts.push(`(${task.kind})`);
  const blockers = showBlockers ? graph.activeBlockers(task.id) : [];
  if (blockers.length > 0) parts.push(`— waits on ${blockers.map((t) => t.id).join(', ')}`);
  if (task.status === 'cancelled' && task.replacedBy.length > 0) {
    parts.push(`— replaced by ${task.replacedBy.join(', ')}`);
  }
  return parts.join(' ');
}

function matches(task: Task, options: ListRenderOptions): boolean {
  if (options.status !== undefined && !options.status.includes(task.status)) return false;
  if (options.kind !== undefined && task.kind !== options.kind) return false;
  if (options.type !== undefined && task.type !== options.type) return false;
  return true;
}

/**
 * The hierarchy as nested markdown bullets. Filtered-out ancestors of a
 * matching task stay visible so the match keeps its context.
 */
export function renderTaskList(tasks: Task[], options: ListRenderOptions): string {
  const graph = buildGraph(tasks);
  const visible = new Set<string>();
  for (const task of tasks) {
    if (!matches(task, options)) continue;
    visible.add(task.id);
    for (const ancestor of graph.ancestors(task.id)) visible.add(ancestor.id);
  }
  const lines: string[] = [];
  const walk = (task: Task, depth: number): void => {
    if (visible.has(task.id)) {
      lines.push(`${'  '.repeat(depth)}- ${taskLabel(task, graph)}`);
    }
    for (const child of graph.children(task.id)) walk(child, depth + 1);
  };
  for (const root of graph.roots()) walk(root, 0);
  return lines.length > 0 ? lines.join('\n') : '_No tasks._';
}

/**
 * The dependency order as nested bullets: a task is indented under each task
 * that blocks it. A task with several blockers appears once per blocker,
 * annotated with the others.
 */
export function renderDependencyForest(tasks: Task[]): string {
  const graph = buildGraph(tasks);
  const present = new Set(tasks.map((t) => t.id));
  const hasEdges = tasks.some((t) => t.blockedBy.some((id) => present.has(id)));
  if (!hasEdges) return '_No dependencies between tasks._';

  const lines: string[] = [];
  const walk = (task: Task, depth: number, via: string | undefined): void => {
    const others = task.blockedBy.filter((id) => id !== via && present.has(id));
    const note = via !== undefined && others.length > 0 ? ` (also waits on ${others.join(', ')})` : '';
    lines.push(`${'  '.repeat(depth)}- ${taskLabel(task, graph, false)}${note}`);
    for (const blocked of graph.blocking(task.id)) walk(blocked, depth + 1, task.id);
  };
  const roots = sortByPriority(
    tasks.filter(
      (t) => graph.blocking(t.id).length > 0 && !t.blockedBy.some((id) => present.has(id)),
    ),
  );
  for (const root of roots) walk(root, 0, undefined);
  return lines.join('\n');
}

export function renderProgressLine(progress: Progress): string {
  const width = 20;
  const filled = Math.round((progress.percent / 100) * width);
  const bar = '█'.repeat(filled) + '░'.repeat(width - filled);
  const counts = [
    `${progress.done}/${progress.total} done`,
    `${progress.byStatus['in-progress']} in progress`,
    `${progress.byStatus.todo} to do`,
  ];
  return `${bar} ${progress.percent}% — ${counts.join(', ')}`;
}

/** Full detail for one task, for the terminal. */
export function renderShow(task: Task, allTasks: Task[], filePath: string): string {
  const graph = buildGraph(allTasks);
  const named = (t: Task): string => `${t.id} ${t.name}`;
  const lines: string[] = [];
  lines.push(`${task.id} — ${task.name}`);
  const facts = [`status: ${task.status}`, `type: ${task.type}`, `kind: ${task.kind}`];
  if (task.model !== undefined) facts.push(`model: ${task.model}`);
  lines.push(facts.join('   '));

  const position = activePosition(allTasks, task);
  if (position !== undefined) lines.push(`position: ${position.index} of ${position.total} active`);

  const ancestors = graph.ancestors(task.id);
  if (ancestors.length > 0) {
    lines.push(`path: ${[...ancestors].reverse().map(named).join(' > ')}`);
  }
  const children = graph.children(task.id);
  if (children.length > 0) lines.push(`children: ${children.map(named).join('; ')}`);
  if (task.blockedBy.length > 0) {
    const blockerLine = task.blockedBy
      .map((id) => {
        const blocker = graph.get(id);
        return blocker === undefined ? id : `${named(blocker)} [${blocker.status}]`;
      })
      .join('; ');
    lines.push(`waits on: ${blockerLine}`);
  }
  const blocking = graph.blocking(task.id);
  if (blocking.length > 0) lines.push(`blocks: ${blocking.map(named).join('; ')}`);
  if (task.replacedBy.length > 0) lines.push(`replaced by: ${task.replacedBy.join(', ')}`);
  lines.push(`file: ${filePath}`);
  lines.push(`created: ${task.created}   updated: ${task.updated}`);
  if (task.resolvedAt !== undefined) lines.push(`resolved: ${task.resolvedAt}`);
  if (task.body !== '') lines.push('', task.body);
  return lines.join('\n');
}

function activePosition(
  tasks: Task[],
  task: Task,
): { index: number; total: number } | undefined {
  if (!isActive(task)) return undefined;
  const active = sortByPriority(tasks.filter(isActive));
  return { index: active.findIndex((t) => t.id === task.id) + 1, total: active.length };
}

export interface ExportOptions extends ListRenderOptions {}

/** A complete plan.md: progress, hierarchy, dependencies, open decisions. */
export function renderExport(tasks: Task[], options: ExportOptions): string {
  const graph = buildGraph(tasks);
  const sections = [
    '# Plan',
    renderProgressLine(computeProgress(tasks)),
    '## Tasks',
    renderTaskList(tasks, options),
    '## Dependencies',
    renderDependencyForest(tasks),
  ];
  const open = sortByPriority(tasks.filter((t) => t.type === 'decision' && isActive(t)));
  if (open.length > 0) {
    sections.push(
      '## Open decisions',
      open.map((t) => `- ${taskLabel(t, graph)}`).join('\n'),
    );
  }
  return `${sections.join('\n\n')}\n`;
}
