/**
 * Notification outbox + delivery worker.
 *
 * Autonomy NEVER blocks on a channel. `notify()` writes a row to
 * `notification_outbox` synchronously and returns. A background drain
 * (started by `startDrain()`) sends queued rows through configured channels
 * with exponential backoff.
 *
 * Channels:
 *   - 'macos' : `osascript -e 'display notification ...'` (default; macOS only)
 *   - 'slack' : webhook from $WORKFORCE_SLACK_WEBHOOK (or configured env)
 *   - 'email' : `mail` / `mailx` to $WORKFORCE_EMAIL_RECIPIENT
 *
 * Severity: 'info' | 'warning' | 'critical'. Channels can filter by min
 * severity via config; future channels can extend the dispatcher.
 *
 * Unknown channel names fall back to a no-op delivery that marks the row
 * delivered (so misconfiguration doesn't fill the outbox forever).
 */

import { execFileSync, spawn } from 'node:child_process';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { URL } from 'node:url';

import {
  enqueueNotification,
  listPendingNotifications,
  markNotificationDelivered,
  markNotificationFailed,
} from './db.js';
import { getAutonomyConfig } from './autonomy-controller.js';

const SEVERITY_ORDER = { info: 0, warning: 1, critical: 2 };

let _drainTimer = null;
let _draining = false;

function severityAtLeast(sev, min) {
  return (SEVERITY_ORDER[sev] ?? 0) >= (SEVERITY_ORDER[min] ?? 0);
}

/**
 * Synchronously enqueue a notification. Returns immediately. Multi-channel
 * fan-out: writes one outbox row per configured channel.
 */
export function notify({
  subject,
  body = null,
  severity = 'info',
  channels = null,
  runId = null,
  taskId = null,
  payload = null,
}) {
  const cfg = getAutonomyConfig().notifications || {};
  const chosen = channels && channels.length > 0 ? channels : (cfg.channels || ['macos']);
  const minSeverity = cfg.minSeverity || 'info';
  if (!severityAtLeast(severity, minSeverity)) return 0;

  let written = 0;
  for (const ch of chosen) {
    try {
      enqueueNotification({ channel: ch, severity, runId, taskId, subject, body, payload });
      written++;
    } catch (err) {
      console.error(`[notifier] enqueue failed for channel=${ch}: ${err.message}`);
    }
  }
  return written;
}

// ---------------------------------------------------------------------------
// Channel delivery
// ---------------------------------------------------------------------------

function deliverMacos({ subject, body }) {
  if (process.platform !== 'darwin') {
    // Non-macOS: just log and consider it "delivered" so we don't loop.
    console.error(`[notifier:macos] (skipped on ${process.platform}) ${subject}`);
    return;
  }
  const safeSubject = String(subject || '').replace(/["\\]/g, '');
  const safeBody = String(body || '').replace(/["\\]/g, '');
  const script = `display notification "${safeBody}" with title "Workforce" subtitle "${safeSubject}"`;
  execFileSync('osascript', ['-e', script], { stdio: 'pipe', timeout: 5000 });
}

function deliverSlack({ subject, body, severity }) {
  const cfg = getAutonomyConfig().notifications || {};
  const envVar = cfg.slackWebhookEnv || 'WORKFORCE_SLACK_WEBHOOK';
  const webhook = process.env[envVar];
  if (!webhook) throw new Error(`Slack webhook env ${envVar} not set`);

  const url = new URL(webhook);
  const payload = JSON.stringify({
    text: `*[${severity.toUpperCase()}] ${subject}*${body ? `\n${body}` : ''}`,
  });
  const opts = {
    method: 'POST',
    hostname: url.hostname,
    port: url.port || (url.protocol === 'https:' ? 443 : 80),
    path: url.pathname + url.search,
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    },
  };
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = lib(opts, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve();
        else reject(new Error(`Slack ${res.statusCode}: ${data}`));
      });
    });
    req.on('error', reject);
    req.setTimeout(10_000, () => req.destroy(new Error('Slack timeout')));
    req.write(payload);
    req.end();
  });
}

function deliverEmail({ subject, body }) {
  const cfg = getAutonomyConfig().notifications || {};
  const envVar = cfg.emailRecipientEnv || 'WORKFORCE_EMAIL_RECIPIENT';
  const to = process.env[envVar];
  if (!to) throw new Error(`Email recipient env ${envVar} not set`);

  return new Promise((resolve, reject) => {
    const child = spawn('mail', ['-s', subject, to], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`mail exited ${code}: ${stderr.trim()}`));
    });
    if (body) child.stdin.write(body);
    child.stdin.end();
  });
}

async function deliverOne(row) {
  switch (row.channel) {
    case 'macos': return deliverMacos(row);
    case 'slack': return deliverSlack(row);
    case 'email': return deliverEmail(row);
    default:
      console.error(`[notifier] unknown channel "${row.channel}" — dropping`);
      return; // treat as delivered
  }
}

// ---------------------------------------------------------------------------
// Drain loop
// ---------------------------------------------------------------------------

function backoffMs(attempts) {
  return Math.min(30 * 60_000, 2 ** attempts * 1000); // cap at 30min
}

async function drainOnce() {
  if (_draining) return;
  _draining = true;
  try {
    const cfg = getAutonomyConfig().notifications || {};
    const maxAttempts = Number(cfg.maxAttempts || 5);
    const pending = listPendingNotifications(50);
    for (const row of pending) {
      try {
        await deliverOne(row);
        markNotificationDelivered(row.id);
      } catch (err) {
        const attempts = (row.attempts || 0) + 1;
        const next = attempts < maxAttempts
          ? new Date(Date.now() + backoffMs(attempts)).toISOString()
          : null;
        markNotificationFailed(row.id, err.message || String(err), next, attempts);
        if (next == null) {
          console.error(`[notifier] giving up on row ${row.id} after ${attempts} attempts: ${err.message}`);
        }
      }
    }
  } finally {
    _draining = false;
  }
}

export function startDrain(intervalMs = null) {
  if (_drainTimer) return;
  const cfg = getAutonomyConfig().notifications || {};
  const ms = intervalMs ?? Number(cfg.drainIntervalMs || 5000);
  _drainTimer = setInterval(() => {
    drainOnce().catch((err) => console.error(`[notifier] drain error: ${err.message}`));
  }, ms);
  if (typeof _drainTimer.unref === 'function') _drainTimer.unref();
}

export function stopDrain() {
  if (_drainTimer) {
    clearInterval(_drainTimer);
    _drainTimer = null;
  }
}

export const _internals = { drainOnce, backoffMs };
