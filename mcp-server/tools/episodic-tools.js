/**
 * Episodic memory tool handlers — Context Fabric M1.
 *
 * Exposes capture + recall as MCP tools so external orchestration (and the
 * lifecycle merge hook) can drive them. Capture is idempotent on
 * (project, task_id); recall is read-only and ranks episodes by keyword
 * overlap + glob match against planned files.
 */

import { getTask } from '../core/db.js';
import {
  captureEpisode,
  recallEpisodes,
  isEpisodicEnabled,
} from '../core/episodic-memory.js';

export async function captureEpisodeHandler({ task_id, repo_root } = {}) {
  if (!isEpisodicEnabled()) {
    return { ok: false, captured: false, reason: 'WORKFORCE_EPISODIC_ENABLED=false' };
  }
  if (!task_id) throw new Error('task_id is required');
  const task = getTask(task_id);
  if (!task) throw new Error(`task not found: ${task_id}`);

  const row = captureEpisode({ task, repoRoot: repo_root });
  if (!row) {
    return { ok: false, captured: false, reason: 'capture failed (see stderr)' };
  }
  return {
    ok: true,
    captured: true,
    episode: {
      id: row.id,
      project: row.project,
      task_id: row.task_id,
      glob_signature: row.glob_signature,
      trust_score: row.trust_score,
      outcome: row.outcome,
    },
  };
}

export async function recallEpisodesHandler({ project, prompt, planned_files, max_n } = {}) {
  if (!isEpisodicEnabled()) {
    return { ok: true, episodes: [], reason: 'WORKFORCE_EPISODIC_ENABLED=false' };
  }
  if (!project) throw new Error('project is required');
  if (!prompt) throw new Error('prompt is required');

  const episodes = recallEpisodes({
    project,
    prompt,
    plannedFiles: Array.isArray(planned_files) ? planned_files : [],
    maxN: typeof max_n === 'number' ? max_n : 3,
  });

  return {
    ok: true,
    count: episodes.length,
    episodes: episodes.map(e => ({
      id: e.id,
      task_id: e.task_id,
      task_type: e.task_type,
      outcome: e.outcome,
      glob_signature: e.glob_signature,
      prompt_summary: e.prompt_summary,
      approach_summary: e.approach_summary,
      review_score: e.review_score,
      created_at: e.created_at,
      score: e._score,
    })),
  };
}
