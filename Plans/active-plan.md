# Plan: Inter-Agent Context Sharing & Dependency Management
**Created**: 2026-03-19
**Status**: Draft

## Goal
Enable independent agents to share context, results, and memory for dependent complex tasks — so that decomposed subtasks execute in the right order, pass results downstream, and build on each other's work instead of operating in isolation.

## Audit Findings (current gaps)

| Gap | Impact |
|-----|--------|
| No task dependencies in DB | Decomposed subtasks run in arbitrary order, ignoring phases |
| No result passing | Task B can't see what task A produced or discovered |
| Agents only see running task prompts | No visibility into completed task outcomes, errors, or learnings |
| Project memory is unstructured plaintext | No way to query specific findings or pass structured data |
| Phase ordering is advisory only | No enforcement — all subtasks compete for slots equally |
| No inter-task messaging | Agents can't signal completion, share artifacts, or coordinate |

## Design: Three-layer context sharing system

### Layer 1: Task Dependency Graph (DB + Scheduler)
Hard enforcement. Task B waits for task A before launching.

### Layer 2: Shared Context Store (Structured key-value)
Rich data passing. Task A writes `{"api_endpoint": "/users", "schema": {...}}`, task B reads it.

### Layer 3: Agent Memory Feed (Prompt injection)
Automatic context enrichment. Each agent's prompt includes relevant results from upstream tasks.

## Affected files

| File | Action | Description |
|------|--------|-------------|
| `mcp-server/core/db.js` | Modify | Migration 5: add dependency columns to tasks, create `shared_context` table |
| `mcp-server/core/worker-manager.js` | Modify | Dependency-aware `promotePending()` — only launch tasks whose deps are satisfied |
| `mcp-server/core/context-store.js` | Create | Shared context store: write/read/query structured data keyed by task or group |
| `mcp-server/core/dependency-resolver.js` | Create | Resolve dependency graph, detect cycles, compute execution phases |
| `mcp-server/tools/task-tools.js` | Modify | Add `parentId`, `dependsOn`, `group` params to `createTaskHandler` |
| `mcp-server/tools/context-tools.js` | Create | MCP tools for reading/writing shared context |
| `mcp-server/tools/formatters.js` | Modify | Add dependency visualization to dashboard |
| `mcp-server/index.js` | Modify | Register new tools, wire context store |
| `skills/workforce/SKILL.md` | Modify | Show dependency status in dashboard |
| `skills/workforce-launch/SKILL.md` | Modify | Support `depends_on` in launch flow |
| `skills/workforce-decompose/SKILL.md` | Modify | Create tasks with dependency chains, not independent |
| `agents/task-planner.md` | Modify | Instruct to output dependency graph with decomposition |

## Implementation steps

### Step 1: Database schema (migration 5)

Add to tasks table:
```sql
ALTER TABLE tasks ADD COLUMN parentId TEXT;       -- parent task (for subtask chains)
ALTER TABLE tasks ADD COLUMN dependsOn TEXT;       -- JSON array of task IDs that must complete first
ALTER TABLE tasks ADD COLUMN taskGroup TEXT;       -- group ID linking related tasks
ALTER TABLE tasks ADD COLUMN phase INTEGER;        -- execution phase (1, 2, 3...)
ALTER TABLE tasks ADD COLUMN resultSummary TEXT;   -- brief outcome written by agent or extracted post-run
```

New shared context table:
```sql
CREATE TABLE IF NOT EXISTS shared_context (
  id         TEXT PRIMARY KEY,
  taskGroup  TEXT NOT NULL,             -- group these entries belong to
  taskId     TEXT,                      -- which task wrote this (null = manual)
  key        TEXT NOT NULL,             -- lookup key (e.g., "api_schema", "test_results")
  value      TEXT NOT NULL,             -- JSON value
  createdAt  TEXT NOT NULL,
  UNIQUE(taskGroup, key)                -- one value per key per group
);
CREATE INDEX IF NOT EXISTS idx_shared_context_group ON shared_context(taskGroup);
```

Update TASK_COLUMNS set to include new columns.

### Step 2: Dependency resolver (`dependency-resolver.js`)

Pure functions:
- `resolveDependencies(taskId)` — returns { satisfied: bool, pending: [taskIds], failed: [taskIds] }
- `getExecutionPhases(tasks)` — given tasks with dependsOn, compute parallel phases
- `detectCycles(tasks)` — return cycle path or null
- `getBlockedTasks()` — all tasks whose deps aren't met
- `getReadyTasks()` — pending tasks whose deps are all done/archived
- `buildDependencyTree(taskGroup)` — returns tree structure for visualization

### Step 3: Dependency-aware scheduling (worker-manager.js)

