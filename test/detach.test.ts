import { execFile, execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * serve --detach / --stop manage real OS processes, so this suite runs the
 * compiled binary end to end instead of the in-process runCli harness.
 */

const execFileAsync = promisify(execFile);
const repo = join(__dirname, '..');
const bin = join(repo, 'dist', 'bin.js');

let dir: string;
const startedPids: number[] = [];

beforeAll(() => {
  // The suite exercises dist, so make dist match the source under test.
  execFileSync(process.execPath, [join(repo, 'node_modules', 'typescript', 'bin', 'tsc')], {
    cwd: repo,
  });
}, 60_000);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'planny-detach-'));
});

afterEach(() => {
  // Belt and braces: no test may leave a server behind, even when it fails.
  for (const pid of startedPids.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
  rmSync(dir, { recursive: true, force: true });
});

async function cli(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return cliIn(dir, ...args);
}

async function cliIn(
  cwd: string,
  ...args: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  const saved = dir;
  dir = cwd;
  try {
    return await runCli(...args);
  } finally {
    dir = saved;
  }
}

async function runCli(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    // TMPDIR points the CLI (and the detached server it spawns) at the
    // per-test dir, so serve logs never leak into the machine's temp dir.
    const { stdout, stderr } = await execFileAsync(process.execPath, [bin, ...args], {
      cwd: dir,
      env: { ...process.env, TMPDIR: dir },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failed.code ?? 1, stdout: failed.stdout ?? '', stderr: failed.stderr ?? '' };
  }
}

/** Remember a detached pid from CLI output so afterEach can reap strays. */
function trackPid(stdout: string): void {
  const pid = /pid (\d+)/.exec(stdout);
  if (pid) startedPids.push(Number(pid[1]));
}

async function until(check: () => Promise<boolean>, ms = 4000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

async function answering(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/api/state`, { signal: AbortSignal.timeout(500) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * decide reads a real terminal, so like the serve tests it needs the compiled
 * binary and a real process — the in-process harness injects its own prompt
 * and never touches readline.
 */
describe('decide over real stdin', () => {
  it('answers what it is fed, then quits when the input ends', async () => {
    await cli('init');
    await cli('add', 'First question', '--type', 'decision', '-d', '## Proposal\n\nDo it.');
    await cli('add', 'Second question', '--type', 'decision');
    // execFileSync, not the async form: only the sync one feeds stdin, which
    // is the whole point of this test.
    const stdout = execFileSync(process.execPath, [bin, 'decide'], {
      cwd: dir,
      env: { ...process.env, TMPDIR: dir },
      input: 'a\n', // one answer, then the input ends mid-loop
      encoding: 'utf8',
      timeout: 15_000,
    });
    expect(stdout).toMatch(/resolved t1/);
    const shown = await cli('show', 't2', '--json');
    expect(JSON.parse(shown.stdout).task.status).toBe('todo');
  }, 30_000);
});

describe('serve --detach and --stop', () => {
  it('detach outlives the CLI, url finds it, stop ends it and clears the record', async () => {
    await cli('init');
    const started = await cli('serve', '--detach', '--port', '0');
    trackPid(started.stdout);
    expect(started.code).toBe(0);
    const url = /http:\/\/127\.0\.0\.1:\d+/.exec(started.stdout)?.[0];
    expect(url).toBeDefined();
    expect(started.stdout).toMatch(/pid \d+/);
    expect(started.stdout).toMatch(/\.planny\/serve\.log/); // says where output goes
    expect(started.stdout).toMatch(/--stop/); // teaches how to end it

    // The launching CLI has exited, yet the board answers: it is detached.
    expect(await answering(url!)).toBe(true);
    const urlCmd = await cli('url');
    expect(urlCmd.code).toBe(0);
    expect(urlCmd.stdout.trim()).toBe(url);

    const stopped = await cli('serve', '--stop');
    expect(stopped.code).toBe(0);
    expect(stopped.stdout).toMatch(/stopped/);
    expect(await until(async () => !(await answering(url!)))).toBe(true);
    expect(existsSync(join(dir, '.planny', 'serve.json'))).toBe(false);
    expect((await cli('url')).code).toBe(1);
  }, 30_000);

  it('two stores get two addresses without anyone choosing a port', async () => {
    const second = mkdtempSync(join(tmpdir(), 'planny-detach-b-'));
    try {
      await cli('init');
      const a = await cli('serve', '--detach');
      trackPid(a.stdout);
      expect(a.code).toBe(0);
      const portA = Number(/127\.0\.0\.1:(\d+)/.exec(a.stdout)![1]);

      await cliIn(second, 'init');
      const b = await cliIn(second, 'serve', '--detach');
      trackPid(b.stdout);
      expect(b.code).toBe(0);
      const portB = Number(/127\.0\.0\.1:(\d+)/.exec(b.stdout)![1]);

      expect(portB).not.toBe(portA);
      expect(await answering(`http://127.0.0.1:${portA}`)).toBe(true);
      expect(await answering(`http://127.0.0.1:${portB}`)).toBe(true);

      // Each store remembers its own address across a stop and a restart.
      expect(readFileSync(join(second, '.planny', 'serve-port'), 'utf8').trim()).toBe(String(portB));
      expect((await cliIn(second, 'serve', '--stop')).code).toBe(0);
      expect(readFileSync(join(second, '.planny', 'serve-port'), 'utf8').trim()).toBe(String(portB));
      const again = await cliIn(second, 'serve', '--detach');
      trackPid(again.stdout);
      expect(again.stdout).toContain(`127.0.0.1:${portB}`);

      expect((await cliIn(second, 'serve', '--stop')).code).toBe(0);
      expect((await cli('serve', '--stop')).code).toBe(0);
    } finally {
      rmSync(second, { recursive: true, force: true });
    }
  }, 60_000);

  it('serves every plan it finds, and stops from any of them', async () => {
    const roots = mkdtempSync(join(tmpdir(), 'planny-all-'));
    try {
      for (const name of ['alpha', 'deep/beta']) {
        mkdirSync(join(roots, name), { recursive: true });
        await cliIn(join(roots, name), 'init');
        await cliIn(join(roots, name), 'add', `task in ${name}`);
      }
      // A plan under node_modules must not be found.
      mkdirSync(join(roots, 'node_modules', 'junk'), { recursive: true });
      await cliIn(join(roots, 'node_modules', 'junk'), 'init');

      const started = await cliIn(join(roots, 'alpha'), 'serve', '--all', '--root', roots, '--detach');
      trackPid(started.stdout);
      expect(started.code).toBe(0);
      const url = /http:\/\/127\.0\.0\.1:\d+/.exec(started.stdout)![0];

      const projects = (await (await fetch(`${url}/api/projects`)).json()) as {
        projects: Array<{ key: string; name: string }>;
      };
      expect(projects.projects.map((p) => p.name).sort()).toEqual(['alpha', 'beta']);

      // Each store finds the shared board, and each holds only its own tasks.
      for (const [name, key] of [['alpha', 'alpha'], ['deep/beta', 'beta']] as const) {
        expect((await cliIn(join(roots, name), 'url')).stdout.trim()).toBe(url);
        const state = (await (await fetch(`${url}/api/projects/${key}/state`)).json()) as {
          tasks: Array<{ name: string }>;
        };
        expect(state.tasks.map((t) => t.name)).toEqual([`task in ${name}`]);
      }

      // Stopping from the second plan ends the shared server, not just its record.
      const stopped = await cliIn(join(roots, 'deep/beta'), 'serve', '--stop');
      expect(stopped.stdout).toMatch(/stopped/);
      expect(await until(async () => !(await answering(url)))).toBe(true);
    } finally {
      rmSync(roots, { recursive: true, force: true });
    }
  }, 60_000);

  it('a second detach is a success no-op that prints the same address', async () => {
    await cli('init');
    const first = await cli('serve', '--detach', '--port', '0');
    trackPid(first.stdout);
    const url = /http:\/\/127\.0\.0\.1:\d+/.exec(first.stdout)![0];

    const second = await cli('serve', '--detach', '--port', '0');
    trackPid(second.stdout);
    expect(second.code).toBe(0);
    expect(second.stdout).toMatch(/already serving/);
    expect(second.stdout).toContain(url);

    expect((await cli('serve', '--stop')).code).toBe(0);
  }, 30_000);

  it('stop with nothing running is a success that says so', async () => {
    await cli('init');
    const result = await cli('serve', '--stop');
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/nothing to stop/i);
  }, 15_000);

  it('stop clears the stale record a crashed server left behind', async () => {
    await cli('init');
    // A record pointing at a dead port: the crash scenario. stop must not
    // kill anything — it probes first — and must clear the record.
    writeFileSync(
      join(dir, '.planny', 'serve.json'),
      `${JSON.stringify({ port: 59_987, pid: 999_999_999, started: '2026-01-01T00:00:00.000Z' })}\n`,
    );
    const result = await cli('serve', '--stop');
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/stale/i);
    expect(existsSync(join(dir, '.planny', 'serve.json'))).toBe(false);
  }, 15_000);

  it('detach onto a foreign port fails and surfaces the child log', async () => {
    await cli('init');
    const blocker: Server = createServer((_req, res) => res.end('not planny'));
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const port = (blocker.address() as { port: number }).port;
    try {
      const result = await cli('serve', '--detach', '--port', String(port));
      trackPid(result.stdout);
      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(/in use|different store/);
    } finally {
      await new Promise((resolve) => blocker.close(resolve));
    }
  }, 30_000);

  it('stop refuses a live server whose record lacks a pid', async () => {
    await cli('init');
    const started = await cli('serve', '--detach', '--port', '0');
    trackPid(started.stdout);
    const recordPath = join(dir, '.planny', 'serve.json');
    const record = JSON.parse(readFileSync(recordPath, 'utf8')) as { port: number };
    writeFileSync(recordPath, `${JSON.stringify({ port: record.port })}\n`);

    const result = await cli('serve', '--stop');
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/no usable pid/);
    // The record was live, not stale: stop must not have cleared it.
    expect(existsSync(recordPath)).toBe(true);
  }, 30_000);

  it('detach and stop together are refused', async () => {
    await cli('init');
    const result = await cli('serve', '--detach', '--stop');
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/not both/i);
  }, 15_000);

  it('the detach log lives in this store\'s .planny, nowhere else', async () => {
    await cli('init');
    const started = await cli('serve', '--detach', '--port', '0');
    trackPid(started.stdout);
    expect(started.code).toBe(0);
    const log = /log: (\S+)/.exec(started.stdout)?.[1];
    expect(log).toBe(join(dir, '.planny', 'serve.log'));
    expect(existsSync(log!)).toBe(true);
    expect((await cli('serve', '--stop')).code).toBe(0);
  }, 30_000);
});

