---
name: workforce-coo
description: "Chief Operating Officer — launch tasks, create chains, run sprints, decompose complex work. Default: launch."
---

When the user invokes /workforce-coo, execute task operations. Parses the first word as the action.

## Default Action: launch

If no action specified, treat the argument as a launch prompt.

## Actions

### launch (default)
Spawn a new autonomous task. `/workforce-coo "fix the login bug"` or `/workforce-coo launch "fix the login bug"`

1. Call `workforce_analyze_prompt` to check admission, tier, cost
2. Call `workforce_get_cost_policy` — reject if over cap
3. **If cost exceeds confirmation threshold**: **MUST use `AskUserQuestion`**:
   - Question: "Estimated ~${cost} exceeds ${threshold} threshold. Proceed?"
   - Options: "Launch anyway", "Reduce scope first", "Cancel"
4. If not admitted: show rejection, offer to refine or decompose
5. If dependencies specified: resolve and add `depends_on`
6. Call `workforce_create_task` with prompt, project (cwd basename), autoMerge: false

```
┌─ LAUNCH ───────────────────────────────────────────┐
│ Prompt:  {full prompt}                             │
│ Tier:    {○●◉} {tier}   Cost: ~${est}             │
│ Project: {project}   Review: manual                │
└────────────────────────────────────────────────────┘
✓ Task {id_8} created — {running now|position N in queue}
```

### chain
Create sequential dependent tasks. `/workforce-coo chain`

1. Take a numbered list of task prompts from the user
2. Validate each via `workforce_analyze_prompt`
3. **Chain reasoning** — before creating dependencies:
   - **Order validation**: For each pair of adjacent tasks: "If task N fails, can task N+1 still produce value?" If yes → they might not need to be chained (could run in parallel). If no → the dependency is correct.
   - **Single point of failure**: Is there one task that, if it fails, blocks everything downstream? If so, is that task simple enough to have high confidence? If not, add an analysis task first.
4. Generate group ID, assign phases, set `depends_on` to previous task
5. Create all via `workforce_create_task`

```
━━━ CHAIN: {group} ({count} tasks) ━━━━━━━━━━━━━━━━━━
Phase 1: ○ {id_8}  "{prompt_40}..."
    ↓
Phase 2: ○ {id_8}  "{prompt_40}..."  ← {dep_id_8}
    ↓
Phase 3: ○ {id_8}  "{prompt_40}..."  ← {dep_id_8}
```

### sprint
Batch-launch backlog items with dependency phasing. `/workforce-coo sprint`

1. `workforce_backlog_list` to get items
2. Present sorted by priority. Ask which to include (or "all high priority")
3. Group into parallel phases by dependency
4. On approval: create all tasks, delete launched items from backlog

```
━━━ SPRINT: {group} ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Phase 1 (parallel):  ○ {id_8}  ○ {id_8}
Phase 2 (sequential): ○ {id_8} ← {deps}
Total: ~${cost}
```

### decompose
Break a complex prompt into subtasks. `/workforce-coo decompose "big refactor"`

1. **Decomposition reasoning** — before generating subtasks:
   - **Is decomposition even needed?** If the change touches <5 files and has no cross-layer deps, launch directly. Decomposing a simple task into 2 subtasks adds coordination cost for no benefit.
   - **Boundary selection**: Where do you cut? By layer (backend/frontend — good for full-stack), by behavior (each user story — good for independent features), or by phase (analyze → implement → test — good for unknowns). Pick ONE strategy and state why.
   - **Isolation test** (per subtask): Can this subtask compile and pass tests in its worktree WITHOUT the others? If not, it needs a dependency or it's split wrong.
2. Break into subtasks completable in <10 min each
3. Present decomposition table with tiers, costs, execution phases
4. On approval: create all tasks with group, phase, depends_on

Supports **analyze-then-fix pattern** when the task involves debugging or finding what's missing:
- Phase 1: analysis task (`task_type: "analysis"`) investigates
- Phase 2+: targeted fix tasks depend on analysis, each addressing one finding

```
━━━ DECOMPOSITION ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Original: "{prompt}"
SUBTASKS ({count}, ~${total})
  #1  {○●◉}  ${est}  {prompt}
  #2  {○●◉}  ${est}  {prompt}  ← #1
➤ Launch all, specific (#), or modify?
```

## Conversation Style

- Don't over-ask. Use sensible defaults (project=cwd, autoMerge=false)
- Parse natural language: "first do X, then Y, then Z" → chain
- "launch top 3 from backlog" → sprint with top 3

## Related

- `/workforce-ceo` — Full gated orchestration (CEO oversees, COO executes)
- `/workforce-cto` — Review the work COO launched
