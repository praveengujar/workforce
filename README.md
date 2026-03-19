# Workforce

A Claude Code plugin that turns Claude into a task orchestrator — spawning autonomous agent sessions in isolated git worktrees, managing their lifecycle, and merging results back to main.

## What it does

Workforce lets you run multiple Claude Code agents in parallel, each working on a separate task in its own git branch. You stay in your main Claude Code session while agents handle work autonomously in the background.

- **Spawn tasks**: Give an agent a prompt, it gets its own git worktree and runs independently
- **Review changes**: When an agent finishes, review its diff and approve or reject
- **Auto-recovery**: A recovery engine detects stuck tasks, ghost processes, and merge failures — fixes them automatically
- **Cost tracking**: Self-calibrating cost model estimates and tracks spend per task
- **Backlog management**: Maintain a prioritized queue of work items, launch them as agent tasks

## Install

```bash
claude --plugin-dir /path/to/workforce
```

Or for permanent installation:

```bash
claude plugin install /path/to/workforce --scope user
```

## Quick start

Once installed, use these slash commands inside Claude Code:

```
/workforce                          # Dashboard — see all running tasks, queue, costs
/workforce-launch "fix the login bug"   # Spawn an agent task
/workforce-review                   # Review completed task diffs, approve/reject
/workforce-backlog                  # Manage work items
/workforce-health                   # Performance metrics and cost tracking
/workforce-decompose "big task"     # Break complex work into subtasks
```

## How it works

### Task lifecycle

```
pending → running → review → merging → done
                      ↓                  ↓
                   rejected           archived
                      ↓
                   failed ← timeout / zero-work / crash
                      ↓
                   retry (up to 3x)
```

1. **Create**: You describe a task. Workforce creates a git worktree on a new branch (`wf/{task-id}`).
2. **Run**: Claude CLI runs in a tmux session (or child process) with your prompt, plus injected context (other running tasks, recent commits, project memory).
3. **Review**: When the agent finishes and files changed, the task enters review. You see the diff and approve or reject.
4. **Merge**: On approval, changes merge to main with a per-repo lock to prevent conflicts between concurrent tasks.
5. **Cleanup**: Worktree and branch are removed. Task auto-archives after 5 minutes.

### Recovery engine

Runs every 30 seconds, detecting and auto-repairing 6 failure patterns:

| Rule | Pattern | Action |
|------|---------|--------|
| 0a | Zombie — running with no session for >3 min | Mark failed |
| 0b | Stuck merge — mergeFailed but not resolved | Check git, auto-resolve or fail |
| 0c | Write-race — done but merge flag missing | Fix merge flag from git evidence |
| 1 | Ghost runner — PID no longer alive | Mark failed |
| 2-3 | Binary missing / hook blocked | Escalate, no retry |
| 4-5 | Stale session / rate limit | Auto-retry with 60s backoff |

### Cost model

Self-calibrating tier-based estimator:

| Tier | Base cost | Example prompts |
|------|-----------|-----------------|
| Simple | $0.05 | Fix typo, rename, add import |
| Medium | $0.25 | Add feature, implement, refactor |
| Complex | $0.50 | Everything else |

Tracks actual costs per tier. When the observed median drifts >15% from the estimate, the model recalibrates automatically.

## Architecture

