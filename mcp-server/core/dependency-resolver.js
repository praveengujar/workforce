/**
 * Dependency Resolver — pure functions for dependency graph operations.
 *
 * Handles dependency satisfaction checks, topological sorting into execution
 * phases, cycle detection, and cascade failure identification.
 */

import { getTask, getAllTasks, getTasksByGroup } from './db.js';

// ---------------------------------------------------------------------------
// resolveDependencies
// ---------------------------------------------------------------------------

/**
 * Check if a task's dependencies are all satisfied.
 * @param {string} taskId
 * @returns {{ satisfied: boolean, pending: string[], failed: string[], done: string[] }}
 */
export function resolveDependencies(taskId) {
  const task = getTask(taskId);
  if (!task || !task.dependsOn) return { satisfied: true, pending: [], failed: [], done: [] };

  let deps;
  try { deps = JSON.parse(task.dependsOn); } catch { return { satisfied: true, pending: [], failed: [], done: [] }; }
  if (!Array.isArray(deps) || deps.length === 0) return { satisfied: true, pending: [], failed: [], done: [] };

  const pending = [], failed = [], done = [];
  for (const depId of deps) {
    const dep = getTask(depId);
    if (!dep) { failed.push(depId); continue; }
    if (dep.status === 'done' || dep.status === 'archived') { done.push(depId); }
    else if (dep.status === 'failed') { failed.push(depId); }
    else { pending.push(depId); }
  }

  return { satisfied: pending.length === 0 && failed.length === 0, pending, failed, done };
}

// ---------------------------------------------------------------------------
// getExecutionPhases
// ---------------------------------------------------------------------------

/**
 * Given a list of tasks with dependsOn, compute parallel execution phases
 * via topological sort (Kahn's algorithm).
 * @param {Array} tasks
 * @returns {Map<number, string[]>} Map from phase number to array of task IDs
 */
export function getExecutionPhases(tasks) {
  const phases = new Map();
  if (!tasks || tasks.length === 0) return phases;

  // Build adjacency and in-degree maps
  const taskMap = new Map();
  const inDegree = new Map();
  const dependents = new Map(); // depId -> [taskIds that depend on it]

  for (const task of tasks) {
    taskMap.set(task.id, task);
    inDegree.set(task.id, 0);
    if (!dependents.has(task.id)) dependents.set(task.id, []);
  }

  const taskIds = new Set(taskMap.keys());

  for (const task of tasks) {
    if (!task.dependsOn) continue;
    let deps;
    try { deps = JSON.parse(task.dependsOn); } catch { continue; }
    if (!Array.isArray(deps)) continue;

    // Only count deps that are within our task set
    for (const depId of deps) {
      if (!taskIds.has(depId)) continue;
      inDegree.set(task.id, (inDegree.get(task.id) || 0) + 1);
      if (!dependents.has(depId)) dependents.set(depId, []);
      dependents.get(depId).push(task.id);
    }
  }

  // Kahn's algorithm: process nodes with in-degree 0 in waves (phases)
  let currentPhase = 1;
  let queue = [];

  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }

  while (queue.length > 0) {
    phases.set(currentPhase, [...queue]);

    const nextQueue = [];
    for (const id of queue) {
      for (const depId of (dependents.get(id) || [])) {
        const newDeg = inDegree.get(depId) - 1;
        inDegree.set(depId, newDeg);
        if (newDeg === 0) nextQueue.push(depId);
      }
    }

    queue = nextQueue;
    currentPhase++;
  }

  // Any remaining nodes with in-degree > 0 are in a cycle — add them to the last phase
  const assigned = new Set();
  for (const ids of phases.values()) {
    for (const id of ids) assigned.add(id);
  }
  const unassigned = [...taskIds].filter(id => !assigned.has(id));
  if (unassigned.length > 0) {
    phases.set(currentPhase, unassigned);
  }

  return phases;
}

// ---------------------------------------------------------------------------
// detectCycles
// ---------------------------------------------------------------------------

/**
 * Detect cycles in dependency graph using DFS.
 * @param {Array} tasks
 * @returns {string[]|null} Cycle path array or null if no cycle
 */
