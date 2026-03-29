#!/usr/bin/env node

/**
 * Startup hook — runs on SessionStart to clean up stale state
 * and log active session context.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const projectDir = process.cwd();

// Prune git worktrees
try {
  execFileSync('git', ['worktree', 'prune'], { cwd: projectDir, stdio: 'pipe' });
  console.error('[workforce:startup] Git worktrees pruned');
} catch {
  // not a git repo or git unavailable
}

// Abort any in-progress merge
try {
  const mergeHead = join(projectDir, '.git', 'MERGE_HEAD');
  if (existsSync(mergeHead)) {
    execFileSync('git', ['merge', '--abort'], { cwd: projectDir, stdio: 'pipe' });
    console.error('[workforce:startup] Aborted stale merge');
  }
} catch {
  // ignore
}

// Log active session context
try {
  const dataDir = process.env.WORKFORCE_DATA_DIR || join(homedir(), '.claude', 'tasks');
  const dbPath = join(dataDir, 'workforce.db');

  if (existsSync(dbPath)) {
    const db = new DatabaseSync(dbPath);
    db.exec('PRAGMA journal_mode = WAL');
    const tableCheck = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session_context'").get();
    if (tableCheck) {
      const entries = db.prepare('SELECT project, key, value FROM session_context ORDER BY project ASC, key ASC').all();
      if (entries.length > 0) {
        const summary = entries.map(e => {
          const val = e.value.length > 50 ? e.value.slice(0, 50) + '...' : e.value;
          return `${e.project}/${e.key}: ${val}`;
        }).join(', ');
        console.error(`[workforce:startup] Active context: ${summary}`);
      }
    }
    db.close();
  }
} catch {
  // ignore — session context is optional
}
