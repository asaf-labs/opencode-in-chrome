import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionBrowser } from '../extension/session-browser.js';
import { fakeChrome } from './fake-chrome.js';

async function fixture() {
  const chrome = fakeChrome();
  const browser = new SessionBrowser(chrome);
  browser.enabled = true;
  const command = {
    sessionID: 'ses_debugger',
    generation: 'generation',
    expiresAt: Date.now() + 25_000,
  };
  const { tabID } = await browser.run({
    ...command,
    tool: 'open_tab',
    args: { url: 'https://example.com' },
  });
  return { chrome, browser, command, tabID, manager: browser.debuggers };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));

test('successful click leases debounce detach for 30 seconds after the most recent release', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { manager, chrome, command, tabID } = await fixture();
  const first = await manager.acquire(command, tabID);
  await manager.release(first, { debounce: true });
  t.mock.timers.tick(29_000);
  await flush();
  assert.equal(chrome.debuggerTabs.has(tabID), true);
  const second = await manager.acquire(command, tabID);
  await manager.release(second, { debounce: true });
  t.mock.timers.tick(29_999);
  await flush();
  assert.equal(chrome.debuggerTabs.has(tabID), true);
  assert.equal(chrome.debuggerCalls.filter((call) => call.action === 'attach').length, 1);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(chrome.debuggerTabs.size, 0);
  assert.equal(manager.entries.size, 0);
});

test('an active inspection/recording lease prevents idle detach; explicit final release detaches immediately', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { manager, chrome, command, tabID } = await fixture();
  const click = await manager.acquire(command, tabID);
  await manager.release(click, { debounce: true });
  const inspection = await manager.acquire(command, tabID);
  const nextClick = await manager.acquire(command, tabID);
  await manager.release(nextClick, { debounce: true });
  t.mock.timers.tick(60_000);
  await flush();
  assert.equal(manager.valid(inspection), true);
  assert.equal(chrome.debuggerCalls.filter((call) => call.action === 'attach').length, 1);
  await manager.release(inspection);
  assert.equal(chrome.debuggerTabs.size, 0);
});

test('disable/disconnect suspension, pause, tab removal, and protected navigation clear idle attachments immediately', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const action of ['suspend', 'pause', 'remove', 'protected']) {
    const { manager, browser, chrome, command, tabID } = await fixture();
    const lease = await manager.acquire(command, tabID);
    await manager.release(lease, { debounce: true });
    if (action === 'suspend') await browser.suspend();
    if (action === 'pause') await browser.pause(command.sessionID);
    if (action === 'remove') await browser.remove(tabID);
    if (action === 'protected')
      await browser.updated(
        tabID,
        { url: 'chrome://settings/' },
        { ...(await chrome.tabs.get(tabID)), url: 'chrome://settings/' },
      );
    assert.equal(chrome.debuggerTabs.size, 0, action);
    assert.equal(manager.entries.size, 0, action);
    t.mock.timers.tick(60_000);
    await flush();
    assert.equal(chrome.debuggerCalls.filter((call) => call.action === 'detach').length, 1, action);
  }
});

test('Chrome Cancel clears the old timer and cannot detach a later attachment', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { manager, chrome, command, tabID } = await fixture();
  const first = await manager.acquire(command, tabID);
  await manager.release(first, { debounce: true });
  chrome.detachDebugger(tabID);
  await flush();
  assert.equal(manager.entries.size, 0);
  const second = await manager.acquire(command, tabID);
  t.mock.timers.tick(60_000);
  await flush();
  assert.equal(manager.valid(second), true);
  await manager.release(second);
  assert.equal(chrome.debuggerTabs.size, 0);
});

test('suspension starts debugger cleanup before slow storage or indicator work completes', async () => {
  const { manager, browser, chrome, command, tabID } = await fixture();
  const lease = await manager.acquire(command, tabID);
  await manager.release(lease, { debounce: true });
  const resume = Promise.withResolvers();
  chrome.storage.session.set = () => resume.promise;
  const suspended = browser.suspend();
  await flush();
  assert.equal(chrome.debuggerTabs.size, 0);
  resume.resolve();
  await suspended;
});

test('failed attachment or invalidated ownership/generation never receives an idle grace period', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const invalidation of ['generation', 'ownership', 'disabled']) {
    const { manager, browser, chrome, command, tabID } = await fixture();
    const lease = await manager.acquire(command, tabID);
    if (invalidation === 'generation') browser.bindings[command.sessionID].generation = 'new';
    if (invalidation === 'ownership') browser.bindings[command.sessionID].tabs = [];
    if (invalidation === 'disabled') browser.enabled = false;
    await manager.release(lease, { debounce: true });
    assert.equal(chrome.debuggerTabs.size, 0, invalidation);
  }
  const { manager, chrome, command, tabID } = await fixture();
  chrome.debugger.attach = async () => {
    throw new Error('DevTools already attached');
  };
  await assert.rejects(manager.acquire(command, tabID), /DevTools/);
  assert.equal(manager.entries.size, 0);
});
