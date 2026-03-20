---
name: workforce-merge
description: Pre-merge conflict check and guided merge for tasks in review. Scans for conflicts before approving, auto-resolves safe files, generates fix-up tasks for real conflicts. Use when merging tasks to main.
---

When the user invokes /workforce-merge, perform safe merges with conflict prevention.

## Steps

1. Call `workforce_list_tasks` with `status_filter: "review"` to get mergeable tasks
2. If no tasks in review, report nothing to merge
3. For each task in review:
   a. Call `workforce_get_diff` to see the changes
   b. Run a pre-merge conflict check (see below)
   c. Present the merge readiness card
   d. If clean: offer to approve (merge)
   e. If conflicts: show conflict details and propose resolution

## Pre-Merge Conflict Check

For each review task, assess merge readiness:
- **Clean**: No conflicts expected — safe to approve
- **Auto-resolvable**: Only conflicts in known-safe files (lockfiles, generated files, status.md) — approve with auto-resolve note
- **Needs attention**: Real conflicts in source files — show conflicting files and suggest fix approach

## Template — Merge Readiness

```
━━━ MERGE: {id_8} ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Prompt:  {full prompt}
Branch:  wf/{id_8}   Files: {file_count}   +{adds} -{dels}

STATUS: {Clean ✓ | Auto-resolvable ⚠ | Conflicts ✗}

{if conflicts:}
CONFLICTS ({conflict_count} files):
  ✗ {filepath} — {description of conflict}
  ✗ {filepath} — {description of conflict}

SUGGESTED RESOLUTION:
  {resolution_approach}

{if clean:}
No conflicts detected. Safe to merge.

➤ Approve (merge), or Skip?
```

## Batch Merge

When multiple tasks are in review:
```
━━━ MERGE QUEUE ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
{count} tasks ready for merge:

  ✓ {id_8}  Clean       "{prompt_40}..."
  ⚠ {id_8}  Auto-resolve "{prompt_40}..."
  ✗ {id_8}  Conflicts    "{prompt_40}..."

➤ Merge all clean, merge individually, or skip?
```

Process clean merges first, then auto-resolvable, then skip conflicts (or offer to create fix-up tasks).

## Merge Order

When merging multiple tasks, order by:
1. Tasks with no file overlap (safe to merge in any order)
2. Smallest diffs first (less risk)
3. Older tasks first (longer in queue)

After each merge, re-check remaining tasks for new conflicts introduced by the merge.
