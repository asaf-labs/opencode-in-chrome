import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionBrowser } from '../extension/session-browser.js';
import { TabLifecycle } from '../extension/lifecycle.js';
import { fakeChrome } from './fake-chrome.js';

const day = 24 * 60 * 60_000;
async function fixture() {
  const chrome = fakeChrome();
  const browser = new SessionBrowser(chrome);
  browser.enabled = true;
  const command = {
    sessionID: 'ses_cleanup',
    generation: 'g',
    tool: 'open_tab',
    args: { url: 'https://example.com' },
    expiresAt: Date.now() + 30_000,
  };
  const result = await browser.run(command);
  const lifecycle = new TabLifecycle(browser, chrome, () => Date.now() + 2 * day);
  await lifecycle.load();
  return { chrome, browser, lifecycle, tabID: result.tabID, command };
}

test('concurrent indicator updates reuse one group and preserve manual collapse', async () => {
  const { chrome, browser, tabID } = await fixture();
  const binding = browser.bindings.ses_cleanup;
  binding.groups = {};
  chrome.groupState.clear();
  await Promise.all(
    Array.from({ length: 8 }, () => browser.mark('ses_cleanup', chrome.tabState.get(tabID))),
  );
  assert.equal(chrome.groupState.size, 1);
  const groupID = binding.groups[1];
  await chrome.tabGroups.update(groupID, { collapsed: true });
  await browser.refreshIndicators();
  assert.equal(chrome.groupState.get(groupID).collapsed, true);
});

test('idle cleanup collapses groups by default but never closes tabs without opt-in', async () => {
  const { chrome, browser, lifecycle, tabID } = await fixture();
  const id = browser.bindings.ses_cleanup.groups[1];
  // Move focus away from the agent tab.
  await chrome.tabs.update(1, { active: true });
  await lifecycle.sweep({ connected: () => true });
  assert.equal(chrome.groupState.get(id).collapsed, true);
  assert.equal(chrome.tabState.has(tabID), true);
  assert.equal(lifecycle.archives.length, 0);
});

test('opt-in archives only owned eligible tabs, persists first and restores locally', async () => {
  const { chrome, browser, lifecycle, tabID } = await fixture();
  await chrome.tabs.update(1, { active: true });
  chrome.tabState.get(tabID).active = false;
  await lifecycle.sweep({ connected: () => true, autoArchive: true });
  assert.equal(chrome.tabState.has(tabID), false);
  assert.equal(chrome.tabState.has(1), true);
  assert.equal(lifecycle.archives.length, 1);
  assert.equal(chrome.saved.tabArchives.length, 1);
  const reloaded = new TabLifecycle(browser, chrome);
  await reloaded.load();
  const restored = await reloaded.restore(reloaded.archives[0].id);
  assert.equal(chrome.tabState.get(restored.tabID).url, 'https://example.com');
  assert.equal(browser.owner(restored.tabID)[0], 'ses_cleanup');
  assert.equal(reloaded.archives.length, 0);
});

test('active, pinned, audible, loading and kept tabs are never archived', async () => {
  for (const changes of [
    { active: true },
    { pinned: true },
    { audible: true },
    { status: 'loading' },
    { keep: true },
  ]) {
    const { chrome, lifecycle, tabID } = await fixture();
    Object.assign(chrome.tabState.get(tabID), { active: false }, changes);
    if (changes.keep) await lifecycle.keep(tabID, true);
    await lifecycle.sweep({ connected: () => true, autoArchive: true });
    assert.equal(chrome.tabState.has(tabID), true);
    assert.equal(lifecycle.archives.length, 0);
  }
});

test('disconnected, disabled or busy profiles/sessions do not clean up', async () => {
  const { chrome, browser, lifecycle, tabID } = await fixture();
  chrome.tabState.get(tabID).active = false;
  await lifecycle.sweep({ connected: () => false, autoArchive: true });
  browser.enabled = false;
  await lifecycle.sweep({ connected: () => true, autoArchive: true });
  browser.enabled = true;
  browser.sessionWork.set('ses_cleanup', Promise.resolve());
  await lifecycle.sweep({ connected: () => true, autoArchive: true });
  assert.equal(chrome.tabState.has(tabID), true);
});

test('archive storage failure leaves live tabs untouched', async () => {
  const { chrome, lifecycle, tabID } = await fixture();
  chrome.tabState.get(tabID).active = false;
  chrome.storage.local.set = async () => {
    throw new Error('disk full');
  };
  await assert.rejects(lifecycle.sweep({ connected: () => true, autoArchive: true }), /disk full/);
  assert.equal(chrome.tabState.has(tabID), true);
  assert.equal(lifecycle.archives.length, 0);
});

test('groups containing personal or active tabs are not collapsed', async () => {
  const { chrome, browser, lifecycle, tabID } = await fixture();
  const groupId = browser.bindings.ses_cleanup.groups[1];
  await chrome.tabs.group({ tabIds: [1], groupId });
  await lifecycle.sweep({ connected: () => true });
  assert.notEqual(chrome.groupState.get(groupId).collapsed, true);
  assert.equal(browser.owner(1), undefined);
  assert.equal(chrome.tabState.has(tabID), true);
});

test('tabs activated while saving an archive are rechecked and kept open', async () => {
  const { chrome, lifecycle, tabID } = await fixture();
  chrome.tabState.get(tabID).active = false;
  const save = chrome.storage.local.set;
  chrome.storage.local.set = async (value) => {
    await save(value);
    chrome.tabState.get(tabID).active = true;
  };
  await lifecycle.sweep({ connected: () => true, autoArchive: true });
  assert.equal(chrome.tabState.has(tabID), true);
  assert.equal(lifecycle.archives.length, 0);
});

test('Keep survives worker restart and saved URLs can be explicitly deleted', async () => {
  const { chrome, browser, lifecycle, tabID } = await fixture();
  await lifecycle.keep(tabID, true);
  const restarted = new SessionBrowser(chrome);
  await restarted.restore(chrome.saved.ownedSessionsV2);
  assert.equal(restarted.bindings.ses_cleanup.tabs[0].keep, true);
  lifecycle.archives.push({ id: 'saved', url: 'https://example.com' });
  await lifecycle.save();
  await lifecycle.forget('saved');
  assert.deepEqual(chrome.saved.tabArchives, []);
  assert.equal(browser.owner(1), undefined);
  await assert.rejects(lifecycle.keep(1, true), /not agent-owned/);
});
