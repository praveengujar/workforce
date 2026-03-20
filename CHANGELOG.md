# Changelog

All notable changes to the Workforce plugin are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/).

## [1.1.0] - 2026-03-20

### Added
- `/workforce-rescue` skill — diagnose and recover failed tasks
- `/workforce-sprint` skill — batch-launch backlog items as phased chains
- `/workforce-release` skill — generate changelogs and tag releases
- `/workforce-merge` skill — pre-merge conflict scanning and guided merges
- `/workforce-qa` skill — E2E test generation and execution via Playwright for tasks in review
- `failure-forensics` agent — deep-dive investigation of complex failures
- `release-manager` agent — autonomous release preparation
- `qa-engineer` agent — writes and runs Playwright E2E tests for web/mobile UI changes
- Playwright MCP server (`@playwright/mcp`) bundled for interactive browser testing (headless)
- Interactive QA mode in `/workforce-qa` — use `browser_navigate`, `browser_snapshot`, `browser_click` etc. directly
- `workforce_analyze_prompt` tool registered (was implemented but unregistered)
- `workforce_backlog_reorder` tool registered (was implemented but unregistered)
- `depends_on`, `group`, `phase`, `parent_id` params in `workforce_create_task` schema
- Retry backoff with `retryAfter` timestamp (migration 6)
- `scripts/bump-version.js` for consistent version bumping
- Plugin versioning across plugin.json, package.json, and index.js

### Fixed
- Recovery engine zombie rule no longer kills healthy tmux/child_process tasks (checked sessionId, tmuxSession, and pid)
- Tmux exit handler idempotency guard prevents double lifecycle processing
- `promotePending` reentrance guard prevents concurrent over-spawning
- Worktree cleanup on spawn failure (tmux and child_process paths)
- Merge safeguard: refuses to merge into main/master (must be on a feature branch)
- Paused tasks count toward capacity to prevent oversubscription
- Graceful shutdown kills running tasks instead of orphaning processes
- `WORKFORCE_MAX_CONCURRENT` and `WORKFORCE_TASK_TIMEOUT` env vars now honored
- `setBudgetHandler` call signature matches `db.setBudget`
- Sparkline `costTrendLine` reads `d.cost` instead of `d.total`
- Commit messages include task prompt instead of generic "Task work"

### Changed
- Plugin `agents` field uses explicit file array instead of directory path
- `hooks` field removed from plugin.json (auto-loads from standard path)
- Tool count updated to 36 across README, CLAUDE.md, and index.js comment

## [1.0.0] - 2026-03-19

### Added
- Initial release: MCP server with task lifecycle, backlog, monitoring
- 8 skills, 3 agents, SQLite database
- Git worktree isolation, dependency graph, cost tracking
- Recovery engine with 6 failure detection rules
- Experiment runner for iterative optimization
