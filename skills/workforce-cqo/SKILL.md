---
name: workforce-cqo
description: "Chief Quality Officer — E2E testing, test plans, quality gate status. Default: qa."
---

When the user invokes /workforce-cqo, handle quality assurance. Parses first word as action.

## Default Action: qa

If no action specified, create QA tasks for work in review.

## Actions

### qa (default)
Generate and run E2E tests for tasks in review. `/workforce-cqo` or `/workforce-cqo qa`

1. `workforce_list_tasks` with `status_filter: "review"`
2. For each: `workforce_task_output` + `workforce_get_diff`
3. **QA Strategy Reasoning** (mandatory before lookup-table strategy selection):
   - **Behavior-coverage map**: What user-visible behaviors does this diff change? List them as verbs ("user can submit form", "API returns 401 on bad token"). The test set must cover each verb at least once. If the diff has zero user-visible behaviors, E2E is wrong tool — surface that and skip.
   - **Cheapest-test-that-proves-it**: For each behavior, what is the *cheapest* test that proves it works? Unit (fast, isolated) → Integration (boundary-crossing) → E2E (full workflow). Don't use E2E to verify what a unit test would catch — E2E is slow, flaky, and expensive. Reserve E2E for true workflow verification.
   - **Regression risk surface**: What existing behaviors AREN'T being changed but COULD break as a side effect? (Shared utilities edited, props changed, schema migrations, config changes.) These are *highest-priority* regression tests, often missed because they're not in the diff.
   - **Fallback rationale**: Lookup table below is a default — if reasoning above contradicts it, prefer reasoning. Document why in the QA plan.
4. Determine strategy by change type:

| Change Type | Test Approach |
|-------------|---------------|
| Web UI (.tsx/.jsx) | Playwright browser tests |
| API endpoints | Playwright API testing |
| Mobile responsive | Playwright viewport emulation |
| Forms | Fill, submit, validate |
| Auth flows | Login flow, protected routes |
| No UI | Skip E2E, suggest unit tests |

5. Present QA plan, on approval create QA tasks via `workforce_create_task` with `depends_on`

```
━━━ CQO QA PLAN ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Task: {id_8}  Strategy: {approach}
  ○ E2E: {test_description}
  Est: ~${est}
➤ Create QA tasks, modify, or skip?
```

**Interactive mode**: When Playwright MCP tools are available, use `browser_navigate`, `browser_snapshot`, `browser_click`, `browser_fill_form`, `browser_take_screenshot` for quick smoke tests during review.

### testplan
Generate test strategy before or during review. `/workforce-cqo testplan <task_id>`

1. Analyze task diff or prompt for testable behaviors
2. **Test strategy reasoning** — before classifying:
   - **What can break**: Trace the change surface — what code paths does this diff affect? For each affected path, what user-visible behavior depends on it?
   - **Regression risk map**: Which existing behaviors AREN'T being changed but COULD break as a side effect? These are highest-priority regression tests.
   - **Test type decision**: For each behavior, what's the cheapest test that proves it works? Unit (fast) → Integration (boundary-crossing) → E2E (user workflow). Don't E2E-test what a unit test can verify.
3. Classify: P0 (must test), P1 (should test), P2 (nice to have)
4. Identify edge cases

```
━━━ CQO TEST PLAN ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Task: {id_8}  Strategy: {e2e|unit|integration}

P0 — MUST TEST
  □ {test} — {verify}
P1 — SHOULD TEST
  □ {test} — {verify}
EDGE CASES
  □ {case} — {expected}

➤ Create QA tasks from plan, or edit?
```

### gates
Show quality gate status for a task. `/workforce-cqo gates <task_id>`

1. `workforce_get_task` (includes gates field) + `workforce_task_events`
2. Show which gates passed, waived, missing

```
━━━ CQO GATES: {id_8} ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ✓ Created        {timestamp}
  ✓ Code Complete  {timestamp}
  ⚠ Test Plan      Not found
  ✗ QA             Missing
  ○ Human Decision Pending

RECOMMENDATION: {based on tier and missing gates}
➤ Proceed to approve, or run missing gates?
```

## Related

- `/workforce-cto review` — Code review scoring (CQO tests, CTO reviews)
- `/workforce-ceo` — QA is a mandatory stage in CEO orchestration
