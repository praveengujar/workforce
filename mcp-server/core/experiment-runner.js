/**
 * Experiment Runner
 *
 * Runs an iterative experiment loop: each iteration spawns a Claude CLI
 * agent that modifies code, runs a measurement command, and evaluates
 * the result against a target metric.
 *
 * The loop continues until:
 * - Target metric is achieved
 * - Max iterations reached
 * - Budget exhausted
 * - Manual cancellation
 */

import { spawn, execFileSync } from 'node:child_process';
import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

import {
  getTask,
  createTask as dbCreateTask,
  updateTask,
  recordCost,
} from './db.js';
import { logEvent } from './task-events.js';
import { classifyTier } from './cost-model.js';
import { estimateTaskCost } from './task-cost.js';
import { parseDetailedCost, appendCostLog } from './cost-tracker.js';
import { createToken, removeToken, getToken } from './project-state.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const DATA_DIR = process.env.WORKFORCE_DATA_DIR || join(homedir(), '.claude', 'tasks');
const DEFAULT_MAX_ITERATIONS = 20;
const DEFAULT_ITERATION_TIMEOUT_MS = 5 * 60 * 1000; // 5 min

// In-memory registry of running experiments
const _runningExperiments = new Map();

let PROJECT_DIR = null;

export function setExperimentProjectDir(dir) {
  PROJECT_DIR = dir;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function gitExec(args, options = {}) {
  return execFileSync('git', args, { stdio: 'pipe', ...options }).toString().trim();
}

function findClaudeCli() {
  const explicit = process.env.CLAUDE_CLI;
  if (explicit) return explicit;

  const candidates = [
    join(homedir(), '.local', 'bin', 'claude'),
    join(homedir(), 'bin', 'claude'),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
  ];

  for (const p of candidates) {
    if (existsSync(p)) return p;
  }

  return 'claude';
}

const CLAUDE_CLI = findClaudeCli();

function experimentConfigPath(experimentId) {
  return join(DATA_DIR, `${experimentId}.experiment.json`);
}

function iterationsPath(experimentId) {
  return join(DATA_DIR, `${experimentId}.iterations.jsonl`);
}

function loadExperimentConfig(experimentId) {
  const p = experimentConfigPath(experimentId);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function saveExperimentConfig(config) {
  ensureDir(DATA_DIR);
  writeFileSync(experimentConfigPath(config.id), JSON.stringify(config, null, 2) + '\n', 'utf8');
}

function appendIteration(experimentId, iteration) {
  ensureDir(DATA_DIR);
  appendFileSync(iterationsPath(experimentId), JSON.stringify(iteration) + '\n', 'utf8');
}

function loadIterations(experimentId) {
  const p = iterationsPath(experimentId);
  if (!existsSync(p)) return [];
  try {
    return readFileSync(p, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// createExperiment
// ---------------------------------------------------------------------------
export async function createExperiment(config) {
  if (!config.prompt) throw new Error('prompt (research objective) is required');
  if (!config.measureCommand) throw new Error('measureCommand is required');
  if (!config.metricPattern) throw new Error('metricPattern (regex) is required');
  if (!config.metricName) throw new Error('metricName is required');
  if (!config.direction || !['minimize', 'maximize'].includes(config.direction)) {
    throw new Error('direction must be "minimize" or "maximize"');
  }

  // Validate the regex
  try {
    new RegExp(config.metricPattern);
  } catch (err) {
    throw new Error(`Invalid metricPattern regex: ${err.message}`);
  }

  const repoRoot = PROJECT_DIR || process.cwd();
  const id = config.id || randomUUID();
  const experimentConfig = {
    id,
    prompt: config.prompt,
    project: config.project || null,
    measureCommand: config.measureCommand,
    metricPattern: config.metricPattern,
    metricName: config.metricName,
    direction: config.direction,
    targetValue: config.targetValue ?? null,
    maxIterations: config.maxIterations || DEFAULT_MAX_ITERATIONS,
    iterationTimeoutMs: config.iterationTimeoutMs || DEFAULT_ITERATION_TIMEOUT_MS,
    budgetLimit: config.budgetLimit ?? null,
    status: 'running',       // running | stopped | completed | failed
    bestMetric: null,
    totalCost: 0,
    currentIteration: 0,
    createdAt: new Date().toISOString(),
    completedAt: null,
    stopReason: null,
  };

  // Create a task row in the DB so it shows up in workforce_list_tasks
  const task = dbCreateTask({ id, prompt: `[Experiment] ${config.prompt}`, project: config.project });
  updateTask(id, {
    status: 'running',
    taskType: 'experiment',
    experimentConfig: JSON.stringify(experimentConfig),
    startedAt: new Date().toISOString(),
  });

  logEvent(id, 'experiment_created', `maxIterations=${experimentConfig.maxIterations} metric=${experimentConfig.metricName} direction=${experimentConfig.direction}`);

  // Create git worktree
  const worktreePath = join(repoRoot, 'wf', id);
  const branchName = `wf/${id}`;

  try {
    gitExec(['worktree', 'add', worktreePath, '-b', branchName], { cwd: repoRoot });
  } catch (err) {
    updateTask(id, { status: 'failed', error: `git worktree add failed: ${err.message}`, completedAt: new Date().toISOString() });
    logEvent(id, 'experiment_failed', `worktree creation failed: ${err.message}`);
    throw new Error(`git worktree add failed: ${err.stderr?.toString() || err.message}`);
  }

  updateTask(id, { worktreePath, branch: branchName });

  // Save experiment config to file
  experimentConfig.worktreePath = worktreePath;
  experimentConfig.branchName = branchName;
  saveExperimentConfig(experimentConfig);

  // Create cancellation token
  createToken(id);

  // Run the experiment loop in the background (non-blocking)
  runExperimentLoop(id).catch(err => {
    console.error(`[experiment] Loop error for ${id}:`, err.message);
    const cfg = loadExperimentConfig(id);
    if (cfg && cfg.status === 'running') {
      cfg.status = 'failed';
      cfg.stopReason = `Loop error: ${err.message}`;
      cfg.completedAt = new Date().toISOString();
      saveExperimentConfig(cfg);
      updateTask(id, { status: 'failed', error: cfg.stopReason, completedAt: cfg.completedAt });
      logEvent(id, 'experiment_failed', cfg.stopReason);
    }
    removeToken(id);
    _runningExperiments.delete(id);
  });

  return experimentConfig;
}

// ---------------------------------------------------------------------------
// runExperimentLoop
// ---------------------------------------------------------------------------
export async function runExperimentLoop(experimentId) {
  const config = loadExperimentConfig(experimentId);
  if (!config) throw new Error(`Experiment ${experimentId} not found`);

  const worktreePath = config.worktreePath;

  // Mark as actively running in memory
  _runningExperiments.set(experimentId, { abortRequested: false });

  // Run baseline measurement first
  let baselineMetric = null;
  try {
    baselineMetric = runMeasurement(config.measureCommand, config.metricPattern, worktreePath);
    config.bestMetric = baselineMetric;
    saveExperimentConfig(config);
    logEvent(experimentId, 'experiment_baseline', `baseline ${config.metricName}=${baselineMetric}`);
  } catch (err) {
    console.error(`[experiment] Baseline measurement failed for ${experimentId}: ${err.message}`);
    logEvent(experimentId, 'experiment_baseline', `baseline measurement failed: ${err.message}`);
    // Continue without baseline — first iteration establishes it
  }

  for (let i = 1; i <= config.maxIterations; i++) {
    // Check cancellation
    const runState = _runningExperiments.get(experimentId);
    if (!runState || runState.abortRequested) {
      config.status = 'stopped';
      config.stopReason = 'Stopped by user';
      config.completedAt = new Date().toISOString();
      saveExperimentConfig(config);
      updateTask(experimentId, { status: 'review', completedAt: config.completedAt });
      logEvent(experimentId, 'experiment_stopped', `Stopped at iteration ${i}`);
      break;
    }

    // Check cancellation token
    const token = getToken(experimentId);
    if (token && token.cancelled) {
      config.status = 'stopped';
      config.stopReason = 'Cancelled via token';
      config.completedAt = new Date().toISOString();
      saveExperimentConfig(config);
      updateTask(experimentId, { status: 'review', completedAt: config.completedAt });
      logEvent(experimentId, 'experiment_stopped', 'Cancelled via token');
      break;
    }

    // Check budget
    if (config.budgetLimit != null && config.totalCost >= config.budgetLimit) {
      config.status = 'completed';
      config.stopReason = `Budget exhausted: $${config.totalCost.toFixed(2)} >= $${config.budgetLimit.toFixed(2)}`;
      config.completedAt = new Date().toISOString();
      saveExperimentConfig(config);
      updateTask(experimentId, { status: 'review', completedAt: config.completedAt });
      logEvent(experimentId, 'experiment_completed', config.stopReason);
      break;
    }

    config.currentIteration = i;
    saveExperimentConfig(config);

    logEvent(experimentId, 'iteration_started', `iteration=${i}/${config.maxIterations}`);
    const iterationStart = Date.now();

    let iterationResult;
    try {
      iterationResult = await runIteration(config, i, worktreePath);
    } catch (err) {
      console.error(`[experiment] Iteration ${i} failed for ${experimentId}: ${err.message}`);
      logEvent(experimentId, 'iteration_failed', `iteration=${i} error=${err.message}`);
      iterationResult = {
        iteration: i,
        metricValue: null,
        improved: false,
        kept: false,
        cost: 0,
        commitHash: null,
        description: `Error: ${err.message}`,
        duration: Date.now() - iterationStart,
      };
    }

    // Record iteration
    appendIteration(experimentId, iterationResult);
    config.totalCost += iterationResult.cost;

    // Update best metric
    if (iterationResult.metricValue != null && iterationResult.kept) {
      config.bestMetric = iterationResult.metricValue;
    }

    saveExperimentConfig(config);

    // Update task cost
    updateTask(experimentId, { cost: config.totalCost });

    logEvent(experimentId, 'iteration_completed',
      `iteration=${i} metric=${iterationResult.metricValue} kept=${iterationResult.kept} cost=$${iterationResult.cost.toFixed(2)}`);

    // Check if target reached
    if (config.targetValue != null && iterationResult.metricValue != null) {
      const targetReached = config.direction === 'minimize'
        ? iterationResult.metricValue <= config.targetValue
        : iterationResult.metricValue >= config.targetValue;

      if (targetReached) {
        config.status = 'completed';
        config.stopReason = `Target reached: ${config.metricName}=${iterationResult.metricValue} (target: ${config.targetValue})`;
        config.completedAt = new Date().toISOString();
        saveExperimentConfig(config);
        updateTask(experimentId, { status: 'review', completedAt: config.completedAt });
        logEvent(experimentId, 'experiment_completed', config.stopReason);
        break;
      }
    }

    // Check if last iteration
    if (i >= config.maxIterations) {
      config.status = 'completed';
      config.stopReason = `Max iterations reached (${config.maxIterations})`;
      config.completedAt = new Date().toISOString();
      saveExperimentConfig(config);
      updateTask(experimentId, { status: 'review', completedAt: config.completedAt });
      logEvent(experimentId, 'experiment_completed', config.stopReason);
      break;
    }
  }

  removeToken(experimentId);
  _runningExperiments.delete(experimentId);
  return config;
}

// ---------------------------------------------------------------------------
// runIteration — spawns Claude CLI, runs measurement, decides keep/revert
// ---------------------------------------------------------------------------
async function runIteration(config, iterationNum, worktreePath) {
  const iterationStart = Date.now();

  // Build the iteration prompt
  const iterations = loadIterations(config.id);
  const prompt = buildIterationPrompt(config, iterationNum, iterations);

  // Snapshot: record current HEAD so we can revert
  let headBefore;
  try {
    headBefore = gitExec(['rev-parse', 'HEAD'], { cwd: worktreePath });
  } catch {
    headBefore = null;
  }

  // Spawn Claude CLI
  const output = await spawnClaudeIteration(prompt, worktreePath, config.iterationTimeoutMs);

  // Commit any changes the agent made
  let commitHash = null;
  let hasChanges = false;
  try {
    const status = gitExec(['status', '--porcelain'], { cwd: worktreePath });
    hasChanges = status.length > 0;
  } catch {
    hasChanges = false;
  }

  if (hasChanges) {
    try {
      gitExec(['add', '-A'], { cwd: worktreePath });
      gitExec(['commit', '-m', `experiment iteration ${iterationNum}`], { cwd: worktreePath });
      commitHash = gitExec(['rev-parse', 'HEAD'], { cwd: worktreePath });
    } catch (err) {
      console.error(`[experiment] Git commit failed in iteration ${iterationNum}: ${err.message}`);
    }
  }

  // Extract agent's description of what it tried (first few lines or from output)
  const description = extractDescription(output, iterationNum);

  // Run measurement
  let metricValue = null;
  try {
    metricValue = runMeasurement(config.measureCommand, config.metricPattern, worktreePath);
  } catch (err) {
    console.error(`[experiment] Measurement failed in iteration ${iterationNum}: ${err.message}`);
  }

  // Determine if this is an improvement
  let improved = false;
  let kept = false;

  if (metricValue != null) {
    if (config.bestMetric == null) {
      // First measurement — always keep
      improved = true;
      kept = true;
    } else {
      improved = config.direction === 'minimize'
        ? metricValue < config.bestMetric
        : metricValue > config.bestMetric;
      kept = improved;
    }
  }

  // Revert if not kept
  if (!kept && commitHash && headBefore) {
    try {
      gitExec(['reset', '--hard', headBefore], { cwd: worktreePath });
      logEvent(config.id, 'iteration_reverted', `iteration=${iterationNum} metric=${metricValue}`);
    } catch (err) {
      console.error(`[experiment] Revert failed in iteration ${iterationNum}: ${err.message}`);
    }
  }

  // Parse cost from output
  let cost = 0;
  try {
    const detailed = parseDetailedCost(output);
    if (detailed.cost && detailed.cost > 0) {
      cost = detailed.cost;
      const tier = classifyTier(config.prompt);
      recordCost(config.id, config.project, cost, tier);
      appendCostLog({
        taskId: config.id,
        project: config.project || null,
        cost,
        tier,
        inputTokens: detailed.inputTokens,
        outputTokens: detailed.outputTokens,
      });
    }
  } catch {
    // Fallback: estimate cost
    try {
      const estimate = estimateTaskCost(config.prompt, 0);
      cost = estimate.totalCost;
    } catch {
      // ignore
    }
  }

  return {
    iteration: iterationNum,
    metricValue,
    improved,
    kept,
    cost,
    commitHash: kept ? commitHash : null,
    description,
    duration: Date.now() - iterationStart,
  };
}

// ---------------------------------------------------------------------------
// spawnClaudeIteration — runs Claude CLI in child_process, returns output
// ---------------------------------------------------------------------------
function spawnClaudeIteration(prompt, cwd, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(CLAUDE_CLI, ['--print', '--dangerously-skip-permissions', '-p', prompt], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });

    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
      reject(new Error(`Iteration timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);

    child.on('error', err => {
      clearTimeout(timer);
      reject(new Error(`Spawn error: ${err.message}`));
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        console.error(`[experiment] Claude exited with code ${code}: ${stderr.slice(-500)}`);
      }
      // Return stdout even on non-zero exit — agent may have made partial changes
      resolve(stdout + stderr);
    });
  });
}

// ---------------------------------------------------------------------------
// runMeasurement — runs the measure command and extracts metric
// ---------------------------------------------------------------------------
function runMeasurement(measureCommand, metricPattern, worktreePath) {
  if (!measureCommand || !measureCommand.trim()) {
    throw new Error('measureCommand is empty');
  }

  let output;
  try {
    output = execFileSync('bash', ['-c', measureCommand], {
      cwd: worktreePath,
      stdio: 'pipe',
      timeout: 120_000, // 2 min max for measurement
      env: { ...process.env },
    }).toString();
  } catch (err) {
    // The command may exit non-zero but still produce useful output
    output = (err.stdout?.toString() || '') + (err.stderr?.toString() || '');
    if (!output) throw new Error(`Measurement command failed: ${err.message}`);
  }

  const regex = new RegExp(metricPattern);
  const match = output.match(regex);
  if (!match || match.length < 2) {
    throw new Error(`Metric pattern "${metricPattern}" did not match in output (${output.slice(0, 200)})`);
  }

  const value = parseFloat(match[1]);
  if (isNaN(value)) {
    throw new Error(`Extracted metric value "${match[1]}" is not a number`);
  }

  return value;
}

// ---------------------------------------------------------------------------
// buildIterationPrompt
// ---------------------------------------------------------------------------
function buildIterationPrompt(config, iterationNum, priorIterations) {
  const lines = [];

  lines.push(`# Experiment: ${config.prompt}`);
  lines.push('');
  lines.push(`You are iteration ${iterationNum}/${config.maxIterations} of an iterative experiment.`);
  lines.push('');
  lines.push('## Objective');
  lines.push(config.prompt);
  lines.push('');
  lines.push('## Metric');
  lines.push(`- **Metric name**: ${config.metricName}`);
  lines.push(`- **Direction**: ${config.direction} (lower is better: ${config.direction === 'minimize'})`);
  lines.push(`- **Current best**: ${config.bestMetric != null ? config.bestMetric : '(no baseline yet)'}`);
  if (config.targetValue != null) {
    lines.push(`- **Target**: ${config.targetValue}`);
  }
  lines.push('');
  lines.push('## Measurement');
  lines.push(`After you make changes, this command will be run to measure the result:`);
  lines.push('```');
  lines.push(config.measureCommand);
  lines.push('```');
  lines.push(`The metric is extracted with regex: \`${config.metricPattern}\``);
  lines.push('');

  // Prior iteration history
  if (priorIterations.length > 0) {
    lines.push('## Prior Iterations');
    lines.push('');
    lines.push('| # | Metric | Status | What was tried |');
    lines.push('|---|--------|--------|----------------|');
    for (const iter of priorIterations) {
      const status = iter.kept ? 'KEPT' : 'REVERTED';
      const metric = iter.metricValue != null ? iter.metricValue.toString() : 'N/A';
      lines.push(`| ${iter.iteration} | ${metric} | ${status} | ${iter.description} |`);
    }
    lines.push('');

    // Guidance based on history
    const keptIterations = priorIterations.filter(i => i.kept);
    const revertedIterations = priorIterations.filter(i => !i.kept);

    if (revertedIterations.length > 0) {
      lines.push('## What to AVOID (these were tried and reverted):');
      for (const iter of revertedIterations) {
        lines.push(`- ${iter.description}`);
      }
      lines.push('');
    }

    if (keptIterations.length > 0) {
      lines.push('## What WORKED (these improved the metric):');
      for (const iter of keptIterations) {
        lines.push(`- ${iter.description} (metric: ${iter.metricValue})`);
      }
      lines.push('');
    }
  }

  lines.push('## Instructions');
  lines.push('');
  lines.push('1. Analyze the current code and prior results.');
  lines.push(`2. Make a focused change that you believe will ${config.direction} the ${config.metricName} metric.`);
  lines.push('3. Try something DIFFERENT from prior reverted attempts.');
  lines.push('4. Make your changes small and targeted — one idea per iteration.');
  lines.push('5. Write a brief summary (1 line) of what you changed at the end of your output, prefixed with "SUMMARY: ".');
  lines.push('');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// extractDescription — pull the agent's summary from output
// ---------------------------------------------------------------------------
function extractDescription(output, iterationNum) {
  if (!output) return `Iteration ${iterationNum}`;

  // Look for "SUMMARY: ..." pattern
  const summaryMatch = output.match(/SUMMARY:\s*(.+)/i);
  if (summaryMatch) {
    return summaryMatch[1].trim().slice(0, 120);
  }

  // Fallback: first meaningful line of output
  const lines = output.trim().split('\n').filter(l => l.trim().length > 10);
  if (lines.length > 0) {
    return lines[lines.length - 1].trim().slice(0, 120);
  }

  return `Iteration ${iterationNum}`;
}

// ---------------------------------------------------------------------------
// getExperimentStatus
// ---------------------------------------------------------------------------
export function getExperimentStatus(experimentId) {
  const config = loadExperimentConfig(experimentId);
  if (!config) throw new Error(`Experiment ${experimentId} not found`);

  const iterations = loadIterations(experimentId);
  const isRunning = _runningExperiments.has(experimentId);

  return {
    ...config,
    status: isRunning ? 'running' : config.status,
    iterations,
    iterationCount: iterations.length,
  };
}

// ---------------------------------------------------------------------------
// stopExperiment
// ---------------------------------------------------------------------------
export function stopExperiment(experimentId) {
  const config = loadExperimentConfig(experimentId);
  if (!config) throw new Error(`Experiment ${experimentId} not found`);

  const runState = _runningExperiments.get(experimentId);
  if (runState) {
    runState.abortRequested = true;
    logEvent(experimentId, 'experiment_stop_requested', 'Stop requested by user');
    return { ok: true, message: 'Stop requested. Experiment will stop after current iteration completes.' };
  }

  // Already stopped
  return { ok: true, message: 'Experiment is not currently running.' };
}

// ---------------------------------------------------------------------------
// listExperiments
// ---------------------------------------------------------------------------
export function listExperiments() {
  ensureDir(DATA_DIR);

  const experiments = [];

  // Scan for .experiment.json files in DATA_DIR
  try {
    const files = readdirSync(DATA_DIR).filter(f => f.endsWith('.experiment.json'));

    for (const file of files) {
      try {
        const config = JSON.parse(readFileSync(join(DATA_DIR, file), 'utf8'));
        const isRunning = _runningExperiments.has(config.id);
        experiments.push({
          id: config.id,
          prompt: config.prompt,
          project: config.project,
          metricName: config.metricName,
          direction: config.direction,
          bestMetric: config.bestMetric,
          targetValue: config.targetValue,
          status: isRunning ? 'running' : config.status,
          currentIteration: config.currentIteration,
          maxIterations: config.maxIterations,
          totalCost: config.totalCost,
          createdAt: config.createdAt,
          completedAt: config.completedAt,
          stopReason: config.stopReason,
        });
      } catch {
        // skip corrupt files
      }
    }
  } catch {
    // ignore
  }

  return experiments.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
}
