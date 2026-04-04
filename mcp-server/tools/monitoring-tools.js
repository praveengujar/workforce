/**
 * Monitoring tool handlers — health metrics, cost summary, projects, profiles, recovery.
 * Pure functions, no Express dependency.
 */

import { getAllTasks } from '../core/db.js';
import { getTaskEvents } from '../core/db.js';
import { classifyTier } from '../core/cost-model.js';
import { runRecoveryScan } from '../core/recovery-engine.js';
import { getDateBoundaries, isSubscriptionMode } from '../core/constants.js';
import { getEvalStats, clusterEvals } from '../core/eval-engine.js';
import { lintRules } from '../core/knowledge-rules.js';
import { routeTask } from '../core/capability-router.js';

// ---------------------------------------------------------------------------
// healthMetricsHandler
// ---------------------------------------------------------------------------
export function healthMetricsHandler() {
  const allTasks = getAllTasks(true); // include archived
  const total = allTasks.length;

  const done = allTasks.filter(t => t.status === 'done' || t.status === 'archived').length;
  const failed = allTasks.filter(t => t.status === 'failed').length;
  const rejected = allTasks.filter(t => t.status === 'rejected').length;
  const retried = allTasks.filter(t => t.retryCount > 0).length;
  const oneShot = allTasks.filter(
    t => (t.status === 'done' || t.status === 'archived') && t.retryCount === 0,
  ).length;

  const doneRate = total > 0 ? done / total : 0;
  const failRate = total > 0 ? failed / total : 0;
  const retryRate = total > 0 ? retried / total : 0;
  const oneShotRate = done > 0 ? oneShot / done : 0;

  // Recent tasks (last 24 hours)
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const recentTasks = allTasks.filter(t => t.createdAt > oneDayAgo).length;

  const suggestions = [];
  if (failRate > 0.3) suggestions.push('High failure rate -- review prompt quality and task scope');
  if (oneShotRate < 0.5) suggestions.push('Low one-shot rate -- consider more specific prompts');
  if (retryRate > 0.4) suggestions.push('Many retries -- check for flaky tests or merge conflicts');

  // Eval stats
  let evalStats = null;
  try { evalStats = getEvalStats(); } catch { /* eval table may not exist yet */ }

  return {
    doneRate: Math.round(doneRate * 100) / 100,
    failRate: Math.round(failRate * 100) / 100,
    retryRate: Math.round(retryRate * 100) / 100,
    oneShotRate: Math.round(oneShotRate * 100) / 100,
    rejected,
    rejectRate: total > 0 ? Math.round((rejected / total) * 100) / 100 : 0,
    uptime: process.uptime(),
    recentTasks,
    total,
    improvementSuggestions: suggestions,
    evalStats,
  };
}

// ---------------------------------------------------------------------------
// costSummaryHandler
// ---------------------------------------------------------------------------
export function costSummaryHandler() {
  const allTasks = getAllTasks(true);
  const { startOfToday, startOfWeek, startOfMonth } = getDateBoundaries();

  if (isSubscriptionMode()) {
    let todayTasks = 0, weekTasks = 0, monthTasks = 0;
    const byTier = { simple: 0, medium: 0, complex: 0 };
    let totalDurationMs = 0;
    let completedCount = 0;

    for (const task of allTasks) {
      const completedAt = task.completedAt || task.createdAt;
      if (!completedAt) continue;
      const tier = classifyTier(task.prompt || '');
      byTier[tier]++;

      if (completedAt >= startOfToday) todayTasks++;
      if (completedAt >= startOfWeek) weekTasks++;
      if (completedAt >= startOfMonth) monthTasks++;

      if (task.startedAt && task.completedAt) {
        totalDurationMs += new Date(task.completedAt).getTime() - new Date(task.startedAt).getTime();
        completedCount++;
      }
    }

    return {
      mode: 'subscription',
      today: todayTasks,
      thisWeek: weekTasks,
      thisMonth: monthTasks,
      byTier,
      totalDurationMs,
      avgDurationMs: completedCount > 0 ? Math.round(totalDurationMs / completedCount) : 0,
    };
  }

  // API mode: existing code below
  let today = 0;
  let thisWeek = 0;
  let thisMonth = 0;
  const byTier = { simple: 0, medium: 0, complex: 0 };

  for (const task of allTasks) {
    const cost = task.cost || 0;
    if (cost <= 0) continue;

    const completedAt = task.completedAt || task.createdAt;
    const tier = classifyTier(task.prompt || '');
    byTier[tier] += cost;

    if (completedAt >= startOfToday) today += cost;
    if (completedAt >= startOfWeek) thisWeek += cost;
    if (completedAt >= startOfMonth) thisMonth += cost;
  }

  return {
    mode: 'api',
    today: Math.round(today * 100) / 100,
    thisWeek: Math.round(thisWeek * 100) / 100,
    thisMonth: Math.round(thisMonth * 100) / 100,
    byTier: {
      simple: Math.round(byTier.simple * 100) / 100,
      medium: Math.round(byTier.medium * 100) / 100,
      complex: Math.round(byTier.complex * 100) / 100,
    },
  };
}

