import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findRoot, initRepo, openStore, type Store } from '../src/store.js';
import type { Task } from '../src/types.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'planny-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeTask(id: string, priority = 10): Task {
  return {
    id,
    name: `Task ${id}`,
    status: 'todo',
    type: 'task',
    kind: 'ai',
    priority,
    blockedBy: [],
    replacedBy: [],
    created: '2026-08-31T12:00:00.000Z',
    updated: '2026-08-31T12:00:00.000Z',
    body: '',
  };
}

describe('initRepo / findRoot / openStore', () => {
  it('initRepo creates .planny/tasks', () => {
    initRepo(dir);
    const store = openStore(dir);
    expect(store.root).toBe(dir);
    expect(store.listIds()).toEqual([]);
  });

  it('findRoot walks up from a nested directory', () => {
    initRepo(dir);
    const nested = join(dir, 'a', 'b');
    mkdirSync(nested, { recursive: true });
    expect(findRoot(nested)).toBe(dir);
  });

  it('findRoot returns null when no repo exists', () => {
    expect(findRoot(dir)).toBeNull();
  });

  it('openStore throws a clear error when no repo exists', () => {
    expect(() => openStore(dir)).toThrow(/planny init/);
  });

  it('initRepo twice is safe', () => {
    initRepo(dir);
    initRepo(dir);
    expect(openStore(dir).listIds()).toEqual([]);
  });
});

describe('task io', () => {
  let store: Store;

  beforeEach(() => {
    initRepo(dir);
    store = openStore(dir);
  });

  it('saves and loads a task', () => {
    const task = makeTask('t1');
    store.save(task);
    expect(store.load('t1')).toEqual(task);
  });

  it('load throws a clear error for a missing id', () => {
    expect(() => store.load('t99')).toThrow(/t99/);
  });

  it('loadAll returns every saved task', () => {
    store.save(makeTask('t1'));
    store.save(makeTask('t2'));
    expect(store.loadAll().map((t) => t.id).sort()).toEqual(['t1', 't2']);
  });

  it('nextId is t1 for an empty store', () => {
    expect(store.nextId()).toBe('t1');
  });

  it('nextId is max + 1 and never reuses gaps', () => {
    store.save(makeTask('t3'));
    store.save(makeTask('t7'));
    expect(store.nextId()).toBe('t8');
  });

  it('exposes a stable path for a task file', () => {
    store.save(makeTask('t1'));
    expect(store.path('t1')).toBe(join(dir, '.planny', 'tasks', 't1.md'));
  });

  it('ignores non-task files in the tasks directory', () => {
    writeFileSync(join(dir, '.planny', 'tasks', 'README.txt'), 'not a task');
    expect(store.loadAll()).toEqual([]);
    expect(store.nextId()).toBe('t1');
  });
});
