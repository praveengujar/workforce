/**
 * Context Memory — Context Fabric Milestone 3.
 *
 * Data layer for the context items / blocks / audits / per-layer telemetry
 * tables introduced in migration 17 (PRD §9.1, §9.2, §9.4, §9.5).
 *
 * This module is pure CRUD + provenance/trust enforcement. No MCP tools (M5),
 * no worker integration (M6), no assembler (M4) live here. All writes route
 * through trust.js so agent-authored entries cannot exceed their poisoning
 * ceiling regardless of the trust_score the caller supplied.
 *
 * No new npm deps. ESM. Logs to stderr.
 */

import { randomUUID } from 'node:crypto';
import { getDb, stmt } from './db.js';
import {
  DEFAULT_TRUST_BY_SOURCE,
  clampTrustForSource,
  getDefaultTrust,
  getTrustThreshold,
} from './trust.js';
import { getSessionContext } from './session-context.js';

// ---------------------------------------------------------------------------
// Enums (PRD §9.1)
// ---------------------------------------------------------------------------

export const SCOPE_TYPES = Object.freeze([
  'project', 'task_group', 'task', 'agent', 'global',
]);

export const MEMORY_TYPES = Object.freeze([
  'semantic', 'episodic', 'procedural', 'artifact', 'decision', 'risk', 'preference',
]);

export const SOURCE_TYPES = Object.freeze(Object.keys(DEFAULT_TRUST_BY_SOURCE));

// Default `context_blocks` blocks per PRD §9.2.
const DEFAULT_BLOCKS = Object.freeze([
  {
    label: 'active_focus',
    description: 'What the user is currently working on. Hydrated from session_context.active_focus on first read.',
    value: '',
    char_limit: 2000,
    read_only: 0,
  },
  {
    label: 'repo_profile',
    description: 'Stable repo-level facts: stack, frameworks, build/test commands, key directories.',
    value: '',
    char_limit: 2000,
    read_only: 0,
  },
  {
    label: 'open_decisions',
    description: 'Decisions in flight whose outcome will shape near-term work.',
    value: '',
    char_limit: 2000,
    read_only: 0,
  },
  {
    label: 'known_risks',
    description: 'Active risks, incidents, or constraints to avoid regressing on.',
    value: '',
    char_limit: 2000,
    read_only: 0,
  },
  {
    label: 'task_preferences',
    description: 'How the user wants tasks executed — voice, brevity, autonomy, conventions.',
    value: '',
    char_limit: 2000,
    read_only: 0,
  },
  {
    label: 'architecture_notes',
    description: 'Cross-cutting architecture facts that apply across most tasks.',
    value: '',
    char_limit: 2000,
    read_only: 0,
  },
]);

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function assertEnum(value, allowed, fieldName) {
  if (!allowed.includes(value)) {
    throw new Error(
      `Invalid ${fieldName}: '${value}'. Must be one of: ${allowed.join(', ')}`,
    );
  }
}

function assertNonEmpty(value, fieldName) {
  if (value === undefined || value === null || value === '') {
    throw new Error(`${fieldName} is required`);
  }
}

function jsonOrNull(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch { return null; }
}

function trustLabelFromScore(score) {
  if (score >= 0.8) return 'high';
  if (score >= 0.5) return 'medium';
  return 'low';
}

function resolveThreshold(opts) {
  if (!opts) return getTrustThreshold();
  const v = opts.trustThreshold;
  if (v === undefined || v === null) return getTrustThreshold();
  const n = Number(v);
  return Number.isFinite(n) ? n : getTrustThreshold();
}

// ---------------------------------------------------------------------------
// FTS5 detection (runtime — handles "drop and recreate without FTS5")
// ---------------------------------------------------------------------------

let _ftsCache = null;
export function isFtsAvailable() {
  if (_ftsCache !== null) return _ftsCache;
  try {
    const row = getDb().prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='context_items_fts'",
    ).get();
    _ftsCache = !!row;
  } catch {
    _ftsCache = false;
  }
  return _ftsCache;
}

export function _resetFtsCache() { _ftsCache = null; }

// ---------------------------------------------------------------------------
// context_items CRUD
// ---------------------------------------------------------------------------

/**
 * Insert a new context_item. Returns the persisted row.
 *
 * Required: project, scopeType, memoryType, title, content, sourceType.
 * Trust is clamped via clampTrustForSource (agent writes capped at 0.4).
 */
