/**
 * Autonomy tool handlers — start/stop/status, evaluate (shadow + live),
 * and the merge-verify-revert flow.
 *
 * The handlers here are the only place that combines evidence collection,
 * policy evaluation, gate event writing, and the merge/revert sequence.
 * `validateGates()` stays pure: it only verifies the persisted verdict.
 */

import { execFileSync } from 'node:child_process';
import { join, basename } from 'node:path';
import {
  getTask, updateTask, getDb, getActiveAutonomyRun, getAutonomyRun,
  listOutboxByRun, listRecentAutonomyRuns,
} from '../core/db.js';
import { logEvent } from '../core/task-events.js';
import { gitExec } from '../core/constants.js';
import {
  getMode,
  isAutonomyEnabled,
  isAutonomousMerge,
  currentRun,
  startRun,
  endRun,
  heartbeat,
  setHalt,
  clearHalt,
  recordConsecutiveFailure,
  resetConsecutiveFailures,
  policyVersion,
  configHash,
  getAutonomyConfig,
} from '../core/autonomy-controller.js';
import { evaluate as evaluatePolicy } from '../core/autonomy-policy.js';
import {
  collectDiffStats,
  runPreMergeTests,
  checkFreshness,
} from '../core/autonomy-evidence.js';
import { ensureStagingBranch, mergeWorktree } from '../core/worker-manager.js';
import { notify } from '../core/notifier.js';

// ---------------------------------------------------------------------------
// startRunHandler — opt-in entry point (workforce-autonomy start)
// ---------------------------------------------------------------------------

export function startRunHandler({
  mode = 'shadow',
  baseBranch = null,
  budgetUsd = null,
  maxConcurrency = null,
  durationMinutes = null,
  force = false,
  snapshot = null,
} = {}) {
  const repoRoot = process.cwd();
  const cfg = getAutonomyConfig();
  const effectiveBase = baseBranch || _detectBaseBranch(repoRoot) || 'main';

  const run = startRun({
    repoRoot,
    mode,
    baseBranch: effectiveBase,
    budgetCapUsd: budgetUsd,
    maxConcurrency,
    snapshot: snapshot || {
      requestedDurationMinutes: durationMinutes,
      requestedAt: new Date().toISOString(),
    },
    force,
  });

  // Ensure the per-run staging branch exists in git (only for live merge modes).
  if (mode === 'auto') {
    try {
      ensureStagingBranch({
        repoRoot,
        baseBranch: effectiveBase,
        stagingBranch: run.stagingBranch,
      });
    } catch (err) {
      // Roll back the run — if we can't create staging, autonomy can't proceed.
      endRun(run.runId, `staging_branch_failed: ${err.message}`);
      throw new Error(`autonomy start failed: ${err.message}`);
    }
  }

  notify({
    subject: `Autonomy started (${mode})`,
    body: `runId=${run.runId} base=${effectiveBase} staging=${run.stagingBranch}`,
    severity: 'info',
    runId: run.runId,
  });

  return {
    ok: true,
    runId: run.runId,
    mode: run.mode,
    stagingBranch: run.stagingBranch,
    baseBranch: run.baseBranch,
    policyVersion: run.policyVersion,
    configHash: run.configHash,
    budgetCapUsd: run.budgetCapUsd,
    maxConcurrency: run.maxConcurrency,
    leaseExpiresAt: run.leaseExpiresAt,
  };
}

