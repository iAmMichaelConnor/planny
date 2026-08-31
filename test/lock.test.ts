import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { diagnose } from '../src/doctor.js';
import { addTask } from '../src/ops.js';
import { initRepo, openStore, type Store } from '../src/store.js';

const run = promisify(execFile);

let dir: string;
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'planny-lock-'));
  initRepo(dir);
  store = openStore(dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.PLANNY_LOCK_TIMEOUT_MS;
});

const lockPath = () => join(dir, '.planny', 'lock');

describe('write lock', () => {
  it('is released after an operation', () => {
    addTask(store, { name: 'a' });
    expect(existsSync(lockPath())).toBe(false);
  });

  it('a held lock makes mutations fail with a clear message after the timeout', () => {
    writeFileSync(lockPath(), '12345');
    process.env.PLANNY_LOCK_TIMEOUT_MS = '80';
    expect(() => addTask(store, { name: 'a' })).toThrow(/locked/i);
  });

  it('a stale lock is broken and the operation proceeds', () => {
    writeFileSync(lockPath(), '12345');
    const old = (Date.now() - 60_000) / 1000;
    utimesSync(lockPath(), old, old);
    expect(addTask(store, { name: 'a' }).task.id).toBe('t1');
    expect(existsSync(lockPath())).toBe(false);
  });

  it('two processes adding concurrently lose nothing and corrupt nothing', async () => {
    const script = `
      const { openStore } = await import(${JSON.stringify(join(process.cwd(), 'dist', 'store.js'))});
      const { addTask } = await import(${JSON.stringify(join(process.cwd(), 'dist', 'ops.js'))});
      const store = openStore(process.env.DIR);
      for (let i = 0; i < 15; i++) addTask(store, { name: process.env.WHO + ' ' + i });
    `;
    const child = (who: string) =>
      run(process.execPath, ['--input-type=module', '-e', script], {
        env: { ...process.env, DIR: dir, WHO: who },
      });
    await Promise.all([child('alpha'), child('beta')]);

    const tasks = store.loadAll();
    expect(tasks).toHaveLength(30);
    expect(new Set(tasks.map((t) => t.id)).size).toBe(30);
    expect(new Set(tasks.map((t) => t.priority)).size).toBe(30);
    expect(diagnose(store)).toEqual([]);
  }, 30_000);
});
