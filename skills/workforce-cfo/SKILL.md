---
name: workforce-cfo
description: "Chief Financial Officer — health metrics, cost tracking, engineering retrospectives, budget management. Default: health."
---

When the user invokes /workforce-cfo, show financial and operational performance. Parses first word as action.

## Default Action: health

If no action specified, show the health dashboard.

## Actions

### health (default)
Visual health report with performance, cost, trends, and ops metrics. `/workforce-cfo`

1. `workforce_health_metrics` + `workforce_cost_summary` + `workforce_get_budget` (global)
2. `workforce_ops_metrics` for governance data

```
━━━ CFO DASHBOARD ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

PERFORMANCE
  Success  {pct}%  {bar}  target 85%  {✓|✗}
  One-shot {pct}%  {bar}  target 70%  {✓|✗}

COST
  Today ${today} │ Week ${week} │ Month ${month}
  By tier: Simple ${s} │ Medium ${m} │ Complex ${c}

GOVERNANCE
  Gate pass rate: {pct}%   Waivers: {n}   Merge blocks: {n}

TRENDS (14d)
  Cost: {sparkline}  avg ${avg}/day
  Tasks: {sparkline}  avg {n}/day
```

Add BUDGET section if configured. Add DIAGNOSIS (2-4 sentences) with failure drivers, cost trends, recommendations.

### retro
Engineering retrospective with velocity metrics. `/workforce-cfo retro` or `/workforce-cfo retro 14d`

Modes: default 7d, custom window (`14d`, `30d`, `24h`), compare (vs prior period).

1. Gather: `workforce_list_tasks`, `workforce_health_metrics`, `workforce_cost_summary`, `workforce_list_evals` + git metrics (commits, LOC, test ratio)
2. Compute: success rate, cost per success, test ratio, shipping streak, failure patterns

```
━━━ CFO RETRO ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Period: {start} → {end}

TWEETABLE: "{tasks} tasks, {commits} commits, {loc} LOC, {test}% tests, ${cost}"

SUMMARY
  Tasks completed: {n} {↑↓→}   Success rate: {pct}% {↑↓→}
  Total cost: ${n} {↑↓→}       Cost/success: ${n} {↑↓→}

FAILURE PATTERNS
  {category}: {count} ({pct}%) {trend}
  {unprocessed evals → run /workforce-cio eval}

TOP 3 WINS: {anchored in tasks/commits}
3 IMPROVEMENTS: {specific, actionable}
```

Voice: direct, craft-focused, senior IC energy. Never generic.

### budget
View and manage spending limits. `/workforce-cfo budget`

Show `workforce_get_budget` (global). Offer to set/update via `workforce_set_budget`.

## Related

- `/workforce-ceo` — CFO metrics inform CEO's pipeline decisions
- `/workforce-cao` — Failure forensics feeds into CFO retro patterns
