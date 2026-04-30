/**
 * Context Assembler — Context Fabric Milestone 4.
 *
 * Pure consumer: READS from M0–M3 stores via context-providers.js, WRITES
 * audit + per-layer telemetry to M3 tables only. Does not touch worker-manager
 * (M6), MCP tools (M5), or any provider's data. Worker-manager continues to
 * use its hardcoded layers until M6; this module ships an unused-but-callable
 * API so M5 can wrap it and M6 can switch over.
 *
 * Per PRD §9.6:
 *   assembleContext({
 *     project, prompt, taskType, taskId, taskGroup, dependsOn,
 *     profile, repoRoot, budget, trustThreshold = 0.5, mode,
 *   })
 *
 * Returns:
 *   {
 *     promptBlock: string,
 *     sections: [{ name, trust, budgetUsed, entries: [...] }],
 *     audit: {
 *       query, budget, trustThreshold,
 *       candidates, selected, omitted, conflicts,
 *       perLayerChars, generatedAt,
 *       error,            // present only on degraded result
 *     }
 *   }
 *
 * Constraints honored:
 *   - Top-level try/catch — never throws; degraded result on error.
 *   - Audit always emitted, even on partial-failure paths and empty prompt.
 *   - Per-layer telemetry written for every section that ran (retrieved or
 *     selected count > 0, or section was attempted with an empty result).
 *   - Budget never exceeded (total + per-layer caps).
 *   - Trust threshold enforced at the candidate level.
 *   - Conflict detection is keyword-anchor heuristic — surfaced, never
 *     auto-resolved.
 *
 * No new npm deps. ESM. Logs to stderr.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeContextAudit, writeLayerTelemetry } from './context-memory.js';
import { getTrustThreshold } from './trust.js';
import { extractPathsFromText } from './knowledge-rules.js';
import {
  episodicProvider,
  knowledgeRulesProvider,
  sessionBlocksProvider,
  contextItemsProvider,
  sharedContextProvider,
  LAYER,
  LAYER_NAMES,
} from './context-providers.js';

// ---------------------------------------------------------------------------
// Defaults — read from config/defaults.json with fallbacks per PRD §9.12
// ---------------------------------------------------------------------------

const FALLBACK_CONTEXT_DEFAULTS = Object.freeze({
  enabled: true,
  defaultBudgetChars: 6000,
  coreBudgetChars: 2000,
  rulesBudgetChars: 3000,
  archivalBudgetChars: 2500,
  sharedContextBudgetChars: 2000,
  episodicBudgetChars: 1500,
  trustThreshold: 0.5,
});

let _cachedDefaults = null;
function loadDefaults() {
  if (_cachedDefaults) return _cachedDefaults;
  try {
    const here = fileURLToPath(new URL('.', import.meta.url));
    const cfgPath = join(here, '..', 'config', 'defaults.json');
    const raw = readFileSync(cfgPath, 'utf8');
    const parsed = JSON.parse(raw);
    _cachedDefaults = { ...FALLBACK_CONTEXT_DEFAULTS, ...(parsed.context || {}) };
  } catch {
    _cachedDefaults = { ...FALLBACK_CONTEXT_DEFAULTS };
  }
  return _cachedDefaults;
}

// ---------------------------------------------------------------------------
// Source-type tiebreaker (PRD §9.6: human > recovery > eval > agent)
// ---------------------------------------------------------------------------

const SOURCE_RANK = Object.freeze({
  human: 1.0,
  'recovery-engine': 0.85,
  'session-end-eval': 0.75,
  git: 0.7,
  eval: 0.65,
  task: 0.55,
  system: 0.5,
  agent: 0.3,
});

function sourceRank(s) {
  return typeof SOURCE_RANK[s] === 'number' ? SOURCE_RANK[s] : 0.5;
}

// ---------------------------------------------------------------------------
// Tokenisation + relevance helpers (cheap, no embeddings)
// ---------------------------------------------------------------------------

function tokenize(text) {
  if (!text) return [];
  return String(text)
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter(t => t.length >= 3 && t.length <= 32);
}

function keywordOverlap(a, b) {
  const A = new Set(tokenize(a));
  if (A.size === 0) return 0;
  const B = new Set(tokenize(b));
  if (B.size === 0) return 0;
  let hits = 0;
  for (const t of A) if (B.has(t)) hits++;
  const union = A.size + B.size - hits;
  return union > 0 ? hits / union : 0;
}

function pathMatchScore(candidatePaths, plannedFiles, promptPaths) {
  if (!Array.isArray(candidatePaths) || candidatePaths.length === 0) return 0;
  const targets = [...(plannedFiles || []), ...(promptPaths || [])];
  if (targets.length === 0) return 0;
  let hits = 0;
  for (const cp of candidatePaths) {
    if (typeof cp !== 'string') continue;
    const stem = cp.replace(/\*+$/, '');
    for (const t of targets) {
      if (typeof t !== 'string') continue;
      if (t === cp || t.startsWith(stem) || cp.startsWith(t)) { hits++; break; }
    }
  }
  return Math.min(1, hits / candidatePaths.length);
}

function recencyDecay(createdAt) {
  if (!createdAt) return 0.5;
  const t = Date.parse(createdAt);
  if (!Number.isFinite(t)) return 0.5;
  const days = Math.max(0, (Date.now() - t) / (24 * 60 * 60 * 1000));
  // Gentle: 1.0 fresh, ~0.5 at 60 days, ~0.3 at 180 days. Never 0.
  return 1 / (1 + days / 60);
}

// ---------------------------------------------------------------------------
// Conflict detection — keyword-anchor heuristic
// ---------------------------------------------------------------------------

const NEGATIONS = ['never', 'do not', "don't", 'avoid', 'prohibit', 'forbidden', 'must not', 'no '];

function hasNegation(text) {
  if (!text) return false;
  const lower = String(text).toLowerCase();
  return NEGATIONS.some(n => lower.includes(n));
}

/**
 * Pair-wise contradiction surfacer. Returns array of conflict descriptors.
 * For each pair of selected candidates that share substantial keyword
 * overlap (>= 0.25) AND one negates while the other does not, emit a
 * conflict. This is a heuristic — high recall, surfaces for human review;
 * never auto-resolves.
 */
