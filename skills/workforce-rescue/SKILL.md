---
name: workforce-rescue
description: Diagnose and recover failed tasks with retrospective analysis. Classifies failure root cause, analyzes patterns across recent failures, proposes fixes with improved prompts, and surfaces systemic issues. Use when tasks have failed or user wants to investigate failures.
---

When the user invokes /workforce-rescue, diagnose failed tasks, analyze failure patterns, and guide recovery.

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

## Retrospective Analysis

After presenting diagnosis cards, run a mini-retro on recent failures to surface systemic issues.

### Steps

1. Call `workforce_health_metrics` to get success/failure/retry rates
2. Call `workforce_list_evals` to get recent failure evaluations
3. Call `workforce_cost_summary` to understand cost impact of failures
4. Analyze patterns across all recent failures (not just current batch)

### Failure Retro Template

```
━━━ RESCUE RETRO ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Period: Last 7 days

FAILURE PATTERNS
  {category}: {count} failures ({pct}% of total) {trend ↑↓→}
  {category}: {count} failures ({pct}% of total) {trend ↑↓→}
  {category}: {count} failures ({pct}% of total) {trend ↑↓→}

COST IMPACT
  Failed task spend: ${cost} ({pct}% of total spend)
  Retry overhead:    ${cost} (from {count} retries)
  Wasted:            ${cost} (tasks that failed and were not retried)

SYSTEMIC ISSUES
  {if same root cause appears 3+ times:}
  ⚠ Recurring: "{root_cause}" — appeared {count} times
    Suggested fix: {systemic fix — e.g., create knowledge rule, update prompt template}

  {if failure rate > 30%:}
  ⚠ High failure rate ({pct}%) — consider:
    - Are prompts specific enough? (run /workforce-rubberduck)
    - Are knowledge rules up to date? (run /workforce-eval)
    - Is task complexity correctly estimated? (check tier distribution)

PREVENTIVE ACTIONS
  {if unprocessed evals:}
  → {count} unprocessed evals — run /workforce-eval to create preventive rules
  {if no rules for common failure paths:}
  → Missing rules for {paths} — run /workforce-rules to add
  {if high retry rate:}
  → Retry rate {pct}% — consider /workforce-decompose for complex tasks
```

### Knowledge Rule Suggestions

When recurring failures point to a pattern:
1. Draft a knowledge rule that would prevent the failure category
2. Offer to create it via `workforce_create_rule`:
   - Path: derived from the failing tasks' file patterns
   - Category: mapped from failure category (zero_work → `workflow`, merge_failure → `patterns`)
   - Priority: 7+ for recurring issues
3. If the user approves, create the rule and note it in the retro summary

### Integration with /workforce-retro

The rescue retro is a focused subset of `/workforce-retro`. When the user wants broader analysis (velocity, code quality, wins), suggest running the full retro.