export function addContextItem(input = {}) {
  assertNonEmpty(input.project, 'project');
  assertNonEmpty(input.title, 'title');
  assertNonEmpty(input.content, 'content');
  assertEnum(input.scopeType, SCOPE_TYPES, 'scope_type');
  assertEnum(input.memoryType, MEMORY_TYPES, 'memory_type');
  assertEnum(input.sourceType, SOURCE_TYPES, 'source_type');

  const now = new Date().toISOString();
  const id = input.id || randomUUID();
  const trustScore = clampTrustForSource(input.sourceType, input.trustScore);
  const trust = input.trust || trustLabelFromScore(trustScore);
  const authoredBy = input.authoredBy || (input.sourceType === 'human' ? 'user' : input.sourceType);

  getDb().prepare(`
    INSERT INTO context_items (
      id, project, scope_type, scope_id, memory_type, title, content, summary,
      source_type, source_id, source_chain, authored_by,
      paths, tags, glob_signature,
      trust, trust_score, confidence, last_validated_at,
      retrieval_count, retrieval_outcome_score,
      valid_from, invalid_at, invalidated_by, invalidation_reason, ttl_days,
      created_at, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?
    )
  `).run(
    id,
    input.project,
    input.scopeType,
    input.scopeId ?? null,
    input.memoryType,
    input.title,
    input.content,
    input.summary ?? null,
    input.sourceType,
    input.sourceId ?? null,
    jsonOrNull(input.sourceChain),
    authoredBy,
    jsonOrNull(input.paths),
    jsonOrNull(input.tags),
    input.globSignature ?? null,
    trust,
    trustScore,
    input.confidence ?? 0.5,
    input.lastValidatedAt ?? now,
    0,
    null,
    input.validFrom ?? now,
    null,
    null,
    null,
    input.ttlDays ?? null,
    now,
    now,
  );

  if (isFtsAvailable()) {
    try {
      getDb().prepare(`
        INSERT INTO context_items_fts (rowid, title, content, summary, tags)
        SELECT rowid, title, content, COALESCE(summary, ''), COALESCE(tags, '')
          FROM context_items WHERE id = ?
      `).run(id);
    } catch (err) {
      console.error(`[context-memory] FTS5 insert failed (degrading to LIKE): ${err.message}`);
    }
  }

  return getContextItem(id);
}

export function getContextItem(id) {
  if (!id) return null;
  return stmt('SELECT * FROM context_items WHERE id = ?').get(id) || null;
}

/**
 * Update a context_item. Mutable fields: title, content, summary, paths, tags,
 * confidence, lastValidatedAt, retrievalOutcomeScore, ttlDays. Trust + source
 * provenance are immutable post-insert (audit invariant).
 */
export function updateContextItem(id, updates = {}) {
  const existing = getContextItem(id);
  if (!existing) throw new Error(`context_item not found: ${id}`);

  const now = new Date().toISOString();
  const next = {
    title: updates.title ?? existing.title,
    content: updates.content ?? existing.content,
    summary: updates.summary ?? existing.summary,
    paths: updates.paths !== undefined ? jsonOrNull(updates.paths) : existing.paths,
    tags: updates.tags !== undefined ? jsonOrNull(updates.tags) : existing.tags,
    confidence: updates.confidence ?? existing.confidence,
    last_validated_at: updates.lastValidatedAt ?? existing.last_validated_at,
    retrieval_outcome_score: updates.retrievalOutcomeScore ?? existing.retrieval_outcome_score,
    ttl_days: updates.ttlDays ?? existing.ttl_days,
  };

  getDb().prepare(`
    UPDATE context_items
       SET title = ?, content = ?, summary = ?, paths = ?, tags = ?,
           confidence = ?, last_validated_at = ?, retrieval_outcome_score = ?,
           ttl_days = ?, updated_at = ?
     WHERE id = ?
  `).run(
    next.title, next.content, next.summary, next.paths, next.tags,
    next.confidence, next.last_validated_at, next.retrieval_outcome_score,
    next.ttl_days, now, id,
  );

  if (isFtsAvailable()) {
    try {
      getDb().prepare(`
        INSERT INTO context_items_fts (context_items_fts, rowid, title, content, summary, tags)
        VALUES ('delete', (SELECT rowid FROM context_items WHERE id = ?), ?, ?, ?, ?)
      `).run(id, existing.title, existing.content, existing.summary || '', existing.tags || '');
      getDb().prepare(`
        INSERT INTO context_items_fts (rowid, title, content, summary, tags)
        SELECT rowid, title, content, COALESCE(summary, ''), COALESCE(tags, '')
          FROM context_items WHERE id = ?
      `).run(id);
    } catch (err) {
      console.error(`[context-memory] FTS5 update failed: ${err.message}`);
    }
  }

  return getContextItem(id);
}

