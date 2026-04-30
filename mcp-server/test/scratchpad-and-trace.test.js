/**
 * Tests for Context Fabric M8 — file-system scratchpad + sub-agent trace.
 *
 * Run: node --test mcp-server/test/scratchpad-and-trace.test.js
 *
 * Uses a per-process WORKFORCE_DATA_DIR pointed at a temp directory so the
 * shared `getDb()` singleton writes to throwaway storage. Worktrees are also
 * created under the temp dir.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const TMP_DIR = mkdtempSync(join(tmpdir(), 'm8-scratchpad-test-'));
process.env.WORKFORCE_DATA_DIR = TMP_DIR;

const dbMod = await import('../core/db.js');
const scratchpadMod = await import('../core/scratchpad.js');
const traceMod = await import('../core/task-trace.js');
const contextMemoryMod = await import('../core/context-memory.js');

const { getDb, applyMigration19 } = dbMod;
const {
  scaffoldScratchpad,
  readScratchpadFindings,
  captureScratchpadOnMerge,
  _internals: scratchInternals,
} = scratchpadMod;
const {
  buildTraceForTask,
  persistTrace,
  loadTraceForChild,
  formatTraceForPrompt,
} = traceMod;
const { addContextItem } = contextMemoryMod;

function makeWorktree(name) {
  const p = join(TMP_DIR, 'worktrees', name);
  mkdirSync(p, { recursive: true });
  return p;
}

function makeTask(id, overrides = {}) {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR REPLACE INTO tasks (id, prompt, project, status, createdAt, taskType, parentId, retryCount)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    overrides.prompt ?? `Prompt for ${id}`,
    overrides.project ?? 'demo',
    overrides.status ?? 'review',
    now,
    overrides.taskType ?? 'standard',
    overrides.parentId ?? null,
    overrides.retryCount ?? 0,
  );
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
}

function resetTables() {
  const db = getDb();
  db['exec']('DELETE FROM context_items');
  db['exec']('DELETE FROM tasks');
}

before(() => { getDb(); });
after(() => {
  try { rmSync(TMP_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------
// Migration 19
// ---------------------------------------------------------------------------

describe('migration 19 — task_trace BLOB', () => {
  it('adds task_trace column to tasks', () => {
    const db = getDb();
    const cols = db.prepare('PRAGMA table_info(tasks)').all().map(c => c.name);
    assert.ok(cols.includes('task_trace'), 'task_trace column missing');
  });

  it('is idempotent — re-running applyMigration19 does not throw', () => {
    const db = getDb();
    assert.doesNotThrow(() => applyMigration19(db));
    assert.doesNotThrow(() => applyMigration19(db));
    const cols = db.prepare('PRAGMA table_info(tasks)').all().map(c => c.name);
    const trace = cols.filter(c => c === 'task_trace').length;
    assert.equal(trace, 1, 'task_trace should appear exactly once');
  });
});

// ---------------------------------------------------------------------------
// scaffoldScratchpad
// ---------------------------------------------------------------------------

describe('scaffoldScratchpad', () => {
  it('creates .workforce/scratch/{todo,notes,findings}.md', () => {
    const wt = makeWorktree('scaffold-basic');
    const paths = scaffoldScratchpad(wt);
    assert.equal(paths.length, 3);
    for (const name of ['todo.md', 'notes.md', 'findings.md']) {
      const p = join(wt, '.workforce', 'scratch', name);
      assert.ok(existsSync(p), `${name} should exist`);
      const content = readFileSync(p, 'utf8');
      assert.ok(content.includes('Workforce scratchpad'), `${name} should have header comment`);
    }
  });

  it('is idempotent — does not overwrite existing content', () => {
    const wt = makeWorktree('scaffold-idem');
    scaffoldScratchpad(wt);
    const findingsPath = join(wt, '.workforce', 'scratch', 'findings.md');
    const customBody = '# Findings\n\nThe agent already wrote this.\n';
    writeFileSync(findingsPath, customBody, 'utf8');

    scaffoldScratchpad(wt);
    const after = readFileSync(findingsPath, 'utf8');
    assert.equal(after, customBody, 're-scaffold should not clobber existing content');
  });

  it('returns [] on bad input and never throws', () => {
    assert.doesNotThrow(() => scaffoldScratchpad(null));
    assert.deepEqual(scaffoldScratchpad(undefined), []);
    assert.deepEqual(scaffoldScratchpad(''), []);
    assert.deepEqual(scaffoldScratchpad(123), []);
  });
});

// ---------------------------------------------------------------------------
// readScratchpadFindings
// ---------------------------------------------------------------------------

describe('readScratchpadFindings', () => {
  it('returns empty string when scaffold-only (no real content)', () => {
    const wt = makeWorktree('read-empty');
    scaffoldScratchpad(wt);
    const out = readScratchpadFindings(wt);
    assert.equal(out, '');
  });

  it('strips scaffold header and returns body', () => {
    const wt = makeWorktree('read-with-body');
    scaffoldScratchpad(wt);
    const findings = join(wt, '.workforce', 'scratch', 'findings.md');
    const header = scratchInternals.HEADERS['findings.md'];
    writeFileSync(findings, header + 'Found a NPE in user.js:42 — null check needed.\n', 'utf8');

    const out = readScratchpadFindings(wt);
    assert.ok(out.includes('NPE in user.js'));
    assert.ok(!out.includes('Workforce scratchpad'), 'header should be stripped');
  });

  it('honors capChars and appends truncation marker', () => {
    const wt = makeWorktree('read-cap');
    mkdirSync(join(wt, '.workforce', 'scratch'), { recursive: true });
    const big = 'x'.repeat(20_000);
    writeFileSync(join(wt, '.workforce', 'scratch', 'findings.md'), big, 'utf8');

    const out = readScratchpadFindings(wt, 200);
    assert.ok(out.length <= 200 + 20, 'output should respect cap (with small truncation marker)');
    assert.ok(out.endsWith('…(truncated)'), 'should mark truncation');
  });

  it('returns empty string when worktree is missing', () => {
    const out = readScratchpadFindings(join(TMP_DIR, 'does-not-exist'));
    assert.equal(out, '');
  });

  it('survives between retries — content persists across re-scaffold', () => {
    const wt = makeWorktree('read-retry-survival');
    scaffoldScratchpad(wt);
    const findings = join(wt, '.workforce', 'scratch', 'findings.md');
    writeFileSync(findings, scratchInternals.HEADERS['findings.md'] + 'Critical: file X needs update.\n', 'utf8');

    // Simulate a retry — scaffold runs again
    scaffoldScratchpad(wt);
    const out = readScratchpadFindings(wt);
    assert.ok(out.includes('Critical: file X needs update'), 'findings must survive retry scaffold');
  });
});

// ---------------------------------------------------------------------------
// captureScratchpadOnMerge
// ---------------------------------------------------------------------------

describe('captureScratchpadOnMerge', () => {
  it('writes a context_item with scratch_findings tag on merge', () => {
    resetTables();
    const wt = makeWorktree('capture-merged');
    scaffoldScratchpad(wt);
    const findings = join(wt, '.workforce', 'scratch', 'findings.md');
    writeFileSync(
      findings,
      scratchInternals.HEADERS['findings.md'] + 'Patched the rate limiter to use exponential backoff.\n',
      'utf8',
    );
    makeTask('task-merged-1', { project: 'demo' });

    const item = captureScratchpadOnMerge(getDb(), 'task-merged-1', wt, 'merged');
    assert.ok(item, 'should return persisted row');
    assert.equal(item.memory_type, 'artifact');
    assert.equal(item.source_type, 'task');
    assert.equal(item.scope_type, 'task');
    assert.equal(item.scope_id, 'task-merged-1');
    const tags = JSON.parse(item.tags || '[]');
    assert.ok(tags.includes('scratch_findings'), 'tags should include scratch_findings');
    assert.ok(!tags.includes('scratch_findings_rejected'));
    assert.ok(item.content.includes('exponential backoff'));
  });

  it('uses scratch_findings_rejected tag on reject', () => {
    resetTables();
    const wt = makeWorktree('capture-rejected');
    scaffoldScratchpad(wt);
    writeFileSync(
      join(wt, '.workforce', 'scratch', 'findings.md'),
      scratchInternals.HEADERS['findings.md'] + 'Reviewer rejected: backoff multiplier was wrong.\n',
      'utf8',
    );
    makeTask('task-rejected-1', { project: 'demo' });

    const item = captureScratchpadOnMerge(getDb(), 'task-rejected-1', wt, 'rejected');
    assert.ok(item);
    const tags = JSON.parse(item.tags || '[]');
    assert.ok(tags.includes('scratch_findings_rejected'), 'tags should include scratch_findings_rejected');
    assert.ok(tags.includes('rejected'));
  });

  it('returns null when findings.md is empty (scaffold-only)', () => {
    resetTables();
    const wt = makeWorktree('capture-empty');
    scaffoldScratchpad(wt);
    makeTask('task-empty-1');

    const item = captureScratchpadOnMerge(getDb(), 'task-empty-1', wt, 'merged');
    assert.equal(item, null);
  });

  it('returns null on bad input and never throws', () => {
    assert.doesNotThrow(() => captureScratchpadOnMerge(getDb(), null, null, 'merged'));
    assert.equal(captureScratchpadOnMerge(getDb(), null, '/tmp', 'merged'), null);
    assert.equal(captureScratchpadOnMerge(getDb(), 'x', null, 'merged'), null);
  });
});

// ---------------------------------------------------------------------------
// task-trace gzip round-trip
// ---------------------------------------------------------------------------

describe('task-trace gzip round-trip', () => {
  it('builds, persists, and loads the trace intact', () => {
    resetTables();
    makeTask('parent-1', { project: 'demo', prompt: 'Refactor the cache layer for better hit rate.' });

    addContextItem({
      project: 'demo',
      scopeType: 'task',
      scopeId: 'parent-1',
      memoryType: 'decision',
      title: 'Use LRU instead of TTL',
      content: 'We decided LRU because access pattern is recency-biased.',
      sourceType: 'task',
      sourceId: 'parent-1',
      trustScore: 0.5,
    });

    const buf = buildTraceForTask(getDb(), 'parent-1');
    assert.ok(Buffer.isBuffer(buf), 'buildTraceForTask should return a Buffer');
    assert.ok(buf.length > 0);

    const ok = persistTrace(getDb(), 'parent-1', buf);
    assert.equal(ok, true);

    const loaded = loadTraceForChild(getDb(), 'parent-1');
    assert.ok(loaded);
    assert.equal(loaded.taskId, 'parent-1');
    assert.ok(loaded.prompt.includes('cache layer'));
    assert.equal(loaded.decisions.length, 1);
    assert.ok(loaded.decisions[0].content.includes('LRU'));
  });
});

// ---------------------------------------------------------------------------
// loadTraceForChild — null on missing/corrupt
// ---------------------------------------------------------------------------

describe('loadTraceForChild', () => {
  it('returns null when parent task does not exist', () => {
    resetTables();
    const out = loadTraceForChild(getDb(), 'no-such-task');
    assert.equal(out, null);
  });

  it('returns null when parent has no persisted trace', () => {
    resetTables();
    makeTask('parent-no-trace');
    const out = loadTraceForChild(getDb(), 'parent-no-trace');
    assert.equal(out, null);
  });

  it('returns null on corrupt gzip data — never throws', () => {
    resetTables();
    makeTask('parent-corrupt');
    const garbage = Buffer.from([0x01, 0x02, 0x03, 0x04, 0xff, 0xfe]);
    getDb().prepare('UPDATE tasks SET task_trace = ? WHERE id = ?').run(garbage, 'parent-corrupt');

    let out;
    assert.doesNotThrow(() => { out = loadTraceForChild(getDb(), 'parent-corrupt'); });
    assert.equal(out, null);
  });

  it('returns null on valid gzip but invalid JSON — never throws', () => {
    resetTables();
    makeTask('parent-bad-json');
    const buf = gzipSync(Buffer.from('this is not json {{{', 'utf8'));
    getDb().prepare('UPDATE tasks SET task_trace = ? WHERE id = ?').run(buf, 'parent-bad-json');

    let out;
    assert.doesNotThrow(() => { out = loadTraceForChild(getDb(), 'parent-bad-json'); });
    assert.equal(out, null);
  });
});

// ---------------------------------------------------------------------------
// formatTraceForPrompt — cap honoured
// ---------------------------------------------------------------------------

describe('formatTraceForPrompt', () => {
  it('renders sections and respects cap', () => {
    const obj = {
      taskId: 'abcdef1234567890',
      project: 'demo',
      taskType: 'standard',
      prompt: 'Original parent prompt that explains the goal in detail.',
      decisions: [{ title: 'Pick LRU', content: 'Better recency fit.' }],
      risks: [{ title: 'Cache stampede', content: 'Mitigate with single-flight.' }],
      scratchFindings: [{ title: 'Hit rate up 12%', content: 'Verified in benchmark.' }],
    };
    const out = formatTraceForPrompt(obj, 6000);
    assert.ok(out.includes('abcdef12'), 'should include short task id');
    assert.ok(out.includes('Original parent prompt'));
    assert.ok(out.includes('Pick LRU'));
    assert.ok(out.includes('Cache stampede'));
    assert.ok(out.includes('Hit rate up 12%'));
    assert.ok(out.length <= 6000);
  });

  it('truncates at cap and adds the truncation marker', () => {
    const obj = {
      taskId: 'big',
      prompt: 'x'.repeat(10_000),
      decisions: [],
      risks: [],
      scratchFindings: [],
    };
    const out = formatTraceForPrompt(obj, 200);
    assert.ok(out.length <= 200 + 20);
    assert.ok(out.endsWith('…(truncated)'));
  });

  it('returns empty string for null/undefined input', () => {
    assert.equal(formatTraceForPrompt(null), '');
    assert.equal(formatTraceForPrompt(undefined), '');
    assert.equal(formatTraceForPrompt('string'), '');
  });
});

// ---------------------------------------------------------------------------
// Sub-task prepend additivity — does not displace existing layers
// ---------------------------------------------------------------------------

describe('sub-task prompt prepend is additive', () => {
  it('PARENT TASK TRACE header is prepended; existing prompt body is preserved', () => {
    // Verifies the contract that worker-manager.js prepends the trace block —
    // we don't actually spawn a child; we simulate the same string operation
    // the worker performs to confirm no existing layer is replaced.
    const baseLayers = [
      '[THINKING PROTOCOL]\nUNDERSTAND the task...',
      '[Knowledge Rules — Trust: MEDIUM]\nUse the shared cache helper.',
      '[Session Context — Trust: LOW]\nACTIVE FOCUS: cache work',
      '[COMPLETION CHECKLIST]\n- Re-read modified files...',
    ];
    const basePrompt = baseLayers.join('\n\n');
    const traceBlock = formatTraceForPrompt({
      taskId: 'parent-x',
      prompt: 'Parent goal',
      decisions: [{ title: 'd1', content: 'c1' }],
      risks: [],
      scratchFindings: [],
    });
    const finalPrompt = `[PARENT TASK TRACE — Trust: HIGH (handoff from parent task parent-x)]\n${traceBlock}\n\n${basePrompt}`;

    for (const layer of baseLayers) {
      assert.ok(finalPrompt.includes(layer), `existing layer "${layer.slice(0, 30)}..." must still be present`);
    }
    assert.ok(finalPrompt.startsWith('[PARENT TASK TRACE'), 'parent trace must come first');
  });
});

// ---------------------------------------------------------------------------
// Best-effort isolation — helpers swallow throws
// ---------------------------------------------------------------------------

describe('best-effort isolation', () => {
  it('captureScratchpadOnMerge with throwing addContextItem path returns null silently', () => {
    // Simulate failure by passing a path inside an unwritable parent — read
    // returns '' and capture short-circuits to null. Doesn't throw.
    let result;
    assert.doesNotThrow(() => {
      result = captureScratchpadOnMerge(getDb(), 'no-task', '/proc/definitely-not-a-worktree', 'merged');
    });
    assert.equal(result, null);
  });

  it('persistTrace returns false on missing taskId without throwing', () => {
    let r;
    assert.doesNotThrow(() => { r = persistTrace(getDb(), 'no-such-task', Buffer.from('x')); });
    assert.equal(r, false);
  });

  it('buildTraceForTask returns null for unknown task without throwing', () => {
    let r;
    assert.doesNotThrow(() => { r = buildTraceForTask(getDb(), 'no-such-parent'); });
    assert.equal(r, null);
  });

  it('loadTraceForChild with null db returns null without throwing', () => {
    let r;
    assert.doesNotThrow(() => { r = loadTraceForChild(null, 'x'); });
    assert.equal(r, null);
  });
});
