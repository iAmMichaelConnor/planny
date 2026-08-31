import { readFileSync, writeFileSync } from 'node:fs';
import { Command, CommanderError } from 'commander';
import { buildGraph } from './graph.js';
import {
  addTask,
  bumpTask,
  cancelTask,
  resolveDecision,
  setStatus,
  updateTask,
  type OpResult,
} from './ops.js';
import type { BumpTarget } from './priority.js';
import { listTasks, nextDecisions, nextTasks, progress } from './query.js';
import {
  renderDependencyForest,
  renderExport,
  renderProgressLine,
  renderShow,
  renderTaskList,
  taskLabel,
} from './render.js';
import { findRoot, initRepo, openStore, type Store } from './store.js';
import { isStatus, isTaskType, STATUSES, type Status, type TaskType } from './types.js';

export interface CliIo {
  cwd: string;
  out: (text: string) => void;
  err: (text: string) => void;
}

/** Parse and run one CLI invocation. Returns the exit code. */
export async function runCli(args: string[], io: CliIo): Promise<number> {
  const program = buildProgram(io);
  try {
    await program.parseAsync(args, { from: 'user' });
    return 0;
  } catch (error) {
    if (error instanceof CommanderError) return error.exitCode === 0 ? 0 : 1;
    io.err(`error: ${(error as Error).message}`);
    return 1;
  }
}

function normalizeId(value: string): string {
  return /^\d+$/.test(value) ? `t${value}` : value;
}

function collectIds(value: string, previous: string[] = []): string[] {
  return [
    ...previous,
    ...value
      .split(',')
      .map((part) => normalizeId(part.trim()))
      .filter((part) => part !== ''),
  ];
}

function parsePriority(value: string): BumpTarget {
  if (value === 'top' || value === 'bottom') return value;
  const position = Number(value);
  if (!Number.isInteger(position)) {
    throw new Error(`priority must be "top", "bottom" or a 1-based position, not "${value}"`);
  }
  return position;
}

function parseStatuses(value: string): Status[] {
  return value.split(',').map((part) => {
    const status = part.trim();
    if (!isStatus(status)) {
      throw new Error(`unknown status "${status}" — expected one of: ${STATUSES.join(', ')}`);
    }
    return status;
  });
}

function parseType(value: string): TaskType {
  if (!isTaskType(value)) throw new Error(`unknown type "${value}" — expected task or decision`);
  return value;
}

interface DescOptions {
  desc?: string;
  descFile?: string;
}

function readBody(options: DescOptions): string | undefined {
  if (options.descFile !== undefined) {
    return options.descFile === '-'
      ? readFileSync(0, 'utf8')
      : readFileSync(options.descFile, 'utf8');
  }
  return options.desc;
}

