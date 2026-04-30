/**
 * Context Fabric M5 — MCP tool handlers for the context fabric.
 *
 * Surfaces M3 (context-memory) + M4 (context-assembler) to MCP. Pure handler
 * layer: ZERO writes outside the M3 store, no worker integration, no auto-
 * apply for promotion. Caller-tagging follows the established M2 pattern:
 * if WORKFORCE_AGENT_TASK_ID is set, the write is tagged source=agent and
 * trust is hard-capped at 0.4 inside context-memory.js.
 *
 * Tool wiring (PRD §10) lives in mcp-server/index.js.
 *
 * Promotion is intent-only in v3.6 (PRD §9.7). The handler returns the
 * proposed candidate so the caller can gate via AskUserQuestion in a
 * separate workflow before any apply step lands.
 *
 * Compaction invalidates near-duplicate rows (same title+content hash);
 * never merges content (would lose information). The canonical row is
 * preserved.
 *
 * No new npm deps. ESM. Logs to stderr.
 */

import { createHash } from 'node:crypto';

import {
  addContextItem,
  searchContextItems,
  listContextItems,
  invalidateContextItem,
  listContextAudits,
  getContextItem,
  SCOPE_TYPES,
  MEMORY_TYPES,
} from '../core/context-memory.js';
import { assembleContext } from '../core/context-assembler.js';

// ---------------------------------------------------------------------------
// Caller-tagging — matches the M2 pattern used in session-tools.js and
// knowledge-tools.js. WORKFORCE_AGENT_TASK_ID is exported into the tmux env
// at task spawn (worker-manager.js); when present, the caller is a spawned
// agent, otherwise the caller is the human user.
// ---------------------------------------------------------------------------

