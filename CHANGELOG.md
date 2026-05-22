# Changelog

All notable changes to the Workforce plugin are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/).

## [3.7.0] - 2026-05-19

### Added

- **Autonomy mode** — opt-in autonomous overnight operation across four first-class modes:
  - `off` — normal human gates (default)
  - `shadow` — policy evaluates every approval and persists a verdict; never alters lifecycle. Safe to leave running for calibration.
  - `park` — policy acts on verdicts but never merges; parks decisions for the morning human pass.
  - `auto` — policy can auto-merge approved tasks, but only to per-run staging branch `autonomous/staging/<runId>`. Never touches `main`, `master`, `release/*`, or any user-configured protected branch.
- **Structured policy verdicts** with `policyVersion` + `configHash` on every decision. Checks include: `reviewScore`, `securityScore`, `blastRadius`, `protectedPaths`, `preMergeTests`, `freshness`, `budget`, `branch`, `knowledgeWrites`. Blast-radius classifier marks `auth`, `payments`, `migrations`, `ci`, `deps`, `public-api` as high-risk regardless of diff size.
- **Pre-merge verification** — autonomy runs the project test command inside the worktree before merging. Red parks the task; no merge churn.
- **Post-merge revert-on-failure** — captures `mergeSha`, runs the existing post-merge test pass, and on failure executes `git revert` with the correct mechanic (merge commit vs fast-forward). Revert conflicts halt the run and leave the branch untouched.
- **Freshness checks** — merge-base distance against configured maximum, dry-run conflict detection, upstream protected-file changes, reverted-dependency detection.
- **Run lease** — prevents two autonomy controllers running against the same repo. Force-takeover available with explicit flag.
- **Notification outbox** — synchronous writes to a `notification_outbox` table; async drain delivers to macOS `osascript`, Slack webhook, or `mail`/`mailx` with exponential backoff. Severity-tagged (`info`/`warning`/`critical`). Autonomy never blocks on a channel.
- **Knowledge-rule + high-trust write lockdown** — `workforce_create_rule` and `workforce_delete_rule` blocked at the MCP tool layer while autonomy is in `auto` or `park`. Proposed rules still allowed.
- **Halt semantics** — `WORKFORCE_AUTONOMY=halt` env kill switch + `workforce_autonomy_halt` tool, checked before every spawn and every merge. Mid-merge halt completes the in-flight verification/revert decision before stopping.
- **Recovery auto-handling** — under autonomy, Ralph Wiggum same-error 2x auto-switches to analysis mode; 3x kills + parks. No-progress >5min kills + parks. No `AskUserQuestion` prompts; everything routes to the outbox.
- **Concurrency override** — autonomy reduces max concurrent tasks (default 3) to bound overnight blast radius.
- 8 new MCP tools: `workforce_autonomy_start`, `_stop`, `_status`, `_heartbeat`, `_evaluate`, `_morning`, `_halt`, `_resume`.
- `/workforce-autonomy` skill — opt-in surface. `start <mode>` asks one confirmation with the full policy snapshot, then no further interactive prompts.
- 20 new tests (`mcp-server/test/autonomy.test.js`) — policy verdicts, controller lease, halt semantics, notifier outbox, staging branch.

### Changed

- `validateGates()` now accepts `autonomy_decision` as a substitute for `human_decision`, but only when `task.autonomyMode === 'auto'` AND the persisted verdict says `auto-approve`. Gate validation stays dumb — no policy re-evaluation. Real human approval remains semantically distinct in the event stream.
- `mergeWorktree` enforces the full configured protected-branch glob list under autonomy (defense in depth on top of the creation-time rewrite).
- `promotePending` checks autonomy halt + concurrency override before every promotion cycle.
- Schema bumped to migration 20; new tables `autonomy_runs` (lease + run snapshot) and `notification_outbox`; new task columns `autonomyMode`, `autonomyDecision`, `autonomyRunId`, `mergeSha`, `revertSha`, `revertedAt`, `parkedReason`.
- MCP tool count: 65 → 73.
- Skill count: 18 → 19 (added `/workforce-autonomy`).

### Safety notes

