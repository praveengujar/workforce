/**
 * Replay runner — Context Fabric Milestone 0 (golden replay harness).
 *
 * Loads frozen task fixtures from disk, scores each one against a fixed
 * scoring pipeline, and emits a deterministic scorecard. Used as the gate
 * for every later milestone of the Context Management Fabric (PRD §17 M0).
 *
 * In M0 the harness does not re-execute tasks — it scores the recorded
 * outcome stored in each fixture. Later milestones (M4 assembler, M6 worker
 * integration) will optionally re-execute via the assembler; the scorecard
 * shape stays stable so baselines remain comparable.
 *
 * No new npm deps. ESM (matches existing mcp-server module style; the
 * package is `"type": "module"`). Logs to stderr only — stdout is reserved
 * for MCP JSON-RPC.
 */

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, isAbsolute, resolve } from 'node:path';

const FIXTURE_EXT = '.json';
const SCORE_VERSION = 1;

/**
 * Load and validate a single fixture file.
 * Throws with a precise message on schema violation — easier to debug than
 * silent skips.
 */
function loadFixture(filePath) {
  const raw = readFileSync(filePath, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Fixture ${filePath}: invalid JSON (${err.message})`);
  }

  const required = ['id', 'taskType', 'prompt', 'expected'];
  for (const k of required) {
    if (!(k in parsed)) {
      throw new Error(`Fixture ${filePath}: missing required field '${k}'`);
    }
  }

  const exp = parsed.expected;
  const expRequired = ['mergeEligible', 'reviewScore', 'tokensUsed', 'ralphWiggumIncidents'];
  for (const k of expRequired) {
    if (!(k in exp)) {
      throw new Error(`Fixture ${filePath}: expected.${k} missing`);
    }
  }

  if (typeof exp.mergeEligible !== 'boolean') {
    throw new Error(`Fixture ${filePath}: expected.mergeEligible must be boolean`);
  }
  if (typeof exp.reviewScore !== 'number' || exp.reviewScore < 0 || exp.reviewScore > 100) {
    throw new Error(`Fixture ${filePath}: expected.reviewScore must be 0-100`);
  }
  if (!Number.isInteger(exp.tokensUsed) || exp.tokensUsed < 0) {
    throw new Error(`Fixture ${filePath}: expected.tokensUsed must be non-negative integer`);
  }
  if (!Number.isInteger(exp.ralphWiggumIncidents) || exp.ralphWiggumIncidents < 0) {
    throw new Error(`Fixture ${filePath}: expected.ralphWiggumIncidents must be non-negative integer`);
  }

  return { ...parsed, _file: filePath };
}

/**
 * Score a single fixture. The scoring is deliberately simple in M0: pass
 * through the recorded outcome with normalisation. Later milestones can
 * override `scoreOne` if they re-execute the task via the assembler.
 */
function scoreOne(fixture) {
  const exp = fixture.expected;
  return {
    fixtureId: fixture.id,
    taskType: fixture.taskType,
    mergeEligible: exp.mergeEligible === true,
    reviewScore: Math.round(exp.reviewScore * 10) / 10,
    tokensUsed: exp.tokensUsed | 0,
    ralphWiggumIncidents: exp.ralphWiggumIncidents | 0,
    pinnedSha: fixture.pinnedSha ?? null,
    scoreVersion: SCORE_VERSION,
  };
}

function summarize(taskScores) {
  const n = taskScores.length;
  if (n === 0) {
    return {
      totals: { fixtures: 0, mergeEligible: 0, ralphWiggumIncidents: 0, tokensUsed: 0 },
      averages: { reviewScore: 0, tokensUsed: 0 },
      ralphWiggumIncidents: 0,
    };
  }

  let totalReview = 0;
  let totalTokens = 0;
  let mergeCount = 0;
  let ralphTotal = 0;

  for (const t of taskScores) {
    totalReview += t.reviewScore;
    totalTokens += t.tokensUsed;
    if (t.mergeEligible) mergeCount += 1;
    ralphTotal += t.ralphWiggumIncidents;
  }

  return {
    totals: {
      fixtures: n,
      mergeEligible: mergeCount,
      ralphWiggumIncidents: ralphTotal,
      tokensUsed: totalTokens,
    },
    averages: {
      reviewScore: Math.round((totalReview / n) * 100) / 100,
      tokensUsed: Math.round(totalTokens / n),
    },
    ralphWiggumIncidents: ralphTotal,
  };
}

function pctDelta(current, baseline) {
  if (baseline === 0) return current === 0 ? 0 : null;
  return Math.round(((current - baseline) / baseline) * 10000) / 100;
}

function diffSummary(current, baseline) {
  if (!baseline || !baseline.summary) return null;
  const b = baseline.summary;
  const c = current;
  return {
    fixtureCountDelta: c.totals.fixtures - b.totals.fixtures,
    mergeEligibleDelta: c.totals.mergeEligible - b.totals.mergeEligible,
    ralphWiggumDelta: c.totals.ralphWiggumIncidents - b.totals.ralphWiggumIncidents,
    avgReviewScoreDelta: Math.round((c.averages.reviewScore - b.averages.reviewScore) * 100) / 100,
    avgReviewScorePctDelta: pctDelta(c.averages.reviewScore, b.averages.reviewScore),
    avgTokensDelta: c.averages.tokensUsed - b.averages.tokensUsed,
    avgTokensPctDelta: pctDelta(c.averages.tokensUsed, b.averages.tokensUsed),
  };
}

/**
 * Discover fixture files under goldenDir. Skips the README and baseline.
 * Returns absolute paths sorted lexicographically for deterministic order.
 */
function listFixtureFiles(goldenDir) {
  if (!existsSync(goldenDir)) {
    throw new Error(`Golden fixture directory not found: ${goldenDir}`);
  }
  const st = statSync(goldenDir);
  if (!st.isDirectory()) {
    throw new Error(`Golden fixture path is not a directory: ${goldenDir}`);
  }

  const skip = new Set(['baseline.json']);
  const entries = readdirSync(goldenDir, { withFileTypes: true });
  const files = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (!e.name.endsWith(FIXTURE_EXT)) continue;
    if (skip.has(e.name)) continue;
    files.push(join(goldenDir, e.name));
  }
  files.sort();
  return files;
}

function loadBaseline(baselineJson, goldenDir) {
  if (!baselineJson) return null;
  const path = isAbsolute(baselineJson) ? baselineJson : resolve(goldenDir, baselineJson);
  if (!existsSync(path)) {
    console.error(`[replay-runner] baseline not found at ${path} — proceeding without delta`);
    return null;
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    console.error(`[replay-runner] baseline parse failed: ${err.message}`);
    return null;
  }
}

/**
 * Run the golden replay set.
 *
 * @param {object}  opts
 * @param {string}  opts.goldenDir    Absolute path to fixture directory.
 * @param {string=} opts.baselineJson Path (absolute or relative to goldenDir) of baseline scorecard to diff against.
 * @param {boolean=} opts.dryRun      Reserved for future re-execution mode; ignored in M0 (scoring is always pure).
 * @returns {{tasks: object[], summary: object, deltaVsBaseline?: object|null, runAt: string, scoreVersion: number}}
 */
export function runGoldenSet({ goldenDir, baselineJson, dryRun = false } = {}) {
  if (!goldenDir) throw new Error('runGoldenSet: goldenDir is required');

  const files = listFixtureFiles(goldenDir);
  if (files.length === 0) {
    console.error(`[replay-runner] no fixtures found in ${goldenDir}`);
  }

  const tasks = files.map(f => scoreOne(loadFixture(f)));
  const summary = summarize(tasks);

  const baseline = loadBaseline(baselineJson, goldenDir);
  const deltaVsBaseline = baseline ? diffSummary(summary, baseline) : null;

  const result = {
    runAt: new Date().toISOString(),
    scoreVersion: SCORE_VERSION,
    fixtureDir: goldenDir,
    dryRun: !!dryRun,
    tasks,
    summary,
  };
  if (deltaVsBaseline) result.deltaVsBaseline = deltaVsBaseline;

  console.error(
    `[replay-runner] scored ${tasks.length} fixtures `
    + `(merge ${summary.totals.mergeEligible}/${summary.totals.fixtures}, `
    + `avg review ${summary.averages.reviewScore}, `
    + `ralph ${summary.ralphWiggumIncidents})`
  );

  return result;
}

export const _internals = { loadFixture, scoreOne, summarize, listFixtureFiles, SCORE_VERSION };
