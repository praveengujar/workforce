#!/usr/bin/env node

/**
 * Startup hook — runs on SessionStart to clean up stale state.
 * Prunes orphaned git worktrees and checks for in-progress merges.
 */

import { execFileSync } from 'node:child_process';

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
  const { existsSync } = await import('node:fs');
  const { join } = await import('node:path');

  const mergeHead = join(projectDir, '.git', 'MERGE_HEAD');
  if (existsSync(mergeHead)) {
    execFileSync('git', ['merge', '--abort'], { cwd: projectDir, stdio: 'pipe' });
    console.error('[workforce:startup] Aborted stale merge');
  }
} catch {
  // ignore
}
