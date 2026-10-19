import { randomUUID } from 'node:crypto';

export function validateBinding(sessionID, binding) {
  if (
    !/^ses[\w-]+$/.test(sessionID) ||
    !binding ||
    !Array.isArray(binding.tabs) ||
    !binding.tabs.every((tab) => Number.isInteger(tab?.id) && tab.id >= 0) ||
    typeof binding.generation !== 'string' ||
    !binding.generation
  ) {
    throw new Error('Invalid tab binding');
  }
  return { ...binding, paused: !!binding.paused };
}

export class BrowserHub {
  socket = null;
  browserEnabled = false;
  extensionProtocol = null;
  bindings = new Map();
  pending = new Map();
  activity = [];

  attach(socket, enabled = false, protocol = 1) {
    if (this.socket) this.socket.close(4001, 'Replaced connection');
    this.reset('Browser connection replaced');
    this.socket = socket;
    this.browserEnabled = enabled;
    this.extensionProtocol = protocol;
    socket.on('close', () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.browserEnabled = false;
      this.extensionProtocol = null;
      this.reset('Chrome disconnected');
    });
  }

  reset(reason) {
    for (const entry of this.pending.values()) entry.reject(new Error(reason));
    this.pending.clear();
    this.bindings.clear();
  }

  bind(sessionID, binding) {
    const validated = validateBinding(sessionID, binding);
    if (this.bindings.get(sessionID)?.generation !== binding.generation)
      this.cancel(sessionID, 'Browser session changed');
    this.bindings.set(sessionID, validated);
  }

  cancel(sessionID, reason = 'Stopped') {
    for (const [id, entry] of this.pending) {
      if (entry.sessionID === sessionID) {
        entry.reject(new Error(reason));
        this.pending.delete(id);
      }
    }
  }

  pause(sessionID) {
    let binding = this.bindings.get(sessionID);
    if (!binding) {
      binding = { generation: randomUUID(), tabs: [] };
      this.bindings.set(sessionID, binding);
    }
    binding.paused = true;
    this.cancel(sessionID);
  }

  receive(message) {
    if (message.type === 'availability') {
      this.browserEnabled = message.enabled === true;
      if (!this.browserEnabled)
        for (const sessionID of this.bindings.keys())
          this.cancel(sessionID, 'Browser access disabled');
    }
    if (message.type === 'bind') this.bind(message.sessionID, message.binding);
    if (message.type === 'unbind') {
      this.cancel(message.sessionID, 'Tab disconnected');
      this.bindings.delete(message.sessionID);
    }
    if (message.type === 'pause') this.pause(message.sessionID);
    if (message.type !== 'result') return;
    const entry = this.pending.get(message.id);
    if (!entry) return;
    this.pending.delete(message.id);
    message.error ? entry.reject(new Error(message.error)) : entry.resolve(message.result);
  }

  async call(sessionID, tool, args, signal) {
    if (signal?.aborted) throw new Error('Browser action cancelled');
    if (!/^ses[\w-]+$/.test(sessionID || ''))
      throw new Error('This tool requires OpenCode session metadata.');
    if (!this.socket || this.socket.readyState !== 1) throw new Error('Chrome is disconnected.');
    if (![2, 3].includes(this.extensionProtocol))
      throw new Error(
        'Chrome is running the old extension. Reload OpenCode in Chrome at chrome://extensions.',
      );
    if (!this.browserEnabled)
      throw new Error(
        'Browser access is disabled. Click Save & enable browser in the extension toolbar popup.',
      );
    let binding = this.bindings.get(sessionID);
    if (!binding) {
      binding = { generation: randomUUID(), tabs: [], paused: false };
      this.bindings.set(sessionID, binding);
    }
    if (binding.paused)
      throw new Error('Browser actions stopped. Enable browser access in the extension popup.');
    const id = randomUUID();
    this.activity.push({ id, sessionID, tool, time: Date.now(), status: 'working' });
    this.activity = this.activity.slice(-100);
    const activity = this.activity.at(-1);
    let timer;
    const abort = (reason = 'Browser action cancelled') => {
      const entry = this.pending.get(id);
      if (!entry) return;
      this.pending.delete(id);
      if (this.socket?.readyState === 1)
        this.socket.send(JSON.stringify({ type: 'cancel', id, sessionID }));
      entry.reject(new Error(reason));
    };
    const onAbort = () => abort();
    try {
      return await new Promise((resolve, reject) => {
        timer = setTimeout(() => abort('Browser action timed out'), 25000);
        this.pending.set(id, { sessionID, resolve, reject });
        signal?.addEventListener('abort', onAbort, { once: true });
        this.socket.send(
          JSON.stringify({
            type: 'command',
            id,
            sessionID,
            tool,
            args,
            generation: binding.generation,
            expiresAt: Date.now() + 25000,
          }),
        );
      }).then((result) => {
        activity.status = 'done';
        return result;
      });
    } catch (error) {
      activity.status = 'error';
      activity.error = error.message;
      throw error;
    } finally {
      clearTimeout(timer);
      this.pending.delete(id);
      signal?.removeEventListener('abort', onAbort);
    }
  }
}
