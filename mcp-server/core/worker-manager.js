/**
 * Worker Manager — core task lifecycle for the MCP server.
 *
 * Ported from server/index.js (lines 248-860). Manages spawning Claude CLI
 * workers in git worktrees, handling exit/merge/cleanup, and promoting
 * pending tasks to fill available capacity.
 *
 * No Express, no WebSocket — pure lifecycle logic.
 */

import { spawn } from 'node:child_process';
import {
  readFileSync,
  existsSync,
} from 'node:fs';
import { appendFile as appendFileAsync } from 'node:fs/promises';
import { join } from 'node:path';
import { DATA_DIR, ensureDir, gitExec, CLAUDE_CLI } from './constants.js';

import {
  getAllTasks,
  getTask,
  updateTask,
  getRunningTasks,
  getPendingTasks,
  claimTask,
  releaseTaskClaim,
  registerWorker,
  removeWorker,
  getBudget,
  getCostForPeriod,
  recordCost,
  readAllSharedContext,
} from './db.js';
import { getReadyTasks, getCascadeFailures } from './dependency-resolver.js';
import { logEvent } from './task-events.js';
import { createToken, removeToken } from './project-state.js';
import {
  isTmuxAvailable,
  createSession,
  capturePane,
  killSession,
  hasSession,
  getSessionPid,
  isSessionAlive,
} from './tmux.js';
import { recordActualCost, classifyTier } from './cost-model.js';
import { estimateTaskCost } from './task-cost.js';
import { parseDetailedCost, appendCostLog } from './cost-tracker.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const MAX_CONCURRENT = parseInt(process.env.WORKFORCE_MAX_CONCURRENT || process.env.MAX_CONCURRENT || '10', 10);
const TASK_TIMEOUT = parseInt(process.env.WORKFORCE_TASK_TIMEOUT || String(30 * 60 * 1000), 10);
const STUCK_NUDGE = 8 * 60 * 1000;   // 480 000 ms
const AUTO_ARCHIVE_DELAY = 5 * 60 * 1000; // 300 000 ms
const MERGE_LOCKS = new Map(); // per-repo merge serialization
const HANDLED_EXITS = new Set(); // idempotency guard for tmux exit handling

let PROJECT_DIR = null;
let _promoteInterval = null;
let _promoting = false;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function extractTaskOutput(stdout) {
  if (!stdout) return '';
  const trimmed = stdout.trim();
  return trimmed.length > 4000 ? trimmed.slice(-4000) : trimmed;
}

function extractSessionId(stderr) {
  if (!stderr) return null;
  const match = stderr.match(/session[_\s]*id[:\s]+([a-f0-9-]+)/i);
  return match ? match[1] : null;
}

/**
 * Check whether any files changed in a worktree relative to a base commit.
 * Shared by both tmux and child_process exit handlers.
 */
function checkFilesChanged(worktreePath, baseCommit) {
  if (!worktreePath) return false;
  try {
    const compareRef = baseCommit || 'HEAD';
    const diff = gitExec(['diff', '--stat', compareRef], { cwd: worktreePath });
    if (diff.length > 0) return true;
    const logCount = gitExec(['rev-list', '--count', `${compareRef}..HEAD`], { cwd: worktreePath });
    return parseInt(logCount, 10) > 0;
  } catch {
    try {
      const untracked = gitExec(['status', '--porcelain'], { cwd: worktreePath });
      return untracked.length > 0;
    } catch {
      return false;
    }
  }
}

/**
 * Record actual cost from Claude CLI output. Shared by both exit handlers.
 */
function recordTaskCost(taskId, task, outputText) {
  try {
    const detailed = parseDetailedCost(outputText || '');
    const actualCost = detailed.cost;
    if (actualCost && actualCost > 0) {
      recordActualCost(task.prompt, actualCost);
      updateTask(taskId, { cost: actualCost });
      const tier = classifyTier(task.prompt || '');
      recordCost(taskId, task.project, actualCost, tier);
      appendCostLog({
        taskId, project: task.project || null, cost: actualCost, tier,
        inputTokens: detailed.inputTokens, outputTokens: detailed.outputTokens,
      });
    }
  } catch { /* ignore cost parsing errors */ }
}

