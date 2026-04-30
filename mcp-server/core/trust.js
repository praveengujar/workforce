/**
 * Trust Scoring — Context Fabric Milestone 2.
 *
 * Per PRD §9.1: numeric trust scores by source, threshold-based retrieval
 * filtering, and a hard cap on agent-authored writes to defend against
 * memory poisoning (MINJA / MemoryGraft / InjecMEM).
 *
 * No new npm deps. ESM. Logs to stderr.
 */

// Default trust score per source (PRD §9.1 — canonical table).
export const DEFAULT_TRUST_BY_SOURCE = Object.freeze({
  human: 1.0,
  'recovery-engine': 0.8,
  'session-end-eval': 0.7,
  git: 0.7,
  eval: 0.6,
  task: 0.5,
  agent: 0.4,
  system: 0.5,
});

// Trust ceilings per source. Agent writes can never exceed 0.4 — this is the
// memory-poisoning defense; even if a spawned agent claims trust=1.0, the
// cap forces the row below the default retrieval threshold.
export const TRUST_CEILING_BY_SOURCE = Object.freeze({
  agent: 0.4,
});

const DEFAULT_FALLBACK = 0.5;
const DEFAULT_THRESHOLD = 0.5;

/**
 * Get the default trust score for a source type. Unknown sources fall back
 * to 0.5 (treated like `system`).
 */
export function getDefaultTrust(sourceType) {
  if (!sourceType) return DEFAULT_FALLBACK;
  const v = DEFAULT_TRUST_BY_SOURCE[sourceType];
  return typeof v === 'number' ? v : DEFAULT_FALLBACK;
}

/**
 * Read the runtime trust threshold from the env. Default 0.5.
 * Invalid/non-finite values fall back to 0.5.
 */
export function getTrustThreshold() {
  const raw = process.env.WORKFORCE_CONTEXT_TRUST_THRESHOLD;
  if (raw === undefined || raw === null || raw === '') return DEFAULT_THRESHOLD;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_THRESHOLD;
  return n;
}

/**
 * Clamp a requested trust score for a source. Values are bounded to [0,1]
 * and to the per-source ceiling (e.g. agent <= 0.4). If `requested` is
 * undefined/null, returns the source default.
 */
export function clampTrustForSource(sourceType, requested) {
  const ceiling = TRUST_CEILING_BY_SOURCE[sourceType];
  let score = (requested === undefined || requested === null || !Number.isFinite(Number(requested)))
    ? getDefaultTrust(sourceType)
    : Number(requested);

  if (score < 0) score = 0;
  if (score > 1) score = 1;
  if (typeof ceiling === 'number' && score > ceiling) score = ceiling;
  return score;
}
