/**
 * Autonomy Policy Engine — evaluates whether an autonomous merge is safe.
 *
 * Returns a structured verdict; never acts directly. The lifecycle layer
 * persists the verdict to `tasks.autonomyDecision`, writes one
 * `autonomy_decision` task event, and then `validateGates()` accepts the
 * substitute gate only when the persisted verdict says `auto-approve`.
 *
 * Shadow mode is first-class: `evaluate()` is identical regardless of mode.
 * What differs is what the caller does with the result. In shadow mode, the
 * caller stores the verdict for telemetry/forensics but never alters the
 * task lifecycle.
 *
 * Verdict shape:
 *   {
 *     policyVersion, configHash, evaluatedAt,
 *     decision: 'auto-approve' | 'park-for-human' | 'auto-reject',
 *     checks: { reviewScore, securityScore, blastRadius, protectedPaths,
 *               preMergeTests, freshness, budget, branch, knowledgeWrites },
 *     blastRadius: { additions, deletions, filesChanged, dirsTouched,
 *                    categories, generatedFiles, manifestChanges },
 *     freshness: { baseSha, mergeBaseSha, behindBase, conflictsDetected,
 *                  upstreamProtectedTouched, dependsOnReverted },
 *     reasons: [ ...string ],
 *   }
 *
 * The engine is intentionally pure given its inputs — it does NOT call
 * `validateGates`, does NOT write events, and does NOT mutate the task.
 * That keeps gate validation dumb and prevents two policy engines from
 * drifting.
 */

import { policyVersion, configHash, getAutonomyConfig } from './autonomy-controller.js';

// ---------------------------------------------------------------------------
// Glob matcher — minimal, fast, no deps. Supports **, *, ? and leading /.
// ---------------------------------------------------------------------------

