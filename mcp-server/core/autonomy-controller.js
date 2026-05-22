/**
 * Autonomy Controller — single source of truth for autonomy state.
 *
 * Modes:
 *   - 'off'    : no policy decisions, normal human gates
 *   - 'shadow' : policy evaluates and logs only; no actions
 *   - 'park'   : policy can park/reject, but cannot merge
 *   - 'auto'   : policy can approve into staging only
 *
 * Resolution order for the active mode:
 *   1. WORKFORCE_AUTONOMY env (highest precedence; supports 'halt' kill switch)
 *   2. The most recent active autonomy_run row for this repoRoot
 *   3. config/defaults.json -> autonomy.mode
 *   4. 'off'
 *
 * Halt conditions (shouldHalt() returns reason or null):
 *   - WORKFORCE_AUTONOMY=halt
 *   - run.haltReason set
 *   - lease expired
 *   - consecutive-failure threshold exceeded
 *   - nightly budget cap exceeded
 *
 * The controller is stateless across calls — every method reads the DB so
 * external `workforce-autonomy stop` from a sibling process is observed.
 */

import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  getActiveAutonomyRun,
  getAutonomyRun,
  insertAutonomyRun,
  updateAutonomyRun,
  getCostForPeriod,
} from './db.js';

export const AUTONOMY_MODES = Object.freeze(['off', 'shadow', 'park', 'auto']);
const FALLBACK_MODE = 'off';

let _cachedConfig = null;

function loadConfig() {
  if (_cachedConfig) return _cachedConfig;
  try {
    const here = fileURLToPath(new URL('.', import.meta.url));
    const cfgPath = join(here, '..', 'config', 'defaults.json');
    const raw = readFileSync(cfgPath, 'utf8');
    const parsed = JSON.parse(raw);
    _cachedConfig = (parsed && parsed.autonomy) || {};
  } catch {
    _cachedConfig = {};
  }
  return _cachedConfig;
}

export function getAutonomyConfig() {
  return loadConfig();
}

export function configHash() {
  const cfg = loadConfig();
  return createHash('sha256').update(JSON.stringify(cfg)).digest('hex').slice(0, 16);
}

export function policyVersion() {
  return loadConfig().policyVersion || 'unversioned';
}

/**
 * Resolve the active mode for this repoRoot.
 *
 * Env override 'halt' is reported as the mode of the most recent run (or
 * config fallback) — callers should also consult shouldHalt() to decide
 * whether to act.
 */
export function getMode(repoRoot) {
  const env = process.env.WORKFORCE_AUTONOMY;
  if (env === 'off' || env === 'shadow' || env === 'park' || env === 'auto') {
    return env;
  }
  if (repoRoot) {
    const run = getActiveAutonomyRun(repoRoot);
    if (run && run.mode && AUTONOMY_MODES.includes(run.mode)) return run.mode;
  }
  const cfg = loadConfig();
  if (cfg.mode && AUTONOMY_MODES.includes(cfg.mode)) return cfg.mode;
  return FALLBACK_MODE;
}

export function isAutonomyEnabled(repoRoot) {
  const m = getMode(repoRoot);
  return m === 'shadow' || m === 'park' || m === 'auto';
}

export function isAutonomousMerge(repoRoot) {
  return getMode(repoRoot) === 'auto';
}

/**
 * Return halt reason string, or null if not halted.
 *
 * NOTE: shadow mode is never blocked by halt — shadow is observation only and
 * should keep logging verdicts even when the live system is paused. Live
 * modes (park, auto) honor halt.
 */
export function shouldHalt(repoRoot) {
  if (process.env.WORKFORCE_AUTONOMY === 'halt') return 'env_halt';

  const mode = getMode(repoRoot);
  if (mode === 'off' || mode === 'shadow') return null;

  if (!repoRoot) return null;
  const run = getActiveAutonomyRun(repoRoot);
  if (!run) return null; // no active run; nothing to halt against

  if (run.haltReason) return run.haltReason;

  const cfg = loadConfig();

  if (run.leaseExpiresAt) {
    const exp = Date.parse(run.leaseExpiresAt);
    if (Number.isFinite(exp) && exp < Date.now()) return 'lease_expired';
  }

  const threshold = Number(cfg.consecutiveFailureThreshold || 0);
  if (threshold > 0 && (run.consecutiveFailures || 0) >= threshold) {
    return 'consecutive_failures';
  }

  if (run.budgetCapUsd != null) {
    const spent = getCostForPeriod('global', run.startedAt, new Date().toISOString());
    if (spent >= run.budgetCapUsd) return 'budget_exceeded';
  }

  return null;
}

