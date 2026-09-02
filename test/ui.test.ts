// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Smoke test for the static UI: load index.html + app.js into jsdom with a
 * stubbed /api/state, then walk every view and the drawer looking for
 * runtime errors and missing content.
 */

const webDir = join(__dirname, '..', 'web');

const sampleState = {
  store: { root: '/home/me/projects/rocket', name: 'rocket' },
  tasks: [
    task('t1', { name: 'Build the API', blocking: ['t3'], position: 1 }),
    task('t2', {
      name: 'Write tests',
      parent: 't1',
      status: 'in-progress',
      model: 'opus',
      createdBy: 'agent-7',
      history: [{ at: '2026-08-31T12:00:00.000Z', status: 'in-progress', by: 'agent-7' }],
      position: 7, // deliberately not the naive index: proves the client reads it
      holder: 'agent-7',
    }),
    task('t3', { name: 'Deploy', blockedBy: ['t1'], blocked: true, position: 3 }),
    task('t4', {
      name: 'Choose hosting',
      type: 'decision',
      kind: 'operator',
      body: '## Background\n\nWe need a host.\n\n## Proposal\n\nUse **Fly.io**.\n\n- cheap\n- fast',
    }),
    task('t5', { name: 'Old idea', status: 'cancelled', replacedBy: ['t1'] }),
    task('t6', {
      name: 'Settled question',
      type: 'decision',
      status: 'done',
      body: '## Outcome\n\nDone deal.',
      resolvedAt: '2026-08-30T10:00:00.000Z',
    }),
  ],
  progress: { done: 1, total: 5, percent: 20, byStatus: { todo: 3, 'in-progress': 1, done: 1, cancelled: 1 } },
  decisions: [{ id: 't4', blocked: false }],
};

function task(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: `Task ${id}`,
    status: 'todo',
    type: 'task',
    kind: 'ai',
    position: 0,
    priority: Number(id.slice(1)) * 10,
    parent: undefined,
    blockedBy: [],
    replacedBy: [],
    created: '2026-08-31T12:00:00.000Z',
    updated: '2026-08-31T12:00:00.000Z',
    body: '',
    blocked: false,
    blocking: [],
    ...overrides,
  };
}

const fetchCalls: Array<{ path: string; init?: RequestInit }> = [];

// Tests that need their own task graph swap this and trigger a refresh.
let servedState: typeof sampleState = sampleState;

async function serveTasks(tasks: ReturnType<typeof task>[]): Promise<void> {
  servedState = { ...sampleState, tasks, decisions: [] };
  window.dispatchEvent(new Event('focus'));
  await new Promise((r) => setTimeout(r, 5));
}

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onmessage: ((event: { data: string }) => void) | null = null;
  onopen: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  close(): void {}
}

let bootAbort: AbortController | undefined;

/** A reload that keeps what the browser stored — for preference tests. */
function bootAppKeepingPreferences(): Promise<void> {
  return boot(false);
}

function bootApp(): Promise<void> {
  return boot(true);
}

function boot(clearPreferences: boolean): Promise<void> {
  if (clearPreferences) localStorage.clear(); // preferences persist per jsdom origin
  // app.js attaches document/window listeners at boot. The page never boots
  // twice in real life, but each test re-runs it, so stale instances would
  // keep handling events. Route every listener through an abort signal and
  // cut the previous boot's listeners off here.
  bootAbort?.abort();
  bootAbort = new AbortController();
  const signal = bootAbort.signal;
  for (const target of [document, window] as Array<EventTarget & { __plannyAdd?: typeof EventTarget.prototype.addEventListener }>) {
    target.__plannyAdd ??= target.addEventListener.bind(target);
    target.addEventListener = ((
      type: string,
      fn: EventListenerOrEventListenerObject,
      opts?: boolean | AddEventListenerOptions,
    ) => {
      const options = typeof opts === 'boolean' ? { capture: opts } : { ...(opts ?? {}) };
      target.__plannyAdd!(type, fn, { ...options, signal });
    }) as typeof EventTarget.prototype.addEventListener;
  }
  FakeEventSource.instances.length = 0;
  vi.stubGlobal('EventSource', FakeEventSource);
  const html = readFileSync(join(webDir, 'index.html'), 'utf8');
  document.body.innerHTML = /<body>([\s\S]*)<\/body>/.exec(html)![1]!.replace(
    /<script[\s\S]*?<\/script>/,
    '',
  );
  fetchCalls.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, init?: RequestInit) => {
      fetchCalls.push({ path, init });
      return {
        ok: true,
        json: async () =>
          path === '/api/state' ? structuredClone(servedState) : { task: task('t9'), warnings: [] },
      };
    }),
  );
  const code = readFileSync(join(webDir, 'app.js'), 'utf8');
  new Function(code)();
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function clickTab(view: string): void {
  (document.querySelector(`.tab[data-view="${view}"]`) as HTMLElement).click();
}

function expandDecision(id: string): void {
  (
    document.querySelector(
      `#view-decisions [data-action="toggle-decision"][data-id="${id}"]`,
    ) as HTMLElement
  ).click();
}

beforeEach(async () => {
  servedState = sampleState;
  await bootApp();
});