function detectConflicts(selected) {
  const conflicts = [];
  for (let i = 0; i < selected.length; i++) {
    for (let j = i + 1; j < selected.length; j++) {
      const a = selected[i];
      const b = selected[j];
      const overlap = keywordOverlap(a.content, b.content);
      if (overlap < 0.25) continue;
      const aNeg = hasNegation(a.content);
      const bNeg = hasNegation(b.content);
      if (aNeg !== bNeg) {
        conflicts.push({
          a: { id: a.id, layer: a.layer, title: a.title },
          b: { id: b.id, layer: b.layer, title: b.title },
          overlap: Math.round(overlap * 1000) / 1000,
          reason: 'one negates the other on overlapping keywords',
        });
      }
    }
  }
  return conflicts;
}

// ---------------------------------------------------------------------------
// Scoring (PRD §9.6 factors)
// ---------------------------------------------------------------------------

function scoreCandidate(c, ctx) {
  if (!c) return 0;

  // Invalidated → excluded by default; if assembler is asked to surface, it
  // still gets a heavy penalty.
  if (c.invalidAt) return -1;

  const trust = typeof c.trustScore === 'number' ? c.trustScore : 0.5;
  if (trust < ctx.trustThreshold) return -1;

  let s = 0;

  // Path match (glob)
  s += pathMatchScore(c.paths, ctx.plannedFiles, ctx.promptPaths) * 1.0;

  // Keyword overlap on prompt
  s += keywordOverlap(ctx.prompt, c.content) * 0.8;
  s += keywordOverlap(ctx.prompt, c.title) * 0.4;

  // Task-type match (only context_items expose tags; rules carry category)
  if (Array.isArray(c.tags) && ctx.taskType && c.tags.includes(ctx.taskType)) s += 0.2;

  // Dependency relevance
  if (c.layer === LAYER.SHARED) s += 0.4;

  // Recency
  s += recencyDecay(c.createdAt) * 0.2;

  // Confidence
  if (typeof c.confidence === 'number') s += c.confidence * 0.1;

  // Source-type tiebreaker
  s += sourceRank(c.sourceType) * 0.05;

  // Rule priority (1-10) — small weight
  if (typeof c.priority === 'number') s += (c.priority / 10) * 0.15;

  // User pinned (e.g. active_focus)
  if (c.pinned) s += 0.5;

  // Retrieval outcome moving avg
  if (typeof c.retrievalOutcome === 'number') s += c.retrievalOutcome * 0.1;

  // Trust as multiplier (so trust still matters even with high keyword match)
  s *= 0.5 + trust * 0.5;

  // Provider-supplied score (e.g. episodic kw+glob blend) folds in
  if (typeof c.score === 'number' && c.score > 0) s += c.score * 0.3;

  return s;
}

