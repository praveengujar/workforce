/**
 * Episodic Memory — Context Fabric Milestone 1.
 *
 * Captures successful (and on the failure path: failed) task trajectories
 * as few-shot examples per PRD §9.3, and recalls the most relevant past
 * episodes for an upcoming task.
 *
 * Today, only failures feed back through eval_logs; successful trajectories
 * are discarded. This module turns merged-task diffs + prompts into reusable
 * episodic memory that gets injected at worker layer 5b.
 *
 * No new npm deps. ESM. Logs to stderr.
 */

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import { getDb, stmt, getTask } from './db.js';
import { gitExec, CLAUDE_CLI } from './constants.js';

// ---------------------------------------------------------------------------
// Feature flag — defaults to true. Set WORKFORCE_EPISODIC_ENABLED=false to
// fully disable both capture and recall.
// ---------------------------------------------------------------------------
export function isEpisodicEnabled() {
  const v = process.env.WORKFORCE_EPISODIC_ENABLED;
  if (v === undefined || v === null || v === '') return true;
  return !['0', 'false', 'no', 'off'].includes(String(v).toLowerCase());
}

// ---------------------------------------------------------------------------
// Glob signature
// ---------------------------------------------------------------------------

/**
 * Convert a list of changed file paths into a sorted, distinct glob
 * signature. Each path collapses to "<dir>/*.<ext>" (or "<dir>/*" if it has
 * no extension), and the resulting set is sorted + comma-joined for stable
 * comparison.
 *
 * Example:
 *   ["mcp-server/core/db.js", "mcp-server/core/episodic-memory.js"]
 *     -> "mcp-server/core/*.js"
 *   ["a/b/c.ts", "a/b/d.ts", "a/Dockerfile"]
 *     -> "a/*,a/b/*.ts"
 */
