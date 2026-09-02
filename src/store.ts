import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { parseTaskFile, serializeTaskFile } from './frontmatter.js';
import type { Task } from './types.js';

const PLANNY_DIR = '.planny';
const TASKS_DIR = 'tasks';
/** The only file shape the CLI writes into tasks/. Doctor flags the rest. */
export const TASK_FILE_RE = /^(t\d+)\.md$/;

export interface ScanFailure {
  file: string;
  error: string;
  code: 'parse' | 'id-mismatch';
}

export interface ScanResult {
  tasks: Task[];
  failures: ScanFailure[];
}

export interface Store {
  /** Directory that contains `.planny`. */
  root: string;
  /** The directory holding the task files. */
  tasksDir: string;
  path(id: string): string;
  listIds(): string[];
  load(id: string): Task;
  /** Parse every task file, collecting failures instead of throwing. */
  scan(): ScanResult;
  /** Like scan, but throws on the first unparseable file. */
  loadAll(): Task[];
  save(task: Task): void;
  nextId(): string;
}

export function initRepo(dir: string): void {
  mkdirSync(join(dir, PLANNY_DIR, TASKS_DIR), { recursive: true });
  // The transient files beside tasks/ must not be committed. A
  // hand-edited ignore file is the operator's; leave it alone.
  const ignore = join(dir, PLANNY_DIR, '.gitignore');
  if (!existsSync(ignore)) {
    writeFileSync(ignore, 'serve.json\nserve.log\nlock\nlast-seen.json\n');
  }
}

/** Existing in a worktree's `.planny`, this marks the fork as deliberate. */
const FORK_MARKER = 'fork';

/**
 * The rewind tripwire (t226): an untracked sidecar remembering the highest
 * id and newest `updated` stamp this machine has written. Saves advance it,
 * monotonically; opens and scans compare against it and warn when the
 * store on disk is behind — a git checkout or restore rewound the plan.
 * Deleting the file acknowledges a deliberate rewind.
 */
const LAST_SEEN = 'last-seen.json';

interface LastSeen {
  maxId: number;
  updated: string;
}

const warnedRewinds = new Set<string>();

function lastSeenPath(root: string): string {
  return join(root, PLANNY_DIR, LAST_SEEN);
}

function readLastSeen(root: string): LastSeen | null {
  try {
    const raw = JSON.parse(readFileSync(lastSeenPath(root), 'utf8')) as Record<string, unknown>;
    if (typeof raw.maxId !== 'number' || typeof raw.updated !== 'string') return null;
    return { maxId: raw.maxId, updated: raw.updated };
  } catch {
    return null;
  }
}

function advanceLastSeen(root: string, task: Task): void {
  const seen = readLastSeen(root) ?? { maxId: 0, updated: '' };
  const next: LastSeen = {
    maxId: Math.max(seen.maxId, idNumber(task.id)),
    updated: task.updated > seen.updated ? task.updated : seen.updated,
  };
  if (next.maxId === seen.maxId && next.updated === seen.updated) return;
  writeFileSync(lastSeenPath(root), `${JSON.stringify(next)}\n`);
}

/**
 * Hand-edits legitimately reuse stamps a moment old; a real rewind (a
 * checkout, a restore) jumps much further back. The slack keeps the
 * tripwire quiet for the first and loud for the second.
 */
const REWIND_SLACK_MS = 5_000;

export function behindMark(newest: string, mark: string): boolean {
  const newestMs = Date.parse(newest);
  const markMs = Date.parse(mark);
  if (Number.isNaN(newestMs) || Number.isNaN(markMs)) return newest < mark;
  return newestMs < markMs - REWIND_SLACK_MS;
}

function warnRewound(root: string, detail: string): void {
  if (warnedRewinds.has(root)) return;
  warnedRewinds.add(root);
  console.error(
    `planny: the store at ${root} looks older than what this machine last wrote (${detail}) — a git checkout or restore may have rewound the plan; run \`planny doctor\` for what to do`,
  );
}

/**
 * When dir sits inside a linked git worktree and the main worktree holds a
 * `.planny` at the matching relative path, return that main directory. A
 * linked worktree is told apart from the main checkout by its `.git`: a
 * one-line `gitdir: …` file instead of a directory. The main root comes
 * from the `commondir` file inside that gitdir; a bare main repo has no
 * working tree to defer to.
 */
