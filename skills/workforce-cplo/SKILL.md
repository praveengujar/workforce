---
name: workforce-cplo
description: "Chief Planning Officer — comprehensive end-to-end implementation plans across all stack layers (infra, database, API, middleware, services, frontend, mobile, real-time, integrations). Auto-detects project stack. Default: plan."
---

When the user invokes /workforce-cplo, create a comprehensive implementation plan that spans the full technology stack. This officer plans the WHAT and WHERE before any code is written. Other officers (COO, CTO, CQO) handle execution, review, and quality.

## Default Action: plan

If no action specified, create a full-stack plan for the given feature/change.

## Actions

### plan (default)
Create a comprehensive multi-layer implementation plan. `/workforce-cplo "add real-time notifications"`

### scan
Scan the project and report detected stack layers without creating a plan. `/workforce-cplo scan`

### impact
Analyze the impact radius of a proposed change across all layers. `/workforce-cplo impact "change user schema to add roles"`

---

## How Planning Works

### Step 1: Stack Discovery (automatic, every plan)

Scan the project root to auto-detect all technology layers. Check for:

| Layer | Detection Signals |
|-------|------------------|
| **Infrastructure** | `Dockerfile`, `docker-compose*.yml`, `terraform/`, `.github/workflows/`, `cloudbuild.yaml`, `Procfile`, `fly.toml`, `render.yaml`, `vercel.json`, `netlify.toml` |
| **Database** | `prisma/schema.prisma`, `drizzle.config.*`, `knex*`, `migrations/`, `*.sql`, `supabase/`, `mongo*` in deps |
| **Cache/Queue** | `redis` in deps, `bull` in deps, `rabbitmq` configs, `celery` configs |
| **API** | `app/api/` (Next.js), `routes/` (Express), `src/controllers/`, `api/` with route files, `openapi.*`, `swagger.*` |
| **Middleware** | `middleware.ts`, `src/middleware/`, auth configs, rate limit configs |
| **Services/Business Logic** | `lib/services/`, `src/services/`, `domain/`, `use-cases/` |
| **Shared Packages** | `packages/` with `package.json`, workspace config in root `package.json` |
| **Frontend (Web)** | `app/` or `pages/` with `.tsx`/`.jsx`, `components/`, React/Vue/Svelte/Angular in deps |
| **Frontend (Mobile)** | `expo` in deps, `react-native` in deps, `ios/`, `android/`, `app.json` with expo config |
| **Real-time** | `socket.io` in deps, WebSocket configs, `pusher`/`ably` in deps, SSE endpoints |
| **External Integrations** | API keys in `.env.example`, SDK imports (stripe, openai, twilio, etc.) |
| **Testing** | `jest.config.*`, `vitest.config.*`, `playwright.config.*`, `cypress/`, `__tests__/`, `*.test.*`, `*.spec.*` |
| **Documentation** | `docs/`, `ARCHITECTURE.md`, `CLAUDE.md`, `README.md` |

For each detected layer, note:
- Framework/tool (e.g., "Next.js 14", "Prisma + MongoDB", "Docker + Cloud Run")
- Key config files
- Approximate scale (file count, model count, route count)

Present stack discovery as:
```
━━━ STACK SCAN ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Detected {n} layers:

  ✓ Infrastructure    Docker, GCP Cloud Run, GitHub Actions
  ✓ Database          Prisma + MongoDB (87 models)
  ✓ Cache             Redis (session + pub/sub)
  ✓ API               Next.js App Router (161 routes)
  ✓ Middleware         Auth (NextAuth), rate limiting, RBAC
  ✓ Services          84 service files, 18 AI agents
  ✓ Packages          10 shared packages (monorepo)
  ✓ Web Frontend      React 19, Tailwind, Recharts
  ✓ Mobile            React Native + Expo
  ✓ Real-time         Socket.io + Redis adapter
  ✓ Integrations      OpenAI, Stripe, Firecrawl, Resend
  ✓ Testing           Jest, Playwright, Vitest
  — Documentation     No ARCHITECTURE.md found
```

