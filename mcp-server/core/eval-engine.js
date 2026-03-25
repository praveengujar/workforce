/**
 * Eval Engine — self-improving feedback loop for workforce.
 *
 * Every task failure produces a structured eval entry. Processed evals
 * can create knowledge rules (preventive) or append to feedback.jsonl (quick-ref).
 * The three-output model: diagnostic (eval log) + preventive (rule) + quick-ref (memory).
 */

import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDb, stmt } from './db.js';
import { createRule } from './knowledge-rules.js';
import { DATA_DIR } from './constants.js';

// ---------------------------------------------------------------------------
// Valid enums
// ---------------------------------------------------------------------------
const VALID_CATEGORIES = [
  'pattern_violation', 'infrastructure', 'prompt_quality',
  'scope_creep', 'rate_limit', 'environment', 'zero_work',
  'merge_failure', 'dependency_failure', 'custom',
];

const VALID_SEVERITIES = ['low', 'medium', 'high', 'critical'];

const VALID_DETECTIONS = [
  'auto_recovery', 'session_end_hook', 'manual_review', 'qa_failure',
];

const VALID_ACTIONS = ['rule_created', 'rule_updated', 'memory_updated', 'dismissed'];

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

/**
 * Create an eval log entry.
 */
export function createEval({
  taskId, category, ruleViolated, whatHappened, rootCause,
  correctApproach, preventiveUpdate, detection, severity,
}) {
  if (!category) throw new Error(`category is required. Valid: ${VALID_CATEGORIES.join(', ')}`);
  if (!whatHappened) throw new Error('whatHappened is required');
  if (!detection) throw new Error(`detection is required. Valid: ${VALID_DETECTIONS.join(', ')}`);

  const id = randomUUID().slice(0, 8);
  const now = new Date().toISOString();
  const sev = severity && VALID_SEVERITIES.includes(severity) ? severity : 'medium';

  getDb().prepare(
    `INSERT INTO eval_logs (id, taskId, category, ruleViolated, whatHappened, rootCause,
     correctApproach, preventiveUpdate, detection, severity, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id, taskId ?? null, category, ruleViolated ?? null, whatHappened,
    rootCause ?? null, correctApproach ?? null, preventiveUpdate ?? null,
    detection, sev, now,
  );

  return getEvalById(id);
}

/**
 * Get a single eval by ID.
 */
export function getEvalById(id) {
  return stmt('SELECT * FROM eval_logs WHERE id = ?').get(id);
}

/**
 * List evals with optional filters.
 */
export function listEvals({ taskId, category, unprocessedOnly, limit } = {}) {
  let sql = 'SELECT * FROM eval_logs WHERE 1=1';
  const params = [];

  if (taskId) { sql += ' AND taskId = ?'; params.push(taskId); }
  if (category) { sql += ' AND category = ?'; params.push(category); }
  if (unprocessedOnly) { sql += ' AND processedAt IS NULL'; }

  sql += ' ORDER BY createdAt DESC';
  if (limit) { sql += ' LIMIT ?'; params.push(limit); }

  return getDb().prepare(sql).all(...params);
}

/**
 * Get aggregate eval statistics.
 */
export function getEvalStats() {
  const total = stmt('SELECT COUNT(*) as count FROM eval_logs').get().count;
  const unprocessed = stmt('SELECT COUNT(*) as count FROM eval_logs WHERE processedAt IS NULL').get().count;

  const byCategory = {};
  const catRows = getDb().prepare(
    'SELECT category, COUNT(*) as count FROM eval_logs GROUP BY category ORDER BY count DESC',
  ).all();
  for (const row of catRows) byCategory[row.category] = row.count;

  const bySeverity = {};
  const sevRows = getDb().prepare(
    'SELECT severity, COUNT(*) as count FROM eval_logs GROUP BY severity ORDER BY count DESC',
  ).all();
  for (const row of sevRows) bySeverity[row.severity] = row.count;

  const byDetection = {};
  const detRows = getDb().prepare(
    'SELECT detection, COUNT(*) as count FROM eval_logs GROUP BY detection ORDER BY count DESC',
  ).all();
  for (const row of detRows) byDetection[row.detection] = row.count;

  return { total, unprocessed, byCategory, bySeverity, byDetection };
}

/**
 * Process an eval — apply the preventive action.
 *
 * Actions:
 * - rule_created: Parse preventiveUpdate to create a knowledge rule
 * - rule_updated: Same as rule_created (upsert behavior)
 * - memory_updated: Append to feedback.jsonl
 * - dismissed: Mark as processed with no action
 */
export function processEval(id, action) {
  if (!action || !VALID_ACTIONS.includes(action)) {
    throw new Error(`Invalid action "${action}". Valid: ${VALID_ACTIONS.join(', ')}`);
  }

  const evalEntry = getEvalById(id);
  if (!evalEntry) throw new Error(`Eval "${id}" not found`);
  if (evalEntry.processedAt) throw new Error(`Eval "${id}" already processed (${evalEntry.processedAction})`);

  const now = new Date().toISOString();

  if (action === 'rule_created' || action === 'rule_updated') {
    // Create a knowledge rule — always, not just when preventiveUpdate exists
    const ruleContent = evalEntry.correctApproach || evalEntry.whatHappened;
    if (!ruleContent && !evalEntry.preventiveUpdate) {
      throw new Error(`Cannot create rule from eval "${id}": no correctApproach, whatHappened, or preventiveUpdate`);
    }

    if (evalEntry.preventiveUpdate) {
      try {
        const update = JSON.parse(evalEntry.preventiveUpdate);
        createRule({
          category: update.category || 'patterns',
          name: update.name || `eval-${id}-fix`,
          description: update.description || `Auto-generated from eval ${id}`,
          paths: update.paths || ['**/*'],
          content: update.content || ruleContent,
          priority: update.priority || 5,
        });
      } catch {
        // preventiveUpdate isn't valid JSON — fall through to generic rule
        createRule({
          category: 'patterns',
          name: `eval-${id}-fix`,
          description: `Auto-generated from eval ${id}: ${evalEntry.category}`,
          paths: ['**/*'],
          content: ruleContent,
          priority: 4,
        });
      }
    } else {
      // No preventiveUpdate — create generic rule from correctApproach/whatHappened
      createRule({
        category: 'patterns',
        name: `eval-${id}-fix`,
        description: `Auto-generated from eval ${id}: ${evalEntry.category}`,
        paths: ['**/*'],
        content: ruleContent,
        priority: 4,
      });
    }
  } else if (action === 'memory_updated') {
    // Append to feedback.jsonl
    try {
      const feedbackPath = join(DATA_DIR, 'feedback.jsonl');
      const entry = {
        type: 'eval',
        category: evalEntry.category,
        prompt: evalEntry.whatHappened,
        correction: evalEntry.correctApproach || evalEntry.rootCause,
        timestamp: now,
      };
      appendFileSync(feedbackPath, JSON.stringify(entry) + '\n', 'utf8');
    } catch { /* ignore feedback write errors */ }
  }

  // Mark as processed
  getDb().prepare(
    'UPDATE eval_logs SET processedAt = ?, processedAction = ? WHERE id = ?',
  ).run(now, action, id);

  return getEvalById(id);
}

export { VALID_CATEGORIES as EVAL_CATEGORIES, VALID_SEVERITIES, VALID_DETECTIONS, VALID_ACTIONS };
