# Workforce Comprehensive Audit and Orchestrator Plan
**Date**: 2026-03-28
**Scope**: Full plugin audit with focus on orchestration completeness, duplicate capability simplification, reusable-library standards, and developer-velocity improvements.

## Executive Summary

Workforce has strong foundations: task orchestration, dependency-aware scheduling, context memory, rules, eval loop, QA/review skills, and merge controls. The largest gaps are not core runtime reliability, but **orchestration consistency**, **gate rigor**, and **capability overlap across skills**.

Primary findings:
1. The strict end-to-end orchestrator flow (rubberduck -> test plan -> code loop -> QA -> review -> explicit human approve/reject -> merge) exists conceptually but is not enforced as a single mandatory state machine.
2. Skill-level overlap causes decision friction (`decompose`, `chain`, `sprint`, `pipeline`, and now `autoplan` intent).
3. Reusable-library guidance is not codified as first-class rules, so duplication prevention is advisory rather than systematic.
4. Session-end eval creation is useful but low-fidelity (diagnostic-heavy, preventive-light), reducing feedback loop compounding.
5. Documentation and capability index drift creates operational confusion (skill counts and listed commands are stale in places).

---

## Coverage Snapshot

### What is implemented well
- Dependency-aware scheduler with phase/dependency support and cascade handling.
- Context memory stack (knowledge rules, session context, upstream results, feedback tail).
- Recovery engine with auto-repair heuristics and eval emission.
- Review lifecycle with approve/reject and merge serialization.
- Rich skill surface for launch, QA, test planning, rescue, release, and retros.

### What is partially implemented
- Full quality-gated pipeline exists as a skill but stages are skippable and not modeled as hard gate transitions.
- Eval processing can create rules, but most automatically generated evals lack preventive payload quality.
- Rule system exists, but no baseline "engineering operating system" rule pack is seeded by default.

### What is missing
- A strict orchestrator mode with immutable gate order and evidence requirements.
- A single canonical planning command that resolves overlap between decomposition/chain/sprint/pipeline.
- Built-in duplicate-capability scanner for rules/skills/prompts.
- Standardized reusable-library policy encoded into knowledge rules and onboarding docs.

---

## Orchestrator Gap Matrix

| Stage | Current state | Gap | Risk |
|---|---|---|---|
| Intake + pre-scan | Present in `workforce-pipeline` | Optional execution path | Wrong flow chosen for high-risk tasks |
| Rubberduck | Present (`workforce-rubberduck`) | Not always mandatory for medium/high complexity | Ambiguous requirements leak into implementation |
| Test plan | Present (`workforce-test-plan`) | Not tied to launch gating | QA/test quality variance |
| Code loop | Present (task create/retry/rescue) | No explicit bounded loop contract (max retries + exit criteria by gate) | Churn and unclear failure handling |
| QA | Present (`workforce-qa`) | Not always attached to acceptance criteria artifacts | False confidence or redundant checks |
| Review | Present (`workforce-review`) | No formal evidence schema required before decision | Reviewer inconsistency |
| Human approval/reject | Present (approve/reject tools) | Not enforced in every path (e.g., auto-merge modes) | Governance drift |
| Merge | Present (`workforce_approve_task`, merge lock) | No release/canary gate integration | Merge-safe but not deploy-safe |

---

## Duplicate / Overlap Audit

High-value simplification opportunities:
1. Planning overlap: `workforce-decompose`, `workforce-chain`, `workforce-sprint`, and `workforce-pipeline` each build execution plans differently.
2. Quality overlap: `workforce-test-plan` and `workforce-qa` both define test intent, often duplicating specification.
3. Review overlap: `workforce-review`, `workforce-gate-status`, and `workforce-merge` can be used in inconsistent order.
4. Security overlap: `workforce-cso` and generic review may re-run similar checks without shared evidence artifacts.

Recommended simplification model:
- `autoplan` as canonical planner/orchestrator.
- `decompose` and `chain` remain focused helpers invoked by `autoplan` when needed.
- `sprint` remains backlog-batch orchestration only.
- `pipeline` becomes lightweight alias or compatibility shim over `autoplan`.

---

## Reusable Library Rule Gap

There was no explicit reusable-library-first standard enforcing:
- extraction thresholds,
- API contract requirements,
- test requirements for shared modules,
- deprecation path before duplicate functionality removal.

This causes inconsistent reuse behavior and duplicate implementations over time.

---

## New Productivity Features to Add

### P0 (Immediate)
1. Strict gate orchestrator mode (`autoplan`) with mandatory checkpoints and explicit human decision points.
2. Seeded reusable-library rule pack (knowledge rules).
3. Gate evidence schema (plan, acceptance criteria, test plan, QA result, review verdict, approval reason).

### P1 (Near-term)
1. Rule overlap/duplication linter (detect near-duplicate rules and conflicting path scopes).
2. Post-merge verification stage (smoke/canary) and rollback playbook hooks.
3. Release-doc freshness check before release tagging.

### P2 (Later)
1. Skill graph + router that auto-selects which helper skill to invoke and records why.
2. Failure-cluster auto-proposals with preventive rule drafts and confidence ranking.
3. Policy packs by project type (API, full-stack, data, infra).

---

## Implementation Roadmap (Phased)

### Phase 1 (1-3 days)
- Add `workforce-autoplan` strict orchestrator skill.
- Add reusable-library baseline rule seeding script.
- Update docs to expose new command and adoption path.

**Acceptance criteria**
- One command can run the complete gated flow with explicit human approval before merge.
- Teams can seed reusable-library rules in one step.

### Phase 2 (3-7 days)
- Add gate evidence templates and required artifacts per stage.
- Add a lightweight rule overlap audit command/script.
- Unify planning UX wording across `decompose`, `chain`, `sprint`, `pipeline`.

**Acceptance criteria**
- Every merged task has deterministic gate evidence.
- Duplicate rule guidance is automatically flagged.

### Phase 3 (1-2 weeks)
- Add post-merge verification hooks and release documentation checks.
- Add policy profiles (strict, balanced, fast) to tune gate strictness by risk.

**Acceptance criteria**
- High-risk changes cannot bypass QA + human review + post-merge verification.
- Teams can choose operating mode without rewriting skills.

---

## Risks and Mitigations

1. Risk: Over-constraining simple tasks.
   - Mitigation: mode profiles (`fast`, `balanced`, `strict`) with defaults from prompt complexity.
2. Risk: Skill sprawl remains despite new orchestrator.
   - Mitigation: mark helper skills as subordinate and route via `autoplan` by default.
3. Risk: Rule overload in prompt injection.
   - Mitigation: priority capping, deduplication, and path narrowing.
4. Risk: Human approval bottleneck.
   - Mitigation: summarize gate evidence in concise cards to reduce review time.

---

## Immediate Action Items

1. Adopt `workforce-autoplan` as default orchestration entrypoint for medium/high complexity tasks.
2. Seed reusable-library rules once per environment.
3. Consolidate docs so command discoverability matches shipped skill set.
4. Schedule a follow-up pass to merge/retire overlapping skill responsibilities after two weeks of telemetry.
