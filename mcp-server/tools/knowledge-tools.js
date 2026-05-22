/**
 * Knowledge rule tool handlers — CRUD for path-scoped domain knowledge.
 */

import { createRule, listRules, getRulesForPaths, deleteRule } from '../core/knowledge-rules.js';
import { getMode as getAutonomyMode, getAutonomyConfig } from '../core/autonomy-controller.js';

/**
 * Block rule promotion (create + delete) when autonomy is in a live mode
 * (`auto` or `park`) and lockdown is enabled. `proposed_rules` writes via
 * other code paths (cio-curator) are unaffected. Shadow mode does not lock.
 */
function ensureNotLockedDown(action) {
  const cfg = getAutonomyConfig();
  if (cfg.knowledgeLockdown === false) return;
  const mode = getAutonomyMode(process.cwd());
  if (mode === 'auto' || mode === 'park') {
    throw new Error(
      `knowledge lockdown: ${action} blocked while autonomy mode=${mode}. ` +
      `Use proposed_rules to draft for human review, or stop autonomy first.`,
    );
  }
}

// See session-tools.js — `WORKFORCE_AGENT_TASK_ID` distinguishes spawned-agent
// writes from human writes. Agent rules are clamped at trust=0.4 inside
// knowledge-rules.js, which keeps them below the default retrieval threshold.
function getCallerProvenance() {
  const agentTaskId = process.env.WORKFORCE_AGENT_TASK_ID;
  if (agentTaskId) {
    return { sourceType: 'agent', authoredBy: `agent:${agentTaskId}` };
  }
  return { sourceType: 'human', authoredBy: 'user' };
}

export function createRuleHandler({ category, name, description, paths, content, priority }) {
  ensureNotLockedDown('create_rule');
  const provenance = getCallerProvenance();
  const rule = createRule({
    category, name, description, paths, content, priority,
    sourceType: provenance.sourceType,
    authoredBy: provenance.authoredBy,
  });
  return { ok: true, rule };
}

export function listRulesHandler({ category }) {
  const rules = listRules(category);
  return {
    count: rules.length,
    rules: rules.map(r => ({
      id: r.id,
      category: r.category,
      name: r.name,
      description: r.description,
      paths: JSON.parse(r.paths),
      priority: r.priority,
      sourceType: r.source_type,
      authoredBy: r.authored_by,
      trustScore: r.trust_score,
      contentPreview: r.content.length > 120 ? r.content.slice(0, 120) + '...' : r.content,
      updatedAt: r.updatedAt,
    })),
  };
}

export function getRulesForPathHandler({ paths }) {
  if (!paths || paths.length === 0) throw new Error('paths must be a non-empty array of file paths');

  const rules = getRulesForPaths(paths);
  return {
    queriedPaths: paths,
    matchedRules: rules.length,
    rules: rules.map(r => ({
      id: r.id,
      category: r.category,
      name: r.name,
      description: r.description,
      paths: JSON.parse(r.paths),
      content: r.content,
      priority: r.priority,
      sourceType: r.source_type,
      authoredBy: r.authored_by,
      trustScore: r.trust_score,
    })),
  };
}

export function deleteRuleHandler({ id }) {
  ensureNotLockedDown('delete_rule');
  if (!id) throw new Error('id is required');
  const deleted = deleteRule(id);
  return { ok: true, deleted: { id: deleted.id, name: deleted.name, category: deleted.category } };
}
