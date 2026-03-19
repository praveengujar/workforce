import { execFileSync } from 'node:child_process';

let _tmuxAvailable = null;

export function isTmuxAvailable() {
  if (_tmuxAvailable !== null) return _tmuxAvailable;
  try {
    execFileSync('tmux', ['-V'], { stdio: 'pipe' });
    _tmuxAvailable = true;
  } catch {
    _tmuxAvailable = false;
  }
  return _tmuxAvailable;
}

export function createSession(name, command, cwd, env = {}) {
  const mergedEnv = { ...process.env, ...env };
  const envPrefix = Object.entries(env)
    .map(([k, v]) => `export ${k}=${JSON.stringify(v)}`)
    .join('; ');
  const fullCommand = envPrefix ? `${envPrefix}; ${command}` : command;

  execFileSync('tmux', [
    'new-session', '-d', '-s', name, '-c', cwd, fullCommand,
  ], { stdio: 'pipe', env: mergedEnv });
}

export function sendKeys(name, text, pressEnter = true) {
  const args = ['send-keys', '-t', name, text];
  if (pressEnter) args.push('Enter');
  execFileSync('tmux', args, { stdio: 'pipe' });
}

export function capturePane(name, historyLines = 2000) {
  try {
    return execFileSync('tmux', [
      'capture-pane', '-t', name, '-p', '-S', `-${historyLines}`,
    ], { stdio: 'pipe', encoding: 'utf8' });
  } catch {
    return '';
  }
}

export function killSession(name) {
  try {
    execFileSync('tmux', ['kill-session', '-t', name], { stdio: 'pipe' });
  } catch { /* session may already be dead */ }
}

export function listSessions(prefix = '') {
  try {
    const output = execFileSync('tmux', [
      'list-sessions', '-F', '#{session_name}',
    ], { stdio: 'pipe', encoding: 'utf8' });
    const sessions = output.trim().split('\n').filter(Boolean);
    return prefix ? sessions.filter(s => s.startsWith(prefix)) : sessions;
  } catch {
    return [];
  }
}

export function hasSession(name) {
  try {
    execFileSync('tmux', ['has-session', '-t', name], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

export function getSessionPid(name) {
  try {
    const output = execFileSync('tmux', [
      'list-panes', '-t', name, '-F', '#{pane_pid}',
    ], { stdio: 'pipe', encoding: 'utf8' });
    const pid = parseInt(output.trim(), 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

export function isSessionAlive(name) {
  if (!hasSession(name)) return false;
  const pid = getSessionPid(name);
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}
