// All state stays inside this Chrome profile. Idle is browser inactivity, not session completion.
import { DEFAULT_ARCHIVE_HOURS, validateArchiveHours } from './cleanup-settings.js';

export class TabLifecycle {
  archives = [];
  running = false;
  constructor(browser, chrome, now = () => Date.now()) {
    this.browser = browser;
    this.chrome = chrome;
    this.now = now;
  }
  async load() {
    this.archives = (await this.chrome.storage.local.get('tabArchives')).tabArchives || [];
  }
  async save() {
    await this.chrome.storage.local.set({ tabArchives: this.archives });
  }
  async keep(tabID, keep) {
    const entry = this.browser.owner(tabID);
    if (!entry) throw new Error('Tab is not agent-owned.');
    return this.browser.serial(this.browser.sessionWork, entry[0], async () => {
      const owned = entry[1].tabs.find((tab) => tab.id === tabID);
      if (!owned) throw new Error('Tab is no longer owned.');
      owned.keep = !!keep;
      await this.browser.save(entry[0]);
    });
  }
  async sweep({ connected, autoArchive = false, archiveAfterHours = DEFAULT_ARCHIVE_HOURS } = {}) {
    if (this.running || !connected?.() || !this.browser.enabled) return;
    this.running = true;
    const archiveEnabled = () => (typeof autoArchive === 'function' ? autoArchive() : autoArchive);
    const archiveDelay = () =>
      validateArchiveHours(
        typeof archiveAfterHours === 'function' ? archiveAfterHours() : archiveAfterHours,
      ) *
      60 *
      60_000;
    try {
      for (const [sessionID, binding] of Object.entries(this.browser.bindings)) {
        if (this.browser.sessionWork.has(sessionID)) continue;
        // Declared recordings and inspection sessions are still using these tabs between tool calls.
        if (
          this.browser.recordings?.sessions.has(sessionID) ||
          [...(this.browser.inspections?.states.values() || [])].some(
            (state) => state.sessionID === sessionID,
          )
        )
          continue;
        await this.browser.serial(this.browser.sessionWork, sessionID, async () => {
          const idle = this.now() - (binding.lastActivity || this.now());
          if (idle < 15 * 60_000 || binding.paused) return;
          for (const id of Object.values(binding.groups || {})) {
            const tabs = await this.chrome.tabs.query({ groupId: id });
            // Do not collapse a user's active tab or a group containing personal tabs.
            if (
              tabs.length &&
              tabs.every((tab) => !tab.active && binding.tabs.some((owned) => owned.id === tab.id))
            )
              await this.chrome.tabGroups.update(id, { collapsed: true }).catch(() => {});
          }
          if (!archiveEnabled() || idle < archiveDelay()) return;
          for (const owned of [...binding.tabs]) {
            if (!connected() || !this.browser.enabled || !archiveEnabled()) return;
            const tab = await this.chrome.tabs.get(owned.id).catch(() => null);
            if (!this.eligible(tab, owned)) continue;
            // Save before closing. On failure the live tab remains; restoration may duplicate a URL.
            if (this.archives.length >= 1000) return;
            const archive = {
              id: crypto.randomUUID(),
              sessionID,
              url: tab.url,
              title: tab.title || '',
              archivedAt: this.now(),
            };
            this.archives.push(archive);
            try {
              await this.save();
            } catch (error) {
              this.archives.pop();
              throw error;
            }
            const current = await this.chrome.tabs.get(tab.id).catch(() => null);
            if (
              !connected() ||
              !this.browser.enabled ||
              !archiveEnabled() ||
              this.now() - binding.lastActivity < archiveDelay() ||
              !this.eligible(current, owned) ||
              current.url !== tab.url ||
              this.browser.owner(tab.id)?.[0] !== sessionID
            ) {
              this.archives = this.archives.filter((item) => item.id !== archive.id);
              await this.save();
              continue;
            }
            await this.chrome.tabs.remove(tab.id);
            if (await this.chrome.tabs.get(tab.id).catch(() => null)) {
              this.archives = this.archives.filter((item) => item.id !== archive.id);
              await this.save();
              continue;
            }
            await this.browser.remove(tab.id);
          }
        });
      }
    } finally {
      this.running = false;
    }
  }
  eligible(tab, owned) {
    return (
      tab &&
      !owned.keep &&
      !tab.active &&
      !tab.pinned &&
      !tab.audible &&
      tab.status === 'complete' &&
      /^https?:\/\//.test(tab.url || '')
    );
  }
  async forget(id) {
    if (this.running) throw new Error('Cleanup is running. Retry shortly.');
    this.running = true;
    const previous = this.archives;
    this.archives = previous.filter((item) => item.id !== id);
    try {
      await this.save();
    } catch (error) {
      this.archives = previous;
      throw error;
    } finally {
      this.running = false;
    }
  }
  async restore(id) {
    if (this.running) throw new Error('Cleanup is running. Retry shortly.');
    this.running = true;
    try {
      const archive = this.archives.find((item) => item.id === id);
      if (!archive || !/^https?:\/\//.test(archive.url)) throw new Error('Archive is unavailable.');
      const binding = this.browser.bindings[archive.sessionID];
      const result = await this.browser.run({
        sessionID: archive.sessionID,
        generation: binding?.generation || crypto.randomUUID(),
        tool: 'open_tab',
        args: { url: archive.url },
        expiresAt: Date.now() + 30_000,
      });
      this.archives = this.archives.filter((item) => item.id !== id);
      await this.save();
      return result;
    } finally {
      this.running = false;
    }
  }
}
