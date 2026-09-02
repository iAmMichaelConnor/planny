import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { linkedWorktreeMainPlan } from './store.js';

/**
 * Finding every plan on this machine, so `planny boards` can list and start
 * them.
 *
 * The rule is a plain walk, not a heuristic: from each root, visit every
 * directory down to a depth, and take any that holds a `.planny`. A store
 * found this way is never descended into — a plan inside another plan's tree
 * belongs to the outer plan — and directories nobody keeps a plan in are
 * passed over, so a scan of a home directory does not wade through
 * node_modules.
 */

export interface DiscoverOptions {
  /** How many directory levels below each root to visit. */
  depth?: number;
}

const PLANNY_DIR = '.planny';
const FORK_MARKER = 'fork';
const DEFAULT_DEPTH = 8;

/**
 * Directories the walk passes over. Hidden ones are where tools keep their
 * caches and scratch — a home directory is full of them, and a plan found in
 * one is a fixture somebody left behind, not a project. A hidden directory
 * named as a root is still searched: that is a deliberate ask.
 */
function skip(name: string): boolean {
  return name.startsWith('.') || SKIP.has(name);
}

/** Visible directories that never hold a plan and cost a lot to walk. */
const SKIP = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  'target',
  'vendor',
  'venv',
  '__pycache__',
  'Library',
  'Applications',
]);

/** The root of every store under the given roots, sorted by path. */
export function discoverStores(roots: string[], options: DiscoverOptions = {}): string[] {
  const depth = options.depth ?? DEFAULT_DEPTH;
  const found = new Set<string>();
  for (const root of roots) walk(resolve(root), depth, found);
  return [...found].sort();
}

function walk(dir: string, budget: number, found: Set<string>): void {
  if (budget < 0) return;
  if (existsSync(join(dir, PLANNY_DIR))) {
    found.add(plannyRootOf(dir));
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
    if (!entry.isDirectory() || skip(entry.name)) continue;
    walk(join(dir, entry.name), budget - 1, found);
  }
}

/**
 * The plan this directory really uses. A `.planny` in a linked git worktree
 * is a checkout copy of a tracked store, not a plan of its own, so it counts
 * as the main worktree's plan — the same rule `findRoot` follows for the CLI.
 * The fork marker opts a worktree out of that.
 */
function plannyRootOf(dir: string): string {
  if (existsSync(join(dir, PLANNY_DIR, FORK_MARKER))) return dir;
  return linkedWorktreeMainPlan(dir) ?? dir;
}
