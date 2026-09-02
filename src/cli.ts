import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, hostname, networkInterfaces } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { Command, CommanderError } from 'commander';
import { catchup, compactCatchup, compactTask } from './catchup.js';
import { buildGraph } from './graph.js';
import {
  addTask,
  bumpTask,
  cancelTask,
  resolveDecision,
  setStatus,
  updateTask,
  type OpResult,
  type ResolveResult,
} from './ops.js';
import { activePosition, type BumpTarget } from './priority.js';
import { listTasks, nextDecisions, nextTasks, progress, resolvedDecisions } from './query.js';
import {
  renderDependencyForest,
  renderExport,
  renderProgressLine,
  renderShow,
  renderTaskList,
  taskLabel,
} from './render.js';
import { findRoot, initRepo, linkedWorktreeMainPlan, openStore, type Store } from './store.js';
import {
  holderOf,
  isStatus,
  isTaskType,
  STATUSES,
  type Status,
  type Task,
  type TaskType,
} from './types.js';

/** Collect a repeatable --root into a list. */
function collectRoots(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export interface CliIo {
  cwd: string;
  out: (text: string) => void;
  err: (text: string) => void;
  /** Interactive input for `decide`; defaults to readline on stdin. */
  prompt?: (question: string) => Promise<string>;
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
    .option(
      '--session <id>',
      'attribute creates and status changes to this agent session (falls back to $PLANNY_SESSION)',
    )
    .option(
      '--project <value>',
      'refuse every command when the store is not this project — a directory name or a full root path (falls back to $PLANNY_PROJECT)',
    )
    .configureOutput({
      writeOut: (text) => io.out(text.replace(/\n$/, '')),
      writeErr: (text) => io.err(text.replace(/\n$/, '')),
    })
    .showSuggestionAfterError()
    .exitOverride()
    .addHelpText(
      'after',
      `
Examples:
  planny init                                   create a store in this project
  planny add "Build the importer" -d "Parse the CSV rows."
  planny add "Choose a database" --type decision --kind operator --blocks t1
  planny next --json                            what to work on now
  planny start t1 && planny done t1             claim it, finish it
  planny tree                                   the plan at a glance
  planny serve                                  the localhost board

The plan lives in .planny/ next to your code; every command acts on the
nearest store above the current directory. Agents: see skills/planny/SKILL.md.`,
    );

  const open = (): Store => {
    const store = openStore(io.cwd);
    // The optional wrong-store guard (decided in t169): with an asserted
    // project, a command aimed at any other store refuses instead of
    // silently acting on the wrong plan. One funnel guards every command.
    const expected: unknown = program.opts().project ?? process.env.PLANNY_PROJECT;
    if (typeof expected === 'string' && expected !== '') {
      const matches = expected.includes(sep)
        ? resolve(expected) === store.root
        : expected === basename(store.root);
      if (!matches) {
        throw new Error(
          `this store is ${store.root} but the asserted project is "${expected}" (--project / $PLANNY_PROJECT) — cd to the right project or update the assertion`,
        );
      }
    }
    return store;
  };
  /** First line of human-readable views: which project's plan answered. */
  const nameStore = (store: Store): void => io.out(`store: ${store.root}`);
  const actor = (): string | undefined => program.opts().session ?? process.env.PLANNY_SESSION;
  const parseTime = (value: string): string => {
    if (Number.isNaN(Date.parse(value))) {
      throw new Error(`"${value}" is not a time — use an ISO timestamp like 2026-08-31T12:00:00Z`);
    }
    return value;
  };
  // Every mutation names the store it acted on: the CLI follows the cwd,
  // so a command run in the wrong project must be visible in its output.
  const report = (store: Store, result: OpResult, line: string): void => {
    io.out(`${line} [store: ${join(store.root, '.planny')}]`);
    for (const warning of result.warnings) io.err(`warning: ${warning}`);
  };
  /** A resolved decision as a text block: labeled lines, never tokens
   * jammed against the free-text name. */
  const resolvedBlock = (
    task: Task,
    dependants: Task[],
    outcomeTask: string | null,
    when?: string,
  ): string => {
    const head = when === undefined
      ? `resolved: ${task.id} ${task.name}`
      : `${task.id} ${when} — ${task.name}`;
    const carrier = outcomeTask === null ? '' : `\n    outcome task: ${outcomeTask}`;
    const tail =
      dependants.length > 0 ? `\n    was gating: ${dependants.map((t) => t.id).join(', ')}` : '';
    return `${head}${carrier}${tail}`;
  };
  /** One wording for a resolution everywhere it is reported. */
  const resolvedLine = (id: string, result: ResolveResult): string =>
    result.outcomeTask !== undefined
      ? `resolved ${id} → outcome task ${result.outcomeTask.id}`
      : `resolved ${id} (rejected — no outcome task)`;

  program
    .command('init')
    .description('create a .planny store in the current directory')
    .option('--nested', 'create a store even though an ancestor store exists')
    .action((options) => {
      // In a linked git worktree the plan already lives in the main
      // worktree; a store here would fork it (see findRoot's redirect).
      const mainPlan = linkedWorktreeMainPlan(io.cwd);
      if (mainPlan !== null && !existsSync(join(io.cwd, '.planny', 'fork'))) {
        throw new Error(
          `this is a linked git worktree — planny commands here already use the main worktree's plan at ${mainPlan}/.planny. A store here would fork the plan; for a deliberate fork run \`mkdir -p .planny && touch .planny/fork\`, then init again`,
        );
      }
      const existing = findRoot(io.cwd);
      // A store inside another store shadows it for the whole subtree:
      // every command run there would silently split the plan.
      if (existing !== null && existing !== io.cwd && options.nested !== true) {
        throw new Error(
          `this directory is inside the store at ${existing}/.planny — a nested store would split the plan (commands here would stop seeing the outer one); pass --nested to create it anyway`,
        );
      }
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
    .option('--start', 'claim and start the new task immediately (yours to work)')
    .option('--json', 'machine-readable output: {task, warnings}')
    .addHelpText(
      'after',
      `
Examples:
  planny add "Write the parser" -d "Done when: round-trip tests pass."
  planny add "Ship v1" --child t3,t4            adopt existing tasks as children
  planny add "Deploy" --blocked-by t2 --parent t1
  planny add "Pick a vendor" --type decision --kind operator --blocks t5
  planny add "Long brief" --desc-file brief.md  (- reads stdin)

A body that quotes a command belongs in a file. Your shell runs whatever
sits between backticks, or inside $(...), in a double-quoted -d before
planny sees it: the command really runs and the body loses the text. Write
the body with a quoted heredoc delimiter and pass --desc-file.`,
    )
    .action((name, options) => {
      const store = open();
      const result = addTask(
        store,
        {
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
        },
        actor(),
      );
      let line = `added ${result.task.id} — ${result.task.name}`;
      if (options.start) {
        const started = setStatus(store, result.task.id, 'in-progress', actor());
        result.warnings.push(...started.warnings);
        line += ' · started';
      }
      if (options.json) {
        const task = options.start ? store.load(result.task.id) : result.task;
        io.out(JSON.stringify({ task, warnings: result.warnings }, null, 2));
        return;
      }
      report(store, result, line);
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
    .addHelpText(
      'after',
      `
Examples:
  planny update t3 --name "Sharper name" --append-desc "Also cover the error path."
  planny update t3 --parent t1                  move under t1 (--clear-parent to detach)
  planny update t3 --add-blocked-by t2 --remove-blocks t9
  planny update t3 --desc-file body.md          replace the whole description`,
    )
    .action((id, options) => {
      const store = open();
      const result = updateTask(store, id, {
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
      }, actor());
      report(store, result, `updated ${id}`);
    });

  program
    .command('start')
    .description('mark a task in progress (claims it for your session)')
    .argument('<id>', 'task id', normalizeId)
    .option('--take', 'take over a task another session started')
    .action((id, options) => {
      const store = open();
      const result = setStatus(store, id, 'in-progress', actor(), { take: options.take });
      report(store, result, `${id} → in-progress`);
    });

  program
    .command('park')
    .description('park a task: real work, but not for now')
    .argument('<id>', 'task id', normalizeId)
    .option('--until <note>', 'what should bring this task back')
    .addHelpText(
      'after',
      `
A parked task keeps its priority place and still blocks whatever waits on
it. Only the queues pass it over: \`planny next\` and \`planny decisions\`
skip parked work unless you pass --include-parked. \`planny todo <id>\`
wakes it and clears the note.

Examples:
  planny park t7
  planny park t7 --until 'the payments API ships'`,
    )
    .action((id, options) => {
      const store = open();
      const result = setStatus(store, id, 'parked', actor(), { parkedUntil: options.until });
      report(store, result, `${id} → parked`);
    });

  for (const [command, status, description] of [
    ['done', 'done', 'mark a task done'],
    ['todo', 'todo', 'mark a task todo (reopen or wake)'],
  ] as const) {
    program
      .command(command)
      .description(description)
      .argument('<id>', 'task id', normalizeId)
      .action((id) => {
        const store = open();
        const result = setStatus(store, id, status, actor());
        report(store, result, `${id} → ${status}`);
      });
  }

  program
    .command('cancel')
    .description('cancel a task, optionally naming its replacements')
    .argument('<id>', 'task id', normalizeId)
    .option('--replaced-by <ids>', 'tasks that replace it (comma-separated, repeatable)', collectIds)
    .action((id, options) => {
      const store = open();
      const result = cancelTask(store, id, options.replacedBy ?? [], actor());
      const suffix =
        result.task.replacedBy.length > 0
          ? ` (replaced by ${result.task.replacedBy.join(', ')})`
          : '';
      report(store, result, `cancelled ${id}${suffix}`);
    });

  program
    .command('bump')
    .description('move a task in the priority order (clamped by dependencies)')
    .argument('<id>', 'task id', normalizeId)
    .argument('<target>', 'top | bottom | 1-based position', parsePriority)
    .addHelpText(
      'after',
      `
Positions count active (todo + in progress) tasks only, and the move is
clamped: a task never lands above an active task that blocks it, nor below
an active task it blocks — you get the nearest legal position.

Examples:
  planny bump t7 top
  planny bump t7 3`,
    )
    .action((id, target) => {
      const store = open();
      const result = bumpTask(store, id, target, actor());
      const { position, total } = activePosition(store.loadAll(), id);
      const where = position > 0 ? `position ${position} of ${total} active` : 'the inactive set';
      report(store, result, `moved ${id} to ${where}`);
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
    .option('--changed-since <time>', 'only tasks updated at or after this ISO time', parseTime)
    .option('--count', 'print only the number of matching tasks')
    .option('--json', 'machine-readable output')
    .option('--compact', 'with --json: id, name, status, type, kind, updated only — no bodies')
    .action((options) => {
      const store = open();
      if (!options.json && !options.count) nameStore(store);
      const tasks = listTasks(store, {
        status: options.status,
        kind: options.kind,
        type: options.type,
        model: options.model,
        parent: options.parent,
        recursive: options.recursive,
        blocked: options.blocked ? true : options.unblocked ? false : undefined,
        changedSince: options.changedSince,
      });
      if (options.count) {
        io.out(String(tasks.length));
        return;
      }
      if (options.json) {
        if (options.compact) {
          io.out(JSON.stringify(tasks.map(compactTask), null, 2));
          return;
        }
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
      const store = open();
      nameStore(store);
      io.out(
        renderTaskList(store.loadAll(), {
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
      const store = open();
      nameStore(store);
      io.out(renderDependencyForest(store.loadAll()));
    });

  program
    .command('next')
    .description('what to work on now: unblocked leaf tasks in priority order')
    .argument('[n]', 'how many tasks', (v: string) => Number(v), 5)
    .option('--kind <kind>', 'filter by owner kind')
    .option('--under <id>', 'restrict to the subtree under this task', normalizeId)
    .option('--include-parked', 'offer parked tasks too')
    .option('--json', 'machine-readable output')
    .action((n, options) => {
      const store = open();
      if (!options.json) nameStore(store);
      const items = nextTasks(store, n, {
        kind: options.kind,
        under: options.under,
        includeParked: options.includeParked === true,
      });
      if (options.json) {
        io.out(
          JSON.stringify(
            items.map((item) => ({
              task: item.task,
              ancestors: item.path.map((t) => t.id),
              unlocks: item.unlocks.map((t) => t.id),
              holder: holderOf(item.task)?.by ?? null,
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
      const store = open();
      if (!options.json) nameStore(store);
      const result = progress(store, options.parent);
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
    .command('catchup')
    .description('everything that changed since this consumer last asked, then advance its cursor')
    .option('--as <id>', 'consumer id (defaults to --session / $PLANNY_SESSION)')
    .option('--peek', 'look without advancing the cursor')
    .option('--json', 'machine-readable output')
    .option('--compact', 'with --json: ids, names, statuses and stamps only — no bodies or history')
    .addHelpText(
      'after',
      `
Each consumer id has its own cursor, stored in .planny/cursors.json: a call
returns everything changed since that consumer's previous call, then
advances the cursor. The first call returns the full state. You can see
the same change twice — never missed, sometimes repeated — so treat each
entry as a current fact, safe to read again.

Examples:
  planny catchup --json                          uses $PLANNY_SESSION as the id
  planny catchup --as mike --peek                look without advancing`,
    )
    .action((options) => {
      const consumer: string | undefined = options.as ?? actor();
      if (consumer === undefined) {
        throw new Error('give --as <id>, or set --session / $PLANNY_SESSION');
      }
      const store = open();
      const result = catchup(store, consumer, { peek: options.peek });
      // Resolutions come first in every form: the delta is consumed once,
      // and a truncated read must lose the least important part last.
      if (options.json) {
        io.out(
          JSON.stringify(
            options.compact
              ? compactCatchup(result)
              : {
                  consumer: result.consumer,
                  since: result.since ?? null, // always present: JSON drops undefined keys
                  now: result.now,
                  resolved: result.resolved.map(({ task, dependants, outcomeTask }) => ({
                    task,
                    dependants: dependants.map((t) => t.id),
                    outcomeTask,
                  })),
                  changed: result.changed,
                },
            null,
            2,
          ),
        );
        return;
      }
      const header =
        result.since === undefined
          ? `first catch-up for ${consumer}: full state follows`
          : `changes since ${result.since}`;
      io.out(header);
      for (const { task, dependants, outcomeTask } of result.resolved) {
        io.out(resolvedBlock(task, dependants, outcomeTask));
      }
      if (result.changed.length === 0) {
        io.out('Nothing changed.');
      } else {
        const graph = buildGraph(store.loadAll());
        io.out(result.changed.map((task) => taskLabel(task, graph)).join('\n'));
      }
      if (options.peek) io.out('(peek: cursor not advanced)');
    });

  program
    .command('decisions')
    .description('list open decisions in the order to answer them')
    .option('--resolved', 'list answered decisions instead, newest first')
    .option('--since <time>', 'with --resolved: only decisions answered at or after this ISO time', parseTime)
    .option('--include-parked', 'list parked decisions too')
    .option('--json', 'machine-readable output')
    .action((options) => {
      const store = open();
      if (!options.json) nameStore(store);
      if (options.resolved) {
        const resolved = resolvedDecisions(store, options.since);
        if (options.json) {
          io.out(
            JSON.stringify(
              resolved.map(({ task, dependants, outcomeTask }) => ({ task, dependants: dependants.map((t) => t.id), outcomeTask })),
              null,
              2,
            ),
          );
          return;
        }
        if (resolved.length === 0) {
          io.out('No resolved decisions.');
          return;
        }
        io.out(
          resolved
            .map(({ task, dependants, outcomeTask }) =>
              resolvedBlock(task, dependants, outcomeTask, task.resolvedAt ?? task.updated),
            )
            .join('\n'),
        );
        return;
      }
      const items = nextDecisions(store, { includeParked: options.includeParked === true });
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
    .option('--reject', 'close as decided-no: record the rejection, create no outcome task')
    .option('--json', 'machine-readable output: {task, outcomeTask, warnings}')
    .addHelpText(
      'after',
      `
The answer is appended to the task under "## Outcome", the decision is
marked done, and an outcome task is created as the decision's child —
the answer as work an agent picks up. --reject closes the decision as
decided-no and creates nothing (--response adds the reason). Afterwards,
enrich the record with what was built:
planny update <id> --append-desc "Consequences: … Files: … How to test: …"

Examples:
  planny resolve t5 --accept
  planny resolve t5 --response "Use SQLite; revisit at 10k rows/day."
  planny resolve t5 --response-file answer.md   (- reads stdin)
  planny resolve t5 --reject --response "not worth the surface"`,
    )
    .action((id, options) => {
      if (options.accept && options.reject) {
        throw new Error('pass --accept or --reject, not both');
      }
      const response: string | undefined = options.accept
        ? 'Accepted the proposal.'
        : options.responseFile !== undefined
          ? options.responseFile === '-'
            ? readFileSync(0, 'utf8')
            : readFileSync(options.responseFile, 'utf8')
          : options.response;
      if (options.reject !== true && (response === undefined || response.trim() === '')) {
        throw new Error('give the decision with --response, --response-file or --accept');
      }
      const store = open();
      const result = resolveDecision(store, id, response ?? '', actor(), {
        reject: options.reject === true,
      });
      if (options.json) {
        // The same shape the server's resolve route sends.
        io.out(
          JSON.stringify(
            {
              task: result.task,
              outcomeTask: result.outcomeTask ?? null,
              warnings: result.warnings,
            },
            null,
            2,
          ),
        );
        return;
      }
      report(store, result, resolvedLine(id, result));
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
      let ask = io.prompt;
      let cleanup = (): void => {};
      if (ask === undefined) {
        const { createInterface } = await import('node:readline/promises');
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        // Input can end before the loop does — a piped file, a closed
        // terminal. readline's question never settles then, so the command
        // would hang forever. Treat the end of input as "quit".
        let ended = false;
        rl.once('close', () => {
          ended = true;
        });
        ask = async (question) => {
          if (ended) return 'q';
          return Promise.race([
            rl.question(question),
            new Promise<string>((resolve) => rl.once('close', () => resolve('q'))),
          ]);
        };
        cleanup = () => rl.close();
      }
      try {
        for (const item of ready) {
          const id = item.task.id;
          io.out('');
          io.out(renderShow(item.task, store.loadAll(), store.path(id)));
          const finish = (response: string, reject = false): void => {
            const result = resolveDecision(store, id, response, actor() ?? 'operator', { reject });
            report(store, result, resolvedLine(id, result));
          };
          // The same choices the board offers, in the same words.
          const choice = (
            await ask('\n[a]ccept proposal / [s]ubmit answer / [x] reject / [p]ark / [c]ancel / [n]ext / [q]uit: ')
          )
            .trim()
            .toLowerCase();
          if (choice === 'q') break;
          try {
            if (choice === 'a') {
              finish('Accepted the proposal.');
            } else if (choice === 'x') {
              finish((await ask('Reason (optional): ')).trim(), true);
            } else if (choice === 's') {
              const answer = (await ask('Your decision: ')).trim();
              if (answer !== '') finish(answer);
              else io.out('Empty answer; nothing recorded.');
            } else if (choice === 'p') {
              const note = (await ask('What should bring it back? (optional): ')).trim();
              const result = setStatus(store, id, 'parked', actor() ?? 'operator', {
                parkedUntil: note === '' ? undefined : note,
              });
              report(store, result, `${id} → parked`);
            } else if (choice === 'c') {
              const result = cancelTask(store, id, [], actor() ?? 'operator');
              report(store, result, `cancelled ${id}`);
            }
          } catch (error) {
            // Another writer may have answered this one since the queue was
            // read. Say so and keep going: the rest of the queue is still good.
            io.err(`${id}: ${(error as Error).message}`);
          }
        }
      } finally {
        cleanup();
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

  /**
   * The host to put at the end of the forward: what the operator named, else
   * the address their own machine dialled to get here. The note goes to
   * stderr, so the command on stdout stays exactly a command — a pipe, a
   * `$(...)` or a paste all keep working.
   */
  const chosenTarget = (
    named: string | true,
    found: { target: string; port?: number } | null,
  ): { target: string; port?: number } | null => {
    if (typeof named === 'string') return { target: named };
    if (found === null) {
      // Nothing to read, so hand over what this machine does know. An agent
      // can offer these to the operator as candidates instead of guessing,
      // and a person can usually recognize their own box in the list.
      io.err(
        'could not work out how you reach this machine, which is normal and not a fault: the address comes from an ssh session, and this command is not running in one. A local terminal, a tmux pane older than your session, a cron job and a container all look the same from here.',
      );
      io.err(
        'replace <host> with the name you ssh to, or user@address; put -p <port> before the -L flags for a port that is not 22.',
      );
      io.err(
        `this machine is called ${hostname()}, reachable at ${ownAddresses().join(', ') || 'no address but its own'}`,
      );
      return null;
    }
    // Named, not stated: a tmux pane or a detached process can carry the
    // environment of a session that has since gone, and would name a host
    // that no longer reaches here.
    io.err(
      `guessing host ${found.target} from this shell's ssh session — pass one to --forward if that is not how you reach this machine`,
    );
    return found;
  };

  /** Every address of this machine that something else could dial. */
  const ownAddresses = (): string[] =>
    Object.values(networkInterfaces())
      .flat()
      .filter((face): face is NonNullable<typeof face> => face !== undefined && !face.internal && face.family === 'IPv4')
      .map((face) => face.address);

  /**
   * `serve --all`: a board for every plan on this machine, and one page that
   * links to them. Each board is the ordinary per-plan one, started the
   * ordinary way, so nothing here knows more about a plan than `serve` does.
   */
  const serveEveryPlan = async (options: {
    root: string[];
    port?: number;
    stop?: boolean;
    forward?: boolean;
    detach?: boolean;
  }): Promise<void> => {
    const all = await import('./serve-all.js');
    const { discoverStores } = await import('./discover.js');
    const roots: string[] = options.root.length > 0 ? options.root : [homedir()];
    const port: number = options.port === undefined ? all.PAGE_PORT : options.port;
    const plans = discoverStores(roots);
    if (options.stop === true) {
      const page = await all.stopPage(port);
      io.out(
        page.kind === 'stopped'
          ? `stopped the boards page ${page.url} (pid ${page.pid})`
          : 'the boards page was not running',
      );
      for (const { name, outcome } of await all.stopBoards(plans)) {
        io.out(
          outcome.kind === 'stopped'
            ? `stopped ${name} ${outcome.url} (pid ${outcome.pid})`
            : `${name}: no board was running${outcome.kind === 'stale' ? ' (cleared a stale record)' : ''}`,
        );
      }
      return;
    }
    if (options.forward !== undefined && options.forward !== false) {
      const running = (await all.probeBoards(plans)).filter((b) => b.url !== null);
      const ports = [port, ...running.map((b) => Number(new URL(b.url!).port))];
      io.out(all.forwardCommand(ports, chosenTarget(options.forward, all.sshTarget())));
      return;
    }
    if (plans.length === 0) {
      throw new Error(
        `no .planny plans found under ${roots.join(', ')} — run \`planny init\` in a project, or pass --root <dir>`,
      );
    }
    for (const ui of await all.startBoards(plans)) {
      io.out(`${ui.name}: ${ui.started ? 'started' : 'already up'} at ${ui.url}`);
    }
    if (options.detach === true) {
      const outcome = await all.detachPage(roots, port);
      if (outcome.kind === 'already') {
        io.out(`boards page: ${outcome.url} (already up)`);
        return;
      }
      io.out(`boards page: ${outcome.url} (detached, pid ${outcome.pid})`);
      io.out(`log: ${outcome.log}`);
      io.out('stop everything with: planny serve --all --stop');
      return;
    }
    const already = await all.currentPageUrl(port);
    if (already !== null) {
      io.out(`boards page: ${already} (already up)`);
      return;
    }
    let page;
    try {
      page = await all.startPage({ plans, roots }, port);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
      throw new Error(`port ${port} is in use by something else — pass --port <other>`);
    }
    io.out(`boards page: http://127.0.0.1:${page.port} (ctrl-c stops the page; the UIs stay up)`);
    // Keep the process alive until interrupted.
    await new Promise<void>((resolve) => {
      process.once('SIGINT', resolve);
      process.once('SIGTERM', resolve);
    });
    await page.close();
  };

  program
    .command('serve')
    .description('start the localhost control site')
    .option('--all', 'every plan on this machine: a board each, and one page linking them')
    .option('--root <dir>', 'with --all: where to look (repeatable; default your home directory)', collectRoots, [])
    .option('--port <port>', 'port to listen on (with --all, the page\'s port; default: the first free port from 5891)', (v: string) => Number(v))
    .option('--detach', 'launch the server as its own detached process and return')
    .option('--stop', 'stop the detached server for this store')
    .option('--forward [host]', 'print the ssh command that tunnels what this command serves')
    .option('--clean-logs', "delete this store's serve log once it is old and its server is gone")
    .option(
      '--older-than <days>',
      'with --clean-logs: only delete logs older than this many days (default 7)',
      (v: string) => Number(v),
    )
    .addHelpText(
      'after',
      `
--detach starts the server in its own OS session, so it survives the shell
or agent session that launched it (harnesses reap session-scoped background
tasks). Its output goes to .planny/serve.log in this store; the command
prints the URL, pid and log path once the board answers. Already serving is
a success. --stop reads the record the server keeps in .planny/serve.json,
so it takes no --port; a record left by a crash is cleared, and nothing
running is a success. Stopping keeps the log for post-mortems; --clean-logs
deletes this store's log once its server is gone and it is older than
--older-than days (default 7) — other projects' logs are never touched. It
also sweeps dead planny-serve-<port>.log files that planny 0.1.9 and older
left in the OS temp dir.

--forward prints the ssh command that tunnels what this command serves.
Two machines are involved: run --forward on the machine that serves the
boards, then paste the line it prints on the machine you sit at. Inside an
ssh session it fills in the host itself, from the address your machine
dialled to get here, so the line needs no editing; pass a host
(--forward my-box) when you reach this machine by another name, such as an
alias in your own ssh config. Outside one it leaves <host> for you. The
command goes to stdout on its own, so a pipe or a paste both work. Do not
wrap it in \`ssh $(planny serve --forward)\`: that substitution runs where
you paste it, which is the machine with no plan on it.

--all works on every plan on this machine instead of this one. It finds
them under your home directory, or under each --root you name, starts a
board for each plan that has none, and serves one page that links to them
all — one address to keep, never a port. A board already running is left
alone, and each runs whichever planny started it. The search looks past
node_modules, build directories, hidden directories, and a linked git
worktree's checkout of a plan (that worktree shares the main one). With
--all, --port is the page's port, --stop takes the page and every board
down, and --forward covers them all. --clean-logs works on one plan's log,
so it takes no --all.

Examples:
  planny serve --detach            board that outlives this session
  planny serve --stop              stop it (the log stays)
  planny serve --forward           the ssh line to tunnel this board
  planny serve --all --forward my-box  name the host yourself
  planny serve --all --detach      every plan's board, and one link to them all
  planny serve --all --root ~/code look under ~/code only
  planny serve --all --stop        take the page and every board down
  planny serve --clean-logs        delete dead serve logs older than 7 days`,
    )
    .action(async (options) => {
      const {
        startServer,
        servedStoreRoot,
        detachServer,
        stopServer,
        cleanLogs,
        pickPorts,
        currentServeUrl,
        BASE_PORT,
      } = await import('./server.js');
      const modes = ['detach', 'stop', 'forward'].filter((mode) => options[mode] === true);
      if (modes.length > 1) throw new Error('pass one of --detach, --stop or --forward');
      if (options.cleanLogs === true && modes.length > 0) {
        throw new Error('pass --clean-logs on its own');
      }
      if (options.olderThan !== undefined && options.cleanLogs !== true) {
        throw new Error('--older-than only works with --clean-logs');
      }
      if (options.root.length > 0 && options.all !== true) {
        throw new Error('--root only works with --all');
      }
      if (options.all === true && options.cleanLogs === true) {
        throw new Error("--clean-logs works on one plan's log, so it takes no --all");
      }
      if (options.all === true) {
        await serveEveryPlan(options);
        return;
      }
      const store = open();
      if (options.forward !== undefined && options.forward !== false) {
        const { forwardCommand, sshTarget } = await import('./serve-all.js');
        const url = await currentServeUrl(store);
        if (url === null) {
          throw new Error('no board is running for this store — start one with `planny serve --detach`');
        }
        io.out(forwardCommand([Number(new URL(url).port)], chosenTarget(options.forward, sshTarget())));
        return;
      }
      if (options.cleanLogs === true) {
        const days = options.olderThan === undefined ? 7 : (options.olderThan as number);
        const outcome = await cleanLogs(store, days);
        for (const path of outcome.keptLive) {
          io.out(`kept ${path} — a live server still writes it`);
        }
        for (const path of outcome.deleted) io.out(`deleted ${path}`);
        io.out(
          outcome.deleted.length === 0
            ? `no serve logs older than ${days} days`
            : `deleted ${outcome.deleted.length} serve log${outcome.deleted.length === 1 ? '' : 's'} older than ${days} days`,
        );
        return;
      }
      if (options.stop === true) {
        const outcome = await stopServer(store);
        io.out(
          outcome.kind === 'stopped'
            ? `stopped ${outcome.url} (pid ${outcome.pid})${outcome.log === undefined ? '' : ` — log kept at ${outcome.log}`}`
            : outcome.kind === 'stale'
              ? 'nothing to stop — cleared the stale record a crashed server left behind'
              : 'nothing to stop — the UI is not being served for this store',
        );
        return;
      }
      // No --port: take the port this store used last, else the first free
      // one from the base. Two stores on one machine then settle on two
      // addresses without the operator choosing either.
      const chosen: number[] =
        options.port === undefined ? await pickPorts(store, BASE_PORT) : [options.port as number];
      if (options.detach === true) {
        const outcome = await detachServer(store, chosen[0]!);
        if (outcome.kind === 'already') {
          io.out(`already serving this store at ${outcome.url}`);
          return;
        }
        io.out(`planny ui: ${outcome.url} (detached, pid ${outcome.pid})`);
        io.out(`log: ${outcome.log}`);
        io.out('stop it with: planny serve --stop');
        return;
      }
      let running;
      for (const [index, port] of chosen.entries()) {
        try {
          running = await startServer(store, port);
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
          // The skill tells agents to serve at session start, so a taken
          // port is routine: find out who holds it before complaining.
          const holder = await servedStoreRoot(port);
          if (holder === store.root) {
            io.out(`already serving this store at http://127.0.0.1:${port}`);
            return;
          }
          // A port picked for us was free a moment ago and is not now: a
          // racing launcher took it, so try the next one.
          if (index < chosen.length - 1) continue;
          throw new Error(
            holder !== undefined
              ? `port ${port} is serving a different store (${holder}) — pass --port <other>`
              : `port ${port} is in use by something else — pass --port <other>`,
          );
        }
      }
      if (running === undefined) throw new Error('no port was free — pass --port <free port>');
      io.out(`planny ui: http://127.0.0.1:${running.port} (ctrl-c to stop)`);
      // Keep the process alive until interrupted.
      await new Promise<void>((resolve) => {
        process.once('SIGINT', resolve);
        process.once('SIGTERM', resolve);
      });
      await running.close();
    });

  program
    .command('url')
    .description('print the address where the localhost UI serves this store')
    .addHelpText(
      'after',
      `
Reads the record the server leaves in .planny/serve.json and probes it, so
a crashed or foreign server is never reported. Exits 1 when nothing serves
this store.

Examples:
  planny url                       http://127.0.0.1:5891
  open "$(planny url)"             jump to the board (macOS)`,
    )
    .action(async () => {
      const store = open();
      const { currentServeUrl } = await import('./server.js');
      const url = await currentServeUrl(store);
      if (url === null) {
        throw new Error('the UI is not being served for this store — run `planny serve`');
      }
      io.out(url);
    });


  return program;
}