/**
 * Extract a short result summary from Claude CLI output. Shared by both exit handlers.
 */
function extractResultSummary(taskId, outputText) {
  try {
    const summaryPatterns = [
      /Result:\s*(.+)/i,
      /Summary:\s*(.+)/i,
      /Done:\s*(.+)/i,
      /Created:\s*(.+)/i,
    ];
    let summary = null;
    for (const pattern of summaryPatterns) {
      const match = outputText.match(pattern);
      if (match) { summary = match[1].trim().slice(0, 500); break; }
    }
    if (!summary) {
      const lines = outputText.trim().split('\n').filter(l => l.trim().length > 10);
      summary = lines.length > 0 ? lines[lines.length - 1].trim().slice(0, 500) : null;
    }
    if (summary) {
      updateTask(taskId, { resultSummary: summary });
    }
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Core: promotePending
// ---------------------------------------------------------------------------
async function promotePending() {
  if (_promoting) return;
  _promoting = true;
  try {
    // 1. Cascade-fail any pending tasks whose dependencies have failed
    try {
      const cascadeFailures = getCascadeFailures();
      for (const task of cascadeFailures) {
        let failedDepIds = [];
        try {
          const deps = JSON.parse(task.dependsOn);
          for (const depId of deps) {
            const dep = getTask(depId);
            if (dep && dep.status === 'failed') failedDepIds.push(depId);
          }
        } catch { /* ignore */ }
        const depList = failedDepIds.join(', ');
        updateTask(task.id, {
          status: 'failed',
          error: `Dependency failed: task ${depList} is failed`,
          completedAt: new Date().toISOString(),
        });
        logEvent(task.id, 'cascade_failed', `Dependency failed: ${depList}`);
        console.error(`[promotePending] Cascade-failed task ${task.id} due to failed deps: ${depList}`);
      }
    } catch (err) {
      console.error('[promotePending] Cascade failure check error:', err.message);
    }

    // 2. Check available capacity
    const running = getRunningTasks();
    let slots = MAX_CONCURRENT - running.length;
    if (slots <= 0) return;

    // 3. Only promote tasks whose dependencies are fully satisfied
    const ready = getReadyTasks();
    // Sort by phase ASC (lower phase = higher priority), then createdAt ASC
    ready.sort((a, b) => {
      const phaseA = a.phase ?? Number.MAX_SAFE_INTEGER;
      const phaseB = b.phase ?? Number.MAX_SAFE_INTEGER;
      if (phaseA !== phaseB) return phaseA - phaseB;
      return (a.createdAt || '').localeCompare(b.createdAt || '');
    });

    for (const task of ready) {
      if (slots <= 0) break;
      const claimed = claimTask(task.id, 'server');
      if (!claimed) continue;

      try {
        await spawnWorker(task);
        slots--;
      } catch (err) {
        console.error(`[promotePending] Failed to spawn worker for ${task.id}:`, err.message);
        releaseTaskClaim(task.id);
        updateTask(task.id, { status: 'failed', error: `Spawn failed: ${err.message}` });
      }
    }
  } finally {
    _promoting = false;
  }
}

// ---------------------------------------------------------------------------
// Core: spawnWorker
// ---------------------------------------------------------------------------
async function spawnWorker(task) {
  const taskId = task.id;
  const repoRoot = PROJECT_DIR;
  const worktreePath = join(repoRoot, 'wf', taskId);
  const branchName = `wf/${taskId}`;

  // 0. Pre-launch cost gate — check budget before creating worktree
  try {
    const estimate = estimateTaskCost(task.prompt, task.retryCount || 0);
    const estimatedCost = estimate.totalCost;
    const now = new Date();
    const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const startOfWeek = new Date(now.getFullYear(), now.getMonth(), now.getDate() - now.getDay()).toISOString();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

    const budgetScopes = ['global'];
    if (task.project) budgetScopes.push(task.project);

    for (const scope of budgetScopes) {
      const budget = getBudget(scope);
      if (!budget) continue;

      const todaySpend = getCostForPeriod(scope, startOfToday, endOfDay);
      const weekSpend = getCostForPeriod(scope, startOfWeek, endOfDay);
      const monthSpend = getCostForPeriod(scope, startOfMonth, endOfDay);

      const violations = [];
      if (budget.dailyLimit != null && todaySpend + estimatedCost > budget.dailyLimit) {
        violations.push(`daily ${scope}: $${todaySpend.toFixed(2)} + $${estimatedCost.toFixed(2)} > $${budget.dailyLimit.toFixed(2)}`);
      }
      if (budget.weeklyLimit != null && weekSpend + estimatedCost > budget.weeklyLimit) {
        violations.push(`weekly ${scope}: $${weekSpend.toFixed(2)} + $${estimatedCost.toFixed(2)} > $${budget.weeklyLimit.toFixed(2)}`);
      }
      if (budget.monthlyLimit != null && monthSpend + estimatedCost > budget.monthlyLimit) {
        violations.push(`monthly ${scope}: $${monthSpend.toFixed(2)} + $${estimatedCost.toFixed(2)} > $${budget.monthlyLimit.toFixed(2)}`);
      }

      if (violations.length > 0) {
        const errorMsg = `Budget exceeded: ${violations.join('; ')}`;
        console.error(`[spawnWorker] Budget gate blocked task ${taskId}: ${errorMsg}`);
        updateTask(taskId, {
          status: 'failed',
          error: errorMsg,
          completedAt: new Date().toISOString(),
        });
        logEvent(taskId, 'budget_exceeded', errorMsg);
        releaseTaskClaim(taskId);
        return;
      }
    }
  } catch (err) {
    // Budget check is non-fatal — log and continue
    console.error(`[spawnWorker] Budget check error for ${taskId}:`, err.message);
  }

  // 1. Create git worktree — branch from upstream task if dependency exists
  try {
    let baseBranch = 'HEAD';
    if (task.dependsOn) {
      try {
        const deps = JSON.parse(task.dependsOn);
        if (deps.length > 0) {
          const upstreamTask = getTask(deps[0]);
          if (upstreamTask && upstreamTask.branch) {
            baseBranch = upstreamTask.branch;
          }
        }
      } catch { /* ignore parse errors — fall back to HEAD */ }
    }
    gitExec(['worktree', 'add', worktreePath, '-b', branchName, baseBranch], { cwd: repoRoot });
  } catch (err) {
    throw new Error(`git worktree add failed: ${err.stderr?.toString() || err.message}`);
  }

  // Record the base commit so zero-work guard can compare against it (not HEAD)
  let baseCommit;
  try {
    baseCommit = gitExec(['rev-parse', 'HEAD'], { cwd: worktreePath });
  } catch { /* ignore */ }

  // 2. Build effective prompt with context
  let effectivePrompt = task.prompt;

  // Add context: open tasks on same project
  try {
    const allTasks = getAllTasks();
    const projectTasks = allTasks.filter(
      (t) => t.project === task.project && t.id !== taskId && t.status === 'running',
    );
    if (projectTasks.length > 0) {
      const taskList = projectTasks.map((t) => `  - [${t.status}] ${t.prompt}`).join('\n');
      effectivePrompt += `\n\n[Context] Other active tasks on this project:\n${taskList}`;
    }
  } catch {
    // ignore context errors
  }

  // Add recent git log context
  try {
    const gitLog = gitExec(['log', '--oneline', '-5'], { cwd: repoRoot });
    if (gitLog) {
      effectivePrompt += `\n\n[Context] Recent commits:\n${gitLog}`;
    }
  } catch {
    // ignore
  }

  // Add project memory if available
  try {
    const memoryPath = join(repoRoot, '.claude', 'project-memory.md');
    if (existsSync(memoryPath)) {
      const memory = readFileSync(memoryPath, 'utf8').trim();
      if (memory) {
        effectivePrompt += `\n\n[Project Memory]\n${memory}`;
      }
    }
  } catch {
    // ignore
  }

  // Add feedback examples if available
  try {
    const feedbackPath = join(DATA_DIR, 'feedback.jsonl');
    if (existsSync(feedbackPath)) {
      const lines = readFileSync(feedbackPath, 'utf8').trim().split('\n').filter(Boolean);
      const recent = lines.slice(-5);
      const examples = recent
        .map((line) => {
          try {
            const fb = JSON.parse(line);
            return `  - [${fb.type}] ${fb.prompt}`;
          } catch {
            return null;
          }
        })
        .filter(Boolean);
      if (examples.length > 0) {
        effectivePrompt += `\n\n[Context] Recent feedback:\n${examples.join('\n')}`;
      }
    }
  } catch {
    // ignore
  }

  // Layer 5: Upstream task results — inject dependency outputs
  if (task.dependsOn) {
    try {
      const deps = JSON.parse(task.dependsOn);
      const upstreamResults = [];
      for (const depId of deps) {
        const dep = getTask(depId);
        if (dep && dep.resultSummary) {
          upstreamResults.push(`Task ${depId.slice(0, 8)} (${dep.status}): "${dep.prompt.slice(0, 80)}"\n  Result: ${dep.resultSummary}`);
        }
      }
      if (upstreamResults.length > 0) {
        effectivePrompt += `\n\n[Upstream Task Results]\n${upstreamResults.join('\n\n')}`;
      }
    } catch { /* ignore */ }
  }

  // Layer 6: Shared context for task group
  if (task.taskGroup) {
    try {
      const contextEntries = readAllSharedContext(task.taskGroup);
      if (contextEntries.length > 0) {
        const contextLines = contextEntries.map(e => `${e.key}: ${e.value}`).join('\n');
        // Cap at 2000 chars to avoid prompt bloat
        const capped = contextLines.length > 2000 ? contextLines.slice(0, 2000) + '\n...(truncated)' : contextLines;
        effectivePrompt += `\n\n[Shared Context]\n${capped}`;
      }
    } catch { /* ignore */ }
  }

  // 3. Spawn Claude CLI
  ensureDir(DATA_DIR);
  const logPath = join(DATA_DIR, `${taskId}.log`);

  const useTmux = isTmuxAvailable();
  const tmuxSession = `wf-${taskId.slice(0, 8)}`;

  if (useTmux) {
    // Build the full command string for tmux
    const cliArgs = [CLAUDE_CLI, '--print', '--dangerously-skip-permissions', '-p', JSON.stringify(effectivePrompt)];
    const fullCommand = cliArgs.map(a => typeof a === 'string' && a.includes(' ') ? `"${a.replace(/"/g, '\\"')}"` : a).join(' ');

    try {
      createSession(tmuxSession, fullCommand, worktreePath);
    } catch (err) {
      cleanupWorktree(taskId, worktreePath);
      throw new Error(`tmux session creation failed: ${err.message}`);
    }

    const pid = getSessionPid(tmuxSession) || 0;

    // Register worker
    registerWorker(taskId, pid, logPath);

    // Update task
    updateTask(taskId, {
      status: 'running',
      pid,
      startedAt: new Date().toISOString(),
      worktreePath,
      branch: branchName,
      tmuxSession,
      baseCommit,
    });

    logEvent(taskId, 'task_started', `tmux=${tmuxSession} pid=${pid}`);

    // Declare all timer variables upfront so every callback can clean up all of them
    let captureInterval, exitCheckInterval, timeoutTimer, nudgeTimer;

    // Start output capture loop — poll tmux pane every 2 seconds
    let lastCaptureLength = 0;
    captureInterval = setInterval(() => {
      try {
        if (!hasSession(tmuxSession)) {
          clearInterval(captureInterval);
          clearInterval(exitCheckInterval);
          clearTimeout(timeoutTimer);
          clearTimeout(nudgeTimer);
          const finalOutput = capturePane(tmuxSession);
          handleTmuxWorkerExit(taskId, finalOutput);
          return;
        }

        const content = capturePane(tmuxSession);
        if (content.length > lastCaptureLength) {
          const newContent = content.slice(lastCaptureLength);
          lastCaptureLength = content.length;
          appendFileAsync(logPath, newContent).catch(() => {});
        }
      } catch {
        // ignore capture errors
      }
    }, 2000);

    // Timeout watchdog
    timeoutTimer = setTimeout(() => {
      console.error(`[spawnWorker] Task ${taskId} timed out — killing tmux session`);
      logEvent(taskId, 'timeout', `Killed after ${TASK_TIMEOUT / 1000}s`);
      killSession(tmuxSession);
      clearInterval(captureInterval);
    }, TASK_TIMEOUT);

    // Stuck nudge
    nudgeTimer = setTimeout(() => {
      logEvent(taskId, 'stuck_warning', `Running for ${STUCK_NUDGE / 1000}s`);
    }, STUCK_NUDGE);

    // Check for session end every 3 seconds
    exitCheckInterval = setInterval(async () => {
      if (!hasSession(tmuxSession) || !isSessionAlive(tmuxSession)) {
        clearInterval(exitCheckInterval);
        clearInterval(captureInterval);
        clearTimeout(timeoutTimer);
        clearTimeout(nudgeTimer);

        const finalOutput = capturePane(tmuxSession);
        await handleTmuxWorkerExit(taskId, finalOutput);
      }
    }, 3000);

    // Cancellation token
    const token = createToken(taskId);
    token.onCancel(() => {
      killSession(tmuxSession);
      clearInterval(exitCheckInterval);
      clearInterval(captureInterval);
      clearTimeout(timeoutTimer);
      clearTimeout(nudgeTimer);
    });

    return; // Don't fall through to the spawn path
  }

  // --- child_process spawn path ---
  const child = spawn(CLAUDE_CLI, ['--print', '--dangerously-skip-permissions', '-p', effectivePrompt], {
    cwd: worktreePath,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  });

  // Declare timers before use so they are in scope for the error handler
  let timeoutTimer;
  let nudgeTimer;

  child.on('error', (err) => {
    console.error(`[spawnWorker] Spawn error for ${taskId}:`, err.message);
    clearTimeout(timeoutTimer);
    clearTimeout(nudgeTimer);
    updateTask(taskId, {
      status: 'failed',
      error: `Spawn error: ${err.message}`,
      completedAt: new Date().toISOString(),
    });
    logEvent(taskId, 'failed', `Spawn error: ${err.message}`);
    releaseTaskClaim(taskId);
    removeWorker(taskId);
    removeToken(taskId);
    cleanupWorktree(taskId, worktreePath);
  });

  const pid = child.pid;

  // 4. Register worker
  registerWorker(taskId, pid, logPath);

  // 5. Update task
  updateTask(taskId, {
    status: 'running',
    pid,
    startedAt: new Date().toISOString(),
    worktreePath,
    branch: branchName,
    baseCommit,
  });

  // 6. Log events
  logEvent(taskId, 'task_started', `pid=${pid}`);
  logEvent(taskId, 'claude_pid_assigned', `pid=${pid}`);

  // Collect stdout/stderr as Buffer arrays — avoids O(n^2) string concatenation
  const stdoutChunks = [];
  const stderrChunks = [];

  child.stdout.on('data', (chunk) => {
    stdoutChunks.push(chunk);
    appendFileAsync(logPath, chunk).catch(() => {});
  });

  child.stderr.on('data', (chunk) => {
    stderrChunks.push(chunk);
    appendFileAsync(logPath, chunk).catch(() => {});
  });

  // 7. Timeout watchdog (10 min)
  timeoutTimer = setTimeout(() => {
    console.error(`[spawnWorker] Task ${taskId} timed out after ${TASK_TIMEOUT / 1000}s — killing`);
    logEvent(taskId, 'timeout', `Killed after ${TASK_TIMEOUT / 1000}s`);
    try {
      child.kill('SIGTERM');
    } catch {
      // ignore
    }
  }, TASK_TIMEOUT);

  // 8. Stuck nudge (8 min)
  nudgeTimer = setTimeout(() => {
    console.error(`[spawnWorker] Task ${taskId} has been running for ${STUCK_NUDGE / 1000}s — possible stuck`);
    logEvent(taskId, 'stuck_warning', `Running for ${STUCK_NUDGE / 1000}s`);
  }, STUCK_NUDGE);

  // 9. On exit: handleWorkerExit
  child.on('close', async (code) => {
    clearTimeout(timeoutTimer);
    clearTimeout(nudgeTimer);
    const stdout = Buffer.concat(stdoutChunks).toString();
    const stderr = Buffer.concat(stderrChunks).toString();
    await handleWorkerExit(task, code, stdout, stderr);
  });

  // 10. Create cancellation token
  const token = createToken(taskId);
  token.onCancel(() => {
    try {
      child.kill('SIGTERM');
    } catch {
      // ignore
    }
  });
}

// ---------------------------------------------------------------------------
// Core: handleTmuxWorkerExit
// ---------------------------------------------------------------------------
async function handleTmuxWorkerExit(taskId, output) {
  // Idempotency guard — both capture loop and exit-check loop can trigger this
  if (HANDLED_EXITS.has(taskId)) return;
  HANDLED_EXITS.add(taskId);

  logEvent(taskId, 'claude_exited', 'tmux session ended');

  const task = getTask(taskId);
  if (!task) return;

  const worktreePath = task.worktreePath;
  const cleanOutput = (output || '').slice(-4000);

  // Check for file changes — compare against base commit, not HEAD
  const filesChanged = checkFilesChanged(worktreePath, task.baseCommit);

  if (filesChanged) {
    // Commit changes
    try {
      gitExec(['add', '-A'], { cwd: worktreePath });
      const commitMsg = `wf: ${(task.prompt || 'Task work').slice(0, 72)}`;
      gitExec(['commit', '-m', commitMsg, '--allow-empty'], { cwd: worktreePath });
    } catch { /* may already be committed */ }

    updateTask(taskId, {
      status: 'review',
      output: cleanOutput,
      exitCode: 0,
    });
    logEvent(taskId, 'verification', 'Changes detected — awaiting review');
  } else {
    updateTask(taskId, {
      status: 'failed',
      output: cleanOutput,
      error: 'No files changed — zero-work guard triggered',
      exitCode: 0,
      completedAt: new Date().toISOString(),
    });
    logEvent(taskId, 'failed', 'Zero-work guard');
    cleanupWorktree(taskId, worktreePath);
  }

  // Cost tracking
  recordTaskCost(taskId, task, output || '');

  // Auto-extract result summary from output (only on success)
  const freshTaskTmux = getTask(taskId);
  if (freshTaskTmux && (freshTaskTmux.status === 'review' || freshTaskTmux.status === 'done')) {
    extractResultSummary(taskId, cleanOutput || output || '');
  }

  releaseTaskClaim(taskId);
  removeWorker(taskId);
  HANDLED_EXITS.delete(taskId);
  removeToken(taskId);

  await promotePending();
}

// ---------------------------------------------------------------------------
// Core: handleWorkerExit
// ---------------------------------------------------------------------------
async function handleWorkerExit(task, exitCode, stdout, stderr) {
  const taskId = task.id;

  // 1. Log exit
  logEvent(taskId, 'claude_exited', `exitCode=${exitCode}`);

  // 2. Parse output
  const output = extractTaskOutput(stdout);
  const sessionId = extractSessionId(stderr);

  if (sessionId) {
    updateTask(taskId, { sessionId });
  }

  // 3. Zero-work guard: did any files change?
  const freshTask = getTask(taskId);
  const worktreePath = freshTask?.worktreePath;
  const filesChanged = checkFilesChanged(worktreePath, freshTask?.baseCommit);

  // 4 & 5. Decide outcome
  if (exitCode === 0 && filesChanged) {
    try {
      gitExec(['add', '-A'], { cwd: worktreePath });
      const commitMsg = `wf: ${(task.prompt || 'Task work').slice(0, 72)}`;
      gitExec(['commit', '-m', commitMsg, '--allow-empty'], { cwd: worktreePath });
    } catch { /* may already be committed */ }

    if (freshTask.autoMerge) {
      updateTask(taskId, { output, exitCode });
      await mergeWorktree(freshTask);
    } else {
      updateTask(taskId, {
        status: 'review',
        output,
        exitCode: 0,
      });
      logEvent(taskId, 'verification', 'Changes detected — awaiting review');
    }
  } else {
    const errorMsg = exitCode !== 0
      ? `Claude exited with code ${exitCode}. ${stderr || ''}`.trim()
      : 'No files changed — zero-work guard triggered';
    updateTask(taskId, {
      status: 'failed',
      output,
      error: errorMsg,
      exitCode,
      completedAt: new Date().toISOString(),
    });
    logEvent(taskId, 'failed', errorMsg);

    cleanupWorktree(taskId, worktreePath);
  }

  // 6. Record actual cost if available
  recordTaskCost(taskId, task, stdout || '');

  // Auto-extract result summary from output (only on success)
  const freshTaskAfterExit = getTask(taskId);
  if (freshTaskAfterExit && (freshTaskAfterExit.status === 'review' || freshTaskAfterExit.status === 'done')) {
    extractResultSummary(taskId, output || stdout || '');
  }

  // 7. Release claim, remove worker
  releaseTaskClaim(taskId);
  removeWorker(taskId);

  // 8. Cleanup token
  removeToken(taskId);

  // Try to promote next pending task
  await promotePending();
}

// ---------------------------------------------------------------------------
// Core: mergeWorktree
// ---------------------------------------------------------------------------
async function mergeWorktree(task) {
  const taskId = task.id;
  const repoRoot = PROJECT_DIR;
  const branchName = `wf/${taskId}`;
  const worktreePath = task.worktreePath || join(repoRoot, 'wf', taskId);

  // 1. Acquire per-repo merge lock
  const lockKey = repoRoot;
  while (MERGE_LOCKS.has(lockKey)) {
    await MERGE_LOCKS.get(lockKey);
  }

  let releaseLock;
  const lockPromise = new Promise((r) => {
    releaseLock = r;
  });
  MERGE_LOCKS.set(lockKey, lockPromise);

  try {
    // 2. Merge
    logEvent(taskId, 'merge_started');
    // Use recorded target branch, falling back to current branch
    const targetBranch = task.targetBranch || gitExec(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoRoot });
    // Safeguard: refuse to merge into main/master to prevent accidental commits
    if (targetBranch === 'main' || targetBranch === 'master') {
      throw new Error(`Refusing to merge into protected branch "${targetBranch}". Checkout a feature branch first.`);
    }
    // Ensure we're on the target branch
    const currentBranch = gitExec(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoRoot });
    if (currentBranch !== targetBranch) {
      gitExec(['checkout', targetBranch], { cwd: repoRoot });
    }
    gitExec(['merge', '--no-ff', branchName], { cwd: repoRoot });

    // 4. Update task
    updateTask(taskId, {
      merged: 1,
      status: 'done',
      completedAt: new Date().toISOString(),
    });

    // 5. Log merge
    logEvent(taskId, 'merge_completed');
  } catch (mergeErr) {
    // 3. Check if conflict is only status.md
    const errMsg = mergeErr.stderr?.toString() || mergeErr.message || '';

    let resolved = false;
    try {
      const conflicts = gitExec(['diff', '--name-only', '--diff-filter=U'], { cwd: repoRoot });

      if (conflicts === 'status.md') {
        gitExec(['checkout', '--theirs', 'status.md'], { cwd: repoRoot });
        gitExec(['add', 'status.md'], { cwd: repoRoot });
        gitExec(['commit', '--no-edit'], { cwd: repoRoot });
        resolved = true;

        updateTask(taskId, {
          merged: 1,
          status: 'done',
          completedAt: new Date().toISOString(),
        });
        logEvent(taskId, 'merge_completed', 'auto-resolved status.md conflict');
      }
    } catch {
      // conflict resolution failed
    }

    if (!resolved) {
      try {
        gitExec(['merge', '--abort'], { cwd: repoRoot });
      } catch {
        // ignore
      }

      updateTask(taskId, {
        mergeFailed: 1,
        status: 'failed',
        error: `Merge failed: ${errMsg}`,
        completedAt: new Date().toISOString(),
      });
      logEvent(taskId, 'merge_failed', errMsg);
    }
  } finally {
    // 6. Release merge lock
    MERGE_LOCKS.delete(lockKey);
    releaseLock();
  }

  // 7. Schedule auto-archive
  scheduleAutoArchive(taskId);

  // 8. Cleanup worktree with retries
  cleanupWorktree(taskId, worktreePath);
}