/**
 * Mark a context_item invalid (Mem0-style ADD-only). The row is preserved for
 * audit; it just stops appearing in default list/search results.
 */
export function invalidateContextItem(id, { invalidatedBy, reason } = {}) {
  const existing = getContextItem(id);
  if (!existing) throw new Error(`context_item not found: ${id}`);
  const now = new Date().toISOString();
  getDb().prepare(`
    UPDATE context_items
       SET invalid_at = ?, invalidated_by = ?, invalidation_reason = ?, updated_at = ?
     WHERE id = ?
  `).run(now, invalidatedBy ?? 'system', reason ?? null, now, id);
  return getContextItem(id);
}

/**
 * List context items for a project, filtered by scope/memory/source/threshold.
 * Excludes invalidated rows by default.
 */
export function listContextItems(project, opts = {}) {
  assertNonEmpty(project, 'project');

  const threshold = resolveThreshold(opts);
  const where = ['project = ?', 'COALESCE(trust_score, 0.4) >= ?'];
  const params = [project, threshold];

  if (!opts.includeInvalidated) where.push('invalid_at IS NULL');

  if (opts.scopeType) {
    assertEnum(opts.scopeType, SCOPE_TYPES, 'scope_type');
    where.push('scope_type = ?');
    params.push(opts.scopeType);
  }
  if (opts.scopeId) { where.push('scope_id = ?'); params.push(opts.scopeId); }
  if (opts.memoryType) {
    assertEnum(opts.memoryType, MEMORY_TYPES, 'memory_type');
    where.push('memory_type = ?');
    params.push(opts.memoryType);
  }
  if (opts.sourceType) {
    assertEnum(opts.sourceType, SOURCE_TYPES, 'source_type');
    where.push('source_type = ?');
    params.push(opts.sourceType);
  }

  const limit = Math.min(Math.max(1, Number(opts.limit) || 100), 1000);
  const sql = `
    SELECT * FROM context_items
     WHERE ${where.join(' AND ')}
     ORDER BY trust_score DESC, updated_at DESC
     LIMIT ${limit}
  `;
  return getDb().prepare(sql).all(...params);
}

/**
 * Search context items by free-text query. Uses FTS5 if available, falls
 * back to LIKE-based scan otherwise. Honors trust threshold + invalidation.
 */
export function searchContextItems(project, query, opts = {}) {
  assertNonEmpty(project, 'project');
  if (!query || typeof query !== 'string') return [];

  const threshold = resolveThreshold(opts);
  const limit = Math.min(Math.max(1, Number(opts.limit) || 25), 200);
  const includeInvalidated = !!opts.includeInvalidated;
  const forceLike = !!opts.forceLike;

  if (!forceLike && isFtsAvailable()) {
    try {
      const sql = `
        SELECT ci.* FROM context_items_fts fts
        JOIN context_items ci ON ci.rowid = fts.rowid
        WHERE context_items_fts MATCH ?
          AND ci.project = ?
          AND COALESCE(ci.trust_score, 0.4) >= ?
          ${includeInvalidated ? '' : 'AND ci.invalid_at IS NULL'}
        ORDER BY ci.trust_score DESC, ci.updated_at DESC
        LIMIT ${limit}
      `;
      return getDb().prepare(sql).all(query, project, threshold);
    } catch (err) {
      console.error(`[context-memory] FTS5 search failed; falling back to LIKE: ${err.message}`);
    }
  }

  const tokens = String(query)
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter(t => t.length >= 2)
    .slice(0, 8);
  if (tokens.length === 0) return [];

  const likeClauses = tokens.map(() =>
    '(LOWER(title) LIKE ? OR LOWER(content) LIKE ? OR LOWER(COALESCE(summary, \'\')) LIKE ? OR LOWER(COALESCE(tags, \'\')) LIKE ?)',
  ).join(' OR ');
  const params = [project, threshold];
  for (const t of tokens) {
    const pat = `%${t}%`;
    params.push(pat, pat, pat, pat);
  }

  const sql = `
    SELECT * FROM context_items
     WHERE project = ?
       AND COALESCE(trust_score, 0.4) >= ?
       ${includeInvalidated ? '' : 'AND invalid_at IS NULL'}
       AND (${likeClauses})
     ORDER BY trust_score DESC, updated_at DESC
     LIMIT ${limit}
  `;
  return getDb().prepare(sql).all(...params);
}

