import { execFileSync } from 'node:child_process';
import { getAllTasks, updateTask } from './db.js';
import { logEvent } from './task-events.js';
import { createEval } from './eval-engine.js';

const SCAN_INTERVAL_MS = 30_000;
const ZOMBIE_THRESHOLD_MS = 3 * 60 * 1000;
const RETRY_BACKOFF_MS = 60_000;
const MAX_RETRIES_DEFAULT = 2;

let _projectDir = process.cwd();

export function setProjectDir(dir) {
  _projectDir = dir;
}

function isPidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function branchMergedInGit(branchName) {
  try {
    const out = execFileSync('git', ['log', '--all', '--oneline', '--merges', `--grep=${branchName}`],
      { cwd: _projectDir, encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] });
    if (out.trim().length > 0) return true;
  } catch { /* fall through */ }

  try {
    execFileSync('git', ['merge-base', '--is-ancestor', branchName, 'HEAD'],
      { cwd: _projectDir, timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] });
    return true;
  } catch { return false; }
}

function branchExistsInGit(branchName) {
  try {
    const out = execFileSync('git', ['branch', '-a', '--list', `*${branchName}*`],
      { cwd: _projectDir, encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] });
    return out.trim().length > 0;
  } catch { return false; }
}

function rule0aZombieRetry(task) {
  if (task.status !== 'running') return false;
  // Task has evidence of a live session — not a zombie
  if (task.sessionId || task.tmuxSession || (task.pid && isPidAlive(task.pid))) return false;
  const startedAt = task.startedAt ? new Date(task.startedAt).getTime() : 0;
  if (Date.now() - startedAt < ZOMBIE_THRESHOLD_MS) return false;
  updateTask(task.id, { status: 'failed', error: 'Zombie retry: running with no session for >3 min', completedAt: new Date().toISOString() });
  logEvent(task.id, 'failed', 'Rule 0a: zombie retry detected');
  try { createEval({ taskId: task.id, category: 'infrastructure', whatHappened: 'Zombie process: running with no active session for >3 min', detection: 'auto_recovery', severity: 'medium' }); } catch { /* ignore */ }
  return true;
}

function rule0bStuckMerge(task) {
  if (!task.mergeFailed || task.status === 'done' || task.status === 'failed') return false;
  const branch = task.branch || '';
  if (branch && branchExistsInGit(branch) && branchMergedInGit(branch)) {
    updateTask(task.id, { status: 'done', merged: 1, mergeFailed: 0, completedAt: new Date().toISOString() });
    logEvent(task.id, 'completed', 'Rule 0b: merge evidence found in git');
    return true;
  }
  updateTask(task.id, { status: 'failed', error: 'Stuck merge: no git evidence of success', completedAt: new Date().toISOString() });
  logEvent(task.id, 'failed', 'Rule 0b: stuck merge with no merge evidence');
  return true;
}

function rule0cWriteRaceVictim(task) {
  if (task.status !== 'done' || task.merged) return false;
  const branch = task.branch || '';
  if (!branch) return false;
  if (branchMergedInGit(branch)) {
    updateTask(task.id, { merged: 1 });
    logEvent(task.id, 'merge_completed', 'Rule 0c: write-race victim — branch was already merged');
    return true;
  }
  return false;
}

// Rule 0d: review-already-merged — task is in `review` but its branch is already
// merged into the target. Happens when CEO/CTO merged the PR through GitHub or
// the user ran `git merge` manually instead of going through approveTaskHandler.
// Auto-resolve to `done` so the task doesn't rot waiting for human approval.
function rule0dReviewAlreadyMerged(task) {
  if (task.status !== 'review') return false;
  const branch = task.branch || '';
  if (!branch) return false;
  if (!branchMergedInGit(branch)) return false;
  updateTask(task.id, { status: 'done', merged: 1, completedAt: new Date().toISOString() });
  logEvent(task.id, 'completed', 'Rule 0d: branch already merged into target — auto-resolved from review');
  return true;
}

