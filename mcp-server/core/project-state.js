export class CancellationToken {
  #cancelled = false;
  #callbacks = [];

  get cancelled() {
    return this.#cancelled;
  }

  cancel() {
    if (this.#cancelled) return;
    this.#cancelled = true;
    for (const cb of this.#callbacks) {
      try { cb(); } catch (err) { console.error('[CancellationToken] callback error:', err); }
    }
    this.#callbacks = [];
  }

  onCancel(callback) {
    if (this.#cancelled) { callback(); return; }
    this.#callbacks.push(callback);
  }
}

const tokens = new Map();

export function createToken(taskId) {
  if (tokens.has(taskId)) return tokens.get(taskId);
  const token = new CancellationToken();
  tokens.set(taskId, token);
  return token;
}

export function getToken(taskId) {
  return tokens.get(taskId);
}

export function cancelTask(taskId) {
  const token = tokens.get(taskId);
  if (token) { token.cancel(); tokens.delete(taskId); }
}

export function removeToken(taskId) {
  tokens.delete(taskId);
}
