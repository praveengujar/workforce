/**
 * Monitoring tool handlers — health metrics, cost summary, projects, profiles, recovery.
 * Pure functions, no Express dependency.
 */

import { getAllTasks } from '../core/db.js';
import { classifyTier } from '../core/cost-model.js';
import { runRecoveryScan } from '../core/recovery-engine.js';
import { getDateBoundaries } from '../core/constants.js';

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
  };
}

// ---------------------------------------------------------------------------
// costSummaryHandler
// ---------------------------------------------------------------------------
export function costSummaryHandler() {
  const allTasks = getAllTasks(true);
  const { startOfToday, startOfWeek, startOfMonth } = getDateBoundaries();

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