export function normalizeGlobSignature(filesTouched) {
  if (!Array.isArray(filesTouched) || filesTouched.length === 0) return '';
  const set = new Set();
  for (const raw of filesTouched) {
    if (typeof raw !== 'string' || raw.length === 0) continue;
    const norm = raw.replace(/\\/g, '/').replace(/^\.\//, '');
    const lastSlash = norm.lastIndexOf('/');
    const dir = lastSlash >= 0 ? norm.slice(0, lastSlash) : '';
    const base = lastSlash >= 0 ? norm.slice(lastSlash + 1) : norm;
    const ext = extname(base);
    const glob = ext ? `${dir ? dir + '/' : ''}*${ext}` : `${dir ? dir + '/' : ''}*`;
    set.add(glob);
  }
  return [...set].sort().join(',');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tokenize(text) {
  if (!text) return [];
  return String(text)
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter(t => t.length >= 3 && t.length <= 32);
}

function keywordOverlap(a, b) {
  const tokensA = new Set(tokenize(a));
  if (tokensA.size === 0) return 0;
  const tokensB = new Set(tokenize(b));
  if (tokensB.size === 0) return 0;
  let hits = 0;
  for (const t of tokensA) if (tokensB.has(t)) hits++;
  const union = tokensA.size + tokensB.size - hits;
  return union > 0 ? hits / union : 0;
}

function globOverlap(sigA, sigB) {
  if (!sigA || !sigB) return 0;
  const a = new Set(sigA.split(',').filter(Boolean));
  const b = new Set(sigB.split(',').filter(Boolean));
  if (a.size === 0 || b.size === 0) return 0;
  let hits = 0;
  for (const g of a) if (b.has(g)) hits++;
  const union = a.size + b.size - hits;
  return union > 0 ? hits / union : 0;
}

function dayMs() { return 24 * 60 * 60 * 1000; }

function isWithinTtl(row, now = Date.now()) {
  const ttl = row.ttl_days ?? 90;
  if (!ttl || ttl <= 0) return true;
  const created = Date.parse(row.created_at);
  if (!Number.isFinite(created)) return true;
  return now - created <= ttl * dayMs();
}

// ---------------------------------------------------------------------------
// Diff + files-touched extraction
// ---------------------------------------------------------------------------

function listFilesTouched(repoRoot, branch, baseBranch) {
  const candidates = [
    ['diff', '--name-only', `${baseBranch}...${branch}`],
    ['diff', '--name-only', `HEAD...${branch}`],
    ['log', '--name-only', '--pretty=format:', `-1`, branch],
  ];
  for (const args of candidates) {
    try {
      const out = gitExec(args, { cwd: repoRoot });
      const files = out.split('\n').map(l => l.trim()).filter(Boolean);
      if (files.length > 0) return [...new Set(files)];
    } catch { /* try next */ }
  }
  return [];
}

function readDiff(repoRoot, branch, baseBranch, maxChars = 16000) {
  try {
    const d = gitExec(['diff', `${baseBranch}...${branch}`], { cwd: repoRoot });
    return d.length > maxChars ? d.slice(0, maxChars) + '\n…(truncated)' : d;
  } catch {
    try {
      const d = gitExec(['diff', `HEAD...${branch}`], { cwd: repoRoot });
      return d.length > maxChars ? d.slice(0, maxChars) + '\n…(truncated)' : d;
    } catch {
      return '';
    }
  }
}

// ---------------------------------------------------------------------------
// Haiku summarization (subprocess)
// ---------------------------------------------------------------------------

/**
 * Summarise prompt + diff with a small Haiku call. Returns
 * { promptSummary, approachSummary, trustScore } on success, or null when
 * the CLI is unavailable / errors / times out.
 */
function summarizeWithHaiku(prompt, diff) {
  const systemInstructions =
    'You will be given a task PROMPT and the resulting GIT DIFF of a successfully merged task.\n'
    + 'Output exactly two short blocks, separated by a line "---":\n'
    + '1) PROMPT_SUMMARY: ≤200 tokens summarising what the task asked for.\n'
    + '2) APPROACH_SUMMARY: ≤200 tokens summarising what the merged change did and why it worked.\n'
    + 'Be concrete (file/function names where relevant). No preamble, no markdown headings.';

  const stdin =
    `${systemInstructions}\n\nPROMPT:\n${prompt || '(empty)'}\n\nGIT DIFF:\n${diff || '(empty)'}\n`;

  try {
    const out = execFileSync(
      CLAUDE_CLI,
      ['-p', '--model', 'claude-haiku-4-5', '--max-tokens', '400'],
      {
        input: stdin,
        timeout: 30_000,
        stdio: ['pipe', 'pipe', 'pipe'],
        encoding: 'utf8',
      },
    );
    const text = (out || '').trim();
    if (!text) return null;
    const sepIdx = text.indexOf('\n---');
    let promptSummary, approachSummary;
    if (sepIdx >= 0) {
      promptSummary = text.slice(0, sepIdx).trim();
      approachSummary = text.slice(sepIdx + 4).trim();
    } else {
      const half = Math.ceil(text.length / 2);
      promptSummary = text.slice(0, half).trim();
      approachSummary = text.slice(half).trim();
    }
    if (!promptSummary || !approachSummary) return null;
    return { promptSummary, approachSummary, trustScore: 0.7 };
  } catch (err) {
    console.error(`[episodic-memory] Haiku summarization unavailable: ${err.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

/**
 * Capture an episode for a task. Idempotent on (project, task_id).
 * Returns the inserted row, the existing row, or null when disabled / on
 * unrecoverable error (best-effort — never throws).
 */
export function captureEpisode({ task, repoRoot, summarizer = summarizeWithHaiku } = {}) {
  if (!isEpisodicEnabled()) return null;
  if (!task || !task.id) return null;

  try {
    const project = task.project || '_global';
    const existing = stmt(
      'SELECT * FROM episodic_memory WHERE project = ? AND task_id = ?',
    ).get(project, task.id);
    if (existing) return existing;

    const branch = task.branch || `wf/${task.id}`;
    const baseBranch = task.targetBranch || 'main';
    const cwd = repoRoot || task.worktreePath || process.cwd();

    const filesTouched = listFilesTouched(cwd, branch, baseBranch);
    const globSignature = normalizeGlobSignature(filesTouched);
    const diff = readDiff(cwd, branch, baseBranch);

    let promptSummary;
    let approachSummary;
    let trustScore = 0.7;

    const summary = summarizer ? summarizer(task.prompt || '', diff) : null;
    if (summary) {
      promptSummary = (summary.promptSummary || '').slice(0, 4000);
      approachSummary = (summary.approachSummary || '').slice(0, 4000);
      trustScore = typeof summary.trustScore === 'number' ? summary.trustScore : 0.7;
    } else {
      promptSummary = (task.prompt || '').slice(0, 1000) || '(no prompt)';
      approachSummary = `(Haiku unavailable — see diff at ${task.id})`;
      trustScore = 0.5;
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    const outcome = task.merged || task.status === 'done' ? 'success' : (task.status === 'failed' ? 'failure' : 'partial');

    stmt(`
      INSERT INTO episodic_memory (
        id, project, task_id, task_type, outcome, glob_signature,
        prompt_summary, approach_summary, files_touched, review_score,
        tokens_used, retry_count, trust_score, retrieval_count, ttl_days, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      project,
      task.id,
      task.taskType || 'standard',
      outcome,
      globSignature,
      promptSummary,
      approachSummary,
      JSON.stringify(filesTouched),
      task.reviewScore ?? null,
      task.tokensUsed ?? null,
      task.retryCount ?? 0,
      trustScore,
      0,
      90,
      now,
    );

    return stmt('SELECT * FROM episodic_memory WHERE id = ?').get(id);
  } catch (err) {
    console.error(`[episodic-memory] capture failed for task ${task?.id}: ${err.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Recall
// ---------------------------------------------------------------------------

/**
 * Recall the top-N most relevant past episodes for an upcoming task.
 * Filters by trust_score >= 0.5 and ttl_days, then ranks by a blend of
 * keyword overlap on prompt_summary and glob match on planned files.
 * Returns at most maxN rows. Returns [] when disabled.
 */
export function recallEpisodes({ project, prompt, plannedFiles = [], maxN = 3 } = {}) {
  if (!isEpisodicEnabled()) return [];
  if (!project) return [];

  let rows;
  try {
    rows = stmt(
      'SELECT * FROM episodic_memory WHERE project = ? AND trust_score >= 0.5 ORDER BY created_at DESC',
    ).all(project);
  } catch (err) {
    console.error(`[episodic-memory] recall query failed: ${err.message}`);
    return [];
  }

  const now = Date.now();
  const targetSig = normalizeGlobSignature(plannedFiles);

  const scored = [];
  for (const row of rows) {
    if (!isWithinTtl(row, now)) continue;
    const kw = keywordOverlap(prompt || '', row.prompt_summary || '');
    const gl = targetSig ? globOverlap(targetSig, row.glob_signature || '') : 0;
    // Require at least one signal — else episodic recall produces noise.
    if (kw === 0 && gl === 0) continue;
    const score = kw * 0.6 + gl * 0.4;
    scored.push({ row, score });
  }

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, Math.max(1, maxN | 0));

  if (top.length > 0) {
    try {
      const ids = top.map(s => s.row.id);
      const placeholders = ids.map(() => '?').join(',');
      getDb().prepare(
        `UPDATE episodic_memory SET retrieval_count = retrieval_count + 1 WHERE id IN (${placeholders})`,
      ).run(...ids);
    } catch { /* non-fatal */ }
  }

  return top.map(s => ({ ...s.row, _score: Math.round(s.score * 1000) / 1000 }));
}

// ---------------------------------------------------------------------------
// Convenience: capture by task_id
// ---------------------------------------------------------------------------

export function captureEpisodeForTaskId(taskId, opts = {}) {
  if (!isEpisodicEnabled()) return null;
  const task = getTask(taskId);
  if (!task) return null;
  return captureEpisode({ task, ...opts });
}

// ---------------------------------------------------------------------------
// Test-only export — lets tests inject a fake summarizer.
// ---------------------------------------------------------------------------
export const _internals = { summarizeWithHaiku, keywordOverlap, globOverlap, isWithinTtl };
