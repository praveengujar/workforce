/**
 * File-System Scratchpad — Context Fabric Milestone 8 (PRD §9.9, Manus pattern).
 *
 * At task spawn we scaffold `.workforce/scratch/{todo,notes,findings}.md` inside
 * the worktree so the agent can recite objectives (todo.md), keep working notes
 * (notes.md), and write durable findings (findings.md). On merge/reject we copy
 * findings.md into context_items so downstream tasks can read it as a memory.
 *
 * All functions are best-effort: scaffold/read failures must never break a task
 * spawn or lifecycle handler. Errors log to stderr and return safe defaults.
 *
 * No new npm deps. ESM. Logs to stderr.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { addContextItem } from './context-memory.js';

const SCRATCH_DIRNAME = '.workforce';
const SCRATCH_SUBDIR = 'scratch';
const FILES = ['todo.md', 'notes.md', 'findings.md'];

const HEADERS = {
  'todo.md':
    '<!-- Workforce scratchpad: todo.md\n'
    + '     Maintain a running checklist for this task.\n'
    + '     Check items off as you complete them (Manus recitation pattern). -->\n'
    + '\n# TODO\n\n',
  'notes.md':
    '<!-- Workforce scratchpad: notes.md\n'
    + '     Free-form working notes. Persist anything you want to remember\n'
    + '     across reasoning steps within this task. -->\n'
    + '\n# Notes\n\n',
  'findings.md':
    '<!-- Workforce scratchpad: findings.md\n'
    + '     Durable findings. On merge or reject these are captured into\n'
    + '     context_items so downstream tasks can read them. Be concrete:\n'
    + '     name files, functions, and the symptom. -->\n'
    + '\n# Findings\n\n',
};

function scratchDir(worktreePath) {
  return join(worktreePath, SCRATCH_DIRNAME, SCRATCH_SUBDIR);
}

/**
 * Create `.workforce/scratch/{todo,notes,findings}.md` inside `worktreePath`.
 * Idempotent: if a file already exists with content, it is left untouched —
 * agent retries should preserve prior findings. Returns the absolute paths of
 * the three files (or [] on failure). Never throws.
 */
export function scaffoldScratchpad(worktreePath) {
  if (!worktreePath || typeof worktreePath !== 'string') return [];
  try {
    const dir = scratchDir(worktreePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const out = [];
    for (const name of FILES) {
      const p = join(dir, name);
      if (!existsSync(p)) {
        writeFileSync(p, HEADERS[name], 'utf8');
      }
      out.push(p);
    }
    return out;
  } catch (err) {
    console.error(`[scratchpad] scaffold failed for ${worktreePath}: ${err.message}`);
    return [];
  }
}

/**
 * Read `.workforce/scratch/findings.md` and return its body, capped at
 * `capChars` characters (default 4000). Returns '' if the file is missing,
 * unreadable, or contains only the scaffold header. Never throws.
 */
export function readScratchpadFindings(worktreePath, capChars = 4000) {
  if (!worktreePath || typeof worktreePath !== 'string') return '';
  const cap = Number.isFinite(capChars) && capChars > 0 ? Math.floor(capChars) : 4000;
  try {
    const p = join(scratchDir(worktreePath), 'findings.md');
    if (!existsSync(p)) return '';
    const raw = readFileSync(p, 'utf8');
    const stripped = stripScaffoldHeader(raw, 'findings.md').trim();
    if (stripped.length === 0) return '';
    if (stripped.length <= cap) return stripped;
    return stripped.slice(0, cap) + '\n…(truncated)';
  } catch (err) {
    console.error(`[scratchpad] read findings failed for ${worktreePath}: ${err.message}`);
    return '';
  }
}

function stripScaffoldHeader(text, name) {
  const header = HEADERS[name];
  if (header && text.startsWith(header)) {
    return text.slice(header.length);
  }
  if (text.startsWith('<!--')) {
    const end = text.indexOf('-->');
    if (end >= 0) return text.slice(end + 3);
  }
  return text;
}

/**
 * Capture `.workforce/scratch/findings.md` into context_items at lifecycle
 * end. `status` must be 'merged' or 'rejected' — anything else is treated as
 * 'merged'. Writes a single context_items row with memoryType='artifact',
 * sourceType='task', trustScore=0.5, and tags=[`scratch_findings`] (or
 * `scratch_findings_rejected` on the reject path) per PRD §9.9. Best-effort:
 * never throws, returns null on bad input or any failure.
 *
 * The `db` argument is unused (writes go through addContextItem which uses
 * the singleton getDb()), but kept in the signature so callers can pass it
 * for forward-compatibility / test isolation.
 */
export function captureScratchpadOnMerge(db, taskId, worktreePath, status = 'merged') {
  if (!taskId || !worktreePath) return null;
  const kind = status === 'rejected' ? 'scratch_findings_rejected' : 'scratch_findings';
  try {
    const findings = readScratchpadFindings(worktreePath, 4000);
    if (!findings) return null;

    let project = '_global';
    try {
      if (db && typeof db.prepare === 'function') {
        const row = db.prepare('SELECT project FROM tasks WHERE id = ?').get(taskId);
        if (row && row.project) project = row.project;
      }
    } catch { /* fall through to default project */ }

    const titleCap = 80;
    const firstLine = findings
      .split('\n')
      .map(l => l.trim())
      .find(l => l.length > 0 && !l.startsWith('#')) || `Scratchpad findings from task ${String(taskId).slice(0, 8)}`;
    const title = firstLine.length > titleCap ? firstLine.slice(0, titleCap - 1) + '…' : firstLine;

    const item = addContextItem({
      project,
      scopeType: 'task',
      scopeId: taskId,
      memoryType: 'artifact',
      title,
      content: findings,
      sourceType: 'task',
      sourceId: taskId,
      trustScore: 0.5,
      authoredBy: `task:${taskId}`,
      tags: [kind, status === 'rejected' ? 'rejected' : 'merged'],
    });
    return item;
  } catch (err) {
    console.error(`[scratchpad] capture failed for task ${taskId}: ${err.message}`);
    return null;
  }
}

/**
 * Test-only handle for header constants and helper paths.
 */
export const _internals = {
  HEADERS,
  FILES,
  scratchDir,
  stripScaffoldHeader,
};
