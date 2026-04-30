/**
 * Context Capture Pipeline — Context Fabric Milestone 7.
 *
 * Extends M1 (success-path episodic capture) to all task outcomes per PRD §9.7:
 *   • failure  → episodic_memory (outcome='failure', trust=0.5)
 *   • decision in resultSummary → context_items (memory_type='decision', trust=0.5)
 *   • risk/security keyword hit → proposed_rules (gated review, trust=0.6)
 *   • eval cluster (3+ similar) → proposed_rules (manual MCP only, trust=0.6)
 *
 * Detection is keyword-anchor only — no LLM calls — except captureFailureEpisode
 * which mirrors M1's Haiku approach summary (with the same fallback behaviour).
 *
 * Every capture function is best-effort: on bad input, missing tables, or any
 * unexpected error it logs to stderr and returns null/[] without throwing. The
 * lifecycle hooks call these via setImmediate so a capture failure can never
 * break the merge or reject path.
 *
 * No new npm deps. ESM. Logs to stderr.
 */

import { execFileSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { extname } from 'node:path';
import { getDb, stmt } from './db.js';
import { gitExec, CLAUDE_CLI } from './constants.js';
import { addContextItem } from './context-memory.js';
import { clusterEvals } from './eval-engine.js';

// ---------------------------------------------------------------------------
// Glob signature (mirrors episodic-memory; kept local to avoid touching M1)
// ---------------------------------------------------------------------------

function normalizeGlobSignature(filesTouched) {
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

function listFilesTouched(repoRoot, branch, baseBranch) {
  const candidates = [
    ['diff', '--name-only', `${baseBranch}...${branch}`],
    ['diff', '--name-only', `HEAD...${branch}`],
    ['log', '--name-only', '--pretty=format:', '-1', branch],
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
// Failure summarization (Haiku subprocess — same pattern as M1)
// ---------------------------------------------------------------------------

function summarizeFailureWithHaiku(prompt, errorText, diff) {
  const systemInstructions =
    'You will be given a task PROMPT, the ERROR/REJECTION reason, and any partial GIT DIFF of a FAILED task.\n'
    + 'Output exactly two short blocks, separated by a line "---":\n'
    + '1) PROMPT_SUMMARY: ≤200 tokens summarising what the task asked for.\n'
    + '2) APPROACH_SUMMARY: ≤200 tokens summarising what failed and why (be concrete — name files/functions and the symptom).\n'
    + 'No preamble, no markdown headings.';

  const stdin =
    `${systemInstructions}\n\nPROMPT:\n${prompt || '(empty)'}\n\nERROR:\n${errorText || '(empty)'}\n\nGIT DIFF:\n${diff || '(empty)'}\n`;

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
    return { promptSummary, approachSummary, trustScore: 0.5 };
  } catch (err) {
    console.error(`[context-capture] Haiku summarization unavailable: ${err.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// captureFailureEpisode — mirrors M1 captureEpisode for failure outcomes
// ---------------------------------------------------------------------------

/**
 * Capture an episodic_memory row for a failed/rejected task. Idempotent on
 * (project, task_id). Always returns null on bad input or DB error — never
 * throws. trust_score defaults to 0.5 per PRD §9.7.
 */
export function captureFailureEpisode({ task, repoRoot, summarizer = summarizeFailureWithHaiku } = {}) {
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

    const errorText = task.error || task.resultSummary || '';
    let promptSummary;
    let approachSummary;
    let trustScore = 0.5;

    const summary = summarizer ? summarizer(task.prompt || '', errorText, diff) : null;
    if (summary) {
      promptSummary = (summary.promptSummary || '').slice(0, 4000);
      approachSummary = (summary.approachSummary || '').slice(0, 4000);
      trustScore = typeof summary.trustScore === 'number' ? summary.trustScore : 0.5;
    } else {
      promptSummary = (task.prompt || '').slice(0, 1000) || '(no prompt)';
      const reason = errorText ? errorText.slice(0, 800) : 'unknown failure';
      approachSummary = `Failure: ${reason}`;
      trustScore = 0.5;
    }

    const id = randomUUID();
    const now = new Date().toISOString();

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
      'failure',
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
    console.error(`[context-capture] failure-episode capture failed for task ${task?.id}: ${err.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Decision detection — keyword anchors on resultSummary
// ---------------------------------------------------------------------------

const DECISION_ANCHORS = [
  /\bwe decided\b/i,
  /\bdecided to\b/i,
  /\bchose\b/i,
  /\bpicked\b/i,
  /\brejected\b/i,
  /\bdecision\s*[:\-]/i,
];

/**
 * Detect decision sentences in free-form text using keyword anchors.
 * Returns an array of {title, content} entries. Casual mentions ("a tough
 * decision") that lack the anchor patterns are ignored. Empty/non-string
 * input returns [].
 */
export function detectDecisions(text) {
  if (typeof text !== 'string' || text.trim().length === 0) return [];
  const out = [];
  const seen = new Set();

  // Split on sentence boundaries (period, !, ?, newline) keeping reasonable
  // chunks. Keyword-anchor only — no NLP.
  const sentences = text
    .split(/(?<=[.!?])\s+|\n+/g)
    .map(s => s.trim())
    .filter(s => s.length > 0);

  for (const sentence of sentences) {
    if (!DECISION_ANCHORS.some(rx => rx.test(sentence))) continue;
    const norm = sentence.toLowerCase();
    if (seen.has(norm)) continue;
    seen.add(norm);
    const title = sentence.length > 80 ? sentence.slice(0, 77) + '…' : sentence;
    out.push({ title, content: sentence.slice(0, 2000) });
    if (out.length >= 10) break;
  }
  return out;
}

/**
 * Walk a task's resultSummary for decision phrases and persist each as a
 * `context_items.memory_type='decision'` row with sourceType='task' and
 * trust 0.5 (per PRD §9.7). Best-effort — never throws.
 */
export function captureDecisionsFromTask(task) {
  if (!task || !task.id) return [];
  try {
    const text = task.resultSummary || task.output || '';
    const decisions = detectDecisions(text);
    if (decisions.length === 0) return [];
    const project = task.project || '_global';
    const written = [];
    for (const d of decisions) {
      try {
        const row = addContextItem({
          project,
          scopeType: 'task',
          scopeId: task.id,
          memoryType: 'decision',
          title: d.title,
          content: d.content,
          sourceType: 'task',
          sourceId: task.id,
          trustScore: 0.5,
          authoredBy: `task:${task.id}`,
        });
        if (row) written.push(row);
      } catch (err) {
        console.error(`[context-capture] decision write failed for task ${task.id}: ${err.message}`);
      }
    }
    return written;
  } catch (err) {
    console.error(`[context-capture] captureDecisionsFromTask failed for ${task?.id}: ${err.message}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Risk detection — security/compliance keyword anchors with word boundaries
// ---------------------------------------------------------------------------

const RISK_ANCHORS = [
  { rx: /\bvulnerabilit(?:y|ies)\b/i,                term: 'vulnerability' },
  { rx: /\bsecrets?\b/i,                             term: 'secret' },
  { rx: /\bcredentials?\b/i,                         term: 'credential' },
  { rx: /\bauth\s+bypass\b/i,                        term: 'auth_bypass' },
  { rx: /\b(?:sql|command|prompt|template)\s+injection\b/i, term: 'injection' },
  { rx: /\binjection\s+(?:attack|flaw|vector)\b/i,   term: 'injection' },
  { rx: /\bRCE\b/,                                   term: 'rce' },
  { rx: /\bremote\s+code\s+execution\b/i,            term: 'rce' },
  { rx: /\bPII\b/,                                   term: 'pii' },
  { rx: /\bpersonally\s+identifiable\s+information\b/i, term: 'pii' },
];

/**
 * Detect security/compliance risk terms in free-form text. Word-boundary
 * aware: 'auth' in 'authority' will not match 'auth bypass'. Returns an
 * array of {term, snippet} hits (deduplicated by term). Empty/non-string
 * input returns [].
 */
export function detectRiskTerms(text) {
  if (typeof text !== 'string' || text.trim().length === 0) return [];
  const hits = [];
  const seen = new Set();
  for (const { rx, term } of RISK_ANCHORS) {
    const m = text.match(rx);
    if (!m) continue;
    if (seen.has(term)) continue;
    seen.add(term);
    const idx = typeof m.index === 'number' ? m.index : 0;
    const start = Math.max(0, idx - 80);
    const end = Math.min(text.length, idx + m[0].length + 80);
    const snippet = text.slice(start, end).replace(/\s+/g, ' ').trim();
    hits.push({ term, snippet });
  }
  return hits;
}

/**
 * Walk a task's output/resultSummary for risk terms and persist each hit as
 * a `proposed_rules` row (source_type='risk_keyword', status='pending',
 * trust 0.6) per PRD §9.7. Gated — never auto-promotes; review queue only.
 * Best-effort — never throws.
 */
export function captureRisksFromTask(task) {
  if (!task || !task.id) return [];
  try {
    const text = `${task.resultSummary || ''}\n${task.output || ''}\n${task.error || ''}`;
    const hits = detectRiskTerms(text);
    if (hits.length === 0) return [];
    const project = task.project || '_global';
    const now = new Date().toISOString();
    const written = [];
    for (const h of hits) {
      try {
        const id = randomUUID();
        const draftName = `risk-${h.term}-${id.slice(0, 6)}`;
        const draftContent = `Risk surfaced from task ${task.id}: ${h.term}\n\nSnippet: ${h.snippet}\n\nReview before adopting as a rule.`;
        const evidence = JSON.stringify({ taskId: task.id, term: h.term, snippet: h.snippet });
        getDb().prepare(`
          INSERT INTO proposed_rules (
            id, project, source_type, source_id,
            draft_category, draft_name, draft_paths, draft_content,
            evidence, trust_score, status, authored_by, created_at
          ) VALUES (?, ?, 'risk_keyword', ?, 'security', ?, NULL, ?, ?, 0.6, 'pending', ?, ?)
        `).run(
          id, project, task.id,
          draftName,
          draftContent,
          evidence,
          `task:${task.id}`,
          now,
        );
        const row = stmt('SELECT * FROM proposed_rules WHERE id = ?').get(id);
        if (row) written.push(row);
      } catch (err) {
        console.error(`[context-capture] risk write failed for task ${task.id}/${h.term}: ${err.message}`);
      }
    }
    return written;
  } catch (err) {
    console.error(`[context-capture] captureRisksFromTask failed for ${task?.id}: ${err.message}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// proposeRuleFromEvalCluster — manual MCP only (NOT auto-triggered)
// ---------------------------------------------------------------------------

/**
 * Produce a deterministic cluster id from the cluster's eval ids.
 */
function clusterIdFor(cluster) {
  const evalIds = (cluster.evals || []).map(e => e.id).filter(Boolean).sort();
  const hash = createHash('sha1').update(evalIds.join(',')).digest('hex').slice(0, 12);
  return `${cluster.category}:${hash}`;
}

/**
 * Draft a `proposed_rules` row for an eval cluster. Caller passes a cluster
 * id (deterministic hash) OR the id of any one eval that's part of a cluster
 * — either resolves the same cluster. Returns the inserted row or null when
 * no matching cluster exists. NOT called automatically anywhere — exposed
 * via `workforce_propose_rule_from_cluster` only (PRD §9.7).
 */
export function proposeRuleFromEvalCluster(clusterIdOrEvalId, { project } = {}) {
  if (!clusterIdOrEvalId) return null;
  try {
    const clusters = clusterEvals();
    let match = null;
    for (const c of clusters) {
      if (clusterIdFor(c) === clusterIdOrEvalId) { match = c; break; }
      if ((c.evals || []).some(e => e.id === clusterIdOrEvalId)) { match = c; break; }
    }
    if (!match) return null;

    const sr = match.suggestedRule || {};
    const evidence = {
      clusterId: clusterIdFor(match),
      category: match.category,
      evalCount: match.evalCount,
      taskIds: (match.evals || []).map(e => e.taskId).filter(Boolean),
      evalIds: (match.evals || []).map(e => e.id).filter(Boolean),
      confidence: match.confidence,
    };

    const id = randomUUID();
    const now = new Date().toISOString();
    const proj = project || '_global';

    getDb().prepare(`
      INSERT INTO proposed_rules (
        id, project, source_type, source_id,
        draft_category, draft_name, draft_paths, draft_content,
        evidence, trust_score, status, authored_by, created_at
      ) VALUES (?, ?, 'eval_cluster', ?, ?, ?, ?, ?, ?, 0.6, 'pending', ?, ?)
    `).run(
      id, proj, evidence.clusterId,
      sr.category || 'patterns',
      sr.name || `cluster-${match.category}-${id.slice(0, 6)}`,
      JSON.stringify(sr.paths || []),
      sr.content || `Auto-drafted from ${match.evalCount} similar ${match.category} failures.`,
      JSON.stringify(evidence),
      'capture-pipeline',
      now,
    );

    return stmt('SELECT * FROM proposed_rules WHERE id = ?').get(id);
  } catch (err) {
    console.error(`[context-capture] proposeRuleFromEvalCluster failed for ${clusterIdOrEvalId}: ${err.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Queue read
// ---------------------------------------------------------------------------

/**
 * List `proposed_rules` rows. Filters by project + status; ORDER BY
 * created_at DESC; default limit 50. Returns [] on error.
 */
export function listProposedRules({ project, status, limit } = {}) {
  try {
    let sql = 'SELECT * FROM proposed_rules WHERE 1=1';
    const params = [];
    if (project) { sql += ' AND project = ?'; params.push(project); }
    if (status) { sql += ' AND status = ?'; params.push(status); }
    sql += ' ORDER BY created_at DESC';
    const n = Math.max(1, Math.min(500, Number(limit) || 50));
    sql += ' LIMIT ?';
    params.push(n);
    return getDb().prepare(sql).all(...params);
  } catch (err) {
    console.error(`[context-capture] listProposedRules failed: ${err.message}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Test-only exports
// ---------------------------------------------------------------------------
export const _internals = {
  DECISION_ANCHORS,
  RISK_ANCHORS,
  clusterIdFor,
  summarizeFailureWithHaiku,
  normalizeGlobSignature,
};
