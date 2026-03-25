# Workforce v2.0.0

Claude Code plugin for managing autonomous agent sessions with self-improving context management.

## Usage

```bash
claude --plugin-dir .   # Load this directory as a Claude Code plugin
```

## Stack

- **MCP server** (stdio) — 48 tools for task lifecycle, backlog, monitoring, context management
- **Skills** — `/workforce`, `/workforce-launch`, `/workforce-review`, `/workforce-backlog`, `/workforce-health`, `/workforce-decompose`, `/workforce-chain`, `/workforce-experiment`, `/workforce-rescue`, `/workforce-sprint`, `/workforce-release`, `/workforce-merge`, `/workforce-qa`, `/workforce-rubberduck`, `/workforce-test-plan`, `/workforce-pipeline`, `/workforce-gate-status`, `/workforce-cleanup`, `/workforce-version`, `/workforce-rules`, `/workforce-eval`, `/workforce-context`
- **Agents** — task-planner, backlog-analyst, experiment-researcher, failure-forensics, release-manager, qa-engineer, requirements-analyst, knowledge-curator
- **Database** — SQLite via `node:sqlite` (DatabaseSync), stored at plugin data dir
- **Dependency** — `@modelcontextprotocol/sdk`

## Architecture

- `.claude-plugin/plugin.json` — Plugin manifest
- `.mcp.json` — MCP server config
- `mcp-server/` — Node.js MCP server (stdio transport)
  - `core/` — DB, worker manager, recovery engine, cost model, tmux, profiles, knowledge rules, eval engine, session context, dependency graph cache
  - `tools/` — Task, lifecycle, backlog, monitoring, knowledge, eval, session, graph tool handlers
  - `config/` — Defaults, metrics targets
- `skills/` — 22 SKILL.md files (slash commands)
- `agents/` — 8 agent definitions
- `scripts/` — Version bump utility
- `hooks/` — SessionStart cleanup + SessionEnd eval analysis

## Task lifecycle

Each task spawns Claude CLI as a child process in an isolated git worktree (`wf/{id}` branch).

Phases: `pending → running → review → merging → done/failed`

- Up to 5 concurrent tasks (default, configurable via WORKFORCE_MAX_CONCURRENT)
- Auto-merge to target branch on success; manual review by default
- Watchdog kills any task running > 30 min (configurable via WORKFORCE_TASK_TIMEOUT)
- Zero-work guard: if Claude made no real code changes, task is marked `failed`
- Recovery engine detects 6 failure patterns every 30s, auto-creates eval entries
- 8 context injection layers: analysis prefix, running tasks, git log, project memory, feedback, upstream results, knowledge rules, session context

## Task types

- **standard** — Default. Spawns agent, expects code changes, zero-work guard active.
- **analysis** — Investigation-only. Skips zero-work guard, succeeds based on output. Full output injected into downstream fix tasks via dependency chain. Use for bugs about missing code, cross-cutting concerns, or runtime behavior.
- **experiment** / **measurement** — Iterative optimization tasks.

## Analyze-then-fix pattern

For complex bugs where autonomous agents fail (zero-work guard triggers because the bug is about what's *missing*, not what's *wrong*):

1. Phase 1: analysis task (`task_type: "analysis"`) investigates and reports findings
2. Phase 2+: targeted fix tasks depend on analysis, each addressing one finding
3. Analysis output flows automatically to fix tasks via dependency injection

Use `/workforce-decompose` to set this up — it detects when the pattern is appropriate.

## Tmux environment

Tmux sessions explicitly export auth-critical env vars (`CLAUDE_*`, `ANTHROPIC_*`, `HOME`, `PATH`) since tmux sessions inherit from the tmux server, not the creating client.

## Git conventions

- Per-repo merge lock serializes the merge step
- `git merge --no-ff` preserves branch history
- Worktree retry loop: 3 attempts at 600ms backoff
- `git worktree prune` on session startup
- Analysis task worktrees are cleaned up immediately (no branch to merge)
- Dependent tasks skip analysis branches when resolving base ref (fall back to HEAD)

## Context management (v2.0.0)

Three integrated systems that make agents domain experts and get smarter over time:

### Knowledge rules
Path-scoped domain knowledge injected into agent prompts. Rules have glob-pattern paths (e.g., `src/auth/**`), categories (standards, architecture, testing, security, workflow, patterns, custom), and priority (1-10). Two matching modes:
- **Path matching**: explicit file paths in prompts are matched against rule glob patterns
- **Keyword matching**: high-level prompts ("fix auth bug") match rules by category keywords

Managed via `/workforce-rules` or `workforce_create_rule` / `workforce_get_rules_for_path`.

### Eval feedback loop
Self-improving system. When tasks fail, the recovery engine and SessionEnd hook create structured eval entries. Processing an eval ALWAYS creates a preventive artifact:
- `rule_created` → creates a knowledge rule (from `preventiveUpdate` JSON or fallback to `correctApproach`)
- `memory_updated` → appends to feedback.jsonl with both problem and correction
- `dismissed` → marks as reviewed with no action

Three-output model: diagnostic (eval log) + preventive (rule) + quick-ref (feedback). Managed via `/workforce-eval` or the knowledge-curator agent.

### Session continuity
Persistent key-value store per project. Tracks active focus, known issues, investigation notes across sessions.

Injection priority: `active_focus` is always injected first at the top of `[Session Context]`, then remaining entries in recency order (most recently updated first). Entries are evicted whole (never mid-value truncated) when the 1500-char budget is reached.

Project defaults to `basename(cwd)` when not specified, ensuring session context is always available. Managed via `/workforce-context`.

### Trust hierarchy
Context injection annotates sources with trust levels:
- **HIGH**: Recent commits, test results
- **MEDIUM**: Knowledge rules
- **LOW**: Project memory (tail 2000 chars), session context, feedback (last 5 entries with corrections)

### Dependency graph
In-memory import graph built from `git ls-files` + regex parsing. Answers "what breaks if I change this file?" via `workforce_dependency_graph`. Used by pipeline pre-scan for impact analysis.

### Review scoring
Weighted multi-category scoring: Correctness (3x), Security (3x), Test coverage (2x), Code quality (2x), Rule compliance (2x), Scope (1x). Thresholds: >=65% approve, <50% reject.

### Context injection layers (8 total)
1. Analysis task prefix (investigation instructions for analysis tasks)
2. Running tasks on same project
3. Recent git log (5 commits) — Trust: HIGH
4. Project memory (.claude/project-memory.md, tail 2000 chars) — Trust: LOW
5. Feedback examples (last 5 from feedback.jsonl, with corrections) — Trust: LOW
6. Upstream task results + shared context (dependency injection)
7. Knowledge rules (path-matched or keyword-matched, priority-sorted, 3000 char cap) — Trust: MEDIUM
8. Session context (active_focus first, recency-ordered, whole-entry eviction, 1500 char cap) — Trust: LOW

## Rules

- Cross-platform code only — no hardcoded paths or usernames
- Credentials in env vars, never in code
- MCP server logs to stderr (stdout reserved for JSON-RPC)
