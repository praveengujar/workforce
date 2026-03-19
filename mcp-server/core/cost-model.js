import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const DATA_DIR = process.env.WORKFORCE_DATA_DIR || join(homedir(), '.claude', 'tasks');
const MODEL_PATH = join(DATA_DIR, 'cost-model.json');
const DRIFT_THRESHOLD = 0.15;

const SIMPLE_RE = /fix typo|rename|update comment|bump version|add import/i;
const MEDIUM_RE = /add feature|implement|create component|refactor/i;

const DEFAULT_MODEL = {
  tiers: {
    simple:  { baseCost: 0.05, actuals: [] },
    medium:  { baseCost: 0.25, actuals: [] },
    complex: { baseCost: 0.50, actuals: [] },
  },
  lastCalibrated: null,
};

let model = structuredClone(DEFAULT_MODEL);

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function calibrateTier(tier) {
  const data = model.tiers[tier];
  if (data.actuals.length < 3) return false;

  const med = median(data.actuals);
  const drift = Math.abs(med - data.baseCost) / data.baseCost;

  if (drift > DRIFT_THRESHOLD) {
    const oldCost = data.baseCost;
    data.baseCost = Math.round(med * 100) / 100;
    model.lastCalibrated = new Date().toISOString();
    console.error(`[costModel] recalibrated ${tier}: $${oldCost.toFixed(2)} -> $${data.baseCost.toFixed(2)} (drift ${(drift * 100).toFixed(1)}%)`);
    return true;
  }
  return false;
}

export function classifyTier(prompt) {
  if (SIMPLE_RE.test(prompt)) return 'simple';
  if (MEDIUM_RE.test(prompt)) return 'medium';
  return 'complex';
}

export function estimateCost(prompt) {
  const tier = classifyTier(prompt);
  return model.tiers[tier].baseCost;
}

export function recordActualCost(prompt, actualCost) {
  const tier = classifyTier(prompt);
  model.tiers[tier].actuals.push(actualCost);
  if (model.tiers[tier].actuals.length > 100) {
    model.tiers[tier].actuals = model.tiers[tier].actuals.slice(-100);
  }
  if (calibrateTier(tier)) saveCostModel();
}

export function getCostModel() {
  return structuredClone(model);
}

export function loadCostModel() {
  try {
    const raw = readFileSync(MODEL_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    for (const tier of Object.keys(DEFAULT_MODEL.tiers)) {
      if (!parsed.tiers?.[tier]) {
        parsed.tiers ??= {};
        parsed.tiers[tier] = structuredClone(DEFAULT_MODEL.tiers[tier]);
      }
      parsed.tiers[tier].actuals ??= [];
    }
    model = parsed;
    console.error('[costModel] loaded from', MODEL_PATH);
  } catch {
    model = structuredClone(DEFAULT_MODEL);
    console.error('[costModel] using defaults');
  }
}

export function saveCostModel() {
  try {
    writeFileSync(MODEL_PATH, JSON.stringify(model, null, 2) + '\n', 'utf8');
  } catch (err) {
    console.error('[costModel] save failed:', err.message);
  }
}
