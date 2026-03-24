/**
 * Shared constants and utilities used across the workforce MCP server.
 * Single source of truth for DATA_DIR, git helpers, and common utils.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const DATA_DIR = process.env.WORKFORCE_DATA_DIR || join(homedir(), '.claude', 'tasks');

export function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function gitExec(args, options = {}) {
  return execFileSync('git', args, { stdio: 'pipe', ...options }).toString().trim();
}

function findClaudeCli() {
  const explicit = process.env.CLAUDE_CLI;
  if (explicit) return explicit;

  const candidates = [
    join(homedir(), '.local', 'bin', 'claude'),
    join(homedir(), 'bin', 'claude'),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
  ];

  for (const p of candidates) {
    if (existsSync(p)) return p;
  }

  return 'claude';
}

export const CLAUDE_CLI = findClaudeCli();

export function getDateBoundaries() {
  const now = new Date();
  return {
    startOfToday: new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString(),
    startOfWeek: new Date(now.getFullYear(), now.getMonth(), now.getDate() - now.getDay()).toISOString(),
    startOfMonth: new Date(now.getFullYear(), now.getMonth(), 1).toISOString(),
    endOfDay: new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString(),
  };
}

export function isSubscriptionMode() {
  return (process.env.WORKFORCE_BILLING_MODE || 'subscription') !== 'api';
}
