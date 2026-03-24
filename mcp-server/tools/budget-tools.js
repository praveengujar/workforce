/**
 * Budget tool handlers — manage budget limits and cost policies.
 *
 * Separated from monitoring-tools.js to avoid merge conflicts with Phase 1.
 *
 * NOTE: This module imports DB functions that Phase 1 is creating:
 *   - getBudget, setBudget, getCostForPeriod, getDailyCostHistory
 * Those imports will resolve once both phases are merged.
 */

import {
  getBudget,
  setBudget,
  getCostForPeriod,
  getDailyCostHistory,
  getTaskCountForPeriod,
} from '../core/db.js';

import { progressBar, costTrendLine } from './sparkline.js';
import {
  loadCostPolicy,
  saveCostPolicy,
  getDefaultPolicy,
} from './cost-approval.js';
import { getDateBoundaries, isSubscriptionMode } from '../core/constants.js';

// ---------------------------------------------------------------------------
// setBudgetHandler
// ---------------------------------------------------------------------------

/**
 * Set budget limits for a scope (global or project name).
 *
 * @param {{ scope: string, daily_limit?: number, weekly_limit?: number, monthly_limit?: number }} params
 * @returns {object}
 */
export function setBudgetHandler({ scope, daily_limit, weekly_limit, monthly_limit }) {
  const budgetScope = scope || 'global';

  if (daily_limit == null && weekly_limit == null && monthly_limit == null) {
    throw new Error('At least one limit (daily_limit, weekly_limit, or monthly_limit) is required');
  }

  // Load existing budget to merge — only overwrite fields that were provided
  let existing;
  try {
    existing = getBudget(budgetScope);
  } catch {
    existing = null;
  }

  const budget = {
    scope: budgetScope,
    dailyLimit: daily_limit ?? existing?.dailyLimit ?? null,
    weeklyLimit: weekly_limit ?? existing?.weeklyLimit ?? null,
    monthlyLimit: monthly_limit ?? existing?.monthlyLimit ?? null,
    updatedAt: new Date().toISOString(),
  };

  setBudget(budgetScope, {
    dailyLimit: budget.dailyLimit,
    weeklyLimit: budget.weeklyLimit,
    monthlyLimit: budget.monthlyLimit,
  });

  return {
    message: `Budget updated for "${budgetScope}"`,
    budget,
  };
}

// ---------------------------------------------------------------------------
// getBudgetHandler
// ---------------------------------------------------------------------------

/**
 * Return budget config + current spend + remaining for a scope.
 * Includes sparkline trend of last 14 days.
 *
 * @param {{ scope?: string }} params
 * @returns {{ text: string, data: object }}
 */
