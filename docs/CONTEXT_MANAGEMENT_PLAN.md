# Workforce Context Management Plan

_Plan author: research synthesis, April 2026. Targets Workforce v3.5.0._

## Executive summary

- **Workforce already does the structural plumbing** of a context-engineering platform (10-layer injection, knowledge rules, eval feedback loop, session KV, trust annotations, isolated worktrees with shared-context dependency injection). What it lacks is the **memory operations layer**: episodic experience capture, just-in-time retrieval, file-system offloading, conflict/freshness governance, and a real eval harness.
- **The biggest single ROI win** is converting the eval feedback loop from "rules text" to **episodic memory** (few-shot trajectories from past tasks) — Workforce already produces the raw material (eval entries, task diffs, recovery-engine signals); it just isn't recalled at injection time. Inspired by LangMem's three-tier memory model ([LangMem docs](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/)) and Reflexion-style reflection over past trajectories.
- **The biggest architectural shift** is moving from **upfront stuffing to just-in-time retrieval** for layers 3 (git log), 7 (knowledge rules), and 8 (session context). Anthropic explicitly called this out as the dominant pattern in production agents ([Anthropic context engineering blog](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)). Today Workforce stuffs ~3000+1500 chars regardless of relevance per task.
- **The biggest defense gap** is around **memory poisoning** (MINJA, MemoryGraft attacks — [arXiv 2503.03704](https://arxiv.org/html/2503.03704v2), [arXiv 2512.16962](https://arxiv.org/abs/2512.16962)). Workforce has no provenance chain on `session_context` / `knowledge_rules` writes, no per-source trust score, and no decay. A spawned agent can write any session context entry that downstream tasks then trust. This needs fixing before scaling autonomy.
- **Two anti-recommendations**: do **not** build a temporal knowledge graph (Zep/Graphiti style) and do **not** build vector embeddings into the SQLite store. Both are wrong-shaped for code-task memory and would dwarf the rest of the codebase. The right primitives are file-system offload (Manus pattern) and SQL-indexed lookup keyed on path + git SHA + task type.

---

## How the field has moved (Apr 2025 → Apr 2026)

| Theme | Source | What changed |
|---|---|---|
| Term coined | [Karpathy 2025](https://karpathy.bearblog.dev/year-in-review-2025/), [LangChain](https://blog.langchain.com/context-engineering-for-agents/) | "Context engineering" displaces "prompt engineering" as the systems discipline |
| Four-strategy taxonomy | [LangChain blog](https://blog.langchain.com/context-engineering-for-agents/) | Write / Select / Compress / Isolate is the canonical breakdown |
| Failure modes | [Drew Breunig](https://www.dbreunig.com/2025/06/22/how-contexts-fail-and-how-to-fix-them.html) | Poisoning / Distraction / Confusion / Clash — now standard vocabulary |
| Just-in-time retrieval | [Anthropic engineering blog (Sep 2025)](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) | Lightweight identifiers + load-on-demand beats upfront stuffing |
| File system as context | [Manus blog](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus) | Recoverable compression: drop body, keep path/URL |
| Memory tool / context editing | [Anthropic news](https://www.anthropic.com/news/context-management) | First-class API primitives for clearing stale tool results |
| Three-tier memory | [LangMem](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/) | Semantic / Episodic / Procedural — model the field has converged on |
| ADD-only extraction | [Mem0 research](https://mem0.ai/research) | Don't overwrite, keep temporal facts; 91.6 LoCoMo, 93.4 LongMemEval |
| Sleeptime compute | [Letta](https://www.letta.com/blog/sleep-time-compute) | Async background consolidation between sessions |
| Eval harnesses | [LongMemEval](https://arxiv.org/abs/2410.10813), [LoCoMo](https://snap-research.github.io/locomo/) | Real benchmarks for memory quality |
| Don't multi-agent naively | [Cognition Devin](https://news.ycombinator.com/item?id=45096962) | Sub-agents without shared context fail; pass full trace |
| Memory poisoning attacks | [MINJA](https://arxiv.org/html/2503.03704v2), [MemoryGraft](https://arxiv.org/abs/2512.16962) | Indirect prompt injection through retrieved memories is now demonstrated |
| Cross-tool standard | [AGENTS.md](https://vibecoding.app/blog/agents-md-guide) | Linux Foundation Agentic AI Foundation owns it as of Dec 2025 |

---

## Where Workforce stands today

| Capability | Workforce status | Gap |
|---|---|---|
| Write context (scratchpad) | Partial — `session_context` KV, `shared_context` per-task | No file-system scratchpad inside worktree; no todo.md recitation pattern |
| Select context (retrieval) | Path-glob match for rules, recency for session | All upfront, no JIT, no embedding-free relevance ranking beyond glob+priority |
| Compress context | Hard char caps (3000 / 1500), no summarization | No rolling summaries, no hierarchical compression of git log / task output |
| Isolate context (subagents) | Worktree per task + dependency injection | Sub-task spawning would re-inherit parent context; no Cognition-style full-trace handoff |
| Trust annotations | HIGH/MEDIUM/LOW labels in prompt | Static — not per-source, no decay, no provenance chain |
| Episodic memory | Eval entries exist but only feed rules | Successes are not captured; failures only become rule text, not few-shot examples |
| Procedural memory | Knowledge rules + completion checklist | Skills/agents files are the procedural store; no learned-procedure update pipeline |
| Loop detection | Ralph Wiggum (Rule 6a/6b) | Only catches same-error / no-progress; doesn't catch context-distraction (>100k token bloat) |
| Memory poisoning defense | None | `workforce_write_context` / `workforce_create_rule` accept any text from spawned agents |
| Eval harness | `eval_logs` table, cluster detection | No quantitative benchmark — can't tell if a change to layer 7 made retrieval better or worse |

---

## Phase 1 — Quick wins (each <1 week)

Ranked by ROI.

### P1.1 — Episodic memory from successful tasks (HIGHEST ROI)

- **Motivation**: Workforce already records every task's diff, prompt, and outcome. LangMem and Mem0 both treat past task trajectories as the highest-signal memory tier. Currently only failures become rules; successes are discarded ([LangMem episodic memory guide](https://langchain-ai.github.io/langmem/guides/extract_episodic_memories/)).
- **Status vs existing**: Net-new. `eval_logs` is failure-only; `knowledge_rules` is generalized text, not concrete examples.
- **Design sketch**:
  - New table `episodic_memory(id, task_id, task_type, glob_signature, prompt_summary, approach_summary, files_touched, outcome, success_score, created_at)`. Glob signature = sorted distinct globs covering changed paths (e.g. `mcp-server/core/*.js`).
  - `workforce_capture_episode` MCP tool — invoked on successful merge by `lifecycle-tools.js`; LLM-summarizes diff + prompt into ~200-token "what worked" note.
  - `workforce_recall_episodes(taskPrompt, maxN=3)` — keyword-overlap match on prompt + path-glob match on planned files; returns top-N as few-shot.
  - **Injection point**: New layer 5b "Past similar successes" between feedback (layer 5) and upstream task results (layer 6). Trust: HIGH (these are merged code).
- **Risks**: Episode bloat over time. Mitigation: TTL of 90 days + per-glob-signature LRU cap of 10.
- **Eval idea**: A/B on a held-out set of 20 tasks — measure first-shot success rate (no retry) and tokens used with/without episodes injected.

### P1.2 — Provenance + trust scoring on writes

- **Motivation**: MINJA and MemoryGraft attacks ([arXiv 2503.03704](https://arxiv.org/html/2503.03704v2)) compromise agents by writing poisoned memories that future tasks retrieve. Workforce currently lets any spawned agent write to `session_context` and `knowledge_rules` with no accountability.
- **Status vs existing**: Trust labels exist in prompt strings but not on rows. Net-new at the data layer.
- **Design sketch**:
  - Schema migration: add `source TEXT, source_task_id TEXT, trust_score REAL, last_validated_at INTEGER` to `session_context` and `knowledge_rules`.
  - Sources: `human`, `recovery-engine`, `session-end-eval`, `agent:<task_id>`. Default trust: human=1.0, recovery-engine=0.8, session-end-eval=0.7, agent=0.4.
  - `workforce_write_context` tagged with caller — agents writing always get `source=agent:<task_id>`.
  - Injection point: filter layer 7 (knowledge rules) and layer 8 (session context) at trust >= 0.5 by default; expose threshold per-call.
- **Risks**: Trust calibration is hard. Mitigation: log retrieval+outcome to feed re-scoring later.
- **Eval idea**: Red-team test — spawn task that tries to write a poisoned rule; verify it can't influence a downstream task above threshold.

### P1.3 — File-system scratchpad inside worktree (Manus pattern)

- **Motivation**: Manus achieves 100:1 compression by writing to files and keeping only paths in context ([Manus blog](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)). Workforce already has isolated worktrees — perfect substrate.
- **Status vs existing**: Net-new. Today the prompt is the only working memory; summaries die at task end.
- **Design sketch**:
  - At task spawn, create `.workforce/scratch/` in worktree with `todo.md`, `notes.md`, `findings.md` templates.
  - Add to layer 0 (sequential thinking) instructions: "Maintain todo.md and check off items as you progress" (the Manus recitation trick — combats context distraction by keeping objectives at the end of the context).
  - On task completion, `lifecycle-tools.js` reads `findings.md` → injected into downstream task results (layer 6).
- **Risks**: Adds one filesystem dependency to spawned agent prompts. Low risk because worktree is already isolated.
- **Eval idea**: Measure long-task (>10 tool calls) completion rate before/after.

### P1.4 — Token-budget telemetry per layer

- **Motivation**: Anthropic frames context as a finite "attention budget" ([Anthropic blog](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)). Workforce has hard caps but no telemetry — we don't know which layers actually matter.
- **Status vs existing**: Net-new instrumentation.
- **Design sketch**:
  - In `worker-manager.js` (or wherever prompt assembly happens), record `prompt_layers(task_id, layer_num, layer_name, char_count, was_truncated)`.
  - Surface in `workforce_health_metrics` and `/workforce` dashboard.
- **Risks**: None. Pure observability.
- **Eval idea**: After 2 weeks of data, look at correlation between layer presence/size and task success; trim layers that don't move the needle.

### P1.5 — Context editing on long tasks (Anthropic native)

- **Motivation**: Anthropic shipped `context-management-2025-06-27` beta header that auto-clears stale tool results ([Anthropic context editing](https://platform.claude.com/docs/en/build-with-claude/context-editing)). Free win for tasks that hit Ralph Wiggum loops on token bloat.
- **Status vs existing**: Workforce spawns `claude` CLI; need to verify CLI passes through the beta flag or set via env.
- **Design sketch**: Set `ANTHROPIC_BETA=context-management-2025-06-27` on tmux env export in `core/tmux.js`. Document in CLAUDE.md.
- **Risks**: Tool-result clearing could hide important error context. Mitigation: keep last 3 results.
- **Eval idea**: Re-run watchdog-killed tasks (>30 min) with context editing on; measure completion rate.

---

## Phase 2 — Medium (1-3 weeks each)

### P2.1 — Just-in-time knowledge rules retrieval

- **Motivation**: Today layer 7 stuffs all path-matched rules up to 3000 chars upfront. Anthropic's pattern: pass identifiers, let the agent fetch ([Anthropic blog](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)).
- **Status vs existing**: Existing `workforce_get_rules_for_path` becomes the JIT primitive. Today it's used at spawn; needs to become a tool the agent calls mid-task.
- **Design sketch**:
  - Promote `workforce_get_rules_for_path` to advertised tool surface (already exists as MCP tool — verify it's listed in spawned agent's tool whitelist).
  - At spawn, inject only an **index** of available rules (rule_id, summary, glob, priority) — not full bodies. Maybe ~600 chars total instead of 3000.
  - Agent calls `workforce_get_rule(rule_id)` when relevant.
- **Risks**: Adds tool-call overhead. Mitigation: cache the index injection so trivial tasks skip.
- **Eval idea**: Measure rule-application precision (did the agent apply the rule when relevant?) — sample 30 task diffs, hand-score.

### P2.2 — Hierarchical summarization of long chains

- **Motivation**: When a chain of 5+ tasks runs, layer 6 (upstream task results) blows past budgets. Manus and Letta both use compression cascades.
- **Status vs existing**: Workforce has no chain-level summary; each downstream task sees raw upstream output.
- **Design sketch**:
  - New table `chain_summaries(chain_id, depth, summary_text, token_count)`.
  - On task completion in a dependency chain, run a small summarization pass (`claude -p --model haiku`) over upstream results → store at depth.
  - Layer 6 prefers the chain summary over raw output once depth > 2.
- **Risks**: Summary loss of detail. Mitigation: keep raw output behind a fetch tool (`workforce_task_output` already exists).
- **Eval idea**: 10-task chain — compare downstream task quality with raw vs summarized upstream context.

### P2.3 — Sleeptime consolidation job

- **Motivation**: Letta's sleeptime ([Letta blog](https://www.letta.com/blog/sleep-time-compute)) runs offline jobs that dedupe, merge, and prune memory. Workforce's `eval_clusters` is the closest analog but only runs on-demand.
- **Status vs existing**: `recovery-engine` runs every 30s for failure detection. Add a complementary slow loop.
- **Design sketch**:
  - New `core/consolidator.js` running every 6h or on session end.
  - Tasks: (a) merge near-duplicate `episodic_memory` entries, (b) detect rule conflicts in `knowledge_rules` and surface to user, (c) decay `trust_score` for entries older than 30d that haven't been retrieved or validated, (d) prune `shared_context` rows for archived tasks.
  - Surface via `workforce_consolidation_report` MCP tool.
- **Risks**: Auto-merge could destroy nuance. Mitigation: stage as proposed merges, require human review (matches existing `AskUserQuestion` pattern).
- **Eval idea**: After 30d of operation, measure DB row count vs retrieval hit-rate; healthy systems should plateau, not grow linearly.

### P2.4 — Memory eval harness (LoCoMo-style for code)

- **Motivation**: Without a benchmark you can't know if changes help. LongMemEval and LoCoMo are domain-mismatched (chat). Build a code-tasks variant.
- **Status vs existing**: `eval_logs` records single-task outcomes; no held-out replay set.
- **Design sketch**:
  - Curate 30 frozen tasks from real Workforce history with known-good diffs (a "golden set" in `mcp-server/test/golden/`).
  - `workforce_replay_golden_set` runs each, scoring (a) merge-eligibility, (b) review score, (c) tokens used, (d) Ralph Wiggum incidents.
  - Run before/after each Phase 2/3 change.
- **Risks**: Tasks drift as codebase changes. Mitigation: pin to a git SHA per task.
- **Eval idea**: This **is** the eval idea.

### P2.5 — Sub-agent spawning with full-trace handoff

- **Motivation**: Cognition's "Don't Build Multi-Agents" — the failure mode is sub-agents losing parent context. Workforce's `coo-planner` decompose path could hit this. Their fix: pass the full trace ([Cognition](https://news.ycombinator.com/item?id=45096962)).
- **Status vs existing**: Dependency graph + shared context exists; full conversation trace does not.
- **Design sketch**:
  - When a parent task spawns a sub-task via `workforce_create_task` with `parent_task_id`, copy the parent's prompt + last N tool calls into the sub-task's layer 6 input.
  - Add `task_trace` blob (gzipped) to `tasks` table, populated from tmux scrollback at spawn.
- **Risks**: Trace bloat. Mitigation: cap at last 8000 chars; summarize older with the layer 0 sequential-thinking output.
- **Eval idea**: Spawn a 3-level decompose chain manually with and without trace handoff; measure inter-task consistency by hand-scoring.

---

## Phase 3 — Ambitious (multi-week)

### P3.1 — Procedural memory updates from eval clusters

- **Motivation**: LangMem's procedural memory tier writes back into prompts/skills based on learned patterns. Workforce's `eval_clusters` already groups 3+ similar failures; closing the loop means **automatically** drafting a knowledge rule or skill update.
- **Status vs existing**: Manual today — user runs `/workforce-cio eval` and writes the rule.
- **Design sketch**:
  - Cluster of 3+ failures → spawn a meta-task (analysis type) whose prompt is "given these failures, draft a knowledge rule".
  - Output goes to a `proposed_rules` table; user reviews via `AskUserQuestion` (matches existing gate pattern).
  - Approved rules feed `workforce_create_rule` with provenance `source=eval-cluster:<cluster_id>`.
- **Risks**: Auto-drafted rules could be slop. Mitigation: human-in-loop required, never auto-merged.
- **Eval idea**: Track over 60d: how many proposed rules approved vs rejected; reject rate >70% means quality is bad.

### P3.2 — Reflexion-style retry reasoning with episodic recall

- **Motivation**: Reflexion ([referenced in self-RAG / agent reflection literature](https://arxiv.org/abs/2310.11511)) — on retry, generate a reflection on what went wrong, store it, retrieve next time. Workforce already has retry-reasoning injection (layer 0); this extends it to use cross-task history.
- **Status vs existing**: Retry reasoning is intra-task. Cross-task is net-new.
- **Design sketch**:
  - On retry, query `episodic_memory` for failures with the same glob signature + similar prompt; inject "previous attempts failed because X — don't repeat".
  - Combines with P1.1 — same table, different query.
- **Risks**: Negative examples can be more confusing than helpful (context confusion, per Breunig). Mitigation: keep only the lesson, not the failed approach in detail.
- **Eval idea**: Retry-success-rate before/after on golden set tasks engineered to fail first try.

### P3.3 — Conflict detection and resolution UI

- **Motivation**: Drew Breunig's "Context Clash" failure mode is unaddressed in Workforce. Two rules with overlapping globs can contradict; current `workforce_rule_lint` checks duplicates but not semantic conflict.
- **Status vs existing**: Lint exists; semantic conflict detection is net-new.
- **Design sketch**:
  - On rule create, run a small LLM check: "Does this contradict rule X (same glob, opposite advice)?"
  - Conflicts surface in `/workforce-cio rules` with side-by-side diff and merge UI.
- **Risks**: LLM-based detection has false positives. Mitigation: only block on user confirmation.
- **Eval idea**: Seed a conflict pair manually; verify detection.

---

## Anti-recommendations (don't build these)

### AR.1 — Temporal knowledge graph (Zep / Graphiti style)

[Zep paper](https://arxiv.org/abs/2501.13956) is impressive for **conversational** memory with bi-temporal entity validity. Workforce's domain is **code tasks on a git repo**. The right temporal index is **git history**, which already exists, is bi-temporal (commit time + author time), has provenance (author + diff), and is free. Building a parallel graph of entities/relationships duplicates git for no gain. The few legitimate graph queries (file co-change, dependency edges) should be on-demand via `git log` / static analysis, not a persistent graph.

### AR.2 — Vector embeddings in SQLite

The temptation: install `sqlite-vec`, embed every rule / context entry, do semantic search. The reality: Workforce has at most a few thousand rules per project. **Path-glob + priority + keyword overlap already works** (it's how `knowledge-rules.js` matches today). Embeddings add an embedding model dependency, an indexing pipeline, and offline drift problems for a relevance gain that disappears once you have decent globs. Mem0's strong LongMemEval scores ([Mem0 research](https://mem0.ai/research)) come mostly from BM25 + entity search, not pure vector. Wait until you have >10K rules and clear evidence glob+keyword is failing.

---

## Mapping to existing internals

| Feature | File / Table | Lives at |
|---|---|---|
| 10-layer prompt assembly | `mcp-server/core/worker-manager.js` | Spawn time |
| Knowledge rules | `core/knowledge-rules.js`, table `knowledge_rules` | Layer 7 |
| Session context | `core/session-context.js`, table `session_context` | Layer 8 |
| Eval feedback | `core/eval-engine.js`, table `eval_logs` | Layer 5 (via feedback.jsonl) + cluster surfacing |
| Recovery / loop detection | `core/recovery-engine.js` | Background, every 30s |
| Shared context (chain) | table `shared_context` | Layer 6 |
| Tools surface | `mcp-server/tools/*.js` | Where new MCP tools go |

Phase 1 lands in: `core/db.js` (schema), `core/episodic-memory.js` (new), `tools/episodic-tools.js` (new), `core/worker-manager.js` (layer 5b injection, telemetry), `core/tmux.js` (env beta header).

---

## Top 3 things to build first

1. **P1.1 Episodic memory from successful tasks** — highest ROI, leverages data Workforce already throws away, lands in <1 week. Plugs into existing `eval_logs`/`shared_context` patterns.
2. **P1.2 Provenance + trust scoring on writes** — security debt that compounds with autonomy. Cheap to add now, painful to retrofit. Covers MINJA/MemoryGraft class of attacks.
3. **P2.4 Memory eval harness (golden set)** — without this, every later phase is guesswork. Build it before P2.1/P2.2/P2.3 so we can score them honestly.

If only one thing ships: **P1.1**. It turns Workforce's eval loop from "rules text" into actual few-shot examples, which is what every leading memory framework (LangMem, Mem0, Letta) treats as the highest-signal tier.
