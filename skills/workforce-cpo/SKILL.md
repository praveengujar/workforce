---
name: workforce-cpo
description: "Chief Product Officer — backlog management, prioritization, release notes, changelog. Default: backlog."
---

When the user invokes /workforce-cpo, manage the product backlog and releases. Parses first word as action.

## Default Action: backlog

If no action specified, show the backlog.

## Actions

### backlog (default)
Manage work items — add, update, remove, reorder, analyze, launch. `/workforce-cpo`

1. `workforce_backlog_list` to get items
2. Display sorted by priority

```
━━━ BACKLOG ({count} items) ━━━━━━━━━━━━━━━━━━━━━━━━━
 1. ▲ HIGH    {title}   "{description_60}..."
 2. ■ MEDIUM  {title}   "{description_60}..."
 3. ▼ LOW     {title}   "{description_60}..."

➤ add, remove #, reorder, analyze, launch #
```

Actions: `add: {desc}`, `remove #N`, `set #N to high`, `move #N to #1`, `analyze` (AI stack-rank), `launch #N` (create task).

### release
Aggregate completed tasks into release notes. `/workforce-cpo release`

1. `workforce_list_tasks` → filter done + unreleased
2. Group by category (Added, Changed, Fixed, Refactored, Tests)
3. Present draft, suggest version bump
4. On approval: create git tag, archive tasks

```
━━━ RELEASE DRAFT ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Version: {suggested}   Tasks: {count}   Cost: ${total}

## Added
- {description} ({id_8})

## Fixed
- {description} ({id_8})

➤ Tag and release, edit version, or cancel?
```

## Related

- `/workforce-coo sprint` — Launch backlog items as a coordinated batch
- `/workforce-cfo retro` — Review what shipped
