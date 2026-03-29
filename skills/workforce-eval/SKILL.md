---
name: workforce-eval
description: Review and process eval logs — the self-improving feedback loop. Shows unprocessed failure evaluations, converts them into knowledge rules or memory updates. Use to make the system learn from its mistakes.
---

When the user invokes /workforce-eval, review the eval log and process entries.

## Steps

1. Call `workforce_list_evals` with `unprocessed_only: true` to see pending evals
2. Present the eval dashboard using the template below
3. For each unprocessed eval, offer processing options

## Processing Actions

For each eval entry, offer these actions:
- **Create rule** (`rule_created`): Convert the eval's preventive update into a knowledge rule. If `preventive_update` is JSON with {category, name, paths, content}, use it directly. Otherwise create a generic rule from `correct_approach`.
- **Update memory** (`memory_updated`): Append to feedback.jsonl for quick injection into future tasks.
- **Dismiss** (`dismissed`): Mark as processed with no action (false positive, already fixed, etc.)
- **Skip**: Leave unprocessed for later review.

Call `workforce_process_eval` with the chosen action.

## Template — Eval Dashboard

```
━━━ EVAL LOG ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

STATS
  Total evals: {total}  |  Unprocessed: {unprocessed}
  Top categories: {cat1} ({n}), {cat2} ({n}), {cat3} ({n})
  By severity: critical ({n}), high ({n}), medium ({n}), low ({n})

UNPROCESSED ({count})
┌──────┬───────────────┬──────────┬──────────────────────────────────────┐
│  ID  │  Category     │ Severity │ What Happened                        │
├──────┼───────────────┼──────────┼──────────────────────────────────────┤
│ {id} │ {category}    │ {sev}    │ {what_happened_truncated}            │
│ {id} │ {category}    │ {sev}    │ {what_happened_truncated}            │
└──────┴───────────────┴──────────┴──────────────────────────────────────┘

➤ Process eval (ID)? Or process all?
```

## Eval Detail Template

```
━━━ EVAL: {id} ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Category:   {category}
Severity:   {severity}
Detection:  {detection}
Task:       {taskId or "none"}
Created:    {createdAt}

What happened:
  {whatHappened}

Root cause:
  {rootCause}

Correct approach:
  {correctApproach}

Preventive update:
  {preventiveUpdate}

Rule violated:
  {ruleViolated or "NO RULE EXISTS"}

➤ Create rule, update memory, dismiss, or skip?
```

## Three-Output Model

Every eval entry represents:
1. **Diagnostic** (the eval itself) — what went wrong, why the system didn't prevent it
2. **Preventive** (create rule) — a knowledge rule to prevent recurrence
3. **Quick-ref** (update memory) — a feedback.jsonl entry for immediate context

The feedback loop closes when an eval is processed: the system literally learns from the failure and encodes the lesson as a rule or memory entry.

## Batch Processing

When the user says "process all", iterate through unprocessed evals:
- For evals with `preventive_update` containing valid JSON: auto-create rules
- For evals without `preventive_update`: offer to dismiss or skip
- Show a summary of what was created/updated/dismissed

## How Evals Are Created

Evals are created automatically by:
1. **Recovery engine** — when a failure pattern is detected (zombie, ghost runner, rate limit)
2. **SessionEnd hook** — analyzes recent failed tasks at session end
3. **Manual** — via `workforce_create_eval` from /workforce-rescue or failure-forensics agent
