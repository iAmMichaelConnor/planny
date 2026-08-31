import { watch } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { basename, join } from 'node:path';
import { buildGraph } from './graph.js';
import {
  addTask,
  bumpTask,
  cancelTask,
  resolveDecision,
  setStatus,
  updateTask,
  type AddInput,
  type OpResult,
  type UpdateInput,
} from './ops.js';
import { computeProgress, nextDecisions } from './query.js';
import { activePositions, sortByPriority } from './priority.js';
import type { Store } from './store.js';
import { holderOf, isStatus } from './types.js';

/**
 * Minimal localhost control surface. Serves the static UI from web/ and a
 * JSON API that fronts ops/query. Binds 127.0.0.1 only.
 */

export interface RunningServer {
  port: number;
  close(): Promise<void>;
}

const STATIC_FILES: Record<string, { file: string; type: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/style.css': { file: 'style.css', type: 'text/css; charset=utf-8' },
};

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function startServer(store: Store, port: number): Promise<RunningServer> {
  // Live updates: watch the task files and tell every open page to re-fetch.
  const clients = new Set<ServerResponse>();
  let debounce: NodeJS.Timeout | undefined;
  const watcher = watch(store.tasksDir, { persistent: false }, () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      for (const client of clients) client.write('data: changed\n\n');
    }, 80);
  });

  const server = createServer((req, res) => {
    if (req.method === 'GET' && (req.url ?? '').split('?')[0] === '/api/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      });
      res.write('retry: 1000\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    handle(store, req, res).catch((error: unknown) => {
      const status = error instanceof HttpError ? error.status : 400;
      sendJson(res, status, { error: (error as Error).message });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', (error) => {
      clearTimeout(debounce);
      watcher.close();
      reject(error);
    });
    server.listen(port, '127.0.0.1', resolve);
  });
  const boundPort = (server.address() as AddressInfo).port;
  // Record where this store is served so `planny url` can answer later.
  // A crash leaves the record behind; readers must probe before trusting it.
  await writeFile(
    serveRecordPath(store),
    `${JSON.stringify({ port: boundPort, pid: process.pid, started: new Date().toISOString() })}\n`,
  );
  return {
    port: boundPort,
    close: async () => {
      clearTimeout(debounce);
      watcher.close();
      for (const client of clients) client.end();
      clients.clear();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(serveRecordPath(store), { force: true });
    },
  };
}

function serveRecordPath(store: Store): string {
  return join(store.root, '.planny', 'serve.json');
}

/** Which store root a planny server on this port serves, if any. */
export async function servedStoreRoot(port: number): Promise<string | undefined> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/state`, {
      signal: AbortSignal.timeout(1000),
    });
    if (!res.ok) return undefined;
    const state = (await res.json()) as { store?: { root?: string } };
    return typeof state.store?.root === 'string' ? state.store.root : undefined;
  } catch {
    return undefined;
  }
}

/** The address of a live server for this store, or null when nothing serves it. */
export async function currentServeUrl(store: Store): Promise<string | null> {
  let recorded: unknown;
  try {
    recorded = (JSON.parse(await readFile(serveRecordPath(store), 'utf8')) as { port?: unknown })
      .port;
  } catch {
    return null;
  }
  if (typeof recorded !== 'number' || !Number.isInteger(recorded) || recorded <= 0) return null;
  const root = await servedStoreRoot(recorded);
  return root === store.root ? `http://127.0.0.1:${recorded}` : null;
}

async function handle(store: Store, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;

  if (req.method === 'GET' && path in STATIC_FILES) {
    const asset = STATIC_FILES[path]!;
    const text = await readFile(new URL(`../web/${asset.file}`, import.meta.url), 'utf8');
    // no-cache: browsers must revalidate, or they run yesterday's app.js
    // against today's API after a deploy.
    res.writeHead(200, { 'content-type': asset.type, 'cache-control': 'no-cache' });
    res.end(text);
    return;
  }

  if (req.method === 'GET' && path === '/api/state') {
    sendJson(res, 200, buildState(store));
    return;
  }

  if (req.method === 'POST' && path === '/api/tasks') {
    const body = await readJson(req);
    // ops validates the runtime shape; the cast only quiets the compiler.
    sendResult(res, addTask(store, body as unknown as AddInput, actorOf(body)));
    return;
  }

  const taskRoute = /^\/api\/tasks\/([^/]+)(?:\/([a-z]+))?$/.exec(path);
  if (taskRoute !== null) {
    const [, id, action] = taskRoute;
    if (req.method === 'PATCH' && action === undefined) {
      sendResult(res, updateTask(store, id!, (await readJson(req)) as UpdateInput));
      return;
    }
    if (req.method === 'POST' && action === 'status') {
      const body = await readJson(req);
      const status = body.status;
      if (!isStatus(status)) throw new HttpError(400, `unknown status "${String(status)}"`);
      sendResult(
        res,
        status === 'cancelled'
          ? cancelTask(store, id!, asIdList(body.replacedBy), actorOf(body))
          : setStatus(store, id!, status, actorOf(body), { take: body.take === true }),
      );
      return;
    }
    if (req.method === 'POST' && action === 'bump') {
      const { target } = await readJson(req);
      // ops rejects malformed targets; the cast only quiets the compiler.
      sendResult(res, bumpTask(store, id!, target as never));
      return;
    }
    if (req.method === 'POST' && action === 'resolve') {
      const body = await readJson(req);
      const response = body.response;
      if (typeof response !== 'string' || response.trim() === '') {
        throw new HttpError(400, 'resolve needs a non-empty "response" string');
      }
      sendResult(res, resolveDecision(store, id!, response, actorOf(body)));
      return;
    }
  }

  sendJson(res, 404, { error: `no route for ${req.method} ${path}` });
}

function buildState(store: Store): object {
  const tasks = store.loadAll();
  const graph = buildGraph(tasks);
  const positions = activePositions(tasks);
  return {
    store: { root: store.root, name: basename(store.root) },
    tasks: sortByPriority(tasks).map((task) => ({
      ...task,
      blocked: graph.isBlocked(task.id),
      blocking: graph.blocking(task.id).map((t) => t.id),
      // The server owns position: clamping and repairs mean only the
      // priority engine knows where a task truly stands.
      position: positions.get(task.id) ?? 0,
      holder: holderOf(task)?.by ?? null,
    })),
    progress: computeProgress(tasks),
    decisions: nextDecisions(store).map(({ task, blocked }) => ({ id: task.id, blocked })),
  };
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return text === '' ? {} : JSON.parse(text);
  } catch {
    throw new HttpError(400, 'request body is not valid JSON');
  }
}

/** UI mutations are the human's; a caller may name itself with "by". */
function actorOf(body: Record<string, unknown>): string {
  return typeof body.by === 'string' && body.by !== '' ? body.by : 'operator';
}

function asIdList(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new HttpError(400, 'replacedBy must be a list of task ids');
  }
  return value as string[];
}

function sendResult(res: ServerResponse, result: OpResult): void {
  sendJson(res, 200, { task: result.task, warnings: result.warnings });
}

function sendJson(res: ServerResponse, status: number, body: object): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}
