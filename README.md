# Workforce v3.6.0

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
- **Safety guardrails**: Intercept destructive commands (rm -rf, DROP TABLE, force push) in user and agent sessions
- **Security auditing**: 14-phase CSO audit (OWASP, STRIDE, secrets, supply chain, LLM threats) with confidence gating
- **Adversarial review**: Cross-model review (Claude + OpenAI Codex) with finding reconciliation and agreement analysis
- **Design system**: Generate complete design systems with anti-AI-slop enforcement and multi-variant exploration
- **Engineering retros**: Task performance analytics, failure pattern analysis, velocity metrics, and cost efficiency trends
- **Multi-perspective planning**: CEO strategy, design UX, and engineering architecture reviews before launching complex tasks
- **Full-stack planning**: Chief Planning Officer auto-detects 13 stack layers, maps cross-layer impact, generates phased implementation plans
- **Sequential thinking**: Every agent gets a task-type-aware reasoning protocol — structured thinking before acting, with retry reasoning and self-review checklists
- **Loop detection**: Ralph Wiggum detector catches agents stuck repeating the same failure or spinning with no progress
- **Structured human gates**: AskUserQuestion at 7 critical decision points prevents LLM auto-deciding on merges, costs, and reviews
- **Context Management Fabric**: Typed context items with provenance, trust scoring, episodic memory, and an assembler that composes prompt blocks under explicit token budgets — runs in shadow mode by default for telemetry

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
/workforce                              # Boardroom dashboard (alerts, tasks, health, cost)
/workforce-ceo "build feature X"        # CEO — strict gated orchestrator (plan → code → QA → review → merge)
/workforce-coo "fix the login bug"      # COO — launch task (also: chain, sprint, decompose)
/workforce-cto                          # CTO — code review with scoring (also: rubberduck, adversarial, merge, experiment)
/workforce-cfo                          # CFO — health metrics + cost (also: retro, budget)
/workforce-cpo                          # CPO — backlog management (also: release)
/workforce-cio                          # CIO — knowledge rules (also: eval, context)
/workforce-cso                          # CSO — 14-phase security audit
/workforce-cro                          # CRO — safety guardrails for destructive commands
/workforce-cao                          # CAO — diagnose + recover failed tasks (also: forensics, cleanup)
/workforce-cqo                          # CQO — E2E testing + test plans (also: gates)
/workforce-cdo                          # CDO — design system consultation (also: shotgun)
/workforce-cplo "add notifications"     # CPLO — full-stack implementation planning across all layers
/workforce-cco                          # CCO — technical writing (docs, README, API ref, tutorial, changelog prose)
/workforce-cmo                          # CMO + PMM mode — positioning, launch posts, messaging house, battlecards, ICP, win-loss
/workforce-clo                          # CLO — license compliance, dep audit, privacy scan, contract redline, ToS
/workforce-clean                        # Bulk cleanup of stuck, orphaned, and unrecoverable tasks
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
                   retry (up to 2x)