describe('ui smoke', () => {
  it('name/path and progress share a second header row; moon sits left of the tabs', () => {
    const label = document.querySelector('#store-label') as HTMLElement;
    expect(label.textContent).toContain('rocket');
    expect(label.textContent).toContain('/home/me/projects/rocket');
    const sub = label.parentElement as HTMLElement;
    expect(sub.classList.contains('header-sub')).toBe(true); // the row below
    expect(sub.querySelector('#progress-wrap')).not.toBeNull(); // progress lives there too
    const theme = document.querySelector('#theme-btn') as HTMLElement;
    expect(theme.nextElementSibling!.id).toBe('tabs'); // 🌓 directly left of Board
  });

  it('disabled buttons are visibly dimmed by one global rule', () => {
    const css = readFileSync(join(webDir, 'style.css'), 'utf8');
    const rule = /button:disabled\s*{[^}]*}/.exec(css)?.[0];
    expect(rule).toBeDefined();
    expect(rule).toContain('opacity');
    expect(rule).toContain('cursor: not-allowed');
    // The hover affordance must not light up a button that cannot be clicked.
    expect(css).toContain('button:hover:not(:disabled)');
    // One codepath: the old per-view rule is gone.
    expect(css).not.toContain('.decision-priority button:disabled');
  });

  it('the page declares the emoji favicon', () => {
    const html = readFileSync(join(webDir, 'index.html'), 'utf8');
    expect(html).toContain('rel="icon"');
    expect(html).toContain('😎');
  });

  it('the theme button cycles auto → dark → light → auto and persists', () => {
    const btn = document.querySelector('#theme-btn') as HTMLElement;
    expect(document.documentElement.dataset.theme).toBeUndefined();
    btn.click();
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(localStorage.getItem('planny-theme')).toBe('dark');
    btn.click();
    expect(document.documentElement.dataset.theme).toBe('light');
    btn.click();
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  it('cmd+enter (or ctrl+enter) submits the drawer form', () => {
    vi.stubGlobal('confirm', vi.fn(() => true));
    (document.querySelector('#add-btn') as HTMLElement).click();
    (document.querySelector('#add-note-continue') as HTMLElement).click();
    (document.querySelector('#f-name') as HTMLInputElement).value = 'quick add';
    document.querySelector('#f-name')!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }),
    );
    const post = fetchCalls.find((c) => c.path === '/api/tasks' && c.init?.method === 'POST');
    expect(post).toBeDefined();
    expect(JSON.parse(post!.init!.body as string).name).toBe('quick add');
  });

  it('board chips slice the cards by kind and type', () => {
    const chips = document.querySelector('#board-filters')!;
    expect(chips.querySelector('.chip[data-kind="operator"]')).not.toBeNull();
    (chips.querySelector('.chip[data-type="decision"]') as HTMLElement).click();
    const board = document.querySelector('#board-columns')!;
    expect(board.textContent).toContain('Choose hosting'); // the decision
    expect(board.textContent).not.toContain('Build the API'); // plain task filtered out
    (chips.querySelector('.chip[data-type="decision"]') as HTMLElement).click();
    expect(document.querySelector('#board-columns')!.textContent).toContain('Build the API');
  });

  it('in-progress cards wear a holder badge', () => {
    const card = document.querySelector('.card[data-id="t2"]')!;
    expect(card.querySelector('.badge.holder')!.textContent).toBe('agent-7');
    expect(document.querySelector('.card[data-id="t1"] .badge.holder')).toBeNull(); // todo: no holder
  });

  it('renders the board with columns, cards and badges', () => {
    const board = document.querySelector('#view-board')!;
    expect(board.textContent).toContain('Build the API');
    expect(board.textContent).toContain('Cancelled');
    expect(board.querySelector('.card.decision')).not.toBeNull();
    expect(board.textContent).toContain('waits on t1');
    expect(document.querySelector('#progress-text')!.textContent).toContain('20%');
  });

  it('labels active board columns as priority-ordered with card positions', () => {
    const headers = [...document.querySelectorAll('#view-board .column h2')].map(
      (h) => h.textContent,
    );
    expect(headers[0]).toContain('priority order');
    expect(headers[1]).toContain('priority order');
    expect(headers[2]).not.toContain('priority order');
    const cardText = (id: string) =>
      (document.querySelector(`.card[data-id="${id}"]`) as HTMLElement).textContent;
    expect(cardText('t1')).toContain('#1');
    expect(cardText('t2')).toContain('#7'); // served value, not a client-side recount
    expect(cardText('t3')).toContain('#3');
    expect(cardText('t6')).not.toContain('#'); // done cards carry no position
  });

  it('renders the tree with nesting and progress; done is hidden by default', () => {
    clickTab('tree');
    const tree = document.querySelector('#tree-list')!;
    expect(tree.querySelector('.tree-children')!.textContent).toContain('Write tests');
    expect(tree.querySelector('.mini-progress')).not.toBeNull();
    expect(tree.textContent).not.toContain('Settled question'); // done, hidden by default
    const doneChip = document.querySelector(
      '#tree-filters .chip[data-status="done"]',
    ) as HTMLElement;
    expect(doneChip.classList.contains('active')).toBe(false);
    doneChip.click();
    expect(document.querySelector('#tree-list')!.textContent).toContain('Settled question');
  });

  it('tree kind and type chips slice the tree', () => {
    clickTab('tree');
    (document.querySelector('#tree-filters .chip[data-kind="operator"]') as HTMLElement).click();
    const tree = document.querySelector('#tree-list')!;
    expect(tree.textContent).toContain('Choose hosting'); // operator decision
    expect(tree.textContent).not.toContain('Deploy'); // ai task, no matching descendant
    (document.querySelector('#tree-filters .chip[data-kind="operator"]') as HTMLElement).click();
    expect(document.querySelector('#tree-list')!.textContent).toContain('Deploy');
  });

  it('the deps view also starts with done inactive', () => {
    clickTab('deps');
    const doneChip = document.querySelector(
      '#deps-status .chip[data-status="done"]',
    ) as HTMLElement;
    expect(doneChip.classList.contains('active')).toBe(false);
  });

  it('renders the dependency graph as SVG nodes and edges', () => {
    clickTab('deps');
    const svg = document.querySelector('#deps-svg')!;
    expect(svg.querySelectorAll('.dep-node').length).toBe(2); // t1 and t3
    expect(svg.querySelectorAll('.dep-edge').length).toBe(1);
  });

  it('colour-codes status consistently across board, deps and drawer', () => {
    const card = (id: string) => document.querySelector(`.card[data-id="${id}"]`) as HTMLElement;
    expect(card('t1').classList.contains('st-todo')).toBe(true);
    expect(card('t2').classList.contains('st-in-progress')).toBe(true);
    expect(card('t5').classList.contains('st-cancelled')).toBe(true);
    expect(document.querySelector('#view-board .column h2 .status-dot')).not.toBeNull();

    clickTab('deps');
    const bar = document.querySelector('.dep-node[data-id="t1"] .statusbar') as SVGRectElement;
    expect(bar).not.toBeNull();
    expect(bar.classList.contains('todo')).toBe(true);
    // one dot per status: todo, in-progress, parked, done, cancelled
    expect(document.querySelectorAll('#view-deps .legend .status-dot').length).toBe(5);

    card('t1').click();
    expect(document.querySelector('#drawer-title .status-dot')).not.toBeNull();
  });

  it('filters the dependency graph by status chips', () => {
    clickTab('deps');
    expect(document.querySelectorAll('#deps-status .chip').length).toBe(5);
    expect(document.querySelectorAll('#deps-svg .dep-node').length).toBe(2);
    (document.querySelector('#deps-status .chip[data-status="todo"]') as HTMLElement).click();
    // t1 and t3 are both todo, so nothing with an edge remains.
    expect(document.querySelector('#deps-svg .dep-node')).toBeNull();
    expect(document.querySelector('#deps-scroll')!.textContent).toMatch(/no dependencies/i);
  });

  it('annotates every arrow and can flip the perspective', () => {
    clickTab('deps');
    const nodeX = (id: string): number =>
      Number(/translate\((\d+(?:\.\d+)?),/.exec(
        (document.querySelector(`.dep-node[data-id="${id}"]`) as SVGGElement).getAttribute('transform')!,
      )![1]);
    expect(document.querySelector('#deps-svg .dep-label')!.textContent).toBe('blocks');
    expect(nodeX('t1')).toBeLessThan(nodeX('t3')); // blocker left

    const mode = document.querySelector('#deps-mode') as HTMLSelectElement;
    mode.value = 'blocked-by';
    mode.dispatchEvent(new Event('change'));
    expect(document.querySelector('#deps-svg .dep-label')!.textContent).toBe('is blocked by');
    expect(nodeX('t3')).toBeLessThan(nodeX('t1')); // blocked task left now
    expect(document.querySelector('#view-deps .hint')!.textContent).toMatch(/is blocked by/);
  });

  it('says which way the arrows point, on the hint and on every edge', () => {
    clickTab('deps');
    const hint = document.querySelector('#view-deps .hint')!;
    expect(hint.textContent).toMatch(/A → B/);
    expect(hint.textContent).toMatch(/waits on A/);
    const edgeTitle = document.querySelector('#deps-svg .dep-edge title')!;
    expect(edgeTitle.textContent).toBe('t1 blocks t3 — t3 waits on t1');
  });

  it('search by bare number opens the task in the drawer and highlights its card', () => {
    const input = document.querySelector('#search') as HTMLInputElement;
    input.value = '3';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(document.querySelector('#drawer')!.classList.contains('hidden')).toBe(false);
    expect((document.querySelector('#f-name') as HTMLInputElement).value).toBe('Deploy');
    expect(document.querySelector('.card[data-id="t3"]')!.classList.contains('is-selected')).toBe(
      true,
    );
  });

  it('clicking a card highlights it and the highlight follows the selection', () => {
    (document.querySelector('.card[data-id="t1"]') as HTMLElement).click();
    expect(document.querySelector('.card[data-id="t1"]')!.classList.contains('is-selected')).toBe(
      true,
    );
    (document.querySelector('.card[data-id="t2"]') as HTMLElement).click();
    expect(document.querySelector('.card[data-id="t1"]')!.classList.contains('is-selected')).toBe(
      false,
    );
    expect(document.querySelector('.card[data-id="t2"]')!.classList.contains('is-selected')).toBe(
      true,
    );
  });

  it('searching an open decision in the decisions view expands and highlights its tile', () => {
    clickTab('decisions');
    const input = document.querySelector('#search') as HTMLInputElement;
    input.value = 't4';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    const tile = document.querySelector(
      '#view-decisions .decision-card[data-id="t4"]',
    ) as HTMLElement;
    expect(tile.classList.contains('collapsed')).toBe(false);
    expect(tile.classList.contains('is-selected')).toBe(true);
  });

  it('typing words lists matching tasks; Enter opens the first', () => {
    const input = document.querySelector('#search') as HTMLInputElement;
    input.value = 'write tests';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const results = document.querySelector('#search-results') as HTMLElement;
    expect(results.hidden).toBe(false);
    const rows = results.querySelectorAll('[data-search-goto]');
    expect(rows).toHaveLength(1); // only t2 "Write tests" matches both words
    expect(rows[0]!.getAttribute('data-search-goto')).toBe('t2');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(document.querySelector('#drawer-title')!.textContent).toContain('t2');
    expect((document.querySelector('#search-results') as HTMLElement).hidden).toBe(true);
  });

  it('body words match too, ranked below name matches', () => {
    const input = document.querySelector('#search') as HTMLInputElement;
    input.value = 'host'; // t4's name "Choose hosting" and t4's body both carry it
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const rows = [...document.querySelectorAll('#search-results [data-search-goto]')];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.getAttribute('data-search-goto')).toBe('t4'); // name hit ranks first
  });

  it('clicking a result opens that task and closes the panel', () => {
    const input = document.querySelector('#search') as HTMLInputElement;
    input.value = 'deploy';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    (document.querySelector('#search-results [data-search-goto="t3"]') as HTMLElement).click();
    expect(document.querySelector('#drawer-title')!.textContent).toContain('t3');
    expect((document.querySelector('#search-results') as HTMLElement).hidden).toBe(true);
  });

  it('no word matches shows an empty note; Escape closes the panel', () => {
    const input = document.querySelector('#search') as HTMLInputElement;
    input.value = 'zebra flotilla';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const results = document.querySelector('#search-results') as HTMLElement;
    expect(results.hidden).toBe(false);
    expect(results.textContent).toMatch(/no tasks match/i);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(results.hidden).toBe(true);
  });

  it('an unknown id warns and opens nothing', () => {
    const input = document.querySelector('#search') as HTMLInputElement;
    input.value = 't99';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(document.querySelector('#drawer')!.classList.contains('hidden')).toBe(true);
    expect(document.querySelector('#toasts')!.textContent).toContain('t99');
  });

  it('decision tiles start collapsed and expand on click', async () => {
    clickTab('decisions');
    const tile = () => document.querySelector('#view-decisions .decision-card') as HTMLElement;
    expect(tile().classList.contains('collapsed')).toBe(true);
    expect(tile().textContent).toContain('Choose hosting'); // the header still names it
    expect(tile().querySelector('.decision-body')).toBeNull(); // no body while collapsed
    expect(tile().querySelector('button[data-action="accept"]')).toBeNull(); // no actions either

    expandDecision('t4');
    expect(tile().classList.contains('collapsed')).toBe(false);
    expect(tile().querySelector('.decision-body strong')!.textContent).toBe('Fly.io');

    // A background refresh must not snap the tile shut.
    window.dispatchEvent(new Event('focus'));
    await new Promise((r) => setTimeout(r, 5));
    expect(tile().classList.contains('collapsed')).toBe(false);

    expandDecision('t4'); // a second click collapses again
    expect(tile().classList.contains('collapsed')).toBe(true);
    expect(tile().querySelector('.decision-body')).toBeNull();
  });

  it('the whole tile toggles, except interactive controls', () => {
    clickTab('decisions');
    const tile = () => document.querySelector('#view-decisions .decision-card') as HTMLElement;
    tile().click(); // anywhere on the tile, not just the header
    expect(tile().classList.contains('collapsed')).toBe(false);

    // The typing target must not collapse the tile.
    (
      document.querySelector('textarea[data-role="response"][data-id="t4"]') as HTMLElement
    ).click();
    expect(tile().classList.contains('collapsed')).toBe(false);

    // A button inside the tile acts without also toggling it.
    vi.stubGlobal('prompt', vi.fn(() => ''));
    (document.querySelector('button[data-action="park"][data-id="t4"]') as HTMLElement).click();
    expect(fetchCalls.some((c) => c.path === '/api/tasks/t4/status')).toBe(true);
    expect(tile().classList.contains('collapsed')).toBe(false);
  });

  it('a bump that stopped short says so, so the button never looks dead', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true));
    vi.stubGlobal(
      'fetch',
      vi.fn(async (path: string, init?: RequestInit) => {
        fetchCalls.push({ path, init });
        if (path.endsWith('/bump')) {
          return {
            ok: true,
            json: async () => ({
              task: task('t4'),
              warnings: ['t4 stopped at position 2 of 9. t7 waits on it, and a task never ranks below a task that waits on it.'],
            }),
          };
        }
        return { ok: true, json: async () => structuredClone(servedState) };
      }),
    );
    clickTab('decisions');
    expandDecision('t4');
    (
      document.querySelector(
        '.decision-priority button[data-action="bottom"][data-id="t4"]',
      ) as HTMLElement
    ).click();
    await new Promise((r) => setTimeout(r, 5));
    const warned = document.querySelector('#toasts .toast.warn') as HTMLElement;
    expect(warned).not.toBeNull();
    expect(warned.textContent).toContain('stopped at position 2 of 9');
    expect(warned.textContent).toContain('t7');
  });

  it('an expanded decision tile offers priority controls that post bumps', () => {
    vi.stubGlobal('confirm', vi.fn(() => true));
    clickTab('decisions');
    expandDecision('t4');
    const tile = () =>
      document.querySelector('#view-decisions .decision-card[data-id="t4"]') as HTMLElement;
    const bumped = (target: unknown) =>
      fetchCalls.some(
        (c) =>
          c.path === '/api/tasks/t4/bump' &&
          JSON.parse(c.init!.body as string).target === target,
      );

    (tile().querySelector('button[data-action="top"]') as HTMLElement).click();
    expect(bumped('top')).toBe(true);
    (tile().querySelector('button[data-action="bottom"]') as HTMLElement).click();
    expect(bumped('bottom')).toBe(true);
    const input = tile().querySelector('input[data-role="pos-input"]') as HTMLInputElement;
    input.value = '2';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    (tile().querySelector('button[data-action="set-pos"]') as HTMLElement).click();
    expect(bumped(2)).toBe(true);
  });

  it('set stays disabled until the position number actually changes', () => {
    clickTab('decisions');
    expandDecision('t4');
    const tile = () =>
      document.querySelector('#view-decisions .decision-card[data-id="t4"]') as HTMLElement;
    const setBtn = () => tile().querySelector('button[data-action="set-pos"]') as HTMLButtonElement;
    const input = () => tile().querySelector('input[data-role="pos-input"]') as HTMLInputElement;

    expect(setBtn().disabled).toBe(true); // untouched: nothing to set
    input().value = '2';
    input().dispatchEvent(new Event('input', { bubbles: true }));
    expect(setBtn().disabled).toBe(false); // modified: now clickable
    input().value = '';
    input().dispatchEvent(new Event('input', { bubbles: true }));
    expect(setBtn().disabled).toBe(true); // back to the original: disabled again
  });

  it('park explains the question stays open, and cancel closes the decision', () => {
    vi.stubGlobal('confirm', vi.fn(() => true));
    clickTab('decisions');
    expandDecision('t4');
    const tile = () =>
      document.querySelector('#view-decisions .decision-card[data-id="t4"]') as HTMLElement;
    const park = tile().querySelector('button[data-action="park"]') as HTMLElement;
    expect(park.title).toMatch(/stays open/i);

    (tile().querySelector('button[data-action="cancel-decision"]') as HTMLElement).click();
    const call = fetchCalls.find((c) => c.path === '/api/tasks/t4/status');
    expect(call).toBeDefined();
    expect(JSON.parse(call!.init!.body as string).status).toBe('cancelled');
  });

  it('renders open and resolved decisions with markdown bodies', () => {
    clickTab('decisions');
    expandDecision('t4');
    const view = document.querySelector('#view-decisions')!;
    expect(view.textContent).toContain('Choose hosting');
    expect(view.querySelector('.decision-body strong')!.textContent).toBe('Fly.io');
    expect(view.textContent).toContain('1 resolved decision');
    expect(view.textContent).toContain('Done deal.');
  });

  it('opens the drawer from a card and saves an edit via PATCH', () => {
    (document.querySelector('.card[data-id="t1"]') as HTMLElement).click();
    expect(document.querySelector('#drawer')!.classList.contains('hidden')).toBe(false);
    const name = document.querySelector('#f-name') as HTMLInputElement;
    name.value = 'Renamed';
    name.dispatchEvent(new Event('input', { bubbles: true }));
    (document.querySelector('#save-btn') as HTMLElement).click();
    const patch = fetchCalls.find((c) => c.path === '/api/tasks/t1');
    expect(patch).toBeDefined();
    expect(patch!.init!.method).toBe('PATCH');
    expect(JSON.parse(patch!.init!.body as string).name).toBe('Renamed');
  });

  it('parking a decision writes the status, so the choice survives a reload', () => {
    vi.stubGlobal('prompt', vi.fn(() => ''));
    clickTab('decisions');
    expandDecision('t4');
    (document.querySelector('button[data-action="park"][data-id="t4"]') as HTMLElement).click();
    const call = fetchCalls.find((c) => c.path === '/api/tasks/t4/status');
    expect(JSON.parse(call!.init!.body as string)).toEqual({ status: 'parked' });
  });

  it('accepting a decision posts a resolve', () => {
    clickTab('decisions');
    expandDecision('t4');
    (document.querySelector('button[data-action="accept"][data-id="t4"]') as HTMLElement).click();
    const resolve = fetchCalls.find((c) => c.path === '/api/tasks/t4/resolve');
    expect(resolve).toBeDefined();
    expect(JSON.parse(resolve!.init!.body as string).response).toContain('Accepted');
  });

  it('a lock-contention error is retried once automatically', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true));
    let attempts = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (path: string, init?: RequestInit) => {
        fetchCalls.push({ path, init });
        if (path.includes('/status') && init?.method === 'POST') {
          attempts += 1;
          if (attempts === 1) {
            return {
              ok: false,
              json: async () => ({ error: 'the store is locked by another planny process — retry' }),
            };
          }
        }
        return {
          ok: true,
          json: async () =>
            path === '/api/state' ? structuredClone(sampleState) : { task: task('t9'), warnings: [] },
        };
      }),
    );
    (document.querySelector('button[data-action="start"][data-id="t1"]') as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 400));
    expect(attempts).toBe(2); // failed once, retried, succeeded
    expect(document.querySelector('#toasts')!.textContent).not.toMatch(/locked/);
  });

  it('quick actions on cards confirm first, then post status and bump', () => {
    const declined = vi.fn(() => false);
    vi.stubGlobal('confirm', declined);
    (document.querySelector('button[data-action="start"][data-id="t1"]') as HTMLElement).click();
    expect(declined).toHaveBeenCalledOnce();
    expect(fetchCalls.some((c) => c.path === '/api/tasks/t1/status')).toBe(false);

    vi.stubGlobal('confirm', vi.fn(() => true));
    (document.querySelector('button[data-action="start"][data-id="t1"]') as HTMLElement).click();
    expect(fetchCalls.some((c) => c.path === '/api/tasks/t1/status')).toBe(true);
    (document.querySelector('button[data-action="top"][data-id="t3"]') as HTMLElement).click();
    expect(fetchCalls.some((c) => c.path === '/api/tasks/t3/bump')).toBe(true);
  });

  it('drawer status buttons confirm first', () => {
    (document.querySelector('.card[data-id="t1"]') as HTMLElement).click();
    vi.stubGlobal('confirm', vi.fn(() => false));
    (document.querySelector('#drawer-body button[data-status="done"]') as HTMLElement).click();
    expect(fetchCalls.some((c) => c.path === '/api/tasks/t1/status')).toBe(false);
    vi.stubGlobal('confirm', vi.fn(() => true));
    (document.querySelector('#drawer-body button[data-status="done"]') as HTMLElement).click();
    expect(fetchCalls.some((c) => c.path === '/api/tasks/t1/status')).toBe(true);
  });

  it('the set button sits directly beside the position input', () => {
    (document.querySelector('.card[data-id="t1"]') as HTMLElement).click();
    const input = document.querySelector('#f-position') as HTMLElement;
    expect(input.nextElementSibling?.id).toBe('set-position');
  });

  it('side-docked drawers start below the header; the bottom dock does not', () => {
    const header = document.querySelector('header') as HTMLElement;
    Object.defineProperty(header, 'offsetHeight', { configurable: true, value: 64 });
    (document.querySelector('.card[data-id="t1"]') as HTMLElement).click();
    const drawer = document.querySelector('#drawer') as HTMLElement;

    (document.querySelector('.dock-btn[data-dock="right"]') as HTMLElement).click();
    expect(drawer.style.top).toBe('64px');
    (document.querySelector('.dock-btn[data-dock="left"]') as HTMLElement).click();
    expect(drawer.style.top).toBe('64px');
    (document.querySelector('.dock-btn[data-dock="bottom"]') as HTMLElement).click();
    expect(drawer.style.top).toBe('');
  });

  it('refreshes when the event stream reconnects and when the tab becomes visible', async () => {
    const stateCalls = () => fetchCalls.filter((c) => c.path === '/api/state').length;
    const before = stateCalls();
    FakeEventSource.instances[0]!.onopen!(); // simulates a reconnect after a server restart
    await new Promise((r) => setTimeout(r, 5));
    expect(stateCalls()).toBe(before + 1);
    document.dispatchEvent(new Event('visibilitychange'));
    await new Promise((r) => setTimeout(r, 5));
    expect(stateCalls()).toBe(before + 2);
  });

  it('connects an event stream and refreshes when it fires', async () => {
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0]!.url).toBe('/api/events');
    const before = fetchCalls.filter((c) => c.path === '/api/state').length;
    FakeEventSource.instances[0]!.onmessage!({ data: 'changed' });
    await new Promise((r) => setTimeout(r, 5));
    expect(fetchCalls.filter((c) => c.path === '/api/state').length).toBe(before + 1);
  });

  it('a background refresh keeps unsaved drawer edits', async () => {
    (document.querySelector('.card[data-id="t1"]') as HTMLElement).click();
    const desc = document.querySelector('#f-desc') as HTMLTextAreaElement;
    desc.value = 'half-typed thought';
    desc.dispatchEvent(new Event('input', { bubbles: true }));
    window.dispatchEvent(new Event('focus'));
    await new Promise((r) => setTimeout(r, 5));
    expect((document.querySelector('#f-desc') as HTMLTextAreaElement).value).toBe(
      'half-typed thought',
    );
  });

  it('a background refresh keeps decision drafts and focus', async () => {
    clickTab('decisions');
    expandDecision('t4');
    const draft = () =>
      document.querySelector('textarea[data-role="response"][data-id="t4"]') as HTMLTextAreaElement;
    draft().value = 'leaning towards yes';
    draft().dispatchEvent(new Event('input', { bubbles: true }));
    draft().focus();
    window.dispatchEvent(new Event('focus'));
    await new Promise((r) => setTimeout(r, 5));
    expect(draft().value).toBe('leaning towards yes');
    expect(document.activeElement).toBe(draft());
  });

  it('progress sits next to the path on the sub-row, not pushed apart', () => {
    const label = document.querySelector('#store-label') as HTMLElement;
    expect(label.nextElementSibling!.id).toBe('progress-wrap');
    const sub = label.parentElement as HTMLElement;
    expect(sub.classList.contains('spread')).toBe(false); // adjacency, not space-between
  });

  it('an empty in-progress column tells the operator to prompt their AI', () => {
    // Filter to decisions only: t2 (a task) leaves the in-progress column empty.
    (document.querySelector('#board-filters .chip[data-type="decision"]') as HTMLElement).click();
    const board = document.querySelector('#board-columns')!;
    expect(board.textContent).toMatch(/do more tasks/i);
    expect(board.textContent).toMatch(/planny skill/i);
  });

  it('the drawer shows the absolute file path', () => {
    (document.querySelector('.card[data-id="t1"]') as HTMLElement).click();
    expect(document.querySelector('#drawer-body .file-path')!.textContent).toBe(
      '/home/me/projects/rocket/.planny/tasks/t1.md',
    );
  });

  it('a description-only edit enables save and PATCHes the new body', () => {
    (document.querySelector('.card[data-id="t1"]') as HTMLElement).click();
    const desc = document.querySelector('#f-desc') as HTMLTextAreaElement;
    desc.value = 'rewritten body';
    desc.dispatchEvent(new Event('input', { bubbles: true }));
    const save = document.querySelector('#save-btn') as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    save.click();
    const patch = fetchCalls.find((c) => c.path === '/api/tasks/t1' && c.init?.method === 'PATCH');
    expect(patch).toBeDefined();
    expect(JSON.parse(patch!.init!.body as string).body).toBe('rewritten body');
  });

  it('save is disabled until an edit is typed', () => {
    (document.querySelector('.card[data-id="t1"]') as HTMLElement).click();
    const save = document.querySelector('#save-btn') as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    const name = document.querySelector('#f-name') as HTMLInputElement;
    name.value = 'x';
    name.dispatchEvent(new Event('input', { bubbles: true }));
    expect(save.disabled).toBe(false);
  });

  it('Enter on the add-task note means continue', () => {
    (document.querySelector('#add-btn') as HTMLElement).click();
    expect(document.querySelector('#add-note')!.classList.contains('hidden')).toBe(false);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(document.querySelector('#add-note')!.classList.contains('hidden')).toBe(true);
    expect(document.querySelector('#drawer')!.classList.contains('hidden')).toBe(false);
  });

  it('the drawer offers an add-child button that prefills the parent', () => {
    (document.querySelector('.card[data-id="t1"]') as HTMLElement).click();
    (document.querySelector('#add-child-btn') as HTMLElement).click();
    expect(document.querySelector('#drawer-title')!.textContent).toContain('New task');
    expect((document.querySelector('#f-parent') as HTMLInputElement).value).toBe('t1');
  });

  it('the expand toggle is not a tab stop', () => {
    (document.querySelector('.card[data-id="t1"]') as HTMLElement).click();
    expect((document.querySelector('#desc-toggle') as HTMLElement).getAttribute('tabindex')).toBe('-1');
  });

  it('parent offers a picker alongside the text input', () => {
    (document.querySelector('.card[data-id="t3"]') as HTMLElement).click();
    const parentPick = document.querySelector('#f-parent-pick') as HTMLSelectElement;
    expect(parentPick).not.toBeNull();
    parentPick.value = 't1';
    parentPick.dispatchEvent(new Event('change', { bubbles: true }));
    expect((document.querySelector('#f-parent') as HTMLInputElement).value).toBe('t1');
  });

  it('waits-on is one input whose menu opens on focus and truly multi-toggles', () => {
    (document.querySelector('.card[data-id="t3"]') as HTMLElement).click();
    expect(document.querySelector('#f-blocked-pick')).toBeNull(); // the second box is gone
    const input = document.querySelector('#f-blocked-by') as HTMLInputElement;
    const menu = document.querySelector('#blocked-menu') as HTMLElement;
    expect(menu.hidden).toBe(true);
    input.dispatchEvent(new Event('focus'));
    expect(menu.hidden).toBe(false);

    const boxT1 = menu.querySelector('input[value="t1"]') as HTMLInputElement;
    expect(boxT1.checked).toBe(true); // reflects the existing blocker
    const boxT2 = menu.querySelector('input[value="t2"]') as HTMLInputElement;
    boxT2.checked = true;
    boxT2.dispatchEvent(new Event('change', { bubbles: true }));
    expect(input.value).toContain('t1');
    expect(input.value).toContain('t2'); // clicking another adds, comma-separated

    boxT1.checked = false;
    boxT1.dispatchEvent(new Event('change', { bubbles: true }));
    expect(input.value).not.toContain('t1'); // unclicking removes
    expect(input.value).toContain('t2');

    (document.querySelector('main') as HTMLElement).click();
    expect(menu.hidden).toBe(true); // clicking elsewhere closes the menu
  });

  it('an edited form says "changes not saved" until save is clicked', () => {
    (document.querySelector('.card[data-id="t1"]') as HTMLElement).click();
    const note = document.querySelector('#unsaved-note') as HTMLElement;
    expect(note.hidden).toBe(true);
    const name = document.querySelector('#f-name') as HTMLInputElement;
    name.value = 'edited';
    name.dispatchEvent(new Event('input', { bubbles: true }));
    expect(note.hidden).toBe(false);
    expect(note.textContent).toMatch(/changes not saved/i);
    (document.querySelector('#save-btn') as HTMLElement).click();
    expect((document.querySelector('#unsaved-note') as HTMLElement).hidden).toBe(true);
  });

  it('the quoted Do-this copy button sits beside the title', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    (document.querySelector('.card[data-id="t3"]') as HTMLElement).click();
    const title = document.querySelector('#drawer-title') as HTMLElement;
    expect(title.textContent).toContain('"Do t3"'); // quoted, alongside the title
    const button = title.querySelector('#copy-do') as HTMLElement;
    expect(button.title).toMatch(/lazy/i);
    button.click();
    await new Promise((r) => setTimeout(r, 5));
    expect(writeText).toHaveBeenCalledWith('Do t3');
  });

  it('offers the Do-this copy only on todo tasks', () => {
    (document.querySelector('.card[data-id="t2"]') as HTMLElement).click(); // in-progress
    let title = document.querySelector('#drawer-title') as HTMLElement;
    expect(title.textContent).not.toContain('"Do t2"'); // an agent already has it
    expect(title.querySelector('#copy-do')).toBeNull();

    (document.querySelector('.card[data-id="t6"]') as HTMLElement).click(); // done
    title = document.querySelector('#drawer-title') as HTMLElement;
    expect(title.querySelector('#copy-do')).toBeNull();

    (document.querySelector('.card[data-id="t5"]') as HTMLElement).click(); // cancelled
    title = document.querySelector('#drawer-title') as HTMLElement;
    expect(title.querySelector('#copy-do')).toBeNull();
  });

  it('kind is a single select of known kinds with a custom escape hatch', () => {
    (document.querySelector('.card[data-id="t1"]') as HTMLElement).click();
    const select = document.querySelector('#f-kind') as HTMLSelectElement;
    expect(select.tagName).toBe('SELECT');
    const values = [...select.options].map((o) => o.value);
    expect(values).toContain('ai');
    expect(values).toContain('operator');
    expect(values).toContain('__custom');
    select.value = '__custom';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    const replaced = document.querySelector('#f-kind') as HTMLElement;
    expect(replaced.tagName).toBe('INPUT'); // free-form entry for a new kind
  });

  it('puts the resolve box directly below the description for open decisions', () => {
    (document.querySelector('.card[data-id="t4"]') as HTMLElement).click();
    const html = (document.querySelector('#drawer-body') as HTMLElement).innerHTML;
    expect(html.indexOf('f-resolution')).toBeGreaterThan(-1);
    expect(html.indexOf('f-desc')).toBeLessThan(html.indexOf('f-resolution'));
    expect(html.indexOf('f-resolution')).toBeLessThan(html.indexOf('f-type'));
  });

  it('clicking a waits-on chip id opens that blocker in the drawer', () => {
    const chipLink = document.querySelector(
      '.card[data-id="t3"] [data-goto-task="t1"]',
    ) as HTMLElement;
    expect(chipLink).not.toBeNull();
    chipLink.click();
    expect(document.querySelector('#drawer-title')!.textContent).toContain('t1');
  });

  it('the drawer left edge drags to resize', () => {
    (document.querySelector('.card[data-id="t1"]') as HTMLElement).click();
    const handle = document.querySelector('#drawer-resize') as HTMLElement;
    expect(handle).not.toBeNull();
    handle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 800 }));
    document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 600 }));
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    const drawer = document.querySelector('#drawer') as HTMLElement;
    expect(drawer.style.width).toBe(`${window.innerWidth - 600}px`);
  });

  it('the description opens expanded by default; the toggle collapses and re-expands', () => {
    (document.querySelector('.card[data-id="t1"]') as HTMLElement).click();
    const textarea = document.querySelector('#f-desc') as HTMLTextAreaElement;
    expect(textarea.classList.contains('expanded')).toBe(true); // default
    Object.defineProperty(textarea, 'scrollHeight', { configurable: true, value: 1500 });
    textarea.value = 'unsaved edit';
    const toggle = document.querySelector('#desc-toggle') as HTMLElement;
    toggle.click();
    expect(textarea.classList.contains('expanded')).toBe(false);
    expect(textarea.style.height).toBe(''); // compact height again
    toggle.click();
    expect(textarea.classList.contains('expanded')).toBe(true);
    expect(textarea.style.height).toBe('1500px'); // sized to the full content
    expect(textarea.value).toBe('unsaved edit');
  });

  it('the drawer shows who created and who started the task', () => {
    (document.querySelector('.card[data-id="t2"]') as HTMLElement).click();
    const list = document.querySelector('#drawer-body .activity-list')!.textContent!;
    expect(list).toContain('created by agent-7');
    expect(list).toMatch(/in-progress by agent-7/);
  });

  it('has no For you chip (removed by operator preference)', () => {
    expect(document.querySelector('#operator-chip')).toBeNull();
  });

  it('drawer top/bottom bumps ask for confirmation first', () => {
    // t3 sits at position 3: its top bump is live (t1's would be disabled).
    (document.querySelector('.card[data-id="t3"]') as HTMLElement).click();
    const declined = vi.fn(() => false);
    vi.stubGlobal('confirm', declined);
    (document.querySelector('button[data-bump="top"]') as HTMLElement).click();
    expect(declined).toHaveBeenCalledOnce();
    expect(fetchCalls.some((c) => c.path === '/api/tasks/t3/bump')).toBe(false);

    vi.stubGlobal('confirm', vi.fn(() => true));
    (document.querySelector('button[data-bump="top"]') as HTMLElement).click();
    expect(fetchCalls.some((c) => c.path === '/api/tasks/t3/bump')).toBe(true);
  });

  it('the drawer docks left, bottom and back right, and remembers the choice', () => {
    (document.querySelector('.card[data-id="t1"]') as HTMLElement).click();
    const drawer = document.querySelector('#drawer') as HTMLElement;

    (document.querySelector('.dock-btn[data-dock="left"]') as HTMLElement).click();
    expect(drawer.classList.contains('dock-left')).toBe(true);

    (document.querySelector('.dock-btn[data-dock="bottom"]') as HTMLElement).click();
    expect(drawer.classList.contains('dock-bottom')).toBe(true);
    expect(drawer.classList.contains('dock-left')).toBe(false);
    expect(localStorage.getItem('planny-drawer-dock')).toBe('bottom');

    // Bottom dock: the handle resizes height, not width.
    const handle = document.querySelector('#drawer-resize') as HTMLElement;
    handle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientY: 500 }));
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    expect(drawer.style.height).toBe(`${window.innerHeight - 500}px`);
    expect(drawer.style.width).toBe('');

    (document.querySelector('.dock-btn[data-dock="right"]') as HTMLElement).click();
    expect(drawer.classList.contains('dock-bottom')).toBe(false);
    expect(drawer.style.height).toBe(''); // dragged size cleared on dock switch
  });

  it('clicking off the drawer closes it; unsaved edits ask first', async () => {
    (document.querySelector('.card[data-id="t1"]') as HTMLElement).click();
    const drawer = document.querySelector('#drawer')!;
    expect(drawer.classList.contains('hidden')).toBe(false);
    (document.querySelector('main') as HTMLElement).click();
    expect(drawer.classList.contains('hidden')).toBe(true);

    (document.querySelector('.card[data-id="t1"]') as HTMLElement).click();
    const desc = document.querySelector('#f-desc') as HTMLTextAreaElement;
    desc.value = 'precious edit';
    desc.dispatchEvent(new Event('input', { bubbles: true }));
    vi.stubGlobal('confirm', vi.fn(() => false));
    (document.querySelector('main') as HTMLElement).click();
    expect(drawer.classList.contains('hidden')).toBe(false); // decline keeps it open
    vi.stubGlobal('confirm', vi.fn(() => true));
    (document.querySelector('main') as HTMLElement).click();
    expect(drawer.classList.contains('hidden')).toBe(true);
  });

  it('the add-task button shows the token-saving note, then opens the form', () => {
    (document.querySelector('#add-btn') as HTMLElement).click();
    const note = document.querySelector('#add-note')!;
    expect(note.classList.contains('hidden')).toBe(false);
    expect(note.textContent).toMatch(/token/i); // explains why the button is good
    expect(document.querySelector('#drawer')!.classList.contains('hidden')).toBe(true);
    (document.querySelector('#add-note-continue') as HTMLElement).click();
    expect(note.classList.contains('hidden')).toBe(true);
    expect(document.querySelector('#drawer')!.classList.contains('hidden')).toBe(false);
  });

  it("don't-show-again persists and skips the note next time", () => {
    (document.querySelector('#add-btn') as HTMLElement).click();
    (document.querySelector('#add-note-dismiss') as HTMLElement).click();
    expect(document.querySelector('#drawer')!.classList.contains('hidden')).toBe(false);
    expect(localStorage.getItem('planny-add-note-dismissed')).toBe('1');
    (document.querySelector('#drawer-close') as HTMLElement).click();
    (document.querySelector('#add-btn') as HTMLElement).click();
    expect(document.querySelector('#add-note')!.classList.contains('hidden')).toBe(true);
    expect(document.querySelector('#drawer')!.classList.contains('hidden')).toBe(false);
  });

  it('the new-task drawer creates via POST', () => {
    (document.querySelector('#add-btn') as HTMLElement).click();
    (document.querySelector('#add-note-continue') as HTMLElement).click();
    (document.querySelector('#f-name') as HTMLInputElement).value = 'Brand new';
    (document.querySelector('#save-btn') as HTMLElement).click();
    const post = fetchCalls.find((c) => c.path === '/api/tasks' && c.init?.method === 'POST');
    expect(post).toBeDefined();
    expect(JSON.parse(post!.init!.body as string).name).toBe('Brand new');
  });
});

