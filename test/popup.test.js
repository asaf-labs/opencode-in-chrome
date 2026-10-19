import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

test('setup popup enables browser once without conversation selection or side panel', async (t) => {
  const manifest = JSON.parse(
    await readFile(new URL('../extension/manifest.json', import.meta.url), 'utf8'),
  );
  assert.equal(manifest.side_panel, undefined);
  assert.equal(manifest.permissions.includes('sidePanel'), false);
  assert.equal(manifest.action.default_popup, 'popup.html');
  const html = await readFile(new URL('../extension/popup.html', import.meta.url), 'utf8');
  const script = await readFile(new URL('../extension/popup.js', import.meta.url), 'utf8');
  const dom = new JSDOM(html, { url: 'https://extension.test', runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const calls = [],
    permissions = [];
  let enabled = false;
  dom.window.setInterval = () => {};
  dom.window.chrome = {
    permissions: {
      request: async (request) => {
        permissions.push(request);
        return true;
      },
    },
    runtime: {
      sendMessage: async (message) => {
        calls.push(message);
        if (message.type === 'settings') enabled = true;
        if (message.type === 'disable') enabled = false;
        return {
          result:
            message.type === 'state'
              ? {
                  ready: true,
                  enabled,
                  ownedTabs: [{ id: 100, title: '<b>Owned</b>', keep: false }],
                  archives: [
                    { id: 'archive', title: '<script>bad</script>', url: 'https://example.com' },
                  ],
                  settings: {
                    token: 'a'.repeat(64),
                    url: 'http://127.0.0.1:8790',
                    profileName: 'Work',
                    profileID: 'test-profile',
                  },
                }
              : { ok: true },
        };
      },
    },
  };
  await dom.window.eval(`(async () => { ${script} })()`);
  dom.window.document
    .getElementById('settings-form')
    .dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(permissions[0].origins[0], '<all_urls>');
  assert.match(dom.window.document.getElementById('status').textContent, /Ready/);
  assert.ok(calls.some((c) => c.type === 'settings'));
  assert.equal(calls.find((c) => c.type === 'settings').profileName, 'Work');
  assert.equal(dom.window.document.getElementById('profile-id').textContent, 'test-profile');
  assert.ok(!calls.some((c) => c.type === 'api' || c.type === 'bind'));
  assert.equal(dom.window.document.querySelector('select'), null);
  const cleanup = dom.window.document.getElementById('auto-archive');
  assert.equal(cleanup.checked, false);
  cleanup.checked = true;
  cleanup.dispatchEvent(new dom.window.Event('change'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(calls.some((call) => call.type === 'cleanup-settings' && call.autoArchive === true));
  assert.equal(dom.window.document.querySelector('#owned-tabs b'), null);
  assert.equal(dom.window.document.querySelector('#archives script'), null);
  dom.window.document.querySelector('#owned-tabs input').click();
  dom.window.document.querySelector('#owned-tabs button').click();
  dom.window.document.querySelector('#archives button').click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(calls.some((call) => call.type === 'keep-tab' && call.tabID === 100 && call.keep));
  assert.ok(calls.some((call) => call.type === 'restore-archive' && call.id === 'archive'));
  assert.ok(
    calls.some(
      (call) => call.type === 'indicator-visibility' && call.tabID === 100 && call.hidden === true,
    ),
  );
  dom.window.document.getElementById('disable').click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(dom.window.document.getElementById('status').textContent, /disabled/);
});
