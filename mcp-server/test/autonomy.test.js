/**
 * Autonomy tests — controller lease, policy verdicts, gate substitution,
 * halt semantics, notifier outbox.
 *
 * Uses node:test. The controller + db helpers touch the singleton sqlite DB
 * under DATA_DIR; we work in unique repoRoot paths and unique runIds so we
 * don't collide with the user's real autonomy state.
 *
 * Run: node --test mcp-server/test/autonomy.test.js
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { evaluate } from '../core/autonomy-policy.js';
import {
  startRun, endRun, heartbeat, currentRun, getMode, isAutonomyEnabled,
  shouldHalt, setHalt, clearHalt, maxConcurrencyOverride, policyVersion, configHash,
} from '../core/autonomy-controller.js';
import {
  enqueueNotification, listPendingNotifications, markNotificationDelivered, getDb,
  listOutboxByRun,
} from '../core/db.js';
import { _internals as notifInternals, notify } from '../core/notifier.js';

function makeRepoRoot() {
  return mkdtempSync(join(tmpdir(), 'wf-autonomy-test-'));
}

// ---------------------------------------------------------------------------
// Policy evaluation
// ---------------------------------------------------------------------------
describe('autonomy-policy.evaluate', () => {
  it('returns auto-approve on clean small change with all checks pass', () => {
    const v = evaluate({
      reviewScore: 90, securityScore: 100,
      additions: 30, deletions: 5,
      files: ['src/foo.js', 'src/bar.js'],
      targetBranch: 'autonomous/staging/abc',
      budget: { exceeded: false },
      tests: { passed: true },
      freshness: { behindBase: 0, conflictsDetected: false, upstreamProtectedTouched: false, dependsOnReverted: false, maxBehind: 10 },
      promotedRules: 0,
    });
    assert.equal(v.decision, 'auto-approve');
    for (const v2 of Object.values(v.checks)) assert.equal(v2, 'pass');
    assert.ok(v.policyVersion);
    assert.ok(v.configHash);
    assert.ok(v.evaluatedAt);
  });

  it('parks tiny payments-touching changes regardless of size', () => {
    const v = evaluate({
      reviewScore: 95, securityScore: 100,
      additions: 5, deletions: 0,
      files: ['src/payments/charge.js'],
      targetBranch: 'autonomous/staging/abc',
      budget: { exceeded: false },
      tests: { passed: true },
      freshness: { behindBase: 0, conflictsDetected: false, upstreamProtectedTouched: false, dependsOnReverted: false, maxBehind: 10 },
      promotedRules: 0,
    });
    assert.equal(v.decision, 'park-for-human');
    assert.equal(v.checks.blastRadius, 'fail');
    assert.ok(v.reasons.some((r) => r.includes('payments')));
  });

  it('parks on merge conflicts detected', () => {
    const v = evaluate({
      reviewScore: 90, securityScore: 100,
      additions: 10, deletions: 1, files: ['src/x.js'],
      targetBranch: 'autonomous/staging/abc',
      budget: { exceeded: false },
      tests: { passed: true },
      freshness: { behindBase: 0, conflictsDetected: true, upstreamProtectedTouched: false, dependsOnReverted: false, maxBehind: 10 },
      promotedRules: 0,
    });
    assert.equal(v.decision, 'park-for-human');
    assert.equal(v.checks.freshness, 'fail');
  });

  it('auto-rejects on zero security score', () => {
    const v = evaluate({
      reviewScore: 90, securityScore: 0,
      additions: 10, deletions: 1, files: ['src/x.js'],
      targetBranch: 'autonomous/staging/abc',
      budget: { exceeded: false },
      tests: { passed: true },
      freshness: { behindBase: 0, conflictsDetected: false, upstreamProtectedTouched: false, dependsOnReverted: false, maxBehind: 10 },
      promotedRules: 0,
    });
    assert.equal(v.decision, 'auto-reject');
  });

  it('parks when freshness data missing', () => {
    const v = evaluate({
      reviewScore: 90, securityScore: 100,
      additions: 10, deletions: 1, files: ['src/x.js'],
      targetBranch: 'autonomous/staging/abc',
      budget: { exceeded: false },
      tests: { passed: true },
      promotedRules: 0,
    });
    assert.equal(v.decision, 'park-for-human');
    assert.equal(v.checks.freshness, 'fail');
  });

  it('parks when knowledge rules were promoted during run', () => {
    const v = evaluate({
      reviewScore: 95, securityScore: 100,
      additions: 5, deletions: 0, files: ['src/safe.js'],
      targetBranch: 'autonomous/staging/abc',
      budget: { exceeded: false },
      tests: { passed: true },
      freshness: { behindBase: 0, conflictsDetected: false, upstreamProtectedTouched: false, dependsOnReverted: false, maxBehind: 10 },
      promotedRules: 1,
    });
    assert.equal(v.decision, 'park-for-human');
    assert.equal(v.checks.knowledgeWrites, 'fail');
  });
});

// ---------------------------------------------------------------------------
// Controller: lease + mode + halt
// ---------------------------------------------------------------------------
describe('autonomy-controller lease + halt', () => {
  let repoRoot;
  let runId;

  beforeEach(() => {
    repoRoot = makeRepoRoot();
    delete process.env.WORKFORCE_AUTONOMY;
  });

  afterEach(() => {
    if (runId) {
      try { endRun(runId, 'test_cleanup'); } catch { /* ignore */ }
      runId = null;
    }
    try { rmSync(repoRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('refuses a second active run for the same repo', () => {
    const r1 = startRun({ repoRoot, mode: 'shadow', baseBranch: 'main' });
    runId = r1.runId;
    assert.throws(() => startRun({ repoRoot, mode: 'shadow', baseBranch: 'main' }),
      /already active/);
  });

  it('allows force takeover of an existing lease', () => {
    const r1 = startRun({ repoRoot, mode: 'shadow', baseBranch: 'main' });
    const r2 = startRun({ repoRoot, mode: 'shadow', baseBranch: 'main', force: true });
    runId = r2.runId;
    assert.notEqual(r1.runId, r2.runId);
    // r1 is now ended
    const all = getDb().prepare('SELECT * FROM autonomy_runs WHERE runId = ?').get(r1.runId);
    assert.equal(all.status, 'ended');
    assert.equal(all.endReason, 'force_takeover');
  });

  it('getMode returns the active run mode', () => {
    const r = startRun({ repoRoot, mode: 'park', baseBranch: 'main' });
    runId = r.runId;
    assert.equal(getMode(repoRoot), 'park');
    assert.equal(isAutonomyEnabled(repoRoot), true);
  });

  it('env WORKFORCE_AUTONOMY=halt forces halt regardless of run state', () => {
    const r = startRun({ repoRoot, mode: 'auto', baseBranch: 'main' });
    runId = r.runId;
    process.env.WORKFORCE_AUTONOMY = 'halt';
    assert.equal(shouldHalt(repoRoot), 'env_halt');
    delete process.env.WORKFORCE_AUTONOMY;
  });

  it('shouldHalt returns null in shadow mode even with halt reason on run', () => {
    const r = startRun({ repoRoot, mode: 'shadow', baseBranch: 'main' });
    runId = r.runId;
    setHalt(r.runId, 'some_reason');
    // shadow is never halted — observation only
    assert.equal(shouldHalt(repoRoot), null);
  });

  it('setHalt/clearHalt cycle on a live run', () => {
    const r = startRun({ repoRoot, mode: 'auto', baseBranch: 'main' });
    runId = r.runId;
    assert.equal(shouldHalt(repoRoot), null);
    setHalt(r.runId, 'manual_test');
    assert.equal(shouldHalt(repoRoot), 'manual_test');
    clearHalt(r.runId);
    assert.equal(shouldHalt(repoRoot), null);
  });

  it('maxConcurrencyOverride returns configured cap under auto', () => {
    const r = startRun({ repoRoot, mode: 'auto', baseBranch: 'main', maxConcurrency: 2 });
    runId = r.runId;
    assert.equal(maxConcurrencyOverride(repoRoot), 2);
  });

  it('maxConcurrencyOverride returns null for shadow/park', () => {
    const r = startRun({ repoRoot, mode: 'park', baseBranch: 'main', maxConcurrency: 2 });
    runId = r.runId;
    assert.equal(maxConcurrencyOverride(repoRoot), null);
  });

  it('heartbeat extends lease', () => {
    const r = startRun({ repoRoot, mode: 'shadow', baseBranch: 'main' });
    runId = r.runId;
    const before = r.leaseExpiresAt;
    // wait a tick
    const updated = heartbeat(r.runId);
    assert.ok(updated.leaseExpiresAt >= before);
  });

  it('policy version + config hash are stable strings', () => {
    assert.equal(typeof policyVersion(), 'string');
    assert.equal(typeof configHash(), 'string');
    assert.equal(policyVersion().length > 0, true);
    assert.equal(configHash().length, 16);
  });
});

