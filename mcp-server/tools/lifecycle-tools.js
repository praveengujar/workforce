/**
 * Lifecycle tool handlers — diff review, approve, reject.
 * Pure functions, no Express dependency. Uses execFileSync for git safety.
 */

import { execFileSync } from 'node:child_process';
import { getTask, updateTask } from '../core/db.js';
import { logEvent } from '../core/task-events.js';
import { mergeWorktree, cleanupWorktree } from '../core/worker-manager.js';

// ---------------------------------------------------------------------------
// Module-level project dir — set once at startup via setProjectDir()
// ---------------------------------------------------------------------------
let _projectDir = process.cwd();

export function setProjectDir(dir) {
  _projectDir = dir;
}

function gitExec(args, options = {}) {
  return execFileSync('git', args, { stdio: 'pipe', ...options }).toString().trim();
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
export async function approveTaskHandler({ task_id, reason }) {
  const task = getTask(task_id);
  if (!task) throw new Error('task not found');
  if (task.status !== 'review') throw new Error('task is not in review status');

  if (reason) {
    logEvent(task.id, 'approval_reason', reason);
  }

  await mergeWorktree(task);

  // Check if merge actually succeeded
  const freshTask = getTask(task_id);
  if (freshTask.status === 'failed' || freshTask.mergeFailed) {
    return { ok: false, merged: false, error: freshTask.error || 'Merge failed' };
  }
  return { ok: true, merged: true };
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

  cleanupWorktree(task.id, task.worktreePath);
  return { ok: true };
}
