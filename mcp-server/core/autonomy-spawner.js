/**
 * Autonomy backlog spawner.
 *
 * When an autonomy run is active in `park` or `auto` mode, this module
 * top-ups the live queue by pulling the highest-priority unclaimed backlog
 * items into new tasks. It runs inside the worker-manager's promote tick
 * (~5s), so a finished task is replaced by the next backlog item within one
 * cycle.
 *
 * Safeguards:
 *   - Skipped when autonomy is off / shadow (shadow is observation-only).
 *   - Skipped when the run is halted (env, budget, lease, consecutive-failure).
 *   - Capped by `concurrencyCap - running - pending`; never queues beyond
 *     what the worker pool can absorb.
 *   - Per-tick spawn limit (`autonomy.backlogSpawnPerTick`, default 2) to
 *     stagger growth and avoid thundering-herd worktree creation.
 *   - Consumed backlog items are tagged with `consumedBy: <taskId>` and
 *     `consumedAt`, then filtered out of subsequent ticks. The audit trail
 *     stays in the backlog file; the user can prune later.
 *   - Opt-out via env (`WORKFORCE_AUTONOMY_SPAWN_BACKLOG=0`) or config
 *     (`autonomy.spawnFromBacklog: false`).
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR, ensureDir } from './constants.js';
import {
  getMode as getAutonomyMode,
  shouldHalt as autonomyShouldHalt,
  getAutonomyConfig,
  currentRun as currentAutonomyRun,
} from './autonomy-controller.js';
import { getRunningTasks, getPendingTasks } from './db.js';

const BACKLOG_PATH = join(DATA_DIR, 'backlog.json');

const PRIORITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };

function readBacklog() {
  try {
    const raw = readFileSync(BACKLOG_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    return { items: [] };
  }
}

function writeBacklog(data) {
  ensureDir(DATA_DIR);
  writeFileSync(BACKLOG_PATH, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function isOptedOut() {
  const env = process.env.WORKFORCE_AUTONOMY_SPAWN_BACKLOG;
  if (env === '0' || env === 'false' || env === 'off') return true;
  const cfg = getAutonomyConfig();
  if (cfg && cfg.spawnFromBacklog === false) return true;
  return false;
}

function pickRunnable(items) {
  return items
    .filter((i) => !i.consumedBy && !i.consumedAt)
    .sort((a, b) => {
      const pa = PRIORITY_ORDER[a.priority] ?? 99;
      const pb = PRIORITY_ORDER[b.priority] ?? 99;
      if (pa !== pb) return pa - pb;
      return (a.createdAt || '').localeCompare(b.createdAt || '');
    });
}

function buildPrompt(item) {
  const title = item.title || 'Backlog item';
  const desc = (item.description || '').trim();
  return desc ? `${title}\n\n${desc}` : title;
}

/**
 * Pull up to `slots` backlog items and create tasks for them.
 *
 * `createTask` is injected to avoid a circular import (worker-manager →
 * autonomy-spawner → task-tools → worker-manager).
 *
 * Returns an array of spawn results: `{ backlogId, taskId } | { backlogId, error }`.
 */
export async function topUpBacklog({ repoRoot, createTask, perTickCap = null } = {}) {
  if (!repoRoot || typeof createTask !== 'function') return [];
  if (isOptedOut()) return [];

  const mode = getAutonomyMode(repoRoot);
  if (mode !== 'park' && mode !== 'auto') return [];

  if (autonomyShouldHalt(repoRoot)) return [];

  const cfg = getAutonomyConfig();
  const run = currentAutonomyRun(repoRoot);
  // Under both park + auto we want a bounded queue. The controller's
  // `maxConcurrencyOverride` helper intentionally only returns for `auto`
  // (since merging is the blast-radius concern); for spawning we read the
  // run's persisted maxConcurrency directly and fall back to the config
  // default.
  const concurrencyCap = (run && Number.isFinite(run.maxConcurrency) && run.maxConcurrency > 0)
    ? run.maxConcurrency
    : (Number(cfg.maxConcurrencyOverride) > 0 ? Number(cfg.maxConcurrencyOverride) : 3);
  const running = getRunningTasks().length;
  const pending = getPendingTasks().length;
  const headroom = concurrencyCap - running - pending;
  if (headroom <= 0) return [];

  const tickCap = Number.isFinite(perTickCap) && perTickCap > 0
    ? perTickCap
    : Number(cfg.backlogSpawnPerTick || 2);
  const budget = Math.max(1, Math.min(headroom, tickCap));

  const backlog = readBacklog();
  const runnable = pickRunnable(backlog.items);
  if (runnable.length === 0) return [];

  const results = [];
  const claimed = new Set();
  for (const item of runnable.slice(0, budget)) {
    try {
      // Mark consumed BEFORE spawning so a concurrent tick (or crash mid-spawn)
      // can never double-spawn the same item.
      item.consumedAt = new Date().toISOString();
      item.consumedBy = 'pending-spawn';
      writeBacklog(backlog);
      claimed.add(item.id);

      const task = await createTask({
        prompt: buildPrompt(item),
        autoMerge: false,
      });

      item.consumedBy = task.id;
      writeBacklog(backlog);
      results.push({ backlogId: item.id, taskId: task.id });
    } catch (err) {
      // Roll back the claim so the item is retried next tick.
      item.consumedAt = undefined;
      item.consumedBy = undefined;
      delete item.consumedAt;
      delete item.consumedBy;
      writeBacklog(backlog);
      console.error(`[autonomy-spawner] failed to spawn from backlog item ${item.id}: ${err.message}`);
      results.push({ backlogId: item.id, error: err.message });
    }
  }

  return results;
}

// Test handle
export const _internals = {
  readBacklog,
  writeBacklog,
  isOptedOut,
  pickRunnable,
};
