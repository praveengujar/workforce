---
name: workforce-pipeline
description: Adaptive orchestration pipeline — auto-skips stages based on task complexity. For strict gated orchestration with mandatory human approval, use /workforce-autoplan instead.
---

When the user invokes /workforce-pipeline, orchestrate a task lifecycle with adaptive quality gates.

## How It Differs From /workforce-autoplan

| | /workforce-pipeline | /workforce-autoplan |
|---|---|---|
| **Philosophy** | Adaptive — skips stages for simple tasks | Strict — every gate mandatory |
| **Human gate** | At review stage | Mandatory, never skipped |
| **Auto-merge** | Allowed for simple tasks | Never |
| **Best for** | Day-to-day tasks across all tiers | High-stakes or complex features |

## Pipeline Stages

```
pre-scan → rubberduck → launch → test plan → QA → security → adversarial → review → merge
```

Each stage is **optional and skippable**. Adaptive behavior selects which stages run.

## Adaptive Behavior

- **Simple (○, <$0.10)**: Pre-scan → Launch → Review → Merge
- **Medium (●, $0.10-$0.50)**: Pre-scan → Launch → Test Plan → QA → Review → Merge
- **Complex (◉, >$0.50)**: Full pipeline including Security + Adversarial
- **Security-sensitive** (auth/payments/secrets): Always include Security regardless of tier
- **User override**: "skip QA", "skip security" — honor immediately

## Steps

### Stage 0: Pre-scan (always)
1. `workforce_dependency_graph` build + impact query
2. `workforce_get_rules_for_path` for mentioned files
3. Present: impact radius, applicable rules, risk level, recommendation

### Stage 1: Rubberduck (complex only)
Run `/workforce-rubberduck` analysis, present refined prompt, proceed on approval.

### Stage 2: Launch
`workforce_create_task` → wait for `review` status via `workforce_get_task`.

### Stage 3: Test Plan (medium+, UI/API only)
Run `/workforce-test-plan` analysis, present plan.

### Stage 4: QA (medium+, testable behaviors only)
Create QA tasks via `/workforce-qa`, wait for completion.

### Stage 5: Security (complex or security-sensitive)
Run `/workforce-cso` in task mode. CRITICAL → block merge. HIGH → warn.

### Stage 6: Adversarial (complex, diffs ≥50 lines)
Run `/workforce-adversarial` in task mode. Low agreement (<40%) → flag.

### Stage 7: Review
Show diff, QA results, security summary, adversarial summary. Ask: approve or reject.

### Stage 8: Merge
`workforce_approve_task` → report result. Merge failure → offer fix-up task.

## Status Card

```
━━━ PIPELINE: {id_8} ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Prompt: "{prompt_40}..."

  ✓ Pre-scan     {risk} risk, {rules} rules
  ✓ Launch       Slot {n}/{max}
  ● Code         Agent working... {elapsed}
  ○ QA           Waiting
  ○ Review       Waiting
  ○ Merge        Waiting
```

Stages not applicable for this tier are omitted from the card.

## Error Handling

- Code fails → `/workforce-rescue`
- QA fails → show output, offer fix
- Merge fails → conflict details, fix-up task
- Human rejects → retry with feedback

## Related

- `/workforce-autoplan`: Strict gated orchestrator (every stage mandatory, never auto-merges)
- `/workforce-launch`: Direct launch with no pipeline
- `/workforce-rubberduck`: Standalone prompt refinement
