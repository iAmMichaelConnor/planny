import { buildGraph, type Graph } from './graph.js';
import { bumpPriority, repairDependencyOrder, type BumpTarget } from './priority.js';
import type { Store } from './store.js';
import { isActive, type Status, type Task, type TaskType } from './types.js';

/**
 * Every mutation of the task store goes through this module. The CLI and the
 * localhost server both call these functions; nothing else writes task files.
 */

export interface OpResult {
  task: Task;
  warnings: string[];
  /** Ids of every task file rewritten by the operation. */
  changed: string[];
}

export interface AddInput {
  name: string;
  body?: string;
  type?: TaskType;
  kind?: string;
  model?: string;
  parent?: string;
  /** Existing tasks to re-parent onto the new task. */
  children?: string[];
  blockedBy?: string[];
  /** Existing tasks that must wait for the new task. */
  blocks?: string[];
  priority?: BumpTarget;
}

export interface UpdateInput {
  name?: string;
  body?: string;
  appendBody?: string;
  kind?: string;
  type?: TaskType;
  /** null clears the field. */
  model?: string | null;
  /** null clears the field. */
  parent?: string | null;
  addChildren?: string[];
  removeChildren?: string[];
  addBlockedBy?: string[];
  removeBlockedBy?: string[];
  addBlocks?: string[];
  removeBlocks?: string[];
  priority?: BumpTarget;
}

/** In-memory working set for one operation; saves changed files on commit. */
class Mutation {
  readonly tasks: Task[];
  readonly warnings: string[] = [];
  private readonly byId: Map<string, Task>;
  private readonly touched = new Set<string>();
  private readonly rankChanged = new Set<string>();

  constructor(private readonly store: Store) {
    this.tasks = store.loadAll();
    this.byId = new Map(this.tasks.map((t) => [t.id, t]));
  }

  get(id: string): Task {
    const task = this.byId.get(id);
    if (task === undefined) throw new Error(`no task ${id}`);
    return task;
  }

  add(task: Task): void {
    this.tasks.push(task);
    this.byId.set(task.id, task);
    this.touched.add(task.id);
  }

  touch(id: string): void {
    this.touched.add(id);
  }

  warn(message: string): void {
    this.warnings.push(message);
  }

  graph(): Graph {
    return buildGraph(this.tasks);
  }

  bump(id: string, target: BumpTarget): void {
    for (const changedId of bumpPriority(this.tasks, id, target)) {
      this.rankChanged.add(changedId);
    }
  }

  /** Repair the dependency-order invariant, then write every changed file. */
  commit(): void {
    for (const id of repairDependencyOrder(this.tasks)) this.rankChanged.add(id);
    const now = new Date().toISOString();
    for (const id of this.touched) {
      const task = this.get(id);
      task.updated = now;
      this.store.save(task);
    }
    for (const id of this.rankChanged) {
      if (!this.touched.has(id)) this.store.save(this.get(id));
    }
  }

  result(task: Task): OpResult {
    return {
      task,
      warnings: this.warnings,
      changed: [...new Set([...this.touched, ...this.rankChanged])],
    };
  }
}

function requireName(name: string): string {
  const trimmed = name.trim();
  if (trimmed === '') throw new Error('task name must not be empty');
  return trimmed;
}

function setParent(m: Mutation, childId: string, parentId: string | undefined): void {
  const child = m.get(childId);
  if (parentId !== undefined) {
    m.get(parentId);
    if (m.graph().wouldCycleParent(childId, parentId)) {
      throw new Error(`parent cycle: ${parentId} is ${childId} or one of its descendants`);
    }
  }
  child.parent = parentId;
  m.touch(childId);
}

function addBlocker(m: Mutation, taskId: string, blockerId: string): void {
  const task = m.get(taskId);
  m.get(blockerId);
  if (task.blockedBy.includes(blockerId)) return;
  if (m.graph().wouldCycleDependency(taskId, blockerId)) {
    throw new Error(`dependency cycle: ${blockerId} already waits on ${taskId}`);
  }
  task.blockedBy.push(blockerId);
  m.touch(taskId);
}

function removeBlocker(m: Mutation, taskId: string, blockerId: string): void {
  const task = m.get(taskId);
  if (!task.blockedBy.includes(blockerId)) return;
  task.blockedBy = task.blockedBy.filter((id) => id !== blockerId);
  m.touch(taskId);
}

export function addTask(store: Store, input: AddInput): OpResult {
  const m = new Mutation(store);
  const now = new Date().toISOString();
  const task: Task = {
    id: store.nextId(),
    name: requireName(input.name),
    status: 'todo',
    type: input.type ?? 'task',
    kind: input.kind ?? 'ai',
    model: input.model,
    priority: Number.MAX_SAFE_INTEGER, // placed by bump below
    parent: undefined,
    blockedBy: [],
    replacedBy: [],
    created: now,
    updated: now,
    body: input.body ?? '',
  };
  m.add(task);
  if (input.parent !== undefined) setParent(m, task.id, input.parent);
  for (const childId of input.children ?? []) setParent(m, childId, task.id);
  for (const blockerId of input.blockedBy ?? []) addBlocker(m, task.id, blockerId);
  for (const blockedId of input.blocks ?? []) addBlocker(m, blockedId, task.id);
  m.bump(task.id, input.priority ?? 'bottom');
  m.commit();
  return m.result(task);
}

