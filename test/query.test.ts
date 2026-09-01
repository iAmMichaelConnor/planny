import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addTask, cancelTask, resolveDecision, setStatus } from '../src/ops.js';
import {
  listTasks,
  nextDecisions,
  nextTasks,
  progress,
  resolvedDecisions,
} from '../src/query.js';
import { initRepo, openStore, type Store } from '../src/store.js';

let dir: string;
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'planny-'));
  initRepo(dir);
  store = openStore(dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('listTasks', () => {
  beforeEach(() => {
    addTask(store, { name: 'root' }); // t1
    addTask(store, { name: 'child', parent: 't1' }); // t2
    addTask(store, { name: 'grandchild', parent: 't2', kind: 'operator' }); // t3
    addTask(store, { name: 'blocked', blockedBy: ['t1'] }); // t4
    addTask(store, { name: 'question', type: 'decision' }); // t5
    setStatus(store, 't2', 'done');
  });

  it('returns everything sorted by priority when unfiltered', () => {
    expect(listTasks(store, {}).map((t) => t.id)).toEqual(['t1', 't2', 't3', 't4', 't5']);
  });

  it('filters by status list', () => {
    expect(listTasks(store, { status: ['done'] }).map((t) => t.id)).toEqual(['t2']);
  });

  it('filters by kind and type', () => {
    expect(listTasks(store, { kind: 'operator' }).map((t) => t.id)).toEqual(['t3']);
    expect(listTasks(store, { type: 'decision' }).map((t) => t.id)).toEqual(['t5']);
  });

  it('filters by parent, optionally recursive', () => {
    expect(listTasks(store, { parent: 't1' }).map((t) => t.id)).toEqual(['t2']);
    expect(listTasks(store, { parent: 't1', recursive: true }).map((t) => t.id)).toEqual([
      't2',
      't3',
    ]);
  });

  it('filters blocked tasks', () => {
    expect(listTasks(store, { blocked: true }).map((t) => t.id)).toEqual(['t4']);
  });
});

describe('nextTasks', () => {
  beforeEach(() => {
    addTask(store, { name: 'epic' }); // t1 has active children -> not actionable
    addTask(store, { name: 'step one', parent: 't1' }); // t2
    addTask(store, { name: 'step two', parent: 't1', blockedBy: ['t2'] }); // t3 blocked
    addTask(store, { name: 'loose end' }); // t4
    addTask(store, { name: 'operator chore', kind: 'operator' }); // t5
  });

  it('returns unblocked leaf work in priority order', () => {
    expect(nextTasks(store, 10).map((n) => n.task.id)).toEqual(['t2', 't4', 't5']);
  });

  it('limits the count', () => {
    expect(nextTasks(store, 1).map((n) => n.task.id)).toEqual(['t2']);
  });

  it('filters by kind', () => {
    expect(nextTasks(store, 10, { kind: 'operator' }).map((n) => n.task.id)).toEqual(['t5']);
  });

  it('includes the ancestor path, nearest first', () => {
    const item = nextTasks(store, 1)[0]!;
    expect(item.path.map((t) => t.id)).toEqual(['t1']);
  });

  it('says which tasks each item unlocks', () => {
    const item = nextTasks(store, 1)[0]!;
    expect(item.unlocks.map((t) => t.id)).toEqual(['t3']);
  });

  it('a parent becomes actionable once its children finish', () => {
    setStatus(store, 't2', 'done');
    setStatus(store, 't3', 'done');
    expect(nextTasks(store, 10).map((n) => n.task.id)).toContain('t1');
  });

  it('a blocked task surfaces once its blocker finishes', () => {
    setStatus(store, 't2', 'done');
    expect(nextTasks(store, 10).map((n) => n.task.id)).toContain('t3');
  });
});

describe('progress', () => {
  it('counts done over non-cancelled tasks', () => {
    addTask(store, { name: 'a' });
    addTask(store, { name: 'b' });
    addTask(store, { name: 'c' });
    addTask(store, { name: 'd' });
    addTask(store, { name: 'gone' });
    setStatus(store, 't1', 'done');
    setStatus(store, 't2', 'in-progress');
    cancelTask(store, 't5');
    const p = progress(store);
    expect(p.total).toBe(4); // the cancelled task does not count
    expect(p.done).toBe(1);
    expect(p.percent).toBe(25);
    expect(p.byStatus['in-progress']).toBe(1);
  });

  it('scopes to a subtree when given a parent', () => {
    addTask(store, { name: 'epic' });
    addTask(store, { name: 'child a', parent: 't1' });
    addTask(store, { name: 'child b', parent: 't1' });
    addTask(store, { name: 'unrelated' });
    setStatus(store, 't2', 'done');
    const p = progress(store, 't1');
    expect(p.total).toBe(3); // the epic plus its two children
    expect(p.done).toBe(1);
    expect(p.percent).toBe(33);
  });

  it('is 100 for an empty store', () => {
    expect(progress(store).percent).toBe(100);
  });
});

describe('resolvedDecisions', () => {
  beforeEach(() => {
    addTask(store, { name: 'blocked work' }); // t1
    addTask(store, { name: 'first q', type: 'decision', blocks: ['t1'] }); // t2
    addTask(store, { name: 'second q', type: 'decision' }); // t3
    addTask(store, { name: 'still open', type: 'decision' }); // t4
    resolveDecision(store, 't2', 'Yes.');
    resolveDecision(store, 't3', 'No.');
  });

  it('lists resolved decisions newest first with what each was gating', () => {
    const resolved = resolvedDecisions(store);
    expect(resolved.map((r) => r.task.id)).toEqual(['t3', 't2']);
    expect(resolved[1]!.dependants.map((t) => t.id)).toEqual(['t1']);
  });

  it('filters by resolved-at time', () => {
    expect(resolvedDecisions(store, '2000-01-01T00:00:00.000Z')).toHaveLength(2);
    expect(resolvedDecisions(store, '2100-01-01T00:00:00.000Z')).toHaveLength(0);
  });
});

describe('changed-since filter', () => {
  it('keeps only tasks updated at or after the given time', () => {
    addTask(store, { name: 'old' });
    addTask(store, { name: 'fresh' });
    const stale = store.load('t1');
    stale.updated = '2020-01-01T00:00:00.000Z';
    store.save(stale);
    const changed = listTasks(store, { changedSince: '2026-01-01T00:00:00.000Z' });
    expect(changed.map((t) => t.id)).toEqual(['t2']);
  });
});

describe('nextDecisions', () => {
  it('returns active decisions, unblocked first, in priority order', () => {
    addTask(store, { name: 'task blocker' }); // t1
    addTask(store, { name: 'first q', type: 'decision' }); // t2
    addTask(store, { name: 'blocked q', type: 'decision', blockedBy: ['t1'] }); // t3
    addTask(store, { name: 'second q', type: 'decision' }); // t4
    addTask(store, { name: 'answered', type: 'decision' }); // t5
    setStatus(store, 't5', 'done');
    const decisions = nextDecisions(store);
    expect(decisions.map((d) => d.task.id)).toEqual(['t2', 't4', 't3']);
    expect(decisions.map((d) => d.blocked)).toEqual([false, false, true]);
  });
});
