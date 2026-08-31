import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
    history: [],
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

describe('scan', () => {
  let store: Store;

  beforeEach(() => {
    initRepo(dir);
    store = openStore(dir);
  });

  it('returns every task and no failures for a healthy store', () => {
    store.save(makeTask('t1'));
    store.save(makeTask('t2'));
    const { tasks, failures } = store.scan();
    expect(tasks.map((t) => t.id).sort()).toEqual(['t1', 't2']);
    expect(failures).toEqual([]);
  });

  it('collects unparseable files instead of throwing', () => {
    store.save(makeTask('t1'));
    writeFileSync(store.path('t2'), '---\nid: t2\nstatus: wip\n---\n');
    writeFileSync(store.path('t3'), 'no frontmatter at all');
    const { tasks, failures } = store.scan();
    expect(tasks.map((t) => t.id)).toEqual(['t1']);
    expect(failures).toHaveLength(2);
    expect(failures[0]!.file).toBe(store.path('t2'));
    expect(failures[0]!.error).toMatch(/status|missing/i);
    expect(failures[1]!.error).toMatch(/frontmatter/i);
  });

  it('loadAll names the broken file when it throws', () => {
    writeFileSync(store.path('t1'), 'garbage');
    expect(() => store.loadAll()).toThrow(/t1\.md/);
  });

  it('flags a frontmatter id that disagrees with the filename', () => {
    const impostor = makeTask('t5');
    store.save(impostor);
    writeFileSync(store.path('t2'), readFileSync(store.path('t5'), 'utf8'));
    const { tasks, failures } = store.scan();
    expect(tasks.map((t) => t.id)).toEqual(['t5']);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.code).toBe('id-mismatch');
    expect(failures[0]!.file).toBe(store.path('t2'));
    expect(() => store.loadAll()).toThrow(/t2\.md/);
  });
});
