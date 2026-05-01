/**
 * Sub-Agent Trace Handoff — Context Fabric Milestone 8 (PRD §9.11, Cognition pattern).
 *
 * Persists a compact, gzipped trace of a parent task at merge time so any
 * sub-task spawned later (parent_id pointer) can prepend the parent's intent
 * to its own prompt under a "PARENT TASK TRACE" header. Defends against the
 * Cognition failure mode of sub-agents losing parent intent.
 *
 * Trace contents (per PRD §9.11):
 *   - Parent prompt (capped)
 *   - Recent decisions (context_items where memory_type='decision', scope=task)
 *   - Recent risks (context_items where memory_type='risk', scope=task)
 *   - Scratch findings (context_items tagged scratch_findings, scope=task)
 *
 * Storage: gzipped JSON in tasks.task_trace BLOB (migration 19). All helpers
 * are best-effort and never throw — a corrupt or missing trace must never
 * break a child spawn.
 *
 * No new npm deps. ESM (uses node:zlib + node:sqlite). Logs to stderr.
 */

import { gzipSync, gunzipSync } from 'node:zlib';

const PROMPT_CAP = 2000;
const PER_ITEM_CAP = 800;
const MAX_DECISIONS = 5;
const MAX_RISKS = 5;
const MAX_FINDINGS = 3;
const TRACE_FORMAT_VERSION = 1;

function safePrepare(db, sql) {
  if (!db || typeof db.prepare !== 'function') return null;
  try {
    return db.prepare(sql);
  } catch (err) {
    console.error(`[task-trace] prepare failed: ${err.message}`);
    return null;
  }
}

function fetchRecentItems(db, taskId, memoryType, limit) {
  const stmt = safePrepare(db, `
    SELECT title, content, summary, tags, memory_type, created_at
      FROM context_items
     WHERE scope_type = 'task' AND scope_id = ?
       AND memory_type = ?
       AND invalid_at IS NULL
     ORDER BY created_at DESC
     LIMIT ?
  `);
  if (!stmt) return [];
  try {
    const rows = stmt.all(taskId, memoryType, limit);
    return rows.map(r => ({
      title: (r.title || '').slice(0, 120),
      content: (r.summary || r.content || '').slice(0, PER_ITEM_CAP),
    }));
  } catch (err) {
    console.error(`[task-trace] fetch ${memoryType} failed for ${taskId}: ${err.message}`);
    return [];
  }
}

function fetchScratchFindings(db, taskId, limit) {
  const stmt = safePrepare(db, `
    SELECT title, content, summary, tags, created_at
      FROM context_items
     WHERE scope_type = 'task' AND scope_id = ?
       AND memory_type = 'artifact'
       AND invalid_at IS NULL
       AND tags LIKE '%scratch_findings%'
     ORDER BY created_at DESC
     LIMIT ?
  `);
  if (!stmt) return [];
  try {
    const rows = stmt.all(taskId, limit);
    return rows.map(r => ({
      title: (r.title || '').slice(0, 120),
      content: (r.summary || r.content || '').slice(0, PER_ITEM_CAP),
    }));
  } catch (err) {
    console.error(`[task-trace] fetch scratch findings failed for ${taskId}: ${err.message}`);
    return [];
  }
}

/**
 * Build a trace object for `taskId` and gzip-encode it. Returns a Buffer ready
 * to persist into tasks.task_trace, or null on missing task / DB error.
 */
export function buildTraceForTask(db, taskId) {
  if (!db || !taskId) return null;
  try {
    const taskStmt = safePrepare(db, 'SELECT id, prompt, project, taskType FROM tasks WHERE id = ?');
    if (!taskStmt) return null;
    const task = taskStmt.get(taskId);
    if (!task) return null;

    const trace = {
      v: TRACE_FORMAT_VERSION,
      taskId: task.id,
      project: task.project || '_global',
      taskType: task.taskType || 'standard',
      prompt: (task.prompt || '').slice(0, PROMPT_CAP),
      decisions: fetchRecentItems(db, taskId, 'decision', MAX_DECISIONS),
      risks: fetchRecentItems(db, taskId, 'risk', MAX_RISKS),
      scratchFindings: fetchScratchFindings(db, taskId, MAX_FINDINGS),
      capturedAt: new Date().toISOString(),
    };
    const json = JSON.stringify(trace);
    return gzipSync(Buffer.from(json, 'utf8'));
  } catch (err) {
    console.error(`[task-trace] buildTraceForTask failed for ${taskId}: ${err.message}`);
    return null;
  }
}

