---
name: workforce-rubberduck
description: Multi-perspective task analysis before launching. Runs CEO strategy, design UX, and engineering architecture reviews to refine prompts. Clarifies ambiguity, identifies risks, defines acceptance criteria. Use before launching complex tasks.
---

When the user invokes /workforce-rubberduck, deeply analyze a task prompt from multiple perspectives and refine it.

## Steps

1. Take the user's task prompt (provided as argument or ask for it)
2. Call `workforce_analyze_prompt` to get initial admission check and tier
3. Determine which review perspectives apply (see Perspective Selection below)
4. Run applicable perspectives
5. Synthesize into the rubberduck report
6. Output a refined, agent-ready prompt
7. Offer to launch via `workforce_create_task`, feed into `/workforce-test-plan`, or run full `/workforce-autoplan`

## Perspective Selection

Not every task needs all perspectives. Auto-select based on task characteristics:

| Perspective | When to Include | Skip When |
|---|---|---|
| **Strategy (CEO)** | Task involves new features, architectural changes, scope decisions | Simple bug fixes, config changes |
| **Design (UX)** | Task touches UI components, user flows, visual elements | Backend-only, infrastructure, scripts |
| **Engineering** | Always | Never |

For simple tasks (○ tier, <$0.10), skip Strategy and Design — run Engineering only.

## Strategy Perspective (CEO)

**Persona**: Product-minded leader who challenges premises and manages scope.

Ask these questions (internally — don't interrogate the user):
1. **Is this the right problem?** Are there simpler alternatives?
2. **Scope check**: Is this the minimal useful version, or does it have scope creep?
3. **Trajectory**: Where does this lead? Is this a one-way door or reversible?
4. **Dependencies**: What else needs to change for this to succeed?
5. **Alternatives**: Could this be solved with existing code, a library, or a different approach?

**Output**:
- Premises identified (validated or challenged)
- Scope assessment (expand / hold / reduce)
- Risk factors
- Alternative approaches considered

## Design Perspective (UX)

**Persona**: Senior product designer ensuring intentional design decisions.

Check these dimensions:
1. **Information architecture**: Is the content hierarchy clear?
2. **Interaction states**: Are loading, empty, error, success states defined?
3. **User journey**: First impression → core flow → edge cases
4. **Responsive**: Mobile/tablet/desktop considered?
5. **Accessibility**: Keyboard navigation, screen readers, color contrast
6. **AI slop risk**: Does the prompt risk generating generic UI patterns?

**Output**:
- Design completeness score (0-10)
- Missing interaction states
- Responsive considerations
- Anti-slop warnings

## Engineering Perspective (always runs)

**Persona**: Senior engineer who designs for maintainability and correctness.

### Scope Check
- What files/modules will this touch? Can you identify them from the prompt?
- Is the scope bounded enough for a single agent run (<10 min)?
- Are there hidden dependencies the prompt doesn't mention?

### Existing Solution Search
- Layer 1: Does this repo already solve this? (grep for similar logic)
- Layer 2: Do our dependencies handle this? (check docs)
- Layer 3: Is there a well-known library for this?

### Ambiguity Check
- Are there multiple valid interpretations?
- Are success criteria clear?
- Are there assumptions that should be explicit?

### Risk Assessment
- Could this break existing functionality?
- Does this touch auth, payments, data migrations, or sensitive areas?
- Are there edge cases the prompt should address?
- Could this conflict with other running tasks?

### Test Plan
- What should be tested?
- Which paths are critical (★★★), important (★★), nice-to-have (★)?

### Acceptance Criteria
- Define 3-5 concrete, verifiable acceptance criteria
- Include positive cases (it does X) and negative cases (it doesn't break Y)

## Template — Rubberduck Report

```
━━━ RUBBERDUCK ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Original: "{original_prompt}"
Tier:     {tier_indicator} {tier}   Est: ~${cost}
Perspectives: {Strategy ✓|✗} {Design ✓|✗} {Engineering ✓}

{if strategy ran:}
STRATEGY
  Premises: {validated|challenged — details}
  Scope:    {expand|hold|reduce} — {reason}
  Alternatives: {considered and why rejected, or "none better"}
  Risks:    {risk list}

{if design ran:}
DESIGN
  Completeness: {score}/10
  Missing states: {list or "all covered"}
  Responsive: {covered|gaps}
  AI slop risk: {low|medium|high — specific warnings}

ENGINEERING
  Files likely affected: {file_list}
  Bounded: {yes/no — reason}
  Existing solutions: {found|none}
  Ambiguities: {numbered list or "None detected"}
  Risks: {numbered list or "Low risk"}

ACCEPTANCE CRITERIA
  1. {criterion — verifiable}
  2. {criterion — verifiable}
  3. {criterion — verifiable}
  4. {criterion — verifiable}
  5. {criterion — verifiable}

REFINED PROMPT
"{improved_prompt_with_file_paths_acceptance_criteria_and_constraints}"

➤ Launch with refined prompt, run /workforce-autoplan for full review, edit further, or generate test plan?
```

## Prompt Refinement Rules

When rewriting the prompt:
- Add specific file paths where identifiable from context
- Add function/component names when identifiable
- Include acceptance criteria inline (e.g., "Verify that X works by Y")
- Add constraints from risk analysis (e.g., "Do not modify Z")
- If design perspective ran: include interaction state requirements
- If strategy perspective challenged scope: reflect the adjusted scope
- Keep it concise — agents work better with focused, specific prompts
- Preserve the user's original intent

## Quick Mode

For rapid-fire task refinement without the full report:
```
/workforce-rubberduck quick "fix the login bug"
```
Runs engineering perspective only, outputs just the refined prompt and acceptance criteria.
