---
name: workforce-sprint
description: Pull items from the backlog, group into phased dependency chains, and launch as a coordinated batch. Use when user wants to execute multiple backlog items as a sprint.
---

When the user invokes /workforce-sprint, orchestrate a batch launch from the backlog.

## Steps

1. Call `workforce_backlog_list` to get all backlog items
2. If backlog is empty, say so and offer to add items
3. Present the backlog sorted by priority with effort estimates
4. Ask the user which items to include in the sprint (or "all high priority")
5. For selected items:
   a. Call `workforce_analyze_prompt` on each item's description to validate scope
   b. Group items into execution phases based on dependencies and parallizability
   c. Generate a sprint group ID (e.g., "sprint-2026-03-20")
6. Present the sprint plan for confirmation
7. On approval: create all tasks via `workforce_create_task` with `group`, `phase`, and `depends_on`
8. Remove launched items from backlog via `workforce_backlog_delete`
9. Show the sprint launch card

## Phasing Rules

- Items with no dependencies → Phase 1 (parallel)
- Items that depend on Phase 1 outputs → Phase 2
- Continue until all items are phased
- If user specifies ordering ("do X before Y"), honor it as a dependency
- If items are independent, maximize parallelism

## Template — Sprint Plan

```
━━━ SPRINT PLAN ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Group: {sprint_group_id}
Items: {count}   Est. cost: ~${total}

Phase 1 (parallel):
  ○ #{n}  {tier}  ${est}  "{title}"
  ○ #{n}  {tier}  ${est}  "{title}"

Phase 2 (after Phase 1):
  ○ #{n}  {tier}  ${est}  "{title}"  ← depends on #{dep}

Phase 3 (after Phase 2):
  ○ #{n}  {tier}  ${est}  "{title}"  ← depends on #{dep}

➤ Launch sprint, modify, or cancel?
```

## Template — Sprint Launched

```
━━━ SPRINT LAUNCHED ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Group: {sprint_group_id}   Tasks: {count}

Phase 1: ○ {id_8}  ○ {id_8}     [launching]
Phase 2: ○ {id_8}              [waiting for Phase 1]
Phase 3: ○ {id_8}              [waiting for Phase 2]

Total est. cost: ~${total}
Track progress: /workforce or workforce_group_status
```

## Conversation Style

- Don't over-ask. If user says "launch high priority items", do it.
- Use backlog item titles as the base for task prompts, but expand them to be agent-ready (add file paths, specifics).
- Default project = current directory basename.
