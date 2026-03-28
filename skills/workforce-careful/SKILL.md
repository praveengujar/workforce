---
name: workforce-careful
description: Safety guardrails for destructive commands. Intercepts rm -rf, DROP TABLE, git push --force, and other dangerous operations. Protects both user sessions and spawned agent tasks.
---

When the user invokes /workforce-careful, activate safety guardrails for the current session and all spawned agent tasks.

## What It Does

Intercepts potentially destructive commands before execution via a PreToolUse hook on the Bash tool. Also injects a safety preamble into all spawned agent task prompts so autonomous agents self-regulate.

## Intercepted Patterns

| Pattern | Command Examples | Action |
|---------|-----------------|--------|
| **Recursive deletion** | `rm -rf`, `rm -r` | Ask confirmation |
| **Database destruction** | `DROP TABLE`, `DROP DATABASE`, `TRUNCATE` | Ask confirmation |
| **Git force push** | `git push --force`, `git push -f` | Ask confirmation |
| **Git hard reset** | `git reset --hard` | Ask confirmation |
| **Git discard all** | `git checkout .`, `git restore .` | Ask confirmation |
| **Kubernetes deletion** | `kubectl delete` | Ask confirmation |
| **Docker destruction** | `docker rm -f`, `docker system prune` | Ask confirmation |
| **Process killing** | `kill -9`, `killall` | Ask confirmation |
| **Disk wipe** | `dd if=`, `mkfs` | Ask confirmation |

## Safe Exceptions

No warning when recursive deletion targets only build artifacts:
- `node_modules`, `.next`, `dist`, `__pycache__`, `.cache`, `build`, `.turbo`, `coverage`
- `.pytest_cache`, `.mypy_cache`, `.tox`, `.venv`, `venv`, `.parcel-cache`

## Steps

1. Check if the careful hook is already configured:
   - Look for `check-careful.sh` in `.claude/settings.json` or `.claude/settings.local.json`
2. If not configured, install it:
   - The hook script lives at `hooks/check-careful.sh` in the workforce plugin directory
   - Guide the user to add the PreToolUse hook to their project settings (see Activation below)
3. Set session context via `workforce_session_context` with action `set`, key `careful_mode`, value `active`
   - This signals the worker-manager to inject the safety preamble into all spawned task prompts
4. Confirm activation with a status card

## Activation

### Hook setup (user session protection)

Add to `.claude/settings.json`:
```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "bash /path/to/workforce/hooks/check-careful.sh"
          }
        ]
      }
    ]
  }
}
```

Replace `/path/to/workforce` with the actual plugin directory path.

### Agent protection (spawned task injection)

When `careful_mode` is `active` in session context, the following preamble is injected into every spawned task:

> **SAFETY CONSTRAINT**: Before executing any destructive command (rm -rf, DROP TABLE, git push --force, git reset --hard, kubectl delete, docker rm -f), verify this is absolutely necessary and intentional. Never delete files outside your worktree scope. Never force-push. Never drop tables without explicit instruction. If unsure, skip the destructive operation and document what you would have done.

## Template

```
━━━ CAREFUL MODE ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Status: {ACTIVE|INACTIVE}

Hook protection (your session):
  {✓|✗} PreToolUse hook {configured|needs setup}

Agent protection (spawned tasks):
  {✓|✗} Safety preamble injection {active|inactive}

Intercepting:
  ✓ Recursive deletion (rm -rf)
  ✓ Database destruction (DROP/TRUNCATE)
  ✓ Git force push / hard reset / discard
  ✓ Kubernetes / Docker destruction
  ✓ Process killing (kill -9)

Safe exceptions: node_modules, dist, build, coverage, .cache
```

## Deactivation

To deactivate:
1. Call `workforce_session_context` with action `set`, key `careful_mode`, value `inactive`
2. Remove the hook from settings (optional — the hook is lightweight)

## Limitations

This is a **workflow safety tool**, not a security boundary. It prevents accidental damage from autonomous agents and user commands. A command could still bypass it via pipes, heredocs, or indirect execution (e.g., `python -c "import shutil; shutil.rmtree('/')""`). The goal is catching the 95% case where an agent runs a destructive command without thinking.
