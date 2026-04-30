/**
 * Context Fabric Mode — Context Fabric Milestone 6.
 *
 * Worker integration for the Context Fabric. Resolves the rollout mode and
 * decides, per task, whether the assembler runs (for audit-only telemetry)
 * and whether its output is injected into the spawn prompt.
 *
 * Modes (PRD §13 stages 1-3):
 *   - 'off':       fabric disabled entirely; assembler does not run.
 *   - 'shadow':    assembler runs (audit + per-layer telemetry written), but
 *                  the spawn prompt is unchanged. Stage 1.
 *   - 'analysis':  assembler runs for all tasks; output injected only into
 *                  analysis tasks (lowest blast radius). Stage 2.
 *   - 'all':       assembler runs and injects into every task. Stage 3.
 *
 * Resolution order: env WORKFORCE_CONTEXT_FABRIC_MODE → config defaults
 * (`context.fabricMode`) → fallback 'shadow'. Unknown values warn to stderr
 * and fall back to 'shadow'.
 *
 * The fabric is purely additive in v3.6: when injected, the assembler block
 * is PREPENDED to the existing hardcoded 10-layer prompt. The hardcoded
 * layers always run as a safety net — assembler failure must NEVER break a
 * task spawn.
 *
 * No new npm deps. ESM. Logs to stderr.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FABRIC_MODES = Object.freeze(['off', 'shadow', 'analysis', 'all']);
const FALLBACK_MODE = 'shadow';

let _cachedDefaultsMode = null;
let _warnedUnknown = new Set();

function loadDefaultsMode() {
  if (_cachedDefaultsMode !== null) return _cachedDefaultsMode;
  try {
    const here = fileURLToPath(new URL('.', import.meta.url));
    const cfgPath = join(here, '..', 'config', 'defaults.json');
    const raw = readFileSync(cfgPath, 'utf8');
    const parsed = JSON.parse(raw);
    const v = parsed && parsed.context && parsed.context.fabricMode;
    _cachedDefaultsMode = (typeof v === 'string' && FABRIC_MODES.includes(v)) ? v : '';
  } catch {
    _cachedDefaultsMode = '';
  }
  return _cachedDefaultsMode;
}

/**
 * Resolve the active fabric mode. env wins; then config defaults; then
 * fallback 'shadow'. Unknown values log a one-time stderr warning and fall
 * back to 'shadow'.
 */
export function getFabricMode() {
  const fromEnv = process.env.WORKFORCE_CONTEXT_FABRIC_MODE;
  if (typeof fromEnv === 'string' && fromEnv.length > 0) {
    if (FABRIC_MODES.includes(fromEnv)) return fromEnv;
    if (!_warnedUnknown.has(fromEnv)) {
      _warnedUnknown.add(fromEnv);
      console.error(
        `[context-fabric] Unknown WORKFORCE_CONTEXT_FABRIC_MODE="${fromEnv}"; `
        + `falling back to "${FALLBACK_MODE}". Valid: ${FABRIC_MODES.join(', ')}.`,
      );
    }
    return FALLBACK_MODE;
  }
  const fromDefaults = loadDefaultsMode();
  if (fromDefaults) return fromDefaults;
  return FALLBACK_MODE;
}

/**
 * Should the assembler-produced prompt block be PREPENDED to the spawn
 * prompt for this task?
 *   - 'all'      → yes for every task type
 *   - 'analysis' → yes only when taskType === 'analysis'
 *   - 'shadow'   → no (audit-only)
 *   - 'off'      → no
 */
export function shouldInject(mode, taskType) {
  if (mode === 'all') return true;
  if (mode === 'analysis') return taskType === 'analysis';
  return false;
}

/**
 * Should the assembler run at all? In 'off' mode it is skipped entirely;
 * in shadow/analysis/all it always runs (audit + telemetry are the point of
 * shadow mode).
 */
export function shouldRunAssembler(mode) {
  return mode === 'shadow' || mode === 'analysis' || mode === 'all';
}

/**
 * Worker-side orchestration: run the assembler if the active mode requires
 * it, optionally PREPEND its prompt block to the hardcoded prompt, and
 * isolate any assembler failure so the spawn continues with the hardcoded
 * 10-layer block as a safety net.
 *
 * The `assembler` arg is injectable for tests; production callers use the
 * default import binding from context-assembler.js.
 *
 * Returns:
 *   {
 *     prompt:     string,            // possibly fabric-prepended
 *     fabricMode: string,            // resolved mode used
 *     fabricRan:  boolean,           // assembler invoked
 *     fabricOk:   boolean,           // assembler succeeded
 *     fabricInjected: boolean,       // promptBlock prepended to prompt
 *     fabricError:    string|null,   // error message on failure
 *     fabricResult:   object|null,   // raw assembler result on success
 *   }
 */
export function applyContextFabric({ task, hardcodedPrompt, repoRoot, assembler }) {
  const mode = getFabricMode();
  const out = {
    prompt: hardcodedPrompt,
    fabricMode: mode,
    fabricRan: false,
    fabricOk: false,
    fabricInjected: false,
    fabricError: null,
    fabricResult: null,
  };

  if (!shouldRunAssembler(mode)) return out;
  if (typeof assembler !== 'function') {
    console.error('[context-fabric] applyContextFabric called without an assembler function; skipping.');
    return out;
  }

  out.fabricRan = true;
  let result = null;
  try {
    result = assembler({
      project: task && task.project,
      prompt: task && task.prompt,
      taskType: task && task.taskType,
      taskId: task && task.id,
      taskGroup: task && task.taskGroup,
      dependsOn: task && task.dependsOn,
      repoRoot,
      mode: 'spawn',
    });
  } catch (err) {
    out.fabricError = (err && err.message) ? err.message : String(err);
    console.error(`[context-fabric] assembler threw: ${out.fabricError}. Falling back to hardcoded prompt.`);
    return out;
  }

  out.fabricOk = true;
  out.fabricResult = result;

  if (shouldInject(mode, task && task.taskType)) {
    const block = result && typeof result.promptBlock === 'string' ? result.promptBlock : '';
    if (block.length > 0) {
      out.prompt = `${block}\n\n${hardcodedPrompt}`;
      out.fabricInjected = true;
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Test-only handles
// ---------------------------------------------------------------------------
export const _internals = {
  FALLBACK_MODE,
  resetCaches() {
    _cachedDefaultsMode = null;
    _warnedUnknown = new Set();
  },
};
