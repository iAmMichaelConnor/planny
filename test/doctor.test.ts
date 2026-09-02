import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { diagnose, fixStore, type Finding } from '../src/doctor.js';
import { initRepo, openStore, type Store } from '../src/store.js';
import type { Task } from '../src/types.js';
import { makeTask } from './helpers.js';

/**
 * Broken states are written with store.save / writeFileSync on purpose:
 * that is exactly the hand editing the doctor exists to catch. The CLI
 * would reject all of these.
 */

let dir: string;
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'planny-doc-'));
  initRepo(dir);
  store = openStore(dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function save(...tasks: Task[]): void {
  for (const task of tasks) store.save(task);
}

function codes(findings: Finding[]): string[] {
  return findings.map((f) => f.code).sort();
}

function byCode(findings: Finding[], code: string): Finding[] {
  return findings.filter((f) => f.code === code);
}

describe('diagnose', () => {
  it('flags files in tasks/ that the CLI does not write', () => {
    // Invisible today: listIds() skips them, so no command ever sees them.
    writeFileSync(join(store.tasksDir, 'notes.md'), 'scratch notes\n');
    writeFileSync(join(store.tasksDir, 't1.md.bak'), 'an old backup\n');
    save(makeTask('t1'));
    const foreign = byCode(diagnose(store), 'foreign-file');
    expect(foreign).toHaveLength(2);
    expect(foreign.map((f) => f.file).sort()).toEqual([
      join(store.tasksDir, 'notes.md'),
      join(store.tasksDir, 't1.md.bak'),
    ]);
    expect(foreign[0]!.severity).toBe('warning'); // nothing breaks, but it may be lost work
    expect(foreign[0]!.fixable).toBe(false); // deleting or importing has no single right answer
    expect(foreign[0]!.message).toMatch(/planny add/); // says how to import it properly
  });

  it('finds nothing wrong with a healthy store', () => {
    save(
      makeTask('t1'),
      makeTask('t2', { parent: 't1', blockedBy: ['t1'], priority: 20 }),
    );
    expect(diagnose(store)).toEqual([]);
  });

  it('reports unreadable files and id mismatches as errors', () => {
    save(makeTask('t1'));
    writeFileSync(store.path('t2'), 'garbage');
    writeFileSync(store.path('t3'), `---\nid: t9\nname: x\nstatus: todo\ntype: task\nkind: ai\npriority: 30\ncreated: c\nupdated: u\n---\n`);
    const findings = diagnose(store);
    expect(codes(findings)).toEqual(['id-mismatch', 'unreadable-file']);
    expect(findings.every((f) => f.severity === 'error' && !f.fixable)).toBe(true);
    expect(byCode(findings, 'unreadable-file')[0]!.file).toBe(store.path('t2'));
  });

  it('flags an unresolved git merge conflict by name, not as a generic unreadable file', () => {
    save(makeTask('t1'));
    const good = readFileSync(store.path('t1'), 'utf8');
    writeFileSync(store.path('t1'), `<<<<<<< HEAD\n${good}=======\n${good}>>>>>>> feature\n`);
    const findings = diagnose(store);
    const conflict = byCode(findings, 'merge-conflict');
    expect(conflict).toHaveLength(1);
    expect(conflict[0]!.message).toMatch(/resolve the merge/);
    expect(conflict[0]!.fixable).toBe(false);
    expect(byCode(findings, 'unreadable-file')).toHaveLength(0);
  });

  it('reports a store that sits behind its last-seen mark, and does not fix it', () => {
    save(makeTask('t1'));
    save(makeTask('t2'));
    // A checkout rewound the plan: t2 is gone but the mark remembers it.
    rmSync(store.path('t2'));
    const findings = byCode(diagnose(store), 'store-rewound');
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe('warning');
    expect(findings[0]!.fixable).toBe(false);
    // The message must be a recipe, not a shrug: how to find the newer
    // snapshot, how to bring it back, and how to accept the rewind.
    expect(findings[0]!.message).toMatch(/git log --all --oneline -- \.planny/);
    expect(findings[0]!.message).toMatch(/git checkout <commit> -- \.planny/);
    expect(findings[0]!.message).toMatch(/delete last-seen\.json/);
    // The skill carries no rule for this, so the message itself must
    // say the choice is the operator's, not an agent's.
    expect(findings[0]!.message).toMatch(/operator/);
    expect(findings[0]!.message).toMatch(/agent/);
    // Accepting a rewind is the operator's act; fix must leave it alone.
    fixStore(store);
    expect(byCode(diagnose(store), 'store-rewound')).toHaveLength(1);
  });

  it('flags an unreadable last-seen file as fixable, and fix deletes it', () => {
    save(makeTask('t1'));
    const lastSeenFile = join(dir, '.planny', 'last-seen.json');
    writeFileSync(lastSeenFile, 'not json');
    const findings = byCode(diagnose(store), 'last-seen-unreadable');
    expect(findings).toHaveLength(1);
    expect(findings[0]!.fixable).toBe(true);
    fixStore(store);
    expect(existsSync(lastSeenFile)).toBe(false);
    expect(byCode(diagnose(store), 'last-seen-unreadable')).toHaveLength(0);
  });

  it('reports dangling parent, blocker and replacement references as fixable errors', () => {
    save(
      makeTask('t1', { parent: 't9' }),
      makeTask('t2', { blockedBy: ['t8'], priority: 20 }),
      makeTask('t3', { status: 'cancelled', replacedBy: ['t7'], priority: 30 }),
    );
    const findings = diagnose(store);
    expect(codes(findings)).toEqual(['dangling-blocker', 'dangling-parent', 'dangling-replacement']);
    expect(findings.every((f) => f.severity === 'error' && f.fixable)).toBe(true);
    expect(byCode(findings, 'dangling-parent')[0]!.message).toContain('t9');
  });

  it('reports duplicate ranks once per rank, as a fixable warning', () => {
    save(
      makeTask('t1', { priority: 10 }),
      makeTask('t2', { priority: 10 }),
      makeTask('t3', { priority: 10 }),
      makeTask('t4', { priority: 40 }),
    );
    const findings = diagnose(store);
    expect(codes(findings)).toEqual(['duplicate-rank']);
    const finding = findings[0]!;
    expect(finding.severity).toBe('warning');
    expect(finding.fixable).toBe(true);
    expect(finding.message).toMatch(/t1.*t2.*t3/);
  });

  it('reports parent cycles once, with the loop spelled out', () => {
    save(
      makeTask('t1', { parent: 't2' }),
      makeTask('t2', { parent: 't1', priority: 20 }),
      makeTask('t3', { priority: 30 }),
    );
    const findings = diagnose(store);
    expect(codes(findings)).toEqual(['parent-cycle']);
    expect(findings[0]!.fixable).toBe(false);
    expect(findings[0]!.message).toContain('t1');
    expect(findings[0]!.message).toContain('t2');
  });

  it('reports dependency cycles once per loop', () => {
    save(
      makeTask('t1', { blockedBy: ['t2'] }),
      makeTask('t2', { blockedBy: ['t1'], priority: 20 }),
      makeTask('t3', { blockedBy: ['t3'], priority: 30 }),
    );
    const findings = diagnose(store);
    expect(codes(findings)).toEqual(['dependency-cycle', 'dependency-cycle']);
  });

  it('reports an active task ranked above its active blocker', () => {
    save(
      makeTask('t1', { blockedBy: ['t2'], priority: 10 }),
      makeTask('t2', { priority: 20 }),
    );
    const findings = diagnose(store);
    expect(codes(findings)).toEqual(['order-violation']);
    expect(findings[0]!.fixable).toBe(true);
  });

  it('does not report order violations for finished tasks', () => {
    save(
      makeTask('t1', { blockedBy: ['t2'], priority: 10, status: 'done' }),
      makeTask('t2', { priority: 20 }),
    );
    expect(diagnose(store)).toEqual([]);
  });

  it('reports status inconsistencies as warnings', () => {
    save(
      makeTask('t1', { status: 'cancelled', replacedBy: ['t4'] }),
      makeTask('t2', { blockedBy: ['t1'], priority: 20 }), // still waits on a cancelled task
      makeTask('t3', { type: 'decision', status: 'done', priority: 30 }), // no outcome
      makeTask('t4', { parent: 't1', priority: 40 }), // active child of cancelled parent
    );
    const findings = diagnose(store);
    expect(codes(findings)).toEqual(['cancelled-blocker', 'cancelled-parent', 'unresolved-decision']);
    expect(findings.every((f) => f.severity === 'warning')).toBe(true);
    expect(byCode(findings, 'cancelled-blocker')[0]!.fixable).toBe(true);
  });

  it('accepts a done decision that has an outcome', () => {
    save(
      makeTask('t1', {
        type: 'decision',
        status: 'done',
        resolvedAt: '2026-08-31T12:00:00.000Z',
        body: '## Outcome\n\nAgreed.',
      }),
    );
    expect(diagnose(store)).toEqual([]);
  });
});

describe('post-doctor feature coverage', () => {
  it('flags history entries out of time order, and fix sorts them', () => {
    save(
      makeTask('t1', {
        status: 'done',
        history: [
          { at: '2026-08-31T13:00:00.000Z', status: 'done' },
          { at: '2026-08-31T12:00:00.000Z', status: 'in-progress' },
        ],
      }),
    );
    const findings = diagnose(store);
    expect(codes(findings)).toContain('history-order');
    expect(byCode(findings, 'history-order')[0]!.fixable).toBe(true);
    fixStore(store);
    const history = store.load('t1').history;
    expect(history.map((e) => e.at)).toEqual([
      '2026-08-31T12:00:00.000Z',
      '2026-08-31T13:00:00.000Z',
    ]);
    expect(codes(diagnose(store))).not.toContain('history-order');
  });

  it('flags a status that disagrees with the history trail', () => {
    save(
      makeTask('t1', {
        status: 'todo',
        history: [{ at: '2026-08-31T12:00:00.000Z', status: 'done', by: 'sess-a' }],
      }),
    );
    const findings = byCode(diagnose(store), 'status-history-mismatch');
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe('warning');
    expect(findings[0]!.fixable).toBe(false);
  });

  it('flags an in-progress task with no claim on record', () => {
    save(makeTask('t1', { status: 'in-progress', history: [] }));
    expect(codes(diagnose(store))).toContain('unclaimed-in-progress');
  });

  it('flags replaced_by on a task that is not cancelled', () => {
    save(makeTask('t1'), makeTask('t2', { replacedBy: ['t1'], priority: 20 }));
    const findings = byCode(diagnose(store), 'stray-replaced-by');
    expect(findings).toHaveLength(1);
    expect(findings[0]!.fixable).toBe(false);
  });

  it('flags a decision carrying two live outcome tasks', () => {
    save(
      makeTask('t1', {
        type: 'decision',
        status: 'done',
        resolvedAt: '2026-09-02T01:00:00.000Z',
        body: 'Q?\n\n## Outcome\n\nYes.\n\nOutcome task: t2\n\n## Outcome\n\nYes.\n\nOutcome task: t3',
      }),
      makeTask('t2', { parent: 't1', priority: 20 }),
      makeTask('t3', { parent: 't1', priority: 30 }),
    );
    const findings = byCode(diagnose(store), 'duplicate-outcome');
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe('warning');
    expect(findings[0]!.fixable).toBe(false);
    expect(findings[0]!.message).toContain('t2');
    expect(findings[0]!.message).toContain('t3');
  });

  it('says nothing when only one outcome task is still open', () => {
    save(
      makeTask('t1', {
        type: 'decision',
        status: 'done',
        resolvedAt: '2026-09-02T01:00:00.000Z',
        body: 'Q?\n\nOutcome task: t2\n\nOutcome task: t3',
      }),
      makeTask('t2', { parent: 't1', status: 'done', priority: 20 }),
      makeTask('t3', { parent: 't1', priority: 30 }),
    );
    expect(codes(diagnose(store))).not.toContain('duplicate-outcome');
  });

  it('says nothing about a decision with one outcome task', () => {
    save(
      makeTask('t1', {
        type: 'decision',
        status: 'done',
        resolvedAt: '2026-09-02T01:00:00.000Z',
        body: 'Q?\n\nOutcome task: t2',
      }),
      makeTask('t2', { parent: 't1', priority: 20 }),
    );
    expect(codes(diagnose(store))).not.toContain('duplicate-outcome');
  });

  it('flags a wake note on a task that is not parked, and fix drops it', () => {
    save(makeTask('t1', { parkedUntil: 'the API ships' }));
    const findings = byCode(diagnose(store), 'stray-wake-note');
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe('warning');
    expect(findings[0]!.fixable).toBe(true);
    const { remaining } = fixStore(store);
    expect(codes(remaining)).not.toContain('stray-wake-note');
    expect(store.load('t1').parkedUntil).toBeUndefined();
  });

  it('leaves a wake note alone on a parked task', () => {
    save(makeTask('t1', { status: 'parked', parkedUntil: 'the API ships' }));
    expect(codes(diagnose(store))).not.toContain('stray-wake-note');
  });

  it('flags an unreadable cursors file as a fixable error, and fix resets it', () => {
    save(makeTask('t1'));
    writeFileSync(join(dir, '.planny', 'cursors.json'), 'not json{');
    const findings = byCode(diagnose(store), 'cursors-unreadable');
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe('error');
    expect(findings[0]!.fixable).toBe(true);
    const { remaining } = fixStore(store);
    expect(codes(remaining)).not.toContain('cursors-unreadable');
  });

  it('flags a future cursor (it would suppress deliveries), and fix drops it', () => {
    save(makeTask('t1'));
    writeFileSync(
      join(dir, '.planny', 'cursors.json'),
      JSON.stringify({ 'agent-x': '2099-01-01T00:00:00.000Z', 'agent-y': '2020-01-01T00:00:00.000Z' }),
    );
    const findings = byCode(diagnose(store), 'cursor-in-future');
    expect(findings).toHaveLength(1);
    expect(findings[0]!.message).toContain('agent-x');
    fixStore(store);
    const cursors = JSON.parse(readFileSync(join(dir, '.planny', 'cursors.json'), 'utf8'));
    expect(cursors['agent-x']).toBeUndefined();
    expect(cursors['agent-y']).toBe('2020-01-01T00:00:00.000Z');
  });

  it('flags a stale lock; a fresh lock is another process at work, not a problem', () => {
    save(makeTask('t1'));
    const lock = join(dir, '.planny', 'lock');
    writeFileSync(lock, '12345');
    expect(codes(diagnose(store))).not.toContain('stale-lock'); // fresh
    const old = (Date.now() - 60_000) / 1000;
    utimesSync(lock, old, old);
    expect(codes(diagnose(store))).toContain('stale-lock');
    fixStore(store); // acquiring the write lock breaks the stale one
    expect(codes(diagnose(store))).not.toContain('stale-lock');
  });
});

describe('fixStore', () => {
  it('does nothing to a healthy store', () => {
    save(makeTask('t1'));
    const before = store.load('t1');
    const { applied, remaining } = fixStore(store);
    expect(applied).toEqual([]);
    expect(remaining).toEqual([]);
    expect(store.load('t1')).toEqual(before);
  });

  it('drops dangling references and bumps updated', () => {
    save(
      makeTask('t1', { parent: 't9', blockedBy: ['t8'] }),
      makeTask('t2', { status: 'cancelled', replacedBy: ['t7'], priority: 20 }),
    );
    const { remaining } = fixStore(store);
    expect(remaining).toEqual([]);
    const t1 = store.load('t1');
    expect(t1.parent).toBeUndefined();
    expect(t1.blockedBy).toEqual([]);
    expect(Date.parse(t1.updated)).toBeGreaterThan(Date.parse(t1.created));
    expect(store.load('t2').replacedBy).toEqual([]);
  });

  it('rewires a cancelled blocker onto its replacements', () => {
    save(
      makeTask('t1', { status: 'cancelled', replacedBy: ['t3'] }),
      makeTask('t2', { blockedBy: ['t1'], priority: 20 }),
      makeTask('t3', { priority: 30 }),
    );
    fixStore(store);
    expect(store.load('t2').blockedBy).toEqual(['t3']);
  });

  it('re-ranks duplicates preserving order and repairs order violations', () => {
    save(
      makeTask('t1', { priority: 10 }),
      makeTask('t2', { priority: 10 }),
      makeTask('t3', { blockedBy: ['t4'], priority: 15 }),
      makeTask('t4', { priority: 20 }),
    );
    const { remaining } = fixStore(store);
    expect(remaining).toEqual([]);
    const tasks = store.loadAll();
    const ranks = tasks.map((t) => t.priority);
    expect(new Set(ranks).size).toBe(ranks.length);
    expect(store.load('t3').priority).toBeGreaterThan(store.load('t4').priority);
  });

  it('leaves cycles alone and reports them as remaining', () => {
    save(
      makeTask('t1', { parent: 't2' }),
      makeTask('t2', { parent: 't1', priority: 20 }),
      makeTask('t3', { blockedBy: ['t3'], priority: 30 }),
    );
    const { applied, remaining } = fixStore(store);
    expect(applied).toEqual([]);
    expect(codes(remaining)).toEqual(['dependency-cycle', 'parent-cycle']);
    expect(store.load('t1').parent).toBe('t2');
  });

  it('skips order repair while a dependency cycle exists', () => {
    save(
      makeTask('t1', { blockedBy: ['t2'], priority: 10 }),
      makeTask('t2', { blockedBy: ['t1'], priority: 20 }),
      makeTask('t3', { blockedBy: ['t4'], priority: 30 }),
      makeTask('t4', { priority: 40 }),
    );
    const { remaining } = fixStore(store);
    // The cycle stays; the t3/t4 violation must wait for the operator to cut it.
    expect(codes(remaining)).toContain('dependency-cycle');
    expect(codes(remaining)).toContain('order-violation');
  });
});
