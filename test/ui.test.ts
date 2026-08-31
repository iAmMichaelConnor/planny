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
    }),
    task('t3', { name: 'Deploy', blockedBy: ['t1'], blocked: true, position: 3 }),
    task('t4', {
      name: 'Choose hosting',
      type: 'decision',
      kind: 'operator',
      body: '## Background\n\nWe need a host.\n\n## Proposal\n\nUse **Fly.io**.\n\n- cheap\n- fast',
    }),
    task('t5', { name: 'Old idea', status: 'cancelled', replacedBy: ['t1'] }),
    task('t6', { name: 'Settled question', type: 'decision', status: 'done', body: '## Outcome\n\nDone deal.' }),
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

function bootApp(): Promise<void> {
  localStorage.clear(); // preferences persist per jsdom origin; each boot starts clean
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
          path === '/api/state' ? structuredClone(sampleState) : { task: task('t9'), warnings: [] },
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

beforeEach(async () => {
  await bootApp();
});

describe('ui smoke', () => {
  it('stacks the project name and directory under the planny title', () => {
    const label = document.querySelector('#store-label') as HTMLElement;
    expect(label.textContent).toContain('rocket');
    expect(label.textContent).toContain('/home/me/projects/rocket'); // visibly, not hover-only
    expect(label.parentElement!.id).toBe('brand'); // stacked in the brand column
    expect(label.parentElement!.querySelector('h1')).not.toBeNull();
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
    expect(document.querySelectorAll('#view-deps .legend .status-dot').length).toBe(4);

    card('t1').click();
    expect(document.querySelector('#drawer-title .status-dot')).not.toBeNull();
  });

  it('filters the dependency graph by status chips', () => {
    clickTab('deps');
    expect(document.querySelectorAll('#deps-status .chip').length).toBe(4);
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

  it('renders open and resolved decisions with markdown bodies', () => {
    clickTab('decisions');
    const view = document.querySelector('#view-decisions')!;
    expect(view.textContent).toContain('Choose hosting');
    expect(view.querySelector('.decision-body strong')!.textContent).toBe('Fly.io');
    expect(view.textContent).toContain('1 resolved decision');
    expect(view.textContent).toContain('Done deal.');
  });

  it('opens the drawer from a card and saves an edit via PATCH', () => {
    (document.querySelector('.card[data-id="t1"]') as HTMLElement).click();
    expect(document.querySelector('#drawer')!.classList.contains('hidden')).toBe(false);
    (document.querySelector('#f-name') as HTMLInputElement).value = 'Renamed';
    (document.querySelector('#save-btn') as HTMLElement).click();
    const patch = fetchCalls.find((c) => c.path === '/api/tasks/t1');
    expect(patch).toBeDefined();
    expect(patch!.init!.method).toBe('PATCH');
    expect(JSON.parse(patch!.init!.body as string).name).toBe('Renamed');
  });

  it('a skipped decision moves to a visible skipped list and can come back', () => {
    clickTab('decisions');
    (document.querySelector('button[data-action="skip"][data-id="t4"]') as HTMLElement).click();
    const view = document.querySelector('#view-decisions')!;
    expect(view.textContent).toContain('Skipped for now');
    expect(view.textContent).toContain('Choose hosting'); // still visible, not vanished
    expect(document.querySelector('textarea[data-role="response"][data-id="t4"]')).toBeNull();

    (document.querySelector('button[data-action="unskip"][data-id="t4"]') as HTMLElement).click();
    expect(document.querySelector('textarea[data-role="response"][data-id="t4"]')).not.toBeNull();
    expect(view.textContent).not.toContain('Skipped for now');
    // Skipping is a view preference: nothing was written to the store.
    expect(fetchCalls.some((c) => c.path.includes('/resolve') || c.path.includes('/status'))).toBe(
      false,
    );
  });

  it('accepting a decision posts a resolve', () => {
    clickTab('decisions');
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

  it('the drawer offers a Do-this copy button, with an honest tooltip', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    (document.querySelector('.card[data-id="t3"]') as HTMLElement).click();
    const button = document.querySelector('#copy-do') as HTMLElement;
    expect(button).not.toBeNull();
    expect(document.querySelector('#drawer-body')!.textContent).toContain('Do t3');
    expect(button.title).toMatch(/lazy/i);
    button.click();
    await new Promise((r) => setTimeout(r, 5));
    expect(writeText).toHaveBeenCalledWith('Do t3');
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
    const body = document.querySelector('#drawer-body')!.textContent!;
    expect(body).toContain('created by agent-7');
    expect(body).toContain('started by agent-7');
  });

  it('has no For you chip (removed by operator preference)', () => {
    expect(document.querySelector('#operator-chip')).toBeNull();
  });

  it('drawer top/bottom bumps ask for confirmation first', () => {
    (document.querySelector('.card[data-id="t1"]') as HTMLElement).click();
    const declined = vi.fn(() => false);
    vi.stubGlobal('confirm', declined);
    (document.querySelector('button[data-bump="top"]') as HTMLElement).click();
    expect(declined).toHaveBeenCalledOnce();
    expect(fetchCalls.some((c) => c.path === '/api/tasks/t1/bump')).toBe(false);

    vi.stubGlobal('confirm', vi.fn(() => true));
    (document.querySelector('button[data-bump="top"]') as HTMLElement).click();
    expect(fetchCalls.some((c) => c.path === '/api/tasks/t1/bump')).toBe(true);
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
