/**
 * Dependency graph tool handler — build, query impact, query dependencies, stats.
 */

import {
  buildGraph, queryImpact, queryDependencies, getCacheStats,
} from '../core/dependency-graph-cache.js';

let _projectDir = process.cwd();

export function setGraphProjectDir(dir) {
  _projectDir = dir;
}

export function dependencyGraphHandler({ action, path, project_dir }) {
  const dir = project_dir || _projectDir;

  switch (action) {
    case 'build':
      return buildGraph(dir);

    case 'query_impact':
      if (!path) throw new Error('path is required for query_impact');
      return queryImpact(path);

    case 'query_dependencies':
      if (!path) throw new Error('path is required for query_dependencies');
      return queryDependencies(path);

    case 'stats':
      return getCacheStats();

    default:
      throw new Error(`Unknown action "${action}". Valid: build, query_impact, query_dependencies, stats`);
  }
}
