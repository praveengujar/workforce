# PRD: Workforce Context Management Fabric

**Created**: 2026-04-29
**Last strengthened**: 2026-04-29 (v2 — research-grounded)
**Status**: Draft
**Owner**: Workforce CIO / CTO
**Target Release**: v3.6 foundational, v3.7 default-on refinement
**Companion research**: [`docs/CONTEXT_MANAGEMENT_PLAN.md`](../docs/CONTEXT_MANAGEMENT_PLAN.md)

## 0. Executive Summary

Five bullets for an exec deciding whether to fund this:

1. **Workforce already has the plumbing** of a context-engineering platform (10-layer prompt injection, knowledge rules, eval feedback loop, session KV, trust labels, isolated worktrees, dependency-graph context). What it lacks is the **memory operations layer**: episodic capture from *successes*, just-in-time retrieval, file-system offload, provenance/freshness governance, and a real eval harness.
2. **Highest-ROI single change**: capture episodic memory from *successful* merges (today only failures feed back via `eval_logs`). LangMem, Mem0, and Letta all treat past trajectories as the highest-signal tier. We already produce the raw material — diff, prompt, outcome — and discard it.
3. **Biggest architectural shift**: move layers 3 (git log), 7 (knowledge rules), and 8 (session context) from upfront stuffing to **just-in-time retrieval**. Anthropic's Sept 2025 guidance is explicit on this — load on demand via tool calls, don't pack everything at spawn. Today Workforce stuffs ~3000+1500 chars regardless of relevance.
4. **Biggest defense gap**: memory poisoning (MINJA, MemoryGraft, InjecMEM — all demonstrated in 2025). `workforce_write_context` and `workforce_create_rule` accept agent-authored writes with no provenance, no per-source trust, and no decay. Fix before scaling autonomy.
5. **Two explicit anti-recommendations** (formerly fuzzy non-goals): do **not** build a Zep/Graphiti-style temporal knowledge graph (git already is one), and do **not** add vector embeddings to SQLite (path-glob + keyword is sufficient at Workforce's scale). Reasoning in §6.

**Top 3 to build first** (ranked by ROI; details in §17): episodic memory capture, provenance+trust on writes, eval harness (golden replay set). The eval harness gates everything in Phase 2/3.

## 1. Summary

Workforce already has the beginnings of a context system: session context, project memory, shared task-group context, knowledge rules, dependency outputs, eval logs, and prompt injection. The next product step is to turn those pieces into a default-on Context Management Fabric that automatically captures, retrieves, ranks, injects, audits, and improves agent context across all Workforce usage.

The goal is to make every Workforce task start with the right working memory by default: relevant project state, prior decisions, learned failure prevention, dependency outputs, known risks, applicable rules, and **few-shot examples from past similar successes**. Users should not have to manually remember what to paste into prompts, and agents should not rediscover the same facts across sessions.

This feature is implemented as an **overlay** on the current architecture, not a replacement. Existing tables and tools remain compatible while a new context assembly layer becomes the default source of injected context. Migration is staged via shadow mode.

## 2. Problem

Current Workforce context is useful but fragmented, untyped, and unaudited.

- `session_context` stores project notes, but it is a simple key-value store with no type, trust score, freshness, TTL, or retrieval ranking. Any spawned agent can write any value with no source attribution.
- `knowledge_rules` act as procedural memory, but only path-glob and keyword matching decide injection — no relevance ranking, no semantic conflict detection, no decay.
- `shared_context` helps task groups, but it is not promoted into durable project memory.
- Task outputs and evals contain high-value episodic memory, but **only failures** become rules; successful task trajectories are discarded.
- Prompt injection is hardcoded across 10 layers in `worker-manager.js`, making it difficult to reason about context quality, tune budgets, or A/B test changes.
- There is no context audit trail explaining why a given memory was injected — debugging "why did the agent know/miss this?" is impossible.
- There is no default memory lifecycle: capture, consolidate, promote, invalidate, compact, and evaluate.
- There is no defense against memory poisoning ([MINJA](https://arxiv.org/html/2503.03704v2), [MemoryGraft](https://arxiv.org/abs/2512.16962), InjecMEM): a poisoned spawned-agent write becomes ground truth for downstream tasks.

As Workforce usage grows, this causes repeated investigation, stale assumptions, prompt bloat, missed lessons, inconsistent multi-agent behavior, and a real attack surface.

## 3. Goals

1. Make context management default-on for every Workforce task.
2. Preserve the current low-dependency, local-first install model (SQLite + node:sqlite, no required hosted services).
3. Introduce typed memory: semantic, episodic, procedural, artifact, decision, risk, and preference (LangMem taxonomy).
4. Capture episodic memory from **successful** tasks — not just failures.
5. Add a Context Assembler that scores and budgets all prompt context before task launch.
6. Provide per-layer token-budget telemetry so layer value can be measured and tuned.
7. Add provenance + numeric trust scoring on every memory row to defend against memory poisoning.
8. Support freshness, TTL, and invalidation so stale decisions do not silently mislead agents.
9. Provide MCP tools for context capture, search, audit, promotion, invalidation, and preview.
10. Build an eval harness (golden replay set) **before** rolling out architectural changes to layers 5–8.
11. Keep human control over sensitive or broad memory writes via `AskUserQuestion` gates.
12. Design storage adapters so future integrations with Zep, Mem0, embeddings, or graph DBs are *possible* without making them required.

## 4. Non-Goals (and why)

Non-goals are anchored to research findings — see §6 for full anti-recommendations with citations.

- **No required hosted memory vendor.** Local-first is a Workforce identity property; it must hold.
- **No embeddings in v3.6.** Path-glob + keyword overlap is sufficient at current scale (<10k rules per project); the gain from semantic search is dwarfed by the cost of an embedding-model dependency. Revisit when retrieval precision becomes the bottleneck.
- **No knowledge-rules replacement.** Rules become *one provider* feeding the assembler, not a deprecated table.
- **No automatic permanence for task output.** Capture is heuristic and bounded; promotion to durable memory requires either auto-rules (low-risk) or human approval (high-risk).
- **No agent-driven writes to high-trust organizational memory.** Trust ceiling for `source=agent:*` writes is bounded.
- **No full UI dashboard in v3.6.** Formatted CLI/MCP output is the entire surface.
- **No temporal knowledge graph (Zep/Graphiti).** Git history is already a bi-temporal entity log. See AR.1 in §6.

## 5. Research-Informed Principles

The product borrows selectively from the current context-management market. Each principle below is sourced.

| Principle | Source | Workforce application |
|---|---|---|
| **Four-strategy taxonomy** (Write / Select / Compress / Isolate) | [LangChain context engineering blog](https://blog.langchain.com/context-engineering-for-agents/) | Frame the assembler design around all four; today Workforce only does Select and partial Compress |
| **Three-tier memory** (Semantic / Episodic / Procedural) | [LangMem conceptual guide](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/) | `memory_type` enum on `context_items` |
| **Just-in-time retrieval over upfront stuffing** | [Anthropic engineering blog (Sep 2025)](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) | Layers 7 (rules) and 8 (session) move from spawn-time injection to mid-task tool calls |
| **File system as context** | [Manus blog](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus) | `.workforce/scratch/` inside each worktree; recoverable compression (drop body, keep path) |
| **Native context editing** | [Anthropic context management API](https://www.anthropic.com/news/context-management) | Set `context-management-2025-06-27` beta header for long tasks |
| **ADD-only extraction (don't overwrite)** | [Mem0 research](https://mem0.ai/research) (91.6 LoCoMo, 93.4 LongMemEval) | Invalidation, not deletion; temporal facts persist |
| **Sleeptime / offline consolidation** | [Letta sleep-time compute](https://www.letta.com/blog/sleep-time-compute) | New `consolidator.js` runs every 6h or on session end |
| **Letta core memory blocks** | [Letta docs](https://docs.letta.com/concepts/core-memory) | `context_blocks` — always-visible, labeled, char-limited, read-only-capable |
| **Pass full trace to sub-agents** | [Cognition: Don't Build Multi-Agents](https://cognition.ai/blog/dont-build-multi-agents) | Sub-task spawning carries parent trace, not just shared context |
| **Reflexion-style cross-task retry reasoning** | [Reflexion paper](https://arxiv.org/abs/2303.11366) | On retry, recall same-glob-signature failures from `episodic_memory` |
| **Eval harnesses for memory** | [LongMemEval](https://arxiv.org/abs/2410.10813), [LoCoMo](https://snap-research.github.io/locomo/) | Code-task variant: 30-task golden replay set, gates Phase 2+ |
| **MCP-native governance** | Anthropic MCP spec | Sensitive mutations gated via `AskUserQuestion`, never silent |
| **Memory poisoning is real** | [MINJA](https://arxiv.org/html/2503.03704v2), [MemoryGraft](https://arxiv.org/abs/2512.16962) | Provenance chain + numeric trust + threshold filter on retrieval |
| **AGENTS.md cross-tool standard** | [vibecoding.app](https://vibecoding.app/blog/agents-md-guide) (Linux Foundation, Dec 2025) | Future: read AGENTS.md alongside CLAUDE.md if present |

### 5.1 Failure-Mode Taxonomy (defend explicitly)

[Drew Breunig](https://www.dbreunig.com/2025/06/22/how-contexts-fail-and-how-to-fix-them.html) names four failure modes — every assembler decision must cite which one it defends against:

1. **Context Poisoning** — bad info gets retrieved and trusted. *Defense*: provenance chain, trust threshold, source-typed scoring (§8.4).
2. **Context Distraction** — context grows so large the model loses focus. *Defense*: per-layer budget telemetry (§8.10), `todo.md` recitation (§8.9), Anthropic context-editing beta (§8.11).
3. **Context Confusion** — irrelevant context degrades reasoning. *Defense*: relevance scoring with stale/invalidated penalty (§8.5), no negative examples without distillation (§16.P3.2).
4. **Context Clash** — contradictory items injected together. *Defense*: conflict detection on rule create (§16.P3.3), invalidation supersession (§8.7).

## 6. Anti-Recommendations (with reasoning)

Two things people will ask for that the research says don't build. State now to short-circuit later debate.

### AR.1 — No temporal knowledge graph (Zep / Graphiti style)

[Zep paper](https://arxiv.org/abs/2501.13956) is impressive for **conversational** memory with bi-temporal entity validity. Workforce's domain is **code tasks on a git repo**. The right temporal index is **git history** — already exists, bi-temporal (commit time + author time), provenance baked in (author + diff), and free. Building a parallel entity/relation graph duplicates git for no measurable gain. The legitimate graph queries (file co-change, dependency edges) should run on-demand via `git log` / static analysis, not a persistent graph table.

> The PRD's `context_entities` / `context_edges` tables (formerly §8.3) are deferred indefinitely. If a use case emerges, derive from git on demand.

### AR.2 — No vector embeddings in SQLite (yet)

The temptation: install `sqlite-vec`, embed every rule and context entry, do semantic search. The reality: Workforce has at most a few thousand rules per project; **path-glob + priority + keyword overlap already works** (it's how `knowledge-rules.js` matches today). Embeddings add a model dependency, an indexing pipeline, and offline-drift problems for marginal relevance gain. Mem0's strong LongMemEval scores ([Mem0 research](https://mem0.ai/research)) come mostly from BM25 + entity search, not pure vector. Wait until you have >10k rules per project AND clear evidence glob+keyword is failing.

> SQLite FTS5 stays. `sqlite-vec` does not.

## 7. Existing Workforce Overlay Points

| Current Component | Current Role | New Role |
|---|---|---|
| `mcp-server/core/session-context.js` | Project key-value notes | Backward-compatible source for core context blocks; gains `source`, `trust_score`, `last_validated_at` columns |
| `mcp-server/core/knowledge-rules.js` | Path-scoped procedural rules | Procedural memory provider; gains numeric trust + provenance |
| `mcp-server/tools/context-tools.js` | Task-group shared context | Short-term group memory provider |
| `mcp-server/core/eval-engine.js` | Failure feedback loop | Memory-capture source for *failures*; complemented by new success-capture path |
| `mcp-server/core/worker-manager.js` | Hardcoded 10-layer prompt injection | Consumer of `context-assembler.js` output; emits per-layer telemetry |
| `mcp-server/core/dependency-resolver.js` | Dependency / task graph | Signal for upstream context relevance |
| `mcp-server/tools/session-tools.js` | Session context MCP tools | Compatibility wrapper plus richer context tools |
| `skills/workforce-cio/SKILL.md` | Knowledge and context UX | Primary user-facing context-management workflow |
| `mcp-server/core/recovery-engine.js` | Failure / loop detection (30s) | Unchanged; complemented by slow `consolidator.js` (6h) |

## 8. Product Experience

### 8.1 Default Behavior

Context Management is enabled by default for all Workforce task launches.

When a user creates a task through `/workforce-coo`, `/workforce-ceo`, `/workforce-cplo`, backlog launch, decomposition, or direct MCP tool usage:

1. Workforce builds a context request from the task prompt, project, task type, profile, paths, dependencies, task group, and recent failures.
2. The Context Assembler queries all context providers (now including the episodic-memory provider — §16.P1.1).
3. Candidates are scored, deduplicated, conflict-checked, **trust-filtered** (default threshold 0.5), and packed into a budget.
4. The final prompt receives a structured context block with trust labels and source attribution.
5. The task record stores a context audit snapshot (§8.5).
6. The worktree gets a `.workforce/scratch/` directory with `todo.md` / `notes.md` / `findings.md` templates (§8.9).
7. On completion, Workforce extracts candidate memories — **including from successful tasks** — and either auto-saves low-risk memories or queues high-risk ones for CIO review.

### 8.2 User-Visible Commands

Add these CIO flows:

```text
/workforce-cio context
  Shows active context, memory health, recent captured memories,
  stale/conflicting items, and per-layer token usage trend.

/workforce-cio context search "auth middleware"
  Searches durable context memory across types.

/workforce-cio context preview "fix login bug"
  Shows what context would be injected before launching, with
  per-layer budget breakdown and trust scores.

/workforce-cio context audit <task_id>
  Shows what context was injected into a task and why
  (selected, omitted, conflicts, trust thresholds applied).

/workforce-cio context promote <memory_id>
  Promotes a memory to higher-trust core/procedural memory
  (always gated by AskUserQuestion).

/workforce-cio context invalidate <memory_id>
  Marks a stale memory invalid without deleting audit history.

/workforce-cio context replay
  Runs the golden replay set; reports score deltas vs baseline.

/workforce-cio context consolidate
  Manually triggers the sleeptime consolidation job
  (otherwise runs every 6h).
```

### 8.3 Agent-Facing Defaults

Every spawned agent receives context in this order:

0. Sequential thinking protocol (existing layer 0)
1. Critical core context blocks (`active_focus`, `known_risks`, `open_decisions`)
2. Task dependency and shared group context (existing layer 6)
3. **Past similar successes** — episodic few-shots (NEW layer 5b)
4. Relevant prior work (existing feedback layer 5)
5. Applicable knowledge rules — **index only by default**, full body fetched JIT (§16.P2.1)
6. Known risks and stale-decision warnings
7. Recent git/project state (existing layer 3)
8. `.workforce/scratch/todo.md` recitation prompt (NEW)
9. Completion checklist (existing layer 9)

The injected context includes trust labels, source attribution, and freshness:

```text
[Core Context — Trust: HIGH (1.0, source=human)]
active_focus: Ship Context Management Fabric as default-on Workforce behavior.

[Past Similar Successes — Trust: HIGH (0.9, episodic from merged tasks)]
Task abc12345 (2026-04-15, glob=mcp-server/core/*.js):
  Approach that worked: extracted shared util before adding 3rd consumer.
  Files: core/db.js, core/session-context.js. Review score: 87%.

[Relevant Prior Work — Trust: MEDIUM (0.6, source=session-end-eval)]
Task def67890 found that session context is currently injected with
a 1500 char budget.

[Known Risks — Trust: MEDIUM (0.7, source=recovery-engine)]
The old context key "auth_strategy" was invalidated on 2026-04-20
by decision d42 (superseded). Excluded from injection by default;
warning shown.

[Procedural Memory — Trust: HIGH (1.0, source=human, last_validated 2026-04-25)]
[security] auth-middleware: API auth routes must use JWT validation.
  Full rule body fetchable via workforce_get_rule(rule_id="auth-mw-01").
```

## 9. Functional Requirements

### 9.1 Context Items (durable memory store)

```sql
context_items (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  scope_type TEXT NOT NULL,            -- project | task_group | task | agent | global
  scope_id TEXT,
  memory_type TEXT NOT NULL,           -- semantic | episodic | procedural | artifact | decision | risk | preference
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  summary TEXT,

  -- Provenance (defends against memory poisoning)
  source_type TEXT NOT NULL,           -- human | task | eval | rule | session | git | system | agent
  source_id TEXT,                      -- e.g. task_id, eval_id, rule_id
  source_chain TEXT,                   -- JSON array of prior source_ids if derived
  authored_by TEXT,                    -- 'user' | 'agent:<task_id>' | 'recovery-engine' | etc.

  -- Retrieval signals
  paths TEXT,                          -- JSON array of glob patterns
  tags TEXT,                           -- JSON array
  glob_signature TEXT,                 -- normalized for episodic recall

  -- Trust / freshness
  trust TEXT NOT NULL DEFAULT 'low',   -- enum kept for UX labels
  trust_score REAL NOT NULL DEFAULT 0.4, -- numeric for scoring/filtering
  confidence REAL DEFAULT 0.5,
  last_validated_at TEXT,
  retrieval_count INTEGER DEFAULT 0,
  retrieval_outcome_score REAL,        -- moving avg of downstream task success when this was injected

  -- Lifecycle
  valid_from TEXT,
  invalid_at TEXT,
  invalidated_by TEXT,
  invalidation_reason TEXT,
  ttl_days INTEGER,

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

**Trust score defaults by source** (numeric; survives across migrations):

| Source | Default `trust_score` | Notes |
|---|---|---|
| `human` | 1.0 | Direct user write |
| `recovery-engine` | 0.8 | System-detected, evidence-backed |
| `session-end-eval` | 0.7 | Post-task LLM-extracted summary |
| `git` (commit/diff-derived) | 0.7 | Auditable in git log |
| `eval` (cluster-promoted) | 0.6 | Pattern from 3+ failures |
| `task` (resultSummary) | 0.5 | Low-risk inference |
| `agent` (spawned-agent write) | 0.4 | Default — must clear threshold |
| `system` (default seeds) | 0.5 | Bootstrap content |

**Default retrieval threshold**: `trust_score >= 0.5`. Configurable per-call.

Indexes: `idx_context_items_project`, `idx_context_items_scope`, `idx_context_items_memory_type`, `idx_context_items_source`, `idx_context_items_validity`, `idx_context_items_glob_signature`.

If SQLite FTS5 is available, create `context_items_fts` over title, content, summary, tags. Fallback: `LIKE` search on tokenized terms.

### 9.2 Context Blocks (Letta-style core memory)

Always-visible, labeled, char-limited blocks. Hydrated from `session_context` on first read.

```sql
context_blocks (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  label TEXT NOT NULL,
  description TEXT NOT NULL,
  value TEXT NOT NULL,
  char_limit INTEGER NOT NULL DEFAULT 2000,
  trust TEXT NOT NULL DEFAULT 'medium',
  trust_score REAL NOT NULL DEFAULT 0.7,
  read_only INTEGER NOT NULL DEFAULT 0,
  source_type TEXT NOT NULL DEFAULT 'human',
  authored_by TEXT,
  updated_by TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project, label)
);
```

Initial default blocks: `active_focus`, `repo_profile`, `open_decisions`, `known_risks`, `task_preferences`, `architecture_notes`.

`session_context.active_focus` hydrates `context_blocks.active_focus` on migration.

### 9.3 Episodic Memory (NEW — Phase 1 highest ROI)

Successful task trajectories as few-shot examples. **Today these are discarded.**

```sql
episodic_memory (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  task_id TEXT NOT NULL,
  task_type TEXT NOT NULL,             -- standard | analysis | experiment | measurement
  outcome TEXT NOT NULL,               -- success | failure | partial
  glob_signature TEXT NOT NULL,        -- sorted distinct globs over changed paths
  prompt_summary TEXT NOT NULL,        -- ~200 tokens
  approach_summary TEXT NOT NULL,      -- ~200 tokens — "what worked" or "what failed"
  files_touched TEXT NOT NULL,         -- JSON array
  review_score REAL,
  tokens_used INTEGER,
  retry_count INTEGER DEFAULT 0,
  trust_score REAL NOT NULL DEFAULT 0.7, -- merged code = high trust
  retrieval_count INTEGER DEFAULT 0,
  ttl_days INTEGER DEFAULT 90,
  created_at TEXT NOT NULL
);
```

**Capture trigger**: `lifecycle-tools.workforce_approve_task` at successful merge → spawn small Haiku call to summarize diff + prompt.

**Recall**: `workforce_recall_episodes(taskPrompt, plannedFiles, maxN=3)` does keyword overlap on `prompt_summary` + glob match on `glob_signature` + `trust_score >= 0.5`. Top-N injected at layer 5b.

**Eviction**: Per-glob-signature LRU cap of 10; TTL 90 days; consolidator merges near-duplicates.

### 9.4 Context Audit (per-task snapshot)

```sql
task_context_audits (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  project TEXT,
  prompt_hash TEXT,
  context_hash TEXT,
  budget INTEGER,
  selected_items TEXT,              -- JSON [{id, layer, score, reason, char_count}]
  omitted_items TEXT,               -- JSON [{id, reason: "below_threshold" | "budget_exceeded" | "stale" | "conflict"}]
  conflicts TEXT,
  trust_threshold REAL,
  assembled_prompt_preview TEXT,    -- first/last 2000 chars
  per_layer_chars TEXT,             -- JSON {layer_num: char_count}
  created_at TEXT NOT NULL
);
```

Enables: "Why did the agent know this?", "Why did the agent miss this?", "Which stale memory caused a bad decision?", and context regression testing against the golden set.

### 9.5 Per-Layer Token Telemetry (NEW)

```sql
prompt_layers (
  task_id TEXT NOT NULL,
  layer_num INTEGER NOT NULL,
  layer_name TEXT NOT NULL,
  char_count INTEGER NOT NULL,
  was_truncated INTEGER NOT NULL DEFAULT 0,
  retrieval_count INTEGER,           -- # candidates considered
  selected_count INTEGER,            -- # injected
  PRIMARY KEY (task_id, layer_num)
);
```

Surfaced in `workforce_health_metrics` and `/workforce` dashboard. Used to identify layers that don't move the needle (candidates for trimming) and layers that consistently truncate (candidates for budget increase).

### 9.6 Context Assembler (`mcp-server/core/context-assembler.js`)

Primary API:

```js
assembleContext({
  project,
  prompt,
  taskType,
  taskId,
  taskGroup,
  dependsOn,
  profile,
  repoRoot,
  budget,
  trustThreshold = 0.5,
  mode,                              // 'spawn' | 'preview' | 'replay'
})
```

Returns:

```js
{
  promptBlock: string,
  sections: [
    { name, trust, budgetUsed, entries: [{ id, title, score, reason, sourceType, trustScore }] }
  ],
  audit: {
    query, budget, trustThreshold,
    candidates, selected, omitted, conflicts,
    perLayerChars, generatedAt,
  }
}
```

**Scoring factors** (each layer applies its own weights):

- Explicit path match (glob)
- Keyword overlap on prompt
- Task-type match
- Dependency relevance
- Task-group relevance
- Recency (gentle decay, not cliff)
- **Trust score** (multiplier)
- Confidence
- Source type (human > recovery > eval > agent)
- Rule priority
- Invalidated/stale penalty (excluded by default; warning-context only when explicitly relevant)
- User-pinned boost
- **Retrieval-outcome score** (moving avg — items that historically helped score higher)

### 9.7 Memory Capture (success + failure)

After task completion, Workforce extracts candidate memories. Sources unchanged from v1, but **success path is new**:

| Outcome | Capture target | Trust | Auto-save? |
|---|---|---|---|
| Success (merged) | `episodic_memory` (approach_summary = "what worked") | 0.7 | Yes (low-risk episodic) |
| Failure | `episodic_memory` (approach_summary = "what failed and why") + `eval_logs` (existing) | 0.5 | Yes |
| Eval cluster (3+ similar) | `proposed_rules` queue | 0.6 | No — gated `AskUserQuestion` |
| Decision in resultSummary | `context_items.memory_type=decision` | 0.5 | Yes |
| Security/compliance keyword | `context_items.memory_type=risk` | 0.5 | **No — gated review** |
| Core block update | `context_blocks` | inherit | **No — gated unless block writable & low-risk** |

### 9.8 Invalidation (ADD-only, Mem0 pattern)

Memory is never deleted on staleness — invalidated. This preserves audit history and enables Reflexion-style learning.

Invalidated memories:
- Excluded from normal injection (default).
- Visible in audit/search with `invalidated` label.
- Surfaced as **warning context** when a current task asks about the superseded topic.

Triggers: user command, new decision supersedes prior decision, rule update replaces older rule, file deletion/rename invalidates file-specific artifact, TTL expiration, eval identifies harmful stale context.

### 9.9 File-System Scratchpad (NEW — Manus pattern)

At task spawn, create `.workforce/scratch/` in worktree:

- `todo.md` — task checklist; agent updates as it progresses (Manus recitation trick — combats context distraction by keeping objectives at end of context)
- `notes.md` — free-form working notes
- `findings.md` — durable output; on task completion, `lifecycle-tools.js` reads and feeds layer 6 of downstream tasks

Layer 0 sequential-thinking instructions are extended with: *"Maintain `.workforce/scratch/todo.md` and check off items as you complete them. Write durable findings to `.workforce/scratch/findings.md`."*

Source: [Manus blog](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus).

### 9.10 Anthropic Context-Editing Beta (NEW — free win)

Anthropic shipped `context-management-2025-06-27` beta header that auto-clears stale tool results. Free win for tasks that hit token-bloat Ralph Wiggum loops.

- Set `ANTHROPIC_BETA=context-management-2025-06-27` on tmux env export in `core/tmux.js`.
- Document in CLAUDE.md.
- Mitigation: keep last 3 tool results visible to preserve recent error context.

Source: [Anthropic context management API](https://platform.claude.com/docs/en/build-with-claude/context-editing).

### 9.11 Sub-Agent Trace Handoff (NEW — Cognition pattern)

When a parent task spawns a sub-task via `workforce_create_task` with `parent_task_id`:

- Copy parent prompt + last N tool calls (gzipped, capped at 8000 chars) into the sub-task's layer 6 input.
- New `task_trace` BLOB column on `tasks` table, populated from tmux scrollback at spawn.
- Older trace entries summarized with the layer 0 sequential-thinking output to fit budget.

Defends against the failure mode Cognition documented: sub-agents losing parent intent and producing inconsistent work.

### 9.12 Settings

`mcp-server/config/defaults.json`:

```json
{
  "context": {
    "enabled": true,
    "defaultBudgetChars": 6000,
    "coreBudgetChars": 2000,
    "rulesBudgetChars": 3000,
    "rulesIndexOnlyChars": 600,
    "archivalBudgetChars": 2500,
    "sharedContextBudgetChars": 2000,
    "episodicBudgetChars": 1500,
    "trustThreshold": 0.5,
    "auditEnabled": true,
    "captureOnCompletion": true,
    "captureSuccessfulTasks": true,
    "autoSaveEpisodic": true,
    "autoPromoteProcedural": false,
    "requireApprovalForCoreWrites": true,
    "requireApprovalForRiskWrites": true,
    "searchProvider": "sqlite_fts",
    "scratchpadEnabled": true,
    "anthropicContextEditingBeta": true,
    "consolidationIntervalHours": 6,
    "subAgentTraceHandoff": true
  }
}
```

Environment overrides: `WORKFORCE_CONTEXT_ENABLED`, `WORKFORCE_CONTEXT_BUDGET`, `WORKFORCE_CONTEXT_CAPTURE`, `WORKFORCE_CONTEXT_TRUST_THRESHOLD`, `WORKFORCE_CONTEXT_SEARCH_PROVIDER`, `WORKFORCE_SCRATCHPAD_ENABLED`.

## 10. MCP Tool Requirements

### `workforce_context_add`
Create a context item. Inputs: `project, memory_type, title, content, scope_type, scope_id, paths, tags, trust, trust_score, confidence, ttl_days, source_type` (caller-tagged automatically).

### `workforce_context_search`
Inputs: `project, query, memory_type, paths, include_invalidated, trust_threshold, limit`.

### `workforce_context_preview`
Preview assembled context before launching. Inputs: `project, prompt, task_type, task_group, depends_on, budget, trust_threshold`.

### `workforce_context_audit`
Inspect context used by a past task. Inputs: `task_id`. Returns selected/omitted/conflicts/per-layer telemetry.

### `workforce_context_invalidate`
Inputs: `id, reason, invalidated_by`. Marks stale, preserves history.

### `workforce_context_promote`
Inputs: `id, target` (`core_block` | `knowledge_rule` | `high_trust_memory`), `label, requires_approval`. Always gated `AskUserQuestion` for `target=core_block` and `target=high_trust_memory`.

### `workforce_context_compact`
Consolidate many items into fewer summaries. Inputs: `project, scope_type, older_than_days, memory_type, dry_run`.

### `workforce_capture_episode` (NEW)
Capture a successful task trajectory. Called by `lifecycle-tools` on merge. Inputs: `task_id` (rest derived).

### `workforce_recall_episodes` (NEW)
Retrieve few-shot examples for an upcoming task. Inputs: `project, prompt, planned_files, max_n`.

### `workforce_replay_golden_set` (NEW)
Run frozen golden tasks; report deltas vs baseline. Inputs: `golden_set_dir, baseline_run_id`.

### `workforce_consolidation_report` (NEW)
Surface latest sleeptime job results: merged duplicates, decayed entries, conflict candidates, pruned rows.

## 11. Skill & Agent Updates

### `skills/workforce-cio/SKILL.md`
Add `context` as a first-class action: list blocks, search memory, preview, audit, promote/demote/invalidate, compact, replay golden set, view consolidation report.

### `skills/workforce/SKILL.md`
Dashboard adds: context enabled/disabled, memory item count, stale/conflict count, last consolidation, recent captured episodes, top active focus, **per-layer token-usage chart**, **trust-score distribution**.

### `skills/workforce-coo/SKILL.md`
Task launch mentions automatic assembly; surface preview when task risk is high (security paths, large file counts) or user requests it.

### `agents/cio-curator.md`
Expand from eval-to-rule curation to memory-lifecycle curation: cluster repeated items, detect stale contradictions, suggest promotions/invalidations, identify missing procedural rules, **propose draft rules from eval clusters** (gated approval).

## 12. Prompt Injection Refactor

`worker-manager.js` delegates assembly. Each hardcoded layer becomes a provider:

| Layer | Provider | Trust source | JIT? |
|---|---|---|---|
| 0 | Sequential thinking | system | no |
| 1 | Running tasks | system | no |
| 2 | Recent git log | git (HIGH) | no |
| 3 | Project memory | human (variable) | no |
| 4 | Feedback (last 5) | session-end-eval | no |
| 5 | Upstream task results + shared context | task | no |
| 5b | **Past similar successes (NEW)** | episodic | no |
| 6 | Knowledge rules — **index only by default** | rule | YES (full body via `workforce_get_rule`) |
| 7 | Session/core context blocks | block | no for `active_focus`; YES for archival |
| 8 | Known risks / stale-decision warnings | item | no |
| 9 | `.workforce/scratch/todo.md` (NEW) | scratchpad | n/a |
| 10 | Completion checklist | system | no |

Each provider returns candidates with metadata; the assembler decides ordering, scoring, and budget.

## 13. Default-On Rollout

### Stage 0: Eval Harness FIRST (NEW — blocks Stage 2+)

Build the golden replay set (§16.M0) before architectural changes ship. Without it, every later phase is guesswork.

Success criteria: 30-task golden set runs end-to-end; baseline scores recorded; replay tooling produces reproducible deltas.

### Stage 1: Shadow Mode

Context Fabric builds an assembled context and audit record, but `worker-manager.js` still uses the current prompt.

Success criteria: no task-launch regressions; preview works; audit snapshots produced; per-layer telemetry flowing.

### Stage 2: Default-On for Analysis Tasks

Use assembler output for `analysis` tasks first (lowest blast radius — no zero-work guard, no merge).

Success criteria: ≥10% improvement in golden replay analysis-task scores; no excessive prompt bloat (per-layer telemetry shows budgets respected); user can audit injected context.

### Stage 3: Default-On for All Tasks

Success criteria: existing rules/session/shared context still appear when relevant; no regression in golden replay; no measurable increase in failed launches.

### Stage 4: Capture and Consolidation

Enable automatic memory capture on task completion (success + failure paths) + sleeptime consolidation job.

Success criteria: useful task summaries are searchable; low-value memories stay below threshold; CIO can review promotion candidates; DB row count plateaus rather than growing linearly.

### Stage 5: Just-In-Time Retrieval

Flip layer 6 to index-only injection; agents fetch full rule body via tool calls.

Success criteria: rule-application precision (hand-scored sample of 30) ≥ baseline; tool-call overhead acceptable; cache hit rate > 60% for trivial tasks.

## 14. Acceptance Criteria

1. New task launches use `context-assembler.js` by default when context is enabled.
2. Existing session context, shared context, and knowledge rules still appear when relevant.
3. `/workforce-cio context preview` shows assembled context without launching.
4. `/workforce-cio context audit <task_id>` explains selected, omitted, and stale-filtered context.
5. Completed *successful* tasks create `episodic_memory` rows with summaries.
6. Completed *failed* tasks create both `eval_logs` (existing) and `episodic_memory` (new) rows.
7. Invalidated memories are excluded from normal injection.
8. Search returns relevant items via SQLite FTS or fallback LIKE.
9. Context injection respects configurable per-layer budgets.
10. Per-layer token telemetry visible in `workforce_health_metrics`.
11. Memory rows have `source_type`, `authored_by`, and `trust_score` populated; retrieval defaults to `trust_score >= 0.5`.
12. Spawned-agent writes are tagged `source=agent:<task_id>` and capped at `trust_score=0.4`.
13. Worktrees contain `.workforce/scratch/` with `todo.md` / `notes.md` / `findings.md`.
14. `findings.md` content from upstream tasks reaches downstream layer-6 context.
15. Sub-task spawn copies parent trace into sub-task layer 6.
16. `ANTHROPIC_BETA=context-management-2025-06-27` is set on long-task tmux env.
17. Golden replay set runs end-to-end and reports score deltas.
18. Context tools have tests for add, search, assemble, audit, capture, recall, invalidate, replay.
19. Users can disable globally with `WORKFORCE_CONTEXT_ENABLED=false`.
20. Red-team test passes: a poisoned spawned-agent write cannot influence a downstream task above the default trust threshold.

## 15. Metrics

Operational:
- Average context budget used per task; per-layer breakdown
- # selected / # omitted candidates per task
- Search hit rate
- Episodic recall hit rate (queries returning ≥1 episode)
- Trust-score distribution across `context_items`
- # captured memories per task (success vs failure split)
- # promoted memories; # invalidated; reject rate on proposed rules

Quality:
- Golden replay score delta per stage
- Task failures attributed to missing context (manual tag)
- Task failures attributed to stale context (manual tag)
- Prompt-size delta before/after default-on
- Retrieval-outcome score moving avg per source type (validates trust calibration)

Security:
- # spawned-agent writes blocked by trust threshold
- # invalidations triggered by source=agent (poisoning candidates)

## 16. Risks

| Risk | Source | Mitigation |
|---|---|---|
| Prompt bloat | All | Budgeted assembly, per-layer caps, telemetry, JIT for layer 6 |
| Stale memory causes drift | Aging deployments | Invalidation, TTL, freshness penalty, consolidator decay |
| Memory poisoning | [MINJA](https://arxiv.org/html/2503.03704v2) / [MemoryGraft](https://arxiv.org/abs/2512.16962) | Provenance chain, numeric trust, source-type ceiling, threshold filter |
| Bad memories compound | Auto-save | Trust levels, approval gates for promotion, CIO curation |
| Implementation complexity blowup | Scope creep | SQLite + FTS only; no embeddings, no graph DB, no hosted vendor |
| Search misses important context | Glob/keyword limits | Path/rule providers remain deterministic; episodic adds recall channel |
| Agents over-trust low-quality notes | Default behavior | Trust labels in prompt + numeric score in retrieval |
| Auto-merge destroys nuance | Consolidator | Stage as proposed merges, require human review |
| Sub-agent context loss | Cognition failure mode | Trace handoff (§9.11) |
| Negative episodic examples confuse model | [Breunig "confusion"](https://www.dbreunig.com/2025/06/22/how-contexts-fail-and-how-to-fix-them.html) | Distill failures to lesson, not full transcript |
| Breaking current behavior | Migration | Shadow mode, compatibility wrappers, opt-out env var |

## 17. Implementation Plan (ROI-ordered, not schema-ordered)

### Milestone 0: Golden Replay Eval Harness (BUILD FIRST)

Files: `mcp-server/test/golden/`, `mcp-server/core/replay-runner.js`, `mcp-server/tools/replay-tools.js`.

Deliver:
- 30 frozen tasks from real Workforce history with known-good diffs (pinned to git SHA per task).
- `workforce_replay_golden_set` runs each, scoring merge-eligibility, review score, tokens used, Ralph Wiggum incidents.
- Baseline run captured before any other Phase 1 work.

**Why first**: every later milestone needs this to validate. Without it, "did P1.1 help?" is unanswerable.

### Milestone 1: Episodic Capture + Recall (HIGHEST ROI)

Files: `mcp-server/core/db.js` (just `episodic_memory` table), `mcp-server/core/episodic-memory.js`, `mcp-server/tools/episodic-tools.js`, hook into `mcp-server/tools/lifecycle-tools.js` on merge, `mcp-server/core/worker-manager.js` (layer 5b injection).

Deliver:
- `episodic_memory` table (only — full schema migration deferred to M3).
- `workforce_capture_episode` on successful merge (Haiku-summarized).
- `workforce_recall_episodes(prompt, paths)` — keyword + glob match, top-3.
- Layer 5b injection of recalled episodes.
- Replay against M0 golden set; expect first-shot success-rate improvement.

### Milestone 2: Provenance + Trust on Existing Tables (SECURITY DEBT)

Files: `mcp-server/core/db.js` (ALTER TABLE migrations), `mcp-server/core/session-context.js`, `mcp-server/core/knowledge-rules.js`, `mcp-server/tools/session-tools.js`, `mcp-server/tools/knowledge-tools.js`.

Deliver:
- Schema migration: `source_type, authored_by, trust_score, last_validated_at` on `session_context` and `knowledge_rules`.
- `workforce_write_context` and `workforce_create_rule` tag caller automatically.
- Retrieval filter at default `trust_score >= 0.5`.
- Red-team test in `mcp-server/test/`.

### Milestone 3: Full Schema + Core Memory Store

Files: `mcp-server/core/db.js`, `mcp-server/core/context-memory.js`, `mcp-server/test/context-memory.test.js`.

Deliver:
- Full migrations (`context_items`, `context_blocks`, `task_context_audits`, `prompt_layers`).
- CRUD for items + blocks + audits.
- FTS5 search if available, fallback LIKE otherwise.
- `context_blocks.active_focus` hydrated from `session_context` on first read.

### Milestone 4: Context Assembler

Files: `mcp-server/core/context-assembler.js`, `mcp-server/core/context-providers.js`, `mcp-server/test/context-assembler.test.js`.

Deliver:
- Provider model (one per layer).
- Candidate scoring with all factors from §9.6.
- Budgeted packing with per-layer caps.
- Conflict + invalidation filtering.
- Prompt block generation + audit emission.
- Golden replay run vs M2 baseline.

### Milestone 5: MCP Tools

Files: `mcp-server/tools/context-memory-tools.js`, `mcp-server/index.js`.

Deliver: add/search/preview/audit/invalidate/promote/compact/replay/consolidation tools with formatted output.

### Milestone 6: Worker Integration (shadow → default-on)

Files: `mcp-server/core/worker-manager.js`, `mcp-server/core/tmux.js` (Anthropic beta header).

Deliver:
- Shadow mode (Stage 1 of §13).
- Default-on for analysis tasks (Stage 2).
- Default-on for all tasks (Stage 3).
- Per-layer telemetry writes.

### Milestone 7: Memory Capture Pipeline

Files: `mcp-server/core/context-capture.js`, hooks in `mcp-server/core/worker-manager.js` and `mcp-server/core/eval-engine.js`.

Deliver:
- Extract task memories on success (extends M1).
- Extract failed-approach memories on failure.
- Queue promotion candidates with `AskUserQuestion` gates.

### Milestone 8: File-System Scratchpad + Sub-Agent Trace

Files: `mcp-server/core/worker-manager.js` (scratchpad creation, trace blob), task-spawn modifications, layer 9 prompt update.

Deliver:
- `.workforce/scratch/` template at spawn.
- Layer 0 instruction update for `todo.md` recitation.
- `findings.md` → downstream layer 6.
- Parent-trace handoff for `parent_task_id` spawns.

### Milestone 9: Sleeptime Consolidator

Files: `mcp-server/core/consolidator.js`.

Deliver: 6h job that merges near-duplicate episodes, detects rule conflicts, decays unread items, prunes archived shared_context. Surface via `workforce_consolidation_report`.

### Milestone 10: Just-In-Time Rules Retrieval

Files: `mcp-server/core/worker-manager.js` (layer 6 → index-only), `mcp-server/tools/knowledge-tools.js` (`workforce_get_rule` advertised to spawned agents).

Deliver: rules layer becomes index by default; agents fetch full body on demand.

### Milestone 11: Skill & Agent UX

Files: `skills/workforce-cio/SKILL.md`, `skills/workforce/SKILL.md`, `skills/workforce-coo/SKILL.md`, `agents/cio-curator.md`.

Deliver: CIO context workflows, dashboard status, curator instructions for memory-lifecycle.

### Milestone 12 (deferred): Procedural Memory from Eval Clusters

Phase-3 ambition. Auto-draft rules from 3+ failure clusters; gated `AskUserQuestion`; reject-rate >70% means quality is bad and we pull back.

## 18. Open Questions — answered with research backing

| Question | Recommendation | Reasoning |
|---|---|---|
| Heuristic vs LLM extraction for capture? | **LLM (Haiku)** for episodic summaries; heuristic for failure-pattern hashing | LangMem and Mem0 both use small-LLM extraction; Haiku is cheap enough for per-task. Heuristic suffices for hashing same-error retries (Workforce already does this). |
| Memories global across repos or project-scoped? | **Project-scoped by default**; global table only for user-level preferences | Cross-project pollution is the bigger risk; LangMem's namespace pattern recommends scoped-by-default. |
| Should `knowledge_rules` become `context_items.memory_type=procedural`? | **Keep separate permanently** | Rules have stable consumer code (`get_rules_for_path`), public MCP tools, and skill-level ergonomics. Merging would force a high-risk migration for marginal cleanup. |
| Default budget — subscription vs API-cost mode? | 6000 chars subscription; 4000 chars API-cost | Match Anthropic's attention-budget guidance; tighter budget where every token costs. |
| AskUserQuestion gates for high-risk memories? | **Yes, mandatory for `memory_type` ∈ {risk, decision} and source=agent** | Memory-poisoning attacks demonstrated in 2025; gating cost is one prompt, breach cost is silent compromise. |
| Auto-preview for CEO/CPLO flows? | **Yes for high-risk** (security paths, >10 file diff, schema migrations); on-demand otherwise | Heavy users won't tolerate forced preview on every launch; targeted at risk surfaces. |
| Read AGENTS.md alongside CLAUDE.md? | **Yes — Phase 3, low effort** | Linux Foundation standard since Dec 2025; cross-tool projects increasingly have it; trivial to inject as a project-memory provider. |

## 19. Recommendation

Build the Context Fabric **local-first and default-on**, with SQLite storage, FTS search, numeric trust scoring, file-system scratchpad, per-layer telemetry, and auditability. **Do not** make external memory platforms required. Treat Zep, Mem0, Letta, embeddings, and graph databases as future adapters, not v3.6 dependencies.

**The first shippable version (v3.6) focuses on, in order:**

1. **Milestone 0** — Golden replay eval harness (without this, nothing else can be measured).
2. **Milestone 1** — Episodic memory capture + recall (highest ROI; turns thrown-away success data into few-shot examples).
3. **Milestone 2** — Provenance + trust on existing tables (closes the memory-poisoning gap before scaling autonomy).
4. **Milestones 3–4** — Schema + assembler.
5. **Milestone 6** — Worker integration (shadow → default-on).
6. **Milestone 7** — Memory capture pipeline.
7. **Milestone 8** — Scratchpad + sub-agent trace.

Milestones 9–12 are v3.7. The harness from M0 is the gate that lets us know when each later milestone has actually helped.

If only one thing ships in v3.6: **Milestone 1**. It turns Workforce's eval loop from "rules text" into actual few-shot trajectories — what every leading memory framework (LangMem, Mem0, Letta) treats as the highest-signal tier.