export function currentRun(repoRoot) {
  if (!repoRoot) return null;
  return getActiveAutonomyRun(repoRoot);
}

export function maxConcurrencyOverride(repoRoot) {
  if (!isAutonomousMerge(repoRoot)) return null;
  const run = currentRun(repoRoot);
  if (run && Number.isFinite(run.maxConcurrency) && run.maxConcurrency > 0) {
    return run.maxConcurrency;
  }
  const cfg = loadConfig();
  return Number(cfg.maxConcurrencyOverride || 0) || null;
}

// ---------------------------------------------------------------------------
// Lease + lifecycle
// ---------------------------------------------------------------------------

function nowIso() { return new Date().toISOString(); }

function expiryIso(timeoutMs) {
  return new Date(Date.now() + Number(timeoutMs || 120_000)).toISOString();
}

/**
 * Start a new autonomy run. Throws if a fresh active lease already exists
 * (callers must pass force=true to take over a stale lease).
 */
export function startRun({
  repoRoot,
  mode,
  baseBranch,
  budgetCapUsd = null,
  maxConcurrency = null,
  snapshot = null,
  force = false,
}) {
  if (!repoRoot) throw new Error('startRun requires repoRoot');
  if (!AUTONOMY_MODES.includes(mode)) throw new Error(`invalid mode: ${mode}`);
  if (mode === 'off') throw new Error('cannot start a run in mode=off');

  const existing = getActiveAutonomyRun(repoRoot);
  if (existing) {
    const exp = Date.parse(existing.leaseExpiresAt || '');
    const fresh = Number.isFinite(exp) && exp > Date.now();
    if (fresh && !force) {
      const err = new Error(
        `autonomy run already active for ${repoRoot} (runId=${existing.runId}, pid=${existing.ownerPid})`,
      );
      err.code = 'LEASE_HELD';
      err.existing = existing;
      throw err;
    }
    if (existing) {
      updateAutonomyRun(existing.runId, {
        status: 'ended',
        endedAt: nowIso(),
        endReason: force ? 'force_takeover' : 'stale_lease_replaced',
      });
    }
  }

  const cfg = loadConfig();
  const runId = randomUUID();
  const startedAt = nowIso();
  const stagingBranch = `${cfg.stagingBranchPrefix || 'autonomous/staging'}/${runId}`;

  insertAutonomyRun({
    runId,
    repoRoot,
    mode,
    status: 'active',
    ownerPid: process.pid,
    heartbeatAt: startedAt,
    leaseExpiresAt: expiryIso(cfg.leaseTimeoutMs),
    stagingBranch,
    baseBranch: baseBranch || 'main',
    budgetCapUsd,
    maxConcurrency: maxConcurrency ?? cfg.maxConcurrencyOverride ?? null,
    policyVersion: policyVersion(),
    configHash: configHash(),
    snapshot: snapshot ? JSON.stringify(snapshot) : null,
    consecutiveFailures: 0,
    startedAt,
  });

  return getAutonomyRun(runId);
}

export function heartbeat(runId) {
  if (!runId) return null;
  const cfg = loadConfig();
  return updateAutonomyRun(runId, {
    heartbeatAt: nowIso(),
    leaseExpiresAt: expiryIso(cfg.leaseTimeoutMs),
  });
}

export function endRun(runId, reason = 'stopped') {
  return updateAutonomyRun(runId, {
    status: 'ended',
    endedAt: nowIso(),
    endReason: reason,
  });
}

export function setHalt(runId, reason) {
  return updateAutonomyRun(runId, { haltReason: reason });
}

export function clearHalt(runId) {
  return updateAutonomyRun(runId, { haltReason: null });
}

export function recordConsecutiveFailure(runId, currentValue) {
  return updateAutonomyRun(runId, { consecutiveFailures: (currentValue || 0) + 1 });
}

export function resetConsecutiveFailures(runId) {
  return updateAutonomyRun(runId, { consecutiveFailures: 0 });
}

// ---------------------------------------------------------------------------
// Test-only handles
// ---------------------------------------------------------------------------

export const _internals = {
  resetConfigCache() { _cachedConfig = null; },
};
