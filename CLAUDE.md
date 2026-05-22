# Workforce v3.7.0

Claude Code plugin for managing autonomous agent sessions with self-improving context management.

## Usage

```bash
claude --plugin-dir .   # Load this directory as a Claude Code plugin
```

## Stack

- **MCP server** (stdio) — 73 tools for task lifecycle, backlog, monitoring, context management, episodic memory, ops dashboard, loop detection, replay harness, autonomy
- **Skills** — 19 skills (15 C-suite officers + dashboard, queue janitor, version, autonomy) (see Skill Routing below)
- **Agents** — 14 definitions: coo-planner, cpo-analyst, cto-researcher, cao-forensics, cpo-release, cqo-engineer, cto-analyst, cio-curator, cso-auditor, cplo-architect, cco-writer, cmo-strategist, clo-counsel, pmm-strategist
- **Loop detection** — Ralph Wiggum detector catches agents stuck in unproductive cycles
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
- `skills/` — 19 SKILL.md files (C-suite officers + utilities)
- `agents/` — 14 agent definitions
- `hooks/` — SessionStart cleanup, SessionEnd eval analysis, PreToolUse safety guardrails

## Task lifecycle

Each task spawns Claude CLI as a child process in an isolated git worktree (`wf/{id}` branch). Worktrees auto-symlink `node_modules` and `.env` files from the main workspace.

Phases: `pending → running → review → merging → done/failed`

- Up to 5 concurrent tasks (configurable via WORKFORCE_MAX_CONCURRENT)
- Watchdog kills tasks running > 30 min (configurable via WORKFORCE_TASK_TIMEOUT)
- Zero-work guard: no real code changes → marked `failed`
- Recovery engine detects 9 failure patterns every 30s (including Ralph Wiggum loop detection and review-already-merged auto-resolve), auto-creates eval entries
- Post-merge verification: detects test command, runs after merge, logs pass/fail

## Task types

- **standard** — Default. Expects code changes, zero-work guard active.
- **analysis** — Investigation-only. Skips zero-work guard, output injected into downstream fix tasks.
- **experiment** / **measurement** — Iterative optimization tasks.

## Context injection (10 layers)

Every spawned agent receives enriched prompts with trust-annotated context:

0. **Sequential Thinking Protocol** — task-type-aware reasoning framework (standard: UNDERSTAND→LOCATE→ANALYZE→PLAN→EXECUTE→VERIFY; analysis: OBSERVE→HYPOTHESIZE→INVESTIGATE→SYNTHESIZE; experiment: BASELINE→HYPOTHESIZE→CHANGE→MEASURE→DECIDE). Retry reasoning injected on retries (prevents Ralph Wiggum loops at the prompt level).
1. Analysis task prefix — investigation instructions (analysis tasks only)
2. Running tasks on same project
3. Recent git log (5 commits) — Trust: HIGH
4. Project memory (.claude/project-memory.md, tail 2000 chars) — Trust: LOW
5. Feedback (last 5 from feedback.jsonl, with corrections) — Trust: LOW
6. Upstream task results + shared context (dependency injection)
7. Knowledge rules (path/keyword-matched, priority-sorted, 3000 char cap) — Trust: MEDIUM
8. Session context (active_focus first, recency-ordered, 1500 char cap) — Trust: LOW
9. **Completion Checklist** — self-review protocol before finishing (standard tasks only): verify changes serve the goal, check for hardcoded values/credentials, run tests if available, write result summary.

## Knowledge rules

Path-scoped domain knowledge injected into agent prompts. Glob-pattern paths, 7 categories (standards, architecture, testing, security, workflow, patterns, custom), priority 1-10. Global wildcard `['**/*']` rejected unless forced. Duplicate detection on create. Managed via `/workforce-cio`.

## Eval feedback loop

Self-improving: failed tasks → eval entries (with populated rootCause, correctApproach, preventiveUpdate) → preventive rules. Per-source dedup allows recovery-engine and session-end evals to coexist. Cluster detection groups 3+ similar failures with suggested rules. Managed via `/workforce-cio eval`.

## Session continuity

Persistent KV store per project. `active_focus` injected first, then recency-ordered entries with whole-entry eviction at 1500-char budget. Managed via `/workforce-cio context`.

## Review scoring

