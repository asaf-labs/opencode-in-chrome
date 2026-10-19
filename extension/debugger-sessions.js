export class DebuggerSessions {
  entries = new Map();

  constructor(chrome, browser) {
    this.chrome = chrome;
    this.browser = browser;
    chrome.debugger?.onDetach?.addListener((source) => {
      if (source.sessionId) return;
      const entry = this.entries.get(source.tabId);
      if (entry) {
        entry.detached = true;
        entry.attached = false;
        entry.closed = true;
        void this.close(entry);
      }
    });
  }

  valid(lease) {
    return !!lease && !lease.released && !lease.entry.closed && lease.entry.attached;
  }

  async acquire(command, tabID) {
    this.browser.assert(command);
    if (this.browser.owner(tabID)?.[0] !== command.sessionID)
      throw new Error('Debugger requires a session-owned tab.');
    if (!this.chrome.debugger) throw new Error('Reload the extension with debugger permission.');
    let entry = this.entries.get(tabID);
    if (
      entry &&
      (entry.closed ||
        entry.sessionID !== command.sessionID ||
        entry.generation !== command.generation)
    )
      throw new Error('Debugger attachment is closing or belongs to another session generation.');
    if (!entry) {
      entry = {
        tabID,
        sessionID: command.sessionID,
        generation: command.generation,
        leases: new Set(),
      };
      this.entries.set(tabID, entry);
      entry.ready = Promise.resolve()
        .then(() => this.chrome.debugger.attach({ tabId: tabID }, '1.3'))
        .then(() => {
          entry.attached = !entry.detached;
        });
    }
    this.cancelIdleDetach(entry);
    const lease = { entry };
    entry.leases.add(lease);
    try {
      await entry.ready;
      this.browser.assert(command);
      if (!this.valid(lease) || this.browser.owner(tabID)?.[0] !== command.sessionID)
        throw new Error('Debugger attachment stopped or ownership changed.');
      return lease;
    } catch (error) {
      await this.release(lease);
      throw error;
    }
  }

  cancelIdleDetach(entry) {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = undefined;
    entry.idleToken = undefined;
  }

  async release(lease, { debounce = false } = {}) {
    if (!lease || lease.released) return;
    lease.released = true;
    lease.entry.leases.delete(lease);
    const entry = lease.entry;
    if (entry.leases.size) return;
    const binding = this.browser.bindings[entry.sessionID];
    if (
      debounce &&
      entry.attached &&
      !entry.closed &&
      this.browser.enabled &&
      !binding?.paused &&
      binding?.generation === entry.generation &&
      this.browser.owner(entry.tabID)?.[0] === entry.sessionID
    ) {
      this.cancelIdleDetach(entry);
      const token = Symbol();
      entry.idleToken = token;
      entry.idleTimer = setTimeout(() => {
        if (
          entry.idleToken === token &&
          !entry.leases.size &&
          this.entries.get(entry.tabID) === entry
        )
          void this.close(entry).catch(() => {});
      }, 30_000);
      entry.idleTimer.unref?.();
    } else await this.close(entry);
  }

  async close(entry) {
    this.cancelIdleDetach(entry);
    if (entry.closing) return entry.closing;
    entry.closed = true;
    entry.closing = this.detach(entry);
    return entry.closing;
  }

  async detach(entry) {
    await entry.ready.catch(() => {});
    if (entry.attached) await this.chrome.debugger.detach({ tabId: entry.tabID }).catch(() => {});
    if (this.entries.get(entry.tabID) === entry) this.entries.delete(entry.tabID);
  }

  async clear(tabID) {
    const entries =
      tabID === undefined ? [...this.entries.values()] : [this.entries.get(tabID)].filter(Boolean);
    await Promise.all(entries.map((entry) => this.close(entry)));
  }
}