// ---------------------------------------------------------------------------
// runRecoveryHandler
// ---------------------------------------------------------------------------
export function runRecoveryHandler() {
  const repairs = runRecoveryScan();
  return { repairs };
}

// ---------------------------------------------------------------------------
// opsMetricsHandler — extended dashboard for gate/merge/rule quality
// ---------------------------------------------------------------------------
export function opsMetricsHandler() {
  const allTasks = getAllTasks(true);

  // Gate pass/fail rates
  let gateChecks = 0, gatePasses = 0, gateBlocks = 0, gateWaivers = 0;
  const mergeBlockReasons = {};
  const postMergeResults = { passed: 0, failed: 0, skipped: 0 };

  for (const task of allTasks) {
    if (task.status !== 'done' && task.status !== 'failed' && task.status !== 'archived') continue;
    try {
      const events = getTaskEvents(task.id);
      for (const ev of events) {
        if (ev.phase === 'approved') gatePasses++;
        if (ev.phase === 'gate_waived') gateWaivers++;
        if (ev.phase === 'merge_failed') {
          gateBlocks++;
          const reason = ev.detail?.slice(0, 50) || 'unknown';
          mergeBlockReasons[reason] = (mergeBlockReasons[reason] || 0) + 1;
        }
        if (ev.phase === 'post_merge_verify_passed') postMergeResults.passed++;
        if (ev.phase === 'post_merge_verify_failed') postMergeResults.failed++;
      }
      if (task.status === 'done') gateChecks++;
    } catch { /* ignore per-task errors */ }
  }

  // Eval clusters
  let evalClusters = [];
  try { evalClusters = clusterEvals(); } catch { /* ignore */ }

  // Rule quality
  let ruleLint = [];
  try { ruleLint = lintRules(); } catch { /* ignore */ }

  return {
    gates: {
      totalChecks: gateChecks,
      passed: gatePasses,
      blocked: gateBlocks,
      waivers: gateWaivers,
      passRate: gateChecks > 0 ? Math.round((gatePasses / gateChecks) * 100) / 100 : 0,
    },
    mergeBlockReasons,
    postMergeVerification: postMergeResults,
    evalClusters: evalClusters.map(c => ({
      category: c.category,
      evalCount: c.evalCount,
      confidence: c.confidence,
      suggestedRuleName: c.suggestedRule.name,
    })),
    ruleQuality: {
      totalIssues: ruleLint.length,
      issues: ruleLint.slice(0, 10), // top 10
    },
  };
}

// ---------------------------------------------------------------------------
// routeTaskHandler — capability router
// ---------------------------------------------------------------------------
export function routeTaskHandler({ prompt, tier, file_paths }) {
  return routeTask({ prompt, tier, filePaths: file_paths || [] });
}

// ---------------------------------------------------------------------------
// evalClustersHandler — expose eval clustering
// ---------------------------------------------------------------------------
export function evalClustersHandler({ min_cluster_size, similarity_threshold } = {}) {
  return clusterEvals({
    minClusterSize: min_cluster_size || 3,
    similarityThreshold: similarity_threshold || 0.7,
  });
}

// ---------------------------------------------------------------------------
// ruleLintHandler — expose rule lint
// ---------------------------------------------------------------------------
export function ruleLintHandler() {
  return lintRules();
}

// ---------------------------------------------------------------------------
// loopStatusHandler — Ralph Wiggum loop detection status
// ---------------------------------------------------------------------------
export function loopStatusHandler() {
  const allTasks = getAllTasks();
  const loopTasks = allTasks.filter(t => t.loopDetected);
  const running = allTasks.filter(t => t.status === 'running');
  const stuckRunning = running.filter(t => {
    if (!t.startedAt) return false;
    return Date.now() - new Date(t.startedAt).getTime() > 5 * 60 * 1000;
  });

  return {
    activeLoops: loopTasks.filter(t => t.status === 'running' || t.status === 'failed').map(t => ({
      taskId: t.id,
      status: t.status,
      loopType: t.loopDetected,
      error: t.error?.slice(0, 200),
      retryCount: t.retryCount,
      prompt: t.prompt?.slice(0, 100),
    })),
    longRunning: stuckRunning.map(t => ({
      taskId: t.id,
      runningMinutes: Math.round((Date.now() - new Date(t.startedAt).getTime()) / 60000),
      prompt: t.prompt?.slice(0, 100),
    })),
    summary: {
      totalDetected: loopTasks.length,
      activeNow: loopTasks.filter(t => t.status === 'running').length,
      failedWithLoop: loopTasks.filter(t => t.status === 'failed').length,
      longRunningCount: stuckRunning.length,
    },
  };
}
