---
name: workforce-cso
description: Chief Security Officer audit — 14-phase vulnerability scanner with confidence gating. Runs against task diffs or full codebase. Integrates with pipeline as a quality gate. For autonomous deep audits, spawn the security-auditor agent instead.
---

When the user invokes /workforce-cso, run a security audit.

## Modes

- **Task mode**: `/workforce-cso <task_id>` — audit only the diff from a task in review
- **Full mode**: `/workforce-cso` — audit the entire codebase
- **Diff mode**: `/workforce-cso --diff` — audit uncommitted changes
- **Scoped mode**: `/workforce-cso --scope <path>` — audit a specific directory
- **Comprehensive**: add `--comprehensive` for 2/10 confidence threshold (default: 8/10)

## Steps

1. Determine mode from arguments
2. Gather the target: task diff (`workforce_get_diff`), `git diff`, or full codebase scan
3. Run the 14-phase audit (phase details in `agents/security-auditor.md`)
4. Apply confidence gating — standard mode discards findings below 8/10
5. Filter false positives (except: CI/CD findings and LLM cost attacks are never discarded)
6. Present findings report
7. If task mode: feed results into review scoring

## Findings Report

```
━━━ CSO AUDIT ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Mode:       {standard|comprehensive}   Confidence: {8|2}/10
Scope:      {task diff|full codebase|path}

FINDINGS ({verified} verified, {unverified} unverified)
┌───┬──────────┬──────┬──────────┬────────┬────────────────────┐
│ # │ Severity │ Conf │ Status   │ Phase  │ Finding            │
├───┼──────────┼──────┼──────────┼────────┼────────────────────┤
│ 1 │ CRITICAL │ 9/10 │ VERIFIED │ Ph.2   │ {description}      │
└───┴──────────┴──────┴──────────┴────────┴────────────────────┘

Per finding: file:line, exploit scenario (step-by-step), fix, variant count.

SUMMARY
  Critical: {n}   High: {n}   Medium: {n}   Low: {n}
```

## Pipeline Integration

When invoked from `/workforce-ceo pipeline` or `/workforce-cto review`:
- CRITICAL finding → override Security score to 0 → auto-REJECT
- HIGH findings → cap Security score at 1/3
- Clean audit → proceed with security note

## After the Audit

Offer to:
1. Create knowledge rules for recurring findings via `workforce_create_rule` (category: `security`)
2. Spawn a full autonomous audit via security-auditor agent (for deeper investigation)

## Related

- **security-auditor agent**: Same 14-phase methodology, runs autonomously — use for deep dives
- `/workforce-cto adversarial`: Complements CSO — code-level logic bugs vs infrastructure/supply-chain security
- `/workforce-cto review`: Findings feed into the Security category of weighted scoring