```

1. **Create**: You describe a task. Workforce creates a git worktree on a new branch (`wf/{task-id}`). Project defaults to cwd basename if not specified.
2. **Run**: Claude CLI runs in a tmux session (or child process) with your prompt, plus 10 layers of injected context (thinking protocol, knowledge rules, session context, git history, project memory, feedback, upstream results, completion checklist).
3. **Review**: When the agent finishes and files changed, the task enters review. You see the diff with weighted scoring and approve or reject.
4. **Merge**: On approval, changes merge to the target branch with a per-repo lock to prevent conflicts between concurrent tasks.
5. **Cleanup**: Worktree and branch are removed. Task auto-archives after 5 minutes.

### Context injection (10 layers)

Every spawned agent receives a prompt enriched with up to 10 context layers:

| Layer | Source | Trust | Budget |
|-------|--------|-------|--------|
| **Thinking protocol** | Task-type-aware reasoning framework + retry reasoning | — | ~200 tokens |
| Analysis prefix | Investigation instructions with confidence-ranked output (analysis tasks) | — | Unbounded |
| Running tasks | Other active tasks on same project | — | Unbounded |
| Git log | Last 5 commits | HIGH | Unbounded |
| Project memory | `.claude/project-memory.md` (tail) | LOW | 2000 chars |
| Feedback | Last 5 entries from feedback.jsonl (with corrections) | LOW | ~1KB |
| Upstream results | Dependency task outputs + shared context | — | 3000 chars |
| Knowledge rules | Path-matched or keyword-matched, priority-sorted | MEDIUM | 3000 chars |
| Session context | Active focus first, then recency-ordered entries | LOW | 1500 chars |
| **Completion checklist** | Self-review protocol (standard tasks only) | — | ~100 tokens |

### Task types

| Type | Zero-work guard | Output | Use case |
|------|----------------|--------|----------|
| `standard` | Active — fails if no changes | Code changes | Default for all tasks |
| `analysis` | Skipped — succeeds on output | Findings report | Investigation, debugging, cross-cutting analysis |
| `experiment` | N/A | Iterative results | Optimization, parameter tuning |

### Sequential thinking protocols

Every spawned agent receives a structured reasoning framework injected before its task prompt. The protocol varies by task type:

| Task Type | Protocol | Steps |
|-----------|----------|-------|
| `standard` | Code execution | UNDERSTAND → LOCATE → ANALYZE → PLAN → EXECUTE → VERIFY |
| `analysis` | Investigation | OBSERVE → HYPOTHESIZE → INVESTIGATE → SYNTHESIZE |
| `experiment` | Optimization | BASELINE → HYPOTHESIZE → CHANGE → MEASURE → DECIDE |

**Retry reasoning**: When a task retries after failure, the previous error is injected with three forcing questions (what went wrong, what to do differently, what another failure would prove). This prevents agents from repeating the same mistake — catching Ralph Wiggum loops at the prompt level before the recovery engine needs to intervene.

**Completion checklist**: Standard tasks get a self-review protocol appended: re-read modified files, check for hardcoded values/credentials, verify existing patterns are followed, run tests if available.

**Agent-specific reasoning scaffolds**: Beyond the universal protocol, individual agents have domain-specific thinking requirements:

| Agent | Reasoning Added |
|-------|----------------|
| CPLO architect | Pre-planning deliberation (change type, assumption inventory, alternative decompositions), per-phase dependency validation, plan self-review with pre-mortem |
| CSO auditor | Threat model construction (attacker profile, crown jewels, trust boundaries), finding validation with exploitability tracing |
| CQO engineer | Pre-test reasoning (user story, risk weight, boundary conditions), post-test self-review |
| CIO curator | Causal chain validation, specificity/counter-example tests before rule creation |
| CPO analyst | Per-item impact/urgency/effort reasoning before scoring |
| CTO researcher | Per-iteration hypothesis → result interpretation loop |

**Skill-level reasoning**: C-suite skills enforce structured thinking at key decision points:

| Skill | Decision Point | Reasoning |
|-------|---------------|-----------|
| CEO | Stage 0 (Pre-scan) | Blast radius and concurrent task risk assessment |
| CEO | Stage 1 (Rubberduck) | Ambiguity detection — 2 misinterpretation scenarios |
| CEO | Stage 5 (Review) | Arguments for AND against merging |
| CTO | Review scoring | Per-dimension evidence before each of 6 score categories |
| COO | Decompose | Boundary selection strategy, per-subtask isolation test |
| COO | Chain | Order validation, single point of failure analysis |
| CDO | Consult | Audience analysis, competitive differentiation, constraint reasoning |
| CDO | Shotgun | Diversity axes, per-variant rationale |
| CQO | Test plan | Regression risk mapping, test type decision per behavior |
| CAO | Rescue | Output-first diagnosis, systemic check, retry value reasoning |

### Analyze-then-fix

For complex bugs where agents struggle (missing symmetric logic, cache/state issues, absent code paths), use the two-phase pattern:

1. **Phase 1**: Analysis task (`task_type: "analysis"`) investigates and produces structured findings
2. **Phase 2+**: Targeted fix tasks depend on the analysis, each addressing one specific finding

The analysis task's full output is automatically injected into downstream fix tasks via the dependency chain. Use `/workforce-coo decompose` to set this up.

## AI context memory

### Knowledge rules

Encode team standards, architectural patterns, and institutional knowledge as path-scoped rules that get auto-injected into agent prompts.

```
/workforce-cio rules                # Create, list, query by path, delete
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
/workforce-cio eval                 # Review and process failure evals
@knowledge-curator                  # Auto-curate evals into rules
```

### Session continuity

Persistent key-value context per project that survives across sessions:

```
/workforce-cio context              # View, set focus, add notes, clear
```

- `active_focus` gets top-priority injection (always first in context block)
- Entries ordered by recency (most recently updated first)
- Whole-entry eviction at budget boundary (no mid-value truncation)
- Logged on session startup so you see where you left off

### Pipeline pre-scan

`/workforce-ceo pipeline` runs a pre-scan before launching expensive agents:
1. Builds dependency graph from imports
2. Checks impact radius of affected files
3. Matches applicable knowledge rules
4. Flags risk level (LOW/MEDIUM/HIGH)
5. Recommends proceed or decompose

### Review scoring

`/workforce-cto review` produces a weighted score:

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

Runs every 30 seconds, detecting and auto-repairing 8 failure patterns. Each detection also creates an eval entry for the feedback loop.

| Rule | Pattern | Action |
|------|---------|--------|
| 0a | Zombie — running with no session for >3 min | Mark failed + create eval |
| 0b | Stuck merge — mergeFailed but not resolved | Check git, auto-resolve or fail |
| 0c | Write-race — done but merge flag missing | Fix merge flag from git evidence |
| 1 | Ghost runner — PID no longer alive | Mark failed + create eval |
| 2-3 | Binary missing / hook blocked | Escalate, no retry |
| 4-5 | Stale session / rate limit | Auto-retry with 60s backoff + create eval |
| 6a | Ralph Wiggum — same error hash on 2+ retries | Flag loop, create eval, stop retrying |
| 6b | Ralph Wiggum — running >5 min with no file changes | Flag no-progress loop |

### Context Management Fabric

A typed context store with assembler, telemetry, and shadow-mode rollout. The hardcoded 10-layer block above always runs as a safety net; the fabric block is purely additive (prepended, never replacing).

| Mode | Behavior |
|------|----------|
| `off` | Assembler skipped entirely |
| `shadow` (default) | Assembler runs to write audit + per-layer telemetry; prompt unchanged |
| `analysis` | Assembler block injected only for `analysis` tasks |
| `all` | Assembler block injected for every task |

Resolution order: `WORKFORCE_CONTEXT_FABRIC_MODE` env var → `context.fabricMode` in `defaults.json` → fallback `shadow`. Unknown values warn to stderr and fall back to `shadow`. Assembler errors are isolated — a fabric failure never breaks a task spawn.

Manage context items via `workforce_context_*` tools (add, search, preview, promote, invalidate, compact, audit). Episodic memory (failure episodes, decisions, risks) feeds back into the assembler via `workforce_capture_episode` and `workforce_recall_episodes`.

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
├── .claude-plugin/plugin.json     # Plugin manifest (v3.6.0)
├── .mcp.json                      # MCP server config (stdio transport)
├── CLAUDE.md                      # Project instructions
├── README.md
├── mcp-server/
│   ├── index.js                   # Entry point — registers 65 MCP tools
│   ├── package.json               # Dependencies (@modelcontextprotocol/sdk)
│   ├── core/
│   │   ├── db.js                  # SQLite database (13 migrations, 12 tables)
│   │   ├── worker-manager.js      # Spawn workers, 10-layer context injection (incl. thinking protocol), merge, cleanup
│   │   ├── recovery-engine.js     # 8-rule self-healing scan + Ralph Wiggum loop detection + eval creation
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
├── skills/                        # 15 C-suite officer skills + 3 utility
│   ├── workforce/                 # Dashboard view
│   ├── workforce-clean/           # Bulk cleanup of stuck/orphaned/unrecoverable tasks
│   ├── workforce-version/         # Version info
│   ├── workforce-cao/             # CAO — rescue, forensics, cleanup
│   ├── workforce-cco/             # CCO — docs, README, API ref, tutorial, changelog prose
│   ├── workforce-cdo/             # CDO — design consultation, shotgun variants
│   ├── workforce-ceo/             # CEO — strict gated orchestrator + adaptive pipeline
│   ├── workforce-cfo/             # CFO — health, retro, budget
│   ├── workforce-cio/             # CIO — rules, eval, context
│   ├── workforce-clo/             # CLO — license, dep audit, privacy, contract redline, ToS
│   ├── workforce-cmo/             # CMO + PMM mode — positioning, launch, messaging house, ICP
│   ├── workforce-coo/             # COO — launch, chain, sprint, decompose
│   ├── workforce-cplo/            # CPLO — full-stack implementation planning
│   ├── workforce-cpo/             # CPO — backlog, release
│   ├── workforce-cqo/             # CQO — qa, testplan, gates
│   ├── workforce-cro/             # CRO — safety guardrails
│   ├── workforce-cso/             # CSO — 14-phase security audit
│   └── workforce-cto/             # CTO — review, rubberduck, adversarial, merge, experiment
├── agents/                        # 14 agent definitions (C-suite)
│   ├── coo-planner.md             # COO — decomposes complex tasks into subtasks
│   ├── cpo-analyst.md             # CPO — prioritizes and stack-ranks backlog
│   ├── cpo-release.md             # CPO — release preparation
│   ├── cto-analyst.md             # CTO — deep-dive requirements analysis
│   ├── cto-researcher.md          # CTO — iterative code experiments
│   ├── cao-forensics.md           # CAO — deep failure investigation
│   ├── cqo-engineer.md            # CQO — E2E test writing with Playwright
│   ├── cio-curator.md             # CIO — eval → rule pipeline automation
│   ├── cso-auditor.md             # CSO — security audit agent
│   ├── cplo-architect.md          # CPLO — full-stack planning architect
│   ├── cco-writer.md              # CCO — technical writing autonomous worker
│   ├── cmo-strategist.md          # CMO — brand/positioning autonomous worker
│   ├── clo-counsel.md             # CLO — legal review autonomous worker
│   └── pmm-strategist.md          # PMM — per-product GTM artifacts
├── scripts/
│   └── bump-version.js            # Version update utility
└── hooks/
    ├── hooks.json                 # SessionStart + SessionEnd hook config
    ├── startup.js                 # Prune worktrees, abort stale merges, log session context
    ├── session-end.js             # Analyze recent failures, create eval entries
    └── check-careful.sh           # PreToolUse hook — intercepts destructive commands
```

