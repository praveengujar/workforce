---
name: workforce-cio
description: "Chief Information Officer — knowledge rules, eval feedback loop, session context, institutional memory. Default: rules."
---

When the user invokes /workforce-cio, manage the knowledge and learning systems. Parses first word as action.

## Default Action: rules

If no action specified, manage knowledge rules.

## Actions

### rules (default)
Create, list, query, delete path-scoped knowledge rules. `/workforce-cio` or `/workforce-cio rules`

- **List**: `workforce_list_rules` (optionally filter by category)
- **Create**: `workforce_create_rule` — guide user through category, name, paths, content, priority
- **Query**: `workforce_get_rules_for_path` — show rules matching given file paths
- **Delete**: `workforce_delete_rule`
- **Lint**: `workforce_rule_lint` — check for global wildcards, duplicates, quality issues

Categories: standards, architecture, testing, security, workflow, patterns, custom. Priority 1-10.

#### Rule Quality Reasoning (mandatory before create)

Rules feed into every future task prompt — bad rules compound across hundreds of agent runs. Before calling `workforce_create_rule`, complete this:

- **Causal-chain test**: Trace what *will go wrong* if this rule does NOT exist. If you can't name a specific past failure or a specific class of bug this prevents, the rule is decoration. Don't create it.
- **Specificity test**: Does the rule name *what* to do (or not do) and *why*? Vague rules ("write good code") are worse than no rule — they consume token budget without changing behavior. A rule should be concrete enough that two engineers would apply it the same way.
- **Existing-rule overlap check**: Run `workforce_list_rules` filtered to the same category. If a rule already covers >70% of this scope, *update the existing rule* instead. Two overlapping rules at different priorities create injection conflicts.
- **Path scope honesty**: The narrowest correct glob wins. `src/auth/**` beats `src/**` beats `**/*`. Wider scope = more tasks pay the token cost — earn the breadth with proven applicability.
- **Priority calibration**: Reserve P9-P10 for hard correctness/security rules. P5-P7 for project conventions. P1-P4 for preferences. Inflated priorities make the priority signal useless.

If any test fails, refine the rule or skip creation — surface to user with the specific failure.

```
━━━ KNOWLEDGE RULES ({count}) ━━━━━━━━━━━━━━━━━━━━━━━
  [P8] security    auth-middleware    src/auth/**
  [P6] standards   api-conventions   src/api/**
  [P4] patterns    eval-zero-work    src/**

➤ create, query <path>, delete <id>, lint
```

### eval
Process failure evals into preventive rules or feedback. `/workforce-cio eval`

1. `workforce_list_evals` with `unprocessedOnly: true`
2. Show unprocessed evals with category, severity, what happened
3. For each: user picks action — `rule_created`, `memory_updated`, or `dismissed`
4. `workforce_process_eval` executes the action
5. Also check `workforce_eval_clusters` for patterns in 3+ similar failures — suggest batch rules

```
━━━ EVAL QUEUE ({count} unprocessed) ━━━━━━━━━━━━━━━━
  {id}  {category}  {severity}  "{whatHappened_60}..."
    Root cause: {rootCause}
    ➤ Create rule, update memory, or dismiss?

{if clusters:}
CLUSTERS DETECTED
  {category}: {n} similar failures → suggested rule: "{name}"
  ➤ Apply suggested rule?
```

For batch processing, use the knowledge-curator agent (cio-curator).

### context
View and manage session context — active focus, known issues, investigation notes. `/workforce-cio context`

- **List**: `workforce_session_context` action=list
- **Set focus**: `workforce_session_context` action=set, key=active_focus
- **Add note**: `workforce_session_context` action=set, key={custom}
- **Clear**: `workforce_session_context` action=clear

```
━━━ SESSION CONTEXT ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Project: {project}

  active_focus: {value}
  known_issues: {value}
  {key}: {value}

➤ set focus, add note, clear
```

## Related

- `/workforce-cao rescue` — Failure diagnosis creates evals that CIO processes
- `/workforce-cfo retro` — Retro identifies patterns, CIO creates preventive rules
