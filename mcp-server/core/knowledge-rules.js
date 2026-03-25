/**
 * Knowledge Rules Engine — path-scoped domain knowledge for agent context injection.
 *
 * Rules encode team standards, architectural patterns, and institutional knowledge
 * as machine-readable entries with glob-pattern path scoping. When a task is spawned,
 * matching rules are injected into the agent's effective prompt.
 */

import { randomUUID } from 'node:crypto';
import { getDb, stmt } from './db.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const VALID_CATEGORIES = [
  'standards', 'architecture', 'testing', 'security',
  'workflow', 'patterns', 'custom',
];

// ---------------------------------------------------------------------------
// Glob matching (inline, no external deps)
// ---------------------------------------------------------------------------

const _regexCache = new Map();

/**
 * Convert a glob pattern to a RegExp (cached).
 * Supports: ** (any path), * (any segment), ? (single char)
 */
function globToRegex(pattern) {
  if (_regexCache.has(pattern)) return _regexCache.get(pattern);
  let re = '';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === '*' && pattern[i + 1] === '*') {
      // ** matches any number of path segments
      re += '.*';
      i += 2;
      // Skip trailing slash after **
      if (pattern[i] === '/') i++;
    } else if (ch === '*') {
      // * matches anything except path separator
      re += '[^/]*';
      i++;
    } else if (ch === '?') {
      re += '.';
      i++;
    } else if ('.+^${}()|[]\\'.includes(ch)) {
      re += '\\' + ch;
      i++;
    } else {
      re += ch;
      i++;
    }
  }
  const rx = new RegExp('^' + re + '$');
  _regexCache.set(pattern, rx);
  return rx;
}

/**
 * Test if a file path matches a glob pattern.
 */
function matchGlob(pattern, filePath) {
  return globToRegex(pattern).test(filePath);
}

// ---------------------------------------------------------------------------
// CRUD operations
// ---------------------------------------------------------------------------

/**
 * Create or update a knowledge rule.
 * If a rule with the same category+name exists, it is updated.
 */
