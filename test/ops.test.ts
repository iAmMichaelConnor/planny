import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addTask,
  bumpTask,
  cancelTask,
  resolveDecision,
  setStatus,
  updateTask,
} from '../src/ops.js';
import { sortByPriority } from '../src/priority.js';
import { initRepo, openStore, type Store } from '../src/store.js';
import { isActive } from '../src/types.js';

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

function activeOrder(): string[] {
  return sortByPriority(store.loadAll().filter(isActive)).map((t) => t.id);
}

describe('addTask', () => {
  it('creates a task with defaults and a fresh id', () => {
    const { task } = addTask(store, { name: 'First' });
    expect(task.id).toBe('t1');
    expect(task.status).toBe('todo');
    expect(task.type).toBe('task');
    expect(task.kind).toBe('ai');
    expect(store.load('t1').name).toBe('First');
  });

  it('appends to the bottom of the priority order by default', () => {
    addTask(store, { name: 'a' });
    addTask(store, { name: 'b' });
    addTask(store, { name: 'c', priority: 'top' });
    expect(activeOrder()).toEqual(['t3', 't1', 't2']);
  });

  it('stores parent, blockers, body, kind and model', () => {
    addTask(store, { name: 'parent' });
    addTask(store, { name: 'blocker' });
    const { task } = addTask(store, {
      name: 'child',
      body: 'Do the thing.',
      kind: 'operator',
      model: 'opus',
      parent: 't1',
      blockedBy: ['t2'],
    });
    expect(task.parent).toBe('t1');
    expect(task.blockedBy).toEqual(['t2']);
    expect(task.kind).toBe('operator');
    expect(store.load(task.id).body).toBe('Do the thing.');
  });

  it('re-parents listed children onto the new task', () => {
    addTask(store, { name: 'orphan1' });
    addTask(store, { name: 'orphan2' });
    addTask(store, { name: 'parent', children: ['t1', 't2'] });
    expect(store.load('t1').parent).toBe('t3');
    expect(store.load('t2').parent).toBe('t3');
  });

  it('adds the new task to blocked_by of each task it blocks', () => {
    addTask(store, { name: 'later' });
    addTask(store, { name: 'first', blocks: ['t1'] });
    expect(store.load('t1').blockedBy).toEqual(['t2']);
  });

  it('keeps a blocked new task below its blocker even when asked for top', () => {
    addTask(store, { name: 'a' });
    addTask(store, { name: 'blocker' });
    addTask(store, { name: 'blocked', blockedBy: ['t2'], priority: 'top' });
    expect(activeOrder()).toEqual(['t1', 't2', 't3']);
  });

  it('rejects unknown references', () => {
    expect(() => addTask(store, { name: 'x', parent: 't9' })).toThrow(/t9/);
    expect(() => addTask(store, { name: 'x', blockedBy: ['t9'] })).toThrow(/t9/);
    expect(() => addTask(store, { name: 'x', blocks: ['t9'] })).toThrow(/t9/);
  });

  it('rejects an empty name', () => {
    expect(() => addTask(store, { name: '  ' })).toThrow(/name/i);
  });
});

