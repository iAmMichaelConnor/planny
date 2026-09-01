import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { withLock } from './lock.js';
import { listTasks, resolvedDecisions, type ResolvedDecision } from './query.js';
import type { Store } from './store.js';
import type { Status, Task, TaskType } from './types.js';

/**
 * Per-consumer catch-up: "everything since I last asked", then advance my
 * cursor. Cursors live in the store so the agent carries no state.
 *
 * Delivery is at-least-once: the window filter is inclusive, so a change in
 * the same millisecond as a cursor write can repeat on the next call.
 * Consumers must treat the delta as idempotent facts, never as commands.
 */

export interface CatchupResult {
  consumer: string;
  /** The previous cursor; undefined on a consumer's first call. */
  since?: string;
  /** The new cursor (unchanged when peeking). */
  now: string;
  changed: Task[];
  resolved: ResolvedDecision[];
}

/** The delta without bodies or history: sized to be read whole. */
export interface CompactCatchup {
  consumer: string;
  since: string | null;
  now: string;
  resolved: Array<{ id: string; name: string; resolvedAt: string | null; dependants: string[] }>;
  changed: Array<{
    id: string;
    name: string;
    status: Status;
    type: TaskType;
    kind: string;
    updated: string;
  }>;
}

/** The lean row every --compact output shares: no body, no history. */
export function compactTask(task: Task): CompactCatchup['changed'][number] {
  return {
    id: task.id,
    name: task.name,
    status: task.status,
    type: task.type,
    kind: task.kind,
    updated: task.updated,
  };
}

export function compactCatchup(result: CatchupResult): CompactCatchup {
  return {
    consumer: result.consumer,
    since: result.since ?? null,
    now: result.now,
    resolved: result.resolved.map(({ task, dependants }) => ({
      id: task.id,
      name: task.name,
      resolvedAt: task.resolvedAt ?? null,
      dependants: dependants.map((t) => t.id),
    })),
    changed: result.changed.map(compactTask),
  };
}

const CURSOR_FILE = 'cursors.json';

export function catchup(
  store: Store,
  consumer: string,
  options: { peek?: boolean } = {},
): CatchupResult {
  if (consumer.trim() === '') throw new Error('catchup needs a consumer id');
  // The lock spans read-query-advance so a concurrent mutation cannot land
  // between the query and the cursor write and get skipped.
  return withLock(store.root, () => {
    const file = join(store.root, '.planny', CURSOR_FILE);
    const cursors: Record<string, string> = existsSync(file)
      ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>)
      : {};
    const since = cursors[consumer];
    const now = new Date().toISOString();
    const changed = listTasks(store, { changedSince: since });
    const resolved = resolvedDecisions(store, since);
    if (options.peek !== true) {
      cursors[consumer] = now;
      writeFileSync(file, `${JSON.stringify(cursors, null, 2)}\n`);
    }
    return { consumer, since, now, changed, resolved };
  });
}
