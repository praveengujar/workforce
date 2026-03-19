import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const DATA_DIR = process.env.WORKFORCE_DATA_DIR || join(homedir(), '.claude', 'tasks');
const PROFILES_PATH = join(DATA_DIR, 'profiles.json');

let _profiles = null;

const DEFAULT_PROFILES = {
  default: {
    command: 'claude',
    args: ['--print', '--dangerously-skip-permissions'],
    description: 'Claude Code (auto-accept)',
    passPromptVia: 'arg',
  },
  interactive: {
    command: 'claude',
    args: [],
    description: 'Claude Code (interactive)',
    passPromptVia: 'none',
  },
};

export function loadProfiles() {
  try {
    if (existsSync(PROFILES_PATH)) {
      const raw = readFileSync(PROFILES_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      _profiles = { ...DEFAULT_PROFILES, ...(parsed.profiles || parsed) };
      console.error(`[profiles] Loaded ${Object.keys(_profiles).length} profiles`);
    } else {
      _profiles = { ...DEFAULT_PROFILES };
    }
  } catch (err) {
    console.error('[profiles] Failed to load:', err.message);
    _profiles = { ...DEFAULT_PROFILES };
  }
  return _profiles;
}

export function getProfile(name) {
  if (!_profiles) loadProfiles();
  return _profiles[name] || _profiles.default;
}

export function listProfiles() {
  if (!_profiles) loadProfiles();
  return Object.entries(_profiles).map(([name, p]) => ({
    name,
    description: p.description || name,
    command: p.command,
  }));
}