describe('updateTask', () => {
  beforeEach(() => {
    addTask(store, { name: 'a' });
    addTask(store, { name: 'b' });
    addTask(store, { name: 'c' });
  });

  it('updates scalar fields and bumps the updated timestamp', () => {
    const before = store.load('t1').updated;
    const { task } = updateTask(store, 't1', {
      name: 'renamed',
      body: 'New body.',
      kind: 'operator',
      model: 'sonnet',
    });
    expect(task.name).toBe('renamed');
    expect(task.body).toBe('New body.');
    expect(task.kind).toBe('operator');
    expect(task.model).toBe('sonnet');
    expect(Date.parse(task.updated)).toBeGreaterThanOrEqual(Date.parse(before));
  });

  it('clears model and parent with null', () => {
    updateTask(store, 't1', { model: 'opus', parent: 't2' });
    const { task } = updateTask(store, 't1', { model: null, parent: null });
    expect(task.model).toBeUndefined();
    expect(task.parent).toBeUndefined();
  });

  it('appends to the body', () => {
    updateTask(store, 't1', { body: 'Line one.' });
    const { task } = updateTask(store, 't1', { appendBody: 'Line two.' });
    expect(task.body).toBe('Line one.\n\nLine two.');
  });

  it('adds and removes children (re-parenting the child)', () => {
    updateTask(store, 't1', { addChildren: ['t2'] });
    expect(store.load('t2').parent).toBe('t1');
    updateTask(store, 't1', { removeChildren: ['t2'] });
    expect(store.load('t2').parent).toBeUndefined();
  });

  it('adds and removes blocked-by and blocks edges', () => {
    updateTask(store, 't1', { addBlockedBy: ['t2'], addBlocks: ['t3'] });
    expect(store.load('t1').blockedBy).toEqual(['t2']);
    expect(store.load('t3').blockedBy).toEqual(['t1']);
    updateTask(store, 't1', { removeBlockedBy: ['t2'], removeBlocks: ['t3'] });
    expect(store.load('t1').blockedBy).toEqual([]);
    expect(store.load('t3').blockedBy).toEqual([]);
  });

  it('rejects a parent cycle', () => {
    updateTask(store, 't2', { parent: 't1' });
    expect(() => updateTask(store, 't1', { parent: 't2' })).toThrow(/cycle/i);
    expect(() => updateTask(store, 't1', { parent: 't1' })).toThrow(/cycle/i);
  });

  it('rejects a dependency cycle', () => {
    updateTask(store, 't2', { addBlockedBy: ['t1'] });
    expect(() => updateTask(store, 't1', { addBlockedBy: ['t2'] })).toThrow(/cycle/i);
    expect(() => updateTask(store, 't1', { addBlocks: ['t1'] })).toThrow(/cycle/i);
  });

  it('repairs priority order when a new edge inverts it', () => {
    // t1 currently ranks above t3; blocking t1 on t3 must demote t1.
    updateTask(store, 't1', { addBlockedBy: ['t3'] });
    expect(activeOrder()).toEqual(['t2', 't3', 't1']);
  });

  it('deduplicates repeated edge additions', () => {
    updateTask(store, 't1', { addBlockedBy: ['t2'] });
    updateTask(store, 't1', { addBlockedBy: ['t2'] });
    expect(store.load('t1').blockedBy).toEqual(['t2']);
  });

  it('moves priority when asked', () => {
    updateTask(store, 't3', { priority: 'top' });
    expect(activeOrder()).toEqual(['t3', 't1', 't2']);
  });
});

describe('status changes', () => {
  beforeEach(() => {
    addTask(store, { name: 'a' });
    addTask(store, { name: 'b' });
  });

  it('walks todo -> in-progress -> done and back to todo', () => {
    expect(setStatus(store, 't1', 'in-progress').task.status).toBe('in-progress');
    expect(setStatus(store, 't1', 'done').task.status).toBe('done');
    expect(setStatus(store, 't1', 'todo').task.status).toBe('todo');
  });

  it('warns when completing a task that is still blocked', () => {
    updateTask(store, 't2', { addBlockedBy: ['t1'] });
    const { warnings } = setStatus(store, 't2', 'done');
    expect(warnings.join(' ')).toMatch(/blocked/i);
  });

  it('warns when completing a task with active children', () => {
    updateTask(store, 't2', { parent: 't1' });
    const { warnings } = setStatus(store, 't1', 'done');
    expect(warnings.join(' ')).toMatch(/children/i);
  });

  it('repairs priority order when a task reopens', () => {
    updateTask(store, 't2', { addBlockedBy: ['t1'] });
    setStatus(store, 't1', 'done');
    bumpTask(store, 't2', 'top');
    setStatus(store, 't1', 'todo');
    expect(activeOrder()).toEqual(['t1', 't2']);
  });
});