function treeRow(id: string): HTMLElement {
  return document.querySelector(`#tree-list .tree-row[data-id="${id}"]`) as HTMLElement;
}

function hover(el: HTMLElement): void {
  el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
}

function hoverPaths(): SVGPathElement[] {
  return [...document.querySelectorAll('#dep-hover-svg path')] as SVGPathElement[];
}

// t1 blocks t2 blocks t3: a two-hop chain for multi-level hover lines.
const chainTasks = [
  task('t1', { name: 'Root blocker', blocking: ['t2'], position: 1 }),
  task('t2', { name: 'Middle', blockedBy: ['t1'], blocked: true, blocking: ['t3'], position: 2 }),
  task('t3', { name: 'Leaf', blockedBy: ['t2'], blocked: true, position: 3 }),
];

describe('dragging a card to a new priority', () => {
  beforeEach(bootApp);

  /** jsdom gives every element a zero-sized rect; drop side needs a real one. */
  function stubRect(el: Element, top: number, height = 40): void {
    el.getBoundingClientRect = () =>
      ({ top, height, bottom: top + height, left: 0, right: 0, width: 0, x: 0, y: top }) as DOMRect;
  }

  function card(id: string): HTMLElement {
    return document.querySelector(`.card[data-id="${id}"]`) as HTMLElement;
  }

  const transfer = { setData: vi.fn(), effectAllowed: '', dropEffect: '' };

  function drag(type: string, el: Element, clientY = 0): Event {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientY });
    Object.defineProperty(event, 'dataTransfer', { value: transfer });
    el.dispatchEvent(event);
    return event;
  }

  async function threeTodos(): Promise<void> {
    await serveTasks([
      task('t1', { name: 'First', position: 1 }),
      task('t2', { name: 'Second', position: 2 }),
      task('t3', { name: 'Third', position: 3 }),
    ]);
    for (const [i, id] of ['t1', 't2', 't3'].entries()) stubRect(card(id), i * 40);
  }

  it('marks active cards draggable and finished ones not', async () => {
    await serveTasks([
      task('t1', { position: 1 }),
      task('t2', { status: 'in-progress', position: 2 }),
      task('t3', { status: 'parked', position: 3 }),
      task('t4', { status: 'done' }),
      task('t5', { status: 'cancelled' }),
    ]);
    for (const id of ['t1', 't2', 't3']) expect(card(id).draggable, id).toBe(true);
    for (const id of ['t4', 't5']) expect(card(id).draggable, id).toBe(false);
  });

  it('drops above a card and asks for that card\'s position', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true));
    await threeTodos();
    drag('dragstart', card('t3'));
    drag('dragover', card('t1'), 5); // top half of t1: insert above it
    drag('drop', card('t1'), 5);
    const call = fetchCalls.find((c) => c.path === '/api/tasks/t3/bump');
    expect(JSON.parse(call!.init!.body as string)).toEqual({ target: 1 });
  });

  it('drops below a card and asks for the next position along', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true));
    await threeTodos();
    drag('dragstart', card('t3'));
    drag('dragover', card('t1'), 35); // bottom half of t1: insert below it
    drag('drop', card('t1'), 35);
    const call = fetchCalls.find((c) => c.path === '/api/tasks/t3/bump');
    expect(JSON.parse(call!.init!.body as string)).toEqual({ target: 2 });
  });

  it('counts positions after the dragged card leaves the order', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true));
    await threeTodos();
    // t3 sits at 80..120, so 110 is its bottom half: drop below it.
    drag('dragstart', card('t1')); // t1 leaves the order, so the count shifts
    drag('dragover', card('t3'), 110);
    drag('drop', card('t3'), 110);
    const call = fetchCalls.find((c) => c.path === '/api/tasks/t1/bump');
    expect(JSON.parse(call!.init!.body as string)).toEqual({ target: 3 });
  });

  it('lands a card between two others, counting from the lifted order', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true));
    await threeTodos();
    drag('dragstart', card('t1'));
    drag('dragover', card('t3'), 85); // t3's top half: land between t2 and t3
    drag('drop', card('t3'), 85);
    const call = fetchCalls.find((c) => c.path === '/api/tasks/t1/bump');
    expect(JSON.parse(call!.init!.body as string)).toEqual({ target: 2 });
  });

  it('shows where the card would land while it hovers', async () => {
    await threeTodos();
    drag('dragstart', card('t3'));
    drag('dragover', card('t1'), 5);
    expect(card('t1').classList.contains('drop-above')).toBe(true);
    drag('dragover', card('t1'), 35);
    expect(card('t1').classList.contains('drop-above')).toBe(false);
    expect(card('t1').classList.contains('drop-below')).toBe(true);
    drag('dragend', card('t3'));
    expect(document.querySelector('.drop-above, .drop-below')).toBeNull();
  });

  it('refuses a drop into another column: that would be a status change', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true));
    await serveTasks([
      task('t1', { position: 1 }),
      task('t2', { status: 'in-progress', position: 2 }),
    ]);
    stubRect(card('t1'), 0);
    stubRect(card('t2'), 0);
    drag('dragstart', card('t1'));
    const over = drag('dragover', card('t2'), 5);
    expect(over.defaultPrevented).toBe(false); // no drop target, so no line drawn
    expect(card('t2').classList.contains('drop-above')).toBe(false);
    drag('drop', card('t2'), 5);
    expect(fetchCalls.some((c) => c.path.includes('/bump'))).toBe(false);
  });

  it('does nothing when a card lands back where it started', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true));
    await threeTodos();
    drag('dragstart', card('t2'));
    drag('dragover', card('t2'), 45);
    drag('drop', card('t2'), 45);
    expect(fetchCalls.some((c) => c.path.includes('/bump'))).toBe(false);
  });

  it('asks before it moves anything, and a refusal posts nothing', async () => {
    vi.stubGlobal('confirm', vi.fn(() => false));
    await threeTodos();
    drag('dragstart', card('t3'));
    drag('dragover', card('t1'), 5);
    drag('drop', card('t1'), 5);
    expect(fetchCalls.some((c) => c.path.includes('/bump'))).toBe(false);
  });
});

