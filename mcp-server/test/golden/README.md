# Golden Replay Set — Workforce Context Fabric M0

This directory holds the frozen task fixtures that gate every Context
Management Fabric milestone. The harness scores each fixture and reports
deltas against `baseline.json`. Without it, "did milestone N help?" cannot
be answered.

The harness lives in `mcp-server/core/replay-runner.js` and is exposed via
the MCP tool `workforce_replay_golden_set` (`mcp-server/tools/replay-tools.js`).

## Strategy: synthetic deterministic fixtures (M0)

The PRD (§17 M0) calls for 30 frozen tasks from real Workforce history,
pinned to commit SHAs. The M0 implementation deliberately ships
**synthetic deterministic fixtures** instead. The trade-offs:

| Concern | Real fixtures | Synthetic fixtures (chosen) |
|---|---|---|
| Reproducibility on a clean checkout | Requires the workforce DB to exist | Self-contained — runs anywhere |
| Coverage of real failure modes | High | Curated — covers the modes that matter |
| Useful before the assembler exists (M4) | Limited — nothing to re-execute | Sufficient — exercises the scoring pipeline |
| Future migration cost | n/a | Drop-in: real fixtures share the same JSON shape |

M0's deliverable is the harness scaffolding, not historical regression
coverage. Real-task fixtures only become *meaningful* once the assembler
(M4) can re-execute them. Until then, recorded outcomes from past tasks
score identically every run — same as a synthetic fixture, but with the
extra dependency on a populated SQLite database. We picked synthetic.

When M4 lands, the plan is to add real-task fixtures alongside the
synthetic ones — the fixture loader treats them identically. The PRD
continues to target the 30-task milestone, just deferred from M0 to M4.

## Fixture format

Each fixture is a single JSON file in this directory (any name except
`baseline.json` and `README.md`). Required fields:

```jsonc
{
  "id":            "01-add-jsdoc-to-utility",       // unique fixture id
  "taskType":      "standard",                       // standard | analysis | experiment | measurement
  "prompt":        "Add a JSDoc block to ...",       // task prompt as it would be sent to the agent
  "plannedFiles":  ["mcp-server/tools/formatters.js"],// files the task is expected to touch (may be [])
  "pinnedSha":     null,                             // commit SHA if recorded from real history; else null
  "fixtureKind":   "synthetic",                      // "synthetic" | "real"
  "description":   "Low-risk doc-only change ...",   // why this fixture exists / what it exercises

  "expected": {
    "mergeEligible":         true,                   // boolean — would this outcome be merge-eligible?
    "reviewScore":           92.0,                   // 0-100 — review weighted score
    "tokensUsed":            4200,                   // non-negative integer — Claude tokens consumed
    "ralphWiggumIncidents":  0                       // non-negative integer — loop incidents detected
  }
}
```

Schema is enforced by `replay-runner.js#loadFixture`. Missing or wrong-typed
fields throw immediately — there are no silent skips, because a silently
skipped fixture is the worst possible failure mode for an eval harness.

## Adding a new fixture — worked example

Suppose you want a fixture that captures "agent must respect a knowledge
rule at security/* paths."

1. Create `mcp-server/test/golden/07-respect-security-rule.json`:

   ```json
   {
     "id": "07-respect-security-rule",
     "taskType": "standard",
     "prompt": "Add input validation to the auth callback handler in mcp-server/core/auth-callback.js. Treat all query params as untrusted.",
     "plannedFiles": ["mcp-server/core/auth-callback.js"],
     "pinnedSha": null,
     "fixtureKind": "synthetic",
     "description": "Security-path edit. Should trigger the security/* knowledge rule and produce a high review score with no Ralph loops.",
     "expected": {
       "mergeEligible": true,
       "reviewScore": 86.0,
       "tokensUsed": 12500,
       "ralphWiggumIncidents": 0
     }
   }
   ```

2. Re-baseline:

   ```sh
   node -e "
   import('./mcp-server/core/replay-runner.js').then(({ runGoldenSet }) => {
     const path = require('node:path');
     const fs   = require('node:fs');
     const dir  = path.resolve('./mcp-server/test/golden');
     const out  = runGoldenSet({ goldenDir: dir });
     fs.writeFileSync(path.join(dir, 'baseline.json'), JSON.stringify(out, null, 2) + '\n');
   });"
   ```

   Or call `workforce_replay_golden_set` with `format=json` and copy the
   scorecard into `baseline.json`.

3. Run the test:

   ```sh
   node --test mcp-server/test/replay-runner.test.js
   ```

4. Commit both the fixture and the updated `baseline.json`. The PR
   description must explain why the new fixture is needed and why its
   `expected` numbers are calibrated where they are — uncalibrated
   fixtures pollute the baseline and make every later run look like a
   regression.

## Running the harness

```sh
# CLI
node --test mcp-server/test/replay-runner.test.js

# Programmatic
node -e "import('./mcp-server/core/replay-runner.js').then(({runGoldenSet}) => console.log(runGoldenSet({goldenDir: require('node:path').resolve('mcp-server/test/golden')})))"

# MCP tool (from a Claude Code session with the workforce plugin loaded)
workforce_replay_golden_set
workforce_replay_golden_set { "format": "json" }
workforce_replay_golden_set { "baseline_json": "baseline.json" }
```

Every run writes a row to the `replay_runs` table (`mcp-server/core/db.js`
migration 14). Use `sqlite3` against the workforce data directory to
inspect history.

## Reproducibility contract

The harness must produce identical scores for identical inputs. Tolerance
for drift: ±2% on aggregates (avg review score, avg tokens). If a run
produces a wider drift without a fixture change, that's a bug in the
harness, not the fixtures.
