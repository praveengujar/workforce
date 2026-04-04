---
name: workforce-cto
description: "Chief Technology Officer — code review, prompt analysis, adversarial review, merge authority, experiments. Default: review."
---

When the user invokes /workforce-cto, handle technical leadership functions. Parses first word as action.

## Default Action: review

If no action specified, run code review on tasks in review status.

## Actions

### review (default)
Review completed task diffs with weighted scoring. `/workforce-cto` or `/workforce-cto review`

1. `workforce_list_tasks` filtered for status=review
2. For each: `workforce_get_diff`, present file summary table
3. Score 6 categories (Correctness 3x, Security 3x, Test coverage 2x, Code quality 2x, Rule compliance 2x, Scope 1x)
4. Check `workforce_get_rules_for_path` for compliance
5. Thresholds: >=65% APPROVE, 50-64% CONDITIONAL, <50% REJECT. Security=0 → auto-REJECT
6. Flag: new deps, deleted tests, hardcoded secrets, auth changes

```
━━━ CTO REVIEW: {id_8} ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Prompt:  {prompt}
Branch:  wf/{id_8}   Files: {n}  +{adds} -{dels}

SCORE
  Correctness  3x  {s}/3   Code quality  2x  {s}/3
  Security     3x  {s}/3   Rule comply   2x  {s}/3
  Test cover   2x  {s}/3   Scope         1x  {s}/3
  Total: {pct}%  → {APPROVE|CONDITIONAL|REJECT}
```

After presenting the score, **MUST use `AskUserQuestion`**:
- Question: "Review score: {pct}%. Recommendation: {rec}. Your decision?"
- Options: "Approve (merge)", "Reject (discard)", "Conditional (approve with notes)", "Show full diff"

### rubberduck
Multi-perspective prompt analysis before launch. `/workforce-cto rubberduck "task prompt"`

Perspectives (auto-selected by task type):
- **Strategy**: Premise challenge, scope, alternatives (skip for simple bug fixes)
- **Design**: Interaction states, responsive, AI slop risk (skip for backend)
- **Engineering**: Always — scope, existing solutions, ambiguity, risk, acceptance criteria

Quick mode: `/workforce-cto rubberduck quick "prompt"` — engineering only.

```
━━━ RUBBERDUCK ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Tier: {○●◉}  Est: ~${cost}
Perspectives: {Strategy ✓|—} {Design ✓|—} {Engineering ✓}

{perspective findings}

ACCEPTANCE CRITERIA
  1. {verifiable}
  2. {verifiable}

REFINED PROMPT: "{improved}"
➤ Launch, run /workforce-ceo, or edit?
```

### adversarial
Cross-model review (Claude + OpenAI Codex). `/workforce-cto adversarial <task_id>`

- Auto-scales: <50 lines=single, 50-199=dual, 200+=triple voice
- Falls back to dual-Claude if no Codex CLI
- Reconciles: consensus findings, Claude-only, Codex-only, agreement rate, tensions

```
━━━ ADVERSARIAL: {id_8} ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Voices: {n}   Agreement: {pct}%
CONSENSUS: {findings}
CLAUDE-ONLY: {findings}
{CODEX|SUBAGENT}-ONLY: {findings}
➤ Apply to review score?
```

### merge
Pre-merge conflict check + guided merge. `/workforce-cto merge`

1. List tasks in review, run conflict check per task
2. Classify: Clean ✓, Auto-resolvable ⚠, Conflicts ✗
3. Batch merge clean first, then auto-resolve, skip conflicts

```
━━━ MERGE QUEUE ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ✓ {id_8}  Clean       "{prompt_40}..."
  ⚠ {id_8}  Auto-resolve "{prompt_40}..."
  ✗ {id_8}  Conflicts    "{prompt_40}..."
➤ Merge all clean, individually, or skip?
```

### experiment
Iterative optimization loop. `/workforce-cto experiment`

Guide setup: research objective, measurement command, metric regex, direction (min/max), target value, max iterations. Then `workforce_create_experiment`.

```
┌─ EXPERIMENT ─────────────────────────────────────────┐
│ Metric: {name} ({direction})  Target: {value}        │
│ Command: {measure_cmd}  Iterations: {max}            │
└──────────────────────────────────────────────────────┘
● Running iteration 1/{max}
```

## Related

- `/workforce-ceo` — Orchestrates CTO review as part of the full pipeline
- `/workforce-cso` — Security-specific audit (complements CTO review)
- `/workforce-cqo` — QA and test planning
