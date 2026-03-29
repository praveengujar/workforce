---
name: workforce-design
description: Design system consultation — generates typography, color, spacing, layout, motion tokens and writes DESIGN.md. Use before building UI features. Follow with /workforce-design-shotgun for visual exploration.
---

When the user invokes /workforce-design, establish or refine the project's design system.

## Modes

- **New**: `/workforce-design` — create from scratch
- **Update**: `/workforce-design update` — refine existing DESIGN.md
- **Extract**: `/workforce-design extract <url>` — extract from a live site

## Steps

### 1. Context

1. Check for existing `DESIGN.md`
2. Read README/package.json for product context
3. Detect UI framework and CSS approach

### 2. Single synthesis question

Ask ONE question covering: product purpose, audience, product type, aesthetic preference, whether to research competitors. Two questions max, then proceed with defaults.

### 3. Generate design system

Complete, coherent system covering:

**Typography**: Display font (avoid overused: Inter, Roboto, Montserrat, Poppins), body font, code font with `tabular-nums`, scale hierarchy with exact values, line heights, CDN links.

**Color**: Primary + secondary accents with variants, neutral grayscale (warm/cool), semantic colors (success/warning/error/info), dark mode strategy (10-20% desaturation). All hex values.

**Spacing**: Base unit (4px or 8px), scale from 2xs(2px) through 3xl(64px), density classification.

**Layout**: Grid columns per breakpoint (375/768/1024/1440), max-width tiers, border-radius hierarchy (sm/md/lg/full) with inner radius rule.

**Motion**: Easing (ease-out enter, ease-in exit), duration scale (50ms-700ms), `prefers-reduced-motion` respected.

### 4. Anti-slop enforcement

Actively reject these AI-generated patterns:

| Reject | Do Instead |
|--------|-----------|
| Purple/violet gradients | Intentional brand color |
| 3-column icon-in-circle grid | Asymmetric layout, varied content |
| Centered everything | Left-aligned body, intentional alignment |
| Uniform bubbly radius | Hierarchical radius scale |
| Decorative SVG blobs/waves | Clean whitespace |
| Emoji as design | Proper iconography |
| "Welcome to [X]" / "Unlock the power of..." | Specific value proposition |
| Cookie-cutter hero→features→testimonials→CTA | Narrative structure |

**Blacklisted fonts**: Papyrus, Comic Sans, Lobster, Impact, Bleeding Cowboys.

### 5. Write DESIGN.md

```markdown
# Design System — {Project Name}
## Product Context
## Aesthetic Direction (name, mood, decoration level)
## Typography (assignments, CDN, scale)
## Color (full palette, hex, dark mode rules)
## Spacing (base unit, density, scale)
## Layout (grid, breakpoints, radius hierarchy)
## Motion (easing, duration scale)
## Decisions Log (date-stamped rationale)
```

### 6. Integration

Offer to:
1. Create knowledge rule via `workforce_create_rule` for `**/*.tsx` / `**/*.css` (category: `standards`, priority: 6)
2. Set session context: `design_system: active`

## Template

```
━━━ DESIGN CONSULTATION ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Product:    {name} — {type}
Direction:  {aesthetic name} — {mood}

Typography: Display: {font}  Body: {font}  Code: {font}
Color:      Primary: {hex}  Secondary: {hex}  Dark: {strategy}
Spacing:    Base: {n}px  Density: {level}
Layout:     Grid: {cols}  Radius: {sm}/{md}/{lg}
Motion:     Intensity: {level}

Anti-slop:  {✓ all clear | ⚠ patterns found}

➤ Write DESIGN.md and create knowledge rule?
```

## Related

- `/workforce-design-shotgun`: Explore visual variants within this design system
- `/workforce-cso`: Phase 9 (OWASP) checks for XSS in rendered content
