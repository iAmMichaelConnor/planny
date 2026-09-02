import { createHash } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { linkedWorktreeMainPlan } from './store.js';

/**
 * Finding every plan on this machine, so one server can hold them all.
 *
 * The rule is a plain walk, not a heuristic: from each root, visit every
 * directory down to a depth, and take any that holds a `.planny`. A store
 * found this way is never descended into — a plan inside another plan's tree
 * belongs to the outer plan — and directories nobody keeps a plan in are
 * passed over, so a scan of a home directory does not wade through
 * node_modules.
 */

export interface FoundStore {
  /** Directory that contains `.planny`. */
  root: string;
  /** What the project is called: the directory's own name. */
  name: string;
  /** URL-safe, stable, and unique across the found set. */
  key: string;
}

export interface DiscoverOptions {
  /** How many directory levels below each root to visit. */
  depth?: number;
}

const PLANNY_DIR = '.planny';
const FORK_MARKER = 'fork';
const DEFAULT_DEPTH = 8;

/** Directories that never hold a plan and cost a lot to walk. */
const SKIP = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  'dist',
  'build',
  'out',
  'target',
  'vendor',
  '.cache',
  '.next',
  '.venv',
  'venv',
  '__pycache__',
  'Library',
  'Applications',
]);

export function discoverStores(roots: string[], options: DiscoverOptions = {}): FoundStore[] {
  const depth = options.depth ?? DEFAULT_DEPTH;
  const found = new Set<string>();
  for (const root of roots) walk(resolve(root), depth, found);
  return name([...found].sort());
}

function walk(dir: string, budget: number, found: Set<string>): void {
  if (budget < 0) return;
  if (existsSync(join(dir, PLANNY_DIR))) {
    const store = plannyRootOf(dir);
    if (store !== null) found.add(store);
    // A plan inside a plan's tree belongs to the outer plan, so stop here.
    return;
  }
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // unreadable, gone, or not a directory: nothing to find here
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || SKIP.has(entry.name)) continue;
    walk(join(dir, entry.name), budget - 1, found);
  }
}

/**
 * The plan this directory really uses. A `.planny` in a linked git worktree
 * is a checkout copy of a tracked store, not a plan of its own, so it counts
 * as the main worktree's plan — the same rule `findRoot` follows for the CLI.
 * The fork marker opts a worktree out of that.
 */
function plannyRootOf(dir: string): string | null {
  if (existsSync(join(dir, PLANNY_DIR, FORK_MARKER))) return dir;
  const main = linkedWorktreeMainPlan(dir);
  return main ?? dir;
}

/**
 * Give each project a name and a key. The name is the directory's, which is
 * what the operator calls it; the key adds a slice of the path's hash when
 * two projects share a name, so it stays unique without becoming unreadable.
 */
function name(roots: string[]): FoundStore[] {
  const counts = new Map<string, number>();
  for (const root of roots) {
    const label = basename(root);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return roots.map((root) => {
    const label = basename(root);
    const unique = (counts.get(label) ?? 0) === 1;
    const safe = label.replace(/[^A-Za-z0-9._-]/g, '-');
    return {
      root,
      name: label,
      key: unique ? safe : `${safe}-${createHash('sha256').update(root).digest('hex').slice(0, 6)}`,
    };
  });
}
