import { buildGraph, type Graph } from './graph.js';
import { withLock } from './lock.js';
import {
  activePosition,
  bumpPriority,
  repairDependencyOrder,
  type BumpTarget,
} from './priority.js';
import type { Store } from './store.js';
import {
  holderOf,
  isActive,
  isTaskType,
  sameTeam,
  type Status,
  type Task,
  type TaskType,
} from './types.js';

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
  /**
   * Optimistic guard for body replacement: the updated stamp the caller's
   * copy was read at. When the stored task is newer and a body is being
   * written, the update is refused instead of clobbering the newer body.
   */
  ifUnchangedSince?: string;
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
    if (task === undefined) {
      const hint = /^\d+$/.test(id) ? ` (ids are prefixed — try t${id})` : '';
      throw new Error(`no task ${id}${hint} — \`planny list\` shows every id`);
    }
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

  /** Run the dependency-order repair now (commit re-runs it, harmlessly). */
  repair(): void {
    for (const id of repairDependencyOrder(this.tasks)) this.rankChanged.add(id);
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

/**
 * Input contracts live here, at the funnel, so every entry point (CLI,
 * server, future callers) inherits them — the type system alone cannot
 * protect the store from a JSON body.
 */

function requireName(name: unknown): string {
  if (typeof name !== 'string') throw new Error('task name must be a string');
  const trimmed = name.trim();
  if (trimmed === '') throw new Error('task name must not be empty');
  return trimmed;
}

function assertType(value: unknown): void {
  if (value !== undefined && !isTaskType(value)) {
    throw new Error(`unknown task type "${String(value)}" — expected task or decision`);
  }
}

function assertKind(value: unknown): void {
  if (value === undefined) return;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('kind must be a non-empty string');
  }
}

function assertOptionalString(value: unknown, field: string, nullable = false): void {
  if (value === undefined || (nullable && value === null)) return;
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
}

function assertIdList(value: unknown, field: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new Error(`${field} must be a list of task ids`);
  }
}

function assertBumpTarget(value: unknown): asserts value is BumpTarget {
  if (value === 'top' || value === 'bottom') return;
  if (typeof value === 'number' && Number.isInteger(value)) return;
  throw new Error(
    `priority must be "top", "bottom" or an integer position, not ${JSON.stringify(value)}`,
  );
}

function assertAddInput(input: AddInput): void {
  assertType(input.type);
  assertKind(input.kind);
  assertOptionalString(input.model, 'model');
  assertOptionalString(input.parent, 'parent');
  assertOptionalString(input.body, 'body');
  assertIdList(input.children, 'children');
  assertIdList(input.blockedBy, 'blockedBy');
  assertIdList(input.blocks, 'blocks');
  if (input.priority !== undefined) assertBumpTarget(input.priority);
}

function assertUpdateInput(input: UpdateInput): void {
  assertType(input.type);
  assertKind(input.kind);
  assertOptionalString(input.model, 'model', true);
  assertOptionalString(input.parent, 'parent', true);
  assertOptionalString(input.body, 'body');
  assertOptionalString(input.appendBody, 'appendBody');
  assertOptionalString(input.ifUnchangedSince, 'ifUnchangedSince');
  assertIdList(input.addChildren, 'addChildren');
  assertIdList(input.removeChildren, 'removeChildren');
  assertIdList(input.addBlockedBy, 'addBlockedBy');
  assertIdList(input.removeBlockedBy, 'removeBlockedBy');
  assertIdList(input.addBlocks, 'addBlocks');
  assertIdList(input.removeBlocks, 'removeBlocks');
  if (input.priority !== undefined) assertBumpTarget(input.priority);
}

function setParent(
  m: Mutation,
  childId: string,
  parentId: string | undefined,
  actor?: string,
  log = true,
): void {
  const child = m.get(childId);
  if (parentId !== undefined) {
    m.get(parentId);
    if (m.graph().wouldCycleParent(childId, parentId)) {
      throw new Error(
        `parent cycle: making ${parentId} the parent of ${childId} would loop the hierarchy — ${parentId} is ${childId} or one of its descendants`,
      );
    }
  }
  if (child.parent === parentId) return;
  if (log) {
    logEvent(child, actor, {
      event: 'parent',
      ...(child.parent !== undefined && { from: child.parent }),
      ...(parentId !== undefined && { to: parentId }),
    });
  }
  child.parent = parentId;
  m.touch(childId);
}