function buildProgram(io: CliIo): Command {
  const program = new Command();
  program
    .name('planny')
    .description('file-backed task and decision tracker for AI-driven projects')
    .configureOutput({
      writeOut: (text) => io.out(text.replace(/\n$/, '')),
      writeErr: (text) => io.err(text.replace(/\n$/, '')),
    })
    .exitOverride();

  const open = (): Store => openStore(io.cwd);
  const report = (result: OpResult, line: string): void => {
    io.out(line);
    for (const warning of result.warnings) io.err(`warning: ${warning}`);
  };

  program
    .command('init')
    .description('create a .planny store in the current directory')
    .action(() => {
      const existing = findRoot(io.cwd);
      initRepo(io.cwd);
      io.out(
        existing === io.cwd
          ? `already initialized: ${io.cwd}/.planny`
          : `initialized ${io.cwd}/.planny`,
      );
    });

  program
    .command('add')
    .description('add a task (or decision) to the plan')
    .argument('<name>', 'short imperative task name')
    .option('-d, --desc <text>', 'description (markdown)')
    .option('--desc-file <path>', 'read the description from a file (- for stdin)')
    .option('--type <type>', 'task | decision', parseType, 'task')
    .option('--kind <kind>', 'owner: ai | operator (or a custom kind)', 'ai')
    .option('--model <model>', 'preferred model for an ai task')
    .option('--parent <id>', 'parent task', normalizeId)
    .option('--child <ids>', 'existing tasks to re-parent under the new task (comma-separated, repeatable)', collectIds)
    .option('--blocked-by <ids>', 'tasks that must finish first (comma-separated, repeatable)', collectIds)
    .option('--blocks <ids>', 'tasks that must wait for this one (comma-separated, repeatable)', collectIds)
    .option('--priority <pos>', 'top | bottom | 1-based position (default bottom)', parsePriority)
    .action((name, options) => {
      const result = addTask(open(), {
        name,
        body: readBody(options),
        type: options.type,
        kind: options.kind,
        model: options.model,
        parent: options.parent,
        children: options.child,
        blockedBy: options.blockedBy,
        blocks: options.blocks,
        priority: options.priority,
      });
      report(result, `added ${result.task.id} — ${result.task.name}`);
    });

  program
    .command('update')
    .description('change fields or relationships of a task')
    .argument('<id>', 'task id', normalizeId)
    .option('--name <text>', 'rename the task')
    .option('-d, --desc <text>', 'replace the description')
    .option('--desc-file <path>', 'replace the description from a file (- for stdin)')
    .option('--append-desc <text>', 'append a paragraph to the description')
    .option('--kind <kind>', 'owner: ai | operator (or a custom kind)')
    .option('--type <type>', 'task | decision', parseType)
    .option('--model <model>', 'preferred model')
    .option('--clear-model', 'remove the model preference')
    .option('--parent <id>', 'set the parent task', normalizeId)
    .option('--clear-parent', 'make the task a root')
    .option('--add-child <ids>', 'adopt tasks as children (comma-separated, repeatable)', collectIds)
    .option('--remove-child <ids>', 'release children (comma-separated, repeatable)', collectIds)
    .option('--add-blocked-by <ids>', 'add blockers (comma-separated, repeatable)', collectIds)
    .option('--remove-blocked-by <ids>', 'remove blockers (comma-separated, repeatable)', collectIds)
    .option('--add-blocks <ids>', 'add tasks that wait on this one (comma-separated, repeatable)', collectIds)
    .option('--remove-blocks <ids>', 'remove tasks that wait on this one (comma-separated, repeatable)', collectIds)
    .option('--priority <pos>', 'top | bottom | 1-based position', parsePriority)
    .action((id, options) => {
      const result = updateTask(open(), id, {
        name: options.name,
        body: readBody(options),
        appendBody: options.appendDesc,
        kind: options.kind,
        type: options.type,
        model: options.clearModel ? null : options.model,
        parent: options.clearParent ? null : options.parent,
        addChildren: options.addChild,
        removeChildren: options.removeChild,
        addBlockedBy: options.addBlockedBy,
        removeBlockedBy: options.removeBlockedBy,
        addBlocks: options.addBlocks,
        removeBlocks: options.removeBlocks,
        priority: options.priority,
      });
      report(result, `updated ${id}`);
    });

  for (const [command, status, description] of [
    ['start', 'in-progress', 'mark a task in progress'],
    ['done', 'done', 'mark a task done'],
    ['todo', 'todo', 'mark a task todo (reopen)'],
  ] as const) {
    program
      .command(command)
      .description(description)
      .argument('<id>', 'task id', normalizeId)
      .action((id) => {
        const result = setStatus(open(), id, status);
        report(result, `${id} → ${status}`);
      });
  }

  program
    .command('cancel')
    .description('cancel a task, optionally naming its replacements')
    .argument('<id>', 'task id', normalizeId)
    .option('--replaced-by <ids>', 'tasks that replace it (comma-separated, repeatable)', collectIds)
    .action((id, options) => {
      const result = cancelTask(open(), id, options.replacedBy ?? []);
      const suffix =
        result.task.replacedBy.length > 0
          ? ` (replaced by ${result.task.replacedBy.join(', ')})`
          : '';
      report(result, `cancelled ${id}${suffix}`);
    });

  program
    .command('bump')
    .description('move a task in the priority order (clamped by dependencies)')
    .argument('<id>', 'task id', normalizeId)
    .argument('<target>', 'top | bottom | 1-based position', parsePriority)
    .action((id, target) => {
      const store = open();
      const result = bumpTask(store, id, target);
      const active = listTasks(store, { status: ['todo', 'in-progress'] });
      const position = active.findIndex((t) => t.id === id) + 1;
      const where = position > 0 ? `position ${position} of ${active.length} active` : 'the inactive set';
      report(result, `moved ${id} to ${where}`);
    });

  program
    .command('show')
    .description('show one task in full, with derived relationships')
    .argument('<id>', 'task id', normalizeId)
    .option('--json', 'machine-readable output')
    .action((id, options) => {
      const store = open();
      const task = store.load(id);
      const tasks = store.loadAll();
      if (options.json) {
        const graph = buildGraph(tasks);
        io.out(
          JSON.stringify(
            {
              task,
              path: store.path(id),
              ancestors: graph.ancestors(id).map((t) => t.id),
              children: graph.children(id).map((t) => t.id),
              blockedBy: task.blockedBy,
              blocking: graph.blocking(id).map((t) => t.id),
              blocked: graph.isBlocked(id),
            },
            null,
            2,
          ),
        );
        return;
      }
      io.out(renderShow(task, tasks, store.path(id)));
    });

  program
    .command('path')
    .description('print the file path of a task')
    .argument('<id>', 'task id', normalizeId)
    .action((id) => {
      const store = open();
      store.load(id);
      io.out(store.path(id));
    });

  program
    .command('list')
    .description('list tasks flat, in priority order')
    .option('--status <statuses>', 'filter: comma-separated statuses', parseStatuses)
    .option('--kind <kind>', 'filter by owner kind')
    .option('--type <type>', 'filter: task | decision', parseType)
    .option('--model <model>', 'filter by preferred model')
    .option('--parent <id>', 'only children of this task', normalizeId)
    .option('--recursive', 'with --parent: all descendants')
    .option('--blocked', 'only blocked tasks')
    .option('--unblocked', 'only unblocked tasks')
    .option('--json', 'machine-readable output')
    .action((options) => {
      const store = open();
      const tasks = listTasks(store, {
        status: options.status,
        kind: options.kind,
        type: options.type,
        model: options.model,
        parent: options.parent,
        recursive: options.recursive,
        blocked: options.blocked ? true : options.unblocked ? false : undefined,
      });
      if (options.json) {
        const graph = buildGraph(store.loadAll());
        io.out(
          JSON.stringify(tasks.map((task) => ({ ...task, blocked: graph.isBlocked(task.id) })), null, 2),
        );
        return;
      }
      if (tasks.length === 0) {
        io.out('No matching tasks.');
        return;
      }
      const graph = buildGraph(store.loadAll());
      io.out(tasks.map((task) => taskLabel(task, graph)).join('\n'));
    });

  program
    .command('tree')
    .description('show the parent/child hierarchy')
    .option('--status <statuses>', 'filter: comma-separated statuses', parseStatuses)
    .option('--kind <kind>', 'filter by owner kind')
    .option('--type <type>', 'filter: task | decision', parseType)
    .action((options) => {
      io.out(
        renderTaskList(open().loadAll(), {
          status: options.status,
          kind: options.kind,
          type: options.type,
        }),
      );
    });

  program
    .command('deps')
    .description('show the dependency order (blockers above the tasks they block)')
    .action(() => {
      io.out(renderDependencyForest(open().loadAll()));
    });

  program
    .command('next')
    .description('what to work on now: unblocked leaf tasks in priority order')
    .argument('[n]', 'how many tasks', (v: string) => Number(v), 5)
    .option('--kind <kind>', 'filter by owner kind')
    .option('--under <id>', 'restrict to the subtree under this task', normalizeId)
    .option('--json', 'machine-readable output')
    .action((n, options) => {
      const items = nextTasks(open(), n, { kind: options.kind, under: options.under });
      if (options.json) {
        io.out(
          JSON.stringify(
            items.map((item) => ({
              task: item.task,
              ancestors: item.path.map((t) => t.id),
              unlocks: item.unlocks.map((t) => t.id),
            })),
            null,
            2,
          ),
        );
        return;
      }
      if (items.length === 0) {
        io.out('Nothing is ready to work on.');
        return;
      }
      const lines = items.map((item) => {
        const extra: string[] = [];
        if (item.path.length > 0) {
          extra.push(`    under: ${[...item.path].reverse().map((t) => `${t.id} ${t.name}`).join(' > ')}`);
        }
        if (item.unlocks.length > 0) {
          extra.push(`    unlocks: ${item.unlocks.map((t) => t.id).join(', ')}`);
        }
        const kind = item.task.kind === 'ai' ? '' : ` (${item.task.kind})`;
        const head = `${item.task.status === 'in-progress' ? '[~]' : '[ ]'} ${item.task.id} ${item.task.name}${kind}`;
        return [head, ...extra].join('\n');
      });
      io.out(lines.join('\n'));
    });

  program
    .command('progress')
    .description('completion percentage over non-cancelled tasks')
    .option('--parent <id>', 'scope to the subtree under this task', normalizeId)
    .option('--json', 'machine-readable output')
    .action((options) => {
      const result = progress(open(), options.parent);
      io.out(options.json ? JSON.stringify(result, null, 2) : renderProgressLine(result));
    });

  program
    .command('export')
    .description('render the plan as a markdown document')
    .option('--out <file>', 'write to a file instead of stdout')
    .option('--status <statuses>', 'filter tasks: comma-separated statuses', parseStatuses)
    .option('--kind <kind>', 'filter by owner kind')
    .option('--type <type>', 'filter: task | decision', parseType)
    .action((options) => {
      const text = renderExport(open().loadAll(), {
        status: options.status,
        kind: options.kind,
        type: options.type,
      });
      if (options.out !== undefined) {
        writeFileSync(options.out, text);
        io.out(`wrote ${options.out}`);
      } else {
        io.out(text.trimEnd());
      }
    });

  program
    .command('decisions')
    .description('list open decisions in the order to answer them')
    .option('--json', 'machine-readable output')
    .action((options) => {
      const store = open();
      const items = nextDecisions(store);
      if (options.json) {
        io.out(JSON.stringify(items.map(({ task, blocked }) => ({ task, blocked })), null, 2));
        return;
      }
      if (items.length === 0) {
        io.out('No open decisions.');
        return;
      }
      const graph = buildGraph(store.loadAll());
      io.out(items.map((item, i) => `${i + 1}. ${taskLabel(item.task, graph)}`).join('\n'));
    });

  program
    .command('resolve')
    .description('record the operator answer on a decision and mark it done')
    .argument('<id>', 'decision task id', normalizeId)
    .option('--response <text>', 'the decision, free-form')
    .option('--response-file <path>', 'read the decision from a file (- for stdin)')
    .option('--accept', 'shorthand for accepting the written proposal')
    .action((id, options) => {
      const response: string | undefined = options.accept
        ? 'Accepted the proposal.'
        : options.responseFile !== undefined
          ? options.responseFile === '-'
            ? readFileSync(0, 'utf8')
            : readFileSync(options.responseFile, 'utf8')
          : options.response;
      if (response === undefined || response.trim() === '') {
        throw new Error('give the decision with --response, --response-file or --accept');
      }
      const result = resolveDecision(open(), id, response);
      report(result, `resolved ${id}`);
    });

  program
    .command('decide')
    .description('work through open decisions interactively, one by one')
    .action(async () => {
      const store = open();
      const ready = nextDecisions(store).filter((item) => !item.blocked);
      if (ready.length === 0) {
        io.out('No open decisions are ready.');
        return;
      }
      const { createInterface } = await import('node:readline/promises');
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        for (const item of ready) {
          io.out('');
          io.out(renderShow(item.task, store.loadAll(), store.path(item.task.id)));
          const choice = (
            await rl.question('\n[a]ccept proposal / [r]espond / [s]kip / [q]uit: ')
          )
            .trim()
            .toLowerCase();
          if (choice === 'q') break;
          if (choice === 'a') {
            report(resolveDecision(store, item.task.id, 'Accepted the proposal.'), `resolved ${item.task.id}`);
          } else if (choice === 'r') {
            const answer = (await rl.question('Your decision: ')).trim();
            if (answer !== '') {
              report(resolveDecision(store, item.task.id, answer), `resolved ${item.task.id}`);
            } else {
              io.out('Empty answer; skipped.');
            }
          }
        }
      } finally {
        rl.close();
      }
      const remaining = nextDecisions(store);
      io.out(`\n${remaining.length} open decision${remaining.length === 1 ? '' : 's'} remaining.`);
    });

  program
    .command('doctor')
    .description('check the store for hand-edit damage; --fix repairs the safe problems')
    .option('--fix', 'apply the safe repairs')
    .option('--json', 'machine-readable output')
    .action(async (options) => {
      const store = open();
      const { diagnose, fixStore } = await import('./doctor.js');
      const describe = (f: import('./doctor.js').Finding): string =>
        `${f.severity === 'error' ? 'error  ' : 'warning'} ${f.code}: ${f.message} (${f.file})${f.fixable ? ' [fixable]' : ''}`;
      const failOnErrors = (findings: import('./doctor.js').Finding[], fixRan: boolean): void => {
        const errors = findings.filter((f) => f.severity === 'error');
        if (errors.length === 0) return;
        const hint = !fixRan && errors.some((f) => f.fixable)
          ? ' — `planny doctor --fix` repairs the [fixable] ones'
          : ' — fix by hand, then re-run planny doctor';
        throw new Error(`${errors.length} error${errors.length === 1 ? '' : 's'} in the store${hint}`);
      };

      if (options.fix) {
        const { applied, remaining } = fixStore(store);
        if (options.json) {
          io.out(JSON.stringify({ applied, remaining }, null, 2));
        } else {
          for (const f of applied) io.out(`fixed   ${f.code}: ${f.message}`);
          for (const f of remaining) io.out(describe(f));
          if (applied.length === 0 && remaining.length === 0) io.out('Store is healthy.');
        }
        failOnErrors(remaining, true);
        return;
      }
      const findings = diagnose(store);
      if (options.json) {
        io.out(JSON.stringify(findings, null, 2));
      } else if (findings.length === 0) {
        io.out('Store is healthy.');
      } else {
        for (const f of findings) io.out(describe(f));
      }
      failOnErrors(findings, false);
    });

  program
    .command('serve')
    .description('start the localhost control site')
    .option('--port <port>', 'port to listen on', (v: string) => Number(v), 5891)
    .action(async (options) => {
      const store = open();
      const { startServer } = await import('./server.js');
      const running = await startServer(store, options.port);
      io.out(`planny ui: http://127.0.0.1:${running.port} (ctrl-c to stop)`);
      // Keep the process alive until interrupted.
      await new Promise<void>((resolve) => {
        process.once('SIGINT', resolve);
        process.once('SIGTERM', resolve);
      });
      await running.close();
    });

  return program;
}
