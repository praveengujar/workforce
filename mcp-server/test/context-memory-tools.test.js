/**
 * Tests for Context Fabric M5 — MCP tool handlers (context-memory-tools.js).
 *
 * Run: node --test mcp-server/test/context-memory-tools.test.js
 *
 * Uses WORKFORCE_DATA_DIR pointed at a temp dir so the singleton DB writes
 * to throwaway storage (matches the M3/M4 test pattern).
 */

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP_DIR = mkdtempSync(join(tmpdir(), 'context-memory-tools-test-'));
process.env.WORKFORCE_DATA_DIR = TMP_DIR;
delete process.env.WORKFORCE_CONTEXT_TRUST_THRESHOLD;

const dbMod = await import('../core/db.js');
const cmMod = await import('../core/context-memory.js');
const toolsMod = await import('../tools/context-memory-tools.js');

const { getDb } = dbMod;
const {
  addContextItem, getContextItem, _resetSeedCache,
} = cmMod;
const {
  addContextItemHandler,
  searchContextItemsHandler,
  previewContextHandler,
  auditContextHandler,
  invalidateContextHandler,
  promoteContextHandler,
  compactContextHandler,
  _internals,
} = toolsMod;

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
  db.prepare('DELETE FROM knowledge_rules').run();
  db.prepare('DELETE FROM episodic_memory').run();
  db.prepare('DELETE FROM shared_context').run();
  try { db.prepare('DELETE FROM context_items_fts').run(); } catch { /* may not exist */ }
  _resetSeedCache();
}

function clearAgentEnv() { delete process.env.WORKFORCE_AGENT_TASK_ID; }
function setAgentEnv(taskId) { process.env.WORKFORCE_AGENT_TASK_ID = taskId; }

// ---------------------------------------------------------------------------
// Caller tagging — environment-driven provenance
// ---------------------------------------------------------------------------

describe('caller-tagging', () => {
  beforeEach(() => { resetTables(); clearAgentEnv(); });
  afterEach(clearAgentEnv);

  it('no agent env → source=human, authoredBy=user', () => {
    const p = _internals.getCallerProvenance();
    assert.equal(p.sourceType, 'human');
    assert.equal(p.authoredBy, 'user');
  });

  it('WORKFORCE_AGENT_TASK_ID set → source=agent, authoredBy=agent:<id>', () => {
    setAgentEnv('task-99');
    const p = _internals.getCallerProvenance();
    assert.equal(p.sourceType, 'agent');
    assert.equal(p.authoredBy, 'agent:task-99');
  });
});

// ---------------------------------------------------------------------------
// 1. addContextItemHandler
// ---------------------------------------------------------------------------

describe('addContextItemHandler', () => {
  beforeEach(() => { resetTables(); clearAgentEnv(); });
  afterEach(clearAgentEnv);

  it('happy path returns shaped item with caller provenance', async () => {
    const r = await addContextItemHandler({
      project: 'demo',
      memoryType: 'semantic',
      title: 'auth contract',
      content: 'JWT validation required',
      scopeType: 'project',
      paths: ['src/auth/**'],
      tags: ['auth'],
    });
    assert.equal(r.ok, true);
    assert.equal(r.callerSource, 'human');
    assert.equal(r.authoredBy, 'user');
    assert.equal(r.item.title, 'auth contract');
    assert.equal(r.item.sourceType, 'human');
    assert.equal(r.item.trustScore, 1.0);
    assert.deepEqual(r.item.paths, ['src/auth/**']);
  });

  it('agent caller: trust clamped at 0.4 even if requested 1.0 (red-team)', async () => {
    setAgentEnv('abc12345');
    const r = await addContextItemHandler({
      project: 'demo',
      memoryType: 'semantic',
      title: 'agent claim',
      content: 'agent-supplied',
      scopeType: 'project',
      trustScore: 1.0,
    });
    assert.equal(r.callerSource, 'agent');
    assert.equal(r.authoredBy, 'agent:abc12345');
    assert.equal(r.item.trustScore, 0.4);
    assert.equal(r.item.sourceType, 'agent');
    assert.equal(r.item.authoredBy, 'agent:abc12345');
  });

  it('throws on missing required args with clear messages', async () => {
    await assert.rejects(() => addContextItemHandler({}), /project/);
    await assert.rejects(
      () => addContextItemHandler({ project: 'x' }),
      /memoryType/,
    );
    await assert.rejects(
      () => addContextItemHandler({ project: 'x', memoryType: 'semantic' }),
      /title/,
    );
    await assert.rejects(
      () => addContextItemHandler({ project: 'x', memoryType: 'semantic', title: 't' }),
      /content/,
    );
    await assert.rejects(
      () => addContextItemHandler({ project: 'x', memoryType: 'semantic', title: 't', content: 'c' }),
      /scopeType/,
    );
  });
});

