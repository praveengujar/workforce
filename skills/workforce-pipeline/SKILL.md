---
name: workforce-pipeline
description: Run the full orchestration pipeline for a task — rubberduck, launch, test plan, QA, human review, merge. Use when you want the complete quality flow from prompt to merge.
---

When the user invokes /workforce-pipeline, orchestrate a complete task lifecycle with quality gates.

## Pipeline Stages

```
pre-scan → rubberduck → launch → [agent codes] → test plan → QA → security (CSO) → adversarial → human review → merge
```

Each stage is optional and skippable. The pipeline adapts based on task complexity.

## Steps

### Stage 0: Pre-scan (always runs, ~5 seconds)
1. Call `workforce_dependency_graph` with action `build` to ensure the graph is fresh
2. Extract file paths from the prompt
3. Call `workforce_get_rules_for_path` with those paths to check applicable rules
4. Call `workforce_dependency_graph` with action `query_impact` for each mentioned file
5. Calculate impact radius (total affected files across all queries)
6. Present the pre-scan summary:

```
━━━ PRE-SCAN ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Files mentioned:    {count}
Impact radius:      {total_affected} files
Applicable rules:   {rule_count}
Risk:               {LOW|MEDIUM|HIGH}
Recommendation:     {proceed|decompose|review rules first}
```

Decision logic:
- Impact radius > 20 files: recommend decomposition via `/workforce-decompose`
- Rules exist with priority >= 7: include them as constraints in the prompt
- No rules for critical paths: flag as a gap, suggest `/workforce-rules` to add

### Stage 1: Rubberduck (skip for simple/○ tasks)
1. Run the rubberduck analysis (same as /workforce-rubberduck)
2. Present refined prompt and acceptance criteria
3. On approval, proceed to launch

### Stage 2: Launch
1. Call `workforce_create_task` with the refined prompt
2. Show the launch card
3. Wait for task to complete (move to `review` status)
4. Periodically check status via `workforce_get_task`

### Stage 3: Test Plan (skip for non-UI/non-API tasks)
1. Once task is in `review`, run test plan analysis (same as /workforce-test-plan)
2. Present the test plan
3. On approval, proceed to QA

### Stage 4: QA (skip if no testable behaviors)
1. Create QA task(s) based on the test plan (same as /workforce-qa)
2. QA tasks auto-launch since `review` satisfies dependencies
3. Wait for QA task(s) to complete
4. Report QA results

### Stage 5: Security Audit (skip for config/docs changes)
1. Run the CSO audit in task mode against the task diff (same as `/workforce-cso <task_id>`)
2. In standard mode: only report findings with confidence >= 8/10
3. Any CRITICAL finding → flag for human review with BLOCK MERGE recommendation
4. HIGH findings → note in review card for human decision
5. Results feed into the review scoring (Security category weight)

Decision logic:
- CRITICAL findings: require explicit human waiver to proceed
- HIGH findings: proceed with warning, human decides
- MEDIUM/LOW only: proceed automatically
- No findings: proceed with clean security note

### Stage 6: Adversarial Review (skip for small diffs <50 lines)
1. Run cross-model adversarial review (same as `/workforce-adversarial <task_id>`)
2. Auto-scale depth by diff size (small=skip, medium=dual, large=triple voice)
3. Reconcile findings between models
4. Consensus findings feed into review scoring (Correctness + Security categories)
5. Low agreement rate (<40%) → flag for human attention

### Stage 7: Human Review
1. Show the diff via `workforce_get_diff`
2. Show QA results (if QA was run)
3. Show security audit summary (if CSO was run) with finding count and severity breakdown
4. Show adversarial review summary (if run) with agreement rate and consensus findings
5. Show the test plan checklist (if generated)
6. Ask for human decision: approve or reject (with reason)

### Stage 8: Merge (on approve)
1. Call `workforce_approve_task` with the approval reason
2. Report merge result (success, conflict, or failure)
3. If merge fails, offer to create a fix-up task

## Template — Pipeline Status

```
━━━ PIPELINE: {id_8} ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Prompt: "{prompt_40}..."

  ✓ Rubberduck    Refined prompt, 4 acceptance criteria
  ✓ Launch        Task running (slot 2/10)
  ● Code          Agent working... {elapsed}
  ○ Test Plan     Waiting for code completion
  ○ QA            Waiting for test plan
  ○ Security      Waiting for QA (CSO audit)
  ○ Adversarial   Waiting for security (cross-model review)
  ○ Review        Waiting for adversarial
  ○ Merge         Waiting for approval
```

Update this status card as each stage completes.

## Adaptive Behavior

- **Simple tasks (○ tier, <$0.10)**: Pre-scan → Launch → Review → Merge.
- **Medium tasks (● tier, $0.10-$0.50)**: Pre-scan → Launch → Test Plan → QA → Review → Merge.
- **Complex tasks (◉ tier, >$0.50)**: Pre-scan → Rubberduck → Launch → Test Plan → QA → Security → Adversarial → Review → Merge.
- **Security-sensitive**: Any task touching auth/payments/secrets: always include Security stage regardless of tier.
- **User override**: "skip QA", "skip security", "skip adversarial", "skip rubberduck" — honor immediately.

## Error Handling

- If code stage fails: offer /workforce-rescue for diagnosis
- If QA fails: show QA output, offer to fix and re-run
- If merge fails: show conflict details, offer fix-up task
- If human rejects: show rejection reason, offer to create retry task with feedback incorporated

## Conversation Style

- Don't ask permission at every stage — execute the appropriate pipeline and pause only at decision points (approve/reject)
- Show the pipeline status card after each stage transition
- If the user is watching, provide brief updates. If async, summarize at the end.
