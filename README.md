# Workforce v2.0.0

A Claude Code plugin that turns Claude into a task orchestrator with self-improving AI context memory — spawning autonomous agent sessions in isolated git worktrees, injecting domain knowledge, learning from failures, and merging results back to the target branch.

## What it does

Workforce lets you run multiple Claude Code agents in parallel, each working on a separate task in its own git branch. Agents get domain-specific knowledge injected into their prompts, learn from past failures, and carry context across sessions.

- **Spawn tasks**: Give an agent a prompt, it gets its own git worktree and runs independently
- **Domain knowledge**: Path-scoped rules inject team standards and patterns into agent prompts automatically
- **Self-improving**: Failed tasks create eval entries that get processed into preventive knowledge rules
- **Session memory**: Active focus, known issues, and investigation notes persist across sessions
- **Review changes**: When an agent finishes, review its diff with weighted scoring and approve or reject
- **Auto-recovery**: Recovery engine detects stuck tasks, ghost processes, and merge failures — fixes them and logs evals
- **Cost tracking**: Self-calibrating cost model estimates and tracks spend per task
- **Backlog management**: Maintain a prioritized queue of work items, launch them as agent tasks

## Install

### From GitHub (recommended)

Add to your Claude Code settings (`~/.claude/settings.json`):

```json
{
  "extraKnownMarketplaces": {
    "workforce": {
      "source": "github",
      "repo": "praveengujar/workforce"
    }
  }
}
```

Then install:

```bash
claude plugin install workforce@workforce --scope user
```

### From local directory

```bash
claude --plugin-dir /path/to/workforce
```

### First-time setup

Dependencies install automatically on first session start via the SessionStart hook. If you need to install manually:

```bash
cd /path/to/workforce/mcp-server && npm install
```

## Quick start

Once installed, use these slash commands inside Claude Code:

