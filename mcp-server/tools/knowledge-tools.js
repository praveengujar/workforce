/**
 * Knowledge rule tool handlers — CRUD for path-scoped domain knowledge.
 */

import { createRule, listRules, getRulesForPaths, deleteRule } from '../core/knowledge-rules.js';

export function createRuleHandler({ category, name, description, paths, content, priority }) {
  const rule = createRule({ category, name, description, paths, content, priority });
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
    })),
  };
}

export function deleteRuleHandler({ id }) {
  if (!id) throw new Error('id is required');
  const deleted = deleteRule(id);
  return { ok: true, deleted: { id: deleted.id, name: deleted.name, category: deleted.category } };
}
