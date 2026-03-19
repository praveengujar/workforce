---
name: workforce-review
description: Review completed task diffs and approve or reject changes. Use when tasks are awaiting review or user wants to inspect agent output.
---

When the user invokes /workforce-review, show tasks awaiting review and guide through approval.

## Steps

1. Call `workforce_list_tasks` and filter for status="review"
2. If no tasks in review, say so and show last 3 completed tasks as context.
3. For each task in review:
   a. Call `workforce_get_diff` with the task_id
   b. Present the review card with file summary table
   c. Show the diff in a ```diff code block
   d. Provide a brief summary of what changed and any concerns
   e. Ask for approve or reject
4. On approve: Call `workforce_approve_task`, report merge result
5. On reject: Call `workforce_reject_task`, report cleanup

## Formatting Rules

- **Elapsed time**: From `startedAt` to now, formatted as `Xm Ys`
- **File table**: Box-drawing characters, right-aligned numbers
- **Large diffs** (>200 lines): Summarize changes first, then offer to show full diff or specific files
- **Security callouts**: Flag new dependencies, deleted tests, hardcoded secrets, or changes to auth/permissions with `⚠`

## Template

```
━━━ REVIEW: {id_8} ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Prompt:  {full prompt}
Project: {project}   Branch: wf/{id_8}   Elapsed: {elapsed}

FILES CHANGED ({file_count} files, +{total_adds}, -{total_dels})
┌──────────────────────────────────────┬──────┬──────┐
│ File                                 │   +  │   -  │
├──────────────────────────────────────┼──────┼──────┤
│ {filepath}                           │ {+N} │ {-N} │
│ {filepath}                           │ {+N} │ {-N} │
└──────────────────────────────────────┴──────┴──────┘
```

Then the diff:
````
```diff
{diff content}
```
````

Then your analysis (2-3 sentences max) and:

```
➤ Approve (merge to main) or Reject?
```

If there are multiple tasks in review, process them one at a time — show the first, wait for user decision, then show the next.
