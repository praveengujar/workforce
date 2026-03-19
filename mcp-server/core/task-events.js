import { addTaskEvent, getTaskEvents } from './db.js';

export function logEvent(taskId, phase, detail = null) {
  addTaskEvent(taskId, phase, detail);
  const ts = new Date().toISOString();
  const suffix = detail ? ` - ${detail}` : '';
  console.error(`[${ts}] task=${taskId} phase=${phase}${suffix}`);
}

export function getTaskTimeline(taskId) {
  return getTaskEvents(taskId);
}
