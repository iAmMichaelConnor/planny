import { existsSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { discoverStores } from './discover.js';
import {
  BASE_PORT,
  currentServeUrl,
  detach,
  detachServer,
  pickPorts,
  stopServer,
  terminate,
  type DetachOutcome,
  type RunningServer,
  type StopOutcome,
} from './server.js';
import { openStore } from './store.js';

/**
 * One command for every board on this machine. Each plan keeps its own
 * board on its own port; `planny serve --all` starts the ones that are missing
 * and serves the page that links to them all, so the operator keeps one
 * address and never a port.
 */

/** The page's port: just below the range `serve` scans, so a board never takes it. */
export const PAGE_PORT = BASE_PORT - 1;

export interface Board {
  name: string;
  root: string;
  /** Where the plan's board answers, or null while it has none. */
  url: string | null;
}

/**
 * Each plan by name, and where its board answers, if it does. The plans are
 * probed together: each probe waits up to a second for a board that is not
 * there, and one after another that wait would be the page's load time.
 */
export async function probeBoards(plans: string[]): Promise<Board[]> {
  return Promise.all(
    plans.map(async (root) => ({
      name: basename(root),
      root,
      url: await currentServeUrl(openStore(root)),
    })),
  );
}

/** Start a board for every plan that has none; a running one is left alone. */
export async function startBoards(plans: string[]): Promise<Array<Board & { started: boolean }>> {
  const boards: Array<Board & { started: boolean }> = [];
  for (const root of plans) {
    const store = openStore(root);
    const port = (await pickPorts(store, BASE_PORT))[0]!;
    const outcome = await detachServer(store, port);
    boards.push({ name: basename(root), root, url: outcome.url, started: outcome.kind === 'started' });
  }
  return boards;
}

/** Stop every plan's board; see `stopServer` for what each outcome means. */
export async function stopBoards(plans: string[]): Promise<Array<{ name: string; outcome: StopOutcome }>> {
  const results = [];
  for (const root of plans) {
    results.push({ name: basename(root), outcome: await stopServer(openStore(root)) });
  }
  return results;
}

/** What the page serves: the plans found so far, and where to look again. */
export interface PageOptions {
  plans: string[];
  roots: string[];
  /** How old the last walk may be before a request triggers another (default 30 s). */
  rescanAfterMs?: number;
}

const RESCAN_AFTER_MS = 30_000;

/** Serve the page: every plan by name, linking those that have a board. */
export async function startPage(options: PageOptions, port: number): Promise<RunningServer> {
  // Walking a home directory can take a second, so a request never waits
  // for one: the page answers from the plans it knows, then walks again
  // once the last walk is old enough. A new plan shows on a later load.
  let { plans } = options;
  let walked = Date.now();
  const rescanAfter = options.rescanAfterMs ?? RESCAN_AFTER_MS;
  const server = createServer((req, res) => {
    handle(plans, req, res)
      .catch((error: unknown) => {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        res.end((error as Error).message);
      })
      .finally(() => {
        if (Date.now() - walked < rescanAfter) return;
        plans = discoverStores(options.roots);
        walked = Date.now();
      });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return {
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

async function handle(plans: string[], req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = (req.url ?? '/').split('?')[0];
  if (req.method !== 'GET' || (path !== '/' && path !== '/api/boards')) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`no route for ${req.method} ${path}`);
    return;
  }
  // Probed on every request, so a board that came or went shows at once.
  const boards = await probeBoards(plans);
  if (path === '/api/boards') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ pid: process.pid, boards }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
  res.end(renderPage(boards));
}

function renderPage(boards: Board[]): string {
  const rows = boards.map((board) => {
    const path = `<span class="path">${esc(board.root)}</span>`;
    return board.url === null
      ? `<li><span class="name">${esc(board.name)}</span> ${path}<br><span class="down">not running — run <code>planny serve --all</code> again</span></li>`
      : `<li><a class="name" href="${esc(board.url)}">${esc(board.name)}</a> ${path}</li>`;
  });
  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>planny boards</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 system-ui, sans-serif; max-width: 40rem; margin: 3rem auto; padding: 0 1rem; }
  h1 { font-size: 1.1rem; font-weight: 600; }
  ul { list-style: none; padding: 0; }
  li { margin: 0.75rem 0; }
  .name { font-weight: 600; }
  .path, .down { opacity: 0.65; font-size: 0.9em; }
</style>
<h1>planny boards</h1>
${boards.length === 0 ? '<p>No plans found.</p>' : `<ul>\n${rows.join('\n')}\n</ul>`}
`;
}

function esc(text: string): string {
  const entity: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  };
  return text.replace(/[&<>"']/g, (c) => entity[c]!);
}

/** Where the detached page's output goes: one file per machine. */
export function pageLogPath(): string {
  return join(tmpdir(), 'planny-boards.log');
}

/** The page's address while it answers on this port, or null. */
export async function currentPageUrl(port: number): Promise<string | null> {
  return (await pageInfo(port)) === null ? null : `http://127.0.0.1:${port}`;
}

/** What the page says about itself, or null when nothing on the port is the page. */
async function pageInfo(port: number): Promise<{ pid: number } | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/boards`, {
      signal: AbortSignal.timeout(1000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { pid?: unknown; boards?: unknown };
    return typeof body.pid === 'number' && Array.isArray(body.boards) ? { pid: body.pid } : null;
  } catch {
    return null;
  }
}

/** Run the page as its own detached process; see `detach` in server.ts. */
export function detachPage(roots: string[], port: number): Promise<DetachOutcome> {
  return detach({
    args: ['serve', '--all', '--port', String(port), ...roots.flatMap((root) => ['--root', root])],
    cwd: process.cwd(),
    log: pageLogPath(),
    up: () => currentPageUrl(port),
  });
}

/** Stop the page on this port. Nothing answering is a success. */
export async function stopPage(port: number): Promise<StopOutcome> {
  const info = await pageInfo(port);
  if (info === null) return { kind: 'nothing' };
  const url = `http://127.0.0.1:${port}`;
  await terminate(info.pid, url, async () => (await pageInfo(port)) !== null);
  const log = pageLogPath();
  return { kind: 'stopped', url, pid: info.pid, ...(existsSync(log) ? { log } : {}) };
}

/**
 * The command that tunnels these ports, ready to paste.
 *
 * Two machines are involved, and that is the whole point of a forward: the
 * ports are known here, on the machine that serves the boards, and the tunnel
 * is opened there, on the machine the operator sits at. So this prints a whole
 * command rather than a fragment — a fragment invites
 * `ssh $(planny serve --forward) <host>`, whose substitution runs on the
 * laptop, where planny is not installed and no plan exists. The host is left
 * as a placeholder because only the operator knows what they call this
 * machine.
 */
export function forwardCommand(ports: number[]): string {
  return `ssh ${ports.map((port) => `-L ${port}:127.0.0.1:${port}`).join(' ')} <host>`;
}
