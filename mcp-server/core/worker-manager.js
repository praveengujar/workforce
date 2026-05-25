/**
 * Worker Manager — core task lifecycle for the MCP server.
 *
 * Ported from server/index.js (lines 248-860). Manages spawning Claude CLI
 * workers in git worktrees, handling exit/merge/cleanup, and promoting
 * pending tasks to fill available capacity.
 *
 * No Express, no WebSocket — pure lifecycle logic.
 */

import { spawn, execFileSync } from 'node:child_process';
import {
  readFileSync,
  existsSync,
  statSync,
  openSync,
  readSync,
  closeSync,
  unlinkSync,
  symlinkSync,
  lstatSync,
} from 'node:fs';
import { appendFile as appendFileAsync } from 'node:fs/promises';
import { join } from 'node:path';
import { DATA_DIR, ensureDir, gitExec, CLAUDE_CLI, isSubscriptionMode, getDateBoundaries } from './constants.js';

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
  getTaskCountForPeriod,
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
import { getRulesForPaths, getRulesForKeywords, extractPathsFromText } from './knowledge-rules.js';
import { getAllSessionContext } from './session-context.js';
import { recallEpisodes, isEpisodicEnabled } from './episodic-memory.js';
import {
  getAutonomyConfig,
  getMode as getAutonomyMode,
  currentRun as currentAutonomyRun,
  shouldHalt as autonomyShouldHalt,
  maxConcurrencyOverride as autonomyMaxConcurrency,
} from './autonomy-controller.js';
import { matchesGlob } from './autonomy-policy.js';
import { topUpBacklog } from './autonomy-spawner.js';
import { notify } from './notifier.js';
import { assembleContext } from './context-assembler.js';
import { applyContextFabric } from './context-fabric-mode.js';
import { scaffoldScratchpad, readScratchpadFindings } from './scratchpad.js';
import { loadTraceForChild, formatTraceForPrompt } from './task-trace.js';
import { getDb } from './db.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const MAX_CONCURRENT = parseInt(process.env.WORKFORCE_MAX_CONCURRENT || process.env.MAX_CONCURRENT || '5', 10);
const LAUNCH_STAGGER_MS = parseInt(process.env.WORKFORCE_LAUNCH_STAGGER || '5000', 10);
const TASK_TIMEOUT = parseInt(process.env.WORKFORCE_TASK_TIMEOUT || String(30 * 60 * 1000), 10);
const STUCK_NUDGE = 8 * 60 * 1000;   // 480 000 ms
const AUTO_ARCHIVE_DELAY = 5 * 60 * 1000; // 300 000 ms
const MERGE_LOCKS = new Map(); // per-repo merge serialization
const HANDLED_EXITS = new Set(); // idempotency guard for tmux exit handling

let PROJECT_DIR = null;
let _promoteInterval = null;
let _promoting = false;
let _promoting_logged_halt = null;
let _createTaskHandlerCached = null;

// Lazy resolver to dodge the circular import: task-tools.js imports
// `promotePending` from this file, and we need `createTaskHandler` from there
// to enqueue backlog work.
async function getCreateTaskHandler() {
  if (_createTaskHandlerCached) return _createTaskHandlerCached;
  const mod = await import('../tools/task-tools.js');
  _createTaskHandlerCached = mod.createTaskHandler;
  return _createTaskHandlerCached;
}

async function topUpAutonomyBacklog() {
  if (!PROJECT_DIR) return;
  const createTask = await getCreateTaskHandler();
  await topUpBacklog({ repoRoot: PROJECT_DIR, createTask });
}

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
/**
 * Detect a test command from project config.
 * Returns { cmd, args } or null if no test command found.
 */
