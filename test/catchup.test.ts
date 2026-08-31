import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { catchup } from '../src/catchup.js';
import { addTask, resolveDecision, setStatus } from '../src/ops.js';
import { initRepo, openStore, type Store } from '../src/store.js';

let dir: string;
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'planny-cu-'));
  initRepo(dir);
  store = openStore(dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Delivery is at-least-once: a change in the same millisecond as a cursor
 * write may repeat on the next call (duplicates beat losses). The ticks
 * separate timestamps so these tests assert the common, separated case.
 */
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe('catchup', () => {
  it('first call returns everything and advances the cursor', async () => {
    addTask(store, { name: 'a' });
    addTask(store, { name: 'b' });
    await tick();
    const first = catchup(store, 'agent-1');
    expect(first.since).toBeUndefined();
    expect(first.changed.map((t) => t.id)).toEqual(['t1', 't2']);
    const second = catchup(store, 'agent-1');
    expect(second.since).toBe(first.now);
    expect(second.changed).toEqual([]);
  });

  it('changes between calls are delivered, then not repeated', async () => {
    addTask(store, { name: 'a' });
    await tick();
    catchup(store, 'agent-1');
    await tick();
    setStatus(store, 't1', 'done');
    await tick();
    const result = catchup(store, 'agent-1');
    expect(result.changed.map((t) => t.id)).toEqual(['t1']);
    expect(catchup(store, 'agent-1').changed).toEqual([]);
  });

  it('includes decisions resolved since the cursor', async () => {
    addTask(store, { name: 'q', type: 'decision' });
    await tick();
    catchup(store, 'agent-1');
    await tick();
    resolveDecision(store, 't1', 'Yes.');
    await tick();
    const result = catchup(store, 'agent-1');
    expect(result.resolved.map((r) => r.task.id)).toEqual(['t1']);
  });

  it('peek reads without advancing', () => {
    addTask(store, { name: 'a' });
    const peeked = catchup(store, 'agent-1', { peek: true });
    expect(peeked.changed).toHaveLength(1);
    expect(catchup(store, 'agent-1').changed).toHaveLength(1); // still there
  });

  it('consumers have independent cursors', async () => {
    addTask(store, { name: 'a' });
    await tick();
    catchup(store, 'agent-1');
    expect(catchup(store, 'agent-2').changed).toHaveLength(1);
    expect(catchup(store, 'agent-1').changed).toHaveLength(0);
  });
});
