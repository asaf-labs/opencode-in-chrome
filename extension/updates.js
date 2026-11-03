import { extensionRevision } from './update-revision.js';

export async function restoreUpdateCheckpoint(chrome, checkpoint) {
  if (!checkpoint) return null;
  await chrome.storage.local.remove('updateCheckpoint');
  if (
    !Number.isFinite(checkpoint.expiresAt) ||
    checkpoint.expiresAt < Date.now() ||
    checkpoint.expiresAt > Date.now() + 60000
  )
    return null;
  const targets = await chrome.debugger.getTargets();
  const bindings = {};
  for (const [sessionID, binding] of Object.entries(checkpoint.bindings || {})) {
    const tabs = (binding.tabs || []).filter((tab) =>
      targets.some(
        (target) =>
          target.type === 'page' &&
          target.tabId === tab.id &&
          target.id === checkpoint.targets?.[tab.id],
      ),
    );
    if (tabs.length) bindings[sessionID] = { ...binding, tabs };
  }
  return bindings;
}

export class ExtensionUpdates {
  prepared = null;
  constructor(chrome, browser, { busy, readRevision = extensionRevision } = {}) {
    this.chrome = chrome;
    this.browser = browser;
    this.busy = busy;
    this.readRevision = readRevision;
    this.loaded = readRevision().catch(() => null);
  }

  get locked() {
    return !!this.prepared;
  }

  async prepare(id, revision) {
    if (this.locked || this.busy() || !/^[a-f0-9]{64}$/.test(revision || ''))
      throw new Error('Extension update deferred: browser work or retained captures are active.');
    this.prepared = { id, revision };
    try {
      if ((await this.readRevision()) !== revision)
        throw new Error(
          'Extension installation differs from the bridge; reload/update this profile manually.',
        );
      await this.chrome.storage.session.set({ ownedSessionsV2: this.browser.bindings });
      if (this.busy()) throw new Error('Extension became busy; update deferred.');
      return { prepared: true };
    } catch (error) {
      this.release(id);
      throw error;
    }
  }

  release(id) {
    if (this.prepared?.id === id) this.prepared = null;
  }

  disconnected() {
    if (!this.prepared?.reload) this.prepared = null;
  }

  assertPrepared(id) {
    if (!this.prepared || this.prepared.id !== id || this.busy())
      throw new Error('Extension update is no longer prepared.');
  }

  canReload(id) {
    this.assertPrepared(id);
    return this.prepared.reload === true;
  }

  async commit(id) {
    this.assertPrepared(id);
    const revision = this.prepared.revision;
    if ((await this.readRevision()) !== revision)
      throw new Error('Installation changed during activation.');
    this.assertPrepared(id);
    await this.browser.debuggers.clear();
    this.assertPrepared(id);
    await this.chrome.storage.session.set({ ownedSessionsV2: this.browser.bindings });
    const reload = (await this.loaded) !== revision;
    this.assertPrepared(id);
    if (reload) {
      const targets = await this.chrome.debugger.getTargets();
      this.assertPrepared(id);
      const identities = {};
      for (const binding of Object.values(this.browser.bindings)) {
        for (const tab of binding.tabs) {
          const target = targets.find(
            (target) => target.type === 'page' && target.tabId === tab.id,
          );
          if (!target?.id)
            throw new Error('Cannot verify owned tab identity for extension reload.');
          identities[tab.id] = target.id;
        }
      }
      await this.chrome.storage.local.set({
        updateCheckpoint: {
          expiresAt: Date.now() + 60000,
          targets: identities,
          bindings: this.browser.bindings,
        },
      });
    }
    this.assertPrepared(id);
    this.prepared.reload = reload;
    return reload;
  }
}
