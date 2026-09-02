import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverStores } from '../src/discover.js';
import { initRepo } from '../src/store.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'planny-find-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function project(...parts: string[]): string {
  const path = join(dir, ...parts);
  mkdirSync(path, { recursive: true });
  initRepo(path);
  return path;
}

describe('discoverStores', () => {
  it('finds every store under the roots it is given', () => {
    const a = project('alpha');
    const b = project('nested', 'beta');
    expect(discoverStores([dir]).map((s) => s.root).sort()).toEqual([a, b].sort());
  });

  it('returns nothing when there is nothing to find', () => {
    expect(discoverStores([dir])).toEqual([]);
  });

  it('never walks into a store it has already found', () => {
    const a = project('alpha');
    // A store inside another store's tree belongs to the outer plan.
    mkdirSync(join(a, 'inner'), { recursive: true });
    initRepo(join(a, 'inner'));
    expect(discoverStores([dir]).map((s) => s.root)).toEqual([a]);
  });

  it('skips the directories nobody keeps a plan in', () => {
    for (const noise of ['node_modules', '.git', 'dist']) {
      const path = join(dir, noise, 'thing');
      mkdirSync(path, { recursive: true });
      initRepo(path);
    }
    expect(discoverStores([dir])).toEqual([]);
  });

  it('passes over hidden directories, where tools keep their scratch', () => {
    const kept = project('work');
    project('.claude', 'jobs', 'abc', 'tmp', 'skill-copy');
    project('.cache', 'thing');
    expect(discoverStores([dir]).map((s) => s.root)).toEqual([kept]);
  });

  it('still reaches a hidden directory named as a root', () => {
    const hidden = project('.config', 'notes');
    expect(discoverStores([join(dir, '.config')]).map((s) => s.root)).toEqual([hidden]);
  });

  it('stops at the depth it is given', () => {
    project('one', 'two', 'three', 'deep');
    expect(discoverStores([dir], { depth: 2 })).toEqual([]);
    expect(discoverStores([dir], { depth: 4 })).toHaveLength(1);
  });

  it('passes over a linked worktree, which shares the main plan', () => {
    const main = project('main');
    // The shape git leaves behind: a .git file pointing at the main repo.
    mkdirSync(join(main, '.git'), { recursive: true });
    const tree = join(dir, 'wt');
    mkdirSync(tree, { recursive: true });
    initRepo(tree);
    mkdirSync(join(main, '.git', 'worktrees', 'wt'), { recursive: true });
    writeFileSync(join(main, '.git', 'worktrees', 'wt', 'commondir'), '../..\n');
    writeFileSync(join(tree, '.git'), `gitdir: ${join(main, '.git', 'worktrees', 'wt')}\n`);
    expect(discoverStores([dir]).map((s) => s.root)).toEqual([main]);
  });

  it('keeps a worktree that says its plan is its own', () => {
    const main = project('main');
    mkdirSync(join(main, '.git'), { recursive: true });
    const tree = join(dir, 'wt');
    mkdirSync(tree, { recursive: true });
    initRepo(tree);
    writeFileSync(join(tree, '.planny', 'fork'), '');
    mkdirSync(join(main, '.git', 'worktrees', 'wt'), { recursive: true });
    writeFileSync(join(main, '.git', 'worktrees', 'wt', 'commondir'), '../..\n');
    writeFileSync(join(tree, '.git'), `gitdir: ${join(main, '.git', 'worktrees', 'wt')}\n`);
    expect(discoverStores([dir]).map((s) => s.root).sort()).toEqual([main, tree].sort());
  });

  it('names each project by its directory, in a stable order', () => {
    project('zulu');
    project('alpha');
    expect(discoverStores([dir]).map((s) => s.name)).toEqual(['alpha', 'zulu']);
  });

  it('keeps two projects of the same name apart', () => {
    project('one', 'work');
    project('two', 'work');
    const found = discoverStores([dir]);
    expect(found.map((s) => s.name)).toEqual(['work', 'work']);
    expect(new Set(found.map((s) => s.key)).size).toBe(2);
  });

  it('gives a project the same key every time', () => {
    project('alpha');
    expect(discoverStores([dir])[0]!.key).toBe(discoverStores([dir])[0]!.key);
  });

  it('shrugs off a directory it may not read', () => {
    project('alpha');
    expect(() => discoverStores([join(dir, 'missing')])).not.toThrow();
    expect(discoverStores([join(dir, 'missing'), dir])).toHaveLength(1);
  });
});
