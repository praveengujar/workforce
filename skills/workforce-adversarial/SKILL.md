---
name: workforce-adversarial
description: Cross-model adversarial review using Claude + OpenAI Codex for independent second opinions. Scales review depth by diff size. Use for high-stakes changes or when you want maximum review coverage.
---

When the user invokes /workforce-adversarial, run a cross-model adversarial review on a task or diff.

## Concept

Two independent AI models review the same code changes. Their findings are compared to surface blind spots that single-model review misses. This is especially valuable for security-critical, architectural, and complex changes where model-specific biases can mask issues.

## Prerequisites

- **OpenAI Codex CLI** must be installed and available in PATH (`codex` command)
- `OPENAI_API_KEY` environment variable must be set
- If Codex is unavailable, falls back to dual-Claude review (independent subagent)

## Modes

- **Task mode**: `/workforce-adversarial <task_id>` — review a task in `review` status
- **Diff mode**: `/workforce-adversarial` — review current uncommitted changes
- **PR mode**: `/workforce-adversarial <pr_url>` — review a pull request

## Steps

### 1. Gather the diff

- Task mode: call `workforce_get_diff` with the task ID
- Diff mode: run `git diff` + `git diff --cached`
- PR mode: use `gh pr diff <number>`

### 2. Determine review depth

Auto-scale based on diff size:

| Diff Size | Strategy | Cost |
|-----------|----------|------|
| **Small** (<50 lines) | Single Claude review, high reasoning | ~$0.05 |
| **Medium** (50-199 lines) | Claude + Codex in parallel | ~$0.15 |
| **Large** (200+ lines) | Claude + Codex + independent Claude subagent (3 voices) | ~$0.30 |
| **XL** (500+ lines) | Recommend decomposing; if user proceeds, 3-voice review | ~$0.50+ |

Present the depth assessment and estimated cost. Proceed unless user overrides.

### 3. Run parallel reviews

**Claude review** (always runs):
Run the standard workforce review analysis — correctness, security, tests, quality, rule compliance, scope.

**Codex review** (medium+ diffs):
Invoke Codex CLI in read-only sandbox mode:
```bash
echo "<diff_content>" | codex --approval-mode full-auto -q \
  "Review this diff as an adversarial code reviewer. Think like an attacker and chaos engineer. Hunt for:
   - Edge cases and boundary conditions
   - Race conditions and concurrency issues
   - Security holes and injection vectors
   - Resource leaks and memory issues
   - Silent data corruption
   - Missing error handling
   - Breaking changes to public APIs
   Report each finding with: severity, file:line, description, exploit scenario."
```

If Codex is unavailable, spawn an independent Claude review via the Agent tool with explicit instruction to challenge every assumption.

**Independent Claude subagent** (large+ diffs):
Spawn a separate Agent with the diff and a distinct review persona:
> "You are a paranoid senior engineer who has been burned by production incidents. Review this diff assuming everything that can go wrong will go wrong. Focus on what's NOT in the diff — missing tests, unhandled states, implicit assumptions."

### 4. Reconcile findings

Once all reviews complete, build the reconciliation:

1. **Overlap detection**: Findings both models independently caught (high confidence)
2. **Claude-only findings**: What only Claude found (check for false positives)
3. **Codex-only findings**: What only Codex found (check for false positives)
4. **Agreement rate**: `overlapping / total_unique` as percentage
5. **Tension points**: Where models disagree on severity or approach

### 5. Present the adversarial report

## Template

```
━━━ ADVERSARIAL REVIEW ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
{Task: id_8 | Diff: N files | PR: #NNN}
Diff size:  {lines} lines ({small|medium|large|XL})
Voices:     {Claude|Claude + Codex|Claude + Codex + Subagent}
Cost:       ~${estimated}

CONSENSUS FINDINGS (both models agree)
  {numbered list — these are highest confidence}

CLAUDE-ONLY FINDINGS
  {numbered list — Codex missed these}

{CODEX|SUBAGENT}-ONLY FINDINGS
  {numbered list — Claude missed these}

AGREEMENT ANALYSIS
  Overlap:    {n}/{total} findings ({pct}%)
  Claude:     {n} unique findings
  Codex:      {n} unique findings
  Tensions:   {n} disagreements

{if tensions:}
TENSION POINTS
  T1: {file:line} — Claude says {X}, Codex says {Y}
     Assessment: {which is more likely correct and why}

COMBINED SEVERITY
  Critical: {n}   High: {n}   Medium: {n}   Low: {n}

RECOMMENDATION
  {APPROVE|APPROVE WITH FIXES|REQUEST CHANGES|BLOCK}
  {1-2 sentence summary}

➤ Apply to workforce review score? (updates Security + Correctness scores)
```

## Integration with Workforce

### With /workforce-review
When used alongside review, adversarial findings feed into the weighted scoring:
- Consensus CRITICAL/HIGH findings → cap Security score
- Low agreement rate (<40%) on large diffs → flag for deeper review
- Update the review card with adversarial results

### With /workforce-pipeline
Can be added as an optional stage between QA and human review:
```
pre-scan → rubberduck → launch → test plan → QA → adversarial → human review → merge
```

### With /workforce-cso
Complementary: CSO focuses on infrastructure/supply-chain security, adversarial focuses on code-level logic bugs. Run both for maximum coverage.

## Codex Fallback

If Codex CLI is not available:
1. Check: `which codex`
2. If missing, log a note and fall back to dual-Claude mode
3. Dual-Claude mode spawns an independent Agent with adversarial persona
4. Results are still reconciled the same way — just both voices are Claude

The value of adversarial review comes from **independent analysis**, not necessarily from different models. Two independent reviews catch more than one, even from the same model family.

## Cost Management

- Small diffs: no extra cost (single review)
- Medium diffs: ~$0.10 Codex + ~$0.05 Claude = ~$0.15
- Large diffs: ~$0.10 Codex + ~$0.05 Claude + ~$0.05 subagent = ~$0.20
- Track via `workforce_cost_summary` — adversarial reviews logged as "review" tier
