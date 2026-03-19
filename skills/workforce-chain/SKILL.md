---
name: workforce-chain
description: Create a sequence of dependent tasks that execute in order. Each task waits for its predecessor to complete. Use when user has multiple steps that must run sequentially.
---

When the user invokes /workforce-chain, create a chain of dependent tasks from a sequence of prompts.

## Steps

1. Ask the user for the sequence of tasks. They can provide them as:
   - A numbered list in a single message
   - One at a time interactively

2. For each task in the sequence:
   - Validate the prompt via `workforce_analyze_prompt`
   - Assign a phase number (1, 2, 3...)
   - Set `depends_on` to the previous task's ID (except task #1)

3. Generate a group ID (short, descriptive, e.g., "auth-implementation")

4. Create all tasks via `workforce_create_task` with:
   - prompt: the task prompt
   - group: the group ID
   - phase: the sequential phase number
   - depends_on: [previous_task_id] (except first task)
   - project: derived from cwd or user-specified

5. Show the chain visualization

## Template — Chain Created

```
━━━ CHAIN: {group_name} ({count} tasks) ━━━━━━━━━━━━━━━

Phase 1: ○ {id_8}  "{prompt_40}..."
    ↓
Phase 2: ○ {id_8}  "{prompt_40}..."  ← {dep_id_8}
    ↓
Phase 3: ○ {id_8}  "{prompt_40}..."  ← {dep_id_8}

Total estimated cost: ~${total}
Phase 1 launching now — subsequent phases auto-launch on completion.
```

## Conversation Style

The user can specify chains naturally:
- "First create the database schema, then build the API endpoints, then write the tests"
- "1. Add user model  2. Add auth routes  3. Add auth middleware  4. Add tests"

Parse the sequence and create the chain. Don't over-ask — use sensible defaults.
