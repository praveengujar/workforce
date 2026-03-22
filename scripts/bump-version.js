#!/usr/bin/env node

/**
 * bump-version.js — Bump the workforce plugin version across all locations.
 *
 * Usage:
 *   node scripts/bump-version.js patch    # 1.0.0 -> 1.0.1
 *   node scripts/bump-version.js minor    # 1.0.0 -> 1.1.0
 *   node scripts/bump-version.js major    # 1.0.0 -> 2.0.0
 *   node scripts/bump-version.js 2.3.4    # set explicit version
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const FILES = {
  plugin: join(ROOT, '.claude-plugin', 'plugin.json'),
  package: join(ROOT, 'mcp-server', 'package.json'),
  index: join(ROOT, 'mcp-server', 'index.js'),
};

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJson(path, data) {
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function bumpSemver(current, type) {
  const [major, minor, patch] = current.split('.').map(Number);
  switch (type) {
    case 'major': return `${major + 1}.0.0`;
    case 'minor': return `${major}.${minor + 1}.0`;
    case 'patch': return `${major}.${minor}.${patch + 1}`;
    default:
      if (/^\d+\.\d+\.\d+$/.test(type)) return type;
      throw new Error(`Invalid bump type: ${type}. Use major, minor, patch, or X.Y.Z`);
  }
}

function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error('Usage: node scripts/bump-version.js <major|minor|patch|X.Y.Z>');
    process.exit(1);
  }

  // Read current version from plugin.json (source of truth)
  const plugin = readJson(FILES.plugin);
  const current = plugin.version;
  const next = bumpSemver(current, arg);

  console.log(`Bumping version: ${current} → ${next}`);

  // 1. plugin.json
  plugin.version = next;
  writeJson(FILES.plugin, plugin);
  console.log(`  ✓ .claude-plugin/plugin.json`);

  // 2. package.json
  const pkg = readJson(FILES.package);
  pkg.version = next;
  writeJson(FILES.package, pkg);
  console.log(`  ✓ mcp-server/package.json`);

  // 3. index.js — update WORKFORCE_VERSION constant and McpServer version
  let indexContent = readFileSync(FILES.index, 'utf8');
  indexContent = indexContent.replace(
    /WORKFORCE_VERSION\s*=\s*['"][\d.]+['"]/,
    `WORKFORCE_VERSION = '${next}'`,
  );
  indexContent = indexContent.replace(
    /version:\s*['"][\d.]+['"]/,
    `version: '${next}'`,
  );
  writeFileSync(FILES.index, indexContent, 'utf8');
  console.log(`  ✓ mcp-server/index.js`);

  console.log(`\nVersion bumped to ${next}. Don't forget to update CHANGELOG.md.`);
}

main();
