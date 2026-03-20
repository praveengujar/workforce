---
name: workforce-rubberduck
description: Analyze and refine a task prompt before launching. Clarifies ambiguity, identifies risks, defines acceptance criteria, and outputs an improved prompt. Use before launching complex tasks.
---

When the user invokes /workforce-rubberduck, deeply analyze a task prompt and refine it.

## Steps

1. Take the user's task prompt (provided as argument or ask for it)
2. Call `workforce_analyze_prompt` to get initial admission check and tier
3. Perform deep analysis (see Analysis Framework below)
4. Present the rubberduck report
5. Output a refined, agent-ready prompt
6. Offer to launch via `workforce_create_task` or feed into `/workforce-test-plan`

## Analysis Framework

### Scope Check
- What files/modules will this touch? Can you identify them from the prompt?
- Is the scope bounded enough for a single agent run (<10 min)?
- Are there hidden dependencies the prompt doesn't mention?

### Ambiguity Check
- Are there multiple valid interpretations of this prompt?
- Are success criteria clear? How would you verify completion?
- Are there assumptions that should be made explicit?

### Risk Assessment
- Could this break existing functionality?
- Does this touch auth, payments, data migrations, or other sensitive areas?
- Are there edge cases the prompt should address?
- Could this conflict with other running tasks?

### Acceptance Criteria
- Define 3-5 concrete, verifiable acceptance criteria
- Each should be testable (manually or automated)
- Include both positive cases (it does X) and negative cases (it doesn't break Y)

## Template — Rubberduck Report

```
━━━ RUBBERDUCK ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Original: "{original_prompt}"
Tier:     {tier_indicator} {tier}   Est: ~${cost}

SCOPE
  Files likely affected: {file_list}
  Bounded: {yes/no — reason}

AMBIGUITIES
  {numbered list of ambiguities found, or "None detected"}

RISKS
  {numbered list of risks, or "Low risk"}

ACCEPTANCE CRITERIA
  1. {criterion — verifiable}
  2. {criterion — verifiable}
  3. {criterion — verifiable}

REFINED PROMPT
"{improved_prompt_with_file_paths_acceptance_criteria_and_constraints}"

➤ Launch with refined prompt, edit further, or generate test plan?
```

## Prompt Refinement Rules

When rewriting the prompt:
- Add specific file paths where you can identify them from context
- Add function/component names when identifiable
- Include acceptance criteria inline (e.g., "Verify that X works by Y")
- Add constraints from risk analysis (e.g., "Do not modify Z")
- Keep it concise — agents work better with focused, specific prompts
- Preserve the user's original intent
