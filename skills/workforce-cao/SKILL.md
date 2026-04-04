---
name: workforce-cao
description: "Chief Audit Officer — diagnose failed tasks, failure forensics, bulk cleanup of stale tasks. Default: rescue."
---

When the user invokes /workforce-cao, diagnose failures and maintain task hygiene. Parses first word as action.

## Default Action: rescue

If no action specified, diagnose failed tasks.

## Actions

### rescue (default)
Diagnose and recover failed tasks. `/workforce-cao` or `/workforce-cao rescue`

1. `workforce_list_tasks` with `status_filter: "failed"` (max 5, most recent first)
2. For each: `workforce_task_events` + `workforce_task_output`
3. Classify root cause:

| Category | Pattern | Recovery |
|----------|---------|----------|
| Timeout | "timed out" | Retry narrower scope or decompose |
| Zero-work | "No files changed" | Rewrite with specific files/functions |
| Merge conflict | "CONFLICT" | Retry after resolving on target |
| Rate limit | "rate limit", "529" | Wait (auto-handled by recovery engine) |
| Binary missing | "ENOENT" | Check Claude CLI installation |
| Budget exceeded | "Budget exceeded" | Increase budget or reduce scope |
| Dependency failed | "Dependency failed" | Fix upstream first |
| Agent error | Exit code != 0 | Analyze output, rewrite prompt |

4. Present diagnosis card, propose recovery
5. After all cards: run failure pattern analysis (`workforce_health_metrics` + `workforce_list_evals`)

```
━━━ CAO RESCUE: {id_8} ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Prompt:   {prompt}
Category: {category}
Error:    {error_200}

DIAGNOSIS: {2-3 sentences}
RECOVERY:  {action + improved prompt if applicable}
```

After each diagnosis card, **MUST use `AskUserQuestion`**:
- Question: "Task {id} ({category}): {error_summary}. Action?"
- Options: "Retry with fix", "Archive (resolved)", "Skip (handle later)"
- If loopDetected: add option "Analyze (switch to investigation mode)"

Failure patterns:
```
━━━ FAILURE PATTERNS ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  {category}: {count} ({pct}%) {trend}
  {if recurring:} ⚠ suggest /workforce-cio rules
  {if unprocessed evals:} → run /workforce-cio eval
```

Batch mode: `{n} failed: {retryable} retryable, {rewrite} needs-rewrite, {archivable} archivable`

### forensics
Deep-dive investigation into a specific failure. `/workforce-cao forensics <task_id>`

Spawns the cao-forensics agent for competing hypotheses analysis. For complex failures where rescue's pattern-matching isn't enough.

### cleanup
Bulk archive stale failed/rejected/stuck tasks. `/workforce-cao cleanup`

1. `workforce_cleanup` with `dry_run: true`, default `max_age_hours: 24`
2. Show preview: failed, rejected, stuck tasks with age
3. On approval: `workforce_cleanup` with `dry_run: false`

```
━━━ CLEANUP PREVIEW ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
{count} tasks older than {hours}h:
  ✗ {id_8}  failed   "{reason}"
  ✗ {id_8}  rejected "{reason}"
➤ Clean up all, adjust threshold, or cancel?
```

User overrides: "older than 48h", "only failed", "include stuck".

## Related

- `/workforce-cio eval` — Process failure evals into preventive rules
- `/workforce-cfo retro` — Systemic failure trend analysis
- cao-forensics agent — Deep investigation for complex failures