function rule1GhostRunner(task) {
  if (task.status !== 'running' || !task.pid) return false;
  if (!isPidAlive(task.pid)) {
    updateTask(task.id, { status: 'failed', error: `Ghost runner: PID ${task.pid} dead`, completedAt: new Date().toISOString() });
    logEvent(task.id, 'failed', `Rule 1: ghost runner — PID ${task.pid} dead`);
    try { createEval({ taskId: task.id, category: 'infrastructure', whatHappened: `Ghost runner: PID ${task.pid} died unexpectedly`, detection: 'auto_recovery', severity: 'medium' }); } catch { /* ignore */ }
    return true;
  }
  return false;
}

function rules2and3BinaryOrHook(task) {
  if (task.status !== 'failed') return false;
  const err = (task.error || '').toLowerCase();
  const isBinaryMissing = err.includes('enoent') || (err.includes('claude') && err.includes('not found'));
  const isHookBlocked = err.includes('hook') && err.includes('denied');
  if (isBinaryMissing || isHookBlocked) {
    const reason = isBinaryMissing ? 'binary missing (ENOENT)' : 'hook blocked';
    logEvent(task.id, 'failed', `Rules 2-3: ${reason} — no retry`);
    return true;
  }
  return false;
}

function rules4and5StaleOrRateLimit(task) {
  if (task.status !== 'failed') return false;
  const err = (task.error || '').toLowerCase();
  const isStaleSession = err.includes('no conversation found');
  const isRateLimit = err.includes('rate limit') || err.includes('529') || err.includes('overloaded');
  if (!isStaleSession && !isRateLimit) return false;

  const maxRetries = task.maxRetries ?? MAX_RETRIES_DEFAULT;
  const retryCount = task.retryCount ?? 0;
  if (retryCount >= maxRetries) {
    logEvent(task.id, 'failed', `Rules 4-5: max retries exhausted (${retryCount}/${maxRetries})`);
    return true;
  }

  const reason = isStaleSession ? 'stale session' : 'rate limit / overloaded';
  const retryAfter = new Date(Date.now() + RETRY_BACKOFF_MS * (retryCount + 1)).toISOString();
  updateTask(task.id, { status: 'pending', retryCount: retryCount + 1, error: null, retryAfter });
  logEvent(task.id, 'retry', `Rules 4-5: ${reason} — retry ${retryCount + 1}/${maxRetries}`);
  try { createEval({ taskId: task.id, category: 'rate_limit', whatHappened: `${reason} — retry ${retryCount + 1}/${maxRetries}`, detection: 'auto_recovery', severity: 'low' }); } catch { /* ignore */ }
  return true;
}

// ---------------------------------------------------------------------------
// Rule 6: Ralph Wiggum loop — detect agents stuck repeating the same failure
// ---------------------------------------------------------------------------

/**
 * Simple hash for error comparison (first 200 chars, lowercased, whitespace-normalized).
 */
