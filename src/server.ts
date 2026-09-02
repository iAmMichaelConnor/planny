import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
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

/** One plan the server holds: its store, and the name and key it answers to. */
export interface ServedProject {
  key: string;
  name: string;
  store: Store;
}

/**
 * Name the stores for the API. One store keeps the plain basename; two
 * projects of the same name are told apart by a slice of the path's hash, so
 * a key is readable and still unique.
 */
export function asProjects(stores: Store[]): ServedProject[] {
  const counts = new Map<string, number>();
  for (const store of stores) {
    const label = basename(store.root);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return stores.map((store) => {
    const label = basename(store.root);
    const safe = label.replace(/[^A-Za-z0-9._-]/g, '-');
    return {
      store,
      name: label,
      key:
        (counts.get(label) ?? 0) === 1
          ? safe
          : `${safe}-${createHash('sha256').update(store.root).digest('hex').slice(0, 6)}`,
    };
  });
}

export async function startServer(
  stores: Store | Store[],
  port: number,
): Promise<RunningServer> {
  // One store or many: the rest of the server sees a list either way, and
  // the first is the one the unprefixed routes answer for.
  const projects = asProjects(Array.isArray(stores) ? stores : [stores]);
  const byKey = new Map(projects.map((project) => [project.key, project]));

  // Live updates: watch every store's task files and tell every open page
  // which project changed, so a page showing another one need not re-fetch.
  const clients = new Set<ServerResponse>();
  const debounce = new Map<string, NodeJS.Timeout>();
  const watchers = projects.map((project) =>
    watch(project.store.tasksDir, { persistent: false }, () => {
      clearTimeout(debounce.get(project.key));
      debounce.set(
        project.key,
        setTimeout(() => {
          for (const client of clients) client.write(`data: ${project.key}\n\n`);
        }, 80),
      );
    }),
  );
  const stopWatching = (): void => {
    for (const timer of debounce.values()) clearTimeout(timer);
    debounce.clear();
    for (const watcher of watchers) watcher.close();
  };

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
    route(projects, byKey, req, res).catch((error: unknown) => {
      const status = error instanceof HttpError ? error.status : 400;
      sendJson(res, status, { error: (error as Error).message });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', (error) => {
      stopWatching();
      reject(error);
    });
    server.listen(port, '127.0.0.1', resolve);
  });
  const boundPort = (server.address() as AddressInfo).port;
  // Record the address in every store served, so `planny url` answers from
  // any of them. A crash leaves the record behind; readers must probe before
  // trusting it.
  const record = `${JSON.stringify({ port: boundPort, pid: process.pid, started: new Date().toISOString() })}\n`;
  for (const { store } of projects) {
    await writeFile(serveRecordPath(store), record);
    await writeFile(servePortPath(store), `${boundPort}\n`);
  }
  return {
    port: boundPort,
    close: async () => {
      stopWatching();
      for (const client of clients) client.end();
      clients.clear();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      for (const { store } of projects) await rm(serveRecordPath(store), { force: true });
    },
  };
}

/**
 * Strip the project prefix, if there is one, and run the request against that
 * project's store. Everything below this point sees one store and a path it
 * already understands, so the routes are written once.
 */
async function route(
  projects: ServedProject[],
  byKey: Map<string, ServedProject>,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/api/projects') {
    sendJson(res, 200, {
      projects: projects.map(({ key, name, store }) => ({ key, name, root: store.root })),
    });
    return;
  }
  const scoped = /^\/api\/projects\/([^/]+)(\/.*)$/.exec(url.pathname);
  if (scoped !== null) {
    const project = byKey.get(scoped[1]!);
    if (project === undefined) {
      throw new HttpError(404, `no project "${scoped[1]}" is served here`);
    }
    await handle(project.store, projects, `/api${scoped[2]}`, req, res);
    return;
  }
  await handle(projects[0]!.store, projects, url.pathname, req, res);
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