### Step 2: Change Analysis

For the requested feature/change, determine which layers are affected:

1. **Parse the request** — what is the user trying to build/change?
2. **Map to layers** — which stack layers must change?
3. **Identify cross-cutting concerns** — what spans multiple layers? (auth, logging, error handling, types)
4. **Check existing code** — use `workforce_dependency_graph` and file search to find related existing code
5. **Check knowledge rules** — use `workforce_get_rules_for_path` for applicable constraints

For each affected layer, determine:
- **What changes** — new files, modified files, deleted files
- **Why** — the reason this layer is affected
- **Risk** — what could go wrong (data loss, breaking changes, downtime)
- **Dependencies** — what must happen in other layers first

### Step 3: Dependency Ordering

Determine the safe implementation order. The general principle:

```
Schema/Types first → Database migration → Backend services → API routes →
Middleware → Shared packages → Frontend → Mobile → Real-time →
Infrastructure → Tests → Documentation
```

But adjust based on the specific change:
- **New feature**: Schema → API → Frontend (top-down)
- **Refactor**: Tests first → Implementation → Verify (safety net first)
- **Bug fix**: Reproduce (test) → Fix → Regression test
- **Migration**: Backward-compatible schema → Dual-write → Migrate readers → Remove old
- **Breaking API change**: Version endpoint → Update clients → Remove old version

Group into parallel phases where possible:
- Phase 1: Independent changes (schema + types can parallel with test setup)
- Phase 2: Changes that depend on Phase 1 (API routes need schema, frontend needs API)
- Phase 3: Integration work (real-time hooks, mobile sync, docs)

### Step 4: Generate the Plan

## Plan Template

```
━━━ CPLO IMPLEMENTATION PLAN ━━━━━━━━━━━━━━━━━━━━━━━━━
Feature: "{description}"
Affected layers: {count}/{total_detected}
Phases: {phase_count}   Tasks: {task_count}   Est: ~${total_cost}
Risk: {LOW|MEDIUM|HIGH}   Breaking changes: {yes|no}

STACK IMPACT MAP
  {✓|—} Infrastructure    {what changes or "no change"}
  {✓|—} Database          {what changes}
  {✓|—} Cache             {what changes}
  {✓|—} API               {what changes}
  {✓|—} Middleware         {what changes}
  {✓|—} Services          {what changes}
  {✓|—} Packages          {what changes}
  {✓|—} Web Frontend      {what changes}
  {✓|—} Mobile            {what changes}
  {✓|—} Real-time         {what changes}
  {✓|—} Integrations      {what changes}
  {✓|—} Testing           {what changes}
  {✓|—} Documentation     {what changes}

CROSS-CUTTING CONCERNS
  {concern}: {affected layers} — {how to handle}
  {concern}: {affected layers} — {how to handle}

━━━ PHASE 1: {phase_name} ━━━━━━━━━━━━━━━━━━━━━━━━━━━
Layer: {layer_name}
Rationale: {why this goes first}
Risk: {risk_level}

  Task 1.1: {specific task description}
    Files: {file_list}
    Depends on: nothing (root task)
    Acceptance: {how to verify this is done correctly}
    Type: {standard|analysis}
    Tier: {○●◉}

  Task 1.2: {specific task description}
    Files: {file_list}
    Depends on: nothing (parallel with 1.1)
    Acceptance: {verification}
    Type: {standard|analysis}
    Tier: {○●◉}

━━━ PHASE 2: {phase_name} ━━━━━━━━━━━━━━━━━━━━━━━━━━━
Layer: {layer_name}
Rationale: {why this depends on Phase 1}
Risk: {risk_level}

  Task 2.1: {specific task description}
    Files: {file_list}
    Depends on: Task 1.1
    Acceptance: {verification}
    Type: {standard}
    Tier: {○●◉}

━━━ PHASE N: Testing & Verification ━━━━━━━━━━━━━━━━━
  Task N.1: Write unit tests for {changed services}
  Task N.2: Write E2E tests for {changed UI flows}
  Task N.3: Update documentation

━━━ ROLLBACK PLAN ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  If Phase {n} fails: {what to revert and how}
  Database rollback: {migration down strategy}
  Feature flag: {if applicable, how to disable without deploy}

━━━ EXECUTION ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Total tasks: {n}   Parallel: {n}   Sequential: {n}
  Est. duration: {n} phases × ~{m} min avg = ~{total} min
  Est. cost: ~${total}

➤ Execute as /workforce-coo chain, /workforce-coo sprint, or edit plan?
```

