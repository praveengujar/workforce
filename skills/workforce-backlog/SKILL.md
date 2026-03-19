---
name: workforce-backlog
description: Manage the task backlog — add, update, remove, reorder, and analyze backlog items. Use when user wants to plan work for agents.
---

When the user invokes /workforce-backlog, show the backlog and handle management actions.

## Steps

1. Call `workforce_backlog_list` to get current items
2. Display the backlog using the template below
3. Wait for user action (add, remove, reorder, analyze, launch)

## Actions

- **add**: Call `workforce_backlog_add` — user says "add: implement dark mode" or similar
- **remove**: Call `workforce_backlog_delete` — user says "remove #3" or "delete the last one"
- **update**: Call `workforce_backlog_update` — user says "change #2 priority to high"
- **reorder**: Call `workforce_backlog_reorder` — user says "move #4 to top"
- **analyze**: Use your own reasoning to stack-rank by impact/urgency, suggest combinations or splits
- **launch**: Call `workforce_create_task` with the item's title+description as the prompt — user says "launch #1" or "launch top 3"

## Formatting Rules

- **Priority indicators**: `▲ HIGH` (urgent), `■ MEDIUM` (standard), `▼ LOW` (backlog)
- **Numbering**: 1-based, matches display order
- **Description**: Show on second line, indented, in quotes. Truncate at 60 chars.
- **Empty backlog**: Show "Backlog is empty. Say 'add: {description}' to create an item."

## Template

```
━━━ BACKLOG ({count} items) ━━━━━━━━━━━━━━━━━━━━━━━━━━━

 1. {▲|■|▼} {HIGH|MEDIUM|LOW}    {title}
              "{description_60}..."
 2. {▲|■|▼} {HIGH|MEDIUM|LOW}    {title}
              "{description_60}..."
 3. ...

➤ add, remove #, reorder, analyze, launch #
```

## Conversation Style

Be conversational after showing the backlog. The user can:
- `"add: implement rate limiting"` — add with medium priority (default)
- `"remove #2"` — delete item at position 2
- `"what should we work on next?"` — analyze and recommend top pick with reasoning
- `"launch #1 and #3"` — create tasks from those items
- `"move #4 to #1"` — reorder
- `"set #3 to high priority"` — update priority

After any mutation, re-display the updated backlog.
