---
name: workforce-gate-status
description: Show current quality gate status for a task — what stages have been completed, what evidence exists, and what's pending. Use to check readiness before approving.
---

When the user invokes /workforce-gate-status, show the quality gate status for a task.

## Steps

1. Get the task ID (from argument or ask)
2. Call `workforce_get_task` for task details
3. Call `workforce_task_events` for the full timeline
4. Analyze events to determine which gates have been passed
5. Present the gate status card

## Gate Detection

Derive gate status from `task_events`:

| Gate | How to Detect | Required For |
|------|--------------|-------------|
| **Created** | `task_created` event exists | All tasks |
| **Rubberduck** | `approval_reason` contains analysis OR task prompt contains acceptance criteria | Complex tasks |
| **Code Complete** | Task status is `review` or later | All tasks |
| **Test Plan** | Event with `test_plan` phase exists | Tasks with UI/API changes |
| **QA Passed** | Dependent QA task exists and is `done` | Tasks with test plan |
| **Human Decision** | `approved` or `rejected` event exists | All tasks before merge |
| **Merged** | `merge_completed` event exists | Approved tasks |

## Template — Gate Status

```
━━━ GATES: {id_8} ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Task:   "{prompt_40}..."
Status: {current_status}

  ✓ Created        {timestamp}
  ✓ Code Complete  {timestamp}   {file_count} files changed
  ⚠ Test Plan      Not found — consider /workforce-test-plan
  ✗ QA             No QA task created — consider /workforce-qa
  ○ Human Decision Pending
  ○ Merged         Waiting for approval

RECOMMENDATION
  {recommendation based on missing gates}

➤ Proceed to approve, or run missing gates first?
```

## Recommendation Logic

- If task is simple (○ tier): only require Code Complete + Human Decision
- If task is medium (● tier): recommend Test Plan + QA
- If task is complex (◉ tier): recommend all gates
- Always show what's missing but don't block — the human decides
