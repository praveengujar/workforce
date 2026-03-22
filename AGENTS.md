# Workforce

Claude Code plugin for managing autonomous agent sessions.

## Usage

```bash
claude --plugin-dir .   # Load this directory as a Claude Code plugin
```

## Stack

- **MCP server** (stdio) — 36 tools for task lifecycle, backlog, monitoring, budgets, experiments, context
- **Skills** — 17 SKILL.md files (slash commands)
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
- `skills/` — 17 SKILL.md files (slash commands)
- `agents/` — 7 agent definitions
- `hooks/` — SessionStart cleanup

## Task lifecycle

Each task spawns Claude CLI as a child process in an isolated git worktree (`wf/{id}` branch).

Phases: `pending -> running -> review -> merging -> done/failed`

- Up to 10 concurrent tasks (hard cap)
- Auto-merge on success; manual review by default
- Watchdog kills any task running > 10 min
- Zero-work guard: if Claude made no real code changes, task is marked `failed`
- Recovery engine detects 6 failure patterns every 30s

## Git conventions

- Per-repo merge lock serializes the merge step
- `git merge --no-ff` preserves branch history
- Worktree retry loop: 3 attempts at 600ms backoff
- `git worktree prune` on session startup

## Rules

- Cross-platform code only — no hardcoded paths or usernames
- Credentials in env vars, never in code
- MCP server logs to stderr (stdout reserved for JSON-RPC)
