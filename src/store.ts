import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseTaskFile, serializeTaskFile } from './frontmatter.js';
import type { Task } from './types.js';

const PLANNY_DIR = '.planny';
const TASKS_DIR = 'tasks';
const TASK_FILE_RE = /^(t\d+)\.md$/;

export interface Store {
  /** Directory that contains `.planny`. */
  root: string;
  path(id: string): string;
  listIds(): string[];
  load(id: string): Task;
  loadAll(): Task[];
  save(task: Task): void;
  nextId(): string;
}

export function initRepo(dir: string): void {
  mkdirSync(join(dir, PLANNY_DIR, TASKS_DIR), { recursive: true });
}

/** Walk up from startDir looking for a `.planny` directory, like git does. */
export function findRoot(startDir: string): string | null {
  let dir = resolve(startDir);
  for (;;) {
    if (existsSync(join(dir, PLANNY_DIR))) return dir;
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

  const listIds = (): string[] =>
    readdirSync(tasksDir)
      .map((name) => TASK_FILE_RE.exec(name)?.[1])
      .filter((id): id is string => id !== undefined)
      .sort((a, b) => idNumber(a) - idNumber(b));

  return {
    root,
    path,
    listIds,
    load(id: string): Task {
      const file = path(id);
      if (!existsSync(file)) throw new Error(`no task ${id} (looked for ${file})`);
      return parseTaskFile(readFileSync(file, 'utf8'));
    },
    loadAll(): Task[] {
      return listIds().map((id) => parseTaskFile(readFileSync(path(id), 'utf8')));
    },
    save(task: Task): void {
      writeFileSync(path(task.id), serializeTaskFile(task));
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
