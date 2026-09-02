import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, watch } from 'node:fs';
import { readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  await writeFile(servePortPath(store), `${boundPort}\n`);
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

/**
 * The port this store last served on. Unlike serve.json — which says "a
 * server is up right now" and goes away when it stops — this outlives every
 * stop, so the board keeps the same address across restarts and a bookmark
 * keeps working.
 */
function servePortPath(store: Store): string {
  return join(store.root, '.planny', 'serve-port');
}

/** How many ports above the base to try before giving up. */
const PORT_SCAN = 20;

function isPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value < 65536;
}

async function rememberedPort(store: Store): Promise<number | undefined> {
  try {
    const port = Number((await readFile(servePortPath(store), 'utf8')).trim());
    return isPort(port) ? port : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Ports to try, best first: the one this store used last, then the base and
 * its neighbours, skipping anything already listening. Two stores on one
 * machine settle on two addresses without the operator choosing either.
 */
export async function pickPorts(
  store: Store,
  base: number,
  busy: (port: number) => Promise<boolean> = inUse,
): Promise<number[]> {
  const remembered = await rememberedPort(store);
  const candidates = [
    ...(remembered === undefined ? [] : [remembered]),
    ...Array.from({ length: PORT_SCAN }, (_, i) => base + i),
  ];
  const free: number[] = [];
  for (const port of candidates) {
    if (free.includes(port)) continue;
    if (await busy(port)) continue;
    free.push(port);
  }
  if (free.length === 0) {
    throw new Error(
      `every port from ${base} to ${base + PORT_SCAN - 1} is in use — pass --port <free port>`,
    );
  }
  return free;
}

/** True while something answers on this port — planny or not. */
async function inUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(true));
    probe.once('listening', () => probe.close(() => resolve(false)));
    probe.listen(port, '127.0.0.1');
  });
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

export type DetachOutcome =
  | { kind: 'started'; url: string; pid: number; log: string }
  | { kind: 'already'; url: string };

export type StopOutcome =
  | { kind: 'stopped'; url: string; pid: number; log?: string }
  | { kind: 'stale' }
  | { kind: 'nothing' };

export type CleanLogsOutcome = { deleted: string[]; keptLive: string[] };

/** Where a detached server's output goes: beside serve.json, one log per store. */
export function serveLogPath(store: Store): string {
  return join(store.root, '.planny', 'serve.log');
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Where the port scan starts when the operator names no port. */
export const BASE_PORT = 5891;

/**
 * What a detached start needs: the planny command to run, where to run it,
 * where its output goes, and how to tell it is up.
 */
export interface Launch {
  args: string[];
  cwd: string;
  log: string;
  /** The address once the server answers, or null while it does not. */
  up(): Promise<string | null>;
}

/**
 * Launch a planny command as a child in its own OS session, so the server
 * outlives the caller — agent harnesses reap session-scoped background
 * tasks, and a plain child dies with its parent's session. The child has
 * no terminal, so its output (the URL line, any later crash) goes to a
 * log file. Resolves only once the child answers: a 'started' outcome
 * means a live server.
 */
export async function detach(launch: Launch): Promise<DetachOutcome> {
  const existing = await launch.up();
  if (existing !== null) return { kind: 'already', url: existing };
  const { log } = launch;
  const fd = openSync(log, 'a');
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL('./bin.js', import.meta.url)), ...launch.args],
    { cwd: launch.cwd, detached: true, stdio: ['ignore', fd, fd] },
  );
  closeSync(fd);
  let exited = false;
  child.once('exit', () => {
    exited = true;
  });
  child.unref();
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && !exited) {
    const url = await launch.up();
    if (url !== null) return { kind: 'started', url, pid: child.pid ?? 0, log };
    await sleep(100);
  }
  // A racing launcher can win the port between our first probe and the
  // spawn; the child then reports "already serving" and exits. That is
  // success, not a failure to surface.
  const raced = await launch.up();
  if (raced !== null) return { kind: 'already', url: raced };
  if (!exited) child.kill('SIGTERM');
  throw new Error(`the detached server did not come up — from ${log}:\n${await logTail(log)}`);
}

/** Start this store's board as a detached process; see `detach`. */
export function detachServer(store: Store, port: number): Promise<DetachOutcome> {
  return detach({
    args: ['serve', '--port', String(port)],
    cwd: store.root,
    log: serveLogPath(store),
    up: () => currentServeUrl(store),
  });
}

async function logTail(path: string): Promise<string> {
  try {
    const text = await readFile(path, 'utf8');
    return text.split('\n').slice(-10).join('\n').trim() || '(the log is empty)';
  } catch {
    return '(no log was written)';
  }
}

