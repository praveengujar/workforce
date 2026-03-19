---
name: workforce-health
description: Show health metrics, cost tracking, and operational insights for the workforce. Use when user asks about agent performance or costs.
---

When the user invokes /workforce-health, display a visual health report.

## Steps

1. Call `workforce_health_metrics` for performance data
2. Call `workforce_cost_summary` for cost data
3. Call `workforce_list_tasks` to get recent failed tasks for analysis
4. Call `workforce_get_budget` (scope: "global") for budget status and sparkline trends
5. If no budget is configured, omit the BUDGET section

## Formatting Rules

- **Progress bars**: 10 chars wide. `▰` filled, `▱` empty. Count = round(percentage / 10).
- **Pass/warn/fail**: Compare actual to targets (from metrics-targets.json defaults: doneRate 85%, failRate <10%, oneShotRate 70%, retryRate <15%). Use `✓ pass`, `⚠ warn`, `✗ fail`.
- **Uptime**: Convert seconds to `Xd Xh Xm` format.
- **Elapsed time on failed tasks**: From `createdAt` to `completedAt`, as `Xm Ys`.

## Template

```
━━━ WORKFORCE HEALTH ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

PERFORMANCE
Success rate   {pct}%  {bar_10}  target 85%   {status}
Failure rate    {pct}%  {bar_10}  target <10%  {status}
One-shot rate  {pct}%  {bar_10}  target 70%   {status}
Retry rate     {pct}%  {bar_10}  target <15%  {status}

COST
┌──────────┬──────────┬───────────┐
│  Today   │   Week   │   Month   │
│  ${today}  │  ${week}  │  ${month}  │
└──────────┴──────────┴───────────┘
By tier: Simple ${s} │ Medium ${m} │ Complex ${c}

ACTIVITY
Total tasks: {total}   │   Last 24h: {recent}   │   Uptime: {uptime}

─── TRENDS ────────────────────────────────────────────
Cost (14d): ▂▃▂▅▇▃▂▁▃▄▂▅▃▂  avg $2.14/day  total $29.96
Tasks (14d): ▃▅▇▃▂▅▇▃▂▁▃▅▃▂  avg 4.2/day

─── BUDGET ────────────────────────────────────────────
Daily:   ${d_spent} / ${d_limit}  (${d_pct}% remaining)  {bar_10}
Weekly:  ${w_spent} / ${w_limit}  (${w_pct}% remaining)  {bar_10}
Monthly: ${m_spent} / ${m_limit}  (${m_pct}% remaining)  {bar_10}
```

If there are improvement suggestions from the API, add after PERFORMANCE:

```
  ⚠ {suggestion_text}
```

After the template, add a **DIAGNOSIS** section (2-4 sentences) with your own analysis:
- What's driving failures? (Look at recent failed tasks' error messages)
- Are costs trending up?
- Specific recommendations to improve one-shot rate