## MCP tools reference (65 tools)

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

### Knowledge rules (6)

| Tool | Description |
|------|-------------|
| `workforce_create_rule` | Create a path-scoped knowledge rule (category, name, paths, content, priority) |
| `workforce_list_rules` | List rules, optionally filtered by category |
| `workforce_get_rules_for_path` | Get all rules matching given file paths (audit mapping) |
| `workforce_delete_rule` | Delete a rule by ID |
| `workforce_list_proposed_rules` | List proposed rules from eval clusters awaiting review |
| `workforce_propose_rule_from_cluster` | Generate a rule proposal from a detected eval cluster |

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

### Episodic memory (2)

| Tool | Description |
|------|-------------|
| `workforce_capture_episode` | Capture an episode (failure, decision, risk) into episodic memory |
| `workforce_recall_episodes` | Recall episodes matching a query, ranked by recency and trust |

### Context Fabric (7)

| Tool | Description |
|------|-------------|
| `workforce_context_add` | Add a typed context item with provenance, trust, and optional expiry |
| `workforce_context_search` | Search context items by query, type, project, trust |
| `workforce_context_preview` | Preview the assembled context block for a task without spawning |
| `workforce_context_promote` | Promote a context item to a higher trust tier |
| `workforce_context_invalidate` | Mark a context item invalid (out-of-date or wrong) |
| `workforce_context_compact` | Compact stale or low-trust items to control token spend |
| `workforce_context_audit` | Per-task audit of which items were included or evicted |

