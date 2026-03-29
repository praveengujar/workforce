---
name: workforce-retro
description: Engineering retrospective — agent task performance, shipping velocity, failure patterns, cost efficiency. Compare mode for trends. Use for weekly reviews or after sprints.
---

When the user invokes /workforce-retro, run a retrospective on agent performance and code velocity.

## Modes

- **Default**: `/workforce-retro` — last 7 days
- **Custom**: `/workforce-retro 14d`, `/workforce-retro 30d`, `/workforce-retro 24h`
- **Compare**: `/workforce-retro compare` — current vs. prior period side-by-side

## Steps

### 1. Gather data (parallel)

**Task metrics**: `workforce_list_tasks`, `workforce_health_metrics`, `workforce_cost_summary`, `workforce_list_evals`

**Git metrics**: commits, authors, insertions/deletions, test LOC ratio, file hotspots (use midnight-aligned `--since` for day/week windows)

### 2. Compute key metrics

| Metric | Source |
|--------|--------|
| Tasks completed / failed / success rate | workforce_list_tasks |
| Avg task duration, retry rate | workforce_health_metrics |
| Total cost, cost per success | workforce_cost_summary |
| Commits, net LOC, test ratio | git log |
| Shipping streak (consecutive days with merges) | git log |
| Top failure categories + trends | workforce_list_evals |

### 3. Report

```
━━━ WORKFORCE RETRO ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Period: {start} → {end}

TWEETABLE
"{tasks_done} tasks, {commits} commits, {net_loc} LOC, {test_ratio}% tests, ${cost} | Streak: {n}d"

SUMMARY
┌────────────────────┬─────────┬───────┐
│ Metric             │  Value  │ Trend │
├────────────────────┼─────────┼───────┤
│ Tasks completed    │  {n}    │ {↑↓→} │
│ Success rate       │  {pct}% │ {↑↓→} │
│ Total cost         │ ${n}    │ {↑↓→} │
│ Cost per success   │ ${n}    │ {↑↓→} │
│ Test ratio         │  {pct}% │ {↑↓→} │
│ Shipping streak    │  {n}d   │       │
└────────────────────┴─────────┴───────┘

FAILURE PATTERNS
  1. {category} — {count} ({pct}%) {trend}
  2. {category} — {count} ({pct}%) {trend}
  {unprocessed evals: run /workforce-eval to process}

TOP 3 WINS
  {specific, anchored in tasks/commits}

3 IMPROVEMENTS
  {specific, actionable, anchored in data}
```

### 4. Persist snapshot

Save key metrics to session context (`last_retro` key) for future trend comparison.

## Compare Mode

Compute both current and prior period, show side-by-side with delta arrows. Highlight biggest improvements and regressions with narrative explanation.

## Voice

Direct, craft-focused, senior IC energy. Anchor all praise and criticism in specific tasks and metrics — never generic.

## Related

- `/workforce-rescue`: Focused failure diagnosis (individual tasks) — retro provides systemic view
- `/workforce-health`: Operational dashboard — retro adds velocity, patterns, and recommendations
