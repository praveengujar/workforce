/**
 * Dependency Graph Cache — pre-computed import relationship graph for impact analysis.
 *
 * Builds an in-memory graph from `git ls-files` + regex import parsing.
 * No persistence needed — fast enough to rebuild on demand (~1-3s for most repos).
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Cache state
// ---------------------------------------------------------------------------
let _forwardDeps = new Map();  // file -> Set<imported files>
let _reverseDeps = new Map();  // file -> Set<files that import it>
let _lastBuilt = null;
let _nodeCount = 0;
let _edgeCount = 0;

// ---------------------------------------------------------------------------
// Import parsing regexes
// ---------------------------------------------------------------------------
const IMPORT_PATTERNS = [
  // ES module: import ... from '...'
  /import\s+(?:[\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g,
  // ES module: import '...'
  /import\s+['"]([^'"]+)['"]/g,
  // CommonJS: require('...')
  /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  // Dynamic import: import('...')
  /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

// File extensions to try when resolving imports
const EXTENSIONS = ['', '.js', '.ts', '.tsx', '.jsx', '.mjs', '.cjs', '/index.js', '/index.ts'];

/**
 * Resolve a relative import to a file path within the project.
 */
function resolveImport(importPath, fromFile, allFiles) {
  if (!importPath.startsWith('.')) return null; // skip node_modules
  const dir = dirname(fromFile);
  const base = resolve('/', dir, importPath).slice(1); // normalize

  for (const ext of EXTENSIONS) {
    const candidate = base + ext;
    if (allFiles.has(candidate)) return candidate;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Graph operations
// ---------------------------------------------------------------------------

/**
 * Build the dependency graph from the project's git-tracked files.
 */
export function buildGraph(projectDir) {
  const forward = new Map();
  const reverse = new Map();

  // Get all tracked files via execFileSync (safe — no shell injection)
  let filesOutput;
  try {
    filesOutput = execFileSync('git', ['ls-files'], {
      cwd: projectDir,
      encoding: 'utf8',
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    throw new Error('Failed to list git files — is this a git repository?');
  }

  const allFilesList = filesOutput.trim().split('\n').filter(Boolean);
  const allFiles = new Set(allFilesList);

  // Filter to parseable source files
  const sourceFiles = allFilesList.filter(f =>
    /\.(js|ts|tsx|jsx|mjs|cjs|py|go|rs|java)$/.test(f),
  );

  let edgeCount = 0;

  for (const file of sourceFiles) {
    let content;
    try {
      content = readFileSync(join(projectDir, file), 'utf8');
    } catch {
      continue;
    }

    const deps = new Set();

    for (const pattern of IMPORT_PATTERNS) {
      // Reset lastIndex for global regex
      const re = new RegExp(pattern.source, pattern.flags);
      let match;
      while ((match = re.exec(content)) !== null) {
        const resolved = resolveImport(match[1], file, allFiles);
        if (resolved && resolved !== file) {
          deps.add(resolved);
        }
      }
    }

    if (deps.size > 0) {
      forward.set(file, deps);
      for (const dep of deps) {
        if (!reverse.has(dep)) reverse.set(dep, new Set());
        reverse.get(dep).add(file);
        edgeCount++;
      }
    }
  }

  // Update cache
  _forwardDeps = forward;
  _reverseDeps = reverse;
  _lastBuilt = new Date().toISOString();
  _nodeCount = sourceFiles.length;
  _edgeCount = edgeCount;

  return {
    nodes: _nodeCount,
    edges: _edgeCount,
    builtAt: _lastBuilt,
  };
}

/**
 * Get all files that depend on (import) the given file — reverse dependencies.
 * Answers: "what breaks if I change this file?"
 */
export function queryImpact(filePath) {
  const direct = _reverseDeps.get(filePath) || new Set();

  // Also compute transitive (2 levels deep to keep it fast)
  const transitive = new Set();
  for (const dep of direct) {
    const indirect = _reverseDeps.get(dep) || new Set();
    for (const t of indirect) {
      if (t !== filePath && !direct.has(t)) transitive.add(t);
    }
  }

  const totalAffected = direct.size + transitive.size;
  let risk = 'LOW';
  if (totalAffected > 8) risk = 'HIGH';
  else if (totalAffected > 3) risk = 'MEDIUM';

  return {
    file: filePath,
    directDependents: [...direct],
    transitiveDependents: [...transitive],
    totalAffected,
    risk,
  };
}

/**
 * Get all files that the given file imports — forward dependencies.
 */
export function queryDependencies(filePath) {
  const deps = _forwardDeps.get(filePath) || new Set();
  return {
    file: filePath,
    dependencies: [...deps],
    count: deps.size,
  };
}

/**
 * Get cache statistics.
 */
export function getCacheStats() {
  return {
    nodes: _nodeCount,
    edges: _edgeCount,
    lastBuilt: _lastBuilt,
    cached: _lastBuilt !== null,
  };
}