describe('board columns: counts and toggles', () => {
  beforeEach(bootApp);

  const headers = () =>
    [...document.querySelectorAll('#board-columns .column h2')].map((h) => h.textContent!);
  const chip = (status: string) =>
    document.querySelector(`#board-filters .chip[data-status="${status}"]`) as HTMLButtonElement;

  it('counts the cards in every column header', async () => {
    await serveTasks([
      task('t1', { position: 1 }),
      task('t2', { position: 2 }),
      task('t3', { status: 'in-progress', position: 3 }),
      task('t4', { status: 'done' }),
    ]);
    expect(headers().find((h) => h.includes('To do'))).toMatch(/\b2\b/);
    expect(headers().find((h) => h.includes('In progress'))).toMatch(/\b1\b/);
    expect(headers().find((h) => h.includes('Done'))).toMatch(/\b1\b/);
  });

  it('counts what the other filters left, not the whole store', async () => {
    await serveTasks([
      task('t1', { position: 1 }),
      task('t2', { type: 'decision', position: 2 }),
    ]);
    (document.querySelector('#board-filters .chip[data-type="decision"]') as HTMLElement).click();
    expect(headers().find((h) => h.includes('To do'))).toMatch(/\b1\b/);
  });

  it('offers a chip per status, each carrying its own count', async () => {
    await serveTasks([
      task('t1', { position: 1 }),
      task('t2', { status: 'parked', position: 2 }),
      task('t3', { status: 'cancelled' }),
    ]);
    for (const status of ['todo', 'in-progress', 'parked', 'done', 'cancelled']) {
      expect(chip(status), status).not.toBeNull();
    }
    expect(chip('parked').textContent).toMatch(/\b1\b/);
    expect(chip('done').textContent).toMatch(/\b0\b/);
  });

  it('a chip click hides its column and the choice sticks', async () => {
    await serveTasks([task('t1', { position: 1 }), task('t2', { status: 'done' })]);
    expect(headers().some((h) => h.includes('Done'))).toBe(true);
    chip('done').click();
    expect(headers().some((h) => h.includes('Done'))).toBe(false);
    expect(localStorage.getItem('planny-board-statuses')).not.toContain('done');
    chip('done').click();
    expect(headers().some((h) => h.includes('Done'))).toBe(true);
  });

  it('brings back a column the store hides by default', async () => {
    await serveTasks([task('t1', { position: 1 })]);
    expect(headers().some((h) => h.includes('Parked'))).toBe(false);
    chip('parked').click();
    expect(headers().some((h) => h.includes('Parked'))).toBe(true);
    expect(headers()[0]).toMatch(/^Parked/);
  });

  it('remembers the choice across a reload', async () => {
    await serveTasks([task('t1', { position: 1 }), task('t2', { status: 'done' })]);
    chip('done').click();
    const stored = localStorage.getItem('planny-board-statuses')!;
    await bootAppKeepingPreferences();
    expect(localStorage.getItem('planny-board-statuses')).toBe(stored);
    expect(headers().some((h) => h.includes('Done'))).toBe(false);
  });
});

