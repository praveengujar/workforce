---
name: workforce-test-plan
description: Generate a test plan for a task — what to test, edge cases, and verification strategy. Feeds into /workforce-qa for automated test generation. Use before or during review.
---

When the user invokes /workforce-test-plan, create a structured test plan for a task.

## Steps

1. Identify the target task:
   - If a task_id is provided, call `workforce_get_task` and `workforce_get_diff` to analyze
   - If a prompt is provided, analyze the prompt for testable behaviors
   - If neither, show tasks in review and ask which to plan for
2. Analyze the changes or intended changes
3. Generate the test plan (see Test Plan Framework)
4. Present the plan
5. Offer to create QA tasks via `/workforce-qa` based on the plan

## Test Plan Framework

### Identify Testable Behaviors
- What user-visible behaviors change?
- What API contracts change?
- What data flows are affected?

### Test Categories
For each testable behavior, classify:

| Category | Description | Priority |
|----------|-------------|----------|
| **Happy path** | Core functionality works as intended | P0 — must test |
| **Input validation** | Invalid/edge-case inputs handled correctly | P1 — should test |
| **Error handling** | Failures produce correct behavior (messages, rollback) | P1 — should test |
| **Responsive/viewport** | UI works across screen sizes | P1 if UI change |
| **Accessibility** | Keyboard navigation, screen reader, ARIA | P2 — nice to have |
| **Performance** | No regressions in load time or responsiveness | P2 — nice to have |
| **Integration** | Works correctly with adjacent systems | P1 if API change |

### Edge Cases
- Empty inputs, null values, missing data
- Concurrent operations
- Large datasets / long strings
- Permission boundaries (authed vs unauthed)

## Template — Test Plan

```
━━━ TEST PLAN ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Task: {id_8}  "{prompt_40}..."
Files: {file_count} changed   Strategy: {e2e|unit|integration|manual}

P0 — MUST TEST
  □ {test_description} — {how_to_verify}
  □ {test_description} — {how_to_verify}

P1 — SHOULD TEST
  □ {test_description} — {how_to_verify}
  □ {test_description} — {how_to_verify}

P2 — NICE TO HAVE
  □ {test_description} — {how_to_verify}

EDGE CASES
  □ {edge_case} — {expected_behavior}
  □ {edge_case} — {expected_behavior}

AUTOMATION RECOMMENDATION
  {e2e_count} E2E tests via Playwright
  {unit_count} unit tests
  {manual_count} manual checks

➤ Create QA tasks from this plan, or edit?
```

## Integration with /workforce-qa

When the user approves the test plan, pass the P0 and P1 items to `/workforce-qa` as test requirements. The QA task prompt should include:
- The specific test cases from the plan
- The test category and priority
- The files to test against
- The expected behaviors to verify