// ---------------------------------------------------------------------------
// 2. searchContextItemsHandler
// ---------------------------------------------------------------------------

describe('searchContextItemsHandler', () => {
  beforeEach(() => { resetTables(); clearAgentEnv(); });

  it('finds items by query and surfaces trust + source', async () => {
    addContextItem({
      project: 'demo', scopeType: 'project', memoryType: 'semantic',
      title: 'webhook delivery', content: 'retry policy is exponential',
      sourceType: 'human',
    });
    const r = await searchContextItemsHandler({ project: 'demo', query: 'webhook' });
    assert.equal(r.ok, true);
    assert.equal(r.count, 1);
    assert.equal(r.items[0].title, 'webhook delivery');
    assert.equal(r.items[0].sourceType, 'human');
    assert.ok(typeof r.items[0].trustScore === 'number');
  });

  it('default excludes invalidated; includeInvalidated=true returns them', async () => {
    const a = addContextItem({
      project: 'demo', scopeType: 'project', memoryType: 'semantic',
      title: 'banana phone', content: 'specifically banana',
      sourceType: 'human',
    });
    await invalidateContextHandler({ id: a.id, reason: 'test' });

    const def = await searchContextItemsHandler({ project: 'demo', query: 'banana' });
    assert.equal(def.count, 0);

    const inc = await searchContextItemsHandler({
      project: 'demo', query: 'banana', includeInvalidated: true,
    });
    assert.equal(inc.count, 1);
    assert.ok(inc.items[0].invalidAt);
  });

  it('trustThreshold flag passes through (low threshold returns agent rows)', async () => {
    addContextItem({
      project: 'demo', scopeType: 'project', memoryType: 'semantic',
      title: 'human row', content: 'token bucket', sourceType: 'human',
    });
    addContextItem({
      project: 'demo', scopeType: 'project', memoryType: 'semantic',
      title: 'agent row', content: 'token bucket', sourceType: 'agent',
      authoredBy: 'agent:x', trustScore: 1.0,
    });
    const def = await searchContextItemsHandler({ project: 'demo', query: 'token bucket' });
    const titles = def.items.map(i => i.title);
    assert.ok(titles.includes('human row'));
    assert.ok(!titles.includes('agent row'));

    const all = await searchContextItemsHandler({
      project: 'demo', query: 'token bucket', trustThreshold: 0,
    });
    const allTitles = all.items.map(i => i.title);
    assert.ok(allTitles.includes('agent row'));
  });

  it('without query returns project items filtered by memoryType', async () => {
    addContextItem({
      project: 'demo', scopeType: 'project', memoryType: 'risk',
      title: 'risk-1', content: 'r', sourceType: 'human',
    });
    addContextItem({
      project: 'demo', scopeType: 'project', memoryType: 'semantic',
      title: 'sem-1', content: 's', sourceType: 'human',
    });
    const r = await searchContextItemsHandler({ project: 'demo', memoryType: 'risk' });
    assert.equal(r.count, 1);
    assert.equal(r.items[0].title, 'risk-1');
  });

  it('throws when project missing', async () => {
    await assert.rejects(() => searchContextItemsHandler({}), /project/);
  });
});

// ---------------------------------------------------------------------------
// 3. previewContextHandler
// ---------------------------------------------------------------------------

