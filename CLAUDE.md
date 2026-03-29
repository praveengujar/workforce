# Workforce v2.2.0

Claude Code plugin for managing autonomous agent sessions with self-improving context management.

## Usage

```bash
claude --plugin-dir .   # Load this directory as a Claude Code plugin
```

## Stack

- **MCP server** (stdio) — 52 tools for task lifecycle, backlog, monitoring, context management, ops dashboard
- **Skills** — 29 slash commands (see README.md for full list)
- **Agents** — 9 definitions: task-planner, backlog-analyst, experiment-researcher, failure-forensics, release-manager, qa-engineer, requirements-analyst, knowledge-curator, security-auditor
- **Database** — SQLite via `node:sqlite` (DatabaseSync), stored at plugin data dir
- **Dependency** — `@modelcontextprotocol/sdk`

## Architecture

- `.claude-plugin/plugin.json` — Plugin manifest
- `.mcp.json` — MCP server config
- `mcp-server/` — Node.js MCP server (stdio transport)
  - `core/` — DB, worker manager, recovery engine, cost model, tmux, profiles, knowledge rules, eval engine, session context, dependency graph cache
  - `tools/` — Task, lifecycle, backlog, monitoring, knowledge, eval, session, graph tool handlers
  - `config/` — Defaults, metrics targets
- `skills/` — 29 SKILL.md files (slash commands)
- `agents/` — 9 agent definitions
- `scripts/` — Version bump utility
- `mcp-server/scripts/` — Rule seeding and maintenance helpers
- `hooks/` — SessionStart cleanup, SessionEnd eval analysis, PreToolUse safety guardrails

## Task lifecycle

Each task spawns Claude CLI as a child process in an isolated git worktree (`wf/{id}` branch).

Phases: `pending → running → review → merging → done/failed`

- Up to 5 concurrent tasks (configurable via WORKFORCE_MAX_CONCURRENT)
- Watchdog kills tasks running > 30 min (configurable via WORKFORCE_TASK_TIMEOUT)
- Zero-work guard: no real code changes → marked `failed`
- Recovery engine detects 6 failure patterns every 30s, auto-creates eval entries

## Task types

- **standard** — Default. Expects code changes, zero-work guard active.
- **analysis** — Investigation-only. Skips zero-work guard, output injected into downstream fix tasks via dependency chain.
- **experiment** / **measurement** — Iterative optimization tasks.

## Context injection (8 layers)

Every spawned agent receives enriched prompts with trust-annotated context:

1. Analysis task prefix — investigation instructions (analysis tasks only)
2. Running tasks on same project
3. Recent git log (5 commits) — Trust: HIGH
4. Project memory (.claude/project-memory.md, tail 2000 chars) — Trust: LOW
5. Feedback (last 5 from feedback.jsonl, with corrections) — Trust: LOW
6. Upstream task results + shared context (dependency injection)
7. Knowledge rules (path/keyword-matched, priority-sorted, 3000 char cap) — Trust: MEDIUM
8. Session context (active_focus first, recency-ordered, 1500 char cap) — Trust: LOW

## Knowledge rules

Path-scoped domain knowledge injected into agent prompts. Glob-pattern paths, 7 categories (standards, architecture, testing, security, workflow, patterns, custom), priority 1-10. Two matching modes: path matching and keyword matching. Managed via `/workforce-rules`.

## Eval feedback loop

Self-improving: failed tasks → eval entries → preventive artifacts. Three-output model: diagnostic (eval log) + preventive (rule or feedback) + quick-ref. Managed via `/workforce-eval` (individual) or knowledge-curator agent (batch).

## Session continuity

Persistent KV store per project. `active_focus` injected first, then recency-ordered entries with whole-entry eviction at 1500-char budget. Managed via `/workforce-context`.

## Review scoring

Weighted: Correctness (3x), Security (3x), Test coverage (2x), Code quality (2x), Rule compliance (2x), Scope (1x). Thresholds: >=65% approve, <50% reject. Security=0 overrides to reject.

## Tmux environment

Tmux sessions explicitly export auth-critical env vars (`CLAUDE_*`, `ANTHROPIC_*`, `HOME`, `PATH`) since tmux sessions inherit from the tmux server, not the creating client.

## Git conventions

- Per-repo merge lock serializes the merge step
- `git merge --no-ff` preserves branch history
- Worktree retry loop: 3 attempts at 600ms backoff
- `git worktree prune` on session startup
- Analysis task worktrees are cleaned up immediately (no branch to merge)

## Skill routing

| Goal | Skill |
|------|-------|
| Quick task | `/workforce-launch` |
| Refine prompt first | `/workforce-rubberduck` → `/workforce-launch` |
| Full quality pipeline | `/workforce-autoplan` (strict gates, never auto-merges) |
| Lightweight pipeline | `/workforce-pipeline` (adaptive, skips stages for simple tasks) |
| Security audit | `/workforce-cso` (interactive) or security-auditor agent (autonomous) |
| Cross-model review | `/workforce-adversarial` (Claude + Codex, or dual-Claude fallback) |
| Design system | `/workforce-design` → `/workforce-design-shotgun` for variants |
| Failure analysis | `/workforce-rescue` (individual) → `/workforce-retro` (systemic) |
| Safety mode | `/workforce-careful` (destructive command interception) |

## Rules

- Cross-platform code only — no hardcoded paths or usernames
- Credentials in env vars, never in code
- MCP server logs to stderr (stdout reserved for JSON-RPC)
