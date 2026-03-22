import { classifyTier, estimateCost as baseEstimate } from './cost-model.js';

const CACHE_OVERHEAD = 0.10;
const RETRY_OVERHEAD = 0.05;

export function estimateTaskCost(prompt, retryCount = 0) {
  const tier = classifyTier(prompt);
  const baseCost = baseEstimate(prompt);

  const adjustments = {};
  let multiplier = 1;

  if (/cache|caching/i.test(prompt)) {
    adjustments.cache_overhead = CACHE_OVERHEAD;
    multiplier += CACHE_OVERHEAD;
  }

  if (retryCount > 0) {
    const retryTotal = RETRY_OVERHEAD * retryCount;
    adjustments.retry_overhead = retryTotal;
    multiplier += retryTotal;
  }

  const totalCost = Math.round(baseCost * multiplier * 100) / 100;
  return { tier, baseCost, adjustments, totalCost };
}
