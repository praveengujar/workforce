/**
 * Tests for Context Fabric M6 — worker-manager integration helpers.
 *
 * Run: node --test mcp-server/test/worker-manager-context-fabric.test.js
 *
 * Covers the orchestration helper that worker-manager.js uses:
 *  - mode resolution (env / defaults / fallback / unknown-warn)
 *  - shouldInject matrix
 *  - shouldRunAssembler
 *  - assembler-failure isolation (spawn must never break)
 *  - shadow vs analysis vs all vs off behavior with a stubbed assembler
 *
 * The real assembleContext is tested in context-assembler.test.js (M4); here
 * we inject a stub via applyContextFabric's `assembler` arg so we can verify
 * call/no-call behavior, prompt prepending, and error isolation without
 * touching the database.
 */

import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

const fabricMod = await import('../core/context-fabric-mode.js');
const {
  getFabricMode,
  shouldInject,
  shouldRunAssembler,
  applyContextFabric,
  FABRIC_MODES,
  _internals,
} = fabricMod;

const SAVED_ENV = process.env.WORKFORCE_CONTEXT_FABRIC_MODE;

beforeEach(() => {
  delete process.env.WORKFORCE_CONTEXT_FABRIC_MODE;
  _internals.resetCaches();
});

after(() => {
  if (SAVED_ENV === undefined) delete process.env.WORKFORCE_CONTEXT_FABRIC_MODE;
  else process.env.WORKFORCE_CONTEXT_FABRIC_MODE = SAVED_ENV;
});

// ---------------------------------------------------------------------------
// getFabricMode
// ---------------------------------------------------------------------------

describe('getFabricMode', () => {
  it('reads valid env override', () => {
    for (const m of FABRIC_MODES) {
      process.env.WORKFORCE_CONTEXT_FABRIC_MODE = m;
      _internals.resetCaches();
      assert.equal(getFabricMode(), m, `env=${m}`);
    }
  });

  it('falls back to shadow on unknown env value with stderr warning', () => {
    const origErr = console.error;
    let warned = '';
    console.error = (...args) => { warned += args.join(' ') + '\n'; };
    try {
      process.env.WORKFORCE_CONTEXT_FABRIC_MODE = 'banana';
      assert.equal(getFabricMode(), 'shadow');
      assert.match(warned, /Unknown WORKFORCE_CONTEXT_FABRIC_MODE/);
      assert.match(warned, /banana/);
      assert.match(warned, /shadow/);
    } finally {
      console.error = origErr;
    }
  });

  it('reads from defaults.json when env unset', () => {
    // defaults.json ships fabricMode: "shadow" in v3.6.
    delete process.env.WORKFORCE_CONTEXT_FABRIC_MODE;
    _internals.resetCaches();
    assert.equal(getFabricMode(), 'shadow');
  });

  it('falls back to shadow when env is empty string', () => {
    process.env.WORKFORCE_CONTEXT_FABRIC_MODE = '';
    _internals.resetCaches();
    assert.equal(getFabricMode(), 'shadow');
  });

  it('warns only once per unknown value', () => {
    const origErr = console.error;
    let warnings = 0;
    console.error = (...args) => {
      if (String(args[0] || '').includes('Unknown WORKFORCE_CONTEXT_FABRIC_MODE')) warnings++;
    };
    try {
      process.env.WORKFORCE_CONTEXT_FABRIC_MODE = 'gibberish';
      getFabricMode();
      getFabricMode();
      getFabricMode();
      assert.equal(warnings, 1, 'should de-dupe warnings for the same unknown value');
    } finally {
      console.error = origErr;
    }
  });
});

// ---------------------------------------------------------------------------
// shouldInject matrix
// ---------------------------------------------------------------------------

describe('shouldInject', () => {
  it('off → false for every task type', () => {
    for (const tt of ['standard', 'analysis', 'experiment', 'measurement']) {
      assert.equal(shouldInject('off', tt), false, `off+${tt}`);
    }
  });

  it('shadow → false for every task type', () => {
    for (const tt of ['standard', 'analysis', 'experiment', 'measurement']) {
      assert.equal(shouldInject('shadow', tt), false, `shadow+${tt}`);
    }
  });

  it('analysis → true only for analysis task type', () => {
    assert.equal(shouldInject('analysis', 'analysis'), true);
    assert.equal(shouldInject('analysis', 'standard'), false);
    assert.equal(shouldInject('analysis', 'experiment'), false);
    assert.equal(shouldInject('analysis', 'measurement'), false);
    assert.equal(shouldInject('analysis', undefined), false);
  });

  it('all → true regardless of task type', () => {
    for (const tt of ['standard', 'analysis', 'experiment', 'measurement', undefined, null]) {
      assert.equal(shouldInject('all', tt), true, `all+${tt}`);
    }
  });
});

// ---------------------------------------------------------------------------
// shouldRunAssembler
// ---------------------------------------------------------------------------

