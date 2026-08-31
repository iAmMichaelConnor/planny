import type { Task } from '../src/types.js';

let stamp = '2026-08-31T12:00:00.000Z';

export function makeTask(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    name: `Task ${id}`,
    status: 'todo',
    type: 'task',
    kind: 'ai',
    priority: Number(id.slice(1)) * 10,
    blockedBy: [],
    replacedBy: [],
    created: stamp,
    updated: stamp,
    history: [],
    body: '',
    ...overrides,
  };
}
