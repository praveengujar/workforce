/**
 * Lifecycle tool handlers — diff review, approve, reject.
 * Pure functions, no Express dependency. Uses execFileSync for git safety.
 */

import { getTask, updateTask, getDb } from '../core/db.js';
import { logEvent, getTaskTimeline } from '../core/task-events.js';
import { mergeWorktree, cleanupWorktree } from '../core/worker-manager.js';
import { gitExec } from '../core/constants.js';
import { captureEpisode, isEpisodicEnabled } from '../core/episodic-memory.js';
import {
  captureFailureEpisode,
  captureDecisionsFromTask,
  captureRisksFromTask,
} from '../core/context-capture-pipeline.js';
import { captureScratchpadOnMerge } from '../core/scratchpad.js';
import { buildTraceForTask, persistTrace } from '../core/task-trace.js';

// ---------------------------------------------------------------------------
// Gate enforcement — required evidence phases before merge
// ---------------------------------------------------------------------------
const REQUIRED_GATES = ['human_decision'];

// Gates that are required only when the corresponding pipeline stage ran
const CONDITIONAL_GATES = ['qa', 'security', 'adversarial'];

/**
 * Check if required gate evidence exists in task events.
 * Returns { passed: boolean, missing: string[], waived: string[] }
 */
function validateGates(taskId, waivers = []) {
  const events = getTaskTimeline(taskId);
  const phases = new Set(events.map(e => e.phase));
  const waiverSet = new Set(waivers.map(w => w.gate));

  const missing = [];
  const waived = [];

  // Required gates must always be present (or waived)
  for (const gate of REQUIRED_GATES) {
    if (phases.has(gate)) continue;
    if (waiverSet.has(gate)) {
      waived.push(gate);
      continue;
    }
    missing.push(gate);
  }

  // Conditional gates: only required if the stage was started (has a corresponding event)
  for (const gate of CONDITIONAL_GATES) {
    const started = phases.has(`${gate}_started`) || phases.has(`${gate}_required`);
    if (!started) continue; // stage never ran — not required
    if (phases.has(gate) || phases.has(`${gate}_passed`)) continue;
    if (waiverSet.has(gate)) {
      waived.push(gate);
      continue;
    }
    missing.push(gate);
  }

  return { passed: missing.length === 0, missing, waived };
}

// ---------------------------------------------------------------------------
// Module-level project dir — set once at startup via setProjectDir()
// ---------------------------------------------------------------------------
let _projectDir = process.cwd();

export function setProjectDir(dir) {
  _projectDir = dir;
}

// ---------------------------------------------------------------------------
// getDiffHandler
// ---------------------------------------------------------------------------
export function getDiffHandler({ task_id }) {
  const task = getTask(task_id);
  if (!task) throw new Error('task not found');

  const repoRoot = _projectDir;
  const branchName = task.branch || `wf/${task.id}`;

  let diff = '';
  let files = [];
  let additions = 0;
  let deletions = 0;

  const baseBranch = task.targetBranch || 'main';
  try {
    diff = gitExec(['diff', `${baseBranch}...${branchName}`], { cwd: repoRoot });
  } catch {
    try {
      diff = gitExec(['diff', `HEAD...${branchName}`], { cwd: repoRoot });
    } catch {
      diff = '(unable to generate diff)';
    }
  }

  try {
    const stat = gitExec(['diff', '--stat', `${baseBranch}...${branchName}`], { cwd: repoRoot });
    const lines = stat.split('\n');
    for (const line of lines) {
      const fileMatch = line.match(/^\s*(.+?)\s+\|\s+(\d+)/);
      if (fileMatch) files.push(fileMatch[1].trim());
      const addMatch = line.match(/(\d+) insertion/);
      const delMatch = line.match(/(\d+) deletion/);
      if (addMatch) additions += parseInt(addMatch[1], 10);
      if (delMatch) deletions += parseInt(delMatch[1], 10);
    }
  } catch {
    // ignore stat errors
  }

  return { diff, files, additions, deletions };
}

