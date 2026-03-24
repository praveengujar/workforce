/**
 * Pre-formatted text output for MCP tool responses.
 * Uses Unicode visual elements for compact, readable dashboard output.
 */

import { progressBar } from './sparkline.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns elapsed time string from ISO timestamp to now.
 * Format: "Xm Ys" for < 1 hour, "Xh Ym" otherwise.
 */
export function elapsed(isoString) {
  if (!isoString) return '--';
  const ms = Date.now() - new Date(isoString).getTime();
  if (ms < 0) return '0s';

  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/**
 * Truncate string with ellipsis.
 */
export function truncate(str, len = 40) {
  if (!str) return '';
  if (str.length <= len) return str;
  return str.slice(0, len - 3) + '...';
}

/**
 * First 8 characters of an ID.
 */
export function shortId(id) {
  if (!id) return '--------';
  return id.slice(0, 8);
}

// Status indicator symbols
const STATUS_ICON = {
  running: '\u25CF',   // ●
  pending: '\u25CB',   // ○
  review:  '\u25C6',   // ◆
  done:    '\u2713',   // ✓
  failed:  '\u2717',   // ✗
  paused:  '\u25D6',   // ◖
  rejected: '\u2718',  // ✘
  archived: '\u2713',  // ✓
  completed: '\u2713', // ✓
  stopped: '\u25D6',   // ◖
};

export function statusIcon(status) {
  return STATUS_ICON[status] || '?';
}

export function dollar(val) {
  if (val == null || isNaN(val)) return '$0.00';
  return `$${Number(val).toFixed(2)}`;
}

function pct(val) {
  if (val == null || isNaN(val)) return '0%';
  return `${Math.round(val * 100)}%`;
}

// ---------------------------------------------------------------------------
// formatTaskList
// ---------------------------------------------------------------------------

/**
 * Compact task list with status indicators.
 */
export function formatTaskList(tasks) {
  if (!tasks || tasks.length === 0) {
    return 'No tasks found.';
  }

  const lines = [];
  lines.push('\u2501\u2501\u2501 TASKS \u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501');
  lines.push('');

  // Group by status
  const groups = {};
  for (const t of tasks) {
    const s = t.status || 'unknown';
    if (!groups[s]) groups[s] = [];
    groups[s].push(t);
  }

  // Display order
  const order = ['running', 'pending', 'paused', 'review', 'done', 'failed', 'rejected', 'archived'];
  for (const status of order) {
    const group = groups[status];
    if (!group || group.length === 0) continue;

    lines.push(`  ${status.toUpperCase()} (${group.length})`);
    for (const t of group) {
      const time = status === 'running' ? elapsed(t.startedAt) : elapsed(t.createdAt);
      const proj = t.project ? `  ${t.project}` : '';
      const prompt = truncate(t.prompt, 42);
      lines.push(`  ${statusIcon(status)} ${shortId(t.id)}  ${time.padEnd(8)}${proj.padEnd(14)} "${prompt}"`);
    }
    lines.push('');
  }

  lines.push(`  Total: ${tasks.length} tasks`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// formatHealthMetrics
// ---------------------------------------------------------------------------

/**
 * Full health report with progress bars.
 */
export function formatHealthMetrics(metrics, costSummary) {
  const lines = [];
  lines.push('\u2501\u2501\u2501 WORKFORCE HEALTH \u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501');
  lines.push('');

  // Success rate
  const successTarget = 0.85;
  const successMet = metrics.doneRate >= successTarget;
  lines.push(`  Success  ${pct(metrics.doneRate).padEnd(5)} ${progressBar(metrics.doneRate)}  target ${pct(successTarget)} ${successMet ? '\u2713' : '\u2717'}`);

  // One-shot rate
  const oneShotTarget = 0.60;
  const oneShotMet = metrics.oneShotRate >= oneShotTarget;
  lines.push(`  1-shot   ${pct(metrics.oneShotRate).padEnd(5)} ${progressBar(metrics.oneShotRate)}  target ${pct(oneShotTarget)} ${oneShotMet ? '\u2713' : '\u2717'}`);

  // Failure rate (lower is better — invert bar)
  const failTarget = 0.15;
  const failMet = metrics.failRate <= failTarget;
  lines.push(`  Fail     ${pct(metrics.failRate).padEnd(5)} ${progressBar(metrics.failRate)}  target <${pct(failTarget)} ${failMet ? '\u2713' : '\u2717'}`);

  // Retry rate
  const retryTarget = 0.20;
  const retryMet = metrics.retryRate <= retryTarget;
  lines.push(`  Retry    ${pct(metrics.retryRate).padEnd(5)} ${progressBar(metrics.retryRate)}  target <${pct(retryTarget)} ${retryMet ? '\u2713' : '\u2717'}`);

  lines.push('');
  lines.push(`  Tasks: ${metrics.total} total, ${metrics.recentTasks} in last 24h`);
  lines.push(`  Uptime: ${Math.floor(metrics.uptime / 3600)}h ${Math.floor((metrics.uptime % 3600) / 60)}m`);

  // Suggestions
  if (metrics.improvementSuggestions && metrics.improvementSuggestions.length > 0) {
    lines.push('');
    lines.push('  \u2500\u2500\u2500 suggestions \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');
    for (const s of metrics.improvementSuggestions) {
      lines.push(`  \u2022 ${s}`);
    }
  }

  // Cost / usage section
  if (costSummary && costSummary.mode === 'subscription') {
    lines.push('');
    lines.push('  \u2500\u2500\u2500 usage \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');
    lines.push(`  Today ${costSummary.today} tasks \u2502 Week ${costSummary.thisWeek} tasks \u2502 Month ${costSummary.thisMonth} tasks`);
  } else if (costSummary) {
    lines.push('');
    lines.push('  \u2500\u2500\u2500 cost \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');
    lines.push(`  Today ${dollar(costSummary.today)} \u2502 Week ${dollar(costSummary.thisWeek)} \u2502 Month ${dollar(costSummary.thisMonth)}`);
    lines.push(`  By tier: simple ${dollar(costSummary.byTier?.simple)} \u2502 medium ${dollar(costSummary.byTier?.medium)} \u2502 complex ${dollar(costSummary.byTier?.complex)}`);
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// formatCostSummary
// ---------------------------------------------------------------------------

/**
 * Box-drawing cost table.
 */
export function formatCostSummary(costSummary) {
  if (!costSummary) return 'No cost data available.';

  if (costSummary.mode === 'subscription') {
    const lines = [];
    lines.push('\u2501\u2501\u2501 USAGE SUMMARY \u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501');
    lines.push('');
    lines.push(`  Today:      ${costSummary.today} tasks`);
    lines.push(`  This week:  ${costSummary.thisWeek} tasks`);
    lines.push(`  This month: ${costSummary.thisMonth} tasks`);
    lines.push('');
    lines.push('  BY TIER');
    lines.push(`  Simple: ${costSummary.byTier?.simple || 0}  Medium: ${costSummary.byTier?.medium || 0}  Complex: ${costSummary.byTier?.complex || 0}`);
    if (costSummary.avgDurationMs > 0) {
      const avgMin = Math.round(costSummary.avgDurationMs / 60000);
      const avgSec = Math.round((costSummary.avgDurationMs % 60000) / 1000);
      lines.push('');
      lines.push(`  Avg duration: ${avgMin}m ${avgSec}s`);
    }
    return lines.join('\n');
  }

  // API mode: existing code below
  const lines = [];
  lines.push('\u250C\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2510');
  lines.push('\u2502  COST SUMMARY' + ' '.repeat(26) + '\u2502');
  lines.push('\u251C\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2524');

  const todayStr = `  Today:      ${dollar(costSummary.today)}`;
  const weekStr =  `  This week:  ${dollar(costSummary.thisWeek)}`;
  const monthStr = `  This month: ${dollar(costSummary.thisMonth)}`;

  lines.push(`\u2502${todayStr.padEnd(40)}\u2502`);
  lines.push(`\u2502${weekStr.padEnd(40)}\u2502`);
  lines.push(`\u2502${monthStr.padEnd(40)}\u2502`);

  lines.push('\u251C\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2524');
  lines.push('\u2502  BY TIER' + ' '.repeat(31) + '\u2502');
  lines.push('\u251C\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2524');

  const simpleStr =  `  Simple:   ${dollar(costSummary.byTier?.simple)}`;
  const mediumStr =  `  Medium:   ${dollar(costSummary.byTier?.medium)}`;
  const complexStr = `  Complex:  ${dollar(costSummary.byTier?.complex)}`;

  lines.push(`\u2502${simpleStr.padEnd(40)}\u2502`);
  lines.push(`\u2502${mediumStr.padEnd(40)}\u2502`);
  lines.push(`\u2502${complexStr.padEnd(40)}\u2502`);

  lines.push('\u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2518');

  // Budget info if present
  if (costSummary.budget) {
    const b = costSummary.budget;
    lines.push('');
    lines.push('  \u2500\u2500\u2500 budget \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');
    if (b.dailyLimit != null) {
      lines.push(`  Daily:   ${dollar(costSummary.today)} / ${dollar(b.dailyLimit)}  ${progressBar(costSummary.today / b.dailyLimit)}  ${dollar(b.dailyLimit - costSummary.today)} remaining`);
    }
    if (b.weeklyLimit != null) {
      lines.push(`  Weekly:  ${dollar(costSummary.thisWeek)} / ${dollar(b.weeklyLimit)}  ${progressBar(costSummary.thisWeek / b.weeklyLimit)}  ${dollar(b.weeklyLimit - costSummary.thisWeek)} remaining`);
    }
    if (b.monthlyLimit != null) {
      lines.push(`  Monthly: ${dollar(costSummary.thisMonth)} / ${dollar(b.monthlyLimit)}  ${progressBar(costSummary.thisMonth / b.monthlyLimit)}  ${dollar(b.monthlyLimit - costSummary.thisMonth)} remaining`);
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// formatLaunchCard
// ---------------------------------------------------------------------------

/**
 * Box-drawing launch confirmation card.
 */
export function formatLaunchCard(task, estimate) {
  const lines = [];
  lines.push('\u250C\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2510');
  lines.push('\u2502  TASK LAUNCHED' + ' '.repeat(25) + '\u2502');
  lines.push('\u251C\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2524');

  const idStr = `  ID: ${shortId(task.id)}`;
  lines.push(`\u2502${idStr.padEnd(40)}\u2502`);

  if (task.project) {
    const projStr = `  Project: ${task.project}`;
    lines.push(`\u2502${projStr.padEnd(40)}\u2502`);
  }

  const promptStr = `  "${truncate(task.prompt, 36)}"`;
  lines.push(`\u2502${promptStr.padEnd(40)}\u2502`);

  if (estimate) {
    lines.push('\u251C\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2524');
    const tierStr = `  Tier: ${estimate.tier}`;
    const costStr = `  Est. cost: ${dollar(estimate.totalCost)}`;
    lines.push(`\u2502${tierStr.padEnd(40)}\u2502`);
    lines.push(`\u2502${costStr.padEnd(40)}\u2502`);
  }

  lines.push('\u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2518');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// formatReviewCard
// ---------------------------------------------------------------------------

/**
 * Review header with file table.
 */
export function formatReviewCard(task, diffInfo) {
  const lines = [];
  lines.push('\u250C\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2510');
  lines.push('\u2502  REVIEW' + ' '.repeat(32) + '\u2502');
  lines.push('\u251C\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2524');

  const idStr = `  ${shortId(task.id)}  "${truncate(task.prompt, 28)}"`;
  lines.push(`\u2502${idStr.padEnd(40)}\u2502`);

  if (diffInfo) {
    lines.push('\u251C\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2524');
    const statsStr = `  +${diffInfo.additions || 0} -${diffInfo.deletions || 0}  ${diffInfo.filesChanged || 0} files`;
    lines.push(`\u2502${statsStr.padEnd(40)}\u2502`);

    if (diffInfo.files && diffInfo.files.length > 0) {
      lines.push('\u251C\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2524');
      for (const f of diffInfo.files.slice(0, 10)) {
        const fname = truncate(typeof f === 'string' ? f : (f.name || f.path || ''), 38);
        lines.push(`\u2502  ${fname.padEnd(38)}\u2502`);
      }
      if (diffInfo.files.length > 10) {
        const moreStr = `  ... and ${diffInfo.files.length - 10} more`;
        lines.push(`\u2502${moreStr.padEnd(40)}\u2502`);
      }
    }
  }

  lines.push('\u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2518');
  return lines.join('\n');
}
