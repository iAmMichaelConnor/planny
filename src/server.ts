import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
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
import { computeProgress, nextDecisions } from './query.js';
import { sortByPriority } from './priority.js';
import type { Store } from './store.js';
import { isStatus } from './types.js';

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
  const server = createServer((req, res) => {
    handle(store, req, res).catch((error: unknown) => {
      const status = error instanceof HttpError ? error.status : 400;
      sendJson(res, status, { error: (error as Error).message });
    });
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

async function handle(store: Store, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;

  if (req.method === 'GET' && path in STATIC_FILES) {
    const asset = STATIC_FILES[path]!;
    const text = await readFile(new URL(`../web/${asset.file}`, import.meta.url), 'utf8');
    res.writeHead(200, { 'content-type': asset.type });
    res.end(text);
    return;
  }

  if (req.method === 'GET' && path === '/api/state') {
    sendJson(res, 200, buildState(store));
    return;
  }

  if (req.method === 'POST' && path === '/api/tasks') {
    sendResult(res, addTask(store, await readJson(req)));
    return;
  }

  const taskRoute = /^\/api\/tasks\/([^/]+)(?:\/([a-z]+))?$/.exec(path);
  if (taskRoute !== null) {
    const [, id, action] = taskRoute;
    if (req.method === 'PATCH' && action === undefined) {
      sendResult(res, updateTask(store, id!, await readJson(req)));
      return;
    }
    if (req.method === 'POST' && action === 'status') {
      const body = await readJson(req);
      const status = body.status;
      if (!isStatus(status)) throw new HttpError(400, `unknown status "${String(status)}"`);
      sendResult(
        res,
        status === 'cancelled'
          ? cancelTask(store, id!, asIdList(body.replacedBy))
          : setStatus(store, id!, status),
      );
      return;
    }
    if (req.method === 'POST' && action === 'bump') {
      const { target } = await readJson(req);
      if (target !== 'top' && target !== 'bottom' && typeof target !== 'number') {
        throw new HttpError(400, 'bump target must be "top", "bottom" or a position number');
      }
      sendResult(res, bumpTask(store, id!, target));
      return;
    }
    if (req.method === 'POST' && action === 'resolve') {
      const { response } = await readJson(req);
      if (typeof response !== 'string' || response.trim() === '') {
        throw new HttpError(400, 'resolve needs a non-empty "response" string');
      }
      sendResult(res, resolveDecision(store, id!, response));
      return;
    }
  }

  sendJson(res, 404, { error: `no route for ${req.method} ${path}` });
}

function buildState(store: Store): object {
  const tasks = store.loadAll();
  const graph = buildGraph(tasks);
  return {
    tasks: sortByPriority(tasks).map((task) => ({
      ...task,
      blocked: graph.isBlocked(task.id),
      blocking: graph.blocking(task.id).map((t) => t.id),
    })),
    progress: computeProgress(tasks),
    decisions: nextDecisions(store).map(({ task, blocked }) => ({ id: task.id, blocked })),
  };
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown> & any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return text === '' ? {} : JSON.parse(text);
  } catch {
    throw new HttpError(400, 'request body is not valid JSON');
  }
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
