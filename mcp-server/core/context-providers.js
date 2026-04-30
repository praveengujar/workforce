/**
 * Context Providers — Context Fabric Milestone 4.
 *
 * Pure consumer functions that wrap M0–M3 stores and emit a uniform
 * candidate shape for the Context Assembler:
 *
 *   {
 *     id, layer, sourceType, trustScore, score, reason,
 *     title, content,
 *     // optional metadata used by the assembler / output:
 *     paths, tags, priority, confidence, retrievalOutcome,
 *     createdAt, invalidAt, pinned, raw,
 *   }
 *
 * Each provider:
 *   - Returns a (possibly empty) array of candidates. Never throws.
 *   - Honors the M2 trust threshold by default.
 *   - Excludes invalidated rows (the assembler is the layer that decides
 *     whether to surface an invalidated row as warning context).
 *
 * Providers are stateless and deliberately do NOT do final ranking,
 * deduplication, or budget enforcement — those belong to the assembler.
 *
 * No new npm deps. ESM. Logs to stderr.
 */

import { recallEpisodes } from './episodic-memory.js';
import {
  getRulesForPaths,
  getRulesForKeywords,
  extractPathsFromText,
} from './knowledge-rules.js';
import {
  listContextBlocks,
  listContextItems,
  searchContextItems,
  getContextBlock,
} from './context-memory.js';
import { readAllSharedContext, getTask } from './db.js';
import { getTrustThreshold } from './trust.js';

// ---------------------------------------------------------------------------
// Layer numbers (assembler uses these for per-layer caps + telemetry rows)
// ---------------------------------------------------------------------------

export const LAYER = Object.freeze({
  SHARED: 5,
  EPISODIC: 6,
  RULES: 7,
  CORE_BLOCKS: 8,
  CONTEXT_ITEMS: 9,
});

export const LAYER_NAMES = Object.freeze({
  [LAYER.SHARED]: 'shared_context',
  [LAYER.EPISODIC]: 'episodic_memory',
  [LAYER.RULES]: 'knowledge_rules',
  [LAYER.CORE_BLOCKS]: 'context_blocks',
  [LAYER.CONTEXT_ITEMS]: 'context_items',
});

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function safeJson(s, fallback = null) {
  if (s === undefined || s === null) return fallback;
  if (typeof s !== 'string') return s;
  try { return JSON.parse(s); } catch { return fallback; }
}

function resolveThreshold(opts) {
  if (!opts || opts.trustThreshold === undefined || opts.trustThreshold === null) {
    return getTrustThreshold();
  }
  const n = Number(opts.trustThreshold);
  return Number.isFinite(n) ? n : getTrustThreshold();
}

function logError(scope, err) {
  console.error(`[context-providers:${scope}] ${err && err.message ? err.message : err}`);
}

// ---------------------------------------------------------------------------
// Episodic provider — wraps M1 recallEpisodes
// ---------------------------------------------------------------------------

export function episodicProvider({ project, prompt, plannedFiles = [], maxN = 3 } = {}) {
  if (!project) return [];
  try {
    const rows = recallEpisodes({ project, prompt: prompt || '', plannedFiles, maxN }) || [];
    return rows.map(r => ({
      id: r.id,
      layer: LAYER.EPISODIC,
      sourceType: 'task',
      trustScore: typeof r.trust_score === 'number' ? r.trust_score : 0.7,
      score: typeof r._score === 'number' ? r._score : 0,
      reason: 'episodic recall',
      title: `episode ${r.task_id}`,
      content: formatEpisode(r),
      paths: r.glob_signature ? r.glob_signature.split(',').filter(Boolean) : [],
      createdAt: r.created_at,
      retrievalOutcome: null,
      raw: r,
    }));
  } catch (err) {
    logError('episodic', err);
    return [];
  }
}

function formatEpisode(r) {
  const ps = r.prompt_summary || '';
  const as = r.approach_summary || '';
  const sig = r.glob_signature ? ` (glob=${r.glob_signature})` : '';
  return `Task ${r.task_id}${sig}: ${ps}\nApproach: ${as}`;
}

// ---------------------------------------------------------------------------
// Knowledge rules provider — wraps M2 getRulesForPaths + getRulesForKeywords
// ---------------------------------------------------------------------------

