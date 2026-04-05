---
name: workforce-cdo
description: "Chief Design Officer — design system consultation, multi-variant exploration, anti-slop enforcement. Default: consult."
---

When the user invokes /workforce-cdo, handle design system work. Parses first word as action.

## Default Action: consult

If no action specified, run design consultation.

## Actions

### consult (default)
Generate complete design system → writes DESIGN.md. `/workforce-cdo` or `/workforce-cdo consult`

Modes: new (from scratch), update (refine existing), extract (from live URL).

1. Check for existing DESIGN.md, detect UI framework + CSS approach
2. Ask ONE question: product purpose, audience, aesthetic preference
3. **Design reasoning** — before generating tokens:
   - **Audience analysis**: Who uses this product? (developer tools → dense, information-rich / consumer → spacious, friendly). What context? (desk + focus / mobile + distracted / both). What feeling should the UI evoke? (trust / energy / calm / precision)
   - **Competitive differentiation**: What do 3 similar products look like? What visual pattern would make THIS product feel distinct? Don't default to "modern SaaS blue" — reason about what makes this product unique.
   - **Constraint reasoning**: What existing elements (brand, colors, fonts) MUST be preserved? What technical constraints? (dark mode required? accessibility standards? print?) How do constraints narrow the design space?
4. Generate: typography (display/body/code fonts, scale), color (primary/secondary/neutral/semantic, dark mode), spacing (base unit, scale), layout (grid, breakpoints, radius), motion (easing, duration)
4. Anti-slop enforcement — reject: purple gradients, 3-column icon grids, centered-everything, uniform bubbly radius, SVG blobs, emoji-as-design, generic hero copy
5. Write DESIGN.md, offer to create knowledge rule for UI files

```
━━━ CDO CONSULTATION ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Direction: {aesthetic name} — {mood}
Typography: {display} / {body} / {code}
Color:      Primary {hex}  Secondary {hex}  Dark: {strategy}
Spacing:    Base {n}px  Density: {level}
Anti-slop:  {✓ clean | ⚠ patterns found}
➤ Write DESIGN.md and create rule?
```

Blacklisted fonts: Papyrus, Comic Sans, Lobster, Impact, Bleeding Cowboys.

### shotgun
Multi-variant visual exploration (3-8 options). `/workforce-cdo shotgun`

1. Check DESIGN.md (variants must respect tokens unless opted out)
2. Check session context for taste memory (prior approved designs)
3. Ask ONE question: what screen/component, constraints
4. **Variant diversity reasoning** — before generating:
   - **Axes of variation**: List 3+ dimensions to vary across: density, color temperature, typography weight, layout structure, visual hierarchy, interaction style. Each variant MUST differ on at least 2 axes from every other variant.
   - **Per-variant rationale**: For each variant, state: "This variant prioritizes {X} at the expense of {Y}" and "This would work best for users who {behavior}." This prevents variants that are superficially different but structurally identical.
5. Present lettered concepts, confirm before generating
6. Generate in parallel via independent Agent subagents
7. Ensure diversity across the identified axes

```
━━━ CDO SHOTGUN ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Screen: {name}   Variants: {n}

A. {concept} — {strengths} / {risk}
B. {concept} — {strengths} / {risk}
C. {concept} — {strengths} / {risk}

After presenting variants, **MUST use `AskUserQuestion`**:
- Question: "Which design direction?"
- Options: "Choose A", "Choose B", "Choose C", "Remix/refine (describe in notes)"
```

Max 3 iteration rounds. On approval: save, update session context, offer DESIGN.md update.

## Related

- `/workforce-cto review` — Design quality feeds into code review scoring
- `/workforce-cqo qa` — UI changes get Playwright visual testing