/**
 * Send SIGTERM to the pid, then wait until `up` says the address no longer
 * answers, so the caller can report the server as really down.
 */
export async function terminate(pid: number, url: string, up: () => Promise<boolean>): Promise<void> {
  process.kill(pid, 'SIGTERM');
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (!(await up())) return;
    await sleep(100);
  }
  throw new Error(`sent SIGTERM to pid ${pid} but ${url} is still serving — stop it by hand`);
}

/**
 * Stop the server recorded in .planny/serve.json. Probes before killing:
 * a record left by a crash points at nothing and is only cleared. Waits
 * until the port stops answering, so a 'stopped' outcome means the board
 * is really down.
 */
export async function stopServer(store: Store): Promise<StopOutcome> {
  let record: { port?: unknown; pid?: unknown };
  try {
    record = JSON.parse(await readFile(serveRecordPath(store), 'utf8')) as typeof record;
  } catch {
    return { kind: 'nothing' };
  }
  const { port, pid } = record;
  if (typeof port !== 'number' || !Number.isInteger(port) || port <= 0) {
    await rm(serveRecordPath(store), { force: true });
    return { kind: 'stale' };
  }
  if ((await servedStoreRoot(port)) !== store.root) {
    await rm(serveRecordPath(store), { force: true });
    return { kind: 'stale' };
  }
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
    throw new Error(`the server at 127.0.0.1:${port} recorded no usable pid — stop it by hand`);
  }
  const url = `http://127.0.0.1:${port}`;
  await terminate(pid, url, async () => (await servedStoreRoot(port)) === store.root);
  // A foreground serve leaves no log; name it only when it exists.
  const log = serveLogPath(store);
  return { kind: 'stopped', url, pid, ...(existsSync(log) ? { log } : {}) };
}

/**
 * Delete this store's serve.log once it is older than the given number of
 * days and no server is writing it — never another project's log. Also
 * sweeps dead planny-serve-<port>.log leftovers of the pre-0.1.10
 * port-keyed scheme out of the OS temp dir, by the same age rule; drop
 * that pass once those files are extinct.
 */
export async function cleanLogs(store: Store, olderThanDays: number): Promise<CleanLogsOutcome> {
  if (!Number.isFinite(olderThanDays) || olderThanDays < 0) {
    throw new Error('--older-than needs a number of days, 0 or more');
  }
  const cutoff = Date.now() - olderThanDays * 86_400_000;
  const deleted: string[] = [];
  const keptLive: string[] = [];

  const own = serveLogPath(store);
  const ownEntry = await stat(own).catch(() => undefined);
  if (ownEntry?.isFile() === true && ownEntry.mtimeMs <= cutoff) {
    if ((await currentServeUrl(store)) !== null) {
      keptLive.push(own);
    } else {
      await rm(own, { force: true });
      deleted.push(own);
    }
  }

  for (const name of await readdir(tmpdir())) {
    const match = /^planny-serve-(\d+)\.log$/.exec(name);
    if (match === null) continue;
    const path = join(tmpdir(), name);
    let entry;
    try {
      entry = await stat(path);
    } catch {
      continue; // deleted by someone else between readdir and stat
    }
    if (!entry.isFile() || entry.mtimeMs > cutoff) continue;
    const port = Number(match[1]);
    if (port > 0 && (await servedStoreRoot(port)) !== undefined) {
      keptLive.push(path);
      continue;
    }
    await rm(path, { force: true });
    deleted.push(path);
  }
  return { deleted, keptLive };
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
          : setStatus(store, id!, status, actorOf(body), {
              take: body.take === true,
              // ops validates the note; the cast only quiets the compiler.
              parkedUntil: body.parkedUntil as string | undefined,
            }),
      );
      return;
    }
    if (req.method === 'POST' && action === 'bump') {
      const body = await readJson(req);
      // ops rejects malformed targets; the cast only quiets the compiler.
      sendResult(res, bumpTask(store, id!, body.target as never, actorOf(body)));
      return;
    }
    if (req.method === 'POST' && action === 'resolve') {
      const body = await readJson(req);
      const reject = body.reject === true;
      const response = body.response;
      if (!reject && (typeof response !== 'string' || response.trim() === '')) {
        throw new HttpError(400, 'resolve needs a non-empty "response" string');
      }
      const result = resolveDecision(
        store,
        id!,
        typeof response === 'string' ? response : '',
        actorOf(body),
        { reject },
      );
      sendJson(res, 200, {
        task: result.task,
        warnings: result.warnings,
        outcomeTask: result.outcomeTask ?? null,
      });
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