Weighted: Correctness (3x), Security (3x), Test coverage (2x), Code quality (2x), Rule compliance (2x), Scope (1x). Thresholds: >=65% approve, <50% reject. Security=0 overrides to reject.

## Gate enforcement

`workforce_approve_task` validates required gate evidence before merge. `human_decision` always required. Conditional gates (qa, security, adversarial) required if started. Waivers supported with auditable reason logging. All critical decision points use `AskUserQuestion` tool for structured human input — the LLM cannot auto-decide.

## Ralph Wiggum loop detection

Recovery engine Rules 6a/6b detect agents stuck in unproductive loops:
- **Rule 6a**: Same error hash on 2+ consecutive retries → `loopDetected: same_error_Nx`, creates `ralph_wiggum_loop` eval
- **Rule 6b**: Running >5 min with no file changes (git status) → `loopDetected: no_progress_Nm`
- Dashboard (`/workforce`) surfaces ⚠ alerts with `AskUserQuestion` escalation: Hint (inject guidance via tmux) / Analyze (switch to investigation) / Kill (rewrite prompt) / Continue
- `workforce_loop_status` MCP tool returns active loops, long-running tasks, summary counts

## Skill Routing (C-Suite)

| Skill | Officer | Default Action | All Actions |
|-------|---------|---------------|-------------|
| `/workforce` | Boardroom | dashboard | status |
| `/workforce-clean` | Queue Janitor | sweep | sweep (stuck + orphaned + unrecoverable bulk cleanup) |
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
| `/workforce-cplo` | Chief Planning Officer | plan | plan, scan, impact |
| `/workforce-cco` | Chief Communications Officer | docs | docs, readme, api-ref, tutorial, changelog-prose |
| `/workforce-cmo` | Chief Marketing Officer (+ PMM mode) | position | **CMO**: position, launch-post, landing-copy, release-announce, persona / **PMM**: messaging-house, launch-plan, battlecard, icp, win-loss, enablement |
| `/workforce-clo` | Chief Legal Officer | review | review, license-check, dep-audit, privacy-scan, contract-redline, tos-implication |
| `/workforce-autonomy` | Autonomy Officer | status | start &lt;mode&gt;, stop, status, morning, halt, resume, evaluate |

## Autonomy mode

Opt-in autonomous operation. Four first-class modes — `off` (default), `shadow` (logs verdicts only), `park` (decides but never merges), `auto` (merges to per-run staging branch). Resolution: `WORKFORCE_AUTONOMY` env (also accepts `halt` as kill switch) → active `autonomy_runs` row for the repo → `autonomy.mode` in `defaults.json` → fallback `off`. The controller (`core/autonomy-controller.js`) owns mode, lease, halt, budget cap, and concurrency override.

Policy verdicts (`core/autonomy-policy.js`) are pure given inputs and structured: every verdict carries `policyVersion` + `configHash` + per-check pass/fail. `validateGates()` stays dumb — it accepts `autonomy_decision` as a substitute for `human_decision` only when `task.autonomyMode === 'auto'` AND the persisted verdict says `auto-approve`. No re-evaluation.

Under `auto`: per-run staging branches (`autonomous/staging/<runId>`), pre-merge + post-merge verification, revert-on-failure with correct mechanic (merge commit vs ff), revert conflicts halt the run. Protected branches enforced at task creation, merge time, and revert time. Knowledge-rule promotion blocked at the MCP tool layer. Concurrency clamped (default 3). Recovery engine kills + parks Ralph Wiggum loops instead of paging humans. Notifications go to a persistent outbox (`notification_outbox`), drained async to macOS / Slack / email — autonomy never blocks on a channel.

## Context Fabric mode

`WORKFORCE_CONTEXT_FABRIC_MODE` controls Context Fabric (M6) worker integration. The hardcoded 10-layer block above always runs as a safety net; the fabric block is purely additive (PREPENDED, never replacing). Modes: **`off`** (assembler skipped entirely), **`shadow`** (default — assembler runs to write audit + per-layer telemetry, prompt unchanged), **`analysis`** (assembler block injected only for `analysis` tasks), **`all`** (assembler block injected for every task). Resolution: env var → `context.fabricMode` in `defaults.json` → fallback `shadow`. Unknown values warn to stderr and fall back to `shadow`. Assembler errors are isolated — a fabric failure never breaks a task spawn.

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
