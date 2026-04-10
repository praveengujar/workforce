/**
 * Capability Router — rule-based skill selection from intent and risk.
 *
 * Analyzes a task prompt and recommends the optimal skill path.
 * Returns the recommended skill, why it was chosen, and alternatives.
 */

// ---------------------------------------------------------------------------
// Intent detection patterns
// ---------------------------------------------------------------------------
const INTENT_PATTERNS = {
  security: /\b(security|auth|token|jwt|csrf|xss|injection|permission|rbac|secret|credential|encrypt|vulnerability|audit|penetration)\b/i,
  design: /\b(design|ui|ux|layout|typography|color|spacing|responsive|mobile|css|tailwind|style|visual|aesthetic|mockup|wireframe)\b/i,
  test: /\b(test|e2e|playwright|jest|coverage|qa|verification|regression)\b/i,
  infrastructure: /\b(deploy|docker|ci|cd|kubernetes|terraform|pipeline|github.action|workflow|container|helm)\b/i,
  investigation: /\b(investigate|debug|diagnose|trace|root.cause|why|analyze|understand|missing|broken)\b/i,
  refactor: /\b(refactor|reorganize|restructure|extract|consolidate|simplify|clean.up|tech.debt)\b/i,
};

const SENSITIVE_PATHS = /\b(auth|payment|billing|secret|credential|migration|permission|admin|security)\b/i;

// ---------------------------------------------------------------------------
// Route determination
// ---------------------------------------------------------------------------

/**
 * Recommend a skill path based on prompt analysis.
 *
 * @param {Object} params
 * @param {string} params.prompt - Task prompt
 * @param {string} params.tier - Estimated tier (simple|medium|complex)
 * @param {string[]} [params.filePaths] - Detected file paths
 * @returns {{ skill: string, reason: string, alternatives: string[], flags: string[] }}
 */
export function routeTask({ prompt, tier, filePaths = [] }) {
  const flags = [];
  const alternatives = [];

  // Detect intents
  const intents = new Set();
  for (const [intent, pattern] of Object.entries(INTENT_PATTERNS)) {
    if (pattern.test(prompt)) intents.add(intent);
  }

  // Detect sensitivity
  const isSensitive = SENSITIVE_PATHS.test(prompt) ||
    filePaths.some(p => SENSITIVE_PATHS.test(p));
  if (isSensitive) flags.push('security-sensitive');

  // Detect UI scope
  const hasUI = intents.has('design') ||
    filePaths.some(p => /\.(tsx|jsx|css|scss|svelte|vue)$/.test(p));
  if (hasUI) flags.push('has-ui');

  // Route decision tree (v3 C-suite naming)
  let skill, reason;

  if (intents.has('investigation')) {
    skill = '/workforce-coo decompose';
    reason = 'Investigation detected — decompose into analysis + fix tasks';
    alternatives.push('/workforce-coo launch (with task_type: analysis)');
  } else if (tier === 'complex' || (isSensitive && tier !== 'simple')) {
    skill = '/workforce-ceo';
    reason = `${tier === 'complex' ? 'Complex task' : 'Security-sensitive change'} — strict gated orchestration`;
    alternatives.push('/workforce-ceo pipeline', '/workforce-cto rubberduck');
  } else if (hasUI && !intents.has('test')) {
    if (intents.has('design')) {
      skill = '/workforce-cdo consult';
      reason = 'Design work detected — establish design system first';
      alternatives.push('/workforce-cdo shotgun');
    } else {
      skill = '/workforce-ceo pipeline';
      reason = 'UI change — adaptive pipeline includes test plan + QA';
      alternatives.push('/workforce-ceo');
    }
  } else if (intents.has('security')) {
    skill = '/workforce-cso';
    reason = 'Security concern — run CSO audit';
    alternatives.push('/workforce-cto adversarial', '/workforce-ceo pipeline');
  } else if (intents.has('test')) {
    skill = '/workforce-cqo qa';
    reason = 'Testing intent — generate E2E tests';
    alternatives.push('/workforce-cqo testplan');
  } else if (tier === 'medium') {
    skill = '/workforce-cto rubberduck';
    reason = 'Medium complexity — refine prompt before launch';
    alternatives.push('/workforce-ceo pipeline', '/workforce-coo launch');
  } else {
    // Simple task
    skill = '/workforce-coo launch';
    reason = 'Simple task — direct launch';
    alternatives.push('/workforce-cto rubberduck');
  }

  return { skill, reason, alternatives, flags, detectedIntents: [...intents] };
}