export function getBudgetHandler({ scope }) {
  const budgetScope = scope || 'global';
  const budget = getBudget(budgetScope);

  if (!budget) {
    return {
      text: `No budget configured for "${budgetScope}". Use set_budget to create one.`,
      data: null,
    };
  }

  const { startOfToday, startOfWeek, startOfMonth, endOfDay } = getDateBoundaries();
  const now = new Date().toISOString();

  if (isSubscriptionMode()) {
    const dailyCount = getTaskCountForPeriod(budgetScope, startOfToday, now);
    const weeklyCount = getTaskCountForPeriod(budgetScope, startOfWeek, now);
    const monthlyCount = getTaskCountForPeriod(budgetScope, startOfMonth, now);

    const lines = [];
    lines.push(`\u2501\u2501\u2501 BUDGET: ${budgetScope} (task limits) \u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501`);

    if (budget.dailyLimit != null) {
      const remaining = Math.max(0, budget.dailyLimit - dailyCount);
      const pct = budget.dailyLimit > 0 ? remaining / budget.dailyLimit : 0;
      lines.push(`Daily:   ${dailyCount} / ${budget.dailyLimit} tasks  (${Math.round(pct * 100)}% remaining)  ${progressBar(pct)}`);
    }
    if (budget.weeklyLimit != null) {
      const remaining = Math.max(0, budget.weeklyLimit - weeklyCount);
      const pct = budget.weeklyLimit > 0 ? remaining / budget.weeklyLimit : 0;
      lines.push(`Weekly:  ${weeklyCount} / ${budget.weeklyLimit} tasks  (${Math.round(pct * 100)}% remaining)  ${progressBar(pct)}`);
    }
    if (budget.monthlyLimit != null) {
      const remaining = Math.max(0, budget.monthlyLimit - monthlyCount);
      const pct = budget.monthlyLimit > 0 ? remaining / budget.monthlyLimit : 0;
      lines.push(`Monthly: ${monthlyCount} / ${budget.monthlyLimit} tasks  (${Math.round(pct * 100)}% remaining)  ${progressBar(pct)}`);
    }

    return {
      text: lines.join('\n'),
      data: { scope: budgetScope, budget, usage: { daily: dailyCount, weekly: weeklyCount, monthly: monthlyCount } },
    };
  }

  // API mode: existing dollar-based display below
  const dailySpend = getCostForPeriod(budgetScope, startOfToday, now);
  const weeklySpend = getCostForPeriod(budgetScope, startOfWeek, now);
  const monthlySpend = getCostForPeriod(budgetScope, startOfMonth, now);

  // Build formatted output
  const lines = [];
  lines.push(`━━━ BUDGET: ${budgetScope} ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

  if (budget.dailyLimit != null) {
    const remaining = Math.max(0, budget.dailyLimit - dailySpend);
    const pct = budget.dailyLimit > 0 ? remaining / budget.dailyLimit : 0;
    const bar = progressBar(pct);
    lines.push(
      `Daily:   $${dailySpend.toFixed(2)} / $${budget.dailyLimit.toFixed(2)}  (${Math.round(pct * 100)}% remaining)  ${bar}`,
    );
  }

  if (budget.weeklyLimit != null) {
    const remaining = Math.max(0, budget.weeklyLimit - weeklySpend);
    const pct = budget.weeklyLimit > 0 ? remaining / budget.weeklyLimit : 0;
    const bar = progressBar(pct);
    lines.push(
      `Weekly:  $${weeklySpend.toFixed(2)} / $${budget.weeklyLimit.toFixed(2)}  (${Math.round(pct * 100)}% remaining)  ${bar}`,
    );
  }

  if (budget.monthlyLimit != null) {
    const remaining = Math.max(0, budget.monthlyLimit - monthlySpend);
    const pct = budget.monthlyLimit > 0 ? remaining / budget.monthlyLimit : 0;
    const bar = progressBar(pct);
    lines.push(
      `Monthly: $${monthlySpend.toFixed(2)} / $${budget.monthlyLimit.toFixed(2)}  (${Math.round(pct * 100)}% remaining)  ${bar}`,
    );
  }

  // 14-day trend
  const history = getDailyCostHistory(budgetScope, 14);
  if (history && history.length > 0) {
    lines.push('');
    lines.push(costTrendLine(history));
  }

  return {
    text: lines.join('\n'),
    data: {
      scope: budgetScope,
      budget,
      spend: { daily: dailySpend, weekly: weeklySpend, monthly: monthlySpend },
      history,
    },
  };
}

// ---------------------------------------------------------------------------
// setCostPolicyHandler
// ---------------------------------------------------------------------------

/**
 * Configure the cost approval policy.
 *
 * @param {{ approval_threshold?: number, daily_auto_approve_limit?: number, per_task_max?: number, enabled?: boolean }} params
 * @returns {object}
 */
export function setCostPolicyHandler({ approval_threshold, daily_auto_approve_limit, per_task_max, enabled }) {
  const current = loadCostPolicy();

  if (approval_threshold != null) current.approvalThreshold = approval_threshold;
  if (daily_auto_approve_limit != null) current.dailyAutoApproveLimit = daily_auto_approve_limit;
  if (per_task_max != null) current.perTaskMax = per_task_max;
  if (enabled != null) current.enabled = enabled;

  saveCostPolicy(current);

  return {
    message: 'Cost policy updated',
    policy: current,
  };
}

// ---------------------------------------------------------------------------
// getCostPolicyHandler
// ---------------------------------------------------------------------------

/**
 * Return current cost policy config.
 *
 * @returns {object}
 */
export function getCostPolicyHandler() {
  const policy = loadCostPolicy();
  const defaults = getDefaultPolicy();

  const lines = [];
  lines.push('━━━ COST POLICY ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push(`Status:              ${policy.enabled ? '✓ Enabled' : '✗ Disabled'}`);
  lines.push(`Approval threshold:  $${policy.approvalThreshold.toFixed(2)}  (default: $${defaults.approvalThreshold.toFixed(2)})`);
  lines.push(`Daily auto-approve:  $${policy.dailyAutoApproveLimit.toFixed(2)}  (default: $${defaults.dailyAutoApproveLimit.toFixed(2)})`);
  lines.push(`Per-task max:        $${policy.perTaskMax.toFixed(2)}  (default: $${defaults.perTaskMax.toFixed(2)})`);

  return {
    text: lines.join('\n'),
    policy,
  };
}
