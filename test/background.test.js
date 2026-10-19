import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeChrome } from './fake-chrome.js';

test('pairing stays suspended until authenticated readiness and disable survives a delayed handshake', async (t) => {
  const listeners = {};
  const event = (name) => ({
    addListener: (callback) => {
      listeners[name] = callback;
    },
  });
  const chrome = fakeChrome();
  const settings = { url: 'http://127.0.0.1:8790', token: 'a'.repeat(64), enabled: true };
  chrome.storage.local = {
    setAccessLevel: async () => {},
    get: async () => ({ settings }),
    set: async () => {},
  };
  chrome.storage.session.get = async () => ({});
  chrome.storage.session.setAccessLevel = async () => {};
  chrome.runtime = { id: 'test-extension', onMessage: event('message') };
  chrome.alarms = { create: () => {}, onAlarm: event('alarm') };
  chrome.permissions = { contains: async () => true, onRemoved: event('permission') };
  chrome.tabs.onRemoved = event('removed');
  chrome.tabs.onCreated = event('created');
  chrome.tabs.onUpdated = event('updated');
  const sockets = [];
  class Socket {
    static OPEN = 1;
    static CONNECTING = 0;
    readyState = 0;
    sent = [];
    constructor() {
      sockets.push(this);
    }
    send(value) {
      this.sent.push(JSON.parse(value));
    }
    close() {
      this.readyState = 3;
      this.onclose?.();
    }
    async open() {
      this.readyState = 1;
      await this.onopen();
    }
    receive(message) {
      this.onmessage({ data: JSON.stringify(message) });
    }
  }
  t.mock.method(globalThis, 'setInterval', () => 0);
  t.mock.method(globalThis, 'setTimeout', () => 0);
  const originalSocket = globalThis.WebSocket;
  globalThis.chrome = chrome;
  globalThis.WebSocket = Socket;
  t.after(() => {
    delete globalThis.chrome;
    globalThis.WebSocket = originalSocket;
  });
  await import('../extension/background.js');
  const request = (message) =>
    new Promise((resolve) => listeners.message(message, { id: chrome.runtime.id }, resolve));
  let state = (await request({ type: 'state' })).result;
  assert.equal(state.enabled, false);
  assert.equal(
    listeners.message(
      { type: 'settings', ...settings },
      { id: chrome.runtime.id, tab: { id: 1 } },
      () => {},
    ),
    false,
  );
  const refusedHide = await new Promise((resolve) =>
    listeners.message(
      { type: 'hide-activity-indicator' },
      { id: chrome.runtime.id, tab: { id: 1 } },
      resolve,
    ),
  );
  assert.ok(refusedHide.error);
  const first = sockets[0];
  await first.open();
  state = (await request({ type: 'state' })).result;
  assert.equal(state.ready, false);
  assert.equal(state.enabled, false);
  assert.equal(first.sent[0].version, 3);
  assert.ok(first.sent[0].profile.id);
  const identity = first.sent[0].profile.id;
  first.receive({ type: 'ready', profileID: identity });
  assert.equal((await request({ type: 'state' })).result.enabled, true);
  await request({ type: 'settings', ...settings });
  assert.equal((await request({ type: 'state' })).result.enabled, false);
  const second = sockets[1];
  await second.open();
  await request({ type: 'disable' });
  assert.equal(second.sent[0].profile.id, identity);
  second.receive({ type: 'ready', profileID: identity });
  assert.equal((await request({ type: 'state' })).result.enabled, false);
  second.close();
  state = (await request({ type: 'state' })).result;
  assert.equal(state.ready, false);
  assert.equal(state.enabled, false);
  // A fresh Chrome profile has its own identity, but no token/opt-in: never connect.
  const count = sockets.length;
  let stored = {};
  chrome.storage.local.get = async () => structuredClone(stored);
  chrome.storage.local.set = async (update) => {
    stored = structuredClone({ ...stored, ...update });
  };
  await import('../extension/background.js?fresh-profile');
  const fresh = (await request({ type: 'state' })).result;
  assert.equal(fresh.enabled, false);
  assert.equal(fresh.settings.token, undefined);
  assert.notEqual(fresh.settings.profileID, identity);
  assert.equal(sockets.length, count);
  await import('../extension/background.js?fresh-profile-worker-restart');
  const restored = (await request({ type: 'state' })).result;
  assert.equal(restored.settings.profileID, fresh.settings.profileID);
  assert.equal(sockets.length, count);
});