// ---------------------------------------------------------------------------
// Section formatting
// ---------------------------------------------------------------------------

function trustLabel(score) {
  if (score >= 0.8) return 'HIGH';
  if (score >= 0.5) return 'MEDIUM';
  return 'LOW';
}

function sectionHeader(name, trust) {
  return `[${name} — Trust: ${trust}]`;
}

function renderEntry(c) {
  const titleLine = c.title ? `• ${c.title}` : '•';
  const body = c.content ? `\n  ${String(c.content).replace(/\n/g, '\n  ')}` : '';
  const meta = ` (source=${c.sourceType}, trust=${(c.trustScore ?? 0).toFixed(2)})`;
  return `${titleLine}${meta}${body}`;
}

const SECTION_LABELS = Object.freeze({
  [LAYER.CORE_BLOCKS]: 'Core Context Blocks',
  [LAYER.SHARED]: 'Upstream / Shared Context',
  [LAYER.EPISODIC]: 'Past Similar Successes',
  [LAYER.RULES]: 'Knowledge Rules',
  [LAYER.CONTEXT_ITEMS]: 'Project Memory',
});

// ---------------------------------------------------------------------------
// Budget packing
// ---------------------------------------------------------------------------

function packLayer(candidates, perLayerCap, totalRemaining) {
  const cap = Math.max(0, Math.min(perLayerCap, totalRemaining));
  if (cap <= 0) {
    return {
      selected: [],
      omitted: candidates.map(c => ({ id: c.id, layer: c.layer, reason: 'budget_exceeded' })),
      used: 0, truncated: false,
    };
  }
  const sorted = [...candidates].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const selected = [];
  const omitted = [];
  let used = 0;
  let truncated = false;
  for (const c of sorted) {
    const charCount = (c.content ? String(c.content).length : 0) + (c.title ? String(c.title).length : 0) + 32;
    if (used + charCount > cap) {
      omitted.push({ id: c.id, layer: c.layer, reason: 'budget_exceeded' });
      truncated = true;
      continue;
    }
    selected.push({ ...c, _charCount: charCount });
    used += charCount;
  }
  return { selected, omitted, used, truncated };
}

// ---------------------------------------------------------------------------
// Main API
// ---------------------------------------------------------------------------

/**
 * Assemble a context block + audit from M0-M3 stores. Pure consumer.
 *
 * Never throws. On unexpected error, returns a degraded result with
 * audit.error set; an audit row is still written so the failure is visible
 * in the audit trail.
 */
