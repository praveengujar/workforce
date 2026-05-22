---
name: workforce-autonomy
description: Chief Autonomy Officer — start, stop, monitor, and triage autonomous overnight runs. Modes: shadow (log-only), park (decide but never merge), auto (merge to per-run staging branch with revert-on-failure). Default action: status.
---

When the user invokes `/workforce-autonomy`, route to the requested action. Default to `status`.

## Actions

| Action | Tool | Purpose |
|--------|------|---------|
| `status` (default) | `workforce_autonomy_status` | Show current mode, active run, lease state, policy version |
| `start <mode>` | `workforce_autonomy_start` | Begin a new run; confirm one full policy snapshot then no further prompts |
| `stop` | `workforce_autonomy_stop` | End the active run; in-flight merges complete |
| `morning` | `workforce_autonomy_morning` | Single-screen overnight triage |
| `halt` | `workforce_autonomy_halt` | Pause spawns + merges immediately; resume via `resume` |
| `resume` | `workforce_autonomy_resume` | Clear halt; reset consecutive failure counter |
| `evaluate <task_id>` | `workforce_autonomy_evaluate` | Force a policy evaluation on one task |

## Modes (be precise — they are not interchangeable)

- **shadow** — Evaluates every approval and persists a verdict to `tasks.autonomyDecision`. **Never** changes lifecycle. Safe to leave running indefinitely for calibration.
- **park** — Acts on verdicts but never merges. Parks tasks the policy approves, parks tasks it rejects. Useful for "let the agent batch-classify overnight, I'll merge in the morning."
- **auto** — Acts AND merges. Targets a per-run staging branch (`autonomous/staging/<runId>`). Never touches `main`, `master`, `release/*`, `prod`. Post-merge test failure triggers automatic `git revert`; revert conflict halts the run.

## Starting a run (the one and only confirmation)

When the user says `start <mode>`, gather the policy snapshot and ask **one** confirmation question that bundles every relevant parameter — once approved, the run proceeds without further prompts.

Before calling `workforce_autonomy_start`:

1. Call `workforce_autonomy_status` to confirm no active run exists. If one does, surface its `runId` and ask whether to stop it first or force-takeover (`force: true`).
2. Read the policy snapshot via `workforce_autonomy_status` (it returns `policyVersion`, `configHash`). Show:
   - Mode (shadow / park / auto)
   - Base branch (auto-detected from current HEAD)
   - Staging branch (will be `autonomous/staging/<new-runId>`)
   - Budget cap (USD, optional — if user said `$50 budget`, parse it)
   - Max concurrency (default 3 under auto)
   - Duration (informational; lease is 2min, refreshed by heartbeat — runs end on explicit `stop`)
   - Protected branches (from config)
   - Protected paths (from config — call out the high-risk categories)
   - Notification channels (macos default; mention Slack/email env vars if configured)
   - Policy version + config hash (for forensics)
3. Use `AskUserQuestion` ONCE with the full snapshot in the question text and options `Start`, `Adjust`, `Cancel`. If `Adjust`, ask follow-ups for the specific param.
4. On `Start`, call `workforce_autonomy_start`. Confirm the returned `runId` and `stagingBranch`. **Do not ask additional confirmation questions during the run.**

## Morning triage

When the user invokes `morning`:

1. Call `workforce_autonomy_morning`. It returns counts plus per-task summaries.
2. Render a single screen with sections, in this order:

```
━━━ AUTONOMOUS RUN: {runId} ━━━━━━━━━━━━━━━━━━━━━━━━
  Mode: {mode}    Status: {status}    Started: {startedAt}
  Staging: {stagingBranch}    Base: {baseBranch}
  Policy: {policyVersion} / cfg={configHash}
  Halt: {haltReason or "—"}    Consecutive failures: {n}

  AUTO-MERGED ({n})
  ✓ {id_8}  {target}  sha={mergeSha_7}  "{prompt_40}"

  REVERTED ({n})
  ↩ {id_8}  merge={mergeSha_7} → revert={revertSha_7}  "{prompt_40}"

  PARKED ({n})  — needs human decision
  ⏸ {id_8}  reasons: {reasons.slice(0,2).join(', ')}  "{prompt_40}"

  FAILED ({n})
  ✗ {id_8}  "{error_40}"

  NOTIFICATIONS
  Total: {total}    Undelivered: {undelivered}    Critical: {criticals}
```

Skip empty sections.

3. If anything is reverted or undelivered notifications > 0, suggest concrete next steps inline (e.g., "review `revertSha` against PR description" or "check Slack webhook env var").

## Promotion

Auto-merged work lives on staging. The user promotes manually:

```bash
git checkout main && git merge --no-ff autonomous/staging/<runId>
```

Do not script that as a slash-command action — promotion to `main` is the one place an autonomy session deliberately stays human.

## Evaluating individual tasks

`evaluate <task_id>` runs the full evidence collection + policy + action sequence for one task. Useful for:

- Forcing a re-evaluation when new evidence arrives (e.g., a security audit completed after the first pass)
- Spot-checking what the policy would do in shadow mode

Always show the returned `verdict.checks` table and `verdict.reasons` array verbatim. Don't summarize — the structured signal is the value.

## When something goes wrong

- **Lease held by another process** — `workforce_autonomy_start` will return `LEASE_HELD`. Surface the holding `pid` and `runId`; offer `Force-takeover` only after explicitly confirming the other process is gone.
- **Revert conflict** — Run halts automatically and notifies critical. Do not attempt to resolve the conflict autonomously. Tell the user which `mergeSha` is stuck and that the staging branch is untouched (the revert was aborted before changing anything).
- **Consecutive failures threshold** — Run halts. Inspect the failed tasks via `workforce_autonomy_morning` before resuming.

## Related

- `/workforce-cao morning` — General overnight forensics (not autonomy-specific)
- `/workforce-cao rescue` — Recover individual failed tasks
- `/workforce-cio` — Knowledge rule management (locked down while autonomy is in `auto`/`park`)