function errorHash(error) {
  if (!error) return '';
  return error.slice(0, 200).toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Detect Ralph Wiggum loops: agent retrying with identical errors.
 * Checks failed tasks that have retried 2+ times with matching error hashes.
 */
function rule6RalphWiggumLoop(task) {
  if (task.status !== 'failed') return false;
  if (task.loopDetected) return false; // already flagged
  if ((task.retryCount ?? 0) < 2) return false;

  const currentHash = errorHash(task.error);
  if (!currentHash) return false;

  // Compare to stored hash from previous failure
  if (task.lastErrorHash && task.lastErrorHash === currentHash) {
    updateTask(task.id, {
      loopDetected: `same_error_${task.retryCount}x`,
    });
    logEvent(task.id, 'ralph_wiggum_detected', `Same error hash on ${task.retryCount} retries: ${task.error?.slice(0, 100)}`);
    try {
      createEval({
        taskId: task.id,
        category: 'ralph_wiggum_loop',
        whatHappened: `Agent failed ${task.retryCount} times with identical error: ${task.error?.slice(0, 300)}`,
        rootCause: 'Retry prompt did not address the root cause — same error reproduced.',
        correctApproach: 'Rewrite the prompt with specific guidance addressing the error, or switch to analysis mode to investigate.',
        detection: 'auto_recovery',
        severity: 'high',
      });
    } catch { /* ignore eval creation errors */ }
    return true;
  }

  // Store current hash for next retry comparison
  updateTask(task.id, { lastErrorHash: currentHash });
  return false;
}

/**
 * Detect Ralph Wiggum loops on running tasks: agent running too long with no file changes.
 * Called from recovery scan for tasks running >5 min with no git diff.
 */
function rule6bRalphWiggumStuck(task) {
  if (task.status !== 'running') return false;
  if (task.loopDetected) return false;
  if (task.taskType === 'analysis') return false; // analysis tasks don't produce file changes

  const startedAt = task.startedAt ? new Date(task.startedAt).getTime() : 0;
  const runningMs = Date.now() - startedAt;
  if (runningMs < 5 * 60 * 1000) return false; // <5 min, too early to judge

  // Check if any files have changed in the worktree
  if (!task.worktreePath) return false;
  try {
    const status = execFileSync('git', ['status', '--porcelain'], {
      cwd: task.worktreePath, encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const realChanges = status.split('\n').filter(line => {
      const t = line.trim();
      return t && !t.endsWith('node_modules') && !t.endsWith('.env') && !t.endsWith('.env.local');
    });
    if (realChanges.length > 0) return false; // agent is making progress
  } catch {
    return false; // can't check, assume OK
  }

  // Running >5 min with no file changes
  updateTask(task.id, {
    loopDetected: `no_progress_${Math.round(runningMs / 60000)}m`,
  });
  logEvent(task.id, 'ralph_wiggum_detected', `Running ${Math.round(runningMs / 60000)}m with no file changes`);
  return true;
}

export function runRecoveryScan() {
  const tasks = getAllTasks();
  const repairs = [];

  for (const task of tasks) {
    if (task.status === 'done' || task.status === 'archived' || task.status === 'pending' || task.status === 'rejected') continue;

    if (rule0aZombieRetry(task)) { repairs.push({ taskId: task.id, rule: '0a', action: 'zombie_retry_failed' }); continue; }
    if (rule0bStuckMerge(task)) { repairs.push({ taskId: task.id, rule: '0b', action: 'stuck_merge_resolved' }); continue; }
    if (rule0cWriteRaceVictim(task)) { repairs.push({ taskId: task.id, rule: '0c', action: 'write_race_fixed' }); continue; }
    if (rule0dReviewAlreadyMerged(task)) { repairs.push({ taskId: task.id, rule: '0d', action: 'review_auto_resolved' }); continue; }
    if (rule1GhostRunner(task)) { repairs.push({ taskId: task.id, rule: '1', action: 'ghost_runner_failed' }); continue; }
    if (rules2and3BinaryOrHook(task)) { repairs.push({ taskId: task.id, rule: '2-3', action: 'escalation_no_retry' }); continue; }
    if (rules4and5StaleOrRateLimit(task)) { repairs.push({ taskId: task.id, rule: '4-5', action: 'auto_retry_or_exhausted' }); continue; }
    if (rule6RalphWiggumLoop(task)) { repairs.push({ taskId: task.id, rule: '6a', action: 'ralph_wiggum_same_error' }); continue; }
    if (rule6bRalphWiggumStuck(task)) { repairs.push({ taskId: task.id, rule: '6b', action: 'ralph_wiggum_no_progress' }); continue; }
  }

  if (repairs.length > 0) {
    console.error(`[recovery] scan complete — ${repairs.length} repair(s)`);
  }
  return repairs;
}

export function startRecoveryEngine() {
  console.error('[recovery] engine started (interval: 30s)');
  const intervalId = setInterval(() => {
    try { runRecoveryScan(); } catch (err) { console.error('[recovery] scan error:', err.message); }
  }, SCAN_INTERVAL_MS);

  return function stopRecoveryEngine() {
    clearInterval(intervalId);
    console.error('[recovery] engine stopped');
  };
}
