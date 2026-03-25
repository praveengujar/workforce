/**
 * Eval tool handlers — create, list, and process eval log entries.
 */

import { createEval, listEvals, getEvalStats, processEval } from '../core/eval-engine.js';

export function createEvalHandler({
  task_id, category, rule_violated, what_happened, root_cause,
  correct_approach, preventive_update, detection, severity,
}) {
  const entry = createEval({
    taskId: task_id,
    category,
    ruleViolated: rule_violated,
    whatHappened: what_happened,
    rootCause: root_cause,
    correctApproach: correct_approach,
    preventiveUpdate: preventive_update,
    detection,
    severity,
  });

  return { ok: true, eval: entry };
}

export function listEvalsHandler({ task_id, category, unprocessed_only, limit }) {
  const evals = listEvals({
    taskId: task_id,
    category,
    unprocessedOnly: unprocessed_only,
    limit: limit || 50,
  });
  const stats = getEvalStats();

  return {
    count: evals.length,
    stats,
    evals: evals.map(e => ({
      id: e.id,
      taskId: e.taskId,
      category: e.category,
      severity: e.severity,
      detection: e.detection,
      whatHappened: e.whatHappened,
      rootCause: e.rootCause,
      processed: !!e.processedAt,
      processedAction: e.processedAction,
      createdAt: e.createdAt,
    })),
  };
}

export function processEvalHandler({ id, action }) {
  if (!id) throw new Error('id is required');
  if (!action) throw new Error('action is required (rule_created, rule_updated, memory_updated, dismissed)');

  const result = processEval(id, action);
  return { ok: true, eval: result };
}
