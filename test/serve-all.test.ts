import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { currentPageUrl, forwardFlags, probeBoards, startPage } from '../src/serve-all.js';
import { discoverStores } from '../src/discover.js';
import { startServer, type RunningServer } from '../src/server.js';
import { initRepo, openStore } from '../src/store.js';

let dir: string;
let alpha: string;
let beta: string;
let alphaBoard: RunningServer;
let page: RunningServer;
let base: string;

function plan(name: string): string {
  const path = join(dir, name);
  mkdirSync(path, { recursive: true });
  initRepo(path);
  return path;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'planny-boards-'));
  alpha = plan('alpha');
  beta = plan('beta');
  alphaBoard = await startServer(openStore(alpha), 0);
  page = await startPage({ plans: discoverStores([dir]), roots: [dir] }, 0);
  base = `http://127.0.0.1:${page.port}`;
});

afterEach(async () => {
  await page.close();
  await alphaBoard.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('probing the boards', () => {
  it('names every plan and says where its board answers, if it does', async () => {
    expect(await probeBoards(discoverStores([dir]))).toEqual([
      { name: 'alpha', root: alpha, url: `http://127.0.0.1:${alphaBoard.port}` },
      { name: 'beta', root: beta, url: null },
    ]);
  });
});

describe('the boards page', () => {
  it('links every plan that has a board, and says which have none', async () => {
    const html = await (await fetch(base)).text();
    expect(html).toContain(`href="http://127.0.0.1:${alphaBoard.port}"`);
    expect(html).toContain('alpha');
    expect(html).toContain('beta');
    expect(html).toMatch(/beta[\s\S]*not running/);
  });

  it('finds the boards again on every load, so it is never stale', async () => {
    const betaBoard = await startServer(openStore(beta), 0);
    try {
      const html = await (await fetch(base)).text();
      expect(html).toContain(`href="http://127.0.0.1:${betaBoard.port}"`);
      expect(html).not.toContain('not running');
    } finally {
      await betaBoard.close();
    }
  });

  it('answers from its last walk, and walks again after answering', async () => {
    // Walking a home directory can take a second, so a request never waits
    // for one: the page answers from the plans it knew, then looks again.
    await page.close();
    page = await startPage({ plans: discoverStores([dir]), roots: [dir], rescanAfterMs: 0 }, 0);
    base = `http://127.0.0.1:${page.port}`;
    plan('gamma');
    expect(await (await fetch(base)).text()).not.toContain('gamma');
    await new Promise((r) => setTimeout(r, 20));
    expect(await (await fetch(base)).text()).toContain('gamma');
  });

  it('escapes what it prints', async () => {
    await page.close();
    plan('a<b');
    page = await startPage({ plans: discoverStores([dir]), roots: [dir] }, 0);
    base = `http://127.0.0.1:${page.port}`;
    const html = await (await fetch(base)).text();
    expect(html).toContain('a&lt;b');
    expect(html).not.toContain('a<b');
  });

  it('answers /api/boards with the same facts and its own pid', async () => {
    const body = (await (await fetch(`${base}/api/boards`)).json()) as {
      pid: number;
      boards: Array<{ name: string; url: string | null }>;
    };
    expect(body.pid).toBe(process.pid);
    expect(body.boards.map((b) => [b.name, b.url])).toEqual([
      ['alpha', `http://127.0.0.1:${alphaBoard.port}`],
      ['beta', null],
    ]);
  });

  it('has no other routes', async () => {
    expect((await fetch(`${base}/api/state`)).status).toBe(404);
    expect((await fetch(`${base}/api/boards`, { method: 'POST' })).status).toBe(404);
  });

  it('is told apart from a board by the probe', async () => {
    expect(await currentPageUrl(page.port)).toBe(base);
    expect(await currentPageUrl(alphaBoard.port)).toBeNull();
  });
});

describe('the ssh forward', () => {
  it('prints one -L flag per port, ready to paste', () => {
    expect(forwardFlags([5890, 5891])).toBe('-L 5890:127.0.0.1:5890 -L 5891:127.0.0.1:5891');
  });
});
