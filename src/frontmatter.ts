import YAML from 'yaml';
import { isStatus, isTaskType, type HistoryEntry, type Task } from './types.js';

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
      const row: Record<string, string> = { at: entry.at, status: entry.status };
      if (entry.by !== undefined) row.by = entry.by;
      return row;
    });
  }

  const yaml = YAML.stringify(meta).trimEnd();
  const body = task.body === '' ? '' : `${task.body.replace(/\n+$/, '')}\n`;
  return `---\n${yaml}\n---\n\n${body}`;
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
  return value;
}

function idList(meta: Record<string, unknown>, key: string): string[] {
  const value = meta[key];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new Error(`field "${key}" must be a list of task ids`);
  }
  return value as string[];
}

function historyList(meta: Record<string, unknown>): HistoryEntry[] {
  const value = meta.history;
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error('field "history" must be a list');
  return value.map((row) => {
    const entry = row as Record<string, unknown>;
    if (typeof entry?.at !== 'string' || !isStatus(entry.status)) {
      throw new Error('each history entry needs an "at" time and a valid "status"');
    }
    const by = entry.by;
    if (by !== undefined && typeof by !== 'string') {
      throw new Error('history "by" must be a string');
    }
    return by === undefined
      ? { at: entry.at, status: entry.status }
      : { at: entry.at, status: entry.status, by };
  });
}

export function parseTaskFile(text: string): Task {
  const match = FRONTMATTER_RE.exec(text);
  if (!match) throw new Error('task file has no YAML frontmatter block');
  const meta = YAML.parse(match[1]!) as Record<string, unknown> | null;
  if (meta === null || typeof meta !== 'object') {
    throw new Error('task file has empty frontmatter');
  }

  const status = requireString(meta, 'status');
  if (!isStatus(status)) throw new Error(`unknown status "${status}"`);
  const type = requireString(meta, 'type');
  if (!isTaskType(type)) throw new Error(`unknown task type "${type}"`);
  const priority = meta.priority;
  if (typeof priority !== 'number') throw new Error('field "priority" must be a number');

  return {
    id: requireString(meta, 'id'),
    name: requireString(meta, 'name'),
    status,
    type,
    kind: requireString(meta, 'kind'),
    model: optionalString(meta, 'model'),
    priority,
    parent: optionalString(meta, 'parent'),
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
