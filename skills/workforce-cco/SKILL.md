---
name: workforce-cco
description: "Chief Communications Officer — technical writing, docs generation, README, API reference, tutorials, changelog prose. Default: docs."
---

When the user invokes /workforce-cco, handle technical writing and documentation. Parses first word as action.

## Default Action: docs

If no action specified, audit and update project docs.

## Actions

### docs (default)
Audit existing docs, identify gaps, draft updates. `/workforce-cco`

1. Detect doc surface: README.md, docs/, CONTRIBUTING.md, AGENTS.md, in-code docstrings
2. Diff docs against current code (recent git log + key entry points) — flag drift
3. **Writing reasoning** — before drafting:
   - **Audience analysis**: Who reads this? (first-time evaluator / contributor / operator / API consumer). Each audience needs a different doc — don't merge them.
   - **Job-to-be-done**: What is the reader trying to *do* in 5 minutes? Lead with that. Background goes later or in a linked appendix.
   - **Drift check**: Does the existing doc describe code that no longer exists? Cite removed APIs / changed flags / renamed files explicitly.
4. Draft updates — match existing voice and structure
5. Anti-slop enforcement — reject: "robust", "leverage", "seamlessly", "powerful", "in today's fast-paced world", "we're excited to announce", emoji decoration, marketing adjectives in reference docs

```
━━━ CCO DOCS AUDIT ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Surface:    {n} files   Drift: {n} sections stale
Gaps:       {missing topic 1}, {missing topic 2}
Voice:      {detected: terse-technical | narrative | tutorial}
Anti-slop:  {✓ clean | ⚠ {n} hits}
➤ Update {file}, draft {topic}, or skip?
```

### readme
Generate or rewrite README.md. `/workforce-cco readme`

Sections in this order: one-line description → install → 60-second quickstart → primary use cases (3 max) → links to deeper docs. No badges-as-decoration, no logo unless brand-approved, no "Why X?" filler section.

### api-ref
Generate API reference from code — function/method signatures, params, return types, errors, one example per function. `/workforce-cco api-ref [path]`

1. Parse exports from target path (or auto-detect public surface)
2. Extract types, JSDoc/docstrings if present
3. For each: signature, what it does in one sentence, params table, returns, throws, **one** runnable example
4. Flag undocumented params, missing return types, examples that won't compile

### tutorial
Step-by-step task-oriented walkthrough. `/workforce-cco tutorial {topic}`

Structure: prerequisites → goal (what reader will have built) → numbered steps with verification check after each → troubleshooting → next steps. Every command must be copy-pasteable. Every output snippet must be real, not invented.

### changelog-prose
Convert git log / merged tasks into human-readable changelog prose. `/workforce-cco changelog-prose`

1. Pull commits since last tag (or `workforce_list_tasks` filtered done+unreleased)
2. Group: Added / Changed / Fixed / Deprecated / Removed / Security
3. One line per item — what the *user* notices, not what the code does. "Fixed worktree cleanup race" not "Refactored cleanupWorktree() to use Promise.all"
4. Hand off draft to `/workforce-cpo release` for tagging

## Hand-offs

For deep autonomous documentation work, spawn `cco-writer` agent.

## Related

- `/workforce-cpo release` — Consumes changelog-prose output
- `/workforce-cmo launch-post` — Marketing-tone announcements (different audience, different voice)
- `/workforce-cdo consult` — Visual design system (CCO handles words, CDO handles pixels)
