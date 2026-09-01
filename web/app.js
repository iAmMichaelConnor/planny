'use strict';

const $ = (sel) => document.querySelector(sel);

const state = {
  data: null,
  byId: new Map(),
  view: 'board',
  selected: null, // task id shown in the drawer, or '__new__'
  collapsed: new Set(),
  skippedDecisions: new Set(),
  justResolved: new Map(), // id → when the operator resolved it in this page (notes expire)
  expandedDecisions: new Set(), // open-decision tiles start collapsed

  depsMode: readPreference('planny-deps-mode', 'blocks'),
  treeOrder: readPreference('planny-tree-order', 'parents'), // 'parents' | 'deps'
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
  descEditing: false, // the description editor was opened deliberately; rebuilds keep it
  renderedDrawerId: null,
  descExpanded: true, // always the default on open; collapse is per-view only
};

/** An edit happened in the drawer: enable Save and show the reminder. */
function markDirty() {
  state.drawerDirty = true;
  const save = $('#save-btn');
  if (save) {
    save.disabled = false;
    save.removeAttribute('title');
  }
  const note = $('#unsaved-note');
  if (note) note.hidden = false;
}

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
      // A save conflict: the task changed while the form sat open. Overwrite
      // is a deliberate choice; declining loads the newer version instead.
      if (typeof data.error === 'string' && data.error.includes('changed underneath')) {
        if (confirm(`${data.error.split(' — ')[0]}.\n\nOK overwrites with your version; Cancel discards your edit and loads the newer one.`)) {
          const retry = { ...body };
          delete retry.ifUnchangedSince;
          return api(path, method, retry);
        }
        state.drawerDirty = false; // hand the form back to the refresh
        state.renderedDrawerId = null;
        await refresh();
        return null;
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

/**
 * After a successful resolve: green reassurance that the answer is in the
 * store and will reach the agent — catchup returns resolved decisions
 * since the agent's cursor, and the skill orders a catch-up at every
 * boundary, so "at its next catch-up" is literally when it acts.
 */
const LOGGED_NOTE_MS = 5 * 60_000; // long enough to actually read, then it clears itself

function confirmResolved(id, outcomeId) {
  state.justResolved.set(id, { at: Date.now(), outcomeId });
  toast(
    typeof outcomeId === 'string'
      ? `${id} resolved — outcome task ${outcomeId} created; your agent acts on it at its next catch-up`
      : outcomeId === null
        ? `${id} rejected and closed — no task will be created from it`
        : `${id} resolved — logged to the store; your agent will act on it at its next catch-up`,
    'ok',
  );
  if (state.view === 'decisions') renderDecisions();
  setTimeout(() => {
    if (state.justResolved.delete(id) && state.view === 'decisions') renderDecisions();
  }, LOGGED_NOTE_MS);
}

function toast(message, cls = '') {
  const div = document.createElement('div');
  div.className = `toast ${cls}`;
  div.textContent = message;
  $('#toasts').appendChild(div);
  // Success toasts carry ids worth reading; give them longer than notices.
  setTimeout(() => div.remove(), cls === 'ok' ? 10_000 : 4500);
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
  if (task.status === 'in-progress' && task.holder) {
    parts.push(`<span class="badge holder" title="started by this session">${esc(task.holder)}</span>`);
  }
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

/**
 * Every known task id in already-escaped text becomes the shared goto
 * chip; unknown ids stay plain. One pattern, applied wherever the UI
 * renders text that can mention a task.
 */
function linkifyIds(s) {
  return s.replace(/\b(t\d+)\b/g, (match, id) =>
    state.byId.has(id) ? `<span class="chip-link" data-goto-task="${id}">${id}</span>` : match,
  );
}

// Tiny markdown renderer for task and decision bodies: headings, bold,
// italic, inline code, bullet lists, paragraphs. Bare ids of tasks that
// exist become click targets (the shared goto funnel); ids inside code
// spans and ids the store does not know stay plain text.
function renderMarkdown(text) {
  const inline = (s) =>
    esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>')
      .split(/(<code>[^<]*<\/code>)/)
      .map((part) => (part.startsWith('<code>') ? part : linkifyIds(part)))
      .join('');
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
  label.innerHTML = state.data.store
    ? `${esc(state.data.store.name)} <span class="store-path">${esc(state.data.store.root)}</span>`
    : '';
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

/** Mark the selected task's representation in whichever views show one. */
function applySelection() {
  for (const el of document.querySelectorAll('.is-selected')) el.classList.remove('is-selected');
  const id = state.selected;
  if (id === null || id === '__new__') return;
  const sel = `.card[data-id="${id}"], .tree-row[data-id="${id}"], .dep-node[data-id="${id}"], .decision-card[data-id="${id}"]`;
  for (const el of document.querySelectorAll(sel)) el.classList.add('is-selected');
}

function cardHtml(task, position) {
  const quick = [];
  if (task.status === 'todo') quick.push(`<button data-action="start" data-id="${task.id}">start</button>`);
  if (task.status === 'in-progress') quick.push(`<button data-action="finish" data-id="${task.id}">done</button>`);
  if (task.status === 'todo' || task.status === 'in-progress') {
    quick.push(
      `<button data-action="top" data-id="${task.id}"${task.position === 1 ? ' disabled title="already at the top"' : ' title="bump to top"'}>▲ top</button>`,
    );
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
    <span class="id">${task.id}</span><span class="name">${linkifyIds(esc(task.name))}</span>
    <div class="badges">${badges(task)}</div>
    <div class="quick">${quick.join('')}</div>${pos}
  </div>`;
}

function renderBoard() {
  clearHoverLines(); // the rebuild wipes the overlay; drop the stale element cache too
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
      const empty = status === 'in-progress'
        ? '<p class="muted col-tip">Nothing in progress. Ask your AI to work the plan — it has the planny skill. Try: &ldquo;do more tasks&rdquo;.</p>'
        : '<p class="muted">—</p>';
      return `<div class="column"><h2><span class="status-dot ${status}"></span>${title}${ordered}</h2>${cards || empty}</div>`;
    })
    .join('');
}

function renderTree() {
  clearHoverLines(); // the rebuild wipes the overlay; drop the stale row cache too
  const filters = state.treeFilters;
  const order = state.treeOrder; // 'parents' | 'deps'
  $('#tree-filters').innerHTML =
    `<span class="chip-group">${statusChips('tree', filters.statuses)}</span>` +
    `<span class="chip-group">${kindChips('tree', filters.kinds)}</span>` +
    `<span class="chip-group">${typeChips('tree', filters.types)}</span>` +
    `<span class="chip-group"><button class="chip${filters.showDeps ? ' active' : ''}" data-scope="tree" data-toggle="deps">show dependencies</button></span>` +
    `<label>nest by: <select id="tree-order" title="parent → child nests the hierarchy; blocker → blocked nests each task under what it waits on, with the most blocking tasks at the top">
      <option value="parents"${order === 'parents' ? ' selected' : ''}>parent → child</option>
      <option value="deps"${order === 'deps' ? ' selected' : ''}>blocker → blocked</option>
    </select></label>`;

  const matches = (t) =>
    filters.statuses.has(t.status) &&
    (filters.kinds.size === 0 || filters.kinds.has(t.kind)) &&
    (filters.types.size === 0 || filters.types.has(t.type));
  const visible = new Set();
  for (const task of state.data.tasks) {
    if (!matches(task)) continue;
    visible.add(task.id);
    // Hierarchy context: ancestors of a match stay visible. Dependency
    // order has no such need — the nesting is the relationship itself.
    if (order === 'parents') for (const a of ancestorsOf(task.id)) visible.add(a.id);
  }

  // Both orders share one recursive renderer; only the child relation and
  // the root set differ. In dependency order a task nests under each of
  // its blockers, so it can appear more than once, and the trail guards
  // against cycles in a hand-edited store.
  const kidsOf = order === 'parents'
    ? (task) => childrenOf(task.id)
    : (task) => task.blocking.map((id) => state.byId.get(id)).filter(Boolean);
  const nodeHtml = (task, trail) => {
    if (!visible.has(task.id)) return '';
    const children = kidsOf(task).filter((c) => visible.has(c.id) && !trail.has(c.id) && c.id !== task.id);
    const isCollapsed = state.collapsed.has(task.id);
    const twist = children.length > 0
      ? `<span class="twist" data-action="toggle" data-id="${task.id}">${isCollapsed ? '▸' : '▾'}</span>`
      : '<span class="twist"></span>';
    let progressHtml = '';
    if (order === 'parents' && children.length > 0) {
      const { done, total } = subtreeCounts(task.id);
      if (total > 0) {
        progressHtml = `<span class="mini-progress" title="${done}/${total} done"><div style="width:${Math.round((done / total) * 100)}%"></div></span><span class="muted" style="font-size:11px">${done}/${total}</span>`;
      }
    }
    const row = `<div class="tree-row" data-id="${task.id}">
      ${twist}<span class="status-dot ${task.status}"></span>
      <span class="id">${task.id}</span>
      <span class="name${task.status === 'done' ? ' done-name' : ''}">${linkifyIds(esc(task.name))}</span>
      ${progressHtml}${state.treeFilters.showDeps ? badges(task) : badges({ ...task, blocked: false })}
    </div>`;
    const nextTrail = new Set(trail).add(task.id);
    const childHtml = !isCollapsed && children.length > 0
      ? `<div class="tree-children">${children.map((c) => nodeHtml(c, nextTrail)).join('')}</div>`
      : '';
    return `<div class="tree-node">${row}${childHtml}</div>`;
  };

  const roots = order === 'parents'
    ? state.data.tasks.filter((t) => !t.parent || !state.byId.has(t.parent))
    : state.data.tasks.filter(
        (t) => visible.has(t.id) && !t.blockedBy.some((id) => visible.has(id)),
      );
  // A cycle in a hand-edited store leaves its members rootless; render any
  // visible task no root can reach at the top level. Reachability ignores
  // collapse — a task hidden under a collapsed node must stay hidden.
  const reached = new Set();
  const reach = (task) => {
    if (!visible.has(task.id) || reached.has(task.id)) return;
    reached.add(task.id);
    for (const c of kidsOf(task)) reach(c);
  };
  for (const t of roots) reach(t);
  let html = roots.map((t) => nodeHtml(t, new Set())).join('');
  for (const t of state.data.tasks) {
    if (visible.has(t.id) && !reached.has(t.id)) {
      reach(t);
      html += nodeHtml(t, new Set());
    }
  }
  $('#tree-list').innerHTML = html || '<p class="muted">No tasks match the filters.</p>';
  applySelection(); // this rebuild is sometimes called outside render()
}

// ---------- hover dependency lines (tree and board) ----------

let hoverDepEl = null; // the element the current overlay was drawn for

function clearHoverLines() {
  hoverDepEl = null;
  const svg = document.getElementById('dep-hover-svg');
  if (svg) svg.remove();
}

function activeBlockersOf(id) {
  const task = state.byId.get(id);
  return (task ? task.blockedBy : []).filter((b) => {
    const blocker = state.byId.get(b);
    return blocker && (blocker.status === 'todo' || blocker.status === 'in-progress');
  });
}

/**
 * Red curves from a hovered element out to each task it waits on, then
 * dimmer curves from those blockers to their own blockers, level by
 * level, until the chain ends. The views share this walk and differ only
 * in how they find a task's element (elFor) and shape one curve (edge).
 */
function drawHoverLines(container, sourceEl, elFor, edge) {
  clearHoverLines();
  hoverDepEl = sourceEl;
  const paths = [];
  const visited = new Set([sourceEl.dataset.id]);
  let frontier = [{ id: sourceEl.dataset.id, el: sourceEl }];
  for (let level = 1; frontier.length > 0; level += 1) {
    const next = [];
    const opacity = Math.max(0.9 - (level - 1) * 0.3, 0.2).toFixed(2);
    for (const { id, el } of frontier) {
      for (const blockerId of activeBlockersOf(id)) {
        const target = elFor(blockerId);
        if (!target) continue; // filtered out or hidden in this view
        paths.push(
          `<path data-level="${level}" data-from="${esc(id)}" data-to="${esc(blockerId)}" stroke-opacity="${opacity}" d="${edge(el, target, level, paths.length)}"/>`,
        );
        if (!visited.has(blockerId)) {
          visited.add(blockerId);
          next.push({ id: blockerId, el: target });
        }
      }
    }
    frontier = next;
  }
  if (paths.length === 0) return;
  container.insertAdjacentHTML(
    'beforeend',
    `<svg id="dep-hover-svg" width="${container.clientWidth}" height="${container.scrollHeight}">${paths.join('')}</svg>`,
  );
}

/**
 * Tree curves start and end where a row's content finishes — the right
 * edge of its last inline element — and bow out to the right; each extra
 * line bows a little further so parallel lines stay apart.
 */
function treeEdge(container) {
  const box = container.getBoundingClientRect();
  const endOf = (rowEl) => {
    const last = rowEl.lastElementChild || rowEl;
    const rowBox = rowEl.getBoundingClientRect();
    return {
      x: last.getBoundingClientRect().right - box.left,
      y: rowBox.top + rowBox.height / 2 - box.top,
    };
  };
  return (from, to, level, index) => {
    const a = endOf(from);
    const b = endOf(to);
    const bow = Math.max(a.x, b.x) + 30 + level * 14 + index * 6;
    return `M${a.x},${a.y} C${bow},${a.y} ${bow},${b.y} ${b.x},${b.y}`;
  };
}

/**
 * Board curves take the shortest route: between columns they leave the
 * edge that faces the other card and land on the edge facing back;
 * within one column they bow out of the right edge into the gap.
 */
function boardEdge(container) {
  const box = container.getBoundingClientRect();
  const rect = (el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left - box.left, right: r.right - box.left, y: r.top + r.height / 2 - box.top };
  };
  return (from, to, level, index) => {
    const a = rect(from);
    const b = rect(to);
    const spread = level * 10 + index * 4;
    if (from.closest('.column') === to.closest('.column')) {
      const bow = Math.max(a.right, b.right) + 20 + spread;
      return `M${a.right},${a.y} C${bow},${a.y} ${bow},${b.y} ${b.right},${b.y}`;
    }
    const dx = 30 + spread;
    return b.left >= a.right
      ? `M${a.right},${a.y} C${a.right + dx},${a.y} ${b.left - dx},${b.y} ${b.left},${b.y}`
      : `M${a.left},${a.y} C${a.left - dx},${a.y} ${b.right + dx},${b.y} ${b.right},${b.y}`;
  };
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
      ? `<p class="muted">Waiting on ${linkifyIds(esc(task.blockedBy.join(', ')))} — answer those first.</p>`
      : `<div class="decision-actions">
          <textarea placeholder="Your decision (free-form)…" data-role="response" data-id="${task.id}"></textarea>
          <div style="display:flex;flex-direction:column;gap:6px">
            <button class="primary" data-action="respond" data-id="${task.id}" disabled title="records the typed text as the decision">Submit</button>
            <button data-action="accept" data-id="${task.id}" title="records the written proposal as the decision — clear the box to use it">Accept proposal</button>
            <button data-action="reject" data-id="${task.id}" title="close as decided-no: the rejection is recorded and no task is created from it">Reject…</button>
            <button data-action="skip" data-id="${task.id}" title="Hide this decision in this tab until the page reloads. It stays open for everyone and nothing is deleted or written to the store.">Skip for now</button>
            <button data-action="cancel-decision" data-id="${task.id}" title="Mark the decision cancelled: the question no longer needs an answer. The task keeps its file — nothing is deleted.">Cancel decision</button>
          </div>
        </div>`;
    const expanded = state.expandedDecisions.has(task.id);
    // Priority moves reuse the shared bump funnel (same delegated actions
    // and API the cards and drawer use).
    const activeTotal = activeTasks().length;
    const priority = `<div class="decision-priority row">
        <span class="muted">priority${task.position > 0 ? ` #${task.position}` : ''} of ${activeTotal} open tasks</span>
        <input type="number" min="1" data-role="pos-input" data-id="${task.id}" data-initial="${task.position > 0 ? task.position : ''}" value="${task.position > 0 ? task.position : ''}">
        <button class="mini" data-action="set-pos" data-id="${task.id}" title="move to the typed position" disabled>set</button>
        <button class="mini" data-action="top" data-id="${task.id}"${task.position === 1 ? ' disabled title="already at the top"' : ' title="move to the top of the priority order"'}>▲ top</button>
        <button class="mini" data-action="bottom" data-id="${task.id}"${task.position > 0 && task.position === activeTotal ? ' disabled title="already at the bottom"' : ' title="move to the bottom of the priority order"'}>▼ bottom</button>
      </div>`;
    return `<div class="decision-card${blocked ? ' blocked' : ''}${expanded ? '' : ' collapsed'}" data-action="toggle-decision" data-id="${task.id}">
      <h3><span class="disclose muted">${expanded ? '▾' : '▸'}</span><span class="id muted">${task.id}</span> ${linkifyIds(esc(task.name))}</h3>
      <div class="badges">${badges(task)}</div>
      ${expanded ? `<div class="decision-body">${renderMarkdown(task.body || '_no detail_')}</div>
      ${actions}${priority}` : ''}
    </div>`;
  });

  const pastHtml = past.length > 0
    ? `<details><summary class="muted">${past.length} resolved decision${past.length === 1 ? '' : 's'}</summary>
        ${past.map((t) => `<div class="decision-card"><h3><span class="id muted">${t.id}</span> ${linkifyIds(esc(t.name))}</h3><div class="decision-body">${renderMarkdown(t.body)}</div></div>`).join('')}
       </details>`
    : '';

  const skippedHtml = skipped.length > 0
    ? `<div class="skipped-list">
        <h4 class="muted">Skipped for now (still open)</h4>
        ${skipped
          .map(
            ({ task }) => `<div class="skipped-row">
              <span class="id muted">${task.id}</span> ${linkifyIds(esc(task.name))}
              <button class="mini" data-action="unskip" data-id="${task.id}">bring back</button>
            </div>`,
          )
          .join('')}
      </div>`
    : '';

  const logged = [...state.justResolved.entries()]
    .filter(([, v]) => Date.now() - v.at < LOGGED_NOTE_MS)
    .map(([id, v]) => ({ task: state.byId.get(id), outcomeId: v.outcomeId }))
    .filter((entry) => entry.task && entry.task.status === 'done');
  const loggedHtml = logged
    .map(({ task: t, outcomeId }) => {
      const what = typeof outcomeId === 'string'
        ? `decision logged — outcome task <span class="chip-link" data-goto-task="${outcomeId}">${outcomeId}</span> carries the answer for your agent to pick up.`
        : outcomeId === null
          ? 'decision rejected and closed — nothing will be created from it.'
          : 'decision logged. Your agent reads resolved decisions at its next catch-up and will create or update tasks where relevant.';
      return `<div class="decision-logged"><span class="logged-text">✓ <span class="id">${t.id}</span> ${esc(t.name)} —
        ${what} From a terminal:
        <code>planny decisions --resolved</code> lists the newest answers;
        <code>planny show ${t.id}</code> shows this one.</span>
        <button class="mini" data-action="dismiss-logged" data-id="${t.id}" title="discard this note">×</button></div>`;
    })
    .join('');

  view.innerHTML =
    loggedHtml + (openHtml.join('') || '<p class="muted">No open decisions.</p>') + skippedHtml + pastHtml;

  for (const [id, value] of drafts) {
    const textarea = view.querySelector(`textarea[data-role="response"][data-id="${id}"]`);
    if (textarea) textarea.value = value;
    syncDecisionButtons(id); // a kept draft keeps its buttons armed
  }
  if (focusedId !== null) {
    const textarea = view.querySelector(`textarea[data-role="response"][data-id="${focusedId}"]`);
    if (textarea) {
      textarea.focus();
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    }
  }
  applySelection(); // this rebuild is sometimes called outside render()
}

/**
 * Respond records the typed text, so it arms only when text exists;
 * Accept records the written proposal, so it arms only while the box is
 * empty — the two can never both be live.
 */
function syncDecisionButtons(id) {
  const textarea = document.querySelector(`textarea[data-role="response"][data-id="${id}"]`);
  if (!textarea) return;
  const empty = textarea.value.trim() === '';
  const respond = document.querySelector(`button[data-action="respond"][data-id="${id}"]`);
  const accept = document.querySelector(`button[data-action="accept"][data-id="${id}"]`);
  if (respond) respond.disabled = empty;
  if (accept) accept.disabled = !empty;
}

// ---------- drawer ----------

/**
 * The recorded decision: everything after the last "## Outcome" heading
 * that `planny resolve` appended — later appends (the built record) are
 * part of what the operator looks back on. Null when nothing is recorded.
 */
function outcomeOf(task) {
  if (task.type !== 'decision' || !task.body) return null;
  const headings = [...task.body.matchAll(/^## Outcome[ \t]*\r?\n/gm)];
  if (headings.length === 0) return null;
  const last = headings[headings.length - 1];
  const text = task.body.slice(last.index + last[0].length).trim();
  return text === '' ? null : text;
}

function renderDrawer() {
  applySelection(); // the views are already rendered whenever the drawer is
  const drawer = $('#drawer');
  if (state.selected === null) {
    drawer.classList.add('hidden');
    state.renderedDrawerId = null;
    state.drawerDirty = false;
    state.descExpanded = true; // next open starts expanded again
    state.descEditing = false;
    return;
  }
  drawer.classList.remove('hidden');
  // A background refresh must not rebuild a form the user is editing.
  if (state.selected === state.renderedDrawerId && state.drawerDirty) return;
  if (state.selected !== state.renderedDrawerId) state.descEditing = false; // a fresh task, fresh default
  const isNew = state.selected === '__new__';
  const task = isNew
    ? { name: '', body: '', type: 'task', kind: 'ai', model: '', parent: state.newParent || '', blockedBy: [], status: 'todo' }
    : state.byId.get(state.selected);
  if (!task) {
    state.selected = null;
    drawer.classList.add('hidden');
    return;
  }
  $('#drawer-title').innerHTML = isNew
    ? 'New task'
    : `<span class="status-dot ${esc(task.status)}"></span>${esc(task.id)} · ${esc(task.status)}${task.status === 'todo' ? `
       <span class="do-copy"><code>"Do ${esc(task.id)}"</code><button id="copy-do" class="mini" title="Copies 'Do ${esc(task.id)}' to your clipboard, so you can paste it at your agent without typing six whole characters. Yes, you really are that lazy — and we respect it.">⧉</button></span>` : ''}`;

  const options = state.data.tasks
    .map((t) => `<option value="${t.id}">${t.id} ${esc(t.name)}</option>`)
    .join('');
  const others = state.data.tasks.filter((t) => isNew || t.id !== task.id);
  const otherOptions = others
    .map((t) => `<option value="${t.id}"${t.id === task.parent ? ' selected' : ''}>${t.id} ${esc(t.name)}</option>`)
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
      ${ancestorsOf(task.id).length > 0 ? `<label>path</label><div>${ancestorsOf(task.id).reverse().map((a) => linkifyIds(esc(`${a.id} ${a.name}`))).join(' › ')}</div>` : ''}
      ${childrenOf(task.id).length > 0 ? `<label>children</label><ul class="rel-list">${childrenOf(task.id).map((c) => `<li data-goto="${c.id}">${c.id} ${esc(c.name)} — ${c.status}</li>`).join('')}</ul>` : ''}
      ${task.blocking.length > 0 ? `<label>blocks</label><ul class="rel-list">${task.blocking.map((id) => { const b = state.byId.get(id); return `<li data-goto="${id}">${id} ${esc(b ? b.name : '')}</li>`; }).join('')}</ul>` : ''}
      <div style="margin:8px 0"><button id="add-child-btn">+ add child task</button></div>
      <label>file</label><div class="file-path">${esc(state.data.store ? `${state.data.store.root}/` : '')}.planny/tasks/${task.id}.md</div>
    </div>`;

  const statusButtons = isNew ? '' : `
    <label>status</label>
    <div class="status-buttons">
      ${['todo', 'in-progress', 'done'].map((s) => `<button data-status="${s}" class="${task.status === s ? 'current' : ''}"${task.status === s ? ' disabled title="the current status"' : ''}>${s}</button>`).join('')}
      <button data-status="cancelled" class="${task.status === 'cancelled' ? 'current' : ''}"${task.status === 'cancelled' ? ' disabled title="the current status"' : ''}>cancel…</button>
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
          <button class="primary" id="resolve-btn" disabled title="records the typed text above as the decision">Submit</button>
          <button id="accept-btn" title="records the written proposal as the decision — clear the box to use it">Accept proposal</button>
          <button id="reject-btn" title="close as decided-no: the rejection is recorded and no task is created from it">Reject…</button>
        </div>
      </div>`
    : '';

  const outcome = isNew ? null : outcomeOf(task);
  const outcomeSection = outcome !== null
    ? `<div class="drawer-section decision-outcome">
        <label>outcome${task.resolvedAt ? ` — resolved ${esc(task.resolvedAt.slice(0, 10))}` : ''}</label>
        <div class="decision-body">${renderMarkdown(outcome)}</div>
      </div>`
    : '';

  const prioritySection = isNew
    ? `<label>priority</label>
       <select id="f-priority"><option value="bottom">bottom of list</option><option value="top">top of list</option></select>`
    : `<label>priority position (of ${active.length} open tasks)</label>
       <div class="row">
         <input id="f-position" type="number" min="1" value="${positionValue > 0 ? positionValue : ''}" ${positionValue > 0 ? '' : 'disabled'}>
         ${positionValue > 0 ? '<button id="set-position" title="move to the typed position" disabled>set</button>' : ''}
         <button data-bump="top"${positionValue === 1 ? ' disabled title="already at the top"' : ' title="move to the top of the priority order"'}>▲ top</button>
         <button data-bump="bottom"${positionValue > 0 && positionValue === active.length ? ' disabled title="already at the bottom"' : ' title="move to the bottom of the priority order"'}>▼ bottom</button>
       </div>`;

  $('#drawer-body').innerHTML = `
    <label>name</label><input id="f-name" value="${esc(task.name)}">
    <label>description (markdown)
      <button id="desc-mode" type="button" class="mini" tabindex="-1">view</button>
      <button id="desc-toggle" type="button" class="mini" tabindex="-1">${state.descExpanded ? 'collapse' : 'expand'}</button>
    </label>
    <textarea id="f-desc" class="desc-area${state.descExpanded ? ' expanded' : ''}">${esc(task.body)}</textarea>
    <div id="f-desc-view" class="desc-view" hidden></div>
    ${resolveSection}${outcomeSection}
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
      <div><label>parent (optional)</label>
        <div class="combo">
          <input id="f-parent" list="task-ids" value="${esc(task.parent || '')}">
          <select id="f-parent-pick" title="pick a parent">
            <option value="">—</option>${otherOptions}
          </select>
        </div>
        <datalist id="task-ids">${options}</datalist></div>
    </div>
    <label>waits on (comma-separated ids — click for a picker)</label>
    <div class="picker-wrap">
      <input id="f-blocked-by" value="${esc(task.blockedBy.join(', '))}" autocomplete="off">
      <div id="blocked-menu" class="picker-menu" hidden>
        ${others
          .map(
            (t) =>
              `<label class="picker-item"><input type="checkbox" value="${t.id}"${task.blockedBy.includes(t.id) ? ' checked' : ''}> ${t.id} ${esc(t.name)}</label>`,
          )
          .join('')}
      </div>
    </div>
    ${prioritySection}
    <div style="margin-top:14px"><button class="primary" id="save-btn"${isNew ? '' : ' disabled title="type a change first"'}>${isNew ? 'Create task' : 'Save changes'}</button>
      <span id="unsaved-note" class="muted" hidden>changes not saved</span></div>
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

  // View renders the current text — unsaved edits included — with known
  // ids clickable; edit hands the same text back untouched. The chosen
  // mode is remembered so a background rebuild cannot snap an open
  // editor back to view.
  const descView = $('#f-desc-view');
  const setDescMode = (toView) => {
    const textarea = $('#f-desc');
    if (toView) descView.innerHTML = renderMarkdown(textarea.value);
    descView.hidden = !toView;
    textarea.hidden = toView;
    $('#desc-mode').textContent = toView ? 'edit' : 'view';
    $('#desc-toggle').hidden = toView; // collapse applies to the editor only
    state.descEditing = !toView;
    if (!toView && state.descExpanded) autosizeDesc();
  };
  $('#desc-mode').onclick = () => setDescMode(descView.hidden);
  descView.addEventListener('click', (event) => {
    if (event.target.closest('[data-goto-task], a')) return; // links keep their job
    if (String(window.getSelection?.() ?? '') !== '') return; // copying is not editing
    setDescMode(false);
    $('#f-desc').focus();
  });
  // Reading is the default when there is something to read.
  setDescMode(!isNew && task.body !== '' && !state.descEditing);

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
    const note = $('#unsaved-note');
    if (note) note.hidden = true;
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
    // The stamp the form was built from: ops refuses the body write if the
    // task changed underneath (an agent appended, a resolve landed).
    api(`/api/tasks/${task.id}`, 'PATCH', {
      ...fields,
      addBlockedBy,
      removeBlockedBy,
      ifUnchangedSince: task.updated,
    });
  };

  const parentPick = $('#f-parent-pick');
  if (parentPick) {
    parentPick.onchange = () => {
      $('#f-parent').value = parentPick.value;
      markDirty();
    };
  }
  const blockedMenu = $('#blocked-menu');
  if (blockedMenu) {
    const blockedInput = $('#f-blocked-by');
    const syncChecks = () => {
      const current = new Set(parseIdList(blockedInput.value));
      for (const box of blockedMenu.querySelectorAll('input[type="checkbox"]')) {
        box.checked = current.has(box.value);
      }
    };
    blockedInput.addEventListener('focus', () => {
      syncChecks();
      blockedMenu.hidden = false;
    });
    blockedInput.addEventListener('input', syncChecks);
    blockedMenu.addEventListener('change', () => {
      const known = new Set(
        [...blockedMenu.querySelectorAll('input[type="checkbox"]')].map((b) => b.value),
      );
      const typedUnknown = parseIdList(blockedInput.value).filter((id) => !known.has(id));
      const picked = [...blockedMenu.querySelectorAll('input[type="checkbox"]:checked')].map(
        (b) => b.value,
      );
      blockedInput.value = [...typedUnknown, ...picked].join(', ');
      markDirty();
    });
  }
  const addChild = $('#add-child-btn');
  if (addChild) {
    addChild.onclick = () => openNewTaskForm(task.id);
  }

  // The copy button lives in the drawer head, rebuilt with the title.
  const copyDo = $('#copy-do');
  if (copyDo) {
    copyDo.onclick = async () => {
      try {
        await navigator.clipboard.writeText(`Do ${task.id}`);
        toast(`copied "Do ${task.id}"`);
      } catch {
        toast('clipboard unavailable — you may have to type it yourself', 'warn');
      }
    };
  }

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
      // set means something only once the typed position differs.
      const posInput = $('#f-position');
      const initialPosition = posInput.value;
      posInput.addEventListener('input', () => {
        setPosition.disabled = posInput.value === initialPosition || posInput.value === '';
      });
      setPosition.onclick = () => {
        const position = Number(posInput.value);
        if (!guard(`Move ${task.id} to position ${position}?`)) return;
        api(`/api/tasks/${task.id}/bump`, 'POST', { target: position });
      };
    }
    const resolveBtn = $('#resolve-btn');
    if (resolveBtn) {
      // Resolve records the typed text; Accept records the proposal.
      // Each arms only when its own input state matches.
      const resolutionBox = $('#f-resolution');
      const syncResolveButtons = () => {
        const empty = resolutionBox.value.trim() === '';
        resolveBtn.disabled = empty;
        $('#accept-btn').disabled = !empty;
      };
      resolutionBox.addEventListener('input', syncResolveButtons);
      syncResolveButtons();
      resolveBtn.onclick = () => {
        const text = $('#f-resolution').value.trim();
        if (text === '') {
          toast('write the decision first, or use Accept proposal', 'warn');
          return;
        }
        api(`/api/tasks/${task.id}/resolve`, 'POST', { response: text })
          .then((res) => res && confirmResolved(task.id, res.outcomeTask ? res.outcomeTask.id : undefined));
      };
      $('#accept-btn').onclick = () =>
        api(`/api/tasks/${task.id}/resolve`, 'POST', { response: 'Accepted the proposal.' })
          .then((res) => res && confirmResolved(task.id, res.outcomeTask ? res.outcomeTask.id : undefined));
      $('#reject-btn').onclick = () => {
        if (!confirm(`Reject ${task.id}? The decision closes as decided-no and no task will be created from it.`)) return;
        api(`/api/tasks/${task.id}/resolve`, 'POST', {
          reject: true,
          response: resolutionBox.value.trim(),
        }).then((res) => res && confirmResolved(task.id, null));
      };
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

function wireHoverLines(container, itemClass, edgeFactory) {
  container.addEventListener('mouseover', (event) => {
    const el = event.target.closest(`.${itemClass}[data-id]`);
    if (!el) {
      clearHoverLines();
      return;
    }
    if (el === hoverDepEl) return;
    drawHoverLines(
      container,
      el,
      (id) => container.querySelector(`.${itemClass}[data-id="${id}"]`),
      edgeFactory(container),
    );
  });
  container.addEventListener('mouseleave', clearHoverLines);
}
wireHoverLines($('#tree-list'), 'tree-row', treeEdge);
wireHoverLines($('#board-columns'), 'card', boardEdge);

// The nest-by select is rebuilt with the tree filters, so delegate.
document.addEventListener('change', (event) => {
  if (!event.target.closest || !event.target.closest('#tree-order')) return;
  state.treeOrder = event.target.value;
  writePreference('planny-tree-order', state.treeOrder);
  renderTree();
});

document.addEventListener('click', (event) => {
  // The waits-on picker closes on any click outside its wrap.
  const blockedMenu = $('#blocked-menu');
  if (blockedMenu && !event.target.closest('.picker-wrap')) blockedMenu.hidden = true;

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
    if (action === 'bottom') {
      if (guard(`Move ${id} to the bottom of the priority order?`)) api(`/api/tasks/${id}/bump`, 'POST', { target: 'bottom' });
      return;
    }
    if (action === 'cancel-decision') {
      if (guard(`Cancel ${id}? The question stays on file as cancelled — nothing is deleted.`))
        api(`/api/tasks/${id}/status`, 'POST', { status: 'cancelled' });
      return;
    }
    if (action === 'set-pos') {
      const input = document.querySelector(`input[data-role="pos-input"][data-id="${id}"]`);
      const position = Number(input && input.value);
      if (!Number.isInteger(position) || position < 1) {
        toast('type a position number first', 'warn');
        return;
      }
      api(`/api/tasks/${id}/bump`, 'POST', { target: position });
      return;
    }
    if (action === 'toggle-decision') {
      // The whole tile toggles — but not clicks on things with their own
      // behavior (typing, links; buttons carry their own data-action and
      // never reach here), and not a click that ends a text selection.
      if (event.target.closest('textarea, a, button, input, select')) return;
      if (String(window.getSelection?.() ?? '') !== '') return;
      state.expandedDecisions.has(id)
        ? state.expandedDecisions.delete(id)
        : state.expandedDecisions.add(id);
      renderDecisions();
      return;
    }
    if (action === 'dismiss-logged') {
      state.justResolved.delete(id);
      renderDecisions();
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
    if (action === 'accept') {
      return void api(`/api/tasks/${id}/resolve`, 'POST', { response: 'Accepted the proposal.' })
        .then((res) => res && confirmResolved(id, res.outcomeTask ? res.outcomeTask.id : undefined));
    }
    if (action === 'reject') {
      if (!confirm(`Reject ${id}? The decision closes as decided-no and no task will be created from it.`)) return;
      const textarea = document.querySelector(`textarea[data-role="response"][data-id="${id}"]`);
      return void api(`/api/tasks/${id}/resolve`, 'POST', {
        reject: true,
        response: textarea ? textarea.value.trim() : '',
      }).then((res) => res && confirmResolved(id, null));
    }
    if (action === 'respond') {
      const textarea = document.querySelector(`textarea[data-role="response"][data-id="${id}"]`);
      const text = textarea ? textarea.value.trim() : '';
      if (text === '') {
        toast('write the decision first, or use Accept proposal', 'warn');
        return;
      }
      return void api(`/api/tasks/${id}/resolve`, 'POST', { response: text })
        .then((res) => res && confirmResolved(id, res.outcomeTask ? res.outcomeTask.id : undefined));
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

function openNewTaskForm(parentId) {
  $('#add-note').classList.add('hidden');
  state.newParent = typeof parentId === 'string' ? parentId : null;
  state.selected = '__new__';
  state.renderedDrawerId = null; // force a rebuild even if the form was open
  state.drawerDirty = false;
  renderDrawer();
}

// The set button only means something once the typed position differs
// from the task's current one.
document.addEventListener('input', (event) => {
  const input = event.target.closest?.('input[data-role="pos-input"]');
  if (input) {
    const btn = document.querySelector(`button[data-action="set-pos"][data-id="${input.dataset.id}"]`);
    if (btn) btn.disabled = input.value === input.dataset.initial;
    return;
  }
  const response = event.target.closest?.('textarea[data-role="response"]');
  if (response) syncDecisionButtons(response.dataset.id);
});

$('#search').addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  const raw = event.target.value.trim().toLowerCase();
  if (raw === '') return;
  const id = /^\d+$/.test(raw) ? `t${raw}` : raw;
  const task = state.byId.get(id);
  if (!task) {
    // Before the first state fetch lands, byId is empty — say so instead
    // of wrongly claiming the task does not exist.
    toast(state.byId.size === 0 ? 'still loading — try again' : `no task "${raw}"`, 'warn');
    return;
  }
  state.selected = id;
  const openDecision =
    task.type === 'decision' && (task.status === 'todo' || task.status === 'in-progress');
  if (state.view === 'decisions' && openDecision) {
    state.skippedDecisions.delete(id); // a skipped tile comes back when searched
    state.expandedDecisions.add(id);
    renderDecisions();
  }
  renderDrawer();
  const el = document.querySelector(`#view-${state.view} [data-id="${id}"]`);
  el?.scrollIntoView?.({ block: 'nearest' });
  event.target.select(); // leave the text ready for the next search
});

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
$('#drawer-body').addEventListener('input', (event) => {
  // The resolve box is not part of the edit form: arming Save from it
  // once let Save clobber a freshly appended Outcome with the stale body.
  if (event.target.closest && event.target.closest('#f-resolution')) return;
  markDirty();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !$('#add-note').classList.contains('hidden')) {
    event.preventDefault();
    openNewTaskForm();
  }
});
$('#drawer-body').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
    const save = $('#save-btn');
    if (save) save.click();
  }
});

// Theme: auto (system) → dark → light → auto, persisted per browser.
function applyTheme() {
  const theme = readPreference('planny-theme', '');
  if (theme === '') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  $('#theme-btn').title = `theme: ${theme === '' ? 'auto' : theme}`;
}
$('#theme-btn').onclick = () => {
  const current = readPreference('planny-theme', '');
  const next = current === '' ? 'dark' : current === 'dark' ? 'light' : '';
  writePreference('planny-theme', next);
  applyTheme();
};
applyTheme();
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