describe('cancelTask', () => {
  beforeEach(() => {
    addTask(store, { name: 'old' });
    addTask(store, { name: 'dependant', blockedBy: ['t1'] });
    addTask(store, { name: 'replacement' });
  });

  it('cancels and records replacements', () => {
    const { task } = cancelTask(store, 't1', ['t3']);
    expect(task.status).toBe('cancelled');
    expect(task.replacedBy).toEqual(['t3']);
  });

  it('rewires dependants onto the replacements', () => {
    cancelTask(store, 't1', ['t3']);
    expect(store.load('t2').blockedBy).toEqual(['t3']);
  });

  it('drops the cancelled blocker when there is no replacement', () => {
    cancelTask(store, 't1');
    expect(store.load('t2').blockedBy).toEqual([]);
  });

  it('rejects unknown replacement ids', () => {
    expect(() => cancelTask(store, 't1', ['t9'])).toThrow(/t9/);
  });

  it('warns about active children of the cancelled task', () => {
    addTask(store, { name: 'child', parent: 't1' });
    const { warnings } = cancelTask(store, 't1');
    expect(warnings.join(' ')).toMatch(/t4/);
  });
});

describe('resolveDecision', () => {
  it('marks the decision done and appends the outcome', () => {
    addTask(store, { name: 'Choose db', type: 'decision', body: '**Background** ...' });
    const { task } = resolveDecision(store, 't1', 'Use markdown files.');
    expect(task.status).toBe('done');
    expect(task.resolvedAt).toBeDefined();
    expect(task.body).toContain('## Outcome');
    expect(task.body).toContain('Use markdown files.');
  });

  it('rejects resolving a plain task', () => {
    addTask(store, { name: 'not a decision' });
    expect(() => resolveDecision(store, 't1', 'yes')).toThrow(/decision/i);
  });
});

describe('attribution', () => {
  it('records who created a task', () => {
    const { task } = addTask(store, { name: 'traced' }, 'sess-1');
    expect(task.createdBy).toBe('sess-1');
    expect(store.load('t1').createdBy).toBe('sess-1');
  });

  it('leaves created_by unset without an actor', () => {
    expect(addTask(store, { name: 'plain' }).task.createdBy).toBeUndefined();
  });

  it('appends a history entry per status change, carrying the actor', () => {
    addTask(store, { name: 'a' });
    setStatus(store, 't1', 'in-progress', 'sess-1');
    setStatus(store, 't1', 'done');
    const history = store.load('t1').history;
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ status: 'in-progress', by: 'sess-1' });
    expect(history[0]!.at).toBeDefined();
    expect(history[1]!.status).toBe('done');
    expect(history[1]!.by).toBeUndefined();
  });

  it('does not log a no-op status change', () => {
    addTask(store, { name: 'a' });
    setStatus(store, 't1', 'todo', 'sess-1');
    expect(store.load('t1').history).toHaveLength(0);
  });

  it('cancel and resolve append attributed entries', () => {
    addTask(store, { name: 'a' });
    addTask(store, { name: 'q', type: 'decision' });
    cancelTask(store, 't1', [], 'sess-2');
    resolveDecision(store, 't2', 'yes', 'sess-3');
    expect(store.load('t1').history.at(-1)).toMatchObject({ status: 'cancelled', by: 'sess-2' });
    expect(store.load('t2').history.at(-1)).toMatchObject({ status: 'done', by: 'sess-3' });
  });
});

describe('bumpTask', () => {
  it('persists the new order', () => {
    addTask(store, { name: 'a' });
    addTask(store, { name: 'b' });
    bumpTask(store, 't2', 'top');
    expect(activeOrder()).toEqual(['t2', 't1']);
  });
});