export function knowledgeRulesProvider({ prompt, paths, trustThreshold } = {}) {
  const threshold = trustThreshold === undefined ? getTrustThreshold() : Number(trustThreshold);
  const out = new Map();
  try {
    const allPaths = Array.from(new Set([
      ...(Array.isArray(paths) ? paths : []),
      ...extractPathsFromText(prompt || ''),
    ]));
    if (allPaths.length > 0) {
      for (const r of getRulesForPaths(allPaths, { trustThreshold: threshold }) || []) {
        out.set(r.id, ruleToCandidate(r, 'path match'));
      }
    }
    for (const r of getRulesForKeywords(prompt || '', { trustThreshold: threshold }) || []) {
      if (!out.has(r.id)) out.set(r.id, ruleToCandidate(r, 'keyword match'));
    }
  } catch (err) {
    logError('rules', err);
  }
  return [...out.values()];
}

function ruleToCandidate(rule, reason) {
  const trustScore = typeof rule.trust_score === 'number' ? rule.trust_score : 0.5;
  return {
    id: rule.id,
    layer: LAYER.RULES,
    sourceType: rule.source_type || 'human',
    trustScore,
    score: 0,
    reason,
    title: `[${rule.category}] ${rule.name}`,
    content: rule.content,
    paths: safeJson(rule.paths, []),
    priority: typeof rule.priority === 'number' ? rule.priority : 5,
    createdAt: rule.createdAt || rule.created_at || null,
    raw: rule,
  };
}

// ---------------------------------------------------------------------------
// Session blocks (Letta-style) provider — wraps M3 listContextBlocks
// ---------------------------------------------------------------------------

