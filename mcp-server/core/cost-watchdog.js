/**
 * Cost Watchdog — monitors running tasks for mid-execution cost overruns.
 *
 * Periodically scans tmux output for cost indicators (Claude CLI prints
 * running cost like `$X.XX`). Kills the task if actual cost exceeds
 * 2x the estimated cost.
 */

import { getRunningTasks, getTask, updateTask } from './db.js';
import { logEvent } from './task-events.js';
import { estimateTaskCost } from './task-cost.js';
import { capturePane, killSession, hasSession } from './tmux.js';
import { cancelTask as cancelTaskToken } from './project-state.js';

const COST_MULTIPLIER_LIMIT = 2.0;   // Kill if actual > 2x estimated
const SCAN_INTERVAL_MS = 15_000;      // Check every 15 seconds

let _intervalId = null;

/**
 * Extract current cost from tmux pane output.
 * Claude CLI periodically prints cost like: "Total cost: $1.23" or just "$1.23"
 * Look for the LAST occurrence of a dollar amount in the output.
 *
 * @param {string} output - Tmux pane content
 * @returns {number|null} - Extracted cost or null
 */
export function extractCostFromOutput(output) {
  if (!output) return null;
  // Match patterns like "$1.23", "cost: $1.23", "$0.05"
  const matches = output.match(/\$(\d+\.\d{2})/g);
  if (!matches || matches.length === 0) return null;
  // Take the last match (most recent cost report)
  const lastMatch = matches[matches.length - 1];
  const cost = parseFloat(lastMatch.replace('$', ''));
  return isNaN(cost) ? null : cost;
}

/**
 * Run a single cost watchdog scan across all running tasks.
 * Returns array of actions taken.
 */
export function runCostWatchdogScan() {
  const running = getRunningTasks();
  const actions = [];

  for (const task of running) {
    if (!task.tmuxSession || !hasSession(task.tmuxSession)) continue;

    // Capture current output
    const output = capturePane(task.tmuxSession);
    const currentCost = extractCostFromOutput(output);
    if (currentCost === null) continue;

    // Get estimated cost
    const estimate = estimateTaskCost(task.prompt, task.retryCount || 0);
    const limit = estimate.totalCost * COST_MULTIPLIER_LIMIT;

    if (currentCost > limit) {
      // KILL the task
      console.error(`[cost-watchdog] Task ${task.id} cost $${currentCost.toFixed(2)} exceeds ${COST_MULTIPLIER_LIMIT}x estimate ($${estimate.totalCost.toFixed(2)}). Killing.`);

      killSession(task.tmuxSession);
      cancelTaskToken(task.id);

      updateTask(task.id, {
        status: 'failed',
        error: `Cost watchdog: actual $${currentCost.toFixed(2)} exceeded ${COST_MULTIPLIER_LIMIT}x estimate of $${estimate.totalCost.toFixed(2)}`,
        cost: currentCost,
        completedAt: new Date().toISOString(),
      });
      logEvent(task.id, 'failed', `Cost watchdog killed — $${currentCost.toFixed(2)} > limit $${limit.toFixed(2)}`);

      actions.push({
        taskId: task.id,
        currentCost,
        estimatedCost: estimate.totalCost,
        limit,
        action: 'killed',
      });
    } else if (currentCost > estimate.totalCost) {
      // Log warning but don't kill yet
      const pct = Math.round((currentCost / limit) * 100);
      if (pct > 75) {
        console.error(`[cost-watchdog] Task ${task.id} at $${currentCost.toFixed(2)} (${pct}% of kill threshold)`);
        logEvent(task.id, 'cost_warning', `$${currentCost.toFixed(2)} — ${pct}% of kill threshold $${limit.toFixed(2)}`);
      }
    }
  }

  return actions;
}

/**
 * Start the cost watchdog on a 15-second interval.
 * Returns a cleanup function.
 */
export function startCostWatchdog() {
  console.error(`[cost-watchdog] Started (interval: ${SCAN_INTERVAL_MS / 1000}s, kill at ${COST_MULTIPLIER_LIMIT}x estimate)`);

  _intervalId = setInterval(() => {
    try {
      runCostWatchdogScan();
    } catch (err) {
      console.error('[cost-watchdog] scan error:', err.message);
    }
  }, SCAN_INTERVAL_MS);

  return function stopCostWatchdog() {
    if (_intervalId) {
      clearInterval(_intervalId);
      _intervalId = null;
    }
    console.error('[cost-watchdog] Stopped');
  };
}

/**
 * Run a manual scan (for MCP tool invocation).
 */
export function manualCostWatchdogScan() {
  return runCostWatchdogScan();
}