/** Returns true when the edge was actually added; the caller logs. */
function addBlocker(m: Mutation, taskId: string, blockerId: string): boolean {
  const task = m.get(taskId);
  m.get(blockerId);
  if (task.blockedBy.includes(blockerId)) return false;
  if (m.graph().wouldCycleDependency(taskId, blockerId)) {
    throw new Error(
      `dependency cycle: ${taskId} waiting on ${blockerId} would loop the dependency graph — ${blockerId} already waits on ${taskId}`,
    );
  }
  task.blockedBy.push(blockerId);
  m.touch(taskId);
  return true;
}

/** Returns true when the edge was actually removed; the caller logs. */
function removeBlocker(m: Mutation, taskId: string, blockerId: string): boolean {
  const task = m.get(taskId);
  if (!task.blockedBy.includes(blockerId)) return false;
  task.blockedBy = task.blockedBy.filter((id) => id !== blockerId);
  m.touch(taskId);
  return true;
}

/** One blocked-by history entry per task, aggregating an op's edge edits. */
function logEdgeChanges(
  m: Mutation,
  taskId: string,
  actor: string | undefined,
  added: string[],
  removed: string[],
): void {
  if (added.length === 0 && removed.length === 0) return;
  logEvent(m.get(taskId), actor, {
    event: 'blocked-by',
    ...(added.length > 0 && { added }),
    ...(removed.length > 0 && { removed }),
  });
}

export function addTask(store: Store, input: AddInput, actor?: string): OpResult {
  return withLock(store.root, () => doAddTask(store, input, actor));
}

/** Build and place a new task inside an open mutation. add and resolve share it. */
function createTask(m: Mutation, store: Store, input: AddInput, actor?: string): Task {
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
    createdBy: actor,
    history: [],
    body: input.body ?? '',
  };
  m.add(task);
  // The new task's own starting state is not history; edits to *other*
  // tasks (re-parented children, blocked targets) are.
  if (input.parent !== undefined) setParent(m, task.id, input.parent, actor, false);
  for (const childId of input.children ?? []) setParent(m, childId, task.id, actor);
  for (const blockerId of input.blockedBy ?? []) addBlocker(m, task.id, blockerId);
  for (const blockedId of input.blocks ?? []) {
    if (addBlocker(m, blockedId, task.id)) logEdgeChanges(m, blockedId, actor, [task.id], []);
  }
  m.bump(task.id, input.priority ?? 'bottom');
  return task;
}

function doAddTask(store: Store, input: AddInput, actor?: string): OpResult {
  assertAddInput(input);
  const m = new Mutation(store);
  const task = createTask(m, store, input, actor);
  m.commit();
  return m.result(task);
}

export function updateTask(
  store: Store,
  id: string,
  input: UpdateInput,
  actor?: string,
): OpResult {
  return withLock(store.root, () => doUpdateTask(store, id, input, actor));
}

function doUpdateTask(store: Store, id: string, input: UpdateInput, actor?: string): OpResult {
  assertUpdateInput(input);
  const m = new Mutation(store);
  const task = m.get(id);

  if (
    input.ifUnchangedSince !== undefined &&
    input.body !== undefined &&
    task.updated > input.ifUnchangedSince
  ) {
    throw new Error(
      `${id} changed underneath the form (stored ${task.updated}, form loaded ${input.ifUnchangedSince}) — reload the newer version, or overwrite it deliberately`,
    );
  }

  if (input.name !== undefined) {
    const name = requireName(input.name);
    if (name !== task.name) logEvent(task, actor, { event: 'rename', from: task.name, to: name });
    task.name = name;
  }
  if (input.body !== undefined) task.body = input.body;
  if (input.appendBody !== undefined) {
    task.body = task.body === '' ? input.appendBody : `${task.body}\n\n${input.appendBody}`;
  }
  if (input.kind !== undefined) task.kind = input.kind;
  if (input.type !== undefined) task.type = input.type;
  if (input.model !== undefined) task.model = input.model ?? undefined;

  if (input.parent !== undefined) setParent(m, id, input.parent ?? undefined, actor);
  for (const childId of input.addChildren ?? []) setParent(m, childId, id, actor);
  for (const childId of input.removeChildren ?? []) {
    if (m.get(childId).parent === id) setParent(m, childId, undefined, actor);
    else m.warn(`${childId} is not a child of ${id}; nothing removed`);
  }

  const added: string[] = [];
  const removed: string[] = [];
  for (const blockerId of input.addBlockedBy ?? []) {
    if (addBlocker(m, id, blockerId)) added.push(blockerId);
  }
  for (const blockerId of input.removeBlockedBy ?? []) {
    if (removeBlocker(m, id, blockerId)) removed.push(blockerId);
  }
  logEdgeChanges(m, id, actor, added, removed);
  for (const blockedId of input.addBlocks ?? []) {
    if (addBlocker(m, blockedId, id)) logEdgeChanges(m, blockedId, actor, [id], []);
  }
  for (const blockedId of input.removeBlocks ?? []) {
    if (removeBlocker(m, blockedId, id)) logEdgeChanges(m, blockedId, actor, [], [id]);
  }

  m.touch(id);
  if (input.priority !== undefined) {
    m.bump(id, input.priority);
    m.repair(); // so the logged position is the task's final resting place
    logEvent(task, actor, {
      event: 'priority',
      target: String(input.priority),
      position: activePosition(m.tasks, id).position,
    });
  }
  m.commit();
  return m.result(task);
}

