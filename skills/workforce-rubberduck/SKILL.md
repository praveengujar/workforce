---
name: workforce-rubberduck
description: Multi-perspective task analysis — strategy, design, and engineering reviews to refine prompts before launching. Quick mode for engineering-only. Use before complex tasks. For full gated orchestration, use /workforce-autoplan instead.
---

When the user invokes /workforce-rubberduck, analyze a task prompt from multiple perspectives and refine it.

## Steps

1. Take the user's task prompt (argument or ask)
2. Call `workforce_analyze_prompt` for tier and cost estimate
3. Select applicable perspectives (see below)
4. Run perspectives, synthesize findings
5. Output refined prompt with acceptance criteria
6. Offer: launch, test plan, or full `/workforce-autoplan`

## Perspective Selection

| Perspective | Include When | Skip When |
|---|---|---|
| **Strategy** | New features, arch changes, scope decisions | Bug fixes, config changes |
| **Design** | UI components, user flows, visual elements | Backend-only, infrastructure |
| **Engineering** | Always | Never |

Simple tasks (○ tier): engineering only. `/workforce-rubberduck quick` forces engineering-only.

## Strategy Perspective

Challenges premises and manages scope:
- Is this the right problem? Simpler alternatives?
- Scope: minimal useful version or creeping?
- Dependencies and trajectory
- Outputs: validated/challenged premises, scope assessment, risk factors

## Design Perspective

Ensures intentional UX decisions:
- Interaction states: loading, empty, error, success defined?
- Responsive: mobile/tablet/desktop?
- AI slop risk: will the prompt produce generic UI?
- Outputs: completeness score (0-10), missing states, anti-slop warnings

## Engineering Perspective

Always runs:
- **Scope**: files affected, bounded for single agent run, hidden dependencies
- **Existing solutions**: already in repo? in dependencies? well-known library?
- **Ambiguity**: multiple interpretations? assumptions to make explicit?
- **Risk**: breaks existing functionality? sensitive areas? edge cases?
- **Acceptance criteria**: 3-5 concrete, verifiable (positive + negative cases)

## Report

```
━━━ RUBBERDUCK ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Original: "{prompt}"
Tier:     {indicator} {tier}   Est: ~${cost}
Perspectives: {Strategy ✓|—} {Design ✓|—} {Engineering ✓}

{STRATEGY — if ran}
  Premises: {validated|challenged}
  Scope: {expand|hold|reduce}
  Risks: {list}

{DESIGN — if ran}
  Completeness: {n}/10
  Missing states: {list}
  AI slop risk: {low|medium|high}

ENGINEERING
  Files: {affected list}
  Existing solutions: {found|none}
  Ambiguities: {list or none}
  Risks: {list or low}

ACCEPTANCE CRITERIA
  1. {verifiable}
  2. {verifiable}
  3. {verifiable}

REFINED PROMPT
"{improved_prompt}"

➤ Launch, run /workforce-autoplan, edit, or generate test plan?
```

## Prompt Refinement Rules

- Add specific file paths and function names when identifiable
- Include acceptance criteria inline
- Add constraints from risk analysis
- Reflect adjusted scope if strategy challenged it
- Keep concise — agents work better with focused prompts
- Preserve the user's original intent

## Related

- `/workforce-autoplan`: Full gated orchestration (includes rubberduck as Stage 1)
- `/workforce-pipeline`: Adaptive pipeline (includes rubberduck for complex tasks)
- `/workforce-launch`: Direct launch without analysis
- `/workforce-test-plan`: Generate test plan from the refined prompt
