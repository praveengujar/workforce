---
name: workforce-cmo
description: "Chief Marketing Officer — positioning, launch posts, landing copy, release announcements, persona development. Default: position."
---

When the user invokes /workforce-cmo, handle marketing and positioning work. Parses first word as action.

## Default Action: position

If no action specified, draft positioning for the project.

## Operating Model

Three tiers — match the tier to the request:
- **Human-led**: brand strategy, naming, pricing — surface options, never decide alone
- **Augmented**: copy drafts, persona analysis, headline variants — generate, the user edits
- **Autonomous**: cross-channel formatting (LinkedIn / X / blog from one source) — execute and present

## Actions

### position (default)
Draft positioning statement and one-liner. `/workforce-cmo`

1. Read README, key feature files, recent merged tasks for ground truth
2. **Positioning reasoning** — before drafting:
   - **Category**: What category does this compete in? Don't invent a category — audiences don't search for new categories.
   - **For-whom**: Who is the target user, specifically? "Developers" is too broad. "Solo founders shipping side projects on weekends" is usable.
   - **Unlike-what**: What is the most likely alternative the target user is using today? Position against *that*, not against the market leader.
   - **Proof**: What single concrete capability proves the claim? Not a list — one thing the alternative cannot do.
3. Generate 3 positioning variants on different axes (jobs-to-be-done / against-incumbent / category-creating)
4. Anti-slop enforcement — reject: "revolutionary", "game-changing", "AI-powered" (unless that's the actual diff), "next-generation", "world-class", "synergy", abstract benefits without proof, headlines that work for any product

```
━━━ CMO POSITIONING ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Category:   {chosen category}
For:        {specific persona}   Unlike: {actual alternative}
Proof:      {single capability that proves it}

A. {variant headline} — angle: {jobs-to-be-done}
B. {variant headline} — angle: {against-incumbent}
C. {variant headline} — angle: {category-creating}

After presenting, **MUST use `AskUserQuestion`**:
- Question: "Which positioning angle?"
- Options: "Choose A", "Choose B", "Choose C", "None — refine (notes)"
```

### launch-post
Draft a launch post for one channel. `/workforce-cmo launch-post {linkedin|x|blog|hn}`

Channel-specific structure:
- **linkedin**: hook (first line under 12 words) → 1-2 sentences of context → 3-4 bullets of substance → one-line takeaway → soft CTA. No hashtag spam.
- **x**: hook tweet under 240 chars → thread of 4-7 posts → final post with link. Each tweet must work standalone.
- **blog**: title (specific, not clever) → TL;DR (3 bullets) → why-this-matters → what-we-built → how-to-try → what's-next
- **hn**: title in HN style (no marketing words, fact-stating) → first comment from author with technical depth

Voice: confident, specific, no hype. Show the artifact, don't describe how great it is.

### landing-copy
Generate landing page copy. `/workforce-cmo landing-copy`

Sections: hero (headline + subhead + primary CTA) → problem (3 sentences max) → solution (with one screenshot/diagram callout) → 3 capability blocks (each: verb-led headline + 2-sentence proof) → social proof or "who this is for" → secondary CTA. No testimonial-fabrication. If the user has no testimonials, leave a TODO marker — never invent quotes.

### release-announce
Marketing-tone version of a release. `/workforce-cmo release-announce`

1. Pull from `/workforce-cpo release` draft or git tag
2. Translate technical changelog into user-benefit framing
3. Output: short post (LinkedIn-ready) + long post (blog-ready) + one-tweet summary
4. Cross-link to docs, never invent capabilities not in the changelog

### persona
Build or refine a target persona. `/workforce-cmo persona {name}`

Structure: who they are (role, context) → what they're trying to do → what's blocking them today → where they look for solutions → what would make them try this → what would make them stay. One persona per request — composite personas are slop.

## Voice DNA

Save approved copy snippets to session context (`workforce_write_context`, key: `cmo_voice_samples`). Reuse on subsequent runs to maintain consistent tone.

## Hand-offs

For multi-channel campaign generation, spawn `cmo-strategist` agent.

## Related

- `/workforce-cco docs` — Reference docs (technical voice, not marketing voice)
- `/workforce-cpo release` — Source of truth for what shipped
- `/workforce-cdo consult` — Visual identity that pairs with positioning
