---
name: workforce-design-shotgun
description: Multi-variant visual design exploration — generates 3-8 options in parallel, structured comparison, and feedback loop. Use after /workforce-design to explore directions for a specific screen or component.
---

When the user invokes /workforce-design-shotgun, generate multiple design variants for comparison.

## Steps

### 1. Context

1. Check for existing `DESIGN.md` — variants must respect its tokens unless user opts out
2. Check session context for prior approved designs (`design_approved_variants`) to inform taste
3. Ask ONE question covering: what screen/component, target audience, constraints

### 2. Generate variants

1. Default 3 variants (up to 8 on request). Present concept directions first:
   ```
   A. {concept_name} — {one-line description}
   B. {concept_name} — {one-line description}
   C. {concept_name} — {one-line description}
   ```
2. Confirm before generating (costs tokens)
3. Generate all variants in **parallel via independent Agent subagents**
4. Each variant: complete functional implementation in project's framework, responsive, distinct

### 3. Ensure diversity

Variants must explore meaningfully different directions — not 3 color variations of the same layout:
- Layout: at least one asymmetric, one grid-based
- Density: at least one spacious, one compact
- Personality: at least one conservative, one bold

### 4. Compare and collect feedback

```
━━━ DESIGN SHOTGUN ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Screen: {name}   Variants: {count}   DESIGN.md: {active|none}

VARIANT A: {concept_name}
  {2-3 sentences}  Strengths: {X}  Risk: {Y}

VARIANT B: ...
VARIANT C: ...

➤ Choose (A/B/C), remix (A+B), refine (B with changes), or new directions?
```

If Playwright MCP available: generate comparison board in browser with screenshots.

### 5. Iterate and save

- Max 3 rounds before asking user to converge
- On approval: save code to project, update session context (`design_approved_variants`)
- If new patterns emerge: offer to update DESIGN.md

## Anti-Slop

Every variant is checked against the blacklist from `/workforce-design` before presentation. Reject and regenerate any variant with: purple gradients, 3-column icon grids, centered-everything, uniform bubbly radius, decorative SVG blobs, emoji as design, generic hero copy.

## Related

- `/workforce-design`: Create the design system first — shotgun explores within it
- `/workforce-review`: Design review scoring includes code quality of UI changes