// ---------------------------------------------------------------------------
// context_blocks CRUD (Letta-style core memory, PRD §9.2)
// ---------------------------------------------------------------------------

let _seededProjects = new Set();

function seedDefaultBlocks(project) {
  if (_seededProjects.has(project)) return;
  const db = getDb();
  const now = new Date().toISOString();
  const insert = db.prepare(`
    INSERT OR IGNORE INTO context_blocks (
      id, project, label, description, value, char_limit,
      trust, trust_score, read_only, source_type, authored_by, updated_by,
      version, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'medium', 0.7, ?, 'system', 'system', 'system', 1, ?, ?)
  `);
  for (const b of DEFAULT_BLOCKS) {
    insert.run(
      randomUUID(), project, b.label, b.description, b.value,
      b.char_limit, b.read_only, now, now,
    );
  }
  _seededProjects.add(project);
}

export function _resetSeedCache() { _seededProjects = new Set(); }

/**
 * Read a single context block. On first read of `active_focus` for a project,
 * hydrate the block value from session_context.active_focus if present and
 * the block is currently empty.
 */
export function getContextBlock(project, label) {
  assertNonEmpty(project, 'project');
  assertNonEmpty(label, 'label');
  seedDefaultBlocks(project);

  let row = stmt('SELECT * FROM context_blocks WHERE project = ? AND label = ?').get(project, label);

  if (label === 'active_focus' && row && (!row.value || row.value === '')) {
    try {
      const sc = getSessionContext(project, 'active_focus');
      const hydrated = sc && sc.value ? sc.value : null;
      if (hydrated) {
        const now = new Date().toISOString();
        getDb().prepare(`
          UPDATE context_blocks
             SET value = ?, updated_at = ?, updated_by = 'session_context_hydration', version = version + 1
           WHERE project = ? AND label = ?
        `).run(hydrated, now, project, label);
        row = stmt('SELECT * FROM context_blocks WHERE project = ? AND label = ?').get(project, label);
      }
    } catch (err) {
      console.error(`[context-memory] active_focus hydration failed: ${err.message}`);
    }
  }

  return row || null;
}

/**
 * Upsert a context block. read_only blocks reject value updates but allow
 * description metadata changes from a human source.
 */