/** Append a typed history record. Mechanical renumbering never comes here. */
function logEvent(task: Task, actor: string | undefined, fields: Record<string, unknown>): void {
  const entry = { at: new Date().toISOString(), ...fields } as Task['history'][number];
  if (actor !== undefined) entry.by = actor;
  task.history.push(entry);
}

/** Append a status-change record; skipped when the status did not change. */
function logStatus(task: Task, status: Status, actor: string | undefined): void {
  if (task.status === status) return;
  logEvent(task, actor, { status });
}

/**
 * Which of a cancelled task's replacements can attach to a dependant
 * without looping the dependency graph. Shared by cancel and the doctor's
 * cancelled-blocker repair, so the rewire policy has one definition.
 */
export function viableReplacements(
  graph: Graph,
  dependantId: string,
  cancelled: Task,
): { attach: string[]; loops: string[] } {
  const attach: string[] = [];
  const loops: string[] = [];
  for (const replacementId of cancelled.replacedBy) {
    if (replacementId === dependantId) continue;
    if (graph.wouldCycleDependency(dependantId, replacementId)) loops.push(replacementId);
    else attach.push(replacementId);
  }
  return { attach, loops };
}

export interface StatusOptions {
  /** Take over a task another team started (records the takeover). */
  take?: boolean;
}

export function setStatus(
  store: Store,
  id: string,
  status: Exclude<Status, 'cancelled'>,
  actor?: string,
  options: StatusOptions = {},
): OpResult {
  return withLock(store.root, () => doSetStatus(store, id, status, actor, options));
}

/** Warn when an actor closes out work a different team started. */
function warnIfForeignHolder(m: Mutation, task: Task, actor: string | undefined, verb: string): void {
  const holder = holderOf(task);
  if (holder?.by !== undefined && !sameTeam(actor, holder.by)) {
    m.warn(`${verb} ${task.id}, which ${holder.by} started`);
  }
}

function doSetStatus(
  store: Store,
  id: string,
  status: Exclude<Status, 'cancelled'>,
  actor?: string,
  options: StatusOptions = {},
): OpResult {
  const m = new Mutation(store);
  const task = m.get(id);

  // The claim: starting a task another team already started needs an
  // explicit takeover, so two agents cannot silently double-claim.
  if (status === 'in-progress' && task.status === 'in-progress') {
    const holder = holderOf(task);
    if (holder?.by === undefined) {
      m.warn(`${id} is already in progress (unattributed)`);
    } else if (!sameTeam(actor, holder.by)) {
      if (options.take !== true) {
        throw new Error(
          `${id} is already in progress, started by ${holder.by} — pass --take to take it over`,
        );
      }
      task.history.push({ at: new Date().toISOString(), status: 'in-progress', by: actor });
      m.warn(`took over ${id} from ${holder.by}`);
    }
  }
  if (status === 'done') warnIfForeignHolder(m, task, actor, 'finishing');
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
  logStatus(task, status, actor);
  task.status = status;
  if (status === 'todo') {
    task.replacedBy = [];
    // A reopened decision is unanswered again: a lingering stamp would
    // make it claim otherwise until the next resolve.
    delete task.resolvedAt;
  }
  m.touch(id);
  m.commit();
  return m.result(task);
}

export function cancelTask(
  store: Store,
  id: string,
  replacedBy: string[] = [],
  actor?: string,
): OpResult {
  return withLock(store.root, () => doCancelTask(store, id, replacedBy, actor));
}

