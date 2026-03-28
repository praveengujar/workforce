---
name: workforce-rescue
description: Diagnose and recover failed tasks. Classifies root cause, proposes fix with improved prompt. Includes failure pattern analysis. For systemic trends, use /workforce-retro.
---

When the user invokes /workforce-rescue, diagnose failed tasks and guide recovery.

## Steps

1. Call `workforce_list_tasks` with `status_filter: "failed"` to get failed tasks
2. If none: report all clear, show last 3 completed tasks as context
3. For each failed task (most recent first, max 5):
   a. Call `workforce_task_events` for lifecycle timeline
   b. Call `workforce_task_output` for last output/error
   c. Classify root cause (see categories)
   d. Present diagnosis card
   e. Propose recovery action
4. On approval: execute recovery (retry, archive, or skip)
5. After all cards: run failure pattern analysis

## Failure Categories

| Category | Pattern | Recovery |
|----------|---------|----------|
| **Timeout** | "timed out", "killed after" | Retry narrower scope or decompose |
| **Zero-work** | "No files changed" | Rewrite prompt with specific files/functions |
| **Merge conflict** | "merge failed", "CONFLICT" | Retry after resolving on target branch |
| **Rate limit** | "rate limit", "529" | Wait and retry (auto-handled by recovery engine) |
| **Binary missing** | "ENOENT", "not found" | Check Claude CLI installation |
| **Budget exceeded** | "Budget exceeded" | Increase budget or reduce scope |
| **Dependency failed** | "Dependency failed" | Fix upstream task first |
| **Agent error** | Exit code != 0 | Analyze output, rewrite prompt |

## Diagnosis Card

```
━━━ RESCUE: {id_8} ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Prompt:    {full prompt}
Failed:    {completedAt}   Duration: {elapsed}
Category:  {category}
Error:     {error_200}

TIMELINE
{timestamp}  {phase}  {detail}

DIAGNOSIS
{2-3 sentence root cause}

RECOVERY
  Recommended: {action}
  Improved prompt: "{rewritten}" (if applicable)

➤ Retry with fix, Archive, or Skip?
```

## Prompt Rewriting

- Zero-work: add file paths, function names, expected behavior
- Timeout: reduce scope — split into pieces
- Agent error: add constraints based on what went wrong
- Merge conflict: add instruction to check target branch first
- Always preserve original intent

## Failure Pattern Analysis

After diagnosis cards, run a quick pattern check:

1. Call `workforce_health_metrics` and `workforce_list_evals`
2. Group failures by category, identify recurring root causes
3. If same root cause appears 3+ times: flag as systemic, suggest knowledge rule
4. If unprocessed evals exist: suggest `/workforce-eval`

```
━━━ FAILURE PATTERNS ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  {category}: {count} ({pct}%) {trend}
  {if recurring:} ⚠ Recurring: suggest /workforce-rules to prevent
  {if unprocessed:} → {n} evals pending — run /workforce-eval
```

## Batch Mode

If multiple failures, after all cards:
```
{count} failed: {retryable} retryable, {rewrite} needs-rewrite, {blocked} blocked
➤ Retry all retryable, or handle individually?
```

## Related

- `/workforce-retro`: Systemic velocity and failure trend analysis (weekly/sprint level)
- `/workforce-eval`: Process failure evals into preventive knowledge rules
- failure-forensics agent: Deep investigation with competing hypotheses (spawn for complex failures)
