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
4. **Confidence Calibration Reasoning** — for each finding before applying the threshold:
   - **Exploitability trace**: Walk the complete attack path — entry point → vulnerable code → impact. If any step requires conditions you can't verify (e.g., "if auth is misconfigured", "if user has admin role"), drop confidence by 2 and mark the assumption explicitly. Theoretical findings score lower than traceable ones.
   - **Framework defense check**: Is this pattern protected by a framework-level defense already in this stack? (ORMs prevent SQLi, React escapes by default, CSRF tokens default-on, CSP headers set.) Verify the defense is *active* in this codebase — don't trust the framework's reputation, check the config. If active, discard the finding.
   - **Severity right-sizing**: What is the *realistic* impact if exploited — not theoretical worst-case, but likely outcome given this stack and deployment? Would this get a CVE? Would it make the news? Or is it a hardening suggestion? Adjust severity based on actual exploitability, not pattern-match severity.
   - **Variant scan**: Before reporting one instance, grep for the same pattern elsewhere in the codebase. One finding becomes a class — report the class with N instances, not N separate findings.
5. Apply confidence gating — standard mode discards findings below 8/10
6. Filter false positives (except: CI/CD findings and LLM cost attacks are never discarded)
7. Present findings report
8. If task mode: feed results into review scoring

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