```
/workforce                          # Dashboard — see all running tasks, queue, costs
/workforce-launch "fix the login bug"   # Spawn an agent task
/workforce-review                   # Review completed task diffs with scoring
/workforce-rules                    # Manage domain knowledge rules
/workforce-eval                     # Review failure evals, convert to rules
/workforce-context                  # View/update session context and focus
/workforce-backlog                  # Manage work items
/workforce-health                   # Performance metrics, cost tracking, eval stats
/workforce-decompose "big task"     # Break complex work into subtasks
/workforce-rescue                   # Diagnose and recover failed tasks
/workforce-pipeline "task"          # Full pipeline: pre-scan → rubberduck → code → QA → review → merge
/workforce-autoplan "task"          # Strict gated orchestrator: pre-scan → plan → code → QA → review → human gate → merge
/workforce-chain                    # Create sequential task chains
/workforce-experiment               # Run iterative optimization experiments
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

1. **Create**: You describe a task. Workforce creates a git worktree on a new branch (`wf/{task-id}`). Project defaults to cwd basename if not specified.
2. **Run**: Claude CLI runs in a tmux session (or child process) with your prompt, plus 8 layers of injected context (knowledge rules, session context, git history, project memory, feedback, upstream results).
3. **Review**: When the agent finishes and files changed, the task enters review. You see the diff with weighted scoring and approve or reject.
4. **Merge**: On approval, changes merge to the target branch with a per-repo lock to prevent conflicts between concurrent tasks.
5. **Cleanup**: Worktree and branch are removed. Task auto-archives after 5 minutes.

### Context injection (8 layers)

Every spawned agent receives a prompt enriched with up to 8 context layers:

| Layer | Source | Trust | Budget |
|-------|--------|-------|--------|
| Analysis prefix | Investigation instructions for analysis tasks | — | Unbounded |
| Running tasks | Other active tasks on same project | — | Unbounded |
| Git log | Last 5 commits | HIGH | Unbounded |
| Project memory | `.claude/project-memory.md` (tail) | LOW | 2000 chars |
| Feedback | Last 5 entries from feedback.jsonl (with corrections) | LOW | ~1KB |
| Upstream results | Dependency task outputs + shared context | — | 3000 chars |
| Knowledge rules | Path-matched or keyword-matched, priority-sorted | MEDIUM | 3000 chars |
| Session context | Active focus first, then recency-ordered entries | LOW | 1500 chars |

### Task types

| Type | Zero-work guard | Output | Use case |
|------|----------------|--------|----------|
| `standard` | Active — fails if no changes | Code changes | Default for all tasks |
| `analysis` | Skipped — succeeds on output | Findings report | Investigation, debugging, cross-cutting analysis |
| `experiment` | N/A | Iterative results | Optimization, parameter tuning |

### Analyze-then-fix

For complex bugs where agents struggle (missing symmetric logic, cache/state issues, absent code paths), use the two-phase pattern:

1. **Phase 1**: Analysis task (`task_type: "analysis"`) investigates and produces structured findings
2. **Phase 2+**: Targeted fix tasks depend on the analysis, each addressing one specific finding

The analysis task's full output is automatically injected into downstream fix tasks via the dependency chain. Use `/workforce-decompose` to set this up.

## AI context memory

### Knowledge rules

Encode team standards, architectural patterns, and institutional knowledge as path-scoped rules that get auto-injected into agent prompts.

```
/workforce-rules                    # Create, list, query by path, delete
```

Seed baseline reusable-library rules:

```bash
cd /path/to/workforce/mcp-server
node scripts/seed-reusable-library-rules.js --dry-run
node scripts/seed-reusable-library-rules.js --apply
```

Rules match in two ways:
- **Path matching**: Explicit file paths in prompts matched against glob patterns (e.g., `src/auth/**`)
- **Keyword matching**: High-level prompts ("fix auth bug") matched by category keywords (security, architecture, testing, etc.)

Categories: standards, architecture, testing, security, workflow, patterns, custom. Priority 1-10 (higher = injected first).

### Eval feedback loop

The system learns from every failure:

1. **Detection**: Recovery engine and SessionEnd hook auto-create eval entries when tasks fail
2. **Diagnosis**: Each eval captures: what happened, root cause, correct approach, preventive update
3. **Prevention**: Processing an eval creates a knowledge rule or feedback entry — always produces an artifact
4. **Curation**: The knowledge-curator agent batch-processes evals into clustered rules

```
/workforce-eval                     # Review and process failure evals
@knowledge-curator                  # Auto-curate evals into rules
```

### Session continuity

Persistent key-value context per project that survives across sessions:

```
/workforce-context                  # View, set focus, add notes, clear
```

- `active_focus` gets top-priority injection (always first in context block)
- Entries ordered by recency (most recently updated first)
- Whole-entry eviction at budget boundary (no mid-value truncation)
- Logged on session startup so you see where you left off

### Pipeline pre-scan

`/workforce-pipeline` runs a pre-scan before launching expensive agents:
1. Builds dependency graph from imports
2. Checks impact radius of affected files
3. Matches applicable knowledge rules
4. Flags risk level (LOW/MEDIUM/HIGH)
5. Recommends proceed or decompose

### Review scoring

`/workforce-review` produces a weighted score:

| Category | Weight |
|----------|--------|
| Correctness | 3x |
| Security | 3x |
| Test coverage | 2x |
| Code quality | 2x |
| Rule compliance | 2x |
| Scope | 1x |

Thresholds: >=65% recommend approve, <50% recommend reject. Security score of 0 overrides to reject.

### Recovery engine

Runs every 30 seconds, detecting and auto-repairing 6 failure patterns. Each detection also creates an eval entry for the feedback loop.

| Rule | Pattern | Action |
|------|---------|--------|
| 0a | Zombie — running with no session for >3 min | Mark failed + create eval |
| 0b | Stuck merge — mergeFailed but not resolved | Check git, auto-resolve or fail |
| 0c | Write-race — done but merge flag missing | Fix merge flag from git evidence |
| 1 | Ghost runner — PID no longer alive | Mark failed + create eval |
| 2-3 | Binary missing / hook blocked | Escalate, no retry |
| 4-5 | Stale session / rate limit | Auto-retry with 60s backoff + create eval |

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
├── .claude-plugin/plugin.json     # Plugin manifest (v2.0.0)
├── .mcp.json                      # MCP server config (stdio transport)
├── CLAUDE.md                      # Project instructions
├── README.md
├── mcp-server/
│   ├── index.js                   # Entry point — registers 48 MCP tools
│   ├── package.json               # Dependencies (@modelcontextprotocol/sdk)
│   ├── core/
│   │   ├── db.js                  # SQLite database (12 migrations, 12 tables)
│   │   ├── worker-manager.js      # Spawn workers, 8-layer context injection, merge, cleanup
│   │   ├── recovery-engine.js     # 6-rule self-healing scan + eval creation
│   │   ├── knowledge-rules.js     # Path-scoped rule engine with glob matching + keyword matching
│   │   ├── eval-engine.js         # Self-improving feedback loop (three-output model)
│   │   ├── session-context.js     # Cross-session persistent KV store
│   │   ├── dependency-graph-cache.js # Import graph builder + impact analysis
│   │   ├── cost-model.js          # Self-calibrating tier-based cost estimator
│   │   ├── cost-tracker.js        # Cost parsing and JSONL logging
│   │   ├── cost-watchdog.js       # Spend monitoring and task killing
│   │   ├── dependency-resolver.js # Topological sort, cycle detection, cascade failures
│   │   ├── experiment-runner.js   # Iterative optimization loop
│   │   ├── task-events.js         # Lifecycle event logging
│   │   ├── project-state.js       # Cancellation tokens
│   │   ├── tmux.js                # Tmux session management
│   │   ├── task-cost.js           # Cost estimation with retry adjustments
│   │   ├── constants.js           # Shared paths, helpers
│   │   └── profiles.js            # Agent profile management
│   ├── tools/
│   │   ├── task-tools.js          # Create, list, cancel, retry, archive, output, reply
│   │   ├── lifecycle-tools.js     # Diff, approve, reject
│   │   ├── backlog-tools.js       # CRUD + reorder
│   │   ├── monitoring-tools.js    # Health metrics, cost summary, eval stats
│   │   ├── knowledge-tools.js     # Knowledge rule CRUD + path query
│   │   ├── eval-tools.js          # Eval create, list, process
│   │   ├── session-tools.js       # Session context CRUD + active focus
│   │   ├── graph-tools.js         # Dependency graph build/query
│   │   ├── context-tools.js       # Shared context + dependency tree
│   │   ├── budget-tools.js        # Budget limits management
│   │   ├── experiment-tools.js    # Experiment lifecycle
│   │   ├── cost-approval.js       # Cost policy evaluation
│   │   ├── formatters.js          # Dashboard formatting with Unicode
│   │   └── sparkline.js           # Progress bar rendering
│   ├── config/
│   │   ├── defaults.json          # Tunable constants (timeouts, limits)
│   │   └── metrics-targets.json   # Health metric targets and warning thresholds
│   └── scripts/
│       └── seed-reusable-library-rules.js # Seed baseline reusable-library rules
├── skills/                        # 29 slash commands
│   ├── workforce/                 # Dashboard view
│   ├── workforce-launch/          # Task creation flow
│   ├── workforce-review/          # Diff review + weighted scoring
│   ├── workforce-rules/           # Knowledge rule management
│   ├── workforce-eval/            # Eval feedback loop
│   ├── workforce-context/         # Session context management
│   ├── workforce-backlog/         # Backlog management
│   ├── workforce-health/          # Health + cost + eval metrics
│   ├── workforce-decompose/       # Task decomposition + analyze-then-fix
│   ├── workforce-rescue/          # Diagnose and recover failed tasks
│   ├── workforce-chain/           # Sequential task chains
│   ├── workforce-experiment/      # Iterative optimization
│   ├── workforce-pipeline/        # Full pipeline with pre-scan
│   ├── workforce-sprint/          # Batch launch from backlog
│   ├── workforce-release/         # Release notes + changelog
│   ├── workforce-qa/              # E2E test generation
│   ├── workforce-merge/           # Conflict-aware merge
│   ├── workforce-rubberduck/      # Prompt refinement
│   ├── workforce-test-plan/       # Test plan generation
│   ├── workforce-gate-status/     # Quality gate status
│   ├── workforce-cleanup/         # Bulk cleanup
│   ├── workforce-careful/         # Safety guardrails for destructive commands
│   ├── workforce-cso/             # 14-phase security audit
│   ├── workforce-adversarial/     # Cross-model adversarial review
│   ├── workforce-retro/           # Engineering retrospective analytics
│   ├── workforce-design/          # Design system consultation
│   ├── workforce-design-shotgun/  # Rapid multi-direction design exploration
│   ├── workforce-autoplan/        # Strict gate-driven end-to-end orchestrator
│   └── workforce-version/         # Version info
├── agents/                        # 8 agent definitions
│   ├── task-planner.md            # Decomposes complex prompts into subtasks
│   ├── backlog-analyst.md         # Prioritizes and stack-ranks backlog items
│   ├── experiment-researcher.md   # Iterative code experiments
│   ├── failure-forensics.md       # Deep failure investigation + competing hypotheses
│   ├── release-manager.md         # Release preparation
│   ├── qa-engineer.md             # E2E test writing with Playwright
│   ├── requirements-analyst.md    # Deep-dive requirements + trust hierarchy + risk classification
│   └── knowledge-curator.md       # Eval → rule pipeline automation
├── scripts/
│   └── bump-version.js            # Version update utility
└── hooks/
    ├── hooks.json                 # SessionStart + SessionEnd hook config
    ├── startup.js                 # Prune worktrees, abort stale merges, log session context
    └── session-end.js             # Analyze recent failures, create eval entries
```

## MCP tools reference (48 tools)

### Task management (13)

| Tool | Description |
|------|-------------|
| `workforce_create_task` | Create a new task (prompt, project, autoMerge, task_type, depends_on, group, phase) |
| `workforce_list_tasks` | List tasks with optional status filter |
| `workforce_get_task` | Get details for a specific task |
| `workforce_cancel_task` | Cancel a running task, kill process, cleanup |
| `workforce_retry_task` | Reset a failed task to pending |
| `workforce_archive_task` | Archive a completed task |
| `workforce_cleanup` | Bulk cleanup old failed/rejected/stuck tasks |
| `workforce_task_events` | Get full lifecycle timeline |
| `workforce_task_output` | Capture current output (tmux pane or log file) |
| `workforce_reply_to_task` | Send a message to a running interactive session |
| `workforce_pause_task` | Pause a running tmux task |
| `workforce_resume_task` | Resume a paused task |
| `workforce_analyze_prompt` | Analyze prompt for complexity, tier, cost estimate |

### Change review (3)

| Tool | Description |
|------|-------------|
| `workforce_get_diff` | Get git diff for a task branch vs main |
| `workforce_approve_task` | Approve and merge a reviewed task |
| `workforce_reject_task` | Reject and discard changes |

### Backlog (5)

| Tool | Description |
|------|-------------|
| `workforce_backlog_list` | List all backlog items |
| `workforce_backlog_add` | Add a new backlog item |
| `workforce_backlog_update` | Update an existing item |
| `workforce_backlog_delete` | Remove an item |
| `workforce_backlog_reorder` | Reorder by ID array |

### Dependencies & context (4)

| Tool | Description |
|------|-------------|
| `workforce_task_dependencies` | View dependency resolution status |
| `workforce_write_context` | Write shared context for a task group |
| `workforce_read_context` | Read shared context for a task group |
| `workforce_group_status` | Status of all tasks in a group with dependency tree |

### Knowledge rules (4)

| Tool | Description |
|------|-------------|
| `workforce_create_rule` | Create a path-scoped knowledge rule (category, name, paths, content, priority) |
| `workforce_list_rules` | List rules, optionally filtered by category |
| `workforce_get_rules_for_path` | Get all rules matching given file paths (audit mapping) |
| `workforce_delete_rule` | Delete a rule by ID |

### Eval feedback loop (3)

| Tool | Description |
|------|-------------|
| `workforce_create_eval` | Create an eval entry for a task failure |
| `workforce_list_evals` | List evals with filters (task, category, unprocessed) |
| `workforce_process_eval` | Process eval into rule, memory update, or dismiss |

### Session context (2)

| Tool | Description |
|------|-------------|
| `workforce_session_context` | Read/write session context (get, set, list, clear) |
| `workforce_active_focus` | Get active focus and context summary for a project |

### Dependency graph (1)

| Tool | Description |
|------|-------------|
| `workforce_dependency_graph` | Build/query import graph (build, query_impact, query_dependencies, stats) |

### Monitoring & cost (8)

| Tool | Description |
|------|-------------|
| `workforce_health_metrics` | Success/failure/retry rates, eval stats, suggestions |
| `workforce_cost_summary` | Cost breakdown by period and tier |
| `workforce_cost_log` | Detailed cost log entries with date filtering |
| `workforce_cost_watchdog_scan` | Manual cost watchdog scan |
| `workforce_set_budget` | Set daily/weekly/monthly spending limits |
| `workforce_get_budget` | Get current budget and usage |
| `workforce_set_cost_policy` | Configure cost approval thresholds |
| `workforce_get_cost_policy` | Get current cost policy |

### Experiments (4)

| Tool | Description |
|------|-------------|
| `workforce_create_experiment` | Start an iterative optimization experiment |
| `workforce_experiment_status` | Get experiment progress and iteration history |
| `workforce_stop_experiment` | Stop a running experiment |
| `workforce_list_experiments` | List all experiments |

### Version (1)

| Tool | Description |
|------|-------------|
| `workforce_version` | Return plugin version |

## Database

SQLite via Node.js built-in `node:sqlite` (DatabaseSync). Stored at the plugin's persistent data directory (`${CLAUDE_PLUGIN_DATA}/workforce.db`).

### Schema (12 tables)

| Table | Purpose |
|-------|---------|
| **tasks** | Core task state (id, prompt, status, project, branch, worktreePath, pid, output, error, merged, cost, timestamps, taskType, dependsOn, taskGroup, phase) |
| **task_events** | Append-only lifecycle log (taskId, phase, detail, timestamp) |
| **workers** | Active worker processes (taskId, pid, logPath) |
| **launch_claims** | Atomic task claiming to prevent double-launch |
| **budgets** | Spending limits per scope (global or project) |
| **cost_history** | Actual costs with token counts and duration |
| **shared_context** | Task group coordination key-value store |
| **experiments** | Iterative experiment state and iteration history |
| **schema_migrations** | Migration version tracking |
| **knowledge_rules** | Path-scoped domain knowledge (category, name, paths, content, priority) |
| **eval_logs** | Failure evaluations (taskId, category, whatHappened, rootCause, correctApproach, preventiveUpdate, severity) |
| **session_context** | Cross-session persistent KV store (project, key, value) |

Auto-migrates from legacy `~/.claude/tasks/claude-agents.db` on first run. 12 migrations applied incrementally.

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

Environment variables:
- `WORKFORCE_MAX_CONCURRENT` — Parallel task limit (default: 5)
- `WORKFORCE_TASK_TIMEOUT` — Task timeout in ms (default: 600000)
- `WORKFORCE_DATA_DIR` — Database and log location (default: `~/.claude/tasks`)
- `WORKFORCE_BILLING_MODE` — "subscription" or "api" (affects cost tracking)

## Requirements

- Node.js 22+ (for built-in `node:sqlite`)
- Git
- tmux (optional, recommended — enables interactive sessions and pause/resume)
- Claude CLI on PATH

## License

MIT
