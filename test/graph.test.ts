import { describe, expect, it } from 'vitest';
import { buildGraph } from '../src/graph.js';
import { makeTask } from './helpers.js';

describe('buildGraph', () => {
  it('derives children from parent links, sorted by priority', () => {
    const graph = buildGraph([
      makeTask('t1'),
      makeTask('t2', { parent: 't1', priority: 30 }),
      makeTask('t3', { parent: 't1', priority: 20 }),
    ]);
    expect(graph.children('t1').map((t) => t.id)).toEqual(['t3', 't2']);
    expect(graph.children('t2')).toEqual([]);
  });

  it('derives blocking as the inverse of blocked_by', () => {
    const graph = buildGraph([
      makeTask('t1'),
      makeTask('t2', { blockedBy: ['t1'] }),
      makeTask('t3', { blockedBy: ['t1'] }),
    ]);
    expect(graph.blocking('t1').map((t) => t.id)).toEqual(['t2', 't3']);
    expect(graph.blocking('t2')).toEqual([]);
  });

  it('walks ancestors nearest-first and descendants depth-first', () => {
    const graph = buildGraph([
      makeTask('t1'),
      makeTask('t2', { parent: 't1' }),
      makeTask('t3', { parent: 't2' }),
      makeTask('t4', { parent: 't1' }),
    ]);
    expect(graph.ancestors('t3').map((t) => t.id)).toEqual(['t2', 't1']);
    expect(graph.descendants('t1').map((t) => t.id)).toEqual(['t2', 't3', 't4']);
    expect(graph.ancestors('t1')).toEqual([]);
  });

  it('lists roots (tasks without a parent) sorted by priority', () => {
    const graph = buildGraph([
      makeTask('t1', { priority: 20 }),
      makeTask('t2', { priority: 10 }),
      makeTask('t3', { parent: 't1' }),
    ]);
    expect(graph.roots().map((t) => t.id)).toEqual(['t2', 't1']);
  });

  it('activeBlockers ignores done and cancelled blockers', () => {
    const graph = buildGraph([
      makeTask('t1', { status: 'done' }),
      makeTask('t2', { status: 'cancelled' }),
      makeTask('t3', { status: 'in-progress' }),
      makeTask('t4', { blockedBy: ['t1', 't2', 't3'] }),
    ]);
    expect(graph.activeBlockers('t4').map((t) => t.id)).toEqual(['t3']);
    expect(graph.isBlocked('t4')).toBe(true);
  });

  it('isBlocked is false when every blocker is finished', () => {
    const graph = buildGraph([
      makeTask('t1', { status: 'done' }),
      makeTask('t2', { blockedBy: ['t1'] }),
    ]);
    expect(graph.isBlocked('t2')).toBe(false);
  });

  it('tolerates dangling references', () => {
    const graph = buildGraph([makeTask('t1', { parent: 't99', blockedBy: ['t98'] })]);
    expect(graph.ancestors('t1')).toEqual([]);
    expect(graph.activeBlockers('t1')).toEqual([]);
  });

  it('detects parent cycles, including self-parent and transitive', () => {
    const graph = buildGraph([
      makeTask('t1'),
      makeTask('t2', { parent: 't1' }),
      makeTask('t3', { parent: 't2' }),
    ]);
    expect(graph.wouldCycleParent('t1', 't1')).toBe(true);
    expect(graph.wouldCycleParent('t1', 't3')).toBe(true);
    expect(graph.wouldCycleParent('t3', 't1')).toBe(false);
  });

  it('detects dependency cycles, including self and transitive', () => {
    const graph = buildGraph([
      makeTask('t1'),
      makeTask('t2', { blockedBy: ['t1'] }),
      makeTask('t3', { blockedBy: ['t2'] }),
    ]);
    // t1 blocked by t3 would close the loop t1 -> t2 -> t3 -> t1
    expect(graph.wouldCycleDependency('t1', 't3')).toBe(true);
    expect(graph.wouldCycleDependency('t1', 't1')).toBe(true);
    expect(graph.wouldCycleDependency('t3', 't1')).toBe(false);
  });
});