Modify `promotePending()`:
```
1. Get pending tasks
2. For each pending task:
   a. If task.dependsOn is set, parse JSON array
   b. For each dep ID, check if that task's status is 'done' or 'archived'
   c. If ANY dep is 'failed', mark this task as 'failed' (cascade failure)
   d. If ALL deps are satisfied, task is eligible for launch
   e. If some deps still running/pending, skip (wait)
3. From eligible tasks, sort by phase ASC (lower phase = higher priority)
4. Claim and spawn as before
```

### Step 4: Context store (`context-store.js`)

Functions:
- `writeContext(taskGroup, taskId, key, value)` — upsert structured data
- `readContext(taskGroup, key)` — get value by key
- `readAllContext(taskGroup)` — get all entries for a group
- `deleteContext(taskGroup, key)` — remove entry
- `extractAndStoreResult(task)` — auto-extract result summary from task output on completion

### Step 5: Prompt enrichment with upstream context

Modify `spawnWorker()` to add two new context layers:

**Layer: Upstream results**
```
[Upstream Task Results]
Task a1b2c3d4 (done): "Added JWT auth middleware to /api/auth"
  Result: Authentication endpoints created at /api/auth/login and /api/auth/register

Task e5f6g7h8 (done): "Created user model with Prisma schema"
  Result: User model at prisma/schema.prisma with email, passwordHash, createdAt fields
```

**Layer: Shared context**
```
[Shared Context]
api_schema: {"login": {"method": "POST", "path": "/api/auth/login", "body": {...}}}
user_model_fields: ["email", "passwordHash", "createdAt", "updatedAt"]
test_command: "npm test -- --grep auth"
```

This gives downstream agents structured knowledge about what upstream tasks produced.

### Step 6: Auto-extract result summaries

In `handleWorkerExit` and `handleTmuxWorkerExit`, after task completes successfully:
1. Take the last 500 chars of output
2. Look for patterns like "Result:", "Summary:", "Done:", "Created:", "Modified:"
3. Store as `resultSummary` on the task
4. If task has a `taskGroup`, also write key findings to shared_context

### Step 7: MCP tools (`context-tools.js`)

New tools:
- `workforce_write_context` — { group, key, value } — write to shared store
- `workforce_read_context` — { group, key? } — read one or all entries
- `workforce_task_dependencies` — { task_id } — show dependency tree for a task
- `workforce_group_status` — { group } — show all tasks in a group with dep status

### Step 8: Update `createTaskHandler`

Add params: `parent_id`, `depends_on` (array of task IDs), `group`, `phase`.
Validate that referenced task IDs exist. Detect cycles before creating.

### Step 9: Update decompose skill

Change `/workforce-decompose` to create tasks WITH dependency chains:
```
Phase 1 (parallel): #1, #2     → depends_on: []
Phase 2 (sequential): #3       → depends_on: [#1]
Phase 3 (parallel): #4         → depends_on: [#2, #3]
```

Each `workforce_create_task` call includes the `depends_on` and `phase` params. All subtasks share a `taskGroup`.

### Step 10: Dashboard visualization

Update `/workforce` dashboard to show dependency status:
```
TASK GROUP: auth-implementation (4 tasks)
Phase 1: ✓ a1b2  ✓ e5f6          [2/2 complete]
Phase 2: ● m3n4  ← a1b2          [running]
Phase 3: ○ q7r8  ← m3n4, e5f6    [waiting]
```

## Risks & mitigations

- **Risk**: Circular dependencies → **Mitigation**: `detectCycles()` validation on task creation, reject if cycle found
- **Risk**: Cascading failures (dep fails → all downstream fail) → **Mitigation**: Allow manual override to unblock tasks despite failed dep
- **Risk**: Stale context (upstream task result changes after downstream reads it) → **Mitigation**: Context is immutable once written; new values create new keys
- **Risk**: Large context payloads bloating prompts → **Mitigation**: Cap injected context at 2000 chars; agent can call `workforce_read_context` for more
- **Risk**: Race condition on shared_context writes → **Mitigation**: SQLite UPSERT with UNIQUE constraint handles concurrent writes safely

## Testing strategy

- [ ] Create 3 tasks with A→B→C chain, verify B waits for A, C waits for B
- [ ] Create parallel tasks with shared group, verify both launch simultaneously
- [ ] Create cycle (A→B→A), verify rejection at creation time
- [ ] Write context from task A, verify task B's prompt includes it
- [ ] Fail task A, verify task B is auto-failed (cascade)
- [ ] Run `/workforce-decompose` with phases, verify tasks created with correct deps
- [ ] Dashboard shows dependency tree correctly

## Out of scope

- Real-time inter-agent messaging (agents talking to each other mid-run)
- Agent-initiated context queries at runtime (would require MCP within MCP)
- Cross-project context sharing (context is scoped to task groups)
- Automatic dependency inference (user/decomposer must specify deps explicitly)
