---
name: workforce-design-shotgun
description: Multi-variant visual design exploration — generates 3-8 design options in parallel, shows side-by-side comparison, and collects structured feedback. Use when exploring visual directions for a feature or page.
---

When the user invokes /workforce-design-shotgun, generate multiple design variants for comparison and selection.

## Steps

### Step 1: Session Detection

1. Check session context via `workforce_session_context` for prior design explorations (`design_shotgun_last`)
2. If prior explorations exist, offer to revisit or start fresh
3. Check for `DESIGN.md` — if it exists, variants must respect its tokens (unless user opts out)

### Step 2: Context Gathering

Collect 5 dimensions (2 questions max, then proceed with assumptions):

1. **What screen/component?** — which page, feature, or UI element
2. **Target audience** — who will see this
3. **Job to be done** — what the user is trying to accomplish on this screen
4. **Constraints** — existing code patterns, framework limitations, responsive requirements
5. **Edge cases** — empty states, error states, loading states, long content

### Step 3: Taste Memory

1. Check session context for `design_approved_variants` (prior approved designs)
2. If prior approvals exist, summarize aesthetic biases:
   - "Previous approvals show preference for: high contrast, generous whitespace, sans-serif"
3. Auto-bias generation toward user's established taste (but still explore)

### Step 4: Variant Generation

1. Determine variant count: default 3, up to 8 if user requests more
2. Present concept directions as lettered options with one-line descriptions:
   ```
   Generating {n} variants for: {screen/component}

   A. {concept_name} — {one-line aesthetic description}
   B. {concept_name} — {one-line aesthetic description}
   C. {concept_name} — {one-line aesthetic description}
   ```
3. Confirm with user before generating (these cost tokens)
4. Generate all variants in **parallel via independent Agent subagents**

Each variant should be:
- A complete, functional implementation (not a mockup)
- Written in the project's actual framework (React, Vue, etc.)
- Responsive (mobile-first)
- Respecting DESIGN.md tokens (if active)
- Distinct from other variants — don't generate 3 similar options

### Step 5: Comparison Board

If browser tools (Playwright MCP) are available:
1. Generate an HTML comparison board showing all variants side-by-side
2. Open in browser via `browser_navigate`
3. Include mobile and desktop viewports for each
4. Take screenshots of each variant for reference

If no browser:
1. Describe each variant in concrete, specific terms
2. Highlight the key differentiators between variants
3. Include code snippets showing the distinct approaches

### Step 6: Structured Feedback

Present the comparison and collect feedback:

```
━━━ DESIGN SHOTGUN ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Screen: {name}   Variants: {count}   DESIGN.md: {active|none}

VARIANT A: {concept_name}
  {2-3 sentence description of visual approach}
  Strengths: {what this variant does well}
  Risk: {what might not work}

VARIANT B: {concept_name}
  {2-3 sentence description}
  Strengths: {what this variant does well}
  Risk: {what might not work}

VARIANT C: {concept_name}
  {2-3 sentence description}
  Strengths: {what this variant does well}
  Risk: {what might not work}

{screenshots if browser available}

➤ Choose a variant (A/B/C), request remixes, or explore new directions?
```

### Step 7: Iteration

Handle feedback actions:

| Action | What Happens |
|--------|-------------|
| **Choose A** | Approve variant A, save to approved record |
| **Remix A+B** | Take elements from A and B, generate hybrid |
| **Refine B** | Keep B's direction, adjust specific elements per feedback |
| **New directions** | Generate entirely new concepts |
| **More variants** | Add N more options to the pool |

Iterate until user approves a direction. Max 3 rounds before asking user to converge.

### Step 8: Save & Apply

On approval:

1. Save the approved variant's code to the appropriate project location
2. Update session context:
   ```
   workforce_session_context: set
     key: design_approved_variants
     value: "{screen}: {variant_letter} - {concept_name} ({date})"
   ```
3. If the variant introduces new patterns not in DESIGN.md, offer to update DESIGN.md
4. Offer to create a workforce task to implement the approved design across related screens

## Anti-Slop Enforcement

Every generated variant is checked against the anti-slop blacklist from `/workforce-design`:
- No purple gradients
- No 3-column icon grids
- No centered-everything layouts
- No uniform bubbly radius
- No decorative SVG blobs
- No emoji as design
- No generic hero copy
- No cookie-cutter section rhythm

If a variant triggers an anti-slop pattern, regenerate it before showing to the user.

## Variant Diversity Strategy

Ensure variants explore meaningfully different directions:

- **Layout**: at least one asymmetric, one grid-based, one single-column
- **Color temperature**: at least one warm, one cool (if 3+ variants)
- **Density**: at least one spacious, one compact
- **Personality**: at least one conservative/corporate, one bold/editorial
- **Interaction model**: at least one progressive disclosure, one all-at-once

Don't generate 3 variations of the same basic layout with different colors. That's not exploration — that's color-picking.

## Agent Task Mode

For complex design explorations, spawn parallel agent tasks:
```
workforce_create_task with task_type: "analysis" for each variant
  depends_on: [] (all independent, run in parallel)
  task_group: "design-shotgun-{screen}"
```

Each agent generates one variant independently. Results collected via `workforce_group_status`.
