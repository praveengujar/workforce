#!/usr/bin/env node

/**
 * SessionEnd hook — analyzes recent failed tasks and creates eval entries.
 * Runs at session teardown. Lightweight — queries DB directly.
 *
 * Populates rootCause, correctApproach, and preventiveUpdate with
 * category-specific templates so downstream eval processing creates
 * scoped rules instead of global ['**/*'] fallbacks.
 *
 * Deduplicates per detection source (not per task) so recovery-engine
 * evals and session-end evals can coexist for the same task.
 */

import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

const DATA_DIR = process.env.WORKFORCE_DATA_DIR || join(homedir(), '.claude', 'tasks');
const DB_PATH = join(DATA_DIR, 'workforce.db');

if (!existsSync(DB_PATH)) {
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Path extraction (inline — this script doesn't import MCP server modules)
// ---------------------------------------------------------------------------
function extractPathsFromPrompt(prompt) {
  if (!prompt) return [];
  const pathRe = /(?:^|\s|["'`(])([./]*(?:src|lib|app|apps|components|pages|api|hooks|utils|services|models|tests?|spec|config|scripts?|mcp-server|agents?|skills?|packages|core|tools)\/[^\s"'`),;]+)/gi;
  const extRe = /(?:^|\s|["'`(])([a-zA-Z0-9_./-]+\.(?:js|ts|tsx|jsx|py|rs|go|java|css|html|json|yaml|yml))\b/gi;
  const paths = new Set();
  let m;
  while ((m = pathRe.exec(prompt)) !== null) paths.add(m[1].replace(/[.,;:!?)]+$/, ''));
  while ((m = extRe.exec(prompt)) !== null) paths.add(m[1]);
  return [...paths];
}

// ---------------------------------------------------------------------------
// Category-specific eval templates
// ---------------------------------------------------------------------------
const CATEGORY_TEMPLATES = {
  zero_work: {
    rootCause: 'Agent completed without modifying any files. Prompt likely lacked specific file paths or actionable instructions.',
    correctApproach: 'Include explicit file paths, function names, and expected changes. Use task_type "analysis" for investigation-only tasks.',
    pathPattern: 'workflow',
  },
  infrastructure: {
    rootCause: 'Infrastructure issue — process died, budget exceeded, or environment misconfiguration.',
    correctApproach: 'Check system resources, process limits, and environment configuration before retrying.',
    pathPattern: 'workflow',
  },
  rate_limit: {
    rootCause: 'API rate limit or service overload caused task failure.',
    correctApproach: 'Wait for rate limit window to pass. Recovery engine handles auto-retry with backoff.',
    pathPattern: 'workflow',
  },
  merge_failure: {
    rootCause: 'Git merge conflict or merge lock contention prevented task completion.',
    correctApproach: 'Check target branch for recent changes. Resolve conflicts before retrying. Consider rebasing the task branch.',
    pathPattern: 'patterns',
  },
  dependency_failure: {
    rootCause: 'Upstream dependency task failed, cascading failure to this task.',
    correctApproach: 'Fix the upstream dependency task first, then retry this task.',
    pathPattern: 'workflow',
  },
  environment: {
    rootCause: 'Claude CLI binary not found or spawn failed. Environment may be misconfigured.',
    correctApproach: 'Verify Claude CLI is installed and on PATH. Check tmux availability.',
    pathPattern: 'workflow',
  },
  prompt_quality: {
    rootCause: 'Task failed after multiple retries, suggesting the prompt needs refinement.',
    correctApproach: 'Use /workforce-rubberduck to refine the prompt. Add file paths, acceptance criteria, and constraints.',
    pathPattern: 'workflow',
  },
  custom: {
    rootCause: 'Task failed with an unclassified error.',
    correctApproach: 'Review task output and error details. Refine prompt or decompose into smaller tasks.',
    pathPattern: 'patterns',
  },
};

function buildPreventiveUpdate(task, category) {
  const template = CATEGORY_TEMPLATES[category] || CATEGORY_TEMPLATES.custom;
  const promptPaths = extractPathsFromPrompt(task.prompt);

  // Derive scoped paths: use extracted paths if available, else category-derived glob
  let rulePaths;
  if (promptPaths.length > 0) {
    rulePaths = [...new Set(promptPaths.map(p => {
      const parts = p.split('/');
      return parts.length > 1 ? parts.slice(0, 2).join('/') + '/**' : p;
    }))];
  } else {
    const categoryGlobs = {
      workflow: ['mcp-server/**', 'hooks/**'],
      patterns: ['src/**', 'lib/**', 'app/**'],
      testing: ['tests/**', 'spec/**'],
      security: ['src/auth/**', 'src/middleware/**'],
    };
    rulePaths = categoryGlobs[template.pathPattern] || ['src/**'];
  }

  return JSON.stringify({
    category: template.pathPattern,
    name: `eval-${category}-${task.id.slice(0, 4)}`,
    description: `Preventive rule from ${category} failure on task ${task.id.slice(0, 8)}`,
    paths: rulePaths,
    content: template.correctApproach,
    priority: category === 'zero_work' || category === 'prompt_quality' ? 6 : 4,
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
try {
  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL');

  const tableCheck = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='eval_logs'",
  ).get();
  if (!tableCheck) {
    db.close();
    process.exit(0);
  }

  // Dedup per detection source — allows recovery-engine and session-end evals to coexist
  const cutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const failedTasks = db.prepare(
    `SELECT t.id, t.prompt, t.error, t.status, t.completedAt, t.taskType, t.retryCount
     FROM tasks t
     WHERE t.status = 'failed'
       AND t.completedAt > ?
       AND t.id NOT IN (SELECT taskId FROM eval_logs WHERE taskId IS NOT NULL AND detection = 'session_end_hook')
     ORDER BY t.completedAt DESC
     LIMIT 10`,
  ).all(cutoff);

  let created = 0;

  for (const task of failedTasks) {
    const error = task.error || '';
    const errLower = error.toLowerCase();
    let category = 'custom';
    let severity = 'medium';

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

    const template = CATEGORY_TEMPLATES[category] || CATEGORY_TEMPLATES.custom;
    const id = randomUUID().slice(0, 8);
    const now = new Date().toISOString();

    db.prepare(
      `INSERT INTO eval_logs (id, taskId, category, ruleViolated, whatHappened, rootCause,
       correctApproach, preventiveUpdate, detection, severity, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id, task.id, category, null,
      `Task failed: ${error.slice(0, 500)}`,
      template.rootCause,
      template.correctApproach,
      buildPreventiveUpdate(task, category),
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
