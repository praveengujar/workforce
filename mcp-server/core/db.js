import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { DATA_DIR } from './constants.js';
const DB_PATH = join(DATA_DIR, 'workforce.db');
const LEGACY_DB_PATH = join(homedir(), '.claude', 'tasks', 'claude-agents.db');

// ---------------------------------------------------------------------------
// Prepared statement cache
// ---------------------------------------------------------------------------
const _stmtCache = new Map();

export function stmt(sql) {
  const db = getDb();
  if (_stmtCache.has(sql)) return _stmtCache.get(sql);
  const s = db.prepare(sql);
  _stmtCache.set(sql, s);
  return s;
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------
let _db = null;

/**
 * Return (and lazily create) the singleton SQLite connection.
 * On first run, migrates from legacy DB path if available.
 */
export function getDb() {
  if (_db) return _db;

  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }

  // Auto-migrate from legacy location on first run
  if (!existsSync(DB_PATH) && existsSync(LEGACY_DB_PATH)) {
    try {
      copyFileSync(LEGACY_DB_PATH, DB_PATH);
      console.error('[db] Migrated database from legacy location');
    } catch (err) {
      console.error('[db] Legacy migration failed:', err.message);
    }
  }

  _db = new DatabaseSync(DB_PATH);
  _db.exec('PRAGMA journal_mode = WAL');
  _db.exec('PRAGMA foreign_keys = ON');
  _applySchema(_db);

  return _db;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------
function _applySchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version   INTEGER PRIMARY KEY,
      appliedAt TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id            TEXT PRIMARY KEY,
      prompt        TEXT,
      status        TEXT NOT NULL DEFAULT 'pending',
      project       TEXT,
      branch        TEXT,
      worktreePath  TEXT,
      pid           INTEGER,
      sessionId     TEXT,
      output        TEXT,
      error         TEXT,
      merged        INTEGER NOT NULL DEFAULT 0,
      mergeFailed   INTEGER NOT NULL DEFAULT 0,
      retryCount    INTEGER NOT NULL DEFAULT 0,
      maxRetries    INTEGER NOT NULL DEFAULT 2,
      pinned        INTEGER NOT NULL DEFAULT 0,
      needsInput    INTEGER NOT NULL DEFAULT 0,
      exitCode      INTEGER,
      cost          REAL,
      createdAt     TEXT,
      startedAt     TEXT,
      completedAt   TEXT,
      archivedAt    TEXT
    );

    CREATE TABLE IF NOT EXISTS task_events (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      taskId    TEXT NOT NULL,
      phase     TEXT NOT NULL,
      detail    TEXT,
      timestamp TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workers (
      taskId    TEXT PRIMARY KEY,
      pid       INTEGER,
      logPath   TEXT,
      startedAt TEXT
    );

    CREATE TABLE IF NOT EXISTS launch_claims (
      taskId    TEXT PRIMARY KEY,
      claimedAt TEXT NOT NULL,
      claimedBy TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_createdAt ON tasks(createdAt);
    CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project);
    CREATE INDEX IF NOT EXISTS idx_task_events_taskId ON task_events(taskId);
  `);

  const row = db.prepare('SELECT version FROM schema_migrations WHERE version = 1').get();
  if (!row) {
    db.prepare('INSERT INTO schema_migrations (version, appliedAt) VALUES (?, ?)').run(1, new Date().toISOString());
  }

  const m2 = db.prepare('SELECT version FROM schema_migrations WHERE version = 2').get();
  if (!m2) {
    try {
      db.exec("ALTER TABLE tasks ADD COLUMN tmuxSession TEXT");
      db.exec("ALTER TABLE tasks ADD COLUMN autoMerge INTEGER NOT NULL DEFAULT 0");
      db.exec("ALTER TABLE tasks ADD COLUMN profile TEXT");
    } catch { /* columns may already exist */ }
    db.prepare('INSERT INTO schema_migrations (version, appliedAt) VALUES (?, ?)').run(2, new Date().toISOString());
  }

  // Migration 3: budgets + cost_history tables
  const m3 = db.prepare('SELECT version FROM schema_migrations WHERE version = 3').get();
  if (!m3) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS budgets (
        id          TEXT PRIMARY KEY,
        scope       TEXT NOT NULL DEFAULT 'global',
        dailyLimit  REAL,
        weeklyLimit REAL,
        monthlyLimit REAL,
        createdAt   TEXT NOT NULL,
        updatedAt   TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS cost_history (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        taskId     TEXT NOT NULL,
        project    TEXT,
        cost       REAL NOT NULL,
        tier       TEXT,
        recordedAt TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_budgets_scope ON budgets(scope);
      CREATE INDEX IF NOT EXISTS idx_cost_history_taskId ON cost_history(taskId);
      CREATE INDEX IF NOT EXISTS idx_cost_history_recordedAt ON cost_history(recordedAt);
      CREATE INDEX IF NOT EXISTS idx_cost_history_project ON cost_history(project);
    `);
    db.prepare('INSERT INTO schema_migrations (version, appliedAt) VALUES (?, ?)').run(3, new Date().toISOString());
    console.error('[db] Applied migration 3: budgets + cost_history tables');
  }

  // Migration 4: experiment support columns on tasks
  const m4 = db.prepare('SELECT version FROM schema_migrations WHERE version = 4').get();
  if (!m4) {
    try {
      db.exec("ALTER TABLE tasks ADD COLUMN taskType TEXT DEFAULT 'standard'");
      db.exec("ALTER TABLE tasks ADD COLUMN experimentConfig TEXT");
    } catch { /* columns may already exist */ }
    db.prepare('INSERT INTO schema_migrations (version, appliedAt) VALUES (?, ?)').run(4, new Date().toISOString());
    console.error('[db] Applied migration 4: experiment columns on tasks');
  }

  // Migration 5: dependency graph + shared context
  const m5 = db.prepare('SELECT version FROM schema_migrations WHERE version = 5').get();
  if (!m5) {
    try {
      db.exec("ALTER TABLE tasks ADD COLUMN parentId TEXT");
      db.exec("ALTER TABLE tasks ADD COLUMN dependsOn TEXT");
      db.exec("ALTER TABLE tasks ADD COLUMN taskGroup TEXT");
      db.exec("ALTER TABLE tasks ADD COLUMN phase INTEGER");
      db.exec("ALTER TABLE tasks ADD COLUMN resultSummary TEXT");
    } catch { /* columns may already exist */ }

    db.exec(`
      CREATE TABLE IF NOT EXISTS shared_context (
        id         TEXT PRIMARY KEY,
        taskGroup  TEXT NOT NULL,
        taskId     TEXT,
        key        TEXT NOT NULL,
        value      TEXT NOT NULL,
        createdAt  TEXT NOT NULL,
        UNIQUE(taskGroup, key)
      );
      CREATE INDEX IF NOT EXISTS idx_shared_context_group ON shared_context(taskGroup);
    `);

    db.prepare('INSERT INTO schema_migrations (version, appliedAt) VALUES (?, ?)').run(5, new Date().toISOString());
    console.error('[db] Applied migration 5: dependency graph + shared context');
  }

  // Migration 6: retryAfter column for backoff
  const m6 = db.prepare('SELECT version FROM schema_migrations WHERE version = 6').get();
  if (!m6) {
    try {
      db.exec("ALTER TABLE tasks ADD COLUMN retryAfter TEXT");
    } catch { /* column may already exist */ }
    db.prepare('INSERT INTO schema_migrations (version, appliedAt) VALUES (?, ?)').run(6, new Date().toISOString());
    console.error('[db] Applied migration 6: retryAfter column');
  }

  // Migration 7: targetBranch for merge target tracking
  const m7 = db.prepare('SELECT version FROM schema_migrations WHERE version = 7').get();
  if (!m7) {
    try {
      db.exec("ALTER TABLE tasks ADD COLUMN targetBranch TEXT");
    } catch { /* column may already exist */ }
    db.prepare('INSERT INTO schema_migrations (version, appliedAt) VALUES (?, ?)').run(7, new Date().toISOString());
    console.error('[db] Applied migration 7: targetBranch column');
  }

  // Migration 8: baseCommit for zero-work guard comparison
  const m8 = db.prepare('SELECT version FROM schema_migrations WHERE version = 8').get();
  if (!m8) {
    try {
      db.exec("ALTER TABLE tasks ADD COLUMN baseCommit TEXT");
    } catch { /* column may already exist */ }
    db.prepare('INSERT INTO schema_migrations (version, appliedAt) VALUES (?, ?)').run(8, new Date().toISOString());
    console.error('[db] Applied migration 8: baseCommit column');
  }

  // Migration 9: token/duration columns on cost_history for subscription mode
  const m9 = db.prepare('SELECT version FROM schema_migrations WHERE version = 9').get();
  if (!m9) {
    try {
      db.exec("ALTER TABLE cost_history ADD COLUMN inputTokens INTEGER");
      db.exec("ALTER TABLE cost_history ADD COLUMN outputTokens INTEGER");
      db.exec("ALTER TABLE cost_history ADD COLUMN durationMs INTEGER");
    } catch { /* columns may already exist */ }
    db.prepare('INSERT INTO schema_migrations (version, appliedAt) VALUES (?, ?)').run(9, new Date().toISOString());
    console.error('[db] Applied migration 9: token/duration columns on cost_history');
  }

  // Migration 10: knowledge rules for context management
  const m10 = db.prepare('SELECT version FROM schema_migrations WHERE version = 10').get();
  if (!m10) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS knowledge_rules (
        id          TEXT PRIMARY KEY,
        category    TEXT NOT NULL,
        name        TEXT NOT NULL,
        description TEXT,
        paths       TEXT NOT NULL,
        content     TEXT NOT NULL,
        priority    INTEGER NOT NULL DEFAULT 5,
        createdAt   TEXT NOT NULL,
        updatedAt   TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_knowledge_rules_category ON knowledge_rules(category);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_rules_cat_name ON knowledge_rules(category, name);
    `);
    db.prepare('INSERT INTO schema_migrations (version, appliedAt) VALUES (?, ?)').run(10, new Date().toISOString());
    console.error('[db] Applied migration 10: knowledge_rules table');
  }

  // Migration 11: eval logs for self-improving feedback loop
  const m11 = db.prepare('SELECT version FROM schema_migrations WHERE version = 11').get();
  if (!m11) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS eval_logs (
        id              TEXT PRIMARY KEY,
        taskId          TEXT,
        category        TEXT NOT NULL,
        ruleViolated    TEXT,
        whatHappened     TEXT NOT NULL,
        rootCause       TEXT,
        correctApproach TEXT,
        preventiveUpdate TEXT,
        detection       TEXT NOT NULL,
        severity        TEXT NOT NULL DEFAULT 'medium',
        processedAt     TEXT,
        processedAction TEXT,
        createdAt       TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_eval_logs_taskId ON eval_logs(taskId);
      CREATE INDEX IF NOT EXISTS idx_eval_logs_category ON eval_logs(category);
      CREATE INDEX IF NOT EXISTS idx_eval_logs_processedAt ON eval_logs(processedAt);
    `);
    db.prepare('INSERT INTO schema_migrations (version, appliedAt) VALUES (?, ?)').run(11, new Date().toISOString());
    console.error('[db] Applied migration 11: eval_logs table');
  }

  // Migration 12: session context for cross-session continuity
  const m12 = db.prepare('SELECT version FROM schema_migrations WHERE version = 12').get();
  if (!m12) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS session_context (
        id        TEXT PRIMARY KEY,
        project   TEXT NOT NULL,
        key       TEXT NOT NULL,
        value     TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        UNIQUE(project, key)
      );
      CREATE INDEX IF NOT EXISTS idx_session_context_project ON session_context(project);
    `);
    db.prepare('INSERT INTO schema_migrations (version, appliedAt) VALUES (?, ?)').run(12, new Date().toISOString());
    console.error('[db] Applied migration 12: session_context table');
  }
}

// ---------------------------------------------------------------------------
// Task CRUD
// ---------------------------------------------------------------------------

export function getAllTasks(includeArchived = false) {
  if (includeArchived) {
    return stmt('SELECT * FROM tasks ORDER BY createdAt DESC').all();
  }
  return stmt("SELECT * FROM tasks WHERE status NOT IN ('archived') ORDER BY createdAt DESC").all();
}

export function getTask(id) {
  const exact = stmt('SELECT * FROM tasks WHERE id = ?').get(id);
  if (exact) return exact;
  // Support short ID prefix matching (e.g., "3cf5c8e5" matches full UUID)
  if (id && id.length >= 8 && id.length < 36) {
    return getDb().prepare('SELECT * FROM tasks WHERE id LIKE ? LIMIT 1').get(`${id}%`);
  }
  return undefined;
}

export function createTask({ id, prompt, project }) {
  const now = new Date().toISOString();
  stmt(
    `INSERT INTO tasks (id, prompt, project, status, createdAt) VALUES (?, ?, ?, 'pending', ?)`,
  ).run(id, prompt, project ?? null, now);
  return getTask(id);
}

const TASK_COLUMNS = new Set([
  'prompt', 'status', 'project', 'branch', 'worktreePath', 'pid',
  'sessionId', 'output', 'error', 'merged', 'mergeFailed', 'retryCount',
  'maxRetries', 'pinned', 'needsInput', 'exitCode', 'cost',
  'createdAt', 'startedAt', 'completedAt', 'archivedAt',
  'tmuxSession', 'autoMerge', 'profile',
  'taskType', 'experimentConfig',
  'parentId', 'dependsOn', 'taskGroup', 'phase', 'resultSummary', 'retryAfter', 'targetBranch', 'baseCommit',
]);

export function updateTask(id, updates) {
  const keys = Object.keys(updates).filter(k => TASK_COLUMNS.has(k));
  if (keys.length === 0) return getTask(id);
  const setClauses = keys.map((k) => `${k} = ?`).join(', ');
  const values = keys.map((k) => updates[k]);
  getDb().prepare(`UPDATE tasks SET ${setClauses} WHERE id = ?`).run(...values, id);
  return getTask(id);
}

export function deleteTask(id) {
  stmt('DELETE FROM task_events WHERE taskId = ?').run(id);
  stmt('DELETE FROM workers WHERE taskId = ?').run(id);
  stmt('DELETE FROM launch_claims WHERE taskId = ?').run(id);
  stmt('DELETE FROM tasks WHERE id = ?').run(id);
}

export function getRunningTasks() {
  return stmt("SELECT * FROM tasks WHERE status IN ('running', 'paused') ORDER BY startedAt ASC").all();
}

export function getPendingTasks() {
  return stmt("SELECT * FROM tasks WHERE status = 'pending' ORDER BY createdAt ASC").all();
}

// ---------------------------------------------------------------------------
// Task events
// ---------------------------------------------------------------------------

export function getTaskEvents(taskId) {
  return stmt('SELECT * FROM task_events WHERE taskId = ? ORDER BY timestamp ASC').all(taskId);
}

export function addTaskEvent(taskId, phase, detail = null) {
  const now = new Date().toISOString();
  stmt('INSERT INTO task_events (taskId, phase, detail, timestamp) VALUES (?, ?, ?, ?)').run(taskId, phase, detail, now);
}

// ---------------------------------------------------------------------------
// Launch claims
// ---------------------------------------------------------------------------

export function claimTask(taskId, claimedBy) {
  const now = new Date().toISOString();
  const result = stmt('INSERT OR IGNORE INTO launch_claims (taskId, claimedAt, claimedBy) VALUES (?, ?, ?)').run(taskId, now, claimedBy ?? null);
  return result.changes > 0;
}

export function releaseTaskClaim(taskId) {
  stmt('DELETE FROM launch_claims WHERE taskId = ?').run(taskId);
}

export function getStaleClaims(maxAgeMs = 60_000) {
  const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
  return stmt('SELECT * FROM launch_claims WHERE claimedAt < ?').all(cutoff);
}

// ---------------------------------------------------------------------------
// Workers
// ---------------------------------------------------------------------------

export function registerWorker(taskId, pid, logPath) {
  const now = new Date().toISOString();
  stmt('INSERT OR REPLACE INTO workers (taskId, pid, logPath, startedAt) VALUES (?, ?, ?, ?)').run(taskId, pid, logPath ?? null, now);
}

export function removeWorker(taskId) {
  stmt('DELETE FROM workers WHERE taskId = ?').run(taskId);
}

export function getWorker(taskId) {
  return stmt('SELECT * FROM workers WHERE taskId = ?').get(taskId);
}

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

export function getBudget(scope = 'global') {
  return stmt('SELECT * FROM budgets WHERE scope = ?').get(scope) || null;
}

export function setBudget(scope, { dailyLimit, weeklyLimit, monthlyLimit }) {
  const now = new Date().toISOString();
  const existing = getBudget(scope);

  if (existing) {
    getDb().prepare(
      'UPDATE budgets SET dailyLimit = ?, weeklyLimit = ?, monthlyLimit = ?, updatedAt = ? WHERE scope = ?',
    ).run(
      dailyLimit ?? existing.dailyLimit,
      weeklyLimit ?? existing.weeklyLimit,
      monthlyLimit ?? existing.monthlyLimit,
      now,
      scope,
    );
  } else {
    const id = `budget-${scope}-${Date.now()}`;
    stmt(
      'INSERT INTO budgets (id, scope, dailyLimit, weeklyLimit, monthlyLimit, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(id, scope, dailyLimit ?? null, weeklyLimit ?? null, monthlyLimit ?? null, now, now);
  }

  return getBudget(scope);
}

// ---------------------------------------------------------------------------
// Cost history
// ---------------------------------------------------------------------------

export function recordCost(taskId, project, cost, tier, extras = {}) {
  const now = new Date().toISOString();
  stmt(
    'INSERT INTO cost_history (taskId, project, cost, tier, inputTokens, outputTokens, durationMs, recordedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(taskId, project ?? null, cost, tier ?? null, extras.inputTokens ?? null, extras.outputTokens ?? null, extras.durationMs ?? null, now);
}

export function getTaskCountForPeriod(scope, startDate, endDate) {
  if (scope === 'global') {
    const row = stmt(
      'SELECT COUNT(*) AS total FROM cost_history WHERE recordedAt >= ? AND recordedAt <= ?',
    ).get(startDate, endDate);
    return row?.total ?? 0;
  }
  const row = stmt(
    'SELECT COUNT(*) AS total FROM cost_history WHERE project = ? AND recordedAt >= ? AND recordedAt <= ?',
  ).get(scope, startDate, endDate);
  return row?.total ?? 0;
}

export function getTokensForPeriod(scope, startDate, endDate) {
  if (scope === 'global') {
    const row = stmt(
      'SELECT COALESCE(SUM(inputTokens), 0) AS totalInput, COALESCE(SUM(outputTokens), 0) AS totalOutput FROM cost_history WHERE recordedAt >= ? AND recordedAt <= ?',
    ).get(startDate, endDate);
    return { input: row?.totalInput ?? 0, output: row?.totalOutput ?? 0 };
  }
  const row = stmt(
    'SELECT COALESCE(SUM(inputTokens), 0) AS totalInput, COALESCE(SUM(outputTokens), 0) AS totalOutput FROM cost_history WHERE project = ? AND recordedAt >= ? AND recordedAt <= ?',
  ).get(scope, startDate, endDate);
  return { input: row?.totalInput ?? 0, output: row?.totalOutput ?? 0 };
}

export function getCostForPeriod(scope, startDate, endDate) {
  if (scope === 'global') {
    const row = stmt(
      'SELECT COALESCE(SUM(cost), 0) AS total FROM cost_history WHERE recordedAt >= ? AND recordedAt <= ?',
    ).get(startDate, endDate);
    return row?.total ?? 0;
  }
  // scope = project name
  const row = stmt(
    'SELECT COALESCE(SUM(cost), 0) AS total FROM cost_history WHERE project = ? AND recordedAt >= ? AND recordedAt <= ?',
  ).get(scope, startDate, endDate);
  return row?.total ?? 0;
}

export function getDailyCostHistory(scope, days = 14) {
  const results = [];
  const now = new Date();

  for (let i = days - 1; i >= 0; i--) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const startDate = day.toISOString();
    const endDate = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1).toISOString();
    const total = getCostForPeriod(scope, startDate, endDate);
    results.push({
      date: startDate.slice(0, 10),
      cost: Math.round(total * 100) / 100,
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Shared context (for task groups / dependency chains)
// ---------------------------------------------------------------------------

export function writeSharedContext(taskGroup, taskId, key, value) {
  const now = new Date().toISOString();
  const id = `${taskGroup}::${key}`;
  getDb().prepare(
    `INSERT OR REPLACE INTO shared_context (id, taskGroup, taskId, key, value, createdAt)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, taskGroup, taskId ?? null, key, value, now);
}

export function readSharedContext(taskGroup, key) {
  return stmt('SELECT * FROM shared_context WHERE taskGroup = ? AND key = ?').get(taskGroup, key);
}

export function readAllSharedContext(taskGroup) {
  return stmt('SELECT * FROM shared_context WHERE taskGroup = ? ORDER BY createdAt ASC').all(taskGroup);
}

export function deleteSharedContext(taskGroup, key) {
  stmt('DELETE FROM shared_context WHERE taskGroup = ? AND key = ?').run(taskGroup, key);
}

export function getTasksByGroup(taskGroup) {
  return stmt(
    "SELECT * FROM tasks WHERE taskGroup = ? ORDER BY phase ASC, createdAt ASC",
  ).all(taskGroup);
}
