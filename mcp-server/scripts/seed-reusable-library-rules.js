#!/usr/bin/env node

/**
 * Seed baseline reusable-library knowledge rules.
 *
 * Usage:
 *   node scripts/seed-reusable-library-rules.js --dry-run
 *   node scripts/seed-reusable-library-rules.js --apply
 */

import { createRule } from '../core/knowledge-rules.js';

const apply = process.argv.includes('--apply');

const BASE_PATHS = [
  'mcp-server/core/**',
  'mcp-server/tools/**',
  'hooks/**',
  'scripts/**',
  'skills/**',
  'agents/**',
  'src/**',
  'lib/**',
  'app/**',
  'packages/**',
  'tests/**',
  'test/**',
];

const rules = [
  {
    category: 'architecture',
    name: 'reusable-library-first',
    description: 'Prefer shared modules over copy-pasted implementation logic.',
    paths: BASE_PATHS,
    priority: 8,
    content: [
      'Before adding new capability logic, search for an existing shared implementation.',
      'If equivalent logic already exists, extend it instead of creating a second implementation.',
      'Extract to a shared library when any one is true: (a) logic appears in 2+ places, (b) >25 lines of reusable domain logic, (c) required by 2+ workflows.',
      'Do not extract trivial glue code or one-off adapter code that has no reuse likelihood.',
    ].join(' '),
  },
  {
    category: 'standards',
    name: 'no-duplicate-business-logic',
    description: 'Block duplicate domain behavior with different implementations.',
    paths: BASE_PATHS,
    priority: 9,
    content: [
      'Treat duplicate business logic as a defect, not stylistic debt.',
      'When changing behavior, update canonical shared logic first, then adapt callsites.',
      'If two implementations intentionally diverge, document the reason and boundaries in code comments and task notes.',
    ].join(' '),
  },
  {
    category: 'architecture',
    name: 'shared-module-api-contract',
    description: 'Shared libraries must expose stable, explicit contracts.',
    paths: BASE_PATHS,
    priority: 8,
    content: [
      'Every shared module must define clear input/output contracts (types or schema).',
      'Avoid hidden side effects and global mutable state in reusable modules.',
      'Version or deprecate contract changes; do not silently break downstream callsites.',
    ].join(' '),
  },
  {
    category: 'testing',
    name: 'shared-library-test-requirement',
    description: 'Library changes require regression coverage.',
    paths: BASE_PATHS,
    priority: 8,
    content: [
      'Any new or modified reusable module must include tests for happy path, edge cases, and failure handling.',
      'At least one test must prove backwards compatibility for existing behavior unless change is explicitly breaking.',
      'When migrating duplicate implementations to one shared path, add regression tests covering old call patterns.',
    ].join(' '),
  },
  {
    category: 'workflow',
    name: 'deprecate-before-delete-duplicate-paths',
    description: 'Use a safe migration path when collapsing duplicate features.',
    paths: BASE_PATHS,
    priority: 7,
    content: [
      'When consolidating duplicate functionality, mark old path as deprecated first, migrate callsites, then delete.',
      'Track migration progress with a checklist in the task output or changelog entry.',
      'Do not remove old path until tests pass and no active references remain.',
    ].join(' '),
  },
];

function printPlan() {
  console.log('Reusable-library rules seed plan');
  console.log(`Mode: ${apply ? 'APPLY' : 'DRY RUN'}`);
  console.log(`Rules: ${rules.length}`);
  for (const rule of rules) {
    console.log(`- [${rule.category}] ${rule.name} (P${rule.priority})`);
  }
}

function applyRules() {
  let success = 0;
  for (const rule of rules) {
    const saved = createRule(rule);
    success += 1;
    console.log(`upserted ${saved.id}: [${saved.category}] ${saved.name}`);
  }
  console.log(`Done. Upserted ${success} reusable-library rules.`);
}

printPlan();
if (apply) {
  applyRules();
} else {
  console.log('No changes written. Re-run with --apply to persist rules.');
}
