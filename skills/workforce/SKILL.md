---
name: workforce
description: Show workforce dashboard — running tasks, pending queue, recent completions, health metrics, and cost summary. Use when user wants task status overview.
---

When the user invokes /workforce, display a compact visual dashboard.

## Steps

1. Call `workforce_list_tasks` to get all active tasks
2. Call `workforce_health_metrics` to get performance data
3. Call `workforce_cost_summary` to get cost data

## Formatting Rules

- **Elapsed time**: Compute from `startedAt` or `createdAt` to now. Format as `Xm Ys` (e.g., `3m 12s`). If over 1 hour: `Xh Ym`.
- **Progress bars**: 10 chars wide. `▰` for filled, `▱` for empty. Count = round(value * 10). Example: 87% = `▰▰▰▰▰▰▰▰▱▱`
- **Status indicators**: `●` running, `○` pending, `◆` review, `✓` done, `✗` failed, `⏸` paused
- **Prompt truncation**: Truncate to 40 chars, append `...` if longer
- **Skip empty sections**: If there are no pending tasks, omit the PENDING section entirely. Same for REVIEW NEEDED.
- **Task ID**: Show first 8 characters only
- **Pass/fail on metrics**: Compare actual to target. `✓` if meeting target, `✗` if in warning zone

## Template

Reproduce this layout exactly, substituting real values for `{placeholders}`:

```
━━━ WORKFORCE DASHBOARD ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  RUNNING ({running_count}/{max_slots} slots)
  ● {id_8}  {elapsed}  {project}   "{prompt_40}..."
  ● {id_8}  {elapsed}  {project}   "{prompt_40}..."

  PENDING ({pending_count} queued)
  ○ {id_8}  {project}   "{prompt_40}..."

  REVIEW NEEDED ({review_count} awaiting approval)
  ◆ {id_8}  {project}   "{prompt_40}..."   +{adds} -{dels}

  RECENT (last 3)
  ✓ {id_8}  done     ${cost}   "{prompt_40}..."
  ✗ {id_8}  failed   ${cost}   "{prompt_40}..."

  ─── health ────────────────────────────────────────────
  Success {pct}%  {bar}  target 85% {pass}
  One-shot {pct}%  {bar}  target 70% {pass}

  ─── cost ──────────────────────────────────────────────
  Today ${today} │ Week ${week} │ Month ${month}
```

For RECENT, show the last 3 completed tasks (done or failed, most recent first). Include cost if available, $0.00 if not.

For health, only show Success rate and One-shot rate to keep it compact. If there are improvement suggestions from the API, add a single line: `  ⚠ {suggestion text}`

If the workforce is completely idle (no running, no pending, no review), show:

```
━━━ WORKFORCE DASHBOARD ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  All quiet. No active tasks.

  ─── health ────────────────────────────────────────────
  ...
  ─── cost ──────────────────────────────────────────────
  ...
```
