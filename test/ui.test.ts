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
  tasks: [
    task('t1', { name: 'Build the API', blocking: ['t3'] }),
    task('t2', { name: 'Write tests', parent: 't1', status: 'in-progress', model: 'opus' }),
    task('t3', { name: 'Deploy', blockedBy: ['t1'], blocked: true }),
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

function bootApp(): Promise<void> {
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
  it('renders the board with columns, cards and badges', () => {
    const board = document.querySelector('#view-board')!;
    expect(board.textContent).toContain('Build the API');
    expect(board.textContent).toContain('Cancelled');
    expect(board.querySelector('.card.decision')).not.toBeNull();
    expect(board.textContent).toContain('waits on t1');
    expect(document.querySelector('#progress-text')!.textContent).toContain('20%');
  });

  it('renders the tree with nesting, per-parent progress and filters', () => {
    clickTab('tree');
    const tree = document.querySelector('#tree-list')!;
    expect(tree.querySelector('.tree-children')!.textContent).toContain('Write tests');
    expect(tree.querySelector('.mini-progress')).not.toBeNull();
    // Uncheck "done": t6 disappears; ancestors of matches stay.
    const doneBox = document.querySelector('input[data-status="done"]') as HTMLInputElement;
    doneBox.checked = false;
    doneBox.dispatchEvent(new Event('change'));
    expect(document.querySelector('#tree-list')!.textContent).not.toContain('Settled question');
  });

  it('renders the dependency graph as SVG nodes and edges', () => {
    clickTab('deps');
    const svg = document.querySelector('#deps-svg')!;
    expect(svg.querySelectorAll('.dep-node').length).toBe(2); // t1 and t3
    expect(svg.querySelectorAll('.dep-edge').length).toBe(1);
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

  it('accepting a decision posts a resolve', () => {
    clickTab('decisions');
    (document.querySelector('button[data-action="accept"][data-id="t4"]') as HTMLElement).click();
    const resolve = fetchCalls.find((c) => c.path === '/api/tasks/t4/resolve');
    expect(resolve).toBeDefined();
    expect(JSON.parse(resolve!.init!.body as string).response).toContain('Accepted');
  });

  it('quick actions on cards post status and bump', () => {
    (document.querySelector('button[data-action="start"][data-id="t1"]') as HTMLElement).click();
    expect(fetchCalls.some((c) => c.path === '/api/tasks/t1/status')).toBe(true);
    (document.querySelector('button[data-action="top"][data-id="t3"]') as HTMLElement).click();
    expect(fetchCalls.some((c) => c.path === '/api/tasks/t3/bump')).toBe(true);
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

  it('the description toggle expands the box without losing unsaved edits', () => {
    (document.querySelector('.card[data-id="t1"]') as HTMLElement).click();
    const textarea = document.querySelector('#f-desc') as HTMLTextAreaElement;
    textarea.value = 'unsaved edit';
    const toggle = document.querySelector('#desc-toggle') as HTMLElement;
    toggle.click();
    expect(textarea.classList.contains('expanded')).toBe(true);
    expect(textarea.value).toBe('unsaved edit');
    toggle.click();
    expect(textarea.classList.contains('expanded')).toBe(false);
    expect(textarea.value).toBe('unsaved edit');
  });

  it('the new-task drawer creates via POST', () => {
    (document.querySelector('#add-btn') as HTMLElement).click();
    (document.querySelector('#f-name') as HTMLInputElement).value = 'Brand new';
    (document.querySelector('#save-btn') as HTMLElement).click();
    const post = fetchCalls.find((c) => c.path === '/api/tasks' && c.init?.method === 'POST');
    expect(post).toBeDefined();
    expect(JSON.parse(post!.init!.body as string).name).toBe('Brand new');
  });
});
