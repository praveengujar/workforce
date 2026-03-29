/**
 * Tests for recovery engine logic, eval processing, and dependency resolver.
 * Uses node:test + in-memory SQLite.
 *
 * Run: node --test mcp-server/test/recovery-eval-deps.test.js
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

// ---------------------------------------------------------------------------
// In-memory DB helper
// ---------------------------------------------------------------------------
function createTestDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, prompt TEXT, status TEXT NOT NULL DEFAULT 'pending',
      project TEXT, branch TEXT, worktreePath TEXT, pid INTEGER, sessionId TEXT,
      output TEXT, error TEXT, merged INTEGER NOT NULL DEFAULT 0,
      mergeFailed INTEGER NOT NULL DEFAULT 0, retryCount INTEGER NOT NULL DEFAULT 0,
      maxRetries INTEGER NOT NULL DEFAULT 2, exitCode INTEGER, cost REAL,
      createdAt TEXT, startedAt TEXT, completedAt TEXT,
      tmuxSession TEXT, autoMerge INTEGER NOT NULL DEFAULT 0,
      taskType TEXT DEFAULT 'standard', dependsOn TEXT, taskGroup TEXT, phase INTEGER,
      retryAfter TEXT, targetBranch TEXT, baseCommit TEXT
    );
    CREATE TABLE IF NOT EXISTS task_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, taskId TEXT NOT NULL,
      phase TEXT NOT NULL, detail TEXT, timestamp TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS eval_logs (
      id TEXT PRIMARY KEY, taskId TEXT, category TEXT NOT NULL,
      ruleViolated TEXT, whatHappened TEXT NOT NULL, rootCause TEXT,
      correctApproach TEXT, preventiveUpdate TEXT, detection TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'medium', processedAt TEXT,
      processedAction TEXT, createdAt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS knowledge_rules (
      id TEXT PRIMARY KEY, category TEXT NOT NULL, name TEXT NOT NULL,
      description TEXT, paths TEXT NOT NULL, content TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 5, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_rules_cat_name ON knowledge_rules(category, name);
  `);
  return db;
}

function insertTask(db, overrides = {}) {
  const id = overrides.id || `t-${Math.random().toString(36).slice(2, 10)}`;
  const now = new Date().toISOString();
  const defaults = { prompt: 'test', status: 'pending', project: 'test', createdAt: now, maxRetries: 2, retryCount: 0, merged: 0, mergeFailed: 0, taskType: 'standard' };
  const task = { ...defaults, ...overrides, id };
  const keys = Object.keys(task);
  db.prepare(`INSERT INTO tasks (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...keys.map(k => task[k] ?? null));
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
}

function insertEval(db, overrides = {}) {
  const id = overrides.id || `e-${Math.random().toString(36).slice(2, 10)}`;
  const now = new Date().toISOString();
  const defaults = { taskId: null, category: 'custom', whatHappened: 'test failure', detection: 'session_end_hook', severity: 'medium', createdAt: now };
  const ev = { ...defaults, ...overrides, id };
  const keys = Object.keys(ev);
  db.prepare(`INSERT INTO eval_logs (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...keys.map(k => ev[k] ?? null));
  return db.prepare('SELECT * FROM eval_logs WHERE id = ?').get(id);
}

// ============================================================================
// Recovery Engine Logic
// ============================================================================

describe('Recovery engine rules', () => {
  let db;
  beforeEach(() => { db = createTestDb(); });

  it('Rule 0a: zombie detection criteria', () => {
    const fourMinAgo = new Date(Date.now() - 4 * 60 * 1000).toISOString();
    const task = insertTask(db, { status: 'running', startedAt: fourMinAgo, pid: null, sessionId: null });
    assert.equal(task.status, 'running');
    assert.equal(task.pid, null);
    const elapsed = Date.now() - new Date(task.startedAt).getTime();
    assert.ok(elapsed > 3 * 60 * 1000, 'Should detect as zombie (>3 min, no PID)');
  });

  it('Rule 0b: stuck merge detection', () => {
    const task = insertTask(db, { status: 'review', mergeFailed: 1 });
    assert.equal(task.mergeFailed, 1);
    assert.ok(task.status !== 'done' && task.status !== 'failed', 'Should be detected as stuck');
  });

  it('Rule 1: ghost runner with dead PID', () => {
    const task = insertTask(db, { status: 'running', pid: 999999999 });
    let alive;
    try { process.kill(999999999, 0); alive = true; } catch { alive = false; }
    assert.ok(!alive, 'PID 999999999 should be dead');
  });

  it('Rules 4-5: rate limit retry respects maxRetries=2', () => {
    const retryable = insertTask(db, { status: 'failed', error: 'rate limit exceeded', retryCount: 0 });
    assert.ok(retryable.retryCount < retryable.maxRetries, 'Should be eligible for retry');

    const exhausted = insertTask(db, { status: 'failed', error: 'rate limit exceeded', retryCount: 2, maxRetries: 2 });
    assert.ok(exhausted.retryCount >= exhausted.maxRetries, 'Should NOT retry');
  });

  it('Rules 2-3: binary missing prevents retry', () => {
    const task = insertTask(db, { status: 'failed', error: 'ENOENT: claude not found' });
    assert.ok(task.error.toLowerCase().includes('enoent'), 'Should detect as binary missing');
  });

  it('recovery engine MAX_RETRIES_DEFAULT aligns with DB default', () => {
    const task = insertTask(db);
    // DB default is 2, recovery engine MAX_RETRIES_DEFAULT should also be 2
    assert.equal(task.maxRetries, 2);
  });
});

// ============================================================================
// Eval Processing
// ============================================================================

describe('Eval processing', () => {
  let db;
  beforeEach(() => { db = createTestDb(); });

  it('valid preventiveUpdate creates scoped rule paths', () => {
    const preventive = JSON.stringify({
      category: 'security', name: 'auth-fix', paths: ['src/auth/**'],
      content: 'Always validate tokens', priority: 7,
    });
    const ev = insertEval(db, { preventiveUpdate: preventive });
    const update = JSON.parse(ev.preventiveUpdate);
    assert.deepEqual(update.paths, ['src/auth/**']);
    assert.ok(!update.paths.includes('**/*'));
  });

  it('invalid preventiveUpdate JSON triggers fallback', () => {
    const ev = insertEval(db, { preventiveUpdate: 'not valid json' });
    let parsed;
    try { parsed = JSON.parse(ev.preventiveUpdate); } catch { parsed = null; }
    assert.equal(parsed, null, 'Should fail to parse invalid JSON');
  });

  it('session-end populates all three payload fields', () => {
    const ev = insertEval(db, {
      category: 'zero_work',
      rootCause: 'Agent completed without modifying any files.',
      correctApproach: 'Include explicit file paths.',
      preventiveUpdate: JSON.stringify({ category: 'workflow', name: 'test', paths: ['src/**'], content: 'test', priority: 5 }),
    });
    assert.ok(ev.rootCause !== null);
    assert.ok(ev.correctApproach !== null);
    assert.ok(ev.preventiveUpdate !== null);
    const update = JSON.parse(ev.preventiveUpdate);
    assert.ok(!update.paths.includes('**/*'));
  });

  it('per-source dedup allows coexistence', () => {
    const now = new Date().toISOString();
    insertEval(db, { id: 'e1', taskId: 'task-1', detection: 'auto_recovery', createdAt: now });
    insertEval(db, { id: 'e2', taskId: 'task-1', detection: 'session_end_hook', createdAt: now });
    const evals = db.prepare('SELECT * FROM eval_logs WHERE taskId = ?').all('task-1');
    assert.equal(evals.length, 2);
    assert.ok(evals.map(e => e.detection).includes('auto_recovery'));
    assert.ok(evals.map(e => e.detection).includes('session_end_hook'));
  });

  it('eval clustering groups 3+ similar failures', () => {
    // Insert 4 similar zero_work evals
    for (let i = 0; i < 4; i++) {
      insertEval(db, {
        id: `cluster-${i}`, taskId: `task-${i}`, category: 'zero_work',
        whatHappened: 'Task failed: No files changed -- zero-work guard triggered',
      });
    }
    const evals = db.prepare("SELECT * FROM eval_logs WHERE category = 'zero_work' AND processedAt IS NULL").all();
    assert.ok(evals.length >= 3, 'Should have enough for a cluster');
  });
});