function _detectBaseBranch(repoRoot) {
  try {
    return gitExec(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoRoot });
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// stopRunHandler
// ---------------------------------------------------------------------------

export function stopRunHandler({ reason = 'user_stop' } = {}) {
  const run = currentRun(process.cwd());
  if (!run) return { ok: false, error: 'no active run' };
  endRun(run.runId, reason);
  notify({
    subject: 'Autonomy stopped',
    body: `runId=${run.runId} reason=${reason}`,
    severity: 'info',
    runId: run.runId,
  });
  return { ok: true, runId: run.runId, endReason: reason };
}

// ---------------------------------------------------------------------------
// statusHandler
// ---------------------------------------------------------------------------

export function statusHandler() {
  const repoRoot = process.cwd();
  const mode = getMode(repoRoot);
  const run = currentRun(repoRoot);
  return {
    mode,
    enabled: isAutonomyEnabled(repoRoot),
    canMerge: isAutonomousMerge(repoRoot),
    policyVersion: policyVersion(),
    configHash: configHash(),
    run: run ? {
      runId: run.runId,
      mode: run.mode,
      stagingBranch: run.stagingBranch,
      baseBranch: run.baseBranch,
      leaseExpiresAt: run.leaseExpiresAt,
      heartbeatAt: run.heartbeatAt,
      consecutiveFailures: run.consecutiveFailures,
      haltReason: run.haltReason,
      budgetCapUsd: run.budgetCapUsd,
      maxConcurrency: run.maxConcurrency,
      startedAt: run.startedAt,
    } : null,
  };
}

// ---------------------------------------------------------------------------
// heartbeatHandler — controller process pings to keep lease fresh
// ---------------------------------------------------------------------------

export function heartbeatHandler({ run_id } = {}) {
  if (!run_id) {
    const run = currentRun(process.cwd());
    if (!run) return { ok: false, error: 'no active run' };
    run_id = run.runId;
  }
  const updated = heartbeat(run_id);
  return { ok: true, heartbeatAt: updated?.heartbeatAt, leaseExpiresAt: updated?.leaseExpiresAt };
}

// ---------------------------------------------------------------------------
// evaluateTaskHandler — collect evidence + run policy. Always safe to call;
// shadow mode persists verdict without acting. Live modes act on the verdict.
// ---------------------------------------------------------------------------

export async function evaluateTaskHandler({ task_id, dry_run = false } = {}) {
  if (!task_id) throw new Error('task_id is required');
  const task = getTask(task_id);
  if (!task) throw new Error(`task not found: ${task_id}`);

  const repoRoot = process.cwd();
  const mode = getMode(repoRoot);

  // Evidence collection
  const branchName = task.branch || `wf/${task.id}`;
  const baseBranch = task.targetBranch || 'main';
  const worktreePath = task.worktreePath || join(repoRoot, 'wf', task.id);

  const diff = collectDiffStats({ repoRoot, branchName, baseBranch });

  // Pre-merge tests — only run if we have a worktree we can exercise.
  let tests = { passed: null };
  try {
    const result = runPreMergeTests({ worktreePath });
    if (result.ran) {
      tests = { passed: result.passed };
      logEvent(task.id, result.passed ? 'pre_merge_verify_passed' : 'pre_merge_verify_failed',
        result.passed ? 'pre-merge tests passed' : `pre-merge tests failed: ${(result.error || '').slice(0, 200)}`);
    } else {
      tests = { passed: true }; // no test command = no signal; don't block
    }
  } catch (err) {
    tests = { passed: false };
    logEvent(task.id, 'pre_merge_verify_failed', `runner error: ${err.message}`);
  }

  const freshness = checkFreshness({ repoRoot, branchName, baseBranch, task });

  // Review + security scores — pull from task events if present.
  const events = _getEvents(task.id);
  const reviewScore = _extractScoreFromEvents(events, 'review_score');
  const securityScore = _extractScoreFromEvents(events, 'security_score');

  const verdict = evaluatePolicy({
    task,
    reviewScore,
    securityScore,
    additions: diff.additions,
    deletions: diff.deletions,
    files: diff.files,
    targetBranch: task.targetBranch,
    budget: null, // budget exceeded surfaces via controller halt, not per-task
    tests,
    freshness,
    promotedRules: 0, // lockdown enforced at tool layer; 0 by construction
  });

  // Persist verdict + write the canonical autonomy_decision event.
  updateTask(task.id, { autonomyDecision: JSON.stringify(verdict) });
  logEvent(task.id, 'autonomy_decision',
    `${verdict.decision} (policy=${verdict.policyVersion}, cfg=${verdict.configHash})`);

  if (dry_run) {
    return { ok: true, verdict, mode, acted: false, reason: 'dry_run' };
  }

  // Act on the verdict according to the active mode.
  return _actOnVerdict({ task, verdict, mode });
}

async function _actOnVerdict({ task, verdict, mode }) {
  if (mode === 'off' || mode === 'shadow') {
    return { ok: true, verdict, mode, acted: false, reason: 'shadow_or_off' };
  }

  if (verdict.decision === 'park-for-human' || verdict.decision === 'auto-reject') {
    return _parkTask({ task, verdict, mode });
  }

  // decision === 'auto-approve'
  if (mode === 'park') {
    // Park mode never merges, even on auto-approve.
    return _parkTask({ task, verdict, mode, reason: 'mode_park' });
  }

  // mode === 'auto' — perform the merge.
  return _autonomousMerge({ task, verdict });
}

function _parkTask({ task, verdict, mode, reason = null }) {
  const reasons = [reason, ...(verdict.reasons || [])].filter(Boolean).join('; ');
  updateTask(task.id, {
    status: 'review',
    parkedReason: reasons || 'parked by autonomy policy',
  });
  logEvent(task.id, 'autonomy_parked', reasons);
  notify({
    subject: `Task parked by autonomy: ${task.id.slice(0, 8)}`,
    body: reasons,
    severity: 'warning',
    runId: task.autonomyRunId,
    taskId: task.id,
  });
  return { ok: true, verdict, mode, acted: true, action: 'parked' };
}

async function _autonomousMerge({ task, verdict }) {
  const repoRoot = process.cwd();
  const run = currentRun(repoRoot);

  // Defense-in-depth: never merge to protected branch under autonomy.
  const cfg = getAutonomyConfig();
  const protectedBranches = cfg.protectedBranches || [];
  const target = task.targetBranch || '';
  for (const g of protectedBranches) {
    if (_matchGlob(target, g)) {
      const msg = `autonomy refuses merge to protected branch "${target}" (matched "${g}")`;
      logEvent(task.id, 'autonomy_refuse', msg);
      if (run) setHalt(run.runId, 'protected_branch_target');
      notify({ subject: 'Autonomy halted: protected branch target', body: msg, severity: 'critical', runId: run?.runId, taskId: task.id });
      return { ok: false, verdict, mode: 'auto', acted: false, error: msg };
    }
  }

  // Stamp the task with the autonomy_decision event acting as gate substitute.
  // Move the task into review->merging via the standard approval path so the
  // existing merge flow runs. validateGates() will accept the substitute.
  updateTask(task.id, { status: 'review' });

  // Capture pre-merge HEAD on target to recover mergeSha after merge.
  let preMergeHead = null;
  try { preMergeHead = gitExec(['rev-parse', target], { cwd: repoRoot }); } catch { /* ignore */ }

  // Run the merge.
  try {
    await mergeWorktree(task);
  } catch (err) {
    logEvent(task.id, 'autonomy_merge_failed', err.message);
    if (run) recordConsecutiveFailure(run.runId, run.consecutiveFailures);
    notify({ subject: `Autonomy merge failed: ${task.id.slice(0, 8)}`, body: err.message, severity: 'critical', runId: run?.runId, taskId: task.id });
    return { ok: false, verdict, mode: 'auto', acted: true, action: 'merge_failed', error: err.message };
  }

  // Capture mergeSha (HEAD on target after merge).
  let mergeSha = null;
  try {
    mergeSha = gitExec(['rev-parse', target], { cwd: repoRoot });
    if (mergeSha && mergeSha !== preMergeHead) {
      updateTask(task.id, { mergeSha });
      logEvent(task.id, 'merge_sha_recorded', mergeSha);
    }
  } catch { /* ignore */ }

  // Post-merge verification was run inside mergeWorktree. If a
  // `post_merge_verify_failed` event exists in this task's timeline, revert.
  const postFailed = _getEvents(task.id).some((e) => e.phase === 'post_merge_verify_failed');
  if (postFailed) {
    return _autonomousRevert({ task, mergeSha, target, run, verdict });
  }

  if (run) resetConsecutiveFailures(run.runId);
  notify({
    subject: `Auto-merged: ${task.id.slice(0, 8)}`,
    body: `${target} <- ${task.branch || `wf/${task.id}`}\nmergeSha=${mergeSha}`,
    severity: 'info',
    runId: run?.runId,
    taskId: task.id,
  });
  return { ok: true, verdict, mode: 'auto', acted: true, action: 'merged', mergeSha };
}

function _autonomousRevert({ task, mergeSha, target, run, verdict }) {
  const repoRoot = process.cwd();
  if (!mergeSha) {
    const msg = 'cannot revert: mergeSha unknown';
    logEvent(task.id, 'autonomy_revert_failed', msg);
    if (run) setHalt(run.runId, 'revert_failed_no_sha');
    notify({ subject: 'Autonomy halted: cannot revert', body: msg, severity: 'critical', runId: run?.runId, taskId: task.id });
    return { ok: false, verdict, mode: 'auto', acted: true, action: 'revert_failed', error: msg };
  }

  // Refuse to revert on protected branch (should never happen — defense in depth).
  const cfg = getAutonomyConfig();
  for (const g of (cfg.protectedBranches || [])) {
    if (_matchGlob(target, g)) {
      const msg = `revert refused: target "${target}" is protected`;
      logEvent(task.id, 'autonomy_revert_failed', msg);
      if (run) setHalt(run.runId, 'revert_on_protected_blocked');
      notify({ subject: 'Autonomy halted: revert blocked', body: msg, severity: 'critical', runId: run?.runId, taskId: task.id });
      return { ok: false, verdict, mode: 'auto', acted: true, action: 'revert_failed', error: msg };
    }
  }

  // Determine if the merge produced a merge commit (true merge --no-ff) or
  // was fast-forwarded. mergeWorktree uses --no-ff so we should always have a
  // merge commit, but we handle both for safety.
  let isMergeCommit = false;
  try {
    const parents = gitExec(['rev-list', '--parents', '-n', '1', mergeSha], { cwd: repoRoot });
    const parts = parents.split(/\s+/).filter(Boolean);
    isMergeCommit = parts.length > 2; // sha + 2+ parents
  } catch { /* ignore */ }

  try {
    if (isMergeCommit) {
      gitExec(['revert', '--no-edit', '-m', '1', mergeSha], { cwd: repoRoot });
    } else {
      gitExec(['revert', '--no-edit', mergeSha], { cwd: repoRoot });
    }
  } catch (err) {
    // Revert conflict — DO NOT force. Halt autonomy, leave branch as-is.
    try { gitExec(['revert', '--abort'], { cwd: repoRoot }); } catch { /* ignore */ }
    const msg = `revert conflict: ${err.message || 'unknown'}`;
    logEvent(task.id, 'autonomy_revert_failed', msg);
    if (run) setHalt(run.runId, 'revert_conflict');
    notify({
      subject: `Autonomy HALT: revert conflict on ${task.id.slice(0, 8)}`,
      body: `Merge ${mergeSha} could not be reverted. ${msg}\nManual intervention required.`,
      severity: 'critical',
      runId: run?.runId,
      taskId: task.id,
    });
    return { ok: false, verdict, mode: 'auto', acted: true, action: 'revert_conflict', error: msg };
  }

  let revertSha = null;
  try { revertSha = gitExec(['rev-parse', 'HEAD'], { cwd: repoRoot }); } catch { /* ignore */ }
  updateTask(task.id, {
    status: 'reverted',
    revertSha,
    revertedAt: new Date().toISOString(),
    error: 'Reverted after failed post-merge verification',
  });
  logEvent(task.id, 'autonomy_reverted', `revertSha=${revertSha} of mergeSha=${mergeSha}`);
  if (run) recordConsecutiveFailure(run.runId, run.consecutiveFailures);
  notify({
    subject: `Auto-reverted: ${task.id.slice(0, 8)}`,
    body: `Reverted ${mergeSha} on ${target} (revertSha=${revertSha})\nPost-merge tests failed.`,
    severity: 'warning',
    runId: run?.runId,
    taskId: task.id,
  });
  return { ok: true, verdict, mode: 'auto', acted: true, action: 'reverted', mergeSha, revertSha };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _getEvents(taskId) {
  return getDb().prepare('SELECT * FROM task_events WHERE taskId = ? ORDER BY id ASC').all(taskId);
}

function _extractScoreFromEvents(events, kind) {
  // Reviews + security agents conventionally log `${kind}` with numeric detail.
  // Scan backwards for the most recent numeric value.
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].phase !== kind) continue;
    const detail = events[i].detail || '';
    const m = detail.match(/(-?\d+(?:\.\d+)?)/);
    if (m) return Number(m[1]);
  }
  return null;
}