export function updateTask(store: Store, id: string, input: UpdateInput): OpResult {
  const m = new Mutation(store);
  const task = m.get(id);

  if (input.name !== undefined) task.name = requireName(input.name);
  if (input.body !== undefined) task.body = input.body;
  if (input.appendBody !== undefined) {
    task.body = task.body === '' ? input.appendBody : `${task.body}\n\n${input.appendBody}`;
  }
  if (input.kind !== undefined) task.kind = input.kind;
  if (input.type !== undefined) task.type = input.type;
  if (input.model !== undefined) task.model = input.model ?? undefined;

  if (input.parent !== undefined) setParent(m, id, input.parent ?? undefined);
  for (const childId of input.addChildren ?? []) setParent(m, childId, id);
  for (const childId of input.removeChildren ?? []) {
    if (m.get(childId).parent === id) setParent(m, childId, undefined);
    else m.warn(`${childId} is not a child of ${id}; nothing removed`);
  }
  for (const blockerId of input.addBlockedBy ?? []) addBlocker(m, id, blockerId);
  for (const blockerId of input.removeBlockedBy ?? []) removeBlocker(m, id, blockerId);
  for (const blockedId of input.addBlocks ?? []) addBlocker(m, blockedId, id);
  for (const blockedId of input.removeBlocks ?? []) removeBlocker(m, blockedId, id);

  m.touch(id);
  if (input.priority !== undefined) m.bump(id, input.priority);
  m.commit();
  return m.result(task);
}

export function setStatus(store: Store, id: string, status: Exclude<Status, 'cancelled'>): OpResult {
  const m = new Mutation(store);
  const task = m.get(id);
  if (status === 'done') {
    const graph = m.graph();
    const blockers = graph.activeBlockers(id);
    if (blockers.length > 0) {
      m.warn(`${id} is still blocked by ${blockers.map((t) => t.id).join(', ')}`);
    }
    const activeChildren = graph.children(id).filter(isActive);
    if (activeChildren.length > 0) {
      m.warn(`${id} still has active children: ${activeChildren.map((t) => t.id).join(', ')}`);
    }
    if (task.type === 'decision' && task.resolvedAt === undefined) {
      m.warn(`${id} is a decision — prefer \`planny resolve ${id} --response ...\` to record the outcome`);
    }
  }
  task.status = status;
  if (status === 'todo') task.replacedBy = [];
  m.touch(id);
  m.commit();
  return m.result(task);
}

export function cancelTask(store: Store, id: string, replacedBy: string[] = []): OpResult {
  const m = new Mutation(store);
  const task = m.get(id);
  const replacements = [...new Set(replacedBy)];
  for (const replacementId of replacements) {
    m.get(replacementId);
    if (replacementId === id) throw new Error(`${id} cannot replace itself`);
  }
  task.status = 'cancelled';
  task.replacedBy = replacements;
  m.touch(id);

  // Dependants stop waiting on the cancelled task and wait on its
  // replacements instead.
  for (const other of m.tasks) {
    if (other.id === id || !other.blockedBy.includes(id)) continue;
    removeBlocker(m, other.id, id);
    for (const replacementId of replacements) {
      if (replacementId === other.id) continue;
      if (m.graph().wouldCycleDependency(other.id, replacementId)) {
        m.warn(`did not rewire ${other.id} onto ${replacementId}: it would create a dependency cycle`);
        continue;
      }
      addBlocker(m, other.id, replacementId);
    }
  }

  const activeChildren = m.graph().children(id).filter(isActive);
  if (activeChildren.length > 0) {
    m.warn(
      `cancelled ${id} still has active children: ${activeChildren.map((t) => t.id).join(', ')} — re-parent or cancel them too`,
    );
  }
  m.commit();
  return m.result(task);
}

export function resolveDecision(store: Store, id: string, response: string): OpResult {
  const m = new Mutation(store);
  const task = m.get(id);
  if (task.type !== 'decision') {
    throw new Error(`${id} is not a decision task — use \`planny done\` for plain tasks`);
  }
  const outcome = `## Outcome\n\n${response.trim()}`;
  task.body = task.body === '' ? outcome : `${task.body}\n\n${outcome}`;
  task.status = 'done';
  task.resolvedAt = new Date().toISOString();
  m.touch(id);
  m.commit();
  return m.result(task);
}

export function bumpTask(store: Store, id: string, target: BumpTarget): OpResult {
  const m = new Mutation(store);
  const task = m.get(id);
  m.touch(id);
  m.bump(id, target);
  m.commit();
  return m.result(task);
}