describe('previewContextHandler', () => {
  beforeEach(() => { resetTables(); clearAgentEnv(); });

  it('returns {promptBlock, sections, audit} from M4 assembler', async () => {
    addContextItem({
      project: 'demo', scopeType: 'project', memoryType: 'risk',
      title: 'never log secrets', content: 'do not log credentials',
      sourceType: 'human',
    });
    const r = await previewContextHandler({
      project: 'demo',
      prompt: 'add audit logging',
    });
    assert.equal(r.ok, true);
    assert.equal(typeof r.promptBlock, 'string');
    assert.ok(Array.isArray(r.sections));
    assert.ok(r.audit);
    assert.ok('selected' in r.audit);
    assert.ok('omitted' in r.audit);
    assert.equal(r.audit.mode, 'preview');
  });

  it('preview is idempotent for the same input', async () => {
    addContextItem({
      project: 'demo', scopeType: 'project', memoryType: 'semantic',
      title: 'note', content: 'stable content', sourceType: 'human',
    });
    const a = await previewContextHandler({ project: 'demo', prompt: 'note' });
    const b = await previewContextHandler({ project: 'demo', prompt: 'note' });
    assert.equal(a.promptBlock, b.promptBlock);
  });

  it('preview does NOT write a task_context_audits row (no taskId)', async () => {
    const before = getDb().prepare('SELECT COUNT(*) AS n FROM task_context_audits').get().n;
    await previewContextHandler({ project: 'demo', prompt: 'preview-no-write' });
    const after = getDb().prepare('SELECT COUNT(*) AS n FROM task_context_audits').get().n;
    assert.equal(after, before);
  });

  it('throws on missing project / prompt', async () => {
    await assert.rejects(() => previewContextHandler({ prompt: 'p' }), /project/);
    await assert.rejects(() => previewContextHandler({ project: 'x' }), /prompt/);
  });
});

// ---------------------------------------------------------------------------
// 4. auditContextHandler
// ---------------------------------------------------------------------------

describe('auditContextHandler', () => {
  beforeEach(() => { resetTables(); clearAgentEnv(); });

  it('returns audit history for a known task (selected + omitted)', async () => {
    // Force an audit row by calling assembleContext via the imported module
    const asm = await import('../core/context-assembler.js');
    addContextItem({
      project: 'demo', scopeType: 'project', memoryType: 'semantic',
      title: 't1', content: 'audit content body',
      sourceType: 'human',
    });
    asm.assembleContext({ project: 'demo', prompt: 'audit content', taskId: 'aud-1' });

    const r = await auditContextHandler({ taskId: 'aud-1' });
    assert.equal(r.ok, true);
    assert.equal(r.taskId, 'aud-1');
    assert.equal(r.count, 1);
    assert.ok(Array.isArray(r.audits[0].selected));
    assert.ok(Array.isArray(r.audits[0].omitted));
    assert.ok('perLayerChars' in r.audits[0]);
  });

  it('returns empty list for unknown task', async () => {
    const r = await auditContextHandler({ taskId: 'never-existed' });
    assert.equal(r.ok, true);
    assert.equal(r.count, 0);
    assert.deepEqual(r.audits, []);
  });

  it('throws on missing taskId', async () => {
    await assert.rejects(() => auditContextHandler({}), /taskId/);
  });
});

// ---------------------------------------------------------------------------
// 5. invalidateContextHandler
// ---------------------------------------------------------------------------

describe('invalidateContextHandler', () => {
  beforeEach(() => { resetTables(); clearAgentEnv(); });

  it('row preserved post-invalidation; not in default search', async () => {
    const created = addContextItem({
      project: 'demo', scopeType: 'project', memoryType: 'decision',
      title: 'use sqlite', content: 'we picked sqlite',
      sourceType: 'human',
    });
    const r = await invalidateContextHandler({
      id: created.id, reason: 'superseded',
    });
    assert.equal(r.ok, true);
    assert.equal(r.invalidated.id, created.id);
    assert.ok(r.invalidated.invalidAt);
    assert.equal(r.invalidated.invalidationReason, 'superseded');

    // Row preserved
    const fetched = getContextItem(created.id);
    assert.ok(fetched);
    assert.ok(fetched.invalid_at);

    // Not in default search
    const search = await searchContextItemsHandler({ project: 'demo', query: 'sqlite' });
    assert.equal(search.count, 0);
  });

  it('agent caller is recorded as invalidator when invalidatedBy omitted', async () => {
    setAgentEnv('agent-zz');
    const created = addContextItem({
      project: 'demo', scopeType: 'project', memoryType: 'semantic',
      title: 't', content: 'c', sourceType: 'human',
    });
    const r = await invalidateContextHandler({ id: created.id });
    assert.equal(r.invalidated.invalidatedBy, 'agent:agent-zz');
  });

  it('throws on missing id', async () => {
    await assert.rejects(() => invalidateContextHandler({}), /id/);
  });
});

// ---------------------------------------------------------------------------
// 6. promoteContextHandler — intent-only (PRD §9.7)
// ---------------------------------------------------------------------------

