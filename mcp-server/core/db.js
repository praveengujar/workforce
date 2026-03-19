import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// ---------------------------------------------------------------------------
// Path & directory setup — uses WORKFORCE_DATA_DIR (plugin persistent data)
// ---------------------------------------------------------------------------
const DATA_DIR = process.env.WORKFORCE_DATA_DIR || join(homedir(), '.claude', 'tasks');
const DB_PATH = join(DATA_DIR, 'workforce.db');
const LEGACY_DB_PATH = join(homedir(), '.claude', 'tasks', 'claude-agents.db');

// ---------------------------------------------------------------------------
// Prepared statement cache
// ---------------------------------------------------------------------------
const _stmtCache = new Map();

function stmt(sql) {
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
}

// ---------------------------------------------------------------------------
// Task CRUD
// ---------------------------------------------------------------------------

export function getAllTasks(includeArchived = false) {
  if (includeArchived) {
    return stmt('SELECT * FROM tasks ORDER BY createdAt DESC').all();
  }
  return stmt("SELECT * FROM tasks WHERE status != 'archived' ORDER BY createdAt DESC").all();
}

export function getTask(id) {
  return stmt('SELECT * FROM tasks WHERE id = ?').get(id);
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
  return stmt("SELECT * FROM tasks WHERE status = 'running' ORDER BY startedAt ASC").all();
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

export function recordCost(taskId, project, cost, tier) {
  const now = new Date().toISOString();
  stmt(
    'INSERT INTO cost_history (taskId, project, cost, tier, recordedAt) VALUES (?, ?, ?, ?, ?)',
  ).run(taskId, project ?? null, cost, tier ?? null, now);
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
