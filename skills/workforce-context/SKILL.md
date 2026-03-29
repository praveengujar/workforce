---
name: workforce-context
description: View and manage session context — active focus, ongoing investigations, and learned context that persists across sessions. Use to track what you're working on.
---

When the user invokes /workforce-context, show and manage session context.

## Steps

1. Call `workforce_active_focus` with the current project to get context overview
2. Present the context dashboard
3. Offer actions: set focus, add context, clear stale entries

## Actions

### Set Active Focus
Ask what the user is currently working on. Call `workforce_session_context` with:
- action: "set"
- project: current project name
- key: "active_focus"
- value: the focus description

### Add Context Note
For recording important context (known issues, decisions, constraints):
- action: "set"
- key: descriptive key like "known_issues", "constraints", "investigation_notes"
- value: the context content

### View All Context
Call `workforce_session_context` with action "list" to see all entries.

### Clear Context
- Clear a specific key: action "clear" with key
- Clear all for project: action "clear" without key

## Template — Context Dashboard

```
━━━ SESSION CONTEXT: {project} ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

ACTIVE FOCUS
  {active_focus or "No active focus set"}

CONTEXT ENTRIES
┌──────────────────┬──────────────────────────────────────────┐
│ Key              │ Value                                    │
├──────────────────┼──────────────────────────────────────────┤
│ {key}            │ {value_truncated}                        │
│ {key}            │ {value_truncated}                        │
└──────────────────┴──────────────────────────────────────────┘

Last updated: {most_recent_updatedAt}

➤ Set focus, add context, clear, or done?
```

## How Session Context Works

Session context is injected into agent task prompts automatically. When a task is spawned:
1. The worker manager queries session context for the task's project
2. Active focus and context entries are appended to the effective prompt as `[Session Context]`
3. Agents get awareness of what you're investigating, known issues, and constraints

This enables multi-session workflows: start investigating in one session, set context notes, pick up where you left off in the next session.

## Tips

- Set `active_focus` to what you're currently working on — agents will prioritize accordingly
- Use `known_issues` for bugs or limitations agents should be aware of
- Use `constraints` for "don't touch X" or "must use Y" requirements
- Context persists until explicitly cleared — review and prune regularly
- Session context is project-scoped — different projects have independent contexts
