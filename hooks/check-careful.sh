#!/usr/bin/env bash
# Workforce safety guardrail — intercepts destructive commands
# PreToolUse hook for the Bash tool
#
# Returns JSON with permissionDecision to ask user before dangerous commands.
# Safe build-artifact targets are exempted.

set -euo pipefail

INPUT=$(cat)

# Extract tool name — only check Bash commands
TOOL_NAME=$(echo "$INPUT" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    print(data.get('tool_name', ''))
except:
    print('')
" 2>/dev/null || echo "")

if [ "$TOOL_NAME" != "Bash" ]; then
  echo '{}'
  exit 0
fi

# Extract the command
COMMAND=$(echo "$INPUT" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    print(data.get('tool_input', {}).get('command', ''))
except:
    print('')
" 2>/dev/null || echo "")

if [ -z "$COMMAND" ]; then
  echo '{}'
  exit 0
fi

# Safe directory targets — no warning needed for these
SAFE_TARGETS='node_modules|\.next|dist|__pycache__|\.cache|build|\.turbo|coverage|\.pytest_cache|\.mypy_cache|\.tox|\.venv|venv|\.parcel-cache'

warn_pattern=""

# --- Recursive deletion ---
if echo "$COMMAND" | grep -qE 'rm\s+-(r|rf|fr|Rf|fR|rfi)'; then
  if ! echo "$COMMAND" | grep -qE "($SAFE_TARGETS)"; then
    warn_pattern="recursive delete (rm -rf)"
  fi
fi

# --- Database destruction ---
if echo "$COMMAND" | grep -iqE 'DROP\s+(TABLE|DATABASE)|TRUNCATE\s+'; then
  warn_pattern="database destruction (DROP/TRUNCATE)"
fi

# --- Git force push ---
if echo "$COMMAND" | grep -qE 'git\s+push\s+.*(-f|--force)'; then
  warn_pattern="force push (git push --force)"
fi

# --- Git hard reset ---
if echo "$COMMAND" | grep -qE 'git\s+reset\s+--hard'; then
  warn_pattern="hard reset (git reset --hard)"
fi

# --- Git discard all ---
if echo "$COMMAND" | grep -qE 'git\s+(checkout|restore)\s+\.'; then
  warn_pattern="discard all changes (git checkout/restore .)"
fi

# --- Kubernetes deletion ---
if echo "$COMMAND" | grep -qE 'kubectl\s+delete'; then
  warn_pattern="kubernetes deletion (kubectl delete)"
fi

# --- Docker destruction ---
if echo "$COMMAND" | grep -qE 'docker\s+(rm\s+-f|system\s+prune|container\s+prune|volume\s+prune|image\s+prune\s+-a)'; then
  warn_pattern="docker destruction"
fi

# --- Process killing ---
if echo "$COMMAND" | grep -qE 'kill\s+-9|killall'; then
  warn_pattern="aggressive process kill (kill -9 / killall)"
fi

# --- Disk wipe ---
if echo "$COMMAND" | grep -qE 'dd\s+if=|mkfs\.|wipefs'; then
  warn_pattern="disk write/format operation"
fi

# --- Output decision ---
if [ -n "$warn_pattern" ]; then
  # Escape for JSON
  escaped_pattern=$(echo "$warn_pattern" | sed 's/"/\\"/g')
  echo "{\"permissionDecision\":\"ask\",\"message\":\"⚠️ CAREFUL: Detected ${escaped_pattern}. This command may be destructive and hard to reverse. Proceed?\"}"
else
  echo '{}'
fi