```
├── .claude-plugin/plugin.json     # Plugin manifest
├── .mcp.json                      # MCP server config (stdio transport)
├── CLAUDE.md                      # Project instructions
├── README.md
├── mcp-server/
│   ├── index.js                   # Entry point — registers 20 MCP tools
│   ├── package.json               # Dependencies (@modelcontextprotocol/sdk)
│   ├── core/
│   │   ├── db.js                  # SQLite database (tasks, events, workers, claims)
│   │   ├── worker-manager.js      # Spawn workers, handle exit, merge, cleanup
│   │   ├── recovery-engine.js     # 6-rule self-healing scan (30s interval)
│   │   ├── cost-model.js          # Self-calibrating tier-based cost estimator
│   │   ├── task-events.js         # Lifecycle event logging
│   │   ├── project-state.js       # Cancellation tokens
│   │   ├── tmux.js                # Tmux session management
│   │   ├── task-cost.js           # Cost estimation with adjustments
│   │   └── profiles.js            # Agent profile management
│   ├── tools/
│   │   ├── task-tools.js          # Create, list, cancel, retry, archive, output, reply
│   │   ├── lifecycle-tools.js     # Diff, approve, reject
│   │   ├── backlog-tools.js       # CRUD + reorder
│   │   └── monitoring-tools.js    # Health metrics, cost summary, projects
│   └── config/
│       ├── defaults.json          # Tunable constants (timeouts, limits)
│       └── metrics-targets.json   # Health metric targets and warning thresholds
├── skills/
│   ├── workforce/SKILL.md         # Dashboard view
│   ├── workforce-launch/SKILL.md  # Task creation flow
│   ├── workforce-review/SKILL.md  # Diff review + approve/reject
│   ├── workforce-backlog/SKILL.md # Backlog management
│   ├── workforce-health/SKILL.md  # Health + cost metrics
│   └── workforce-decompose/SKILL.md  # Task decomposition
├── agents/
│   ├── task-planner.md            # Decomposes complex prompts into subtasks
│   └── backlog-analyst.md         # Prioritizes and stack-ranks backlog items
└── hooks/
    ├── hooks.json                 # SessionStart hook config
    └── startup.js                 # Prune worktrees, abort stale merges
```

## MCP tools reference

### Task management

| Tool | Description |
|------|-------------|
| `workforce_create_task` | Create a new task (prompt, project, profile, autoMerge) |
| `workforce_list_tasks` | List tasks with optional status filter |
| `workforce_get_task` | Get details for a specific task |
| `workforce_cancel_task` | Cancel a running task, kill process, cleanup |
| `workforce_retry_task` | Reset a failed task to pending |
| `workforce_archive_task` | Archive a completed task |
| `workforce_task_events` | Get full lifecycle timeline |
| `workforce_task_output` | Capture current output (tmux pane or log file) |
| `workforce_reply_to_task` | Send a message to a running interactive session |
| `workforce_pause_task` | Pause a running tmux task |
| `workforce_resume_task` | Resume a paused task |

### Change review

| Tool | Description |
|------|-------------|
| `workforce_get_diff` | Get git diff for a task branch vs main |
| `workforce_approve_task` | Approve and merge a reviewed task |
| `workforce_reject_task` | Reject and discard changes |

### Backlog

| Tool | Description |
|------|-------------|
| `workforce_backlog_list` | List all backlog items |
| `workforce_backlog_add` | Add a new backlog item |
| `workforce_backlog_update` | Update an existing item |
| `workforce_backlog_delete` | Remove an item |

### Monitoring

| Tool | Description |
|------|-------------|
| `workforce_health_metrics` | Success/failure/retry rates, suggestions |
| `workforce_cost_summary` | Cost breakdown by period and tier |

## Database

SQLite via Node.js built-in `node:sqlite` (DatabaseSync). Stored at the plugin's persistent data directory (`${CLAUDE_PLUGIN_DATA}/workforce.db`).

### Schema

**tasks** — Core task state (id, prompt, status, project, branch, worktreePath, pid, output, error, merged, cost, timestamps)

**task_events** — Append-only lifecycle log (taskId, phase, detail, timestamp)

**workers** — Active worker processes (taskId, pid, logPath)

**launch_claims** — Atomic task claiming to prevent double-launch

Auto-migrates from legacy `~/.claude/tasks/claude-agents.db` on first run.

## Configuration

Edit `mcp-server/config/defaults.json`:

```json
{
  "maxConcurrent": 10,
  "taskTimeoutMs": 600000,
  "stuckNudgeMs": 480000,
  "autoArchiveDelayMs": 300000,
  "recoveryIntervalMs": 30000,
  "promoteIntervalMs": 5000
}
```

## Requirements

- Node.js 22+ (for built-in `node:sqlite`)
- Git
- tmux (optional, recommended — enables interactive sessions and pause/resume)
- Claude CLI on PATH

## License

MIT
