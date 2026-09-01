import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

  it('load names the broken file when a single task fails to parse', () => {
    writeFileSync(store.path('t1'), 'garbage');
    expect(() => store.load('t1')).toThrow(/t1\.md/);
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

describe('worktree-aware discovery', () => {
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errSpy.mockRestore();
  });

  /** Fabricate a linked git worktree of main — no git needed. */
  function makeWorktree(main: string, name: string, gitdirLine?: string): string {
    const meta = join(main, '.git', 'worktrees', name);
    mkdirSync(meta, { recursive: true });
    writeFileSync(join(meta, 'commondir'), '../..\n');
    const wt = join(main, '.claude', 'worktrees', name);
    mkdirSync(wt, { recursive: true });
    writeFileSync(join(wt, '.git'), `${gitdirLine ?? `gitdir: ${meta}`}\n`);
    return wt;
  }

  it('a worktree copy of the store defers to the main worktree plan', () => {
    initRepo(dir);
    const wt = makeWorktree(dir, 'wt1');
    initRepo(wt); // stands in for the checkout copy of a tracked store
    expect(findRoot(wt)).toBe(dir);
    expect(openStore(wt).root).toBe(dir);
  });

  it('a start dir nested inside the worktree defers too', () => {
    initRepo(dir);
    const wt = makeWorktree(dir, 'wt2');
    initRepo(wt);
    const nested = join(wt, 'a', 'b');
    mkdirSync(nested, { recursive: true });
    expect(findRoot(nested)).toBe(dir);
  });

  it('the fork marker keeps the worktree store', () => {
    initRepo(dir);
    const wt = makeWorktree(dir, 'wt3');
    initRepo(wt);
    writeFileSync(join(wt, '.planny', 'fork'), '');
    expect(findRoot(wt)).toBe(wt);
  });

  it('no plan in the main worktree means no redirect', () => {
    const wt = makeWorktree(dir, 'wt4'); // main has .git but no .planny
    initRepo(wt);
    expect(findRoot(wt)).toBe(wt);
  });

  it('a relative gitdir line resolves against the worktree root', () => {
    initRepo(dir);
    const wt = makeWorktree(dir, 'wt5', 'gitdir: ../../../.git/worktrees/wt5');
    initRepo(wt);
    expect(findRoot(wt)).toBe(dir);
  });

  it('a main worktree, where .git is a directory, never redirects', () => {
    initRepo(dir);
    mkdirSync(join(dir, '.git'), { recursive: true });
    expect(findRoot(dir)).toBe(dir);
  });

  it('says on stderr that the main plan is being used', () => {
    initRepo(dir);
    const wt = makeWorktree(dir, 'wt6');
    initRepo(wt);
    findRoot(wt);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('main worktree'));
  });

  const hasGit = (() => {
    try {
      execFileSync('git', ['--version'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  })();

  it.skipIf(!hasGit)('a real git worktree checks out the tracked store and still defers', () => {
    const git = (...args: string[]): void => {
      execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
        cwd: dir,
        stdio: 'ignore',
      });
    };
    git('init', '-b', 'main');
    initRepo(dir);
    openStore(dir).save(makeTask('t1'));
    git('add', '-A');
    git('commit', '-m', 'store');
    const wt = join(dir, 'wt');
    git('worktree', 'add', wt);
    // The checkout really did materialize a copy of the store…
    expect(existsSync(join(wt, '.planny', 'tasks', 't1.md'))).toBe(true);
    // …and discovery still lands on the main worktree's plan.
    expect(findRoot(wt)).toBe(dir);
    expect(openStore(wt).root).toBe(dir);
    // The fork marker flips it back to the local copy.
    writeFileSync(join(wt, '.planny', 'fork'), '');
    expect(findRoot(wt)).toBe(wt);
  });
});

describe('the rewind tripwire', () => {
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errSpy.mockRestore();
  });

  function lastSeenFile(): string {
    return join(dir, '.planny', 'last-seen.json');
  }

  it('saving a task advances the mark; opening and scanning never create it', () => {
    initRepo(dir);
    const store = openStore(dir);
    store.scan();
    expect(existsSync(lastSeenFile())).toBe(false);
    store.save(makeTask('t3'));
    const mark = JSON.parse(readFileSync(lastSeenFile(), 'utf8')) as Record<string, unknown>;
    expect(mark.maxId).toBe(3);
    expect(mark.updated).toBe(makeTask('t3').updated);
  });

  it('the mark never goes backwards', () => {
    initRepo(dir);
    const store = openStore(dir);
    store.save({ ...makeTask('t5'), updated: '2026-09-01T00:00:00.000Z' });
    store.save({ ...makeTask('t2'), updated: '2026-01-01T00:00:00.000Z' });
    const mark = JSON.parse(readFileSync(lastSeenFile(), 'utf8')) as Record<string, unknown>;
    expect(mark.maxId).toBe(5);
    expect(mark.updated).toBe('2026-09-01T00:00:00.000Z');
  });

  it('a store missing an id the mark has seen warns of a rewind at open', () => {
    initRepo(dir);
    const store = openStore(dir);
    store.save(makeTask('t1'));
    store.save(makeTask('t2'));
    rmSync(join(dir, '.planny', 'tasks', 't2.md'));
    openStore(dir);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('rewound'));
  });

  it('a store whose newest update is older than the mark warns on scan', () => {
    initRepo(dir);
    const store = openStore(dir);
    store.save({ ...makeTask('t1'), updated: '2026-09-01T00:00:00.000Z' });
    // A checkout reverting the file to an older snapshot, by hand.
    const p = join(dir, '.planny', 'tasks', 't1.md');
    writeFileSync(
      p,
      readFileSync(p, 'utf8').replace('2026-09-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
    );
    openStore(dir).scan();
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('rewound'));
  });

  it('deleting the mark acknowledges the rewind', () => {
    initRepo(dir);
    const store = openStore(dir);
    store.save(makeTask('t1'));
    store.save(makeTask('t2'));
    rmSync(join(dir, '.planny', 'tasks', 't2.md'));
    rmSync(lastSeenFile());
    openStore(dir).scan();
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('a garbage mark is ignored rather than fatal', () => {
    initRepo(dir);
    const store = openStore(dir);
    store.save(makeTask('t1'));
    writeFileSync(lastSeenFile(), 'not json');
    expect(() => openStore(dir).scan()).not.toThrow();
    expect(errSpy).not.toHaveBeenCalled();
  });
});
