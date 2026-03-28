---
name: workforce-careful
description: Safety guardrails — intercepts destructive commands (rm -rf, DROP TABLE, git push --force) via PreToolUse hook. Protects both user sessions and spawned agent tasks.
---

When the user invokes /workforce-careful, activate safety guardrails.

## What It Intercepts

| Pattern | Examples | Action |
|---------|---------|--------|
| Recursive deletion | `rm -rf`, `rm -r` | Ask confirmation |
| Database destruction | `DROP TABLE`, `TRUNCATE` | Ask confirmation |
| Git force push | `git push --force`, `git push -f` | Ask confirmation |
| Git hard reset | `git reset --hard` | Ask confirmation |
| Git discard all | `git checkout .`, `git restore .` | Ask confirmation |
| Kubernetes deletion | `kubectl delete` | Ask confirmation |
| Docker destruction | `docker rm -f`, `docker system prune` | Ask confirmation |
| Process killing | `kill -9`, `killall` | Ask confirmation |

**Safe exceptions** (no warning): `node_modules`, `.next`, `dist`, `build`, `coverage`, `__pycache__`, `.cache`, `.turbo`, `.venv`

## Steps

1. Check if hook is configured (look for `check-careful.sh` in settings)
2. If not: guide setup (add PreToolUse hook to `.claude/settings.json` pointing to `hooks/check-careful.sh`)
3. Set session context: `workforce_session_context` action `set`, key `careful_mode`, value `active`
   - This injects safety preamble into all spawned agent tasks
4. Confirm activation

## Hook Setup

Add to `.claude/settings.json`:
```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "Bash",
      "hooks": [{ "type": "command", "command": "bash /path/to/workforce/hooks/check-careful.sh" }]
    }]
  }
}
```

## Status

```
━━━ CAREFUL MODE ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Hook:  {✓ configured|✗ needs setup}
Agent: {✓ preamble active|✗ inactive}
```

## Limitations

Workflow safety tool, not a security boundary. Prevents accidental damage — commands can still bypass via pipes or indirect execution.