### Replay harness (1)

| Tool | Description |
|------|-------------|
| `workforce_replay_golden_set` | Replay golden prompt assemblies for regression testing |

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

### Ops dashboard & routing (5)

| Tool | Description |
|------|-------------|
| `workforce_ops_metrics` | Gate pass/fail rates, merge-block reasons, post-merge results, eval clusters, rule quality |
| `workforce_route_task` | Capability router — recommend optimal skill path for a prompt based on intent/risk |
| `workforce_eval_clusters` | Detect clusters of similar unprocessed evals, suggest preventive rules |
| `workforce_rule_lint` | Quality checks on knowledge rules (wildcards, duplicates, short content) |
| `workforce_loop_status` | Ralph Wiggum loop detection — stuck tasks, identical errors, no-progress alerts |

### Version (1)

| Tool | Description |
|------|-------------|
| `workforce_version` | Return plugin version |

## Database

SQLite via Node.js built-in `node:sqlite` (DatabaseSync). Stored at the plugin's persistent data directory (`${CLAUDE_PLUGIN_DATA}/workforce.db`).

### Schema (19 tables, 19 migrations)

| Table | Purpose |
|-------|---------|
| **tasks** | Core task state (id, prompt, status, project, branch, worktreePath, pid, output, error, merged, cost, timestamps, taskType, dependsOn, taskGroup, phase, loopDetected, lastErrorHash, task_trace) |
| **task_events** | Append-only lifecycle log (taskId, phase, detail, timestamp) |
| **workers** | Active worker processes (taskId, pid, logPath) |
| **launch_claims** | Atomic task claiming to prevent double-launch |
| **budgets** | Spending limits per scope (global or project) |
| **cost_history** | Actual costs with token counts and duration |
| **shared_context** | Task group coordination key-value store |
| **experiments** | Iterative experiment state and iteration history |
| **schema_migrations** | Migration version tracking |
| **knowledge_rules** | Path-scoped domain knowledge with provenance + trust (category, name, paths, content, priority) |
| **eval_logs** | Failure evaluations (taskId, category, whatHappened, rootCause, correctApproach, preventiveUpdate, severity) |
| **session_context** | Cross-session persistent KV store with provenance + trust (project, key, value) |
| **replay_runs** | Golden replay harness state for regression testing prompt assembly |
| **episodic_memory** | Captured episodes (failures, decisions, risks) for recall during context assembly |
| **context_items** | Typed context items (typed payloads with provenance, trust, expiry) |
| **context_blocks** | Assembled prompt blocks composed from context items with budgets |
| **task_context_audits** | Per-task audit log of which context items were included or evicted |
| **prompt_layers** | Per-layer telemetry on token counts, eviction, and trust mix |
| **proposed_rules** | Rule curation pipeline — proposals from eval clusters awaiting review |

Auto-migrates from legacy `~/.claude/tasks/claude-agents.db` on first run. 19 migrations applied incrementally.

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
