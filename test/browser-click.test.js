import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { SessionBrowser } from '../extension/session-browser.js';
import { fakeChrome } from './fake-chrome.js';
import { startTestBrowser } from './cdp-browser.js';

const content = await readFile(new URL('../extension/content.js', import.meta.url), 'utf8');
const html = `<!doctype html><title>Click regression</title>
<style>button { margin: 100px; width: 100px; height: 40px; }</style>
<div id="value">--</div><div id="dropdown"><button id="yes">Yes</button></div>
<div id="portal-filter">Portals: none</div>
<div role="dialog" aria-label="Portal filters">
  <input id="portal-search" role="combobox" aria-label="Search portals" aria-expanded="true">
  <div role="listbox" aria-multiselectable="true">
    <div id="coupa" role="option" cmdk-item="" aria-selected="true" style="padding:12px;width:180px"><svg width="16" height="16" aria-hidden="true"></svg><span>Coupa</span></div>
    <div id="other-portal" role="option" cmdk-item="">Other portal</div>
  </div>
</div>
<script>
window.events = [];
let pressed = false;
const yes = document.getElementById('yes');
for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'])
  yes.addEventListener(type, (event) => {
    events.push({ type, trusted: event.isTrusted });
    if (type === 'pointerdown' && event.isTrusted) pressed = true;
    if (type === 'click' && event.isTrusted && pressed) {
      document.getElementById('value').textContent = 'Yes';
      document.getElementById('dropdown').hidden = true;
    }
  });
document.getElementById('portal-search').addEventListener('input', () => {
  document.getElementById('other-portal').hidden = true;
});
document.getElementById('coupa').addEventListener('click', event => {
  if (!event.isTrusted) return;
  document.getElementById('portal-filter').textContent = 'Portals: Coupa';
});
</script>`;

test(
  'real Chrome click dispatch satisfies trusted pointer handlers and refuses covered targets',
  {
    skip:
      !process.env.CHROME_BINARY &&
      'Set CHROME_BINARY to run the isolated real-browser regression.',
    timeout: 30000,
  },
  async (t) => {
    const server = createServer((_req, res) =>
      res.writeHead(200, { 'Content-Type': 'text/html' }).end(html),
    );
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(
      () =>
        new Promise((resolve) => {
          server.closeAllConnections();
          server.close(resolve);
        }),
    );
    const cdp = await startTestBrowser(t);
    const url = `http://127.0.0.1:${server.address().port}`;
    const contextID = await cdp.navigate(url);
    const chrome = fakeChrome();
    const browser = new SessionBrowser(chrome);
    browser.enabled = true;
    chrome.scripting.executeScript = async (request) => {
      if (request.files) {
        await cdp.evaluate(content, contextID);
        return [];
      }
      const expression = `(${request.func.toString()})(...${JSON.stringify(request.args || [])})`;
      return [{ result: await cdp.evaluate(expression, contextID) }];
    };
    const send = chrome.debugger.sendCommand;
    chrome.debugger.sendCommand = async (target, method, params) => {
      await send(target, method, params);
      return cdp.command(method, params);
    };
    const command = (tool, args = {}) => ({
      tool,
      args,
      id: crypto.randomUUID(),
      sessionID: 'ses_browserTest',
      generation: browser.bindings.ses_browserTest?.generation || 'test-generation',
      expiresAt: Date.now() + 25000,
    });
    await browser.run(command('open_tab', { url }));
    const snapshot = await browser.run(command('read_page'));
    const yes = snapshot.elements.find((element) => element.label === 'Yes');
    await cdp.evaluate("document.getElementById('yes').click()");
    assert.equal(await cdp.evaluate("document.getElementById('value').textContent"), '--');
    await cdp.evaluate('events = []');
    const result = await browser.run(command('click', { ref: yes.ref }));
    assert.equal(result.dispatched, true);
    assert.equal(result.applicationAccepted, null);
    assert.equal(await cdp.evaluate("document.getElementById('value').textContent"), 'Yes');
    assert.equal(await cdp.evaluate("document.getElementById('dropdown').hidden"), true);
    assert.deepEqual(await cdp.evaluate('events'), [
      { type: 'pointerdown', trusted: true },
      { type: 'mousedown', trusted: true },
      { type: 'pointerup', trusted: true },
      { type: 'mouseup', trusted: true },
      { type: 'click', trusted: true },
    ]);
    const portals = await browser.run(command('read_page'));
    const search = portals.elements.find((element) => element.label === 'Search portals');
    await browser.run(command('type', { ref: search.ref, text: 'Coupa' }));
    const filtered = await browser.run(command('read_page'));
    const coupa = filtered.elements.find((element) => element.label === 'Coupa');
    assert.equal(coupa.type, 'option');
    assert.equal(
      filtered.elements.some((element) => element.label === 'Other portal'),
      false,
    );
    const selected = await browser.run(command('click', { ref: coupa.ref }));
    assert.equal(selected.dispatched, true);
    assert.equal(
      await cdp.evaluate("document.getElementById('portal-filter').textContent"),
      'Portals: Coupa',
    );
    await cdp.evaluate(`document.getElementById('dropdown').hidden = false;
    events = []; document.getElementById('value').textContent = '--';
    const cover = document.createElement('div');
    cover.style.cssText = 'position:fixed;inset:0;z-index:1000;background:white';
    document.body.append(cover);`);
    const fresh = await browser.run(command('read_page'));
    const before = chrome.debuggerCalls.length;
    await assert.rejects(
      browser.run(
        command('click', { ref: fresh.elements.find((element) => element.label === 'Yes').ref }),
      ),
      /covered/,
    );
    assert.equal(chrome.debuggerCalls.length, before);
    assert.deepEqual(await cdp.evaluate('events'), []);
  },
);