function doCancelTask(store: Store, id: string, replacedBy: string[], actor?: string): OpResult {
  const m = new Mutation(store);
  const task = m.get(id);
  warnIfForeignHolder(m, task, actor, 'cancelling');
  const replacements = [...new Set(replacedBy)];
  for (const replacementId of replacements) {
    m.get(replacementId);
    if (replacementId === id) throw new Error(`${id} cannot replace itself`);
  }
  logStatus(task, 'cancelled', actor);
  task.status = 'cancelled';
  task.replacedBy = replacements;
  m.touch(id);

  // Dependants stop waiting on the cancelled task and wait on its
  // replacements instead.
  for (const other of m.tasks) {
    if (other.id === id || !other.blockedBy.includes(id)) continue;
    removeBlocker(m, other.id, id);
    const { attach, loops } = viableReplacements(m.graph(), other.id, task);
    for (const replacementId of loops) {
      m.warn(`did not rewire ${other.id} onto ${replacementId}: it would create a dependency cycle`);
    }
    const rewired = attach.filter((replacementId) => addBlocker(m, other.id, replacementId));
    logEdgeChanges(m, other.id, actor, rewired, [id]);
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

export interface ResolveOptions {
  /** Close the decision as decided-no: record the rejection, create nothing. */
  reject?: boolean;
}

export type ResolveResult = OpResult & { outcomeTask?: Task };

export function resolveDecision(
  store: Store,
  id: string,
  response: string,
  actor?: string,
  options: ResolveOptions = {},
): ResolveResult {
  if (options.reject !== undefined && typeof options.reject !== 'boolean') {
    throw new Error('reject must be true or false');
  }
  return withLock(store.root, () => doResolveDecision(store, id, response, actor, options));
}

function doResolveDecision(
  store: Store,
  id: string,
  response: string,
  actor?: string,
  options: ResolveOptions = {},
): ResolveResult {
  const m = new Mutation(store);
  const task = m.get(id);
  if (task.type !== 'decision') {
    throw new Error(`${id} is not a decision task — use \`planny done\` for plain tasks`);
  }
  const answer = response.trim();
  const background = task.body; // the decision text before any outcome
  // The gate moves rather than opens: work that waited on the answer must
  // also wait on the answer being interpreted (the outcome task). Order
  // lives in dependencies, never in prose.
  const dependants = m.graph().blocking(id).filter(isActive).map((t) => t.id);
  const outcomeText =
    options.reject === true
      ? `Rejected — closed without action.${answer === '' ? '' : ` Reason: ${answer}`}`
      : answer;
  const outcome = `## Outcome\n\n${outcomeText}`;
  task.body = task.body === '' ? outcome : `${task.body}\n\n${outcome}`;
  logStatus(task, 'done', actor);
  task.status = 'done';
  task.resolvedAt = new Date().toISOString();
  m.touch(id);
  let outcomeTask: Task | undefined;
  if (options.reject !== true) {
    // The answer becomes work the queue cannot lose: an outcome task,
    // child of the decision, carrying everything a fresh agent needs.
    outcomeTask = createTask(
      m,
      store,
      {
        name: `Act on the outcome of ${id}: ${task.name}`,
        parent: id,
        blocks: dependants,
        body: outcomeTaskBody(id, task.name, background, outcomeText, dependants),
      },
      actor,
    );
    // ops writes the citation, so it cannot be forgotten.
    task.body += `\n\nOutcome task: ${outcomeTask.id}`;
  }
  m.commit();
  return { ...m.result(task), outcomeTask };
}

function outcomeTaskBody(
  id: string,
  name: string,
  background: string,
  outcomeText: string,
  dependants: string[],
): string {
  const reconcile =
    dependants.length > 0
      ? `The tasks that waited on the decision now wait on this task instead: ${dependants.join(', ')}. Update or cancel them to match the outcome. Marking this task done lifts their wait so they become workable — it does not close them.`
      : 'No tasks were waiting on the decision.';
  return `This task records the outcome of decision ${id} ("${name}"). The operator has decided; the decision and the answer follow. If the outcome calls for work, create tasks from this one, then mark this task done. ${reconcile}

## The decision (${id})

${background === '' ? '(the decision had no body)' : background}

## The outcome

${outcomeText}`;
}

export function bumpTask(store: Store, id: string, target: BumpTarget, actor?: string): OpResult {
  assertBumpTarget(target);
  return withLock(store.root, () => {
    const m = new Mutation(store);
    const task = m.get(id);
    m.touch(id);
    m.bump(id, target);
    m.repair(); // so the logged position is the task's final resting place
    logEvent(task, actor, {
      event: 'priority',
      target: String(target),
      position: activePosition(m.tasks, id).position,
    });
    m.commit();
    return m.result(task);
  });
}