// ---------------------------------------------------------------------------
// approveTaskHandler
// ---------------------------------------------------------------------------
export async function approveTaskHandler({ task_id, reason, waivers }) {
  const task = getTask(task_id);
  if (!task) throw new Error('task not found');
  if (task.status !== 'review') throw new Error('task is not in review status');

  // Gate enforcement — check required evidence before merge
  const parsedWaivers = Array.isArray(waivers) ? waivers : [];
  const gateResult = validateGates(task.id, parsedWaivers);

  // Log waivers as auditable events
  for (const w of parsedWaivers) {
    logEvent(task.id, 'gate_waived', `${w.gate}: ${w.reason || 'no reason given'}`);
  }

  if (!gateResult.passed) {
    const missingList = gateResult.missing.join(', ');
    return {
      ok: false,
      merged: false,
      error: `Gate enforcement: missing required evidence for [${missingList}]. Add gate events or provide waivers.`,
      missingGates: gateResult.missing,
      waivedGates: gateResult.waived,
    };
  }

  logEvent(task.id, 'approved', reason || 'Approved by user');

  // M8 — capture scratchpad findings BEFORE mergeWorktree removes the
  // worktree. Best-effort, never throws.
  try {
    captureScratchpadOnMerge(getDb(), task.id, task.worktreePath, 'merged');
  } catch (err) {
    console.error(`[lifecycle] scratchpad capture failed for ${task_id}: ${err.message}`);
  }

  await mergeWorktree(task);

  // Check if merge actually succeeded
  const freshTask = getTask(task_id);
  if (freshTask.status === 'failed' || freshTask.mergeFailed) {
    return { ok: false, merged: false, error: freshTask.error || 'Merge failed' };
  }

  // Best-effort episodic capture + M7 decision/risk capture — never fails the merge.
  setImmediate(() => {
    const merged = getTask(task_id);
    if (!merged) return;
    if (isEpisodicEnabled()) {
      try {
        captureEpisode({ task: merged, repoRoot: _projectDir });
      } catch (err) {
        console.error(`[lifecycle] episodic capture failed for ${task_id}: ${err.message}`);
      }
    }
    try { captureDecisionsFromTask(merged); } catch (err) {
      console.error(`[lifecycle] decision capture failed for ${task_id}: ${err.message}`);
    }
    try { captureRisksFromTask(merged); } catch (err) {
      console.error(`[lifecycle] risk capture failed for ${task_id}: ${err.message}`);
    }
    // M8 — sub-agent trace handoff. Builds trace from DB rows just written
    // above; safe to defer to setImmediate.
    try {
      const buf = buildTraceForTask(getDb(), task_id);
      if (buf) persistTrace(getDb(), task_id, buf);
    } catch (err) {
      console.error(`[lifecycle] task-trace persist failed for ${task_id}: ${err.message}`);
    }
  });

  return { ok: true, merged: true, waivedGates: gateResult.waived };
}

// ---------------------------------------------------------------------------
// rejectTaskHandler
// ---------------------------------------------------------------------------
export function rejectTaskHandler({ task_id, reason }) {
  const task = getTask(task_id);
  if (!task) throw new Error('task not found');
  if (task.status !== 'review') throw new Error('task is not in review status');

  updateTask(task.id, {
    status: 'rejected',
    error: reason || 'Changes rejected by user',
    completedAt: new Date().toISOString(),
  });
  logEvent(task.id, 'rejected', 'User rejected changes');

  // M8 — capture scratchpad findings BEFORE cleanupWorktree removes the file.
  // Best-effort, never throws — wrapped in try/catch so a capture failure can
  // never block rejection.
  try {
    captureScratchpadOnMerge(getDb(), task.id, task.worktreePath, 'rejected');
  } catch (err) {
    console.error(`[lifecycle] scratchpad reject-capture failed for ${task.id}: ${err.message}`);
  }

  cleanupWorktree(task.id, task.worktreePath);

  // Best-effort failure-path capture (PRD §9.7) — never fails the rejection.
  setImmediate(() => {
    const rejected = getTask(task.id);
    if (!rejected) return;
    try { captureFailureEpisode({ task: rejected, repoRoot: _projectDir }); } catch (err) {
      console.error(`[lifecycle] failure-episode capture failed for ${task.id}: ${err.message}`);
    }
    try { captureDecisionsFromTask(rejected); } catch (err) {
      console.error(`[lifecycle] decision capture failed for ${task.id}: ${err.message}`);
    }
    try { captureRisksFromTask(rejected); } catch (err) {
      console.error(`[lifecycle] risk capture failed for ${task.id}: ${err.message}`);
    }
  });

  return { ok: true };
}
