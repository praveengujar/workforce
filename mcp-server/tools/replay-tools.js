/**
 * Replay tool handlers — Context Fabric M0.
 *
 * Exposes the golden-replay harness as MCP tools and persists each run to
 * the `replay_runs` table so deltas can be tracked over time.
 */

import { join, dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { runGoldenSet } from '../core/replay-runner.js';
import { getDb } from '../core/db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DEFAULT_GOLDEN_DIR = resolve(__dirname, '..', 'test', 'golden');

function resolveGoldenDir(input) {
  if (!input) return DEFAULT_GOLDEN_DIR;
  return isAbsolute(input) ? input : resolve(process.cwd(), input);
}

function persistRun(scorecard, baselineRunId) {
  try {
    const db = getDb();
    const runId = `replay-${Date.now()}-${randomUUID().slice(0, 8)}`;
    db.prepare(
      'INSERT INTO replay_runs (run_id, run_at, scorecard_json, baseline_run_id) VALUES (?, ?, ?, ?)',
    ).run(runId, scorecard.runAt, JSON.stringify(scorecard), baselineRunId ?? null);
    return runId;
  } catch (err) {
    console.error(`[replay-tools] failed to persist run: ${err.message}`);
    return null;
  }
}

function formatScorecard(scorecard, runId) {
  const lines = [];
  lines.push('═══ Workforce Golden Replay Scorecard ═══');
  if (runId) lines.push(`run_id:        ${runId}`);
  lines.push(`run_at:        ${scorecard.runAt}`);
  lines.push(`fixture_dir:   ${scorecard.fixtureDir}`);
  lines.push(`score_version: ${scorecard.scoreVersion}`);
  lines.push(`fixtures:      ${scorecard.summary.totals.fixtures}`);
  lines.push('');
  lines.push('── Totals ──');
  lines.push(`merge_eligible:        ${scorecard.summary.totals.mergeEligible}/${scorecard.summary.totals.fixtures}`);
  lines.push(`tokens_used:           ${scorecard.summary.totals.tokensUsed}`);
  lines.push(`ralph_wiggum:          ${scorecard.summary.ralphWiggumIncidents}`);
  lines.push('');
  lines.push('── Averages ──');
  lines.push(`avg_review_score:      ${scorecard.summary.averages.reviewScore}`);
  lines.push(`avg_tokens_per_task:   ${scorecard.summary.averages.tokensUsed}`);

  if (scorecard.deltaVsBaseline) {
    const d = scorecard.deltaVsBaseline;
    lines.push('');
    lines.push('── Delta vs baseline ──');
    lines.push(`fixture_count:         ${d.fixtureCountDelta >= 0 ? '+' : ''}${d.fixtureCountDelta}`);
    lines.push(`merge_eligible:        ${d.mergeEligibleDelta >= 0 ? '+' : ''}${d.mergeEligibleDelta}`);
    lines.push(`ralph_wiggum:          ${d.ralphWiggumDelta >= 0 ? '+' : ''}${d.ralphWiggumDelta}`);
    const reviewPct = d.avgReviewScorePctDelta == null ? 'n/a' : `${d.avgReviewScorePctDelta}%`;
    const tokensPct = d.avgTokensPctDelta == null ? 'n/a' : `${d.avgTokensPctDelta}%`;
    lines.push(`avg_review_score:      ${d.avgReviewScoreDelta >= 0 ? '+' : ''}${d.avgReviewScoreDelta} (${reviewPct})`);
    lines.push(`avg_tokens_per_task:   ${d.avgTokensDelta >= 0 ? '+' : ''}${d.avgTokensDelta} (${tokensPct})`);
  }

  lines.push('');
  lines.push('── Per-fixture ──');
  for (const t of scorecard.tasks) {
    const merge = t.mergeEligible ? '✓' : '✗';
    const ralph = t.ralphWiggumIncidents > 0 ? ` ralph=${t.ralphWiggumIncidents}` : '';
    lines.push(`  ${merge} ${t.fixtureId.padEnd(40)} type=${t.taskType.padEnd(11)} review=${t.reviewScore} tokens=${t.tokensUsed}${ralph}`);
  }
  return lines.join('\n');
}

/**
 * MCP handler for `workforce_replay_golden_set`.
 * Inputs (all optional):
 *   golden_dir    — override fixture directory (absolute or cwd-relative)
 *   baseline_json — baseline scorecard path for delta reporting
 *   dry_run       — pass through to runner (M0: ignored)
 *   format        — 'text' (default) or 'json'
 */
export async function replayGoldenSetHandler({ golden_dir, baseline_json, dry_run, format } = {}) {
  const goldenDir = resolveGoldenDir(golden_dir);
  const scorecard = runGoldenSet({
    goldenDir,
    baselineJson: baseline_json,
    dryRun: !!dry_run,
  });
  const runId = persistRun(scorecard, null);

  if (format === 'json') {
    return { runId, scorecard };
  }
  return formatScorecard(scorecard, runId);
}

export const _internals = { resolveGoldenDir, persistRun, formatScorecard, DEFAULT_GOLDEN_DIR };