export function assembleContext(input = {}) {
  const startedAt = new Date().toISOString();
  const defaults = loadDefaults();

  const {
    project,
    prompt = '',
    taskType,
    taskId,
    taskGroup,
    dependsOn,
    plannedFiles = [],
    profile,
    repoRoot,
    mode = 'spawn',
  } = input;

  const budget = Number.isFinite(Number(input.budget))
    ? Number(input.budget)
    : (defaults.defaultBudgetChars || FALLBACK_CONTEXT_DEFAULTS.defaultBudgetChars);

  const trustThreshold = (input.trustThreshold === undefined || input.trustThreshold === null)
    ? getTrustThreshold()
    : Number(input.trustThreshold);

  const perLayerCap = {
    [LAYER.CORE_BLOCKS]: defaults.coreBudgetChars ?? FALLBACK_CONTEXT_DEFAULTS.coreBudgetChars,
    [LAYER.SHARED]: defaults.sharedContextBudgetChars ?? FALLBACK_CONTEXT_DEFAULTS.sharedContextBudgetChars,
    [LAYER.EPISODIC]: defaults.episodicBudgetChars ?? FALLBACK_CONTEXT_DEFAULTS.episodicBudgetChars,
    [LAYER.RULES]: defaults.rulesBudgetChars ?? FALLBACK_CONTEXT_DEFAULTS.rulesBudgetChars,
    [LAYER.CONTEXT_ITEMS]: defaults.archivalBudgetChars ?? FALLBACK_CONTEXT_DEFAULTS.archivalBudgetChars,
  };

  const promptPaths = extractPathsFromText(prompt || '');
  const scoreCtx = {
    prompt: prompt || '',
    plannedFiles: Array.isArray(plannedFiles) ? plannedFiles : [],
    promptPaths,
    taskType,
    trustThreshold,
  };

  // Defaults for degraded-result emit
  let promptBlock = '';
  const sections = [];
  const allSelected = [];
  const allOmitted = [];
  const perLayerChars = {};
  let conflicts = [];
  let degradedError = null;

  try {
    if (!project) {
      degradedError = 'missing project — degraded empty result';
    } else {
      // ---------------------------------------------------------------
      // Order: core blocks → shared → episodic → rules → archival items
      // ---------------------------------------------------------------
      const layerOrder = [
        { layer: LAYER.CORE_BLOCKS, fn: () => sessionBlocksProvider({ project, trustThreshold }) },
        { layer: LAYER.SHARED, fn: () => sharedContextProvider({ taskGroup, dependsOn }) },
        { layer: LAYER.EPISODIC, fn: () => episodicProvider({ project, prompt, plannedFiles, maxN: 3 }) },
        { layer: LAYER.RULES, fn: () => knowledgeRulesProvider({ prompt, paths: plannedFiles, trustThreshold }) },
        { layer: LAYER.CONTEXT_ITEMS, fn: () => contextItemsProvider({
          project, prompt, plannedFiles, scopeId: taskId, taskGroup, trustThreshold,
        }) },
      ];

      let remaining = budget;

      for (const { layer, fn } of layerOrder) {
        let raw = [];
        try {
          raw = fn() || [];
        } catch (err) {
          console.error(`[context-assembler] provider layer ${layer} failed: ${err.message}`);
          raw = [];
        }
        const retrievalCount = raw.length;

        // Score every candidate, drop sub-threshold/invalid here so audit
        // omitted reasons are accurate.
        const scored = [];
        for (const c of raw) {
          const s = scoreCandidate(c, scoreCtx);
          if (s < 0) {
            // Sub-threshold or invalidated — emit to omitted with reason
            const reason = c.invalidAt
              ? 'invalidated'
              : (typeof c.trustScore === 'number' && c.trustScore < trustThreshold
                ? 'below_threshold'
                : 'excluded');
            // Invalidated rows are not surfaced (not even in audit.omitted) —
            // providers already exclude them; this is a defensive fence.
            if (reason === 'invalidated') continue;
            allOmitted.push({ id: c.id, layer, reason });
            continue;
          }
          scored.push({ ...c, score: s });
        }

        const { selected, omitted, used, truncated } = packLayer(scored, perLayerCap[layer], remaining);
        remaining -= used;
        if (remaining < 0) remaining = 0;

        for (const o of omitted) allOmitted.push(o);
        for (const s of selected) allSelected.push(s);

        perLayerChars[layer] = used;

        if (selected.length > 0) {
          sections.push({
            name: SECTION_LABELS[layer] || `layer_${layer}`,
            layer,
            trust: trustLabel(
              selected.reduce((acc, x) => acc + (x.trustScore ?? 0), 0) / selected.length,
            ),
            budgetUsed: used,
            entries: selected.map(s => ({
              id: s.id,
              title: s.title,
              score: Math.round((s.score ?? 0) * 1000) / 1000,
              reason: s.reason,
              sourceType: s.sourceType,
              trustScore: s.trustScore,
              charCount: s._charCount,
            })),
            _selected: selected,
          });
        }

        // Telemetry — emit for every section we attempted, even empty ones,
        // so the dashboard can identify dead layers per PRD §9.5.
        if (taskId) {
          try {
            writeLayerTelemetry({
              taskId,
              layerNum: layer,
              layerName: LAYER_NAMES[layer] || `layer_${layer}`,
              charCount: used,
              wasTruncated: truncated,
              retrievalCount,
              selectedCount: selected.length,
            });
          } catch (err) {
            console.error(`[context-assembler] telemetry write failed (layer ${layer}): ${err.message}`);
          }
        }
      }

      // Conflict detection over the final selected set
      conflicts = detectConflicts(allSelected);

      // Render
      promptBlock = renderPromptBlock(sections);
    }
  } catch (err) {
    console.error(`[context-assembler] unexpected error: ${err.message}`);
    degradedError = err.message;
  }

  // ---------------------------------------------------------------------
  // Audit — always written
  // ---------------------------------------------------------------------
  const audit = {
    query: prompt || '',
    budget,
    trustThreshold,
    candidates: allSelected.length + allOmitted.length,
    selected: allSelected.map(s => ({
      id: s.id,
      layer: s.layer,
      score: Math.round((s.score ?? 0) * 1000) / 1000,
      reason: s.reason,
      sourceType: s.sourceType,
      trustScore: s.trustScore,
      char_count: s._charCount,
    })),
    omitted: allOmitted,
    conflicts,
    perLayerChars,
    generatedAt: startedAt,
    mode,
  };
  if (degradedError) audit.error = degradedError;

  if (taskId) {
    try {
      writeContextAudit({
        taskId,
        project: project || null,
        promptHash: hashOrNull(prompt),
        contextHash: hashOrNull(promptBlock),
        budget,
        selectedItems: audit.selected,
        omittedItems: audit.omitted,
        conflicts: audit.conflicts,
        trustThreshold,
        assembledPromptPreview: promptBlock.slice(0, 2000),
        perLayerChars,
      });
    } catch (err) {
      console.error(`[context-assembler] audit write failed: ${err.message}`);
    }
  }

  // Strip private _selected from output sections
  const publicSections = sections.map(s => {
    const copy = { ...s };
    delete copy._selected;
    return copy;
  });

  return { promptBlock, sections: publicSections, audit };
}

function hashOrNull(s) {
  if (!s) return null;
  try { return createHash('sha256').update(String(s)).digest('hex').slice(0, 16); } catch { return null; }
}

function renderPromptBlock(sections) {
  const lines = [];
  for (const section of sections) {
    const header = sectionHeader(section.name, section.trust);
    lines.push(header);
    for (const c of section._selected || []) {
      lines.push(renderEntry(c));
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

// ---------------------------------------------------------------------------
// Test-only handles
// ---------------------------------------------------------------------------

export const _internals = {
  loadDefaults,
  scoreCandidate,
  detectConflicts,
  packLayer,
  keywordOverlap,
  pathMatchScore,
  recencyDecay,
  sourceRank,
  hasNegation,
  SOURCE_RANK,
  FALLBACK_CONTEXT_DEFAULTS,
};
