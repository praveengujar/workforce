/**
 * Tests for Context Fabric M3 — full context schema (context_items,
 * context_blocks, task_context_audits, prompt_layers).
 *
 * Run: node --test mcp-server/test/context-memory.test.js
 *
 * Uses WORKFORCE_DATA_DIR pointed at a temp dir so the singleton DB writes
 * to throwaway storage (matches trust.test.js / episodic-memory.test.js).
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP_DIR = mkdtempSync(join(tmpdir(), 'context-memory-test-'));
process.env.WORKFORCE_DATA_DIR = TMP_DIR;
delete process.env.WORKFORCE_CONTEXT_TRUST_THRESHOLD;

const dbMod = await import('../core/db.js');
const cmMod = await import('../core/context-memory.js');
const sessionMod = await import('../core/session-context.js');

const { getDb, applyMigration17 } = dbMod;
const {
  SCOPE_TYPES, MEMORY_TYPES, SOURCE_TYPES,
  addContextItem, getContextItem, updateContextItem, invalidateContextItem,
  listContextItems, searchContextItems, isFtsAvailable, _resetFtsCache,
  getContextBlock, setContextBlock, listContextBlocks, _resetSeedCache,
  writeContextAudit, getContextAudit, listContextAudits,
  writeLayerTelemetry, getLayerTelemetry,
} = cmMod;
const { setSessionContext } = sessionMod;

before(() => { getDb(); });
after(() => {
  try { rmSync(TMP_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

function resetTables() {
  const db = getDb();
  db.prepare('DELETE FROM context_items').run();
  db.prepare('DELETE FROM context_blocks').run();
  db.prepare('DELETE FROM task_context_audits').run();
  db.prepare('DELETE FROM prompt_layers').run();
  db.prepare('DELETE FROM session_context').run();
  try { db.prepare('DELETE FROM context_items_fts').run(); } catch { /* may not exist */ }
  _resetSeedCache();
}

// ---------------------------------------------------------------------------
// Migration 17 — idempotent
// ---------------------------------------------------------------------------

describe('Migration 17 — idempotent', () => {
  it('re-running on a fully migrated DB is a no-op', () => {
    const before = getDb().prepare('PRAGMA table_info(context_items)').all();
    applyMigration17(getDb());
    applyMigration17(getDb());
    const after = getDb().prepare('PRAGMA table_info(context_items)').all();
    assert.equal(after.length, before.length);
  });

  it('creates all four core tables', () => {
    const tables = getDb().prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN (?, ?, ?, ?)",
    ).all('context_items', 'context_blocks', 'task_context_audits', 'prompt_layers');
    assert.equal(tables.length, 4);
  });

  it('schema_migrations row recorded for version 17', () => {
    const row = getDb().prepare('SELECT * FROM schema_migrations WHERE version = 17').get();
    assert.ok(row);
  });
});

// ---------------------------------------------------------------------------
// context_items — CRUD + trust + invalidation + enums
// ---------------------------------------------------------------------------

