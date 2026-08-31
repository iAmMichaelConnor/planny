import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';

let dir: string;
let out: string[];
let err: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'planny-cli-'));
  out = [];
  err = [];
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function run(...args: string[]): Promise<number> {
  return runCli(args, {
    cwd: dir,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  });
}

function allOut(): string {
  return out.join('\n');
}

async function seedTrio(): Promise<void> {
  await run('init');
  await run('add', 'first task');
  await run('add', 'second task');
  await run('add', 'third task');
  out = [];
}

describe('init and add', () => {
  it('init creates the store', async () => {
    expect(await run('init')).toBe(0);
    expect(existsSync(join(dir, '.planny', 'tasks'))).toBe(true);
    expect(allOut()).toMatch(/initialized/i);
  });

  it('commands fail cleanly without init', async () => {
    expect(await run('list')).toBe(1);
    expect(err.join('\n')).toMatch(/planny init/);
  });

  it('add prints the new id', async () => {
    await run('init');
    expect(await run('add', 'my first task')).toBe(0);
    expect(allOut()).toContain('t1');
  });

  it('add accepts description, kind, model, type and relationships', async () => {
    await run('init');
    await run('add', 'parent');
    await run(
      'add', 'child',
      '--desc', 'Do it well.',
      '--kind', 'operator',
      '--model', 'opus',
      '--parent', 't1',
    );
    out = [];
    await run('show', 't2');
    const text = allOut();
    expect(text).toContain('child');
    expect(text).toContain('operator');
    expect(text).toContain('opus');
    expect(text).toContain('Do it well.');
    expect(text).toContain('t1');
  });

  it('rejects a bad reference with exit code 1', async () => {
    await run('init');
    expect(await run('add', 'x', '--parent', 't9')).toBe(1);
    expect(err.join('\n')).toContain('t9');
  });
});

describe('show and list', () => {
  it('show --json includes derived relationships and the file path', async () => {
    await seedTrio();
    await run('update', 't2', '--parent', 't1', '--add-blocked-by', 't3');
    out = [];
    await run('show', 't2', '--json');
    const data = JSON.parse(allOut());
    expect(data.task.id).toBe('t2');
    expect(data.task.parent).toBe('t1');
    expect(data.path.endsWith('t2.md')).toBe(true);
    expect(data.ancestors).toEqual(['t1']);
    expect(data.blockedBy).toEqual(['t3']);
  });

  it('accepts a bare number as an id', async () => {
    await seedTrio();
    await run('show', '2');
    expect(allOut()).toContain('second task');
  });

  it('list filters by status', async () => {
    await seedTrio();
    await run('done', 't1');
    out = [];
    await run('list', '--status', 'done');
    expect(allOut()).toContain('first task');
    expect(allOut()).not.toContain('second task');
  });

  it('list --json returns an array', async () => {
    await seedTrio();
    out = [];
    await run('list', '--json');
    const data = JSON.parse(allOut());
    expect(data.map((t: { id: string }) => t.id)).toEqual(['t1', 't2', 't3']);
  });
});

describe('status commands', () => {
  it('start, done and todo change status', async () => {
    await seedTrio();
    await run('start', 't1');
    expect(allOut()).toContain('in-progress');
    await run('done', 't1');
    await run('todo', 't1');
    out = [];
    await run('show', 't1');
    expect(allOut()).toContain('todo');
  });

  it('done on a blocked task prints a warning but succeeds', async () => {
    await seedTrio();
    await run('update', 't2', '--add-blocked-by', 't1');
    expect(await run('done', 't2')).toBe(0);
    expect(err.join('\n')).toMatch(/blocked/i);
  });

  it('cancel with replacement rewires dependants', async () => {
    await seedTrio();
    await run('update', 't3', '--add-blocked-by', 't1');
    await run('cancel', 't1', '--replaced-by', 't2');
    out = [];
    await run('show', 't3', '--json');
    expect(JSON.parse(allOut()).blockedBy).toEqual(['t2']);
  });
});

describe('ordering', () => {
  it('bump top reorders the list', async () => {
    await seedTrio();
    await run('bump', 't3', 'top');
    out = [];
    await run('list');
    const text = allOut();
    expect(text.indexOf('third task')).toBeLessThan(text.indexOf('first task'));
  });

  it('bump respects blockers and says where the task landed', async () => {
    await seedTrio();
    await run('update', 't2', '--add-blocked-by', 't1');
    out = [];
    await run('bump', 't2', 'top');
    out = [];
    await run('list');
    const text = allOut();
    expect(text.indexOf('first task')).toBeLessThan(text.indexOf('second task'));
  });
});