describe('the drawer activity list', () => {
  beforeEach(bootApp);

  const activity = () => document.querySelector('#drawer-body .activity-list') as HTMLElement;
  const lines = () => [...activity().querySelectorAll('li')];

  it('times the creation line, with or without a creator on record', async () => {
    await serveTasks([
      task('t1', { created: '2026-08-31T12:00:00.000Z', position: 1 }),
      task('t2', { created: '2026-08-31T12:00:00.000Z', createdBy: 'agent-7', position: 2 }),
    ]);
    (document.querySelector('.card[data-id="t1"]') as HTMLElement).click();
    expect(lines()[0]!.textContent).toMatch(/^created\b/);
    expect(lines()[0]!.querySelector('time')).not.toBeNull();
    (document.querySelector('.card[data-id="t2"]') as HTMLElement).click();
    expect(lines()[0]!.textContent).toContain('agent-7');
    expect(lines()[0]!.querySelector('time')).not.toBeNull();
  });

  it('gives every action a time, and the exact stamp on hover', async () => {
    await serveTasks([
      task('t1', {
        created: '2026-08-31T12:00:00.000Z',
        createdBy: 'agent-7',
        status: 'in-progress',
        history: [
          { at: '2026-08-31T13:00:00.000Z', event: 'rename', from: 'Old name', to: 'New name' },
          { at: '2026-08-31T14:00:00.000Z', event: 'priority', target: 'top', position: 1 },
          { at: '2026-08-31T15:00:00.000Z', event: 'parent', to: 't9' },
          { at: '2026-08-31T16:00:00.000Z', event: 'blocked-by', added: ['t9'] },
          { at: '2026-08-31T17:00:00.000Z', status: 'in-progress', by: 'agent-7' },
        ],
        position: 1,
      }),
    ]);
    (document.querySelector('.card[data-id="t1"]') as HTMLElement).click();
    expect(lines()).toHaveLength(6); // created, then one per history entry
    for (const line of lines()) {
      const stamp = line.querySelector('time') as HTMLElement;
      expect(stamp, line.textContent!).not.toBeNull();
      expect(stamp.getAttribute('datetime')).toMatch(/^2026-08-31T/);
      expect(stamp.title).toMatch(/^2026-08-31T/);
      expect(stamp.textContent!.trim()).not.toBe('');
    }
    const text = activity().textContent!;
    expect(text).toContain('renamed');
    expect(text).toContain('position 1');
    expect(text).toContain('parent');
    expect(text).toContain('waits on');
    expect(text).toMatch(/in-progress/);
    expect(text).toContain('agent-7');
  });

  it('reads the newest action last, in time order', async () => {
    await serveTasks([
      task('t1', {
        created: '2026-08-31T12:00:00.000Z',
        history: [
          { at: '2026-08-31T13:00:00.000Z', status: 'in-progress', by: 'a' },
          { at: '2026-08-31T18:00:00.000Z', status: 'done', by: 'b' },
        ],
        position: 1,
      }),
    ]);
    (document.querySelector('.card[data-id="t1"]') as HTMLElement).click();
    const stamps = lines().map((l) => l.querySelector('time')!.getAttribute('datetime'));
    expect(stamps).toEqual([
      '2026-08-31T12:00:00.000Z',
      '2026-08-31T13:00:00.000Z',
      '2026-08-31T18:00:00.000Z',
    ]);
  });

  it('shows only the creation line for a task nothing has happened to', async () => {
    await serveTasks([task('t1', { created: '2026-08-31T12:00:00.000Z', position: 1 })]);
    (document.querySelector('.card[data-id="t1"]') as HTMLElement).click();
    expect(lines()).toHaveLength(1);
  });
});

describe('parked work on the board', () => {
  beforeEach(bootApp);

  it('gives parked cards their own column, before To do', async () => {
    await serveTasks([
      task('t1', { name: 'Live one', position: 1 }),
      task('t2', { name: 'Napping', status: 'parked', parkedUntil: 'the API ships', position: 2 }),
    ]);
    const titles = [...document.querySelectorAll('#board-columns .column h2')].map((h) =>
      h.textContent!.trim(),
    );
    expect(titles[0]).toMatch(/^Parked/);
    expect(titles[1]).toMatch(/^To do/);
    const parkedColumn = document.querySelectorAll('#board-columns .column')[0]!;
    expect(parkedColumn.querySelector('.card[data-id="t2"]')).not.toBeNull();
  });

  it('hides the parked column when nothing is parked', async () => {
    await serveTasks([task('t1', { name: 'Live one', position: 1 })]);
    const titles = [...document.querySelectorAll('#board-columns .column h2')].map((h) =>
      h.textContent!.trim(),
    );
    expect(titles.some((t) => t.startsWith('Parked'))).toBe(false);
  });

  it('offers a parked status filter chip in the tree', async () => {
    await serveTasks([task('t1', { status: 'parked', position: 1 })]);
    clickTab('tree');
    expect(document.querySelector('.chip[data-scope="tree"][data-status="parked"]')).not.toBeNull();
    expect(document.querySelector('#tree-list [data-id="t1"]')).not.toBeNull();
  });

  it('counts parked work in the priority total, as the server does', async () => {
    await serveTasks([
      task('t1', { position: 1 }),
      task('t2', { status: 'parked', position: 2 }),
      task('t3', { status: 'done' }),
    ]);
    (document.querySelector('.card[data-id="t1"]') as HTMLElement).click();
    expect(document.querySelector('#drawer-body')!.textContent).toMatch(/of 2 open tasks/);
  });

  it('shows the wake note in the drawer, and hides it on live work', async () => {
    await serveTasks([
      task('t1', { status: 'parked', parkedUntil: 'the payments API ships', position: 1 }),
      task('t2', { position: 2 }),
    ]);
    (document.querySelector('.card[data-id="t1"]') as HTMLElement).click();
    expect(document.querySelector('#drawer-body')!.textContent).toContain(
      'the payments API ships',
    );
    (document.querySelector('.card[data-id="t2"]') as HTMLElement).click();
    expect(document.querySelector('#drawer-body')!.textContent).not.toContain('parked until');
  });

  it('parks from the drawer, asking for the wake note', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true));
    vi.stubGlobal('prompt', vi.fn(() => 'the payments API ships'));
    await serveTasks([task('t1', { position: 1 })]);
    (document.querySelector('.card[data-id="t1"]') as HTMLElement).click();
    (document.querySelector('#drawer-body button[data-status="parked"]') as HTMLElement).click();
    const call = fetchCalls.find((c) => c.path === '/api/tasks/t1/status' && c.init?.body);
    expect(JSON.parse(call!.init!.body as string)).toMatchObject({
      status: 'parked',
      parkedUntil: 'the payments API ships',
    });
  });

  it('parks with no note when the operator leaves the box empty', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true));
    vi.stubGlobal('prompt', vi.fn(() => ''));
    await serveTasks([task('t1', { position: 1 })]);
    (document.querySelector('.card[data-id="t1"]') as HTMLElement).click();
    (document.querySelector('#drawer-body button[data-status="parked"]') as HTMLElement).click();
    const call = fetchCalls.find((c) => c.path === '/api/tasks/t1/status' && c.init?.body);
    expect(JSON.parse(call!.init!.body as string)).toEqual({ status: 'parked' });
  });

  it('parks nothing when the operator cancels the box', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true));
    vi.stubGlobal('prompt', vi.fn(() => null));
    await serveTasks([task('t1', { position: 1 })]);
    (document.querySelector('.card[data-id="t1"]') as HTMLElement).click();
    (document.querySelector('#drawer-body button[data-status="parked"]') as HTMLElement).click();
    expect(fetchCalls.some((c) => c.path === '/api/tasks/t1/status')).toBe(false);
  });

  it('wakes a parked task straight from its card', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true));
    await serveTasks([task('t1', { status: 'parked', position: 1 })]);
    const wake = document.querySelector(
      '.card[data-id="t1"] button[data-action="unpark"]',
    ) as HTMLElement;
    expect(wake).not.toBeNull();
    wake.click();
    const call = fetchCalls.find((c) => c.path === '/api/tasks/t1/status' && c.init?.body);
    expect(JSON.parse(call!.init!.body as string)).toMatchObject({ status: 'todo' });
  });

  it('keeps the priority number on a parked card: the rank is not lost', async () => {
    await serveTasks([
      task('t1', { position: 1 }),
      task('t2', { status: 'parked', position: 2 }),
    ]);
    const card = document.querySelector('.card[data-id="t2"]')!;
    expect(card.querySelector('.pos')!.textContent).toBe('#2');
    expect(card.querySelector('button[data-action="top"]')).not.toBeNull();
  });

  it('a parked blocker still reads as a blocker on the card', async () => {
    await serveTasks([
      task('t1', { status: 'parked', position: 1 }),
      task('t2', { blockedBy: ['t1'], blocked: true, position: 2 }),
    ]);
    const card = document.querySelector('.card[data-id="t2"]')!;
    expect(card.querySelector('.badge.blocked')!.textContent).toContain('t1');
  });
});

