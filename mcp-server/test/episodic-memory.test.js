/**
 * Tests for Context Fabric M1 — episodic capture + recall.
 *
 * Run: node --test mcp-server/test/episodic-memory.test.js
 *
 * Uses a per-process WORKFORCE_DATA_DIR pointed at a temp directory so the
 * shared `getDb()` singleton writes to throwaway storage.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP_DIR = mkdtempSync(join(tmpdir(), 'episodic-test-'));
process.env.WORKFORCE_DATA_DIR = TMP_DIR;

const dbMod = await import('../core/db.js');
const epMod = await import('../core/episodic-memory.js');

const { getDb } = dbMod;
const {
  captureEpisode,
  recallEpisodes,
  normalizeGlobSignature,
  isEpisodicEnabled,
} = epMod;

function resetTable() {
  getDb().exec('DELETE FROM episodic_memory');
}

function makeTask(overrides = {}) {
  return {
    id: overrides.id || `task-${Math.random().toString(36).slice(2, 10)}`,
    project: 'demo',
    prompt: 'Refactor session-context to add trust scoring',
    branch: overrides.branch || 'wf/test',
    targetBranch: 'main',
    taskType: 'standard',
    status: 'done',
    merged: 1,
    retryCount: 0,
    ...overrides,
  };
}

function fakeSummarizer(prompt, diff) {
  return {
    promptSummary: `prompt: ${prompt.slice(0, 80)}`,
    approachSummary: `approach: diff len=${(diff || '').length}; introduced helpers and tests`,
    trustScore: 0.7,
  };
}

function failingSummarizer() { return null; }

function insertRow({
  id, project = 'demo', task_id, glob_signature = '',
  prompt_summary = '', approach_summary = '',
  trust_score = 0.7, ttl_days = 90, created_at,
}) {
  const now = created_at || new Date().toISOString();
  getDb().prepare(`
    INSERT INTO episodic_memory (
      id, project, task_id, task_type, outcome, glob_signature,
      prompt_summary, approach_summary, files_touched, review_score,
      tokens_used, retry_count, trust_score, retrieval_count, ttl_days, created_at
    ) VALUES (?, ?, ?, 'standard', 'success', ?, ?, ?, '[]', null, null, 0, ?, 0, ?, ?)
  `).run(id, project, task_id, glob_signature, prompt_summary, approach_summary, trust_score, ttl_days, now);
}

before(() => { getDb(); });
after(() => {
  try { rmSync(TMP_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('normalizeGlobSignature', () => {
  it('returns empty string for empty input', () => {
    assert.equal(normalizeGlobSignature([]), '');
    assert.equal(normalizeGlobSignature(null), '');
  });

  it('collapses files in the same directory by extension', () => {
    const sig = normalizeGlobSignature([
      'mcp-server/core/db.js',
      'mcp-server/core/episodic-memory.js',
    ]);
    assert.equal(sig, 'mcp-server/core/*.js');
  });

  it('produces sorted, distinct, comma-joined globs', () => {
    const sig = normalizeGlobSignature([
      'a/b/d.ts',
      'a/b/c.ts',
      'a/Dockerfile',
    ]);
    assert.equal(sig, 'a/*,a/b/*.ts');
  });

  it('normalises Windows-style backslashes', () => {
    const sig = normalizeGlobSignature(['mcp-server\\core\\db.js']);
    assert.equal(sig, 'mcp-server/core/*.js');
  });

  it('strips leading dot-slash', () => {
    const sig = normalizeGlobSignature(['./pkg/foo.ts']);
    assert.equal(sig, 'pkg/*.ts');
  });
});

describe('captureEpisode + recallEpisodes', () => {
  it('captures a successful merged task and recalls it by keyword', () => {
    resetTable();
    const task = makeTask({ id: 'cap-1' });
    const row = captureEpisode({
      task,
      repoRoot: TMP_DIR,
      summarizer: fakeSummarizer,
    });
    assert.ok(row, 'captureEpisode returned null');
    assert.equal(row.project, 'demo');
    assert.equal(row.task_id, 'cap-1');
    assert.ok(row.prompt_summary.includes('Refactor'));
    assert.equal(row.trust_score, 0.7);

    const hits = recallEpisodes({
      project: 'demo',
      prompt: 'Add trust scoring to session context',
      plannedFiles: [],
      maxN: 3,
    });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].task_id, 'cap-1');
    assert.ok(hits[0]._score > 0);
  });

  it('returns up to maxN ranked by overlap', () => {
    resetTable();
    insertRow({
      id: 'a', task_id: 'a',
      prompt_summary: 'auth middleware jwt validation refresh tokens',
      glob_signature: 'src/auth/*.ts',
    });
    insertRow({
      id: 'b', task_id: 'b',
      prompt_summary: 'database migration prisma schema',
      glob_signature: 'prisma/*.prisma',
    });
    insertRow({
      id: 'c', task_id: 'c',
      prompt_summary: 'auth jwt session expiry',
      glob_signature: 'src/auth/*.ts',
    });

    const hits = recallEpisodes({
      project: 'demo',
      prompt: 'add jwt refresh token endpoint',
      plannedFiles: ['src/auth/refresh.ts'],
      maxN: 3,
    });
    const ids = hits.map(h => h.task_id);
    assert.ok(ids.includes('a'));
    assert.ok(ids.includes('c'));
    assert.ok(!ids.includes('b'), 'unrelated episode b should not be returned');
  });
});

describe('trust threshold', () => {
  it('excludes episodes below trust_score 0.5', () => {
    resetTable();
    insertRow({
      id: 'low', task_id: 'low', trust_score: 0.4,
      prompt_summary: 'unique anchor xylophone keyword',
      glob_signature: 'pkg/*.ts',
    });
    insertRow({
      id: 'high', task_id: 'high', trust_score: 0.9,
      prompt_summary: 'unique anchor xylophone keyword',
      glob_signature: 'pkg/*.ts',
    });
    const hits = recallEpisodes({
      project: 'demo',
      prompt: 'unique anchor xylophone keyword',
      plannedFiles: [],
      maxN: 5,
    });
    const ids = hits.map(h => h.task_id);
    assert.ok(ids.includes('high'));
    assert.ok(!ids.includes('low'), 'low-trust episode must be filtered');
  });
});

describe('TTL filter', () => {
  it('excludes episodes older than ttl_days', () => {
    resetTable();
    const veryOld = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString();
    insertRow({
      id: 'old', task_id: 'old', ttl_days: 90, created_at: veryOld,
      prompt_summary: 'kangaroo zebra anchor unique keyword',
      glob_signature: '',
    });
    insertRow({
      id: 'new', task_id: 'new', ttl_days: 90,
      prompt_summary: 'kangaroo zebra anchor unique keyword',
      glob_signature: '',
    });
    const hits = recallEpisodes({
      project: 'demo',
      prompt: 'kangaroo zebra anchor unique keyword',
      plannedFiles: [],
      maxN: 5,
    });
    const ids = hits.map(h => h.task_id);
    assert.ok(ids.includes('new'));
    assert.ok(!ids.includes('old'), 'expired episode must be filtered');
  });
});

describe('best-effort failure', () => {
  it('persists a placeholder when summarizer is unavailable and never throws', () => {
    resetTable();
    const task = makeTask({ id: 'be-1' });
    let row;
    assert.doesNotThrow(() => {
      row = captureEpisode({ task, repoRoot: TMP_DIR, summarizer: failingSummarizer });
    });
    assert.ok(row, 'capture should still produce a row when summarizer is unavailable');
    assert.equal(row.trust_score, 0.5);
    assert.match(row.approach_summary, /Haiku unavailable/);
  });

  it('returns null without throwing when task is missing', () => {
    resetTable();
    let result;
    assert.doesNotThrow(() => {
      result = captureEpisode({ task: null });
    });
    assert.equal(result, null);
  });
});

describe('idempotency', () => {
  it('returns the existing row on a second capture for the same (project, task_id)', () => {
    resetTable();
    const task = makeTask({ id: 'idem-1' });
    const first = captureEpisode({ task, repoRoot: TMP_DIR, summarizer: fakeSummarizer });
    const second = captureEpisode({ task, repoRoot: TMP_DIR, summarizer: fakeSummarizer });
    assert.equal(first.id, second.id);

    const count = getDb().prepare(
      'SELECT COUNT(*) AS n FROM episodic_memory WHERE project = ? AND task_id = ?',
    ).get('demo', 'idem-1').n;
    assert.equal(count, 1);
  });
});

describe('feature-flag opt-out', () => {
  it('returns null and empty when WORKFORCE_EPISODIC_ENABLED=false', () => {
    resetTable();
    const prev = process.env.WORKFORCE_EPISODIC_ENABLED;
    process.env.WORKFORCE_EPISODIC_ENABLED = 'false';
    try {
      assert.equal(isEpisodicEnabled(), false);
      const cap = captureEpisode({ task: makeTask({ id: 'flag-1' }), summarizer: fakeSummarizer });
      assert.equal(cap, null);
      const hits = recallEpisodes({ project: 'demo', prompt: 'anything', plannedFiles: [], maxN: 3 });
      assert.deepEqual(hits, []);
      const count = getDb().prepare('SELECT COUNT(*) AS n FROM episodic_memory').get().n;
      assert.equal(count, 0);
    } finally {
      if (prev === undefined) delete process.env.WORKFORCE_EPISODIC_ENABLED;
      else process.env.WORKFORCE_EPISODIC_ENABLED = prev;
    }
    assert.equal(isEpisodicEnabled(), true);
  });
});
