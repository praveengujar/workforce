---
name: workforce-clean
description: Bulk clean up stuck, orphaned, or unrecoverable workforce tasks. Surfaces a categorized preview, then archives + kills on confirmation. Use when the queue is clogged with zombie tasks or Ralph Wiggum loops.
---

When the user invokes /workforce-clean, sweep the task queue for tasks that are no longer making forward progress and offer bulk cleanup.

## Default Action: sweep

Categorize cleanup candidates into three buckets, preview them, and confirm before acting. **Never delete without confirmation** — this skill cancels running processes and archives DB rows, both visible to the user.

## Categories

| Category | Definition | Detection |
|----------|------------|-----------|
| **Stuck** | `pending` or `running` tasks idle past threshold | `workforce_cleanup` with `include_stuck: true` |
| **Orphaned** | `failed` / `rejected` tasks older than threshold, not archived | `workforce_cleanup` default behavior |
| **Unrecoverable** | Ralph Wiggum loops — same error N+ retries, or no progress while running | `workforce_loop_status` `activeLoops[]` |

Threshold defaults to 24h. User overrides parsed from invocation: `older than 48h`, `only stuck`, `only loops`, `aggressive` (= 6h threshold + include all categories).

## Steps

1. Parse user args for threshold + category filters. Default: all three categories, 24h.
2. Run in parallel:
   - `workforce_cleanup` with `dry_run: true`, `include_stuck: true`, `max_age_hours: <threshold>`
   - `workforce_loop_status` (for unrecoverable bucket)
3. Group results by category. Dedupe — a loop-detected task may also appear as stuck; show it under **Unrecoverable** only.
4. Render preview card (template below). If zero candidates, print `No cleanup needed — queue is clean.` and exit.
5. **Use `AskUserQuestion`**:
   - Question: `Clean up {total} task(s)?`
   - Options: `Clean all`, `Only orphaned (safe)`, `Only stuck`, `Only unrecoverable`, `Adjust threshold`, `Cancel`
6. On approval, execute:
   - **Orphaned + Stuck** → `workforce_cleanup` with `dry_run: false` and the user's category filter (set `include_stuck: false` when "Only orphaned").
   - **Unrecoverable** → for each loop-detected task: `workforce_cancel_task`, then `workforce_archive_task`. (The loop tasks are running, so `workforce_cleanup` would handle them via `include_stuck`, but explicit cancel + archive logs a clearer audit trail.)
7. Report final tally: `{archived} archived, {cancelled} processes killed`.

## Preview template

```
━━━ WORKFORCE CLEAN ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Threshold: older than {hours}h

  STUCK ({n})
  ⏸ {id_8}  {status}    {age}   "{prompt_40}..."

  ORPHANED ({n})
  ✗ {id_8}  failed      {age}   "{reason_40}..."
  ✗ {id_8}  rejected    {age}   "{reason_40}..."

  UNRECOVERABLE ({n})
  ⚠ {id_8}  {loopType}  {age}   "{prompt_40}..."

  ─── total: {total} task(s) ──────────────────────
```

Skip empty sections. Format ages as `Xh Ym` or `Xd Yh`.

## User overrides

Parse the invocation string for these phrases:

- `older than 48h` / `older than 6h` → set threshold
- `aggressive` → threshold = 6h, include all categories
- `only stuck` / `only orphaned` / `only loops` → restrict category
- `dry-run` / `preview` → stop after step 4, no `AskUserQuestion`
- `--yes` / `force` → skip `AskUserQuestion`, clean all (use sparingly — confirm in chat that you're skipping the prompt)

## Edge cases

- **Loop-detected task is the user's active focus**: include it but flag inline with `⚠ active focus — confirm before kill`.
- **Task has dependents waiting on it**: warn `⚠ {n} downstream task(s) will fail` before cancelling. Get the dep count from `workforce_task_dependencies`.
- **MCP tool error on one task**: log the error in the tally, continue with the rest. Don't abort the whole batch.

## Related

- `/workforce-cao rescue` — Diagnose individual failures before deciding to clean (use when you want to retry, not archive).
- `/workforce-cao forensics <id>` — Deep investigation for a single complex failure.
- `/workforce` — Dashboard view showing what's currently running, including Ralph Wiggum alerts.