describe('next', () => {
  it('lists ready tasks with their paths', async () => {
    await run('init');
    await run('add', 'epic');
    await run('add', 'leaf', '--parent', 't1');
    await run('add', 'blocked', '--blocked-by', 't2');
    out = [];
    await run('next');
    const text = allOut();
    expect(text).toContain('leaf');
    expect(text).not.toContain('blocked');
  });

  it('next --json includes path and unlocks', async () => {
    await run('init');
    await run('add', 'epic');
    await run('add', 'leaf', '--parent', 't1');
    await run('add', 'blocked', '--blocked-by', 't2');
    out = [];
    await run('next', '--json');
    const data = JSON.parse(allOut());
    expect(data[0].task.id).toBe('t2');
    expect(data[0].ancestors).toEqual(['t1']);
    expect(data[0].unlocks).toEqual(['t3']);
  });
});

describe('decisions', () => {
  it('lists open decisions and resolves one', async () => {
    await run('init');
    await run('add', 'Pick a database', '--type', 'decision', '--desc', '## Proposal\n\nUse files.');
    out = [];
    await run('decisions');
    expect(allOut()).toContain('Pick a database');
    out = [];
    await run('resolve', 't1', '--response', 'Agreed: use files.');
    out = [];
    await run('show', 't1');
    expect(allOut()).toContain('Agreed: use files.');
    expect(allOut()).toContain('done');
  });

  it('resolve rejects a plain task', async () => {
    await seedTrio();
    expect(await run('resolve', 't1', '--response', 'x')).toBe(1);
    expect(err.join('\n')).toMatch(/decision/i);
  });
});

describe('doctor', () => {
  const brokenTask = (id: string, extra: string): string =>
    `---\nid: ${id}\nname: broken ${id}\nstatus: todo\ntype: task\nkind: ai\npriority: ${Number(id.slice(1)) * 10}\n${extra}created: 2026-08-31T12:00:00.000Z\nupdated: 2026-08-31T12:00:00.000Z\n---\n`;

  it('reports a healthy store and exits 0', async () => {
    await seedTrio();
    expect(await run('doctor')).toBe(0);
    expect(allOut()).toMatch(/healthy/i);
  });

  it('lists problems and exits 1 when errors exist', async () => {
    await seedTrio();
    writeFileSync(join(dir, '.planny', 'tasks', 't1.md'), 'garbage');
    expect(await run('doctor')).toBe(1);
    expect(allOut()).toContain('unreadable-file');
    expect(err.join('\n')).toMatch(/1 error/);
  });

  it('--fix repairs the safe problems and exits 0', async () => {
    await seedTrio();
    writeFileSync(
      join(dir, '.planny', 'tasks', 't2.md'),
      brokenTask('t2', 'blocked_by:\n  - t9\n'),
    );
    expect(await run('doctor', '--fix')).toBe(0);
    expect(allOut()).toMatch(/fixed/i);
    out = [];
    await run('show', 't2', '--json');
    expect(JSON.parse(allOut()).blockedBy).toEqual([]);
  });

  it('--json prints the findings', async () => {
    await seedTrio();
    writeFileSync(
      join(dir, '.planny', 'tasks', 't3.md'),
      brokenTask('t3', 'parent: t9\n'),
    );
    await run('doctor', '--json');
    const findings = JSON.parse(allOut());
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe('dangling-parent');
    expect(findings[0].fixable).toBe(true);
  });
});