describe('serve --clean-logs', () => {
  function backdate(path: string, ageDays: number): void {
    const then = new Date(Date.now() - ageDays * 86_400_000);
    utimesSync(path, then, then);
  }

  /** This store's own log, seeded dead at the given age. */
  function seedStoreLog(root: string, ageDays: number): string {
    const path = join(root, '.planny', 'serve.log');
    writeFileSync(path, 'old serve output\n');
    backdate(path, ageDays);
    return path;
  }

  /** A leftover of the pre-0.1.10 port-keyed scheme, in the temp dir (= dir here). */
  function seedLegacyLog(name: string, ageDays: number): string {
    const path = join(dir, name);
    writeFileSync(path, 'old serve output\n');
    backdate(path, ageDays);
    return path;
  }

  it('deletes this store\'s dead log once it is older than the default seven days', async () => {
    await cli('init');
    const old = seedStoreLog(dir, 8);
    const result = await cli('serve', '--clean-logs');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(old);
    expect(existsSync(old)).toBe(false);
  }, 15_000);

  it('keeps a log younger than the age', async () => {
    await cli('init');
    const young = seedStoreLog(dir, 6);
    const result = await cli('serve', '--clean-logs');
    expect(result.code).toBe(0);
    expect(existsSync(young)).toBe(true);
  }, 15_000);

  it('--older-than sets the age in days', async () => {
    await cli('init');
    const twoDaysOld = seedStoreLog(dir, 2);
    const result = await cli('serve', '--clean-logs', '--older-than', '1');
    expect(result.code).toBe(0);
    expect(existsSync(twoDaysOld)).toBe(false);
  }, 15_000);

  it('never touches another project\'s log', async () => {
    await cli('init');
    const foreign = mkdtempSync(join(tmpdir(), 'planny-foreign-'));
    try {
      mkdirSync(join(foreign, '.planny'), { recursive: true });
      const foreignLog = join(foreign, '.planny', 'serve.log');
      writeFileSync(foreignLog, "someone else's board\n");
      backdate(foreignLog, 30);
      const result = await cli('serve', '--clean-logs');
      expect(result.code).toBe(0);
      expect(existsSync(foreignLog)).toBe(true);
    } finally {
      rmSync(foreign, { recursive: true, force: true });
    }
  }, 15_000);

  it('sweeps dead legacy temp-dir logs by the same age rule, and only them', async () => {
    await cli('init');
    const oldLegacy = seedLegacyLog('planny-serve-40001.log', 8);
    const youngLegacy = seedLegacyLog('planny-serve-40002.log', 6);
    const nearMiss = seedLegacyLog('planny-serve-extra-9.log', 30);
    // A directory wearing a log's name must be left alone, not crash the sweep.
    const dirTrap = join(dir, 'planny-serve-777.log');
    mkdirSync(dirTrap);
    backdate(dirTrap, 30);
    const result = await cli('serve', '--clean-logs');
    expect(result.code).toBe(0);
    expect(existsSync(oldLegacy)).toBe(false);
    expect(existsSync(youngLegacy)).toBe(true);
    expect(existsSync(nearMiss)).toBe(true);
    expect(existsSync(dirTrap)).toBe(true);
  }, 15_000);

  it('keeps a live server\'s log; stop names the kept log; then it is fair game', async () => {
    await cli('init');
    const started = await cli('serve', '--detach', '--port', '0');
    trackPid(started.stdout);
    expect(started.code).toBe(0);
    const log = join(dir, '.planny', 'serve.log');
    expect(existsSync(log)).toBe(true);
    backdate(log, 30);
    // A legacy log named with the live server's port is protected too.
    const port = Number(/127\.0\.0\.1:(\d+)/.exec(started.stdout)![1]);
    const legacyForLivePort = seedLegacyLog(`planny-serve-${port}.log`, 30);

    const kept = await cli('serve', '--clean-logs');
    expect(kept.code).toBe(0);
    expect(kept.stdout).toMatch(/kept/);
    expect(existsSync(log)).toBe(true);
    expect(existsSync(legacyForLivePort)).toBe(true);

    const stopped = await cli('serve', '--stop');
    expect(stopped.code).toBe(0);
    expect(stopped.stdout).toContain(`log kept at ${log}`);

    // The server may write as it shuts down; backdate again so only
    // liveness, not age, decides this pass.
    backdate(log, 30);
    backdate(legacyForLivePort, 30);
    const second = await cli('serve', '--clean-logs');
    expect(second.code).toBe(0);
    expect(existsSync(log)).toBe(false);
    expect(existsSync(legacyForLivePort)).toBe(false);
  }, 30_000);

  it('nothing to delete is a success that says so', async () => {
    await cli('init');
    const result = await cli('serve', '--clean-logs');
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/no serve logs older than 7 days/);
  }, 15_000);

  it('refuses --clean-logs beside --detach or --stop, and --older-than alone', async () => {
    await cli('init');
    expect((await cli('serve', '--clean-logs', '--detach')).code).toBe(1);
    expect((await cli('serve', '--clean-logs', '--stop')).code).toBe(1);
    const alone = await cli('serve', '--older-than', '3');
    expect(alone.code).toBe(1);
    expect(alone.stderr).toMatch(/--clean-logs/);
  }, 15_000);

  it('rejects a negative or non-numeric age', async () => {
    await cli('init');
    const negative = await cli('serve', '--clean-logs', '--older-than', '-1');
    expect(negative.code).toBe(1);
    expect(negative.stderr).toMatch(/number of days/);
    const wordy = await cli('serve', '--clean-logs', '--older-than', 'soon');
    expect(wordy.code).toBe(1);
    expect(wordy.stderr).toMatch(/number of days/);
  }, 15_000);
});
