import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addTask, setStatus, updateTask } from '../src/ops.js';
import { nextActions, nextTasks } from '../src/query.js';
import { catchup } from '../src/catchup.js';
import { runCli } from '../src/cli.js';
import { initRepo, openStore, type Store } from '../src/store.js';

let dir: string;
let store: Store;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'planny-actions-'));
  initRepo(dir);
  store = openStore(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('human action tasks', () => {
  it('persists actions as operator work and excludes them from the default work queue', () => {
    const { task } = addTask(store, { name: 'Connect the device', type: 'action' }, 'agent');
    expect(store.load(task.id)).toMatchObject({ type: 'action', kind: 'operator', createdBy: 'agent' });
    expect(nextTasks(store, 10)).toEqual([]);
    expect(nextTasks(store, 10, { kind: 'ai' })).toEqual([]);
    expect(nextTasks(store, 10, { kind: 'operator' }).map((n) => n.task.id)).toEqual([task.id]);
  });

  it('only lets the operator start and complete an action, releasing dependent work', () => {
    const { task } = addTask(store, { name: 'Connect the device', type: 'action' }, 'agent');
    const dependent = addTask(store, { name: 'Test the device', blockedBy: [task.id] }).task;
    for (const actor of [undefined, 'agent', 'operator/agent']) {
      for (const status of ['in-progress', 'done'] as const) {
        expect(() => setStatus(store, task.id, status, actor, { take: true })).toThrow(/human|operator/);
      }
    }
    expect(store.load(task.id).status).toBe('todo');
    catchup(store, 'agent');
    setStatus(store, task.id, 'in-progress', 'operator');
    setStatus(store, task.id, 'done', 'operator');
    expect(nextTasks(store, 10).map((n) => n.task.id)).toEqual([dependent.id]);
    expect(store.load(task.id).history.every((entry) => entry.by === 'operator')).toBe(true);
    expect(store.loadAll()).toHaveLength(2); // no decision outcome task
    expect(catchup(store, 'agent').changed).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: task.id, type: 'action', status: 'done' }),
    ]));
  });

  it('enforces ownership on creation and conversion and prevents agents converting actions away', () => {
    expect(() => addTask(store, { name: 'Human work', type: 'action', kind: 'ai' })).toThrow(/operator/);
    const { task } = addTask(store, { name: 'Human work', model: 'model' });
    updateTask(store, task.id, { type: 'action' }, 'agent');
    expect(store.load(task.id)).toMatchObject({ type: 'action', kind: 'operator' });
    expect(store.load(task.id).model).toBeUndefined();
    expect(() => updateTask(store, task.id, { kind: 'ai' }, 'agent')).toThrow(/operator/);
    expect(() => updateTask(store, task.id, { type: 'task' }, 'agent')).toThrow(/human|operator/);
    updateTask(store, task.id, { body: 'Plug in the USB cable.' }, 'agent');
    updateTask(store, task.id, { type: 'task', kind: 'ai' }, 'operator');
    expect(store.load(task.id).type).toBe('task');
  });

  it('supports CLI creation, action queues, and explicit operator completion', async () => {
    const out: string[] = [];
    const err: string[] = [];
    const run = (...args: string[]) => runCli(args, { cwd: dir, out: (s) => out.push(s), err: (s) => err.push(s) });
    expect(await run('--session', 'agent', 'add', 'Connect device', '--type', 'action', '--json')).toBe(0);
    const id = JSON.parse(out.pop()!).task.id;
    expect(await run('actions', '--json')).toBe(0);
    expect(JSON.parse(out.pop()!)).toMatchObject([{ task: { id, kind: 'operator' }, blocked: false }]);
    expect(await run('--session', 'agent', 'add', 'Bad start', '--type', 'action', '--start')).toBe(1);
    expect(store.loadAll()).toHaveLength(1);
    expect(await run('--session', 'agent', 'done', id)).toBe(1);
    expect(await run('--session', 'operator', 'done', id)).toBe(0);
    expect(await run('actions', '--json')).toBe(0);
    expect(JSON.parse(out.pop()!)).toEqual([]);
  });

  it('orders ready actions before blocked ones, and includes parked work only on request', () => {
    const blocker = addTask(store, { name: 'Prepare the test' }).task;
    const waiting = addTask(store, { name: 'Run the hardware test', type: 'action', blockedBy: [blocker.id] }).task;
    const ready = addTask(store, { name: 'Connect the cable', type: 'action' }).task;
    const parked = addTask(store, { name: 'Bring spare cable', type: 'action' }).task;
    setStatus(store, parked.id, 'parked', 'agent', { parkedUntil: 'The cable arrives' });
    expect(nextActions(store).map(({ task, blocked }) => [task.id, blocked])).toEqual([
      [ready.id, false], [waiting.id, true],
    ]);
    expect(nextActions(store, { includeParked: true }).map(({ task }) => task.id)).toEqual([
      ready.id, parked.id, waiting.id,
    ]);
    setStatus(store, blocker.id, 'done', 'agent');
    expect(nextActions(store)[0]).toMatchObject({ task: { id: waiting.id }, blocked: false });
  });

  it('does not turn a running agent task into a human action', () => {
    const { task } = addTask(store, { name: 'Do work' });
    setStatus(store, task.id, 'in-progress', 'agent');
    expect(() => updateTask(store, task.id, { type: 'action' }, 'agent')).toThrow(/todo/);
    expect(store.load(task.id)).toMatchObject({ type: 'task', status: 'in-progress', kind: 'ai' });
  });
});
