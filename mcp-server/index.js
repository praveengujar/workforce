#!/usr/bin/env node

/**
 * Workforce MCP Server — stdio transport.
 *
 * Exposes 65 tools for managing autonomous Claude Code agent sessions.
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
  runRecoveryHandler, opsMetricsHandler, routeTaskHandler,
  evalClustersHandler, ruleLintHandler, loopStatusHandler,
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

import {
  createRuleHandler, listRulesHandler,
  getRulesForPathHandler, deleteRuleHandler,
} from './tools/knowledge-tools.js';

import {
  createEvalHandler, listEvalsHandler, processEvalHandler,
} from './tools/eval-tools.js';

import {
  sessionContextHandler, activeFocusHandler,
} from './tools/session-tools.js';

import {
  dependencyGraphHandler, setGraphProjectDir,
} from './tools/graph-tools.js';

import { replayGoldenSetHandler } from './tools/replay-tools.js';

import {
  captureEpisodeHandler, recallEpisodesHandler,
} from './tools/episodic-tools.js';

import {
  proposeRuleFromEvalCluster, listProposedRules,
} from './core/context-capture-pipeline.js';

import {
  addContextItemHandler, searchContextItemsHandler,
  previewContextHandler, auditContextHandler,
  invalidateContextHandler, promoteContextHandler,
  compactContextHandler,
} from './tools/context-memory-tools.js';

import { startCostWatchdog, manualCostWatchdogScan } from './core/cost-watchdog.js';
import { isSubscriptionMode } from './core/constants.js';
import { readCostLog, getCostLogSummary } from './core/cost-tracker.js';

// ---------------------------------------------------------------------------
// Server setup
// ---------------------------------------------------------------------------
const WORKFORCE_VERSION = '3.6.0';

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
  { prompt: z.string().describe('Task instruction for the agent'), project: z.string().optional().describe('Project name'), autoMerge: z.boolean().optional().describe('Auto-merge on success (default: false)'), depends_on: z.array(z.string()).optional().describe('Array of task IDs this task depends on'), group: z.string().optional().describe('Task group ID for dependency chains'), phase: z.number().optional().describe('Execution phase number'), parent_id: z.string().optional().describe('Parent task ID'), task_type: z.enum(['standard', 'analysis', 'experiment', 'measurement']).optional().describe('Task type. "analysis" skips zero-work guard — for investigation tasks that produce findings without code changes') },
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
  'Approve a task in review status — merges its branch to the target branch. Enforces gate evidence (human_decision required; qa/security/adversarial required if started). Provide waivers to bypass specific gates with auditable reason.',
  {
    task_id: z.string().describe('Task ID to approve'),
    reason: z.string().optional().describe('Approval rationale'),
    waivers: z.array(z.object({
      gate: z.string().describe('Gate to waive (e.g., qa, security, adversarial, human_decision)'),
      reason: z.string().describe('Why this gate is being waived'),
    })).optional().describe('Explicit waivers for missing gate evidence'),
  },
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
// Ops Dashboard + Capability Router Tools
// ---------------------------------------------------------------------------

server.tool(
  'workforce_ops_metrics',
  'Get operational metrics: gate pass/fail rates, merge-block reasons, post-merge verification results, eval clusters, and rule quality issues.',
  {},
  wrap(opsMetricsHandler),
);

server.tool(
  'workforce_route_task',
  'Recommend the optimal skill path for a task prompt based on intent, complexity, and risk. Returns recommended skill, reason, alternatives, and detected flags.',
  {
    prompt: z.string().describe('Task prompt to analyze'),
    tier: z.string().optional().describe('Estimated tier: simple, medium, or complex'),
    file_paths: z.array(z.string()).optional().describe('Detected file paths in the prompt'),
  },
  wrap(routeTaskHandler),
);

server.tool(
  'workforce_eval_clusters',
  'Detect clusters of similar unprocessed evals and suggest preventive rules. Returns clusters of 3+ similar failures with suggested rule content and confidence score.',
  {
    min_cluster_size: z.number().optional().describe('Minimum evals to form a cluster (default 3)'),
    similarity_threshold: z.number().optional().describe('Jaccard similarity threshold 0-1 (default 0.7)'),
  },
  wrap(({ min_cluster_size, similarity_threshold }) => {
    return evalClustersHandler({ min_cluster_size, similarity_threshold });
  }),
);

server.tool(
  'workforce_rule_lint',
  'Run quality checks on all knowledge rules. Detects global wildcards, near-duplicates, short content, and priority issues.',
  {},
  wrap(ruleLintHandler),
);

server.tool(
  'workforce_loop_status',
  'Check Ralph Wiggum loop detection status — shows tasks stuck in unproductive loops (same error repeated, no progress after 5+ min). Use to identify agents that need intervention.',
  {},
  wrap(loopStatusHandler),
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
// Knowledge Rules Tools
// ---------------------------------------------------------------------------

server.tool(
  'workforce_create_rule',
  'Create a path-scoped knowledge rule. Rules encode domain knowledge (standards, patterns, anti-patterns) that gets injected into agent prompts when they work on matching files.',
  {
    category: z.enum(['standards', 'architecture', 'testing', 'security', 'workflow', 'patterns', 'custom']).describe('Rule category'),
    name: z.string().describe('Short rule name (e.g., "auth-jwt-validation")'),
    description: z.string().optional().describe('One-line description of what this rule covers'),
    paths: z.array(z.string()).describe('Array of glob patterns for path scoping (e.g., ["src/auth/**", "*.test.ts"])'),
    content: z.string().describe('The actual knowledge/standard to inject into agent context'),
    priority: z.number().optional().describe('Priority 1-10, higher = injected first (default: 5)'),
  },
  wrap(createRuleHandler),
);

server.tool(
  'workforce_list_rules',
  'List all knowledge rules, optionally filtered by category.',
  {
    category: z.enum(['standards', 'architecture', 'testing', 'security', 'workflow', 'patterns', 'custom']).optional().describe('Filter by category'),
  },
  wrap(listRulesHandler),
);

server.tool(
  'workforce_get_rules_for_path',
  'Get all knowledge rules that apply to the given file paths (audit mapping). Returns rules whose glob patterns match any of the input paths.',
  {
    paths: z.array(z.string()).describe('Array of file paths to check against rules'),
  },
  wrap(getRulesForPathHandler),
);

server.tool(
  'workforce_delete_rule',
  'Delete a knowledge rule by ID.',
  {
    id: z.string().describe('Rule ID to delete'),
  },
  wrap(deleteRuleHandler),
);

// ---------------------------------------------------------------------------
// Eval & Feedback Loop Tools
// ---------------------------------------------------------------------------

server.tool(
  'workforce_create_eval',
  'Create an eval log entry for a task failure. Part of the self-improving feedback loop.',
  {
    task_id: z.string().optional().describe('Task ID that failed'),
    category: z.enum(['pattern_violation', 'infrastructure', 'prompt_quality', 'scope_creep', 'rate_limit', 'environment', 'zero_work', 'merge_failure', 'dependency_failure', 'custom']).describe('Failure category'),
    rule_violated: z.string().optional().describe('Rule file path that should have prevented this, or "NO RULE EXISTS"'),
    what_happened: z.string().describe('Description of what went wrong'),
    root_cause: z.string().optional().describe('Why the system did not prevent this'),
    correct_approach: z.string().optional().describe('What should have been done instead'),
    preventive_update: z.string().optional().describe('JSON: {category, name, paths, content} for auto-creating a knowledge rule'),
    detection: z.enum(['auto_recovery', 'session_end_hook', 'manual_review', 'qa_failure']).describe('How this failure was detected'),
    severity: z.enum(['low', 'medium', 'high', 'critical']).optional().describe('Severity level (default: medium)'),
  },
  wrap(createEvalHandler),
);

server.tool(
  'workforce_list_evals',
  'List eval log entries with optional filters. Shows the self-improving feedback loop state.',
  {
    task_id: z.string().optional().describe('Filter by task ID'),
    category: z.string().optional().describe('Filter by category'),
    unprocessed_only: z.boolean().optional().describe('Only show unprocessed evals (default: false)'),
    limit: z.number().optional().describe('Max entries to return (default: 50)'),
  },
  wrap(listEvalsHandler),
);

server.tool(
  'workforce_process_eval',
  'Process an eval entry — create a knowledge rule, update memory, or dismiss.',
  {
    id: z.string().describe('Eval ID to process'),
    action: z.enum(['rule_created', 'rule_updated', 'memory_updated', 'dismissed']).describe('Processing action'),
  },
  wrap(processEvalHandler),
);

// ---------------------------------------------------------------------------
// Session Context Tools
// ---------------------------------------------------------------------------

server.tool(
  'workforce_session_context',
  'Read/write session context for cross-session continuity. Persists active focus, known issues, and investigation notes.',
  {
    project: z.string().describe('Project name'),
    action: z.enum(['get', 'set', 'list', 'clear']).describe('Action to perform'),
    key: z.string().optional().describe('Context key (required for get/set, optional for clear)'),
    value: z.string().optional().describe('Context value (required for set)'),
  },
  wrap(sessionContextHandler),
);

server.tool(
  'workforce_active_focus',
  'Get the active focus and session context summary for a project.',
  {
    project: z.string().describe('Project name'),
  },
  wrap(activeFocusHandler),
);

// ---------------------------------------------------------------------------
// Dependency Graph Tools
// ---------------------------------------------------------------------------

server.tool(
  'workforce_dependency_graph',
  'Build and query the import dependency graph for impact analysis. Build first, then query.',
  {
    action: z.enum(['build', 'query_impact', 'query_dependencies', 'stats']).describe('Action: build the graph, query impact (reverse deps), query dependencies (forward deps), or get stats'),
    path: z.string().optional().describe('File path to query (required for query_impact and query_dependencies)'),
    project_dir: z.string().optional().describe('Project directory (default: cwd)'),
  },
  wrap(dependencyGraphHandler),
);

// ---------------------------------------------------------------------------
// Context Fabric — Golden Replay Harness (M0)
// ---------------------------------------------------------------------------

server.tool(
  'workforce_replay_golden_set',
  'Run the Context Fabric golden replay set: load frozen task fixtures, score each (mergeEligible, reviewScore, tokensUsed, ralphWiggumIncidents), and emit a scorecard with optional delta vs a baseline. Each run is persisted to the replay_runs table. Used as the gate for every later Context Fabric milestone.',
  {
    golden_dir: z.string().optional().describe('Override fixture directory (absolute path or cwd-relative). Default: mcp-server/test/golden/'),
    baseline_json: z.string().optional().describe('Baseline scorecard path for delta reporting (absolute, or relative to golden_dir). Default: baseline.json inside golden_dir'),
    dry_run: z.boolean().optional().describe('Reserved for future re-execution mode; ignored in M0 (scoring is always pure)'),
    format: z.enum(['text', 'json']).optional().describe('Output format. Default: text'),
  },
  async (params) => {
    try {
      const result = await replayGoldenSetHandler(params);
      if (typeof result === 'string') {
        return { content: [{ type: 'text', text: result }] };
      }
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  },
);

// ---------------------------------------------------------------------------
// Context Fabric — Episodic Memory (M1)
// ---------------------------------------------------------------------------

server.tool(
  'workforce_capture_episode',
  'Capture a successful task trajectory as an episodic memory entry. Idempotent on (project, task_id). Called automatically by workforce_approve_task on merge; can also be invoked manually. Summarises prompt + diff via a small Haiku call; falls back to a placeholder approach summary if the CLI is unavailable.',
  {
    task_id: z.string().describe('Task ID to capture'),
    repo_root: z.string().optional().describe('Repo root for git diff; defaults to task.worktreePath or cwd'),
  },
  wrap(captureEpisodeHandler),
);

server.tool(
  'workforce_recall_episodes',
  'Recall up to N past similar successful episodes for an upcoming task. Ranks by keyword overlap on prompt_summary plus glob match on planned files; filters by trust_score >= 0.5 and within ttl_days. Used by worker layer 5b at spawn time.',
  {
    project: z.string().describe('Project name to scope the recall'),
    prompt: z.string().describe('Upcoming task prompt to match against past prompt summaries'),
    planned_files: z.array(z.string()).optional().describe('Files the upcoming task is expected to touch (used for glob match)'),
    max_n: z.number().optional().describe('Max episodes to return (default 3)'),
  },
  wrap(recallEpisodesHandler),
);

// ---------------------------------------------------------------------------
// Context Fabric — Memory MCP Tools (M5)
// ---------------------------------------------------------------------------

server.tool(
  'workforce_context_add',
  'Add a context item to the durable memory store. Caller is auto-tagged via WORKFORCE_AGENT_TASK_ID — agent writes are clamped at trust_score=0.4 (poisoning defense).',
  {
    project: z.string().describe('Project name'),
    memoryType: z.enum(['semantic', 'episodic', 'procedural', 'artifact', 'decision', 'risk', 'preference']).describe('Memory type per PRD §9.1'),
    title: z.string().describe('Short title for the memory'),
    content: z.string().describe('The memory body'),
    scopeType: z.enum(['project', 'task_group', 'task', 'agent', 'global']).describe('Scope of this memory'),
    scopeId: z.string().optional().describe('Scope identifier (task_id, group_id, etc.)'),
    paths: z.array(z.string()).optional().describe('Glob patterns for path-based retrieval'),
    tags: z.array(z.string()).optional().describe('Free-form tags'),
    trust: z.string().optional().describe('UX trust label (low/medium/high) — derived from trustScore if omitted'),
    trustScore: z.number().optional().describe('Numeric trust score 0–1 (clamped to source ceiling)'),
    ttlDays: z.number().optional().describe('Optional time-to-live in days'),
  },
  wrap(addContextItemHandler),
);

server.tool(
  'workforce_context_search',
  'Search durable context memory. Free-text query via FTS5 (or LIKE fallback); also filters by memoryType, paths, trust threshold. Defaults exclude invalidated rows.',
  {
    project: z.string().describe('Project name'),
    query: z.string().optional().describe('Free-text query; if omitted, returns project items by filter'),
    memoryType: z.enum(['semantic', 'episodic', 'procedural', 'artifact', 'decision', 'risk', 'preference']).optional().describe('Filter by memory type'),
    paths: z.array(z.string()).optional().describe('Filter by path overlap'),
    includeInvalidated: z.boolean().optional().describe('Include invalidated rows (default false)'),
    trustThreshold: z.number().optional().describe('Override default trust threshold (0.5)'),
    limit: z.number().optional().describe('Max items to return'),
  },
  wrap(searchContextItemsHandler),
);

server.tool(
  'workforce_context_preview',
  'Preview the context the assembler would inject for a task before launch. Returns {promptBlock, sections, audit}. Does NOT write an audit row (preview-only).',
  {
    project: z.string().describe('Project name'),
    prompt: z.string().describe('Task prompt to assemble context for'),
    taskType: z.enum(['standard', 'analysis', 'experiment', 'measurement']).optional().describe('Task type'),
    taskGroup: z.string().optional().describe('Task group ID for shared context'),
    dependsOn: z.array(z.string()).optional().describe('Upstream task IDs'),
    budget: z.number().optional().describe('Override default budget chars'),
    trustThreshold: z.number().optional().describe('Override default trust threshold'),
  },
  wrap(previewContextHandler),
);

server.tool(
  'workforce_context_audit',
  'Inspect the context audits for a past task — selected, omitted (with reason), conflicts, per-layer telemetry. Returns empty list for unknown tasks.',
  {
    taskId: z.string().describe('Task ID'),
  },
  wrap(auditContextHandler),
);

server.tool(
  'workforce_context_invalidate',
  'Mark a context item invalid (Mem0 ADD-only pattern). The row is preserved for audit; default search/list excludes it.',
  {
    id: z.string().describe('context_item id to invalidate'),
    reason: z.string().optional().describe('Why this is being invalidated'),
    invalidatedBy: z.string().optional().describe('Override the inferred caller (defaults to caller provenance)'),
  },
  wrap(invalidateContextHandler),
);

server.tool(
  'workforce_context_promote',
  'Propose a promotion of a context item to higher-trust storage (core_block | knowledge_rule | high_trust_memory). Intent-only in v3.6 per PRD §9.7 — returns the candidate; does NOT auto-apply. Caller must gate via AskUserQuestion.',
  {
    id: z.string().describe('source context_item id'),
    target: z.enum(['core_block', 'knowledge_rule', 'high_trust_memory']).describe('Promotion target'),
    label: z.string().optional().describe('Optional label override (defaults to source title)'),
    requiresApproval: z.boolean().optional().describe('Whether the apply step must be human-approved (default true)'),
  },
  wrap(promoteContextHandler),
);

server.tool(
  'workforce_context_compact',
  'Find near-duplicate context items (same title + content hash) and invalidate the duplicates. Preserves the canonical row (oldest by created_at; ties broken by highest trust). Never merges content. dryRun returns candidates without mutating.',
  {
    project: z.string().describe('Project name'),
    scopeType: z.enum(['project', 'task_group', 'task', 'agent', 'global']).optional().describe('Restrict to a scope type'),
    olderThanDays: z.number().optional().describe('Only compact items older than this many days'),
    memoryType: z.enum(['semantic', 'episodic', 'procedural', 'artifact', 'decision', 'risk', 'preference']).optional().describe('Restrict to a memory type'),
    dryRun: z.boolean().optional().describe('Preview candidates without invalidating (default false)'),
  },
  wrap(compactContextHandler),
);

// ---------------------------------------------------------------------------
// Context Fabric — Capture Pipeline (M7)
// ---------------------------------------------------------------------------

server.tool(
  'workforce_propose_rule_from_cluster',
  'Draft a proposed_rules row from an eval cluster (3+ similar failures). Manual MCP only — capture pipeline never auto-promotes clusters per PRD §9.7. cluster_id may be the deterministic cluster hash returned by detection or any one eval id that belongs to a cluster. Returns the inserted draft row, or null if no matching cluster exists.',
  {
    cluster_id: z.string().describe('Cluster id (category:hash) or any eval id from the cluster'),
    project: z.string().optional().describe('Project name to scope the proposed rule (default "_global")'),
  },
  wrap(({ cluster_id, project }) => {
    const row = proposeRuleFromEvalCluster(cluster_id, { project });
    return row ? row : { ok: false, reason: 'no matching cluster found' };
  }),
);

server.tool(
  'workforce_list_proposed_rules',
  'List proposed_rules queue entries (eval clusters, risk keyword hits, decision keyword hits, manual drafts). Filters by project + status; ORDER BY created_at DESC. M7 is write-only — the approval workflow is deferred to PRD §16 P3.1.',
  {
    project: z.string().optional().describe('Filter by project'),
    status: z.enum(['pending', 'approved', 'rejected', 'superseded']).optional().describe('Filter by status (default: any)'),
    limit: z.number().optional().describe('Max rows (default 50, max 500)'),
  },
  wrap(({ project, status, limit }) => {
    const rows = listProposedRules({ project, status, limit });
    return { count: rows.length, rows };
  }),
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
  setGraphProjectDir(projectDir);

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
