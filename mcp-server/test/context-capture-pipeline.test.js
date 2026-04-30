/**
 * Tests for Context Fabric M7 — capture pipeline.
 *
 * Run: node --test mcp-server/test/context-capture-pipeline.test.js
 *
 * Uses a per-process WORKFORCE_DATA_DIR pointed at a temp directory so the
 * shared `getDb()` singleton writes to throwaway storage.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP_DIR = mkdtempSync(join(tmpdir(), 'm7-capture-test-'));
process.env.WORKFORCE_DATA_DIR = TMP_DIR;

const dbMod = await import('../core/db.js');
const cpMod = await import('../core/context-capture-pipeline.js');
const evalMod = await import('../core/eval-engine.js');

const { getDb, applyMigration18 } = dbMod;
const {
  captureFailureEpisode,
  detectDecisions,
  captureDecisionsFromTask,
  detectRiskTerms,
  captureRisksFromTask,
  proposeRuleFromEvalCluster,
  listProposedRules,
} = cpMod;
const { createEval } = evalMod;

function resetTables() {
  const db = getDb();
  db['exec']('DELETE FROM episodic_memory');
  db['exec']('DELETE FROM context_items');
  db['exec']('DELETE FROM proposed_rules');
  db['exec']('DELETE FROM eval_logs');
}

function makeFailedTask(overrides = {}) {
  return {
    id: overrides.id || `fail-${Math.random().toString(36).slice(2, 10)}`,
    project: 'demo',
    prompt: 'Patch the rate-limit retry to use exponential backoff',
    branch: overrides.branch || 'wf/test-fail',
    targetBranch: 'main',
    taskType: 'standard',
    status: 'rejected',
    error: 'Reviewer rejected: backoff multiplier was wrong',
    retryCount: 1,
    ...overrides,
  };
}

function failingSummarizer() { return null; }

before(() => { getDb(); });
after(() => {
  try { rmSync(TMP_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------
// Migration 18 — idempotent
// ---------------------------------------------------------------------------

describe('migration 18', () => {
  it('creates proposed_rules table with required columns and indexes', () => {
    const db = getDb();
    const cols = db.prepare('PRAGMA table_info(proposed_rules)').all().map(c => c.name);
    for (const col of [
      'id', 'project', 'source_type', 'source_id',
      'draft_category', 'draft_name', 'draft_paths', 'draft_content',
      'evidence', 'trust_score', 'status', 'authored_by',
      'reviewed_by', 'reviewed_at', 'created_at',
    ]) {
      assert.ok(cols.includes(col), `column ${col} missing`);
    }
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='proposed_rules'").all().map(r => r.name);
    assert.ok(indexes.includes('idx_proposed_rules_project'));
    assert.ok(indexes.includes('idx_proposed_rules_status'));
    assert.ok(indexes.includes('idx_proposed_rules_created_at'));
  });

  it('is idempotent — re-running applyMigration18 does not throw', () => {
    const db = getDb();
    assert.doesNotThrow(() => applyMigration18(db));
    assert.doesNotThrow(() => applyMigration18(db));
  });
});

// ---------------------------------------------------------------------------
// captureFailureEpisode
// ---------------------------------------------------------------------------

describe('captureFailureEpisode', () => {
  it('writes an episodic_memory row with outcome=failure and trust=0.5', () => {
    resetTables();
    const task = makeFailedTask({ id: 'fe-1' });
    const row = captureFailureEpisode({ task, repoRoot: TMP_DIR, summarizer: failingSummarizer });
    assert.ok(row, 'row not returned');
    assert.equal(row.project, 'demo');
    assert.equal(row.task_id, 'fe-1');
    assert.equal(row.outcome, 'failure');
    assert.equal(row.trust_score, 0.5);
    assert.match(row.approach_summary, /Failure:/);
  });

  it('is idempotent on (project, task_id)', () => {
    resetTables();
    const task = makeFailedTask({ id: 'fe-idem' });
    const a = captureFailureEpisode({ task, repoRoot: TMP_DIR, summarizer: failingSummarizer });
    const b = captureFailureEpisode({ task, repoRoot: TMP_DIR, summarizer: failingSummarizer });
    assert.equal(a.id, b.id);
    const count = getDb().prepare(
      'SELECT COUNT(*) AS n FROM episodic_memory WHERE project=? AND task_id=?',
    ).get('demo', 'fe-idem').n;
    assert.equal(count, 1);
  });

  it('returns null without throwing on null/missing task', () => {
    let r;
    assert.doesNotThrow(() => { r = captureFailureEpisode({ task: null }); });
    assert.equal(r, null);
    assert.doesNotThrow(() => { r = captureFailureEpisode({ task: { id: '' } }); });
    assert.equal(r, null);
  });
});

// ---------------------------------------------------------------------------
// detectDecisions
// ---------------------------------------------------------------------------

describe('detectDecisions', () => {
  it('matches anchored decision phrases', () => {
    const text = [
      'We decided to migrate to PostgreSQL.',
      'The team chose option B over option A.',
      'Decision: ship the feature behind a flag.',
      'They picked Redis for the cache.',
      'We rejected the WebSocket proposal.',
    ].join('\n');
    const out = detectDecisions(text);
    const titles = out.map(d => d.title);
    assert.ok(titles.some(t => /decided to migrate/i.test(t)));
    assert.ok(titles.some(t => /chose option B/i.test(t)));
    assert.ok(titles.some(t => /Decision:/i.test(t)));
    assert.ok(titles.some(t => /picked Redis/i.test(t)));
    assert.ok(titles.some(t => /rejected the WebSocket/i.test(t)));
    assert.equal(out.length, 5);
  });

  it('ignores casual mentions without anchor patterns', () => {
    const text = 'It was a tough call. Decisions are hard. The choice was obvious.';
    const out = detectDecisions(text);
    assert.deepEqual(out, []);
  });

  it('returns [] for empty/non-string input', () => {
    assert.deepEqual(detectDecisions(''), []);
    assert.deepEqual(detectDecisions(null), []);
    assert.deepEqual(detectDecisions(123), []);
  });

  it('deduplicates identical sentences', () => {
    const text = 'We decided to ship.\nWe decided to ship.';
    const out = detectDecisions(text);
    assert.equal(out.length, 1);
  });
});

// ---------------------------------------------------------------------------
// captureDecisionsFromTask
// ---------------------------------------------------------------------------

describe('captureDecisionsFromTask', () => {
  it('writes context_items rows with memory_type=decision and trust=0.5', () => {
    resetTables();
    const task = {
      id: 'dec-1',
      project: 'demo',
      resultSummary: 'We decided to use Redis. Decision: ship behind a feature flag.',
    };
    const written = captureDecisionsFromTask(task);
    assert.equal(written.length, 2);
    for (const row of written) {
      assert.equal(row.memory_type, 'decision');
      assert.equal(row.scope_type, 'task');
      assert.equal(row.scope_id, 'dec-1');
      assert.equal(row.source_type, 'task');
      assert.equal(row.trust_score, 0.5);
      assert.equal(row.project, 'demo');
    }
  });

  it('returns [] when no decisions are present', () => {
    resetTables();
    const task = { id: 'dec-2', project: 'demo', resultSummary: 'Refactored helper. No anchor phrases here.' };
    const out = captureDecisionsFromTask(task);
    assert.deepEqual(out, []);
  });

  it('is best-effort — never throws on bad input', () => {
    let r;
    assert.doesNotThrow(() => { r = captureDecisionsFromTask(null); });
    assert.deepEqual(r, []);
    assert.doesNotThrow(() => { r = captureDecisionsFromTask({}); });
    assert.deepEqual(r, []);
  });
});

// ---------------------------------------------------------------------------
// detectRiskTerms
// ---------------------------------------------------------------------------

describe('detectRiskTerms', () => {
  it('is case-insensitive and word-boundary aware', () => {
    const hits = detectRiskTerms('We patched a Vulnerability and rotated the SECRET.');
    const terms = hits.map(h => h.term);
    assert.ok(terms.includes('vulnerability'));
    assert.ok(terms.includes('secret'));
  });

  it('does not match auth inside authority', () => {
    const hits = detectRiskTerms('The local authority signed off on the change.');
    const terms = hits.map(h => h.term);
    assert.ok(!terms.includes('auth_bypass'), 'auth_bypass must not match "authority"');
  });

  it('detects auth bypass / RCE / SQL injection / PII', () => {
    const text = 'Found an auth bypass and a SQL injection. Could lead to RCE. Also leaked PII.';
    const hits = detectRiskTerms(text);
    const terms = hits.map(h => h.term);
    assert.ok(terms.includes('auth_bypass'));
    assert.ok(terms.includes('injection'));
    assert.ok(terms.includes('rce'));
    assert.ok(terms.includes('pii'));
  });

  it('deduplicates by term', () => {
    const hits = detectRiskTerms('credential leak; new credentials shipped; credential rotation.');
    assert.equal(hits.filter(h => h.term === 'credential').length, 1);
  });

  it('returns [] for empty/non-string input', () => {
    assert.deepEqual(detectRiskTerms(''), []);
    assert.deepEqual(detectRiskTerms(null), []);
  });
});

// ---------------------------------------------------------------------------
// captureRisksFromTask
// ---------------------------------------------------------------------------

describe('captureRisksFromTask', () => {
  it('writes proposed_rules rows with source_type=risk_keyword status=pending trust=0.6', () => {
    resetTables();
    const task = {
      id: 'risk-1',
      project: 'demo',
      resultSummary: 'Patched an auth bypass in /login.',
      output: 'Also rotated a leaked credential.',
    };
    const written = captureRisksFromTask(task);
    assert.ok(written.length >= 2, `expected >=2 risk rows, got ${written.length}`);
    for (const row of written) {
      assert.equal(row.source_type, 'risk_keyword');
      assert.equal(row.status, 'pending');
      assert.equal(row.trust_score, 0.6);
      assert.equal(row.project, 'demo');
      assert.equal(row.source_id, 'risk-1');
      assert.equal(row.draft_category, 'security');
      assert.ok(row.evidence && JSON.parse(row.evidence).taskId === 'risk-1');
    }
  });

  it('returns [] when no risk terms are present', () => {
    resetTables();
    const out = captureRisksFromTask({ id: 'risk-clean', project: 'demo', resultSummary: 'No risky words here.' });
    assert.deepEqual(out, []);
  });

  it('is best-effort — never throws', () => {
    let r;
    assert.doesNotThrow(() => { r = captureRisksFromTask(null); });
    assert.deepEqual(r, []);
    assert.doesNotThrow(() => { r = captureRisksFromTask({}); });
    assert.deepEqual(r, []);
  });
});

// ---------------------------------------------------------------------------
// proposeRuleFromEvalCluster
// ---------------------------------------------------------------------------

describe('proposeRuleFromEvalCluster', () => {
  it('drafts a queue entry with evidence pointing to the cluster evals', () => {
    resetTables();
    // Create 3+ similar unprocessed evals so they form a cluster
    const e1 = createEval({
      taskId: 't-1', category: 'pattern_violation',
      whatHappened: 'Used hardcoded API key in service config file.',
      correctApproach: 'Read API keys from environment variables.',
      detection: 'manual_review', severity: 'high',
    });
    const e2 = createEval({
      taskId: 't-2', category: 'pattern_violation',
      whatHappened: 'Used hardcoded API key in service config file.',
      correctApproach: 'Read API keys from environment variables.',
      detection: 'manual_review', severity: 'high',
    });
    const e3 = createEval({
      taskId: 't-3', category: 'pattern_violation',
      whatHappened: 'Used hardcoded API key in service config file.',
      correctApproach: 'Read API keys from environment variables.',
      detection: 'manual_review', severity: 'high',
    });

    // Resolve a cluster id by passing any one eval id
    const row = proposeRuleFromEvalCluster(e1.id, { project: 'demo' });
    assert.ok(row, 'expected proposed_rules row');
    assert.equal(row.source_type, 'eval_cluster');
    assert.equal(row.status, 'pending');
    assert.equal(row.trust_score, 0.6);
    assert.equal(row.project, 'demo');
    const ev = JSON.parse(row.evidence);
    assert.ok(Array.isArray(ev.taskIds));
    assert.ok(Array.isArray(ev.evalIds));
    assert.ok(ev.evalIds.includes(e1.id));
    assert.ok(ev.evalIds.includes(e2.id));
    assert.ok(ev.evalIds.includes(e3.id));
    assert.ok(ev.clusterId.startsWith('pattern_violation:'));
  });

  it('returns null when no cluster matches the id', () => {
    resetTables();
    const r = proposeRuleFromEvalCluster('nonexistent:xxxxx', { project: 'demo' });
    assert.equal(r, null);
  });

  it('returns null on missing/empty input without throwing', () => {
    let r;
    assert.doesNotThrow(() => { r = proposeRuleFromEvalCluster(''); });
    assert.equal(r, null);
    assert.doesNotThrow(() => { r = proposeRuleFromEvalCluster(null); });
    assert.equal(r, null);
  });
});

// ---------------------------------------------------------------------------
// listProposedRules
// ---------------------------------------------------------------------------

describe('listProposedRules', () => {
  it('filters by project and status', () => {
    resetTables();
    const db = getDb();
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO proposed_rules
       (id, project, source_type, draft_content, trust_score, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`).run('p1', 'demo', 'manual', 'a', 0.6, 'pending', now);
    db.prepare(`INSERT INTO proposed_rules
       (id, project, source_type, draft_content, trust_score, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`).run('p2', 'other', 'manual', 'b', 0.6, 'pending', now);
    db.prepare(`INSERT INTO proposed_rules
       (id, project, source_type, draft_content, trust_score, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`).run('p3', 'demo', 'manual', 'c', 0.6, 'approved', now);

    const demoPending = listProposedRules({ project: 'demo', status: 'pending' });
    assert.equal(demoPending.length, 1);
    assert.equal(demoPending[0].id, 'p1');

    const allPending = listProposedRules({ status: 'pending' });
    assert.equal(allPending.length, 2);

    const demoAll = listProposedRules({ project: 'demo' });
    assert.equal(demoAll.length, 2);
  });

  it('respects the limit parameter and returns []  on totally empty query', () => {
    resetTables();
    assert.deepEqual(listProposedRules({ project: 'nope' }), []);
    const db = getDb();
    const now = new Date().toISOString();
    for (let i = 0; i < 5; i++) {
      db.prepare(`INSERT INTO proposed_rules
        (id, project, source_type, draft_content, trust_score, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(`x${i}`, 'demo', 'manual', 'd', 0.6, 'pending', now);
    }
    const limited = listProposedRules({ project: 'demo', limit: 2 });
    assert.equal(limited.length, 2);
  });
});
