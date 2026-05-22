/**
 * Autonomy evidence collectors — pre-merge verification, freshness, diff stats.
 *
 * These functions gather the inputs the policy engine needs and never make
 * decisions themselves. All are pure(ish) — they shell out to git/test
 * commands but do not mutate task state.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gitExec } from './constants.js';
import { getAutonomyConfig } from './autonomy-controller.js';
import { matchesAnyGlob } from './autonomy-policy.js';
import { getTask } from './db.js';

// ---------------------------------------------------------------------------
// Diff stats — additions/deletions/files
// ---------------------------------------------------------------------------

export function collectDiffStats({ repoRoot, branchName, baseBranch }) {
  let additions = 0;
  let deletions = 0;
  const files = [];

  try {
    const numstat = gitExec(['diff', '--numstat', `${baseBranch}...${branchName}`], { cwd: repoRoot });
    for (const line of numstat.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const m = trimmed.match(/^(\d+|-)\s+(\d+|-)\s+(.+)$/);
      if (!m) continue;
      const a = m[1] === '-' ? 0 : parseInt(m[1], 10);
      const d = m[2] === '-' ? 0 : parseInt(m[2], 10);
      additions += a;
      deletions += d;
      files.push(m[3]);
    }
  } catch {
    // diff failed — return zeros so policy parks the task with "no data"
  }

  return { additions, deletions, files };
}

// ---------------------------------------------------------------------------
// Pre-merge verification — run test command inside the worktree
// ---------------------------------------------------------------------------

export function detectTestCommand(repoRoot) {
  try {
    const pkgPath = join(repoRoot, 'package.json');
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      if (pkg.scripts?.test && pkg.scripts.test !== 'echo "Error: no test specified" && exit 1') {
        return { cmd: 'npm', args: ['test', '--', '--bail'] };
      }
    }
  } catch { /* ignore */ }
  try {
    if (existsSync(join(repoRoot, 'Makefile'))) {
      const mk = readFileSync(join(repoRoot, 'Makefile'), 'utf8');
      if (mk.includes('test:')) return { cmd: 'make', args: ['test'] };
    }
  } catch { /* ignore */ }
  return null;
}

/**
 * Run test command in worktreePath. Returns { ran, passed, output }.
 * If no test command can be detected, returns { ran: false }.
 */
export function runPreMergeTests({ worktreePath, timeoutMs = 120_000 }) {
  const cmd = detectTestCommand(worktreePath);
  if (!cmd) return { ran: false };
  try {
    execFileSync(cmd.cmd, cmd.args, {
      cwd: worktreePath, timeout: timeoutMs, stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { ran: true, passed: true };
  } catch (err) {
    const stderr = err.stderr?.toString().slice(-1000) || err.message || 'tests failed';
    return { ran: true, passed: false, error: stderr };
  }
}

// ---------------------------------------------------------------------------
// Freshness — merge-base distance, conflict detection, upstream-protected,
// reverted-dependency check
// ---------------------------------------------------------------------------

function _safeGit(args, repoRoot) {
  try { return gitExec(args, { cwd: repoRoot }); } catch { return null; }
}

export function checkFreshness({ repoRoot, branchName, baseBranch, task }) {
  const cfg = getAutonomyConfig();
  const maxBehind = cfg.freshness?.maxCommitsBehindBase ?? 10;
  const protectedPaths = cfg.blastRadius?.protectedPaths || [];

  const baseSha = _safeGit(['rev-parse', baseBranch], repoRoot);
  const branchSha = _safeGit(['rev-parse', branchName], repoRoot);
  const mergeBaseSha = baseSha && branchSha
    ? _safeGit(['merge-base', baseBranch, branchName], repoRoot)
    : null;

  // How many commits is the base ahead of merge-base?
  let behindBase = 0;
  if (mergeBaseSha && baseSha && mergeBaseSha !== baseSha) {
    const out = _safeGit(['rev-list', '--count', `${mergeBaseSha}..${baseSha}`], repoRoot);
    behindBase = out ? parseInt(out, 10) : 0;
  }

  // Upstream protected: did any protected path change in base..mergeBase..base
  // while this branch was being worked? Comparing base vs mergeBase shows what
  // upstream landed.
  let upstreamProtectedTouched = false;
  if (mergeBaseSha && baseSha && mergeBaseSha !== baseSha) {
    const out = _safeGit(['diff', '--name-only', `${mergeBaseSha}..${baseSha}`], repoRoot);
    if (out) {
      const changed = out.split('\n').filter(Boolean);
      upstreamProtectedTouched = changed.some((f) => matchesAnyGlob(f, protectedPaths));
    }
  }

  // Conflict dry-run: try a no-commit merge, then abort.
  let conflictsDetected = false;
  try {
    // Find current HEAD to restore after dry-run
    const currentHead = _safeGit(['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot);
    if (currentHead && baseBranch) {
      try {
        gitExec(['checkout', baseBranch], { cwd: repoRoot });
        try {
          gitExec(['merge', '--no-commit', '--no-ff', branchName], { cwd: repoRoot });
          // No conflict — abort the in-progress merge so we don't actually merge.
          try { gitExec(['merge', '--abort'], { cwd: repoRoot }); } catch { /* ignore */ }
        } catch (mergeErr) {
          conflictsDetected = true;
          try { gitExec(['merge', '--abort'], { cwd: repoRoot }); } catch { /* ignore */ }
        }
      } finally {
        if (currentHead !== baseBranch) {
          try { gitExec(['checkout', currentHead], { cwd: repoRoot }); } catch { /* ignore */ }
        }
      }
    }
  } catch {
    // dry-run not possible; leave conflictsDetected=false but mark unknown
  }

  // depends-on-reverted: any upstream task in dependsOn was reverted?
  let dependsOnReverted = false;
  if (task && task.dependsOn) {
    try {
      const deps = JSON.parse(task.dependsOn);
      for (const depId of deps) {
        const dep = getTask(depId);
        if (dep && dep.revertedAt) { dependsOnReverted = true; break; }
      }
    } catch { /* ignore */ }
  }

  return {
    baseSha, branchSha, mergeBaseSha,
    behindBase, maxBehind,
    conflictsDetected, upstreamProtectedTouched, dependsOnReverted,
  };
}