describe('attribution and catch-up', () => {
  it('--session stamps created_by and history entries', async () => {
    await run('init');
    await run('--session', 'sess-9', 'add', 'traced task');
    await run('--session', 'sess-9', 'start', 't1');
    out = [];
    await run('show', 't1', '--json');
    const { task } = JSON.parse(allOut());
    expect(task.createdBy).toBe('sess-9');
    expect(task.history[0]).toMatchObject({ status: 'in-progress', by: 'sess-9' });
  });

  it('falls back to the PLANNY_SESSION environment variable', async () => {
    await run('init');
    process.env.PLANNY_SESSION = 'env-sess';
    try {
      await run('add', 'env task');
    } finally {
      delete process.env.PLANNY_SESSION;
    }
    out = [];
    await run('show', 't1', '--json');
    expect(JSON.parse(allOut()).task.createdBy).toBe('env-sess');
  });

  it('list --changed-since filters by update time', async () => {
    await seedTrio();
    const { openStore } = await import('../src/store.js');
    const store = openStore(dir);
    const stale = store.load('t1');
    stale.updated = '2020-01-01T00:00:00.000Z';
    store.save(stale);
    out = [];
    await run('list', '--changed-since', '2026-01-01T00:00:00.000Z', '--json');
    expect(JSON.parse(allOut()).map((t: { id: string }) => t.id)).toEqual(['t2', 't3']);
  });

  it('decisions --resolved lists answered decisions, filterable by --since', async () => {
    await run('init');
    await run('add', 'work'); // t1
    await run('add', 'the q', '--type', 'decision', '--blocks', 't1'); // t2
    await run('resolve', 't2', '--response', 'Go with plan A.');
    out = [];
    await run('decisions', '--resolved');
    expect(allOut()).toContain('the q');
    expect(allOut()).toContain('t1'); // what it unblocked
    out = [];
    await run('decisions', '--resolved', '--since', '2100-01-01T00:00:00.000Z', '--json');
    expect(JSON.parse(allOut())).toEqual([]);
  });
});

describe('ownership', () => {
  it('start refuses a held task without --take and shows the holder in show', async () => {
    await run('init');
    await run('add', 'contested');
    await run('--session', 'sess-a', 'start', 't1');
    expect(await run('--session', 'sess-b', 'start', 't1')).toBe(1);
    expect(err.join('\n')).toContain('sess-a');
    expect(await run('--session', 'sess-b', 'start', 't1', '--take')).toBe(0);
    out = [];
    await run('show', 't1');
    expect(allOut()).toContain('started by: sess-b');
  });
});

describe('history in show', () => {
  it('prints the change log', async () => {
    await run('init');
    await run('--session', 'sess-a', 'add', 'traced');
    await run('--session', 'sess-a', 'start', 't1');
    await run('--session', 'sess-a', 'bump', 't1', 'top');
    out = [];
    await run('show', 't1');
    const text = allOut();
    expect(text).toContain('history:');
    expect(text).toMatch(/in-progress.*sess-a/);
    expect(text).toMatch(/position 1/);
  });
});

describe('catchup command', () => {
  it('returns the delta for a consumer and advances its cursor', async () => {
    await seedTrio();
    await new Promise((r) => setTimeout(r, 5)); // separate timestamps: delivery is at-least-once
    out = [];
    await run('catchup', '--as', 'agent-x', '--json');
    const first = JSON.parse(allOut());
    expect(first.changed).toHaveLength(3);
    await new Promise((r) => setTimeout(r, 5));
    out = [];
    await run('catchup', '--as', 'agent-x', '--json');
    expect(JSON.parse(allOut()).changed).toHaveLength(0);
  });

  it('requires a consumer id from --as or the session', async () => {
    await run('init');
    expect(await run('catchup')).toBe(1);
    expect(err.join('\n')).toMatch(/--as|PLANNY_SESSION/);
  });
});

describe('error clarity and help', () => {
  it('a mistyped command gets a did-you-mean suggestion', async () => {
    await run('init');
    expect(await run('lst')).toBe(1);
    expect(err.join('\n')).toMatch(/did you mean.*list/i);
  });

  it('top-level help ends with a worked example block', async () => {
    await run('--help');
    const text = allOut() + err.join('\n');
    expect(text).toMatch(/Examples:/);
    expect(text).toContain('planny init');
  });

  it('command help carries examples where usage is not obvious', async () => {
    for (const command of ['add', 'update', 'bump', 'resolve', 'catchup']) {
      out = [];
      err = [];
      await run(command, '--help');
      expect(allOut() + err.join('\n'), `${command} --help`).toMatch(/Examples:/);
    }
  });
});

