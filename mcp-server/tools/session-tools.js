/**
 * Session context tool handlers — cross-session continuity.
 */

import {
  setSessionContext, getSessionContext, getAllSessionContext,
  getActiveFocus, clearSessionContext, getSessionSummary,
} from '../core/session-context.js';

// Identify whether the caller is a spawned agent (taskId) or the human user.
// `WORKFORCE_AGENT_TASK_ID` is exported into the tmux env block at task spawn
// (see core/worker-manager.js). When present, writes are tagged source=agent
// and trust is hard-capped at 0.4 inside session-context.js.
function getCallerProvenance() {
  const agentTaskId = process.env.WORKFORCE_AGENT_TASK_ID;
  if (agentTaskId) {
    return { sourceType: 'agent', authoredBy: `agent:${agentTaskId}` };
  }
  return { sourceType: 'human', authoredBy: 'user' };
}

export function sessionContextHandler({ project, key, value, action }) {
  if (!action) throw new Error('action is required (get, set, list, clear)');
  if (!project) throw new Error('project is required');

  switch (action) {
    case 'set': {
      if (!key) throw new Error('key is required for set');
      if (value === undefined) throw new Error('value is required for set');
      const provenance = getCallerProvenance();
      setSessionContext(project, key, value, provenance);
      return { ok: true, project, key, sourceType: provenance.sourceType, authoredBy: provenance.authoredBy };
    }

    case 'get': {
      if (!key) throw new Error('key is required for get');
      const entry = getSessionContext(project, key);
      if (!entry) throw new Error(`Key "${key}" not found for project "${project}"`);
      return entry;
    }

    case 'list': {
      const entries = getAllSessionContext(project);
      return {
        project,
        count: entries.length,
        entries: entries.map(e => ({
          key: e.key,
          value: e.value,
          updatedAt: e.updatedAt,
          sourceType: e.source_type,
          authoredBy: e.authored_by,
          trustScore: e.trust_score,
        })),
      };
    }

    case 'clear':
      clearSessionContext(project, key);
      return { ok: true, project, cleared: key || 'all' };

    default:
      throw new Error(`Unknown action "${action}". Valid: get, set, list, clear`);
  }
}

export function activeFocusHandler({ project }) {
  if (!project) throw new Error('project is required');

  const focus = getActiveFocus(project);
  const summary = getSessionSummary();

  return {
    project,
    activeFocus: focus,
    allContext: summary,
  };
}
