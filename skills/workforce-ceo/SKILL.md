---
name: workforce-ceo
description: "Chief Executive Officer — strict gate-driven orchestrator: pre-scan, rubberduck, test plan, code, QA, review, human decision, merge. Never auto-merges. Default: plan."
---

When the user invokes /workforce-ceo, run the strict gated orchestrator.

## Default Action: plan

If no action specified, run the full orchestration pipeline.

## Actions

- **plan** (default) — Full gated orchestration (pre-scan → rubberduck → test plan → code → QA → review → human gate → merge)
- **pipeline** — Adaptive pipeline that skips stages for simple tasks

## Contract (plan mode)

- Always run stages in order: `pre-scan → rubberduck → test plan → code loop → QA → review → human decision → merge`
- Never skip the human decision gate
- Never auto-merge
- Every gate must produce evidence in the status card

## Stage Flow (plan mode)

### Stage 0: Intake + Pre-scan (mandatory)
1. Call `workforce_analyze_prompt`
2. Extract file paths, call `workforce_dependency_graph` build
3. If paths exist: `workforce_get_rules_for_path` + `workforce_dependency_graph` query_impact
4. **Risk reasoning** — before producing go/no-go:
   - What is the worst thing that could happen if this task fails?
   - Is the blast radius contained to the worktree, or could it affect shared state (DB, config, deps)?
   - Are there concurrent tasks working on related files?
   - Decision: proceed / flag risk / stop
5. Produce: risk level, impacted files, applicable rules, go/no-go

### Stage 1: Rubberduck (mandatory)
1. **Ambiguity detection** — before refining, identify:
   - What assumptions are you making that the user didn't explicitly state?
   - What could "done" mean from two different perspectives?
   - List 2 ways this task could be misinterpreted by an autonomous agent
2. Refine prompt into execution spec that eliminates those ambiguities, with acceptance criteria, non-goals, risk notes
3. If ambiguous after analysis, stop and ask for clarification
4. Save refined prompt as gate evidence

### Stage 2: Test Plan (mandatory)
1. Build P0/P1/P2 test plan before coding
2. Save P0 and P1 checks as QA requirements

### Stage 3: Code Loop (mandatory)
1. `workforce_create_task` with refined prompt, `autoMerge: false`
2. Track via `workforce_get_task` until `review` or `failed`
3. On failure: inspect + retry (max 2 attempts in orchestrator)
4. Still failed → stop and report

### Stage 4: QA (mandatory)
1. Create QA task(s) depending on implementation task
2. QA prompts include P0/P1 checks from Stage 2
3. Wait for completion. Failure → stop and report

### Stage 5: Review (mandatory)
1. `workforce_get_diff`, summarize changes, risk highlights, QA outcome
2. **Pre-decision reasoning** — before presenting the recommendation:
   - What is the strongest argument FOR merging this change?
   - What is the strongest argument AGAINST merging?
   - If you had to bet your own code on this, would you merge? Why or why not?
3. Present both arguments to the user with the recommendation — do NOT merge yet

### Stage 6: Human Decision (mandatory)
1. **MUST use `AskUserQuestion` tool** — do NOT proceed without structured user input:
   - Question: "Task {id}: Review score {pct}%, {qa_status}. Your decision?"
   - Options: "APPROVE (merge to {branch})", "REJECT (discard changes)", "INSPECT (show full diff first)"
2. If INSPECT → show diff, then AskUserQuestion again with APPROVE/REJECT
3. Rejected → `workforce_reject_task`, stop

### Stage 7: Merge (approve path only)
1. `workforce_approve_task`
2. Report merge outcome. Failure → fix-up task recommendation

## Adaptive Pipeline (pipeline action)

When invoked as `/workforce-ceo pipeline`:
- **Simple (○)**: Pre-scan → Launch → Review → Merge
- **Medium (●)**: Pre-scan → Launch → Test Plan → QA → Review → Merge
- **Complex (◉)**: Full pipeline including Security + Adversarial
- **Security-sensitive**: Always include `/workforce-cso` regardless of tier
- Stages skip automatically based on tier. "skip QA", "skip security" honored.

## Gate Evidence Template

```
━━━ CEO ORCHESTRATOR ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Prompt: {prompt_60}...
Task: {task_id_or_pending}

[0] Pre-scan      {status}  Evidence: {risk, impact, rules}
[1] Rubberduck    {status}  Evidence: {refined_prompt, AC_count}
[2] Test Plan     {status}  Evidence: {P0_count, P1_count}
[3] Code Loop     {status}  Evidence: {status, retries_used}
[4] QA            {status}  Evidence: {qa_task_ids, result}
[5] Review        {status}  Evidence: {files_changed, key_risks}
[6] Human Gate    {status}  Evidence: {approve|reject, reason}
[7] Merge         {status}  Evidence: {merged|conflict|failed}
```

## Related

- `/workforce-coo` — Direct task operations (launch, chain, sprint)
- `/workforce-cto` — Technical review and analysis
