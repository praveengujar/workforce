---
name: workforce-design
description: Design system consultation — generates complete design systems (typography, color, spacing, layout, motion) and writes DESIGN.md as source of truth. Use before building UI features to establish intentional design direction.
---

When the user invokes /workforce-design, run a design consultation to establish or refine the project's design system.

## Modes

- **New**: `/workforce-design` — create a design system from scratch
- **Update**: `/workforce-design update` — refine existing DESIGN.md
- **Extract**: `/workforce-design extract <url>` — extract design system from a live site

## Steps

### Step 1: Context Gathering

1. Check for existing `DESIGN.md` in the project root or `.claude/`
2. Read `README.md`, `package.json`, or project docs for product context
3. Detect existing UI framework (React, Vue, Svelte, etc.) and CSS approach (Tailwind, CSS modules, styled-components)
4. If DESIGN.md exists, load it as baseline for updates

### Step 2: Single Synthesis Question

Ask ONE comprehensive question that covers:
- Product purpose and target audience
- Product type (SaaS dashboard, consumer app, developer tool, marketing site, etc.)
- Aesthetic direction preference (minimal, bold, editorial, playful, corporate)
- Whether to research competitors first

Do NOT ask multiple rounds of questions. Two questions max, then proceed with reasonable defaults.

### Step 3: Competitor Research (if requested)

- Search for 5-10 competitors or comparable products
- Capture their design patterns: typography, color, layout, interaction style
- Identify what works and what to differentiate from
- Summarize findings for the user

### Step 4: Design System Proposal

Generate a complete, coherent design system covering all token categories:

#### Typography Tokens
- **Display/Hero**: Distinctive display font (avoid: Inter, Roboto, Arial, Helvetica, Montserrat, Poppins — these are overused defaults)
- **Body**: Readable sans-serif optimized for screen
- **Code/Data**: Monospace with `font-variant-numeric: tabular-nums`
- **Scale hierarchy**: specific px/rem values per level (h1 through body-sm)
- **Line heights**: per level (display: 1.1-1.2, body: 1.5-1.6)
- **Font stacks**: with proper fallbacks and CDN links

#### Color Tokens
- **Primary accent**: with hover/active/subtle variants
- **Secondary accent**: complementary, not competing
- **Neutral grayscale**: warm or cool bias (8-10 steps)
- **Semantic**: success (green), warning (amber), error (red), info (blue)
- **Dark mode strategy**: 10-20% desaturation, elevation-based backgrounds
- **All values in hex**: no magic numbers, no unnamed colors

#### Spacing Tokens
- **Base unit**: 4px or 8px
- **Scale**: 2xs(2px) → xs(4px) → sm(8px) → md(16px) → lg(24px) → xl(32px) → 2xl(48px) → 3xl(64px)
- **Density classification**: compact / comfortable / spacious

#### Layout Tokens
- **Grid system**: columns per breakpoint (375/768/1024/1440)
- **Max width**: content, wide, full
- **Border-radius hierarchy**: sm(4px) → md(8px) → lg(12px) → full(9999px)
- **Inner radius rule**: outer - padding = inner

#### Motion Tokens
- **Easing**: ease-out (enter), ease-in (exit), ease-in-out (move)
- **Duration scale**: micro(50-100ms) → short(150-250ms) → medium(250-400ms) → long(400-700ms)
- **Intensity level**: subtle / moderate / expressive
- **Respect `prefers-reduced-motion`**: always

### Step 5: Anti-Slop Enforcement

Actively reject these AI-generated design patterns:

| Anti-Pattern | What to Do Instead |
|---|---|
| Purple/violet gradient backgrounds | Use intentional brand color with purpose |
| 3-column icon-in-circle feature grid | Asymmetric layout, varied content types |
| Centered everything | Left-aligned body text, intentional alignment |
| Uniform bubbly border-radius | Hierarchical radius scale |
| Decorative SVG blobs/waves | Clean whitespace or intentional illustration |
| Emoji as design elements | Proper iconography or no icons |
| "Welcome to [X]" / "Unlock the power of..." | Specific value proposition, user's language |
| Cookie-cutter section rhythm (hero → 3 features → testimonials → pricing → CTA) | Narrative structure driven by user journey |

**Blacklisted fonts**: Papyrus, Comic Sans, Lobster, Impact, Bleeding Cowboys

### Step 6: Visual Preview

If browser tools are available (Playwright MCP), generate an HTML specimen page showing:
- Typography scale with actual font rendering
- Color palette swatches
- Spacing scale visualization
- Component examples (button, card, input)
- Dark mode toggle

If no browser, describe the aesthetic in concrete terms with specific references.

### Step 7: Write DESIGN.md

Generate `DESIGN.md` at project root with this structure:

```markdown
# Design System — {Project Name}

## Product Context
{product purpose, audience, aesthetic direction}

## Aesthetic Direction
**Name**: {e.g., "Warm Minimalist"}
**Mood**: {3-4 adjective description}
**Decoration level**: {minimal|moderate|rich}

## Typography
{font assignments, CDN links, scale with exact values}

## Color
{full palette with hex values, semantic colors, dark mode rules}

## Spacing
{base unit, density, full scale}

## Layout
{grid, breakpoints, max-width, radius hierarchy}

## Motion
{intensity, easing rules, duration scale}

## Decisions Log
{date-stamped rationale for each major choice}
```

### Step 8: Agent Integration

After writing DESIGN.md, offer to:
1. Create a knowledge rule via `workforce_create_rule` for `**/*.tsx` / `**/*.css` files:
   - Category: `standards`
   - Content: key design tokens and anti-slop rules
   - Priority: 6
2. Set session context: `design_system: active` so future tasks reference DESIGN.md

## Template — Consultation Report

```
━━━ DESIGN CONSULTATION ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Product:    {name} — {type}
Audience:   {target}
Direction:  {aesthetic name} — {mood}

TYPOGRAPHY
  Display:  {font} via {CDN}
  Body:     {font} via {CDN}
  Code:     {font} via {CDN}
  Scale:    {h1}→{h2}→{h3}→{h4}→{body}→{sm}→{xs}

COLOR
  Primary:   {hex} ████  Secondary: {hex} ████
  Neutral:   {hex range}
  Semantic:  ✓:{hex}  ⚠:{hex}  ✗:{hex}  ℹ:{hex}
  Dark mode: {strategy}

SPACING
  Base: {n}px  Density: {classification}

LAYOUT
  Grid: {cols}  Max-width: {px}  Radius: {sm}/{md}/{lg}

MOTION
  Intensity: {level}  Easing: {enter}/{exit}/{move}

ANTI-SLOP CHECK
  {✓|⚠} {each anti-pattern status}

➤ Write DESIGN.md and create knowledge rule?
```

## Spawning as Agent Task

For large design system overhauls:
```
workforce_create_task with:
  prompt: "Generate a complete design system based on DESIGN.md consultation..."
  task_type: "analysis" (investigation, no code changes)
```
