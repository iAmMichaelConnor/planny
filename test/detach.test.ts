import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [bin, ...args], { cwd: dir });
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

describe('serve --detach and --stop', () => {
  it('detach outlives the CLI, url finds it, stop ends it and clears the record', async () => {
    await cli('init');
    const started = await cli('serve', '--detach', '--port', '0');
    trackPid(started.stdout);
    expect(started.code).toBe(0);
    const url = /http:\/\/127\.0\.0\.1:\d+/.exec(started.stdout)?.[0];
    expect(url).toBeDefined();
    expect(started.stdout).toMatch(/pid \d+/);
    expect(started.stdout).toMatch(/planny-serve-.*\.log/); // says where output goes
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
});
