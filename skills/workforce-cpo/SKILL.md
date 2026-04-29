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

#### Prioritization Reasoning (mandatory before reorder/analyze)

Default action is the user-facing entry point — bad orderings here mislead the human. Before reordering or rendering analysis, complete this:

- **Impact-vs-loudness check**: Is this item high-priority because it delivers measurable value, or because someone is asking loudly? "Loud" requests cluster at the top by default — verify each top-3 item against actual user benefit, not request volume.
- **Dependency-blocking detection**: Walk the list — does any later item depend on an earlier item not being done first? An item that unblocks 3 others outranks a higher-impact item that unblocks nothing. Scan for hidden dependency edges before scoring.
- **Effort honesty test**: Has this item been attempted before? If yes, the effort estimate goes UP, not stays flat — re-attempts hit the same blockers. Does it need investigation first? If yes, split into an analysis task ahead of it.
- **Sanity check**: After ordering, look at the final ranking. If item #5 intuitively feels more important than item #1, the scoring weights are wrong. Adjust weights and re-score, don't override one item.

For deep autonomous prioritization, hand off to `cpo-analyst` agent (which has the full scoring framework).

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