function _matchGlob(path, glob) {
  let re = '^';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') { re += '.*'; i++; if (glob[i + 1] === '/') i++; }
      else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if ('.+()|^$[]{}\\'.includes(c)) re += '\\' + c;
    else re += c;
  }
  re += '$';
  return new RegExp(re).test(path);
}

// ---------------------------------------------------------------------------
// morningReportHandler — overnight triage
// ---------------------------------------------------------------------------

export function morningReportHandler({ run_id = null } = {}) {
  const repoRoot = process.cwd();
  const run = run_id ? getAutonomyRun(run_id) : (currentRun(repoRoot) || _lastRun(repoRoot));
  if (!run) return { ok: false, error: 'no run found' };

  const db = getDb();
  const tasks = db.prepare(
    'SELECT * FROM tasks WHERE autonomyRunId = ? ORDER BY createdAt ASC',
  ).all(run.runId);

  const groups = {
    merged: [],
    parked: [],
    reverted: [],
    failed: [],
    done: [],
    inProgress: [],
  };
  for (const t of tasks) {
    if (t.revertedAt) groups.reverted.push(t);
    else if (t.parkedReason) groups.parked.push(t);
    else if (t.status === 'failed') groups.failed.push(t);
    else if (t.merged) groups.merged.push(t);
    else if (t.status === 'done') groups.done.push(t);
    else groups.inProgress.push(t);
  }

  const outbox = listOutboxByRun(run.runId, true);
  const undelivered = outbox.filter((n) => n.status !== 'delivered');

  return {
    ok: true,
    run: {
      runId: run.runId,
      mode: run.mode,
      status: run.status,
      stagingBranch: run.stagingBranch,
      baseBranch: run.baseBranch,
      policyVersion: run.policyVersion,
      configHash: run.configHash,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      endReason: run.endReason,
      haltReason: run.haltReason,
      consecutiveFailures: run.consecutiveFailures,
    },
    counts: {
      merged: groups.merged.length,
      parked: groups.parked.length,
      reverted: groups.reverted.length,
      failed: groups.failed.length,
      done: groups.done.length,
      inProgress: groups.inProgress.length,
    },
    merged: groups.merged.map(_summarize),
    parked: groups.parked.map(_summarize),
    reverted: groups.reverted.map(_summarize),
    failed: groups.failed.map(_summarize),
    notifications: {
      total: outbox.length,
      undelivered: undelivered.length,
      criticals: outbox.filter((n) => n.severity === 'critical').length,
    },
  };
}