describe('promoteContextHandler', () => {
  beforeEach(() => { resetTables(); clearAgentEnv(); });

  it('returns candidate without applying; requiresApproval=true by default', async () => {
    const item = addContextItem({
      project: 'demo', scopeType: 'project', memoryType: 'decision',
      title: 'promote me', content: 'durable decision',
      sourceType: 'human',
    });
    const r = await promoteContextHandler({ id: item.id, target: 'core_block' });
    assert.equal(r.ok, true);
    assert.equal(r.applied, false);
    assert.equal(r.requiresApproval, true);
    assert.equal(r.candidate.target, 'core_block');
    assert.equal(r.candidate.sourceItemId, item.id);
    assert.equal(r.candidate.proposed.title, 'promote me');

    // Source item is untouched (no DB mutation)
    const fetched = getContextItem(item.id);
    assert.equal(fetched.title, 'promote me');
    assert.equal(fetched.invalid_at, null);
  });

  it('rejects invalid target', async () => {
    const item = addContextItem({
      project: 'demo', scopeType: 'project', memoryType: 'semantic',
      title: 't', content: 'c', sourceType: 'human',
    });
    await assert.rejects(
      () => promoteContextHandler({ id: item.id, target: 'galactic_block' }),
      /target/,
    );
  });

  it('rejects unknown id', async () => {
    await assert.rejects(
      () => promoteContextHandler({ id: 'does-not-exist', target: 'core_block' }),
      /not found/,
    );
  });

  it('throws on missing id / target', async () => {
    await assert.rejects(() => promoteContextHandler({}), /id/);
    await assert.rejects(() => promoteContextHandler({ id: 'x' }), /target/);
  });
});

// ---------------------------------------------------------------------------
// 7. compactContextHandler
// ---------------------------------------------------------------------------

describe('compactContextHandler', () => {
  beforeEach(() => { resetTables(); clearAgentEnv(); });

  it('dryRun returns candidates list with no DB mutations', async () => {
    const a = addContextItem({
      project: 'demo', scopeType: 'project', memoryType: 'semantic',
      title: 'duplicate title', content: 'same content body',
      sourceType: 'human',
    });
    const b = addContextItem({
      project: 'demo', scopeType: 'project', memoryType: 'semantic',
      title: 'duplicate title', content: 'same content body',
      sourceType: 'human',
    });
    const r = await compactContextHandler({ project: 'demo', dryRun: true });
    assert.equal(r.ok, true);
    assert.equal(r.dryRun, true);
    assert.equal(r.duplicateGroups, 1);
    assert.equal(r.invalidated, 0);
    assert.equal(r.candidates[0].duplicates.length, 1);

    // Both rows still active (no mutation in dryRun)
    assert.equal(getContextItem(a.id).invalid_at, null);
    assert.equal(getContextItem(b.id).invalid_at, null);
  });

  it('non-dry: invalidates duplicates, preserves canonical row', async () => {
    const a = addContextItem({
      project: 'demo', scopeType: 'project', memoryType: 'semantic',
      title: 'shared title', content: 'shared body content',
      sourceType: 'human',
    });
    // Force a later created_at by waiting a millisecond + writing again
    await new Promise(res => setTimeout(res, 10));
    const b = addContextItem({
      project: 'demo', scopeType: 'project', memoryType: 'semantic',
      title: 'shared title', content: 'shared body content',
      sourceType: 'human',
    });
    const r = await compactContextHandler({ project: 'demo', dryRun: false });
    assert.equal(r.ok, true);
    assert.equal(r.dryRun, false);
    assert.equal(r.duplicateGroups, 1);
    assert.equal(r.invalidated, 1);

    // Canonical (oldest) preserved; duplicate invalidated
    assert.equal(getContextItem(a.id).invalid_at, null);
    assert.ok(getContextItem(b.id).invalid_at);
  });

  it('singleton items are not flagged', async () => {
    addContextItem({
      project: 'demo', scopeType: 'project', memoryType: 'semantic',
      title: 'lonely', content: 'unique', sourceType: 'human',
    });
    const r = await compactContextHandler({ project: 'demo', dryRun: true });
    assert.equal(r.duplicateGroups, 0);
    assert.deepEqual(r.candidates, []);
  });

  it('rejects bad scopeType / memoryType', async () => {
    await assert.rejects(
      () => compactContextHandler({ project: 'demo', scopeType: 'galactic' }),
      /scopeType/,
    );
    await assert.rejects(
      () => compactContextHandler({ project: 'demo', memoryType: 'martian' }),
      /memoryType/,
    );
  });

  it('throws on missing project', async () => {
    await assert.rejects(() => compactContextHandler({}), /project/);
  });
});