export function createRule({ category, name, description, paths, content, priority }) {
  if (!category || !VALID_CATEGORIES.includes(category)) {
    throw new Error(`Invalid category "${category}". Valid: ${VALID_CATEGORIES.join(', ')}`);
  }
  if (!name) throw new Error('name is required');
  if (!content) throw new Error('content is required');
  if (!paths || !Array.isArray(paths) || paths.length === 0) {
    throw new Error('paths must be a non-empty array of glob patterns');
  }

  const now = new Date().toISOString();
  const pathsJson = JSON.stringify(paths);
  const prio = priority ?? 5;

  // Check for existing rule with same category+name — upsert
  const existing = getDb().prepare(
    'SELECT id FROM knowledge_rules WHERE category = ? AND name = ?',
  ).get(category, name);

  if (existing) {
    getDb().prepare(
      `UPDATE knowledge_rules SET description = ?, paths = ?, content = ?, priority = ?, updatedAt = ?
       WHERE id = ?`,
    ).run(description ?? null, pathsJson, content, prio, now, existing.id);
    return getRuleById(existing.id);
  }

  const id = randomUUID().slice(0, 8);
  getDb().prepare(
    `INSERT INTO knowledge_rules (id, category, name, description, paths, content, priority, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, category, name, description ?? null, pathsJson, content, prio, now, now);
  return getRuleById(id);
}

/**
 * List rules, optionally filtered by category.
 */
export function listRules(category) {
  if (category) {
    return stmt('SELECT * FROM knowledge_rules WHERE category = ? ORDER BY priority DESC, name ASC').all(category);
  }
  return stmt('SELECT * FROM knowledge_rules ORDER BY category ASC, priority DESC, name ASC').all();
}

/**
 * Get a single rule by ID.
 */
export function getRuleById(id) {
  return stmt('SELECT * FROM knowledge_rules WHERE id = ?').get(id);
}

/**
 * Get all rules whose path patterns match any of the given file paths.
 * This is the "audit mapping" function — given files, return applicable rules.
 */
export function getRulesForPaths(filePaths) {
  if (!filePaths || filePaths.length === 0) return [];

  const allRules = stmt('SELECT * FROM knowledge_rules ORDER BY priority DESC').all();
  const matched = [];

  for (const rule of allRules) {
    let patterns;
    try { patterns = JSON.parse(rule.paths); } catch { continue; }

    let hits = false;
    for (const pattern of patterns) {
      for (const fp of filePaths) {
        if (matchGlob(pattern, fp)) {
          hits = true;
          break;
        }
      }
      if (hits) break;
    }
    if (hits) matched.push(rule);
  }

  return matched;
}

/**
 * Delete a rule by ID.
 */
export function deleteRule(id) {
  const rule = getRuleById(id);
  if (!rule) throw new Error(`Rule "${id}" not found`);
  stmt('DELETE FROM knowledge_rules WHERE id = ?').run(id);
  return rule;
}

/**
 * Extract file paths mentioned in a text string (task prompt).
 * Matches common path patterns: src/..., lib/..., paths with extensions, etc.
 */
export function extractPathsFromText(text) {
  if (!text) return [];
  // Match paths with known directory prefixes
  const pathRe = /(?:^|\s|["'`(])([./]*(?:src|lib|app|apps|components|pages|api|hooks|utils|services|models|tests?|spec|config|scripts?|mcp-server|agents?|skills?|packages|prisma|public|e2e|types|middleware|core|tools|docs)\/[^\s"'`),;]+)/gi;
  const matches = [];
  let m;
  while ((m = pathRe.exec(text)) !== null) {
    matches.push(m[1].replace(/[.,;:!?)]+$/, '')); // trim trailing punctuation
  }
  // Also match bare file references with extensions
  const extRe = /(?:^|\s|["'`(])([a-zA-Z0-9_./-]+\.(?:js|ts|tsx|jsx|py|rs|go|java|css|scss|html|md|json|yaml|yml|toml|sql|prisma|mjs|cjs))\b/gi;
  while ((m = extRe.exec(text)) !== null) {
    if (!matches.includes(m[1])) matches.push(m[1]);
  }
  return [...new Set(matches)];
}

/**
 * Keyword-to-category mapping for high-level prompts without explicit file paths.
 * Returns synthetic glob paths that match rules in relevant categories.
 */
const KEYWORD_CATEGORY_MAP = {
  security: ['auth', 'login', 'password', 'token', 'jwt', 'session', 'csrf', 'xss', 'injection', 'permission', 'rbac', 'mfa', 'encrypt', 'secret', 'credential'],
  architecture: ['api', 'route', 'endpoint', 'service', 'middleware', 'database', 'cache', 'redis', 'prisma', 'mongo', 'schema', 'migration'],
  testing: ['test', 'spec', 'e2e', 'playwright', 'jest', 'coverage', 'assertion', 'mock', 'fixture'],
  standards: ['lint', 'format', 'typescript', 'type', 'eslint', 'prettier', 'convention'],
  patterns: ['react', 'hook', 'query', 'socket', 'realtime', 'component', 'state', 'form'],
  workflow: ['deploy', 'docker', 'ci', 'cd', 'env', 'config', 'build', 'release', 'css', 'style', 'tailwind', 'color'],
};

/**
 * Get rules matching keywords in text (for prompts without explicit file paths).
 * Returns rules whose categories match detected keywords.
 */
export function getRulesForKeywords(text) {
  if (!text) return [];
  const textLower = text.toLowerCase();
  const matchedCategories = new Set();

  for (const [category, keywords] of Object.entries(KEYWORD_CATEGORY_MAP)) {
    for (const keyword of keywords) {
      if (textLower.includes(keyword)) {
        matchedCategories.add(category);
        break;
      }
    }
  }

  if (matchedCategories.size === 0) return [];

  const cats = [...matchedCategories];
  const placeholders = cats.map(() => '?').join(', ');
  return getDb().prepare(
    `SELECT * FROM knowledge_rules WHERE category IN (${placeholders}) ORDER BY priority DESC`,
  ).all(...cats);
}

export { VALID_CATEGORIES, matchGlob };