function _summarize(task) {
  let verdict = null;
  try { verdict = task.autonomyDecision ? JSON.parse(task.autonomyDecision) : null; } catch { /* ignore */ }
  return {
    id: task.id,
    prompt: (task.prompt || '').slice(0, 80),
    status: task.status,
    targetBranch: task.targetBranch,
    mergeSha: task.mergeSha,
    revertSha: task.revertSha,
    parkedReason: task.parkedReason,
    decision: verdict?.decision,
    reasons: verdict?.reasons,
  };
}

function _lastRun(repoRoot) {
  const recent = listRecentAutonomyRuns(repoRoot, 1);
  return recent[0] || null;
}

// ---------------------------------------------------------------------------
// haltHandler / resumeHandler
// ---------------------------------------------------------------------------

export function haltHandler({ reason = 'manual' } = {}) {
  const run = currentRun(process.cwd());
  if (!run) return { ok: false, error: 'no active run' };
  setHalt(run.runId, reason);
  notify({
    subject: 'Autonomy halted (manual)',
    body: `runId=${run.runId} reason=${reason}`,
    severity: 'critical',
    runId: run.runId,
  });
  return { ok: true, runId: run.runId, haltReason: reason };
}

export function resumeHandler() {
  const run = currentRun(process.cwd());
  if (!run) return { ok: false, error: 'no active run' };
  clearHalt(run.runId);
  resetConsecutiveFailures(run.runId);
  return { ok: true, runId: run.runId };
}