describe('shouldRunAssembler', () => {
  it('off → false', () => assert.equal(shouldRunAssembler('off'), false));
  it('shadow → true', () => assert.equal(shouldRunAssembler('shadow'), true));
  it('analysis → true', () => assert.equal(shouldRunAssembler('analysis'), true));
  it('all → true', () => assert.equal(shouldRunAssembler('all'), true));
  it('garbage → false (no surprises)', () => {
    assert.equal(shouldRunAssembler('banana'), false);
    assert.equal(shouldRunAssembler(undefined), false);
    assert.equal(shouldRunAssembler(null), false);
  });
});

// ---------------------------------------------------------------------------
// applyContextFabric — orchestration with stubbed assembler
// ---------------------------------------------------------------------------

const HARDCODED = '[hardcoded 10-layer prompt content]';
const baseTask = (overrides = {}) => ({
  id: 'task-abc12345',
  project: 'demo',
  prompt: 'fix login bug',
  taskType: 'standard',
  ...overrides,
});

function makeStub({ promptBlock = 'FABRIC-BLOCK', shouldThrow = false } = {}) {
  let calls = 0;
  let lastInput = null;
  const fn = (input) => {
    calls++;
    lastInput = input;
    if (shouldThrow) throw new Error('stub assembler boom');
    return {
      promptBlock,
      sections: [],
      audit: { query: input.prompt, generatedAt: new Date().toISOString() },
    };
  };
  return {
    fn,
    get calls() { return calls; },
    get lastInput() { return lastInput; },
  };
}

describe('applyContextFabric — off mode', () => {
  it('does NOT call assembler; prompt unchanged', () => {
    process.env.WORKFORCE_CONTEXT_FABRIC_MODE = 'off';
    const stub = makeStub();
    const r = applyContextFabric({
      task: baseTask(),
      hardcodedPrompt: HARDCODED,
      repoRoot: '/repo',
      assembler: stub.fn,
    });
    assert.equal(stub.calls, 0);
    assert.equal(r.prompt, HARDCODED);
    assert.equal(r.fabricRan, false);
    assert.equal(r.fabricOk, false);
    assert.equal(r.fabricInjected, false);
    assert.equal(r.fabricMode, 'off');
  });
});

describe('applyContextFabric — shadow mode', () => {
  it('calls assembler (audit side-effect) but does NOT prepend block', () => {
    process.env.WORKFORCE_CONTEXT_FABRIC_MODE = 'shadow';
    const stub = makeStub();
    const r = applyContextFabric({
      task: baseTask(),
      hardcodedPrompt: HARDCODED,
      repoRoot: '/repo',
      assembler: stub.fn,
    });
    assert.equal(stub.calls, 1, 'assembler must run so audit row is written');
    assert.equal(r.prompt, HARDCODED, 'prompt must be unchanged in shadow mode');
    assert.equal(r.fabricRan, true);
    assert.equal(r.fabricOk, true);
    assert.equal(r.fabricInjected, false);
    assert.equal(stub.lastInput.mode, 'spawn');
    assert.equal(stub.lastInput.taskId, 'task-abc12345');
    assert.equal(stub.lastInput.project, 'demo');
  });
});

describe('applyContextFabric — analysis mode', () => {
  it('prepends fabric block for analysis task', () => {
    process.env.WORKFORCE_CONTEXT_FABRIC_MODE = 'analysis';
    const stub = makeStub({ promptBlock: 'FABRIC' });
    const r = applyContextFabric({
      task: baseTask({ taskType: 'analysis' }),
      hardcodedPrompt: HARDCODED,
      repoRoot: '/repo',
      assembler: stub.fn,
    });
    assert.equal(stub.calls, 1);
    assert.equal(r.fabricInjected, true);
    assert.equal(r.prompt, `FABRIC\n\n${HARDCODED}`);
    assert.ok(r.prompt.startsWith('FABRIC'), 'fabric must be PREPENDED, not appended');
    assert.ok(r.prompt.endsWith(HARDCODED), 'hardcoded safety net must remain intact');
  });

  it('does NOT prepend fabric block for standard task (assembler still runs)', () => {
    process.env.WORKFORCE_CONTEXT_FABRIC_MODE = 'analysis';
    const stub = makeStub({ promptBlock: 'FABRIC' });
    const r = applyContextFabric({
      task: baseTask({ taskType: 'standard' }),
      hardcodedPrompt: HARDCODED,
      repoRoot: '/repo',
      assembler: stub.fn,
    });
    assert.equal(stub.calls, 1, 'assembler runs for shadow audit even on standard tasks');
    assert.equal(r.fabricInjected, false);
    assert.equal(r.prompt, HARDCODED);
  });

  it('does NOT prepend for experiment/measurement tasks', () => {
    process.env.WORKFORCE_CONTEXT_FABRIC_MODE = 'analysis';
    for (const tt of ['experiment', 'measurement']) {
      const stub = makeStub();
      const r = applyContextFabric({
        task: baseTask({ taskType: tt }),
        hardcodedPrompt: HARDCODED,
        repoRoot: '/repo',
        assembler: stub.fn,
      });
      assert.equal(r.fabricInjected, false, `taskType=${tt} should not be injected in analysis mode`);
      assert.equal(r.prompt, HARDCODED);
    }
  });
});

