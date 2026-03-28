---
name: workforce-adversarial
description: Cross-model adversarial review using Claude + OpenAI Codex. Auto-scales depth by diff size, reconciles findings between models. Falls back to dual-Claude if Codex unavailable. Use for high-stakes changes.
---

When the user invokes /workforce-adversarial, run a cross-model adversarial review.

## Modes

- **Task mode**: `/workforce-adversarial <task_id>` — review a task in `review` status
- **Diff mode**: `/workforce-adversarial` — review uncommitted changes
- **PR mode**: `/workforce-adversarial <pr_url>` — review a pull request

## Steps

### 1. Gather the diff

Task: `workforce_get_diff`. Diff: `git diff`. PR: `gh pr diff`.

### 2. Auto-scale review depth

| Diff Size | Voices | Strategy |
|-----------|--------|----------|
| <50 lines | 1 (Claude) | Standard review only |
| 50-199 | 2 (Claude + Codex) | Parallel independent reviews |
| 200+ | 3 (Claude + Codex + Claude subagent) | Triple-voice with adversarial persona |

If Codex CLI unavailable (`which codex` fails), fall back to dual-Claude: spawn an independent Agent with adversarial persona. The value comes from **independent analysis**, not different models.

### 3. Run reviews in parallel

**Claude**: Standard workforce review (correctness, security, tests, quality).

**Codex** (medium+): Read-only sandbox, adversarial posture — hunt for edge cases, race conditions, security holes, resource leaks, breaking API changes.

**Subagent** (large+): Paranoid senior engineer persona — focus on what's NOT in the diff (missing tests, unhandled states, implicit assumptions).

### 4. Reconcile and report

```
━━━ ADVERSARIAL REVIEW ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Diff: {lines} lines   Voices: {count}

CONSENSUS (both models agree — highest confidence)
  {findings}

CLAUDE-ONLY
  {findings Codex missed}

{CODEX|SUBAGENT}-ONLY
  {findings Claude missed}

AGREEMENT: {n}/{total} ({pct}%)

{if tensions:}
TENSIONS
  {file:line} — Claude: {X}, Codex: {Y} → Assessment: {which is correct}

RECOMMENDATION: {APPROVE|APPROVE WITH FIXES|REQUEST CHANGES}
```

## Integration

- **With /workforce-review**: Findings feed into Security + Correctness scoring
- **With /workforce-pipeline**: Optional stage between QA and human review
- **With /workforce-cso**: Complementary — CSO covers infrastructure, adversarial covers code logic

## Related

- `/workforce-review`: Standard single-model review with weighted scoring
- `/workforce-cso`: Infrastructure-first security audit (14 phases)
