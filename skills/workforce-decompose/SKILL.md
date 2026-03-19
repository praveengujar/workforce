---
name: workforce-decompose
description: Break a complex task into smaller subtasks suitable for individual agent runs. Use when a task is too broad for a single agent.
---

When the user invokes /workforce-decompose, decompose a complex prompt into focused subtasks.

## Steps

1. Take the user's prompt (provided as argument or ask for it)
2. Analyze and break into subtasks, each completable by a single agent in <10 minutes
3. Present the decomposition using the template below
4. Wait for user decision: launch all, launch specific, or modify

## Formatting Rules

- **Tier indicator**: `○` simple ($0.05), `●` medium ($0.25), `◉` complex ($0.50)
- **Dependencies**: Use phase groupings — parallel tasks in same phase, sequential across phases
- **Prompt text**: Keep concise but specific (name files, functions, behavior)
- For each selected subtask, call `workforce_create_task`

## Template

```
━━━ DECOMPOSITION ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Original: "{original_prompt}"

SUBTASKS ({count} tasks, ~${total_cost} total)
┌─────┬──────────┬────────┬─────────────────────────────────────┐
│  #  │   Tier   │  Cost  │ Prompt                              │
├─────┼──────────┼────────┼─────────────────────────────────────┤
│  1  │ {ind} {t}│ ${est} │ {subtask_prompt}                    │
│  2  │ {ind} {t}│ ${est} │ {subtask_prompt}                    │
│  3  │ {ind} {t}│ ${est} │ {subtask_prompt}                    │
│  4  │ {ind} {t}│ ${est} │ {subtask_prompt}                    │
└─────┴──────────┴────────┴─────────────────────────────────────┘

EXECUTION ORDER
Phase 1 (parallel):   #{n}, #{n}
Phase 2 (sequential): #{n} ← depends on #{dep}
Phase 3 (parallel):   #{n}

➤ Launch all, launch specific (#), or modify?
```

## Decomposition Principles

- Prefer many small tasks over few large ones
- Each task should touch a bounded set of files (ideally <10)
- Separate refactoring from feature work
- Separate backend from frontend changes
- Tests should be their own subtask if substantial
- Include file paths in subtask prompts where possible (e.g., "modify `src/auth/middleware.js` to...")

## Dependency-Aware Launch

When launching subtasks, create them with dependency tracking:

1. Generate a group ID from the original prompt (e.g., "auth-jwt-impl")
2. For each subtask, set:
   - `group`: the group ID
   - `phase`: the phase number from the execution order
   - `depends_on`: array of task IDs from earlier phases that this depends on
3. Phase 1 tasks have no dependencies and launch immediately
4. Phase 2+ tasks wait automatically for their dependencies to complete
5. If a dependency fails, downstream tasks are auto-failed (cascade)

After launch, show the dependency tree:
```
CHAIN: {group_name}
Phase 1: ○ {id_8}, ○ {id_8}     [launching]
Phase 2: ○ {id_8} ← {deps}      [waiting]
Phase 3: ○ {id_8} ← {deps}      [waiting]
```

## After Launch

When the user selects tasks to launch, create them and show:

```
  ✓ Launched {count} tasks:
    ● {id_8}  "{prompt_40}..."
    ● {id_8}  "{prompt_40}..."
```
