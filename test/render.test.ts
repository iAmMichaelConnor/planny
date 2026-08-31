import { describe, expect, it } from 'vitest';
import {
  renderDependencyForest,
  renderExport,
  renderProgressLine,
  renderShow,
  renderTaskList,
} from '../src/render.js';
import { makeTask } from './helpers.js';

const family = [
  makeTask('t1', { name: 'Epic' }),
  makeTask('t2', { name: 'Step one', parent: 't1', status: 'done' }),
  makeTask('t3', { name: 'Step two', parent: 't1', blockedBy: ['t2'] }),
  makeTask('t4', { name: 'Question', type: 'decision' }),
];

describe('renderTaskList', () => {
  it('indents children under parents with status markers', () => {
    const text = renderTaskList(family, {});
    const lines = text.split('\n');
    expect(lines[0]).toBe('- [ ] t1 Epic');
    expect(lines[1]).toBe('  - [x] t2 Step one');
    expect(text).toContain('- [ ] t3 Step two');
  });

  it('marks decisions and cancelled tasks', () => {
    const text = renderTaskList(
      [makeTask('t1', { name: 'Gone', status: 'cancelled', replacedBy: ['t2'] }), ...family],
      {},
    );
    expect(text).toContain('[-] t1 Gone');
    expect(text).toContain('replaced by t2');
    expect(text).toContain('(decision)');
  });

  it('annotates blocked tasks with their active blockers', () => {
    const text = renderTaskList(family, {});
    expect(text).not.toContain('waits on t2'); // t2 is done, so t3 is not blocked
    const blocked = renderTaskList(
      [makeTask('t1', { name: 'A' }), makeTask('t2', { name: 'B', blockedBy: ['t1'] })],
      {},
    );
    expect(blocked).toContain('waits on t1');
  });

  it('filters by status but keeps ancestors of matches for context', () => {
    const text = renderTaskList(family, { status: ['done'] });
    expect(text).toContain('t2 Step one');
    expect(text).toContain('t1 Epic'); // context ancestor
    expect(text).not.toContain('t3');
    expect(text).not.toContain('t4');
  });

  it('says so when nothing matches', () => {
    expect(renderTaskList([], {})).toMatch(/no tasks/i);
  });
});

describe('renderDependencyForest', () => {
  it('nests blocked tasks under their blockers', () => {
    const text = renderDependencyForest([
      makeTask('t1', { name: 'First' }),
      makeTask('t2', { name: 'Second', blockedBy: ['t1'] }),
      makeTask('t3', { name: 'Third', blockedBy: ['t2'] }),
    ]);
    const lines = text.split('\n');
    expect(lines[0]).toContain('t1 First');
    expect(lines[1]).toContain('t2 Second');
    expect(lines[1]!.indexOf('t2')).toBeGreaterThan(lines[0]!.indexOf('t1'));
    expect(lines[2]!.indexOf('t3')).toBeGreaterThan(lines[1]!.indexOf('t2'));
  });

  it('repeats a task under each of its blockers with a note', () => {
    const text = renderDependencyForest([
      makeTask('t1', { name: 'A' }),
      makeTask('t2', { name: 'B' }),
      makeTask('t3', { name: 'C', blockedBy: ['t1', 't2'] }),
    ]);
    expect(text.match(/t3 C/g)?.length).toBe(2);
    expect(text).toContain('also waits on');
  });

  it('says so when there are no dependencies', () => {
    expect(renderDependencyForest([makeTask('t1')])).toMatch(/no dependencies/i);
  });
});

describe('holder in labels', () => {
  it('an in-progress task names its holder in the terminal label', () => {
    const tasks = [
      makeTask('t1', {
        status: 'in-progress',
        history: [{ at: '2026-08-31T12:00:00.000Z', status: 'in-progress', by: 'sess-w' }],
      }),
    ];
    expect(renderTaskList(tasks, {})).toContain('sess-w');
  });
});

describe('renderProgressLine', () => {
  it('shows a bar, the percentage and the counts', () => {
    const line = renderProgressLine({
      done: 2,
      total: 5,
      percent: 40,
      byStatus: { todo: 2, 'in-progress': 1, done: 2, cancelled: 1 },
    });
    expect(line).toContain('40%');
    expect(line).toContain('2/5');
    expect(line).toContain('1 in progress');
  });
});

describe('renderShow', () => {
  it('prints fields, relationships and the file path', () => {
    const text = renderShow(family[2]!, family, '/repo/.planny/tasks/t3.md');
    expect(text).toContain('t3');
    expect(text).toContain('Step two');
    expect(text).toContain('todo');
    expect(text).toContain('t1'); // parent path
    expect(text).toContain('t2'); // blocker
    expect(text).toContain('/repo/.planny/tasks/t3.md');
  });
});

describe('markdown escaping in exports', () => {
  it('escapes hostile names in the export but not in terminal output', () => {
    const hostile = [makeTask('t1', { name: 'fix *urgent* [x] `now`' })];
    expect(renderExport(hostile, {})).toContain('fix \\*urgent\\* \\[x\\] \\`now\\`');
    expect(renderTaskList(hostile, {})).toContain('fix *urgent* [x] `now`');
  });
});

describe('renderExport', () => {
  it('produces a markdown document with tasks, dependencies and decisions', () => {
    const text = renderExport(family, {});
    expect(text).toMatch(/^# Plan/);
    expect(text).toContain('## Tasks');
    expect(text).toContain('## Dependencies');
    expect(text).toContain('## Open decisions');
    expect(text).toContain('t4 Question');
  });
});