/** Every store root a planny server on this port serves. Empty when none. */
export async function servedStoreRoots(port: number): Promise<string[]> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/state`, {
      signal: AbortSignal.timeout(1000),
    });
    if (!res.ok) return [];
    const state = (await res.json()) as { store?: { root?: string }; roots?: unknown };
    if (Array.isArray(state.roots)) return state.roots.filter((r): r is string => typeof r === 'string');
    return typeof state.store?.root === 'string' ? [state.store.root] : [];
  } catch {
    return [];
  }
}

/** The first store root a planny server on this port serves, if any. */
export async function servedStoreRoot(port: number): Promise<string | undefined> {
  return (await servedStoreRoots(port))[0];
}

/** True while the server on this port holds this store, first or not. */
async function serves(port: number, store: Store): Promise<boolean> {
  return (await servedStoreRoots(port)).includes(store.root);
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

/**
 * Launch `planny serve` as a child in its own OS session, so the board
 * outlives the caller — agent harnesses reap session-scoped background
 * tasks, and a plain child dies with its parent's session. The child has
 * no terminal, so its output (the URL line, any later crash) goes to a
 * log file. Resolves only once the child answers for this store: a
 * 'started' outcome means a live board.
 */
export async function detachServer(
  store: Store,
  port: number,
  options: { all?: boolean; roots?: string[] } = {},
): Promise<DetachOutcome> {
  const existing = await currentServeUrl(store);
  if (existing !== null) return { kind: 'already', url: existing };
  const log = serveLogPath(store);
  const fd = openSync(log, 'a');
  // The child runs the same command the caller asked for, minus --detach.
  const args = [
    fileURLToPath(new URL('./bin.js', import.meta.url)),
    'serve',
    '--port',
    String(port),
    ...(options.all === true ? ['--all'] : []),
    ...(options.roots ?? []).flatMap((root) => ['--root', root]),
  ];
  const child = spawn(process.execPath, args, {
    cwd: store.root,
    detached: true,
    stdio: ['ignore', fd, fd],
  });
  closeSync(fd);
  let exited = false;
  child.once('exit', () => {
    exited = true;
  });
  child.unref();
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && !exited) {
    const url = await currentServeUrl(store);
    if (url !== null) return { kind: 'started', url, pid: child.pid ?? 0, log };
    await sleep(100);
  }
  // A racing launcher can win the port for this store between our first
  // probe and the spawn; the child then reports "already serving" and
  // exits. That is success, not a failure to surface.
  const raced = await currentServeUrl(store);
  if (raced !== null) return { kind: 'already', url: raced };
  if (!exited) child.kill('SIGTERM');
  throw new Error(`the detached server did not come up — from ${log}:\n${await logTail(log)}`);
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
  // A shared server holds several plans, and this store may be any of them.
  if (!(await serves(port, store))) {
    await rm(serveRecordPath(store), { force: true });
    return { kind: 'stale' };
  }
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
    throw new Error(`the server at 127.0.0.1:${port} recorded no usable pid — stop it by hand`);
  }
  process.kill(pid, 'SIGTERM');
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (!(await serves(port, store))) {
      // A foreground serve leaves no log; name it only when it exists.
      const log = serveLogPath(store);
      return {
        kind: 'stopped',
        url: `http://127.0.0.1:${port}`,
        pid,
        ...(existsSync(log) ? { log } : {}),
      };
    }
    await sleep(100);
  }
  throw new Error(
    `sent SIGTERM to pid ${pid} but 127.0.0.1:${port} is still serving — stop it by hand`,
  );
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
  return (await serves(recorded, store)) ? `http://127.0.0.1:${recorded}` : null;
}

async function handle(
  store: Store,
  projects: ServedProject[],
  path: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {

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
    sendJson(res, 200, { ...buildState(store), roots: projects.map((p) => p.store.root) });
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
