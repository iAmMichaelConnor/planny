import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

  it('add --start creates, starts and claims in one command', async () => {
    await run('init');
    await run('--session', 'sess-a', 'add', 'grab it', '--start');
    out = [];
    await run('show', 't1', '--json');
    const { task } = JSON.parse(allOut());
    expect(task.status).toBe('in-progress');
    expect(task.createdBy).toBe('sess-a');
    expect(task.history.at(-1)).toMatchObject({ status: 'in-progress', by: 'sess-a' });
  });

  it('add --json returns the task machine-readably, with --start reflected', async () => {
    await run('init');
    out = [];
    await run('--session', 'sess-a', 'add', 'json task', '--start', '--json');
    const { task, warnings } = JSON.parse(allOut());
    expect(task.id).toBe('t1');
    expect(task.status).toBe('in-progress');
    expect(Array.isArray(warnings)).toBe(true);
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

  it('list --count prints a bare number honoring the filters', async () => {
    await seedTrio();
    await run('done', 't1');
    out = [];
    await run('list', '--status', 'todo', '--count');
    expect(out).toEqual(['2']);
    out = [];
    await run('list', '--count');
    expect(out).toEqual(['3']);
  });

  it('list --json --compact returns lean rows with no bodies', async () => {
    await seedTrio();
    await run('update', 't1', '--desc', 'a long body that must not ship');
    out = [];
    await run('list', '--json', '--compact');
    const rows = JSON.parse(allOut());
    expect(rows[0]).toEqual({
      id: 't1',
      name: 'first task',
      status: 'todo',
      type: 'task',
      kind: 'ai',
      updated: expect.any(String),
    });
    expect(JSON.stringify(rows)).not.toContain('long body');
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
    expect(allOut()).toContain('t1'); // what it was gating
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

  it('json always carries since, null on a first call', async () => {
    await run('init');
    out = [];
    await run('catchup', '--as', 'fresh-agent', '--json');
    const result = JSON.parse(allOut());
    expect('since' in result).toBe(true);
    expect(result.since).toBeNull();
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

describe('url', () => {
  it('prints the address serving this store', async () => {
    await run('init');
    const { openStore } = await import('../src/store.js');
    const { startServer } = await import('../src/server.js');
    const srv = await startServer(openStore(dir), 0);
    try {
      out = [];
      expect(await run('url')).toBe(0);
      expect(allOut()).toBe(`http://127.0.0.1:${srv.port}`);
    } finally {
      await srv.close();
    }
  });

  it('fails with guidance when nothing serves the store', async () => {
    await run('init');
    expect(await run('url')).toBe(1);
    expect(err.join('\n')).toMatch(/planny serve/);
  });
});

describe('init inside an existing store', () => {
  const runIn = (cwd: string, ...args: string[]): Promise<number> =>
    runCli(args, { cwd, out: (l) => out.push(l), err: (l) => err.push(l) });

  it('refuses to nest, names the owning store, and creates nothing', async () => {
    await run('init');
    const sub = join(dir, 'packages', 'web');
    mkdirSync(sub, { recursive: true });
    expect(await runIn(sub, 'init')).toBe(1);
    expect(err.join('\n')).toContain(dir); // says which store already owns this tree
    expect(err.join('\n')).toMatch(/--nested/); // and how to override deliberately
    expect(existsSync(join(sub, '.planny'))).toBe(false);
  });

  it('--nested creates the inner store anyway', async () => {
    await run('init');
    const sub = join(dir, 'packages', 'web');
    mkdirSync(sub, { recursive: true });
    expect(await runIn(sub, 'init', '--nested')).toBe(0);
    expect(existsSync(join(sub, '.planny', 'tasks'))).toBe(true);
  });

  it('re-init at the root stays a friendly no-op', async () => {
    await run('init');
    out = [];
    expect(await run('init')).toBe(0);
    expect(allOut()).toMatch(/already initialized/);
  });
});

describe('the project guard', () => {
  afterEach(() => {
    delete process.env.PLANNY_PROJECT;
  });
  const base = () => dir.slice(dir.lastIndexOf('/') + 1);

  it('a matching bare name passes; a wrong one refuses with both sides named', async () => {
    await run('init');
    process.env.PLANNY_PROJECT = base();
    expect(await run('add', 'guarded add')).toBe(0);
    process.env.PLANNY_PROJECT = 'some-other-project';
    expect(await run('add', 'stray add')).toBe(1);
    const message = err.join('\n');
    expect(message).toContain(dir); // the store it actually found
    expect(message).toContain('some-other-project'); // the assertion that failed
    out = [];
    await run('list', '--count');
    expect(out).toEqual([]); // the read is guarded too
  });

  it('a path form compares the resolved root', async () => {
    await run('init');
    process.env.PLANNY_PROJECT = dir;
    expect(await run('add', 'by path')).toBe(0);
    process.env.PLANNY_PROJECT = `${dir}-elsewhere`;
    expect(await run('add', 'stray')).toBe(1);
  });

  it('--project asserts without the environment', async () => {
    await run('init');
    expect(await run('--project', base(), 'add', 'flagged add')).toBe(0);
    expect(await run('--project', 'wrong-name', 'add', 'stray')).toBe(1);
  });

  it('init stays exempt — it creates stores', async () => {
    process.env.PLANNY_PROJECT = 'anything-at-all';
    expect(await run('init')).toBe(0);
  });
});

describe('resolution outcome tasks', () => {
  beforeEach(async () => {
    await run('init');
    await run('add', 'gated work');
    await run('add', 'Choose db', '--type', 'decision', '--desc', 'Use files?', '--blocks', 't1');
    out = [];
  });

  it('resolve names the outcome task it created, and the child link holds', async () => {
    expect(await run('resolve', 't2', '--response', 'yes, files')).toBe(0);
    expect(allOut()).toContain('resolved t2 → outcome task t3');
    out = [];
    await run('show', 't3', '--json');
    const { task } = JSON.parse(allOut());
    expect(task.parent).toBe('t2');
    expect(task.body).toContain('records the outcome of decision t2');
    expect(task.body).toContain('t1'); // names the rewired dependant
  });

  it('gated work stays gated until the outcome task is done', async () => {
    await run('resolve', 't2', '--response', 'yes, files');
    out = [];
    await run('next', '--json');
    let ready = JSON.parse(allOut()).map((n: { task: { id: string } }) => n.task.id);
    expect(ready).toContain('t3'); // the outcome task is the actionable step
    expect(ready).not.toContain('t1'); // the gated work waits for interpretation
    await run('done', 't3');
    out = [];
    await run('next', '--json');
    ready = JSON.parse(allOut()).map((n: { task: { id: string } }) => n.task.id);
    expect(ready).toContain('t1'); // finishing the interpretation releases it
  });

  it('--reject closes the decision and creates nothing', async () => {
    expect(await run('resolve', 't2', '--reject', '--response', 'not needed')).toBe(0);
    expect(allOut()).toMatch(/rejected — no outcome task/);
    out = [];
    await run('list', '--count');
    expect(out).toEqual(['2']); // still just the two seeded tasks
    out = [];
    await run('show', 't2');
    expect(allOut()).toContain('Rejected — closed without action. Reason: not needed');
  });

  it('--reject needs no response text', async () => {
    expect(await run('resolve', 't2', '--reject')).toBe(0);
  });

  it('a catching-up agent is handed the outcome task id', async () => {
    await run('resolve', 't2', '--response', 'yes, files');
    out = [];
    await run('catchup', '--as', 'later-agent');
    expect(allOut()).toContain('resolved: t2 Choose db');
    // Labeled continuation lines: the free-text name never abuts tokens.
    expect(allOut()).toContain('\n    outcome task: t3');
    expect(allOut()).toContain('\n    was gating: t1');
    out = [];
    await run('decisions', '--resolved', '--json');
    const rows = JSON.parse(allOut());
    expect(rows[0].outcomeTask).toBe('t3');
  });

  it('a rejected decision reports no outcome task', async () => {
    await run('resolve', 't2', '--reject');
    out = [];
    await run('decisions', '--resolved', '--json');
    expect(JSON.parse(allOut())[0].outcomeTask).toBeNull();
  });

  it('--json hands the resolving agent both tasks, structurally', async () => {
    expect(await run('resolve', 't2', '--response', 'yes, files', '--json')).toBe(0);
    const data = JSON.parse(allOut());
    expect(data.task.id).toBe('t2');
    expect(data.task.status).toBe('done');
    expect(data.outcomeTask.id).toBe('t3');
    expect(data.outcomeTask.parent).toBe('t2');
    expect(data.outcomeTask.body).toContain('records the outcome of decision t2');
    expect(Array.isArray(data.warnings)).toBe(true);
  });

  it('--json on a reject reports a null outcome task', async () => {
    expect(await run('resolve', 't2', '--reject', '--json')).toBe(0);
    const data = JSON.parse(allOut());
    expect(data.task.status).toBe('done');
    expect(data.outcomeTask).toBeNull();
  });

  it('--accept with --reject is refused', async () => {
    expect(await run('resolve', 't2', '--accept', '--reject')).toBe(1);
    expect(err.join('\n')).toMatch(/not both/);
  });
});

describe('catchup output shape', () => {
  // The delta is consumed once; if a reader truncates it anyway, the
  // resolutions — the part that changes what an agent does next — must
  // be the last thing a truncation loses.
  beforeEach(async () => {
    await seedTrio();
    await run('add', 'Pick a colour', '--type', 'decision');
    await run('done', 't1');
    await run('resolve', 't4', '--response', 'blue');
    out = [];
  });

  it('--json puts resolved before changed', async () => {
    expect(await run('catchup', '--as', 'reader', '--json')).toBe(0);
    const text = allOut();
    expect(text.indexOf('"resolved"')).toBeGreaterThan(-1);
    expect(text.indexOf('"resolved"')).toBeLessThan(text.indexOf('"changed"'));
  });

  it('text output prints resolutions before the changed list', async () => {
    expect(await run('catchup', '--as', 'reader2')).toBe(0);
    const text = allOut();
    expect(text.indexOf('resolved: t4')).toBeGreaterThan(-1);
    expect(text.indexOf('resolved: t4')).toBeLessThan(text.indexOf('first task'));
  });

  it('--compact keeps ids, names, statuses and stamps; drops bodies and history', async () => {
    expect(await run('catchup', '--as', 'reader3', '--compact', '--json')).toBe(0);
    const data = JSON.parse(allOut());
    expect(data.resolved[0]).toEqual({
      id: 't4',
      name: 'Pick a colour',
      resolvedAt: expect.any(String),
      dependants: [],
      outcomeTask: 't5', // the answer's carrier, handed over — never inferred
    });
    const first = data.changed.find((t: { id: string }) => t.id === 't1');
    expect(first).toEqual({
      id: 't1',
      name: 'first task',
      status: 'done',
      type: 'task',
      kind: 'ai',
      updated: expect.any(String),
    });
    expect(JSON.stringify(data)).not.toContain('"body"');
    expect(JSON.stringify(data)).not.toContain('"history"');
  });
});

describe('mutations name the store they acted on', () => {
  // A command run in the wrong directory writes to the wrong plan; the
  // confirmation line must make that visible at zero interaction cost.
  it('every mutation confirmation carries the store path', async () => {
    await seedTrio();
    const stamped = (): void => {
      expect(allOut()).toContain(`[store: ${join(dir, '.planny')}]`);
      out = [];
    };
    await run('add', 'a new one');
    stamped();
    await run('update', 't1', '--desc', 'x');
    stamped();
    await run('start', 't1');
    stamped();
    await run('done', 't1');
    stamped();
    await run('todo', 't1');
    stamped();
    await run('bump', 't2', 'top');
    stamped();
    await run('cancel', 't3');
    stamped();
    await run('add', 'a question', '--type', 'decision');
    stamped();
    await run('resolve', 't5', '--response', 'yes');
    stamped();
  });

  it('json output stays pure json', async () => {
    await seedTrio();
    await run('add', 'json one', '--json');
    expect(() => JSON.parse(allOut())).not.toThrow();
  });
});