describe('decide loop', () => {
  function runWithPrompt(answers: string[], ...args: string[]): Promise<number> {
    const queue = [...answers];
    return runCli(args, {
      cwd: dir,
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      prompt: async () => queue.shift() ?? 'q',
    });
  }

  beforeEach(async () => {
    await run('init');
    await run('add', 'First question', '--type', 'decision', '-d', '## Proposal\n\nDo it.');
    await run('add', 'Second question', '--type', 'decision', '-d', '## Proposal\n\nAlso.');
    out = [];
  });

  it('accept resolves with the proposal, attributed to the operator', async () => {
    expect(await runWithPrompt(['a', 'q'], 'decide')).toBe(0);
    const t1 = JSON.parse(await (async () => { out = []; await run('show', 't1', '--json'); return allOut(); })());
    expect(t1.task.status).toBe('done');
    expect(t1.task.body).toContain('Accepted the proposal.');
    expect(t1.task.history.at(-1).by).toBe('operator');
    out = [];
    await run('show', 't2', '--json');
    expect(JSON.parse(allOut()).task.status).toBe('todo'); // quit before it
  });

  it('respond records the typed answer', async () => {
    await runWithPrompt(['r', 'Use blue.', 'q'], 'decide');
    out = [];
    await run('show', 't1');
    expect(allOut()).toContain('Use blue.');
  });

  it('skip leaves decisions open and reports the remainder', async () => {
    await runWithPrompt(['s', 's'], 'decide');
    expect(allOut()).toMatch(/2 open decisions remaining/);
    out = [];
    await run('decisions');
    expect(allOut()).toContain('First question');
    expect(allOut()).toContain('Second question');
  });
});

describe('path and export filters', () => {
  it('path prints the task file and fails on an unknown id', async () => {
    await seedTrio();
    out = [];
    await run('path', 't1');
    expect(allOut().endsWith('t1.md')).toBe(true);
    expect(await run('path', 't9')).toBe(1);
  });

  it('export --status keeps only matching tasks', async () => {
    await seedTrio();
    await run('done', 't1');
    out = [];
    await run('export', '--status', 'done');
    expect(allOut()).toContain('first task');
    expect(allOut()).not.toContain('second task');
  });
});

describe('serve on a taken port', () => {
  it('recognizes its own store already serving and exits cleanly', async () => {
    await run('init');
    const { openStore } = await import('../src/store.js');
    const { startServer } = await import('../src/server.js');
    const running = await startServer(openStore(dir), 0);
    try {
      expect(await run('serve', '--port', String(running.port))).toBe(0);
      expect(allOut()).toMatch(/already serving/i);
      expect(allOut()).toContain(String(running.port));
    } finally {
      await running.close();
    }
  });

  it('explains a port held by a different store', async () => {
    await run('init');
    const otherDir = mkdtempSync(join(tmpdir(), 'planny-other-'));
    const { initRepo, openStore } = await import('../src/store.js');
    const { startServer } = await import('../src/server.js');
    initRepo(otherDir);
    const running = await startServer(openStore(otherDir), 0);
    try {
      expect(await run('serve', '--port', String(running.port))).toBe(1);
      expect(err.join('\n')).toMatch(/different store|--port/i);
    } finally {
      await running.close();
      rmSync(otherDir, { recursive: true, force: true });
    }
  });
});

describe('store header', () => {
  it('view commands name the store they read, first line', async () => {
    await seedTrio();
    for (const args of [['tree'], ['deps'], ['list'], ['next'], ['decisions'], ['progress']]) {
      out = [];
      await run(...args);
      expect(out.join('\n').split('\n')[0]).toBe(`store: ${dir}`);
    }
  });

  it('json output stays clean for machines', async () => {
    await seedTrio();
    out = [];
    await run('list', '--json');
    expect(allOut().startsWith('store:')).toBe(false);
    expect(() => JSON.parse(allOut())).not.toThrow();
  });
});

describe('progress and export', () => {
  it('progress prints a percentage', async () => {
    await seedTrio();
    await run('done', 't1');
    out = [];
    await run('progress');
    expect(allOut()).toContain('33%');
  });

  it('export writes a markdown file', async () => {
    await seedTrio();
    const file = join(dir, 'plan.md');
    await run('export', '--out', file);
    const text = readFileSync(file, 'utf8');
    expect(text).toMatch(/^# Plan/);
    expect(text).toContain('first task');
  });

  it('export without --out prints to stdout', async () => {
    await seedTrio();
    out = [];
    await run('export');
    expect(allOut()).toContain('## Tasks');
  });

  it('tree and deps render to the terminal', async () => {
    await seedTrio();
    await run('update', 't2', '--parent', 't1', '--add-blocked-by', 't3');
    out = [];
    await run('tree');
    expect(allOut()).toContain('second task');
    out = [];
    await run('deps');
    expect(allOut()).toContain('third task');
  });
});
