---
name: workforce-cro
description: "Chief Risk Officer — safety guardrails, destructive command interception. Protects user sessions and spawned agents. Default: careful."
---

When the user invokes /workforce-cro, activate safety guardrails.

## Default Action: careful

If no action specified, activate careful mode.

## Actions

### careful (default)
Intercept destructive commands via PreToolUse hook + inject safety preamble into spawned agents.

Intercepts: `rm -rf`, `DROP TABLE`, `TRUNCATE`, `git push --force`, `git reset --hard`, `git checkout .`, `kubectl delete`, `docker rm -f`, `docker system prune`, `kill -9`.

Safe exceptions (no warning): `node_modules`, `.next`, `dist`, `build`, `coverage`, `__pycache__`, `.cache`, `.turbo`, `.venv`

1. Check if hook is configured (look for `check-careful.sh` in settings)
2. If not: guide setup — add PreToolUse hook to `.claude/settings.json` pointing to `hooks/check-careful.sh`
3. Set session context: `workforce_session_context` set `careful_mode` = `active` (injects safety preamble into spawned tasks)

```
━━━ CRO: CAREFUL MODE ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Hook:  {✓ configured|✗ needs setup}
Agent: {✓ preamble active|✗ inactive}
```

Deactivate: set `careful_mode` = `inactive`.

Limitation: workflow safety tool, not security boundary. Prevents accidental damage.

## Related

- `/workforce-cso` — Security audits (different from risk prevention)
- `/workforce-cao` — Audit officer handles post-failure analysis
