#!/usr/bin/env node

/**
 * Workforce MCP Server — stdio transport.
 *
 * Exposes 36 tools for managing autonomous Claude Code agent sessions.
 * Replaces the Express+WebSocket backend with a single MCP server process.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

// Core modules
import { getDb, getBudget, getRunningTasks } from './core/db.js';
import { killSession } from './core/tmux.js';
import { loadCostModel } from './core/cost-model.js';
import { loadProfiles } from './core/profiles.js';
import { startRecoveryEngine, setProjectDir as setRecoveryProjectDir } from './core/recovery-engine.js';
import { initWorkerManager, stopWorkerManager } from './core/worker-manager.js';

// Tool handlers
import {
  createTaskHandler, listTasksHandler, getTaskHandler,
  cancelTaskHandler, retryTaskHandler, archiveTaskHandler,
  cleanupTasksHandler, taskEventsHandler, taskOutputHandler,
  replyToTaskHandler, pauseTaskHandler, resumeTaskHandler,
  analyzePromptHandler,
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
  healthMetricsHandler, costSummaryHandler,
  runRecoveryHandler,
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
import { isSubscriptionMode } from './core/constants.js';
import { readCostLog, getCostLogSummary } from './core/cost-tracker.js';

// ---------------------------------------------------------------------------
// Server setup
// ---------------------------------------------------------------------------
const WORKFORCE_VERSION = '1.3.0';

const server = new McpServer({
  name: 'workforce',
  version: WORKFORCE_VERSION,
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
// Version
// ---------------------------------------------------------------------------

server.tool(
  'workforce_version',
  'Return the workforce plugin version.',
  {},
  async () => ({ content: [{ type: 'text', text: WORKFORCE_VERSION }] }),
);

// ---------------------------------------------------------------------------
// Task Management Tools
// ---------------------------------------------------------------------------

server.tool(
  'workforce_create_task',
  'Create a new autonomous agent task. Spawns Claude CLI in an isolated git worktree.',
  { prompt: z.string().describe('Task instruction for the agent'), project: z.string().optional().describe('Project name'), autoMerge: z.boolean().optional().describe('Auto-merge on success (default: false)'), depends_on: z.array(z.string()).optional().describe('Array of task IDs this task depends on'), group: z.string().optional().describe('Task group ID for dependency chains'), phase: z.number().optional().describe('Execution phase number'), parent_id: z.string().optional().describe('Parent task ID') },
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
  'workforce_cleanup',
  'Bulk cleanup old failed/rejected/stuck tasks. Archives them after optional cancellation.',
  {
    max_age_hours: z.number().optional().describe('Age threshold in hours (default: 24)'),
    include_stuck: z.boolean().optional().describe('Also clean up stuck running/pending tasks (default: false)'),
    dry_run: z.boolean().optional().describe('Preview what would be cleaned up without acting (default: false)'),
  },
  wrap(cleanupTasksHandler),
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

server.tool(
  'workforce_analyze_prompt',
  'Analyze a task prompt for admission quality, complexity, and estimated cost.',
  { prompt: z.string().describe('Task prompt to analyze') },
  wrap(analyzePromptHandler),
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
  'Approve a task in review status — merges its branch to the target branch.',
  { task_id: z.string().describe('Task ID to approve'), reason: z.string().optional().describe('Approval rationale') },
  wrap(approveTaskHandler),
);

server.tool(
  'workforce_reject_task',
  'Reject a task in review status — marks as rejected and cleans up worktree.',
  { task_id: z.string().describe('Task ID to reject'), reason: z.string().optional().describe('Rejection reason') },
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

server.tool(
  'workforce_backlog_reorder',
  'Reorder backlog items by providing an ordered array of item IDs.',
  { order: z.array(z.string()).describe('Ordered array of backlog item IDs') },
  wrap(backlogReorderHandler),
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
  `Set ${isSubscriptionMode() ? 'task count' : 'spending'} limits for the workforce. Scope can be "global" or a project name.`,
  {
    scope: z.string().optional().describe('Budget scope: "global" (default) or project name'),
    daily_limit: z.number().optional().describe(`Daily ${isSubscriptionMode() ? 'task count' : 'spending'} limit`),
    weekly_limit: z.number().optional().describe(`Weekly ${isSubscriptionMode() ? 'task count' : 'spending'} limit`),
    monthly_limit: z.number().optional().describe(`Monthly ${isSubscriptionMode() ? 'task count' : 'spending'} limit`),
  },
  wrap(setBudgetHandler),
);

server.tool(
  'workforce_get_budget',
  `Get budget limits and current ${isSubscriptionMode() ? 'task usage' : 'spend'} for a scope.`,
  {
    scope: z.string().optional().describe('Budget scope: "global" (default) or project name'),
  },
  wrapFormatted(async (params) => {
    const result = getBudgetHandler(params);
    return result.text || JSON.stringify(result.data || result, null, 2);
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
function gracefulShutdown() {
  console.error('[workforce] Shutting down...');
  if (stopRecovery) stopRecovery();
  if (stopCostWatchdog) stopCostWatchdog();
  stopWorkerManager();
  // Kill running tasks to prevent orphaned processes
  try {
    const running = getRunningTasks();
    for (const task of running) {
      if (task.tmuxSession) {
        try { killSession(task.tmuxSession); } catch { /* ignore */ }
      }
      if (task.pid) {
        try { process.kill(task.pid, 'SIGTERM'); } catch { /* ignore */ }
      }
    }
  } catch { /* ignore cleanup errors */ }
  process.exit(0);
}

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

main().catch(err => {
  console.error('[workforce] Fatal error:', err);
  process.exit(1);
});
