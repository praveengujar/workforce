import { readAllSharedContext, readSharedContext, writeSharedContext, deleteSharedContext, getTasksByGroup } from '../core/db.js';
import { resolveDependencies, buildDependencyTree } from '../core/dependency-resolver.js';
import { getTask } from '../core/db.js';

export function writeContextHandler({ group, key, value, task_id }) {
  if (!group) throw new Error('group is required');
  if (!key) throw new Error('key is required');
  if (value === undefined) throw new Error('value is required');
  const valueStr = typeof value === 'string' ? value : JSON.stringify(value);
  writeSharedContext(group, task_id || null, key, valueStr);
  return { ok: true, group, key };
}

export function readContextHandler({ group, key }) {
  if (!group) throw new Error('group is required');
  if (key) {
    const entry = readSharedContext(group, key);
    if (!entry) throw new Error(`Key "${key}" not found in group "${group}"`);
    return entry;
  }
  return readAllSharedContext(group);
}

export function taskDependenciesHandler({ task_id }) {
  if (!task_id) throw new Error('task_id is required');
  const task = getTask(task_id);
  if (!task) throw new Error('task not found');

  const resolution = resolveDependencies(task_id);
  return {
    taskId: task_id,
    status: task.status,
    dependsOn: task.dependsOn ? JSON.parse(task.dependsOn) : [],
    resolution,
    group: task.taskGroup || null,
    phase: task.phase || null,
  };
}

/**
 * Returns formatted group status with dependency tree.
 */
export function groupStatusHandler({ group }) {
  if (!group) throw new Error('group is required');

  const tasks = getTasksByGroup(group);
  if (tasks.length === 0) throw new Error(`No tasks found in group "${group}"`);

  const tree = buildDependencyTree(group);
  const context = readAllSharedContext(group);

  // Build formatted output
  let output = `\u2501\u2501\u2501 GROUP: ${group} (${tasks.length} tasks) \u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n\n`;
  output += tree;

  if (context.length > 0) {
    output += `\n\n\u2500\u2500\u2500 shared context \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n`;
    for (const entry of context) {
      const val = entry.value.length > 80 ? entry.value.slice(0, 80) + '...' : entry.value;
      output += `  ${entry.key}: ${val}\n`;
    }
  }

  return output;
}