describe('context_items CRUD', () => {
  beforeEach(resetTables);

  it('roundtrip: add → get → update → list', () => {
    const created = addContextItem({
      project: 'demo',
      scopeType: 'project',
      memoryType: 'semantic',
      title: 'Auth middleware contract',
      content: 'Bearer token validation runs before any handler.',
      sourceType: 'human',
      tags: ['auth', 'middleware'],
      paths: ['mcp-server/core/*.js'],
    });
    assert.ok(created.id);
    assert.equal(created.title, 'Auth middleware contract');
    assert.equal(created.source_type, 'human');
    assert.equal(created.trust_score, 1.0);
    assert.equal(created.authored_by, 'user');

    const fetched = getContextItem(created.id);
    assert.equal(fetched.id, created.id);

    const updated = updateContextItem(created.id, { content: 'updated body', tags: ['auth'] });
    assert.equal(updated.content, 'updated body');
    assert.equal(updated.tags, JSON.stringify(['auth']));

    const list = listContextItems('demo');
    assert.equal(list.length, 1);
    assert.equal(list[0].id, created.id);
  });

  it('agent-authored writes are clamped at trust_score = 0.4', () => {
    const r = addContextItem({
      project: 'demo',
      scopeType: 'project',
      memoryType: 'semantic',
      title: 'agent claim',
      content: 'agent-supplied note',
      sourceType: 'agent',
      authoredBy: 'agent:abc12345',
      trustScore: 1.0,
    });
    assert.equal(r.trust_score, 0.4);
    assert.equal(r.source_type, 'agent');
    assert.equal(r.authored_by, 'agent:abc12345');
  });

  it('default threshold (0.5) excludes agent rows; threshold=0 returns them', () => {
    addContextItem({
      project: 'demo', scopeType: 'project', memoryType: 'semantic',
      title: 'human-row', content: 'h', sourceType: 'human',
    });
    addContextItem({
      project: 'demo', scopeType: 'project', memoryType: 'semantic',
      title: 'agent-row', content: 'a', sourceType: 'agent',
      authoredBy: 'agent:x', trustScore: 1.0,
    });
    const filtered = listContextItems('demo');
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].title, 'human-row');

    const all = listContextItems('demo', { trustThreshold: 0 });
    assert.equal(all.length, 2);
  });

  it('invalidate excludes from default list but preserves the row', () => {
    const r = addContextItem({
      project: 'demo', scopeType: 'project', memoryType: 'decision',
      title: 'choice', content: 'use SQLite', sourceType: 'human',
    });
    invalidateContextItem(r.id, { invalidatedBy: 'user', reason: 'superseded by Postgres choice' });

    const list = listContextItems('demo');
    assert.equal(list.length, 0);

    const including = listContextItems('demo', { includeInvalidated: true });
    assert.equal(including.length, 1);
    assert.equal(including[0].invalidation_reason, 'superseded by Postgres choice');

    const direct = getContextItem(r.id);
    assert.ok(direct.invalid_at);
    assert.equal(direct.invalidated_by, 'user');
  });

  it('rejects invalid scope_type', () => {
    assert.throws(() => addContextItem({
      project: 'demo', scopeType: 'galactic', memoryType: 'semantic',
      title: 't', content: 'c', sourceType: 'human',
    }), /scope_type/);
  });

  it('rejects invalid memory_type', () => {
    assert.throws(() => addContextItem({
      project: 'demo', scopeType: 'project', memoryType: 'mythical',
      title: 't', content: 'c', sourceType: 'human',
    }), /memory_type/);
  });

  it('rejects invalid source_type', () => {
    assert.throws(() => addContextItem({
      project: 'demo', scopeType: 'project', memoryType: 'semantic',
      title: 't', content: 'c', sourceType: 'martian',
    }), /source_type/);
  });

  it('listContextItems filters by scope/memory/source', () => {
    addContextItem({
      project: 'demo', scopeType: 'task', scopeId: 'task-1',
      memoryType: 'episodic', title: 'episode', content: 'e', sourceType: 'task',
      trustScore: 0.6,
    });
    addContextItem({
      project: 'demo', scopeType: 'project', memoryType: 'risk',
      title: 'risk', content: 'r', sourceType: 'human',
    });
    assert.equal(listContextItems('demo', { scopeType: 'task' }).length, 1);
    assert.equal(listContextItems('demo', { memoryType: 'risk' }).length, 1);
    assert.equal(listContextItems('demo', { sourceType: 'human' }).length, 1);
  });
});

// ---------------------------------------------------------------------------
// searchContextItems — FTS5 + LIKE fallback
// ---------------------------------------------------------------------------