export function detectCycles(tasks) {
  if (!tasks || tasks.length === 0) return null;

  const taskIds = new Set(tasks.map(t => t.id));
  const depsMap = new Map();

  for (const task of tasks) {
    let deps = [];
    if (task.dependsOn) {
      try { deps = JSON.parse(task.dependsOn); } catch { deps = []; }
      if (!Array.isArray(deps)) deps = [];
      // Only consider deps within the task set
      deps = deps.filter(d => taskIds.has(d));
    }
    depsMap.set(task.id, deps);
  }

  // DFS with three states: unvisited, visiting (in current path), visited (done)
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map();
  const parent = new Map();

  for (const id of taskIds) {
    color.set(id, WHITE);
    parent.set(id, null);
  }

  for (const startId of taskIds) {
    if (color.get(startId) !== WHITE) continue;

    const stack = [{ id: startId, entering: true }];

    while (stack.length > 0) {
      const { id, entering } = stack.pop();

      if (!entering) {
        color.set(id, BLACK);
        continue;
      }

      if (color.get(id) === GRAY) {
        // Already processing — skip (we'll mark BLACK via the non-entering entry)
        continue;
      }

      color.set(id, GRAY);
      // Push a "leaving" marker so we can set BLACK when done
      stack.push({ id, entering: false });

      for (const depId of (depsMap.get(id) || [])) {
        if (color.get(depId) === GRAY) {
          // Found a cycle — reconstruct path
          const cyclePath = [depId, id];
          let current = id;
          while (current !== depId && parent.get(current) != null) {
            current = parent.get(current);
            cyclePath.push(current);
          }
          cyclePath.reverse();
          return cyclePath;
        }
        if (color.get(depId) === WHITE) {
          parent.set(depId, id);
          stack.push({ id: depId, entering: true });
        }
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// getReadyTasks
// ---------------------------------------------------------------------------

/**
 * Get all pending tasks whose dependencies are fully satisfied (ready to launch).
 * @returns {Array} tasks ready to spawn
 */
export function getReadyTasks() {
  const pending = getAllTasks().filter(t => t.status === 'pending');
  return pending.filter(t => {
    const { satisfied } = resolveDependencies(t.id);
    return satisfied;
  });
}

// ---------------------------------------------------------------------------
// getCascadeFailures
// ---------------------------------------------------------------------------

/**
 * Get all pending tasks whose dependencies include at least one failed task.
 * These should be cascade-failed.
 * @returns {Array} tasks that should be cascade-failed
 */
export function getCascadeFailures() {
  const pending = getAllTasks().filter(t => t.status === 'pending' && t.dependsOn);
  return pending.filter(t => {
    const { failed } = resolveDependencies(t.id);
    return failed.length > 0;
  });
}

// ---------------------------------------------------------------------------
// buildDependencyTree
// ---------------------------------------------------------------------------

/**
 * Build a visual dependency tree string for a task group.
 * Returns formatted string like:
 * Phase 1: done a1b2c3d4  done e5f6g7h8          [2/2 complete]
 * Phase 2: run  m3n4o5p6  <- a1b2c3d4             [running]
 * Phase 3: wait q7r8s9t0  <- m3n4o5p6, e5f6g7h8   [waiting]
 *
 * @param {string} taskGroup
 * @returns {string}
 */
export function buildDependencyTree(taskGroup) {
  const tasks = getTasksByGroup(taskGroup);
  if (!tasks || tasks.length === 0) return `No tasks found for group "${taskGroup}"`;

  const phases = getExecutionPhases(tasks);
  if (phases.size === 0) return `No execution phases computed for group "${taskGroup}"`;

  const lines = [];

  for (const [phaseNum, taskIds] of phases) {
    const phaseEntries = [];
    let doneCount = 0;
    let totalCount = taskIds.length;
    let phaseStatus = 'waiting';

    for (const tid of taskIds) {
      const task = getTask(tid);
      if (!task) continue;

      const shortId = tid.slice(0, 8);
      let icon;
      switch (task.status) {
        case 'done':
        case 'archived':
          icon = '\u2713'; // checkmark
          doneCount++;
          break;
        case 'running':
          icon = '\u25CF'; // filled circle
          phaseStatus = 'running';
          break;
        case 'failed':
          icon = '\u2717'; // X mark
          break;
        default:
          icon = '\u25CB'; // empty circle
          break;
      }

      // Show dependencies
      let depStr = '';
      if (task.dependsOn) {
        try {
          const deps = JSON.parse(task.dependsOn);
          if (Array.isArray(deps) && deps.length > 0) {
            depStr = ' <- ' + deps.map(d => d.slice(0, 8)).join(', ');
          }
        } catch { /* ignore */ }
      }

      phaseEntries.push(`${icon} ${shortId}${depStr}`);
    }

    if (doneCount === totalCount) phaseStatus = `${doneCount}/${totalCount} complete`;
    else if (doneCount > 0) phaseStatus = `${doneCount}/${totalCount} complete`;

    lines.push(`Phase ${phaseNum}: ${phaseEntries.join('  ')}    [${phaseStatus}]`);
  }

  return lines.join('\n');
}
