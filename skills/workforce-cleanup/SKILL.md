---
name: workforce-cleanup
description: Clean up old failed, rejected, and stuck tasks. Preview first with dry run, then archive in bulk. Use when the task list is cluttered with dead tasks.
---

When the user invokes /workforce-cleanup, clean up stale tasks.

## Steps

1. First, run a dry run to show what would be cleaned up:
   - Call `workforce_cleanup` with `dry_run: true` and `include_stuck: true`
   - Default `max_age_hours: 24` (tasks older than 24h)

2. Present the cleanup preview:

```
━━━ CLEANUP PREVIEW ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Found {count} tasks to clean up (older than {hours}h):

  ✗ {id_8}  failed     "{reason}"
  ✗ {id_8}  rejected   "{reason}"
  ● {id_8}  stuck running  (started {age} ago)
  ○ {id_8}  stuck pending  (created {age} ago)

➤ Clean up all, adjust age threshold, or cancel?
```

3. On approval, call `workforce_cleanup` with `dry_run: false` and the same parameters.

4. Report results:

```
✓ Cleaned up {total} tasks ({cancelled} cancelled, {archived} archived)
```

## Parameters

If the user specifies a time threshold, use it:
- "clean up tasks older than 48 hours" → `max_age_hours: 48`
- "clean up everything" → `max_age_hours: 0`
- "only failed tasks" → `include_stuck: false`
- "include stuck ones too" → `include_stuck: true`

Default: 24 hours, failed/rejected only (no stuck tasks unless asked).
