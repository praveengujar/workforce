---
name: workforce-qa
description: Generate and run E2E tests for tasks in review. Spawns QA agent tasks that write Playwright tests for web/mobile UI changes, run them, and report results. Use when user wants to verify task output with automated tests before merging.
---

When the user invokes /workforce-qa, create QA verification tasks for work in review.

## Steps

1. Call `workforce_list_tasks` with `status_filter: "review"` to get tasks awaiting review
2. If no tasks in review, say so and exit
3. For each task in review (or user-specified subset):
   a. Call `workforce_task_output` to understand what the task changed
   b. Call `workforce_get_diff` to see the actual file changes
   c. Determine the testing strategy (see Testing Strategy below)
   d. Present the QA plan
4. On user approval, create QA tasks via `workforce_create_task` with:
   - A test-writing prompt tailored to the changes (see Prompt Templates)
   - `depends_on: [original_task_id]`
   - `group: "qa-{original_task_id_8}"`
   - `phase: 2` (original task is phase 1)
   - `project`: same as original task

## Testing Strategy

Analyze the diff to determine the right test approach:

| Change Type | Detection | Test Approach |
|------------|-----------|---------------|
| **Web UI components** | .tsx/.jsx/.vue/.svelte files, HTML templates | Playwright browser tests: navigate, interact, assert |
| **API endpoints** | route files, controller files, handler files | Playwright API testing: fetch endpoints, verify responses |
| **Mobile responsive** | media queries, viewport changes, mobile components | Playwright mobile emulation: test across viewports |
| **Form handling** | input elements, form submissions, validation | Playwright form tests: fill, submit, validate feedback |
| **Navigation/routing** | router config, link changes, redirect logic | Playwright navigation tests: click through flows |
| **Auth flows** | login/signup/session files | Playwright auth tests: login flow, protected routes |
| **No UI changes** | backend-only, config, infra | Skip E2E — suggest unit tests instead |

## Prompt Templates

### Web UI Test Prompt
```
Write and run Playwright E2E tests for the following UI changes:

{diff_summary}

Requirements:
1. Create a test file at `tests/e2e/{feature_name}.spec.{ts|js}`
2. Use Playwright test runner (`@playwright/test`)
3. Test the happy path and one error/edge case
4. Use meaningful test descriptions
5. Take screenshots on failure
6. If the app needs a dev server, start it before tests and stop after
7. Run the tests and ensure they pass
8. If tests fail, fix the code or tests until green

Dev server command: {detected_or_ask} (e.g., `npm run dev`, `python manage.py runserver`)
Base URL: {detected_or_default} (e.g., `http://localhost:3000`)

Focus on testing user-visible behavior, not implementation details.
```

### Mobile Responsive Test Prompt
```
Write and run Playwright E2E tests verifying responsive behavior:

{diff_summary}

Requirements:
1. Test at minimum 3 viewports: mobile (375x667), tablet (768x1024), desktop (1280x720)
2. Verify layout doesn't break across viewports
3. Test touch interactions where applicable
4. Take screenshots at each viewport for visual comparison
5. Use `page.setViewportSize()` for viewport testing

Dev server command: {detected_or_ask}
Base URL: {detected_or_default}
```

### API Test Prompt
```
Write and run Playwright API tests for the following endpoint changes:

{diff_summary}

Requirements:
1. Create a test file at `tests/e2e/api-{feature_name}.spec.{ts|js}`
2. Use `request.newContext()` for API testing
3. Test success responses, validation errors, and auth (if applicable)
4. Verify response shapes and status codes
5. Run the tests and ensure they pass

Base URL: {detected_or_default}
```

## Template — QA Plan

```
━━━ QA PLAN ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Task:     {id_8}  "{prompt_40}..."
Changes:  {file_count} files  +{adds} -{dels}
Strategy: {test_approach}

TEST TASKS TO CREATE:
  ○ E2E: {test_description}
    Scope: {files_to_test}
    Viewports: {if responsive: mobile, tablet, desktop}

