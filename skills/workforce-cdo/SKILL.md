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
3. Generate: typography (display/body/code fonts, scale), color (primary/secondary/neutral/semantic, dark mode), spacing (base unit, scale), layout (grid, breakpoints, radius), motion (easing, duration)
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
4. Present lettered concepts, confirm before generating
5. Generate in parallel via independent Agent subagents
6. Ensure diversity: layout variety, density range, personality spectrum

```
━━━ CDO SHOTGUN ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Screen: {name}   Variants: {n}

A. {concept} — {strengths} / {risk}
B. {concept} — {strengths} / {risk}
C. {concept} — {strengths} / {risk}

➤ Choose (A/B/C), remix (A+B), refine (B), or new?
```

Max 3 iteration rounds. On approval: save, update session context, offer DESIGN.md update.

## Related

- `/workforce-cto review` — Design quality feeds into code review scoring
- `/workforce-cqo qa` — UI changes get Playwright visual testing