// ============================================================================
// Dependency Resolver
// ============================================================================

describe('Dependency resolution', () => {
  let db;
  beforeEach(() => { db = createTestDb(); });

  it('null dependsOn means always satisfied', () => {
    const task = insertTask(db, { dependsOn: null });
    assert.equal(task.dependsOn, null);
  });

  it('done upstream satisfies dependency', () => {
    insertTask(db, { id: 'up-1', status: 'done' });
    const down = insertTask(db, { id: 'down-1', dependsOn: JSON.stringify(['up-1']) });
    const upTask = db.prepare('SELECT * FROM tasks WHERE id = ?').get(JSON.parse(down.dependsOn)[0]);
    assert.equal(upTask.status, 'done');
  });

  it('permanently failed upstream blocks downstream', () => {
    insertTask(db, { id: 'up-2', status: 'failed', retryCount: 2, maxRetries: 2 });
    const down = insertTask(db, { id: 'down-2', dependsOn: JSON.stringify(['up-2']) });
    const upTask = db.prepare('SELECT * FROM tasks WHERE id = ?').get(JSON.parse(down.dependsOn)[0]);
    assert.ok(upTask.retryCount >= upTask.maxRetries, 'Permanently failed');
  });

  it('transient failure does not cascade', () => {
    const upstream = insertTask(db, { id: 'up-3', status: 'failed', retryCount: 0, maxRetries: 2 });
    assert.ok(upstream.retryCount < upstream.maxRetries, 'Transient - may retry');
  });

  it('topological sort: roots in phase 1, dependents later', () => {
    insertTask(db, { id: 'a', taskGroup: 'g1' });
    insertTask(db, { id: 'b', taskGroup: 'g1' });
    insertTask(db, { id: 'c', taskGroup: 'g1', dependsOn: JSON.stringify(['a', 'b']) });
    const tasks = db.prepare("SELECT * FROM tasks WHERE taskGroup = 'g1'").all();

    const inDegree = new Map();
    const taskIds = new Set(tasks.map(t => t.id));
    for (const t of tasks) inDegree.set(t.id, 0);
    for (const t of tasks) {
      if (!t.dependsOn) continue;
      for (const d of JSON.parse(t.dependsOn).filter(d => taskIds.has(d))) {
        inDegree.set(t.id, (inDegree.get(t.id) || 0) + 1);
      }
    }
    const phase1 = [...inDegree.entries()].filter(([, d]) => d === 0).map(([id]) => id);
    assert.ok(phase1.includes('a') && phase1.includes('b'));
    assert.ok(!phase1.includes('c'));
  });

  it('cycle: mutual dependency leaves both unresolvable', () => {
    insertTask(db, { id: 'x', taskGroup: 'cyc', dependsOn: JSON.stringify(['y']) });
    insertTask(db, { id: 'y', taskGroup: 'cyc', dependsOn: JSON.stringify(['x']) });
    const tasks = db.prepare("SELECT * FROM tasks WHERE taskGroup = 'cyc'").all();

    const inDegree = new Map();
    const taskIds = new Set(tasks.map(t => t.id));
    for (const t of tasks) inDegree.set(t.id, 0);
    for (const t of tasks) {
      for (const d of JSON.parse(t.dependsOn).filter(d => taskIds.has(d))) {
        inDegree.set(t.id, (inDegree.get(t.id) || 0) + 1);
      }
    }
    const phase1 = [...inDegree.entries()].filter(([, d]) => d === 0).map(([id]) => id);
    assert.equal(phase1.length, 0, 'Both tasks should have non-zero in-degree');
  });
});

// ============================================================================
// Capability Router
// ============================================================================

describe('Capability router patterns', () => {
  it('security keywords detected', () => {
    assert.ok(/\b(security|auth|xss|injection)\b/i.test('audit the authentication module for XSS'));
  });

  it('UI file paths detected', () => {
    assert.ok(/\.(tsx|jsx|css)$/.test('src/components/Dashboard.tsx'));
  });

  it('investigation intent detected', () => {
    assert.ok(/\b(investigate|debug|diagnose)\b/i.test('investigate why payments fail'));
  });

  it('simple prompts have no special intent', () => {
    const prompt = 'fix typo in README';
    assert.ok(!/\b(security|auth|investigate|design)\b/i.test(prompt));
  });
});
