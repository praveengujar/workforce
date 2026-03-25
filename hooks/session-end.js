#!/usr/bin/env node

/**
 * SessionEnd hook — analyzes recent failed tasks and creates eval entries.
 * Runs at session teardown. Lightweight — queries DB directly.
 */

import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

const DATA_DIR = process.env.WORKFORCE_DATA_DIR || join(homedir(), '.claude', 'tasks');
const DB_PATH = join(DATA_DIR, 'workforce.db');

if (!existsSync(DB_PATH)) {
  process.exit(0); // No DB = nothing to analyze
}

try {
  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL');

  // Check if eval_logs table exists
  const tableCheck = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='eval_logs'",
  ).get();
  if (!tableCheck) {
    db.close();
    process.exit(0);
  }

  // Find tasks that failed in the last 30 minutes and don't already have evals
  const cutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const failedTasks = db.prepare(
    `SELECT t.id, t.prompt, t.error, t.status, t.completedAt, t.taskType, t.retryCount
     FROM tasks t
     WHERE t.status = 'failed'
       AND t.completedAt > ?
       AND t.id NOT IN (SELECT taskId FROM eval_logs WHERE taskId IS NOT NULL)
     ORDER BY t.completedAt DESC
     LIMIT 10`,
  ).all(cutoff);

  let created = 0;

  for (const task of failedTasks) {
    const error = task.error || '';
    const errLower = error.toLowerCase();
    let category = 'custom';
    let severity = 'medium';

    // Classify failure category (case-insensitive)
    if (errLower.includes('zero-work') || errLower.includes('no files changed')) {
      category = 'zero_work';
      severity = 'high';
    } else if (errLower.includes('budget') || errLower.includes('task limit exceeded')) {
      category = 'infrastructure';
      severity = 'low';
    } else if (errLower.includes('rate limit') || errLower.includes('overloaded') || errLower.includes('529')) {
      category = 'rate_limit';
      severity = 'low';
    } else if (errLower.includes('ghost') || errLower.includes('zombie') || errLower.includes('pid')) {
      category = 'infrastructure';
      severity = 'medium';
    } else if (errLower.includes('merge') || errLower.includes('conflict')) {
      category = 'merge_failure';
      severity = 'medium';
    } else if (errLower.includes('dependency failed') || errLower.includes('cascade')) {
      category = 'dependency_failure';
      severity = 'medium';
    } else if (errLower.includes('spawn failed') || errLower.includes('enoent')) {
      category = 'environment';
      severity = 'high';
    } else if (task.retryCount > 1) {
      category = 'prompt_quality';
      severity = 'high';
    }

    const id = randomUUID().slice(0, 8);
    const now = new Date().toISOString();

    db.prepare(
      `INSERT INTO eval_logs (id, taskId, category, ruleViolated, whatHappened, rootCause,
       correctApproach, preventiveUpdate, detection, severity, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id, task.id, category, null,
      `Task failed: ${error.slice(0, 500)}`,
      null, null, null,
      'session_end_hook', severity, now,
    );
    created++;
  }

  db.close();

  if (created > 0) {
    console.error(`[workforce:session-end] Created ${created} eval(s) from recent failures`);
  }
} catch (err) {
  console.error(`[workforce:session-end] Error: ${err.message}`);
}