function detectTestCommand(repoRoot) {
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

// ---------------------------------------------------------------------------
// Worktree environment setup — ensure deps are available for test/build tasks
// ---------------------------------------------------------------------------

/**
 * Detect project type and set up worktree environment.
 * Symlinks node_modules from main workspace (fast, avoids full npm install).
 * For monorepos (Turborepo/pnpm/yarn workspaces), symlinks the root node_modules
 * and any workspace package node_modules.
 */
function setupWorktreeEnvironment(worktreePath, repoRoot) {
  try {
    // Symlink root node_modules if it exists
    const rootNodeModules = join(repoRoot, 'node_modules');
    const worktreeNodeModules = join(worktreePath, 'node_modules');
    if (existsSync(rootNodeModules) && !existsSync(worktreeNodeModules)) {
      try {
        symlinkSync(rootNodeModules, worktreeNodeModules, 'junction');
        logEvent('_system', 'worktree_setup', `Symlinked node_modules → ${worktreePath}`);
      } catch { /* may fail on some platforms — non-fatal */ }
    }

    // Detect monorepo and symlink workspace package node_modules
    const pkgPath = join(repoRoot, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
        const workspaces = pkg.workspaces || (pkg.workspaces?.packages);
        if (Array.isArray(workspaces)) {
          // Symlink each workspace's node_modules
          for (const wsGlob of workspaces) {
            const wsBase = wsGlob.replace('/*', '').replace('/**', '');
            const srcDir = join(repoRoot, wsBase);
            const dstDir = join(worktreePath, wsBase);
            if (!existsSync(srcDir)) continue;
            // Find actual workspace dirs (apps/web, packages/shared, etc.)
            try {
              const entries = execFileSync('ls', ['-1', srcDir], { encoding: 'utf8', timeout: 5000 })
                .trim().split('\n').filter(Boolean);
              for (const entry of entries) {
                const srcNM = join(srcDir, entry, 'node_modules');
                const dstNM = join(dstDir, entry, 'node_modules');
                if (existsSync(srcNM) && !existsSync(dstNM)) {
                  try { symlinkSync(srcNM, dstNM, 'junction'); } catch { /* non-fatal */ }
                }
              }
            } catch { /* ignore ls errors */ }
          }
        }
      } catch { /* ignore package.json parse errors */ }
    }

    // Symlink .env files (test tasks need env vars)
    for (const envFile of ['.env', '.env.local', '.env.development']) {
      const srcEnv = join(repoRoot, envFile);
      const dstEnv = join(worktreePath, envFile);
      if (existsSync(srcEnv) && !existsSync(dstEnv)) {
        try { symlinkSync(srcEnv, dstEnv, 'file'); } catch { /* non-fatal */ }
      }
    }
  } catch (err) {
    // Worktree setup is best-effort — don't fail the task
    console.error(`[worktree-setup] Warning: ${err.message}`);
  }
}

function checkFilesChanged(worktreePath, baseCommit) {
  if (!worktreePath) return false;

  // Check 1: committed changes vs base (staged diffs + new commits)
  try {
    const compareRef = baseCommit || 'HEAD';
    const diff = gitExec(['diff', '--stat', compareRef], { cwd: worktreePath });
    if (diff.length > 0) return true;
    const logCount = gitExec(['rev-list', '--count', `${compareRef}..HEAD`], { cwd: worktreePath });
    if (parseInt(logCount, 10) > 0) return true;
  } catch { /* fall through to status check */ }

  // Check 2: ALWAYS check for untracked/unstaged files (the critical fix).
  // Agents often write files but don't git-add them. Without this check,
  // the zero-work guard destroys their work.
  try {
    const status = gitExec(['status', '--porcelain'], { cwd: worktreePath });
    // Filter out symlinked node_modules and .env files (from worktree setup)
    const realChanges = status.split('\n').filter(line => {
      const trimmed = line.trim();
      if (!trimmed) return false;
      if (trimmed.endsWith('node_modules')) return false;
      if (trimmed.endsWith('.env') || trimmed.endsWith('.env.local') || trimmed.endsWith('.env.development')) return false;
      return true;
    });
    if (realChanges.length > 0) return true;
  } catch { /* ignore */ }

  return false;
}

/**
 * Record actual cost from Claude CLI output. Shared by both exit handlers.
 */
