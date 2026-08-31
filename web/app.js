'use strict';

const $ = (sel) => document.querySelector(sel);

const state = {
  data: null,
  byId: new Map(),
  view: 'board',
  selected: null, // task id shown in the drawer, or '__new__'
  collapsed: new Set(),
  skippedDecisions: new Set(),
  depsMode: readPreference('planny-deps-mode', 'blocks'),
  treeFilters: {
    statuses: new Set(['todo', 'in-progress']),
    kinds: new Set(), // empty set = no filter
    types: new Set(),
    showDeps: true,
  },
  depsStatuses: new Set(['todo', 'in-progress']),
  boardFilters: { kinds: new Set(), types: new Set() },
  drawerDock: readPreference('planny-drawer-dock', 'right'),
  drawerDirty: false, // unsaved form edits: background refreshes must not clobber them
  renderedDrawerId: null,
  descExpanded: readPreference('planny-desc-expanded', '1') === '1',
};

/** Guardrail for manual state changes: the agent usually does these. */
function guard(question) {
  return confirm(
    `${question}\n\nTip: an AI agent working this plan can make these changes for you — consider asking it instead.`,
  );
}

function readPreference(key, fallback) {
  try {
    return localStorage.getItem(key) || fallback;
  } catch {
    return fallback;
  }
}

function writePreference(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode: the preference just does not stick */
  }
}

// ---------- data ----------

async function refresh() {
  const res = await fetch('/api/state');
  state.data = await res.json();
  state.byId = new Map(state.data.tasks.map((t) => [t.id, t]));
  render();
}

async function api(path, method, body, retried = false) {
  try {
    const res = await fetch(path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) {
      // Lock contention is transient (an agent mid-write; stale locks
      // self-break), so one silent retry usually clears it. The failed
      // attempt wrote nothing, so retrying is safe.
      if (!retried && typeof data.error === 'string' && data.error.includes('locked by another planny process')) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        return api(path, method, body, true);
      }
      // A claim conflict offers a deliberate takeover instead of a dead end.
      if (
        typeof data.error === 'string' &&
        data.error.includes('--take') &&
        confirm(`${data.error.split(' — ')[0]}.\n\nTake it over?`)
      ) {
        return api(path, method, { ...body, take: true });
      }
      toast(data.error || 'request failed', 'error');
      return null;
    }
    for (const w of data.warnings || []) toast(w, 'warn');
    await refresh();
    return data;
  } catch (err) {
    toast(err.message, 'error');
    return null;
  }
}

// ---------- helpers ----------

