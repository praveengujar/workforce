# Workforce v1.4.0

Claude Code plugin for managing autonomous agent sessions.

## Usage

```bash
claude --plugin-dir .   # Load this directory as a Claude Code plugin
```

## Stack

- **MCP server** (stdio) — 36 tools for task lifecycle, backlog, monitoring
- **Skills** — `/workforce`, `/workforce-launch`, `/workforce-review`, `/workforce-backlog`, `/workforce-health`, `/workforce-decompose`, `/workforce-chain`, `/workforce-experiment`, `/workforce-rescue`, `/workforce-sprint`, `/workforce-release`, `/workforce-merge`, `/workforce-qa`, `/workforce-rubberduck`, `/workforce-test-plan`, `/workforce-pipeline`, `/workforce-gate-status`, `/workforce-cleanup`, `/workforce-version`
- **Agents** — task-planner, backlog-analyst, experiment-researcher, failure-forensics, release-manager, qa-engineer, requirements-analyst
- **Database** — SQLite via `node:sqlite` (DatabaseSync), stored at plugin data dir
- **Dependency** — `@modelcontextprotocol/sdk`

## Architecture

- `.claude-plugin/plugin.json` — Plugin manifest
- `.mcp.json` — MCP server config
- `mcp-server/` — Node.js MCP server (stdio transport)
  - `core/` — DB, worker manager, recovery engine, cost model, tmux, profiles
  - `tools/` — Task, lifecycle, backlog, monitoring tool handlers
  - `config/` — Defaults, metrics targets
- `skills/` — 19 SKILL.md files (slash commands)
- `agents/` — 7 agent definitions
- `scripts/` — Version bump utility
- `hooks/` — SessionStart cleanup

## Task lifecycle

Each task spawns Claude CLI as a child process in an isolated git worktree (`wf/{id}` branch).

Phases: `pending → running → review → merging → done/failed`

- Up to 5 concurrent tasks (default, configurable via WORKFORCE_MAX_CONCURRENT)
- Auto-merge to target branch on success; manual review by default
- Watchdog kills any task running > 30 min (configurable via WORKFORCE_TASK_TIMEOUT)
- Zero-work guard: if Claude made no real code changes, task is marked `failed`
- Recovery engine detects 6 failure patterns every 30s

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

## Rules

- Cross-platform code only — no hardcoded paths or usernames
- Credentials in env vars, never in code
- MCP server logs to stderr (stdout reserved for JSON-RPC)