// ---------------------------------------------------------------------------
// Notifier outbox
// ---------------------------------------------------------------------------
describe('notifier outbox', () => {
  beforeEach(() => {
    // Clean outbox to keep tests isolated
    getDb().prepare('DELETE FROM notification_outbox').run();
  });

  it('notify() writes rows synchronously, one per channel', () => {
    notify({
      subject: 'test outbox',
      body: 'body',
      severity: 'info',
      channels: ['unknown-channel-a', 'unknown-channel-b'],
    });
    const pending = listPendingNotifications();
    assert.equal(pending.length, 2);
    const channels = pending.map((p) => p.channel).sort();
    assert.deepEqual(channels, ['unknown-channel-a', 'unknown-channel-b']);
  });

  it('drainOnce delivers unknown-channel rows as no-op (marks delivered)', async () => {
    notify({ subject: 'x', channels: ['noop-test-channel'] });
    assert.equal(listPendingNotifications().length, 1);
    await notifInternals.drainOnce();
    assert.equal(listPendingNotifications().length, 0);
  });

  it('backoffMs is exponential up to a 30-min cap', () => {
    const m1 = notifInternals.backoffMs(1);
    const m3 = notifInternals.backoffMs(3);
    const m99 = notifInternals.backoffMs(99);
    assert.ok(m1 < m3);
    assert.equal(m99, 30 * 60 * 1000);
  });
});

// ---------------------------------------------------------------------------
// Staging branch helper (uses real git in a tmp repo)
// ---------------------------------------------------------------------------
describe('ensureStagingBranch', () => {
  let repoRoot;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'wf-staging-test-'));
    execFileSync('git', ['init', '-q'], { cwd: repoRoot });
    execFileSync('git', ['commit', '--allow-empty', '-m', 'init', '-q'], { cwd: repoRoot });
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('creates branch from base; idempotent on re-call', async () => {
    const { ensureStagingBranch } = await import('../core/worker-manager.js');
    const r1 = ensureStagingBranch({
      repoRoot,
      baseBranch: 'main',
      stagingBranch: 'autonomous/staging/test-1',
    });
    assert.equal(r1.created, true);
    const r2 = ensureStagingBranch({
      repoRoot,
      baseBranch: 'main',
      stagingBranch: 'autonomous/staging/test-1',
    });
    assert.equal(r2.created, false);
  });
});