// ---------------------------------------------------------------------------
// Worktree cleanup with retries
// ---------------------------------------------------------------------------
function cleanupWorktree(taskId, worktreePath) {
  if (!worktreePath) return;

  const repoRoot = PROJECT_DIR;
  const branchName = `wf/${taskId}`;

  let attempts = 0;
  const maxAttempts = 3;

  function attempt() {
    attempts++;
    try {
      gitExec(['worktree', 'remove', worktreePath, '--force'], { cwd: repoRoot });
    } catch {
      if (attempts < maxAttempts) {
        setTimeout(attempt, 600 * attempts);
        return;
      }
      console.error(`[cleanupWorktree] Failed to remove worktree for ${taskId} after ${maxAttempts} attempts`);
    }

    // Try to delete the branch too
    try {
      gitExec(['branch', '-D', branchName], { cwd: repoRoot });
    } catch {
      // ignore — branch may not exist or may be the current branch
    }
  }

  attempt();
}

// ---------------------------------------------------------------------------
// Core: scheduleAutoArchive
// ---------------------------------------------------------------------------
function scheduleAutoArchive(taskId) {
  setTimeout(() => {
    try {
      const task = getTask(taskId);
      if (task && task.status === 'done' && !task.pinned && !task.needsInput) {
        updateTask(taskId, {
          status: 'archived',
          archivedAt: new Date().toISOString(),
        });
        logEvent(taskId, 'archived', 'auto-archived after delay');
      }
    } catch (err) {
      console.error(`[autoArchive] Error archiving ${taskId}:`, err.message);
    }
  }, AUTO_ARCHIVE_DELAY);
}

// ---------------------------------------------------------------------------
// Init / Stop
// ---------------------------------------------------------------------------
function initWorkerManager(projectDir) {
  PROJECT_DIR = projectDir;
  console.error(`[worker-manager] Initialized with project dir: ${PROJECT_DIR}`);
  console.error(`[worker-manager] Claude CLI: ${CLAUDE_CLI}`);
  console.error(`[worker-manager] Tasks dir: ${DATA_DIR}`);
  console.error(`[worker-manager] Max concurrent: ${MAX_CONCURRENT}`);

  // Start promote loop every 5 seconds
  _promoteInterval = setInterval(() => {
    promotePending().catch((err) => {
      console.error('[worker-manager] promotePending error:', err.message);
    });
  }, 5000);
}

function stopWorkerManager() {
  if (_promoteInterval) {
    clearInterval(_promoteInterval);
    _promoteInterval = null;
  }
  console.error('[worker-manager] Stopped');
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
export {
  promotePending,
  spawnWorker,
  handleTmuxWorkerExit,
  handleWorkerExit,
  mergeWorktree,
  cleanupWorktree,
  scheduleAutoArchive,
  initWorkerManager,
  stopWorkerManager,
};