function recordTaskCost(taskId, task, outputText) {
  try {
    const detailed = parseDetailedCost(outputText || '');

    if (isSubscriptionMode()) {
      // Subscription: record tokens + duration, no dollar cost
      const durationMs = task.startedAt ? Date.now() - new Date(task.startedAt).getTime() : null;
      const tier = classifyTier(task.prompt || '');
      recordCost(taskId, task.project, 0, tier, {
        inputTokens: detailed.inputTokens,
        outputTokens: detailed.outputTokens,
        durationMs,
      });
      appendCostLog({
        taskId, project: task.project || null, cost: 0, tier,
        inputTokens: detailed.inputTokens, outputTokens: detailed.outputTokens,
        durationMs,
      });
    } else {
      // API mode: existing logic
      const actualCost = detailed.cost;
      if (actualCost && actualCost > 0) {
        recordActualCost(task.prompt, actualCost);
        updateTask(taskId, { cost: actualCost });
        const tier = classifyTier(task.prompt || '');
        recordCost(taskId, task.project, actualCost, tier, {
          inputTokens: detailed.inputTokens,
          outputTokens: detailed.outputTokens,
        });
        appendCostLog({
          taskId, project: task.project || null, cost: actualCost, tier,
          inputTokens: detailed.inputTokens, outputTokens: detailed.outputTokens,
        });
      }
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
    // 0. Autonomy halt check — refuses new spawns when autonomy is halted
    // (env kill switch, budget breach, lease expired, consecutive-failure
    // threshold). Only applies to live modes (auto/park). Shadow is never
    // halted; off mode bypasses the check entirely.
    try {
      const haltReason = autonomyShouldHalt(PROJECT_DIR);
      if (haltReason) {
        if (!_promoting_logged_halt || _promoting_logged_halt !== haltReason) {
          console.error(`[promotePending] Autonomy halted: ${haltReason} — refusing spawns`);
          _promoting_logged_halt = haltReason;
          try {
            notify({
              subject: `Autonomy halted: ${haltReason}`,
              body: 'Workforce will not spawn new tasks until autonomy is resumed.',
              severity: 'critical',
            });
          } catch { /* ignore */ }
        }
        return;
      }
      _promoting_logged_halt = null;
    } catch (err) {
      console.error('[promotePending] halt check error:', err.message);
    }

    // 0b. Autonomy backlog top-up — under park/auto, pull highest-priority
    // backlog items into pending tasks so the run keeps making progress
    // overnight without a human enqueueing each one.
    try {
      await topUpAutonomyBacklog();
    } catch (err) {
      console.error('[promotePending] backlog top-up error:', err.message);
    }

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

    // 2. Check available capacity. Autonomy may override the concurrency cap
    // downward (default 3 under `auto`) to bound overnight blast radius.
    const running = getRunningTasks();
    const concurrencyCap = autonomyMaxConcurrency(PROJECT_DIR) || MAX_CONCURRENT;
    let slots = concurrencyCap - running.length;
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

    let launched = 0;
    for (const task of ready) {
      if (slots <= 0) break;
      const claimed = claimTask(task.id, 'server');
      if (!claimed) continue;

      // Stagger launches to avoid resource exhaustion
      if (launched > 0 && LAUNCH_STAGGER_MS > 0) {
        await new Promise(r => setTimeout(r, LAUNCH_STAGGER_MS));
      }

      try {
        await spawnWorker(task);
        slots--;
        launched++;
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
    if (isSubscriptionMode()) {
      // Subscription mode: budget limits are task counts, not dollars
      const budgetScopes = ['global'];
      if (task.project) budgetScopes.push(task.project);
      for (const scope of budgetScopes) {
        const budget = getBudget(scope);
        if (!budget) continue;
        const { startOfToday, startOfWeek, startOfMonth, endOfDay } = getDateBoundaries();
        const violations = [];
        if (budget.dailyLimit != null) {
          const count = getTaskCountForPeriod(scope, startOfToday, endOfDay);
          if (count + 1 > budget.dailyLimit) violations.push(`daily tasks ${scope}: ${count}+1 > ${budget.dailyLimit}`);
        }
        if (budget.weeklyLimit != null) {
          const count = getTaskCountForPeriod(scope, startOfWeek, endOfDay);
          if (count + 1 > budget.weeklyLimit) violations.push(`weekly tasks ${scope}: ${count}+1 > ${budget.weeklyLimit}`);
        }
        if (budget.monthlyLimit != null) {
          const count = getTaskCountForPeriod(scope, startOfMonth, endOfDay);
          if (count + 1 > budget.monthlyLimit) violations.push(`monthly tasks ${scope}: ${count}+1 > ${budget.monthlyLimit}`);
        }
        if (violations.length > 0) {
          const errorMsg = `Task limit exceeded: ${violations.join('; ')}`;
          console.error(`[spawnWorker] Task limit blocked task ${taskId}: ${errorMsg}`);
          updateTask(taskId, { status: 'failed', error: errorMsg, completedAt: new Date().toISOString() });
          logEvent(taskId, 'budget_exceeded', errorMsg);
          releaseTaskClaim(taskId);
          return;
        }
      }
    } else {
      // API mode: existing dollar-based budget gate
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
        for (const depId of deps) {
          const upstreamTask = getTask(depId);
          // Skip analysis tasks — they produce no branch (worktree is cleaned up)
          if (upstreamTask && upstreamTask.branch && upstreamTask.taskType !== 'analysis') {
            baseBranch = upstreamTask.branch;
            break;
          }
        }
      } catch { /* ignore parse errors — fall back to HEAD */ }
    }
    gitExec(['worktree', 'add', worktreePath, '-b', branchName, baseBranch], { cwd: repoRoot });
  } catch (err) {
    throw new Error(`git worktree add failed: ${err.stderr?.toString() || err.message}`);
  }

  // 1b. Set up worktree environment (symlink node_modules, .env files)
  setupWorktreeEnvironment(worktreePath, repoRoot);

  // 1c. Context Fabric M8 — scaffold .workforce/scratch/ scratchpad files
  // (PRD §9.9, Manus pattern). Best-effort — scaffold failure must never
  // break a task spawn.
  try {
    scaffoldScratchpad(worktreePath);
  } catch (err) {
    console.error(`[worker-manager] scratchpad scaffold failed for ${taskId}: ${err.message}`);
  }

  // Record the base commit so zero-work guard can compare against it (not HEAD)
  let baseCommit;
  try {
    baseCommit = gitExec(['rev-parse', 'HEAD'], { cwd: worktreePath });
  } catch { /* ignore */ }

  // 2. Build effective prompt with context
  const isAnalysis = task.taskType === 'analysis';
  let effectivePrompt = task.prompt;

  // For analysis tasks, prepend investigation instructions
  if (isAnalysis) {
    effectivePrompt = `[ANALYSIS TASK — investigation only, no code changes expected]

Your job is to investigate and produce a structured findings report. Do NOT modify any files.
Explore the codebase, trace execution paths, and identify all issues related to the task below.

Phase 1 — SURVEY: Map all relevant files, functions, and data flows. Search 3+ naming patterns before concluding something doesn't exist.
Phase 2 — DIAGNOSE: For each finding, distinguish root cause from symptom. Trace the issue to its origin.
Phase 3 — PRIORITIZE: Rank findings by (impact × confidence). Only HIGH-confidence findings go into the fix specification.
Phase 4 — SPECIFY: For each high-priority finding, write the exact change spec: file, function, what to change, what to verify.

Structure your output as:
FINDINGS (ranked by confidence):
1. [HIGH CONFIDENCE] [Issue title] — [file:line] — [description + root cause + specific fix]
2. [MEDIUM CONFIDENCE] [Issue title] — [file:line] — [description + what needs further investigation]

End with:
Summary: [one-line summary of all findings]

---

${effectivePrompt}`;
  }

  // Layer 0: Sequential Thinking Protocol + Retry Reasoning
  {
    const taskType = task.taskType || 'standard';
    let thinkingBlock = '';

    // Retry reasoning — prevent Ralph Wiggum loops at the prompt level
    const retryCount = task.retryCount ?? 0;
    if (retryCount > 0 && task.error) {
      thinkingBlock += `[RETRY — Attempt ${retryCount + 1}]
Previous attempt failed: ${task.error.slice(0, 300)}

Before repeating the same approach:
1. What specifically went wrong last time?
2. What will you do DIFFERENTLY this time?
3. If the same error occurs again, what does that prove?

Do NOT repeat the exact same approach that failed.

`;
    }

    // Task-type-aware thinking framework
    if (isAnalysis) {
      thinkingBlock += `[THINKING PROTOCOL — Investigation]
Before producing findings, follow this reasoning sequence:
OBSERVE: What files, logs, and state are relevant? Search 3+ naming patterns before concluding something doesn't exist.
HYPOTHESIZE: Generate at least 2 possible explanations for the issue.
INVESTIGATE: For each hypothesis, find supporting AND contradicting evidence in the code.
SYNTHESIZE: Rank findings by confidence (HIGH/MEDIUM/LOW). Only high-confidence findings become recommendations.
`;
    } else if (taskType === 'experiment' || taskType === 'measurement') {
      thinkingBlock += `[THINKING PROTOCOL — Experiment]
For each iteration, follow this reasoning sequence:
BASELINE: What is the current metric value? Record it before changing anything.
HYPOTHESIZE: "I believe {change} will improve {metric} because {mechanism}." If you cannot complete this sentence, stop and think harder.
CHANGE: Make exactly ONE focused change. Never bundle unrelated changes.
MEASURE: Run the measurement. Compare to baseline.
DECIDE: Keep if improved, revert if not. State what you learned and what to try next.
`;
    } else {
      thinkingBlock += `[THINKING PROTOCOL]
Before writing any code, complete these reasoning steps:
UNDERSTAND: Restate the task in your own words. What exactly must change and why?
LOCATE: Find all relevant files. Search 3+ naming patterns (camelCase, snake_case, kebab-case) before concluding something doesn't exist.
ANALYZE: What are the dependencies and call chains? What could break? What existing patterns should you follow?
PLAN: List the specific changes you will make, in order. State what you will NOT change.
EXECUTE: Make the changes.
VERIFY: Re-read every file you modified. Do the changes satisfy the requirements? Did you introduce any regressions?
`;
    }

    effectivePrompt = thinkingBlock + '\n' + effectivePrompt;
  }

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
      effectivePrompt += `\n\n[Context — Trust: HIGH] Recent commits:\n${gitLog}`;
    }
  } catch {
    // ignore
  }

  // Add project memory if available
  try {
    const memoryPath = join(repoRoot, '.claude', 'project-memory.md');
    if (existsSync(memoryPath)) {
      let memory = readFileSync(memoryPath, 'utf8').trim();
      if (memory) {
        if (memory.length > 2000) memory = '...(truncated)\n' + memory.slice(-2000);
        effectivePrompt += `\n\n[Project Memory — Trust: LOW]\n${memory}`;
      }
    }
  } catch {
    // ignore
  }

  // Add feedback examples if available
  try {
    const feedbackPath = join(DATA_DIR, 'feedback.jsonl');
    if (existsSync(feedbackPath)) {
      const stat = statSync(feedbackPath);
      let rawText;
      if (stat.size > 102400) {
        // Large file: read only the last 10KB to avoid blocking on huge files
        const fd = openSync(feedbackPath, 'r');
        const buf = Buffer.alloc(10240);
        readSync(fd, buf, 0, 10240, stat.size - 10240);
        closeSync(fd);
        rawText = buf.toString('utf8');
      } else {
        rawText = readFileSync(feedbackPath, 'utf8');
      }
      const lines = rawText.trim().split('\n').filter(Boolean);
      const recent = lines.slice(-5);
      const examples = recent
        .map((line) => {
          try {
            const fb = JSON.parse(line);
            const base = `  - [${fb.type}] ${fb.prompt}`;
            return fb.correction ? `${base} -> Fix: ${fb.correction}` : base;
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

  // Layer 5b: Past similar successes — episodic memory recall (PRD §9.3 / M1).
  // Wrapped in try/catch — recall failure NEVER breaks spawn.
  if (isEpisodicEnabled() && task.project) {
    try {
      const plannedFiles = extractPathsFromText(task.prompt || '');
      const episodes = recallEpisodes({
        project: task.project,
        prompt: task.prompt || '',
        plannedFiles,
        maxN: 3,
      });
      if (episodes.length > 0) {
        const EPISODIC_BUDGET = 1500;
        const lines = [];
        for (const ep of episodes) {
          const dateOnly = (ep.created_at || '').slice(0, 10);
          const sigShort = (ep.glob_signature || '').slice(0, 120);
          const promptShort = (ep.prompt_summary || '').replace(/\s+/g, ' ').slice(0, 220);
          const approachShort = (ep.approach_summary || '').replace(/\s+/g, ' ').slice(0, 320);
          const reviewPart = ep.review_score != null ? ` Review score: ${ep.review_score}.` : '';
          lines.push(
            `Task ${String(ep.task_id).slice(0, 8)} (${dateOnly}, glob=${sigShort})\n`
            + `  Asked: ${promptShort}\n`
            + `  Approach that worked: ${approachShort}.${reviewPart}`,
          );
        }
        let block = lines.join('\n\n');
        if (block.length > EPISODIC_BUDGET) {
          block = block.slice(0, EPISODIC_BUDGET) + '\n…(truncated)';
        }
        effectivePrompt += `\n\n[Past Similar Successes — Trust: HIGH (episodic from merged tasks)]\n${block}`;
      }
    } catch (err) {
      console.error(`[worker-manager] episodic recall failed: ${err.message}`);
    }
  }

  // Layer 5: Upstream task results — inject dependency outputs
  // For tasks downstream of an analysis task, inject the full analysis output
  // so the fix agent has the complete findings report, not just a summary.
  if (task.dependsOn) {
    try {
      const deps = JSON.parse(task.dependsOn);
      const upstreamResults = [];
      for (const depId of deps) {
        const dep = getTask(depId);
        if (!dep) continue;
        if (dep.taskType === 'analysis' && dep.output) {
          // Full analysis output — this is the primary value of two-phase tasks
          const capped = dep.output.length > 3000 ? dep.output.slice(-3000) : dep.output;
          upstreamResults.push(`[Analysis from ${depId.slice(0, 8)}]\n${capped}`);
        } else if (dep.resultSummary) {
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

  // Layer 7: Applicable knowledge rules (path-scoped + keyword-matched)
  try {
    const mentionedPaths = extractPathsFromText(task.prompt);
    // Path-based matching (explicit file references in prompt)
    let rules = mentionedPaths.length > 0 ? getRulesForPaths(mentionedPaths) : [];
    // Keyword-based matching (high-level prompts without file paths)
    if (rules.length === 0) {
      rules = getRulesForKeywords(task.prompt);
    }
    if (rules.length > 0) {
      // Deduplicate by rule ID
      const seen = new Set();
      const unique = rules.filter(r => { if (seen.has(r.id)) return false; seen.add(r.id); return true; });
      let rulesBlock = '';
      for (const rule of unique) {
        const entry = `[${rule.category}] ${rule.name} (priority ${rule.priority})\n${rule.content}\n`;
        if (rulesBlock.length + entry.length > 3000) break; // cap injection size
        rulesBlock += entry + '\n';
      }
      if (rulesBlock) {
        effectivePrompt += `\n\n[Knowledge Rules — Trust: MEDIUM]\n${rulesBlock.trim()}`;
      }
    }
  } catch {
    // ignore knowledge rules errors
  }

  // Layer 8: Session context (cross-session continuity)
  if (task.project) {
    try {
      const SESSION_CTX_BUDGET = 1500;
      let ctxBlock = '';

      // Single query — extract active_focus from results (avoids double DB round-trip)
      const contextEntries = getAllSessionContext(task.project);
      const focusEntry = contextEntries.find(e => e.key === 'active_focus');
      if (focusEntry) {
        ctxBlock += `ACTIVE FOCUS: ${focusEntry.value}\n`;
      }

      // Fill remaining budget with other entries (recency-ordered, whole entries only)
      for (const e of contextEntries) {
        if (e.key === 'active_focus') continue;
        const line = `${e.key}: ${e.value}\n`;
        if (ctxBlock.length + line.length > SESSION_CTX_BUDGET) break; // evict whole entry, don't slice
        ctxBlock += line;
      }

      if (ctxBlock) {
        effectivePrompt += `\n\n[Session Context — Trust: LOW]\n${ctxBlock.trim()}`;
      }
    } catch {
      // ignore session context errors
    }
  }

  // Completion Protocol — self-review checklist before finishing
  if (!isAnalysis) {
    effectivePrompt += `\n\n[COMPLETION CHECKLIST]
Before finishing, verify your work:
- Re-read every file you modified. Does each change directly serve the stated goal?
- Check: did you introduce any hardcoded values, credentials, or TODO comments?
- Check: do your changes work with the existing patterns (imports, naming, error handling)?
- If a test command is available, run it.
- Write a one-sentence summary of what you changed and why (this becomes the result summary).`;
  }

  // Context Fabric M8 — PRIOR ATTEMPT FINDINGS (retry survival, PRD §9.9).
  // On retry, prepend the surviving scratchpad findings.md so the new attempt
  // can read what the prior attempt learned. Best-effort, never breaks spawn.
  if ((task.retryCount ?? 0) > 0) {
    try {
      const priorFindings = readScratchpadFindings(worktreePath, 4000);
      if (priorFindings) {
        effectivePrompt = `[PRIOR ATTEMPT FINDINGS — Trust: MEDIUM (from previous retry of this task)]\n${priorFindings}\n\n${effectivePrompt}`;
      }
    } catch (err) {
      console.error(`[worker-manager] prior-findings prepend failed for ${taskId}: ${err.message}`);
    }
  }

  // Context Fabric M8 — PARENT TASK TRACE (sub-agent handoff, PRD §9.11).
  // When a task has a parent, prepend the parent's gzipped trace so the child
  // does not lose parent intent (Cognition failure mode). Best-effort.
  if (task.parentId) {
    try {
      const trace = loadTraceForChild(getDb(), task.parentId);
      if (trace) {
        const block = formatTraceForPrompt(trace, 6000);
        if (block) {
          effectivePrompt = `[PARENT TASK TRACE — Trust: HIGH (handoff from parent task ${String(task.parentId).slice(0, 8)})]\n${block}\n\n${effectivePrompt}`;
        }
      }
    } catch (err) {
      console.error(`[worker-manager] parent-trace prepend failed for ${taskId}: ${err.message}`);
    }
  }

  // Context Fabric (M6): in shadow mode, run the assembler purely for its
  // audit + per-layer telemetry side-effects (prompt unchanged). In analysis
  // mode, prepend its prompt block to analysis tasks only. In 'all' mode,
  // prepend for every task. The hardcoded 10-layer block above STAYS as the
  // safety net — assembler failure must never break a spawn.
  try {
    const fabric = applyContextFabric({
      task,
      hardcodedPrompt: effectivePrompt,
      repoRoot,
      assembler: assembleContext,
    });
    effectivePrompt = fabric.prompt;
    if (fabric.fabricInjected) {
      logEvent(taskId, 'context_fabric_injected', `mode=${fabric.fabricMode}`);
    }
  } catch (err) {
    // Defense-in-depth: applyContextFabric already isolates assembler errors,
    // but if it itself throws (shouldn't happen), keep the spawn alive.
    console.error(`[worker-manager] context fabric integration error: ${err.message}`);
  }

  // 3. Spawn Claude CLI
  ensureDir(DATA_DIR);
  const logPath = join(DATA_DIR, `${taskId}.log`);

  const useTmux = isTmuxAvailable();
  const tmuxSession = `wf-${taskId.slice(0, 8)}`;

  if (useTmux) {
    // Write prompt to a temp file to avoid shell escaping issues in tmux
    const { writeFileSync: writeFileSync_ } = await import('node:fs');
    const promptFile = join(DATA_DIR, `${taskId}.prompt`);
    ensureDir(DATA_DIR);
    writeFileSync_(promptFile, effectivePrompt, 'utf8');
    // Use cat to pipe the prompt file — avoids all shell metacharacter issues
    const fullCommand = `cat ${JSON.stringify(promptFile)} | ${CLAUDE_CLI} --print --dangerously-skip-permissions`;

    try {
      // Tag the spawned agent's environment so MCP tool calls (knowledge_rules,
      // session_context) can detect agent provenance and clamp trust at 0.4.
      // Pattern matches the FORWARD_ENV_PREFIXES export block in core/tmux.js.
      createSession(tmuxSession, fullCommand, worktreePath, {
        WORKFORCE_AGENT_TASK_ID: taskId,
      });
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
  // Write prompt to temp file for the non-tmux path too (avoids arg length limits)
  const { writeFileSync: writeFileSync_ } = await import('node:fs');
  const promptFile = join(DATA_DIR, `${taskId}.prompt`);
  ensureDir(DATA_DIR);
  writeFileSync_(promptFile, effectivePrompt, 'utf8');

  const child = spawn('sh', ['-c', `cat ${JSON.stringify(promptFile)} | ${CLAUDE_CLI} --print --dangerously-skip-permissions`], {
    cwd: worktreePath,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, WORKFORCE_AGENT_TASK_ID: taskId },
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
  if (!task) {
    HANDLED_EXITS.delete(taskId);
    return;
  }

  const worktreePath = task.worktreePath;
  const cleanOutput = (output || '').slice(-4000);

  // Check for file changes — compare against base commit, not HEAD
  const filesChanged = checkFilesChanged(worktreePath, task.baseCommit);
  const isAnalysisTask = task.taskType === 'analysis';

  if (isAnalysisTask) {
    // Analysis tasks succeed without file changes — their output IS the deliverable
    updateTask(taskId, {
      status: 'done',
      output: cleanOutput,
      exitCode: 0,
      completedAt: new Date().toISOString(),
    });
    logEvent(taskId, 'completed', 'Analysis task completed');
    extractResultSummary(taskId, cleanOutput || output || '');
    cleanupWorktree(taskId, worktreePath);
  } else if (filesChanged) {
    // Commit changes — stage all real files (excluding setup symlinks)
    try {
      // Remove symlinks from git tracking before staging
      for (const f of ['.env', '.env.local', '.env.development']) {
        try { gitExec(['rm', '--cached', '--ignore-unmatch', f], { cwd: worktreePath }); } catch { /* ignore */ }
      }
      gitExec(['add', '-A'], { cwd: worktreePath });
      const commitMsg = `wf: ${(task.prompt || 'Task work').slice(0, 72)}`;
      gitExec(['commit', '-m', commitMsg, '--allow-empty'], { cwd: worktreePath });
    } catch { /* may already be committed */ }

    if (task.autoMerge) {
      updateTask(taskId, { output: cleanOutput, exitCode: 0 });
      await mergeWorktree(task);
    } else {
      updateTask(taskId, {
        status: 'review',
        output: cleanOutput,
        exitCode: 0,
      });
      logEvent(taskId, 'verification', 'Changes detected — awaiting review');
    }
  } else {
    // Distinguish crash from genuine zero-work: if task ran < 2 min, likely a crash
    const runtimeMs = task.startedAt ? Date.now() - new Date(task.startedAt).getTime() : Infinity;
    const isCrash = runtimeMs < 2 * 60 * 1000;
    const errorMsg = isCrash
      ? `Agent crashed after ${Math.round(runtimeMs / 1000)}s — no files changed (likely transient, will auto-retry)`
      : 'No files changed — zero-work guard triggered';
    updateTask(taskId, {
      status: 'failed',
      output: cleanOutput,
      error: errorMsg,
      exitCode: 0,
      completedAt: new Date().toISOString(),
    });
    logEvent(taskId, 'failed', isCrash ? 'Crash detected (short runtime, no changes)' : 'Zero-work guard');
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

  // Clean up prompt file
  try { unlinkSync(join(DATA_DIR, `${taskId}.prompt`)); } catch { /* ignore */ }

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
  const isAnalysisTask = freshTask?.taskType === 'analysis';

  // 4 & 5. Decide outcome
  if (isAnalysisTask && exitCode === 0) {
    // Analysis tasks succeed without file changes — their output IS the deliverable
    updateTask(taskId, {
      status: 'done',
      output,
      exitCode: 0,
      completedAt: new Date().toISOString(),
    });
    logEvent(taskId, 'completed', 'Analysis task completed');
    extractResultSummary(taskId, output || stdout || '');
    cleanupWorktree(taskId, worktreePath);
  } else if (exitCode === 0 && filesChanged) {
    try {
      for (const f of ['.env', '.env.local', '.env.development']) {
        try { gitExec(['rm', '--cached', '--ignore-unmatch', f], { cwd: worktreePath }); } catch { /* ignore */ }
      }
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
    let errorMsg;
    if (exitCode !== 0) {
      errorMsg = `Claude exited with code ${exitCode}. ${stderr || ''}`.trim();
    } else {
      const runtimeMs = freshTask?.startedAt ? Date.now() - new Date(freshTask.startedAt).getTime() : Infinity;
      const isCrash = runtimeMs < 2 * 60 * 1000;
      errorMsg = isCrash
        ? `Agent crashed after ${Math.round(runtimeMs / 1000)}s — no files changed (likely transient, will auto-retry)`
        : 'No files changed — zero-work guard triggered';
    }
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

  // Clean up prompt file
  try { const { unlinkSync } = await import('node:fs'); unlinkSync(join(DATA_DIR, `${task.id}.prompt`)); } catch { /* ignore */ }

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
    // Autonomy: defense-in-depth protected-branch check using config globs.
    // task-tools rewrites targetBranch on creation, but a stale task or a
    // manually-injected row could still slip through.
    if (task.autonomyMode === 'auto') {
      const cfg = getAutonomyConfig();
      const protectedBranches = cfg.protectedBranches || [];
      for (const g of protectedBranches) {
        if (matchesGlob(targetBranch, g)) {
          throw new Error(`Autonomy refusing merge: target "${targetBranch}" matches protected glob "${g}".`);
        }
      }
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

    // 6. Post-merge verification — run project test command if available
    try {
      const testCmd = detectTestCommand(repoRoot);
      if (testCmd) {
        logEvent(taskId, 'post_merge_verify_started', `Running: ${testCmd.cmd} ${testCmd.args.join(' ')}`);
        try {
          execFileSync(testCmd.cmd, testCmd.args, {
            cwd: repoRoot, timeout: 120_000, stdio: ['pipe', 'pipe', 'pipe'],
          });
          logEvent(taskId, 'post_merge_verify_passed', 'Tests passed after merge');
        } catch (testErr) {
          const stderr = testErr.stderr?.toString().slice(-500) || testErr.message;
          logEvent(taskId, 'post_merge_verify_failed', `Tests failed: ${stderr}`);
          // Don't fail the task — surface the signal, let human decide on rollback
          updateTask(taskId, {
            error: `Post-merge tests failed (merge succeeded). Consider: git revert HEAD. Error: ${stderr.slice(0, 200)}`,
          });
        }
      }
    } catch { /* ignore test detection errors */ }
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
// ensureStagingBranch — create per-run staging branch from base if missing.
// Idempotent. Safe to call multiple times. Used at autonomy run start.
// ---------------------------------------------------------------------------
export function ensureStagingBranch({ repoRoot, baseBranch, stagingBranch }) {
  if (!repoRoot || !stagingBranch) throw new Error('ensureStagingBranch requires repoRoot + stagingBranch');
  const base = baseBranch || 'main';

  // Does the branch already exist?
  try {
    gitExec(['rev-parse', '--verify', stagingBranch], { cwd: repoRoot });
    return { created: false, branch: stagingBranch };
  } catch {
    // not found — fall through and create it
  }

  // Resolve base SHA
  let baseSha;
  try {
    baseSha = gitExec(['rev-parse', base], { cwd: repoRoot });
  } catch (err) {
    throw new Error(`ensureStagingBranch: base branch "${base}" not found: ${err.message}`);
  }

  gitExec(['branch', stagingBranch, baseSha], { cwd: repoRoot });
  return { created: true, branch: stagingBranch, baseSha };
}

// ---------------------------------------------------------------------------
// Worktree cleanup with retries
// ---------------------------------------------------------------------------
function cleanupWorktree(taskId, worktreePath) {
  if (!worktreePath) return;

  const repoRoot = PROJECT_DIR;
  const branchName = `wf/${taskId}`;

  // Preserve work when the merge step failed (e.g. protected-branch refusal,
  // non-fast-forward conflict). Removing the worktree + branch + remote ref
  // would silently destroy the agent's commits, leaving them recoverable only
  // via `git fsck --dangling`. Operators recover by either rerunning approval
  // after fixing the merge target, or by manually shipping the branch as a PR.
  const task = getTask(taskId);
  if (task && task.mergeFailed === 1) {
    console.warn(
      `[cleanupWorktree] Skipping cleanup for ${taskId}: merge failed, ` +
      `preserving worktree at ${worktreePath} and branch ${branchName} ` +
      `for recovery.`,
    );
    logEvent(taskId, 'cleanup_skipped_merge_failed', branchName);
    return;
  }

  // Remove symlinks before worktree removal (prevents deleting main workspace files)
  for (const target of ['node_modules', '.env', '.env.local', '.env.development']) {
    const linked = join(worktreePath, target);
    try {
      if (existsSync(linked) && lstatSync(linked).isSymbolicLink()) {
        unlinkSync(linked);
      }
    } catch { /* non-fatal */ }
  }

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

    // Try to delete the local branch
    try {
      gitExec(['branch', '-D', branchName], { cwd: repoRoot });
    } catch {
      // ignore — branch may not exist or may be the current branch
    }

    // Clean up the remote branch if it was pushed by the agent
    try {
      gitExec(['push', 'origin', '--delete', branchName], { cwd: repoRoot });
    } catch {
      // ignore — remote branch may not exist
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