describe('searchContextItems', () => {
  beforeEach(resetTables);

  it('FTS5 path: returns matches when available', () => {
    addContextItem({
      project: 'demo', scopeType: 'project', memoryType: 'semantic',
      title: 'webhook delivery', content: 'retry policy is 3x exponential backoff',
      sourceType: 'human', tags: ['webhook', 'retry'],
    });
    addContextItem({
      project: 'demo', scopeType: 'project', memoryType: 'semantic',
      title: 'database choice', content: 'we picked sqlite for embedding',
      sourceType: 'human', tags: ['db'],
    });
    const hits = searchContextItems('demo', 'webhook');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].title, 'webhook delivery');
  });

  it('LIKE fallback path (forceLike=true) returns the same shape', () => {
    addContextItem({
      project: 'demo', scopeType: 'project', memoryType: 'semantic',
      title: 'rate limiter', content: 'token bucket sized at 100/min',
      sourceType: 'human', tags: ['rate-limit'],
    });
    addContextItem({
      project: 'demo', scopeType: 'project', memoryType: 'semantic',
      title: 'random unrelated', content: 'alpha bravo charlie',
      sourceType: 'human',
    });
    const hits = searchContextItems('demo', 'token bucket', { forceLike: true });
    assert.ok(hits.length >= 1);
    assert.equal(hits[0].title, 'rate limiter');
  });

  it('LIKE fallback respects trust threshold and invalidation', () => {
    const a = addContextItem({
      project: 'demo', scopeType: 'project', memoryType: 'semantic',
      title: 'banana phone', content: 'specifically banana', sourceType: 'human',
    });
    addContextItem({
      project: 'demo', scopeType: 'project', memoryType: 'semantic',
      title: 'agent banana', content: 'banana spam from agent', sourceType: 'agent',
      authoredBy: 'agent:abc', trustScore: 1.0,
    });
    const def = searchContextItems('demo', 'banana', { forceLike: true });
    const titles = def.map(r => r.title);
    assert.ok(titles.includes('banana phone'));
    assert.ok(!titles.includes('agent banana'));

    invalidateContextItem(a.id, { reason: 'tested' });
    const after = searchContextItems('demo', 'banana', { forceLike: true });
    assert.equal(after.length, 0);
  });
});

// ---------------------------------------------------------------------------
// context_blocks — defaults + hydration + read_only + version bump
// ---------------------------------------------------------------------------

describe('context_blocks defaults + hydration', () => {
  beforeEach(resetTables);

  it('first listContextBlocks call seeds the six defaults', () => {
    const blocks = listContextBlocks('proj-x');
    const labels = blocks.map(b => b.label).sort();
    assert.deepEqual(labels, [
      'active_focus', 'architecture_notes', 'known_risks',
      'open_decisions', 'repo_profile', 'task_preferences',
    ]);
    for (const b of blocks) {
      assert.equal(b.source_type, 'system');
      assert.equal(b.version, 1);
      assert.equal(b.read_only, 0);
    }
  });

  it('seeding is idempotent across repeated calls', () => {
    listContextBlocks('proj-x');
    _resetSeedCache();
    listContextBlocks('proj-x');
    const count = getDb().prepare(
      "SELECT COUNT(*) AS c FROM context_blocks WHERE project = ?",
    ).get('proj-x').c;
    assert.equal(count, 6);
  });

  it('active_focus hydrates from session_context on first read when empty', () => {
    setSessionContext('proj-x', 'active_focus', 'shipping M3');
    const b = getContextBlock('proj-x', 'active_focus');
    assert.equal(b.value, 'shipping M3');
    assert.equal(b.updated_by, 'session_context_hydration');
  });

  it('active_focus hydration does NOT clobber an explicit set', () => {
    setSessionContext('proj-x', 'active_focus', 'session value');
    setContextBlock('proj-x', 'active_focus', 'block value');
    const b = getContextBlock('proj-x', 'active_focus');
    assert.equal(b.value, 'block value');
  });

  it('setContextBlock bumps version on each update', () => {
    // seed creates row at v1; two setContextBlock calls bump to v3.
    setContextBlock('proj-x', 'repo_profile', 'v1');
    setContextBlock('proj-x', 'repo_profile', 'v2');
    const b = getContextBlock('proj-x', 'repo_profile');
    assert.equal(b.value, 'v2');
    assert.equal(b.version, 3);
  });

  it('agent writes are clamped at trust_score 0.4', () => {
    const b = setContextBlock('proj-x', 'open_decisions', 'agent claim', {
      sourceType: 'agent', authoredBy: 'agent:zzz', trustScore: 1.0,
    });
    assert.equal(b.trust_score, 0.4);
  });

  it('read_only block rejects updates', () => {
    setContextBlock('proj-x', 'architecture_notes', 'locked', { readOnly: true });
    assert.throws(
      () => setContextBlock('proj-x', 'architecture_notes', 'attempted change'),
      /read_only/,
    );
  });
});

