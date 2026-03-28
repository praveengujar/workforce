---
name: workforce-retro
description: Engineering retrospective analyzing agent task history, shipping velocity, failure patterns, and code quality metrics. Team-aware with per-agent breakdowns, praise, and improvement areas. Use for weekly reviews or after sprints.
---

When the user invokes /workforce-retro, run a comprehensive retrospective on agent task performance and code shipping velocity.

## Modes

- **Default**: `/workforce-retro` — last 7 days
- **Custom window**: `/workforce-retro 14d`, `/workforce-retro 30d`, `/workforce-retro 24h`
- **Compare**: `/workforce-retro compare` — current window vs. prior window (side-by-side)

## Steps

### Step 1: Gather Data (parallel)

Run these data collection steps in parallel:

**A. Task metrics** (from workforce tools):
1. Call `workforce_list_tasks` — get all tasks (no filter) to analyze by status
2. Call `workforce_health_metrics` — get success/failure/retry rates
3. Call `workforce_cost_summary` — get cost breakdown by period
4. Call `workforce_list_evals` — get failure evaluations for pattern analysis

**B. Git metrics** (from git history):
```bash
# Core metrics: commits, authors, stats (midnight-aligned window)
git log origin/$(git symbolic-ref refs/remotes/origin/HEAD --short | sed 's|origin/||') \
  --since="{window_start}T00:00:00" --format="%H|%aN|%ai|%s" --shortstat

# Test vs production LOC
git log origin/main --since="{window_start}T00:00:00" \
  --format="COMMIT:%H|%aN" --numstat

# File hotspots
git log origin/main --since="{window_start}T00:00:00" \
  --format="" --name-only | sort | uniq -c | sort -rn | head -20

# Merged workforce branches
git branch -r --merged | grep 'wf/' | wc -l
```

**C. Session metrics** (from git + tasks):
- Detect coding sessions using 45-minute gap threshold between commits
- Classify: Deep (50+ min), Medium (20-50 min), Micro (<20 min)
- Calculate LOC per session-hour

### Step 2: Compute Metrics

| Metric | Formula |
|--------|---------|
| **Tasks completed** | Status = done in window |
| **Tasks failed** | Status = failed in window |
| **Success rate** | done / (done + failed) |
| **Avg task duration** | Mean(completedAt - startedAt) |
| **Retry rate** | Tasks with retryCount > 0 / total |
| **Total cost** | Sum of task costs in window |
| **Cost per success** | Total cost / tasks completed |
| **Commits** | Total commits to main in window |
| **Net LOC** | Insertions - deletions |
| **Test ratio** | Test LOC / Total LOC |
| **Commit types** | feat/fix/refactor/test/chore/docs breakdown |
| **Shipping streak** | Consecutive days with merged tasks |
| **Focus score** | % commits to primary directory |
| **Eval patterns** | Most common failure categories |

### Step 3: Analyze Patterns

**Failure patterns** (from evals):
- Group failures by category (zero_work, merge_failure, timeout, etc.)
- Identify recurring root causes
- Track whether knowledge rules have reduced repeat failures

**Velocity patterns**:
- Commits per day trend
- Task throughput trend (tasks completed per day)
- Are tasks getting faster or slower?

**Quality signals**:
- Test ratio trend (improving or declining?)
- File hotspots (churn = potential architectural debt)
- Review scores trend (from approved tasks)

**Cost efficiency**:
- Cost per completed task trend
- Tier distribution (are we using the right task complexity?)
- Budget utilization

### Step 4: Generate Report

## Template

```
━━━ WORKFORCE RETRO ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Period: {start_date} → {end_date} ({window})

TWEETABLE
"{period}: {tasks_done} tasks shipped, {commits} commits, {net_loc} LOC, {test_ratio}% tests, ${total_cost} spent | Streak: {streak}d"

SUMMARY
┌────────────────────┬─────────┬──────────────────────┐
│ Metric             │  Value  │ Trend                │
├────────────────────┼─────────┼──────────────────────┤
│ Tasks completed    │  {n}    │ {↑↓→} vs last period │
│ Tasks failed       │  {n}    │ {↑↓→}               │
│ Success rate       │  {pct}% │ {↑↓→}               │
│ Avg duration       │  {Xm}   │ {↑↓→}               │
│ Total commits      │  {n}    │ {↑↓→}               │
│ Net LOC            │ +{n}    │ {↑↓→}               │
│ Test ratio         │  {pct}% │ {↑↓→}               │
│ Total cost         │ ${n}    │ {↑↓→}               │
│ Cost per success   │ ${n}    │ {↑↓→}               │
│ Shipping streak    │  {n}d   │                      │
│ Focus score        │  {pct}% │                      │
└────────────────────┴─────────┴──────────────────────┘

{if compare mode: show side-by-side with previous period}

VELOCITY
  Commit type breakdown:
    feat: {pct}%  fix: {pct}%  refactor: {pct}%  test: {pct}%  chore: {pct}%
  Tasks per day: {avg} (peak: {peak_day})
  LOC per session-hour: {n}

FAILURE ANALYSIS
  Top failure categories:
    1. {category} — {count} ({pct}%) — {trend}
    2. {category} — {count} ({pct}%) — {trend}
    3. {category} — {count} ({pct}%) — {trend}

  {if rules reduced failures:}
  Rules that prevented repeats:
    ✓ "{rule_name}" — blocked {n} potential {category} failures

  Unprocessed evals: {count} (run /workforce-eval to process)

COST BREAKDOWN
  By tier:  Simple: ${n} ({pct}%)  Medium: ${n} ({pct}%)  Complex: ${n} ({pct}%)
  By day:   {sparkline or bar chart of daily spend}
  Budget:   ${used}/${limit} ({pct}% of {period} budget)

CODE QUALITY
  Test ratio: {pct}% {assessment}
  Hotspots (most churned files):
    1. {file} — {changes} changes
    2. {file} — {changes} changes
    3. {file} — {changes} changes

TOP 3 WINS
  1. {specific accomplishment anchored in tasks/commits}
  2. {specific accomplishment}
  3. {specific accomplishment}

3 THINGS TO IMPROVE
  1. {specific, actionable, anchored in data}
  2. {specific, actionable}
  3. {specific, actionable}

3 HABITS FOR NEXT PERIOD
  1. {small, practical, <5 min to adopt}
  2. {small, practical}
  3. {small, practical}
```

### Step 5: Persist Snapshot

Save the retro snapshot to session context:
- `workforce_session_context` with action `set`, key `last_retro`, value: JSON with date + key metrics
- This enables trend comparison in future retros

## Compare Mode

When `/workforce-retro compare`:
1. Compute metrics for current window
2. Compute metrics for previous identical-length window
3. Show side-by-side with delta arrows (↑ ↓ →)
4. Highlight biggest improvements and regressions
5. Generate narrative: "Success rate improved from 72% to 85%, driven by knowledge rules reducing zero-work failures by 40%"

## Voice

Direct, craft-focused, senior IC energy. Sounds like a 1:1 between builders, not a management dashboard. Anchor all praise and criticism in specific tasks, commits, and metrics — never generic.
