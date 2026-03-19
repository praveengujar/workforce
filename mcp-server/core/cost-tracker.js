/**
 * Cost Tracker — enhanced cost tracking with token-level detail and JSONL log.
 *
 * Parses Claude CLI output for cost and token counts, maintains a running
 * cost log at ~/.claude/tasks/cost-log.jsonl for historical analysis.
 */

import { readFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const DATA_DIR = process.env.WORKFORCE_DATA_DIR || join(homedir(), '.claude', 'tasks');
const COST_LOG_PATH = join(DATA_DIR, 'cost-log.jsonl');

/**
 * Parse Claude CLI output for detailed cost info.
 * Looks for patterns like:
 *   - "Total cost: $1.23"
 *   - "$1.23"
 *   - "Input tokens: 1234, Output tokens: 567"
 *   - "Total tokens: 1801"
 *
 * @param {string} output - Full task output
 * @returns {{ cost: number|null, inputTokens: number|null, outputTokens: number|null }}
 */
export function parseDetailedCost(output) {
  const result = { cost: null, inputTokens: null, outputTokens: null };
  if (!output) return result;

  // Cost extraction - take last match
  const costMatches = output.match(/\$(\d+\.\d{2})/g);
  if (costMatches && costMatches.length > 0) {
    result.cost = parseFloat(costMatches[costMatches.length - 1].replace('$', ''));
  }

  // Token extraction
  const inputMatch = output.match(/[Ii]nput\s*tokens?[:\s]+(\d[\d,]*)/);
  if (inputMatch) result.inputTokens = parseInt(inputMatch[1].replace(/,/g, ''), 10);

  const outputMatch = output.match(/[Oo]utput\s*tokens?[:\s]+(\d[\d,]*)/);
  if (outputMatch) result.outputTokens = parseInt(outputMatch[1].replace(/,/g, ''), 10);

  return result;
}

/**
 * Append a cost record to the JSONL log.
 *
 * @param {{ taskId: string, project?: string, cost?: number, tier?: string, inputTokens?: number, outputTokens?: number }} entry
 */
export function appendCostLog(entry) {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  const line = JSON.stringify({
    ...entry,
    timestamp: new Date().toISOString(),
  });
  appendFileSync(COST_LOG_PATH, line + '\n', 'utf8');
}

/**
 * Read recent cost log entries.
 * @param {number} limit - Max entries to return (default 100)
 * @returns {Array<object>}
 */
export function readCostLog(limit = 100) {
  if (!existsSync(COST_LOG_PATH)) return [];
  try {
    const lines = readFileSync(COST_LOG_PATH, 'utf8').trim().split('\n').filter(Boolean);
    const start = Math.max(0, lines.length - limit);
    return lines.slice(start).map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Get cost summary from the detailed log for a date range.
 *
 * @param {string} [startDate] - ISO 8601 lower bound (inclusive)
 * @param {string} [endDate] - ISO 8601 upper bound (inclusive)
 * @returns {{ totalCost: number, totalTasks: number, avgCost: number, totalInputTokens: number, totalOutputTokens: number }}
 */
export function getCostLogSummary(startDate, endDate) {
  const entries = readCostLog(1000);
  const filtered = entries.filter(e => {
    if (startDate && e.timestamp < startDate) return false;
    if (endDate && e.timestamp > endDate) return false;
    return true;
  });

  const totalCost = filtered.reduce((sum, e) => sum + (e.cost || 0), 0);
  const totalInputTokens = filtered.reduce((sum, e) => sum + (e.inputTokens || 0), 0);
  const totalOutputTokens = filtered.reduce((sum, e) => sum + (e.outputTokens || 0), 0);

  return {
    totalCost: Math.round(totalCost * 100) / 100,
    totalTasks: filtered.length,
    avgCost: filtered.length > 0 ? Math.round((totalCost / filtered.length) * 100) / 100 : 0,
    totalInputTokens,
    totalOutputTokens,
  };
}
