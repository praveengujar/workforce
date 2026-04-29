/**
 * Smoke tests for the Context Fabric M0 golden replay harness.
 *
 * Run: node --test mcp-server/test/replay-runner.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { runGoldenSet } from '../core/replay-runner.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_GOLDEN_DIR = resolve(__dirname, 'golden');
const REPO_BASELINE = join(REPO_GOLDEN_DIR, 'baseline.json');

function makeFixture(overrides = {}) {
  return {
    id: overrides.id || 'sample',
    taskType: overrides.taskType || 'standard',
    prompt: overrides.prompt || 'sample prompt',
    plannedFiles: overrides.plannedFiles || [],
    pinnedSha: overrides.pinnedSha ?? null,
    fixtureKind: overrides.fixtureKind || 'synthetic',
    description: overrides.description || 'unit-test fixture',
    expected: {
      mergeEligible: true,
      reviewScore: 80,
      tokensUsed: 5000,
      ralphWiggumIncidents: 0,
      ...(overrides.expected || {}),
    },
  };
}

function withTempGoldenDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'replay-test-'));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runGoldenSet — shape and scoring', () => {
  it('produces the expected scorecard shape', () => {
    withTempGoldenDir((dir) => {
      writeFileSync(join(dir, 'a.json'), JSON.stringify(makeFixture({ id: 'a' })));
      writeFileSync(join(dir, 'b.json'), JSON.stringify(makeFixture({
        id: 'b',
        expected: { mergeEligible: false, reviewScore: 50, tokensUsed: 9000, ralphWiggumIncidents: 2 },
      })));

      const out = runGoldenSet({ goldenDir: dir });

      assert.equal(out.tasks.length, 2);
      assert.equal(out.scoreVersion, 1);
      assert.match(out.runAt, /^\d{4}-\d{2}-\d{2}T/);
      assert.deepEqual(
        out.tasks.map(t => t.fixtureId).sort(),
        ['a', 'b'],
      );

      assert.equal(out.summary.totals.fixtures, 2);
      assert.equal(out.summary.totals.mergeEligible, 1);
      assert.equal(out.summary.totals.ralphWiggumIncidents, 2);
      assert.equal(out.summary.ralphWiggumIncidents, 2);
      assert.equal(out.summary.totals.tokensUsed, 14000);
      assert.equal(out.summary.averages.reviewScore, 65); // (80+50)/2
      assert.equal(out.summary.averages.tokensUsed, 7000);
    });
  });

  it('returns deterministic scores on identical input (idempotency)', () => {
    withTempGoldenDir((dir) => {
      writeFileSync(join(dir, 'one.json'), JSON.stringify(makeFixture({ id: 'one' })));
      writeFileSync(join(dir, 'two.json'), JSON.stringify(makeFixture({
        id: 'two',
        expected: { mergeEligible: true, reviewScore: 73.5, tokensUsed: 6200, ralphWiggumIncidents: 1 },
      })));

      const a = runGoldenSet({ goldenDir: dir });
      const b = runGoldenSet({ goldenDir: dir });

      assert.deepEqual(a.tasks, b.tasks);
      assert.deepEqual(a.summary, b.summary);
    });
  });

  it('orders fixtures lexicographically regardless of write order', () => {
    withTempGoldenDir((dir) => {
      writeFileSync(join(dir, 'zzz.json'), JSON.stringify(makeFixture({ id: 'zzz' })));
      writeFileSync(join(dir, 'aaa.json'), JSON.stringify(makeFixture({ id: 'aaa' })));
      writeFileSync(join(dir, 'mmm.json'), JSON.stringify(makeFixture({ id: 'mmm' })));

      const out = runGoldenSet({ goldenDir: dir });
      assert.deepEqual(out.tasks.map(t => t.fixtureId), ['aaa', 'mmm', 'zzz']);
    });
  });
});

describe('runGoldenSet — failure handling', () => {
  it('throws a clear error when goldenDir is missing', () => {
    const missing = join(tmpdir(), `does-not-exist-${Date.now()}`);
    assert.throws(
      () => runGoldenSet({ goldenDir: missing }),
      /Golden fixture directory not found/,
    );
  });

  it('throws when goldenDir is not provided', () => {
    assert.throws(() => runGoldenSet({}), /goldenDir is required/);
  });

  it('rejects fixtures with malformed expected fields', () => {
    withTempGoldenDir((dir) => {
      const bad = {
        id: 'bad', taskType: 'standard', prompt: 'p',
        expected: { mergeEligible: 'yes', reviewScore: 80, tokensUsed: 1, ralphWiggumIncidents: 0 },
      };
      writeFileSync(join(dir, 'bad.json'), JSON.stringify(bad));
      assert.throws(() => runGoldenSet({ goldenDir: dir }), /mergeEligible must be boolean/);
    });
  });

  it('rejects fixtures missing required top-level fields', () => {
    withTempGoldenDir((dir) => {
      const bad = { id: 'x', taskType: 'standard', expected: { mergeEligible: true, reviewScore: 1, tokensUsed: 1, ralphWiggumIncidents: 0 } };
      writeFileSync(join(dir, 'bad.json'), JSON.stringify(bad));
      assert.throws(() => runGoldenSet({ goldenDir: dir }), /missing required field 'prompt'/);
    });
  });

  it('rejects fixtures with reviewScore out of 0-100 range', () => {
    withTempGoldenDir((dir) => {
      writeFileSync(join(dir, 'bad.json'), JSON.stringify(makeFixture({
        expected: { mergeEligible: true, reviewScore: 150, tokensUsed: 1, ralphWiggumIncidents: 0 },
      })));
      assert.throws(() => runGoldenSet({ goldenDir: dir }), /reviewScore must be 0-100/);
    });
  });

  it('handles an empty fixture directory without throwing', () => {
    withTempGoldenDir((dir) => {
      const out = runGoldenSet({ goldenDir: dir });
      assert.equal(out.tasks.length, 0);
      assert.equal(out.summary.totals.fixtures, 0);
      assert.equal(out.summary.averages.reviewScore, 0);
    });
  });

  it('skips baseline.json and README.md, picks up only fixture .json', () => {
    withTempGoldenDir((dir) => {
      writeFileSync(join(dir, 'baseline.json'), JSON.stringify({ summary: {} }));
      writeFileSync(join(dir, 'README.md'), '# notes');
      writeFileSync(join(dir, 'real.json'), JSON.stringify(makeFixture({ id: 'real' })));
      const out = runGoldenSet({ goldenDir: dir });
      assert.equal(out.tasks.length, 1);
      assert.equal(out.tasks[0].fixtureId, 'real');
    });
  });
});

describe('runGoldenSet — baseline diff', () => {
  it('emits deltaVsBaseline when a baseline is provided', () => {
    withTempGoldenDir((dir) => {
      writeFileSync(join(dir, 'a.json'), JSON.stringify(makeFixture({
        id: 'a',
        expected: { mergeEligible: true, reviewScore: 90, tokensUsed: 5000, ralphWiggumIncidents: 0 },
      })));

      // Baseline that recorded a slightly lower review score.
      const baseline = {
        summary: {
          totals: { fixtures: 1, mergeEligible: 1, ralphWiggumIncidents: 0, tokensUsed: 5000 },
          averages: { reviewScore: 80, tokensUsed: 5000 },
          ralphWiggumIncidents: 0,
        },
        tasks: [],
      };
      const baselinePath = join(dir, 'baseline.json');
      writeFileSync(baselinePath, JSON.stringify(baseline));

      const out = runGoldenSet({ goldenDir: dir, baselineJson: 'baseline.json' });
      assert.ok(out.deltaVsBaseline, 'expected deltaVsBaseline to be present');
      assert.equal(out.deltaVsBaseline.avgReviewScoreDelta, 10);
      assert.equal(out.deltaVsBaseline.avgReviewScorePctDelta, 12.5);
      assert.equal(out.deltaVsBaseline.fixtureCountDelta, 0);
    });
  });

  it('omits delta when baselineJson does not exist', () => {
    withTempGoldenDir((dir) => {
      writeFileSync(join(dir, 'a.json'), JSON.stringify(makeFixture({ id: 'a' })));
      const out = runGoldenSet({ goldenDir: dir, baselineJson: 'nope.json' });
      assert.equal(out.deltaVsBaseline, undefined);
    });
  });
});

describe('runGoldenSet — reproducibility against committed baseline', () => {
  it('committed baseline matches a fresh run within tolerance', () => {
    if (!existsSync(REPO_BASELINE)) return; // don't fail if the file isn't present yet
    const baseline = JSON.parse(readFileSync(REPO_BASELINE, 'utf8'));
    const out = runGoldenSet({ goldenDir: REPO_GOLDEN_DIR });

    assert.equal(out.summary.totals.fixtures, baseline.summary.totals.fixtures);
    assert.equal(out.summary.totals.mergeEligible, baseline.summary.totals.mergeEligible);
    assert.equal(out.summary.totals.ralphWiggumIncidents, baseline.summary.totals.ralphWiggumIncidents);

    const tolerance = 0.02; // ±2 %
    function withinTolerance(current, base) {
      if (base === 0) return current === 0;
      return Math.abs(current - base) / Math.abs(base) <= tolerance;
    }
    assert.ok(
      withinTolerance(out.summary.averages.reviewScore, baseline.summary.averages.reviewScore),
      `avg review score drifted: ${out.summary.averages.reviewScore} vs ${baseline.summary.averages.reviewScore}`,
    );
    assert.ok(
      withinTolerance(out.summary.averages.tokensUsed, baseline.summary.averages.tokensUsed),
      `avg tokens drifted: ${out.summary.averages.tokensUsed} vs ${baseline.summary.averages.tokensUsed}`,
    );
  });

  it('repo golden directory ships at least 5 fixtures (PRD M0 minimum)', () => {
    if (!existsSync(REPO_GOLDEN_DIR)) return;
    const out = runGoldenSet({ goldenDir: REPO_GOLDEN_DIR });
    assert.ok(out.tasks.length >= 5, `expected ≥5 fixtures, got ${out.tasks.length}`);
  });
});
