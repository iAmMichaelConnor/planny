import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseTaskFile, serializeTaskFile } from './frontmatter.js';
import type { Task } from './types.js';

const PLANNY_DIR = '.planny';
const TASKS_DIR = 'tasks';
const TASK_FILE_RE = /^(t\d+)\.md$/;

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
    return { tasks, failures };
  };

  return {
    root,
    path,
    listIds,
    load(id: string): Task {
      const file = path(id);
      if (!existsSync(file)) throw new Error(`no task ${id} (looked for ${file})`);
      try {
        return parseTaskFile(readFileSync(file, 'utf8'));
      } catch (error) {
        throw new Error(`${file}: ${(error as Error).message}`);
      }
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
