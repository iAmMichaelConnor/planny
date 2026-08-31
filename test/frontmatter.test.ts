import { describe, expect, it } from 'vitest';
import { parseTaskFile, serializeTaskFile } from '../src/frontmatter.js';
import type { Task } from '../src/types.js';

const fullTask: Task = {
  id: 't12',
  name: 'Build the exporter',
  status: 'in-progress',
  type: 'task',
  kind: 'ai',
  model: 'opus',
  priority: 30,
  parent: 't4',
  blockedBy: ['t7', 't9'],
  replacedBy: [],
  created: '2026-08-31T12:00:00.000Z',
  updated: '2026-08-31T13:00:00.000Z',
  history: [],
  body: 'Write the markdown exporter.\n\nIt renders the hierarchy as nested bullets.',
};

describe('serializeTaskFile', () => {
  it('renders YAML frontmatter followed by the body', () => {
    const text = serializeTaskFile(fullTask);
    expect(text).toMatch(/^---\n/);
    expect(text).toContain('id: t12');
    expect(text).toContain('name: Build the exporter');
    expect(text).toContain('blocked_by:');
    expect(text).toContain('\n---\n\nWrite the markdown exporter.');
  });

  it('omits empty optional fields', () => {
    const minimal: Task = {
      ...fullTask,
      model: undefined,
      parent: undefined,
      blockedBy: [],
      replacedBy: [],
    };
    const text = serializeTaskFile(minimal);
    expect(text).not.toContain('model:');
    expect(text).not.toContain('parent:');
    expect(text).not.toContain('blocked_by:');
    expect(text).not.toContain('replaced_by:');
  });
});

describe('parseTaskFile', () => {
  it('round-trips a full task', () => {
    const parsed = parseTaskFile(serializeTaskFile(fullTask));
    expect(parsed).toEqual(fullTask);
  });

  it('round-trips a minimal task and fills defaults', () => {
    const minimal: Task = {
      ...fullTask,
      model: undefined,
      parent: undefined,
      blockedBy: [],
      replacedBy: [],
      body: '',
    };
    const parsed = parseTaskFile(serializeTaskFile(minimal));
    expect(parsed).toEqual(minimal);
  });

  it('keeps a body that itself contains a --- line', () => {
    const tricky: Task = { ...fullTask, body: 'Above\n\n---\n\nBelow the rule.' };
    const parsed = parseTaskFile(serializeTaskFile(tricky));
    expect(parsed.body).toBe('Above\n\n---\n\nBelow the rule.');
  });

  it('preserves a name containing YAML-special characters', () => {
    const tricky: Task = { ...fullTask, name: 'fix: handle "quotes" & colons: everywhere' };
    const parsed = parseTaskFile(serializeTaskFile(tricky));
    expect(parsed.name).toBe('fix: handle "quotes" & colons: everywhere');
  });

  it('rejects text without frontmatter', () => {
    expect(() => parseTaskFile('just some markdown')).toThrow(/frontmatter/i);
  });

  it('rejects frontmatter missing required fields', () => {
    expect(() => parseTaskFile('---\nid: t1\n---\n')).toThrow(/missing required field/i);
  });

  it('rejects an invalid status, listing the valid ones', () => {
    const text = serializeTaskFile(fullTask).replace('status: in-progress', 'status: wip');
    expect(() => parseTaskFile(text)).toThrow(/todo.*in-progress.*done.*cancelled/);
  });

  it('rejects an invalid type, listing the valid ones', () => {
    const text = serializeTaskFile(fullTask).replace('type: task', 'type: epic');
    expect(() => parseTaskFile(text)).toThrow(/task.*decision/);
  });

  it('round-trips attribution and history', () => {
    const tracked: Task = {
      ...fullTask,
      createdBy: 'sess-abc',
      history: [
        { at: '2026-08-31T12:30:00.000Z', status: 'in-progress', by: 'sess-abc' },
        { at: '2026-08-31T13:00:00.000Z', status: 'done' },
      ],
    };
    expect(parseTaskFile(serializeTaskFile(tracked))).toEqual(tracked);
  });

  it('omits empty history and absent created_by', () => {
    const text = serializeTaskFile(fullTask);
    expect(text).not.toContain('history:');
    expect(text).not.toContain('created_by:');
  });

  it('round-trips typed history events', () => {
    const tracked: Task = {
      ...fullTask,
      history: [
        { at: '2026-08-31T12:00:00.000Z', status: 'in-progress', by: 'sess-a' },
        { at: '2026-08-31T12:01:00.000Z', event: 'priority', target: 'top', position: 1, by: 'sess-a' },
        { at: '2026-08-31T12:02:00.000Z', event: 'parent', from: 't1', to: 't2' },
        { at: '2026-08-31T12:03:00.000Z', event: 'blocked-by', added: ['t3'], removed: ['t4'] },
        { at: '2026-08-31T12:04:00.000Z', event: 'rename', from: 'old', to: 'new' },
      ],
    };
    expect(parseTaskFile(serializeTaskFile(tracked))).toEqual(tracked);
  });

  it('rejects an unknown history event kind', () => {
    const tracked: Task = {
      ...fullTask,
      history: [{ at: '2026-08-31T12:00:00.000Z', event: 'rename', from: 'a', to: 'b' }],
    };
    const text = serializeTaskFile(tracked).replace('event: rename', 'event: mystery');
    expect(() => parseTaskFile(text)).toThrow(/history/i);
  });

  it('rejects a malformed history entry', () => {
    const tracked: Task = {
      ...fullTask,
      history: [{ at: '2026-08-31T12:30:00.000Z', status: 'in-progress' }],
    };
    const serialized = serializeTaskFile(tracked);
    expect(serialized).toContain('    status: in-progress'); // the history entry, indented
    const text = serialized.replace('    status: in-progress\n', '');
    expect(() => parseTaskFile(text)).toThrow(/history/i);
  });
});