describe('applyContextFabric — all mode', () => {
  it('prepends fabric block for every task type', () => {
    process.env.WORKFORCE_CONTEXT_FABRIC_MODE = 'all';
    for (const tt of ['standard', 'analysis', 'experiment', 'measurement']) {
      const stub = makeStub({ promptBlock: `FABRIC-${tt}` });
      const r = applyContextFabric({
        task: baseTask({ taskType: tt }),
        hardcodedPrompt: HARDCODED,
        repoRoot: '/repo',
        assembler: stub.fn,
      });
      assert.equal(stub.calls, 1, `assembler called for ${tt}`);
      assert.equal(r.fabricInjected, true, `injected for ${tt}`);
      assert.equal(r.prompt, `FABRIC-${tt}\n\n${HARDCODED}`);
    }
  });

  it('skips injection when assembler returns empty promptBlock', () => {
    process.env.WORKFORCE_CONTEXT_FABRIC_MODE = 'all';
    const stub = makeStub({ promptBlock: '' });
    const r = applyContextFabric({
      task: baseTask(),
      hardcodedPrompt: HARDCODED,
      repoRoot: '/repo',
      assembler: stub.fn,
    });
    assert.equal(stub.calls, 1);
    assert.equal(r.fabricOk, true);
    assert.equal(r.fabricInjected, false);
    assert.equal(r.prompt, HARDCODED, 'empty block must not insert blank header');
  });
});

describe('applyContextFabric — assembler failure isolation', () => {
  it('does NOT throw when assembler throws; falls back to hardcoded prompt', () => {
    process.env.WORKFORCE_CONTEXT_FABRIC_MODE = 'all';
    const stub = makeStub({ shouldThrow: true });
    let thrown = null;
    let r;
    try {
      r = applyContextFabric({
        task: baseTask(),
        hardcodedPrompt: HARDCODED,
        repoRoot: '/repo',
        assembler: stub.fn,
      });
    } catch (e) {
      thrown = e;
    }
    assert.equal(thrown, null, 'applyContextFabric must not propagate assembler errors');
    assert.equal(stub.calls, 1);
    assert.equal(r.fabricRan, true);
    assert.equal(r.fabricOk, false);
    assert.equal(r.fabricInjected, false);
    assert.equal(r.fabricError, 'stub assembler boom');
    assert.equal(r.prompt, HARDCODED, 'hardcoded prompt is the safety net');
  });

  it('isolation holds in shadow mode too', () => {
    process.env.WORKFORCE_CONTEXT_FABRIC_MODE = 'shadow';
    const stub = makeStub({ shouldThrow: true });
    const r = applyContextFabric({
      task: baseTask(),
      hardcodedPrompt: HARDCODED,
      repoRoot: '/repo',
      assembler: stub.fn,
    });
    assert.equal(r.fabricOk, false);
    assert.equal(r.prompt, HARDCODED);
  });

  it('isolation holds in analysis mode for analysis task', () => {
    process.env.WORKFORCE_CONTEXT_FABRIC_MODE = 'analysis';
    const stub = makeStub({ shouldThrow: true });
    const r = applyContextFabric({
      task: baseTask({ taskType: 'analysis' }),
      hardcodedPrompt: HARDCODED,
      repoRoot: '/repo',
      assembler: stub.fn,
    });
    assert.equal(r.fabricOk, false);
    assert.equal(r.fabricInjected, false);
    assert.equal(r.prompt, HARDCODED);
  });
});

describe('applyContextFabric — argument plumbing', () => {
  it('passes task fields and repoRoot through to assembler input', () => {
    process.env.WORKFORCE_CONTEXT_FABRIC_MODE = 'all';
    const stub = makeStub();
    const task = baseTask({
      id: 'task-xyz',
      project: 'p1',
      prompt: 'do the thing',
      taskType: 'analysis',
      taskGroup: 'tg-9',
      dependsOn: '["dep-1"]',
    });
    applyContextFabric({
      task,
      hardcodedPrompt: HARDCODED,
      repoRoot: '/some/repo',
      assembler: stub.fn,
    });
    const input = stub.lastInput;
    assert.equal(input.taskId, 'task-xyz');
    assert.equal(input.project, 'p1');
    assert.equal(input.prompt, 'do the thing');
    assert.equal(input.taskType, 'analysis');
    assert.equal(input.taskGroup, 'tg-9');
    assert.equal(input.dependsOn, '["dep-1"]');
    assert.equal(input.repoRoot, '/some/repo');
    assert.equal(input.mode, 'spawn');
  });
});