describe('parking a decision', () => {
  beforeEach(bootApp);

  it('parks the decision instead of hiding it in this browser only', async () => {
    vi.stubGlobal('prompt', vi.fn(() => 'after the demo'));
    clickTab('decisions');
    expandDecision('t4');
    const btn = document.querySelector(
      'button[data-action="park"][data-id="t4"]',
    ) as HTMLElement;
    expect(btn.textContent).toMatch(/park for now/i);
    btn.click();
    const call = fetchCalls.find((c) => c.path === '/api/tasks/t4/status' && c.init?.body);
    expect(JSON.parse(call!.init!.body as string)).toMatchObject({
      status: 'parked',
      parkedUntil: 'after the demo',
    });
  });

  it('lists parked decisions with a way to bring one back', async () => {
    servedState = {
      ...sampleState,
      tasks: [
        task('t4', {
          name: 'Choose hosting',
          type: 'decision',
          status: 'parked',
          parkedUntil: 'after the demo',
        }),
        task('t7', { name: 'Live question', type: 'decision' }),
      ],
      decisions: [{ id: 't7', blocked: false }],
    };
    window.dispatchEvent(new Event('focus'));
    await new Promise((r) => setTimeout(r, 5));
    clickTab('decisions');
    const parked = document.querySelector('#view-decisions .parked-list')!;
    expect(parked.textContent).toContain('t4');
    expect(parked.textContent).toContain('after the demo');
    (parked.querySelector('button[data-action="unpark"][data-id="t4"]') as HTMLElement).click();
    const call = fetchCalls.find((c) => c.path === '/api/tasks/t4/status' && c.init?.body);
    expect(JSON.parse(call!.init!.body as string)).toMatchObject({ status: 'todo' });
  });
});

