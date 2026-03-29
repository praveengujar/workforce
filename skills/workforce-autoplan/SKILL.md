---
name: workforce-autoplan
description: Strict, gate-driven orchestrator for end-to-end delivery: pre-scan, rubberduck, test plan, code loop, QA, review, explicit human approval/reject, and merge. Use when you want one command to drive the full quality workflow.
---

When the user invokes /workforce-autoplan, run the complete orchestrator with mandatory gates and evidence at each stage.

## Contract

- Always run stages in this order:
  `pre-scan -> rubberduck -> test plan -> code loop -> QA -> review -> human decision -> merge`
- Never skip the human decision gate.
- Never auto-merge in this skill.
- Every gate must produce an evidence artifact in the status card.

## Stage Flow

### Stage 0: Intake + Pre-scan (mandatory)
1. Call `workforce_analyze_prompt`.
2. Extract any file paths from the prompt (if present).
3. Call `workforce_dependency_graph` with `action: "build"`.
4. If paths exist, call:
   - `workforce_get_rules_for_path`
   - `workforce_dependency_graph` with `action: "query_impact"` per path
5. Produce gate evidence:
   - risk level (LOW/MEDIUM/HIGH)
   - impacted files estimate
   - applicable rule count
   - go/no-go recommendation

### Stage 1: Rubberduck (mandatory)
1. Refine the prompt into an execution spec with:
   - acceptance criteria
   - non-goals
   - risk notes
2. If the spec is still ambiguous, stop and ask for clarification before launch.
3. Save the refined prompt as gate evidence.

### Stage 2: Test Plan (mandatory)
1. Build a test plan before coding with P0/P1/P2 coverage.
2. Include functional, edge, error, and regression checks.
3. Save P0 and P1 checks as QA requirements.

### Stage 3: Code Loop (mandatory)
1. Create the implementation task using `workforce_create_task` with:
   - refined prompt
   - `autoMerge: false`
   - default `task_type: "standard"`
2. Track status with `workforce_get_task` until task reaches `review` or `failed`.
3. If failed, run a bounded recovery loop:
   - inspect with `workforce_task_events` + `workforce_task_output`
   - retry via `workforce_retry_task` when appropriate
   - max retries in this orchestrator: 2 attempts
4. If still failed after retries, stop and report failure package.

### Stage 4: QA (mandatory)
1. Create QA verification task(s) that depend on the implementation task using `workforce_create_task`.
2. QA prompts must include P0/P1 checks from Stage 2.
3. Wait for QA tasks to complete.
4. If QA fails, stop and report with suggested fix loop.

### Stage 5: Review (mandatory)
1. Call `workforce_get_diff` for implementation task.
2. Summarize:
   - changed files
   - additions/deletions
   - risk highlights
   - QA outcome
3. Prepare an approval recommendation, but do not merge yet.

### Stage 6: Human Decision (mandatory)
1. Ask for explicit decision:
   - `approve` with reason
   - `reject` with reason
2. If rejected, call `workforce_reject_task` and stop.

### Stage 7: Merge (approve path only)
1. On explicit human approval, call `workforce_approve_task`.
2. Report merge outcome.
3. If merge fails, provide a fix-up task recommendation.

## Gate Evidence Template

Use and update this card after each stage:

```
━━━ AUTOPLAN ORCHESTRATOR ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Prompt: {prompt_60}...
Task: {task_id_or_pending}

[0] Pre-scan      {pending|done|failed}  Evidence: {risk, impact, rules}
[1] Rubberduck    {pending|done|failed}  Evidence: {refined_prompt, AC_count}
[2] Test Plan     {pending|done|failed}  Evidence: {P0_count, P1_count}
[3] Code Loop     {pending|done|failed}  Evidence: {status, retries_used}
[4] QA            {pending|done|failed}  Evidence: {qa_task_ids, result}
[5] Review        {pending|done|failed}  Evidence: {files_changed, key_risks}
[6] Human Gate    {pending|done|failed}  Evidence: {approve|reject, reason}
[7] Merge         {pending|done|failed}  Evidence: {merged|conflict|failed}
```

## Decision Rules

- If risk is HIGH and no relevant rules exist, recommend creating rules before merge.
- If QA is unavailable for a testable change, require explicit human waiver before approval.
- If security-relevant files changed, require explicit note in human approval reason.

## Simplification Routing

Use helper skills as subroutines, but keep `/workforce-autoplan` as the single entrypoint:
- Use decomposition logic when scope is too broad.
- Use chain/sprint logic only when user explicitly asks for multi-task sequencing or backlog batch launch.
- Keep final approval and merge decisions in this skill.

## Conversation Style

- Be concise at each gate.
- Ask only at hard decision points.
- Show what is blocked and what is next.
