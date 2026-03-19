---
name: workforce-experiment
description: Run iterative experiments — the agent modifies code, measures a metric, keeps improvements, reverts failures. Repeat until target is hit or budget exhausted. Use when user wants to optimize code through experimentation.
---

When the user invokes /workforce-experiment, guide them through setting up and launching an iterative experiment.

## What this does

Instead of a one-shot task, an experiment runs a loop:
1. Modify code (Claude agent makes a focused change)
2. Run a measurement command (e.g., `npm test`, `python train.py`)
3. Extract a metric from the output (e.g., val_bpb, test_pass_rate)
4. If metric improved: keep the changes. If not: revert.
5. Repeat until target is hit, max iterations reached, or budget exhausted.

## Setup Steps

1. **Research objective** — What should the agent optimize? Ask for the prompt if not provided.
   - Good: "Reduce inference latency of the transformer model by optimizing attention computation"
   - Bad: "Make it faster"

2. **Measurement command** — What shell command measures the result?
   - Examples: `npm test`, `python train.py --epochs 1`, `cargo bench`, `pytest --tb=short`

3. **Metric extraction** — A regex with a capture group to extract the numeric metric from command output.
   - Examples: `val_bpb: ([0-9.]+)`, `(\d+) passing`, `time:\s+([0-9.]+)ms`

4. **Metric name** — Human-readable name (e.g., "val_bpb", "test_pass_rate", "latency_ms")

5. **Direction** — Is lower better (`minimize`) or higher better (`maximize`)?

6. **Target value** (optional) — Stop early when this value is reached.

7. **Max iterations** — Default 20. How many tries before stopping.

8. **Budget limit** (optional) — Max total cost across all iterations.

Then call `workforce_create_experiment` with all parameters.

## Defaults

- max_iterations: 20
- iteration_timeout_ms: 300000 (5 minutes)
- budget_limit: null (unlimited)
- target_value: null (run all iterations)

## Monitoring

After launch, use `workforce_experiment_status` with the experiment ID to check progress. The status display shows:
- Current best metric value
- Iteration history with kept/reverted status
- Trend sparkline
- Total cost

Use `workforce_stop_experiment` to gracefully stop after the current iteration.
Use `workforce_list_experiments` to see all experiments.

## Template — Experiment Launched

```
  ┌─ EXPERIMENT LAUNCHED ──────────────────────────────┐
  │ ID:        {id_8}                                  │
  │ Objective: {prompt}                                │
  │ Metric:    {metric_name} ({direction})             │
  │ Measure:   {measure_command}                       │
  │ Pattern:   {metric_pattern}                        │
  │ Target:    {target_value || 'none'}                │
  │ Iterations: {max_iterations}                       │
  │ Budget:    {budget_limit || 'unlimited'}           │
  └────────────────────────────────────────────────────┘
  ● Experiment started — iteration 1/{max_iterations} running
```

## Template — Status Check

```
━━━ EXPERIMENT: {id_8} ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Objective: {prompt}
Metric: {metric_name} ({direction})  Best: {best_value}  Target: {target_value}
Progress: {iteration}/{max_iterations}  Cost: ${total_cost}

ITERATIONS
┌─────┬────────────┬──────────┬────────┬──────────────────────────────┐
│  #  │   Metric   │  Status  │  Cost  │ Description                  │
├─────┼────────────┼──────────┼────────┼──────────────────────────────┤
│  1  │  0.4521    │ ✓ kept   │ $0.23  │ Increased LR to 3e-4        │
│  2  │  0.4498    │ ✓ kept   │ $0.31  │ Added cosine annealing      │
│  3  │  0.4612    │ ✗ revert │ $0.18  │ Tried batch size 64         │
└─────┴────────────┴──────────┴────────┴──────────────────────────────┘

Trend: ▇▆▅▅▄▃  (improving)
```

## Formatting Rules

- Use the templates above for consistent output.
- Do not ask unnecessary questions — use sensible defaults.
- If the user provides all info in the invocation, skip the interactive setup and launch directly.
- For metric_pattern, help the user construct the regex if they describe the output format.
