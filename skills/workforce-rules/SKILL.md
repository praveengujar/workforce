---
name: workforce-rules
description: Manage domain knowledge rules — create, list, query by path, and delete. Rules are path-scoped domain knowledge injected into agent context. Use to encode team standards, architectural patterns, and institutional knowledge.
---

When the user invokes /workforce-rules, manage the knowledge rules database.

## Steps

1. Call `workforce_list_rules` to show current rules
2. Present the rules dashboard using the template below
3. Offer actions: create, query by path, view category, or delete

## Actions

### Create a Rule
Ask for:
- **Category**: standards, architecture, testing, security, workflow, patterns, custom
- **Name**: Short descriptive name (e.g., "auth-jwt-validation", "react-hooks-patterns")
- **Paths**: Array of glob patterns for file scoping (e.g., `["src/auth/**", "src/middleware/**"]`)
- **Content**: The actual knowledge/standard to inject into agent context
- **Priority**: 1-10 (higher = injected first, default 5)

Call `workforce_create_rule` with the collected inputs.

### Query by Path
Ask for file paths or extract from context. Call `workforce_get_rules_for_path` with the paths.
Show which rules match and their content — this is the "audit mapping" that tells you what standards apply to specific files.

### Delete a Rule
Show current rules, ask for ID. Call `workforce_delete_rule`.

## Template — Rules Dashboard

```
━━━ KNOWLEDGE RULES ({count} rules) ━━━━━━━━━━━━━━━━━━━━━━━━━

BY CATEGORY
┌──────────────┬───────┬──────────────────────────────────────┐
│ Category     │ Count │ Top Rules                            │
├──────────────┼───────┼──────────────────────────────────────┤
│ standards    │   {n} │ {name1}, {name2}                     │
│ architecture │   {n} │ {name1}, {name2}                     │
│ testing      │   {n} │ {name1}, {name2}                     │
│ security     │   {n} │ {name1}, {name2}                     │
│ workflow     │   {n} │ {name1}, {name2}                     │
│ patterns     │   {n} │ {name1}, {name2}                     │
│ custom       │   {n} │ {name1}, {name2}                     │
└──────────────┴───────┴──────────────────────────────────────┘

➤ Create, query by path, view category, or delete?
```

## Path Query Template

```
━━━ RULES FOR: {paths} ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

{n} matching rules:

[P{priority}] {name} ({category})
Paths: {glob_patterns}
{content}

---
[P{priority}] {name} ({category})
Paths: {glob_patterns}
{content}
```

## How Rules Work

Rules are injected into agent task prompts automatically when a task is spawned. The worker manager:
1. Extracts file paths mentioned in the task prompt
2. Matches those paths against all rules' glob patterns
3. Injects matching rules into the effective prompt as `[Knowledge Rules]`

This means agents become domain experts for the specific files they're working on — auth rules for auth code, testing standards for test files, etc.

## Tips

- Start with 5-10 rules for your most common mistakes (anti-patterns, naming conventions, required patterns)
- Use `**` for recursive matching: `src/auth/**` matches all files under src/auth/
- Higher priority rules are injected first (useful when prompt space is limited)
- Rules with the same category+name are upserted (updated, not duplicated)
- Use `/workforce-eval` to discover what rules are needed based on task failures
