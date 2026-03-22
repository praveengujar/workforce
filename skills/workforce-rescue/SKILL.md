---
name: workforce-rescue
description: Diagnose and recover failed tasks. Classifies failure root cause, proposes fix, and offers retry with improved prompt. Use when tasks have failed or user wants to investigate failures.
---

When the user invokes /workforce-rescue, diagnose failed tasks and guide recovery.

## Steps

1. Call `workforce_list_tasks` with `status_filter: "failed"` to get failed tasks.
2. If no failed tasks, report all clear and show last 3 completed tasks as context.
3. For each failed task (most recent first, max 5):
   a. Call `workforce_task_events` to get the lifecycle timeline
   b. Call `workforce_task_output` to get the last output/error
   c. Classify the failure root cause (see categories below)
   d. Present the diagnosis card
   e. Propose a recovery action
4. On user approval: execute the recovery action (retry, archive, or skip)

## Failure Categories

Classify each failure into exactly one category:

| Category | Pattern | Recovery |
|----------|---------|----------|
| **Timeout** | "timed out", "killed after" | Retry with narrower scope or decompose |
| **Zero-work** | "No files changed", "zero-work guard" | Rewrite prompt to be more specific |
| **Merge conflict** | "merge failed", "CONFLICT" | Retry after resolving conflict on target branch |
| **Rate limit** | "rate limit", "529", "overloaded" | Wait and retry (auto-handled by recovery engine) |
| **Binary missing** | "ENOENT", "not found" | Check Claude CLI installation |
| **Budget exceeded** | "Budget exceeded" | Increase budget or reduce task scope |
| **Dependency failed** | "Dependency failed" | Fix upstream task first, then retry |
| **Agent error** | Exit code != 0, other errors | Analyze output for root cause, rewrite prompt |

## Template — Diagnosis Card

```
━━━ RESCUE: {id_8} ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Prompt:    {full prompt}
Failed:    {completedAt}   Duration: {elapsed}
Category:  {failure_category}
Error:     {error_message_truncated_to_200}

TIMELINE
{timestamp}  {phase}  {detail}
{timestamp}  {phase}  {detail}
...

DIAGNOSIS
{2-3 sentence root cause analysis}

RECOVERY
  {action_icon} Recommended: {action_description}
  Improved prompt: "{rewritten_prompt}" (if applicable)

➤ Retry with fix, Archive, or Skip?
```

## Prompt Rewriting Rules

When proposing a retry with an improved prompt:
- If zero-work: add specific file paths, function names, and expected behavior
- If timeout: reduce scope — split into smaller pieces
- If agent error: add constraints based on what went wrong (e.g., "do not modify X")
- If merge conflict: add instruction to check for recent changes on target branch first
- Preserve the original intent — do not change what the task is trying to accomplish

## Batch Mode

If multiple tasks failed, after showing all diagnosis cards, offer:
```
━━━ RESCUE SUMMARY ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
{count} failed tasks analyzed:
  {count} retryable    {count} needs-rewrite    {count} blocked

➤ Retry all retryable, or handle individually?
```

Process them one at a time unless the user asks for batch retry.
