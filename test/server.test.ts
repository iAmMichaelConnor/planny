import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addTask } from '../src/ops.js';
import { startServer, type RunningServer } from '../src/server.js';
import { initRepo, openStore, type Store } from '../src/store.js';

let dir: string;
let store: Store;
let server: RunningServer;
let base: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'planny-srv-'));
  initRepo(dir);
  store = openStore(dir);
  server = await startServer(store, 0);
  base = `http://127.0.0.1:${server.port}`;
});

afterEach(async () => {
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function patch(path: string, body: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('static ui', () => {
  it('serves the app shell at /', async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('planny');
  });

  it('404s unknown paths', async () => {
    const res = await fetch(`${base}/nope.js`);
    expect(res.status).toBe(404);
  });
});

describe('GET /api/state', () => {
  it('returns tasks with derived fields, progress and decisions', async () => {
    addTask(store, { name: 'a' });
    addTask(store, { name: 'q', type: 'decision', blockedBy: ['t1'] });
    const res = await fetch(`${base}/api/state`);
    expect(res.status).toBe(200);
    const state = await res.json();
    expect(state.tasks).toHaveLength(2);
    expect(state.tasks[1].blocked).toBe(true);
    expect(state.tasks[1].blocking).toEqual([]);
    expect(state.tasks[0].blocking).toEqual(['t2']);
    expect(state.progress.total).toBe(2);
    expect(state.decisions).toEqual([{ id: 't2', blocked: true }]);
    expect(state.store.root).toBe(dir);
    expect(state.store.name).toBe(dir.split('/').pop());
    // Positions come from the server so the client never re-derives order.
    expect(state.tasks[0].position).toBe(1);
    expect(state.tasks[1].position).toBe(2);
  });
});

describe('mutations', () => {
  it('adds a task', async () => {
    const res = await post('/api/tasks', { name: 'from the ui', kind: 'operator' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.task.id).toBe('t1');
    expect(store.load('t1').kind).toBe('operator');
  });

  it('updates a task', async () => {
    addTask(store, { name: 'old' });
    const res = await patch('/api/tasks/t1', { name: 'new name' });
    expect(res.status).toBe(200);
    expect(store.load('t1').name).toBe('new name');
  });

  it('changes status, including cancel with replacements', async () => {
    addTask(store, { name: 'a' });
    addTask(store, { name: 'b' });
    expect((await post('/api/tasks/t1/status', { status: 'in-progress' })).status).toBe(200);
    expect(store.load('t1').status).toBe('in-progress');
    expect(
      (await post('/api/tasks/t1/status', { status: 'cancelled', replacedBy: ['t2'] })).status,
    ).toBe(200);
    expect(store.load('t1').replacedBy).toEqual(['t2']);
  });

  it('bumps priority', async () => {
    addTask(store, { name: 'a' });
    addTask(store, { name: 'b' });
    expect((await post('/api/tasks/t2/bump', { target: 'top' })).status).toBe(200);
    expect(store.load('t2').priority).toBeLessThan(store.load('t1').priority);
  });

  it('resolves a decision', async () => {
    addTask(store, { name: 'q', type: 'decision' });
    const res = await post('/api/tasks/t1/resolve', { response: 'Ship it.' });
    expect(res.status).toBe(200);
    const task = store.load('t1');
    expect(task.status).toBe('done');
    expect(task.body).toContain('Ship it.');
  });

  it('attributes UI mutations to the operator', async () => {
    const created = await (await post('/api/tasks', { name: 'from the ui' })).json();
    expect(created.task.createdBy).toBe('operator');
    await post('/api/tasks/t1/status', { status: 'done' });
    expect(store.load('t1').history.at(-1)).toMatchObject({ status: 'done', by: 'operator' });
  });

  it('surfaces warnings in the response', async () => {
    addTask(store, { name: 'a' });
    addTask(store, { name: 'b', blockedBy: ['t1'] });
    const body = await (await post('/api/tasks/t2/status', { status: 'done' })).json();
    expect(body.warnings.join(' ')).toMatch(/blocked/i);
  });
});

describe('port conflicts', () => {
  it('startServer rejects cleanly when the port is taken', async () => {
    await expect(startServer(store, server.port)).rejects.toThrow(/EADDRINUSE|in use/i);
  });
});

describe('events', () => {
  it('streams a change event when a task file changes', async () => {
    const res = await fetch(`${base}/api/events`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    addTask(store, { name: 'trigger' });
    let text = '';
    const deadline = Date.now() + 3000;
    while (!text.includes('changed') && Date.now() < deadline) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value: undefined }>((r) =>
          setTimeout(() => r({ done: true, value: undefined }), 300),
        ),
      ]);
      if (chunk.value !== undefined) text += decoder.decode(chunk.value);
    }
    expect(text).toContain('changed');
    await reader.cancel();
  });

  it('open event streams do not prevent the server from closing', async () => {
    await fetch(`${base}/api/events`);
    // afterEach closes the server; hanging there would fail this test by timeout.
  });
});

describe('malformed input cannot corrupt the store', () => {
  it('rejects an invalid type and leaves the task intact', async () => {
    addTask(store, { name: 'a' });
    const res = await patch('/api/tasks/t1', { type: 'epic' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/task or decision/);
    expect(store.load('t1').type).toBe('task'); // file still parses, unchanged
  });

  it('rejects an invalid type on create', async () => {
    expect((await post('/api/tasks', { name: 'x', type: 'epic' })).status).toBe(400);
  });

  it('rejects a malformed priority', async () => {
    expect((await post('/api/tasks', { name: 'x', priority: 'banana' })).status).toBe(400);
    addTask(store, { name: 'a' });
    expect((await post('/api/tasks/t1/bump', { target: 1.5 })).status).toBe(400);
  });

  it('rejects non-list relationship fields', async () => {
    expect((await post('/api/tasks', { name: 'x', blockedBy: 't1' })).status).toBe(400);
    addTask(store, { name: 'a' });
    expect((await patch('/api/tasks/t1', { addBlockedBy: 't1' })).status).toBe(400);
  });

  it('rejects an unknown status value', async () => {
    addTask(store, { name: 'a' });
    const res = await post('/api/tasks/t1/status', { status: 'wip' });
    expect(res.status).toBe(400);
    expect(store.load('t1').status).toBe('todo');
  });
});

describe('errors', () => {
  it('400s an unknown task id with the message', async () => {
    const res = await patch('/api/tasks/t9', { name: 'x' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('t9');
  });

  it('400s invalid JSON', async () => {
    const res = await fetch(`${base}/api/tasks`, { method: 'POST', body: 'not json{' });
    expect(res.status).toBe(400);
  });

  it('404s unknown api routes', async () => {
    const res = await fetch(`${base}/api/nope`);
    expect(res.status).toBe(404);
  });
});