function globToRegex(glob) {
  let re = '^';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // **/ or just **
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('.+()|^$[]{}\\'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  re += '$';
  return new RegExp(re);
}

function matchAny(path, globs) {
  if (!Array.isArray(globs) || globs.length === 0) return false;
  return globs.some((g) => globToRegex(g).test(path));
}

export function matchesGlob(path, glob) {
  return globToRegex(glob).test(path);
}

export function matchesAnyGlob(path, globs) {
  return matchAny(path, globs);
}

// ---------------------------------------------------------------------------
// Classifier — assign each touched path to risk categories
// ---------------------------------------------------------------------------

export function classifyPaths(files, categoryGlobs = {}) {
  const hits = new Set();
  for (const file of files) {
    for (const [category, globs] of Object.entries(categoryGlobs)) {
      if (matchAny(file, globs)) hits.add(category);
    }
  }
  return Array.from(hits).sort();
}

// ---------------------------------------------------------------------------
// Blast radius
// ---------------------------------------------------------------------------

const MANIFEST_PATHS = [
  'package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock',
  'requirements.txt', 'Pipfile', 'Pipfile.lock', 'poetry.lock',
  'go.mod', 'go.sum', 'Cargo.toml', 'Cargo.lock',
];

const GENERATED_HINTS = ['/dist/', '/build/', '/.next/', '/coverage/', '/node_modules/'];

export function evaluateBlastRadius({
  additions = 0,
  deletions = 0,
  files = [],
  cfg = {},
}) {
  const filesChanged = files.length;
  const dirsTouched = new Set(
    files.map((f) => {
      const ix = f.lastIndexOf('/');
      return ix === -1 ? '.' : f.slice(0, ix);
    }),
  ).size;

  const categories = classifyPaths(files, cfg.categoryGlobs || {});
  const highRisk = new Set(cfg.highRiskCategories || []);
  const triggeredHighRisk = categories.filter((c) => highRisk.has(c));

  const manifestChanges = files.some((f) => MANIFEST_PATHS.includes(f) || f.endsWith('/package.json'));
  const generatedFiles = files.some((f) => GENERATED_HINTS.some((h) => f.includes(h)));

  const protectedHit = matchAny(files.join('\n'), []) || files.some((f) => matchAny(f, cfg.protectedPaths || []));

  const reasons = [];
  let pass = true;

  if (additions > (cfg.maxAdditions ?? Infinity)) {
    pass = false;
    reasons.push(`additions ${additions} > ${cfg.maxAdditions}`);
  }
  if (deletions > (cfg.maxDeletions ?? Infinity)) {
    pass = false;
    reasons.push(`deletions ${deletions} > ${cfg.maxDeletions}`);
  }
  if (filesChanged > (cfg.maxFiles ?? Infinity)) {
    pass = false;
    reasons.push(`files ${filesChanged} > ${cfg.maxFiles}`);
  }
  if (dirsTouched > (cfg.maxDirs ?? Infinity)) {
    pass = false;
    reasons.push(`dirs ${dirsTouched} > ${cfg.maxDirs}`);
  }
  if (triggeredHighRisk.length > 0) {
    pass = false;
    reasons.push(`high-risk categories: ${triggeredHighRisk.join(',')}`);
  }
  if (manifestChanges) {
    pass = false;
    reasons.push('dependency manifest changed');
  }
  if (generatedFiles) {
    pass = false;
    reasons.push('generated files touched');
  }

  return {
    pass,
    reasons,
    summary: {
      additions, deletions, filesChanged, dirsTouched,
      categories, generatedFiles, manifestChanges, protectedHit,
    },
  };
}

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------

function passFail(ok) { return ok ? 'pass' : 'fail'; }

function checkReviewScore(reviewScore, min) {
  if (reviewScore == null) return { ok: false, reason: 'no review score' };
  if (reviewScore < min) return { ok: false, reason: `review ${reviewScore} < ${min}` };
  return { ok: true };
}

function checkSecurityScore(securityScore, min) {
  if (securityScore == null) return { ok: false, reason: 'no security score' };
  if (securityScore < min) return { ok: false, reason: `security ${securityScore} < ${min}` };
  return { ok: true };
}

function checkProtectedPaths(files, protectedPaths) {
  const hits = files.filter((f) => matchAny(f, protectedPaths || []));
  if (hits.length > 0) return { ok: false, reason: `touched: ${hits.slice(0, 3).join(', ')}` };
  return { ok: true };
}

function checkBranch(targetBranch, protectedBranches) {
  if (!targetBranch) return { ok: true };
  if (matchAny(targetBranch, protectedBranches || [])) {
    return { ok: false, reason: `targets protected branch ${targetBranch}` };
  }
  return { ok: true };
}

function checkBudget(budget) {
  if (!budget) return { ok: true };
  if (budget.exceeded) return { ok: false, reason: `budget exceeded` };
  return { ok: true };
}

function checkKnowledgeWrites(promotedRules) {
  if (promotedRules > 0) return { ok: false, reason: 'rules promoted during autonomous run' };
  return { ok: true };
}

function checkPreMergeTests(tests) {
  if (tests == null) return { ok: false, reason: 'no pre-merge test result' };
  if (tests.passed === false) return { ok: false, reason: 'pre-merge tests failed' };
  return { ok: tests.passed === true };
}

function checkFreshness(freshness) {
  if (!freshness) return { ok: false, reason: 'no freshness data' };
  if (freshness.dependsOnReverted) return { ok: false, reason: 'depends on reverted task' };
  if (freshness.conflictsDetected) return { ok: false, reason: 'merge conflicts detected' };
  if (freshness.upstreamProtectedTouched) return { ok: false, reason: 'protected files changed upstream' };
  if (Number.isFinite(freshness.behindBase) && Number.isFinite(freshness.maxBehind) && freshness.behindBase > freshness.maxBehind) {
    return { ok: false, reason: `${freshness.behindBase} commits behind base` };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// evaluate — the main entry point
// ---------------------------------------------------------------------------

/**
 * @param {object} input
 * @param {object} input.task                  Task row
 * @param {number|null} input.reviewScore      Weighted review score 0..100
 * @param {number|null} input.securityScore    Security score 0..100 (100 = no findings)
 * @param {number} input.additions
 * @param {number} input.deletions
 * @param {string[]} input.files               Changed file paths
 * @param {string} input.targetBranch
 * @param {object|null} input.budget           { exceeded: boolean, remainingUsd: number }
 * @param {object|null} input.tests            { passed: boolean }; pass='ok', fail='no', null='not yet run'
 * @param {object|null} input.freshness        { behindBase, conflictsDetected, upstreamProtectedTouched, dependsOnReverted, maxBehind }
 * @param {number} input.promotedRules         Count of rules promoted during this run (must be 0 for auto)
 * @param {boolean} input.requireTests         Default true. Pre-merge tests must have run.
 */
export function evaluate(input) {
  const cfg = getAutonomyConfig();
  const blastRadiusCfg = cfg.blastRadius || {};
  const protectedBranches = cfg.protectedBranches || [];
  const reasons = [];

  const review = checkReviewScore(input.reviewScore, cfg.reviewScoreMin ?? 80);
  if (!review.ok) reasons.push(`review: ${review.reason}`);

  const security = checkSecurityScore(input.securityScore, cfg.securityScoreMin ?? 100);
  if (!security.ok) reasons.push(`security: ${security.reason}`);

  const blastRadius = evaluateBlastRadius({
    additions: input.additions || 0,
    deletions: input.deletions || 0,
    files: input.files || [],
    cfg: blastRadiusCfg,
  });
  for (const r of blastRadius.reasons) reasons.push(`blastRadius: ${r}`);

  const protectedPaths = checkProtectedPaths(input.files || [], blastRadiusCfg.protectedPaths || []);
  if (!protectedPaths.ok) reasons.push(`protectedPaths: ${protectedPaths.reason}`);

  const branch = checkBranch(input.targetBranch, protectedBranches);
  if (!branch.ok) reasons.push(`branch: ${branch.reason}`);

  const budget = checkBudget(input.budget);
  if (!budget.ok) reasons.push(`budget: ${budget.reason}`);

  const knowledgeWrites = checkKnowledgeWrites(input.promotedRules || 0);
  if (!knowledgeWrites.ok) reasons.push(`knowledgeWrites: ${knowledgeWrites.reason}`);

  // Pre-merge tests + freshness are required only when `requireTests`/freshness data is provided.
  // In shadow mode early in implementation, these may be null; we report "fail" honestly so the
  // shadow telemetry shows what's still missing rather than silently passing.
  const requireTests = input.requireTests !== false;
  const preMergeTests = requireTests
    ? checkPreMergeTests(input.tests)
    : { ok: true };
  if (!preMergeTests.ok) reasons.push(`preMergeTests: ${preMergeTests.reason}`);

  const freshnessCheck = input.freshness !== undefined
    ? checkFreshness(input.freshness)
    : { ok: false, reason: 'freshness not yet computed' };
  if (!freshnessCheck.ok) reasons.push(`freshness: ${freshnessCheck.reason}`);

  const checks = {
    reviewScore:    passFail(review.ok),
    securityScore:  passFail(security.ok),
    blastRadius:    passFail(blastRadius.pass),
    protectedPaths: passFail(protectedPaths.ok),
    preMergeTests:  passFail(preMergeTests.ok),
    freshness:      passFail(freshnessCheck.ok),
    budget:         passFail(budget.ok),
    branch:         passFail(branch.ok),
    knowledgeWrites: passFail(knowledgeWrites.ok),
  };

  // Decision: auto-approve only if every check passes. Hard rejects on
  // security finding (score 0). Otherwise park-for-human.
  let decision;
  if (Object.values(checks).every((v) => v === 'pass')) {
    decision = 'auto-approve';
  } else if (input.securityScore != null && input.securityScore <= 0) {
    decision = 'auto-reject';
  } else {
    decision = 'park-for-human';
  }

  return {
    policyVersion: policyVersion(),
    configHash: configHash(),
    evaluatedAt: new Date().toISOString(),
    decision,
    checks,
    blastRadius: blastRadius.summary,
    freshness: input.freshness || null,
    reasons,
  };
}

// ---------------------------------------------------------------------------
// Test-only handles
// ---------------------------------------------------------------------------

export const _internals = {
  globToRegex,
  matchAny,
};