Est. cost: ~${est}

➤ Create QA tasks, modify plan, or skip?
```

## Template — QA Launched

```
━━━ QA LAUNCHED ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Original: {original_id_8}  "{prompt_40}..."
QA group: qa-{original_id_8}

  ● {qa_task_id_8}  "E2E: {test_description}"  ← depends on {original_id_8}

QA task will auto-launch when original task work is available.
Results: /workforce or workforce_task_output {qa_task_id}
```

## Dev Server Detection

Try to detect the dev server command from the project:
- `package.json` → `scripts.dev` or `scripts.start`
- `Makefile` → `dev` or `serve` target
- `docker-compose.yml` → mapped ports
- `manage.py` → Django
- `Procfile` → Heroku-style
- If can't detect, ask the user

## When to Skip E2E

Don't create QA tasks for changes that are:
- Documentation only (.md files)
- Configuration/infrastructure (CI, Docker, terraform)
- Backend logic with no user-facing interface
- Test files themselves

Instead, note: "These changes are backend/config — E2E tests not applicable. Consider unit tests."

## Interactive QA Mode (Playwright MCP)

The workforce plugin bundles Microsoft's Playwright MCP server (`@playwright/mcp`), giving you direct browser control tools in this session. Use this for **interactive review** — manually verifying task output before approving.

### When to Use Interactive Mode

- Quick smoke test before approving a task
- Verifying a specific UI behavior the diff shows changed
- Debugging a QA task that reported failures
- Testing responsive layouts across viewports

### Interactive QA Workflow

1. Start the dev server in the task's worktree (check task's `worktreePath`)
2. Use Playwright MCP tools to navigate and verify:

```
browser_navigate → http://localhost:3000
browser_snapshot → get accessibility tree, identify elements
browser_click   → interact with UI elements by ref
browser_fill_form → test form submissions
browser_take_screenshot → capture visual state
browser_resize  → test responsive breakpoints (375x667, 768x1024, 1280x720)
```

3. For mobile testing:
```
browser_resize → {"width": 375, "height": 667}
browser_snapshot → verify mobile layout
browser_take_screenshot → capture mobile view
```

4. For form/interaction testing:
```
browser_snapshot → find form element refs
browser_fill_form → fill inputs by ref
browser_click → submit
browser_snapshot → verify result state
```

5. For network verification:
```
browser_network_requests → check API calls made
browser_console_messages → check for errors
```

### Key Playwright MCP Tools Reference

| Tool | Use For |
|------|---------|
| `browser_navigate` | Open a URL |
| `browser_snapshot` | Get accessibility tree with element refs |
| `browser_take_screenshot` | Visual capture |
| `browser_click` | Click element by ref |
| `browser_fill_form` | Fill multiple form fields at once |
| `browser_select_option` | Dropdown selection |
| `browser_type` | Type into editable element |
| `browser_press_key` | Keyboard input (Enter, Tab, etc.) |
| `browser_resize` | Change viewport for responsive testing |
| `browser_wait_for` | Wait for text/element appearance |
| `browser_console_messages` | Check for JS errors |
| `browser_network_requests` | Verify API calls |
| `browser_evaluate` | Run JS on page |
| `browser_tabs` | Multi-tab testing |
| `browser_pdf_save` | Save page as PDF |

### Interactive vs Autonomous QA

| Aspect | Interactive (Playwright MCP) | Autonomous (QA task) |
|--------|------------------------------|----------------------|
| **When** | During `/workforce-review` | Before review via `/workforce-qa` |
| **How** | You use browser tools directly | Spawned agent writes + runs test files |
| **Artifacts** | Screenshots, observations | Committed `.spec.ts` test files |
| **Best for** | Quick verification, debugging | Durable test coverage, CI pipeline |

Offer interactive mode when the user says "let me check" or "test it" during review. Default to autonomous QA tasks when the user wants to gate merges.