export function sessionBlocksProvider({ project, trustThreshold } = {}) {
  if (!project) return [];
  try {
    // Trigger lazy hydration of active_focus from session_context (M3 §9.2).
    try { getContextBlock(project, 'active_focus'); } catch { /* non-fatal */ }
    const blocks = listContextBlocks(project, { trustThreshold }) || [];
    return blocks
      .filter(b => b.value && String(b.value).length > 0)
      .map(b => ({
        id: b.id,
        layer: LAYER.CORE_BLOCKS,
        sourceType: b.source_type || 'human',
        trustScore: typeof b.trust_score === 'number' ? b.trust_score : 0.7,
        score: 0,
        reason: b.label === 'active_focus' ? 'active focus' : `core block: ${b.label}`,
        title: b.label,
        content: String(b.value),
        pinned: b.label === 'active_focus' ? 1 : 0,
        createdAt: b.updated_at || b.created_at || null,
        raw: b,
      }));
  } catch (err) {
    logError('blocks', err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Context items (M3 archival memory) provider
// ---------------------------------------------------------------------------

const RELEVANT_MEMORY_TYPES = Object.freeze([
  'semantic', 'decision', 'risk', 'procedural', 'preference', 'artifact',
]);

export function contextItemsProvider({
  project, prompt, plannedFiles = [], scopeId, taskGroup, trustThreshold,
} = {}) {
  if (!project) return [];
  const threshold = trustThreshold === undefined ? getTrustThreshold() : Number(trustThreshold);
  const out = new Map();

  try {
    // Search by free-text query first when prompt is provided
    if (prompt && typeof prompt === 'string' && prompt.trim().length > 0) {
      const hits = searchContextItems(project, prompt, { trustThreshold: threshold, limit: 50 }) || [];
      for (const r of hits) {
        if (!RELEVANT_MEMORY_TYPES.includes(r.memory_type)) continue;
        out.set(r.id, itemToCandidate(r, 'keyword match'));
      }
    }

    // Pull project-wide items (excludes invalidated by default).
    const projectItems = listContextItems(project, {
      trustThreshold: threshold,
      limit: 100,
    }) || [];
    for (const r of projectItems) {
      if (!RELEVANT_MEMORY_TYPES.includes(r.memory_type)) continue;
      if (out.has(r.id)) continue;
      const reason = pathRelevanceReason(r, plannedFiles);
      if (reason) out.set(r.id, itemToCandidate(r, reason));
    }

    // Group/scope-targeted items
    if (taskGroup) {
      const groupItems = listContextItems(project, {
        scopeType: 'task_group', scopeId: taskGroup,
        trustThreshold: threshold, limit: 50,
      }) || [];
      for (const r of groupItems) {
        if (!RELEVANT_MEMORY_TYPES.includes(r.memory_type)) continue;
        if (!out.has(r.id)) out.set(r.id, itemToCandidate(r, 'task_group scope'));
      }
    }
    if (scopeId) {
      const taskItems = listContextItems(project, {
        scopeType: 'task', scopeId,
        trustThreshold: threshold, limit: 25,
      }) || [];
      for (const r of taskItems) {
        if (!RELEVANT_MEMORY_TYPES.includes(r.memory_type)) continue;
        if (!out.has(r.id)) out.set(r.id, itemToCandidate(r, 'task scope'));
      }
    }
  } catch (err) {
    logError('items', err);
  }

  return [...out.values()];
}

function pathRelevanceReason(row, plannedFiles) {
  const itemPaths = safeJson(row.paths, []);
  if (!Array.isArray(itemPaths) || itemPaths.length === 0) {
    // No path scope → keep risk/decision/preference items by default
    if (['risk', 'decision', 'preference'].includes(row.memory_type)) {
      return `${row.memory_type} item`;
    }
    return null;
  }
  if (!Array.isArray(plannedFiles) || plannedFiles.length === 0) return 'project scope';
  const overlap = plannedFiles.some(f =>
    itemPaths.some(p => typeof p === 'string' && (f === p || f.startsWith(p.replace(/\*+$/, '')))),
  );
  return overlap ? 'path overlap' : null;
}

function itemToCandidate(r, reason) {
  return {
    id: r.id,
    layer: LAYER.CONTEXT_ITEMS,
    sourceType: r.source_type || 'system',
    trustScore: typeof r.trust_score === 'number' ? r.trust_score : 0.5,
    score: 0,
    reason,
    title: r.title,
    content: r.content,
    paths: safeJson(r.paths, []),
    tags: safeJson(r.tags, []),
    confidence: typeof r.confidence === 'number' ? r.confidence : 0.5,
    retrievalOutcome: typeof r.retrieval_outcome_score === 'number' ? r.retrieval_outcome_score : null,
    createdAt: r.updated_at || r.created_at || null,
    invalidAt: r.invalid_at || null,
    memoryType: r.memory_type,
    raw: r,
  };
}

// ---------------------------------------------------------------------------
// Shared context provider — read-only consumer of shared_context table
// ---------------------------------------------------------------------------

export function sharedContextProvider({ taskGroup, dependsOn } = {}) {
  const out = new Map();

  try {
    if (taskGroup) {
      const rows = readAllSharedContext(taskGroup) || [];
      for (const r of rows) {
        out.set(`group:${r.id}`, {
          id: `group:${r.id}`,
          layer: LAYER.SHARED,
          sourceType: 'task',
          trustScore: 0.6, // shared_context comes from prior tasks in this group
          score: 0,
          reason: 'task_group shared context',
          title: r.key,
          content: typeof r.value === 'string' ? r.value : JSON.stringify(r.value),
          createdAt: r.createdAt || null,
          raw: r,
        });
      }
    }

    if (Array.isArray(dependsOn)) {
      for (const upstreamId of dependsOn) {
        if (!upstreamId || typeof upstreamId !== 'string') continue;
        const upstream = getTask(upstreamId);
        if (!upstream) continue;
        const summary = upstream.resultSummary;
        if (!summary) continue;
        out.set(`task:${upstreamId}`, {
          id: `task:${upstreamId}`,
          layer: LAYER.SHARED,
          sourceType: 'task',
          trustScore: 0.6,
          score: 0,
          reason: 'upstream dependency result',
          title: `upstream ${upstreamId}`,
          content: typeof summary === 'string' ? summary : JSON.stringify(summary),
          createdAt: upstream.updatedAt || upstream.createdAt || null,
          raw: upstream,
        });
      }
    }
  } catch (err) {
    logError('shared', err);
  }

  return [...out.values()];
}

// ---------------------------------------------------------------------------
// Test-only handles
// ---------------------------------------------------------------------------

export const _internals = {
  safeJson,
  resolveThreshold,
  pathRelevanceReason,
  RELEVANT_MEMORY_TYPES,
};
