# Workforce v2.0.0

Claude Code plugin for managing autonomous agent sessions with self-improving context management.

## Usage

```bash
claude --plugin-dir .   # Load this directory as a Claude Code plugin
```

## Stack

- **MCP server** (stdio) — 48 tools for task lifecycle, backlog, monitoring, context management
- **Skills** — `/workforce`, `/workforce-launch`, `/workforce-review`, `/workforce-backlog`, `/workforce-health`, `/workforce-decompose`, `/workforce-chain`, `/workforce-experiment`, `/workforce-rescue`, `/workforce-sprint`, `/workforce-release`, `/workforce-merge`, `/workforce-qa`, `/workforce-rubberduck`, `/workforce-test-plan`, `/workforce-pipeline`, `/workforce-gate-status`, `/workforce-cleanup`, `/workforce-version`, `/workforce-rules`, `/workforce-eval`, `/workforce-context`, `/workforce-careful`, `/workforce-cso`, `/workforce-adversarial`, `/workforce-retro`, `/workforce-design`, `/workforce-design-shotgun`, `/workforce-autoplan`
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
- `skills/` — 29 SKILL.md files (slash commands)
- `agents/` — 8 agent definitions
- `scripts/` — Version bump utility
- `mcp-server/scripts/` — Rule seeding and maintenance helpers
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

## Safety guardrails (v2.1.0)

`/workforce-careful` activates destructive command interception for both user sessions and spawned agents:
- PreToolUse hook (`hooks/check-careful.sh`) intercepts: rm -rf, DROP TABLE, git push --force, git reset --hard, kubectl delete, docker rm -f
- Safe exceptions: node_modules, dist, build, coverage, .cache (build artifacts)
- Session context `careful_mode: active` injects safety preamble into all spawned task prompts
- Workflow safety tool, not a security boundary — prevents accidental damage

## Security auditing (v2.1.0)

`/workforce-cso` runs a 14-phase security audit (adapted from gstack):
1. Stack detection → Attack surface → Secrets archaeology → Supply chain → CI/CD → Infrastructure → Webhooks → LLM/AI → Skills → OWASP Top 10 → STRIDE → Data classification → False-positive filtering → Report
2. Confidence gating: standard (8/10) or comprehensive (2/10)
3. Task mode audits only the task diff; full mode audits entire codebase
4. Integrates with pipeline: CRITICAL findings block merge, HIGH findings warn
5. `security-auditor` agent profile for autonomous deep audits

## Cross-model adversarial review (v2.1.0)

`/workforce-adversarial` runs independent parallel reviews (Claude + OpenAI Codex):
- Auto-scales by diff size: small (single), medium (dual), large (triple voice)
- Reconciles findings: consensus, Claude-only, Codex-only, agreement rate, tension points
- Falls back to dual-Claude mode if Codex CLI unavailable
- Integrates with pipeline between QA and human review stages

## Engineering retrospective (v2.1.0)

`/workforce-retro` analyzes agent task performance and shipping velocity:
- Task metrics (success rate, duration, cost efficiency) + git metrics (commits, LOC, test ratio)
- Failure pattern analysis from eval logs
- Compare mode for period-over-period trends
- Anchored praise and improvement suggestions (specific to tasks/commits, never generic)
- `/workforce-rescue` now includes a mini-retro on failure patterns with systemic issue detection

## Design system (v2.1.0)

`/workforce-design` generates complete design systems (typography, color, spacing, layout, motion):
- Writes DESIGN.md as source of truth with full token definitions
- Anti-slop enforcement: blacklists AI-generated patterns (purple gradients, 3-column icon grids, centered everything)
- Creates knowledge rules for UI files to enforce design tokens in agent tasks

`/workforce-design-shotgun` generates 3-8 design variants for comparison:
- Parallel variant generation via independent Agent subagents
- Taste memory from prior approved designs biases future generation
- Structured feedback loop with iteration support
- Anti-slop checked on every variant before presentation

## Multi-perspective planning (v2.1.0)

`/workforce-autoplan` is a strict gate-driven orchestrator for end-to-end delivery:
- Stages: pre-scan → rubberduck → test plan → code loop → QA → review → human decision → merge
- Never skips human decision gate, never auto-merges
- Every gate produces evidence artifacts in the status card

`/workforce-rubberduck` enhanced with multi-perspective analysis:
- Strategy (CEO): premise challenge, scope management, alternatives
- Design (UX): interaction states, responsive, AI slop risk (skipped for backend tasks)
- Engineering: always runs — scope, ambiguity, risk, acceptance criteria
- Quick mode: `/workforce-rubberduck quick` for engineering-only rapid refinement

## Rules

- Cross-platform code only — no hardcoded paths or usernames
- Credentials in env vars, never in code
- MCP server logs to stderr (stdout reserved for JSON-RPC)