- Autonomy is opt-in and not enabled by default. Out-of-the-box behavior is unchanged.
- Per-run staging branches are non-negotiable for `auto` mode — protected branches are blocked at task creation, merge time, and revert time.
- Shadow mode is first-class — recommend running for at least a week before flipping to `park` or `auto` so the policy can be calibrated against your actual approval patterns.

## [3.6.0] - 2026-04-30

### Added
- Context Management Fabric — full context lifecycle pipeline shipped across 9 milestones (M0–M8):
  - **M0** Golden replay harness (`workforce_replay_golden_set`) for regression testing prompt assembly
  - **M1** Episodic capture + recall (`workforce_capture_episode`, `workforce_recall_episodes`) — `episodic_memory` table
  - **M2** Provenance + trust scoring on session_context and knowledge_rules
  - **M3** Full context schema — `context_items`, `context_blocks`, `task_context_audits`, `prompt_layers` tables
  - **M4** Context assembler — typed builder that composes prompt layers from context items with budgets and trust annotations
  - **M5** MCP tools surface (`workforce_context_add`, `_search`, `_preview`, `_promote`, `_invalidate`, `_compact`, `_audit`)
  - **M6** Worker integration via `WORKFORCE_CONTEXT_FABRIC_MODE` (off / shadow / analysis / all). Default `shadow` — fabric runs for telemetry only; the hardcoded 10-layer block remains the safety net.
  - **M7** Capture pipeline — auto-records failure episodes, decisions, and risks during task execution
  - **M8** Scratchpad + sub-agent trace handoff (`task_trace` BLOB column on tasks)
- `proposed_rules` table + `workforce_list_proposed_rules` and `workforce_propose_rule_from_cluster` tools — rule curation pipeline from eval clusters
- `/workforce-clean` skill — bulk cleanup of stuck, orphaned, and unrecoverable tasks with categorized preview before archive

### Changed
- Schema bumped to migration 19; 19 tables total (added `replay_runs`, `episodic_memory`, `context_items`, `context_blocks`, `task_context_audits`, `prompt_layers`, `proposed_rules`)
- MCP tool count: 53 → 65

## [3.5.0] - 2026-04-29

### Added
- Sequential-thinking reasoning sections added to 7 personas with depth gaps (CDO, CPLO, CEO, CMO, CCO, CLO, others)
- Audit-driven enhancement: 24 of 31 personas already had strong reasoning scaffolding; this targets the gaps without bloating files already at the gold standard

## [3.4.0] - 2026-04-28

