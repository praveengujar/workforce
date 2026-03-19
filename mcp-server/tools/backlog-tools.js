/**
 * Backlog tool handlers — CRUD + reorder for backlog items.
 * Pure functions, no Express dependency. Persists to backlog.json in data dir.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';

const DATA_DIR = process.env.WORKFORCE_DATA_DIR || join(homedir(), '.claude', 'tasks');
const BACKLOG_PATH = join(DATA_DIR, 'backlog.json');

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function readBacklog() {
  try {
    const raw = readFileSync(BACKLOG_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    return { items: [] };
  }
}

function writeBacklog(data) {
  ensureDir(DATA_DIR);
  writeFileSync(BACKLOG_PATH, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

// ---------------------------------------------------------------------------
// backlogListHandler
// ---------------------------------------------------------------------------
export function backlogListHandler() {
  const backlog = readBacklog();
  return backlog.items;
}

// ---------------------------------------------------------------------------
// backlogAddHandler
// ---------------------------------------------------------------------------
export function backlogAddHandler({ title, description, priority }) {
  if (!title) throw new Error('title is required');

  const backlog = readBacklog();
  const item = {
    id: randomUUID(),
    title,
    description: description || '',
    priority: priority || 'medium',
    score: 0,
    effort: null,
    createdAt: new Date().toISOString(),
  };

  backlog.items.push(item);
  writeBacklog(backlog);

  return item;
}

// ---------------------------------------------------------------------------
// backlogUpdateHandler
// ---------------------------------------------------------------------------
export function backlogUpdateHandler({ id, title, description, priority }) {
  if (!id) throw new Error('id is required');

  const backlog = readBacklog();
  const idx = backlog.items.findIndex(item => item.id === id);
  if (idx === -1) throw new Error('item not found');

  if (title !== undefined) backlog.items[idx].title = title;
  if (description !== undefined) backlog.items[idx].description = description;
  if (priority !== undefined) backlog.items[idx].priority = priority;

  writeBacklog(backlog);
  return backlog.items[idx];
}

// ---------------------------------------------------------------------------
// backlogDeleteHandler
// ---------------------------------------------------------------------------
export function backlogDeleteHandler({ id }) {
  if (!id) throw new Error('id is required');

  const backlog = readBacklog();
  const idx = backlog.items.findIndex(item => item.id === id);
  if (idx === -1) throw new Error('item not found');

  backlog.items.splice(idx, 1);
  writeBacklog(backlog);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// backlogReorderHandler
// ---------------------------------------------------------------------------
export function backlogReorderHandler({ order }) {
  if (!Array.isArray(order)) throw new Error('order must be an array of ids');

  const backlog = readBacklog();
  const itemMap = new Map(backlog.items.map(item => [item.id, item]));

  const reordered = [];
  for (const id of order) {
    const item = itemMap.get(id);
    if (item) {
      reordered.push(item);
      itemMap.delete(id);
    }
  }

  // Append any items not in the order list
  for (const item of itemMap.values()) {
    reordered.push(item);
  }

  backlog.items = reordered;
  writeBacklog(backlog);

  return backlog.items;
}