/**
 * Write the gzipped trace into tasks.task_trace. No-op (returns false) if the
 * column or row is missing. Never throws.
 */
export function persistTrace(db, taskId, buf) {
  if (!db || !taskId || !buf) return false;
  try {
    const stmt = safePrepare(db, 'UPDATE tasks SET task_trace = ? WHERE id = ?');
    if (!stmt) return false;
    const result = stmt.run(buf, taskId);
    return (result && (result.changes ?? 0) > 0);
  } catch (err) {
    console.error(`[task-trace] persistTrace failed for ${taskId}: ${err.message}`);
    return false;
  }
}

/**
 * Load and decode the gzipped trace stored on a parent task. Returns the
 * parsed object on success, or null on missing column / missing row / corrupt
 * gzip / corrupt JSON / any error. Never throws.
 */
export function loadTraceForChild(db, parentTaskId) {
  if (!db || !parentTaskId) return null;
  try {
    const stmt = safePrepare(db, 'SELECT task_trace FROM tasks WHERE id = ?');
    if (!stmt) return null;
    const row = stmt.get(parentTaskId);
    if (!row) return null;
    const buf = row.task_trace;
    if (!buf) return null;
    let decoded;
    try {
      decoded = gunzipSync(Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
    } catch (err) {
      console.error(`[task-trace] gunzip failed for parent ${parentTaskId}: ${err.message}`);
      return null;
    }
    let parsed;
    try {
      parsed = JSON.parse(decoded.toString('utf8'));
    } catch (err) {
      console.error(`[task-trace] JSON parse failed for parent ${parentTaskId}: ${err.message}`);
      return null;
    }
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch (err) {
    console.error(`[task-trace] loadTraceForChild failed for ${parentTaskId}: ${err.message}`);
    return null;
  }
}

function renderItems(label, items) {
  if (!Array.isArray(items) || items.length === 0) return '';
  const lines = [`${label}:`];
  for (const it of items) {
    const title = (it.title || '').replace(/\s+/g, ' ').trim();
    const content = (it.content || '').replace(/\s+/g, ' ').trim();
    if (!title && !content) continue;
    if (title && content) {
      lines.push(`  - ${title}: ${content}`);
    } else {
      lines.push(`  - ${title || content}`);
    }
  }
  return lines.length > 1 ? lines.join('\n') : '';
}

/**
 * Render a parsed trace object into a human-readable text block suitable for
 * prompt injection. Returns '' on null/empty input. Output is truncated at
 * `cap` characters (default 6000) and ends with "…(truncated)" when cut.
 */
export function formatTraceForPrompt(obj, cap = 6000) {
  if (!obj || typeof obj !== 'object') return '';
  const limit = Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : 6000;
  const sections = [];

  const taskShort = obj.taskId ? String(obj.taskId).slice(0, 8) : 'unknown';
  sections.push(`Parent task: ${taskShort} (project=${obj.project || '_global'}, type=${obj.taskType || 'standard'})`);

  if (obj.prompt) {
    const prompt = String(obj.prompt).trim();
    if (prompt) sections.push(`Parent prompt:\n${prompt}`);
  }

  const decisionsBlock = renderItems('Recent decisions', obj.decisions);
  if (decisionsBlock) sections.push(decisionsBlock);

  const risksBlock = renderItems('Recent risks', obj.risks);
  if (risksBlock) sections.push(risksBlock);

  const findingsBlock = renderItems('Scratch findings', obj.scratchFindings);
  if (findingsBlock) sections.push(findingsBlock);

  const text = sections.join('\n\n').trim();
  if (text.length <= limit) return text;
  return text.slice(0, limit) + '\n…(truncated)';
}

export const _internals = {
  PROMPT_CAP,
  PER_ITEM_CAP,
  MAX_DECISIONS,
  MAX_RISKS,
  MAX_FINDINGS,
  TRACE_FORMAT_VERSION,
};