// ---------------------------------------------------------------------------
// task_context_audits — write/read/list
// ---------------------------------------------------------------------------

describe('task_context_audits', () => {
  beforeEach(resetTables);

  it('write → get → list roundtrip', () => {
    const audit = writeContextAudit({
      taskId: 'task-1',
      project: 'demo',
      promptHash: 'sha-prompt-1',
      contextHash: 'sha-ctx-1',
      budget: 80000,
      selectedItems: [{ id: 'a', layer: 7, score: 0.8, reason: 'matched glob', char_count: 240 }],
      omittedItems: [{ id: 'b', reason: 'below_threshold' }],
      conflicts: [],
      trustThreshold: 0.5,
      assembledPromptPreview: 'first 2000 chars...',
      perLayerChars: { 1: 200, 7: 1500 },
    });
    assert.ok(audit.id);
    assert.equal(audit.task_id, 'task-1');
    assert.equal(audit.budget, 80000);

    const fetched = getContextAudit(audit.id);
    assert.equal(fetched.id, audit.id);
    const parsedSelected = JSON.parse(fetched.selected_items);
    assert.equal(parsedSelected[0].id, 'a');

    writeContextAudit({ taskId: 'task-1', project: 'demo' });
    const list = listContextAudits('task-1');
    assert.equal(list.length, 2);
  });

  it('throws on missing task_id', () => {
    assert.throws(() => writeContextAudit({}), /task_id/);
  });
});

// ---------------------------------------------------------------------------
// prompt_layers — UPSERT idempotent on (task_id, layer_num)
// ---------------------------------------------------------------------------

describe('prompt_layers', () => {
  beforeEach(resetTables);

  it('writeLayerTelemetry UPSERTs on (task_id, layer_num)', () => {
    writeLayerTelemetry({
      taskId: 'task-7', layerNum: 3, layerName: 'recent_git_log',
      charCount: 1234, retrievalCount: 5, selectedCount: 5,
    });
    writeLayerTelemetry({
      taskId: 'task-7', layerNum: 3, layerName: 'recent_git_log',
      charCount: 4321, retrievalCount: 6, selectedCount: 5,
      wasTruncated: true,
    });
    const rows = getLayerTelemetry('task-7');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].char_count, 4321);
    assert.equal(rows[0].was_truncated, 1);
  });

  it('different layer_num produces independent rows', () => {
    writeLayerTelemetry({ taskId: 'task-9', layerNum: 1, layerName: 'a', charCount: 10 });
    writeLayerTelemetry({ taskId: 'task-9', layerNum: 2, layerName: 'b', charCount: 20 });
    writeLayerTelemetry({ taskId: 'task-9', layerNum: 7, layerName: 'g', charCount: 70 });
    const rows = getLayerTelemetry('task-9');
    assert.equal(rows.length, 3);
    assert.deepEqual(rows.map(r => r.layer_num), [1, 2, 7]);
  });

  it('rejects non-integer layer_num', () => {
    assert.throws(
      () => writeLayerTelemetry({ taskId: 'task-x', layerNum: 'big', layerName: 'l', charCount: 0 }),
      /layer_num/,
    );
  });
});

// ---------------------------------------------------------------------------
// FTS5 detection — runtime cache
// ---------------------------------------------------------------------------

describe('FTS5 detection', () => {
  it('isFtsAvailable returns a boolean and matches sqlite_master', () => {
    _resetFtsCache();
    const present = !!getDb().prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='context_items_fts'",
    ).get();
    assert.equal(isFtsAvailable(), present);
  });
});