### Added
- PMM mode in `/workforce-cmo` — six product-marketing actions: `messaging-house`, `launch-plan`, `battlecard`, `icp`, `win-loss`, `enablement`
- `pmm-strategist` agent for the heavier PMM artifacts
- PMM mode preserves C-suite naming while delivering distinct per-product GTM artifacts (vs CMO's brand/org-wide scope)

## [3.3.0] - 2026-04-28

### Added
- `/workforce-cco` (Chief Communications Officer) — technical writing, README, API reference, tutorials, changelog prose; `cco-writer` agent
- `/workforce-cmo` (Chief Marketing Officer) — positioning, launch posts, landing copy, release announcements, persona; `cmo-strategist` agent
- `/workforce-clo` (Chief Legal Officer) — license compliance, dependency audit, privacy/PII scan, contract redline, ToS implications; `clo-counsel` agent
- All three follow the existing CPO/CDO pattern: reasoning sections, anti-slop enforcement, AskUserQuestion gates
- All v2 command references migrated to v3 C-suite naming

## [3.2.1] - 2026-04-22

### Fixed
- Remote branch cleanup after merge in `cleanupWorktree` — orphaned remote refs no longer linger after task completion

## [3.2.0] - 2026-04-22

### Added
- Sequential thinking protocols injected into every spawned agent prompt — task-type-aware framework (standard: UNDERSTAND→LOCATE→ANALYZE→PLAN→EXECUTE→VERIFY; analysis: OBSERVE→HYPOTHESIZE→INVESTIGATE→SYNTHESIZE; experiment: BASELINE→HYPOTHESIZE→CHANGE→MEASURE→DECIDE)
- Retry reasoning protocol — when a task retries after failure, the previous error is injected with three forcing questions (catches Ralph Wiggum loops at the prompt level before recovery engine intervention)
- Completion checklist appended to standard tasks — self-review protocol covering hardcoded values, credentials, pattern adherence, test execution
- Agent-specific reasoning scaffolds for CPLO, CSO, CQO, CIO, CPO, CTO researcher
- Skill-level reasoning at decision points across CEO, CTO, COO, CDO, CQO, CAO

### Changed
- Context injection grew from 9 to 10 layers (added thinking protocol at layer 0)

## [3.1.0] - 2026-04-12

### Added
- Ralph Wiggum loop detection — recovery engine rules 6a/6b detect agents stuck in unproductive cycles:
  - **6a**: same error hash on 2+ consecutive retries → `loopDetected: same_error_Nx`, creates `ralph_wiggum_loop` eval, stops retrying
  - **6b**: running >5 min with no file changes → `loopDetected: no_progress_Nm`
- `workforce_loop_status` MCP tool — surface active loops, long-running tasks, summary counts
- AskUserQuestion gates at 7 critical decision points — merges, cost approvals, reviews; LLM cannot auto-decide
- `/workforce-cplo` (Chief Planning Officer) — full-stack implementation planning across 13 stack layers (infra, database, API, middleware, services, frontend, mobile, real-time, integrations)
- `cplo-architect` agent — auto-detects project stack, maps cross-layer impact, produces phased implementation plans
- C-suite skill breakdown — restructured all skills into 15 C-suite officer roles (CEO, COO, CTO, CFO, CPO, CIO, CSO, CRO, CAO, CQO, CDO, CPLO, CCO, CMO, CLO)
- Context Memory v2 — improved session continuity with active focus prioritization

### Changed
- Schema bumped through migration 13 (Ralph Wiggum loop detection fields: `loopDetected`, `lastErrorHash`)

## [1.4.0] - 2026-04-04

### Added
- Two-phase analyze-then-fix pattern — `task_type: "analysis"` for investigation-only tasks; output auto-injected into downstream fix tasks via dependency chain
- Tmux auth forwarding — sessions explicitly export `CLAUDE_*`, `ANTHROPIC_*`, `HOME`, `PATH` (tmux server inherits from creating client, not subsequent clients)

### Fixed
- Dependent tasks no longer fail on analysis task's nonexistent branch

## [1.3.0] - 2026-03-26

### Added
- Dual-mode cost tracking — `WORKFORCE_BILLING_MODE` env var (`subscription` or `api`) controls cost attribution model
- `workforce_version` MCP tool — runtime version check
- `/workforce-version` skill — slash menu access to version info
- `workforce_cleanup` tool + `/workforce-cleanup` skill (predecessor to `/workforce-clean`)

### Fixed
- Tmux session lingering after Claude exits
- Tmux prompt passing — write to temp file, pipe via stdin (avoids shell escaping issues)
- Zombie threshold raised to 60 minutes (was too aggressive)
- Default `MAX_CONCURRENT` lowered to 5 with 5s stagger between launches

## [1.2.1] - 2026-03-21

### Changed
- Codebase simplification — constants extraction, dedup, dead code removal

## [1.2.0] - 2026-03-20

### Added
- `/workforce-pipeline` skill — full orchestration: rubberduck → launch → test plan → QA → review → merge
- `/workforce-rubberduck` skill — prompt analysis, risk assessment, acceptance criteria
- `/workforce-test-plan` skill — structured test plan generation for tasks in review
- `/workforce-gate-status` skill — quality gate status reporting before approval
- `requirements-analyst` agent — deep-dive codebase analysis for complex task requirements
- `targetBranch` field on tasks — records the branch at creation time for correct merge target and diffs
- `rejected` terminal status — human rejections separated from runtime failures
- `reason` parameter on approve/reject tools — audit trail for decisions
- Cost policy enforcement in `createTaskHandler` — server-side gate, not just skill convention
- Reject rate and rejected count in health metrics

### Fixed
- QA dependency deadlock: `review` status now satisfies dependencies, allowing QA tasks to launch
- Approve handler returns structured result `{ ok, merged, error }` instead of unconditional `{ ok: true }`
- Merge uses recorded `targetBranch` instead of assuming current branch
- Diff compares against `targetBranch` instead of hardcoded `main`
- Merge safeguard blocks `main`/`master` as target (must use feature branch)
- Recovery engine skips `rejected` tasks
- Default task listing excludes `rejected` alongside `archived`

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
