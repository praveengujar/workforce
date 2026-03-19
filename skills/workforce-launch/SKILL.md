---
name: workforce-launch
description: Launch a new autonomous agent task. Validates the prompt, estimates cost, optionally decomposes complex tasks, and creates the task. Use when user wants to spawn an agent.
---

When the user invokes /workforce-launch, create a new autonomous task with minimal friction.

## Steps

1. If the user provided a prompt in the invocation, use it. Otherwise ask for the task prompt.

2. Call `workforce_analyze_prompt` with the prompt to check admission, tier, and cost.

3. Call `workforce_get_cost_policy` to check if cost approval is enabled. If the estimated cost from step 2 would be rejected (exceeds per-task max), show the rejection template. If it needs confirmation, ask the user before proceeding.

4. **If NOT admitted** (too broad, too vague, too short):
   - Show the rejection reason and offer to refine it yourself or decompose via /workforce-decompose

5. **If admitted**: Call `workforce_create_task` with:
   - prompt: the final prompt
   - project: derive from current directory name unless user specifies one
   - autoMerge: default false (manual review)
   Show the launch card.

## Formatting Rules

- **Tier indicator**: `○` simple, `●` medium, `◉` complex
- **Do not ask unnecessary questions** — use sensible defaults (project = cwd basename, autoMerge = false). Only ask if ambiguous.
- Since you ARE Claude, you can refine vague prompts directly — make them specific (name files, functions, expected behavior).

## Template — Successful Launch

```
  ┌─ LAUNCH ───────────────────────────────────────────┐
  │ Prompt:  {full prompt text}                        │
  │ Tier:    {indicator} {tier}   Cost: ~${est}        │
  │ Project: {project}   Review: manual                │
  │ Budget:  {cost_approval_status}                    │
  └────────────────────────────────────────────────────┘
  ✓ Task {id_8} created — {position_msg}
```

Where `{cost_approval_status}` is one of:
- `✓ Auto-approved (~$0.25)` — within policy limits
- `⚠ Needs confirmation: ...` — estimated cost exceeds threshold
- `✗ Rejected: ...` — exceeds hard per-task cap

Where `{position_msg}` is either `running now (slot X/{max})` if it started immediately, or `position {N} in queue` if pending.

## Template — Rejected Prompt

```
  ┌─ LAUNCH ───────────────────────────────────────────┐
  │ ✗ {reason}                                         │
  │ Suggestions:                                       │
  │   • {suggestion_1}                                 │
  │   • {suggestion_2}                                 │
  └────────────────────────────────────────────────────┘
```

Then offer: "Want me to refine this prompt, or decompose it into subtasks?"
