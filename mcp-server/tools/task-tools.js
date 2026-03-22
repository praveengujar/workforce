/**
 * Task tool handlers — pure functions that return plain objects or throw.
 * No Express dependency. Each mirrors an original API route from server/index.js.
 */

import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  getAllTasks, getTask, createTask as dbCreateTask, updateTask,
  getRunningTasks, releaseTaskClaim, removeWorker,
  deleteTask, getCostForPeriod,
} from '../core/db.js';
import { detectCycles } from '../core/dependency-resolver.js';
import { logEvent, getTaskTimeline } from '../core/task-events.js';
import { cancelTask as cancelTaskToken } from '../core/project-state.js';
import { promotePending, cleanupWorktree } from '../core/worker-manager.js';
import { isTmuxAvailable, hasSession, sendKeys, capturePane } from '../core/tmux.js';
import { estimateTaskCost } from '../core/task-cost.js';
import { evaluateTaskCost } from './cost-approval.js';
import { DATA_DIR, ensureDir } from '../core/constants.js';

// ---------------------------------------------------------------------------
// createTaskHandler
// ---------------------------------------------------------------------------
export async function createTaskHandler({ prompt, project, autoMerge, parent_id, depends_on, group, phase }) {
  if (!prompt) throw new Error('prompt is required');

  // Validate depends_on references exist
  if (depends_on && Array.isArray(depends_on)) {
    for (const depId of depends_on) {
      const dep = getTask(depId);
      if (!dep) throw new Error(`Dependency task ${depId} not found`);
    }
  }

  const id = randomUUID();
  let task = dbCreateTask({ id, prompt, project });

  // Set optional fields that createTask doesn't handle directly
  const extras = {};
  if (autoMerge) extras.autoMerge = autoMerge ? 1 : 0;
  if (parent_id) extras.parentId = parent_id;
  if (depends_on && depends_on.length > 0) extras.dependsOn = JSON.stringify(depends_on);
  if (group) extras.taskGroup = group;
  if (phase != null) extras.phase = phase;
  // Record current branch as merge target
  try {
    const currentBranch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { stdio: 'pipe' }).toString().trim();
    extras.targetBranch = currentBranch;
  } catch { /* ignore — targetBranch stays null */ }
  if (Object.keys(extras).length > 0) {
    task = updateTask(id, extras);
  }

  // Cycle detection after task is created with deps
  if (depends_on && depends_on.length > 0) {
    try {
      const allTasks = getAllTasks();
      const cycle = detectCycles(allTasks);
      if (cycle) {
        // Roll back: delete the task we just created
        deleteTask(id);
        throw new Error(`Dependency cycle detected: ${cycle.map(c => c.slice(0, 8)).join(' -> ')}`);
      }
    } catch (err) {
      if (err.message.includes('cycle detected')) throw err;
      // Non-fatal cycle check error — continue
    }
  }

  // Enforce cost policy
  try {
    const estimate = estimateTaskCost(prompt);
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();
    const dailySpend = getCostForPeriod('global', startOfToday, endOfDay);
    const evaluation = evaluateTaskCost(estimate.totalCost, dailySpend);
    if (evaluation.decision === 'rejected') {
      deleteTask(id);
      throw new Error(`Cost policy rejected: ${evaluation.reason}`);
    }
  } catch (err) {
    if (err.message.includes('Cost policy rejected')) throw err;
    // Non-fatal cost policy error — continue
  }

  logEvent(id, 'task_created');

  // Attempt to start immediately if capacity is available
  try {
    await promotePending();
  } catch {
    // task stays pending -- that's fine
  }

  return task;
}

// ---------------------------------------------------------------------------
// listTasksHandler
// ---------------------------------------------------------------------------
export function listTasksHandler({ status_filter, include_archived } = {}) {
  const includeArchived = !!include_archived;
  let tasks = getAllTasks(includeArchived);

  if (status_filter) {
    tasks = tasks.filter(t => t.status === status_filter);
  }

  return tasks;
}

// ---------------------------------------------------------------------------
// getTaskHandler
// ---------------------------------------------------------------------------
export function getTaskHandler({ task_id }) {
  const task = getTask(task_id);
  if (!task) throw new Error('task not found');
  return task;
}

// ---------------------------------------------------------------------------
// cancelTaskHandler
// ---------------------------------------------------------------------------
export async function cancelTaskHandler({ task_id }) {
  const task = getTask(task_id);
  if (!task) throw new Error('task not found');

  // Kill process if running
  if (task.pid) {
    try {
      process.kill(task.pid, 'SIGTERM');
    } catch {
      // Process may already be dead
    }
  }

  updateTask(task.id, {
    status: 'failed',
    error: 'Cancelled by user',
    completedAt: new Date().toISOString(),
  });
  logEvent(task.id, 'cancelled', 'User-initiated cancellation');

  // Cleanup worktree
  if (task.worktreePath) {
    cleanupWorktree(task.id, task.worktreePath);
  }

  // Cancel token
  cancelTaskToken(task.id);

  // Release claim & worker
  releaseTaskClaim(task.id);
  removeWorker(task.id);

  return { ok: true };
}

// ---------------------------------------------------------------------------
// retryTaskHandler
// ---------------------------------------------------------------------------
export async function retryTaskHandler({ task_id }) {
  const task = getTask(task_id);
  if (!task) throw new Error('task not found');

  const updated = updateTask(task.id, {
    status: 'pending',
    error: null,
    output: null,
    pid: null,
    sessionId: null,
    startedAt: null,
    completedAt: null,
    exitCode: null,
    merged: 0,
    mergeFailed: 0,
    retryCount: (task.retryCount || 0) + 1,
  });

  logEvent(task.id, 'retry', `retry #${updated.retryCount}`);

  try {
    await promotePending();
  } catch {
    // stays pending
  }

  return updated;
}

