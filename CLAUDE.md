# Workforce v3.0.0

Claude Code plugin for managing autonomous agent sessions with self-improving context management.

## Usage

```bash
claude --plugin-dir .   # Load this directory as a Claude Code plugin
```

## Stack

- **MCP server** (stdio) — 52 tools for task lifecycle, backlog, monitoring, context management, ops dashboard
- **Skills** — 13 C-suite officer skills (see Skill Routing below)
- **Agents** — 9 definitions: coo-planner, cpo-analyst, cto-researcher, cao-forensics, cpo-release, cqo-engineer, cto-analyst, cio-curator, cso-auditor
- **Database** — SQLite via `node:sqlite` (DatabaseSync), stored at plugin data dir
- **Dependency** — `@modelcontextprotocol/sdk`

## Architecture

- `.claude-plugin/plugin.json` — Plugin manifest
- `.mcp.json` — MCP server config
- `mcp-server/` — Node.js MCP server (stdio transport)
  - `core/` — DB, worker manager, recovery engine, cost model, tmux, profiles, knowledge rules, eval engine, session context, dependency graph cache, capability router
  - `tools/` — Task, lifecycle, backlog, monitoring, knowledge, eval, session, graph tool handlers
  - `config/` — Defaults, metrics targets
  - `test/` — node:test smoke tests (lifecycle, recovery, eval, deps, router)
- `skills/` — 13 SKILL.md files (C-suite officers)
- `agents/` — 9 agent definitions
- `hooks/` — SessionStart cleanup, SessionEnd eval analysis, PreToolUse safety guardrails

## Task lifecycle

Each task spawns Claude CLI as a child process in an isolated git worktree (`wf/{id}` branch). Worktrees auto-symlink `node_modules` and `.env` files from the main workspace.

Phases: `pending → running → review → merging → done/failed`

- Up to 5 concurrent tasks (configurable via WORKFORCE_MAX_CONCURRENT)
- Watchdog kills tasks running > 30 min (configurable via WORKFORCE_TASK_TIMEOUT)
- Zero-work guard: no real code changes → marked `failed`
- Recovery engine detects 6 failure patterns every 30s, auto-creates eval entries
- Post-merge verification: detects test command, runs after merge, logs pass/fail

## Task types

- **standard** — Default. Expects code changes, zero-work guard active.
- **analysis** — Investigation-only. Skips zero-work guard, output injected into downstream fix tasks.
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

Path-scoped domain knowledge injected into agent prompts. Glob-pattern paths, 7 categories (standards, architecture, testing, security, workflow, patterns, custom), priority 1-10. Global wildcard `['**/*']` rejected unless forced. Duplicate detection on create. Managed via `/workforce-cio`.

## Eval feedback loop

Self-improving: failed tasks → eval entries (with populated rootCause, correctApproach, preventiveUpdate) → preventive rules. Per-source dedup allows recovery-engine and session-end evals to coexist. Cluster detection groups 3+ similar failures with suggested rules. Managed via `/workforce-cio eval`.

## Session continuity

Persistent KV store per project. `active_focus` injected first, then recency-ordered entries with whole-entry eviction at 1500-char budget. Managed via `/workforce-cio context`.

## Review scoring

Weighted: Correctness (3x), Security (3x), Test coverage (2x), Code quality (2x), Rule compliance (2x), Scope (1x). Thresholds: >=65% approve, <50% reject. Security=0 overrides to reject.

## Gate enforcement

`workforce_approve_task` validates required gate evidence before merge. `human_decision` always required. Conditional gates (qa, security, adversarial) required if started. Waivers supported with auditable reason logging.

## Skill Routing (C-Suite)

| Skill | Officer | Default Action | All Actions |
|-------|---------|---------------|-------------|
| `/workforce` | Boardroom | dashboard | status |
| `/workforce-ceo` | Chief Executive Officer | plan | plan, pipeline |
| `/workforce-coo` | Chief Operating Officer | launch | launch, chain, sprint, decompose |
| `/workforce-cto` | Chief Technology Officer | review | review, rubberduck, adversarial, merge, experiment |
| `/workforce-cfo` | Chief Financial Officer | health | health, retro, budget |
| `/workforce-cpo` | Chief Product Officer | backlog | backlog, release |
| `/workforce-cio` | Chief Information Officer | rules | rules, eval, context |
| `/workforce-cso` | Chief Security Officer | audit | audit, scan |
| `/workforce-cro` | Chief Risk Officer | careful | careful |
| `/workforce-cao` | Chief Audit Officer | rescue | rescue, forensics, cleanup |
| `/workforce-cqo` | Chief Quality Officer | qa | qa, testplan, gates |
| `/workforce-cdo` | Chief Design Officer | consult | consult, shotgun |

## Tmux environment

Tmux sessions explicitly export auth-critical env vars (`CLAUDE_*`, `ANTHROPIC_*`, `HOME`, `PATH`) since tmux sessions inherit from the tmux server, not the creating client.

## Git conventions

- Per-repo merge lock serializes the merge step
- `git merge --no-ff` preserves branch history
- Worktree retry loop: 3 attempts at 600ms backoff
- `git worktree prune` on session startup
- Analysis task worktrees are cleaned up immediately (no branch to merge)

## Rules

- Cross-platform code only — no hardcoded paths or usernames
- Credentials in env vars, never in code
- MCP server logs to stderr (stdout reserved for JSON-RPC)
