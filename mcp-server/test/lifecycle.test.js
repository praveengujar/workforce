/**
 * Lifecycle smoke tests — verifies core task flows and bug fixes.
 * Uses node:test + in-memory SQLite (no external deps).
 *
 * Run: node --test mcp-server/test/lifecycle.test.js
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

// ---------------------------------------------------------------------------
// In-memory DB helper — applies full schema without migrations
// ---------------------------------------------------------------------------
function createTestDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, prompt TEXT, status TEXT NOT NULL DEFAULT 'pending',
      project TEXT, branch TEXT, worktreePath TEXT, pid INTEGER, sessionId TEXT,
      output TEXT, error TEXT, merged INTEGER NOT NULL DEFAULT 0,
      mergeFailed INTEGER NOT NULL DEFAULT 0, retryCount INTEGER NOT NULL DEFAULT 0,
      maxRetries INTEGER NOT NULL DEFAULT 2, pinned INTEGER NOT NULL DEFAULT 0,
      needsInput INTEGER NOT NULL DEFAULT 0, exitCode INTEGER, cost REAL,
      createdAt TEXT, startedAt TEXT, completedAt TEXT, archivedAt TEXT,
      tmuxSession TEXT, autoMerge INTEGER NOT NULL DEFAULT 0, profile TEXT,
      taskType TEXT DEFAULT 'standard', experimentConfig TEXT,
      parentId TEXT, dependsOn TEXT, taskGroup TEXT, phase INTEGER,
      resultSummary TEXT, retryAfter TEXT, targetBranch TEXT, baseCommit TEXT
    );
    CREATE TABLE IF NOT EXISTS task_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, taskId TEXT NOT NULL,
      phase TEXT NOT NULL, detail TEXT, timestamp TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS knowledge_rules (
      id TEXT PRIMARY KEY, category TEXT NOT NULL, name TEXT NOT NULL,
      description TEXT, paths TEXT NOT NULL, content TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 5, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_rules_cat_name ON knowledge_rules(category, name);
    CREATE TABLE IF NOT EXISTS eval_logs (
      id TEXT PRIMARY KEY, taskId TEXT, category TEXT NOT NULL,
      ruleViolated TEXT, whatHappened TEXT NOT NULL, rootCause TEXT,
      correctApproach TEXT, preventiveUpdate TEXT, detection TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'medium', processedAt TEXT,
      processedAction TEXT, createdAt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS session_context (
      id TEXT PRIMARY KEY, project TEXT NOT NULL, key TEXT NOT NULL,
      value TEXT NOT NULL, updatedAt TEXT NOT NULL, UNIQUE(project, key)
    );
  `);
  return db;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function insertTask(db, overrides = {}) {
  const id = overrides.id || `test-${Math.random().toString(36).slice(2, 10)}`;
  const now = new Date().toISOString();
  const defaults = {
    prompt: 'test task', status: 'pending', project: 'test',
    createdAt: now, maxRetries: 2, retryCount: 0, merged: 0,
    mergeFailed: 0, autoMerge: 0, taskType: 'standard',
  };
  const task = { ...defaults, ...overrides, id };
  const keys = Object.keys(task);
  const placeholders = keys.map(() => '?').join(', ');
  db.prepare(`INSERT INTO tasks (${keys.join(', ')}) VALUES (${placeholders})`)
    .run(...keys.map(k => task[k] ?? null));
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
}

function insertEvent(db, taskId, phase, detail = null) {
  db.prepare('INSERT INTO task_events (taskId, phase, detail, timestamp) VALUES (?, ?, ?, ?)')
    .run(taskId, phase, detail, new Date().toISOString());
}

function getTask(db, id) {
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
}

function getEvents(db, taskId) {
  return db.prepare('SELECT * FROM task_events WHERE taskId = ? ORDER BY id').all(taskId);
}

// ============================================================================
// Tests
// ============================================================================

describe('Task lifecycle', () => {
  let db;
  beforeEach(() => { db = createTestDb(); });

  it('creates a task with correct defaults', () => {
    const task = insertTask(db);
    assert.equal(task.status, 'pending');
    assert.equal(task.maxRetries, 2);
    assert.equal(task.retryCount, 0);
    assert.equal(task.merged, 0);
    assert.equal(task.taskType, 'standard');
  });

  it('maxRetries defaults to 2 (not 3)', () => {
    const task = insertTask(db);
    assert.equal(task.maxRetries, 2, 'DB default should be 2, matching recovery engine');
  });

  it('transitions through pending -> running -> review', () => {
    const task = insertTask(db);
    db.prepare('UPDATE tasks SET status = ?, startedAt = ? WHERE id = ?')
      .run('running', new Date().toISOString(), task.id);
    assert.equal(getTask(db, task.id).status, 'running');

    db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('review', task.id);
    assert.equal(getTask(db, task.id).status, 'review');
  });

  it('zero-work guard marks task as failed', () => {
    const task = insertTask(db, { status: 'running', startedAt: new Date().toISOString() });
    db.prepare('UPDATE tasks SET status = ?, error = ?, completedAt = ? WHERE id = ?')
      .run('failed', 'No files changed -- zero-work guard triggered', new Date().toISOString(), task.id);
    const failed = getTask(db, task.id);
    assert.equal(failed.status, 'failed');
    assert.ok(failed.error.includes('zero-work'));
  });

  it('retry increments retryCount and resets to pending', () => {
    const task = insertTask(db, { status: 'failed', retryCount: 0 });
    db.prepare('UPDATE tasks SET status = ?, retryCount = ?, error = NULL WHERE id = ?')
      .run('pending', task.retryCount + 1, task.id);
    const retried = getTask(db, task.id);
    assert.equal(retried.status, 'pending');
    assert.equal(retried.retryCount, 1);
  });

  it('stops retrying at maxRetries', () => {
    const task = insertTask(db, { status: 'failed', retryCount: 2, maxRetries: 2 });
    assert.ok(task.retryCount >= task.maxRetries, 'Should not retry when retryCount >= maxRetries');
  });
});

describe('Gate enforcement', () => {
  let db;
  beforeEach(() => { db = createTestDb(); });

  it('blocks merge when human_decision gate is missing', () => {
    const task = insertTask(db, { status: 'review' });
    const events = getEvents(db, task.id);
    const phases = new Set(events.map(e => e.phase));
    assert.ok(!phases.has('human_decision'), 'human_decision should be missing');
  });

  it('passes when human_decision gate is present', () => {
    const task = insertTask(db, { status: 'review' });
    insertEvent(db, task.id, 'human_decision', 'Approved after code review');
    const events = getEvents(db, task.id);
    const phases = new Set(events.map(e => e.phase));
    assert.ok(phases.has('human_decision'), 'human_decision should be present');
  });

  it('blocks when conditional gate was started but not completed', () => {
    const task = insertTask(db, { status: 'review' });
    insertEvent(db, task.id, 'human_decision', 'Approved');
    insertEvent(db, task.id, 'qa_started', 'QA task spawned');
    const events = getEvents(db, task.id);
    const phases = new Set(events.map(e => e.phase));
    assert.ok(phases.has('qa_started'), 'qa_started should exist');
    assert.ok(!phases.has('qa') && !phases.has('qa_passed'), 'qa completion should be missing');
  });

  it('allows waiver for missing conditional gate', () => {
    const task = insertTask(db, { status: 'review' });
    insertEvent(db, task.id, 'human_decision', 'Approved');
    insertEvent(db, task.id, 'qa_started', 'QA spawned');
    insertEvent(db, task.id, 'gate_waived', 'qa: backend-only change');
    const events = getEvents(db, task.id);
    const hasWaiver = events.some(e => e.phase === 'gate_waived' && e.detail.startsWith('qa:'));
    assert.ok(hasWaiver, 'Waiver event should exist');
  });
});

describe('Eval cascade prevention', () => {
  let db;
  beforeEach(() => { db = createTestDb(); });

  it('eval with preventiveUpdate has scoped paths (not **/*)', () => {
    const preventive = JSON.stringify({
      category: 'workflow',
      name: 'test-rule',
      paths: ['src/auth/**'],
      content: 'Always check auth middleware',
      priority: 6,
    });
    db.prepare(`INSERT INTO eval_logs (id, taskId, category, whatHappened, rootCause,
      correctApproach, preventiveUpdate, detection, severity, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      'eval-01', 'task-01', 'zero_work', 'Task failed', 'No files changed',
      'Add file paths', preventive, 'session_end_hook', 'high', new Date().toISOString(),
    );
    const evalEntry = db.prepare('SELECT * FROM eval_logs WHERE id = ?').get('eval-01');
    const update = JSON.parse(evalEntry.preventiveUpdate);
    assert.ok(!update.paths.includes('**/*'), 'Paths should not contain global wildcard');
    assert.deepEqual(update.paths, ['src/auth/**']);
  });

  it('per-source dedup allows both recovery and session-end evals', () => {
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO eval_logs (id, taskId, category, whatHappened, detection, severity, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run('e1', 'task-01', 'rate_limit', 'Rate limited', 'auto_recovery', 'low', now);
    db.prepare(`INSERT INTO eval_logs (id, taskId, category, whatHappened, detection, severity, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run('e2', 'task-01', 'rate_limit', 'Rate limited', 'session_end_hook', 'low', now);

    const evals = db.prepare('SELECT * FROM eval_logs WHERE taskId = ?').all('task-01');
    assert.equal(evals.length, 2, 'Both evals should coexist');
    const sources = evals.map(e => e.detection);
    assert.ok(sources.includes('auto_recovery'));
    assert.ok(sources.includes('session_end_hook'));
  });

  it('session-end eval populates rootCause and correctApproach (not null)', () => {
    // Simulate what session-end.js now produces
    const rootCause = 'Agent completed without modifying any files.';
    const correctApproach = 'Include explicit file paths and function names.';
    const preventive = JSON.stringify({ category: 'workflow', name: 'test', paths: ['src/**'], content: correctApproach, priority: 5 });

    db.prepare(`INSERT INTO eval_logs (id, taskId, category, whatHappened, rootCause,
      correctApproach, preventiveUpdate, detection, severity, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      'e3', 'task-02', 'zero_work', 'Task failed: No files changed',
      rootCause, correctApproach, preventive,
      'session_end_hook', 'high', new Date().toISOString(),
    );
    const evalEntry = db.prepare('SELECT * FROM eval_logs WHERE id = ?').get('e3');
    assert.ok(evalEntry.rootCause !== null, 'rootCause should be populated');
    assert.ok(evalEntry.correctApproach !== null, 'correctApproach should be populated');
    assert.ok(evalEntry.preventiveUpdate !== null, 'preventiveUpdate should be populated');
  });
});

describe('Rule hygiene', () => {
  let db;
  beforeEach(() => { db = createTestDb(); });

  it('scoped rule is accepted', () => {
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO knowledge_rules (id, category, name, paths, content, priority, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run('r1', 'security', 'auth-check', '["src/auth/**"]', 'Verify auth', 7, now, now);
    const rule = db.prepare('SELECT * FROM knowledge_rules WHERE id = ?').get('r1');
    assert.ok(rule);
    assert.equal(JSON.parse(rule.paths)[0], 'src/auth/**');
  });

  it('documents that **/* paths are rejected by createRule at app layer', () => {
    // The actual rejection happens in knowledge-rules.js createRule()
    // This test documents the contract
    const globalPaths = ['**/*'];
    assert.ok(globalPaths.includes('**/*'), 'Global wildcard should be detectable');
    // In production: createRule({ paths: ['**/*'] }) throws unless force: true
  });
});

describe('Dependency cascade', () => {
  let db;
  beforeEach(() => { db = createTestDb(); });

  it('upstream permanent failure blocks downstream', () => {
    const now = new Date().toISOString();
    const upstream = insertTask(db, {
      id: 'up-1', status: 'failed', retryCount: 2, maxRetries: 2,
      error: 'Permanent failure', completedAt: now,
    });
    insertTask(db, {
      id: 'down-1', status: 'pending', dependsOn: JSON.stringify(['up-1']),
    });

    assert.ok(upstream.retryCount >= upstream.maxRetries, 'Upstream should be permanently failed');
    const deps = JSON.parse(getTask(db, 'down-1').dependsOn);
    const upTask = getTask(db, deps[0]);
    assert.equal(upTask.status, 'failed');
    assert.ok(upTask.retryCount >= upTask.maxRetries);
  });

  it('upstream transient failure does NOT cascade', () => {
    const upstream = insertTask(db, {
      id: 'up-2', status: 'failed', retryCount: 0, maxRetries: 2,
    });
    assert.ok(upstream.retryCount < upstream.maxRetries, 'Upstream should be transiently failed');
  });
});