export function setContextBlock(project, label, value, opts = {}) {
  assertNonEmpty(project, 'project');
  assertNonEmpty(label, 'label');
  if (value === undefined || value === null) throw new Error('value is required');
  seedDefaultBlocks(project);

  const sourceType = opts.sourceType || 'human';
  assertEnum(sourceType, SOURCE_TYPES, 'source_type');
  const trustScore = clampTrustForSource(sourceType, opts.trustScore);
  const trust = opts.trust || trustLabelFromScore(trustScore);
  const authoredBy = opts.authoredBy || (sourceType === 'human' ? 'user' : sourceType);
  const updatedBy = opts.updatedBy || authoredBy;
  const now = new Date().toISOString();

  const existing = stmt('SELECT * FROM context_blocks WHERE project = ? AND label = ?').get(project, label);
  if (existing && existing.read_only) {
    throw new Error(`context_block '${label}' is read_only`);
  }

  const charLimit = Number.isFinite(Number(opts.charLimit))
    ? Number(opts.charLimit)
    : (existing ? existing.char_limit : 2000);
  const readOnly = opts.readOnly !== undefined
    ? (opts.readOnly ? 1 : 0)
    : (existing ? existing.read_only : 0);
  const description = opts.description ?? (existing ? existing.description : label);

  if (existing) {
    getDb().prepare(`
      UPDATE context_blocks
         SET value = ?, description = ?, char_limit = ?, trust = ?, trust_score = ?,
             read_only = ?, source_type = ?, authored_by = ?, updated_by = ?,
             version = version + 1, updated_at = ?
       WHERE project = ? AND label = ?
    `).run(
      String(value), description, charLimit, trust, trustScore,
      readOnly, sourceType, authoredBy, updatedBy, now, project, label,
    );
  } else {
    getDb().prepare(`
      INSERT INTO context_blocks (
        id, project, label, description, value, char_limit,
        trust, trust_score, read_only, source_type, authored_by, updated_by,
        version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(
      randomUUID(), project, label, description, String(value), charLimit,
      trust, trustScore, readOnly, sourceType, authoredBy, updatedBy, now, now,
    );
  }

  return stmt('SELECT * FROM context_blocks WHERE project = ? AND label = ?').get(project, label);
}

/**
 * List all context blocks for a project. On first call, seeds the default
 * blocks (active_focus, repo_profile, ...) per PRD §9.2.
 */
export function listContextBlocks(project, opts = {}) {
  assertNonEmpty(project, 'project');
  seedDefaultBlocks(project);
  const threshold = resolveThreshold(opts);
  return getDb().prepare(`
    SELECT * FROM context_blocks
     WHERE project = ?
       AND COALESCE(trust_score, 0.7) >= ?
     ORDER BY label ASC
  `).all(project, threshold);
}

// ---------------------------------------------------------------------------
// task_context_audits (PRD §9.4)
// ---------------------------------------------------------------------------

/**
 * Record a per-task context audit snapshot. Each call inserts a new row;
 * audits are append-only.
 */
export function writeContextAudit(input = {}) {
  assertNonEmpty(input.taskId, 'task_id');
  const now = new Date().toISOString();
  const id = input.id || randomUUID();
  getDb().prepare(`
    INSERT INTO task_context_audits (
      id, task_id, project, prompt_hash, context_hash, budget,
      selected_items, omitted_items, conflicts, trust_threshold,
      assembled_prompt_preview, per_layer_chars, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.taskId,
    input.project ?? null,
    input.promptHash ?? null,
    input.contextHash ?? null,
    input.budget ?? null,
    jsonOrNull(input.selectedItems),
    jsonOrNull(input.omittedItems),
    jsonOrNull(input.conflicts),
    input.trustThreshold ?? null,
    input.assembledPromptPreview ?? null,
    jsonOrNull(input.perLayerChars),
    now,
  );
  return getContextAudit(id);
}

export function getContextAudit(id) {
  if (!id) return null;
  return stmt('SELECT * FROM task_context_audits WHERE id = ?').get(id) || null;
}

export function listContextAudits(taskId, opts = {}) {
  assertNonEmpty(taskId, 'task_id');
  const limit = Math.min(Math.max(1, Number(opts.limit) || 50), 500);
  return getDb().prepare(`
    SELECT * FROM task_context_audits
     WHERE task_id = ?
     ORDER BY created_at DESC
     LIMIT ${limit}
  `).all(taskId);
}

// ---------------------------------------------------------------------------
// prompt_layers (PRD §9.5)
// ---------------------------------------------------------------------------

/**
 * UPSERT per-layer telemetry for a task. Idempotent on (task_id, layer_num).
 */
export function writeLayerTelemetry(input = {}) {
  assertNonEmpty(input.taskId, 'task_id');
  if (!Number.isInteger(input.layerNum)) throw new Error('layer_num must be an integer');
  assertNonEmpty(input.layerName, 'layer_name');
  const charCount = Number.isFinite(Number(input.charCount)) ? Number(input.charCount) : 0;
  const wasTruncated = input.wasTruncated ? 1 : 0;
  const retrievalCount = input.retrievalCount ?? null;
  const selectedCount = input.selectedCount ?? null;

  getDb().prepare(`
    INSERT INTO prompt_layers (
      task_id, layer_num, layer_name, char_count, was_truncated,
      retrieval_count, selected_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(task_id, layer_num) DO UPDATE SET
      layer_name = excluded.layer_name,
      char_count = excluded.char_count,
      was_truncated = excluded.was_truncated,
      retrieval_count = excluded.retrieval_count,
      selected_count = excluded.selected_count
  `).run(
    input.taskId, input.layerNum, input.layerName, charCount, wasTruncated,
    retrievalCount, selectedCount,
  );
  return getLayerTelemetry(input.taskId);
}

export function getLayerTelemetry(taskId) {
  assertNonEmpty(taskId, 'task_id');
  return stmt(
    'SELECT * FROM prompt_layers WHERE task_id = ? ORDER BY layer_num ASC',
  ).all(taskId);
}

// ---------------------------------------------------------------------------
// Test-only handles
// ---------------------------------------------------------------------------

export const _internals = {
  DEFAULT_BLOCKS,
  trustLabelFromScore,
  resolveThreshold,
  jsonOrNull,
  getDefaultTrust,
};