### Step 5: Execution Handoff

When the user approves:
- **Sequential plan** → hand off to `/workforce-coo chain` with the task list
- **Parallel phases** → hand off to `/workforce-coo sprint` with phased groups
- **Complex plan** → hand off to `/workforce-ceo` for gated orchestration
- **Single layer** → hand off to `/workforce-coo launch` directly

Each task in the plan includes enough context for an autonomous agent:
- Specific file paths
- Function/component names
- Acceptance criteria
- Dependencies on prior tasks
- Constraints from knowledge rules

---

## Impact Analysis (impact action)

When invoked as `/workforce-cplo impact "change description"`:

1. Run stack discovery
2. For the described change, trace impact across all layers:
   - **Direct**: files that must change
   - **Indirect**: files that import/depend on changed files (use `workforce_dependency_graph`)
   - **Transient**: files that depend on indirect files (2nd-degree impact)
3. Present impact map:

```
━━━ IMPACT ANALYSIS ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Change: "{description}"

DIRECT IMPACT ({n} files)
  {layer}: {file} — {what changes}
  {layer}: {file} — {what changes}

INDIRECT IMPACT ({n} files)
  {layer}: {file} — imports {direct_file}, may need updates
  {layer}: {file} — uses {changed_type/function}

TRANSIENT IMPACT ({n} files)
  {layer}: {file} — 2nd-degree dependency

RISK ASSESSMENT
  Breaking changes: {list}
  Data migration needed: {yes|no}
  Downtime required: {yes|no}
  Feature flag recommended: {yes|no}

➤ Create implementation plan from this analysis?
```

---

## Planning Principles

1. **Schema drives everything** — database changes propagate to every layer. Plan them first and get them right.
2. **Types are the contract** — shared type definitions are the API between layers. Change types early, catch breakage early.
3. **Backward compatibility by default** — new columns are nullable, new endpoints don't replace old ones, new UI is behind feature flags.
4. **Test the boundaries** — every layer boundary (API ↔ Service, Service ↔ DB, Frontend ↔ API) needs a test.
5. **One-way doors need rollback plans** — database migrations, API removals, and infrastructure changes need explicit rollback strategies.
6. **Parallel when independent** — if frontend and mobile don't share state for this change, they can be built in parallel.
7. **Smallest deployable unit** — each phase should be independently deployable without breaking the system.

## Complexity Heuristics

| Signal | Complexity | Recommendation |
|--------|-----------|----------------|
| Touches 1 layer | Low | Single task via `/workforce-coo launch` |
| Touches 2-3 layers | Medium | Chain via `/workforce-coo chain` |
| Touches 4+ layers | High | Full plan with phases |
| New database model | +1 complexity | Schema migration phase first |
| Breaking API change | +2 complexity | Versioning + dual-write phase |
| Auth/payment changes | +2 complexity | Extra review + security audit |
| Real-time events | +1 complexity | Socket event registration phase |
| Mobile + web | +1 complexity | Shared package update phase |

## Related

- `/workforce-ceo` — Executes the plan with full quality gates
- `/workforce-coo chain` — Runs sequential task chains from the plan
- `/workforce-coo sprint` — Runs parallel phases from the plan
- `/workforce-cto rubberduck` — Refines individual task prompts within the plan
- `/workforce-cio rules` — Constraints that feed into planning decisions