function esc(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

function toast(message, cls = '') {
  const div = document.createElement('div');
  div.className = `toast ${cls}`;
  div.textContent = message;
  $('#toasts').appendChild(div);
  setTimeout(() => div.remove(), 4500);
}

function childrenOf(id) {
  return state.data.tasks.filter((t) => t.parent === id);
}

function activeTasks() {
  return state.data.tasks.filter((t) => t.status === 'todo' || t.status === 'in-progress');
}

function ancestorsOf(id) {
  const out = [];
  let current = state.byId.get(id);
  const seen = new Set([id]);
  while (current && current.parent && state.byId.has(current.parent) && !seen.has(current.parent)) {
    current = state.byId.get(current.parent);
    out.push(current);
    seen.add(current.id);
  }
  return out;
}

function subtreeCounts(id) {
  let done = 0;
  let total = 0;
  const walk = (taskId) => {
    const task = state.byId.get(taskId);
    if (!task) return;
    if (task.status !== 'cancelled') {
      total += 1;
      if (task.status === 'done') done += 1;
    }
    for (const child of childrenOf(taskId)) walk(child.id);
  };
  walk(id);
  return { done, total };
}

function badges(task) {
  const parts = [];
  if (task.type === 'decision') parts.push('<span class="badge decision">decision</span>');
  if (task.kind !== 'ai') parts.push(`<span class="badge operator">${esc(task.kind)}</span>`);
  if (task.model) parts.push(`<span class="badge">${esc(task.model)}</span>`);
  if (task.blocked) {
    const blockers = task.blockedBy.filter((id) => {
      const b = state.byId.get(id);
      return b && (b.status === 'todo' || b.status === 'in-progress');
    });
    const links = blockers
      .map((id) => `<span class="chip-link" data-goto-task="${esc(id)}">${esc(id)}</span>`)
      .join(', ');
    parts.push(`<span class="badge blocked">waits on ${links}</span>`);
  }
  return parts.join('');
}

// ---------- filter chips ----------

const ALL_STATUSES = ['todo', 'in-progress', 'done', 'cancelled'];

function chip(scope, attr, value, label, active) {
  return `<button class="chip${active ? ' active' : ''}" data-scope="${scope}" data-${attr}="${esc(value)}">${label}</button>`;
}

function statusChips(scope, activeSet) {
  return ALL_STATUSES.map((s) =>
    chip(scope, 'status', s, `<span class="status-dot ${s}"></span>${s.replace('-', ' ')}`, activeSet.has(s)),
  ).join('');
}

function kindChips(scope, activeSet) {
  const kinds = [...new Set(state.data.tasks.map((t) => t.kind))].sort();
  if (kinds.length < 2) return '';
  return kinds.map((k) => chip(scope, 'kind', k, esc(k), activeSet.has(k))).join('');
}

function typeChips(scope, activeSet) {
  return ['task', 'decision'].map((t) => chip(scope, 'type', t, t, activeSet.has(t))).join('');
}

function toggleInSet(set, value) {
  if (set.has(value)) set.delete(value);
  else set.add(value);
}

// Tiny markdown renderer for decision bodies: headings, bold, italic,
// inline code, bullet lists, paragraphs.
function renderMarkdown(text) {
  const inline = (s) =>
    esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>');
  const blocks = text.split(/\n{2,}/);
  return blocks
    .map((block) => {
      const heading = /^(#{1,4})\s+(.*)$/.exec(block.trim());
      if (heading) {
        const level = Math.min(heading[1].length + 1, 5);
        return `<h${level}>${inline(heading[2])}</h${level}>`;
      }
      const lines = block.split('\n');
      if (lines.every((l) => /^\s*[-*]\s+/.test(l))) {
        return `<ul>${lines.map((l) => `<li>${inline(l.replace(/^\s*[-*]\s+/, ''))}</li>`).join('')}</ul>`;
      }
      return `<p>${lines.map(inline).join('<br>')}</p>`;
    })
    .join('\n');
}

// ---------- rendering ----------

function render() {
  const { progress } = state.data;
  const label = $('#store-label');
  label.textContent = state.data.store ? state.data.store.name : '';
  label.title = state.data.store ? state.data.store.root : '';
  $('#progress-fill').style.width = `${progress.percent}%`;
  $('#progress-text').textContent = `${progress.percent}% · ${progress.done}/${progress.total} done`;
  const openCount = state.data.decisions.filter((d) => !d.blocked).length;
  $('#decision-count').textContent = openCount > 0 ? `(${openCount})` : '';

  for (const tab of document.querySelectorAll('.tab')) {
    tab.classList.toggle('active', tab.dataset.view === state.view);
  }
  for (const view of document.querySelectorAll('.view')) view.classList.add('hidden');
  $(`#view-${state.view}`).classList.remove('hidden');

  if (state.view === 'board') renderBoard();
  if (state.view === 'tree') renderTree();
  if (state.view === 'deps') renderDeps();
  if (state.view === 'decisions') renderDecisions();
  renderDrawer();
}

function cardHtml(task, position) {
  const quick = [];
  if (task.status === 'todo') quick.push(`<button data-action="start" data-id="${task.id}">start</button>`);
  if (task.status === 'in-progress') quick.push(`<button data-action="finish" data-id="${task.id}">done</button>`);
  if (task.status === 'todo' || task.status === 'in-progress') {
    quick.push(`<button data-action="top" data-id="${task.id}" title="bump to top">▲ top</button>`);
  }
  const classes = [
    'card',
    `st-${task.status}`,
    task.type === 'decision' ? 'decision' : '',
    task.blocked ? 'blocked-card' : '',
  ];
  const pos = position !== undefined
    ? `<span class="pos" title="priority position among active tasks">#${position}</span>`
    : '';
  return `<div class="${classes.join(' ')}" data-id="${task.id}">
    ${pos}<span class="id">${task.id}</span><span class="name">${esc(task.name)}</span>
    <div class="badges">${badges(task)}</div>
    <div class="quick">${quick.join('')}</div>
  </div>`;
}

function renderBoard() {
  const f = state.boardFilters;
  $('#board-filters').innerHTML =
    `<span class="chip-group">${kindChips('board', f.kinds)}</span>` +
    `<span class="chip-group">${typeChips('board', f.types)}</span>`;
  const visible = (t) =>
    (f.kinds.size === 0 || f.kinds.has(t.kind)) && (f.types.size === 0 || f.types.has(t.type));

  const columns = [
    ['todo', 'To do'],
    ['in-progress', 'In progress'],
    ['done', 'Done'],
    ['cancelled', 'Cancelled'],
  ];
  $('#board-columns').innerHTML = columns
    .filter(([status]) => status !== 'cancelled' || state.data.tasks.some((t) => t.status === status))
    .map(([status, title]) => {
      const ordered = status === 'todo' || status === 'in-progress'
        ? ' <span class="colsub">priority order ↓</span>'
        : '';
      const cards = state.data.tasks
        .filter((t) => t.status === status && visible(t))
        .map((t) => cardHtml(t, t.position > 0 ? t.position : undefined))
        .join('');
      return `<div class="column"><h2><span class="status-dot ${status}"></span>${title}${ordered}</h2>${cards || '<p class="muted">—</p>'}</div>`;
    })
    .join('');
}

function renderTree() {
  const filters = state.treeFilters;
  $('#tree-filters').innerHTML =
    `<span class="chip-group">${statusChips('tree', filters.statuses)}</span>` +
    `<span class="chip-group">${kindChips('tree', filters.kinds)}</span>` +
    `<span class="chip-group">${typeChips('tree', filters.types)}</span>` +
    `<span class="chip-group"><button class="chip${filters.showDeps ? ' active' : ''}" data-scope="tree" data-toggle="deps">show dependencies</button></span>`;

  const matches = (t) =>
    filters.statuses.has(t.status) &&
    (filters.kinds.size === 0 || filters.kinds.has(t.kind)) &&
    (filters.types.size === 0 || filters.types.has(t.type));
  const visible = new Set();
  for (const task of state.data.tasks) {
    if (!matches(task)) continue;
    visible.add(task.id);
    for (const a of ancestorsOf(task.id)) visible.add(a.id);
  }

  const nodeHtml = (task) => {
    if (!visible.has(task.id)) return '';
    const children = childrenOf(task.id);
    const isCollapsed = state.collapsed.has(task.id);
    const twist = children.length > 0
      ? `<span class="twist" data-action="toggle" data-id="${task.id}">${isCollapsed ? '▸' : '▾'}</span>`
      : '<span class="twist"></span>';
    let progressHtml = '';
    if (children.length > 0) {
      const { done, total } = subtreeCounts(task.id);
      if (total > 0) {
        progressHtml = `<span class="mini-progress" title="${done}/${total} done"><div style="width:${Math.round((done / total) * 100)}%"></div></span><span class="muted" style="font-size:11px">${done}/${total}</span>`;
      }
    }
    const row = `<div class="tree-row" data-id="${task.id}">
      ${twist}<span class="status-dot ${task.status}"></span>
      <span class="id">${task.id}</span>
      <span class="name${task.status === 'done' ? ' done-name' : ''}">${esc(task.name)}</span>
      ${progressHtml}${state.treeFilters.showDeps ? badges(task) : badges({ ...task, blocked: false })}
    </div>`;
    const childHtml = !isCollapsed && children.length > 0
      ? `<div class="tree-children">${children.map(nodeHtml).join('')}</div>`
      : '';
    return `<div class="tree-node">${row}${childHtml}</div>`;
  };

  const roots = state.data.tasks.filter((t) => !t.parent || !state.byId.has(t.parent));
  $('#tree-list').innerHTML =
    roots.map(nodeHtml).join('') || '<p class="muted">No tasks match the filters.</p>';
}

function renderDeps() {
  const mode = state.depsMode; // 'blocks' | 'blocked-by'
  $('#deps-mode').value = mode;
  $('#deps-status').innerHTML = statusChips('deps', state.depsStatuses);
  $('#deps-hint').textContent =
    mode === 'blocks'
      ? 'Arrows point from a blocker to the task it blocks: A → B means A blocks B, so B waits on A. Blockers sit left. Hover an arrow for its two ends; click a task to edit it.'
      : 'Arrows point from a task to what it waits on: A → B means A is blocked by B. Blocked tasks sit left. Hover an arrow for its two ends; click a task to edit it.';

  const visibleIds = new Set(
    state.data.tasks.filter((t) => state.depsStatuses.has(t.status)).map((t) => t.id),
  );
  const involved = state.data.tasks.filter(
    (t) =>
      visibleIds.has(t.id) &&
      (t.blockedBy.some((id) => visibleIds.has(id)) ||
        t.blocking.some((id) => visibleIds.has(id))),
  );
  const scroll = $('#deps-scroll');
  if (involved.length === 0) {
    scroll.innerHTML = '<p class="muted" style="padding:16px">No dependencies between tasks.</p>';
    return;
  }
  if (!$('#deps-svg')) scroll.innerHTML = '<svg id="deps-svg"></svg>';

  const layerOf = new Map();
  const layer = (id, trail = new Set()) => {
    if (layerOf.has(id)) return layerOf.get(id);
    if (trail.has(id)) return 0;
    trail.add(id);
    const task = state.byId.get(id);
    const blockers = task.blockedBy.filter((b) => visibleIds.has(b));
    const value = blockers.length === 0 ? 0 : 1 + Math.max(...blockers.map((b) => layer(b, trail)));
    layerOf.set(id, value);
    return value;
  };
  for (const t of involved) layer(t.id);

  const perLayer = new Map();
  const position = new Map();
  for (const t of involved) {
    const l = layerOf.get(t.id);
    const row = perLayer.get(l) || 0;
    perLayer.set(l, row + 1);
    position.set(t.id, { l, row });
  }
  const boxW = 200;
  const boxH = 48;
  const gapX = 70;
  const gapY = 18;
  const maxLayer = Math.max(...layerOf.values());
  const maxRows = Math.max(...perLayer.values());
  // In blocked-by mode the whole layout mirrors: blocked tasks sit left.
  const x = (l) => 20 + (mode === 'blocked-by' ? maxLayer - l : l) * (boxW + gapX);
  const y = (row) => 20 + row * (boxH + gapY);

  const edges = [];
  const label = mode === 'blocks' ? 'blocks' : 'is blocked by';
  for (const t of involved) {
    for (const b of t.blockedBy) {
      if (!position.has(b)) continue;
      // The arrow leaves the left-hand box and lands on the right-hand one:
      // blocker → blocked when reading "blocks", blocked → blocker mirrored.
      const from = position.get(mode === 'blocks' ? b : t.id);
      const to = position.get(mode === 'blocks' ? t.id : b);
      const x1 = x(from.l) + boxW;
      const y1 = y(from.row) + boxH / 2;
      const x2 = x(to.l);
      const y2 = y(to.row) + boxH / 2;
      const mid = (x1 + x2) / 2;
      edges.push(
        `<path class="dep-edge" d="M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2 - 6},${y2}"><title>${esc(b)} blocks ${esc(t.id)} — ${esc(t.id)} waits on ${esc(b)}</title></path>`,
        `<text class="dep-label" x="${mid}" y="${(y1 + y2) / 2 - 5}" text-anchor="middle">${label}</text>`,
      );
    }
  }
  const nodes = involved.map((t) => {
    const { l, row } = position.get(t.id);
    const name = t.name.length > 26 ? `${t.name.slice(0, 25)}…` : t.name;
    const cls = t.status === 'done' || t.status === 'cancelled' ? 'dep-node done' : 'dep-node';
    return `<g class="${cls}" data-id="${t.id}" transform="translate(${x(l)},${y(row)})">
      <rect width="${boxW}" height="${boxH}"/>
      <rect class="statusbar ${t.status}" x="1" y="1" width="4" height="${boxH - 2}"/>
      <text x="12" y="20">${esc(t.id)} ${esc(name)}</text>
      <text x="10" y="36" class="sub">${t.status}${t.type === 'decision' ? ' · decision' : ''}</text>
    </g>`;
  });
  const svg = $('#deps-svg');
  svg.setAttribute('width', x(mode === 'blocked-by' ? 0 : maxLayer) + boxW + 20);
  svg.setAttribute('height', y(maxRows - 1) + boxH + 20);
  svg.innerHTML = `<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="currentColor" opacity="0.65"/></marker></defs>${edges.join('')}${nodes.join('')}`;
}

function renderDecisions() {
  const view = $('#view-decisions');
  // A background refresh must not eat a half-typed response: carry drafts
  // (and focus) across the rebuild.
  const drafts = new Map();
  let focusedId = null;
  for (const textarea of view.querySelectorAll('textarea[data-role="response"]')) {
    if (textarea.value !== '') drafts.set(textarea.dataset.id, textarea.value);
    if (document.activeElement === textarea) focusedId = textarea.dataset.id;
  }
  const all = state.data.decisions
    .map(({ id, blocked }) => ({ task: state.byId.get(id), blocked }))
    .filter((d) => d.task);
  const items = all.filter((d) => !state.skippedDecisions.has(d.task.id));
  const skipped = all.filter((d) => state.skippedDecisions.has(d.task.id));
  const past = state.data.tasks.filter((t) => t.type === 'decision' && t.status === 'done');

  const openHtml = items.map(({ task, blocked }) => {
    const actions = blocked
      ? `<p class="muted">Waiting on ${esc(task.blockedBy.join(', '))} — answer those first.</p>`
      : `<div class="decision-actions">
          <textarea placeholder="Your decision (free-form)…" data-role="response" data-id="${task.id}"></textarea>
          <div style="display:flex;flex-direction:column;gap:6px">
            <button class="primary" data-action="respond" data-id="${task.id}">Respond</button>
            <button data-action="accept" data-id="${task.id}">Accept proposal</button>
            <button data-action="skip" data-id="${task.id}">Skip for now</button>
          </div>
        </div>`;
    return `<div class="decision-card${blocked ? ' blocked' : ''}">
      <h3><span class="id muted">${task.id}</span> ${esc(task.name)}</h3>
      <div class="badges">${badges(task)}</div>
      <div class="decision-body">${renderMarkdown(task.body || '_no detail_')}</div>
      ${actions}
    </div>`;
  });

  const pastHtml = past.length > 0
    ? `<details><summary class="muted">${past.length} resolved decision${past.length === 1 ? '' : 's'}</summary>
        ${past.map((t) => `<div class="decision-card"><h3><span class="id muted">${t.id}</span> ${esc(t.name)}</h3><div class="decision-body">${renderMarkdown(t.body)}</div></div>`).join('')}
       </details>`
    : '';

  const skippedHtml = skipped.length > 0
    ? `<div class="skipped-list">
        <h4 class="muted">Skipped for now (still open)</h4>
        ${skipped
          .map(
            ({ task }) => `<div class="skipped-row">
              <span class="id muted">${task.id}</span> ${esc(task.name)}
              <button class="mini" data-action="unskip" data-id="${task.id}">bring back</button>
            </div>`,
          )
          .join('')}
      </div>`
    : '';

  view.innerHTML =
    (openHtml.join('') || '<p class="muted">No open decisions.</p>') + skippedHtml + pastHtml;

  for (const [id, value] of drafts) {
    const textarea = view.querySelector(`textarea[data-role="response"][data-id="${id}"]`);
    if (textarea) textarea.value = value;
  }
  if (focusedId !== null) {
    const textarea = view.querySelector(`textarea[data-role="response"][data-id="${focusedId}"]`);
    if (textarea) {
      textarea.focus();
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    }
  }
}

// ---------- drawer ----------

function renderDrawer() {
  const drawer = $('#drawer');
  if (state.selected === null) {
    drawer.classList.add('hidden');
    state.renderedDrawerId = null;
    state.drawerDirty = false;
    return;
  }
  drawer.classList.remove('hidden');
  // A background refresh must not rebuild a form the user is editing.
  if (state.selected === state.renderedDrawerId && state.drawerDirty) return;
  const isNew = state.selected === '__new__';
  const task = isNew
    ? { name: '', body: '', type: 'task', kind: 'ai', model: '', parent: '', blockedBy: [], status: 'todo' }
    : state.byId.get(state.selected);
  if (!task) {
    state.selected = null;
    drawer.classList.add('hidden');
    return;
  }
  $('#drawer-title').innerHTML = isNew
    ? 'New task'
    : `<span class="status-dot ${esc(task.status)}"></span>${esc(task.id)} · ${esc(task.status)}`;

  const options = state.data.tasks
    .map((t) => `<option value="${t.id}">${t.id} ${esc(t.name)}</option>`)
    .join('');
  const active = activeTasks();
  const positionValue = task.position ?? 0; // served by the API; 0 when inactive or new

  const startedEntry = task.status === 'in-progress'
    ? [...(task.history || [])].reverse().find((e) => e.status === 'in-progress')
    : undefined;
  const activity = [
    ...(task.createdBy ? [`created by ${esc(task.createdBy)}`] : []),
    ...(startedEntry
      ? [`started by ${esc(startedEntry.by || '(unattributed)')} at ${esc(startedEntry.at)}`]
      : []),
  ];
  const relSection = isNew ? '' : `
    <div class="drawer-section">
      ${activity.length > 0 ? `<label>activity</label><div>${activity.join(' · ')}</div>` : ''}
      ${ancestorsOf(task.id).length > 0 ? `<label>path</label><div>${ancestorsOf(task.id).reverse().map((a) => `${a.id} ${esc(a.name)}`).join(' › ')}</div>` : ''}
      ${childrenOf(task.id).length > 0 ? `<label>children</label><ul class="rel-list">${childrenOf(task.id).map((c) => `<li data-goto="${c.id}">${c.id} ${esc(c.name)} — ${c.status}</li>`).join('')}</ul>` : ''}
      ${task.blocking.length > 0 ? `<label>blocks</label><ul class="rel-list">${task.blocking.map((id) => { const b = state.byId.get(id); return `<li data-goto="${id}">${id} ${esc(b ? b.name : '')}</li>`; }).join('')}</ul>` : ''}
      <label>file</label><div class="file-path">.planny/tasks/${task.id}.md</div>
    </div>`;

  const statusButtons = isNew ? '' : `
    <label>status</label>
    <div class="status-buttons">
      ${['todo', 'in-progress', 'done'].map((s) => `<button data-status="${s}" class="${task.status === s ? 'current' : ''}">${s}</button>`).join('')}
      <button data-status="cancelled" class="${task.status === 'cancelled' ? 'current' : ''}">cancel…</button>
    </div>
    <div id="cancel-extra" class="hidden">
      <label>replaced by (comma-separated ids, optional)</label>
      <input id="f-replaced-by" placeholder="t4, t5">
      <button id="confirm-cancel" style="margin-top:6px">Confirm cancel</button>
    </div>`;

  const resolveSection = !isNew && task.type === 'decision' && (task.status === 'todo' || task.status === 'in-progress')
    ? `<div class="drawer-section">
        <label>resolve this decision</label>
        <textarea id="f-resolution" placeholder="The decision, free-form…"></textarea>
        <div class="row" style="margin-top:6px">
          <button class="primary" id="resolve-btn">Resolve</button>
          <button id="accept-btn">Accept proposal</button>
        </div>
      </div>`
    : '';

  const prioritySection = isNew
    ? `<label>priority</label>
       <select id="f-priority"><option value="bottom">bottom of list</option><option value="top">top of list</option></select>`
    : `<label>priority position (of ${active.length} active)</label>
       <div class="row">
         <input id="f-position" type="number" min="1" value="${positionValue > 0 ? positionValue : ''}" ${positionValue > 0 ? '' : 'disabled'}>
         ${positionValue > 0 ? '<button id="set-position" title="move to the typed position">set</button>' : ''}
         <button data-bump="top" title="move to the top of the priority order">▲ top</button>
         <button data-bump="bottom" title="move to the bottom of the priority order">▼ bottom</button>
       </div>`;

  $('#drawer-body').innerHTML = `
    <label>name</label><input id="f-name" value="${esc(task.name)}">
    <label>description (markdown)
      <button id="desc-toggle" type="button" class="mini">${state.descExpanded ? 'collapse' : 'expand'}</button>
    </label>
    <textarea id="f-desc" class="desc-area${state.descExpanded ? ' expanded' : ''}">${esc(task.body)}</textarea>
    ${resolveSection}
    <div class="row">
      <div><label>type</label><select id="f-type">
        <option value="task"${task.type === 'task' ? ' selected' : ''}>task</option>
        <option value="decision"${task.type === 'decision' ? ' selected' : ''}>decision</option>
      </select></div>
      <div><label>kind (owner)</label><select id="f-kind">
        ${[...new Set(['ai', 'operator', ...state.data.tasks.map((t) => t.kind), task.kind])]
          .filter(Boolean)
          .map((k) => `<option value="${esc(k)}"${k === task.kind ? ' selected' : ''}>${esc(k)}</option>`)
          .join('')}
        <option value="__custom">custom…</option>
      </select></div>
    </div>
    <div class="row">
      <div><label>model (optional)</label><input id="f-model" value="${esc(task.model || '')}"></div>
      <div><label>parent (optional)</label><input id="f-parent" list="task-ids" value="${esc(task.parent || '')}">
        <datalist id="task-ids">${options}</datalist></div>
    </div>
    <label>waits on (comma-separated ids)</label>
    <input id="f-blocked-by" value="${esc(task.blockedBy.join(', '))}">
    ${prioritySection}
    <div style="margin-top:14px"><button class="primary" id="save-btn">${isNew ? 'Create task' : 'Save changes'}</button></div>
    ${statusButtons}
    ${relSection}`;

  wireDrawer(task, isNew);
  state.renderedDrawerId = state.selected;
  state.drawerDirty = false;
}

function parseIdList(value) {
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}

function wireDrawer(task, isNew) {
  const body = $('#drawer-body');
  // Expanded means full: the box fits its whole content and the drawer
  // scrolls, so there is never a scrollbar inside the box.
  const autosizeDesc = () => {
    const textarea = $('#f-desc');
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.max(textarea.scrollHeight, 240)}px`;
  };
  $('#desc-toggle').onclick = () => {
    // Toggle in place: a re-render would drop unsaved edits in the form.
    state.descExpanded = !state.descExpanded;
    writePreference('planny-desc-expanded', state.descExpanded ? '1' : '0');
    const textarea = $('#f-desc');
    textarea.classList.toggle('expanded', state.descExpanded);
    $('#desc-toggle').textContent = state.descExpanded ? 'collapse' : 'expand';
    if (state.descExpanded) autosizeDesc();
    else textarea.style.height = '';
  };
  $('#f-desc').addEventListener('input', () => {
    if (state.descExpanded) autosizeDesc();
  });
  if (state.descExpanded) autosizeDesc();

  // "custom…" turns the kind select into a free-form input: ai and
  // operator are the conventional kinds, but the store accepts new ones.
  $('#f-kind').addEventListener('change', () => {
    const select = $('#f-kind');
    if (select.value !== '__custom') return;
    const input = document.createElement('input');
    input.id = 'f-kind';
    input.placeholder = 'new kind…';
    select.replaceWith(input);
    input.focus();
  });
  $('#save-btn').onclick = () => {
    state.drawerDirty = false; // saving hands the form back to refreshes
    const fields = {
      name: $('#f-name').value,
      body: $('#f-desc').value,
      type: $('#f-type').value,
      kind: $('#f-kind').value || 'ai',
      model: $('#f-model').value || null,
      parent: $('#f-parent').value || null,
    };
    const blockedBy = parseIdList($('#f-blocked-by').value);
    if (isNew) {
      api('/api/tasks', 'POST', {
        ...fields,
        model: fields.model || undefined,
        parent: fields.parent || undefined,
        blockedBy,
        priority: $('#f-priority').value,
      }).then((res) => {
        if (res) state.selected = res.task.id;
      });
      return;
    }
    const addBlockedBy = blockedBy.filter((id) => !task.blockedBy.includes(id));
    const removeBlockedBy = task.blockedBy.filter((id) => !blockedBy.includes(id));
    api(`/api/tasks/${task.id}`, 'PATCH', { ...fields, addBlockedBy, removeBlockedBy });
  };

  if (!isNew) {
    for (const btn of body.querySelectorAll('[data-status]')) {
      btn.onclick = () => {
        if (btn.dataset.status === 'cancelled') {
          $('#cancel-extra').classList.toggle('hidden');
          return;
        }
        if (!guard(`Mark ${task.id} ${btn.dataset.status}?`)) return;
        api(`/api/tasks/${task.id}/status`, 'POST', { status: btn.dataset.status });
      };
    }
    const confirmCancel = $('#confirm-cancel');
    if (confirmCancel) {
      confirmCancel.onclick = () => {
        if (!guard(`Cancel ${task.id}?`)) return;
        api(`/api/tasks/${task.id}/status`, 'POST', {
          status: 'cancelled',
          replacedBy: parseIdList($('#f-replaced-by').value),
        });
      };
    }
    for (const btn of body.querySelectorAll('[data-bump]')) {
      btn.onclick = () => {
        if (!guard(`Move ${task.id} to the ${btn.dataset.bump} of the priority order?`)) return;
        api(`/api/tasks/${task.id}/bump`, 'POST', { target: btn.dataset.bump });
      };
    }
    const setPosition = $('#set-position');
    if (setPosition) {
      setPosition.onclick = () => {
        const position = Number($('#f-position').value);
        if (!guard(`Move ${task.id} to position ${position}?`)) return;
        api(`/api/tasks/${task.id}/bump`, 'POST', { target: position });
      };
    }
    const resolveBtn = $('#resolve-btn');
    if (resolveBtn) {
      resolveBtn.onclick = () => {
        const text = $('#f-resolution').value.trim();
        if (text === '') {
          toast('write the decision first, or use Accept proposal', 'warn');
          return;
        }
        api(`/api/tasks/${task.id}/resolve`, 'POST', { response: text });
      };
      $('#accept-btn').onclick = () =>
        api(`/api/tasks/${task.id}/resolve`, 'POST', { response: 'Accepted the proposal.' });
    }
    for (const li of body.querySelectorAll('[data-goto]')) {
      li.onclick = () => {
        state.selected = li.dataset.goto;
        renderDrawer();
      };
    }
  }
}

// ---------- events ----------

document.addEventListener('click', (event) => {
  const filterChip = event.target.closest('.chip[data-scope]');
  if (filterChip) {
    const { scope, status, kind, type, toggle } = filterChip.dataset;
    if (scope === 'deps') {
      toggleInSet(state.depsStatuses, status);
      renderDeps();
    } else {
      const f = scope === 'tree' ? state.treeFilters : state.boardFilters;
      if (status !== undefined) toggleInSet(f.statuses, status);
      else if (kind !== undefined) toggleInSet(f.kinds, kind);
      else if (type !== undefined) toggleInSet(f.types, type);
      else if (toggle === 'deps') f.showDeps = !f.showDeps;
      (scope === 'tree' ? renderTree : renderBoard)();
    }
    return;
  }

  const chipLink = event.target.closest('[data-goto-task]');
  if (chipLink) {
    event.stopPropagation();
    state.selected = chipLink.dataset.gotoTask;
    renderDrawer();
    return;
  }

  const actionEl = event.target.closest('[data-action]');
  if (actionEl) {
    const { action, id } = actionEl.dataset;
    event.stopPropagation();
    if (action === 'toggle') {
      state.collapsed.has(id) ? state.collapsed.delete(id) : state.collapsed.add(id);
      renderTree();
      return;
    }
    if (action === 'start') {
      if (guard(`Start ${id} (mark it in progress)?`)) api(`/api/tasks/${id}/status`, 'POST', { status: 'in-progress' });
      return;
    }
    if (action === 'finish') {
      if (guard(`Mark ${id} done?`)) api(`/api/tasks/${id}/status`, 'POST', { status: 'done' });
      return;
    }
    if (action === 'top') {
      if (guard(`Move ${id} to the top of the priority order?`)) api(`/api/tasks/${id}/bump`, 'POST', { target: 'top' });
      return;
    }
    if (action === 'skip') {
      state.skippedDecisions.add(id);
      renderDecisions();
      return;
    }
    if (action === 'unskip') {
      state.skippedDecisions.delete(id);
      renderDecisions();
      return;
    }
    if (action === 'accept') return void api(`/api/tasks/${id}/resolve`, 'POST', { response: 'Accepted the proposal.' });
    if (action === 'respond') {
      const textarea = document.querySelector(`textarea[data-role="response"][data-id="${id}"]`);
      const text = textarea ? textarea.value.trim() : '';
      if (text === '') {
        toast('write the decision first, or use Accept proposal', 'warn');
        return;
      }
      return void api(`/api/tasks/${id}/resolve`, 'POST', { response: text });
    }
  }

  const tab = event.target.closest('.tab');
  if (tab) {
    state.view = tab.dataset.view;
    render();
    return;
  }

  const opener = event.target.closest('.card[data-id], .tree-row[data-id], .dep-node[data-id]');
  if (opener) {
    state.selected = opener.dataset.id;
    renderDrawer();
    return;
  }

  // A click on dead space, anywhere outside the drawer, closes it.
  if (
    state.selected !== null &&
    !event.target.closest('#drawer') &&
    !event.target.closest('button, input, select, textarea, label, a, summary')
  ) {
    if (state.drawerDirty && !confirm('Close the panel and discard unsaved changes?')) return;
    state.selected = null;
    renderDrawer();
  }
});

/** Side docks start below the header so the tabs stay reachable. */
function positionDrawer() {
  $('#drawer').style.top =
    state.drawerDock === 'bottom' ? '' : `${document.querySelector('header').offsetHeight}px`;
}

function applyDock() {
  const drawer = $('#drawer');
  drawer.classList.toggle('dock-left', state.drawerDock === 'left');
  drawer.classList.toggle('dock-bottom', state.drawerDock === 'bottom');
  drawer.style.width = '';
  drawer.style.height = '';
  positionDrawer();
  for (const btn of document.querySelectorAll('.dock-btn')) {
    btn.classList.toggle('active', btn.dataset.dock === state.drawerDock);
  }
}

for (const btn of document.querySelectorAll('.dock-btn')) {
  btn.onclick = () => {
    state.drawerDock = btn.dataset.dock;
    writePreference('planny-drawer-dock', state.drawerDock);
    applyDock();
  };
}
applyDock();

{
  // Drag the drawer's inner edge to resize it: width when docked to a side,
  // height when docked to the bottom.
  let dragging = false;
  $('#drawer-resize').addEventListener('mousedown', (event) => {
    dragging = true;
    event.preventDefault();
  });
  document.addEventListener('mousemove', (event) => {
    if (!dragging) return;
    const drawer = $('#drawer');
    if (state.drawerDock === 'bottom') {
      const height = Math.min(
        Math.max(window.innerHeight - event.clientY, 160),
        Math.round(window.innerHeight * 0.9),
      );
      drawer.style.height = `${height}px`;
      return;
    }
    const along = state.drawerDock === 'left' ? event.clientX : window.innerWidth - event.clientX;
    const width = Math.min(Math.max(along, 320), Math.round(window.innerWidth * 0.95));
    drawer.style.width = `${width}px`;
  });
  document.addEventListener('mouseup', () => {
    dragging = false;
  });
}

function openNewTaskForm() {
  $('#add-note').classList.add('hidden');
  state.selected = '__new__';
  renderDrawer();
}

$('#add-btn').onclick = () => {
  if (readPreference('planny-add-note-dismissed', '') === '1') {
    openNewTaskForm();
    return;
  }
  $('#add-note').classList.remove('hidden');
};
$('#add-note-continue').onclick = openNewTaskForm;
$('#add-note-dismiss').onclick = () => {
  writePreference('planny-add-note-dismissed', '1');
  openNewTaskForm();
};
$('#drawer-body').addEventListener('input', () => {
  state.drawerDirty = true;
});
window.addEventListener('resize', positionDrawer);
if (typeof EventSource !== 'undefined') {
  // The server pushes an event whenever any task file changes (CLI edits included).
  const stream = new EventSource('/api/events');
  stream.onmessage = () => refresh();
  // A (re)connect means events may have been missed — a server restart, a
  // dropped connection — so catch up immediately.
  stream.onopen = () => refresh();
}
document.addEventListener('visibilitychange', () => {
  // Background tabs get throttled and can miss events.
  if (!document.hidden) refresh();
});
$('#drawer-close').onclick = () => {
  state.selected = null;
  renderDrawer();
};
$('#deps-mode').addEventListener('change', () => {
  state.depsMode = $('#deps-mode').value;
  writePreference('planny-deps-mode', state.depsMode);
  renderDeps();
});
window.addEventListener('focus', refresh);

refresh().catch((err) => toast(err.message, 'error'));
