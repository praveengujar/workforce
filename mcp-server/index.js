#!/usr/bin/env node

/**
 * Workforce MCP Server — stdio transport.
 *
 * Exposes 35 tools for managing autonomous Claude Code agent sessions.
 * Replaces the Express+WebSocket backend with a single MCP server process.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

// Core modules
import { getDb, getBudget, setBudget, getCostForPeriod } from './core/db.js';
import { loadCostModel } from './core/cost-model.js';
import { loadProfiles } from './core/profiles.js';
import { startRecoveryEngine, setProjectDir as setRecoveryProjectDir } from './core/recovery-engine.js';
import { initWorkerManager, stopWorkerManager } from './core/worker-manager.js';

// Tool handlers
import {
  createTaskHandler, listTasksHandler, getTaskHandler,
  cancelTaskHandler, retryTaskHandler, archiveTaskHandler,
  taskEventsHandler, taskOutputHandler, replyToTaskHandler,
  pauseTaskHandler, resumeTaskHandler, analyzePromptHandler,
} from './tools/task-tools.js';

import {
  getDiffHandler, approveTaskHandler, rejectTaskHandler,
  setProjectDir as setLifecycleProjectDir,
} from './tools/lifecycle-tools.js';

import {
  backlogListHandler, backlogAddHandler, backlogUpdateHandler,
  backlogDeleteHandler, backlogReorderHandler,
} from './tools/backlog-tools.js';

import {
  healthMetricsHandler, costSummaryHandler, listProjectsHandler,
  listProfilesHandler, runRecoveryHandler,
} from './tools/monitoring-tools.js';

import {
  formatTaskList, formatHealthMetrics, formatCostSummary,
} from './tools/formatters.js';

import {
  setBudgetHandler, getBudgetHandler,
  setCostPolicyHandler, getCostPolicyHandler,
} from './tools/budget-tools.js';

import {
  createExperimentHandler, experimentStatusHandler,
  stopExperimentHandler, listExperimentsHandler,
} from './tools/experiment-tools.js';

import { setExperimentProjectDir } from './core/experiment-runner.js';

import {
  writeContextHandler, readContextHandler,
  taskDependenciesHandler, groupStatusHandler,
} from './tools/context-tools.js';

import { startCostWatchdog, manualCostWatchdogScan } from './core/cost-watchdog.js';
import { readCostLog, getCostLogSummary } from './core/cost-tracker.js';

// ---------------------------------------------------------------------------
// Server setup
// ---------------------------------------------------------------------------
const server = new McpServer({
  name: 'workforce',
  version: '1.0.0',
});

// Helper: wrap handler so errors become tool error results instead of crashes
function wrap(handler) {
  return async (params) => {
    try {
      const result = await handler(params);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  };
}

// Helper: wrap handler that returns pre-formatted text (no JSON.stringify)
function wrapFormatted(handler) {
  return async (params) => {
    try {
      const result = await handler(params);
      return { content: [{ type: 'text', text: result }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  };
}

// ---------------------------------------------------------------------------
// Task Management Tools
// ---------------------------------------------------------------------------

server.tool(
  'workforce_create_task',
  'Create a new autonomous agent task. Spawns Claude CLI in an isolated git worktree.',
  { prompt: z.string().describe('Task instruction for the agent'), project: z.string().optional().describe('Project name'), profile: z.string().optional().describe('Agent profile (default/interactive)'), autoMerge: z.boolean().optional().describe('Auto-merge on success (default: false)') },
  wrap(createTaskHandler),
);

server.tool(
  'workforce_list_tasks',
  'List all active tasks with status, project, and timing info.',
  { status_filter: z.string().optional().describe('Filter by status (pending/running/review/done/failed)'), include_archived: z.boolean().optional().describe('Include archived tasks') },
  wrapFormatted(async (params) => {
    const tasks = listTasksHandler(params);
    return formatTaskList(tasks);
  }),
);

server.tool(
  'workforce_get_task',
  'Get detailed info for a specific task.',
  { task_id: z.string().describe('Task ID') },
  wrap(getTaskHandler),
);

server.tool(
  'workforce_cancel_task',
  'Cancel a running or pending task. Kills the process and cleans up the worktree.',
  { task_id: z.string().describe('Task ID to cancel') },
  wrap(cancelTaskHandler),
);

server.tool(
  'workforce_retry_task',
  'Retry a failed task. Resets to pending and increments retry count.',
  { task_id: z.string().describe('Task ID to retry') },
  wrap(retryTaskHandler),
);

server.tool(
  'workforce_archive_task',
  'Archive a completed task to hide it from the active list.',
  { task_id: z.string().describe('Task ID to archive') },
  wrap(archiveTaskHandler),
);

server.tool(
  'workforce_task_events',
  'Get the full lifecycle event timeline for a task.',
  { task_id: z.string().describe('Task ID') },
  wrap(taskEventsHandler),
);

server.tool(
  'workforce_task_output',
  'Get current output from a running or completed task (captures tmux pane or reads log).',
  { task_id: z.string().describe('Task ID') },
  wrap(taskOutputHandler),
);

server.tool(
  'workforce_reply_to_task',
  'Send a message to a running interactive task (via tmux).',
  { task_id: z.string().describe('Task ID'), message: z.string().describe('Message to send') },
  wrap(replyToTaskHandler),
);

server.tool(
  'workforce_pause_task',
  'Pause a running task (tmux sessions only).',
  { task_id: z.string().describe('Task ID to pause') },
  wrap(pauseTaskHandler),
);

server.tool(
  'workforce_resume_task',
  'Resume a paused task.',
  { task_id: z.string().describe('Task ID to resume') },
  wrap(resumeTaskHandler),
);

// ---------------------------------------------------------------------------
// Change Review Tools
// ---------------------------------------------------------------------------

server.tool(
  'workforce_get_diff',
  'Get the git diff for a task branch vs main. Shows files changed, additions, deletions.',
  { task_id: z.string().describe('Task ID') },
  wrap(getDiffHandler),
);

server.tool(
  'workforce_approve_task',
  'Approve a task in review status — merges its branch to main.',
  { task_id: z.string().describe('Task ID to approve') },
  wrap(approveTaskHandler),
);

server.tool(
  'workforce_reject_task',
  'Reject a task in review status — discards changes and cleans up worktree.',
  { task_id: z.string().describe('Task ID to reject') },
  wrap(rejectTaskHandler),
);

// ---------------------------------------------------------------------------
// Backlog Tools
// ---------------------------------------------------------------------------

server.tool(
  'workforce_backlog_list',
  'List all backlog items with priority, title, and description.',
  {},
  wrap(backlogListHandler),
);

server.tool(
  'workforce_backlog_add',
  'Add a new item to the backlog.',
  { title: z.string().describe('Item title'), description: z.string().optional().describe('Item description'), priority: z.enum(['high', 'medium', 'low']).optional().describe('Priority level') },
  wrap(backlogAddHandler),
);

server.tool(
  'workforce_backlog_update',
  'Update an existing backlog item.',
  { id: z.string().describe('Item ID'), title: z.string().optional(), description: z.string().optional(), priority: z.enum(['high', 'medium', 'low']).optional() },
  wrap(backlogUpdateHandler),
);

server.tool(
  'workforce_backlog_delete',
  'Remove an item from the backlog.',
  { id: z.string().describe('Item ID to delete') },
  wrap(backlogDeleteHandler),
);

// ---------------------------------------------------------------------------
// Monitoring Tools
// ---------------------------------------------------------------------------

server.tool(
  'workforce_health_metrics',
  'Get workforce health metrics: success rate, failure rate, one-shot rate, suggestions.',
  {},
  wrapFormatted(async () => {
    const metrics = healthMetricsHandler();
    const costData = costSummaryHandler();
    return formatHealthMetrics(metrics, costData);
  }),
);

server.tool(
  'workforce_cost_summary',
  'Get cost summary: today, this week, this month, breakdown by tier.',
  {},
  wrapFormatted(async () => {
    const costData = costSummaryHandler();
    // Attach budget info if available
    const budget = getBudget('global');
    if (budget) {
      costData.budget = budget;
    }
    return formatCostSummary(costData);
  }),
);

// ---------------------------------------------------------------------------
// Budget Tools
// ---------------------------------------------------------------------------

server.tool(
  'workforce_set_budget',
  'Set spending limits for the workforce. Scope can be "global" or a project name.',
  {
    scope: z.string().optional().describe('Budget scope: "global" (default) or project name'),
    daily_limit: z.number().optional().describe('Daily spending limit in dollars'),
    weekly_limit: z.number().optional().describe('Weekly spending limit in dollars'),
    monthly_limit: z.number().optional().describe('Monthly spending limit in dollars'),
  },
  wrap(({ scope, daily_limit, weekly_limit, monthly_limit }) => {
    const budgetScope = scope || 'global';
    if (daily_limit == null && weekly_limit == null && monthly_limit == null) {
      throw new Error('At least one limit (daily_limit, weekly_limit, or monthly_limit) is required');
    }
    const budget = setBudget(budgetScope, {
      dailyLimit: daily_limit,
      weeklyLimit: weekly_limit,
      monthlyLimit: monthly_limit,
    });
    return budget;
  }),
);

server.tool(
  'workforce_get_budget',
  'Get budget limits and current spend for a scope.',
  {
    scope: z.string().optional().describe('Budget scope: "global" (default) or project name'),
  },
  wrap(({ scope }) => {
    const budgetScope = scope || 'global';
    const budget = getBudget(budgetScope);

    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const startOfWeek = new Date(now.getFullYear(), now.getMonth(), now.getDate() - now.getDay()).toISOString();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();

    const todaySpend = getCostForPeriod(budgetScope, startOfToday, endOfDay);
    const weekSpend = getCostForPeriod(budgetScope, startOfWeek, endOfDay);
    const monthSpend = getCostForPeriod(budgetScope, startOfMonth, endOfDay);

    return {
      scope: budgetScope,
      budget: budget || { dailyLimit: null, weeklyLimit: null, monthlyLimit: null },
      currentSpend: {
        today: Math.round(todaySpend * 100) / 100,
        thisWeek: Math.round(weekSpend * 100) / 100,
        thisMonth: Math.round(monthSpend * 100) / 100,
      },
      remaining: {
        daily: budget?.dailyLimit != null ? Math.round((budget.dailyLimit - todaySpend) * 100) / 100 : null,
        weekly: budget?.weeklyLimit != null ? Math.round((budget.weeklyLimit - weekSpend) * 100) / 100 : null,
        monthly: budget?.monthlyLimit != null ? Math.round((budget.monthlyLimit - monthSpend) * 100) / 100 : null,
      },
    };
  }),
);

// ---------------------------------------------------------------------------
// Cost Policy Tools (Phase 2)
// ---------------------------------------------------------------------------

server.tool(
  'workforce_set_cost_policy',
  'Configure cost approval policy: thresholds for auto-approve, confirmation, and hard reject.',
  {
    approval_threshold: z.number().optional().describe('Tasks above this cost need confirmation (default: $0.50)'),
    daily_auto_approve_limit: z.number().optional().describe('Auto-approve if daily total stays under this (default: $5.00)'),
    per_task_max: z.number().optional().describe('Hard reject tasks above this cost (default: $2.00)'),
    enabled: z.boolean().optional().describe('Enable/disable cost policy'),
  },
  wrap(setCostPolicyHandler),
);

server.tool(
  'workforce_get_cost_policy',
  'Get current cost approval policy configuration.',
  {},
  wrap(getCostPolicyHandler),
);

// ---------------------------------------------------------------------------
// Cost Monitoring Tools (Phase 3)
// ---------------------------------------------------------------------------

server.tool(
  'workforce_cost_watchdog_scan',
  'Manually trigger a cost watchdog scan across all running tasks. Returns any actions taken (warnings or kills).',
  {},
  wrap(async () => {
    const actions = manualCostWatchdogScan();
    return {
      scannedAt: new Date().toISOString(),
      actions,
      message: actions.length === 0 ? 'All running tasks within cost limits' : `${actions.length} action(s) taken`,
    };
  }),
);

server.tool(
  'workforce_cost_log',
  'Get recent cost log entries with token counts and a date-range summary.',
  {
    limit: z.number().optional().describe('Max entries to return (default 50)'),
    start_date: z.string().optional().describe('ISO 8601 start date filter'),
    end_date: z.string().optional().describe('ISO 8601 end date filter'),
  },
  wrap(({ limit, start_date, end_date }) => {
    const entries = readCostLog(limit || 50);
    const summary = getCostLogSummary(start_date, end_date);
    return { entries, summary };
  }),
);

// ---------------------------------------------------------------------------
// Experiment Tools
// ---------------------------------------------------------------------------

server.tool(
  'workforce_create_experiment',
  'Create and start an iterative experiment. The agent modifies code, measures a metric, keeps improvements, reverts failures. Repeats until target, max iterations, or budget is hit.',
  {
    prompt: z.string().describe('Research objective — what to optimize'),
    project: z.string().optional().describe('Project name'),
    measure_command: z.string().describe('Shell command to measure results (e.g., "npm test", "python train.py")'),
    metric_pattern: z.string().describe('Regex with capture group to extract metric from command output (e.g., "val_bpb: ([0-9.]+)")'),
    metric_name: z.string().describe('Human name for the metric (e.g., "val_bpb", "test_pass_rate")'),
    direction: z.enum(['minimize', 'maximize']).describe('Whether to minimize or maximize the metric'),
    target_value: z.number().optional().describe('Stop early when this metric value is reached'),
    max_iterations: z.number().optional().describe('Max experiment iterations (default: 20)'),
    iteration_timeout_ms: z.number().optional().describe('Per-iteration timeout in ms (default: 300000 = 5 min)'),
    budget_limit: z.number().optional().describe('Max total cost in dollars for all iterations'),
  },
  wrap(createExperimentHandler),
);

server.tool(
  'workforce_experiment_status',
  'Get experiment status with iteration history, metric trend, and cost.',
  { experiment_id: z.string().describe('Experiment ID') },
  wrapFormatted(experimentStatusHandler),
);

server.tool(
  'workforce_stop_experiment',
  'Stop a running experiment after the current iteration finishes.',
  { experiment_id: z.string().describe('Experiment ID to stop') },
  wrap(stopExperimentHandler),
);

server.tool(
  'workforce_list_experiments',
  'List all experiments with status summary.',
  {},
  wrapFormatted(listExperimentsHandler),
);

// ---------------------------------------------------------------------------
// Context & Dependency Tools
// ---------------------------------------------------------------------------

server.tool(
  'workforce_write_context',
  'Write a key-value entry to the shared context store for a task group.',
  {
    group: z.string().describe('Task group ID'),
    key: z.string().describe('Context key (e.g., "api_schema", "test_results")'),
    value: z.string().describe('Context value (string or JSON)'),
    task_id: z.string().optional().describe('Task that wrote this (for attribution)'),
  },
  wrap(writeContextHandler),
);

server.tool(
  'workforce_read_context',
  'Read shared context entries for a task group. Omit key to get all entries.',
  {
    group: z.string().describe('Task group ID'),
    key: z.string().optional().describe('Specific key to read (omit for all)'),
  },
  wrap(readContextHandler),
);

server.tool(
  'workforce_task_dependencies',
  'Show dependency resolution status for a task — which deps are done, pending, or failed.',
  { task_id: z.string().describe('Task ID') },
  wrap(taskDependenciesHandler),
);

server.tool(
  'workforce_group_status',
  'Show all tasks in a group with dependency tree, phase progress, and shared context.',
  { group: z.string().describe('Task group ID') },
  wrapFormatted(groupStatusHandler),
);

// ---------------------------------------------------------------------------
// Initialization and startup
// ---------------------------------------------------------------------------

let stopRecovery = null;
let stopCostWatchdog = null;

async function main() {
  const projectDir = process.cwd();

  // 1. Initialize database
  getDb();
  console.error('[workforce] Database initialized');

  // 2. Load cost model and profiles
  loadCostModel();
  loadProfiles();

  // 3. Set project directory for all modules
  setRecoveryProjectDir(projectDir);
  setLifecycleProjectDir(projectDir);
  setExperimentProjectDir(projectDir);

  // 4. Initialize worker manager (starts promote loop)
  initWorkerManager(projectDir);
  console.error('[workforce] Worker manager initialized');

  // 5. Start recovery engine
  stopRecovery = startRecoveryEngine();

  // 6. Start cost watchdog
  stopCostWatchdog = startCostWatchdog();

  // 7. Connect MCP transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error('[workforce] MCP server running on stdio');
}

// Graceful shutdown
process.on('SIGTERM', () => {
  console.error('[workforce] Shutting down...');
  if (stopRecovery) stopRecovery();
  if (stopCostWatchdog) stopCostWatchdog();
  stopWorkerManager();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.error('[workforce] Shutting down...');
  if (stopRecovery) stopRecovery();
  if (stopCostWatchdog) stopCostWatchdog();
  stopWorkerManager();
  process.exit(0);
});

main().catch(err => {
  console.error('[workforce] Fatal error:', err);
  process.exit(1);
});
