/**
 * Experiment tool handlers — MCP tool functions for iterative experiments.
 * Pure functions that return plain objects or pre-formatted text.
 */

import {
  createExperiment,
  getExperimentStatus,
  stopExperiment,
  listExperiments,
} from '../core/experiment-runner.js';
import { sparkline } from './sparkline.js';
import { shortId, truncate, elapsed, dollar, statusIcon } from './formatters.js';

// ---------------------------------------------------------------------------
// createExperimentHandler
// ---------------------------------------------------------------------------
export async function createExperimentHandler({
  prompt,
  project,
  measure_command,
  metric_pattern,
  metric_name,
  direction,
  target_value,
  max_iterations,
  iteration_timeout_ms,
  budget_limit,
}) {
  const config = await createExperiment({
    prompt,
    project,
    measureCommand: measure_command,
    metricPattern: metric_pattern,
    metricName: metric_name,
    direction,
    targetValue: target_value,
    maxIterations: max_iterations,
    iterationTimeoutMs: iteration_timeout_ms,
    budgetLimit: budget_limit,
  });

  return config;
}

// ---------------------------------------------------------------------------
// experimentStatusHandler — returns pre-formatted text
// ---------------------------------------------------------------------------
export function experimentStatusHandler({ experiment_id }) {
  const status = getExperimentStatus(experiment_id);
  return formatExperimentStatus(status);
}

// ---------------------------------------------------------------------------
// stopExperimentHandler
// ---------------------------------------------------------------------------
export function stopExperimentHandler({ experiment_id }) {
  return stopExperiment(experiment_id);
}

// ---------------------------------------------------------------------------
// listExperimentsHandler — returns pre-formatted text
// ---------------------------------------------------------------------------
export function listExperimentsHandler() {
  const experiments = listExperiments();
  return formatExperimentList(experiments);
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

/**
 * Format a full experiment status display.
 */
function formatExperimentStatus(status) {
  const lines = [];

  lines.push(`\u2501\u2501\u2501 EXPERIMENT: ${shortId(status.id)} \u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501`);
  lines.push(`Objective: ${status.prompt}`);

  const targetStr = status.targetValue != null ? `  Target: ${status.targetValue}` : '';
  const bestStr = status.bestMetric != null ? status.bestMetric : '--';
  lines.push(`Metric: ${status.metricName} (${status.direction})  Best: ${bestStr}${targetStr}`);

  const progressStr = `${status.currentIteration || 0}/${status.maxIterations}`;
  lines.push(`Progress: ${progressStr}  Cost: ${dollar(status.totalCost)}  Status: ${statusIcon(status.status)} ${status.status}`);

  if (status.stopReason) {
    lines.push(`Reason: ${status.stopReason}`);
  }

  const iterations = status.iterations || [];

  if (iterations.length > 0) {
    lines.push('');
    lines.push('ITERATIONS');

    // Table header
    lines.push('\u250C\u2500\u2500\u2500\u2500\u2500\u252C\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u252C\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u252C\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u252C\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2510');
    lines.push('\u2502  #  \u2502   Metric   \u2502  Status  \u2502  Cost  \u2502 Description                  \u2502');
    lines.push('\u251C\u2500\u2500\u2500\u2500\u2500\u253C\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u253C\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u253C\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u253C\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2524');

    for (const iter of iterations) {
      const num = String(iter.iteration).padStart(3);
      const metric = iter.metricValue != null
        ? String(iter.metricValue).slice(0, 10).padStart(10)
        : '       N/A';
      const st = iter.kept ? '\u2713 kept  ' : '\u2717 revert';
      const cost = dollar(iter.cost).padStart(6);
      const desc = truncate(iter.description || '', 28);
      lines.push(`\u2502 ${num} \u2502 ${metric} \u2502 ${st} \u2502 ${cost} \u2502 ${desc.padEnd(28)} \u2502`);
    }

    lines.push('\u2514\u2500\u2500\u2500\u2500\u2500\u2534\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2534\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2534\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2534\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2518');

    // Trend sparkline
    const metricValues = iterations
      .map(i => i.metricValue)
      .filter(v => v != null);

    if (metricValues.length >= 2) {
      const trend = sparkline(metricValues, Math.min(metricValues.length, 20));
      const improving = isImproving(metricValues, status.direction);
      lines.push('');
      lines.push(`Trend: ${trend}  (${improving ? 'improving' : 'stalling'})`);
    }
  } else {
    lines.push('');
    lines.push('No iterations completed yet.');
  }

  return lines.join('\n');
}

/**
 * Format a list of all experiments.
 */
function formatExperimentList(experiments) {
  if (!experiments || experiments.length === 0) {
    return 'No experiments found.';
  }

  const lines = [];
  lines.push('\u2501\u2501\u2501 EXPERIMENTS \u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501');
  lines.push('');

  for (const exp of experiments) {
    const icon = statusIcon(exp.status);
    const id = shortId(exp.id);
    const progress = `${exp.currentIteration || 0}/${exp.maxIterations}`;
    const best = exp.bestMetric != null ? `best=${exp.bestMetric}` : 'no data';
    const cost = dollar(exp.totalCost);
    const time = elapsed(exp.createdAt);
    const prompt = truncate(exp.prompt, 40);

    lines.push(`  ${icon} ${id}  ${exp.status.padEnd(10)} ${progress.padEnd(6)} ${best.padEnd(18)} ${cost.padEnd(8)} ${time}`);
    lines.push(`    "${prompt}"`);
    lines.push('');
  }

  lines.push(`  Total: ${experiments.length} experiment(s)`);
  return lines.join('\n');
}

/**
 * Check if metric values show improvement trend.
 */
function isImproving(values, direction) {
  if (values.length < 3) return false;
  const recent = values.slice(-3);
  const older = values.slice(-6, -3);

  if (older.length === 0) {
    // Compare last vs first
    return direction === 'minimize'
      ? recent[recent.length - 1] < values[0]
      : recent[recent.length - 1] > values[0];
  }

  const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
  const olderAvg = older.reduce((a, b) => a + b, 0) / older.length;

  return direction === 'minimize' ? recentAvg < olderAvg : recentAvg > olderAvg;
}
