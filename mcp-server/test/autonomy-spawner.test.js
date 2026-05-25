/**
 * Autonomy backlog spawner tests.
 *
 * Verifies the top-up loop:
 *   - skips when mode is off/shadow
 *   - skips when run is halted
 *   - respects headroom (concurrencyCap - running - pending)
 *   - claims items before spawn so a mid-spawn crash can't double-issue
 *   - records consumedBy on success and rolls back on failure
 *   - honors the per-tick spawn cap
 *
 * Run: node --test mcp-server/test/autonomy-spawner.test.js
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startRun, endRun, setHalt } from '../core/autonomy-controller.js';
import { topUpBacklog, _internals } from '../core/autonomy-spawner.js';
import { DATA_DIR } from '../core/constants.js';
import { createTask, updateTask, getDb } from '../core/db.js';
import { randomUUID } from 'node:crypto';

const BACKLOG_PATH = join(DATA_DIR, 'backlog.json');
let savedBacklog = null;

function makeRepoRoot() {
  return mkdtempSync(join(tmpdir(), 'wf-spawner-test-'));
}

function setBacklog(items) {
  writeFileSync(BACKLOG_PATH, JSON.stringify({ items }, null, 2) + '\n', 'utf8');
}

function readBacklogItems() {
  return JSON.parse(readFileSync(BACKLOG_PATH, 'utf8')).items;
}

function makeItem(overrides = {}) {
  return {
    id: randomUUID(),
    title: 'Backlog test item',
    description: 'do a thing',
    priority: 'medium',
    score: 0,
    effort: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

// Clear leftover spawner-test tasks so headroom counts are predictable.
function purgeTestTasks() {
  const db = getDb();
  db.prepare("DELETE FROM tasks WHERE prompt LIKE 'Backlog test item%' OR project = 'spawner-test'").run();
}

describe('autonomy-spawner.topUpBacklog', () => {
  let repoRoot;
  let run;
  let backupExists = false;

  beforeEach(() => {
    repoRoot = makeRepoRoot();
    if (existsSync(BACKLOG_PATH)) {
      savedBacklog = readFileSync(BACKLOG_PATH, 'utf8');
      backupExists = true;
    }
    setBacklog([]);
    purgeTestTasks();
  });

  afterEach(() => {
    try { if (run) endRun(run.runId, 'test_cleanup'); } catch { /* ignore */ }
    run = null;
    purgeTestTasks();
    if (backupExists && savedBacklog != null) {
      writeFileSync(BACKLOG_PATH, savedBacklog, 'utf8');
    } else {
      try { rmSync(BACKLOG_PATH); } catch { /* ignore */ }
    }
    savedBacklog = null;
    backupExists = false;
    try { rmSync(repoRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('skips when no run is active (mode=off)', async () => {
    setBacklog([makeItem()]);
    let called = 0;
    const fakeCreate = async () => { called++; return { id: 'x' }; };
    const results = await topUpBacklog({ repoRoot, createTask: fakeCreate });
    assert.equal(results.length, 0);
    assert.equal(called, 0);
  });

  it('skips when run is in shadow mode', async () => {
    run = startRun({ repoRoot, mode: 'shadow', baseBranch: 'main' });
    setBacklog([makeItem()]);
    let called = 0;
    const fakeCreate = async () => { called++; return { id: 'x' }; };
    const results = await topUpBacklog({ repoRoot, createTask: fakeCreate });
    assert.equal(results.length, 0);
    assert.equal(called, 0);
  });

  it('skips when the run is halted', async () => {
    run = startRun({ repoRoot, mode: 'park', baseBranch: 'main' });
    setHalt(run.runId, 'manual_test');
    setBacklog([makeItem()]);
    let called = 0;
    const fakeCreate = async () => { called++; return { id: 'x' }; };
    const results = await topUpBacklog({ repoRoot, createTask: fakeCreate });
    assert.equal(results.length, 0);
    assert.equal(called, 0);
  });

  it('spawns up to the per-tick cap when capacity is wide open', async () => {
    run = startRun({ repoRoot, mode: 'park', baseBranch: 'main', maxConcurrency: 5 });
    setBacklog([
      makeItem({ title: 'a', priority: 'high' }),
      makeItem({ title: 'b', priority: 'high' }),
      makeItem({ title: 'c', priority: 'high' }),
    ]);

    let n = 0;
    const fakeCreate = async ({ prompt }) => {
      const id = `task-${++n}`;
      createTask({ id, prompt, project: 'spawner-test' });
      return { id };
    };

    const results = await topUpBacklog({ repoRoot, createTask: fakeCreate, perTickCap: 2 });
    assert.equal(results.length, 2, 'should respect perTickCap');
    const items = readBacklogItems();
    const claimed = items.filter((i) => i.consumedBy && i.consumedBy !== 'pending-spawn');
    assert.equal(claimed.length, 2);
  });

  it('priority order: critical/high before medium/low', async () => {
    run = startRun({ repoRoot, mode: 'park', baseBranch: 'main', maxConcurrency: 5 });
    setBacklog([
      makeItem({ title: 'low one', priority: 'low' }),
      makeItem({ title: 'high one', priority: 'high' }),
      makeItem({ title: 'medium one', priority: 'medium' }),
    ]);

    const spawned = [];
    const fakeCreate = async ({ prompt }) => {
      const id = `task-${spawned.length + 1}`;
      spawned.push(prompt);
      createTask({ id, prompt, project: 'spawner-test' });
      return { id };
    };

    await topUpBacklog({ repoRoot, createTask: fakeCreate, perTickCap: 1 });
    assert.match(spawned[0], /high one/);
  });

  it('rolls back the claim if createTask throws', async () => {
    run = startRun({ repoRoot, mode: 'park', baseBranch: 'main', maxConcurrency: 5 });
    const item = makeItem({ title: 'doomed' });
    setBacklog([item]);
    const fakeCreate = async () => { throw new Error('boom'); };
    const results = await topUpBacklog({ repoRoot, createTask: fakeCreate, perTickCap: 1 });
    assert.equal(results.length, 1);
    assert.ok(results[0].error);
    const items = readBacklogItems();
    assert.equal(items[0].consumedBy, undefined, 'rollback should clear consumedBy');
    assert.equal(items[0].consumedAt, undefined, 'rollback should clear consumedAt');
  });

  it('respects headroom (no spawn when running+pending >= cap)', async () => {
    run = startRun({ repoRoot, mode: 'park', baseBranch: 'main', maxConcurrency: 1 });
    // Seed one running task so headroom = 1 - 1 - 0 = 0.
    const busyId = `busy-${randomUUID()}`;
    createTask({ id: busyId, prompt: 'busy', project: 'spawner-test' });
    updateTask(busyId, { status: 'running' });
    setBacklog([makeItem({ title: 'should not spawn' })]);

    let called = 0;
    const fakeCreate = async () => { called++; return { id: 'x' }; };
    const results = await topUpBacklog({ repoRoot, createTask: fakeCreate });
    assert.equal(results.length, 0);
    assert.equal(called, 0);
  });

  it('opt-out via env disables spawning', async () => {
    run = startRun({ repoRoot, mode: 'auto', baseBranch: 'main' });
    setBacklog([makeItem()]);
    const prev = process.env.WORKFORCE_AUTONOMY_SPAWN_BACKLOG;
    process.env.WORKFORCE_AUTONOMY_SPAWN_BACKLOG = '0';
    try {
      let called = 0;
      const fakeCreate = async () => { called++; return { id: 'x' }; };
      const results = await topUpBacklog({ repoRoot, createTask: fakeCreate });
      assert.equal(results.length, 0);
      assert.equal(called, 0);
    } finally {
      if (prev === undefined) delete process.env.WORKFORCE_AUTONOMY_SPAWN_BACKLOG;
      else process.env.WORKFORCE_AUTONOMY_SPAWN_BACKLOG = prev;
    }
  });
});