export function linkedWorktreeMainPlan(dir: string): string | null {
  const target = resolve(dir);
  let wtRoot = target;
  while (!existsSync(join(wtRoot, '.git'))) {
    const parent = dirname(wtRoot);
    if (parent === wtRoot) return null;
    wtRoot = parent;
  }
  const gitPath = join(wtRoot, '.git');
  if (statSync(gitPath).isDirectory()) return null;
  const gitdirLine = /^gitdir:\s*(.+)$/m.exec(readFileSync(gitPath, 'utf8'));
  if (gitdirLine === null) return null;
  const gitdir = resolve(wtRoot, gitdirLine[1]!.trim());
  let common: string;
  try {
    common = readFileSync(join(gitdir, 'commondir'), 'utf8').trim();
  } catch {
    return null;
  }
  const commonDir = resolve(gitdir, common);
  if (basename(commonDir) !== '.git') return null;
  const main = join(dirname(commonDir), relative(wtRoot, target));
  if (main === target || !existsSync(join(main, PLANNY_DIR))) return null;
  return main;
}

/**
 * Walk up from startDir looking for a `.planny` directory, like git does.
 * A `.planny` found inside a linked git worktree is a checkout copy of a
 * tracked store, not a plan of its own: discovery defers to the main
 * worktree's store unless the fork marker opts this worktree out.
 */
export function findRoot(startDir: string): string | null {
  let dir = resolve(startDir);
  for (;;) {
    if (existsSync(join(dir, PLANNY_DIR))) {
      if (existsSync(join(dir, PLANNY_DIR, FORK_MARKER))) return dir;
      const main = linkedWorktreeMainPlan(dir);
      if (main === null) return dir;
      console.error(
        `planny: this is a linked git worktree — using the main worktree's plan at ${join(main, PLANNY_DIR)} (create ${join(dir, PLANNY_DIR, FORK_MARKER)} to keep a separate plan here)`,
      );
      return main;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function openStore(startDir: string): Store {
  const root = findRoot(startDir);
  if (root === null) {
    throw new Error(`no .planny directory found from ${startDir} upward — run \`planny init\` first`);
  }
  const tasksDir = join(root, PLANNY_DIR, TASKS_DIR);

  const path = (id: string): string => join(tasksDir, `${id}.md`);

  const seenAtOpen = readLastSeen(root);
  if (seenAtOpen !== null) {
    const maxNow = readdirSync(tasksDir)
      .map((name) => TASK_FILE_RE.exec(name)?.[1])
      .filter((id): id is string => id !== undefined)
      .reduce((acc, id) => Math.max(acc, idNumber(id)), 0);
    if (maxNow < seenAtOpen.maxId) {
      warnRewound(root, `highest task id t${maxNow}, but t${seenAtOpen.maxId} was minted here`);
    }
  }

  const listIds = (): string[] =>
    readdirSync(tasksDir)
      .map((name) => TASK_FILE_RE.exec(name)?.[1])
      .filter((id): id is string => id !== undefined)
      .sort((a, b) => idNumber(a) - idNumber(b));

  const scan = (): ScanResult => {
    const tasks: Task[] = [];
    const failures: ScanFailure[] = [];
    for (const id of listIds()) {
      try {
        const task = parseTaskFile(readFileSync(path(id), 'utf8'));
        if (task.id !== id) {
          failures.push({
            file: path(id),
            error: `frontmatter says id "${task.id}" but the filename says "${id}"`,
            code: 'id-mismatch',
          });
        } else {
          tasks.push(task);
        }
      } catch (error) {
        failures.push({ file: path(id), error: (error as Error).message, code: 'parse' });
      }
    }
    const seen = readLastSeen(root);
    if (seen !== null && tasks.length > 0) {
      const newest = tasks.reduce((acc, t) => (t.updated > acc ? t.updated : acc), '');
      if (behindMark(newest, seen.updated)) {
        warnRewound(root, `newest update ${newest}, but ${seen.updated} was written here`);
      }
    }
    return { tasks, failures };
  };

  return {
    root,
    tasksDir,
    path,
    listIds,
    load(id: string): Task {
      const file = path(id);
      if (!existsSync(file)) throw new Error(`no task ${id} (looked for ${file})`);
      let task: Task;
      try {
        task = parseTaskFile(readFileSync(file, 'utf8'));
      } catch (error) {
        throw new Error(`${file}: ${(error as Error).message}`);
      }
      // Saving goes to path(task.id): an impostor id would write through
      // to another task's file. Refuse before any mutation can.
      if (task.id !== id) {
        throw new Error(
          `${file}: frontmatter says id "${task.id}" but the filename says "${id}" — run \`planny doctor\``,
        );
      }
      return task;
    },
    scan,
    loadAll(): Task[] {
      const { tasks, failures } = scan();
      if (failures.length > 0) {
        const first = failures[0]!;
        throw new Error(`${first.file}: ${first.error} — run \`planny doctor\` to see all problems`);
      }
      return tasks;
    },
    save(task: Task): void {
      writeFileSync(path(task.id), serializeTaskFile(task));
      advanceLastSeen(root, task);
    },
    nextId(): string {
      const ids = listIds();
      const max = ids.reduce((acc, id) => Math.max(acc, idNumber(id)), 0);
      return `t${max + 1}`;
    },
  };
}

function idNumber(id: string): number {
  return Number(id.slice(1));
}