// ---------------------------------------------------------------------------
// archiveTaskHandler
// ---------------------------------------------------------------------------
export function archiveTaskHandler({ task_id }) {
  const task = getTask(task_id);
  if (!task) throw new Error('task not found');

  updateTask(task.id, {
    status: 'archived',
    archivedAt: new Date().toISOString(),
  });
  logEvent(task.id, 'archived', 'User-initiated archive');

  return { ok: true };
}

// ---------------------------------------------------------------------------
// taskEventsHandler
// ---------------------------------------------------------------------------
export function taskEventsHandler({ task_id }) {
  return getTaskTimeline(task_id);
}

// ---------------------------------------------------------------------------
// taskOutputHandler
// ---------------------------------------------------------------------------
export function taskOutputHandler({ task_id }) {
  const task = getTask(task_id);
  if (!task) throw new Error('task not found');

  let output = '';

  // Try tmux first if session exists and is alive
  if (isTmuxAvailable() && task.tmuxSession && hasSession(task.tmuxSession)) {
    output = capturePane(task.tmuxSession);
    return { output, status: task.status };
  }

  // Fallback: read log file
  const logPath = join(DATA_DIR, `${task.id}.log`);
  if (existsSync(logPath)) {
    try {
      const content = readFileSync(logPath, 'utf8');
      // Return last 4000 chars to keep output manageable
      output = content.length > 4000 ? content.slice(-4000) : content;
    } catch {
      // ignore read errors
    }
  }

  return { output, status: task.status };
}

// ---------------------------------------------------------------------------
// replyToTaskHandler
// ---------------------------------------------------------------------------
export function replyToTaskHandler({ task_id, message }) {
  const task = getTask(task_id);
  if (!task) throw new Error('task not found');
  if (task.status !== 'running') throw new Error('task is not running');
  if (!message) throw new Error('message is required');

  // Use tmux sendKeys if available and task has a tmux session
  if (isTmuxAvailable() && task.tmuxSession && hasSession(task.tmuxSession)) {
    sendKeys(task.tmuxSession, message);
    logEvent(task.id, 'reply_sent', `via tmux: ${message}`);
    return { ok: true, method: 'tmux' };
  }

  // Fallback: write reply file
  ensureDir(DATA_DIR);
  const replyPath = join(DATA_DIR, `${task.id}.reply`);
  writeFileSync(replyPath, message, 'utf8');
  logEvent(task.id, 'reply_sent', message);
  return { ok: true, method: 'file' };
}

// ---------------------------------------------------------------------------
// pauseTaskHandler
// ---------------------------------------------------------------------------
export function pauseTaskHandler({ task_id }) {
  const task = getTask(task_id);
  if (!task) throw new Error('task not found');
  if (task.status !== 'running') throw new Error('task is not running');

  if (!isTmuxAvailable() || !task.tmuxSession) {
    throw new Error('pause requires tmux sessions');
  }

  updateTask(task.id, { status: 'paused' });
  logEvent(task.id, 'paused', 'User paused task');

  return { ok: true };
}

// ---------------------------------------------------------------------------
// resumeTaskHandler
// ---------------------------------------------------------------------------
export function resumeTaskHandler({ task_id }) {
  const task = getTask(task_id);
  if (!task) throw new Error('task not found');
  if (task.status !== 'paused') throw new Error('task is not paused');

  if (!task.tmuxSession || !hasSession(task.tmuxSession)) {
    throw new Error('tmux session no longer exists');
  }

  updateTask(task.id, { status: 'running' });
  logEvent(task.id, 'resumed', 'User resumed task');

  return { ok: true };
}

// ---------------------------------------------------------------------------
// analyzePromptHandler
// ---------------------------------------------------------------------------
export function analyzePromptHandler({ prompt }) {
  if (!prompt) throw new Error('prompt is required');

  const wordCount = prompt.split(/\s+/).length;
  const suggestions = [];
  let admitted = true;
  let reason = 'Task looks good';

  // Word count heuristics
  if (wordCount < 3) {
    admitted = false;
    reason = 'Prompt is too short -- provide more detail';
    suggestions.push('Add specifics about what files, functions, or behavior to change');
  }

  if (wordCount > 500) {
    admitted = false;
    reason = 'Prompt is too long -- consider decomposing into subtasks';
    suggestions.push('Use the decompose endpoint to break this into smaller tasks');
  }

  // Complexity heuristics
  const complexPatterns = [
    /refactor.*entire/i,
    /rewrite.*from scratch/i,
    /migrate.*all/i,
    /redesign/i,
  ];
  const isOverlyComplex = complexPatterns.some(p => p.test(prompt));
  if (isOverlyComplex) {
    admitted = false;
    reason = 'Task appears too broad for a single agent run';
    suggestions.push('Break into focused sub-tasks targeting specific files or modules');
  }

  // Vagueness heuristics
  const vaguePatterns = [/make it better/i, /fix everything/i, /improve the code/i, /clean up/i];
  const isVague = vaguePatterns.some(p => p.test(prompt));
  if (isVague) {
    suggestions.push('Be more specific about what needs to change and why');
    if (admitted) {
      reason = 'Task admitted but could benefit from more specificity';
    }
  }

  const estimate = estimateTaskCost(prompt);

  return {
    admitted,
    reason,
    suggestions,
    wordCount,
    tier: estimate.tier,
    estimatedCost: estimate.totalCost,
  };
}