function getCallerProvenance() {
  const agentTaskId = process.env.WORKFORCE_AGENT_TASK_ID;
  if (agentTaskId) {
    return { sourceType: 'agent', authoredBy: `agent:${agentTaskId}` };
  }
  return { sourceType: 'human', authoredBy: 'user' };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function safeParse(s, fallback) {
  if (s === undefined || s === null) return fallback;
  if (typeof s !== 'string') return s;
  try { return JSON.parse(s); } catch { return fallback; }
}

function shapeItem(row) {
  if (!row) return null;
  return {
    id: row.id,
    project: row.project,
    scopeType: row.scope_type,
    scopeId: row.scope_id,
    memoryType: row.memory_type,
    title: row.title,
    content: row.content,
    summary: row.summary,
    sourceType: row.source_type,
    authoredBy: row.authored_by,
    paths: safeParse(row.paths, []),
    tags: safeParse(row.tags, []),
    trust: row.trust,
    trustScore: row.trust_score,
    confidence: row.confidence,
    invalidAt: row.invalid_at,
    invalidatedBy: row.invalidated_by,
    invalidationReason: row.invalidation_reason,
    ttlDays: row.ttl_days,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function hashContent(value) {
  return createHash('sha256').update(String(value || '')).digest('hex').slice(0, 32);
}

function pathOverlap(itemPaths, queryPaths) {
  if (!Array.isArray(itemPaths) || itemPaths.length === 0) return false;
  if (!Array.isArray(queryPaths) || queryPaths.length === 0) return true;
  return queryPaths.some(q =>
    itemPaths.some(p => typeof p === 'string' && typeof q === 'string'
      && (q === p || q.startsWith(p.replace(/\*+$/, '')) || p.startsWith(q))),
  );
}

// ---------------------------------------------------------------------------
// 1. workforce_context_add
// ---------------------------------------------------------------------------

export async function addContextItemHandler({
  project, memoryType, title, content,
  scopeType, scopeId, paths, tags,
  trust, trustScore, ttlDays,
} = {}) {
  if (!project) throw new Error('project is required');
  if (!memoryType) throw new Error('memoryType is required');
  if (!title) throw new Error('title is required');
  if (!content) throw new Error('content is required');
  if (!scopeType) throw new Error('scopeType is required');

  const provenance = getCallerProvenance();
  const row = addContextItem({
    project,
    memoryType,
    title,
    content,
    scopeType,
    scopeId,
    paths,
    tags,
    trust,
    trustScore,
    ttlDays,
    sourceType: provenance.sourceType,
    authoredBy: provenance.authoredBy,
  });

  return {
    ok: true,
    item: shapeItem(row),
    callerSource: provenance.sourceType,
    authoredBy: provenance.authoredBy,
  };
}

// ---------------------------------------------------------------------------
// 2. workforce_context_search
// ---------------------------------------------------------------------------

export async function searchContextItemsHandler({
  project, query, memoryType, paths,
  includeInvalidated, trustThreshold, limit,
} = {}) {
  if (!project) throw new Error('project is required');

  const opts = {
    includeInvalidated: !!includeInvalidated,
    limit: typeof limit === 'number' ? limit : undefined,
  };
  if (trustThreshold !== undefined && trustThreshold !== null) {
    opts.trustThreshold = Number(trustThreshold);
  }

  let rows;
  if (query && typeof query === 'string' && query.trim().length > 0) {
    rows = searchContextItems(project, query, opts) || [];
  } else {
    rows = listContextItems(project, {
      ...opts,
      memoryType,
    }) || [];
  }

  let filtered = rows;
  if (memoryType) {
    filtered = filtered.filter(r => r.memory_type === memoryType);
  }
  if (Array.isArray(paths) && paths.length > 0) {
    filtered = filtered.filter(r => pathOverlap(safeParse(r.paths, []), paths));
  }

  return {
    ok: true,
    project,
    count: filtered.length,
    items: filtered.map(r => {
      const s = shapeItem(r);
      return {
        id: s.id,
        title: s.title,
        memoryType: s.memoryType,
        sourceType: s.sourceType,
        authoredBy: s.authoredBy,
        trustScore: s.trustScore,
        trust: s.trust,
        paths: s.paths,
        tags: s.tags,
        invalidAt: s.invalidAt,
        contentPreview: s.content && s.content.length > 200
          ? s.content.slice(0, 200) + '...'
          : s.content,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// 3. workforce_context_preview
// ---------------------------------------------------------------------------

export async function previewContextHandler({
  project, prompt, taskType, taskGroup, dependsOn,
  budget, trustThreshold,
} = {}) {
  if (!project) throw new Error('project is required');
  if (prompt === undefined || prompt === null) throw new Error('prompt is required');

  // No taskId → no audit row written, no telemetry persisted (preview mode).
  const result = assembleContext({
    project,
    prompt,
    taskType,
    taskGroup,
    dependsOn,
    budget,
    trustThreshold,
    mode: 'preview',
  });

  return {
    ok: true,
    promptBlock: result.promptBlock,
    sections: result.sections,
    audit: result.audit,
  };
}

// ---------------------------------------------------------------------------
// 4. workforce_context_audit
// ---------------------------------------------------------------------------

export async function auditContextHandler({ taskId } = {}) {
  if (!taskId) throw new Error('taskId is required');

  const rows = listContextAudits(taskId) || [];
  return {
    ok: true,
    taskId,
    count: rows.length,
    audits: rows.map(r => ({
      id: r.id,
      project: r.project,
      promptHash: r.prompt_hash,
      contextHash: r.context_hash,
      budget: r.budget,
      trustThreshold: r.trust_threshold,
      selected: safeParse(r.selected_items, []),
      omitted: safeParse(r.omitted_items, []),
      conflicts: safeParse(r.conflicts, []),
      perLayerChars: safeParse(r.per_layer_chars, {}),
      assembledPromptPreview: r.assembled_prompt_preview,
      createdAt: r.created_at,
    })),
  };
}

// ---------------------------------------------------------------------------
// 5. workforce_context_invalidate
// ---------------------------------------------------------------------------

export async function invalidateContextHandler({ id, reason, invalidatedBy } = {}) {
  if (!id) throw new Error('id is required');

  const provenance = getCallerProvenance();
  const by = invalidatedBy || provenance.authoredBy;
  const row = invalidateContextItem(id, { invalidatedBy: by, reason });

  return {
    ok: true,
    invalidated: {
      id: row.id,
      invalidAt: row.invalid_at,
      invalidatedBy: row.invalidated_by,
      invalidationReason: row.invalidation_reason,
    },
  };
}

// ---------------------------------------------------------------------------
// 6. workforce_context_promote
//
// Intent-only per PRD §9.7. The handler does NOT mutate state; it returns
// the proposed candidate so the caller can gate via AskUserQuestion in a
// separate workflow.
// ---------------------------------------------------------------------------

const PROMOTION_TARGETS = Object.freeze(['core_block', 'knowledge_rule', 'high_trust_memory']);

export async function promoteContextHandler({ id, target, label, requiresApproval } = {}) {
  if (!id) throw new Error('id is required');
  if (!target) throw new Error('target is required');
  if (!PROMOTION_TARGETS.includes(target)) {
    throw new Error(`invalid target '${target}'. Must be one of: ${PROMOTION_TARGETS.join(', ')}`);
  }

  const row = getContextItem(id);
  if (!row) throw new Error(`context_item not found: ${id}`);

  // Per PRD §9.7: core_block and high_trust_memory are always gated; knowledge_rule
  // can be opted out via requiresApproval=false but defaults to gated.
  const gated = requiresApproval === undefined
    ? true
    : !!requiresApproval;

  const candidate = {
    sourceItemId: row.id,
    target,
    label: label || row.title,
    proposed: {
      title: row.title,
      content: row.content,
      sourceType: row.source_type,
      trustScore: row.trust_score,
      paths: safeParse(row.paths, []),
      tags: safeParse(row.tags, []),
      memoryType: row.memory_type,
    },
  };

  return {
    ok: true,
    candidate,
    requiresApproval: gated,
    applied: false,
    note: 'Promotion is intent-only in v3.6 (PRD §9.7). Apply via the gated workflow.',
  };
}

// ---------------------------------------------------------------------------
// 7. workforce_context_compact
//
// Invalidates near-duplicate rows (same title + same content hash). Never
// merges content (would lose information). Canonical row = oldest by
// created_at among the duplicate set; ties broken by highest trust_score.
// ---------------------------------------------------------------------------

export async function compactContextHandler({
  project, scopeType, olderThanDays, memoryType, dryRun = false,
} = {}) {
  if (!project) throw new Error('project is required');
  if (scopeType !== undefined && scopeType !== null && !SCOPE_TYPES.includes(scopeType)) {
    throw new Error(`invalid scopeType '${scopeType}'. Must be one of: ${SCOPE_TYPES.join(', ')}`);
  }
  if (memoryType !== undefined && memoryType !== null && !MEMORY_TYPES.includes(memoryType)) {
    throw new Error(`invalid memoryType '${memoryType}'. Must be one of: ${MEMORY_TYPES.join(', ')}`);
  }

  const rows = listContextItems(project, {
    scopeType,
    memoryType,
    trustThreshold: 0,
    limit: 1000,
  }) || [];

  // Optional age filter
  let pool = rows;
  if (Number.isFinite(Number(olderThanDays)) && Number(olderThanDays) > 0) {
    const cutoff = Date.now() - Number(olderThanDays) * 24 * 60 * 60 * 1000;
    pool = pool.filter(r => {
      const t = Date.parse(r.created_at);
      return Number.isFinite(t) && t < cutoff;
    });
  }

  // Group by (title, content_hash)
  const groups = new Map();
  for (const r of pool) {
    const key = `${r.title}|${hashContent(r.content)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }

  const candidates = [];
  for (const [key, group] of groups.entries()) {
    if (group.length < 2) continue;
    // Canonical = oldest createdAt; tie-break: highest trust_score
    const sorted = [...group].sort((a, b) => {
      const aT = Date.parse(a.created_at) || 0;
      const bT = Date.parse(b.created_at) || 0;
      if (aT !== bT) return aT - bT;
      return (b.trust_score || 0) - (a.trust_score || 0);
    });
    const canonical = sorted[0];
    const duplicates = sorted.slice(1);
    candidates.push({
      key,
      canonical: { id: canonical.id, title: canonical.title, createdAt: canonical.created_at },
      duplicates: duplicates.map(d => ({
        id: d.id, createdAt: d.created_at, trustScore: d.trust_score,
      })),
    });
  }

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      duplicateGroups: candidates.length,
      candidates,
      invalidated: 0,
    };
  }

  const provenance = getCallerProvenance();
  const reason = 'compact: near-duplicate (same title + content hash)';
  let invalidated = 0;
  for (const group of candidates) {
    for (const dup of group.duplicates) {
      try {
        invalidateContextItem(dup.id, {
          invalidatedBy: provenance.authoredBy,
          reason,
        });
        invalidated++;
      } catch (err) {
        console.error(`[context-memory-tools:compact] failed to invalidate ${dup.id}: ${err.message}`);
      }
    }
  }

  return {
    ok: true,
    dryRun: false,
    duplicateGroups: candidates.length,
    invalidated,
    candidates,
  };
}

// ---------------------------------------------------------------------------
// Test-only handles
// ---------------------------------------------------------------------------

export const _internals = {
  getCallerProvenance,
  hashContent,
  pathOverlap,
  shapeItem,
  PROMOTION_TARGETS,
};
