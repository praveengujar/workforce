---
name: workforce-cso
description: Chief Security Officer audit — 14-phase infrastructure-first vulnerability scanner. Runs against task diffs or full codebase. Integrates with workforce pipeline as a quality gate. Use when reviewing task security or auditing the project.
---

When the user invokes /workforce-cso, run a comprehensive security audit.

## Modes

- **Task mode**: `/workforce-cso <task_id>` — audit only the diff from a task in review
- **Full mode**: `/workforce-cso` — audit the entire codebase
- **Diff mode**: `/workforce-cso --diff` — audit only uncommitted changes
- **Scoped mode**: `/workforce-cso --scope <path>` — audit a specific directory

## Confidence Gating

Two operating modes with strict thresholds:

- **Standard** (default): **8/10 confidence** — only high-confidence findings reported. Zero noise priority.
- **Comprehensive** (`--comprehensive`): **2/10 confidence** — reports tentative findings for deeper investigation.

**Principle**: Zero noise over zero misses. Missing 3 real vulnerabilities is better than reporting 3 real findings plus 12 false positives.

## The 14 Phases

### Phase 0: Stack Detection & Architecture Modeling
- Identify languages, frameworks, package managers, infrastructure
- Determine scanning priority for subsequent phases
- Undetected languages receive catch-all coverage

### Phase 1: Attack Surface Census
- Map exposed endpoints, API routes, webhooks, public URLs
- Identify entry points: user input, file uploads, auth flows
- Catalog external service connections

### Phase 2: Secrets Archaeology
- Scan git history for active secret patterns: `AKIA`, `sk_`, `ghp_`, `xoxb-`, `-----BEGIN`
- Check for tracked `.env` files, CI configs with inline credentials
- In task mode: limit to commits on the task branch
- Flag: hardcoded API keys, connection strings, JWT secrets

### Phase 3: Dependency Supply Chain
- Identify vulnerable dependencies via lockfile analysis
- Check for unpinned versions, deprecated packages
- Flag transitive dependency exposure
- Cross-reference with known CVE databases

### Phase 4: CI/CD Pipeline Security
- Check for unpinned third-party GitHub Actions
- Detect dangerous `pull_request_target` workflows
- Find script injection via `${{ github.event.* }}`
- Verify CODEOWNERS on workflow files
- **Never auto-discarded** regardless of false-positive filtering

### Phase 5: Infrastructure Shadow Surface
- Scan Dockerfiles for exposed credentials, running as root
- Check IaC (Terraform, CloudFormation, Kubernetes manifests)
- Identify exposed ports, missing network policies

### Phase 6: Webhook & Integration Audit
- Validate webhook signature verification
- Check for SSRF in callback URLs
- Verify integration authentication

### Phase 7: LLM/AI-Specific Vulnerabilities
- Prompt injection vectors in user-facing LLM features
- Unsanitized LLM output rendering (XSS via AI)
- Unvalidated tool/function calling
- Exposed AI API keys in client code
- **Unbounded LLM cost amplification** — flagged as financial risk, **never discarded**

### Phase 8: Skill & Plugin Supply Chain
- Scan `.claude/skills/`, plugin directories for exfiltration patterns
- Check for credential theft in tool configurations
- Verify MCP server security

### Phase 9: OWASP Top 10 Targeted Analysis
- A01 Broken Access Control through A10 SSRF
- Specific to the codebase's architecture and framework
- Framework-aware checks (e.g., Next.js middleware, Express auth)

### Phase 10: STRIDE Threat Modeling
Per-component analysis:
- **S**poofing — authentication weaknesses
- **T**ampering — data integrity gaps
- **R**epudiation — missing audit trails
- **I**nformation Disclosure — data leaks, verbose errors
- **D**enial of Service — resource exhaustion, rate limiting gaps
- **E**levation of Privilege — authorization bypasses

### Phase 11: Data Classification
- Classify data flows: PII, credentials, financial, health
- Identify protection gaps per classification level
- Check encryption at rest and in transit

### Phase 12: False-Positive Filtering
- Confirm findings via code tracing (not pattern-only)
- Each verified finding triggers variant analysis across codebase
- Apply hard exclusions (see below)
- Mark findings as VERIFIED or UNVERIFIED

### Phase 13: Findings Report & Persistence

Generate the findings report and save to `.workforce/security-reports/`.

## False-Positive Hard Exclusions

Automatically discarded unless explicitly excepted:
- Test-only file vulnerabilities
- DoS from algorithmic complexity (unless in hot path)
- Missing optional hardening headers
- Documentation-only warnings
- Deprecated but unused code paths

**Carved-out exceptions** (never auto-discarded):
- Phase 4 CI/CD findings — always reported
- Phase 7 LLM cost attacks — financial risk, always reported

## Findings Report Template

```
━━━ CSO AUDIT ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Mode:       {standard|comprehensive}   Confidence: {8|2}/10
Scope:      {task diff|full codebase|path}
Stack:      {detected languages, frameworks}

FINDINGS ({count} verified, {count} unverified)
┌───┬──────────┬──────┬──────────┬────────┬────────────────────┐
│ # │ Severity │ Conf │ Status   │ Phase  │ Finding            │
├───┼──────────┼──────┼──────────┼────────┼────────────────────┤
│ 1 │ CRITICAL │ 9/10 │ VERIFIED │ Ph.2   │ API key in git     │
│ 2 │ HIGH     │ 8/10 │ VERIFIED │ Ph.9   │ SQL injection      │
│ 3 │ MEDIUM   │ 8/10 │ UNVERIF  │ Ph.10  │ Missing rate limit │
└───┴──────────┴──────┴──────────┴────────┴────────────────────┘

FINDING DETAILS

[F1] API key committed to git history — CRITICAL (9/10) VERIFIED
  File:    src/config/api.ts:42
  Phase:   2 — Secrets Archaeology
  Exploit: 1. Clone repo → 2. git log -p -- src/config/ → 3. Extract key → 4. Call API
  Fix:     Rotate key immediately. Move to env var. Add to .gitignore.
  Variants: {count} similar patterns found in codebase

...

SUMMARY
  Critical: {n}   High: {n}   Medium: {n}   Low: {n}
  Verified: {n}   Unverified: {n}
  Phases clean: {list of phases with 0 findings}

{if task mode:}
REVIEW IMPACT
  Security score adjustment: {current} → {recommended}
  Recommendation: {BLOCK MERGE|APPROVE WITH FIXES|APPROVE}
```

## Integration with Workforce Pipeline

When invoked from `/workforce-pipeline` or `/workforce-review`:
1. Runs in task mode against the task diff
2. Findings feed into the review scoring system
3. Any CRITICAL finding → override Security score to 0 → auto-REJECT
4. HIGH findings → cap Security score at 1/3
5. Results stored in task events via `workforce_task_events`

## Creating Knowledge Rules from Findings

After the audit, offer to create knowledge rules for recurring patterns:
- For each VERIFIED finding, propose a rule via `workforce_create_rule`:
  - Path: glob pattern matching affected files
  - Category: `security`
  - Priority: severity-mapped (CRITICAL=10, HIGH=8, MEDIUM=5, LOW=3)
  - Content: the finding + fix guidance

## Spawning as Agent Task

For full codebase audits, offer to spawn as an autonomous task:
```
Create analysis task with:
  task_type: "analysis"
  prompt: "Run a comprehensive security audit of the codebase following the CSO methodology..."
```

This uses the security-auditor agent profile for deeper investigation.

## Disclaimer

This tool is not a substitute for professional security audits or penetration testing. Use between professional engagements, not as your only defense.
