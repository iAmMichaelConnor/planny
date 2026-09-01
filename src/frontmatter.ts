import YAML from 'yaml';
import { isStatus, isTaskType, STATUSES, TASK_TYPES, type HistoryEntry, type Task } from './types.js';

/**
 * Task file format: a YAML frontmatter block delimited by `---` lines,
 * followed by the markdown body. Frontmatter keys are snake_case.
 */

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

export function serializeTaskFile(task: Task): string {
  const meta: Record<string, unknown> = {
    id: task.id,
    name: task.name,
    status: task.status,
    type: task.type,
    kind: task.kind,
  };
  if (task.model !== undefined) meta.model = task.model;
  meta.priority = task.priority;
  if (task.parent !== undefined) meta.parent = task.parent;
  if (task.blockedBy.length > 0) meta.blocked_by = task.blockedBy;
  if (task.replacedBy.length > 0) meta.replaced_by = task.replacedBy;
  meta.created = task.created;
  meta.updated = task.updated;
  if (task.createdBy !== undefined) meta.created_by = task.createdBy;
  if (task.resolvedAt !== undefined) meta.resolved_at = task.resolvedAt;
  if (task.history.length > 0) {
    meta.history = task.history.map((entry) => {
      const row: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(entry)) {
        if (value !== undefined) row[key] = value;
      }
      return row;
    });
  }
  for (const [key, value] of Object.entries(task.extras ?? {})) {
    if (!(key in meta)) meta[key] = value;
  }

  const yaml = YAML.stringify(meta).trimEnd();
  const body = task.body === '' ? '' : `${task.body.replace(/\n+$/, '')}\n`;
  return `---\n${yaml}\n---\n\n${body}`;
}

/**
 * Ids become file paths (`store.path(id)`), so their shape is a safety
 * boundary: a hand-edited id like "../evil" must never reach a write.
 */
const ID_RE = /^t\d+$/;

function requireId(meta: Record<string, unknown>, key: string): string {
  const value = requireString(meta, key);
  if (!ID_RE.test(value)) {
    throw new Error(`field "${key}" must be a task id like t12, not "${value}"`);
  }
  return value;
}

function requireString(meta: Record<string, unknown>, key: string): string {
  const value = meta[key];
  if (typeof value !== 'string' || value === '') {
    throw new Error(`task frontmatter is missing required field "${key}"`);
  }
  return value;
}

function optionalString(meta: Record<string, unknown>, key: string): string | undefined {
  const value = meta[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error(`field "${key}" must be a string`);
  // A hand-edited empty string means "not set"; normalize it away.
  return value === '' ? undefined : value;
}

function optionalId(meta: Record<string, unknown>, key: string): string | undefined {
  const value = optionalString(meta, key);
  if (value !== undefined && !ID_RE.test(value)) {
    throw new Error(`field "${key}" must be a task id like t12, not "${value}"`);
  }
  return value;
}

function idList(meta: Record<string, unknown>, key: string): string[] {
  const value = meta[key];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || !ID_RE.test(v))) {
    throw new Error(`field "${key}" must be a list of task ids like t12`);
  }
  return value as string[];
}

function historyList(meta: Record<string, unknown>): HistoryEntry[] {
  const value = meta.history;
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error('field "history" must be a list');
  return value.map((row) => {
    const entry = row as Record<string, unknown>;
    if (typeof entry?.at !== 'string') throw new Error('each history entry needs an "at" time');
    if (entry.by !== undefined && typeof entry.by !== 'string') {
      throw new Error('history "by" must be a string');
    }
    const shapeOk =
      entry.event === undefined
        ? isStatus(entry.status)
        : entry.event === 'priority'
          ? typeof entry.target === 'string' && typeof entry.position === 'number'
          : entry.event === 'parent'
            ? isOptionalString(entry.from) && isOptionalString(entry.to)
            : entry.event === 'blocked-by'
              ? isOptionalIdList(entry.added) && isOptionalIdList(entry.removed)
              : entry.event === 'rename'
                ? typeof entry.from === 'string' && typeof entry.to === 'string'
                : false;
    if (!shapeOk) {
      throw new Error(`malformed history entry${entry.event !== undefined ? ` (event "${String(entry.event)}")` : ''}`);
    }
    return entry as unknown as HistoryEntry;
  });
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function isOptionalIdList(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.every((v) => typeof v === 'string'));
}

const KNOWN_KEYS = new Set([
  'id',
  'name',
  'status',
  'type',
  'kind',
  'model',
  'priority',
  'parent',
  'blocked_by',
  'replaced_by',
  'created',
  'updated',
  'created_by',
  'resolved_at',
  'history',
]);

export function parseTaskFile(text: string): Task {
  const match = FRONTMATTER_RE.exec(text);
  if (!match) throw new Error('task file has no YAML frontmatter block');
  const meta = YAML.parse(match[1]!) as Record<string, unknown> | null;
  if (meta === null || typeof meta !== 'object') {
    throw new Error('task file has empty frontmatter');
  }

  const status = requireString(meta, 'status');
  if (!isStatus(status)) {
    throw new Error(`unknown status "${status}" — expected ${STATUSES.join(', ')}`);
  }
  const type = requireString(meta, 'type');
  if (!isTaskType(type)) {
    throw new Error(`unknown task type "${type}" — expected ${TASK_TYPES.join(' or ')}`);
  }
  const priority = meta.priority;
  if (typeof priority !== 'number') throw new Error('field "priority" must be a number');

  const extras: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(meta)) {
    if (!KNOWN_KEYS.has(key)) extras[key] = value;
  }

  return {
    ...(Object.keys(extras).length > 0 && { extras }),
    id: requireId(meta, 'id'),
    name: requireString(meta, 'name'),
    status,
    type,
    kind: requireString(meta, 'kind'),
    model: optionalString(meta, 'model'),
    priority,
    parent: optionalId(meta, 'parent'),
    blockedBy: idList(meta, 'blocked_by'),
    replacedBy: idList(meta, 'replaced_by'),
    created: requireString(meta, 'created'),
    updated: requireString(meta, 'updated'),
    createdBy: optionalString(meta, 'created_by'),
    history: historyList(meta),
    resolvedAt: optionalString(meta, 'resolved_at'),
    body: match[2]!.replace(/^\n/, '').replace(/\n+$/, ''),
  };
}
