/**
 * Session Context — persistent key-value store for cross-session continuity.
 *
 * Tracks active focus areas, ongoing investigations, and learned context
 * across Claude Code sessions. Scoped by project name.
 */

import { getDb, stmt } from './db.js';

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

/**
 * Set a session context value. Upserts on project+key.
 */
export function setSessionContext(project, key, value) {
  if (!project) throw new Error('project is required');
  if (!key) throw new Error('key is required');
  if (value === undefined) throw new Error('value is required');

  const now = new Date().toISOString();
  const id = `${project}::${key}`;
  const valueStr = typeof value === 'string' ? value : JSON.stringify(value);

  getDb().prepare(
    `INSERT OR REPLACE INTO session_context (id, project, key, value, updatedAt)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, project, key, valueStr, now);
}

/**
 * Get a single session context value.
 */
export function getSessionContext(project, key) {
  if (!project) throw new Error('project is required');
  if (!key) throw new Error('key is required');
  return stmt('SELECT * FROM session_context WHERE project = ? AND key = ?').get(project, key);
}

/**
 * Get all session context entries for a project.
 */
export function getAllSessionContext(project) {
  if (!project) throw new Error('project is required');
  return stmt('SELECT * FROM session_context WHERE project = ? ORDER BY updatedAt DESC').all(project);
}

/**
 * Get the active focus for a project.
 */
export function getActiveFocus(project) {
  const entry = getSessionContext(project, 'active_focus');
  if (!entry) return null;
  try { return JSON.parse(entry.value); } catch { return entry.value; }
}

/**
 * Clear a specific session context key, or all keys for a project.
 */
export function clearSessionContext(project, key) {
  if (!project) throw new Error('project is required');
  if (key) {
    stmt('DELETE FROM session_context WHERE project = ? AND key = ?').run(project, key);
  } else {
    stmt('DELETE FROM session_context WHERE project = ?').run(project);
  }
}

/**
 * Get a formatted summary of all active session context across all projects.
 */
export function getSessionSummary() {
  const all = getDb().prepare(
    'SELECT * FROM session_context ORDER BY project ASC, key ASC',
  ).all();

  if (all.length === 0) return null;

  const byProject = {};
  for (const entry of all) {
    if (!byProject[entry.project]) byProject[entry.project] = [];
    byProject[entry.project].push(entry);
  }

  const lines = [];
  for (const [project, entries] of Object.entries(byProject)) {
    const keys = entries.map(e => {
      const val = e.value.length > 60 ? e.value.slice(0, 60) + '...' : e.value;
      return `${e.key}: ${val}`;
    });
    lines.push(`${project}: ${keys.join(', ')}`);
  }

  return lines.join('\n');
}
