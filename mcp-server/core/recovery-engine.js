import { execFileSync } from 'node:child_process';
import { getAllTasks, updateTask } from './db.js';
import { logEvent } from './task-events.js';

const SCAN_INTERVAL_MS = 30_000;
const ZOMBIE_THRESHOLD_MS = 3 * 60 * 1000;
const RETRY_BACKOFF_MS = 60_000;
const MAX_RETRIES_DEFAULT = 3;

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
  if (task.status !== 'running' || task.sessionId) return false;
  const startedAt = task.startedAt ? new Date(task.startedAt).getTime() : 0;
  if (Date.now() - startedAt < ZOMBIE_THRESHOLD_MS) return false;
  updateTask(task.id, { status: 'failed', error: 'Zombie retry: running with no session for >3 min', completedAt: new Date().toISOString() });
  logEvent(task.id, 'failed', 'Rule 0a: zombie retry detected');
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

function rule1GhostRunner(task) {
  if (task.status !== 'running' || !task.pid) return false;
  if (!isPidAlive(task.pid)) {
    updateTask(task.id, { status: 'failed', error: `Ghost runner: PID ${task.pid} dead`, completedAt: new Date().toISOString() });
    logEvent(task.id, 'failed', `Rule 1: ghost runner — PID ${task.pid} dead`);
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
  updateTask(task.id, { status: 'pending', retryCount: retryCount + 1, error: null });
  logEvent(task.id, 'retry', `Rules 4-5: ${reason} — retry ${retryCount + 1}/${maxRetries}`);
  return true;
}

export function runRecoveryScan() {
  const tasks = getAllTasks();
  const repairs = [];

  for (const task of tasks) {
    if (task.status === 'done' || task.status === 'archived' || task.status === 'pending') continue;

    if (rule0aZombieRetry(task)) { repairs.push({ taskId: task.id, rule: '0a', action: 'zombie_retry_failed' }); continue; }
    if (rule0bStuckMerge(task)) { repairs.push({ taskId: task.id, rule: '0b', action: 'stuck_merge_resolved' }); continue; }
    if (rule0cWriteRaceVictim(task)) { repairs.push({ taskId: task.id, rule: '0c', action: 'write_race_fixed' }); continue; }
    if (rule1GhostRunner(task)) { repairs.push({ taskId: task.id, rule: '1', action: 'ghost_runner_failed' }); continue; }
    if (rules2and3BinaryOrHook(task)) { repairs.push({ taskId: task.id, rule: '2-3', action: 'escalation_no_retry' }); continue; }
    if (rules4and5StaleOrRateLimit(task)) { repairs.push({ taskId: task.id, rule: '4-5', action: 'auto_retry_or_exhausted' }); continue; }
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
