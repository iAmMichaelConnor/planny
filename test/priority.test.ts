import { describe, expect, it } from 'vitest';
import { bumpPriority, repairDependencyOrder, sortByPriority } from '../src/priority.js';
import { isActive, type Task } from '../src/types.js';
import { makeTask } from './helpers.js';

function activeOrder(tasks: Task[]): string[] {
  return sortByPriority(tasks.filter(isActive)).map((t) => t.id);
}

function expectUniqueRanks(tasks: Task[]): void {
  const ranks = tasks.map((t) => t.priority);
  expect(new Set(ranks).size).toBe(ranks.length);
}

describe('sortByPriority', () => {
  it('orders ascending by rank without mutating input', () => {
    const tasks = [makeTask('t1', { priority: 30 }), makeTask('t2', { priority: 10 })];
    expect(sortByPriority(tasks).map((t) => t.id)).toEqual(['t2', 't1']);
    expect(tasks[0]!.id).toBe('t1');
  });
});

describe('bumpPriority', () => {
  it('moves a task to the top', () => {
    const tasks = [makeTask('t1'), makeTask('t2'), makeTask('t3')];
    const changed = bumpPriority(tasks, 't3', 'top');
    expect(activeOrder(tasks)).toEqual(['t3', 't1', 't2']);
    expect(changed.has('t3')).toBe(true);
    expectUniqueRanks(tasks);
  });

  it('moves a task to the bottom', () => {
    const tasks = [makeTask('t1'), makeTask('t2'), makeTask('t3')];
    bumpPriority(tasks, 't1', 'bottom');
    expect(activeOrder(tasks)).toEqual(['t2', 't3', 't1']);
    expectUniqueRanks(tasks);
  });

  it('moves a task to a numeric 1-based position', () => {
    const tasks = [makeTask('t1'), makeTask('t2'), makeTask('t3'), makeTask('t4')];
    bumpPriority(tasks, 't4', 2);
    expect(activeOrder(tasks)).toEqual(['t1', 't4', 't2', 't3']);
    expectUniqueRanks(tasks);
  });

  it('clamps an out-of-range position to the ends', () => {
    const tasks = [makeTask('t1'), makeTask('t2'), makeTask('t3')];
    bumpPriority(tasks, 't2', 99);
    expect(activeOrder(tasks)).toEqual(['t1', 't3', 't2']);
    bumpPriority(tasks, 't2', 0);
    expect(activeOrder(tasks)).toEqual(['t2', 't1', 't3']);
  });

  it('clamps below active blockers: a blocked task cannot pass its blocker', () => {
    const tasks = [
      makeTask('t1'),
      makeTask('t2', { blockedBy: ['t1'] }),
      makeTask('t3'),
    ];
    bumpPriority(tasks, 't2', 'top');
    expect(activeOrder(tasks)).toEqual(['t1', 't2', 't3']);
  });

  it('clamps above active dependants: a blocker cannot pass a task it blocks', () => {
    const tasks = [
      makeTask('t1'),
      makeTask('t2'),
      makeTask('t3', { blockedBy: ['t1'] }),
    ];
    bumpPriority(tasks, 't1', 'bottom');
    expect(activeOrder(tasks)).toEqual(['t2', 't1', 't3']);
  });

  it('ignores finished blockers when clamping', () => {
    const tasks = [
      makeTask('t1', { status: 'done' }),
      makeTask('t2', { blockedBy: ['t1'] }),
      makeTask('t3'),
    ];
    bumpPriority(tasks, 't2', 'top');
    expect(activeOrder(tasks)).toEqual(['t2', 't3']);
  });

  it('renormalizes when there is no rank gap at the insertion point', () => {
    const tasks = [
      makeTask('t1', { priority: 1 }),
      makeTask('t2', { priority: 2 }),
      makeTask('t3', { priority: 3 }),
    ];
    const changed = bumpPriority(tasks, 't3', 2);
    expect(activeOrder(tasks)).toEqual(['t1', 't3', 't2']);
    expectUniqueRanks(tasks);
    expect(changed.has('t3')).toBe(true);
  });

  it('throws for an unknown id', () => {
    expect(() => bumpPriority([makeTask('t1')], 't9', 'top')).toThrow(/t9/);
  });
});

describe('repairDependencyOrder', () => {
  it('returns an empty set when the invariant already holds', () => {
    const tasks = [makeTask('t1'), makeTask('t2', { blockedBy: ['t1'] })];
    expect(repairDependencyOrder(tasks).size).toBe(0);
  });

  it('demotes a blocked task to just after its blocker', () => {
    const tasks = [
      makeTask('t1', { priority: 10, blockedBy: ['t3'] }),
      makeTask('t2', { priority: 20 }),
      makeTask('t3', { priority: 30 }),
    ];
    const changed = repairDependencyOrder(tasks);
    expect(activeOrder(tasks)).toEqual(['t2', 't3', 't1']);
    expect(changed).toEqual(new Set(['t1']));
    expectUniqueRanks(tasks);
  });

  it('cascades through chains of dependants', () => {
    const tasks = [
      makeTask('t2', { priority: 10, blockedBy: ['t3'] }),
      makeTask('t4', { priority: 20, blockedBy: ['t2'] }),
      makeTask('t3', { priority: 30 }),
    ];
    repairDependencyOrder(tasks);
    expect(activeOrder(tasks)).toEqual(['t3', 't2', 't4']);
    expectUniqueRanks(tasks);
  });

  it('ignores violations involving finished tasks', () => {
    const tasks = [
      makeTask('t1', { priority: 10, blockedBy: ['t2'] }),
      makeTask('t2', { priority: 20, status: 'done' }),
    ];
    expect(repairDependencyOrder(tasks).size).toBe(0);
  });
});
