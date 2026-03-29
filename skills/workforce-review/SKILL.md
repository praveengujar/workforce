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

Then run the **weighted scoring system**:

### Scoring

1. Call `workforce_get_rules_for_path` with the changed file paths
2. Check each rule against the diff — does the code comply?
3. Score each category 0-3 (0=fail, 1=poor, 2=good, 3=excellent):

```
REVIEW SCORE
┌─────────────────┬────────┬───────┬─────────────────────────────┐
│ Category        │ Weight │ Score │ Notes                       │
├─────────────────┼────────┼───────┼─────────────────────────────┤
│ Correctness     │   3x   │  {s}  │ Does it solve the task?     │
│ Security        │   3x   │  {s}  │ No new vulnerabilities?     │
│ Test coverage   │   2x   │  {s}  │ Are changes tested?         │
│ Code quality    │   2x   │  {s}  │ Clean, idiomatic code?      │
│ Rule compliance │   2x   │  {s}  │ Follows knowledge rules?    │
│ Scope           │   1x   │  {s}  │ No unrelated changes?       │
├─────────────────┼────────┼───────┼─────────────────────────────┤
│ Weighted total  │        │ {pct} │ {status}                    │
└─────────────────┴────────┴───────┴─────────────────────────────┘
```

**Thresholds**:
- >= 65%: Recommend APPROVE
- 50-64%: Recommend CONDITIONAL APPROVE with fix suggestions
- < 50%: Recommend REJECT with specific issues to fix
- Any Security score of 0: override to REJECT regardless of total

Then your analysis (2-3 sentences max) and:

```
➤ Approve (merge to target branch) or Reject?
```

If there are multiple tasks in review, process them one at a time — show the first, wait for user decision, then show the next.
