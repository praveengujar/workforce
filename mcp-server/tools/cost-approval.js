/**
 * Cost Approval — decides whether a task needs explicit user confirmation
 * before launching, based on configurable cost policy thresholds.
 */

import { join } from 'node:path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { DATA_DIR } from '../core/constants.js';
const CONFIG_PATH = join(DATA_DIR, 'cost-policy.json');

const DEFAULT_POLICY = {
  approvalThreshold: 0.50,       // Tasks estimated above this need confirmation
  dailyAutoApproveLimit: 5.00,   // Auto-approve if daily spend is under this
  perTaskMax: 2.00,              // Hard reject tasks estimated above this
  enabled: true,
};

/**
 * Load cost policy from disk. Falls back to defaults.
 * @returns {object} The cost policy
 */
export function loadCostPolicy() {
  try {
    if (existsSync(CONFIG_PATH)) {
      const raw = readFileSync(CONFIG_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      // Merge with defaults so new fields always have values
      return { ...DEFAULT_POLICY, ...parsed };
    }
  } catch (err) {
    console.error('[cost-approval] Failed to load policy:', err.message);
  }
  return { ...DEFAULT_POLICY };
}

/**
 * Save cost policy to disk.
 * @param {object} policy - The cost policy to persist
 */
export function saveCostPolicy(policy) {
  try {
    if (!existsSync(DATA_DIR)) {
      mkdirSync(DATA_DIR, { recursive: true });
    }
    writeFileSync(CONFIG_PATH, JSON.stringify(policy, null, 2) + '\n', 'utf8');
  } catch (err) {
    console.error('[cost-approval] Failed to save policy:', err.message);
    throw new Error(`Failed to save cost policy: ${err.message}`);
  }
}

/**
 * Evaluate whether a task should be auto-approved, needs confirmation, or is rejected.
 *
 * Decision logic:
 *   1. If policy disabled → approved
 *   2. If estimatedCost > perTaskMax → rejected (hard cap)
 *   3. If estimatedCost > approvalThreshold → needs_confirmation
 *   4. If dailySpendSoFar + estimatedCost > dailyAutoApproveLimit → needs_confirmation
 *   5. Otherwise → approved
 *
 * @param {number} estimatedCost - Estimated cost of the task
 * @param {number} dailySpendSoFar - How much has been spent today
 * @param {object} [policy] - Cost policy config (loaded from disk if omitted)
 * @returns {{ decision: 'approved'|'needs_confirmation'|'rejected', reason: string }}
 */
export function evaluateTaskCost(estimatedCost, dailySpendSoFar, policy = null) {
  if (!policy) policy = loadCostPolicy();
  if (!policy.enabled) {
    return { decision: 'approved', reason: 'Cost policy disabled' };
  }

  // Hard reject above perTaskMax
  if (estimatedCost > policy.perTaskMax) {
    return {
      decision: 'rejected',
      reason: `Estimated $${estimatedCost.toFixed(2)} exceeds per-task max of $${policy.perTaskMax.toFixed(2)}`,
    };
  }

  // Need confirmation above threshold
  if (estimatedCost > policy.approvalThreshold) {
    return {
      decision: 'needs_confirmation',
      reason: `Estimated $${estimatedCost.toFixed(2)} exceeds auto-approve threshold of $${policy.approvalThreshold.toFixed(2)}`,
    };
  }

  // Check daily auto-approve limit
  if (dailySpendSoFar + estimatedCost > policy.dailyAutoApproveLimit) {
    return {
      decision: 'needs_confirmation',
      reason: `Daily spend would reach $${(dailySpendSoFar + estimatedCost).toFixed(2)}, exceeding auto-approve limit of $${policy.dailyAutoApproveLimit.toFixed(2)}`,
    };
  }

  return { decision: 'approved', reason: 'Within auto-approve limits' };
}

/**
 * Get a formatted cost approval status string for display.
 *
 * @param {{ decision: string, reason: string }} evaluation - Result from evaluateTaskCost
 * @param {number} estimatedCost - The estimated cost
 * @returns {string}
 */
export function formatCostApproval(evaluation, estimatedCost) {
  switch (evaluation.decision) {
    case 'approved':
      return `✓ Auto-approved (~$${estimatedCost.toFixed(2)})`;
    case 'needs_confirmation':
      return `⚠ Needs confirmation: ${evaluation.reason}`;
    case 'rejected':
      return `✗ Rejected: ${evaluation.reason}`;
    default:
      return `? Unknown decision: ${evaluation.decision}`;
  }
}

/**
 * Return the default policy object (for reference / reset).
 * @returns {object}
 */
export function getDefaultPolicy() {
  return { ...DEFAULT_POLICY };
}