describe('meaningless buttons are disabled', () => {
  it('the quick top button is dead on the top card, live below', () => {
    const topBtn = (id: string) =>
      document.querySelector(`button[data-action="top"][data-id="${id}"]`) as HTMLButtonElement;
    expect(topBtn('t1').disabled).toBe(true); // position 1 already
    expect(topBtn('t1').title).toMatch(/already/i);
    expect(topBtn('t3').disabled).toBe(false); // position 3 can rise
  });

  it('drawer: current status is dead; top bump is dead at position 1', () => {
    (document.querySelector('.card[data-id="t2"]') as HTMLElement).click(); // in-progress
    const current = document.querySelector(
      '#drawer-body button[data-status="in-progress"]',
    ) as HTMLButtonElement;
    expect(current.disabled).toBe(true);
    expect(
      (document.querySelector('#drawer-body button[data-status="done"]') as HTMLButtonElement)
        .disabled,
    ).toBe(false);

    (document.querySelector('.card[data-id="t1"]') as HTMLElement).click(); // position 1
    expect((document.querySelector('button[data-bump="top"]') as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(
      (document.querySelector('button[data-bump="bottom"]') as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it('drawer: set arms only when the typed position differs', () => {
    (document.querySelector('.card[data-id="t3"]') as HTMLElement).click();
    const setBtn = () => document.querySelector('#set-position') as HTMLButtonElement;
    const input = document.querySelector('#f-position') as HTMLInputElement;
    expect(setBtn().disabled).toBe(true); // untouched
    input.value = '1';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(setBtn().disabled).toBe(false);
    input.value = '3'; // back to the original
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(setBtn().disabled).toBe(true);
  });

  it('tile priority rows kill top at position 1 and bottom at the end', async () => {
    await serveTasks([
      task('t1', { name: 'First question', type: 'decision', position: 1 }),
      task('t2', { name: 'Last question', type: 'decision', position: 2 }),
    ]);
    servedState = { ...servedState, decisions: [{ id: 't1', blocked: false }, { id: 't2', blocked: false }] };
    window.dispatchEvent(new Event('focus'));
    await new Promise((r) => setTimeout(r, 5));
    clickTab('decisions');
    expandDecision('t1');
    expandDecision('t2');
    const btn = (id: string, action: string) =>
      document.querySelector(
        `.decision-priority button[data-action="${action}"][data-id="${id}"]`,
      ) as HTMLButtonElement;
    expect(btn('t1', 'top').disabled).toBe(true);
    expect(btn('t1', 'bottom').disabled).toBe(false);
    expect(btn('t2', 'top').disabled).toBe(false);
    expect(btn('t2', 'bottom').disabled).toBe(true);
  });

  it('the current status button keeps its filled look while disabled', () => {
    const css = readFileSync(join(webDir, 'style.css'), 'utf8');
    expect(css).toMatch(/\.status-buttons button\.current:disabled\s*{[^}]*opacity: 1/);
  });
});

describe('task ids link in rendered bodies', () => {
  const bodies = [
    task('t1', { name: 'The referenced one' }),
    task('t2', {
      name: 'Cites tasks',
      type: 'decision',
      body: 'See t1 for the build. Run `planny show t1` first. t99 is unknown.',
    }),
    task('t3', {
      name: 'Settled citation',
      type: 'decision',
      status: 'done',
      body: '## Outcome\n\nSpawned t1.',
      resolvedAt: '2026-09-01T10:00:00.000Z',
    }),
  ];

  it('a known id in a decision tile links; code spans and unknown ids stay plain', async () => {
    await serveTasks(bodies);
    clickTab('decisions');
    // serveTasks empties the decisions list; rebuild it for this fixture.
    servedState = { ...servedState, decisions: [{ id: 't2', blocked: false }] };
    window.dispatchEvent(new Event('focus'));
    await new Promise((r) => setTimeout(r, 5));
    expandDecision('t2');
    const body = document.querySelector('#view-decisions .decision-body') as HTMLElement;
    const links = body.querySelectorAll('[data-goto-task="t1"]');
    expect(links).toHaveLength(1); // the prose mention only
    expect(body.querySelector('code')!.textContent).toBe('planny show t1'); // untouched
    expect(body.querySelector('[data-goto-task="t99"]')).toBeNull(); // unknown id
    (links[0] as HTMLElement).click();
    expect(document.querySelector('#drawer-title')!.textContent).toContain('t1');
  });

  it('the drawer outcome section links ids too', async () => {
    await serveTasks(bodies);
    (document.querySelector('.card[data-id="t3"]') as HTMLElement).click();
    const outcome = document.querySelector('#drawer-body .decision-outcome') as HTMLElement;
    expect(outcome.querySelector('[data-goto-task="t1"]')).not.toBeNull();
  });
});

describe('resolving must not arm Save (t160 data loss)', () => {
  it('typing in the resolve box leaves Save disabled and the form clean', () => {
    (document.querySelector('.card[data-id="t4"]') as HTMLElement).click();
    const resolution = document.querySelector('#f-resolution') as HTMLTextAreaElement;
    resolution.value = 'go';
    resolution.dispatchEvent(new Event('input', { bubbles: true }));
    expect((document.querySelector('#save-btn') as HTMLButtonElement).disabled).toBe(true);
    expect((document.querySelector('#unsaved-note') as HTMLElement).hidden).toBe(true);
  });

  it('after resolving, the drawer is clean so refreshes rebuild it', async () => {
    (document.querySelector('.card[data-id="t4"]') as HTMLElement).click();
    const resolution = document.querySelector('#f-resolution') as HTMLTextAreaElement;
    resolution.value = 'go';
    resolution.dispatchEvent(new Event('input', { bubbles: true }));
    (document.querySelector('#resolve-btn') as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 5));
    const resolve = fetchCalls.find((c) => c.path === '/api/tasks/t4/resolve');
    expect(resolve).toBeDefined();
    // A description edit still protects itself: this is only about the box.
    expect((document.querySelector('#save-btn') as HTMLButtonElement).disabled).toBe(true);
  });

  it('a real description edit still arms Save', () => {
    (document.querySelector('.card[data-id="t4"]') as HTMLElement).click();
    const desc = document.querySelector('#f-desc') as HTMLTextAreaElement;
    desc.value = 'edited';
    desc.dispatchEvent(new Event('input', { bubbles: true }));
    expect((document.querySelector('#save-btn') as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('logged-decision confirmation', () => {
  it('resolving from a tile shows a green toast and a logged note naming the catch-up', async () => {
    clickTab('decisions');
    expandDecision('t4');
    const draft = document.querySelector(
      'textarea[data-role="response"][data-id="t4"]',
    ) as HTMLTextAreaElement;
    draft.value = 'use the proposal';
    draft.dispatchEvent(new Event('input', { bubbles: true })); // arms Respond
    // The refresh after the resolve will see the store's new truth: t4 done.
    servedState = {
      ...sampleState,
      tasks: sampleState.tasks.map((t) =>
        t.id === 't4' ? { ...t, status: 'done', resolvedAt: '2026-09-01T10:00:00.000Z' } : t,
      ),
      decisions: [],
    };
    (document.querySelector('button[data-action="respond"][data-id="t4"]') as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 5));
    const toast = document.querySelector('#toasts .toast.ok') as HTMLElement;
    expect(toast).not.toBeNull();
    expect(toast.textContent).toContain('t4');
    expect(toast.textContent).toMatch(/catch-up/);
    const note = document.querySelector('#view-decisions .decision-logged') as HTMLElement;
    expect(note).not.toBeNull();
    expect(note.textContent).toContain('t4');
    expect(note.textContent).toMatch(/logged/i);
    expect(note.textContent).toMatch(/catch-up/);
  });

  it('the logged note names the CLI commands and dismisses on its cross', async () => {
    clickTab('decisions');
    expandDecision('t4');
    const draft = document.querySelector(
      'textarea[data-role="response"][data-id="t4"]',
    ) as HTMLTextAreaElement;
    draft.value = 'go';
    draft.dispatchEvent(new Event('input', { bubbles: true }));
    servedState = {
      ...sampleState,
      tasks: sampleState.tasks.map((t) =>
        t.id === 't4' ? { ...t, status: 'done', resolvedAt: '2026-09-01T10:00:00.000Z' } : t,
      ),
      decisions: [],
    };
    (document.querySelector('button[data-action="respond"][data-id="t4"]') as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 5));
    const note = document.querySelector('#view-decisions .decision-logged') as HTMLElement;
    expect(note.textContent).toContain('planny decisions --resolved'); // all recent answers
    expect(note.textContent).toContain('planny show t4'); // this one
    const cross = note.querySelector('button[data-action="dismiss-logged"]') as HTMLElement;
    expect(cross).not.toBeNull();
    cross.click();
    expect(document.querySelector('#view-decisions .decision-logged')).toBeNull();
  });

  it('both typed-answer buttons say Submit', () => {
    clickTab('decisions');
    expandDecision('t4');
    expect(
      (document.querySelector('button[data-action="respond"][data-id="t4"]') as HTMLElement)
        .textContent,
    ).toBe('Submit');
    (document.querySelector('#search') as HTMLInputElement).value = ''; // no-op, keep focus sane
    (document.querySelector('.card[data-id="t4"]') as HTMLElement).click();
    expect((document.querySelector('#resolve-btn') as HTMLElement).textContent).toBe('Submit');
  });

  it('the green toast outlives ordinary toasts', async () => {
    clickTab('decisions');
    expandDecision('t4');
    const draft = document.querySelector(
      'textarea[data-role="response"][data-id="t4"]',
    ) as HTMLTextAreaElement;
    draft.value = 'go';
    draft.dispatchEvent(new Event('input', { bubbles: true }));
    vi.useFakeTimers();
    try {
      (
        document.querySelector('button[data-action="respond"][data-id="t4"]') as HTMLElement
      ).click();
      await vi.advanceTimersByTimeAsync(6_000); // an ordinary toast is gone by now
      expect(document.querySelector('#toasts .toast.ok')).not.toBeNull();
      await vi.advanceTimersByTimeAsync(6_000);
      expect(document.querySelector('#toasts .toast.ok')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('the logged note stays for five minutes', async () => {
    clickTab('decisions');
    expandDecision('t4');
    const draft = document.querySelector(
      'textarea[data-role="response"][data-id="t4"]',
    ) as HTMLTextAreaElement;
    draft.value = 'go';
    draft.dispatchEvent(new Event('input', { bubbles: true }));
    servedState = {
      ...sampleState,
      tasks: sampleState.tasks.map((t) =>
        t.id === 't4' ? { ...t, status: 'done', resolvedAt: '2026-09-01T10:00:00.000Z' } : t,
      ),
      decisions: [],
    };
    vi.useFakeTimers();
    try {
      (
        document.querySelector('button[data-action="respond"][data-id="t4"]') as HTMLElement
      ).click();
      await vi.advanceTimersByTimeAsync(61_000); // the old one-minute life was too short
      expect(document.querySelector('#view-decisions .decision-logged')).not.toBeNull();
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(document.querySelector('#view-decisions .decision-logged')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('the confirmation names the outcome task when the server reports one', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (path: string, init?: RequestInit) => {
        fetchCalls.push({ path, init });
        if (path.endsWith('/resolve')) {
          return {
            ok: true,
            json: async () => ({
              task: task('t4', { status: 'done' }),
              warnings: [],
              outcomeTask: task('t9', { name: 'Act on the outcome of t4: Choose hosting' }),
            }),
          };
        }
        return { ok: true, json: async () => structuredClone(servedState) };
      }),
    );
    clickTab('decisions');
    expandDecision('t4');
    (document.querySelector('button[data-action="accept"][data-id="t4"]') as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 5));
    const toast = document.querySelector('#toasts .toast.ok') as HTMLElement;
    expect(toast.textContent).toContain('outcome task t9');
  });

  it('reject asks for the warned confirmation, then posts reject', async () => {
    const confirmed = vi.fn(() => true);
    vi.stubGlobal('confirm', confirmed);
    clickTab('decisions');
    expandDecision('t4');
    const reject = document.querySelector(
      'button[data-action="reject"][data-id="t4"]',
    ) as HTMLElement;
    expect(reject).not.toBeNull();
    reject.click();
    await new Promise((r) => setTimeout(r, 5));
    expect(confirmed.mock.calls[0]![0]).toMatch(/no task will be created/i);
    const post = fetchCalls.find((c) => c.path === '/api/tasks/t4/resolve');
    expect(post).toBeDefined();
    expect(JSON.parse(post!.init!.body as string).reject).toBe(true);
  });

  it('declining the reject warning posts nothing', async () => {
    vi.stubGlobal('confirm', vi.fn(() => false));
    clickTab('decisions');
    expandDecision('t4');
    (document.querySelector('button[data-action="reject"][data-id="t4"]') as HTMLElement).click();
    expect(fetchCalls.some((c) => c.path === '/api/tasks/t4/resolve')).toBe(false);
  });

  it('the drawer offers reject too', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true));
    (document.querySelector('.card[data-id="t4"]') as HTMLElement).click();
    (document.querySelector('#reject-btn') as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 5));
    const post = fetchCalls.find((c) => c.path === '/api/tasks/t4/resolve');
    expect(JSON.parse(post!.init!.body as string).reject).toBe(true);
  });

  it('resolving from the drawer also confirms in green', async () => {
    (document.querySelector('.card[data-id="t4"]') as HTMLElement).click();
    const resolution = document.querySelector('#f-resolution') as HTMLTextAreaElement;
    resolution.value = 'go';
    resolution.dispatchEvent(new Event('input', { bubbles: true }));
    (document.querySelector('#resolve-btn') as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 5));
    expect(document.querySelector('#toasts .toast.ok')).not.toBeNull();
  });
});

describe('decision buttons gate on their own input', () => {
  it('drawer: Resolve arms only with text; Accept only while the box is empty', () => {
    (document.querySelector('.card[data-id="t4"]') as HTMLElement).click();
    const resolveBtn = () => document.querySelector('#resolve-btn') as HTMLButtonElement;
    const acceptBtn = () => document.querySelector('#accept-btn') as HTMLButtonElement;
    const box = document.querySelector('#f-resolution') as HTMLTextAreaElement;
    expect(resolveBtn().disabled).toBe(true); // nothing typed yet
    expect(acceptBtn().disabled).toBe(false); // the proposal is acceptable as-is
    expect(resolveBtn().title).toMatch(/typed/i);
    expect(acceptBtn().title).toMatch(/proposal/i);

    box.value = 'go';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    expect(resolveBtn().disabled).toBe(false);
    expect(acceptBtn().disabled).toBe(true); // typed text and Accept disagree

    box.value = '';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    expect(resolveBtn().disabled).toBe(true);
    expect(acceptBtn().disabled).toBe(false);
  });

  it('tiles: Respond arms only with text; Accept only while the box is empty', () => {
    clickTab('decisions');
    expandDecision('t4');
    const respond = () =>
      document.querySelector('button[data-action="respond"][data-id="t4"]') as HTMLButtonElement;
    const accept = () =>
      document.querySelector('button[data-action="accept"][data-id="t4"]') as HTMLButtonElement;
    const draft = document.querySelector(
      'textarea[data-role="response"][data-id="t4"]',
    ) as HTMLTextAreaElement;
    expect(respond().disabled).toBe(true);
    expect(accept().disabled).toBe(false);

    draft.value = 'leaning yes';
    draft.dispatchEvent(new Event('input', { bubbles: true }));
    expect(respond().disabled).toBe(false);
    expect(accept().disabled).toBe(true);
  });

  it('a background refresh keeps the armed state with the kept draft', async () => {
    clickTab('decisions');
    expandDecision('t4');
    const draft = () =>
      document.querySelector('textarea[data-role="response"][data-id="t4"]') as HTMLTextAreaElement;
    draft().value = 'half-typed answer';
    draft().dispatchEvent(new Event('input', { bubbles: true }));
    window.dispatchEvent(new Event('focus'));
    await new Promise((r) => setTimeout(r, 5));
    const respond = document.querySelector(
      'button[data-action="respond"][data-id="t4"]',
    ) as HTMLButtonElement;
    expect(draft().value).toBe('half-typed answer');
    expect(respond.disabled).toBe(false); // still armed for the kept draft
  });
});

describe('cancel confirmation', () => {
  const openCancel = (id: string) => {
    (document.querySelector(`.card[data-id="${id}"]`) as HTMLElement).click();
    (document.querySelector('#drawer-body button[data-status="cancelled"]') as HTMLElement).click();
    return document.querySelector('#cancel-extra') as HTMLElement;
  };

  it('names the tasks waiting on the one being cancelled, as links', () => {
    const extra = openCancel('t1'); // t1 blocks t3 in the sample state
    expect(extra.classList.contains('hidden')).toBe(false);
    expect(extra.textContent).toMatch(/wait/i);
    expect(extra.querySelector('[data-goto-task="t3"]')).not.toBeNull();
    expect(extra.textContent).toMatch(/rewire/i); // says what replacements do
  });

  it('says so when nothing waits', () => {
    const extra = openCancel('t2');
    expect(extra.textContent).toMatch(/nothing waits/i);
  });

  it('the replaced-by box has no fake-id placeholder', () => {
    const extra = openCancel('t1');
    const input = extra.querySelector('#f-replaced-by') as HTMLInputElement;
    expect(input.placeholder).toBe('');
  });
});

describe('ids link everywhere text renders', () => {
  const fixture = [
    task('t1', { name: 'The referenced one', blocking: ['t3'], position: 1 }),
    task('t2', { name: 'Follow up t1 properly', parent: 't1', position: 2 }),
    task('t3', {
      name: 'Blocked question',
      type: 'decision',
      blockedBy: ['t1'],
      blocked: true,
      position: 3,
    }),
  ];
  const serveFixture = async () => {
    await serveTasks(fixture);
    servedState = { ...servedState, decisions: [{ id: 't3', blocked: true }] };
    window.dispatchEvent(new Event('focus'));
    await new Promise((r) => setTimeout(r, 5));
  };

  it('card names link mentioned ids, and the chip wins over the card', async () => {
    await serveFixture();
    const chip = document.querySelector(
      '.card[data-id="t2"] .name [data-goto-task="t1"]',
    ) as HTMLElement;
    expect(chip).not.toBeNull();
    chip.click();
    expect(document.querySelector('#drawer-title')!.textContent).toContain('t1'); // not t2
  });

  it('tree row names link mentioned ids', async () => {
    await serveFixture();
    clickTab('tree');
    expect(
      document.querySelector('#tree-list .tree-row[data-id="t2"] .name [data-goto-task="t1"]'),
    ).not.toBeNull();
  });

  it('a blocked decision tile links the blockers it waits on', async () => {
    await serveFixture();
    clickTab('decisions');
    expandDecision('t3');
    const tile = document.querySelector('.decision-card[data-id="t3"]') as HTMLElement;
    expect(tile.querySelector('[data-goto-task="t1"]')).not.toBeNull();
  });

  it('the drawer path links the ancestors', async () => {
    await serveFixture();
    (document.querySelector('.card[data-id="t2"]') as HTMLElement).click();
    const body = document.querySelector('#drawer-body') as HTMLElement;
    // The path line "t1 The referenced one" carries a chip for t1.
    expect(body.querySelector('.drawer-section [data-goto-task="t1"]')).not.toBeNull();
  });
});

describe('drawer description view mode', () => {
  const bodies = [
    task('t1', { name: 'The referenced one' }),
    task('t2', {
      name: 'Outcome-ish task',
      body: 'The tasks now wait on this task instead: t1. Run `planny show t1` first.',
    }),
  ];

  it('a task with a body opens in view mode with clickable ids; code spans stay plain', async () => {
    await serveTasks(bodies);
    (document.querySelector('.card[data-id="t2"]') as HTMLElement).click();
    const view = document.querySelector('#f-desc-view') as HTMLElement;
    expect(view.hidden).toBe(false); // reading is the default
    expect((document.querySelector('#f-desc') as HTMLElement).hidden).toBe(true);
    expect((document.querySelector('#desc-mode') as HTMLElement).textContent).toBe('edit');
    const links = view.querySelectorAll('[data-goto-task="t1"]');
    expect(links).toHaveLength(1); // the prose mention; the code span untouched
    (links[0] as HTMLElement).click();
    expect(document.querySelector('#drawer-title')!.textContent).toContain('t1');
  });

  it('a new task and an empty body open in the editor', async () => {
    await serveTasks(bodies);
    (document.querySelector('.card[data-id="t1"]') as HTMLElement).click(); // empty body
    expect((document.querySelector('#f-desc') as HTMLElement).hidden).toBe(false);
    expect((document.querySelector('#f-desc-view') as HTMLElement).hidden).toBe(true);
  });

  it('clicking plain text in the view flips to the editor', async () => {
    await serveTasks(bodies);
    (document.querySelector('.card[data-id="t2"]') as HTMLElement).click();
    const view = document.querySelector('#f-desc-view') as HTMLElement;
    view.click(); // anywhere that is not a link
    expect((document.querySelector('#f-desc') as HTMLElement).hidden).toBe(false);
    expect(view.hidden).toBe(true);
  });

  it('the chosen editor mode survives a background rebuild of the same task', async () => {
    await serveTasks(bodies);
    (document.querySelector('.card[data-id="t2"]') as HTMLElement).click();
    (document.querySelector('#f-desc-view') as HTMLElement).click(); // into edit, nothing typed
    window.dispatchEvent(new Event('focus'));
    await new Promise((r) => setTimeout(r, 5));
    expect((document.querySelector('#f-desc') as HTMLElement).hidden).toBe(false); // still editing
  });

  it('the mode round-trip keeps an unsaved edit', async () => {
    await serveTasks(bodies);
    (document.querySelector('.card[data-id="t2"]') as HTMLElement).click();
    (document.querySelector('#f-desc-view') as HTMLElement).click(); // into edit
    const desc = document.querySelector('#f-desc') as HTMLTextAreaElement;
    desc.value = 'half-typed thought mentioning t1';
    desc.dispatchEvent(new Event('input', { bubbles: true }));
    (document.querySelector('#desc-mode') as HTMLElement).click(); // back to view
    expect((document.querySelector('#f-desc-view') as HTMLElement).textContent).toContain(
      'half-typed thought',
    );
    (document.querySelector('#f-desc-view') as HTMLElement).click(); // and in again
    const after = document.querySelector('#f-desc') as HTMLTextAreaElement;
    expect(after.hidden).toBe(false);
    expect(after.value).toBe('half-typed thought mentioning t1');
  });
});

describe('save conflict guard', () => {
  it('save sends the updated stamp the form was built from', () => {
    (document.querySelector('.card[data-id="t1"]') as HTMLElement).click();
    const name = document.querySelector('#f-name') as HTMLInputElement;
    name.value = 'renamed';
    name.dispatchEvent(new Event('input', { bubbles: true }));
    (document.querySelector('#save-btn') as HTMLElement).click();
    const patch = fetchCalls.find((c) => c.path === '/api/tasks/t1' && c.init?.method === 'PATCH');
    expect(JSON.parse(patch!.init!.body as string).ifUnchangedSince).toBe(
      '2026-08-31T12:00:00.000Z', // the sample task's updated stamp
    );
  });

  it('a conflict offers overwrite; accepting resends without the guard', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true));
    let patches = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (path: string, init?: RequestInit) => {
        fetchCalls.push({ path, init });
        if (init?.method === 'PATCH') {
          patches += 1;
          if (patches === 1) {
            return {
              ok: false,
              json: async () => ({ error: 't1 changed underneath the form — reload or overwrite' }),
            };
          }
        }
        return {
          ok: true,
          json: async () =>
            path === '/api/state' ? structuredClone(servedState) : { task: task('t9'), warnings: [] },
        };
      }),
    );
    (document.querySelector('.card[data-id="t1"]') as HTMLElement).click();
    const name = document.querySelector('#f-name') as HTMLInputElement;
    name.value = 'renamed';
    name.dispatchEvent(new Event('input', { bubbles: true }));
    (document.querySelector('#save-btn') as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 10));
    expect(patches).toBe(2);
    const retry = fetchCalls.filter((c) => c.init?.method === 'PATCH').at(-1)!;
    expect(JSON.parse(retry.init!.body as string).ifUnchangedSince).toBeUndefined();
  });

  it('declining the overwrite reloads the newer version instead', async () => {
    vi.stubGlobal('confirm', vi.fn(() => false));
    vi.stubGlobal(
      'fetch',
      vi.fn(async (path: string, init?: RequestInit) => {
        fetchCalls.push({ path, init });
        if (init?.method === 'PATCH') {
          return {
            ok: false,
            json: async () => ({ error: 't1 changed underneath the form — reload or overwrite' }),
          };
        }
        return {
          ok: true,
          json: async () =>
            path === '/api/state' ? structuredClone(servedState) : { task: task('t9'), warnings: [] },
        };
      }),
    );
    (document.querySelector('.card[data-id="t1"]') as HTMLElement).click();
    const name = document.querySelector('#f-name') as HTMLInputElement;
    name.value = 'my stale edit';
    name.dispatchEvent(new Event('input', { bubbles: true }));
    (document.querySelector('#save-btn') as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 10));
    expect(fetchCalls.filter((c) => c.init?.method === 'PATCH')).toHaveLength(1); // no retry
    // The form was rebuilt from the store's newer truth; the stale edit is gone.
    expect((document.querySelector('#f-name') as HTMLInputElement).value).toBe('Build the API');
    expect((document.querySelector('#save-btn') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('drawer decision outcome', () => {
  it('a resolved decision shows its outcome rendered below the description', () => {
    (document.querySelector('.card[data-id="t6"]') as HTMLElement).click();
    const section = document.querySelector('#drawer-body .decision-outcome') as HTMLElement;
    expect(section).not.toBeNull();
    expect(section.textContent).toContain('Done deal.');
    expect(section.textContent).toContain('resolved 2026-08-30'); // when it was decided
    // Rendered prose, not another raw editor.
    expect(section.querySelector('textarea')).toBeNull();
    // It sits below the description editor.
    const body = (document.querySelector('#drawer-body') as HTMLElement).innerHTML;
    expect(body.indexOf('f-desc')).toBeLessThan(body.indexOf('decision-outcome'));
  });

  it('open decisions and plain tasks get no outcome section', () => {
    (document.querySelector('.card[data-id="t4"]') as HTMLElement).click(); // open decision
    expect(document.querySelector('#drawer-body .decision-outcome')).toBeNull();
    (document.querySelector('.card[data-id="t1"]') as HTMLElement).click(); // plain task
    expect(document.querySelector('#drawer-body .decision-outcome')).toBeNull();
  });

  it('shows everything after the last Outcome heading, including later appends', async () => {
    await serveTasks([
      task('t1', {
        name: 'Settled with a record',
        type: 'decision',
        status: 'done',
        body: '## Proposal\n\nUse A.\n\n## Outcome\n\nChose **B** instead.\n\nBuilt: shipped in 0.2.',
        resolvedAt: '2026-08-30T10:00:00.000Z',
      }),
    ]);
    (document.querySelector('.card[data-id="t1"]') as HTMLElement).click();
    const section = document.querySelector('#drawer-body .decision-outcome') as HTMLElement;
    expect(section.textContent).toContain('Chose B instead.');
    expect(section.textContent).toContain('Built: shipped in 0.2.');
    expect(section.textContent).not.toContain('Use A.'); // pre-outcome body stays out
    expect(section.querySelector('strong')!.textContent).toBe('B'); // markdown is rendered
  });
});

describe('board hover dependency lines', () => {
  const card = (id: string) => document.querySelector(`.card[data-id="${id}"]`) as HTMLElement;
  const boardPaths = () =>
    [...document.querySelectorAll('#board-columns #dep-hover-svg path')] as SVGPathElement[];

  // t1 (todo) blocks t2 (in progress) blocks t3 (todo): the chain crosses
  // columns in both directions.
  const crossColumnChain = [
    task('t1', { name: 'Root blocker', blocking: ['t2'], position: 1 }),
    task('t2', {
      name: 'Middle',
      status: 'in-progress',
      blockedBy: ['t1'],
      blocked: true,
      blocking: ['t3'],
      position: 2,
    }),
    task('t3', { name: 'Leaf', blockedBy: ['t2'], blocked: true, position: 3 }),
  ];

  it('hovering a blocked card draws a red curve to its blocker; leaving clears it', () => {
    hover(card('t3')); // t3 waits on t1 in the sample state
    const paths = boardPaths();
    expect(paths).toHaveLength(1);
    expect(paths[0]!.getAttribute('data-level')).toBe('1');
    expect(paths[0]!.getAttribute('data-from')).toBe('t3');
    expect(paths[0]!.getAttribute('data-to')).toBe('t1');
    expect(paths[0]!.getAttribute('d')).toMatch(/^M.+C/);
    (document.querySelector('#board-columns') as HTMLElement).dispatchEvent(
      new MouseEvent('mouseleave'),
    );
    expect(boardPaths()).toHaveLength(0);
  });

  it('hovering an unblocked card draws nothing', () => {
    hover(card('t1'));
    expect(boardPaths()).toHaveLength(0);
  });

  it('follows the chain across columns with dimmer lines per level', async () => {
    await serveTasks(crossColumnChain);
    hover(card('t3'));
    const paths = boardPaths();
    expect(paths).toHaveLength(2);
    const byLevel = new Map(paths.map((p) => [p.getAttribute('data-level'), p]));
    expect(byLevel.get('1')!.getAttribute('data-to')).toBe('t2');
    expect(byLevel.get('2')!.getAttribute('data-from')).toBe('t2');
    expect(byLevel.get('2')!.getAttribute('data-to')).toBe('t1');
    const opacity = (p: SVGPathElement) => Number(p.getAttribute('stroke-opacity'));
    expect(opacity(byLevel.get('2')!)).toBeLessThan(opacity(byLevel.get('1')!));
  });

  it('board and tree share one overlay: switching views never strands lines', async () => {
    hover(card('t3'));
    expect(boardPaths()).toHaveLength(1);
    clickTab('tree');
    // The board view is hidden; its overlay must not linger anywhere.
    expect(document.querySelectorAll('#dep-hover-svg')).toHaveLength(0);
  });
});

describe('tree hover dependency lines', () => {
  beforeEach(() => clickTab('tree'));

  it('hovering a blocked row draws a red curve to its blocker; leaving clears it', () => {
    hover(treeRow('t3')); // t3 waits on t1 in the sample state
    const paths = hoverPaths();
    expect(paths).toHaveLength(1);
    expect(paths[0]!.getAttribute('data-level')).toBe('1');
    expect(paths[0]!.getAttribute('data-from')).toBe('t3');
    expect(paths[0]!.getAttribute('data-to')).toBe('t1');
    expect(paths[0]!.getAttribute('d')).toMatch(/^M.+C/); // a curve, not a straight line
    (document.querySelector('#tree-list') as HTMLElement).dispatchEvent(
      new MouseEvent('mouseleave'),
    );
    expect(hoverPaths()).toHaveLength(0);
  });

  it('hovering a row with nothing to wait on draws nothing', () => {
    hover(treeRow('t1'));
    expect(hoverPaths()).toHaveLength(0);
  });

  it('follows the chain: blockers of blockers get dimmer lines per level', async () => {
    await serveTasks(chainTasks);
    hover(treeRow('t3'));
    const paths = hoverPaths();
    expect(paths).toHaveLength(2);
    const byLevel = new Map(paths.map((p) => [p.getAttribute('data-level'), p]));
    expect(byLevel.get('1')!.getAttribute('data-to')).toBe('t2');
    expect(byLevel.get('2')!.getAttribute('data-from')).toBe('t2');
    expect(byLevel.get('2')!.getAttribute('data-to')).toBe('t1');
    const opacity = (p: SVGPathElement) => Number(p.getAttribute('stroke-opacity'));
    expect(opacity(byLevel.get('2')!)).toBeLessThan(opacity(byLevel.get('1')!));
  });

  it('ignores blockers that are no longer active', async () => {
    await serveTasks([
      task('t1', { name: 'Done blocker', status: 'done', blocking: ['t2'] }),
      task('t2', { name: 'Freed', blockedBy: ['t1'], blocked: false }),
    ]);
    (document.querySelector('#tree-filters .chip[data-status="done"]') as HTMLElement).click();
    expect(treeRow('t1')).not.toBeNull(); // the done blocker is on screen…
    hover(treeRow('t2'));
    expect(hoverPaths()).toHaveLength(0); // …but no line: it no longer blocks
  });
});

describe('tree dependency order', () => {
  const orderSelect = () => document.querySelector('#tree-order') as HTMLSelectElement;
  const setOrder = (value: string) => {
    orderSelect().value = value;
    orderSelect().dispatchEvent(new Event('change', { bubbles: true }));
  };

  beforeEach(() => clickTab('tree'));

  it('offers an order toggle that nests blocked tasks under their blockers', () => {
    expect(orderSelect()).not.toBeNull();
    expect(orderSelect().value).toBe('parents'); // hierarchy is the default
    setOrder('deps');
    // t3 waits on t1, so it nests under t1 now.
    const t1node = treeRow('t1').parentElement as HTMLElement;
    expect(t1node.querySelector('.tree-children .tree-row[data-id="t3"]')).not.toBeNull();
    // t2 is t1's child in the hierarchy but has no blockers: top level here.
    expect(treeRow('t2').closest('.tree-children')).toBeNull();
    expect(localStorage.getItem('planny-tree-order')).toBe('deps');
  });

  it('drops the parent-child progress bars in dependency order', () => {
    expect(document.querySelector('#tree-list .mini-progress')).not.toBeNull();
    setOrder('deps');
    expect(document.querySelector('#tree-list .mini-progress')).toBeNull();
  });

  it('switching back to hierarchy restores parent nesting', () => {
    setOrder('deps');
    setOrder('parents');
    const t1node = treeRow('t1').parentElement as HTMLElement;
    expect(t1node.querySelector('.tree-children .tree-row[data-id="t2"]')).not.toBeNull();
  });

  it('collapse works on dependency nodes too', () => {
    setOrder('deps');
    (treeRow('t1').querySelector('.twist') as HTMLElement).click();
    expect(treeRow('t3')).toBeNull(); // hidden under the collapsed blocker
    (treeRow('t1').querySelector('.twist') as HTMLElement).click();
    expect(treeRow('t3')).not.toBeNull();
  });

  it('a hand-edited dependency cycle still shows every task', async () => {
    await serveTasks([
      task('t1', { name: 'Chicken', blockedBy: ['t2'], blocked: true, blocking: ['t2'] }),
      task('t2', { name: 'Egg', blockedBy: ['t1'], blocked: true, blocking: ['t1'] }),
    ]);
    setOrder('deps');
    expect(treeRow('t1')).not.toBeNull();
    expect(treeRow('t2')).not.toBeNull();
  });
});
